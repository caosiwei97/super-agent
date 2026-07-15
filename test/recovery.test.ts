import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  applyOperationEvent,
  createOperationInputDigestPort,
  createOperationResultProtectionPort,
  parseOperationEvent,
  proposeOperation,
  redactSensitiveInput,
  transitionOperation,
} from '../src/execution/operation-ledger.js'
import {
  RecoveryCoordinator,
  UnresolvedOperationsError,
  materializeTerminalResult,
} from '../src/execution/recovery-coordinator.js'
import type {
  OperationEventDraft,
  OperationProjection,
  OperationTransition,
} from '../src/execution/operation-types.js'
import { SessionStore, type SessionEventInput } from '../src/session/store.js'

const inputPort = createOperationInputDigestPort({ redact: redactSensitiveInput })
const resultPort = createOperationResultProtectionPort({
  redact: redactSensitiveInput,
  includeModelResult: true,
})

async function temporaryStore(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'super-agent-recovery-'))
  const store = await SessionStore.open('recovery-test', { directory })
  context.after(async () => {
    await store.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  })
  return store
}

async function persistDraft(store: SessionStore, draft: OperationEventDraft) {
  return parseOperationEvent(await store.appendEvent({ ...draft } as SessionEventInput, 'durable'))
}

async function propose(store: SessionStore, operationId: string): Promise<OperationProjection> {
  const draft = proposeOperation({
    operationId,
    sessionId: store.getSessionId(),
    turnId: `turn-${operationId}`,
    stepId: `step-${operationId}`,
    requestId: `request-${operationId}`,
    toolCallId: `call-${operationId}`,
    toolName: 'write_file',
    capabilitySet: ['filesystem.write'],
    protectedInput: inputPort.protect({ path: `${operationId}.txt` }),
  }) as OperationEventDraft
  return applyOperationEvent(undefined, await persistDraft(store, draft))
}

async function transition(
  store: SessionStore,
  projection: OperationProjection,
  operationTransition: OperationTransition,
) {
  const draft = transitionOperation(projection, operationTransition) as OperationEventDraft
  return applyOperationEvent(projection, await persistDraft(store, draft))
}

describe('RecoveryCoordinator', () => {
  it('durably normalizes interrupted operations in original journal order', async (context) => {
    const store = await temporaryStore(context)
    const proposed = await propose(store, 'proposed')
    let approved = await propose(store, 'approved')
    approved = await transition(store, approved, { kind: 'approve' })
    let started = await propose(store, 'started')
    started = await transition(store, started, { kind: 'approve' })
    started = await transition(store, started, { kind: 'start', attemptId: 'attempt-started' })
    let succeeded = await propose(store, 'succeeded')
    succeeded = await transition(store, succeeded, { kind: 'approve' })
    succeeded = await transition(store, succeeded, { kind: 'start', attemptId: 'attempt-succeeded' })
    succeeded = await transition(store, succeeded, {
      kind: 'succeed',
      protectedResult: resultPort.protect({ ok: true }),
    })

    const before = (await store.replayEvents()).length
    const recovered = await new RecoveryCoordinator(store).recover()

    assert.equal(recovered.operations.get(proposed.operationId)?.status, 'cancelled')
    assert.equal(recovered.operations.get(approved.operationId)?.status, 'cancelled')
    assert.equal(recovered.operations.get(started.operationId)?.status, 'uncertain')
    assert.equal(recovered.operations.get(succeeded.operationId)?.status, 'succeeded')
    assert.equal(recovered.operations.get('proposed')?.latestEvent.cancellationProof, 'not_dispatched')
    assert.equal(recovered.operations.get('started')?.latestEvent.attemptId, 'attempt-started')
    assert.deepEqual(recovered.unresolved.map((operation) => operation.operationId), ['started'])
    assert.equal((await store.replayEvents()).length, before + 3)

    const recoveryEvents = (await store.replayEvents()).slice(-3).map(parseOperationEvent)
    assert.deepEqual(recoveryEvents.map((event) => event.operationId), [
      'proposed',
      'approved',
      'started',
    ])
  })

  it('is idempotent across repeated recovery and across a new coordinator', async (context) => {
    const store = await temporaryStore(context)
    let started = await propose(store, 'operation-1')
    started = await transition(store, started, { kind: 'approve' })
    await transition(store, started, { kind: 'start', attemptId: 'attempt-1' })

    await new RecoveryCoordinator(store).recover()
    const first = await store.replayEvents()
    await new RecoveryCoordinator(store).recover()
    const second = await store.replayEvents()

    assert.equal(second.length, first.length)
    assert.deepEqual(second, first)
  })

  it('gates new turns until explicit reconciliation and makes same resolution idempotent', async (context) => {
    const store = await temporaryStore(context)
    let started = await propose(store, 'operation-1')
    started = await transition(store, started, { kind: 'approve' })
    await transition(store, started, { kind: 'start', attemptId: 'attempt-1' })
    const recovery = new RecoveryCoordinator(store)

    await assert.rejects(
      recovery.assertCanStartNewTurn(),
      (error: unknown) => {
        assert.ok(error instanceof UnresolvedOperationsError)
        assert.deepEqual(error.operationIds, ['operation-1'])
        return true
      },
    )

    const resolved = await recovery.resolveOperation('operation-1', {
      outcome: 'succeeded',
      protectedResult: resultPort.protect({ restored: true }),
    })
    assert.equal(resolved.status, 'reconciled_succeeded')
    const count = (await store.replayEvents()).length
    assert.equal((await recovery.resolveOperation('operation-1', { outcome: 'succeeded' })).status,
      'reconciled_succeeded')
    assert.equal((await store.replayEvents()).length, count)
    assert.equal((await recovery.assertCanStartNewTurn()).canStartNewTurn, true)
  })

  it('supports confirmed-failed resolution and rejects conflicting terminal resolution', async (context) => {
    const store = await temporaryStore(context)
    let started = await propose(store, 'operation-1')
    started = await transition(store, started, { kind: 'approve' })
    await transition(store, started, { kind: 'start', attemptId: 'attempt-1' })
    const recovery = new RecoveryCoordinator(store)

    const resolved = await recovery.resolveOperation('operation-1', {
      outcome: 'failed',
      errorCode: 'downstream_confirmed_absent',
    })
    assert.equal(resolved.status, 'reconciled_failed')
    assert.equal(resolved.latestEvent.errorCode, 'downstream_confirmed_absent')
    await assert.rejects(
      recovery.resolveOperation('operation-1', { outcome: 'succeeded' }),
      /reconciled_failed|不能对账/,
    )
  })

  it('atomically rejects conflicting reconciliation from independent coordinators', async (context) => {
    const store = await temporaryStore(context)
    let started = await propose(store, 'operation-race')
    started = await transition(store, started, { kind: 'approve' })
    await transition(store, started, { kind: 'start', attemptId: 'attempt-race' })
    await new RecoveryCoordinator(store).recover()

    const succeeded = new RecoveryCoordinator(store).resolveOperation('operation-race', {
      outcome: 'succeeded',
      protectedResult: resultPort.protect({ confirmed: true }),
    })
    const failed = new RecoveryCoordinator(store).resolveOperation('operation-race', {
      outcome: 'failed',
      errorCode: 'confirmed_absent',
    })
    const settled = await Promise.allSettled([succeeded, failed])

    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(settled.filter((result) => result.status === 'rejected').length, 1)
    const operations = await new RecoveryCoordinator(store).listOperations()
    assert.equal(operations.length, 1)
    assert.ok(['reconciled_succeeded', 'reconciled_failed'].includes(operations[0]!.status))
  })

  it('materializes terminal results as stable pure values', async (context) => {
    const store = await temporaryStore(context)
    let succeeded = await propose(store, 'operation-1')
    succeeded = await transition(store, succeeded, { kind: 'approve' })
    succeeded = await transition(store, succeeded, { kind: 'start', attemptId: 'attempt-1' })
    succeeded = await transition(store, succeeded, {
      kind: 'succeed',
      protectedResult: resultPort.protect({ ok: true, value: 'persisted' }),
    })

    const first = materializeTerminalResult(succeeded)
    const second = materializeTerminalResult(succeeded)
    assert.deepEqual(first, second)
    assert.equal(first?.operationId, 'operation-1')
    assert.deepEqual(first?.output, {
      type: 'result',
      value: { ok: true, value: 'persisted' },
    })
    assert.equal(Object.isFrozen(first), true)

    const nonterminal = await propose(store, 'operation-2')
    assert.equal(materializeTerminalResult(nonterminal), undefined)
  })

  it('durably materializes a missing terminal tool result exactly once', async (context) => {
    const store = await temporaryStore(context)
    await store.appendMessages([{
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'call-operation-1',
        toolName: 'write_file',
        input: { path: 'operation-1.txt' },
      }],
    }])
    let succeeded = await propose(store, 'operation-1')
    succeeded = await transition(store, succeeded, { kind: 'approve' })
    succeeded = await transition(store, succeeded, { kind: 'start', attemptId: 'attempt-1' })
    await transition(store, succeeded, {
      kind: 'succeed',
      protectedResult: resultPort.protect({ ok: true }),
    })
    const recovery = new RecoveryCoordinator(store)

    await recovery.assertCanStartNewTurn()
    await recovery.assertCanStartNewTurn()

    const materializations = (await store.replayEvents()).filter(
      (event) => typeof event.materializationId === 'string',
    )
    assert.equal(materializations.length, 1)
    const toolMessages = (await store.loadState()).messages.filter((message) => message.role === 'tool')
    assert.equal(toolMessages.length, 1)
    assert.deepEqual(toolMessages[0]?.content[0], {
      type: 'tool-result',
      toolCallId: 'call-operation-1',
      toolName: 'write_file',
      output: { type: 'json', value: { ok: true } },
    })
  })

  it('fails closed on malformed or cross-session operation records', async (context) => {
    const store = await temporaryStore(context)
    const malformed = {
      type: 'operation',
      operationId: 'bad-operation',
      sessionId: store.getSessionId(),
      status: 'proposed',
    }
    await assert.rejects(store.appendEvent(malformed, 'durable'), /OperationEvent|turnId|eventId/)

    const crossSession = proposeOperation({
      operationId: 'cross-session',
      sessionId: 'another-session',
      turnId: 'turn-cross',
      stepId: 'step-cross',
      requestId: 'request-cross',
      toolCallId: 'call-cross',
      toolName: 'write_file',
      capabilitySet: ['filesystem.write'],
      protectedInput: inputPort.protect({ path: 'cross.txt' }),
    }) as OperationEventDraft
    await persistDraft(store, crossSession)
    await assert.rejects(new RecoveryCoordinator(store).recover(), /another-session|journal/)
  })

  it('lists operations without mutating their state', async (context) => {
    const store = await temporaryStore(context)
    await propose(store, 'operation-1')
    const recovery = new RecoveryCoordinator(store)
    const before = (await store.replayEvents()).length

    const operations = await recovery.listOperations()

    assert.deepEqual(operations.map((operation) => operation.operationId), ['operation-1'])
    assert.equal(operations[0]?.status, 'proposed')
    assert.equal((await store.replayEvents()).length, before)
  })
})
