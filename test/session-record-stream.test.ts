import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  createSessionRecordFingerprint,
  SessionRecordStreamError,
  streamSessionRecordBytes,
  type SessionRawRecordStreamItem,
} from '../src/session/session-record-stream.js'

async function* chunks(bytes: Uint8Array, cuts: readonly number[] = []) {
  let start = 0
  for (const end of cuts) {
    yield bytes.subarray(start, end)
    start = end
  }
  yield bytes.subarray(start)
}

async function collect(
  bytes: Uint8Array,
  maxRecordBytes: number,
  cuts: readonly number[] = [],
) {
  const values: SessionRawRecordStreamItem[] = []
  for await (const value of streamSessionRecordBytes(chunks(bytes, cuts), { maxRecordBytes })) {
    values.push(value)
  }
  return values
}

describe('raw session record stream', () => {
  it('preserves LF, CRLF, blank lines, and multibyte bytes across arbitrary chunks', async () => {
    const first = Buffer.from('{"text":"密😀"}\r\n', 'utf-8')
    const blank = Buffer.from('\n')
    const third = Buffer.from('{ "spaced": true }\n', 'utf-8')
    const input = Buffer.concat([first, blank, third])
    const multibyte = input.indexOf(Buffer.from('密', 'utf-8'))
    const records = await collect(input, 1024, [
      0,
      1,
      multibyte + 1,
      multibyte + 2,
      first.length - 1,
      first.length,
      first.length + 1,
      input.length - 1,
    ])

    assert.deepEqual(records.map(({ kind }) => kind), ['record', 'record', 'record'])
    assert.deepEqual(records.map(({ line, byteOffset, byteLength }) => ({
      line,
      byteOffset,
      byteLength,
    })), [
      { line: 1, byteOffset: 0, byteLength: first.length },
      { line: 2, byteOffset: first.length, byteLength: blank.length },
      { line: 3, byteOffset: first.length + blank.length, byteLength: third.length },
    ])
    assert.deepEqual(records.map(({ bytes }) => Buffer.from(bytes)), [first, blank, third])
    assert.deepEqual(Buffer.concat(records.map(({ bytes }) => Buffer.from(bytes))), input)
  })

  it('treats bytes as opaque and never parses JSON or UTF-8', async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x0a])
    const malformedJson = Buffer.from('{not-json}\n')
    const records = await collect(Buffer.concat([invalidUtf8, malformedJson]), 64, [1, 2, 4])

    assert.deepEqual(records.map(({ bytes }) => Buffer.from(bytes)), [invalidUtf8, malformedJson])
  })

  it('enforces the exact per-record byte limit on records and fragments', async () => {
    assert.deepEqual(
      (await collect(Buffer.from('abc\n'), 4)).map(({ byteLength }) => byteLength),
      [4],
    )
    assert.deepEqual(
      (await collect(Buffer.from('abcd'), 4)).map(({ kind, byteLength }) => ({
        kind,
        byteLength,
      })),
      [{ kind: 'eof-fragment', byteLength: 4 }],
    )

    await assert.rejects(
      collect(Buffer.from('abcd\n'), 4, [2, 4]),
      (error: unknown) => {
        assert.ok(error instanceof SessionRecordStreamError)
        assert.equal(error.code, 'record_too_large')
        assert.deepEqual(error.location, { line: 1, byteOffset: 0, byteLength: 5 })
        return true
      },
    )
    await assert.rejects(
      collect(Buffer.from('abcde'), 4, [1, 2, 3, 4]),
      (error: unknown) => error instanceof SessionRecordStreamError &&
        error.code === 'record_too_large',
    )
    await assert.rejects(
      async () => {
        for await (const _value of streamSessionRecordBytes(chunks(Buffer.alloc(0)), {
          maxRecordBytes: 0,
        })) {
          // The options check runs before the first item.
        }
      },
      (error: unknown) => error instanceof SessionRecordStreamError &&
        error.code === 'invalid_max_record_bytes',
    )
  })

  it('emits nothing for an empty stream and fingerprints zero bytes', async () => {
    assert.deepEqual(await collect(Buffer.alloc(0), 16, [0]), [])

    const fingerprint = createSessionRecordFingerprint()
    const expected = createHash('sha256').digest('hex')
    assert.deepEqual(fingerprint.digest(), { byteLength: 0, sha256: expected })
    assert.equal(fingerprint.digest(), fingerprint.digest(), 'digest must be idempotent')
  })

  it('reports one exact EOF fragment separately and fingerprints only chosen records', async () => {
    const complete = Buffer.from('{"id":1}\r\n\n', 'utf-8')
    const fragment = Buffer.from('{"tail":"密😀"}', 'utf-8')
    const input = Buffer.concat([complete, fragment])
    const splitInsideEmoji = complete.length + fragment.indexOf(Buffer.from('😀', 'utf-8')) + 1
    const values = await collect(input, 128, [1, complete.length - 1, complete.length, splitInsideEmoji])

    assert.deepEqual(values.map(({ kind }) => kind), ['record', 'record', 'eof-fragment'])
    const trailing = values.at(-1)!
    assert.equal(trailing.kind, 'eof-fragment')
    assert.deepEqual(Buffer.from(trailing.bytes), fragment)
    assert.deepEqual({
      line: trailing.line,
      byteOffset: trailing.byteOffset,
      byteLength: trailing.byteLength,
    }, {
      line: 3,
      byteOffset: complete.length,
      byteLength: fragment.length,
    })

    const fingerprint = createSessionRecordFingerprint()
    for (const value of values) {
      if (value.kind === 'record') fingerprint.update(value.bytes)
    }
    assert.equal(fingerprint.byteLength, complete.length)
    const result = fingerprint.digest()
    assert.deepEqual(result, {
      byteLength: complete.length,
      sha256: createHash('sha256').update(complete).digest('hex'),
    })
    assert.equal(fingerprint.digest(), result)
    assert.throws(
      () => fingerprint.update(Buffer.from('late')),
      /already finalized/,
    )
  })
})
