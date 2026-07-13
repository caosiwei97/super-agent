/**
 * 从 Error 对象提取 HTTP 状态码。
 *
 * 优先读取 error.status / error.statusCode 属性（AI SDK / fetch 错误的标准字段），
 * 再 fallback 到 message 文本中匹配 "status: 429" / "HTTP 500" 这类模式。
 *
 * 不再用裸 /(\d{3})/ —— 那会误匹配 message 中的任意三位数（如 "retry in 5000ms" → 500）。
 */
function extractStatusCode(error: Error): number | null {
  // 1. 属性读取（最可靠）
  const statusAttr =
    (error as any).status ?? (error as any).statusCode ?? (error as any).response?.status
  if (typeof statusAttr === 'number') return statusAttr

  // 2. 文本 fallback：匹配 "status: 429" / "HTTP 500" / "status 503" 等模式
  const message = error.message || ''
  const match = message.match(/(?:status|HTTP)[:\s]*(\d{3})\b/i)
  return match ? parseInt(match[1], 10) : null
}

export function isRetryable(error: unknown): boolean {
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
 * 抖动公式：capped - jitter/2 + random * jitter，
 * 确保结果始终在 [capped - jitter/2, capped + jitter/2] 范围内，
 * 不会因抖动叠加而超过 maxMs。
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, maxMs)
  const jitter = capped * 0.25
  return Math.max(0, Math.round(capped - jitter / 2 + Math.random() * jitter))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
