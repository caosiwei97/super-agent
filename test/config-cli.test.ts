import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runCli } from '../src/cli/main.js'
import { loadConfig } from '../src/core/config.js'

describe('configuration', () => {
  it('keeps runtime policies out of environment configuration', () => {
    const config = loadConfig({})

    assert.deepEqual(config.agent, { budgetLimit: 1_000_000 })
    assert.equal('compaction' in config, false)
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
