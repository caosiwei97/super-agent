import { createSessionId } from '../session/store.js'

export type CliCommand = 'chat' | 'run'

export function parseCliOptions(args: string[]) {
  let command: CliCommand | undefined
  let continueSession = false
  let sessionId: string | undefined
  let autoApprove = false
  let prompt: string | undefined
  let help = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    // pnpm/npm may forward the conventional separator to the script itself.
    if (arg === '--') continue
    if ((arg === 'chat' || arg === 'run') && command === undefined && prompt === undefined) {
      command = arg
    } else if (arg === '--continue') continueSession = true
    else if (arg === '--yes' || arg === '-y') autoApprove = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--prompt' || arg === '-p') {
      prompt = args[++index]
      if (!prompt?.trim()) throw new Error(`${arg} 需要一段提示词`)
    } else if (arg === '--session') {
      sessionId = args[++index]
      if (!sessionId) throw new Error('--session 需要一个 session ID')
    } else if (command === 'run' && prompt === undefined && !arg.startsWith('-')) {
      prompt = arg
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }

  const resolvedCommand = command || (prompt === undefined ? 'chat' : 'run')
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

选项:
  --session <id>  指定会话 ID
  --continue      恢复指定会话（未指定 ID 时恢复旧版 default）
  --prompt, -p <text>  run 命令的提示词
  --yes, -y       自动批准读写工具，仅建议在可信环境使用
  --help, -h      显示帮助

兼容旧用法:
  super-agent --prompt <text>`
}
