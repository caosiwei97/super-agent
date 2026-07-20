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
  compaction?: Partial<CompactionOptions>
  approveTool?: ToolApprovalHandler
  observer?: AgentLoopObserver
  onCompaction?: (phase: CompactionPhase, result: ContextCompactionResult) => void
  runAgentLoop?: (options: AgentLoopOptions) => Promise<AgentLoopResult>
}

/** 编排一个可持久化的对话轮次；命令行界面只负责交互。 */
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
        // `agentLoop` 会在此回调前更新共享预算。将预算快照与原始步骤消息
        // 持久化到同一条 JSONL 事件中，避免崩溃恢复消息时丢失对应的令牌消耗。
        onMessages: (messages) =>
          this.options.store.appendMessages(messages, this.state.budget.used),
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
      this.options.compaction ?? {},
      { allowSummary: this.state.budget.used < this.state.budget.limit },
    )

    this.state.messages.splice(0, this.state.messages.length, ...result.messages)
    this.state.summary = result.summary
    this.state.budget.used += result.usageTokens

    // 步骤间压缩和轮次前压缩发生在最终轮次检查点之前。
    // 重要的上下文或预算变化需要立即持久化，确保后续模型请求失败或进程退出时仍可恢复。
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
      // 可观测性回调不得破坏已持久化的对话轮次。
    }
  }
}
