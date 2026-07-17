import type { LanguageModel } from 'ai'
import { constants } from 'node:fs'
import { runOnce } from '../../src/cli/repl.js'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { SessionStore } from '../../src/session/store.js'
import {
  nodeSessionSegmentStorageIo,
  type SessionSegmentFile,
  type SessionSegmentStorageIo,
} from '../../src/session/session-segment-storage.js'

const [directory, mode = 'cooperative'] = process.argv.slice(2)
if (!directory) throw new Error('missing session directory')

const model = {
  specificationVersion: 'v3',
  provider: 'test',
  modelId: 'sigterm-blocking-model',
  supportedUrls: {},
  async doGenerate() {
    throw new Error('doGenerate is not used')
  },
  async doStream(options: { abortSignal?: AbortSignal }) {
    if (mode === 'noncooperative') {
      console.log('ACTIVE')
      setInterval(() => undefined, 1_000)
      return await new Promise<never>(() => undefined)
    }
    return {
      stream: new ReadableStream({
        start(controller) {
          const abort = () => controller.error(
            options.abortSignal?.reason ?? new DOMException('aborted', 'AbortError'),
          )
          if (options.abortSignal?.aborted) abort()
          else options.abortSignal?.addEventListener('abort', abort, { once: true })
          console.log('ACTIVE')
        },
      }),
    } as never
  },
} satisfies LanguageModel

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
            throw Object.assign(new Error('injected one-shot shutdown datasync failure'), {
              code: 'EIO',
            })
          },
          close: () => handle.close(),
        }
        return wrapped
      },
    }
  : undefined

const store = await SessionStore.open('sigterm-run', {
  directory,
  ...(segmentIo ? { segmentIo } : {}),
})
const registry = new ToolRegistry()
await runOnce({
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
  modelRequestTimeoutMs: 60_000,
  turnTimeoutMs: 60_000,
  autoApprove: false,
  ...(mode === 'noncooperative'
    ? {
        shutdown: {
          activeWaitTimeoutMs: 100,
          registryCloseTimeoutMs: 100,
          storeCloseTimeoutMs: 500,
          closeWaitTimeoutMs: 1_000,
        },
      }
    : {}),
}, 'wait for SIGTERM')
console.log('DONE')
