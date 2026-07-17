import { writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  parseSessionFormatBytes,
  resolveSessionBundlePaths,
} from '../../src/session/session-layout.js'
import {
  migrateLegacySession,
  type SessionMigrationPoint,
} from '../../src/session/session-migration.js'
import { SessionFileLease } from '../../src/session/session-file-lease.js'
import {
  SessionSegmentStorage,
  type SessionSegmentStoragePoint,
} from '../../src/session/session-segment-storage.js'

type WorkerMode = 'migration' | 'rotation'

const MIGRATION_POINTS = new Set<SessionMigrationPoint>([
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
])

const ROTATION_POINTS = new Set<SessionSegmentStoragePoint>([
  'active_synced',
  'active_renamed',
  'sealed_directory_synced',
  'next_active_created',
  'next_active_synced',
])

function event(sequence: number) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    eventId: `sigkill-event-${sequence}`,
    sequence,
    type: 'test.sigkill',
    timestamp: '2026-07-17T00:00:00.000Z',
  })}\n`, 'utf8')
}

function crash(mode: WorkerMode, point: string): never {
  writeSync(1, `${JSON.stringify({
    type: 'session-storage-crash-point',
    mode,
    point,
  })}\n`)
  process.kill(process.pid, 'SIGKILL')
  throw new Error(`SIGKILL did not terminate ${mode} worker at ${point}`)
}

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const values: Buffer[] = []
  for await (const chunk of chunks) values.push(Buffer.from(chunk))
  return Buffer.concat(values)
}

const [modeValue, pointValue, directory, sessionId, generation] = process.argv.slice(2)
if ((modeValue !== 'migration' && modeValue !== 'rotation') ||
    !pointValue || !directory || !sessionId) {
  throw new Error('Missing or invalid session storage SIGKILL worker arguments')
}
const mode: WorkerMode = modeValue

if (mode === 'migration') {
  if (!MIGRATION_POINTS.has(pointValue as SessionMigrationPoint)) {
    throw new Error(`Unknown migration crash point: ${pointValue}`)
  }
  const selectedPoint = pointValue as SessionMigrationPoint
  const lease = new SessionFileLease(directory, sessionId)
  await migrateLegacySession({
    directory,
    sessionId,
    lease,
    verifyPreparedBundle: async ({ scan, readChunks }) => {
      if (scan.recordCount !== 1 || scan.nextSequence !== 2) {
        throw new Error('Migration worker prepared bundle validation failed')
      }
      if (!(await collect(readChunks())).equals(event(1))) {
        throw new Error('Migration worker prepared bundle bytes changed')
      }
    },
    probe(point) {
      if (point === selectedPoint) crash(mode, point)
    },
  })
  await lease.close()
  throw new Error(`Migration worker did not reach ${selectedPoint}`)
}

if (!ROTATION_POINTS.has(pointValue as SessionSegmentStoragePoint) || !generation) {
  throw new Error(`Unknown rotation crash point or missing generation: ${pointValue}`)
}
const selectedPoint = pointValue as SessionSegmentStoragePoint
const paths = resolveSessionBundlePaths(directory, sessionId, generation)
const format = parseSessionFormatBytes(await readFile(paths.formatPath), {
  sessionId,
  generation,
})
const storage = await SessionSegmentStorage.open({
  paths,
  format,
  probe(point) {
    if (point === selectedPoint) crash(mode, point)
  },
})
await storage.appendPreparedBatch(storage.prepareAppendBatch([event(2)]), {
  durability: 'durable',
})
await storage.close()
throw new Error(`Rotation worker did not reach ${selectedPoint}`)
