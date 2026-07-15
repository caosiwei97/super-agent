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

export interface InternalToolDispatchOptions extends ToolRuntimeContext {
  readonly constraints: ExecutionConstraints
  readonly beforeDispatch?: (invocation: ResolvedToolInvocation) => void | Promise<void>
}

type DispatchHandler = (
  invocation: ResolvedToolInvocation,
  options: InternalToolDispatchOptions,
) => Promise<ToolDispatchResult>

const handlers = new WeakMap<ToolRegistry, DispatchHandler>()
const KERNEL_CONSTRAINTS = new Set<keyof ExecutionConstraints>(['maxResultChars'])

export type ConstraintGateErrorCode =
  | 'constraint_invalid'
  | 'constraint_unsupported'
  | 'constraint_relaxation'
  | 'sandbox_unavailable'

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
  if (effective.requireSandbox === true || invocation.constraints.requireSandbox === true) {
    throw new ConstraintGateError(
      'sandbox_unavailable',
      'requireSandbox 尚无可用执行后端，拒绝 dispatch',
    )
  }
  const tightened = intersectExecutionConstraints(invocation.constraints, effective)
  if (tightened === null || !sameConstraints(tightened, effective)) {
    throw new ConstraintGateError(
      'constraint_relaxation',
      'effective constraints 不能放宽 resolved invocation constraints',
    )
  }
  return sameConstraints(effective, invocation.constraints)
    ? invocation.constraints
    : effective
}

/** Install the registry-owned closure without exposing it on ToolRegistry's public surface. */
export function installInternalToolDispatcher(registry: ToolRegistry, handler: DispatchHandler) {
  if (handlers.has(registry)) throw new Error('ToolRegistry internal dispatcher 已安装')
  handlers.set(registry, handler)
}

/** Package-internal gate; deliberately absent from the package public index. */
export async function dispatchResolvedInvocation(
  registry: ToolRegistry,
  invocation: ResolvedToolInvocation,
  options: InternalToolDispatchOptions,
) {
  const handler = handlers.get(registry)
  if (!handler) throw new Error('ToolRegistry internal dispatcher 未安装')
  return handler(invocation, {
    ...options,
    constraints: preflightResolvedInvocation(invocation, options.constraints),
  })
}
