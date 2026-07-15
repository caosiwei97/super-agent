import { canSpawnProcess } from '../../core/env.js'
import type { ToolDefinition, ToolExecutionContext } from '../../core/tool-registry.js'
import type { Workspace } from '../../core/workspace.js'
import { executeProcess } from '../../execution/process-executor.js'

export function createShellTools(workspace: Workspace): ToolDefinition[] {
  return [
    {
      name: 'bash',
      executionKind: 'process',
      description: '在工作区目录执行 shell 命令；命令拥有当前进程权限，每次执行均需审批',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command'],
        additionalProperties: false,
      },
      // A free-form shell command can exercise every host capability. Until M3
      // provides a sandbox backend, secret.read + network.egress makes this a
      // PolicyEngine hard deny (including when CLI --yes is set).
      getCapabilities: () => [
        'process.execute',
        'filesystem.read',
        'filesystem.write',
        'network.egress',
        'secret.read',
      ] as const,
      getConstraints: () => ({
        filesystemReadRoots: [workspace.root],
        filesystemWriteRoots: [workspace.root],
        requireSandbox: true,
        maxResultChars: 3_000,
      }),
      // Root bounds are carried for the future sandbox backend. In M2 the
      // kernel consumes requireSandbox and rejects before this host closure;
      // cwd alone is deliberately not treated as a filesystem boundary.
      supportedConstraintKeys: [
        'filesystemReadRoots',
        'filesystemWriteRoots',
        'requireSandbox',
      ],
      isConcurrencySafe: () => false,
      maxResultChars: 3_000,
      execute: async ({ command }: { command: string }, context: ToolExecutionContext) => {
        if (!canSpawnProcess()) return '[bash 不可用] 当前环境不支持子进程'

        const shell = process.platform === 'win32'
          ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
          : { command: '/bin/sh', args: ['-c', command] }
        const result = await executeProcess({
          ...shell,
          cwd: workspace.root,
          signal: context.signal,
          deadline: context.deadline,
          timeoutMs: 10_000,
          maxOutputBytes: 1024 * 1024,
        })

        if (['aborted', 'timeout', 'output_limit'].includes(result.terminationReason)) {
          const name = result.terminationReason === 'aborted' ? 'AbortError' : 'TimeoutError'
          throw new DOMException(`Shell execution ${result.terminationReason}`, name)
        }
        const output = result.stdout || result.stderr
        if (result.terminationReason === 'spawn_error') {
          return `命令启动失败: ${result.error?.message || 'unknown spawn error'}`
        }
        if (result.exitCode !== 0 || result.signal) {
          return `命令执行失败 (exit ${result.exitCode ?? result.signal ?? 1}):\n${output}`
        }
        return output || '(命令执行成功，无输出)'
      },
    },
  ]
}
