import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  OperationEvent,
  OperationProjection,
  OperationStatus,
} from '../src/execution/operation-types.js'
import {
  SessionQuotaError,
  calculateOperationReservationTransition,
  measureJsonlEventBytes,
  operationQuotaAdmissionClass,
  preflightSessionQuotaAdmission,
  rebuildSessionQuotaReservation,
  reservationSlotsForOperation,
} from '../src/session/session-quota.js'

function projection(status: OperationStatus, operationId = `operation-${status}`) {
  const latestEvent = { operationId, status } as OperationEvent
  return Object.freeze({
    operationId,
    status,
    latestEvent,
    events: Object.freeze([latestEvent]),
    attemptIds: Object.freeze([]),
  }) satisfies OperationProjection
}

function bytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function errorCode(code: SessionQuotaError['code']) {
  return (error: unknown) => error instanceof SessionQuotaError && error.code === code
}

describe('session quota reservations', () => {
  it('freezes every recovered Operation status at 2/3/2/1/0 slots', () => {
    for (const status of ['proposed', 'approved'] as const) {
      assert.equal(reservationSlotsForOperation(projection(status), false), 2)
      assert.equal(operationQuotaAdmissionClass(status), 'regular')
    }
    assert.equal(reservationSlotsForOperation(projection('started'), false), 3)
    assert.equal(operationQuotaAdmissionClass('started'), 'regular')
    assert.equal(reservationSlotsForOperation(projection('uncertain'), false), 2)
    assert.equal(operationQuotaAdmissionClass('uncertain'), 'critical')

    const terminal: OperationStatus[] = [
      'succeeded',
      'failed',
      'denied',
      'cancelled',
      'reconciled_succeeded',
      'reconciled_failed',
      'superseded',
    ]
    for (const status of terminal) {
      const current = projection(status)
      assert.equal(reservationSlotsForOperation(current, false), 1)
      assert.equal(reservationSlotsForOperation(current, true), 0)
      assert.equal(operationQuotaAdmissionClass(status), 'critical')
    }
    assert.throws(
      () => reservationSlotsForOperation(projection('started'), true),
      errorCode('invalid_quota_state'),
    )
  })

  it('rebuilds reservations by operationId and stable materialization state', () => {
    const operations = [
      projection('proposed', 'proposed'),
      projection('started', 'started'),
      projection('uncertain', 'uncertain'),
      projection('succeeded', 'terminal'),
      projection('cancelled', 'materialized'),
    ]
    const rebuilt = rebuildSessionQuotaReservation({
      operations,
      materializedOperationIds: new Set(['materialized', 'orphan-legacy-materialization']),
      slotBytes: 1024,
    })
    assert.equal(rebuilt.totalSlots, 8)
    assert.equal(rebuilt.reservedBytes, 8192)
    assert.deepEqual([...rebuilt.slotsByOperationId], [
      ['proposed', 2],
      ['started', 3],
      ['uncertain', 2],
      ['terminal', 1],
      ['materialized', 0],
    ])
  })

  it('exposes reservation deltas for proposal, start, terminal and materialization', () => {
    const proposed = projection('proposed', 'operation-1')
    const approved = projection('approved', 'operation-1')
    const started = projection('started', 'operation-1')
    const succeeded = projection('succeeded', 'operation-1')
    assert.equal(calculateOperationReservationTransition({ after: proposed }).deltaSlots, 2)
    assert.equal(calculateOperationReservationTransition({
      before: approved,
      after: started,
    }).deltaSlots, 1)
    assert.deepEqual(calculateOperationReservationTransition({
      before: started,
      after: succeeded,
    }), {
      operationId: 'operation-1',
      beforeSlots: 3,
      afterSlots: 1,
      deltaSlots: -2,
    })
    assert.equal(calculateOperationReservationTransition({
      before: succeeded,
      after: succeeded,
      materializedBefore: false,
      materializedAfter: true,
    }).deltaSlots, -1)
  })
})

describe('session quota admission', () => {
  const limits = Object.freeze({
    maxRecordBytes: 10,
    regularQuotaBytes: 10,
    criticalReserveBytes: 30,
  })

  it('counts complete UTF-8 JSONL bytes including the newline', () => {
    const event = { text: '你好😀' }
    assert.equal(measureJsonlEventBytes(event), bytes(event).byteLength)
    assert.equal(measureJsonlEventBytes({}), 3)
  })

  it('admits proposal/start only before writes and reservation consumption', () => {
    const proposed = preflightSessionQuotaAdmission({
      limits,
      usedEventBytes: 0,
      reservedCriticalSlots: 0,
    }, {
      records: [{ bytes: bytes({}), admissionClass: 'regular' }],
      reservedCriticalSlotsAfter: 2,
    })
    assert.deepEqual(proposed, {
      usedEventBytesBefore: 0,
      usedEventBytesAfter: 3,
      batchEventBytes: 3,
      regularEventBytes: 3,
      criticalEventBytes: 0,
      reservedCriticalSlotsBefore: 0,
      reservedCriticalSlotsAfter: 2,
      reservedCriticalBytesAfter: 20,
      hardLimitBytes: 40,
    })

    const started = preflightSessionQuotaAdmission({
      limits,
      usedEventBytes: proposed.usedEventBytesAfter,
      reservedCriticalSlots: proposed.reservedCriticalSlotsAfter,
    }, {
      records: [{ bytes: bytes({}), admissionClass: 'regular' }],
      reservedCriticalSlotsAfter: 3,
    })
    assert.equal(started.usedEventBytesAfter, 6)
    assert.equal(started.reservedCriticalSlotsAfter, 3)
  })

  it('rejects insufficient started reserve before a durable ack can be issued', () => {
    const state = Object.freeze({
      limits: { ...limits, criticalReserveBytes: 20 },
      usedEventBytes: 3,
      reservedCriticalSlots: 2,
    })
    assert.throws(() => preflightSessionQuotaAdmission(state, {
      records: [{ bytes: bytes({}), admissionClass: 'regular' }],
      reservedCriticalSlotsAfter: 3,
    }), errorCode('critical_reserve_exceeded'))
    assert.deepEqual(state, {
      limits: { ...limits, criticalReserveBytes: 20 },
      usedEventBytes: 3,
      reservedCriticalSlots: 2,
    })
  })

  it('lets critical lifecycle records enter reserve but blocks ordinary events', () => {
    const state = { limits, usedEventBytes: 9, reservedCriticalSlots: 0 }
    assert.throws(() => preflightSessionQuotaAdmission(state, {
      records: [{ bytes: bytes({}), admissionClass: 'regular' }],
      reservedCriticalSlotsAfter: 0,
    }), errorCode('regular_quota_exceeded'))
    const critical = preflightSessionQuotaAdmission(state, {
      records: [{ bytes: bytes({}), admissionClass: 'critical' }],
      reservedCriticalSlotsAfter: 0,
    })
    assert.equal(critical.usedEventBytesAfter, 12)
    assert.equal(critical.criticalEventBytes, 3)
  })

  it('preflights schema marker and business event as one indivisible batch', () => {
    const state = Object.freeze({
      limits: { ...limits, regularQuotaBytes: 5 },
      usedEventBytes: 0,
      reservedCriticalSlots: 0,
    })
    const marker = bytes({})
    const business = bytes({})
    assert.throws(() => preflightSessionQuotaAdmission(state, {
      records: [
        { bytes: marker, admissionClass: 'regular' },
        { bytes: business, admissionClass: 'regular' },
      ],
      reservedCriticalSlotsAfter: 0,
    }), errorCode('regular_quota_exceeded'))
    assert.equal(state.usedEventBytes, 0)
  })

  it('enforces full-record and total event-plus-obligation hard limits', () => {
    assert.throws(() => preflightSessionQuotaAdmission({
      limits,
      usedEventBytes: 0,
      reservedCriticalSlots: 0,
    }, {
      records: [{ bytes: Buffer.from('not-complete'), admissionClass: 'regular' }],
      reservedCriticalSlotsAfter: 0,
    }), errorCode('invalid_quota_batch'))
    assert.throws(() => preflightSessionQuotaAdmission({
      limits,
      usedEventBytes: 0,
      reservedCriticalSlots: 0,
    }, {
      records: [{ bytes: Buffer.from('1234567890\n'), admissionClass: 'regular' }],
      reservedCriticalSlotsAfter: 0,
    }), errorCode('record_too_large'))
    assert.throws(() => preflightSessionQuotaAdmission({
      limits,
      usedEventBytes: 37,
      reservedCriticalSlots: 0,
    }, {
      records: [{ bytes: bytes({}), admissionClass: 'critical' }],
      reservedCriticalSlotsAfter: 1,
    }), errorCode('total_quota_exceeded'))
  })
})
