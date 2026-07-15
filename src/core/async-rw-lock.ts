type LockKind = 'read' | 'write'

interface Waiter {
  kind: LockKind
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

function once(release: () => void) {
  let released = false
  return () => {
    if (released) return
    released = true
    release()
  }
}

/** Fair FIFO read/write lock: queued writers cannot be starved by new readers. */
export class AsyncReadWriteLock {
  private activeReaders = 0
  private activeWriter = false
  private readonly queue: Waiter[] = []

  acquireRead(signal?: AbortSignal) {
    return this.acquire('read', signal)
  }

  acquireWrite(signal?: AbortSignal) {
    return this.acquire('write', signal)
  }

  private acquire(kind: LockKind, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(this.abortReason(signal))
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { kind, resolve, reject, ...(signal ? { signal } : {}) }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter)
          if (index < 0) return
          this.queue.splice(index, 1)
          signal.removeEventListener('abort', waiter.onAbort!)
          reject(this.abortReason(signal))
          this.drain()
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
      this.drain()
    })
  }

  private abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Lock acquisition aborted', 'AbortError')
  }

  private accept(waiter: Waiter, release: () => void) {
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
    waiter.resolve(once(release))
  }

  private drain() {
    if (this.activeWriter || this.queue.length === 0) return

    if (this.queue[0].kind === 'write') {
      if (this.activeReaders > 0) return
      const waiter = this.queue.shift()!
      this.activeWriter = true
      this.accept(waiter, () => {
        this.activeWriter = false
        this.drain()
      })
      return
    }

    while (this.queue[0]?.kind === 'read' && !this.activeWriter) {
      const waiter = this.queue.shift()!
      this.activeReaders++
      this.accept(waiter, () => {
        this.activeReaders--
        this.drain()
      })
    }
  }
}
