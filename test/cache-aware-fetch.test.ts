import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createDeepSeekFetch,
  disableDeepSeekThinking,
  normalizeCacheUsagePayload,
} from '../src/usage/cache-aware-fetch.js'

describe('DeepSeek OpenAI-compatible adapter', () => {
  it('disables thinking because the current provider cannot replay reasoning_content', () => {
    assert.deepEqual(disableDeepSeekThinking({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }), {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'disabled' },
    })
  })

  it('maps DeepSeek cache hits into the field recognized by the AI SDK', () => {
    assert.deepEqual(normalizeCacheUsagePayload({
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
      },
    }), {
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    })
  })

  it('patches both JSON and chunk-split SSE responses', async () => {
    const payload = {
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 75,
        prompt_cache_miss_tokens: 25,
      },
    }
    const jsonFetch: typeof fetch = async () => new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    })
    const jsonResponse = await createDeepSeekFetch(jsonFetch)('https://example.com')
    assert.equal((await jsonResponse.json() as {
      usage: { prompt_tokens_details: { cached_tokens: number } }
    }).usage.prompt_tokens_details.cached_tokens, 75)

    const encoded = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17))
        controller.enqueue(encoded.slice(17))
        controller.close()
      },
    })
    const sseFetch: typeof fetch = async () => new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    })
    const sseResponse = await createDeepSeekFetch(sseFetch)('https://example.com')
    const sseText = await sseResponse.text()
    assert.match(sseText, /"prompt_tokens_details":\{"cached_tokens":75\}/)
    assert.match(sseText, /data: \[DONE\]/)
  })

  it('preserves an existing standard cached token value', () => {
    const payload = {
      usage: {
        prompt_cache_hit_tokens: 80,
        prompt_tokens_details: { cached_tokens: 70 },
      },
    }
    assert.strictEqual(normalizeCacheUsagePayload(payload), payload)
  })

  it('injects disabled thinking into requests and preserves null-body responses', async () => {
    let sentBody = ''
    const baseFetch: typeof fetch = async (_input, init) => {
      sentBody = String(init?.body)
      return new Response(null, {
        status: 204,
        headers: { 'content-type': 'application/json' },
      })
    }
    const response = await createDeepSeekFetch(baseFetch)('https://example.com', {
      method: 'POST',
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    assert.equal(response.status, 204)
    assert.equal((JSON.parse(sentBody) as {
      thinking: { type: string }
    }).thinking.type, 'disabled')
  })
})
