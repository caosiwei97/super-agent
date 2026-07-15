import { SessionStore } from '../../src/session/store.js'

const [directory, sessionId] = process.argv.slice(2)
if (!directory || !sessionId) throw new Error('缺少 session child 参数')

const store = await SessionStore.open(sessionId, { directory })
await store.appendEvent({ type: 'test.child-ready', pid: process.pid }, 'durable')
process.stdout.write('READY\n')

// The parent deliberately sends SIGKILL. Keep both the lock and journal handle
// open so the recovery path observes a real crashed writer.
setInterval(() => {}, 60_000)
