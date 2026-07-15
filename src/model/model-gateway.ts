import {
  streamText,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import {
  calculateRetryDelay,
  isAbortError,
  isRetryable,
  sleep,
} from '../agent/retry.js'

export interface ModelToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

export interface ModelGatewayResult {
  readonly requestId: string
  readonly attempts: number
  readonly responseMessages: ModelMessage[]
  readonly usage: LanguageModelUsage
  readonly toolCalls: readonly ModelToolCall[]
  readonly finishReason: FinishReason
}

export type ModelAttemptErrorCode =
  | 'abort'
  | 'deadline'
  | 'http_429'
  | 'http_5xx'
  | 'timeout'
  | 'network'
  | 'provider_error'

export type ModelAttemptAuditEvent =
  | {
    readonly phase: 'started'
    readonly requestId: string
    readonly attempt: number
  }
  | {
    readonly phase: 'failed'
    readonly requestId: string
    readonly attempt: number
    readonly observable: boolean
    readonly willRetry: boolean
    readonly errorCode: ModelAttemptErrorCode
  }
  | {
    readonly phase: 'retry_scheduled'
    readonly requestId: string
    readonly attempt: number
    readonly nextAttempt: number
    readonly delayMs: number
  }
  | {
    readonly phase: 'succeeded'
    readonly requestId: string
    readonly attempt: number
  }

export interface ModelGatewayRequest {
  readonly requestId: string
  readonly model: LanguageModel
  readonly messages: ModelMessage[]
  readonly system?: string
  readonly tools?: ToolSet
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly signal?: AbortSignal
  /** Absolute UNIX epoch deadline in milliseconds. */
  readonly deadline?: number
  /** Per-attempt provider timeout. */
  readonly requestTimeoutMs?: number
  readonly maxRetries?: number
  readonly onTextDelta?: (event: {
    requestId: string
    attempt: number
    text: string
  }) => void
  readonly onToolCall?: (event: {
    requestId: string
    attempt: number
    call: ModelToolCall
  }) => void
  readonly onStreamError?: (event: {
    requestId: string
    attempt: number
    error: unknown
  }) => void
  readonly onAttemptError?: (event: {
    requestId: string
    attempt: number
    error: unknown
  }) => void
  /** Durable audit boundary. A rejected write fails the model request closed. */
  readonly onAttemptAudit?: (event: ModelAttemptAuditEvent) => Promise<void> | void
}

export class DeadlineExceededError extends Error {
  override readonly name = 'AbortError'

  constructor(message = 'Model request deadline exceeded', options?: ErrorOptions) {
    super(message, options)
  }
}

export class ModelAuditWriteError extends Error {
  override readonly name = 'ModelAuditWriteError'

  constructor(options?: ErrorOptions) {
    super('Failed to persist model attempt audit event', options)
  }
}

function notify(callback: (() => void) | undefined) {
  try {
    callback?.()
  } catch {
    // Telemetry and presentation callbacks must not alter model semantics.
  }
}

function validateRequest(request: ModelGatewayRequest) {
  if (!request.requestId.trim()) throw new Error('requestId 不能为空')
  const maxRetries = request.maxRetries ?? 10
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`maxRetries 必须是非负整数，当前值: ${maxRetries}`)
  }
  if (request.deadline !== undefined && !Number.isFinite(request.deadline)) {
    throw new Error('deadline 必须是有限的绝对时间戳')
  }
  if (
    request.requestTimeoutMs !== undefined &&
    (!Number.isFinite(request.requestTimeoutMs) || request.requestTimeoutMs <= 0)
  ) {
    throw new Error('requestTimeoutMs 必须是正数')
  }
  return maxRetries
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

interface AttemptSignal {
  readonly signal?: AbortSignal
  dispose(): void
}

/** Merge caller cancellation and an absolute deadline without retaining listeners. */
function createAttemptSignal(signal?: AbortSignal, deadline?: number): AttemptSignal {
  if (deadline === undefined) return { signal, dispose() {} }

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => controller.abort(signal ? abortReason(signal) : undefined)
  if (signal?.aborted) {
    onAbort()
  } else {
    signal?.addEventListener('abort', onAbort, { once: true })
  }

  const scheduleDeadline = () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      controller.abort(new DeadlineExceededError())
      return
    }
    timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647))
  }
  scheduleDeadline()

  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

function thrownStreamError(error: unknown) {
  return error instanceof Error ? error : new Error('Model stream failed', { cause: error })
}

function statusCode(error: unknown) {
  if (!(error instanceof Error)) return undefined
  const candidate = error as Error & {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  const value = candidate.status ?? candidate.statusCode ?? candidate.response?.status
  if (typeof value === 'number') return value
  const match = error.message.match(/(?:status|HTTP)[:\s]*(\d{3})\b/i)
  return match ? Number.parseInt(match[1], 10) : undefined
}

function errorCode(
  error: unknown,
  options: { deadline?: boolean; cancelled?: boolean } = {},
): ModelAttemptErrorCode {
  if (options.deadline || error instanceof DeadlineExceededError) return 'deadline'
  if (options.cancelled || isAbortError(error)) return 'abort'
  const status = statusCode(error)
  if (status === 429) return 'http_429'
  if (status !== undefined && status >= 500 && status < 600) return 'http_5xx'
  const message = error instanceof Error ? error.message : ''
  if (/ETIMEDOUT|\btimeout\b/i.test(message)) return 'timeout'
  if (/ECONNRESET|EPIPE|fetch failed|\bnetwork\b/i.test(message)) return 'network'
  return 'provider_error'
}

async function writeAudit(
  callback: ModelGatewayRequest['onAttemptAudit'],
  event: ModelAttemptAuditEvent,
) {
  try {
    await callback?.(event)
  } catch (error) {
    throw new ModelAuditWriteError({ cause: error })
  }
}

/**
 * Owns the complete model streaming and retry boundary.
 *
 * The AI SDK retry layer is always disabled. A retry is possible only before a
 * text delta or a complete tool call has crossed this gateway's observation
 * boundary. requestId remains stable while attempt monotonically increases.
 */
export class ModelGateway {
  async stream(request: ModelGatewayRequest): Promise<ModelGatewayResult> {
    const maxRetries = validateRequest(request)

    for (let attempt = 1; ; attempt++) {
      const attemptSignal = createAttemptSignal(request.signal, request.deadline)
      let observable = false
      try {
        await writeAudit(request.onAttemptAudit, {
          phase: 'started',
          requestId: request.requestId,
          attempt,
        })
        if (attemptSignal.signal?.aborted) throw abortReason(attemptSignal.signal)

        const toolCalls: ModelToolCall[] = []
        const result = streamText({
          model: request.model,
          system: request.system,
          tools: request.tools,
          messages: request.messages,
          maxRetries: 0,
          abortSignal: attemptSignal.signal,
          timeout: request.requestTimeoutMs,
          providerOptions: request.providerOptions as never,
          onError: ({ error }) => notify(() => request.onStreamError?.({
            requestId: request.requestId,
            attempt,
            error,
          })),
        })

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              observable = true
              notify(() => request.onTextDelta?.({
                requestId: request.requestId,
                attempt,
                text: part.text,
              }))
              break

            case 'tool-call': {
              if (part.providerExecuted || ('invalid' in part && part.invalid === true)) {
                throw new Error(`拒绝 provider-executed 或非法工具调用: ${part.toolName}`)
              }
              const call: ModelToolCall = {
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              }
              observable = true
              toolCalls.push(call)
              notify(() => request.onToolCall?.({
                requestId: request.requestId,
                attempt,
                call,
              }))
              break
            }

            case 'tool-result':
              throw new Error(`Provider 绕过执行管线返回工具结果: ${part.toolName}`)

            case 'tool-approval-request':
              throw new Error('Schema-only 模型阶段不应产生 tool approval request')

            case 'error':
              throw thrownStreamError(part.error)

            case 'abort':
              throw new DOMException('Model stream aborted', 'AbortError')
          }
        }

        const [response, usage, finishReason] = await Promise.all([
          result.response,
          result.usage,
          result.finishReason,
        ])
        await writeAudit(request.onAttemptAudit, {
          phase: 'succeeded',
          requestId: request.requestId,
          attempt,
        })
        return {
          requestId: request.requestId,
          attempts: attempt,
          responseMessages: response.messages,
          usage,
          toolCalls,
          finishReason,
        }
      } catch (caught) {
        if (caught instanceof ModelAuditWriteError) throw caught
        notify(() => request.onAttemptError?.({
          requestId: request.requestId,
          attempt,
          error: caught,
        }))
        const cancelled = attemptSignal.signal?.aborted || isAbortError(caught)
        const retryable =
          !cancelled &&
          !observable &&
          attempt <= maxRetries &&
          isRetryable(caught)

        if (!retryable) {
          await writeAudit(request.onAttemptAudit, {
            phase: 'failed',
            requestId: request.requestId,
            attempt,
            observable,
            willRetry: false,
            errorCode: errorCode(caught, {
              cancelled,
              deadline: attemptSignal.signal?.reason instanceof DeadlineExceededError,
            }),
          })
          throw caught
        }

        const delayMs = calculateRetryDelay(caught, attempt)
        const remaining = request.deadline === undefined
          ? undefined
          : request.deadline - Date.now()
        if (remaining !== undefined && delayMs >= remaining) {
          const deadlineError = new DeadlineExceededError(
            'Model retry backoff would exceed deadline',
            { cause: caught },
          )
          await writeAudit(request.onAttemptAudit, {
            phase: 'failed',
            requestId: request.requestId,
            attempt,
            observable,
            willRetry: false,
            errorCode: 'deadline',
          })
          throw deadlineError
        }

        await writeAudit(request.onAttemptAudit, {
          phase: 'failed',
          requestId: request.requestId,
          attempt,
          observable,
          willRetry: true,
          errorCode: errorCode(caught),
        })
        await writeAudit(request.onAttemptAudit, {
          phase: 'retry_scheduled',
          requestId: request.requestId,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
        })
        await sleep(delayMs, attemptSignal.signal)
      } finally {
        attemptSignal.dispose()
      }
    }
  }
}
