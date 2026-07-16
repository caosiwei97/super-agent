import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isSensitivePath } from '../security/sensitive-paths.js'

const COPY_CHUNK_BYTES = 64 * 1024
const SNAPSHOT_DIRECTORY_PREFIX = 'super-agent-workspace-snapshot-'
const SNAPSHOT_DIRECTORY_SUFFIX = /^[A-Za-z0-9]{6}$/
const SNAPSHOT_OWNER_MARKER = 'owner.json'
const SNAPSHOT_PAYLOAD_DIRECTORY = 'payload'
const SNAPSHOT_OWNER_SCHEMA = 'super-agent.workspace-snapshot-owner/v1'
const MAX_OWNER_MARKER_BYTES = 512
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const NON_BLOCK = constants.O_NONBLOCK ?? 0
const DIRECTORY = constants.O_DIRECTORY ?? 0

const DEFAULT_STALE_SNAPSHOT_LIMITS: WorkspaceSnapshotLimits = Object.freeze({
  maxFiles: 10_000,
  maxEntries: 20_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxDepth: 64,
})

export interface WorkspaceSnapshotLimits {
  readonly maxFiles: number
  /** Files plus directories below the source root. */
  readonly maxEntries: number
  readonly maxTotalBytes: number
  readonly maxFileBytes: number
  /** Root is depth 0; its direct children are depth 1. */
  readonly maxDepth: number
}

export interface WorkspaceSnapshotControl {
  readonly signal: AbortSignal
  readonly deadline: number
}

/**
 * `linux-proc-fd` is the production source form. The descriptor itself remains
 * owned by the caller (normally `withReadOnlyWorkspaceFd`) for the entire copy.
 * `directory` exists for portable development/tests and detects, but cannot
 * eliminate, same-UID pathname races on platforms without openat-style APIs.
 */
export interface WorkspaceSnapshotSource {
  readonly readPath: string
  readonly canonicalPath: string
  readonly expectedIdentity: string
  readonly rootKind?: 'directory' | 'linux-proc-fd'
}

export interface WorkspaceSnapshotManifestEntry {
  readonly relativePath: string
  readonly bytes: number
  readonly sha256: string
}

export interface WorkspaceSnapshotTestHooks {
  /** Test seam only. Production callers must omit it. */
  readonly afterFileCopied?: (relativePath: string) => void | Promise<void>
}

export interface WorkspaceSnapshotOptions {
  readonly limits: WorkspaceSnapshotLimits
  readonly control: WorkspaceSnapshotControl
  readonly stagingParent?: string
  /** Test seam only. Production callers must omit it. */
  readonly testHooks?: WorkspaceSnapshotTestHooks
}

export interface StaleWorkspaceSnapshotCleanupOptions {
  readonly control: WorkspaceSnapshotControl
  readonly stagingParent?: string
  /** Defaults to the production snapshot limits. */
  readonly limits?: WorkspaceSnapshotLimits
  /** Must exceed the maximum sandbox operation lifetime. */
  readonly minimumAgeMs: number
  /** Test seam for deterministic age checks. */
  readonly now?: number
}

export interface WorkspaceSnapshot {
  /** Host path of the private artifact's read-only `payload/` directory. */
  readonly rootPath: string
  /** Owned directory FD, valid until `cleanup()` resolves. */
  readonly descriptor: number
  readonly sourceIdentity: string
  readonly fileCount: number
  readonly entryCount: number
  readonly totalBytes: number
  readonly manifest: readonly WorkspaceSnapshotManifestEntry[]
  /** Explicitly distinguishes this artifact from a kernel/filesystem snapshot. */
  readonly implementation: 'verified-user-space-copy'
  /** Safe to call repeatedly or concurrently. */
  cleanup(): Promise<void>
}

export type WorkspaceSnapshotErrorCode =
  | 'workspace_snapshot_invalid_source'
  | 'workspace_snapshot_unsafe_entry'
  | 'workspace_snapshot_limit_exceeded'
  | 'workspace_snapshot_source_changed'
  | 'workspace_snapshot_staging_failed'
  | 'workspace_snapshot_cleanup_failed'

export class WorkspaceSnapshotError extends Error {
  override readonly name = 'WorkspaceSnapshotError'

  constructor(readonly code: WorkspaceSnapshotErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

interface MutableSnapshotState {
  files: number
  entries: number
  totalBytes: number
  readonly manifest: WorkspaceSnapshotManifestEntry[]
  readonly sourceTreeManifest: Map<string, SourceTreeManifestEntry>
}

type SourceTreeManifestEntry = Readonly<{
  kind: 'directory'
  relativePath: string
  metadata: BigIntStats
}> | Readonly<{
  kind: 'file'
  relativePath: string
  metadata: BigIntStats
  bytes: number
  sha256: string
}>

interface VerificationState {
  files: number
  entries: number
  totalBytes: number
  readonly seen: Set<string>
}

interface CopyContext {
  readonly source: WorkspaceSnapshotSource
  readonly stagingRoot: string
  readonly limits: WorkspaceSnapshotLimits
  readonly control: WorkspaceSnapshotControl
  readonly state: MutableSnapshotState
  readonly testHooks?: WorkspaceSnapshotTestHooks
}

function fail(
  code: WorkspaceSnapshotErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WorkspaceSnapshotError(code, message, cause === undefined ? undefined : { cause })
}

function assertControl(control: WorkspaceSnapshotControl) {
  if (control.signal.aborted) {
    throw control.signal.reason instanceof Error
      ? control.signal.reason
      : new DOMException('Workspace snapshot aborted', 'AbortError')
  }
  if (Date.now() >= control.deadline) {
    throw new DOMException('Workspace snapshot deadline exceeded', 'TimeoutError')
  }
}

function assertPositiveSafeInteger(value: number, field: string, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${field} 必须是${allowZero ? '非负' : '正'}安全整数`)
  }
}

function validateLimits(limits: WorkspaceSnapshotLimits) {
  for (const [field, value] of Object.entries({
    maxFiles: limits.maxFiles,
    maxEntries: limits.maxEntries,
    maxTotalBytes: limits.maxTotalBytes,
    maxFileBytes: limits.maxFileBytes,
    maxDepth: limits.maxDepth,
  })) {
    assertPositiveSafeInteger(value, field, field === 'maxDepth')
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new TypeError('workspace snapshot maxFileBytes 不能超过 maxTotalBytes')
  }
}

function validateInputs(source: WorkspaceSnapshotSource, options: WorkspaceSnapshotOptions) {
  if (!isAbsolute(source.readPath) || !isAbsolute(source.canonicalPath)) {
    throw new TypeError('workspace snapshot source 路径必须是绝对路径')
  }
  if (!/^\d+:\d+$/.test(source.expectedIdentity)) {
    throw new TypeError('workspace snapshot expectedIdentity 必须是 dev:ino')
  }
  if (!Number.isFinite(options.control.deadline)) {
    throw new TypeError('workspace snapshot deadline 必须是有限数字')
  }
  if (source.rootKind !== undefined
    && source.rootKind !== 'directory'
    && source.rootKind !== 'linux-proc-fd') {
    throw new TypeError('workspace snapshot rootKind 非法')
  }
  validateLimits(options.limits)
  if (options.stagingParent !== undefined && !isAbsolute(options.stagingParent)) {
    throw new TypeError('workspace snapshot stagingParent 必须是绝对路径')
  }
}

function identity(metadata: BigIntStats) {
  return `${metadata.dev}:${metadata.ino}`
}

function isWithin(parent: string, child: string) {
  const value = relative(parent, child)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function assertTrustedStagingParent(path: string) {
  const currentUid = process.getuid?.()
  if (currentUid === undefined) {
    fail('workspace_snapshot_staging_failed', '当前平台无法验证 staging owner')
  }
  const components = path.split(sep).filter(Boolean)
  let current: string = sep
  for (const component of components) {
    current = join(current, component)
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail('workspace_snapshot_staging_failed', `staging ancestor 不是普通目录: ${current}`)
    }
    if (metadata.uid !== 0 && metadata.uid !== currentUid) {
      fail('workspace_snapshot_staging_failed', `staging ancestor owner 不可信: ${current}`)
    }
    const writableByOthers = (metadata.mode & 0o022) !== 0
    const sticky = (metadata.mode & 0o1000) !== 0
    if (writableByOthers && !(sticky && metadata.uid === 0)) {
      fail('workspace_snapshot_staging_failed', `staging ancestor 可被其他用户替换: ${current}`)
    }
  }

  const parent = await lstat(path)
  const privatelyOwned = parent.uid === currentUid && (parent.mode & 0o022) === 0
  if (!privatelyOwned) {
    fail('workspace_snapshot_staging_failed', 'staging final parent 必须由当前 UID 拥有且不可被 group/other 写入')
  }
}

function stableFingerprint(metadata: BigIntStats) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.uid,
    metadata.gid,
    metadata.nlink,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(':')
}

function assertSameMetadata(
  expected: BigIntStats,
  actual: BigIntStats,
  relativePath: string,
) {
  if (stableFingerprint(expected) !== stableFingerprint(actual)) {
    fail('workspace_snapshot_source_changed', `workspace source 在复制期间发生变化: ${relativePath}`)
  }
}

function relativeName(parts: readonly string[]) {
  return parts.join('/')
}

function manifestName(parts: readonly string[]) {
  return relativeName(parts) || '.'
}

function recordSourceTreeEntry(
  state: MutableSnapshotState,
  entry: SourceTreeManifestEntry,
) {
  if (state.sourceTreeManifest.has(entry.relativePath)) {
    fail('workspace_snapshot_source_changed', `workspace source 出现重复目录项: ${entry.relativePath}`)
  }
  state.sourceTreeManifest.set(entry.relativePath, entry)
}

function assertSafeLogicalPath(source: WorkspaceSnapshotSource, parts: readonly string[]) {
  const logicalPath = join(source.canonicalPath, ...parts)
  if (isSensitivePath(logicalPath, source.canonicalPath) || isSensitivePath(logicalPath)) {
    fail('workspace_snapshot_unsafe_entry', `workspace snapshot 拒绝敏感路径: ${relativeName(parts)}`)
  }
}

function assertEntryBudget(context: CopyContext, depth: number) {
  context.state.entries += 1
  if (context.state.entries > context.limits.maxEntries) {
    fail('workspace_snapshot_limit_exceeded', 'workspace snapshot 超过 entry 数量限制')
  }
  if (depth > context.limits.maxDepth) {
    fail('workspace_snapshot_limit_exceeded', 'workspace snapshot 超过目录深度限制')
  }
}

async function sourceRootMetadata(source: WorkspaceSnapshotSource) {
  if (source.rootKind === 'linux-proc-fd') {
    if (process.platform !== 'linux' || !/^\/proc\/self\/fd\/\d+$/.test(source.readPath)) {
      fail('workspace_snapshot_invalid_source', 'linux workspace snapshot source 必须是 /proc/self/fd/N')
    }
    return stat(source.readPath, { bigint: true })
  }
  const metadata = await lstat(source.readPath, { bigint: true })
  if (metadata.isSymbolicLink()) {
    fail('workspace_snapshot_invalid_source', 'workspace snapshot source root 不能是 symlink')
  }
  if (await realpath(source.readPath) !== source.canonicalPath) {
    fail('workspace_snapshot_invalid_source', 'workspace snapshot canonicalPath 与 source root 不匹配')
  }
  return metadata
}

async function readDirectoryEntries(
  path: string,
  context: CopyContext,
  childDepth: number,
) {
  const directory = await opendir(path)
  const names: string[] = []
  try {
    while (true) {
      assertControl(context.control)
      const entry = await directory.read()
      if (!entry) break
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\0')) {
        fail('workspace_snapshot_unsafe_entry', 'workspace snapshot 遇到非法目录项')
      }
      assertEntryBudget(context, childDepth)
      names.push(entry.name)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  return names
}

async function readVerificationDirectoryEntries(
  path: string,
  context: CopyContext,
  state: VerificationState,
  childDepth: number,
) {
  const directory = await opendir(path)
  const names: string[] = []
  try {
    while (true) {
      assertControl(context.control)
      const entry = await directory.read()
      if (!entry) break
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\0')) {
        fail('workspace_snapshot_unsafe_entry', 'workspace snapshot 复验遇到非法目录项')
      }
      state.entries += 1
      if (state.entries > context.limits.maxEntries) {
        fail('workspace_snapshot_source_changed', 'workspace source 在全树复验时增加了过多目录项')
      }
      if (childDepth > context.limits.maxDepth) {
        fail('workspace_snapshot_source_changed', 'workspace source 在全树复验时超过目录深度限制')
      }
      names.push(entry.name)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  return names
}

async function openAnchoredDirectory(path: string, expected: BigIntStats, relativePath: string) {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW)
  } catch (error) {
    fail('workspace_snapshot_source_changed', `workspace 目录无法安全锚定: ${relativePath}`, error)
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isDirectory()) {
      fail('workspace_snapshot_unsafe_entry', `workspace snapshot 只允许目录: ${relativePath}`)
    }
    assertSameMetadata(expected, opened, relativePath)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function copyFile(
  sourcePath: string,
  destinationPath: string,
  metadata: BigIntStats,
  parts: readonly string[],
  context: CopyContext,
) {
  const relativePath = relativeName(parts)
  if (!metadata.isFile()) {
    fail('workspace_snapshot_unsafe_entry', `workspace snapshot 拒绝特殊文件: ${relativePath}`)
  }
  if (metadata.nlink !== 1n) {
    fail('workspace_snapshot_unsafe_entry', `workspace snapshot 拒绝 hardlink: ${relativePath}`)
  }
  if (++context.state.files > context.limits.maxFiles) {
    fail('workspace_snapshot_limit_exceeded', 'workspace snapshot 超过文件数量限制')
  }
  if (metadata.size > BigInt(context.limits.maxFileBytes)) {
    fail('workspace_snapshot_limit_exceeded', `workspace 文件超过单文件限制: ${relativePath}`)
  }
  if (BigInt(context.state.totalBytes) + metadata.size > BigInt(context.limits.maxTotalBytes)) {
    fail('workspace_snapshot_limit_exceeded', 'workspace snapshot 超过总字节限制')
  }

  let sourceHandle: FileHandle
  try {
    sourceHandle = await open(sourcePath, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
  } catch (error) {
    fail('workspace_snapshot_source_changed', `workspace 文件无法安全打开: ${relativePath}`, error)
  }
  let destinationHandle: FileHandle | undefined
  try {
    const opened = await sourceHandle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n) {
      fail('workspace_snapshot_unsafe_entry', `workspace snapshot 拒绝非普通文件或 hardlink: ${relativePath}`)
    }
    assertSameMetadata(metadata, opened, relativePath)
    destinationHandle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    )

    const copiedHash = createHash('sha256')
    let copiedBytes = 0
    while (true) {
      assertControl(context.control)
      const remaining = context.limits.maxFileBytes - copiedBytes
      const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, remaining + 1))
      const result = await sourceHandle.read(buffer, 0, buffer.byteLength, copiedBytes)
      if (result.bytesRead === 0) break
      copiedBytes += result.bytesRead
      if (copiedBytes > context.limits.maxFileBytes
        || context.state.totalBytes + copiedBytes > context.limits.maxTotalBytes) {
        fail('workspace_snapshot_limit_exceeded', `workspace 文件复制时超过字节限制: ${relativePath}`)
      }
      const chunk = buffer.subarray(0, result.bytesRead)
      copiedHash.update(chunk)
      let written = 0
      while (written < chunk.byteLength) {
        assertControl(context.control)
        const result = await destinationHandle.write(
          chunk,
          written,
          chunk.byteLength - written,
          copiedBytes - chunk.byteLength + written,
        )
        if (result.bytesWritten <= 0) {
          fail('workspace_snapshot_staging_failed', 'workspace staging 写入未取得进展')
        }
        written += result.bytesWritten
      }
    }
    await context.testHooks?.afterFileCopied?.(relativePath)
    assertControl(context.control)

    const copiedDigest = copiedHash.digest('hex')
    const verifiedHash = createHash('sha256')
    let verifiedBytes = 0
    while (true) {
      assertControl(context.control)
      const remaining = context.limits.maxFileBytes - verifiedBytes
      const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, remaining + 1))
      const result = await sourceHandle.read(buffer, 0, buffer.byteLength, verifiedBytes)
      if (result.bytesRead === 0) break
      verifiedBytes += result.bytesRead
      if (verifiedBytes > context.limits.maxFileBytes) {
        fail('workspace_snapshot_source_changed', `workspace 文件校验时增长: ${relativePath}`)
      }
      verifiedHash.update(buffer.subarray(0, result.bytesRead))
    }
    const after = await sourceHandle.stat({ bigint: true })
    assertSameMetadata(opened, after, relativePath)
    if (copiedBytes !== verifiedBytes || copiedDigest !== verifiedHash.digest('hex')) {
      fail('workspace_snapshot_source_changed', `workspace 文件内容在复制期间发生变化: ${relativePath}`)
    }

    await destinationHandle.sync()
    await destinationHandle.chmod(0o400)
    context.state.totalBytes += copiedBytes
    context.state.manifest.push(Object.freeze({
      relativePath,
      bytes: copiedBytes,
      sha256: copiedDigest,
    }))
    recordSourceTreeEntry(context.state, Object.freeze({
      kind: 'file',
      relativePath,
      metadata: opened,
      bytes: copiedBytes,
      sha256: copiedDigest,
    }))
  } finally {
    await destinationHandle?.close().catch(() => undefined)
    await sourceHandle.close().catch(() => undefined)
  }
}

async function copyDirectory(
  sourcePath: string,
  destinationPath: string,
  metadata: BigIntStats,
  parts: readonly string[],
  context: CopyContext,
  sourceIsRootDescriptor = false,
): Promise<void> {
  const relativePath = relativeName(parts) || '.'
  if (!metadata.isDirectory()) {
    fail('workspace_snapshot_unsafe_entry', `workspace snapshot 只允许普通文件和目录: ${relativePath}`)
  }

  let directoryHandle: FileHandle | undefined
  let enumerationPath = sourcePath
  try {
    if (!sourceIsRootDescriptor) {
      directoryHandle = await openAnchoredDirectory(sourcePath, metadata, relativePath)
      if (process.platform === 'linux') enumerationPath = `/proc/self/fd/${directoryHandle.fd}`
    } else {
      const anchored = await stat(sourcePath, { bigint: true })
      assertSameMetadata(metadata, anchored, relativePath)
    }

    const names = await readDirectoryEntries(enumerationPath, context, parts.length + 1)
    for (const name of names) {
      assertControl(context.control)
      const childParts = [...parts, name]
      assertSafeLogicalPath(context.source, childParts)
      const childSource = join(enumerationPath, name)
      const childDestination = join(destinationPath, name)
      let childMetadata: BigIntStats
      try {
        childMetadata = await lstat(childSource, { bigint: true })
      } catch (error) {
        fail(
          'workspace_snapshot_source_changed',
          `workspace 目录项在复制前消失: ${relativeName(childParts)}`,
          error,
        )
      }
      if (childMetadata.isSymbolicLink()) {
        fail('workspace_snapshot_unsafe_entry', `workspace snapshot 拒绝 symlink: ${relativeName(childParts)}`)
      }
      if (childMetadata.isDirectory()) {
        await mkdir(childDestination, { mode: 0o700 })
        await copyDirectory(
          childSource,
          childDestination,
          childMetadata,
          childParts,
          context,
        )
      } else {
        await copyFile(childSource, childDestination, childMetadata, childParts, context)
      }
    }

    const after = directoryHandle
      ? await directoryHandle.stat({ bigint: true })
      : await stat(sourcePath, { bigint: true })
    assertSameMetadata(metadata, after, relativePath)
    // Darwin development/tests cannot enumerate through /proc/self/fd. The
    // retained directory handle proves the original inode stayed unchanged;
    // this pathname check additionally detects a rename/replacement that may
    // have redirected path-based enumeration. Linux production enumeration is
    // descriptor-relative and does not rely on this detection-only fallback.
    if (process.platform !== 'linux' && !sourceIsRootDescriptor) {
      const afterPath = await lstat(sourcePath, { bigint: true })
      assertSameMetadata(metadata, afterPath, relativePath)
    }
    recordSourceTreeEntry(context.state, Object.freeze({
      kind: 'directory',
      relativePath,
      metadata,
    }))
    await chmod(destinationPath, 0o500)
  } finally {
    await directoryHandle?.close().catch(() => undefined)
  }
}

function expectedSourceEntry<Kind extends SourceTreeManifestEntry['kind']>(
  context: CopyContext,
  state: VerificationState,
  parts: readonly string[],
  kind: Kind,
): Extract<SourceTreeManifestEntry, { kind: Kind }> {
  const relativePath = manifestName(parts)
  const expected = context.state.sourceTreeManifest.get(relativePath)
  if (expected?.kind !== kind || state.seen.has(relativePath)) {
    fail(
      'workspace_snapshot_source_changed',
      `workspace source entry set 在复制后发生变化: ${relativePath}`,
    )
  }
  state.seen.add(relativePath)
  return expected as Extract<SourceTreeManifestEntry, { kind: Kind }>
}

async function verifyCopiedFile(
  sourcePath: string,
  metadata: BigIntStats,
  parts: readonly string[],
  context: CopyContext,
  state: VerificationState,
) {
  const relativePath = relativeName(parts)
  const expected = expectedSourceEntry(context, state, parts, 'file')
  if (!metadata.isFile() || metadata.nlink !== 1n) {
    fail('workspace_snapshot_source_changed', `workspace 文件类型在复制后发生变化: ${relativePath}`)
  }
  assertSameMetadata(expected.metadata, metadata, relativePath)
  state.files += 1
  if (state.files > context.limits.maxFiles) {
    fail('workspace_snapshot_source_changed', 'workspace source 在全树复验时增加了过多文件')
  }

  let sourceHandle: FileHandle
  try {
    sourceHandle = await open(sourcePath, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
  } catch (error) {
    fail('workspace_snapshot_source_changed', `workspace 文件在全树复验时无法安全打开: ${relativePath}`, error)
  }
  try {
    const opened = await sourceHandle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n) {
      fail('workspace_snapshot_source_changed', `workspace 文件类型在全树复验时发生变化: ${relativePath}`)
    }
    assertSameMetadata(expected.metadata, opened, relativePath)

    const verifiedHash = createHash('sha256')
    let verifiedBytes = 0
    while (true) {
      assertControl(context.control)
      const remainingExpected = expected.bytes - verifiedBytes
      const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(1, remainingExpected + 1)))
      const result = await sourceHandle.read(buffer, 0, buffer.byteLength, verifiedBytes)
      if (result.bytesRead === 0) break
      verifiedBytes += result.bytesRead
      if (verifiedBytes > expected.bytes
        || verifiedBytes > context.limits.maxFileBytes
        || state.totalBytes + verifiedBytes > context.limits.maxTotalBytes) {
        fail('workspace_snapshot_source_changed', `workspace 文件在全树复验时增长: ${relativePath}`)
      }
      verifiedHash.update(buffer.subarray(0, result.bytesRead))
    }
    const after = await sourceHandle.stat({ bigint: true })
    assertSameMetadata(expected.metadata, after, relativePath)
    if (verifiedBytes !== expected.bytes || verifiedHash.digest('hex') !== expected.sha256) {
      fail('workspace_snapshot_source_changed', `workspace 文件内容在复制后发生变化: ${relativePath}`)
    }
    state.totalBytes += verifiedBytes
  } finally {
    await sourceHandle.close().catch(() => undefined)
  }
}

async function verifyCopiedDirectory(
  sourcePath: string,
  metadata: BigIntStats,
  parts: readonly string[],
  context: CopyContext,
  state: VerificationState,
  sourceIsRootDescriptor = false,
): Promise<void> {
  const relativePath = manifestName(parts)
  const expected = expectedSourceEntry(context, state, parts, 'directory')
  if (!metadata.isDirectory()) {
    fail('workspace_snapshot_source_changed', `workspace 目录类型在复制后发生变化: ${relativePath}`)
  }
  assertSameMetadata(expected.metadata, metadata, relativePath)

  let directoryHandle: FileHandle | undefined
  let enumerationPath = sourcePath
  try {
    if (!sourceIsRootDescriptor) {
      directoryHandle = await openAnchoredDirectory(sourcePath, expected.metadata, relativePath)
      if (process.platform === 'linux') enumerationPath = `/proc/self/fd/${directoryHandle.fd}`
    } else {
      const anchored = await stat(sourcePath, { bigint: true })
      assertSameMetadata(expected.metadata, anchored, relativePath)
    }

    const names = await readVerificationDirectoryEntries(
      enumerationPath,
      context,
      state,
      parts.length + 1,
    )
    for (const name of names) {
      assertControl(context.control)
      const childParts = [...parts, name]
      assertSafeLogicalPath(context.source, childParts)
      const childSource = join(enumerationPath, name)
      let childMetadata: BigIntStats
      try {
        childMetadata = await lstat(childSource, { bigint: true })
      } catch (error) {
        fail(
          'workspace_snapshot_source_changed',
          `workspace 目录项在全树复验时消失: ${relativeName(childParts)}`,
          error,
        )
      }
      if (childMetadata.isSymbolicLink()) {
        fail(
          'workspace_snapshot_source_changed',
          `workspace 目录项在全树复验时变为 symlink: ${relativeName(childParts)}`,
        )
      }
      if (childMetadata.isDirectory()) {
        await verifyCopiedDirectory(childSource, childMetadata, childParts, context, state)
      } else {
        await verifyCopiedFile(childSource, childMetadata, childParts, context, state)
      }
    }

    const after = directoryHandle
      ? await directoryHandle.stat({ bigint: true })
      : await stat(sourcePath, { bigint: true })
    assertSameMetadata(expected.metadata, after, relativePath)
    if (process.platform !== 'linux' && !sourceIsRootDescriptor) {
      const afterPath = await lstat(sourcePath, { bigint: true })
      assertSameMetadata(expected.metadata, afterPath, relativePath)
    }
  } finally {
    await directoryHandle?.close().catch(() => undefined)
  }
}

async function verifyCompleteSourceTree(
  rootMetadata: BigIntStats,
  context: CopyContext,
) {
  const state: VerificationState = {
    files: 0,
    entries: 0,
    totalBytes: 0,
    seen: new Set(),
  }
  await verifyCopiedDirectory(
    context.source.readPath,
    rootMetadata,
    [],
    context,
    state,
    context.source.rootKind === 'linux-proc-fd',
  )
  if (state.seen.size !== context.state.sourceTreeManifest.size
    || state.entries !== context.state.entries
    || state.files !== context.state.files
    || state.totalBytes !== context.state.totalBytes) {
    fail('workspace_snapshot_source_changed', 'workspace source entry set 在复制后发生变化')
  }
}

async function makeTreeRemovable(path: string): Promise<void> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return
  await chmod(path, 0o700)
  const directory = await opendir(path)
  try {
    for await (const entry of directory) {
      await makeTreeRemovable(join(path, entry.name))
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
}

function isExactSnapshotArtifactName(name: string) {
  return name.startsWith(SNAPSHOT_DIRECTORY_PREFIX)
    && SNAPSHOT_DIRECTORY_SUFFIX.test(name.slice(SNAPSHOT_DIRECTORY_PREFIX.length))
}

function hasExactMode(metadata: BigIntStats, mode: bigint) {
  return (metadata.mode & 0o777n) === mode
}

function hasPrivateDirectoryMode(metadata: BigIntStats) {
  return hasExactMode(metadata, 0o700n) || hasExactMode(metadata, 0o500n)
}

function hasPrivateFileMode(metadata: BigIntStats) {
  return hasExactMode(metadata, 0o600n) || hasExactMode(metadata, 0o400n)
}

function sameMetadata(left: BigIntStats, right: BigIntStats) {
  return stableFingerprint(left) === stableFingerprint(right)
}

async function createOwnerMarker(
  artifactRoot: string,
  artifactIdentity: string,
  ownerUid: number,
) {
  const encoded = Buffer.from(`${JSON.stringify({
    schema: SNAPSHOT_OWNER_SCHEMA,
    artifactIdentity,
    ownerUid,
  })}\n`)
  if (encoded.byteLength > MAX_OWNER_MARKER_BYTES) {
    fail('workspace_snapshot_staging_failed', 'workspace owner marker 超过内部大小限制')
  }
  let handle: FileHandle | undefined
  try {
    handle = await open(
      join(artifactRoot, SNAPSHOT_OWNER_MARKER),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    )
    let written = 0
    while (written < encoded.byteLength) {
      const result = await handle.write(encoded, written, encoded.byteLength - written, written)
      if (result.bytesWritten <= 0) {
        fail('workspace_snapshot_staging_failed', 'workspace owner marker 写入未取得进展')
      }
      written += result.bytesWritten
    }
    await handle.sync()
    await handle.chmod(0o400)
    const metadata = await handle.stat({ bigint: true })
    if (!metadata.isFile() || metadata.nlink !== 1n
      || metadata.uid !== BigInt(ownerUid) || !hasExactMode(metadata, 0o400n)
      || metadata.size !== BigInt(encoded.byteLength)) {
      fail('workspace_snapshot_staging_failed', 'workspace owner marker identity 或权限非法')
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readBoundedMarker(handle: FileHandle) {
  const buffer = Buffer.alloc(MAX_OWNER_MARKER_BYTES + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset > MAX_OWNER_MARKER_BYTES) return undefined
  return buffer.subarray(0, offset).toString('utf8')
}

async function hasValidOwnerMarker(
  markerPath: string,
  artifactIdentity: string,
  ownerUid: number,
) {
  let handle: FileHandle | undefined
  try {
    handle = await open(markerPath, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(ownerUid)
      || !hasExactMode(before, 0o400n) || before.size > BigInt(MAX_OWNER_MARKER_BYTES)) {
      return false
    }
    const raw = await readBoundedMarker(handle)
    const after = await handle.stat({ bigint: true })
    if (raw === undefined || !sameMetadata(before, after)) return false
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return keys.length === 3
      && keys[0] === 'artifactIdentity'
      && keys[1] === 'ownerUid'
      && keys[2] === 'schema'
      && record.schema === SNAPSHOT_OWNER_SCHEMA
      && record.artifactIdentity === artifactIdentity
      && record.ownerUid === ownerUid
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

interface StalePayloadVerificationState {
  files: number
  entries: number
  totalBytes: number
}

async function verifyStalePayloadFile(
  path: string,
  metadata: BigIntStats,
  ownerUid: bigint,
  limits: WorkspaceSnapshotLimits,
  state: StalePayloadVerificationState,
) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || metadata.uid !== ownerUid || !hasPrivateFileMode(metadata)) return false
  state.files += 1
  if (state.files > limits.maxFiles || metadata.size > BigInt(limits.maxFileBytes)
    || BigInt(state.totalBytes) + metadata.size > BigInt(limits.maxTotalBytes)) return false

  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
    const opened = await handle.stat({ bigint: true })
    if (!sameMetadata(metadata, opened)) return false
    const after = await handle.stat({ bigint: true })
    if (!sameMetadata(opened, after)) return false
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
  state.totalBytes += Number(metadata.size)
  return true
}

async function verifyStalePayloadDirectory(
  path: string,
  metadata: BigIntStats,
  ownerUid: bigint,
  limits: WorkspaceSnapshotLimits,
  control: WorkspaceSnapshotControl,
  state: StalePayloadVerificationState,
  depth: number,
): Promise<boolean> {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== ownerUid || !hasPrivateDirectoryMode(metadata)) return false

  let handle: FileHandle | undefined
  let directory: Awaited<ReturnType<typeof opendir>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (!sameMetadata(metadata, opened)) return false
    const enumerationPath = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path
    directory = await opendir(enumerationPath)
    while (true) {
      assertControl(control)
      const entry = await directory.read()
      if (!entry) break
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\0')) return false
      state.entries += 1
      const childDepth = depth + 1
      if (state.entries > limits.maxEntries || childDepth > limits.maxDepth) return false
      const childPath = join(enumerationPath, entry.name)
      const child = await lstat(childPath, { bigint: true })
      if (child.isSymbolicLink()) return false
      if (child.isDirectory()) {
        if (!await verifyStalePayloadDirectory(
          childPath,
          child,
          ownerUid,
          limits,
          control,
          state,
          childDepth,
        )) return false
      } else if (!await verifyStalePayloadFile(childPath, child, ownerUid, limits, state)) {
        return false
      }
    }
    const after = await handle.stat({ bigint: true })
    if (!sameMetadata(opened, after)) return false
    if (process.platform !== 'linux') {
      const afterPath = await lstat(path, { bigint: true })
      if (!sameMetadata(opened, afterPath)) return false
    }
    return true
  } catch (error) {
    if (error instanceof DOMException) throw error
    return false
  } finally {
    await directory?.close().catch(() => undefined)
    await handle?.close().catch(() => undefined)
  }
}

async function validStalePayloadIdentity(
  payloadPath: string,
  ownerUid: number,
  limits: WorkspaceSnapshotLimits,
  control: WorkspaceSnapshotControl,
) {
  const metadata = await lstat(payloadPath, { bigint: true })
  const state: StalePayloadVerificationState = { files: 0, entries: 0, totalBytes: 0 }
  if (!await verifyStalePayloadDirectory(
    payloadPath,
    metadata,
    BigInt(ownerUid),
    limits,
    control,
    state,
    0,
  )) return undefined
  return identity(metadata)
}

async function inspectStaleArtifact(
  path: string,
  metadata: BigIntStats,
  ownerUid: number,
  limits: WorkspaceSnapshotLimits,
  control: WorkspaceSnapshotControl,
) {
  let handle: FileHandle | undefined
  let directory: Awaited<ReturnType<typeof opendir>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (!sameMetadata(metadata, opened)) return undefined
    const enumerationPath = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path
    directory = await opendir(enumerationPath)
    const names: string[] = []
    while (names.length <= 2) {
      assertControl(control)
      const entry = await directory.read()
      if (!entry) break
      names.push(entry.name)
    }
    let result: { artifactIdentity: string; payloadIdentity: string | undefined }
    if (names.length === 0) {
      result = { artifactIdentity: identity(opened), payloadIdentity: undefined }
    } else {
      names.sort()
      if ((names.length !== 1 && names.length !== 2)
        || names[0] !== SNAPSHOT_OWNER_MARKER
        || (names.length === 2 && names[1] !== SNAPSHOT_PAYLOAD_DIRECTORY)) return undefined
      const artifactIdentity = identity(opened)
      if (!await hasValidOwnerMarker(
        join(enumerationPath, SNAPSHOT_OWNER_MARKER),
        artifactIdentity,
        ownerUid,
      )) return undefined
      if (names.length === 1) {
        result = { artifactIdentity, payloadIdentity: undefined }
      } else {
        const payloadIdentity = await validStalePayloadIdentity(
          join(enumerationPath, SNAPSHOT_PAYLOAD_DIRECTORY),
          ownerUid,
          limits,
          control,
        )
        if (payloadIdentity === undefined) return undefined
        result = { artifactIdentity, payloadIdentity }
      }
    }
    const after = await handle.stat({ bigint: true })
    if (!sameMetadata(opened, after)) return undefined
    if (process.platform !== 'linux') {
      const afterPath = await lstat(path, { bigint: true })
      if (!sameMetadata(opened, afterPath)) return undefined
    }
    return result
  } catch (error) {
    if (error instanceof DOMException) throw error
    return undefined
  } finally {
    await directory?.close().catch(() => undefined)
    await handle?.close().catch(() => undefined)
  }
}

async function removeOwnedStaging(
  path: string,
  expectedIdentity: string,
  expectedPayloadIdentity?: string,
) {
  let metadata
  try {
    metadata = await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || identity(metadata) !== expectedIdentity) {
    fail('workspace_snapshot_cleanup_failed', 'workspace staging identity 在清理前发生变化')
  }
  if (expectedPayloadIdentity !== undefined) {
    const payload = await lstat(join(path, SNAPSHOT_PAYLOAD_DIRECTORY), { bigint: true })
    if (!payload.isDirectory() || payload.isSymbolicLink()
      || identity(payload) !== expectedPayloadIdentity) {
      fail('workspace_snapshot_cleanup_failed', 'workspace payload identity 在清理前发生变化')
    }
  }
  await makeTreeRemovable(path)
  await rm(path, { recursive: true, force: true })
}

/**
 * Build a private, bounded, read-only user-space copy for one sandbox run.
 * This closes the mutable-source-to-sandbox window after the copy completes,
 * but it is deliberately not described as an atomic or kernel-level snapshot.
 */
export async function createWorkspaceSnapshot(
  source: WorkspaceSnapshotSource,
  options: WorkspaceSnapshotOptions,
): Promise<WorkspaceSnapshot> {
  validateInputs(source, options)
  assertControl(options.control)
  assertSafeLogicalPath(source, [])

  let rootMetadata: BigIntStats
  try {
    rootMetadata = await sourceRootMetadata(source)
  } catch (error) {
    if (error instanceof WorkspaceSnapshotError) throw error
    fail('workspace_snapshot_invalid_source', 'workspace snapshot source 无法读取', error)
  }
  if (!rootMetadata.isDirectory() || identity(rootMetadata) !== source.expectedIdentity) {
    fail('workspace_snapshot_invalid_source', 'workspace snapshot source identity 不匹配')
  }

  let stagingRoot: string | undefined
  let stagingIdentity: string | undefined
  let payloadRoot: string | undefined
  let payloadIdentity: string | undefined
  let stagingWriteRoot: string | undefined
  let artifactHandle: FileHandle | undefined
  let snapshotHandle: FileHandle | undefined
  try {
    const stagingParent = await realpath(options.stagingParent ?? tmpdir())
    if (isWithin(source.canonicalPath, stagingParent)) {
      fail('workspace_snapshot_staging_failed', 'workspace staging parent 不能位于 source 内部')
    }
    await assertTrustedStagingParent(stagingParent)
    const currentUid = process.getuid?.()
    if (currentUid === undefined) {
      fail('workspace_snapshot_staging_failed', '当前平台无法验证 workspace staging owner')
    }
    stagingRoot = await mkdtemp(join(stagingParent, SNAPSHOT_DIRECTORY_PREFIX))
    await chmod(stagingRoot, 0o700)
    const created = await lstat(stagingRoot, { bigint: true })
    if (!created.isDirectory() || created.isSymbolicLink()
      || created.uid !== BigInt(currentUid) || !hasExactMode(created, 0o700n)) {
      fail('workspace_snapshot_staging_failed', 'workspace staging root identity 或权限非法')
    }
    stagingIdentity = identity(created)
    artifactHandle = await open(stagingRoot, constants.O_RDONLY | DIRECTORY | NO_FOLLOW)
    const anchored = await artifactHandle.stat({ bigint: true })
    if (!anchored.isDirectory() || identity(anchored) !== stagingIdentity) {
      fail('workspace_snapshot_staging_failed', 'workspace staging root FD identity 不匹配')
    }
    const artifactWriteRoot = process.platform === 'linux'
      ? `/proc/self/fd/${artifactHandle.fd}`
      : stagingRoot
    await createOwnerMarker(artifactWriteRoot, stagingIdentity, currentUid)
    await mkdir(join(artifactWriteRoot, SNAPSHOT_PAYLOAD_DIRECTORY), { mode: 0o700 })
    payloadRoot = join(stagingRoot, SNAPSHOT_PAYLOAD_DIRECTORY)
    snapshotHandle = await open(
      join(artifactWriteRoot, SNAPSHOT_PAYLOAD_DIRECTORY),
      constants.O_RDONLY | DIRECTORY | NO_FOLLOW,
    )
    const payload = await snapshotHandle.stat({ bigint: true })
    if (!payload.isDirectory() || payload.isSymbolicLink()
      || payload.uid !== BigInt(currentUid) || !hasExactMode(payload, 0o700n)) {
      fail('workspace_snapshot_staging_failed', 'workspace payload identity 或权限非法')
    }
    payloadIdentity = identity(payload)
    stagingWriteRoot = process.platform === 'linux'
      ? `/proc/self/fd/${snapshotHandle.fd}`
      : payloadRoot
    await artifactHandle.close()
    artifactHandle = undefined
  } catch (error) {
    await artifactHandle?.close().catch(() => undefined)
    artifactHandle = undefined
    await snapshotHandle?.close().catch(() => undefined)
    snapshotHandle = undefined
    if (stagingRoot !== undefined) {
      await makeTreeRemovable(stagingRoot).catch(() => undefined)
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    if (error instanceof WorkspaceSnapshotError) throw error
    fail('workspace_snapshot_staging_failed', 'workspace staging 无法创建', error)
  }

  try {
    if (!snapshotHandle || !stagingWriteRoot || !payloadRoot || !payloadIdentity) {
      fail('workspace_snapshot_staging_failed', 'workspace staging FD 未建立')
    }
    const state: MutableSnapshotState = {
      files: 0,
      entries: 0,
      totalBytes: 0,
      manifest: [],
      sourceTreeManifest: new Map(),
    }
    const context: CopyContext = {
      source,
      stagingRoot: stagingWriteRoot,
      limits: options.limits,
      control: options.control,
      state,
      testHooks: options.testHooks,
    }
    await copyDirectory(
      source.readPath,
      stagingWriteRoot,
      rootMetadata,
      [],
      context,
      source.rootKind === 'linux-proc-fd',
    )
    await verifyCompleteSourceTree(rootMetadata, context)
    assertControl(options.control)
    const finalMetadata = await snapshotHandle.stat({ bigint: true })
    if (!finalMetadata.isDirectory() || identity(finalMetadata) !== payloadIdentity) {
      fail('workspace_snapshot_staging_failed', 'workspace payload identity 不匹配')
    }

    const ownedHandle = snapshotHandle
    snapshotHandle = undefined
    let cleanupPromise: Promise<void> | undefined
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        const errors: unknown[] = []
        try {
          await ownedHandle.close()
        } catch (error) {
          errors.push(error)
        }
        try {
          await removeOwnedStaging(stagingRoot, stagingIdentity, payloadIdentity)
        } catch (error) {
          errors.push(error)
        }
        if (errors.length > 0) {
          throw new WorkspaceSnapshotError(
            'workspace_snapshot_cleanup_failed',
            'workspace snapshot 清理失败',
            { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) },
          )
        }
      })()
      return cleanupPromise
    }

    return Object.freeze({
      rootPath: payloadRoot,
      descriptor: ownedHandle.fd,
      sourceIdentity: source.expectedIdentity,
      fileCount: state.files,
      entryCount: state.entries,
      totalBytes: state.totalBytes,
      manifest: Object.freeze([...state.manifest]),
      implementation: 'verified-user-space-copy' as const,
      cleanup,
    })
  } catch (error) {
    const cleanupErrors: unknown[] = []
    await snapshotHandle?.close().catch((cleanupError: unknown) => cleanupErrors.push(cleanupError))
    await removeOwnedStaging(stagingRoot, stagingIdentity, payloadIdentity)
      .catch((cleanupError: unknown) => cleanupErrors.push(cleanupError))
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'workspace snapshot 构建与清理均失败')
    }
    throw error
  }
}

/**
 * Reap crash leftovers only after an operator-chosen safety age. Active
 * callback-owned snapshots must always be younger than `minimumAgeMs`.
 */
export async function cleanupStaleWorkspaceSnapshots(
  options: StaleWorkspaceSnapshotCleanupOptions,
) {
  assertPositiveSafeInteger(options.minimumAgeMs, 'minimumAgeMs')
  const limits = options.limits ?? DEFAULT_STALE_SNAPSHOT_LIMITS
  validateLimits(limits)
  const now = options.now ?? Date.now()
  if (!Number.isFinite(now)) throw new TypeError('workspace snapshot cleanup now 必须是有限数字')
  assertControl(options.control)

  let stagingParent: string
  try {
    stagingParent = await realpath(options.stagingParent ?? tmpdir())
  } catch (error) {
    fail('workspace_snapshot_cleanup_failed', 'workspace staging parent 无法读取', error)
  }
  await assertTrustedStagingParent(stagingParent)
  const currentUid = process.getuid?.()
  if (currentUid === undefined) {
    fail('workspace_snapshot_cleanup_failed', '当前平台无法验证 stale workspace owner')
  }
  let removed = 0
  const directory = await opendir(stagingParent)
  try {
    while (true) {
      assertControl(options.control)
      const entry = await directory.read()
      if (!entry) break
      if (!isExactSnapshotArtifactName(entry.name)) continue
      const candidate = join(stagingParent, entry.name)
      let metadata: BigIntStats
      try {
        metadata = await lstat(candidate, { bigint: true })
      } catch {
        continue
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue
      if (metadata.uid !== BigInt(currentUid) || !hasExactMode(metadata, 0o700n)) continue
      if (now - Number(metadata.mtimeMs) < options.minimumAgeMs) continue
      const verified = await inspectStaleArtifact(
        candidate,
        metadata,
        currentUid,
        limits,
        options.control,
      )
      if (verified === undefined) continue
      await removeOwnedStaging(
        candidate,
        verified.artifactIdentity,
        verified.payloadIdentity,
      )
      removed += 1
    }
  } catch (error) {
    if (error instanceof WorkspaceSnapshotError || error instanceof DOMException) throw error
    fail('workspace_snapshot_cleanup_failed', 'workspace snapshot stale cleanup 失败', error)
  } finally {
    await directory.close().catch(() => undefined)
  }
  return removed
}

/** Keep the staging FD and directory alive for exactly one callback lifecycle. */
export async function withWorkspaceSnapshot<T>(
  source: WorkspaceSnapshotSource,
  options: WorkspaceSnapshotOptions,
  execute: (snapshot: WorkspaceSnapshot) => Promise<T>,
): Promise<T> {
  const snapshot = await createWorkspaceSnapshot(source, options)
  let result!: T
  let callbackFailed = false
  let callbackError: unknown
  try {
    result = await execute(snapshot)
  } catch (error) {
    callbackFailed = true
    callbackError = error
  }

  let cleanupFailed = false
  let cleanupError: unknown
  try {
    await snapshot.cleanup()
  } catch (error) {
    cleanupFailed = true
    cleanupError = error
  }

  if (callbackFailed && cleanupFailed) {
    throw new AggregateError(
      [callbackError, cleanupError],
      'workspace snapshot callback 与清理均失败',
    )
  }
  if (callbackFailed) throw callbackError
  if (cleanupFailed) throw cleanupError
  return result
}
