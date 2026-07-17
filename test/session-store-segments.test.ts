import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseOperationEvent } from '../src/execution/operation-ledger.js'
import {
  parseSessionFence,
  parseSessionFormatBytes,
  parseSessionSegmentFileName,
} from '../src/session/session-layout.js'
import { SessionQuotaError } from '../src/session/session-quota.js'
import {
  nodeSessionSegmentStorageIo,
  type SessionSegmentFile,
  type SessionSegmentStorageIo,
} from '../src/session/session-segment-storage.js'
import { SessionStore, type SessionEventInput } from '../src/session/store.js'
import {
  readSessionEventBytes,
  sessionBundlePaths,
  sessionSegmentPaths,
} from './session-storage-helpers.js'

const storageLimits = Object.freeze({
  maxRecordBytes: 1024,
  maxReadRecordBytes: 4096,
  segmentTargetBytes: 360,
  regularQuotaBytes: 1024 * 1024,
  criticalReserveBytes: 16 * 1024,
})

function operation(
  sessionId: string,
  operationId: string,
  status: string,
  fields: Record<string, unknown> = {},
): SessionEventInput {
  return {
    type: 'operation',
    operationId,
    sessionId,
    turnId: 'turn-1',
    stepId: 'step-1',
    requestId: 'request-1',
    toolCallId: 'call-1',
    toolName: 'probe',
    capabilitySet: [],
    inputDigest: 'a'.repeat(64),
    status,
    ...fields,
  }
}

describe('SessionStore layout-v1 integration', () => {
  it('persists exact fence/format and resumes a globally ordered stream across rotations',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-store-segments-'))
      const sessionId = 'cross-segment'
      context.after(() => rm(root, { recursive: true, force: true }))
      const store = await SessionStore.open(sessionId, { directory: root, ...storageLimits })
      const accepted = []
      for (let index = 0; index < 12; index++) {
        accepted.push(await store.appendEvent({
          type: 'test.unicode',
          value: `${index}:密😀:${'x'.repeat(32)}`,
        }, 'durable'))
      }
      await store.close()

      const fence = await readFile(join(root, `${sessionId}.jsonl`))
      const generation = parseSessionFence(fence)
      const paths = await sessionBundlePaths(root, sessionId)
      assert.equal(paths.generationPath.endsWith(generation), true)
      const format = parseSessionFormatBytes(await readFile(paths.formatPath), {
        sessionId,
        generation,
        limits: storageLimits,
      })
      assert.deepEqual(format.limits, storageLimits)

      const names = await readdir(paths.segmentsPath)
      const segments = names.map((name) => parseSessionSegmentFileName(name))
        .filter((value) => value !== undefined)
        .sort((left, right) => left.ordinal - right.ordinal)
      assert.ok(segments.length > 1)
      assert.ok(segments.slice(0, -1).every(({ state }) => state === 'sealed'))
      assert.equal(segments.at(-1)?.state, 'active')

      const manifestText = (await readFile(paths.manifestPath, 'utf8'))
      assert.doesNotMatch(manifestText, /nextSequence|eventIds|materializationIds|operations/i)
      const reopened = await SessionStore.open(sessionId, { directory: root })
      assert.deepEqual(await reopened.replayEvents(), accepted)
      await reopened.close()
      await assert.rejects(
        SessionStore.open(sessionId, { directory: root, segmentTargetBytes: 361 }),
        /conflict/i,
      )
    })

  it('rejects started admission before write, rotation, sequence, or dispatch capacity exists',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-store-quota-'))
      const sessionId = 'started-quota'
      context.after(() => rm(root, { recursive: true, force: true }))
      const store = await SessionStore.open(sessionId, {
        directory: root,
        maxRecordBytes: 1024,
        maxReadRecordBytes: 4096,
        segmentTargetBytes: 256,
        regularQuotaBytes: 1024 * 1024,
        criticalReserveBytes: 2 * 1024,
      })
      const proposed = parseOperationEvent(await store.appendEvent(
        operation(sessionId, 'operation-1', 'proposed'),
        'durable',
      ))
      const approved = parseOperationEvent(await store.appendEvent(
        operation(sessionId, 'operation-1', 'approved'),
        'durable',
      ))
      assert.equal(proposed.sequence, 1)
      assert.equal(approved.sequence, 2)
      const beforeBytes = await readSessionEventBytes(root, sessionId)
      const beforeSegments = (await sessionSegmentPaths(root, sessionId)).entries
        .map(({ fileName }) => fileName)

      await assert.rejects(
        store.appendEvent(operation(sessionId, 'operation-1', 'started', {
          attemptId: 'attempt-1',
        }), 'durable'),
        (error: unknown) => error instanceof SessionQuotaError &&
          error.code === 'critical_reserve_exceeded',
      )
      assert.deepEqual(await readSessionEventBytes(root, sessionId), beforeBytes)
      assert.deepEqual(
        (await sessionSegmentPaths(root, sessionId)).entries.map(({ fileName }) => fileName),
        beforeSegments,
      )

      const cancelled = parseOperationEvent(await store.appendEvent(
        operation(sessionId, 'operation-1', 'cancelled', {
          cancellationProof: 'not_dispatched',
          errorCode: 'quota_rejected_before_dispatch',
        }),
        'durable',
      ))
      assert.equal(cancelled.sequence, 3)
      assert.deepEqual((await store.replayEvents()).filter(({ type }) => type === 'operation')
        .map((event) => parseOperationEvent(event).status), [
        'proposed', 'approved', 'cancelled',
      ])
      await store.close()
    })

  it('preflights a legacy schema marker and business event without leaving marker-only state',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-store-marker-batch-'))
      const sessionId = 'marker-batch'
      context.after(() => rm(root, { recursive: true, force: true }))
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeFile(join(root, `${sessionId}.lock`), '', { mode: 0o600 })
      const legacyBytes = Buffer.from(`${JSON.stringify({
        type: 'message',
        timestamp: '2026-07-17T00:00:00.000Z',
        message: { role: 'user', content: 'legacy' },
      })}\n`)
      await writeFile(join(root, `${sessionId}.jsonl`), legacyBytes, { mode: 0o600 })
      const store = await SessionStore.open(sessionId, {
        directory: root,
        maxRecordBytes: 1024,
        maxReadRecordBytes: 4096,
        segmentTargetBytes: 4096,
        regularQuotaBytes: legacyBytes.length,
        criticalReserveBytes: 4096,
      })
      const before = await readSessionEventBytes(root, sessionId)
      await assert.rejects(
        store.appendEvent({ type: 'test.must-not-leave-marker' }, 'durable'),
        (error: unknown) => error instanceof SessionQuotaError &&
          error.code === 'regular_quota_exceeded',
      )
      assert.deepEqual(await readSessionEventBytes(root, sessionId), before)
      assert.deepEqual(await store.replayEvents(), [])
      assert.equal((await store.loadState()).messages.length, 1)
      await store.close()
    })

  it('keeps an over-hard legacy journal canonical and does not publish the fence',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-store-migration-quota-'))
      const sessionId = 'legacy-over-hard'
      context.after(() => rm(root, { recursive: true, force: true }))
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeFile(join(root, `${sessionId}.lock`), '', { mode: 0o600 })
      const legacyEvent = {
        schemaVersion: 2,
        eventId: 'legacy-proposal',
        sequence: 1,
        timestamp: '2026-07-17T00:00:00.000Z',
        ...operation(sessionId, 'legacy-operation', 'proposed'),
      }
      const legacyBytes = Buffer.from(`${JSON.stringify(legacyEvent)}\n`)
      const journalPath = join(root, `${sessionId}.jsonl`)
      await writeFile(journalPath, legacyBytes, { mode: 0o600 })

      await assert.rejects(SessionStore.open(sessionId, {
        directory: root,
        maxRecordBytes: 1024,
        maxReadRecordBytes: 4096,
        segmentTargetBytes: 4096,
        regularQuotaBytes: 1,
        criticalReserveBytes: 2048,
      }), /obligations exceed|quota/i)
      assert.deepEqual(await readFile(journalPath), legacyBytes)
      assert.throws(() => parseSessionFence(legacyBytes))

      const retried = await SessionStore.open(sessionId, {
        directory: root,
        maxRecordBytes: 1024,
        maxReadRecordBytes: 4096,
        segmentTargetBytes: 4096,
        regularQuotaBytes: 1024 * 1024,
        criticalReserveBytes: 4096,
      })
      await retried.close()
      const fence = await readFile(journalPath)
      assert.doesNotThrow(() => parseSessionFence(fence))
    })

  it('reports a failed manifest rebuild as unrepaired while segment facts stay usable',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-store-manifest-warning-'))
      const sessionId = 'manifest-unrepaired'
      context.after(() => rm(root, { recursive: true, force: true }))
      const initial = await SessionStore.open(sessionId, {
        directory: root,
        ...storageLimits,
      })
      await initial.appendEvent({ type: 'test.manifest-cache-independent' }, 'durable')
      await initial.close()
      const paths = await sessionBundlePaths(root, sessionId)
      await rm(paths.manifestPath)
      const diagnostics: Array<{ code: string; repaired: boolean; message: string }> = []
      let warnings = 0
      const segmentIo: SessionSegmentStorageIo = {
        ...nodeSessionSegmentStorageIo,
        async rename(from, to) {
          if (to.endsWith('/manifest.json')) {
            const error = new Error('injected manifest rename EIO') as NodeJS.ErrnoException
            error.code = 'EIO'
            throw error
          }
          await nodeSessionSegmentStorageIo.rename(from, to)
        },
      }
      const store = await SessionStore.open(sessionId, {
        directory: root,
        ...storageLimits,
        segmentIo,
        onDiagnostic(value) {
          diagnostics.push(value)
        },
        onWarning() {
          warnings++
        },
      })
      const diagnostic = diagnostics.find(({ code }) => code === 'manifest_missing')
      assert.ok(diagnostic)
      assert.equal(diagnostic.repaired, false)
      assert.match(diagnostic.message, /重建失败/)
      assert.ok(warnings > 0)
      await assert.rejects(readFile(paths.manifestPath), { code: 'ENOENT' })
      await store.appendEvent({ type: 'test.manifest-cache-still-independent' }, 'durable')
      await store.close()
    })

  it('localizes online scan failures to a segment path and segment-local offsets',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-store-segment-diagnostic-'))
      const sessionId = 'segment-diagnostic'
      context.after(() => rm(root, { recursive: true, force: true }))
      const diagnostics: Array<{
        code: string
        path: string
        line?: number
        byteOffset?: number
      }> = []
      const store = await SessionStore.open(sessionId, {
        directory: root,
        ...storageLimits,
        onDiagnostic(value) {
          diagnostics.push(value)
        },
      })
      for (let index = 0; index < 5; index++) {
        await store.appendEvent({
          type: 'test.segment-diagnostic',
          value: `${index}:${'x'.repeat(96)}`,
        }, 'durable')
      }
      const { entries } = await sessionSegmentPaths(root, sessionId)
      assert.ok(entries.length > 1)
      const active = entries.at(-1)!
      assert.equal(active.state, 'active')
      const bytes = await readFile(active.path)
      assert.ok(bytes.length > 1)
      const corrupt = Buffer.alloc(bytes.length, 0x20)
      corrupt[0] = 0x7b
      corrupt[corrupt.length - 1] = 0x0a
      await writeFile(active.path, corrupt)

      await assert.rejects(store.replayEvents(), /invalid_json/)
      const diagnostic = diagnostics.find(({ code }) => code === 'invalid_json')
      assert.ok(diagnostic)
      assert.equal(diagnostic.path, active.path)
      assert.equal(diagnostic.line, 1)
      assert.equal(diagnostic.byteOffset, 0)
      await store.close().catch(() => undefined)
    })

  it('closes every segment descriptor before retrying a failed lazy recovery',
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-store-recovery-fd-'))
      const sessionId = 'lazy-recovery-fd-balance'
      context.after(() => rm(root, { recursive: true, force: true }))
      const outstanding = new Set<number>()
      let opens = 0
      let closes = 0
      let injectTransientFailure = true
      const segmentIo: SessionSegmentStorageIo = {
        ...nodeSessionSegmentStorageIo,
        async open(path, flags, mode) {
          const handle = await nodeSessionSegmentStorageIo.open(path, flags, mode)
          const fd = handle.fd
          opens++
          outstanding.add(fd)
          const readOnly = (flags & (constants.O_WRONLY | constants.O_RDWR)) === 0
          const wrapped: SessionSegmentFile = {
            fd,
            chmod: (value) => handle.chmod(value),
            async stat() {
              const metadata = await handle.stat()
              if (injectTransientFailure && readOnly && path.endsWith('.active.jsonl') &&
                  outstanding.size >= 4) {
                injectTransientFailure = false
                throw new Error('injected transient post-open recovery failure')
              }
              return metadata
            },
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, length, position),
            write: (buffer, offset, length) => handle.write(buffer, offset, length),
            truncate: (length) => handle.truncate(length),
            datasync: () => handle.datasync(),
            async close() {
              try {
                await handle.close()
              } finally {
                if (outstanding.delete(fd)) closes++
              }
            },
          }
          return wrapped
        },
      }
      const store = await SessionStore.open(sessionId, {
        directory: root,
        ...storageLimits,
        segmentIo,
      })
      context.after(() => store.close().catch(() => undefined))
      await assert.rejects(
        store.appendEvent({ type: 'test.first-init-must-fail' }, 'durable'),
        /transient post-open recovery failure/,
      )
      assert.equal(outstanding.size, 0)

      await store.appendEvent({ type: 'test.retry-succeeds' }, 'durable')
      assert.equal(outstanding.size, 3)
      await store.close()
      assert.equal(outstanding.size, 0)
      assert.equal(closes, opens)
    })
})
