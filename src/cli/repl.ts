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
import type { SessionWriter } from '../session/store.js'

export interface CliRuntimeDeps {
  model: LanguageModel
  registry: ToolRegistry
  store: SessionWriter
  state: ConversationState
  compaction: CompactionOptions
  maxSteps: number
  maxRetries: number
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
    onBudget: ({ used, limit }) => {
      const percentage = Math.round((used / limit) * 100)
      console.log(`  [Token] ${used}/${limit} (${percentage}%)`)
    },
    onContinue: () => console.log('  → 继续下一步...'),
    onStop: ({ stopReason }) => {
      const messages: Partial<Record<typeof stopReason, string>> = {
        budget: '\n[Token 预算耗尽，Agent 已停止]',
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
    compaction: deps.compaction,
    maxSteps: deps.maxSteps,
    maxRetries: deps.maxRetries,
    approveTool,
    observer: createConsoleObserver(),
    onCompaction: printCompaction,
  })
}

/** Interactive shell only; turn orchestration lives in ConversationRunner. */
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
