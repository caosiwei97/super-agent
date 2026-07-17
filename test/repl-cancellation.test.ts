import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { describe, it } from 'node:test'
import { ToolRegistry } from '../src/core/tool-registry.js'
import {
  closeRuntime,
  createInteractiveApprovalHandler,
  runOnce,
  RuntimeResourceCloseTimeoutError,
} from '../src/cli/repl.js'
import type { CliRuntimeDeps } from '../src/cli/repl.js'
import type { PipelineApprovalRequest } from '../src/execution/tool-execution-pipeline.js'

function approvalRequest(signal: AbortSignal): PipelineApprovalRequest {
  return {
    tool: {
      name: 'write_demo',
      description: 'write',
      parameters: { type: 'object', properties: {} },
      maxResultChars: 1_000,
      shouldDefer: false,
    },
    input: { path: 'safe.txt' },
    toolCallId: 'call-1',
    operationId: 'operation-1',
    signal,
    deadline: Date.now() + 10_000,
    capabilities: ['filesystem.write'],
    constraints: {},
    policyReasonCode: 'policy.default.approval_required',
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

  it('bounds a stuck registry close and still releases the store', async () => {
    const order: string[] = []
    const registry = {
      close: async () => {
        order.push('registry')
        await new Promise<never>(() => undefined)
      },
    }
    const store = {
      close: async () => {
        order.push('store')
      },
    }

    await assert.rejects(
      closeRuntime(
        { registry, store } as unknown as Parameters<typeof closeRuntime>[0],
        { registryCloseTimeoutMs: 5, storeCloseTimeoutMs: 50 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.errors.length, 1)
        const timeout = error.errors[0]
        assert.ok(timeout instanceof RuntimeResourceCloseTimeoutError)
        assert.equal(timeout.code, 'runtime_resource_close_timeout')
        assert.equal(timeout.resource, 'registry')
        return true
      },
    )
    assert.deepEqual(order, ['registry', 'store'])
  })

  it('rejects an outer close budget smaller than the two resource budgets', async () => {
    await assert.rejects(
      runOnce({
        shutdown: {
          registryCloseTimeoutMs: 20,
          storeCloseTimeoutMs: 30,
          closeWaitTimeoutMs: 49,
        },
      } as unknown as CliRuntimeDeps, 'unused'),
      /closeWaitTimeoutMs.*registryCloseTimeoutMs \+ storeCloseTimeoutMs/,
    )
  })
})
