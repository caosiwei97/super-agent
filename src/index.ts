export { runCli } from './cli/main.js'
export { agentLoop } from './agent/agent-loop.js'
export type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopObserver,
  AgentStopReason,
  TokenCostState,
  ToolApprovalHandler,
} from './agent/agent-loop.js'
export { ConversationRunner } from './agent/conversation-runner.js'
export type {
  ConversationRunnerOptions,
  ConversationState,
  CompactionPhase,
} from './agent/conversation-runner.js'
export {
  compactContext,
  estimateTokens,
  microcompact,
  summarize,
} from './context/compressor.js'
export type {
  CompactionOptions,
  CompactionResult,
  ContextCompactionResult,
} from './context/compressor.js'
export {
  applyContextDefense,
  DEFAULT_CONTEXT_DEFENSE_OPTIONS,
  estimateTextTokens,
  TokenTracker,
  truncateToolResults,
  ttlPrune,
} from './context/defense.js'
export type {
  ContextDefenseOptions,
  ContextDefenseResult,
} from './context/defense.js'
export { ToolRegistry } from './core/tool-registry.js'
export type {
  MCPToolClient,
  MCPToolDescriptor,
  ToolDefinition,
  ToolExecutionResult,
  ToolInvocation,
  ToolRuntimeHooks,
} from './core/tool-registry.js'
export { Workspace, WorkspaceBoundaryError } from './core/workspace.js'
export { loadConfig } from './core/config.js'
export { SessionStore } from './session/store.js'
export type {
  SessionEntry,
  SessionCheckpointState,
  SessionState,
  SessionStoreOptions,
  SessionWriter,
} from './session/store.js'
