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
})

describe('CLI', () => {
  it('only accepts the argument-free interactive entry', async () => {
    await assert.rejects(runCli(['chat']), /直接运行 ti/)
    await assert.rejects(runCli(['--yes']), /直接运行 ti/)
  })
})
