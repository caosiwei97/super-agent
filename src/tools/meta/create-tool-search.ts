import type { ToolDefinition, ToolRegistry } from '../../core/tool-registry.js'

/**
 * 构造 tool_search 元工具。
 *
 * 它的作用是「按名取延迟工具的完整 schema」——
 * 模型先从 SYSTEM 提示里的延迟工具清单读出工具名，
 * 再用这个工具把名字换成带完整 parameters 的定义，
 * registry 同时把该工具标记为「已发现」，下一轮它就会出现在 activeTools 中。
 */
export function createToolSearch(registry: ToolRegistry): ToolDefinition {
  return {
    name: 'tool_search',
    description:
      '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query }: { query: string }) => {
      const results = registry.searchTools(query)
      if (results.length === 0) {
        return `没有找到匹配 "${query}" 的工具`
      }
      return results.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))
    },
  }
}
