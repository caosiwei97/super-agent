import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { SessionStore } from '../src/session/store.js'

async function waitForLine(
  child: ReturnType<typeof spawn>,
  lines: ReturnType<typeof createInterface>,
  expected: string,
  stderr: () => string,
) {
  return new Promise<void>((resolve, reject) => {
    const onLine = (line: string) => {
      if (line.trim() !== expected) return
      child.off('exit', onExit)
      lines.off('line', onLine)
      resolve()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      lines.off('line', onLine)
      reject(new Error(
        `child exited before ${expected}: code=${String(code)} signal=${String(signal)} ${stderr()}`,
      ))
    }
    lines.on('line', onLine)
    child.once('exit', onExit)
  })
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runSigtermCase(directory: string, mode: 'success' | 'fail-close') {
  const fixture = fileURLToPath(new URL('./fixtures/sigterm-repl-child.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, directory, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  await waitForLine(child, lines, 'READY', () => stderr)
  assert.equal(child.kill('SIGTERM'), true)
  const [code, signal] = await waitForExit(child)
  lines.close()
  return { code, signal, stderr }
}

async function runOneShotSignalCase(
  directory: string,
  sentSignal: 'SIGINT' | 'SIGTERM',
  mode?: 'fail-close',
) {
  const fixture = fileURLToPath(new URL('./fixtures/sigterm-run-child.ts', import.meta.url))
  const child = spawn(process.execPath, [
    '--import', 'tsx', fixture, directory, ...(mode ? [mode] : []),
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  try {
    await waitForLine(child, lines, 'ACTIVE', () => stderr)
    assert.equal(child.kill(sentSignal), true)
    const [code, signal] = await waitForExit(child)
    return { code, signal, stderr }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    lines.close()
  }
}

describe('SIGTERM shutdown', () => {
  it('cancels a one-shot active model turn before flushing and closing', {
    skip: process.platform === 'win32' ? 'SIGTERM process semantics are POSIX-only' : false,
    timeout: 20_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sigterm-run-'))
    try {
      const result = await runOneShotSignalCase(root, 'SIGTERM')
      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: 143, signal: null },
        result.stderr,
      )

      const successor = await SessionStore.open('sigterm-run', { directory: root })
      const events = await successor.replayEvents()
      assert.ok(events.some(({ type }) => type === 'messages'))
      await successor.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses 130 for a cleanly released one-shot SIGINT cancellation', {
    skip: process.platform === 'win32' ? 'SIGINT process semantics are POSIX-only' : false,
    timeout: 20_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sigint-run-'))
    try {
      const result = await runOneShotSignalCase(root, 'SIGINT')
      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: 130, signal: null },
        result.stderr,
      )

      const successor = await SessionStore.open('sigterm-run', { directory: root })
      assert.ok((await successor.replayEvents()).some(({ type }) => type === 'messages'))
      await successor.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses 1 when one-shot SIGTERM cleanup cannot flush the Store', {
    skip: process.platform === 'win32' ? 'SIGTERM process semantics are POSIX-only' : false,
    timeout: 20_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sigterm-run-close-failure-'))
    try {
      const result = await runOneShotSignalCase(root, 'SIGTERM', 'fail-close')
      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: 1, signal: null },
        result.stderr,
      )
      assert.match(result.stderr, /Shutdown/i)

      const successor = await SessionStore.open('sigterm-run', { directory: root })
      await successor.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds runCli fallback cleanup when the registry close promise never settles', {
    skip: process.platform === 'win32' ? 'subprocess timing assertion is POSIX-only' : false,
    timeout: 10_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-runcli-close-'))
    const fixture = fileURLToPath(new URL('./fixtures/runcli-hung-close-child.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const startedAt = Date.now()
    try {
      const [code, signal] = await waitForExit(child)
      assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr)
      assert.ok(Date.now() - startedAt < 4_000, 'composition-root cleanup must stay bounded')
      assert.match(stdout, /STORE_CLOSED/)
      assert.match(stdout, /CLEANUP_DONE/)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds a one-shot provider that ignores abort and releases the writer lock', {
    skip: process.platform === 'win32' ? 'POSIX signal semantics are required' : false,
    timeout: 10_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sigterm-run-stuck-'))
    const fixture = fileURLToPath(new URL('./fixtures/sigterm-run-child.ts', import.meta.url))
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fixture, root, 'noncooperative'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    try {
      await waitForLine(child, lines, 'ACTIVE', () => stderr)
      const startedAt = Date.now()
      assert.equal(child.kill('SIGTERM'), true)
      const [code, signal] = await waitForExit(child)
      assert.deepEqual({ code, signal }, { code: 1, signal: null }, stderr)
      assert.ok(Date.now() - startedAt < 3_000, 'shutdown must not inherit the 60s turn timeout')
      assert.match(stderr, /Shutdown|活跃任务|timeout/i)

      const successor = await SessionStore.open('sigterm-run', { directory: root })
      assert.ok((await successor.replayEvents()).some(({ type }) => type === 'messages'))
      await successor.close()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      lines.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('flushes a buffered journal record and releases the writer lock', {
    skip: process.platform === 'win32' ? 'SIGTERM process semantics are POSIX-only' : false,
    timeout: 20_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sigterm-'))
    try {
      const result = await runSigtermCase(root, 'success')
      assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null })

      const successor = await SessionStore.open('sigterm', { directory: root })
      assert.deepEqual(
        (await successor.replayEvents()).map(({ type, sequence }) => ({ type, sequence })),
        [{ type: 'test.buffered-before-sigterm', sequence: 1 }],
      )
      await successor.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exits nonzero on flush failure but still releases the writer lock', {
    skip: process.platform === 'win32' ? 'SIGTERM process semantics are POSIX-only' : false,
    timeout: 20_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sigterm-failure-'))
    try {
      const result = await runSigtermCase(root, 'fail-close')
      assert.deepEqual({ code: result.code, signal: result.signal }, { code: 1, signal: null })
      assert.match(result.stderr, /shutdown|EIO|datasync/i)

      const successor = await SessionStore.open('sigterm', { directory: root })
      assert.deepEqual((await successor.replayEvents()).map(({ sequence }) => sequence), [1])
      await successor.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds a non-cooperative REPL tool and bypasses a stuck registry close', {
    skip: process.platform === 'win32' ? 'POSIX signal semantics are required' : false,
    timeout: 10_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sigterm-repl-stuck-'))
    const fixture = fileURLToPath(new URL('./fixtures/sigterm-repl-child.ts', import.meta.url))
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fixture, root, 'noncooperative-tool'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    try {
      await waitForLine(child, lines, 'READY', () => stderr)
      const active = waitForLine(child, lines, 'ACTIVE', () => stderr)
      child.stdin.write('run the tool\n')
      await active

      const startedAt = Date.now()
      assert.equal(child.kill('SIGTERM'), true)
      const [code, signal] = await waitForExit(child)
      assert.deepEqual({ code, signal }, { code: 1, signal: null }, stderr)
      assert.ok(Date.now() - startedAt < 3_000)
      assert.match(stderr, /Shutdown|活跃任务|registry|关闭/i)

      const successor = await SessionStore.open('sigterm', { directory: root })
      assert.ok(
        (await successor.replayEvents()).some(({ type }) => type === 'test.buffered-before-sigterm'),
      )
      await successor.close()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      lines.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses a second idle SIGINT as force exit while close is stuck', {
    skip: process.platform === 'win32' ? 'POSIX signal semantics are required' : false,
    timeout: 10_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-sigint-repl-force-'))
    const fixture = fileURLToPath(new URL('./fixtures/sigterm-repl-child.ts', import.meta.url))
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fixture, root, 'slow-close'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    try {
      await waitForLine(child, lines, 'READY', () => stderr)
      const closing = waitForLine(child, lines, 'CLOSING', () => stderr)
      assert.equal(child.kill('SIGINT'), true)
      await closing
      assert.equal(child.kill('SIGINT'), true)
      const [code, signal] = await waitForExit(child)
      assert.deepEqual({ code, signal }, { code: 130, signal: null }, stderr)

      const successor = await SessionStore.open('sigterm', { directory: root })
      await successor.close()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      lines.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
