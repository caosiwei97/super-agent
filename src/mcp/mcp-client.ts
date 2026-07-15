import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolExecutionContext } from '../core/tool-registry.js'
import type { ExecutionConstraints } from '../security/capabilities.js'

export interface MCPClientOptions {
  url: string
  headers?: Record<string, string>
  /** Test/integration injection; every implementation is still wrapped by the redirect guard. */
  fetch?: typeof globalThis.fetch
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** Fail closed unless the immutable policy snapshot authorizes this MCP origin exactly. */
export function assertMcpEndpointConstraints(
  endpointOrigin: string,
  constraints: ExecutionConstraints | undefined,
) {
  const endpoint = new URL(endpointOrigin)
  const scheme = endpoint.protocol.slice(0, -1)
  const host = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = endpoint.port ? Number(endpoint.port) : scheme === 'https' ? 443 : 80
  if (!constraints?.networkSchemes
    || !constraints.networkHosts
    || !constraints.networkPorts
    || !constraints.networkSchemes.includes(scheme)
    || !constraints.networkHosts.includes(host)
    || !constraints.networkPorts.includes(port)) {
    throw new Error(`MCP endpoint 超出已授权网络约束: ${scheme}://${host}:${port}`)
  }
}

/**
 * The MCP SDK uses this fetch for connect, SSE, listTools and callTool traffic.
 * Manual mode plus rejecting every 3xx keeps the configured endpoint origin as
 * the only network authority; callers cannot override redirect behavior.
 */
export function createMCPGuardedFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      try {
        await response.body?.cancel()
      } catch {
        // The redirect denial is authoritative even if response cleanup fails.
      }
      throw new Error(`MCP transport 拒绝 HTTP redirect: ${response.status}`)
    }
    return response
  }
}

/** Hosted Streamable HTTP MCP client backed by the official SDK. */
export class MCPClient {
  private client: Client | null = null
  readonly endpointOrigin: string

  constructor(private readonly options: MCPClientOptions) {
    this.endpointOrigin = new URL(options.url).origin
  }

  async connect() {
    const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
      requestInit: { headers: this.options.headers, redirect: 'manual' },
      fetch: createMCPGuardedFetch(this.options.fetch),
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

  async callTool(name: string, args: Record<string, unknown>, context: ToolExecutionContext) {
    assertMcpEndpointConstraints(this.endpointOrigin, context.constraints)
    if (!this.client) throw new Error('MCP client 未连接')
    // SDK 返回类型里的 content 是更严格的联合类型，这里统一按文本块抽取，做一次结构断言即可。
    const result = (await this.client.callTool(
      { name, arguments: args },
      undefined,
      {
        signal: context.signal,
        timeout: Math.max(1, context.deadline - Date.now()),
      },
    )) as MCPCallResult
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
