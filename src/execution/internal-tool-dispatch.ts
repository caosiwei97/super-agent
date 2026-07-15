import type {
  ResolvedToolInvocation,
  ToolDispatchResult,
  ToolRegistry,
  ToolRuntimeContext,
} from '../core/tool-registry.js'
import {
  intersectExecutionConstraints,
  parseExecutionConstraints,
  type ExecutionConstraints,
} from '../security/capabilities.js'
import type { ExecutionPlan } from './execution-router.js'
import { ExecutionRoutingError } from './execution-router.js'

export interface InternalToolDispatchOptions extends ToolRuntimeContext {
  readonly constraints: ExecutionConstraints
  readonly plan: ExecutionPlan
  readonly operationId: string
  readonly attemptId: string
  readonly idempotencyKey?: string
  readonly beforeDispatch?: (invocation: ResolvedToolInvocation) => void | Promise<void>
}

type DispatchHandler = (
  invocation: ResolvedToolInvocation,
  options: InternalToolDispatchOptions,
) => Promise<ToolDispatchResult>

type PreflightHandler = (
  invocation: ResolvedToolInvocation,
  constraints: ExecutionConstraints,
) => ExecutionPlan

const handlers = new WeakMap<ToolRegistry, DispatchHandler>()
const preflightHandlers = new WeakMap<ToolRegistry, PreflightHandler>()
const KERNEL_CONSTRAINTS = new Set<keyof ExecutionConstraints>(['maxResultChars'])

export type ConstraintGateErrorCode =
  | 'constraint_invalid'
  | 'constraint_unsupported'
  | 'constraint_relaxation'
  | 'sandbox_unavailable'
  | 'process_boundary_mismatch'
  | 'legacy_execution_kind'

export class ConstraintGateError extends Error {
  override readonly name = 'ConstraintGateError'

  constructor(readonly code: ConstraintGateErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function sameArray(left: readonly unknown[], right: readonly unknown[]) {
  return left.length === right.length && left.every((item) => right.includes(item))
}

function sameConstraints(left: ExecutionConstraints, right: ExecutionConstraints) {
  const keys = new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ] as (keyof ExecutionConstraints)[])
  for (const key of keys) {
    const a = left[key]
    const b = right[key]
    if (Array.isArray(a) && Array.isArray(b)) {
      if (!sameArray(a, b)) return false
    } else if (a !== b) {
      return false
    }
  }
  return true
}

export function preflightResolvedInvocation(
  registry: ToolRegistry,
  invocation: ResolvedToolInvocation,
  value: ExecutionConstraints,
) {
  let effective: ExecutionConstraints
  try {
    effective = parseExecutionConstraints(value)
  } catch (error) {
    throw new ConstraintGateError('constraint_invalid', 'effective constraints 非法', { cause: error })
  }
  const supported = new Set<keyof ExecutionConstraints>([
    ...invocation.supportedConstraintKeys,
    ...KERNEL_CONSTRAINTS,
  ])
  const unsupported = (Object.keys(effective) as (keyof ExecutionConstraints)[])
    .find((key) => !supported.has(key))
  if (unsupported) {
    throw new ConstraintGateError('constraint_unsupported', `工具不支持执行约束: ${unsupported}`)
  }
  const tightened = intersectExecutionConstraints(invocation.constraints, effective)
  if (tightened === null || !sameConstraints(tightened, effective)) {
    throw new ConstraintGateError(
      'constraint_relaxation',
      'effective constraints 不能放宽 resolved invocation constraints',
    )
  }
  const constraints = sameConstraints(effective, invocation.constraints)
    ? invocation.constraints
    : effective
  const preflight = preflightHandlers.get(registry)
  if (!preflight) throw new Error('ToolRegistry execution router 未安装')
  try {
    return preflight(invocation, constraints)
  } catch (error) {
    if (error instanceof ExecutionRoutingError) {
      throw new ConstraintGateError(error.code, error.message, { cause: error })
    }
    throw error
  }
}

/** Install the registry-owned closure without exposing it on ToolRegistry's public surface. */
export function installInternalToolDispatcher(
  registry: ToolRegistry,
  handler: DispatchHandler,
  preflight: PreflightHandler,
) {
  if (handlers.has(registry) || preflightHandlers.has(registry)) {
    throw new Error('ToolRegistry internal dispatcher 已安装')
  }
  handlers.set(registry, handler)
  preflightHandlers.set(registry, preflight)
}

/** Package-internal gate; deliberately absent from the package public index. */
export async function dispatchResolvedInvocation(
  registry: ToolRegistry,
  invocation: ResolvedToolInvocation,
  options: InternalToolDispatchOptions,
) {
  const handler = handlers.get(registry)
  if (!handler) throw new Error('ToolRegistry internal dispatcher 未安装')
  const defensivePlan = preflightResolvedInvocation(registry, invocation, options.constraints)
  if (
    defensivePlan.executionKind !== options.plan.executionKind
    || defensivePlan.backend !== options.plan.backend
    || defensivePlan.executionKindSource !== options.plan.executionKindSource
  ) {
    throw new ConstraintGateError('constraint_relaxation', 'execution plan 在审批后发生变化')
  }
  return handler(invocation, {
    ...options,
    constraints: defensivePlan.constraints,
    plan: defensivePlan,
  })
}
