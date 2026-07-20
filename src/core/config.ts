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

function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数，当前值: ${raw}`)
  }
  return value
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正数，当前值: ${raw}`)
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
      maxSteps: positiveInteger(env, 'AGENT_MAX_STEPS', 15),
      maxRetries: nonNegativeInteger(env, 'AGENT_MAX_RETRIES', 10),
    },
    compaction: {
      tokenThreshold: positiveInteger(env, 'CONTEXT_TOKEN_THRESHOLD', 12_000),
      keepRecentMessages: positiveInteger(env, 'CONTEXT_KEEP_RECENT_MESSAGES', 8),
      keepRecentToolMessages: nonNegativeInteger(env, 'CONTEXT_KEEP_RECENT_TOOL_MESSAGES', 4),
      asciiCharsPerToken: positiveNumber(env, 'CONTEXT_ASCII_CHARS_PER_TOKEN', 4),
      maxSummaryChars: positiveInteger(env, 'CONTEXT_MAX_SUMMARY_CHARS', 1_200),
    },
    workspaceRoot: resolve(env.SUPER_AGENT_WORKSPACE || process.cwd()),
    githubMcp: {
      token: env.GITHUB_PERSONAL_ACCESS_TOKEN,
    },
  }
}
