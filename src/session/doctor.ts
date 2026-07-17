import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  type Stats,
} from 'node:fs'
import { resolve } from 'node:path'
import { flockSync } from 'fs-ext'
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
  DEFAULT_MAX_SESSION_READ_RECORD_BYTES,
  validateSessionId,
} from './store.js'

const DEFAULT_SESSION_DIR = '.sessions'
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

export type SessionDoctorStatus = 'missing' | 'busy' | 'healthy' | 'recoverable' | 'corrupt'

export type SessionDoctorDiagnosticCode =
  | 'journal_missing'
  | 'lock_missing'
  | 'writer_busy'
  | 'unsafe_file_metadata'
  | 'lock_unavailable'
  | 'invalid_record_payload'
  | 'lock_release_failed'
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
  flock(fd: number, operation: SessionDoctorLockOperation): void
  close(fd: number): void
}

export const nodeSessionDoctorIo: SessionDoctorIo = Object.freeze({
  open: (path: string, flags: number) => openSync(path, flags),
  fstat: (fd: number) => fstatSync(fd),
  lstat: (path: string) => lstatSync(path),
  read: (path: string, fd: number) => createReadStream(path, { fd, autoClose: false }),
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
  journalSharedLock: boolean
  fixedSharedLock: boolean
}

class SessionRecordValidationError extends Error {
  constructor(readonly location: SessionJournalRecordLocation) {
    super('Session journal record payload validation failed')
    this.name = 'SessionRecordValidationError'
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

  const schemaTransition = createSessionSchemaTransitionState()
  const scanned = await scanSessionJournal(io.read(journalPath, resources.journalFd), {
    maxRecordBytes: maxReadRecordBytes,
    onRecord: (record, location) => {
      try {
        validateSessionRecord(record, location.line)
        validateSessionSchemaTransition(schemaTransition, record, location.line)
      } catch {
        throw new SessionRecordValidationError(location)
      }
    },
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
    journalSharedLock: false,
    fixedSharedLock: false,
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
        'invalid_record_payload',
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

  return cleanupFailed ? appendCleanupFailure(result!, sessionId, lockPath) : result!
}
