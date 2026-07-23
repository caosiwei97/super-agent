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

function optionalModelPricing(env: NodeJS.ProcessEnv) {
  const names = [
    'MODEL_INPUT_PRICE_PER_MILLION',
    'MODEL_OUTPUT_PRICE_PER_MILLION',
    'MODEL_CACHE_WRITE_PRICE_PER_MILLION',
    'MODEL_CACHE_READ_PRICE_PER_MILLION',
  ] as const
  const configured = names.filter((name) => env[name] !== undefined && env[name] !== '')
  if (configured.length === 0) return undefined
  if (configured.length !== names.length) {
    throw new Error(`${names.join('、')} 必须同时配置`)
  }

  const values = names.map((name) => {
    const value = Number(env[name])
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} 必须是非负数，当前值: ${env[name]}`)
    }
    return value
  })
  return {
    input: values[0],
    output: values[1],
    cacheWrite: values[2],
    cacheRead: values[3],
  }
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
      pricing: optionalModelPricing(env),
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
