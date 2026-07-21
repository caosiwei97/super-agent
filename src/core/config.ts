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
    },
    agent: {
      budgetLimit: positiveInteger(env, 'TOKEN_BUDGET', 1_000_000),
    },
    workspaceRoot: resolve(env.TI_AGENT_WORKSPACE || process.cwd()),
    githubMcp: {
      token: env.GITHUB_PERSONAL_ACCESS_TOKEN,
    },
  }
}
