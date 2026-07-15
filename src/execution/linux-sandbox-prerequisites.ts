import { constants } from 'node:fs'
import { lstat, open, opendir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Stats } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { AsyncReadWriteLock } from '../core/async-rw-lock.js'
import { isSensitivePath } from '../security/sensitive-paths.js'

function isWithin(parent: string, child: string) {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

async function readTrimmed(path: string) {
  return (await readFile(path, 'utf8')).trim()
}

/**
 * Require the agent itself to already run in a bounded cgroup v2 subtree.
 * The bwrap child inherits this membership before it can execute or fork.
 */
export interface CgroupResourceLimits {
  readonly maxMemoryBytes: number
  readonly maxPids: number
  /** Maximum CPU quota normalized to one second; 1_000_000 equals one CPU. */
  readonly maxCpuMicrosPerSecond: number
}

function validResourceLimits(limits: CgroupResourceLimits) {
  return Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
}

export function cgroupValuesWithinLimits(
  memory: string,
  pids: string,
  cpu: string,
  limits: CgroupResourceLimits,
) {
  if (!validResourceLimits(limits) || memory === 'max' || pids === 'max') return false
  const cpuParts = cpu.trim().split(/\s+/)
  if (cpuParts.length !== 2) return false
  const [cpuQuota, cpuPeriod] = cpuParts
  if (cpuQuota === 'max') return false
  if (!/^\d+$/.test(memory) || !/^\d+$/.test(pids)
    || !cpuQuota || !cpuPeriod || !/^\d+$/.test(cpuQuota) || !/^\d+$/.test(cpuPeriod)) {
    return false
  }
  const memoryBytes = BigInt(memory)
  const processCount = BigInt(pids)
  const quota = BigInt(cpuQuota)
  const period = BigInt(cpuPeriod)
  if (memoryBytes <= 0n || processCount <= 0n || quota <= 0n || period <= 0n) return false
  return memoryBytes <= BigInt(limits.maxMemoryBytes)
    && processCount <= BigInt(limits.maxPids)
    && quota * 1_000_000n <= period * BigInt(limits.maxCpuMicrosPerSecond)
}

export async function verifyBoundedCgroupV2(
  cgroupRoot: string,
  limits: CgroupResourceLimits,
) {
  try {
    if (!validResourceLimits(limits)) return false
    const membership = (await readTrimmed('/proc/self/cgroup'))
      .split('\n')
      .find((line) => line.startsWith('0::'))
    if (!membership) return false
    const configured = await realpath(cgroupRoot)
    const current = await realpath(join('/sys/fs/cgroup', membership.slice(3)))
    if (!isWithin(configured, current)) return false

    await readTrimmed(join(current, 'cgroup.controllers'))
    const memory = await readTrimmed(join(current, 'memory.max'))
    const pids = await readTrimmed(join(current, 'pids.max'))
    const cpu = await readTrimmed(join(current, 'cpu.max'))
    if (!cgroupValuesWithinLimits(memory, pids, cpu, limits)) return false

    const processLimits = await readFile('/proc/self/limits', 'utf8')
    const nofile = processLimits.split('\n').find((line) => line.startsWith('Max open files'))
    if (!nofile) return false
    const values = nofile.slice('Max open files'.length).trim().split(/\s+/)
    const [soft, hard] = values
    if (!soft || !hard || !/^\d+$/.test(soft) || !/^\d+$/.test(hard)) return false
    return BigInt(soft) > 0n && BigInt(hard) > 0n && BigInt(hard) <= 4096n
  } catch {
    return false
  }
}

/**
 * The first sandbox lane inherits one bounded cgroup from the agent instead of
 * creating a per-operation child cgroup. Serializing every sandbox process is
 * therefore a security invariant, not a throughput optimization.
 */
export class SharedCgroupProcessGate {
  private readonly lock = new AsyncReadWriteLock()

  async run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    const release = await this.lock.acquireWrite(signal)
    try {
      return await execute()
    } finally {
      release()
    }
  }
}

const MAX_ROOTFS_ENTRIES = 200_000

function immutableMetadata(metadata: Stats) {
  return metadata.uid === 0 && (metadata.mode & 0o022) === 0
}

async function immutableAncestors(path: string) {
  const components = path.split('/').filter(Boolean)
  let current = '/'
  if (!immutableMetadata(await lstat(current))) return false
  for (const component of components) {
    current = join(current, component)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink() || !immutableMetadata(metadata)) return false
  }
  return true
}

/** Require a root-owned, non-group/world-writable tree without special files. */
export async function verifyImmutableRootfs(root: string) {
  if (process.getuid?.() === 0) return false
  let entries = 0
  const inspect = async (path: string, rootEntry = false): Promise<boolean> => {
    if (++entries > MAX_ROOTFS_ENTRIES) return false
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return !rootEntry && metadata.uid === 0
    if (!immutableMetadata(metadata)) return false
    if (metadata.isFile()) return true
    if (!metadata.isDirectory()) return false
    const directory = await opendir(path)
    try {
      for await (const entry of directory) {
        if (!await inspect(join(path, entry.name))) return false
      }
      return true
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
  try {
    return await inspect(root, true)
  } catch {
    return false
  }
}

export async function canonicalTrustedPath(
  path: string,
  kind: 'file' | 'directory',
  executable = false,
) {
  try {
    const canonical = await realpath(path)
    if (!await immutableAncestors(canonical)) return undefined
    const metadata = await lstat(canonical)
    if (kind === 'file' && (!metadata.isFile() || (executable && (metadata.mode & 0o111) === 0))) {
      return undefined
    }
    if (kind === 'directory' && !metadata.isDirectory()) return undefined
    return canonical
  } catch {
    return undefined
  }
}

/** Reject credentials, hardlinks and socket/device/FIFO entries before a read-only bind. */
export async function verifyReadOnlyWorkspace(root: string, followAnchoredRoot = false) {
  let entries = 0
  const inspect = async (path: string, rootEntry = false): Promise<boolean> => {
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
        if (!await inspect(join(path, entry.name))) return false
      }
      return true
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
  try {
    return await inspect(root, true)
  } catch {
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
): Promise<T> {
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
    throw new WorkspaceAnchorUnavailableError('workspace 无法安全打开', { cause: error })
  }
  try {
    let workspace: AnchoredReadOnlyWorkspace
    try {
      const descriptorPath = `/proc/self/fd/${handle.fd}`
      const before = await handle.stat()
      if (!before.isDirectory()) throw new Error('workspace 不是目录')
      const canonicalPath = await realpath(descriptorPath)
      const throughDescriptor = await stat(descriptorPath)
      const identity = metadataIdentity(before)
      if (metadataIdentity(throughDescriptor) !== identity
        || isSensitivePath(canonicalPath)
        || !await verifyReadOnlyWorkspace(descriptorPath, true)) {
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
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) return false
  try {
    const directory = await opendir(tmpdir())
    try {
      for await (const entry of directory) {
        if (!entry.name.startsWith('super-agent-sandbox-probe-')) continue
        const candidate = join(tmpdir(), entry.name)
        const metadata = await lstat(candidate)
        if (!metadata.isDirectory() || metadata.uid !== process.getuid?.()) continue
        if (now - metadata.mtimeMs < minimumAgeMs) continue
        await rm(candidate, { recursive: true, force: true })
      }
      return true
    } finally {
      await directory.close().catch(() => undefined)
    }
  } catch {
    return false
  }
}
