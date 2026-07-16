import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
// The production launcher is intentionally shipped as directly executable ESM.
// @ts-expect-error No declaration file is emitted for the deployment script.
import * as launcher from '../scripts/linux-sandbox-launcher.mjs'

const {
  parseLauncherInvocation,
  validateDelegatedRootSnapshot,
  validateLauncherHost,
} = launcher

const CGROUP2_SUPER_MAGIC = 0x63677270

describe('Linux sandbox launcher fail-closed validation', () => {
  it('accepts only a non-root Linux service identity', () => {
    assert.doesNotThrow(() => validateLauncherHost('linux', 1000))
    assert.throws(() => validateLauncherHost('darwin', 501), /Linux/)
    assert.throws(() => validateLauncherHost('linux', 0), /非 root/)
    assert.throws(() => validateLauncherHost('linux', undefined), /非 root/)
  })

  it('requires cgroup v2 with all delegated controllers and exactly the launcher', () => {
    const valid = {
      filesystemType: CGROUP2_SUPER_MAGIC,
      controllersText: 'cpuset cpu io memory pids\n',
      membersText: '4242\n',
      launcherPid: 4242,
    }
    assert.doesNotThrow(() => validateDelegatedRootSnapshot(valid))
    assert.throws(
      () => validateDelegatedRootSnapshot({ ...valid, filesystemType: 0x01021994 }),
      /不是 cgroup v2/,
    )
    for (const controllersText of ['cpu memory', 'memory pids', 'cpu pids']) {
      assert.throws(
        () => validateDelegatedRootSnapshot({ ...valid, controllersText }),
        /未 Delegate/,
      )
    }
    for (const membersText of ['', '7\n4242\n', '7\n']) {
      assert.throws(
        () => validateDelegatedRootSnapshot({ ...valid, membersText }),
        /只包含 launcher/,
      )
    }
    assert.throws(
      () => validateDelegatedRootSnapshot({ ...valid, membersText: 'not-a-pid\n' }),
      /格式非法/,
    )
  })

  it('rejects wrapper tokens and relative commands before touching cgroup state', () => {
    assert.deepEqual(
      parseLauncherInvocation(['node', 'launcher', '--', '/usr/bin/node', 'agent.js']),
      { command: '/usr/bin/node', args: ['agent.js'] },
    )
    assert.throws(
      () => parseLauncherInvocation(['node', 'launcher', '--', 'node']),
      /absolute\/agent-command/,
    )
    assert.throws(
      () => parseLauncherInvocation(['node', 'launcher', '--verbose', '--', '/usr/bin/node']),
      /absolute\/agent-command/,
    )
  })
})

describe('systemd supervisor example', () => {
  it('pins the delegation, descendant cleanup and resource envelope contract', async () => {
    const unit = await readFile(resolve('deploy/super-agent.service.example'), 'utf8')
    for (const directive of [
      'Type=exec',
      'User=super-agent',
      'Group=super-agent',
      'Delegate=cpu memory pids',
      'KillMode=control-group',
      'SendSIGKILL=yes',
      'OOMPolicy=stop',
      'LimitNOFILE=4096',
      'MemorySwapMax=0',
      'Restart=no',
    ]) {
      assert.match(unit, new RegExp(`^${directive}$`, 'm'), directive)
    }
    const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='))
    assert.ok(execStart)
    assert.match(
      execStart,
      /^ExecStart=\/usr\/bin\/node \/opt\/super-agent\/scripts\/linux-sandbox-launcher\.mjs -- \/usr\/bin\/node /,
    )
    assert.doesNotMatch(execStart, /(?:\/bin\/(?:ba)?sh|\bpnpm\b|\bnpm\b)/)
  })
})
