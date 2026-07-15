import {
  intersectExecutionConstraints,
  parseExecutionConstraints,
  parseToolCapabilities,
  type ExecutionConstraints,
  type ToolCapability,
} from './capabilities.js'
import { evaluateDefaultPolicy } from './rules.js'

export type PolicyToolSource =
  | { readonly kind: 'local' }
  | { readonly kind: 'mcp'; readonly serverName: string }

export type PolicyBehavior = 'allow' | 'ask' | 'deny'

export type PolicyReasonCode =
  | 'policy.hard_deny.secret_exfiltration'
  | 'policy.input.invalid'
  | 'policy.input.unknown_capability'
  | 'policy.constraints.empty_intersection'
  | 'policy.hook.error'
  | 'policy.hook.invalid'
  | 'policy.hook.permission_expansion'
  | 'policy.rule.error'
  | 'policy.rule.invalid'
  | 'policy.default.low_risk'
  | 'policy.default.approval_required'
  | `hook.${string}`
  | `rule.${string}`

export type PolicyDecision =
  | {
      readonly behavior: 'allow' | 'ask'
      readonly constraints: ExecutionConstraints
      readonly reasonCode: PolicyReasonCode
    }
  | {
      readonly behavior: 'deny'
      readonly reasonCode: PolicyReasonCode
    }

export type PolicySourceType = 'cli' | 'api' | 'mcp' | 'internal'

export interface PolicySource {
  readonly type: PolicySourceType
  readonly nonInteractive: boolean
  readonly id?: string
}

export interface PolicyContext {
  readonly toolName: string
  readonly input: unknown
  readonly capabilities: readonly ToolCapability[]
  readonly constraints: ExecutionConstraints
  readonly batchCapabilities: readonly ToolCapability[]
  readonly priorCapabilities: readonly ToolCapability[]
  readonly toolSource: PolicyToolSource
  readonly source: PolicySource
  readonly signal: AbortSignal
  readonly deadline: number
}

export interface PolicyContextInput {
  readonly toolName: string
  readonly input: unknown
  readonly capabilities: readonly ToolCapability[]
  readonly constraints?: ExecutionConstraints
  readonly batchCapabilities?: readonly ToolCapability[]
  readonly priorCapabilities?: readonly ToolCapability[]
  readonly toolSource: PolicyToolSource
  readonly source: PolicySource
  readonly signal: AbortSignal
  readonly deadline: number
}

export type PolicyTighteningHook = (
  context: PolicyContext,
  current: PolicyDecision,
) => PolicyDecision | undefined | Promise<PolicyDecision | undefined>

export interface PolicyRule {
  readonly id: string
  evaluate(context: PolicyContext): PolicyDecision | undefined
}

export interface PolicyEngineOptions {
  readonly hooks?: readonly PolicyTighteningHook[]
  readonly rules?: readonly PolicyRule[]
}

const SOURCE_KEYS = new Set(['type', 'nonInteractive', 'id'])
const SOURCE_TYPES = new Set<PolicySourceType>(['cli', 'api', 'mcp', 'internal'])
const REASON_CODE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/

function frozenDecision(decision: PolicyDecision): PolicyDecision {
  if (decision.behavior === 'deny') return Object.freeze({ ...decision })
  return Object.freeze({ ...decision, constraints: parseExecutionConstraints(decision.constraints) })
}

function deny(reasonCode: PolicyReasonCode): PolicyDecision {
  return frozenDecision({ behavior: 'deny', reasonCode })
}

function parseSource(value: unknown): PolicySource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('source 必须是结构化对象')
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !SOURCE_KEYS.has(key))
  if (unknown) throw new TypeError(`source 包含未知字段: ${unknown}`)
  if (typeof record.type !== 'string' || !SOURCE_TYPES.has(record.type as PolicySourceType)) {
    throw new TypeError('source.type 非法')
  }
  if (typeof record.nonInteractive !== 'boolean') throw new TypeError('source.nonInteractive 必须是 boolean')
  if (record.id !== undefined && (typeof record.id !== 'string' || record.id.length === 0)) {
    throw new TypeError('source.id 必须是非空字符串')
  }
  return Object.freeze({
    type: record.type as PolicySourceType,
    nonInteractive: record.nonInteractive,
    ...(record.id === undefined ? {} : { id: record.id as string }),
  })
}

function parseToolSource(value: unknown): PolicyToolSource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('toolSource 必须是结构化对象')
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'local' && Object.keys(record).length === 1) {
    return Object.freeze({ kind: 'local' })
  }
  if (record.kind === 'mcp' && Object.keys(record).every((key) => ['kind', 'serverName'].includes(key))
    && Object.keys(record).length === 2
    && typeof record.serverName === 'string' && record.serverName.length > 0) {
    return Object.freeze({ kind: 'mcp', serverName: record.serverName })
  }
  throw new TypeError('toolSource 非法')
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === 'object'
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).addEventListener === 'function'
    && typeof (value as AbortSignal).throwIfAborted === 'function'
}

export function createPolicyContext(input: PolicyContextInput): PolicyContext {
  if (input === null || typeof input !== 'object') throw new TypeError('PolicyContext 必须是对象')
  if (typeof input.toolName !== 'string' || input.toolName.length === 0) {
    throw new TypeError('toolName 必须是非空字符串')
  }
  if (!isAbortSignal(input.signal)) throw new TypeError('signal 必须是 AbortSignal')
  if (!Number.isFinite(input.deadline) || input.deadline <= 0) throw new TypeError('deadline 必须是有限正数')
  return Object.freeze({
    toolName: input.toolName,
    input: input.input,
    capabilities: parseToolCapabilities(input.capabilities),
    constraints: parseExecutionConstraints(input.constraints ?? {}),
    batchCapabilities: parseToolCapabilities(input.batchCapabilities ?? [], 'batchCapabilities'),
    priorCapabilities: parseToolCapabilities(input.priorCapabilities ?? [], 'priorCapabilities'),
    toolSource: parseToolSource(input.toolSource),
    source: parseSource(input.source),
    signal: input.signal,
    deadline: input.deadline,
  })
}

function assertRuntime(context: PolicyContext) {
  context.signal.throwIfAborted()
  if (Date.now() >= context.deadline) throw new DOMException('Policy deadline exceeded', 'TimeoutError')
}

function isControlFlowError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function parseDecision(value: unknown): PolicyDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PolicyDecision 必须是对象')
  }
  const record = value as Record<string, unknown>
  if (record.behavior !== 'allow' && record.behavior !== 'ask' && record.behavior !== 'deny') {
    throw new TypeError('PolicyDecision.behavior 非法')
  }
  if (typeof record.reasonCode !== 'string' || !REASON_CODE.test(record.reasonCode)) {
    throw new TypeError('PolicyDecision.reasonCode 非法')
  }
  const expected = record.behavior === 'deny'
    ? new Set(['behavior', 'reasonCode'])
    : new Set(['behavior', 'constraints', 'reasonCode'])
  const unknown = Object.keys(record).find((key) => !expected.has(key))
  if (unknown) throw new TypeError(`PolicyDecision 包含未知字段: ${unknown}`)
  if (record.behavior === 'deny') {
    if ('constraints' in record) throw new TypeError('deny 不能携带 constraints')
    return frozenDecision({ behavior: 'deny', reasonCode: record.reasonCode as PolicyReasonCode })
  }
  return frozenDecision({
    behavior: record.behavior,
    constraints: parseExecutionConstraints(record.constraints),
    reasonCode: record.reasonCode as PolicyReasonCode,
  })
}

const BEHAVIOR_RANK: Record<PolicyBehavior, number> = { allow: 0, ask: 1, deny: 2 }

function tightenDecision(current: PolicyDecision, candidateValue: unknown, source: 'hook' | 'rule') {
  let candidate: PolicyDecision
  try {
    candidate = parseDecision(candidateValue)
  } catch {
    return deny(source === 'hook' ? 'policy.hook.invalid' : 'policy.rule.invalid')
  }
  if (BEHAVIOR_RANK[candidate.behavior] < BEHAVIOR_RANK[current.behavior]) {
    return source === 'hook'
      ? deny('policy.hook.permission_expansion')
      : current
  }
  if (candidate.behavior === 'deny') return candidate
  if (current.behavior === 'deny') return current
  const constraints = intersectExecutionConstraints(current.constraints, candidate.constraints)
  if (constraints === null) return deny('policy.constraints.empty_intersection')
  return frozenDecision({
    behavior: candidate.behavior,
    constraints,
    reasonCode: candidate.reasonCode,
  })
}

function hardDeny(context: PolicyContext): PolicyDecision | undefined {
  const planned = new Set([
    ...context.capabilities,
    ...context.batchCapabilities,
  ])
  const prior = new Set(context.priorCapabilities)
  if ((planned.has('secret.read') && planned.has('network.egress'))
    || (prior.has('secret.read') && planned.has('network.egress'))) {
    return deny('policy.hard_deny.secret_exfiltration')
  }
  return undefined
}

function invalidInputDecision(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return deny(message.includes('未知能力')
    ? 'policy.input.unknown_capability'
    : 'policy.input.invalid')
}

export class PolicyEngine {
  private readonly hooks: readonly PolicyTighteningHook[]
  private readonly rules: readonly PolicyRule[]

  constructor(options: PolicyEngineOptions = {}) {
    this.hooks = Object.freeze([...(options.hooks ?? [])])
    this.rules = Object.freeze([...(options.rules ?? [])])
  }

  async evaluate(input: PolicyContextInput): Promise<PolicyDecision> {
    let context: PolicyContext
    try {
      context = createPolicyContext(input)
    } catch (error) {
      return invalidInputDecision(error)
    }
    assertRuntime(context)
    const blocked = hardDeny(context)
    if (blocked) return blocked

    let current = frozenDecision({
      behavior: 'allow',
      constraints: context.constraints,
      reasonCode: 'policy.default.low_risk',
    })
    for (const hook of this.hooks) {
      assertRuntime(context)
      let candidate: PolicyDecision | undefined
      try {
        candidate = await hook(context, current)
      } catch (error) {
        assertRuntime(context)
        if (isControlFlowError(error)) throw error
        return deny('policy.hook.error')
      }
      assertRuntime(context)
      if (candidate !== undefined) current = tightenDecision(current, candidate, 'hook')
      if (current.behavior === 'deny') return current
    }

    let ruleDecision: PolicyDecision | undefined
    for (const rule of this.rules) {
      try {
        ruleDecision = rule.evaluate(context)
      } catch {
        return deny('policy.rule.error')
      }
      if (ruleDecision !== undefined) break
    }
    const selected = ruleDecision ?? evaluateDefaultPolicy(context)
    return tightenDecision(current, selected, 'rule')
  }
}
