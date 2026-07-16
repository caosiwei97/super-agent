import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ExecutionRequest, ExecutionResult } from '../src/execution/executor.js'
import {
  buildLinuxSandboxCommand,
  SANDBOX_RELEASE_PROBE_PATH,
} from '../src/execution/linux-sandbox-command.js'
import { SandboxExecutor } from '../src/execution/sandbox-executor.js'

const MAX_OUTPUT_BYTES = 16 * 1024
const WALL_TIME_MS = 8_000
const MAX_MEMORY_BYTES = 256 * 1024 * 1024
const MAX_PIDS = 8
const MAX_CPU_MICROS_PER_SECOND = 100_000
const MAX_OPEN_FILES = 256

function requiredEnvironment(name: string) {
  const value = process.env[name]
  assert.ok(value, `${name} is required by the non-skippable Linux release gate`)
  assert.equal(value.startsWith('/'), true, `${name} must be an absolute path`)
  return value
}

function request(
  workspace: string,
  operation: string,
  toolName: 'workspace_inspect' | 'sandbox-release-probe',
  input: unknown,
  deadlineMs = WALL_TIME_MS,
): ExecutionRequest {
  return {
    schemaVersion: 1,
    operationId: `release-${operation}`,
    attemptId: `release-${operation}`,
    toolCallId: `release-${operation}`,
    toolName,
    executionKind: 'process',
    input,
    capabilities: ['process.execute', 'filesystem.read'],
    constraints: {
      filesystemReadRoots: [workspace],
      requireSandbox: true,
    },
    deadline: Date.now() + deadlineMs,
  }
}

function succeededOutput(result: ExecutionResult) {
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(typeof result.rawOutput, 'string')
  return result.rawOutput as string
}

async function assertCleanup(cgroupRoot: string, stagingParent: string) {
  const [cgroups, snapshots] = await Promise.all([
    readdir(cgroupRoot),
    readdir(stagingParent),
  ])
  assert.deepEqual(
    cgroups.filter((name) => name.startsWith('super-agent-op-')),
    [],
    'per-operation cgroup leaked after execute returned',
  )
  assert.deepEqual(
    snapshots.filter((name) => name.startsWith('super-agent-workspace-snapshot-')),
    [],
    'workspace snapshot leaked after execute returned',
  )
}

describe('PR10B target-Linux release gate', () => {
  it('passes the complete public SandboxExecutor enforcement matrix without skips', async () => {
    assert.equal(
      process.platform,
      'linux',
      'test:linux-release must run on a target Linux kernel; non-Linux is a release failure',
    )

    const bwrapPath = requiredEnvironment('SUPER_AGENT_BWRAP_PATH')
    const rootfsPath = requiredEnvironment('SUPER_AGENT_SANDBOX_ROOTFS')
    const seccompProfilePath = requiredEnvironment('SUPER_AGENT_SANDBOX_SECCOMP_PROFILE')
    const cgroupRoot = requiredEnvironment('SUPER_AGENT_SANDBOX_CGROUP_ROOT')
    const stagingParent = requiredEnvironment('SUPER_AGENT_SANDBOX_STAGING_PARENT')
    const crashSupervisorMode = process.env.SUPER_AGENT_SANDBOX_CRASH_SUPERVISOR
    assert.ok(
      crashSupervisorMode === 'systemd-control-group-v1'
        || crashSupervisorMode === 'container-control-group-v1',
      'SUPER_AGENT_SANDBOX_CRASH_SUPERVISOR must name an accepted supervisor contract',
    )
    const seccompProfileSha256 = process.env.SUPER_AGENT_SANDBOX_SECCOMP_SHA256
    assert.match(
      seccompProfileSha256 ?? '',
      /^[a-f0-9]{64}$/,
      'SUPER_AGENT_SANDBOX_SECCOMP_SHA256 is required and must be lowercase SHA-256',
    )

    const workspace = await mkdtemp(join(tmpdir(), 'super-agent-linux-release-'))
    await writeFile(join(workspace, 'marker.txt'), 'alpha\nbeta alpha\n', { mode: 0o600 })
    const executor = new SandboxExecutor({
      bwrapPath,
      rootfsPath,
      seccompProfilePath,
      seccompProfileSha256,
      cgroupRoot,
      crashSupervisorMode,
      snapshotStagingParent: stagingParent,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      wallTimeMs: WALL_TIME_MS,
      maxCgroupMemoryBytes: MAX_MEMORY_BYTES,
      maxCgroupSwapBytes: 0,
      maxCgroupPids: MAX_PIDS,
      maxCgroupCpuMicrosPerSecond: MAX_CPU_MICROS_PER_SECOND,
      maxOpenFiles: MAX_OPEN_FILES,
    })

    const execute = async (
      operation: string,
      toolName: 'workspace_inspect' | 'sandbox-release-probe',
      input: unknown,
      options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
    ) => {
      const result = await executor.execute(
        request(workspace, operation, toolName, input, options.deadlineMs),
        { signal: options.signal ?? new AbortController().signal },
      )
      await assertCleanup(cgroupRoot, stagingParent)
      return result
    }

    try {
      const probe = await executor.probe()
      assert.deepEqual(probe, { available: true })
      await assertCleanup(cgroupRoot, stagingParent)

      const fixedCommand = buildLinuxSandboxCommand(
        request(workspace, 'argv', 'sandbox-release-probe', { action: 'cpu' }),
        {
          bwrapPath,
          rootfsPath,
          seccompFd: 3,
          workspaceFd: 4,
          scratchBytes: 1024,
        },
      )
      assert.deepEqual(fixedCommand.args.slice(fixedCommand.args.indexOf('--') + 1), [
        SANDBOX_RELEASE_PROBE_PATH,
        'v1',
        'cpu',
      ])
      assert.throws(() => buildLinuxSandboxCommand(
        request(workspace, 'argv-reject', 'sandbox-release-probe', {
          action: 'cpu',
          argv: ['sh', '-c', 'id'],
        }),
        {
          bwrapPath,
          rootfsPath,
          seccompFd: 3,
          workspaceFd: 4,
          scratchBytes: 1024,
        },
      ), /固定 action 契约/)
      const exactUtf8Boundary = `${'界'.repeat(85)}a`
      const overUtf8Boundary = `${exactUtf8Boundary}b`
      assert.equal(Buffer.byteLength(exactUtf8Boundary), 256)
      assert.equal(Buffer.byteLength(overUtf8Boundary), 257)
      assert.throws(() => buildLinuxSandboxCommand(
        request(workspace, 'utf8-reject', 'workspace_inspect', {
          action: 'search_text', path: 'marker.txt', limit: 10, query: overUtf8Boundary,
        }),
        {
          bwrapPath,
          rootfsPath,
          seccompFd: 3,
          workspaceFd: 4,
          scratchBytes: 1024,
        },
      ), /合法 query/)

      assert.equal(succeededOutput(await execute(
        'inspect-list',
        'workspace_inspect',
        { action: 'list_files', path: '.', limit: 10 },
      )), 'marker.txt\n')
      assert.equal(succeededOutput(await execute(
        'inspect-read',
        'workspace_inspect',
        { action: 'read_text', path: 'marker.txt', limit: 2 },
      )), 'alpha\nbeta alpha\n')
      assert.equal(succeededOutput(await execute(
        'inspect-search',
        'workspace_inspect',
        { action: 'search_text', path: 'marker.txt', limit: 10, query: 'alpha' },
      )), '1:alpha\n2:beta alpha\n')
      assert.equal(succeededOutput(await execute(
        'inspect-search-empty',
        'workspace_inspect',
        { action: 'search_text', path: 'marker.txt', limit: 10, query: exactUtf8Boundary },
      )), '')

      assert.equal(succeededOutput(await execute(
        'readonly',
        'sandbox-release-probe',
        { action: 'readonly' },
      )), 'release:readonly-ok\n')
      await assert.rejects(stat(join(workspace, 'release-write-test')), { code: 'ENOENT' })

      assert.deepEqual(await execute(
        'output',
        'sandbox-release-probe',
        { action: 'output' },
      ), { outcome: 'uncertain', errorCode: 'sandbox_output_limit' })

      assert.deepEqual(await execute(
        'deadline',
        'sandbox-release-probe',
        { action: 'sleep' },
        { deadlineMs: 1_500 },
      ), { outcome: 'uncertain', errorCode: 'sandbox_timeout' })

      const cancellation = new AbortController()
      const cancellationTimer = setTimeout(() => cancellation.abort(), 1_000)
      try {
        assert.deepEqual(await execute(
          'cancel',
          'sandbox-release-probe',
          { action: 'sleep' },
          { signal: cancellation.signal },
        ), { outcome: 'uncertain', errorCode: 'sandbox_aborted' })
      } finally {
        clearTimeout(cancellationTimer)
      }

      const pidsOutput = succeededOutput(await execute(
        'pids',
        'sandbox-release-probe',
        { action: 'fork' },
      ))
      const pids = /^release:pids-limited:(\d+)\n$/.exec(pidsOutput)
      assert.ok(pids, pidsOutput)
      // bwrap keeps a PID-namespace init alongside the fixed helper. The
      // remaining six slots must be consumed before fork receives EAGAIN.
      assert.equal(Number(pids[1]), MAX_PIDS - 2)

      const fdOutput = succeededOutput(await execute(
        'fd',
        'sandbox-release-probe',
        { action: 'fd' },
      ))
      const descriptors = /^release:fd-limited:(\d+)\n$/.exec(fdOutput)
      assert.ok(descriptors, fdOutput)
      assert.ok(Number(descriptors[1]) >= 240 && Number(descriptors[1]) <= MAX_OPEN_FILES)

      const cpuOutput = succeededOutput(await execute(
        'cpu',
        'sandbox-release-probe',
        { action: 'cpu' },
      ))
      const cpu = /^release:cpu:(\d+):(\d+):(\d+)\n$/.exec(cpuOutput)
      assert.ok(cpu, cpuOutput)
      const cpuMicroseconds = Number(cpu[1])
      const wallMicroseconds = Number(cpu[2])
      assert.ok(cpuMicroseconds >= 240_000 && cpuMicroseconds <= 500_000, cpuOutput)
      // The one-second CFS period permits phase-dependent initial quota. Keep
      // the assertion ratio-based while retaining a meaningful absolute floor.
      assert.ok(wallMicroseconds >= 1_000_000, cpuOutput)
      assert.ok(wallMicroseconds >= cpuMicroseconds * 4, cpuOutput)
    } finally {
      await executor.close()
      await assertCleanup(cgroupRoot, stagingParent)
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
