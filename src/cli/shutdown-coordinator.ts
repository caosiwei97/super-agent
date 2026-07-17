export const DEFAULT_SHUTDOWN_ACTIVE_WAIT_TIMEOUT_MS = 4_000
export const DEFAULT_SHUTDOWN_CLOSE_WAIT_TIMEOUT_MS = 4_500

export class ShutdownTimeoutError extends Error {
  readonly code = 'shutdown_active_wait_timeout'

  constructor(readonly timeoutMs: number) {
    super(`等待活跃任务关闭超过 ${timeoutMs}ms`)
    this.name = 'ShutdownTimeoutError'
  }
}

export class ShutdownCloseTimeoutError extends Error {
  readonly code = 'shutdown_close_wait_timeout'

  constructor(readonly timeoutMs: number) {
    super(`等待运行时资源关闭超过 ${timeoutMs}ms`)
    this.name = 'ShutdownCloseTimeoutError'
  }
}

export interface ShutdownTimer {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

const systemTimer: ShutdownTimer = Object.freeze({
  set: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clear: (handle: unknown) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
})

export interface ShutdownCoordinatorOptions {
  abortActive(reason: unknown): void
  waitForActive(): void | Promise<void>
  closeResources(): void | Promise<void>
  activeWaitTimeoutMs?: number
  closeWaitTimeoutMs?: number
  timer?: ShutdownTimer
}

/**
 * Coordinates one process-agnostic shutdown attempt.
 *
 * The first reason wins. Re-entrant callers share the same completion promise,
 * while resource closing is attempted even when aborting or waiting fails.
 * A timeout bounds how long the coordinator waits; JavaScript cannot cancel the
 * losing Promise, so CLI callers must terminate the process after timeout.
 */
export class ShutdownCoordinator {
  private readonly activeWaitTimeoutMs: number
  private readonly closeWaitTimeoutMs: number
  private readonly timer: ShutdownTimer
  private shutdownPromise: Promise<void> | undefined

  constructor(private readonly options: ShutdownCoordinatorOptions) {
    this.activeWaitTimeoutMs = options.activeWaitTimeoutMs ?? DEFAULT_SHUTDOWN_ACTIVE_WAIT_TIMEOUT_MS
    if (!Number.isFinite(this.activeWaitTimeoutMs) || this.activeWaitTimeoutMs < 0) {
      throw new Error('activeWaitTimeoutMs 必须是非负有限数')
    }
    this.closeWaitTimeoutMs = options.closeWaitTimeoutMs ?? DEFAULT_SHUTDOWN_CLOSE_WAIT_TIMEOUT_MS
    if (!Number.isFinite(this.closeWaitTimeoutMs) || this.closeWaitTimeoutMs < 0) {
      throw new Error('closeWaitTimeoutMs 必须是非负有限数')
    }
    this.timer = options.timer ?? systemTimer
  }

  shutdown(reason: unknown): Promise<void> {
    if (!this.shutdownPromise) {
      // Defer work until after assigning the promise so abortActive may safely
      // call shutdown() re-entrantly without starting a second shutdown.
      this.shutdownPromise = Promise.resolve().then(() => this.performShutdown(reason))
    }
    return this.shutdownPromise
  }

  private async performShutdown(reason: unknown) {
    const errors: unknown[] = []

    try {
      this.options.abortActive(reason)
    } catch (error) {
      errors.push(error)
    }

    try {
      await this.waitForActiveWithinTimeout()
    } catch (error) {
      errors.push(error)
    }

    try {
      await this.closeResourcesWithinTimeout()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, '关闭过程中发生多个错误')
  }

  private async waitForActiveWithinTimeout() {
    await this.runWithinTimeout(
      () => this.options.waitForActive(),
      this.activeWaitTimeoutMs,
      () => new ShutdownTimeoutError(this.activeWaitTimeoutMs),
    )
  }

  private async closeResourcesWithinTimeout() {
    await this.runWithinTimeout(
      () => this.options.closeResources(),
      this.closeWaitTimeoutMs,
      () => new ShutdownCloseTimeoutError(this.closeWaitTimeoutMs),
    )
  }

  private async runWithinTimeout(
    operation: () => void | Promise<void>,
    timeoutMs: number,
    timeoutError: () => Error,
  ) {
    let pending: Promise<void>
    try {
      pending = Promise.resolve(operation())
    } catch (error) {
      pending = Promise.reject(error)
    }

    let timeoutHandle: unknown
    let timeoutScheduled = false
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.timer.set(() => {
        reject(timeoutError())
      }, timeoutMs)
      timeoutScheduled = true
    })

    try {
      await Promise.race([pending, timeout])
    } finally {
      if (timeoutScheduled) this.timer.clear(timeoutHandle)
    }
  }
}
