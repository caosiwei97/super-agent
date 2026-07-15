import { Worker } from 'node:worker_threads'

const DEFAULT_TIMEOUT_MS = 1_000
const MAX_PATTERN_CHARS = 200
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_MATCHES_PER_REQUEST = 50

const WORKER_SOURCE = String.raw`
'use strict'
const { parentPort, workerData } = require('node:worker_threads')

let regex
try {
  regex = new RegExp(workerData.pattern, 'i')
} catch {
  parentPort.postMessage({ type: 'ready', ok: false })
  parentPort.close()
}

if (regex) {
  parentPort.postMessage({ type: 'ready', ok: true })
  parentPort.on('message', (message) => {
    try {
      if (!message || !Number.isSafeInteger(message.id)
        || typeof message.content !== 'string'
        || Buffer.byteLength(message.content, 'utf8') > workerData.maxInputBytes
        || !Number.isSafeInteger(message.maxMatches)
        || message.maxMatches < 1
        || message.maxMatches > workerData.maxMatchesPerRequest) {
        throw new Error('invalid_request')
      }

      const matches = []
      const lines = message.content.split('\n')
      for (let index = 0; index < lines.length && matches.length < message.maxMatches; index++) {
        if (regex.test(lines[index].slice(0, workerData.maxLineChars))) matches.push(index)
      }
      parentPort.postMessage({ type: 'result', id: message.id, matches })
    } catch {
      parentPort.postMessage({ type: 'failure', id: message && message.id })
    }
  })
}
`

interface PendingRequest {
  readonly maxMatches: number
  readonly resolve: (matches: readonly number[]) => void
  readonly reject: (error: Error) => void
}

interface RegexWorkerMatcherOptions {
  readonly signal: AbortSignal
  readonly deadline: number
  readonly timeoutMs?: number
}

export class InvalidRegexPatternError extends Error {
  override readonly name = 'InvalidRegexPatternError'
}

export class RegexWorkerTimeoutError extends Error {
  override readonly name = 'RegexWorkerTimeoutError'
}

export class RegexWorkerExecutionError extends Error {
  override readonly name = 'RegexWorkerExecutionError'
}

let activeWorkers = 0

/** Exposed for health checks and deterministic leak assertions. */
export function getActiveRegexWorkerCount() {
  return activeWorkers
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Regex worker aborted', 'AbortError')
}

function validateOptions(options: RegexWorkerMatcherOptions) {
  if (!(options.signal instanceof AbortSignal)) throw new TypeError('Regex worker signal 必填')
  if (!Number.isFinite(options.deadline)) throw new TypeError('Regex worker deadline 必须为有限时间戳')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Regex worker timeoutMs 必须是正安全整数')
  }
  if (options.signal.aborted) throw abortError(options.signal)
  const remaining = options.deadline - Date.now()
  if (remaining <= 0) throw new RegexWorkerTimeoutError('Regex worker deadline 已到期')
  return Math.min(timeoutMs, remaining, 2_147_483_647)
}

/**
 * A per-grep isolated RegExp session. The main thread never constructs or runs
 * the untrusted expression; timeout and cancellation terminate the isolate.
 */
export class RegexWorkerMatcher {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private readonly ready: Promise<void>
  private readonly onAbort: () => void
  private timer: NodeJS.Timeout | undefined
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private nextRequestId = 1
  private terminalError: Error | undefined
  private closePromise: Promise<void> | undefined
  private closed = false

  private constructor(pattern: string, private readonly options: RegexWorkerMatcherOptions) {
    const effectiveTimeoutMs = validateOptions(options)
    if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN_CHARS) {
      throw new InvalidRegexPatternError(`正则表达式长度不能超过 ${MAX_PATTERN_CHARS} 字符`)
    }

    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      name: 'super-agent-regex',
      workerData: {
        pattern,
        maxInputBytes: MAX_INPUT_BYTES,
        maxLineChars: 10_000,
        maxMatchesPerRequest: MAX_MATCHES_PER_REQUEST,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        codeRangeSizeMb: 8,
        stackSizeMb: 1,
      },
    })
    activeWorkers += 1
    this.worker.once('exit', (code) => {
      activeWorkers -= 1
      if (!this.closed) {
        this.fail(new RegexWorkerExecutionError(`Regex worker 意外退出 (${code})`))
      }
    })
    this.worker.once('error', () => {
      this.fail(new RegexWorkerExecutionError('Regex worker 执行失败'))
    })
    this.worker.on('message', (message: unknown) => this.handleMessage(message))

    this.onAbort = () => {
      this.fail(abortError(this.options.signal))
    }
    options.signal.addEventListener('abort', this.onAbort, { once: true })
    this.timer = setTimeout(() => {
      this.fail(new RegexWorkerTimeoutError('Regex worker 超过硬超时'))
    }, effectiveTimeoutMs)
    this.timer.unref()
  }

  static async create(pattern: string, options: RegexWorkerMatcherOptions) {
    const matcher = new RegexWorkerMatcher(pattern, options)
    try {
      await matcher.ready
      return matcher
    } catch (error) {
      await matcher.close()
      throw error
    }
  }

  async match(content: string, maxMatches: number): Promise<readonly number[]> {
    if (this.terminalError) throw this.terminalError
    if (this.closed) throw new RegexWorkerExecutionError('Regex worker 已关闭')
    if (this.options.signal.aborted) throw abortError(this.options.signal)
    if (Date.now() >= this.options.deadline) {
      this.fail(new RegexWorkerTimeoutError('Regex worker deadline 已到期'))
      throw this.terminalError
    }
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_INPUT_BYTES) {
      throw new RegexWorkerExecutionError(`Regex worker 输入超过 ${MAX_INPUT_BYTES} 字节`)
    }
    if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > MAX_MATCHES_PER_REQUEST) {
      throw new RegexWorkerExecutionError(`Regex worker maxMatches 必须为 1..${MAX_MATCHES_PER_REQUEST}`)
    }

    const id = this.nextRequestId++
    return new Promise<readonly number[]>((resolve, reject) => {
      this.pending.set(id, { maxMatches, resolve, reject })
      try {
        this.worker.postMessage({ id, content, maxMatches })
      } catch {
        this.pending.delete(id)
        const error = new RegexWorkerExecutionError('Regex worker 请求发送失败')
        reject(error)
        this.fail(error)
      }
    })
  }

  async close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.options.signal.removeEventListener('abort', this.onAbort)
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const error = this.terminalError ?? new RegexWorkerExecutionError('Regex worker 已关闭')
    this.readyReject(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.closePromise = this.worker.terminate().then(() => undefined)
    return this.closePromise
  }

  private handleMessage(value: unknown) {
    if (this.closed || value === null || typeof value !== 'object' || Array.isArray(value)) return
    const message = value as Record<string, unknown>
    if (message.type === 'ready') {
      if (message.ok === true) this.readyResolve()
      else this.fail(new InvalidRegexPatternError('无效的正则表达式'))
      return
    }
    if (!Number.isSafeInteger(message.id)) {
      this.fail(new RegexWorkerExecutionError('Regex worker 返回非法消息'))
      return
    }
    const id = message.id as number
    const pending = this.pending.get(id)
    if (!pending) {
      this.fail(new RegexWorkerExecutionError('Regex worker 返回未知请求'))
      return
    }
    this.pending.delete(id)
    if (message.type === 'failure') {
      const error = new RegexWorkerExecutionError('Regex worker 拒绝请求')
      pending.reject(error)
      this.fail(error)
      return
    }
    if (message.type !== 'result'
      || !Array.isArray(message.matches)
      || message.matches.length > pending.maxMatches
      || message.matches.some((index) => !Number.isSafeInteger(index) || (index as number) < 0)) {
      const error = new RegexWorkerExecutionError('Regex worker 返回非法结果')
      pending.reject(error)
      this.fail(error)
      return
    }
    pending.resolve(Object.freeze([...(message.matches as number[])]))
  }

  private fail(error: Error) {
    if (this.terminalError) return
    this.terminalError = error
    this.readyReject(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    void this.close()
  }
}
