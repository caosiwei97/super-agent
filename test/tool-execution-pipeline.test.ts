import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { ToolRegistry, type ToolDefinition } from '../src/core/tool-registry.js'
import {
  applyOperationEvent,
  createOperationInputDigestPort,
  parseOperationEvent,
  proposeOperation,
  redactSensitiveInput,
  transitionOperation,
} from '../src/execution/operation-ledger.js'
import {
  ToolExecutionPipeline,
  type ToolExecutionPipelineOptions,
} from '../src/execution/tool-execution-pipeline.js'
import { dispatchResolvedInvocation } from '../src/execution/internal-tool-dispatch.js'
import type { OperationEventDraft, OperationProjection } from '../src/execution/operation-types.js'
import {
  SessionStore,
  nodeSessionJournalIo,
  type SessionJournalFile,
  type SessionJournalIo,
} from '../src/session/store.js'
import { RecoveryCoordinator } from '../src/execution/recovery-coordinator.js'

function definition(
  name: string,
  execute: ToolDefinition['execute'],
  options: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    capabilitySet: ['external.read'],
    isConcurrencySafe: true,
    isReadOnly: true,
    execute,
    ...options,
  }
}

async function setup(
  context: TestContext,
  io?: SessionJournalIo,
  pipelineOptions?: ToolExecutionPipelineOptions,
) {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-pipeline-'))
  const store = await SessionStore.open('pipeline-test', { directory: root, io })
  const registry = new ToolRegistry()
  context.after(async () => {
    await registry.close().catch(() => undefined)
    await store.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })
  return { store, registry, pipeline: new ToolExecutionPipeline(registry, store, pipelineOptions) }
}

function runContext() {
  return {
    sessionId: 'pipeline-test',
    turnId: 'turn-1',
    stepId: 'step-1',
    requestId: 'request-1',
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
  }
}

async function seedSucceededOperation(
  store: SessionStore,
  capabilitySet: readonly string[],
): Promise<OperationProjection> {
  const append = async (draft: OperationEventDraft) => parseOperationEvent(
    await store.appendEvent({ ...draft }, 'durable'),
  )
  let projection = applyOperationEvent(undefined, await append(proposeOperation({
    operationId: `seed-${capabilitySet.join('-')}`,
    sessionId: 'pipeline-test',
    turnId: 'seed-turn',
    stepId: 'seed-step',
    requestId: 'seed-request',
    toolCallId: 'seed-call',
    toolName: 'seed-tool',
    capabilitySet,
    protectedInput: createOperationInputDigestPort({ redact: redactSensitiveInput }).protect({}),
  }) as OperationEventDraft))
  projection = applyOperationEvent(projection, await append(
    transitionOperation(projection, { kind: 'approve' }) as OperationEventDraft,
  ))
  projection = applyOperationEvent(projection, await append(
    transitionOperation(projection, { kind: 'start', attemptId: 'seed-attempt' }) as OperationEventDraft,
  ))
  return applyOperationEvent(projection, await append(
    transitionOperation(projection, { kind: 'succeed' }) as OperationEventDraft,
  ))
}

describe('ToolExecutionPipeline', () => {
  it('persists dynamic resolution failures as denied without approval or dispatch', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    let approvals = 0
    let executions = 0
    registry.register(definition('broken_security', async () => { executions++; return 'never' }, {
      getCapabilities: () => { throw new Error('resolver exploded') },
      isConcurrencySafe: () => true,
    }))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-broken-security',
      toolName: 'broken_security',
      input: { value: 'safe' },
    }], { approve: async () => { approvals++; return true } })

    assert.equal(executions, 0)
    assert.equal(approvals, 0)
    assert.equal(result.outcomes[0]?.operation.status, 'denied')
    assert.equal(result.outcomes[0]?.operation.latestEvent.errorCode, 'capability_resolution_failed')
    assert.deepEqual(result.outcomes[0]?.operation.latestEvent.capabilitySet, [])
    assert.deepEqual((await store.replayEvents()).filter((event) => event.type === 'operation')
      .map((event) => parseOperationEvent(event).status), ['proposed', 'denied'])
  })

  it('calls approval only for ask while explicit low-risk capabilities allow directly', async (context) => {
    const { registry, pipeline } = await setup(context)
    let approvals = 0
    registry.register(
      definition('pure', async () => 'pure', {
        getCapabilities: () => [],
        isConcurrencySafe: () => true,
      }),
      definition('egress', async () => 'egress', {
        getCapabilities: () => ['network.egress'],
        isConcurrencySafe: () => true,
      }),
    )

    const allowed = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-pure', toolName: 'pure', input: { value: 'safe' },
    }], { approve: async () => { approvals++; return true } })
    assert.equal(allowed.outcomes[0]?.operation.status, 'succeeded')
    assert.equal(approvals, 0)

    const asked = await pipeline.executeBatch({ ...runContext(), stepId: 'step-2' }, [{
      toolCallId: 'call-egress', toolName: 'egress', input: { value: 'safe' },
    }], { approve: async () => { approvals++; return true } })
    assert.equal(asked.outcomes[0]?.operation.status, 'succeeded')
    assert.equal(approvals, 1)
  })

  it('fails requireSandbox closed before durable started while M3 has no sandbox backend', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    let executions = 0
    let approvals = 0
    registry.register(definition('sandbox_required', async () => { executions++; return 'never' }, {
      getCapabilities: () => ['process.execute'],
      getConstraints: () => ({ requireSandbox: true }),
      supportedConstraintKeys: ['requireSandbox'],
      isConcurrencySafe: () => false,
    }))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-sandbox',
      toolName: 'sandbox_required',
      input: { value: 'safe' },
    }], { approve: async () => { approvals++; return true } })
    assert.equal(executions, 0)
    assert.equal(approvals, 0)
    assert.equal(result.outcomes[0]?.operation.status, 'denied')
    assert.equal(result.outcomes[0]?.operation.latestEvent.errorCode, 'sandbox_unavailable')
    const events = (await store.replayEvents()).filter((event) => event.type === 'operation')
      .map((event) => parseOperationEvent(event).status)
    assert.deepEqual(events, ['proposed', 'denied'])
  })

  it('persists unsupported policy constraints as denied without approval or dispatch', async (context) => {
    let approvals = 0
    let executions = 0
    const { store, registry, pipeline } = await setup(context, undefined, {
      hooks: [() => ({
        behavior: 'ask',
        constraints: { networkHosts: ['api.example'] },
        reasonCode: 'hook.unsupported_constraint_probe',
      })],
    })
    registry.register(definition('no_network_constraint', async () => {
      executions++
      return 'never'
    }, {
      getCapabilities: () => [],
      isConcurrencySafe: () => true,
    }))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-unsupported-constraint',
      toolName: 'no_network_constraint',
      input: { value: 'safe' },
    }], { approve: async () => { approvals++; return true } })
    assert.equal(result.outcomes[0]?.operation.status, 'denied')
    assert.equal(result.outcomes[0]?.operation.latestEvent.errorCode, 'constraint_unsupported')
    assert.equal(approvals, 0)
    assert.equal(executions, 0)
    assert.deepEqual((await store.replayEvents()).filter((event) => event.type === 'operation')
      .map((event) => parseOperationEvent(event).status), ['proposed', 'denied'])
  })

  it('hard-denies batch and durable prior secret-to-egress plans before approval', async (context) => {
    const { registry, pipeline } = await setup(context)
    let approvals = 0
    let executions = 0
    registry.register(
      definition('secret', async () => { executions++; return 'secret-read' }, {
        getCapabilities: () => ['secret.read'],
        isConcurrencySafe: () => true,
      }),
      definition('network', async () => { executions++; return 'sent' }, {
        getCapabilities: () => ['network.egress'],
        isConcurrencySafe: () => true,
      }),
    )

    const batch = await pipeline.executeBatch(runContext(), [
      { toolCallId: 'call-secret-batch', toolName: 'secret', input: { value: 'safe' } },
      { toolCallId: 'call-network-batch', toolName: 'network', input: { value: 'safe' } },
    ], { approve: async () => { approvals++; return true } })
    assert.deepEqual(batch.outcomes.map((outcome) => outcome.operation.status), ['denied', 'denied'])
    assert.equal(approvals, 0)
    assert.equal(executions, 0)

    const secret = await pipeline.executeBatch({ ...runContext(), stepId: 'step-prior-secret' }, [{
      toolCallId: 'call-secret-prior', toolName: 'secret', input: { value: 'safe' },
    }], { approve: async () => { approvals++; return true } })
    assert.equal(secret.outcomes[0]?.operation.status, 'succeeded')
    assert.equal(approvals, 1)

    const network = await pipeline.executeBatch({ ...runContext(), stepId: 'step-after-secret' }, [{
      toolCallId: 'call-network-after', toolName: 'network', input: { value: 'safe' },
    }], { approve: async () => { approvals++; return true } })
    assert.equal(network.outcomes[0]?.operation.status, 'denied')
    assert.equal(network.outcomes[0]?.operation.latestEvent.errorCode, 'policy_denied')
    assert.equal(approvals, 1, 'hard deny must not be routed through approval')
  })

  it('normalizes legacy and unknown successful ledger capabilities conservatively', async (context) => {
    let observedPrior: readonly string[] = []
    const { store, registry, pipeline } = await setup(context, undefined, {
      hooks: [(policyContext) => {
        observedPrior = policyContext.priorCapabilities
        return undefined
      }],
    })
    await seedSucceededOperation(store, ['legacy.read'])
    await seedSucceededOperation(store, ['vendor.future.write'])
    registry.register(definition('after_upgrade', async () => 'ok', {
      getCapabilities: () => [],
      isConcurrencySafe: () => true,
    }))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-after-upgrade',
      toolName: 'after_upgrade',
      input: { value: 'safe' },
    }])
    assert.equal(result.outcomes[0]?.operation.status, 'succeeded')
    assert.deepEqual(observedPrior, ['secret.read', 'external.write'])
  })

  it('keeps denyReason as a tighten-only compatibility gate', async (context) => {
    const { registry, pipeline } = await setup(context)
    let executions = 0
    let approvals = 0
    registry.register(definition('tightened', async () => { executions++; return 'never' }, {
      getCapabilities: () => [],
      isConcurrencySafe: () => true,
    }))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-tightened', toolName: 'tightened', input: { value: 'safe' },
    }], {
      denyReason: () => 'loop guard denied',
      approve: async () => { approvals++; return true },
    })
    assert.equal(result.outcomes[0]?.operation.status, 'denied')
    assert.equal(executions, 0)
    assert.equal(approvals, 0)
  })

  it('persists proposed, durable start, terminal and materialized result in order', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    let executions = 0
    registry.register(definition('probe', async ({ value }) => {
      executions++
      return `done:${value}`
    }))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-1',
      toolName: 'probe',
      input: { value: 'safe' },
    }])

    assert.equal(executions, 1)
    assert.equal(result.hasUncertain, false)
    assert.equal(result.outcomes[0]?.operation.status, 'succeeded')
    assert.equal(result.outcomes[0]?.message?.content[0]?.type, 'tool-result')
    const events = await store.replayEvents()
    assert.deepEqual(events.map((event) =>
      event.type === 'operation' ? parseOperationEvent(event).status : event.type), [
      'proposed', 'approved', 'started', 'succeeded', 'messages',
    ])
    assert.equal(typeof events[4]?.materializationId, 'string')
  })

  it('strictly denies invalid input without exposing a tool closure', async (context) => {
    const { registry, pipeline } = await setup(context)
    let executions = 0
    registry.register(definition('strict', async () => { executions++; return 'never' }, {
      isReadOnly: false,
      requiresApproval: true,
    }))
    let approvalRequest: unknown

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-invalid',
      toolName: 'strict',
      input: { value: 'safe', unexpected: true },
    }], {
      approve: async (request) => { approvalRequest = request; return true },
    })

    assert.equal(executions, 0)
    assert.equal(approvalRequest, undefined)
    assert.equal(result.outcomes[0]?.operation.status, 'denied')
    assert.equal(result.outcomes[0]?.operation.latestEvent.errorCode, 'invalid_input')
    assert.equal('execute' in (registry.getDescriptor('strict') as object), false)
  })

  it('uses actionable safe denial codes for unknown tools and rejected approval', async (context) => {
    const { registry, pipeline } = await setup(context)
    let executions = 0
    registry.register(definition('approval_probe', async () => {
      executions++
      return 'never'
    }, {
      isReadOnly: false,
      requiresApproval: true,
    }))

    const result = await pipeline.executeBatch(runContext(), [
      { toolCallId: 'call-missing', toolName: 'missing_tool', input: {} },
      { toolCallId: 'call-rejected', toolName: 'approval_probe', input: { value: 'safe' } },
    ], { approve: async () => false })

    assert.equal(executions, 0)
    assert.deepEqual(result.outcomes.map((outcome) => outcome.operation.latestEvent.errorCode), [
      'unknown_tool', 'approval_denied',
    ])
    const modelFacing = result.outcomes.map((outcome) => JSON.stringify(outcome.message))
    assert.equal(modelFacing[0]?.includes('unknown_tool'), true)
    assert.equal(modelFacing[1]?.includes('approval_denied'), true)
  })

  it('does not dispatch when the durable start sync fails', async (context) => {
    const io: SessionJournalIo = {
      readFile: (path) => nodeSessionJournalIo.readFile(path),
      open: async (path, flags, mode) => {
        const handle = await nodeSessionJournalIo.open(path, flags, mode)
        const wrapped: SessionJournalFile = {
          chmod: (value) => handle.chmod(value),
          truncate: (length) => handle.truncate(length),
          write: (buffer, offset, length) => handle.write(buffer, offset, length),
          datasync: async () => {
            throw Object.assign(new Error('injected start datasync failure'), { code: 'EIO' })
          },
          close: () => handle.close(),
        }
        return wrapped
      },
    }
    const { registry, pipeline } = await setup(context, io)
    let executions = 0
    registry.register(definition('write_probe', async () => { executions++; return 'never' }, {
      capabilitySet: ['external.write'],
      isConcurrencySafe: false,
      isReadOnly: false,
      requiresApproval: true,
    }))

    await assert.rejects(pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-write',
      toolName: 'write_probe',
      input: { value: 'safe' },
    }], { approve: async () => true }), (error: unknown) => {
      const messages = error instanceof AggregateError
        ? error.errors.map((item) => item instanceof Error ? item.message : String(item))
        : [error instanceof Error ? error.message : String(error)]
      assert.ok(messages.some((message) => /datasync failure/.test(message)))
      return true
    })
    assert.equal(executions, 0)
  })

  it('maps a generic dispatch rejection to uncertain and emits no fake result', async (context) => {
    const { registry, pipeline } = await setup(context)
    registry.register(definition('unknown_outcome', async () => {
      throw new Error('connection lost after dispatch')
    }))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-unknown',
      toolName: 'unknown_outcome',
      input: { value: 'safe' },
    }])

    assert.equal(result.hasUncertain, true)
    assert.equal(result.outcomes[0]?.operation.status, 'uncertain')
    assert.equal(result.outcomes[0]?.message, undefined)
  })

  it('keeps a known success when its raw result cannot be encoded', async (context) => {
    const { registry, pipeline } = await setup(context)
    registry.register(definition('cyclic_result', async () => {
      const value: { self?: unknown } = {}
      value.self = value
      return value
    }))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-cyclic',
      toolName: 'cyclic_result',
      input: { value: 'safe' },
    }])

    assert.equal(result.outcomes[0]?.operation.status, 'succeeded')
    const message = result.outcomes[0]?.message
    assert.ok(message?.role === 'tool')
    assert.equal(message.content[0]?.type, 'tool-result')
    if (message.content[0]?.type === 'tool-result') {
      assert.equal(message.content[0].output.type, 'error-text')
    }
  })

  it('redacts structured secrets before serializing durable tool results', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    const marker = 'SENSITIVE_TEST_MARKER'
    registry.register(definition('secret_result', async () => ({
      ok: true,
      apiKey: marker,
      nested: { password: marker, publicValue: 'kept' },
    })))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-secret',
      toolName: 'secret_result',
      input: { value: 'safe' },
    }])

    assert.equal(result.outcomes[0]?.operation.status, 'succeeded')
    const persisted = JSON.stringify(await store.replayEvents())
    assert.equal(persisted.includes(marker), false)
    assert.equal(persisted.includes('publicValue'), true)
    assert.equal(JSON.stringify(result.outcomes[0]?.message).includes(marker), false)
  })

  it('redacts secrets inside MCP-style nested JSON text', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    const marker = 'SENSITIVE_STRING_MARKER'
    registry.register(definition('mcp_style_result', async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({ apiKey: marker, publicValue: 'kept' }),
      }],
    })))

    const result = await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-mcp-secret',
      toolName: 'mcp_style_result',
      input: { value: 'safe' },
    }])

    const persisted = JSON.stringify(await store.replayEvents())
    assert.equal(persisted.includes(marker), false)
    assert.equal(persisted.includes('publicValue'), true)
    assert.equal(JSON.stringify(result.outcomes[0]?.message).includes(marker), false)
  })

  it('redacts non-JSON secret assignments using the full sensitive field policy', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    const markers = [
      'TOKEN_STRING_MARKER',
      'PRIVATE_KEY_STRING_MARKER',
      'COOKIE_STRING_MARKER',
      'CREDENTIALS_STRING_MARKER',
    ]
    registry.register(definition('log_style_result', async () => ({
      content: [{
        type: 'text',
        text: [
          `token: ${markers[0]}`,
          `privateKey=${markers[1]}`,
          `cookie ${markers[2]}`,
          `credentials: ${markers[3]}`,
        ].join('\n'),
      }],
    })))

    await pipeline.executeBatch(runContext(), [{
      toolCallId: 'call-log-secret',
      toolName: 'log_style_result',
      input: { value: 'safe' },
    }])

    const persisted = JSON.stringify(await store.replayEvents())
    for (const marker of markers) assert.equal(persisted.includes(marker), false)
  })

  it('runs concurrency-safe tools in parallel and keeps ordered outcomes', async (context) => {
    const { registry, pipeline } = await setup(context)
    let active = 0
    let maxActive = 0
    const execute = async ({ value }: { value: string }) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active--
      return value
    }
    registry.register(definition('parallel_a', execute), definition('parallel_b', execute))

    const result = await pipeline.executeBatch(runContext(), [
      { toolCallId: 'call-a', toolName: 'parallel_a', input: { value: 'a' } },
      { toolCallId: 'call-b', toolName: 'parallel_b', input: { value: 'b' } },
    ])

    assert.equal(maxActive, 2)
    assert.deepEqual(result.outcomes.map((outcome) => outcome.operation.latestEvent.toolCallId), [
      'call-a', 'call-b',
    ])
  })

  it('atomically rejects concurrent reservation of the same operation', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    let executions = 0
    registry.register(definition('single_dispatch', async () => {
      executions++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 'ok'
    }))
    const call = [{
      toolCallId: 'same-call',
      toolName: 'single_dispatch',
      input: { value: 'safe' },
    }]

    const settled = await Promise.allSettled([
      pipeline.executeBatch(runContext(), call),
      pipeline.executeBatch(runContext(), call),
    ])

    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(settled.filter((result) => result.status === 'rejected').length, 1)
    assert.equal(executions, 1)
    const operations = await new RecoveryCoordinator(store).listOperations()
    assert.equal(operations.length, 1)
    assert.equal(operations[0]?.status, 'succeeded')
  })

  it('cancels a proposed operation when approval is aborted', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    let executions = 0
    registry.register(definition('approval_wait', async () => {
      executions++
      return 'never'
    }, { isReadOnly: false, requiresApproval: true }))
    const controller = new AbortController()
    let approvalStarted!: () => void
    const started = new Promise<void>((resolve) => { approvalStarted = resolve })
    const execution = pipeline.executeBatch({
      ...runContext(),
      signal: controller.signal,
    }, [{
      toolCallId: 'call-approval-abort',
      toolName: 'approval_wait',
      input: { value: 'safe' },
    }], {
      approve: async ({ signal }) => {
        approvalStarted()
        return new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })

    await started
    controller.abort(new DOMException('cancel approval', 'AbortError'))
    await assert.rejects(execution, { name: 'AbortError' })
    assert.equal(executions, 0)
    const operations = await new RecoveryCoordinator(store).listOperations()
    assert.equal(operations[0]?.status, 'cancelled')
    assert.equal(operations[0]?.latestEvent.cancellationProof, 'not_dispatched')
    assert.equal((await store.loadState()).messages.filter((message) => message.role === 'tool').length, 1)
  })

  it('marks an aborted dispatch uncertain and emits no fake tool result', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    const controller = new AbortController()
    let closureStarted!: () => void
    const started = new Promise<void>((resolve) => { closureStarted = resolve })
    registry.register(definition('abort_after_start', async (_input, execution) => {
      closureStarted()
      return new Promise((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(execution.signal.reason), {
          once: true,
        })
      })
    }))
    const execution = pipeline.executeBatch({
      ...runContext(),
      signal: controller.signal,
    }, [{
      toolCallId: 'call-abort-after-start',
      toolName: 'abort_after_start',
      input: { value: 'safe' },
    }])

    await started
    controller.abort(new DOMException('cancel dispatch', 'AbortError'))
    const result = await execution

    assert.equal(result.hasUncertain, true)
    assert.equal(result.outcomes[0]?.message, undefined)
    assert.equal(result.outcomes[0]?.operation.status, 'uncertain')
    assert.equal((await store.loadState()).messages.some((message) => message.role === 'tool'), false)
  })

  it('cancels an approved operation when lock waiting is aborted', async (context) => {
    const { store, registry, pipeline } = await setup(context)
    let releaseBlocker!: () => void
    let blockerStarted!: () => void
    const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve })
    const blockerReady = new Promise<void>((resolve) => { blockerStarted = resolve })
    registry.register(
      definition('lock_blocker', async () => {
        blockerStarted()
        await blockerRelease
        return 'released'
      }, { isConcurrencySafe: false }),
      definition('lock_target', async () => 'must not run', { isConcurrencySafe: false }),
    )
    const blockerContext = runContext()
    const blockerResolution = registry.resolveInvocation(
      'lock_blocker', { value: 'hold' }, 'blocker-call',
    )
    assert.equal(blockerResolution.ok, true)
    if (!blockerResolution.ok) return
    const blocker = dispatchResolvedInvocation(registry, blockerResolution.invocation, {
      ...blockerContext,
      constraints: blockerResolution.invocation.constraints,
    })
    await blockerReady

    const controller = new AbortController()
    const execution = pipeline.executeBatch({
      ...runContext(),
      signal: controller.signal,
    }, [{
      toolCallId: 'call-lock-abort',
      toolName: 'lock_target',
      input: { value: 'safe' },
    }])
    const waitDeadline = Date.now() + 2_000
    while ((await new RecoveryCoordinator(store).listOperations())[0]?.status !== 'approved') {
      if (Date.now() >= waitDeadline) throw new Error('lock target did not reach approved')
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    controller.abort(new DOMException('cancel lock wait', 'AbortError'))
    try {
      await assert.rejects(execution, { name: 'AbortError' })
    } finally {
      releaseBlocker()
    }
    await blocker

    const operations = await new RecoveryCoordinator(store).listOperations()
    assert.equal(operations[0]?.status, 'cancelled')
    assert.equal(operations[0]?.latestEvent.cancellationProof, 'not_dispatched')
  })

  it('commits a known successful result even if cancellation races after invocation', async (context) => {
    const { registry, pipeline } = await setup(context)
    const controller = new AbortController()
    registry.register(definition('known_success', async () => {
      controller.abort(new DOMException('late cancellation', 'AbortError'))
      return 'known-result'
    }))

    const result = await pipeline.executeBatch({
      ...runContext(),
      signal: controller.signal,
    }, [{
      toolCallId: 'call-known-success',
      toolName: 'known_success',
      input: { value: 'safe' },
    }])

    assert.equal(result.outcomes[0]?.operation.status, 'succeeded')
    assert.ok(result.outcomes[0]?.message)
  })
})
