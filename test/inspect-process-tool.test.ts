import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ToolRegistry } from '../src/core/tool-registry.js'
import { Workspace } from '../src/core/workspace.js'
import { ExecutionRouter } from '../src/execution/execution-router.js'
import type { ExecutionRequest, Executor } from '../src/execution/executor.js'
import {
  dispatchResolvedInvocation,
  preflightResolvedInvocation,
} from '../src/execution/internal-tool-dispatch.js'
import {
  INSPECT_PROCESS_TOOL_NAME,
  WORKSPACE_INSPECT_HELPER_PATH,
  buildWorkspaceInspectHelperArgv,
  createInspectProcessTool,
  parseInspectProcessInput,
} from '../src/tools/builtins/inspect-process-tool.js'

const safeInput = (query = 'needle', path = '.') => ({
  action: 'search_text' as const,
  path,
  limit: 25,
  query,
})

describe('inspect workspace process tool', () => {
  it('declares a semantic-input, offline, read-only sandbox contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-inspect-process-'))
    try {
      const workspace = new Workspace(root)
      const [tool] = [createInspectProcessTool(workspace)]
      assert.equal(tool.name, INSPECT_PROCESS_TOOL_NAME)
      assert.equal(tool.executionKind, 'process')
      assert.deepEqual(tool.getCapabilities!(safeInput()), ['process.execute', 'filesystem.read'])
      assert.deepEqual(tool.getConstraints!(safeInput()), {
        filesystemReadRoots: [workspace.root],
        requireSandbox: true,
        maxResultChars: 3_000,
      })
      assert.deepEqual(tool.supportedConstraintKeys, ['filesystemReadRoots', 'requireSandbox'])
      assert.equal(
        typeof tool.isConcurrencySafe === 'function'
          ? tool.isConcurrencySafe(safeInput())
          : tool.isConcurrencySafe,
        false,
      )
      await assert.rejects(tool.execute(safeInput(), {
        signal: new AbortController().signal,
        deadline: Date.now() + 1_000,
        capabilities: ['process.execute', 'filesystem.read'],
        constraints: { filesystemReadRoots: [root], requireSandbox: true },
      }), /只能由 SandboxExecutor/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects executable/env injection, unknown actions and workspace escapes', () => {
    assert.throws(() => parseInspectProcessInput({
      ...safeInput(), command: '/bin/sh',
    }), /合法 action/)
    assert.throws(() => parseInspectProcessInput({
      ...safeInput(), env: { PATH: '/tmp/unsafe' },
    }), /合法 action/)
    assert.throws(() => parseInspectProcessInput({
      action: 'shell', path: '.', limit: 25,
    }), /合法 action/)
    assert.throws(() => parseInspectProcessInput(safeInput('needle', '../outside')), /合法 action/)
    assert.throws(() => parseInspectProcessInput(safeInput('needle', '/etc')), /合法 action/)
    assert.throws(() => parseInspectProcessInput(safeInput('needle', 'src\tsecret')), /合法 action/)
    assert.throws(() => parseInspectProcessInput(safeInput('needle\tsecret', 'src')), /合法 query/)
  })

  it('maps semantic input to one fixed versioned helper argv', () => {
    const input = safeInput('$(touch should-not-run);`id`', 'src')
    const parsed = parseInspectProcessInput(input)
    assert.deepEqual(parsed, input)
    assert.equal(Object.isFrozen(parsed), true)
    assert.deepEqual(buildWorkspaceInspectHelperArgv(input), [
      WORKSPACE_INSPECT_HELPER_PATH,
      'v1',
      'search_text',
      '25',
      'src',
      '$(touch should-not-run);`id`',
    ])
  })

  it('enforces the helper UTF-8 byte limits for multibyte paths and queries', () => {
    const exactBoundary = `${'界'.repeat(85)}a`
    const overBoundary = `${exactBoundary}b`
    assert.equal(Buffer.byteLength(exactBoundary, 'utf8'), 256)
    assert.equal(Buffer.byteLength(overBoundary, 'utf8'), 257)

    assert.equal(parseInspectProcessInput(safeInput('needle', exactBoundary)).path, exactBoundary)
    assert.equal(parseInspectProcessInput(safeInput(exactBoundary, 'src')).query, exactBoundary)
    assert.throws(
      () => parseInspectProcessInput(safeInput('needle', overBoundary)),
      /合法 action/,
    )
    assert.throws(
      () => parseInspectProcessInput(safeInput(overBoundary, 'src')),
      /合法 query/,
    )
  })

  it('routes the approved frozen argv through SandboxExecutor and never calls the host closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-inspect-route-'))
    let observed: ExecutionRequest | undefined
    const sandbox: Executor = {
      kind: 'sandbox',
      probe: async () => ({ available: true }),
      supports: (kind, constraints, capabilities) => kind === 'process'
        && constraints.requireSandbox === true
        && capabilities?.join(',') === 'process.execute,filesystem.read',
      execute: async (request) => {
        observed = request
        return { outcome: 'succeeded', rawOutput: 'src/index.ts:1:needle' }
      },
      close: async () => {},
    }
    const registry = new ToolRegistry({
      executionRouter: new ExecutionRouter({ profile: 'production', processExecutor: sandbox }),
    })
    try {
      registry.register(createInspectProcessTool(new Workspace(root)))
      const resolved = registry.resolveInvocation(INSPECT_PROCESS_TOOL_NAME, safeInput(), 'call-1')
      assert.equal(resolved.ok, true)
      if (!resolved.ok) return
      const plan = preflightResolvedInvocation(registry, resolved.invocation, resolved.invocation.constraints)
      assert.equal(plan.backend, 'sandbox')
      const result = await dispatchResolvedInvocation(registry, resolved.invocation, {
        signal: new AbortController().signal,
        deadline: Date.now() + 5_000,
        constraints: resolved.invocation.constraints,
        plan,
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      })
      assert.equal(result.outcome, 'succeeded')
      assert.equal(observed?.toolName, INSPECT_PROCESS_TOOL_NAME)
      assert.deepEqual(observed?.input, safeInput())
      assert.equal(Object.isFrozen(observed?.input), true)
    } finally {
      await registry.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails capability resolution when argv violates the semantic whitelist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-inspect-invalid-'))
    const registry = new ToolRegistry()
    try {
      registry.register(createInspectProcessTool(new Workspace(root)))
      const resolution = registry.resolveInvocation(INSPECT_PROCESS_TOOL_NAME, {
        action: 'list_files',
        path: '.',
        limit: 20,
        query: 'query-is-forbidden-for-list',
      }, 'call-invalid')
      assert.deepEqual(resolution.ok, false)
      if (resolution.ok) return
      assert.equal(resolution.code, 'capability_resolution_failed')
    } finally {
      await registry.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
