import { MCPClient } from './mcp-client.js'
import type { ToolRegistry } from '../core/tool-registry.js'

/**
 * 连接 GitHub MCP Server 并把它的工具注册进 registry。
 *
 * 需要环境变量 GITHUB_PERSONAL_ACCESS_TOKEN 且当前环境能 spawn 子进程；
 * 任意一项不满足都会静默降级（不连），不影响 agent 其余功能。
 * 连接失败也只降级、不抛错——MCP 是增强项而非必需项。
 */
export async function connectGitHubMCP(registry: ToolRegistry): Promise<void> {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN

  let canSpawn = true
  try {
    const { execSync } = await import('node:child_process')
    execSync('echo test', { stdio: 'ignore' })
  } catch {
    canSpawn = false
  }

  if (githubToken && canSpawn) {
    console.log('\n连接 GitHub MCP Server...')
    try {
      const client = new MCPClient('npx', ['-y', '@modelcontextprotocol/server-github'], {
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      })
      const tools = await registry.registerMCPServer('github', client)
      console.log(`  已注册 ${tools.length} 个 MCP 工具`)
      return
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`)
      console.log('  降级为 Mock MCP...')
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP')
  }
}
