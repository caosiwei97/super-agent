import { runCli } from '../../src/cli/main.js'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { SessionStore } from '../../src/session/store.js'

const [directory] = process.argv.slice(2)
if (!directory) throw new Error('missing working directory')

process.chdir(directory)
process.env.SUPER_AGENT_EXECUTION_PROFILE = 'development'
process.env.SUPER_AGENT_WORKSPACE = directory
delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN

ToolRegistry.prototype.close = async () => await new Promise<never>(() => undefined)

const originalStoreClose = SessionStore.prototype.close
SessionStore.prototype.close = async function closeWithProof(this: SessionStore) {
  await originalStoreClose.call(this)
  console.log('STORE_CLOSED')
}

try {
  await runCli(['chat', '--continue', '--session', 'hung-close'])
  throw new Error('runCli unexpectedly accepted a missing session')
} catch (error) {
  const errors = error instanceof AggregateError ? error.errors : [error]
  if (!errors.some((value) => value instanceof Error && /会话不存在/.test(value.message))) {
    throw error
  }
  console.log('CLEANUP_DONE')
}
