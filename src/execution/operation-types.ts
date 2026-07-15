/** The persisted lifecycle of one logical tool operation. */
export type OperationStatus =
  | 'proposed'
  | 'approved'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'uncertain'
  | 'reconciled_succeeded'
  | 'reconciled_failed'
  | 'superseded'

export type FailureProof = 'no_side_effect' | 'transactionally_rejected'
export type CancellationProof = 'not_dispatched' | 'proven_not_started'

/** Values that can safely cross the journal boundary after redaction. */
export type ReadonlyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue }

export interface OperationEvent {
  readonly type: 'operation'
  readonly schemaVersion: 2
  readonly eventId: string
  readonly sequence: number
  readonly operationId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly requestId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly capabilitySet: readonly string[]
  readonly inputDigest: string
  /** Input that has already passed the caller's redaction policy. */
  readonly redactedInput?: ReadonlyJsonValue
  readonly status: OperationStatus
  readonly idempotencyKey?: string
  readonly attemptId?: string
  readonly timestamp: string
  readonly resultDigest?: string
  /** A bounded, redacted result suitable for reconstructing the model message. */
  readonly modelResult?: ReadonlyJsonValue
  /** Durable reference used instead of modelResult for large or sensitive output. */
  readonly resultRef?: string
  readonly errorCode?: string
  /** Audit evidence set only by the guarded failed transition. */
  readonly failureProof?: FailureProof
  /** Audit evidence set only by the guarded cancelled transition. */
  readonly cancellationProof?: CancellationProof
}

/** An event before the shared Event Store assigns its ordered envelope. */
export type OperationEventDraft = Omit<OperationEvent, 'schemaVersion' | 'eventId' | 'sequence'>

export interface OperationEventEnvelope {
  readonly schemaVersion?: 2
  readonly eventId: string
  readonly sequence: number
}

export interface ProposedOperation {
  readonly operationId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly requestId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly capabilitySet: readonly string[]
  /** Raw tool input is deliberately not accepted at this boundary. */
  readonly protectedInput: ProtectedOperationInput
  readonly idempotencyKey?: string
}

export interface OperationProjection {
  readonly operationId: string
  readonly status: OperationStatus
  readonly latestEvent: OperationEvent
  readonly events: readonly OperationEvent[]
  readonly attemptIds: readonly string[]
}

export type ReconcileResult =
  | {
      readonly outcome: 'succeeded'
      readonly protectedResult?: ProtectedOperationResult
    }
  | { readonly outcome: 'failed'; readonly errorCode?: string }
  | { readonly outcome: 'unknown'; readonly errorCode?: string }

export interface IdempotencyContract {
  readonly scope: 'operation'
  readonly ttlMs?: number
  readonly retrySafeAfterUnknownOutcome: boolean
  readonly reconcile?: (key: string) => Promise<ReconcileResult>
}

declare const protectedOperationInputBrand: unique symbol
declare const protectedOperationResultBrand: unique symbol

export interface ProtectedOperationInput {
  readonly [protectedOperationInputBrand]: true
  readonly inputDigest: string
  /** Omitted unless persistence of the redacted form was explicitly enabled. */
  readonly redactedInput?: ReadonlyJsonValue
}

export interface ProtectedOperationResult {
  readonly [protectedOperationResultBrand]: true
  readonly resultDigest: string
  /** Omitted unless bounded result persistence was explicitly enabled. */
  readonly modelResult?: ReadonlyJsonValue
  /** Durable, access-controlled reference for large or sensitive output. */
  readonly resultRef?: string
}

/**
 * Boundary responsible for turning raw input into journal-safe data. Callers
 * must never attach the original input to an OperationEvent.
 */
export interface OperationInputDigestPort {
  protect(input: unknown): ProtectedOperationInput
}

export interface OperationResultProtectionPort {
  protect(result: unknown, resultRef?: string): ProtectedOperationResult
}

export type OperationInputRedactor = (input: unknown) => ReadonlyJsonValue

export type OperationTransition =
  | { readonly kind: 'approve' }
  | { readonly kind: 'deny'; readonly errorCode?: string }
  | { readonly kind: 'start'; readonly attemptId: string }
  | {
      readonly kind: 'succeed'
      readonly attemptId?: string
      readonly protectedResult?: ProtectedOperationResult
    }
  | {
      readonly kind: 'fail'
      readonly attemptId?: string
      readonly proof: FailureProof
      readonly errorCode: string
    }
  | {
      readonly kind: 'cancel'
      readonly dispatchState: CancellationProof
      readonly errorCode?: string
    }
  | {
      readonly kind: 'mark_uncertain'
      readonly attemptId?: string
      readonly errorCode?: string
    }
  | {
      readonly kind: 'reconcile_succeeded'
      readonly protectedResult?: ProtectedOperationResult
    }
  | { readonly kind: 'reconcile_failed'; readonly errorCode?: string }
  | { readonly kind: 'supersede'; readonly errorCode?: string }

export interface OperationEventMetadata {
  readonly timestamp?: string
  readonly envelope?: OperationEventEnvelope
}
