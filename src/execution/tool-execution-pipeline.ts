import { createHash, randomUUID } from 'node:crypto'
import type { ToolModelMessage } from 'ai'
import type {
  ResolvedToolInvocation,
  ToolDescriptor,
  ToolDispatchResult,
  ToolRegistry,
} from '../core/tool-registry.js'
import { truncateResult } from '../core/tool-registry.js'
import {
  ConstraintGateError,
  dispatchResolvedInvocation,
  preflightResolvedInvocation,
  type ConstraintGateErrorCode,
} from './internal-tool-dispatch.js'
import {
  TOOL_CAPABILITIES,
  type ExecutionConstraints,
  type ToolCapability,
} from '../security/capabilities.js'
import {
  PolicyEngine,
  type PolicyDecision,
  type PolicyEngineOptions,
  type PolicySource,
} from '../security/policy-engine.js'
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
  readonly capabilities: readonly ToolCapability[]
  readonly constraints: ExecutionConstraints
  readonly policyReasonCode: string
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
  readonly policySource?: PolicySource
}

export interface ToolExecutionPipelineOptions {
  readonly hooks?: PolicyEngineOptions['hooks']
  readonly rules?: PolicyEngineOptions['rules']
  readonly policySource?: PolicySource
}

interface PreparedCall {
  readonly call: CompleteToolCall
  readonly operationId: string
  readonly invocation?: ResolvedToolInvocation
  readonly input: unknown
  readonly invalidReason?: string
  readonly invalidCode?: DenialCode
  decision?: PolicyDecision
  projection: OperationProjection
}

type DenialCode =
  | 'invalid_input'
  | 'input_not_persistable'
  | 'unknown_tool'
  | 'capability_resolution_failed'
  | ConstraintGateErrorCode
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

const knownCapabilities = new Set<string>(TOOL_CAPABILITIES)

function normalizePersistedCapability(capability: string): ToolCapability {
  if (knownCapabilities.has(capability)) return capability as ToolCapability
  if (capability === 'legacy.read') return 'secret.read'
  // Historical write metadata and any unknown legacy value are conservatively
  // treated as external writes instead of making an upgraded session permissive.
  return 'external.write'
}

/** The only boundary allowed to turn a complete model tool call into a side effect. */
export class ToolExecutionPipeline {
  private readonly recovery: RecoveryCoordinator
  private readonly policyEngine: PolicyEngine
  private readonly policySource: PolicySource

  constructor(
    private readonly registry: ToolRegistry,
    private readonly journal: RecoveryJournal,
    options: ToolExecutionPipelineOptions = {},
  ) {
    this.recovery = new RecoveryCoordinator(journal)
    this.policyEngine = new PolicyEngine({ hooks: options.hooks, rules: options.rules })
    this.policySource = options.policySource ?? Object.freeze({
      type: 'internal',
      nonInteractive: false,
    })
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
      const operations = await this.recovery.listOperations()
      const existing = new Set(operations.map((item) => item.operationId))
      const priorCapabilities = Object.freeze([...new Set(operations
        .filter((item) => item.status === 'succeeded' || item.status === 'reconciled_succeeded')
        .flatMap((item) => item.latestEvent.capabilitySet.map(normalizePersistedCapability)))])
      const resolvedCalls = calls.map((call) => {
        assertContext(context)
        const operationId = stableOperationId(context, call)
        if (existing.has(operationId)) {
          throw new Error(`operation 已存在，拒绝重复执行: ${operationId}`)
        }
        existing.add(operationId)
        const resolution = this.registry.resolveInvocation(call.toolName, call.input, call.toolCallId)
        return { call, operationId, resolution }
      })
      const batchCapabilities = Object.freeze([...new Set(resolvedCalls.flatMap(({ resolution }) =>
        resolution.ok ? [...resolution.invocation.capabilities] : [],
      ))])

      for (const { call, operationId, resolution } of resolvedCalls) {
        assertContext(context)
        const safeInput = resolution.ok ? resolution.invocation.input : resolution.input
        const protection = safeProtectedInput(safeInput)
        let invalidReason = resolution.ok ? protection.error : resolution.error
        let invalidCode: DenialCode | undefined = !resolution.ok
          ? resolution.code
          : protection.error === undefined ? undefined : 'input_not_persistable'
        let decision: PolicyDecision | undefined
        if (resolution.ok && invalidReason === undefined) {
          decision = await this.policyEngine.evaluate({
            toolName: resolution.invocation.tool.name,
            input: resolution.invocation.input,
            capabilities: resolution.invocation.capabilities,
            constraints: resolution.invocation.constraints,
            batchCapabilities,
            priorCapabilities,
            toolSource: resolution.invocation.toolSource,
            source: options.policySource ?? this.policySource,
            signal: context.signal,
            deadline: context.deadline,
          })
          if (decision.behavior === 'allow' && resolution.invocation.legacyRequiresApproval) {
            decision = Object.freeze({
              behavior: 'ask',
              constraints: decision.constraints,
              reasonCode: 'policy.default.approval_required',
            })
          }
          if (decision.behavior !== 'deny') {
            try {
              preflightResolvedInvocation(resolution.invocation, decision.constraints)
            } catch (error) {
              if (!(error instanceof ConstraintGateError)) throw error
              invalidReason = error.message
              invalidCode = error.code
              decision = undefined
            }
          }
        }
        const draft = proposeOperation({
          operationId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          stepId: context.stepId,
          requestId: context.requestId,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          capabilitySet: resolution.ok ? resolution.invocation.capabilities : [],
          protectedInput: protection.protectedInput,
        }) as OperationEventDraft
        const projection = applyOperationEvent(
          undefined,
          await this.appendDraft(draft, 'buffered'),
        )
        prepared.push({
          call,
          operationId,
          ...(resolution.ok ? { invocation: resolution.invocation } : {}),
          input: safeInput,
          ...(invalidReason === undefined ? {} : { invalidReason }),
          ...(invalidCode === undefined ? {} : { invalidCode }),
          ...(decision === undefined ? {} : { decision }),
          projection,
        })
      }

      const approved: PreparedCall[] = []
      const outcomes: PipelineOutcome[] = []
      for (const item of prepared) {
        assertContext(context)
        let denial = item.invalidReason
        let denialCode = item.invalidCode
        if (!denial && item.decision?.behavior === 'deny') {
          denial = item.decision.reasonCode
          denialCode = 'policy_denied'
        }
        const request = item.invocation === undefined || item.decision === undefined ||
          item.decision.behavior === 'deny' ? undefined : {
          tool: item.invocation.tool,
          input: item.input,
          toolCallId: item.call.toolCallId,
          operationId: item.operationId,
          signal: context.signal,
          deadline: context.deadline,
          capabilities: item.invocation.capabilities,
          constraints: item.decision.constraints,
          policyReasonCode: item.decision.reasonCode,
        }
        if (!denial && request) {
          denial = options.denyReason?.(request)
          if (denial) denialCode = 'policy_denied'
        }
        if (!denial && request && item.decision?.behavior === 'ask') {
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
    if (!item.invocation || !item.decision || item.decision.behavior === 'deny') {
      throw new Error(`operation ${item.operationId} 缺少已授权的 resolved invocation`)
    }
    let started: OperationProjection | undefined
    const result: ToolDispatchResult = await dispatchResolvedInvocation(
      this.registry,
      item.invocation,
      {
        signal: context.signal,
        deadline: context.deadline,
        constraints: item.decision.constraints,
        beforeDispatch: async () => {
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
      // A sensitive-path read may contain arbitrary variable names that no
      // field-name heuristic can classify reliably. Never materialize such a
      // result into the model context, observer output, or durable journal.
      const redactedOutput = item.invocation.capabilities.includes('secret.read')
        ? '[REDACTED]'
        : redactSensitiveInput(result.rawOutput)
      protectedResult = resultPort.protect(
        modelOutput(redactedOutput, Math.min(
          result.descriptor.maxResultChars,
          item.decision.constraints.maxResultChars ?? Number.POSITIVE_INFINITY,
        )),
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
