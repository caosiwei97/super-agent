import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelMessageSchema, type ModelMessage } from 'ai'
import {
  estimateTextTokens,
  TokenTracker,
  truncateToolResults,
  ttlPrune,
  type ContextDefenseOptions,
} from '../src/context/defense.js'

function toolMessage(index: number, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: `call-${index}`,
      toolName: 'read_file',
      output: { type: 'text', value },
    }],
  }
}

function textOutput(message: ModelMessage) {
  if (message.role !== 'tool') return undefined
  const part = message.content.find((item) => item.type === 'tool-result')
  return part?.type === 'tool-result' && part.output.type === 'text'
    ? part.output.value
    : undefined
}

const TTL_OPTIONS: Partial<ContextDefenseOptions> = {
  softTTLMs: 5 * 60_000,
  hardTTLMs: 10 * 60_000,
  softRetainChars: 100,
}

describe('Token estimation', () => {
  it('uses a conservative CJK weight and recalibrates from API usage', () => {
    assert.equal(estimateTextTokens('abcdefgh'), 2)
    assert.equal(estimateTextTokens('中文'), 4)

    const tracker = new TokenTracker([{ role: 'user', content: 'abcd' }])
    assert.equal(tracker.estimatedTokens, 1)
    tracker.updateFromAPI(100)
    tracker.addMessages([{ role: 'assistant', content: 'abcdefgh' }])
    assert.equal(tracker.estimatedTokens, 102)
    tracker.rebase(40)
    assert.equal(tracker.estimatedTokens, 40)
  })
})

describe('truncateToolResults', () => {
  it('keeps a 60/40 head-tail view and an explicit truncation marker', () => {
    const original = `HEAD-${'x'.repeat(500)}-TAIL`
    const result = truncateToolResults([toolMessage(0, original)], {
      contextWindowTokens: 200,
      contextBudgetRatio: 1,
      maxSingleToolResultRatio: 0.1,
    })
    const output = textOutput(result.messages[0]) ?? ''

    assert.equal(result.truncated, 1)
    assert.match(output, /^HEAD-/)
    assert.match(output, /\[truncated: \d+ -> \d+ chars]/)
    assert.match(output, /-TAIL$/)
    assert.ok(estimateTextTokens(output) <= 20)
    assert.ok(modelMessageSchema.safeParse(result.messages[0]).success)
  })

  it('clears oldest successful results first but preserves failure experience', () => {
    const error = 'permission denied: remember this failed path'
    const result = truncateToolResults([
      toolMessage(0, `old-${'a'.repeat(500)}`),
      toolMessage(1, error),
      toolMessage(2, `new-${'b'.repeat(500)}`),
    ], {
      contextWindowTokens: 400,
      contextBudgetRatio: 0.75,
      maxSingleToolResultRatio: 1,
    })

    assert.ok(result.compacted >= 1)
    assert.equal(textOutput(result.messages[0]), '[tool result compacted: read_file]')
    assert.equal(textOutput(result.messages[1]), error)
    assert.match(textOutput(result.messages[2]) ?? '', /^new-/)
  })
})

describe('ttlPrune', () => {
  it('soft-prunes at five minutes, expires at ten, and never prunes failures', () => {
    const now = 20 * 60_000
    const soft = `SOFT-${'s'.repeat(1_000)}-END`
    const hard = `HARD-${'h'.repeat(1_000)}-END`
    const failure = 'ERROR: file does not exist'
    const user: ModelMessage = { role: 'user', content: 'keep user history forever' }
    const messages = [toolMessage(0, soft), toolMessage(1, hard), toolMessage(2, failure), user]

    const result = ttlPrune(
      messages,
      [now - 7 * 60_000, now - 11 * 60_000, now - 20 * 60_000, 0],
      TTL_OPTIONS,
      now,
    )

    const softOutput = textOutput(result.messages[0]) ?? ''
    assert.equal(result.softPruned, 1)
    assert.equal(result.hardPruned, 1)
    assert.match(softOutput, /^SOFT-/)
    assert.match(softOutput, /\[soft pruned: read_file; middle omitted]/)
    assert.match(softOutput, /-END$/)
    assert.equal(textOutput(result.messages[1]), '[tool result expired: read_file]')
    assert.equal(textOutput(result.messages[2]), failure)
    assert.strictEqual(result.messages[3], user)
    assert.ok(result.messages.every((message) => modelMessageSchema.safeParse(message).success))

    const secondPass = ttlPrune(
      result.messages,
      result.messageTimestamps,
      TTL_OPTIONS,
      now + 4 * 60_000,
    )
    assert.equal(secondPass.softPruned, 0)
    assert.equal(secondPass.hardPruned, 1)
    assert.equal(textOutput(secondPass.messages[0]), '[tool result expired: read_file]')
  })
})
