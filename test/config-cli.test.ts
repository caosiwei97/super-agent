import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runCli } from '../src/cli/main.js'
import { loadConfig } from '../src/core/config.js'

describe('configuration', () => {
  it('keeps runtime policies out of environment configuration', () => {
    const config = loadConfig({})

    assert.deepEqual(config.agent, { tokenCostLimit: 1_000_000 })
    assert.equal('compaction' in config, false)
  })

  it('defaults the model context window to a safe fallback and overrides via env', () => {
    assert.equal(loadConfig({}).model.contextWindowTokens, 16_000)
    assert.equal(
      loadConfig({ MODEL_CONTEXT_WINDOW: '200000' }).model.contextWindowTokens,
      200_000,
    )
  })

  it('configures GitHub MCP with only a personal access token', () => {
    assert.deepEqual(loadConfig({ GITHUB_PERSONAL_ACCESS_TOKEN: 'token' }).githubMcp, {
      token: 'token',
    })
  })

  it('accepts only a complete non-negative pricing override', () => {
    const pricingEnv = {
      MODEL_INPUT_PRICE_PER_MILLION: '1',
      MODEL_OUTPUT_PRICE_PER_MILLION: '2',
      MODEL_CACHE_WRITE_PRICE_PER_MILLION: '1.25',
      MODEL_CACHE_READ_PRICE_PER_MILLION: '0.1',
    }
    assert.deepEqual(loadConfig(pricingEnv).model.pricing, {
      input: 1,
      output: 2,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    })
    assert.throws(
      () => loadConfig({ MODEL_INPUT_PRICE_PER_MILLION: '1' }),
      /必须同时配置/,
    )
    assert.throws(
      () => loadConfig({ ...pricingEnv, MODEL_OUTPUT_PRICE_PER_MILLION: '-1' }),
      /必须是非负数/,
    )
  })
})

describe('CLI', () => {
  it('only accepts the argument-free interactive entry', async () => {
    await assert.rejects(runCli(['chat']), /直接运行 ti/)
    await assert.rejects(runCli(['--yes']), /直接运行 ti/)
  })
})
