import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_TERMINATION_GRACE_MS = 500
const MAX_SPAWN_GATE_SETTLE_MS = 500
const MAX_TIMER_DELAY_MS = 2_147_483_647
const activePosixProcessGroups = new Set<number>()
let exitCleanupInstalled = false

function signalPosixGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      // Cancellation is best-effort at this layer; callers still receive the
      // structured outcome instead of an uncaught signal-delivery exception.
    }
    return false
  }
}

/** Synchronous last-resort cleanup for CLI force-exit and process exit hooks. */
export function killActiveProcessGroupsSync() {
  if (process.platform === 'win32') return
  for (const pid of activePosixProcessGroups) signalPosixGroup(pid, 'SIGKILL')
}

function trackPosixProcessGroup(pid: number) {
  if (!exitCleanupInstalled) {
    process.once('exit', killActiveProcessGroupsSync)
    exitCleanupInstalled = true
  }
  activePosixProcessGroups.add(pid)
}

function untrackPosixProcessGroup(pid: number) {
  activePosixProcessGroups.delete(pid)
  if (activePosixProcessGroups.size === 0 && exitCleanupInstalled) {
    process.removeListener('exit', killActiveProcessGroupsSync)
    exitCleanupInstalled = false
  }
}

export type ProcessTerminationReason =
  | 'exited'
  | 'aborted'
  | 'timeout'
  | 'output_limit'
  | 'setup_error'
  | 'spawn_error'

export interface ProcessSpawnControl {
  readonly pid: number
  /**
   * Aborted when execution is cancelled, times out, fails to spawn, or the
   * child closes. Spawn gates must use this signal for every blocking wait.
   */
  readonly signal: AbortSignal
  /** Parent-side endpoints corresponding to child fd 3, 4, ... . */
  readonly extraStdio: readonly (
    NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined
  )[]
}

export interface ProcessExecutionOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  /** Relative execution timeout. Omit to rely only on deadline or cancellation. */
  readonly timeoutMs?: number
  /** Absolute Unix epoch deadline in milliseconds. */
  readonly deadline?: number
  /** Combined stdout and stderr byte budget. */
  readonly maxOutputBytes?: number
  readonly terminationGraceMs?: number
  /** Numeric parent descriptors inherited as child fd 3, 4, ... . */
  readonly extraFileDescriptors?: readonly number[]
  /** Internal backend seam for inherited descriptors and parent/child pipes. */
  readonly extraStdio?: readonly (number | 'pipe')[]
  /**
   * Runs immediately after spawn while a backend-owned child handshake is
   * expected to keep untrusted code blocked. Throwing terminates the process.
   */
  readonly onSpawn?: (control: ProcessSpawnControl) => Promise<void> | void
}

export interface ProcessExecutionResult {
  readonly pid?: number
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly outputBytes: number
  readonly outputTruncated: boolean
  readonly terminationReason: ProcessTerminationReason
  readonly durationMs: number
  readonly error?: {
    readonly message: string
    readonly code?: string
  }
}

function assertFiniteNonNegative(value: number | undefined, field: string) {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} 必须为非负有限数字`)
}

function validateOptions(options: ProcessExecutionOptions) {
  if (typeof options.command !== 'string' || options.command.trim().length === 0) {
    throw new Error('command 不能为空')
  }
  if (options.args?.some((argument) => typeof argument !== 'string')) {
    throw new Error('args 必须全部为字符串')
  }
  assertFiniteNonNegative(options.timeoutMs, 'timeoutMs')
  assertFiniteNonNegative(options.deadline, 'deadline')
  assertFiniteNonNegative(options.terminationGraceMs, 'terminationGraceMs')
  if (options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)) {
    throw new Error('maxOutputBytes 必须为正安全整数')
  }
  if (options.extraFileDescriptors?.some(
    (descriptor) => !Number.isSafeInteger(descriptor) || descriptor < 0,
  )) {
    throw new Error('extraFileDescriptors 必须全部为非负安全整数')
  }
  if (options.extraStdio !== undefined && options.extraFileDescriptors !== undefined) {
    throw new Error('extraStdio 与 extraFileDescriptors 不能同时设置')
  }
  if (options.extraStdio?.some(
    (entry) => entry !== 'pipe' && (!Number.isSafeInteger(entry) || entry < 0),
  )) {
    throw new Error('extraStdio 只允许 pipe 或非负安全整数')
  }
}

function effectiveTimeout(options: ProcessExecutionOptions, now: number): number | undefined {
  const candidates: number[] = []
  if (options.timeoutMs !== undefined) candidates.push(options.timeoutMs)
  if (options.deadline !== undefined) candidates.push(Math.max(0, options.deadline - now))
  if (candidates.length === 0) return undefined
  return Math.min(...candidates)
}

function boundedTimerDelay(delay: number) {
  return Math.min(Math.max(0, Math.ceil(delay)), MAX_TIMER_DELAY_MS)
}

function spawnGateAbortReason(reason: ProcessTerminationReason | 'closed') {
  return new DOMException(`Process spawn gate cancelled: ${reason}`, 'AbortError')
}

async function drainSpawnGate(
  gate: Promise<unknown>,
  terminationGraceMs: number,
) {
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      gate,
      new Promise<void>((resolve) => {
        timeout = setTimeout(
          resolve,
          boundedTimerDelay(Math.min(terminationGraceMs, MAX_SPAWN_GATE_SETTLE_MS)),
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function closeSpawnControlEndpoints(
  endpoints: readonly (NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined)[],
) {
  for (const endpoint of endpoints) {
    const destroy = endpoint === null || endpoint === undefined
      ? undefined
      : (endpoint as { destroy?: unknown }).destroy
    if (typeof destroy === 'function') {
      destroy.call(endpoint)
    }
  }
}

function noProcessResult(
  reason: 'aborted' | 'timeout',
  startedAt: number,
): ProcessExecutionResult {
  return Object.freeze({
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputBytes: 0,
    outputTruncated: false,
    terminationReason: reason,
    durationMs: Math.max(0, Date.now() - startedAt),
  })
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return
  if (process.platform !== 'win32' && signalPosixGroup(child.pid, signal)) return
  try {
    child.kill(signal)
  } catch {
    // The process may have exited between the group and direct-child attempts.
  }
}

async function cleanupRemainingPosixGroup(pid: number, graceMs: number) {
  if (!signalPosixGroup(pid, 'SIGTERM')) return
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())))
    if (!signalPosixGroup(pid, 0)) return
  }
  signalPosixGroup(pid, 'SIGKILL')
}

/**
 * Execute one local process without a shell. On Unix the child leads a new
 * process group so cancellation can terminate its descendants as one unit.
 */
export async function executeProcess(
  options: ProcessExecutionOptions,
): Promise<ProcessExecutionResult> {
  validateOptions(options)
  const startedAt = Date.now()
  if (options.signal?.aborted) return noProcessResult('aborted', startedAt)
  const timeoutMs = effectiveTimeout(options, startedAt)
  if (timeoutMs === 0) return noProcessResult('timeout', startedAt)

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  let outputTruncated = false
  let terminationReason: ProcessTerminationReason | undefined
  let spawnError: NodeJS.ErrnoException | undefined
  let spawnGateError: Error | undefined
  let timeoutHandle: NodeJS.Timeout | undefined
  let killHandle: NodeJS.Timeout | undefined
  let terminationGrace: Promise<void> | undefined
  let finishTerminationGrace: (() => void) | undefined
  const spawnGateController = new AbortController()

  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: [
      'ignore',
      'pipe',
      'pipe',
      ...(options.extraStdio ?? options.extraFileDescriptors ?? []),
    ],
    windowsHide: true,
  })
  if (process.platform !== 'win32' && child.pid !== undefined) {
    trackPosixProcessGroup(child.pid)
  }

  const requestTermination = (reason: Exclude<ProcessTerminationReason, 'exited' | 'spawn_error'>) => {
    if (terminationReason !== undefined || spawnError !== undefined) return
    terminationReason = reason
    spawnGateController.abort(spawnGateAbortReason(reason))
    signalProcess(child, 'SIGTERM')

    terminationGrace = new Promise<void>((resolve) => {
      finishTerminationGrace = resolve
      killHandle = setTimeout(() => {
        try {
          signalProcess(child, 'SIGKILL')
        } finally {
          finishTerminationGrace?.()
          finishTerminationGrace = undefined
        }
      }, boundedTimerDelay(terminationGraceMs))
    })
  }

  const capture = (destination: Buffer[], chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = maxOutputBytes - outputBytes
    if (remaining > 0) {
      const accepted = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining)
      destination.push(Buffer.from(accepted))
      outputBytes += accepted.length
    }
    if (bytes.length > remaining) {
      outputTruncated = true
      requestTermination('output_limit')
    }
  }

  child.stdout?.on('data', (chunk: Buffer | string) => capture(stdout, chunk))
  child.stderr?.on('data', (chunk: Buffer | string) => capture(stderr, chunk))

  const spawnControlEndpoints = Object.freeze(child.stdio.slice(3))
  const closedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        spawnError = error
        spawnGateController.abort(spawnGateAbortReason('spawn_error'))
      })
      child.once('close', (code, signal) => {
        spawnGateController.abort(spawnGateAbortReason('closed'))
        closeSpawnControlEndpoints(spawnControlEndpoints)
        resolve({ code, signal })
      })
    },
  )

  const abort = () => requestTermination('aborted')
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => requestTermination('timeout'), boundedTimerDelay(timeoutMs))
    timeoutHandle.unref()
  }

  let startup: Promise<
    { state: 'ready' } | { state: 'failed'; error: unknown }
  > | undefined
  if (options.onSpawn !== undefined && child.pid !== undefined && spawnError === undefined) {
    startup = Promise.resolve()
      .then(() => options.onSpawn!({
        pid: child.pid!,
        signal: spawnGateController.signal,
        extraStdio: spawnControlEndpoints,
      }))
      .then(
        () => ({ state: 'ready' as const }),
        (error: unknown) => {
          spawnGateError = error instanceof Error
            ? error
            : new Error(String(error))
          return { state: 'failed' as const, error: spawnGateError }
        },
      )
    const startupResult = await Promise.race([
      startup,
      closedPromise.then(() => ({ state: 'closed' as const })),
    ])
    if (startupResult.state === 'failed'
      && terminationReason === undefined
      && spawnError === undefined) {
      requestTermination('setup_error')
    }
  }

  const closed = await closedPromise
  if (startup !== undefined) await drainSpawnGate(startup, terminationGraceMs)

  if (process.platform !== 'win32' && child.pid !== undefined) {
    if (terminationGrace !== undefined) await terminationGrace
    else await cleanupRemainingPosixGroup(child.pid, terminationGraceMs)
    untrackPosixProcessGroup(child.pid)
  } else if (killHandle !== undefined) {
    clearTimeout(killHandle)
    finishTerminationGrace?.()
  }
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  if (killHandle !== undefined) clearTimeout(killHandle)
  options.signal?.removeEventListener('abort', abort)

  const reason = spawnError !== undefined
    ? 'spawn_error'
    : terminationReason ?? (spawnGateError === undefined ? 'exited' : 'setup_error')
  const reportedError = spawnError
    ?? (reason === 'setup_error' ? spawnGateError : undefined)
  return Object.freeze({
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    exitCode: closed.code,
    signal: closed.signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    outputBytes,
    outputTruncated,
    terminationReason: reason,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(reportedError === undefined
      ? {}
      : {
          error: Object.freeze({
            message: reportedError.message,
            ...(spawnError?.code === undefined ? {} : { code: spawnError.code }),
          }),
        }),
  })
}
