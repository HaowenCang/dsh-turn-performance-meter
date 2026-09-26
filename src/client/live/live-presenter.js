/**
 * Live presenter: machine state + LiveMeter snapshot -> render view model.
 *
 * Layering rule enforced here: statistics (trailing TPS, TTFT, tool-episode
 * wall time, turn elapsed) come from the `LiveMeter` snapshot untouched; the
 * state machine decides *what kind* of view this is; the presenter combines the
 * two and applies the defensive guards. The React layer receives a finished
 * view model and computes nothing.
 *
 * Defensive guards, each of which fails toward "show less", never toward
 * "show a stale number":
 *
 *   - machine inactive/settled, or meter idle/settled  -> hidden
 *   - streaming state without a live streaming snapshot -> transition
 *     (a settlement or tool event the machine has not folded yet must not leak
 *     the previous TPS)
 *   - pending state with an already-frozen TTFT        -> waiting
 *   - tool stage resolved from the machine OR the meter -> tool view, values
 *     strictly from the meter snapshot
 *
 * Every view carries `approximate` derived from metric quality: live TPS is
 * `estimated`, so it always renders with `≈`.
 */

import { MetricQuality, requiresApproximateMarker } from '../../core/quality-model.js'
import { completedViewModel } from '../ui-model.js'
import { LiveUiState, initialLiveUi, reduceLiveUi } from './live-state.js'

const HIDDEN_STATES = new Set([LiveUiState.INACTIVE, LiveUiState.SETTLED])

export class LivePresenter {
  /** @param {object} [machine] initial machine state (per session instance) */
  constructor(machine = initialLiveUi()) {
    this.machine = machine
  }

  /** Apply one normalized event to the state machine; returns the event count. */
  apply(event) {
    this.machine = reduceLiveUi(this.machine, event)
    return this.machine
  }

  /**
   * Project the current presentation model.
   *
   * Precedence is frozen: an open turn always wins over a settled one, so a new
   * `turn/start` removes the previous card in the same state advance that opens
   * the new turn.
   *
   * @param {object|null} snapshot `LiveMeter.snapshot(nowMs)` output
   * @param {number} nowMs presentation instant (wall clock)
   * @param {object|null} [settled] this session's latest settled snapshot
   */
  project(snapshot, nowMs, settled = null) {
    const machine = this.machine

    /**
     * Completed branch. It is reached from `settled`, never from the meter: the
     * card is a static projection of the settled turn record, and the settled
     * *machine* (not merely a settled meter) is what proves the turn this session
     * most recently observed has ended. A session whose machine is still
     * `inactive` has no card to show.
     */
    if (machine.state === LiveUiState.SETTLED) {
      return completedViewModel(settled) ?? hidden(machine)
    }

    if (HIDDEN_STATES.has(machine.state)) return hidden(machine)
    if (!snapshot || snapshot.phase === 'idle' || snapshot.phase === 'settled') return hidden(machine)

    const turn = machine.turn ?? snapshot.turn ?? null
    /**
     * `null` when the turn start was not observed (mid-turn attach): the pill
     * then omits the elapsed run instead of printing `0 s`. Never a stale or
     * fabricated number.
     */
    const elapsedMs = Number.isFinite(snapshot.turnElapsedMs) ? snapshot.turnElapsedMs : null

    // Tool stage: both the machine's activity counter and the meter's phase
    // are accepted as evidence, so a missed event cannot show a stale TPS.
    const tooling = machine.state === LiveUiState.TOOL_RUNNING || snapshot.phase === 'tool'
    if (tooling) {
      if (snapshot.phase === 'tool') {
        return {
          kind: 'tool',
          state: LiveUiState.TOOL_RUNNING,
          turn,
          count: snapshot.runningToolCount ?? 0,
          names: snapshot.runningToolNames ?? [],
          toolElapsedMs: snapshot.toolElapsedMs ?? 0,
          elapsedMs,
        }
      }
      // The machine believes tools run but the meter does not: inconsistent
      // evidence. The neutral transition view is the only honest rendering.
      return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
    }

    switch (machine.state) {
      case LiveUiState.PENDING_FIRST_TOKEN: {
        if (snapshot.ttftMs === null) {
          return { kind: 'ttft', state: machine.state, turn, counterMs: elapsedMs, elapsedMs }
        }
        // The meter already froze the turn TTFT; the machine lagged a delta.
        return { kind: 'waiting', state: LiveUiState.WAITING_MODEL, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
      }

      case LiveUiState.STREAMING_REASONING:
      case LiveUiState.STREAMING_OUTPUT: {
        const phase = machine.state === LiveUiState.STREAMING_REASONING ? 'reasoning' : 'output'
        if (snapshot.phase === 'streaming' && Number.isFinite(snapshot.tps)) {
          const quality = snapshot.tpsQuality ?? MetricQuality.ESTIMATED
          return {
            kind: 'streaming',
            state: machine.state,
            turn,
            phase,
            tps: snapshot.tps,
            quality,
            /** Live TPS is estimated unconditionally; `≈` is mandatory. */
            approximate: requiresApproximateMarker(quality),
            elapsedMs,
          }
        }
        // Streaming state without streaming evidence: never render the last
        // TPS as if it were current.
        return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
      }

      case LiveUiState.WAITING_MODEL:
        return { kind: 'waiting', state: machine.state, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }

      case LiveUiState.TRANSITION:
        return { kind: 'transition', state: machine.state, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }

      default:
        return hidden(machine)
    }
  }
}

function hidden(machine) {
  return { kind: 'hidden', state: machine.state, turn: machine.turn }
}

function stageWait(machine, nowMs) {
  if (!Number.isFinite(machine.sinceMs) || !Number.isFinite(nowMs)) return 0
  return Math.max(0, nowMs - machine.sinceMs)
}
