import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  type Stats,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { flockSync } from 'fs-ext'
import {
  applyOperationEvent,
  parseOperationEvent,
} from '../execution/operation-ledger.js'
import type { OperationProjection } from '../execution/operation-types.js'
import {
  SessionJournalScanError,
  scanSessionJournal,
  type SessionJournalRecordLocation,
} from './journal-scanner.js'
import {
  createSessionSchemaTransitionState,
  validateSessionRecord,
  validateSessionSchemaTransition,
} from './session-records.js'
import {
  deterministicSessionJsonBytes,
  parseSessionFence,
  parseSessionFormatBytes,
  resolveSessionBundlePaths,
  SESSION_FORMAT_MAX_BYTES,
  SESSION_MANIFEST_MAX_BYTES,
  SESSION_STORAGE_FENCE_PREFIX,
  type SessionBundlePaths,
  type SessionFormatV1,
} from './session-layout.js'
import { rebuildSessionQuotaReservation } from './session-quota.js'
import {
  buildSessionSegmentCatalog,
  createSessionManifest,
  parseSessionManifest,
  type SessionSegmentCatalogEntry,
} from './session-segment-storage.js'
import {
  DEFAULT_MAX_SESSION_READ_RECORD_BYTES,
  validateSessionId,
} from './store.js'

const DEFAULT_SESSION_DIR = '.sessions'
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const FENCE_BYTE_LENGTH = Buffer.byteLength(SESSION_STORAGE_FENCE_PREFIX, 'ascii') + 64 + 1

export type SessionDoctorStatus = 'missing' | 'busy' | 'healthy' | 'recoverable' | 'corrupt'

export type SessionDoctorDiagnosticCode =
  | 'journal_missing'
  | 'lock_missing'
  | 'writer_busy'
  | 'unsafe_file_metadata'
  | 'lock_unavailable'
  | 'invalid_record_payload'
  | 'invalid_operation_projection'
  | 'session_quota_exceeded'
  | 'lock_release_failed'
  | 'bundle_format_invalid'
  | 'segment_catalog_invalid'
  | 'sealed_eof_fragment'
  | 'active_segment_missing'
  | 'manifest_missing'
  | 'manifest_corrupt'
  | 'manifest_stale'
  | SessionJournalScanError['code']
  | 'trailing_eof_fragment'

export interface SessionDoctorDiagnostic {
  code: SessionDoctorDiagnosticCode
  severity: 'info' | 'warning' | 'fatal'
  sessionId: string
  path: string
  line?: number
  byteOffset?: number
  byteLength?: number
  repaired: false
  message: string
}

export interface SessionDoctorReport {
  reportVersion: 1
  sessionId: string
  status: SessionDoctorStatus
  path: string
  byteLength: number
  recordCount: number
  v1RecordCount: number
  v2RecordCount: number
  nextSequence?: number
  diagnostics: readonly SessionDoctorDiagnostic[]
}

export type SessionDoctorLockOperation = 'shnb' | 'un'

/** Injectable read-only I/O boundary for deterministic lifecycle fault tests. */
export interface SessionDoctorIo {
  open(path: string, flags: number): number
  fstat(fd: number): Stats
  lstat(path: string): Stats
  read(path: string, fd: number): AsyncIterable<Uint8Array>
  readdir(path: string, fd: number): readonly string[]
  flock(fd: number, operation: SessionDoctorLockOperation): void
  close(fd: number): void
}

export const nodeSessionDoctorIo: SessionDoctorIo = Object.freeze({
  open: (path: string, flags: number) => openSync(path, flags),
  fstat: (fd: number) => fstatSync(fd),
  lstat: (path: string) => lstatSync(path),
  read: (path: string, fd: number) => createReadStream(path, {
    fd,
    autoClose: false,
    start: 0,
  }),
  readdir: (path: string, _fd: number) => readdirSync(path, { encoding: 'utf8' }),
  flock: (fd: number, operation: SessionDoctorLockOperation) => flockSync(fd, operation),
  close: (fd: number) => closeSync(fd),
})

export interface DiagnoseSessionOptions {
  directory?: string
  /** Compatibility alias: doctor has no write ceiling, so this controls its read ceiling. */
  maxRecordBytes?: number
  maxReadRecordBytes?: number
  io?: SessionDoctorIo
}

interface SessionDoctorResources {
  directoryFd?: number
  journalFd?: number
  lockFd?: number
  readonly additionalFds: Set<number>
  journalSharedLock: boolean
  fixedSharedLock: boolean
  cleanupFailed: boolean
}

class SessionRecordValidationError extends Error {
  constructor(
    readonly location: SessionJournalRecordLocation,
    readonly code: 'invalid_record_payload' | 'invalid_operation_projection' =
      'invalid_record_payload',
    message = 'Session journal record payload validation failed',
  ) {
    super(message)
    this.name = 'SessionRecordValidationError'
  }
}

type DoctorSegmentEntry = ReturnType<typeof buildSessionSegmentCatalog>[number]

interface DoctorSegmentRange {
  readonly path: string
  readonly byteOffset: number
  readonly lineOffset: number
  physicalByteLength: number
  eventByteLength: number
  lineCount: number
}

class SessionDoctorStorageError extends Error {
  constructor(
    readonly code: 'bundle_format_invalid' | 'segment_catalog_invalid' |
      'invalid_operation_projection' | 'session_quota_exceeded',
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'SessionDoctorStorageError'
  }
}

interface SessionDoctorProjectionState {
  readonly operations: Map<string, OperationProjection>
  readonly materializedOperationIds: Set<string>
}

function createDoctorProjectionState(): SessionDoctorProjectionState {
  return {
    operations: new Map<string, OperationProjection>(),
    materializedOperationIds: new Set<string>(),
  }
}

function validateDoctorRecord(
  record: Record<string, unknown>,
  location: SessionJournalRecordLocation,
  schemaTransition: ReturnType<typeof createSessionSchemaTransitionState>,
  projection: SessionDoctorProjectionState,
) {
  try {
    validateSessionRecord(record, location.line)
    validateSessionSchemaTransition(schemaTransition, record, location.line)
  } catch {
    throw new SessionRecordValidationError(location)
  }
  try {
    if (record.schemaVersion === 2 && record.type === 'operation') {
      const operation = parseOperationEvent(record)
      const next = applyOperationEvent(projection.operations.get(operation.operationId), operation)
      projection.operations.set(operation.operationId, next)
    }
  } catch {
    throw new SessionRecordValidationError(
      location,
      'invalid_operation_projection',
      'Session Operation projection contains an invalid lifecycle transition',
    )
  }
  if (typeof record.materializationId === 'string' &&
      typeof record.operationId === 'string') {
    projection.materializedOperationIds.add(record.operationId)
  }
}

function validateDoctorQuota(
  format: SessionFormatV1,
  eventBytes: number,
  projection: SessionDoctorProjectionState,
  diagnosticPath: string,
) {
  let reservedBytes: number
  try {
    reservedBytes = rebuildSessionQuotaReservation({
      operations: projection.operations.values(),
      materializedOperationIds: projection.materializedOperationIds,
      slotBytes: format.limits.maxRecordBytes,
    }).reservedBytes
  } catch {
    throw new SessionDoctorStorageError(
      'invalid_operation_projection',
      diagnosticPath,
      'Session materialization state is inconsistent with its Operation projection',
    )
  }
  const hardLimit = format.limits.regularQuotaBytes + format.limits.criticalReserveBytes
  if (reservedBytes > format.limits.criticalReserveBytes ||
      !Number.isSafeInteger(eventBytes + reservedBytes) ||
      eventBytes + reservedBytes > hardLimit) {
    throw new SessionDoctorStorageError(
      'session_quota_exceeded',
      diagnosticPath,
      'Session event bytes and Operation recovery obligations exceed the immutable quota',
    )
  }
}

class SealedSegmentEofError extends Error {
  constructor(
    readonly path: string,
    readonly location: SessionJournalRecordLocation,
  ) {
    super('Sealed session segment has an unterminated EOF record')
    this.name = 'SealedSegmentEofError'
  }
}

function report(
  sessionId: string,
  path: string,
  status: SessionDoctorStatus,
  value: SessionDoctorDiagnostic,
): SessionDoctorReport {
  return Object.freeze({
    reportVersion: 1,
    sessionId,
    status,
    path,
    byteLength: 0,
    recordCount: 0,
    v1RecordCount: 0,
    v2RecordCount: 0,
    diagnostics: Object.freeze([Object.freeze(value)]),
  })
}

function diagnostic(
  sessionId: string,
  path: string,
  code: SessionDoctorDiagnosticCode,
  severity: SessionDoctorDiagnostic['severity'],
  message: string,
  location?: SessionJournalRecordLocation,
): SessionDoctorDiagnostic {
  return {
    code,
    severity,
    sessionId,
    path,
    ...(location === undefined ? {} : {
      line: location.line,
      byteOffset: location.byteOffset,
      byteLength: location.byteLength,
    }),
    repaired: false,
    message,
  }
}

function isCurrentOwner(metadata: Stats) {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid()
}

function hasExactMode(metadata: Stats, mode: number) {
  return (metadata.mode & 0o777) === mode
}

function isPrivateRegularFile(metadata: Stats) {
  return metadata.isFile() && metadata.nlink === 1 &&
    hasExactMode(metadata, FILE_MODE) && isCurrentOwner(metadata)
}

function isPrivateDirectory(metadata: Stats) {
  return metadata.isDirectory() && hasExactMode(metadata, DIRECTORY_MODE) &&
    isCurrentOwner(metadata)
}

function sameIdentity(expected: Stats, actual: Stats) {
  return expected.dev === actual.dev && expected.ino === actual.ino
}

function errnoCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code
}

function pathIsConfirmedMissing(io: SessionDoctorIo, path: string) {
  try {
    io.lstat(path)
    return false
  } catch (error) {
    return errnoCode(error) === 'ENOENT'
  }
}

function pinnedDirectoryIsSafe(
  io: SessionDoctorIo,
  fd: number,
  path: string,
  identity: Stats,
) {
  try {
    const descriptorMetadata = io.fstat(fd)
    const pathMetadata = io.lstat(path)
    return sameIdentity(identity, descriptorMetadata) &&
      sameIdentity(identity, pathMetadata) &&
      isPrivateDirectory(descriptorMetadata) &&
      isPrivateDirectory(pathMetadata)
  } catch {
    return false
  }
}

function pinnedRegularFileIsSafe(
  io: SessionDoctorIo,
  fd: number,
  path: string,
  identity: Stats,
) {
  try {
    const descriptorMetadata = io.fstat(fd)
    const pathMetadata = io.lstat(path)
    return sameIdentity(identity, descriptorMetadata) &&
      sameIdentity(identity, pathMetadata) &&
      isPrivateRegularFile(descriptorMetadata) &&
      isPrivateRegularFile(pathMetadata)
  } catch {
    return false
  }
}

function trackAdditionalFd(resources: SessionDoctorResources, fd: number) {
  resources.additionalFds.add(fd)
  return fd
}

function closeAdditionalFd(
  io: SessionDoctorIo,
  resources: SessionDoctorResources,
  fd: number,
) {
  resources.additionalFds.delete(fd)
  try {
    io.close(fd)
  } catch {
    resources.cleanupFailed = true
  }
}

function openPinnedPrivateDirectory(
  io: SessionDoctorIo,
  resources: SessionDoctorResources,
  path: string,
) {
  let expected: Stats
  try {
    expected = io.lstat(path)
  } catch (error) {
    throw new SessionDoctorStorageError(
      'bundle_format_invalid',
      path,
      errnoCode(error) === 'ENOENT'
        ? 'Session bundle directory is missing'
        : 'Session bundle directory metadata is unavailable',
    )
  }
  if (!isPrivateDirectory(expected)) {
    throw new SessionDoctorStorageError(
      'bundle_format_invalid',
      path,
      'Session bundle directory metadata is unsafe',
    )
  }
  let fd: number
  try {
    fd = trackAdditionalFd(resources, io.open(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    ))
  } catch {
    throw new SessionDoctorStorageError(
      'bundle_format_invalid',
      path,
      'Session bundle directory could not be opened without following links',
    )
  }
  if (!pinnedDirectoryIsSafe(io, fd, path, expected)) {
    throw new SessionDoctorStorageError(
      'bundle_format_invalid',
      path,
      'Session bundle directory inode or metadata changed',
    )
  }
  return Object.freeze({ fd, identity: expected })
}

function openPinnedPrivateRegularFile(
  io: SessionDoctorIo,
  resources: SessionDoctorResources,
  path: string,
  code: SessionDoctorStorageError['code'],
) {
  let expected: Stats
  try {
    expected = io.lstat(path)
  } catch (error) {
    throw new SessionDoctorStorageError(
      code,
      path,
      errnoCode(error) === 'ENOENT'
        ? 'Session bundle file is missing'
        : 'Session bundle file metadata is unavailable',
    )
  }
  if (!isPrivateRegularFile(expected)) {
    throw new SessionDoctorStorageError(code, path, 'Session bundle file metadata is unsafe')
  }
  let fd: number
  try {
    fd = trackAdditionalFd(resources, io.open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    ))
  } catch {
    throw new SessionDoctorStorageError(
      code,
      path,
      'Session bundle file could not be opened without following links',
    )
  }
  if (!pinnedRegularFileIsSafe(io, fd, path, expected)) {
    throw new SessionDoctorStorageError(code, path, 'Session bundle file inode changed')
  }
  return Object.freeze({ fd, identity: expected })
}

async function readPinnedFileBytes(
  io: SessionDoctorIo,
  path: string,
  fd: number,
  identity: Stats,
  maximumBytes: number,
  code: SessionDoctorStorageError['code'],
) {
  if (!Number.isSafeInteger(identity.size) || identity.size < 0 ||
    identity.size > maximumBytes) {
    throw new SessionDoctorStorageError(code, path, 'Session bundle file exceeds its metadata bound')
  }
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const value of io.read(path, fd)) {
    if (!(value instanceof Uint8Array)) {
      throw new SessionDoctorStorageError(code, path, 'Session bundle read returned invalid bytes')
    }
    byteLength += value.byteLength
    if (!Number.isSafeInteger(byteLength) || byteLength > maximumBytes ||
      byteLength > identity.size) {
      throw new SessionDoctorStorageError(code, path, 'Session bundle file changed while reading')
    }
    chunks.push(Buffer.from(value))
  }
  let descriptor: Stats
  let pathname: Stats
  try {
    descriptor = io.fstat(fd)
    pathname = io.lstat(path)
  } catch {
    throw new SessionDoctorStorageError(code, path, 'Session bundle file changed while reading')
  }
  if (byteLength !== identity.size || descriptor.size !== identity.size ||
    pathname.size !== identity.size || !sameIdentity(identity, descriptor) ||
    !sameIdentity(identity, pathname) || !isPrivateRegularFile(descriptor) ||
    !isPrivateRegularFile(pathname)) {
    throw new SessionDoctorStorageError(code, path, 'Session bundle file changed while reading')
  }
  return Buffer.concat(chunks, byteLength)
}

async function* oneChunk(bytes: Uint8Array) {
  yield bytes
}

async function* readDoctorSegmentChunks(options: {
  readonly entries: readonly DoctorSegmentEntry[]
  readonly paths: SessionBundlePaths
  readonly io: SessionDoctorIo
  readonly resources: SessionDoctorResources
  readonly ranges: DoctorSegmentRange[]
  readonly maximumTotalBytes: number
}): AsyncGenerator<Uint8Array> {
  let globalByteOffset = 0
  let globalLineOffset = 0
  for (const entry of options.entries) {
    const segmentPath = join(options.paths.segmentsPath, entry.fileName)
    const pinned = openPinnedPrivateRegularFile(
      options.io,
      options.resources,
      segmentPath,
      'segment_catalog_invalid',
    )
    const range: DoctorSegmentRange = {
      path: segmentPath,
      byteOffset: globalByteOffset,
      lineOffset: globalLineOffset,
      physicalByteLength: 0,
      eventByteLength: 0,
      lineCount: 0,
    }
    options.ranges.push(range)
    let localByteLength = 0
    let lastNewlineOffset = -1
    let newlineCount = 0
    let lastByte: number | undefined
    try {
      if (!Number.isSafeInteger(pinned.identity.size) || pinned.identity.size < 0) {
        throw new SessionDoctorStorageError(
          'segment_catalog_invalid',
          segmentPath,
          'Session segment byte length is invalid',
        )
      }
      if (!Number.isSafeInteger(globalByteOffset + pinned.identity.size) ||
        globalByteOffset + pinned.identity.size > options.maximumTotalBytes) {
        throw new SessionDoctorStorageError(
          'segment_catalog_invalid',
          segmentPath,
          'Session segment bytes exceed the immutable total storage boundary',
        )
      }
      for await (const value of options.io.read(segmentPath, pinned.fd)) {
        if (!(value instanceof Uint8Array)) {
          throw new SessionDoctorStorageError(
            'segment_catalog_invalid',
            segmentPath,
            'Session segment read returned invalid bytes',
          )
        }
        if (!Number.isSafeInteger(localByteLength + value.byteLength) ||
          localByteLength + value.byteLength > pinned.identity.size) {
          throw new SessionDoctorStorageError(
            'segment_catalog_invalid',
            segmentPath,
            'Session segment changed while reading',
          )
        }
        const bytes = Buffer.from(value)
        let cursor = 0
        while (cursor < bytes.length) {
          const newline = bytes.indexOf(0x0a, cursor)
          if (newline === -1) break
          lastNewlineOffset = localByteLength + newline
          newlineCount++
          cursor = newline + 1
        }
        localByteLength += bytes.length
        globalByteOffset += bytes.length
        range.physicalByteLength = localByteLength
        if (bytes.length > 0) lastByte = bytes[bytes.length - 1]
        yield bytes
      }
      let descriptor: Stats
      let pathname: Stats
      try {
        descriptor = options.io.fstat(pinned.fd)
        pathname = options.io.lstat(segmentPath)
      } catch {
        throw new SessionDoctorStorageError(
          'segment_catalog_invalid',
          segmentPath,
          'Session segment metadata changed while reading',
        )
      }
      if (localByteLength !== pinned.identity.size || descriptor.size !== pinned.identity.size ||
        pathname.size !== pinned.identity.size || !sameIdentity(pinned.identity, descriptor) ||
        !sameIdentity(pinned.identity, pathname) || !isPrivateRegularFile(descriptor) ||
        !isPrivateRegularFile(pathname)) {
        throw new SessionDoctorStorageError(
          'segment_catalog_invalid',
          segmentPath,
          'Session segment inode or byte length changed while reading',
        )
      }
      range.eventByteLength = lastNewlineOffset + 1
      range.lineCount = newlineCount
      if (entry.state === 'sealed' && localByteLength > 0 && lastByte !== 0x0a) {
        const fragmentOffset = lastNewlineOffset + 1
        throw new SealedSegmentEofError(segmentPath, Object.freeze({
          line: newlineCount + 1,
          byteOffset: fragmentOffset,
          byteLength: localByteLength - fragmentOffset,
        }))
      }
      globalLineOffset += newlineCount
    } finally {
      closeAdditionalFd(options.io, options.resources, pinned.fd)
    }
  }
}

function localizeGlobalLocation(
  ranges: readonly DoctorSegmentRange[],
  location: SessionJournalRecordLocation | undefined,
  fallback: string,
) {
  if (!location) return Object.freeze({ path: fallback, location })
  const range = ranges.find((value) => location.byteOffset >= value.byteOffset &&
    location.byteOffset < value.byteOffset + value.physicalByteLength)
  if (!range) return Object.freeze({ path: fallback, location })
  return Object.freeze({
    path: range.path,
    location: Object.freeze({
      line: location.line - range.lineOffset,
      byteOffset: location.byteOffset - range.byteOffset,
      byteLength: location.byteLength,
    }),
  })
}

async function inspectManifest(
  sessionId: string,
  paths: SessionBundlePaths,
  format: SessionFormatV1,
  entries: readonly DoctorSegmentEntry[],
  ranges: readonly DoctorSegmentRange[],
  io: SessionDoctorIo,
  resources: SessionDoctorResources,
): Promise<SessionDoctorDiagnostic | undefined> {
  let metadata: Stats
  try {
    metadata = io.lstat(paths.manifestPath)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT' && pathIsConfirmedMissing(io, paths.manifestPath)) {
      return Object.freeze(diagnostic(
        sessionId,
        paths.manifestPath,
        'manifest_missing',
        'warning',
        'Rebuildable session manifest is missing; no rebuild was attempted',
      ))
    }
    return Object.freeze(diagnostic(
      sessionId,
      paths.manifestPath,
      'manifest_corrupt',
      'warning',
      'Rebuildable session manifest metadata is unavailable; no rebuild was attempted',
    ))
  }
  if (!isPrivateRegularFile(metadata) || !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 || metadata.size > SESSION_MANIFEST_MAX_BYTES) {
    return Object.freeze(diagnostic(
      sessionId,
      paths.manifestPath,
      'manifest_corrupt',
      'warning',
      'Rebuildable session manifest metadata is invalid; no rebuild was attempted',
    ))
  }

  let pinned: ReturnType<typeof openPinnedPrivateRegularFile> | undefined
  try {
    pinned = openPinnedPrivateRegularFile(
      io,
      resources,
      paths.manifestPath,
      'segment_catalog_invalid',
    )
    const bytes = await readPinnedFileBytes(
      io,
      paths.manifestPath,
      pinned.fd,
      pinned.identity,
      SESSION_MANIFEST_MAX_BYTES,
      'segment_catalog_invalid',
    )
    const parsed = parseSessionManifest(bytes)
    let totalEventBytes = 0
    const catalogEntries: SessionSegmentCatalogEntry[] = entries.map((entry, index) => {
      const range = ranges[index]
      if (!range) throw new Error('Session segment range is unavailable')
      totalEventBytes += range.eventByteLength
      if (!Number.isSafeInteger(totalEventBytes)) {
        throw new Error('Session event byte length exceeds Number.MAX_SAFE_INTEGER')
      }
      return Object.freeze({
        ...entry,
        path: range.path,
        byteLength: range.eventByteLength,
        physicalByteLength: range.physicalByteLength,
        lineCount: range.lineCount,
      })
    })
    const expected = createSessionManifest(format, Object.freeze({
      entries: Object.freeze(catalogEntries),
      totalEventBytes,
    }))
    if (parsed.generation !== expected.generation ||
      !Buffer.from(bytes).equals(deterministicSessionJsonBytes(expected))) {
      return Object.freeze(diagnostic(
        sessionId,
        paths.manifestPath,
        'manifest_stale',
        'warning',
        'Rebuildable session manifest is stale; no rebuild was attempted',
      ))
    }
    return undefined
  } catch {
    return Object.freeze(diagnostic(
      sessionId,
      paths.manifestPath,
      'manifest_corrupt',
      'warning',
      'Rebuildable session manifest is corrupt; no rebuild was attempted',
    ))
  } finally {
    if (pinned) closeAdditionalFd(io, resources, pinned.fd)
  }
}

async function inspectSegmentedSession(
  sessionId: string,
  generation: string,
  directory: string,
  journalPath: string,
  maxReadRecordBytes: number,
  io: SessionDoctorIo,
  resources: SessionDoctorResources,
): Promise<SessionDoctorReport> {
  const paths = resolveSessionBundlePaths(directory, sessionId, generation)
  const ranges: DoctorSegmentRange[] = []
  try {
    const bundleRoot = openPinnedPrivateDirectory(io, resources, paths.bundleRootPath)
    const generationDirectory = openPinnedPrivateDirectory(
      io,
      resources,
      paths.generationPath,
    )
    const segmentsDirectory = openPinnedPrivateDirectory(io, resources, paths.segmentsPath)
    const formatFile = openPinnedPrivateRegularFile(
      io,
      resources,
      paths.formatPath,
      'bundle_format_invalid',
    )
    const formatBytes = await readPinnedFileBytes(
      io,
      paths.formatPath,
      formatFile.fd,
      formatFile.identity,
      SESSION_FORMAT_MAX_BYTES,
      'bundle_format_invalid',
    )
    let format: SessionFormatV1
    try {
      format = parseSessionFormatBytes(formatBytes, { sessionId, generation })
    } catch {
      throw new SessionDoctorStorageError(
        'bundle_format_invalid',
        paths.formatPath,
        'Session bundle immutable format is invalid or inconsistent with its fence',
      )
    }

    const initialNames = [...io.readdir(paths.segmentsPath, segmentsDirectory.fd)].sort()
    if (!pinnedDirectoryIsSafe(
      io,
      segmentsDirectory.fd,
      paths.segmentsPath,
      segmentsDirectory.identity,
    )) {
      throw new SessionDoctorStorageError(
        'segment_catalog_invalid',
        paths.segmentsPath,
        'Session segments directory changed while reading its catalog',
      )
    }
    let entries: readonly DoctorSegmentEntry[]
    try {
      entries = buildSessionSegmentCatalog(initialNames)
    } catch {
      throw new SessionDoctorStorageError(
        'segment_catalog_invalid',
        paths.segmentsPath,
        'Session segment catalog is invalid',
      )
    }
    const schemaTransition = createSessionSchemaTransitionState()
    const projection = createDoctorProjectionState()
    const scanned = await scanSessionJournal(readDoctorSegmentChunks({
      entries,
      paths,
      io,
      resources,
      ranges,
      maximumTotalBytes: format.limits.regularQuotaBytes +
        format.limits.criticalReserveBytes + format.limits.maxReadRecordBytes,
    }), {
      maxRecordBytes: Math.min(maxReadRecordBytes, format.limits.maxReadRecordBytes),
      onRecord: (record, location) =>
        validateDoctorRecord(record, location, schemaTransition, projection),
    })
    // Active EOF fragments are diagnostic bytes, not complete quota events.
    validateDoctorQuota(format, scanned.validLength, projection, paths.segmentsPath)

    const finalNames = [...io.readdir(paths.segmentsPath, segmentsDirectory.fd)].sort()
    if (initialNames.length !== finalNames.length ||
      initialNames.some((name, index) => name !== finalNames[index]) ||
      !pinnedDirectoryIsSafe(
        io,
        bundleRoot.fd,
        paths.bundleRootPath,
        bundleRoot.identity,
      ) || !pinnedDirectoryIsSafe(
        io,
        generationDirectory.fd,
        paths.generationPath,
        generationDirectory.identity,
      ) || !pinnedDirectoryIsSafe(
        io,
        segmentsDirectory.fd,
        paths.segmentsPath,
        segmentsDirectory.identity,
      )) {
      throw new SessionDoctorStorageError(
        'segment_catalog_invalid',
        paths.segmentsPath,
        'Session bundle directory or segment catalog changed during diagnosis',
      )
    }
    const verifiedFormatBytes = await readPinnedFileBytes(
      io,
      paths.formatPath,
      formatFile.fd,
      formatFile.identity,
      SESSION_FORMAT_MAX_BYTES,
      'bundle_format_invalid',
    )
    if (!verifiedFormatBytes.equals(formatBytes)) {
      throw new SessionDoctorStorageError(
        'bundle_format_invalid',
        paths.formatPath,
        'Session bundle immutable format changed during diagnosis',
      )
    }

    const diagnostics: SessionDoctorDiagnostic[] = scanned.diagnostics.map((value) => {
      const localized = localizeGlobalLocation(ranges, value, paths.segmentsPath)
      return Object.freeze(diagnostic(
        sessionId,
        localized.path,
        value.code,
        'warning',
        'Active session segment has an unterminated EOF record; no repair was attempted',
        localized.location,
      ))
    })
    if (!entries.some((entry) => entry.state === 'active')) {
      diagnostics.push(Object.freeze(diagnostic(
        sessionId,
        paths.segmentsPath,
        'active_segment_missing',
        'warning',
        'Session bundle has no active segment; no recovery file was created',
      )))
    }
    const manifestValue = await inspectManifest(
      sessionId,
      paths,
      format,
      entries,
      ranges,
      io,
      resources,
    )
    if (manifestValue) diagnostics.push(manifestValue)
    return Object.freeze({
      reportVersion: 1,
      sessionId,
      status: diagnostics.length > 0 ? 'recoverable' : 'healthy',
      path: journalPath,
      byteLength: scanned.byteLength,
      recordCount: scanned.recordCount,
      v1RecordCount: scanned.v1RecordCount,
      v2RecordCount: scanned.v2RecordCount,
      nextSequence: scanned.nextSequence,
      diagnostics: Object.freeze(diagnostics),
    })
  } catch (error) {
    if (error instanceof SessionJournalScanError) {
      const localized = localizeGlobalLocation(ranges, error.location, paths.segmentsPath)
      return report(sessionId, journalPath, 'corrupt', diagnostic(
        sessionId,
        localized.path,
        error.code,
        'fatal',
        error.message,
        localized.location,
      ))
    }
    if (error instanceof SessionRecordValidationError) {
      const localized = localizeGlobalLocation(ranges, error.location, paths.segmentsPath)
      return report(sessionId, journalPath, 'corrupt', diagnostic(
        sessionId,
        localized.path,
        error.code,
        'fatal',
        error.message,
        localized.location,
      ))
    }
    if (error instanceof SealedSegmentEofError) {
      return report(sessionId, journalPath, 'corrupt', diagnostic(
        sessionId,
        error.path,
        'sealed_eof_fragment',
        'fatal',
        error.message,
        error.location,
      ))
    }
    if (error instanceof SessionDoctorStorageError) {
      return report(sessionId, journalPath, 'corrupt', diagnostic(
        sessionId,
        error.path,
        error.code,
        'fatal',
        error.message,
      ))
    }
    return report(sessionId, journalPath, 'corrupt', diagnostic(
      sessionId,
      paths.generationPath,
      'segment_catalog_invalid',
      'fatal',
      'Session bundle could not be diagnosed safely',
    ))
  }
}

function unsafeMetadataReport(
  sessionId: string,
  journalPath: string,
  diagnosticPath: string,
  message: string,
) {
  return report(sessionId, journalPath, 'corrupt', diagnostic(
    sessionId,
    diagnosticPath,
    'unsafe_file_metadata',
    'fatal',
    message,
  ))
}

function appendCleanupFailure(
  value: SessionDoctorReport,
  sessionId: string,
  lockPath: string,
) {
  return Object.freeze({
    ...value,
    status: 'corrupt' as const,
    diagnostics: Object.freeze([
      ...value.diagnostics,
      Object.freeze(diagnostic(
        sessionId,
        lockPath,
        'lock_release_failed',
        'fatal',
        'Session diagnosis could not release every pinned descriptor safely',
      )),
    ]),
  })
}

async function inspectSession(
  sessionId: string,
  directory: string,
  journalPath: string,
  lockPath: string,
  maxReadRecordBytes: number,
  io: SessionDoctorIo,
  resources: SessionDoctorResources,
): Promise<SessionDoctorReport> {
  const commonFlags = constants.O_NOFOLLOW ?? 0
  const fileReadFlags = constants.O_RDONLY | constants.O_NONBLOCK | commonFlags
  try {
    resources.directoryFd = io.open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | commonFlags,
    )
  } catch (error) {
    if (errnoCode(error) === 'ENOENT' && pathIsConfirmedMissing(io, directory)) {
      return report(sessionId, journalPath, 'missing', diagnostic(
        sessionId,
        journalPath,
        'journal_missing',
        'info',
        'Session journal does not exist',
      ))
    }
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      directory,
      'Session directory could not be opened without following links',
    )
  }

  let directoryIdentity: Stats
  try {
    directoryIdentity = io.fstat(resources.directoryFd)
  } catch {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      directory,
      'Session directory descriptor metadata is unavailable',
    )
  }
  if (!pinnedDirectoryIsSafe(io, resources.directoryFd, directory, directoryIdentity)) {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      directory,
      'Session directory metadata is unsafe or its inode was replaced',
    )
  }

  let journalInitiallyMissing = false
  try {
    io.lstat(journalPath)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT' && pathIsConfirmedMissing(io, journalPath)) {
      journalInitiallyMissing = true
    } else {
      return unsafeMetadataReport(
        sessionId,
        journalPath,
        journalPath,
        'Session journal path metadata could not be read safely',
      )
    }
  }
  if (journalInitiallyMissing && pathIsConfirmedMissing(io, lockPath)) {
    return report(sessionId, journalPath, 'missing', diagnostic(
      sessionId,
      journalPath,
      'journal_missing',
      'info',
      'Session journal does not exist',
    ))
  }

  try {
    resources.lockFd = io.open(lockPath, fileReadFlags)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT' && pathIsConfirmedMissing(io, lockPath)) {
      return report(sessionId, journalPath, 'corrupt', diagnostic(
        sessionId,
        lockPath,
        'lock_missing',
        'fatal',
        'Session lock inode is missing; diagnosis refused',
      ))
    }
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      lockPath,
      'Session lock could not be opened without following links',
    )
  }

  let lockIdentity: Stats
  try {
    lockIdentity = io.fstat(resources.lockFd)
  } catch {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      lockPath,
      'Session lock descriptor metadata is unavailable',
    )
  }
  if (!pinnedRegularFileIsSafe(io, resources.lockFd, lockPath, lockIdentity)) {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      lockPath,
      'Session lock metadata is unsafe or its fixed inode was replaced',
    )
  }

  try {
    io.flock(resources.lockFd, 'shnb')
    resources.fixedSharedLock = true
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'EAGAIN' || code === 'EACCES' || code === 'EWOULDBLOCK') {
      return report(sessionId, journalPath, 'busy', diagnostic(
        sessionId,
        lockPath,
        'writer_busy',
        'warning',
        'Session has an active writer; diagnosis did not read the journal',
      ))
    }
    return report(sessionId, journalPath, 'corrupt', diagnostic(
      sessionId,
      lockPath,
      'lock_unavailable',
      'fatal',
      'Session shared lock could not be acquired',
    ))
  }

  if (!pinnedRegularFileIsSafe(io, resources.lockFd, lockPath, lockIdentity)) {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      lockPath,
      'Session lock fixed inode changed while acquiring the shared lock',
    )
  }
  if (!pinnedDirectoryIsSafe(io, resources.directoryFd, directory, directoryIdentity)) {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      directory,
      'Session directory inode identity changed before journal diagnosis',
    )
  }

  let expectedJournalIdentity: Stats
  try {
    expectedJournalIdentity = io.lstat(journalPath)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT' && pathIsConfirmedMissing(io, journalPath)) {
      return report(sessionId, journalPath, 'missing', diagnostic(
        sessionId,
        journalPath,
        'journal_missing',
        'info',
        'Session journal does not exist',
      ))
    }
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      journalPath,
      'Session journal path metadata could not be read safely under the fixed lock',
    )
  }
  if (!isPrivateRegularFile(expectedJournalIdentity)) {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      journalPath,
      'Session journal path type, owner, mode, or link count is unsafe',
    )
  }

  try {
    resources.journalFd = io.open(journalPath, fileReadFlags)
  } catch {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      journalPath,
      'Session journal disappeared or could not be opened without following links',
    )
  }

  let journalIdentity: Stats
  try {
    journalIdentity = io.fstat(resources.journalFd)
  } catch {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      journalPath,
      'Session journal descriptor metadata is unavailable',
    )
  }
  if (!sameIdentity(expectedJournalIdentity, journalIdentity) ||
    !pinnedRegularFileIsSafe(io, resources.journalFd, journalPath, journalIdentity)) {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      journalPath,
      'Session journal metadata is unsafe or its inode was replaced',
    )
  }

  try {
    io.flock(resources.journalFd, 'shnb')
    resources.journalSharedLock = true
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'EAGAIN' || code === 'EACCES' || code === 'EWOULDBLOCK') {
      return report(sessionId, journalPath, 'busy', diagnostic(
        sessionId,
        journalPath,
        'writer_busy',
        'warning',
        'Session journal has an active writer; diagnosis did not scan any records',
      ))
    }
    return report(sessionId, journalPath, 'corrupt', diagnostic(
      sessionId,
      journalPath,
      'lock_unavailable',
      'fatal',
      'Session journal shared lock could not be acquired',
    ))
  }

  if (!pinnedRegularFileIsSafe(io, resources.lockFd, lockPath, lockIdentity) ||
    !pinnedDirectoryIsSafe(io, resources.directoryFd, directory, directoryIdentity) ||
    !pinnedRegularFileIsSafe(io, resources.journalFd, journalPath, journalIdentity)) {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      journalPath,
      'Session storage inode identity changed before journal diagnosis',
    )
  }

  let journalInput: AsyncIterable<Uint8Array> = io.read(journalPath, resources.journalFd)
  if (journalIdentity.size === FENCE_BYTE_LENGTH) {
    let possibleFence: Buffer
    try {
      possibleFence = await readPinnedFileBytes(
        io,
        journalPath,
        resources.journalFd,
        journalIdentity,
        FENCE_BYTE_LENGTH,
        'bundle_format_invalid',
      )
    } catch {
      return unsafeMetadataReport(
        sessionId,
        journalPath,
        journalPath,
        'Session journal bytes changed while detecting its storage format',
      )
    }
    let generation: string | undefined
    try {
      generation = parseSessionFence(possibleFence)
    } catch {
      // Only exact fence bytes are a migration commit point. Equal-sized legacy
      // data remains on the PR11A scanner path and fails or succeeds by JSONL rules.
    }
    if (generation !== undefined) {
      const segmented = await inspectSegmentedSession(
        sessionId,
        generation,
        directory,
        journalPath,
        maxReadRecordBytes,
        io,
        resources,
      )
      try {
        const verifiedFence = await readPinnedFileBytes(
          io,
          journalPath,
          resources.journalFd,
          journalIdentity,
          FENCE_BYTE_LENGTH,
          'bundle_format_invalid',
        )
        if (parseSessionFence(verifiedFence) !== generation ||
          !pinnedRegularFileIsSafe(io, resources.lockFd, lockPath, lockIdentity) ||
          !pinnedDirectoryIsSafe(io, resources.directoryFd, directory, directoryIdentity)) {
          throw new Error('storage fence changed')
        }
      } catch {
        return report(sessionId, journalPath, 'corrupt', diagnostic(
          sessionId,
          journalPath,
          'bundle_format_invalid',
          'fatal',
          'Session storage fence changed or became inconsistent during diagnosis',
        ))
      }
      return segmented
    }
    journalInput = oneChunk(possibleFence)
  }

  const schemaTransition = createSessionSchemaTransitionState()
  const projection = createDoctorProjectionState()
  const scanned = await scanSessionJournal(journalInput, {
    maxRecordBytes: maxReadRecordBytes,
    onRecord: (record, location) =>
      validateDoctorRecord(record, location, schemaTransition, projection),
  })

  if (!pinnedRegularFileIsSafe(io, resources.lockFd, lockPath, lockIdentity) ||
    !pinnedDirectoryIsSafe(io, resources.directoryFd, directory, directoryIdentity) ||
    !pinnedRegularFileIsSafe(io, resources.journalFd, journalPath, journalIdentity)) {
    return unsafeMetadataReport(
      sessionId,
      journalPath,
      journalPath,
      'Session storage inode identity changed during journal diagnosis',
    )
  }

  const diagnostics = scanned.diagnostics.map((value) => Object.freeze(diagnostic(
    sessionId,
    journalPath,
    value.code,
    'warning',
    'Session journal has an unterminated EOF record; no repair was attempted',
    value,
  )))
  return Object.freeze({
    reportVersion: 1,
    sessionId,
    status: diagnostics.length > 0 ? 'recoverable' : 'healthy',
    path: journalPath,
    byteLength: scanned.byteLength,
    recordCount: scanned.recordCount,
    v1RecordCount: scanned.v1RecordCount,
    v2RecordCount: scanned.v2RecordCount,
    nextSequence: scanned.nextSequence,
    diagnostics: Object.freeze(diagnostics),
  })
}

/** Read-only diagnosis. It never creates locks, changes modes, or repairs journal bytes. */
export async function diagnoseSession(
  sessionId: string,
  options: DiagnoseSessionOptions = {},
): Promise<SessionDoctorReport> {
  validateSessionId(sessionId)
  const directory = resolve(options.directory || DEFAULT_SESSION_DIR)
  const journalPath = resolve(directory, `${sessionId}.jsonl`)
  const lockPath = resolve(directory, `${sessionId}.lock`)
  const maxReadRecordBytes = options.maxReadRecordBytes ?? options.maxRecordBytes ??
    DEFAULT_MAX_SESSION_READ_RECORD_BYTES
  const io = options.io ?? nodeSessionDoctorIo
  const resources: SessionDoctorResources = {
    additionalFds: new Set<number>(),
    journalSharedLock: false,
    fixedSharedLock: false,
    cleanupFailed: false,
  }
  let result: SessionDoctorReport
  let cleanupFailed = false

  try {
    result = await inspectSession(
      sessionId,
      directory,
      journalPath,
      lockPath,
      maxReadRecordBytes,
      io,
      resources,
    )
  } catch (error) {
    if (error instanceof SessionJournalScanError) {
      result = report(sessionId, journalPath, 'corrupt', diagnostic(
        sessionId,
        journalPath,
        error.code,
        'fatal',
        error.message,
        error.location,
      ))
    } else if (error instanceof SessionRecordValidationError) {
      result = report(sessionId, journalPath, 'corrupt', diagnostic(
        sessionId,
        journalPath,
        error.code,
        'fatal',
        error.message,
        error.location,
      ))
    } else {
      result = report(sessionId, journalPath, 'corrupt', diagnostic(
        sessionId,
        lockPath,
        'lock_unavailable',
        'fatal',
        'Session diagnosis could not safely access storage',
      ))
    }
  } finally {
    for (const fd of [...resources.additionalFds].reverse()) {
      closeAdditionalFd(io, resources, fd)
    }
    if (resources.journalFd !== undefined) {
      if (resources.journalSharedLock) {
        try {
          io.flock(resources.journalFd, 'un')
        } catch {
          cleanupFailed = true
        }
      }
      try {
        io.close(resources.journalFd)
      } catch {
        cleanupFailed = true
      }
    }
    if (resources.lockFd !== undefined) {
      if (resources.fixedSharedLock) {
        try {
          io.flock(resources.lockFd, 'un')
        } catch {
          cleanupFailed = true
        }
      }
      try {
        io.close(resources.lockFd)
      } catch {
        cleanupFailed = true
      }
    }
    if (resources.directoryFd !== undefined) {
      try {
        io.close(resources.directoryFd)
      } catch {
        cleanupFailed = true
      }
    }
  }

  return cleanupFailed || resources.cleanupFailed
    ? appendCleanupFailure(result!, sessionId, lockPath)
    : result!
}
