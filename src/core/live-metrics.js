/**
 * Live meter state and snapshots — MiMo-style phase-cumulative throughput.
 *
 * This is the only place the "what is happening right now" question is answered,
 * and it exists so the client half contains no statistics of its own. It is
 * transport-agnostic: it consumes *normalized* events, which `src/host` (or the
 * browser adapter) produces from verified DSH data.
 *
 * ## The statistic (Phase 9.2)
 *
 * For the active **phase episode** — the contiguous run of generated samples of
 * one phase inside one model attempt — the live rate is
 *
 *     TPS(t) = generated token mass since the episode started
 *              / elapsed wall time since the episode started
 *
 * rounded with `Math.round`, which is MiMo's observed rule
 * (`docs/MIMO_RUNTIME_METRICS.md` §5.1/§5.2). It is a cumulative phase average,
 * not a trailing window: while the model falls silent the numerator freezes and
 * the denominator advances, so the readout decays continuously and never reaches
 * zero by rule (`docs/METRICS_SPEC.md` §6).
 *
 * Behaviours implemented here:
 *
 *   - a **phase change** restarts the episode clock and the numerator; the old
 *     phase's elapsed time is never carried into the new phase (§14);
 *   - a **new attempt** is a hard boundary: episode, numerator, clock and the
 *     reasoning-rate fallback are all reset, so two calls separated by a tool or
 *     a retry never mix (§5);
 *   - while no attempt is streaming — including while a tool runs — the meter
 *     reports `tps: null` and a phase of `tool`/`pending`, never a stale or zero
 *     TPS dressed up as current, and never a continuation of the MiMo decay
 *     across a tool wait (§9);
 *   - a rate is published only once the current episode satisfies the shared
 *     publication policy (`src/core/rate-publication.js`): at least
 *     `MIN_WARMUP_SAMPLES` contributing samples **and** at least
 *     `MIN_RATE_ELAPSED_MS` of its own clock. A one-sample rate is never shown,
 *     and neither is a quotient whose denominator is a few milliseconds of
 *     delivery granularity (§12);
 *   - the first output samples of a fresh output episode may reuse the last
 *     positive reasoning rate for at most `FIRST_OUTPUT_GUARD_MS`, and only while
 *     the output episode has no valid positive rate of its own (§15);
 *   - TTFT is measured once per turn, from turn start to the first chunk DSH's
 *     own `isTokenDelta` accepts — `tokenEvidence().countsAsToken` in
 *     `src/core/delta-accounting.js`, which includes a name-bearing
 *     `tool-call-delta` whose argument fragment has not arrived yet — and is
 *     never redefined by a later call (docs/METRICS_SPEC.md §4). A boundary-only
 *     delta freezes TTFT and contributes no token mass.
 *
 * ## Token evidence priority (§6)
 *
 *   1. a usable authoritative **in-stream provider counter** (a `usage` chunk
 *      that arrived through the transient plane), converted to an episode-local
 *      mass by subtracting the counter snapshot taken when the episode started;
 *   2. otherwise the **generated-delta shape weight** `sample.tokens ??
 *      sample.weight`.
 *
 * The provider counters are used only while the phase-evidence policy agrees
 * that the split may be mapped onto the observed stream; a contradiction falls
 * back to the shape magnitude rather than claiming an exact phase split (§7).
 * No client-side tokenizer is used anywhere.
 */

import { MetricQuality } from './metric-quality.js'
import { PHASE } from './phase-duration.js'
import { analyzePhaseEvidenceFrom } from './phase-evidence.js'
import { MIN_RATE_ELAPSED_MS, MIN_RATE_SAMPLES, rateAvailability } from './rate-publication.js'

export const LivePhase = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  STREAMING: 'streaming',
  TOOL: 'tool',
  SETTLED: 'settled',
})

/**
 * Generated samples the current episode needs before a rate is published.
 *
 * This is the shared gate (`src/core/rate-publication.js`), re-exported under the
 * name the live half has used since Phase 9.2. It is an alias rather than a
 * second constant so the live pill and the completed curve cannot drift apart:
 * the live half kept this rule while the curve half had none, and that asymmetry
 * is what allowed a sub-100 ms quotient to reach `peakTps`.
 */
export const MIN_WARMUP_SAMPLES = MIN_RATE_SAMPLES

/**
 * How long the last positive reasoning rate may stand in for an output episode
 * that has no valid positive rate of its own yet.
 *
 * MiMo reuses the thinking rate for up to 1 s into the output phase rather than
 * displaying a spurious zero (`docs/MIMO_RUNTIME_METRICS.md` §5.2). The reuse
 * never overwrites a valid positive output estimate, and it does not survive a
 * tool wait, an attempt boundary or a turn boundary.
 */
export const FIRST_OUTPUT_GUARD_MS = 1000

/** The counter a phase episode reads, or `null` when the split is unusable. */
function episodeCounter(usage, phase, evidence) {
  if (usage === null || evidence === null || evidence.splitUsable !== true) return null
  if (phase === PHASE.REASONING) return evidence.reasoningTotal
  if (phase === PHASE.OUTPUT) return evidence.outputTotal
  return null
}

export class LiveMeter {
  constructor() {
    this.reset()
  }

  reset() {
    this.turn = null
    this.turnStartMs = null
    this.turnEndMs = null
    this.firstTokenMs = null
    this.attemptId = null
    this.attemptStartMs = null
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
    /**
     * The active phase episode. `episodeStartMs` is the first generated sample
     * of the episode and is the origin of the cumulative clock; the numerator is
     * the episode's token mass, accumulated from accepted samples or from the
     * provider counter when one is usable.
     */
    this.episodeStartMs = null
    this.episodeTokenMass = 0
    this.episodeSampleCount = 0
    /**
     * The attempt's authoritative counters as they stood when the episode
     * started, so a provider counter can be read as an episode-local mass. It is
     * `null` until a usable in-stream usage chunk has been observed, and it is
     * re-taken at every episode start while counters are known.
     */
    this.episodeUsageBaseline = null
    /** Latest in-stream usage for the active attempt, or `null`. */
    this.usage = null
    /** Whether the attempt's stream has produced deltas of each phase. */
    this.phaseSeen = { reasoning: false, output: false }
    this.phaseSampleCounts = { reasoning: 0, output: 0 }
    /**
     * The last published positive reasoning rate, or `null`. It exists solely
     * for the first-output guard, and every hard boundary clears it.
     */
    this.lastPositiveReasoningRate = null
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
   * Begin a new model attempt. Always a hard boundary: the episode, its
   * numerator, its clock and the first-output guard are reset, because a new
   * attempt identity is exactly the boundary a cumulative phase average must not
   * be bridged across (§5).
   * @returns {boolean} whether the identity actually changed
   */
  attemptStarted({ attemptId, step = null, timeMs = null }) {
    const changed = this.attemptId !== attemptId
    this.attemptId = attemptId
    this.step = step
    this.streamingPhase = null
    this.usage = null
    this.phaseSeen = { reasoning: false, output: false }
    this.phaseSampleCounts = { reasoning: 0, output: 0 }
    this.lastPositiveReasoningRate = null
    this.clearEpisode()
    // A model attempt cannot be generating while tools are still running, so the
    // phase leaves `tool` only once the last one has settled.
    if (this.runningTools().length === 0) this.phase = LivePhase.PENDING
    if (Number.isFinite(timeMs)) this.attemptStartMs = timeMs
    return changed
  }

  /** Drop the active episode and its clock. */
  clearEpisode() {
    this.episodeStartMs = null
    this.episodeTokenMass = 0
    this.episodeSampleCount = 0
    this.episodeUsageBaseline = null
  }

  /**
   * Accept one generated sample (`{timeMs, phase, tokens|weight}`). Non-generated
   * chunks must have been filtered out upstream by `sampleFromChunk`.
   *
   * A sample carrying an `attemptId` other than the active one is rejected: a
   * late frame from an attempt the turn has already moved past must not enter the
   * current episode, or the cumulative rate would bridge two model calls.
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

    const phase = sample.phase ?? null
    /**
     * The stream summary is updated **before** the episode's baseline is taken, so
     * the phase-evidence check the baseline depends on can see the sample that is
     * opening the episode. Evaluating it first made the first episode of every
     * phase invisible to its own check, which locked the provider-counter path out
     * of exactly the case §6.1 describes (a usage chunk arriving during reasoning
     * and a fresh output episode beginning right after it).
     */
    if (phase === PHASE.REASONING) {
      this.phaseSeen.reasoning = true
      this.phaseSampleCounts.reasoning += 1
    } else if (phase === PHASE.OUTPUT) {
      this.phaseSeen.output = true
      this.phaseSampleCounts.output += 1
    }
    if (phase !== this.streamingPhase || this.episodeStartMs === null) {
      /**
       * A phase change — or the attempt's very first generated sample — opens a
       * fresh episode. The previous phase's elapsed time and numerator are
       * discarded rather than carried forward (§14).
       */
      this.streamingPhase = phase
      this.episodeStartMs = sample.timeMs
      this.episodeTokenMass = weight
      this.episodeSampleCount = 1
      this.episodeUsageBaseline = this.usageBaselineFor(phase)
    } else {
      this.episodeTokenMass += weight
      this.episodeSampleCount += 1
    }
    return true
  }

  /**
   * Record DSH's first-token boundary for a chunk that carries **no** usable
   * TPS-shape magnitude.
   *
   * Exactly one chunk shape reaches this method: a name-bearing
   * `tool-call-delta` whose `argumentsDelta` is still empty. DSH's `isTokenDelta`
   * accepts it — the model has begun emitting a call, and the name is the
   * evidence — while `classifyDelta` cannot attribute any argument text to it. It
   * therefore freezes the turn's TTFT and opens the phase episode it starts, and
   * it does neither of the things that would corrupt the numbers: it adds no
   * token mass, and it does not increment `episodeSampleCount`, so a rate can
   * never be published from boundary evidence alone.
   *
   * Before this method existed, `firstTokenMs` could only be frozen by an
   * accepted sample, so a turn whose first token was a tool-call boundary kept
   * rendering the first-response stopwatch after the boundary had passed.
   *
   * @param {{attemptId?:string|null, timeMs:number, phase?:string|null}} input
   * @returns {boolean} whether the boundary was recorded
   */
  observeTokenBoundary({ attemptId = null, timeMs, phase = null } = {}) {
    if (!Number.isFinite(timeMs)) return false
    if (this.turn === null) return false
    if (attemptId !== null && attemptId !== undefined && attemptId !== this.attemptId) return false
    if (this.firstTokenMs === null) this.firstTokenMs = timeMs
    if (!Number.isFinite(this.lastDeltaMs) || timeMs > this.lastDeltaMs) this.lastDeltaMs = timeMs
    this.phase = LivePhase.STREAMING
    const nextPhase = phase ?? null
    /**
     * The boundary opens the episode whose clock it starts. It is a *clock*
     * origin, not a measurement: mass stays at zero and the sample count stays at
     * zero until a magnitude-bearing delta arrives, so the first publishable rate
     * of that episode still needs `MIN_RATE_SAMPLES` real samples.
     */
    if (nextPhase !== null && (nextPhase !== this.streamingPhase || this.episodeStartMs === null)) {
      this.streamingPhase = nextPhase
      this.episodeStartMs = timeMs
      this.episodeTokenMass = 0
      this.episodeSampleCount = 0
      this.episodeUsageBaseline = this.usageBaselineFor(nextPhase)
    }
    return true
  }

  /**
   * Accept the authoritative usage an in-stream `usage` chunk carried.
   *
   * A usage chunk is not a generated sample, so it never becomes one; what it
   * does is upgrade the numerator evidence for the episodes that follow it (§6).
   * A chunk naming another attempt is refused, exactly as a late sample is.
   *
   * @returns {boolean} whether the counters were recorded
   */
  observeUsage({ attemptId, usage }) {
    if (attemptId !== undefined && attemptId !== null && attemptId !== this.attemptId) return false
    if (usage === null || typeof usage !== 'object') return false
    if (!Number.isFinite(usage.outputTokens)) return false
    /**
     * A usage chunk that arrives *inside* an episode cannot retroactively
     * explain the episode's start — the counter value at that instant was never
     * observed — so an episode that began without a baseline keeps its shape
     * magnitude. An episode that already holds one keeps it: the counters are
     * cumulative, so `counterNow - baseline` remains this episode's own growth.
     */
    this.usage = usage
    return true
  }

  /** The counter snapshot an episode of `phase` starts from, or `null`. */
  usageBaselineFor(phase) {
    if (this.usage === null) return null
    const evidence = this.evidence()
    const counter = episodeCounter(this.usage, phase, evidence)
    if (counter === null || !Number.isFinite(counter)) return null
    return { phase, counter }
  }

  /** The phase-evidence verdict for the active attempt, from stream evidence only. */
  evidence() {
    if (this.usage === null) return null
    return analyzePhaseEvidenceFrom({
      hasReasoningSamples: this.phaseSeen.reasoning,
      hasOutputSamples: this.phaseSeen.output,
      reasoningSampleCount: this.phaseSampleCounts.reasoning,
      outputSampleCount: this.phaseSampleCounts.output,
    }, this.usage.outputTokens, this.usage.reasoningTokens)
  }

  /**
   * The episode's token mass, from the strongest available evidence.
   *
   * Provider counters win when the split is usable, an episode-local baseline
   * exists, and the counter has **advanced** since that baseline. A counter that
   * has not advanced carries no evidence about this episode — a usage chunk
   * arrives before the terminal `finish` and nothing after it, so between chunks
   * the counter is stale — and publishing its zero delta would be the spurious
   * non-positive value §6 forbids. The shape weight is used instead; a counter
   * that contradicts the stream is likewise never turned into an exact phase
   * magnitude (§7).
   *
   * @returns {{mass:number, source:'provider-counter'|'shape'}}
   */
  episodeMass() {
    const baseline = this.episodeUsageBaseline
    if (baseline !== null && this.usage !== null) {
      const evidence = this.evidence()
      const counter = episodeCounter(this.usage, baseline.phase, evidence)
      if (counter !== null && Number.isFinite(counter)) {
        const delta = counter - baseline.counter
        if (delta > 0) return { mass: delta, source: 'provider-counter' }
      }
    }
    return { mass: this.episodeTokenMass, source: 'shape' }
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
    /**
     * The model is not generating while a tool runs, so the episode is cleared
     * rather than frozen: MiMo has no agentic tool wait, and continuing its
     * decay across one would charge a tool's wall time to the model's clock
     * (§9). The next attempt starts its own episode from zero.
     */
    this.clearEpisode()
    this.streamingPhase = null
    this.attemptId = null
    this.usage = null
    this.lastPositiveReasoningRate = null
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
    this.clearEpisode()
    this.lastPositiveReasoningRate = null
    this.attemptId = null
    this.usage = null
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
   * The live rate of the active episode at `nowMs`, or `null` while the episode
   * is still below the shared publication policy.
   *
   * Two gates, one contract (`src/core/rate-publication.js`): at least
   * `MIN_RATE_SAMPLES` contributing samples **and** at least
   * `MIN_RATE_ELAPSED_MS` since the episode opened. A non-positive elapsed time
   * yields no rate at all rather than a division, and a quotient below the
   * horizon is not published as a small number — it is not published.
   *
   * The quotient is rounded with `Math.round`, MiMo's observed rule. There is no
   * clamp of any kind on a rate that passes both gates.
   */
  episodeRate(nowMs) {
    if (this.episodeStartMs === null) return null
    const elapsed = nowMs - this.episodeStartMs
    if (!rateAvailability({ sampleCount: this.episodeSampleCount, elapsedMs: elapsed }).publishable) return null
    const { mass } = this.episodeMass()
    return Math.round(mass * 1000 / elapsed)
  }

  /**
   * Why the episode has no publishable rate yet, or `null` when it has one (or
   * when no episode exists). Diagnostics only: the presentation reads `tps`.
   */
  episodeRateGate(nowMs) {
    if (this.episodeStartMs === null) return null
    return rateAvailability({ sampleCount: this.episodeSampleCount, elapsedMs: nowMs - this.episodeStartMs })
  }

  /**
   * The published live rate: the episode's own rate, or — for the first second
   * of a fresh output episode that has no valid positive rate yet — the last
   * positive reasoning rate (§15). A valid positive output estimate is never
   * overwritten.
   */
  publishedRate(nowMs) {
    const rate = this.episodeRate(nowMs)
    if (rate !== null && rate > 0 && this.streamingPhase === PHASE.REASONING) {
      this.lastPositiveReasoningRate = rate
      return { tps: rate, guard: false }
    }
    if (this.streamingPhase === PHASE.OUTPUT
      && (rate === null || rate <= 0)
      && this.lastPositiveReasoningRate !== null
      && this.episodeStartMs !== null
      && nowMs - this.episodeStartMs <= FIRST_OUTPUT_GUARD_MS) {
      return { tps: this.lastPositiveReasoningRate, guard: true }
    }
    return { tps: rate, guard: false }
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

    if (this.phase === LivePhase.STREAMING && this.attemptId !== null) {
      const { tps, guard } = this.publishedRate(now)
      const gate = tps === null && !guard ? this.episodeRateGate(now) : null
      return {
        ...base,
        tps,
        /**
         * Live TPS is a shape estimate anchored to nothing yet: DSH streams no
         * per-delta token counts, so the value cannot be `exact` until provider
         * usage arrives and calibration happens after settlement.
         */
        tpsQuality: tps === null ? MetricQuality.UNAVAILABLE : MetricQuality.ESTIMATED,
        activePhase: this.activePhase(),
        /** The episode clock the rate is measured on, for the warming presentation. */
        episodeElapsedMs: this.episodeStartMs === null ? null : Math.max(0, now - this.episodeStartMs),
        episodeSampleCount: this.episodeSampleCount,
        warmupSamples: MIN_WARMUP_SAMPLES,
        /** The other half of the shared policy, published for the warming presentation. */
        minRateElapsedMs: MIN_RATE_ELAPSED_MS,
        /**
         * Which gate withheld the rate, when one did. Diagnostics only — the
         * renderer prints the counter and never a rate — and `null` for a
         * publishable rate and for the first-output fallback, which is a
         * deliberately labelled stand-in rather than this episode's own value.
         */
        rateGateReason: gate === null ? null : gate.reason,
        /** Whether the published value is the first-output fallback, not this phase's own. */
        fallback: guard,
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
     * Pending — turn open, or an attempt begun with no generated delta yet. No
     * episode exists, so there is no rate and no clock to report: the UI shows a
     * running TTFT counter here, not a rate.
     */
    if (this.phase === LivePhase.PENDING) {
      return {
        ...base,
        tps: null,
        tpsQuality: MetricQuality.UNAVAILABLE,
        episodeElapsedMs: null,
        episodeSampleCount: 0,
      }
    }

    return { ...base, tps: null, tpsQuality: MetricQuality.UNAVAILABLE }
  }
}

export { PHASE }
