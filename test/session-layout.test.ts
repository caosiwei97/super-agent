import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COMPILED_MAX_SESSION_REGULAR_QUOTA_BYTES,
  DEFAULT_SESSION_CRITICAL_RESERVE_BYTES,
  DEFAULT_SESSION_MAX_READ_RECORD_BYTES,
  DEFAULT_SESSION_MAX_RECORD_BYTES,
  DEFAULT_SESSION_REGULAR_QUOTA_BYTES,
  DEFAULT_SESSION_SEGMENT_TARGET_BYTES,
  LEGACY_JSONL_SOURCE_KIND,
  SESSION_FORMAT_MAX_BYTES,
  SessionLayoutError,
  computeSessionGeneration,
  createSessionFormat,
  deterministicSessionJsonBytes,
  encodeSessionFence,
  formatSessionSegmentFileName,
  parseSessionFence,
  parseSessionFormatBytes,
  parseSessionSegmentFileName,
  resolveSessionBundlePaths,
} from '../src/session/session-layout.js'

const source = Object.freeze({
  kind: LEGACY_JSONL_SOURCE_KIND,
  byteLength: 5,
  sha256: '0'.repeat(64),
})

function errorCode(code: SessionLayoutError['code']) {
  return (error: unknown) => error instanceof SessionLayoutError && error.code === code
}

describe('session layout protocol', () => {
  it('derives the frozen generation formula and exact invalid-JSON fence', () => {
    const generation = computeSessionGeneration({ sessionId: 'alpha_1', source })
    assert.equal(generation, 'd4bd284637d8367cc2f644bdee2ea41c60b746193d41cdf62415df5d5e6223a8')

    const fence = encodeSessionFence(generation)
    assert.equal(
      fence.toString('ascii'),
      `SUPER_AGENT_SESSION_STORAGE_FENCE_V1 ${generation}\n`,
    )
    assert.equal(parseSessionFence(fence), generation)
    assert.throws(() => JSON.parse(fence.toString('utf8')))
  })

  it('rejects every fence byte variation including uppercase digest and extra bytes', () => {
    const generation = computeSessionGeneration({ sessionId: 'alpha_1', source })
    const exact = encodeSessionFence(generation)
    const variations = [
      exact.subarray(0, exact.length - 1),
      Buffer.concat([exact, Buffer.from('\n')]),
      Buffer.from(exact.toString('ascii').replace('V1 ', 'V2 ')),
      Buffer.from(exact.toString('ascii').replace(generation, generation.toUpperCase())),
      Buffer.from(exact.toString('ascii').replace('\n', '\r\n')),
    ]
    for (const bytes of variations) {
      assert.throws(() => parseSessionFence(bytes), errorCode('invalid_fence'))
    }
  })

  it('creates deterministic immutable format bytes with all frozen defaults', () => {
    const format = createSessionFormat({ sessionId: 'alpha_1', source })
    assert.deepEqual(format.limits, {
      maxRecordBytes: DEFAULT_SESSION_MAX_RECORD_BYTES,
      maxReadRecordBytes: DEFAULT_SESSION_MAX_READ_RECORD_BYTES,
      segmentTargetBytes: DEFAULT_SESSION_SEGMENT_TARGET_BYTES,
      regularQuotaBytes: DEFAULT_SESSION_REGULAR_QUOTA_BYTES,
      criticalReserveBytes: DEFAULT_SESSION_CRITICAL_RESERVE_BYTES,
    })
    const bytes = deterministicSessionJsonBytes(format)
    assert.equal(bytes.at(-1), 0x0a)
    assert.deepEqual(parseSessionFormatBytes(bytes, {
      sessionId: 'alpha_1',
      generation: format.generation,
      source,
      limits: { segmentTargetBytes: DEFAULT_SESSION_SEGMENT_TARGET_BYTES },
    }), format)
    assert.deepEqual(
      deterministicSessionJsonBytes({ z: 1, a: { y: 2, x: 3 } }),
      deterministicSessionJsonBytes({ a: { x: 3, y: 2 }, z: 1 }),
    )
  })

  it('fails closed on reopen conflicts, non-canonical bytes and generation tampering', () => {
    const format = createSessionFormat({ sessionId: 'alpha_1', source })
    const bytes = deterministicSessionJsonBytes(format)
    assert.throws(
      () => parseSessionFormatBytes(bytes, { limits: { maxRecordBytes: 123 } }),
      errorCode('format_conflict'),
    )
    assert.throws(
      () => parseSessionFormatBytes(Buffer.from(` ${bytes.toString('utf8')}`)),
      errorCode('non_deterministic_format'),
    )
    assert.throws(
      () => parseSessionFormatBytes(deterministicSessionJsonBytes({
        ...format,
        generation: 'f'.repeat(64),
      })),
      errorCode('invalid_generation'),
    )
    assert.throws(
      () => parseSessionFormatBytes(deterministicSessionJsonBytes({ ...format, extra: true })),
      errorCode('invalid_format'),
    )
  })

  it('enforces strict source kind, compiled caps and fixed metadata bounds', () => {
    assert.throws(
      () => createSessionFormat({
        sessionId: 'alpha_1',
        source: { ...source, kind: 'future-kind' } as never,
      }),
      errorCode('invalid_source'),
    )
    const format = createSessionFormat({ sessionId: 'alpha_1', source })
    assert.throws(
      () => parseSessionFormatBytes(deterministicSessionJsonBytes({
        ...format,
        limits: {
          ...format.limits,
          regularQuotaBytes: COMPILED_MAX_SESSION_REGULAR_QUOTA_BYTES + 1,
        },
      })),
      errorCode('invalid_limits'),
    )
    assert.throws(
      () => parseSessionFormatBytes(Buffer.alloc(SESSION_FORMAT_MAX_BYTES + 1)),
      errorCode('format_too_large'),
    )
  })

  it('resolves generation bundle paths without allowing path-like identities', () => {
    const format = createSessionFormat({ sessionId: 'alpha_1', source })
    const paths = resolveSessionBundlePaths('/tmp/session-layout-root', 'alpha_1', format.generation)
    assert.equal(paths.legacyJournalPath, '/tmp/session-layout-root/alpha_1.jsonl')
    assert.equal(paths.fixedLockPath, '/tmp/session-layout-root/alpha_1.lock')
    assert.equal(
      paths.generationPath,
      `/tmp/session-layout-root/alpha_1.session-v1/${format.generation}`,
    )
    assert.equal(paths.formatPath, `${paths.generationPath}/format.json`)
    assert.equal(paths.manifestPath, `${paths.generationPath}/manifest.json`)
    assert.equal(paths.segmentsPath, `${paths.generationPath}/segments`)
    assert.throws(
      () => resolveSessionBundlePaths('/tmp/session-layout-root', '../escape', format.generation),
      errorCode('invalid_session_id'),
    )
  })

  it('formats and strictly parses one-based twelve-digit segment names', () => {
    assert.equal(formatSessionSegmentFileName(1, 'active'), '000000000001.active.jsonl')
    assert.equal(formatSessionSegmentFileName(42, 'sealed'), '000000000042.sealed.jsonl')
    assert.deepEqual(parseSessionSegmentFileName('000000000042.sealed.jsonl'), {
      ordinal: 42,
      state: 'sealed',
      fileName: '000000000042.sealed.jsonl',
    })
    for (const invalid of [
      '000000000000.active.jsonl',
      '00000000001.active.jsonl',
      '000000000001.open.jsonl',
      '000000000001.active.jsonl.tmp',
      '1000000000000.sealed.jsonl',
    ]) {
      assert.equal(parseSessionSegmentFileName(invalid), undefined)
    }
    assert.throws(() => formatSessionSegmentFileName(0, 'active'))
  })

  it('rejects ambiguous values in deterministic metadata JSON', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const sparse = Array<string>(1)
    assert.throws(() => deterministicSessionJsonBytes(cyclic), errorCode('invalid_format'))
    assert.throws(() => deterministicSessionJsonBytes(sparse), errorCode('invalid_format'))
    assert.throws(() => deterministicSessionJsonBytes({ value: Number.NaN }),
      errorCode('invalid_format'))
  })
})
