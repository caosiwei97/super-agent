import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runCli } from '../src/cli/main.js'
import { loadConfig } from '../src/core/config.js'

describe('configuration', () => {
  it('accepts zero retries and zero retained old tool results', () => {
    const config = loadConfig({
      AGENT_MAX_RETRIES: '0',
      CONTEXT_KEEP_RECENT_TOOL_MESSAGES: '0',
    })

    assert.equal(config.agent.maxRetries, 0)
    assert.equal(config.compaction.keepRecentToolMessages, 0)
  })

  it('configures GitHub MCP with only a personal access token', () => {
    assert.deepEqual(loadConfig({ GITHUB_PERSONAL_ACCESS_TOKEN: 'token' }).githubMcp, {
      token: 'token',
    })
  })
})

describe('CLI', () => {
  it('only accepts the argument-free interactive entry', async () => {
    await assert.rejects(runCli(['chat']), /直接运行 super-agent/)
    await assert.rejects(runCli(['--yes']), /直接运行 super-agent/)
  })
})
