import {
  closeSync,
  constants,
  createReadStream,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  type Stats,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { flockSync } from 'fs-ext'
import { parseSessionFence } from './session-layout.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const READ_CHUNK_BYTES = 64 * 1024

export interface SessionJournalFile {
  /** Required so every adapter preserves the production descriptor/flock boundary. */
  readonly fd: number
  chmod(mode: number): Promise<void>
  truncate(length?: number): Promise<void>
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
  datasync(): Promise<void>
  close(): Promise<void>
  stat(): Promise<Stats>
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
}

/** Minimal injectable boundary around journal I/O. Adapters retain real descriptor operations. */
export interface SessionJournalIo {
  open(path: string, flags: number, mode: number): Promise<SessionJournalFile>
  readFile(path: string): Promise<Buffer>
  readChunks?(path: string): AsyncIterable<Uint8Array>
}

export const nodeSessionJournalIo: SessionJournalIo = Object.freeze({
  open: (path: string, flags: number, mode: number) => open(path, flags, mode),
  readFile: (path: string) => readFile(path),
  readChunks: (path: string) => createReadStream(path),
})

interface FileIdentity {
  readonly dev: number
  readonly ino: number
}

export type SessionFenceCommitPoint =
  | 'fence_locked'
  | 'fence_synced'
  | 'fence_renamed'
  | 'fence_verified'
  | 'parent_synced'
  | 'legacy_unlocked'

export type SessionFenceCommitProbe = (
  point: SessionFenceCommitPoint,
) => void | Promise<void>

interface ExtraSecondaryHandle {
  readonly handle: SessionJournalFile
  lockHeld: boolean
}

function sameIdentity(expected: FileIdentity, actual: FileIdentity) {
  return expected.dev === actual.dev && expected.ino === actual.ino
}

function isCurrentOwner(metadata: Stats) {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid()
}

function isPrivateFile(metadata: Stats) {
  return isOwnedSingleLinkFile(metadata) && (metadata.mode & 0o777) === FILE_MODE
}

function isOwnedSingleLinkFile(metadata: Stats) {
  return metadata.isFile() && metadata.nlink === 1 && isCurrentOwner(metadata)
}

function unsafeStorage(message: string, cause?: unknown) {
  const detail = `[Session] 存储安全校验失败: ${message}`
  return cause === undefined ? new Error(detail) : new Error(detail, { cause })
}

/**
 * Pins the legacy `<id>.lock` and `<id>.jsonl` inodes for one writer lifetime.
 * Store owns logical ordering; this lease owns path/inode validation and descriptor I/O.
 */
export class SessionFileLease {
  readonly filePath: string
  readonly lockPath: string

  private readonly directoryPath: string
  private journalExpectedPresent: boolean
  private journalIdentity: FileIdentity | undefined
  private directoryFd: number | undefined
  private directoryIdentity: FileIdentity | undefined
  private lockFd: number | undefined
  private lockIdentity: FileIdentity | undefined
  private journalHandle: SessionJournalFile | undefined
  private journalLockHeld = false
  private journalRole: 'legacy' | 'fence' = 'legacy'
  private readonly extraSecondaryHandles = new Set<ExtraSecondaryHandle>()

  constructor(
    directory: string,
    sessionId: string,
    private readonly io: SessionJournalIo = nodeSessionJournalIo,
  ) {
    this.directoryPath = resolve(directory)
    this.filePath = resolve(this.directoryPath, `${sessionId}.jsonl`)
    this.lockPath = resolve(this.directoryPath, `${sessionId}.lock`)
    mkdirSync(this.directoryPath, { recursive: true, mode: DIRECTORY_MODE })
    const initialJournal = this.pathMetadata(this.filePath)
    this.journalExpectedPresent = initialJournal !== undefined
    this.journalIdentity = initialJournal === undefined
      ? undefined
      : Object.freeze({ dev: initialJournal.dev, ino: initialJournal.ino })
    try {
      this.pinDirectory()
      this.acquireLock(sessionId, this.journalExpectedPresent)
      this.assertJournalSnapshot()
    } catch (error) {
      this.releaseLockIgnoringErrors()
      this.closeDirectoryIgnoringErrors()
      throw error
    }
  }

  exists() {
    this.assertJournalSnapshot()
    return this.journalExpectedPresent
  }

  hasOpenJournal() {
    return this.journalHandle !== undefined
  }

  async openJournal() {
    if (this.journalHandle) return
    this.assertLockInvariant()
    const expectedMetadata = this.assertJournalSnapshot()
    const noFollow = constants.O_NOFOLLOW ?? 0
    const creationFlags = this.journalExpectedPresent
      ? 0
      : constants.O_CREAT | constants.O_EXCL
    const handle = await this.io.open(
      this.filePath,
      constants.O_APPEND | constants.O_RDWR | noFollow | creationFlags,
      FILE_MODE,
    )
    this.journalHandle = handle
    try {
      const before = await this.journalMetadata()
      if (!isOwnedSingleLinkFile(before) ||
        (expectedMetadata !== undefined && !sameIdentity(expectedMetadata, before))) {
        throw unsafeStorage('session journal 类型、owner 或 nlink 无效')
      }
      this.acquireJournalLock(handle)
      await handle.chmod(FILE_MODE)
      const after = await this.journalMetadata()
      const pathMetadata = lstatSync(this.filePath)
      if (!sameIdentity(before, after) || !sameIdentity(after, pathMetadata) ||
        !isPrivateFile(after) || !isPrivateFile(pathMetadata)) {
        throw unsafeStorage('session journal inode 或 mode 不安全')
      }
      this.journalIdentity = Object.freeze({ dev: after.dev, ino: after.ino })
      this.journalExpectedPresent = true
      await this.assertSafe()
    } catch (error) {
      this.releaseJournalLockIgnoringErrors(handle)
      this.journalHandle = undefined
      try {
        await handle.close()
      } catch {
        // Preserve the validation error while ensuring the descriptor is not retained.
      }
      throw error
    }
  }

  async assertSafe() {
    this.assertLockInvariant()
    if (!this.journalHandle) return
    if (!this.journalIdentity) throw unsafeStorage('session journal identity 不可用')
    let descriptorMetadata: Stats
    let pathMetadata: Stats
    try {
      descriptorMetadata = await this.journalMetadata()
      pathMetadata = lstatSync(this.filePath)
    } catch (error) {
      throw unsafeStorage('session journal 丢失或无法校验', error)
    }
    if (!sameIdentity(this.journalIdentity, descriptorMetadata) ||
      !sameIdentity(this.journalIdentity, pathMetadata) ||
      !isPrivateFile(descriptorMetadata) || !isPrivateFile(pathMetadata)) {
      throw unsafeStorage('session journal inode 已被替换或属性已改变')
    }
  }

  async *readChunks(): AsyncIterable<Uint8Array> {
    await this.assertSafe()
    const handle = this.requireJournal()
    let position = 0
    while (true) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) return
      position += bytesRead
      yield buffer.subarray(0, bytesRead)
    }
  }

  async truncate(length: number) {
    this.assertLegacyJournal()
    await this.assertSafe()
    await this.requireJournal().truncate(length)
    await this.assertSafe()
  }

  async write(buffer: Uint8Array, offset: number, length: number) {
    this.assertLegacyJournal()
    await this.assertSafe()
    const result = await this.requireJournal().write(buffer, offset, length)
    await this.assertSafe()
    return result
  }

  async datasync() {
    await this.assertSafe()
    await this.requireJournal().datasync()
    await this.assertSafe()
  }

  /**
   * Marks an already-open canonical journal as the exact layout fence. Its
   * exclusive flock remains held until close().
   */
  async adoptJournalFence(expectedBytes: Uint8Array) {
    parseSessionFence(expectedBytes)
    await this.assertSafe()
    await this.assertExactHandleBytes(this.requireJournal(), expectedBytes)
    this.journalRole = 'fence'
  }

  /**
   * Atomically replaces the locked legacy journal path with a pre-locked fence.
   * The legacy and fence flocks overlap through parent-directory fsync. Any
   * extra handle retained by a failed probe is still released by close().
   */
  async commitJournalFence(
    fenceBytes: Uint8Array,
    probe: SessionFenceCommitProbe = () => undefined,
  ) {
    this.assertLegacyJournal()
    await this.assertSafe()
    parseSessionFence(fenceBytes)

    const legacyHandle = this.requireJournal()
    const noFollow = constants.O_NOFOLLOW ?? 0
    const tempPath = resolve(
      this.directoryPath,
      `.${this.filePath.slice(this.directoryPath.length + 1)}.${process.pid}.${randomUUID()}.fence.tmp`,
    )
    const fenceHandle = await this.io.open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
      FILE_MODE,
    )
    const extra: ExtraSecondaryHandle = { handle: fenceHandle, lockHeld: false }
    this.extraSecondaryHandles.add(extra)

    try {
      const before = await fenceHandle.stat()
      if (!isOwnedSingleLinkFile(before)) {
        throw unsafeStorage('storage fence temp 类型、owner 或 nlink 无效')
      }
      flockSync(fenceHandle.fd, 'exnb')
      extra.lockHeld = true
      await probe('fence_locked')
      await fenceHandle.chmod(FILE_MODE)
      const after = await fenceHandle.stat()
      const tempMetadata = lstatSync(tempPath)
      if (!sameIdentity(before, after) || !sameIdentity(after, tempMetadata) ||
        !isPrivateFile(after) || !isPrivateFile(tempMetadata)) {
        throw unsafeStorage('storage fence temp inode 或 mode 不安全')
      }

      await this.writeAll(fenceHandle, fenceBytes)
      await fenceHandle.datasync()
      await this.assertExactHandleBytes(fenceHandle, fenceBytes)
      await probe('fence_synced')

      // Revalidate both the fixed lock and the legacy descriptor immediately
      // before the one and only migration commit point.
      await this.assertSafe()
      renameSync(tempPath, this.filePath)

      const legacyExtra: ExtraSecondaryHandle = {
        handle: legacyHandle,
        lockHeld: this.journalLockHeld,
      }
      this.extraSecondaryHandles.add(legacyExtra)
      this.extraSecondaryHandles.delete(extra)
      this.journalHandle = fenceHandle
      this.journalLockHeld = extra.lockHeld
      this.journalIdentity = Object.freeze({ dev: after.dev, ino: after.ino })
      this.journalRole = 'fence'
      await probe('fence_renamed')

      await this.assertSafe()
      await this.assertExactHandleBytes(fenceHandle, fenceBytes)
      await probe('fence_verified')
      this.assertDirectoryInvariant()
      fsyncSync(this.requireDirectoryFd())
      await probe('parent_synced')

      await this.releaseExtraSecondary(legacyExtra)
      await probe('legacy_unlocked')
    } catch (error) {
      // State is intentionally retained. close() releases whichever side(s) of
      // the handoff were live at the injected/process failure boundary.
      throw error
    }
  }

  async close() {
    let closeError: unknown
    const handle = this.journalHandle
    this.journalHandle = undefined
    if (handle) {
      try {
        this.releaseJournalLock(handle)
      } catch (error) {
        closeError = error
      }
      try {
        await handle.close()
      } catch (error) {
        closeError ||= error
      }
    }
    for (const extra of [...this.extraSecondaryHandles]) {
      try {
        await this.releaseExtraSecondary(extra)
      } catch (error) {
        closeError ||= error
      }
    }
    try {
      this.releaseLock()
    } catch (error) {
      closeError ||= error
    }
    try {
      this.releaseDirectory()
    } catch (error) {
      closeError ||= error
    }
    if (closeError) throw closeError
  }

  private requireJournal() {
    if (!this.journalHandle) throw new Error('[Session] journal 尚未打开')
    return this.journalHandle
  }

  private requireDirectoryFd() {
    if (this.directoryFd === undefined) {
      throw unsafeStorage('session directory descriptor 不可用')
    }
    return this.directoryFd
  }

  private assertLegacyJournal() {
    if (this.journalRole !== 'legacy') {
      throw unsafeStorage('storage fence 不得作为 legacy journal 修改')
    }
  }

  private async journalMetadata() {
    const handle = this.requireJournal()
    return handle.stat()
  }

  private async writeAll(handle: SessionJournalFile, bytes: Uint8Array) {
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 ||
        bytesWritten > bytes.length - offset) {
        throw unsafeStorage('storage fence write 未取得有效进展')
      }
      offset += bytesWritten
    }
  }

  private async assertExactHandleBytes(handle: SessionJournalFile, expected: Uint8Array) {
    const metadata = await handle.stat()
    if (!isPrivateFile(metadata) || metadata.size !== expected.length) {
      throw unsafeStorage('storage fence descriptor 大小或属性无效')
    }
    const actual = Buffer.allocUnsafe(expected.length)
    let offset = 0
    while (offset < actual.length) {
      const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset)
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 ||
        bytesRead > actual.length - offset) {
        throw unsafeStorage('storage fence descriptor 无法完整读取')
      }
      offset += bytesRead
    }
    const eof = Buffer.allocUnsafe(1)
    const { bytesRead: trailingBytes } = await handle.read(eof, 0, 1, actual.length)
    if (trailingBytes !== 0 || !actual.equals(Buffer.from(expected))) {
      throw unsafeStorage('storage fence bytes 不匹配')
    }
  }

  private async releaseExtraSecondary(extra: ExtraSecondaryHandle) {
    if (!this.extraSecondaryHandles.delete(extra)) return
    let releaseError: unknown
    if (extra.lockHeld) {
      extra.lockHeld = false
      try {
        flockSync(extra.handle.fd, 'un')
      } catch (error) {
        releaseError = error
      }
    }
    try {
      await extra.handle.close()
    } catch (error) {
      releaseError ||= error
    }
    if (releaseError) throw releaseError
  }

  private assertJournalSnapshot() {
    const metadata = this.pathMetadata(this.filePath)
    if (!this.journalExpectedPresent) {
      if (metadata !== undefined) {
        throw unsafeStorage('session journal path 在获取 lock 后异常出现')
      }
      return undefined
    }
    if (metadata === undefined) {
      throw unsafeStorage('session journal path 在获取 lock 后消失')
    }
    if (this.journalIdentity === undefined ||
      !sameIdentity(this.journalIdentity, metadata) ||
      !isOwnedSingleLinkFile(metadata)) {
      throw unsafeStorage('session journal inode 已被替换或属性已改变')
    }
    return metadata
  }

  private acquireJournalLock(handle: SessionJournalFile) {
    try {
      flockSync(handle.fd, 'exnb')
      this.journalLockHeld = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EAGAIN' || code === 'EACCES' || code === 'EWOULDBLOCK') {
        throw new Error('[Session] session journal 已被其他活跃写者锁定', { cause: error })
      }
      throw error
    }
  }

  private releaseJournalLock(handle: SessionJournalFile) {
    if (!this.journalLockHeld) return
    this.journalLockHeld = false
    flockSync(handle.fd, 'un')
  }

  private releaseJournalLockIgnoringErrors(handle: SessionJournalFile) {
    try {
      this.releaseJournalLock(handle)
    } catch {
      // Preserve journal open/validation failure.
    }
  }

  private pinDirectory() {
    let directoryFd: number | undefined
    try {
      directoryFd = openSync(
        this.directoryPath,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      )
      const before = fstatSync(directoryFd)
      if (!before.isDirectory() || before.nlink < 1 || !isCurrentOwner(before)) {
        throw unsafeStorage('session directory 类型、owner 或 nlink 无效')
      }
      fchmodSync(directoryFd, DIRECTORY_MODE)
      const after = fstatSync(directoryFd)
      const pathMetadata = lstatSync(this.directoryPath)
      if (!sameIdentity(before, after) || !sameIdentity(after, pathMetadata) ||
        !after.isDirectory() || after.nlink < 1 || !isCurrentOwner(after) ||
        (after.mode & 0o777) !== DIRECTORY_MODE) {
        throw unsafeStorage('session directory inode 或 mode 不安全')
      }
      this.directoryFd = directoryFd
      this.directoryIdentity = Object.freeze({ dev: after.dev, ino: after.ino })
    } catch (error) {
      if (directoryFd !== undefined) {
        try {
          closeSync(directoryFd)
        } catch {
          // Preserve the validation error.
        }
      }
      throw error
    }
  }

  private acquireLock(sessionId: string, journalExists: boolean) {
    let lockFd: number | undefined
    try {
      this.assertDirectoryInvariant()
      const noFollow = constants.O_NOFOLLOW ?? 0
      const lockExists = this.pathEntryExists(this.lockPath)
      if (journalExists && !lockExists) {
        throw unsafeStorage('existing session journal 缺少固定 lock inode')
      }
      let expectedLock: Stats | undefined
      if (lockExists) {
        expectedLock = lstatSync(this.lockPath)
        if (!isOwnedSingleLinkFile(expectedLock)) {
          throw unsafeStorage('session lock 类型、owner 或 nlink 无效')
        }
        lockFd = openSync(this.lockPath, constants.O_RDWR | noFollow)
      } else {
        try {
          lockFd = openSync(
            this.lockPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
            FILE_MODE,
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          expectedLock = lstatSync(this.lockPath)
          if (!isOwnedSingleLinkFile(expectedLock)) {
            throw unsafeStorage('session lock 类型、owner 或 nlink 无效')
          }
          lockFd = openSync(this.lockPath, constants.O_RDWR | noFollow)
        }
      }
      const before = fstatSync(lockFd)
      if (!isOwnedSingleLinkFile(before) ||
        (expectedLock !== undefined && !sameIdentity(expectedLock, before))) {
        throw unsafeStorage('session lock 类型、owner 或 nlink 无效')
      }
      // A losing contender must not chmod an inode held by the current owner.
      flockSync(lockFd, 'exnb')
      fchmodSync(lockFd, FILE_MODE)
      const after = fstatSync(lockFd)
      if (!sameIdentity(before, after) || !isPrivateFile(after)) {
        throw unsafeStorage('session lock inode 或 mode 不安全')
      }
      this.lockFd = lockFd
      this.lockIdentity = Object.freeze({ dev: after.dev, ino: after.ino })
      this.assertLockInvariant()
    } catch (error) {
      try {
        if (lockFd !== undefined) closeSync(lockFd)
      } catch {
        // Preserve the acquisition error.
      }
      this.lockFd = undefined
      this.lockIdentity = undefined
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EAGAIN' || code === 'EACCES' || code === 'EWOULDBLOCK') {
        throw new Error(`[Session] session ${sessionId} 已被其他活跃写者锁定`, { cause: error })
      }
      throw error
    }
  }

  private pathEntryExists(path: string) {
    return this.pathMetadata(path) !== undefined
  }

  private pathMetadata(path: string) {
    try {
      return lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private assertDirectoryInvariant() {
    if (this.directoryFd === undefined || this.directoryIdentity === undefined) {
      throw unsafeStorage('session directory descriptor 不可用')
    }
    let descriptorMetadata: Stats
    let pathMetadata: Stats
    try {
      descriptorMetadata = fstatSync(this.directoryFd)
      pathMetadata = lstatSync(this.directoryPath)
    } catch (error) {
      throw unsafeStorage('session directory 丢失或无法校验', error)
    }
    if (!sameIdentity(this.directoryIdentity, descriptorMetadata) ||
      !sameIdentity(this.directoryIdentity, pathMetadata) ||
      !descriptorMetadata.isDirectory() || descriptorMetadata.nlink < 1 ||
      !isCurrentOwner(descriptorMetadata) ||
      (descriptorMetadata.mode & 0o777) !== DIRECTORY_MODE) {
      throw unsafeStorage('session directory 已被替换或权限已改变')
    }
  }

  private assertLockInvariant() {
    this.assertDirectoryInvariant()
    if (this.lockFd === undefined || this.lockIdentity === undefined) {
      throw unsafeStorage('session lock descriptor 不可用')
    }
    let descriptorMetadata: Stats
    let pathMetadata: Stats
    try {
      descriptorMetadata = fstatSync(this.lockFd)
      pathMetadata = lstatSync(this.lockPath)
    } catch (error) {
      throw unsafeStorage('session lock 丢失或无法校验', error)
    }
    if (!sameIdentity(this.lockIdentity, descriptorMetadata) ||
      !sameIdentity(this.lockIdentity, pathMetadata) ||
      !isPrivateFile(descriptorMetadata) || !isPrivateFile(pathMetadata)) {
      throw unsafeStorage('session lock inode 已被替换或属性已改变')
    }
  }

  private releaseLock() {
    if (this.lockFd === undefined) return
    const lockFd = this.lockFd
    let releaseError: unknown
    try {
      this.assertLockInvariant()
    } catch (error) {
      releaseError = error
    }
    this.lockFd = undefined
    this.lockIdentity = undefined
    try {
      flockSync(lockFd, 'un')
    } catch (error) {
      releaseError ||= error
    }
    try {
      closeSync(lockFd)
    } catch (error) {
      releaseError ||= error
    }
    if (releaseError) throw releaseError
  }

  private releaseDirectory() {
    if (this.directoryFd === undefined) return
    const directoryFd = this.directoryFd
    this.directoryFd = undefined
    this.directoryIdentity = undefined
    closeSync(directoryFd)
  }

  private closeDirectoryIgnoringErrors() {
    try {
      this.releaseDirectory()
    } catch {
      // Preserve constructor failure.
    }
  }

  private releaseLockIgnoringErrors() {
    try {
      this.releaseLock()
    } catch {
      // Preserve constructor failure while still closing the lock descriptor.
    }
  }
}
