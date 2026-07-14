import { MCPClient } from './mcp-client.js'
import type { ToolRegistry } from '../core/tool-registry.js'

const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'

export interface GitHubMCPOptions {
  token?: string
}

/** Connects to GitHub's hosted Streamable HTTP MCP server. */
export async function connectGitHubMCP(
  registry: ToolRegistry,
  options: GitHubMCPOptions,
) {
  if (!options.token) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，跳过 GitHub MCP')
    return
  }
  console.log('\n连接 GitHub MCP Server（GitHub 托管 HTTP）...')
  try {
    const client = new MCPClient({
      url: GITHUB_MCP_URL,
      headers: { Authorization: `Bearer ${options.token}` },
    })
    const tools = await registry.registerMCPServer('github', client)
    console.log(`  已注册 ${tools.length} 个 GitHub MCP 工具`)
  } catch (error) {
    console.log(`  MCP 连接失败，继续使用本地工具: ${error instanceof Error ? error.message : error}`)
  }
}
