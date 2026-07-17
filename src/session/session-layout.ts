import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export const SESSION_LAYOUT_VERSION = 1 as const
export const LEGACY_JSONL_SOURCE_KIND = 'legacy-jsonl' as const
export const SESSION_SEGMENT_ORDINAL_WIDTH = 12
export const MAX_SESSION_SEGMENT_ORDINAL = 999_999_999_999

export const DEFAULT_SESSION_MAX_RECORD_BYTES = 1 * 1024 * 1024
export const DEFAULT_SESSION_MAX_READ_RECORD_BYTES = 16 * 1024 * 1024
export const DEFAULT_SESSION_SEGMENT_TARGET_BYTES = 16 * 1024 * 1024
export const DEFAULT_SESSION_REGULAR_QUOTA_BYTES = 64 * 1024 * 1024
export const DEFAULT_SESSION_CRITICAL_RESERVE_BYTES = 16 * 1024 * 1024

/** Persisted contracts are bounded again by the running binary before use. */
export const COMPILED_MAX_SESSION_RECORD_BYTES = 16 * 1024 * 1024
export const COMPILED_MAX_SESSION_READ_RECORD_BYTES = 16 * 1024 * 1024
export const COMPILED_MAX_SESSION_SEGMENT_TARGET_BYTES = 1024 * 1024 * 1024
export const COMPILED_MAX_SESSION_REGULAR_QUOTA_BYTES = 1024 * 1024 * 1024 * 1024
export const COMPILED_MAX_SESSION_CRITICAL_RESERVE_BYTES = 1024 * 1024 * 1024

/** Metadata has a separate bound and never consumes event quota. */
export const SESSION_FORMAT_MAX_BYTES = 64 * 1024
export const SESSION_MANIFEST_MAX_BYTES = 1024 * 1024

export const SESSION_STORAGE_FENCE_PREFIX = 'SUPER_AGENT_SESSION_STORAGE_FENCE_V1 '

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SEGMENT_FILE_PATTERN = /^(\d{12})\.(active|sealed)\.jsonl$/

export type SessionLayoutErrorCode =
  | 'invalid_session_id'
  | 'invalid_source'
  | 'invalid_generation'
  | 'invalid_fence'
  | 'invalid_limits'
  | 'invalid_format'
  | 'format_too_large'
  | 'format_conflict'
  | 'non_deterministic_format'

export class SessionLayoutError extends Error {
  constructor(
    readonly code: SessionLayoutErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionLayoutError'
  }
}

export interface LegacyJsonlSourceFingerprint {
  readonly kind: typeof LEGACY_JSONL_SOURCE_KIND
  readonly byteLength: number
  readonly sha256: string
}

export type SessionSourceFingerprint = LegacyJsonlSourceFingerprint

export interface SessionStorageLimits {
  readonly maxRecordBytes: number
  readonly maxReadRecordBytes: number
  readonly segmentTargetBytes: number
  readonly regularQuotaBytes: number
  readonly criticalReserveBytes: number
}

export interface SessionFormatV1 {
  readonly layoutVersion: typeof SESSION_LAYOUT_VERSION
  readonly sessionId: string
  readonly generation: string
  readonly source: SessionSourceFingerprint
  readonly limits: SessionStorageLimits
}

export interface SessionBundlePaths {
  readonly directoryPath: string
  readonly legacyJournalPath: string
  readonly fixedLockPath: string
  readonly bundleRootPath: string
  readonly generationPath: string
  readonly formatPath: string
  readonly manifestPath: string
  readonly segmentsPath: string
}

export interface CreateSessionFormatOptions {
  readonly sessionId: string
  readonly source: SessionSourceFingerprint
  readonly limits?: Partial<SessionStorageLimits>
}

export interface SessionFormatReopenExpectation {
  readonly sessionId?: string
  readonly generation?: string
  readonly source?: SessionSourceFingerprint
  /** Only explicitly supplied values conflict with the immutable contract. */
  readonly limits?: Partial<SessionStorageLimits>
}

export type SessionSegmentState = 'active' | 'sealed'

export interface SessionSegmentFileName {
  readonly ordinal: number
  readonly state: SessionSegmentState
  readonly fileName: string
}

function layoutError(code: SessionLayoutErrorCode, message: string): never {
  throw new SessionLayoutError(code, message)
}

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId) ||
      sessionId === '.' || sessionId === '..') {
    layoutError('invalid_session_id', 'Session layout sessionId is invalid')
  }
}

function assertGeneration(generation: unknown): asserts generation is string {
  if (typeof generation !== 'string' || !SHA256_PATTERN.test(generation)) {
    layoutError('invalid_generation', 'Session layout generation must be lowercase SHA-256')
  }
}

function validateSource(source: unknown): SessionSourceFingerprint {
  if (!isRecord(source) || !hasExactKeys(source, ['byteLength', 'kind', 'sha256']) ||
      source.kind !== LEGACY_JSONL_SOURCE_KIND ||
      !Number.isSafeInteger(source.byteLength) || (source.byteLength as number) < 0 ||
      typeof source.sha256 !== 'string' || !SHA256_PATTERN.test(source.sha256)) {
    layoutError('invalid_source', 'Session layout source fingerprint is invalid')
  }
  return Object.freeze({
    kind: LEGACY_JSONL_SOURCE_KIND,
    byteLength: source.byteLength as number,
    sha256: source.sha256,
  })
}

function positiveSafeInteger(
  value: unknown,
  field: keyof SessionStorageLimits,
  compiledMaximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 ||
      (value as number) > compiledMaximum) {
    layoutError('invalid_limits', `Session layout ${field} is outside the compiled boundary`)
  }
  return value as number
}

export function validateSessionStorageLimits(limits: unknown): SessionStorageLimits {
  if (!isRecord(limits) || !hasExactKeys(limits, [
    'criticalReserveBytes',
    'maxReadRecordBytes',
    'maxRecordBytes',
    'regularQuotaBytes',
    'segmentTargetBytes',
  ])) {
    layoutError('invalid_limits', 'Session layout limits object is invalid')
  }
  const validated = Object.freeze({
    maxRecordBytes: positiveSafeInteger(
      limits.maxRecordBytes,
      'maxRecordBytes',
      COMPILED_MAX_SESSION_RECORD_BYTES,
    ),
    maxReadRecordBytes: positiveSafeInteger(
      limits.maxReadRecordBytes,
      'maxReadRecordBytes',
      COMPILED_MAX_SESSION_READ_RECORD_BYTES,
    ),
    segmentTargetBytes: positiveSafeInteger(
      limits.segmentTargetBytes,
      'segmentTargetBytes',
      COMPILED_MAX_SESSION_SEGMENT_TARGET_BYTES,
    ),
    regularQuotaBytes: positiveSafeInteger(
      limits.regularQuotaBytes,
      'regularQuotaBytes',
      COMPILED_MAX_SESSION_REGULAR_QUOTA_BYTES,
    ),
    criticalReserveBytes: positiveSafeInteger(
      limits.criticalReserveBytes,
      'criticalReserveBytes',
      COMPILED_MAX_SESSION_CRITICAL_RESERVE_BYTES,
    ),
  })
  if (validated.maxReadRecordBytes < validated.maxRecordBytes) {
    layoutError('invalid_limits', 'Session layout maxReadRecordBytes is below maxRecordBytes')
  }
  if (!Number.isSafeInteger(validated.regularQuotaBytes + validated.criticalReserveBytes)) {
    layoutError('invalid_limits', 'Session layout total quota exceeds Number.MAX_SAFE_INTEGER')
  }
  return validated
}

export function defaultSessionStorageLimits(
  overrides: Partial<SessionStorageLimits> = {},
): SessionStorageLimits {
  return validateSessionStorageLimits({
    maxRecordBytes: overrides.maxRecordBytes ?? DEFAULT_SESSION_MAX_RECORD_BYTES,
    maxReadRecordBytes: overrides.maxReadRecordBytes ?? DEFAULT_SESSION_MAX_READ_RECORD_BYTES,
    segmentTargetBytes: overrides.segmentTargetBytes ?? DEFAULT_SESSION_SEGMENT_TARGET_BYTES,
    regularQuotaBytes: overrides.regularQuotaBytes ?? DEFAULT_SESSION_REGULAR_QUOTA_BYTES,
    criticalReserveBytes: overrides.criticalReserveBytes ??
      DEFAULT_SESSION_CRITICAL_RESERVE_BYTES,
  })
}

export function computeSessionGeneration(input: {
  readonly sessionId: string
  readonly source: SessionSourceFingerprint
}): string {
  assertSessionId(input.sessionId)
  const source = validateSource(input.source)
  return createHash('sha256').update(
    `super-agent:session-layout-v1\0${input.sessionId}\0${source.kind}\0` +
      `${source.byteLength}\0${source.sha256}`,
    'utf8',
  ).digest('hex')
}

export function encodeSessionFence(generation: string): Buffer {
  assertGeneration(generation)
  return Buffer.from(`${SESSION_STORAGE_FENCE_PREFIX}${generation}\n`, 'ascii')
}

export function parseSessionFence(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    layoutError('invalid_fence', 'Session storage fence must be bytes')
  }
  const expectedLength = SESSION_STORAGE_FENCE_PREFIX.length + 64 + 1
  if (bytes.byteLength !== expectedLength) {
    layoutError('invalid_fence', 'Session storage fence has an invalid byte length')
  }
  let value: string
  try {
    value = new TextDecoder('ascii', { fatal: true }).decode(bytes)
  } catch {
    layoutError('invalid_fence', 'Session storage fence is not ASCII')
  }
  const match = /^SUPER_AGENT_SESSION_STORAGE_FENCE_V1 ([0-9a-f]{64})\n$/.exec(value)
  if (!match) layoutError('invalid_fence', 'Session storage fence bytes are not exact')
  return match[1]!
}

export function resolveSessionBundlePaths(
  directory: string,
  sessionId: string,
  generation: string,
): SessionBundlePaths {
  if (typeof directory !== 'string' || directory.length === 0) {
    layoutError('invalid_format', 'Session layout directory is invalid')
  }
  assertSessionId(sessionId)
  assertGeneration(generation)
  const directoryPath = resolve(directory)
  const bundleRootPath = resolve(directoryPath, `${sessionId}.session-v1`)
  const generationPath = resolve(bundleRootPath, generation)
  return Object.freeze({
    directoryPath,
    legacyJournalPath: resolve(directoryPath, `${sessionId}.jsonl`),
    fixedLockPath: resolve(directoryPath, `${sessionId}.lock`),
    bundleRootPath,
    generationPath,
    formatPath: resolve(generationPath, 'format.json'),
    manifestPath: resolve(generationPath, 'manifest.json'),
    segmentsPath: resolve(generationPath, 'segments'),
  })
}

export function createSessionFormat(options: CreateSessionFormatOptions): SessionFormatV1 {
  assertSessionId(options.sessionId)
  const source = validateSource(options.source)
  const limits = defaultSessionStorageLimits(options.limits)
  return Object.freeze({
    layoutVersion: SESSION_LAYOUT_VERSION,
    sessionId: options.sessionId,
    generation: computeSessionGeneration({ sessionId: options.sessionId, source }),
    source,
    limits,
  })
}

export function assertSessionFormatReopenCompatible(
  format: SessionFormatV1,
  expectation: SessionFormatReopenExpectation = {},
): void {
  if (expectation.sessionId !== undefined && expectation.sessionId !== format.sessionId) {
    layoutError('format_conflict', 'Session format sessionId conflicts with reopen options')
  }
  if (expectation.generation !== undefined) {
    assertGeneration(expectation.generation)
    if (expectation.generation !== format.generation) {
      layoutError('format_conflict', 'Session format generation conflicts with reopen options')
    }
  }
  if (expectation.source !== undefined) {
    const source = validateSource(expectation.source)
    if (source.kind !== format.source.kind || source.byteLength !== format.source.byteLength ||
        source.sha256 !== format.source.sha256) {
      layoutError('format_conflict', 'Session format source conflicts with reopen options')
    }
  }
  if (expectation.limits !== undefined) {
    for (const key of Object.keys(expectation.limits) as (keyof SessionStorageLimits)[]) {
      const value = expectation.limits[key]
      if (value !== undefined && value !== format.limits[key]) {
        layoutError('format_conflict', `Session format ${key} conflicts with reopen options`)
      }
    }
  }
}

export function parseSessionFormatBytes(
  bytes: Uint8Array,
  expectation: SessionFormatReopenExpectation = {},
): SessionFormatV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    layoutError('invalid_format', 'Session format must be non-empty bytes')
  }
  if (bytes.byteLength > SESSION_FORMAT_MAX_BYTES) {
    layoutError('format_too_large', 'Session format exceeds its fixed metadata boundary')
  }
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    layoutError('invalid_format', 'Session format is not valid UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    layoutError('invalid_format', 'Session format is not valid JSON')
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    'generation',
    'layoutVersion',
    'limits',
    'sessionId',
    'source',
  ]) || value.layoutVersion !== SESSION_LAYOUT_VERSION) {
    layoutError('invalid_format', 'Session format shape or layoutVersion is invalid')
  }
  assertSessionId(value.sessionId)
  assertGeneration(value.generation)
  const source = validateSource(value.source)
  const limits = validateSessionStorageLimits(value.limits)
  const format: SessionFormatV1 = Object.freeze({
    layoutVersion: SESSION_LAYOUT_VERSION,
    sessionId: value.sessionId,
    generation: value.generation,
    source,
    limits,
  })
  const derived = computeSessionGeneration({ sessionId: format.sessionId, source })
  if (derived !== format.generation) {
    layoutError('invalid_generation', 'Session format generation does not match its source')
  }
  if (!Buffer.from(bytes).equals(deterministicSessionJsonBytes(format))) {
    layoutError('non_deterministic_format', 'Session format bytes are not canonical')
  }
  assertSessionFormatReopenCompatible(format, expectation)
  return format
}

export function deterministicSessionJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value, new Set<object>())}\n`, 'utf8')
}

export function formatSessionSegmentFileName(
  ordinal: number,
  state: SessionSegmentState,
): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_SESSION_SEGMENT_ORDINAL) {
    layoutError('invalid_format', 'Session segment ordinal is invalid')
  }
  if (state !== 'active' && state !== 'sealed') {
    layoutError('invalid_format', 'Session segment state is invalid')
  }
  return `${String(ordinal).padStart(SESSION_SEGMENT_ORDINAL_WIDTH, '0')}.${state}.jsonl`
}

export function parseSessionSegmentFileName(fileName: string): SessionSegmentFileName | undefined {
  if (typeof fileName !== 'string') return undefined
  const match = SEGMENT_FILE_PATTERN.exec(fileName)
  if (!match) return undefined
  const ordinal = Number(match[1])
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_SESSION_SEGMENT_ORDINAL) {
    return undefined
  }
  const state = match[2] as SessionSegmentState
  return Object.freeze({ ordinal, state, fileName })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) layoutError('invalid_format', 'Canonical JSON rejects non-finite numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object') {
    layoutError('invalid_format', 'Canonical JSON rejects non-JSON values')
  }
  if (ancestors.has(value)) layoutError('invalid_format', 'Canonical JSON rejects cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        layoutError('invalid_format', 'Canonical JSON rejects sparse or decorated arrays')
      }
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      layoutError('invalid_format', 'Canonical JSON requires plain objects')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      layoutError('invalid_format', 'Canonical JSON rejects symbol properties')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(value).sort()
    const fields = keys.map((key) => {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor)) {
        layoutError('invalid_format', 'Canonical JSON rejects accessors')
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`
    })
    return `{${fields.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}
