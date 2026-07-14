import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCliOptions } from '../src/cli/args.js'
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

describe('CLI options', () => {
  it('creates unique sessions by default and preserves legacy continue behavior', () => {
    const first = parseCliOptions([])
    const second = parseCliOptions([])
    assert.notEqual(first.sessionId, second.sessionId)
    assert.equal(first.command, 'chat')
    assert.equal(parseCliOptions(['--continue']).sessionId, 'default')
  })

  it('parses explicit safe-operation flags and rejects unknown flags', () => {
    assert.deepEqual(parseCliOptions(['--', '--continue', '--session', 'demo-1', '--yes']), {
      command: 'chat',
      continueSession: true,
      sessionId: 'demo-1',
      autoApprove: true,
      prompt: undefined,
      help: false,
    })
    assert.throws(() => parseCliOptions(['--unknown']), /未知参数/)
  })

  it('parses one-shot prompts and validates their value', () => {
    const positional = parseCliOptions(['run', 'summarize this'])
    assert.deepEqual({ command: positional.command, prompt: positional.prompt }, {
      command: 'run',
      prompt: 'summarize this',
    })
    assert.equal(parseCliOptions(['--prompt', 'summarize this']).command, 'run')
    assert.equal(parseCliOptions(['-p', 'hello']).prompt, 'hello')
    assert.throws(() => parseCliOptions(['--prompt']), /需要一段提示词/)
    assert.throws(() => parseCliOptions(['--prompt', '   ']), /需要一段提示词/)
    assert.throws(() => parseCliOptions(['run']), /需要提示词/)
    assert.throws(() => parseCliOptions(['run', '--unknown']), /未知参数/)
    assert.throws(() => parseCliOptions(['chat', '--prompt', 'hello']), /chat 命令不接受/)
    assert.equal(parseCliOptions(['run', '--help']).help, true)
  })
})
