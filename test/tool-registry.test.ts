import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { streamText } from 'ai'
import { AsyncReadWriteLock } from '../src/core/async-rw-lock.js'
import {
  ToolRegistry,
  type MCPToolClient,
  type ToolDefinition,
} from '../src/core/tool-registry.js'
import {
  dispatchResolvedInvocation,
  type InternalToolDispatchOptions,
} from '../src/execution/internal-tool-dispatch.js'
import { streamSequenceModel } from './helpers.js'

function definition(name: string, execute: ToolDefinition['execute']) {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute,
  }
}

function dispatchOptions() {
  return { signal: new AbortController().signal, deadline: Date.now() + 60_000 }
}

async function dispatchTool(
  registry: ToolRegistry,
  toolName: string,
  input: unknown,
  toolCallId: string,
  options: Omit<InternalToolDispatchOptions, 'constraints'> = dispatchOptions(),
) {
  const resolution = registry.resolveInvocation(toolName, input, toolCallId)
  if (!resolution.ok) throw new Error(`工具 ${toolName} 输入或能力解析无效: ${resolution.error}`)
  return dispatchResolvedInvocation(registry, resolution.invocation, {
    ...options,
    constraints: resolution.invocation.constraints,
  })
}

describe('AsyncReadWriteLock', () => {
  it('lets queued writers run before later readers and tolerates double release', async () => {
    const lock = new AsyncReadWriteLock()
    const order: string[] = []
    const releaseFirstReader = await lock.acquireRead()

    const writer = lock.acquireWrite().then((release) => {
      order.push('writer')
      release()
      release()
    })
    const laterReader = lock.acquireRead().then((release) => {
      order.push('reader')
      release()
    })

    await Promise.resolve()
    assert.deepEqual(order, [])
    releaseFirstReader()
    releaseFirstReader()
    await Promise.all([writer, laterReader])
    assert.deepEqual(order, ['writer', 'reader'])
  })

  it('removes an aborted waiter without poisoning the queue', async () => {
    const lock = new AsyncReadWriteLock()
    const releaseWriter = await lock.acquireWrite()
    const controller = new AbortController()
    const cancelled = lock.acquireRead(controller.signal)
    const next = lock.acquireWrite()

    controller.abort(new DOMException('cancel wait', 'AbortError'))
    await assert.rejects(cancelled, { name: 'AbortError' })
    releaseWriter()
    const releaseNext = await next
    releaseNext()
  })
})

describe('ToolRegistry', () => {
  it('does not expose a public dispatch bypass', () => {
    const registry = new ToolRegistry()
    assert.equal('dispatchTool' in registry, false)
    assert.equal('dispatchResolved' in registry, false)
  })

  it('resolves dynamic security metadata exactly once and dispatches the frozen snapshot', async () => {
    const registry = new ToolRegistry()
    const calls = { capabilities: 0, constraints: 0, concurrency: 0 }
    let executionContext: Parameters<ToolDefinition['execute']>[1] | undefined
    registry.register({
      name: 'dynamic',
      description: 'dynamic',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      getCapabilities: () => { calls.capabilities++; return ['filesystem.read'] },
      getConstraints: () => { calls.constraints++; return { filesystemReadRoots: ['/safe'] } },
      supportedConstraintKeys: ['filesystemReadRoots'],
      isConcurrencySafe: () => { calls.concurrency++; return true },
      execute: async (_input, context) => { executionContext = context; return 'ok' },
    })

    const resolution = registry.resolveInvocation('dynamic', { path: 'a' }, 'dynamic-call')
    assert.equal(resolution.ok, true)
    if (!resolution.ok) return
    assert.equal(Object.isFrozen(resolution.invocation), true)
    assert.equal(Object.isFrozen(resolution.invocation.input), true)
    assert.deepEqual(calls, { capabilities: 1, constraints: 1, concurrency: 1 })

    const result = await dispatchResolvedInvocation(registry, resolution.invocation, {
      ...dispatchOptions(),
      constraints: resolution.invocation.constraints,
    })
    assert.equal(result.outcome, 'succeeded')
    assert.deepEqual(calls, { capabilities: 1, constraints: 1, concurrency: 1 })
    assert.equal(executionContext?.capabilities, resolution.invocation.capabilities)
    assert.equal(executionContext?.constraints, resolution.invocation.constraints)
  })

  it('prefers explicit security metadata and emits one injectable legacy warning per tool', () => {
    const warnings: string[] = []
    const registry = new ToolRegistry({ onLegacyWarning: (warning) => warnings.push(warning) })
    registry.register(
      definition('legacy', async () => 'ok'),
      {
        ...definition('explicit', async () => 'ok'),
        capabilitySet: ['external.write'],
        isReadOnly: false,
        requiresApproval: true,
        getCapabilities: () => [],
        isConcurrencySafe: () => true,
      },
    )

    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /legacy/)
    const resolved = registry.resolveInvocation('explicit', {}, 'explicit-call')
    assert.equal(resolved.ok, true)
    if (resolved.ok) {
      assert.deepEqual(resolved.invocation.capabilities, [])
      assert.equal(resolved.invocation.legacyRequiresApproval, false)
      assert.equal(resolved.invocation.securitySource, 'explicit')
    }
  })

  it('fails closed for undeclared, loosened, and sandbox constraints before dispatch starts', async () => {
    const undeclared = new ToolRegistry()
    undeclared.register({
      name: 'undeclared',
      description: 'undeclared',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      getCapabilities: () => ['filesystem.read'],
      getConstraints: () => ({ filesystemReadRoots: ['/safe'] }),
      isConcurrencySafe: () => true,
      execute: async () => 'never',
    })
    const badResolution = undeclared.resolveInvocation('undeclared', {}, 'undeclared-call')
    assert.equal(badResolution.ok, false)
    if (!badResolution.ok) assert.match(badResolution.error, /未声明可执行约束/)

    const registry = new ToolRegistry()
    let starts = 0
    let executions = 0
    registry.register({
      name: 'constrained',
      description: 'constrained',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      getCapabilities: () => ['filesystem.read'],
      getConstraints: () => ({ filesystemReadRoots: ['/safe'] }),
      supportedConstraintKeys: ['filesystemReadRoots'],
      isConcurrencySafe: () => true,
      execute: async () => { executions++; return 'never' },
    }, {
      name: 'sandboxed',
      description: 'sandboxed',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      getCapabilities: () => ['process.execute'],
      getConstraints: () => ({ requireSandbox: true }),
      supportedConstraintKeys: ['requireSandbox'],
      isConcurrencySafe: () => false,
      execute: async () => { executions++; return 'never' },
    })
    const constrained = registry.resolveInvocation('constrained', {}, 'constrained-call')
    assert.equal(constrained.ok, true)
    if (!constrained.ok) return
    await assert.rejects(dispatchResolvedInvocation(registry, constrained.invocation, {
      ...dispatchOptions(),
      constraints: { filesystemReadRoots: ['/'] },
      beforeDispatch: () => { starts++ },
    }), /不能放宽/)
    await assert.rejects(dispatchResolvedInvocation(registry, constrained.invocation, {
      ...dispatchOptions(),
      constraints: {
        filesystemReadRoots: ['/safe'],
        networkHosts: ['example.com'],
      },
      beforeDispatch: () => { starts++ },
    }), /不支持执行约束/)
    const sandboxed = registry.resolveInvocation('sandboxed', {}, 'sandbox-call')
    assert.equal(sandboxed.ok, true)
    if (!sandboxed.ok) return
    await assert.rejects(dispatchResolvedInvocation(registry, sandboxed.invocation, {
      ...dispatchOptions(),
      constraints: sandboxed.invocation.constraints,
      beforeDispatch: () => { starts++ },
    }), /requireSandbox 尚无可用执行后端/)
    assert.equal(starts, 0)
    assert.equal(executions, 0)
  })

  it('exposes schema-only model tools and metadata without execution closures', async () => {
    const registry = new ToolRegistry()
    let executions = 0
    const source = definition('read_demo', async () => {
      executions++
      return 'must not run during generation'
    })
    registry.register(source)

    const descriptor = registry.getDescriptor('read_demo')
    assert.ok(descriptor)
    assert.equal('execute' in descriptor, false)
    assert.equal('dispose' in descriptor, false)
    assert.equal(Object.isFrozen(descriptor), true)
    assert.equal(Object.isFrozen(descriptor.parameters), true)

    const modelTools = registry.toModelToolSet() as Record<string, Record<string, unknown>>
    assert.equal('execute' in modelTools.read_demo!, false)
    assert.equal('needsApproval' in modelTools.read_demo!, false)

    const { model } = streamSequenceModel([{ type: 'tools', calls: [
      { id: 'call-1', name: 'read_demo', input: {} },
    ] }])
    const result = streamText({
      model,
      tools: registry.toModelToolSet(),
      messages: [{ role: 'user', content: 'read' }],
      maxRetries: 0,
    })
    for await (const _part of result.fullStream) {
      // Consuming the full model stream must still not invoke the tool closure.
    }
    assert.equal(executions, 0)
    assert.equal((await result.response).messages[0]?.role, 'assistant')
  })

  it('strictly validates and freezes tool input without coercion or unknown fields', async () => {
    const registry = new ToolRegistry()
    let executions = 0
    registry.register({
      ...definition('strict_tool', async () => {
        executions++
        return 'ok'
      }),
      parameters: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
    })

    const valid = registry.validateToolInput('strict_tool', { count: 2 })
    assert.equal(valid.ok, true)
    if (valid.ok) assert.equal(Object.isFrozen(valid.input), true)
    assert.equal(registry.validateToolInput('strict_tool', { count: '2' }).ok, false)
    assert.equal(registry.validateToolInput('strict_tool', { count: 2, surprise: true }).ok, false)
    assert.equal(registry.validateToolInput('missing', {}).ok, false)

    await assert.rejects(
      dispatchTool(registry, 'strict_tool', { count: 2, surprise: true }, 'invalid-call', dispatchOptions()),
      /输入无效|additional properties/i,
    )
    assert.equal(executions, 0)
  })

  it('propagates beforeDispatch failure and never invokes the tool closure', async () => {
    const registry = new ToolRegistry()
    let executions = 0
    registry.register(definition('write', async () => {
      executions++
      return 'wrote'
    }))

    await assert.rejects(
      dispatchTool(registry, 'write', {}, 'call-1', {
        ...dispatchOptions(),
        beforeDispatch: () => {
          throw new Error('durable started failed')
        },
      }),
      /durable started failed/,
    )
    assert.equal(executions, 0)
  })

  it('keeps successful raw output separate from uncertain execution outcome', async () => {
    const registry = new ToolRegistry()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    registry.register(
      definition('circular_result', async () => circular),
      definition('rejected_execution', async () => {
        throw new Error('remote connection disappeared')
      }),
    )

    const dispatched = await dispatchTool(
      registry, 'circular_result', {}, 'call-success', dispatchOptions(),
    )
    assert.equal(dispatched.outcome, 'succeeded')
    if (dispatched.outcome === 'succeeded') assert.equal(dispatched.rawOutput, circular)

    assert.deepEqual(
      await dispatchTool(registry, 'rejected_execution', {}, 'call-unknown', dispatchOptions()),
      {
        outcome: 'uncertain',
        errorCode: 'tool_execution_error',
        descriptor: registry.getDescriptor('rejected_execution'),
      },
    )
  })

  it('keeps concurrency-safe dispatches parallel and serializes unsafe dispatches', async () => {
    const registry = new ToolRegistry()
    let safeActive = 0
    let safeMaxActive = 0
    registry.register(
      definition('safe', async () => {
        safeActive++
        safeMaxActive = Math.max(safeMaxActive, safeActive)
        await new Promise((resolve) => setTimeout(resolve, 10))
        safeActive--
        return 'ok'
      }),
      {
        ...definition('unsafe', async ({ id }: { id: string }) => {
          unsafeOrder.push(`${id}:start`)
          await new Promise((resolve) => setTimeout(resolve, 10))
          unsafeOrder.push(`${id}:end`)
          return id
        }),
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        isConcurrencySafe: false,
      },
    )
    const unsafeOrder: string[] = []

    await Promise.all([
      dispatchTool(registry, 'safe', {}, 'safe-1', dispatchOptions()),
      dispatchTool(registry, 'safe', {}, 'safe-2', dispatchOptions()),
    ])
    assert.equal(safeMaxActive, 2)

    await Promise.all([
      dispatchTool(registry, 'unsafe', { id: 'one' }, 'unsafe-1', dispatchOptions()),
      dispatchTool(registry, 'unsafe', { id: 'two' }, 'unsafe-2', dispatchOptions()),
    ])
    assert.deepEqual(unsafeOrder, ['one:start', 'one:end', 'two:start', 'two:end'])
  })

  it('rejects duplicate registration and disposes resources only once', async () => {
    const registry = new ToolRegistry()
    let disposed = 0
    registry.register({
      ...definition('resource', async () => 'ok'),
      dispose: () => {
        disposed++
      },
    })

    assert.throws(() => registry.register(definition('resource', async () => 'again')), /重复注册/)
    assert.throws(
      () => registry.register(
        definition('must-not-leak', async () => 'new'),
        definition('resource', async () => 'duplicate'),
      ),
      /重复注册/,
    )
    assert.equal(registry.get('must-not-leak'), undefined)
    await registry.close()
    await registry.close()
    assert.equal(disposed, 1)
    await assert.rejects(
      dispatchTool(registry, 'resource', {}, 'late-call', dispatchOptions()),
      /已关闭/,
    )
    assert.throws(() => registry.register(definition('late', async () => 'no')), /已关闭/)
  })

  it('rolls back an MCP client when tool discovery fails', async () => {
    const registry = new ToolRegistry()
    let closed = 0
    const client: MCPToolClient = {
      endpointOrigin: 'https://broken.example',
      connect: async () => {},
      listTools: async () => {
        throw new Error('discovery failed')
      },
      callTool: async () => 'unused',
      close: async () => {
        closed++
      },
    }

    await assert.rejects(registry.registerMCPServer('broken', client), /discovery failed/)
    assert.equal(closed, 1)
    await registry.close()
    assert.equal(closed, 1, 'failed clients must not remain registered for shutdown')
  })

  it('passes the same cancellation context into MCP calls', async () => {
    const registry = new ToolRegistry()
    let observedSignal: AbortSignal | undefined
    let observedDeadline: number | undefined
    const client: MCPToolClient = {
      endpointOrigin: 'https://mcp.example:8443',
      connect: async () => {},
      listTools: async () => [{
        name: 'probe',
        description: 'probe',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      callTool: async (_name, _input, context) => {
        observedSignal = context.signal
        observedDeadline = context.deadline
        return 'ok'
      },
      close: async () => {},
    }
    await registry.registerMCPServer('test', client)
    const execution = dispatchOptions()
    const resolution = registry.resolveInvocation('mcp__test__probe', {}, 'mcp-call')
    assert.equal(resolution.ok, true)
    if (!resolution.ok) return
    assert.deepEqual(resolution.invocation.toolSource, { kind: 'mcp', serverName: 'test' })
    assert.deepEqual(resolution.invocation.constraints, {
      networkSchemes: ['https'],
      networkHosts: ['mcp.example'],
      networkPorts: [8443],
      maxResultChars: 3_000,
    })

    const result = await dispatchResolvedInvocation(registry, resolution.invocation, {
      ...execution,
      constraints: resolution.invocation.constraints,
    })

    assert.equal(result.outcome, 'succeeded')
    assert.equal(observedSignal, execution.signal)
    assert.equal(observedDeadline, execution.deadline)
    await registry.close()
  })
})
