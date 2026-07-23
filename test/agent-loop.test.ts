import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelMessageSchema, type ModelMessage } from 'ai'
import { agentLoop } from '../src/agent/agent-loop.js'
import { ToolRegistry, type ToolDefinition } from '../src/core/tool-registry.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { streamSequenceModel } from './helpers.js'

function tool(name: string, execute: ToolDefinition['execute'], mutation = false) {
  return {
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    isConcurrencySafe: !mutation,
    isReadOnly: !mutation,
    requiresApproval: mutation,
    execute,
  }
}

function toolResults(messages: ModelMessage[]) {
  return messages
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.role === 'tool' ? message.content : [])
    .filter((part) => part.type === 'tool-result')
}

describe('agentLoop', () => {
  it('keeps parallel results associated by toolCallId', async () => {
    const registry = new ToolRegistry()
    registry.register(
      tool('slow_a', async ({ value }) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return `A:${value}`
      }),
      tool('fast_b', async ({ value }) => `B:${value}`),
    )
    const { model } = streamSequenceModel([
      {
        type: 'tools',
        calls: [
          { id: 'call-a', name: 'slow_a', input: { value: 'one' } },
          { id: 'call-b', name: 'fast_b', input: { value: 'two' } },
        ],
      },
      { type: 'text', text: 'done' },
    ])
    const messages: ModelMessage[] = [{ role: 'user', content: 'run both' }]
    const inputTokenCounts: number[] = []
    const usageTracker = new UsageTracker()

    const result = await agentLoop({
      model,
      registry,
      messages,
      buildSystem: () => 'test',
      tokenCost: { used: 0, limit: 1_000 },
      usageTracker,
      onInputTokens: (tokens) => inputTokenCounts.push(tokens),
      maxRetries: 0,
    })

    assert.deepEqual(result, { steps: 2, stopReason: 'completed' })
    assert.deepEqual(inputTokenCounts, [3, 3])
    assert.deepEqual(
      usageTracker.records().map((record) => ({
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
      })),
      [
        { model: 'stream-sequence', inputTokens: 3, outputTokens: 2 },
        { model: 'stream-sequence', inputTokens: 3, outputTokens: 2 },
      ],
    )
    const byId = new Map(toolResults(messages).map((part) => [part.toolCallId, part.output]))
    assert.deepEqual(byId.get('call-a'), { type: 'text', value: 'A:one' })
    assert.deepEqual(byId.get('call-b'), { type: 'text', value: 'B:two' })
    assert.ok(messages.every((message) => modelMessageSchema.safeParse(message).success))
  })

  it('records formal approval and executes a mutation exactly once', async () => {
    const registry = new ToolRegistry()
    let executions = 0
    registry.register(tool('write_demo', async ({ value }) => {
      executions++
      return `wrote:${value}`
    }, true))
    const { model } = streamSequenceModel([
      {
        type: 'tools',
        calls: [{ id: 'write-1', name: 'write_demo', input: { value: 'safe' } }],
      },
      { type: 'text', text: 'finished' },
    ])
    const messages: ModelMessage[] = [{ role: 'user', content: 'write it' }]
    const approvals: string[] = []

    const result = await agentLoop({
      model,
      registry,
      messages,
      buildSystem: () => 'test',
      tokenCost: { used: 0, limit: 1_000 },
      approveTool: async (invocation) => {
        approvals.push(invocation.toolCallId)
        return true
      },
      maxRetries: 0,
    })

    assert.equal(result.stopReason, 'completed')
    assert.equal(executions, 1)
    assert.deepEqual(approvals, ['write-1'])

    const approvalMessage = messages.find((message) =>
      message.role === 'tool' && message.content.some((part) => part.type === 'tool-approval-response'),
    )
    assert.ok(approvalMessage?.role === 'tool')
    assert.ok(approvalMessage.content.some(
      (part) => part.type === 'tool-approval-response' && part.approved,
    ))
    assert.ok(approvalMessage.content.some(
      (part) => part.type === 'tool-result' && part.toolCallId === 'write-1',
    ))
    assert.ok(messages.every((message) => modelMessageSchema.safeParse(message).success))
  })
})
