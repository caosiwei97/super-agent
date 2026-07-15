import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Workspace } from '../src/core/workspace.js'
import { createShellTools } from '../src/tools/builtins/shell-tools.js'

async function waitForPid(path: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('shell child did not become ready')
}

async function processIsGone(pid: number) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

describe('bash tool cancellation', () => {
  it('uses the governed process executor and reaps the process group', {
    skip: process.platform === 'win32' ? 'Windows only guarantees direct-child cancellation' : false,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-shell-cancel-'))
    const pidFile = join(root, 'child.pid')
    let childPid: number | undefined
    context.after(async () => {
      if (childPid) {
        try { process.kill(childPid, 'SIGKILL') } catch { /* already gone */ }
      }
      await rm(root, { recursive: true, force: true })
    })
    const source = [
      "const fs=require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid))`,
      "process.on('SIGTERM',()=>{})",
      'setInterval(()=>{},1000)',
    ].join(';')
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`
    const [bash] = createShellTools(new Workspace(root))
    const controller = new AbortController()
    const execution = bash.execute({ command }, {
      signal: controller.signal,
      deadline: Date.now() + 10_000,
    })

    childPid = await waitForPid(pidFile)
    controller.abort(new DOMException('cancel shell', 'AbortError'))
    await assert.rejects(execution, { name: 'AbortError' })
    assert.equal(await processIsGone(childPid), true)
  })
})
