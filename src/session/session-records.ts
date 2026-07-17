import { modelMessageSchema, type ModelMessage } from 'ai'
import { parseOperationEvent } from '../execution/operation-ledger.js'

const CURRENT_SCHEMA_VERSION = 2 as const

export interface SessionProjectionState {
  messages: ModelMessage[]
  summary: string
  budgetUsed: number
}

export interface SessionSchemaTransitionState {
  sawV1: boolean
  sawV2: boolean
}

export function createEmptySessionState(): SessionProjectionState {
  return { messages: [], summary: '', budgetUsed: 0 }
}

export function createSessionSchemaTransitionState(): SessionSchemaTransitionState {
  return { sawV1: false, sawV2: false }
}

function invalid(line: number, field: string) {
  return new Error(`[Session] 第 ${line} 行 ${field} 无效`)
}

function parseMessages(value: unknown, line: number, field: string) {
  if (!Array.isArray(value)) throw invalid(line, field)
  const parsed = value.map((message) => modelMessageSchema.safeParse(message))
  if (parsed.some((message) => !message.success)) throw invalid(line, field)
  return parsed.map((message) => message.data!)
}

function parseBudget(value: unknown, line: number, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(line, field)
  }
  return value
}

/** Validate and apply one physical journal record to the recoverable conversation projection. */
export function applySessionRecord(
  state: SessionProjectionState,
  entry: Record<string, unknown>,
  line: number,
): SessionProjectionState {
  if (entry.type === 'messages') {
    const messages = parseMessages(entry.messages, line, 'messages.messages')
    const budgetUsed = entry.budgetUsed === undefined
      ? state.budgetUsed
      : parseBudget(entry.budgetUsed, line, 'messages.budgetUsed')
    state.messages.push(...messages)
    state.budgetUsed = budgetUsed
    return state
  }

  if (entry.type === 'message') {
    const message = modelMessageSchema.safeParse(entry.message)
    if (!message.success) throw invalid(line, 'message.message')
    state.messages.push(message.data)
    return state
  }

  if (entry.type === 'budget') {
    state.budgetUsed = parseBudget(entry.budgetUsed, line, 'budget.budgetUsed')
    return state
  }

  if (entry.type === 'checkpoint') {
    const messages = parseMessages(entry.messages, line, 'checkpoint.messages')
    if (typeof entry.summary !== 'string') throw invalid(line, 'checkpoint.summary')
    const budgetUsed = parseBudget(entry.budgetUsed, line, 'checkpoint.budgetUsed')
    if (entry.throughSequence !== undefined && (
      !Number.isSafeInteger(entry.throughSequence) ||
      (entry.throughSequence as number) < 0 ||
      (entry.schemaVersion === CURRENT_SCHEMA_VERSION &&
        (!Number.isSafeInteger(entry.sequence) ||
          (entry.throughSequence as number) !== (entry.sequence as number) - 1))
    )) {
      throw invalid(line, 'checkpoint.throughSequence')
    }
    return { messages, summary: entry.summary, budgetUsed }
  }

  if (entry.schemaVersion === CURRENT_SCHEMA_VERSION) {
    if (entry.type === 'operation') parseOperationEvent(entry)
    if (entry.type === 'schema.upgraded' && (
      entry.fromSchemaVersion !== 1 || entry.toSchemaVersion !== CURRENT_SCHEMA_VERSION
    )) {
      throw invalid(line, 'schema.upgraded payload')
    }
    return state
  }
  throw new Error(`[Session] 第 ${line} 行未知 v1 entry type`)
}

/** Validate one known journal payload without retaining conversation state. */
export function validateSessionRecord(
  entry: Record<string, unknown>,
  line: number,
): void {
  void applySessionRecord(createEmptySessionState(), entry, line)
}

/** Enforce the one-way v1 -> explicit schema.upgraded -> v2 transition. */
export function validateSessionSchemaTransition(
  state: SessionSchemaTransitionState,
  entry: Record<string, unknown>,
  line: number,
): void {
  if (entry.schemaVersion === undefined) {
    state.sawV1 = true
    return
  }

  const isUpgrade = entry.type === 'schema.upgraded'
  if (!state.sawV2) {
    if (state.sawV1 !== isUpgrade) {
      throw invalid(line, state.sawV1
        ? 'v1 -> v2 缺少 schema.upgraded marker'
        : 'schema.upgraded marker 缺少 v1 前缀')
    }
  } else if (isUpgrade) {
    throw invalid(line, 'schema.upgraded marker 重复或不在边界')
  }
  state.sawV2 = true
}
