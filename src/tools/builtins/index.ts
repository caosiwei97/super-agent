// builtins/ 的内部聚合。
// 保持与旧 tools.ts 中 allTools 数组完全一致的顺序。
import { utilityTools } from './utility-tools.js'
import { fileTools } from './file-tools.js'
import { shellTools } from './shell-tools.js'
import { webTools } from './web-tools.js'
import { previewTools } from './preview-tools.js'
import type { ToolDefinition } from '../../core/tool-registry.js'

export const allTools: ToolDefinition[] = [
  ...utilityTools,
  ...fileTools,
  ...shellTools,
  ...webTools,
  ...previewTools,
]
