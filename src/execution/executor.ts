import type { ExecutionConstraints, ToolCapability } from '../security/capabilities.js'

export const TOOL_EXECUTION_KINDS = [
  'pure',
  'filesystem',
  'network',
  'preview',
  'process',
  'mcp',
] as const

export type ToolExecutionKind = typeof TOOL_EXECUTION_KINDS[number]
export type ExecutionProfile = 'development' | 'production'
export type ExecutorKind = 'local' | 'sandbox'

/** JSON-only execution data. Cancellation is deliberately carried out-of-band. */
export interface ExecutionRequest {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly attemptId: string
  readonly idempotencyKey?: string
  readonly toolCallId: string
  readonly toolName: string
  readonly executionKind: ToolExecutionKind
  readonly input: unknown
  readonly capabilities: readonly ToolCapability[]
  readonly constraints: ExecutionConstraints
  readonly deadline: number
}

export interface ExecutionControl {
  readonly signal: AbortSignal
}

export type ExecutionResult =
  | { readonly outcome: 'succeeded'; readonly rawOutput: unknown }
  | {
      readonly outcome: 'failed'
      readonly errorCode: string
      readonly proof: 'no_side_effect'
    }
  | { readonly outcome: 'uncertain'; readonly errorCode: string }

export interface ExecutorProbeResult {
  readonly available: boolean
  readonly reasonCode?: string
}

/** Process backends implement this port; host brokers remain owned by the router. */
export interface Executor {
  readonly kind: ExecutorKind
  probe(): Promise<ExecutorProbeResult>
  supports(kind: ToolExecutionKind, constraints: ExecutionConstraints): boolean
  execute(request: ExecutionRequest, control: ExecutionControl): Promise<ExecutionResult>
  close(): Promise<void>
}

export function assertSerializableExecutionRequest(request: ExecutionRequest) {
  if (request.schemaVersion !== 1) throw new TypeError('ExecutionRequest.schemaVersion 非法')
  for (const [field, value] of Object.entries({
    operationId: request.operationId,
    attemptId: request.attemptId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
  })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`ExecutionRequest.${field} 必须是非空字符串`)
    }
  }
  if (request.idempotencyKey !== undefined && request.idempotencyKey.length === 0) {
    throw new TypeError('ExecutionRequest.idempotencyKey 必须是非空字符串')
  }
  if (!TOOL_EXECUTION_KINDS.includes(request.executionKind)) {
    throw new TypeError('ExecutionRequest.executionKind 非法')
  }
  if (!Number.isFinite(request.deadline) || request.deadline <= 0) {
    throw new TypeError('ExecutionRequest.deadline 必须是有限正数')
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(request)
  } catch (error) {
    throw new TypeError('ExecutionRequest 必须可序列化为 JSON', { cause: error })
  }
  if (serialized === undefined) throw new TypeError('ExecutionRequest 必须可序列化为 JSON')
}
