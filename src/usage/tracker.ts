import type { LanguageModelUsage } from 'ai'

export interface ModelPricing {
  /** 美元 / 1M tokens。 */
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface StepUsage {
  /** 未命中缓存的普通输入 token。 */
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface StepRecord extends StepUsage {
  timestamp: number
  model: string
  /** 未知模型不会伪造价格，成本字段保持为空。 */
  cost?: number
  baselineCost?: number
}

export interface UsageTotals extends StepUsage {
  steps: number
  pricedSteps: number
  unpricedSteps: number
  cost: number
  baselineCost: number
  savedCost: number
  cacheHitRate: number
}

/**
 * 当前只维护 DeepSeek 官方直连 API 的 V4 价格。
 * 单位统一为 USD / 1M tokens；代理平台或其他模型必须由调用方显式覆盖。
 */
export const PRICE_TABLE: Readonly<Record<string, ModelPricing>> = {
  // https://api-docs.deepseek.com/quick_start/pricing (2026-07-23)
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheWrite: 0.14, cacheRead: 0.0028 },
  'deepseek-v4-pro': { input: 0.435, output: 0.87, cacheWrite: 0.435, cacheRead: 0.003625 },
}

type UsageLike = Partial<LanguageModelUsage>

function finiteTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function recordValue(value: unknown, ...path: string[]) {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function firstTokenCount(...values: unknown[]) {
  for (const value of values) {
    const tokens = finiteTokenCount(value)
    if (tokens !== undefined) return tokens
  }
  return 0
}

/**
 * 把 AI SDK 6 与 DeepSeek OpenAI-compatible usage 统一为四类 token。
 *
 * AI SDK 6 的 inputTokenDetails 优先级最高；raw 仅用于兼容 DeepSeek 原始
 * prompt_cache_hit_tokens / prompt_cache_miss_tokens。
 */
export function normalizeUsage(usage: UsageLike | undefined): StepUsage {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
  }

  const raw = usage.raw
  const cacheReadTokens = firstTokenCount(
    usage.inputTokenDetails?.cacheReadTokens,
    usage.cachedInputTokens,
    recordValue(raw, 'prompt_cache_hit_tokens'),
    recordValue(raw, 'prompt_tokens_details', 'cached_tokens'),
  )
  const cacheWriteTokens = firstTokenCount(usage.inputTokenDetails?.cacheWriteTokens)

  const totalInputTokens = firstTokenCount(usage.inputTokens)
  const providerMissTokens = firstTokenCount(
    usage.inputTokenDetails?.noCacheTokens,
    recordValue(raw, 'prompt_cache_miss_tokens'),
  )
  const hasExplicitMissCount =
    finiteTokenCount(usage.inputTokenDetails?.noCacheTokens) !== undefined ||
    finiteTokenCount(recordValue(raw, 'prompt_cache_miss_tokens')) !== undefined
  const inputTokens = hasExplicitMissCount
    ? providerMissTokens
    : Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens)

  return {
    inputTokens,
    outputTokens: firstTokenCount(usage.outputTokens),
    cacheWriteTokens,
    cacheReadTokens,
  }
}

export function resolvePricing(
  model: string,
  prices: Readonly<Record<string, ModelPricing>> = PRICE_TABLE,
) {
  return prices[model]
}

export function computeCost(pricing: ModelPricing, usage: StepUsage) {
  return (
    usage.inputTokens * pricing.input +
    usage.outputTokens * pricing.output +
    usage.cacheWriteTokens * pricing.cacheWrite +
    usage.cacheReadTokens * pricing.cacheRead
  ) / 1_000_000
}

export function computeBaselineCost(pricing: ModelPricing, usage: StepUsage) {
  return (
    (usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens) * pricing.input +
    usage.outputTokens * pricing.output
  ) / 1_000_000
}

export function isStepRecord(value: unknown): value is StepRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<StepRecord>
  const tokenCounts = [
    record.inputTokens,
    record.outputTokens,
    record.cacheWriteTokens,
    record.cacheReadTokens,
  ]
  return (
    typeof record.model === 'string' &&
    record.model.length > 0 &&
    finiteTokenCount(record.timestamp) !== undefined &&
    tokenCounts.every((tokens) => finiteTokenCount(tokens) !== undefined) &&
    (record.cost === undefined || (Number.isFinite(record.cost) && record.cost >= 0)) &&
    (
      record.baselineCost === undefined ||
      (Number.isFinite(record.baselineCost) && record.baselineCost >= 0)
    )
  )
}

export class UsageTracker {
  private readonly steps: StepRecord[]

  constructor(
    records: readonly StepRecord[] = [],
    private readonly prices: Readonly<Record<string, ModelPricing>> = PRICE_TABLE,
  ) {
    if (!records.every(isStepRecord)) throw new Error('UsageTracker 收到无效的历史记录')
    this.steps = records.map((record) => {
      if (record.cost !== undefined && record.baselineCost !== undefined) return { ...record }
      const pricing = resolvePricing(record.model, this.prices)
      return pricing
        ? {
            ...record,
            cost: computeCost(pricing, record),
            baselineCost: computeBaselineCost(pricing, record),
          }
        : { ...record }
    })
  }

  record(model: string, usage: StepUsage, timestamp = Date.now()) {
    const pricing = resolvePricing(model, this.prices)
    const record: StepRecord = {
      timestamp,
      model,
      ...usage,
      ...(pricing
        ? {
            cost: computeCost(pricing, usage),
            baselineCost: computeBaselineCost(pricing, usage),
          }
        : {}),
    }
    if (!isStepRecord(record)) throw new Error('UsageTracker 收到无效的 step usage')
    this.steps.push(record)
    return record
  }

  records() {
    return this.steps.map((record) => ({ ...record }))
  }

  totals(): UsageTotals {
    const totals: UsageTotals = {
      steps: this.steps.length,
      pricedSteps: 0,
      unpricedSteps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      cost: 0,
      baselineCost: 0,
      savedCost: 0,
      cacheHitRate: 0,
    }

    for (const step of this.steps) {
      totals.inputTokens += step.inputTokens
      totals.outputTokens += step.outputTokens
      totals.cacheWriteTokens += step.cacheWriteTokens
      totals.cacheReadTokens += step.cacheReadTokens
      if (step.cost === undefined || step.baselineCost === undefined) {
        totals.unpricedSteps++
      } else {
        totals.pricedSteps++
        totals.cost += step.cost
        totals.baselineCost += step.baselineCost
      }
    }

    totals.savedCost = totals.baselineCost - totals.cost
    const inputTotal = totals.inputTokens + totals.cacheWriteTokens + totals.cacheReadTokens
    totals.cacheHitRate = inputTotal === 0 ? 0 : totals.cacheReadTokens / inputTotal
    return totals
  }
}
