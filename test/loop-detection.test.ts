import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashToolCall, LoopDetector } from '../src/agent/loop-detection.js'

describe('LoopDetector', () => {
  it('hashes object keys deterministically and keeps histories isolated', () => {
    assert.equal(
      hashToolCall('read', { a: 1, b: 2 }),
      hashToolCall('read', { b: 2, a: 1 }),
    )

    const first = new LoopDetector({ warningThreshold: 2 })
    first.recordCall('read', { path: 'a' })
    const warning = first.detect('read', { path: 'a' })
    assert.ok(warning.stuck)
    assert.equal(warning.count, 2)

    const second = new LoopDetector({ warningThreshold: 2 })
    assert.deepEqual(second.detect('read', { path: 'a' }), { stuck: false })
  })

  it('trips the no-progress breaker from results attached to exact records', () => {
    const detector = new LoopDetector({
      warningThreshold: 100,
      criticalThreshold: 100,
      breakerThreshold: 3,
    })

    for (let index = 0; index < 3; index++) {
      const record = detector.recordCall('fetch', { page: 1 })
      detector.recordResult(record, { ok: true, output: 'unchanged' })
    }

    const result = detector.detect('fetch', { page: 1 })
    assert.ok(result.stuck)
    assert.equal(result.detector, 'global_circuit_breaker')
    assert.equal(result.level, 'critical')
  })

  it('detects alternating calls including the pending invocation', () => {
    const detector = new LoopDetector({ warningThreshold: 5, criticalThreshold: 8 })
    for (const value of ['A', 'B', 'A', 'B']) detector.recordCall('read', { value })

    const result = detector.detect('read', { value: 'A' })
    assert.ok(result.stuck)
    assert.equal(result.detector, 'ping_pong')
    assert.equal(result.count, 5)
  })
})
