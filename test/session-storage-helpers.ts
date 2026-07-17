import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseSessionFence,
  parseSessionSegmentFileName,
  resolveSessionBundlePaths,
  type SessionBundlePaths,
} from '../src/session/session-layout.js'

export async function sessionBundlePaths(
  directory: string,
  sessionId: string,
): Promise<SessionBundlePaths> {
  const generation = parseSessionFence(await readFile(join(directory, `${sessionId}.jsonl`)))
  return resolveSessionBundlePaths(directory, sessionId, generation)
}

export async function sessionSegmentPaths(directory: string, sessionId: string) {
  const paths = await sessionBundlePaths(directory, sessionId)
  const entries = (await readdir(paths.segmentsPath)).map((fileName) => {
    const parsed = parseSessionSegmentFileName(fileName)
    if (!parsed) throw new Error(`Unexpected session segment entry: ${fileName}`)
    return { ...parsed, path: join(paths.segmentsPath, fileName) }
  }).sort((left, right) => left.ordinal - right.ordinal)
  return { paths, entries }
}

export async function activeSessionSegmentPath(directory: string, sessionId: string) {
  const { entries } = await sessionSegmentPaths(directory, sessionId)
  const active = entries.find(({ state }) => state === 'active')
  if (!active) throw new Error(`Session ${sessionId} has no active segment`)
  return active.path
}

export async function readSessionEventBytes(directory: string, sessionId: string) {
  const { entries } = await sessionSegmentPaths(directory, sessionId)
  return Buffer.concat(await Promise.all(entries.map(({ path }) => readFile(path))))
}
