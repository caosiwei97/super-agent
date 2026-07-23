import { createInterface, type Interface } from 'node:readline'
import type { LanguageModel } from 'ai'
import {
  ConversationRunner,
  type CompactionPhase,
  type ConversationState,
} from '../agent/conversation-runner.js'
import type { AgentLoopObserver, ToolApprovalHandler } from '../agent/agent-loop.js'
import type { ToolInvocation, ToolRegistry } from '../core/tool-registry.js'
import type { CompactionOptions, ContextCompactionResult } from '../context/compressor.js'
import { renderContextMatrix } from '../context/view.js'
import type { SessionWriter } from '../session/store.js'
import {
  UsageTracker,
  type StepRecord,
  type UsageTotals,
} from '../usage/tracker.js'

export interface CliRuntimeDeps {
  model: LanguageModel
  registry: ToolRegistry
  store: SessionWriter
  state: ConversationState
  usageTracker: UsageTracker
  compaction?: Partial<CompactionOptions>
}

function formatTokens(tokens: number) {
  return new Intl.NumberFormat('en-US').format(tokens)
}

function formatDollars(cost: number) {
  if (cost === 0) return '$0.000000'
  if (cost < 0.0001) return `$${cost.toFixed(8)}`
  return `$${cost.toFixed(6)}`
}

function progressBar(ratio: number, width = 30) {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export function renderUsageSummary(tracker: UsageTracker) {
  const totals: UsageTotals = tracker.totals()
  const hitPercentage = totals.cacheHitRate * 100
  const savedPercentage = totals.baselineCost === 0
    ? 0
    : (totals.savedCost / totals.baselineCost) * 100
  const unpricedModels = Array.from(new Set(
    tracker.records()
      .filter((record) => record.cost === undefined)
      .map((record) => record.model),
  ))
  const partial = totals.unpricedSteps > 0
    ? `（仅含 ${totals.pricedSteps}/${totals.steps} 个已定价 step）`
    : ''

  return [
    'Usage Summary',
    `${totals.steps} steps`,
    '',
    `◎ Input        ${formatTokens(totals.inputTokens)} tokens`,
    `◈ Cache write  ${formatTokens(totals.cacheWriteTokens)} tokens`,
    `◉ Cache read   ${formatTokens(totals.cacheReadTokens)} tokens (${hitPercentage.toFixed(1)}% hit)`,
    `◇ Output       ${formatTokens(totals.outputTokens)} tokens`,
    '',
    `Cache hit rate ${progressBar(totals.cacheHitRate)} ${hitPercentage.toFixed(1)}%`,
    '',
    `Estimated cost ${formatDollars(totals.cost)} ${partial}`.trimEnd(),
    `Without cache  ${formatDollars(totals.baselineCost)} ${partial}`.trimEnd(),
    `Estimated saved ${formatDollars(totals.savedCost)} (${savedPercentage.toFixed(1)}% off)`,
    ...(unpricedModels.length > 0
      ? ['', `价格未知: ${unpricedModels.join(', ')}；这些 step 只统计 token，不计入金额。`]
      : []),
  ].join('\n')
}

function printCompaction(phase: CompactionPhase, result: ContextCompactionResult) {
  if (result.error) console.warn(`[Compaction] LLM 摘要失败: ${result.error}`)
  if (
    result.truncated === 0 &&
    result.compacted === 0 &&
    result.softPruned === 0 &&
    result.hardPruned === 0 &&
    result.cleared === 0 &&
    result.compressedCount === 0
  ) return

  const phaseLabel: Record<CompactionPhase, string> = {
    'before-turn': '发送前',
    'between-steps': 'Step 间',
    'after-turn': 'Agent Loop 后',
  }
  const actions: string[] = []
  if (result.truncated > 0) actions.push(`截断 ${result.truncated} 个超长工具结果`)
  if (result.compacted > 0) actions.push(`预算清理 ${result.compacted} 个工具结果`)
  if (result.softPruned > 0) actions.push(`软修剪 ${result.softPruned} 个过期结果`)
  if (result.hardPruned > 0) actions.push(`硬清除 ${result.hardPruned} 个过期结果`)
  if (result.cleared > 0) actions.push(`清理 ${result.cleared} 个旧工具结果`)
  if (result.compressedCount > 0) actions.push(`摘要 ${result.compressedCount} 条消息`)
  const saved = Math.max(0, result.beforeTokens - result.afterTokens)

  console.log(
    `[Context:${phaseLabel[phase]}] ${actions.join('，')}，` +
      `~${result.beforeTokens} → ~${result.afterTokens} tokens` +
      (saved > 0 ? `（节省 ~${saved}）` : ''),
  )
}

function inputPreview(input: unknown) {
  const serialized = JSON.stringify(input)
  if (!serialized) return String(input)
  return serialized.length > 500 ? `${serialized.slice(0, 500)}…` : serialized
}

function createInteractiveApprovalHandler(rl: Interface) {
  return async (invocation: ToolInvocation) => {
    const description = `${invocation.tool.name}(${inputPreview(invocation.input)})`
    if (!process.stdin.isTTY) {
      console.log(`  [拒绝: 非交互环境无法审批 ${invocation.tool.name}]`)
      return false
    }

    return new Promise<boolean>((resolve) => {
      rl.question(`\n批准执行 ${description}？[y/N] `, (answer) => {
        resolve(['y', 'yes'].includes(answer.trim().toLowerCase()))
      })
    })
  }
}

function createConsoleObserver() {
  return {
    onStepStart: ({ step }) => console.log(`\n--- Step ${step} ---`),
    onTextDelta: ({ text }) => process.stdout.write(text),
    onToolCall: ({ toolName, input }) => {
      console.log(`  [调用: ${toolName}(${JSON.stringify(input)})]`)
    },
    onToolResult: ({ output }) => console.log(`  [结果: ${JSON.stringify(output)}]`),
    onLoopDetection: ({ detection }) => console.log(`  ${detection.stuck ? detection.message : ''}`),
    onStreamError: ({ error }) => console.error('[stream error]', error),
    onAttemptError: ({ error }) => console.error(error),
    onRetry: ({ attempt, maxRetries, delayMs }) => {
      console.log(`  [重试] 第 ${attempt}/${maxRetries} 次失败，${delayMs}ms 后重试...`)
    },
    onTokenCost: ({ used, limit }) => {
      const percentage = Math.round((used / limit) * 100)
      console.log(`  [Token] ${used}/${limit} (${percentage}%)`)
    },
    onUsage: ({ record }: { record: StepRecord }) => {
      if (record.cacheReadTokens === 0) return
      const cost = record.cost === undefined ? '' : ` · ${formatDollars(record.cost)}`
      console.log(`  [Cache hit] read ${formatTokens(record.cacheReadTokens)} tokens${cost}`)
    },
    onContinue: () => console.log('  → 继续下一步...'),
    onStop: ({ stopReason }) => {
      const messages: Partial<Record<typeof stopReason, string>> = {
        cost_exhausted: '\n[Token 成本预算耗尽，Agent 已停止]',
        loop_detected: '\n[循环检测触发，Agent 已停止]',
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
    usageTracker: deps.usageTracker,
    compaction: deps.compaction,
    approveTool,
    observer: createConsoleObserver(),
    onCompaction: printCompaction,
  })
}

/** 这里只负责交互式终端；单轮对话编排由 ConversationRunner 负责。 */
export function startRepl(deps: CliRuntimeDeps) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const runner = createRunner(deps, createInteractiveApprovalHandler(rl))

  let shuttingDown = false
  let sigintCount = 0
  let sigintTimer: NodeJS.Timeout | undefined

  async function shutdown(force = false) {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\nBye!')

    if (!force) {
      try {
        await deps.registry.close()
      } catch (error) {
        console.error(`[Shutdown] ${error instanceof Error ? error.message : error}`)
      }
    }
    process.exit(0)
  }

  rl.on('SIGINT', () => {
    sigintCount++
    if (sigintCount >= 2) {
      if (sigintTimer) clearTimeout(sigintTimer)
      void shutdown(true)
      return
    }
    console.log('\n(再按一次 Ctrl+C 强制退出)')
    if (sigintTimer) clearTimeout(sigintTimer)
    sigintTimer = setTimeout(() => {
      sigintCount = 0
    }, 1_500)
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
      if (trimmed === '/usage') {
        console.log(`\n${renderUsageSummary(runner.usage)}`)
        ask()
        return
      }
      if (trimmed === '/context') {
        console.log(`\n${renderContextMatrix(runner.getContextSnapshot())}`)
        ask()
        return
      }
      if (trimmed === '/help') {
        console.log('\n命令: /context 查看上下文，/usage 查看成本，/help 查看帮助，exit 退出')
        ask()
        return
      }
      if (trimmed.startsWith('/')) {
        console.log(`[未知命令] ${trimmed}；输入 /help 查看可用命令`)
        ask()
        return
      }

      try {
        await runner.runTurn(trimmed)
      } catch (error) {
        console.error(`[Agent 出错] ${error instanceof Error ? error.message : error}`)
      }
      ask()
    })
  }

  ask()
}
