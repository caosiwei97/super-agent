#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  mkdir,
  readFile,
  realpath,
  rmdir,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CGROUP2_SUPER_MAGIC = 0x63677270
const REQUIRED_CONTROLLERS = ['cpu', 'memory', 'pids']
const RUNTIME_LEAF = 'super-agent-runtime'

function fail(message) {
  throw new Error(`linux sandbox launcher: ${message}`)
}

function parsePids(value) {
  const trimmed = value.trim()
  if (!trimmed) return []
  return trimmed.split(/\s+/).map((entry) => {
    if (!/^\d+$/.test(entry)) fail('cgroup.procs 格式非法')
    const pid = Number(entry)
    if (!Number.isSafeInteger(pid) || pid <= 0) fail('cgroup.procs PID 非法')
    return pid
  })
}

/** Pure validation boundary used by host-side fail-closed tests. */
export function validateLauncherHost(platform, uid) {
  if (platform !== 'linux') fail('必须由 systemd 在 Linux 上直接启动')
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    fail('必须由 systemd 以非 root 服务用户直接启动')
  }
}

/** Pure validation boundary for the cgroup-v2 delegation snapshot. */
export function validateDelegatedRootSnapshot({
  filesystemType,
  controllersText,
  membersText,
  launcherPid,
}) {
  if (Number(filesystemType) !== CGROUP2_SUPER_MAGIC) fail('服务 root 不是 cgroup v2')
  const controllers = new Set(controllersText.trim().split(/\s+/).filter(Boolean))
  if (REQUIRED_CONTROLLERS.some((controller) => !controllers.has(controller))) {
    fail('systemd 未 Delegate cpu/memory/pids controller')
  }
  if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0) fail('launcher PID 非法')
  const members = parsePids(membersText)
  if (members.length !== 1 || members[0] !== launcherPid) {
    fail('服务 root 必须只包含 launcher；ExecStart 不得经过 shell/pnpm')
  }
}

/** Accept only the documented argv-only invocation; tokens before `--` are rejected. */
export function parseLauncherInvocation(argv) {
  if (argv.length < 4 || argv[2] !== '--' || !isAbsolute(argv[3])) {
    fail('用法: linux-sandbox-launcher.mjs -- /absolute/agent-command [args...]')
  }
  return Object.freeze({ command: argv[3], args: argv.slice(4) })
}

async function delegatedServiceRoot() {
  validateLauncherHost(process.platform, process.getuid?.())
  const membership = (await readFile('/proc/self/cgroup', 'utf8'))
    .split('\n')
    .find((line) => line.startsWith('0::'))
  if (!membership) fail('缺少 unified cgroup v2 membership')
  const relative = membership.slice(3)
  const root = await realpath(join('/sys/fs/cgroup', relative.replace(/^\//, '')))
  validateDelegatedRootSnapshot({
    filesystemType: (await statfs(root)).type,
    controllersText: await readFile(join(root, 'cgroup.controllers'), 'utf8'),
    membersText: await readFile(join(root, 'cgroup.procs'), 'utf8'),
    launcherPid: process.pid,
  })
  return root
}

async function enterRuntimeLeaf(root) {
  const leaf = join(root, RUNTIME_LEAF)
  try {
    await mkdir(leaf, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (parsePids(await readFile(join(leaf, 'cgroup.procs'), 'utf8')).length > 0) {
      fail('旧 runtime leaf 仍 populated；supervisor 回收契约失效')
    }
    await rmdir(leaf)
    await mkdir(leaf, { mode: 0o700 })
  }
  await writeFile(join(leaf, 'cgroup.procs'), String(process.pid), 'utf8')
  if (parsePids(await readFile(join(root, 'cgroup.procs'), 'utf8')).length !== 0) {
    fail('移动 launcher 后 delegated root 仍有 task')
  }
  if (!parsePids(await readFile(join(leaf, 'cgroup.procs'), 'utf8')).includes(process.pid)) {
    fail('launcher runtime membership 回读失败')
  }
}

async function run() {
  const { command, args } = parseLauncherInvocation(process.argv)
  const root = await delegatedServiceRoot()
  await enterRuntimeLeaf(root)
  const child = spawn(command, args, {
    env: {
      ...process.env,
      SUPER_AGENT_SANDBOX_CGROUP_ROOT: root,
      SUPER_AGENT_SANDBOX_CRASH_SUPERVISOR: 'systemd-control-group-v1',
    },
    stdio: 'inherit',
    shell: false,
  })

  const signalHandlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      try { child.kill(signal) } catch {}
    }
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }

  let outcome
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  }
  if (outcome.signal) {
    process.kill(process.pid, outcome.signal)
  } else {
    process.exitCode = outcome.code ?? 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (import.meta.url === invokedPath) await run()
