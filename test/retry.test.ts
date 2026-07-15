import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  calculateDelay,
  calculateRetryDelay,
  isRetryable,
  retryAfterMs,
  sleep,
} from '../src/agent/retry.js'

describe('calculateDelay', () => {
  it('keeps jitter within the configured cap', () => {
    const originalRandom = Math.random
    try {
      Math.random = () => 0.999_999
      assert.ok(calculateDelay(20, 500, 30_000) <= 30_000)

      Math.random = () => 0
      assert.equal(calculateDelay(1, 500, 30_000), 375)
    } finally {
      Math.random = originalRandom
    }
  })

  it('rejects invalid retry parameters', () => {
    assert.throws(() => calculateDelay(0), /attempt/)
    assert.throws(() => calculateDelay(1, 0), /baseMs/)
    assert.throws(() => calculateDelay(1, 500, 0), /maxMs/)
  })
})

describe('retry classification', () => {
  it('never retries AbortError, including DOMException AbortError', () => {
    const error = new Error('cancelled')
    error.name = 'AbortError'
    assert.equal(isRetryable(error), false)
    assert.equal(isRetryable(new DOMException('cancelled', 'AbortError')), false)
  })

  it('does not classify an unrelated DOMException as cancellation or retryable', () => {
    assert.equal(isRetryable(new DOMException('bad state', 'InvalidStateError')), false)
  })

  it('recognizes transient status and network failures', () => {
    assert.equal(isRetryable(Object.assign(new Error('busy'), { status: 429 })), true)
    assert.equal(isRetryable(Object.assign(new Error('bad'), { status: 400 })), false)
    assert.equal(isRetryable(new Error('fetch failed')), true)
  })
})

describe('Retry-After', () => {
  it('supports milliseconds, seconds, dates and case-insensitive headers', () => {
    assert.equal(retryAfterMs(Object.assign(new Error(), {
      responseHeaders: { 'Retry-After-Ms': '125' },
    })), 125)
    assert.equal(retryAfterMs(Object.assign(new Error(), {
      responseHeaders: { 'retry-after': '2.5' },
    })), 2_500)
    assert.equal(retryAfterMs(Object.assign(new Error(), {
      responseHeaders: { 'retry-after': new Date(10_000).toUTCString() },
    }), 5_000), 5_000)
  })

  it('takes precedence over local backoff', () => {
    const error = Object.assign(new Error(), {
      responseHeaders: { 'retry-after-ms': '42' },
    })
    assert.equal(calculateRetryDelay(error, 10), 42)
  })
})

describe('sleep', () => {
  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('stop', 'AbortError'))
    await assert.rejects(sleep(1_000, controller.signal), { name: 'AbortError' })
  })

  it('interrupts an active wait', async () => {
    const controller = new AbortController()
    const pending = sleep(10_000, controller.signal)
    controller.abort(new DOMException('stop', 'AbortError'))
    await assert.rejects(pending, { name: 'AbortError' })
  })
})
