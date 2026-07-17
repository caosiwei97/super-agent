import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import type { ModelMessage } from 'ai'
import {
  ConversationRunner,
  type CompactionPhase,
  type ConversationState,
} from '../src/agent/conversation-runner.js'
import type { AgentLoopOptions } from '../src/agent/agent-loop.js'
import type { ContextCompactionResult } from '../src/context/compressor.js'
import { ToolRegistry } from '../src/core/tool-registry.js'
import { SessionStore } from '../src/session/store.js'
import { summaryModel } from './helpers.js'
import { readSessionEventBytes } from './session-storage-helpers.js'

const COMPACTION = {
  tokenThreshold: 300,
  keepRecentMessages: 2,
  keepRecentToolMessages: 1,
  asciiCharsPerToken: 4,
  maxSummaryChars: 500,
}

function olderTurns() {
  return [
    { role: 'user', content: `old-u1-${'a'.repeat(190)}` },
    { role: 'assistant', content: `old-a1-${'b'.repeat(190)}` },
    { role: 'user', content: `old-u2-${'c'.repeat(190)}` },
    { role: 'assistant', content: `old-a2-${'d'.repeat(190)}` },
  ] satisfies ModelMessage[]
}

async function createStore(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'super-agent-runner-'))
  const store = new SessionStore('runner', { directory })
  context.after(async () => {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, store }
}

async function commitAssistant(options: AgentLoopOptions, content: string, tokenCost: number) {
  const message: ModelMessage = { role: 'assistant', content }
  options.budget.used += tokenCost
  await options.onMessages?.([message])
  options.messages.push(message)
}

describe('ConversationRunner', () => {
  it('rejects an already-aborted turn before persisting the user message', async (context) => {
    const { store } = await createStore(context)
    const state: ConversationState = {
      messages: [],
      summary: '',
      budget: { used: 0, limit: 1_000 },
    }
    const runner = new ConversationRunner({
      model: summaryModel('unused'),
      registry: new ToolRegistry(),
      store,
      state,
      compaction: { ...COMPACTION, tokenThreshold: 10_000 },
      runAgentLoop: async () => {
        throw new Error('must not run')
      },
    })
    const controller = new AbortController()
    controller.abort(new DOMException('cancel before turn', 'AbortError'))

    await assert.rejects(runner.runTurn('must not persist', {
      signal: controller.signal,
    }), { name: 'AbortError' })
    assert.deepEqual(state.messages, [])
    assert.deepEqual(await store.replayEvents(), [])
  })

  it('propagates the turn deadline signal into the agent loop', async (context) => {
    const { store } = await createStore(context)
    const state: ConversationState = {
      messages: [],
      summary: '',
      budget: { used: 0, limit: 1_000 },
    }
    let observedDeadline = 0
    const runner = new ConversationRunner({
      model: summaryModel('unused'),
      registry: new ToolRegistry(),
      store,
      state,
      compaction: { ...COMPACTION, tokenThreshold: 10_000 },
      // Leave enough headroom for full-suite parallel process tests to delay
      // this worker before runAgentLoop starts; the assertion is about signal
      // propagation, not scheduler precision.
      turnTimeoutMs: 500,
      runAgentLoop: async (options) => {
        observedDeadline = options.deadline
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
      },
    })

    await assert.rejects(runner.runTurn('deadline'), { name: 'TimeoutError' })
    assert.ok(observedDeadline > 0)
    assert.equal((await store.loadState()).messages[0]?.role, 'user')
  })

  it('checks the recovery gate before persisting a new user turn', async (context) => {
    const { store } = await createStore(context)
    const state: ConversationState = {
      messages: [],
      summary: '',
      budget: { used: 0, limit: 1_000 },
    }
    const runner = new ConversationRunner({
      model: summaryModel('unused'),
      registry: new ToolRegistry(),
      store,
      state,
      compaction: { ...COMPACTION, tokenThreshold: 10_000 },
      recovery: {
        assertCanStartNewTurn: async () => {
          throw new Error('injected unresolved operation')
        },
      },
      runAgentLoop: async () => {
        throw new Error('must not run')
      },
    })

    await assert.rejects(runner.runTurn('must stay uncommitted'), /unresolved operation/)
    assert.deepEqual(state.messages, [])
    assert.deepEqual(await store.replayEvents(), [])
  })

  it('rejects overlapping turns that would race shared state', async (context) => {
    const { store } = await createStore(context)
    const state: ConversationState = {
      messages: [],
      summary: '',
      budget: { used: 0, limit: 1_000 },
    }
    await store.appendCheckpoint({ messages: [], summary: '', budgetUsed: 0 })
    let signalStarted!: () => void
    let releaseLoop!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseLoop = resolve })
    const runner = new ConversationRunner({
      model: summaryModel('unused'),
      registry: new ToolRegistry(),
      store,
      state,
      compaction: { ...COMPACTION, tokenThreshold: 10_000 },
      runAgentLoop: async () => {
        signalStarted()
        await release
        return { steps: 1, stopReason: 'completed' }
      },
    })

    const firstTurn = runner.runTurn('first')
    await started
    await assert.rejects(runner.runTurn('second'), /已有对话轮次/)
    releaseLoop()
    await firstTurn
  })

  it('compresses after a one-step agent loop and restores the checkpoint', async (context) => {
    const { directory, store } = await createStore(context)
    const state: ConversationState = {
      messages: olderTurns(),
      summary: '',
      budget: { used: 0, limit: 1_000 },
    }
    await store.appendCheckpoint({ messages: state.messages, summary: '', budgetUsed: 0 })
    const phases: Array<[CompactionPhase, ContextCompactionResult]> = []
    let summaryCalls = 0
    const largeAnswer = `answer-${'x'.repeat(1_000)}`
    const runner = new ConversationRunner({
      model: summaryModel('older turns completed', () => summaryCalls++),
      registry: new ToolRegistry(),
      store,
      state,
      compaction: COMPACTION,
      onCompaction: (phase, result) => phases.push([phase, result]),
      runAgentLoop: async (options) => {
        await commitAssistant(options, largeAnswer, 5)
        return { steps: 1, stopReason: 'completed' }
      },
    })

    await runner.runTurn('current request')

    assert.equal(summaryCalls, 1)
    assert.equal(phases.find(([phase]) => phase === 'before-turn')?.[1].compressedCount, 0)
    assert.ok((phases.find(([phase]) => phase === 'after-turn')?.[1].compressedCount ?? 0) > 0)
    assert.equal(state.summary, 'older turns completed')
    assert.equal(state.budget.used, 20)
    assert.equal(state.messages[0].role, 'assistant')

    const restored = await store.loadState()
    assert.deepEqual(restored, {
      messages: state.messages,
      summary: state.summary,
      budgetUsed: state.budget.used,
    })
    const rawLog = (await readSessionEventBytes(directory, 'runner')).toString('utf-8')
    assert.ok(rawLog.includes(largeAnswer), 'raw assistant output should remain in the audit log')
  })

  it('compacts between tool steps before the next model request', async (context) => {
    const { store } = await createStore(context)
    const state: ConversationState = {
      messages: olderTurns(),
      summary: '',
      budget: { used: 0, limit: 1_000 },
    }
    await store.appendCheckpoint({ messages: state.messages, summary: '', budgetUsed: 0 })
    const phases: Array<[CompactionPhase, ContextCompactionResult]> = []
    let secondStepSawSummary = false
    const runner = new ConversationRunner({
      model: summaryModel('between-step summary'),
      registry: new ToolRegistry(),
      store,
      state,
      compaction: COMPACTION,
      onCompaction: (phase, result) => phases.push([phase, result]),
      runAgentLoop: async (options) => {
        await commitAssistant(options, `tool-heavy-${'z'.repeat(1_000)}`, 5)
        await options.beforeStep?.(2)
        secondStepSawSummary = options.messages[0]?.role === 'assistant' &&
          String(options.messages[0].content).includes('between-step summary')
        await commitAssistant(options, 'final', 5)
        return { steps: 2, stopReason: 'completed' }
      },
    })

    await runner.runTurn('multi-step request')

    assert.equal(secondStepSawSummary, true)
    assert.ok((phases.find(([phase]) => phase === 'between-steps')?.[1].compressedCount ?? 0) > 0)
    assert.equal((await store.loadState()).summary, 'between-step summary')
  })

  it('still microcompacts but skips paid summarization once budget is exhausted', async (context) => {
    const { store } = await createStore(context)
    const state: ConversationState = {
      messages: olderTurns(),
      summary: '',
      budget: { used: 0, limit: 5 },
    }
    await store.appendCheckpoint({ messages: state.messages, summary: '', budgetUsed: 0 })
    let summaryCalls = 0
    const runner = new ConversationRunner({
      model: summaryModel('must not be used', () => summaryCalls++),
      registry: new ToolRegistry(),
      store,
      state,
      compaction: COMPACTION,
      runAgentLoop: async (options) => {
        await commitAssistant(options, `large-${'q'.repeat(1_000)}`, 5)
        return { steps: 1, stopReason: 'budget' }
      },
    })

    await runner.runTurn('use remaining budget')

    assert.equal(summaryCalls, 0)
    assert.equal(state.summary, '')
    assert.equal((await store.loadState()).budgetUsed, 5)
  })
})
