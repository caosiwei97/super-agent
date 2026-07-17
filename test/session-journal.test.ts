import assert from 'node:assert/strict'
import { once } from 'node:events'
import { closeSync, constants, openSync } from 'node:fs'
import {
  appendFile,
  link,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { describe, it, type TestContext } from 'node:test'
import { flockSync } from 'fs-ext'
import {
  nodeSessionJournalIo,
  SessionRecordTooLargeError,
  SessionStore,
  type SessionEvent,
  type SessionJournalFile,
  type SessionJournalIo,
} from '../src/session/store.js'
import { SessionFileLease } from '../src/session/session-file-lease.js'

async function createJournal(context: TestContext, sessionId = 'journal') {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-journal-'))
  const directory = join(root, 'sessions')
  const store = await SessionStore.open(sessionId, { directory })
  context.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  return { directory, file: join(directory, `${sessionId}.jsonl`), store }
}

function persistedEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    schemaVersion: 2,
    eventId: 'event-1',
    sequence: 1,
    type: 'test.event',
    timestamp: '2026-07-15T00:00:00.000Z',
    ...overrides,
  }
}

function wrapJournalFile(
  handle: SessionJournalFile,
  overrides: Partial<SessionJournalFile>,
): SessionJournalFile {
  return {
    chmod: (mode) => handle.chmod(mode),
    truncate: (length) => handle.truncate(length),
    write: (buffer, offset, length) => handle.write(buffer, offset, length),
    datasync: () => handle.datasync(),
    close: () => handle.close(),
    ...overrides,
  }
}

function injectedIo(
  customize: (handle: SessionJournalFile) => SessionJournalFile,
): SessionJournalIo {
  return {
    readFile: (path) => nodeSessionJournalIo.readFile(path),
    open: async (path, flags, mode) => customize(
      await nodeSessionJournalIo.open(path, flags, mode),
    ),
  }
}

describe('SessionStore journal', () => {
  it('assigns unique, strictly increasing v2 metadata under concurrent appends', async (context) => {
    const { file, store } = await createJournal(context, 'concurrent')

    const appended = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        store.appendEvent({ type: 'test.event', value: index })),
    )

    assert.deepEqual(appended.map((event) => event.sequence),
      Array.from({ length: 32 }, (_, index) => index + 1))
    assert.equal(new Set(appended.map((event) => event.eventId)).size, appended.length)
    assert.ok(appended.every((event) => event.schemaVersion === 2))

    const raw = await readFile(file, 'utf-8')
    assert.ok(raw.endsWith('\n'))
    const records = raw.trimEnd().split('\n').map((line) => JSON.parse(line) as SessionEvent)
    assert.equal(records.length, 32, 'one append must produce exactly one complete JSONL record')
    assert.deepEqual(records.map((event) => event.sequence), appended.map((event) => event.sequence))
    assert.deepEqual(records.map((event) => event.value),
      Array.from({ length: 32 }, (_, index) => index))
  })

  it('supports an explicit durable append and replays it after close', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-durable-'))
    const directory = join(root, 'sessions')
    context.after(() => rm(root, { recursive: true, force: true }))
    const writer = await SessionStore.open('durable', { directory })

    const written = await writer.appendEvent(
      { type: 'test.durable', operationId: 'op-1', status: 'started' },
      'durable',
    )
    await writer.close()
    assert.equal(writer.exists(), true)

    const reader = new SessionStore('durable', { directory })
    assert.deepEqual(await reader.replayEvents(), [written])
    await reader.close()
  })

  it('idempotently commits a materialized tool result across reopen', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-materialization-'))
    const directory = join(root, 'sessions')
    context.after(() => rm(root, { recursive: true, force: true }))
    const message = {
      role: 'tool' as const,
      content: [{
        type: 'tool-result' as const,
        toolCallId: 'call-1',
        toolName: 'probe',
        output: { type: 'text' as const, value: 'done' },
      }],
    }
    const commit = {
      materializationId: 'materialization-1',
      operationId: 'operation-1',
      message,
    }
    const writer = await SessionStore.open('materialized', { directory })
    assert.equal(await writer.appendToolResult(commit), true)
    assert.equal(await writer.appendToolResult(commit), false)
    await writer.close()

    const reopened = await SessionStore.open('materialized', { directory })
    assert.equal(await reopened.appendToolResult(commit), false)
    const events = await reopened.replayEvents()
    assert.equal(events.length, 1)
    assert.equal(events[0]?.materializationId, 'materialization-1')
    assert.deepEqual((await reopened.loadState()).messages, [message])
    await reopened.close()
  })

  it('validates every known payload before async open allows appends', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-open-payload-'))
    const directory = join(root, 'sessions')
    const file = join(directory, 'invalid-payload.jsonl')
    context.after(() => rm(root, { recursive: true, force: true }))
    const bootstrap = await SessionStore.open('invalid-payload', { directory })
    await bootstrap.close()
    await writeFile(file, `${JSON.stringify(persistedEvent({
      type: 'messages',
      messages: 'not-an-array',
    }))}\n`, { encoding: 'utf-8', mode: 0o600 })

    await assert.rejects(
      SessionStore.open('invalid-payload', { directory }),
      /messages\.messages|payload|无效/i,
    )
  })

  it('scans through the pinned journal descriptor when the adapter exposes positional reads',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-pinned-read-'))
      const directory = join(root, 'sessions')
      context.after(() => rm(root, { recursive: true, force: true }))
      const writer = await SessionStore.open('pinned-read', { directory })
      await writer.appendEvent({ type: 'test.persisted' }, 'durable')
      await writer.close()
      let pathReads = 0
      const io: SessionJournalIo = {
        open: (path, flags, mode) => nodeSessionJournalIo.open(path, flags, mode),
        readFile: async () => {
          pathReads++
          throw new Error('path read must not be used')
        },
        readChunks: async function* () {
          pathReads++
          throw new Error('path stream must not be used')
        },
      }

      const reopened = await SessionStore.open('pinned-read', { directory, io })
      assert.deepEqual((await reopened.replayEvents()).map(({ sequence }) => sequence), [1])
      assert.equal(pathReads, 0)
      await reopened.close()
    })

  it('closes a newly opened journal descriptor when inode validation fails', {
    skip: process.platform === 'win32' ? 'POSIX rename semantics are required' : false,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-open-validation-close-'))
    const directory = join(root, 'sessions')
    const file = join(directory, 'unsafe-journal.jsonl')
    context.after(() => rm(root, { recursive: true, force: true }))
    const writer = await SessionStore.open('unsafe-journal', { directory })
    await writer.appendEvent({ type: 'test.persisted' }, 'durable')
    await writer.close()
    let handleClosed = false
    const io: SessionJournalIo = {
      readFile: (path) => nodeSessionJournalIo.readFile(path),
      open: async (path, flags, mode) => {
        const handle = await nodeSessionJournalIo.open(path, flags, mode)
        await rename(path, `${path}.retained`)
        await writeFile(path, 'replacement', { mode: 0o600 })
        return wrapJournalFile(handle, {
          stat: () => handle.stat!(),
          close: async () => {
            handleClosed = true
            await handle.close()
          },
        })
      },
    }

    await assert.rejects(
      SessionStore.open('unsafe-journal', { directory, io }),
      /inode|存储安全/,
    )
    assert.equal(handleClosed, true)
    assert.equal(await readFile(file, 'utf-8'), 'replacement')
  })

  it('owns checkpoint throughSequence and rejects mismatches without consuming sequence',
    async (context) => {
      const { store } = await createJournal(context, 'checkpoint-sequence')
      await store.appendEvent({ type: 'test.before-checkpoint' })
      const checkpoint = {
        type: 'checkpoint',
        messages: [{ role: 'assistant' as const, content: 'state' }],
        summary: 'summary',
        budgetUsed: 1,
      }

      await assert.rejects(
        store.appendEvent({ ...checkpoint, throughSequence: 0 }),
        /throughSequence.*1|期望 1/,
      )
      const accepted = await store.appendEvent(checkpoint)
      assert.equal(accepted.sequence, 2)
      assert.equal(accepted.throughSequence, 1)
      assert.equal((await store.appendEvent({ type: 'test.after-checkpoint' })).sequence, 3)
    })

  it('acks, accepts, and replays the canonical event represented by the written bytes',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-canonical-event-'))
      const directory = join(root, 'sessions')
      const file = join(directory, 'canonical-event.jsonl')
      context.after(() => rm(root, { recursive: true, force: true }))
      const store = await SessionStore.open('canonical-event', { directory })

      await assert.rejects(
        store.appendEvent({
          type: 'test.root-to-json',
          toJSON() {
            return {
              schemaVersion: 2,
              eventId: 'changed-by-to-json',
              sequence: 99,
              type: 'test.changed',
              timestamp: '2026-07-16T00:00:00.000Z',
            }
          },
        }),
        /序列化.*保护字段|serialization/i,
      )
      assert.equal(await readFile(file, 'utf-8'), '')

      const accepted = await store.appendEvent({
        type: 'test.nested-to-json',
        payload: {
          visible: 'memory-value',
          toJSON() {
            return { visible: 'persisted-value' }
          },
        },
      }, 'durable')
      assert.deepEqual(accepted.payload, { visible: 'persisted-value' })
      assert.deepEqual(JSON.parse((await readFile(file, 'utf-8')).trim()), accepted)
      await store.close()

      const reopened = await SessionStore.open('canonical-event', { directory })
      assert.deepEqual(await reopened.replayEvents(), [accepted])
      await reopened.close()
    })

  it('rejects persisted checkpoints whose throughSequence does not cover the prior record',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-checkpoint-mismatch-'))
      const directory = join(root, 'sessions')
      const file = join(directory, 'checkpoint-mismatch.jsonl')
      context.after(() => rm(root, { recursive: true, force: true }))
      const bootstrap = await SessionStore.open('checkpoint-mismatch', { directory })
      await bootstrap.close()
      await writeFile(file, [
        JSON.stringify(persistedEvent({ type: 'test.before-checkpoint' })),
        JSON.stringify(persistedEvent({
          eventId: 'event-2',
          sequence: 2,
          type: 'checkpoint',
          messages: [{ role: 'assistant', content: 'state' }],
          summary: 'summary',
          budgetUsed: 1,
          throughSequence: 0,
        })),
      ].join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })

      await assert.rejects(
        SessionStore.open('checkpoint-mismatch', { directory }),
        /checkpoint\.throughSequence|无效/,
      )
    })

  it('requires exactly one valid schema upgrade marker at the v1/v2 boundary',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-schema-transition-'))
      const directory = join(root, 'sessions')
      context.after(() => rm(root, { recursive: true, force: true }))
      const timestamp = '2026-07-15T00:00:00.000Z'
      const legacy = {
        type: 'message',
        timestamp,
        message: { role: 'user', content: 'legacy' },
      }
      const marker = persistedEvent({
        type: 'schema.upgraded',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
      })
      const cases: Array<{ id: string; records: Record<string, unknown>[] }> = [
        {
          id: 'missing-marker',
          records: [legacy, persistedEvent({ type: 'test.v2' })],
        },
        {
          id: 'bad-marker-payload',
          records: [legacy, { ...marker, fromSchemaVersion: 0 }],
        },
        {
          id: 'marker-without-v1',
          records: [marker],
        },
        {
          id: 'duplicate-marker',
          records: [
            legacy,
            marker,
            { ...marker, eventId: 'event-2', sequence: 2 },
          ],
        },
      ]

      for (const { id, records } of cases) {
        const bootstrap = await SessionStore.open(id, { directory })
        await bootstrap.close()
        await writeFile(
          join(directory, `${id}.jsonl`),
          records.map((record) => JSON.stringify(record)).join('\n') + '\n',
          { encoding: 'utf-8', mode: 0o600 },
        )
        await assert.rejects(
          SessionStore.open(id, { directory }),
          /schema\.upgraded|marker|无效|缺少|重复/,
          id,
        )
      }
    })

  it('rejects empty and duplicate generic materialization IDs without consuming sequence',
    async (context) => {
      const { store } = await createJournal(context, 'generic-materialization')
      const first = await store.appendEvent({
        type: 'test.materialized',
        materializationId: 'materialization-generic-1',
      })
      assert.equal(first.sequence, 1)

      await assert.rejects(
        store.appendEvent({ type: 'test.empty', materializationId: '' }),
        /materializationId.*无效/,
      )
      await assert.rejects(
        store.appendEvent({
          type: 'test.duplicate',
          materializationId: 'materialization-generic-1',
        }),
        /materializationId.*重复/,
      )
      assert.equal((await store.appendEvent({ type: 'test.next' })).sequence, 2)
    })

  it('creates private session directories and files', async (context) => {
    const { directory, file, store } = await createJournal(context, 'private')
    await store.appendEvent({ type: 'test.event' })
    const lockFile = join(directory, 'private.lock')

    if (process.platform === 'win32') return
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await stat(lockFile)).mode & 0o777, 0o600)
  })

  it('rejects a second active writer and lets close release the lock', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-writer-lock-'))
    const directory = join(root, 'sessions')
    context.after(() => rm(root, { recursive: true, force: true }))
    const first = await SessionStore.open('locked', { directory })

    await assert.rejects(SessionStore.open('locked', { directory }), /锁|lock|writer|写者/i)
    await first.close()

    const successor = await SessionStore.open('locked', { directory })
    await successor.appendEvent({ type: 'test.event', owner: 'successor' })
    await successor.close()
  })

  it('releases the fixed lock when async open fails while checking journal existence',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-open-exists-cleanup-'))
      const directory = join(root, 'sessions')
      context.after(() => rm(root, { recursive: true, force: true }))
      const originalExists = SessionFileLease.prototype.exists
      let injected = true
      SessionFileLease.prototype.exists = function existsWithInjectedFailure() {
        if (injected) {
          injected = false
          throw new Error('injected journal snapshot mismatch')
        }
        return originalExists.call(this)
      }
      try {
        await assert.rejects(
          SessionStore.open('exists-cleanup', { directory }),
          /injected journal snapshot mismatch/,
        )
      } finally {
        SessionFileLease.prototype.exists = originalExists
      }

      const successor = await SessionStore.open('exists-cleanup', { directory })
      await successor.appendEvent({ type: 'test.successor' }, 'durable')
      await successor.close()
    })

  it('ignores an unterminated EOF fragment', async (context) => {
    const { file, store } = await createJournal(context, 'partial-eof')
    const complete = await store.appendEvent({ type: 'test.event', value: 'complete' })
    await store.close()
    await appendFile(file, '{"schemaVersion":2,"eventId":"torn', 'utf-8')

    const reader = new SessionStore('partial-eof', { directory: dirname(file) })
    assert.deepEqual(await reader.replayEvents(), [complete])
    await reader.close()
  })

  it('repairs a trailing fragment even when diagnostic callbacks throw', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-diagnostic-callback-'))
    const directory = join(root, 'sessions')
    const file = join(directory, 'callback-tail.jsonl')
    context.after(() => rm(root, { recursive: true, force: true }))
    const writer = await SessionStore.open('callback-tail', { directory })
    await writer.appendEvent({ type: 'test.before-tail' }, 'durable')
    await writer.close()
    await appendFile(file, '{"torn":', 'utf-8')

    const recovered = await SessionStore.open('callback-tail', {
      directory,
      onDiagnostic: () => { throw new Error('observer diagnostic failure') },
      onWarning: () => { throw new Error('observer warning failure') },
    })
    const accepted = await recovered.appendEvent({ type: 'test.after-tail' }, 'durable')
    assert.equal(accepted.sequence, 2)
    await recovered.close()
    const raw = await readFile(file, 'utf-8')
    assert.equal(raw.trimEnd().split('\n').length, 2)
    assert.doesNotMatch(raw, /torn/)
  })

  it('fails closed when an existing journal has lost its fixed lock inode',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-missing-lock-'))
      const directory = join(root, 'sessions')
      context.after(() => rm(root, { recursive: true, force: true }))
      const writer = await SessionStore.open('missing-lock', { directory })
      await writer.appendEvent({ type: 'test.persisted' }, 'durable')
      await writer.close()
      await unlink(join(directory, 'missing-lock.lock'))

      await assert.rejects(
        SessionStore.open('missing-lock', { directory }),
        /缺少固定 lock inode|missing.*lock/i,
      )
    })

  it('never recreates a journal that disappears after the fixed lock is acquired',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-missing-journal-race-'))
      const directory = join(root, 'sessions')
      const file = join(directory, 'missing-journal-race.jsonl')
      context.after(() => rm(root, { recursive: true, force: true }))
      const writer = await SessionStore.open('missing-journal-race', { directory })
      await writer.appendEvent({ type: 'test.persisted' }, 'durable')
      await writer.close()

      const pinned = new SessionStore('missing-journal-race', { directory })
      await unlink(file)
      await assert.rejects(pinned.replayEvents(), /journal path.*消失|存储安全/i)
      await pinned.close()
      await assert.rejects(stat(file), { code: 'ENOENT' })
    })

  it('never adopts a journal path that appears after a new-session lock is acquired',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-appearing-journal-race-'))
      const directory = join(root, 'sessions')
      const file = join(directory, 'appearing-journal-race.jsonl')
      context.after(() => rm(root, { recursive: true, force: true }))
      const pinned = new SessionStore('appearing-journal-race', { directory })
      await writeFile(file, 'untrusted-existing-bytes', { mode: 0o600 })

      await assert.rejects(
        pinned.appendEvent({ type: 'test.must-not-overwrite' }),
        /EEXIST|file already exists|异常出现|存储安全/i,
      )
      await pinned.close()
      assert.equal(await readFile(file, 'utf-8'), 'untrusted-existing-bytes')

      await writeFile(file, `${JSON.stringify(persistedEvent())}\n`, { mode: 0o600 })
      const successor = await SessionStore.open('appearing-journal-race', { directory })
      await successor.close()
    })

  it('rejects replacement between journal snapshot and descriptor open', {
    skip: process.platform === 'win32' ? 'POSIX rename semantics are required' : false,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-journal-snapshot-race-'))
    const directory = join(root, 'sessions')
    const file = join(directory, 'snapshot-race.jsonl')
    context.after(() => rm(root, { recursive: true, force: true }))
    const writer = await SessionStore.open('snapshot-race', { directory })
    await writer.appendEvent({ type: 'test.original' }, 'durable')
    await writer.close()

    const pinned = new SessionStore('snapshot-race', { directory })
    await rename(file, `${file}.retained`)
    await writeFile(file, `${JSON.stringify(persistedEvent({ type: 'test.replacement' }))}\n`, {
      mode: 0o600,
    })
    await assert.rejects(pinned.replayEvents(), /journal inode|存储安全/)
    await pinned.close()
  })

  it('uses a lifetime journal flock to stop writers after the fixed lock inode splits', {
    skip: process.platform === 'win32' ? 'POSIX flock semantics are required' : false,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-split-lock-'))
    const directory = join(root, 'sessions')
    const file = join(directory, 'split-lock.jsonl')
    const lockPath = join(directory, 'split-lock.lock')
    context.after(() => rm(root, { recursive: true, force: true }))
    const writer = await SessionStore.open('split-lock', { directory })
    await writer.appendEvent({ type: 'test.persisted' }, 'durable')
    await writer.close()

    const oldWriterJournalFd = openSync(file, constants.O_RDWR)
    flockSync(oldWriterJournalFd, 'exnb')
    try {
      await rename(lockPath, `${lockPath}.old-inode`)
      await writeFile(lockPath, '', { mode: 0o600 })
      await assert.rejects(
        SessionStore.open('split-lock', { directory }),
        /journal.*锁定|writer|EAGAIN|EWOULDBLOCK/i,
      )
    } finally {
      flockSync(oldWriterJournalFd, 'un')
      closeSync(oldWriterJournalFd)
    }

    const successor = await SessionStore.open('split-lock', { directory })
    assert.deepEqual((await successor.replayEvents()).map(({ sequence }) => sequence), [1])
    await successor.close()
  })

  it('rejects lock hardlinks and journal symlinks', {
    skip: process.platform === 'win32' ? 'POSIX inode semantics are required' : false,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-unsafe-inodes-'))
    const directory = join(root, 'sessions')
    context.after(() => rm(root, { recursive: true, force: true }))
    const seed = await SessionStore.open('seed', { directory })
    await seed.close()
    await link(join(directory, 'seed.lock'), join(directory, 'hardlink.lock'))
    await assert.rejects(
      SessionStore.open('hardlink', { directory }),
      /nlink|存储安全/,
    )

    const writer = await SessionStore.open('journal-link', { directory })
    await writer.appendEvent({ type: 'test.persisted' }, 'durable')
    await writer.close()
    const journal = join(directory, 'journal-link.jsonl')
    const retained = join(directory, 'journal-link.retained')
    await rename(journal, retained)
    await symlink(retained, journal)
    await assert.rejects(
      SessionStore.open('journal-link', { directory }),
      /ELOOP|symbolic|symlink|符号链接|存储安全/i,
    )
  })

  it('detects active lock and journal path replacement before acknowledging writes', {
    skip: process.platform === 'win32' ? 'POSIX inode semantics are required' : false,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-path-swap-'))
    const directory = join(root, 'sessions')
    context.after(() => rm(root, { recursive: true, force: true }))

    const lockStore = await SessionStore.open('lock-swap', { directory })
    await lockStore.appendEvent({ type: 'test.before-lock-swap' }, 'durable')
    const lockPath = join(directory, 'lock-swap.lock')
    await rename(lockPath, `${lockPath}.retained`)
    await writeFile(lockPath, 'replacement', { mode: 0o600 })
    await assert.rejects(
      lockStore.appendEvent({ type: 'test.after-lock-swap' }),
      /lock inode|存储安全/,
    )
    await assert.rejects(lockStore.close(), /lock inode|存储安全/)
    const lockJournal = await readFile(join(directory, 'lock-swap.jsonl'), 'utf-8')
    assert.equal(lockJournal.trimEnd().split('\n').length, 1)

    const journalStore = await SessionStore.open('journal-swap', { directory })
    await journalStore.appendEvent({ type: 'test.before-journal-swap' }, 'durable')
    const journalPath = join(directory, 'journal-swap.jsonl')
    const retainedJournal = `${journalPath}.retained`
    await rename(journalPath, retainedJournal)
    await writeFile(journalPath, '', { mode: 0o600 })
    await assert.rejects(
      journalStore.appendEvent({ type: 'test.after-journal-swap' }),
      /journal inode|存储安全/,
    )
    await assert.rejects(journalStore.close(), /journal inode|存储安全/)
    assert.equal(await readFile(journalPath, 'utf-8'), '')
    assert.equal((await readFile(retainedJournal, 'utf-8')).trimEnd().split('\n').length, 1)
  })

  it('rejects a complete malformed JSONL record, including at EOF', async (context) => {
    const { file, store } = await createJournal(context, 'bad-line')
    await store.appendEvent({ type: 'test.event' })
    await store.close()
    await appendFile(file, '{broken json}\n', 'utf-8')

    const reader = new SessionStore('bad-line', { directory: dirname(file) })
    await assert.rejects(reader.replayEvents(), /损坏|JSON|第 2 行|line 2/i)
    await reader.close()
  })

  it('rejects gaps in the v2 sequence', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sequence-gap-'))
    const directory = join(root, 'sessions')
    const file = join(directory, 'gap.jsonl')
    context.after(() => rm(root, { recursive: true, force: true }))
    await SessionStore.open('gap', { directory }).then((store) => store.close())
    await writeFile(file, [
      JSON.stringify(persistedEvent()),
      JSON.stringify(persistedEvent({ eventId: 'event-3', sequence: 3 })),
    ].join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })

    const reader = new SessionStore('gap', { directory })
    await assert.rejects(reader.replayEvents(), /sequence|序列|连续|gap/i)
    await reader.close()
  })

  it('rejects duplicate v2 event IDs', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-duplicate-event-'))
    const directory = join(root, 'sessions')
    const file = join(directory, 'duplicate.jsonl')
    context.after(() => rm(root, { recursive: true, force: true }))
    await SessionStore.open('duplicate', { directory }).then((store) => store.close())
    await writeFile(file, [
      JSON.stringify(persistedEvent({ eventId: 'same-event' })),
      JSON.stringify(persistedEvent({ eventId: 'same-event', sequence: 2 })),
    ].join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })

    const reader = new SessionStore('duplicate', { directory })
    await assert.rejects(reader.replayEvents(), /eventId|重复|duplicate/i)
    await reader.close()
  })

  it('releases the kernel writer lock after a real SIGKILL', {
    skip: process.platform === 'win32' ? 'SIGKILL process semantics are POSIX-only' : false,
    timeout: 15_000,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-crash-lock-'))
    const directory = join(root, 'sessions')
    const fixture = fileURLToPath(new URL('./fixtures/session-lock-child.ts', import.meta.url))
    context.after(() => rm(root, { recursive: true, force: true }))

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fixture, directory, 'crashed-writer'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })

    const ready = new Promise<string>((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(
          `child exited before READY: code=${String(code)} signal=${String(signal)} ${stderr}`,
        ))
      }
      child.once('exit', onExit)
      lines.once('line', (line) => {
        child.off('exit', onExit)
        resolve(String(line))
      })
    })
    assert.equal(await ready, 'READY')

    assert.equal(child.kill('SIGKILL'), true)
    await once(child, 'exit')
    lines.close()
    const successor = await SessionStore.open('crashed-writer', { directory })
    const recovered = await successor.appendEvent(
      { type: 'test.recovered-writer', pid: process.pid },
      'durable',
    )
    const events = await successor.replayEvents()

    assert.equal(events[0]?.type, 'test.child-ready')
    assert.equal(events[1]?.eventId, recovered.eventId)
    assert.deepEqual(events.map((event) => event.sequence), [1, 2])
    await successor.close()
  })

  it('allows exactly one of two successors to acquire the released kernel lock', {
    skip: process.platform === 'win32' ? 'SIGKILL process semantics are POSIX-only' : false,
    timeout: 20_000,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-lock-race-'))
    const directory = join(root, 'sessions')
    const gate = join(root, 'successors.start')
    const holderFixture = fileURLToPath(new URL('./fixtures/session-lock-child.ts', import.meta.url))
    const successorFixture = fileURLToPath(
      new URL('./fixtures/session-lock-successor-child.ts', import.meta.url),
    )
    context.after(() => rm(root, { recursive: true, force: true }))

    const holder = spawn(
      process.execPath,
      ['--import', 'tsx', holderFixture, directory, 'contended-stale'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const holderLines = createInterface({ input: holder.stdout })
    const holderReady = once(holderLines, 'line').then(([line]) => String(line))
    assert.equal(await holderReady, 'READY')
    assert.equal(holder.kill('SIGKILL'), true)
    await once(holder, 'exit')
    holderLines.close()
    const contenders = Array.from({ length: 2 }, () => spawn(
      process.execPath,
      ['--import', 'tsx', successorFixture, directory, 'contended-stale', gate],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ))
    const contenderLines = contenders.map((child) => createInterface({ input: child.stdout }))
    const iterators = contenderLines.map((lines) => lines[Symbol.asyncIterator]())
    const waiting = await Promise.all(iterators.map((iterator) => iterator.next()))
    assert.deepEqual(waiting.map(({ value }) => value), ['WAITING', 'WAITING'])

    await writeFile(gate, 'go', 'utf-8')
    const outcomes = await Promise.all(iterators.map((iterator) => iterator.next()))
    const values = outcomes.map(({ value }) => String(value))
    assert.deepEqual([...values].sort(), ['ACQUIRED', 'LOCKED'])

    const winnerIndex = values.indexOf('ACQUIRED')
    assert.notEqual(winnerIndex, -1)
    assert.equal(contenders[winnerIndex]!.kill('SIGTERM'), true)
    await Promise.all(contenders.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    }))
    contenderLines.forEach((lines) => lines.close())

    const finalWriter = await SessionStore.open('contended-stale', { directory })
    const events = await finalWriter.replayEvents()
    assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2])
    await finalWriter.close()
  })

  it('fails queued and later appends closed after a write failure, then releases the lock',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-write-failure-'))
      const directory = join(root, 'sessions')
      context.after(() => rm(root, { recursive: true, force: true }))
      const io = injectedIo((handle) => wrapJournalFile(handle, {
        write: async () => {
          throw Object.assign(new Error('injected ENOSPC write failure'), { code: 'ENOSPC' })
        },
      }))
      const store = await SessionStore.open('write-failure', { directory, io })

      const first = store.appendEvent({ type: 'test.first' })
      const queued = store.appendEvent({ type: 'test.queued' })
      await assert.rejects(first, /ENOSPC/)
      await assert.rejects(queued, /ENOSPC/)
      await assert.rejects(store.appendEvent({ type: 'test.later' }), /ENOSPC/)
      await assert.rejects(store.close(), /ENOSPC/)

      const successor = await SessionStore.open('write-failure', { directory })
      assert.deepEqual(await successor.replayEvents(), [])
      await successor.close()
    })

  it('fails queued and later appends closed after datasync failure, then releases the lock',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-sync-failure-'))
      const directory = join(root, 'sessions')
      context.after(() => rm(root, { recursive: true, force: true }))
      const io = injectedIo((handle) => wrapJournalFile(handle, {
        datasync: async () => {
          throw Object.assign(new Error('injected EACCES datasync failure'), { code: 'EACCES' })
        },
      }))
      const store = await SessionStore.open('sync-failure', { directory, io })

      const first = store.appendEvent({ type: 'test.first' }, 'durable')
      const queued = store.appendEvent({ type: 'test.queued' })
      await assert.rejects(first, /EACCES/)
      await assert.rejects(queued, /EACCES/)
      await assert.rejects(store.appendEvent({ type: 'test.later' }), /EACCES/)
      await assert.rejects(store.close(), /EACCES/)

      const successor = await SessionStore.open('sync-failure', { directory })
      assert.deepEqual((await successor.replayEvents()).map(({ sequence }) => sequence), [1])
      await successor.close()
    })

  it('uses one idempotent close and releases the lock even when handle close fails',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-close-failure-'))
      const directory = join(root, 'sessions')
      context.after(() => rm(root, { recursive: true, force: true }))
      const io = injectedIo((handle) => wrapJournalFile(handle, {
        close: async () => {
          await handle.close()
          throw new Error('injected close failure')
        },
      }))
      const store = await SessionStore.open('close-failure', { directory, io })
      await store.appendEvent({ type: 'test.event' })

      const firstClose = store.close()
      const secondClose = store.close()
      assert.equal(firstClose, secondClose)
      await assert.rejects(firstClose, /injected close failure/)

      const successor = await SessionStore.open('close-failure', { directory })
      await successor.close()
      const finalWriter = await SessionStore.open('close-failure', { directory })
      await finalWriter.close()
    })

  it('rejects an oversized serialized record before writing or consuming sequence',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-record-limit-'))
      const directory = join(root, 'sessions')
      context.after(() => rm(root, { recursive: true, force: true }))
      const store = await SessionStore.open('record-limit', {
        directory,
        maxRecordBytes: 512,
      })

      await assert.rejects(
        store.appendEvent({ type: 'test.oversized', value: '界'.repeat(512) }),
        (error: unknown) => {
          assert.ok(error instanceof SessionRecordTooLargeError)
          assert.equal(error.maxRecordBytes, 512)
          assert.ok(error.actualBytes > error.maxRecordBytes)
          return true
        },
      )
      const accepted = await store.appendEvent({ type: 'test.accepted' }, 'durable')
      assert.equal(accepted.sequence, 1)
      assert.deepEqual((await store.replayEvents()).map(({ sequence }) => sequence), [1])
      await store.close()
    })

  it('admits a legacy append size before writing the v2 upgrade marker', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-legacy-record-limit-'))
    const directory = join(root, 'sessions')
    const file = join(directory, 'legacy-record-limit.jsonl')
    context.after(() => rm(root, { recursive: true, force: true }))
    const bootstrap = await SessionStore.open('legacy-record-limit', { directory })
    await bootstrap.close()
    await writeFile(file, `${JSON.stringify({
      type: 'message',
      timestamp: '2026-07-15T00:00:00.000Z',
      message: { role: 'user', content: 'legacy' },
    })}\n`, { encoding: 'utf-8', mode: 0o600 })
    const store = await SessionStore.open('legacy-record-limit', {
      directory,
      maxRecordBytes: 512,
    })
    const before = await readFile(file, 'utf-8')

    await assert.rejects(
      store.appendEvent({ type: 'test.oversized', value: 'x'.repeat(1024) }),
      SessionRecordTooLargeError,
    )
    assert.equal(await readFile(file, 'utf-8'), before)
    assert.deepEqual(await store.replayEvents(), [])

    const accepted = await store.appendEvent({ type: 'test.accepted' }, 'durable')
    assert.equal(accepted.sequence, 2)
    assert.deepEqual((await store.replayEvents()).map(({ type, sequence }) => ({
      type,
      sequence,
    })), [
      { type: 'schema.upgraded', sequence: 1 },
      { type: 'test.accepted', sequence: 2 },
    ])
    await store.close()
  })

  it('validates an operation transition before writing a legacy upgrade marker',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-legacy-operation-validation-'))
      const directory = join(root, 'sessions')
      const file = join(directory, 'legacy-operation-validation.jsonl')
      context.after(() => rm(root, { recursive: true, force: true }))
      const bootstrap = await SessionStore.open('legacy-operation-validation', { directory })
      await bootstrap.close()
      await writeFile(file, `${JSON.stringify({
        type: 'message',
        timestamp: '2026-07-15T00:00:00.000Z',
        message: { role: 'user', content: 'legacy' },
      })}\n`, { encoding: 'utf-8', mode: 0o600 })
      const store = await SessionStore.open('legacy-operation-validation', { directory })
      const before = await readFile(file, 'utf-8')

      await assert.rejects(store.appendEvent({
        type: 'operation',
        operationId: 'operation-invalid-transition',
        sessionId: 'legacy-operation-validation',
        turnId: 'turn-1',
        stepId: 'step-1',
        requestId: 'request-1',
        toolCallId: 'call-1',
        toolName: 'probe',
        capabilitySet: [],
        inputDigest: 'a'.repeat(64),
        status: 'approved',
      }), /非法 operation 状态迁移/)
      assert.equal(await readFile(file, 'utf-8'), before)
      assert.deepEqual(await store.replayEvents(), [])

      const accepted = await store.appendEvent({ type: 'test.accepted' }, 'durable')
      assert.equal(accepted.sequence, 2)
      assert.deepEqual((await store.replayEvents()).map(({ type, sequence }) => ({
        type,
        sequence,
      })), [
        { type: 'schema.upgraded', sequence: 1 },
        { type: 'test.accepted', sequence: 2 },
      ])
      await store.close()
    })
})
