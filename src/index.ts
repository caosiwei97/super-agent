import 'dotenv/config'
import { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { allTools, createToolSearch, simulatedTools } from './tools'
import { ToolRegistry } from './core/tool-registry'
import { connectGitHubMCP } from './mcp/create-mcp'
import { printStartupStats, startRepl } from './cli/repl'
import { SessionStore } from './session/store'

// ---- 1. 装配 registry ----
const registry = new ToolRegistry()
registry.register(...allTools)
registry.register(createToolSearch(registry))

let messages: ModelMessage[] = []

// ---- 2. 启动 ----
async function main() {
  // 2.1 先连真实 MCP（github），失败/无 token 则静默降级
  await connectGitHubMCP(registry)

  // 2.2 再注册演示用的模拟 MCP 工具
  registry.register(...simulatedTools)
  console.log(`  已注册 ${simulatedTools.length} 个模拟 MCP 工具（Notion/Browser/Supabase）`)

  const isContinue = process.argv.includes('--continue')
  const sessionId = 'default'
  const store = new SessionStore(sessionId)

  if (isContinue && store.exists()) {
    messages = store.load()
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`)
  } else {
    console.log(`[Session] 新会话`)
  }

  // 2.3 打印统计
  printStartupStats(registry)

  // 2.4 创建模型客户端 + 预算（跨轮累计）
  const client = createOpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.OPENAI_API_KEY,
  })
  const budget = { used: 0, limit: 1_000_000 }

  // 2.5 进入 REPL —— SYSTEM 在 repl 里每轮按当前 registry 重建
  startRepl({
    model: client.chat('deepseek-v4-flash'),
    registry,
    messages,
    budget,
    store,
  })
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
