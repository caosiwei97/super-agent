import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SessionJournalScanError,
  scanSessionJournal,
  type SessionJournalScanErrorCode,
} from '../src/session/journal-scanner.js'

async function* byteChunks(bytes: Uint8Array, cuts: readonly number[] = []) {
  let start = 0
  for (const end of cuts) {
    yield bytes.subarray(start, end)
    start = end
  }
  yield bytes.subarray(start)
}

function jsonl(...records: readonly unknown[]) {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8')
}

async function expectScanError(
  bytes: Uint8Array,
  code: SessionJournalScanErrorCode,
) {
  await assert.rejects(
    scanSessionJournal(byteChunks(bytes)),
    (error: unknown) => {
      assert.ok(error instanceof SessionJournalScanError)
      assert.equal(error.code, code)
      return true
    },
  )
}

describe('session journal scanner', () => {
  it('streams across chunk, newline, CRLF, and multibyte boundaries', async () => {
    const first = JSON.stringify({ type: 'message', timestamp: 't1', text: '密钥' }) + '\r\n'
    const second = JSON.stringify({
      schemaVersion: 2,
      eventId: 'event-1',
      sequence: 1,
      type: 'messages',
      timestamp: 't2',
      materializationId: 'materialization-1',
    }) + '\n'
    const bytes = Buffer.from(first + second, 'utf-8')
    const multibyte = bytes.indexOf(Buffer.from('密', 'utf-8'))
    const firstLength = Buffer.byteLength(first, 'utf-8')
    const seen: Array<{ record: Record<string, unknown>; line: number; offset: number; length: number }> = []

    const result = await scanSessionJournal(
      byteChunks(bytes, [1, multibyte + 1, multibyte + 2, firstLength - 1, firstLength, bytes.length - 1]),
      {
        onRecord: async (record, location) => {
          await Promise.resolve()
          seen.push({
            record,
            line: location.line,
            offset: location.byteOffset,
            length: location.byteLength,
          })
        },
      },
    )

    assert.equal(seen[0]?.record.text, '密钥')
    assert.deepEqual(seen.map(({ line, offset, length }) => ({ line, offset, length })), [
      { line: 1, offset: 0, length: firstLength },
      { line: 2, offset: firstLength, length: Buffer.byteLength(second, 'utf-8') },
    ])
    assert.equal(result.byteLength, bytes.length)
    assert.equal(result.validLength, bytes.length)
    assert.equal(result.lineCount, 2)
    assert.equal(result.recordCount, 2)
    assert.equal(result.v1RecordCount, 1)
    assert.equal(result.v2RecordCount, 1)
    assert.equal(result.nextSequence, 2)
    assert.deepEqual([...result.eventIds], ['event-1'])
    assert.deepEqual([...result.materializationIds], ['materialization-1'])
    assert.deepEqual(result.diagnostics, [])
  })

  it('enforces schema and globally unique ordered v2 metadata', async () => {
    const v2 = (eventId: string, sequence: number, materializationId?: string) => ({
      schemaVersion: 2,
      eventId,
      sequence,
      type: 'test.event',
      timestamp: 't',
      ...(materializationId === undefined ? {} : { materializationId }),
    })
    const cases: Array<[Uint8Array, SessionJournalScanErrorCode]> = [
      [jsonl({ schemaVersion: 3, type: 'x', timestamp: 't' }), 'unsupported_schema'],
      [jsonl(v2('event-1', 1), { type: 'message', timestamp: 't' }), 'v1_after_v2'],
      [jsonl({ timestamp: 't' }), 'invalid_type'],
      [jsonl({ type: 'message' }), 'invalid_timestamp'],
      [jsonl({ ...v2('event-1', 1), eventId: '' }), 'invalid_event_id'],
      [jsonl(v2('same-event', 1), v2('same-event', 2)), 'duplicate_event_id'],
      [jsonl(v2('event-2', 2)), 'invalid_sequence'],
      [jsonl(v2('event-1', 1, '')), 'invalid_materialization_id'],
      [
        jsonl(v2('event-1', 1, 'same-materialization'), v2('event-2', 2, 'same-materialization')),
        'duplicate_materialization_id',
      ],
    ]

    for (const [bytes, code] of cases) await expectScanError(bytes, code)
  })

  it('rejects invalid UTF-8, JSON, and non-object records', async () => {
    await expectScanError(Uint8Array.from([0xff, 0x0a]), 'invalid_utf8')
    await expectScanError(Buffer.from('{not-json}\n', 'utf-8'), 'invalid_json')
    await expectScanError(Buffer.from('[]\n', 'utf-8'), 'record_not_object')
  })

  it('measures the exact record limit in UTF-8 bytes including newline', async () => {
    const base = JSON.stringify({ type: 'message', timestamp: 't', padding: '' })
    const paddingLength = 7
    const exact = Buffer.from(
      JSON.stringify({ type: 'message', timestamp: 't', padding: '界'.repeat(paddingLength) }) + '\n',
      'utf-8',
    )
    const expectedLength = Buffer.byteLength(base, 'utf-8') + paddingLength * 3 + 1
    assert.equal(exact.length, expectedLength)

    const result = await scanSessionJournal(byteChunks(exact), { maxRecordBytes: exact.length })
    assert.equal(result.recordCount, 1)

    const over = Buffer.from(
      JSON.stringify({ type: 'message', timestamp: 't', padding: `${'界'.repeat(paddingLength)}x` }) + '\n',
      'utf-8',
    )
    await assert.rejects(
      scanSessionJournal(byteChunks(over), { maxRecordBytes: exact.length }),
      (error: unknown) => error instanceof SessionJournalScanError && error.code === 'record_too_large',
    )
  })

  it('reports but never parses an unterminated EOF fragment', async () => {
    const complete = jsonl({ type: 'message', timestamp: 't' })
    const fragment = Buffer.from('{"secret":"tail-secret"', 'utf-8')
    const bytes = Buffer.concat([complete, fragment])
    const seen: Record<string, unknown>[] = []

    const result = await scanSessionJournal(byteChunks(bytes, [complete.length + 3]), {
      onRecord: (record) => { seen.push(record) },
    })

    assert.equal(seen.length, 1)
    assert.equal(result.validLength, complete.length)
    assert.equal(result.byteLength, bytes.length)
    assert.deepEqual(result.diagnostics.map(({ code, line, byteOffset, byteLength }) => ({
      code,
      line,
      byteOffset,
      byteLength,
    })), [{
      code: 'trailing_eof_fragment',
      line: 2,
      byteOffset: complete.length,
      byteLength: fragment.length,
    }])
    assert.doesNotMatch(result.diagnostics[0]!.message, /tail-secret/)
  })

  it('never includes journal contents in fatal errors or diagnostics', async () => {
    const secret = 'sk-super-secret-value'
    const malformed = Buffer.from(`{"type":"message","timestamp":"t","value":"${secret}" BROKEN}\n`)
    let caught: unknown
    try {
      await scanSessionJournal(byteChunks(malformed))
    } catch (error) {
      caught = error
    }

    assert.ok(caught instanceof SessionJournalScanError)
    const exposed = [
      caught.message,
      caught.stack,
      JSON.stringify({ code: caught.code, location: caught.location }),
    ].join('\n')
    assert.doesNotMatch(exposed, new RegExp(secret))

    const fragment = Buffer.from(`{"value":"${secret}"`)
    const result = await scanSessionJournal(byteChunks(fragment))
    assert.doesNotMatch(JSON.stringify(result.diagnostics), new RegExp(secret))
  })
})
