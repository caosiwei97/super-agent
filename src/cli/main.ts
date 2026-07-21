import { createOpenAI } from '@ai-sdk/openai'
import { ToolRegistry } from '../core/tool-registry.js'
import { Workspace } from '../core/workspace.js'
import { loadConfig } from '../core/config.js'
import { createBuiltinTools, createToolSearch } from '../tools/index.js'
import { connectGitHubMCP } from '../mcp/create-mcp.js'
import { startRepl } from './repl.js'
import { SessionStore } from '../session/store.js'

const SESSION_ID = 'default'

/** 命令行应用入口。进程级错误处理由可执行程序的外层入口负责。 */
export async function runCli(args: string[] = []) {
  const unexpectedArgs = args.filter((arg) => arg !== '--')
  if (unexpectedArgs.length > 0) {
    throw new Error('无需子命令或参数，直接运行 ti 即可')
  }

  const config = loadConfig()
  const workspace = new Workspace(config.workspaceRoot)
  const registry = new ToolRegistry()

  try {
    registry.register(...createBuiltinTools({ workspace }))
    registry.register(createToolSearch(registry))
    await connectGitHubMCP(registry, config.githubMcp)

    const store = new SessionStore(SESSION_ID)
    const resumed = store.exists()
    const loaded = await store.loadState()
    if (!resumed) await store.appendCheckpoint(loaded)
    console.log(
      resumed
        ? `[Session] 已恢复，工作上下文 ${loaded.messages.length} 条消息`
        : '[Session] 已创建',
    )
    if (!config.model.apiKey) console.warn('[Config] 未配置 OPENAI_API_KEY，模型调用将失败')

    const client = createOpenAI({
      baseURL: config.model.baseURL,
      apiKey: config.model.apiKey,
    })
    const runtime = {
      model: client.chat(config.model.modelId),
      registry,
      store,
      state: {
        messages: loaded.messages,
        summary: loaded.summary,
        budget: { used: loaded.budgetUsed, limit: config.agent.budgetLimit },
      },
    }

    startRepl(runtime)
  } catch (error) {
    try {
      await registry.close()
    } catch {
      // 保留应用错误作为主要失败原因。
    }
    throw error
  }
}
