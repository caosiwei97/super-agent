import { createHash, randomUUID } from 'node:crypto'
import type { ToolModelMessage } from 'ai'
import type {
  ToolDescriptor,
  ToolDispatchResult,
  ToolInvocation,
  ToolRegistry,
} from '../core/tool-registry.js'
import { truncateResult } from '../core/tool-registry.js'
import type { EventDurability, SessionEventInput } from '../session/store.js'
import {
  applyOperationEvent,
  createOperationInputDigestPort,
  createOperationResultProtectionPort,
  parseOperationEvent,
  proposeOperation,
  redactSensitiveInput,
  transitionOperation,
} from './operation-ledger.js'
import type {
  OperationEventDraft,
  OperationProjection,
  ProtectedOperationInput,
} from './operation-types.js'
import {
  RecoveryCoordinator,
  materializeTerminalResult,
  materializedTerminalToToolMessage,
  type RecoveryJournal,
} from './recovery-coordinator.js'

export interface RunContext {
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly requestId: string
  readonly signal: AbortSignal
  readonly deadline: number
}

export interface CompleteToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

export interface PipelineApprovalRequest {
  readonly tool: ToolDescriptor
  readonly input: unknown
  readonly toolCallId: string
  readonly operationId: string
  readonly signal: AbortSignal
  readonly deadline: number
}

export interface PipelineOutcome {
  readonly operation: OperationProjection
  readonly message?: ToolModelMessage
}

export interface PipelineBatchResult {
  readonly outcomes: readonly PipelineOutcome[]
  readonly hasUncertain: boolean
}

export interface PipelineBatchOptions {
  readonly approve?: (request: PipelineApprovalRequest) => Promise<boolean>
  readonly denyReason?: (request: PipelineApprovalRequest) => string | undefined
  readonly budgetUsed?: number
  readonly onOutcome?: (outcome: PipelineOutcome) => Promise<void> | void
}

interface PreparedCall {
  readonly call: CompleteToolCall
  readonly operationId: string
  readonly descriptor?: ToolDescriptor
  readonly input: unknown
  readonly invalidReason?: string
  readonly invalidCode?: DenialCode
  projection: OperationProjection
}

type DenialCode =
  | 'invalid_input'
  | 'input_not_persistable'
  | 'unknown_tool'
  | 'policy_denied'
  | 'approval_denied'
  | 'approval_error'

const inputPort = createOperationInputDigestPort({ redact: redactSensitiveInput })
const resultPort = createOperationResultProtectionPort({
  redact: redactSensitiveInput,
  includeModelResult: true,
})

function stableOperationId(context: RunContext, call: CompleteToolCall) {
  const digest = createHash('sha256')
    .update([
      'super-agent:operation:v1',
      context.sessionId,
      context.turnId,
      context.stepId,
      call.toolCallId,
    ].join('\0'))
    .digest('hex')
  return `op-${digest}`
}

function assertContext(context: RunContext) {
  for (const [field, value] of Object.entries({
    sessionId: context.sessionId,
    turnId: context.turnId,
    stepId: context.stepId,
    requestId: context.requestId,
  })) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`RunContext.${field} 不能为空`)
    }
  }
  if (!(context.signal instanceof AbortSignal)) throw new Error('RunContext.signal 必填')
  if (!Number.isFinite(context.deadline)) throw new Error('RunContext.deadline 必须为有限时间戳')
  if (context.signal.aborted) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new DOMException('operation 已取消', 'AbortError')
  }
  if (Date.now() >= context.deadline) {
    throw new DOMException('operation deadline 已到期', 'TimeoutError')
  }
}

function isCancellation(error: unknown, context: RunContext) {
  return context.signal.aborted ||
    (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
}

function safeProtectedInput(input: unknown): { protectedInput: ProtectedOperationInput; error?: string } {
  try {
    return { protectedInput: inputPort.protect(input) }
  } catch (error) {
    return {
      protectedInput: inputPort.protect({ omitted: 'input_not_persistable' }),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function modelOutput(rawOutput: unknown, maxChars: number) {
  if (typeof rawOutput === 'string') return truncateResult(rawOutput, maxChars)
  const serialized = JSON.stringify(rawOutput, null, 2)
  if (serialized === undefined) throw new Error('工具结果无法序列化')
  return truncateResult(serialized, maxChars)
}

/** The only boundary allowed to turn a complete model tool call into a side effect. */
export class ToolExecutionPipeline {
  private readonly recovery: RecoveryCoordinator

  constructor(
    private readonly registry: ToolRegistry,
    private readonly journal: RecoveryJournal,
  ) {
    this.recovery = new RecoveryCoordinator(journal)
  }

  async executeBatch(
    context: RunContext,
    calls: readonly CompleteToolCall[],
    options: PipelineBatchOptions = {},
  ): Promise<PipelineBatchResult> {
    assertContext(context)
    if (context.sessionId !== this.journal.getSessionId()) {
      throw new Error('RunContext.sessionId 与 journal 不匹配')
    }
    if (new Set(calls.map((call) => call.toolCallId)).size !== calls.length) {
      throw new Error('同一 batch 不能包含重复 toolCallId')
    }

    const prepared: PreparedCall[] = []
    try {
      const existing = new Set((await this.recovery.listOperations()).map((item) => item.operationId))
      for (const call of calls) {
        assertContext(context)
        const operationId = stableOperationId(context, call)
        if (existing.has(operationId)) {
          throw new Error(`operation 已存在，拒绝重复执行: ${operationId}`)
        }
        const descriptor = this.registry.getDescriptor(call.toolName)
        const validation = this.registry.validateToolInput(call.toolName, call.input)
        const safeInput = validation.ok ? validation.input : call.input
        const protection = safeProtectedInput(safeInput)
        const invalidReason = validation.ok ? protection.error : validation.error
        const invalidCode: DenialCode | undefined = descriptor === undefined
          ? 'unknown_tool'
          : !validation.ok
            ? 'invalid_input'
            : protection.error === undefined
              ? undefined
              : 'input_not_persistable'
        const draft = proposeOperation({
          operationId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          stepId: context.stepId,
          requestId: context.requestId,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          capabilitySet: descriptor?.capabilitySet ?? ['tool.unknown'],
          protectedInput: protection.protectedInput,
        }) as OperationEventDraft
        const projection = applyOperationEvent(
          undefined,
          await this.appendDraft(draft, 'buffered'),
        )
        existing.add(operationId)
        prepared.push({
          call,
          operationId,
          descriptor,
          input: safeInput,
          ...(invalidReason === undefined ? {} : { invalidReason }),
          ...(invalidCode === undefined ? {} : { invalidCode }),
          projection,
        })
      }

      const approved: PreparedCall[] = []
      const outcomes: PipelineOutcome[] = []
      for (const item of prepared) {
        assertContext(context)
        let denial = item.invalidReason
        let denialCode = item.invalidCode
        const request = item.descriptor === undefined ? undefined : {
          tool: item.descriptor,
          input: item.input,
          toolCallId: item.call.toolCallId,
          operationId: item.operationId,
          signal: context.signal,
          deadline: context.deadline,
        }
        if (!denial && request === undefined) {
          denial = `工具不存在: ${item.call.toolName}`
          denialCode = 'unknown_tool'
        }
        if (!denial && request) {
          denial = options.denyReason?.(request)
          if (denial) denialCode = 'policy_denied'
        }
        if (!denial && request && request.tool.requiresApproval) {
          try {
            const approvedByPolicy = await (options.approve?.(request) ?? Promise.resolve(false))
            assertContext(context)
            if (!approvedByPolicy) {
              denial = '用户或策略拒绝执行'
              denialCode = 'approval_denied'
            }
          } catch (error) {
            if (isCancellation(error, context)) throw error
            denial = `审批失败: ${error instanceof Error ? error.message : String(error)}`
            denialCode = 'approval_error'
          }
        }

        if (denial) {
          item.projection = await this.transition(item.projection, {
            kind: 'deny',
            errorCode: denialCode || 'policy_denied',
          }, 'durable')
          const outcome = await this.commitTerminal(item.projection, options.budgetUsed)
          outcomes.push(outcome)
          await options.onOutcome?.(outcome)
        } else {
          item.projection = await this.transition(item.projection, { kind: 'approve' }, 'buffered')
          approved.push(item)
        }
      }

      const settled = await Promise.allSettled(approved.map(async (item) => {
        const outcome = await this.executeApproved(context, item, options.budgetUsed)
        await options.onOutcome?.(outcome)
        return outcome
      }))
      outcomes.push(...settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []))
      const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, '多个工具执行未能安全收束')

      const ordered = prepared.map((item) => {
        const outcome = outcomes.find((candidate) => candidate.operation.operationId === item.operationId)
        if (!outcome) throw new Error(`operation 缺少 outcome: ${item.operationId}`)
        return outcome
      })
      return Object.freeze({
        outcomes: Object.freeze(ordered),
        hasUncertain: ordered.some((outcome) => outcome.operation.status === 'uncertain'),
      })
    } catch (error) {
      const cleanupErrors = await this.settleInterrupted(prepared, options)
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Pipeline 失败且 operation 收束不完整')
      }
      throw error
    }
  }

  private async executeApproved(
    context: RunContext,
    item: PreparedCall,
    budgetUsed?: number,
  ): Promise<PipelineOutcome> {
    assertContext(context)
    let started: OperationProjection | undefined
    const result: ToolDispatchResult = await this.registry.dispatchTool(
      item.call.toolName,
      item.input,
      item.call.toolCallId,
      {
        signal: context.signal,
        deadline: context.deadline,
        beforeDispatch: async (_invocation: ToolInvocation) => {
          assertContext(context)
          started = await this.transition(item.projection, {
            kind: 'start',
            attemptId: randomUUID(),
          }, 'durable')
          item.projection = started
        },
      },
    )
    if (!started) throw new Error(`工具 ${item.call.toolName} 未经过 durable start gate`)

    if (result.outcome === 'uncertain') {
      item.projection = await this.transition(started, {
        kind: 'mark_uncertain',
        errorCode: result.errorCode,
      }, 'durable')
      return Object.freeze({ operation: item.projection })
    }

    let protectedResult
    try {
      // Redact while field names are still available. Serializing first would
      // turn `{ apiKey: "..." }` into an opaque string and defeat field-based
      // secret removal before it reaches the durable journal.
      const redactedOutput = redactSensitiveInput(result.rawOutput)
      protectedResult = resultPort.protect(
        modelOutput(redactedOutput, result.descriptor.maxResultChars),
      )
    } catch {
      // The closure already resolved successfully. Persist success even when its
      // model-facing representation cannot be recovered.
      protectedResult = undefined
    }
    item.projection = await this.transition(started, {
      kind: 'succeed',
      ...(protectedResult === undefined ? {} : { protectedResult }),
    }, 'durable')
    return this.commitTerminal(item.projection, budgetUsed)
  }

  private async settleInterrupted(
    prepared: readonly PreparedCall[],
    options: PipelineBatchOptions,
  ) {
    const errors: unknown[] = []
    for (const item of prepared) {
      try {
        if (item.projection.status === 'proposed' || item.projection.status === 'approved') {
          item.projection = await this.transition(item.projection, {
            kind: 'cancel',
            dispatchState: 'not_dispatched',
            errorCode: 'execution_interrupted_before_dispatch',
          }, 'durable')
        } else if (item.projection.status === 'started') {
          item.projection = await this.transition(item.projection, {
            kind: 'mark_uncertain',
            errorCode: 'execution_interrupted_after_start',
          }, 'durable')
        } else {
          continue
        }
        const outcome = await this.commitTerminal(item.projection, options.budgetUsed)
        await options.onOutcome?.(outcome)
      } catch (cleanupError) {
        errors.push(cleanupError)
      }
    }
    return errors
  }

  private async commitTerminal(
    projection: OperationProjection,
    budgetUsed?: number,
  ): Promise<PipelineOutcome> {
    const materialization = materializeTerminalResult(projection)
    if (!materialization) return Object.freeze({ operation: projection })
    const message = materializedTerminalToToolMessage(materialization)
    await this.journal.appendToolResult({
      materializationId: materialization.materializationId,
      operationId: materialization.operationId,
      message,
    }, budgetUsed)
    return Object.freeze({ operation: projection, message })
  }

  private async transition(
    current: OperationProjection,
    transition: Parameters<typeof transitionOperation>[1],
    durability: EventDurability,
  ) {
    const draft = transitionOperation(current, transition) as OperationEventDraft
    return applyOperationEvent(current, await this.appendDraft(draft, durability))
  }

  private async appendDraft(draft: OperationEventDraft, durability: EventDurability) {
    return parseOperationEvent(
      await this.journal.appendEvent({ ...draft } as SessionEventInput, durability),
    )
  }
}
