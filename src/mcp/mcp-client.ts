import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/**
 * MCP 客户端：基于官方 @modelcontextprotocol/sdk 实现。
 *
 * 对外保持原有的最小接口契约（connect / listTools / callTool / close），
 * 让 tool-registry 与 index.ts 无需任何改动即可复用。
 */
export class MCPClient {
  private client: Client | null = null
  private serverName: string

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    this.serverName = args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server'
  }

  async connect(): Promise<void> {
    // 用 stdio 传输拉起 MCP Server 子进程；协议握手由 SDK 自动完成。
    // env 默认会继承父进程的安全环境变量，再覆盖以传入的 env（如 token）。
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      // process.env 的值是 string | undefined，过滤掉 undefined 以满足 SDK 的 Record<string,string>。
      env: Object.fromEntries(Object.entries({ ...process.env, ...this.env }).filter(([, v]) => v !== undefined)) as Record<string, string>,
      // 默认 inherit 会让 server 的 stderr 直接打到主控制台，这里改为忽略，
      // 避免下载进度 / npm 警告污染 agent 输出。
      stderr: 'ignore',
    })

    this.client = new Client(
      { name: 'super-agent', version: '0.5.0' },
      // capabilities 留空；请求超时沿用之前的 15s。
      { capabilities: {} },
    )

    // SDK 内部会完成 initialize ↔ initialized 握手。
    await this.client.connect(transport)
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.client) throw new Error('MCP client 未连接')
    const { tools } = await this.client.listTools()
    // SDK 返回的 Tool 形状与本模块原先约定的 MCPTool 一致，做一次显式映射便于阅读。
    return (tools || []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error('MCP client 未连接')
    // SDK 返回类型里的 content 是更严格的联合类型，这里统一按文本块抽取，做一次结构断言即可。
    const result = (await this.client.callTool({ name, arguments: args })) as MCPCallResult
    if (result.isError) {
      throw new Error(`MCP 工具调用失败: ${name}`)
    }
    // 维持原契约：只抽取文本内容，用换行拼接成纯文本字符串。
    const texts = (result.content || []).filter((c) => c.type === 'text' && c.text).map((c) => c.text!)
    return texts.join('\n') || '(无返回内容)'
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close()
      this.client = null
    }
  }

  /** 暴露 server 名，便于日志与调试（index.ts 目前未用，保留备用）。 */
  get name(): string {
    return this.serverName
  }
}
