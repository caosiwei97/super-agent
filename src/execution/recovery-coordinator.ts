import { createHash } from 'node:crypto'
import type {
  DurableEventWriter,
  SessionEvent,
  SessionEventInput,
  ToolResultCommit,
} from '../session/store.js'
import type { ToolModelMessage } from 'ai'
import {
  applyOperationEvent,
  parseOperationEvent,
  reduceOperationEvents,
  transitionOperation,
} from './operation-ledger.js'
import type {
  OperationEvent,
  OperationEventDraft,
  OperationProjection,
  ProtectedOperationResult,
  ReadonlyJsonValue,
} from './operation-types.js'

const UNRESOLVED_STATUS = 'uncertain'

export interface RecoveryJournal extends DurableEventWriter {
  getSessionId(): string
  replayEvents(): Promise<SessionEvent[]>
  appendToolResult(commit: ToolResultCommit, budgetUsed?: number): Promise<boolean>
}

export interface RecoverySnapshot {
  readonly operations: ReadonlyMap<string, OperationProjection>
  readonly unresolved: readonly OperationProjection[]
  readonly canStartNewTurn: boolean
}

export type OperationResolution =
  | {
      readonly outcome: 'succeeded'
      readonly protectedResult?: ProtectedOperationResult
    }
  | {
      readonly outcome: 'failed'
      readonly errorCode?: string
    }

export type MaterializedTerminalOutput =
  | { readonly type: 'result'; readonly value: ReadonlyJsonValue }
  | { readonly type: 'result-ref'; readonly ref: string }
  | { readonly type: 'result-unavailable' }
  | {
      readonly type: 'error'
      readonly status: Exclude<OperationProjection['status'], 'succeeded' | 'reconciled_succeeded'>
      readonly errorCode?: string
    }

/** Pure recovery representation; the Pipeline later adapts it to an AI SDK tool-result message. */
export interface TerminalResultMaterialization {
  readonly materializationId: string
  readonly operationId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly terminalEventId: string
  readonly output: MaterializedTerminalOutput
}

export class UnresolvedOperationsError extends Error {
  constructor(readonly operationIds: readonly string[]) {
    super(`session 存在未对账的 uncertain operation: ${operationIds.join(', ')}`)
    this.name = 'UnresolvedOperationsError'
  }
}

function stableRecoveryEventId(operationId: string, transition: string) {
  const digest = createHash('sha256')
    .update(`super-agent:recovery:v1\0${operationId}\0${transition}`)
    .digest('hex')
  return `recovery-${digest}`
}

function stableMaterializationId(event: OperationEvent) {
  const digest = createHash('sha256')
    .update(`super-agent:tool-result:v1\0${event.operationId}\0${event.eventId}`)
    .digest('hex')
  return `tool-result-${digest}`
}

function freezeSnapshot(operations: ReadonlyMap<string, OperationProjection>): RecoverySnapshot {
  const ordered = [...operations.values()].sort(
    (left, right) => left.latestEvent.sequence - right.latestEvent.sequence ||
      left.operationId.localeCompare(right.operationId),
  )
  const stableOperations = new Map(ordered.map((operation) => [operation.operationId, operation]))
  const unresolved = Object.freeze(ordered.filter((operation) => operation.status === UNRESOLVED_STATUS))
  return Object.freeze({
    operations: stableOperations,
    unresolved,
    canStartNewTurn: unresolved.length === 0,
  })
}

export function materializedTerminalToToolMessage(
  materialization: TerminalResultMaterialization,
): ToolModelMessage {
  const { output } = materialization
  type ToolResultPart = Extract<ToolModelMessage['content'][number], { type: 'tool-result' }>
  let toolOutput: ToolResultPart['output']
  if (output.type === 'result') {
    toolOutput = typeof output.value === 'string'
      ? { type: 'text', value: output.value }
      : { type: 'json', value: JSON.parse(JSON.stringify(output.value)) as never }
  } else if (output.type === 'result-ref') {
    toolOutput = { type: 'text', value: `结果引用: ${output.ref}` }
  } else if (output.type === 'result-unavailable') {
    toolOutput = {
      type: 'error-text',
      value: '操作已成功，但结果不可恢复；为避免重复副作用，禁止自动重跑。',
    }
  } else {
    toolOutput = {
      type: 'error-text',
      value: `操作结束状态: ${output.status}${output.errorCode ? ` (${output.errorCode})` : ''}`,
    }
  }
  return {
    role: 'tool',
    content: [{
      type: 'tool-result' as const,
      toolCallId: materialization.toolCallId,
      toolName: materialization.toolName,
      output: toolOutput,
    }],
  }
}

function asSessionEventInput(draft: OperationEventDraft, eventId: string): SessionEventInput {
  return { ...draft, eventId } as SessionEventInput
}

/**
 * Convert one terminal projection into a deterministic, model-facing domain value.
 * This function performs no I/O and deliberately does not fabricate a result for uncertain operations.
 */
export function materializeTerminalResult(
  projection: OperationProjection,
): TerminalResultMaterialization | undefined {
  const event = projection.latestEvent
  if (event.status === 'uncertain' || event.status === 'proposed' ||
      event.status === 'approved' || event.status === 'started') {
    return undefined
  }

  let output: MaterializedTerminalOutput
  if (event.status === 'succeeded' || event.status === 'reconciled_succeeded') {
    if (event.modelResult !== undefined) output = { type: 'result', value: event.modelResult }
    else if (event.resultRef !== undefined) output = { type: 'result-ref', ref: event.resultRef }
    else output = { type: 'result-unavailable' }
  } else {
    output = {
      type: 'error',
      status: event.status,
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    }
  }

  return Object.freeze({
    materializationId: stableMaterializationId(event),
    operationId: event.operationId,
    sessionId: event.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    terminalEventId: event.eventId,
    output: Object.freeze(output),
  })
}

/** Single-session crash recovery and manual reconciliation boundary. */
export class RecoveryCoordinator {
  private exclusiveTail: Promise<void> = Promise.resolve()

  constructor(private readonly journal: RecoveryJournal) {}

  /** Recover interrupted operations, then return the authoritative operation projection. */
  recover(): Promise<RecoverySnapshot> {
    return this.runExclusive(() => this.recoverUnlocked())
  }

  /** Read operations without changing journal state. */
  async listOperations(): Promise<readonly OperationProjection[]> {
    await this.exclusiveTail
    const snapshot = await this.loadSnapshot()
    return Object.freeze([...snapshot.operations.values()])
  }

  /** Recover first and fail closed while any unknown outcome remains unresolved. */
  assertCanStartNewTurn(): Promise<RecoverySnapshot> {
    return this.runExclusive(async () => {
      const snapshot = await this.recoverUnlocked()
      if (!snapshot.canStartNewTurn) {
        throw new UnresolvedOperationsError(
          Object.freeze(snapshot.unresolved.map((operation) => operation.operationId)),
        )
      }
      await this.materializeMissingTerminalResults(snapshot)
      return snapshot
    })
  }

  /** Append an explicit human/downstream reconciliation event. */
  resolveOperation(
    operationId: string,
    resolution: OperationResolution,
  ): Promise<OperationProjection> {
    if (operationId.trim().length === 0) return Promise.reject(new Error('operationId 不能为空'))
    return this.runExclusive(async () => {
      const recovered = await this.recoverUnlocked()
      const current = recovered.operations.get(operationId)
      if (!current) throw new Error(`找不到 operation: ${operationId}`)

      const alreadyResolved =
        (resolution.outcome === 'succeeded' && current.status === 'reconciled_succeeded') ||
        (resolution.outcome === 'failed' && current.status === 'reconciled_failed')
      if (alreadyResolved) return current
      if (current.status !== UNRESOLVED_STATUS) {
        throw new Error(`operation ${operationId} 当前状态 ${current.status}，不能对账`)
      }

      const transition = resolution.outcome === 'succeeded'
        ? { kind: 'reconcile_succeeded' as const, protectedResult: resolution.protectedResult }
        : {
            kind: 'reconcile_failed' as const,
            errorCode: resolution.errorCode || 'manually_confirmed_failed',
          }
      const draft = transitionOperation(current, transition) as OperationEventDraft
      return this.appendTransition(
        current,
        draft,
        stableRecoveryEventId(operationId, `resolve-${resolution.outcome}`),
      )
    })
  }

  private async recoverUnlocked(): Promise<RecoverySnapshot> {
    let snapshot = await this.loadSnapshot()
    const interrupted = [...snapshot.operations.values()]
      .filter((operation) => ['proposed', 'approved', 'started'].includes(operation.status))
      .sort((left, right) => left.latestEvent.sequence - right.latestEvent.sequence ||
        left.operationId.localeCompare(right.operationId))

    for (const current of interrupted) {
      const transition = current.status === 'started'
        ? {
            kind: 'mark_uncertain' as const,
            attemptId: current.latestEvent.attemptId,
            errorCode: 'recovery_unknown_outcome',
          }
        : {
            kind: 'cancel' as const,
            dispatchState: 'not_dispatched' as const,
            errorCode: 'recovery_interrupted_before_dispatch',
          }
      const draft = transitionOperation(current, transition) as OperationEventDraft
      const recovered = await this.appendTransition(
        current,
        draft,
        stableRecoveryEventId(current.operationId, `interrupted-${current.status}`),
      )
      const updated = new Map(snapshot.operations)
      updated.set(recovered.operationId, recovered)
      snapshot = freezeSnapshot(updated)
    }
    return snapshot
  }

  private async loadSnapshot(): Promise<RecoverySnapshot> {
    const events = await this.journal.replayEvents()
    const sessionId = this.journal.getSessionId()
    const operations: OperationEvent[] = []
    for (const event of events) {
      if (event.type !== 'operation') continue
      const operation = parseOperationEvent(event)
      if (operation.sessionId !== sessionId) {
        throw new Error(
          `operation ${operation.operationId} 的 sessionId ${operation.sessionId} 与 journal ${sessionId} 不匹配`,
        )
      }
      operations.push(operation)
    }
    return freezeSnapshot(reduceOperationEvents(operations))
  }

  private async materializeMissingTerminalResults(snapshot: RecoverySnapshot) {
    const persisted = await this.journal.replayEvents()
    const materializedIds = new Set(
      persisted.flatMap((event) =>
        typeof event.materializationId === 'string' ? [event.materializationId] : []),
    )
    for (const projection of snapshot.operations.values()) {
      const materialization = materializeTerminalResult(projection)
      if (!materialization || materializedIds.has(materialization.materializationId)) continue
      await this.journal.appendToolResult({
        materializationId: materialization.materializationId,
        operationId: materialization.operationId,
        message: materializedTerminalToToolMessage(materialization),
      })
      materializedIds.add(materialization.materializationId)
    }
  }

  private async appendTransition(
    current: OperationProjection,
    draft: OperationEventDraft,
    eventId: string,
  ): Promise<OperationProjection> {
    const persisted = await this.journal.appendEvent(asSessionEventInput(draft, eventId), 'durable')
    const event = parseOperationEvent(persisted)
    return applyOperationEvent(current, event)
  }

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.exclusiveTail.then(work)
    this.exclusiveTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
