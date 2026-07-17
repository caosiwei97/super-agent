import assert from 'node:assert/strict'
import { closeSync, constants, openSync, renameSync, writeFileSync } from 'node:fs'
import {
  appendFile,
  chmod,
  link,
  mkdtemp,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { flockSync } from 'fs-ext'
import {
  diagnoseSession,
  nodeSessionDoctorIo,
  type SessionDoctorIo,
} from '../src/session/doctor.js'
import { SessionStore, type SessionStoreDiagnostic } from '../src/session/store.js'
import { activeSessionSegmentPath } from './session-storage-helpers.js'

async function createClosedSession(root: string, sessionId: string) {
  const store = await SessionStore.open(sessionId, { directory: root })
  await store.appendEvent({ type: 'test.event' }, 'durable')
  await store.close()
  return {
    journalPath: join(root, `${sessionId}.jsonl`),
    lockPath: join(root, `${sessionId}.lock`),
    activePath: await activeSessionSegmentPath(root, sessionId),
  }
}

describe('session doctor', () => {
  it('reports a missing journal without creating the directory or lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-missing-'))
    const directory = join(root, 'sessions')
    try {
      const report = await diagnoseSession('missing', { directory })
      assert.equal(report.status, 'missing')
      assert.equal(report.diagnostics[0]?.code, 'journal_missing')
      await assert.rejects(stat(directory), { code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns a structured healthy report after clean close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-healthy-'))
    const store = await SessionStore.open('healthy', { directory: root })
    try {
      await store.appendCheckpoint({
        messages: [{ role: 'user', content: 'hello' }],
        summary: 'safe summary',
        budgetUsed: 1,
      })
      await store.close()

      const lockPath = join(root, 'healthy.lock')
      const lockBefore = await stat(lockPath)

      const report = await diagnoseSession('healthy', { directory: root })
      assert.equal(report.status, 'healthy')
      assert.equal(report.recordCount, 1)
      assert.equal(report.v2RecordCount, 1)
      assert.equal(report.nextSequence, 2)
      assert.deepEqual(report.diagnostics, [])
      const lockAfter = await stat(lockPath)
      assert.equal(lockAfter.ino, lockBefore.ino, 'doctor must preserve the fixed lock inode')
      assert.equal(lockAfter.nlink, 1)
    } finally {
      await store.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('diagnoses but does not repair an EOF fragment; writer recovery reports the repair',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-tail-'))
      const store = await SessionStore.open('tail', { directory: root })
      try {
        await store.appendEvent({ type: 'test.complete' }, 'durable')
        await store.close()
        const path = await activeSessionSegmentPath(root, 'tail')
        await appendFile(path, '{"unfinished":', 'utf-8')
        const before = await stat(path)

        const report = await diagnoseSession('tail', { directory: root })
        assert.equal(report.status, 'recoverable')
        assert.equal(report.diagnostics[0]?.code, 'trailing_eof_fragment')
        assert.equal(report.diagnostics[0]?.repaired, false)
        assert.equal((await stat(path)).size, before.size)

        const diagnostics: SessionStoreDiagnostic[] = []
        const recovered = await SessionStore.open('tail', {
          directory: root,
          onDiagnostic: (value) => diagnostics.push(value),
          onWarning: () => undefined,
        })
        await recovered.close()
        assert.equal(diagnostics[0]?.code, 'trailing_eof_fragment')
        assert.equal(diagnostics[0]?.repaired, true)
        assert.ok((await stat(path)).size < before.size)
      } finally {
        await store.close().catch(() => undefined)
        await rm(root, { recursive: true, force: true })
      }
    })

  it('returns busy without reading a journal held by an active writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-busy-'))
    const store = await SessionStore.open('busy', { directory: root })
    try {
      await store.appendEvent({ type: 'test.event' }, 'durable')
      const report = await diagnoseSession('busy', { directory: root })
      assert.equal(report.status, 'busy')
      assert.equal(report.diagnostics[0]?.code, 'writer_busy')
      assert.equal(report.recordCount, 0)
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns busy when a split-lock writer holds the canonical journal', {
    skip: process.platform === 'win32' ? 'POSIX flock contract is required' : false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-split-lock-'))
    const { journalPath, lockPath, activePath } = await createClosedSession(root, 'split-lock')
    await appendFile(activePath, '{malformed complete record}\n', 'utf-8')
    const oldLockFd = openSync(lockPath, constants.O_RDWR)
    let journalFd: number | undefined
    try {
      flockSync(oldLockFd, 'exnb')
      renameSync(lockPath, `${lockPath}.retired`)
      writeFileSync(lockPath, '', { mode: 0o600 })
      journalFd = openSync(journalPath, constants.O_RDWR)
      flockSync(journalFd, 'exnb')

      const report = await diagnoseSession('split-lock', { directory: root })
      assert.equal(report.status, 'busy')
      assert.equal(report.diagnostics[0]?.code, 'writer_busy')
      assert.equal(report.diagnostics[0]?.path, journalPath)
      assert.equal(report.recordCount, 0, 'doctor must not scan a writer-locked journal')
    } finally {
      if (journalFd !== undefined) {
        try {
          flockSync(journalFd, 'un')
        } finally {
          closeSync(journalFd)
        }
      }
      try {
        flockSync(oldLockFd, 'un')
      } finally {
        closeSync(oldLockFd)
      }
    }

    try {
      const afterRelease = await diagnoseSession('split-lock', { directory: root })
      assert.equal(afterRelease.status, 'corrupt')
      assert.equal(afterRelease.diagnostics[0]?.code, 'invalid_json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not include malformed journal contents in diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-secret-'))
    const secret = 'sk-doctor-secret-marker'
    const store = await SessionStore.open('corrupt', { directory: root })
    try {
      await store.appendEvent({ type: 'test.event' }, 'durable')
      await store.close()
      await appendFile(
        await activeSessionSegmentPath(root, 'corrupt'),
        `{"value":"${secret}" BROKEN}\n`,
        'utf-8',
      )

      const report = await diagnoseSession('corrupt', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'invalid_json')
      assert.doesNotMatch(JSON.stringify(report), new RegExp(secret))
    } finally {
      await store.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates known record payloads without retaining conversation state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-payload-'))
    const { activePath } = await createClosedSession(root, 'payload')
    try {
      await appendFile(activePath, `${JSON.stringify({
        schemaVersion: 2,
        eventId: 'invalid-messages-event',
        sequence: 2,
        type: 'messages',
        timestamp: '2026-07-16T00:00:00.000Z',
        messages: { secret: 'must-not-be-retained' },
      })}\n`, 'utf-8')

      const report = await diagnoseSession('payload', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'invalid_record_payload')
      assert.equal(report.diagnostics[0]?.line, 2)
      assert.doesNotMatch(JSON.stringify(report), /must-not-be-retained/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires an explicit schema upgrade marker after a v1 prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-upgrade-boundary-'))
    const store = await SessionStore.open('upgrade-boundary', { directory: root })
    await store.close()
    const journalPath = join(root, 'upgrade-boundary.jsonl')
    try {
      await writeFile(journalPath, [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-07-16T00:00:00.000Z',
          message: { role: 'user', content: 'legacy' },
        }),
        JSON.stringify({
          schemaVersion: 2,
          eventId: 'direct-v2',
          sequence: 1,
          type: 'test.event',
          timestamp: '2026-07-16T00:00:01.000Z',
        }),
      ].join('\n') + '\n', { mode: 0o600 })

      const report = await diagnoseSession('upgrade-boundary', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'invalid_record_payload')
      assert.equal(report.diagnostics[0]?.line, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a schema upgrade marker without a preceding v1 record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-orphan-marker-'))
    const store = await SessionStore.open('orphan-marker', { directory: root })
    await store.close()
    const journalPath = join(root, 'orphan-marker.jsonl')
    try {
      await writeFile(journalPath, `${JSON.stringify({
        schemaVersion: 2,
        eventId: 'orphan-upgrade',
        sequence: 1,
        type: 'schema.upgraded',
        timestamp: '2026-07-16T00:00:00.000Z',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
      })}\n`, { mode: 0o600 })

      const report = await diagnoseSession('orphan-marker', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'invalid_record_payload')
      assert.equal(report.diagnostics[0]?.line, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a checkpoint whose throughSequence does not match its sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-checkpoint-sequence-'))
    const store = await SessionStore.open('checkpoint-sequence', { directory: root })
    await store.close()
    const journalPath = join(root, 'checkpoint-sequence.jsonl')
    try {
      await writeFile(journalPath, `${JSON.stringify({
        schemaVersion: 2,
        eventId: 'bad-checkpoint-sequence',
        sequence: 1,
        type: 'checkpoint',
        timestamp: '2026-07-16T00:00:00.000Z',
        messages: [],
        summary: '',
        budgetUsed: 0,
        throughSequence: 1,
      })}\n`, { mode: 0o600 })

      const report = await diagnoseSession('checkpoint-sequence', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'invalid_record_payload')
      assert.equal(report.diagnostics[0]?.line, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('scans many near-ceiling records without retaining the conversation projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-streaming-'))
    const sessionId = 'streaming'
    const bootstrap = await SessionStore.open(sessionId, { directory: root })
    await bootstrap.close()
    const records = Array.from({ length: 2_000 }, (_, index) => JSON.stringify({
      schemaVersion: 2,
      eventId: `stream-event-${index + 1}`,
      sequence: index + 1,
      type: 'messages',
      timestamp: '2026-07-16T00:00:00.000Z',
      messages: [{ role: 'user', content: `${index}:`.padEnd(700, 'x') }],
    }))
    try {
      await writeFile(
        join(root, `${sessionId}.jsonl`),
        `${records.join('\n')}\n`,
        { mode: 0o600 },
      )

      const report = await diagnoseSession(sessionId, {
        directory: root,
        maxReadRecordBytes: 1_024,
      })
      assert.equal(report.status, 'healthy')
      assert.equal(report.recordCount, records.length)
      assert.equal(report.nextSequence, records.length + 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a missing fixed lock inode without creating a replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-lock-missing-'))
    const { lockPath } = await createClosedSession(root, 'lock-missing')
    try {
      await unlink(lockPath)

      const report = await diagnoseSession('lock-missing', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'lock_missing')
      await assert.rejects(stat(lockPath), { code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses dangling symlinks instead of treating them as missing storage', {
    skip: process.platform === 'win32' ? 'O_NOFOLLOW contract is POSIX-only' : false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-symlink-'))
    const journalPath = join(root, 'symlink.jsonl')
    try {
      await symlink(join(root, 'missing-target'), journalPath)
      await writeFile(join(root, 'symlink.lock'), '', { mode: 0o600 })

      const report = await diagnoseSession('symlink', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'unsafe_file_metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a hard-linked fixed lock inode', {
    skip: process.platform === 'win32' ? 'POSIX inode contract is required' : false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-hardlink-'))
    const { lockPath } = await createClosedSession(root, 'hardlink')
    try {
      await link(lockPath, `${lockPath}.alias`)

      const report = await diagnoseSession('hardlink', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'unsafe_file_metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses storage whose private file mode changed', {
    skip: process.platform === 'win32' ? 'POSIX mode contract is required' : false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-mode-'))
    const { journalPath } = await createClosedSession(root, 'mode')
    try {
      await chmod(journalPath, 0o640)

      const report = await diagnoseSession('mode', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'unsafe_file_metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('detects replacement of the fixed lock inode while acquiring the shared lock', {
    skip: process.platform === 'win32' ? 'POSIX inode contract is required' : false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-replaced-lock-'))
    const { lockPath } = await createClosedSession(root, 'replaced-lock')
    let replaced = false
    const io: SessionDoctorIo = {
      ...nodeSessionDoctorIo,
      flock: (fd, operation) => {
        nodeSessionDoctorIo.flock(fd, operation)
        if (operation === 'shnb' && !replaced) {
          renameSync(lockPath, `${lockPath}.retired`)
          writeFileSync(lockPath, '', { mode: 0o600 })
          replaced = true
        }
      },
    }
    try {
      const report = await diagnoseSession('replaced-lock', { directory: root, io })
      assert.equal(replaced, true)
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'unsafe_file_metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('releases journal before fixed lock and continues closing after unlock failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-cleanup-'))
    await createClosedSession(root, 'cleanup')
    const sharedFds: number[] = []
    const lifecycle: string[] = []
    const io: SessionDoctorIo = {
      ...nodeSessionDoctorIo,
      flock: (fd, operation) => {
        if (operation === 'shnb') {
          nodeSessionDoctorIo.flock(fd, operation)
          sharedFds.push(fd)
          return
        }
        const label = fd === sharedFds[1] ? 'journal' : 'fixed'
        lifecycle.push(`${label}-unlock`)
        nodeSessionDoctorIo.flock(fd, operation)
        if (label === 'journal') {
          throw Object.assign(new Error('injected journal unlock failure'), { code: 'EIO' })
        }
      },
      close: (fd) => {
        nodeSessionDoctorIo.close(fd)
        if (fd === sharedFds[1]) {
          lifecycle.push('journal-close')
          throw Object.assign(new Error('injected journal close failure'), { code: 'EIO' })
        }
        if (fd === sharedFds[0]) {
          lifecycle.push('fixed-close')
        }
      },
    }
    try {
      const report = await diagnoseSession('cleanup', { directory: root, io })
      assert.equal(report.status, 'corrupt')
      assert.deepEqual(lifecycle, [
        'journal-unlock',
        'journal-close',
        'fixed-unlock',
        'fixed-close',
      ])
      assert.equal(
        report.diagnostics.some((value) => value.code === 'lock_release_failed'),
        true,
      )

      const secondReport = await diagnoseSession('cleanup', { directory: root })
      assert.equal(secondReport.status, 'healthy', 'lock fd must be closed despite unlock failure')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
