import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fstatSync, readFileSync } from 'node:fs'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildLinuxSandboxCommand,
  supportsBwrapFeatures,
  supportsBwrapVersion,
} from '../src/execution/linux-sandbox-command.js'
import {
  SECCOMP_POLICY_PROBE_MARKER,
  SECCOMP_POLICY_PROBE_PATH,
  SandboxExecutor,
  seccompPolicyProbeSucceeded,
  supportsLinuxSandboxCapabilities,
  supportsLinuxSandboxConstraints,
} from '../src/execution/sandbox-executor.js'
import {
  SeccompProfileIntegrityError,
  SeccompProfileUnavailableError,
  withSeccompProfileFd,
} from '../src/execution/linux-sandbox-seccomp.js'
import {
  SharedCgroupProcessGate,
  WorkspaceAnchorUnavailableError,
  cgroupValuesWithinLimits,
  cleanupStaleSandboxProbeDirectories,
  verifyReadOnlyWorkspace,
  withReadOnlyWorkspaceFd,
} from '../src/execution/linux-sandbox-prerequisites.js'
import type { ExecutionRequest } from '../src/execution/executor.js'

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    schemaVersion: 1,
    operationId: 'sandbox-operation',
    attemptId: 'sandbox-attempt',
    toolCallId: 'sandbox-call',
    toolName: 'bash',
    executionKind: 'process',
    input: { command: 'printf %s "$HOME"; touch "$(echo literal)"' },
    capabilities: ['process.execute', 'filesystem.read'],
    constraints: {
      filesystemReadRoots: ['/srv/workspace'],
      requireSandbox: true,
    },
    deadline: Date.now() + 5_000,
    ...overrides,
  }
}

describe('Linux bwrap argv contract', () => {
  it('constructs all isolation boundaries without a host shell or inherited environment', () => {
    const command = buildLinuxSandboxCommand(request(), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/opt/super-agent/rootfs',
      seccompFd: 3,
      workspaceFd: 4,
      scratchBytes: 64 * 1024 * 1024,
    })

    assert.equal(command.command, '/usr/bin/bwrap')
    for (const flag of [
      '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      '--unshare-net', '--unshare-cgroup', '--die-with-parent', '--new-session',
      '--disable-userns', '--cap-drop', '--clearenv', '--ro-bind', '--proc',
      '--dev', '--size', '--tmpfs', '--ro-bind-fd', '--seccomp',
    ]) assert.equal(command.args.includes(flag), true, `缺少 ${flag}`)
    assert.equal(command.args.includes('--share-net'), false)
    assert.deepEqual(command.env, { PATH: '/usr/bin:/bin', LANG: 'C' })

    const separator = command.args.indexOf('--')
    assert.deepEqual(command.args.slice(separator + 1), [
      '/bin/sh', '-c', 'printf %s "$HOME"; touch "$(echo literal)"',
    ])
    assert.deepEqual(command.args.slice(command.args.indexOf('--ro-bind'), separator)
      .slice(0, 3), ['--ro-bind', '/opt/super-agent/rootfs', '/'])
    const workspaceBind = command.args.indexOf('--ro-bind-fd')
    assert.deepEqual(command.args.slice(workspaceBind, workspaceBind + 3), [
      '--ro-bind-fd', '4', '/workspace',
    ])
    assert.equal(command.args.includes('/srv/workspace'), false)
    assert.equal(command.args.includes('/proc/self/fd/4'), false)
    assert.equal(command.args.includes('--tmp-overlay'), false)
    assert.deepEqual(command.args.slice(command.args.indexOf('--size'), command.args.indexOf('--size') + 4), [
      '--size', String(64 * 1024 * 1024), '--tmpfs', '/tmp',
    ])
    assert.deepEqual(command.args.slice(command.args.indexOf('--seccomp'), separator), [
      '--seccomp', '3',
    ])
  })

  it('rejects malformed process payloads and invalid inherited seccomp descriptors', () => {
    assert.throws(() => buildLinuxSandboxCommand(request({ input: { command: '', extra: true } }), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/rootfs',
      seccompFd: 3,
      workspaceFd: 4,
      scratchBytes: 1024,
    }), /bash sandbox input/)
    assert.throws(() => buildLinuxSandboxCommand(request(), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/rootfs',
      seccompFd: 2,
      workspaceFd: 4,
      scratchBytes: 1024,
    }), /fd >= 3/)
    assert.throws(() => buildLinuxSandboxCommand(request(), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/rootfs',
      seccompFd: 3,
      workspaceFd: 3,
      scratchBytes: 1024,
    }), /workspaceFd/)
  })

  it('supports only one read-only workspace and no network or listener grants', () => {
    const readOnly = {
      filesystemReadRoots: ['/srv/workspace'],
      requireSandbox: true,
    }
    assert.equal(supportsLinuxSandboxConstraints('process', readOnly), true)
    assert.equal(supportsLinuxSandboxConstraints('process', {
      ...readOnly,
      filesystemWriteRoots: ['/srv/workspace'],
    }), false)
    assert.equal(supportsLinuxSandboxConstraints('process', {
      ...readOnly,
      networkHosts: ['example.com'],
    }), false)
    assert.equal(supportsLinuxSandboxConstraints('process', {
      ...readOnly,
      allowLoopbackListen: true,
    }), false)
    assert.equal(supportsLinuxSandboxConstraints('filesystem', readOnly), false)
  })

  it('supports only the capabilities promised by the read-only process lane', () => {
    assert.equal(supportsLinuxSandboxCapabilities(['process.execute', 'filesystem.read']), true)
    for (const unsupported of [
      'filesystem.write',
      'network.egress',
      'external.write',
      'secret.read',
      'user.interaction',
    ] as const) {
      assert.equal(supportsLinuxSandboxCapabilities([
        'process.execute', 'filesystem.read', unsupported,
      ]), false)
    }
    assert.equal(supportsLinuxSandboxCapabilities(['process.execute']), false)
    assert.equal(supportsLinuxSandboxCapabilities(['filesystem.read']), false)
  })

  it('rejects unsupported capabilities before probing or spawning', async () => {
    const executor = new SandboxExecutor({
      bwrapPath: '/missing/bwrap',
      platform: 'linux',
    })
    const result = await executor.execute(request({
      capabilities: ['process.execute', 'filesystem.read', 'filesystem.write'],
    }), { signal: new AbortController().signal })
    assert.deepEqual(result, {
      outcome: 'failed',
      errorCode: 'sandbox_capability_unsupported',
      proof: 'no_side_effect',
    })
  })

  it('requires a recent bwrap with every security-critical flag', () => {
    assert.equal(supportsBwrapVersion('bubblewrap 0.11.1'), false)
    assert.equal(supportsBwrapVersion('bubblewrap 0.11.2'), true)
    assert.equal(supportsBwrapVersion('bwrap 0.12.0'), true)
    assert.equal(supportsBwrapVersion('unknown'), false)
    const complete = '--disable-userns --seccomp --size --unshare-cgroup --ro-bind-fd'
    assert.equal(supportsBwrapFeatures(complete), true)
    assert.equal(supportsBwrapFeatures(complete.replace('--seccomp', '')), false)
    assert.equal(supportsBwrapFeatures(complete.replace('--ro-bind-fd', '')), false)
  })

  it('uses a fixed rootfs helper contract to reject allow-all seccomp profiles', () => {
    assert.equal(SECCOMP_POLICY_PROBE_PATH, '/usr/libexec/super-agent/seccomp-probe')
    assert.equal(seccompPolicyProbeSucceeded({
      terminationReason: 'exited',
      exitCode: 0,
      stdout: `${SECCOMP_POLICY_PROBE_MARKER}\n`,
    }), true)
    assert.equal(seccompPolicyProbeSucceeded({
      terminationReason: 'exited',
      exitCode: 0,
      stdout: 'ptrace unexpectedly succeeded',
    }), false)
    assert.equal(seccompPolicyProbeSucceeded({
      terminationReason: 'exited',
      exitCode: 1,
      stdout: SECCOMP_POLICY_PROBE_MARKER,
    }), false)
  })

  it('enforces explicit upper bounds for the inherited shared cgroup', () => {
    const limits = {
      maxMemoryBytes: 1024 * 1024 * 1024,
      maxPids: 64,
      maxCpuMicrosPerSecond: 1_000_000,
    }
    assert.equal(cgroupValuesWithinLimits('536870912', '32', '50000 100000', limits), true)
    assert.equal(cgroupValuesWithinLimits('1073741825', '32', '50000 100000', limits), false)
    assert.equal(cgroupValuesWithinLimits('536870912', '65', '50000 100000', limits), false)
    assert.equal(cgroupValuesWithinLimits('536870912', '32', '100001 100000', limits), false)
    assert.equal(cgroupValuesWithinLimits('max', '32', '50000 100000', limits), false)
    assert.equal(cgroupValuesWithinLimits('536870912', 'max', '50000 100000', limits), false)
    assert.equal(cgroupValuesWithinLimits('536870912', '32', 'max 100000', limits), false)
  })

  it('serializes processes that inherit the same cgroup and cancels queued work', async () => {
    const gate = new SharedCgroupProcessGate()
    let releaseFirst!: () => void
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })
    const events: string[] = []
    const first = gate.run(new AbortController().signal, async () => {
      events.push('first-start')
      await holdFirst
      events.push('first-end')
    })
    await new Promise((resolve) => setImmediate(resolve))
    const second = gate.run(new AbortController().signal, async () => {
      events.push('second-start')
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(events, ['first-start'])

    const cancelled = new AbortController()
    const third = gate.run(cancelled.signal, async () => {
      events.push('must-not-start')
    })
    cancelled.abort()
    await assert.rejects(third, { name: 'AbortError' })
    releaseFirst()
    await Promise.all([first, second])
    assert.deepEqual(events, ['first-start', 'first-end', 'second-start'])
  })

  it('rejects sensitive files and hardlinks before a read-only workspace bind', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'super-agent-workspace-gate-'))
    try {
      const ordinary = join(workspace, 'ordinary.txt')
      const alias = join(workspace, 'alias.txt')
      await writeFile(ordinary, 'ordinary')
      assert.equal(await verifyReadOnlyWorkspace(workspace), true)
      await link(ordinary, alias)
      assert.equal(await verifyReadOnlyWorkspace(workspace), false)
      await unlink(alias)
      await writeFile(join(workspace, '.env'), 'TOKEN=synthetic')
      assert.equal(await verifyReadOnlyWorkspace(workspace), false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('anchors workspace identity across pathname swaps and closes the parent FD', {
    skip: process.platform === 'linux' ? false : 'requires Linux /proc/self/fd',
  }, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'super-agent-workspace-anchor-'))
    const workspace = join(parent, 'workspace')
    const replacement = join(parent, 'replacement')
    const displaced = join(parent, 'displaced')
    await mkdir(workspace)
    await mkdir(replacement)
    await writeFile(join(workspace, 'marker'), 'original')
    await writeFile(join(replacement, 'marker'), 'replacement')
    let descriptor = -1
    try {
      await withReadOnlyWorkspaceFd(workspace, async (anchor) => {
        descriptor = anchor.descriptor
        assert.equal((await stat(anchor.descriptorPath)).isDirectory(), true)
        await rename(workspace, displaced)
        await rename(replacement, workspace)
        assert.equal(await readFile(join(anchor.descriptorPath, 'marker'), 'utf8'), 'original')
        const command = buildLinuxSandboxCommand(request(), {
          bwrapPath: '/usr/bin/bwrap',
          rootfsPath: '/rootfs',
          seccompFd: 3,
          workspaceFd: 4,
          scratchBytes: 1024,
        })
        assert.deepEqual(command.args.slice(command.args.indexOf('--ro-bind-fd'),
          command.args.indexOf('--ro-bind-fd') + 3), ['--ro-bind-fd', '4', '/workspace'])
      })
      assert.throws(() => fstatSync(descriptor), { code: 'EBADF' })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('scans through the workspace FD and preserves callback error identity', {
    skip: process.platform === 'linux' ? false : 'requires Linux /proc/self/fd',
  }, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'super-agent-workspace-anchor-gate-'))
    const sensitive = join(parent, 'sensitive')
    const hardlinked = join(parent, 'hardlinked')
    const target = join(parent, 'target')
    await mkdir(sensitive)
    await mkdir(hardlinked)
    await mkdir(target)
    await writeFile(join(sensitive, '.env'), 'TOKEN=synthetic')
    await writeFile(join(hardlinked, 'file'), 'ordinary')
    await link(join(hardlinked, 'file'), join(hardlinked, 'alias'))
    const alias = join(parent, 'workspace-link')
    await symlink(target, alias)
    try {
      await assert.rejects(
        withReadOnlyWorkspaceFd(sensitive, async () => undefined),
        WorkspaceAnchorUnavailableError,
      )
      await assert.rejects(
        withReadOnlyWorkspaceFd(hardlinked, async () => undefined),
        WorkspaceAnchorUnavailableError,
      )
      await assert.rejects(
        withReadOnlyWorkspaceFd(alias, async () => undefined),
        WorkspaceAnchorUnavailableError,
      )

      const sentinel = new Error('callback sentinel')
      let descriptor = -1
      await assert.rejects(withReadOnlyWorkspaceFd(target, async (anchor) => {
        descriptor = anchor.descriptor
        throw sentinel
      }), (error) => error === sentinel)
      assert.throws(() => fstatSync(descriptor), { code: 'EBADF' })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('cleans only stale probe directories with the reserved prefix', async () => {
    const stale = await mkdtemp(join(tmpdir(), 'super-agent-sandbox-probe-'))
    const unrelated = await mkdtemp(join(tmpdir(), 'super-agent-unrelated-'))
    try {
      await writeFile(join(stale, 'leftover'), 'probe')
      assert.equal(await cleanupStaleSandboxProbeDirectories(0, Date.now() + 1_000), true)
      await assert.rejects(stat(stale), { code: 'ENOENT' })
      assert.equal((await stat(unrelated)).isDirectory(), true)
    } finally {
      await rm(stale, { recursive: true, force: true })
      await rm(unrelated, { recursive: true, force: true })
    }
  })

  it('closes the owned seccomp descriptor on errors and cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'super-agent-seccomp-fd-test-'))
    const profile = join(directory, 'profile.bpf')
    await writeFile(profile, 'test-profile')
    const digest = createHash('sha256').update('test-profile').digest('hex')
    let errorFd = -1
    let cancelledFd = -1
    try {
      await assert.rejects(withSeccompProfileFd(profile, digest, async (descriptor) => {
        errorFd = descriptor
        assert.equal(readFileSync(descriptor, 'utf8'), 'test-profile')
        throw new Error('probe failed')
      }), /probe failed/)
      assert.throws(() => fstatSync(errorFd), { code: 'EBADF' })

      await assert.rejects(withSeccompProfileFd(profile, digest, async (descriptor) => {
        cancelledFd = descriptor
        throw new DOMException('cancelled', 'AbortError')
      }), { name: 'AbortError' })
      assert.throws(() => fstatSync(cancelledFd), { code: 'EBADF' })

      await assert.rejects(
        withSeccompProfileFd(profile, '0'.repeat(64), async () => undefined),
        SeccompProfileIntegrityError,
      )

      await assert.rejects(
        withSeccompProfileFd(join(directory, 'missing.bpf'), digest, async () => undefined),
        SeccompProfileUnavailableError,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

const linuxIntegration = process.platform === 'linux'
  && process.env.SUPER_AGENT_LINUX_SANDBOX_TEST === '1'

describe('Linux bwrap integration', () => {
  it('probes and executes inside the real configured kernel sandbox', {
    skip: linuxIntegration ? false : 'requires Linux and SUPER_AGENT_LINUX_SANDBOX_TEST=1',
  }, async () => {
    const rootfsPath = process.env.SUPER_AGENT_SANDBOX_ROOTFS
    const seccompProfilePath = process.env.SUPER_AGENT_SANDBOX_SECCOMP_PROFILE
    const seccompProfileSha256 = process.env.SUPER_AGENT_SANDBOX_SECCOMP_SHA256
    const cgroupRoot = process.env.SUPER_AGENT_SANDBOX_CGROUP_ROOT
    assert.ok(rootfsPath && seccompProfilePath && seccompProfileSha256 && cgroupRoot)
    const executor = new SandboxExecutor({
      bwrapPath: process.env.SUPER_AGENT_BWRAP_PATH || '/usr/bin/bwrap',
      rootfsPath,
      seccompProfilePath,
      seccompProfileSha256,
      cgroupRoot,
    })
    assert.deepEqual(await executor.probe(), { available: true })

    const workspace = await mkdtemp(join(tmpdir(), 'super-agent-linux-sandbox-test-'))
    try {
      const result = await executor.execute(request({
        toolName: 'process_probe',
        input: {
          command: '/bin/sh',
          args: ['-c', 'test ! -e /proc/self/fd/4 && printf sandbox-ok'],
        },
        constraints: {
          filesystemReadRoots: [workspace],
          requireSandbox: true,
        },
      }), { signal: new AbortController().signal })
      assert.deepEqual(result, { outcome: 'succeeded', rawOutput: 'sandbox-ok' })
    } finally {
      await executor.close()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
