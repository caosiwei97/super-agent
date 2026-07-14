import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { calculateDelay } from '../src/agent/retry.js'

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
