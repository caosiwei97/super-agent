import { createHash } from 'node:crypto'

export type SessionRecordStreamErrorCode =
  | 'invalid_max_record_bytes'
  | 'invalid_chunk'
  | 'record_too_large'

export interface SessionRawRecordLocation {
  /** One-based physical record number. Blank lines count as records. */
  readonly line: number
  /** Zero-based offset in the source byte stream. */
  readonly byteOffset: number
  /** Exact source bytes. Complete records include their terminating LF. */
  readonly byteLength: number
}

export class SessionRecordStreamError extends Error {
  constructor(
    readonly code: SessionRecordStreamErrorCode,
    message: string,
    readonly location?: SessionRawRecordLocation,
  ) {
    super(message)
    this.name = 'SessionRecordStreamError'
  }
}

export interface SessionCompleteRawRecord extends SessionRawRecordLocation {
  readonly kind: 'record'
  /** Exact source bytes, including LF and any preceding CR. */
  readonly bytes: Uint8Array
}

export interface SessionRawEofFragment extends SessionRawRecordLocation {
  readonly kind: 'eof-fragment'
  /** Exact unterminated source bytes. The stream never parses or repairs them. */
  readonly bytes: Uint8Array
}

export type SessionRawRecordStreamItem = SessionCompleteRawRecord | SessionRawEofFragment

export interface SessionRecordStreamOptions {
  /** Maximum bytes per record, including LF when present. */
  readonly maxRecordBytes: number
}

export interface SessionRecordFingerprint {
  readonly byteLength: number
  readonly sha256: string
}

export interface SessionRecordFingerprintAccumulator {
  readonly byteLength: number
  update(bytes: Uint8Array): void
  digest(): SessionRecordFingerprint
}

function streamError(
  code: SessionRecordStreamErrorCode,
  location?: SessionRawRecordLocation,
) {
  const suffix = location
    ? ` at line ${location.line}, byte ${location.byteOffset}`
    : ''
  return new SessionRecordStreamError(
    code,
    `Session record stream validation failed: ${code}${suffix}`,
    location,
  )
}

function checkedTotal(current: number, added: number) {
  const total = current + added
  if (!Number.isSafeInteger(total)) {
    throw new Error('Session record stream byteLength exceeds Number.MAX_SAFE_INTEGER')
  }
  return total
}

/**
 * Split a raw JSONL byte stream without decoding or parsing it.
 *
 * Complete records retain their exact bytes, including LF, CRLF, blank lines,
 * invalid UTF-8, and original JSON formatting. An unterminated final fragment is
 * emitted once as a distinct item and is never interpreted or repaired.
 */
export async function* streamSessionRecordBytes(
  input: AsyncIterable<Uint8Array>,
  options: SessionRecordStreamOptions,
): AsyncGenerator<SessionRawRecordStreamItem> {
  const { maxRecordBytes } = options
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw streamError('invalid_max_record_bytes')
  }

  let pendingParts: Buffer[] = []
  let pendingLength = 0
  let pendingOffset = 0
  let sourceLength = 0
  let line = 1

  const addPending = (part: Buffer, byteOffset: number) => {
    if (part.length === 0) return
    if (pendingLength === 0) pendingOffset = byteOffset
    const nextLength = checkedTotal(pendingLength, part.length)
    if (nextLength > maxRecordBytes) {
      throw streamError('record_too_large', Object.freeze({
        line,
        byteOffset: pendingOffset,
        byteLength: nextLength,
      }))
    }
    pendingParts.push(Buffer.from(part))
    pendingLength = nextLength
    // Bound per-record bookkeeping for adversarial one-byte input chunks.
    if (pendingParts.length >= 64) {
      pendingParts = [Buffer.concat(pendingParts, pendingLength)]
    }
  }

  for await (const value of input) {
    if (!(value instanceof Uint8Array)) throw streamError('invalid_chunk')
    const chunk = Buffer.from(value)
    const chunkOffset = sourceLength
    sourceLength = checkedTotal(sourceLength, chunk.length)
    let cursor = 0

    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor)
      if (newline === -1) {
        addPending(chunk.subarray(cursor), chunkOffset + cursor)
        break
      }

      const suffix = chunk.subarray(cursor, newline + 1)
      const recordOffset = pendingLength === 0 ? chunkOffset + cursor : pendingOffset
      const recordLength = checkedTotal(pendingLength, suffix.length)
      const location = Object.freeze({
        line,
        byteOffset: recordOffset,
        byteLength: recordLength,
      })
      if (recordLength > maxRecordBytes) throw streamError('record_too_large', location)

      const bytes = pendingLength === 0
        ? Buffer.from(suffix)
        : Buffer.concat([...pendingParts, suffix], recordLength)
      pendingParts = []
      pendingLength = 0
      yield Object.freeze({ kind: 'record' as const, bytes, ...location })
      line++
      cursor = newline + 1
    }
  }

  if (pendingLength > 0) {
    const bytes = Buffer.concat(pendingParts, pendingLength)
    yield Object.freeze({
      kind: 'eof-fragment' as const,
      bytes,
      line,
      byteOffset: pendingOffset,
      byteLength: pendingLength,
    })
  }
}

/** Incrementally fingerprint exact record bytes without retaining prior input. */
export function createSessionRecordFingerprint(): SessionRecordFingerprintAccumulator {
  const hash = createHash('sha256')
  let byteLength = 0
  let completed: SessionRecordFingerprint | undefined

  return {
    get byteLength() {
      return byteLength
    },
    update(bytes) {
      if (completed) throw new Error('Session record fingerprint is already finalized')
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('Session record fingerprint input must be Uint8Array')
      }
      byteLength = checkedTotal(byteLength, bytes.length)
      hash.update(bytes)
    },
    digest() {
      completed ||= Object.freeze({
        byteLength,
        sha256: hash.digest('hex'),
      })
      return completed
    },
  }
}
