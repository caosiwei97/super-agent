import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { modelMessageSchema, type ModelMessage, type ToolModelMessage } from 'ai'
import {
  applyOperationEvent,
  parseOperationEvent,
} from '../execution/operation-ledger.js'
import type { OperationProjection } from '../execution/operation-types.js'
import {
  SessionJournalScanError,
  scanSessionJournal,
  type SessionJournalDiagnostic,
  type SessionJournalRecordHandler,
  type SessionJournalScanResult,
} from './journal-scanner.js'
import {
  applySessionRecord,
  createEmptySessionState,
  createSessionSchemaTransitionState,
  validateSessionRecord,
  validateSessionSchemaTransition,
} from './session-records.js'
import {
  SessionFileLease,
  nodeSessionJournalIo,
  type SessionJournalIo,
} from './session-file-lease.js'
import {
  DEFAULT_SESSION_MAX_READ_RECORD_BYTES,
  DEFAULT_SESSION_MAX_RECORD_BYTES,
  defaultSessionStorageLimits,
  type SessionFormatV1,
  type SessionStorageLimits,
} from './session-layout.js'
import {
  migrateLegacySession,
  type SessionMigrationProbe,
} from './session-migration.js'
import {
  calculateOperationReservationTransition,
  operationQuotaAdmissionClass,
  preflightSessionQuotaAdmission,
  rebuildSessionQuotaReservation,
  type SessionQuotaAdmissionClass,
} from './session-quota.js'
import {
  SessionSegmentStorage,
  type SessionSegmentDiagnostic,
  type SessionSegmentStorageIo,
  type SessionSegmentStorageProbe,
} from './session-segment-storage.js'

export {
  nodeSessionJournalIo,
  type SessionJournalFile,
  type SessionJournalIo,
} from './session-file-lease.js'

const DEFAULT_SESSION_DIR = '.sessions'
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/
const CURRENT_SCHEMA_VERSION = 2 as const

/** Existing v1/v2 records may be larger than the stricter ceiling for new writes. */
export const DEFAULT_MAX_SESSION_READ_RECORD_BYTES = DEFAULT_SESSION_MAX_READ_RECORD_BYTES

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
  /** Last journal sequence represented by this derived checkpoint. */
  throughSequence?: number
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

export type SessionStoreDiagnosticCode =
  | SessionJournalScanError['code']
  | SessionJournalDiagnostic['code']
  | SessionSegmentDiagnostic['code']

export interface SessionStoreDiagnostic {
  code: SessionStoreDiagnosticCode
  severity: 'warning' | 'fatal'
  sessionId: string
  path: string
  line?: number
  byteOffset?: number
  byteLength?: number
  repaired: boolean
  message: string
}

export class SessionRecordTooLargeError extends Error {
  readonly code = 'session_record_too_large'

  constructor(
    readonly actualBytes: number,
    readonly maxRecordBytes: number,
  ) {
    super(`Session journal 记录为 ${actualBytes} bytes，超过 ${maxRecordBytes} bytes 上限`)
    this.name = 'SessionRecordTooLargeError'
  }
}

export interface SessionStoreOptions {
  directory?: string
  onWarning?: (message: string) => void
  onDiagnostic?: (diagnostic: SessionStoreDiagnostic) => void
  /** Maximum UTF-8 bytes for newly appended JSONL records, including newline. */
  maxRecordBytes?: number
  /** Compatibility ceiling for existing records. Must be at least maxRecordBytes. */
  maxReadRecordBytes?: number
  /** Immutable soft segment target for newly migrated/created layout-v1 sessions. */
  segmentTargetBytes?: number
  /** Immutable regular event soft quota. */
  regularQuotaBytes?: number
  /** Immutable reserve for Operation recovery obligations and critical records. */
  criticalReserveBytes?: number
  io?: SessionJournalIo
  /** Descriptor-preserving segment I/O seam for fault tests. */
  segmentIo?: SessionSegmentStorageIo
  migrationProbe?: SessionMigrationProbe
  segmentProbe?: SessionSegmentStorageProbe
}

interface PreparedSessionEvent {
  readonly event: SessionEvent
  readonly bytes: Uint8Array
}

interface RecoveredSessionStorageState {
  readonly scanned: SessionJournalScanResult
  readonly operations: Map<string, OperationProjection>
  readonly materializedOperationIds: Set<string>
  readonly reservationSlots: number
}

export function createSessionId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${timestamp}_${randomUUID().slice(0, 8)}`
}

export function validateSessionId(sessionId: string) {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`非法 session ID: ${sessionId}`)
  }
}

function emptyState(): SessionState {
  return createEmptySessionState()
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

/**
 * Append-only, versioned session journal with a process-lifetime single-writer lock.
 * Buffered writes are complete OS writes; durable writes additionally wait for
 * fdatasync before acknowledging the event.
 */
export class SessionStore implements SessionWriter, DurableEventWriter {
  private readonly lease: SessionFileLease
  private readonly filePath: string
  private readonly directoryPath: string
  private readonly onWarning: (message: string) => void
  private readonly onDiagnostic: (diagnostic: SessionStoreDiagnostic) => void
  private readonly requestedLimits: Partial<SessionStorageLimits>
  private readonly segmentIo: SessionSegmentStorageIo | undefined
  private readonly migrationProbe: SessionMigrationProbe | undefined
  private readonly segmentProbe: SessionSegmentStorageProbe | undefined
  private maxRecordBytes = DEFAULT_SESSION_MAX_RECORD_BYTES
  private maxReadRecordBytes = DEFAULT_MAX_SESSION_READ_RECORD_BYTES
  private format: SessionFormatV1 | undefined
  private segmentStorage: SessionSegmentStorage | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private fatalError: unknown
  private initialized = false
  private nextSequence = 1
  private eventIds = new Set<string>()
  private materializationIds = new Set<string>()
  private materializedOperationIds = new Set<string>()
  private operations = new Map<string, OperationProjection>()
  private usedEventBytes = 0
  private reservedCriticalSlots = 0
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
    this.onWarning = options.onWarning || ((message) => console.warn(message))
    this.onDiagnostic = options.onDiagnostic || (() => undefined)
    this.requestedLimits = Object.freeze({
      ...(options.maxRecordBytes === undefined
        ? {} : { maxRecordBytes: options.maxRecordBytes }),
      ...(options.maxReadRecordBytes === undefined
        ? {} : { maxReadRecordBytes: options.maxReadRecordBytes }),
      ...(options.segmentTargetBytes === undefined
        ? {} : { segmentTargetBytes: options.segmentTargetBytes }),
      ...(options.regularQuotaBytes === undefined
        ? {} : { regularQuotaBytes: options.regularQuotaBytes }),
      ...(options.criticalReserveBytes === undefined
        ? {} : { criticalReserveBytes: options.criticalReserveBytes }),
    })
    // Validate explicit values without turning omitted defaults into reopen conflicts.
    defaultSessionStorageLimits(this.requestedLimits)
    this.segmentIo = options.segmentIo
    this.migrationProbe = options.migrationProbe
    this.segmentProbe = options.segmentProbe
    this.directoryPath = resolve(options.directory || DEFAULT_SESSION_DIR)
    this.lease = new SessionFileLease(
      this.directoryPath,
      sessionId,
      options.io || nodeSessionJournalIo,
    )
    this.filePath = this.lease.filePath
  }

  static async open(sessionId: string, options: SessionStoreOptions = {}) {
    const store = new SessionStore(sessionId, options)
    try {
      if (!store.exists()) return store
      await store.ensureInitialized()
      return store
    } catch (error) {
      await store.close().catch(() => undefined)
      throw error
    }
  }

  getSessionId() {
    return this.sessionId
  }

  exists() {
    return this.lease.exists()
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

    return this.enqueueOperation(async () => {
      await this.ensureInitialized()
      if (this.materializationIds.has(commit.materializationId)) return false
      const prepared = this.serializeEvent(this.createEvent({
        type: 'messages',
        messages: [commit.message],
        materializationId: commit.materializationId,
        operationId: commit.operationId,
        ...(budgetUsed === undefined ? {} : { budgetUsed }),
      }, this.nextAppendSequence()))
      await this.commitPreparedEvent(prepared, undefined, 'durable')
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
    if (input.type === 'schema.upgraded') {
      throw new Error('[Session] schema.upgraded 是 Store 保留事件类型')
    }
    if (input.schemaVersion !== undefined && input.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`[Session] event.schemaVersion 必须为 ${CURRENT_SCHEMA_VERSION}`)
    }

    return this.enqueueOperation(async () => {
      await this.ensureInitialized()
      const prepared = this.serializeEvent(
        this.createEvent(input, this.nextAppendSequence()),
      )
      const operationProjection = this.projectOperationEvent(prepared.event)
      await this.commitPreparedEvent(prepared, operationProjection, durability)
      return prepared.event
    })
  }

  /** Returns the ordered v2 stream; v1 records remain available through loadState(). */
  replayEvents(): Promise<SessionEvent[]> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error(`[Session] session ${this.sessionId} 已关闭`))
    }
    return this.enqueueOperation(async () => {
      if (!this.exists()) return []
      await this.ensureInitialized()
      const events: SessionEvent[] = []
      await this.scanJournal(true, (record) => {
        if (record.schemaVersion === CURRENT_SCHEMA_VERSION) events.push(record as SessionEvent)
      })
      return events
    })
  }

  loadState(): Promise<SessionState> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error(`[Session] session ${this.sessionId} 已关闭`))
    }
    return this.enqueueOperation(async () => {
      if (!this.exists()) return emptyState()
      await this.ensureInitialized()
      let state = emptyState()
      await this.scanJournal(true, (record, location) => {
        state = applySessionRecord(state, record, location.line)
      })
      return state
    })
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
      if (this.segmentStorage) await this.segmentStorage.close()
      else if (this.lease.hasOpenJournal()) await this.lease.datasync()
    } catch (error) {
      closeError = error
    }

    try {
      await this.lease.close()
    } catch (error) {
      closeError ||= error
    } finally {
      this.closed = true
      this.closing = false
    }

    if (closeError) throw closeError
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
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

  private async ensureInitialized() {
    if (this.initialized) return
    let migrationState: RecoveredSessionStorageState | undefined
    const migration = await migrateLegacySession({
      directory: this.directoryPath,
      sessionId: this.sessionId,
      lease: this.lease,
      limits: this.requestedLimits,
      verifyPreparedBundle: async ({ format, readChunks }) => {
        migrationState = await this.recoverStorageState(readChunks(), format)
        this.assertRecoveredQuota(format, migrationState)
      },
      ...(this.migrationProbe === undefined ? {} : { probe: this.migrationProbe }),
    })
    this.format = migration.format
    this.maxRecordBytes = migration.format.limits.maxRecordBytes
    this.maxReadRecordBytes = migration.format.limits.maxReadRecordBytes

    const storage = await SessionSegmentStorage.open({
      paths: migration.paths,
      format: migration.format,
      ...(this.segmentIo === undefined ? {} : { io: this.segmentIo }),
      ...(this.segmentProbe === undefined ? {} : { probe: this.segmentProbe }),
      onManifestCacheWarning: (message) => this.emitWarning(message),
    })
    let recovered: RecoveredSessionStorageState
    try {
      recovered = await this.recoverStorageState(storage.readChunks(), migration.format)
      this.assertRecoveredQuota(migration.format, recovered)
      this.acceptRecoveredState(recovered)
    } catch (error) {
      try {
        await storage.close()
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          '[Session] recovery failed and its segment descriptors could not be closed',
        )
      }
      throw error
    }
    // Ownership transfers only after recovery and quota admission succeed.
    // A lazy-init retry must never overwrite an unreachable open storage.
    this.segmentStorage = storage

    if (migration.repairedLegacyEofBytes > 0) {
      this.reportTrailingFragment(Object.freeze({
        code: 'trailing_eof_fragment',
        severity: 'warning',
        repaired: false,
        line: recovered.scanned.lineCount + 1,
        byteOffset: migration.format.source.byteLength,
        byteLength: migration.repairedLegacyEofBytes,
        message: 'Legacy session journal had an unterminated EOF record',
      }), true, migration.paths.legacyJournalPath)
    }
    for (const diagnostic of storage.recoveryDiagnostics) {
      this.reportSegmentDiagnostic(diagnostic)
    }
    // The migration callback is deliberately rechecked against the opened
    // writer catalog; never trust a callback result across the fence handoff.
    void migrationState
    this.initialized = true
  }

  private async recoverStorageState(
    input: AsyncIterable<Uint8Array>,
    format: SessionFormatV1,
  ): Promise<RecoveredSessionStorageState> {
    const operations = new Map<string, OperationProjection>()
    const materializedOperationIds = new Set<string>()
    const schemaTransition = createSessionSchemaTransitionState()
    await this.lease.assertSafe()
    const scanned = await scanSessionJournal(input, {
      maxRecordBytes: format.limits.maxReadRecordBytes,
      onRecord: (record, location) => {
        validateSessionRecord(record, location.line)
        validateSessionSchemaTransition(schemaTransition, record, location.line)
        if (record.schemaVersion === CURRENT_SCHEMA_VERSION && record.type === 'operation') {
          const operation = parseOperationEvent(record)
          const projection = applyOperationEvent(operations.get(operation.operationId), operation)
          operations.set(operation.operationId, projection)
        }
        if (typeof record.materializationId === 'string' &&
            typeof record.operationId === 'string') {
          materializedOperationIds.add(record.operationId)
        }
      },
    })
    await this.lease.assertSafe()
    if (scanned.diagnostics.length > 0) {
      throw new Error('[Session] opened segment storage retained an EOF fragment')
    }
    const reservation = rebuildSessionQuotaReservation({
      operations: operations.values(),
      materializedOperationIds,
      slotBytes: format.limits.maxRecordBytes,
    })
    return Object.freeze({
      scanned,
      operations,
      materializedOperationIds,
      reservationSlots: reservation.totalSlots,
    })
  }

  private assertRecoveredQuota(
    format: SessionFormatV1,
    recovered: RecoveredSessionStorageState,
  ) {
    const reservedBytes = recovered.reservationSlots * format.limits.maxRecordBytes
    const hardLimit = format.limits.regularQuotaBytes + format.limits.criticalReserveBytes
    if (!Number.isSafeInteger(reservedBytes) ||
        reservedBytes > format.limits.criticalReserveBytes ||
        !Number.isSafeInteger(recovered.scanned.byteLength + reservedBytes) ||
        recovered.scanned.byteLength + reservedBytes > hardLimit) {
      throw new Error(
        '[Session] recovered event bytes and Operation obligations exceed the immutable quota',
      )
    }
  }

  private acceptRecoveredState(recovered: RecoveredSessionStorageState) {
    const { scanned } = recovered
    this.nextSequence = scanned.nextSequence
    this.eventIds = new Set(scanned.eventIds)
    this.materializationIds = new Set(scanned.materializationIds)
    this.materializedOperationIds = new Set(recovered.materializedOperationIds)
    this.operations = recovered.operations
    this.usedEventBytes = scanned.byteLength
    this.reservedCriticalSlots = recovered.reservationSlots
    this.hasV2Records = scanned.v2RecordCount > 0
    this.hasV1Records = scanned.v1RecordCount > 0
  }

  private reportSegmentDiagnostic(diagnostic: SessionSegmentDiagnostic) {
    const repaired = diagnostic.repaired
    const message = diagnostic.code === 'trailing_eof_fragment'
      ? repaired
        ? '已截断 active session segment 的 EOF 未完成记录'
        : 'active session segment 存在 EOF 未完成记录，尚未修复'
      : diagnostic.code === 'active_segment_missing'
        ? repaired
          ? '已在 sealed tail 后建立新的 active session segment'
          : 'sealed tail 后缺少 active session segment，尚未修复'
        : repaired
          ? '已从 segment 事实重建可重建 session manifest'
          : 'session manifest 重建失败；segment 事实仍可用于后续重建'
    const value: SessionStoreDiagnostic = Object.freeze({
      code: diagnostic.code,
      severity: 'warning',
      sessionId: this.sessionId,
      path: diagnostic.path,
      ...(diagnostic.byteOffset === undefined ? {} : { byteOffset: diagnostic.byteOffset }),
      ...(diagnostic.byteLength === undefined ? {} : { byteLength: diagnostic.byteLength }),
      repaired,
      message,
    })
    this.emitDiagnostic(value)
    this.emitWarning(`[Session] ${message}`)
  }

  private nextAppendSequence() {
    return this.nextSequence + (this.hasV1Records && !this.hasV2Records ? 1 : 0)
  }

  private createEvent(input: SessionEventInput, sequence = this.nextSequence): SessionEvent {
    const {
      schemaVersion: _schemaVersion,
      eventId: requestedEventId,
      sequence: requestedSequence,
      timestamp: requestedTimestamp,
      ...payload
    } = input
    void _schemaVersion

    if (requestedSequence !== undefined && requestedSequence !== sequence) {
      throw new Error(
        `[Session] event.sequence 无效: 期望 ${sequence}，实际 ${requestedSequence}`,
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

    if (payload.materializationId !== undefined) {
      if (typeof payload.materializationId !== 'string' ||
        payload.materializationId.length === 0) {
        throw new Error('[Session] event.materializationId 无效')
      }
      if (this.materializationIds.has(payload.materializationId)) {
        throw new Error(`[Session] materializationId 重复: ${payload.materializationId}`)
      }
    }

    const checkpointSequence = sequence - 1
    if (input.type === 'checkpoint' && payload.throughSequence !== undefined &&
      payload.throughSequence !== checkpointSequence) {
      throw new Error(
        `[Session] checkpoint.throughSequence 无效: 期望 ${checkpointSequence}，实际 ${String(payload.throughSequence)}`,
      )
    }
    const checkpointFields = input.type === 'checkpoint'
      ? { throughSequence: checkpointSequence }
      : {}

    const event: SessionEvent = {
      ...payload,
      ...checkpointFields,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      eventId,
      sequence,
      type: input.type,
      timestamp,
    }
    validateSessionRecord(event, sequence)
    return event
  }

  private projectOperationEvent(event: SessionEvent) {
    if (event.type !== 'operation') return undefined
    const operation = parseOperationEvent(event)
    return applyOperationEvent(this.operations.get(operation.operationId), operation)
  }

  private async commitPreparedEvent(
    prepared: PreparedSessionEvent,
    operationProjection: OperationProjection | undefined,
    durability: EventDurability,
  ) {
    try {
      await this.lease.assertSafe()
    } catch (error) {
      this.fatalError ||= error
      throw error
    }
    const format = this.requireFormat()
    const storage = this.requireSegmentStorage()
    const marker = this.hasV1Records && !this.hasV2Records
      ? this.serializeEvent(this.createEvent({
          type: 'schema.upgraded',
          fromSchemaVersion: 1,
          toSchemaVersion: CURRENT_SCHEMA_VERSION,
        }))
      : undefined
    const batch = marker === undefined ? [prepared] : [marker, prepared]
    this.assertPreparedBatchStillNext(batch)

    let reservationSlotsAfter = this.reservedCriticalSlots
    if (operationProjection) {
      const before = this.operations.get(operationProjection.operationId)
      const materialized = this.materializedOperationIds.has(operationProjection.operationId)
      reservationSlotsAfter += calculateOperationReservationTransition({
        ...(before === undefined ? {} : { before }),
        after: operationProjection,
        materializedBefore: materialized,
        materializedAfter: materialized,
      }).deltaSlots
    }
    let newlyMaterializedOperationId: string | undefined
    if (typeof prepared.event.materializationId === 'string' &&
        typeof prepared.event.operationId === 'string') {
      const operationId = prepared.event.operationId
      if (!this.materializedOperationIds.has(operationId)) {
        newlyMaterializedOperationId = operationId
        const projection = operationProjection?.operationId === operationId
          ? operationProjection
          : this.operations.get(operationId)
        if (projection) {
          reservationSlotsAfter += calculateOperationReservationTransition({
            before: projection,
            after: projection,
            materializedBefore: false,
            materializedAfter: true,
          }).deltaSlots
        }
      }
    }
    const businessClass = this.quotaAdmissionClass(prepared.event)
    const admission = preflightSessionQuotaAdmission({
      limits: format.limits,
      usedEventBytes: this.usedEventBytes,
      reservedCriticalSlots: this.reservedCriticalSlots,
    }, {
      records: batch.map(({ bytes }) => ({
        bytes,
        admissionClass: businessClass,
      })),
      reservedCriticalSlotsAfter: reservationSlotsAfter,
    })
    const appendPlan = storage.prepareAppendBatch(batch.map(({ bytes }) => bytes))

    try {
      await storage.appendPreparedBatch(appendPlan, { durability })
      await this.lease.assertSafe()
    } catch (error) {
      this.fatalError ||= error
      throw error
    }
    if (storage.catalog.totalEventBytes !== admission.usedEventBytesAfter) {
      const error = new Error('[Session] segment catalog byte count diverged after append')
      this.fatalError ||= error
      throw error
    }
    if (marker) this.acceptEvent(marker.event)
    this.acceptEvent(prepared.event, operationProjection)
    if (newlyMaterializedOperationId) {
      this.materializedOperationIds.add(newlyMaterializedOperationId)
    }
    this.usedEventBytes = admission.usedEventBytesAfter
    this.reservedCriticalSlots = reservationSlotsAfter
  }

  private quotaAdmissionClass(event: SessionEvent): SessionQuotaAdmissionClass {
    if (event.type === 'operation') {
      return operationQuotaAdmissionClass(parseOperationEvent(event).status)
    }
    if (typeof event.materializationId === 'string' &&
        typeof event.operationId === 'string' &&
        this.operations.has(event.operationId)) {
      return 'critical'
    }
    return 'regular'
  }

  private assertPreparedBatchStillNext(batch: readonly PreparedSessionEvent[]) {
    let sequence = this.nextSequence
    const eventIds = new Set(this.eventIds)
    const materializationIds = new Set(this.materializationIds)
    for (const { event } of batch) {
      if (event.sequence !== sequence) {
        throw new Error('[Session] prepared event sequence 已过期')
      }
      if (eventIds.has(event.eventId)) {
        throw new Error(`[Session] eventId 重复: ${event.eventId}`)
      }
      eventIds.add(event.eventId)
      if (typeof event.materializationId === 'string') {
        if (materializationIds.has(event.materializationId)) {
          throw new Error(`[Session] materializationId 重复: ${event.materializationId}`)
        }
        materializationIds.add(event.materializationId)
      }
      sequence++
    }
  }

  private requireFormat() {
    if (!this.format) throw new Error('[Session] immutable format 尚未准备')
    return this.format
  }

  private requireSegmentStorage() {
    if (!this.segmentStorage) throw new Error('[Session] segment storage 尚未准备')
    return this.segmentStorage
  }

  private acceptEvent(event: SessionEvent, operationProjection?: OperationProjection) {
    this.eventIds.add(event.eventId)
    if (typeof event.materializationId === 'string') {
      this.materializationIds.add(event.materializationId)
    }
    this.nextSequence++
    this.hasV2Records = true
    if (operationProjection) {
      this.operations.set(operationProjection.operationId, operationProjection)
    }
  }

  private serializeEvent(event: SessionEvent): PreparedSessionEvent {
    const expectedEnvelope = Object.freeze({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      materializationId: event.materializationId,
      throughSequence: event.type === 'checkpoint' ? event.throughSequence : undefined,
    })
    const serialized = JSON.stringify(event)
    if (serialized === undefined) throw new Error('[Session] event 无法序列化')
    const bytes = Buffer.from(`${serialized}\n`, 'utf-8')
    if (bytes.length > this.maxRecordBytes) {
      throw new SessionRecordTooLargeError(bytes.length, this.maxRecordBytes)
    }

    const parsed: unknown = JSON.parse(serialized)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('[Session] event 序列化结果必须是 object')
    }
    const canonical = parsed as Record<string, unknown>
    if (
      canonical.schemaVersion !== expectedEnvelope.schemaVersion ||
      canonical.eventId !== expectedEnvelope.eventId ||
      canonical.sequence !== expectedEnvelope.sequence ||
      canonical.type !== expectedEnvelope.type ||
      canonical.timestamp !== expectedEnvelope.timestamp ||
      canonical.materializationId !== expectedEnvelope.materializationId ||
      (expectedEnvelope.type === 'checkpoint' &&
        canonical.throughSequence !== expectedEnvelope.throughSequence)
    ) {
      throw new Error('[Session] event 序列化改变了 Store 保护字段')
    }
    validateSessionRecord(canonical, expectedEnvelope.sequence)
    return Object.freeze({ event: canonical as SessionEvent, bytes })
  }

  private async scanJournal(
    reportTrailing: boolean,
    onRecord?: SessionJournalRecordHandler,
  ): Promise<SessionJournalScanResult> {
    try {
      await this.lease.assertSafe()
      const scanned = await scanSessionJournal(this.requireSegmentStorage().readChunks(), {
        maxRecordBytes: this.maxReadRecordBytes,
        ...(onRecord === undefined ? {} : { onRecord }),
      })
      await this.lease.assertSafe()
      if (reportTrailing && scanned.diagnostics.length > 0) {
        this.reportTrailingFragment(scanned.diagnostics[0]!, false)
      }
      return scanned
    } catch (error) {
      if (error instanceof SessionJournalScanError) this.reportScanError(error)
      await this.lease.assertSafe()
      throw error
    }
  }

  private reportTrailingFragment(
    diagnostic: SessionJournalDiagnostic,
    repaired: boolean,
    path = this.filePath,
  ) {
    const value: SessionStoreDiagnostic = Object.freeze({
      code: diagnostic.code,
      severity: 'warning',
      sessionId: this.sessionId,
      path,
      line: diagnostic.line,
      byteOffset: diagnostic.byteOffset,
      byteLength: diagnostic.byteLength,
      repaired,
      message: repaired
        ? '已截断 session journal 的 EOF 未完成记录'
        : '已忽略 session journal 的 EOF 未完成记录',
    })
    this.emitDiagnostic(value)
    this.emitWarning(`[Session] ${value.message}（第 ${diagnostic.line} 行）`)
  }

  private reportScanError(error: SessionJournalScanError) {
    const location = error.location
    const localized = location === undefined
      ? undefined
      : this.segmentStorage?.localizeRecordLocation(location)
    this.emitDiagnostic(Object.freeze({
      code: error.code,
      severity: 'fatal',
      sessionId: this.sessionId,
      path: localized?.path ?? this.filePath,
      ...(location === undefined ? {} : {
        line: localized?.line ?? location.line,
        byteOffset: localized?.byteOffset ?? location.byteOffset,
        byteLength: localized?.byteLength ?? location.byteLength,
      }),
      repaired: false,
      message: `Session journal validation failed: ${error.code}`,
    }))
  }

  private emitDiagnostic(diagnostic: SessionStoreDiagnostic) {
    try {
      this.onDiagnostic(diagnostic)
    } catch {
      // Observability callbacks must never change storage recovery semantics.
    }
  }

  private emitWarning(message: string) {
    try {
      this.onWarning(message)
    } catch {
      // Observability callbacks must never change storage recovery semantics.
    }
  }
}
