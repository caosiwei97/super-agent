import type { ToolDefinition } from '../core/tool-registry.js'

/**
 * 模拟的 MCP 工具集合（Notion / Browser / Supabase）。
 *
 * 仅用于演示「工具膨胀 → 延迟加载」机制：它们都带 shouldDefer: true，
 * 不会出现在每轮 prompt 的活跃工具列表里，需要先经 tool_search 按名取定义后才会激活。
 * 真正的 MCP 工具通过 MCPClient 在运行时拉起，不走这里。
 */
export const simulatedTools: ToolDefinition[] = [
  // ---- Notion MCP 模拟 ----
  {
    name: 'mcp__notion__search_pages',
    description: '[MCP:notion] 搜索 Notion 页面',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    shouldDefer: true,
    searchHint: 'notion search pages documents',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query }: any) => JSON.stringify([{ title: `Mock: ${query}`, id: 'page-001' }]),
  },
  {
    name: 'mcp__notion__create_page',
    description: '[MCP:notion] 创建 Notion 页面',
    parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title'] },
    shouldDefer: true,
    searchHint: 'notion create page document write',
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ title }: any) => `已创建页面: ${title}`,
  },
  {
    name: 'mcp__notion__list_databases',
    description: '[MCP:notion] 列出 Notion 数据库',
    parameters: { type: 'object', properties: {}, required: [] },
    shouldDefer: true,
    searchHint: 'notion list databases tables',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async () =>
      JSON.stringify([
        { title: '项目追踪', id: 'db-001' },
        { title: '知识库', id: 'db-002' },
      ]),
  },

  // ---- Playwright MCP 模拟 ----
  {
    name: 'mcp__browser__navigate',
    description: '[MCP:browser] 导航到指定 URL',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    shouldDefer: true,
    searchHint: 'browser navigate open url webpage',
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ url }: any) => `已导航到 ${url}`,
  },
  {
    name: 'mcp__browser__screenshot',
    description: '[MCP:browser] 对当前页面截图',
    parameters: { type: 'object', properties: {}, required: [] },
    shouldDefer: true,
    searchHint: 'browser screenshot capture page',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async () => '[screenshot data]',
  },
  {
    name: 'mcp__browser__click',
    description: '[MCP:browser] 点击页面元素',
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
    shouldDefer: true,
    searchHint: 'browser click element button',
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ selector }: any) => `已点击 ${selector}`,
  },
  {
    name: 'mcp__browser__fill',
    description: '[MCP:browser] 在输入框中填写内容',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string' }, value: { type: 'string' } },
      required: ['selector', 'value'],
    },
    shouldDefer: true,
    searchHint: 'browser fill input form text',
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ selector, value }: any) => `已在 ${selector} 填写 ${value}`,
  },
  {
    name: 'mcp__browser__get_text',
    description: '[MCP:browser] 获取页面文本内容',
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
    shouldDefer: true,
    searchHint: 'browser get text content extract',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ selector }: any) => `Mock text content of ${selector}`,
  },

  // ---- Supabase MCP 模拟 ----
  {
    name: 'mcp__supabase__query',
    description: '[MCP:supabase] 执行 SQL 查询',
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    shouldDefer: true,
    searchHint: 'database sql query select',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ sql }: any) => JSON.stringify([{ id: 1, name: 'mock_row', sql }]),
  },
  {
    name: 'mcp__supabase__list_tables',
    description: '[MCP:supabase] 列出数据库所有表',
    parameters: { type: 'object', properties: {}, required: [] },
    shouldDefer: true,
    searchHint: 'database list tables schema',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async () => JSON.stringify(['users', 'orders', 'products']),
  },
  {
    name: 'mcp__supabase__describe_table',
    description: '[MCP:supabase] 查看表结构',
    parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    shouldDefer: true,
    searchHint: 'database describe table columns schema',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ table }: any) =>
      JSON.stringify({
        table,
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'name', type: 'text' },
        ],
      }),
  },
]
