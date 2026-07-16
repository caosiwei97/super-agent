import type { ToolDefinition } from '../../core/tool-registry.js'
import type { Workspace } from '../../core/workspace.js'
import {
  INSPECT_ACTIONS,
  INSPECT_PROCESS_TOOL_NAME,
  MAX_WORKSPACE_INSPECT_PATH_CHARS,
  MAX_WORKSPACE_INSPECT_QUERY_CHARS,
  MAX_WORKSPACE_INSPECT_RESULTS,
  parseInspectProcessInput,
} from '../../execution/workspace-inspect-contract.js'

export {
  INSPECT_PROCESS_TOOL_NAME,
  WORKSPACE_INSPECT_HELPER_PATH,
  buildWorkspaceInspectHelperArgv,
  parseInspectProcessInput,
} from '../../execution/workspace-inspect-contract.js'
export type { InspectProcessInput } from '../../execution/workspace-inspect-contract.js'

/**
 * First production process tool: semantic input only, offline and read-only.
 *
 * The host closure is deliberately unusable. A successful preflight must route
 * the frozen input to SandboxExecutor. The backend maps the tool name to the
 * fixed helper protocol above; `/workspace` is mounted read-only and the
 * network namespace has no interfaces inherited from the host.
 */
export function createInspectProcessTool(workspace: Workspace): ToolDefinition {
  return {
    name: INSPECT_PROCESS_TOOL_NAME,
    executionKind: 'process',
    description: [
      '在只读、离线 Linux sandbox 中检查工作区。',
      'list_files 列目录，read_text 读文件行，search_text 在单个文件中做字面搜索；',
      '不接受 command、argv、env 或 shell。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...INSPECT_ACTIONS],
          description: '固定的只读检查动作',
        },
        path: {
          type: 'string', minLength: 1, maxLength: MAX_WORKSPACE_INSPECT_PATH_CHARS,
          description: '工作区内安全相对路径；禁止绝对路径、.. 与反斜杠',
        },
        limit: {
          type: 'integer', minimum: 1, maximum: MAX_WORKSPACE_INSPECT_RESULTS,
          description: 'list/search 的最大记录数或 read 的最大行数',
        },
        query: {
          type: 'string', minLength: 1, maxLength: MAX_WORKSPACE_INSPECT_QUERY_CHARS,
          description: '仅 search_text 必填的字面搜索文本',
        },
      },
      required: ['action', 'path', 'limit'],
      additionalProperties: false,
    },
    getCapabilities: (input) => {
      parseInspectProcessInput(input)
      return ['process.execute', 'filesystem.read'] as const
    },
    getConstraints: (input) => {
      parseInspectProcessInput(input)
      return {
        filesystemReadRoots: [workspace.root],
        requireSandbox: true,
        maxResultChars: 3_000,
      }
    },
    supportedConstraintKeys: ['filesystemReadRoots', 'requireSandbox'],
    // Staging happens before the process enters its per-operation cgroup and
    // can consume the full snapshot byte budget. Keep this lane serialized
    // until a host-wide staging admission/quota controller exists.
    isConcurrencySafe: () => false,
    maxResultChars: 3_000,
    execute: async () => {
      throw new Error('workspace_inspect 只能由 SandboxExecutor 执行')
    },
  }
}
