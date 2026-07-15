import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { jsonSchema, type LanguageModel, type ModelMessage } from 'ai'
import {
  DeadlineExceededError,
  ModelGateway,
  ModelAuditWriteError,
  type ModelAttemptAuditEvent,
} from '../src/model/model-gateway.js'

function usage(input = 3, output = 2) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  }
}

type Attempt =
  | { error: Error }
  | { parts: unknown[]; finishReason?: 'stop' | 'tool-calls' }

function sequenceModel(attempts: Attempt[]) {
  let calls = 0
  const model: LanguageModel = {
    specificationVersion: 'v3',
    provider: 'gateway-test',
    modelId: 'sequence',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used')
    },
    async doStream() {
      const attempt = attempts[calls++]
      if (!attempt) throw new Error(`missing attempt ${calls}`)
      if ('error' in attempt) throw attempt.error

      const parts = [
        { type: 'stream-start', warnings: [] },
        ...attempt.parts,
        {
          type: 'finish',
          finishReason: {
            unified: attempt.finishReason ?? 'stop',
            raw: attempt.finishReason ?? 'stop',
          },
          usage: usage(),
        },
      ]
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      } as never
    },
  }
  return { model, calls: () => calls }
}

function textParts(text: string) {
  return [
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
  ]
}

function transientError(delayMs = 0) {
  return Object.assign(new Error('HTTP status: 503'), {
    status: 503,
    responseHeaders: { 'retry-after-ms': String(delayMs) },
  })
}

const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
const lookupTools = {
  lookup: {
    inputSchema: jsonSchema({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    }),
  },
}

describe('ModelGateway', () => {
  it('keeps requestId stable and increments audited attempt across a safe retry', async () => {
    const sequence = sequenceModel([
      { error: transientError() },
      { parts: textParts('done') },
    ])
    const audit: ModelAttemptAuditEvent[] = []
    const deltas: string[] = []

    const result = await new ModelGateway().stream({
      requestId: 'request-stable',
      model: sequence.model,
      messages,
      maxRetries: 1,
      onAttemptAudit: (event) => {
        audit.push(event)
      },
      onTextDelta: ({ text }) => deltas.push(text),
    })

    assert.equal(sequence.calls(), 2)
    assert.equal(result.requestId, 'request-stable')
    assert.equal(result.attempts, 2)
    assert.deepEqual(deltas, ['done'])
    assert.deepEqual(
      audit.map((event) => [event.phase, event.requestId, event.attempt]),
      [
        ['started', 'request-stable', 1],
        ['failed', 'request-stable', 1],
        ['retry_scheduled', 'request-stable', 1],
        ['started', 'request-stable', 2],
        ['succeeded', 'request-stable', 2],
      ],
    )
    const failed = audit.find((event) => event.phase === 'failed')
    assert.equal(failed?.phase === 'failed' && failed.willRetry, true)
    assert.equal(failed?.phase === 'failed' && failed.errorCode, 'http_5xx')
  })

  it('does not retry after a text delta becomes observable', async () => {
    const sequence = sequenceModel([{
      parts: [
        ...textParts('partial').slice(0, 2),
        { type: 'error', error: transientError() },
      ],
    }])
    const audit: ModelAttemptAuditEvent[] = []

    await assert.rejects(new ModelGateway().stream({
      requestId: 'text-commit',
      model: sequence.model,
      messages,
      maxRetries: 3,
      onAttemptAudit: (event) => {
        audit.push(event)
      },
    }))

    assert.equal(sequence.calls(), 1)
    const failed = audit.find((event) => event.phase === 'failed')
    assert.equal(failed?.phase === 'failed' && failed.observable, true)
    assert.equal(failed?.phase === 'failed' && failed.willRetry, false)
  })

  it('does not retry after a complete tool call and returns complete calls on success', async () => {
    const call = {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: JSON.stringify({ value: 'x' }),
    }
    const failedSequence = sequenceModel([{
      parts: [call, { type: 'error', error: transientError() }],
      finishReason: 'tool-calls',
    }])
    await assert.rejects(new ModelGateway().stream({
      requestId: 'tool-commit-failed',
      model: failedSequence.model,
      messages,
      tools: lookupTools,
      maxRetries: 3,
    }))
    assert.equal(failedSequence.calls(), 1)

    const successSequence = sequenceModel([{
      parts: [call],
      finishReason: 'tool-calls',
    }])
    const result = await new ModelGateway().stream({
      requestId: 'tool-commit-success',
      model: successSequence.model,
      messages,
      tools: lookupTools,
      maxRetries: 0,
    })
    assert.deepEqual(result.toolCalls, [{
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: { value: 'x' },
    }])
    assert.equal(result.responseMessages.length, 1)
    assert.equal(result.usage.inputTokens, 3)
    assert.equal(result.usage.outputTokens, 2)
    assert.equal(result.finishReason, 'tool-calls')
  })

  it('never retries a caller AbortError', async () => {
    const sequence = sequenceModel([{ parts: textParts('unused') }])
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await assert.rejects(new ModelGateway().stream({
      requestId: 'cancelled',
      model: sequence.model,
      messages,
      signal: controller.signal,
      maxRetries: 10,
    }), { name: 'AbortError' })
    assert.equal(sequence.calls(), 0)
  })

  it('does not schedule Retry-After beyond the absolute deadline', async () => {
    const sequence = sequenceModel([{
      error: transientError(60_000),
    }])
    await assert.rejects(new ModelGateway().stream({
      requestId: 'deadline',
      model: sequence.model,
      messages,
      deadline: Date.now() + 1_000,
      maxRetries: 3,
    }), (error) => error instanceof DeadlineExceededError)
    assert.equal(sequence.calls(), 1)
  })

  it('isolates presentation observer failures from model execution', async () => {
    const sequence = sequenceModel([{ parts: textParts('done') }])
    const result = await new ModelGateway().stream({
      requestId: 'observer-isolation',
      model: sequence.model,
      messages,
      onTextDelta: () => {
        throw new Error('observer failed')
      },
    })
    assert.equal(result.attempts, 1)
  })

  it('fails closed when durable audit persistence rejects', async () => {
    const sequence = sequenceModel([{ parts: textParts('must not run') }])
    await assert.rejects(new ModelGateway().stream({
      requestId: 'audit-fail-closed',
      model: sequence.model,
      messages,
      onAttemptAudit: async () => {
        throw new Error('disk unavailable')
      },
    }), (error) => error instanceof ModelAuditWriteError)
    assert.equal(sequence.calls(), 0)
  })
})
