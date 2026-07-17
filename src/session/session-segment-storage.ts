import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  type Stats,
} from 'node:fs'
import {
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  deterministicSessionJsonBytes,
  formatSessionSegmentFileName,
  parseSessionSegmentFileName,
  SESSION_MANIFEST_MAX_BYTES,
  type SessionBundlePaths,
  type SessionFormatV1,
  type SessionSegmentState,
} from './session-layout.js'
import {
  SessionRecordStreamError,
  streamSessionRecordBytes,
} from './session-record-stream.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const READ_CHUNK_BYTES = 64 * 1024

export type SessionSegmentStorageErrorCode =
  | 'unsafe_metadata'
  | 'invalid_catalog'
  | 'sealed_eof_fragment'
  | 'invalid_record'
  | 'record_too_large'
  | 'stale_append_plan'
  | 'storage_closed'
  | 'write_failed'
  | 'legacy_import_not_empty'

export class SessionSegmentStorageError extends Error {
  constructor(
    readonly code: SessionSegmentStorageErrorCode,
    message: string,
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionSegmentStorageError'
  }
}

export type SessionSegmentDiagnosticCode =
  | 'trailing_eof_fragment'
  | 'manifest_missing'
  | 'manifest_corrupt'
  | 'manifest_stale'
  | 'active_segment_missing'

export interface SessionSegmentDiagnostic {
  readonly code: SessionSegmentDiagnosticCode
  readonly path: string
  readonly repaired: boolean
  readonly byteOffset?: number
  readonly byteLength?: number
}

export interface SessionSegmentCatalogEntry {
  readonly ordinal: number
  readonly state: SessionSegmentState
  readonly fileName: string
  readonly path: string
  /** Complete JSONL bytes; an inspected active EOF fragment is excluded. */
  readonly byteLength: number
  readonly physicalByteLength: number
  /** Complete physical JSONL lines, including blank records. */
  readonly lineCount: number
}

export interface SessionSegmentRecordLocation {
  readonly path: string
  readonly line: number
  readonly byteOffset: number
  readonly byteLength: number
}

export interface SessionSegmentCatalog {
  readonly entries: readonly SessionSegmentCatalogEntry[]
  readonly active?: SessionSegmentCatalogEntry
  readonly totalEventBytes: number
  readonly diagnostics: readonly SessionSegmentDiagnostic[]
}

export interface SessionSegmentInspectionResult {
  readonly catalog: SessionSegmentCatalog
  readonly diagnostics: readonly SessionSegmentDiagnostic[]
}

export interface SessionManifestV1 {
  readonly layoutVersion: 1
  readonly generation: string
  readonly segments: readonly {
    readonly ordinal: number
    readonly state: SessionSegmentState
    readonly byteLength: number
  }[]
  readonly totalEventBytes: number
}

export interface SessionSegmentFile {
  readonly fd: number
  chmod(mode: number): Promise<void>
  stat(): Promise<Stats>
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ bytesWritten: number }>
  truncate(length?: number): Promise<void>
  datasync(): Promise<void>
  close(): Promise<void>
}

export interface SessionSegmentStorageIo {
  open(path: string, flags: number, mode?: number): Promise<SessionSegmentFile>
  mkdir(path: string, mode: number): Promise<void>
  readdir(path: string): Promise<readonly string[]>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

function fileHandle(handle: FileHandle): SessionSegmentFile {
  return handle
}

export const nodeSessionSegmentStorageIo: SessionSegmentStorageIo = Object.freeze({
  open: async (path: string, flags: number, mode?: number) =>
    fileHandle(await open(path, flags, mode)),
  mkdir: async (path: string, mode: number) => {
    await mkdir(path, { mode })
  },
  readdir: (path: string) => readdir(path),
  rename: (from: string, to: string) => rename(from, to),
  unlink: (path: string) => unlink(path),
})

export type SessionSegmentStoragePoint =
  | 'active_synced'
  | 'active_renamed'
  | 'sealed_directory_synced'
  | 'next_active_created'
  | 'next_active_synced'
  | 'manifest_published'

export type SessionSegmentStorageProbe = (
  point: SessionSegmentStoragePoint,
) => void | Promise<void>

export interface SessionSegmentStorageOptions {
  readonly paths: SessionBundlePaths
  readonly format: SessionFormatV1
  readonly io?: SessionSegmentStorageIo
  readonly probe?: SessionSegmentStorageProbe
  /** Manifest is a cache; publication failures are observable but never deny event facts. */
  readonly onManifestCacheWarning?: (message: string) => void
}

export interface SessionPreparedAppendBatch {
  readonly records: readonly Uint8Array[]
  readonly byteLength: number
}

export interface SessionAppendBatchOptions {
  readonly durability: 'buffered' | 'durable'
}

interface InternalAppendPlan extends SessionPreparedAppendBatch {
  readonly owner: symbol
  readonly version: number
}

interface ScannedSegment {
  readonly entry: SessionSegmentCatalogEntry
  readonly diagnostic?: SessionSegmentDiagnostic
}

interface PinnedSessionDirectory {
  readonly path: string
  readonly identity: Stats
  readonly handle: SessionSegmentFile
}

function storageError(
  code: SessionSegmentStorageErrorCode,
  message: string,
  path?: string,
  cause?: unknown,
): SessionSegmentStorageError {
  return new SessionSegmentStorageError(
    code,
    `[Session] segment storage failed closed: ${message}`,
    path,
    cause === undefined ? undefined : { cause },
  )
}

function sameIdentity(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino
}

function isCurrentOwner(metadata: Stats) {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid()
}

function assertPrivateDirectoryMetadata(metadata: Stats, path: string) {
  if (!metadata.isDirectory() || metadata.nlink < 1 || !isCurrentOwner(metadata) ||
      (metadata.mode & 0o777) !== DIRECTORY_MODE) {
    throw storageError('unsafe_metadata', 'session bundle directory metadata is unsafe', path)
  }
}

function assertPrivateDirectory(path: string) {
  try {
    assertPrivateDirectoryMetadata(lstatSync(path), path)
  } catch (error) {
    if (error instanceof SessionSegmentStorageError) throw error
    throw storageError('unsafe_metadata', 'session bundle directory is unavailable', path, error)
  }
}

function assertPrivateFile(metadata: Stats, path: string) {
  if (!metadata.isFile() || metadata.nlink !== 1 || !isCurrentOwner(metadata) ||
      (metadata.mode & 0o777) !== FILE_MODE) {
    throw storageError('unsafe_metadata', 'session segment file metadata is unsafe', path)
  }
}

function pathExists(path: string) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function assertManifestCachePathSafe(paths: SessionBundlePaths) {
  assertPrivateDirectory(paths.generationPath)
  if (pathExists(paths.manifestPath)) {
    assertPrivateFile(lstatSync(paths.manifestPath), paths.manifestPath)
  }
}

function syncDirectory(path: string) {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const descriptor = fstatSync(fd)
    const pathname = lstatSync(path)
    if (!sameIdentity(descriptor, pathname) || !descriptor.isDirectory() ||
        descriptor.nlink < 1 || !isCurrentOwner(descriptor) ||
        (descriptor.mode & 0o777) !== DIRECTORY_MODE) {
      throw storageError('unsafe_metadata', 'directory changed before fsync', path)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function openPinnedFile(
  io: SessionSegmentStorageIo,
  path: string,
  flags: number,
) {
  const expected = lstatSync(path)
  assertPrivateFile(expected, path)
  const handle = await io.open(path, flags | (constants.O_NOFOLLOW ?? 0), FILE_MODE)
  try {
    const descriptor = await handle.stat()
    const pathname = lstatSync(path)
    if (!sameIdentity(expected, descriptor) || !sameIdentity(descriptor, pathname)) {
      throw storageError('unsafe_metadata', 'segment descriptor/path identity mismatch', path)
    }
    assertPrivateFile(descriptor, path)
    assertPrivateFile(pathname, path)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function openPinnedDirectory(
  io: SessionSegmentStorageIo,
  path: string,
): Promise<PinnedSessionDirectory> {
  const expected = lstatSync(path)
  assertPrivateDirectoryMetadata(expected, path)
  const handle = await io.open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const descriptor = await handle.stat()
    const pathname = lstatSync(path)
    if (!sameIdentity(expected, descriptor) || !sameIdentity(descriptor, pathname)) {
      throw storageError('unsafe_metadata', 'directory descriptor/path identity mismatch', path)
    }
    assertPrivateDirectoryMetadata(descriptor, path)
    assertPrivateDirectoryMetadata(pathname, path)
    return Object.freeze({ path, identity: descriptor, handle })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function assertPinnedDirectory(pinned: PinnedSessionDirectory) {
  const descriptor = await pinned.handle.stat()
  let pathname: Stats
  try {
    pathname = lstatSync(pinned.path)
  } catch (error) {
    throw storageError('unsafe_metadata', 'pinned directory path is unavailable', pinned.path, error)
  }
  if (!sameIdentity(pinned.identity, descriptor) || !sameIdentity(descriptor, pathname)) {
    throw storageError('unsafe_metadata', 'pinned directory identity changed', pinned.path)
  }
  assertPrivateDirectoryMetadata(descriptor, pinned.path)
  assertPrivateDirectoryMetadata(pathname, pinned.path)
}

async function assertHandlePath(handle: SessionSegmentFile, path: string) {
  const descriptor = await handle.stat()
  const pathname = lstatSync(path)
  if (!sameIdentity(descriptor, pathname)) {
    throw storageError('unsafe_metadata', 'active segment inode changed', path)
  }
  assertPrivateFile(descriptor, path)
  assertPrivateFile(pathname, path)
  return descriptor
}

async function* handleChunks(
  handle: SessionSegmentFile,
  maximumLength = Number.MAX_SAFE_INTEGER,
): AsyncIterable<Uint8Array> {
  let position = 0
  while (position < maximumLength) {
    const length = Math.min(READ_CHUNK_BYTES, maximumLength - position)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead === 0) return
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
      throw storageError('unsafe_metadata', 'segment descriptor returned an invalid read length')
    }
    position += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

async function writeAll(handle: SessionSegmentFile, bytes: Uint8Array) {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 ||
        bytesWritten > bytes.length - offset) {
      throw storageError('write_failed', 'segment write made no valid progress')
    }
    offset += bytesWritten
  }
}

function checkedAdd(left: number, right: number) {
  const total = left + right
  if (!Number.isSafeInteger(total)) {
    throw storageError('invalid_catalog', 'segment byte count exceeds Number.MAX_SAFE_INTEGER')
  }
  return total
}

export function buildSessionSegmentCatalog(
  fileNames: readonly string[],
): readonly { ordinal: number; state: SessionSegmentState; fileName: string }[] {
  const parsed = fileNames.map((fileName) => {
    const entry = parseSessionSegmentFileName(fileName)
    if (!entry) throw storageError('invalid_catalog', `invalid segment entry: ${fileName}`)
    return entry
  }).sort((left, right) => left.ordinal - right.ordinal ||
    left.state.localeCompare(right.state))
  let activeCount = 0
  for (let index = 0; index < parsed.length; index++) {
    const entry = parsed[index]!
    if (entry.ordinal !== index + 1) {
      throw storageError('invalid_catalog', 'segment ordinals must be continuous from one')
    }
    if (entry.state === 'active') activeCount++
    if (entry.state === 'active' && index !== parsed.length - 1) {
      throw storageError('invalid_catalog', 'only the maximum ordinal may be active')
    }
  }
  if (activeCount > 1) {
    throw storageError('invalid_catalog', 'only one active segment is allowed')
  }
  return Object.freeze(parsed.map((entry) => Object.freeze({ ...entry })))
}

export function createSessionManifest(
  format: SessionFormatV1,
  catalog: Pick<SessionSegmentCatalog, 'entries' | 'totalEventBytes'>,
): SessionManifestV1 {
  return Object.freeze({
    layoutVersion: 1 as const,
    generation: format.generation,
    segments: Object.freeze(catalog.entries.map((entry) => Object.freeze({
      ordinal: entry.ordinal,
      state: entry.state,
      byteLength: entry.byteLength,
    }))),
    totalEventBytes: catalog.totalEventBytes,
  })
}

export function encodeSessionManifest(
  format: SessionFormatV1,
  catalog: Pick<SessionSegmentCatalog, 'entries' | 'totalEventBytes'>,
) {
  const bytes = deterministicSessionJsonBytes(createSessionManifest(format, catalog))
  if (bytes.length > SESSION_MANIFEST_MAX_BYTES) {
    throw storageError('invalid_catalog', 'session manifest exceeds metadata boundary')
  }
  return bytes
}

export function parseSessionManifest(bytes: Uint8Array): SessionManifestV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 ||
      bytes.length > SESSION_MANIFEST_MAX_BYTES) {
    throw storageError('invalid_catalog', 'session manifest bytes are invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw storageError('invalid_catalog', 'session manifest is not valid JSON', undefined, error)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw storageError('invalid_catalog', 'session manifest must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.layoutVersion !== 1 || typeof record.generation !== 'string' ||
      !Array.isArray(record.segments) || !Number.isSafeInteger(record.totalEventBytes) ||
      (record.totalEventBytes as number) < 0) {
    throw storageError('invalid_catalog', 'session manifest shape is invalid')
  }
  const entries = record.segments.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw storageError('invalid_catalog', 'session manifest segment is invalid')
    }
    const item = entry as Record<string, unknown>
    if (!Number.isSafeInteger(item.ordinal) || (item.ordinal as number) < 1 ||
        (item.state !== 'active' && item.state !== 'sealed') ||
        !Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0) {
      throw storageError('invalid_catalog', 'session manifest segment fields are invalid')
    }
    return Object.freeze({
      ordinal: item.ordinal as number,
      state: item.state,
      byteLength: item.byteLength as number,
    })
  })
  const manifest = Object.freeze({
    layoutVersion: 1 as const,
    generation: record.generation,
    segments: Object.freeze(entries),
    totalEventBytes: record.totalEventBytes as number,
  })
  if (!Buffer.from(bytes).equals(deterministicSessionJsonBytes(manifest))) {
    throw storageError('invalid_catalog', 'session manifest is not canonical')
  }
  return manifest
}

async function scanSegment(
  io: SessionSegmentStorageIo,
  paths: SessionBundlePaths,
  format: SessionFormatV1,
  named: { ordinal: number; state: SessionSegmentState; fileName: string },
  repairActive: boolean,
): Promise<ScannedSegment> {
  const path = join(paths.segmentsPath, named.fileName)
  const flags = named.state === 'active' && repairActive
    ? constants.O_RDWR
    : constants.O_RDONLY
  const handle = await openPinnedFile(io, path, flags)
  try {
    const before = await assertHandlePath(handle, path)
    let validLength = 0
    let lineCount = 0
    let fragment: { byteOffset: number; byteLength: number } | undefined
    try {
      for await (const item of streamSessionRecordBytes(handleChunks(handle), {
        maxRecordBytes: format.limits.maxReadRecordBytes,
      })) {
        if (item.kind === 'record') {
          validLength = item.byteOffset + item.byteLength
          lineCount++
        } else fragment = Object.freeze({
          byteOffset: item.byteOffset,
          byteLength: item.byteLength,
        })
      }
    } catch (error) {
      if (error instanceof SessionRecordStreamError && error.code === 'record_too_large') {
        throw storageError('record_too_large', 'segment record exceeds read boundary', path, error)
      }
      throw error
    }

    if (fragment && named.state === 'sealed') {
      throw storageError(
        'sealed_eof_fragment',
        'sealed segment contains an EOF fragment',
        path,
      )
    }
    let physicalByteLength = before.size
    let diagnostic: SessionSegmentDiagnostic | undefined
    if (fragment) {
      diagnostic = Object.freeze({
        code: 'trailing_eof_fragment' as const,
        path,
        repaired: repairActive,
        byteOffset: fragment.byteOffset,
        byteLength: fragment.byteLength,
      })
      if (repairActive) {
        await assertHandlePath(handle, path)
        await handle.truncate(fragment.byteOffset)
        await handle.datasync()
        await assertHandlePath(handle, path)
        physicalByteLength = fragment.byteOffset
      }
    }
    const after = await assertHandlePath(handle, path)
    if (after.size !== physicalByteLength || validLength > physicalByteLength) {
      throw storageError('unsafe_metadata', 'segment size changed while scanning', path)
    }
    return Object.freeze({
      entry: Object.freeze({
        ...named,
        path,
        byteLength: validLength,
        physicalByteLength,
        lineCount,
      }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    })
  } finally {
    await handle.close()
  }
}

async function readMetadataFile(
  io: SessionSegmentStorageIo,
  path: string,
  maximumBytes: number,
) {
  const handle = await openPinnedFile(io, path, constants.O_RDONLY)
  try {
    const metadata = await assertHandlePath(handle, path)
    if (metadata.size <= 0 || metadata.size > maximumBytes ||
        !Number.isSafeInteger(metadata.size)) {
      throw storageError('invalid_catalog', 'metadata size is outside its boundary', path)
    }
    const parts: Buffer[] = []
    let length = 0
    for await (const chunk of handleChunks(handle, metadata.size)) {
      parts.push(Buffer.from(chunk))
      length += chunk.length
    }
    if (length !== metadata.size) {
      throw storageError('unsafe_metadata', 'metadata read was incomplete', path)
    }
    await assertHandlePath(handle, path)
    return Buffer.concat(parts, length)
  } finally {
    await handle.close()
  }
}

async function manifestDiagnostic(
  io: SessionSegmentStorageIo,
  paths: SessionBundlePaths,
  format: SessionFormatV1,
  catalog: SessionSegmentCatalog,
): Promise<SessionSegmentDiagnostic | undefined> {
  if (!pathExists(paths.manifestPath)) {
    return Object.freeze({
      code: 'manifest_missing' as const,
      path: paths.manifestPath,
      repaired: false,
    })
  }
  let bytes: Buffer
  try {
    bytes = await readMetadataFile(io, paths.manifestPath, SESSION_MANIFEST_MAX_BYTES)
  } catch (error) {
    if (error instanceof SessionSegmentStorageError && error.code === 'unsafe_metadata') {
      throw error
    }
    return Object.freeze({
      code: 'manifest_corrupt' as const,
      path: paths.manifestPath,
      repaired: false,
    })
  }
  try {
    const parsed = parseSessionManifest(bytes)
    const expected = createSessionManifest(format, catalog)
    if (parsed.generation === expected.generation &&
        Buffer.from(bytes).equals(deterministicSessionJsonBytes(expected))) {
      return undefined
    }
  } catch {
    return Object.freeze({
      code: 'manifest_corrupt' as const,
      path: paths.manifestPath,
      repaired: false,
    })
  }
  return Object.freeze({
    code: 'manifest_stale' as const,
    path: paths.manifestPath,
    repaired: false,
  })
}

async function inspectInternal(
  options: SessionSegmentStorageOptions,
  repairActive: boolean,
): Promise<SessionSegmentInspectionResult> {
  const io = options.io ?? nodeSessionSegmentStorageIo
  const { paths, format } = options
  assertPrivateDirectory(paths.generationPath)
  assertPrivateDirectory(paths.segmentsPath)
  const named = buildSessionSegmentCatalog(await io.readdir(paths.segmentsPath))
  const scanned: ScannedSegment[] = []
  for (const entry of named) {
    scanned.push(await scanSegment(io, paths, format, entry, repairActive))
  }
  const entries = Object.freeze(scanned.map(({ entry }) => entry))
  let totalEventBytes = 0
  for (const entry of entries) totalEventBytes = checkedAdd(totalEventBytes, entry.byteLength)
  const diagnostics: SessionSegmentDiagnostic[] = scanned.flatMap(({ diagnostic }) =>
    diagnostic === undefined ? [] : [diagnostic])
  const active = entries.find((entry) => entry.state === 'active')
  if (!active) {
    diagnostics.push(Object.freeze({
      code: 'active_segment_missing' as const,
      path: paths.segmentsPath,
      repaired: false,
    }))
  }
  const preliminary: SessionSegmentCatalog = Object.freeze({
    entries,
    ...(active === undefined ? {} : { active }),
    totalEventBytes,
    diagnostics: Object.freeze([...diagnostics]),
  })
  const manifest = await manifestDiagnostic(io, paths, format, preliminary)
  if (manifest) diagnostics.push(manifest)
  const frozenDiagnostics = Object.freeze([...diagnostics])
  const catalog: SessionSegmentCatalog = Object.freeze({
    ...preliminary,
    diagnostics: frozenDiagnostics,
  })
  return Object.freeze({ catalog, diagnostics: frozenDiagnostics })
}

export async function inspectSessionSegmentStorage(
  options: SessionSegmentStorageOptions,
): Promise<SessionSegmentInspectionResult> {
  return inspectInternal(options, false)
}

async function* readFilePrefix(
  io: SessionSegmentStorageIo,
  entry: SessionSegmentCatalogEntry,
) {
  const handle = await openPinnedFile(io, entry.path, constants.O_RDONLY)
  let initial: Stats | undefined
  try {
    const metadata = await assertHandlePath(handle, entry.path)
    initial = metadata
    if (metadata.size !== entry.physicalByteLength || metadata.size < entry.byteLength) {
      throw storageError('unsafe_metadata', 'segment changed after catalog inspection', entry.path)
    }
    let length = 0
    for await (const chunk of handleChunks(handle, entry.byteLength)) {
      length += chunk.length
      yield chunk
    }
    if (length !== entry.byteLength) {
      throw storageError('unsafe_metadata', 'segment prefix read was incomplete', entry.path)
    }
  } finally {
    try {
      if (initial) {
        const after = await assertHandlePath(handle, entry.path)
        if (after.size !== initial.size) {
          throw storageError('unsafe_metadata', 'segment size changed while reading', entry.path)
        }
      }
    } finally {
      await handle.close()
    }
  }
}

export async function* readSessionSegmentChunks(
  options: SessionSegmentStorageOptions,
): AsyncIterable<Uint8Array> {
  const io = options.io ?? nodeSessionSegmentStorageIo
  const inspected = await inspectSessionSegmentStorage(options)
  for (const entry of inspected.catalog.entries) {
    for await (const chunk of readFilePrefix(io, entry)) yield chunk
  }
}

async function createPrivateFile(
  io: SessionSegmentStorageIo,
  path: string,
  flags = constants.O_APPEND | constants.O_RDWR,
) {
  const handle = await io.open(
    path,
    flags | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  )
  try {
    await handle.chmod(FILE_MODE)
    const descriptor = await handle.stat()
    const pathname = lstatSync(path)
    if (!sameIdentity(descriptor, pathname)) {
      throw storageError('unsafe_metadata', 'new segment descriptor/path mismatch', path)
    }
    assertPrivateFile(descriptor, path)
    assertPrivateFile(pathname, path)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function ensureSegmentsDirectory(
  io: SessionSegmentStorageIo,
  paths: SessionBundlePaths,
) {
  if (!pathExists(paths.segmentsPath)) {
    await io.mkdir(paths.segmentsPath, DIRECTORY_MODE)
    assertPrivateDirectory(paths.segmentsPath)
    syncDirectory(paths.generationPath)
  } else {
    assertPrivateDirectory(paths.segmentsPath)
  }
}

async function writeManifest(
  io: SessionSegmentStorageIo,
  paths: SessionBundlePaths,
  format: SessionFormatV1,
  catalog: SessionSegmentCatalog,
  probe: SessionSegmentStorageProbe,
) {
  const bytes = encodeSessionManifest(format, catalog)
  const tempPath = resolve(
    paths.generationPath,
    `.manifest.${process.pid}.${randomUUID()}.tmp`,
  )
  let renamed = false
  try {
    const handle = await createPrivateFile(io, tempPath, constants.O_RDWR)
    try {
      await writeAll(handle, bytes)
      await handle.datasync()
      const metadata = await assertHandlePath(handle, tempPath)
      if (metadata.size !== bytes.length) {
        throw storageError('unsafe_metadata', 'manifest temp size mismatch', tempPath)
      }
    } finally {
      await handle.close()
    }
    if (pathExists(paths.manifestPath)) {
      const current = lstatSync(paths.manifestPath)
      assertPrivateFile(current, paths.manifestPath)
    }
    await io.rename(tempPath, paths.manifestPath)
    renamed = true
    syncDirectory(paths.generationPath)
    await probe('manifest_published')
  } catch (error) {
    if (!renamed) {
      try {
        await io.unlink(tempPath)
        syncDirectory(paths.generationPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Preserve the authoritative/security classification of the primary
          // failure; the cache warning still makes the cleanup failure visible.
        }
      }
    }
    throw error
  }
}

function validateRecordBytes(bytes: Uint8Array, maximumBytes: number) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 ||
      bytes[bytes.length - 1] !== 0x0a ||
      bytes.subarray(0, bytes.length - 1).includes(0x0a)) {
    throw storageError('invalid_record', 'append requires one complete JSONL record')
  }
  if (bytes.length > maximumBytes) {
    throw storageError('record_too_large', 'append record exceeds its byte boundary')
  }
}

function catalogWith(
  entries: readonly SessionSegmentCatalogEntry[],
  diagnostics: readonly SessionSegmentDiagnostic[] = [],
): SessionSegmentCatalog {
  let totalEventBytes = 0
  for (const entry of entries) totalEventBytes = checkedAdd(totalEventBytes, entry.byteLength)
  const active = entries.find((entry) => entry.state === 'active')
  return Object.freeze({
    entries: Object.freeze([...entries]),
    ...(active === undefined ? {} : { active }),
    totalEventBytes,
    diagnostics: Object.freeze([...diagnostics]),
  })
}

export class SessionSegmentStorage {
  private readonly io: SessionSegmentStorageIo
  private readonly probe: SessionSegmentStorageProbe
  private readonly owner = Symbol('SessionSegmentStorage')
  private readonly plans = new WeakSet<object>()
  private activeHandle: SessionSegmentFile | undefined
  private generationDirectory: PinnedSessionDirectory | undefined
  private segmentsDirectory: PinnedSessionDirectory | undefined
  private currentCatalog: SessionSegmentCatalog
  private recoveryDiagnosticValues: readonly SessionSegmentDiagnostic[]
  private version = 0
  private closed = false
  private fatalError: unknown

  private constructor(
    private readonly paths: SessionBundlePaths,
    private readonly format: SessionFormatV1,
    io: SessionSegmentStorageIo,
    probe: SessionSegmentStorageProbe,
    private readonly onManifestCacheWarning: (message: string) => void,
    catalog: SessionSegmentCatalog,
    recoveryDiagnostics: readonly SessionSegmentDiagnostic[],
  ) {
    this.io = io
    this.probe = probe
    this.currentCatalog = catalog
    this.recoveryDiagnosticValues = Object.freeze([...recoveryDiagnostics])
  }

  static async open(options: SessionSegmentStorageOptions) {
    const io = options.io ?? nodeSessionSegmentStorageIo
    const probe = options.probe ?? (() => undefined)
    const onManifestCacheWarning = options.onManifestCacheWarning ?? (() => undefined)
    assertPrivateDirectory(options.paths.generationPath)
    await ensureSegmentsDirectory(io, options.paths)
    const generationDirectory = await openPinnedDirectory(io, options.paths.generationPath)
    let segmentsDirectory: PinnedSessionDirectory | undefined
    let activeHandle: SessionSegmentFile | undefined
    let handedOff = false
    try {
      segmentsDirectory = await openPinnedDirectory(io, options.paths.segmentsPath)
      const inspected = await inspectInternal({ ...options, io }, true)
      await assertPinnedDirectory(generationDirectory)
      await assertPinnedDirectory(segmentsDirectory)
      let catalog = inspected.catalog
      if (!catalog.active) {
        const ordinal = catalog.entries.length + 1
        const fileName = formatSessionSegmentFileName(ordinal, 'active')
        const path = join(options.paths.segmentsPath, fileName)
        const handle = await createPrivateFile(io, path)
        try {
          await handle.datasync()
        } finally {
          await handle.close()
        }
        syncDirectory(options.paths.segmentsPath)
        const active = Object.freeze({
          ordinal,
          state: 'active' as const,
          fileName,
          path,
          byteLength: 0,
          physicalByteLength: 0,
          lineCount: 0,
        })
        catalog = catalogWith([...catalog.entries, active], catalog.diagnostics.filter(
          ({ code }) => code !== 'active_segment_missing' && !code.startsWith('manifest_'),
        ))
      }
      const active = catalog.active!
      activeHandle = await openPinnedFile(
        io,
        active.path,
        constants.O_APPEND | constants.O_RDWR,
      )
      const storage = new SessionSegmentStorage(
        options.paths,
        options.format,
        io,
        probe,
        onManifestCacheWarning,
        catalog,
        inspected.diagnostics,
      )
      storage.activeHandle = activeHandle
      storage.generationDirectory = generationDirectory
      storage.segmentsDirectory = segmentsDirectory
      const manifestPublished = await storage.publishManifestCache()
      storage.currentCatalog = catalogWith(catalog.entries, catalog.diagnostics)
      storage.recoveryDiagnosticValues = Object.freeze(inspected.diagnostics.map((diagnostic) =>
        diagnostic.code === 'active_segment_missing'
          ? Object.freeze({ ...diagnostic, repaired: true })
          : diagnostic.code.startsWith('manifest_')
            ? Object.freeze({ ...diagnostic, repaired: manifestPublished })
            : diagnostic))
      await storage.assertFilesystemSafe()
      handedOff = true
      return storage
    } finally {
      if (!handedOff) {
        await activeHandle?.close().catch(() => undefined)
        await segmentsDirectory?.handle.close().catch(() => undefined)
        await generationDirectory.handle.close().catch(() => undefined)
      }
    }
  }

  get catalog() {
    return this.currentCatalog
  }

  get recoveryDiagnostics() {
    return this.recoveryDiagnosticValues
  }

  localizeRecordLocation(location: {
    readonly line: number
    readonly byteOffset: number
    readonly byteLength: number
  }): SessionSegmentRecordLocation | undefined {
    let globalByteOffset = 0
    let globalLineOffset = 0
    for (const entry of this.currentCatalog.entries) {
      if (location.byteOffset >= globalByteOffset &&
          location.byteOffset < globalByteOffset + entry.byteLength) {
        return Object.freeze({
          path: entry.path,
          line: location.line - globalLineOffset,
          byteOffset: location.byteOffset - globalByteOffset,
          byteLength: location.byteLength,
        })
      }
      globalByteOffset = checkedAdd(globalByteOffset, entry.byteLength)
      globalLineOffset = checkedAdd(globalLineOffset, entry.lineCount)
    }
    return undefined
  }

  prepareAppendBatch(records: readonly Uint8Array[]): SessionPreparedAppendBatch {
    this.assertUsable()
    if (!Array.isArray(records) || records.length === 0) {
      throw storageError('invalid_record', 'append batch must not be empty')
    }
    const copied: Uint8Array[] = []
    let byteLength = 0
    for (const record of records) {
      validateRecordBytes(record, this.format.limits.maxRecordBytes)
      const bytes = Buffer.from(record)
      copied.push(bytes)
      byteLength = checkedAdd(byteLength, bytes.length)
    }
    const plan: InternalAppendPlan = Object.freeze({
      owner: this.owner,
      version: this.version,
      records: Object.freeze(copied),
      byteLength,
    })
    this.plans.add(plan)
    return plan
  }

  async appendPreparedBatch(
    prepared: SessionPreparedAppendBatch,
    options: SessionAppendBatchOptions,
  ) {
    this.assertUsable()
    const plan = prepared as InternalAppendPlan
    if (!this.plans.delete(plan) || plan.owner !== this.owner || plan.version !== this.version) {
      throw storageError('stale_append_plan', 'append plan is stale or belongs to another storage')
    }
    if (options.durability !== 'buffered' && options.durability !== 'durable') {
      throw storageError('invalid_record', 'append durability is invalid')
    }
    try {
      await this.assertFilesystemSafe()
      // Reject manifest path tampering before any authoritative event write.
      assertManifestCachePathSafe(this.paths)
      for (const record of plan.records) {
        await this.appendOne(record)
      }
      if (options.durability === 'durable') await this.requireActive().datasync()
      await this.publishManifestCache()
      await this.assertFilesystemSafe()
      this.version++
    } catch (error) {
      this.fatalError ||= error
      throw error
    }
  }

  async *readChunks(): AsyncIterable<Uint8Array> {
    this.assertUsable()
    await this.assertFilesystemSafe()
    try {
      for (const entry of this.currentCatalog.entries) {
        for await (const chunk of readFilePrefix(this.io, entry)) yield chunk
      }
    } finally {
      await this.assertFilesystemSafe()
    }
  }

  async sync() {
    this.assertUsable()
    try {
      await this.assertFilesystemSafe()
      assertManifestCachePathSafe(this.paths)
      await this.requireActive().datasync()
      await this.publishManifestCache()
      await this.assertFilesystemSafe()
    } catch (error) {
      this.fatalError ||= error
      throw error
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    let closeError: unknown = this.fatalError
    const handle = this.activeHandle
    try {
      await this.assertFilesystemSafe(false)
    } catch (error) {
      closeError ||= error
    }
    this.activeHandle = undefined
    if (handle) {
      try {
        await handle.datasync()
      } catch (error) {
        closeError ||= error
      }
      try {
        await handle.close()
      } catch (error) {
        closeError ||= error
      }
    }
    const segmentsDirectory = this.segmentsDirectory
    this.segmentsDirectory = undefined
    if (segmentsDirectory) {
      try {
        await segmentsDirectory.handle.close()
      } catch (error) {
        closeError ||= error
      }
    }
    const generationDirectory = this.generationDirectory
    this.generationDirectory = undefined
    if (generationDirectory) {
      try {
        await generationDirectory.handle.close()
      } catch (error) {
        closeError ||= error
      }
    }
    if (closeError) throw closeError
  }

  /** Staging-only import path; callers must ensure this is a fresh generation. */
  async importLegacyRecords(records: AsyncIterable<Uint8Array>) {
    this.assertUsable()
    if (this.currentCatalog.entries.length !== 1 ||
        this.currentCatalog.active?.ordinal !== 1 ||
        this.currentCatalog.active.byteLength !== 0) {
      throw storageError('legacy_import_not_empty', 'legacy import requires an empty catalog')
    }
    try {
      await this.assertFilesystemSafe()
      assertManifestCachePathSafe(this.paths)
      for await (const value of records) {
        validateRecordBytes(value, this.format.limits.maxReadRecordBytes)
        await this.appendOne(Buffer.from(value))
      }
      await this.requireActive().datasync()
      await this.publishManifestCache()
      await this.assertFilesystemSafe()
      this.version++
    } catch (error) {
      this.fatalError ||= error
      throw error
    }
  }

  private assertUsable() {
    if (this.closed) throw storageError('storage_closed', 'segment storage is closed')
    if (this.fatalError) throw this.fatalError
  }

  private requireActive() {
    if (!this.activeHandle || !this.currentCatalog.active) {
      throw storageError('invalid_catalog', 'active segment descriptor is unavailable')
    }
    return this.activeHandle
  }

  private async assertFilesystemSafe(requireOpen = true) {
    if (requireOpen) this.assertUsable()
    const generationDirectory = this.generationDirectory
    const segmentsDirectory = this.segmentsDirectory
    if (!generationDirectory || !segmentsDirectory) {
      throw storageError('unsafe_metadata', 'session directory descriptors are unavailable')
    }
    await assertPinnedDirectory(generationDirectory)
    await assertPinnedDirectory(segmentsDirectory)
    const active = this.currentCatalog.active
    const handle = this.activeHandle
    if (!active || !handle) {
      throw storageError('invalid_catalog', 'active segment descriptor is unavailable')
    }
    await assertHandlePath(handle, active.path)
  }

  private async publishManifestCache() {
    try {
      await writeManifest(
        this.io,
        this.paths,
        this.format,
        this.currentCatalog,
        this.probe,
      )
      return true
    } catch (error) {
      if (error instanceof SessionSegmentStorageError && error.code === 'unsafe_metadata') {
        throw error
      }
      try {
        this.onManifestCacheWarning(
          '[Session] manifest cache publish failed; authoritative segment facts remain usable',
        )
      } catch {
        // Observability must not turn a rebuildable cache into an append dependency.
      }
      return false
    }
  }

  private async appendOne(bytes: Uint8Array) {
    let active = this.currentCatalog.active
    if (!active) throw storageError('invalid_catalog', 'active segment is unavailable')
    if (active.byteLength > 0 &&
        checkedAdd(active.byteLength, bytes.length) > this.format.limits.segmentTargetBytes) {
      await this.rotate()
      active = this.currentCatalog.active!
    }
    const handle = this.requireActive()
    await assertHandlePath(handle, active.path)
    await writeAll(handle, bytes)
    const expectedPhysicalByteLength = checkedAdd(active.physicalByteLength, bytes.length)
    const written = await assertHandlePath(handle, active.path)
    if (written.size !== expectedPhysicalByteLength) {
      throw storageError('write_failed', 'active segment size does not match the completed write')
    }
    const nextActive = Object.freeze({
      ...active,
      byteLength: checkedAdd(active.byteLength, bytes.length),
      physicalByteLength: expectedPhysicalByteLength,
      lineCount: checkedAdd(active.lineCount, 1),
    })
    this.currentCatalog = catalogWith(this.currentCatalog.entries.map((entry) =>
      entry.ordinal === active!.ordinal ? nextActive : entry))
  }

  private async rotate() {
    const active = this.currentCatalog.active
    const handle = this.requireActive()
    if (!active || active.byteLength === 0) return
    await assertHandlePath(handle, active.path)
    await handle.datasync()
    await this.probe('active_synced')
    const sealedFileName = formatSessionSegmentFileName(active.ordinal, 'sealed')
    const sealedPath = join(this.paths.segmentsPath, sealedFileName)
    await this.io.rename(active.path, sealedPath)
    await this.probe('active_renamed')
    syncDirectory(this.paths.segmentsPath)
    await this.probe('sealed_directory_synced')
    await handle.close()
    this.activeHandle = undefined

    const ordinal = active.ordinal + 1
    const activeFileName = formatSessionSegmentFileName(ordinal, 'active')
    const activePath = join(this.paths.segmentsPath, activeFileName)
    const nextHandle = await createPrivateFile(this.io, activePath)
    this.activeHandle = nextHandle
    await this.probe('next_active_created')
    await nextHandle.datasync()
    syncDirectory(this.paths.segmentsPath)
    await this.probe('next_active_synced')

    const sealed = Object.freeze({
      ...active,
      state: 'sealed' as const,
      fileName: sealedFileName,
      path: sealedPath,
    })
    const next = Object.freeze({
      ordinal,
      state: 'active' as const,
      fileName: activeFileName,
      path: activePath,
      byteLength: 0,
      physicalByteLength: 0,
      lineCount: 0,
    })
    this.currentCatalog = catalogWith([
      ...this.currentCatalog.entries.filter((entry) => entry.ordinal !== active.ordinal),
      sealed,
      next,
    ])
  }
}

export interface ImportLegacySessionRecordsOptions extends SessionSegmentStorageOptions {
  readonly records: AsyncIterable<Uint8Array>
}

export async function importLegacySessionRecords(
  options: ImportLegacySessionRecordsOptions,
): Promise<SessionSegmentCatalog> {
  const io = options.io ?? nodeSessionSegmentStorageIo
  assertPrivateDirectory(options.paths.generationPath)
  if (pathExists(options.paths.segmentsPath)) {
    assertPrivateDirectory(options.paths.segmentsPath)
    if ((await io.readdir(options.paths.segmentsPath)).length > 0) {
      throw storageError(
        'legacy_import_not_empty',
        'legacy import refuses a non-empty segment directory',
        options.paths.segmentsPath,
      )
    }
  }
  if (pathExists(options.paths.manifestPath)) {
    throw storageError(
      'legacy_import_not_empty',
      'legacy import refuses an existing manifest',
      options.paths.manifestPath,
    )
  }
  const storage = await SessionSegmentStorage.open(options)
  try {
    await storage.importLegacyRecords(options.records)
    const catalog = storage.catalog
    await storage.close()
    return catalog
  } catch (error) {
    await storage.close().catch(() => undefined)
    throw error
  }
}
