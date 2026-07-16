import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { executeProcess } from '../src/execution/process-executor.js'

const directory = resolve('sandbox/seccomp')

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex')
}

describe('versioned seccomp artifacts', () => {
  it('regenerates deterministically without drift', async () => {
    const result = await executeProcess({
      command: process.execPath,
      args: [join(directory, 'build-profile.mjs'), '--check'],
      cwd: resolve('.'),
      env: { PATH: process.env.PATH, LANG: 'C' },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    })
    assert.equal(result.terminationReason, 'exited', result.stderr)
    assert.equal(result.exitCode, 0, result.stderr)
  })

  it('binds every source and architecture artifact to the manifest', async () => {
    const artifacts = join(directory, 'artifacts')
    const manifest = JSON.parse(await readFile(join(artifacts, 'manifest-v1.json'), 'utf8')) as {
      releaseStatus: string
      sourceSha256: Record<string, string>
      targets: Array<{
        architecture: string
        artifact: string
        sha256: string
        bytes: number
        instructions: number
        allowedSyscalls: string[]
      }>
      mustDenyProbes: string[]
    }
    assert.equal(manifest.releaseStatus, 'candidate-linux-release-gate-required')
    for (const [name, expected] of Object.entries(manifest.sourceSha256)) {
      assert.equal(sha256(await readFile(join(directory, name))), expected, name)
    }
    assert.deepEqual(
      manifest.targets.map((target) => target.architecture).sort(),
      ['aarch64', 'x86_64'],
    )
    const deniedSyscalls = new Set(manifest.mustDenyProbes.map((probe) => {
      if (probe.startsWith('socket-')) return 'socket'
      return probe
    }))
    for (const target of manifest.targets) {
      const bytes = await readFile(join(artifacts, target.artifact))
      assert.equal(bytes.byteLength, target.bytes, target.artifact)
      assert.equal(bytes.byteLength, target.instructions * 8, target.artifact)
      assert.equal(sha256(bytes), target.sha256, target.artifact)
      for (const denied of deniedSyscalls) {
        assert.equal(target.allowedSyscalls.includes(denied), false, `${target.architecture}:${denied}`)
      }
      const digestFile = await readFile(join(artifacts, `${target.artifact}.sha256`), 'utf8')
      assert.equal(digestFile, `${target.sha256}  ${target.artifact}\n`)
    }
  })
})
