import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCliOptions } from '../src/cli/args.js'
import { inputPreview } from '../src/cli/repl.js'
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

  it('validates turn and model request deadlines', () => {
    const config = loadConfig({
      AGENT_TURN_TIMEOUT_MS: '90000',
      MODEL_REQUEST_TIMEOUT_MS: '30000',
    })
    assert.equal(config.agent.turnTimeoutMs, 90_000)
    assert.equal(config.agent.modelRequestTimeoutMs, 30_000)
    assert.throws(() => loadConfig({ AGENT_TURN_TIMEOUT_MS: '0' }), /正整数/)
    assert.throws(() => loadConfig({ MODEL_REQUEST_TIMEOUT_MS: '-1' }), /正整数/)
  })

  it('configures GitHub MCP with only a personal access token', () => {
    assert.deepEqual(loadConfig({ GITHUB_PERSONAL_ACCESS_TOKEN: 'token' }).githubMcp, {
      token: 'token',
    })
  })

  it('defaults to development execution and validates production sandbox paths', () => {
    assert.equal(loadConfig({}).execution.profile, 'development')
    const execution = loadConfig({
      SUPER_AGENT_EXECUTION_PROFILE: 'production',
      SUPER_AGENT_BWRAP_PATH: '/opt/super-agent/bin/bwrap',
      SUPER_AGENT_SANDBOX_ROOTFS: '/opt/super-agent/rootfs',
      SUPER_AGENT_SANDBOX_SECCOMP_PROFILE: '/opt/super-agent/seccomp.bpf',
      SUPER_AGENT_SANDBOX_SECCOMP_SHA256: 'a'.repeat(64),
      SUPER_AGENT_SANDBOX_CGROUP_ROOT: '/sys/fs/cgroup/super-agent',
    }).execution

    assert.deepEqual(execution, {
      profile: 'production',
      sandbox: {
        bwrapPath: '/opt/super-agent/bin/bwrap',
        mkfifoPath: '/usr/bin/mkfifo',
        rootfsPath: '/opt/super-agent/rootfs',
        seccompProfilePath: '/opt/super-agent/seccomp.bpf',
        seccompProfileSha256: 'a'.repeat(64),
        cgroupRoot: '/sys/fs/cgroup/super-agent',
        crashSupervisorMode: undefined,
        maxCgroupMemoryBytes: 1024 * 1024 * 1024,
        maxCgroupSwapBytes: 0,
        maxCgroupPids: 64,
        maxCgroupCpuMicrosPerSecond: 1_000_000,
        maxOpenFiles: 4_096,
        snapshotStagingParent: undefined,
        snapshotMaxFiles: 10_000,
        snapshotMaxEntries: 20_000,
        snapshotMaxTotalBytes: 256 * 1024 * 1024,
        snapshotMaxFileBytes: 16 * 1024 * 1024,
        snapshotMaxDepth: 64,
      },
    })
    assert.throws(
      () => loadConfig({ SUPER_AGENT_EXECUTION_PROFILE: 'staging' }),
      /development 或 production/,
    )
    for (const name of [
      'SUPER_AGENT_BWRAP_PATH',
      'SUPER_AGENT_MKFIFO_PATH',
      'SUPER_AGENT_SANDBOX_ROOTFS',
      'SUPER_AGENT_SANDBOX_SECCOMP_PROFILE',
      'SUPER_AGENT_SANDBOX_CGROUP_ROOT',
      'SUPER_AGENT_SANDBOX_STAGING_PARENT',
    ]) {
      assert.throws(() => loadConfig({ [name]: 'relative/path' }), /必须是绝对路径/)
    }
    assert.throws(
      () => loadConfig({ SUPER_AGENT_SANDBOX_SECCOMP_SHA256: 'not-a-digest' }),
      /SHA-256/,
    )
    assert.throws(
      () => loadConfig({ SUPER_AGENT_SANDBOX_CRASH_SUPERVISOR: 'trust-me' }),
      /CRASH_SUPERVISOR/,
    )
    assert.throws(() => loadConfig({ SUPER_AGENT_SANDBOX_MAX_PIDS: '0' }), /正整数/)
    assert.throws(() => loadConfig({ SUPER_AGENT_SANDBOX_MAX_OPEN_FILES: '0' }), /正整数/)
    assert.throws(
      () => loadConfig({ SUPER_AGENT_SANDBOX_MAX_SWAP_BYTES: '-1' }),
      /非负整数/,
    )
  })
})

describe('CLI options', () => {
  it('redacts secrets in approval and observer previews', () => {
    const marker = 'CLI_SENSITIVE_MARKER'
    const preview = inputPreview({
      apiKey: marker,
      content: [{ text: `cookie: ${marker}` }],
      publicValue: 'kept',
    })
    assert.equal(preview.includes(marker), false)
    assert.equal(preview.includes('publicValue'), true)
  })

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

  it('parses operation list and explicit reconciliation commands', () => {
    assert.deepEqual(parseCliOptions(['ops', 'list', '--session', 'session-1']), {
      command: 'ops',
      action: 'list',
      sessionId: 'session-1',
      operationId: undefined,
      outcome: undefined,
      help: false,
    })
    assert.deepEqual(parseCliOptions([
      'ops', 'resolve', '--session', 'session-1',
      '--operation', 'operation-1', '--outcome', 'failed',
    ]), {
      command: 'ops',
      action: 'resolve',
      sessionId: 'session-1',
      operationId: 'operation-1',
      outcome: 'failed',
      help: false,
    })
    assert.throws(() => parseCliOptions(['ops']), /list|resolve/)
    assert.throws(() => parseCliOptions(['ops', 'resolve']), /operation|outcome/)
    assert.throws(
      () => parseCliOptions(['ops', 'resolve', '--operation', 'op', '--outcome', 'unknown']),
      /succeeded|failed/,
    )
  })
})
