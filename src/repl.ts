import { createInterface } from 'node:readline'
import type { ModelMessage } from 'ai'
import { agentLoop, BudgetState } from './core/agent-loop.js'
import { ToolRegistry } from './core/tool-registry.js'

const SYSTEM_BASE = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`

export interface ReplDeps {
  model: any
  registry: ToolRegistry
  messages: ModelMessage[]
  budget: BudgetState
}

/** 启动时打印工具统计（从旧 main 里抽出来，保持输出一致）。 */
export function printStartupStats(registry: ToolRegistry): void {
  console.log(`已注册 ${registry.getAll().length} 个工具：`)
  for (const tool of registry.getAll()) {
    const flags = [tool.isConcurrencySafe ? '可并发' : '串行', tool.isReadOnly ? '只读' : '读写'].join(', ')
    console.log(`  - ${tool.name}（${flags}）`)
  }

  const allCount = registry.getAll().length
  const activeTools = registry.getActiveTools()
  const estimate = registry.countTokenEstimate()

  console.log(`\n=== 工具统计 ===`)
  console.log(`  全部工具: ${allCount} 个`)
  console.log(`  活跃工具: ${activeTools.length} 个`)
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`)
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`)
}

/**
 * 启动交互式 REPL。
 *
 * 退出（核心修复）：
 *   - 输入 exit / 空行 → 关闭
 *   - Ctrl+D（EOF）→ readline 触发 'close' 事件
 *   - Ctrl+C → 'SIGINT'，连按两次则强制退出
 * 三路统一收敛到 shutdown()：先 await closeAllMCP 清掉子进程句柄，再 process.exit(0)。
 * 否则 MCP 子进程 / 预览 server 等句柄会让进程在 rl.close() 之后仍挂住。
 */
export function startRepl({ model, registry, messages, budget }: ReplDeps): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  let shuttingDown = false
  let sigintCount = 0
  let sigintTimer: NodeJS.Timeout | null = null

  async function shutdown(force = false): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true

    console.log('\nBye!')

    if (!force) {
      try {
        await registry.closeAllMCP()
      } catch {
        // 清理失败也不阻塞退出
      }
    }
    process.exit(0)
  }

  // Ctrl+C：第一次提醒「再按一次强制退出」，1.5s 内第二次直接 force 退出。
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
    }, 1500)
  })

  // Ctrl+D / stdin 关闭：直接走清理。
  rl.on('close', () => {
    void shutdown()
  })

  function ask(): void {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === 'exit') {
        void shutdown()
        return
      }

      messages.push({ role: 'user', content: trimmed })

      try {
        await agentLoop(model, registry, messages, buildSystem(registry), budget)
      } catch (err) {
        console.log(`[Agent 出错] ${err instanceof Error ? err.message : err}`)
      }

      ask()
    })
  }

  ask()
}

/**
 * 每轮重建 SYSTEM：基础提示 + 当前的延迟工具清单。
 *
 * 放在这里每轮调用，是为了让「运行中通过 MCP 动态注册的工具」
 * 也能及时出现在清单里——而不是只在启动时拼一次。
 */
export function buildSystem(registry: ToolRegistry): string {
  return `${SYSTEM_BASE}${registry.getDeferredToolSummary()}`
}
