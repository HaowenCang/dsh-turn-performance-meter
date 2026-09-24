/**
 * Pure turn-lifecycle reducer.
 *
 * Verified local reason vocabulary (`@deepseek-ai/dsh-session/lib/types/types.d.ts:165-201`):
 *
 *   completed | aborted{reason} | blocked | error{error} | max-tokens | interrupted
 *
 * The mapping below is the documented product decision from
 * docs/IMPLEMENTATION_LOG.md. `max-tokens` settles as `completed` with a
 * truncation note because the turn did finish; `blocked` and `error` are
 * failures; `aborted` is a user/parent/hook cancellation; `interrupted` is the
 * crash-orphan closer DSH synthesizes for a turn whose log never ended.
 *
 * The reducer owns only lifecycle. Sample storage, tool intervals and the live
 * window belong to the telemetry store / `LiveMeter`.
 */

export const TurnPhase = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  STREAMING: 'streaming',
  TOOL: 'tool',
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERRORED: 'errored',
})

export const TURN_STATUS = Object.freeze({
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERRORED: 'errored',
})

/** Map a verified DSH `turn/end.reason` to a card status and note. */
export function settleFromTurnEndReason(reason) {
  const kind = reason?.kind
  switch (kind) {
    case 'completed':
      return { status: TURN_STATUS.COMPLETED, note: null }
    case 'max-tokens':
      return { status: TURN_STATUS.COMPLETED, note: 'max-tokens' }
    case 'aborted': {
      const cause = reason.reason?.kind ?? 'unknown'
      return { status: TURN_STATUS.INTERRUPTED, note: `aborted:${cause}` }
    }
    case 'interrupted':
      return { status: TURN_STATUS.INTERRUPTED, note: 'crash-orphaned' }
    case 'blocked':
      return { status: TURN_STATUS.ERRORED, note: 'blocked' }
    case 'error':
      return { status: TURN_STATUS.ERRORED, note: reason.error?.code ?? 'error' }
    default:
      // An unrecognized reason is a newer DSH vocabulary. Reporting `completed`
      // would claim knowledge the plugin does not have; the turn did end, so the
      // honest value is a settled turn whose exact reason is unknown.
      return { status: TURN_STATUS.COMPLETED, note: kind === undefined ? 'unknown-reason' : String(kind) }
  }
}

export function initialTurnState() {
  return {
    phase: TurnPhase.IDLE,
    turn: null,
    turnStartMs: null,
    firstTokenMs: null,
    activeAttemptId: null,
    activeToolIds: new Set(),
    settledAtMs: null,
    status: null,
    statusNote: null,
  }
}

/** Pure lifecycle reducer. Telemetry payload storage belongs to the store. */
export function reduceTurnState(state, event) {
  switch (event.type) {
    case 'TURN_STARTED':
      return { ...initialTurnState(), phase: TurnPhase.PENDING, turn: event.turn, turnStartMs: event.timeMs }
    case 'ATTEMPT_STARTED':
      return { ...state, phase: TurnPhase.PENDING, activeAttemptId: event.attemptId }
    case 'FIRST_DELTA':
      return {
        ...state,
        phase: TurnPhase.STREAMING,
        firstTokenMs: state.firstTokenMs ?? event.timeMs,
      }
    case 'DELTA':
      return { ...state, phase: TurnPhase.STREAMING }
    case 'TOOL_STARTED': {
      const next = new Set(state.activeToolIds)
      next.add(event.callId)
      // A tool cannot run while the same turn's model call is still delivering
      // tokens; clearing the live attempt is what forbids a stale TPS readout.
      return { ...state, phase: TurnPhase.TOOL, activeToolIds: next, activeAttemptId: null }
    }
    case 'TOOL_ENDED': {
      const next = new Set(state.activeToolIds)
      next.delete(event.callId)
      return { ...state, activeToolIds: next, phase: next.size ? TurnPhase.TOOL : TurnPhase.PENDING }
    }
    case 'TURN_ENDED': {
      const settled = settleFromTurnEndReason(event.reason)
      const status = event.status ?? settled.status
      return {
        ...state,
        phase: status === TURN_STATUS.INTERRUPTED ? TurnPhase.INTERRUPTED
          : status === TURN_STATUS.ERRORED ? TurnPhase.ERRORED
            : TurnPhase.COMPLETED,
        status,
        statusNote: settled.note,
        activeAttemptId: null,
        activeToolIds: new Set(),
        settledAtMs: event.timeMs,
      }
    }
    default:
      return state
  }
}
