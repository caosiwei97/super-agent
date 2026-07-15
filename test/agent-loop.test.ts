import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { modelMessageSchema, type ModelMessage } from 'ai'
import { agentLoop } from '../src/agent/agent-loop.js'
import { ToolRegistry, type ToolDefinition } from '../src/core/tool-registry.js'
import { parseOperationEvent } from '../src/execution/operation-ledger.js'
import { ToolExecutionPipeline } from '../src/execution/tool-execution-pipeline.js'
import { SessionStore } from '../src/session/store.js'
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

async function runtime(context: TestContext, registry: ToolRegistry) {
  const directory = await mkdtemp(join(tmpdir(), 'super-agent-loop-'))
  const sessionId = 'agent-loop-test'
  const store = await SessionStore.open(sessionId, { directory })
  context.after(async () => {
    await registry.close().catch(() => undefined)
    await store.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  })
  return {
    store,
    sessionId,
    pipeline: new ToolExecutionPipeline(registry, store),
    onMessages: (batch: ModelMessage[]) => store.appendMessages(batch),
    onModelAttemptAudit: (event: { phase: string; requestId: string; attempt: number }) =>
      store.appendEvent({ type: `model.request.${event.phase}`, ...event }).then(() => undefined),
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
  }
}

describe('agentLoop', () => {
  it('keeps parallel results associated by toolCallId', async (context) => {
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
    const durable = await runtime(context, registry)

    const result = await agentLoop({
      model,
      registry,
      pipeline: durable.pipeline,
      sessionId: durable.sessionId,
      turnId: 'turn-parallel',
      signal: durable.signal,
      deadline: durable.deadline,
      messages,
      onMessages: durable.onMessages,
      onModelAttemptAudit: durable.onModelAttemptAudit,
      buildSystem: () => 'test',
      budget: { used: 0, limit: 1_000 },
      maxRetries: 0,
    })

    assert.deepEqual(result, { steps: 2, stopReason: 'completed' })
    const byId = new Map(toolResults(messages).map((part) => [part.toolCallId, part.output]))
    assert.deepEqual(byId.get('call-a'), { type: 'text', value: 'A:one' })
    assert.deepEqual(byId.get('call-b'), { type: 'text', value: 'B:two' })
    assert.ok(messages.every((message) => modelMessageSchema.safeParse(message).success))
  })

  it('records durable approval and executes a mutation exactly once', async (context) => {
    const registry = new ToolRegistry()
    let executions = 0
    registry.register(tool('write_demo', async ({ value }) => {
      executions++
      return `wrote:${value}`
    }, true))
    const { model, getCallCount } = streamSequenceModel([
      {
        type: 'tools',
        calls: [{ id: 'write-1', name: 'write_demo', input: { value: 'safe' } }],
      },
      { type: 'text', text: 'finished' },
    ])
    const messages: ModelMessage[] = [{ role: 'user', content: 'write it' }]
    const approvals: string[] = []
    const durable = await runtime(context, registry)

    const result = await agentLoop({
      model,
      registry,
      pipeline: durable.pipeline,
      sessionId: durable.sessionId,
      turnId: 'turn-write',
      signal: durable.signal,
      deadline: durable.deadline,
      messages,
      onMessages: durable.onMessages,
      onModelAttemptAudit: durable.onModelAttemptAudit,
      buildSystem: () => 'test',
      budget: { used: 0, limit: 1_000 },
      approveTool: async (invocation) => {
        approvals.push(invocation.toolCallId)
        return true
      },
      maxRetries: 0,
    })

    assert.equal(result.stopReason, 'completed')
    assert.equal(executions, 1)
    assert.deepEqual(approvals, ['write-1'])

    assert.equal(messages.some((message) =>
      message.role === 'tool' && message.content.some(
        (part) => part.type === 'tool-approval-response',
      )), false)
    const resultMessage = messages.find((message) =>
      message.role === 'tool' && message.content.some(
        (part) => part.type === 'tool-result' && part.toolCallId === 'write-1',
      ),
    )
    assert.ok(resultMessage?.role === 'tool')
    assert.ok(resultMessage.content.some(
      (part) => part.type === 'tool-result' && part.toolCallId === 'write-1',
    ))
    const statuses = (await durable.store.replayEvents())
      .filter((event) => event.type === 'operation')
      .map((event) => parseOperationEvent(event).status)
    assert.deepEqual(statuses, ['proposed', 'approved', 'started', 'succeeded'])
    const eventOrder = (await durable.store.replayEvents())
      .filter((event) => event.type === 'operation' || event.type === 'messages')
      .map((event) => event.type === 'operation' ? parseOperationEvent(event).status : event.type)
    assert.deepEqual(eventOrder.slice(0, 6), [
      'messages', 'proposed', 'approved', 'started', 'succeeded', 'messages',
    ])
    assert.equal(getCallCount(), 2)
    assert.ok(messages.every((message) => modelMessageSchema.safeParse(message).success))
  })

  it('stops the turn on an uncertain dispatch and never asks the model to continue', async (context) => {
    const registry = new ToolRegistry()
    registry.register(tool('ambiguous_write', async () => {
      throw new Error('connection lost after dispatch')
    }, true))
    const { model, getCallCount } = streamSequenceModel([
      {
        type: 'tools',
        calls: [{ id: 'uncertain-1', name: 'ambiguous_write', input: { value: 'safe' } }],
      },
      { type: 'text', text: 'must not be generated' },
    ])
    const messages: ModelMessage[] = [{ role: 'user', content: 'write once' }]
    const durable = await runtime(context, registry)

    const result = await agentLoop({
      model,
      registry,
      pipeline: durable.pipeline,
      sessionId: durable.sessionId,
      turnId: 'turn-uncertain',
      signal: durable.signal,
      deadline: durable.deadline,
      messages,
      onMessages: durable.onMessages,
      onModelAttemptAudit: durable.onModelAttemptAudit,
      buildSystem: () => 'test',
      budget: { used: 0, limit: 1_000 },
      approveTool: async () => true,
      maxRetries: 0,
    })

    assert.deepEqual(result, { steps: 1, stopReason: 'uncertain' })
    assert.equal(getCallCount(), 1)
    assert.equal(toolResults(messages).length, 0)
    const statuses = (await durable.store.replayEvents())
      .filter((event) => event.type === 'operation')
      .map((event) => parseOperationEvent(event).status)
    assert.deepEqual(statuses, ['proposed', 'approved', 'started', 'uncertain'])
  })

  it('never proposes or executes a tool when assistant persistence fails', async (context) => {
    const registry = new ToolRegistry()
    let executions = 0
    registry.register(tool('must_not_run', async () => {
      executions++
      return 'unexpected'
    }))
    const { model } = streamSequenceModel([{
      type: 'tools',
      calls: [{ id: 'blocked-1', name: 'must_not_run', input: { value: 'safe' } }],
    }])
    const messages: ModelMessage[] = [{ role: 'user', content: 'run' }]
    const durable = await runtime(context, registry)

    await assert.rejects(agentLoop({
      model,
      registry,
      pipeline: durable.pipeline,
      sessionId: durable.sessionId,
      turnId: 'turn-persist-failure',
      signal: durable.signal,
      deadline: durable.deadline,
      messages,
      onMessages: async () => {
        throw new Error('injected assistant persistence failure')
      },
      onModelAttemptAudit: durable.onModelAttemptAudit,
      buildSystem: () => 'test',
      budget: { used: 0, limit: 1_000 },
      maxRetries: 0,
    }), /assistant persistence failure/)

    assert.equal(executions, 0)
    const persisted = await durable.store.replayEvents()
    assert.equal(persisted.some((event) => event.type === 'operation'), false)
    assert.equal(persisted.some((event) => event.type === 'messages'), false)
    assert.ok(persisted.every((event) => event.type.startsWith('model.request.')))
  })
})
