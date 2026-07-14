import { createOpenAI } from '@ai-sdk/openai'
import { ToolRegistry } from '../core/tool-registry.js'
import { Workspace } from '../core/workspace.js'
import { loadConfig } from '../core/config.js'
import { createBuiltinTools, createToolSearch } from '../tools/index.js'
import { connectGitHubMCP } from '../mcp/create-mcp.js'
import { printStartupStats, runOnce, startRepl } from './repl.js'
import { cliUsage, parseCliOptions } from './args.js'
import { SessionStore } from '../session/store.js'

/** CLI application entry. Process-level error handling belongs to the executable shim. */
export async function runCli(args: string[]) {
  const cli = parseCliOptions(args)
  if (cli.help) {
    console.log(cliUsage())
    return
  }

  const config = loadConfig()
  const workspace = new Workspace(config.workspaceRoot)
  const registry = new ToolRegistry()

  try {
    registry.register(...createBuiltinTools({ workspace }))
    registry.register(createToolSearch(registry))
    await connectGitHubMCP(registry, config.githubMcp)

    const store = new SessionStore(cli.sessionId)
    if (cli.continueSession && !store.exists()) {
      throw new Error(`会话不存在: ${cli.sessionId}`)
    }
    if (!cli.continueSession && store.exists()) {
      throw new Error(`会话 ${cli.sessionId} 已存在；请改用 --continue --session ${cli.sessionId}`)
    }

    const loaded = cli.continueSession
      ? await store.loadState()
      : { messages: [], summary: '', budgetUsed: 0 }
    if (!cli.continueSession) await store.appendCheckpoint(loaded)
    console.log(
      cli.continueSession
        ? `[Session] 恢复 ${cli.sessionId}，工作上下文 ${loaded.messages.length} 条消息`
        : `[Session] 新会话 ${cli.sessionId}`,
    )
    if (!cli.continueSession) {
      console.log(`  恢复命令: super-agent chat --continue --session ${cli.sessionId}`)
    }

    printStartupStats(registry)
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
      compaction: config.compaction,
      maxSteps: config.agent.maxSteps,
      maxRetries: config.agent.maxRetries,
      autoApprove: cli.autoApprove || config.autoApprove,
    }

    if (cli.command === 'run') {
      if (!cli.prompt) throw new Error('run 命令缺少提示词')
      await runOnce(runtime, cli.prompt)
      return
    }

    startRepl(runtime)
  } catch (error) {
    try {
      await registry.close()
    } catch {
      // Preserve the application error as the primary failure.
    }
    throw error
  }
}
