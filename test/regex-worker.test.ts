import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type {
  ToolDefinition,
  ToolExecutionContext,
} from '../src/core/tool-registry.js'
import { Workspace } from '../src/core/workspace.js'
import {
  getActiveRegexWorkerCount,
  InvalidRegexPatternError,
  RegexWorkerMatcher,
  RegexWorkerTimeoutError,
} from '../src/execution/regex-worker.js'
import { createFileTools } from '../src/tools/builtins/file-tools.js'

function grepTool(tools: readonly ToolDefinition[]) {
  const grep = tools.find((tool) => tool.name === 'grep')
  if (!grep) throw new Error('grep tool missing')
  return grep
}

function runtime(
  signal: AbortSignal,
  readRoot: string,
  deadline = Date.now() + 5_000,
): ToolExecutionContext {
  return {
    signal,
    deadline,
    capabilities: ['filesystem.read'],
    constraints: { filesystemReadRoots: [readRoot] },
  }
}

describe('isolated regex worker', () => {
  it('matches normal expressions with bounded line indexes and terminates cleanly', async () => {
    const matcher = await RegexWorkerMatcher.create('needle\\s+\\d+', {
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    })
    assert.equal(getActiveRegexWorkerCount(), 1)
    try {
      assert.deepEqual(await matcher.match('needle 1\nno match\nNEEDLE 22', 10), [0, 2])
    } finally {
      await matcher.close()
    }
    assert.equal(getActiveRegexWorkerCount(), 0)
  })

  it('rejects invalid expressions inside the worker and terminates cleanly', async () => {
    await assert.rejects(
      RegexWorkerMatcher.create('[', {
        signal: new AbortController().signal,
        deadline: Date.now() + 5_000,
      }),
      (error) => error instanceof InvalidRegexPatternError,
    )
    assert.equal(getActiveRegexWorkerCount(), 0)
  })

  it('hard-terminates catastrophic backtracking without returning partial results', async () => {
    const matcher = await RegexWorkerMatcher.create('(a*)*b', {
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
      timeoutMs: 100,
    })
    const startedAt = Date.now()
    try {
      await assert.rejects(
        matcher.match(`${'a'.repeat(10_000)}!`, 1),
        (error) => error instanceof RegexWorkerTimeoutError,
      )
    } finally {
      await matcher.close()
    }
    assert.ok(Date.now() - startedAt < 2_000, 'catastrophic regex must be forcibly bounded')
    assert.equal(getActiveRegexWorkerCount(), 0)
  })

  it('propagates cancellation and leaves no worker behind', async () => {
    const controller = new AbortController()
    const matcher = await RegexWorkerMatcher.create('(a*)*b', {
      signal: controller.signal,
      deadline: Date.now() + 5_000,
      timeoutMs: 5_000,
    })
    const matching = matcher.match(`${'a'.repeat(10_000)}!`, 1)
    setTimeout(() => controller.abort(new DOMException('test abort', 'AbortError')), 20).unref()
    try {
      await assert.rejects(matching, (error) => error instanceof Error && error.name === 'AbortError')
    } finally {
      await matcher.close()
    }
    assert.equal(getActiveRegexWorkerCount(), 0)
  })
})

describe('grep regex isolation', () => {
  it('uses the worker for normal grep output', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-regex-normal-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'notes.txt'), 'first\nneedle 42\nlast')
    const workspace = new Workspace(root)
    const grep = grepTool(createFileTools(workspace))

    const result = String(await grep.execute(
      { pattern: 'needle\\s+\\d+', path: 'notes.txt' },
      runtime(new AbortController().signal, join(workspace.root, 'notes.txt')),
    ))
    assert.match(result, /notes\.txt:2: needle 42/)
    assert.equal(getActiveRegexWorkerCount(), 0)
  })

  it('fails closed on regex timeout and cancellation', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'super-agent-regex-fail-closed-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'hostile.txt'), `${'a'.repeat(10_000)}!`)
    const workspace = new Workspace(root)
    const grep = grepTool(createFileTools(workspace, { regexTimeoutMs: 100 }))
    const readRoot = join(workspace.root, 'hostile.txt')

    await assert.rejects(
      grep.execute(
        { pattern: '(a*)*b', path: 'hostile.txt' },
        runtime(new AbortController().signal, readRoot),
      ),
      (error) => error instanceof RegexWorkerTimeoutError,
    )
    assert.equal(getActiveRegexWorkerCount(), 0)

    const controller = new AbortController()
    const cancellableGrep = grepTool(createFileTools(workspace, { regexTimeoutMs: 5_000 }))
    const execution = cancellableGrep.execute(
      { pattern: '(a*)*b', path: 'hostile.txt' },
      runtime(controller.signal, readRoot),
    )
    setTimeout(() => controller.abort(new DOMException('test abort', 'AbortError')), 20).unref()
    await assert.rejects(execution, (error) => error instanceof Error && error.name === 'AbortError')
    assert.equal(getActiveRegexWorkerCount(), 0)
  })
})
