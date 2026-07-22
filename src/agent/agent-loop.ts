import {
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolModelMessage,
} from 'ai'
import { LoopDetector, type DetectionResult, type ToolCallRecord } from './loop-detection.js'
import { calculateDelay, isRetryable, sleep } from './retry.js'
import {
  ToolRegistry,
  type ToolInvocation,
  type ToolRuntimeHooks,
} from '../core/tool-registry.js'

export interface TokenCostState {
  used: number
  limit: number
}

export type AgentStopReason = 'completed' | 'cost_exhausted' | 'loop_detected' | 'max_steps'

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
  onTokenCost?: (event: { used: number; limit: number }) => void
  onContinue?: (event: { nextStep: number }) => void
  onStop?: (result: AgentLoopResult) => void
}

export type ToolApprovalHandler = (invocation: ToolInvocation) => Promise<boolean>

export interface AgentLoopOptions {
  model: LanguageModel
  registry: ToolRegistry
  messages: ModelMessage[]
  buildSystem: () => string
  tokenCost: TokenCostState
  approveTool?: ToolApprovalHandler
  observer?: AgentLoopObserver
  beforeStep?: (step: number) => Promise<void>
  /** 每次成功模型请求返回的精确 prompt token，用于校准上下文估算。 */
  onInputTokens?: (inputTokens: number) => void
  onMessages?: (messages: ModelMessage[]) => Promise<void>
  maxSteps?: number
  maxRetries?: number
}

interface GuardedCall {
  invocation: ToolInvocation
  record: ToolCallRecord
  detection: DetectionResult
}

interface ApprovalRequest {
  approvalId: string
  toolCallId: string
}

const DEFAULT_MAX_STEPS = 15
const DEFAULT_MAX_RETRIES = 10

function notify(callback: (() => void) | undefined) {
  try {
    callback?.()
  } catch {
    // 可观测性回调不得改变智能体的执行语义。
  }
}

function usageTokens(usage: LanguageModelUsage | undefined) {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
}

function deniedToolResult(call: GuardedCall, reason: string) {
  return {
    type: 'tool-result',
    toolCallId: call.invocation.toolCallId,
    toolName: call.invocation.tool.name,
    output: { type: 'execution-denied', reason },
  } satisfies ToolModelMessage['content'][number]
}

/**
 * 运行一轮智能体，对重试、成本预算、审批和循环进行保护。
 *
 * 每个成功步骤的消息都会立即通过 `onMessages` 持久化；
 * 调用方可以在步骤之间压缩工作上下文，同时保留原始审计记录。
 */
export async function agentLoop(options: AgentLoopOptions) {
  const {
    model,
    registry,
    messages,
    buildSystem,
    tokenCost,
    approveTool = async () => false,
    observer = {},
    beforeStep,
    onInputTokens,
    onMessages,
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
    !Number.isFinite(tokenCost.used) ||
    !Number.isFinite(tokenCost.limit) ||
    tokenCost.used < 0 ||
    tokenCost.limit <= 0
  ) {
    throw new Error(`非法 token 成本: ${tokenCost.used}/${tokenCost.limit}`)
  }

  const stop = (result: AgentLoopResult) => {
    notify(() => observer.onStop?.(result))
    return result
  }

  if (tokenCost.used >= tokenCost.limit) {
    return stop({ steps: 0, stopReason: 'cost_exhausted' })
  }

  const detector = new LoopDetector()
  const guardedCalls = new Map<string, GuardedCall>()

  const runtimeHooks: ToolRuntimeHooks = {
    inspectToolCall: (invocation) => {
      const existing = guardedCalls.get(invocation.toolCallId)
      if (existing) return existing.detection.stuck

      const detection = detector.detect(invocation.tool.name, invocation.input)
      const record = detector.recordCall(invocation.tool.name, invocation.input)
      guardedCalls.set(invocation.toolCallId, { invocation, record, detection })

      if (detection.stuck) {
        notify(() => observer.onLoopDetection?.({ invocation, detection }))
      }
      return detection.stuck
    },
    onToolResult: (invocation, result) => {
      const call = guardedCalls.get(invocation.toolCallId)
      if (call) detector.recordResult(call.record, result)
    },
  }

  for (let step = 1; step <= maxSteps; step++) {
    await beforeStep?.(step)
    if (tokenCost.used >= tokenCost.limit) {
      return stop({ steps: step - 1, stopReason: 'cost_exhausted' })
    }

    notify(() => observer.onStepStart?.({ step }))
    let hasToolCall = false
    let responseMessages: ModelMessage[] = []
    let stepUsage: LanguageModelUsage | undefined
    let approvalRequests: ApprovalRequest[] = []

    for (let attempt = 1; ; attempt++) {
      try {
        const currentApprovals: ApprovalRequest[] = []
        const result = streamText({
          model,
          system: buildSystem(),
          tools: registry.toAISDKFormat(runtimeHooks),
          messages,
          maxRetries: 0,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: (error) => notify(() => observer.onStreamError?.({ error })),
        })

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              notify(() => observer.onTextDelta?.({ text: part.text }))
              break

            case 'tool-call':
              hasToolCall = true
              notify(() => observer.onToolCall?.({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              }))
              break

            case 'tool-result':
              notify(() => observer.onToolResult?.({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: part.output,
              }))
              break

            case 'tool-approval-request':
              currentApprovals.push({
                approvalId: part.approvalId,
                toolCallId: part.toolCall.toolCallId,
              })
              break
          }
        }

        responseMessages = (await result.response).messages
        stepUsage = await result.usage
        approvalRequests = currentApprovals
        break
      } catch (error) {
        notify(() => observer.onAttemptError?.({ attempt, error }))
        if (attempt > maxRetries || !isRetryable(error)) throw error

        const delay = calculateDelay(attempt)
        notify(() => observer.onRetry?.({ attempt, maxRetries, delayMs: delay }))
        await sleep(delay)
        hasToolCall = false
      }
    }

    tokenCost.used += usageTokens(stepUsage)
    if (typeof stepUsage?.inputTokens === 'number') {
      onInputTokens?.(stepUsage.inputTokens)
    }
    const committedMessages = [...responseMessages]
    let criticalLoopDetected = false

    if (approvalRequests.length > 0) {
      const approvalContent: ToolModelMessage['content'] = []
      const calls = approvalRequests.map((request) => {
        const call = guardedCalls.get(request.toolCallId)
        if (!call) throw new Error(`找不到待审批工具调用: ${request.toolCallId}`)
        return { request, call }
      })
      criticalLoopDetected = calls.some(
        ({ call }) => call.detection.stuck && call.detection.level === 'critical',
      )

      for (const { request, call } of calls) {
        const loopBlocked = call.detection.stuck
        const approved = !criticalLoopDetected && !loopBlocked && (await approveTool(call.invocation))
        const reason = criticalLoopDetected
          ? '同一步检测到严重循环，已阻止全部待执行工具'
          : loopBlocked
            ? call.detection.message
            : approved
              ? undefined
              : '用户拒绝执行'

        approvalContent.push({
          type: 'tool-approval-response',
          approvalId: request.approvalId,
          approved,
          reason,
        })

        if (!approved) {
          const denied = deniedToolResult(call, reason || '工具执行被拒绝')
          approvalContent.push(denied)
          detector.recordResult(call.record, denied)
          continue
        }

        const execution = await registry.executeTool(
          call.invocation.tool.name,
          call.invocation.input,
          call.invocation.toolCallId,
          runtimeHooks,
        )
        approvalContent.push({
          type: 'tool-result',
          toolCallId: call.invocation.toolCallId,
          toolName: call.invocation.tool.name,
          output: execution.ok
            ? { type: 'text', value: execution.output }
            : { type: 'error-text', value: execution.output },
        })
        notify(() => observer.onToolResult?.({
          toolCallId: call.invocation.toolCallId,
          toolName: call.invocation.tool.name,
          output: execution.output,
        }))
      }

      committedMessages.push({ role: 'tool', content: approvalContent })
    }

    await onMessages?.(committedMessages)
    messages.push(...committedMessages)

    notify(() => observer.onTokenCost?.({ used: tokenCost.used, limit: tokenCost.limit }))

    if (criticalLoopDetected) {
      return stop({ steps: step, stopReason: 'loop_detected' })
    }
    if (tokenCost.used >= tokenCost.limit) {
      return stop({ steps: step, stopReason: 'cost_exhausted' })
    }
    if (!hasToolCall) {
      return stop({ steps: step, stopReason: 'completed' })
    }

    notify(() => observer.onContinue?.({ nextStep: step + 1 }))
  }

  return stop({ steps: maxSteps, stopReason: 'max_steps' })
}
