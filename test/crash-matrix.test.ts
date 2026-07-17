import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, type TestContext } from 'node:test'
import { parseOperationEvent } from '../src/execution/operation-ledger.js'
import {
  RecoveryCoordinator,
  UnresolvedOperationsError,
} from '../src/execution/recovery-coordinator.js'
import { SessionStore, type SessionEvent } from '../src/session/store.js'
import {
  CRASH_EXPECTATIONS,
  CRASH_POINTS,
  type CrashPoint,
  type CrashSignal,
} from './fixtures/crash-matrix-contract.js'
import { sessionSegmentPaths } from './session-storage-helpers.js'

const workerFixture = fileURLToPath(
  new URL('./fixtures/crash-matrix-worker.ts', import.meta.url),
)

async function fileText(path: string) {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function logRecords(raw: string) {
  return raw.trim().length === 0
    ? []
    : raw.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

function assertContinuousSequence(events: readonly SessionEvent[]) {
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: events.length }, (_, index) => index + 1),
  )
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length)
}

function assertCausalPrelude(events: readonly SessionEvent[]) {
  const prelude = events[0]
  assert.equal(prelude?.type, 'messages')
  assert.equal(prelude?.materializationId, undefined)
  assert.deepEqual(prelude?.messages, [{
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: 'crash-call',
      toolName: 'durable_effect_probe',
      input: { value: 'effect-once' },
    }],
  }])
}

async function collectCrashSignal(
  child: ReturnType<typeof spawn>,
  point: CrashPoint,
) {
  assert.ok(child.stdout)
  assert.ok(child.stderr)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const [exitCode, exitSignal] = await once(child, 'close') as [
    number | null,
    NodeJS.Signals | null,
  ]
  assert.equal(exitCode, null, stderr)
  assert.equal(exitSignal, 'SIGKILL', stderr)

  const lines = stdout.trimEnd().split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1, `expected one crash signal for ${point}; stderr=${stderr}`)
  const signal = JSON.parse(lines[0]!) as CrashSignal
  assert.equal(signal.type, 'crash-point')
  assert.equal(signal.point, point)
  return signal
}

async function runCase(context: TestContext, point: CrashPoint) {
  const root = await mkdtemp(join(tmpdir(), `super-agent-crash-${point}-`))
  const directory = join(root, 'sessions')
  const dispatchLog = join(root, 'dispatch.log')
  const effectLog = join(root, 'side-effects.log')
  const sessionId = `crash-${CRASH_POINTS.indexOf(point)}`
  context.after(() => rm(root, { recursive: true, force: true }))

  const child = spawn(process.execPath, [
    '--import', 'tsx', workerFixture,
    point, directory, sessionId, dispatchLog, effectLog,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })

  const crashSignal = await collectCrashSignal(child, point)

  const expectation = CRASH_EXPECTATIONS[point]
  const dispatchBefore = await fileText(dispatchLog)
  const effectsBefore = await fileText(effectLog)
  const dispatchRecords = logRecords(dispatchBefore)
  const effectRecords = logRecords(effectsBefore)
  assert.equal(dispatchRecords.length, expectation.dispatches)
  assert.equal(effectRecords.length, expectation.effects)

  let store = await SessionStore.open(sessionId, { directory })
  let events = await store.replayEvents()
  assert.ok((await sessionSegmentPaths(directory, sessionId)).entries.length > 1,
    'tiny segment target must exercise cross-segment recovery')
  assertContinuousSequence(events)
  assertCausalPrelude(events)
  assert.equal(events.some((event) => event.type === 'checkpoint'), false)

  const firstRecovery = new RecoveryCoordinator(store)
  const firstSnapshot = await firstRecovery.recover()
  const afterFirstRecovery = await store.replayEvents()
  assertContinuousSequence(afterFirstRecovery)
  if (expectation.status === undefined) {
    assert.equal(firstSnapshot.operations.size, 0)
  } else {
    assert.equal(firstSnapshot.operations.size, 1)
    const operation = [...firstSnapshot.operations.values()][0]!
    assert.equal(operation.operationId, crashSignal.details.operationId)
    assert.equal(operation.status, expectation.status)
  }
  await store.close()

  // A fresh writer performs recovery again. No transition may be duplicated.
  store = await SessionStore.open(sessionId, { directory })
  const secondRecovery = new RecoveryCoordinator(store)
  const secondSnapshot = await secondRecovery.recover()
  const afterSecondRecovery = await store.replayEvents()
  assert.deepEqual(afterSecondRecovery, afterFirstRecovery)
  assert.equal(secondSnapshot.canStartNewTurn, expectation.canStartNewTurn)

  const beforeGate = await store.replayEvents()
  if (expectation.canStartNewTurn) {
    await secondRecovery.assertCanStartNewTurn()
    const afterFirstGate = await store.replayEvents()
    await secondRecovery.assertCanStartNewTurn()
    const afterSecondGate = await store.replayEvents()
    assert.deepEqual(afterSecondGate, afterFirstGate)
  } else {
    await assert.rejects(
      secondRecovery.assertCanStartNewTurn(),
      (error: unknown) => error instanceof UnresolvedOperationsError,
    )
    const afterFirstGate = await store.replayEvents()
    await assert.rejects(
      secondRecovery.assertCanStartNewTurn(),
      (error: unknown) => error instanceof UnresolvedOperationsError,
    )
    assert.deepEqual(afterFirstGate, beforeGate)
    assert.deepEqual(await store.replayEvents(), beforeGate)
  }

  events = await store.replayEvents()
  assertContinuousSequence(events)
  assertCausalPrelude(events)
  assert.equal(events.some((event) => event.type === 'checkpoint'), false)
  const materializations = events.filter(
    (event) => typeof event.materializationId === 'string',
  )
  assert.equal(materializations.length, expectation.materializedResults)
  assert.equal(new Set(materializations.map((event) => event.materializationId)).size,
    materializations.length)

  const operationEvents = events
    .filter((event) => event.type === 'operation')
    .map(parseOperationEvent)
  if (expectation.status === undefined) {
    assert.equal(operationEvents.length, 0)
  } else {
    assert.equal(new Set(operationEvents.map((event) => event.operationId)).size, 1)
    assert.equal(operationEvents.at(-1)?.status, expectation.status)
    assert.equal(operationEvents.filter((event) => event.status === expectation.status).length, 1)
  }

  // Recovery must never redispatch or replay an external effect.
  assert.equal(await fileText(dispatchLog), dispatchBefore)
  assert.equal(await fileText(effectLog), effectsBefore)
  for (const record of [...dispatchRecords, ...effectRecords]) {
    assert.equal(record.operationId, crashSignal.details.operationId)
  }
  await store.close()
}

describe('durable execution crash matrix', () => {
  for (const point of CRASH_POINTS) {
    it(point, {
      skip: process.platform === 'win32'
        ? 'SIGKILL crash matrix is POSIX-only'
        : false,
      timeout: 20_000,
    }, async (context) => runCase(context, point))
  }
})
