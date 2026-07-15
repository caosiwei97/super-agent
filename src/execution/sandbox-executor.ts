import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  assertSerializableExecutionRequest,
  type ExecutionControl,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ExecutorProbeResult,
  type ToolExecutionKind,
} from './executor.js'
import type { ExecutionConstraints } from '../security/capabilities.js'

export interface SandboxExecutorOptions {
  readonly bwrapPath: string
  readonly rootfsPath?: string
  readonly seccompProfilePath?: string
  readonly cgroupRoot?: string
  /** Test seam only. Production construction must omit it. */
  readonly platform?: NodeJS.Platform
}

export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError'

  constructor(readonly reasonCode: string) {
    super(`production sandbox 不可用: ${reasonCode}`)
  }
}

async function isExecutableFile(path: string) {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
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

/**
 * PR9 bootstrap for the production backend.
 *
 * It deliberately reports unavailable after checking prerequisites: the real
 * bwrap command, seccomp FD, cgroup placement and staged filesystem contract
 * land together in PR10. Reporting success before then would be a sandbox
 * downgrade disguised as readiness.
 */
export class SandboxExecutor implements Executor {
  readonly kind = 'sandbox' as const
  private readonly platform: NodeJS.Platform

  constructor(private readonly options: SandboxExecutorOptions) {
    this.platform = options.platform ?? process.platform
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

  async probe(): Promise<ExecutorProbeResult> {
    if (this.platform !== 'linux') return unavailable('sandbox_platform_unsupported')
    if (!this.options.rootfsPath || !this.options.seccompProfilePath || !this.options.cgroupRoot) {
      return unavailable('sandbox_configuration_incomplete')
    }
    if (!await isExecutableFile(this.options.bwrapPath)) {
      return unavailable('sandbox_bwrap_unavailable')
    }
    if (!await isDirectory(this.options.rootfsPath)) {
      return unavailable('sandbox_rootfs_unavailable')
    }
    if (!await isFile(this.options.seccompProfilePath)) {
      return unavailable('sandbox_seccomp_unavailable')
    }
    if (!await isDirectory(this.options.cgroupRoot)) {
      return unavailable('sandbox_cgroup_unavailable')
    }
    return unavailable('sandbox_backend_not_implemented')
  }

  supports(_kind: ToolExecutionKind, _constraints: ExecutionConstraints) {
    return false
  }

  async execute(request: ExecutionRequest, _control: ExecutionControl): Promise<ExecutionResult> {
    assertSerializableExecutionRequest(request)
    return Object.freeze({
      outcome: 'failed',
      errorCode: 'sandbox_unavailable',
      proof: 'no_side_effect',
    })
  }

  async close() {}
}
