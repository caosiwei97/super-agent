import assert from 'node:assert/strict'
import { fstatSync } from 'node:fs'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { executeProcess } from '../src/execution/process-executor.js'
import { withReadOnlyWorkspaceFd } from '../src/execution/linux-sandbox-prerequisites.js'
import {
  WorkspaceSnapshotError,
  cleanupStaleWorkspaceSnapshots,
  createWorkspaceSnapshot,
  withWorkspaceSnapshot,
  type WorkspaceSnapshotLimits,
  type WorkspaceSnapshotOptions,
  type WorkspaceSnapshotSource,
} from '../src/execution/workspace-snapshot.js'

const generousLimits: WorkspaceSnapshotLimits = Object.freeze({
  maxFiles: 100,
  maxEntries: 200,
  maxTotalBytes: 1024 * 1024,
  maxFileBytes: 512 * 1024,
  maxDepth: 16,
})

const snapshotOwnerSchema = 'super-agent.workspace-snapshot-owner/v1'

function control(signal = new AbortController().signal) {
  return { signal, deadline: Date.now() + 10_000 }
}

async function directorySource(root: string): Promise<WorkspaceSnapshotSource> {
  const canonicalPath = await realpath(root)
  const metadata = await stat(root, { bigint: true })
  return {
    readPath: root,
    canonicalPath,
    expectedIdentity: `${metadata.dev}:${metadata.ino}`,
  }
}

function options(
  stagingParent: string,
  overrides: Partial<WorkspaceSnapshotOptions> = {},
): WorkspaceSnapshotOptions {
  return {
    limits: overrides.limits ?? generousLimits,
    control: overrides.control ?? control(),
    stagingParent,
    testHooks: overrides.testHooks,
  }
}

async function fixture(prefix: string) {
  const parent = await mkdtemp(join(tmpdir(), prefix))
  const source = join(parent, 'source')
  const staging = join(parent, 'staging')
  await mkdir(source)
  await mkdir(staging)
  return { parent, source, staging }
}

async function crashArtifact(parent: string) {
  const artifact = await mkdtemp(join(parent, 'super-agent-workspace-snapshot-'))
  await chmod(artifact, 0o700)
  const metadata = await stat(artifact, { bigint: true })
  const payload = join(artifact, 'payload')
  await writeFile(join(artifact, 'owner.json'), `${JSON.stringify({
    schema: snapshotOwnerSchema,
    artifactIdentity: `${metadata.dev}:${metadata.ino}`,
    ownerUid: process.getuid!(),
  })}\n`, { mode: 0o600 })
  await chmod(join(artifact, 'owner.json'), 0o400)
  await mkdir(payload, { mode: 0o700 })
  return { artifact, payload }
}

async function makeOld(path: string, now: number) {
  const old = new Date(now - 60_000)
  await utimes(path, old, old)
}

async function assertSnapshotError(
  action: () => Promise<unknown>,
  code: WorkspaceSnapshotError['code'],
) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof WorkspaceSnapshotError)
    assert.equal(error.code, code)
    return true
  })
}

describe('WorkspaceSnapshot', () => {
  it('creates an independent, bounded, read-only copy with an owned FD', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-basic-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    await mkdir(join(paths.source, 'src'))
    await writeFile(join(paths.source, 'README.md'), 'before')
    await writeFile(join(paths.source, 'src', 'index.ts'), 'export const answer = 42\n')

    const snapshot = await createWorkspaceSnapshot(
      await directorySource(paths.source),
      options(paths.staging),
    )
    const descriptor = snapshot.descriptor
    assert.equal(snapshot.implementation, 'verified-user-space-copy')
    assert.equal(snapshot.fileCount, 2)
    assert.equal(snapshot.entryCount, 3)
    assert.equal(snapshot.totalBytes, Buffer.byteLength('before') + Buffer.byteLength('export const answer = 42\n'))
    assert.deepEqual(snapshot.manifest.map((entry) => entry.relativePath), [
      'README.md',
      'src/index.ts',
    ])
    assert.equal((await stat(snapshot.rootPath)).mode & 0o777, 0o500)
    assert.deepEqual((await readdir(join(snapshot.rootPath, '..'))).sort(), ['owner.json', 'payload'])
    assert.equal((await stat(join(snapshot.rootPath, 'src'))).mode & 0o777, 0o500)
    assert.equal((await stat(join(snapshot.rootPath, 'README.md'))).mode & 0o777, 0o400)
    assert.equal(fstatSync(descriptor).isDirectory(), true)

    await writeFile(join(paths.source, 'README.md'), 'after')
    assert.equal(await readFile(join(snapshot.rootPath, 'README.md'), 'utf8'), 'before')

    await Promise.all([snapshot.cleanup(), snapshot.cleanup()])
    await snapshot.cleanup()
    await assert.rejects(stat(snapshot.rootPath), { code: 'ENOENT' })
    assert.throws(() => fstatSync(descriptor), { code: 'EBADF' })
  })

  it('rejects symlinks, hardlinks, sensitive paths and special files', {
    skip: process.platform === 'win32' && 'POSIX filesystem semantics required',
  }, async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-unsafe-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    const ordinary = join(paths.source, 'ordinary.txt')
    await writeFile(ordinary, 'ordinary')

    const alias = join(paths.source, 'alias.txt')
    await symlink(ordinary, alias)
    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(paths.staging)),
      'workspace_snapshot_unsafe_entry',
    )
    await unlink(alias)

    await link(ordinary, alias)
    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(paths.staging)),
      'workspace_snapshot_unsafe_entry',
    )
    await unlink(alias)

    await writeFile(join(paths.source, '.env'), 'TOKEN=synthetic')
    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(paths.staging)),
      'workspace_snapshot_unsafe_entry',
    )
    await unlink(join(paths.source, '.env'))

    const fifo = join(paths.source, 'blocked.fifo')
    const created = await executeProcess({ command: 'mkfifo', args: [fifo], timeoutMs: 2_000 })
    assert.equal(created.terminationReason, 'exited')
    assert.equal(created.exitCode, 0)
    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(paths.staging)),
      'workspace_snapshot_unsafe_entry',
    )
    assert.deepEqual(await readdir(paths.staging), [])
  })

  it('enforces file, entry, total-byte, single-file and depth limits', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-limits-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    await mkdir(join(paths.source, 'deep'))
    await writeFile(join(paths.source, 'one.txt'), '1234')
    await writeFile(join(paths.source, 'two.txt'), '5678')
    await writeFile(join(paths.source, 'deep', 'three.txt'), '90')
    const source = await directorySource(paths.source)
    const expectLimit = async (limits: WorkspaceSnapshotLimits) => {
      await assertSnapshotError(
        () => createWorkspaceSnapshot(source, options(paths.staging, { limits })),
        'workspace_snapshot_limit_exceeded',
      )
      assert.deepEqual(await readdir(paths.staging), [])
    }

    await expectLimit({ ...generousLimits, maxFiles: 2 })
    await expectLimit({ ...generousLimits, maxEntries: 3 })
    await expectLimit({ ...generousLimits, maxFileBytes: 3 })
    await expectLimit({ ...generousLimits, maxTotalBytes: 9, maxFileBytes: 9 })
    await expectLimit({ ...generousLimits, maxDepth: 1 })
  })

  it('rejects a non-sticky staging parent writable by other users', {
    skip: process.platform === 'win32' && 'POSIX mode semantics required',
  }, async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-parent-trust-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    await writeFile(join(paths.source, 'safe.txt'), 'safe')
    await chmod(paths.staging, 0o777)
    await assertSnapshotError(
      async () => createWorkspaceSnapshot(
        await directorySource(paths.source),
        options(paths.staging),
      ),
      'workspace_snapshot_staging_failed',
    )
    await assertSnapshotError(
      () => cleanupStaleWorkspaceSnapshots({
        stagingParent: paths.staging,
        minimumAgeMs: 1_000,
        control: control(),
      }),
      'workspace_snapshot_staging_failed',
    )
    assert.deepEqual(await readdir(paths.staging), [])
  })

  it('rejects a shared root-owned sticky directory as the final staging parent', {
    skip: process.platform === 'win32' && 'requires POSIX /tmp ownership and mode semantics',
  }, async (context) => {
    const sharedTmp = '/tmp'
    const metadata = await stat(sharedTmp)
    if (metadata.uid !== 0 || (metadata.mode & 0o1000) === 0) {
      context.skip('platform /tmp is not a root-owned sticky directory')
      return
    }
    const paths = await fixture('super-agent-workspace-snapshot-shared-parent-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    await writeFile(join(paths.source, 'safe.txt'), 'safe')
    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(sharedTmp)),
      'workspace_snapshot_staging_failed',
    )
  })

  it('detects content and directory identity drift during copying', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-drift-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    const target = join(paths.source, 'target.txt')
    await writeFile(target, 'alpha')

    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(paths.staging, {
        testHooks: {
          afterFileCopied: async () => writeFile(target, 'omega'),
        },
      })),
      'workspace_snapshot_source_changed',
    )
    assert.deepEqual(await readdir(paths.staging), [])

    await writeFile(target, 'stable')
    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(paths.staging, {
        testHooks: {
          afterFileCopied: async () => {
            await rename(target, join(paths.source, 'displaced.txt'))
            await writeFile(target, 'stable')
          },
        },
      })),
      'workspace_snapshot_source_changed',
    )
    assert.deepEqual(await readdir(paths.staging), [])
  })

  it('rejects a mixed-version copy when an early file changes while a later file copies', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-mixed-version-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    const early = join(paths.source, 'early.txt')
    await writeFile(early, 'alpha')
    await writeFile(join(paths.source, 'later.txt'), 'later')

    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(paths.staging, {
        testHooks: {
          afterFileCopied: async (relativePath) => {
            if (relativePath === 'later.txt') await writeFile(early, 'omega')
          },
        },
      })),
      'workspace_snapshot_source_changed',
    )
    assert.deepEqual(await readdir(paths.staging), [])
  })

  it('detects a Darwin compatibility-source pathname replacement', {
    skip: process.platform === 'linux' && 'Linux traversal is descriptor-relative instead',
  }, async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-darwin-race-')
    const replacement = join(paths.parent, 'replacement')
    const displaced = join(paths.parent, 'displaced')
    await mkdir(replacement)
    await writeFile(join(paths.source, 'marker.txt'), 'original')
    await writeFile(join(replacement, 'marker.txt'), 'replacement')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))

    await assertSnapshotError(
      async () => createWorkspaceSnapshot(await directorySource(paths.source), options(paths.staging, {
        testHooks: {
          afterFileCopied: async () => {
            await rename(paths.source, displaced)
            await rename(replacement, paths.source)
          },
        },
      })),
      'workspace_snapshot_source_changed',
    )
    assert.deepEqual(await readdir(paths.staging), [])
  })

  it('propagates cancellation and removes a partially built staging tree', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-abort-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    await writeFile(join(paths.source, 'first.txt'), 'first')
    await writeFile(join(paths.source, 'second.txt'), 'second')
    const controller = new AbortController()
    const cancellation = new DOMException('cancelled by test', 'AbortError')

    await assert.rejects(createWorkspaceSnapshot(
      await directorySource(paths.source),
      options(paths.staging, {
        control: control(controller.signal),
        testHooks: {
          afterFileCopied: () => controller.abort(cancellation),
        },
      }),
    ), (error) => error === cancellation)
    assert.deepEqual(await readdir(paths.staging), [])
  })

  it('keeps callback ownership exact and cleans up when the callback throws', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-callback-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    await writeFile(join(paths.source, 'input.txt'), 'input')
    const sentinel = new Error('sandbox callback failed')
    let stagingRoot = ''
    let descriptor = -1

    await assert.rejects(withWorkspaceSnapshot(
      await directorySource(paths.source),
      options(paths.staging),
      async (snapshot) => {
        stagingRoot = snapshot.rootPath
        descriptor = snapshot.descriptor
        assert.equal(await readFile(join(snapshot.rootPath, 'input.txt'), 'utf8'), 'input')
        throw sentinel
      },
    ), (error) => error === sentinel)
    await assert.rejects(stat(stagingRoot), { code: 'ENOENT' })
    assert.throws(() => fstatSync(descriptor), { code: 'EBADF' })
  })

  it('aggregates callback and cleanup failures without losing either cause', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-double-failure-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    await writeFile(join(paths.source, 'input.txt'), 'input')
    const callbackError = new Error('sandbox callback failed')
    let descriptor = -1
    let displacedRoot = ''

    await assert.rejects(withWorkspaceSnapshot(
      await directorySource(paths.source),
      options(paths.staging),
      async (snapshot) => {
        descriptor = snapshot.descriptor
        displacedRoot = join(snapshot.rootPath, '..', 'displaced-snapshot')
        await rename(snapshot.rootPath, displacedRoot)
        await mkdir(snapshot.rootPath)
        throw callbackError
      },
    ), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      assert.equal(error.errors[0], callbackError)
      assert.ok(error.errors[1] instanceof WorkspaceSnapshotError)
      assert.equal(error.errors[1].code, 'workspace_snapshot_cleanup_failed')
      return true
    })
    assert.throws(() => fstatSync(descriptor), { code: 'EBADF' })
    await chmod(displacedRoot, 0o700)
    await chmod(join(displacedRoot, 'input.txt'), 0o600)
  })

  it('keeps a standalone cleanup failure explicit and fail-closed', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-cleanup-failure-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    await writeFile(join(paths.source, 'input.txt'), 'input')
    let descriptor = -1
    let displacedRoot = ''

    await assert.rejects(withWorkspaceSnapshot(
      await directorySource(paths.source),
      options(paths.staging),
      async (snapshot) => {
        descriptor = snapshot.descriptor
        displacedRoot = join(snapshot.rootPath, '..', 'displaced-snapshot')
        await rename(snapshot.rootPath, displacedRoot)
        await mkdir(snapshot.rootPath)
        return 'completed'
      },
    ), (error) => {
      assert.ok(error instanceof WorkspaceSnapshotError)
      assert.equal(error.code, 'workspace_snapshot_cleanup_failed')
      assert.ok(error.cause instanceof WorkspaceSnapshotError)
      assert.equal(error.cause.code, 'workspace_snapshot_cleanup_failed')
      return true
    })
    assert.throws(() => fstatSync(descriptor), { code: 'EBADF' })
    await chmod(displacedRoot, 0o700)
    await chmod(join(displacedRoot, 'input.txt'), 0o600)
  })

  it('fails closed before staging when the expected source identity is stale', async (context) => {
    const paths = await fixture('super-agent-workspace-snapshot-identity-')
    context.after(() => rm(paths.parent, { recursive: true, force: true }))
    const source = await directorySource(paths.source)
    await assertSnapshotError(
      () => createWorkspaceSnapshot({ ...source, expectedIdentity: '0:0' }, options(paths.staging)),
      'workspace_snapshot_invalid_source',
    )
    assert.deepEqual(await readdir(paths.staging), [])
  })

  it('refuses to create staging recursively inside the source tree', async (context) => {
    const parent = await mkdtemp(join(tmpdir(), 'super-agent-workspace-snapshot-overlap-'))
    const source = join(parent, 'source')
    const nestedStaging = join(source, 'staging')
    await mkdir(source)
    await mkdir(nestedStaging)
    context.after(() => rm(parent, { recursive: true, force: true }))

    await assertSnapshotError(
      async () => createWorkspaceSnapshot(
        await directorySource(source),
        options(nestedStaging),
      ),
      'workspace_snapshot_staging_failed',
    )
    assert.deepEqual(await readdir(nestedStaging), [])
  })

  it('reaps only bounded, owner-marked crash artifacts and empty creation remnants', {
    skip: process.platform === 'win32' && 'requires POSIX uid and mode semantics',
  }, async (context) => {
    const parent = await mkdtemp(join(tmpdir(), 'super-agent-workspace-snapshot-reap-'))
    const stale = await crashArtifact(parent)
    const fresh = await crashArtifact(parent)
    const markerOnly = await crashArtifact(parent)
    await rm(markerOnly.payload, { recursive: true, force: true })
    const emptyStale = await mkdtemp(join(parent, 'super-agent-workspace-snapshot-'))
    const publicMode = await mkdtemp(join(parent, 'super-agent-workspace-snapshot-'))
    const unrelated = await mkdtemp(join(parent, 'unrelated-'))
    const fakePrefix = join(parent, 'super-agent-workspace-snapshot-not-six')
    await mkdir(fakePrefix, { mode: 0o700 })
    await writeFile(join(stale.payload, 'leftover.txt'), 'ok')
    await chmod(join(stale.payload, 'leftover.txt'), 0o400)
    await chmod(stale.payload, 0o500)
    await chmod(emptyStale, 0o700)
    await chmod(publicMode, 0o755)

    const invalidMarker = await crashArtifact(parent)
    await chmod(join(invalidMarker.artifact, 'owner.json'), 0o600)
    await writeFile(join(invalidMarker.artifact, 'owner.json'), '{}\n')
    await chmod(join(invalidMarker.artifact, 'owner.json'), 0o400)

    const special = await crashArtifact(parent)
    const fifo = await executeProcess({
      command: 'mkfifo',
      args: ['-m', '600', join(special.payload, 'special.fifo')],
      timeoutMs: 2_000,
    })
    assert.equal(fifo.exitCode, 0)

    const symlinkArtifact = await crashArtifact(parent)
    const outsideSymlinkTarget = join(parent, 'outside-symlink-target')
    await writeFile(outsideSymlinkTarget, 'outside')
    await symlink(outsideSymlinkTarget, join(symlinkArtifact.payload, 'link'))

    const hardlinkArtifact = await crashArtifact(parent)
    const outsideHardlinkTarget = join(parent, 'outside-hardlink-target')
    await writeFile(outsideHardlinkTarget, 'outside')
    await chmod(outsideHardlinkTarget, 0o400)
    await link(outsideHardlinkTarget, join(hardlinkArtifact.payload, 'hardlink'))

    const overBytes = await crashArtifact(parent)
    await writeFile(join(overBytes.payload, 'large.txt'), '12345')
    await chmod(join(overBytes.payload, 'large.txt'), 0o400)

    const overFiles = await crashArtifact(parent)
    for (const name of ['one', 'two', 'three']) {
      await writeFile(join(overFiles.payload, name), name.slice(0, 1))
      await chmod(join(overFiles.payload, name), 0o400)
    }

    const overEntries = await crashArtifact(parent)
    await Promise.all(['one', 'two', 'three', 'four'].map(
      (name) => mkdir(join(overEntries.payload, name), { mode: 0o500 }),
    ))

    const overDepth = await crashArtifact(parent)
    await mkdir(join(overDepth.payload, 'nested'), { mode: 0o700 })
    await writeFile(join(overDepth.payload, 'nested', 'deep.txt'), 'x')
    await chmod(join(overDepth.payload, 'nested', 'deep.txt'), 0o400)
    await chmod(join(overDepth.payload, 'nested'), 0o500)

    const now = Date.now()
    await Promise.all([
      stale.artifact,
      markerOnly.artifact,
      emptyStale,
      publicMode,
      fakePrefix,
      invalidMarker.artifact,
      special.artifact,
      symlinkArtifact.artifact,
      hardlinkArtifact.artifact,
      overBytes.artifact,
      overFiles.artifact,
      overEntries.artifact,
      overDepth.artifact,
    ].map((path) => makeOld(path, now)))
    context.after(async () => {
      await chmod(join(overDepth.payload, 'nested'), 0o700).catch(() => undefined)
      await rm(parent, { recursive: true, force: true })
    })

    const removed = await cleanupStaleWorkspaceSnapshots({
      stagingParent: parent,
      minimumAgeMs: 30_000,
      now,
      control: control(),
      limits: {
        maxFiles: 2,
        maxEntries: 3,
        maxTotalBytes: 4,
        maxFileBytes: 4,
        maxDepth: 1,
      },
    })
    assert.equal(removed, 3)
    await assert.rejects(stat(stale.artifact), { code: 'ENOENT' })
    await assert.rejects(stat(markerOnly.artifact), { code: 'ENOENT' })
    await assert.rejects(stat(emptyStale), { code: 'ENOENT' })
    for (const path of [
      fresh.artifact,
      publicMode,
      unrelated,
      fakePrefix,
      invalidMarker.artifact,
      special.artifact,
      symlinkArtifact.artifact,
      hardlinkArtifact.artifact,
      overBytes.artifact,
      overFiles.artifact,
      overEntries.artifact,
      overDepth.artifact,
    ]) {
      assert.equal((await stat(path)).isDirectory(), true)
    }
  })

  it('copies from the pinned Linux root after its pathname is replaced', {
    skip: process.platform !== 'linux' && 'final integration requires Linux /proc/self/fd',
  }, async (context) => {
    const parent = await mkdtemp(join(tmpdir(), 'super-agent-workspace-snapshot-linux-'))
    const workspace = join(parent, 'workspace')
    const replacement = join(parent, 'replacement')
    const displaced = join(parent, 'displaced')
    const staging = join(parent, 'staging')
    await Promise.all([mkdir(workspace), mkdir(replacement), mkdir(staging)])
    await writeFile(join(workspace, 'marker.txt'), 'anchored')
    await writeFile(join(replacement, 'marker.txt'), 'replacement')
    context.after(() => rm(parent, { recursive: true, force: true }))

    await withReadOnlyWorkspaceFd(workspace, async (anchor) => {
      await rename(workspace, displaced)
      await rename(replacement, workspace)
      await withWorkspaceSnapshot({
        readPath: anchor.descriptorPath,
        canonicalPath: anchor.canonicalPath,
        expectedIdentity: anchor.identity,
        rootKind: 'linux-proc-fd',
      }, options(staging), async (snapshot) => {
        assert.equal(await readFile(join(snapshot.rootPath, 'marker.txt'), 'utf8'), 'anchored')
        assert.equal(fstatSync(snapshot.descriptor).isDirectory(), true)
      })
    })
    assert.deepEqual(await readdir(staging), [])
  })
})
