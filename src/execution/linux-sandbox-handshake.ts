import { once } from 'node:events'
import { stat, readFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'

const DEFAULT_MAX_INFO_BYTES = 8 * 1024
const MAX_TIMER_DELAY_MS = 2_147_483_647

export class SandboxHandshakeError extends Error {
  override readonly name = 'SandboxHandshakeError'
}

export interface BlockedSandboxChildIdentity {
  readonly pid: number
  readonly startTimeTicks: string
  readonly executableIdentity: string
}

function assertChildPid(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) {
    throw new SandboxHandshakeError('bwrap child PID 非法或受保护')
  }
}

/** Parse field 22 without trusting the parenthesized comm field to exclude spaces or ')'. */
export function parseLinuxProcessStartTime(value: string) {
  const commandEnd = value.lastIndexOf(') ')
  if (!/^\d+ \(/.test(value) || commandEnd < 3) {
    throw new SandboxHandshakeError('/proc child stat 格式非法')
  }
  // The suffix starts at field 3 (state); starttime is field 22.
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/)
  const startTime = fields[19]
  if (fields.length < 20 || !startTime || !/^\d+$/.test(startTime) || startTime === '0') {
    throw new SandboxHandshakeError('/proc child starttime 非法')
  }
  return startTime
}

function metadataIdentity(metadata: Awaited<ReturnType<typeof stat>>) {
  return `${metadata.dev}:${metadata.ino}`
}

/**
 * Bind an info-fd PID to the exact blocked bwrap executable and kernel process
 * lifetime. A missing or hidden /proc identity is a release-gate failure, not
 * a reason to fall back to PID-only cgroup attachment.
 */
export async function readBlockedSandboxChildIdentity(
  pid: number,
  expectedExecutableIdentity: string,
): Promise<BlockedSandboxChildIdentity> {
  assertChildPid(pid)
  if (!/^\d+:\d+$/.test(expectedExecutableIdentity)) {
    throw new TypeError('expectedExecutableIdentity 必须是 dev:ino')
  }
  try {
    const [processStat, executable] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      stat(`/proc/${pid}/exe`),
    ])
    const executableIdentity = metadataIdentity(executable)
    if (executableIdentity !== expectedExecutableIdentity) {
      throw new SandboxHandshakeError('bwrap child executable identity 不匹配')
    }
    return Object.freeze({
      pid,
      startTimeTicks: parseLinuxProcessStartTime(processStat),
      executableIdentity,
    })
  } catch (error) {
    if (error instanceof SandboxHandshakeError) throw error
    throw new SandboxHandshakeError('无法确认 bwrap child /proc identity', { cause: error })
  }
}

/** Reject PID reuse or exec between cgroup attach and block-fd release. */
export async function assertBlockedSandboxChildIdentity(
  expected: BlockedSandboxChildIdentity,
) {
  const actual = await readBlockedSandboxChildIdentity(
    expected.pid,
    expected.executableIdentity,
  )
  if (actual.startTimeTicks !== expected.startTimeTicks) {
    throw new SandboxHandshakeError('bwrap child PID lifetime changed')
  }
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Sandbox handshake aborted', 'AbortError')
}

function timerDelay(deadline: number) {
  return Math.min(
    Math.max(0, Math.ceil(deadline - Date.now())),
    MAX_TIMER_DELAY_MS,
  )
}

/**
 * Read bwrap --info-fd JSON without allowing an unbounded control stream.
 * The returned PID is the host PID of the blocked sandbox child, not the
 * outer bwrap monitor process.
 */
export async function readBlockedSandboxChildPid(
  stream: Readable,
  options: {
    readonly signal: AbortSignal
    readonly deadline: number
    readonly maxBytes?: number
  },
) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INFO_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes 必须是正安全整数')
  }
  if (!Number.isFinite(options.deadline) || options.deadline <= 0) {
    throw new TypeError('deadline 必须是有限正数')
  }
  if (options.signal.aborted) throw abortReason(options.signal)
  if (Date.now() >= options.deadline) {
    throw new DOMException('Sandbox handshake deadline exceeded', 'TimeoutError')
  }

  const chunks: Buffer[] = []
  let size = 0
  const onData = (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.length
    if (size > maxBytes) {
      stream.destroy(new SandboxHandshakeError('bwrap info-fd 超过大小限制'))
      return
    }
    chunks.push(Buffer.from(chunk))
  }
  stream.on('data', onData)
  const timeout = setTimeout(() => {
    stream.destroy(new DOMException('Sandbox handshake deadline exceeded', 'TimeoutError'))
  }, timerDelay(options.deadline))
  timeout.unref()
  const abort = () => stream.destroy(abortReason(options.signal))
  options.signal.addEventListener('abort', abort, { once: true })

  try {
    await once(stream, 'end', { signal: options.signal })
  } catch (error) {
    if (options.signal.aborted) throw abortReason(options.signal)
    throw error
  } finally {
    clearTimeout(timeout)
    options.signal.removeEventListener('abort', abort)
    stream.removeListener('data', onData)
  }

  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new SandboxHandshakeError('bwrap info-fd 不是合法 JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SandboxHandshakeError('bwrap info-fd 必须是对象')
  }
  const childPid = (value as Record<string, unknown>)['child-pid']
  if (!Number.isSafeInteger(childPid) || (childPid as number) <= 0) {
    throw new SandboxHandshakeError('bwrap info-fd 缺少合法 child-pid')
  }
  assertChildPid(childPid as number)
  return childPid as number
}

/** Release exactly one blocked bwrap child after all parent-side checks pass. */
export async function releaseBlockedSandboxChild(stream: Writable) {
  if (stream.destroyed || typeof stream.write !== 'function') {
    throw new SandboxHandshakeError('bwrap block-fd 不可写')
  }
  await new Promise<void>((resolve, reject) => {
    stream.write(Buffer.from([1]), (error?: Error | null) => {
      if (error) reject(error)
      else resolve()
    })
  })
  stream.end()
}
