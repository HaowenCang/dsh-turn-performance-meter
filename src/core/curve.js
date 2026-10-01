/**
 * Completed-turn TPS curve: one attempt-local **phase-cumulative** throughput
 * trace per model attempt, segmented into visual phases.
 *
 * ## The statistic (Phase 9.2)
 *
 * A curve vertex at attempt-local `t` reports the same estimator family the live
 * pill publishes (docs/METRICS_SPEC.md §8.2): the generated token mass of the
 * **current phase episode** divided by the wall time elapsed since that episode
 * began —
 *
 *     tps(t) = mass(samples of the episode at or before t)
 *              / (t - first sample of that episode)
 *
 * across **all** phases — reasoning deltas, text deltas and tool-call argument
 * deltas alike — with the episode reset at every phase transition and every
 * attempt boundary. It is rounded with `Math.round`, MiMo's observed rule. There
 * is no trailing window anywhere in the rate path, and `DEFAULT_SAMPLE_EVERY_MS`
 * is a sampling decision rather than a statistical one.
 *
 * Two consequences the old trailing statistic did not have, and both are
 * deliberate:
 *
 *   - **a stall decays hyperbolically.** The numerator freezes while the
 *     denominator advances, so a silence inside one phase is visible as a
 *     continuous decay that never reaches exactly zero (§8.2.1);
 *   - **a phase transition resets the magnitude.** Each episode owns its own
 *     clock, so the trace steps down at the boundary and climbs again from the
 *     new phase's own evidence. The phase remains encoded by colour as well.
 *
 * The terminal episode may extend from its last generated delta to the attempt's
 * settlement instant: that tail is model-attempt elapsed time under the MiMo
 * definition (`docs/MIMO_RUNTIME_METRICS.md` §5.4). Tool waits and inter-attempt
 * waits still own no coordinate at all on the compressed axis.
 *
 * Curve magnitudes are `estimated` before provider usage arrives and `calibrated`
 * afterwards; they are never `exact`. `peakTps` is the maximum of the
 * **published** series — the series after `capSeriesPoints` — and it must still
 * be labelled as an estimate, because a series sample is not a provider-certified
 * maximum (docs/METRICS_SPEC.md §9).
 */

import { MetricQuality } from './metric-quality.js'
import { buildPhaseEpisodes } from './phase-duration.js'
import { RateUnavailable, rateAvailability } from './rate-publication.js'

export const DEFAULT_SAMPLE_EVERY_MS = 100

/**
 * Largest number of points one attempt's MiMo-style throughput series may store.
 *
 * MiMo resamples any longer raw series to exactly 200 evenly spaced points, each
 * taken as the nearest raw sample and with no interpolation
 * (`docs/MIMO_RUNTIME_METRICS.md` §7). The cap is a *stored-series* fidelity
 * decision: the published peak is the maximum of this series, exactly as MiMo's
 * `peakTps` is the maximum of its published series, so a value the resampling
 * skips is a value the card does not report.
 */
export const MAX_SERIES_POINTS = 200

/** Largest rendered series the SVG layer is allowed to receive. */
export const DEFAULT_MAX_POINTS = 512

/**
 * Largest number of vertices **one chart** may receive across every series, every
 * run and both phases.
 *
 * `DEFAULT_MAX_POINTS` bounds per run, which is not a bound on a chart: a hundred
 * runs of 512 points each would be 51 200 SVG vertices, and the card renders inside
 * a conversation that may hold several of them. This is the budget the settled
 * snapshot actually allocates, and `allocateRunBudgets` is what divides it.
 */
export const MAX_RENDER_POINTS_TOTAL = 512

/**
 * Smallest budget that can hold the guaranteed anchors: the first point, the last
 * point and the global maximum are three distinct indices in the worst case.
 * A smaller budget is unsatisfiable rather than merely tight.
 */
export const MIN_MAX_POINTS = 3

function assertPositive(value, label) {
  if (!(Number.isFinite(value) && value > 0)) throw new TypeError(`${label} must be a finite number > 0`)
}

/**
 * Authoritative stream ordinal of one sample.
 *
 * The order in which a model's deltas were delivered is **evidence**, and it is the only
 * evidence there is for which of two simultaneous samples is the newer one. DSH carries it
 * twice — the transient frame index and the durable compact stream member order — and both
 * reconstruct into the stored attempt's `samples` array in that order, which
 * `compressAttempts` publishes per sample as `sampleOrder`.
 *
 * A sample that already carries the ordinal keeps it. One that does not takes its position
 * in the list it arrived in, which is the same fact stated by the array itself and is what
 * keeps a direct caller of `cumulativePhaseTpsSeries` well defined.
 */
function ordinalOf(sample, index) {
  return Number.isFinite(sample?.sampleOrder) ? sample.sampleOrder : index
}

/**
 * Ascending instant, then the authoritative stream ordinal — **never** the phase.
 *
 * The second key is load-bearing rather than cosmetic. `activePhase` is the label of the
 * newest sample at or before a vertex, and a reasoning delta and a text delta can share one
 * timestamp, so something has to decide which of them is newer. The previous revision
 * decided it with a fixed phase hierarchy (`reasoning` before `output`, so `output` always
 * won) on the reasoning that a deterministic rule beats the sort's stability. Determinism
 * is not the same as agreement: `LiveMeter.streamingPhase` is the phase of the last
 * **accepted** sample, so for a pair delivered text-then-reasoning the live pill says
 * `reasoning` while the completed vertex said `output`. Two halves of one project
 * disagreed about one stream.
 *
 * Ordering by the ordinal reproduces the live semantics exactly, because the ordinal *is*
 * the live order. It does not weaken reproducibility: the ordinal is derived from the
 * stored evidence, not from which array the transport happened to hand the curve. And it
 * decides only which of two simultaneous samples is the newer one — the episode a vertex
 * belongs to, and therefore its label — never a value the evidence does not contain
 * (`test/curve-stream-order.test.js`).
 */

/**
 * Phase-cumulative TPS trace of one attempt, over **every** generated sample of that attempt.
 *
 * Each vertex reports the cumulative phase average of the episode in force at that
 * instant: the mass of the current phase episode at or before the vertex, divided
 * by the wall time since that episode's first sample. The episode is the maximal
 * run of consecutive samples carrying one phase, so it restarts at every phase
 * transition — the number therefore steps down at a boundary and climbs again on
 * the new phase's own evidence, and it decays hyperbolically (never to zero by
 * rule) across a silence, because the numerator freezes while the denominator
 * advances.
 *
 * **The vertex grid is per episode.** Every episode is sampled on **its own**
 * ladder — `episodeStart, episodeStart + sampleEveryMs, …` up to the instant the
 * next episode opens (or the attempt's own end, for the terminal episode) — and
 * the attempt's end instant is a vertex whether or not it falls on a ladder.
 *
 * The previous revision used one attempt-global ladder. That grid is what made a
 * phase episode opening between two of its instants acquire a first denominator
 * of nothing but the remainder of a step: an episode opening at 250 ms was first
 * measured over `300 - 250 = 50 ms`, and one opening at 299 ms over a single
 * millisecond. Those quotients were published, and `peakTps` is a maximum, so
 * they became the turn's peak. Sampling each episode from its own origin removes
 * the class of vertex rather than filtering its value afterwards: a denominator
 * between 1 and 99 ms no longer exists on the grid.
 *
 * Nothing is sampled after the attempt's end: a vertex past it measures elapsed
 * time the model never had, and on the completed chart it would carry a
 * coordinate larger than `curve.durationMs` and be clamped onto `x = 100`
 * (`test/curve-axis-endpoint.test.js`).
 *
 * **A vertex is a measurement only when the shared publication policy says so.**
 * `src/core/rate-publication.js` requires at least `MIN_RATE_SAMPLES` contributing
 * samples *and* at least `MIN_RATE_ELAPSED_MS` of the episode's own clock. A
 * vertex that fails either gate carries `tps: null` — never `0` — together with
 * the episode facts that explain the refusal (`rateUnavailableReason`,
 * `episodeElapsedMs`, `episodeSampleCount`, `episodeMass`). "Not measured yet" and
 * "measured zero" are different facts, and the chart draws the first as a gap.
 * There is no clamp, no smoothing and no ceiling anywhere in this path: a rate
 * that passes both gates is published exactly as computed.
 *
 * **A phase is never filtered out.** What a phase contributes here is the
 * `activePhase` **label** on each vertex — the phase of the latest generated sample
 * at or before that instant, which is `LiveMeter.streamingPhase` restated — and its
 * own episode clock. There is no per-phase filter that could produce two partial
 * rates of one stream.
 *
 * **One clock, one attempt.** This function has no notion of an attempt, so calling
 * it across an attempt boundary bridges two model calls — the exact defect Phase 6
 * removed. Completed curves go through `attemptTraces`, which calls it once per
 * attempt; the concatenating overload here exists for callers that genuinely hold a
 * single uninterrupted stream.
 *
 * `fromMs`/`toMs`/`offsetMs` express "sample a bounded stretch of one attempt's
 * local clock" without weakening the above: the episode structure is always measured
 * on the same coordinate the samples carry, and `offsetMs` only relabels the emitted
 * `timeMs`. A bounded call therefore never reaches outside `[fromMs, toMs]`.
 *
 * @param {readonly object[]} samples samples carrying `activeTimeMs`, `phase` and `tokens`/`weight`
 * @param {{
 *   sampleEveryMs?:number,
 *   durationMs?:number,
 *   fromMs?:number,
 *   toMs?:number,
 *   offsetMs?:number,
 *   sampleEndMs?:number,
 *   cuts?:readonly {activeTimeMs:number, phase:string|null}[],
 * }} [options]
 *   `cuts` are the attempt's **non-magnitude phase boundaries** on the same
 *   coordinate the samples carry. Each one ends the episode in force at its own
 *   instant and opens nothing, so the stretch that follows it belongs to no
 *   episode and is drawn as a hole rather than as a decay of the phase that had
 *   already stopped (`docs/METRICS_SPEC.md` §8.7).
 * @returns {{
 *   timeMs:number, localMs:number, tps:number|null,
 *   publishable:boolean, rateUnavailableReason:string|null,
 *   activePhase:string|null, attemptId:string|null,
 *   episodeStartMs:number|null, episodeEndMs:number|null, episodeElapsedMs:number,
 *   episodeSampleCount:number, episodeMass:number,
 * }[]}
 */
export function cumulativePhaseTpsSeries(samples, options = {}) {
  const sampleEveryMs = options.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS
  assertPositive(sampleEveryMs, 'sampleEveryMs')

  const filtered = (Array.isArray(samples) ? samples : [])
    /**
     * The authoritative ordinal is attached to a **copy**, so the caller's sample objects
     * are never written to, and the sort below has one key to read per entry rather than a
     * side lookup into the input array.
     */
    .map((sample, index) => (sample === null || sample === undefined
      ? null
      : { ...sample, sampleOrder: ordinalOf(sample, index) }))
    .filter(sample => sample !== null && Number.isFinite(sample.activeTimeMs))
    /**
     * Ascending instant, then the authoritative ordinal. See `ordinalOf` above: the second
     * key reproduces `LiveMeter.streamingPhase`'s answer for a simultaneous pair instead of
     * imposing a phase hierarchy on it.
     */
    .sort((a, b) => a.activeTimeMs - b.activeTimeMs || a.sampleOrder - b.sampleOrder)

  /**
   * The attempt's phase cuts on this call's own coordinate. A cut without a finite
   * instant cannot bound anything and is dropped rather than given a default clock;
   * a cut that declares no phase is likewise inert, because "which phase started"
   * is not evidence it carries.
   */
  const cuts = (Array.isArray(options.cuts) ? options.cuts : [])
    .filter(cut => cut && Number.isFinite(cut.activeTimeMs))
    .map(cut => ({ timeMs: cut.activeTimeMs, phase: cut.phase ?? null }))

  const offsetMs = Number.isFinite(options.offsetMs) ? options.offsetMs : 0
  const sampleEnd = Math.max(0, filtered.length > 0 ? filtered[filtered.length - 1].activeTimeMs : 0)
  const toMs = Number.isFinite(options.toMs) ? Math.max(0, options.toMs)
    : (Number.isFinite(options.durationMs) ? Math.max(0, options.durationMs) : sampleEnd)
  const fromMs = Number.isFinite(options.fromMs) ? Math.max(0, options.fromMs) : 0
  /**
   * `sampleEndMs` is where the attempt stops producing *or settles* — the terminal
   * episode's own end instant — and it is also the last instant the trace is sampled
   * at. `toMs` bounds it from above so a bounded call still never reaches outside
   * `[fromMs, toMs]`.
   */
  const sampleEndMs = Number.isFinite(options.sampleEndMs)
    ? Math.max(0, options.sampleEndMs)
    : Math.max(0, Math.min(sampleEnd, toMs))
  const bodyEndMs = Math.max(fromMs, Math.min(sampleEndMs, toMs))

  /**
   * The episodes, from the shared rule (`src/core/phase-duration.js`): maximal runs
   * of consecutive same-phase samples, each closed by the next episode's opening
   * sample, by a **phase cut** that declares a different phase, or — for the
   * terminal episode — by the attempt's own end instant. The summary that prints
   * the phase rates reads the same function, so the chart and the numbers beside it
   * cannot disagree about where a phase stopped.
   */
  const { episodes, episodeIndexBySample } = buildPhaseEpisodes(
    filtered.map(sample => ({
      timeMs: sample.activeTimeMs,
      phase: sample.phase ?? null,
      tokens: sample.tokens,
      weight: sample.weight,
    })),
    { cuts, endMs: bodyEndMs },
  )

  /**
   * **Each episode's own ladder**, from its own origin. A non-terminal episode is
   * sampled up to the instant it ends — the next episode's opening sample, or the
   * cut that closed it — and the terminal one runs to the attempt's end instant.
   * The closing instant is emitted explicitly, so a cut that falls off the cadence
   * (an episode ending at 120 ms on a 100 ms ladder) is still a vertex: it is the
   * instant the phase stopped, and the curve's own endpoint guarantee is exactly
   * that promise. Instants are built by multiplication rather than by accumulating
   * `+=`, so floating-point error over a ten-minute turn cannot put the last vertex
   * off the grid it claims to be on.
   */
  const instants = []
  for (const episode of episodes) {
    const boundMs = episode.boundMs === null ? bodyEndMs : Math.min(episode.boundMs, bodyEndMs)
    if (!(episode.startMs <= boundMs + 1e-9)) continue
    for (let step = 0; ; step += 1) {
      const at = episode.startMs + step * sampleEveryMs
      if (at > boundMs + 1e-9) break
      if (at >= fromMs - 1e-9 && at <= toMs + 1e-9) instants.push(at)
    }
    if (episode.closedByCut && boundMs >= fromMs - 1e-9 && boundMs <= toMs + 1e-9) instants.push(boundMs)
  }
  instants.sort((a, b) => a - b)
  const vertices = []
  for (const at of instants) {
    if (vertices.length === 0 || at > vertices[vertices.length - 1] + 1e-9) vertices.push(at)
  }
  /**
   * The attempt's own end instant is unconditional **while an episode is still in
   * force there**: an attempt settling at 510 ms is sampled at its own
   * `…, 500, 510`, so the instant its clock stopped is always drawn and the trace
   * cannot end short of the axis it is drawn against. A cut-closed terminal episode
   * is the one exception, and it is not a special case but the same rule: the
   * attempt's end belongs to no episode, so there is no phase to label a vertex
   * there with and nothing is emitted for it.
   */
  const terminal = episodes.length > 0 ? episodes[episodes.length - 1] : null
  const terminalBoundMs = terminal === null
    ? null
    : (terminal.boundMs === null ? bodyEndMs : Math.min(terminal.boundMs, bodyEndMs))
  const endIsInForce = terminal === null || Math.abs(terminalBoundMs - bodyEndMs) <= 1e-9
  if (endIsInForce
    && (vertices.length === 0 || bodyEndMs > vertices[vertices.length - 1] + 1e-9)
    && bodyEndMs >= fromMs - 1e-9) {
    vertices.push(bodyEndMs)
  }

  /**
   * The episode cursors. `newest` is the index of the newest sample at or before the
   * current instant and `episodePos` the index of the episode in force there; the
   * pair advance monotonically with the instant, so the trace is linear in the
   * sample count. `episodeMass` and `episodeSampleCount` accumulate the episode in
   * force and reset the moment a sample belonging to another one arrives.
   */
  let newest = -1
  let episodePos = -1
  let massCursor = -1
  let episodeMass = 0
  let episodeSampleCount = 0

  const result = []
  for (const localMs of vertices) {
    while (newest + 1 < filtered.length && filtered[newest + 1].activeTimeMs <= localMs) {
      newest += 1
      const sample = filtered[newest]
      const weight = sample.tokens ?? sample.weight ?? 0
      const owner = episodeIndexBySample[newest]
      /**
       * A sample whose phase differs from the episode in force **opens** a new
       * episode at its own instant: the previous phase's elapsed time and mass are
       * not carried into it. So does a sample of the *same* phase when a cut has
       * closed the previous episode in between — the boundary, not the phase name,
       * is what ended that episode.
       */
      if (owner !== massCursor) {
        massCursor = owner
        episodeMass = 0
        episodeSampleCount = 0
      }
      episodeMass += weight
      episodeSampleCount += 1
    }
    while (episodePos + 1 < episodes.length && episodes[episodePos + 1].startMs <= localMs + 1e-9) {
      episodePos += 1
    }
    const episode = episodePos >= 0 ? episodes[episodePos] : null
    const boundMs = episode === null
      ? null
      : (episode.boundMs === null ? bodyEndMs : Math.min(episode.boundMs, bodyEndMs))
    /**
     * No episode is in force at this instant. With a per-episode ladder the only
     * instants emitted outside every episode are a bounded call's `fromMs`… and
     * none exist at all while no sample has arrived — and then the honest answer is
     * that no episode exists, not that the rate is zero.
     */
    if (episode === null || localMs < episode.startMs - 1e-9 || localMs > boundMs + 1e-9) {
      result.push({
        timeMs: offsetMs + localMs,
        localMs,
        tps: null,
        publishable: false,
        rateUnavailableReason: RateUnavailable.NO_EPISODE,
        activePhase: null,
        attemptId: null,
        episodeStartMs: null,
        episodeEndMs: null,
        episodeElapsedMs: 0,
        episodeSampleCount: 0,
        episodeMass: 0,
      })
      continue
    }
    const startMs = episode.startMs
    const elapsed = localMs - startMs
    const gate = rateAvailability({ sampleCount: episodeSampleCount, elapsedMs: elapsed })
    result.push({
      timeMs: offsetMs + localMs,
      localMs,
      /**
       * `Math.round` is MiMo's observed rule for every published rate. A vertex
       * that fails either gate publishes **nothing**: `null` is not a rate, and a
       * `0` here would be read as a measured zero by every consumer that does not
       * consult `publishable`.
       */
      tps: gate.publishable ? Math.round(episodeMass * 1000 / elapsed) : null,
      publishable: gate.publishable,
      rateUnavailableReason: gate.reason,
      /**
       * The label is the phase of the **episode in force**, which for a vertex
       * shared with the next episode is that episode's phase — the same answer
       * `filtered[newest].phase` gave before cuts existed, since an episode's own
       * vertices and its newest sample carry one phase.
       */
      activePhase: episode.phase,
      attemptId: filtered[newest]?.attemptId ?? null,
      episodeStartMs: startMs,
      /**
       * The instant this episode ends: the next episode's opening sample, the cut
       * that closed it, or the attempt's own end. It is what tells two neighbouring
       * stretches whether they meet on one vertex — see `visualRunsOf`.
       */
      episodeEndMs: boundMs,
      episodeElapsedMs: elapsed,
      episodeSampleCount,
      episodeMass,
    })
  }
  return result
}

/**
 * Resample one published series to at most `maxPoints`, nearest-neighbour, no interpolation.
 *
 * This is the stored-series cap MiMo applies to its own throughput series
 * (`docs/MIMO_RUNTIME_METRICS.md` §7): a series longer than the cap is reduced to
 * **exactly** `maxPoints` points evenly spaced in time across the full span, each
 * target taking the raw sample nearest to it. The selected entries are the source
 * objects themselves — nothing is averaged, smoothed or invented, and a source
 * sample may be selected twice when two targets fall closest to it.
 *
 * A series at or below the cap is returned unchanged (a copy of the array, same
 * objects), so the cap never perturbs evidence that already fits.
 *
 * @param {readonly {timeMs:number}[]} series ascending in `timeMs`
 * @param {number} [maxPoints] the stored-series cap
 * @returns {object[]} at most `maxPoints` points, ascending, drawn from the input
 */
export function capSeriesPoints(series, maxPoints = MAX_SERIES_POINTS) {
  const points = Array.isArray(series) ? series : []
  if (!(Number.isFinite(maxPoints) && maxPoints >= 2)) {
    throw new TypeError('maxPoints must be a finite number >= 2')
  }
  if (points.length <= maxPoints) return points.slice()

  const first = Number.isFinite(points[0]?.timeMs) ? points[0].timeMs : 0
  const last = Number.isFinite(points[points.length - 1]?.timeMs) ? points[points.length - 1].timeMs : first
  const span = last - first
  const selected = []
  /**
   * One monotone cursor serves every target: the targets ascend, so the nearest
   * sample's index can never move backwards, and a tie resolves to the earlier
   * sample. That makes the result a pure function of the input.
   */
  let cursor = 0
  for (let index = 0; index < maxPoints; index += 1) {
    const target = first + (span * index) / (maxPoints - 1)
    while (cursor + 1 < points.length
      && Math.abs(points[cursor + 1].timeMs - target) < Math.abs(points[cursor].timeMs - target)) {
      cursor += 1
    }
    selected.push(points[cursor])
  }
  return selected
}

/**
 * One attempt's phase-cumulative throughput trace, measured on its own clock and relabelled.
 *
 * Each attempt is measured on its **own** local clock and only then relabelled to
 * the turn's compressed coordinate by `attemptTimeMs + segment.startMs`. Two
 * attempts that share the compressed coordinate `x` therefore share no episode
 * clock: the last vertex of A and the first vertex of B are computed from disjoint
 * sample sets, whatever the x distance between them happens to be.
 *
 * **A trace is sampled from the attempt's first delta to the attempt's own end
 * instant.** The sampled instants are the union of two sets:
 *
 *   - the attempt's own cadence ladder, `0, sampleEveryMs, 2 * sampleEveryMs, …`, up
 *     to that end instant;
 *   - the end instant itself.
 *
 * The attempt's end instant is the one `compressAttempts` computed for it — the
 * attempt's terminal episode end, i.e. its settlement instant when one is known and
 * its last generated delta otherwise — so the terminal phase is drawn across the
 * final generated-delta → settlement tail, which is model-attempt elapsed time under
 * the MiMo-style definition. The trace and the compressed axis therefore cannot
 * disagree about where the attempt ended.
 *
 * The union is what makes the attempt's **real** endpoint a vertex even when it does
 * not fall on the cadence: a call settling at 510 ms is sampled at
 * `0, 100, 200, 300, 400, 500, 510`, so the instant its clock stopped is always
 * drawn. Deduplication keeps an on-cadence endpoint from being emitted twice.
 *
 * Every attempt obeys this identically, so the final attempt is not a special case
 * and no attempt receives synthetic width merely for being last. Tool waits,
 * inter-attempt waits and next-call TTFT still own no coordinate at all: they lie
 * between one attempt's settlement and the next one's first delta, where this trace
 * has no vertex and the next trace's local zero is the same compressed coordinate.
 *
 * A real stall **inside** the attempt is preserved in full, and so is the terminal
 * tail: the numerator freezes while the denominator advances, so both are drawn as a
 * continuous hyperbolic decay rather than as a window reaching zero.
 *
 * The published `points` are the capped MiMo-style series (`capSeriesPoints`), so a
 * series longer than `MAX_SERIES_POINTS` is resampled to exactly that many
 * nearest-neighbour samples. The render budget thins the *drawing* afterwards and
 * never moves the published peak, which is read from these points.
 *
 * @param {{attemptId?:string|null, step?:number|null, startMs:number, endMs?:number,
 *   localEndMs?:number}} segment
 * @param {readonly object[]} samples compressed samples carrying `attemptId` and `activeTimeMs`
 * @param {{
 *   sampleEveryMs?:number, attemptId?:string|null, calibrated?:boolean, maxPoints?:number,
 *   temporalAllocationMode?:string|null,
 *   cuts?:readonly {attemptId?:string|null, attemptTimeMs:number, phase:string|null}[],
 * }} [options]
 *   `cuts` are the turn's non-magnitude phase boundaries on the compressed clock
 *   (`compressAttempts`); this attempt's own are selected by `attemptId` and
 *   rebased onto its local clock exactly as its samples are.
 * @returns {{
 *   attemptId:string|null, startMs:number, endMs:number, localEndMs:number,
 *   durationMs:number, sampleCount:number, tokens:number, calibratedTokens:number|null,
 *   calibrated:boolean, samples:object[], cuts:object[], points:object[], visualRuns:object[],
 *   peakProvenance:object|null,
 * }}
 */
export function attemptTrace(segment, samples, options = {}) {
  const sampleEveryMs = options.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS
  const maxPoints = options.maxPoints ?? MAX_SERIES_POINTS
  const attemptId = options.attemptId ?? segment?.attemptId ?? null
  const startMs = Number.isFinite(segment?.startMs) ? segment.startMs : 0
  const endMs = Number.isFinite(segment?.endMs) ? segment.endMs : startMs

  /**
   * Every sample of the attempt is retained, whatever its phase: an episode that
   * begins inside one phase must be cut out of the attempt's own stream, and
   * excluding samples would measure the episode against a truncated history.
   */
  const perAttempt = (Array.isArray(samples) ? samples : [])
    .filter(sample => (
      sample
      && (sample.attemptId ?? null) === attemptId
      && Number.isFinite(sample.activeTimeMs)
    ))
    .map((sample, index) => ({
      ...sample,
      activeTimeMs: Number.isFinite(sample.attemptTimeMs)
        ? Math.max(0, sample.attemptTimeMs)
        : Math.max(0, (sample.activeTimeMs ?? 0) - startMs),
      /** The authoritative ordinal, carried explicitly into the sort below. */
      sampleOrder: ordinalOf(sample, index),
    }))
    /**
     * The same tie-break `cumulativePhaseTpsSeries` applies — instant, then authoritative
     * ordinal — so the two agree on which simultaneous sample supplied a vertex's label.
     */
    .sort((a, b) => a.activeTimeMs - b.activeTimeMs || a.sampleOrder - b.sampleOrder)

  /**
   * The attempt's own phase cuts, rebased like its samples. A cut before the
   * attempt's local zero has no coordinate on this axis and is dropped here as it
   * was dropped by `compressAttempts`, which counts it on the segment.
   */
  const perAttemptCuts = (Array.isArray(options.cuts) ? options.cuts : [])
    .filter(cut => cut && (cut.attemptId ?? null) === attemptId)
    .map((cut) => {
      const localMs = Number.isFinite(cut.attemptTimeMs)
        ? cut.attemptTimeMs
        : (Number.isFinite(cut.activeTimeMs) ? cut.activeTimeMs - startMs : Number.NaN)
      return { localMs, phase: cut.phase ?? null }
    })
    .filter(cut => Number.isFinite(cut.localMs) && cut.localMs >= 0)
    .sort((a, b) => a.localMs - b.localMs)
    .map(cut => ({ timeMs: startMs + cut.localMs, localMs: cut.localMs, phase: cut.phase }))

  let tokens = 0
  let calibratedTokens = null
  for (const sample of perAttempt) {
    const value = sample.tokens ?? sample.weight ?? 0
    tokens += value
    if (sample.quality === 'calibrated') calibratedTokens = (calibratedTokens ?? 0) + value
  }

  if (perAttempt.length === 0) {
    return {
      attemptId,
      startMs,
      endMs,
      localEndMs: Math.max(0, endMs - startMs),
      durationMs: 0,
      sampleCount: 0,
      tokens: 0,
      calibratedTokens,
      calibrated: options.calibrated === true,
      samples: [],
      cuts: [],
      points: [],
      visualRuns: [],
      peakProvenance: null,
    }
  }

  const lastSampleMs = perAttempt[perAttempt.length - 1].activeTimeMs
  const boundedEndMs = Math.max(0, endMs - startMs)
  /**
   * **The trace runs to the attempt's own end instant.** `bodyEndMs` is that instant
   * — the segment's width, which is the last generated delta for an attempt whose
   * settlement is unknown and the settlement instant otherwise — and it is the only
   * bound, for every attempt including the last.
   *
   * A vertex past it would be time the attempt does not own: the chart's own
   * `durationMs` is the sum of these widths, and a vertex carrying a coordinate
   * larger than it is clamped onto `x = 100` by `xOf(timeMs, durationMs)`. Several
   * distinct instants would then land on one x coordinate and the SVG would close
   * with a vertical stroke the evidence does not contain
   * (`test/curve-axis-endpoint.test.js`).
   *
   * What this does **not** remove: a silence between two deltas *inside* the attempt
   * (the grid runs across it and the cumulative rate decays hyperbolically), and the
   * terminal generated-delta → settlement tail, which is model-attempt elapsed time
   * and therefore part of the attempt's own width.
   */
  const bodyEndMs = Math.max(lastSampleMs, boundedEndMs)
  const toMs = bodyEndMs

  const points = capSeriesPoints(cumulativePhaseTpsSeries(perAttempt, {
    sampleEveryMs,
    offsetMs: startMs,
    fromMs: 0,
    toMs,
    sampleEndMs: bodyEndMs,
    cuts: perAttemptCuts.map(cut => ({ activeTimeMs: cut.localMs, phase: cut.phase })),
  }), maxPoints)

  return {
    attemptId,
    startMs,
    endMs,
    localEndMs: boundedEndMs,
    durationMs: toMs,
    sampleCount: perAttempt.length,
    tokens,
    calibratedTokens,
    calibrated: options.calibrated === true,
    samples: perAttempt,
    /**
     * The attempt's non-magnitude phase boundaries on its own clock, exactly as the
     * estimator read them. Published rather than left implicit because they are
     * evidence the card's geometry depends on: a gap the reader sees is one of
     * these, and a diagnostic that cannot name it cannot explain the chart.
     */
    cuts: perAttemptCuts,
    points,
    visualRuns: visualRunsOf(points),
    /**
     * The attempt's own strongest **publishable** vertex, with the evidence that
     * produced it. `null` when no vertex of this attempt passed the shared
     * publication policy — see `peakTps` for why that is not `0`.
     */
    peakProvenance: peakProvenanceOf({
      attemptId,
      point: strongestPoint(points),
      samples: perAttempt,
      temporalAllocationMode: options.temporalAllocationMode ?? null,
    }),
  }
}

/**
 * One attempt's trace, cut into phase stretches that meet at a shared boundary vertex.
 *
 * This is the whole of the colour model. Each vertex carries the phase of the latest generated
 * sample at or before it, and the trace is cut where that label changes.
 *
 * ## Why the cut is the outgoing stretch's own last vertex
 *
 * `activePhase` persists until new phase evidence arrives, so a label is carried by **every**
 * vertex of the trace: there is no vertex without a phase, and therefore no silence between two
 * stretches. The maximal stretches of one label are contiguous by construction —
 * `next.first === stretch.last + 1` — and the boundary of a change is the last vertex still
 * labelled with the outgoing phase.
 *
 * The incoming coloured path opens on that same vertex, which is what makes a tone change a
 * seam rather than a hole: the two subpaths meet at one instant, one measured rate, one object.
 * The next vertex then carries the new phase.
 *
 * ## A phase cut is not a seam (Phase 9.4.3)
 *
 * A **non-magnitude phase boundary** ends the outgoing episode and opens nothing
 * (`src/core/phase-duration.js`): the incoming episode begins at its own first magnitude
 * sample, which may be far later. The two stretches are then *not* adjacent — the outgoing
 * one ends at the cut, the incoming one opens at its first sample — and sharing the seam
 * would draw the incoming tone through the outgoing episode's last measurement, publishing
 * an output rate at an instant where the output phase had produced nothing. The stretch
 * boundary is therefore stated by the episodes themselves: a run opens on the previous run's
 * closing vertex only when the outgoing episode ends exactly where the incoming one begins.
 *
 * The stretches are keyed by **episode**, not by label, for the same reason: a cut between
 * two runs of one phase (`reasoning -> output boundary -> reasoning`) leaves two episodes with
 * one label, and a label-keyed walk would merge them back across the hole.
 *
 * ## Losing the closing vertex does not reopen the hole
 *
 * The adjacency test reads `episodeEndMs` and `episodeStartMs`, which every vertex carries,
 * rather than a marker on the cut vertex alone. A capped series (`capSeriesPoints`) may drop
 * the cut instant itself, and the rule must still hold: the surviving last vertex of the
 * outgoing episode still reports the instant that episode ended, and it still does not equal
 * the incoming episode's origin.
 *
 * A long silence **is** divided between two tones when the episodes are adjacent: a silence
 * inside one phase is a stretch of zero-valued vertices that all carry that phase, and it is
 * drawn in that phase's tone at full width, because a stall inside a model call is a
 * throughput fact the chart exists to show (`docs/METRICS_SPEC.md` §8.2.1). An earlier
 * revision described the cut as "the midpoint of the label change"; for a trace whose every
 * vertex is labelled, the midpoint of two adjacent indices is `floor((last + last + 1) / 2)`,
 * which is `last` — the same index. The formula was correct and its description was not, so the
 * formula is gone and the rule is stated directly.
 *
 * The invariants this produces, and the ones the renderer and its tests rely on:
 *
 *     runs[i].endIndex === runs[i + 1].startIndex          for an adjacent pair (a seam)
 *     runs[i].endIndex + 1 === runs[i + 1].startIndex      across a cut (a hole)
 *     sum(runs[i].pointCount) === points.length + (seams)
 *
 * Statistics come first; colour segmentation is applied to them afterwards, and a vertex with
 * no sample at or before it (`activePhase === null`, which cannot occur for a non-empty trace)
 * opens a run of its own rather than being merged away.
 *
 * @param {readonly {activePhase?:string|null, episodeStartMs?:number|null,
 *   episodeEndMs?:number|null}[]} points
 * @returns {{phase:string|null, startIndex:number, endIndex:number, pointCount:number}[]}
 */
export function visualRunsOf(points) {
  const list = Array.isArray(points) ? points : []
  if (list.length === 0) return []
  const labelAt = index => list[index]?.activePhase ?? null
  /**
   * The stretch key. A trace built by `cumulativePhaseTpsSeries` publishes the
   * episode in force on every vertex, and the episode — not the phase name — is
   * what a stretch is a stretch of. A hand-built or pre-Phase-9.4.3 point list
   * carries no episode identity, and for it the label remains the whole of the
   * available structure, exactly as before.
   */
  const keyAt = index => {
    const startMs = list[index]?.episodeStartMs
    return Number.isFinite(startMs) ? `episode:${startMs}` : `phase:${String(labelAt(index))}`
  }

  /** Maximal stretches of one episode, before any boundary is shared. */
  const stretches = []
  let start = 0
  while (start < list.length) {
    const key = keyAt(start)
    let last = start
    while (last + 1 < list.length && keyAt(last + 1) === key) last += 1
    stretches.push({ phase: labelAt(start), first: start, last })
    start = last + 1
  }

  const runs = []
  for (const stretch of stretches) {
    const previous = runs[runs.length - 1]
    /**
     * A run opens on the vertex the previous one closed on, so a tone change is a seam rather
     * than a blank horizontal gap. That vertex is shared, not duplicated: it is one index in
     * the trace's own grid, emitted by both paths and charged to both by the render budget.
     * It is shared only when the two episodes really are adjacent — see `episodesMeet`.
     */
    const from = previous === undefined
      ? stretch.first
      : (episodesMeet(list[previous.endIndex], list[stretch.first]) ? previous.endIndex : stretch.first)
    /**
     * The shared vertex: the final vertex carrying this stretch's phase, which is also the
     * vertex in front of the next stretch. It is one index either way, which is what makes the
     * two subpaths meet.
     */
    const to = stretch.last
    runs.push({ phase: stretch.phase, startIndex: from, endIndex: to, pointCount: to - from + 1 })
  }
  return runs
}

/**
 * Whether two neighbouring stretches belong to episodes that meet on one instant.
 *
 * The outgoing episode ends exactly where the incoming one opens at an ordinary
 * phase transition, and then the two runs share their boundary vertex. A phase cut
 * separates them — the outgoing episode ends at the cut, the incoming one opens at
 * its own first magnitude sample — and then they must not: the vertex the outgoing
 * run closed on carries the outgoing episode's measurement and is not the incoming
 * episode's opening anchor.
 *
 * A point list that predates this evidence carries neither instant, and keeps the
 * long-standing shared-seam drawing rather than losing its tone change.
 */
function episodesMeet(previousLast, nextFirst) {
  const endMs = previousLast?.episodeEndMs
  const startMs = nextFirst?.episodeStartMs
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return true
  return Math.abs(endMs - startMs) <= 1e-9
}

/**
 * The per-attempt trace list the completed curve is drawn from, in turn order.
 *
 * `temporalAllocationModeByAttemptId` carries each attempt's calibrated
 * allocation mode (`phase-anchored` / `total-anchored` / `unanchored`) into its
 * trace, where it is published on the peak's debug provenance. The samples
 * themselves do not carry it — it is a property of the attempt's calibration, not
 * of one delta — so it travels beside them rather than being inferred from them.
 *
 * @param {readonly object[]} segments `compressAttempts` segments, in turn order
 * @param {readonly object[]} samples `compressAttempts` samples
 * @param {{sampleEveryMs?:number, maxPoints?:number,
 *   cuts?:readonly object[],
 *   calibratedAttemptIds?:ReadonlySet<string|null>,
 *   temporalAllocationModeByAttemptId?:Map<string|null, string|null>}} [options]
 * @returns {object[]} one trace per segment that produced evidence
 */
export function attemptTraces(segments, samples, options = {}) {
  const ordered = (Array.isArray(segments) ? segments : []).filter(
    segment => segment && typeof segment === 'object' && Number.isFinite(segment.startMs),
  )
  const calibrated = options.calibratedAttemptIds
  const allocationModes = options.temporalAllocationModeByAttemptId instanceof Map
    ? options.temporalAllocationModeByAttemptId
    : null
  const traces = []
  for (const segment of ordered) {
    const trace = attemptTrace(segment, samples, {
      sampleEveryMs: options.sampleEveryMs,
      maxPoints: options.maxPoints,
      cuts: options.cuts,
      calibrated: calibrated instanceof Set ? calibrated.has(segment.attemptId ?? null) : false,
      temporalAllocationMode: allocationModes === null
        ? null
        : (allocationModes.get(segment.attemptId ?? null) ?? null),
    })
    if (trace.points.length === 0) continue
    traces.push(trace)
  }
  return traces
}

/**
 * Peak across any number of **published** series.
 *
 * The peak is a statistic over the series the card publishes — the capped
 * MiMo-style series — which is exactly MiMo's own definition: its `peakTps` is the
 * maximum of the *published* series, not of the raw one
 * (`docs/MIMO_RUNTIME_METRICS.md` §7). The render budget thins the *drawing*
 * afterwards and must not be read here: taking the maximum of the drawn points
 * would make a chart setting silently change a number the card reports, which is
 * the one direction this statistic still refuses.
 *
 * **Only publishable vertices compete.** Every vertex below the shared
 * publication policy (`src/core/rate-publication.js`) carries `tps: null` and is
 * skipped by the `Number.isFinite` test, which is what keeps an episode opening
 * anchor, a sub-100 ms denominator and a below-warm-up vertex out of the peak.
 * A number that passes the gates is never clamped: this function takes a maximum
 * and does nothing else to it.
 *
 * **`null` when nothing is publishable.** An attempt whose every episode is
 * below the gates has no measured rate at all, and `0` would be a fabricated
 * measurement of zero throughput. The UI prints `—` for `null`.
 *
 * @param {...(readonly {tps?:number|null}[])} seriesList
 * @returns {number|null}
 */
export function peakTps(...seriesList) {
  let peak = null
  for (const series of seriesList) {
    if (!Array.isArray(series)) continue
    for (const point of series) {
      const value = point?.tps
      if (!Number.isFinite(value)) continue
      if (peak === null || value > peak) peak = value
    }
  }
  return peak
}

/** Whether one vertex is a publishable measurement. */
function isMeasured(point) {
  return Number.isFinite(point?.tps)
}

/**
 * The strongest publishable vertex of one series, or `null`.
 *
 * Ties resolve to the earliest vertex, so a provenance record is a pure function
 * of the evidence rather than of the order two equal maxima happened to be
 * emitted in.
 */
function strongestPoint(points) {
  let best = null
  for (const point of points) {
    if (!isMeasured(point)) continue
    if (best === null || point.tps > best.tps) best = point
  }
  return best
}

/**
 * The sample quality of an episode's contributing samples.
 *
 * `calibrated` requires **every** contributing sample to carry a provider-anchored
 * magnitude; a mixture is reported as `mixed` rather than rounded to either end,
 * because the two answers mean different things to a reader diagnosing a spike.
 */
function sampleQualityOf(samples) {
  if (samples.length === 0) return null
  let calibrated = 0
  let estimated = 0
  for (const sample of samples) {
    if (sample?.quality === MetricQuality.CALIBRATED) calibrated += 1
    else estimated += 1
  }
  if (estimated === 0) return MetricQuality.CALIBRATED
  if (calibrated === 0) return MetricQuality.ESTIMATED
  return 'mixed'
}

/**
 * Debug-only provenance for one published peak.
 *
 * Phase 9.4 added this because the peak stopped being explainable by its value
 * alone: the defect it fixes was a peak produced by a denominator nobody could
 * see on the chart. Every field here is evidence the estimator already held —
 * the episode's origin, its elapsed clock, its contributing sample count and
 * mass, the calibration mode, and the timestamps of the samples that produced
 * the winning vertex — so a diagnostic can say *why* a number is the maximum.
 *
 * It is **diagnostics only** and must not reach a renderer: nothing in
 * `src/client` reads `peakProvenance`, and `test/curve-rate-publication.test.js`
 * asserts that the rendered view model does not carry it.
 */
function peakProvenanceOf({ attemptId, point, samples, temporalAllocationMode }) {
  if (point === null) return null
  const contributing = samples.filter(sample => (
    Number.isFinite(sample?.activeTimeMs)
    && Number.isFinite(point.episodeStartMs)
    && sample.activeTimeMs >= point.episodeStartMs
    && sample.activeTimeMs <= point.localMs
    && (sample.phase ?? null) === (point.activePhase ?? null)
  ))
  const quality = sampleQualityOf(contributing)
  return {
    attemptId,
    phase: point.activePhase ?? null,
    episodeStartMs: point.episodeStartMs ?? null,
    pointTimeMs: point.timeMs,
    elapsedMs: point.episodeElapsedMs ?? 0,
    episodeSampleCount: point.episodeSampleCount ?? 0,
    episodeMass: point.episodeMass ?? 0,
    temporalAllocationMode: temporalAllocationMode ?? null,
    calibrated: quality === MetricQuality.CALIBRATED,
    sampleQuality: quality,
    contributingSampleTimes: contributing.map(sample => sample.activeTimeMs),
    tps: point.tps,
  }
}

/**
 * Colour segmentation of the attempt traces, keyed by phase.
 *
 * This is the phase-keyed view of the same runs `attemptTrace().visualRuns` publishes
 * per attempt, and it exists because two callers want different keys for one fact:
 * the chart draws per attempt, and a diagnostic or a test asks "where does reasoning
 * have evidence at all". Deriving both from one `visualRunsOf` pass is what keeps
 * them from drifting apart.
 *
 * A phase that produced nothing has no run. That is an absence of evidence, and it is
 * never drawn as a flat zero line: "never reasoned here" and "reasoning throughput
 * fell to zero" are different facts.
 *
 * @param {readonly object[]} traces `attemptTraces` output
 * @returns {{reasoning: object[], output: object[]}} runs in draw order
 */
export function phaseRuns(traces) {
  const out = { reasoning: [], output: [] }
  for (const trace of Array.isArray(traces) ? traces : []) {
    for (const run of trace?.visualRuns ?? []) {
      if (run.phase !== 'reasoning' && run.phase !== 'output') continue
      const points = (trace.points ?? []).slice(run.startIndex, run.endIndex + 1)
      if (points.length === 0) continue
      out[run.phase].push({
        attemptId: trace.attemptId ?? null,
        phase: run.phase,
        startMs: points[0].timeMs,
        endMs: points[points.length - 1].timeMs,
        startIndex: run.startIndex,
        endIndex: run.endIndex,
        pointCount: points.length,
        points,
      })
    }
  }
  return out
}

/**
 * Single-interval evidence view, retained for callers that only ask when a phase
 * began and ended.
 *
 * It is derived from `phaseRuns`, so it can never disagree with the colour
 * segmentation. It must not be used to decide what to draw: between the first and
 * last run of a phase there may be stretches where the phase is absent, and this
 * shape cannot express that.
 *
 * @deprecated for rendering — use `phaseRuns` or `attemptTrace().visualRuns`.
 */
export function phaseSpans(traces) {
  const runs = phaseRuns(traces)
  const outer = list => (list.length === 0
    ? null
    : { startMs: list[0].startMs, endMs: list[list.length - 1].endMs })
  return { reasoning: outer(runs.reasoning), output: outer(runs.output) }
}

/** Rate a series' point carries, in either supported field spelling. */
function rateOf(point) {
  const value = point?.tps ?? point?.tokens ?? point?.weight
  return Number.isFinite(value) ? value : null
}

/**
 * What a run costs to draw **at all**, which is not what it could be thinned to.
 *
 * A run of one or two vertices is already at full resolution: `downsampleSeries`
 * refuses a budget below `MIN_MAX_POINTS` precisely because it cannot honour the
 * three anchors, and duplicating a vertex to reach the minimum would draw a segment
 * the data does not contain. Its irreducible cost is therefore its own length. Every
 * longer run costs `MIN_MAX_POINTS`, the smallest allowance that keeps its first
 * point, its last point and its maximum.
 *
 * This is the unit the allocation is denominated in, and stating it as a function of
 * length alone is what makes the priority order total: every run is comparable to
 * every other, whatever their lengths, so no priority band can end at a length
 * boundary.
 */
export function minimumRunCost(length) {
  if (!Number.isFinite(length) || length <= 0) return 0
  return length < MIN_MAX_POINTS ? length : MIN_MAX_POINTS
}

/**
 * Divide one chart-wide rendering budget across the runs that will be drawn.
 *
 * `downsampleSeries` bounds *one* run. Nothing bounded the sum, so the SVG could
 * grow with the number of episodes: a turn with a hundred phase alternations
 * produced a hundred runs of up to 512 vertices each, and the card's element count
 * became a function of the model's delivery pattern rather than of a design
 * decision. This function is the missing global bound.
 *
 * Three constraints, in priority order, because a budget smaller than the number of
 * runs must degrade predictably rather than silently:
 *
 *   1. **The global peak keeps a drawable budget — whatever length its run is.** The
 *      run whose series carries the chart's maximum rate is seated first and is never
 *      thinned to a point per run. Without this, a many-run turn could drop the one
 *      vertex the card's printed peak refers to, and the chart would contradict its
 *      own number.
 *   2. **Every run keeps its own first and last vertex.** `downsampleSeries` treats
 *      those as unconditional anchors, so a run whose allocation is below its
 *      irreducible cost cannot honour the anchors its own contract promises.
 *      Allocations are therefore `0` or at least `minimumRunCost(length)`, and a `0`
 *      is an explicit "not drawable", not a silently truncated run.
 *   3. **Remaining budget is shared out in the ranked order**, which serves the
 *      shorter run first whenever two runs cost the same. Above `MIN_MAX_POINTS`
 *      every run costs three, so the length tie-break decides most charts, and it
 *      resolves towards the shorter run: a long stretch is described by fewer
 *      vertices before a dense one is topped up, because the short run is the one
 *      whose whole shape still fits. Ranking by length is the cheapest approximation
 *      of vertex density that does not require inspecting the values here, and it is
 *      deterministic.
 *
 * ## One priority order, not one per run length
 *
 * Phase 7A implemented the above as two passes partitioned by length: long runs were
 * seated in ranked order, then the one- and two-vertex runs were served **in raw index
 * order**. The peak band existed only inside the first pass, so it vanished exactly at
 * the class boundary. A chart whose maximum lived in a one-vertex run — a single heavy
 * delta in an attempt of zero width, which `compressAttempts` produces routinely — was
 * skipped by the anchor pass for being short and then competed in the second pass as an
 * ordinary run, on index alone. Two ordinary short runs ahead of it consumed the last
 * vertices of a saturated budget and the peak was refused:
 *
 *     170 runs x 3 vertices = 510 allocated; remaining 2
 *     index 170 (tps 10) -> 1, index 171 (tps 20) -> 1, index 172 (tps 9999) -> 0
 *
 * The repair is not a third pass. It is a single order over all runs, ranked by
 * retention priority and denominated in `minimumRunCost`, so "the peak-bearing run is
 * first" is a property of the whole allocation rather than of one of its stages. A
 * one-vertex run is not a lesser citizen of that order; it is simply the cheapest one.
 *
 * The allocation is a **pure function of run lengths and the budget**, and it is
 * applied per run. Flattening the runs into one series, downsampling that and
 * cutting it back apart is the one construction this module forbids: the cut points
 * would not fall on run boundaries, so a bridged line could appear across a stretch
 * where the phase produced nothing.
 *
 * Degradation policy when even the anchors do not fit: runs are refused in reverse
 * priority order, so the peak-bearing run is the last to be refused, and a run
 * given `0` is reported as `points: 0` with `degraded: true`. A caller must render
 * it as absent. The policy is stated rather than implied because an unbounded DOM is
 * the failure mode this function exists to remove.
 *
 * `peakRetained` reports whether the maximum actually survived. It is `false` only in
 * the formal corner where `minimumRunCost` of the peak-bearing run exceeds the whole
 * budget — unreachable at `MAX_RENDER_POINTS_TOTAL` (512), where the cost is at most
 * `MIN_MAX_POINTS` — and it exists so that corner cannot be reported as a preservation.
 *
 * @param {readonly {points?: readonly unknown[], length?: number}[]} runs in draw order
 * @param {number} [totalBudget] chart-wide vertex budget
 * @returns {{
 *   budgets:number[], total:number, allocated:number, degraded:number[],
 *   peakIndex:number, peakRetained:boolean,
 * }}
 *   `budgets[i]` is the allowance for `runs[i]`, `degraded` lists the indices that
 *   received `0`, `peakIndex` names the run carrying the chart maximum (`-1` when no
 *   run holds a finite rate) and `peakRetained` says whether it was seated
 */
export function allocateRunBudgets(runs, totalBudget = MAX_RENDER_POINTS_TOTAL) {
  const list = Array.isArray(runs) ? runs : []
  const budget = Number.isFinite(totalBudget) && totalBudget > 0 ? Math.floor(totalBudget) : 0
  /**
   * A run's length, from its own `points` or from the explicit `length` a caller may
   * publish instead. The second form exists because a visual run is a slice of its
   * attempt's grid rather than a copy of it, and the allocation only ever needs the
   * count.
   */
  const lengths = list.map(run => (
    Number.isFinite(run?.length) ? Math.max(0, Math.floor(run.length))
      : (Array.isArray(run?.points) ? run.points.length : 0)
  ))
  const budgets = lengths.map(() => 0)
  if (list.length === 0 || budget <= 0) {
    return {
      budgets,
      total: budget,
      allocated: 0,
      degraded: lengths.map((_, index) => index),
      peakIndex: -1,
      /** Nothing was drawn, so nothing can be claimed as retained. */
      peakRetained: false,
    }
  }

  /**
   * The chart's maximum rate, recovered from the runs themselves rather than passed
   * in, so this function cannot be handed a peak that disagrees with the points it
   * is budgeting. The earliest run wins a tie, which keeps the allocation stable
   * when two runs share the maximum.
   */
  let peakIndex = -1
  let peakValue = Number.NEGATIVE_INFINITY
  for (let i = 0; i < lengths.length; i += 1) {
    for (const point of (Array.isArray(list[i].points) ? list[i].points : [])) {
      const rate = rateOf(point)
      if (rate !== null && rate > peakValue) {
        peakValue = rate
        peakIndex = i
      }
    }
  }
  /**
   * Exactly one run carries the priority band. `peakValue` starts below every finite
   * rate — `0` is finite — so a run is identified whenever any run holds a finite one,
   * including an all-zero chart, whose maximum is `0` and whose earliest run carries it.
   * Only a chart with no finite rate anywhere leaves `peakIndex` at `-1`, and only then
   * does no run receive priority, which is the correct reading rather than a fallback.
   */
  const conveysPeak = index => index === peakIndex

  /**
   * **The one priority order.** After the peak band, runs are ranked by what they
   * irreducibly cost (so the most runs survive a tight budget), then by **ascending
   * length** — the shorter run wins the tie, matching the surplus pass below, which
   * grants its vertices "to the shorter run first" — then by original index, which
   * makes the result a pure function of the input.
   *
   * The length tie-break is load-bearing rather than decorative: every run longer than
   * `MIN_MAX_POINTS` costs exactly `MIN_MAX_POINTS`, so cost alone cannot separate them
   * and the shorter run is the one served first among equals.
   */
  const ranked = lengths.map((length, index) => ({ index, length, cost: minimumRunCost(length) }))
    .sort((left, right) => (
      Number(conveysPeak(right.index)) - Number(conveysPeak(left.index))
      || left.cost - right.cost
      || left.length - right.length
      || left.index - right.index
    ))

  /**
   * **Minimum cost first, for every run, in that one order.** A run that does not fit is
   * left at `0` — refused outright rather than thinned below its own anchor contract —
   * and the ranking guarantees the peak-bearing run is the last one that could ever be
   * refused, whatever its length.
   *
   * Seating a run at its own minimum is also what keeps an unrunnable allowance off the
   * wire: `minimumRunCost` is the smallest value `downsampleSeries` can honour for that
   * length, so nothing between one and three is ever published for a longer run.
   */
  let allocated = 0
  const seated = new Set()
  for (const entry of ranked) {
    if (entry.cost === 0) continue
    if (allocated + entry.cost > budget) continue
    budgets[entry.index] = entry.cost
    allocated += entry.cost
    seated.add(entry.index)
  }

  /**
   * Surplus, shared out so that equal fairness goes to the shorter run first:
   * one vertex at a time around the ranking, which is what keeps a two-vertex run
   * from being starved by a four-hundred-vertex one. The loop terminates because
   * every pass either grants a vertex or finds nothing left to grant.
   *
   * Refused runs are skipped, and that guard is the one that matters: a run the seating
   * pass could not seat at its minimum must stay at `0`, because topping it up with
   * whatever surplus remains would hand it an allowance below its own irreducible cost —
   * an allowance `downsampleSeries` refuses outright and which cannot honour the first,
   * last and peak anchors it promises. A run is drawable at its minimum or it is not
   * drawable at all; there is no third state.
   */
  let remaining = budget - allocated
  while (remaining > 0) {
    let served = false
    for (const entry of ranked) {
      if (remaining <= 0) break
      if (!seated.has(entry.index)) continue
      const capacity = lengths[entry.index] - budgets[entry.index]
      if (capacity <= 0) continue
      const share = Math.max(1, Math.floor(remaining / ranked.length))
      const grant = Math.min(capacity, share)
      budgets[entry.index] += grant
      remaining -= grant
      served = true
    }
    if (!served) break
  }

  const degraded = []
  for (let i = 0; i < lengths.length; i += 1) {
    if (budgets[i] === 0 && lengths[i] > 0) degraded.push(i)
  }
  return {
    budgets,
    total: budget,
    allocated: budgets.reduce((sum, value) => sum + value, 0),
    degraded,
    peakIndex,
    /**
     * Vacuously true when there is no maximum to keep: a chart of nothing but zeros has
     * not lost anything. The only `false` is "the run carrying the chart's maximum could
     * not be drawn", which a caller must not present as a preserved peak.
     */
    peakRetained: peakIndex === -1 || budgets[peakIndex] > 0,
  }
}

/** Index of the first finite global maximum (or minimum) of a series. */
function extremeIndex(points, direction) {
  let best = -1
  let bestValue = 0
  for (let i = 0; i < points.length; i += 1) {
    const value = points[i]?.tps
    if (!Number.isFinite(value)) continue
    if (best === -1 || (direction > 0 ? value > bestValue : value < bestValue)) {
      best = i
      bestValue = value
    }
  }
  return best
}

/**
 * Reduce a series to at most `maxPoints` for rendering.
 *
 * Retention is a **priority list**, not one heuristic, because the budget can be
 * smaller than the number of interesting points and something has to give. In
 * order:
 *
 *   1. the two endpoints — the series must still start and end where it did;
 *   2. the global maximum — this is the point the card's `peak` refers to, and a
 *      rendering choice may never delete it;
 *   3. the global minimum — the trough a stall produces;
 *   4. `required`, a set of indices the caller cannot afford to lose (a **rendering
 *      seam**: a colour-transition vertex shared with the neighbouring run);
 *   5. uniform shape samples with whatever budget is left, so a long flat run
 *      still has vertices to be drawn with.
 *
 * The previous revision kept every local extremum and then, on budget overflow,
 * thinned that set by uniform stride — which is exactly the operation that can
 * step over the single global spike the chart exists to show. Ranking extrema by
 * prominence and reserving the anchors before anything else makes the peak and
 * the trough unconditional; `test/curve.test.js` carries the counterexample that
 * defeats the old stride.
 *
 * `required` sits between the trough and the shape samples because it is a
 * structural obligation rather than a shape preference: dropping a seam vertex
 * would reopen, as a blank horizontal gap, a tone change that is not a stall.
 *
 * Determinism: ties in the global extreme resolve to the earliest index, and
 * ties in prominence resolve to the earliest index, so two runs over equal input
 * return equal output.
 *
 * @param {readonly {timeMs:number, tps:number}[]} series
 * @param {number} [maxPoints] budget; must be `>= MIN_MAX_POINTS`
 * @param {{required?: ReadonlySet<number>}} [options]
 * @returns {{timeMs:number, tps:number}[]} at most `maxPoints` points, in
 *   non-decreasing `timeMs` order, drawn from the input objects themselves
 */
export function downsampleSeries(series, maxPoints = DEFAULT_MAX_POINTS, options = {}) {
  const points = Array.isArray(series) ? series : []
  if (!(Number.isFinite(maxPoints) && maxPoints >= MIN_MAX_POINTS)) {
    /**
     * Refusing is the only honest answer: first, last and the global maximum
     * cannot all survive in fewer than three points, and silently breaking one
     * of the three guarantees would be a worse failure than a loud one.
     */
    throw new TypeError(`maxPoints must be a finite number >= ${MIN_MAX_POINTS}`)
  }
  if (points.length <= maxPoints) return points.slice()

  const lastIndex = points.length - 1
  /** 1-3. Mandatory anchors, in priority order; the Set de-duplicates them. */
  const keep = new Set()
  keep.add(0)
  keep.add(lastIndex)
  const peakIndex = extremeIndex(points, 1)
  if (peakIndex >= 0) keep.add(peakIndex)
  /**
   * The trough is the *recommended* fourth anchor rather than a guaranteed one:
   * a three-point budget must still be able to honour the three hard guarantees,
   * so the trough yields when there is no room for it and never the other way
   * round.
   */
  const troughIndex = extremeIndex(points, -1)
  if (troughIndex >= 0 && keep.size < maxPoints) keep.add(troughIndex)

  /** 4a. Seam vertices the caller requires, taken before any shape preference. */
  const required = options.required
  if (required instanceof Set) {
    for (const index of [...required].sort((a, b) => a - b)) {
      if (keep.size >= maxPoints) break
      if (Number.isInteger(index) && index >= 0 && index < points.length) keep.add(index)
    }
  }

  /** 4b. Local extrema, each with the prominence that ranks it. */
  const extrema = []
  for (let i = 1; i < lastIndex; i += 1) {
    const prev = points[i - 1]?.tps
    const here = points[i]?.tps
    const next = points[i + 1]?.tps
    if (!Number.isFinite(prev) || !Number.isFinite(here) || !Number.isFinite(next)) continue
    if (!((here > prev && here >= next) || (here < prev && here <= next))) continue
    extrema.push({ index: i, prominence: Math.abs(here - (prev + next) / 2) })
  }
  extrema.sort((left, right) => (
    right.prominence - left.prominence || left.index - right.index
  ))
  for (const extremum of extrema) {
    if (keep.size >= maxPoints) break
    keep.add(extremum.index)
  }

  /** 5. Whatever budget remains goes to evenly spaced shape samples. */
  const remaining = maxPoints - keep.size
  if (remaining > 0) {
    const stride = lastIndex / (remaining + 1)
    for (let k = 1; k <= remaining; k += 1) keep.add(Math.round(k * stride))
  }

  /**
   * Ascending index emission, then an explicit `timeMs` ordering: the drawn path
   * requires non-decreasing x, and guaranteeing it here means a caller cannot
   * produce a self-crossing polyline by handing in an out-of-order series. The
   * index tie-break keeps the sort stable, so equal timestamps keep input order.
   */
  const ordered = [...keep]
    .filter(index => index >= 0 && index < points.length)
    .sort((a, b) => a - b)
  const selected = ordered.map(index => points[index])
  selected.sort((left, right) => (
    (Number.isFinite(left?.timeMs) ? left.timeMs : 0) - (Number.isFinite(right?.timeMs) ? right.timeMs : 0)
  ))
  return selected
}

/**
 * Downsample one visual run without breaking the seams it shares with its neighbours.
 *
 * A visual run is a slice of its attempt's vertex grid, and at a phase transition it
 * shares its first or last vertex with the neighbouring run. Downsampling each run
 * independently would therefore be free to thin away **exactly** the vertex the two
 * runs have in common — the reasoning subpath would stop at its own last surviving
 * vertex and the output subpath would start at its own, leaving a blank horizontal
 * gap that looks like a stall and is not one (docs/METRICS_SPEC.md §8.6).
 *
 * The seam is protected by reserving the slice's own endpoints, which is also what
 * `downsampleSeries` does unconditionally for the first and last point: a run's
 * opening and closing vertices are anchors of its own contract. The two ends and the
 * four anchors fit in any budget of at least `MIN_MAX_POINTS`, because the reserve
 * happens before the shape samples and prefers those same anchors.
 *
 * @param {readonly object[]} points the slice, ascending
 * @param {number} budget at least `MIN_MAX_POINTS`, or the slice's own length
 * @returns {object[]} at most `budget` points, endpoints preserved
 */
export function downsampleRun(points, budget) {
  const list = Array.isArray(points) ? points : []
  if (!(Number.isFinite(budget) && budget >= MIN_MAX_POINTS)) {
    throw new TypeError(`budget must be a finite number >= ${MIN_MAX_POINTS}`)
  }
  if (list.length <= budget) return list.slice()
  /**
   * The seam is the slice's own two endpoints, so reserving them is exactly what
   * keeps the tone change continuous. They are emitted in ascending `timeMs` order
   * like every other returned series.
   */
  const required = new Set([0, list.length - 1])
  const selected = downsampleSeries(list, budget, { required })
  selected.sort((left, right) => (
    (Number.isFinite(left?.timeMs) ? left.timeMs : 0) - (Number.isFinite(right?.timeMs) ? right.timeMs : 0)
  ))
  return selected
}
