import { jsonSchema, type ToolSet } from 'ai'
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import { AsyncReadWriteLock } from './async-rw-lock.js'

export interface MCPToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Narrow port keeps the registry independent from the MCP transport implementation. */
export interface MCPToolClient {
  connect(): Promise<void>
  listTools(): Promise<MCPToolDescriptor[]>
  callTool(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown>
  close(): Promise<void>
}

export interface ToolDescriptor {
  name: string
  description: string
  parameters: Record<string, unknown>
  capabilitySet: readonly string[]
  isConcurrencySafe: boolean
  isReadOnly: boolean
  requiresApproval: boolean
  maxResultChars: number
  shouldDefer: boolean
  searchHint?: string
}

export interface ToolDefinition extends Omit<
  ToolDescriptor,
  | 'capabilitySet'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'requiresApproval'
  | 'maxResultChars'
  | 'shouldDefer'
> {
  capabilitySet?: readonly string[]
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  requiresApproval?: boolean
  maxResultChars?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, context: ToolExecutionContext) => Promise<unknown>
  dispose?: () => Promise<void> | void
  shouldDefer?: boolean
}

export interface ToolInvocation {
  tool: ToolDescriptor
  input: unknown
  toolCallId: string
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal
  readonly deadline: number
}

export type ToolInputValidationResult =
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly error: string }

export interface ToolDispatchOptions extends ToolExecutionContext {
  beforeDispatch?: (invocation: ToolInvocation) => void | Promise<void>
}

export type ToolDispatchResult =
  | {
      readonly outcome: 'succeeded'
      readonly rawOutput: unknown
      readonly descriptor: ToolDescriptor
    }
  | {
      readonly outcome: 'uncertain'
      readonly errorCode: string
      readonly descriptor: ToolDescriptor
    }

const DEFAULT_MAX_RESULT_CHARS = 3_000
const TOOL_EXECUTION_ERROR = 'tool_execution_error'

interface RegisteredTool {
  readonly descriptor: ToolDescriptor
  readonly validate: ValidateFunction
  readonly execute: ToolDefinition['execute']
  readonly dispose?: ToolDefinition['dispose']
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

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  private readonly mcpClients: MCPToolClient[] = []
  private readonly discoveredTools = new Set<string>()
  private readonly executionLock = new AsyncReadWriteLock()
  private readonly ajv = new Ajv({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    strict: true,
    validateFormats: false,
  })
  private closePromise: Promise<void> | undefined
  private closed = false

  register(...tools: ToolDefinition[]) {
    if (this.closed) throw new Error('ToolRegistry 已关闭，不能继续注册工具')
    const incomingNames = new Set<string>()
    const registrations: RegisteredTool[] = []
    for (const tool of tools) {
      if (this.tools.has(tool.name) || incomingNames.has(tool.name)) {
        throw new Error(`工具重复注册: ${tool.name}`)
      }
      incomingNames.add(tool.name)

      const parameters = deepFreeze(
        cloneJsonValue(tool.parameters, `工具 ${tool.name} parameters`) as Record<string, unknown>,
      )
      const descriptor = deepFreeze({
        name: tool.name,
        description: tool.description,
        parameters,
        capabilitySet: [...(tool.capabilitySet ?? (
          tool.isReadOnly === true ? ['legacy.read'] : ['legacy.write']
        ))],
        isConcurrencySafe: tool.isConcurrencySafe === true,
        isReadOnly: tool.isReadOnly === true,
        requiresApproval: tool.requiresApproval === true || tool.isReadOnly !== true,
        maxResultChars: tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
        shouldDefer: tool.shouldDefer === true,
        ...(tool.searchHint === undefined ? {} : { searchHint: tool.searchHint }),
      } satisfies ToolDescriptor)
      registrations.push({
        descriptor,
        validate: this.ajv.compile(parameters),
        execute: tool.execute,
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
          isConcurrencySafe: false,
          isReadOnly: false,
          requiresApproval: true,
          capabilitySet: ['external.write'],
          maxResultChars: 3_000,
          shouldDefer: true,
          searchHint: `${serverName} ${tool.name} ${tool.description}`,
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

  /** @internal ToolExecutionPipeline is the only supported caller. */
  async dispatchTool(
    toolName: string,
    input: unknown,
    toolCallId: string,
    options: ToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    if (this.closed) throw new Error('ToolRegistry 已关闭')
    const tool = this.tools.get(toolName)
    if (!tool) throw new Error(`工具不存在: ${toolName}`)
    const validation = this.validateToolInput(toolName, input)
    if (!validation.ok) throw new Error(`工具 ${toolName} 输入无效: ${validation.error}`)

    const release = tool.descriptor.isConcurrencySafe
      ? await this.executionLock.acquireRead(options.signal)
      : await this.executionLock.acquireWrite(options.signal)
    const invocation = {
      tool: tool.descriptor,
      input: validation.input,
      toolCallId,
    }

    try {
      // Deliberately outside the tool error boundary. A durable-start failure
      // must reach the caller and must never be rewritten as an execution result.
      this.assertExecutionContext(options)
      await options.beforeDispatch?.(invocation)
      this.assertExecutionContext(options)
      try {
        return {
          outcome: 'succeeded',
          rawOutput: await tool.execute(validation.input, {
            signal: options.signal,
            deadline: options.deadline,
          }),
          descriptor: tool.descriptor,
        }
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

  private assertExecutionContext(context: ToolExecutionContext) {
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
