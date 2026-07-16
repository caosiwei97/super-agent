import assert from 'node:assert/strict'
import { open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  executeProcess,
  killActiveProcessGroupsSync,
} from '../src/execution/process-executor.js'

function nodeScript(source: string, options: Omit<Parameters<typeof executeProcess>[0], 'command' | 'args'> = {}) {
  return executeProcess({
    command: process.execPath,
    args: ['-e', source],
    ...options,
  })
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

async function waitForPidFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 0) return pid
      throw new Error(`ready 文件包含非法 PID: ${String(pid)}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待后代进程 ready 超时: ${path}`)
}

async function cleanupPidFile(path: string) {
  try {
    const pid = Number(await readFile(path, 'utf8'))
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    await rm(path, { force: true })
  }
}

describe('executeProcess', () => {
  it('does not install process-exit cleanup merely by being imported', () => {
    assert.equal(process.listeners('exit').includes(killActiveProcessGroupsSync), false)
  })

  it('captures structured stdout, stderr and non-zero exit status', async () => {
    const result = await nodeScript(
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7",
    )

    assert.equal(result.terminationReason, 'exited')
    assert.equal(result.exitCode, 7)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, 'out')
    assert.equal(result.stderr, 'err')
    assert.equal(result.outputBytes, 6)
    assert.equal(result.outputTruncated, false)
  })

  it('passes arguments without shell interpretation', async () => {
    const value = '$(touch should-not-run); * | literal'
    const result = await executeProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', value],
    })

    assert.equal(result.stdout, value)
    assert.equal(result.terminationReason, 'exited')
  })

  it('inherits only explicit numeric extra file descriptors after stderr', async (context) => {
    const path = join(tmpdir(), `super-agent-extra-fd-${process.pid}-${Date.now()}`)
    const workspacePath = `${path}-workspace`
    await writeFile(path, 'seccomp-profile-bytes')
    await writeFile(workspacePath, 'workspace-anchor-bytes')
    const handle = await open(path, 'r')
    const workspaceHandle = await open(workspacePath, 'r')
    context.after(async () => {
      await handle.close().catch(() => undefined)
      await workspaceHandle.close().catch(() => undefined)
      await rm(path, { force: true })
      await rm(workspacePath, { force: true })
    })

    const result = await nodeScript(
      "const fs=require('node:fs');process.stdout.write(fs.readFileSync(3,'utf8')+'|'+fs.readFileSync(4,'utf8'))",
      { extraFileDescriptors: [handle.fd, workspaceHandle.fd] },
    )
    assert.equal(result.stdout, 'seccomp-profile-bytes|workspace-anchor-bytes')
    assert.equal((await handle.stat()).isFile(), true)
    assert.equal((await workspaceHandle.stat()).isFile(), true)
    await assert.rejects(
      executeProcess({ command: process.execPath, extraFileDescriptors: [-1] }),
      /非负安全整数/,
    )
  })

  it('runs an explicit parent-child spawn gate over inherited pipes', async () => {
    let observedPid: number | undefined
    const result = await nodeScript(
      [
        "const fs=require('node:fs')",
        "fs.writeSync(3,String(process.pid))",
        "const release=Buffer.alloc(1)",
        "fs.readSync(4,release,0,1,null)",
        "process.stdout.write('released:'+release.toString())",
      ].join(';'),
      {
        extraStdio: ['pipe', 'pipe'],
        onSpawn: async ({ pid, extraStdio }) => {
          observedPid = pid
          const [info, release] = extraStdio
          assert.ok(info && 'once' in info)
          assert.ok(release && 'write' in release)
          const childPid = await new Promise<number>((resolve, reject) => {
            info.once('data', (chunk) => resolve(Number(String(chunk))))
            info.once('error', reject)
          })
          assert.equal(childPid, pid)
          release.write(Buffer.from('1'))
        },
      },
    )

    assert.equal(result.pid, observedPid)
    assert.equal(result.terminationReason, 'exited')
    assert.equal(result.stdout, 'released:1')
  })

  it('kills a blocked child when the spawn gate fails', async () => {
    const result = await nodeScript(
      "const fs=require('node:fs');const byte=Buffer.alloc(1);fs.readSync(3,byte,0,1,null)",
      {
        extraStdio: ['pipe'],
        onSpawn: async () => {
          throw new Error('cgroup attach failed')
        },
      },
    )

    assert.equal(result.terminationReason, 'setup_error')
    assert.match(result.error?.message ?? '', /cgroup attach failed/)
  })

  it('records a spawn gate rejection triggered in the child-close tick', async () => {
    const result = await nodeScript('process.exit(0)', {
      onSpawn: ({ signal }) => new Promise<void>((_resolve, reject) => {
        const rejectOnClose = () => reject(new Error('gate rejected while child closed'))
        if (signal.aborted) rejectOnClose()
        else signal.addEventListener('abort', rejectOnClose, { once: true })
      }),
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.terminationReason, 'setup_error')
    assert.match(result.error?.message ?? '', /gate rejected while child closed/)
  })

  it('preserves an established timeout over a same-tick spawn gate rejection', async () => {
    const result = await nodeScript('setInterval(()=>{},1000)', {
      timeoutMs: 30,
      onSpawn: ({ signal }) => new Promise<void>((_resolve, reject) => {
        const rejectOnCancel = () => reject(new Error('gate observed timeout cancellation'))
        if (signal.aborted) rejectOnCancel()
        else signal.addEventListener('abort', rejectOnCancel, { once: true })
      }),
    })

    assert.equal(result.terminationReason, 'timeout')
    assert.equal(result.error, undefined)
  })

  it('cancels and settles a pending spawn gate before returning after child close', async () => {
    let gateSettled = false
    let gateSignal: AbortSignal | undefined
    const result = await nodeScript('process.exit(0)', {
      terminationGraceMs: 100,
      onSpawn: async ({ signal }) => {
        gateSignal = signal
        try {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
          await new Promise((resolve) => setTimeout(resolve, 20))
        } finally {
          gateSettled = true
        }
      },
    })

    assert.equal(result.terminationReason, 'exited')
    assert.equal(gateSignal?.aborted, true)
    assert.equal(gateSettled, true)
  })

  it('cancels a pending info gate on timeout and waits for its cleanup', async () => {
    let gateSettled = false
    const result = await nodeScript(
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      {
        extraStdio: ['pipe'],
        timeoutMs: 200,
        terminationGraceMs: 100,
        onSpawn: async ({ signal, extraStdio }) => {
          const info = extraStdio[0]
          assert.ok(info && 'once' in info)
          try {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', () => resolve(), { once: true })
            })
            await new Promise((resolve) => setTimeout(resolve, 20))
          } finally {
            gateSettled = true
          }
        },
      },
    )

    assert.equal(result.terminationReason, 'timeout')
    assert.equal(result.signal, 'SIGKILL')
    assert.equal(gateSettled, true)
  })

  it('bounds shutdown when a cancelled spawn gate ignores its signal', async () => {
    const startedAt = Date.now()
    const result = await nodeScript('process.exit(0)', {
      terminationGraceMs: 20,
      onSpawn: () => new Promise<void>(() => undefined),
    })

    assert.equal(result.terminationReason, 'exited')
    assert.ok(Date.now() - startedAt < 1_000)
  })

  it('does not take ownership of inherited descriptors on pre-spawn cancellation', async () => {
    const path = join(tmpdir(), `super-agent-cancelled-fd-${process.pid}-${Date.now()}`)
    await writeFile(path, 'still-open')
    const handle = await open(path, 'r')
    const controller = new AbortController()
    controller.abort()
    try {
      const result = await nodeScript('process.exit(99)', {
        signal: controller.signal,
        extraFileDescriptors: [handle.fd],
      })
      assert.equal(result.terminationReason, 'aborted')
      assert.equal((await handle.stat()).isFile(), true)
    } finally {
      await handle.close()
      await rm(path, { force: true })
    }
  })

  it('reaps redirected background descendants after a natural leader exit', {
    skip: process.platform === 'win32' ? 'Windows uses direct-child fallback' : false,
  }, async (context) => {
    const pidFile = join(tmpdir(), `super-agent-natural-descendant-${process.pid}-${Date.now()}.pid`)
    context.after(() => cleanupPidFile(pidFile))
    const childSource = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
    const parentSource = [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'})`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
      'child.unref()',
    ].join(';')

    const result = await nodeScript(parentSource, { terminationGraceMs: 50 })
    const descendantPid = await waitForPidFile(pidFile, 2_000)

    assert.equal(result.terminationReason, 'exited')
    assert.equal(result.exitCode, 0)
    assert.equal(await processIsGone(descendantPid), true, `descendant ${descendantPid} 仍存活`)
  })

  it('synchronously kills active groups for a CLI force-exit path', {
    skip: process.platform === 'win32' ? 'Windows uses direct-child fallback' : false,
  }, async (context) => {
    const pidFile = join(tmpdir(), `super-agent-force-descendant-${process.pid}-${Date.now()}.pid`)
    context.after(() => cleanupPidFile(pidFile))
    const childSource = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
    const parentSource = [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'})`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
      "process.on('SIGTERM',()=>{})",
      "setInterval(()=>{},1000)",
    ].join(';')
    const execution = nodeScript(parentSource)
    const descendantPid = await waitForPidFile(pidFile, 2_000)

    killActiveProcessGroupsSync()
    const result = await execution

    assert.equal(result.signal, 'SIGKILL')
    assert.equal(await processIsGone(descendantPid), true, `descendant ${descendantPid} 仍存活`)
  })

  it('enforces one combined stdout and stderr byte limit', async () => {
    const result = await nodeScript(
      "process.on('SIGTERM',()=>{}); setInterval(()=>{process.stdout.write('12345678');process.stderr.write('abcdefgh')},1)",
      { maxOutputBytes: 97, terminationGraceMs: 30 },
    )

    assert.equal(result.terminationReason, 'output_limit')
    assert.equal(result.outputTruncated, true)
    assert.equal(result.outputBytes, 97)
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 97)
  })

  it('returns a spawn error as structured output', async () => {
    const result = await executeProcess({ command: join(tmpdir(), 'definitely-missing-super-agent-bin') })

    assert.equal(result.terminationReason, 'spawn_error')
    assert.equal(result.exitCode, -2)
    assert.match(result.error?.message ?? '', /ENOENT|spawn/i)
  })

  it('does not spawn when already aborted or past deadline', async () => {
    const controller = new AbortController()
    controller.abort()
    const aborted = await nodeScript("throw new Error('must not run')", { signal: controller.signal })
    const timedOut = await nodeScript("throw new Error('must not run')", { deadline: Date.now() - 1 })

    assert.equal(aborted.terminationReason, 'aborted')
    assert.equal(aborted.pid, undefined)
    assert.equal(timedOut.terminationReason, 'timeout')
    assert.equal(timedOut.pid, undefined)
  })

  it('enforces an absolute deadline while the process is running', async () => {
    const result = await nodeScript(
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
      { deadline: Date.now() + 300, timeoutMs: 10_000, terminationGraceMs: 30 },
    )

    assert.equal(result.terminationReason, 'timeout')
    assert.equal(result.signal, 'SIGKILL')
    assert.ok(result.durationMs < 2_000)
  })

  it('terminates an entire Unix process group on timeout', {
    skip: process.platform === 'win32' ? 'Windows uses direct-child fallback' : false,
  }, async (context) => {
    const pidFile = join(tmpdir(), `super-agent-descendant-${process.pid}-${Date.now()}.pid`)
    context.after(() => cleanupPidFile(pidFile))
    const childSource = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
    const parentSource = [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'})`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
      "process.on('SIGTERM',()=>{})",
      "setInterval(()=>{},1000)",
    ].join(';')

    const execution = nodeScript(parentSource, { timeoutMs: 1_000, terminationGraceMs: 50 })
    let descendantPid: number
    try {
      descendantPid = await waitForPidFile(pidFile, 800)
    } catch (error) {
      await execution
      throw error
    }
    const result = await execution

    assert.equal(result.terminationReason, 'timeout')
    assert.equal(result.signal, 'SIGKILL')
    assert.equal(await processIsGone(descendantPid), true, `descendant ${descendantPid} 仍存活`)
  })

  it('terminates an entire Unix process group when aborted', {
    skip: process.platform === 'win32' ? 'Windows uses direct-child fallback' : false,
  }, async (context) => {
    const pidFile = join(tmpdir(), `super-agent-abort-descendant-${process.pid}-${Date.now()}.pid`)
    context.after(() => cleanupPidFile(pidFile))
    const childSource = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
    const parentSource = [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'})`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
      "process.on('SIGTERM',()=>{})",
      "setInterval(()=>{},1000)",
    ].join(';')
    const controller = new AbortController()
    const execution = nodeScript(parentSource, {
      signal: controller.signal,
      terminationGraceMs: 50,
    })
    let descendantPid: number
    try {
      descendantPid = await waitForPidFile(pidFile, 2_000)
    } catch (error) {
      controller.abort()
      await execution
      throw error
    }
    controller.abort()
    const result = await execution

    assert.equal(result.terminationReason, 'aborted')
    assert.equal(result.signal, 'SIGKILL')
    assert.equal(await processIsGone(descendantPid), true, `descendant ${descendantPid} 仍存活`)
  })
})
