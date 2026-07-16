import { constants } from 'node:fs'
import {
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { isSensitivePath } from '../security/sensitive-paths.js'

const MAX_ROOTFS_ENTRIES = 200_000
const SANDBOX_PROBE_DIRECTORY = /^super-agent-sandbox-probe-[A-Za-z0-9]{6}$/
export const SANDBOX_WORKSPACE_PROBE_CONTENT = 'super-agent-workspace-helper-ok\n'

export interface SandboxPreflightControl {
  readonly signal: AbortSignal
  readonly deadline: number
}

function controlError(control: SandboxPreflightControl) {
  if (control.signal.aborted) {
    return control.signal.reason instanceof Error
      ? control.signal.reason
      : new DOMException('Sandbox preflight aborted', 'AbortError')
  }
  if (Date.now() >= control.deadline) {
    return new DOMException('Sandbox preflight deadline exceeded', 'TimeoutError')
  }
  return undefined
}

function assertPreflightControl(control?: SandboxPreflightControl) {
  if (!control) return
  if (!Number.isFinite(control.deadline) || control.deadline <= 0) {
    throw new TypeError('sandbox preflight deadline 必须是有限正数')
  }
  const error = controlError(control)
  if (error) throw error
}

function isPreflightControlError(error: unknown, control?: SandboxPreflightControl) {
  return control !== undefined && (control.signal.aborted
    || error instanceof DOMException
      && (error.name === 'AbortError' || error.name === 'TimeoutError'))
}

export function openFilesLimitWithinBound(value: string, maximumHardLimit: number) {
  if (!Number.isSafeInteger(maximumHardLimit) || maximumHardLimit <= 0) return false
  const line = value.split('\n').find((entry) => entry.startsWith('Max open files'))
  if (!line) return false
  const fields = line.slice('Max open files'.length).trim().split(/\s+/)
  const [soft, hard, units, ...extra] = fields
  if (!soft || !hard || !units || extra.length > 0
    || !/^\d+$/.test(soft) || !/^\d+$/.test(hard)) return false
  const softValue = BigInt(soft)
  const hardValue = BigInt(hard)
  return softValue > 0n
    && softValue <= hardValue
    && hardValue <= BigInt(maximumHardLimit)
}

/** cgroup v2 has no file-descriptor controller, so the launcher must bound RLIMIT_NOFILE. */
export async function verifyBoundedOpenFilesLimit(maximumHardLimit: number) {
  try {
    return openFilesLimitWithinBound(
      await readFile('/proc/self/limits', 'utf8'),
      maximumHardLimit,
    )
  } catch {
    return false
  }
}

function immutableMetadata(metadata: Stats) {
  return metadata.uid === 0 && (metadata.mode & 0o022) === 0
}

async function immutableAncestors(path: string, control?: SandboxPreflightControl) {
  assertPreflightControl(control)
  const components = path.split('/').filter(Boolean)
  let current = '/'
  if (!immutableMetadata(await lstat(current))) return false
  for (const component of components) {
    assertPreflightControl(control)
    current = join(current, component)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink() || !immutableMetadata(metadata)) return false
  }
  return true
}

/** Require a root-owned, non-group/world-writable tree without special files. */
export async function verifyImmutableRootfs(root: string, control?: SandboxPreflightControl) {
  assertPreflightControl(control)
  if (process.getuid?.() === 0) return false
  let entries = 0
  const inspect = async (path: string, rootEntry = false): Promise<boolean> => {
    assertPreflightControl(control)
    if (++entries > MAX_ROOTFS_ENTRIES) return false
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return !rootEntry && metadata.uid === 0
    if (!immutableMetadata(metadata)) return false
    if (metadata.isFile()) return true
    if (!metadata.isDirectory()) return false
    const directory = await opendir(path)
    try {
      for await (const entry of directory) {
        assertPreflightControl(control)
        if (!await inspect(join(path, entry.name))) return false
      }
      return true
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
  try {
    return await inspect(root, true)
  } catch (error) {
    if (isPreflightControlError(error, control)) throw error
    return false
  }
}

export async function canonicalTrustedPath(
  path: string,
  kind: 'file' | 'directory',
  executable = false,
  control?: SandboxPreflightControl,
) {
  try {
    assertPreflightControl(control)
    const canonical = await realpath(path)
    if (!await immutableAncestors(canonical, control)) return undefined
    assertPreflightControl(control)
    const metadata = await lstat(canonical)
    if (kind === 'file' && (!metadata.isFile() || (executable && (metadata.mode & 0o111) === 0))) {
      return undefined
    }
    if (kind === 'directory' && !metadata.isDirectory()) return undefined
    return canonical
  } catch (error) {
    if (isPreflightControlError(error, control)) throw error
    return undefined
  }
}

/** Reject credentials, hardlinks and socket/device/FIFO entries before a read-only bind. */
export async function verifyReadOnlyWorkspace(
  root: string,
  followAnchoredRoot = false,
  control?: SandboxPreflightControl,
) {
  assertPreflightControl(control)
  let entries = 0
  const inspect = async (path: string, rootEntry = false): Promise<boolean> => {
    assertPreflightControl(control)
    if (++entries > 100_000 || isSensitivePath(path, root) || isSensitivePath(path)) return false
    // /proc/self/fd/N is intentionally a magic symlink. Follow only that root;
    // nested workspace symlinks remain leaf entries and are never traversed.
    const metadata = rootEntry && followAnchoredRoot ? await stat(path) : await lstat(path)
    if (metadata.isSymbolicLink()) return true
    if (metadata.isFile()) return metadata.nlink === 1
    if (!metadata.isDirectory()) return false
    const directory = await opendir(path)
    try {
      for await (const entry of directory) {
        assertPreflightControl(control)
        if (!await inspect(join(path, entry.name))) return false
      }
      return true
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
  try {
    return await inspect(root, true)
  } catch (error) {
    if (isPreflightControlError(error, control)) throw error
    return false
  }
}

export interface AnchoredReadOnlyWorkspace {
  readonly descriptor: number
  readonly descriptorPath: string
  readonly canonicalPath: string
  readonly identity: string
}

export class WorkspaceAnchorUnavailableError extends Error {
  override readonly name = 'WorkspaceAnchorUnavailableError'
}

function metadataIdentity(metadata: Stats) {
  return `${metadata.dev}:${metadata.ino}`
}

/**
 * Anchor the workspace directory before inspection and keep that exact inode
 * open until the caller's spawn lifecycle completes. All inspection uses the
 * descriptor path; a concurrent rename or pathname replacement cannot change
 * what bwrap receives.
 */
export async function withReadOnlyWorkspaceFd<T>(
  path: string,
  execute: (workspace: AnchoredReadOnlyWorkspace) => Promise<T>,
  control?: SandboxPreflightControl,
): Promise<T> {
  assertPreflightControl(control)
  if (process.platform !== 'linux') {
    throw new WorkspaceAnchorUnavailableError('workspace FD anchor 仅支持 Linux')
  }
  let handle
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
  } catch (error) {
    if (isPreflightControlError(error, control)) throw error
    throw new WorkspaceAnchorUnavailableError('workspace 无法安全打开', { cause: error })
  }
  try {
    let workspace: AnchoredReadOnlyWorkspace
    try {
      const descriptorPath = `/proc/self/fd/${handle.fd}`
      assertPreflightControl(control)
      const before = await handle.stat()
      assertPreflightControl(control)
      if (!before.isDirectory()) throw new Error('workspace 不是目录')
      const canonicalPath = await realpath(descriptorPath)
      assertPreflightControl(control)
      const throughDescriptor = await stat(descriptorPath)
      const identity = metadataIdentity(before)
      if (metadataIdentity(throughDescriptor) !== identity
        || isSensitivePath(canonicalPath)
        || !await verifyReadOnlyWorkspace(descriptorPath, true, control)) {
        throw new Error('workspace FD anchor 校验失败')
      }
      const after = await handle.stat()
      if (metadataIdentity(after) !== identity) throw new Error('workspace identity changed')
      workspace = Object.freeze({
        descriptor: handle.fd,
        descriptorPath,
        canonicalPath,
        identity,
      })
    } catch (error) {
      if (isPreflightControlError(error, control)) throw error
      throw new WorkspaceAnchorUnavailableError('workspace FD anchor 校验失败', { cause: error })
    }
    // Callback errors may occur after spawn and must retain their uncertainty
    // semantics; never relabel them as a no-side-effect anchor failure.
    return await execute(workspace)
  } finally {
    await handle.close()
  }
}

export async function cleanupStaleSandboxProbeDirectories(
  minimumAgeMs = 60 * 60 * 1000,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0 || !Number.isFinite(now)) return false
  try {
    const parent = tmpdir()
    const directory = await opendir(parent)
    try {
      for await (const entry of directory) {
        if (!SANDBOX_PROBE_DIRECTORY.test(entry.name)) continue
        const candidate = join(parent, entry.name)
        const metadata = await lstat(candidate)
        if (!metadata.isDirectory() || metadata.isSymbolicLink()
          || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) continue
        if (now - metadata.mtimeMs < minimumAgeMs) continue
        const contents = await opendir(candidate)
        const names: string[] = []
        try {
          for await (const child of contents) names.push(child.name)
        } finally {
          await contents.close().catch(() => undefined)
        }
        if (names.length === 1 && names[0] === 'probe.txt') {
          const probePath = join(candidate, 'probe.txt')
          const probe = await lstat(probePath)
          if (!probe.isFile() || probe.isSymbolicLink() || probe.uid !== process.getuid?.()
            || probe.nlink !== 1 || (probe.mode & 0o077) !== 0
            || probe.size !== Buffer.byteLength(SANDBOX_WORKSPACE_PROBE_CONTENT)
            || await readFile(probePath, 'utf8') !== SANDBOX_WORKSPACE_PROBE_CONTENT) continue
          await unlink(probePath)
        } else if (names.length !== 0) {
          continue
        }
        const beforeRemove = await lstat(candidate)
        if (beforeRemove.dev !== metadata.dev || beforeRemove.ino !== metadata.ino) return false
        await rmdir(candidate)
      }
      return true
    } finally {
      await directory.close().catch(() => undefined)
    }
  } catch {
    return false
  }
}
