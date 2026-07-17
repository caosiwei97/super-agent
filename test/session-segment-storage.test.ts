import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import {
  createSessionFormat,
  deterministicSessionJsonBytes,
  formatSessionSegmentFileName,
  LEGACY_JSONL_SOURCE_KIND,
  resolveSessionBundlePaths,
} from '../src/session/session-layout.js'
import {
  encodeSessionManifest,
  inspectSessionSegmentStorage,
  nodeSessionSegmentStorageIo,
  readSessionSegmentChunks,
  SessionSegmentStorage,
  SessionSegmentStorageError,
  type SessionSegmentFile,
  type SessionSegmentStorageIo,
  type SessionSegmentStoragePoint,
} from '../src/session/session-segment-storage.js'

function record(sequence: number, value = `value-${sequence}`) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    eventId: `event-${sequence}`,
    sequence,
    type: 'test.event',
    timestamp: '2026-07-17T00:00:00.000Z',
    value,
  })}\n`, 'utf8')
}

async function fixture(
  context: TestContext,
  sessionId: string,
  segmentTargetBytes: number,
) {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-segments-'))
  const format = createSessionFormat({
    sessionId,
    source: {
      kind: LEGACY_JSONL_SOURCE_KIND,
      byteLength: 0,
      sha256: createHash('sha256').digest('hex'),
    },
    limits: {
      maxRecordBytes: 1024,
      maxReadRecordBytes: 4096,
      segmentTargetBytes,
      regularQuotaBytes: 1024 * 1024,
      criticalReserveBytes: 4096,
    },
  })
  const paths = resolveSessionBundlePaths(root, sessionId, format.generation)
  await mkdir(paths.bundleRootPath, { mode: 0o700 })
  await mkdir(paths.generationPath, { mode: 0o700 })
  await writeFile(paths.formatPath, deterministicSessionJsonBytes(format), { mode: 0o600 })
  context.after(() => rm(root, { recursive: true, force: true }))
  return { root, format, paths }
}

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const parts: Buffer[] = []
  for await (const chunk of chunks) parts.push(Buffer.from(chunk))
  return Buffer.concat(parts)
}

function errorCode(code: SessionSegmentStorageError['code']) {
  return (error: unknown) => error instanceof SessionSegmentStorageError && error.code === code
}

describe('session segment storage', () => {
  it('rotates exact records in order and rebuilds its non-authoritative manifest',
    async (context) => {
      const first = record(1)
      const second = record(2, '密😀')
      const third = record(3)
      const { format, paths } = await fixture(context, 'rotation', first.length + 4)
      const storage = await SessionSegmentStorage.open({ paths, format })
      const before = storage.catalog
      const prepared = storage.prepareAppendBatch([first, second, third])
      assert.equal(storage.catalog, before, 'pure preflight must not rotate or create files')
      await storage.appendPreparedBatch(prepared, { durability: 'durable' })

      assert.deepEqual(storage.catalog.entries.map(({ ordinal, state }) => ({ ordinal, state })), [
        { ordinal: 1, state: 'sealed' },
        { ordinal: 2, state: 'sealed' },
        { ordinal: 3, state: 'active' },
      ])
      assert.equal(storage.catalog.totalEventBytes, first.length + second.length + third.length)
      assert.deepEqual(await collect(storage.readChunks()), Buffer.concat([first, second, third]))
      assert.deepEqual(await readFile(paths.manifestPath),
        encodeSessionManifest(format, storage.catalog))
      await storage.close()

      const reopened = await SessionSegmentStorage.open({ paths, format })
      assert.deepEqual(await collect(reopened.readChunks()), Buffer.concat([first, second, third]))
      await reopened.close()
      assert.equal((await stat(paths.segmentsPath)).mode & 0o777, 0o700)
      for (const name of await readdir(paths.segmentsPath)) {
        assert.equal((await stat(join(paths.segmentsPath, name))).mode & 0o777, 0o600)
      }
    })

  it('reports active EOF damage read-only and repairs it only on writer open',
    async (context) => {
      const first = record(1)
      const second = record(2)
      const fragment = Buffer.from('{"torn":"密😀"}', 'utf8')
      const { format, paths } = await fixture(context, 'active-repair', 4096)
      let storage = await SessionSegmentStorage.open({ paths, format })
      await storage.appendPreparedBatch(storage.prepareAppendBatch([first]), {
        durability: 'durable',
      })
      await storage.close()
      const activePath = join(paths.segmentsPath, formatSessionSegmentFileName(1, 'active'))
      await appendFile(activePath, fragment)

      const inspected = await inspectSessionSegmentStorage({ paths, format })
      assert.equal(inspected.diagnostics.some(({ code, repaired }) =>
        code === 'trailing_eof_fragment' && !repaired), true)
      assert.deepEqual(await readFile(activePath), Buffer.concat([first, fragment]))
      assert.deepEqual(await collect(readSessionSegmentChunks({ paths, format })), first)

      storage = await SessionSegmentStorage.open({ paths, format })
      assert.deepEqual(await readFile(activePath), first)
      await storage.appendPreparedBatch(storage.prepareAppendBatch([second]), {
        durability: 'durable',
      })
      await storage.close()
      assert.deepEqual(await readFile(activePath), Buffer.concat([first, second]))
    })

  it('treats every sealed EOF fragment and ambiguous ordinal catalog as fatal',
    async (context) => {
      const first = record(1)
      const second = record(2)
      const { format, paths } = await fixture(context, 'sealed-fatal', first.length + 1)
      const storage = await SessionSegmentStorage.open({ paths, format })
      await storage.appendPreparedBatch(storage.prepareAppendBatch([first, second]), {
        durability: 'durable',
      })
      await storage.close()
      const sealed = join(paths.segmentsPath, formatSessionSegmentFileName(1, 'sealed'))
      await appendFile(sealed, '{"torn":')
      await assert.rejects(
        inspectSessionSegmentStorage({ paths, format }),
        errorCode('sealed_eof_fragment'),
      )

      const gap = await fixture(context, 'ordinal-gap', 4096)
      const gapStorage = await SessionSegmentStorage.open({
        paths: gap.paths,
        format: gap.format,
      })
      await gapStorage.close()
      await rename(
        join(gap.paths.segmentsPath, formatSessionSegmentFileName(1, 'active')),
        join(gap.paths.segmentsPath, formatSessionSegmentFileName(2, 'active')),
      )
      await assert.rejects(
        inspectSessionSegmentStorage({ paths: gap.paths, format: gap.format }),
        errorCode('invalid_catalog'),
      )
    })

  it('treats missing/corrupt/stale manifest as a warning and writer-rebuilds it',
    async (context) => {
      const first = record(1)
      const { format, paths } = await fixture(context, 'manifest-cache', 4096)
      let storage = await SessionSegmentStorage.open({ paths, format })
      await storage.appendPreparedBatch(storage.prepareAppendBatch([first]), {
        durability: 'durable',
      })
      await storage.close()

      await unlink(paths.manifestPath)
      assert.equal((await inspectSessionSegmentStorage({ paths, format })).diagnostics
        .some(({ code }) => code === 'manifest_missing'), true)
      storage = await SessionSegmentStorage.open({ paths, format })
      await storage.close()

      await writeFile(paths.manifestPath, '{broken}\n', { mode: 0o600 })
      assert.equal((await inspectSessionSegmentStorage({ paths, format })).diagnostics
        .some(({ code }) => code === 'manifest_corrupt'), true)
      storage = await SessionSegmentStorage.open({ paths, format })
      await storage.close()

      const stale = Buffer.from('{"generation":"stale","layoutVersion":1,"segments":[],"totalEventBytes":0}\n')
      await writeFile(paths.manifestPath, stale, { mode: 0o600 })
      assert.equal((await inspectSessionSegmentStorage({ paths, format })).diagnostics
        .some(({ code }) => code === 'manifest_stale'), true)
      storage = await SessionSegmentStorage.open({ paths, format })
      assert.deepEqual(await readFile(paths.manifestPath),
        encodeSessionManifest(format, storage.catalog))
      await storage.close()

      await chmod(paths.manifestPath, 0o644)
      await assert.rejects(
        inspectSessionSegmentStorage({ paths, format }),
        errorCode('unsafe_metadata'),
      )

      await chmod(paths.manifestPath, 0o600)
      storage = await SessionSegmentStorage.open({ paths, format })
      await chmod(paths.manifestPath, 0o644)
      await assert.rejects(
        storage.appendPreparedBatch(storage.prepareAppendBatch([record(2)]), {
          durability: 'durable',
        }),
        errorCode('unsafe_metadata'),
      )
      const activePath = join(
        paths.segmentsPath,
        formatSessionSegmentFileName(1, 'active'),
      )
      assert.deepEqual(await readFile(activePath), first)
      await storage.close().catch(() => undefined)
    })

  it('keeps fd/stat/read and short-write behavior in injected wrappers', async (context) => {
    const first = record(1, 'descriptor-boundary')
    const { format, paths } = await fixture(context, 'real-descriptors', 4096)
    const observed = { fd: new Set<number>(), stat: 0, read: 0, write: 0 }
    const io: SessionSegmentStorageIo = {
      ...nodeSessionSegmentStorageIo,
      open: async (path, flags, mode) => {
        const handle = await nodeSessionSegmentStorageIo.open(path, flags, mode)
        observed.fd.add(handle.fd)
        const wrapped: SessionSegmentFile = {
          fd: handle.fd,
          chmod: (value) => handle.chmod(value),
          stat: () => {
            observed.stat++
            return handle.stat()
          },
          read: async (buffer, offset, length, position) => {
            observed.read++
            const result = await handle.read(buffer, offset, Math.min(length, 11), position)
            return { bytesRead: result.bytesRead }
          },
          write: (buffer, offset, length) => {
            observed.write++
            return handle.write(buffer, offset, Math.min(length, 7))
          },
          truncate: (length) => handle.truncate(length),
          datasync: () => handle.datasync(),
          close: () => handle.close(),
        }
        return wrapped
      },
    }
    const storage = await SessionSegmentStorage.open({ paths, format, io })
    await storage.appendPreparedBatch(storage.prepareAppendBatch([first]), {
      durability: 'durable',
    })
    assert.deepEqual(await collect(storage.readChunks()), first)
    await storage.close()
    assert.ok(observed.fd.size > 0)
    assert.ok(observed.stat > 0)
    assert.ok(observed.read > 1)
    assert.ok(observed.write > 1)
  })
})

const ROTATION_CRASH_POINTS: readonly SessionSegmentStoragePoint[] = [
  'active_synced',
  'active_renamed',
  'sealed_directory_synced',
  'next_active_created',
  'next_active_synced',
]

describe('session segment rotation fault-injection boundaries', () => {
  for (const crashPoint of ROTATION_CRASH_POINTS) {
    it(`recovers after ${crashPoint}`, async (context) => {
      const first = record(1)
      const second = record(2)
      const fixtureValue = await fixture(
        context,
        `rotation-crash-${ROTATION_CRASH_POINTS.indexOf(crashPoint)}`,
        first.length + 1,
      )
      let armed = false
      const storage = await SessionSegmentStorage.open({
        paths: fixtureValue.paths,
        format: fixtureValue.format,
        probe(point) {
          if (armed && point === crashPoint) throw new Error(`injected ${crashPoint}`)
        },
      })
      await storage.appendPreparedBatch(storage.prepareAppendBatch([first]), {
        durability: 'durable',
      })
      armed = true
      await assert.rejects(
        storage.appendPreparedBatch(storage.prepareAppendBatch([second]), {
          durability: 'durable',
        }),
        new RegExp(`injected ${crashPoint}`),
      )
      await storage.close().catch(() => undefined)

      const recovered = await SessionSegmentStorage.open({
        paths: fixtureValue.paths,
        format: fixtureValue.format,
      })
      assert.deepEqual(await collect(recovered.readChunks()), first)
      await recovered.appendPreparedBatch(recovered.prepareAppendBatch([second]), {
        durability: 'durable',
      })
      assert.deepEqual(await collect(recovered.readChunks()), Buffer.concat([first, second]))
      await recovered.close()
    })
  }

  it('keeps durable event acknowledgement independent from manifest cache publication',
    async (context) => {
      const first = record(1)
      const second = record(2)
      const third = record(3)
      const fixtureValue = await fixture(context, 'manifest-publish-crash', 4096)
      let armed = false
      let warnings = 0
      const storage = await SessionSegmentStorage.open({
        paths: fixtureValue.paths,
        format: fixtureValue.format,
        onManifestCacheWarning() {
          warnings++
        },
        probe(point) {
          if (armed && point === 'manifest_published') {
            armed = false
            throw new Error('injected manifest_published')
          }
        },
      })
      await storage.appendPreparedBatch(storage.prepareAppendBatch([first]), {
        durability: 'durable',
      })
      armed = true
      await storage.appendPreparedBatch(storage.prepareAppendBatch([second]), {
        durability: 'durable',
      })
      assert.equal(warnings, 1)
      await storage.appendPreparedBatch(storage.prepareAppendBatch([third]), {
        durability: 'durable',
      })
      assert.deepEqual(
        await collect(storage.readChunks()),
        Buffer.concat([first, second, third]),
      )
      await storage.close()

      const recovered = await SessionSegmentStorage.open({
        paths: fixtureValue.paths,
        format: fixtureValue.format,
      })
      assert.deepEqual(
        await collect(recovered.readChunks()),
        Buffer.concat([first, second, third]),
      )
      await recovered.close()
    })

  it('unlinks its exact manifest temp after each pre-rename cache failure',
    async (context) => {
      const fixtureValue = await fixture(context, 'manifest-temp-cleanup', 4096)
      let warnings = 0
      const io: SessionSegmentStorageIo = {
        ...nodeSessionSegmentStorageIo,
        async rename(from, to) {
          if (to === fixtureValue.paths.manifestPath) {
            const error = new Error('injected manifest rename EIO') as NodeJS.ErrnoException
            error.code = 'EIO'
            throw error
          }
          await nodeSessionSegmentStorageIo.rename(from, to)
        },
      }
      const storage = await SessionSegmentStorage.open({
        paths: fixtureValue.paths,
        format: fixtureValue.format,
        io,
        onManifestCacheWarning() {
          warnings++
        },
      })
      const expected: Buffer[] = []
      for (let sequence = 1; sequence <= 3; sequence++) {
        const value = record(sequence)
        expected.push(value)
        await storage.appendPreparedBatch(storage.prepareAppendBatch([value]), {
          durability: 'durable',
        })
      }
      assert.equal(warnings, 4)
      assert.equal((await readdir(fixtureValue.paths.generationPath))
        .some((name) => /^\.manifest\..+\.tmp$/.test(name)), false)
      await assert.rejects(readFile(fixtureValue.paths.manifestPath), { code: 'ENOENT' })
      assert.deepEqual(await collect(storage.readChunks()), Buffer.concat(expected))
      await storage.close()
    })

  it('fails an append acknowledgement when the pinned generation path is moved',
    async (context) => {
      const fixtureValue = await fixture(context, 'generation-pin', 4096)
      let armed = false
      const movedPath = `${fixtureValue.paths.generationPath}.moved`
      const storage = await SessionSegmentStorage.open({
        paths: fixtureValue.paths,
        format: fixtureValue.format,
        async probe(point) {
          if (armed && point === 'manifest_published') {
            armed = false
            await rename(fixtureValue.paths.generationPath, movedPath)
          }
        },
      })
      await storage.appendPreparedBatch(storage.prepareAppendBatch([record(1)]), {
        durability: 'durable',
      })
      armed = true
      await assert.rejects(
        storage.appendPreparedBatch(storage.prepareAppendBatch([record(2)]), {
          durability: 'durable',
        }),
        errorCode('unsafe_metadata'),
      )
      await storage.close().catch(() => undefined)
      await rename(movedPath, fixtureValue.paths.generationPath)
      const recovered = await SessionSegmentStorage.open({
        paths: fixtureValue.paths,
        format: fixtureValue.format,
      })
      assert.deepEqual(await collect(recovered.readChunks()), Buffer.concat([record(1), record(2)]))
      await recovered.close()
    })
})
