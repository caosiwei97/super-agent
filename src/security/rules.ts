import type { ToolCapability } from './capabilities.js'
import type {
  PolicyBehavior,
  PolicyContext,
  PolicyDecision,
  PolicyReasonCode,
  PolicyRule,
  PolicySourceType,
} from './policy-engine.js'
import { parseExecutionConstraints, parseToolCapabilities, type ExecutionConstraints } from './capabilities.js'

const APPROVAL_CAPABILITIES = new Set<ToolCapability>([
  'secret.read',
  'filesystem.write',
  'network.egress',
  'process.execute',
  'external.write',
  'user.interaction',
])

export function evaluateDefaultPolicy(context: PolicyContext): PolicyDecision {
  const needsApproval = context.capabilities.some((capability) => APPROVAL_CAPABILITIES.has(capability))
  return Object.freeze(needsApproval
    ? {
        behavior: 'ask' as const,
        constraints: context.constraints,
        reasonCode: 'policy.default.approval_required' as const,
      }
    : {
        behavior: 'allow' as const,
        constraints: context.constraints,
        reasonCode: 'policy.default.low_risk' as const,
      })
}

export interface CapabilityRuleOptions {
  readonly id: string
  readonly capabilities?: readonly ToolCapability[]
  readonly toolNames?: readonly string[]
  readonly sourceTypes?: readonly PolicySourceType[]
  readonly mcpServerNames?: readonly string[]
  readonly behavior: PolicyBehavior
  readonly constraints?: ExecutionConstraints
  readonly reasonCode: PolicyReasonCode
}

/** A small typed rule primitive; deliberately not a policy DSL. */
export function createCapabilityRule(options: CapabilityRuleOptions): PolicyRule {
  if (!/^[a-z][a-z0-9._-]*$/.test(options.id)) throw new TypeError('rule id 非法')
  const capabilities = options.capabilities === undefined
    ? undefined
    : parseToolCapabilities(options.capabilities)
  const toolNames = options.toolNames === undefined ? undefined : Object.freeze([...options.toolNames])
  const sourceTypes = options.sourceTypes === undefined ? undefined : Object.freeze([...options.sourceTypes])
  const mcpServerNames = options.mcpServerNames === undefined
    ? undefined
    : Object.freeze([...options.mcpServerNames])
  const constraints = parseExecutionConstraints(options.constraints ?? {})
  if (toolNames?.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new TypeError('toolNames 必须是非空字符串数组')
  }
  const allowedSources = new Set<PolicySourceType>(['cli', 'api', 'mcp', 'internal'])
  if (sourceTypes?.some((source) => !allowedSources.has(source))) throw new TypeError('sourceTypes 非法')
  if (mcpServerNames?.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new TypeError('mcpServerNames 必须是非空字符串数组')
  }
  if (options.behavior !== 'allow' && options.behavior !== 'ask' && options.behavior !== 'deny') {
    throw new TypeError('rule behavior 非法')
  }
  return Object.freeze({
    id: options.id,
    evaluate(context: PolicyContext): PolicyDecision | undefined {
      if (capabilities && !capabilities.every((item) => context.capabilities.includes(item))) return undefined
      if (toolNames && !toolNames.includes(context.toolName)) return undefined
      if (sourceTypes && !sourceTypes.includes(context.source.type)) return undefined
      if (mcpServerNames && (
        context.toolSource.kind !== 'mcp'
        || !mcpServerNames.includes(context.toolSource.serverName)
      )) return undefined
      if (options.behavior === 'deny') {
        return Object.freeze({ behavior: 'deny', reasonCode: options.reasonCode })
      }
      return Object.freeze({ behavior: options.behavior, constraints, reasonCode: options.reasonCode })
    },
  })
}
