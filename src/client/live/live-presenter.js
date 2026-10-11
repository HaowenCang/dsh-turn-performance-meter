/**
 * Live presenter: machine state + LiveMeter snapshot -> render view model.
 *
 * Layering rule enforced here: statistics (phase-cumulative TPS, TTFT, tool-episode
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
 *   - streaming state whose episode has not reached its warm-up sample count
 *     -> warming (the elapsed counter, never a one-sample rate)
 *   - pending state with an already-frozen TTFT        -> transition
 *     (a frozen TTFT is itself proof that a token arrived; "waiting for the
 *     model" would contradict the meter)
 *   - waiting-model while the meter is streaming       -> transition
 *     (the meter's `streaming` phase is live evidence, and the machine leaves
 *     its wait only on a delta this client may never have received)
 *   - tool stage resolved from the machine OR the meter -> tool view, values
 *     strictly from the meter snapshot, and only while the machine has not
 *     already streamed past it
 *
 * Every view carries `approximate` derived from metric quality: live TPS is
 * `estimated`, so it always renders with `≈`.
 */

import { MetricQuality, requiresApproximateMarker } from '../../core/quality-model.js'
import { completedViewModel } from '../ui-model.js'
import { LiveUiState, initialLiveUi, reduceLiveUi } from './live-state.js'

const HIDDEN_STATES = new Set([LiveUiState.INACTIVE, LiveUiState.SETTLED])

/**
 * How long the first-response stopwatch may keep running before the presenter
 * stops calling it a first response.
 *
 * The stopwatch is the honest view while a first token can still be pending, but
 * it is only *bounded* evidence. The meter freezes `ttftMs` exclusively from the
 * transient `assistant/live-chunk` plane (`acceptSample` /
 * `observeTokenBoundary`, reached only through that route), so a turn whose
 * rows never arrive leaves it `null` with no fallback that could notice the
 * model answered. In that state the `ttft` view's `counterMs` is
 * `turnElapsedMs` — the *turn* clock, not a first-token interval — and the pill
 * therefore counted up a "first response" over a live stream (a reported
 * screenshot read `首响应计时 1189.7 s`), asserting a wait that no longer
 * described anything.
 *
 * The bound is a guard against that rendering, not a diagnosis of it: why a
 * given turn had no rows is not established here, and this guard holds whatever
 * the reason. Past the bound the neutral transition stage carries the same turn
 * clock without claiming the model is still being waited on. The TTFT value
 * itself is never invented: a meter that does have a frozen `ttftMs` reports
 * the real number on the completed card regardless of this guard.
 */
const FIRST_RESPONSE_HONEST_MS = 120_000

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

    /**
     * Whether the machine has already seen model output. The meter's `tool`
     * phase is *sticky*: it is left only when the last running call settles
     * (`LiveMeter.toolSettled`), so a tool result this client could not pair
     * leaves the phase on `tool` while the model keeps streaming. The machine's
     * streaming state is driven by the deltas themselves and is the newer
     * evidence there — a leftover tool timer must never be rendered as if it
     * still tracked the turn.
     */
    const streaming = machine.state === LiveUiState.STREAMING_REASONING
      || machine.state === LiveUiState.STREAMING_OUTPUT

    // Tool stage: both the machine's activity counter and the meter's phase
    // are accepted as evidence, so a missed event cannot show a stale TPS.
    const tooling = machine.state === LiveUiState.TOOL_RUNNING || snapshot.phase === 'tool'
    if (tooling) {
      if (snapshot.phase === 'tool' && !streaming) {
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
      // Inconsistent evidence in either direction: the machine believes tools
      // run while the meter does not, or the meter still reports a tool episode
      // the machine has already streamed past. The neutral transition view is
      // the only honest rendering — it carries the turn clock and never claims a
      // stage the other layer contradicts.
      return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
    }

    switch (machine.state) {
      case LiveUiState.PENDING_FIRST_TOKEN: {
        if (snapshot.ttftMs === null) {
          /**
           * No token has reached the meter. That is a genuine first-response wait
           * only while it is still plausible; past the bound the transient plane
           * has published nothing for this turn and the stopwatch would keep
           * counting over a stream the meter simply cannot see.
           */
          if (Number.isFinite(elapsedMs) && elapsedMs > FIRST_RESPONSE_HONEST_MS) {
            return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
          }
          return { kind: 'ttft', state: machine.state, turn, counterMs: elapsedMs, elapsedMs }
        }
        /**
         * The meter froze the turn TTFT, which is only ever set by the turn's
         * first token: the model has already answered and the machine merely
         * lagged the delta that says so. `waiting-model` would contradict the
         * meter and keep a "waiting for model" stopwatch running over a live
         * stream, so the neutral transition view carries the turn clock instead.
         * The first-response stopwatch stays a thing only the meter can still
         * report (`ttftMs === null`).
         */
        return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
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
            /**
             * Whether the number is the first-output fallback rather than this
             * phase's own estimate. The renderer prints the same `≈` either way —
             * both are estimates — but a diagnostic can tell them apart.
             */
            fallback: snapshot.fallback === true,
          }
        }
        if (snapshot.phase === 'streaming') {
          /**
           * The episode exists but has not yet produced `MIN_WARMUP_SAMPLES`
           * samples, so no rate may be published: a one-sample rate is not a
           * measurement. The pill keeps the phase label and the episode's elapsed
           * counter instead of a number (`docs/METRICS_SPEC.md` §12), which is the
           * pending/elapsed presentation the pre-warm-up state already used.
           *
           * `counterMs` is `null` — not `0` — when no episode is open at all: a
           * boundary-only first token knows the phase and the TTFT but has opened
           * no phase episode (§4), so there is no episode clock to print. The
           * renderer turns a non-finite duration into the shared em dash, and
           * `0` would claim a measured zero-length episode.
           */
          return {
            kind: 'warming',
            state: machine.state,
            turn,
            phase,
            counterMs: Number.isFinite(snapshot.episodeElapsedMs) ? snapshot.episodeElapsedMs : null,
            samples: snapshot.episodeSampleCount ?? 0,
            required: snapshot.warmupSamples ?? 0,
            elapsedMs,
          }
        }
        // Streaming state without streaming evidence: never render the last
        // TPS as if it were current.
        return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
      }

      case LiveUiState.WAITING_MODEL: {
        /**
         * The machine leaves this state only on a DELTA (`live-state.js`), and a
         * delta this client never received leaves it waiting forever — the
         * reported defect: "waiting for model" with the stopwatch still counting
         * up while the model streams. The meter's `streaming` phase is live
         * evidence that tokens are arriving right now, so the wait is over and the
         * neutral transition view is the honest rendering. A meter that is merely
         * `pending` is the genuine wait the specification describes and keeps
         * its own stopwatch.
         */
        if (snapshot.phase === 'streaming') {
          return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
        }
        return { kind: 'waiting', state: machine.state, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
      }

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
