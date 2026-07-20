type LockKind = 'read' | 'write'

interface Waiter {
  kind: LockKind
  resolve: (release: () => void) => void
}

function once(release: () => void) {
  let released = false
  return () => {
    if (released) return
    released = true
    release()
  }
}

/** 公平的先进先出读写锁：排队的写操作不会因新读操作不断进入而饿死。 */
export class AsyncReadWriteLock {
  private activeReaders = 0
  private activeWriter = false
  private readonly queue: Waiter[] = []

  acquireRead() {
    return this.acquire('read')
  }

  acquireWrite() {
    return this.acquire('write')
  }

  private acquire(kind: LockKind) {
    return new Promise<() => void>((resolve) => {
      this.queue.push({ kind, resolve })
      this.drain()
    })
  }

  private drain() {
    if (this.activeWriter || this.queue.length === 0) return

    if (this.queue[0].kind === 'write') {
      if (this.activeReaders > 0) return
      const waiter = this.queue.shift()!
      this.activeWriter = true
      waiter.resolve(once(() => {
        this.activeWriter = false
        this.drain()
      }))
      return
    }

    while (this.queue[0]?.kind === 'read' && !this.activeWriter) {
      const waiter = this.queue.shift()!
      this.activeReaders++
      waiter.resolve(once(() => {
        this.activeReaders--
        this.drain()
      }))
    }
  }
}
