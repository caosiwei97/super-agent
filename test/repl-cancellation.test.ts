import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { describe, it } from 'node:test'
import { ToolRegistry } from '../src/core/tool-registry.js'
import {
  closeRuntime,
  createInteractiveApprovalHandler,
} from '../src/cli/repl.js'
import type { PipelineApprovalRequest } from '../src/execution/tool-execution-pipeline.js'

function approvalRequest(signal: AbortSignal): PipelineApprovalRequest {
  return {
    tool: {
      name: 'write_demo',
      description: 'write',
      parameters: { type: 'object', properties: {} },
      capabilitySet: ['filesystem.write'],
      isConcurrencySafe: false,
      isReadOnly: false,
      requiresApproval: true,
      maxResultChars: 1_000,
      shouldDefer: false,
    },
    input: { path: 'safe.txt' },
    toolCallId: 'call-1',
    operationId: 'operation-1',
    signal,
    deadline: Date.now() + 10_000,
  }
}

describe('REPL cancellation lifecycle', () => {
  it('aborts the native pending approval question without consuming the next answer', async (context) => {
    const input = new PassThrough()
    const output = new PassThrough()
    const rl = createInterface({ input, output, terminal: true })
    context.after(() => rl.close())
    const controller = new AbortController()
    const approval = createInteractiveApprovalHandler(rl, false)(approvalRequest(controller.signal))

    controller.abort(new DOMException('cancel approval', 'AbortError'))
    await assert.rejects(approval, { name: 'AbortError' })

    const nextAnswer = new Promise<string>((resolve) => rl.question('next: ', resolve))
    input.write('yes\n')
    assert.equal(await nextAnswer, 'yes')
  })

  it('closes the registry before the store, including registry close failure', async () => {
    const order: string[] = []
    const registry = new ToolRegistry()
    registry.register({
      name: 'resource',
      description: 'resource',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => 'ok',
      dispose: () => {
        order.push('registry')
        throw new Error('dispose failed')
      },
    })
    const store = {
      close: async () => {
        order.push('store')
      },
    }

    await assert.rejects(
      closeRuntime({ registry, store } as unknown as Parameters<typeof closeRuntime>[0]),
      /部分运行时资源关闭失败/,
    )
    assert.deepEqual(order, ['registry', 'store'])
  })
})
