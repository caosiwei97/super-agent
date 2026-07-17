import { isAbsolute, resolve } from 'node:path'
import type { ExecutionProfile } from '../execution/executor.js'

export type { ExecutionProfile } from '../execution/executor.js'

function executionProfile(env: NodeJS.ProcessEnv): ExecutionProfile {
  const raw = env.SUPER_AGENT_EXECUTION_PROFILE || 'development'
  if (raw !== 'development' && raw !== 'production') {
    throw new Error(
      `SUPER_AGENT_EXECUTION_PROFILE 必须是 development 或 production，当前值: ${raw}`,
    )
  }
  return raw
}

function optionalAbsolutePath(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  if (!isAbsolute(raw)) throw new Error(`${name} 必须是绝对路径，当前值: ${raw}`)
  return resolve(raw)
}

function optionalSha256(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  if (!/^[a-f0-9]{64}$/.test(raw)) {
    throw new Error(`${name} 必须是 64 位小写十六进制 SHA-256`)
  }
  return raw
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，当前值: ${raw}`)
  }
  return value
}

function optionalPositiveInteger(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，当前值: ${raw}`)
  }
  return value
}

function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数，当前值: ${raw}`)
  }
  return value
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正数，当前值: ${raw}`)
  }
  return value
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false
  throw new Error(`${name} 必须是 true/false 或 1/0，当前值: ${raw}`)
}

function crashSupervisorMode(env: NodeJS.ProcessEnv):
  | 'systemd-control-group-v1'
  | 'container-control-group-v1'
  | undefined {
  const value = env.SUPER_AGENT_SANDBOX_CRASH_SUPERVISOR
  if (value === undefined || value.trim() === '') return undefined
  if (value === 'systemd-control-group-v1' || value === 'container-control-group-v1') return value
  throw new Error(
    'SUPER_AGENT_SANDBOX_CRASH_SUPERVISOR 必须是 systemd-control-group-v1 或 container-control-group-v1',
  )
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const profile = executionProfile(env)
  const sessionMaxRecordBytes = optionalPositiveInteger(
    env,
    'SUPER_AGENT_SESSION_MAX_RECORD_BYTES',
  )
  const sessionMaxReadRecordBytes = optionalPositiveInteger(
    env,
    'SUPER_AGENT_SESSION_MAX_READ_RECORD_BYTES',
  )
  const sessionSegmentTargetBytes = optionalPositiveInteger(
    env,
    'SUPER_AGENT_SESSION_SEGMENT_TARGET_BYTES',
  )
  const sessionRegularQuotaBytes = optionalPositiveInteger(
    env,
    'SUPER_AGENT_SESSION_REGULAR_QUOTA_BYTES',
  )
  const sessionCriticalReserveBytes = optionalPositiveInteger(
    env,
    'SUPER_AGENT_SESSION_CRITICAL_RESERVE_BYTES',
  )
  return {
    model: {
      baseURL: env.MODEL_BASE_URL || 'https://api.deepseek.com',
      apiKey: env.OPENAI_API_KEY,
      modelId: env.MODEL_ID || 'deepseek-v4-flash',
    },
    agent: {
      budgetLimit: positiveInteger(env, 'TOKEN_BUDGET', 1_000_000),
      maxSteps: positiveInteger(env, 'AGENT_MAX_STEPS', 15),
      maxRetries: nonNegativeInteger(env, 'AGENT_MAX_RETRIES', 10),
      turnTimeoutMs: positiveInteger(env, 'AGENT_TURN_TIMEOUT_MS', 120_000),
      modelRequestTimeoutMs: positiveInteger(env, 'MODEL_REQUEST_TIMEOUT_MS', 60_000),
    },
    compaction: {
      tokenThreshold: positiveInteger(env, 'CONTEXT_TOKEN_THRESHOLD', 12_000),
      keepRecentMessages: positiveInteger(env, 'CONTEXT_KEEP_RECENT_MESSAGES', 8),
      keepRecentToolMessages: nonNegativeInteger(env, 'CONTEXT_KEEP_RECENT_TOOL_MESSAGES', 4),
      asciiCharsPerToken: positiveNumber(env, 'CONTEXT_ASCII_CHARS_PER_TOKEN', 4),
      maxSummaryChars: positiveInteger(env, 'CONTEXT_MAX_SUMMARY_CHARS', 1_200),
    },
    workspaceRoot: resolve(env.SUPER_AGENT_WORKSPACE || process.cwd()),
    autoApprove: booleanValue(env, 'SUPER_AGENT_AUTO_APPROVE', false),
    sessionStorage: {
      ...(sessionMaxRecordBytes === undefined
        ? {} : { maxRecordBytes: sessionMaxRecordBytes }),
      ...(sessionMaxReadRecordBytes === undefined
        ? {} : { maxReadRecordBytes: sessionMaxReadRecordBytes }),
      ...(sessionSegmentTargetBytes === undefined
        ? {} : { segmentTargetBytes: sessionSegmentTargetBytes }),
      ...(sessionRegularQuotaBytes === undefined
        ? {} : { regularQuotaBytes: sessionRegularQuotaBytes }),
      ...(sessionCriticalReserveBytes === undefined
        ? {} : { criticalReserveBytes: sessionCriticalReserveBytes }),
    },
    execution: {
      profile,
      sandbox: {
        bwrapPath: optionalAbsolutePath(env, 'SUPER_AGENT_BWRAP_PATH') || '/usr/bin/bwrap',
        mkfifoPath: optionalAbsolutePath(env, 'SUPER_AGENT_MKFIFO_PATH') || '/usr/bin/mkfifo',
        rootfsPath: optionalAbsolutePath(env, 'SUPER_AGENT_SANDBOX_ROOTFS'),
        seccompProfilePath: optionalAbsolutePath(env, 'SUPER_AGENT_SANDBOX_SECCOMP_PROFILE'),
        seccompProfileSha256: optionalSha256(env, 'SUPER_AGENT_SANDBOX_SECCOMP_SHA256'),
        cgroupRoot: optionalAbsolutePath(env, 'SUPER_AGENT_SANDBOX_CGROUP_ROOT'),
        crashSupervisorMode: crashSupervisorMode(env),
        maxCgroupMemoryBytes: positiveInteger(
          env,
          'SUPER_AGENT_SANDBOX_MAX_MEMORY_BYTES',
          1024 * 1024 * 1024,
        ),
        maxCgroupSwapBytes: nonNegativeInteger(
          env,
          'SUPER_AGENT_SANDBOX_MAX_SWAP_BYTES',
          0,
        ),
        maxCgroupPids: positiveInteger(env, 'SUPER_AGENT_SANDBOX_MAX_PIDS', 64),
        maxCgroupCpuMicrosPerSecond: positiveInteger(
          env,
          'SUPER_AGENT_SANDBOX_MAX_CPU_MICROS_PER_SECOND',
          1_000_000,
        ),
        maxOpenFiles: positiveInteger(
          env,
          'SUPER_AGENT_SANDBOX_MAX_OPEN_FILES',
          4_096,
        ),
        snapshotStagingParent: optionalAbsolutePath(
          env,
          'SUPER_AGENT_SANDBOX_STAGING_PARENT',
        ),
        snapshotMaxFiles: positiveInteger(
          env,
          'SUPER_AGENT_SANDBOX_SNAPSHOT_MAX_FILES',
          10_000,
        ),
        snapshotMaxEntries: positiveInteger(
          env,
          'SUPER_AGENT_SANDBOX_SNAPSHOT_MAX_ENTRIES',
          20_000,
        ),
        snapshotMaxTotalBytes: positiveInteger(
          env,
          'SUPER_AGENT_SANDBOX_SNAPSHOT_MAX_TOTAL_BYTES',
          256 * 1024 * 1024,
        ),
        snapshotMaxFileBytes: positiveInteger(
          env,
          'SUPER_AGENT_SANDBOX_SNAPSHOT_MAX_FILE_BYTES',
          16 * 1024 * 1024,
        ),
        snapshotMaxDepth: nonNegativeInteger(
          env,
          'SUPER_AGENT_SANDBOX_SNAPSHOT_MAX_DEPTH',
          64,
        ),
      },
    },
    githubMcp: {
      token: env.GITHUB_PERSONAL_ACCESS_TOKEN,
    },
  }
}
