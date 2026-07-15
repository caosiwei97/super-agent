import type { ExecutionRequest } from './executor.js'

export interface LinuxSandboxCommandOptions {
  readonly bwrapPath: string
  readonly rootfsPath: string
  readonly seccompFd: number
  readonly workspaceFd: number
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
  return ['--disable-userns', '--seccomp', '--size', '--unshare-cgroup', '--ro-bind-fd']
    .every((flag) => help.includes(flag))
}

function processArgv(request: ExecutionRequest): readonly string[] {
  if (request.input === null || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw new TypeError('sandbox process input 必须是对象')
  }
  const input = request.input as Record<string, unknown>
  if (request.toolName === 'bash') {
    if (Object.keys(input).some((key) => key !== 'command')
      || typeof input.command !== 'string'
      || input.command.trim().length === 0) {
      throw new TypeError('bash sandbox input 必须只包含非空 command')
    }
    // The user command remains one argv element. The host never interpolates it
    // into the bwrap invocation or another shell command string.
    return Object.freeze(['/bin/sh', '-c', input.command])
  }

  if (Object.keys(input).some((key) => key !== 'command' && key !== 'args')
    || typeof input.command !== 'string'
    || input.command.trim().length === 0
    || (input.args !== undefined && (!Array.isArray(input.args)
      || input.args.some((argument) => typeof argument !== 'string')))) {
    throw new TypeError('sandbox process input 必须是 command + 可选字符串 args')
  }
  return Object.freeze([input.command, ...((input.args as string[] | undefined) ?? [])])
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
      '--seccomp', String(options.seccompFd),
      '--',
      ...target,
    ]),
    // bwrap itself receives no provider keys, HOME, SSH agent or user PATH.
    env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C' }),
  })
}
