import assert from 'node:assert/strict'
import { basename, dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  LinuxCgroupLifecycleError,
  LinuxCgroupManager,
  LinuxCgroupSafetyError,
  LinuxCgroupUnavailableError,
  type LinuxCgroupFileSystem,
  type LinuxCgroupLimits,
} from '../src/execution/linux-cgroup.js'

const CGROUP2_SUPER_MAGIC = 0x63677270
const ROOT = '/sys/fs/cgroup/super-agent'
const LIMITS: LinuxCgroupLimits = Object.freeze({
  maxMemoryBytes: 512 * 1024 * 1024,
  maxSwapBytes: 0,
  maxPids: 64,
  maxCpuMicrosPerSecond: 500_000,
})

interface FakeNode {
  kind: 'directory' | 'file'
  value: string
  identity: string
}

function errno(code: string) {
  return Object.assign(new Error(code), { code })
}

class FakeCgroupFileSystem implements LinuxCgroupFileSystem {
  readonly writes: Array<{ path: string, value: string }> = []
  readonly removed: string[] = []
  onWrite?: (path: string, value: string) => void
  statType = CGROUP2_SUPER_MAGIC
  killClears = true
  attachExtraPid?: number
  private readonly nodes = new Map<string, FakeNode>()
  private nextIdentity = 1
  private nextRandomId = 1
  private clock = 0

  constructor() {
    this.addDirectory(ROOT)
    this.addFile('cgroup.type', 'domain\n')
    this.addFile('cgroup.procs', '')
    this.addFile('cgroup.controllers', 'cpu memory pids\n')
    this.addFile('cgroup.subtree_control', '')
    this.addFile('memory.max', 'max\n')
    this.addFile('memory.swap.max', 'max\n')
    this.addFile('pids.max', 'max\n')
    this.addFile('cpu.max', 'max 100000\n')
  }

  async realpath(path: string) {
    const node = this.require(path)
    if (node.kind !== 'directory') throw errno('ENOTDIR')
    return path
  }

  async identity(path: string) {
    const node = this.require(path)
    if (node.kind !== 'directory') throw errno('ENOTDIR')
    return node.identity
  }

  async statFsType(path: string) {
    this.require(path)
    return this.statType
  }

  async read(path: string) {
    const node = this.require(path)
    if (node.kind !== 'file') throw errno('EISDIR')
    return node.value
  }

  async write(path: string, value: string) {
    const node = this.require(path)
    if (node.kind !== 'file') throw errno('EISDIR')
    this.writes.push({ path, value })
    this.onWrite?.(path, value)
    if (path === join(ROOT, 'cgroup.subtree_control')) {
      node.value = value.split(/\s+/).map((entry) => entry.replace(/^\+/, '')).join(' ')
      return
    }
    if (basename(path) === 'cgroup.procs') {
      node.value = this.attachExtraPid === undefined
        ? `${value}\n`
        : `${value}\n${this.attachExtraPid}\n`
      this.require(join(dirname(path), 'cgroup.events')).value = 'populated 1\nfrozen 0\n'
      return
    }
    if (basename(path) === 'cgroup.kill') {
      if (this.killClears) this.setMembers(dirname(path), [])
      return
    }
    node.value = `${value}\n`
  }

  async mkdir(path: string) {
    if (this.nodes.has(path)) throw errno('EEXIST')
    if (dirname(path) !== ROOT) throw errno('EPERM')
    this.addDirectory(path)
    for (const [file, value] of Object.entries({
      'cgroup.max.depth': 'max\n',
      'cgroup.max.descendants': 'max\n',
      'memory.max': 'max\n',
      'memory.swap.max': 'max\n',
      'memory.oom.group': '0\n',
      'pids.max': 'max\n',
      'cpu.max': 'max 100000\n',
      'cgroup.procs': '',
      'cgroup.events': 'populated 0\nfrozen 0\n',
      'cgroup.kill': '',
    })) this.addFile(file, value, path)
  }

  async list(path: string) {
    this.require(path)
    return [...this.nodes.entries()]
      .filter(([candidate, node]) => dirname(candidate) === path && node.kind === 'directory')
      .map(([candidate]) => basename(candidate))
  }

  async rmdir(path: string) {
    this.require(path)
    if ((await this.read(join(path, 'cgroup.procs'))).trim()) throw errno('EBUSY')
    for (const key of [...this.nodes.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key)
    }
    this.removed.push(path)
  }

  randomId() {
    return (this.nextRandomId++).toString(16).padStart(32, '0')
  }

  now() {
    return this.clock
  }

  async sleep(milliseconds: number) {
    this.clock += milliseconds
  }

  setRootFile(file: string, value: string) {
    this.require(join(ROOT, file)).value = value
  }

  setMembers(path: string, pids: readonly number[]) {
    this.require(join(path, 'cgroup.procs')).value = pids.length > 0 ? `${pids.join('\n')}\n` : ''
    this.require(join(path, 'cgroup.events')).value = pids.length > 0
      ? 'populated 1\nfrozen 0\n'
      : 'populated 0\nfrozen 0\n'
  }

  replaceIdentity(path: string) {
    this.require(path).identity = `replaced-${this.nextIdentity++}`
  }

  value(path: string) {
    return this.require(path).value.trim()
  }

  has(path: string) {
    return this.nodes.has(path)
  }

  private addDirectory(path: string) {
    this.nodes.set(path, {
      kind: 'directory',
      value: '',
      identity: `directory-${this.nextIdentity++}`,
    })
  }

  private addFile(file: string, value: string, parent = ROOT) {
    this.nodes.set(join(parent, file), {
      kind: 'file',
      value,
      identity: `file-${this.nextIdentity++}`,
    })
  }

  private require(path: string) {
    const node = this.nodes.get(path)
    if (!node) throw errno('ENOENT')
    return node
  }
}

async function createManager(fileSystem = new FakeCgroupFileSystem()) {
  const manager = await LinuxCgroupManager.initialize({
    root: ROOT,
    limits: LIMITS,
    platform: 'linux',
    fileSystem,
    cleanupTimeoutMs: 30,
    cleanupPollMs: 10,
  })
  return { manager, fileSystem }
}

describe('per-operation Linux cgroup v2', () => {
  it('validates delegation and configures every operation limit before use', async () => {
    const { manager, fileSystem } = await createManager()
    assert.deepEqual(fileSystem.writes[0], {
      path: join(ROOT, 'cgroup.subtree_control'),
      value: '+cpu +memory +pids',
    })

    const group = await manager.createOperation(
      'session:attempt-1',
      new AbortController().signal,
    )
    assert.match(basename(group.path), /^super-agent-op-[a-f0-9]{16}-[a-f0-9]{32}$/)
    assert.equal(group.path.includes('session:attempt-1'), false)
    assert.equal(fileSystem.value(join(group.path, 'cgroup.max.depth')), '0')
    assert.equal(fileSystem.value(join(group.path, 'cgroup.max.descendants')), '0')
    assert.equal(fileSystem.value(join(group.path, 'memory.max')), String(LIMITS.maxMemoryBytes))
    assert.equal(fileSystem.value(join(group.path, 'memory.swap.max')), '0')
    assert.equal(fileSystem.value(join(group.path, 'memory.oom.group')), '1')
    assert.equal(fileSystem.value(join(group.path, 'pids.max')), '64')
    assert.equal(fileSystem.value(join(group.path, 'cpu.max')), '500000 1000000')

    const firstCleanup = group.cleanup()
    const secondCleanup = group.cleanup()
    assert.equal(firstCleanup, secondCleanup)
    await firstCleanup
    await group.cleanup()
    assert.equal(fileSystem.has(group.path), false)
  })

  it('fails closed for unsupported hierarchy, controllers, root members and parent limits', async () => {
    const wrongFileSystem = new FakeCgroupFileSystem()
    wrongFileSystem.statType = 0x1234
    await assert.rejects(createManager(wrongFileSystem), (error) => {
      return error instanceof LinuxCgroupUnavailableError && error.reasonCode === 'not_cgroup_v2'
    })

    const missingController = new FakeCgroupFileSystem()
    missingController.setRootFile('cgroup.controllers', 'cpu memory\n')
    await assert.rejects(createManager(missingController), (error) => {
      return error instanceof LinuxCgroupUnavailableError
        && error.reasonCode === 'controllers_unavailable'
    })

    const occupiedRoot = new FakeCgroupFileSystem()
    occupiedRoot.setRootFile('cgroup.procs', `${process.pid}\n`)
    await assert.rejects(createManager(occupiedRoot), (error) => {
      return error instanceof LinuxCgroupUnavailableError
        && error.reasonCode === 'delegation_root_has_processes'
    })

    const smallerParent = new FakeCgroupFileSystem()
    smallerParent.setRootFile('memory.max', '1024\n')
    await assert.rejects(createManager(smallerParent), (error) => {
      return error instanceof LinuxCgroupUnavailableError
        && error.reasonCode === 'limits_exceed_delegation'
    })

    await assert.rejects(LinuxCgroupManager.initialize({
      root: ROOT,
      limits: LIMITS,
      platform: 'darwin',
      fileSystem: new FakeCgroupFileSystem(),
    }), (error) => {
      return error instanceof LinuxCgroupUnavailableError
        && error.reasonCode === 'platform_unsupported'
    })
  })

  it('reaps only empty stale operation scopes and fails closed for populated or malformed ones', async () => {
    const staleName = `super-agent-op-${'a'.repeat(16)}-${'b'.repeat(32)}`
    const empty = new FakeCgroupFileSystem()
    const emptyPath = join(ROOT, staleName)
    await empty.mkdir(emptyPath)
    const { manager } = await createManager(empty)
    assert.equal(empty.has(emptyPath), false)
    await manager.close()

    const populated = new FakeCgroupFileSystem()
    const populatedPath = join(ROOT, staleName)
    await populated.mkdir(populatedPath)
    populated.setMembers(populatedPath, [424_242])
    await assert.rejects(createManager(populated), (error) => {
      return error instanceof LinuxCgroupUnavailableError
        && error.reasonCode === 'stale_operation_populated'
    })
    assert.equal(populated.has(populatedPath), true)

    const malformed = new FakeCgroupFileSystem()
    await malformed.mkdir(join(ROOT, 'super-agent-op-malformed'))
    await assert.rejects(createManager(malformed), (error) => {
      return error instanceof LinuxCgroupUnavailableError
        && error.reasonCode === 'stale_operation_name_invalid'
    })
  })

  it('rejects operation IDs that could influence a cgroup path', async () => {
    const { manager } = await createManager()
    for (const operationId of ['', '../escape', 'nested/path', 'white space', `x${'a'.repeat(128)}`]) {
      await assert.rejects(
        manager.createOperation(operationId, new AbortController().signal),
        TypeError,
      )
    }
    await manager.close()
  })

  it('attaches and confirms the fd5 child PID before the caller releases fd6', async () => {
    const { manager, fileSystem } = await createManager()
    const group = await manager.createOperation('blocked-bwrap', new AbortController().signal)
    const events: string[] = ['info-fd:424242', 'block-fd:held']
    fileSystem.onWrite = (path) => {
      if (path === join(group.path, 'cgroup.procs')) events.push('cgroup:attached')
    }
    const controller = new AbortController()

    await group.attachAndVerify(424_242, controller.signal)
    events.push('block-fd:released')
    assert.deepEqual(events, [
      'info-fd:424242',
      'block-fd:held',
      'cgroup:attached',
      'block-fd:released',
    ])
    assert.equal(fileSystem.value(join(group.path, 'cgroup.procs')), '424242')

    controller.abort(new DOMException('cancel sandbox', 'AbortError'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fileSystem.value(join(group.path, 'cgroup.procs')), '')
    assert.equal(fileSystem.writes.some((write) => {
      return write.path === join(group.path, 'cgroup.kill') && write.value === '1'
    }), true)
    await group.cleanup()
  })

  it('does not represent an already-aborted attach as safe', async () => {
    const { manager, fileSystem } = await createManager()
    const group = await manager.createOperation('cancelled-attach', new AbortController().signal)
    const controller = new AbortController()
    controller.abort(new DOMException('cancel before attach', 'AbortError'))
    await assert.rejects(group.attachAndVerify(424_243, controller.signal), { name: 'AbortError' })
    assert.equal(fileSystem.value(join(group.path, 'cgroup.procs')), '')
    await group.cleanup()
  })

  it('rejects an operation cgroup containing any unexpected member', async () => {
    const { manager, fileSystem } = await createManager()
    const group = await manager.createOperation('unexpected-member', new AbortController().signal)
    fileSystem.attachExtraPid = 525_252
    await assert.rejects(
      group.attachAndVerify(424_252, new AbortController().signal),
      (error) => error instanceof LinuxCgroupLifecycleError
        && error.reasonCode === 'attach_membership_unconfirmed',
    )
    assert.equal(fileSystem.value(join(group.path, 'cgroup.procs')), '')
    await group.cleanup()
  })

  it('kills and removes the exact child scope after callback failure', async () => {
    const { manager, fileSystem } = await createManager()
    const expected = new Error('sandbox failed')
    let operationPath = ''
    await assert.rejects(manager.withOperation(
      'failing-operation',
      new AbortController().signal,
      async (group) => {
        operationPath = group.path
        await group.attachAndVerify(424_244, new AbortController().signal)
        throw expected
      },
    ), (error) => error === expected)
    assert.equal(fileSystem.has(operationPath), false)
    assert.equal(fileSystem.removed.includes(operationPath), true)
  })

  it('never attaches or kills the Agent, init, or the Agent parent', async () => {
    const { manager, fileSystem } = await createManager()
    const group = await manager.createOperation('parent-protection', new AbortController().signal)
    for (const pid of [1, process.pid, process.ppid]) {
      await assert.rejects(
        group.attachAndVerify(pid, new AbortController().signal),
        LinuxCgroupSafetyError,
      )
    }

    fileSystem.setMembers(group.path, [process.pid])
    const killWritesBefore = fileSystem.writes.filter((write) => {
      return write.path === join(group.path, 'cgroup.kill')
    }).length
    await assert.rejects(group.kill(), LinuxCgroupSafetyError)
    const killWritesAfter = fileSystem.writes.filter((write) => {
      return write.path === join(group.path, 'cgroup.kill')
    }).length
    assert.equal(killWritesAfter, killWritesBefore)
    fileSystem.setMembers(group.path, [])
    await group.cleanup()
  })

  it('refuses destructive actions after the owned cgroup identity changes', async () => {
    const { manager, fileSystem } = await createManager()
    const group = await manager.createOperation('identity-change', new AbortController().signal)
    fileSystem.replaceIdentity(group.path)
    await assert.rejects(group.kill(), LinuxCgroupSafetyError)
  })

  it('times out without recursive deletion and permits a later idempotent cleanup retry', async () => {
    const { manager, fileSystem } = await createManager()
    const group = await manager.createOperation('cleanup-timeout', new AbortController().signal)
    await group.attachAndVerify(424_245, new AbortController().signal)
    fileSystem.killClears = false
    await assert.rejects(group.cleanup(), (error) => {
      return error instanceof LinuxCgroupLifecycleError && error.reasonCode === 'cleanup_timeout'
    })
    assert.equal(fileSystem.has(group.path), true)
    fileSystem.killClears = true
    await group.cleanup()
    assert.equal(fileSystem.has(group.path), false)
  })

  it('manager close drains every active operation scope', async () => {
    const { manager, fileSystem } = await createManager()
    const first = await manager.createOperation('close-first', new AbortController().signal)
    const second = await manager.createOperation('close-second', new AbortController().signal)
    await first.attachAndVerify(424_246, new AbortController().signal)
    await second.attachAndVerify(424_247, new AbortController().signal)
    await manager.close()
    assert.equal(fileSystem.has(first.path), false)
    assert.equal(fileSystem.has(second.path), false)
    await assert.rejects(
      manager.createOperation('after-close', new AbortController().signal),
      (error) => error instanceof LinuxCgroupLifecycleError && error.reasonCode === 'manager_closed',
    )
  })
})
