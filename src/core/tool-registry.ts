import { jsonSchema, type ToolSet } from 'ai'
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  parseToolCapabilities,
  resolveToolInvocation as resolveToolSecurity,
  type ExecutionConstraints,
  type ToolCapability,
} from '../security/capabilities.js'
import {
  installInternalToolDispatcher,
  type InternalToolDispatchOptions,
} from '../execution/internal-tool-dispatch.js'
import { ExecutionRouter } from '../execution/execution-router.js'
import type {
  ExecutionResult,
  ToolExecutionKind,
} from '../execution/executor.js'
import { TOOL_EXECUTION_KINDS } from '../execution/executor.js'
import { AsyncReadWriteLock } from './async-rw-lock.js'

export interface MCPToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Narrow port keeps the registry independent from the MCP transport implementation. */
export interface MCPToolClient {
  readonly endpointOrigin: string
  connect(): Promise<void>
  listTools(): Promise<MCPToolDescriptor[]>
  callTool(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown>
  close(): Promise<void>
}

export interface ToolDescriptor {
  name: string
  description: string
  parameters: Record<string, unknown>
  maxResultChars: number
  shouldDefer: boolean
  searchHint?: string
}

export interface ToolDefinition extends Omit<
  ToolDescriptor,
  | 'maxResultChars'
  | 'shouldDefer'
> {
  getCapabilities?: (input: unknown) => readonly ToolCapability[]
  getConstraints?: (input: unknown) => ExecutionConstraints
  /** Constraint fields actively enforced by the execution closure. */
  supportedConstraintKeys?: readonly (keyof ExecutionConstraints)[]
  capabilitySet?: readonly ToolCapability[]
  isConcurrencySafe?: boolean | ((input: unknown) => boolean)
  isReadOnly?: boolean
  requiresApproval?: boolean
  maxResultChars?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, context: ToolExecutionContext) => Promise<unknown>
  dispose?: () => Promise<void> | void
  shouldDefer?: boolean
  /** Registry provenance; MCP registration sets this structurally. */
  toolSource?: ToolSource
  /** M3 execution lane. Optional for one compatibility release only. */
  executionKind?: ToolExecutionKind
}

export interface ToolInvocation {
  tool: ToolDescriptor
  input: unknown
  toolCallId: string
}

export type ToolSource =
  | { readonly kind: 'local' }
  | { readonly kind: 'mcp'; readonly serverName: string }

export interface ResolvedToolInvocation extends ToolInvocation {
  readonly capabilities: readonly ToolCapability[]
  readonly constraints: ExecutionConstraints
  readonly supportedConstraintKeys: readonly (keyof ExecutionConstraints)[]
  readonly isConcurrencySafe: boolean
  readonly securitySource: 'explicit' | 'legacy'
  readonly legacyRequiresApproval: boolean
  readonly toolSource: ToolSource
  readonly executionKind: ToolExecutionKind
  readonly executionKindSource: 'explicit' | 'legacy'
}

export type ToolInvocationResolution =
  | { readonly ok: true; readonly invocation: ResolvedToolInvocation }
  | {
      readonly ok: false
      readonly code: 'unknown_tool' | 'invalid_input' | 'capability_resolution_failed'
      readonly error: string
      readonly input: unknown
      readonly tool?: ToolDescriptor
    }

export interface ToolRuntimeContext {
  readonly signal: AbortSignal
  readonly deadline: number
}

export interface ToolExecutionContext extends ToolRuntimeContext {
  /** Present on every governed Pipeline dispatch; optional only for one direct-test compatibility release. */
  readonly operationId?: string
  readonly attemptId?: string
  readonly idempotencyKey?: string
  readonly capabilities: readonly ToolCapability[]
  readonly constraints: ExecutionConstraints
}

export type ToolInputValidationResult =
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly error: string }

export interface ToolRegistryOptions {
  readonly onLegacyWarning?: (message: string) => void
  readonly executionRouter?: ExecutionRouter
}

export type ToolDispatchResult =
  | {
      readonly outcome: 'succeeded'
      readonly rawOutput: unknown
      readonly descriptor: ToolDescriptor
    }
  | {
      readonly outcome: 'failed'
      readonly errorCode: string
      readonly proof: 'no_side_effect'
      readonly descriptor: ToolDescriptor
    }
  | {
      readonly outcome: 'uncertain'
      readonly errorCode: string
      readonly descriptor: ToolDescriptor
    }

const DEFAULT_MAX_RESULT_CHARS = 3_000
const TOOL_EXECUTION_ERROR = 'tool_execution_error'
const EXECUTION_CONSTRAINT_KEYS = new Set<keyof ExecutionConstraints>([
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

interface RegisteredTool {
  readonly descriptor: ToolDescriptor
  readonly validate: ValidateFunction
  readonly execute: ToolDefinition['execute']
  readonly dispose?: ToolDefinition['dispose']
  readonly getCapabilities: (input: unknown) => readonly ToolCapability[]
  readonly getConstraints: (input: unknown) => ExecutionConstraints
  readonly supportedConstraintKeys: readonly (keyof ExecutionConstraints)[]
  readonly isConcurrencySafe: (input: unknown) => boolean
  readonly securitySource: 'explicit' | 'legacy'
  readonly legacyRequiresApproval: boolean
  readonly toolSource: ToolSource
  readonly executionKind?: ToolExecutionKind
  readonly executionKindSource: 'explicit' | 'legacy'
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member)
    Object.freeze(value)
  }
  return value
}

function cloneJsonValue(value: unknown, field: string) {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new Error(`${field} 必须是可序列化 JSON`, { cause: error })
  }
  if (serialized === undefined) throw new Error(`${field} 必须是可序列化 JSON`)
  return JSON.parse(serialized) as unknown
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined) {
  if (!errors?.length) return '输入不符合工具 schema'
  return errors.map((error) => {
    const location = error.instancePath || '<root>'
    return `${location} ${error.message || error.keyword}`
  }).join('; ')
}

function createStrictAjv() {
  return new Ajv({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    strict: true,
    validateFormats: false,
  })
}

function createStrictMcpAjv() {
  return new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    strict: true,
    validateFormats: false,
    allowUnionTypes: true,
  }).addKeyword({
    // GitHub's hosted MCP currently annotates generated input schemas with
    // this extension. It has no validation semantics, so accept only this
    // known annotation while keeping every other unknown keyword strict.
    keyword: 'x-mcp-header',
    valid: true,
  })
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  private readonly mcpClients: MCPToolClient[] = []
  private readonly discoveredTools = new Set<string>()
  private readonly executionLock = new AsyncReadWriteLock()
  private readonly resolvedInvocations = new WeakSet<object>()
  private readonly legacyWarnings = new Set<string>()
  private readonly localAjv = createStrictAjv()
  private readonly mcpAjv = createStrictMcpAjv()
  private closePromise: Promise<void> | undefined
  private closed = false
  private readonly executionRouter: ExecutionRouter

  constructor(private readonly options: ToolRegistryOptions = {}) {
    this.executionRouter = options.executionRouter ?? new ExecutionRouter()
    installInternalToolDispatcher(this, (invocation, dispatchOptions) =>
      this.dispatchInternal(invocation, dispatchOptions), (invocation, constraints) =>
      this.executionRouter.preflight({
        executionKind: invocation.executionKind,
        executionKindSource: invocation.executionKindSource,
        capabilities: invocation.capabilities,
        constraints,
      }))
  }

  register(...tools: ToolDefinition[]) {
    if (this.closed) throw new Error('ToolRegistry 已关闭，不能继续注册工具')
    const incomingNames = new Set<string>()
    const registrations: RegisteredTool[] = []
    for (const tool of tools) {
      if (this.tools.has(tool.name) || incomingNames.has(tool.name)) {
        throw new Error(`工具重复注册: ${tool.name}`)
      }
      incomingNames.add(tool.name)
      if (tool.executionKind !== undefined && !TOOL_EXECUTION_KINDS.includes(tool.executionKind)) {
        throw new TypeError(`工具 ${tool.name} executionKind 非法: ${String(tool.executionKind)}`)
      }

      const parameters = deepFreeze(
        cloneJsonValue(tool.parameters, `工具 ${tool.name} parameters`) as Record<string, unknown>,
      )
      const explicitSecurity = tool.getCapabilities !== undefined
      const legacyCapabilities = explicitSecurity
        ? Object.freeze([]) as readonly ToolCapability[]
        : parseToolCapabilities(tool.capabilitySet ?? (
            tool.isReadOnly === true ? ['external.read'] : ['external.write']
          ), `工具 ${tool.name} capabilitySet`)
      const getCapabilities = explicitSecurity
        ? tool.getCapabilities!
        : () => legacyCapabilities
      const getConstraints = explicitSecurity
        ? (tool.getConstraints ?? (() => Object.freeze({})))
        : () => Object.freeze({})
      const supportedConstraintKeys = this.parseSupportedConstraintKeys(
        tool.name,
        tool.supportedConstraintKeys,
        explicitSecurity,
      )
      const concurrencyResolver = typeof tool.isConcurrencySafe === 'function'
        ? tool.isConcurrencySafe
        : () => tool.isConcurrencySafe === true
      const legacyRequiresApproval = !explicitSecurity && (
        tool.requiresApproval === true || tool.isReadOnly !== true
      )
      const toolSource = this.parseToolSource(tool.toolSource)
      const executionKindSource = tool.executionKind === undefined ? 'legacy' : 'explicit'
      if (!explicitSecurity) this.warnLegacyOnce(tool.name)

      const descriptor = deepFreeze({
        name: tool.name,
        description: tool.description,
        parameters,
        maxResultChars: tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
        shouldDefer: tool.shouldDefer === true,
        ...(tool.searchHint === undefined ? {} : { searchHint: tool.searchHint }),
      } satisfies ToolDescriptor)
      registrations.push({
        descriptor,
        validate: (toolSource.kind === 'mcp' ? this.mcpAjv : this.localAjv).compile(parameters),
        execute: tool.execute,
        getCapabilities,
        getConstraints,
        supportedConstraintKeys,
        isConcurrencySafe: concurrencyResolver,
        securitySource: explicitSecurity ? 'explicit' : 'legacy',
        legacyRequiresApproval,
        toolSource,
        ...(tool.executionKind === undefined ? {} : { executionKind: tool.executionKind }),
        executionKindSource,
        ...(tool.dispose === undefined ? {} : { dispose: tool.dispose }),
      })
    }
    for (const registration of registrations) {
      this.tools.set(registration.descriptor.name, registration)
    }
  }

  async registerMCPServer(serverName: string, client: MCPToolClient) {
    if (this.closed) throw new Error('ToolRegistry 已关闭，不能连接 MCP Server')

    try {
      const endpoint = this.parseMCPEndpoint(client.endpointOrigin, serverName)
      await client.connect()
      const tools = await client.listTools()
      const definitions: ToolDefinition[] = []

      for (const tool of tools) {
        const prefixedName = `mcp__${serverName}__${tool.name}`
        if (this.tools.has(prefixedName)) continue

        const originalName = tool.name
        definitions.push({
          name: prefixedName,
          description: `[MCP:${serverName}] ${tool.description}`,
          parameters: tool.inputSchema,
          // MCP schemas do not expose trustworthy read/write metadata. Default to
          // serialized execution with explicit approval.
          getCapabilities: () => ['network.egress', 'external.write'],
          getConstraints: () => ({
            networkSchemes: [endpoint.protocol.slice(0, -1)],
            networkHosts: [endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase()],
            networkPorts: [endpoint.port === ''
              ? endpoint.protocol === 'https:' ? 443 : 80
              : Number(endpoint.port)],
            maxResultChars: 3_000,
          }),
          supportedConstraintKeys: ['networkSchemes', 'networkHosts', 'networkPorts'],
          isConcurrencySafe: () => false,
          maxResultChars: 3_000,
          shouldDefer: true,
          searchHint: `${serverName} ${tool.name} ${tool.description}`,
          toolSource: { kind: 'mcp', serverName },
          executionKind: 'mcp',
          execute: (input, context) => client.callTool(originalName, input, context),
        })
      }

      this.register(...definitions)
      this.mcpClients.push(client)
      return definitions.map((tool) => tool.name)
    } catch (error) {
      try {
        await client.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], `MCP Server ${serverName} 注册及回滚均失败`)
      }
      throw error
    }
  }

  getDescriptor(name: string) {
    return this.tools.get(name)?.descriptor
  }

  /** @deprecated Prefer getDescriptor; this alias now returns metadata only. */
  get(name: string) {
    return this.getDescriptor(name)
  }

  getAll() {
    return Array.from(this.tools.values(), (tool) => tool.descriptor)
  }

  getActiveTools() {
    return this.getAll().filter((tool) => !this.isDeferred(tool))
  }

  getDeferredToolSummary() {
    const deferred = this.getAll().filter((tool) => this.isDeferred(tool))
    if (deferred.length === 0) return ''

    const lines = deferred.map((tool) => {
      const hint = tool.searchHint ? ` — ${tool.searchHint}` : ''
      return `  - ${tool.name}${hint}`
    })
    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  searchTools(query: string) {
    const names = query.includes(',')
      ? query.split(',').map((name) => name.trim()).filter(Boolean)
      : [query.trim()]
    const results: ToolDescriptor[] = []

    for (const name of names) {
      const tool = this.tools.get(name)?.descriptor
      if (!tool || tool.name === 'tool_search') continue
      results.push(tool)
      this.discoveredTools.add(tool.name)
    }
    return results
  }

  countTokenEstimate() {
    let active = 0
    let deferred = 0

    for (const { descriptor: tool } of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length
      const tokens = Math.ceil(schemaSize / 4)
      if (this.isDeferred(tool)) deferred += tokens
      else active += tokens
    }
    return { active, deferred, total: active + deferred }
  }

  /** Model-facing tools contain schemas only and can never execute implicitly. */
  toModelToolSet() {
    const result: Record<string, unknown> = {}

    for (const tool of this.getActiveTools()) {
      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters),
      }
    }

    return result as ToolSet
  }

  validateToolInput(toolName: string, input: unknown): ToolInputValidationResult {
    const tool = this.tools.get(toolName)
    if (!tool) return { ok: false, error: `工具不存在: ${toolName}` }

    let safeInput: unknown
    try {
      safeInput = deepFreeze(cloneJsonValue(input, `工具 ${toolName} input`))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const valid = tool.validate(safeInput)
    if (valid) return { ok: true, input: safeInput }
    return { ok: false, error: formatValidationErrors(tool.validate.errors) }
  }

  resolveInvocation(toolName: string, input: unknown, toolCallId: string): ToolInvocationResolution {
    const tool = this.tools.get(toolName)
    if (!tool) return { ok: false, code: 'unknown_tool', error: `工具不存在: ${toolName}`, input }
    const validation = this.validateToolInput(toolName, input)
    if (!validation.ok) {
      return {
        ok: false,
        code: 'invalid_input',
        error: validation.error,
        input,
        tool: tool.descriptor,
      }
    }

    try {
      const security = resolveToolSecurity({
        getCapabilities: tool.getCapabilities,
        getConstraints: tool.getConstraints,
        isConcurrencySafe: tool.isConcurrencySafe,
      }, validation.input)
      const unsupported = (Object.keys(security.constraints) as (keyof ExecutionConstraints)[])
        .find((key) => key !== 'maxResultChars' && !tool.supportedConstraintKeys.includes(key))
      if (unsupported) throw new Error(`工具 ${toolName} 未声明可执行约束: ${unsupported}`)
      const invocation = Object.freeze({
        tool: tool.descriptor,
        input: validation.input,
        toolCallId,
        capabilities: security.capabilities,
        constraints: security.constraints,
        supportedConstraintKeys: tool.supportedConstraintKeys,
        isConcurrencySafe: security.isConcurrencySafe,
        securitySource: tool.securitySource,
        legacyRequiresApproval: tool.legacyRequiresApproval,
        toolSource: tool.toolSource,
        executionKind: tool.executionKind ?? this.inferLegacyExecutionKind(
          security.capabilities,
          tool.toolSource,
        ),
        executionKindSource: tool.executionKindSource,
      } satisfies ResolvedToolInvocation)
      this.resolvedInvocations.add(invocation)
      return { ok: true, invocation }
    } catch (error) {
      return {
        ok: false,
        code: 'capability_resolution_failed',
        error: error instanceof Error ? error.message : String(error),
        input: validation.input,
        tool: tool.descriptor,
      }
    }
  }

  private async dispatchInternal(
    invocation: ResolvedToolInvocation,
    options: InternalToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    if (this.closed) throw new Error('ToolRegistry 已关闭')
    if (!this.resolvedInvocations.has(invocation)) throw new Error('拒绝未由 ToolRegistry 解析的 invocation')
    const tool = this.tools.get(invocation.tool.name)
    if (!tool || tool.descriptor !== invocation.tool) throw new Error('resolved invocation 已失效')

    const release = invocation.isConcurrencySafe
      ? await this.executionLock.acquireRead(options.signal)
      : await this.executionLock.acquireWrite(options.signal)

    try {
      // Deliberately outside the tool error boundary. A durable-start failure
      // must reach the caller and must never be rewritten as an execution result.
      this.assertExecutionContext(options)
      await options.beforeDispatch?.(invocation)
      this.assertExecutionContext(options)
      try {
        const executionResult = await this.executionRouter.dispatch(
          options.plan,
          {
            schemaVersion: 1,
            operationId: options.operationId,
            attemptId: options.attemptId,
            ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
            toolCallId: invocation.toolCallId,
            toolName: invocation.tool.name,
            executionKind: invocation.executionKind,
            input: invocation.input,
            capabilities: invocation.capabilities,
            constraints: options.constraints,
            deadline: options.deadline,
          },
          { signal: options.signal },
          async (): Promise<ExecutionResult> => ({
            outcome: 'succeeded',
            rawOutput: await tool.execute(invocation.input, {
              signal: options.signal,
              deadline: options.deadline,
              operationId: options.operationId,
              attemptId: options.attemptId,
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
              capabilities: invocation.capabilities,
              constraints: options.constraints,
            }),
          }),
        )
        return { ...executionResult, descriptor: tool.descriptor }
      } catch {
        // Once invocation begins, a generic rejection cannot prove that no side
        // effect occurred. The Pipeline may reconcile it, but must not mark failed.
        return {
          outcome: 'uncertain',
          errorCode: TOOL_EXECUTION_ERROR,
          descriptor: tool.descriptor,
        }
      }
    } finally {
      release()
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = this.closeResources()
    return this.closePromise
  }

  private async closeResources() {
    const release = await this.executionLock.acquireWrite()
    try {
      const disposers = [...this.tools.values()]
        .flatMap((tool) => (tool.dispose ? [tool.dispose] : []))
      const operations = [
        ...disposers.map((dispose) => Promise.resolve().then(dispose)),
        ...this.mcpClients.map((client) => client.close()),
        this.executionRouter.close(),
      ]
      this.mcpClients.length = 0

      const results = await Promise.allSettled(operations)
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, '部分工具资源关闭失败')
    } finally {
      release()
    }
  }

  private isDeferred(tool: ToolDescriptor) {
    return tool.shouldDefer === true && !this.discoveredTools.has(tool.name)
  }

  private warnLegacyOnce(toolName: string) {
    if (this.legacyWarnings.has(toolName)) return
    this.legacyWarnings.add(toolName)
    this.options.onLegacyWarning?.(
      `工具 ${toolName} 使用 legacy capabilitySet/isReadOnly/requiresApproval；请迁移到 getCapabilities`,
    )
  }

  private parseToolSource(source: ToolSource | undefined): ToolSource {
    if (source === undefined || source.kind === 'local') return Object.freeze({ kind: 'local' })
    if (source.kind !== 'mcp' || typeof source.serverName !== 'string' || source.serverName.trim() === '') {
      throw new TypeError('toolSource MCP serverName 必须为非空字符串')
    }
    return Object.freeze({ kind: 'mcp', serverName: source.serverName })
  }

  private inferLegacyExecutionKind(
    capabilities: readonly ToolCapability[],
    source: ToolSource,
  ): ToolExecutionKind {
    if (source.kind === 'mcp') return 'mcp'
    if (capabilities.includes('process.execute')) return 'process'
    if (capabilities.includes('network.egress')) return 'network'
    if (capabilities.some((capability) => capability.startsWith('filesystem.'))) return 'filesystem'
    return 'pure'
  }

  private parseSupportedConstraintKeys(
    toolName: string,
    value: readonly (keyof ExecutionConstraints)[] | undefined,
    explicitSecurity: boolean,
  ) {
    if (!explicitSecurity && value !== undefined) {
      throw new TypeError(`legacy 工具 ${toolName} 不能声明 supportedConstraintKeys`)
    }
    const keys = value ?? []
    const unknown = keys.find((key) => !EXECUTION_CONSTRAINT_KEYS.has(key))
    if (unknown) throw new TypeError(`工具 ${toolName} supportedConstraintKeys 非法: ${String(unknown)}`)
    if (new Set(keys).size !== keys.length) {
      throw new TypeError(`工具 ${toolName} supportedConstraintKeys 不能重复`)
    }
    return Object.freeze([...keys])
  }

  private parseMCPEndpoint(endpointOrigin: string, serverName: string) {
    let endpoint: URL
    try {
      endpoint = new URL(endpointOrigin)
    } catch (error) {
      throw new TypeError(`MCP Server ${serverName} endpointOrigin 非法`, { cause: error })
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.origin !== endpointOrigin) {
      throw new TypeError(`MCP Server ${serverName} endpointOrigin 必须是规范 HTTP(S) origin`)
    }
    return endpoint
  }

  private assertExecutionContext(context: ToolRuntimeContext) {
    if (context.signal.aborted) {
      throw context.signal.reason instanceof Error
        ? context.signal.reason
        : new DOMException('Tool execution aborted', 'AbortError')
    }
    if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline) {
      throw new DOMException('Tool execution deadline exceeded', 'TimeoutError')
    }
  }
}

export function truncateResult(text: string, maxChars = DEFAULT_MAX_RESULT_CHARS) {
  if (text.length <= maxChars) return text

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const dropped = text.length - headSize - tailSize
  return `${text.slice(0, headSize)}\n\n... [省略 ${dropped} 字符] ...\n\n${text.slice(-tailSize)}`
}
