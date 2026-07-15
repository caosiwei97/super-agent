import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { modelMessageSchema, type ModelMessage, type ToolModelMessage } from 'ai'
import { flockSync } from 'fs-ext'
import {
  applyOperationEvent,
  parseOperationEvent,
  reduceOperationEvents,
} from '../execution/operation-ledger.js'
import type { OperationProjection } from '../execution/operation-types.js'

const DEFAULT_SESSION_DIR = '.sessions'
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const CURRENT_SCHEMA_VERSION = 2 as const
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

interface EntryBase {
  timestamp: string
}

/** Current atomic event: step messages and their cumulative budget share one JSONL record. */
export interface MessagesEntry extends EntryBase {
  type: 'messages'
  messages: ModelMessage[]
  budgetUsed?: number
}

/** Legacy entries remain readable so existing sessions can be resumed. */
export interface MessageEntry extends EntryBase {
  type: 'message'
  message: ModelMessage
}

export interface BudgetEntry extends EntryBase {
  type: 'budget'
  budgetUsed: number
}

export interface CheckpointEntry extends EntryBase {
  type: 'checkpoint'
  messages: ModelMessage[]
  summary: string
  budgetUsed: number
}

export type SessionEntry = MessagesEntry | MessageEntry | BudgetEntry | CheckpointEntry

/** Envelope persisted for every new journal record. */
export interface SessionEvent {
  schemaVersion: 2
  eventId: string
  sequence: number
  type: string
  timestamp: string
  [key: string]: unknown
}

/**
 * Callers may provide a stable eventId, but ordering is owned by the store.
 * A supplied sequence is accepted only when it equals the next journal sequence.
 */
export interface SessionEventInput {
  type: string
  schemaVersion?: 2
  eventId?: string
  sequence?: number
  timestamp?: string
  [key: string]: unknown
}

export type EventDurability = 'buffered' | 'durable'

export interface SessionState {
  messages: ModelMessage[]
  summary: string
  budgetUsed: number
}

export interface SessionWriter {
  getSessionId(): string
  appendMessages(messages: ModelMessage[], budgetUsed?: number): Promise<void>
  appendCheckpoint(state: SessionState): Promise<void>
  appendToolResult(commit: ToolResultCommit, budgetUsed?: number): Promise<boolean>
  close(): Promise<void>
}

export interface ToolResultCommit {
  materializationId: string
  operationId: string
  message: ToolModelMessage
}

export interface DurableEventWriter {
  appendEvent(event: SessionEventInput, durability?: EventDurability): Promise<SessionEvent>
}

export interface SessionJournalFile {
  chmod(mode: number): Promise<void>
  truncate(length?: number): Promise<void>
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
  datasync(): Promise<void>
  close(): Promise<void>
}

/** Minimal injectable boundary around journal file I/O. */
export interface SessionJournalIo {
  open(path: string, flags: number, mode: number): Promise<SessionJournalFile>
  readFile(path: string): Promise<Buffer>
}

export const nodeSessionJournalIo: SessionJournalIo = Object.freeze({
  open: (path: string, flags: number, mode: number) => open(path, flags, mode),
  readFile: (path: string) => readFile(path),
})

export interface SessionStoreOptions {
  directory?: string
  onWarning?: (message: string) => void
  io?: SessionJournalIo
}

interface ParsedJournal {
  records: Record<string, unknown>[]
  validLength: number
  hasTrailingFragment: boolean
}

export function createSessionId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${timestamp}_${randomUUID().slice(0, 8)}`
}

function validateSessionId(sessionId: string) {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`非法 session ID: ${sessionId}`)
  }
}

function emptyState(): SessionState {
  const messages: ModelMessage[] = []
  return { messages, summary: '', budgetUsed: 0 }
}

function assertBudget(budgetUsed: number) {
  if (!Number.isFinite(budgetUsed) || budgetUsed < 0) {
    throw new Error(`非法 budgetUsed: ${budgetUsed}`)
  }
}

function assertNonEmptyCommitField(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ToolResultCommit.${field} 不能为空`)
  }
}

function assertMessages(messages: ModelMessage[]) {
  for (const message of messages) {
    if (!modelMessageSchema.safeParse(message).success) {
      throw new Error('拒绝写入结构无效的 ModelMessage')
    }
  }
}

function asRecord(value: unknown, lineNumber: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[Session] 第 ${lineNumber} 行不是 JSON object`)
  }
  return value as Record<string, unknown>
}

function validateV2Events(records: Record<string, unknown>[]) {
  let nextSequence = 1
  let sawV2 = false
  const eventIds = new Set<string>()
  const materializationIds = new Set<string>()

  for (const [index, record] of records.entries()) {
    const lineNumber = index + 1
    if (record.schemaVersion === undefined) {
      if (sawV2) {
        throw new Error(`[Session] 第 ${lineNumber} 行在 v2 事件后出现无版本 v1 记录`)
      }
      continue
    }
    if (record.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`[Session] 第 ${lineNumber} 行 schemaVersion 不受支持`)
    }

    sawV2 = true
    if (typeof record.type !== 'string' || record.type.length === 0) {
      throw new Error(`[Session] 第 ${lineNumber} 行 type 无效`)
    }
    if (typeof record.timestamp !== 'string' || record.timestamp.length === 0) {
      throw new Error(`[Session] 第 ${lineNumber} 行 timestamp 无效`)
    }
    if (typeof record.eventId !== 'string' || record.eventId.length === 0) {
      throw new Error(`[Session] 第 ${lineNumber} 行 eventId 无效`)
    }
    if (eventIds.has(record.eventId)) {
      throw new Error(`[Session] 第 ${lineNumber} 行 eventId 重复: ${record.eventId}`)
    }
    if (!Number.isSafeInteger(record.sequence) || record.sequence !== nextSequence) {
      throw new Error(
        `[Session] 第 ${lineNumber} 行 sequence 无效: 期望 ${nextSequence}，实际 ${String(record.sequence)}`,
      )
    }

    eventIds.add(record.eventId)
    if (record.materializationId !== undefined) {
      if (typeof record.materializationId !== 'string' || record.materializationId.length === 0) {
        throw new Error(`[Session] 第 ${lineNumber} 行 materializationId 无效`)
      }
      if (materializationIds.has(record.materializationId)) {
        throw new Error(
          `[Session] 第 ${lineNumber} 行 materializationId 重复: ${record.materializationId}`,
        )
      }
      materializationIds.add(record.materializationId)
    }
    nextSequence++
  }

  return { nextSequence, eventIds, materializationIds, sawV2 }
}

/**
 * Append-only, versioned session journal with a process-lifetime single-writer lock.
 * Buffered writes are complete OS writes; durable writes additionally wait for
 * fdatasync before acknowledging the event.
 */
export class SessionStore implements SessionWriter, DurableEventWriter {
  private readonly filePath: string
  private readonly lockPath: string
  private readonly onWarning: (message: string) => void
  private readonly io: SessionJournalIo
  private lockFd: number | undefined
  private journalHandle: SessionJournalFile | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private fatalError: unknown
  private initialized = false
  private nextSequence = 1
  private eventIds = new Set<string>()
  private materializationIds = new Set<string>()
  private operations = new Map<string, OperationProjection>()
  private hasV1Records = false
  private hasV2Records = false
  private closing = false
  private closed = false
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly sessionId: string,
    options: SessionStoreOptions = {},
  ) {
    validateSessionId(sessionId)
    const directory = resolve(options.directory || DEFAULT_SESSION_DIR)
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
    chmodSync(directory, DIRECTORY_MODE)
    this.filePath = resolve(directory, `${sessionId}.jsonl`)
    this.lockPath = resolve(directory, `${sessionId}.lock`)
    this.onWarning = options.onWarning || ((message) => console.warn(message))
    this.io = options.io || nodeSessionJournalIo

    if (existsSync(this.filePath)) chmodSync(this.filePath, FILE_MODE)
    this.acquireLock()
  }

  static async open(sessionId: string, options: SessionStoreOptions = {}) {
    return new SessionStore(sessionId, options)
  }

  getSessionId() {
    return this.sessionId
  }

  exists() {
    return existsSync(this.filePath)
  }

  async appendMessages(messages: ModelMessage[], budgetUsed?: number) {
    if (messages.length === 0) return
    assertMessages(messages)
    if (budgetUsed !== undefined) assertBudget(budgetUsed)

    await this.appendEvent({
      type: 'messages',
      messages,
      ...(budgetUsed === undefined ? {} : { budgetUsed }),
    })
  }

  async appendCheckpoint(state: SessionState) {
    assertMessages(state.messages)
    assertBudget(state.budgetUsed)
    await this.appendEvent({
      type: 'checkpoint',
      messages: state.messages,
      summary: state.summary,
      budgetUsed: state.budgetUsed,
    })
  }

  /** Idempotently persist one model-facing tool result with a recovery identity. */
  appendToolResult(commit: ToolResultCommit, budgetUsed?: number): Promise<boolean> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error(`[Session] session ${this.sessionId} 已关闭`))
    }
    if (typeof commit !== 'object' || commit === null) {
      return Promise.reject(new Error('ToolResultCommit 必须为 object'))
    }
    assertNonEmptyCommitField(commit.materializationId, 'materializationId')
    assertNonEmptyCommitField(commit.operationId, 'operationId')
    assertMessages([commit.message])
    if (budgetUsed !== undefined) assertBudget(budgetUsed)

    return this.enqueueWrite(async () => {
      await this.ensureInitialized()
      if (this.materializationIds.has(commit.materializationId)) return false
      await this.ensureV2UpgradeMarker()
      const event = this.createEvent({
        type: 'messages',
        messages: [commit.message],
        materializationId: commit.materializationId,
        operationId: commit.operationId,
        ...(budgetUsed === undefined ? {} : { budgetUsed }),
      })
      await this.writeEvent(event, 'durable')
      this.acceptEvent(event)
      this.materializationIds.add(commit.materializationId)
      return true
    })
  }

  async appendEvent(
    input: SessionEventInput,
    durability: EventDurability = 'buffered',
  ): Promise<SessionEvent> {
    if (this.closing || this.closed) throw new Error(`[Session] session ${this.sessionId} 已关闭`)
    if (durability !== 'buffered' && durability !== 'durable') {
      throw new Error(`[Session] 未知 durability: ${String(durability)}`)
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('[Session] event 必须是 object')
    }
    if (typeof input.type !== 'string' || input.type.length === 0) {
      throw new Error('[Session] event.type 无效')
    }
    if (input.schemaVersion !== undefined && input.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`[Session] event.schemaVersion 必须为 ${CURRENT_SCHEMA_VERSION}`)
    }

    return this.enqueueWrite(async () => {
      await this.ensureInitialized()

      await this.ensureV2UpgradeMarker()

      const event = this.createEvent(input)
      const operationProjection = this.projectOperationEvent(event)
      await this.writeEvent(event, durability)
      this.acceptEvent(event, operationProjection)
      return event
    })
  }

  /** Returns the ordered v2 stream; v1 records remain available through loadState(). */
  async replayEvents(): Promise<SessionEvent[]> {
    await this.awaitPendingWrites()
    const parsed = await this.readJournal()
    validateV2Events(parsed.records)
    return parsed.records
      .filter((record) => record.schemaVersion === CURRENT_SCHEMA_VERSION)
      .map((record) => record as SessionEvent)
  }

  async loadState() {
    await this.awaitPendingWrites()
    if (!this.exists()) return emptyState()

    const parsed = await this.readJournal()
    validateV2Events(parsed.records)
    let state = emptyState()

    for (const [index, entry] of parsed.records.entries()) {
      const lineNumber = index + 1
      const type = entry.type

      if (type === 'messages') {
        if (!Array.isArray(entry.messages)) {
          throw new Error(`[Session] 第 ${lineNumber} 行 messages.messages 不是数组`)
        }
        const parsedMessages = entry.messages.map((message) => modelMessageSchema.safeParse(message))
        if (parsedMessages.some((message) => !message.success)) {
          throw new Error(`[Session] 第 ${lineNumber} 行 messages 包含无效消息`)
        }
        if (entry.budgetUsed !== undefined) {
          if (typeof entry.budgetUsed !== 'number') {
            throw new Error(`[Session] 第 ${lineNumber} 行 messages.budgetUsed 无效`)
          }
          assertBudget(entry.budgetUsed)
          state.budgetUsed = entry.budgetUsed
        }
        state.messages.push(...parsedMessages.map((message) => message.data!))
        continue
      }

      if (type === 'message') {
        const message = modelMessageSchema.safeParse(entry.message)
        if (!message.success) throw new Error(`[Session] 第 ${lineNumber} 行 message 结构无效`)
        state.messages.push(message.data)
        continue
      }

      if (type === 'budget') {
        if (typeof entry.budgetUsed !== 'number') {
          throw new Error(`[Session] 第 ${lineNumber} 行 budget.budgetUsed 无效`)
        }
        assertBudget(entry.budgetUsed)
        state.budgetUsed = entry.budgetUsed
        continue
      }

      if (type === 'checkpoint') {
        if (!Array.isArray(entry.messages)) {
          throw new Error(`[Session] 第 ${lineNumber} 行 checkpoint.messages 不是数组`)
        }
        const parsedMessages = entry.messages.map((message) => modelMessageSchema.safeParse(message))
        if (parsedMessages.some((message) => !message.success)) {
          throw new Error(`[Session] 第 ${lineNumber} 行 checkpoint 包含无效消息`)
        }
        if (typeof entry.summary !== 'string') {
          throw new Error(`[Session] 第 ${lineNumber} 行 checkpoint.summary 无效`)
        }
        if (typeof entry.budgetUsed !== 'number') {
          throw new Error(`[Session] 第 ${lineNumber} 行 checkpoint.budgetUsed 无效`)
        }
        assertBudget(entry.budgetUsed)
        state = {
          messages: parsedMessages.map((message) => message.data!),
          summary: entry.summary,
          budgetUsed: entry.budgetUsed,
        }
        continue
      }

      // v2 contains operation and control-plane events which do not alter this projection.
      if (entry.schemaVersion === CURRENT_SCHEMA_VERSION) continue
      throw new Error(`[Session] 第 ${lineNumber} 行未知 v1 entry type`)
    }

    return state
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = this.performClose()
    return this.closePromise
  }

  private async performClose() {
    let closeError: unknown
    try {
      await this.writeTail
      if (this.fatalError) closeError = this.fatalError
      if (this.journalHandle) await this.journalHandle.datasync()
    } catch (error) {
      closeError = error
    }

    try {
      await this.journalHandle?.close()
    } catch (error) {
      closeError ||= error
    } finally {
      this.journalHandle = undefined
      try {
        this.releaseLock()
      } catch (error) {
        closeError ||= error
      }
      this.closed = true
      this.closing = false
    }

    if (closeError) throw closeError
  }

  private acquireLock() {
    let lockFd: number | undefined
    try {
      lockFd = openSync(this.lockPath, constants.O_CREAT | constants.O_RDWR, FILE_MODE)
      chmodSync(this.lockPath, FILE_MODE)
      flockSync(lockFd, 'exnb')
      this.lockFd = lockFd
    } catch (error) {
      try {
        if (lockFd !== undefined) closeSync(lockFd)
      } catch {
        // Preserve the acquisition error.
      }
      this.lockFd = undefined
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EAGAIN' || code === 'EACCES' || code === 'EWOULDBLOCK') {
        throw new Error(`[Session] session ${this.sessionId} 已被其他活跃写者锁定`, { cause: error })
      }
      throw error
    }
  }

  private releaseLock() {
    if (this.lockFd === undefined) return
    const lockFd = this.lockFd
    this.lockFd = undefined
    let releaseError: unknown
    try {
      flockSync(lockFd, 'un')
    } catch (error) {
      releaseError = error
    }
    try {
      closeSync(lockFd)
    } catch (error) {
      releaseError ||= error
    }
    if (releaseError) throw releaseError
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(async () => {
      if (this.fatalError) throw this.fatalError
      return operation()
    })
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async awaitPendingWrites() {
    await this.writeTail
    if (this.fatalError) throw this.fatalError
  }

  private async ensureInitialized() {
    if (this.initialized) return
    try {
      const parsed = await this.readJournal()
      const validated = validateV2Events(parsed.records)
      this.nextSequence = validated.nextSequence
      this.eventIds = validated.eventIds
      this.materializationIds = validated.materializationIds
      this.operations = new Map(reduceOperationEvents(
        parsed.records
          .filter((record) => record.schemaVersion === CURRENT_SCHEMA_VERSION && record.type === 'operation')
          .map((record) => parseOperationEvent(record)),
      ))
      this.hasV2Records = validated.sawV2
      this.hasV1Records = parsed.records.some((record) => record.schemaVersion === undefined)

      this.journalHandle = await this.io.open(
        this.filePath,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
        FILE_MODE,
      )
      await this.journalHandle.chmod(FILE_MODE)
      if (parsed.hasTrailingFragment) await this.journalHandle.truncate(parsed.validLength)
      this.initialized = true
    } catch (error) {
      this.fatalError ||= error
      throw error
    }
  }

  private async ensureV2UpgradeMarker() {
    if (!this.hasV1Records || this.hasV2Records) return
    const marker = this.createEvent({
      type: 'schema.upgraded',
      fromSchemaVersion: 1,
      toSchemaVersion: CURRENT_SCHEMA_VERSION,
    })
    await this.writeEvent(marker, 'buffered')
    this.acceptEvent(marker)
  }

  private createEvent(input: SessionEventInput): SessionEvent {
    const {
      schemaVersion: _schemaVersion,
      eventId: requestedEventId,
      sequence: requestedSequence,
      timestamp: requestedTimestamp,
      ...payload
    } = input
    void _schemaVersion

    if (requestedSequence !== undefined && requestedSequence !== this.nextSequence) {
      throw new Error(
        `[Session] event.sequence 无效: 期望 ${this.nextSequence}，实际 ${requestedSequence}`,
      )
    }
    if (
      requestedEventId !== undefined &&
      (typeof requestedEventId !== 'string' || requestedEventId.length === 0)
    ) {
      throw new Error('[Session] event.eventId 无效')
    }
    const eventId = requestedEventId ?? randomUUID()
    if (this.eventIds.has(eventId)) throw new Error(`[Session] eventId 重复: ${eventId}`)

    if (
      requestedTimestamp !== undefined &&
      (typeof requestedTimestamp !== 'string' || requestedTimestamp.length === 0)
    ) {
      throw new Error('[Session] event.timestamp 无效')
    }
    const timestamp = requestedTimestamp ?? new Date().toISOString()

    return {
      ...payload,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      eventId,
      sequence: this.nextSequence,
      type: input.type,
      timestamp,
    }
  }

  private projectOperationEvent(event: SessionEvent) {
    if (event.type !== 'operation') return undefined
    const operation = parseOperationEvent(event)
    return applyOperationEvent(this.operations.get(operation.operationId), operation)
  }

  private acceptEvent(event: SessionEvent, operationProjection?: OperationProjection) {
    this.eventIds.add(event.eventId)
    this.nextSequence++
    this.hasV2Records = true
    if (operationProjection) {
      this.operations.set(operationProjection.operationId, operationProjection)
    }
  }

  private async writeEvent(event: SessionEvent, durability: EventDurability) {
    if (!this.journalHandle) throw new Error('[Session] journal 尚未打开')
    const serialized = JSON.stringify(event)
    if (serialized === undefined) throw new Error('[Session] event 无法序列化')
    const bytes = Buffer.from(`${serialized}\n`, 'utf-8')
    try {
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await this.journalHandle.write(bytes, offset, bytes.length - offset)
        if (bytesWritten <= 0) throw new Error('[Session] journal write 未取得进展')
        offset += bytesWritten
      }
      if (durability === 'durable') await this.journalHandle.datasync()
    } catch (error) {
      this.fatalError ||= error
      throw error
    }
  }

  private async readJournal(): Promise<ParsedJournal> {
    let data: Buffer
    try {
      data = await this.io.readFile(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { records: [], validLength: 0, hasTrailingFragment: false }
      }
      throw error
    }

    const records: Record<string, unknown>[] = []
    let start = 0
    let lineNumber = 0
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 0x0a) continue
      lineNumber++
      let raw: string
      try {
        raw = UTF8_DECODER.decode(data.subarray(start, index)).replace(/\r$/, '')
      } catch (error) {
        throw new Error(`[Session] 第 ${lineNumber} 行不是有效 UTF-8，停止恢复`, { cause: error })
      }
      start = index + 1
      if (!raw.trim()) continue

      try {
        records.push(asRecord(JSON.parse(raw), lineNumber))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`[Session] 第 ${lineNumber} 行损坏，停止恢复: ${reason}`, { cause: error })
      }
    }

    const hasTrailingFragment = start < data.length
    if (hasTrailingFragment) {
      this.onWarning(`[Session] 忽略 EOF 尾部未完成记录（第 ${lineNumber + 1} 行）`)
    }

    return { records, validLength: start, hasTrailingFragment }
  }
}
