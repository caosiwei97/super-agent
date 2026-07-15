import {
  assertSerializableExecutionRequest,
  type ExecutionControl,
  type ExecutionProfile,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ToolExecutionKind,
} from './executor.js'
import { parseExecutionConstraints, type ExecutionConstraints } from '../security/capabilities.js'

export type ExecutionKindSource = 'explicit' | 'legacy'
export type ExecutionBackendKind = 'host' | 'local' | 'sandbox'
export type ExecutionRoutingErrorCode = 'legacy_execution_kind' | 'sandbox_unavailable'

export class ExecutionRoutingError extends Error {
  override readonly name = 'ExecutionRoutingError'

  constructor(readonly code: ExecutionRoutingErrorCode, message: string) {
    super(message)
  }
}

export interface ExecutionPreflightInput {
  readonly executionKind: ToolExecutionKind
  readonly executionKindSource: ExecutionKindSource
  readonly constraints: ExecutionConstraints
}

export interface ExecutionPlan {
  readonly executionKind: ToolExecutionKind
  readonly executionKindSource: ExecutionKindSource
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
    const constraints = Object.isFrozen(input.constraints)
      ? input.constraints
      : parseExecutionConstraints(input.constraints)
    if (this.profile === 'production' && input.executionKindSource === 'legacy') {
      throw new ExecutionRoutingError(
        'legacy_execution_kind',
        'production profile 拒绝未显式声明 executionKind 的工具',
      )
    }

    const requiresSandbox = input.executionKind === 'process' || constraints.requireSandbox === true
    if (requiresSandbox) {
      const executor = this.processExecutor
      const productionBackendInvalid = this.profile === 'production' && executor?.kind !== 'sandbox'
      let supported = false
      try {
        supported = executor?.supports(input.executionKind, constraints) === true
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
        constraints,
        backend: executor.kind,
      })
    }

    return Object.freeze({
      ...input,
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
      constraints: request.constraints,
    })
    if (defensivePlan.backend !== plan.backend
      || JSON.stringify(defensivePlan.constraints) !== JSON.stringify(plan.constraints)) {
      throw new Error('ExecutionRequest 约束与已批准 execution plan 不匹配')
    }

    if (plan.backend !== 'host') {
      let supported = false
      try {
        supported = this.processExecutor?.kind === plan.backend
          && this.processExecutor.supports(plan.executionKind, plan.constraints)
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
