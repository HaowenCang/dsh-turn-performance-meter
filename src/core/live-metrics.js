/**
 * Live meter state and snapshots.
 *
 * This is the only place the "what is happening right now" question is answered,
 * and it exists so the client half contains no statistics of its own. It is
 * transport-agnostic: it consumes *normalized* events, which `src/host` (or the
 * browser adapter) produces from verified DSH data.
 *
 * Frozen behaviours implemented here:
 *
 *   - the trailing window is bound to one model attempt and is reset at every new
 *     attempt, so two calls separated by a tool or a retry never mix
 *     (docs/METRICS_SPEC.md §6);
 *   - while no attempt is streaming — including while a tool runs — the meter
 *     reports `tps: null` and a phase of `tool`/`pending`, never a stale or zero
 *     TPS dressed up as current (UI_SPEC §3.3);
 *   - TTFT is measured once per turn, from turn start to the first non-empty
 *     generated delta, and is never redefined by a later call
 *     (docs/METRICS_SPEC.md §4).
 */

import { SlidingWindowMeter } from './sliding-window.js'
import { MetricQuality } from './metric-quality.js'
import { PHASE } from './phase-duration.js'

export const LivePhase = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  STREAMING: 'streaming',
  TOOL: 'tool',
  SETTLED: 'settled',
})

export class LiveMeter {
  /**
   * @param {{windowMs?:number}} [options]
   */
  constructor(options = {}) {
    /**
     * The measured interval. Named `windowMs` because it is a definition of the
     * rate, not a schedule: this class owns no timer and never will. A `refreshMs`
     * option used to sit beside it and was removed in Phase 6 — it described a
     * presentation cadence the meter never drove, and the only cadence in the
     * project is `src/client/live/cadence.js`. Keeping a second, dead copy of that
     * number here invited a future reader to change the wrong one.
     */
    this.windowMs = options.windowMs ?? 1000
    this.meter = new SlidingWindowMeter(this.windowMs)
    this.reset()
  }

  reset() {
    this.turn = null
    this.turnStartMs = null
    this.turnEndMs = null
    this.firstTokenMs = null
    this.attemptId = null
    this.step = null
    this.phase = LivePhase.IDLE
    this.status = null
    /** Insertion-ordered so the compact label lists tools in call order. */
    this.tools = new Map()
    /**
     * Start of the current *continuous* tool-activity episode: the earliest
     * boundary of the union of overlapping tool intervals that is still open.
     * A tool starting while another runs extends the episode; an episode ends
     * only when the last running call settles. This is the wall-clock figure
     * the compact live timer shows (`toolWall`, never a sum of call durations).
     */
    this.toolEpisodeStartMs = null
    this.lastDeltaMs = null
    /** Phase of the most recent generated sample of the active attempt. */
    this.streamingPhase = null
    this.meter.reset(null)
  }

  /** Begin a new turn; any previous turn's live state is discarded. */
  turnStarted({ turn, timeMs }) {
    this.reset()
    this.turn = turn
    this.turnStartMs = timeMs
    this.phase = LivePhase.PENDING
  }

  /**
   * Record the turn's start now that it has been observed.
   *
   * Two orderings reach this method. A page that attached mid-turn adopted the
   * open turn with an unknown start, and the turn's own `turn/start` row later
   * enters the window (a reconnect, or the window sliding back far enough): the
   * missing instant is then *recovered*, not redefined. Second, the ordinary
   * case calls it on every durable `turn/start` after `turnStarted`, where a
   * finite start is already present.
   *
   * Both elapsed time and turn TTFT are defined as intervals from the turn's
   * start, so recording that instant late does not move either measurement: it
   * is the same arithmetic on the same evidence, and the first token timestamp
   * was already stamped when its delta arrived. What the call changes is
   * whether the metric is *computable* — a finite start turns an unknown into a
   * measured value, which is strictly more evidence than was held before.
   *
   * The converse is refused: an observed start is never replaced by a later
   * non-finite one, so authority can only be added, never withdrawn. The first
   * finite observation wins because a turn has exactly one start.
   *
   * @param {{turn:number|null, timeMs:number|null}} input
   * @returns {boolean} whether the recorded start changed
   */
  turnStartObserved({ turn, timeMs }) {
    if (turn === null || turn === undefined) return false
    if (turn !== this.turn) return false
    if (Number.isFinite(this.turnStartMs)) return false
    if (!Number.isFinite(timeMs)) return false
    this.turnStartMs = timeMs
    return true
  }

  /**
   * Begin a new model attempt. Always resets the window: a new attempt identity
   * is exactly the boundary across which a rolling window must not be bridged.
   * @returns {boolean} whether the identity actually changed
   */
  attemptStarted({ attemptId, step = null, timeMs = null }) {
    const changed = this.meter.beginAttempt(attemptId)
    this.attemptId = attemptId
    this.step = step
    this.streamingPhase = null
    // A model attempt cannot be generating while tools are still running, so the
    // phase leaves `tool` only once the last one has settled.
    if (this.runningTools().length === 0) this.phase = LivePhase.PENDING
    if (Number.isFinite(timeMs)) this.attemptStartMs = timeMs
    return changed
  }

  /**
   * Accept one generated sample (`{timeMs, phase, tokens|weight}`). Non-generated
   * chunks must have been filtered out upstream by `sampleFromChunk`.
   *
   * A sample carrying an `attemptId` other than the active one is rejected: a
   * late frame from an attempt the turn has already moved past must not enter the
   * current window, or the rolling rate would bridge two model calls.
   */
  acceptSample(sample) {
    if (!sample || !Number.isFinite(sample.timeMs)) return false
    if (this.turn === null) return false
    if (sample.attemptId !== undefined && sample.attemptId !== null && sample.attemptId !== this.attemptId) {
      return false
    }
    const weight = sample.tokens ?? sample.weight
    if (!(weight > 0) || !Number.isFinite(weight)) return false
    if (this.firstTokenMs === null) this.firstTokenMs = sample.timeMs
    this.lastDeltaMs = sample.timeMs
    this.phase = LivePhase.STREAMING
    this.streamingPhase = sample.phase ?? null
    this.meter.add(sample.timeMs, weight)
    return true
  }

  /** Which phase the active attempt is currently generating, or `null`. */
  activePhase() {
    return this.streamingPhase
  }

  toolStarted({ callId, name, timeMs }) {
    const wasRunning = this.runningTools().length > 0
    this.tools.set(callId, { callId, name: name ?? 'tool', startMs: timeMs, endMs: null, status: 'running' })
    // A call starting while others run belongs to the same continuous episode;
    // only the first call of a quiet period opens a new one.
    if (!wasRunning) this.toolEpisodeStartMs = timeMs
    this.phase = LivePhase.TOOL
    // The model is not generating while a tool runs, so the attempt window is
    // cleared rather than frozen: a later frame must not read a stale speed.
    this.meter.reset(null)
    this.attemptId = null
  }

  toolSettled({ callId, timeMs, status = 'ok' }) {
    const call = this.tools.get(callId)
    if (call) {
      call.endMs = timeMs
      call.status = status
    }
    if (this.runningTools().length === 0) {
      // The continuous activity interval ended with the last running call.
      this.toolEpisodeStartMs = null
      if (this.phase === LivePhase.TOOL) this.phase = LivePhase.PENDING
    }
  }

  runningTools() {
    return [...this.tools.values()].filter(call => call.endMs === null)
  }

  turnSettled({ timeMs, status = 'completed' }) {
    this.turnEndMs = timeMs
    this.status = status
    this.phase = LivePhase.SETTLED
    this.meter.reset(null)
    this.attemptId = null
  }

  /**
   * Current wall clock, clamped so a paused tab cannot produce negative elapsed
   * times or count samples from the future.
   */
  clock(nowMs) {
    if (!Number.isFinite(nowMs)) return this.lastDeltaMs ?? this.turnStartMs ?? 0
    return Math.max(this.turnStartMs ?? nowMs, nowMs)
  }

  /**
   * The live view snapshot. `tps` is `null` whenever no model attempt is
   * generating, so a renderer cannot accidentally print a stale rate.
   */
  snapshot(nowMs) {
    if (this.turn === null) return { phase: LivePhase.IDLE }
    const now = this.clock(nowMs)
    /**
     * `null`, never `0`, when the turn start was not observed: a page that
     * attaches mid-turn adopts the open turn without its `turn/start` boundary
     * (see `client-feed`), and "elapsed 0 s" would then be a fabricated number
     * for a turn that may have been running for minutes.
     */
    const elapsedMs = Number.isFinite(this.turnStartMs) ? Math.max(0, now - this.turnStartMs) : null
    const base = {
      turn: this.turn,
      phase: this.phase,
      turnElapsedMs: elapsedMs,
      ttftMs: this.firstTokenMs !== null && Number.isFinite(this.turnStartMs)
        ? Math.max(0, this.firstTokenMs - this.turnStartMs)
        : null,
      attemptId: this.attemptId,
      step: this.step,
    }

    if (this.phase === LivePhase.STREAMING && this.meter.attemptId !== null) {
      const tps = this.meter.value(now)
      return {
        ...base,
        tps,
        /**
         * Live TPS is a shape estimate anchored to nothing yet: DSH streams no
         * per-delta token counts, so the value cannot be `exact` until provider
         * usage arrives and calibration happens after settlement.
         */
        tpsQuality: MetricQuality.ESTIMATED,
        activePhase: this.activePhase(),
      }
    }

    if (this.phase === LivePhase.TOOL) {
      const running = this.runningTools()
      return {
        ...base,
        tps: null,
        tpsQuality: MetricQuality.UNAVAILABLE,
        runningToolCount: running.length,
        runningToolNames: running.map(call => call.name),
        /**
         * Wall-clock duration of the current continuous tool-activity episode
         * (the open union interval), not the sum and not merely the oldest
         * still-running call: a call that joined an already-running episode
         * keeps the episode's original start even after the first call ends.
         */
        toolElapsedMs: this.toolEpisodeStartMs === null ? 0 : Math.max(0, now - this.toolEpisodeStartMs),
        toolEpisodeStartMs: this.toolEpisodeStartMs,
      }
    }

    /**
     * Pending — turn open, or an attempt begun with no generated delta yet. The
     * window is knowingly empty, so the value is a measured zero rather than
     * absent evidence: the UI shows a running TTFT counter here, not a rate.
     */
    if (this.phase === LivePhase.PENDING && this.meter.attemptId !== null) {
      return { ...base, tps: 0, tpsQuality: MetricQuality.ESTIMATED }
    }

    return { ...base, tps: null, tpsQuality: MetricQuality.UNAVAILABLE }
  }
}

export { PHASE }
