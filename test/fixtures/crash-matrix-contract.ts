export const CRASH_POINTS = [
  'before_proposed_append',
  'after_proposed_append',
  'after_approved_append',
  'before_started_write',
  'after_started_write_before_datasync',
  'after_started_datasync_before_dispatch',
  'after_dispatch_before_effect',
  'after_effect_before_result',
  'after_result_before_terminal',
  'after_terminal_before_tool_result',
  'after_tool_result_before_checkpoint',
] as const

export type CrashPoint = typeof CRASH_POINTS[number]

export interface CrashPointDetails {
  readonly operationId?: string
  readonly sequence?: number
}

/** Synchronous by design: the parent must be able to SIGKILL a stopped child. */
export interface CrashProbe {
  hit(point: CrashPoint, details: CrashPointDetails): void
}

export interface CrashSignal {
  readonly type: 'crash-point'
  readonly point: CrashPoint
  readonly details: CrashPointDetails
}

export interface CrashExpectation {
  readonly status?: 'cancelled' | 'uncertain' | 'succeeded'
  readonly dispatches: number
  readonly effects: number
  readonly materializedResults: number
  readonly canStartNewTurn: boolean
}

export const CRASH_EXPECTATIONS: Readonly<Record<CrashPoint, CrashExpectation>> = {
  before_proposed_append: {
    dispatches: 0, effects: 0, materializedResults: 0, canStartNewTurn: true,
  },
  after_proposed_append: {
    status: 'cancelled', dispatches: 0, effects: 0, materializedResults: 1,
    canStartNewTurn: true,
  },
  after_approved_append: {
    status: 'cancelled', dispatches: 0, effects: 0, materializedResults: 1,
    canStartNewTurn: true,
  },
  before_started_write: {
    status: 'cancelled', dispatches: 0, effects: 0, materializedResults: 1,
    canStartNewTurn: true,
  },
  after_started_write_before_datasync: {
    status: 'uncertain', dispatches: 0, effects: 0, materializedResults: 0,
    canStartNewTurn: false,
  },
  after_started_datasync_before_dispatch: {
    status: 'uncertain', dispatches: 0, effects: 0, materializedResults: 0,
    canStartNewTurn: false,
  },
  after_dispatch_before_effect: {
    status: 'uncertain', dispatches: 1, effects: 0, materializedResults: 0,
    canStartNewTurn: false,
  },
  after_effect_before_result: {
    status: 'uncertain', dispatches: 1, effects: 1, materializedResults: 0,
    canStartNewTurn: false,
  },
  after_result_before_terminal: {
    status: 'uncertain', dispatches: 1, effects: 1, materializedResults: 0,
    canStartNewTurn: false,
  },
  after_terminal_before_tool_result: {
    status: 'succeeded', dispatches: 1, effects: 1, materializedResults: 1,
    canStartNewTurn: true,
  },
  after_tool_result_before_checkpoint: {
    status: 'succeeded', dispatches: 1, effects: 1, materializedResults: 1,
    canStartNewTurn: true,
  },
}

export function isCrashPoint(value: string): value is CrashPoint {
  return (CRASH_POINTS as readonly string[]).includes(value)
}
