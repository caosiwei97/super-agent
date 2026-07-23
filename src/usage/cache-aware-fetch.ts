type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * DeepSeek 的 OpenAI-compatible usage 使用 prompt_cache_hit_tokens，
 * @ai-sdk/openai 只保留 prompt_tokens_details.cached_tokens。
 * 在 provider schema 解析前补齐标准字段，避免缓存命中数据被静默丢弃。
 */
export function normalizeCacheUsagePayload(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.usage)) return payload
  const usage = payload.usage
  const cacheHit = usage.prompt_cache_hit_tokens
  if (typeof cacheHit !== 'number' || !Number.isFinite(cacheHit) || cacheHit < 0) {
    return payload
  }

  const details = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {}
  if (typeof details.cached_tokens === 'number') return payload

  return {
    ...payload,
    usage: {
      ...usage,
      prompt_tokens_details: {
        ...details,
        cached_tokens: cacheHit,
      },
    },
  }
}

/** 当前 SDK 无法回放 DeepSeek reasoning_content，因此明确关闭默认 thinking mode。 */
export function disableDeepSeekThinking(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload
  return {
    ...payload,
    thinking: { type: 'disabled' },
  }
}

function patchJson(text: string) {
  try {
    const parsed = JSON.parse(text)
    const patched = normalizeCacheUsagePayload(parsed)
    return patched === parsed
      ? { text, changed: false }
      : { text: JSON.stringify(patched), changed: true }
  } catch {
    return { text, changed: false }
  }
}

function patchSseLine(line: string) {
  if (!line.startsWith('data:')) return line
  const data = line.slice('data:'.length).trimStart()
  if (!data || data === '[DONE]') return line
  const patched = patchJson(data)
  return patched.changed ? `data: ${patched.text}` : line
}

function responseHeaders(response: Response) {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return headers
}

function preserveResponseMetadata(target: Response, source: Response) {
  for (const key of ['url', 'redirected', 'type'] as const) {
    try {
      Object.defineProperty(target, key, { configurable: true, value: source[key] })
    } catch {
      // 这些元数据不参与 AI SDK 解析；不可覆盖时保留平台默认值。
    }
  }
  return target
}

function patchEventStream(response: Response) {
  if (!response.body) return response

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${patchSseLine(line)}\n`))
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) controller.enqueue(encoder.encode(patchSseLine(buffer)))
    },
  })

  return preserveResponseMetadata(new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  }), response)
}

async function patchJsonResponse(response: Response) {
  const patched = patchJson(await response.clone().text())
  if (!patched.changed) return response

  return preserveResponseMetadata(new Response(patched.text, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  }), response)
}

function patchDeepSeekRequest(init: RequestInit | undefined) {
  if (typeof init?.body !== 'string') return init
  const patched = patchJsonRequest(init.body)
  if (!patched.changed) return init

  const headers = new Headers(init.headers)
  headers.delete('content-length')
  return { ...init, headers, body: patched.text }
}

function patchJsonRequest(text: string) {
  try {
    const parsed = JSON.parse(text)
    const patched = disableDeepSeekThinking(parsed)
    return patched === parsed
      ? { text, changed: false }
      : { text: JSON.stringify(patched), changed: true }
  } catch {
    return { text, changed: false }
  }
}

export function createDeepSeekFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await baseFetch(input, patchDeepSeekRequest(init))
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('text/event-stream')) return patchEventStream(response)
    if (contentType.includes('application/json') && response.body !== null) {
      return patchJsonResponse(response)
    }
    return response
  }
}
