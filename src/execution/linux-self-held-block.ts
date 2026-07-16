import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  opendir,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeProcess } from './process-executor.js'

const BLOCK_DIRECTORY_PREFIX = 'super-agent-block-fd-'
const BLOCK_DIRECTORY_SUFFIX = /^[A-Za-z0-9]{6}$/

function isExactBlockDirectoryName(name: string) {
  return name.startsWith(BLOCK_DIRECTORY_PREFIX)
    && BLOCK_DIRECTORY_SUFFIX.test(name.slice(BLOCK_DIRECTORY_PREFIX.length))
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
) {
  return left.dev === right.dev && left.ino === right.ino
}

function hasExpectedDirectoryLinkCount(nlink: number) {
  // overlayfs commonly reports 1 while traditional Linux filesystems report 2
  // for a directory without subdirectories.
  return nlink === 1 || nlink === 2
}

export class SelfHeldBlockFdError extends Error {
  override readonly name = 'SelfHeldBlockFdError'
}

export async function cleanupStaleSelfHeldBlockDirectories(
  minimumAgeMs: number,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs <= 0 || !Number.isFinite(now)) {
    throw new TypeError('self-held block stale cleanup 参数非法')
  }
  const currentUid = process.getuid?.()
  if (currentUid === undefined) throw new SelfHeldBlockFdError('无法验证 stale block owner')
  const parent = tmpdir()
  const directory = await opendir(parent)
  let removed = 0
  try {
    for await (const entry of directory) {
      if (!isExactBlockDirectoryName(entry.name)) continue
      const candidate = join(parent, entry.name)
      const metadata = await lstat(candidate)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || metadata.uid !== currentUid || (metadata.mode & 0o777) !== 0o700
        || !hasExpectedDirectoryLinkCount(metadata.nlink)
        || now - metadata.mtimeMs < minimumAgeMs) continue
      const contents = await opendir(candidate)
      const names: string[] = []
      try {
        for await (const child of contents) names.push(child.name)
      } finally {
        await contents.close().catch(() => undefined)
      }
      if (names.length === 1 && names[0] === 'gate') {
        const gatePath = join(candidate, 'gate')
        const gate = await lstat(gatePath)
        if (!gate.isFIFO() || gate.isSymbolicLink() || gate.uid !== currentUid
          || gate.nlink !== 1 || (gate.mode & 0o777) !== 0o600) continue
        const gateBeforeUnlink = await lstat(gatePath)
        if (!sameIdentity(gate, gateBeforeUnlink) || !gateBeforeUnlink.isFIFO()
          || gateBeforeUnlink.nlink !== 1 || gateBeforeUnlink.uid !== currentUid
          || (gateBeforeUnlink.mode & 0o777) !== 0o600) continue
        await unlink(gatePath)
      } else if (names.length !== 0) {
        continue
      }
      const beforeRmdir = await lstat(candidate)
      if (!sameIdentity(metadata, beforeRmdir) || !beforeRmdir.isDirectory()
        || beforeRmdir.isSymbolicLink() || beforeRmdir.uid !== currentUid
        || !hasExpectedDirectoryLinkCount(beforeRmdir.nlink)
        || (beforeRmdir.mode & 0o777) !== 0o700) continue
      await rmdir(candidate)
      removed += 1
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return removed
}

/**
 * Create an anonymous O_RDWR FIFO and inherit that same open description as
 * bwrap's --block-fd. Because the blocked child owns a write reference too,
 * parent death cannot turn the read into EOF (which bwrap treats as release).
 */
export async function withSelfHeldBlockFd<T>(
  mkfifoPath: string,
  signal: AbortSignal,
  execute: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  if (process.platform !== 'linux') {
    throw new SelfHeldBlockFdError('self-held block FD 仅支持 Linux')
  }
  const directory = await mkdtemp(join(tmpdir(), BLOCK_DIRECTORY_PREFIX))
  await chmod(directory, 0o700)
  const fifoPath = join(directory, 'gate')
  let handle: FileHandle | undefined
  let result!: T
  let callbackError: unknown
  try {
    const created = await executeProcess({
      command: mkfifoPath,
      args: ['-m', '600', fifoPath],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      signal,
      timeoutMs: 2_000,
      maxOutputBytes: 16 * 1024,
    })
    if (created.terminationReason !== 'exited' || created.exitCode !== 0) {
      throw new SelfHeldBlockFdError('mkfifo 固定 helper 执行失败')
    }
    const before = await lstat(fifoPath, { bigint: true })
    const currentUid = process.getuid?.()
    if (!before.isFIFO() || before.nlink !== 1n
      || currentUid === undefined || before.uid !== BigInt(currentUid)
      || (before.mode & 0o077n) !== 0n) {
      throw new SelfHeldBlockFdError('block FIFO identity 或权限非法')
    }
    handle = await open(fifoPath, constants.O_RDWR | constants.O_NOFOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFIFO() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new SelfHeldBlockFdError('block FIFO 打开后 identity 不匹配')
    }
    // The inherited FD is now anonymous and cannot be swapped through a path.
    await unlink(fifoPath)
    result = await execute(handle)
  } catch (error) {
    callbackError = error
  }

  const cleanupErrors: unknown[] = []
  await handle?.close().catch((error: unknown) => cleanupErrors.push(error))
  await rm(directory, { recursive: true, force: true })
    .catch((error: unknown) => cleanupErrors.push(error))
  if (callbackError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [callbackError, ...cleanupErrors],
      'self-held block FD 执行与清理均失败',
    )
  }
  if (callbackError !== undefined) throw callbackError
  if (cleanupErrors.length > 0) {
    throw new SelfHeldBlockFdError('self-held block FD 清理失败', {
      cause: cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors),
    })
  }
  return result
}

export async function releaseSelfHeldBlockFd(handle: FileHandle) {
  const result = await handle.write(Buffer.from([1]), 0, 1, null)
  if (result.bytesWritten !== 1) {
    throw new SelfHeldBlockFdError('self-held block FD release byte 写入失败')
  }
}
