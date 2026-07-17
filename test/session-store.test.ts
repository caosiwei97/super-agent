import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { SessionStore } from '../src/session/store.js'
import {
  activeSessionSegmentPath,
  readSessionEventBytes,
} from './session-storage-helpers.js'

describe('SessionStore', () => {
  it('restores the latest checkpoint plus raw tail and budget snapshot', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'super-agent-session-'))
    const warnings: string[] = []
    const store = new SessionStore('recoverable', {
      directory,
      onWarning: (warning) => warnings.push(warning),
    })
    context.after(async () => {
      await store.close()
      await rm(directory, { recursive: true, force: true })
    })
    const compacted: ModelMessage[] = [{ role: 'assistant', content: 'compact state' }]
    const tail: ModelMessage[] = [{ role: 'user', content: 'after checkpoint' }]

    await store.appendCheckpoint({ messages: compacted, summary: 'summary-v1', budgetUsed: 11 })
    await store.appendMessages(tail, 17)
    await store.close()
    const activePath = await activeSessionSegmentPath(directory, 'recoverable')
    await appendFile(activePath, '{"torn":', 'utf-8')
    const recovered = await SessionStore.open('recoverable', {
      directory,
      onWarning: (warning) => warnings.push(warning),
    })

    const restored = await recovered.loadState()

    assert.deepEqual(restored.messages, [...compacted, ...tail])
    assert.equal(restored.summary, 'summary-v1')
    assert.equal(restored.budgetUsed, 17)
    const log = (await readSessionEventBytes(directory, 'recoverable')).toString('utf-8')
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
    const checkpoint = entries.find((entry) => entry.type === 'checkpoint')
    assert.equal(checkpoint.throughSequence, 0)
    assert.equal(batch.messages.length, 1)
    assert.equal(batch.budgetUsed, 17)
    await recovered.close()
  })

  it('uses the newest checkpoint as the recovery base', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'super-agent-session-'))
    const store = new SessionStore('checkpoints', { directory })
    context.after(async () => {
      await store.close()
      await rm(directory, { recursive: true, force: true })
    })

    await store.appendMessages([{ role: 'user', content: 'superseded raw message' }], 3)
    await store.appendCheckpoint({
      messages: [{ role: 'assistant', content: 'new compact context' }],
      summary: 'latest',
      budgetUsed: 5,
    })
    await store.appendMessages([{ role: 'user', content: 'tail' }], 8)

    assert.deepEqual(await store.loadState(), {
      messages: [
        { role: 'assistant', content: 'new compact context' },
        { role: 'user', content: 'tail' },
      ],
      summary: 'latest',
      budgetUsed: 8,
    })
  })

  it('rejects path traversal in session IDs', () => {
    assert.throws(() => new SessionStore('../outside'), /非法 session ID/)
  })

  it('continues to read legacy per-message and budget events', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'super-agent-session-'))
    const timestamp = new Date().toISOString()
    const bootstrap = await SessionStore.open('legacy', { directory })
    await bootstrap.close()
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
    const store = new SessionStore('legacy', { directory })
    context.after(async () => {
      await store.close()
      await rm(directory, { recursive: true, force: true })
    })
    await store.appendMessages([{ role: 'assistant', content: 'v2 tail' }], 12)

    assert.deepEqual(await store.loadState(), {
      messages: [
        { role: 'user', content: 'legacy message' },
        { role: 'assistant', content: 'v2 tail' },
      ],
      summary: '',
      budgetUsed: 12,
    })
  })

  it('reads a pre-existing legacy record above the stricter new-write ceiling',
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), 'super-agent-session-large-legacy-'))
      const content = 'x'.repeat(1024 * 1024 + 4096)
      const bootstrap = await SessionStore.open('large-legacy', { directory })
      await bootstrap.close()
      await appendFile(join(directory, 'large-legacy.jsonl'), `${JSON.stringify({
        type: 'message',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content },
      })}\n`, 'utf-8')

      const store = await SessionStore.open('large-legacy', { directory })
      context.after(async () => {
        await store.close()
        await rm(directory, { recursive: true, force: true })
      })

      const state = await store.loadState()
      assert.equal(typeof state.messages[0]?.content, 'string')
      assert.equal(state.messages[0]?.content.length, content.length)
    })
})
