import { createInterface, type Interface } from 'node:readline'
import type { LanguageModel } from 'ai'
import {
  ConversationRunner,
  type CompactionPhase,
  type ConversationState,
} from '../agent/conversation-runner.js'
import type { AgentLoopObserver, ToolApprovalHandler } from '../agent/agent-loop.js'
import type { ToolRegistry } from '../core/tool-registry.js'
import type { CompactionOptions, ContextCompactionResult } from '../context/compressor.js'
import type { SessionWriter } from '../session/store.js'
import type { RecoveryJournal } from '../execution/recovery-coordinator.js'
import { redactSensitiveInput } from '../execution/operation-ledger.js'
import type { PipelineApprovalRequest } from '../execution/tool-execution-pipeline.js'
import { killActiveProcessGroupsSync } from '../execution/process-executor.js'

export interface CliRuntimeDeps {
  model: LanguageModel
  registry: ToolRegistry
  store: SessionWriter & RecoveryJournal
  state: ConversationState
  compaction: CompactionOptions
  maxSteps: number
  maxRetries: number
  modelRequestTimeoutMs: number
  turnTimeoutMs: number
  autoApprove: boolean
}

export function printStartupStats(registry: ToolRegistry) {
  const allTools = registry.getAll()
  const activeTools = registry.getActiveTools()
  const estimate = registry.countTokenEstimate()

  console.log(`已注册 ${allTools.length} 个工具：`)
  for (const tool of allTools) {
    console.log(`  - ${tool.name}（能力、约束、并发与审批按调用动态判定）`)
  }

  console.log('\n=== 工具统计 ===')
  console.log(`  全部工具: ${allTools.length} 个`)
  console.log(`  活跃工具: ${activeTools.length} 个`)
  console.log(`  延迟工具: ${allTools.length - activeTools.length} 个`)
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`)
  console.log('  权限策略: 每次调用由 Capability Resolver + Policy Engine 判定')
}

function printCompaction(phase: CompactionPhase, result: ContextCompactionResult) {
  if (result.error) console.warn(`[Compaction] LLM 摘要失败: ${result.error}`)
  if (result.cleared === 0 && result.compressedCount === 0) return

  const phaseLabel: Record<CompactionPhase, string> = {
    'before-turn': '发送前',
    'between-steps': 'Step 间',
    'after-turn': 'Agent Loop 后',
  }
  const actions: string[] = []
  if (result.cleared > 0) actions.push(`清理 ${result.cleared} 个旧工具结果`)
  if (result.compressedCount > 0) actions.push(`摘要 ${result.compressedCount} 条消息`)
  const saved = Math.max(0, result.beforeTokens - result.afterTokens)

  console.log(
    `[Context:${phaseLabel[phase]}] ${actions.join('，')}，` +
      `~${result.beforeTokens} → ~${result.afterTokens} tokens` +
      (saved > 0 ? `（节省 ~${saved}）` : ''),
  )
}

export function inputPreview(input: unknown) {
  try {
    const serialized = JSON.stringify(redactSensitiveInput(input))
    if (!serialized) return '[无法安全预览]'
    return serialized.length > 500 ? `${serialized.slice(0, 500)}…` : serialized
  } catch {
    return '[无法安全预览]'
  }
}

export function createInteractiveApprovalHandler(
  rl: Interface,
  autoApprove: boolean,
): ToolApprovalHandler {
  return async (invocation: PipelineApprovalRequest) => {
    if (invocation.signal.aborted) {
      throw invocation.signal.reason instanceof Error
        ? invocation.signal.reason
        : new DOMException('Approval aborted', 'AbortError')
    }
    const description = `${invocation.tool.name}(${inputPreview(invocation.input)})`
    if (autoApprove) {
      console.log(`  [自动批准: ${description}]`)
      return true
    }
    if (!rl.terminal) {
      console.log(`  [拒绝: 非交互环境无法审批 ${invocation.tool.name}]`)
      return false
    }

    return new Promise<boolean>((resolve, reject) => {
      let settled = false
      const cleanup = () => invocation.signal.removeEventListener('abort', onAbort)
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(invocation.signal.reason instanceof Error
          ? invocation.signal.reason
          : new DOMException('Approval aborted', 'AbortError'))
      }
      invocation.signal.addEventListener('abort', onAbort, { once: true })
      rl.question(`\n批准执行 ${description}？[y/N] `, { signal: invocation.signal }, (answer) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(['y', 'yes'].includes(answer.trim().toLowerCase()))
      })
    })
  }
}

function createNonInteractiveApprovalHandler(autoApprove: boolean): ToolApprovalHandler {
  return async (invocation: PipelineApprovalRequest) => {
    if (invocation.signal.aborted) {
      throw invocation.signal.reason instanceof Error
        ? invocation.signal.reason
        : new DOMException('Approval aborted', 'AbortError')
    }
    const description = `${invocation.tool.name}(${inputPreview(invocation.input)})`
    if (autoApprove) {
      console.log(`  [自动批准: ${description}]`)
      return true
    }

    console.log(`  [拒绝: one-shot 模式需使用 --yes 才能批准 ${invocation.tool.name}]`)
    return false
  }
}

function createConsoleObserver() {
  return {
    onStepStart: ({ step }) => console.log(`\n--- Step ${step} ---`),
    onTextDelta: ({ text }) => process.stdout.write(text),
    onToolCall: ({ toolName, input }) => {
      console.log(`  [调用: ${toolName}(${inputPreview(input)})]`)
    },
    onToolResult: ({ output }) => console.log(`  [结果: ${inputPreview(output)}]`),
    onLoopDetection: ({ detection }) => console.log(`  ${detection.stuck ? detection.message : ''}`),
    onStreamError: ({ error }) => console.error('[stream error]', error),
    onAttemptError: ({ error }) => console.error(error),
    onRetry: ({ attempt, maxRetries, delayMs }) => {
      console.log(`  [重试] 第 ${attempt}/${maxRetries} 次失败，${delayMs}ms 后重试...`)
    },
    onBudget: ({ used, limit }) => {
      const percentage = Math.round((used / limit) * 100)
      console.log(`  [Token] ${used}/${limit} (${percentage}%)`)
    },
    onContinue: () => console.log('  → 继续下一步...'),
    onStop: ({ stopReason }) => {
      const messages: Partial<Record<typeof stopReason, string>> = {
        budget: '\n[Token 预算耗尽，Agent 已停止]',
        loop_detected: '\n[循环检测触发，Agent 已停止]',
        uncertain: '\n[工具结果不确定，Agent 已停止；请先使用 ops resolve 完成对账]',
        max_steps: '\n[达到最大步数限制，Agent 已停止]',
      }
      if (messages[stopReason]) console.log(messages[stopReason])
      else console.log()
    },
  } satisfies AgentLoopObserver
}

function createRunner(deps: CliRuntimeDeps, approveTool: ToolApprovalHandler) {
  return new ConversationRunner({
    model: deps.model,
    registry: deps.registry,
    store: deps.store,
    state: deps.state,
    compaction: deps.compaction,
    maxSteps: deps.maxSteps,
    maxRetries: deps.maxRetries,
    modelRequestTimeoutMs: deps.modelRequestTimeoutMs,
    turnTimeoutMs: deps.turnTimeoutMs,
    approveTool,
    observer: createConsoleObserver(),
    onCompaction: printCompaction,
  })
}

export async function closeRuntime(deps: Pick<CliRuntimeDeps, 'registry' | 'store'>) {
  const errors: unknown[] = []
  try {
    await deps.registry.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    await deps.store.close()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) throw new AggregateError(errors, '部分运行时资源关闭失败')
}

/** Executes one automation-friendly turn and releases all tool resources. */
export async function runOnce(deps: CliRuntimeDeps, prompt: string) {
  const runner = createRunner(deps, createNonInteractiveApprovalHandler(deps.autoApprove))
  const controller = new AbortController()
  let sigintCount = 0
  const onSigint = () => {
    sigintCount++
    if (sigintCount === 1) {
      controller.abort(new DOMException('Turn cancelled by SIGINT', 'AbortError'))
      return
    }
    killActiveProcessGroupsSync()
    process.exit(130)
  }
  process.on('SIGINT', onSigint)
  let turnFailed = false
  let turnError: unknown
  try {
    return await runner.runTurn(prompt, { signal: controller.signal })
  } catch (error) {
    turnFailed = true
    turnError = error
    throw error
  } finally {
    process.removeListener('SIGINT', onSigint)
    try {
      await closeRuntime(deps)
    } catch (closeError) {
      if (turnFailed) {
        throw new AggregateError([turnError, closeError], 'Agent 执行与工具资源关闭均失败')
      }
      throw closeError
    }
  }
}

/** Interactive shell only; turn orchestration lives in ConversationRunner. */
export function startRepl(deps: CliRuntimeDeps) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const runner = createRunner(deps, createInteractiveApprovalHandler(rl, deps.autoApprove))

  let shuttingDown = false
  let sigintCount = 0
  let sigintTimer: NodeJS.Timeout | undefined
  let activeTurn: AbortController | undefined
  let activeTurnPromise: Promise<unknown> | undefined

  async function shutdown(force = false) {
    if (force) {
      activeTurn?.abort(new DOMException('Turn force-cancelled by SIGINT', 'AbortError'))
      killActiveProcessGroupsSync()
      process.exit(130)
    }
    if (shuttingDown) return
    shuttingDown = true
    if (sigintTimer) clearTimeout(sigintTimer)
    activeTurn?.abort(new DOMException('Turn cancelled during shutdown', 'AbortError'))
    try {
      await activeTurnPromise
    } catch {
      // The turn reports its own cancellation/error before shutdown continues.
    }
    console.log('\nBye!')

    try {
      await closeRuntime(deps)
    } catch (error) {
      console.error(`[Shutdown] ${error instanceof Error ? error.message : error}`)
    }
    process.exit(0)
  }

  rl.on('SIGINT', () => {
    if (activeTurn && !activeTurn.signal.aborted) {
      sigintCount = 1
      activeTurn.abort(new DOMException('Turn cancelled by SIGINT', 'AbortError'))
      console.log('\n[正在取消当前 Agent turn；再按一次 Ctrl+C 强制退出]')
      if (sigintTimer) clearTimeout(sigintTimer)
      sigintTimer = setTimeout(() => {
        sigintCount = 0
      }, 1_500)
      return
    }
    if (sigintCount >= 1) void shutdown(true)
    else void shutdown(false)
  })

  rl.on('close', () => void shutdown())

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed) {
        ask()
        return
      }
      if (trimmed === 'exit') {
        void shutdown()
        return
      }

      try {
        const controller = new AbortController()
        activeTurn = controller
        const turn = runner.runTurn(trimmed, { signal: controller.signal })
        activeTurnPromise = turn
        await turn
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          console.log('[Agent turn 已取消]')
        } else {
          console.error(`[Agent 出错] ${error instanceof Error ? error.message : error}`)
        }
      } finally {
        activeTurn = undefined
        activeTurnPromise = undefined
        sigintCount = 0
        if (sigintTimer) {
          clearTimeout(sigintTimer)
          sigintTimer = undefined
        }
      }
      if (!shuttingDown) ask()
    })
  }

  ask()
}
