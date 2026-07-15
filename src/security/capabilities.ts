import path from 'node:path'

export const TOOL_CAPABILITIES = [
  'filesystem.read',
  'filesystem.write',
  'process.execute',
  'network.egress',
  'secret.read',
  'external.read',
  'external.write',
  'user.interaction',
] as const

export type ToolCapability = typeof TOOL_CAPABILITIES[number]

export interface ExecutionConstraints {
  readonly filesystemReadRoots?: readonly string[]
  readonly filesystemWriteRoots?: readonly string[]
  readonly networkSchemes?: readonly string[]
  readonly networkHosts?: readonly string[]
  readonly networkPorts?: readonly number[]
  readonly allowLoopbackListen?: boolean
  readonly loopbackListenPorts?: readonly number[]
  readonly requireSandbox?: boolean
  readonly maxResultChars?: number
}

export interface ToolSecurityDefinition<Input = unknown> {
  getCapabilities(input: Input): readonly ToolCapability[]
  getConstraints?(input: Input): ExecutionConstraints
  isConcurrencySafe(input: Input): boolean
}

export interface ResolvedToolInvocation {
  readonly capabilities: readonly ToolCapability[]
  readonly constraints: ExecutionConstraints
  readonly isConcurrencySafe: boolean
}

const CAPABILITY_SET = new Set<string>(TOOL_CAPABILITIES)
const CONSTRAINT_KEYS = new Set([
  'filesystemReadRoots',
  'filesystemWriteRoots',
  'networkSchemes',
  'networkHosts',
  'networkPorts',
  'allowLoopbackListen',
  'loopbackListenPorts',
  'requireSandbox',
  'maxResultChars',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unique<T>(values: readonly T[], field: string) {
  if (new Set(values).size !== values.length) throw new TypeError(`${field} 不能包含重复值`)
  return Object.freeze([...values])
}

function stringArray(value: unknown, field: string, validate: (item: string) => boolean) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !validate(item))) {
    throw new TypeError(`${field} 必须是合法字符串数组`)
  }
  return unique(value as string[], field)
}

function portArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some(
    (item) => !Number.isInteger(item) || (item as number) < 1 || (item as number) > 65_535,
  )) {
    throw new TypeError(`${field} 必须是 1..65535 的整数数组`)
  }
  return unique(value as number[], field)
}

export function parseToolCapabilities(value: unknown, field = 'capabilities'): readonly ToolCapability[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} 必须是数组`)
  for (const capability of value) {
    if (typeof capability !== 'string' || !CAPABILITY_SET.has(capability)) {
      throw new TypeError(`${field} 包含未知能力: ${String(capability)}`)
    }
  }
  return unique(value as ToolCapability[], field)
}

export function parseExecutionConstraints(value: unknown = {}): ExecutionConstraints {
  if (!isRecord(value)) throw new TypeError('constraints 必须是对象')
  const unknownKey = Object.keys(value).find((key) => !CONSTRAINT_KEYS.has(key))
  if (unknownKey) throw new TypeError(`constraints 包含未知字段: ${unknownKey}`)

  const result: Record<string, unknown> = {}
  const root = (item: string) => item.length > 0 && path.isAbsolute(item)
  const scheme = (item: string) => /^[a-z][a-z0-9+.-]*$/.test(item)
  const host = (item: string) => item.length > 0 && item === item.toLowerCase()
    && !/[\s/?#]/.test(item)

  if (value.filesystemReadRoots !== undefined) {
    result.filesystemReadRoots = stringArray(value.filesystemReadRoots, 'filesystemReadRoots', root)
  }
  if (value.filesystemWriteRoots !== undefined) {
    result.filesystemWriteRoots = stringArray(value.filesystemWriteRoots, 'filesystemWriteRoots', root)
  }
  if (value.networkSchemes !== undefined) {
    result.networkSchemes = stringArray(value.networkSchemes, 'networkSchemes', scheme)
  }
  if (value.networkHosts !== undefined) {
    result.networkHosts = stringArray(value.networkHosts, 'networkHosts', host)
  }
  if (value.networkPorts !== undefined) {
    result.networkPorts = portArray(value.networkPorts, 'networkPorts')
  }
  if (value.loopbackListenPorts !== undefined) {
    result.loopbackListenPorts = portArray(value.loopbackListenPorts, 'loopbackListenPorts')
  }
  for (const field of ['allowLoopbackListen', 'requireSandbox'] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') throw new TypeError(`${field} 必须是 boolean`)
      result[field] = value[field]
    }
  }
  if (value.maxResultChars !== undefined) {
    if (typeof value.maxResultChars !== 'number'
      || !Number.isInteger(value.maxResultChars)
      || value.maxResultChars < 1) {
      throw new TypeError('maxResultChars 必须是正整数')
    }
    result.maxResultChars = value.maxResultChars
  }
  return Object.freeze(result) as ExecutionConstraints
}

function intersectExact<T>(left: readonly T[] | undefined, right: readonly T[] | undefined) {
  if (left === undefined) return right === undefined ? undefined : [...right]
  if (right === undefined) return [...left]
  const allowed = new Set(right)
  return left.filter((item) => allowed.has(item))
}

function containsRoot(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function intersectRoots(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  if (left === undefined) return right === undefined ? undefined : [...right]
  if (right === undefined) return [...left]
  const roots: string[] = []
  for (const first of left) {
    for (const second of right) {
      const narrower = containsRoot(first, second) ? second : containsRoot(second, first) ? first : undefined
      if (narrower !== undefined && !roots.includes(narrower)) roots.push(narrower)
    }
  }
  return roots
}

/** Returns null when two non-empty boundaries have an empty intersection. */
export function intersectExecutionConstraints(
  leftValue: ExecutionConstraints,
  rightValue: ExecutionConstraints,
): ExecutionConstraints | null {
  const left = parseExecutionConstraints(leftValue)
  const right = parseExecutionConstraints(rightValue)
  const result: Record<string, unknown> = {}
  const lists = {
    filesystemReadRoots: intersectRoots(left.filesystemReadRoots, right.filesystemReadRoots),
    filesystemWriteRoots: intersectRoots(left.filesystemWriteRoots, right.filesystemWriteRoots),
    networkSchemes: intersectExact(left.networkSchemes, right.networkSchemes),
    networkHosts: intersectExact(left.networkHosts, right.networkHosts),
    networkPorts: intersectExact(left.networkPorts, right.networkPorts),
    loopbackListenPorts: intersectExact(left.loopbackListenPorts, right.loopbackListenPorts),
  }
  for (const [field, intersection] of Object.entries(lists)) {
    if (intersection === undefined) continue
    const bothSpecified = left[field as keyof ExecutionConstraints] !== undefined
      && right[field as keyof ExecutionConstraints] !== undefined
    if (bothSpecified && intersection.length === 0) return null
    result[field] = intersection
  }
  if (left.allowLoopbackListen !== undefined || right.allowLoopbackListen !== undefined) {
    result.allowLoopbackListen = (left.allowLoopbackListen ?? true) && (right.allowLoopbackListen ?? true)
  }
  if (left.requireSandbox !== undefined || right.requireSandbox !== undefined) {
    result.requireSandbox = (left.requireSandbox ?? false) || (right.requireSandbox ?? false)
  }
  if (left.maxResultChars !== undefined || right.maxResultChars !== undefined) {
    result.maxResultChars = Math.min(left.maxResultChars ?? Infinity, right.maxResultChars ?? Infinity)
  }
  return parseExecutionConstraints(result)
}

export function resolveToolInvocation<Input>(
  definition: ToolSecurityDefinition<Input>,
  input: Input,
): ResolvedToolInvocation {
  const capabilities = parseToolCapabilities(definition.getCapabilities(input))
  const constraints = parseExecutionConstraints(definition.getConstraints?.(input) ?? {})
  const isConcurrencySafe = definition.isConcurrencySafe(input)
  if (typeof isConcurrencySafe !== 'boolean') throw new TypeError('isConcurrencySafe 必须返回 boolean')
  return Object.freeze({ capabilities, constraints, isConcurrencySafe })
}
