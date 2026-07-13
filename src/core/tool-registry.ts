import { jsonSchema } from 'ai'
import type { MCPClient } from '../mcp/mcp-client.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  maxResultChars?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any) => Promise<unknown>
  shouldDefer?: boolean
  searchHint?: string
}

const DEFAULT_MAX_RESULT_CHARS = 3000

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private mcpClients: Array<MCPClient> = []

  private exclusiveLock = false
  private concurrentCount = 0
  private waitQueue: Array<() => void> = []

  private discoveredTools = new Set<string>()

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  async registerMCPServer(serverName: string, client: MCPClient): Promise<string[]> {
    await client.connect()
    this.mcpClients.push(client)

    const tools = await client.listTools()
    const registered: string[] = []

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`
      if (this.tools.has(prefixedName)) continue

      const toolClient = client
      const originalName = tool.name

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        // 真实 MCP 工具的读写属性无法确定，保守起见走串行 + 读写标记，
        // 避免把 create_issue 等写工具当只读并发执行。
        isConcurrencySafe: false,
        isReadOnly: false,
        maxResultChars: 3000,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        execute: async (input) => {
          return toolClient.callTool(originalName, input)
        },
      })

      registered.push(prefixedName)
    }

    return registered
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close()
    }
    this.mcpClients = []
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /** 工具是否被延迟加载且尚未被 tool_search 发现。 */
  private isDeferred(tool: ToolDefinition): boolean {
    return !!tool.shouldDefer && !this.discoveredTools.has(tool.name)
  }

  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => !this.isDeferred(tool))
  }

  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => this.isDeferred(tool))

    if (deferred.length === 0) return ''

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : ''
      return `  - ${t.name}${hint}`
    })

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim()
    const results: ToolDefinition[] = []

    // 支持逗号分隔的多个工具名，如 "mcp__github__list_issues,mcp__github__search_repositories"
    const names = q.includes(',')
      ? q
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [q]

    for (const name of names) {
      const tool = this.tools.get(name)
      if (tool && tool.name !== 'tool_search') {
        results.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }

    return results
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0
    let deferred = 0

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length
      const tokens = Math.ceil(schemaSize / 4)

      if (this.isDeferred(tool)) {
        deferred += tokens
      } else {
        active += tokens
      }
    }

    return { active, deferred, total: active + deferred }
  }

  /**
   * 获取并发读锁：等待排他锁释放后，concurrentCount++。
   *
   * 被唤醒后必须重新检查 exclusiveLock——不能假设被唤醒就意味着条件满足，
   * 因为 release 时一次性唤醒了所有等待者，可能多个 concurrent 和 exclusive
   * 同时醒来，exclusive 醒来后拿到锁，concurrent 醒来后应继续等待。
   */
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r))
    }
    this.concurrentCount++
  }

  private releaseConcurrent(): void {
    this.concurrentCount--
    if (this.concurrentCount === 0) this.drainQueue()
  }

  /**
   * 获取独占写锁：等待所有并发读完成 + 无其他排他锁。
   *
   * 同样在唤醒后重新检查条件，避免与 concurrent 竞争。
   */
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r))
    }
    this.exclusiveLock = true
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false
    this.drainQueue()
  }

  /**
   * 唤醒所有等待者。每个等待者在 resolve 后会回到 while 循环重新检查条件，
   * 不满足的会重新入队等待下一次唤醒，从而避免锁竞态。
   */
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0)
    for (const resolve of waiting) resolve()
  }

  toAISDKFormat(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    const activeTools = this.getActiveTools()

    for (const tool of activeTools) {
      const maxChars = tool.maxResultChars
      const executeFn = tool.execute
      const isSafe = tool.isConcurrencySafe === true
      const registry = this

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters),
        execute: async (input: Record<string, unknown>) => {
          if (isSafe) {
            await registry.acquireConcurrent()
          } else {
            await registry.acquireExclusive()
          }
          try {
            const raw = await executeFn(input)
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
            return truncateResult(text, maxChars)
          } finally {
            if (isSafe) {
              registry.releaseConcurrent()
            } else {
              registry.releaseExclusive()
            }
          }
        },
      }
    }
    return result
  }
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const head = text.slice(0, headSize)
  const tail = text.slice(-tailSize)
  const dropped = text.length - headSize - tailSize

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`
}
