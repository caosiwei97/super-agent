const CURRENT_SCHEMA_VERSION = 2 as const

/** New journal records are bounded before their terminating newline is accepted. */
export const DEFAULT_MAX_JOURNAL_RECORD_BYTES = 1024 * 1024

export type SessionJournalScanErrorCode =
  | 'invalid_max_record_bytes'
  | 'invalid_chunk'
  | 'record_too_large'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'record_not_object'
  | 'unsupported_schema'
  | 'v1_after_v2'
  | 'invalid_type'
  | 'invalid_timestamp'
  | 'invalid_event_id'
  | 'duplicate_event_id'
  | 'invalid_sequence'
  | 'invalid_materialization_id'
  | 'duplicate_materialization_id'

export interface SessionJournalRecordLocation {
  /** One-based physical line number. */
  readonly line: number
  /** Zero-based byte offset of the line. */
  readonly byteOffset: number
  /** UTF-8 bytes occupied by the complete line, including its newline. */
  readonly byteLength: number
}

export type SessionJournalDiagnosticCode = 'trailing_eof_fragment'

export interface SessionJournalDiagnostic extends SessionJournalRecordLocation {
  readonly code: SessionJournalDiagnosticCode
  readonly severity: 'warning'
  readonly repaired: false
  readonly message: string
}

export class SessionJournalScanError extends Error {
  constructor(
    readonly code: SessionJournalScanErrorCode,
    message: string,
    readonly location?: SessionJournalRecordLocation,
  ) {
    super(message)
    this.name = 'SessionJournalScanError'
  }
}

export type SessionJournalRecordHandler = (
  record: Record<string, unknown>,
  location: SessionJournalRecordLocation,
) => void | Promise<void>

export interface SessionJournalScanOptions {
  readonly maxRecordBytes?: number
  readonly onRecord?: SessionJournalRecordHandler
}

export interface SessionJournalScanResult {
  /** Total bytes consumed from the input, including an ignored EOF fragment. */
  readonly byteLength: number
  /** Safe truncation boundary immediately after the last complete newline. */
  readonly validLength: number
  readonly lineCount: number
  readonly recordCount: number
  readonly v1RecordCount: number
  readonly v2RecordCount: number
  readonly nextSequence: number
  readonly eventIds: ReadonlySet<string>
  readonly materializationIds: ReadonlySet<string>
  readonly diagnostics: readonly SessionJournalDiagnostic[]
}

function scanError(
  code: SessionJournalScanErrorCode,
  location?: SessionJournalRecordLocation,
) {
  const suffix = location
    ? ` at line ${location.line}, byte ${location.byteOffset}`
    : ''
  return new SessionJournalScanError(code, `Session journal validation failed: ${code}${suffix}`, location)
}

function assertNonEmptyString(
  value: unknown,
  code: 'invalid_type' | 'invalid_timestamp' | 'invalid_event_id' |
    'invalid_materialization_id',
  location: SessionJournalRecordLocation,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw scanError(code, location)
}

function parseRecord(
  bytes: Uint8Array,
  decoder: TextDecoder,
  location: SessionJournalRecordLocation,
) {
  const content = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d
    ? bytes.subarray(0, bytes.length - 1)
    : bytes
  let raw: string
  try {
    raw = decoder.decode(content)
  } catch {
    throw scanError('invalid_utf8', location)
  }
  if (raw.trim().length === 0) return undefined

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // JSON parser messages are deliberately discarded because runtimes may quote input.
    throw scanError('invalid_json', location)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw scanError('record_not_object', location)
  }
  return value as Record<string, unknown>
}

/**
 * Incrementally validates a session JSONL stream without retaining record bodies.
 * Only an unterminated EOF fragment is recoverable; every complete invalid line is fatal.
 */
export async function scanSessionJournal(
  input: AsyncIterable<Uint8Array>,
  options: SessionJournalScanOptions = {},
): Promise<SessionJournalScanResult> {
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_JOURNAL_RECORD_BYTES
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw scanError('invalid_max_record_bytes')
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const eventIds = new Set<string>()
  const materializationIds = new Set<string>()
  const diagnostics: SessionJournalDiagnostic[] = []
  let pendingParts: Buffer[] = []
  let pendingLength = 0
  let pendingOffset = 0
  let byteLength = 0
  let validLength = 0
  let lineCount = 0
  let recordCount = 0
  let v1RecordCount = 0
  let v2RecordCount = 0
  let nextSequence = 1
  let sawV2 = false

  const addPending = (part: Buffer, byteOffset: number) => {
    if (part.length === 0) return
    if (pendingLength === 0) pendingOffset = byteOffset
    pendingLength += part.length
    if (pendingLength > maxRecordBytes) {
      throw scanError('record_too_large', Object.freeze({
        line: lineCount + 1,
        byteOffset: pendingOffset,
        byteLength: pendingLength,
      }))
    }
    pendingParts.push(Buffer.from(part))
    // Bound bookkeeping for adversarial streams that yield one byte at a time.
    if (pendingParts.length >= 64) {
      pendingParts = [Buffer.concat(pendingParts, pendingLength)]
    }
  }

  const acceptLine = async (prefix: Buffer, byteOffset: number) => {
    const lineOffset = pendingLength === 0 ? byteOffset : pendingOffset
    const contentLength = pendingLength + prefix.length
    const completeLength = contentLength + 1
    const location: SessionJournalRecordLocation = Object.freeze({
      line: ++lineCount,
      byteOffset: lineOffset,
      byteLength: completeLength,
    })
    if (completeLength > maxRecordBytes) throw scanError('record_too_large', location)

    const content = pendingLength === 0
      ? prefix
      : Buffer.concat([...pendingParts, prefix], contentLength)
    pendingParts = []
    pendingLength = 0
    validLength = lineOffset + completeLength

    const record = parseRecord(content, decoder, location)
    if (!record) return

    const isV1 = record.schemaVersion === undefined
    if (isV1) {
      if (sawV2) throw scanError('v1_after_v2', location)
    } else if (record.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw scanError('unsupported_schema', location)
    }

    assertNonEmptyString(record.type, 'invalid_type', location)
    assertNonEmptyString(record.timestamp, 'invalid_timestamp', location)

    if (!isV1) {
      sawV2 = true
      assertNonEmptyString(record.eventId, 'invalid_event_id', location)
      if (eventIds.has(record.eventId)) throw scanError('duplicate_event_id', location)
      if (!Number.isSafeInteger(record.sequence) || record.sequence !== nextSequence) {
        throw scanError('invalid_sequence', location)
      }
      eventIds.add(record.eventId)
      nextSequence++
      v2RecordCount++
    } else {
      v1RecordCount++
    }

    if (record.materializationId !== undefined) {
      assertNonEmptyString(
        record.materializationId,
        'invalid_materialization_id',
        location,
      )
      if (materializationIds.has(record.materializationId)) {
        throw scanError('duplicate_materialization_id', location)
      }
      materializationIds.add(record.materializationId)
    }

    recordCount++
    await options.onRecord?.(record, location)
  }

  for await (const value of input) {
    if (!(value instanceof Uint8Array)) throw scanError('invalid_chunk')
    const chunk = Buffer.from(value)
    const chunkOffset = byteLength
    byteLength += chunk.length
    let cursor = 0

    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor)
      if (newline === -1) {
        addPending(chunk.subarray(cursor), chunkOffset + cursor)
        break
      }
      await acceptLine(chunk.subarray(cursor, newline), chunkOffset + cursor)
      cursor = newline + 1
    }
  }

  if (pendingLength > 0) {
    diagnostics.push(Object.freeze({
      code: 'trailing_eof_fragment',
      severity: 'warning',
      repaired: false,
      line: lineCount + 1,
      byteOffset: pendingOffset,
      byteLength: pendingLength,
      message: 'Ignored an unterminated session journal record at EOF',
    }))
  }

  return Object.freeze({
    byteLength,
    validLength,
    lineCount,
    recordCount,
    v1RecordCount,
    v2RecordCount,
    nextSequence,
    eventIds: new Set(eventIds),
    materializationIds: new Set(materializationIds),
    diagnostics: Object.freeze(diagnostics),
  })
}
