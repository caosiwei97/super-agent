import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { SessionStore } from '../src/session/store.js'

describe('SessionStore', () => {
  it('restores the latest checkpoint plus raw tail and budget snapshot', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'ti-agent-session-'))
    context.after(() => rm(directory, { recursive: true, force: true }))
    const warnings: string[] = []
    const store = new SessionStore('recoverable', {
      directory,
      onWarning: (warning) => warnings.push(warning),
    })
    const compacted: ModelMessage[] = [{ role: 'assistant', content: 'compact state' }]
    const tail: ModelMessage[] = [{ role: 'user', content: 'after checkpoint' }]

    await store.appendCheckpoint({ messages: compacted, summary: 'summary-v1', budgetUsed: 11 })
    await store.appendMessages(tail, 17)
    await appendFile(join(directory, 'recoverable.jsonl'), '{broken json}\n', 'utf-8')

    const restored = await store.loadState()

    assert.deepEqual(restored.messages, [...compacted, ...tail])
    assert.equal(restored.messageTimestamps.length, restored.messages.length)
    assert.equal(restored.summary, 'summary-v1')
    assert.equal(restored.budgetUsed, 17)
    assert.equal(warnings.length, 1)

    const log = await readFile(join(directory, 'recoverable.jsonl'), 'utf-8')
    assert.match(log, /"type":"checkpoint"/)
    assert.match(log, /"type":"messages"/)
    const entries = log.trim().split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    const batch = entries.find((entry) => entry.type === 'messages')
    assert.equal(batch.messages.length, 1)
    assert.equal(batch.budgetUsed, 17)
  })

  it('uses the newest checkpoint as the recovery base', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'ti-agent-session-'))
    context.after(() => rm(directory, { recursive: true, force: true }))
    const store = new SessionStore('checkpoints', { directory })

    await store.appendMessages([{ role: 'user', content: 'superseded raw message' }], 3)
    await store.appendCheckpoint({
      messages: [{ role: 'assistant', content: 'new compact context' }],
      messageTimestamps: [123],
      summary: 'latest',
      budgetUsed: 5,
    })
    await store.appendMessages([{ role: 'user', content: 'tail' }], 8)

    const restored = await store.loadState()
    assert.deepEqual(restored.messages, [
      { role: 'assistant', content: 'new compact context' },
      { role: 'user', content: 'tail' },
    ])
    assert.equal(restored.messageTimestamps.length, 2)
    assert.equal(restored.messageTimestamps[0], 123)
    assert.deepEqual({ summary: restored.summary, budgetUsed: restored.budgetUsed }, {
      summary: 'latest',
      budgetUsed: 8,
    })
  })

  it('rejects path traversal in session IDs', () => {
    assert.throws(() => new SessionStore('../outside'), /非法 session ID/)
  })

  it('continues to read legacy per-message and budget events', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'ti-agent-session-'))
    context.after(() => rm(directory, { recursive: true, force: true }))
    const store = new SessionStore('legacy', { directory })
    const timestamp = new Date().toISOString()
    await appendFile(
      join(directory, 'legacy.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          timestamp,
          message: { role: 'user', content: 'legacy message' },
        }),
        JSON.stringify({ type: 'budget', timestamp, budgetUsed: 9 }),
      ].join('\n') + '\n',
      'utf-8',
    )

    assert.deepEqual(await store.loadState(), {
      messages: [{ role: 'user', content: 'legacy message' }],
      messageTimestamps: [Date.parse(timestamp)],
      summary: '',
      budgetUsed: 9,
    })
  })
})
