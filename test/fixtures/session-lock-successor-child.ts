import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionStore } from '../../src/session/store.js'

const [directory, sessionId, gate] = process.argv.slice(2)
if (!directory || !sessionId || !gate) throw new Error('缺少 successor child 参数')

process.stdout.write('WAITING\n')
while (!existsSync(gate)) await delay(5)

try {
  const store = await SessionStore.open(sessionId, { directory })
  await store.appendEvent({ type: 'test.successor', pid: process.pid }, 'durable')
  process.stdout.write('ACQUIRED\n')

  process.once('SIGTERM', () => {
    void store.close().finally(() => process.exit(0))
  })
  setInterval(() => {}, 60_000)
} catch (error) {
  if (error instanceof Error && /锁|lock|writer|写者/i.test(error.message)) {
    process.stdout.write('LOCKED\n')
    process.exit(0)
  }
  throw error
}
