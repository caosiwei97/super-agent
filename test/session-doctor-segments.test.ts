import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, constants, openSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { flockSync } from 'fs-ext'
import {
  diagnoseSession,
  nodeSessionDoctorIo,
  type SessionDoctorIo,
} from '../src/session/doctor.js'
import {
  createSessionFormat,
  deterministicSessionJsonBytes,
  encodeSessionFence,
  formatSessionSegmentFileName,
  LEGACY_JSONL_SOURCE_KIND,
  resolveSessionBundlePaths,
  type SessionStorageLimits,
} from '../src/session/session-layout.js'
import { encodeSessionManifest } from '../src/session/session-segment-storage.js'

interface SegmentFixture {
  readonly ordinal: number
  readonly state: 'active' | 'sealed'
  readonly bytes: Uint8Array
}

function event(sequence: number, eventId = `event-${sequence}`) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    eventId,
    sequence,
    type: 'test.event',
    timestamp: '2026-07-17T00:00:00.000Z',
  })}\n`, 'utf8')
}

function operationEvent(
  sequence: number,
  operationId: string,
  status: 'proposed' | 'started',
) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    eventId: `operation-event-${sequence}`,
    sequence,
    type: 'operation',
    timestamp: '2026-07-17T00:00:00.000Z',
    operationId,
    sessionId: 'doctor-operation',
    turnId: 'turn-1',
    stepId: 'step-1',
    requestId: 'request-1',
    toolCallId: `call-${operationId}`,
    toolName: 'probe',
    capabilitySet: [],
    inputDigest: 'a'.repeat(64),
    status,
    ...(status === 'started' ? { attemptId: 'attempt-1' } : {}),
  })}\n`, 'utf8')
}

async function createSegmentedFixture(
  root: string,
  sessionId: string,
  segments: readonly SegmentFixture[],
  options: {
    readonly limits?: Partial<SessionStorageLimits>
    readonly manifestBytes?: Uint8Array
  } = {},
) {
  const emptySha256 = createHash('sha256').digest('hex')
  const format = createSessionFormat({
    sessionId,
    source: {
      kind: LEGACY_JSONL_SOURCE_KIND,
      byteLength: 0,
      sha256: emptySha256,
    },
    limits: options.limits,
  })
  const paths = resolveSessionBundlePaths(root, sessionId, format.generation)
  await writeFile(paths.fixedLockPath, '', { mode: 0o600 })
  await mkdir(paths.bundleRootPath, { mode: 0o700 })
  await mkdir(paths.generationPath, { mode: 0o700 })
  await mkdir(paths.segmentsPath, { mode: 0o700 })
  await writeFile(paths.formatPath, deterministicSessionJsonBytes(format), { mode: 0o600 })
  if (options.manifestBytes !== undefined) {
    await writeFile(paths.manifestPath, options.manifestBytes, { mode: 0o600 })
  }
  for (const segment of segments) {
    await writeFile(
      join(paths.segmentsPath, formatSessionSegmentFileName(segment.ordinal, segment.state)),
      segment.bytes,
      { mode: 0o600 },
    )
  }
  await writeFile(paths.legacyJournalPath, encodeSessionFence(format.generation), { mode: 0o600 })
  return { format, paths }
}

describe('session doctor segmented storage', () => {
  it('scans sequence and IDs globally across every continuous segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-segments-'))
    try {
      const { paths } = await createSegmentedFixture(root, 'segments', [
        { ordinal: 1, state: 'sealed', bytes: Buffer.concat([event(1), event(2)]) },
        { ordinal: 2, state: 'active', bytes: event(3) },
      ])

      const report = await diagnoseSession('segments', { directory: root })
      assert.equal(report.status, 'recoverable', 'missing rebuildable manifest is a warning')
      assert.equal(report.recordCount, 3)
      assert.equal(report.v2RecordCount, 3)
      assert.equal(report.nextSequence, 4)
      assert.equal(report.byteLength, (await stat(join(
        paths.segmentsPath,
        formatSessionSegmentFileName(1, 'sealed'),
      ))).size + (await stat(join(
        paths.segmentsPath,
        formatSessionSegmentFileName(2, 'active'),
      ))).size)
      assert.equal(report.diagnostics.some((value) => value.code === 'manifest_missing'), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate event IDs across a segment boundary without reporting payloads',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-segment-duplicate-'))
      const secret = 'sk-segment-doctor-secret'
      try {
        await createSegmentedFixture(root, 'segment-duplicate', [
          { ordinal: 1, state: 'sealed', bytes: event(1, secret) },
          { ordinal: 2, state: 'active', bytes: event(2, secret) },
        ])

        const report = await diagnoseSession('segment-duplicate', { directory: root })
        assert.equal(report.status, 'corrupt')
        assert.equal(report.diagnostics[0]?.code, 'duplicate_event_id')
        assert.doesNotMatch(JSON.stringify(report), new RegExp(secret))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

  it('treats a sealed EOF fragment as fatal and never truncates it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-sealed-eof-'))
    try {
      const fragment = Buffer.from('{"sealed":"fragment"}', 'utf8')
      const { paths } = await createSegmentedFixture(root, 'sealed-eof', [
        { ordinal: 1, state: 'sealed', bytes: Buffer.concat([event(1), fragment]) },
        { ordinal: 2, state: 'active', bytes: event(2) },
      ])
      const sealedPath = join(
        paths.segmentsPath,
        formatSessionSegmentFileName(1, 'sealed'),
      )
      const before = await readFile(sealedPath)

      const report = await diagnoseSession('sealed-eof', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'sealed_eof_fragment')
      assert.deepEqual(await readFile(sealedPath), before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports but never truncates the only active segment EOF fragment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-active-eof-'))
    try {
      const fragment = Buffer.from('{"active":"fragment"}', 'utf8')
      const { paths } = await createSegmentedFixture(root, 'active-eof', [
        { ordinal: 1, state: 'sealed', bytes: event(1) },
        { ordinal: 2, state: 'active', bytes: Buffer.concat([event(2), fragment]) },
      ])
      const activePath = join(
        paths.segmentsPath,
        formatSessionSegmentFileName(2, 'active'),
      )
      const before = await readFile(activePath)

      const report = await diagnoseSession('active-eof', { directory: root })
      assert.equal(report.status, 'recoverable')
      assert.equal(
        report.diagnostics.some((value) => value.code === 'trailing_eof_fragment'),
        true,
      )
      assert.equal(report.recordCount, 2)
      assert.deepEqual(await readFile(activePath), before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('excludes an active EOF fragment from immutable event quota accounting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-active-eof-quota-'))
    const complete = event(1)
    const fragment = Buffer.from('{x', 'utf8')
    try {
      await createSegmentedFixture(root, 'active-eof-quota', [
        { ordinal: 1, state: 'active', bytes: Buffer.concat([complete, fragment]) },
      ], {
        limits: {
          maxRecordBytes: 1024,
          maxReadRecordBytes: 4096,
          segmentTargetBytes: 4096,
          regularQuotaBytes: complete.length,
          criticalReserveBytes: 1,
        },
      })

      const report = await diagnoseSession('active-eof-quota', { directory: root })
      assert.equal(report.status, 'recoverable')
      assert.equal(
        report.diagnostics.some(({ code }) => code === 'trailing_eof_fragment'),
        true,
      )
      assert.equal(
        report.diagnostics.some(({ code }) => code === 'session_quota_exceeded'),
        false,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a crash window with sealed segments but no active segment as recoverable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-active-missing-'))
      try {
        await createSegmentedFixture(root, 'active-missing', [
          { ordinal: 1, state: 'sealed', bytes: event(1) },
        ])

        const report = await diagnoseSession('active-missing', { directory: root })
        assert.equal(report.status, 'recoverable')
        assert.equal(report.recordCount, 1)
        assert.equal(
          report.diagnostics.some((value) => value.code === 'active_segment_missing'),
          true,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

  it('enforces materialization identity globally across segment boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-materialization-'))
    const materializationId = 'materialization-secret-sentinel'
    const materialized = (sequence: number, eventId: string) => Buffer.from(
      `${JSON.stringify({
        schemaVersion: 2,
        eventId,
        sequence,
        type: 'test.event',
        timestamp: '2026-07-17T00:00:00.000Z',
        materializationId,
      })}\n`,
      'utf8',
    )
    try {
      await createSegmentedFixture(root, 'materialization', [
        { ordinal: 1, state: 'sealed', bytes: materialized(1, 'first') },
        { ordinal: 2, state: 'active', bytes: materialized(2, 'second') },
      ])

      const report = await diagnoseSession('materialization', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'duplicate_materialization_id')
      assert.doesNotMatch(JSON.stringify(report), new RegExp(materializationId))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects structurally valid Operation events with an impossible lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-operation-transition-'))
    try {
      await createSegmentedFixture(root, 'doctor-operation', [
        { ordinal: 1, state: 'active', bytes: operationEvent(1, 'operation-1', 'started') },
      ])

      const report = await diagnoseSession('doctor-operation', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'invalid_operation_projection')
      assert.doesNotMatch(JSON.stringify(report), /operation-1|attempt-1/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects rebuilt Operation obligations that exceed the immutable reserve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-operation-quota-'))
    try {
      await createSegmentedFixture(root, 'doctor-operation', [
        {
          ordinal: 1,
          state: 'active',
          bytes: Buffer.concat([
            operationEvent(1, 'operation-1', 'proposed'),
            operationEvent(2, 'operation-2', 'proposed'),
          ]),
        },
      ], {
        limits: {
          maxRecordBytes: 1024,
          maxReadRecordBytes: 4096,
          segmentTargetBytes: 4096,
          regularQuotaBytes: 1024 * 1024,
          criticalReserveBytes: 2048,
        },
      })

      const report = await diagnoseSession('doctor-operation', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'session_quota_exceeded')
      assert.doesNotMatch(JSON.stringify(report), /operation-1|operation-2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('enforces the schema upgrade payload boundary across segments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-segment-schema-'))
    const legacy = Buffer.from(`${JSON.stringify({
      type: 'message',
      timestamp: '2026-07-17T00:00:00.000Z',
      message: { role: 'user', content: 'legacy-secret-sentinel' },
    })}\n`, 'utf8')
    try {
      await createSegmentedFixture(root, 'segment-schema', [
        { ordinal: 1, state: 'sealed', bytes: legacy },
        { ordinal: 2, state: 'active', bytes: Buffer.from(`${JSON.stringify({
          schemaVersion: 2,
          eventId: 'missing-upgrade-marker',
          sequence: 1,
          type: 'test.event',
          timestamp: '2026-07-17T00:00:01.000Z',
        })}\n`, 'utf8') },
      ])

      const report = await diagnoseSession('segment-schema', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'invalid_record_payload')
      assert.doesNotMatch(JSON.stringify(report), /legacy-secret-sentinel/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports corrupt manifest bytes as a warning without rewriting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-manifest-corrupt-'))
    const manifestBytes = Buffer.from('{"secret":"manifest-secret" BROKEN}\n', 'utf8')
    try {
      const { paths } = await createSegmentedFixture(root, 'manifest-corrupt', [
        { ordinal: 1, state: 'active', bytes: event(1) },
      ], { manifestBytes })

      const report = await diagnoseSession('manifest-corrupt', { directory: root })
      assert.equal(report.status, 'recoverable')
      assert.equal(report.diagnostics.some((value) => value.code === 'manifest_corrupt'), true)
      assert.doesNotMatch(JSON.stringify(report), /manifest-secret/)
      assert.deepEqual(await readFile(paths.manifestPath), manifestBytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a matching rebuildable manifest and warns on a canonical stale cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-manifest-stale-'))
    const first = event(1)
    const second = event(2)
    try {
      const { format, paths } = await createSegmentedFixture(root, 'manifest-stale', [
        { ordinal: 1, state: 'sealed', bytes: first },
        { ordinal: 2, state: 'active', bytes: second },
      ])
      const entries = [
        Object.freeze({
          ordinal: 1,
          state: 'sealed' as const,
          fileName: formatSessionSegmentFileName(1, 'sealed'),
          path: join(paths.segmentsPath, formatSessionSegmentFileName(1, 'sealed')),
          byteLength: first.length,
          physicalByteLength: first.length,
          lineCount: 1,
        }),
        Object.freeze({
          ordinal: 2,
          state: 'active' as const,
          fileName: formatSessionSegmentFileName(2, 'active'),
          path: join(paths.segmentsPath, formatSessionSegmentFileName(2, 'active')),
          byteLength: second.length,
          physicalByteLength: second.length,
          lineCount: 1,
        }),
      ]
      const matching = encodeSessionManifest(format, {
        entries,
        totalEventBytes: first.length + second.length,
      })
      await writeFile(paths.manifestPath, matching, { mode: 0o600 })

      const healthy = await diagnoseSession('manifest-stale', { directory: root })
      assert.equal(healthy.status, 'healthy')
      assert.deepEqual(healthy.diagnostics, [])

      const stale = encodeSessionManifest(format, {
        entries: [entries[0]!],
        totalEventBytes: first.length,
      })
      await writeFile(paths.manifestPath, stale, { mode: 0o600 })
      const report = await diagnoseSession('manifest-stale', { directory: root })
      assert.equal(report.status, 'recoverable')
      assert.equal(report.diagnostics.some((value) => value.code === 'manifest_stale'), true)
      assert.deepEqual(await readFile(paths.manifestPath), stale)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects gaps and duplicate ordinal states in the segment catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-segment-gap-'))
    try {
      await createSegmentedFixture(root, 'segment-gap', [
        { ordinal: 1, state: 'sealed', bytes: event(1) },
        { ordinal: 3, state: 'active', bytes: event(2) },
      ])
      const gap = await diagnoseSession('segment-gap', { directory: root })
      assert.equal(gap.status, 'corrupt')
      assert.equal(gap.diagnostics[0]?.code, 'segment_catalog_invalid')

      const duplicateRoot = await mkdtemp(join(tmpdir(), 'super-agent-doctor-segment-duplicate-'))
      try {
        await createSegmentedFixture(duplicateRoot, 'segment-duplicate-state', [
          { ordinal: 1, state: 'sealed', bytes: event(1) },
          { ordinal: 1, state: 'active', bytes: event(2) },
        ])
        const duplicate = await diagnoseSession('segment-duplicate-state', {
          directory: duplicateRoot,
        })
        assert.equal(duplicate.status, 'corrupt')
        assert.equal(duplicate.diagnostics[0]?.code, 'segment_catalog_invalid')
      } finally {
        await rm(duplicateRoot, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when an exact fence points at an inconsistent immutable format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-format-mismatch-'))
    try {
      const { format, paths } = await createSegmentedFixture(root, 'format-mismatch', [
        { ordinal: 1, state: 'active', bytes: event(1) },
      ])
      await writeFile(paths.formatPath, deterministicSessionJsonBytes({
        ...format,
        sessionId: 'different-session',
      }), { mode: 0o600 })

      const report = await diagnoseSession('format-mismatch', { directory: root })
      assert.equal(report.status, 'corrupt')
      assert.equal(report.diagnostics[0]?.code, 'bundle_format_invalid')
      assert.equal(report.recordCount, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the real descriptor/stat/read/flock boundary in injected wrappers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-segment-io-'))
    const reads: Array<{ path: string, fd: number }> = []
    const fstats: number[] = []
    const flocks: Array<{ fd: number, operation: 'shnb' | 'un' }> = []
    try {
      await createSegmentedFixture(root, 'segment-io', [
        { ordinal: 1, state: 'active', bytes: event(1) },
      ])
      const io: SessionDoctorIo = {
        ...nodeSessionDoctorIo,
        fstat: (fd) => {
          fstats.push(fd)
          return nodeSessionDoctorIo.fstat(fd)
        },
        read: (path, fd) => {
          reads.push({ path, fd })
          return nodeSessionDoctorIo.read(path, fd)
        },
        flock: (fd, operation) => {
          flocks.push({ fd, operation })
          nodeSessionDoctorIo.flock(fd, operation)
        },
      }

      const report = await diagnoseSession('segment-io', { directory: root, io })
      assert.equal(report.status, 'recoverable')
      assert.ok(reads.length >= 3, 'fence, format, and segment must be descriptor-backed reads')
      assert.ok(reads.every(({ fd }) => Number.isInteger(fd) && fd >= 0))
      assert.ok(reads.every(({ fd }) => fstats.includes(fd)))
      assert.equal(flocks.filter(({ operation }) => operation === 'shnb').length, 2)
      assert.equal(flocks.filter(({ operation }) => operation === 'un').length, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns busy before reading a fence locked by a split-lock writer', {
    skip: process.platform === 'win32' ? 'POSIX flock contract is required' : false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-doctor-segment-busy-'))
    let fenceFd: number | undefined
    try {
      const { paths } = await createSegmentedFixture(root, 'segment-busy', [
        { ordinal: 1, state: 'active', bytes: event(1) },
      ])
      fenceFd = openSync(paths.legacyJournalPath, constants.O_RDWR)
      flockSync(fenceFd, 'exnb')
      let readCount = 0
      const io: SessionDoctorIo = {
        ...nodeSessionDoctorIo,
        read: (path, fd) => {
          readCount++
          return nodeSessionDoctorIo.read(path, fd)
        },
      }

      const report = await diagnoseSession('segment-busy', { directory: root, io })
      assert.equal(report.status, 'busy')
      assert.equal(report.diagnostics[0]?.code, 'writer_busy')
      assert.equal(readCount, 0)
    } finally {
      if (fenceFd !== undefined) {
        try {
          flockSync(fenceFd, 'un')
        } finally {
          closeSync(fenceFd)
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
