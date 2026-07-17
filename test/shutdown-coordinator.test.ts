import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ShutdownCloseTimeoutError,
  ShutdownCoordinator,
  ShutdownTimeoutError,
  type ShutdownTimer,
} from '../src/cli/shutdown-coordinator.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class ManualTimer implements ShutdownTimer {
  callback: (() => void) | undefined
  delayMs: number | undefined
  readonly handle = Object.freeze({ type: 'manual-shutdown-timer' })
  cleared = false

  set(callback: () => void, delayMs: number) {
    this.callback = callback
    this.delayMs = delayMs
    return this.handle
  }

  clear(handle: unknown) {
    assert.equal(handle, this.handle)
    this.cleared = true
  }

  fire() {
    assert.ok(this.callback, 'expected a scheduled shutdown timeout')
    this.callback()
  }
}

describe('ShutdownCoordinator', () => {
  it('aborts, waits, then closes exactly once across re-entrant calls', async () => {
    const order: string[] = []
    const active = deferred()
    const reason = new Error('SIGTERM')
    let nestedShutdown: Promise<void> | undefined
    let observedReason: unknown
    let coordinator!: ShutdownCoordinator

    coordinator = new ShutdownCoordinator({
      abortActive: (value) => {
        order.push('abort')
        observedReason = value
        nestedShutdown = coordinator.shutdown(new Error('nested reason'))
      },
      waitForActive: () => {
        order.push('wait')
        return active.promise
      },
      closeResources: () => {
        order.push('close')
      },
    })

    const first = coordinator.shutdown(reason)
    const second = coordinator.shutdown(new Error('later reason'))
    assert.equal(first, second)

    await Promise.resolve()
    assert.equal(nestedShutdown, first)
    assert.equal(observedReason, reason)
    assert.deepEqual(order, ['abort', 'wait'])

    active.resolve()
    await first
    assert.deepEqual(order, ['abort', 'wait', 'close'])
    assert.equal(coordinator.shutdown(new Error('after close')), first)
  })

  it('still closes resources when the active turn rejects', async () => {
    const order: string[] = []
    const activeError = new Error('active turn failed')
    const coordinator = new ShutdownCoordinator({
      abortActive: () => { order.push('abort') },
      waitForActive: async () => {
        order.push('wait')
        throw activeError
      },
      closeResources: () => { order.push('close') },
    })

    await assert.rejects(coordinator.shutdown(new Error('stop')), (error) => error === activeError)
    assert.deepEqual(order, ['abort', 'wait', 'close'])
  })

  it('times out deterministically and still closes resources', async () => {
    const order: string[] = []
    const active = deferred()
    const timer = new ManualTimer()
    const coordinator = new ShutdownCoordinator({
      abortActive: () => { order.push('abort') },
      waitForActive: () => {
        order.push('wait')
        return active.promise
      },
      closeResources: () => { order.push('close') },
      activeWaitTimeoutMs: 25,
      timer,
    })

    const shutdown = coordinator.shutdown(new Error('timeout test'))
    await Promise.resolve()
    assert.equal(timer.delayMs, 25)
    timer.fire()

    await assert.rejects(shutdown, (error: unknown) => {
      assert.ok(error instanceof ShutdownTimeoutError)
      assert.equal(error.code, 'shutdown_active_wait_timeout')
      assert.equal(error.timeoutMs, 25)
      return true
    })
    assert.deepEqual(order, ['abort', 'wait', 'close'])
    assert.equal(timer.cleared, true)
    active.resolve()
  })

  it('propagates a close failure after a successful active wait', async () => {
    const closeError = new Error('close failed')
    const coordinator = new ShutdownCoordinator({
      abortActive: () => undefined,
      waitForActive: () => undefined,
      closeResources: async () => { throw closeError },
    })

    await assert.rejects(coordinator.shutdown(new Error('stop')), (error) => error === closeError)
  })

  it('bounds a close callback that never settles', async () => {
    const close = deferred()
    const timer = new ManualTimer()
    const coordinator = new ShutdownCoordinator({
      abortActive: () => undefined,
      waitForActive: () => undefined,
      closeResources: () => close.promise,
      activeWaitTimeoutMs: 25,
      closeWaitTimeoutMs: 40,
      timer,
    })

    const shutdown = coordinator.shutdown(new Error('close timeout test'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(timer.delayMs, 40)
    timer.fire()

    await assert.rejects(shutdown, (error: unknown) => {
      assert.ok(error instanceof ShutdownCloseTimeoutError)
      assert.equal(error.code, 'shutdown_close_wait_timeout')
      assert.equal(error.timeoutMs, 40)
      return true
    })
    close.resolve()
  })

  it('aggregates active-turn and close failures without losing either', async () => {
    const activeError = new Error('active failed')
    const closeError = new Error('close failed')
    const coordinator = new ShutdownCoordinator({
      abortActive: () => undefined,
      waitForActive: async () => { throw activeError },
      closeResources: async () => { throw closeError },
    })

    await assert.rejects(coordinator.shutdown(new Error('stop')), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [activeError, closeError])
      return true
    })
  })

  it('continues through an abort callback failure and aggregates all failures', async () => {
    const order: string[] = []
    const abortError = new Error('abort failed')
    const waitError = new Error('wait failed')
    const closeError = new Error('close failed')
    const coordinator = new ShutdownCoordinator({
      abortActive: () => {
        order.push('abort')
        throw abortError
      },
      waitForActive: () => {
        order.push('wait')
        throw waitError
      },
      closeResources: () => {
        order.push('close')
        throw closeError
      },
    })

    await assert.rejects(coordinator.shutdown(new Error('stop')), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [abortError, waitError, closeError])
      return true
    })
    assert.deepEqual(order, ['abort', 'wait', 'close'])
  })
})
