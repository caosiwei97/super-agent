import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, type TestContext } from 'node:test'
import { scanSessionJournal } from '../src/session/journal-scanner.js'
import {
  createSessionFormat,
  deterministicSessionJsonBytes,
  encodeSessionFence,
  LEGACY_JSONL_SOURCE_KIND,
  parseSessionFence,
  resolveSessionBundlePaths,
} from '../src/session/session-layout.js'
import {
  migrateLegacySession,
  type SessionMigrationPoint,
} from '../src/session/session-migration.js'
import { SessionFileLease } from '../src/session/session-file-lease.js'
import {
  readSessionSegmentChunks,
  SessionSegmentStorage,
  type SessionSegmentStoragePoint,
} from '../src/session/session-segment-storage.js'

const workerFixture = fileURLToPath(
  new URL('./fixtures/session-storage-sigkill-worker.ts', import.meta.url),
)

const MIGRATION_SIGKILL_POINTS = [
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
  'existing_fence_adopted',
] as const satisfies readonly SessionMigrationPoint[]

const ROTATION_SIGKILL_POINTS = [
  'active_synced',
  'active_renamed',
  'sealed_directory_synced',
  'next_active_created',
  'next_active_synced',
] as const satisfies readonly SessionSegmentStoragePoint[]

interface CrashSignal {
  readonly type: 'session-storage-crash-point'
  readonly mode: 'migration' | 'rotation'
  readonly point: string
}

function event(sequence: number) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    eventId: `sigkill-event-${sequence}`,
    sequence,
    type: 'test.sigkill',
    timestamp: '2026-07-17T00:00:00.000Z',
  })}\n`, 'utf8')
}

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const values: Buffer[] = []
  for await (const chunk of chunks) values.push(Buffer.from(chunk))
  return Buffer.concat(values)
}

async function* oneChunk(bytes: Uint8Array) {
  yield bytes
}

async function assertOrderedEvents(bytes: Uint8Array, count: number) {
  const scanned = await scanSessionJournal(oneChunk(bytes), { maxRecordBytes: 4096 })
  assert.equal(scanned.recordCount, count)
  assert.equal(scanned.nextSequence, count + 1)
  assert.equal(scanned.diagnostics.length, 0)
}

async function createLegacyFixture(context: TestContext, sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-migration-sigkill-'))
  const directory = join(root, 'sessions')
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, `${sessionId}.lock`), '', { mode: 0o600 })
  await writeFile(join(directory, `${sessionId}.jsonl`), event(1), { mode: 0o600 })
  context.after(() => rm(root, { recursive: true, force: true }))
  return { directory, journal: join(directory, `${sessionId}.jsonl`) }
}

async function recoverMigration(directory: string, sessionId: string) {
  const lease = new SessionFileLease(directory, sessionId)
  try {
    const result = await migrateLegacySession({
      directory,
      sessionId,
      lease,
      verifyPreparedBundle: async ({ scan, readChunks }) => {
        assert.equal(scan.recordCount, 1)
        assert.equal(scan.nextSequence, 2)
        assert.deepEqual(await collect(readChunks()), event(1))
      },
    })
    await lease.close()
    return result
  } catch (error) {
    await lease.close().catch(() => undefined)
    throw error
  }
}

async function spawnCrashWorker(
  context: TestContext,
  mode: CrashSignal['mode'],
  point: string,
  directory: string,
  sessionId: string,
  generation?: string,
) {
  const child = spawn(process.execPath, [
    '--import', 'tsx', workerFixture,
    mode, point, directory, sessionId,
    ...(generation === undefined ? [] : [generation]),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  assert.ok(child.stdout)
  assert.ok(child.stderr)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const [exitCode, exitSignal] = await once(child, 'close') as [
    number | null,
    NodeJS.Signals | null,
  ]
  assert.equal(exitCode, null, stderr)
  assert.equal(exitSignal, 'SIGKILL', stderr)
  const lines = stdout.trimEnd().split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1, `expected one crash signal; stderr=${stderr}`)
  const signal = JSON.parse(lines[0]!) as CrashSignal
  assert.deepEqual(signal, {
    type: 'session-storage-crash-point',
    mode,
    point,
  })
}

describe('session migration real SIGKILL recovery', () => {
  for (const point of MIGRATION_SIGKILL_POINTS) {
    it(point, {
      skip: process.platform === 'win32' ? 'SIGKILL/flock recovery is POSIX-only' : false,
      timeout: 20_000,
    }, async (context) => {
      const sessionId = `migration-sigkill-${MIGRATION_SIGKILL_POINTS.indexOf(point)}`
      const { directory, journal } = await createLegacyFixture(context, sessionId)
      if (point === 'existing_fence_adopted') await recoverMigration(directory, sessionId)

      await spawnCrashWorker(context, 'migration', point, directory, sessionId)

      // Reacquiring the default lease proves the real fixed/canonical flocks
      // were released by kernel process teardown.
      const recovered = await recoverMigration(directory, sessionId)
      const fence = await readFile(journal)
      assert.deepEqual(fence, encodeSessionFence(recovered.format.generation))
      assert.equal(parseSessionFence(fence), recovered.format.generation)
      assert.throws(() => JSON.parse(fence.toString('utf8').trim()), SyntaxError)
      const bytes = await collect(readSessionSegmentChunks({
        paths: recovered.paths,
        format: recovered.format,
      }))
      assert.deepEqual(bytes, event(1))
      await assertOrderedEvents(bytes, 1)
    })
  }
})

async function createRotationFixture(context: TestContext, sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-rotation-sigkill-'))
  const directory = join(root, 'sessions')
  await mkdir(directory, { mode: 0o700 })
  const first = event(1)
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
      segmentTargetBytes: first.length + 1,
      regularQuotaBytes: 1024 * 1024,
      criticalReserveBytes: 4096,
    },
  })
  const paths = resolveSessionBundlePaths(directory, sessionId, format.generation)
  await mkdir(paths.bundleRootPath, { mode: 0o700 })
  await mkdir(paths.generationPath, { mode: 0o700 })
  await writeFile(paths.formatPath, deterministicSessionJsonBytes(format), { mode: 0o600 })
  const storage = await SessionSegmentStorage.open({ paths, format })
  await storage.appendPreparedBatch(storage.prepareAppendBatch([first]), {
    durability: 'durable',
  })
  await storage.close()
  context.after(() => rm(root, { recursive: true, force: true }))
  return { directory, format, paths }
}

describe('session rotation real SIGKILL recovery', () => {
  for (const point of ROTATION_SIGKILL_POINTS) {
    it(point, {
      skip: process.platform === 'win32' ? 'SIGKILL/rename recovery is POSIX-only' : false,
      timeout: 20_000,
    }, async (context) => {
      const sessionId = `rotation-sigkill-${ROTATION_SIGKILL_POINTS.indexOf(point)}`
      const fixture = await createRotationFixture(context, sessionId)
      await spawnCrashWorker(
        context,
        'rotation',
        point,
        fixture.directory,
        sessionId,
        fixture.format.generation,
      )

      const recovered = await SessionSegmentStorage.open({
        paths: fixture.paths,
        format: fixture.format,
      })
      assert.deepEqual(await collect(recovered.readChunks()), event(1))
      await recovered.appendPreparedBatch(recovered.prepareAppendBatch([event(2)]), {
        durability: 'durable',
      })
      await recovered.close()

      const verified = await SessionSegmentStorage.open({
        paths: fixture.paths,
        format: fixture.format,
      })
      const bytes = await collect(verified.readChunks())
      assert.deepEqual(bytes, Buffer.concat([event(1), event(2)]))
      await assertOrderedEvents(bytes, 2)
      await verified.close()
    })
  }
})
