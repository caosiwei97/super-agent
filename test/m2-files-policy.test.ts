import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolExecutionContext,
} from '../src/core/tool-registry.js'
import { Workspace } from '../src/core/workspace.js'
import { ToolExecutionPipeline } from '../src/execution/tool-execution-pipeline.js'
import { isSensitivePath } from '../src/security/sensitive-paths.js'
import { SessionStore } from '../src/session/store.js'
import { createFileTools } from '../src/tools/builtins/file-tools.js'
import { createPreviewTools } from '../src/tools/builtins/preview-tools.js'

function tool(tools: ToolDefinition[], name: string) {
  const found = tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function runtime(
  capabilities: ToolExecutionContext['capabilities'],
  constraints: ToolExecutionContext['constraints'],
): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    capabilities,
    constraints,
  }
}

async function availablePort() {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('failed to allocate port')
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return address.port
}

describe('M2 file capability policy', () => {
  it('strictly classifies the credential path families', () => {
    for (const path of [
      '/work/.env',
      '/work/.env.production',
      '/work/.ssh/id_ed25519',
      '/work/.aws/credentials',
      '/work/.config/gcloud/application_default_credentials.json',
      '/work/.azure/accessTokens.json',
      '/work/.kube/config',
      '/work/.npmrc',
      '/work/.netrc',
      '/work/.git-credentials',
      '/work/.pypirc',
      '/work/cert.pem',
      '/work/signing.key',
      '/work/service-account.json',
      '/work/project-credentials.json',
      '/Users/test/Library/Keychains/login.keychain-db',
      '/Users/test/Library/Keychains',
      '/work/signing.keychain',
    ]) assert.equal(isSensitivePath(path), true, path)

    for (const path of [
      '/work/.environment',
      '/work/.ssh/known_hosts',
      '/work/.aws/config',
      '/work/credentials.txt',
      '/work/monkey',
      '/work/login.keychains',
      '/work/keychain-db',
    ]) assert.equal(isSensitivePath(path), false, path)
  })

  it('uses canonical realpaths for capabilities and rechecks execution constraints', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-files-'))
    let store: SessionStore | undefined
    context.after(async () => {
      await store?.close()
      await rm(root, { recursive: true, force: true })
    })
    await writeFile(join(root, '.env'), 'ARBITRARY_VALUE=canonical-secret')
    await writeFile(join(root, 'ordinary.txt'), 'ordinary')
    await symlink('.env', join(root, 'innocent.txt'))
    const workspace = new Workspace(root)
    const fileTools = createFileTools(workspace)
    const read = tool(fileTools, 'read_file')

    const warnings: string[] = []
    const registry = new ToolRegistry({ onLegacyWarning: (warning) => warnings.push(warning) })
    registry.register(...fileTools)
    context.after(() => registry.close())
    const resolution = registry.resolveInvocation('read_file', { path: 'innocent.txt' }, 'call-1')
    assert.equal(resolution.ok, true)
    assert.equal(resolution.invocation.securitySource, 'explicit')
    assert.deepEqual(resolution.invocation.capabilities, ['filesystem.read', 'secret.read'])
    assert.deepEqual(resolution.invocation.supportedConstraintKeys, ['filesystemReadRoots'])
    assert.deepEqual(warnings, [])

    store = await SessionStore.open('files-policy', { directory: join(root, '.sessions') })
    const pipeline = new ToolExecutionPipeline(registry, store)
    const batch = await pipeline.executeBatch({
      sessionId: 'files-policy',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
    }, [{
      toolCallId: 'call-pipeline-sensitive-read',
      toolName: 'read_file',
      input: { path: 'innocent.txt' },
    }], { approve: async () => true })
    assert.equal(batch.outcomes[0]?.operation.status, 'succeeded')
    const pipelineMessage = JSON.stringify(batch.outcomes[0]?.message)
    assert.match(pipelineMessage, /\[REDACTED\]/)
    assert.doesNotMatch(pipelineMessage, /canonical-secret/)

    const capabilities = read.getCapabilities!({ path: 'innocent.txt' })
    const constraints = read.getConstraints!({ path: 'innocent.txt' })
    assert.deepEqual(capabilities, ['filesystem.read', 'secret.read'])
    assert.deepEqual(constraints.filesystemReadRoots, [join(workspace.root, '.env')])

    await assert.rejects(
      read.execute({ path: 'innocent.txt' }, runtime(['filesystem.read'], constraints)),
      /secret\.read/,
    )
    assert.equal(
      await read.execute({ path: 'innocent.txt' }, runtime(capabilities, constraints)),
      'ARBITRARY_VALUE=canonical-secret',
    )
    await assert.rejects(
      read.execute({ path: 'ordinary.txt' }, runtime(['filesystem.read'], constraints)),
      /执行约束不允许/,
    )
  })

  it('derives per-operation capabilities and hides secrets from broad search', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-search-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'notes.txt'), 'needle public')
    await writeFile(join(root, '.env'), 'needle private')
    await writeFile(join(root, 'service-account.json'), '{"needle":"credential"}')
    const workspace = new Workspace(root)
    const tools = createFileTools(workspace)
    const grep = tool(tools, 'grep')
    const glob = tool(tools, 'glob')
    const write = tool(tools, 'write_file')
    const edit = tool(tools, 'edit_file')

    assert.deepEqual(write.getCapabilities!({ path: '.env', content: 'replacement' }), ['filesystem.write'])
    assert.deepEqual(
      edit.getCapabilities!({ path: '.env', old_string: 'private', new_string: 'changed' }),
      ['filesystem.read', 'filesystem.write', 'secret.read'],
    )

    const broadGrepConstraints = grep.getConstraints!({ pattern: 'needle', path: '.' })
    const broadGrep = String(await grep.execute(
      { pattern: 'needle', path: '.' },
      runtime(['filesystem.read'], broadGrepConstraints),
    ))
    assert.match(broadGrep, /notes\.txt/)
    assert.doesNotMatch(broadGrep, /private|credential|\.env|service-account/)

    const broadGlobConstraints = glob.getConstraints!({ pattern: '**/*', path: '.' })
    const broadGlob = String(await glob.execute(
      { pattern: '**/*', path: '.' },
      runtime(['filesystem.read'], broadGlobConstraints),
    ))
    assert.match(broadGlob, /notes\.txt/)
    assert.doesNotMatch(broadGlob, /\.env|service-account/)
    assert.deepEqual(
      glob.getCapabilities!({ pattern: '**/.env*', path: '.' }),
      ['filesystem.read', 'secret.read'],
    )

    const explicitCapabilities = grep.getCapabilities!({ pattern: 'needle', path: '.env' })
    const explicitConstraints = grep.getConstraints!({ pattern: 'needle', path: '.env' })
    assert.deepEqual(explicitCapabilities, ['filesystem.read', 'secret.read'])
    assert.match(String(await grep.execute(
      { pattern: 'needle', path: '.env' },
      runtime(explicitCapabilities, explicitConstraints),
    )), /private/)
  })
})

describe('M2 preview policy', () => {
  it('binds approved loopback constraints and never serves sensitive files', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-preview-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'app'))
    await writeFile(join(root, 'app', 'index.html'), '<h1>safe</h1>')
    await writeFile(join(root, 'app', '.env'), 'TOKEN=preview-secret')
    await symlink('.env', join(root, 'app', 'alias.txt'))
    const workspace = new Workspace(root)
    const preview = tool(createPreviewTools(workspace), 'start_preview')
    const port = await availablePort()
    const capabilities = preview.getCapabilities!({ port })
    const constraints = preview.getConstraints!({ port })

    assert.deepEqual(capabilities, ['filesystem.read', 'process.execute'])
    assert.deepEqual(constraints.filesystemReadRoots, [join(workspace.root, 'app')])
    assert.deepEqual(constraints.networkHosts, ['127.0.0.1'])
    assert.deepEqual(constraints.loopbackListenPorts, [port])

    const registry = new ToolRegistry()
    registry.register(preview)
    context.after(() => registry.close())
    const resolution = registry.resolveInvocation('start_preview', { port }, 'call-preview')
    assert.equal(resolution.ok, true)
    assert.deepEqual(resolution.invocation.supportedConstraintKeys, [
      'filesystemReadRoots',
      'networkHosts',
      'networkPorts',
      'allowLoopbackListen',
      'loopbackListenPorts',
    ])
    await assert.rejects(
      preview.execute({ port }, runtime(capabilities, { ...constraints, loopbackListenPorts: [port + 1] })),
      /不允许监听/,
    )

    await preview.execute({ port }, runtime(capabilities, constraints))
    context.after(() => preview.dispose?.())
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${port}/.env`)).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/alias.txt`)).status, 403)
  })
})
