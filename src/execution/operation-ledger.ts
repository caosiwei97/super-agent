import { createHash, createHmac } from 'node:crypto'
import type {
  CancellationProof,
  FailureProof,
  OperationEvent,
  OperationEventDraft,
  OperationEventEnvelope,
  OperationEventMetadata,
  OperationInputDigestPort,
  OperationInputRedactor,
  OperationProjection,
  OperationResultProtectionPort,
  OperationStatus,
  OperationTransition,
  ProtectedOperationInput,
  ProtectedOperationResult,
  ProposedOperation,
  ReadonlyJsonValue,
} from './operation-types.js'

const OPERATION_STATUSES = [
  'proposed', 'approved', 'started', 'succeeded', 'failed', 'denied', 'cancelled',
  'uncertain', 'reconciled_succeeded', 'reconciled_failed', 'superseded',
] as const satisfies readonly OperationStatus[]

const FAILURE_PROOFS = ['no_side_effect', 'transactionally_rejected'] as const satisfies readonly FailureProof[]
const CANCELLATION_PROOFS = ['not_dispatched', 'proven_not_started'] as const satisfies readonly CancellationProof[]

const OPERATION_EVENT_KEYS = new Set([
  'type', 'schemaVersion', 'eventId', 'sequence', 'operationId', 'sessionId', 'turnId',
  'stepId', 'requestId', 'toolCallId', 'toolName', 'capabilitySet', 'inputDigest',
  'redactedInput', 'status', 'idempotencyKey', 'attemptId', 'timestamp', 'resultDigest',
  'modelResult', 'resultRef', 'errorCode', 'failureProof', 'cancellationProof',
])

const MAX_PERSISTED_JSON_BYTES = 64 * 1024
const MAX_PERSISTED_JSON_DEPTH = 32
const DIGEST_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/
const protectedInputs = new WeakSet<object>()
const protectedResults = new WeakSet<object>()
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  proposed: ['approved', 'denied', 'cancelled'],
  approved: ['started', 'cancelled'],
  started: ['succeeded', 'failed', 'uncertain'],
  succeeded: [],
  failed: [],
  denied: [],
  cancelled: [],
  uncertain: ['reconciled_succeeded', 'reconciled_failed', 'superseded'],
  reconciled_succeeded: [],
  reconciled_failed: [],
  superseded: [],
}

const TERMINAL_RESULT_STATUSES = new Set<OperationStatus>([
  'succeeded',
  'reconciled_succeeded',
])

const DEFAULT_SENSITIVE_FIELD_PATTERN =
  /^(?:authorization|proxy[-_]?authorization|cookie|set-cookie|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|credentials?|x[-_]?api[-_]?key|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|session[-_]?id)$/i

const stableFields = [
  'operationId',
  'sessionId',
  'turnId',
  'stepId',
  'requestId',
  'toolCallId',
  'toolName',
  'inputDigest',
  'idempotencyKey',
] as const

export class InvalidOperationTransitionError extends Error {
  constructor(
    readonly from: OperationStatus | undefined,
    readonly to: OperationStatus,
    reason?: string,
  ) {
    super(reason || `非法 operation 状态迁移: ${from ?? '<empty>'} -> ${to}`)
    this.name = 'InvalidOperationTransitionError'
  }
}

function assertNonEmpty(value: string, field: string) {
  if (value.trim().length === 0) throw new Error(`${field} 不能为空`)
}

function assertOptionalNonEmptyString(value: unknown, field: string): asserts value is string | undefined {
  if (value === undefined) return
  if (typeof value !== 'string') throw new Error(`${field} 必须为字符串`)
  assertNonEmpty(value, field)
}

function assertJsonValue(
  value: unknown,
  field: string,
  depth = 0,
  seen = new Set<object>(),
): asserts value is ReadonlyJsonValue {
  if (depth > MAX_PERSISTED_JSON_DEPTH) throw new Error(`${field} 嵌套过深`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (depth === 0 && Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PERSISTED_JSON_BYTES) {
      throw new Error(`${field} 超过 ${MAX_PERSISTED_JSON_BYTES} bytes`)
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field} 包含非有限数字`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${field} 不是 JSON value`)
  if (seen.has(value)) throw new Error(`${field} 包含循环引用`)
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, field, depth + 1, seen)
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${field} 必须为普通 JSON object`)
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (UNSAFE_OBJECT_KEYS.has(key)) throw new Error(`${field} 包含不安全 object key: ${key}`)
      assertJsonValue(item, field, depth + 1, seen)
    }
  }
  seen.delete(value)
  if (depth === 0 && Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PERSISTED_JSON_BYTES) {
    throw new Error(`${field} 超过 ${MAX_PERSISTED_JSON_BYTES} bytes`)
  }
}

function deepFreezeJson(value: ReadonlyJsonValue): ReadonlyJsonValue {
  if (Array.isArray(value)) {
    value.forEach(deepFreezeJson)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreezeJson)
    return Object.freeze(value)
  }
  return value
}

function cloneAndFreezeJson(value: unknown, field: string): ReadonlyJsonValue {
  assertJsonValue(value, field)
  return deepFreezeJson(stableNormalizeInput(value))
}

function assertProtectedInput(value: ProtectedOperationInput) {
  if (typeof value !== 'object' || value === null || !protectedInputs.has(value)) {
    throw new Error('protectedInput 必须由 OperationInputDigestPort 创建')
  }
}

function assertProtectedResult(value: ProtectedOperationResult) {
  if (typeof value !== 'object' || value === null || !protectedResults.has(value)) {
    throw new Error('protectedResult 必须由 OperationResultProtectionPort 创建')
  }
}

/** Parse and validate an untrusted journal payload before it reaches the ledger. */
export function parseOperationEvent(value: unknown): OperationEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OperationEvent 必须为 object')
  }
  const event = value as Record<string, unknown>
  for (const key of Object.keys(event)) {
    if (!OPERATION_EVENT_KEYS.has(key)) throw new Error(`未知 OperationEvent 字段: ${key}`)
  }
  if (event.type !== 'operation') throw new Error('OperationEvent.type 必须为 operation')
  if (event.schemaVersion !== 2) throw new Error(`不支持 schemaVersion: ${String(event.schemaVersion)}`)
  if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) <= 0) {
    throw new Error(`非法 OperationEvent.sequence: ${String(event.sequence)}`)
  }

  for (const field of [
    'eventId', 'operationId', 'sessionId', 'turnId', 'stepId', 'requestId',
    'toolCallId', 'toolName', 'inputDigest', 'timestamp',
  ] as const) {
    if (typeof event[field] !== 'string') throw new Error(`OperationEvent.${field} 必须为字符串`)
    assertNonEmpty(event[field], `OperationEvent.${field}`)
  }
  if (Number.isNaN(Date.parse(event.timestamp as string))) {
    throw new Error('OperationEvent.timestamp 必须为有效时间')
  }
  if (!OPERATION_STATUSES.includes(event.status as OperationStatus)) {
    throw new Error(`非法 OperationEvent.status: ${String(event.status)}`)
  }
  if (!Array.isArray(event.capabilitySet) || event.capabilitySet.some(
    (item) => typeof item !== 'string' || item.trim().length === 0,
  )) {
    throw new Error('OperationEvent.capabilitySet 必须为非空字符串数组')
  }
  if (event.capabilitySet.length > 64) throw new Error('OperationEvent.capabilitySet 过大')
  if (new Set(event.capabilitySet).size !== event.capabilitySet.length) {
    throw new Error('OperationEvent.capabilitySet 不能重复')
  }
  for (const field of [
    'idempotencyKey', 'attemptId', 'resultDigest', 'resultRef', 'errorCode',
  ] as const) {
    assertOptionalNonEmptyString(event[field], `OperationEvent.${field}`)
  }
  const redactedInput = event.redactedInput === undefined
    ? undefined
    : cloneAndFreezeJson(event.redactedInput, 'redactedInput')
  const modelResult = event.modelResult === undefined
    ? undefined
    : cloneAndFreezeJson(event.modelResult, 'modelResult')
  if (!DIGEST_PATTERN.test(event.inputDigest as string)) {
    throw new Error('OperationEvent.inputDigest 必须为 SHA-256 digest')
  }
  if (event.resultDigest !== undefined && !DIGEST_PATTERN.test(event.resultDigest as string)) {
    throw new Error('OperationEvent.resultDigest 必须为 SHA-256 digest')
  }

  const status = event.status as OperationStatus
  const errorStatuses: readonly OperationStatus[] = [
    'denied', 'failed', 'cancelled', 'uncertain', 'reconciled_failed', 'superseded',
  ]
  if (event.errorCode !== undefined && !errorStatuses.includes(status)) {
    throw new Error(`${status} 事件不能携带 errorCode`)
  }
  if (event.redactedInput !== undefined && status !== 'proposed') {
    throw new Error(`${status} 事件不能携带 redactedInput`)
  }
  if (event.modelResult !== undefined && event.resultRef !== undefined) {
    throw new Error('modelResult 与 resultRef 不能同时持久化')
  }
  if ((event.resultDigest !== undefined || event.modelResult !== undefined || event.resultRef !== undefined) &&
      !TERMINAL_RESULT_STATUSES.has(status)) {
    throw new Error(`${status} 事件不能携带 terminal result`)
  }
  const attemptStatuses: readonly OperationStatus[] = ['started', 'succeeded', 'failed', 'uncertain']
  if (attemptStatuses.includes(status)) {
    if (event.attemptId === undefined) throw new Error(`${status} 事件必须包含 attemptId`)
  } else if (event.attemptId !== undefined) {
    throw new Error(`${status} 事件不能携带 attemptId`)
  }
  if (status === 'failed') {
    if (!FAILURE_PROOFS.includes(event.failureProof as FailureProof)) {
      throw new Error('failed 事件必须包含合法 failureProof')
    }
    if (event.errorCode === undefined) throw new Error('failed 事件必须包含 errorCode')
  } else if (event.failureProof !== undefined) {
    throw new Error(`${status} 事件不能携带 failureProof`)
  }
  if (status === 'cancelled') {
    if (!CANCELLATION_PROOFS.includes(event.cancellationProof as CancellationProof)) {
      throw new Error('cancelled 事件必须包含合法 cancellationProof')
    }
  } else if (event.cancellationProof !== undefined) {
    throw new Error(`${status} 事件不能携带 cancellationProof`)
  }
  return Object.freeze({
    ...event,
    capabilitySet: Object.freeze([...event.capabilitySet]),
    ...(redactedInput === undefined ? {} : { redactedInput }),
    ...(modelResult === undefined ? {} : { modelResult }),
  }) as unknown as OperationEvent
}

function sameCapabilities(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertStableIdentity(current: OperationProjection, event: OperationEvent) {
  const previous = current.latestEvent
  for (const field of stableFields) {
    if (previous[field] !== event[field]) {
      throw new Error(`OperationEvent.${field} 在同一 operation 中不能改变`)
    }
  }
  if (!sameCapabilities(previous.capabilitySet, event.capabilitySet)) {
    throw new Error('OperationEvent.capabilitySet 在同一 operation 中不能改变')
  }
  if (event.sequence <= previous.sequence) {
    throw new Error('OperationEvent.sequence 必须严格递增')
  }
  if (current.events.some((item) => item.eventId === event.eventId)) {
    throw new Error(`重复 OperationEvent.eventId: ${event.eventId}`)
  }
}

export function assertOperationTransition(
  from: OperationStatus | undefined,
  to: OperationStatus,
): void {
  if (from === undefined) {
    if (to !== 'proposed') throw new InvalidOperationTransitionError(from, to)
    return
  }
  if (!TRANSITIONS[from].includes(to)) throw new InvalidOperationTransitionError(from, to)
}

/** Apply one already-persisted event without mutating either argument. */
export function applyOperationEvent(
  current: OperationProjection | undefined,
  event: OperationEvent,
): OperationProjection {
  const parsedEvent = parseOperationEvent(event)
  assertOperationTransition(current?.status, parsedEvent.status)

  if (current === undefined) {
    return Object.freeze({
      operationId: parsedEvent.operationId,
      status: parsedEvent.status,
      latestEvent: parsedEvent,
      events: Object.freeze([parsedEvent]),
      attemptIds: Object.freeze(parsedEvent.attemptId === undefined ? [] : [parsedEvent.attemptId]),
    })
  }

  assertStableIdentity(current, parsedEvent)
  const attemptIds = [...current.attemptIds]
  if (parsedEvent.status === 'started') {
    const attemptId = parsedEvent.attemptId!
    if (attemptIds.includes(attemptId)) throw new Error(`重复 attemptId: ${attemptId}`)
    attemptIds.push(attemptId)
  } else if (parsedEvent.attemptId !== undefined) {
    const activeAttemptId = attemptIds.at(-1)
    if (parsedEvent.attemptId !== activeAttemptId) {
      throw new Error(`事件 attemptId ${parsedEvent.attemptId} 与当前 dispatch 不匹配`)
    }
  }

  return Object.freeze({
    operationId: current.operationId,
    status: parsedEvent.status,
    latestEvent: parsedEvent,
    events: Object.freeze([...current.events, parsedEvent]),
    attemptIds: Object.freeze(attemptIds),
  })
}

/** Rebuild all operation projections from globally ordered operation events. */
export function reduceOperationEvents(
  events: Iterable<OperationEvent>,
): ReadonlyMap<string, OperationProjection> {
  const projections = new Map<string, OperationProjection>()
  const eventIds = new Set<string>()
  let previousSequence: number | undefined

  for (const event of events) {
    if (eventIds.has(event.eventId)) throw new Error(`重复 OperationEvent.eventId: ${event.eventId}`)
    if (previousSequence !== undefined && event.sequence <= previousSequence) {
      throw new Error('OperationEvent.sequence 必须按全局顺序严格递增')
    }
    const next = applyOperationEvent(projections.get(event.operationId), event)
    projections.set(event.operationId, next)
    eventIds.add(event.eventId)
    previousSequence = event.sequence
  }

  return projections
}

function timestamp(metadata?: OperationEventMetadata) {
  return metadata?.timestamp || new Date().toISOString()
}

function completeDraft(
  draft: OperationEventDraft,
  envelope?: OperationEventEnvelope,
): OperationEventDraft | OperationEvent {
  if (envelope !== undefined) return assignOperationEvent(draft, envelope)
  parseOperationEvent({ ...draft, schemaVersion: 2, eventId: '<draft>', sequence: 1 })
  return draft
}

function assignOperationEvent(
  draft: OperationEventDraft,
  envelope: OperationEventEnvelope,
): OperationEvent {
  assertNonEmpty(envelope.eventId, 'OperationEvent.eventId')
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence <= 0) {
    throw new Error(`非法 OperationEvent.sequence: ${envelope.sequence}`)
  }
  return parseOperationEvent({
    ...draft,
    schemaVersion: envelope.schemaVersion ?? 2,
    eventId: envelope.eventId,
    sequence: envelope.sequence,
    capabilitySet: Object.freeze([...draft.capabilitySet]),
  })
}

export function proposeOperation(
  proposal: ProposedOperation,
  metadata?: OperationEventMetadata,
): OperationEventDraft | OperationEvent {
  assertProtectedInput(proposal.protectedInput)
  const draft: OperationEventDraft = Object.freeze({
    type: 'operation',
    operationId: proposal.operationId,
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    stepId: proposal.stepId,
    requestId: proposal.requestId,
    toolCallId: proposal.toolCallId,
    toolName: proposal.toolName,
    capabilitySet: Object.freeze([...proposal.capabilitySet]),
    inputDigest: proposal.protectedInput.inputDigest,
    ...(proposal.protectedInput.redactedInput === undefined
      ? {}
      : { redactedInput: proposal.protectedInput.redactedInput }),
    status: 'proposed',
    ...(proposal.idempotencyKey === undefined ? {} : { idempotencyKey: proposal.idempotencyKey }),
    timestamp: timestamp(metadata),
  })
  return completeDraft(draft, metadata?.envelope)
}

function resultFields(
  transition:
    | Extract<OperationTransition, { kind: 'succeed' }>
    | Extract<OperationTransition, { kind: 'reconcile_succeeded' }>,
) {
  const result = transition.protectedResult
  if (result === undefined) return {}
  assertProtectedResult(result)
  if (result.modelResult !== undefined && result.resultRef !== undefined) {
    throw new Error('protectedResult 不能同时包含 modelResult 与 resultRef')
  }
  return {
    resultDigest: result.resultDigest,
    ...(result.modelResult === undefined ? {} : { modelResult: result.modelResult }),
    ...(result.resultRef === undefined ? {} : { resultRef: result.resultRef }),
  }
}

function transitionFields(transition: OperationTransition): Partial<OperationEventDraft> & {
  readonly status: OperationStatus
} {
  switch (transition.kind) {
    case 'approve':
      return { status: 'approved' }
    case 'deny':
      return { status: 'denied', errorCode: transition.errorCode }
    case 'start':
      assertNonEmpty(transition.attemptId, 'attemptId')
      return { status: 'started', attemptId: transition.attemptId }
    case 'succeed':
      return { status: 'succeeded', attemptId: transition.attemptId, ...resultFields(transition) }
    case 'fail':
      return {
        status: 'failed',
        attemptId: transition.attemptId,
        failureProof: transition.proof,
        errorCode: transition.errorCode,
      }
    case 'cancel':
      return {
        status: 'cancelled',
        cancellationProof: transition.dispatchState,
        errorCode: transition.errorCode,
      }
    case 'mark_uncertain':
      return { status: 'uncertain', attemptId: transition.attemptId, errorCode: transition.errorCode }
    case 'reconcile_succeeded':
      return { status: 'reconciled_succeeded', ...resultFields(transition) }
    case 'reconcile_failed':
      return { status: 'reconciled_failed', errorCode: transition.errorCode }
    case 'supersede':
      return { status: 'superseded', errorCode: transition.errorCode }
  }
}

/**
 * Construct a guarded transition. In particular, failed requires proof that no
 * side effect occurred, while cancellation is unavailable after started.
 */
export function transitionOperation(
  current: OperationProjection,
  transition: OperationTransition,
  metadata?: OperationEventMetadata,
): OperationEventDraft | OperationEvent {
  const fields = transitionFields(transition)
  assertOperationTransition(current.status, fields.status)

  const activeAttemptId = current.attemptIds.at(-1)
  if (fields.status === 'started' && current.attemptIds.includes(fields.attemptId!)) {
    throw new Error(`每次 dispatch 必须使用新的 attemptId: ${fields.attemptId}`)
  }
  let effectiveFields = fields
  if (current.status === 'started' &&
      ['succeeded', 'failed', 'uncertain'].includes(fields.status)) {
    if (fields.attemptId !== undefined && fields.attemptId !== activeAttemptId) {
      throw new Error(`transition attemptId ${fields.attemptId} 与当前 dispatch 不匹配`)
    }
    effectiveFields = { ...fields, attemptId: activeAttemptId }
  }

  const previous = current.latestEvent
  const draft: OperationEventDraft = Object.freeze({
    type: 'operation',
    operationId: previous.operationId,
    sessionId: previous.sessionId,
    turnId: previous.turnId,
    stepId: previous.stepId,
    requestId: previous.requestId,
    toolCallId: previous.toolCallId,
    toolName: previous.toolName,
    capabilitySet: Object.freeze([...previous.capabilitySet]),
    inputDigest: previous.inputDigest,
    ...(previous.idempotencyKey === undefined ? {} : { idempotencyKey: previous.idempotencyKey }),
    timestamp: timestamp(metadata),
    ...effectiveFields,
  })
  return completeDraft(draft, metadata?.envelope)
}

function normalizeJson(value: unknown, seen: Set<object>): ReadonlyJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('operation input 不能包含非有限数字')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, seen))
  if (typeof value !== 'object') throw new Error(`operation input 包含非 JSON 类型: ${typeof value}`)
  if (seen.has(value)) throw new Error('operation input 不能包含循环引用')

  seen.add(value)
  const output: Record<string, ReadonlyJsonValue> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (UNSAFE_OBJECT_KEYS.has(key)) throw new Error(`operation input 包含不安全 object key: ${key}`)
    const member = (value as Record<string, unknown>)[key]
    if (member === undefined) continue
    output[key] = normalizeJson(member, seen)
  }
  seen.delete(value)
  return output
}

/** Normalize JSON input with deterministic object-key ordering. */
export function stableNormalizeInput(input: unknown): ReadonlyJsonValue {
  return normalizeJson(input, new Set())
}

/**
 * Remove fields whose names are sensitive. Values are omitted, never replaced
 * with a digest that could enable low-entropy secret enumeration.
 */
export function redactSensitiveInput(
  input: unknown,
  sensitiveFieldPattern: RegExp = DEFAULT_SENSITIVE_FIELD_PATTERN,
): ReadonlyJsonValue {
  const normalized = stableNormalizeInput(input)
  const maxEmbeddedJsonChars = 100_000

  const secretBearingString = (value: string) =>
    /(?:\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+|:\/\/[^\s/:@]+:[^\s/@]+@|(?:[?&]|--?)(?:access[-_]?token|refresh[-_]?token|id[-_]?token|password|secret|api[-_]?key|x[-_]?api[-_]?key)(?:=|\s+)\S+)/i.test(value)

  const sensitiveKeyValueString = (value: string) => {
    const assignments = /(?:^|[\s,;{])["']?([a-z][a-z0-9_-]*)["']?\s*(?::|=|\s)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi
    for (const match of value.matchAll(assignments)) {
      sensitiveFieldPattern.lastIndex = 0
      if (sensitiveFieldPattern.test(match[1]!)) return true
    }
    return false
  }

  const redact = (value: ReadonlyJsonValue): ReadonlyJsonValue => {
    if (Array.isArray(value)) return value.map(redact)
    if (value !== null && typeof value === 'object') {
      const result: Record<string, ReadonlyJsonValue> = {}
      for (const [key, member] of Object.entries(value)) {
        sensitiveFieldPattern.lastIndex = 0
        if (!sensitiveFieldPattern.test(key)) result[key] = redact(member)
      }
      return result
    }
    if (typeof value === 'string') {
      if (secretBearingString(value)) return '[REDACTED]'

      // MCP and HTTP tools frequently wrap structured JSON in a `text` field.
      // Parse only bounded object/array strings so their sensitive field names
      // remain visible to the same recursive redaction policy.
      const trimmed = value.trim()
      if (value.length <= maxEmbeddedJsonChars &&
          ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
           (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
        try {
          const embedded = stableNormalizeInput(JSON.parse(trimmed))
          return JSON.stringify(redact(embedded))
        } catch {
          // Fall through to conservative key/value detection.
        }
      }
      if (sensitiveKeyValueString(value)) return '[REDACTED]'
    }
    return value
  }

  return redact(normalized)
}

export interface OperationInputDigestOptions {
  /** Mandatory, application-specific redaction before optional persistence. */
  readonly redact: OperationInputRedactor
  /** If present, the digest covers full normalized input without exposing it. */
  readonly hmacKey?: string | Uint8Array
  readonly includeRedactedInput?: boolean
}

function copyHmacKey(key: string | Uint8Array | undefined) {
  if (key === undefined) return undefined
  const copied = Buffer.from(key)
  if (copied.byteLength < 32) throw new Error('operation HMAC key 至少需要 32 bytes')
  return copied
}

/**
 * Build the input-safety port. Plain SHA-256 only covers redacted input; full
 * input is digested exclusively through keyed HMAC.
 */
export function createOperationInputDigestPort(
  options: OperationInputDigestOptions,
): OperationInputDigestPort {
  const hmacKey = copyHmacKey(options.hmacKey)
  return Object.freeze({
    protect(input: unknown): ProtectedOperationInput {
      const redacted = cloneAndFreezeJson(options.redact(input), 'redactedInput')
      const digestPayload = hmacKey === undefined
        ? JSON.stringify(redacted)
        : JSON.stringify(stableNormalizeInput(input))
      const inputDigest = hmacKey === undefined
        ? createHash('sha256').update(digestPayload).digest('hex')
        : createHmac('sha256', hmacKey).update(digestPayload).digest('hex')

      const protectedInput = Object.freeze({
        inputDigest,
        ...(options.includeRedactedInput ? { redactedInput: redacted } : {}),
      }) as ProtectedOperationInput
      protectedInputs.add(protectedInput)
      return protectedInput
    },
  })
}

export interface OperationResultProtectionOptions {
  /** Mandatory result-specific redaction; inline persistence remains opt-in. */
  readonly redact: OperationInputRedactor
  readonly hmacKey?: string | Uint8Array
  readonly includeModelResult?: boolean
}

/** Build the only supported boundary for creating persistable tool results. */
export function createOperationResultProtectionPort(
  options: OperationResultProtectionOptions,
): OperationResultProtectionPort {
  const hmacKey = copyHmacKey(options.hmacKey)
  return Object.freeze({
    protect(result: unknown, resultRef?: string): ProtectedOperationResult {
      const redacted = cloneAndFreezeJson(options.redact(result), 'modelResult')
      assertOptionalNonEmptyString(resultRef, 'resultRef')
      const digestPayload = hmacKey === undefined
        ? JSON.stringify(redacted)
        : JSON.stringify(stableNormalizeInput(result))
      const resultDigest = hmacKey === undefined
        ? createHash('sha256').update(digestPayload).digest('hex')
        : createHmac('sha256', hmacKey).update(digestPayload).digest('hex')

      const protectedResult = Object.freeze({
        resultDigest,
        ...(resultRef !== undefined
          ? { resultRef }
          : options.includeModelResult ? { modelResult: redacted } : {}),
      }) as ProtectedOperationResult
      protectedResults.add(protectedResult)
      return protectedResult
    },
  })
}
