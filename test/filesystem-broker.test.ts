import assert from 'node:assert/strict'
import { link, mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  FilesystemBroker,
  FilesystemBrokerUnavailableError,
} from '../src/execution/filesystem-broker.js'
import { executeProcess } from '../src/execution/process-executor.js'

function control() {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
  }
}

describe('FilesystemBroker', () => {
  it('uses bounded reads and atomic same-directory replacement', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-fs-broker-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const target = join(root, 'notes.txt')
    await writeFile(target, 'before', { mode: 0o640 })
    const broker = new FilesystemBroker(root)

    assert.equal(await broker.readText(target, 64, control()), 'before')
    await broker.writeTextAtomic(target, 'after', 64, control())
    assert.equal(await readFile(target, 'utf8'), 'after')
    assert.deepEqual(await readdir(root), ['notes.txt'])
    await assert.rejects(broker.readText(target, 2, control()), /超过 2 字节/)
    await assert.rejects(broker.writeTextAtomic(target, 'oversized', 2, control()), /超过 2 字节/)
  })

  it('refuses final and parent symlinks instead of following them outside the workspace', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-fs-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'super-agent-fs-outside-'))
    context.after(() => Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]))
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(join(outside, 'secret.txt'), join(root, 'alias.txt'))
    const broker = new FilesystemBroker(root)

    await assert.rejects(broker.readText(join(root, 'alias.txt'), 64, control()))
    await assert.rejects(broker.writeTextAtomic(join(root, 'alias.txt'), 'changed', 64, control()))
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside')

    await mkdir(join(root, 'real-parent'))
    await rm(join(root, 'real-parent'), { recursive: true })
    await symlink(outside, join(root, 'real-parent'))
    await assert.rejects(
      broker.writeTextAtomic(join(root, 'real-parent', 'new.txt'), 'changed', 64, control()),
    )
    await assert.rejects(readFile(join(outside, 'new.txt')))

    const hardlink = join(root, 'innocent-hardlink.txt')
    await link(join(outside, 'secret.txt'), hardlink)
    await assert.rejects(broker.readText(hardlink, 64, control()), /hardlink/)
  })

  it('propagates cancellation and refuses production anchoring off Linux', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-fs-control-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const target = join(root, 'notes.txt')
    await writeFile(target, 'safe')
    const aborted = new AbortController()
    aborted.abort(new DOMException('cancelled', 'AbortError'))
    const broker = new FilesystemBroker(root, { platform: 'darwin' })

    await assert.rejects(
      broker.readText(target, 64, { signal: aborted.signal, deadline: Date.now() + 10_000 }),
      { name: 'AbortError' },
    )
    assert.deepEqual(await broker.probe(), {
      available: false,
      reasonCode: 'filesystem_broker_platform_unsupported',
    })
    assert.throws(
      () => new FilesystemBroker(root, {
        platform: 'darwin',
        requireDescriptorAnchoring: true,
      }),
      FilesystemBrokerUnavailableError,
    )
  })

  it('enumerates through the Broker without following directory or file symlinks', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-fs-walk-'))
    const outside = await mkdtemp(join(tmpdir(), 'super-agent-fs-walk-outside-'))
    context.after(() => Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]))
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'safe.ts'), 'safe')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'outside-link'))
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'))
    const broker = new FilesystemBroker(root)
    context.after(() => broker.close())

    const listed = await broker.listDirectory(root, 10, control())
    assert.deepEqual(listed.map((entry) => [entry.name, entry.kind]).sort(), [
      ['outside-link', 'other'],
      ['secret-link.txt', 'other'],
      ['src', 'directory'],
    ])
    assert.deepEqual(await broker.walkFiles(root, {
      maxFiles: 10,
      maxEntries: 20,
    }, control()), [join(root, 'src', 'safe.ts')])
  })

  it('opens special files non-blocking and rejects them before IO', {
    skip: process.platform === 'win32' && 'mkfifo is POSIX-only',
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-fs-fifo-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const fifo = join(root, 'blocked.fifo')
    const created = await executeProcess({ command: 'mkfifo', args: [fifo], timeoutMs: 2_000 })
    assert.equal(created.terminationReason, 'exited')
    assert.equal(created.exitCode, 0)
    const broker = new FilesystemBroker(root)
    context.after(() => broker.close())

    await assert.rejects(broker.readText(fifo, 64, control()), /普通文件/)
    await assert.rejects(broker.writeTextAtomic(fifo, 'safe', 64, control()), /替换普通文件/)
  })

  it('probes the real Linux descriptor anchor when available', {
    skip: process.platform !== 'linux' && 'Linux-only /proc/self/fd integration',
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-fs-linux-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const broker = new FilesystemBroker(root, { requireDescriptorAnchoring: true })
    context.after(() => broker.close())
    assert.deepEqual(await broker.probe(), { available: true })
    const target = join(root, 'linux.txt')
    await broker.writeTextAtomic(target, 'anchored', 64, control())
    assert.equal(await broker.readText(target, 64, control()), 'anchored')
  })

  it('fails closed when the workspace pathname is swapped after the root FD is pinned', {
    skip: process.platform !== 'linux' && 'Linux-only persistent root FD integration',
  }, async (context) => {
    const parent = await mkdtemp(join(tmpdir(), 'super-agent-fs-root-swap-'))
    const root = join(parent, 'workspace')
    const original = join(parent, 'workspace-original')
    await mkdir(root)
    await writeFile(join(root, 'target.txt'), 'original')
    const broker = new FilesystemBroker(root, { requireDescriptorAnchoring: true })
    context.after(() => broker.close())
    context.after(() => rm(parent, { recursive: true, force: true }))

    await rename(root, original)
    await mkdir(root)
    await writeFile(join(root, 'target.txt'), 'swapped')

    await assert.rejects(
      broker.readText(join(root, 'target.txt'), 64, control()),
      /root identity 已变化/,
    )
    assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'swapped')
  })
})
