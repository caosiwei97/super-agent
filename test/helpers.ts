import type { LanguageModel } from 'ai'

export interface StreamToolCall {
  id: string
  name: string
  input: unknown
}

export type StreamStep =
  | { type: 'tools'; calls: StreamToolCall[] }
  | { type: 'text'; text: string }

function usage(totalInput = 3, totalOutput = 2) {
  return {
    inputTokens: {
      total: totalInput,
      noCache: totalInput,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: totalOutput,
      text: totalOutput,
      reasoning: 0,
    },
  }
}

/** Minimal AI SDK v3 model for deterministic agent-loop tests. */
export function streamSequenceModel(steps: StreamStep[]) {
  let callCount = 0

  const model: LanguageModel = {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'stream-sequence',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate is not used by this model')
    },
    async doStream() {
      const step = steps[callCount++]
      if (!step) throw new Error(`No stream step configured for call ${callCount}`)

      const parts: unknown[] = [{ type: 'stream-start', warnings: [] }]
      if (step.type === 'tools') {
        for (const call of step.calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.name,
            input: JSON.stringify(call.input),
          })
        }
      } else {
        parts.push(
          { type: 'text-start', id: `text-${callCount}` },
          { type: 'text-delta', id: `text-${callCount}`, delta: step.text },
          { type: 'text-end', id: `text-${callCount}` },
        )
      }
      parts.push({
        type: 'finish',
        finishReason: {
          unified: step.type === 'tools' ? 'tool-calls' : 'stop',
          raw: step.type === 'tools' ? 'tool_calls' : 'stop',
        },
        usage: usage(),
      })

      return {
        // The helper mirrors provider events at runtime; keeping the cast here
        // avoids coupling tests to the transitive @ai-sdk/provider package.
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      } as never
    },
  }

  return { model, getCallCount: () => callCount }
}

export function summaryModel(summary: string, onGenerate?: () => void) {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'summary',
    supportedUrls: {},
    async doGenerate() {
      onGenerate?.()
      return {
        content: [{ type: 'text', text: summary }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usage(10, 5),
        warnings: [],
      }
    },
    async doStream() {
      throw new Error('doStream is not used by this model')
    },
  } satisfies LanguageModel
}
