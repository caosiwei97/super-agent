import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Workspace, WorkspaceBoundaryError } from '../src/core/workspace.js'
import {
  createWebTools,
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
  it('blocks local, private, mapped and transition addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '::1',
      '::ffff:127.0.0.1',
      '::127.0.0.1',
      'fc00::1',
      'fe80::1',
      'fec0::1',
      '2002:7f00:1::',
      '64:ff9b::7f00:1',
    ]) {
      assert.equal(isPublicAddress(address), false, address)
    }
    assert.equal(isPublicAddress('93.184.216.34'), true)
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  })

  it('rejects a hostname if any DNS answer is non-public', async () => {
    await assert.rejects(
      validatePublicUrl('https://mixed.example/path', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
      /禁止访问非公网地址/,
    )
  })

  it('revalidates redirect targets and handles malformed URLs as tool output', async () => {
    let fetches = 0
    const [fetchTool] = createWebTools({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async () => {
        fetches++
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/private' },
        })
      },
    })
    const context = {
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
    }

    assert.match(
      String(await fetchTool.execute({ url: 'https://public.example' }, context)),
      /禁止访问非公网地址/,
    )
    assert.equal(fetches, 1)
    assert.match(
      String(await fetchTool.execute({ url: 'not a url' }, context)),
      /抓取失败：Invalid URL|抓取失败：无效 URL/,
    )
  })

  it('propagates the root abort signal through fetch', async () => {
    let fetchSignal: AbortSignal | undefined
    const [fetchTool] = createWebTools({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async (_input, init) => {
        fetchSignal = init?.signal as AbortSignal
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal!.addEventListener('abort', () => reject(fetchSignal!.reason), { once: true })
        })
      },
    })
    const controller = new AbortController()
    const execution = fetchTool.execute({ url: 'https://public.example' }, {
      signal: controller.signal,
      deadline: Date.now() + 60_000,
    })

    const waitDeadline = Date.now() + 2_000
    while (!fetchSignal) {
      if (Date.now() >= waitDeadline) throw new Error('fetch did not start')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    controller.abort(new DOMException('cancel fetch', 'AbortError'))

    await assert.rejects(execution, { name: 'AbortError' })
    assert.equal(fetchSignal.aborted, true)
  })
})
