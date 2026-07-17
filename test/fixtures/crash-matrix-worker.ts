import {
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
} from 'node:fs'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { ToolExecutionPipeline } from '../../src/execution/tool-execution-pipeline.js'
import type { RecoveryJournal } from '../../src/execution/recovery-coordinator.js'
import {
  SessionStore,
  type SessionEvent,
  type SessionEventInput,
  type ToolResultCommit,
} from '../../src/session/store.js'
import {
  nodeSessionSegmentStorageIo,
  type SessionSegmentFile,
  type SessionSegmentStorageIo,
} from '../../src/session/session-segment-storage.js'
import {
  isCrashPoint,
  type CrashPoint,
  type CrashPointDetails,
  type CrashProbe,
  type CrashSignal,
} from './crash-matrix-contract.js'

const [pointValue, directory, sessionId, dispatchLog, effectLog] = process.argv.slice(2)
if (!pointValue || !directory || !sessionId || !dispatchLog || !effectLog) {
  throw new Error('缺少 crash matrix worker 参数')
}
if (!isCrashPoint(pointValue)) throw new Error(`未知 crash point: ${pointValue}`)
const selectedPoint: CrashPoint = pointValue

const probe: CrashProbe = {
  hit(point, details) {
    if (point !== selectedPoint) return
    const signal: CrashSignal = { type: 'crash-point', point, details }
    writeSync(1, `${JSON.stringify(signal)}\n`)
    process.kill(process.pid, 'SIGKILL')
    throw new Error(`SIGKILL did not terminate worker at ${point}`)
  },
}

function details(value: Record<string, unknown>): CrashPointDetails {
  return {
    ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
    ...(typeof value.sequence === 'number' ? { sequence: value.sequence } : {}),
  }
}

function durableLog(path: string, value: Record<string, unknown>) {
  const fd = openSync(path, 'a', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function segmentIo(): SessionSegmentStorageIo {
  let pending = Buffer.alloc(0)
  return {
    ...nodeSessionSegmentStorageIo,
    open: async (path, flags, mode) => {
      const handle = await nodeSessionSegmentStorageIo.open(path, flags, mode)
      if (!path.endsWith('.active.jsonl')) return handle
      const wrapped: SessionSegmentFile = {
        fd: handle.fd,
        chmod: (value) => handle.chmod(value),
        truncate: (length) => handle.truncate(length),
        datasync: () => handle.datasync(),
        stat: () => handle.stat(),
        read: (buffer, offset, length, position) =>
          handle.read(buffer, offset, length, position),
        close: () => handle.close(),
        write: async (buffer, offset, length) => {
          const result = await handle.write(buffer, offset, length)
          pending = Buffer.concat([
            pending,
            Buffer.from(buffer.subarray(offset, offset + result.bytesWritten)),
          ])
          while (true) {
            const newline = pending.indexOf(0x0a)
            if (newline < 0) break
            const raw = pending.subarray(0, newline).toString('utf-8')
            pending = pending.subarray(newline + 1)
            const event = JSON.parse(raw) as Record<string, unknown>
            if (event.type === 'operation' && event.status === 'started') {
              probe.hit('after_started_write_before_datasync', details(event))
            }
          }
          return result
        },
      }
      return wrapped
    },
  }
}

function instrumentJournal(store: SessionStore): RecoveryJournal {
  return {
    getSessionId: () => store.getSessionId(),
    replayEvents: () => store.replayEvents(),
    appendEvent: async (input: SessionEventInput, durability) => {
      const candidate = input as Record<string, unknown>
      if (candidate.type === 'operation' && candidate.status === 'proposed') {
        probe.hit('before_proposed_append', details(candidate))
      }
      if (candidate.type === 'operation' && candidate.status === 'started') {
        probe.hit('before_started_write', details(candidate))
      }
      if (candidate.type === 'operation' && candidate.status === 'succeeded') {
        probe.hit('after_result_before_terminal', details(candidate))
      }

      const event: SessionEvent = await store.appendEvent(input, durability)
      if (event.type === 'operation' && event.status === 'proposed') {
        probe.hit('after_proposed_append', details(event))
      }
      if (event.type === 'operation' && event.status === 'approved') {
        probe.hit('after_approved_append', details(event))
      }
      if (event.type === 'operation' && event.status === 'started') {
        probe.hit('after_started_datasync_before_dispatch', details(event))
      }
      if (event.type === 'operation' && event.status === 'succeeded') {
        probe.hit('after_terminal_before_tool_result', details(event))
      }
      return event
    },
    appendToolResult: async (commit: ToolResultCommit, budgetUsed?: number) => {
      const appended = await store.appendToolResult(commit, budgetUsed)
      probe.hit('after_tool_result_before_checkpoint', {
        operationId: commit.operationId,
      })
      return appended
    },
  }
}

const store = await SessionStore.open(sessionId, {
  directory,
  segmentTargetBytes: 256,
  segmentIo: segmentIo(),
})
await store.appendEvent({
  type: 'messages',
  messages: [{
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: 'crash-call',
      toolName: 'durable_effect_probe',
      input: { value: 'effect-once' },
    }],
  }],
}, 'durable')
await store.appendEvent({ type: 'test.rotation-anchor' }, 'durable')
const journal = instrumentJournal(store)
const registry = new ToolRegistry()
registry.register({
  name: 'durable_effect_probe',
  description: 'Crash matrix durable effect probe',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  capabilitySet: ['external.write'],
  isConcurrencySafe: false,
  isReadOnly: false,
  requiresApproval: true,
  execute: async ({ value }) => {
    const operationId = (await journal.replayEvents())
      .find((event) => event.type === 'operation' && event.status === 'started')
      ?.operationId
    const operationDetails = typeof operationId === 'string' ? { operationId } : {}
    durableLog(dispatchLog, { ...operationDetails, value })
    probe.hit('after_dispatch_before_effect', operationDetails)
    durableLog(effectLog, { ...operationDetails, value })
    probe.hit('after_effect_before_result', operationDetails)
    return { ok: true, value }
  },
})

const pipeline = new ToolExecutionPipeline(registry, journal)
await pipeline.executeBatch({
  sessionId,
  turnId: 'crash-turn',
  stepId: 'crash-step',
  requestId: 'crash-request',
  signal: new AbortController().signal,
  deadline: Date.now() + 60_000,
}, [{
  toolCallId: 'crash-call',
  toolName: 'durable_effect_probe',
  input: { value: 'effect-once' },
}], {
  approve: async () => true,
})

// The last crash point is inside appendToolResult. Reaching this checkpoint
// therefore means the worker unexpectedly passed its requested crash point.
await store.appendCheckpoint({ messages: [], summary: 'unexpected', budgetUsed: 0 })
throw new Error(`worker passed crash point without stopping: ${selectedPoint}`)
