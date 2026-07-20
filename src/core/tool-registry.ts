import { jsonSchema, type ToolExecutionOptions, type ToolSet } from 'ai'
import { AsyncReadWriteLock } from './async-rw-lock.js'

export interface MCPToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** 精简接口使工具注册表不依赖 MCP 传输层的具体实现。 */
export interface MCPToolClient {
  connect(): Promise<void>
  listTools(): Promise<MCPToolDescriptor[]>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  requiresApproval?: boolean
  maxResultChars?: number
  // 工具执行前，AI SDK 会依据 `parameters` 校验输入。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any) => Promise<unknown>
  dispose?: () => Promise<void> | void
  shouldDefer?: boolean
  searchHint?: string
}

export interface ToolInvocation {
  tool: ToolDefinition
  input: unknown
  toolCallId: string
}

export interface ToolRuntimeHooks {
  inspectToolCall?: (invocation: ToolInvocation) => boolean | Promise<boolean>
  onExecutionStart?: (invocation: ToolInvocation) => void | Promise<void>
  onToolResult?: (
    invocation: ToolInvocation,
    result: { ok: boolean; output: string },
  ) => void | Promise<void>
}

export interface ToolExecutionResult {
  ok: boolean
  output: string
}

const DEFAULT_MAX_RESULT_CHARS = 3_000

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly mcpClients: MCPToolClient[] = []
  private readonly discoveredTools = new Set<string>()
  private readonly executionLock = new AsyncReadWriteLock()
  private closePromise: Promise<void> | undefined
  private closed = false

  register(...tools: ToolDefinition[]) {
    if (this.closed) throw new Error('ToolRegistry 已关闭，不能继续注册工具')
    const incomingNames = new Set<string>()
    for (const tool of tools) {
      if (this.tools.has(tool.name) || incomingNames.has(tool.name)) {
        throw new Error(`工具重复注册: ${tool.name}`)
      }
      incomingNames.add(tool.name)
    }
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  async registerMCPServer(serverName: string, client: MCPToolClient) {
    if (this.closed) throw new Error('ToolRegistry 已关闭，不能连接 MCP Server')

    try {
      await client.connect()
      const tools = await client.listTools()
      const definitions: ToolDefinition[] = []

      for (const tool of tools) {
        const prefixedName = `mcp__${serverName}__${tool.name}`
        if (this.tools.has(prefixedName)) continue

        const originalName = tool.name
        definitions.push({
          name: prefixedName,
          description: `[MCP:${serverName}] ${tool.description}`,
          parameters: tool.inputSchema,
          // MCP 参数结构没有提供可信的读写元数据，因此默认串行执行并要求明确审批。
          isConcurrencySafe: false,
          isReadOnly: false,
          requiresApproval: true,
          maxResultChars: 3_000,
          shouldDefer: true,
          searchHint: `${serverName} ${tool.name} ${tool.description}`,
          execute: (input) => client.callTool(originalName, input),
        })
      }

      this.register(...definitions)
      this.mcpClients.push(client)
      return definitions.map((tool) => tool.name)
    } catch (error) {
      try {
        await client.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], `MCP Server ${serverName} 注册及回滚均失败`)
      }
      throw error
    }
  }

  get(name: string) {
    return this.tools.get(name)
  }

  getAll() {
    return Array.from(this.tools.values())
  }

  getActiveTools() {
    return this.getAll().filter((tool) => !this.isDeferred(tool))
  }

  getDeferredToolSummary() {
    const deferred = this.getAll().filter((tool) => this.isDeferred(tool))
    if (deferred.length === 0) return ''

    const lines = deferred.map((tool) => {
      const hint = tool.searchHint ? ` — ${tool.searchHint}` : ''
      return `  - ${tool.name}${hint}`
    })
    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  searchTools(query: string) {
    const names = query.includes(',')
      ? query.split(',').map((name) => name.trim()).filter(Boolean)
      : [query.trim()]
    const results: ToolDefinition[] = []

    for (const name of names) {
      const tool = this.tools.get(name)
      if (!tool || tool.name === 'tool_search') continue
      results.push(tool)
      this.discoveredTools.add(tool.name)
    }
    return results
  }

  countTokenEstimate() {
    let active = 0
    let deferred = 0

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length
      const tokens = Math.ceil(schemaSize / 4)
      if (this.isDeferred(tool)) deferred += tokens
      else active += tokens
    }
    return { active, deferred, total: active + deferred }
  }

  toAISDKFormat(hooks: ToolRuntimeHooks = {}) {
    const result: Record<string, unknown> = {}

    for (const tool of this.getActiveTools()) {
      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters),
        needsApproval: async (input: unknown, options: ToolExecutionOptions) => {
          const invocation = { tool, input, toolCallId: options.toolCallId }
          const forcedApproval = await hooks.inspectToolCall?.(invocation)
          return forcedApproval === true || tool.requiresApproval === true || tool.isReadOnly !== true
        },
        execute: async (input: unknown, options: ToolExecutionOptions) => {
          const execution = await this.executeTool(tool.name, input, options.toolCallId, hooks)
          if (!execution.ok) throw new Error(execution.output)
          return execution.output
        },
      }
    }

    return result as ToolSet
  }

  async executeTool(
    toolName: string,
    input: unknown,
    toolCallId: string,
    hooks: ToolRuntimeHooks = {},
  ) {
    if (this.closed) return { ok: false, output: 'ToolRegistry 已关闭' }
    const tool = this.tools.get(toolName)
    if (!tool) return { ok: false, output: `工具不存在: ${toolName}` }

    const release = tool.isConcurrencySafe
      ? await this.executionLock.acquireRead()
      : await this.executionLock.acquireWrite()
    const invocation = { tool, input, toolCallId }

    try {
      let execution: ToolExecutionResult
      try {
        await hooks.onExecutionStart?.(invocation)
        const raw = await tool.execute(input)
        const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2) ?? String(raw)
        execution = { ok: true, output: truncateResult(serialized, tool.maxResultChars) }
      } catch (error) {
        execution = { ok: false, output: error instanceof Error ? error.message : String(error) }
      }

      // 结果观察器只运行一次。钩子失败会有意向上抛出，
      // 静默忽略会导致循环检测与实际执行状态不同步。
      await hooks.onToolResult?.(invocation, execution)
      return execution
    } finally {
      release()
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = this.closeResources()
    return this.closePromise
  }

  private async closeResources() {
    const release = await this.executionLock.acquireWrite()
    try {
      const disposers = this.getAll().flatMap((tool) => (tool.dispose ? [tool.dispose] : []))
      const operations = [
        ...disposers.map((dispose) => Promise.resolve().then(dispose)),
        ...this.mcpClients.map((client) => client.close()),
      ]
      this.mcpClients.length = 0

      const results = await Promise.allSettled(operations)
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, '部分工具资源关闭失败')
    } finally {
      release()
    }
  }

  private isDeferred(tool: ToolDefinition) {
    return tool.shouldDefer === true && !this.discoveredTools.has(tool.name)
  }
}

export function truncateResult(text: string, maxChars = DEFAULT_MAX_RESULT_CHARS) {
  if (text.length <= maxChars) return text

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const dropped = text.length - headSize - tailSize
  return `${text.slice(0, headSize)}\n\n... [省略 ${dropped} 字符] ...\n\n${text.slice(-tailSize)}`
}
