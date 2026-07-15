import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import {
  assertSerializableExecutionRequest,
  type ExecutionControl,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ExecutorProbeResult,
  type ToolExecutionKind,
} from './executor.js'
import {
  buildLinuxSandboxCommand,
  supportsBwrapFeatures,
  supportsBwrapVersion,
} from './linux-sandbox-command.js'
import {
  type CgroupResourceLimits,
  SharedCgroupProcessGate,
  WorkspaceAnchorUnavailableError,
  canonicalTrustedPath,
  cleanupStaleSandboxProbeDirectories,
  verifyBoundedCgroupV2,
  verifyImmutableRootfs,
  withReadOnlyWorkspaceFd,
} from './linux-sandbox-prerequisites.js'
import {
  SeccompProfileIntegrityError,
  SeccompProfileUnavailableError,
  withSeccompProfileFd,
} from './linux-sandbox-seccomp.js'
import { ProcessController } from './process-controller.js'
import type { ExecutionConstraints, ToolCapability } from '../security/capabilities.js'

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_WALL_TIME_MS = 10_000
const DEFAULT_SCRATCH_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_CGROUP_MEMORY_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_CGROUP_PIDS = 64
const DEFAULT_MAX_CGROUP_CPU_MICROS_PER_SECOND = 1_000_000
const CHILD_SECCOMP_FD = 3
const CHILD_WORKSPACE_FD = 4
export const SECCOMP_POLICY_PROBE_PATH = '/usr/libexec/super-agent/seccomp-probe'
export const SECCOMP_POLICY_PROBE_MARKER = 'super-agent-seccomp-policy-ok'

export function seccompPolicyProbeSucceeded(result: {
  readonly terminationReason: string
  readonly exitCode: number | null
  readonly stdout: string
}) {
  return result.terminationReason === 'exited'
    && result.exitCode === 0
    && result.stdout.trim() === SECCOMP_POLICY_PROBE_MARKER
}

// All SandboxExecutor instances inherit the same agent cgroup. Keep probes and
// target processes globally serialized until per-operation cgroups exist.
const SHARED_CGROUP_PROCESS_GATE = new SharedCgroupProcessGate()

export interface SandboxExecutorOptions {
  readonly bwrapPath: string
  readonly rootfsPath?: string
  readonly seccompProfilePath?: string
  readonly seccompProfileSha256?: string
  readonly cgroupRoot?: string
  readonly maxCgroupMemoryBytes?: number
  readonly maxCgroupPids?: number
  readonly maxCgroupCpuMicrosPerSecond?: number
  readonly maxOutputBytes?: number
  readonly wallTimeMs?: number
  readonly scratchBytes?: number
  /** Test seam only. Production construction must omit it. */
  readonly platform?: NodeJS.Platform
}

export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError'

  constructor(readonly reasonCode: string) {
    super(`production sandbox 不可用: ${reasonCode}`)
  }
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function unavailable(reasonCode: string): ExecutorProbeResult {
  return Object.freeze({ available: false, reasonCode })
}

function positiveSafeInteger(value: number | undefined, fallback: number, field: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${field} 必须是正安全整数`)
  return result
}

function workspaceRoot(constraints: ExecutionConstraints) {
  const readRoots = constraints.filesystemReadRoots
  const writeRoots = constraints.filesystemWriteRoots
  if (readRoots?.length !== 1 || (writeRoots?.length ?? 0) !== 0) return undefined
  return readRoots[0]
}

export function supportsLinuxSandboxConstraints(
  kind: ToolExecutionKind,
  constraints: ExecutionConstraints,
) {
  if (kind !== 'process' || constraints.requireSandbox !== true || !workspaceRoot(constraints)) {
    return false
  }
  if (constraints.allowLoopbackListen === true || (constraints.loopbackListenPorts?.length ?? 0) > 0) {
    return false
  }
  // The first production process lane is offline. Any requested network grant
  // requires a future broker and cannot silently become host networking.
  return (constraints.networkSchemes?.length ?? 0) === 0
    && (constraints.networkHosts?.length ?? 0) === 0
    && (constraints.networkPorts?.length ?? 0) === 0
}

const READ_ONLY_PROCESS_CAPABILITIES = new Set<ToolCapability>([
  'process.execute',
  'filesystem.read',
])

export function supportsLinuxSandboxCapabilities(capabilities: readonly ToolCapability[]) {
  return capabilities.includes('process.execute')
    && capabilities.includes('filesystem.read')
    && capabilities.every((capability) => READ_ONLY_PROCESS_CAPABILITIES.has(capability))
}

function sameOrAncestor(parent: string, child: string) {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

interface TrustedSandboxPaths {
  readonly bwrap: string
  readonly rootfs: string
  readonly seccomp: string
  readonly cgroup: string
  readonly identities: Readonly<Record<'bwrap' | 'rootfs' | 'seccomp' | 'cgroup', string>>
}

async function pathIdentity(path: string) {
  const metadata = await stat(path)
  return `${metadata.dev}:${metadata.ino}`
}

function safeWorkspaceRoot(workspace: string, paths: TrustedSandboxPaths) {
  if (['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/proc', '/root',
    '/run', '/sbin', '/sys', '/usr', '/var'].includes(workspace)) return false
  return [paths.bwrap, paths.rootfs, paths.seccomp, paths.cgroup]
    .every((protectedPath) => !sameOrAncestor(workspace, protectedPath))
}

export class SandboxExecutor implements Executor {
  readonly kind = 'sandbox' as const
  private readonly platform: NodeJS.Platform
  private readonly maxOutputBytes: number
  private readonly wallTimeMs: number
  private readonly scratchBytes: number
  private readonly cgroupLimits: CgroupResourceLimits
  private readonly processes = new ProcessController()
  private probePromise?: Promise<ExecutorProbeResult>
  private available = false
  private trustedPaths?: TrustedSandboxPaths

  constructor(private readonly options: SandboxExecutorOptions) {
    this.platform = options.platform ?? process.platform
    this.maxOutputBytes = positiveSafeInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    )
    this.wallTimeMs = positiveSafeInteger(options.wallTimeMs, DEFAULT_WALL_TIME_MS, 'wallTimeMs')
    this.scratchBytes = positiveSafeInteger(
      options.scratchBytes,
      DEFAULT_SCRATCH_BYTES,
      'scratchBytes',
    )
    this.cgroupLimits = Object.freeze({
      maxMemoryBytes: positiveSafeInteger(
        options.maxCgroupMemoryBytes,
        DEFAULT_MAX_CGROUP_MEMORY_BYTES,
        'maxCgroupMemoryBytes',
      ),
      maxPids: positiveSafeInteger(
        options.maxCgroupPids,
        DEFAULT_MAX_CGROUP_PIDS,
        'maxCgroupPids',
      ),
      maxCpuMicrosPerSecond: positiveSafeInteger(
        options.maxCgroupCpuMicrosPerSecond,
        DEFAULT_MAX_CGROUP_CPU_MICROS_PER_SECOND,
        'maxCgroupCpuMicrosPerSecond',
      ),
    })
    if (options.seccompProfileSha256 !== undefined
      && !/^[a-f0-9]{64}$/.test(options.seccompProfileSha256)) {
      throw new TypeError('seccompProfileSha256 必须是 64 位小写十六进制 SHA-256')
    }
    if (!isAbsolute(options.bwrapPath)) {
      throw new TypeError('bwrapPath 必须是可信绝对路径')
    }
    for (const [field, value] of Object.entries({
      rootfsPath: options.rootfsPath,
      seccompProfilePath: options.seccompProfilePath,
      cgroupRoot: options.cgroupRoot,
    })) {
      if (value !== undefined && !isAbsolute(value)) {
        throw new TypeError(`${field} 必须是绝对路径`)
      }
    }
  }

  probe(): Promise<ExecutorProbeResult> {
    this.probePromise ??= SHARED_CGROUP_PROCESS_GATE.run(
      new AbortController().signal,
      () => this.probeOnce(),
    )
    return this.probePromise
  }

  private async probeOnce(): Promise<ExecutorProbeResult> {
    if (this.platform !== 'linux') return unavailable('sandbox_platform_unsupported')
    if (!await cleanupStaleSandboxProbeDirectories()) {
      return unavailable('sandbox_probe_cleanup_failed')
    }
    const { rootfsPath, seccompProfilePath, seccompProfileSha256, cgroupRoot } = this.options
    if (!rootfsPath || !seccompProfilePath || !seccompProfileSha256 || !cgroupRoot) {
      return unavailable('sandbox_configuration_incomplete')
    }
    const canonicalBwrap = await canonicalTrustedPath(this.options.bwrapPath, 'file', true)
    if (!canonicalBwrap) {
      return unavailable('sandbox_bwrap_unavailable_or_untrusted')
    }
    if (!await this.verifyBwrapFeatures(canonicalBwrap)) {
      return unavailable('sandbox_bwrap_version_or_features_unsupported')
    }
    const canonicalRootfs = await canonicalTrustedPath(rootfsPath, 'directory')
    if (!canonicalRootfs || !await verifyImmutableRootfs(canonicalRootfs)) {
      return unavailable('sandbox_rootfs_unavailable_or_untrusted')
    }
    const canonicalSeccomp = await canonicalTrustedPath(seccompProfilePath, 'file')
    if (!canonicalSeccomp) {
      return unavailable('sandbox_seccomp_unavailable_or_untrusted')
    }
    const canonicalCgroup = await realpath(cgroupRoot).catch(() => undefined)
    if (!canonicalCgroup || !await isDirectory(canonicalCgroup)
      || !await verifyBoundedCgroupV2(canonicalCgroup, this.cgroupLimits)) {
      return unavailable('sandbox_cgroup_unavailable_or_unbounded')
    }
    const trustedPaths = Object.freeze({
      bwrap: canonicalBwrap,
      rootfs: canonicalRootfs,
      seccomp: canonicalSeccomp,
      cgroup: canonicalCgroup,
      identities: Object.freeze({
        bwrap: await pathIdentity(canonicalBwrap),
        rootfs: await pathIdentity(canonicalRootfs),
        seccomp: await pathIdentity(canonicalSeccomp),
        cgroup: await pathIdentity(canonicalCgroup),
      }),
    })

    const workspace = await mkdtemp(join(tmpdir(), 'super-agent-sandbox-probe-'))
    try {
      const probeRequest = (input: ExecutionRequest['input']): ExecutionRequest => ({
        schemaVersion: 1,
        operationId: 'sandbox-probe',
        attemptId: 'sandbox-probe',
        toolCallId: 'sandbox-probe',
        toolName: 'sandbox-probe',
        executionKind: 'process',
        input,
        capabilities: ['process.execute'],
        constraints: {
          filesystemReadRoots: [workspace],
          requireSandbox: true,
        },
        deadline: Date.now() + Math.min(this.wallTimeMs, 5_000),
      })
      const runProbe = async (request: ExecutionRequest) => {
        return withReadOnlyWorkspaceFd(workspace, async (anchoredWorkspace) => {
          return withSeccompProfileFd(canonicalSeccomp, seccompProfileSha256, async (profileFd) => {
            const invocation = buildLinuxSandboxCommand(request, {
              bwrapPath: canonicalBwrap,
              rootfsPath: canonicalRootfs,
              seccompFd: CHILD_SECCOMP_FD,
              workspaceFd: CHILD_WORKSPACE_FD,
              scratchBytes: this.scratchBytes,
            })
            return this.processes.execute({
              ...invocation,
              deadline: request.deadline,
              maxOutputBytes: 16 * 1024,
              extraFileDescriptors: [profileFd, anchoredWorkspace.descriptor],
            })
          })
        })
      }

      // Fixed immutable rootfs fixture: it must attempt the curated forbidden
      // syscall in a child and print the marker only for EPERM or SIGSYS.
      const policyResult = await runProbe(probeRequest({ command: SECCOMP_POLICY_PROBE_PATH }))
      if (!seccompPolicyProbeSucceeded(policyResult)) {
        return unavailable('sandbox_seccomp_policy_probe_failed')
      }

      const boundaryResult = await runProbe(probeRequest({
        command: '/bin/sh',
        args: [
          '-c',
          "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status && grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status && test ! -e /proc/self/fd/4",
        ],
      }))
      if (boundaryResult.terminationReason !== 'exited' || boundaryResult.exitCode !== 0) {
        return unavailable('sandbox_functional_probe_failed')
      }
      this.trustedPaths = trustedPaths
      this.available = true
      return Object.freeze({ available: true })
    } catch (error) {
      if (error instanceof SeccompProfileIntegrityError) {
        return unavailable('sandbox_seccomp_digest_mismatch')
      }
      if (error instanceof SeccompProfileUnavailableError) {
        return unavailable('sandbox_seccomp_unavailable')
      }
      return unavailable('sandbox_functional_probe_failed')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  supports(
    kind: ToolExecutionKind,
    constraints: ExecutionConstraints,
    capabilities?: readonly ToolCapability[],
  ) {
    return this.available
      && supportsLinuxSandboxConstraints(kind, constraints)
      && (capabilities === undefined || supportsLinuxSandboxCapabilities(capabilities))
  }

  async execute(request: ExecutionRequest, control: ExecutionControl): Promise<ExecutionResult> {
    assertSerializableExecutionRequest(request)
    if (!supportsLinuxSandboxCapabilities(request.capabilities)) {
      return Object.freeze({
        outcome: 'failed', errorCode: 'sandbox_capability_unsupported', proof: 'no_side_effect',
      })
    }
    if (control.signal.aborted || Date.now() >= request.deadline) {
      return Object.freeze({
        outcome: 'failed',
        errorCode: control.signal.aborted ? 'sandbox_aborted' : 'sandbox_timeout',
        proof: 'no_side_effect',
      })
    }
    const probe = await this.probe()
    if (!probe.available || !this.supports(
      request.executionKind,
      request.constraints,
      request.capabilities,
    )) {
      return Object.freeze({
        outcome: 'failed',
        errorCode: probe.reasonCode || 'sandbox_constraint_unsupported',
        proof: 'no_side_effect',
      })
    }
    let enteredSharedCgroup = false
    try {
      return await SHARED_CGROUP_PROCESS_GATE.run(control.signal, async () => {
        enteredSharedCgroup = true
        return this.executeExclusive(request, control)
      })
    } catch {
      if (!enteredSharedCgroup) {
        return Object.freeze({
          outcome: 'failed', errorCode: 'sandbox_aborted', proof: 'no_side_effect',
        })
      }
      return Object.freeze({ outcome: 'uncertain', errorCode: 'sandbox_execution_error' })
    }
  }

  private async executeExclusive(
    request: ExecutionRequest,
    control: ExecutionControl,
  ): Promise<ExecutionResult> {
    if (!this.supports(
      request.executionKind,
      request.constraints,
      request.capabilities,
    )) {
      return Object.freeze({
        outcome: 'failed',
        errorCode: 'sandbox_constraint_unsupported',
        proof: 'no_side_effect',
      })
    }
    if (control.signal.aborted || Date.now() >= request.deadline) {
      return Object.freeze({
        outcome: 'failed',
        errorCode: control.signal.aborted ? 'sandbox_aborted' : 'sandbox_timeout',
        proof: 'no_side_effect',
      })
    }

    const configuredRoot = workspaceRoot(request.constraints)
    if (!configuredRoot || !this.trustedPaths) {
      return Object.freeze({
        outcome: 'failed', errorCode: 'sandbox_constraint_unsupported', proof: 'no_side_effect',
      })
    }
    if (!safeWorkspaceRoot(configuredRoot, this.trustedPaths)) {
      return Object.freeze({
        outcome: 'failed', errorCode: 'sandbox_workspace_unavailable', proof: 'no_side_effect',
      })
    }

    try {
      if (!await this.runtimePrerequisitesStillValid()) throw new Error('sandbox prerequisites changed')
    } catch {
      return Object.freeze({
        outcome: 'failed', errorCode: 'sandbox_prerequisite_changed', proof: 'no_side_effect',
      })
    }

    try {
      return await withReadOnlyWorkspaceFd(configuredRoot, async (workspace) => {
        if (!safeWorkspaceRoot(workspace.canonicalPath, this.trustedPaths!)) {
          return Object.freeze({
            outcome: 'failed', errorCode: 'sandbox_workspace_unavailable', proof: 'no_side_effect',
          })
        }
        let invocation
        try {
          invocation = buildLinuxSandboxCommand(request, {
            bwrapPath: this.trustedPaths!.bwrap,
            rootfsPath: this.trustedPaths!.rootfs,
            seccompFd: CHILD_SECCOMP_FD,
            workspaceFd: CHILD_WORKSPACE_FD,
            scratchBytes: this.scratchBytes,
          })
        } catch {
          return Object.freeze({
            outcome: 'failed', errorCode: 'sandbox_process_input_invalid', proof: 'no_side_effect',
          })
        }
        return withSeccompProfileFd(
          this.trustedPaths!.seccomp,
          this.options.seccompProfileSha256!,
          async (profileFd) => {
            const result = await this.processes.execute({
              ...invocation,
              signal: control.signal,
              deadline: request.deadline,
              timeoutMs: this.wallTimeMs,
              maxOutputBytes: this.maxOutputBytes,
              extraFileDescriptors: [profileFd, workspace.descriptor],
            })
            if (result.terminationReason === 'spawn_error') {
              return Object.freeze({
                outcome: 'failed', errorCode: 'sandbox_spawn_error', proof: 'no_side_effect',
              })
            }
            if (result.terminationReason !== 'exited' || result.exitCode !== 0) {
              if (result.pid === undefined) {
                return Object.freeze({
                  outcome: 'failed',
                  errorCode: `sandbox_${result.terminationReason}`,
                  proof: 'no_side_effect',
                })
              }
              return Object.freeze({
                outcome: 'uncertain',
                errorCode: result.terminationReason === 'exited'
                  ? 'sandbox_nonzero_exit'
                  : `sandbox_${result.terminationReason}`,
              })
            }
            return Object.freeze({
              outcome: 'succeeded',
              rawOutput: result.stdout || result.stderr || '(命令执行成功，无输出)',
            })
          },
        )
      })
    } catch (error) {
      if (error instanceof WorkspaceAnchorUnavailableError) {
        return Object.freeze({
          outcome: 'failed', errorCode: 'sandbox_workspace_unavailable', proof: 'no_side_effect',
        })
      }
      if (error instanceof SeccompProfileIntegrityError) {
        return Object.freeze({
          outcome: 'failed', errorCode: 'sandbox_seccomp_digest_mismatch', proof: 'no_side_effect',
        })
      }
      if (error instanceof SeccompProfileUnavailableError) {
        return Object.freeze({
          outcome: 'failed', errorCode: 'sandbox_seccomp_unavailable', proof: 'no_side_effect',
        })
      }
      return Object.freeze({ outcome: 'uncertain', errorCode: 'sandbox_execution_error' })
    }
  }

  async close() {}

  private async verifyBwrapFeatures(bwrapPath: string) {
    const environment = { PATH: '/usr/bin:/bin', LANG: 'C' }
    const version = await this.processes.execute({
      command: bwrapPath,
      args: ['--version'],
      env: environment,
      timeoutMs: 2_000,
      maxOutputBytes: 16 * 1024,
    })
    if (version.terminationReason !== 'exited' || version.exitCode !== 0) return false
    if (!supportsBwrapVersion(`${version.stdout}\n${version.stderr}`)) return false

    const help = await this.processes.execute({
      command: bwrapPath,
      args: ['--help'],
      env: environment,
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1024,
    })
    if (help.terminationReason !== 'exited' || help.exitCode !== 0) return false
    return supportsBwrapFeatures(`${help.stdout}\n${help.stderr}`)
  }

  private async runtimePrerequisitesStillValid() {
    const trusted = this.trustedPaths
    const { rootfsPath, seccompProfilePath, seccompProfileSha256, cgroupRoot } = this.options
    if (!trusted || !rootfsPath || !seccompProfilePath || !seccompProfileSha256 || !cgroupRoot) {
      return false
    }
    const [bwrap, rootfs, seccomp, cgroup] = await Promise.all([
      canonicalTrustedPath(this.options.bwrapPath, 'file', true),
      canonicalTrustedPath(rootfsPath, 'directory'),
      canonicalTrustedPath(seccompProfilePath, 'file'),
      realpath(cgroupRoot).catch(() => undefined),
    ])
    if (!bwrap || !rootfs || !seccomp || !cgroup) return false
    const identities = await Promise.all([
      pathIdentity(bwrap),
      pathIdentity(rootfs),
      pathIdentity(seccomp),
      pathIdentity(cgroup),
    ]).catch(() => undefined)
    if (!identities) return false
    return bwrap === trusted.bwrap
      && rootfs === trusted.rootfs
      && seccomp === trusted.seccomp
      && cgroup === trusted.cgroup
      && identities[0] === trusted.identities.bwrap
      && identities[1] === trusted.identities.rootfs
      && identities[2] === trusted.identities.seccomp
      && identities[3] === trusted.identities.cgroup
      && await verifyImmutableRootfs(trusted.rootfs)
      && await verifyBoundedCgroupV2(trusted.cgroup, this.cgroupLimits)
  }
}
