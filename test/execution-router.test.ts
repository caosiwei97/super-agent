import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertSerializableExecutionRequest,
  type ExecutionRequest,
  type Executor,
} from '../src/execution/executor.js'
import { ExecutionRouter } from '../src/execution/execution-router.js'

function request(): ExecutionRequest {
  return Object.freeze({
    schemaVersion: 1,
    operationId: 'operation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    toolName: 'probe',
    executionKind: 'pure',
    input: Object.freeze({ value: 'safe' }),
    capabilities: Object.freeze([]),
    constraints: Object.freeze({}),
    deadline: Date.now() + 60_000,
  })
}

describe('ExecutionRouter', () => {
  it('keeps AbortSignal out of the serializable request envelope', () => {
    const value = request()
    assert.doesNotThrow(() => assertSerializableExecutionRequest(value))
    assert.equal('signal' in value, false)
    assert.doesNotThrow(() => JSON.stringify(value))
  })

  it('rejects legacy execution kinds in production', () => {
    const router = new ExecutionRouter({ profile: 'production' })
    assert.throws(() => router.preflight({
      executionKind: 'pure',
      executionKindSource: 'legacy',
      capabilities: [],
      constraints: {},
    }), /production profile 拒绝/)
  })

  it('fails a process lane closed when no sandbox supports it', () => {
    const router = new ExecutionRouter()
    assert.throws(() => router.preflight({
      executionKind: 'process',
      executionKindSource: 'explicit',
      capabilities: ['process.execute'],
      constraints: {},
    }), /尚无可用执行后端/)
  })

  it('uses a local process executor only in development and never as production fallback', () => {
    const local: Executor = {
      kind: 'local',
      probe: async () => ({ available: true }),
      supports: (kind, constraints) => kind === 'process' && constraints.requireSandbox !== true,
      execute: async () => ({ outcome: 'succeeded', rawOutput: 'local' }),
      close: async () => {},
    }
    const development = new ExecutionRouter({ profile: 'development', processExecutor: local })
    assert.equal(development.preflight({
      executionKind: 'process',
      executionKindSource: 'explicit',
      capabilities: ['process.execute'],
      constraints: {},
    }).backend, 'local')
    assert.throws(() => development.preflight({
      executionKind: 'process',
      executionKindSource: 'explicit',
      capabilities: ['process.execute'],
      constraints: { requireSandbox: true },
    }), /尚无可用执行后端/)

    const production = new ExecutionRouter({ profile: 'production', processExecutor: local })
    assert.throws(() => production.preflight({
      executionKind: 'process',
      executionKindSource: 'explicit',
      capabilities: ['process.execute'],
      constraints: {},
    }), /尚无可用执行后端/)
  })

  it('rejects process capability hidden behind a host lane in production', () => {
    const router = new ExecutionRouter({ profile: 'production' })
    assert.throws(() => router.preflight({
      executionKind: 'preview',
      executionKindSource: 'explicit',
      capabilities: ['filesystem.read', 'process.execute'],
      constraints: {},
    }), /非 process lane/)
  })

  it('copies shallow-frozen constraints so nested arrays cannot drift after preflight', () => {
    const roots = ['/safe']
    const input = Object.freeze({ filesystemReadRoots: roots })
    const plan = new ExecutionRouter().preflight({
      executionKind: 'filesystem',
      executionKindSource: 'explicit',
      capabilities: Object.freeze(['filesystem.read'] as const),
      constraints: input,
    })
    roots.push('/later')
    assert.deepEqual(plan.constraints.filesystemReadRoots, ['/safe'])
    assert.notEqual(plan.constraints, input)
  })

  it('dispatches the approved request and out-of-band signal through the sandbox port', async () => {
    let observedRequest: ExecutionRequest | undefined
    let observedSignal: AbortSignal | undefined
    const sandbox: Executor = {
      kind: 'sandbox',
      probe: async () => ({ available: true }),
      supports: (kind) => kind === 'process',
      execute: async (value, control) => {
        observedRequest = value
        observedSignal = control.signal
        return { outcome: 'succeeded', rawOutput: 'sandboxed' }
      },
      close: async () => {},
    }
    const router = new ExecutionRouter({ processExecutor: sandbox })
    const plan = router.preflight({
      executionKind: 'process',
      executionKindSource: 'explicit',
      capabilities: ['process.execute'],
      constraints: { requireSandbox: true },
    })
    const controller = new AbortController()
    const value = {
      ...request(),
      executionKind: 'process' as const,
      capabilities: Object.freeze(['process.execute'] as const),
      constraints: Object.freeze({ requireSandbox: true }),
    }
    const result = await router.dispatch(plan, value, { signal: controller.signal }, async () => {
      throw new Error('host closure must not run')
    })

    assert.deepEqual(result, { outcome: 'succeeded', rawOutput: 'sandboxed' })
    assert.equal(observedRequest, value)
    assert.equal(observedSignal, controller.signal)
  })
})
