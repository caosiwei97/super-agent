import type { ExecutionRequest } from './executor.js'
import {
  buildWorkspaceInspectHelperArgv,
  WORKSPACE_INSPECT_HELPER_PATH,
} from './workspace-inspect-contract.js'

export { WORKSPACE_INSPECT_HELPER_PATH }
const SECCOMP_POLICY_PROBE_PATH = '/usr/libexec/super-agent/seccomp-probe'
export const SANDBOX_RELEASE_PROBE_PATH = '/usr/libexec/super-agent/sandbox-release-probe'
export const SANDBOX_RELEASE_PROBE_ACTIONS = Object.freeze([
  'readonly',
  'output',
  'sleep',
  'fork',
  'fd',
  'cpu',
] as const)

export interface LinuxSandboxCommandOptions {
  readonly bwrapPath: string
  readonly rootfsPath: string
  readonly seccompFd: number
  readonly workspaceFd: number
  readonly infoFd?: number
  readonly blockFd?: number
  readonly scratchBytes: number
}

export interface LinuxSandboxCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<NodeJS.ProcessEnv>
}

export function supportsBwrapVersion(output: string) {
  const match = output.match(/(?:bubblewrap|bwrap)\s+(\d+)\.(\d+)\.(\d+)/i)
  if (!match) return false
  const current = match.slice(1).map(Number)
  const minimum = [0, 11, 2]
  const firstDifference = current.findIndex((value, index) => value !== minimum[index])
  return firstDifference === -1 || current[firstDifference]! > minimum[firstDifference]!
}

export function supportsBwrapFeatures(help: string) {
  return [
    '--disable-userns',
    '--seccomp',
    '--size',
    '--unshare-cgroup',
    '--ro-bind-fd',
    '--info-fd',
    '--block-fd',
  ]
    .every((flag) => help.includes(flag))
}

function sandboxProbeArgv(input: Record<string, unknown>) {
  if (Object.keys(input).length === 1 && input.command === SECCOMP_POLICY_PROBE_PATH) {
    return Object.freeze([SECCOMP_POLICY_PROBE_PATH])
  }
  throw new TypeError('sandbox-probe input 不符合固定探针契约')
}

function sandboxReleaseProbeArgv(input: Record<string, unknown>) {
  if (Object.keys(input).length !== 1
    || typeof input.action !== 'string'
    || !SANDBOX_RELEASE_PROBE_ACTIONS.includes(
      input.action as typeof SANDBOX_RELEASE_PROBE_ACTIONS[number],
    )) {
    throw new TypeError('sandbox-release-probe input 不符合固定 action 契约')
  }
  return Object.freeze([SANDBOX_RELEASE_PROBE_PATH, 'v1', input.action])
}

function processArgv(request: ExecutionRequest): readonly string[] {
  if (request.input === null || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw new TypeError('sandbox process input 必须是对象')
  }
  const input = request.input as Record<string, unknown>
  if (request.toolName === 'workspace_inspect') return buildWorkspaceInspectHelperArgv(input)
  if (request.toolName === 'sandbox-probe') return sandboxProbeArgv(input)
  if (request.toolName === 'sandbox-release-probe') return sandboxReleaseProbeArgv(input)
  throw new TypeError('sandbox 只允许固定的 workspace_inspect 与内部 probe')
}

/** Build the exact argv-only bwrap boundary. No host shell is involved. */
export function buildLinuxSandboxCommand(
  request: ExecutionRequest,
  options: LinuxSandboxCommandOptions,
): LinuxSandboxCommand {
  if (!Number.isSafeInteger(options.seccompFd) || options.seccompFd < 3) {
    throw new TypeError('seccompFd 必须是继承到 child 的 fd >= 3')
  }
  if (!Number.isSafeInteger(options.workspaceFd) || options.workspaceFd < 3
    || options.workspaceFd === options.seccompFd) {
    throw new TypeError('workspaceFd 必须是与 seccompFd 不同的 child fd >= 3')
  }
  if ((options.infoFd === undefined) !== (options.blockFd === undefined)) {
    throw new TypeError('infoFd 与 blockFd 必须同时设置')
  }
  const controlFds = [options.infoFd, options.blockFd].filter(
    (descriptor): descriptor is number => descriptor !== undefined,
  )
  if (controlFds.some((descriptor) => !Number.isSafeInteger(descriptor) || descriptor < 3)
    || new Set([options.seccompFd, options.workspaceFd, ...controlFds]).size
      !== 2 + controlFds.length) {
    throw new TypeError('sandbox child fd 必须是互不相同的整数且 >= 3')
  }
  if (!Number.isSafeInteger(options.scratchBytes) || options.scratchBytes <= 0) {
    throw new TypeError('scratchBytes 必须是正安全整数')
  }
  const target = processArgv(request)
  return Object.freeze({
    command: options.bwrapPath,
    args: Object.freeze([
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-net',
      '--unshare-cgroup',
      '--die-with-parent',
      '--new-session',
      '--disable-userns',
      '--cap-drop', 'ALL',
      '--clearenv',
      '--setenv', 'PATH', '/usr/bin:/bin',
      '--setenv', 'HOME', '/tmp/home',
      '--setenv', 'TMPDIR', '/tmp',
      '--setenv', 'LANG', 'C.UTF-8',
      '--hostname', 'super-agent',
      '--ro-bind', options.rootfsPath, '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--dir', '/run',
      '--size', String(options.scratchBytes),
      '--tmpfs', '/tmp',
      '--dir', '/tmp/home',
      // bwrap implements this from /proc/self/fd/<FD>, verifies the mounted
      // inode identity, then closes FD before the target starts.
      '--ro-bind-fd', String(options.workspaceFd), '/workspace',
      '--chdir', '/workspace',
      ...(options.infoFd === undefined
        ? []
        : ['--info-fd', String(options.infoFd), '--block-fd', String(options.blockFd)]),
      '--seccomp', String(options.seccompFd),
      '--',
      ...target,
    ]),
    // bwrap itself receives no provider keys, HOME, SSH agent or user PATH.
    env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C' }),
  })
}
