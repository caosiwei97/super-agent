import type { Workspace } from '../../core/workspace.js'
import type { FilesystemBroker } from '../../execution/filesystem-broker.js'
import { utilityTools } from './utility-tools.js'
import { createFileTools } from './file-tools.js'
import { createShellTools } from './shell-tools.js'
import { createWebTools, type WebToolDependencies } from './web-tools.js'
import { createPreviewTools } from './preview-tools.js'
import { createInspectProcessTool } from './inspect-process-tool.js'

export interface BuiltinToolOptions {
  workspace: Workspace
  filesystem?: FilesystemBroker
  web?: WebToolDependencies
}

export function createBuiltinTools(options: BuiltinToolOptions) {
  return [
    ...utilityTools,
    ...createFileTools(options.workspace, { filesystem: options.filesystem }),
    ...createShellTools(options.workspace),
    createInspectProcessTool(options.workspace),
    ...createWebTools(options.web),
    ...createPreviewTools(options.workspace),
  ]
}
