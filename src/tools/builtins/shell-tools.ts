import { execSync } from 'node:child_process'
import type { ToolDefinition } from '../../core/tool-registry.js'
import { canSpawnProcess } from '../../core/env.js'

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }) => {
    if (!canSpawnProcess()) {
      return `[bash 不可用] 当前环境（WebContainer）不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`
    }

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return output || '(命令执行成功，无输出)'
    } catch (err: any) {
      const stderr = err.stderr || ''
      const stdout = err.stdout || ''
      return `命令执行失败 (exit ${err.status || 1}):\n${stderr || stdout || err.message}`
    }
  },
}

export const shellTools: ToolDefinition[] = [bashTool]
