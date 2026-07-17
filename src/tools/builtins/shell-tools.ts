import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { canSpawnProcess } from '../../core/env.js'
import type { Workspace } from '../../core/workspace.js'

const execAsync = promisify(exec)

export function createShellTools(workspace: Workspace) {
  return [
    {
      name: 'bash',
      description: '在工作区目录执行 shell 命令；命令拥有当前进程权限，每次执行均需审批',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command'],
        additionalProperties: false,
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      requiresApproval: true,
      maxResultChars: 3_000,
      execute: async ({ command }: { command: string }) => {
        if (!canSpawnProcess()) return '[bash 不可用] 当前环境不支持子进程'

        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: workspace.root,
            encoding: 'utf-8',
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
          })
          return stdout || stderr || '(命令执行成功，无输出)'
        } catch (error) {
          const result = error as Error & { stdout?: string; stderr?: string; code?: number | string }
          return `命令执行失败 (exit ${result.code ?? 1}):\n${result.stderr || result.stdout || result.message}`
        }
      },
    },
  ]
}
