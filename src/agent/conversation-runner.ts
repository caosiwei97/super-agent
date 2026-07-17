import type { LanguageModel, ModelMessage } from 'ai'
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

export interface ConversationRunnerOptions {
  model: LanguageModel
  registry: ToolRegistry
  store: SessionWriter
  state: ConversationState
  compaction: CompactionOptions
  approveTool?: ToolApprovalHandler
  observer?: AgentLoopObserver
  maxSteps?: number
  maxRetries?: number
  onCompaction?: (phase: CompactionPhase, result: ContextCompactionResult) => void
  runAgentLoop?: (options: AgentLoopOptions) => Promise<AgentLoopResult>
}

/** Coordinates one durable conversation turn; the CLI only handles interaction. */
export class ConversationRunner {
  private readonly runAgentLoop: (options: AgentLoopOptions) => Promise<AgentLoopResult>
  private turnInProgress = false

  constructor(private readonly options: ConversationRunnerOptions) {
    this.runAgentLoop = options.runAgentLoop || agentLoop
  }

  get state() {
    return this.options.state
  }

  async runTurn(input: string) {
    if (this.turnInProgress) throw new Error('当前已有对话轮次正在执行')
    this.turnInProgress = true
    try {
      return await this.executeTurn(input)
    } finally {
      this.turnInProgress = false
    }
  }

  private async executeTurn(input: string) {
    const content = input.trim()
    if (!content) throw new Error('用户输入不能为空')

    const userMessage: ModelMessage = { role: 'user', content }
    await this.options.store.appendMessages([userMessage])
    this.state.messages.push(userMessage)
    await this.compact('before-turn')

    let loopResult: AgentLoopResult | undefined
    let loopError: unknown
    try {
      loopResult = await this.runAgentLoop({
        model: this.options.model,
        registry: this.options.registry,
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
          if (step > 1) await this.compact('between-steps')
        },
        // `agentLoop` updates the shared budget before this callback. Persist
        // the snapshot in the same JSONL event as the raw step messages so a
        // crash cannot restore messages while losing their token cost.
        onMessages: (messages) =>
          this.options.store.appendMessages(messages, this.state.budget.used),
        maxSteps: this.options.maxSteps,
        maxRetries: this.options.maxRetries,
      })
    } catch (error) {
      loopError = error
    }

    try {
      await this.compact('after-turn')
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

  private async compact(phase: CompactionPhase) {
    const result = await compactContext(
      this.options.model,
      this.state.messages,
      this.state.summary,
      this.options.compaction,
      { allowSummary: this.state.budget.used < this.state.budget.limit },
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
}
