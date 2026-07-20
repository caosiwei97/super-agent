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

/** 用于确定性智能体循环测试的最小 AI SDK v3 模型。 */
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
        // 此辅助函数模拟模型供应商的运行时事件；在这里保留类型断言，
        // 可避免测试与间接依赖的 @ai-sdk/provider 包耦合。
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
