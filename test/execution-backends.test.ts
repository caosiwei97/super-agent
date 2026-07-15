import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LocalExecutor } from '../src/execution/local-executor.js'
import {
  SandboxExecutor,
  SandboxUnavailableError,
} from '../src/execution/sandbox-executor.js'
import type { ExecutionRequest } from '../src/execution/executor.js'
import { executeProcess } from '../src/execution/process-executor.js'

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    schemaVersion: 1,
    operationId: 'operation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    toolName: 'process_probe',
    executionKind: 'process',
    input: {
      command: process.execPath,
      args: ['-e', "process.stdout.write('ok')"],
      maxOutputBytes: 1024,
    },
    capabilities: ['process.execute'],
    constraints: {},
    deadline: Date.now() + 5_000,
    ...overrides,
  }
}

describe('LocalExecutor', () => {
  it('executes argv through ProcessController and never satisfies requireSandbox', async () => {
    const executor = new LocalExecutor()
    assert.deepEqual(await executor.probe(), { available: true })
    assert.equal(executor.supports('process', {}), true)
    assert.equal(executor.supports('process', { requireSandbox: true }), false)
    assert.equal(executor.supports('pure', {}), false)

    const result = await executor.execute(request(), { signal: new AbortController().signal })
    assert.equal(result.outcome, 'succeeded')
    if (result.outcome === 'succeeded') {
      assert.equal((result.rawOutput as { stdout: string }).stdout, 'ok')
    }
  })

  it('returns no-side-effect failures for invalid, aborted and sandbox-required requests', async () => {
    const executor = new LocalExecutor()
    const invalid = await executor.execute(request({ input: { command: 'echo', shell: true } }), {
      signal: new AbortController().signal,
    })
    assert.deepEqual(invalid, {
      outcome: 'failed', errorCode: 'local_process_input_invalid', proof: 'no_side_effect',
    })

    const aborted = new AbortController()
    aborted.abort()
    const cancelled = await executor.execute(request(), { signal: aborted.signal })
    assert.deepEqual(cancelled, {
      outcome: 'failed', errorCode: 'process_aborted', proof: 'no_side_effect',
    })

    const sandboxed = await executor.execute(request({ constraints: { requireSandbox: true } }), {
      signal: new AbortController().signal,
    })
    assert.deepEqual(sandboxed, {
      outcome: 'failed', errorCode: 'local_executor_unsupported', proof: 'no_side_effect',
    })
  })
})

describe('SandboxExecutor bootstrap', () => {
  it('fails closed on non-Linux without inspecting host paths', async () => {
    const executor = new SandboxExecutor({
      bwrapPath: '/missing/bwrap',
      platform: 'darwin',
    })
    assert.deepEqual(await executor.probe(), {
      available: false,
      reasonCode: 'sandbox_platform_unsupported',
    })
    assert.equal(executor.supports('process', { requireSandbox: true }), false)
  })

  it('requires every production prerequisite before claiming Linux isolation', async () => {
    const incomplete = new SandboxExecutor({
      bwrapPath: '/missing/bwrap',
      platform: 'linux',
    })
    assert.deepEqual(await incomplete.probe(), {
      available: false,
      reasonCode: 'sandbox_configuration_incomplete',
    })
    assert.throws(
      () => new SandboxExecutor({ bwrapPath: 'relative/bwrap' }),
      /可信绝对路径/,
    )
    assert.equal(new SandboxUnavailableError('probe').reasonCode, 'probe')
  })

  it('stops the production CLI before session or provider initialization', async () => {
    const result = await executeProcess({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        'src/bin/super-agent.ts',
        'run',
        'must not reach the provider',
        '--session',
        `sandbox-probe-${process.pid}`,
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        SUPER_AGENT_EXECUTION_PROFILE: 'production',
        SUPER_AGENT_SANDBOX_ROOTFS: '',
        SUPER_AGENT_SANDBOX_SECCOMP_PROFILE: '',
        SUPER_AGENT_SANDBOX_CGROUP_ROOT: '',
      },
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    })

    assert.equal(result.terminationReason, 'exited')
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /SandboxUnavailableError|production sandbox 不可用/)
    assert.doesNotMatch(result.stdout, /\[Session\]|已注册|Step 1/)
  })
})
