import {
  assertSerializableExecutionRequest,
  type ExecutionControl,
  type ExecutionProfile,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ToolExecutionKind,
} from './executor.js'
import {
  parseExecutionConstraints,
  parseToolCapabilities,
  type ExecutionConstraints,
  type ToolCapability,
} from '../security/capabilities.js'

export type ExecutionKindSource = 'explicit' | 'legacy'
export type ExecutionBackendKind = 'host' | 'local' | 'sandbox'
export type ExecutionRoutingErrorCode =
  | 'legacy_execution_kind'
  | 'process_boundary_mismatch'
  | 'sandbox_unavailable'

export class ExecutionRoutingError extends Error {
  override readonly name = 'ExecutionRoutingError'

  constructor(readonly code: ExecutionRoutingErrorCode, message: string) {
    super(message)
  }
}

export interface ExecutionPreflightInput {
  readonly executionKind: ToolExecutionKind
  readonly executionKindSource: ExecutionKindSource
  readonly capabilities: readonly ToolCapability[]
  readonly constraints: ExecutionConstraints
}

export interface ExecutionPlan {
  readonly executionKind: ToolExecutionKind
  readonly executionKindSource: ExecutionKindSource
  readonly capabilities: readonly ToolCapability[]
  readonly backend: ExecutionBackendKind
  readonly constraints: ExecutionConstraints
}

export interface ExecutionRouterOptions {
  readonly profile?: ExecutionProfile
  readonly processExecutor?: Executor
}

type HostExecution = () => Promise<ExecutionResult>

export class ExecutionRouter {
  private readonly profile: ExecutionProfile
  private readonly processExecutor?: Executor

  constructor(options: ExecutionRouterOptions = {}) {
    this.profile = options.profile ?? 'development'
    this.processExecutor = options.processExecutor
  }

  preflight(input: ExecutionPreflightInput): ExecutionPlan {
    const parsedConstraints = parseExecutionConstraints(input.constraints)
    const parsedCapabilities = parseToolCapabilities(input.capabilities)
    // Resolved invocation snapshots are already deeply frozen. Validate them
    // again at the boundary, while preserving the exact approved references.
    const constraintsDeeplyFrozen = Object.isFrozen(input.constraints)
      && Object.values(input.constraints).every(
        (value) => !Array.isArray(value) || Object.isFrozen(value),
      )
    const constraints = constraintsDeeplyFrozen
      ? input.constraints
      : parsedConstraints
    const capabilities = Object.isFrozen(input.capabilities)
      ? input.capabilities
      : parsedCapabilities
    if (this.profile === 'production' && input.executionKindSource === 'legacy') {
      throw new ExecutionRoutingError(
        'legacy_execution_kind',
        'production profile 拒绝未显式声明 executionKind 的工具',
      )
    }
    if (this.profile === 'production'
      && capabilities.includes('process.execute')
      && input.executionKind !== 'process') {
      throw new ExecutionRoutingError(
        'process_boundary_mismatch',
        'production profile 拒绝从非 process lane 执行 process.execute',
      )
    }

    const requiresSandbox = input.executionKind === 'process' || constraints.requireSandbox === true
    if (requiresSandbox) {
      const executor = this.processExecutor
      const productionBackendInvalid = this.profile === 'production' && executor?.kind !== 'sandbox'
      let supported = false
      try {
        supported = executor?.supports(input.executionKind, constraints, capabilities) === true
      } catch {
        // Backend capability discovery is a security boundary and fails closed.
      }
      if (productionBackendInvalid || !executor || !supported) {
        throw new ExecutionRoutingError(
          'sandbox_unavailable',
          'requireSandbox 尚无可用执行后端，拒绝 dispatch',
        )
      }
      return Object.freeze({
        ...input,
        capabilities,
        constraints,
        backend: executor.kind,
      })
    }

    return Object.freeze({
      ...input,
      capabilities,
      constraints,
      backend: 'host' as const,
    })
  }

  async dispatch(
    plan: ExecutionPlan,
    request: ExecutionRequest,
    control: ExecutionControl,
    executeHost: HostExecution,
  ): Promise<ExecutionResult> {
    assertSerializableExecutionRequest(request)
    if (control.signal.aborted) {
      throw control.signal.reason instanceof Error
        ? control.signal.reason
        : new DOMException('Execution aborted', 'AbortError')
    }
    if (Date.now() >= request.deadline) {
      throw new DOMException('Execution deadline exceeded', 'TimeoutError')
    }
    if (request.executionKind !== plan.executionKind) {
      throw new Error('ExecutionRequest 与已批准 execution plan 不匹配')
    }
    const defensivePlan = this.preflight({
      executionKind: request.executionKind,
      executionKindSource: plan.executionKindSource,
      capabilities: request.capabilities,
      constraints: request.constraints,
    })
    if (defensivePlan.backend !== plan.backend
      || JSON.stringify(defensivePlan.capabilities) !== JSON.stringify(plan.capabilities)
      || JSON.stringify(defensivePlan.constraints) !== JSON.stringify(plan.constraints)) {
      throw new Error('ExecutionRequest 约束与已批准 execution plan 不匹配')
    }

    if (plan.backend !== 'host') {
      let supported = false
      try {
        supported = this.processExecutor?.kind === plan.backend
          && this.processExecutor.supports(
            plan.executionKind,
            plan.constraints,
            plan.capabilities,
          )
      } catch {
        // A backend that cannot revalidate its contract is no longer usable.
      }
      if (!supported || !this.processExecutor) {
        throw new ExecutionRoutingError('sandbox_unavailable', 'process backend 在 dispatch 前失效')
      }
      return this.processExecutor.execute(request, control)
    }
    return executeHost()
  }

  async close() {
    await this.processExecutor?.close()
  }
}
