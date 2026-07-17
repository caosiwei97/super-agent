import {
  closeSync,
  constants,
  createReadStream,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { flockSync } from 'fs-ext'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const READ_CHUNK_BYTES = 64 * 1024

export interface SessionJournalFile {
  /** Present on Node's production FileHandle; trusted test adapters may omit it. */
  readonly fd?: number
  chmod(mode: number): Promise<void>
  truncate(length?: number): Promise<void>
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
  datasync(): Promise<void>
  close(): Promise<void>
  /** Production FileHandle methods; optional for trusted fault-injection adapters. */
  stat?(): Promise<Stats>
  read?(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
}

/** Minimal injectable boundary around journal I/O. Custom implementations are trusted test seams. */
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
    if (handle.read) {
      let position = 0
      while (true) {
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) return
        position += bytesRead
        yield buffer.subarray(0, bytesRead)
      }
    }
    if (this.io.readChunks) {
      for await (const chunk of this.io.readChunks(this.filePath)) yield chunk
      return
    }
    yield await this.io.readFile(this.filePath)
  }

  async truncate(length: number) {
    await this.assertSafe()
    await this.requireJournal().truncate(length)
    await this.assertSafe()
  }

  async write(buffer: Uint8Array, offset: number, length: number) {
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

  private async journalMetadata() {
    const handle = this.requireJournal()
    return handle.stat ? handle.stat() : lstatSync(this.filePath)
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
    if (handle.fd === undefined) return
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
    if (!this.journalLockHeld || handle.fd === undefined) return
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
      fchmodSync(lockFd, FILE_MODE)
      const after = fstatSync(lockFd)
      if (!sameIdentity(before, after) || !isPrivateFile(after)) {
        throw unsafeStorage('session lock inode 或 mode 不安全')
      }
      flockSync(lockFd, 'exnb')
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
