import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  intersectExecutionConstraints,
  parseExecutionConstraints,
  parseToolCapabilities,
  resolveToolInvocation,
  type ToolCapability,
} from '../src/security/capabilities.js'
import {
  PolicyEngine,
  type PolicyContextInput,
  type PolicyDecision,
} from '../src/security/policy-engine.js'
import { createCapabilityRule } from '../src/security/rules.js'

function context(
  capabilities: readonly ToolCapability[],
  overrides: Partial<PolicyContextInput> = {},
): PolicyContextInput {
  return {
    toolName: 'test_tool',
    input: {},
    capabilities,
    constraints: {},
    batchCapabilities: [],
    priorCapabilities: [],
    toolSource: { kind: 'local' },
    source: { type: 'cli', nonInteractive: false, id: 'test' },
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
    ...overrides,
  }
}

describe('capability and constraint validation', () => {
  it('accepts and freezes an explicit empty capability set', () => {
    const capabilities = parseToolCapabilities([])
    assert.deepEqual(capabilities, [])
    assert.equal(Object.isFrozen(capabilities), true)
    assert.throws(() => parseToolCapabilities(['filesystem.read', 'filesystem.read']), /重复/)
    assert.throws(() => parseToolCapabilities(['system.root']), /未知能力/)
  })

  it('strictly validates and freezes executable constraints', () => {
    const constraints = parseExecutionConstraints({
      filesystemReadRoots: ['/workspace'],
      filesystemWriteRoots: ['/workspace/out'],
      networkSchemes: ['https'],
      networkHosts: ['example.com'],
      networkPorts: [443],
      allowLoopbackListen: true,
      loopbackListenPorts: [4321],
      requireSandbox: true,
      maxResultChars: 2_000,
    })
    assert.equal(Object.isFrozen(constraints), true)
    assert.equal(Object.isFrozen(constraints.networkHosts), true)
    assert.throws(() => parseExecutionConstraints({ typo: true }), /未知字段/)
    assert.throws(() => parseExecutionConstraints({ filesystemReadRoots: ['relative'] }), /合法字符串数组/)
    assert.throws(() => parseExecutionConstraints({ networkHosts: ['EXAMPLE.com'] }), /合法字符串数组/)
    assert.throws(() => parseExecutionConstraints({ networkPorts: [0] }), /1..65535/)
    assert.throws(() => parseExecutionConstraints({ loopbackListenPorts: [65_536] }), /1..65535/)
    assert.throws(() => parseExecutionConstraints({ maxResultChars: 0 }), /正整数/)
  })

  it('intersects roots, network boundaries, loopback permission and result limits', () => {
    const intersection = intersectExecutionConstraints({
      filesystemReadRoots: ['/workspace'],
      networkHosts: ['api.example.com', 'cdn.example.com'],
      allowLoopbackListen: true,
      loopbackListenPorts: [3000, 4000],
      requireSandbox: false,
      maxResultChars: 4_000,
    }, {
      filesystemReadRoots: ['/workspace/project'],
      networkHosts: ['api.example.com'],
      allowLoopbackListen: false,
      loopbackListenPorts: [4000],
      requireSandbox: true,
      maxResultChars: 1_000,
    })
    assert.deepEqual(intersection, {
      filesystemReadRoots: ['/workspace/project'],
      networkHosts: ['api.example.com'],
      loopbackListenPorts: [4000],
      allowLoopbackListen: false,
      requireSandbox: true,
      maxResultChars: 1_000,
    })
    assert.equal(intersectExecutionConstraints(
      { networkHosts: ['one.example'] },
      { networkHosts: ['two.example'] },
    ), null)
  })

  it('resolves dynamic capabilities, constraints and concurrency independently', () => {
    const resolved = resolveToolInvocation({
      getCapabilities: (input: { write: boolean }) => input.write
        ? ['filesystem.write']
        : [],
      getConstraints: () => ({ filesystemWriteRoots: ['/workspace'] }),
      isConcurrencySafe: (input) => !input.write,
    }, { write: true })
    assert.deepEqual(resolved.capabilities, ['filesystem.write'])
    assert.deepEqual(resolved.constraints.filesystemWriteRoots, ['/workspace'])
    assert.equal(resolved.isConcurrencySafe, false)
    assert.equal(Object.isFrozen(resolved), true)
  })
})

describe('PolicyEngine hard deny and defaults', () => {
  it('allows pure and ordinary read-only work, while asking for risk capabilities', async () => {
    const engine = new PolicyEngine()
    assert.equal((await engine.evaluate(context([]))).behavior, 'allow')
    assert.equal((await engine.evaluate(context(['filesystem.read']))).behavior, 'allow')
    assert.equal((await engine.evaluate(context(['external.read']))).behavior, 'allow')
    for (const capability of [
      'secret.read',
      'filesystem.write',
      'network.egress',
      'process.execute',
      'external.write',
      'user.interaction',
    ] as const) {
      const decision = await engine.evaluate(context([capability]))
      assert.equal(decision.behavior, 'ask', capability)
      assert.equal(decision.reasonCode, 'policy.default.approval_required')
    }
  })

  it('denies secret exfiltration across current, batch and directional history before hooks/rules', async () => {
    let hookCalls = 0
    let ruleCalls = 0
    const engine = new PolicyEngine({
      hooks: [() => {
        hookCalls += 1
        return { behavior: 'allow', constraints: {}, reasonCode: 'hook.allow' }
      }],
      rules: [{
        id: 'allow-all',
        evaluate: () => {
          ruleCalls += 1
          return { behavior: 'allow', constraints: {}, reasonCode: 'rule.allow' }
        },
      }],
    })
    for (const input of [
      context(['secret.read', 'network.egress']),
      context(['secret.read'], { batchCapabilities: ['network.egress'] }),
      context(['network.egress'], { priorCapabilities: ['secret.read'] }),
    ]) {
      const decision = await engine.evaluate(input)
      assert.deepEqual(decision, {
        behavior: 'deny',
        reasonCode: 'policy.hard_deny.secret_exfiltration',
      })
    }
    assert.equal(hookCalls, 0)
    assert.equal(ruleCalls, 0)
  })

  it('does not reverse history direction: prior egress does not block a later secret read', async () => {
    const decision = await new PolicyEngine().evaluate(context(
      ['secret.read'],
      { priorCapabilities: ['network.egress'] },
    ))
    assert.equal(decision.behavior, 'ask')
  })

  it('fails closed for unknown capabilities and malformed structured source', async () => {
    const engine = new PolicyEngine()
    const unknown = await engine.evaluate(context(
      ['not.real' as ToolCapability],
    ))
    assert.deepEqual(unknown, { behavior: 'deny', reasonCode: 'policy.input.unknown_capability' })
    const malformed = await engine.evaluate(context([], {
      source: { type: 'cli', nonInteractive: false, extra: true } as never,
    }))
    assert.deepEqual(malformed, { behavior: 'deny', reasonCode: 'policy.input.invalid' })
  })
})

describe('PolicyEngine tightening hooks and typed rules', () => {
  it('awaits hooks, preserves behavior monotonicity and intersects constraints', async () => {
    const engine = new PolicyEngine({
      hooks: [async () => ({
        behavior: 'ask',
        constraints: { networkHosts: ['api.example.com'], maxResultChars: 1_000 },
        reasonCode: 'hook.review',
      })],
      rules: [{
        id: 'attempt-relax',
        evaluate: () => ({
          behavior: 'allow',
          constraints: { networkHosts: ['api.example.com', 'other.example.com'], maxResultChars: 9_000 },
          reasonCode: 'rule.relax',
        }),
      }],
    })
    const decision = await engine.evaluate(context(['external.read'], {
      constraints: {
        networkHosts: ['api.example.com', 'cdn.example.com'],
        maxResultChars: 2_000,
      },
    }))
    assert.equal(decision.behavior, 'ask')
    assert.deepEqual(decision.constraints.networkHosts, ['api.example.com'])
    assert.equal(decision.constraints.maxResultChars, 1_000)
    assert.equal(decision.reasonCode, 'hook.review')
  })

  it('denies a hook behavior expansion, malformed result, exception, or empty intersection', async () => {
    const askThenAllow = new PolicyEngine({ hooks: [
      () => ({ behavior: 'ask', constraints: {}, reasonCode: 'hook.ask' }),
      () => ({ behavior: 'allow', constraints: {}, reasonCode: 'hook.allow' }),
    ] })
    assert.equal((await askThenAllow.evaluate(context([]))).reasonCode, 'policy.hook.permission_expansion')

    const malformed = new PolicyEngine({ hooks: [
      () => ({ behavior: 'allow', constraints: {}, reasonCode: 'unstable' } as unknown as PolicyDecision),
    ] })
    assert.equal((await malformed.evaluate(context([]))).reasonCode, 'policy.hook.invalid')

    const failed = new PolicyEngine({ hooks: [() => { throw new Error('raw secret') }] })
    assert.equal((await failed.evaluate(context([]))).reasonCode, 'policy.hook.error')

    const timedOut = new PolicyEngine({ hooks: [() => {
      throw new DOMException('hook deadline', 'TimeoutError')
    }] })
    await assert.rejects(timedOut.evaluate(context([])), { name: 'TimeoutError' })

    const empty = new PolicyEngine({ hooks: [() => ({
      behavior: 'allow',
      constraints: { networkHosts: ['other.example'] },
      reasonCode: 'hook.restrict',
    })] })
    assert.equal((await empty.evaluate(context([], {
      constraints: { networkHosts: ['api.example'] },
    }))).reasonCode, 'policy.constraints.empty_intersection')
  })

  it('supports ordered typed rules without allowing them to bypass a hook', async () => {
    const rule = createCapabilityRule({
      id: 'write-review',
      capabilities: ['filesystem.write'],
      sourceTypes: ['cli'],
      behavior: 'ask',
      constraints: { filesystemWriteRoots: ['/workspace/out'] },
      reasonCode: 'rule.write_review',
    })
    const decision = await new PolicyEngine({ rules: [rule] }).evaluate(context(
      ['filesystem.write'],
      { constraints: { filesystemWriteRoots: ['/workspace'] } },
    ))
    assert.equal(decision.behavior, 'ask')
    assert.deepEqual(decision.constraints.filesystemWriteRoots, ['/workspace/out'])
  })

  it('matches typed MCP rules by structured server provenance', async () => {
    const rule = createCapabilityRule({
      id: 'trusted-mcp',
      mcpServerNames: ['trusted'],
      behavior: 'deny',
      reasonCode: 'rule.trusted_mcp_probe',
    })
    const engine = new PolicyEngine({ rules: [rule] })
    assert.equal((await engine.evaluate(context([], {
      toolSource: { kind: 'mcp', serverName: 'trusted' },
    }))).reasonCode, 'rule.trusted_mcp_probe')
    assert.equal((await engine.evaluate(context([], {
      toolSource: { kind: 'mcp', serverName: 'other' },
    }))).reasonCode, 'policy.default.low_risk')
    assert.equal((await engine.evaluate(context([], {
      toolSource: { kind: 'local' },
    }))).reasonCode, 'policy.default.low_risk')
  })

  it('propagates cancellation and deadline instead of converting them into policy decisions', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('stop', 'AbortError'))
    await assert.rejects(
      new PolicyEngine().evaluate(context([], { signal: controller.signal })),
      { name: 'AbortError' },
    )
    await assert.rejects(
      new PolicyEngine().evaluate(context([], { deadline: Date.now() - 1 })),
      { name: 'TimeoutError' },
    )
  })
})
