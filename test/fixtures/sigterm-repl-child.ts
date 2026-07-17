import type { LanguageModel } from 'ai'
import { constants } from 'node:fs'
import { startRepl } from '../../src/cli/repl.js'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { SessionStore } from '../../src/session/store.js'
import {
  nodeSessionSegmentStorageIo,
  type SessionSegmentFile,
  type SessionSegmentStorageIo,
} from '../../src/session/session-segment-storage.js'

const [directory, mode = 'success'] = process.argv.slice(2)
if (!directory) throw new Error('missing session directory')

const segmentIo: SessionSegmentStorageIo | undefined = mode === 'fail-close'
  ? {
      ...nodeSessionSegmentStorageIo,
      open: async (path, flags, fileMode) => {
        const handle = await nodeSessionSegmentStorageIo.open(path, flags, fileMode)
        if (!path.endsWith('.active.jsonl') ||
            (flags & constants.O_APPEND) === 0 ||
            (flags & constants.O_CREAT) !== 0) return handle
        const wrapped: SessionSegmentFile = {
          fd: handle.fd,
          chmod: (value) => handle.chmod(value),
          truncate: (length) => handle.truncate(length),
          write: (buffer, offset, length) => handle.write(buffer, offset, length),
          stat: () => handle.stat(),
          read: (buffer, offset, length, position) =>
            handle.read(buffer, offset, length, position),
          datasync: async () => {
            throw Object.assign(new Error('injected shutdown datasync failure'), { code: 'EIO' })
          },
          close: () => handle.close(),
        }
        return wrapped
      },
    }
  : undefined

const store = await SessionStore.open('sigterm', {
  directory,
  ...(segmentIo ? { segmentIo } : {}),
})
await store.appendEvent({ type: 'test.buffered-before-sigterm' })
const registry = new ToolRegistry()

if (mode === 'noncooperative-tool') {
  registry.register({
    name: 'hang_forever',
    description: 'ignores cancellation for shutdown testing',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capabilitySet: [],
    isReadOnly: true,
    requiresApproval: false,
    execute: async () => {
      console.log('ACTIVE')
      setInterval(() => undefined, 1_000)
      return await new Promise<never>(() => undefined)
    },
  })
}

if (mode === 'slow-close') {
  registry.register({
    name: 'slow_close',
    description: 'blocks disposal for second-signal testing',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capabilitySet: [],
    isReadOnly: true,
    requiresApproval: false,
    execute: async () => 'ok',
    dispose: async () => {
      console.log('CLOSING')
      setInterval(() => undefined, 1_000)
      await new Promise<never>(() => undefined)
    },
  })
}

const model = mode === 'noncooperative-tool'
  ? {
      specificationVersion: 'v3' as const,
      provider: 'test',
      modelId: 'noncooperative-tool-model',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('doGenerate is not used')
      },
      async doStream() {
        const parts = [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'call-hang',
            toolName: 'hang_forever',
            input: '{}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part)
              controller.close()
            },
          }),
        } as never
      },
    } satisfies LanguageModel
  : {} as LanguageModel

startRepl({
  model,
  registry,
  store,
  state: { messages: [], summary: '', budget: { used: 0, limit: 100 } },
  compaction: {
    tokenThreshold: 100_000,
    keepRecentMessages: 10,
    keepRecentToolMessages: 5,
    asciiCharsPerToken: 4,
    maxSummaryChars: 10_000,
  },
  maxSteps: 1,
  maxRetries: 0,
  modelRequestTimeoutMs: 10_000,
  turnTimeoutMs: 10_000,
  autoApprove: mode === 'noncooperative-tool',
  ...(mode === 'noncooperative-tool' || mode === 'slow-close'
    ? {
        shutdown: {
          activeWaitTimeoutMs: 100,
          registryCloseTimeoutMs: 100,
          storeCloseTimeoutMs: 500,
          closeWaitTimeoutMs: 1_000,
        },
      }
    : {}),
})
console.log('\nREADY')
