import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Workspace, WorkspaceBoundaryError } from '../src/core/workspace.js'
import {
  createWebTools,
  getUrlConstraints,
  isPublicAddress,
  validatePublicUrl,
} from '../src/tools/builtins/web-tools.js'

describe('Workspace', () => {
  it('blocks lexical traversal and symlink escapes for reads and writes', async (context) => {
    const parent = await mkdtemp(join(tmpdir(), 'super-agent-workspace-'))
    context.after(() => rm(parent, { recursive: true, force: true }))
    const root = join(parent, 'root')
    const outside = join(parent, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'escape'))
    await symlink(join(outside, 'not-created.txt'), join(root, 'dangling'))
    const workspace = new Workspace(root)

    assert.throws(() => workspace.resolveExisting('../outside/secret.txt'), WorkspaceBoundaryError)
    assert.throws(() => workspace.resolveExisting('escape/secret.txt'), WorkspaceBoundaryError)
    assert.throws(() => workspace.resolveForWrite('escape/new.txt'), WorkspaceBoundaryError)
    assert.throws(() => workspace.resolveForWrite('dangling'), /路径不存在/)
    assert.equal(workspace.resolveForWrite('inside.txt'), join(workspace.root, 'inside.txt'))
  })
})

describe('web tool SSRF guard', () => {
  it('blocks IANA special-purpose, mapped, compatible and scoped addresses', () => {
    for (const address of [
      '0.0.0.1',
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.31.196.1',
      '192.52.193.1',
      '192.88.99.2',
      '192.175.48.1',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '::127.0.0.1',
      '::8.8.8.8',
      'fc00::1',
      'fe80::1',
      'fe80::1%lo0',
      '2606:4700:4700::1111%eth0',
      'fec0::1',
      '100:0:0:1::1',
      '2001:2::1',
      '2001:20::1',
      '2001:30::1',
      '2002:7f00:1::',
      '64:ff9b::7f00:1',
      '64:ff9b:1::a00:1',
      '2620:4f:8000::1',
      '3fff::1',
      '4000::1',
      '5f00::1',
    ]) {
      assert.equal(isPublicAddress(address), false, address)
    }
    assert.equal(isPublicAddress('93.184.216.34'), true)
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  })

  it('rejects a hostname if any DNS answer is non-public', async () => {
    for (const special of [
      { address: '127.0.0.1', family: 4 },
      { address: '64:ff9b:1::a00:1', family: 6 },
      { address: '::ffff:127.0.0.1', family: 6 },
    ]) {
      await assert.rejects(
        validatePublicUrl('https://mixed.example/path', async () => [
          { address: '93.184.216.34', family: 4 },
          special,
        ]),
        /禁止访问非公网地址/,
      )
    }
  })

  it('revalidates redirect targets and handles malformed URLs as tool output', async () => {
    let dials = 0
    const [fetchTool] = createWebTools({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      dial: async () => {
        dials++
        return {
          status: 302,
          headers: { location: 'http://127.0.0.1/private' },
          body: '',
        }
      },
    })
    const context = {
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      capabilities: ['network.egress', 'external.read'] as const,
      constraints: getUrlConstraints('https://public.example'),
    }

    assert.match(
      String(await fetchTool.execute({ url: 'https://public.example' }, context)),
      /超出已授权网络约束/,
    )
    assert.equal(dials, 1)
    assert.match(
      String(await fetchTool.execute({ url: 'not a url' }, context)),
      /抓取失败：Invalid URL|抓取失败：无效 URL/,
    )
  })

  it('propagates the root abort signal through the pinned dialer', async () => {
    let dialSignal: AbortSignal | undefined
    const [fetchTool] = createWebTools({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      dial: async (request) => {
        dialSignal = request.signal
        return new Promise((_resolve, reject) => {
          dialSignal!.addEventListener('abort', () => reject(dialSignal!.reason), { once: true })
        })
      },
    })
    const controller = new AbortController()
    const execution = fetchTool.execute({ url: 'https://public.example' }, {
      signal: controller.signal,
      deadline: Date.now() + 60_000,
      capabilities: ['network.egress', 'external.read'],
      constraints: getUrlConstraints('https://public.example'),
    })

    const waitDeadline = Date.now() + 2_000
    while (!dialSignal) {
      if (Date.now() >= waitDeadline) throw new Error('dial did not start')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    controller.abort(new DOMException('cancel fetch', 'AbortError'))

    await assert.rejects(execution, { name: 'AbortError' })
    assert.equal(dialSignal.aborted, true)
  })
})
