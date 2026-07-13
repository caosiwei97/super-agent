import { createInterface } from 'node:readline'
import type { ModelMessage, LanguageModel } from 'ai'
import { agentLoop, type BudgetState } from '../agent/agent-loop.js'
import { ToolRegistry } from '../core/tool-registry.js'
import { buildSystem } from '../context/prompt-builder.js'
import { SessionStore } from '../session/store.js'

export interface ReplDeps {
  model: LanguageModel
  registry: ToolRegistry
  messages: ModelMessage[]
  budget: BudgetState
  store: SessionStore
}

/** 启动时打印工具统计（从旧 main 里抽出来，保持输出一致）。 */
export function printStartupStats(registry: ToolRegistry): void {
  const allTools = registry.getAll()
  const activeTools = registry.getActiveTools()
  const estimate = registry.countTokenEstimate()

  console.log(`已注册 ${allTools.length} 个工具：`)
  for (const tool of allTools) {
    const flags = [tool.isConcurrencySafe ? '可并发' : '串行', tool.isReadOnly ? '只读' : '读写'].join(', ')
    console.log(`  - ${tool.name}（${flags}）`)
  }

  console.log(`\n=== 工具统计 ===`)
  console.log(`  全部工具: ${allTools.length} 个`)
  console.log(`  活跃工具: ${activeTools.length} 个`)
  console.log(`  延迟工具: ${allTools.length - activeTools.length} 个`)
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
export function startRepl({ model, registry, messages, budget, store }: ReplDeps): void {
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
      const userMsg: ModelMessage = { role: 'user', content: trimmed }

      messages.push(userMsg)
      await store.append(userMsg)
      const beforeLen = messages.length

      try {
        await agentLoop(model, registry, messages, buildSystem(registry, messages, store), budget)
      } catch (err) {
        console.error(`[Agent 出错] ${err instanceof Error ? err.message : err}`)
      }
      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen)
      await store.appendAll(newMessages)

      ask()
    })
  }

  ask()
}
