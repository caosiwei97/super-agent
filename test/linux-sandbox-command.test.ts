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
  WORKSPACE_INSPECT_HELPER_PATH,
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
  WorkspaceAnchorUnavailableError,
  SANDBOX_WORKSPACE_PROBE_CONTENT,
  cleanupStaleSandboxProbeDirectories,
  openFilesLimitWithinBound,
  verifyImmutableRootfs,
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
    toolName: 'workspace_inspect',
    executionKind: 'process',
    input: {
      action: 'search_text',
      path: 'src',
      limit: 20,
      query: '$(touch should-not-run); * | literal',
    },
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
  it('requires a finite launcher RLIMIT_NOFILE hard bound', () => {
    assert.equal(openFilesLimitWithinBound(
      'Max open files            1024                 4096                 files\n',
      4_096,
    ), true)
    assert.equal(openFilesLimitWithinBound(
      'Max open files            1024                 8192                 files\n',
      4_096,
    ), false)
    assert.equal(openFilesLimitWithinBound(
      'Max open files            1024                 unlimited            files\n',
      4_096,
    ), false)
    assert.equal(openFilesLimitWithinBound('malformed', 4_096), false)
  })

  it('propagates cancellation and deadlines through recursive preflight validation', async () => {
    const cancellation = new AbortController()
    const sentinel = new Error('preflight cancelled')
    cancellation.abort(sentinel)
    await assert.rejects(
      verifyReadOnlyWorkspace('/path-must-not-be-read', false, {
        signal: cancellation.signal,
        deadline: Date.now() + 1_000,
      }),
      (error) => error === sentinel,
    )
    await assert.rejects(
      verifyImmutableRootfs('/path-must-not-be-read', {
        signal: new AbortController().signal,
        deadline: Date.now() - 1,
      }),
      { name: 'TimeoutError' },
    )
  })

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
      WORKSPACE_INSPECT_HELPER_PATH,
      'v1',
      'search_text',
      '20',
      'src',
      '$(touch should-not-run); * | literal',
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

  it('adds a paired, non-conflicting info/block handshake for pre-exec cgroup attach', () => {
    const command = buildLinuxSandboxCommand(request(), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/rootfs',
      seccompFd: 3,
      workspaceFd: 4,
      infoFd: 5,
      blockFd: 6,
      scratchBytes: 1024,
    })
    assert.deepEqual(
      command.args.slice(command.args.indexOf('--info-fd'), command.args.indexOf('--seccomp')),
      ['--info-fd', '5', '--block-fd', '6'],
    )
    assert.throws(() => buildLinuxSandboxCommand(request(), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/rootfs',
      seccompFd: 3,
      workspaceFd: 4,
      infoFd: 5,
      scratchBytes: 1024,
    }), /必须同时设置/)
    assert.throws(() => buildLinuxSandboxCommand(request(), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/rootfs',
      seccompFd: 3,
      workspaceFd: 4,
      infoFd: 4,
      blockFd: 6,
      scratchBytes: 1024,
    }), /互不相同/)
  })

  it('rejects malformed process payloads and invalid inherited seccomp descriptors', () => {
    assert.throws(() => buildLinuxSandboxCommand(request({ input: { command: '', extra: true } }), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/rootfs',
      seccompFd: 3,
      workspaceFd: 4,
      scratchBytes: 1024,
    }), /workspace_inspect/)
    assert.throws(() => buildLinuxSandboxCommand(request({
      toolName: 'bash',
      input: { command: 'true' },
    }), {
      bwrapPath: '/usr/bin/bwrap',
      rootfsPath: '/rootfs',
      seccompFd: 3,
      workspaceFd: 4,
      scratchBytes: 1024,
    }), /只允许固定/)
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
    const complete = [
      '--disable-userns',
      '--seccomp',
      '--size',
      '--unshare-cgroup',
      '--ro-bind-fd',
      '--info-fd',
      '--block-fd',
    ].join(' ')
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

  it('cleans only exact stale probe artifacts with their fixed content contract', async () => {
    const stale = await mkdtemp(join(tmpdir(), 'super-agent-sandbox-probe-'))
    const forged = await mkdtemp(join(tmpdir(), 'super-agent-sandbox-probe-'))
    const unrelated = await mkdtemp(join(tmpdir(), 'super-agent-unrelated-'))
    try {
      await writeFile(join(stale, 'probe.txt'), SANDBOX_WORKSPACE_PROBE_CONTENT, { mode: 0o600 })
      await writeFile(join(forged, 'leftover'), 'not an owned probe artifact', { mode: 0o600 })
      assert.equal(await cleanupStaleSandboxProbeDirectories(0, Date.now() + 1_000), true)
      await assert.rejects(stat(stale), { code: 'ENOENT' })
      assert.equal((await stat(forged)).isDirectory(), true)
      assert.equal((await stat(unrelated)).isDirectory(), true)
    } finally {
      await rm(stale, { recursive: true, force: true })
      await rm(forged, { recursive: true, force: true })
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
    const snapshotStagingParent = process.env.SUPER_AGENT_SANDBOX_STAGING_PARENT
    const crashSupervisorMode = process.env.SUPER_AGENT_SANDBOX_CRASH_SUPERVISOR
    assert.ok(rootfsPath && seccompProfilePath && seccompProfileSha256 && cgroupRoot
      && snapshotStagingParent
      && (crashSupervisorMode === 'systemd-control-group-v1'
        || crashSupervisorMode === 'container-control-group-v1'))
    const executor = new SandboxExecutor({
      bwrapPath: process.env.SUPER_AGENT_BWRAP_PATH || '/usr/bin/bwrap',
      rootfsPath,
      seccompProfilePath,
      seccompProfileSha256,
      cgroupRoot,
      snapshotStagingParent,
      crashSupervisorMode: crashSupervisorMode as
        | 'systemd-control-group-v1'
        | 'container-control-group-v1'
        | undefined,
    })
    assert.deepEqual(await executor.probe(), { available: true })

    const workspace = await mkdtemp(join(tmpdir(), 'super-agent-linux-sandbox-test-'))
    try {
      await writeFile(join(workspace, 'marker.txt'), 'sandbox-ok\n')
      const result = await executor.execute(request({
        input: {
          action: 'read_text',
          path: 'marker.txt',
          limit: 1,
        },
        constraints: {
          filesystemReadRoots: [workspace],
          requireSandbox: true,
        },
      }), { signal: new AbortController().signal })
      assert.deepEqual(result, { outcome: 'succeeded', rawOutput: 'sandbox-ok\n' })
    } finally {
      await executor.close()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
