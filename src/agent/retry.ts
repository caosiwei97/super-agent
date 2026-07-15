/** Return true only for an actual cancellation, never for arbitrary DOMException values. */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return true
  const wrapped = error as Error & { reason?: unknown; lastError?: unknown }
  if (wrapped.reason === 'abort') return true
  return wrapped.lastError !== error && isAbortError(wrapped.lastError)
}

/**
 * Extract an HTTP status without matching unrelated three-digit values in the
 * error text (for example, "retry in 5000ms").
 */
function extractStatusCode(error: Error): number | null {
  const candidate = error as Error & {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
    lastError?: unknown
  }
  const statusAttr =
    candidate.status ?? candidate.statusCode ?? candidate.response?.status
  if (typeof statusAttr === 'number') return statusAttr

  const match = (error.message || '').match(/(?:status|HTTP)[:\s]*(\d{3})\b/i)
  if (match) return parseInt(match[1], 10)
  return candidate.lastError instanceof Error && candidate.lastError !== error
    ? extractStatusCode(candidate.lastError)
    : null
}

export function isRetryable(error: unknown) {
  if (!(error instanceof Error) || isAbortError(error)) return false

  const status = extractStatusCode(error)
  if (status !== null) {
    if ([408, 429, 529].includes(status)) return true
    if (status >= 500 && status < 600) return true
    if (status >= 400 && status < 500) return false
  }

  const message = error.message || ''
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true
  if (message.includes('ETIMEDOUT') || /\btimeout\b/i.test(message)) return true
  if (message.includes('fetch failed') || /\bnetwork\b/i.test(message)) return true
  if (message.includes('No output generated')) return true
  return false
}

/** Exponential backoff with bounded [75%, 100%] jitter. */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('attempt 必须是正整数')
  if (!Number.isFinite(baseMs) || baseMs <= 0) throw new Error('baseMs 必须是正数')
  if (!Number.isFinite(maxMs) || maxMs <= 0) throw new Error('maxMs 必须是正数')

  const exponential = baseMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, maxMs)
  const minimum = capped * 0.75
  return Math.round(minimum + Math.random() * (capped - minimum))
}

type HeaderSource = Headers | Readonly<Record<string, unknown>>

function getHeader(headers: HeaderSource, name: string) {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && (typeof value === 'string' || typeof value === 'number')) {
      return String(value)
    }
  }
  return undefined
}

function errorHeaders(error: unknown): HeaderSource | undefined {
  if (!(error instanceof Error)) return undefined
  const candidate = error as Error & {
    responseHeaders?: unknown
    headers?: unknown
    response?: { headers?: unknown }
    lastError?: unknown
  }
  const headers = candidate.responseHeaders ?? candidate.headers ?? candidate.response?.headers
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    return headers as Readonly<Record<string, unknown>>
  }
  if (candidate.lastError !== error) return errorHeaders(candidate.lastError)
  return undefined
}

/** Parse provider Retry-After headers. Invalid and negative values are ignored. */
export function retryAfterMs(error: unknown, now = Date.now()) {
  const headers = errorHeaders(error)
  if (!headers) return undefined

  const explicitMs = Number.parseFloat(getHeader(headers, 'retry-after-ms') ?? '')
  if (Number.isFinite(explicitMs) && explicitMs >= 0) return explicitMs

  const value = getHeader(headers, 'retry-after')
  if (!value) return undefined
  const seconds = Number.parseFloat(value)
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined
}

export interface RetryDelayOptions {
  readonly baseMs?: number
  readonly maxMs?: number
  readonly now?: number
}

/** Retry-After takes precedence over local exponential backoff. */
export function calculateRetryDelay(
  error: unknown,
  attempt: number,
  options: RetryDelayOptions = {},
) {
  return retryAfterMs(error, options.now) ?? calculateDelay(
    attempt,
    options.baseMs,
    options.maxMs,
  )
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

/** Abort-aware sleep; listeners and timers are always cleaned up. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new Error('ms 必须是非负数'))
  if (signal?.aborted) return Promise.reject(abortReason(signal))

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal ? abortReason(signal) : new DOMException('The operation was aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
