import { ModelMessage } from 'ai'
import type { ToolRegistry } from '../core/tool-registry.js'
import { SessionStore } from '../session/store.js'

/**
 * 每轮重建 SYSTEM：基础提示 + 当前的延迟工具清单。
 *
 * 放在这里每轮调用，是为了让「运行中通过 MCP 动态注册的工具」
 * 也能及时出现在清单里——而不是只在启动时拼一次。
 */
export function buildSystem(registry: ToolRegistry, messages: ModelMessage[], store: SessionStore): string {
  // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext())

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId: store.getSessionId(),
  }

  // Debug: 显示 Prompt Pipe 各模块状态（需设置 PROMPT_DEBUG=1 才开启，避免正常运行时的噪音）
  builder.debug(promptCtx)

  return builder.build(promptCtx)
}

export interface PromptContext {
  toolCount: number
  deferredToolSummary: string
  sessionMessageCount: number
  sessionId: string
}

type PipeFn = (ctx: PromptContext) => string | null

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = []

  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn })
    return this
  }

  /**
   * 构建最终的 system prompt。
   *
   * 如果 PROMPT_DEBUG=1，同时打印各 pipe 的状态（开关 + 字符数），
   * 避免正常使用时的噪音输出。
   */
  build(ctx: PromptContext): string {
    const sections: Array<{ name: string; content: string | null }> = []

    for (const { name, fn } of this.pipes) {
      const result = fn(ctx)
      sections.push({ name, content: result })
    }

    if (process.env.PROMPT_DEBUG === '1') {
      console.log('\n=== Prompt Pipe Debug ===')
      for (const { name, content } of sections) {
        const status = content !== null ? `[ON] ${content.length} chars` : '[OFF]'
        console.log(`  ${name}: ${status}`)
      }
      console.log('========================\n')
    }

    return sections
      .filter((s) => s.content !== null)
      .map((s) => s.content!)
      .join('\n\n')
  }

  /** @deprecated 使用 build() 并设置 PROMPT_DEBUG=1 环境变量 */
  debug(ctx: PromptContext): void {
    // 保留方法签名以兼容外部调用，实际调试输出已合并到 build() 中
  }
}

// ── 预定义的 Pipe ────────────────────────────────

export function coreRules(): PipeFn {
  return () => `你是 Super Agent，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`
}

export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null
    return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`
  }
}

export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null
    return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`
  }
}

export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null
    return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`
  }
}
