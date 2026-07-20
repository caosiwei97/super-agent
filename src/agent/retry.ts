/**
 * 从 Error 对象提取 HTTP 状态码。
 *
 * 优先读取 error.status / error.statusCode 属性（AI SDK / fetch 错误的标准字段），
 * 再回退到错误消息文本中匹配 "status: 429" / "HTTP 500" 这类模式。
 *
 * 不再用裸 /(\d{3})/ —— 那会误匹配错误消息中的任意三位数（如 "retry in 5000ms" → 500）。
 */
function extractStatusCode(error: Error) {
  // 1. 属性读取（最可靠）
  const candidate = error as Error & {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  const statusAttr =
    candidate.status ?? candidate.statusCode ?? candidate.response?.status
  if (typeof statusAttr === 'number') return statusAttr

  // 2. 文本回退：匹配 "status: 429" / "HTTP 500" / "status 503" 等模式
  const message = error.message || ''
  const match = message.match(/(?:status|HTTP)[:\s]*(\d{3})\b/i)
  return match ? parseInt(match[1], 10) : null
}

export function isRetryable(error: unknown) {
  if (!(error instanceof Error)) return false

  // 网络中断 / 用户取消
  const errorName = error.name || ''
  if (errorName === 'AbortError' || errorName === 'DOMException') return true

  const status = extractStatusCode(error)
  if (status !== null) {
    if ([429, 529, 408].includes(status)) return true
    if (status >= 500 && status < 600) return true
    if (status >= 400 && status < 500) return false
  }

  const message = error.message || ''
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true
  if (message.includes('fetch failed') || message.includes('network')) return true
  if (message.includes('No output generated')) return true
  return false
}

/**
 * 指数退避 + 抖动。
 *
 * 使用 [75%, 100%] 的有界抖动，既分散重试请求，也严格不超过 maxMs。
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('attempt 必须是正整数')
  if (!Number.isFinite(baseMs) || baseMs <= 0) throw new Error('baseMs 必须是正数')
  if (!Number.isFinite(maxMs) || maxMs <= 0) throw new Error('maxMs 必须是正数')

  const exponential = baseMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, maxMs)
  const minimum = capped * 0.75
  return Math.round(minimum + Math.random() * (capped - minimum))
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
