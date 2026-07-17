import { createOpenAI } from '@ai-sdk/openai'
import { ToolRegistry } from '../core/tool-registry.js'
import { Workspace } from '../core/workspace.js'
import { loadConfig } from '../core/config.js'
import { createBuiltinTools, createToolSearch } from '../tools/index.js'
import { connectGitHubMCP } from '../mcp/create-mcp.js'
import { closeRuntime, printStartupStats, runOnce, startRepl } from './repl.js'
import {
  cliUsage,
  parseCliOptions,
  type OpsCliOptions,
  type SessionCliOptions,
} from './args.js'
import { SessionStore } from '../session/store.js'
import { diagnoseSession } from '../session/doctor.js'
import { RecoveryCoordinator } from '../execution/recovery-coordinator.js'
import type { Executor } from '../execution/executor.js'
import { LocalExecutor } from '../execution/local-executor.js'
import {
  FilesystemBroker,
  FilesystemBrokerUnavailableError,
} from '../execution/filesystem-broker.js'
import {
  SandboxExecutor,
  SandboxUnavailableError,
} from '../execution/sandbox-executor.js'
import { ExecutionRouter } from '../execution/execution-router.js'

function printableOperation(operation: Awaited<ReturnType<RecoveryCoordinator['listOperations']>>[number]) {
  return {
    operationId: operation.operationId,
    status: operation.status,
    toolName: operation.latestEvent.toolName,
    toolCallId: operation.latestEvent.toolCallId,
    sequence: operation.latestEvent.sequence,
    errorCode: operation.latestEvent.errorCode,
  }
}

async function runOps(cli: OpsCliOptions) {
  const store = await SessionStore.open(cli.sessionId)
  let operationError: unknown
  try {
    if (!store.exists()) throw new Error(`会话不存在: ${cli.sessionId}`)
    const recovery = new RecoveryCoordinator(store)
    if (cli.action === 'list') {
      const snapshot = await recovery.recover()
      console.log(JSON.stringify([...snapshot.operations.values()].map(printableOperation), null, 2))
      return
    }
    if (cli.action === 'resolve') {
      const resolved = await recovery.resolveOperation(cli.operationId!, {
        outcome: cli.outcome!,
      })
      console.log(JSON.stringify(printableOperation(resolved), null, 2))
      return
    }
    throw new Error('ops 需要 list 或 resolve 子命令')
  } catch (error) {
    operationError = error
    throw error
  } finally {
    try {
      await store.close()
    } catch (closeError) {
      if (operationError) {
        throw new AggregateError([operationError, closeError], 'ops 执行与 SessionStore 关闭均失败')
      }
      throw closeError
    }
  }
}

async function runSessionCommand(cli: SessionCliOptions) {
  if (cli.action !== 'doctor') throw new Error('session 需要 doctor 子命令')
  const report = await diagnoseSession(cli.sessionId)
  console.log(JSON.stringify(report, null, 2))
}

/** CLI application entry. Process-level error handling belongs to the executable shim. */
export async function runCli(args: string[]) {
  const cli = parseCliOptions(args)
  if (cli.help) {
    console.log(cliUsage())
    return
  }

  if (cli.command === 'ops') return runOps(cli)
  if (cli.command === 'session') return runSessionCommand(cli)

  const config = loadConfig()
  const executor: Executor = config.execution.profile === 'production'
    ? new SandboxExecutor(config.execution.sandbox)
    : new LocalExecutor()
  let registry: ToolRegistry | undefined
  let store: SessionStore | undefined
  let filesystem: FilesystemBroker | undefined

  try {
    const executorProbe = await executor.probe()
    if (config.execution.profile === 'production' && !executorProbe.available) {
      throw new SandboxUnavailableError(executorProbe.reasonCode || 'sandbox_probe_failed')
    }
    const workspace = new Workspace(config.workspaceRoot)
    filesystem = new FilesystemBroker(workspace.root, {
      requireDescriptorAnchoring: config.execution.profile === 'production',
    })
    if (config.execution.profile === 'production') {
      const filesystemProbe = await filesystem.probe()
      if (!filesystemProbe.available) {
        throw new FilesystemBrokerUnavailableError(
          `production filesystem broker 不可用: ${filesystemProbe.reasonCode}`,
        )
      }
    }
    registry = new ToolRegistry({
      onLegacyWarning: (warning) => console.warn(`[Security] ${warning}`),
      executionRouter: new ExecutionRouter({
        profile: config.execution.profile,
        processExecutor: executor,
      }),
    })
    registry.register(...createBuiltinTools({ workspace, filesystem }))
    registry.register(createToolSearch(registry))
    await connectGitHubMCP(registry, config.githubMcp)

    store = await SessionStore.open(cli.sessionId)
    if (cli.continueSession && !store.exists()) {
      throw new Error(`会话不存在: ${cli.sessionId}`)
    }
    if (!cli.continueSession && store.exists()) {
      throw new Error(`会话 ${cli.sessionId} 已存在；请改用 --continue --session ${cli.sessionId}`)
    }

    const recovery = new RecoveryCoordinator(store)
    await recovery.assertCanStartNewTurn()

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
      modelRequestTimeoutMs: config.agent.modelRequestTimeoutMs,
      turnTimeoutMs: config.agent.turnTimeoutMs,
      autoApprove: cli.autoApprove || config.autoApprove,
    }

    if (cli.command === 'run') {
      if (!cli.prompt) throw new Error('run 命令缺少提示词')
      await runOnce(runtime, cli.prompt)
      return
    }

    startRepl(runtime)
  } catch (error) {
    const cleanupErrors: unknown[] = []
    try {
      filesystem?.close()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    try {
      await closeRuntime({
        registry: registry ?? executor,
        ...(store === undefined ? {} : { store }),
      })
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'CLI 执行与运行时资源关闭均失败',
      )
    }
    throw error
  }
}
