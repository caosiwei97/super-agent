import {
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai'
import { randomUUID } from 'node:crypto'
import { LoopDetector, type DetectionResult, type ToolCallRecord } from './loop-detection.js'
import {
  ToolRegistry,
  type ToolInvocation,
} from '../core/tool-registry.js'
import {
  type CompleteToolCall,
  type PipelineApprovalRequest,
  type ToolExecutionPipeline,
} from '../execution/tool-execution-pipeline.js'
import {
  ModelGateway,
  type ModelAttemptAuditEvent,
} from '../model/model-gateway.js'

export interface BudgetState {
  used: number
  limit: number
}

export type AgentStopReason = 'completed' | 'budget' | 'loop_detected' | 'uncertain' | 'max_steps'

export interface AgentLoopResult {
  steps: number
  stopReason: AgentStopReason
}

export interface AgentLoopObserver {
  onStepStart?: (event: { step: number }) => void
  onTextDelta?: (event: { text: string }) => void
  onToolCall?: (event: { toolCallId: string; toolName: string; input: unknown }) => void
  onToolResult?: (event: { toolCallId: string; toolName: string; output: unknown }) => void
  onLoopDetection?: (event: { invocation: ToolInvocation; detection: DetectionResult }) => void
  onStreamError?: (event: { error: unknown }) => void
  onAttemptError?: (event: { attempt: number; error: unknown }) => void
  onRetry?: (event: { attempt: number; maxRetries: number; delayMs: number }) => void
  onBudget?: (event: { used: number; limit: number }) => void
  onContinue?: (event: { nextStep: number }) => void
  onStop?: (result: AgentLoopResult) => void
}

export type ToolApprovalHandler = (invocation: PipelineApprovalRequest) => Promise<boolean>

export interface AgentLoopOptions {
  model: LanguageModel
  registry: ToolRegistry
  pipeline: ToolExecutionPipeline
  sessionId: string
  turnId: string
  messages: ModelMessage[]
  buildSystem: () => string
  budget: BudgetState
  modelGateway?: ModelGateway
  signal: AbortSignal
  deadline: number
  modelRequestTimeoutMs?: number
  approveTool?: ToolApprovalHandler
  observer?: AgentLoopObserver
  beforeStep?: (step: number) => Promise<void>
  onMessages: (messages: ModelMessage[]) => Promise<void>
  onModelAttemptAudit: (
    event: ModelAttemptAuditEvent & { readonly stepId: string },
  ) => Promise<void>
  maxSteps?: number
  maxRetries?: number
}

interface GuardedCall {
  invocation: ToolInvocation
  record: ToolCallRecord
  detection: DetectionResult
}

const DEFAULT_MAX_STEPS = 15
const DEFAULT_MAX_RETRIES = 10

function notify(callback: (() => void) | undefined) {
  try {
    callback?.()
  } catch {
    // Observability must not change agent execution semantics.
  }
}

function usageTokens(usage: LanguageModelUsage | undefined) {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
}

/**
 * Runs one agent turn with retry, budget, approval and loop protection.
 *
 * Successful step messages are committed through `onMessages` immediately;
 * callers can compact the working context between steps without losing the raw
 * audit trail.
 */
export async function agentLoop(options: AgentLoopOptions) {
  const {
    model,
    registry,
    pipeline,
    sessionId,
    turnId,
    messages,
    buildSystem,
    budget,
    modelGateway = new ModelGateway(),
    signal,
    deadline,
    modelRequestTimeoutMs,
    approveTool = async () => false,
    observer = {},
    beforeStep,
    onMessages,
    onModelAttemptAudit,
    maxSteps = DEFAULT_MAX_STEPS,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options

  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new Error(`maxSteps 必须是正整数，当前值: ${maxSteps}`)
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`maxRetries 必须是非负整数，当前值: ${maxRetries}`)
  }
  if (
    !Number.isFinite(budget.used) ||
    !Number.isFinite(budget.limit) ||
    budget.used < 0 ||
    budget.limit <= 0
  ) {
    throw new Error(`非法 Token 预算: ${budget.used}/${budget.limit}`)
  }

  const stop = (result: AgentLoopResult) => {
    notify(() => observer.onStop?.(result))
    return result
  }

  if (budget.used >= budget.limit) {
    return stop({ steps: 0, stopReason: 'budget' })
  }

  const detector = new LoopDetector()

  for (let step = 1; step <= maxSteps; step++) {
    await beforeStep?.(step)
    if (budget.used >= budget.limit) {
      return stop({ steps: step - 1, stopReason: 'budget' })
    }

    notify(() => observer.onStepStart?.({ step }))
    const stepId = `${turnId}:step:${step}`
    const requestId = randomUUID()
    const generated = await modelGateway.stream({
      requestId,
      model,
      system: buildSystem(),
      tools: registry.toModelToolSet(),
      messages,
      signal,
      deadline,
      requestTimeoutMs: modelRequestTimeoutMs,
      maxRetries,
      providerOptions: { openai: { parallelToolCalls: true } },
      onTextDelta: ({ text }) => notify(() => observer.onTextDelta?.({ text })),
      onToolCall: ({ call }) => notify(() => observer.onToolCall?.({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      })),
      onStreamError: ({ error }) => notify(() => observer.onStreamError?.({ error })),
      onAttemptError: ({ attempt, error }) => {
        notify(() => observer.onAttemptError?.({ attempt, error }))
      },
      onAttemptAudit: async (event) => {
        await onModelAttemptAudit({ ...event, stepId })
        if (event.phase === 'retry_scheduled') {
          notify(() => observer.onRetry?.({
            attempt: event.attempt,
            maxRetries,
            delayMs: event.delayMs,
          }))
        }
      },
    })
    const responseMessages = generated.responseMessages
    const stepUsage: LanguageModelUsage = generated.usage
    const toolCalls: CompleteToolCall[] = [...generated.toolCalls]

    budget.used += usageTokens(stepUsage)

    // Persist the complete assistant response before proposing or dispatching
    // any operation. This keeps the causal chain recoverable after a crash.
    await onMessages(responseMessages)
    messages.push(...responseMessages)

    const guardedCalls = new Map<string, GuardedCall>()
    for (const call of toolCalls) {
      const descriptor = registry.getDescriptor(call.toolName)
      if (!descriptor) continue

      const invocation: ToolInvocation = {
        tool: descriptor,
        input: call.input,
        toolCallId: call.toolCallId,
      }
      const detection = detector.detect(call.toolName, call.input)
      const record = detector.recordCall(call.toolName, call.input)
      guardedCalls.set(call.toolCallId, { invocation, detection, record })
      if (detection.stuck) {
        notify(() => observer.onLoopDetection?.({ invocation, detection }))
      }
    }

    const criticalLoopDetected = [...guardedCalls.values()].some(
      (call) => call.detection.stuck && call.detection.level === 'critical',
    )
    const batch = toolCalls.length === 0
      ? undefined
      : await pipeline.executeBatch(
        { sessionId, turnId, stepId, requestId, signal, deadline },
        toolCalls,
        {
          approve: approveTool,
          budgetUsed: budget.used,
          denyReason: (request) => {
            if (criticalLoopDetected) {
              return '同一步检测到严重循环，已阻止全部待执行工具'
            }
            const guarded = guardedCalls.get(request.toolCallId)
            return guarded?.detection.stuck ? guarded.detection.message : undefined
          },
          onOutcome: (outcome) => {
            const event = outcome.operation.latestEvent
            const guarded = guardedCalls.get(event.toolCallId)
            const resultPart = outcome.message?.content.find(
              (part) => part.type === 'tool-result',
            )
            const safeOutput = resultPart?.output ?? { status: event.status }
            if (guarded) detector.recordResult(guarded.record, safeOutput)
            if (resultPart) {
              messages.push(outcome.message!)
              notify(() => observer.onToolResult?.({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                output: resultPart.output,
              }))
            }
          },
        },
      )

    notify(() => observer.onBudget?.({ used: budget.used, limit: budget.limit }))

    if (criticalLoopDetected) {
      return stop({ steps: step, stopReason: 'loop_detected' })
    }
    if (batch?.hasUncertain) {
      return stop({ steps: step, stopReason: 'uncertain' })
    }
    if (budget.used >= budget.limit) {
      return stop({ steps: step, stopReason: 'budget' })
    }
    if (toolCalls.length === 0) {
      return stop({ steps: step, stopReason: 'completed' })
    }

    notify(() => observer.onContinue?.({ nextStep: step + 1 }))
  }

  return stop({ steps: maxSteps, stopReason: 'max_steps' })
}
