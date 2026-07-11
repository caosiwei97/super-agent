import type { ToolRegistry } from '../core/tool-registry.js'

const SYSTEM_BASE = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`

/**
 * 每轮重建 SYSTEM：基础提示 + 当前的延迟工具清单。
 *
 * 放在这里每轮调用，是为了让「运行中通过 MCP 动态注册的工具」
 * 也能及时出现在清单里——而不是只在启动时拼一次。
 */
export function buildSystem(registry: ToolRegistry): string {
  return `${SYSTEM_BASE}${registry.getDeferredToolSummary()}`
}
