import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, constants, openSync } from 'node:fs'
import {
  appendFile,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import {
  encodeSessionFence,
  formatSessionSegmentFileName,
  LEGACY_JSONL_SOURCE_KIND,
  parseSessionFence,
  type SessionStorageLimits,
} from '../src/session/session-layout.js'
import {
  migrateLegacySession,
  type SessionMigrationPoint,
  type VerifyPreparedSessionBundle,
} from '../src/session/session-migration.js'
import {
  nodeSessionJournalIo,
  SessionFileLease,
  type SessionJournalFile,
  type SessionJournalIo,
} from '../src/session/session-file-lease.js'

const TEST_LIMITS = Object.freeze({
  maxRecordBytes: 1024,
  maxReadRecordBytes: 4096,
  segmentTargetBytes: 180,
  regularQuotaBytes: 1024 * 1024,
  criticalReserveBytes: 4096,
})

function event(sequence: number, value = `value-${sequence}`) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    eventId: `event-${sequence}`,
    sequence,
    type: 'test.event',
    timestamp: '2026-07-17T00:00:00.000Z',
    value,
  })}\n`, 'utf8')
}

async function createLegacy(
  context: TestContext,
  sessionId: string,
  bytes = event(1),
) {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-migration-'))
  const directory = join(root, 'sessions')
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, `${sessionId}.lock`), '', { mode: 0o600 })
  await writeFile(join(directory, `${sessionId}.jsonl`), bytes, { mode: 0o600 })
  context.after(() => rm(root, { recursive: true, force: true }))
  return { root, directory, journal: join(directory, `${sessionId}.jsonl`) }
}

const typedQuotaGate: VerifyPreparedSessionBundle = async ({ scan, format, readChunks }) => {
  assert.equal(scan.diagnostics.length, 0)
  assert.ok(scan.byteLength <=
    format.limits.regularQuotaBytes + format.limits.criticalReserveBytes)
  let exactBytes = 0
  for await (const chunk of readChunks()) exactBytes += chunk.length
  assert.equal(exactBytes, scan.byteLength)
}

function descriptorPreservingIo(observed: { stat: number; read: number }): SessionJournalIo {
  return {
    readFile: (path) => nodeSessionJournalIo.readFile(path),
    open: async (path, flags, mode) => {
      const handle = await nodeSessionJournalIo.open(path, flags, mode)
      const wrapped: SessionJournalFile = {
        fd: handle.fd,
        chmod: (fileMode) => handle.chmod(fileMode),
        truncate: (length) => handle.truncate(length),
        write: (buffer, offset, length) => handle.write(buffer, offset, length),
        datasync: () => handle.datasync(),
        close: () => handle.close(),
        stat: () => {
          observed.stat++
          return handle.stat()
        },
        read: async (buffer, offset, length, position) => {
          observed.read++
          const result = await handle.read(buffer, offset, length, position)
          return { bytesRead: result.bytesRead }
        },
      }
      return wrapped
    },
  }
}

async function runMigration(
  directory: string,
  sessionId: string,
  options: {
    limits?: SessionStorageLimits
    probe?: (point: SessionMigrationPoint) => void | Promise<void>
    io?: SessionJournalIo
  } = {},
) {
  const lease = new SessionFileLease(directory, sessionId, options.io)
  try {
    const result = await migrateLegacySession({
      directory,
      sessionId,
      lease,
      limits: options.limits ?? TEST_LIMITS,
      verifyPreparedBundle: typedQuotaGate,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
    })
    return { lease, result }
  } catch (error) {
    await lease.close().catch(() => undefined)
    throw error
  }
}

async function generations(directory: string, sessionId: string) {
  return (await readdir(join(directory, `${sessionId}.session-v1`)))
    .filter((name) => /^[0-9a-f]{64}$/.test(name))
    .sort()
}

describe('legacy session migration', () => {
  it('rejects a lease/session identity mismatch before opening the journal', async (context) => {
    const { directory } = await createLegacy(context, 'lease-identity')
    const lease = new SessionFileLease(directory, 'lease-identity')
    await assert.rejects(
      migrateLegacySession({
        directory,
        sessionId: 'different-session',
        lease,
        limits: TEST_LIMITS,
        verifyPreparedBundle: typedQuotaGate,
      }),
      /lease identity/,
    )
    await lease.close()
  })

  it('publishes the deterministic bundle and exact invalid-JSON fence through real descriptors',
    async (context) => {
      const sessionId = 'exact-fence'
      const sourceBytes = Buffer.concat([event(1), event(2, '密😀')])
      const { directory, journal } = await createLegacy(context, sessionId, sourceBytes)
      const observed = { stat: 0, read: 0 }
      const { lease, result } = await runMigration(directory, sessionId, {
        io: descriptorPreservingIo(observed),
      })
      context.after(() => lease.close())

      const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
      const expectedGeneration = createHash('sha256').update(
        `super-agent:session-layout-v1\0${sessionId}\0${LEGACY_JSONL_SOURCE_KIND}\0` +
          `${sourceBytes.length}\0${sourceSha256}`,
        'utf8',
      ).digest('hex')
      assert.equal(result.disposition, 'migrated')
      assert.equal(result.format.source.sha256, sourceSha256)
      assert.equal(result.format.generation, expectedGeneration)
      const fence = await readFile(journal)
      assert.deepEqual(fence, encodeSessionFence(expectedGeneration))
      assert.equal(parseSessionFence(fence), expectedGeneration)
      assert.throws(() => JSON.parse(fence.toString('utf8').trim()), SyntaxError)
      assert.ok(observed.stat > 0)
      assert.ok(observed.read > 0)

      await assert.rejects(
        runMigration(directory, sessionId),
        /锁|lock|writer|写者/i,
        'the committed fence flock remains held for the Store lease lifetime',
      )
      await lease.close()
      const reopened = await runMigration(directory, sessionId)
      assert.equal(reopened.result.disposition, 'reopened')
      await reopened.lease.close()
    })

  it('repairs only the locked legacy EOF fragment before fingerprinting', async (context) => {
    const complete = event(1)
    const fragment = Buffer.from('{"torn":"密😀"}', 'utf8')
    const { directory } = await createLegacy(
      context,
      'repair-fragment',
      Buffer.concat([complete, fragment]),
    )

    const { lease, result } = await runMigration(directory, 'repair-fragment')
    assert.equal(result.repairedLegacyEofBytes, fragment.length)
    assert.equal(result.format.source.byteLength, complete.length)
    await lease.close()
  })

  it('rejects a complete invalid JSON record before committing the fence', async (context) => {
    const { directory, journal } = await createLegacy(
      context,
      'invalid-complete',
      Buffer.from('{not-json}\n'),
    )

    await assert.rejects(
      runMigration(directory, 'invalid-complete'),
      /invalid_json|validation/i,
    )
    assert.equal((await readFile(journal, 'utf8')), '{not-json}\n')
  })

  it('keeps legacy canonical when the typed Operation/quota gate rejects the bundle',
    async (context) => {
      const sessionId = 'quota-gate-rejects'
      const source = event(1)
      const { directory, journal } = await createLegacy(context, sessionId, source)
      let sawFencePhase = false
      for (let attempt = 0; attempt < 3; attempt++) {
        const lease = new SessionFileLease(directory, sessionId)
        await assert.rejects(
          migrateLegacySession({
            directory,
            sessionId,
            lease,
            limits: TEST_LIMITS,
            verifyPreparedBundle() {
              throw new Error('critical reservation exceeds total contract')
            },
            probe(point) {
              if (point === 'before_fence_commit' || point === 'fence_locked') {
                sawFencePhase = true
              }
            },
          }),
          /critical reservation exceeds total contract/,
        )
        await lease.close()
        const bundleEntries = await readdir(join(directory, `${sessionId}.session-v1`))
        assert.equal(bundleEntries.some((name) => name.endsWith('.staging')), false)
        assert.equal(bundleEntries.some((name) => /^[0-9a-f]{64}$/.test(name)), false)
      }
      assert.equal(sawFencePhase, false)
      assert.deepEqual(await readFile(journal), source)
    })

  it('removes only abandoned private staging directories while both migration locks are held',
    async (context) => {
      const sessionId = 'abandoned-staging'
      const { directory } = await createLegacy(context, sessionId)
      const bundleRoot = join(directory, `${sessionId}.session-v1`)
      await mkdir(bundleRoot, { mode: 0o700 })
      const abandoned = join(
        bundleRoot,
        `.${'a'.repeat(64)}.999.00000000-0000-4000-8000-000000000000.staging`,
      )
      await mkdir(abandoned, { mode: 0o700 })
      await writeFile(join(abandoned, 'legacy-copy'), event(99), { mode: 0o600 })
      const unrelated = join(bundleRoot, '.operator-note')
      await writeFile(unrelated, 'keep', { mode: 0o600 })

      const migrated = await runMigration(directory, sessionId)
      await migrated.lease.close()
      const names = await readdir(bundleRoot)
      assert.equal(names.includes('.operator-note'), true)
      assert.equal(names.some((name) => name.endsWith('.staging')), false)
    })

  it('reuses only an exact orphan and derives a new generation after a legacy append',
    async (context) => {
      const sessionId = 'orphan-append'
      const { directory, journal } = await createLegacy(context, sessionId)
      await assert.rejects(
        runMigration(directory, sessionId, {
          probe(point) {
            if (point === 'bundle_published') throw new Error('crash after bundle publish')
          },
        }),
        /crash after bundle publish/,
      )
      const [orphan] = await generations(directory, sessionId)
      assert.ok(orphan)

      await appendFile(journal, event(2))
      const migrated = await runMigration(directory, sessionId)
      assert.equal(migrated.result.disposition, 'migrated')
      assert.notEqual(migrated.result.format.generation, orphan)
      assert.deepEqual(await generations(directory, sessionId),
        [orphan, migrated.result.format.generation].sort())
      assert.equal(parseSessionFence(await readFile(journal)), migrated.result.format.generation)
      await migrated.lease.close()
    })

  it('refuses an orphan with extra active-fragment bytes despite a matching valid prefix',
    async (context) => {
      const sessionId = 'orphan-extra-fragment'
      const source = event(1)
      const { directory, journal } = await createLegacy(context, sessionId, source)
      await assert.rejects(
        runMigration(directory, sessionId, {
          probe(point) {
            if (point === 'bundle_published') throw new Error('published orphan prefix')
          },
        }),
        /published orphan prefix/,
      )
      const [generation] = await generations(directory, sessionId)
      assert.ok(generation)
      const activePath = join(
        directory,
        `${sessionId}.session-v1`,
        generation,
        'segments',
        formatSessionSegmentFileName(1, 'active'),
      )
      await appendFile(activePath, '{"extra":"fragment"}')

      await assert.rejects(
        runMigration(directory, sessionId),
        /beyond the locked legacy source/,
      )
      assert.deepEqual(await readFile(journal), source)
    })

  it('recovers persisted custom limits when reusing an orphan without new explicit limits',
    async (context) => {
      const sessionId = 'orphan-custom-limits'
      const customLimits = Object.freeze({ ...TEST_LIMITS, segmentTargetBytes: 97 })
      const { directory } = await createLegacy(context, sessionId)
      await assert.rejects(
        runMigration(directory, sessionId, {
          limits: customLimits,
          probe(point) {
            if (point === 'bundle_published') throw new Error('published custom orphan')
          },
        }),
        /published custom orphan/,
      )

      const lease = new SessionFileLease(directory, sessionId)
      const reused = await migrateLegacySession({
        directory,
        sessionId,
        lease,
        verifyPreparedBundle: typedQuotaGate,
      })
      assert.equal(reused.disposition, 'reused-orphan')
      assert.equal(reused.format.limits.segmentTargetBytes, 97)
      await lease.close()
    })

  it('fails closed on fence/format mismatch without adopting another generation',
    async (context) => {
      const sessionId = 'fence-format-mismatch'
      const { directory } = await createLegacy(context, sessionId)
      const migrated = await runMigration(directory, sessionId)
      await migrated.lease.close()
      await chmod(migrated.result.paths.formatPath, 0o644)

      await assert.rejects(
        runMigration(directory, sessionId),
        /unsafe|metadata|private|migration failed/i,
      )
    })

  it('keeps metadata private and excludes record bodies from format, manifest, and fence',
    async (context) => {
      const sessionId = 'safe-metadata'
      const secret = 'MIGRATION_METADATA_SECRET_SENTINEL'
      const { directory, journal } = await createLegacy(context, sessionId, event(1, secret))
      const migrated = await runMigration(directory, sessionId)
      const { paths } = migrated.result

      for (const directoryPath of [directory, paths.bundleRootPath, paths.generationPath,
        paths.segmentsPath]) {
        assert.equal((await stat(directoryPath)).mode & 0o777, 0o700)
      }
      for (const filePath of [journal, paths.formatPath, paths.manifestPath]) {
        assert.equal((await stat(filePath)).mode & 0o777, 0o600)
        assert.doesNotMatch(await readFile(filePath, 'utf8'), new RegExp(secret))
      }
      await migrated.lease.close()
    })
})

const CRASH_POINTS: readonly SessionMigrationPoint[] = [
  'legacy_synced',
  'bundle_staged',
  'bundle_published',
  'bundle_verified',
  'before_fence_commit',
  'fence_locked',
  'fence_synced',
  'fence_renamed',
  'fence_verified',
  'parent_synced',
  'legacy_unlocked',
]

describe('legacy session migration fault-injection boundaries', () => {
  for (const crashPoint of CRASH_POINTS) {
    it(`recovers idempotently after ${crashPoint}`, async (context) => {
      const sessionId = `migration-crash-${CRASH_POINTS.indexOf(crashPoint)}`
      const { directory, journal } = await createLegacy(context, sessionId)
      await assert.rejects(
        runMigration(directory, sessionId, {
          probe(point) {
            if (point === crashPoint) throw new Error(`injected ${crashPoint}`)
          },
        }),
        new RegExp(`injected ${crashPoint}`),
      )

      const afterFault = await readFile(journal)
      const committed = [
        'fence_renamed',
        'fence_verified',
        'parent_synced',
        'legacy_unlocked',
      ].includes(crashPoint)
      if (committed) assert.doesNotThrow(() => parseSessionFence(afterFault))
      else assert.deepEqual(afterFault, event(1))

      const recovered = await runMigration(directory, sessionId)
      assert.equal(recovered.result.disposition, committed
        ? 'reopened'
        : ['legacy_synced', 'bundle_staged'].includes(crashPoint)
          ? 'migrated'
          : 'reused-orphan')
      assert.equal(parseSessionFence(await readFile(journal)), recovered.result.format.generation)
      await recovered.lease.close()
    })
  }
})

it('fails before the fence when the verified generation path is replaced',
  async (context) => {
    const sessionId = 'bundle-pin-before-fence'
    const source = event(1)
    const { directory, journal } = await createLegacy(context, sessionId, source)
    let canonical = ''
    let moved = ''
    await assert.rejects(
      runMigration(directory, sessionId, {
        async probe(point) {
          if (point !== 'before_fence_commit') return
          const [generation] = await generations(directory, sessionId)
          assert.ok(generation)
          canonical = join(directory, `${sessionId}.session-v1`, generation)
          moved = `${canonical}.moved`
          await rename(canonical, moved)
        },
      }),
      /bundle|directory|ENOENT|unavailable/i,
    )
    assert.deepEqual(await readFile(journal), source)
    assert.throws(() => parseSessionFence(source))

    await rename(moved, canonical)
    const recovered = await runMigration(directory, sessionId)
    assert.equal(recovered.result.disposition, 'reused-orphan')
    await recovered.lease.close()
  })

async function probeSecondaryLocks(path: string, legacyFd: number) {
  const script = String.raw`
    import { constants, openSync } from 'node:fs'
    import { flockSync } from 'fs-ext'
    const blocked = new Set(['EAGAIN', 'EACCES', 'EWOULDBLOCK'])
    function attempt(fd) {
      try { flockSync(fd, 'exnb'); flockSync(fd, 'un'); return 'available' }
      catch (error) { return blocked.has(error?.code) ? 'blocked' : String(error?.code) }
    }
    const canonical = openSync(process.argv[1], constants.O_RDWR)
    process.stdout.write(JSON.stringify({ canonical: attempt(canonical), legacy: attempt(3) }))
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, path], {
    stdio: ['ignore', 'pipe', 'pipe', legacyFd],
  })

  assert.ok(child.stdout)
  assert.ok(child.stderr)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const [code] = await once(child, 'close') as [number]
  assert.equal(code, 0, stderr)
  return JSON.parse(stdout) as { canonical: string; legacy: string }
}

describe('legacy/fence secondary lock overlap', () => {
  it('holds both locks before rename and through parent fsync, then releases only legacy', {
    skip: process.platform === 'win32' ? 'POSIX flock/rename semantics are required' : false,
  }, async (context) => {
    const sessionId = 'secondary-overlap'
    const { directory, journal } = await createLegacy(context, sessionId)
    const legacyFd = openSync(journal, constants.O_RDWR)
    context.after(() => closeSync(legacyFd))
    const observations = new Map<string, { canonical: string; legacy: string }>()

    const migrated = await runMigration(directory, sessionId, {
      async probe(point) {
        if (point === 'fence_locked') {
          const temp = (await readdir(directory)).find((name) => name.endsWith('.fence.tmp'))
          assert.ok(temp)
          observations.set(point, await probeSecondaryLocks(join(directory, temp), legacyFd))
        }
        if (point === 'parent_synced' || point === 'legacy_unlocked') {
          observations.set(point, await probeSecondaryLocks(journal, legacyFd))
        }
      },
    })

    assert.deepEqual(observations.get('fence_locked'), {
      canonical: 'blocked',
      legacy: 'blocked',
    })
    assert.deepEqual(observations.get('parent_synced'), {
      canonical: 'blocked',
      legacy: 'blocked',
    })
    assert.deepEqual(observations.get('legacy_unlocked'), {
      canonical: 'blocked',
      legacy: 'available',
    })
    await migrated.lease.close()
  })
})
