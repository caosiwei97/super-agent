import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import {
  releaseSelfHeldBlockFd,
  cleanupStaleSelfHeldBlockDirectories,
  withSelfHeldBlockFd,
} from '../src/execution/linux-self-held-block.js'
import { executeProcess } from '../src/execution/process-executor.js'

const linux = process.platform === 'linux'

async function crashBlockDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'super-agent-block-fd-'))
  await chmod(directory, 0o700)
  const gate = join(directory, 'gate')
  const created = await executeProcess({
    command: '/usr/bin/mkfifo',
    args: ['-m', '600', gate],
    timeoutMs: 2_000,
  })
  assert.equal(created.exitCode, 0)
  return { directory, gate }
}

it('releases a self-held block FD only after the explicit byte', {
  skip: linux ? false : 'requires Linux FIFO semantics',
}, async () => {
  const mkfifo = '/usr/bin/mkfifo'
  assert.equal((await stat(mkfifo)).isFile(), true)
  await withSelfHeldBlockFd(mkfifo, new AbortController().signal, async (handle) => {
    let observed = false
    const execution = executeProcess({
      command: process.execPath,
      args: ['-e', [
        "const fs=require('node:fs')",
        'const value=Buffer.alloc(1)',
        'fs.readSync(3,value,0,1,null)',
        "process.stdout.write(value[0]===1?'released':'wrong')",
      ].join(';')],
      extraFileDescriptors: [handle.fd],
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    void execution.then(() => { observed = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(observed, false)
    await releaseSelfHeldBlockFd(handle)
    const result = await execution
    assert.equal(result.terminationReason, 'exited')
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'released')
  })
})

it('reaps only exact, private, single-link FIFO crash remnants', {
  skip: linux ? false : 'requires Linux FIFO semantics',
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'super-agent-block-cleanup-test-'))
  const valid = await crashBlockDirectory()
  const fresh = await crashBlockDirectory()
  const publicMode = await crashBlockDirectory()
  const hardlinked = await crashBlockDirectory()
  const special = await mkdtemp(join(tmpdir(), 'super-agent-block-fd-'))
  const nested = await mkdtemp(join(tmpdir(), 'super-agent-block-fd-'))
  const fakePrefix = await mkdtemp(join(tmpdir(), 'super-agent-block-fd-fake-'))
  const paths = [
    valid.directory,
    fresh.directory,
    publicMode.directory,
    hardlinked.directory,
    special,
    nested,
    fakePrefix,
  ]
  try {
    await chmod(publicMode.directory, 0o755)
    await link(hardlinked.gate, join(fixtureRoot, 'outside-gate-link'))
    await chmod(special, 0o700)
    await writeFile(join(special, 'gate'), 'not a fifo', { mode: 0o600 })
    await chmod(nested, 0o700)
    await mkdir(join(nested, 'child'), { mode: 0o700 })
    await chmod(fakePrefix, 0o700)
    const now = Date.now()
    const minimumAgeMs = 30 * 24 * 60 * 60 * 1_000
    const old = new Date(now - minimumAgeMs * 2)
    await Promise.all([
      valid.directory,
      publicMode.directory,
      hardlinked.directory,
      special,
      nested,
      fakePrefix,
    ].map((path) => utimes(path, old, old)))
    assert.equal(await cleanupStaleSelfHeldBlockDirectories(minimumAgeMs, now), 1)
    await assert.rejects(stat(valid.directory), { code: 'ENOENT' })
    for (const path of paths.slice(1)) {
      assert.equal((await stat(path)).isDirectory(), true)
    }
  } finally {
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

it('does not turn parent SIGKILL into EOF for the blocked child', {
  skip: linux ? false : 'requires Linux FIFO and process semantics',
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'super-agent-block-crash-test-'))
  const marker = join(fixtureRoot, 'released.txt')
  const before = new Set((await readdir(tmpdir())).filter(
    (name) => name.startsWith('super-agent-block-fd-'),
  ))
  const parent = spawn(process.execPath, [
    '--import',
    'tsx',
    'test/fixtures/self-held-block-parent.ts',
    marker,
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let blockedPid: number | undefined
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffered = ''
      parent.stdout!.setEncoding('utf8')
      parent.stdout!.on('data', (chunk: string) => {
        buffered += chunk
        const newline = buffered.indexOf('\n')
        if (newline >= 0) resolve(buffered.slice(0, newline))
      })
      parent.once('error', reject)
      parent.once('close', () => reject(new Error('block parent closed before reporting child')))
    })
    blockedPid = Number(line)
    assert.equal(Number.isSafeInteger(blockedPid) && blockedPid > 1, true)
    parent.kill('SIGKILL')
    await new Promise<void>((resolve) => parent.once('close', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 250))
    await assert.rejects(stat(marker), { code: 'ENOENT' })
    assert.doesNotThrow(() => process.kill(blockedPid!, 0))
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    if (blockedPid !== undefined) {
      try { process.kill(blockedPid, 'SIGKILL') } catch {}
    }
    const after = (await readdir(tmpdir())).filter(
      (name) => name.startsWith('super-agent-block-fd-') && !before.has(name),
    )
    await Promise.all(after.map((name) => rm(join(tmpdir(), name), { recursive: true, force: true })))
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
