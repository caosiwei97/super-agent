import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AsyncReadWriteLock } from '../src/core/async-rw-lock.js'
import {
  ToolRegistry,
  type MCPToolClient,
  type ToolDefinition,
} from '../src/core/tool-registry.js'

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
})

describe('ToolRegistry', () => {
  it('notifies each result once and preserves toolCallId under parallel completion', async () => {
    const registry = new ToolRegistry()
    registry.register(
      definition('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return 'slow-result'
      }),
      definition('fast', async () => 'fast-result'),
    )
    const observed: Array<[string, string]> = []

    await Promise.all([
      registry.executeTool('slow', {}, 'id-slow', {
        onToolResult: (invocation, result) => {
          observed.push([invocation.toolCallId, result.output])
        },
      }),
      registry.executeTool('fast', {}, 'id-fast', {
        onToolResult: (invocation, result) => {
          observed.push([invocation.toolCallId, result.output])
        },
      }),
    ])

    assert.deepEqual(new Map(observed), new Map([
      ['id-fast', 'fast-result'],
      ['id-slow', 'slow-result'],
    ]))
  })

  it('does not invoke a failing result observer twice', async () => {
    const registry = new ToolRegistry()
    registry.register(definition('read', async () => 'ok'))
    let calls = 0

    await assert.rejects(
      registry.executeTool('read', {}, 'call-1', {
        onToolResult: () => {
          calls++
          throw new Error('observer failed')
        },
      }),
      /observer failed/,
    )
    assert.equal(calls, 1)
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
    assert.deepEqual(await registry.executeTool('resource', {}, 'late-call'), {
      ok: false,
      output: 'ToolRegistry 已关闭',
    })
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
})
