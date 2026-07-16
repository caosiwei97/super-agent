import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { Readable } from 'node:stream'
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
  type LinuxSandboxCommand,
} from './linux-sandbox-command.js'
import {
  WorkspaceAnchorUnavailableError,
  canonicalTrustedPath,
  cleanupStaleSandboxProbeDirectories,
  SANDBOX_WORKSPACE_PROBE_CONTENT,
  verifyImmutableRootfs,
  verifyBoundedOpenFilesLimit,
  withReadOnlyWorkspaceFd,
  type SandboxPreflightControl,
} from './linux-sandbox-prerequisites.js'
import {
  LinuxCgroupManager,
  LinuxCgroupUnavailableError,
  type LinuxCgroupLimits,
} from './linux-cgroup.js'
import {
  assertBlockedSandboxChildIdentity,
  readBlockedSandboxChildIdentity,
  SandboxHandshakeError,
  readBlockedSandboxChildPid,
} from './linux-sandbox-handshake.js'
import {
  cleanupStaleSelfHeldBlockDirectories,
  releaseSelfHeldBlockFd,
  withSelfHeldBlockFd,
} from './linux-self-held-block.js'
import {
  SeccompProfileIntegrityError,
  SeccompProfileUnavailableError,
  withSeccompProfileFd,
} from './linux-sandbox-seccomp.js'
import {
  WorkspaceSnapshotError,
  cleanupStaleWorkspaceSnapshots,
  type WorkspaceSnapshotLimits,
  withWorkspaceSnapshot,
} from './workspace-snapshot.js'
import { ProcessController } from './process-controller.js'
import type { ExecutionConstraints, ToolCapability } from '../security/capabilities.js'

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_WALL_TIME_MS = 10_000
const DEFAULT_SCRATCH_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_CGROUP_MEMORY_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_CGROUP_SWAP_BYTES = 0
const DEFAULT_MAX_CGROUP_PIDS = 64
const DEFAULT_MAX_CGROUP_CPU_MICROS_PER_SECOND = 1_000_000
const DEFAULT_MAX_OPEN_FILES = 4_096
const DEFAULT_SNAPSHOT_MAX_FILES = 10_000
const DEFAULT_SNAPSHOT_MAX_ENTRIES = 20_000
const DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const DEFAULT_SNAPSHOT_MAX_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_SNAPSHOT_MAX_DEPTH = 64
const CHILD_SECCOMP_FD = 3
const CHILD_WORKSPACE_FD = 4
const CHILD_INFO_FD = 5
const CHILD_BLOCK_FD = 6
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

export interface SandboxExecutorOptions {
  readonly bwrapPath: string
  readonly mkfifoPath?: string
  readonly rootfsPath?: string
  readonly seccompProfilePath?: string
  readonly seccompProfileSha256?: string
  readonly cgroupRoot?: string
  readonly crashSupervisorMode?: 'systemd-control-group-v1' | 'container-control-group-v1'
  readonly maxCgroupMemoryBytes?: number
  readonly maxCgroupSwapBytes?: number
  readonly maxCgroupPids?: number
  readonly maxCgroupCpuMicrosPerSecond?: number
  readonly maxOpenFiles?: number
  readonly snapshotStagingParent?: string
  readonly snapshotMaxFiles?: number
  readonly snapshotMaxEntries?: number
  readonly snapshotMaxTotalBytes?: number
  readonly snapshotMaxFileBytes?: number
  readonly snapshotMaxDepth?: number
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

function nonNegativeSafeInteger(value: number | undefined, fallback: number, field: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${field} 必须是非负安全整数`)
  }
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
  readonly mkfifo: string
  readonly rootfs: string
  readonly seccomp: string
  readonly cgroup: string
  readonly identities: Readonly<Record<'bwrap' | 'mkfifo' | 'rootfs' | 'seccomp' | 'cgroup', string>>
}

async function pathIdentity(path: string) {
  const metadata = await stat(path)
  return `${metadata.dev}:${metadata.ino}`
}

function safeWorkspaceRoot(workspace: string, paths: TrustedSandboxPaths) {
  if (['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/proc', '/root',
    '/run', '/sbin', '/sys', '/usr', '/var'].includes(workspace)) return false
  return [paths.bwrap, paths.mkfifo, paths.rootfs, paths.seccomp, paths.cgroup]
    .every((protectedPath) => !sameOrAncestor(workspace, protectedPath))
}

export class SandboxExecutor implements Executor {
  readonly kind = 'sandbox' as const
  private readonly platform: NodeJS.Platform
  private readonly maxOutputBytes: number
  private readonly wallTimeMs: number
  private readonly scratchBytes: number
  private readonly cgroupLimits: LinuxCgroupLimits
  private readonly maxOpenFiles: number
  private readonly snapshotLimits: WorkspaceSnapshotLimits
  private readonly processes = new ProcessController()
  private probePromise?: Promise<ExecutorProbeResult>
  private available = false
  private trustedPaths?: TrustedSandboxPaths
  private cgroupManager?: LinuxCgroupManager

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
      maxSwapBytes: nonNegativeSafeInteger(
        options.maxCgroupSwapBytes,
        DEFAULT_MAX_CGROUP_SWAP_BYTES,
        'maxCgroupSwapBytes',
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
    this.maxOpenFiles = positiveSafeInteger(
      options.maxOpenFiles,
      DEFAULT_MAX_OPEN_FILES,
      'maxOpenFiles',
    )
    this.snapshotLimits = Object.freeze({
      maxFiles: positiveSafeInteger(
        options.snapshotMaxFiles,
        DEFAULT_SNAPSHOT_MAX_FILES,
        'snapshotMaxFiles',
      ),
      maxEntries: positiveSafeInteger(
        options.snapshotMaxEntries,
        DEFAULT_SNAPSHOT_MAX_ENTRIES,
        'snapshotMaxEntries',
      ),
      maxTotalBytes: positiveSafeInteger(
        options.snapshotMaxTotalBytes,
        DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES,
        'snapshotMaxTotalBytes',
      ),
      maxFileBytes: positiveSafeInteger(
        options.snapshotMaxFileBytes,
        DEFAULT_SNAPSHOT_MAX_FILE_BYTES,
        'snapshotMaxFileBytes',
      ),
      maxDepth: nonNegativeSafeInteger(
        options.snapshotMaxDepth,
        DEFAULT_SNAPSHOT_MAX_DEPTH,
        'snapshotMaxDepth',
      ),
    })
    if (this.snapshotLimits.maxFileBytes > this.snapshotLimits.maxTotalBytes) {
      throw new TypeError('snapshotMaxFileBytes 不能超过 snapshotMaxTotalBytes')
    }
    if (options.seccompProfileSha256 !== undefined
      && !/^[a-f0-9]{64}$/.test(options.seccompProfileSha256)) {
      throw new TypeError('seccompProfileSha256 必须是 64 位小写十六进制 SHA-256')
    }
    if (options.crashSupervisorMode !== undefined
      && options.crashSupervisorMode !== 'systemd-control-group-v1'
      && options.crashSupervisorMode !== 'container-control-group-v1') {
      throw new TypeError('crashSupervisorMode 不符合可信 launcher 契约')
    }
    if (!isAbsolute(options.bwrapPath)) {
      throw new TypeError('bwrapPath 必须是可信绝对路径')
    }
    if (options.mkfifoPath !== undefined && !isAbsolute(options.mkfifoPath)) {
      throw new TypeError('mkfifoPath 必须是可信绝对路径')
    }
    for (const [field, value] of Object.entries({
      rootfsPath: options.rootfsPath,
      seccompProfilePath: options.seccompProfilePath,
      cgroupRoot: options.cgroupRoot,
      snapshotStagingParent: options.snapshotStagingParent,
    })) {
      if (value !== undefined && !isAbsolute(value)) {
        throw new TypeError(`${field} 必须是绝对路径`)
      }
    }
  }

  probe(): Promise<ExecutorProbeResult> {
    this.probePromise ??= this.probeOnce()
    return this.probePromise
  }

  private async probeOnce(): Promise<ExecutorProbeResult> {
    if (this.platform !== 'linux') return unavailable('sandbox_platform_unsupported')
    const {
      rootfsPath,
      seccompProfilePath,
      seccompProfileSha256,
      cgroupRoot,
      snapshotStagingParent,
    } = this.options
    if (!rootfsPath || !seccompProfilePath || !seccompProfileSha256
      || !cgroupRoot || !snapshotStagingParent) {
      return unavailable('sandbox_configuration_incomplete')
    }
    const cleanupControl = {
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    }
    let workspaceCleanupSucceeded = true
    try {
      const minimumAgeMs = Math.max(60 * 60 * 1_000, this.wallTimeMs * 10)
      await cleanupStaleWorkspaceSnapshots({
        control: cleanupControl,
        stagingParent: snapshotStagingParent,
        limits: this.snapshotLimits,
        minimumAgeMs,
      })
      await cleanupStaleSelfHeldBlockDirectories(minimumAgeMs)
    } catch {
      workspaceCleanupSucceeded = false
    }
    if (!await cleanupStaleSandboxProbeDirectories() || !workspaceCleanupSucceeded) {
      return unavailable('sandbox_probe_cleanup_failed')
    }
    if (!this.options.crashSupervisorMode) {
      return unavailable('sandbox_crash_supervisor_unconfigured')
    }
    if (!await verifyBoundedOpenFilesLimit(this.maxOpenFiles)) {
      return unavailable('sandbox_open_files_limit_unbounded')
    }
    const canonicalBwrap = await canonicalTrustedPath(this.options.bwrapPath, 'file', true)
    if (!canonicalBwrap) {
      return unavailable('sandbox_bwrap_unavailable_or_untrusted')
    }
    if (!await this.verifyBwrapFeatures(canonicalBwrap)) {
      return unavailable('sandbox_bwrap_version_or_features_unsupported')
    }
    const canonicalMkfifo = await canonicalTrustedPath(
      this.options.mkfifoPath ?? '/usr/bin/mkfifo',
      'file',
      true,
    )
    if (!canonicalMkfifo) return unavailable('sandbox_mkfifo_unavailable_or_untrusted')
    const canonicalRootfs = await canonicalTrustedPath(rootfsPath, 'directory')
    if (!canonicalRootfs || !await verifyImmutableRootfs(canonicalRootfs)) {
      return unavailable('sandbox_rootfs_unavailable_or_untrusted')
    }
    const canonicalSeccomp = await canonicalTrustedPath(seccompProfilePath, 'file')
    if (!canonicalSeccomp) {
      return unavailable('sandbox_seccomp_unavailable_or_untrusted')
    }
    const canonicalCgroup = await realpath(cgroupRoot).catch(() => undefined)
    if (!canonicalCgroup || !await isDirectory(canonicalCgroup)) {
      return unavailable('sandbox_cgroup_unavailable_or_unbounded')
    }
    let cgroupManager: LinuxCgroupManager
    try {
      cgroupManager = await LinuxCgroupManager.initialize({
        root: canonicalCgroup,
        limits: this.cgroupLimits,
        platform: this.platform,
      })
    } catch (error) {
      if (error instanceof LinuxCgroupUnavailableError) {
        return unavailable(`sandbox_cgroup_${error.reasonCode}`)
      }
      return unavailable('sandbox_cgroup_unavailable_or_unbounded')
    }
    let trustedPaths: TrustedSandboxPaths
    try {
      trustedPaths = Object.freeze({
        bwrap: canonicalBwrap,
        mkfifo: canonicalMkfifo,
        rootfs: canonicalRootfs,
        seccomp: canonicalSeccomp,
        cgroup: canonicalCgroup,
        identities: Object.freeze({
          bwrap: await pathIdentity(canonicalBwrap),
          mkfifo: await pathIdentity(canonicalMkfifo),
          rootfs: await pathIdentity(canonicalRootfs),
          seccomp: await pathIdentity(canonicalSeccomp),
          cgroup: await pathIdentity(canonicalCgroup),
        }),
      })
    } catch {
      await cgroupManager.close().catch(() => undefined)
      return unavailable('sandbox_prerequisite_identity_unavailable')
    }

    const workspace = await mkdtemp(join(tmpdir(), 'super-agent-sandbox-probe-'))
    let retainCgroupManager = false
    try {
      const probeRequest = (
        toolName: 'sandbox-probe' | 'workspace_inspect',
        input: ExecutionRequest['input'],
      ): ExecutionRequest => ({
        schemaVersion: 1,
        operationId: `sandbox-probe-${toolName}`,
        attemptId: `sandbox-probe-${toolName}`,
        toolCallId: `sandbox-probe-${toolName}`,
        toolName,
        executionKind: 'process',
        input,
        capabilities: toolName === 'workspace_inspect'
          ? ['process.execute', 'filesystem.read']
          : ['process.execute'],
        constraints: {
          filesystemReadRoots: [workspace],
          requireSandbox: true,
        },
        deadline: Date.now() + Math.min(this.wallTimeMs, 5_000),
      })
      const runProbe = async (request: ExecutionRequest) => {
        const control = { signal: new AbortController().signal }
        return withReadOnlyWorkspaceFd(workspace, async (anchoredWorkspace) => {
          return withWorkspaceSnapshot({
            readPath: anchoredWorkspace.descriptorPath,
            canonicalPath: anchoredWorkspace.canonicalPath,
            expectedIdentity: anchoredWorkspace.identity,
            rootKind: 'linux-proc-fd',
          }, {
            limits: this.snapshotLimits,
            control: { signal: control.signal, deadline: request.deadline },
            stagingParent: this.options.snapshotStagingParent,
          }, async (snapshot) => {
            return withSeccompProfileFd(canonicalSeccomp, seccompProfileSha256, async (profileFd) => {
              const invocation = buildLinuxSandboxCommand(request, {
                bwrapPath: canonicalBwrap,
                rootfsPath: canonicalRootfs,
                seccompFd: CHILD_SECCOMP_FD,
                workspaceFd: CHILD_WORKSPACE_FD,
                infoFd: CHILD_INFO_FD,
                blockFd: CHILD_BLOCK_FD,
                scratchBytes: this.scratchBytes,
              })
              return this.runIsolatedProcess(
                request,
                control,
                cgroupManager,
                invocation,
                profileFd,
                snapshot.descriptor,
                16 * 1024,
                trustedPaths.identities.bwrap,
                trustedPaths.mkfifo,
              )
            })
          })
        })
      }

      // Fixed immutable rootfs fixture: it must attempt the curated forbidden
      // syscall in a child and print the marker only for EPERM or SIGSYS.
      const policyResult = await runProbe(probeRequest(
        'sandbox-probe',
        { command: SECCOMP_POLICY_PROBE_PATH },
      ))
      if (!seccompPolicyProbeSucceeded(policyResult)) {
        return unavailable('sandbox_seccomp_policy_probe_failed')
      }

      const helperMarker = SANDBOX_WORKSPACE_PROBE_CONTENT
      await writeFile(join(workspace, 'probe.txt'), helperMarker, { mode: 0o600 })
      const helperResult = await runProbe(probeRequest('workspace_inspect', {
        action: 'read_text',
        path: 'probe.txt',
        limit: 1,
      }))
      if (helperResult.terminationReason !== 'exited'
        || helperResult.exitCode !== 0
        || helperResult.stdout !== helperMarker
        || helperResult.stderr !== '') {
        return unavailable('sandbox_workspace_helper_probe_failed')
      }

      this.trustedPaths = trustedPaths
      this.cgroupManager = cgroupManager
      retainCgroupManager = true
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
      if (!retainCgroupManager) await cgroupManager.close().catch(() => undefined)
      await rm(workspace, { recursive: true, force: true })
    }
  }

  private async runIsolatedProcess(
    request: ExecutionRequest,
    control: ExecutionControl,
    cgroupManager: LinuxCgroupManager,
    invocation: LinuxSandboxCommand,
    profileFd: number,
    workspaceFd: number,
    maxOutputBytes: number,
    expectedBwrapIdentity: string,
    mkfifoPath: string,
  ) {
    return cgroupManager.withOperation(request.operationId, control.signal, async (group) => {
      return withSelfHeldBlockFd(mkfifoPath, control.signal, async (blockHandle) => {
        return this.processes.execute({
          ...invocation,
          signal: control.signal,
          deadline: request.deadline,
          timeoutMs: this.wallTimeMs,
          maxOutputBytes,
          extraStdio: [profileFd, workspaceFd, 'pipe', blockHandle.fd],
          onSpawn: async ({ extraStdio, signal: spawnSignal }) => {
            const info = extraStdio[2]
            if (!(info instanceof Readable)) {
              throw new SandboxHandshakeError('bwrap info pipe 类型错误')
            }
            const childPid = await readBlockedSandboxChildPid(info, {
              signal: spawnSignal,
              deadline: request.deadline,
            })
            const childIdentity = await readBlockedSandboxChildIdentity(
              childPid,
              expectedBwrapIdentity,
            )
            await group.attachAndVerify(childPid, spawnSignal)
            await assertBlockedSandboxChildIdentity(childIdentity)
            if (spawnSignal.aborted) throw spawnSignal.reason
            await releaseSelfHeldBlockFd(blockHandle)
          },
        })
      })
    })
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
    const effectiveDeadline = Math.min(request.deadline, Date.now() + this.wallTimeMs)
    const boundedRequest = effectiveDeadline === request.deadline
      ? request
      : Object.freeze({ ...request, deadline: effectiveDeadline })
    if (control.signal.aborted || Date.now() >= boundedRequest.deadline) {
      return Object.freeze({
        outcome: 'failed',
        errorCode: control.signal.aborted ? 'sandbox_aborted' : 'sandbox_timeout',
        proof: 'no_side_effect',
      })
    }
    const probe = await this.probe()
    if (control.signal.aborted || Date.now() >= boundedRequest.deadline) {
      return Object.freeze({
        outcome: 'failed',
        errorCode: control.signal.aborted ? 'sandbox_aborted' : 'sandbox_timeout',
        proof: 'no_side_effect',
      })
    }
    if (!probe.available || !this.supports(
      boundedRequest.executionKind,
      boundedRequest.constraints,
      boundedRequest.capabilities,
    )) {
      return Object.freeze({
        outcome: 'failed',
        errorCode: probe.reasonCode || 'sandbox_constraint_unsupported',
        proof: 'no_side_effect',
      })
    }
    try {
      return await this.executeExclusive(boundedRequest, control)
    } catch {
      if (control.signal.aborted) {
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
    const trustedPaths = this.trustedPaths
    const cgroupManager = this.cgroupManager
    if (!configuredRoot || !trustedPaths || !cgroupManager) {
      return Object.freeze({
        outcome: 'failed', errorCode: 'sandbox_constraint_unsupported', proof: 'no_side_effect',
      })
    }
    if (!safeWorkspaceRoot(configuredRoot, trustedPaths)) {
      return Object.freeze({
        outcome: 'failed', errorCode: 'sandbox_workspace_unavailable', proof: 'no_side_effect',
      })
    }

    const preflightControl: SandboxPreflightControl = {
      signal: control.signal,
      deadline: request.deadline,
    }
    try {
      if (!await this.runtimePrerequisitesStillValid(preflightControl)) {
        throw new Error('sandbox prerequisites changed')
      }
    } catch {
      if (control.signal.aborted || Date.now() >= request.deadline) {
        return Object.freeze({
          outcome: 'failed',
          errorCode: control.signal.aborted ? 'sandbox_aborted' : 'sandbox_timeout',
          proof: 'no_side_effect',
        })
      }
      return Object.freeze({
        outcome: 'failed', errorCode: 'sandbox_prerequisite_changed', proof: 'no_side_effect',
      })
    }

    let invocation: LinuxSandboxCommand
    try {
      invocation = buildLinuxSandboxCommand(request, {
        bwrapPath: trustedPaths.bwrap,
        rootfsPath: trustedPaths.rootfs,
        seccompFd: CHILD_SECCOMP_FD,
        workspaceFd: CHILD_WORKSPACE_FD,
        infoFd: CHILD_INFO_FD,
        blockFd: CHILD_BLOCK_FD,
        scratchBytes: this.scratchBytes,
      })
    } catch {
      return Object.freeze({
        outcome: 'failed', errorCode: 'sandbox_process_input_invalid', proof: 'no_side_effect',
      })
    }

    let dispatched = false
    try {
      return await withReadOnlyWorkspaceFd(configuredRoot, async (workspace) => {
        if (!safeWorkspaceRoot(workspace.canonicalPath, trustedPaths)) {
          return Object.freeze({
            outcome: 'failed', errorCode: 'sandbox_workspace_unavailable', proof: 'no_side_effect',
          })
        }
        return withWorkspaceSnapshot({
          readPath: workspace.descriptorPath,
          canonicalPath: workspace.canonicalPath,
          expectedIdentity: workspace.identity,
          rootKind: 'linux-proc-fd',
        }, {
          limits: this.snapshotLimits,
          control: { signal: control.signal, deadline: request.deadline },
          stagingParent: this.options.snapshotStagingParent,
        }, async (snapshot) => {
          return withSeccompProfileFd(
            trustedPaths.seccomp,
            this.options.seccompProfileSha256!,
            async (profileFd) => {
              dispatched = true
              const result = await this.runIsolatedProcess(
                request,
                control,
                cgroupManager,
                invocation,
                profileFd,
                snapshot.descriptor,
                this.maxOutputBytes,
                trustedPaths.identities.bwrap,
                trustedPaths.mkfifo,
              )
              if (result.terminationReason === 'spawn_error'
                || result.terminationReason === 'setup_error') {
                return Object.freeze({
                  outcome: 'failed',
                  errorCode: result.terminationReason === 'spawn_error'
                    ? 'sandbox_spawn_error'
                    : 'sandbox_setup_error',
                  proof: 'no_side_effect',
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
                rawOutput: result.stdout,
              })
            },
          )
        })
      }, preflightControl)
    } catch (error) {
      if (!dispatched && (control.signal.aborted || Date.now() >= request.deadline)) {
        return Object.freeze({
          outcome: 'failed',
          errorCode: control.signal.aborted ? 'sandbox_aborted' : 'sandbox_timeout',
          proof: 'no_side_effect',
        })
      }
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
      if (error instanceof WorkspaceSnapshotError
        && error.code !== 'workspace_snapshot_cleanup_failed') {
        return Object.freeze({
          outcome: 'failed', errorCode: error.code, proof: 'no_side_effect',
        })
      }
      if (error instanceof LinuxCgroupUnavailableError) {
        return Object.freeze({
          outcome: 'failed', errorCode: `sandbox_cgroup_${error.reasonCode}`, proof: 'no_side_effect',
        })
      }
      return Object.freeze({ outcome: 'uncertain', errorCode: 'sandbox_execution_error' })
    }
  }

  async close() {
    await this.cgroupManager?.close()
  }

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

  private async runtimePrerequisitesStillValid(control: SandboxPreflightControl) {
    const trusted = this.trustedPaths
    const cgroupManager = this.cgroupManager
    const { rootfsPath, seccompProfilePath, seccompProfileSha256, cgroupRoot } = this.options
    if (!trusted || !cgroupManager || !rootfsPath || !seccompProfilePath
      || !seccompProfileSha256 || !cgroupRoot) {
      return false
    }
    const [bwrap, mkfifo, rootfs, seccomp, cgroup] = await Promise.all([
      canonicalTrustedPath(this.options.bwrapPath, 'file', true, control),
      canonicalTrustedPath(this.options.mkfifoPath ?? '/usr/bin/mkfifo', 'file', true, control),
      canonicalTrustedPath(rootfsPath, 'directory', false, control),
      canonicalTrustedPath(seccompProfilePath, 'file', false, control),
      realpath(cgroupRoot).catch(() => undefined),
    ])
    if (!bwrap || !mkfifo || !rootfs || !seccomp || !cgroup) return false
    const identities = await Promise.all([
      pathIdentity(bwrap),
      pathIdentity(mkfifo),
      pathIdentity(rootfs),
      pathIdentity(seccomp),
      pathIdentity(cgroup),
    ]).catch(() => undefined)
    if (!identities) return false
    return bwrap === trusted.bwrap
      && rootfs === trusted.rootfs
      && mkfifo === trusted.mkfifo
      && seccomp === trusted.seccomp
      && cgroup === trusted.cgroup
      && identities[0] === trusted.identities.bwrap
      && identities[1] === trusted.identities.mkfifo
      && identities[2] === trusted.identities.rootfs
      && identities[3] === trusted.identities.seccomp
      && identities[4] === trusted.identities.cgroup
      && await verifyImmutableRootfs(trusted.rootfs, control)
      && await verifyBoundedOpenFilesLimit(this.maxOpenFiles)
      && cgroupManager.root === trusted.cgroup
  }
}
