import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface MCPClientOptions {
  url: string
  headers?: Record<string, string>
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** Hosted Streamable HTTP MCP client backed by the official SDK. */
export class MCPClient {
  private client: Client | null = null

  constructor(private readonly options: MCPClientOptions) {}

  async connect() {
    const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
      requestInit: { headers: this.options.headers },
    })

    // 先用临时变量持有 client，connect 成功后再赋给 this.client。
    // 这样 connect 抛错时 this.client 保持 null，不会出现"已赋值但未连上"的中间状态。
    const client = new Client(
      { name: 'super-agent', version: '1.0.0' },
      { capabilities: {} },
    )

    // SDK 内部会完成 initialize ↔ initialized 握手。失败时主动关闭
    // 临时 client，避免未进入 registry 生命周期的子进程残留。
    try {
      await client.connect(transport)
      this.client = client
    } catch (error) {
      try {
        await client.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'MCP 连接及回滚均失败')
      }
      throw error
    }
  }

  async listTools() {
    if (!this.client) throw new Error('MCP client 未连接')
    const { tools } = await this.client.listTools()
    // SDK 返回的 Tool 形状与本模块原先约定的 MCPTool 一致，做一次显式映射便于阅读。
    return (tools || []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }))
  }

  async callTool(name: string, args: Record<string, unknown>) {
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

  async close() {
    if (this.client) {
      await this.client.close()
      this.client = null
    }
  }

}
