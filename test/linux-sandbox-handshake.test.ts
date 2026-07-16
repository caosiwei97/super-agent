import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import {
  assertBlockedSandboxChildIdentity,
  parseLinuxProcessStartTime,
  readBlockedSandboxChildIdentity,
  SandboxHandshakeError,
  readBlockedSandboxChildPid,
  releaseBlockedSandboxChild,
} from '../src/execution/linux-sandbox-handshake.js'

describe('Linux sandbox pre-exec handshake', () => {
  it('parses Linux starttime even when comm contains spaces and closing parentheses', () => {
    const suffix = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '424242']
    assert.equal(parseLinuxProcessStartTime(`123 (bwrap ) child) ${suffix.join(' ')}`), '424242')
    assert.throws(() => parseLinuxProcessStartTime('malformed'), SandboxHandshakeError)
    assert.throws(
      () => parseLinuxProcessStartTime(`123 (bwrap) ${suffix.slice(0, 19).join(' ')}`),
      SandboxHandshakeError,
    )
  })

  it('parses a bounded bwrap child PID and releases one byte', async () => {
    const info = new PassThrough()
    const reading = readBlockedSandboxChildPid(info, {
      signal: new AbortController().signal,
      deadline: Date.now() + 1_000,
    })
    info.end('{"child-pid":1234,"unshare-pid":true}')
    assert.equal(await reading, 1234)

    const block = new PassThrough()
    const released: Buffer[] = []
    block.on('data', (chunk: Buffer) => released.push(chunk))
    await releaseBlockedSandboxChild(block)
    assert.deepEqual(Buffer.concat(released), Buffer.from([1]))
  })

  it('rejects malformed, oversized, cancelled and expired control data', async () => {
    for (const payload of ['{}', '[]', '{"child-pid":0}', 'not-json']) {
      const info = new PassThrough()
      const reading = readBlockedSandboxChildPid(info, {
        signal: new AbortController().signal,
        deadline: Date.now() + 1_000,
      })
      info.end(payload)
      await assert.rejects(reading, SandboxHandshakeError)
    }

    const oversized = new PassThrough()
    const bounded = readBlockedSandboxChildPid(oversized, {
      signal: new AbortController().signal,
      deadline: Date.now() + 1_000,
      maxBytes: 8,
    })
    oversized.end('{"child-pid":1234}')
    await assert.rejects(bounded, /大小限制/)

    const controller = new AbortController()
    controller.abort(new DOMException('stop', 'AbortError'))
    await assert.rejects(
      readBlockedSandboxChildPid(new PassThrough(), {
        signal: controller.signal,
        deadline: Date.now() + 1_000,
      }),
      { name: 'AbortError' },
    )
    await assert.rejects(
      readBlockedSandboxChildPid(new PassThrough(), {
        signal: new AbortController().signal,
        deadline: Date.now() - 1,
      }),
      { name: 'TimeoutError' },
    )
  })

  it('binds a Linux child PID to executable inode and starttime', {
    skip: process.platform === 'linux' ? false : 'requires Linux /proc',
  }, async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      stdio: 'ignore',
    })
    assert.ok(child.pid)
    try {
      const executable = await stat(process.execPath)
      const identity = await readBlockedSandboxChildIdentity(
        child.pid,
        `${executable.dev}:${executable.ino}`,
      )
      assert.equal(identity.pid, child.pid)
      await assertBlockedSandboxChildIdentity(identity)
      await assert.rejects(
        readBlockedSandboxChildIdentity(child.pid, '1:1'),
        /executable identity/,
      )
    } finally {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('close', () => resolve()))
    }
  })
})
