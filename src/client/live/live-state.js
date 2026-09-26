/**
 * The explicit live-UI state machine.
 *
 * The eight presentation states are frozen in `docs/UI_SPEC.md` §3. The rule
 * this module exists to enforce: a React component never *guesses* the current
 * situation from a handful of possibly-undefined fields. Every transition is an
 * explicit reaction to one normalized event, and every state has a written
 * entry and exit condition.
 *
 *   inactive              no open turn for this session — render nothing
 *   pending-first-token   turn/start seen, no first model-producing delta yet;
 *                         the turn's ONE TTFT stopwatch stage
 *   streaming-reasoning   active attempt generating reasoning deltas
 *   streaming-output      active attempt generating text / tool-argument deltas
 *   tool-running          at least one tool call active — no model TPS
 *   waiting-model         turn TTFT already frozen; a new step/attempt is
 *                         started or imminent, no delta yet — never the TTFT
 *                         counter again
 *   transition            brief neutral gap (settlement before tool/call, tool
 *                         result before next step/start, retry backoff) — no
 *                         stale TPS
 *   settled               turn/end received — exit live mode immediately
 *
 * The machine tracks the *model side* plus a tool-activity counter; numeric
 * values (TPS, elapsed, tool timer) are read from the `LiveMeter` snapshot by
 * the presenter, never recomputed here.
 */

export const LiveUiState = Object.freeze({
  INACTIVE: 'inactive',
  PENDING_FIRST_TOKEN: 'pending-first-token',
  STREAMING_REASONING: 'streaming-reasoning',
  STREAMING_OUTPUT: 'streaming-output',
  TOOL_RUNNING: 'tool-running',
  WAITING_MODEL: 'waiting-model',
  TRANSITION: 'transition',
  SETTLED: 'settled',
})

export function initialLiveUi() {
  return {
    state: LiveUiState.INACTIVE,
    turn: null,
    /** Frozen by the first accepted model-producing delta of the turn. */
    ttftFrozen: false,
    /** Entry time of the current waiting/transition stage, for its stopwatch. */
    sinceMs: null,
    /** Active tool-call counter; > 0 means the tool-running stage owns the view. */
    activeTools: 0,
  }
}

/** Events are normalized vocabulary only — never raw DSH shapes. */
export const LIVE_UI_EVENT = Object.freeze({
  TURN_START: 'turn-start',
  TURN_END: 'turn-end',
  STEP_START: 'step-start',
  ATTEMPT_START: 'attempt-start',
  DELTA: 'delta',
  ATTEMPT_SETTLE: 'attempt-settle',
  ATTEMPT_ABANDON: 'attempt-abandon',
  RETRY: 'retry',
  TOOL_START: 'tool-start',
  TOOL_END: 'tool-end',
  RESET: 'reset',
})

const { INACTIVE, PENDING_FIRST_TOKEN, STREAMING_REASONING, STREAMING_OUTPUT, TOOL_RUNNING, WAITING_MODEL, TRANSITION, SETTLED } = LiveUiState

/** An event naming a different turn than the one on screen changes nothing. */
function wrongTurn(machine, event) {
  if (machine.state === INACTIVE) return true
  if (event.turn === undefined || event.turn === null) return false
  if (machine.turn === null) return false
  return event.turn !== machine.turn
}

function settleTo(machine, event) {
  // A settlement does not end running tools; the tool stage keeps the view
  // until the last call settles.
  if (machine.activeTools > 0) return machine
  return { ...machine, state: TRANSITION, sinceMs: event.timeMs ?? machine.sinceMs }
}

/**
 * Reduce the live UI machine by one normalized event. Pure: returns the same
 * object when the event changes nothing, so callers can detect no-ops.
 */
export function reduceLiveUi(machine, event) {
  if (event === null || typeof event !== 'object') return machine
  switch (event.type) {
    case LIVE_UI_EVENT.RESET:
      return initialLiveUi()

    case LIVE_UI_EVENT.TURN_START: {
      // A replayed durable turn/start for the open turn must not restart the
      // TTFT stage or wipe the frozen marker.
      if (machine.state !== INACTIVE && machine.state !== SETTLED && event.turn === machine.turn) return machine
      /**
       * Adopted boundary (`recovered`): the page attached mid-turn and the
       * open turn's `turn/start` was outside the published window, so this
       * turn's TTFT was never observed *here*. The turn opens in the neutral
       * waiting stage with the TTFT stopwatch already frozen as unknown —
       * restarting it would print a TTFT measured from the reload.
       */
      if (event.recovered === true) {
        return {
          state: WAITING_MODEL,
          turn: event.turn ?? machine.turn,
          ttftFrozen: true,
          sinceMs: null,
          activeTools: 0,
        }
      }
      return {
        state: PENDING_FIRST_TOKEN,
        turn: event.turn ?? machine.turn,
        ttftFrozen: false,
        sinceMs: event.timeMs ?? null,
        activeTools: 0,
      }
    }

    case LIVE_UI_EVENT.TURN_END: {
      if (wrongTurn(machine, event)) return machine
      return { ...machine, state: SETTLED, sinceMs: event.timeMs ?? machine.sinceMs, activeTools: 0 }
    }

    case LIVE_UI_EVENT.STEP_START: {
      if (wrongTurn(machine, event) || machine.state === SETTLED) return machine
      if (machine.activeTools > 0) return machine
      if (!machine.ttftFrozen) {
        // The turn's one and only first-token stage: later step boundaries
        // must not restart it.
        return { ...machine, state: PENDING_FIRST_TOKEN }
      }
      return { ...machine, state: WAITING_MODEL, sinceMs: event.timeMs ?? null }
    }

    case LIVE_UI_EVENT.ATTEMPT_START: {
      if (wrongTurn(machine, event) || machine.state === SETTLED) return machine
      if (machine.activeTools > 0) return machine
      if (!machine.ttftFrozen) return { ...machine, state: PENDING_FIRST_TOKEN }
      // Turn TTFT is already frozen; a later attempt can only wait.
      return { ...machine, state: WAITING_MODEL, sinceMs: event.timeMs ?? null }
    }

    case LIVE_UI_EVENT.DELTA: {
      if (wrongTurn(machine, event) || machine.state === SETTLED) return machine
      if (machine.state === INACTIVE) return machine
      const phase = event.phase === 'reasoning' ? STREAMING_REASONING : STREAMING_OUTPUT
      // The first accepted delta of the turn freezes the TTFT stopwatch. No
      // later event in this turn ever returns to pending-first-token.
      return { ...machine, state: phase, ttftFrozen: true, sinceMs: machine.sinceMs }
    }

    case LIVE_UI_EVENT.ATTEMPT_SETTLE: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      return settleTo(machine, event)
    }

    case LIVE_UI_EVENT.ATTEMPT_ABANDON: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      return settleTo(machine, event)
    }

    case LIVE_UI_EVENT.RETRY: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      // Retry backoff is a neutral gap: no model deltas, no tool yet.
      return settleTo(machine, event)
    }

    case LIVE_UI_EVENT.TOOL_START: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      return { ...machine, activeTools: machine.activeTools + 1, state: TOOL_RUNNING }
    }

    case LIVE_UI_EVENT.TOOL_END: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      const remaining = Math.max(0, machine.activeTools - 1)
      if (remaining > 0) return { ...machine, activeTools: remaining }
      // The last tool ended. Until the next step/start arrives the UI is in
      // the neutral gap the specification calls transition; if the turn never
      // produced a first token the TTFT stage is still the honest view.
      if (!machine.ttftFrozen) return { ...machine, activeTools: 0, state: PENDING_FIRST_TOKEN }
      return { ...machine, activeTools: 0, state: TRANSITION, sinceMs: event.timeMs ?? null }
    }

    default:
      return machine
  }
}
