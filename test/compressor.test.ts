import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelMessageSchema, type LanguageModel, type ModelMessage } from 'ai'
import {
  compactContext,
  microcompact,
  summarize,
  type CompactionOptions,
} from '../src/context/compressor.js'

const TEST_OPTIONS: CompactionOptions = {
  tokenThreshold: 300,
  keepRecentMessages: 6,
  keepRecentToolMessages: 3,
  asciiCharsPerToken: 4,
  maxSummaryChars: 20_000,
}

function toolMessage(index: number, toolName = 'read_file') {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: `call-${index}`,
        toolName,
        output: { type: 'text', value: `result-${index}-${'x'.repeat(80)}` },
      },
    ],
  } satisfies ModelMessage
}

function textToolOutput(message: ModelMessage) {
  if (message.role !== 'tool') return undefined
  const part = message.content[0]
  if (part?.type !== 'tool-result' || part.output.type !== 'text') return undefined
  return part.output.value
}

function summaryModel(summaries: string[], prompts: string[]) {
  let callIndex = 0

  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'summary-model',
    supportedUrls: {},
    async doGenerate(options) {
      prompts.push(JSON.stringify(options.prompt))
      const text = summaries[callIndex++] ?? ''

      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }
    },
    async doStream() {
      throw new Error('not used by compaction tests')
    },
  } satisfies LanguageModel
}

function longConversation(messageCount: number, prefix: string) {
  const messages: ModelMessage[] = []
  for (let index = 0; index < messageCount; index++) {
    const content = `${prefix}-${index}-${'内容'.repeat(120)}`
    messages.push(index % 2 === 0 ? { role: 'user', content } : { role: 'assistant', content })
  }
  return messages
}

describe('microcompact', () => {
  it('clears only old eligible tool results and keeps AI SDK message shape valid', () => {
    const messages = [
      toolMessage(0, 'calculator'),
      toolMessage(1),
      toolMessage(2),
      toolMessage(3),
      toolMessage(4),
      toolMessage(5),
    ]

    const result = microcompact(messages, TEST_OPTIONS)

    assert.equal(result.cleared, 2)
    assert.match(textToolOutput(result.messages[0]) ?? '', /^result-0-/)
    assert.equal(textToolOutput(result.messages[1]), '[tool result cleared]')
    assert.equal(textToolOutput(result.messages[2]), '[tool result cleared]')
    assert.match(textToolOutput(result.messages[3]) ?? '', /^result-3-/)
    assert.ok(result.messages.every((message) => modelMessageSchema.safeParse(message).success))

    const secondPass = microcompact(result.messages, TEST_OPTIONS)
    assert.equal(secondPass.cleared, 0)
  })

  it('preserves failed tool results as reusable error experience', () => {
    const failed: ModelMessage = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-failed',
        toolName: 'read_file',
        output: { type: 'error-text', value: 'file does not exist' },
      }],
    }
    const result = microcompact([
      failed,
      toolMessage(1),
      toolMessage(2),
    ], { ...TEST_OPTIONS, keepRecentToolMessages: 1 })

    assert.equal(result.cleared, 1)
    const failedPart = result.messages[0].role === 'tool' && result.messages[0].content[0]
    assert.ok(failedPart && failedPart.type === 'tool-result')
    assert.deepEqual(failedPart.output, { type: 'error-text', value: 'file does not exist' })
  })
})

describe('summarize', () => {
  it('does not call the model below the threshold', async () => {
    const prompts: string[] = []
    const model = summaryModel(['unused'], prompts)
    const messages: ModelMessage[] = [{ role: 'user', content: 'short message' }]

    const result = await summarize(model, messages, '', TEST_OPTIONS)

    assert.equal(result.compressedCount, 0)
    assert.equal(result.usageTokens, 0)
    assert.equal(prompts.length, 0)
    assert.strictEqual(result.messages, messages)
  })

  it('rolls an embedded summary forward exactly once', async () => {
    const prompts: string[] = []
    const model = summaryModel(['first-summary', 'second-summary'], prompts)

    const first = await summarize(model, longConversation(8, 'first'), '', TEST_OPTIONS)
    assert.equal(first.compressedCount, 2)
    assert.equal(first.usageTokens, 15)
    assert.equal(first.messages.length, 7)
    assert.match(String(first.messages[0].content), /first-summary/)

    const expanded = [
      ...first.messages,
      ...longConversation(4, 'second'),
    ]
    const second = await summarize(model, expanded, first.summary, TEST_OPTIONS)

    assert.equal(second.compressedCount, 4)
    assert.equal(second.summary, 'second-summary')
    assert.equal((prompts[1].match(/first-summary/g) ?? []).length, 1)
    assert.doesNotMatch(prompts[1], /摘要结束，以下是最近的对话/)
  })

  it('rejects a summary that would make the context larger', async () => {
    const prompts: string[] = []
    const model = summaryModel(['oversized'.repeat(1_000)], prompts)
    const messages = longConversation(8, 'history')

    const result = await summarize(model, messages, '', TEST_OPTIONS)

    assert.equal(result.compressedCount, 0)
    assert.equal(result.summary, '')
    assert.strictEqual(result.messages, messages)
    assert.equal(result.usageTokens, 15)
  })
})

describe('compactContext', () => {
  it('runs zero-cost TTL defense without calling the summary model', async () => {
    const prompts: string[] = []
    const model = summaryModel(['unused'], prompts)
    const messages = [toolMessage(0)]

    const result = await compactContext(
      model,
      messages,
      '',
      { ...TEST_OPTIONS, tokenThreshold: 10_000 },
      { now: 11 * 60_000 },
      [0],
    )

    assert.equal(result.hardPruned, 1)
    assert.equal(result.compressedCount, 0)
    assert.equal(prompts.length, 0)
    assert.equal(textToolOutput(result.messages[0]), '[tool result expired: read_file]')
  })

  it('reports both layer results for lifecycle logging', async () => {
    const prompts: string[] = []
    const model = summaryModel(['combined-summary'], prompts)
    const messages: ModelMessage[] = [
      ...longConversation(8, 'history'),
      toolMessage(0),
      toolMessage(1),
      toolMessage(2),
      toolMessage(3),
    ]

    const result = await compactContext(model, messages, '', TEST_OPTIONS)

    assert.equal(result.cleared, 1)
    assert.ok(result.compressedCount > 0)
    assert.ok(result.beforeTokens > 0)
    assert.ok(result.afterTokens > 0)
    assert.equal(prompts.length, 1)
  })
})
