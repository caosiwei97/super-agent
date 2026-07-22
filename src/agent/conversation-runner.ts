import type { LanguageModel, ModelMessage } from 'ai'
import {
  agentLoop,
  type AgentLoopOptions,
  type AgentLoopObserver,
  type AgentLoopResult,
  type TokenCostState,
  type ToolApprovalHandler,
} from './agent-loop.js'
import type { ToolRegistry } from '../core/tool-registry.js'
import type { SessionWriter } from '../session/store.js'
import {
  compactContext,
  type CompactionOptions,
  type ContextCompactionResult,
} from '../context/compressor.js'
import { TokenTracker } from '../context/defense.js'
import { buildSystem } from '../context/prompt-builder.js'

export type CompactionPhase = 'before-turn' | 'between-steps' | 'after-turn'

export interface ConversationState {
  messages: ModelMessage[]
  messageTimestamps?: number[]
  summary: string
  tokenCost: TokenCostState
}

export interface ConversationRunnerOptions {
  model: LanguageModel
  registry: ToolRegistry
  store: SessionWriter
  state: ConversationState
  compaction?: Partial<CompactionOptions>
  approveTool?: ToolApprovalHandler
  observer?: AgentLoopObserver
  onCompaction?: (phase: CompactionPhase, result: ContextCompactionResult) => void
  runAgentLoop?: (options: AgentLoopOptions) => Promise<AgentLoopResult>
}

/** 编排一个可持久化的对话轮次；命令行界面只负责交互。 */
export class ConversationRunner {
  private readonly runAgentLoop: (options: AgentLoopOptions) => Promise<AgentLoopResult>
  private readonly tokenTracker: TokenTracker
  private turnInProgress = false

  constructor(private readonly options: ConversationRunnerOptions) {
    this.runAgentLoop = options.runAgentLoop || agentLoop
    const now = Date.now()
    const timestamps = options.state.messageTimestamps ?? []
    options.state.messageTimestamps = options.state.messages.map((_, index) => {
      const timestamp = timestamps[index]
      return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : now
    })
    this.tokenTracker = new TokenTracker(options.state.messages, options.compaction)
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
    this.state.messageTimestamps!.push(Date.now())
    this.tokenTracker.addMessages([userMessage])
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
        tokenCost: this.state.tokenCost,
        approveTool: this.options.approveTool,
        observer: this.options.observer,
        beforeStep: async (step) => {
          if (step > 1) await this.compact('between-steps')
        },
        onInputTokens: (inputTokens) => this.tokenTracker.updateFromAPI(inputTokens),
        // `agentLoop` 会在此回调前更新共享成本预算。将成本预算快照与原始步骤消息
        // 持久化到同一条 JSONL 事件中，避免崩溃恢复消息时丢失对应的令牌消耗。
        onMessages: async (messages) => {
          await this.options.store.appendMessages(messages, this.state.tokenCost.used)
          const timestamp = Date.now()
          this.state.messageTimestamps!.push(...messages.map(() => timestamp))
          this.tokenTracker.addMessages(messages)
        },
      })
    } catch (error) {
      loopError = error
    }

    try {
      await this.compact('after-turn')
      await this.options.store.appendCheckpoint({
        messages: this.state.messages,
        messageTimestamps: this.state.messageTimestamps,
        summary: this.state.summary,
        budgetUsed: this.state.tokenCost.used,
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
      this.options.compaction ?? {},
      {
        allowSummary: this.state.tokenCost.used < this.state.tokenCost.limit,
        estimatedTokens: this.tokenTracker.estimatedTokens,
      },
      this.state.messageTimestamps,
    )

    this.state.messages.splice(0, this.state.messages.length, ...result.messages)
    this.state.messageTimestamps!.splice(
      0,
      this.state.messageTimestamps!.length,
      ...result.messageTimestamps,
    )
    this.state.summary = result.summary
    this.state.tokenCost.used += result.usageTokens
    this.tokenTracker.rebase(result.afterTokens)

    // 步骤间压缩和轮次前压缩发生在最终轮次检查点之前。
    // 重要的上下文或成本预算变化需要立即持久化，确保后续模型请求失败或进程退出时仍可恢复。
    const changed = result.truncated > 0 || result.compacted > 0 ||
      result.softPruned > 0 || result.hardPruned > 0 || result.cleared > 0 ||
      result.compressedCount > 0 || result.usageTokens > 0
    if (changed && phase !== 'after-turn') {
      await this.options.store.appendCheckpoint({
        messages: this.state.messages,
        messageTimestamps: this.state.messageTimestamps,
        summary: this.state.summary,
        budgetUsed: this.state.tokenCost.used,
      })
    }

    try {
      this.options.onCompaction?.(phase, result)
    } catch {
      // 可观测性回调不得破坏已持久化的对话轮次。
    }
  }
}
