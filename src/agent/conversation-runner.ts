import type { LanguageModel, ModelMessage } from 'ai'
import { randomUUID } from 'node:crypto'
import {
  agentLoop,
  type AgentLoopOptions,
  type AgentLoopObserver,
  type AgentLoopResult,
  type BudgetState,
  type ToolApprovalHandler,
} from './agent-loop.js'
import type { ToolRegistry } from '../core/tool-registry.js'
import type { SessionWriter } from '../session/store.js'
import {
  RecoveryCoordinator,
  type RecoveryJournal,
} from '../execution/recovery-coordinator.js'
import { ToolExecutionPipeline } from '../execution/tool-execution-pipeline.js'
import {
  compactContext,
  type CompactionOptions,
  type ContextCompactionResult,
} from '../context/compressor.js'
import { buildSystem } from '../context/prompt-builder.js'

export type CompactionPhase = 'before-turn' | 'between-steps' | 'after-turn'

export interface ConversationState {
  messages: ModelMessage[]
  summary: string
  budget: BudgetState
}

export interface RunTurnOptions {
  signal?: AbortSignal
  /** Optional absolute deadline; the runner's configured timeout may shorten it. */
  deadline?: number
}

interface TurnRuntime {
  signal: AbortSignal
  deadline: number
  dispose(): void
}

export interface ConversationRunnerOptions {
  model: LanguageModel
  registry: ToolRegistry
  store: SessionWriter & RecoveryJournal
  state: ConversationState
  compaction: CompactionOptions
  approveTool?: ToolApprovalHandler
  observer?: AgentLoopObserver
  maxSteps?: number
  maxRetries?: number
  modelRequestTimeoutMs?: number
  turnTimeoutMs?: number
  onCompaction?: (phase: CompactionPhase, result: ContextCompactionResult) => void
  runAgentLoop?: (options: AgentLoopOptions) => Promise<AgentLoopResult>
  recovery?: Pick<RecoveryCoordinator, 'assertCanStartNewTurn'>
  pipeline?: ToolExecutionPipeline
}

/** Coordinates one durable conversation turn; the CLI only handles interaction. */
export class ConversationRunner {
  private readonly runAgentLoop: (options: AgentLoopOptions) => Promise<AgentLoopResult>
  private readonly recovery: Pick<RecoveryCoordinator, 'assertCanStartNewTurn'>
  private readonly pipeline: ToolExecutionPipeline
  private turnInProgress = false

  constructor(private readonly options: ConversationRunnerOptions) {
    this.runAgentLoop = options.runAgentLoop || agentLoop
    this.recovery = options.recovery || new RecoveryCoordinator(options.store)
    this.pipeline = options.pipeline || new ToolExecutionPipeline(options.registry, options.store)
  }

  get state() {
    return this.options.state
  }

  async runTurn(input: string, options: RunTurnOptions = {}) {
    if (this.turnInProgress) throw new Error('当前已有对话轮次正在执行')
    const runtime = this.createTurnRuntime(options)
    this.turnInProgress = true
    try {
      return await this.executeTurn(input, runtime)
    } finally {
      runtime.dispose()
      this.turnInProgress = false
    }
  }

  private async executeTurn(input: string, runtime: TurnRuntime) {
    const content = input.trim()
    if (!content) throw new Error('用户输入不能为空')
    this.throwIfCancelled(runtime)
    await this.recovery.assertCanStartNewTurn()
    this.throwIfCancelled(runtime)
    const turnId = randomUUID()

    const userMessage: ModelMessage = { role: 'user', content }
    await this.options.store.appendMessages([userMessage])
    this.state.messages.push(userMessage)
    await this.compact('before-turn', runtime)

    let loopResult: AgentLoopResult | undefined
    let loopError: unknown
    try {
      loopResult = await this.runAgentLoop({
        model: this.options.model,
        registry: this.options.registry,
        pipeline: this.pipeline,
        sessionId: this.options.store.getSessionId(),
        turnId,
        signal: runtime.signal,
        deadline: runtime.deadline,
        messages: this.state.messages,
        buildSystem: () =>
          buildSystem(this.options.registry, {
            id: this.options.store.getSessionId(),
            contextMessageCount: this.state.messages.length,
          }),
        budget: this.state.budget,
        approveTool: this.options.approveTool,
        observer: this.options.observer,
        beforeStep: async (step) => {
          this.throwIfCancelled(runtime)
          if (step > 1) await this.compact('between-steps', runtime)
        },
        // `agentLoop` updates the shared budget before this callback. Persist
        // the snapshot in the same JSONL event as the raw step messages so a
        // crash cannot restore messages while losing their token cost.
        onMessages: (messages) =>
          this.options.store.appendMessages(messages, this.state.budget.used),
        onModelAttemptAudit: async (event) => {
          const eventTypes = {
            started: 'model.request.started',
            failed: 'model.request.failed',
            retry_scheduled: 'model.request.retried',
            succeeded: 'model.request.completed',
          } as const
          await this.options.store.appendEvent({
            ...event,
            type: eventTypes[event.phase],
            sessionId: this.options.store.getSessionId(),
            turnId,
          })
        },
        modelRequestTimeoutMs: this.options.modelRequestTimeoutMs,
        maxSteps: this.options.maxSteps,
        maxRetries: this.options.maxRetries,
      })
    } catch (error) {
      loopError = error
    }

    try {
      await this.compact('after-turn', runtime)
      await this.options.store.appendCheckpoint({
        messages: this.state.messages,
        summary: this.state.summary,
        budgetUsed: this.state.budget.used,
      })
    } catch (finalizeError) {
      if (loopError) {
        throw new AggregateError([loopError, finalizeError], 'Agent Loop 与会话收尾均失败')
      }
      throw finalizeError
    }

    if (loopError) throw loopError
    return loopResult!
  }

  private async compact(phase: CompactionPhase, runtime: TurnRuntime) {
    const result = await compactContext(
      this.options.model,
      this.state.messages,
      this.state.summary,
      this.options.compaction,
      {
        allowSummary: this.state.budget.used < this.state.budget.limit &&
          !runtime.signal.aborted && Date.now() < runtime.deadline,
        signal: runtime.signal,
        deadline: runtime.deadline,
      },
    )

    this.state.messages.splice(0, this.state.messages.length, ...result.messages)
    this.state.summary = result.summary
    this.state.budget.used += result.usageTokens

    // Between-step and pre-turn compaction happen before the final turn
    // checkpoint. Persist material context/budget changes immediately so they
    // remain recoverable if the following model request fails or the process exits.
    const changed = result.cleared > 0 || result.compressedCount > 0 || result.usageTokens > 0
    if (changed && phase !== 'after-turn') {
      await this.options.store.appendCheckpoint({
        messages: this.state.messages,
        summary: this.state.summary,
        budgetUsed: this.state.budget.used,
      })
    }

    try {
      this.options.onCompaction?.(phase, result)
    } catch {
      // An observability callback must not invalidate a durable turn.
    }
  }

  private createTurnRuntime(options: RunTurnOptions): TurnRuntime {
    const timeoutMs = this.options.turnTimeoutMs ?? 120_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('turnTimeoutMs 必须是正数')
    }
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
      throw new Error('runTurn.deadline 必须是有限时间戳')
    }
    const deadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, Date.now() + timeoutMs)
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new DOMException('Turn aborted', 'AbortError'),
    )
    if (options.signal?.aborted) forwardAbort()
    else options.signal?.addEventListener('abort', forwardAbort, { once: true })
    const remaining = deadline - Date.now()
    const timer = remaining <= 0
      ? undefined
      : setTimeout(() => controller.abort(
        new DOMException('Turn deadline exceeded', 'TimeoutError'),
      ), Math.min(remaining, 2_147_483_647))
    if (remaining <= 0 && !controller.signal.aborted) {
      controller.abort(new DOMException('Turn deadline exceeded', 'TimeoutError'))
    }
    return {
      signal: controller.signal,
      deadline,
      dispose() {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', forwardAbort)
      },
    }
  }

  private throwIfCancelled(runtime: Pick<TurnRuntime, 'signal' | 'deadline'>) {
    if (runtime.signal.aborted) {
      throw runtime.signal.reason instanceof Error
        ? runtime.signal.reason
        : new DOMException('Turn aborted', 'AbortError')
    }
    if (Date.now() >= runtime.deadline) {
      throw new DOMException('Turn deadline exceeded', 'TimeoutError')
    }
  }
}
