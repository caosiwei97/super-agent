import type { Workspace } from '../../core/workspace.js'
import { utilityTools } from './utility-tools.js'
import { createFileTools } from './file-tools.js'
import { createShellTools } from './shell-tools.js'
import { createWebTools, type WebToolDependencies } from './web-tools.js'
import { createPreviewTools } from './preview-tools.js'

export interface BuiltinToolOptions {
  workspace: Workspace
  web?: WebToolDependencies
}

export function createBuiltinTools(options: BuiltinToolOptions) {
  return [
    ...utilityTools,
    ...createFileTools(options.workspace),
    ...createShellTools(options.workspace),
    ...createWebTools(options.web),
    ...createPreviewTools(options.workspace),
  ]
}
