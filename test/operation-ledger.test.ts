import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyOperationEvent,
  assertOperationTransition,
  createOperationInputDigestPort,
  createOperationResultProtectionPort,
  parseOperationEvent,
  proposeOperation,
  redactSensitiveInput,
  reduceOperationEvents,
  transitionOperation,
} from '../src/execution/operation-ledger.js'
import type {
  OperationEvent,
  OperationStatus,
  ProtectedOperationInput,
  ProtectedOperationResult,
} from '../src/execution/operation-types.js'

function operationEvent(
  status: OperationStatus,
  sequence: number,
  overrides: Partial<OperationEvent> = {},
): OperationEvent {
  return {
    schemaVersion: 2,
    eventId: `event-${sequence}`,
    sequence,
    type: 'operation',
    operationId: 'operation-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    stepId: 'step-1',
    requestId: 'request-1',
    toolCallId: 'tool-call-1',
    toolName: 'write_file',
    capabilitySet: ['filesystem.write'],
    inputDigest: '0'.repeat(64),
    status,
    timestamp: `2026-07-15T00:00:0${sequence}.000Z`,
    ...overrides,
  }
}

function reduceLifecycle(events: OperationEvent[]) {
  const projection = reduceOperationEvents(events).get('operation-1')
  assert.ok(projection)
  return projection
}

describe('Operation ledger reducer', () => {
  it('reduces the legal proposed, approved, started, succeeded lifecycle', () => {
    const projection = reduceLifecycle([
      operationEvent('proposed', 1),
      operationEvent('approved', 2),
      operationEvent('started', 3, { attemptId: 'attempt-1' }),
      operationEvent('succeeded', 4, {
        attemptId: 'attempt-1',
        resultDigest: '1'.repeat(64),
        modelResult: { ok: true },
      }),
    ])

    assert.equal(projection.status, 'succeeded')
    assert.equal(projection.latestEvent.eventId, 'event-4')
    assert.equal(projection.events.length, 4)
    assert.deepEqual(projection.attemptIds, ['attempt-1'])
  })

  it('accepts denial and pre-dispatch cancellation as terminal outcomes', () => {
    assert.equal(reduceLifecycle([
      operationEvent('proposed', 1),
      operationEvent('denied', 2, { errorCode: 'policy_denied' }),
    ]).status, 'denied')

    assert.equal(reduceLifecycle([
      operationEvent('proposed', 1),
      operationEvent('approved', 2),
      operationEvent('cancelled', 3, {
        cancellationProof: 'not_dispatched',
        errorCode: 'user_cancelled',
      }),
    ]).status, 'cancelled')
  })

  it('accepts failed only as a proved terminal outcome after start', () => {
    const projection = reduceLifecycle([
      operationEvent('proposed', 1),
      operationEvent('approved', 2),
      operationEvent('started', 3, { attemptId: 'attempt-1' }),
      operationEvent('failed', 4, {
        attemptId: 'attempt-1',
        failureProof: 'transactionally_rejected',
        errorCode: 'upstream_rejected',
      }),
    ])

    assert.equal(projection.status, 'failed')
  })

  it('moves a started operation with an unknown result to uncertain', () => {
    const started = reduceLifecycle([
      operationEvent('proposed', 1),
      operationEvent('approved', 2),
      operationEvent('started', 3, { attemptId: 'attempt-1' }),
    ])

    const uncertain = applyOperationEvent(started, operationEvent('uncertain', 4, {
      attemptId: 'attempt-1',
      errorCode: 'connection_lost',
    }))

    assert.equal(uncertain.status, 'uncertain')
    assert.throws(
      () => applyOperationEvent(started, operationEvent('cancelled', 4, {
        cancellationProof: 'not_dispatched',
      })),
      /started|cancelled|非法|transition/i,
    )
  })

  it('allows each explicit reconciliation outcome from uncertain', () => {
    const prefix = [
      operationEvent('proposed', 1),
      operationEvent('approved', 2),
      operationEvent('started', 3, { attemptId: 'attempt-1' }),
      operationEvent('uncertain', 4, {
        attemptId: 'attempt-1',
        errorCode: 'timeout',
      }),
    ]

    const outcomes: OperationEvent[] = [
      operationEvent('reconciled_succeeded', 5, {
        resultDigest: '2'.repeat(64),
        modelResult: { ok: true },
      }),
      operationEvent('reconciled_failed', 5, { errorCode: 'confirmed_absent' }),
      operationEvent('superseded', 5, { errorCode: 'user_superseded' }),
    ]

    for (const outcome of outcomes) {
      const projection = reduceLifecycle([...prefix, outcome])
      assert.equal(projection.status, outcome.status)
      assert.throws(
        () => applyOperationEvent(projection, operationEvent('uncertain', 6, {
          attemptId: 'attempt-1',
        })),
        /terminal|终态|非法|transition/i,
      )
    }
  })

  it('rejects events that skip or reverse lifecycle states', () => {
    const illegalTransitions: Array<[OperationStatus, OperationStatus]> = [
      ['proposed', 'started'],
      ['proposed', 'succeeded'],
      ['approved', 'succeeded'],
      ['started', 'approved'],
      ['uncertain', 'succeeded'],
      ['succeeded', 'uncertain'],
      ['denied', 'approved'],
      ['cancelled', 'started'],
    ]

    for (const [from, to] of illegalTransitions) {
      assert.throws(
        () => assertOperationTransition(from, to),
        new RegExp(`${from}|${to}|非法|transition`, 'i'),
      )
    }
  })

  it('requires proposed to be the first event and keeps operations isolated', () => {
    assert.throws(
      () => applyOperationEvent(undefined, operationEvent('approved', 1)),
      /proposed|首|first|非法/i,
    )

    const current = reduceLifecycle([operationEvent('proposed', 1)])
    assert.throws(
      () => applyOperationEvent(current, operationEvent('approved', 2, {
        operationId: 'operation-2',
      })),
      /operationId|operation-1|operation-2|不匹配/i,
    )
  })

  it('rejects persisted terminal events that omit proof or attempt identity', () => {
    const started = reduceLifecycle([
      operationEvent('proposed', 1),
      operationEvent('approved', 2),
      operationEvent('started', 3, { attemptId: 'attempt-1' }),
    ])

    assert.throws(
      () => applyOperationEvent(started, operationEvent('failed', 4, {
        attemptId: 'attempt-1',
        errorCode: 'failed_without_proof',
      })),
      /failureProof|proof/i,
    )
    assert.throws(
      () => applyOperationEvent(started, operationEvent('succeeded', 4)),
      /attemptId/i,
    )
  })

  it('strictly parses untrusted operation journal payloads', () => {
    assert.equal(parseOperationEvent(operationEvent('proposed', 1)).status, 'proposed')
    assert.deepEqual(parseOperationEvent(operationEvent('proposed', 1, {
      capabilitySet: [],
    })).capabilitySet, [])
    assert.throws(
      () => parseOperationEvent(operationEvent('proposed', 1, {
        capabilitySet: ['filesystem.write', 1 as unknown as string],
      })),
      /capabilitySet/i,
    )
    assert.throws(
      () => parseOperationEvent(operationEvent('failed', 1, {
        attemptId: 'attempt-1',
        errorCode: 'bad-proof',
        failureProof: 'invented' as OperationEvent['failureProof'],
      })),
      /failureProof/i,
    )
    assert.throws(
      () => parseOperationEvent(operationEvent('proposed', 1, {
        attemptId: 'not-allowed',
      })),
      /attemptId/i,
    )
    assert.throws(
      () => parseOperationEvent(operationEvent('proposed', 1, { inputDigest: 'weak' })),
      /SHA-256|digest/i,
    )
    assert.throws(
      () => parseOperationEvent({ ...operationEvent('proposed', 1), surprise: true }),
      /未知.*surprise/i,
    )
    assert.throws(
      () => parseOperationEvent(operationEvent('proposed', 1, {
        redactedInput: JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'),
      })),
      /不安全 object key|__proto__/i,
    )
    assert.throws(
      () => parseOperationEvent(operationEvent('proposed', 1, {
        redactedInput: 'x'.repeat(65 * 1024),
      })),
      /bytes|超过/i,
    )
  })

  it('constructs a full guarded lifecycle only from protected input and result', () => {
    const inputPort = createOperationInputDigestPort({
      redact: redactSensitiveInput,
      hmacKey: 'input-key-for-tests-must-be-32-bytes',
    })
    const resultPort = createOperationResultProtectionPort({
      redact: redactSensitiveInput,
      hmacKey: 'result-key-for-tests-must-be-32-bytes',
      includeModelResult: true,
    })
    const proposed = proposeOperation({
      operationId: 'operation-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      toolCallId: 'tool-call-1',
      toolName: 'write_file',
      capabilitySet: ['filesystem.write'],
      protectedInput: inputPort.protect({ path: 'a.txt', accessToken: 'secret' }),
    }, { envelope: { eventId: 'event-1', sequence: 1 }, timestamp: '2026-07-15T00:00:01Z' }) as OperationEvent
    const approved = transitionOperation(
      applyOperationEvent(undefined, proposed),
      { kind: 'approve' },
      { envelope: { eventId: 'event-2', sequence: 2 }, timestamp: '2026-07-15T00:00:02Z' },
    ) as OperationEvent
    const started = transitionOperation(
      applyOperationEvent(applyOperationEvent(undefined, proposed), approved),
      { kind: 'start', attemptId: 'attempt-1' },
      { envelope: { eventId: 'event-3', sequence: 3 }, timestamp: '2026-07-15T00:00:03Z' },
    ) as OperationEvent
    const current = reduceLifecycle([proposed, approved, started])
    const succeeded = transitionOperation(current, {
      kind: 'succeed',
      protectedResult: resultPort.protect({ ok: true, refresh_token: 'secret' }),
    }, { envelope: { eventId: 'event-4', sequence: 4 }, timestamp: '2026-07-15T00:00:04Z' }) as OperationEvent

    assert.equal(succeeded.attemptId, 'attempt-1')
    assert.deepEqual(succeeded.modelResult, { ok: true })
    assert.equal(JSON.stringify([proposed, succeeded]).includes('secret'), false)
  })

  it('rejects forged protection objects and isolates nested values from mutation', () => {
    const baseProposal = {
      operationId: 'operation-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      toolCallId: 'tool-call-1',
      toolName: 'write_file',
      capabilitySet: ['filesystem.write'],
    }
    const forgedInput = {
      inputDigest: '0'.repeat(64),
      redactedInput: { password: 'raw-secret' },
    } as unknown as ProtectedOperationInput
    assert.throws(
      () => proposeOperation({ ...baseProposal, protectedInput: forgedInput }),
      /OperationInputDigestPort|protectedInput/i,
    )

    const source = { nested: { value: 'safe' } }
    const inputPort = createOperationInputDigestPort({
      redact: (value) => value as { nested: { value: string } },
      includeRedactedInput: true,
    })
    const protectedInput = inputPort.protect(source)
    source.nested.value = 'mutated-after-protect'
    assert.deepEqual(protectedInput.redactedInput, { nested: { value: 'safe' } })
    assert.equal(Object.isFrozen((protectedInput.redactedInput as { nested: object }).nested), true)

    const proposed = proposeOperation(
      { ...baseProposal, protectedInput },
      { envelope: { eventId: 'event-1', sequence: 1 }, timestamp: '2026-07-15T00:00:01Z' },
    ) as OperationEvent
    const approved = operationEvent('approved', 2, { inputDigest: proposed.inputDigest })
    const started = operationEvent('started', 3, {
      inputDigest: proposed.inputDigest,
      attemptId: 'attempt-1',
    })
    const current = reduceLifecycle([proposed, approved, started])
    const forgedResult = {
      resultDigest: '1'.repeat(64),
      modelResult: { token: 'raw-secret' },
    } as unknown as ProtectedOperationResult
    assert.throws(
      () => transitionOperation(current, { kind: 'succeed', protectedResult: forgedResult }),
      /OperationResultProtectionPort|protectedResult/i,
    )

    const persistedSource = operationEvent('proposed', 1, {
      redactedInput: { nested: { value: 'persisted-safe' } },
    })
    const parsed = parseOperationEvent(persistedSource)
    ;(persistedSource.redactedInput as { nested: { value: string } }).nested.value = 'mutated-source'
    assert.deepEqual(parsed.redactedInput, { nested: { value: 'persisted-safe' } })
    assert.equal(Object.isFrozen((parsed.redactedInput as { nested: object }).nested), true)
  })

  it('redacts secrets and uses keyed HMAC when hashing full input', () => {
    const input = {
      path: 'src/index.ts',
      token: 'secret-value',
      accessToken: 'access-secret',
      refresh_token: 'refresh-secret',
      id_token: 'id-secret',
      credentials: 'credential-secret',
      headers: {
        authorization: 'Bearer header-secret',
        'x-api-key': 'api-secret',
        'proxy-authorization': 'Basic proxy-secret',
      },
      url: 'https://user:pass@example.test/path?access_token=query-secret',
      command: 'deploy --api-key command-secret',
      nested: { password: 'hidden', value: 1 },
    }
    assert.deepEqual(redactSensitiveInput(input), {
      command: '[REDACTED]',
      headers: {},
      nested: { value: 1 },
      path: 'src/index.ts',
      url: '[REDACTED]',
    })
    assert.throws(
      () => createOperationInputDigestPort({ redact: redactSensitiveInput, hmacKey: 'weak' }),
      /32 bytes|HMAC/i,
    )

    const port = createOperationInputDigestPort({
      redact: redactSensitiveInput,
      hmacKey: 'local-test-key-at-least-32-bytes',
      includeRedactedInput: true,
    })
    const protectedInput = port.protect(input)

    assert.match(protectedInput.inputDigest, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(protectedInput).includes('secret-value'), false)
    assert.equal(JSON.stringify(protectedInput).includes('hidden'), false)
    assert.equal(JSON.stringify(protectedInput).includes('query-secret'), false)
    assert.equal(JSON.stringify(protectedInput).includes('command-secret'), false)

    const defaultProtected = createOperationInputDigestPort({
      redact: redactSensitiveInput,
      hmacKey: 'local-test-key-at-least-32-bytes',
    }).protect(input)
    assert.equal('redactedInput' in defaultProtected, false)
  })

  it('redacts prefixed environment-style secret field names', () => {
    assert.deepEqual(redactSensitiveInput({
      OPENAI_API_KEY: 'provider-secret',
      M2_SYNTHETIC_TOKEN: 'synthetic-secret',
      DATABASE_PASSWORD: 'database-secret',
      ordinary_value: 'visible',
    }), {
      ordinary_value: 'visible',
    })
    assert.equal(
      redactSensitiveInput('OPENAI_API_KEY=provider-secret'),
      '[REDACTED]',
    )
  })
})
