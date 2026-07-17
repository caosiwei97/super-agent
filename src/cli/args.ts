import { createSessionId } from '../session/store.js'

export type CliCommand = 'chat' | 'run' | 'ops' | 'session'
export type OpsAction = 'list' | 'resolve'
export type OpsOutcome = 'succeeded' | 'failed'
export type SessionAction = 'doctor'

export interface AgentCliOptions {
  command: 'chat' | 'run'
  continueSession: boolean
  sessionId: string
  autoApprove: boolean
  prompt: string | undefined
  help: boolean
}

export interface OpsCliOptions {
  command: 'ops'
  action: OpsAction | undefined
  sessionId: string
  operationId: string | undefined
  outcome: OpsOutcome | undefined
  help: boolean
  readonly prompt?: undefined
  readonly continueSession?: false
  readonly autoApprove?: false
}

export interface SessionCliOptions {
  command: 'session'
  action: SessionAction | undefined
  sessionId: string
  help: boolean
  readonly prompt?: undefined
  readonly continueSession?: false
  readonly autoApprove?: false
}

export type CliOptions = AgentCliOptions | OpsCliOptions | SessionCliOptions

export function parseCliOptions(args: string[]): CliOptions {
  let command: CliCommand | undefined
  let action: OpsAction | undefined
  let sessionAction: SessionAction | undefined
  let continueSession = false
  let sessionId: string | undefined
  let autoApprove = false
  let prompt: string | undefined
  let operationId: string | undefined
  let outcome: OpsOutcome | undefined
  let help = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    // pnpm/npm may forward the conventional separator to the script itself.
    if (arg === '--') continue
    if ((arg === 'chat' || arg === 'run' || arg === 'ops' || arg === 'session') &&
      command === undefined && prompt === undefined) {
      command = arg
    } else if (command === 'ops' && (arg === 'list' || arg === 'resolve') && action === undefined) {
      action = arg
    } else if (command === 'session' && arg === 'doctor' && sessionAction === undefined) {
      sessionAction = arg
    } else if (arg === '--continue') continueSession = true
    else if (arg === '--yes' || arg === '-y') autoApprove = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--prompt' || arg === '-p') {
      prompt = args[++index]
      if (!prompt?.trim()) throw new Error(`${arg} 需要一段提示词`)
    } else if (arg === '--session') {
      sessionId = args[++index]
      if (!sessionId) throw new Error('--session 需要一个 session ID')
    } else if (arg === '--operation') {
      operationId = args[++index]
      if (!operationId?.trim()) throw new Error('--operation 需要一个 operation ID')
    } else if (arg === '--outcome') {
      const value = args[++index]
      if (value !== 'succeeded' && value !== 'failed') {
        throw new Error('--outcome 必须是 succeeded 或 failed')
      }
      outcome = value
    } else if (command === 'run' && prompt === undefined && !arg.startsWith('-')) {
      prompt = arg
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }

  const resolvedCommand = command || (prompt === undefined ? 'chat' : 'run')
  if (resolvedCommand === 'session') {
    if (!help && sessionAction === undefined) throw new Error('session 需要 doctor 子命令')
    if (continueSession || autoApprove || prompt !== undefined || operationId !== undefined ||
      outcome !== undefined) {
      throw new Error('session doctor 只接受 --session 与 --help')
    }
    return {
      command: 'session',
      action: sessionAction,
      sessionId: sessionId || 'default',
      help,
    }
  }
  if (resolvedCommand === 'ops') {
    if (!help && action === undefined) throw new Error('ops 需要 list 或 resolve 子命令')
    if (continueSession || autoApprove || prompt !== undefined) {
      throw new Error('ops 不接受 --continue、--yes 或 --prompt')
    }
    if (action === 'resolve' && !help && (!operationId || !outcome)) {
      throw new Error('ops resolve 需要 --operation 和 --outcome')
    }
    if (action === 'list' && (operationId !== undefined || outcome !== undefined)) {
      throw new Error('ops list 不接受 --operation 或 --outcome')
    }
    return {
      command: 'ops',
      action,
      sessionId: sessionId || 'default',
      operationId,
      outcome,
      help,
    }
  }
  if (!help && resolvedCommand === 'run' && !prompt?.trim()) {
    throw new Error('run 命令需要提示词，例如 super-agent run "你的任务"')
  }
  if (resolvedCommand === 'chat' && prompt !== undefined) {
    throw new Error('chat 命令不接受 --prompt，请改用 super-agent run')
  }

  return {
    command: resolvedCommand,
    continueSession,
    // `default` keeps old JSONL sessions resumable. New sessions always receive
    // a unique ID unless the user explicitly names one.
    sessionId: sessionId || (continueSession ? 'default' : createSessionId()),
    autoApprove,
    prompt,
    help,
  }
}

export function cliUsage() {
  return `Super Agent CLI

用法:
  super-agent chat [选项]
  super-agent run <prompt> [选项]
  super-agent run --prompt <text> [选项]
  super-agent ops list --session <id>
  super-agent ops resolve --session <id> --operation <id> --outcome succeeded|failed
  super-agent session doctor --session <id>

选项:
  --session <id>  指定会话 ID
  --continue      恢复指定会话（未指定 ID 时恢复旧版 default）
  --prompt, -p <text>  run 命令的提示词
  --yes, -y       自动批准读写工具，仅建议在可信环境使用
  --help, -h      显示帮助

兼容旧用法:
  super-agent --prompt <text>`
}
