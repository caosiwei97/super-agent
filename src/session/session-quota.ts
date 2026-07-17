import type {
  OperationProjection,
  OperationStatus,
} from '../execution/operation-types.js'
import type { SessionStorageLimits } from './session-layout.js'

export const PROPOSED_OPERATION_RESERVATION_SLOTS = 2
export const STARTED_OPERATION_RESERVATION_SLOTS = 3
export const UNCERTAIN_OPERATION_RESERVATION_SLOTS = 2
export const TERMINAL_OPERATION_RESERVATION_SLOTS = 1
export const MATERIALIZED_OPERATION_RESERVATION_SLOTS = 0

const REGULAR_OPERATION_STATUSES = new Set<OperationStatus>([
  'proposed',
  'approved',
  'started',
])

const TERMINAL_OPERATION_STATUSES = new Set<OperationStatus>([
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'reconciled_succeeded',
  'reconciled_failed',
  'superseded',
])

export type SessionQuotaErrorCode =
  | 'invalid_quota_state'
  | 'invalid_quota_batch'
  | 'record_too_large'
  | 'regular_quota_exceeded'
  | 'critical_reserve_exceeded'
  | 'total_quota_exceeded'

export class SessionQuotaError extends Error {
  constructor(
    readonly code: SessionQuotaErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionQuotaError'
  }
}

export type SessionQuotaAdmissionClass = 'regular' | 'critical'

export interface SessionQuotaReservation {
  readonly slotBytes: number
  readonly totalSlots: number
  readonly reservedBytes: number
  readonly slotsByOperationId: ReadonlyMap<string, number>
}

export interface RebuildSessionQuotaReservationOptions {
  readonly operations: Iterable<OperationProjection>
  /** Collected from stable materialization events' operationId fields. */
  readonly materializedOperationIds: ReadonlySet<string>
  /** One slot covers one maximum-sized complete JSONL record. */
  readonly slotBytes: number
}

export interface OperationReservationTransition {
  readonly operationId: string
  readonly beforeSlots: number
  readonly afterSlots: number
  readonly deltaSlots: number
}

export interface SessionQuotaAdmissionState {
  readonly limits: Pick<SessionStorageLimits,
    'maxRecordBytes' | 'regularQuotaBytes' | 'criticalReserveBytes'>
  /** Complete JSONL event bytes already present in all segments. */
  readonly usedEventBytes: number
  /** Rebuilt from the complete Operation projection and materializations. */
  readonly reservedCriticalSlots: number
}

export interface SessionQuotaBatchRecord {
  /** Exact complete JSONL bytes, including the terminating LF. */
  readonly bytes: Uint8Array
  readonly admissionClass: SessionQuotaAdmissionClass
}

export interface SessionQuotaAdmissionRequest {
  /** Schema marker and business event belong in this one atomic array. */
  readonly records: readonly SessionQuotaBatchRecord[]
  /** Reservation after every record in this batch has been projected. */
  readonly reservedCriticalSlotsAfter: number
}

export interface SessionQuotaAdmission {
  readonly usedEventBytesBefore: number
  readonly usedEventBytesAfter: number
  readonly batchEventBytes: number
  readonly regularEventBytes: number
  readonly criticalEventBytes: number
  readonly reservedCriticalSlotsBefore: number
  readonly reservedCriticalSlotsAfter: number
  readonly reservedCriticalBytesAfter: number
  readonly hardLimitBytes: number
}

function quotaError(code: SessionQuotaErrorCode, message: string): never {
  throw new SessionQuotaError(code, message)
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    quotaError('invalid_quota_state', `${field} must be a non-negative safe integer`)
  }
  return value as number
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    quotaError('invalid_quota_state', `${field} must be a positive safe integer`)
  }
  return value as number
}

function checkedAdd(left: number, right: number, field: string): number {
  const value = left + right
  if (!Number.isSafeInteger(value)) {
    quotaError('invalid_quota_state', `${field} exceeds Number.MAX_SAFE_INTEGER`)
  }
  return value
}

function checkedMultiply(left: number, right: number, field: string): number {
  const value = left * right
  if (!Number.isSafeInteger(value)) {
    quotaError('invalid_quota_state', `${field} exceeds Number.MAX_SAFE_INTEGER`)
  }
  return value
}

export function reservationSlotsForOperation(
  projection: OperationProjection,
  materialized: boolean,
): number {
  if (projection.operationId !== projection.latestEvent.operationId ||
      projection.status !== projection.latestEvent.status) {
    quotaError('invalid_quota_state', 'Operation projection identity or status is inconsistent')
  }
  if (materialized) {
    if (!TERMINAL_OPERATION_STATUSES.has(projection.status)) {
      quotaError('invalid_quota_state', 'A non-terminal operation cannot be materialized')
    }
    return MATERIALIZED_OPERATION_RESERVATION_SLOTS
  }
  if (projection.status === 'proposed' || projection.status === 'approved') {
    return PROPOSED_OPERATION_RESERVATION_SLOTS
  }
  if (projection.status === 'started') return STARTED_OPERATION_RESERVATION_SLOTS
  if (projection.status === 'uncertain') return UNCERTAIN_OPERATION_RESERVATION_SLOTS
  if (TERMINAL_OPERATION_STATUSES.has(projection.status)) {
    return TERMINAL_OPERATION_RESERVATION_SLOTS
  }
  quotaError('invalid_quota_state', `Unsupported Operation status: ${projection.status}`)
}

export function operationQuotaAdmissionClass(
  status: OperationStatus,
): SessionQuotaAdmissionClass {
  return REGULAR_OPERATION_STATUSES.has(status) ? 'regular' : 'critical'
}

export function calculateOperationReservationTransition(input: {
  readonly before?: OperationProjection
  readonly after: OperationProjection
  readonly materializedBefore?: boolean
  readonly materializedAfter?: boolean
}): OperationReservationTransition {
  if (input.before !== undefined && input.before.operationId !== input.after.operationId) {
    quotaError('invalid_quota_state', 'Reservation transition crosses operation identities')
  }
  const beforeSlots = input.before === undefined
    ? 0
    : reservationSlotsForOperation(input.before, input.materializedBefore ?? false)
  const afterSlots = reservationSlotsForOperation(
    input.after,
    input.materializedAfter ?? false,
  )
  return Object.freeze({
    operationId: input.after.operationId,
    beforeSlots,
    afterSlots,
    deltaSlots: afterSlots - beforeSlots,
  })
}

export function rebuildSessionQuotaReservation(
  options: RebuildSessionQuotaReservationOptions,
): SessionQuotaReservation {
  const slotBytes = positiveSafeInteger(options.slotBytes, 'slotBytes')
  const slotsByOperationId = new Map<string, number>()
  let totalSlots = 0
  for (const projection of options.operations) {
    if (slotsByOperationId.has(projection.operationId)) {
      quotaError('invalid_quota_state', `Duplicate Operation projection: ${projection.operationId}`)
    }
    const slots = reservationSlotsForOperation(
      projection,
      options.materializedOperationIds.has(projection.operationId),
    )
    slotsByOperationId.set(projection.operationId, slots)
    totalSlots = checkedAdd(totalSlots, slots, 'reservation slots')
  }
  return Object.freeze({
    slotBytes,
    totalSlots,
    reservedBytes: checkedMultiply(totalSlots, slotBytes, 'reserved bytes'),
    slotsByOperationId,
  })
}

/** Measure the exact bytes the ordinary JSON.stringify append path will write. */
export function measureJsonlEventBytes(event: unknown): number {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(event)
  } catch {
    quotaError('invalid_quota_batch', 'Event cannot be serialized as JSON')
  }
  if (serialized === undefined) {
    quotaError('invalid_quota_batch', 'Event cannot be serialized as a JSONL record')
  }
  return Buffer.byteLength(serialized, 'utf8') + 1
}

/**
 * Pure quota preflight. It neither writes, rotates, changes projections nor
 * consumes a sequence. Callers must commit the complete accepted batch later in
 * the same single-writer critical section.
 */
export function preflightSessionQuotaAdmission(
  state: SessionQuotaAdmissionState,
  request: SessionQuotaAdmissionRequest,
): SessionQuotaAdmission {
  const maxRecordBytes = positiveSafeInteger(
    state.limits.maxRecordBytes,
    'limits.maxRecordBytes',
  )
  const regularQuotaBytes = positiveSafeInteger(
    state.limits.regularQuotaBytes,
    'limits.regularQuotaBytes',
  )
  const criticalReserveBytes = positiveSafeInteger(
    state.limits.criticalReserveBytes,
    'limits.criticalReserveBytes',
  )
  const usedEventBytes = nonNegativeSafeInteger(state.usedEventBytes, 'usedEventBytes')
  const reservedCriticalSlots = nonNegativeSafeInteger(
    state.reservedCriticalSlots,
    'reservedCriticalSlots',
  )
  const reservedCriticalSlotsAfter = nonNegativeSafeInteger(
    request.reservedCriticalSlotsAfter,
    'reservedCriticalSlotsAfter',
  )
  if (!Array.isArray(request.records) || request.records.length === 0) {
    quotaError('invalid_quota_batch', 'Quota admission batch must contain at least one record')
  }

  const hardLimitBytes = checkedAdd(
    regularQuotaBytes,
    criticalReserveBytes,
    'total quota',
  )
  const reservedCriticalBytesBefore = checkedMultiply(
    reservedCriticalSlots,
    maxRecordBytes,
    'reserved bytes before admission',
  )
  if (reservedCriticalBytesBefore > criticalReserveBytes ||
      checkedAdd(usedEventBytes, reservedCriticalBytesBefore, 'current quota commitment') >
        hardLimitBytes) {
    quotaError('invalid_quota_state', 'Recovered event bytes and reservations exceed quota')
  }

  let batchEventBytes = 0
  let regularEventBytes = 0
  let criticalEventBytes = 0
  for (const record of request.records) {
    if (!(record.bytes instanceof Uint8Array) || record.bytes.byteLength === 0 ||
        record.bytes[record.bytes.byteLength - 1] !== 0x0a ||
        record.bytes.subarray(0, record.bytes.byteLength - 1).includes(0x0a)) {
      quotaError('invalid_quota_batch', 'Quota admission requires one complete JSONL record')
    }
    if (record.bytes.byteLength > maxRecordBytes) {
      quotaError('record_too_large', 'JSONL record exceeds maxRecordBytes')
    }
    if (record.admissionClass !== 'regular' && record.admissionClass !== 'critical') {
      quotaError('invalid_quota_batch', 'Quota admission class is invalid')
    }
    batchEventBytes = checkedAdd(batchEventBytes, record.bytes.byteLength, 'batch bytes')
    if (record.admissionClass === 'regular') {
      regularEventBytes = checkedAdd(
        regularEventBytes,
        record.bytes.byteLength,
        'regular batch bytes',
      )
    } else {
      criticalEventBytes = checkedAdd(
        criticalEventBytes,
        record.bytes.byteLength,
        'critical batch bytes',
      )
    }
  }

  if (regularEventBytes > 0 &&
      checkedAdd(usedEventBytes, regularEventBytes, 'regular quota use') > regularQuotaBytes) {
    quotaError('regular_quota_exceeded', 'Regular events cannot consume critical reserve')
  }
  const reservedCriticalBytesAfter = checkedMultiply(
    reservedCriticalSlotsAfter,
    maxRecordBytes,
    'reserved bytes after admission',
  )
  if (reservedCriticalBytesAfter > criticalReserveBytes) {
    quotaError('critical_reserve_exceeded', 'Operation reservations exceed critical reserve')
  }
  const usedEventBytesAfter = checkedAdd(usedEventBytes, batchEventBytes, 'event bytes after admission')
  if (checkedAdd(
    usedEventBytesAfter,
    reservedCriticalBytesAfter,
    'quota commitment after admission',
  ) > hardLimitBytes) {
    quotaError('total_quota_exceeded', 'Event bytes plus recovery obligations exceed total quota')
  }

  return Object.freeze({
    usedEventBytesBefore: usedEventBytes,
    usedEventBytesAfter,
    batchEventBytes,
    regularEventBytes,
    criticalEventBytes,
    reservedCriticalSlotsBefore: reservedCriticalSlots,
    reservedCriticalSlotsAfter,
    reservedCriticalBytesAfter,
    hardLimitBytes,
  })
}
