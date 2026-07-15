import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { describe, it, type TestContext } from 'node:test'
import {
  nodeSessionJournalIo,
  SessionStore,
  type SessionEvent,
  type SessionJournalFile,
  type SessionJournalIo,
} from '../src/session/store.js'

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

  it('ignores an unterminated EOF fragment', async (context) => {
    const { file, store } = await createJournal(context, 'partial-eof')
    const complete = await store.appendEvent({ type: 'test.event', value: 'complete' })
    await store.close()
    await appendFile(file, '{"schemaVersion":2,"eventId":"torn', 'utf-8')

    const reader = new SessionStore('partial-eof', { directory: dirname(file) })
    assert.deepEqual(await reader.replayEvents(), [complete])
    await reader.close()
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
})
