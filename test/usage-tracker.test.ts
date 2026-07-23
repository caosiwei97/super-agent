import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  computeBaselineCost,
  computeCost,
  normalizeUsage,
  PRICE_TABLE,
  resolvePricing,
  UsageTracker,
} from '../src/usage/tracker.js'
import { renderUsageSummary } from '../src/cli/repl.js'

describe('usage normalization', () => {
  it('uses AI SDK 6 cache details without double-counting cached input', () => {
    const normalized = normalizeUsage({
      inputTokens: 1_000,
      inputTokenDetails: {
        noCacheTokens: 200,
        cacheReadTokens: 700,
        cacheWriteTokens: 100,
      },
      outputTokens: 50,
    } as never)

    assert.deepEqual(normalized, {
      inputTokens: 200,
      outputTokens: 50,
      cacheWriteTokens: 100,
      cacheReadTokens: 700,
    })
  })

  it('falls back to DeepSeek raw cache hit and miss fields', () => {
    const normalized = normalizeUsage({
      inputTokens: 1_000,
      outputTokens: 20,
      raw: {
        prompt_cache_hit_tokens: 750,
        prompt_cache_miss_tokens: 250,
      },
    } as never)

    assert.deepEqual(normalized, {
      inputTokens: 250,
      outputTokens: 20,
      cacheWriteTokens: 0,
      cacheReadTokens: 750,
    })
  })
})

describe('UsageTracker', () => {
  it('prices only exact DeepSeek V4 model IDs', () => {
    assert.ok(resolvePricing('deepseek-v4-flash'))
    assert.ok(resolvePricing('deepseek-v4-pro'))
    assert.equal(resolvePricing('deepseek-v4-flash-custom'), undefined)
    assert.equal(resolvePricing('deepseek-chat'), undefined)
    assert.equal(resolvePricing('gpt-5'), undefined)
  })

  it('computes actual, no-cache baseline, savings, and hit rate', () => {
    const usage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheWriteTokens: 0,
      cacheReadTokens: 9_000,
    }
    const pricing = PRICE_TABLE['deepseek-v4-flash']
    const tracker = new UsageTracker()
    tracker.record('deepseek-v4-flash', usage, 123)

    assert.ok(Math.abs(computeCost(pricing, usage) - 0.0003052) < 1e-12)
    assert.ok(Math.abs(computeBaselineCost(pricing, usage) - 0.00154) < 1e-12)
    const totals = tracker.totals()
    assert.deepEqual({
      ...totals,
      cost: undefined,
      baselineCost: undefined,
      savedCost: undefined,
    }, {
      steps: 1,
      pricedSteps: 1,
      unpricedSteps: 0,
      ...usage,
      cost: undefined,
      baselineCost: undefined,
      savedCost: undefined,
      cacheHitRate: 0.9,
    })
    assert.ok(Math.abs(totals.cost - 0.0003052) < 1e-12)
    assert.ok(Math.abs(totals.baselineCost - 0.00154) < 1e-12)
    assert.ok(Math.abs(totals.savedCost - 0.0012348) < 1e-12)

    const summary = renderUsageSummary(tracker)
    assert.match(summary, /9,000 tokens \(90\.0% hit\)/)
    assert.match(summary, /Estimated saved\s+\$0\.001235 \(80\.2% off\)/)
  })

  it('keeps token totals but marks unknown model pricing as incomplete', () => {
    const tracker = new UsageTracker()
    const record = tracker.record('private-model', {
      inputTokens: 10,
      outputTokens: 2,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    })

    assert.equal(record.cost, undefined)
    assert.equal(tracker.totals().unpricedSteps, 1)
    assert.match(renderUsageSummary(tracker), /价格未知: private-model/)
  })
})
