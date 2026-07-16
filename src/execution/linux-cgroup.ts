import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rmdir,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

const CGROUP2_SUPER_MAGIC = 0x63677270
const CPU_PERIOD_MICROS = 1_000_000
const REQUIRED_CONTROLLERS = Object.freeze(['cpu', 'memory', 'pids'] as const)
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIRECTORY_NAME_PATTERN = /^super-agent-op-[a-f0-9]{16}-[a-f0-9]{32}$/

export interface LinuxCgroupLimits {
  readonly maxMemoryBytes: number
  readonly maxSwapBytes: number
  readonly maxPids: number
  /** Maximum CPU quota normalized to one second; 1_000_000 equals one CPU. */
  readonly maxCpuMicrosPerSecond: number
}

/**
 * Filesystem boundary used by the manager. Supplying this is a test seam; a
 * production caller should use the kernel-backed default implementation.
 */
export interface LinuxCgroupFileSystem {
  realpath(path: string): Promise<string>
  identity(path: string): Promise<string>
  statFsType(path: string): Promise<number>
  read(path: string): Promise<string>
  write(path: string, value: string): Promise<void>
  mkdir(path: string): Promise<void>
  list(path: string): Promise<readonly string[]>
  rmdir(path: string): Promise<void>
  randomId(): string
  now(): number
  sleep(milliseconds: number): Promise<void>
}

export interface LinuxCgroupManagerOptions {
  readonly root: string
  readonly limits: LinuxCgroupLimits
  readonly cleanupTimeoutMs?: number
  readonly cleanupPollMs?: number
  /** Test seam only. Production construction must omit it. */
  readonly platform?: NodeJS.Platform
  /** Test seam only. Production construction must omit it. */
  readonly fileSystem?: LinuxCgroupFileSystem
}

export class LinuxCgroupUnavailableError extends Error {
  override readonly name = 'LinuxCgroupUnavailableError'

  constructor(readonly reasonCode: string, options?: ErrorOptions) {
    super(`per-operation cgroup 不可用: ${reasonCode}`, options)
  }
}

export class LinuxCgroupLifecycleError extends Error {
  override readonly name = 'LinuxCgroupLifecycleError'

  constructor(readonly reasonCode: string, options?: ErrorOptions) {
    super(`per-operation cgroup 生命周期失败: ${reasonCode}`, options)
  }
}

export class LinuxCgroupSafetyError extends Error {
  override readonly name = 'LinuxCgroupSafetyError'
}

const DEFAULT_FILE_SYSTEM: LinuxCgroupFileSystem = Object.freeze({
  realpath,
  async identity(path: string) {
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new LinuxCgroupSafetyError('cgroup path 不是普通目录')
    }
    return `${metadata.dev}:${metadata.ino}`
  },
  async statFsType(path: string) {
    return Number((await statfs(path)).type)
  },
  async read(path: string) {
    return readFile(path, 'utf8')
  },
  async write(path: string, value: string) {
    await writeFile(path, value, 'utf8')
  },
  async mkdir(path: string) {
    await mkdir(path, { mode: 0o700 })
  },
  async list(path: string) {
    const directory = await opendir(path)
    const names: string[] = []
    try {
      for await (const entry of directory) names.push(entry.name)
    } finally {
      await directory.close().catch(() => undefined)
    }
    return names
  },
  async rmdir(path: string) {
    await rmdir(path)
  },
  randomId() {
    return randomUUID().replaceAll('-', '')
  },
  now: Date.now,
  async sleep(milliseconds: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  },
})

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('cgroup operation aborted', 'AbortError')
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortReason(signal)
}

function parseWords(value: string) {
  return new Set(value.trim().split(/\s+/).filter(Boolean))
}

function parsePids(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return []
  return trimmed.split(/\s+/).map((entry) => {
    if (!/^\d+$/.test(entry)) {
      throw new LinuxCgroupLifecycleError('cgroup_procs_malformed')
    }
    const pid = Number(entry)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new LinuxCgroupLifecycleError('cgroup_procs_malformed')
    }
    return pid
  })
}

function validateLimits(limits: LinuxCgroupLimits) {
  const positive = [
    limits.maxMemoryBytes,
    limits.maxPids,
    limits.maxCpuMicrosPerSecond,
  ].every((value) => Number.isSafeInteger(value) && value > 0)
  if (!positive || !Number.isSafeInteger(limits.maxSwapBytes) || limits.maxSwapBytes < 0) {
    throw new TypeError('cgroup limits 必须是安全整数，swap 可为 0，其余必须为正数')
  }
  return Object.freeze({ ...limits })
}

function boundedValueAllows(parent: string, requested: number) {
  const value = parent.trim()
  if (value === 'max') return true
  return /^\d+$/.test(value) && BigInt(requested) <= BigInt(value)
}

function cpuValueAllows(parent: string, requestedMicrosPerSecond: number) {
  const [quota, period, ...extra] = parent.trim().split(/\s+/)
  if (!quota || !period || extra.length > 0 || !/^\d+$/.test(period)) return false
  if (quota === 'max') return true
  if (!/^\d+$/.test(quota)) return false
  const parentPeriod = BigInt(period)
  return parentPeriod > 0n
    && BigInt(requestedMicrosPerSecond) * parentPeriod
      <= BigInt(quota) * BigInt(CPU_PERIOD_MICROS)
}

function childPath(root: string, name: string) {
  if (!DIRECTORY_NAME_PATTERN.test(name)) {
    throw new LinuxCgroupSafetyError('cgroup directory name 非法')
  }
  const path = join(root, name)
  const fromRoot = relative(root, path)
  if (fromRoot !== name || fromRoot.includes('/') || fromRoot.includes('\\')) {
    throw new LinuxCgroupSafetyError('cgroup path 越界')
  }
  return path
}

/** Owns a delegated, process-free cgroup v2 root. */
export class LinuxCgroupManager {
  private readonly active = new Set<LinuxOperationCgroup>()
  private closed = false

  private constructor(
    readonly root: string,
    readonly limits: LinuxCgroupLimits,
    private readonly rootIdentity: string,
    private readonly fileSystem: LinuxCgroupFileSystem,
    private readonly cleanupTimeoutMs: number,
    private readonly cleanupPollMs: number,
  ) {}

  static async initialize(options: LinuxCgroupManagerOptions) {
    const platform = options.platform ?? process.platform
    if (platform !== 'linux') {
      throw new LinuxCgroupUnavailableError('platform_unsupported')
    }
    if (!isAbsolute(options.root)) throw new TypeError('cgroup root 必须是绝对路径')
    const limits = validateLimits(options.limits)
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000
    const cleanupPollMs = options.cleanupPollMs ?? 10
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0
      || !Number.isSafeInteger(cleanupPollMs) || cleanupPollMs <= 0
      || cleanupPollMs > cleanupTimeoutMs) {
      throw new TypeError('cgroup cleanup 时间参数非法')
    }

    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM
    let root: string
    let identity: string
    try {
      root = await fileSystem.realpath(options.root)
      identity = await fileSystem.identity(root)
      if (await fileSystem.statFsType(root) !== CGROUP2_SUPER_MAGIC) {
        throw new LinuxCgroupUnavailableError('not_cgroup_v2')
      }
      if ((await fileSystem.read(join(root, 'cgroup.type'))).trim() !== 'domain') {
        throw new LinuxCgroupUnavailableError('delegation_not_domain')
      }
      if (parsePids(await fileSystem.read(join(root, 'cgroup.procs'))).length > 0) {
        // The manager never owns or kills the delegation root. Requiring a
        // process-free root also satisfies cgroup v2's no-internal-process rule.
        throw new LinuxCgroupUnavailableError('delegation_root_has_processes')
      }
      const available = parseWords(await fileSystem.read(join(root, 'cgroup.controllers')))
      if (REQUIRED_CONTROLLERS.some((controller) => !available.has(controller))) {
        throw new LinuxCgroupUnavailableError('controllers_unavailable')
      }
      if (!boundedValueAllows(
        await fileSystem.read(join(root, 'memory.max')),
        limits.maxMemoryBytes,
      ) || !boundedValueAllows(
        await fileSystem.read(join(root, 'memory.swap.max')),
        limits.maxSwapBytes,
      ) || !boundedValueAllows(
        await fileSystem.read(join(root, 'pids.max')),
        limits.maxPids,
      ) || !cpuValueAllows(
        await fileSystem.read(join(root, 'cpu.max')),
        limits.maxCpuMicrosPerSecond,
      )) {
        throw new LinuxCgroupUnavailableError('limits_exceed_delegation')
      }

      // Always perform the write, even if already enabled. A successful write
      // validates that the caller actually owns subtree controller delegation.
      await fileSystem.write(
        join(root, 'cgroup.subtree_control'),
        REQUIRED_CONTROLLERS.map((controller) => `+${controller}`).join(' '),
      )
      const enabled = parseWords(await fileSystem.read(join(root, 'cgroup.subtree_control')))
      if (REQUIRED_CONTROLLERS.some((controller) => !enabled.has(controller))) {
        throw new LinuxCgroupUnavailableError('controllers_not_delegated')
      }

      // This delegated root is exclusive to one Agent generation. Empty
      // operation directories can remain after a supervised crash and are
      // safe to reap; a populated or malformed reserved directory is never
      // killed merely because its name has our prefix.
      for (const name of await fileSystem.list(root)) {
        if (!name.startsWith('super-agent-op-')) continue
        if (!DIRECTORY_NAME_PATTERN.test(name)) {
          throw new LinuxCgroupUnavailableError('stale_operation_name_invalid')
        }
        const path = childPath(root, name)
        if (await fileSystem.realpath(path) !== path) {
          throw new LinuxCgroupUnavailableError('stale_operation_identity_invalid')
        }
        await fileSystem.identity(path)
        const members = parsePids(await fileSystem.read(join(path, 'cgroup.procs')))
        const events = await fileSystem.read(join(path, 'cgroup.events'))
        const populated = events.split('\n').find((line) => line.startsWith('populated '))
        if (!populated || !/^populated [01]$/.test(populated.trim())) {
          throw new LinuxCgroupUnavailableError('stale_operation_events_invalid')
        }
        if (members.length > 0 || populated.trim() !== 'populated 0') {
          throw new LinuxCgroupUnavailableError('stale_operation_populated')
        }
        try {
          await fileSystem.rmdir(path)
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            throw new LinuxCgroupUnavailableError('stale_operation_cleanup_failed', { cause: error })
          }
        }
      }
    } catch (error) {
      if (error instanceof LinuxCgroupUnavailableError) throw error
      throw new LinuxCgroupUnavailableError('delegation_unusable', { cause: error })
    }

    return new LinuxCgroupManager(
      root,
      limits,
      identity,
      fileSystem,
      cleanupTimeoutMs,
      cleanupPollMs,
    )
  }

  async createOperation(operationId: string, signal: AbortSignal) {
    if (this.closed) throw new LinuxCgroupLifecycleError('manager_closed')
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new TypeError('operationId 只能包含安全的 ASCII 标识字符且长度不超过 128')
    }
    throwIfAborted(signal)
    await this.assertRootIdentity()
    const enabled = parseWords(await this.fileSystem.read(join(this.root, 'cgroup.subtree_control')))
    if (REQUIRED_CONTROLLERS.some((controller) => !enabled.has(controller))) {
      throw new LinuxCgroupLifecycleError('delegation_changed')
    }

    const digest = createHash('sha256').update(operationId).digest('hex').slice(0, 16)
    let path: string | undefined
    for (let attempt = 0; attempt < 4 && !path; attempt++) {
      const nonce = this.fileSystem.randomId().toLowerCase()
      if (!/^[a-f0-9]{32}$/.test(nonce)) {
        throw new LinuxCgroupSafetyError('cgroup random id 非法')
      }
      const candidate = childPath(this.root, `super-agent-op-${digest}-${nonce}`)
      try {
        await this.fileSystem.mkdir(candidate)
        path = candidate
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
    }
    if (!path) throw new LinuxCgroupLifecycleError('operation_name_collision')

    let group: LinuxOperationCgroup | undefined
    try {
      const canonical = await this.fileSystem.realpath(path)
      if (canonical !== path) throw new LinuxCgroupSafetyError('operation cgroup 被路径替换')
      const identity = await this.fileSystem.identity(path)
      group = new LinuxOperationCgroup(
        path,
        this.limits,
        identity,
        this.fileSystem,
        this.cleanupTimeoutMs,
        this.cleanupPollMs,
        () => this.active.delete(group!),
      )
      await group.configure()
      throwIfAborted(signal)
      if (this.closed) throw new LinuxCgroupLifecycleError('manager_closed')
      this.active.add(group)
      return group
    } catch (error) {
      if (!group) {
        await this.fileSystem.rmdir(path).catch(() => undefined)
        throw error
      }
      try {
        await group.cleanup()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'cgroup 创建与回收均失败')
      }
      throw error
    }
  }

  async withOperation<T>(
    operationId: string,
    signal: AbortSignal,
    execute: (group: LinuxOperationCgroup) => Promise<T>,
  ): Promise<T> {
    const group = await this.createOperation(operationId, signal)
    try {
      throwIfAborted(signal)
      const result = await execute(group)
      await group.cleanup()
      return result
    } catch (error) {
      try {
        await group.cleanup()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'cgroup operation 与回收均失败')
      }
      throw error
    }
  }

  async close() {
    this.closed = true
    const results = await Promise.allSettled([...this.active].map((group) => group.cleanup()))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, '部分 operation cgroup 回收失败')
  }

  private async assertRootIdentity() {
    try {
      if (await this.fileSystem.realpath(this.root) !== this.root
        || await this.fileSystem.identity(this.root) !== this.rootIdentity) {
        throw new LinuxCgroupSafetyError('delegation root identity changed')
      }
    } catch (error) {
      if (error instanceof LinuxCgroupSafetyError) throw error
      throw new LinuxCgroupSafetyError('delegation root unavailable', { cause: error })
    }
  }
}

type OperationState = 'configuring' | 'configured' | 'attaching' | 'attached' | 'failed'
  | 'cleaning' | 'closed'

export class LinuxOperationCgroup {
  private state: OperationState = 'configuring'
  private cleanupPromise?: Promise<void>
  private readonly abortBindings = new Map<AbortSignal, () => void>()
  private readonly pendingKills = new Set<Promise<void>>()

  constructor(
    readonly path: string,
    readonly limits: LinuxCgroupLimits,
    private readonly identity: string,
    private readonly fileSystem: LinuxCgroupFileSystem,
    private readonly cleanupTimeoutMs: number,
    private readonly cleanupPollMs: number,
    private readonly onClosed: () => void,
  ) {}

  async configure() {
    if (this.state !== 'configuring') throw new LinuxCgroupLifecycleError('already_configured')
    await this.assertIdentity()
    const values = Object.freeze({
      // Keep every member directly observable in this cgroup. No nested
      // subtree can hide a protected process from the safety check in kill().
      'cgroup.max.depth': '0',
      'cgroup.max.descendants': '0',
      'memory.max': String(this.limits.maxMemoryBytes),
      'memory.swap.max': String(this.limits.maxSwapBytes),
      'memory.oom.group': '1',
      'pids.max': String(this.limits.maxPids),
      'cpu.max': `${this.limits.maxCpuMicrosPerSecond} ${CPU_PERIOD_MICROS}`,
    })
    try {
      for (const [file, value] of Object.entries(values)) {
        const target = join(this.path, file)
        await this.fileSystem.write(target, value)
        if ((await this.fileSystem.read(target)).trim() !== value) {
          throw new LinuxCgroupLifecycleError(`limit_readback_mismatch:${file}`)
        }
      }
      const initialMembers = parsePids(await this.fileSystem.read(join(this.path, 'cgroup.procs')))
      if (initialMembers.length > 0) {
        throw new LinuxCgroupSafetyError('新建 operation cgroup 非空')
      }
      await this.fileSystem.read(join(this.path, 'cgroup.events'))
      // Probe the required recursive kill primitive while the new scope is
      // guaranteed empty, so cleanup support fails before any target attaches.
      await this.fileSystem.write(join(this.path, 'cgroup.kill'), '1')
      this.state = 'configured'
    } catch (error) {
      this.state = 'failed'
      if (error instanceof LinuxCgroupLifecycleError || error instanceof LinuxCgroupSafetyError) {
        throw error
      }
      throw new LinuxCgroupLifecycleError('configuration_failed', { cause: error })
    }
  }

  /**
   * Attach and read back the bwrap child while its target is still blocked.
   *
   * `pid` must come from bwrap child fd 5 (`--info-fd`) while child fd 6
   * (`--block-fd`) is still held by the parent. The caller may release fd 6
   * only after this method resolves. On failure it must terminate the outer
   * bwrap monitor without releasing the target. A plain spawn-then-attach flow
   * without this pre-exec block has an escape window and is not supported.
   */
  async attachAndVerify(pid: number, signal: AbortSignal) {
    if (this.state !== 'configured') throw new LinuxCgroupLifecycleError('attach_state_invalid')
    this.validateTargetPid(pid)
    this.state = 'attaching'
    let abortBindingInstalled = false
    try {
      throwIfAborted(signal)
      await this.assertIdentity()
      await this.fileSystem.write(join(this.path, 'cgroup.procs'), String(pid))
      const members = parsePids(await this.fileSystem.read(join(this.path, 'cgroup.procs')))
      if (members.length !== 1 || members[0] !== pid) {
        throw new LinuxCgroupLifecycleError('attach_membership_unconfirmed')
      }
      this.bindAbort(signal)
      abortBindingInstalled = true
      throwIfAborted(signal)
      this.state = 'attached'
    } catch (error) {
      this.state = 'failed'
      if (abortBindingInstalled) this.unbindAbort(signal)
      const failures: unknown[] = [error]
      await this.kill().catch((killError: unknown) => failures.push(killError))
      if (failures.length > 1) {
        throw new AggregateError(failures, 'cgroup attach 验证与终止均失败')
      }
      throw error
    }
  }

  async kill() {
    if (this.state === 'closed') return
    await this.assertIdentity()
    const members = parsePids(await this.fileSystem.read(join(this.path, 'cgroup.procs')))
    const protectedPids = new Set([1, process.pid, process.ppid])
    if (members.some((pid) => protectedPids.has(pid))) {
      throw new LinuxCgroupSafetyError('拒绝终止包含 Agent/父进程的 cgroup')
    }
    if (members.length > 0) {
      // cgroup.kill targets only this owned child subtree. Never signal the
      // delegation root or enumerate-and-kill arbitrary host PIDs.
      await this.fileSystem.write(join(this.path, 'cgroup.kill'), '1')
    }
  }

  cleanup(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve()
    this.cleanupPromise ??= this.cleanupOnce().catch((error: unknown) => {
      this.cleanupPromise = undefined
      throw error
    })
    return this.cleanupPromise
  }

  private async cleanupOnce() {
    this.state = 'cleaning'
    for (const [signal, listener] of this.abortBindings) {
      signal.removeEventListener('abort', listener)
    }
    this.abortBindings.clear()
    await Promise.allSettled([...this.pendingKills])
    const deadline = this.fileSystem.now() + this.cleanupTimeoutMs
    while (true) {
      try {
        await this.assertIdentity()
        await this.kill()
        if (!await this.isPopulated()) {
          try {
            await this.fileSystem.rmdir(this.path)
            this.state = 'closed'
            this.onClosed()
            return
          } catch (error) {
            if (errorCode(error) === 'ENOENT') {
              this.state = 'closed'
              this.onClosed()
              return
            }
            if (!['EBUSY', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error
          }
        }
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          this.state = 'closed'
          this.onClosed()
          return
        }
        this.state = 'failed'
        throw error
      }
      if (this.fileSystem.now() >= deadline) {
        this.state = 'failed'
        throw new LinuxCgroupLifecycleError('cleanup_timeout')
      }
      await this.fileSystem.sleep(this.cleanupPollMs)
    }
  }

  private async isPopulated() {
    const events = await this.fileSystem.read(join(this.path, 'cgroup.events'))
    const populated = events.split('\n').find((line) => line.startsWith('populated '))
    if (!populated || !/^populated [01]$/.test(populated.trim())) {
      throw new LinuxCgroupLifecycleError('cgroup_events_malformed')
    }
    return populated.trim() === 'populated 1'
      || parsePids(await this.fileSystem.read(join(this.path, 'cgroup.procs'))).length > 0
  }

  private validateTargetPid(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) {
      throw new LinuxCgroupSafetyError('拒绝 attach 非法或受保护 PID')
    }
  }

  private bindAbort(signal: AbortSignal) {
    const listener = () => {
      const pending = this.kill().catch(() => undefined).finally(() => {
        this.pendingKills.delete(pending)
      })
      this.pendingKills.add(pending)
    }
    this.abortBindings.set(signal, listener)
    signal.addEventListener('abort', listener, { once: true })
    if (signal.aborted) listener()
  }

  private unbindAbort(signal: AbortSignal) {
    const listener = this.abortBindings.get(signal)
    if (listener) signal.removeEventListener('abort', listener)
    this.abortBindings.delete(signal)
  }

  private async assertIdentity() {
    try {
      if (await this.fileSystem.realpath(this.path) !== this.path
        || await this.fileSystem.identity(this.path) !== this.identity) {
        throw new LinuxCgroupSafetyError('operation cgroup identity changed')
      }
    } catch (error) {
      if (error instanceof LinuxCgroupSafetyError) throw error
      throw error
    }
  }
}
