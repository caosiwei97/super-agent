import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ToolRegistry } from '../src/core/tool-registry.js'
import { Workspace } from '../src/core/workspace.js'
import { ToolExecutionPipeline } from '../src/execution/tool-execution-pipeline.js'
import {
  assertMcpEndpointConstraints,
  createMCPGuardedFetch,
  MCPClient,
} from '../src/mcp/mcp-client.js'
import { SessionStore } from '../src/session/store.js'
import { createShellTools } from '../src/tools/builtins/shell-tools.js'
import { utilityTools } from '../src/tools/builtins/utility-tools.js'
import { createWebTools, getUrlConstraints } from '../src/tools/builtins/web-tools.js'
import { createToolSearch } from '../src/tools/meta/create-tool-search.js'

function runtime() {
  return {
    sessionId: 'm2-external',
    turnId: 'turn-1',
    stepId: 'step-1',
    requestId: 'request-1',
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
  }
}

describe('M2 external tool policy migration', () => {
  it('marks utility and tool_search calls as explicit pure concurrent work', () => {
    const warnings: string[] = []
    const registry = new ToolRegistry({ onLegacyWarning: (warning) => warnings.push(warning) })
    registry.register(...utilityTools, createToolSearch(registry))
    const cases = [
      ['get_weather', { city: '北京' }],
      ['calculator', { expression: '1 + 1' }],
      ['tool_search', { query: 'missing' }],
    ] as const
    for (const [name, input] of cases) {
      const resolved = registry.resolveInvocation(name, input, `call-${name}`)
      assert.equal(resolved.ok, true)
      if (!resolved.ok) continue
      assert.deepEqual(resolved.invocation.capabilities, [])
      assert.equal(resolved.invocation.isConcurrencySafe, true)
      assert.equal(resolved.invocation.securitySource, 'explicit')
    }
    assert.deepEqual(warnings, [])
  })

  it('exposes only the normalized MCP endpoint origin for policy binding', () => {
    const client = new MCPClient({ url: 'https://MCP.Example:443/rpc?tenant=private' })
    assert.equal(client.endpointOrigin, 'https://mcp.example')
  })

  it('fails closed before MCP transport unless endpoint constraints match exactly', async () => {
    const client = new MCPClient({ url: 'https://mcp.example/rpc' })
    let transportCalls = 0
    ;(client as unknown as { client: { callTool: () => Promise<unknown> } }).client = {
      callTool: async () => {
        transportCalls++
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    }
    const baseContext = {
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      capabilities: ['network.egress', 'external.write'] as const,
      constraints: {},
    }

    await assert.rejects(
      client.callTool('probe', {}, baseContext),
      /超出已授权网络约束/,
    )
    await assert.rejects(
      client.callTool('probe', {}, {
        ...baseContext,
        constraints: {
          networkSchemes: ['https'],
          networkHosts: ['other.example'],
          networkPorts: [443],
        },
      }),
      /超出已授权网络约束/,
    )
    assert.equal(transportCalls, 0)

    assert.doesNotThrow(() => assertMcpEndpointConstraints(client.endpointOrigin, {
      networkSchemes: ['https'],
      networkHosts: ['mcp.example'],
      networkPorts: [443],
    }))
    assert.equal(await client.callTool('probe', {}, {
      ...baseContext,
      constraints: {
        networkSchemes: ['https'],
        networkHosts: ['mcp.example'],
        networkPorts: [443],
      },
    }), 'ok')
    assert.equal(transportCalls, 1)
  })

  it('forces manual redirects and refuses cross-origin MCP redirects without following', async () => {
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
    const guardedFetch = createMCPGuardedFetch(async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        redirect: init?.redirect,
      })
      return new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/mcp' },
      })
    })

    await assert.rejects(
      guardedFetch('https://mcp.example/rpc', { redirect: 'follow' }),
      /拒绝 HTTP redirect: 302/,
    )
    assert.deepEqual(requests, [{
      url: 'https://mcp.example/rpc',
      redirect: 'manual',
    }])
  })

  it('resolves fetch capabilities and exact URL constraints dynamically', () => {
    const registry = new ToolRegistry()
    registry.register(...createWebTools())
    const resolved = registry.resolveInvocation(
      'fetch_url',
      { url: 'https://Example.COM:443/path' },
      'call-fetch',
    )
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.deepEqual(resolved.invocation.capabilities, ['network.egress', 'external.read'])
    assert.deepEqual(resolved.invocation.constraints, {
      networkSchemes: ['https'],
      networkHosts: ['example.com'],
      networkPorts: [443],
      maxResultChars: 1_500,
    })
    assert.deepEqual(resolved.invocation.supportedConstraintKeys, [
      'networkSchemes',
      'networkHosts',
      'networkPorts',
    ])
    assert.equal(resolved.invocation.isConcurrencySafe, true)
  })

  it('checks policy constraints before DNS/fetch and on every redirect', async () => {
    const lookups: string[] = []
    let fetches = 0
    const [fetchTool] = createWebTools({
      lookup: async (hostname) => {
        lookups.push(hostname)
        return [{ address: '93.184.216.34', family: 4 }]
      },
      fetch: async () => {
        fetches++
        return new Response(null, {
          status: 302,
          headers: { location: 'https://other.example/private' },
        })
      },
    })
    const context = {
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      capabilities: ['network.egress', 'external.read'] as const,
      constraints: getUrlConstraints('https://public.example'),
    }

    assert.match(
      String(await fetchTool.execute({ url: 'https://public.example/start' }, context)),
      /超出已授权网络约束/,
    )
    assert.equal(fetches, 1)
    assert.deepEqual(lookups, ['public.example'])

    fetches = 0
    lookups.length = 0
    assert.match(
      String(await fetchTool.execute({ url: 'https://unapproved.example' }, context)),
      /超出已授权网络约束/,
    )
    assert.equal(fetches, 0)
    assert.deepEqual(lookups, [])
  })

  it('hard-denies bash before approval or execution even with an auto-approve handler', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-m2-bash-'))
    const store = await SessionStore.open('m2-external', { directory: root })
    const registry = new ToolRegistry()
    context.after(async () => {
      await registry.close().catch(() => undefined)
      await store.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    })

    let approvals = 0
    let executions = 0
    const [bash] = createShellTools(new Workspace(root))
    registry.register({
      ...bash,
      execute: async () => {
        executions++
        return 'must not run'
      },
    })
    const resolved = registry.resolveInvocation(
      'bash',
      { command: 'echo should-not-run' },
      'resolve-bash',
    )
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.equal(resolved.invocation.constraints.requireSandbox, true)
    assert.deepEqual(resolved.invocation.supportedConstraintKeys, [
      'filesystemReadRoots',
      'filesystemWriteRoots',
      'requireSandbox',
    ])
    const result = await new ToolExecutionPipeline(registry, store, {
      policySource: { type: 'cli', nonInteractive: true },
    }).executeBatch(runtime(), [{
      toolCallId: 'call-bash',
      toolName: 'bash',
      input: { command: 'echo should-not-run' },
    }], {
      approve: async () => {
        approvals++
        return true
      },
    })

    assert.equal(result.outcomes[0]?.operation.status, 'denied')
    assert.equal(result.outcomes[0]?.operation.latestEvent.errorCode, 'policy_denied')
    assert.deepEqual(result.outcomes[0]?.operation.latestEvent.capabilitySet, [
      'process.execute',
      'filesystem.read',
      'filesystem.write',
      'network.egress',
      'secret.read',
    ])
    assert.equal(approvals, 0)
    assert.equal(executions, 0)
  })
})
