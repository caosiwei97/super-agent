import { randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  type Stats,
} from 'node:fs'
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createSessionFormat,
  computeSessionGeneration,
  deterministicSessionJsonBytes,
  encodeSessionFence,
  LEGACY_JSONL_SOURCE_KIND,
  parseSessionFence,
  parseSessionFormatBytes,
  resolveSessionBundlePaths,
  SESSION_FORMAT_MAX_BYTES,
  SESSION_STORAGE_FENCE_PREFIX,
  type SessionBundlePaths,
  type SessionFormatV1,
  type SessionSourceFingerprint,
  type SessionStorageLimits,
} from './session-layout.js'
import {
  importLegacySessionRecords,
  inspectSessionSegmentStorage,
  readSessionSegmentChunks,
} from './session-segment-storage.js'
import {
  createSessionRecordFingerprint,
  streamSessionRecordBytes,
} from './session-record-stream.js'
import {
  scanSessionJournal,
  type SessionJournalScanResult,
} from './journal-scanner.js'
import {
  type SessionFenceCommitPoint,
  type SessionFileLease,
} from './session-file-lease.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const FENCE_BYTES = SESSION_STORAGE_FENCE_PREFIX.length + 64 + 1

export type SessionMigrationPoint =
  | 'legacy_synced'
  | 'bundle_staged'
  | 'bundle_published'
  | 'bundle_verified'
  | 'before_fence_commit'
  | 'existing_fence_adopted'
  | SessionFenceCommitPoint

export type SessionMigrationProbe = (
  point: SessionMigrationPoint,
) => void | Promise<void>

export interface SessionPreparedBundleVerification {
  /** Migration verifies generic JSONL/envelope invariants first. */
  readonly scan: SessionJournalScanResult
  readonly phase: 'migration' | 'reopen'
  readonly format: SessionFormatV1
  readonly paths: SessionBundlePaths
  readChunks(): AsyncIterable<Uint8Array>
}

/**
 * Required typed gate for payload/schema transitions, Operation projection and
 * quota obligations. Returning successfully authorizes the fence commit.
 */
export type VerifyPreparedSessionBundle = (
  prepared: SessionPreparedBundleVerification,
) => void | Promise<void>

export interface MigrateLegacySessionOptions {
  readonly directory: string
  readonly sessionId: string
  /** The caller owns this fixed-lock lease and closes it with the Store. */
  readonly lease: SessionFileLease
  readonly limits?: Partial<SessionStorageLimits>
  readonly verifyPreparedBundle: VerifyPreparedSessionBundle
  readonly probe?: SessionMigrationProbe
}

export interface SessionMigrationResult {
  readonly disposition: 'migrated' | 'reused-orphan' | 'reopened'
  readonly format: SessionFormatV1
  readonly paths: SessionBundlePaths
  readonly repairedLegacyEofBytes: number
}

interface LegacyFingerprintResult {
  readonly source: SessionSourceFingerprint
  readonly repairedBytes: number
}

interface MigrationPinnedPath {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly identity: Stats
  readonly handle: FileHandle
}

function migrationError(message: string, cause?: unknown) {
  const detail = `[Session] migration failed closed: ${message}`
  return cause === undefined ? new Error(detail) : new Error(detail, { cause })
}

function sameIdentity(expected: Stats, actual: Stats) {
  return expected.dev === actual.dev && expected.ino === actual.ino
}

function isCurrentOwner(metadata: Stats) {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid()
}

function assertPrivateDirectory(path: string) {
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.nlink < 1 || !isCurrentOwner(metadata) ||
      (metadata.mode & 0o777) !== DIRECTORY_MODE) {
    throw migrationError(`unsafe private directory: ${path}`)
  }
}

function assertPrivatePinnedMetadata(
  metadata: Stats,
  path: string,
  kind: MigrationPinnedPath['kind'],
) {
  const valid = kind === 'directory'
    ? metadata.isDirectory() && metadata.nlink >= 1 &&
      (metadata.mode & 0o777) === DIRECTORY_MODE
    : metadata.isFile() && metadata.nlink === 1 &&
      (metadata.mode & 0o777) === FILE_MODE
  if (!valid || !isCurrentOwner(metadata)) {
    throw migrationError(`unsafe pinned bundle ${kind}: ${path}`)
  }
}

async function openMigrationPinnedPath(
  path: string,
  kind: MigrationPinnedPath['kind'],
): Promise<MigrationPinnedPath> {
  const expected = lstatSync(path)
  assertPrivatePinnedMetadata(expected, path, kind)
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) |
    (kind === 'directory' ? (constants.O_DIRECTORY ?? 0) : 0)
  const handle = await open(path, flags)
  try {
    const descriptor = await handle.stat()
    const pathname = lstatSync(path)
    assertPrivatePinnedMetadata(descriptor, path, kind)
    assertPrivatePinnedMetadata(pathname, path, kind)
    if (!sameIdentity(expected, descriptor) || !sameIdentity(descriptor, pathname)) {
      throw migrationError(`pinned bundle ${kind} identity mismatch: ${path}`)
    }
    return Object.freeze({ path, kind, identity: descriptor, handle })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function assertMigrationPinnedPath(pinned: MigrationPinnedPath) {
  const descriptor = await pinned.handle.stat()
  const pathname = lstatSync(pinned.path)
  assertPrivatePinnedMetadata(descriptor, pinned.path, pinned.kind)
  assertPrivatePinnedMetadata(pathname, pinned.path, pinned.kind)
  if (!sameIdentity(pinned.identity, descriptor) || !sameIdentity(descriptor, pathname) ||
      descriptor.size !== pinned.identity.size || pathname.size !== pinned.identity.size ||
      descriptor.mtimeMs !== pinned.identity.mtimeMs ||
      descriptor.ctimeMs !== pinned.identity.ctimeMs) {
    throw migrationError(`pinned bundle ${pinned.kind} changed before fence commit: ${pinned.path}`)
  }
}

class MigrationBundlePin {
  private constructor(private readonly pinned: readonly MigrationPinnedPath[]) {}

  static async open(paths: SessionBundlePaths) {
    const pinned: MigrationPinnedPath[] = []
    try {
      for (const path of [paths.bundleRootPath, paths.generationPath, paths.segmentsPath]) {
        pinned.push(await openMigrationPinnedPath(path, 'directory'))
      }
      pinned.push(await openMigrationPinnedPath(paths.formatPath, 'file'))
      for (const name of (await readdir(paths.segmentsPath)).sort()) {
        pinned.push(await openMigrationPinnedPath(resolve(paths.segmentsPath, name), 'file'))
      }
      const value = new MigrationBundlePin(Object.freeze(pinned))
      await value.assertSafe()
      return value
    } catch (error) {
      await Promise.allSettled(pinned.map(({ handle }) => handle.close()))
      throw error
    }
  }

  async assertSafe() {
    for (const value of this.pinned) await assertMigrationPinnedPath(value)
  }

  async close() {
    const results = await Promise.allSettled(this.pinned.map(({ handle }) => handle.close()))
    const rejected = results.find((value) => value.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
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
      throw migrationError(`directory changed while synchronizing: ${path}`)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function readPrivateFile(path: string, maximumBytes: number) {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const expected = lstatSync(path)
  if (!expected.isFile() || expected.nlink !== 1 || !isCurrentOwner(expected) ||
      (expected.mode & 0o777) !== FILE_MODE || expected.size <= 0 ||
      expected.size > maximumBytes || !Number.isSafeInteger(expected.size)) {
    throw migrationError(`unsafe or oversized metadata file: ${path}`)
  }
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const descriptor = await handle.stat()
    if (!sameIdentity(expected, descriptor) || !descriptor.isFile() ||
        descriptor.nlink !== 1 || !isCurrentOwner(descriptor) ||
        (descriptor.mode & 0o777) !== FILE_MODE || descriptor.size !== expected.size) {
      throw migrationError(`metadata descriptor mismatch: ${path}`)
    }
    const bytes = Buffer.allocUnsafe(descriptor.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead <= 0 || bytesRead > bytes.length - offset) {
        throw migrationError(`metadata read made no progress: ${path}`)
      }
      offset += bytesRead
    }
    const eof = Buffer.allocUnsafe(1)
    if ((await handle.read(eof, 0, 1, bytes.length)).bytesRead !== 0) {
      throw migrationError(`metadata grew while reading: ${path}`)
    }
    const current = lstatSync(path)
    if (!sameIdentity(descriptor, current) || current.size !== descriptor.size) {
      throw migrationError(`metadata path changed while reading: ${path}`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array) {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
    FILE_MODE,
  )
  try {
    await handle.chmod(FILE_MODE)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
      if (bytesWritten <= 0 || bytesWritten > bytes.length - offset) {
        throw migrationError(`metadata write made no progress: ${path}`)
      }
      offset += bytesWritten
    }
    await handle.datasync()
    const metadata = await handle.stat()
    const pathname = lstatSync(path)
    if (!sameIdentity(metadata, pathname) || !metadata.isFile() || metadata.nlink !== 1 ||
        !isCurrentOwner(metadata) || (metadata.mode & 0o777) !== FILE_MODE ||
        metadata.size !== bytes.length) {
      throw migrationError(`metadata publish validation failed: ${path}`)
    }
  } finally {
    await handle.close()
  }
  const actual = await readPrivateFile(path, Math.max(bytes.length, 1))
  if (!actual.equals(Buffer.from(bytes))) {
    throw migrationError(`metadata bytes changed after publish: ${path}`)
  }
}

function pathsAtGenerationPath(
  canonical: SessionBundlePaths,
  generationPath: string,
): SessionBundlePaths {
  return Object.freeze({
    ...canonical,
    generationPath,
    formatPath: resolve(generationPath, 'format.json'),
    manifestPath: resolve(generationPath, 'manifest.json'),
    segmentsPath: resolve(generationPath, 'segments'),
  })
}

function ensureBundleRoot(paths: SessionBundlePaths) {
  let created = false
  try {
    mkdirSync(paths.bundleRootPath, { mode: DIRECTORY_MODE })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  assertPrivateDirectory(paths.bundleRootPath)
  if (created) syncDirectory(paths.directoryPath)
}

const STAGING_DIRECTORY_PATTERN =
  /^\.[0-9a-f]{64}\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.staging$/

function removePrivateStagingDirectory(bundleRootPath: string, stagingPath: string) {
  assertPrivateDirectory(stagingPath)
  rmSync(stagingPath, { recursive: true })
  syncDirectory(bundleRootPath)
}

/** The fixed + legacy locks prove that no live migration can own these paths. */
function cleanAbandonedStagingDirectories(bundleRootPath: string) {
  for (const name of readdirSync(bundleRootPath)) {
    if (!STAGING_DIRECTORY_PATTERN.test(name)) continue
    removePrivateStagingDirectory(bundleRootPath, resolve(bundleRootPath, name))
  }
}

async function potentialFenceGeneration(lease: SessionFileLease) {
  const parts: Buffer[] = []
  let length = 0
  for await (const chunk of lease.readChunks()) {
    if (length + chunk.length > FENCE_BYTES) return undefined
    parts.push(Buffer.from(chunk))
    length += chunk.length
  }
  if (length !== FENCE_BYTES) return undefined
  try {
    return parseSessionFence(Buffer.concat(parts, length))
  } catch {
    return undefined
  }
}

async function fingerprintLegacyJournal(
  lease: SessionFileLease,
  maxReadRecordBytes: number,
  repairEof: boolean,
): Promise<LegacyFingerprintResult> {
  const fingerprint = createSessionRecordFingerprint()
  let repairedBytes = 0
  for await (const item of streamSessionRecordBytes(lease.readChunks(), {
    maxRecordBytes: maxReadRecordBytes,
  })) {
    if (item.kind === 'record') {
      fingerprint.update(item.bytes)
      continue
    }
    if (!repairEof) {
      throw migrationError('legacy journal changed after its synchronized fingerprint')
    }
    repairedBytes = item.byteLength
    await lease.truncate(item.byteOffset)
  }
  await lease.datasync()
  await lease.assertSafe()
  const digested = fingerprint.digest()
  return Object.freeze({
    source: Object.freeze({
      kind: LEGACY_JSONL_SOURCE_KIND,
      byteLength: digested.byteLength,
      sha256: digested.sha256,
    }),
    repairedBytes,
  })
}

async function* legacyRecords(
  lease: SessionFileLease,
  maxReadRecordBytes: number,
) {
  for await (const item of streamSessionRecordBytes(lease.readChunks(), {
    maxRecordBytes: maxReadRecordBytes,
  })) {
    if (item.kind !== 'record') {
      throw migrationError('legacy journal retained an EOF fragment after repair')
    }
    yield item.bytes
  }
}

async function assertFormat(
  paths: SessionBundlePaths,
  expectation: {
    readonly sessionId: string
    readonly generation: string
    readonly source?: SessionSourceFingerprint
    readonly limits?: Partial<SessionStorageLimits>
  },
) {
  assertPrivateDirectory(paths.bundleRootPath)
  assertPrivateDirectory(paths.generationPath)
  const bytes = await readPrivateFile(paths.formatPath, SESSION_FORMAT_MAX_BYTES)
  return parseSessionFormatBytes(bytes, expectation)
}

async function fingerprintBundle(format: SessionFormatV1, paths: SessionBundlePaths) {
  const fingerprint = createSessionRecordFingerprint()
  for await (const chunk of readSessionSegmentChunks({ paths, format })) {
    fingerprint.update(chunk)
  }
  const actual = fingerprint.digest()
  if (actual.byteLength !== format.source.byteLength || actual.sha256 !== format.source.sha256) {
    throw migrationError('orphan bundle does not exactly match the locked legacy fingerprint')
  }
}

async function verifyBundle(
  phase: 'migration' | 'reopen',
  format: SessionFormatV1,
  paths: SessionBundlePaths,
  verifyPreparedBundle: VerifyPreparedSessionBundle,
) {
  const inspected = await inspectSessionSegmentStorage({ paths, format })
  if (phase === 'migration' && inspected.diagnostics.some(
    ({ code }) => code === 'trailing_eof_fragment',
  )) {
    throw migrationError('orphan bundle contains bytes beyond the locked legacy source')
  }
  if (phase === 'migration') await fingerprintBundle(format, paths)
  const readChunks = () => readSessionSegmentChunks({ paths, format })
  const scan = await scanSessionJournal(readChunks(), {
    maxRecordBytes: format.limits.maxReadRecordBytes,
  })
  if (scan.diagnostics.length > 0) {
    throw migrationError('prepared bundle contains an unexpected active EOF fragment')
  }
  await verifyPreparedBundle(Object.freeze({
    scan,
    phase,
    format,
    paths,
    readChunks,
  }))
}

async function createAndPublishBundle(
  lease: SessionFileLease,
  canonical: SessionBundlePaths,
  format: SessionFormatV1,
  verifyPreparedBundle: VerifyPreparedSessionBundle,
  probe: SessionMigrationProbe,
) {
  ensureBundleRoot(canonical)
  const stagingPath = resolve(
    canonical.bundleRootPath,
    `.${format.generation}.${process.pid}.${randomUUID()}.staging`,
  )
  mkdirSync(stagingPath, { mode: DIRECTORY_MODE })
  assertPrivateDirectory(stagingPath)
  const staging = pathsAtGenerationPath(canonical, stagingPath)
  let published = false
  try {
    await writePrivateFile(staging.formatPath, deterministicSessionJsonBytes(format))
    await importLegacySessionRecords({
      paths: staging,
      format,
      records: legacyRecords(lease, format.limits.maxReadRecordBytes),
    })
    syncDirectory(staging.generationPath)
    await assertFormat(staging, {
      sessionId: format.sessionId,
      generation: format.generation,
      source: format.source,
      limits: format.limits,
    })
    // A rejected typed/quota contract must never become a canonical orphan.
    // Generation deliberately excludes limits, so publishing first would make
    // a later explicit contract increase conflict forever with the rejected
    // immutable format at the same generation.
    await verifyBundle('migration', format, staging, verifyPreparedBundle)
    await probe('bundle_staged')

    if (pathExists(canonical.generationPath)) {
      throw migrationError('canonical generation appeared during staging publish')
    }
    renameSync(staging.generationPath, canonical.generationPath)
    published = true
    syncDirectory(canonical.bundleRootPath)
    await probe('bundle_published')
  } catch (error) {
    if (!published && pathExists(stagingPath)) {
      try {
        removePrivateStagingDirectory(canonical.bundleRootPath, stagingPath)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          '[Session] migration failed and its exact staging directory could not be removed',
        )
      }
    }
    throw error
  }
}

/**
 * Opens the exact committed generation or migrates the locked legacy journal.
 * The lease must already own the fixed lock; this function acquires/retains the
 * canonical secondary flock through lease.openJournal().
 */
export async function migrateLegacySession(
  options: MigrateLegacySessionOptions,
): Promise<SessionMigrationResult> {
  if (typeof options.verifyPreparedBundle !== 'function') {
    throw new TypeError('verifyPreparedBundle is required for typed/quota migration admission')
  }
  const probe = options.probe ?? (() => undefined)
  const { lease, sessionId, directory } = options
  if (lease.filePath !== resolve(directory, `${sessionId}.jsonl`) ||
      lease.lockPath !== resolve(directory, `${sessionId}.lock`)) {
    throw migrationError('lease identity does not match the requested session')
  }
  await lease.openJournal()

  const fencedGeneration = await potentialFenceGeneration(lease)
  if (fencedGeneration !== undefined) {
    const fenceBytes = encodeSessionFence(fencedGeneration)
    const paths = resolveSessionBundlePaths(directory, sessionId, fencedGeneration)
    const format = await assertFormat(paths, {
      sessionId,
      generation: fencedGeneration,
      limits: options.limits,
    })
    await verifyBundle('reopen', format, paths, options.verifyPreparedBundle)
    await lease.adoptJournalFence(fenceBytes)
    await probe('existing_fence_adopted')
    return Object.freeze({
      disposition: 'reopened',
      format,
      paths,
      repairedLegacyEofBytes: 0,
    })
  }

  const initialLimits = createSessionFormat({
    sessionId,
    source: Object.freeze({
      kind: LEGACY_JSONL_SOURCE_KIND,
      byteLength: 0,
      sha256: '0'.repeat(64),
    }),
    limits: options.limits,
  }).limits
  const fingerprint = await fingerprintLegacyJournal(
    lease,
    initialLimits.maxReadRecordBytes,
    true,
  )
  await probe('legacy_synced')
  const generation = computeSessionGeneration({ sessionId, source: fingerprint.source })
  const paths = resolveSessionBundlePaths(directory, sessionId, generation)
  ensureBundleRoot(paths)
  cleanAbandonedStagingDirectories(paths.bundleRootPath)
  const reused = pathExists(paths.generationPath)
  let persistedFormat: SessionFormatV1
  if (reused) {
    // Generation deliberately excludes limits. A post-publish/pre-fence retry
    // must recover unspecified values from immutable format.json instead of
    // accidentally comparing them with this process's defaults.
    persistedFormat = await assertFormat(paths, {
      sessionId,
      generation,
      source: fingerprint.source,
      limits: options.limits,
    })
  } else {
    const format = createSessionFormat({
      sessionId,
      source: fingerprint.source,
      limits: options.limits,
    })
    await createAndPublishBundle(
      lease,
      paths,
      format,
      options.verifyPreparedBundle,
      probe,
    )
    persistedFormat = await assertFormat(paths, {
      sessionId,
      generation,
      source: fingerprint.source,
      limits: format.limits,
    })
  }
  await verifyBundle('migration', persistedFormat, paths, options.verifyPreparedBundle)
  await probe('bundle_verified')

  const unchanged = await fingerprintLegacyJournal(
    lease,
    persistedFormat.limits.maxReadRecordBytes,
    false,
  )
  if (unchanged.source.byteLength !== persistedFormat.source.byteLength ||
      unchanged.source.sha256 !== persistedFormat.source.sha256) {
    throw migrationError('legacy journal changed before the fence commit point')
  }
  const bundlePin = await MigrationBundlePin.open(paths)
  try {
    await probe('before_fence_commit')
    // The last observer hook is deliberately before this descriptor-bound
    // revalidation, so path replacement cannot cross the fence commit point.
    await verifyBundle('migration', persistedFormat, paths, options.verifyPreparedBundle)
    await bundlePin.assertSafe()
    await lease.assertSafe()
    await lease.commitJournalFence(
      encodeSessionFence(persistedFormat.generation),
      async (point) => {
        await bundlePin.assertSafe()
        await probe(point)
        await bundlePin.assertSafe()
      },
    )
    await bundlePin.assertSafe()
  } finally {
    await bundlePin.close()
  }
  return Object.freeze({
    disposition: reused ? 'reused-orphan' : 'migrated',
    format: persistedFormat,
    paths,
    repairedLegacyEofBytes: fingerprint.repairedBytes,
  })
}
