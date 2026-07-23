import { resolve } from 'node:path'

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，当前值: ${raw}`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    model: {
      baseURL: env.MODEL_BASE_URL || 'https://api.deepseek.com',
      apiKey: env.OPENAI_API_KEY,
      modelId: env.MODEL_ID || 'deepseek-v4-flash',
      // AI SDK 不暴露模型实际上下文窗口，需显式配置；默认 16k 仅作兜底，
      // 按模型真实窗口设置（如 200000）才能用满上下文。
      contextWindowTokens: positiveInteger(env, 'MODEL_CONTEXT_WINDOW', 16_000),
    },
    agent: {
      tokenCostLimit: positiveInteger(env, 'TOKEN_BUDGET', 1_000_000),
    },
    workspaceRoot: resolve(env.TI_AGENT_WORKSPACE || process.cwd()),
    githubMcp: {
      token: env.GITHUB_PERSONAL_ACCESS_TOKEN,
    },
  }
}
