import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { streamText } from 'ai'
import { AsyncReadWriteLock } from '../src/core/async-rw-lock.js'
import {
  ToolRegistry,
  type MCPToolClient,
  type ToolDefinition,
} from '../src/core/tool-registry.js'
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
      registry.dispatchTool('strict_tool', { count: 2, surprise: true }, 'invalid-call', dispatchOptions()),
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
      registry.dispatchTool('write', {}, 'call-1', {
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

    const dispatched = await registry.dispatchTool(
      'circular_result', {}, 'call-success', dispatchOptions(),
    )
    assert.equal(dispatched.outcome, 'succeeded')
    if (dispatched.outcome === 'succeeded') assert.equal(dispatched.rawOutput, circular)

    assert.deepEqual(
      await registry.dispatchTool('rejected_execution', {}, 'call-unknown', dispatchOptions()),
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
      registry.dispatchTool('safe', {}, 'safe-1', dispatchOptions()),
      registry.dispatchTool('safe', {}, 'safe-2', dispatchOptions()),
    ])
    assert.equal(safeMaxActive, 2)

    await Promise.all([
      registry.dispatchTool('unsafe', { id: 'one' }, 'unsafe-1', dispatchOptions()),
      registry.dispatchTool('unsafe', { id: 'two' }, 'unsafe-2', dispatchOptions()),
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
      registry.dispatchTool('resource', {}, 'late-call', dispatchOptions()),
      /已关闭/,
    )
    assert.throws(() => registry.register(definition('late', async () => 'no')), /已关闭/)
  })

  it('rolls back an MCP client when tool discovery fails', async () => {
    const registry = new ToolRegistry()
    let closed = 0
    const client: MCPToolClient = {
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

    const result = await registry.dispatchTool('mcp__test__probe', {}, 'mcp-call', execution)

    assert.equal(result.outcome, 'succeeded')
    assert.equal(observedSignal, execution.signal)
    assert.equal(observedDeadline, execution.deadline)
    await registry.close()
  })
})
