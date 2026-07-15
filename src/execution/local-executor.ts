import {
  assertSerializableExecutionRequest,
  type ExecutionControl,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ToolExecutionKind,
} from './executor.js'
import { ProcessController } from './process-controller.js'
import type { ExecutionConstraints } from '../security/capabilities.js'

interface LocalProcessInput {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

function parseLocalProcessInput(value: unknown): LocalProcessInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('local process input 必须是对象')
  }
  const input = value as Record<string, unknown>
  const allowed = new Set(['command', 'args', 'cwd', 'env', 'timeoutMs', 'maxOutputBytes'])
  const unknown = Object.keys(input).find((key) => !allowed.has(key))
  if (unknown) throw new TypeError(`local process input 包含未知字段: ${unknown}`)
  if (typeof input.command !== 'string' || input.command.trim().length === 0) {
    throw new TypeError('local process command 不能为空')
  }
  if (input.args !== undefined && (!Array.isArray(input.args) ||
    input.args.some((argument) => typeof argument !== 'string'))) {
    throw new TypeError('local process args 必须是字符串数组')
  }
  if (input.cwd !== undefined && typeof input.cwd !== 'string') {
    throw new TypeError('local process cwd 必须是字符串')
  }
  if (input.env !== undefined && (input.env === null || typeof input.env !== 'object' ||
    Array.isArray(input.env) || Object.values(input.env).some((item) => typeof item !== 'string'))) {
    throw new TypeError('local process env 必须是字符串字典')
  }
  for (const field of ['timeoutMs', 'maxOutputBytes'] as const) {
    const item = input[field]
    if (item !== undefined && (!Number.isSafeInteger(item) || (item as number) <= 0)) {
      throw new TypeError(`local process ${field} 必须是正安全整数`)
    }
  }
  return input as unknown as LocalProcessInput
}

/** Development-only argv executor. It can never satisfy requireSandbox. */
export class LocalExecutor implements Executor {
  readonly kind = 'local' as const

  constructor(private readonly processes = new ProcessController()) {}

  async probe() {
    return Object.freeze({ available: true })
  }

  supports(kind: ToolExecutionKind, constraints: ExecutionConstraints) {
    return kind === 'process' && constraints.requireSandbox !== true
  }

  async execute(request: ExecutionRequest, control: ExecutionControl): Promise<ExecutionResult> {
    assertSerializableExecutionRequest(request)
    if (!this.supports(request.executionKind, request.constraints)) {
      return Object.freeze({
        outcome: 'failed',
        errorCode: 'local_executor_unsupported',
        proof: 'no_side_effect',
      })
    }

    let input: LocalProcessInput
    try {
      input = parseLocalProcessInput(request.input)
    } catch {
      return Object.freeze({
        outcome: 'failed',
        errorCode: 'local_process_input_invalid',
        proof: 'no_side_effect',
      })
    }

    const result = await this.processes.execute({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      signal: control.signal,
      deadline: request.deadline,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
    })
    if (result.terminationReason === 'spawn_error') {
      return Object.freeze({
        outcome: 'failed',
        errorCode: 'process_spawn_error',
        proof: 'no_side_effect',
      })
    }
    if (result.terminationReason !== 'exited') {
      if (result.pid === undefined) {
        return Object.freeze({
          outcome: 'failed',
          errorCode: `process_${result.terminationReason}`,
          proof: 'no_side_effect',
        })
      }
      return Object.freeze({
        outcome: 'uncertain',
        errorCode: `process_${result.terminationReason}`,
      })
    }
    return Object.freeze({ outcome: 'succeeded', rawOutput: result })
  }

  async close() {}
}
