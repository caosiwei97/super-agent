export { runCli } from './cli/main.js'
export { parseCliOptions, cliUsage } from './cli/args.js'
export type { CliCommand } from './cli/args.js'
export { agentLoop } from './agent/agent-loop.js'
export type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopObserver,
  AgentStopReason,
  BudgetState,
  ToolApprovalHandler,
} from './agent/agent-loop.js'
export { ConversationRunner } from './agent/conversation-runner.js'
export type {
  ConversationRunnerOptions,
  ConversationState,
  CompactionPhase,
  RunTurnOptions,
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
export { ToolRegistry, truncateResult } from './core/tool-registry.js'
export type {
  MCPToolClient,
  MCPToolDescriptor,
  ToolDescriptor,
  ToolDefinition,
  ToolDispatchOptions,
  ToolDispatchResult,
  ToolExecutionContext,
  ToolInputValidationResult,
  ToolInvocation,
} from './core/tool-registry.js'
export { Workspace, WorkspaceBoundaryError } from './core/workspace.js'
export { loadConfig } from './core/config.js'
export { SessionStore, createSessionId } from './session/store.js'
export type {
  DurableEventWriter,
  EventDurability,
  SessionEntry,
  SessionEvent,
  SessionEventInput,
  SessionState,
  SessionStoreOptions,
  SessionWriter,
  ToolResultCommit,
} from './session/store.js'
export {
  applyOperationEvent,
  assertOperationTransition,
  createOperationInputDigestPort,
  createOperationResultProtectionPort,
  parseOperationEvent,
  proposeOperation,
  redactSensitiveInput,
  reduceOperationEvents,
  stableNormalizeInput,
  transitionOperation,
} from './execution/operation-ledger.js'
export {
  RecoveryCoordinator,
  UnresolvedOperationsError,
  materializeTerminalResult,
  materializedTerminalToToolMessage,
} from './execution/recovery-coordinator.js'
export { ToolExecutionPipeline } from './execution/tool-execution-pipeline.js'
export type {
  CompleteToolCall,
  PipelineApprovalRequest,
  PipelineBatchOptions,
  PipelineBatchResult,
  PipelineOutcome,
  RunContext,
} from './execution/tool-execution-pipeline.js'
export {
  DeadlineExceededError,
  ModelAuditWriteError,
  ModelGateway,
} from './model/model-gateway.js'
export type {
  ModelAttemptAuditEvent,
  ModelAttemptErrorCode,
  ModelGatewayRequest,
  ModelGatewayResult,
  ModelToolCall,
} from './model/model-gateway.js'
export { executeProcess } from './execution/process-executor.js'
export type {
  ProcessExecutionOptions,
  ProcessExecutionResult,
  ProcessTerminationReason,
} from './execution/process-executor.js'
export type {
  CancellationProof,
  FailureProof,
  IdempotencyContract,
  OperationEvent,
  OperationInputDigestPort,
  OperationResultProtectionPort,
  OperationProjection,
  OperationStatus,
  OperationTransition,
  ProtectedOperationInput,
  ProtectedOperationResult,
  ProposedOperation,
  ReconcileResult,
} from './execution/operation-types.js'
export type {
  MaterializedTerminalOutput,
  OperationResolution,
  RecoveryJournal,
  RecoverySnapshot,
  TerminalResultMaterialization,
} from './execution/recovery-coordinator.js'
