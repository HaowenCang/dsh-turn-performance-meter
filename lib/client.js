/**
 * GENERATED FILE — do not edit.
 * Rebuild with: npm run build:client
 * Source graph: src/client/main.js + its imports (scripts/bundle-client.mjs).
 */
window.__ModuleLoader__.load({
	id: "dsh-turn-performance-meter",
	factory(require) {
		'use strict'
		const __cache = new Map()
		function __ext(spec) { return require(spec) }
		function __req(id) {
			const hit = __cache.get(id)
			if (hit !== undefined) return hit
			const factory = __modules[id]
			if (factory === undefined) throw new Error('dsh-turn-performance-meter bundle: unknown module ' + id)
			const record = { exports: {} }
			__cache.set(id, record.exports)
			factory(record.exports)
			return record.exports
		}
		const __modules = {
			"src/core/metric-quality.js": function (__exports) {
/**
 * Metric quality is ordered from strongest to weakest evidence. It exists so
 * that no display path can pretend a live estimate is a provider-exact number
 * (docs/METRICS_SPEC.md §11).
 */
const MetricQuality = Object.freeze({
  EXACT: 'exact',
  CALIBRATED: 'calibrated',
  ESTIMATED: 'estimated',
  UNAVAILABLE: 'unavailable',
})

const ORDER = Object.freeze([
  MetricQuality.EXACT,
  MetricQuality.CALIBRATED,
  MetricQuality.ESTIMATED,
  MetricQuality.UNAVAILABLE,
])

const RANK = new Map(ORDER.map((quality, index) => [quality, index]))

/** Whether the value is one of the four declared qualities. */
function isMetricQuality(value) {
  return RANK.has(value)
}

/** Return the weakest quality among the supplied values. */
function weakestQuality(...values) {
  if (values.length === 0) return MetricQuality.UNAVAILABLE
  let weakest = MetricQuality.EXACT
  for (const value of values) {
    const rank = RANK.get(value)
    if (rank === undefined) return MetricQuality.UNAVAILABLE
    if (rank > RANK.get(weakest)) weakest = value
  }
  return weakest
}

/**
 * Quality of an aggregate whose denominator is the sum of phase durations.
 *
 * `null` duration is deliberately not coerced to zero: a single-delta attempt
 * has no measurable generation interval, so any rate computed from it would be
 * fabricated. Callers receive `unavailable` and must render `—`.
 *
 * `measuredRatio` is the share of contributing attempts that supplied a
 * duration. Below 1 the aggregate under-counts the true generation time, so the
 * resulting rate is optimistic and cannot be `exact`.
 */
function rateQuality({ measuredRatio = 1, tokensExact = true, phaseSplitExact = true } = {}) {
  if (!(measuredRatio > 0)) return MetricQuality.UNAVAILABLE
  if (measuredRatio < 1) return MetricQuality.ESTIMATED
  if (!phaseSplitExact) return MetricQuality.CALIBRATED
  return tokensExact ? MetricQuality.EXACT : MetricQuality.ESTIMATED
}

;Object.assign(__exports, { MetricQuality, isMetricQuality, weakestQuality, rateQuality })
			},
			"src/core/phase-duration.js": function (__exports) {
/**
 * MiMo-style phase-episode duration attribution for one model attempt.
 *
 * Normative policy (docs/METRICS_SPEC.md §7 "Phase-duration policy", superseded
 * by Phase 9.2), which this module is the only implementation of:
 *
 *  1. TTFT — the interval from attempt start to the first generated delta — is
 *     excluded, because an episode begins at its first generated sample.
 *  2. Tool and inter-attempt time is excluded: this function only ever sees one
 *     attempt's own samples plus that attempt's own settlement instant. The next
 *     attempt's samples and the tools between them are not inputs.
 *  3. An attempt is cut into **contiguous phase episodes**. Each episode's
 *     duration is `episodeEnd - episodeStart` where
 *
 *       episodeStart = the episode's first generated sample, and
 *       episodeEnd   = the first generated sample of the next episode, or —
 *                      for the terminal episode — the attempt's settlement time.
 *
 *     This intentionally includes stalls inside model generation (the gap
 *     between two samples of one episode is charged to that episode) and,
 *     for the terminal episode, the final generated-delta → settlement tail.
 *     That tail is model-attempt elapsed time under the MiMo-style definition
 *     (`docs/MIMO_RUNTIME_METRICS.md` §5.4: `settlementTime - outputStartTime`),
 *     and charging it is the deliberate Phase 9.2 change from the old
 *     inter-delta contract.
 *
 *  3b. **A non-magnitude phase cut ends the outgoing episode early (Phase
 *     9.4.3).** A name-bearing `tool-call-delta` with an empty `argumentsDelta`
 *     carries no magnitude but does declare a phase (`tokenEvidence()`), and the
 *     live meter closes the outgoing episode at that instant. The summary must
 *     close it at the same instant, or the silent stretch between the boundary and
 *     the incoming phase's first magnitude sample is charged to a phase that had
 *     already stopped producing — the principal fixture of `docs/METRICS_SPEC.md`
 *     §8.7 read `reasoningMs 300 / reasoningTps 1000` where the episode is 120 ms
 *     of reasoning and a 180 ms stretch that belongs to no phase at all.
 *
 *     The cut closes the episode and opens nothing: the incoming episode still
 *     begins at its first magnitude sample, and the stretch between the two is
 *     charged to neither phase. A cut that declares the phase already in force
 *     changes nothing, exactly as it changes nothing live.
 *
 *     The rule is implemented once, in {@link buildPhaseEpisodes}, because three
 *     consumers read it — the live estimator, the completed curve and this
 *     summary — and a second copy of the episode boundary would be free to drift
 *     from the one the chart draws.
 *  4. Reasoning and output never double-count: the episodes are disjoint and
 *     ordered, so a reasoning -> output -> reasoning interleave produces three
 *     disjoint durations rather than overlapping `[first,last]` spans.
 *  5. Degenerate attempts never produce division by zero or infinite TPS. An
 *     episode with no positive measurable duration — a single sample whose
 *     successor starts at the same instant, or a terminal episode whose
 *     settlement instant is unknown or not later than its start — reports
 *     `durationMs: null`, never `0`: "no evidence" and "measured zero duration"
 *     are different facts and only the former is true. Consumers translate
 *     `null` duration plus non-zero tokens into `unavailable` quality rather
 *     than an infinite rate.
 *
 * What is deliberately **not** charged: the attempt's own TTFT, the tool time
 * between two attempts, and the inter-attempt wait. None of them is model
 * generation, and none of them reaches this function.
 */

const PHASE = Object.freeze({ REASONING: 'reasoning', OUTPUT: 'output' })

function toSamples(samples) {
  if (!Array.isArray(samples)) return []
  return samples
    .filter(sample => sample && Number.isFinite(sample.timeMs))
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs)
}

/** One attempt's non-magnitude phase boundaries, ascending, finite and phase-bearing. */
function toCuts(cuts) {
  if (!Array.isArray(cuts)) return []
  return cuts
    .filter(cut => cut && Number.isFinite(cut.timeMs) && (cut.phase === PHASE.REASONING || cut.phase === PHASE.OUTPUT))
    .map(cut => ({ timeMs: cut.timeMs, phase: cut.phase }))
    .sort((a, b) => a.timeMs - b.timeMs)
}

/**
 * Cut one attempt's ordered samples into phase episodes, honouring its phase cuts.
 *
 * This is the **one** implementation of the episode boundary, and it is shared by
 * the completed curve (`src/core/curve.js` samples its ladder from the returned
 * episodes) and by the summary (`attributePhaseDurations` sums their durations).
 * Two copies of this walk would be free to disagree about where a phase stopped,
 * which is exactly the class of defect the cut exists to remove.
 *
 * An episode opens at a generated sample whose phase differs from the open
 * episode's — or at any sample when no episode is open — and ends at the earliest
 * of
 *
 *   - the next episode's opening sample,
 *   - a **phase cut** declaring a different phase (a non-magnitude boundary),
 *   - the attempt's own end (`endMs`, i.e. its settlement instant).
 *
 * A cut contributes no sample, no sample count and no magnitude: it closes the
 * outgoing episode and opens nothing, so the stretch that follows it belongs to no
 * episode until a magnitude sample opens one. A cut declaring the phase already in
 * force is inert, which is what keeps a same-phase boundary from splitting a valid
 * episode.
 *
 * @param {readonly {timeMs:number, phase?:string|null}[]} samples ascending stream order
 * @param {{cuts?:readonly {timeMs:number, phase?:string|null}[], endMs?:number|null}} [options]
 * @returns {{
 *   episodes: {
 *     phase:string|null, startMs:number, startIndex:number, lastSampleMs:number,
 *     boundMs:number|null, closedByCut:boolean, sampleCount:number, mass:number,
 *   }[],
 *   episodeIndexBySample: number[],
 * }}
 *   `boundMs` is the episode's own end instant, or `null` for a terminal episode
 *   whose attempt end is unknown. `episodeIndexBySample[i]` is the episode sample
 *   `i` belongs to, so a caller can accumulate an episode's mass incrementally.
 */
function buildPhaseEpisodes(samples, options = {}) {
  const ordered = Array.isArray(samples) ? samples : []
  const cuts = toCuts(options.cuts)
  const endMs = Number.isFinite(options.endMs) ? options.endMs : null

  /**
   * Samples and cuts merged on one clock, **cut first** at a shared instant.
   *
   * The order is the stream's own: DSH delivers the boundary delta before the
   * delta that confirms its phase, so at one millisecond the cut is the earlier
   * fact. `Array.prototype.sort` is stable, so the samples keep the ascending
   * order (and the stream ordinal) they arrived in.
   */
  const events = []
  for (let index = 0; index < ordered.length; index += 1) {
    if (Number.isFinite(ordered[index]?.timeMs)) events.push({ at: ordered[index].timeMs, sampleIndex: index, cut: null })
  }
  for (const cut of cuts) events.push({ at: cut.timeMs, sampleIndex: -1, cut })
  events.sort((left, right) => (
    left.at - right.at || (left.cut === null ? 1 : 0) - (right.cut === null ? 1 : 0)
  ))

  const episodes = []
  const episodeIndexBySample = ordered.map(() => -1)
  let current = null
  for (const event of events) {
    if (event.cut !== null) {
      const declared = event.cut.phase
      if (current !== null && declared !== current.phase && event.cut.timeMs >= current.startMs) {
        current.boundMs = event.cut.timeMs
        current.closedByCut = true
        current = null
      }
      continue
    }
    const sample = ordered[event.sampleIndex]
    if (sample === null || sample === undefined) continue
    const phase = sample.phase ?? null
    if (current !== null && phase !== current.phase) {
      current.boundMs = sample.timeMs
      current = null
    }
    if (current === null) {
      current = {
        phase,
        startMs: sample.timeMs,
        startIndex: event.sampleIndex,
        lastSampleMs: sample.timeMs,
        boundMs: null,
        closedByCut: false,
        sampleCount: 0,
        mass: 0,
      }
      episodes.push(current)
    }
    current.lastSampleMs = sample.timeMs
    current.sampleCount += 1
    current.mass += sample.tokens ?? sample.weight ?? 0
    episodeIndexBySample[event.sampleIndex] = episodes.length - 1
  }

  /**
   * The terminal episode's own end. A settlement stamped *before* the attempt's
   * last delta is clock skew and is refused rather than allowed to shrink real
   * generation time — the same rule `compressAttempts` applies to the attempt's
   * width. A cut-closed terminal episode keeps its cut: the attempt's later clock
   * belongs to no episode, and charging it to the phase that already stopped is
   * the defect this whole mechanism removes.
   */
  const terminal = episodes[episodes.length - 1]
  if (terminal !== undefined && terminal.boundMs === null && endMs !== null) {
    terminal.boundMs = Math.max(endMs, terminal.lastSampleMs)
  }
  return { episodes, episodeIndexBySample }
}

/**
 * Cut one attempt's ordered samples into contiguous phase episodes and measure each.
 *
 * The episode list is the shared vocabulary of the live estimator, the completed
 * summary and the curve: all three read "the phase of the newest sample at or
 * before an instant" and "the first sample of that episode" from the same rule —
 * `buildPhaseEpisodes` above, which is the only place the boundary is computed.
 *
 * @param {readonly {timeMs:number, phase?:string|null}[]} ordered samples, ascending
 * @param {number|null} settledAtMs the attempt's settlement instant, or `null`
 * @param {readonly {timeMs:number, phase?:string|null}[]} [cuts] the attempt's
 *   non-magnitude phase boundaries; each one ends the episode in force without
 *   opening a new one (`docs/METRICS_SPEC.md` §8.7)
 * @returns {{
 *   phase:string|null, startMs:number, lastSampleMs:number,
 *   endMs:number|null, durationMs:number|null, sampleCount:number,
 * }[]}
 */
function phaseEpisodes(ordered, settledAtMs = null, cuts = []) {
  /**
   * Only samples with a finite instant take part, exactly as before: an attempt's
   * malformed timestamp cannot create an episode, and it cannot shift one either.
   */
  const timed = Array.isArray(ordered) ? ordered.filter(sample => sample && Number.isFinite(sample.timeMs)) : []
  const { episodes } = buildPhaseEpisodes(timed, {
    cuts,
    endMs: Number.isFinite(settledAtMs) ? settledAtMs : null,
  })
  return episodes.map(episode => {
    /**
     * A non-terminal episode ends where the next one begins — which is *after*
     * its own last sample whenever the stream fell silent across the boundary,
     * and at the same instant when the two phases interleave with no gap. A
     * cut-closed episode ends at the cut instead, and the stretch after it is
     * charged to no phase. The terminal episode ends at the attempt's settlement
     * instant, never before its own last sample (see `buildPhaseEpisodes`).
     */
    const endMs = episode.boundMs
    return {
      phase: episode.phase,
      startMs: episode.startMs,
      lastSampleMs: episode.lastSampleMs,
      endMs,
      /** `null` means "not measurable"; `0` would claim a measured zero duration. */
      durationMs: endMs === null || !(endMs > episode.startMs) ? null : endMs - episode.startMs,
      sampleCount: episode.sampleCount,
    }
  })
}

/**
 * Sum one phase's measurable episode durations.
 *
 * @returns {{ms:number|null, episodeCount:number, measuredCount:number}}
 *   `ms` is `null` when the phase has no measurable episode at all; otherwise it
 *   is the sum of the measurable ones, and `measuredCount < episodeCount` states
 *   that the denominator is short of the phase's full generation time.
 */
function phaseDuration(episodes, phase) {
  const owned = episodes.filter(episode => episode.phase === phase)
  let ms = 0
  let measured = 0
  for (const episode of owned) {
    if (episode.durationMs === null) continue
    ms += episode.durationMs
    measured += 1
  }
  return {
    ms: measured > 0 ? ms : null,
    episodeCount: owned.length,
    measuredCount: measured,
  }
}

/**
 * Attribute one attempt's phase-episode durations.
 *
 * @param {readonly {timeMs:number, phase:'reasoning'|'output'}[]} samples
 * @param {{settledAtMs?:number|null, phaseCuts?:readonly {timeMs:number, phase:string}[]}} [options]
 *   `settledAtMs` ends the terminal episode; without it the terminal episode is
 *   unmeasurable (`null`), never zero. `phaseCuts` are the attempt's
 *   non-magnitude phase boundaries: each one ends the episode in force at its own
 *   instant and opens nothing, so the stretch that follows belongs to no phase.
 * @returns {{
 *   reasoningMs:number|null,
 *   outputMs:number|null,
 *   reasoningEpisodeCount:number,
 *   reasoningMeasuredEpisodes:number,
 *   outputEpisodeCount:number,
 *   outputMeasuredEpisodes:number,
 *   spanMs:number,
 *   sampleCount:number,
 *   generatedCount:number,
 *   episodes:object[],
 * }}
 */
function attributePhaseDurations(samples, options = {}) {
  const ordered = toSamples(samples)
  const settledAtMs = Number.isFinite(options?.settledAtMs) ? options.settledAtMs : null
  const episodes = phaseEpisodes(ordered, settledAtMs, options?.phaseCuts)
  const reasoning = phaseDuration(episodes, PHASE.REASONING)
  const output = phaseDuration(episodes, PHASE.OUTPUT)

  const first = ordered[0]?.timeMs
  const last = ordered[ordered.length - 1]?.timeMs
  return {
    reasoningMs: reasoning.ms,
    outputMs: output.ms,
    reasoningEpisodeCount: reasoning.episodeCount,
    reasoningMeasuredEpisodes: reasoning.measuredCount,
    outputEpisodeCount: output.episodeCount,
    outputMeasuredEpisodes: output.measuredCount,
    spanMs: ordered.length > 1 ? Math.max(0, last - first) : 0,
    sampleCount: ordered.length,
    generatedCount: ordered.length,
    episodes,
  }
}

;Object.assign(__exports, { PHASE, buildPhaseEpisodes, phaseEpisodes, attributePhaseDurations })
			},
			"src/core/phase-evidence.js": function (__exports) {
/**
 * Phase-evidence consistency: one authority for the disagreements between what a
 * provider *counted* and what the stream *recorded*.
 *
 * ## The two claims that are not the same claim
 *
 * Provider usage and the stream answer different questions.
 *
 *   - The provider reports an authoritative **total** `outputTokens` and, on some
 *     routes, authoritative **phase counters**: how many of those tokens were
 *     reasoning and how many were not.
 *   - The stream records **where** generation happened: the timestamps and the
 *     observed phase labels of the deltas it emitted.
 *
 * A total and a temporal allocation are therefore independent claims. Provider
 * phase counters describe *how many* tokens were reasoning; the stream describes
 * *when* reasoning was emitted. When the two disagree about whether a phase is
 * present at all, the disagreement damages only the second claim. The first is
 * still a counted total and must not be thrown away with it.
 *
 * ## Why this is a module and not a branch
 *
 * The contradiction rules used to be spread across two places: the
 * `reasoningTokens === 0` guard inside `aggregateTurn`, and the missing-phase
 * test inside `calibrateAttemptSamples`. They disagreed. The first caught only
 * one direction of one phase; the second detected a missing phase but then
 * calibrated anyway, publishing `totalAnchored: true` over a curve whose sample
 * integral was short by exactly the tokens of the phase the stream never showed.
 *
 * Both callers now read this module, so a rule cannot be true in the calibration
 * layer and false in the aggregation layer.
 *
 * ## The two outputs
 *
 * `contradictions` is the *diagnosis*: the symmetric list of ways the two
 * evidence sources disagree, or an empty list when they agree.
 *
 * `temporalAllocationMode` is the *consequence*: which of the two claims the
 * per-delta curve magnitudes may still be built from.
 */

/** How the per-delta curve magnitudes of one attempt were anchored. */
const TemporalAllocationMode = Object.freeze({
  /**
   * The provider total and its phase split were both usable, so each phase's
   * samples were calibrated against that phase's own counter. The curve's phase
   * integrals are the provider's phase counters.
   */
  PHASE_ANCHORED: 'phase-anchored',
  /**
   * The provider total is authoritative but the phase split could not be mapped
   * onto the observed stream — either because the provider reported no split, or
   * because the split it reported contradicts the phases the stream recorded. All
   * observed samples are then scaled by one common factor so their integral is the
   * authoritative total, and the phase-temporal allocation is *not* claimed to be
   * exact.
   */
  TOTAL_ANCHORED: 'total-anchored',
  /** No authoritative provider total exists, so the magnitudes stay raw shape weights. */
  UNANCHORED: 'unanchored',
})

/**
 * The symmetric contradiction kinds.
 *
 * Every kind is a disagreement between a provider counter and the stream's own
 * evidence. A missing `reasoningTokens` is deliberately **not** among them: an
 * absent counter is a split that was never measured, which is a quality level
 * rather than a conflict.
 */
const PhaseEvidenceIssue = Object.freeze({
  /** The provider split is internally impossible: more reasoning than output. */
  IMPOSSIBLE_SPLIT: 'impossible-split',
  /** The provider counted reasoning tokens, but the stream emitted no reasoning delta. */
  REASONING_WITHOUT_DELTAS: 'reasoning-without-deltas',
  /** The provider counted zero reasoning tokens, but the stream emitted a reasoning delta. */
  REASONING_ZERO_WITH_DELTAS: 'reasoning-zero-with-deltas',
  /** The provider counted non-reasoning tokens, but the stream emitted only reasoning deltas. */
  OUTPUT_WITHOUT_DELTAS: 'output-without-deltas',
  /** The provider counted zero non-reasoning tokens, but the stream emitted an output delta. */
  OUTPUT_ZERO_WITH_DELTAS: 'output-zero-with-deltas',
})

/**
 * One contradiction, stated as the two counters that disagree.
 *
 * @typedef {{
 *   kind: string,
 *   phase: 'reasoning'|'output'|null,
 *   provider: number|null,
 *   observedSamples: number|null,
 *   message: string,
 * }} PhaseEvidenceContradiction
 */

/**
 * Decide whether the provider's phase split may be mapped onto the observed stream.
 *
 * @param {readonly object[]} samples the attempt's generated samples, in stream order
 * @param {number|null|undefined} outputTokens the authoritative provider total
 * @param {number|null|undefined} reasoningTokens the provider's reasoning counter, or absent
 * @returns {{
 *   splitAvailable: boolean,
 *   splitUsable: boolean,
 *   reasoningTotal: number|null,
 *   outputTotal: number|null,
 *   hasReasoningSamples: boolean,
 *   hasOutputSamples: boolean,
 *   contradictions: PhaseEvidenceContradiction[],
 *   notes: string[],
 * }}
 *   `splitUsable` is the gate: `true` means the provider counters may be used as the
 *   per-phase temporal allocation, `false` means the caller must fall back to one
 *   common scale over every observed sample.
 */
function analyzePhaseEvidence(samples, outputTokens, reasoningTokens) {
  const list = Array.isArray(samples) ? samples : []
  return analyzePhaseEvidenceFrom({
    hasReasoningSamples: list.some(sample => sample?.phase === 'reasoning'),
    hasOutputSamples: list.some(sample => sample?.phase === 'output'),
    reasoningSampleCount: list.filter(sample => sample?.phase === 'reasoning').length,
    outputSampleCount: list.filter(sample => sample?.phase === 'output').length,
  }, outputTokens, reasoningTokens)
}

/**
 * The same decision, from a **summary** of the observed stream rather than its samples.
 *
 * The live meter cannot hold an attempt's whole sample list — it is a running
 * estimator, not a log — but the contradiction rules below read exactly two facts
 * from it: whether a phase produced any generated delta at all, and how many.
 * This entry point exists so that the live path applies the *same* rules as the
 * calibration path instead of a second, drifting copy of them.
 *
 * @param {{hasReasoningSamples:boolean, hasOutputSamples:boolean,
 *   reasoningSampleCount?:number, outputSampleCount?:number}} summary
 * @param {number|null|undefined} outputTokens the authoritative provider total
 * @param {number|null|undefined} reasoningTokens the provider's reasoning counter, or absent
 * @returns {object} the same shape `analyzePhaseEvidence` returns
 */
function analyzePhaseEvidenceFrom(summary, outputTokens, reasoningTokens) {
  const hasReasoningSamples = summary?.hasReasoningSamples === true
  const hasOutputSamples = summary?.hasOutputSamples === true
  const reasoningSampleCount = Number.isFinite(summary?.reasoningSampleCount) ? summary.reasoningSampleCount : 0
  const outputSampleCount = Number.isFinite(summary?.outputSampleCount) ? summary.outputSampleCount : 0
  const splitAvailable = Number.isFinite(reasoningTokens) && reasoningTokens >= 0
  const total = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : null

  if (!splitAvailable) {
    /**
     * An absent counter is "split unavailable", not a contradiction: the provider
     * never claimed anything about the phase that could be contradicted. The total
     * is unaffected and the common-scale fallback still applies.
     */
    return {
      splitAvailable: false,
      splitUsable: false,
      reasoningTotal: null,
      outputTotal: total,
      hasReasoningSamples,
      hasOutputSamples,
      contradictions: [],
      notes: ['reasoningTokens absent: whole-attempt integral anchored, reasoning/output split estimated'],
    }
  }

  const reasoningTotal = reasoningTokens
  const outputTotal = total === null ? null : total - reasoningTokens
  const contradictions = []

  if (total !== null && reasoningTotal > total) {
    contradictions.push(contradiction(
      PhaseEvidenceIssue.IMPOSSIBLE_SPLIT,
      null,
      reasoningTotal,
      null,
      `reasoningTokens=${reasoningTotal} exceeds outputTokens=${total}; `
      + 'the reported phase split is impossible and is not accepted as exact',
    ))
    /**
     * Both per-phase counters are withheld, not clamped. `total - reasoningTokens` is
     * negative here, and publishing it would either show a negative token count or — after
     * the clamp the brief forbids — a fabricated zero for a phase the provider never said
     * was empty. `NaN` is the explicit "this number may not be published" marker; the
     * provider's own counters remain readable in `contradictions[].provider`.
     */
    return {
      splitAvailable: true,
      splitUsable: false,
      reasoningTotal: Number.NaN,
      outputTotal: Number.NaN,
      hasReasoningSamples,
      hasOutputSamples,
      contradictions,
      notes: [contradictions[0].message],
    }
  }

  if (reasoningTotal > 0 && !hasReasoningSamples) {
    contradictions.push(contradiction(
      PhaseEvidenceIssue.REASONING_WITHOUT_DELTAS,
      'reasoning',
      reasoningTotal,
      0,
      `authoritative reasoning tokens reported but the stream carried no such deltas`,
    ))
  }
  if (reasoningTotal === 0 && hasReasoningSamples) {
    contradictions.push(contradiction(
      PhaseEvidenceIssue.REASONING_ZERO_WITH_DELTAS,
      'reasoning',
      0,
      reasoningSampleCount,
      'provider reported reasoningTokens=0 but the stream carries non-empty reasoning deltas; '
      + 'the phase split is downgraded',
    ))
  }
  if (outputTotal !== null && outputTotal > 0 && !hasOutputSamples) {
    contradictions.push(contradiction(
      PhaseEvidenceIssue.OUTPUT_WITHOUT_DELTAS,
      'output',
      outputTotal,
      0,
      'authoritative non-reasoning tokens reported but the stream carried no such deltas',
    ))
  }
  if (outputTotal === 0 && hasOutputSamples) {
    contradictions.push(contradiction(
      PhaseEvidenceIssue.OUTPUT_ZERO_WITH_DELTAS,
      'output',
      0,
      outputSampleCount,
      'provider reported no non-reasoning tokens but the stream carries output deltas; '
      + 'the phase split is downgraded',
    ))
  }

  return {
    splitAvailable: true,
    splitUsable: contradictions.length === 0,
    reasoningTotal,
    outputTotal,
    hasReasoningSamples,
    hasOutputSamples,
    contradictions,
    notes: contradictions.map(entry => entry.message),
  }
}

function contradiction(kind, phase, provider, observedSamples, message) {
  return { kind, phase, provider, observedSamples, message }
}

;Object.assign(__exports, { TemporalAllocationMode, PhaseEvidenceIssue, analyzePhaseEvidence, analyzePhaseEvidenceFrom })
			},
			"src/core/rate-publication.js": function (__exports) {
/**
 * The one publication policy for throughput measurements.
 *
 * ## Why a shared module rather than a constant in each half
 *
 * The live pill and the completed curve publish the same statistic — the
 * phase-cumulative average of an episode —
 *
 *     TPS(t) = episode token mass * 1000 / elapsed since the episode opened
 *
 * and they publish it from two different code paths. Before this module each
 * path carried its own half of the rule: the live meter required three samples,
 * the curve required nothing at all. A quotient with a 50 ms — or, after an
 * off-grid phase transition, a 1 ms — denominator was therefore publishable on
 * the completed chart and promoted to `peakTps`, while the live meter would have
 * withheld the same measurement.
 *
 * Both halves now ask this module, so "is this a measurement?" has exactly one
 * answer in the project.
 *
 * ## The two gates
 *
 *   - **`MIN_RATE_SAMPLES`** — a rate assembled from fewer than three deltas is
 *     not a rate. One sample over any elapsed time is a single observation, and
 *     two samples cannot show whether the stream is sustaining or stalling.
 *     MiMo hides a rate until its value is plausible; the DSH port keeps the
 *     structurally useful half of that rule without MiMo's product-specific
 *     `200 <= TPS <= 1564` visibility window, which would hide the low rates DSH
 *     models legitimately produce.
 *   - **`MIN_RATE_ELAPSED_MS`** — a denominator below one tenth of a second is
 *     dominated by delivery granularity rather than by generation speed. DSH
 *     streams no per-delta token counts, so the numerator of an early vertex is
 *     a coarse shape weight; dividing it by a few milliseconds amplifies that
 *     coarse weight into a number the evidence cannot support.
 *
 * Neither gate clamps a value. A rate that passes both is published exactly as
 * computed, however large; a rate that fails either is **not published at all**,
 * which is a different statement from "published as zero". No smoothing (EMA,
 * moving average, winsorization) and no arbitrary ceiling exists anywhere in
 * this policy: the defect was an eligibility defect and it is repaired at the
 * eligibility site.
 *
 * ## Calibration does not relax the gates
 *
 * `calibrated` magnitudes make the numerator exact in total, not in time: the
 * provider reports one aggregate for an attempt, so the per-delta allocation is
 * still a shape. An exactly-anchored total divided by a 1 ms denominator is
 * exactly as meaningless as an estimated one, which is why both gates apply
 * identically at every quality level.
 */

/**
 * Generated samples an episode needs before one of its rates may be published.
 *
 * The live meter has enforced this since Phase 9.2 under the name
 * `MIN_WARMUP_SAMPLES`; that export is now an alias of this constant, so a
 * caller cannot end up with two different sample gates.
 */
const MIN_RATE_SAMPLES = 3

/** Episode elapsed time, in milliseconds, below which no rate is publishable. */
const MIN_RATE_ELAPSED_MS = 100

/**
 * Why a vertex or a live snapshot carries no rate.
 *
 * `null` is reserved for "publishable"; every other value names a fact about the
 * evidence rather than a judgement about the number.
 */
const RateUnavailable = Object.freeze({
  /** No episode is in force: no generated sample has been observed yet. */
  NO_EPISODE: 'no-episode',
  /** The episode's own opening instant, where elapsed time is exactly zero. */
  OPENING_ANCHOR: 'opening-anchor',
  /** The episode has run for less than `MIN_RATE_ELAPSED_MS`. */
  BELOW_ELAPSED_HORIZON: 'below-elapsed-horizon',
  /** The episode holds fewer than `MIN_RATE_SAMPLES` contributing samples. */
  BELOW_SAMPLE_WARMUP: 'below-sample-warmup',
})

/**
 * Whether one episode state is a publishable throughput measurement, and why not
 * when it is not.
 *
 * The order of the tests is the order of the facts: an unknown episode outranks
 * its own opening anchor, which outranks the elapsed horizon, which outranks the
 * sample count. A caller that reports the first failure therefore reports the
 * most specific thing that is missing.
 *
 * @param {{sampleCount?:number, elapsedMs?:number|null}} state
 * @returns {{publishable:boolean, reason:string|null}}
 */
function rateAvailability(state = {}) {
  const sampleCount = state.sampleCount
  const elapsedMs = state.elapsedMs
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    return { publishable: false, reason: RateUnavailable.NO_EPISODE }
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { publishable: false, reason: RateUnavailable.OPENING_ANCHOR }
  }
  if (elapsedMs < MIN_RATE_ELAPSED_MS) {
    return { publishable: false, reason: RateUnavailable.BELOW_ELAPSED_HORIZON }
  }
  if (sampleCount < MIN_RATE_SAMPLES) {
    return { publishable: false, reason: RateUnavailable.BELOW_SAMPLE_WARMUP }
  }
  return { publishable: true, reason: null }
}

/** Convenience for a caller that only needs the boolean. */
function rateIsPublishable(state) {
  return rateAvailability(state).publishable
}

;Object.assign(__exports, { MIN_RATE_SAMPLES, MIN_RATE_ELAPSED_MS, RateUnavailable, rateAvailability, rateIsPublishable })
			},
			"src/core/live-metrics.js": function (__exports) {
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
 *     the output episode has no valid positive rate of its own (§15). The window
 *     is the episode's own — it starts at the first output magnitude sample — so
 *     a boundary-only instant neither opens it nor extends the reasoning rate
 *     across a phase that has produced nothing;
 *   - TTFT is measured once per turn, from turn start to the first chunk DSH's
 *     own `isTokenDelta` accepts — `tokenEvidence().countsAsToken` in
 *     `src/core/delta-accounting.js`, which includes a name-bearing
 *     `tool-call-delta` whose argument fragment has not arrived yet — and is
 *     never redefined by a later call (docs/METRICS_SPEC.md §4). A boundary-only
 *     delta freezes TTFT and contributes no token mass.
 *
 * ## Three instants that are deliberately not one instant (Phase 9.4.2)
 *
 *   - the **TTFT boundary**: the first chunk DSH's first-token predicate accepts;
 *   - the **magnitude sample**: a generated delta that carries a TPS-shape weight;
 *   - the **TPS episode origin**: the first magnitude sample of the active phase
 *     episode, which is the only origin the phase-cumulative denominator may use.
 *
 * Exactly one chunk shape separates the first from the second: a name-bearing
 * `tool-call-delta` with an empty `argumentsDelta`. It establishes the TTFT
 * boundary and the streaming phase identity, and it establishes **neither** a
 * magnitude nor an episode origin. `acceptSample` is the only method that opens
 * an episode, so `episodeStartMs` is never a boundary instant — which is what
 * keeps the live denominator origin identical to the origin the completed curve
 * uses (`cumulativePhaseTpsSeries` opens an episode at its first sample), and
 * what keeps `episodeUsageBaseline` describing the same interval as the
 * provider-counter numerator it is subtracted from.
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

const { MetricQuality } = __req("src/core/metric-quality.js")
const { PHASE } = __req("src/core/phase-duration.js")
const { analyzePhaseEvidenceFrom } = __req("src/core/phase-evidence.js")
const { MIN_RATE_ELAPSED_MS, MIN_RATE_SAMPLES, rateAvailability } = __req("src/core/rate-publication.js")

const LivePhase = Object.freeze({
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
const MIN_WARMUP_SAMPLES = MIN_RATE_SAMPLES

/**
 * How long the last positive reasoning rate may stand in for an output episode
 * that has no valid positive rate of its own yet.
 *
 * MiMo reuses the thinking rate for up to 1 s into the output phase rather than
 * displaying a spurious zero (`docs/MIMO_RUNTIME_METRICS.md` §5.2). The reuse
 * never overwrites a valid positive output estimate, and it does not survive a
 * tool wait, an attempt boundary or a turn boundary.
 */
const FIRST_OUTPUT_GUARD_MS = 1000

/** The counter a phase episode reads, or `null` when the split is unusable. */
function episodeCounter(usage, phase, evidence) {
  if (usage === null || evidence === null || evidence.splitUsable !== true) return null
  if (phase === PHASE.REASONING) return evidence.reasoningTotal
  if (phase === PHASE.OUTPUT) return evidence.outputTotal
  return null
}

class LiveMeter {
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
     *
     * It is `null` while the phase is known but no magnitude has arrived yet —
     * after a boundary-only first token, or after any attempt/phase boundary —
     * and in that state there is no episode: no clock, no numerator, no
     * denominator and no publishable rate. Only `acceptSample` opens one.
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
       * A phase change — or the first magnitude sample of the attempt, or the
       * first magnitude sample after a boundary-only delta already announced the
       * phase — opens a fresh episode **at this sample's instant**. The previous
       * phase's elapsed time and numerator are discarded rather than carried
       * forward (§14), and the phase identity a boundary established is now
       * backed by the sample that gives it a clock.
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
   * therefore freezes the turn's TTFT and establishes the streaming phase
   * identity, and it does none of the things that would corrupt the numbers: it
   * adds no token mass, it does not increment `episodeSampleCount`, and it does
   * **not open the TPS episode**, so no rate can ever be published from boundary
   * evidence alone.
   *
   * Before this method existed, `firstTokenMs` could only be frozen by an
   * accepted sample, so a turn whose first token was a tool-call boundary kept
   * rendering the first-response stopwatch after the boundary had passed.
   *
   * ## Why the boundary is not an episode origin (Phase 9.4.2)
   *
   * The phase-cumulative denominator is measured from the first **magnitude**
   * sample of the episode, and so is the completed curve's: `acceptSample` (and
   * `cumulativePhaseTpsSeries`) open an episode at a sample's own instant, and a
   * boundary-only delta produces no sample, so the curve never sees this instant
   * at all. Opening the episode here gave the live pill a denominator origin the
   * completed trace could not reproduce — the same fixture read `1500` live and
   * `3000` on the card — and it attached `episodeUsageBaseline` to that instant,
   * making the provider-counter numerator an interval the denominator did not
   * describe.
   *
   * A **same-phase** boundary inside an already magnitude-open episode therefore
   * changes nothing here: the boundary is TTFT/state evidence, not a magnitude
   * boundary, so an origin, a numerator and a sample count that real samples
   * established are left intact.
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
     * A genuine phase transition is established **immediately** — the identity
     * changes and the previous phase's episode is discarded rather than bridged —
     * but the new episode stays *unopened*: `episodeStartMs` is `null`, mass and
     * sample count are zero and no provider baseline is taken. The first
     * magnitude sample of that phase opens the episode at its own instant and
     * takes the baseline there, so numerator and denominator share one origin.
     */
    if (nextPhase !== null && nextPhase !== this.streamingPhase) {
      this.streamingPhase = nextPhase
      this.episodeStartMs = null
      this.episodeTokenMass = 0
      this.episodeSampleCount = 0
      this.episodeUsageBaseline = null
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
   *
   * The fallback is measured on the output episode's own clock, which exists only
   * once a magnitude sample opened it. Before that, `episodeStartMs` is `null`
   * and neither the episode's rate nor the stand-in is published: a phase that has
   * produced nothing yet has nothing to stand in for.
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



;Object.assign(__exports, { PHASE, LivePhase, MIN_WARMUP_SAMPLES, FIRST_OUTPUT_GUARD_MS, LiveMeter })
			},
			"src/core/delta-accounting.js": function (__exports) {
/**
 * Delta accounting: which DSH stream/chunk shapes contribute to model-output
 * telemetry, and how the compact durable stream runs reconstruct their exact
 * timed delta sequence.
 *
 * Local evidence for these shapes (DSH 0.1.5-rc.2):
 *   @deepseek-ai/dsh-llm/lib/types/types.d.ts:359-389       StreamChunk union
 *   @deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts:16-40  AssistantStreamRecord
 *   @deepseek-ai/dsh-llm/lib/index.js:1206-1246             expandAssistantStream
 *   @deepseek-ai/dsh-llm/lib/index.js:1495-1505             validateRun (dt invariants)
 *   @deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts:72-78  isTokenDelta
 *
 * Nothing here is imported from DSH: `@deepseek-ai/dsh-llm` declares no
 * `dsh.client` manifest, so its modules are not requireable from a browser
 * bundle (see docs/IMPLEMENTATION_LOG.md). This module is the single
 * implementation of the rule for both halves.
 */

/** Content kinds this project accounts for. `null` means "not model output". */
const MODEL_PHASE = Object.freeze({ REASONING: 'reasoning', OUTPUT: 'output' })

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Whether one chunk carries the model's first output token, mirroring DSH's
 * `isTokenDelta`: true for a non-empty text, reasoning or tool-argument
 * fragment and for every name-bearing tool-call delta; false for block, usage
 * and finish chunks.
 *
 * @param {unknown} chunk
 * @returns {boolean}
 */
function isTokenDelta(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return isNonEmptyString(chunk.text)
    case 'tool-call-delta':
      // DSH's predicate is `argumentsDelta !== '' || name !== undefined`, i.e. a
      // name-*bearing* delta qualifies even when the name is the empty string
      // (`dsh-llm/lib/types/assistant-stream.js`, isTokenDelta). The accumulator
      // can emit such a delta: an empty name degrades to a raw `chunk` record,
      // whose expansion restores `name: ''`. Matching DSH exactly matters here
      // because this predicate defines the first-token boundary used by TTFT.
      return isNonEmptyString(chunk.argumentsDelta) || chunk.name !== undefined
    default:
      return false
  }
}

/**
 * Map one StreamChunk to the phase it contributes tokens to.
 *
 * `tool-call-delta.argumentsDelta` is model output: shell commands, file
 * bodies, edit patches and any other tool arguments are generated by the
 * model. Tool results never reach this function.
 *
 * @param {unknown} chunk
 * @returns {'reasoning'|'output'|null}
 */
function classifyDelta(chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  if (chunk.type === 'reasoning-delta' && isNonEmptyString(chunk.text)) return MODEL_PHASE.REASONING
  if (chunk.type === 'text-delta' && isNonEmptyString(chunk.text)) return MODEL_PHASE.OUTPUT
  if (chunk.type === 'tool-call-delta' && isNonEmptyString(chunk.argumentsDelta)) return MODEL_PHASE.OUTPUT
  return null
}

/**
 * The complete first-token verdict for one chunk: DSH's predicate, the phase the
 * boundary belongs to, and whether the chunk also carries a usable magnitude.
 *
 * `isTokenDelta` and `classifyDelta` answer two different questions, and exactly
 * one chunk shape makes them disagree: a **name-bearing** `tool-call-delta` whose
 * `argumentsDelta` is empty. DSH counts it as the model's first token (the call
 * has begun; its name is the evidence), while `classifyDelta` finds no argument
 * text to attribute and answers `null`.
 *
 * Before this function existed, three call sites resolved that disagreement
 * independently, and all three resolved it wrongly for TTFT: the adapter only
 * published `classifyDelta`, the controller dropped any chunk that produced no
 * sample, and `LiveMeter.firstTokenMs` was frozen only by an accepted sample. The
 * turn therefore kept rendering the first-response stopwatch after the model had
 * already crossed its first-token boundary.
 *
 * The verdict is deliberately explicit about both facts:
 *
 *   - `countsAsToken` is DSH's boundary and is what TTFT is measured from;
 *   - `phase` is where the *state transition* belongs. It falls back to
 *     `output`, because a tool call is model output, and it is never `null` for a
 *     chunk the predicate accepts;
 *   - `contributesMagnitude` is `false` precisely when no token mass can be
 *     attributed. A boundary-only delta freezes TTFT and moves the live machine
 *     out of its first-response stage, and contributes **no** TPS-shape mass:
 *     inventing a magnitude to make the numbers look complete is the one repair
 *     this contract forbids.
 *
 * @param {unknown} chunk
 * @returns {{countsAsToken:boolean, phase:'reasoning'|'output'|null, contributesMagnitude:boolean}}
 */
function tokenEvidence(chunk) {
  if (!isTokenDelta(chunk)) {
    return { countsAsToken: false, phase: null, contributesMagnitude: false }
  }
  const phase = classifyDelta(chunk)
  return {
    countsAsToken: true,
    phase: phase ?? MODEL_PHASE.OUTPUT,
    contributesMagnitude: phase !== null,
  }
}

/**
 * The **phase cut** one timed chunk records, or `null` when it records none.
 *
 * A cut is the evidence a non-magnitude boundary leaves behind: the chunk is
 * DSH's first-token evidence (`countsAsToken`) and it carries no attributable
 * magnitude (`contributesMagnitude === false`), which is exactly the name-bearing
 * `tool-call-delta` whose `argumentsDelta` is still empty. It declares the phase
 * the stream moved to and it is **not** a TPS-shape sample — turning it into one
 * would fabricate a magnitude and a sample count, and dropping it would leave the
 * completed curve bridging an episode the live meter had already closed
 * (`docs/METRICS_SPEC.md` §8.7).
 *
 * @param {{timeMs:number, chunk:unknown}} timedChunk
 * @returns {{timeMs:number, phase:'reasoning'|'output'}|null}
 */
function phaseCutOf(timedChunk) {
  if (!timedChunk || !Number.isFinite(timedChunk.timeMs)) return null
  const evidence = tokenEvidence(timedChunk.chunk)
  if (!evidence.countsAsToken || evidence.contributesMagnitude) return null
  return { timeMs: timedChunk.timeMs, phase: evidence.phase }
}

/**
 * Every phase cut a decoded chunk sequence carries, in stream order.
 *
 * This is the bulk form of {@link phaseCutOf}, and it is the rule the **durable**
 * reconstruction uses: a compact settlement's decoded stream reaches the store
 * either one `acceptChunk` at a time (`materializeReconstructedTurn`) or as a
 * whole attempt record (`attemptFromDecoded`, which the live controller's reload
 * branch restores directly), and both must publish the same cuts or a reloaded
 * card would disagree with the card the live session showed.
 *
 * @param {readonly {timeMs:number, chunk:unknown}[]} timedChunks
 * @returns {{timeMs:number, phase:'reasoning'|'output'}[]}
 */
function phaseCutsFromChunks(timedChunks) {
  const cuts = []
  for (const entry of Array.isArray(timedChunks) ? timedChunks : []) {
    const cut = phaseCutOf(entry)
    if (cut !== null) cuts.push(cut)
  }
  return cuts
}

/** Generated text of one chunk, or the empty string for non-generated chunks. */
function deltaText(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  switch (chunk.type) {
    case 'reasoning-delta':
    case 'text-delta':
      return typeof chunk.text === 'string' ? chunk.text : ''
    case 'tool-call-delta':
      return typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
    default:
      return ''
  }
}

/** One in-stream `usage` chunk carries authoritative aggregate usage mid-attempt. */
function usageFromChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  if (chunk.type !== 'usage') return null
  const usage = chunk.usage
  if (!usage || typeof usage !== 'object') return null
  return Number.isFinite(usage.outputTokens) ? usage : null
}

/**
 * Rebuild the exact timed delta sequence of one compact durable stream.
 *
 * `dt` is a per-step gap array with `dt.length === members.length - 1`; member
 * `i > 0` occurs `dt[i - 1]` ms after member `i - 1`
 * (`dsh-llm/lib/index.js:1218-1220`, invariant at `:1499`). Delta boundaries are
 * therefore preserved exactly, which is what lets the completed curve keep real
 * intra-stream stalls after a reload.
 *
 * Malformed records are skipped rather than throwing: a curve with one missing
 * run degrades, while an exception would lose the whole turn card.
 *
 * @param {readonly object[]} records compact `AssistantStreamRecord` values
 * @returns {{timeMs:number, chunk:object}[]} timed chunks in stream order
 */
function expandAssistantStream(records) {
  const out = []
  if (!Array.isArray(records)) return out
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      if (Number.isFinite(record.time) && record.chunk && typeof record.chunk === 'object') {
        out.push({ timeMs: record.time, chunk: record.chunk })
      }
      continue
    }
    const members = runMembers(record)
    if (members === null) continue
    const dt = Array.isArray(record.dt) ? record.dt : null
    if (members.length > 1 && (dt === null || dt.length !== members.length - 1)) continue
    let timeMs = record.time0
    if (!Number.isFinite(timeMs)) continue
    for (let i = 0; i < members.length; i += 1) {
      if (i > 0) {
        const gap = dt[i - 1]
        if (!Number.isFinite(gap)) { timeMs = NaN; break }
        timeMs += gap
      }
      const chunk = runMemberChunk(record, members[i])
      if (chunk === null) continue
      out.push({ timeMs, chunk })
    }
  }
  return out
}

function runMembers(record) {
  if (record.type === 'tool-call-chunks') return Array.isArray(record.args) ? record.args : null
  if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
    return Array.isArray(record.texts) ? record.texts : null
  }
  return null
}

function runMemberChunk(record, member) {
  // A member that is not a string cannot reconstruct a delta; skipping it keeps
  // one malformed member from costing the whole run.
  if (typeof member !== 'string') return null
  if (record.type === 'text-chunks') {
    return { type: 'text-delta', index: record.index, text: member }
  }
  if (record.type === 'reasoning-chunks') {
    return { type: 'reasoning-delta', index: record.index, text: member }
  }
  const chunk = { type: 'tool-call-delta', index: record.index, id: record.id, argumentsDelta: member }
  if (typeof record.name === 'string') chunk.name = record.name
  return chunk
}

/** Time of the first member that {@link isTokenDelta} accepts, or `null`. */
function firstTokenTime(timedChunks) {
  if (!Array.isArray(timedChunks)) return null
  for (const entry of timedChunks) {
    if (!entry || !Number.isFinite(entry.timeMs)) continue
    if (isTokenDelta(entry.chunk)) return entry.timeMs
  }
  return null
}

/**
 * Why one compact stream record could not be decoded exactly.
 *
 * These are the *whole* failure surface. Anything not listed here is decoded,
 * so a caller that sees an empty `issues` array has every original delta
 * boundary, in order, with its exact reconstructed timestamp.
 */
const DECODE_ISSUE = Object.freeze({
  /** The record is not a JSON object. */
  NOT_AN_OBJECT: 'not-an-object',
  /** `record.type` is absent or unrecognized. */
  UNKNOWN_TYPE: 'unknown-type',
  /** The record has keys outside its declared shape. */
  UNEXPECTED_KEYS: 'unexpected-keys',
  /** A required key is missing. */
  MISSING_KEYS: 'missing-keys',
  /** The member array (`texts`/`args`) is absent, not an array, or holds a non-string. */
  BAD_MEMBERS: 'bad-members',
  /** The member array is empty, which the accumulator never produces. */
  EMPTY_RUN: 'empty-run',
  /** `time0`/`time` is not a safe integer. */
  BAD_TIME: 'bad-time',
  /** `dt` is absent, not an array of safe integers, or not exactly members - 1 long. */
  BAD_DT: 'bad-dt',
  /** Reconstructed member times leave the safe-integer range. */
  TIME_OVERFLOW: 'time-overflow',
  /** A tool-call run has no usable `id`. */
  BAD_CALL_ID: 'bad-call-id',
  /** A raw `chunk` record carries no usable chunk object. */
  BAD_RAW_CHUNK: 'bad-raw-chunk',
})

function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function exactKeys(record, keys) {
  const own = Object.keys(record)
  if (own.length !== keys.length) return false
  return keys.every(key => Object.hasOwn(record, key))
}

/** Decide the member array and the issue for one non-`chunk` record. */
function strictRunMembers(type, record) {
  const label = type === 'tool-call-chunks' ? 'args' : 'texts'
  const value = record[label]
  if (!Array.isArray(value)) return { members: null, issue: DECODE_ISSUE.BAD_MEMBERS }
  if (value.some(member => typeof member !== 'string')) return { members: null, issue: DECODE_ISSUE.BAD_MEMBERS }
  // The accumulator always packs at least one member, so an empty run is a
  // malformed record rather than an attempt that produced nothing.
  if (value.length === 0) return { members: null, issue: DECODE_ISSUE.EMPTY_RUN }
  return { members: value, issue: null }
}

/**
 * Strict decoder for DSH's compact durable `AssistantStreamRecord[]`.
 *
 * This is the validating counterpart of {@link expandAssistantStream}, which
 * exists for the tolerant live path. The two differ deliberately:
 *
 *   - `expandAssistantStream` never throws and skips what it cannot read, so a
 *     single corrupt record costs one curve segment instead of the whole card;
 *   - this decoder reports *every* deviation with its record index and never
 *     fabricates a delta. It is the one a durable reconstruction must use,
 *     because a reconstruction that silently drops half a stream would produce
 *     a TPS curve that looks authoritative and is wrong.
 *
 * The validation rules mirror `validateRecord`/`validateRun`
 * (`dsh-llm/lib/types/assistant-stream.js`): exact key sets, non-empty string
 * member arrays, safe-integer `time0`/`time`, `dt.length === members - 1` with
 * safe-integer entries, non-empty `id`, and non-empty `name` when present.
 *
 * @param {unknown} records candidate compact records
 * @returns {{
 *   chunks: {timeMs:number, chunk:object, recordIndex:number, memberIndex:number}[],
 *   issues: {kind:string, recordIndex:number, detail?:unknown}[],
 *   issuesTruncated: boolean,
 *   recordCount: number,
 *   decodedRecordCount: number,
 *   deltaCount: number,
 *   firstTimeMs: number|null,
 *   lastTimeMs: number|null,
 *   complete: boolean,
 * }}
 */
function decodeAssistantStream(records, { maxIssues = 50 } = {}) {
  const chunks = []
  const issues = []
  let issuesTruncated = false
  const list = Array.isArray(records) ? records : null

  const report = (kind, recordIndex, detail) => {
    if (issues.length >= maxIssues) { issuesTruncated = true; return }
    issues.push(detail === undefined ? { kind, recordIndex } : { kind, recordIndex, detail })
  }

  if (list === null) {
    report(Array.isArray(records) ? DECODE_ISSUE.NOT_AN_OBJECT : DECODE_ISSUE.NOT_AN_OBJECT, -1, records)
    return {
      chunks,
      issues,
      issuesTruncated,
      recordCount: 0,
      decodedRecordCount: 0,
      deltaCount: 0,
      firstTimeMs: null,
      lastTimeMs: null,
      complete: false,
    }
  }

  for (let recordIndex = 0; recordIndex < list.length; recordIndex += 1) {
    const candidate = list[recordIndex]
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      report(DECODE_ISSUE.NOT_AN_OBJECT, recordIndex)
      continue
    }
    const type = candidate.type
    if (type === 'chunk') {
      if (!exactKeys(candidate, ['type', 'time', 'chunk'])) {
        report(DECODE_ISSUE.UNEXPECTED_KEYS, recordIndex, Object.keys(candidate))
        continue
      }
      if (!isSafeInteger(candidate.time)) {
        report(DECODE_ISSUE.BAD_TIME, recordIndex, candidate.time)
        continue
      }
      const chunk = candidate.chunk
      if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) {
        report(DECODE_ISSUE.BAD_RAW_CHUNK, recordIndex)
        continue
      }
      chunks.push({ timeMs: candidate.time, chunk, recordIndex, memberIndex: 0 })
      continue
    }

    if (type !== 'text-chunks' && type !== 'reasoning-chunks' && type !== 'tool-call-chunks') {
      report(DECODE_ISSUE.UNKNOWN_TYPE, recordIndex, type)
      continue
    }

    const isToolRun = type === 'tool-call-chunks'
    const memberLabel = isToolRun ? 'args' : 'texts'
    const keys = isToolRun
      ? (Object.hasOwn(candidate, 'name')
        ? ['type', 'time0', 'index', 'dt', 'id', 'name', 'args']
        : ['type', 'time0', 'index', 'dt', 'id', 'args'])
      : ['type', 'time0', 'index', 'dt', 'texts']
    if (!exactKeys(candidate, keys)) {
      const own = Object.keys(candidate)
      const missing = keys.filter(key => !own.includes(key))
      report(missing.length > 0 ? DECODE_ISSUE.MISSING_KEYS : DECODE_ISSUE.UNEXPECTED_KEYS, recordIndex, {
        expected: keys,
        own,
      })
      continue
    }
    if (!isSafeInteger(candidate.time0)) {
      report(DECODE_ISSUE.BAD_TIME, recordIndex, candidate.time0)
      continue
    }
    const membersResult = strictRunMembers(type, candidate)
    if (membersResult.members === null) {
      report(membersResult.issue, recordIndex, candidate[memberLabel])
      continue
    }
    const members = membersResult.members
    const dt = candidate.dt
    if (!Array.isArray(dt) || dt.length !== members.length - 1 || dt.some(gap => !isSafeInteger(gap))) {
      report(DECODE_ISSUE.BAD_DT, recordIndex, { dtLength: Array.isArray(dt) ? dt.length : null, memberCount: members.length })
      continue
    }
    if (isToolRun) {
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
        report(DECODE_ISSUE.BAD_CALL_ID, recordIndex, candidate.id)
        continue
      }
      if (candidate.name !== undefined && (typeof candidate.name !== 'string' || candidate.name.length === 0)) {
        report(DECODE_ISSUE.BAD_MEMBERS, recordIndex, { name: candidate.name })
        continue
      }
    }

    let timeMs = candidate.time0
    let overflowed = false
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      if (memberIndex > 0) {
        timeMs += dt[memberIndex - 1]
        if (!Number.isSafeInteger(timeMs)) { overflowed = true; break }
      }
      const chunk = isToolRun
        ? toolCallChunk(candidate, members[memberIndex])
        : deltaChunk(type, candidate.index, members[memberIndex])
      chunks.push({ timeMs, chunk, recordIndex, memberIndex })
    }
    if (overflowed) {
      // Members already produced stay in `chunks`: dropping them would discard
      // real evidence, and `complete` already reports that the run is short.
      report(DECODE_ISSUE.TIME_OVERFLOW, recordIndex)
    }
  }

  const times = chunks.map(entry => entry.timeMs)
  return {
    chunks,
    issues,
    issuesTruncated,
    recordCount: list.length,
    decodedRecordCount: new Set(chunks.map(entry => entry.recordIndex)).size,
    deltaCount: chunks.length,
    firstTimeMs: times.length > 0 ? Math.min(...times) : null,
    lastTimeMs: times.length > 0 ? Math.max(...times) : null,
    complete: issues.length === 0,
  }
}

function deltaChunk(type, index, text) {
  return type === 'text-chunks'
    ? { type: 'text-delta', index, text }
    : { type: 'reasoning-delta', index, text }
}

function toolCallChunk(record, argumentsDelta) {
  const chunk = { type: 'tool-call-delta', index: record.index, id: record.id, argumentsDelta }
  if (typeof record.name === 'string') chunk.name = record.name
  return chunk
}

;Object.assign(__exports, { MODEL_PHASE, isTokenDelta, classifyDelta, tokenEvidence, phaseCutOf, phaseCutsFromChunks, deltaText, usageFromChunk, expandAssistantStream, firstTokenTime, DECODE_ISSUE, decodeAssistantStream })
			},
			"src/core/token-allocation.js": function (__exports) {
const { MetricQuality } = __req("src/core/metric-quality.js")
const { classifyDelta, deltaText } = __req("src/core/delta-accounting.js")
const { TemporalAllocationMode, analyzePhaseEvidence } = __req("src/core/phase-evidence.js")

/**
 * Live token-shape weighting and post-hoc calibration.
 *
 * DSH does not attach an exact token count to each streamed delta; provider
 * usage arrives as an aggregate (`TokenUsage`). Every per-delta number this
 * module produces is therefore a *shape*, and the only honest operations are
 * (a) label it estimated and (b) rescale the shape so its integral equals the
 * authoritative aggregate once that aggregate is known.
 *
 * Calibration guarantees, asserted by tests:
 *   - `totalAnchored === true` implies the sample integral equals the attempt's
 *     authoritative `outputTokens` exactly (relative error < 1e-9), because the
 *     scaling products sum algebraically to that total. This holds in **both**
 *     anchored modes and is the Phase 7C.2 invariant;
 *   - the per-phase exact split is used only when the provider counters and the
 *     observed stream phases agree (`analyzePhaseEvidence`). A phase the provider
 *     counted but the stream never showed cannot be placed in time, so the whole
 *     attempt falls back to one common scale — the phase's tokens stay inside the
 *     total instead of being dropped with it;
 *   - a phase with tokens but no shape weight distributes evenly rather than
 *     dividing by zero;
 *   - a contradiction is never repaired by inventing a sample, never by assigning
 *     zero tokens to a phase the stream really recorded, and never by silently
 *     clamping an impossible split into a plausible one.
 */

/**
 * Fallback shape weight for live display only. This is **not** a tokenizer and
 * must never be presented as provider-exact: the project rules forbid assuming
 * GPT/tiktoken tokenization for DeepSeek or any other route, and DSH's own token
 * meter uses an approximate character heuristic when provider-exact usage is
 * unavailable.
 *
 * CJK-like code points weigh 1; everything else weighs 0.25. The ratio is a
 * deliberate coarse prior (roughly one token per CJK character, roughly four
 * Latin characters per token) whose only role is to shape the live and curve
 * series until calibration replaces it.
 */
function heuristicTokenWeight(text) {
  if (!text) return 0
  let weight = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    const cjk = (cp >= 0x3400 && cp <= 0x9fff)
      || (cp >= 0x3040 && cp <= 0x30ff)
      || (cp >= 0xac00 && cp <= 0xd7af)
      || (cp >= 0xf900 && cp <= 0xfaff)
    weight += cjk ? 1 : 0.25
  }
  return weight
}

/**
 * Build one chart/live sample from a chunk, or `null` when the chunk carries no
 * generated content (block, usage and finish chunks carry none).
 *
 * @param {number} timeMs
 * @param {unknown} chunk
 * @param {(text:string, phase:string, chunk:unknown)=>number} [estimate]
 */
function sampleFromChunk(timeMs, chunk, estimate = heuristicTokenWeight) {
  const phase = classifyDelta(chunk)
  if (phase === null) return null
  if (!Number.isFinite(timeMs)) return null
  const text = deltaText(chunk)
  const weight = estimate(text, phase, chunk)
  if (!(weight > 0) || !Number.isFinite(weight)) {
    // A generated delta whose shape weight is zero is still evidence that
    // generation happened. Give it a minimal non-zero shape so it cannot vanish
    // from the series; calibration later fixes its magnitude.
    return { timeMs, phase, weight: Number.EPSILON, tokens: Number.EPSILON, quality: MetricQuality.ESTIMATED }
  }
  return { timeMs, phase, weight, tokens: weight, quality: MetricQuality.ESTIMATED }
}

/** Sample a whole timed chunk list, dropping non-generated chunks. */
function samplesFromTimedChunks(timedChunks, estimate = heuristicTokenWeight) {
  const out = []
  if (!Array.isArray(timedChunks)) return out
  for (const entry of timedChunks) {
    if (!entry) continue
    const sample = sampleFromChunk(entry.timeMs, entry.chunk, estimate)
    if (sample !== null) out.push(sample)
  }
  return out
}

/**
 * Rescale one phase's shape weights so their integral equals `exactTokens`.
 * Pure: returns new objects and never mutates the input.
 */
function calibratePhase(samples, exactTokens) {
  if (!Array.isArray(samples)) return []
  if (!Number.isFinite(exactTokens) || exactTokens < 0) return samples.slice()
  if (samples.length === 0) return []
  const totalWeight = samples.reduce((sum, s) => sum + Math.max(0, s.weight ?? 0), 0)
  const each = exactTokens / samples.length
  if (!(totalWeight > 0)) {
    return samples.map(s => ({ ...s, tokens: each, quality: MetricQuality.CALIBRATED }))
  }
  const scale = exactTokens / totalWeight
  return samples.map(s => ({
    ...s,
    tokens: Math.max(0, s.weight ?? 0) * scale,
    quality: MetricQuality.CALIBRATED,
  }))
}

/**
 * Calibrate one attempt's samples against authoritative provider usage, and report
 * how much of that usage the stream's own evidence supports.
 *
 * `reasoningTokens`, when present, is already included in `outputTokens`
 * (verified local contract at `dsh-llm/lib/types/types.d.ts:136-150`), so the
 * non-reasoning output total is `outputTokens - reasoningTokens`. The two
 * counters are never added.
 *
 * ## The invariant this function now guarantees
 *
 *     totalAnchored === true  =>  sum(samples[].tokens) === outputTokens
 *
 * The previous revision could violate it. With `reasoningTokens > 0` and **no**
 * reasoning delta in the stream it calibrated the output phase against
 * `outputTokens - reasoningTokens` and the (empty) reasoning phase against
 * `reasoningTokens`, then published `totalAnchored: true`. The reasoning tokens
 * were silently dropped from the curve: the samples summed to
 * `outputTokens - reasoningTokens` while every consumer was told the attempt was
 * anchored. `totalAnchored` now means exactly what it says, because the
 * exact-split branch is entered only when the provider counters and the observed
 * phases agree (`analyzePhaseEvidence`).
 *
 * @param {readonly object[]} samples
 * @param {{outputTokens?:number, reasoningTokens?:number}|null|undefined} usage
 * @returns {{
 *   samples: object[],
 *   phaseTokens: {reasoning:number|null, output:number|null},
 *   totalTokens: number|null,
 *   totalQuality: string,
 *   splitQuality: string,
 *   totalAnchored: boolean,
 *   temporalAllocationMode: string,
 *   evidence: object,
 *   note: string|null,
 * }}
 */
function calibrateAttemptSamples(samples, usage) {
  const list = Array.isArray(samples) ? samples : []
  const outputTokens = usage?.outputTokens
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    return {
      // No authoritative anchor exists, so the per-delta allocation stays at the
      // raw shape weight and is labelled `estimated`. It is never presented as a
      // token count.
      samples: list.map(s => ({
        ...s,
        tokens: Math.max(0, s.weight ?? 0),
        quality: MetricQuality.ESTIMATED,
      })),
      phaseTokens: { reasoning: null, output: null },
      totalTokens: null,
      totalQuality: MetricQuality.UNAVAILABLE,
      splitQuality: MetricQuality.UNAVAILABLE,
      totalAnchored: false,
      temporalAllocationMode: TemporalAllocationMode.UNANCHORED,
      evidence: analyzePhaseEvidence(list, null, undefined),
      note: 'no authoritative usage',
    }
  }

  const evidence = analyzePhaseEvidence(list, outputTokens, usage?.reasoningTokens)

  if (evidence.splitUsable) {
    /**
     * The provider total **and** its phase split can both be mapped onto observed
     * stream evidence, so each phase is calibrated against its own counter. This is
     * the only branch that may claim an exact per-phase temporal allocation.
     */
    const reasoningSamples = calibratePhase(
      list.filter(s => s.phase === 'reasoning'),
      evidence.reasoningTotal,
    )
    const outputSamples = calibratePhase(
      list.filter(s => s.phase === 'output'),
      evidence.outputTotal,
    )
    let ri = 0
    let oi = 0
    const merged = list.map(s => (s.phase === 'reasoning' ? reasoningSamples[ri++] : outputSamples[oi++]))
    return {
      samples: merged,
      phaseTokens: { reasoning: evidence.reasoningTotal, output: evidence.outputTotal },
      totalTokens: outputTokens,
      totalQuality: MetricQuality.EXACT,
      splitQuality: MetricQuality.EXACT,
      totalAnchored: true,
      temporalAllocationMode: TemporalAllocationMode.PHASE_ANCHORED,
      evidence,
      note: null,
    }
  }

  /**
   * Fallback: the provider total is authoritative, the phase split is not usable
   * as a temporal allocation. This covers both the absent counter and every
   * contradiction `analyzePhaseEvidence` reports.
   *
   * One common factor is applied across **every** observed generated sample, so
   * the whole-attempt integral is the authoritative total and the observed
   * temporal shape and phase labels are preserved. Per the Phase 7C.2 brief:
   * a missing phase is neither invented, nor discarded, nor allowed to zero a
   * phase the stream really recorded. What is *not* claimed is that the
   * phase-temporal allocation is exact — hence `total-anchored`.
   *
   * The provider's phase counters are still reported in `phaseTokens` when a split
   * exists: they are a provider summary fact (docs/METRICS_SPEC.md §8.3), separate
   * from the curve's temporal allocation, and the split quality says how far they
   * may be trusted.
   */
  const rescaled = calibrateTotally(list, outputTokens)
  /**
   * A contradicted split withholds the phase pair; an absent one does not. `splitAvailable`
   * is true in exactly the contradiction cases that reach this branch, so the two
   * conditions are stated separately rather than folded into one.
   */
  const splitWithheld = evidence.contradictions.length > 0 || evidence.splitAvailable
  return {
    samples: rescaled,
    /**
     * What may be published as the per-phase division of the total.
     *
     * A **contradicted** split is refused: the provider's counters are not republished as
     * the phase pair, because doing so was half of the 7C.2 defect — the pair read
     * `reasoning 74 / output 70` while the curve carried 70. The provider's own numbers stay
     * available as the summary fact they are, in `evidence.contradictions[]`, and the
     * anchored attribution of the observed samples is published instead.
     *
     * An **absent** split is a quality level, not a conflict, and keeps its long-standing
     * reading: the shape division of the anchored total
     * (`docs/METRICS_SPEC.md` §8.3, frozen in Phase 4).
     */
    phaseTokens: splitWithheld
      ? publishablePhasePair(evidence.reasoningTotal, evidence.outputTotal)
      : attributedPhaseTokens(rescaled),
    totalTokens: outputTokens,
    totalQuality: MetricQuality.EXACT,
    splitQuality: evidence.splitAvailable ? MetricQuality.UNAVAILABLE : MetricQuality.ESTIMATED,
    totalAnchored: true,
    temporalAllocationMode: TemporalAllocationMode.TOTAL_ANCHORED,
    evidence,
    note: evidence.notes.length > 0
      ? evidence.notes.join('; ')
      : 'reasoningTokens absent: whole-attempt integral anchored, reasoning/output split estimated',
  }
}

/**
 * A per-phase pair fit to publish, from a provider split that was contradicted.
 *
 * The counters are a provider summary fact and are retained as such, but only where each is a
 * real count. An impossible split carries `NaN` in one or both members (see
 * `analyzePhaseEvidence`), and a non-finite counter is published as `null` — "no evidence" —
 * rather than as a negative number or a clamped zero.
 */
function publishablePhasePair(reasoning, output) {
  return {
    reasoning: Number.isFinite(reasoning) ? reasoning : null,
    output: Number.isFinite(output) ? output : null,
  }
}

/**
 * Sum the rescaled samples per phase and report each phase as a count, or `null` when the
 * phase has no evidence at all. `null` and `0` are different facts and only a phase that
 * really produced nothing gets the latter, which the caller decides from the split counters.
 */
function attributedPhaseTokens(samples) {
  let reasoning = 0
  let output = 0
  for (const sample of samples) {
    const tokens = Math.max(0, sample.tokens ?? sample.weight ?? 0)
    if (sample.phase === 'reasoning') reasoning += tokens
    else if (sample.phase === 'output') output += tokens
  }
  return {
    reasoning: reasoning > 0 ? reasoning : null,
    output: output > 0 ? output : null,
  }
}

/**
 * Apply one common scale to every observed generated sample so their integral is
 * `exactTokens`.
 *
 * Shared by the absent-counter case and every contradictory-split case, because
 * the mathematics is identical and duplicating it is how the two paths drifted
 * apart before. When the samples carry no positive weight at all the total is
 * divided evenly rather than by zero.
 */
function calibrateTotally(samples, exactTokens) {
  if (!Array.isArray(samples)) return []
  if (!Number.isFinite(exactTokens) || exactTokens < 0) return samples.slice()
  if (samples.length === 0) return []
  const totalWeight = samples.reduce((sum, s) => sum + Math.max(0, s.weight ?? 0), 0)
  const each = exactTokens / samples.length
  if (!(totalWeight > 0)) {
    return samples.map(s => ({ ...s, tokens: each, quality: MetricQuality.CALIBRATED }))
  }
  const scale = exactTokens / totalWeight
  return samples.map(s => ({
    ...s,
    tokens: Math.max(0, s.weight ?? 0) * scale,
    quality: MetricQuality.CALIBRATED,
  }))
}

;Object.assign(__exports, { heuristicTokenWeight, sampleFromChunk, samplesFromTimedChunks, calibratePhase, calibrateAttemptSamples, calibrateTotally })
			},
			"src/core/time-axis.js": function (__exports) {
/**
 * The compressed curve clock.
 *
 * The completed chart diagnoses model throughput stability, not end-to-end turn
 * latency, so its x-axis is an *active model-generation* coordinate:
 *
 *   - an attempt's local x = 0 is its first non-empty generated delta, so the
 *     attempt's own TTFT consumes no width;
 *   - distances between deltas inside one attempt are preserved exactly, which
 *     keeps real intra-stream stalls visible;
 *   - an attempt's local x ends at its **terminal phase episode's end**: the
 *     attempt's settlement instant when one is known, and its last generated
 *     delta otherwise. That tail is model-attempt elapsed time under the
 *     MiMo-style definition — the numerator freezes while the denominator
 *     advances — so it is drawn rather than discarded. Nothing else is
 *     allocated after it: not for the next call's TTFT, not for the tool that
 *     follows;
 *   - the next attempt starts at the previous attempt's end, so tools,
 *     inter-attempt waiting and the next call's TTFT consume no width.
 *
 * The last two rules are one rule applied to every attempt, including the final
 * one: the axis is model-attempt time, and a tool wait between two attempts is
 * not. The final attempt is not a special case.
 *
 * Formally this is a piecewise-linear remap of wall time. It is implemented as
 * explicit per-attempt concatenation rather than as one global clock minus
 * subtracted wall intervals, because concatenation cannot silently mis-attribute
 * a gap that spans a boundary.
 *
 * **Two clocks per sample, and conflating them is a real defect.** Each
 * compressed sample carries both, because the curve needs both:
 *
 *   - `activeTimeMs` is the **turn-compressed coordinate**, continuous across
 *     attempts. It is what the x-axis is drawn against and what `phaseRuns`
 *     reports its intervals in;
 *   - `attemptTimeMs` is the **attempt-local** instant, measured from that
 *     attempt's own first delta. A phase episode's cumulative clock is defined
 *     on *this* clock: it is a property of one model call, not of the
 *     concatenated axis.
 *
 * The earlier revision published only `activeTimeMs` and then filtered it per
 * attempt. For the first attempt the two happen to coincide, so the code looked
 * correct; for every later attempt the "local" clock silently started at the
 * turn-global offset and its opening vertices read a rate assembled from nothing
 * (`test/curve-attempt-boundary.test.js`).
 *
 * A tool gap therefore has zero coordinate width *and* remains an absolute
 * episode boundary. Compressed coordinates being continuous does not make the
 * phase clock continuous, and code that conflates the two credits one model call
 * with another call's tokens.
 */

/**
 * @param {readonly {
 *   attemptId?:string, samples?:readonly object[], settledAtMs?:number|null,
 *   phaseCuts?:readonly {timeMs:number, phase:string}[],
 * }[]} attempts
 * @returns {{
 *   samples: object[],
 *   cuts: object[],
 *   durationMs: number,
 *   segments: {
 *     attemptId:string|null, startMs:number, endMs:number, localEndMs:number,
 *     sampleCount:number, phaseCutCount:number, preOriginCutCount:number,
 *   }[],
 * }}
 *   `cuts` are the attempts' **non-magnitude phase boundaries** on the same two
 *   clocks the samples carry. A cut that precedes its attempt's first generated
 *   sample has no coordinate on this axis — an attempt's local zero is its first
 *   delta, so a boundary before it lies outside the axis entirely — and is counted
 *   in `segments[].preOriginCutCount` rather than clamped onto zero, which would
 *   invent a pre-sample instant the evidence does not contain.
 */
function compressAttempts(attempts) {
  const out = []
  const cuts = []
  const segments = []
  let offsetMs = 0
  if (!Array.isArray(attempts)) return { samples: out, cuts, durationMs: 0, segments }

  for (const attempt of attempts) {
    if (!attempt) continue
    const stored = Array.isArray(attempt.samples)
      ? attempt.samples.filter(s => s && Number.isFinite(s.timeMs))
      : []
    /**
     * **The stored arrays are the authoritative order.** `TurnTelemetryStore.acceptChunk`
     * appends, and both reconstruction paths preserve the decoded member order —
     * `attemptFromDecoded` walks `decoded.chunks` in order and the live path appends each
     * frame as it arrives. Position in the array is therefore the order the model's stream
     * delivered the deltas in, and it is the only evidence of that order this project has.
     *
     * The ordinal is captured **before** any timestamp sort, so a delta that arrives later
     * but carries an earlier clock still sorts after its predecessor at the same instant.
     * It is published as `sampleOrder` so nothing downstream has to infer the order from a
     * phase name or from whichever array a caller happens to hand in.
     */
    const ordered = stored.map((sample, index) => ({
      sample,
      sampleOrder: Number.isFinite(sample.sampleOrder) ? sample.sampleOrder : index,
    }))
    ordered.sort((a, b) => (
      a.sample.timeMs - b.sample.timeMs
      || a.sampleOrder - b.sampleOrder
    ))
    const samples = ordered.map(entry => entry.sample)
    if (samples.length === 0) continue
    const first = samples[0].timeMs
    const last = samples[samples.length - 1].timeMs
    const attemptId = attempt.attemptId ?? null
    for (const entry of ordered) {
      const localMs = Math.max(0, entry.sample.timeMs - first)
      out.push({
        ...entry.sample,
        attemptId,
        /** Attempt-local instant: the clock a phase episode is measured on. */
        attemptTimeMs: localMs,
        /** Turn-compressed coordinate: the clock the chart is drawn against. */
        activeTimeMs: offsetMs + localMs,
        /** Authoritative stream ordinal, so the tie-break at one instant is stated, not implied. */
        sampleOrder: entry.sampleOrder,
      })
    }
    /**
     * **The attempt's width is its terminal episode's end minus its first delta.**
     * The settlement instant ends the terminal episode (Phase 9.2), so an attempt
     * that settled 40 ms after its last delta owns those 40 ms of clock; an attempt
     * whose settlement was never observed keeps the last delta as its end. A
     * settlement recorded *before* the last delta is clock skew and is refused
     * rather than allowed to shrink real generation time.
     */
    const settledAtMs = Number.isFinite(attempt.settledAtMs) ? attempt.settledAtMs : null
    const span = Math.max(
      0,
      last - first,
      settledAtMs === null ? 0 : Math.max(0, settledAtMs - first),
    )
    /**
     * The attempt's phase cuts, on the attempt-local and turn-compressed clocks.
     * They are mapped by the **same** subtraction the samples use, so a cut and a
     * sample that share an absolute instant share a coordinate, and a cut is never
     * given a width of its own: the axis is model-attempt time, and a boundary is
     * an instant on it rather than a stretch of it.
     */
    const attemptCuts = []
    let preOriginCutCount = 0
    for (const cut of Array.isArray(attempt.phaseCuts) ? attempt.phaseCuts : []) {
      if (!cut || !Number.isFinite(cut.timeMs)) continue
      const localMs = cut.timeMs - first
      if (localMs < 0) {
        preOriginCutCount += 1
        continue
      }
      attemptCuts.push({
        attemptId,
        timeMs: cut.timeMs,
        phase: cut.phase ?? null,
        /** Attempt-local instant: the clock an episode is measured on. */
        attemptTimeMs: localMs,
        /** Turn-compressed coordinate: the clock the chart is drawn against. */
        activeTimeMs: offsetMs + localMs,
      })
    }
    attemptCuts.sort((a, b) => a.attemptTimeMs - b.attemptTimeMs)
    cuts.push(...attemptCuts)
    segments.push({
      attemptId,
      startMs: offsetMs,
      endMs: offsetMs + span,
      /** The attempt's own width, so a caller need not re-derive it. */
      localEndMs: span,
      sampleCount: samples.length,
      /** Boundaries that closed an episode inside this attempt's own width. */
      phaseCutCount: attemptCuts.length,
      /** Boundaries that precede the attempt's first delta and own no coordinate here. */
      preOriginCutCount,
    })
    offsetMs += span
  }

  /**
   * **Every segment's `endMs` is the attempt's terminal episode end**, and therefore
   * also the coordinate at which the next attempt opens. Those are the same instant by
   * construction — the concatenation is what removes tool wait and next-call TTFT from the
   * axis — so no separate "where the next attempt starts" field is published, and no field
   * distinguishes the final attempt from any other.
   *
   * The previous revision ended every attempt at its last generated delta, on the reasoning
   * that a vertex past it is post-generation time. That reasoning was correct for the tool
   * and inter-attempt waits it was written for and wrong for the attempt's own settlement
   * tail, which is model-attempt elapsed time: under the MiMo-style phase-cumulative
   * definition the terminal episode runs to settlement, and a curve that stopped drawing at
   * the last delta would silently drop the decay that tail produces.
   */

  return { samples: out, cuts, durationMs: offsetMs, segments }
}

;Object.assign(__exports, { compressAttempts })
			},
			"src/core/quality-model.js": function (__exports) {
/**
 * Three-axis metric quality model.
 *
 * A single quality label for a whole curve cannot express what the evidence
 * actually supports. The same turn routinely has an exactly known token total, an
 * estimated reasoning/output split, and a reconstructed temporal shape, and
 * collapsing those into one word forces one of them to be misreported.
 *
 * Three axes are therefore tracked independently:
 *
 *   tokenTotalQuality     how well the *total* generated tokens are known
 *   phaseSplitQuality     how well that total is divided into reasoning vs output
 *   temporalShapeQuality  how well the *timing* of generation is known
 *
 * Their acceptance criteria are the semantic examples frozen in
 * `docs/METRICS_SPEC.md`. The strongest achievable value differs per axis, and
 * that asymmetry is the point:
 *
 *   - `tokenTotalQuality` can reach `exact`, because providers report aggregate
 *     output tokens;
 *   - `phaseSplitQuality` can reach `exact`, because some routes also report
 *     `reasoningTokens` — and only then, because a split nobody measured must
 *     never be called exact;
 *   - `temporalShapeQuality` can **never** reach `exact`. DSH attaches no token
 *     count to a delta, so every curve point is a shape weight, rescaled or not.
 *     The best achievable value is `reconstructed`: exact phase integrals on an
 *     estimated local shape. This is enforced structurally by the per-axis
 *     maximum below, not by convention.
 */

const { MetricQuality } = __req("src/core/metric-quality.js")

/**
 * Ordered weakest-to-strongest. `partial` and `reconstructed` are additions to
 * the four frozen levels, not replacements: `partial` distinguishes "some
 * contributors were authoritative and some were not" from a wholesale estimate,
 * and `reconstructed` distinguishes "shape weight with an exact anchor and exact
 * timing" from "rough estimate".
 */
const QualityLevel = Object.freeze({
  UNAVAILABLE: 'unavailable',
  ESTIMATED: 'estimated',
  PARTIAL: 'partial',
  RECONSTRUCTED: 'reconstructed',
  CALIBRATED: 'calibrated',
  EXACT: 'exact',
})

const RANK = Object.freeze({
  [QualityLevel.UNAVAILABLE]: 0,
  [QualityLevel.ESTIMATED]: 1,
  [QualityLevel.PARTIAL]: 2,
  [QualityLevel.RECONSTRUCTED]: 3,
  [QualityLevel.CALIBRATED]: 4,
  [QualityLevel.EXACT]: 5,
})

/** The strongest value each axis may ever carry. */
const QUALITY_CEILING = Object.freeze({
  tokenTotal: QualityLevel.EXACT,
  phaseSplit: QualityLevel.EXACT,
  temporalShape: QualityLevel.RECONSTRUCTED,
})

const QUALITY_AXIS = Object.freeze({
  TOKEN_TOTAL: 'tokenTotal',
  PHASE_SPLIT: 'phaseSplit',
  TEMPORAL_SHAPE: 'temporalShape',
})

/** Whether a value is one of the six declared levels. */
function isQualityLevel(value) {
  return Object.hasOwn(RANK, value)
}

/** The weaker of two levels. */
function weakestLevel(a, b) {
  if (!isQualityLevel(a)) return QualityLevel.UNAVAILABLE
  if (!isQualityLevel(b)) return QualityLevel.UNAVAILABLE
  return RANK[a] <= RANK[b] ? a : b
}

/** Clamp a level to its axis ceiling. */
function clampToAxis(axis, level) {
  const ceiling = QUALITY_CEILING[axis]
  if (ceiling === undefined) return QualityLevel.UNAVAILABLE
  if (!isQualityLevel(level)) return QualityLevel.UNAVAILABLE
  return RANK[level] <= RANK[ceiling] ? level : ceiling
}

/**
 * Quality of the generated-token total.
 *
 * @param {{
 *   contributingAttemptCount: number,
 *   attemptsWithUsage: number,
 *   recoveredTotals: number,
 *   reportedTotals: number,
 * }} input
 */
function tokenTotalQuality({
  contributingAttemptCount = 0,
  attemptsWithUsage = 0,
  recoveredTotals = 0,
  reportedTotals = 0,
} = {}) {
  if (contributingAttemptCount === 0) return QualityLevel.UNAVAILABLE
  if (attemptsWithUsage === 0) return QualityLevel.UNAVAILABLE
  if (recoveredTotals > 0) return QualityLevel.PARTIAL
  if (attemptsWithUsage === contributingAttemptCount) return QualityLevel.EXACT
  if (reportedTotals > 0) return QualityLevel.PARTIAL
  return QualityLevel.UNAVAILABLE
}

/**
 * Quality of the reasoning/output split.
 *
 * A split is only `exact` when every contributing attempt that carries the total
 * also carries an authoritative `reasoningTokens`. When the totals are exact but
 * the split is not, the honest answer is `estimated`: the shape prior still divides
 * the anchored total, and that division was never measured.
 *
 * When *some* contributors reported the counter and some did not, this axis answers
 * `estimated` rather than the token-total axis's `partial`. That asymmetry is
 * deliberate and is the two axes disagreeing on purpose: `tokenTotalQuality` is a
 * sum, so the sum of the attempts that reported is a real, publishable quantity
 * that is merely incomplete; the split is a *division*, and a division over a
 * population where one member has no counter cannot be published as partly
 * measured. It stays `estimated` — the shape prior still divides an anchored
 * total — which is the conservative answer and the one `docs/METRICS_SPEC.md`
 * §8.3 records.
 *
 * `reasoningStreamConflict` is the consistency guard, generalised in Phase 7C.2 from the
 * single `reasoningTokens === 0` direction to every contradiction
 * `src/core/phase-evidence.js` reports: a provider that counts reasoning tokens the
 * stream never emitted, a provider that counts zero beside real reasoning deltas, the
 * same two directions for the non-reasoning phase, and a split that is internally
 * impossible (`reasoningTokens > outputTokens`). A split derived from counters the
 * stream contradicts can never be `exact` however many attempts reported them. The
 * flag never reaches the token-total axis: `outputTokens` was counted by the provider
 * and stays exact even when the phase mapping is refused.
 */
function phaseSplitQuality({
  contributingAttemptCount = 0,
  attemptsWithSplit = 0,
  attemptsWithUsage = 0,
  splitIsAnchored = false,
  hasReasoningDeltas = false,
  hasOutputDeltas = false,
  reasoningStreamConflict = false,
} = {}) {
  if (contributingAttemptCount === 0) return QualityLevel.UNAVAILABLE
  if (attemptsWithSplit === 0) {
    // No counter at all. If only one phase is present in the stream, the other
    // phase is empty by observation rather than by assumption, and the reported
    // split is still a shape division of an authoritative total.
    if (!hasReasoningDeltas && !hasOutputDeltas) return QualityLevel.UNAVAILABLE
    return attemptsWithUsage > 0 ? QualityLevel.ESTIMATED : QualityLevel.UNAVAILABLE
  }
  if (attemptsWithSplit === contributingAttemptCount && !reasoningStreamConflict) return QualityLevel.EXACT
  return QualityLevel.ESTIMATED
}

/**
 * Quality of the temporal shape.
 *
 * `durable` and `timestampsComplete` describe the *evidence*, not the accuracy:
 * reconstructed timestamps are exact copies of the original envelope times, but
 * the token magnitude carried at each timestamp is a shape weight, so no timing
 * evidence can lift the axis past `reconstructed`.
 */
function temporalShapeQuality({
  durable = false,
  timestampsComplete = true,
  anchored = false,
  sampleCount = 0,
} = {}) {
  if (sampleCount === 0) return QualityLevel.UNAVAILABLE
  // Anchored means the phase integrals are the authoritative provider totals;
  // unanchored means the curve is still raw shape weight magnitudes.
  if (!anchored) return QualityLevel.ESTIMATED
  if (!timestampsComplete) return QualityLevel.ESTIMATED
  // `durable` records *where* the timestamps came from. A durable settlement's
  // embedded stream reproduces the original envelope times exactly, which is
  // why the anchored durable case reads `reconstructed` while a live one does
  // not: the live pane can be re-baselined or lose frames.
  return durable ? QualityLevel.RECONSTRUCTED : QualityLevel.ESTIMATED
}

/**
 * Assemble the three-axis quality object, enforcing the ceilings.
 *
 * @returns {{
 *   tokenTotalQuality: string,
 *   phaseSplitQuality: string,
 *   temporalShapeQuality: string,
 *   approximateTokenTotal: boolean,
 *   approximatePhaseSplit: boolean,
 *   displayTokenTotal: 'exact'|'approximate'|'unavailable',
 *   displayPhaseSplit: 'exact'|'approximate'|'unavailable',
 *   notes: string[],
 * }}
 */
function qualityAxes(input = {}) {
  const tokenTotal = clampToAxis(QUALITY_AXIS.TOKEN_TOTAL, tokenTotalQuality(input))
  let phaseSplit = clampToAxis(QUALITY_AXIS.PHASE_SPLIT, phaseSplitQuality(input))
  // A split cannot be better known than the total it divides.
  phaseSplit = weakestLevel(phaseSplit, tokenTotal)
  // The consistency guard is a hard ceiling on this axis: provider aggregate
  // usage contradicting the stream's phase evidence downgrades the split to at
  // most `estimated`, regardless of how many attempts reported the counter.
  if (input.reasoningStreamConflict === true) {
    phaseSplit = weakestLevel(phaseSplit, QualityLevel.ESTIMATED)
  }
  const temporalShape = clampToAxis(QUALITY_AXIS.TEMPORAL_SHAPE, temporalShapeQuality(input))

  const notes = []
  if (input.recoveredTotals > 0) {
    notes.push(`${input.recoveredTotals} of ${input.contributingAttemptCount} attempts reported no usage; their totals were recovered from the stream`)
  }
  if (input.reasoningStreamConflict === true) {
    notes.push(
      input.reasoningZeroConflict === true
        ? 'provider reported reasoningTokens=0 while the stream carries reasoning deltas; the reasoning/output split is downgraded'
        : 'provider phase counters contradict the stream\'s phase evidence; the reasoning/output split is downgraded',
    )
  }
  if (tokenTotal === QualityLevel.EXACT && phaseSplit !== QualityLevel.EXACT && input.reasoningStreamConflict !== true) {
    notes.push('generated-token total is authoritative but the reasoning/output split is not reported by the provider')
  }
  if (temporalShape === QualityLevel.RECONSTRUCTED) {
    notes.push('phase integrals are anchored to authoritative totals; the local curve shape remains a delta-shape estimate')
  }

  return {
    tokenTotalQuality: tokenTotal,
    phaseSplitQuality: phaseSplit,
    temporalShapeQuality: temporalShape,
    approximateTokenTotal: tokenTotal !== QualityLevel.EXACT,
    approximatePhaseSplit: phaseSplit !== QualityLevel.EXACT,
    displayTokenTotal: displayMode(tokenTotal),
    displayPhaseSplit: displayMode(phaseSplit),
    notes,
  }
}

function displayMode(level) {
  if (level === QualityLevel.EXACT) return 'exact'
  if (level === QualityLevel.UNAVAILABLE) return 'unavailable'
  return 'approximate'
}

/**
 * Whether a rate or chart value derived from these axes must render with an
 * approximate marker. Live values are always approximate: no per-delta provider
 * count exists, so nothing measured live can be `exact`.
 */
function requiresApproximateMarker(level) {
  return level !== QualityLevel.EXACT && level !== QualityLevel.UNAVAILABLE
}



;Object.assign(__exports, { MetricQuality, QualityLevel, QUALITY_CEILING, QUALITY_AXIS, isQualityLevel, weakestLevel, clampToAxis, tokenTotalQuality, phaseSplitQuality, temporalShapeQuality, qualityAxes, requiresApproximateMarker })
			},
			"src/core/tool-timing.js": function (__exports) {
/**
 * Tool latency: per-call durations plus the two required aggregates.
 *
 * `workMs` is the arithmetic sum of every completed call duration.
 * `wallMs` is the measure of the **union** of the same intervals, so parallel
 * calls are not counted twice. `workMs >= wallMs` always holds, with equality
 * exactly when no two counted calls overlap (docs/METRICS_SPEC.md §5).
 *
 * A call with no result yet is running and contributes to neither total: an open
 * interval has no measurable duration, and treating its "duration so far" as
 * completed latency would double-count when it closes.
 */

/** Merge completed intervals and return their union length in ms. */
function unionDurationMs(intervals) {
  const normalized = intervals
    .filter(x => x && Number.isFinite(x.startMs) && Number.isFinite(x.endMs) && x.endMs >= x.startMs)
    .map(x => ({ startMs: x.startMs, endMs: x.endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  if (!normalized.length) return 0
  let total = 0
  let start = normalized[0].startMs
  let end = normalized[0].endMs
  for (let i = 1; i < normalized.length; i += 1) {
    const next = normalized[i]
    if (next.startMs <= end) {
      end = Math.max(end, next.endMs)
    } else {
      total += end - start
      start = next.startMs
      end = next.endMs
    }
  }
  return total + end - start
}

function isCompleted(call) {
  return call
    && Number.isFinite(call.startMs)
    && Number.isFinite(call.endMs)
    && call.endMs >= call.startMs
}

/**
 * Summarize a turn's tool calls.
 *
 * @param {readonly object[]} calls normalized `ToolCallRecord` values
 */
function summarizeToolCalls(calls) {
  const list = (Array.isArray(calls) ? calls : []).filter(call => call && typeof call === 'object')
  const completed = list.filter(isCompleted)
  const intervals = completed.map(call => ({ startMs: call.startMs, endMs: call.endMs }))
  const running = list.filter(call => !isCompleted(call))
  return {
    /** Every call seen, running or settled. */
    count: list.length,
    /** Calls with a result, i.e. the calls the two durations describe. */
    completedCount: completed.length,
    /** Calls whose result has not arrived. */
    runningCount: running.length,
    /** Sum of completed individual durations. */
    workMs: completed.reduce((sum, call) => sum + call.endMs - call.startMs, 0),
    /** Union of the same intervals; the figure the compact UI shows. */
    wallMs: unionDurationMs(intervals),
    failedCount: list.filter(call => call.status === 'error' || call.status === 'failed').length,
    cancelledCount: list.filter(call => call.status === 'cancelled').length,
    /** Distinct tool names in first-seen order, for the compact `a, b +1` label. */
    names: [...new Set(list.map(call => call && call.name).filter(name => typeof name === 'string' && name.length > 0))],
  }
}

;Object.assign(__exports, { unionDurationMs, summarizeToolCalls })
			},
			"src/core/aggregate-turn.js": function (__exports) {
/**
 * Attempt-level reduction and turn-level aggregation.
 *
 * The statistical unit is the whole **turn**. A turn may contain several model
 * attempts, retries and tool calls, and the completed TPS values are ratios of
 * turn-level sums:
 *
 *   reasoning TPS = sum(reasoning tokens) / sum(reasoning generation time)
 *   output TPS    = sum(non-reasoning output tokens) / sum(output generation time)
 *
 * An arithmetic mean of per-step or per-attempt TPS values is never computed
 * here or anywhere else (docs/METRICS_SPEC.md §1, §7).
 *
 * Provider usage semantics: `reasoningTokens`, when present, is already included
 * in `outputTokens`, so non-reasoning output is `outputTokens - reasoningTokens`.
 * The two counters are never added.
 */

const { MetricQuality, rateQuality, weakestQuality } = __req("src/core/metric-quality.js")
const { QualityLevel, qualityAxes, QUALITY_AXIS, clampToAxis } = __req("src/core/quality-model.js")
const { summarizeToolCalls } = __req("src/core/tool-timing.js")
const { attributePhaseDurations, PHASE } = __req("src/core/phase-duration.js")
const { calibrateAttemptSamples } = __req("src/core/token-allocation.js")
const { TemporalAllocationMode, PhaseEvidenceIssue } = __req("src/core/phase-evidence.js")

/** Mask a usage object into the fields this project reads, or `null` when unusable. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const outputTokens = usage.outputTokens
  if (!Number.isFinite(outputTokens) || outputTokens < 0) return null
  const reasoningTokens = Number.isFinite(usage.reasoningTokens) && usage.reasoningTokens >= 0
    ? usage.reasoningTokens
    : null
  return {
    outputTokens,
    reasoningTokens,
    nonReasoningTokens: reasoningTokens === null ? null : Math.max(0, outputTokens - reasoningTokens),
  }
}

/**
 * Whether an attempt contributes a phase denominator to the turn.
 *
 * An attempt that produced no generated delta contributes nothing measurable and
 * must not appear in a turn, because including it would introduce a zero-length
 * phase and make the aggregate look worse than the evidence supports. An attempt
 * that produced generated deltas does contribute even when it settled without a
 * surface message or its outcome is unknown: its observed generation time really
 * was spent on this turn.
 */
function isContributingAttempt(attempt) {
  return Array.isArray(attempt?.samples) && attempt.samples.length > 0
}

/**
 * Reduce one normalized attempt to its measured facts.
 *
 * @param {object} attempt `{attemptId, turn, step, samples, usage, status}`
 */
function reduceAttempt(attempt) {
  const samples = Array.isArray(attempt?.samples) ? attempt.samples : []
  /**
   * Phase-episode durations (Phase 9.2). The attempt's settlement instant ends its
   * terminal episode, so the final generated-delta → settlement tail is charged to
   * that episode — the MiMo definition — while tool and inter-attempt time is not
   * reachable from this call at all.
   *
   * The attempt's non-magnitude phase cuts travel with the samples (Phase 9.4.3):
   * each one ends the episode in force at its own instant, so the silent stretch
   * between a boundary and the incoming phase's first magnitude sample is charged
   * to **neither** phase. Without them the outgoing phase's denominator absorbed
   * that stretch and the printed rate disagreed with the curve the card draws.
   */
  const durations = attributePhaseDurations(samples, {
    settledAtMs: attempt?.settledAtMs,
    phaseCuts: attempt?.phaseCuts,
  })
  const usage = normalizeUsage(attempt?.usage)
  const calibration = calibrateAttemptSamples(samples, usage ?? undefined)

  const reasoningTokens = calibration.phaseTokens.reasoning
  const outputTokens = calibration.phaseTokens.output
  const totalTokens = calibration.totalTokens
  // With no authoritative usage the phase totals are unknown; the per-phase
  // allocation sum is then the raw shape weight, which is reported as a shape
  // rather than as a token count.
  const shapeReasoning = phaseShapeSum(calibration.samples, 'reasoning')
  const shapeOutput = phaseShapeSum(calibration.samples, 'output')

  return {
    attemptId: attempt?.attemptId ?? null,
    turn: attempt?.turn ?? null,
    step: attempt?.step ?? null,
    /** Settlement type, surface visibility and execution outcome stay separate. */
    settlementKind: attempt?.settlementKind ?? 'none',
    surfaceCommitted: attempt?.surfaceCommitted === true,
    attemptOutcome: attempt?.attemptOutcome ?? 'unknown',
    sampleCount: samples.length,
    /**
     * Whether the stream carries at least one non-empty reasoning delta. This is the
     * stream-side half of the phase-evidence comparison; the provider-side half is
     * `usage.reasoningTokens`. The comparison itself lives in
     * `src/core/phase-evidence.js` and is reported through `phaseEvidence`, so this
     * flag is a fact about the stream rather than a duplicate of a rule.
     */
    hasReasoningStream: samples.some(sample => sample.phase === 'reasoning'),
    reasoningMs: durations.reasoningMs,
    outputMs: durations.outputMs,
    /**
     * How many phase episodes the attempt produced and how many of them were
     * measurable. The denominator is only complete when every episode of the phase
     * contributed a positive duration; a phase with a partial denominator makes the
     * turn's rate optimistic, which `measuredRatio` states rather than hides.
     */
    reasoningEpisodeCount: durations.reasoningEpisodeCount,
    reasoningMeasuredEpisodes: durations.reasoningMeasuredEpisodes,
    outputEpisodeCount: durations.outputEpisodeCount,
    outputMeasuredEpisodes: durations.outputMeasuredEpisodes,
    spanMs: durations.spanMs,
    usage,
    /** Where the usage came from, so a recovered total stays distinguishable. */
    usageSource: attempt?.usageSource ?? (usage === null ? null : 'attempt'),
    /** Whether this attempt's per-delta allocation is anchored to a total. */
    totalAnchored: calibration.totalAnchored,
    /**
     * Which claim the per-delta magnitudes were built from: `phase-anchored` when the
     * provider's phase counters were usable as a temporal allocation, `total-anchored`
     * when only the attempt total was, `unanchored` when neither was. The curve source
     * is measured in the calibrated system at every level, so this is a statement
     * about the *phase* allocation rather than about whether the integral is anchored.
     */
    temporalAllocationMode: calibration.temporalAllocationMode,
    /**
     * The symmetric provider-counter versus stream-evidence diagnosis for this
     * attempt. `calibrateAttemptSamples` owns the rules; the aggregation layer only
     * reports them, so the two cannot disagree.
     */
    phaseEvidence: calibration.evidence,
    calibration,
    reasoningTokens,
    outputTokens,
    totalTokens,
    shapeReasoning,
    shapeOutput,
    /** Anchored to usage but not split exactly. */
    splitQuality: calibration.splitQuality,
  }
}

function phaseShapeSum(samples, phase) {
  let sum = 0
  for (const sample of samples) {
    if (sample.phase === phase) sum += sample.tokens ?? sample.weight ?? 0
  }
  return sum
}

/**
 * Turn-level aggregation.
 *
 * @param {{
 *   turn?: number|null,
 *   sessionId?: string|null,
 *   turnStartMs?: number,
 *   turnEndMs?: number|null,
 *   firstTokenMs?: number|null,
 *   attempts?: readonly object[],
 *   tools?: readonly object[],
 *   status?: 'completed'|'interrupted'|'errored',
 * }} [input]
 */
function aggregateTurn(input = {}) {
  const attempts = Array.isArray(input.attempts) ? input.attempts : []
  const tools = Array.isArray(input.tools) ? input.tools : []
  const status = input.status ?? 'completed'

  const contributing = attempts.filter(isContributingAttempt)
  const reduced = contributing.map(reduceAttempt)
  /** Attempts that never emitted a generated delta: real events, no throughput evidence. */
  const emptyAttemptCount = attempts.length - contributing.length

  const withUsage = reduced.filter(a => a.usage !== null)
  const usageComplete = reduced.length > 0 && withUsage.length === reduced.length
  const splitComplete = usageComplete && withUsage.every(a => a.usage.reasoningTokens !== null)
  /**
   * A split that survived the phase-evidence comparison. It is deliberately narrower
   * than `splitComplete`, which only asks whether every attempt *reported* a counter:
   * a counter the stream contradicts is reported but not usable, and the published
   * per-phase counters must then come from the anchored allocation rather than from a
   * provider division the evidence refutes.
   */
  const splitUsable = splitComplete && withUsage.every(a => a.calibration.evidence?.splitUsable === true)

  /**
   * Consistency between provider aggregate usage and stream phase evidence.
   *
   * The rules are **not** restated here. `calibrateAttemptSamples` already ran
   * `analyzePhaseEvidence` over the same samples and the same counters, and this loop
   * only surfaces its result. The previous revision kept a one-sided guard in this
   * function — `reasoningTokens === 0` beside a reasoning stream — while the opposite
   * direction and the output phase were handled differently inside the calibration
   * layer, which is exactly how the two layers came to disagree about whether an
   * attempt was anchored.
   *
   * The authoritative `outputTokens` total stays trusted throughout: a phase
   * contradiction damages the temporal phase allocation, never the counted total.
   */
  const consistencyIssues = []
  let splitConflict = false
  let reasoningZeroConflict = false
  let phaseMismatchAttempts = 0
  for (const attempt of reduced) {
    const contradictions = attempt.calibration.evidence?.contradictions ?? []
    if (contradictions.length === 0) continue
    splitConflict = true
    phaseMismatchAttempts += 1
    const label = attempt.attemptId ?? attempt.step ?? '?'
    for (const entry of contradictions) {
      if (entry.kind === PhaseEvidenceIssue.REASONING_ZERO_WITH_DELTAS) reasoningZeroConflict = true
      consistencyIssues.push(`attempt ${label}: ${entry.message}`)
    }
  }

  // Authoritative token totals. A missing counter is never silently treated as
  // zero: when coverage is incomplete the turn total is reported as unavailable
  // together with the partial sum that *is* observed, so the UI can show "≈" or
  // "—" honestly instead of under-reporting.
  const observedGeneratedTokens = withUsage.reduce((sum, a) => sum + a.usage.outputTokens, 0)
  const generatedTokens = usageComplete ? observedGeneratedTokens : null
  const observedReasoningTokens = splitComplete
    ? withUsage.reduce((sum, a) => sum + a.usage.reasoningTokens, 0)
    : null
  const observedNonReasoningTokens = splitComplete
    ? withUsage.reduce((sum, a) => sum + a.usage.nonReasoningTokens, 0)
    : null

  // Phase denominators: sums of measured episode time. An attempt whose phase
  // duration is not measurable — no episode of that phase with a positive
  // duration, or a phase whose episodes are only partly measurable — is not a
  // complete denominator contribution and is counted as such, so the rate can be
  // marked optimistic rather than exact.
  const reasoningDurations = reduced.map(a => a.reasoningMs)
  const outputDurations = reduced.map(a => a.outputMs)
  const reasoningMs = reasoningDurations.reduce((sum, ms) => sum + (ms ?? 0), 0)
  const outputMs = outputDurations.reduce((sum, ms) => sum + (ms ?? 0), 0)
  const reasoningMeasured = reduced.filter(a => (
    a.reasoningMs !== null && a.reasoningMs > 0 && a.reasoningMeasuredEpisodes === a.reasoningEpisodeCount
  )).length
  const outputMeasured = reduced.filter(a => (
    a.outputMs !== null && a.outputMs > 0 && a.outputMeasuredEpisodes === a.outputEpisodeCount
  )).length

  /**
   * Per-attempt phase allocations summed across the turn. For an attempt with
   * usage these are calibrated values anchored to the authoritative total, so
   * their sum equals that total exactly; for an attempt without usage they are
   * raw shape weights. They are the *only* per-phase token magnitudes this
   * project has when the provider reports no `reasoningTokens`, and
   * `calibrateAttemptSamples` already rescales them so each attempt's phases sum
   * to that attempt's authoritative total — which is what makes an anchored
   * division of a known total honest, and what makes the unanchored case read as
   * `≈`. Rounding across many attempts can leave the sum a fraction off the
   * total, so the output phase absorbs the residual; the reported pair therefore
   * always adds up to the reported total.
   */
  const allocatedTokens = reduced.reduce(
    (sum, a) => ({
      reasoning: sum.reasoning + (a.reasoningTokens ?? a.shapeReasoning),
      output: sum.output + (a.outputTokens ?? a.shapeOutput),
    }),
    { reasoning: 0, output: 0 },
  )
  const allocatedTotal = allocatedTokens.reasoning + allocatedTokens.output
  /**
   * The residual correction is applied **only** when an authoritative total
   * exists to correct toward. Without one there is nothing to reconcile, and
   * subtracting the allocation from a zero observed sum would manufacture a
   * negative phase magnitude. Attempts that reported no usage contribute their
   * raw shape weight instead, which is why the resulting phase pair is then a
   * shape estimate rather than an anchored division.
   */
  const anchored = observedGeneratedTokens > 0
  const shapeTokens = anchored ? {
    reasoning: allocatedTokens.reasoning,
    output: allocatedTokens.output + (observedGeneratedTokens - allocatedTotal),
  } : allocatedTokens

  /**
   * The per-phase totals the card publishes: the provider counters when the provider
   * reported them *and* the stream did not contradict them, the anchored allocation
   * otherwise. A phase with no evidence at all stays `null` and renders `—`; it is
   * never shown as `0`.
   *
   * `splitUsable` rather than `splitComplete` is the gate because a contradicted split
   * may not be published as a division of the total. The provider's own counters remain
   * available per attempt in `attemptBreakdown[].phaseTokens` and
   * `.phaseEvidence.contradictions`, so the summary fact is retained even where the
   * temporal reading of it is refused (docs/METRICS_SPEC.md §8.3).
   */
  const phaseTokens = splitUsable
    ? { reasoning: observedReasoningTokens, output: observedNonReasoningTokens }
    : {
      /**
       * A phase count is only publishable when it is a real, non-negative number. An
       * impossible provider split (`reasoningTokens > outputTokens`) makes the derived
       * non-reasoning count negative, and a negative "token count" rendered in a card is a
       * worse failure than an em dash. It becomes `null`, which the card already renders as
       * "no evidence", while the contradiction itself is reported in `consistencyIssues`.
       */
      reasoning: publishableCount(shapeTokens.reasoning),
      output: publishableCount(shapeTokens.output),
    }
  /**
   * Whether those per-phase counters are measured, anchored, or absent. A split the
   * stream contradicted is never `exact` here, matching `quality.phaseSplitQuality`.
   */
  const phaseTokensQuality = splitUsable
    ? MetricQuality.EXACT
    : (usageComplete ? MetricQuality.ESTIMATED
      : (withUsage.length > 0 ? MetricQuality.PARTIAL : MetricQuality.UNAVAILABLE))

  // Phase rates divide whatever per-phase magnitude is published by the measured
  // generation time of that phase. A rate whose numerator is not measured is
  // reported at the quality of that numerator, so `≈` follows the number rather
  // than the field name.
  const reasoningTps = phaseTokens.reasoning !== null && phaseTokens.reasoning > 0 && reasoningMs > 0
    ? phaseTokens.reasoning * 1000 / reasoningMs
    : null
  const outputTps = phaseTokens.output !== null && phaseTokens.output > 0 && outputMs > 0
    ? phaseTokens.output * 1000 / outputMs
    : null

  const reasoningTokensReported = reduced.some(a => a.usage !== null && a.usage.reasoningTokens !== null)
  const reasoningQuality = reasoningTps === null
    ? MetricQuality.UNAVAILABLE
    : rateQuality({
      measuredRatio: measuredRatio(reasoningMeasured, reduced.length),
      tokensExact: splitUsable,
      phaseSplitExact: splitUsable,
    })
  const outputQuality = outputTps === null
    ? MetricQuality.UNAVAILABLE
    : rateQuality({
      measuredRatio: measuredRatio(outputMeasured, reduced.length),
      tokensExact: splitUsable,
      phaseSplitExact: splitUsable,
    })

  const ttftMs = Number.isFinite(input.firstTokenMs) && Number.isFinite(input.turnStartMs)
    ? Math.max(0, input.firstTokenMs - input.turnStartMs)
    : null
  const turnElapsedMs = Number.isFinite(input.turnEndMs) && Number.isFinite(input.turnStartMs)
    ? Math.max(0, input.turnEndMs - input.turnStartMs)
    : null

  /**
   * Three-axis quality, replacing the single blended label the scaffold used.
   * A turn whose token total is authoritative but whose reasoning split is not
   * reported must be able to say exactly that, which one label cannot express.
   */
  const quality = qualityAxes({
    contributingAttemptCount: reduced.length,
    attemptsWithUsage: withUsage.length,
    // An attempt whose usage came from an in-stream usage chunk is authoritative
    // too, but it is recorded with a source, so a recovered total is detectable.
    recoveredTotals: reduced.filter(a => a.usage !== null && a.usageSource === 'recovered').length,
    reportedTotals: withUsage.length,
    attemptsWithSplit: withUsage.filter(a => a.usage.reasoningTokens !== null).length,
    splitIsAnchored: splitComplete,
    /**
     * Every contradiction `analyzePhaseEvidence` found, in all four directions plus the
     * impossible split. It gates **only** the phase-split axis: `outputTokens` was counted
     * by the provider and remains exact, which is the independence Phase 7C.2 requires.
     * The name is kept from the Phase 3 guard it generalises, so existing consumers of
     * `quality-model.js` keep working.
     */
    reasoningStreamConflict: splitConflict,
    /**
     * Narrower form, for the note text only: the Phase 3 `reasoningTokens=0` direction
     * specifically. The gate itself is `reasoningStreamConflict`.
     */
    reasoningZeroConflict,
    hasReasoningDeltas: reduced.some(a => a.shapeReasoning > 0),
    hasOutputDeltas: reduced.some(a => a.shapeOutput > 0),
    durable: input.durable === true,
    timestampsComplete: input.timestampsComplete !== false,
    anchored: reduced.length > 0 && reduced.every(a => a.totalAnchored === true),
    /**
     * The count the temporal axis is measured from. Without it `temporalShapeQuality`
     * answers `unavailable` — there is no shape to describe — so omitting it here
     * silently capped the strongest achievable curve quality at `estimated`.
     */
    sampleCount: reduced.reduce((sum, a) => sum + a.sampleCount, 0),
  })

  return {
    turn: input.turn ?? null,
    /**
     * Carried through rather than re-derived: the card states which session's turn
     * it describes, and the aggregation layer is the last place that knows it
     * before the view model is built.
     */
    sessionId: input.sessionId ?? null,
    status,
    turnStartMs: Number.isFinite(input.turnStartMs) ? input.turnStartMs : null,
    turnEndMs: Number.isFinite(input.turnEndMs) ? input.turnEndMs : null,
    ttftMs,
    /** Wall-clock turn duration; includes model waits and tools by design (§10). */
    turnElapsedMs,

    // Four principal columns.
    reasoningTps,
    reasoningTpsQuality: reasoningQuality,
    outputTps,
    outputTpsQuality: outputQuality,
    generatedTokens,
    /** Partial sum over attempts that did report usage; diagnostic, never the headline. */
    observedGeneratedTokens,
    generatedTokensQuality: usageComplete
      ? MetricQuality.EXACT
      : (withUsage.length > 0 ? MetricQuality.ESTIMATED : MetricQuality.UNAVAILABLE),
    reasoningTokens: observedReasoningTokens,
    nonReasoningTokens: observedNonReasoningTokens,
    /**
     * Per-phase token magnitudes actually fit to publish: the provider counters when it
     * reported them and the stream did not contradict them, otherwise the anchored phase
     * allocation of the authoritative total. `null` means "no evidence for this phase",
     * never `0`.
     */
    phaseTokens,
    phaseTokensQuality,
    splitQuality: splitUsable
      ? MetricQuality.EXACT
      : (withUsage.length > 0 ? MetricQuality.ESTIMATED : MetricQuality.UNAVAILABLE),
    /**
     * The temporal allocation mode of the whole turn: the weakest mode among the
     * contributing attempts, because the turn's curve is no better anchored than its
     * weakest attempt. `phase-anchored` means every attempt mapped the provider's phase
     * counters onto observed stream evidence; `total-anchored` means at least one attempt
     * used the common-scale fallback; `unanchored` means no attempt had a provider total.
     *
     * This is deliberately separate from `curveSource().calibrationCoverage`, which
     * answers how many attempts have an authoritative **total**. A `total-anchored`
     * attempt is still fully anchored for coverage purposes; it merely does not claim an
     * exact phase-temporal allocation.
     */
    temporalAllocationMode: weakestTemporalAllocationMode(reduced),
    /**
     * Provider-aggregate versus stream-evidence contradictions detected while
     * aggregating, in every direction and for both phases. Empty means the two evidence
     * sources agreed. The rules live in `phase-evidence.js`; this array only reports them.
     */
    consistencyIssues,
    /** How many contributing attempts carried at least one contradiction. */
    phaseMismatchAttemptCount: phaseMismatchAttempts,

    /**
     * The quality model actually used by display code. `quality.tokenTotalQuality`
     * answers "is the generated-token total trustworthy", `.phaseSplitQuality`
     * answers "is the reasoning/output division trustworthy", and
     * `.temporalShapeQuality` answers "how good is the timing shape".
     */
    quality,

    // Phase denominators, for the secondary lines.
    reasoningMs,
    reasoningMeasuredAttempts: reasoningMeasured,
    outputMs,
    outputMeasuredAttempts: outputMeasured,
    /** Shape-weighted token sums; their phase pair sums to the observed total. */
    shapeTokens,

    // Coverage / diagnostics.
    attemptCount: attempts.length,
    contributingAttemptCount: reduced.length,
    emptyAttemptCount,
    usageAttemptCount: withUsage.length,
    usageComplete,
    splitComplete,
    /**
     * `splitComplete` refined by the phase-evidence comparison: every attempt reported a
     * counter **and** no counter was contradicted by the stream. This is the flag that says
     * whether a per-phase exact temporal allocation was possible; `splitComplete` alone
     * only says the counters arrived.
     */
    splitUsable,
    reasoningTokensReported,
    attemptBreakdown: reduced,

    tools: summarizeToolCalls(tools),
    /**
     * Retained for callers that only want the four frozen levels. It is the
     * weakest of the three axes, so it can never be better than the honest
     * answer; new code should read `quality` instead.
     */
    overallQuality: weakestQuality(
      generatedTokens === null ? MetricQuality.UNAVAILABLE : MetricQuality.EXACT,
      reasoningQuality,
    ),
    /** Reasoning/output phase coverage, for the secondary lines. */
    measuredPhaseShare: {
      reasoning: measuredRatio(reasoningMeasured, reduced.length),
      output: measuredRatio(outputMeasured, reduced.length),
    },
  }
}

function measuredRatio(measured, total) {
  if (total === 0) return 0
  return measured / total
}

/**
 * A phase token count fit to publish: a finite positive number, otherwise `null`.
 *
 * `null` means "no evidence for this phase" and renders as an em dash. A negative value can
 * only arise from an impossible provider split, and publishing it would put `-20` in a token
 * column; a zero is suppressed too, because a phase that produced nothing is already reported
 * as `0` by the provider-counter branch and as `—` by this one.
 */
function publishableCount(value) {
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * The weakest temporal allocation mode across the contributing attempts.
 *
 * Ordered strongest to weakest, because the turn may not claim a stronger allocation than
 * the attempt that could support the least: one attempt whose phase counters contradict the
 * stream is enough to make the *turn's* phase allocation approximate, even though every
 * attempt's integral is still anchored to its own provider total.
 */
function weakestTemporalAllocationMode(reduced) {
  if (reduced.length === 0) return TemporalAllocationMode.UNANCHORED
  const rank = {
    [TemporalAllocationMode.PHASE_ANCHORED]: 2,
    [TemporalAllocationMode.TOTAL_ANCHORED]: 1,
    [TemporalAllocationMode.UNANCHORED]: 0,
  }
  let weakest = TemporalAllocationMode.PHASE_ANCHORED
  for (const attempt of reduced) {
    const mode = attempt.calibration.temporalAllocationMode
    if (!Object.hasOwn(rank, mode)) return TemporalAllocationMode.UNANCHORED
    if (rank[mode] < rank[weakest]) weakest = mode
  }
  return weakest
}



;Object.assign(__exports, { PHASE, normalizeUsage, isContributingAttempt, reduceAttempt, aggregateTurn })
			},
			"src/core/curve-source.js": function (__exports) {
/**
 * Curve source: the ephemeral, calibrated input the completed curve is drawn from.
 *
 * ## Why this module exists
 *
 * Two magnitude systems live in this project and they are not interchangeable:
 *
 *   - the raw **shape weight** `sampleFromChunk` attaches to each streamed delta,
 *     produced by `heuristicTokenWeight` (0.25 per Latin code point, 1 per CJK
 *     one). It is a coarse prior whose only job is to say *where* tokens went;
 *   - the **provider-calibrated** per-delta allocation `calibrateAttemptSamples`
 *     produces once authoritative usage is known, whose integral over an attempt
 *     equals that attempt's `outputTokens` exactly.
 *
 * `aggregateTurn` builds the published metrics — `generatedTokens`, the per-phase
 * token counts, `reasoningTps`, `outputTps` — from the second. The completed curve
 * was built from the first, because `settle()` read `record.attempts` directly.
 * A card could therefore print `Generated Tokens: 900` beside a curve whose whole
 * integrated area was 200. This module removes that possibility by construction:
 * the curve's samples come from `aggregate.attemptBreakdown[].calibration.samples`,
 * which is the one place calibration is performed.
 *
 * ## What the curve source is, and what it is not
 *
 * It is a **join**, not a second calibration. Calibration happens exactly once, in
 * `calibrateAttemptSamples`, and this module reads its output. No scaling,
 * re-weighting or re-derivation of token magnitudes occurs here — a duplicate
 * implementation would be free to drift from the one the printed numbers use,
 * which is the defect this module exists to close.
 *
 * The raw evidence is never mutated. `record.attempts[].samples` stays the
 * provenance: it is what `compressAttempts` reads for timestamps, and what the
 * fallback below returns when no calibration is available to join against.
 *
 * ## The alignment contract
 *
 * `aggregate.attemptBreakdown` is built by `aggregateTurn` from the attempts that
 * contributed evidence, in `record.attempts` order:
 *
 *     record.attempts.filter(isContributingAttempt).map(reduceAttempt)
 *
 * The join is therefore positional and the two lists are the same length. Position
 * alone is not treated as sufficient: wherever both sides publish an `attemptId`
 * and a `step`, they must agree, and a disagreement is reported in `issues` and
 * **degrades the whole join to the raw shape** rather than attaching one attempt's
 * calibration to another. A silent mismatch would be worse than the defect being
 * fixed, because the resulting numbers would look calibrated.
 *
 * ## Fallback
 *
 * The join either happens or it does not. When it does not, `calibrationCoverage` is
 * `fallback`, `calibratedForCurve` is `false`, and the curve carries the raw shape
 * weight under `curveQuality`'s ordinary `estimated` reading.
 *
 * ## Coverage, and why a boolean was not enough
 *
 * The join can succeed while only **part** of the curve is anchored: three contributing
 * attempts, two of which reported usage, produce a curve whose first two stretches are
 * calibrated to provider counters and whose third is still the coarse shape weight. Both
 * magnitudes are legitimate best estimates — per-delta allocation is reconstructed either
 * way, so the peak is `≈` at every coverage level, and dropping the unanchored attempt
 * would remove real generation from the chart — but a curve one third of which is
 * unanchored is not a *calibrated curve*.
 *
 * The previous revision reported `calibratedForCurve: calibratedCount > 0`, so that turn
 * was published as calibrated and every consumer that read the boolean — including
 * `curveViewModel.calibrated` — was told the whole curve was anchored. Coverage is now
 * stated explicitly as `calibrationCoverage`, and `calibratedForCurve` is narrowed to its
 * honest meaning: **full coverage only**.
 */

const { MetricQuality } = __req("src/core/metric-quality.js")
const { isContributingAttempt } = __req("src/core/aggregate-turn.js")

/**
 * How much of the curve an authoritative provider total anchored.
 *
 *   - `full`     — the join is aligned and **every** contributing attempt is anchored;
 *   - `partial`  — the join is aligned and some, but not all, are;
 *   - `none`     — the join is aligned and none are, which is the ordinary
 *                  no-usage turn and is not an error;
 *   - `fallback` — the join could not be trusted, so nothing is calibrated and the
 *                  whole curve is the raw shape weight.
 *
 * `none` and `fallback` are deliberately different: the first says the evidence
 * contains no provider total, the second says the evidence could not be joined. A
 * consumer that treated missing usage as corruption would report a defect where
 * there is only a quality level.
 */
const CalibrationCoverage = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  NONE: 'none',
  FALLBACK: 'fallback',
})

/** Fields on `record.attempts` that are shared with every calibration sample. */
function withCalibratedSamples(attempt, samples, anchored, temporalAllocationMode) {
  return {
    ...attempt,
    /**
     * The attempt's samples replaced by their calibrated allocation. Every other
     * field — `attemptId`, `step`, `turn`, `usage`, `settlementKind`, `startedAtMs`,
     * `settledAtMs`, `settlementSeq` — is carried through untouched, so a curve
     * vertex remains attributable to the same attempt the aggregate reduced.
     */
    samples,
    /**
     * Whether an authoritative provider total anchored these magnitudes. `false`
     * means the samples are the raw shape weights relabelled by the same function,
     * which is arithmetically identical and is what keeps "missing usage stays
     * estimated" true — but it is never reported as a calibration.
     */
    anchored,
    /**
     * The weaker statement of *how* they were anchored, retained per attempt. A
     * `total-anchored` attempt has an authoritative integral but no trustworthy
     * phase-temporal allocation, so a consumer that draws the phase split must be able
     * to tell it apart from a `phase-anchored` one even though both are fully anchored
     * for coverage purposes. Phase 7C.2 requires the coverage axis and the
     * allocation-mode axis to stay separate.
     */
    temporalAllocationMode,
  }
}

/**
 * Normalize one calibration sample for curve consumption.
 *
 * `calibrateAttemptSamples` already writes both `tokens` and `quality`, so this is
 * a shape guarantee rather than a transformation: a caller cannot receive a curve
 * sample whose magnitude field is missing or whose quality is unstated.
 */
function curveSample(sample) {
  return {
    ...sample,
    tokens: Number.isFinite(sample?.tokens) ? sample.tokens : Math.max(0, sample?.weight ?? 0),
    quality: sample?.quality ?? MetricQuality.ESTIMATED,
  }
}

/**
 * Join the stored attempts with their calibrated reductions.
 *
 * @param {readonly object[]} attempts `record.attempts`, in turn order
 * @param {readonly object[]} breakdown `aggregate.attemptBreakdown`, in reduction order
 * @returns {{
 *   attempts: object[],
 *   aligned: boolean,
 *   calibratedForCurve: boolean,
 *   calibrationCoverage: 'full'|'partial'|'none'|'fallback',
 *   contributingCount: number,
 *   calibratedCount: number,
 *   rawFallbackAttemptIds: (string|null)[],
 *   issues: string[],
 * }}
 *   `attempts` is the list `compressAttempts` must be given; it is never shorter
 *   than the raw contributing list, and it carries calibrated magnitudes for every
 *   attempt the join could be trusted for. `calibratedForCurve` is `true` only for
 *   `full` coverage — it is a statement about the whole curve, never about whether
 *   any attempt was calibrated.
 */
function curveSource(attempts, breakdown) {
  const raw = Array.isArray(attempts) ? attempts : []
  const reduced = Array.isArray(breakdown) ? breakdown : []
  const contributing = raw.filter(isContributingAttempt)
  const issues = []

  if (contributing.length !== reduced.length) {
    issues.push(
      `curve source misaligned: ${contributing.length} contributing attempts against `
      + `${reduced.length} reduced attempts`,
    )
  }

  const pairs = Math.min(contributing.length, reduced.length)
  for (let index = 0; index < pairs; index += 1) {
    const attempt = contributing[index]
    const entry = reduced[index]
    const attemptId = attempt?.attemptId ?? null
    const reducedId = entry?.attemptId ?? null
    /**
     * Identity is asserted only where **both** sides publish one. An attempt with no
     * `attemptId` and a reduction with none agree by absence; the earlier revision of
     * this contract would have had to invent a placeholder to compare, which is how a
     * positional join silently becomes a wrong one.
     */
    if (attemptId !== null && reducedId !== null && attemptId !== reducedId) {
      issues.push(
        `curve source misaligned at position ${index}: attempt ${attemptId} reduced as ${reducedId}`,
      )
    }
    const step = attempt?.step ?? null
    const reducedStep = entry?.step ?? null
    if (step !== null && reducedStep !== null && step !== reducedStep) {
      issues.push(
        `curve source misaligned at position ${index}: attempt ${attemptId ?? '?'} has step ${step} `
        + `reduced as step ${reducedStep}`,
      )
    }
    const calibrated = entry?.calibration?.samples
    if (!Array.isArray(calibrated)) {
      issues.push(`curve source misaligned at position ${index}: no calibration samples for attempt ${attemptId ?? '?'}`)
    } else if (calibrated.length !== (attempt?.samples?.length ?? 0)) {
      issues.push(
        `curve source misaligned at position ${index}: attempt ${attemptId ?? '?'} has `
        + `${attempt?.samples?.length ?? 0} samples against ${calibrated.length} calibrated ones`,
      )
    }
  }

  const aligned = issues.length === 0
  if (!aligned) {
    /**
     * The whole join is refused, not repaired per attempt. A partial join would leave
     * the curve measured in two magnitude systems at once with nothing on screen to
     * say which vertex belongs to which — the original defect, applied unevenly.
     */
    return {
      attempts: raw,
      aligned: false,
      calibratedForCurve: false,
      calibrationCoverage: CalibrationCoverage.FALLBACK,
      contributingCount: contributing.length,
      calibratedCount: 0,
      rawFallbackAttemptIds: contributing.map(attempt => attempt?.attemptId ?? null),
      issues,
    }
  }

  /**
   * **Total-anchor coverage, not phase-allocation quality.** The count asks only whether an
   * authoritative provider total anchored the attempt's integral, which is why a
   * `total-anchored` attempt — one whose phase counters contradicted the stream and whose
   * curve therefore used one common scale — counts as covered. Its weaker phase-temporal
   * mode travels on the attempt itself (`temporalAllocationMode`) and on the aggregate
   * (`aggregate.temporalAllocationMode`); it deliberately does not lower this coverage.
   */
  const calibratedCount = reduced.filter(entry => entry?.calibration?.totalAnchored === true).length
  /**
   * The curve's magnitude provenance, stated as coverage rather than as a yes/no.
   *
   * `calibratedForCurve` means "the **whole** curve is anchored", so it requires a
   * non-empty contributing set: zero attempts cover nothing, and `0 === 0` must not
   * be read as completeness.
   */
  const calibrationCoverage = calibratedCount === 0
    ? CalibrationCoverage.NONE
    : (calibratedCount === contributing.length ? CalibrationCoverage.FULL : CalibrationCoverage.PARTIAL)
  const calibratedForCurve = contributing.length > 0
    && calibratedCount === contributing.length

  if (calibratedCount === 0) {
    return {
      attempts: raw,
      aligned: true,
      calibratedForCurve,
      calibrationCoverage,
      contributingCount: contributing.length,
      calibratedCount: 0,
      rawFallbackAttemptIds: [],
      issues,
    }
  }

  const calibrated = contributing.map((attempt, index) => withCalibratedSamples(
    attempt,
    (reduced[index].calibration.samples ?? []).map(curveSample),
    reduced[index].calibration.totalAnchored === true,
    reduced[index].calibration.temporalAllocationMode ?? null,
  ))
  /**
   * Attempts that produced no generated delta are retained, not dropped: an empty
   * attempt contributes no samples and therefore no width, and removing it here
   * would make the curve's attempt list disagree with the turn's own count. The
   * walk is positional because `contributing` is a filter of `raw`, so the two
   * lists have a known, stable correspondence.
   */
  let cursor = 0
  const joined = raw.map((attempt) => {
    if (!isContributingAttempt(attempt)) return attempt
    const next = calibrated[cursor]
    cursor += 1
    return next
  })

  return {
    attempts: joined,
    aligned: true,
    calibratedForCurve,
    calibrationCoverage,
    contributingCount: contributing.length,
    calibratedCount,
    rawFallbackAttemptIds: [],
    issues,
  }
}

;Object.assign(__exports, { CalibrationCoverage, curveSource })
			},
			"src/core/curve.js": function (__exports) {
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

const { MetricQuality } = __req("src/core/metric-quality.js")
const { buildPhaseEpisodes } = __req("src/core/phase-duration.js")
const { RateUnavailable, rateAvailability } = __req("src/core/rate-publication.js")

const DEFAULT_SAMPLE_EVERY_MS = 100

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
const MAX_SERIES_POINTS = 200

/** Largest rendered series the SVG layer is allowed to receive. */
const DEFAULT_MAX_POINTS = 512

/**
 * Largest number of vertices **one chart** may receive across every series, every
 * run and both phases.
 *
 * `DEFAULT_MAX_POINTS` bounds per run, which is not a bound on a chart: a hundred
 * runs of 512 points each would be 51 200 SVG vertices, and the card renders inside
 * a conversation that may hold several of them. This is the budget the settled
 * snapshot actually allocates, and `allocateRunBudgets` is what divides it.
 */
const MAX_RENDER_POINTS_TOTAL = 512

/**
 * Smallest budget that can hold the guaranteed anchors: the first point, the last
 * point and the global maximum are three distinct indices in the worst case.
 * A smaller budget is unsatisfiable rather than merely tight.
 */
const MIN_MAX_POINTS = 3

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
function cumulativePhaseTpsSeries(samples, options = {}) {
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
function capSeriesPoints(series, maxPoints = MAX_SERIES_POINTS) {
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
function attemptTrace(segment, samples, options = {}) {
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
function visualRunsOf(points) {
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
function attemptTraces(segments, samples, options = {}) {
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
function peakTps(...seriesList) {
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
function phaseRuns(traces) {
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
function phaseSpans(traces) {
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
function minimumRunCost(length) {
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
function allocateRunBudgets(runs, totalBudget = MAX_RENDER_POINTS_TOTAL) {
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
function downsampleSeries(series, maxPoints = DEFAULT_MAX_POINTS, options = {}) {
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
function downsampleRun(points, budget) {
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

;Object.assign(__exports, { DEFAULT_SAMPLE_EVERY_MS, MAX_SERIES_POINTS, DEFAULT_MAX_POINTS, MAX_RENDER_POINTS_TOTAL, MIN_MAX_POINTS, cumulativePhaseTpsSeries, capSeriesPoints, attemptTrace, visualRunsOf, attemptTraces, peakTps, phaseRuns, phaseSpans, minimumRunCost, allocateRunBudgets, downsampleSeries, downsampleRun })
			},
			"src/core/types.js": function (__exports) {
/**
 * Normalized domain types.
 *
 * These are this project's own records, deliberately independent of DSH wire
 * shapes so that `src/core` stays testable without a DSH runtime. The adapter
 * layer is responsible for translating verified DSH evidence into them; the
 * evidence locations are recorded in docs/IMPLEMENTATION_LOG.md.
 *
 * @typedef {'reasoning'|'output'} TokenPhase
 * @typedef {'exact'|'calibrated'|'estimated'|'unavailable'} MetricQualityValue
 * @typedef {'completed'|'interrupted'|'errored'} TurnStatus
 *
 * @typedef {Object} DeltaSample
 * @property {number} timeMs Wall-clock event timestamp (DSH `AssistantLiveChunkEvent.time`
 *   or a timestamp reconstructed from an `AssistantStreamRecord` run).
 * @property {TokenPhase} phase Which phase this delta's tokens belong to.
 * @property {number} weight Live token-shape estimate; never a provider count.
 * @property {number} [tokens] Calibrated allocation. Equal to `weight` until calibration.
 * @property {MetricQualityValue} [quality]
 * @property {number} [activeTimeMs] Compressed chart-clock coordinate (set by `compressAttempts`).
 * @property {string} [attemptId] Set by `compressAttempts` so a curve segment is attributable.
 *
 * @typedef {Object} NormalizedUsage
 * @property {number} outputTokens Provider output total, reasoning included.
 * @property {number|null} reasoningTokens `null` when the provider did not report it.
 * @property {number|null} nonReasoningTokens `outputTokens - reasoningTokens`, never a sum.
 *
 * @typedef {Object} AttemptRecord
 * @property {string} attemptId DSH `LlmAttemptId` for one streaming attempt.
 * @property {number} turn
 * @property {number} step
 * @property {DeltaSample[]} samples Generated deltas only.
 * @property {TemporalEvidenceAuthority} temporalEvidenceAuthority Where this
 *   attempt's `samples`/`phaseCuts` came from. See the enum below; it is the
 *   only field the settled temporal-shape gate may read.
 * @property {NormalizedUsage} [usage] From `assistant/message.usage` or an in-stream usage chunk.
 * @property {'message'|'attempt'|'none'} [settlementKind] Concept 1: which durable
 *   surface settled the attempt. `message` = `assistant/message`;
 *   `attempt` = `assistant/attempt` (durable settlement **without** a surface
 *   message — not an abandonment); `none` = no durable settlement observed.
 * @property {boolean} [surfaceCommitted] Concept 3: whether a model-visible
 *   assistant message exists for this attempt.
 * @property {'committed'|'interrupted'|'failed'|'retried'|'cancelled'|'stream-error'|'abandoned'|'unknown'} [attemptOutcome]
 *   Concept 2: the execution outcome. `abandoned` comes only from a transient
 *   `end` frame with `outcome.kind === 'abandoned'` (no durable settlement).
 *   When the durable evidence cannot prove a cause the value is `unknown`.
 * @property {number} [startedAtMs]
 * @property {number} [settledAtMs]
 *
 * @typedef {Object} ToolCallRecord
 * @property {string} callId DSH `ToolCallId`, the `tool/call` -> `tool/result` pair key.
 * @property {string} name
 * @property {number} startMs `tool/call` event time.
 * @property {number} [endMs] `tool/result` event time. Absent while running.
 * @property {'running'|'ok'|'error'|'cancelled'} status
 * @property {string} [parentCallId] When DSH exposes nested calls.
 *
 * @typedef {Object} TurnRecord
 * @property {string} sessionId State is always keyed by session as well as turn:
 *   two sessions can be active at once and must never share a live window.
 * @property {number} turn
 * @property {number} startMs `turn/start` event time.
 * @property {number} [endMs] `turn/end` event time.
 * @property {number} [firstTokenMs] First non-empty reasoning/text/tool-argument delta, turn-wide.
 * @property {TurnStatus} [status]
 * @property {AttemptRecord[]} attempts
 * @property {ToolCallRecord[]} tools
 */

/** Stable key for `(sessionId, turn)` isolation. */
function turnKey(sessionId, turn) {
  return `${String(sessionId)}::${String(turn)}`
}

/**
 * Where one attempt's temporal sample stream actually comes from.
 *
 * Three facts are distinct and none of them implies another:
 *
 *   1. a durable settlement was observed for the attempt (`attempt.settlementSeq`);
 *   2. the settlement's embedded compact stream decoded completely
 *      (`decoded.complete === true`);
 *   3. that complete decode was **adopted** as the attempt's temporal evidence
 *      (its `samples`/`phaseCuts` *are* one decode of it).
 *
 * `settlementSeq` proves only (1). A settlement whose decode lost a record is
 * refused by the reconciliation, so the attempt keeps the transient samples its
 * window happened to see — evidence that is real but partial — and the settled
 * card must not describe that timeline as a reconstruction of the durable
 * stream. This field is the answer to (3), recorded where the decision is made
 * instead of being inferred later from incidental fields.
 *
 * The values are the three reachable states, and the field is never defaulted to
 * the strongest one: an unknown value is treated as `live`, so a construction
 * path that forgets to declare its source can only ever *understate* authority.
 *
 * @typedef {'live'|'durable-incomplete'|'durable-complete'} TemporalEvidenceAuthority
 */
const TEMPORAL_EVIDENCE_AUTHORITY = Object.freeze({
  /**
   * The samples are the transient plane's own observation. This is a real
   * measurement — the live timestamps are the same envelope instants — but the
   * live pane can be re-baselined or lose frames, so it cannot support a
   * `reconstructed` shape claim. A settlement whose decode was refused leaves the
   * attempt here: nothing replaced its samples.
   */
  LIVE: 'live',
  /**
   * The samples are one decode of a durable stream, and that decode is known to
   * be **incomplete** (`decoded.complete !== true`). The attempt's evidence is
   * durable-derived but partial, so it is not authoritative either.
   */
  DURABLE_INCOMPLETE: 'durable-incomplete',
  /**
   * The samples are one **complete, authoritative** decode of the durable
   * stream. This is the only value that may support `temporalShapeQuality:
   * reconstructed` (`docs/METRICS_SPEC.md` §11).
   */
  DURABLE_COMPLETE: 'durable-complete',
})

/**
 * Strength ordering of the three authorities, weakest first.
 *
 * A claim about where evidence came from can be **raised** when better evidence
 * replaces the samples and can never be withdrawn afterwards, because nothing
 * removes a sample once it is recorded. Unknown or absent means `live`.
 */
const TEMPORAL_EVIDENCE_RANK = Object.freeze({
  [TEMPORAL_EVIDENCE_AUTHORITY.LIVE]: 0,
  [TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE]: 1,
  [TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE]: 2,
})

/**
 * Whether one attempt's temporal sample stream is backed by a complete
 * authoritative durable decode.
 *
 * This is the single predicate the settled temporal-shape gate is allowed to
 * use. Anything other than the explicit `durable-complete` value — including a
 * missing field, `null`, an unknown string, or an attempt object built by a
 * path this project does not know about — answers `false`.
 *
 * @param {{temporalEvidenceAuthority?: string}|null|undefined} attempt
 * @returns {boolean}
 */
function hasDurableTemporalAuthority(attempt) {
  return attempt?.temporalEvidenceAuthority === TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE
}



;Object.assign(__exports, { turnKey, TEMPORAL_EVIDENCE_AUTHORITY, TEMPORAL_EVIDENCE_RANK, hasDurableTemporalAuthority })
			},
			"src/host/telemetry-design.js": function (__exports) {
/**
 * Normalized telemetry store.
 *
 * This layer sits between the DSH adapter and the pure metric engine. It knows
 * nothing about DSH Context types and holds no browser resources: the adapter
 * feeds it verified events, and it produces the live snapshot and the settled
 * turn record that the UI consumes.
 *
 * Two invariants it exists to enforce:
 *
 *   1. **Isolation.** All state is keyed by `(sessionId, turn)`. There is no
 *      global "current turn", because two sessions can run at once and a
 *      background turn must never supply another session's numbers.
 *   2. **One formula site.** Durations, calibration and turn aggregation come
 *      from `src/core`; this class only routes facts into them.
 */

const { LiveMeter, LivePhase } = __req("src/core/live-metrics.js")
const { sampleFromChunk, heuristicTokenWeight } = __req("src/core/token-allocation.js")
const { MODEL_PHASE, firstTokenTime, phaseCutsFromChunks, tokenEvidence } = __req("src/core/delta-accounting.js")
const { compressAttempts } = __req("src/core/time-axis.js")
const { curveSource } = __req("src/core/curve-source.js")
const { DEFAULT_SAMPLE_EVERY_MS: CURVE_SAMPLE_EVERY_MS, MAX_RENDER_POINTS_TOTAL, MAX_SERIES_POINTS, MIN_MAX_POINTS, allocateRunBudgets, attemptTraces, downsampleRun, peakTps, phaseRuns, visualRunsOf } = __req("src/core/curve.js")
const { aggregateTurn, isContributingAttempt } = __req("src/core/aggregate-turn.js")
const { QualityLevel, clampToAxis, QUALITY_AXIS } = __req("src/core/quality-model.js")
const { TEMPORAL_EVIDENCE_AUTHORITY, TEMPORAL_EVIDENCE_RANK, hasDurableTemporalAuthority, turnKey } = __req("src/core/types.js")

/** How many settled turns are retained per session, newest first. */
const DEFAULT_HISTORY_LIMIT = 4

/**
 * Quality of the completed curve.
 *
 * A curve is a **temporal shape** claim, so it is governed by the temporal-shape
 * axis and by nothing else. The previous revision derived it from
 * `usageComplete`, which answers a different question: a turn whose provider
 * reported an exact token total but whose delta timestamps were incomplete was
 * labelled `calibrated`, and `calibrated` is a claim about the *shape* that the
 * evidence does not support. Meanwhile a turn with complete, durable, anchored
 * timing and only partially reported usage was labelled `estimated`, which
 * understates what is known.
 *
 * The token and split axes still govern the numbers printed beside the chart, so
 * they travel with the curve in `curve.qualityAxes` rather than being folded into
 * this one label.
 *
 * The ceiling is structural: `temporalShape` can never exceed `reconstructed`,
 * because DSH attaches no token count to a delta and every vertex is therefore a
 * shape weight. That is why the peak keeps its `≈` at every quality level.
 *
 * The argument may be a settled aggregate (which nests the axes under `quality`)
 * or a bare axes object; both are accepted so that a caller holding only the axes
 * cannot accidentally get `unavailable` back.
 */
function curveQuality(aggregate) {
  const axes = aggregate?.quality ?? aggregate
  const level = axes?.temporalShapeQuality
  if (level === undefined) return QualityLevel.UNAVAILABLE
  return clampToAxis(QUALITY_AXIS.TEMPORAL_SHAPE, level)
}

class TurnTelemetryStore {
  /**
   * @param {{estimateTokens?:Function, historyLimit?:number}} [options]
   */
  constructor(options = {}) {
    this.estimateTokens = options.estimateTokens ?? heuristicTokenWeight
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    /**
     * A `windowMs` option and its field were removed in Phase 9.2 with the trailing
     * window itself: the live rate is a phase-cumulative average and the completed
     * curve is sampled at `CURVE_SAMPLE_EVERY_MS`. The only presentation cadence in
     * the project still lives in `src/client/live/cadence.js`, and nothing here
     * schedules anything.
     */
    /** @type {Map<string, object>} keyed by `sessionId::turn` */
    this.turns = new Map()
    /** @type {Map<string, LiveMeter>} one live meter per session, so sessions cannot share a window. */
    this.liveBySession = new Map()
  }

  /**
   * The live meter serving one session. Created on demand: the meter is
   * per-session state, and a session that is not selected still owns its own.
   */
  live(sessionId) {
    let meter = this.liveBySession.get(sessionId)
    if (meter === undefined) {
      meter = new LiveMeter()
      this.liveBySession.set(sessionId, meter)
    }
    return meter
  }

  /**
   * Open a turn. Idempotent: replaying the same durable `turn/start` (reload,
   * reconnect) must not discard samples already observed for it.
   */
  beginTurn({ sessionId, turn, timeMs }) {
    const key = turnKey(sessionId, turn)
    let record = this.turns.get(key)
    if (record === undefined) {
      record = {
        sessionId,
        turn,
        startMs: timeMs,
        endMs: null,
        firstTokenMs: null,
        status: null,
        statusNote: null,
        attempts: [],
        tools: [],
        attemptIndex: new Map(),
        toolIndex: new Map(),
        settled: null,
      }
      this.turns.set(key, record)
    }
    const meter = this.live(sessionId)
    if (meter.turn !== turn) meter.turnStarted({ turn, timeMs })
    return record
  }

  /**
   * Record a turn's start time that was **observed after the record already
   * existed**.
   *
   * The one path that needs this is the mid-turn attach. A page that reloads
   * during a turn sees no `turn/start` in its window and adopts the open turn
   * from transient evidence (`SessionEventFeed.adoptTurn`, marked `recovered`),
   * which opens the record with `startMs: null` so nothing is measured from the
   * reload. If the durable `turn/start` row is later published into this client
   * — a reconnect, or the window sliding back over it — its timestamp is the
   * turn's real start, and `beginTurn` is idempotent and would otherwise keep
   * the record at `null` for the rest of the turn.
   *
   * Two rules make the upgrade safe. It is **one-way**: a node already holding a
   * finite start is left untouched, so re-observing a turn can never withdraw
   * authority or move a measurement that was already reported. And it is
   * **recomputed, not restarted**: `record.firstTokenMs` is the absolute time of
   * the first token-producing delta and is never rewritten here, so TTFT stays
   * `firstToken - turn/start` over the same evidence, and elapsed is the same
   * interval it always was — merely computable now.
   *
   * @returns {boolean} whether anything was upgraded
   */
  turnStartObserved(record, { timeMs }) {
    if (record === null || record === undefined) return false
    if (Number.isFinite(record.startMs) || !Number.isFinite(timeMs)) return false
    record.startMs = timeMs
    this.live(record.sessionId).turnStartObserved({ turn: record.turn, timeMs })
    return true
  }

  /**
   * Begin an attempt. A new `attemptId` is a hard window boundary: it is exactly
   * the signal that the previous call ended, whether it committed, settled
   * without a surface message, or is being retried.
   *
   * ## The temporal-evidence authority of a new attempt
   *
   * A new attempt is opened with `temporalEvidenceAuthority: 'live'` and nothing
   * else: the samples about to arrive are the transient plane's, and this method
   * cannot know whether a durable stream will ever complete them. A caller that
   * already holds the attempt's durable decode — the two reconstruction paths —
   * declares it through the `temporalEvidenceAuthority` option rather than by
   * assigning the field, so the value travels through the same one-way rule
   * every other authority claim uses (`temporalEvidenceObserved`).
   *
   * The default is what makes the gate fail conservative: a path that says
   * nothing about its source produces `live`, which can never satisfy
   * `hasDurableTemporalAuthority`.
   */
  beginAttempt(
    record,
    {
      attemptId,
      step = null,
      startedAtMs = null,
      temporalEvidenceAuthority = null,
    },
  ) {
    let attempt = record.attemptIndex.get(attemptId)
    if (attempt === undefined) {
      attempt = {
        attemptId,
        turn: record.turn,
        step,
        samples: [],
        /**
         * The attempt's **non-magnitude phase boundaries**, in stream order.
         *
         * A name-bearing `tool-call-delta` whose `argumentsDelta` is still empty is
         * DSH's first-token evidence and declares a phase, and it carries no
         * magnitude: `sampleFromChunk` returns `null` for it, so it can never be a
         * sample and must not be turned into one. Until Phase 9.4.3 the boundary
         * existed only in the live meter, and the completed curve — which segments
         * its episodes from `samples` alone — continued the outgoing phase until the
         * new phase's first magnitude sample, drawing a decay across a stretch the
         * live pill had already left.
         *
         * This array is that evidence, kept beside the samples rather than inside
         * them: `{timeMs, phase}` per boundary, appended in arrival order, never
         * deduplicated (a replayed frame is the same duplicate a replayed sample is)
         * and never given a magnitude, a sample count or a `sampleOrder`.
         */
        phaseCuts: [],
        usage: null,
        /** No durable settlement observed yet — an open attempt is not "abandoned". */
        settlementKind: 'none',
        surfaceCommitted: false,
        attemptOutcome: 'unknown',
        startedAtMs,
        settledAtMs: null,
        /**
         * Where the samples above came from. Set by the two durable decode paths
         * when they are the source; `live` otherwise. See
         * `TEMPORAL_EVIDENCE_AUTHORITY` (`src/core/types.js`) for why a durable
         * settlement observed for this attempt does **not** imply this value.
         */
        temporalEvidenceAuthority: TEMPORAL_EVIDENCE_AUTHORITY.LIVE,
      }
      record.attempts.push(attempt)
      record.attemptIndex.set(attemptId, attempt)
    }
    if (temporalEvidenceAuthority !== null) {
      this.temporalEvidenceObserved(attempt, { authority: temporalEvidenceAuthority })
    }
    this.live(record.sessionId).attemptStarted({ attemptId, step, timeMs: startedAtMs })
    return attempt
  }

  /**
   * Record where one attempt's temporal sample stream came from.
   *
   * The rule is **one-way upward**, and the direction is the whole point:
   *
   *   - a proven claim may be raised — a live attempt completed by a durable
   *     reconciliation, or a partial decode superseded by a complete one — because
   *     the samples those claims describe were just replaced by better evidence;
   *   - a proven claim is never withdrawn, because nothing in this store removes a
   *     sample once it is recorded. An incomplete settlement arriving after a
   *     complete one leaves the adopted complete decode exactly where it was, so
   *     the attempt is still backed by it.
   *
   * An unknown, absent or unrecognised authority is ranked as `live`, so a caller
   * cannot promote an attempt past what it can prove, and `hasDurableTemporalAuthority`
   * stays the single gate the settled temporal shape depends on.
   *
   * @param {object} attempt
   * @param {{authority: string}} input
   * @returns {boolean} whether the recorded authority changed
   */
  temporalEvidenceObserved(attempt, { authority }) {
    if (attempt === null || attempt === undefined) return false
    const next = TEMPORAL_EVIDENCE_RANK[authority]
    if (next === undefined) return false
    const current = TEMPORAL_EVIDENCE_RANK[attempt.temporalEvidenceAuthority] ?? 0
    if (next <= current) return false
    attempt.temporalEvidenceAuthority = authority
    return true
  }

  /**
   * Freeze the turn's first-token instant, once.
   *
   * TTFT is `firstToken - turn/start`, and the first token is the first chunk
   * DSH's own predicate accepts (`tokenEvidence().countsAsToken`). The stamp is
   * one-way and additive: a later chunk can never move it forward, and an earlier
   * one can only replace it with an earlier instant — which is what lets a
   * durable reconstruction report the same TTFT a live session froze, whichever
   * order the two planes delivered their evidence in.
   *
   * `firstTokenMs` is deliberately *not* the earliest accepted sample. A
   * name-bearing tool-call delta with an empty argument fragment is the model's
   * first token and contributes no sample at all, so the two sets are not the
   * same, and treating them as one is what left the pill on the first-response
   * stopwatch after the boundary had passed.
   *
   * @returns {boolean} whether the recorded instant changed
   */
  firstTokenObserved(record, { timeMs }) {
    if (record === null || record === undefined) return false
    if (!Number.isFinite(timeMs)) return false
    if (!Number.isFinite(record.firstTokenMs)) {
      record.firstTokenMs = timeMs
      return true
    }
    if (timeMs < record.firstTokenMs) {
      record.firstTokenMs = timeMs
      return true
    }
    return false
  }

  /**
   * Record a non-magnitude **phase cut** on the attempt it happened in.
   *
   * The one chunk shape that reaches here is a name-bearing `tool-call-delta`
   * whose `argumentsDelta` is still empty: DSH's `isTokenDelta` accepts it while
   * `classifyDelta` attributes no argument text to it, so it is the model's first
   * token and not a TPS-shape sample. `tokenEvidence().phase` is the phase the
   * boundary declares, and it is never `null` for a chunk the predicate accepts.
   *
   * Two things this method deliberately does **not** do:
   *
   *   - it does not turn the boundary into a sample. A `{tokens: 0}` entry would
   *     enter the episode's numerator and its sample count, which is exactly the
   *     fabricated evidence the contract forbids;
   *   - it does not decide whether the cut closes anything. That question depends on
   *     the phase in force at the instant, which is the episode walk's answer
   *     (`src/core/phase-duration.js`), read identically by the completed curve and
   *     by the summary so the two cannot disagree. A same-phase boundary is
   *     therefore stored here and closes nothing.
   *
   * @returns {boolean} whether the cut was recorded
   */
  phaseCutObserved(attempt, { timeMs, phase }) {
    if (attempt === null || attempt === undefined) return false
    if (!Number.isFinite(timeMs)) return false
    if (phase !== MODEL_PHASE.REASONING && phase !== MODEL_PHASE.OUTPUT) return false
    if (!Array.isArray(attempt.phaseCuts)) attempt.phaseCuts = []
    attempt.phaseCuts.push({ timeMs, phase })
    return true
  }

  /**
   * Accept one streamed chunk. Non-generated chunks (block, usage, finish) are
   * ignored by `sampleFromChunk`; a `usage` chunk additionally updates the
   * attempt's authoritative usage without becoming a sample.
   *
   * The sample is stamped with the attempt it belongs to **before** it reaches the
   * live meter. The meter's episode is bound to one attempt and rejects a sample
   * naming another one, and that guard is only reachable if the identity travels
   * with the sample: a late frame for an attempt the turn has already moved past
   * therefore cannot enter the newer attempt's cumulative rate, even though the
   * closed attempt still keeps it for the completed curve.
   *
   * ## A chunk can be token evidence without being a sample
   *
   * DSH's `isTokenDelta` accepts a name-bearing `tool-call-delta` whose
   * `argumentsDelta` is empty, while `classifyDelta` attributes no argument text
   * to it and `sampleFromChunk` therefore returns `null`. The TTFT boundary and
   * the TPS-shape sample set are two different questions, and this method answers
   * both: the boundary freezes the turn's first token and moves the live meter out
   * of its first-response stage, and no magnitude is fabricated to make the sample
   * set look complete.
   *
   * ## This method never claims a temporal authority
   *
   * A transient sample cannot make a stream durable, so nothing here raises
   * `attempt.temporalEvidenceAuthority`; and nothing here lowers it either. The
   * field describes the stream the reconciliation adopted (or the live
   * observation standing in its place), which is a fact about *which decode is the
   * attempt's timeline* rather than about the arrival order of frames. The
   * reconcile path owns raising it, and `temporalEvidenceObserved` owns the rule.
   *
   * @returns {object|null} the accepted sample, or `null`
   */
  acceptChunk(record, attempt, { timeMs, chunk }) {
    if (chunk && chunk.type === 'usage' && chunk.usage) {
      attempt.usage = chunk.usage
      /**
       * An in-stream `usage` chunk is not a generated sample, but it is evidence
       * the live estimator may use: the phase-cumulative numerator prefers an
       * authoritative provider counter over the shape weight for the episodes
       * that begin after the counter is known (`docs/METRICS_SPEC.md` §6).
       */
      this.live(record.sessionId).observeUsage({ attemptId: attempt.attemptId ?? null, usage: chunk.usage })
      return null
    }
    if (!Number.isFinite(timeMs)) return null
    const sample = sampleFromChunk(timeMs, chunk, this.estimateTokens)
    if (sample === null) {
      /**
       * No usable TPS-shape magnitude. That is not the same as "not model
       * output": the DSH first-token predicate may still accept the chunk, and
       * when it does, this is the turn's TTFT boundary.
       */
      const evidence = tokenEvidence(chunk)
      if (!evidence.countsAsToken) return null
      this.firstTokenObserved(record, { timeMs })
      /**
       * The boundary is also a **phase statement**, and Phase 9.4.3 records it as
       * one. It is not converted into a sample — that would fabricate a magnitude
       * and a sample count — and it is not discarded — that would leave the
       * completed curve bridging an episode the live meter had already closed. It
       * is stored as its own fact, on the attempt it belongs to, on the same clock
       * the samples carry.
       *
       * The predicate is the one `phaseCutOf` states for a decoded chunk: token
       * evidence the sample builder could not turn into a magnitude. The two forms
       * exist because this plane delivers one chunk at a time while a durable
       * settlement delivers a whole decoded stream, and both must publish the same
       * cut or a reloaded card would disagree with the live one.
       */
      if (!evidence.contributesMagnitude) {
        this.phaseCutObserved(attempt, { timeMs, phase: evidence.phase })
      }
      this.live(record.sessionId).observeTokenBoundary({
        attemptId: attempt.attemptId ?? null,
        timeMs,
        phase: evidence.phase,
      })
      return null
    }
    this.firstTokenObserved(record, { timeMs })
    const stamped = { ...sample, attemptId: attempt.attemptId ?? null }
    attempt.samples.push(stamped)
    this.live(record.sessionId).acceptSample(stamped)
    return stamped
  }

  /**
   * Reconcile one already-existing attempt with the authoritative stream its
   * durable settlement carries (Phase 9.4.4).
   *
   * ## The mixed plane this exists for
   *
   * A reload produces one attempt whose evidence arrives on **both** planes: the
   * replacement window holds only the transient tail it could still see, and the
   * settlement that closes the attempt holds the complete compact stream. The
   * transient rows are real evidence and the durable decode is the authoritative
   * one, and the completed record has to end up with the second without losing
   * the identity the first established.
   *
   * ## Why replacement, and not a union or a dedupe
   *
   * The two planes share **no per-delta identity**. A transient row carries
   * `(attemptId, index, revision)` from the client fold; a decoded durable delta
   * carries `(recordIndex, memberIndex)` from the compact record array. Nothing
   * joins them, so a union would double-count every overlapped delta — and a
   * dedupe keyed on `timeMs + text` would collapse two genuinely distinct
   * same-timestamp deltas into one, silently reordering what survived. Both
   * failure modes corrupt the one thing this project measures.
   *
   * Replacement has none of them, and it is what the semantic requirement
   * actually states: after settlement the attempt's stream-derived evidence *is*
   * one decode of the durable stream. It is idempotent (reconciling twice is
   * reconciling once), it cannot duplicate a cut, and it cannot reorder a
   * same-timestamp pair, because `decodeAssistantStream` already preserves
   * logical stream order exactly.
   *
   * ## What is replaced, and what is deliberately not
   *
   * Replaced — the fields derived from the stream, and only those:
   *
   *   - `attempt.samples`, rebuilt with `sampleFromChunk` over `decoded.chunks`
   *     and stamped with the attempt's own `attemptId`, exactly as
   *     `acceptChunk` stamps them;
   *   - `attempt.phaseCuts`, rebuilt with `phaseCutsFromChunks` over the same
   *     decode, so the completed curve closes the episode the live pill closed.
   *
   * Not replaced:
   *
   *   - `attempt.attemptId`, `step`, `startedAtMs` and every settlement field —
   *     process-local identity and lifecycle belong to the attempt the
   *     correlation proved, which is exactly why this method mutates in place
   *     rather than returning a restored record;
   *   - `attempt.usage` / `usageSource` — the settlement's own carrier and the
   *     in-stream `usage` chunk keep their existing precedence
   *     (`settleAttempt` / `setAttemptUsage` own that policy), and neither is
   *     recomputed from the decode here;
   *   - `chunks`, `decoded`, `streamQuality` and `issues`. A record built by the
   *     live path does not represent them, and this method's job is to complete
   *     that record, not to convert it into a durable-restored one. Nothing in
   *     the metric pipeline reads them either (`src/core`, `src/client/completed`).
   *
   * The turn's first-token fact is upgraded through `firstTokenObserved`, which
   * is the **one-way** rule: an earlier authoritative boundary may replace a later
   * one and a later one may not move it forward. A reload after the true first
   * token therefore has its TTFT boundary restored without the record ever being
   * able to regress.
   *
   * ## The live meter is not replayed
   *
   * Nothing here touches `LiveMeter`. Feeding the historical stream back through
   * `acceptSample` / `observeTokenBoundary` would re-open episodes the live pill
   * had already left, reset a frozen TTFT and restart a settled attempt — the
   * historical *presentation* is a fact about what the session showed, and this
   * method edits only the record the completed card is built from. The turn's own
   * terminal boundary clears the meter in any case.
   *
   * ## Only a complete decode is authoritative
   *
   * `decoded.complete` is `false` as soon as one record failed to decode. Such a
   * stream is missing evidence the transient plane may still hold, so replacing
   * with it would *lose* data rather than complete it. The method refuses and
   * reports why; the caller keeps the transient evidence and counts the refusal
   * as `settlementStreamsRejected` — a *proven correlation whose decode was
   * refused*, which is a different fact from an unprovable correlation.
   *
   * A refusal writes **nothing**, and that includes the attempt's
   * `temporalEvidenceAuthority`: the samples were not replaced, so where they came
   * from did not change. A correlated settlement that is refused therefore leaves
   * the attempt `live`, and the settled card reports an `estimated` temporal shape
   * rather than a `reconstructed` one — `settlementSeq` records that the durable
   * settlement happened, not that its stream became the attempt's timeline.
   *
   * @param {object} record the turn record that owns `attempt`
   * @param {object} attempt the attempt the settlement was correlated to
   * @param {{decoded?: object|null}} input the settlement's decoded compact stream
   * @returns {{reconciled:boolean, reason:string, samples:number, cuts:number, firstTokenMs:number|null}}
   */
  reconcileAttemptStream(record, attempt, { decoded = null } = {}) {
    const refusal = reason => ({ reconciled: false, reason, samples: 0, cuts: 0, firstTokenMs: null })
    if (attempt === null || attempt === undefined) return refusal('no-attempt')
    if (decoded === null || typeof decoded !== 'object') return refusal('no-decode')
    if (!Array.isArray(decoded.chunks)) return refusal('no-decode')
    if (decoded.complete !== true) return refusal('incomplete-decode')

    const chunks = decoded.chunks
    const attemptId = attempt.attemptId ?? null
    const samples = []
    for (const entry of chunks) {
      const sample = sampleFromChunk(entry.timeMs, entry.chunk, this.estimateTokens)
      if (sample !== null) samples.push({ ...sample, attemptId })
    }
    attempt.samples = samples
    attempt.phaseCuts = phaseCutsFromChunks(chunks)
    /**
     * The attempt's stream-derived evidence *is* one decode of the durable stream
     * now, and that decode is complete. This is the fact a finite `settlementSeq`
     * cannot express: observing the settlement is not adopting its stream, and only
     * the adopted stream supports `temporalShapeQuality: reconstructed`.
     */
    this.temporalEvidenceObserved(attempt, { authority: TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE })

    const firstTokenMs = Number.isFinite(decoded.firstTokenTimeMs)
      ? decoded.firstTokenTimeMs
      : firstTokenTime(chunks)
    if (record !== null && record !== undefined) this.firstTokenObserved(record, { timeMs: firstTokenMs })

    return { reconciled: true, reason: 'replaced', samples: samples.length, cuts: attempt.phaseCuts.length, firstTokenMs }
  }

  /** Attach authoritative usage from a durable settlement. */
  setAttemptUsage(attempt, usage, source = 'assistant-settlement') {
    if (!usage) return
    attempt.usage = usage
    /**
     * Which carrier the counter came from. Two carriers exist — the settlement
     * and an in-stream `usage` chunk — and only one of them may be used, so the
     * provenance is kept rather than inferred later.
     */
    attempt.usageSource = source
  }

  /**
   * Record an attempt settlement.
   *
   * The three concepts travel separately and are never collapsed into one
   * `status` string: `settlementKind` is which durable surface settled the
   * attempt (`message`/`attempt`/`none`), `surfaceCommitted` says whether a
   * model-visible message exists, and `attemptOutcome` is the execution
   * outcome (`committed`/`interrupted`/`abandoned`/`retried`/`unknown`/…).
   * Defaults describe "durable non-surface settlement of unknown cause" only
   * when the caller passes `settlementKind: 'attempt'` explicitly; otherwise
   * the message-settlement defaults apply.
   *
   * This method records settlement **identity and lifecycle** and nothing else. It
   * deliberately never writes `attempt.temporalEvidenceAuthority`: a finite
   * `settlementSeq` proves the durable settlement was observed, and observing a
   * settlement is a different fact from adopting its embedded stream as the
   * attempt's timeline. A settlement whose decode was refused leaves the attempt
   * `live`.
   */
  settleAttempt(
    attempt,
    {
      settledAtMs = null,
      settlementKind = 'message',
      surfaceCommitted = settlementKind === 'message',
      attemptOutcome = 'unknown',
      usage = null,
      usageSource = null,
      settlementSeq = null,
    } = {},
  ) {
    attempt.settledAtMs = settledAtMs
    attempt.settlementKind = settlementKind
    attempt.surfaceCommitted = surfaceCommitted === true
    attempt.attemptOutcome = attemptOutcome
    if (usage) {
      attempt.usage = usage
      if (usageSource !== null) attempt.usageSource = usageSource
    }
    /**
     * The durable sequence of the settlement that closed this attempt. Absence
     * is meaningful: an attempt still open when the turn closes has no settled
     * durable stream, so the turn's temporal shape can only be `estimated`.
     */
    if (Number.isFinite(settlementSeq)) attempt.settlementSeq = settlementSeq
  }

  toolStarted(record, { callId, name, timeMs }) {
    if (record.toolIndex.has(callId)) return record.toolIndex.get(callId)
    const call = { callId, name, startMs: timeMs, endMs: null, status: 'running' }
    record.tools.push(call)
    record.toolIndex.set(callId, call)
    this.live(record.sessionId).toolStarted({ callId, name, timeMs })
    return call
  }

  /** Pair a result with its call. An unpaired result is dropped rather than guessed. */
  toolSettled(record, { callId, timeMs, status = 'ok' }) {
    const call = record.toolIndex.get(callId)
    if (call === undefined) return null
    call.endMs = timeMs
    call.status = status
    this.live(record.sessionId).toolSettled({ callId, timeMs, status })
    return call
  }

  /**
   * Close the turn and compute the settled view. `status` comes from the verified
   * `turn/end.reason` mapping in `src/core/turn-state.js`.
   */
  endTurn(record, { timeMs, status = 'completed', statusNote = null, reason = undefined } = {}) {
    record.endMs = timeMs
    record.status = status
    record.statusNote = statusNote
    if (reason !== undefined) record.reason = reason
    this.live(record.sessionId).turnSettled({ timeMs, status })
    record.settled = this.settle(record)
    this.pruneHistory(record.sessionId)
    return record.settled
  }

  /** Compute the settled snapshot for one turn. Pure over the stored records. */
  settle(record) {
    /**
     * Whether the delta timing in hand is durable evidence rather than live
     * observation, and therefore whether the settled temporal shape may read
     * `reconstructed`.
     *
     * ## What this gate means, and what it used to mean
     *
     * It asks one question — is every contributing attempt's temporal sample
     * stream backed by a **complete authoritative durable decode** — and it reads
     * the answer from `temporalEvidenceAuthority`, the field written where the
     * decision is made. It is not a settlement-lifecycle question and must not be
     * inferred from one: a finite `settlementSeq` proves the durable settlement was
     * observed, and a refusal to adopt an incomplete decode leaves the attempt's
     * samples on the transient plane.
     *
     * Until Phase 9.4.5 this gate was `every(attempt => Number.isFinite(attempt.settlementSeq))`,
     * and the two are not the same statement. Measured on `5ef2f0d` for a reload
     * whose replacement window held only the post-cut tail while the correlated
     * settlement carried an incomplete decode and an authoritative usage counter:
     * the reconciliation refused, the attempt kept its three transient samples, and
     * the settled card still reported `temporalShapeQuality: reconstructed` for a
     * shape drawn from a window that had lost half the attempt.
     *
     * `durableShape` constrains the **temporal** axis only. `settlementSeq`,
     * `settlementKind`, `surfaceCommitted` and `attemptOutcome` keep their own
     * meanings and are never derived from this gate, and the token and split axes
     * stay independent of it: authoritative usage is still `exact` when the
     * temporal shape is only `estimated`.
     *
     * The population is the **contributing** attempts (`isContributingAttempt`,
     * the same predicate `aggregateTurn` reduces with): an attempt that emitted no
     * generated sample contributes no vertex to the shape, so it can neither
     * support nor degrade it. An empty population cannot claim a durable shape,
     * which is why the length guard is stated rather than left vacuous.
     */
    const contributing = record.attempts.filter(isContributingAttempt)
    const durableShape = contributing.length > 0
      && contributing.every(attempt => hasDurableTemporalAuthority(attempt))
    const timestampsComplete = record.attempts.every(attempt => (
      (attempt.samples ?? []).every(sample => Number.isFinite(sample.timeMs))
    ))

    const aggregate = aggregateTurn({
      turn: record.turn,
      sessionId: record.sessionId,
      turnStartMs: record.startMs,
      turnEndMs: record.endMs,
      firstTokenMs: record.firstTokenMs,
      attempts: record.attempts,
      tools: record.tools,
      status: record.status ?? 'completed',
      durable: durableShape,
      timestampsComplete,
    })

    /**
     * The ephemeral curve input: the stored attempts joined with the calibrated
     * per-delta allocation `aggregateTurn` has already computed. The raw evidence is
     * not touched — `record.attempts[].samples` remains the provenance — and no
     * second calibration algorithm lives here, because a duplicate would be free to
     * drift from the one the printed token totals use
     * (`src/core/curve-source.js`).
     */
    const source = curveSource(record.attempts, aggregate.attemptBreakdown)
    const calibratedIds = new Set(
      source.attempts
        .filter(attempt => attempt?.anchored === true)
        .map(attempt => attempt.attemptId ?? null),
    )
    /**
     * Each attempt's calibrated allocation mode, carried beside its samples.
     * `phase-anchored` means the provider's own phase split mapped onto the
     * observed stream; `total-anchored` means only the attempt's integral is
     * anchored. The distinction is not recoverable from a sample, so it travels
     * as a separate fact and is published on the peak's debug provenance.
     */
    const allocationModes = new Map()
    for (const attempt of source.attempts) {
      allocationModes.set(attempt?.attemptId ?? null, attempt?.temporalAllocationMode ?? null)
    }

    // The curve is built from the same compressed clock the live meter used, so
    // a point read off it means the same thing the pill showed at that instant.
    // The attempt's non-magnitude phase cuts are mapped onto that clock with the
    // samples, so a boundary the live half closed an episode at is a coordinate the
    // completed half can close it at too (`src/core/time-axis.js`).
    const compressed = compressAttempts(source.attempts)

    /**
     * The published series is one **attempt-local phase-cumulative trace** per model
     * attempt. This ordering is the specification.
     *
     * The compressed clock concatenates attempts so a tool gap has no width, but a
     * phase episode's clock is a property of one model call. Measuring across the
     * concatenated list would credit the opening vertices of attempt B with attempt
     * A's tokens — the two numbers are drawn a single pixel apart and describe
     * different calls, which is precisely the case a reader cannot detect by looking
     * at the chart. `attemptTraces` measures each attempt on its own clock;
     * `test/curve-attempt-boundary.test.js` carries the counterexample that the
     * previous implementation fails.
     *
     * Within one attempt the trace is **one measurement per phase episode**: every
     * generated sample counts toward the episode in force, whatever its phase, which
     * is what `LiveMeter` measures. Reasoning and output own their own episode clocks
     * and are carried on each vertex as `activePhase`; a phase transition therefore
     * resets the magnitude rather than producing two partial rates of one window.
     */
    const traces = attemptTraces(compressed.segments, compressed.samples, {
      sampleEveryMs: CURVE_SAMPLE_EVERY_MS,
      maxPoints: MAX_SERIES_POINTS,
      calibratedAttemptIds: calibratedIds,
      temporalAllocationModeByAttemptId: allocationModes,
      cuts: compressed.cuts,
    })

    /**
     * The vertex set of each attempt, as flat index ranges rather than copies. The
     * allocation below needs the length of every visual run and the renderer needs
     * its slice; neither needs a duplicated array per run, and a slice keeps the
     * shared phase-transition vertex the **same object** in both runs that meet on
     * it, which is what makes the tone change a seam rather than a fabricated
     * duplicate measurement.
     */
    const drawables = []
    for (const trace of traces) {
      for (const run of trace.visualRuns) {
        drawables.push({
          attemptId: trace.attemptId,
          phase: run.phase,
          /** Explicit length, because this run is a range and not its own array. */
          length: run.pointCount,
          points: trace.points.slice(run.startIndex, run.endIndex + 1),
          trace,
        })
      }
    }

    /**
     * The chart-wide point budget, allocated **before** any downsampling runs.
     *
     * `downsampleSeries` bounds one run, and one run is not a chart: a turn that
     * alternates reasoning and output a hundred times produced a hundred runs of up
     * to `DEFAULT_MAX_POINTS` vertices each, so the SVG's element count followed the
     * model's delivery pattern. Every phase is budgeted together because they are
     * drawn into one plot area and share one axis.
     *
     * The allocation is computed over the run list and then applied per run. The
     * attempts are never flattened, downsampled as one series and cut back apart: the
     * cut points would not fall on run boundaries, and a single bridged polyline
     * across a stretch where the model produced nothing is exactly the defect the
     * per-attempt structure exists to prevent.
     *
     * `peakTps` below still reads the **published** series — the attempt traces after
     * the MiMo-style 200-point cap, not after this budget — and `downsampleRun`
     * independently guarantees the maximum survives into whatever budget it is
     * given, so the render budget can thin the drawing but never move a reported
     * number.
     */
    const allocation = allocateRunBudgets(drawables, MAX_RENDER_POINTS_TOTAL)
    let cursor = 0
    const budgetedTraces = traces.map((trace) => {
      const runs = trace.visualRuns.map((run) => {
        const allowance = allocation.budgets[cursor] ?? run.pointCount
        const refused = allocation.degraded.includes(cursor)
        cursor += 1
        const full = trace.points.slice(run.startIndex, run.endIndex + 1)
        /**
         * Two cases bypass downsampling and keep their measured vertices: a refused
         * run keeps none, and a run of one or two vertices is already at full
         * resolution. The second matters because `downsampleSeries` refuses a budget
         * below `MIN_MAX_POINTS` by design — it cannot honour the three anchors — and
         * a run that already has fewer vertices than that has nothing to thin. Such a
         * run is a **singleton measurement**, drawn as a point marker rather than as
         * a line (`src/client/completed/curve-view-model.js`), which is why carrying
         * it through is not the same as inventing a second vertex to draw a segment
         * with.
         *
         * `downsampleRun` is what protects a phase transition: adjacent runs share
         * their boundary vertex, and thinning each run independently would be free to
         * drop exactly that shared vertex, reopening as a blank horizontal gap a tone
         * change that is not a stall.
         */
        const measured = full.length < MIN_MAX_POINTS
        const points = refused
          ? []
          /**
           * A run that fits keeps the trace's **own** vertex objects rather than copies. Two
           * reasons, and the second is the load-bearing one: the renderer only ever reads
           * them, so copying buys nothing; and the runs of one attempt meet on a shared
           * boundary vertex, so a copy per run would quietly turn one measurement drawn twice
           * into two objects that merely happen to agree. Identity is what lets a test — and a
           * future diagnostic — say "these two subpaths meet *here*" rather than "they end and
           * start at the same coordinate".
           */
          : (measured ? full : downsampleRun(full, allowance))
        return {
          attemptId: trace.attemptId,
          phase: run.phase,
          startIndex: run.startIndex,
          endIndex: run.endIndex,
          startMs: points.length > 0 ? points[0].timeMs : trace.startMs,
          endMs: points.length > 0 ? points[points.length - 1].timeMs : trace.startMs,
          pointCount: run.pointCount,
          points,
          peak: peakTps(points),
          degraded: refused,
          /**
           * `false` when the run is drawn under a reduced allowance. A caller that
           * wants to annotate a thinned run can read it; nothing renders it.
           */
          fullResolution: !refused && allowance >= run.pointCount,
        }
      })
      return {
        attemptId: trace.attemptId,
        startMs: trace.startMs,
        endMs: trace.endMs,
        localEndMs: trace.localEndMs,
        durationMs: trace.durationMs,
        sampleCount: trace.sampleCount,
        /**
         * The sum this attempt's curve samples carry. With calibration it equals the
         * attempt's authoritative `outputTokens`, which is what makes the printed
         * generated-token total and the curve the same magnitude system.
         */
        tokens: trace.tokens,
        calibratedTokens: trace.calibratedTokens,
        calibrated: trace.calibrated,
        /**
         * The **unbudgeted** published trace — the capped MiMo-style series the peak
         * is measured on. The renderer must use `runs`.
         */
        points: trace.points,
        /**
         * The attempt's own winning measurement, with the episode facts that
         * produced it. Debug-only; see `curve.peakProvenance` below.
         */
        peakProvenance: trace.peakProvenance,
        /**
         * The attempt's own curve-source samples, on its attempt-local clock, exactly
         * as the phase-cumulative estimator read them. They are the bridge between a
         * printed token total and a drawn vertex, which is why they are published
         * rather than left to be reassembled from the runs.
         */
        samples: trace.samples,
        /**
         * The attempt's non-magnitude phase boundaries, on the same clock as
         * `samples`. A gap in the drawn runs is one of these and the reason for it;
         * publishing the evidence is what lets a reader, a test or a diagnostic say
         * which boundary produced the hole instead of inferring it from geometry.
         */
        cuts: trace.cuts,
        /** The attempt's budgeted phase-coloured subruns, in ascending time order. */
        runs,
      }
    })

    /**
     * The per-phase view of the same runs, in the fixed legend order.
     *
     * It is a **view**, not a second measurement: every entry is one of the budgeted
     * visual runs of an attempt trace, so the legend, the peak and the drawn geometry
     * can never describe different series. A phase with no run is absent rather than
     * flat, because "never reasoned here" and "reasoning throughput fell to zero" are
     * different facts.
     */
    const series = ['reasoning', 'output'].map((key) => {
      const runs = []
      for (const attempt of budgetedTraces) {
        for (const run of attempt.runs) if (run.phase === key) runs.push(run)
      }
      return {
        key,
        tone: key === 'output' ? 'accent' : 'neutral',
        phase: key,
        present: runs.some(run => run.points.length >= 2),
        runs,
        /**
         * The phase's strongest **publishable** vertex, or `null` when the phase
         * produced no measurement that passed the shared publication policy. It is
         * read from the points rather than from `run.peak` so a phase whose runs
         * are all below the gates reports `null` instead of a fabricated zero.
         */
        peak: peakTps(...runs.map(run => run.points)),
      }
    })

    /**
     * The same allocation, counted the way the chart is drawn. `lineVertices` is the
     * number of path vertices the SVG will receive — runs of two or more **measured**
     * points — and `markers` is the number of one-vertex runs, each of which becomes a
     * point marker rather than a vertex of a line. Their sum is what
     * `MAX_RENDER_POINTS_TOTAL` bounds; see `renderBudget` below for why the two are
     * never published as one number called `drawnPoints`.
     *
     * A phase-transition vertex is charged **once**, to both of the runs that share it,
     * because it is drawn as the endpoint of both subpaths. That is why the sum below
     * is the honest count of emitted vertices and why the seam can never push the
     * chart past its own bound.
     *
     * ## Withheld vertices are spent from the allocation, not drawn
     *
     * The allocator charges a run for **every** vertex it holds, which is the right unit
     * for a budget: a vertex the publication policy later withholds still cost the run
     * its seat. What the chart *emits* is a different set, and this accounting exists to
     * state the emitted one, because it is the number `curveViewModel.renderElementPoints`
     * reports and the one a reader is checking against the bound.
     *
     * Since Phase 9.4 a withheld vertex carries `tps: null` instead of a fabricated `0`
     * (`src/core/rate-publication.js`), and no path is drawn through it. On a dense
     * fixture that is not a rounding difference: a three-delta attempt on a 250 ms grid
     * is allocated four vertices and measures two, so counting allocations would report
     * twice the elements the SVG receives and make the two published numbers disagree by
     * exactly the number of withheld vertices. Filtering here keeps the pair equal, which
     * is the property the budget tests assert, and keeps `elementPoints <= allocated <=
     * total` true in the only direction that matters.
     */
    const isMeasuredPoint = point => Number.isFinite(point?.tps)
    let lineVertices = 0
    let markers = 0
    for (const entry of series) {
      for (const run of entry.runs) {
        const points = Array.isArray(run.points) ? run.points : []
        const measured = points.filter(isMeasuredPoint).length
        if (measured >= 2) lineVertices += measured
        else if (points.length === 1) markers += 1
      }
    }

    /**
     * Runs the allocator had to refuse outright, because even the three anchors that
     * `downsampleSeries` guarantees could not fit inside the chart budget. This is
     * the documented degradation: a refused run is **not drawn at all** rather than
     * drawn truncated, and the count is published so the condition is inspectable
     * instead of silent.
     */
    const degradedRuns = allocation.degraded.length

    /**
     * `peakTps` is measured on the **full** series, before downsampling. The order of
     * the two expressions in `curve` below is the specification, not an accident: the
     * rendered point count is a drawing budget, and a drawing budget must never move a
     * reported statistic. `downsampleRun` independently guarantees that the point
     * bearing this maximum survives into the rendered series, so the drawn curve and
     * the printed peak agree.
     *
     * The peak is the maximum over every attempt's total trace. It is never a sum and
     * never an average across attempts: the turn's peak rate is the fastest any single
     * call ran, not a quantity assembled from two calls.
     *
     * `renderBudget` publishes the allocation itself, so a test or a diagnostic can
     * assert the chart-wide bound without re-deriving it from the point counts.
     */
    return {
      ...aggregate,
      statusNote: record.statusNote,
      curve: {
        durationMs: compressed.durationMs,
        segments: compressed.segments,
        /**
         * The curve's own magnitude provenance. `aligned: false` means the join
         * between the stored attempts and their calibrated reductions could not be
         * trusted, and the whole curve fell back to the raw shape weight rather than
         * attaching one attempt's calibration to another
         * (`src/core/curve-source.js`).
         *
         * `calibrated` means **the whole curve** is anchored, and `calibrationCoverage`
         * states that explicitly as `full` / `partial` / `none` / `fallback`. A turn
         * whose attempts reported usage unevenly is `partial`: some stretches are
         * anchored to a provider counter and some are still the coarse shape weight,
         * which is a legitimate best estimate and an inaccurate thing to call
         * "calibrated". The peak keeps its `≈` at every level, because per-delta
         * allocation is reconstructed in all of them.
         */
        source: {
          aligned: source.aligned,
          calibrated: source.calibratedForCurve,
          calibrationCoverage: source.calibrationCoverage,
          contributingAttemptCount: source.contributingCount,
          calibratedAttemptCount: source.calibratedCount,
          rawFallbackAttemptIds: source.rawFallbackAttemptIds,
          issues: source.issues,
        },
        /** The rendered geometry: one trace per attempt, split into phase-coloured runs. */
        attempts: budgetedTraces,
        series,
        /**
         * Per-phase colour segmentation of the same traces, for diagnostics and for
         * tests that ask where a phase has evidence at all. It is derived from the
         * attempt traces rather than measured separately.
         */
        phaseRuns: phaseRuns(traces),
        peakTps: peakTps(...traces.map(trace => trace.points)),
        /**
         * **Debug-only provenance of the published peak.**
         *
         * `peakTps` is a maximum, and a maximum says nothing about how it was
         * produced. The Phase 9.4 defect was exactly that: a peak whose value came
         * from a denominator — 50 ms, or one millisecond — that no surface
         * reported. This record publishes the winning attempt, phase, episode
         * origin, elapsed clock, contributing sample count and mass, the
         * calibration mode and the timestamps of the samples behind the number, so
         * a spike can be explained rather than merely observed.
         *
         * It is diagnostics and must not be rendered: no module in `src/client`
         * reads it, and `test/curve-rate-publication.test.js` asserts that the
         * composed view model does not carry it. `null` when nothing is
         * publishable, which is the same condition that makes `peakTps` `null`.
         */
        peakProvenance: traces.reduce(
          (best, trace) => (trace.peakProvenance === null
            ? best
            : (best === null || trace.peakProvenance.tps > best.tps ? trace.peakProvenance : best)),
          null,
        ),
        /**
         * Flat concatenations of the budgeted runs, retained for callers that want one
         * array of vertices. They carry `attemptId` on every point; a renderer must
         * segment on it rather than joining the array into one path.
         */
        reasoning: series[0].runs.flatMap(run => run.points),
        output: series[1].runs.flatMap(run => run.points),
        /**
         * The chart-wide rendering budget, and what became of it. `allocated` is at or
         * below `total`, and `degradedRuns` counts the runs refused outright when the
         * anchors did not fit — the documented degradation, published rather than
         * silent.
         *
         * `lineVertices` and `markers` split the same allocation the way the chart is
         * actually built: a run of two or more vertices becomes a path vertex, and a run
         * of one becomes a point marker
         * (`src/client/completed/curve-view-model.js`). `elementPoints` is their sum,
         * and it — not `drawnPoints` alone — is the quantity `MAX_RENDER_POINTS_TOTAL`
         * bounds, because a marker is an SVG-adjacent element just as a vertex is, and
         * a phase-transition vertex is emitted by both subpaths that share it.
         *
         * `peakRun` is the flat index of the run carrying the chart maximum in the
         * allocation's own run order, or `-1` when no run holds a finite rate.
         * `peakRetained` is false only when that run could not be seated at all, which
         * at a budget of 512 cannot happen; a caller that reads it must not present a
         * refused peak as a drawn one.
         */
        renderBudget: {
          total: allocation.total,
          allocated: allocation.allocated,
          runs: allocation.budgets.length,
          degradedRuns,
          lineVertices,
          markers,
          elementPoints: lineVertices + markers,
          peakRun: allocation.peakIndex,
          peakRetained: allocation.peakRetained,
        },
        /**
         * Every budgeted vertex, summed over both phases and every run. This is the
         * allocation's own accounting, so it counts a one-vertex run as the single
         * vertex it holds — which is what the allocator charged for it.
         *
         * It is therefore **not** the same quantity as `curveViewModel.drawnPoints`,
         * which counts path vertices only and reports markers separately. The two names
         * were once the same and the coincidence hid half the SVG from the bound: a
         * chart could assert `drawnPoints <= 512` while carrying any number of markers
         * on top. `renderBudget.elementPoints` is the sum that is actually bounded;
         * this field remains the allocator's accounting.
         */
        drawnPoints: series.reduce(
          (sum, entry) => sum + entry.runs.reduce((inner, run) => inner + run.points.length, 0),
          0,
        ),
        /**
         * Curve quality follows the **temporal shape** axis, not the token axis. A
         * curve is a shape claim, so an exactly known token total with incomplete
         * timestamps is an estimated shape, and `usageComplete` alone cannot express
         * that. See `curveQuality` below.
         */
        quality: curveQuality(aggregate),
        qualityAxes: {
          tokenTotalQuality: aggregate.quality.tokenTotalQuality,
          phaseSplitQuality: aggregate.quality.phaseSplitQuality,
          temporalShapeQuality: aggregate.quality.temporalShapeQuality,
        },
        sampleEveryMs: CURVE_SAMPLE_EVERY_MS,
        /**
         * The stored-series cap the published points obey. There is no statistical
         * window to publish beside it: the estimator is a phase-cumulative average,
         * so `sampleEveryMs` is a sampling decision and the cap is a fidelity one.
         */
        maxSeriesPoints: MAX_SERIES_POINTS,
      },
    }
  }

  /** Current live snapshot for one session, or `{phase:'idle'}`. */
  liveSnapshot(sessionId, nowMs) {
    const meter = this.liveBySession.get(sessionId)
    return meter === undefined ? { phase: LivePhase.IDLE } : meter.snapshot(nowMs)
  }

  /** Latest settled turn for one session, newest by turn number. */
  latestSettled(sessionId) {
    let best = null
    for (const record of this.turns.values()) {
      if (record.sessionId !== sessionId || record.settled === null) continue
      if (best === null || record.turn > best.turn) best = record.settled
    }
    return best
  }

  /** Drop the oldest settled turns so memory stays bounded. */
  pruneHistory(sessionId) {
    const settled = [...this.turns.values()]
      .filter(record => record.sessionId === sessionId && record.settled !== null)
      .sort((a, b) => a.turn - b.turn)
    while (settled.length > this.historyLimit) {
      const victim = settled.shift()
      this.turns.delete(turnKey(victim.sessionId, victim.turn))
    }
  }

  /**
   * Drop everything one session owns, because the window that produced it has been
   * superseded.
   *
   * A `replace` on the session event window is a **rebaseline**: the complete contiguous
   * window was swapped (reload, reconnect, window generation change), so the rows the feed
   * republishes are that session's authoritative evidence and whatever the previous
   * generation contributed is not. `SessionEventFeed` drops its own generation state for
   * exactly that reason; this method is the same boundary on the metric side, where the
   * evidence actually lives.
   *
   * Without it the replay re-enters attempts that already exist. `beginTurn` is
   * deliberately idempotent — re-observing the same durable `turn/start` must not discard
   * samples — and `beginAttempt` returns the existing attempt for a known `attemptId`, so
   * a replayed delta is appended to the very attempt the superseded window filled. The
   * turn then reports whatever the window happened to publish, counted once per
   * republication.
   *
   * Two things are removed, and both are needed. The turn records
   * (`this.turns`, keyed by `(sessionId, turn)`) carry attempts, samples, usage, tool
   * intervals and the computed settled snapshot; the `LiveMeter` in `this.liveBySession`
   * carries the rolling window, the frozen TTFT stage, the turn start and the running
   * tool set. Clearing one and keeping the other would leave a live rate assembled from a
   * window the client no longer believes in.
   *
   * The scope is one session. Two sessions run concurrently and their windows are
   * independent, so a rebaseline of one is not a reason to discard the other's evidence;
   * `dispose()` is the store-wide reset, and it is a different operation with a different
   * meaning.
   *
   * @param {string} sessionId
   * @returns {number} how many turn records were removed
   */
  rebaselineSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return 0
    let removed = 0
    /** Deleting during `Map` iteration is safe: entries not yet visited are still reached. */
    for (const [key, record] of this.turns) {
      if (record.sessionId !== sessionId) continue
      this.turns.delete(key)
      removed += 1
    }
    this.liveBySession.delete(sessionId)
    return removed
  }

  /**
   * Release every resource. The store owns no timers or listeners, but clearing
   * is still required so an HMR reload cannot leave a previous generation's
   * state addressing the same sessions.
   */
  dispose() {
    this.turns.clear()
    this.liveBySession.clear()
  }
}

;Object.assign(__exports, { DEFAULT_HISTORY_LIMIT, curveQuality, TurnTelemetryStore })
			},
			"src/dsh/raw.js": function (__exports) {
/**
 * Raw DSH evidence discriminants.
 *
 * These predicates are the *only* place that inspects the DSH wire shape of an
 * incoming record. Everything downstream consumes normalized events.
 *
 * Verified shapes (re-audited against the target DSH **0.1.7-rc.2** in Phase 7D;
 * the 0.1.5-rc.2 line numbers these were originally taken from are kept in
 * `docs/IMPLEMENTATION_LOG.md`):
 *   SessionEvent                 dsh-session/lib/types/types.d.ts
 *   SessionEventLikeEntry        dsh-api-session-controller/lib/types/client/contract/events.d.ts:20-26
 *   AssistantLiveChunkEvent      …/events.d.ts:6-16
 *   AssistantStreamFrame         dsh-api-session-controller/lib/types/types.d.ts:482-509
 *
 * The three discriminants themselves — the `type` tags and the `event`/`frame`
 * nesting — are unchanged between the two lines, which is why this module needed
 * no migration. The 0.1.7 change is in the payloads, not in the envelope.
 */

/** Which of the two evidence planes one raw entry belongs to. */
const DSH_RAW_KIND = Object.freeze({
  /** A durable `SessionEvent` envelope. */
  DURABLE: 'durable',
  /** A client-folded `assistant/live-chunk` transient row. */
  TRANSIENT: 'transient',
  /** A host-published `agent/assistant-stream` frame. */
  STREAM_FRAME: 'stream-frame',
  /** None of the above. */
  UNKNOWN: 'unknown',
})

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A durable session envelope: `{type, seq, time, data}` with a non-empty string type. */
function isDurableSessionEventEntry(entry) {
  if (!isObject(entry)) return false
  // Wrapped form: `{ type: 'event', event }`.
  if (entry.type === 'event') return isDurableSessionEventEntry(entry.event)
  if (typeof entry.type !== 'string' || entry.type === '') return false
  if (!Number.isFinite(entry.seq)) return false
  if (!Number.isFinite(entry.time)) return false
  return isObject(entry.data)
}

/** A client-folded transient row: `{type:'assistant/live-chunk', seq, time, data:{attemptId, chunk}}`. */
function isTransientLiveChunkEntry(entry) {
  if (!isObject(entry)) return false
  if (entry.type === 'transient') return isTransientLiveChunkEntry(entry.event)
  if (entry.type !== 'assistant/live-chunk') return false
  return isObject(entry.data) && typeof entry.data.attemptId === 'string'
}

/** A host-published assistant-stream frame. */
function isAssistantStreamFrame(value) {
  if (!isObject(value)) return false
  if (value.type !== 'start' && value.type !== 'chunk' && value.type !== 'end') return false
  return typeof value.attemptId === 'string'
}

/** Classify one raw entry without interpreting it. */
function classifyRawEntry(entry) {
  if (isAssistantStreamFrame(entry)) return DSH_RAW_KIND.STREAM_FRAME
  if (isTransientLiveChunkEntry(entry)) return DSH_RAW_KIND.TRANSIENT
  if (isDurableSessionEventEntry(entry)) return DSH_RAW_KIND.DURABLE
  return DSH_RAW_KIND.UNKNOWN
}

/**
 * Identity of the session a raw entry belongs to, or `null`.
 *
 * The durable plane carries the session outside the envelope (the listener's
 * `session` argument), so callers pass the session explicitly when they have it
 * and fall back to this reader for wrapped fixture forms.
 */
function sessionKeyOf(entry) {
  if (!isObject(entry)) return null
  if (typeof entry.sessionId === 'string' && entry.sessionId !== '') return entry.sessionId
  if (isObject(entry.session) && entry.session.id !== undefined) return String(entry.session.id)
  return null
}

;Object.assign(__exports, { DSH_RAW_KIND, isDurableSessionEventEntry, isTransientLiveChunkEntry, isAssistantStreamFrame, classifyRawEntry, sessionKeyOf })
			},
			"src/dsh/stream-decoder.js": function (__exports) {
/**
 * Durable `AssistantStreamRecord` decoder — the DSH-facing surface.
 *
 * The decoding rules themselves live in `src/core/delta-accounting.js`
 * (`decodeAssistantStream` / `expandAssistantStream`) so that exactly one
 * implementation of the rule exists and `src/core` stays free of DSH imports.
 * This module adds only what is DSH-specific: locating the record array inside
 * a settlement payload, and turning decoder issues into this project's
 * quality vocabulary.
 *
 * What a successful decode guarantees, and therefore what the durable
 * reconstruction path is allowed to assume:
 *
 *   - every delta of the attempt, in logical stream order;
 *   - each delta's exact reconstructed wall-clock time, hence the exact gap
 *     (`dt`) to its predecessor;
 *   - the phase of each delta: `text-delta` and `tool-call-delta` are output,
 *     `reasoning-delta` is reasoning;
 *   - the block boundaries, because `block-start`/`block-end` are never packed
 *     into runs and therefore survive as raw `chunk` records;
 *   - the in-stream `usage` chunk and the `finish` chunk, likewise raw.
 *
 * When any record is malformed the decode reports it and marks itself
 * incomplete. It never invents a delta and never silently drops one: a stream
 * that lost a record yields a *lower quality* observation, which is a different
 * claim from an exact one.
 */

const { DECODE_ISSUE, decodeAssistantStream, expandAssistantStream, firstTokenTime, isTokenDelta } = __req("src/core/delta-accounting.js")
const { MetricQuality } = __req("src/core/metric-quality.js")

/** Chunk kinds a decoded stream can carry, in the vocabulary the core uses. */
const RECORD_KIND = Object.freeze({
  DELTA: 'delta',
  RAW: 'raw',
})

/** Event types that settle one attempt and embed its stream. */
const SETTLEMENT_EVENT_TYPES = Object.freeze(['assistant/message', 'assistant/attempt'])

/** How much of the stream survived decoding, as a metric-quality value. */
function decodeQuality(result) {
  if (!result || result.recordCount === 0) return MetricQuality.UNAVAILABLE
  if (result.deltaCount === 0 && result.recordCount > 0) return MetricQuality.UNAVAILABLE
  return result.complete ? MetricQuality.EXACT : MetricQuality.ESTIMATED
}

/**
 * Decode the compact records of one durable settlement.
 *
 * @param {unknown} records `assistant/message.stream` or `assistant/attempt.stream`
 * @param {{maxIssues?:number}} [options]
 * @returns {{
 *   chunks: {timeMs:number, chunk:object, recordIndex:number, memberIndex:number}[],
 *   issues: object[],
 *   issuesTruncated: boolean,
 *   recordCount: number,
 *   decodedRecordCount: number,
 *   deltaCount: number,
 *   firstTimeMs: number|null,
 *   lastTimeMs: number|null,
 *   complete: boolean,
 *   quality: string,
 *   generatedChunkCount: number,
 *   firstTokenTimeMs: number|null,
 * }}
 */
function decodeStreamRecords(records, options = {}) {
  const result = decodeAssistantStream(records, options)
  return decorate(result)
}

/**
 * Tolerant decode for the live path.
 *
 * The transient plane arrives one frame at a time and a rebaseline can hand the
 * client a compact prefix mid-attempt, so the tolerant reader is the right one
 * there: losing one curve segment beats losing the meter. It reports the same
 * issue vocabulary by re-deriving it, so a caller can tell the two apart.
 */
function expandAssistantStreamRaw(records) {
  const tolerant = expandAssistantStream(records)
  const strict = decodeAssistantStream(records, { maxIssues: 50 })
  const chunks = tolerant.map((entry, index) => ({
    timeMs: entry.timeMs,
    chunk: entry.chunk,
    recordIndex: -1,
    memberIndex: index,
  }))
  const times = chunks.map(entry => entry.timeMs)
  return decorate({
    chunks,
    issues: strict.issues,
    issuesTruncated: strict.issuesTruncated,
    recordCount: strict.recordCount,
    decodedRecordCount: strict.decodedRecordCount,
    deltaCount: strict.deltaCount,
    firstTimeMs: times.length > 0 ? Math.min(...times) : null,
    lastTimeMs: times.length > 0 ? Math.max(...times) : null,
    complete: strict.complete,
  })
}

function decorate(result) {
  const generated = result.chunks.filter(entry => isTokenDelta(entry.chunk))
  return {
    ...result,
    quality: decodeQuality(result),
    generatedChunkCount: generated.length,
    firstTokenTimeMs: firstTokenTime(result.chunks),
  }
}

/** Time of the first member this project counts as a generated first token. */
function firstTokenTimeOf(chunks) {
  return firstTokenTime(chunks)
}



;Object.assign(__exports, { DECODE_ISSUE, expandAssistantStream: expandAssistantStreamRaw, RECORD_KIND, SETTLEMENT_EVENT_TYPES, decodeQuality, decodeStreamRecords, expandAssistantStreamRaw, firstTokenTimeOf })
			},
			"src/dsh/adapter.js": function (__exports) {
/**
 * DSH rc.2 raw evidence -> normalized engine events.
 *
 * This is the only module in the project that reads a DSH field name. Its
 * contract is deliberately narrow and total: given the durable events of one
 * session and the transient frames of one session, produce the normalized
 * `TurnRecord`/`AttemptRecord`/`ToolCallRecord` values that `src/core` consumes,
 * plus an explicit list of everything that had to be degraded on the way.
 *
 * Field mapping (raw -> normalized), with the local evidence for each shape:
 *
 * | DSH raw                                                    | normalized                                  |
 * |------------------------------------------------------------|---------------------------------------------|
 * | `SessionEvent<'turn/start'>.time`                          | `TurnRecord.startMs`                        |
 * | `SessionEvent<'turn/end'>.time`                            | `TurnRecord.endMs`                          |
 * | `SessionEvent<'turn/end'>.data.reason`                     | `TurnRecord.status` (+ `endReason`)         |
 * | `SessionEvent<'assistant/message'>{turn,step,stream,usage}`| one `AttemptRecord` (surface settlement)    |
 * | `SessionEvent<'assistant/attempt'>{turn,step,stream}`      | one `AttemptRecord` (durable non-surface settlement — **not** an abandonment) |
 * | `SessionEvent<'llm/retry'>`                                | `RETRY_SCHEDULED` (correlates `retried`)    |
 * | `AssistantStreamRecord.text-chunks`                        | `text-delta` samples (output phase)         |
 * | `AssistantStreamRecord.reasoning-chunks`                   | `reasoning-delta` samples (reasoning phase) |
 * | `AssistantStreamRecord.tool-call-chunks`                   | `tool-call-delta` samples (output phase)    |
 * | `AssistantStreamRecord.chunk`                              | block/usage/finish; no token sample         |
 * | `StreamChunk.usage.usage` (in-stream)                      | `AttemptRecord.usage` fallback              |
 * | `assistant/message.usage`                                  | `AttemptRecord.usage` (authoritative)       |
 * | `SessionEvent<'tool/call'>{callId,name,arguments}.time`    | `ToolCallRecord.startMs`                    |
 * | `SessionEvent<'tool/result'>.time`                         | `ToolCallRecord.endMs` + status             |
 * | `AssistantLiveChunkEvent.time`                             | `DeltaSample.timeMs` (live path)            |
 * | `AssistantLiveChunkEvent.data.attemptId`                   | `DeltaSample.attemptId` / attempt identity  |
 * | `AssistantStreamFrame{start,chunk,end}`                    | the same, before the client fold            |
 *
 * Nothing here computes statistics. Every number this module produces is a
 * measured boundary copied from an event envelope, or a token-shape weight
 * obtained from `src/core/token-allocation.js`.
 */

const { classifyDelta, deltaText, firstTokenTime, isTokenDelta, phaseCutsFromChunks, usageFromChunk } = __req("src/core/delta-accounting.js")
const { MetricQuality, weakestQuality } = __req("src/core/metric-quality.js")
const { heuristicTokenWeight, sampleFromChunk } = __req("src/core/token-allocation.js")
const { TEMPORAL_EVIDENCE_AUTHORITY } = __req("src/core/types.js")
const { decodeStreamRecords, SETTLEMENT_EVENT_TYPES } = __req("src/dsh/stream-decoder.js")

/** Normalized event kinds emitted by the mapping step. */
const NORMALIZED_KIND = Object.freeze({
  TURN_START: 'turn-start',
  TURN_END: 'turn-end',
  STEP_START: 'step-start',
  STEP_END: 'step-end',
  ATTEMPT_START: 'attempt-start',
  ATTEMPT_DELTA: 'attempt-delta',
  ATTEMPT_SETTLE: 'attempt-settle',
  ATTEMPT_ABANDON: 'attempt-abandon',
  RETRY_SCHEDULED: 'retry-scheduled',
  TOOL_CALL: 'tool-call',
  TOOL_RESULT: 'tool-result',
  IGNORED: 'ignored',
})

/**
 * Which durable surface settled one attempt (settlement type — concept 1).
 *
 * Verified against `dsh-session/lib/types/types.d.ts:309-327` in the local
 * `0.1.5-rc.2` install:
 *
 *   `assistant/message` — an assembled assistant message on the model-visible
 *     surface; a turn cancelled mid-stream finalizes its delivered prefix as
 *     this event with `interrupted: true`.
 *   `assistant/attempt` — "one model attempt that committed no surface
 *     message. The embedded stream preserves a failed, retried, cancelled, or
 *     stream-error attempt that reached **settlement** without fabricating
 *     model-visible history."
 *
 * `NONE` means no durable settlement exists — either the attempt is still
 * open or it was transiently abandoned (`AssistantStreamFrame.end.outcome.kind
 * === 'abandoned'`, documented as "live abandonment without one [durable
 * settlement]", `dsh-agent/lib/types/runtime-types.d.ts:129-136`).
 */
const SETTLEMENT_KIND = Object.freeze({
  MESSAGE: 'message',
  ATTEMPT: 'attempt',
  NONE: 'none',
})

/**
 * Execution outcome of one attempt (concept 2), strictly separated from the
 * settlement type and from surface visibility (concept 3).
 *
 * Only `committed`, `interrupted` and `abandoned` are directly readable from
 * rc.2 evidence. `failed`/`retried`/`cancelled`/`stream-error` are named by
 * the `assistant/attempt` doc comment as *possible* causes, but the durable
 * payload carries no cause field: `retried` is the single member derivable by
 * correlation (a later `llm/retry` event names the same turn/step —
 * `dsh-llm-retry` invariant code pairs them), and everything else stays
 * `unknown` rather than being guessed.
 */
const ATTEMPT_OUTCOME = Object.freeze({
  COMMITTED: 'committed',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
  RETRIED: 'retried',
  CANCELLED: 'cancelled',
  STREAM_ERROR: 'stream-error',
  ABANDONED: 'abandoned',
  UNKNOWN: 'unknown',
})

/**
 * Classify one durable settlement into the three independent concepts.
 *
 * `assistant/attempt` is deliberately **not** mapped to `abandoned`: it is a
 * durable settlement (surface visibility lost, settlement preserved), while
 * abandonment is the transient condition of having no durable settlement at
 * all. When the cause of a non-surface settlement cannot be derived from
 * durable evidence the outcome is `unknown`.
 *
 * @param {string} eventType `assistant/message` | `assistant/attempt`
 * @param {{interrupted?: boolean}} [data] settlement payload
 * @returns {{settlementKind: string, surfaceCommitted: boolean, attemptOutcome: string}}
 */
function settlementClassification(eventType, data = {}) {
  const surfaceCommitted = eventType === 'assistant/message'
  const settlementKind = surfaceCommitted
    ? SETTLEMENT_KIND.MESSAGE
    : eventType === 'assistant/attempt' ? SETTLEMENT_KIND.ATTEMPT : SETTLEMENT_KIND.NONE
  let attemptOutcome = ATTEMPT_OUTCOME.UNKNOWN
  if (data?.interrupted === true) attemptOutcome = ATTEMPT_OUTCOME.INTERRUPTED
  else if (surfaceCommitted) attemptOutcome = ATTEMPT_OUTCOME.COMMITTED
  return { settlementKind, surfaceCommitted, attemptOutcome }
}

/**
 * Classify a transient `end` frame outcome.
 *
 * `kind: 'abandoned'` is the **only** evidence for `ATTEMPT_OUTCOME.ABANDONED`:
 * a live stream that ended without any durable settlement.
 */
function transientEndClassification(outcome) {
  if (outcome?.kind === 'committed') return settlementClassification(outcome.eventType, {})
  if (outcome?.kind === 'abandoned') {
    return {
      settlementKind: SETTLEMENT_KIND.NONE,
      surfaceCommitted: false,
      attemptOutcome: ATTEMPT_OUTCOME.ABANDONED,
    }
  }
  return {
    settlementKind: SETTLEMENT_KIND.NONE,
    surfaceCommitted: false,
    attemptOutcome: ATTEMPT_OUTCOME.UNKNOWN,
  }
}

/**
 * Every `TurnEndReason` variant of the local 0.1.7-rc.2 install, mapped to the
 * card status.
 *
 * Audited field by field against
 * `dsh-session/lib/types/types.d.ts:165-208`, which declares exactly seven
 * variants: `completed`, `aborted{reason: TurnEndCancelCause}`, `blocked`,
 * `error{error: LlmFailure}`, `max-tokens`, `interrupted` and `forked`.
 *
 *   completed     the turn finished normally
 *   max-tokens    at least one step reached its output ceiling; the turn did
 *                 finish, so it is `completed` **with** a truncation note
 *   aborted       a cancellation request interrupted the live turn; `reason` is
 *                 `AgentCancelCause` (`user` | `parent` | `hook` | `disposed`)
 *                 or `{kind:'legacy'}` for an import whose coarse record carried
 *                 no cause
 *   interrupted   a crash-orphaned turn closed after the fact; the loop never
 *                 emits this marker live
 *   forked        fork-seed construction closed a turn that was **still open**
 *                 at the fork boundary in the source session. Only fork seeds
 *                 carry it and the loop never emits it, but the turn genuinely
 *                 did not finish, so it is an interruption and never a
 *                 completion
 *   blocked       the turn could not proceed
 *   error         the turn failed; `error` is a structured `LlmFailure`
 */
const STATUS_BY_TURN_END = Object.freeze({
  completed: 'completed',
  'max-tokens': 'completed',
  aborted: 'interrupted',
  interrupted: 'interrupted',
  forked: 'interrupted',
  blocked: 'errored',
  error: 'errored',
})

/**
 * Map one durable `turn/end` reason to the card status, per the mapping table
 * frozen in `docs/IMPLEMENTATION_LOG.md`.
 *
 * An unknown future reason kind must not be reported as a known cause: it maps
 * to `errored` with `known: false`, and the caller surfaces the raw reason. The
 * turn still closes — a turn is never left live merely because its reason kind
 * is unrecognized.
 */
function turnEndStatus(reason) {
  const kind = reason && typeof reason === 'object' ? reason.kind : undefined
  if (typeof kind !== 'string') return { status: 'errored', known: false, note: 'turn/end carried no reason kind' }
  const status = STATUS_BY_TURN_END[kind]
  if (status === undefined) return { status: 'errored', known: false, note: `unrecognized turn/end reason "${kind}"` }
  if (kind === 'max-tokens') {
    return { status, known: true, note: 'output-token ceiling reached; generation is truncated' }
  }
  if (kind === 'aborted') {
    const cause = reason.reason?.kind ?? 'unknown'
    return { status, known: true, note: `cancelled (${cause})` }
  }
  if (kind === 'interrupted') {
    return { status, known: true, note: 'turn was closed after a crash' }
  }
  if (kind === 'forked') {
    return { status, known: true, note: 'turn was still open at a fork boundary' }
  }
  return { status, known: true, note: null }
}

/**
 * Where a `tool/result`'s call identity was read from.
 *
 * The 0.1.7 contract puts the identity on the message; the recorded 0.1.5
 * fixtures put it on the first content block. The two are separated by a
 * **structural** discriminator (`message.role`), so the legacy read is
 * unreachable for a 0.1.7 tool-role message and every normalization states
 * which shape it used.
 */
const TOOL_RESULT_SHAPE = Object.freeze({
  /** 0.1.7: a first-class tool-role message owning `toolCallId` and `isError`. */
  TOOL_MESSAGE: 'tool-message',
  /** Recorded 0.1.5 form: a `user`-role message whose first content block owned them. */
  LEGACY_CONTENT_BLOCK: 'legacy-content-block',
  /** Neither location carried an identity. The result is unusable. */
  MALFORMED: 'malformed',
})

/**
 * Read one tool result's call identity and failure flag.
 *
 * 0.1.7 target contract, verified against the local install:
 *
 *   `dsh-llm/lib/types/message.d.ts:152-160`
 *     `ToolResultMessage` = `{ role: 'tool', toolCallId, isError? , content, source, id }`
 *   `dsh-session/lib/types/types.d.ts:374-388`
 *     `'tool/result'` = `{ turn, step, message: ToolResultMessage, error?, meta? }`
 *
 * so the identity is `data.message.toolCallId`, the failure flag is
 * `data.message.isError`, and the content blocks are result **content** with no
 * call identity in them at all. `content[0].toolCallId` is therefore never read
 * for a tool-role message — not as a fallback, and not when the message field is
 * missing, because §6 requires a malformed result to fail closed rather than be
 * repaired by position.
 *
 * The legacy form is the shape actually present in `fixtures/dsh-turns/*`
 * (recorded on 0.1.5-rc.2, where the result was a `user`-role message carrying
 * `content[0].{toolCallId,isError}`). It is decoded — the metric-math
 * regressions replay those bytes — but it is labelled, and a message that
 * declares `role: 'tool'` can never reach it.
 */
function toolResultIdentity(message) {
  if (message === null || typeof message !== 'object') {
    return { callId: null, callIdSource: TOOL_RESULT_SHAPE.MALFORMED, status: 'ok', errorName: null, errorCode: null }
  }
  if (message.role === 'tool') {
    const callId = typeof message.toolCallId === 'string' && message.toolCallId !== '' ? message.toolCallId : null
    return {
      callId,
      callIdSource: callId === null ? TOOL_RESULT_SHAPE.MALFORMED : TOOL_RESULT_SHAPE.TOOL_MESSAGE,
      status: message.isError === true ? 'error' : 'ok',
      errorName: null,
      errorCode: null,
    }
  }
  const block = Array.isArray(message.content) ? message.content[0] : undefined
  const callId = typeof block?.toolCallId === 'string' && block.toolCallId !== '' ? block.toolCallId : null
  return {
    callId,
    callIdSource: callId === null ? TOOL_RESULT_SHAPE.MALFORMED : TOOL_RESULT_SHAPE.LEGACY_CONTENT_BLOCK,
    status: block?.isError === true ? 'error' : 'ok',
    errorName: null,
    errorCode: null,
  }
}

/**
 * Timestamps on a `tool/result` payload do not exist; the envelope carries them.
 * The structured `data.error` identity is on the event, beside the message, and
 * is allowed only when the message is flagged failed
 * (`dsh-session/lib/types/types.d.ts:378-386`).
 *
 * Exported because it is the **single** contract site for reading a tool result.
 * Every consumer — the live adapter and the durable reconstruction path alike —
 * goes through it, so the identity location cannot drift between them.
 */
function toolResultOutcome(data) {
  const identity = toolResultIdentity(data?.message)
  const error = data?.error
  const hasError = error !== null && typeof error === 'object'
  return {
    ...identity,
    status: hasError || identity.status === 'error' ? 'error' : 'ok',
    errorName: hasError && typeof error.name === 'string' ? error.name : identity.errorName,
    errorCode: hasError && typeof error.code === 'string' ? error.code : identity.errorCode,
  }
}

/** Read the usage carrier from a settlement, preferring the durable one. */
function settlementUsage(data, decoded) {
  const durable = data?.usage
  if (durable && typeof durable === 'object' && Number.isFinite(durable.outputTokens)) {
    return { usage: durable, source: 'assistant-settlement' }
  }
  for (let index = decoded.chunks.length - 1; index >= 0; index -= 1) {
    const usage = usageFromChunk(decoded.chunks[index].chunk)
    if (usage !== null) return { usage, source: 'in-stream-usage-chunk' }
  }
  return { usage: null, source: null }
}

/**
 * Turn one durable session event into zero or more normalized events.
 *
 * The returned values are the adapter's stable vocabulary; a caller that has to
 * branch on a raw DSH event type is a caller that should be reading
 * `NORMALIZED_KIND` instead.
 */
function normalizeDurableEvent(event) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
    return { kind: NORMALIZED_KIND.IGNORED, reason: 'not a session event' }
  }
  const data = event.data ?? {}
  const common = { seq: event.seq, timeMs: event.time }
  switch (event.type) {
    case 'turn/start':
      return { kind: NORMALIZED_KIND.TURN_START, ...common, turn: data.turn }
    case 'turn/end': {
      const mapped = turnEndStatus(data.reason)
      return {
        kind: NORMALIZED_KIND.TURN_END,
        ...common,
        turn: data.turn,
        status: mapped.status,
        reasonKind: data.reason?.kind ?? null,
        statusKnown: mapped.known,
        note: mapped.note,
        rawReason: data.reason ?? null,
      }
    }
    case 'step/start':
      return { kind: NORMALIZED_KIND.STEP_START, ...common, turn: data.turn, step: data.step }
    case 'step/end':
      return { kind: NORMALIZED_KIND.STEP_END, ...common, turn: data.turn, step: data.step }
    case 'assistant/message':
    case 'assistant/attempt': {
      const decoded = decodeStreamRecords(data.stream)
      const { usage, source } = settlementUsage(data, decoded)
      const issues = decoded.issues.map(issue => ({ ...issue, where: 'durable-stream' }))
      return {
        kind: NORMALIZED_KIND.ATTEMPT_SETTLE,
        ...common,
        turn: data.turn,
        step: data.step,
        eventType: event.type,
        ...settlementClassification(event.type, data),
        interrupted: data.interrupted === true,
        decoded,
        usage,
        usageSource: source,
        issues,
        quality: decoded.quality,
      }
    }
    case 'llm/retry':
      /**
       * A scheduled durable retry (`dsh-llm-retry`): non-surface, appended
       * after the failed step's `assistant/attempt` settled, naming the same
       * turn/step. It is the one retry fact derivable from the durable log and
       * the only way an `assistant/attempt` outcome becomes knowable.
       */
      return {
        kind: NORMALIZED_KIND.RETRY_SCHEDULED,
        ...common,
        turn: data.turn,
        step: data.step,
        retryId: typeof data.retryId === 'string' ? data.retryId : null,
        retry: Number.isFinite(data.retry) ? data.retry : null,
      }
    case 'tool/call':
      return {
        kind: NORMALIZED_KIND.TOOL_CALL,
        ...common,
        turn: data.turn,
        step: data.step,
        callId: typeof data.callId === 'string' ? data.callId : null,
        name: typeof data.name === 'string' ? data.name : null,
        /**
         * The raw argument JSON exactly as the model produced it. It is kept for
         * evidence and for argument-length accounting; it is **not** a token
         * count and is never used as one.
         */
        argumentsRaw: typeof data.arguments === 'string' ? data.arguments : null,
      }
    case 'tool/result': {
      const outcome = toolResultOutcome(data)
      return {
        kind: NORMALIZED_KIND.TOOL_RESULT,
        ...common,
        turn: data.turn,
        step: data.step,
        callId: outcome.callId,
        /** Which shape supplied the identity; `malformed` means none did. */
        callIdSource: outcome.callIdSource,
        /**
         * The result cannot be paired. §6: fail closed — no guessing the most
         * recent call, no matching by name or by step, no closing every running
         * call. The caller decides what to record, and records that it happened.
         */
        malformed: outcome.callId === null,
        status: outcome.status,
        errorName: outcome.errorName,
        errorCode: outcome.errorCode,
      }
    }
    default:
      return { kind: NORMALIZED_KIND.IGNORED, reason: event.type, ...common }
  }
}

/**
 * Normalize one client-folded transient row (`assistant/live-chunk`).
 *
 * The client fold is what a browser actually sees, so this is the shape the
 * live path must consume. `time` sits on the row, not on `data`.
 */
function normalizeLiveChunk(entry) {
  const row = entry?.type === 'transient' ? entry.event : entry
  const data = row?.data
  if (row?.type !== 'assistant/live-chunk' || !data || typeof data.attemptId !== 'string') {
    return { kind: NORMALIZED_KIND.IGNORED, reason: 'not a live chunk' }
  }
  return {
    kind: NORMALIZED_KIND.ATTEMPT_DELTA,
    timeMs: row.time,
    seq: row.seq,
    attemptId: data.attemptId,
    turn: data.turn,
    step: data.step,
    chunk: data.chunk,
    phase: classifyDelta(data.chunk),
    text: deltaText(data.chunk),
    countsAsToken: isTokenDelta(data.chunk),
  }
}

/**
 * Normalize one host `agent/assistant-stream` frame.
 *
 * The host frame is the earliest form of the same evidence: it carries
 * `attemptId`, `revision`, `index`, `time` and the chunk, and it is what the
 * client fold later turns into `assistant/live-chunk`. A `start` frame is the
 * only source of an attempt's `(turn, step)` before its first durable fact.
 */
function normalizeStreamFrame(frame) {
  if (frame === null || typeof frame !== 'object' || typeof frame.attemptId !== 'string') {
    return { kind: NORMALIZED_KIND.IGNORED, reason: 'not a stream frame' }
  }
  if (frame.type === 'start') {
    return {
      kind: NORMALIZED_KIND.ATTEMPT_START,
      attemptId: frame.attemptId,
      revision: frame.revision,
      turn: frame.turn,
      step: frame.step,
      startedAfterSeq: frame.startedAfterSeq ?? null,
    }
  }
  if (frame.type === 'chunk') {
    return {
      kind: NORMALIZED_KIND.ATTEMPT_DELTA,
      timeMs: frame.time,
      attemptId: frame.attemptId,
      revision: frame.revision,
      index: frame.index,
      chunk: frame.chunk,
      phase: classifyDelta(frame.chunk),
      text: deltaText(frame.chunk),
      countsAsToken: isTokenDelta(frame.chunk),
    }
  }
  if (frame.type === 'end') {
    const outcome = frame.outcome ?? {}
    return {
      kind: outcome.kind === 'abandoned' ? NORMALIZED_KIND.ATTEMPT_ABANDON : NORMALIZED_KIND.ATTEMPT_SETTLE,
      attemptId: frame.attemptId,
      revision: frame.revision,
      index: frame.index,
      outcomeKind: outcome.kind ?? null,
      settlementEventType: outcome.eventType ?? null,
      settlementSeq: Number.isFinite(outcome.seq) ? outcome.seq : null,
      ...transientEndClassification(outcome),
    }
  }
  return { kind: NORMALIZED_KIND.IGNORED, reason: `unrecognized frame type ${String(frame.type)}` }
}

/**
 * Build one attempt record from decoded chunks plus its usage and identity.
 *
 * The attempt's `samples` are the generated deltas only; `chunks` keeps the
 * whole decoded stream so that block boundaries, `usage` and `finish` remain
 * available to a caller that needs them. Both come from the same decode, so the
 * sample set and the boundary set can never disagree.
 *
 * The attempt's `temporalEvidenceAuthority` is derived from that same decode and
 * from nothing else: the samples *are* one decode of the durable stream, so a
 * complete decode is `durable-complete` and a decode that lost a record is
 * `durable-incomplete`. A restored attempt built from a partial stream is still
 * real evidence and is still restored — it simply may not support a
 * `reconstructed` temporal shape, because the record it lost is evidence the
 * transient plane may have held and the decode cannot supply.
 */
function attemptFromDecoded({
  attemptId,
  turn,
  step,
  decoded,
  usage = null,
  usageSource = null,
  settlementKind = SETTLEMENT_KIND.NONE,
  surfaceCommitted = false,
  attemptOutcome = ATTEMPT_OUTCOME.UNKNOWN,
  startedAtMs = null,
  settledAtMs = null,
  settlementSeq = null,
  settlementEventType = null,
  interrupted = false,
  issues = [],
  estimate = heuristicTokenWeight,
}) {
  const samples = []
  for (const entry of decoded.chunks) {
    const sample = sampleFromChunk(entry.timeMs, entry.chunk, estimate)
    if (sample !== null) samples.push(sample)
  }
  return {
    attemptId: attemptId ?? null,
    turn: turn ?? null,
    step: step ?? null,
    settlementKind,
    surfaceCommitted,
    attemptOutcome,
    samples,
    /**
     * The attempt's **non-magnitude phase boundaries** (`phaseCutsFromChunks`),
     * beside `samples` rather than inside them.
     *
     * A card restored from a durable settlement must carry the same phase cuts the
     * live session recorded, or the reload path silently loses a boundary the live
     * path published — the completed curve would then bridge an episode the live
     * meter had closed, and the summary would charge the silent stretch to a phase
     * that had already stopped (`docs/METRICS_SPEC.md` §8.7). The rule is the
     * decoder's own `tokenEvidence` verdict, so a boundary the durable stream
     * contains is recovered exactly, and one it does not contain is not invented.
     */
    phaseCuts: phaseCutsFromChunks(decoded.chunks),
    chunks: decoded.chunks,
    decoded,
    /**
     * The attempt's first-token instant, as DSH's own predicate reads it: the
     * time of the first chunk `isTokenDelta` accepts, which includes a
     * name-bearing tool-call delta whose argument fragment is still empty.
     *
     * It is published beside `samples` rather than derived from them because the
     * two are different sets — the boundary chunk contributes no sample — and
     * deriving TTFT from the sample list is what made a reloaded card report `—`
     * for a turn whose TTFT the live session had already measured.
     *
     * The decoder computes it; `firstTokenTime` re-derives it for a caller that
     * hands in a bare decode result, so both entry points agree.
     */
    firstTokenMs: Number.isFinite(decoded?.firstTokenTimeMs)
      ? decoded.firstTokenTimeMs
      : firstTokenTime(decoded?.chunks),
    usage,
    usageSource,
    startedAtMs,
    settledAtMs,
    settlementSeq,
    settlementEventType,
    interrupted,
    issues,
    /** Quality of the decoded stream itself, before any provider anchoring. */
    streamQuality: decoded.quality,
    /**
     * Where this attempt's temporal evidence came from: the decode it was just
     * built from, and only that. A restored attempt is the one path where a
     * partial decode *is* the sample source, which is why the value distinguishes
     * the two cases rather than assuming the durable plane is always complete.
     */
    temporalEvidenceAuthority: decoded?.complete === true
      ? TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE
      : TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE,
  }
}

/** Weakest quality over an attempt's stream decode and its usage availability. */
function attemptEvidenceQuality(attempt) {
  const usageQuality = attempt?.usage === null || attempt?.usage === undefined
    ? MetricQuality.UNAVAILABLE
    : MetricQuality.EXACT
  const streamQuality = attempt?.decoded?.quality ?? MetricQuality.UNAVAILABLE
  return weakestQuality(streamQuality, usageQuality)
}



/**
 * Upgrade `assistant/attempt` outcomes that a durable `llm/retry` proves.
 *
 * Both correlation requirements come from `dsh-llm-retry`'s own invariant
 * checker: the retry names the same turn and step as the failed request, and
 * it is appended *after* that attempt settled. The most recent still-unknown
 * non-surface settlement preceding the retry inside the same step is therefore
 * the retried attempt. Attempts the correlation cannot prove keep `unknown`.
 *
 * Mutates the supplied attempt records in place and is idempotent: an outcome
 * already derived (or a retry already applied by sequence) is never rewritten.
 *
 * @param {readonly object[]} attempts attempt-likes carrying
 *   `{turn, step, settlementKind, settlementSeq, attemptOutcome}`
 * @param {readonly object[]} retries normalized `RETRY_SCHEDULED` events
 * @returns {number} how many attempts were upgraded to `retried`
 */
function applyRetryOutcomes(attempts, retries) {
  if (!Array.isArray(attempts) || !Array.isArray(retries)) return 0
  let upgraded = 0
  const ordered = [...retries]
    .filter(retry => retry && Number.isFinite(retry.seq))
    .sort((a, b) => a.seq - b.seq)
  for (const retry of ordered) {
    let candidate = null
    for (const attempt of attempts) {
      if (attempt.settlementKind !== SETTLEMENT_KIND.ATTEMPT) continue
      if (attempt.attemptOutcome !== ATTEMPT_OUTCOME.UNKNOWN) continue
      if (!Number.isFinite(attempt.settlementSeq) || attempt.settlementSeq >= retry.seq) continue
      if (attempt.turn !== retry.turn || attempt.step !== retry.step) continue
      if (candidate === null || attempt.settlementSeq > candidate.settlementSeq) candidate = attempt
    }
    if (candidate !== null) {
      candidate.attemptOutcome = ATTEMPT_OUTCOME.RETRIED
      upgraded += 1
    }
  }
  return upgraded
}

;Object.assign(__exports, { SETTLEMENT_EVENT_TYPES, NORMALIZED_KIND, SETTLEMENT_KIND, ATTEMPT_OUTCOME, settlementClassification, transientEndClassification, turnEndStatus, TOOL_RESULT_SHAPE, toolResultOutcome, normalizeDurableEvent, normalizeLiveChunk, normalizeStreamFrame, attemptFromDecoded, attemptEvidenceQuality, applyRetryOutcomes })
			},
			"src/dsh/live-path.js": function (__exports) {
/**
 * Live (transient) accumulation path.
 *
 * This is path A of the equivalence requirement: consume the transient plane
 * exactly as a browser receives it — `agent/assistant-stream` frames or the
 * client-folded `assistant/live-chunk` rows they become — plus the durable
 * `turn/start`, `step/start`, `tool/call`, `tool/result` and `turn/end`
 * boundaries, and never touch a compact `AssistantStreamRecord`.
 *
 * The transient plane is fragile in a specific way that the durable plane is
 * not: it is ordered by a dense per-attempt `index`, it can be replayed, and it
 * can be re-baselined after a reload. This accumulator therefore validates the
 * index sequence instead of trusting arrival order, and it reports every
 * duplicate, gap and regression rather than folding them away.
 */

const { MetricQuality } = __req("src/core/metric-quality.js")
const { heuristicTokenWeight, sampleFromChunk } = __req("src/core/token-allocation.js")
const { NORMALIZED_KIND, applyRetryOutcomes, normalizeDurableEvent, normalizeLiveChunk, normalizeStreamFrame, settlementClassification } = __req("src/dsh/adapter.js")

/** Why a transient frame was not accepted into the attempt. */
const FRAME_ISSUE = Object.freeze({
  DUPLICATE: 'duplicated-transient-frame',
  OUT_OF_ORDER: 'out-of-order-transient-frame',
  UNKNOWN_ATTEMPT: 'frame-for-unknown-attempt',
  MISSING_ATTEMPT_ID: 'frame-without-attempt-id',
  ATTEMPT_REOPENED: 'attempt-stream-reopened',
  MISSING_TIME: 'frame-without-timestamp',
})

/**
 * Accumulate one session's live evidence.
 *
 * Keyed by `(sessionId, turn)` at the caller's level; within one instance the
 * attempts are keyed by `attemptId`, because a turn may hold several attempts
 * and a tool may be running while the next attempt starts.
 */
class LiveTurnAccumulator {
  /**
   * @param {{sessionId: string, estimate?: (text:string, phase:string, chunk:unknown)=>number}} options
   */
  constructor({ sessionId, estimate = heuristicTokenWeight } = {}) {
    this.sessionId = sessionId ?? null
    this.estimate = estimate
    this.turnStartMs = null
    this.turnEndMs = null
    this.status = null
    this.statusNote = null
    this.turnEndPayload = null
    this.attempts = new Map()
    this.attemptOrder = []
    this.tools = new Map()
    this.toolOrder = []
    this.steps = new Map()
    /** Scheduled durable retries, for outcome correlation (`llm/retry`). */
    this.retries = []
    /** Everything the live plane could not use, with its reason. */
    this.issues = []
    this.ignoredEvents = 0
    /** Attempts whose transient stream was still open when the caller read it. */
    this.openAttemptIds = new Set()
  }

  issue(kind, detail) {
    this.issues.push(detail === undefined ? { kind } : { kind, detail })
  }

  attempt(attemptId) {
    let attempt = this.attempts.get(attemptId)
    if (attempt === undefined) {
      attempt = {
        attemptId,
        turn: null,
        step: null,
        /** Settlement type: no durable settlement observed yet. */
        settlementKind: 'none',
        surfaceCommitted: false,
        /** Never fabricated: an open attempt's outcome is not known, and is *not* `abandoned`. */
        attemptOutcome: 'unknown',
        revision: null,
        nextIndex: 0,
        chunks: [],
        samples: [],
        usage: null,
        usageSource: null,
        startedAtMs: null,
        settledAtMs: null,
        settlementSeq: null,
        settlementEventType: null,
        interrupted: false,
        issues: [],
        /** Transient frames seen for this attempt, accepted or not. */
        frameCount: 0,
        acceptedFrameCount: 0,
      }
      this.attempts.set(attemptId, attempt)
      this.attemptOrder.push(attemptId)
      this.openAttemptIds.add(attemptId)
    }
    return attempt
  }

  /** Accept one `agent/assistant-stream` frame. */
  acceptStreamFrame(frame) {
    const normalized = normalizeStreamFrame(frame)
    switch (normalized.kind) {
      case NORMALIZED_KIND.ATTEMPT_START: {
        const existing = this.attempts.get(normalized.attemptId)
        if (existing !== undefined && existing.chunks.length > 0) {
          this.issue(FRAME_ISSUE.ATTEMPT_REOPENED, { attemptId: normalized.attemptId, revision: normalized.revision })
        }
        const attempt = this.attempt(normalized.attemptId)
        attempt.turn = normalized.turn ?? attempt.turn
        attempt.step = normalized.step ?? attempt.step
        attempt.revision = normalized.revision ?? attempt.revision
        attempt.startedAtMs = attempt.startedAtMs ?? null
        return
      }
      case NORMALIZED_KIND.ATTEMPT_DELTA: {
        this.acceptDelta({
          attemptId: normalized.attemptId,
          timeMs: normalized.timeMs,
          index: normalized.index,
          revision: normalized.revision,
          chunk: normalized.chunk,
        })
        return
      }
      case NORMALIZED_KIND.ATTEMPT_SETTLE:
      case NORMALIZED_KIND.ATTEMPT_ABANDON: {
        const attempt = this.attempt(normalized.attemptId)
        this.openAttemptIds.delete(normalized.attemptId)
        if (normalized.kind === NORMALIZED_KIND.ATTEMPT_ABANDON) {
          // Transient abandonment: no durable settlement exists for this
          // stream. This is the *only* place `abandoned` may be derived.
          attempt.settlementKind = normalized.settlementKind ?? 'none'
          attempt.surfaceCommitted = false
          attempt.attemptOutcome = normalized.attemptOutcome ?? 'abandoned'
          return
        }
        attempt.settlementSeq = normalized.settlementSeq
        attempt.settlementEventType = normalized.settlementEventType
        attempt.settlementKind = normalized.settlementKind
        attempt.surfaceCommitted = normalized.surfaceCommitted
        // The end frame's eventType is known but its `interrupted` marker is
        // not; `acceptSettlementIdentity` refines this from the durable payload.
        attempt.attemptOutcome = normalized.attemptOutcome
        return
      }
      default:
        this.issue(FRAME_ISSUE.MISSING_ATTEMPT_ID, normalized.reason ?? null)
    }
  }

  /** Accept one client-folded `assistant/live-chunk` row. */
  acceptLiveChunk(entry) {
    const normalized = normalizeLiveChunk(entry)
    if (normalized.kind === NORMALIZED_KIND.IGNORED) {
      this.issue(FRAME_ISSUE.MISSING_ATTEMPT_ID, normalized.reason ?? null)
      return
    }
    this.acceptDelta({
      attemptId: normalized.attemptId,
      timeMs: normalized.timeMs,
      index: null,
      revision: null,
      chunk: normalized.chunk,
      turn: normalized.turn,
      step: normalized.step,
      seq: normalized.seq,
    })
  }

  /**
   * Index-validated delta admission.
   *
   * `index` is the attempt's dense zero-based frame position. When it is
   * present, the accumulator requires it to be exactly the next expected value:
   * a repeat is a duplicated frame and a jump is a gap, and both make the
   * observed stream incomplete. Neither may be folded away, because both change
   * what the curve claims about time spent generating.
   */
  acceptDelta({ attemptId, timeMs, index, revision, chunk, turn = null, step = null, seq = null }) {
    if (typeof attemptId !== 'string' || attemptId === '') {
      this.issue(FRAME_ISSUE.MISSING_ATTEMPT_ID)
      return
    }
    const attempt = this.attempt(attemptId)
    if (turn !== null) attempt.turn = turn
    if (step !== null) attempt.step = step
    if (revision !== null && revision !== undefined) attempt.revision = revision
    attempt.frameCount += 1

    if (!Number.isFinite(timeMs)) {
      attempt.issues.push({ kind: FRAME_ISSUE.MISSING_TIME, index })
      this.issue(FRAME_ISSUE.MISSING_TIME, { attemptId, index })
      return
    }

    if (Number.isFinite(index)) {
      if (index < attempt.nextIndex) {
        attempt.issues.push({ kind: FRAME_ISSUE.DUPLICATE, index, expected: attempt.nextIndex })
        this.issue(FRAME_ISSUE.DUPLICATE, { attemptId, index, expected: attempt.nextIndex })
        return
      }
      if (index > attempt.nextIndex) {
        attempt.issues.push({ kind: FRAME_ISSUE.OUT_OF_ORDER, index, expected: attempt.nextIndex })
        this.issue(FRAME_ISSUE.OUT_OF_ORDER, { attemptId, index, expected: attempt.nextIndex })
      }
      attempt.nextIndex = index + 1
    }

    attempt.acceptedFrameCount += 1
    attempt.chunks.push({ timeMs, chunk, index, revision, seq })
    const sample = sampleFromChunk(timeMs, chunk, this.estimate)
    if (sample !== null) attempt.samples.push({ ...sample, attemptId })
  }

  /** Accept one durable session event (boundaries, tools, settlements). */
  acceptDurableEvent(event) {
    const normalized = normalizeDurableEvent(event)
    switch (normalized.kind) {
      case NORMALIZED_KIND.TURN_START:
        // Idempotent: a replayed durable `turn/start` must not discard samples.
        this.turnStartMs = Number.isFinite(this.turnStartMs) ? this.turnStartMs : normalized.timeMs
        return normalized
      case NORMALIZED_KIND.TURN_END:
        this.turnEndMs = normalized.timeMs
        this.status = normalized.status
        this.statusNote = normalized.note
        this.turnEndPayload = {
          reasonKind: normalized.reasonKind,
          statusKnown: normalized.statusKnown,
          rawReason: normalized.rawReason,
        }
        return normalized
      case NORMALIZED_KIND.STEP_START:
        this.steps.set(normalized.step, { step: normalized.step, startMs: normalized.timeMs, endMs: null })
        return normalized
      case NORMALIZED_KIND.STEP_END: {
        const step = this.steps.get(normalized.step) ?? { step: normalized.step, startMs: null, endMs: null }
        step.endMs = normalized.timeMs
        this.steps.set(normalized.step, step)
        return normalized
      }
      case NORMALIZED_KIND.ATTEMPT_SETTLE: {
        // A durable settlement carries no `attemptId`: DSH's attempt identity is
        // process-local and never enters the durable log. Path A therefore takes
        // a settlement's usage and status from `settlements` (see
        // `acceptSettlementIdentity`) and treats the durable settlement event
        // itself as a boundary only. Creating an attempt here would invent an
        // identity the evidence does not contain.
        return normalized
      }
      case NORMALIZED_KIND.RETRY_SCHEDULED:
        this.retries.push(normalized)
        this.correlateRetries()
        return normalized
      case NORMALIZED_KIND.TOOL_CALL: {
        if (normalized.callId === null) {
          this.issue('tool-call-without-call-id', { seq: normalized.seq })
          return normalized
        }
        const record = this.tools.get(normalized.callId) ?? {
          callId: normalized.callId,
          name: normalized.name,
          startMs: normalized.timeMs,
          endMs: undefined,
          status: 'running',
          parentCallId: undefined,
        }
        record.startMs = Math.min(record.startMs, normalized.timeMs)
        if (normalized.name !== null) record.name = normalized.name
        this.tools.set(normalized.callId, record)
        if (!this.toolOrder.includes(normalized.callId)) this.toolOrder.push(normalized.callId)
        return normalized
      }
      case NORMALIZED_KIND.TOOL_RESULT: {
        if (normalized.callId === null) {
          this.issue('tool-result-without-call-id', { seq: normalized.seq })
          return normalized
        }
        const record = this.tools.get(normalized.callId)
        if (record === undefined) {
          this.issue('unmatched-tool-result', { callId: normalized.callId, seq: normalized.seq })
          return normalized
        }
        record.endMs = normalized.timeMs
        record.status = normalized.status
        return normalized
      }
      default:
        this.ignoredEvents += 1
        return normalized
    }
  }

  /**
   * Fold a durable settlement's *identity and usage* into the live attempts.
   *
   * A settlement arriving through the durable plane is how the client learns an
   * attempt is over. It is not a source of deltas here: path A must not read the
   * compact stream, or the two paths would stop being independent.
   *
   * The three settlement concepts are passed explicitly when the caller has
   * them; otherwise they are re-derived from the settlement event type and the
   * `interrupted` marker, exactly as the durable path derives them.
   */
  acceptSettlementIdentity({
    attemptId,
    turn,
    step,
    usage,
    usageSource,
    settlementKind,
    surfaceCommitted,
    attemptOutcome,
    interrupted,
    settledAtMs,
    seq,
    eventType,
  }) {
    const attempt = this.attempt(attemptId)
    attempt.turn = turn ?? attempt.turn
    attempt.step = step ?? attempt.step
    attempt.settledAtMs = settledAtMs ?? attempt.settledAtMs
    attempt.settlementSeq = seq ?? attempt.settlementSeq
    attempt.settlementEventType = eventType ?? attempt.settlementEventType
    attempt.interrupted = interrupted === true
    const derived = settlementClassification(attempt.settlementEventType, { interrupted: attempt.interrupted })
    attempt.settlementKind = settlementKind ?? derived.settlementKind
    attempt.surfaceCommitted = surfaceCommitted ?? derived.surfaceCommitted
    attempt.attemptOutcome = attemptOutcome ?? derived.attemptOutcome
    if (usage !== null && usage !== undefined) {
      attempt.usage = usage
      attempt.usageSource = usageSource ?? attempt.usageSource
    }
    this.openAttemptIds.delete(attemptId)
    // A retry may have been seen before the settlement identity linked up
    // (batch replay processes durable events first); re-run the correlation.
    this.correlateRetries()
    return attempt
  }

  /**
   * Apply scheduled durable retries to the attempts they prove. Idempotent;
   * called again whenever a retry or a settlement identity lands.
   */
  correlateRetries() {
    if (this.retries.length === 0) return 0
    return applyRetryOutcomes(this.attemptList().filter(Boolean), this.retries)
  }

  /** Attempts in the order their first frame arrived. */
  attemptList() {
    return this.attemptOrder.map(attemptId => this.attempts.get(attemptId))
  }

  toolList() {
    return this.toolOrder.map(callId => this.tools.get(callId))
  }

  /** Whether the live plane is complete enough to be called exact. */
  liveQuality() {
    if (this.issues.length > 0) return MetricQuality.ESTIMATED
    if (this.attemptList().length === 0) return MetricQuality.UNAVAILABLE
    return MetricQuality.ESTIMATED
  }
}

/**
 * Path A entry point: replay a recorded transient plane plus the durable
 * boundaries, and return the normalized attempts and tools.
 *
 * `settlements` carries only identity and usage, never streams — see
 * `acceptSettlementIdentity`.
 */
function accumulateLive({
  sessionId,
  frames = [],
  liveChunks = [],
  durableEvents = [],
  settlements = [],
  estimate = heuristicTokenWeight,
}) {
  const accumulator = new LiveTurnAccumulator({ sessionId, estimate })
  for (const event of durableEvents) accumulator.acceptDurableEvent(event)
  for (const frame of frames) accumulator.acceptStreamFrame(frame)
  for (const row of liveChunks) accumulator.acceptLiveChunk(row)
  for (const settlement of settlements) accumulator.acceptSettlementIdentity(settlement)
  // Batch replay processes durable events before settlement identities exist;
  // a retry seen in that order could not yet be correlated. Re-run now that
  // every identity has been folded in.
  accumulator.correlateRetries()
  return accumulator
}



;Object.assign(__exports, { settlementClassification, FRAME_ISSUE, LiveTurnAccumulator, accumulateLive })
			},
			"src/dsh/durable-path.js": function (__exports) {
/**
 * Durable (settlement) reconstruction path — path B.
 *
 * Path B reads only what survives a reload: the durable session log. It takes
 * turn and step boundaries, tool call/result pairs, and, for every attempt, the
 * compact `AssistantStreamRecord[]` embedded in its settlement, which it
 * decodes with the strict decoder. It never consults a transient frame.
 *
 * The point of path B is that a completed turn's card must be reconstructible
 * from the durable log alone. If the two paths disagree on a settled turn, the
 * live path is the one that is wrong, because only the durable log is replayable
 * evidence.
 */

const { isTokenDelta, phaseCutsFromChunks } = __req("src/core/delta-accounting.js")
const { heuristicTokenWeight, sampleFromChunk } = __req("src/core/token-allocation.js")
const { TEMPORAL_EVIDENCE_AUTHORITY } = __req("src/core/types.js")
const { applyRetryOutcomes, settlementClassification, toolResultOutcome, turnEndStatus } = __req("src/dsh/adapter.js")
const { decodeStreamRecords } = __req("src/dsh/stream-decoder.js")

/**
 * Reconstruct a turn from durable events.
 *
 * @param {{
 *   sessionId: string,
 *   turn: number,
 *   events: readonly object[],
 *   estimate?: Function,
 * }} input
 */
function reconstructFromDurable({ sessionId, turn, events = [], estimate }) {
  const ordered = [...events]
    .filter(event => event && typeof event === 'object' && typeof event.type === 'string')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

  const result = {
    sessionId: sessionId ?? null,
    turn: turn ?? null,
    turnStartMs: null,
    turnEndMs: null,
    status: null,
    statusNote: null,
    statusKnown: null,
    endReason: null,
    attempts: [],
    tools: [],
    steps: new Map(),
    issues: [],
    ignoredEventCount: 0,
    /** Scheduled durable retries (`llm/retry`), for attempt-outcome correlation. */
    retries: [],
    /** Raw evidence retained for auditing: the settlements exactly as recorded. */
    settlements: [],
  }

  const toolByCallId = new Map()
  const toolOrder = []

  for (const event of ordered) {
    const data = event.data ?? {}
    if (data.turn !== undefined && data.turn !== turn) continue
    switch (event.type) {
      case 'turn/start':
        result.turnStartMs = result.turnStartMs === null ? event.time : Math.min(result.turnStartMs, event.time)
        break
      case 'turn/end': {
        const mapped = turnEndStatus(data.reason)
        result.turnEndMs = event.time
        result.status = mapped.status
        result.statusNote = mapped.note
        result.statusKnown = mapped.known
        result.endReason = data.reason ?? null
        break
      }
      case 'step/start': {
        const step = result.steps.get(data.step) ?? { step: data.step, startMs: null, endMs: null }
        step.startMs = step.startMs === null ? event.time : Math.min(step.startMs, event.time)
        result.steps.set(data.step, step)
        break
      }
      case 'step/end': {
        const step = result.steps.get(data.step) ?? { step: data.step, startMs: null, endMs: null }
        step.endMs = event.time
        result.steps.set(data.step, step)
        break
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const decoded = decodeStreamRecords(data.stream)
        const issues = decoded.issues.map(issue => ({ ...issue, where: 'durable-stream', seq: event.seq }))
        result.issues.push(...issues)
        const durableUsage = data.usage && typeof data.usage === 'object' && Number.isFinite(data.usage.outputTokens)
          ? data.usage
          : null
        const inStreamUsage = durableUsage === null ? lastUsageChunk(decoded) : null
        const attempt = {
          attemptId: null,
          turn: data.turn ?? turn,
          step: data.step ?? null,
          ...settlementClassification(event.type, data),
          samples: [],
          /**
           * The stream's non-magnitude phase boundaries, recovered from the same
           * decode as the samples (`phaseCutsFromChunks`). They are evidence about
           * *where a phase stopped*, not magnitude, so they travel beside the
           * samples and never inside them — and they are what makes a reconstructed
           * card close an episode the live meter closed.
           */
          phaseCuts: phaseCutsFromChunks(decoded.chunks),
          chunks: decoded.chunks,
          decoded,
          usage: durableUsage ?? inStreamUsage,
          usageSource: durableUsage !== null ? 'assistant-settlement' : (inStreamUsage !== null ? 'in-stream-usage-chunk' : null),
          startedAtMs: null,
          settledAtMs: event.time,
          settlementSeq: event.seq,
          settlementEventType: event.type,
          interrupted: data.interrupted === true,
          issues,
          streamQuality: decoded.quality,
          /**
           * The reconstruction plane's temporal evidence *is* this decode, so the
           * authority is the decode's own completeness and nothing else. A
           * settlement whose stream lost a record still yields an attempt — the
           * remaining deltas are real evidence — but a partial decode is not
           * authoritative, and the settled card must read `estimated` rather than
           * `reconstructed` for it (`src/core/types.js`).
           */
          temporalEvidenceAuthority: decoded.complete === true
            ? TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE
            : TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE,
        }
        if (estimate !== undefined) {
          attempt.samples = samplesFromChunks(decoded.chunks, estimate)
        } else {
          attempt.samples = samplesFromChunks(decoded.chunks)
        }
        result.attempts.push(attempt)
        result.settlements.push({
          seq: event.seq,
          time: event.time,
          type: event.type,
          turn: data.turn,
          step: data.step,
          usage: durableUsage,
          interrupted: data.interrupted === true,
          recordCount: decoded.recordCount,
          deltaCount: decoded.deltaCount,
          streamQuality: decoded.quality,
        })
        break
      }
      case 'llm/retry':
        result.retries.push({
          kind: 'retry-scheduled',
          seq: event.seq,
          timeMs: event.time,
          turn: data.turn,
          step: data.step,
          retryId: typeof data.retryId === 'string' ? data.retryId : null,
          retry: Number.isFinite(data.retry) ? data.retry : null,
        })
        break
      case 'tool/call': {
        if (typeof data.callId !== 'string') {
          result.issues.push({ kind: 'tool-call-without-call-id', seq: event.seq })
          break
        }
        const record = toolByCallId.get(data.callId) ?? {
          callId: data.callId,
          name: data.name ?? null,
          startMs: event.time,
          status: 'running',
          argumentsRaw: data.arguments ?? null,
          step: data.step ?? null,
        }
        record.startMs = Math.min(record.startMs, event.time)
        if (typeof data.name === 'string') record.name = data.name
        toolByCallId.set(data.callId, record)
        if (!toolOrder.includes(data.callId)) toolOrder.push(data.callId)
        break
      }
      case 'tool/result': {
        /**
         * The call identity is read through the adapter's single contract site,
         * never re-derived here. A second copy of this read is exactly how the
         * 0.1.7 migration was nearly left half-done: the same
         * `content[0].toolCallId` expression existed in this file and in
         * `adapter.js`, and fixing only one of them would have left durable
         * reconstruction silently unable to pair any 0.1.7 tool result while the
         * live path paired all of them.
         */
        const outcome = toolResultOutcome(data)
        const callId = outcome.callId
        if (callId === null) {
          result.issues.push({ kind: 'tool-result-without-call-id', seq: event.seq, callIdSource: outcome.callIdSource })
          break
        }
        const record = toolByCallId.get(callId)
        if (record === undefined) {
          result.issues.push({ kind: 'unmatched-tool-result', seq: event.seq, callId })
          break
        }
        record.endMs = event.time
        record.status = outcome.status
        record.errorName = outcome.errorName
        break
      }
      default:
        result.ignoredEventCount += 1
    }
  }

  result.tools = toolOrder.map(callId => toolByCallId.get(callId))
  for (const record of result.tools) {
    if (record.endMs === undefined) {
      result.issues.push({ kind: 'unmatched-tool-call', callId: record.callId, name: record.name })
    }
  }

  // Attempt order is settlement order, which is step order for a normal turn.
  result.attempts.sort((a, b) => (a.settlementSeq ?? 0) - (b.settlementSeq ?? 0))
  // An `assistant/attempt` outcome is `unknown` until a durable `llm/retry`
  // proves it was retried; the correlation runs after every settlement is in
  // place so ordering inside the log cannot hide the pairing.
  applyRetryOutcomes(result.attempts, result.retries)
  return result
}

function lastUsageChunk(decoded) {
  for (let index = decoded.chunks.length - 1; index >= 0; index -= 1) {
    const chunk = decoded.chunks[index].chunk
    if (chunk?.type === 'usage' && chunk.usage && Number.isFinite(chunk.usage.outputTokens)) return chunk.usage
  }
  return null
}

function samplesFromChunks(chunks, estimate = heuristicTokenWeight) {
  const samples = []
  for (const entry of chunks) {
    const sample = sampleFromChunk(entry.timeMs, entry.chunk, estimate)
    if (sample !== null) samples.push(sample)
  }
  return samples
}

/**
 * Settlement chronology for one turn, in durable order.
 *
 * This is the raw material of the generation-tail measurement: it pairs the
 * last non-empty model-producing delta of an attempt with the wall-clock time
 * at which DSH committed that attempt's settlement.
 */
function settlementChronology(turnRecord) {
  return turnRecord.attempts.map(attempt => ({
    settlementSeq: attempt.settlementSeq,
    settlementEventType: attempt.settlementEventType,
    settlementTimeMs: attempt.settledAtMs,
    turn: attempt.turn,
    step: attempt.step,
    usage: attempt.usage,
    interrupted: attempt.interrupted,
    streamQuality: attempt.streamQuality,
    lastDeltaTimeMs: lastGeneratedDeltaTime(attempt.chunks),
    firstDeltaTimeMs: firstGeneratedDeltaTime(attempt.chunks),
    deltaCount: attempt.decoded?.deltaCount ?? 0,
  }))
}

function lastGeneratedDeltaTime(chunks) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (isTokenDelta(chunks[index].chunk)) return chunks[index].timeMs
  }
  return null
}

function firstGeneratedDeltaTime(chunks) {
  for (const entry of chunks) {
    if (isTokenDelta(entry.chunk)) return entry.timeMs
  }
  return null
}

;Object.assign(__exports, { reconstructFromDurable, settlementChronology })
			},
			"src/dsh/index.js": function (__exports) {
/**
 * DSH adapter layer.
 *
 * The single responsibility of this directory is to translate **verified DSH
 * 0.2.0-rc.2 raw evidence** into this project's normalized engine events. No
 * other layer may know about DSH field names:
 *
 *   src/core   pure statistics, zero `@deepseek-ai/*` imports
 *   src/dsh    raw evidence  ->  normalized events   (this directory)
 *   src/host   in-memory store over normalized events
 *   src/client presentation only
 *
 * ## Compatibility baseline (moved to 0.2.0-rc.2 in Phase 9.3)
 *
 * The target runtime is `@deepseek-ai/dsh` **0.2.0-rc.2**, public reference
 * commit `639ed015397290b3745d163aafe02ffee4aa3f84`, as installed locally at
 * `%APPDATA%/npm/node_modules/@deepseek-ai/dsh`. The 0.1.7-rc.2 line was the
 * target from Phase 7D through Phase 9.2; the 0.1.5-rc.2 line is **not** the
 * contract any more.
 *
 * Phase 9.3 re-audited every declaration this directory reads against
 * 0.2.0-rc.2 and found them unchanged from 0.1.7-rc.2, so no adapter code
 * moved. The "0.1.7-rc.2" references that remain in the modules below are the
 * dates of the audits that established each shape — recorded evidence that
 * occurred on that version — not stale targets. The comparison lives in
 * `docs/DSH_API_NOTES.md` §14.
 *
 * Evidence locations for every shape handled here are recorded in
 * `docs/IMPLEMENTATION_LOG.md`.
 */

const { DSH_RAW_KIND } = __req("src/dsh/raw.js")
const { classifyRawEntry } = __req("src/dsh/raw.js")
const { isAssistantStreamFrame } = __req("src/dsh/raw.js")
const { isDurableSessionEventEntry } = __req("src/dsh/raw.js")
const { isTransientLiveChunkEntry } = __req("src/dsh/raw.js")
const { sessionKeyOf } = __req("src/dsh/raw.js")

const { DECODE_ISSUE } = __req("src/dsh/stream-decoder.js")
const { RECORD_KIND } = __req("src/dsh/stream-decoder.js")
const { SETTLEMENT_EVENT_TYPES } = __req("src/dsh/stream-decoder.js")
const { decodeQuality } = __req("src/dsh/stream-decoder.js")
const { decodeStreamRecords } = __req("src/dsh/stream-decoder.js")
const { expandAssistantStream } = __req("src/dsh/stream-decoder.js")
const { expandAssistantStreamRaw } = __req("src/dsh/stream-decoder.js")
const { firstTokenTimeOf } = __req("src/dsh/stream-decoder.js")

const { ATTEMPT_OUTCOME } = __req("src/dsh/adapter.js")
const { NORMALIZED_KIND } = __req("src/dsh/adapter.js")
const { SETTLEMENT_KIND } = __req("src/dsh/adapter.js")
const { TOOL_RESULT_SHAPE } = __req("src/dsh/adapter.js")
const { applyRetryOutcomes } = __req("src/dsh/adapter.js")
const { attemptEvidenceQuality } = __req("src/dsh/adapter.js")
const { attemptFromDecoded } = __req("src/dsh/adapter.js")
const { normalizeDurableEvent } = __req("src/dsh/adapter.js")
const { normalizeLiveChunk } = __req("src/dsh/adapter.js")
const { normalizeStreamFrame } = __req("src/dsh/adapter.js")
const { settlementClassification } = __req("src/dsh/adapter.js")
const { transientEndClassification } = __req("src/dsh/adapter.js")
const { turnEndStatus } = __req("src/dsh/adapter.js")

const { FRAME_ISSUE } = __req("src/dsh/live-path.js")
const { LiveTurnAccumulator } = __req("src/dsh/live-path.js")
const { accumulateLive } = __req("src/dsh/live-path.js")

const { reconstructFromDurable } = __req("src/dsh/durable-path.js")
const { settlementChronology } = __req("src/dsh/durable-path.js")

;Object.assign(__exports, { DSH_RAW_KIND, classifyRawEntry, isAssistantStreamFrame, isDurableSessionEventEntry, isTransientLiveChunkEntry, sessionKeyOf, DECODE_ISSUE, RECORD_KIND, SETTLEMENT_EVENT_TYPES, decodeQuality, decodeStreamRecords, expandAssistantStream, expandAssistantStreamRaw, firstTokenTimeOf, ATTEMPT_OUTCOME, NORMALIZED_KIND, SETTLEMENT_KIND, TOOL_RESULT_SHAPE, applyRetryOutcomes, attemptEvidenceQuality, attemptFromDecoded, normalizeDurableEvent, normalizeLiveChunk, normalizeStreamFrame, settlementClassification, transientEndClassification, turnEndStatus, FRAME_ISSUE, LiveTurnAccumulator, accumulateLive, reconstructFromDurable, settlementChronology })
			},
			"src/dsh/client-feed.js": function (__exports) {
/**
 * Browser event-window feed: `SessionEventWindow` -> normalized engine events.
 *
 * This is the Phase 3 seam chosen in Phase 0: the Client
 * `ctx.sessions.binding(id).eventSource` publishes every window mutation
 * synchronously, and one window carries **both** evidence planes — durable
 * `SessionEvent` rows (`type: 'event'`) and client-folded transient
 * `assistant/live-chunk` rows (`type: 'transient'`). No host telemetry channel,
 * no session projection, no synthetic durable events, no DOM scraping.
 *
 * The feed is the only module that understands the window wire shape
 * (`change.kind`, entry discriminants). Everything it emits is a normalized
 * event in this project's vocabulary, ready for `TurnTelemetryStore` and the
 * live UI state machine. It holds no timers, no statistics and no React.
 *
 * Window-change semantics (verified at
 * `dsh-api-session-controller/lib/types/client/contract/events.d.ts:41-61`):
 *
 *   replace          the complete contiguous window was swapped (initial
 *                    snapshot, reload rebaseline) — reset and replay it
 *   append           new tail entries arrived — feed exactly those
 *   prepend          older history was paged in — irrelevant to the live tail,
 *                    and ingesting it after newer events would replay stale
 *                    turns out of order, so it is deliberately ignored
 *   settle-assistant attemptId, with or without a durable settlement entry
 *
 * ## Retained durable evidence, and why the feed holds it
 *
 * Every durable row the feed accepts is also retained, keyed by the turn it names,
 * for the lifetime of the current window generation. The retention is not a second
 * interpretation of the wire — the rows are kept exactly as they arrived, with their
 * own `seq` — and it exists for one consumer:
 *
 *   a `turn/end` published for a turn whose record this client never opened (the
 *   window is a tail; the opening `turn/start` may be outside it) must be able to
 *   reconstruct the turn from the durable facts that *are* in the window, rather
 *   than open an empty record and close it again.
 *
 * The feed is where this belongs because it is the only module that sees the wire
 * shape, and because the alternative — having the controller keep every raw row it
 * has ever routed — would put window bookkeeping and metric bookkeeping in one
 * place. Consumers ask for a turn's rows through `turnEvents(turn)` and hand them to
 * the canonical durable reconstruction; nothing is decoded here.
 *
 * Three properties keep the retention from becoming a leak or a contamination
 * source. It is bounded per generation, evicting the least recently updated turn
 * first. It is **cleared** by `rebaseline()`, because a new window is a new
 * generation and reconstructing one generation's settlement together with another's
 * `turn/end` would be a metric assembled from two windows. And it is per
 * `SessionEventFeed`, so a second session's feed cannot reach it.
 *
 * Two different things are bounded here, and only one of them is the retention. The
 * rows are bounded *by turns*: eviction releases the bytes of the least recently
 * updated turn. The **durable seq identity is generation-wide**: a `seq` that has been
 * admitted can never be new again until `rebaseline()`, even after the row carrying
 * it was evicted. Eviction therefore forgets a row's bytes but not the fact that its
 * `seq` was already seen, and `rebaseline()` is the only boundary that clears both.
 * Keeping the two in one structure — a pool-local `seq` set that eviction also
 * trimmed — is what made a duplicate row able to re-enter retention; see
 * `admitDurable`.
 *
 * ## `settle-assistant` is ambiguous in DSH 0.1.7-rc.2, and this is where it is resolved
 *
 * The published contract calls the entry optional and the 0.1.5 reading treated
 * "entry absent" as synonym for "attempt abandoned". The local 0.1.7 install
 * disproves that reading. `ClientAssistantStream` publishes the same bare
 * `settleAssistant(attemptId)` from **two** different situations
 * (`dsh-api-session-controller/lib/client.js:1445-1539`, `:617-648`):
 *
 *   normal successful retirement
 *     the attempt's durable `assistant/message` is published (non-interrupted),
 *     a `retainedAttempt` is recorded, and when the matching `step/end` is
 *     published the fold returns `{type:'publish', entry, retireAttemptId}` —
 *     the session then appends the step end **and** calls
 *     `eventSource.settleAssistant(attemptId)` with no entry, purely to discard
 *     transient rows that a durable node already supersedes.
 *
 *   true abandonment
 *     the attempt's `end` frame carries `outcome.kind === 'abandoned'` and no
 *     settlement is pending; the fold returns `{type:'abandonment', attemptId}`
 *     and the session calls the same bare `settleAssistant(attemptId)`.
 *
 * `entry === undefined` therefore proves nothing on its own. What distinguishes
 * them is state the feed can hold from evidence it has already seen: whether a
 * durable, non-interrupted settlement has already been observed for this
 * attempt. A bare settle for an attempt that already has one is **transient
 * retirement only** and emits no second attempt outcome; a bare settle for an
 * attempt that has none is the abandonment path.
 */

const { NORMALIZED_KIND, normalizeDurableEvent, normalizeLiveChunk } = __req("src/dsh/adapter.js")

/** Feed-level diagnostics; every entry names why evidence could not be used. */
const FEED_ISSUE = Object.freeze({
  MALFORMED_WINDOW: 'malformed-window',
  UNKNOWN_CHANGE: 'unknown-window-change',
  MISSING_CHANGE_ENTRIES: 'missing-change-entries',
  MALFORMED_ENTRY: 'malformed-entry',
  DUPLICATE_TRANSIENT: 'duplicate-transient-row',
  DUPLICATE_DURABLE: 'duplicate-durable-event',
  UNMATCHED_SETTLEMENT: 'settlement-without-attempt-id',
  /**
   * A transient row naming a turn this client has already finished with. The
   * row is not delivered — re-opening a settled turn would resurrect a closed
   * record and a card that has already been built — but it is recorded, because
   * a late frame is a real wire behaviour and silence would hide it.
   */
  LATE_TURN_ROW: 'transient-row-of-a-finished-turn',
  /**
   * A durable row of a turn this client has already closed. The same rule as
   * `LATE_TURN_ROW`, on the durable plane: `turn/end` is terminal for live
   * presentation, so a trailing tool boundary cannot re-open the turn.
   */
  LATE_TURN_EVENT: 'durable-event-of-a-finished-turn',
  /**
   * A bare `settle-assistant` naming an attempt the feed never saw open, with no
   * durable settlement waiting to be retired. Read as abandonment, and recorded
   * because the identity could not be resolved from held evidence.
   */
  UNRESOLVED_SETTLEMENT: 'bare-settlement-without-known-attempt',
})

/** The key under which an attempt's `(turn, step)` is registered. */
function stepKey(turn, step) {
  return Number.isFinite(turn) && Number.isFinite(step) ? `${turn}:${step}` : null
}

/**
 * How many turns' raw durable rows one window generation retains.
 *
 * The bound is a memory budget, not a semantic limit. It is expressed in turns
 * rather than in rows because the reconstruction the retention serves is
 * turn-scoped, and a turn's row count follows its model traffic rather than any
 * constant.
 *
 * Eviction is **least-recently-updated**: when a new turn would exceed the bound,
 * the retained turn with the oldest last arrival is released, and recording another
 * durable row of a turn refreshes that turn's retention position. That is the
 * policy `DurableEvidencePool.record` implements, and it is chosen for the
 * consumer rather than for symmetry with a queue: the turn a `turn/end` miss can
 * ask about is a turn that was producing evidence moments earlier, so it is the
 * most recently refreshed entry and is never the eviction candidate. Under
 * first-seen FIFO a long turn that published its opening row 33 turns ago would be
 * released while it was still running — destroying exactly the evidence the
 * retention exists to keep.
 */
const MAX_RETAINED_TURNS = 32

/**
 * Raw durable rows keyed by turn, in arrival order, bounded by turn count.
 *
 * The map's iteration order is *least recently updated first*: a turn's position
 * is refreshed every time another of its rows arrives, so `keys().next()` is the
 * eviction candidate and becomes the released turn after a single `delete`. The
 * per-turn row array, by contrast, is pure arrival order and is never reordered —
 * the two orders are different things and only the first is a retention policy.
 *
 * The refresh is deliberate rather than incidental. Retention exists so a
 * `turn/end` whose opening row is outside the live tail can still be reconstructed,
 * and that turn is by construction the one still producing durable rows; refreshing
 * on every arrival is what keeps it resident, and is what makes "the oldest turn is
 * evicted first" *false* of this structure in the first-seen sense.
 *
 * The structure holds **evidence bytes only**. Which durable identities the
 * generation has seen is the feed's question, not this pool's: a released turn's rows
 * are gone from here and their `seq`s remain refused by the caller, so eviction
 * bounds memory without re-opening an identity. `record()` is therefore called only
 * for a row the caller has already admitted as new, and it holds no dedupe state of
 * its own.
 */
class DurableEvidencePool {
  constructor(limit = MAX_RETAINED_TURNS) {
    this.limit = limit
    /** @type {Map<number, object[]>} turn -> raw `SessionEvent` rows */
    this.byTurn = new Map()
    /**
     * Unique durable rows admitted into this pool during the current generation.
     *
     * This is a **cumulative ingest counter**, not a current occupancy figure: it
     * grows by one for every newly retained row and is never decremented when a turn
     * is evicted, then resets to zero with the pool at a rebaseline. It is named for
     * what it measures — rows retained at ingest — and any consumer that needs the
     * live occupancy must derive it (`byTurn.size` for turns, or a sum over the
     * per-turn arrays for rows) rather than read this. Decrementing it here was
     * rejected as the more expensive lie: an eviction would have to walk the released
     * turn's rows to keep a diagnostic honest.
     */
    this.eventCount = 0
  }

  /**
   * Retain one raw durable row. Returns whether it was retained.
   *
   * A row naming no finite turn is not retained: the map is keyed by turn identity,
   * and a row that cannot name one cannot be retrieved by the consumer this exists
   * for. The row is still processed normally — retention is an addition to
   * ingestion, never a condition on it.
   *
   * The caller has already refused a `seq` this generation admitted, so a row that
   * reaches here is new by construction and recording it is an arrival of new
   * evidence: it refreshes the turn's position in the map's iteration order, which
   * is what makes eviction least-recently-updated rather than first-seen.
   */
  record(event) {
    if (event === null || typeof event !== 'object') return false
    if (!Number.isFinite(event.seq)) return false
    const turn = event.data?.turn
    if (!Number.isFinite(turn)) return false
    const rows = this.byTurn.get(turn)
    if (rows === undefined) this.byTurn.set(turn, [event])
    else {
      // Delete before re-inserting, which is precisely what moves the turn to the
      // tail of the map's iteration order and makes eviction least-recently-updated
      // rather than first-seen. The row array itself keeps arrival order.
      this.byTurn.delete(turn)
      rows.push(event)
      this.byTurn.set(turn, rows)
    }
    this.eventCount += 1
    this.evict()
    return true
  }

  /**
   * Release the least recently updated turns until the bound holds again.
   *
   * One `delete` per released turn, and no walk over the turn's rows: the rows of a
   * released turn are the only record of it this structure keeps, so dropping the
   * map entry is the whole eviction. Nothing else is derived from them — the durable
   * identity a released row carried stays with the caller, which is what stops the
   * same `seq` from being re-admitted later in the generation.
   */
  evict() {
    if (this.byTurn.size <= this.limit) return
    while (this.byTurn.size > this.limit) {
      const oldest = this.byTurn.keys().next()
      if (oldest.done === true) return
      this.byTurn.delete(oldest.value)
    }
  }

  /** @returns {object[]} the turn's retained rows, in arrival order; `[]` when none. */
  eventsFor(turn) {
    if (!Number.isFinite(turn)) return []
    return this.byTurn.get(turn) ?? []
  }

  clear() {
    this.byTurn.clear()
    this.eventCount = 0
  }
}

class SessionEventFeed {
  /**
   * @param {{
   *   sessionId: string,
   *   onEvent: (event: object) => void,
   *   onIssue?: (issue: {kind: string, detail?: unknown}) => void,
   * }} options
   */
  constructor({ sessionId, onEvent, onIssue = () => {} }) {
    this.sessionId = sessionId ?? null
    this.onEvent = onEvent
    this.onIssue = onIssue
    /** Whether the initial full window pass has happened. */
    this.initialized = false
    this.revision = -1
    /**
     * Durable sequence numbers admitted in the current window generation.
     *
     * Durable seq identity is **generation-wide**: once a `seq` has been admitted it
     * can never be new again until `rebaseline()`, whether or not its row is still
     * retained. This set is therefore the only dedupe state the durable plane has, and
     * retention consults it rather than keeping a second set of its own — two sets with
     * different release rules is exactly how a rejected row used to keep mutating
     * retention (see the module docstring).
     */
    this.durableSeqs = new Set()
    /** Transient row dedupe keyed by the fold's event object identity. */
    this.transientRows = new WeakSet()
    /** The transient attempt that has not received a durable settlement yet. */
    this.openAttemptId = null
    /** Open turn number, or `null`. */
    this.openTurn = null
    /**
     * Turns this feed has seen close (`turn/end`). A late transient row of any
     * of them must not re-open the turn: its record has already been settled and
     * its evidence handed to the completed card. Keyed by identity rather than a
     * single "last settled" number, because a settlement can be followed by rows
     * of an older turn.
     */
    this.settledTurns = new Set()
    /**
     * The highest turn number observed so far, or `null`. Turns are ordered
     * within a session, so a transient row below it is late evidence of a turn
     * the feed has already moved past (`adoptTurn`).
     */
    this.highestTurn = null
    /**
     * Attempts whose transient rows arrived, with the `(turn, step)` those rows
     * named. This is the only place an `attemptId` — a process-local identity
     * that never enters the durable log — can be tied to a durable coordinate.
     */
    this.attemptSteps = new Map()
    /**
     * Attempts that received a durable settlement **directly** — the
     * `settle-assistant` route that names the attempt and carries its entry
     * (interrupted messages, `assistant/attempt`). A bare settle for one of
     * these can only be a retirement.
     */
    this.settledAttemptIds = new Set()
    /**
     * Durable, non-interrupted `assistant/message` settlements published but not
     * yet retired, oldest first, keyed by their durable `(turn, step)`.
     *
     * DSH's fold retains exactly one such settlement per step and releases it
     * when that step's `step/end` is published, calling the bare
     * `settleAssistant(attemptId)` at that moment. The queue is therefore both
     * the proof that a retirement is happening and the budget that stops one
     * settlement from excusing a *later* attempt in the same step.
     */
    this.pendingSettlements = []
    /**
     * Raw durable rows of the current window generation, by turn. See
     * `DurableEvidencePool` and the module docstring: this is what lets a
     * `turn/end` with no open record be reconstructed from the turn's own durable
     * evidence instead of closing an empty record.
     */
    this.durableEvidence = new DurableEvidencePool()
    this.issues = []
    /** Counts of deliberately skipped window changes, for diagnostics. */
    this.ignoredPrepends = 0
    this.eventCount = 0
    /** Debug-only counters; `controller.diagnostics()` reads them. */
    this.counters = {
      rawDurableEvents: 0,
      rawTransientRows: 0,
      rawToolCalls: 0,
      rawToolResults: 0,
      matchedToolResults: 0,
      unmatchedToolResults: 0,
      malformedToolResults: 0,
      rawTurnEndSeen: 0,
      normalizedTurnEndSeen: 0,
      /**
       * Cumulative distinct durable rows admitted into reconstruction retention during
       * this window generation. It counts retention *events*, not rows currently
       * held: eviction does not decrement it, and `rebaseline()` resets it to zero
       * with the pool. For current occupancy use `retainedTurnCount()` (turns) — see
       * `DurableEvidencePool.eventCount` for why no live row count is maintained.
       */
      retainedDurableEvents: 0,
      bareSettleSeen: 0,
      settlementsWithEntry: 0,
      retirementsResolved: 0,
      abandonmentsResolved: 0,
      lateTurnRows: 0,
      lateTurnEvents: 0,
    }
  }

  issue(kind, detail) {
    const record = detail === undefined ? { kind } : { kind, detail }
    this.issues.push(record)
    this.onIssue(record)
  }

  emit(event) {
    this.eventCount += 1
    this.onEvent(event)
  }

  /** Consume one published window snapshot (idempotent per revision). */
  applyWindow(window) {
    if (window === null || typeof window !== 'object' || !Array.isArray(window.entries)) {
      this.issue(FEED_ISSUE.MALFORMED_WINDOW)
      return
    }
    const change = window.change && typeof window.change === 'object' ? window.change : { kind: 'replace' }

    if (!this.initialized) {
      this.initialized = true
      this.revision = Number.isFinite(window.revision) ? window.revision : -1
      this.processEntries(window.entries)
      return
    }

    if (Number.isFinite(window.revision) && window.revision <= this.revision) return
    if (Number.isFinite(window.revision)) this.revision = window.revision

    switch (change.kind) {
      case 'append':
        if (!Array.isArray(change.entries)) {
          this.issue(FEED_ISSUE.MISSING_CHANGE_ENTRIES, 'append')
          return
        }
        this.processEntries(change.entries)
        return
      case 'prepend':
        // Older history: outside the live tail and out of chronological order
        // relative to what has already been consumed. Counted, never guessed at.
        this.ignoredPrepends += 1
        return
      case 'replace':
        this.rebaseline()
        this.processEntries(window.entries)
        return
      case 'settle-assistant':
        this.applySettlement(change)
        return
      default:
        this.issue(FEED_ISSUE.UNKNOWN_CHANGE, change.kind)
    }
  }

  /**
   * A `replace` is a rebaseline (reload, reconnect, window swap). All previous
   * dedupe state belongs to the superseded window generation; replaying the new
   * window from scratch is what keeps the live state consistent with the rows
   * the fold actually publishes now.
   */
  rebaseline() {
    this.durableSeqs = new Set()
    this.transientRows = new WeakSet()
    this.openAttemptId = null
    this.openTurn = null
    /**
     * The turn-adoption guards are generation state too. A new window is a new
     * set of rows: a turn this client had already closed may legitimately be
     * the open turn of the replayed window, and a window may begin at any turn.
     * Keeping the previous generation's `highestTurn` would refuse the adoption
     * the reload just made necessary.
     */
    this.settledTurns = new Set()
    this.highestTurn = null
    this.attemptSteps = new Map()
    this.settledAttemptIds = new Set()
    this.pendingSettlements = []
    /**
     * A `replace` is a new window generation, so the retained durable rows of the
     * superseded one are dropped with the rest of the generation state. The
     * boundary is explicit rather than incidental: sequence numbers are not
     * guaranteed to be disjoint across generations, and reconstructing one
     * generation's settlement together with another's `turn/end` would produce a
     * turn whose metrics were assembled from two windows.
     */
    this.durableEvidence.clear()
    this.counters.retainedDurableEvents = 0
    this.emit({ kind: 'window-rebaseline', timeMs: null })
  }

  /**
   * Admit one raw durable row's identity to this generation, or refuse it as already
   * seen.
   *
   * This is the single gate every durable entry route passes — an appended window entry
   * and the entry carried by a `settle-assistant` change alike — and its whole substance
   * is the order of its two halves. The `seq` is recorded as seen **at the moment of
   * admission**, before retention is attempted and before normalization, so a row that
   * is refused for either reason is refused for good. Recording it later would leave a
   * row that ingested nothing but was counted as seen anyway (or the reverse), and
   * leaving identity to the retention pool would let eviction re-open it: the pool
   * releases rows to bound memory, which is not the same thing as forgetting that their
   * `seq`s were already admitted.
   *
   * Because admission precedes retention, a refused duplicate cannot reach the retention
   * pool at all. That is the contract, not an incidental consequence of the pool
   * refusing it too: a duplicate must not count as activity of its turn, must not
   * refresh that turn's retention position, and must not change which turn a later
   * admission evicts.
   *
   * @returns {boolean} whether the row is new to this generation
   */
  admitDurable(event) {
    if (event === null || typeof event !== 'object' || !Number.isFinite(event.seq)) return false
    if (this.durableSeqs.has(event.seq)) return false
    this.durableSeqs.add(event.seq)
    return true
  }

  /**
   * Retain one raw durable row as reconstruction evidence for its turn.
   *
   * Called after `admitDurable` on **both** routes by which a durable row enters this
   * feed — an appended window entry and the entry carried by a `settle-assistant`
   * change — because DSH delivers a settlement by both, and a retention path that
   * covered only one of them would silently lose the attempts that travelled the other.
   *
   * The row is stored exactly as it arrived: same object, same `seq`, no normalization
   * and no decoding. Duplicate-free retention is not restated here; it follows from the
   * caller having admitted the `seq`, and the import of that ordering is that an evicted
   * row's identity survives its own eviction.
   *
   * `counters.retainedDurableEvents` is republished from the pool's cumulative counter,
   * which is what keeps it "distinct durable rows admitted into retention" rather than
   * "distinct seqs that arrived": a row naming no finite turn is admitted as an identity
   * but cannot be retained, so it is not one of them. The counter is not the rows the
   * pool currently holds either — eviction does not decrement it.
   *
   * @returns {boolean} whether the row was retained
   */
  retainDurable(event) {
    const retained = this.durableEvidence.record(event)
    if (retained) this.counters.retainedDurableEvents = this.durableEvidence.eventCount
    return retained
  }

  /**
   * A turn's retained durable rows, in arrival order.
   *
   * The rows are the raw `SessionEvent` objects; the caller decodes them through the
   * project's canonical durable reconstruction. An unknown or evicted turn yields an
   * empty array — which is the honest answer, and is what makes a `turn/end` with no
   * other evidence reconstruct to an empty turn rather than to a guess.
   */
  turnEvents(turn) {
    return this.durableEvidence.eventsFor(turn)
  }

  /**
   * How many turns' durable evidence this generation currently retains.
   *
   * The live occupancy, bounded by `MAX_RETAINED_TURNS`; unlike
   * `counters.retainedDurableEvents` it falls when a turn is evicted.
   */
  retainedTurnCount() {
    return this.durableEvidence.byTurn.size
  }

  /**
   * Whether a durable settlement is available to retire one bare settle, and by
   * which route it was resolved.
   *
   * Three routes, in order of strength. The attempt's own identity is the only
   * proof that needs no coordinate; the outstanding-settlement queue is how a
   * settlement — which names no `attemptId` — is matched to the attempt whose
   * `(turn, step)` its transient rows declared; and a single queued settlement
   * still covers an attempt whose rows this client never saw, because DSH
   * retires one attempt per published settlement.
   */
  durableSettlementFor(attemptId) {
    if (this.settledAttemptIds.has(attemptId)) return { route: 'attempt-identity', key: null, index: -1 }
    if (this.pendingSettlements.length === 0) return null
    const key = this.attemptSteps.get(attemptId)
    if (key !== undefined) {
      const index = this.pendingSettlements.findIndex(entry => entry.key === key)
      if (index >= 0) return { route: 'pending-coordinate', key, index }
      return null
    }
    /**
     * The attempt's coordinate is unknown. Two or more outstanding settlements
     * leave the pairing unprovable, and the settle is recorded as unresolved
     * rather than attached to a guess.
     */
    if (this.pendingSettlements.length === 1) return { route: 'pending-unique', key: null, index: 0 }
    return null
  }

  consumeSettlement(route) {
    if (!Number.isFinite(route.index) || route.index < 0) return
    this.pendingSettlements.splice(route.index, 1)
  }

  applySettlement(change) {
    const attemptId = typeof change.attemptId === 'string' ? change.attemptId : null
    const entry = change.entry
    if (attemptId === null) {
      this.issue(FEED_ISSUE.UNMATCHED_SETTLEMENT)
      return
    }
    if (entry === undefined || entry === null) {
      this.counters.bareSettleSeen += 1
      const durable = this.durableSettlementFor(attemptId)
      if (this.openAttemptId === attemptId) this.openAttemptId = null
      if (durable !== null) {
        /**
         * Normal successful retirement. The durable settlement was already fed
         * from the `append` that published it, and the machine has already left
         * the streaming state on that event; emitting a second attempt outcome
         * here would overwrite a committed outcome with an abandonment and is
         * exactly the 0.1.5-era defect this branch exists to prevent.
         */
        this.consumeSettlement(durable)
        this.counters.retirementsResolved += 1
        return
      }
      if (this.attemptSteps.get(attemptId) === undefined) {
        this.issue(FEED_ISSUE.UNRESOLVED_SETTLEMENT, { attemptId, route: 'abandonment' })
      }
      this.counters.abandonmentsResolved += 1
      this.emit({
        kind: NORMALIZED_KIND.ATTEMPT_ABANDON,
        attemptId,
        turn: this.openTurn,
        timeMs: null,
        settlementKind: 'none',
        surfaceCommitted: false,
        attemptOutcome: 'abandoned',
      })
      return
    }
    this.counters.settlementsWithEntry += 1
    const event = entry.event
    /**
     * The admission gate runs **before** retention on this route too. A settlement
     * delivered by `settle-assistant` is the same durable row a window entry would
     * have carried, so a second delivery of it is a duplicate, not new evidence: it
     * must not refresh its turn's retention position, and it must not emit a second
     * attempt outcome over one that is already committed.
     */
    if (!this.admitDurable(event)) {
      this.issue(FEED_ISSUE.DUPLICATE_DURABLE, event === null || typeof event !== 'object' ? null : event.seq)
      return
    }
    this.retainDurable(event)
    const normalized = normalizeDurableEvent(event)
    if (normalized.kind !== NORMALIZED_KIND.ATTEMPT_SETTLE) {
      this.issue(FEED_ISSUE.UNMATCHED_SETTLEMENT, normalized.kind)
      return
    }
    /**
     * A settlement delivered **with** its entry is DSH's immediate path:
     * interrupted messages and non-surface `assistant/attempt` settlements. It
     * is a durable settlement for this attempt, so a later bare settle for the
     * same attempt is a retirement and not a second outcome.
     */
    this.registerDurableSettlement(normalized, { attemptId, queue: false })
    if (this.openAttemptId === attemptId) this.openAttemptId = null
    this.emit({ ...normalized, attemptId })
  }

  /**
   * Record that one durable settlement landed.
   *
   * Two routes reach a durable settlement, and they differ in what they leave
   * behind. A settlement delivered **with** its entry is DSH's immediate route
   * (interrupted messages, `assistant/attempt`): it names the attempt, the
   * transient rows are superseded at that instant, and nothing stays
   * outstanding. A settlement appended as a plain durable row is a
   * non-interrupted `assistant/message`, which the fold retains until the owning
   * `step/end` is published and only then retires with a bare settle — that one
   * is queued, and `queue: false` is what keeps an immediately-retired
   * settlement from excusing a later attempt in the same step.
   */
  registerDurableSettlement(normalized, { attemptId = null, queue = true } = {}) {
    if (attemptId !== null) this.settledAttemptIds.add(attemptId)
    if (!queue) return
    const key = stepKey(normalized.turn, normalized.step)
    const retains = normalized.eventType === 'assistant/message' && normalized.interrupted !== true
    if (retains && key !== null && !this.pendingSettlements.some(entry => entry.key === key)) {
      this.pendingSettlements.push({ key, seq: normalized.seq ?? null })
    }
  }

  /**
   * Derive the open-turn boundary from transient evidence.
   *
   * The published window is a live *tail*: after a reload — or after a
   * `replace` rebaseline, which is what a reconnect produces — the open turn's
   * `turn/start` row is normally outside it. A page that attaches mid-turn then
   * knows the turn only from the `turn` field of its transient rows. Without a
   * boundary every turn-scoped event is discarded ("belongs to no turn") and
   * the live view never appears at all.
   *
   * The first transient row naming a turn the feed is not tracking is therefore
   * adopted as the boundary — the same client-side derivation the attempt
   * boundary below already relies on. The emitted event carries
   * `recovered: true` because it is *inferred*, not observed: consumers must not
   * restart turn-scoped stopwatches from it, and the turn's start time stays
   * unknown (`timeMs: null`) so TTFT is never measured from the reload.
   *
   * A turn already closed by a durable `turn/end` is never re-opened, and a turn
   * the feed has already moved past is never re-adopted: both guards are per turn
   * identity, because a turn number is an identity and the rows of one turn can
   * arrive interleaved with another's. A row that names no *finite* turn adopts
   * nothing — there is nothing to name, and guessing one would attach this
   * client's evidence to a turn it cannot identify.
   */
  adoptTurn(turn) {
    if (!Number.isFinite(turn)) return false
    if (turn === this.openTurn) return false
    if (this.settledTurns.has(turn)) return false
    /** Turns are ordered, so a row below the highest observed one is late evidence of a past turn. */
    if (Number.isFinite(this.highestTurn) && turn < this.highestTurn) return false
    this.markTurnSeen(turn)
    this.openTurn = turn
    this.emit({ kind: NORMALIZED_KIND.TURN_START, turn, timeMs: null, recovered: true })
    return true
  }

  /**
   * Record that a turn number has been observed, whichever plane named it.
   *
   * This is the ordering watermark `adoptTurn` compares against, and it is fed
   * by transient rows and durable turn rows alike: a turn established by a
   * durable boundary — a row the client *did* observe, fully — must not later be
   * re-opened by the synthetic path either.
   */
  markTurnSeen(turn) {
    if (!Number.isFinite(turn)) return
    if (!Number.isFinite(this.highestTurn) || turn > this.highestTurn) this.highestTurn = turn
  }

  /**
   * Drop a transient row that belongs to a turn this feed has already finished
   * with, and record why.
   *
   * The row is *not* delivered. A turn closed by `turn/end` has a settled record
   * and a card; feeding a late delta into it would re-open a turn the session
   * ended, and the attempt identity it carries is no longer open, so the value it
   * would contribute is not the live view's business. Dropping it silently would
   * hide a real wire behaviour, so it is counted as an issue.
   */
  dropLateRow(turn, attemptId) {
    this.counters.lateTurnRows += 1
    this.issue(FEED_ISSUE.LATE_TURN_ROW, { turn, attemptId })
  }

  processEntries(entries) {
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') {
        this.issue(FEED_ISSUE.MALFORMED_ENTRY)
        continue
      }
      if (entry.type === 'transient') {
        this.processTransient(entry.event)
        continue
      }
      if (entry.type === 'event') {
        this.processDurable(entry.event)
        continue
      }
      this.issue(FEED_ISSUE.MALFORMED_ENTRY, entry.type)
    }
  }

  processTransient(row) {
    if (row === null || typeof row !== 'object') {
      this.issue(FEED_ISSUE.MALFORMED_ENTRY)
      return
    }
    if (this.transientRows.has(row)) {
      this.issue(FEED_ISSUE.DUPLICATE_TRANSIENT)
      return
    }
    this.transientRows.add(row)
    this.counters.rawTransientRows += 1
    const normalized = normalizeLiveChunk(row)
    if (normalized.kind === NORMALIZED_KIND.IGNORED) {
      this.issue(FEED_ISSUE.MALFORMED_ENTRY, normalized.reason)
      return
    }
    // Attempt identity exists only on the transient plane: a change of
    // `attemptId` between consecutive rows is the client-side attempt
    // boundary (the browser never sees the host `start` frame).
    this.markTurnSeen(normalized.turn)
    const adopted = this.adoptTurn(normalized.turn)
    if (!adopted && Number.isFinite(normalized.turn)) {
      /**
       * The row names a finite turn that was not adopted. Either the turn is
       * already the open one — the ordinary case, every row after the first —
       * or it is a turn this client has finished with, and its late evidence is
       * dropped rather than re-attached to a settled record.
       */
      if (normalized.turn !== this.openTurn) {
        this.dropLateRow(normalized.turn, normalized.attemptId)
        return
      }
    }
    /**
     * Tie the process-local attempt to its durable coordinate. The settlement
     * event never names an `attemptId`, so this registration is the only way a
     * later bare `settle-assistant` can be resolved against durable evidence.
     */
    const key = stepKey(normalized.turn, normalized.step)
    if (key !== null) this.attemptSteps.set(normalized.attemptId, key)
    if (normalized.attemptId !== this.openAttemptId) {
      this.openAttemptId = normalized.attemptId
      this.emit({
        kind: NORMALIZED_KIND.ATTEMPT_START,
        attemptId: normalized.attemptId,
        turn: normalized.turn,
        step: normalized.step,
        timeMs: normalized.timeMs,
      })
    }
    this.emit({
      kind: NORMALIZED_KIND.ATTEMPT_DELTA,
      attemptId: normalized.attemptId,
      turn: normalized.turn,
      step: normalized.step,
      timeMs: normalized.timeMs,
      chunk: normalized.chunk,
      phase: normalized.phase,
      countsAsToken: normalized.countsAsToken,
    })
  }

  processDurable(event) {
    if (event === null || typeof event !== 'object' || !Number.isFinite(event.seq)) {
      this.issue(FEED_ISSUE.MALFORMED_ENTRY)
      return
    }
    /**
     * Admission first, retention second. Every effect of a durable row on this feed's
     * bookkeeping — the generation-wide seq identity, the ingest counter, its turn's
     * retention position — is downstream of this one check, so a duplicate is inert
     * rather than half-applied. Retention used to run first, which made a replayed row
     * of an evicted turn a duplicate for ingestion and new evidence for retention at
     * the same time.
     */
    if (!this.admitDurable(event)) {
      this.issue(FEED_ISSUE.DUPLICATE_DURABLE, event.seq)
      return
    }
    this.retainDurable(event)
    this.counters.rawDurableEvents += 1
    const normalized = normalizeDurableEvent(event)
    switch (normalized.kind) {
      case NORMALIZED_KIND.IGNORED:
        return
      case NORMALIZED_KIND.TURN_START:
        this.openTurn = normalized.turn
        this.markTurnSeen(normalized.turn)
        this.emit(normalized)
        return
      case NORMALIZED_KIND.TURN_END:
        this.counters.rawTurnEndSeen += 1
        this.counters.normalizedTurnEndSeen += 1
        this.openTurn = null
        this.openAttemptId = null
        if (Number.isFinite(normalized.turn)) this.settledTurns.add(normalized.turn)
        this.markTurnSeen(normalized.turn)
        this.emit(normalized)
        return
      case NORMALIZED_KIND.ATTEMPT_SETTLE:
        this.registerDurableSettlement(normalized)
        // No `settle-assistant` change here (fixture-style replay, or a fold
        // that appends the row): correlate to the open transient attempt when
        // one exists. Attempt identity is never invented when none does.
        this.emit({ ...normalized, attemptId: this.openAttemptId })
        if (this.openAttemptId !== null) this.openAttemptId = null
        return
      case NORMALIZED_KIND.TOOL_CALL:
        this.counters.rawToolCalls += 1
        if (this.dropIfSettled(normalized)) return
        this.emit(normalized)
        return
      case NORMALIZED_KIND.TOOL_RESULT:
        this.counters.rawToolResults += 1
        if (normalized.malformed === true) this.counters.malformedToolResults += 1
        if (this.dropIfSettled(normalized)) return
        this.emit(normalized)
        return
      default:
        /**
         * `turn/end` is terminal for live presentation: a trailing `step/start`,
         * `step/end`, retry or delta of a closed turn is counted and dropped so
         * it cannot resurrect the turn the session already ended.
         */
        if (this.dropIfSettled(normalized)) return
        this.emit(normalized)
    }
  }

  /**
   * Suppress a durable row belonging to a turn that has already been closed by
   * `turn/end`. Returns whether the row was dropped.
   */
  dropIfSettled(normalized) {
    if (!Number.isFinite(normalized.turn)) return false
    if (!this.settledTurns.has(normalized.turn)) return false
    this.counters.lateTurnEvents += 1
    this.issue(FEED_ISSUE.LATE_TURN_EVENT, { turn: normalized.turn, kind: normalized.kind, seq: normalized.seq })
    return true
  }
}

;Object.assign(__exports, { FEED_ISSUE, MAX_RETAINED_TURNS, SessionEventFeed })
			},
			"src/dsh/reconstruction.js": function (__exports) {
/**
 * Durable reconstruction -> materialized `TurnTelemetryStore` turn record.
 *
 * This is the bridge Phase 7D.1 adds. It exists for exactly one situation, and it
 * is worth stating which one, because the module is otherwise easy to mistake for a
 * second reconstruction path:
 *
 *   The published window is a live **tail**. A client that attached after a turn
 *   began — a fresh page on a running session, a reload whose tail has slid past
 *   the opening row, a reconnect — can receive the turn's authoritative `turn/end`
 *   while holding no record for it, because nothing in the window ever opened the
 *   turn. The durable facts of that turn are nevertheless in the same window: the
 *   `assistant/message` settlements with their embedded compact streams, the
 *   `tool/call` and `tool/result` boundaries, the step boundaries, the retries.
 *
 * Phase 7D closed the *lifecycle* half of that case: the boundary was no longer
 * dropped, and a completed card appeared. It opened an **empty** record
 * (`beginTurn` immediately followed by `endTurn`), so the card closed with zero
 * attempts, zero tokens and no tools while the evidence for all of them sat in the
 * window it had just read. This module closes the metric half.
 *
 * ## What it does, and what it deliberately does not
 *
 * Every durable fact comes from `reconstructFromDurable` (`durable-path.js`), which
 * remains the project's only durable parser. This module performs no decoding, no
 * tool pairing, no retry correlation and no settlement classification of its own: it
 * calls that pipeline and routes its output into the store through the store's own
 * methods — the same `beginAttempt` / `acceptChunk` / `setAttemptUsage` /
 * `settleAttempt` / `toolStarted` / `toolSettled` sequence the live path uses, so
 * the recovered record is indistinguishable from a record the live path built, and
 * therefore enters `aggregateTurn` -> `calibration` -> `curveSource` ->
 * `attemptTraces` with no side channel of its own. A `tail recovery curve` would be
 * a second set of curve arithmetic, and a second set of curve arithmetic is free to
 * disagree with the printed numbers.
 *
 * ## No unavailable fact is fabricated
 *
 * Two rules, both load-bearing:
 *
 *   **The turn start is only what the tail observed.** `turnStartMs` is
 *   `reconstructFromDurable().turnStartMs`, which is `null` unless the turn's own
 *   `turn/start` row is in the evidence. The first model delta, a `step/start`, a
 *   `tool/call`, the moment this client attached and the current wall clock are all
 *   tempting substitutes and all forbidden: TTFT and turn elapsed are intervals from
 *   the start, so inventing one would print a measured-looking number for a turn
 *   whose beginning nobody saw. `null` is the correct answer, and the UI already
 *   renders it as "—". This module enforces the rule at the API level as well as in
 *   its arithmetic: `materializeReconstructedTurn()` accepts no caller clock at all,
 *   so the substitution cannot be expressed by a future caller either. See its
 *   docstring for the measured pre-7D.1.1 behaviour that clause closes.
 *
 *   **Sample timestamps are only what the settlement recorded.** Each attempt's
 *   samples are the ones `acceptChunk` derives from the settlement's own embedded
 *   compact stream, so `firstTokenMs` is the earliest *observed* generated sample.
 *   That is durable evidence and may be recovered. It is not TTFT: TTFT needs the
 *   start as well, so a recovered turn can legitimately hold a known first token
 *   beside an unavailable TTFT, and the aggregate computes it that way for free.
 */

const { reconstructFromDurable } = __req("src/dsh/durable-path.js")

/**
 * Deterministic, reconstruction-local identity for a materialized attempt.
 *
 * DSH's durable log carries no `attemptId` — the identity is process-local to the
 * client fold and never appears in a settlement — so a recovered attempt has no
 * provider identity to adopt, and inventing one would present a reconstruction-local
 * key as an external fact. The key is nonetheless needed, because the store, the
 * curve sources and the attempt traces are all keyed by it.
 *
 * It is derived from the settlement's own sequence number, so replaying the same
 * evidence always yields the same identity: a wall clock or a random UUID would make
 * two replays of one window disagree, which is precisely what durable reconstruction
 * exists to prevent.
 *
 * The `#n` suffix appears only in the impossible case of two settlements sharing one
 * sequence number, and it is still a function of the evidence rather than of time.
 *
 * @param {number|null|undefined} settlementSeq
 * @param {number} duplicateIndex how many attempts already claimed this sequence
 */
function reconstructedAttemptId(settlementSeq, duplicateIndex = 0) {
  const base = Number.isFinite(settlementSeq) ? `settlement:${settlementSeq}` : 'settlement:unknown'
  return duplicateIndex === 0 ? base : `${base}#${duplicateIndex}`
}

/**
 * Build a `TurnTelemetryStore` turn record from a turn's durable evidence.
 *
 * The returned record is a normal store record: it carries attempts, samples,
 * usage, tool intervals, a first-token stamp and (once the caller closes it) a
 * settled snapshot computed by the ordinary pipeline. The caller owns the turn's
 * terminal boundary for the same reason the live path does — it has the
 * authoritative `turn/end` envelope — so this function deliberately does not call
 * `endTurn`.
 *
 * ## There is no `timeMs` input, and its absence is load-bearing
 *
 * Phase 7D.1.1 removed a `timeMs` parameter that this function used to accept and
 * passed to `beginTurn` as `reconstructed.turnStartMs ?? timeMs`. Any finite value
 * a caller supplied therefore *became* the recovered turn's start. Measured on the
 * 7D.1 baseline, a tail holding settlements but no `turn/start`, given an invented
 * clock, produced `record.startMs === <that clock>`, and because the store clamps
 * negative intervals, `settled.ttftMs === 0` and `settled.turnElapsedMs === 0` — a
 * measured-looking `0 ms` for two metrics with no measurement behind them, where
 * `null` ("—") is the honest answer.
 *
 * The parameter is deleted rather than ignored, so that fallback is not
 * expressible: the recovered start is `reconstructed.turnStartMs` and nothing else
 * can reach it. Callers that legitimately hold an observed boundary for this turn
 * apply it through `store.turnStartObserved()`, which is the one-way upgrade and
 * refuses to replace a finite start — the controller's miss path already does
 * exactly that with `state.observedTurnStart`. Do not reintroduce a wall-clock
 * fallback here: a start may only come from durable `turn/start` evidence, and a
 * caller's clock is not evidence about this turn.
 *
 * @param {{
 *   store: object,
 *   sessionId: string,
 *   turn: number,
 *   events: readonly object[],
 *   estimate?: Function,
 * }} input
 * @returns {{record: object, reconstructed: object}}
 */
function materializeReconstructedTurn({ store, sessionId, turn, events = [], estimate }) {
  const reconstructed = reconstructFromDurable({ sessionId, turn, events, ...(estimate === undefined ? {} : { estimate }) })

  /**
   * `beginTurn` is idempotent, so a record already holding evidence for this turn is
   * extended rather than discarded. On the path this module exists for there is no
   * such record — the caller reached it precisely because the lookup missed — but
   * the idempotence is what keeps the function safe to call twice.
   *
   * `timeMs` is the parser's own `turnStartMs`: `null` when the tail carried no
   * `turn/start`, which is the correct answer rather than a gap to fill. See the
   * docstring above before adding any fallback to this argument.
   */
  const record = store.beginTurn({ sessionId, turn, timeMs: reconstructed.turnStartMs })

  /**
   * An observed start is recorded through the one-way upgrade rather than by
   * assignment. The upgrade only ever adds authority (`turnStartObserved` refuses to
   * replace a finite start, and refuses a non-finite one), so recovery cannot
   * withdraw a boundary the live path had already measured, and the per-session
   * `LiveMeter` learns the instant for the same turn.
   */
  store.turnStartObserved(record, { timeMs: reconstructed.turnStartMs })

  const seenAttemptIds = new Set()
  const duplicates = new Map()
  for (const attempt of reconstructed.attempts) {
    const seq = attempt.settlementSeq
    const duplicateIndex = duplicates.get(seq) ?? 0
    duplicates.set(seq, duplicateIndex + 1)
    let attemptId = reconstructedAttemptId(seq, duplicateIndex)
    while (seenAttemptIds.has(attemptId)) attemptId = `${attemptId}#`
    seenAttemptIds.add(attemptId)

    const stored = store.beginAttempt(record, {
      attemptId,
      step: attempt.step ?? null,
      startedAtMs: attempt.startedAtMs ?? null,
      /**
       * The store is told where these samples come from, because it cannot see
       * the decode: `reconstructFromDurable` derives the value from the same
       * `decoded.complete` verdict that produced the chunks accepted below. A
       * recovered attempt is therefore `durable-complete` only when the durable
       * stream decoded completely — a partial decode still restores the attempt
       * (its surviving deltas are evidence) but is not authoritative temporal
       * evidence.
       */
      temporalEvidenceAuthority: attempt.temporalEvidenceAuthority ?? null,
    })

    /**
     * The samples are produced by `acceptChunk` from the settlement's own embedded
     * stream, not copied from `reconstructFromDurable`'s per-attempt sample array.
     * The two run the same rule over the same chunks and therefore agree, and routing
     * through the store is what keeps the per-session `LiveMeter` consistent with the
     * record instead of letting the two drift. A malformed stream (no chunk array)
     * contributes no samples rather than a guess.
     */
    if (Array.isArray(attempt.chunks)) {
      for (const entry of attempt.chunks) {
        store.acceptChunk(record, stored, { timeMs: entry.timeMs, chunk: entry.chunk })
      }
    }

    const usage = isUsage(attempt.usage) ? attempt.usage : null
    if (usage !== null) store.setAttemptUsage(stored, usage, attempt.usageSource ?? 'assistant-settlement')

    store.settleAttempt(stored, {
      settledAtMs: Number.isFinite(attempt.settledAtMs) ? attempt.settledAtMs : null,
      settlementKind: attempt.settlementKind ?? 'none',
      surfaceCommitted: attempt.surfaceCommitted === true,
      attemptOutcome: attempt.attemptOutcome ?? 'unknown',
      usage,
      usageSource: attempt.usageSource ?? null,
      settlementSeq: Number.isFinite(attempt.settlementSeq) ? attempt.settlementSeq : null,
    })
    stored.settlementEventType = attempt.settlementEventType ?? null
    stored.interrupted = attempt.interrupted === true
  }

  for (const tool of reconstructed.tools) {
    if (typeof tool.callId !== 'string' || !Number.isFinite(tool.startMs)) continue
    store.toolStarted(record, { callId: tool.callId, name: tool.name ?? null, timeMs: tool.startMs })
    /**
     * A call whose result is not in the evidence keeps `endMs: null` and stays
     * incomplete. Giving it the turn's end, the next call's start or the current
     * clock would turn an unobserved boundary into a measured duration.
     */
    if (Number.isFinite(tool.endMs)) {
      store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status ?? 'ok' })
    }
  }

  return { record, reconstructed }
}

function isUsage(usage) {
  return usage !== null && typeof usage === 'object' && Number.isFinite(usage.outputTokens)
}

;Object.assign(__exports, { reconstructedAttemptId, materializeReconstructedTurn })
			},
			"src/client/format.js": function (__exports) {
/**
 * Display formatting.
 *
 * Two rules govern everything here:
 *
 *   1. Absent evidence renders as an em dash. A missing measurement must never
 *      be shown as `0`, because that would claim a measured zero.
 *   2. Quality is *not* baked into the string. Whether a value deserves a `≈`
 *      prefix or a quality indicator is decided by the renderer from the
 *      metric's declared quality, so the exactness claim has exactly one home.
 */

const DASH = '—'

function formatSeconds(ms, digits = 1) {
  if (!Number.isFinite(ms)) return DASH
  return `${(ms / 1000).toFixed(digits)}s`
}

/**
 * Running stopwatch split into its number and its unit.
 *
 * The reference renders the first-response counter as a large number followed by
 * a visibly smaller unit, so the two parts must be separately styleable. Keeping
 * the split here — next to the rules that decide the digits — means the visible
 * pair and `formatCountdown`'s flat string can never disagree about precision.
 *
 * @returns {{value: string, unit: string|null}} `unit` is `null` for absent evidence
 */
function countdownParts(ms, digits = 2) {
  if (!Number.isFinite(ms)) return { value: DASH, unit: null }
  return { value: (ms / 1000).toFixed(digits), unit: 's' }
}

/** Running TTFT counter form: `2.80 s`. */
function formatCountdown(ms, digits = 2) {
  const parts = countdownParts(ms, digits)
  return parts.unit === null ? parts.value : `${parts.value} ${parts.unit}`
}

/**
 * Rate and magnitude display. Three-significant-figure behaviour without
 * exponent notation at the low end, where token rates are most often read.
 *
 * The same function formats the card's TPS values and its token magnitudes,
 * because both are "a number with a unit" and the specification freezes one
 * formatter for the card rather than one per column. Counts of a thousand or more
 * therefore keep locale grouping: `54,770` is the reference's number, and
 * compacting it to `54770` would be a formatting accident rather than a layout
 * decision. `formatTokens` remains the explicit integer formatter for secondary
 * lines.
 */
function formatTps(value) {
  if (!Number.isFinite(value)) return DASH
  /**
   * Round **before** choosing the precision band. `9.999` must read `10.0`, not
   * `10.00`: picking the band from the unrounded value would print a
   * two-decimal number for a value already past ten.
   */
  const rounded = Math.round(value * 100) / 100
  if (rounded >= 1000) return formatTokens(rounded)
  if (rounded >= 100) return Math.round(rounded).toString()
  if (rounded >= 10) return rounded.toFixed(1)
  return rounded.toFixed(2)
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return DASH
  const rounded = Math.round(value)
  // `-0` is a display artefact of rounding, not a magnitude: it must not reach
  // the DOM as `-0`.
  return (rounded === 0 ? 0 : rounded).toLocaleString('en-US')
}

/** Compact elapsed form used on secondary lines: `133.6s`, `2m42s`. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`
}



;Object.assign(__exports, { DASH, formatSeconds, countdownParts, formatCountdown, formatTps, formatTokens, formatDuration })
			},
			"src/client/ui-model.js": function (__exports) {
/**
 * Pure view-model shaping.
 *
 * Keeping this layer pure means the component tree contains no statistics and no
 * transport knowledge, so screenshots and component tests are independent of
 * DSH. The inputs are the snapshots produced by `src/core/live-metrics.js` and
 * the settled turn record from `src/host/telemetry-design.js`.
 *
 * The completed half of this module is the **only** seam between the settled
 * snapshot and the completed card: quality, approximate markers, em-dash
 * fallbacks and every displayed string are decided here, so the React component
 * renders fields instead of interpreting statistics.
 */

const { MetricQuality, weakestQuality } = __req("src/core/metric-quality.js")
const { QualityLevel, requiresApproximateMarker } = __req("src/core/quality-model.js")
const { formatSeconds, formatTps, formatTokens, DASH } = __req("src/client/format.js")

/** Shared shape for a value that may legitimately be absent. */
function value(value, quality) {
  return { value: value ?? null, quality: quality ?? MetricQuality.UNAVAILABLE, available: value !== null && value !== undefined }
}

/**
 * Live branch selection. `idle` and `settled` both render nothing here: an idle
 * meter has no turn, and a settled turn belongs to the completed card.
 */
function liveViewModel(snapshot) {
  if (!snapshot || snapshot.phase === 'idle' || snapshot.phase === 'settled') return { kind: 'hidden' }

  if (snapshot.phase === 'tool') {
    return {
      kind: 'tool',
      turn: snapshot.turn,
      runningToolCount: snapshot.runningToolCount ?? 0,
      runningToolNames: snapshot.runningToolNames ?? [],
      /** The compact label prefers a single tool name and falls back to a count. */
      label: (snapshot.runningToolCount ?? 0) === 1
        ? (snapshot.runningToolNames?.[0] ?? 'tool')
        : `Tools ${snapshot.runningToolCount ?? 0}`,
      toolElapsed: value(snapshot.toolElapsedMs ?? null, MetricQuality.EXACT),
      turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
    }
  }

  if (snapshot.phase === 'streaming') {
    /**
     * No rate is published until the current phase episode holds enough samples:
     * a one-sample cumulative average is not a measurement. Until then the view
     * is the episode's elapsed counter, exactly as the pending state shows one
     * (`docs/METRICS_SPEC.md` §12).
     */
    if (snapshot.tps === null || snapshot.tps === undefined) {
      return {
        kind: 'warming',
        turn: snapshot.turn,
        activePhase: snapshot.activePhase ?? null,
        episodeElapsedMs: value(snapshot.episodeElapsedMs ?? null, MetricQuality.EXACT),
        samples: snapshot.episodeSampleCount ?? 0,
        required: snapshot.warmupSamples ?? 0,
        turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
      }
    }
    return {
      kind: 'streaming',
      turn: snapshot.turn,
      activePhase: snapshot.activePhase ?? null,
      /**
       * Live TPS is a shape estimate until provider usage arrives after
       * settlement, so it is never presented as exact.
       */
      tps: value(snapshot.tps ?? null, snapshot.tpsQuality ?? MetricQuality.ESTIMATED),
      turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
    }
  }

  // Pending: turn open, no generated delta yet. The UI shows the TTFT counter.
  return {
    kind: 'ttft',
    turn: snapshot.turn,
    /** Running counter: the final TTFT is not known until the first delta lands. */
    ttft: value(snapshot.ttftMs ?? null, snapshot.ttftMs === null ? MetricQuality.ESTIMATED : MetricQuality.EXACT),
    turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
  }
}

/**
 * Turn status as the card must present it.
 *
 * `status` is the settlement outcome derived from `turn/end`; `statusNote`
 * carries the finer fact (why it was aborted, which ceiling truncated it). The
 * truncated case is its own presentation kind because "completed" alone would
 * hide that the model stopped at a token ceiling.
 */
function completedStatusOf(status, statusNote) {
  if (status === 'interrupted') return { kind: 'interrupted', detail: statusNote ?? null, tone: 'warn' }
  if (status === 'errored') return { kind: 'errored', detail: statusNote ?? null, tone: 'error' }
  if (statusNote === 'max-tokens') return { kind: 'max-tokens', detail: null, tone: 'warn' }
  return { kind: 'completed', detail: statusNote ?? null, tone: 'neutral' }
}

/**
 * Duration on a secondary line.
 *
 * The completed card uses the reference's one-decimal **second** scale at every
 * magnitude (`108.2s`, `133.6s`), because these lines are read against the
 * reference layout and against each other; the shared `formatDuration` helper's
 * minute form stays the live pill's format, where a running turn can be read for
 * hours and compactness matters more than comparison.
 */
function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH
  return formatSeconds(ms, 1)
}

/**
 * A duration paired with a token count on one secondary line.
 *
 * The two halves are one derivation chain, so they share one approximate
 * decision: a token count that is not measured may never be printed bare next to
 * a rate that carries `≈`. A phase with no tokens and no duration is omitted
 * rather than printed as a zero.
 */
function phaseSecondary(durationMs, tokens, approximateTokens) {
  const parts = []
  const hasDuration = Number.isFinite(durationMs) && durationMs > 0
  const hasTokens = tokens !== null && tokens !== undefined
  if (hasDuration) parts.push(durationText(durationMs))
  if (hasTokens) parts.push(`${approximateTokens ? '≈' : ''}${formatTokens(tokens)}`)
  else if (hasDuration) parts.push(DASH)
  return parts.length === 0 ? null : { kind: 'phase', text: parts.join(' · '), approximate: approximateTokens === true }
}

/**
 * One of the four principal columns.
 *
 * `display` is resolved here rather than in the component, and `format` lets a
 * column state its own unit convention: token magnitudes read through
 * three-significant-figure formatting (`345`, `54,770`), while a duration in
 * seconds is always two decimals (`1.44`), so a 1440 ms TTFT can never be
 * printed as the token-like `1,440`.
 */
function metricCell({ key, labelKey, value: metricValue, unit = null, secondary = null, approximate = false, format = formatTps }) {
  const available = metricValue.value !== null && metricValue.value !== undefined
  return {
    key,
    labelKey,
    value: metricValue.value,
    display: available ? (approximate ? `≈${format(metricValue.value)}` : format(metricValue.value)) : DASH,
    unit: available ? unit : null,
    quality: metricValue.quality,
    approximate: approximate && available,
    available,
    secondary,
  }
}

/**
 * Completed card view model.
 *
 * Four principal columns are fixed by the UI specification and always present in
 * the same order; tool statistics stay on the footer line and never become a
 * fifth column. Display quality follows the settled snapshot's three-axis model:
 *
 *   - `tokenTotalQuality === exact`  -> a bare generated-token total;
 *   - anything weaker                -> `≈` on the number it qualifies;
 *   - `phaseSplitQuality === exact`   -> bare reasoning/output rates and counts;
 *   - `unavailable`                  -> `—`, never `0`.
 */
function completedViewModel(settled) {
  if (!settled || !['completed', 'interrupted', 'errored'].includes(settled.status)) return null

  const quality = settled.quality ?? {}
  const tokenTotalExact = quality.tokenTotalQuality === QualityLevel.EXACT
  const phaseSplitExact = quality.phaseSplitQuality === QualityLevel.EXACT

  /**
   * A partial total has a real observed sum but no complete evidence: publishing
   * the exact figure would claim coverage the turn does not have, so the partial
   * sum is shown with `≈` and the field is explicitly marked partial.
   */
  /**
   * A partial or recovered total has a real sum but no complete evidence:
   * publishing it bare would claim coverage the turn does not have, and `0` is
   * never a substitute for "not measured", so only a genuine observed sum is
   * published and it is always marked approximate.
   */
  const observed = Number.isFinite(settled.observedGeneratedTokens) ? settled.observedGeneratedTokens : 0
  const generatedValue = Number.isFinite(settled.generatedTokens)
    ? settled.generatedTokens
    : (observed > 0 ? observed : null)
  /** Only a fully authoritative total may be printed without `≈`. */
  const generatedApproximate = !tokenTotalExact

  const tools = settled.tools ?? {}
  const status = completedStatusOf(settled.status, settled.statusNote)
  const phaseTokens = settled.phaseTokens ?? { reasoning: null, output: null }
  /** Counters derived from the provider split are exact; everything else is not. */
  const phaseCountsApproximate = !phaseSplitExact

  const columns = [
    metricCell({
      key: 'reasoningTps',
      labelKey: 'colReasoningTps',
      unit: 'tokens/s',
      value: value(settled.reasoningTps ?? null, settled.reasoningTpsQuality),
      approximate: requiresApproximateMarker(settled.reasoningTpsQuality),
      secondary: phaseSecondary(settled.reasoningMs, phaseTokens.reasoning, phaseCountsApproximate),
    }),
    metricCell({
      key: 'outputTps',
      labelKey: 'colOutputTps',
      unit: 'tokens/s',
      value: value(settled.outputTps ?? null, settled.outputTpsQuality),
      approximate: requiresApproximateMarker(settled.outputTpsQuality),
      secondary: phaseSecondary(settled.outputMs, phaseTokens.output, phaseCountsApproximate),
    }),
    metricCell({
      key: 'generatedTokens',
      labelKey: 'colGeneratedTokens',
      unit: 'tokens',
      value: value(generatedValue, quality.tokenTotalQuality ?? MetricQuality.UNAVAILABLE),
      approximate: generatedApproximate,
      secondary: Number.isFinite(settled.turnElapsedMs)
        ? { kind: 'elapsed', labelKey: 'elapsed', ms: settled.turnElapsedMs, display: durationText(settled.turnElapsedMs) }
        : null,
    }),
    metricCell({
      key: 'ttft',
      labelKey: 'colTtft',
      unit: 's',
      value: value(settled.ttftMs ?? null, MetricQuality.EXACT),
      /** Bare two-decimal seconds; the `s` unit is rendered by the column. */
      format: milliseconds => Number.isFinite(milliseconds) ? (milliseconds / 1000).toFixed(2) : DASH,
      secondary: { kind: 'status', statusKey: `status.${status.kind}`, detail: status.detail, tone: status.tone },
    }),
  ]

  return {
    kind: 'completed',
    /**
     * The live state machine's terminal state. Both views expose `state` so the
     * projection identity used by the controller's cache is uniform across them.
     */
    state: 'settled',
    sessionId: settled.sessionId ?? null,
    turn: settled.turn,
    /** Turn identity for the projection cache: one string per settled view. */
    projectionKey: `completed:${settled.sessionId ?? ''}:${settled.turn ?? ''}`,
    status: status.kind,
    statusDetail: settled.statusNote ?? null,
    columns,
    elapsedMs: Number.isFinite(settled.turnElapsedMs) ? settled.turnElapsedMs : null,
    elapsedDisplay: durationText(settled.turnElapsedMs),
    tools: {
      count: tools.count ?? 0,
      completedCount: tools.completedCount ?? 0,
      wallMs: tools.wallMs ?? 0,
      wallDisplay: durationText(tools.wallMs ?? 0),
      workMs: tools.workMs ?? 0,
      workDisplay: durationText(tools.workMs ?? 0),
      failedCount: tools.failedCount ?? 0,
      names: tools.names ?? [],
    },
    attemptCount: settled.attemptCount ?? 0,
    quality: {
      tokenTotalQuality: quality.tokenTotalQuality ?? QualityLevel.UNAVAILABLE,
      phaseSplitQuality: quality.phaseSplitQuality ?? QualityLevel.UNAVAILABLE,
      displayTokenTotal: quality.displayTokenTotal ?? 'unavailable',
      displayPhaseSplit: quality.displayPhaseSplit ?? 'unavailable',
      /** Weakest axis: what a single `data-quality` attribute may say. */
      overall: weakestQuality(
        quality.tokenTotalQuality === QualityLevel.EXACT ? MetricQuality.EXACT : MetricQuality.ESTIMATED,
        quality.phaseSplitQuality === QualityLevel.EXACT ? MetricQuality.EXACT : MetricQuality.ESTIMATED,
      ),
    },
    /**
     * Provider/stream contradictions observed while aggregating. Never printed in
     * the production card (the quality downgrade already reaches the numbers); it
     * travels for diagnostics and for Phase 8's settings surface.
     */
    consistencyIssues: Array.isArray(settled.consistencyIssues) ? settled.consistencyIssues : [],
    /**
     * Retained for Phase 5's hover/focus curve view. Phase 4 renders no chart and
     * the component must not read this field.
     */
    curve: settled.curve ?? null,
  }
}

;Object.assign(__exports, { liveViewModel, completedStatusOf, completedViewModel })
			},
			"src/client/live/live-state.js": function (__exports) {
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

const LiveUiState = Object.freeze({
  INACTIVE: 'inactive',
  PENDING_FIRST_TOKEN: 'pending-first-token',
  STREAMING_REASONING: 'streaming-reasoning',
  STREAMING_OUTPUT: 'streaming-output',
  TOOL_RUNNING: 'tool-running',
  WAITING_MODEL: 'waiting-model',
  TRANSITION: 'transition',
  SETTLED: 'settled',
})

function initialLiveUi() {
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
const LIVE_UI_EVENT = Object.freeze({
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
function reduceLiveUi(machine, event) {
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

;Object.assign(__exports, { LiveUiState, initialLiveUi, LIVE_UI_EVENT, reduceLiveUi })
			},
			"src/client/live/live-presenter.js": function (__exports) {
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
 *   - pending state with an already-frozen TTFT        -> waiting
 *   - tool stage resolved from the machine OR the meter -> tool view, values
 *     strictly from the meter snapshot
 *
 * Every view carries `approximate` derived from metric quality: live TPS is
 * `estimated`, so it always renders with `≈`.
 */

const { MetricQuality, requiresApproximateMarker } = __req("src/core/quality-model.js")
const { completedViewModel } = __req("src/client/ui-model.js")
const { LiveUiState, initialLiveUi, reduceLiveUi } = __req("src/client/live/live-state.js")

const HIDDEN_STATES = new Set([LiveUiState.INACTIVE, LiveUiState.SETTLED])

class LivePresenter {
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

;Object.assign(__exports, { LivePresenter })
			},
			"src/client/live/cadence.js": function (__exports) {
/**
 * The live presentation cadence — the single source of truth.
 *
 * Before this module the same conceptual number existed in three places: the
 * controller's own default, the scheduler's own default and the value the meter
 * root handed the scheduler. Three defaults for one contract drift apart, and a
 * cadence that drifts is a cadence nobody measured. Everything that needs the
 * number now imports it from here.
 *
 * What this number is **not**:
 *
 *   - it is not the data-ingestion rate. Every model delta enters the store;
 *     the cadence bounds *presentation* only (`docs/METRICS_SPEC.md` §6);
 *   - it is not a rate-measurement window. Phase 9.2 removed the trailing window
 *     entirely: the live rate is a phase-cumulative average, so there is no
 *     interval for a refresh to shorten;
 *   - it is not the completed curve's sampling cadence. That is
 *     `DEFAULT_SAMPLE_EVERY_MS` in `src/core/curve.js`, and the two are
 *     different concepts that happen to be expressed in milliseconds.
 *
 * `PRESENTATION_REFRESH_CANDIDATES_MS` records the cadences that were actually
 * measured in a browser (Phase 5A A/B, and the Phase 9.2 comparison against
 * MiMo's ~100 ms). The selection rationale is in
 * `docs/IMPLEMENTATION_LOG.md`; the constant below is the winner.
 */

/**
 * Selected production cadence: 100 ms (10 presentation updates per second).
 *
 * Phase 9.2 moved the selection from 50 ms to 100 ms as a **fidelity** decision
 * rather than a performance one: MiMo's metric sampling and its visible
 * presentation are both ~100 ms (`docs/MIMO_RUNTIME_METRICS.md` §3), so a DSH
 * readout that updates on the same grid is directly comparable with it. 50 ms
 * (the Phase 5A winner) and 200 ms (the original baseline) are retained as
 * measured reference points, and the diagnostic override still reaches all three.
 */
const DEFAULT_PRESENTATION_REFRESH_MS = 100

/** The cadences the browser A/B runs actually measured, slowest first. */
const PRESENTATION_REFRESH_CANDIDATES_MS = Object.freeze([200, 100, 50, 10])

/**
 * Debug-only override key. Read exclusively while the diagnostic switch is on,
 * so the production cadence cannot be changed by anything a user can leave
 * behind in local storage.
 */
const REFRESH_OVERRIDE_STORAGE_KEY = 'dsh-turn-performance-meter.refreshMs'

/**
 * Coerce a stored override into a usable cadence.
 *
 * Anything that is not a finite positive number — absent key, empty string,
 * `NaN`, a negative interval — resolves to the selected production cadence
 * rather than to a broken `setInterval`, because a scheduler constructed with
 * `intervalMs <= 0` throws and would take the whole meter down with it.
 *
 * @param {unknown} candidate raw value (typically a local-storage string)
 * @returns {number} a finite interval in milliseconds
 */
function resolvePresentationRefreshMs(candidate) {
  const value = Number(candidate)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRESENTATION_REFRESH_MS
}

;Object.assign(__exports, { DEFAULT_PRESENTATION_REFRESH_MS, PRESENTATION_REFRESH_CANDIDATES_MS, REFRESH_OVERRIDE_STORAGE_KEY, resolvePresentationRefreshMs })
			},
			"src/client/live/controller.js": function (__exports) {
/**
 * Client presentation controller: the runtime wire between the DSH event
 * window, the telemetry store and the per-session live UI machines.
 *
 * Data flow (frozen architecture):
 *
 *   ctx.sessions.binding(id).eventSource   (SessionEventWindow, both planes)
 *       -> SessionEventFeed                (src/dsh: window wire -> normalized)
 *       -> TurnTelemetryStore + LivePresenter (per session, keyed state)
 *       -> React LiveMeter                 (throttled presentation only)
 *
 * Invariants this class exists to keep:
 *
 *   1. **Session/turn isolation.** One presenter (and therefore one UI state
 *      machine) per session; the store is keyed by `(sessionId, turn)`. There
 *      is no global "current turn" anywhere.
 *   2. **One subscription per session.** `attach` is idempotent; switching
 *      sessions back and forth can never double-subscribe an eventSource.
 *   3. **No statistics here.** The controller routes events; TPS, TTFT, tool
 *      wall time and elapsed come from `LiveMeter` snapshots.
 *   4. **Bounded lifecycle.** `dispose()` unsubscribes every eventSource and
 *      disposes the store — the HMR path.
 */

const { TurnTelemetryStore } = __req("src/host/telemetry-design.js")
const { turnKey } = __req("src/core/types.js")
const { tokenEvidence } = __req("src/core/delta-accounting.js")
const { NORMALIZED_KIND, applyRetryOutcomes, attemptFromDecoded } = __req("src/dsh/index.js")
const { SessionEventFeed } = __req("src/dsh/client-feed.js")
const { materializeReconstructedTurn } = __req("src/dsh/reconstruction.js")
const { LivePresenter } = __req("src/client/live/live-presenter.js")
const { DEFAULT_PRESENTATION_REFRESH_MS } = __req("src/client/live/cadence.js")

/**
 * Controller-level diagnostics raised on the completion path.
 *
 * `TURN_END_WITHOUT_RECORD` is the one that matters: §25 requires a lost terminal
 * boundary to be visible, because the alternative — a silent early return — is
 * indistinguishable from a turn that never ended.
 */
const CONTROLLER_ISSUE = Object.freeze({
  TURN_END_WITHOUT_RECORD: 'turn-end-without-record',
})

/**
 * Identity of a projected view: equal keys mean the picture is unchanged.
 *
 * The point of the key is the completed card. A settled turn's projection depends
 * on nothing that ticks, so its key is constant and the card is built exactly once
 * per settled turn even though events keep arriving. Every live field that can
 * change the rendering is enumerated, and anything not enumerated (per-delta
 * counters, sample arrays) deliberately cannot change a live value on its own —
 * the live view is a one-second window plus a wall clock, both of which are in
 * the key.
 */
function projectionKey(state, snapshot, atMs) {
  const machine = state.presenter.machine
  const phase = snapshot?.phase ?? 'none'
  if (machine.state === 'settled') return `settled:${machine.turn ?? ''}`
  const clock = Number.isFinite(atMs) ? atMs : 0
  /**
   * `turnElapsedMs` is in the key because every live view prints a running
   * elapsed value; a settled view prints none, which is why its key omits the
   * clock entirely and stays stable while deltas keep arriving.
   */
  return [
    machine.state,
    machine.turn ?? '',
    phase,
    Number.isFinite(snapshot?.turnElapsedMs) ? snapshot.turnElapsedMs : '',
    phase === 'streaming' ? Math.round(snapshot.tps ?? 0) : '',
    phase === 'tool' ? snapshot.runningToolCount ?? 0 : '',
    phase === 'tool' ? Math.round(snapshot.toolElapsedMs ?? 0) : '',
    machine.sinceMs ?? '',
    clock,
  ].join('|')
}

/**
 * @param {{
 *   sessions?: {binding?: (id: string) => {eventSource: object}|undefined},
 *   refreshMs?: number,
 *   debug?: boolean,
 *   nowMs?: () => number,
 * }} [options]
 */
function createController({
  sessions,
  refreshMs = DEFAULT_PRESENTATION_REFRESH_MS,
  debug = false,
  nowMs = () => Date.now(),
} = {}) {
  const store = new TurnTelemetryStore()
  /** @type {Map<string, object>} sessionId -> session state */
  const sessionsMap = new Map()
  const listeners = new Set()
  let disposed = false

  const log = debug
    ? (...args) => { try { console.debug('[dsh-turn-performance-meter]', ...args) } catch { /* never break telemetry for a log */ } }
    : () => {}

  function emit() {
    if (disposed) return
    for (const listener of [...listeners]) {
      try { listener() } catch { /* a broken listener must not stop ingestion */ }
    }
  }

  /** Resolve the turn record an event belongs to; `null` when none exists. */
  function lookupRecord(state, turn) {
    if (Number.isFinite(turn)) return store.turns.get(turnKey(state.sessionId, turn)) ?? null
    return state.currentRecord
  }

  /** Drop whatever the last projection cached, including its settled-turn read. */
  function invalidate(state) {
    state.viewCache = undefined
    state.settledRead = undefined
  }

  function applyEvent(state, event) {
    const sessionId = state.sessionId
    switch (event.kind) {
      case 'window-rebaseline': {
        // A `replace` swapped the window (reload/reconnect). Local live state
        // belongs to the superseded window; replay begins from a clean machine
        // rather than fabricating continuity.
        //
        // The store is reset **first**, and it is the step that matters. The
        // presenter machine and the two identifiers below are presentation state;
        // the evidence is `store.turns` (attempts, samples, usage, tool intervals)
        // and the per-session `LiveMeter`, and both outlive a presenter reset.
        // Leaving them in place makes the replay land inside attempts the
        // superseded generation already filled — `beginTurn` is idempotent and
        // `beginAttempt` returns the existing attempt — so a replayed delta is
        // appended rather than replacing, and the turn reports one sample per
        // republication of the window.
        //
        // The reset is scoped to this session: a rebaseline of one conversation is
        // not evidence about any other.
        log('stream gap/rebaseline', sessionId)
        store.rebaselineSession(sessionId)
        state.presenter.apply({ type: 'reset' })
        state.currentRecord = null
        state.openAttemptId = null
        state.observedTurnStart = null
        invalidate(state)
        return
      }

      case NORMALIZED_KIND.TURN_START: {
        /**
         * `recovered` marks a boundary the feed *derived* from transient
         * evidence (mid-turn attach) rather than observed as a durable event.
         * The record is opened with an unknown start time (`timeMs: null`), so
         * TTFT and turn elapsed stay unknown instead of being measured from the
         * reload.
         */
        const recovered = event.recovered === true
        state.currentRecord = store.beginTurn({
          sessionId,
          turn: event.turn,
          timeMs: recovered ? null : event.timeMs,
        })
        /**
         * The durable `turn/start` can arrive **after** the turn was adopted: the
         * window is a live tail, so a reconnect (or the tail sliding back over
         * the row) publishes it mid-turn. It is then an upgrade of an unknown
         * start to the observed one, never a restart of the metrics — the
         * attempt boundaries, deltas and first-token stamp already collected for
         * this turn are kept. The inverse is impossible by construction: only a
         * `recovered` event carries `timeMs: null`, and such an event is emitted
         * exactly once per turn, when the turn is first adopted.
         */
        store.turnStartObserved(state.currentRecord, { timeMs: event.timeMs })
        /**
         * Only an *observed* boundary is kept: a recovered adoption carries
         * `timeMs: null` and must not become the start a later reconstruction
         * reports as measured.
         */
        if (!recovered && Number.isFinite(event.timeMs)) {
          state.observedTurnStart = { turn: event.turn, timeMs: event.timeMs }
        }
        state.presenter.apply({ type: 'turn-start', turn: event.turn, timeMs: event.timeMs, recovered })
        /** A new turn supersedes the previous card in this same advance. */
        state.settledRead = undefined
        log(recovered ? 'turn adopted (mid-turn attach)' : 'turn open', sessionId, event.turn)
        return
      }

      case NORMALIZED_KIND.STEP_START: {
        state.presenter.apply({ type: 'step-start', turn: event.turn, step: event.step, timeMs: event.timeMs })
        return
      }

      case NORMALIZED_KIND.STEP_END:
        return

      case NORMALIZED_KIND.ATTEMPT_START: {
        const record = lookupRecord(state, event.turn)
        if (record !== null) {
          store.beginAttempt(record, { attemptId: event.attemptId, step: event.step, startedAtMs: event.timeMs })
        }
        state.openAttemptId = event.attemptId
        state.presenter.apply({
          type: 'attempt-start',
          attemptId: event.attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('attempt start', sessionId, event.attemptId)
        return
      }

      case NORMALIZED_KIND.ATTEMPT_DELTA: {
        const record = lookupRecord(state, event.turn)
        if (record === null) {
          // No turn boundary has been observed (a window that no longer
          // contains this turn's `turn/start`). Fabricating a start time would
          // corrupt TTFT, so the delta is reported and dropped instead.
          state.droppedDeltas = (state.droppedDeltas ?? 0) + 1
          return
        }
        let attempt = record.attemptIndex.get(event.attemptId)
        if (attempt === undefined) {
          // The feed always emits `attempt-start` before an attempt's first
          // delta; this is the defensive path for a mid-turn attach.
          attempt = store.beginAttempt(record, {
            attemptId: event.attemptId,
            step: event.step ?? null,
            startedAtMs: event.timeMs,
          })
        }
        const sample = store.acceptChunk(record, attempt, { timeMs: event.timeMs, chunk: event.chunk })
        if (sample !== null) {
          // Only model-producing deltas drive the state machine; the machine's
          // first accepted delta is what freezes the turn TTFT stage.
          state.presenter.apply({
            type: 'delta',
            attemptId: event.attemptId,
            turn: record.turn,
            phase: sample.phase,
            timeMs: sample.timeMs,
          })
          return
        }
        /**
         * No accepted sample — and that no longer ends the story. A name-bearing
         * `tool-call-delta` whose argument fragment is still empty is accepted by
         * DSH's `isTokenDelta` and rejected by `classifyDelta`, so it produces no
         * TPS-shape sample while remaining the model's **first token**. Returning
         * here is exactly the defect Phase 9.4 removes: the machine stayed in
         * `pending-first-token` and the pill kept rendering the first-response
         * stopwatch after the boundary had passed.
         *
         * The boundary is applied as a delta event so the machine advances to its
         * streaming stage, and nothing else happens: the store has frozen the
         * turn's TTFT, updated the phase identity, and recorded the phase cut it
         * declares, and it has opened **no** magnitude episode — so no episode
         * clock, no numerator and no rate exist for a chunk whose argument text
         * does not exist yet. (Before Phase 9.4.2 this comment claimed the
         * boundary had opened the episode clock. It never should have: a
         * boundary-only delta carries no magnitude, so an origin taken from it
         * would have been a denominator origin the completed curve could not
         * reproduce.)
         */
        const evidence = tokenEvidence(event.chunk)
        if (!evidence.countsAsToken) return
        state.presenter.apply({
          type: 'delta',
          attemptId: event.attemptId,
          turn: record.turn,
          phase: evidence.phase,
          timeMs: event.timeMs,
        })
        return
      }

      case NORMALIZED_KIND.ATTEMPT_SETTLE: {
        const record = lookupRecord(state, event.turn)
        let attemptId = event.attemptId ?? state.openAttemptId
        /**
         * A durable settlement arriving as a plain event carries no `attemptId`,
         * so it is correlated to the one attempt of its `(turn, step)` that has
         * not settled yet. The correlation demands a *unique* candidate: if two
         * unsettled attempts share the step, the settlement belongs to neither
         * provably, and the durable record is restored as its own attempt instead
         * of being attached to a guess.
         */
        if ((attemptId === null || attemptId === undefined) && record !== null && Number.isFinite(event.step)) {
          const open = record.attempts.filter(candidate => (
            candidate.settlementKind === 'none' && candidate.step === event.step
          ))
          if (open.length === 1) attemptId = open[0].attemptId
        }
        if (record !== null && attemptId !== null && attemptId !== undefined) {
          const attempt = record.attemptIndex.get(attemptId)
          if (attempt !== undefined) {
            /**
             * ## The mixed plane: the settlement completes the attempt it settles
             *
             * This is the one path where both planes already hold evidence for the
             * *same* attempt. A reload leaves a transient attempt holding only the
             * tail its window could still see, and the settlement that closes that
             * attempt carries the authoritative complete compact stream. Phase
             * 9.4.3 taught the completed curve to read a non-magnitude phase cut,
             * but only the two *pure* planes routed it: here the correlation
             * succeeded, `settleAttempt` ran, and `event.decoded` was ignored — so
             * a boundary, and every delta before the reload, survived on the live
             * card and vanished from the reloaded one.
             *
             * Correlating and then discarding is also the one combination the
             * correlation rules do **not** justify. A proven correlation is a
             * statement that this settlement's stream *is* this attempt's stream,
             * and a settlement's embedded stream is the whole attempt: replacing
             * the stream-derived evidence with it is completing the record, not
             * merging two records. The alternative — appending — is unavailable in
             * principle, because the two planes share no per-delta identity and an
             * overlapped delta would be counted twice (`reconcileAttemptStream`).
             *
             * The refusal is as load-bearing as the replacement: a decode with any
             * malformed record is not the whole attempt, so it is declined and the
             * transient evidence — which may well hold deltas the decode lost —
             * is left exactly as it stands. Phase 9.4.5 names the second half of
             * that: an attempt whose decode was refused keeps its `live` temporal
             * authority, so the settled card reports an `estimated` shape. A finite
             * `settlementSeq` and an authoritative usage counter are still recorded
             * — the settlement happened and the tokens are the provider's — but
             * neither of them says the attempt's *timeline* is a durable
             * reconstruction. The refusal is counted as
             * `settlementStreamsRejected`, not as an unproved correlation.
             */
            if (event.decoded !== undefined) {
              const reconciliation = store.reconcileAttemptStream(record, attempt, { decoded: event.decoded })
              if (reconciliation.reconciled) state.counters.settlementStreamsReconciled += 1
              else state.counters.settlementStreamsRejected += 1
              log(
                'attempt stream reconciled', sessionId, attemptId, reconciliation.reason,
                reconciliation.samples, reconciliation.cuts,
              )
            }
            store.settleAttempt(attempt, {
              settledAtMs: event.timeMs,
              settlementKind: event.settlementKind,
              surfaceCommitted: event.surfaceCommitted,
              attemptOutcome: event.attemptOutcome,
              usage: event.usage ?? null,
              usageSource: event.usageSource ?? null,
              settlementSeq: event.seq,
            })
          }
        } else if (record !== null && event.decoded !== undefined) {
          /**
           * Durable-only settlement: the window carries the settlement (and its
           * embedded compact stream), but the attempt's transient rows are gone —
           * the reload case. The durable record is the complete evidence for that
           * attempt, so it is restored from the decode rather than dropped: a
           * refresh must be able to show the last completed turn without ever
           * having observed it live. Nothing is invented here — the attempt's
           * samples, usage and settlement metadata all come from the durable row.
           */
          const restored = attemptFromDecoded({
            attemptId: `durable:${event.seq ?? record.attempts.length}`,
            turn: record.turn,
            step: event.step ?? null,
            decoded: event.decoded,
            usage: event.usage ?? null,
            usageSource: event.usageSource ?? null,
            settlementKind: event.settlementKind,
            surfaceCommitted: event.surfaceCommitted,
            attemptOutcome: event.attemptOutcome,
            settledAtMs: event.timeMs,
            settlementSeq: event.seq,
            /**
             * Which durable surface settled the attempt. `settleAttempt` does not
             * carry it — it is not part of the settlement *state* the store is asked
             * to record — so it is attached to the restored attempt directly, which is
             * what the durable reconstruction path publishes and therefore what makes
             * a restored attempt comparable with a reconstructed one.
             */
            settlementEventType: event.eventType ?? null,
            interrupted: event.interrupted === true,
            issues: event.issues ?? [],
          })
          record.attempts.push(restored)
          record.attemptIndex.set(restored.attemptId, restored)
          /**
           * The settlement carried a decoded stream and could not be joined to an
           * existing attempt — either no attempt was proved to own it, or more than
           * one candidate made the pairing unprovable and the correlation refused to
           * guess. Counted, so a refused join is visible in `diagnostics()` rather
           * than indistinguishable from a settlement that never carried a stream.
           *
           * This is the *uncorrelated* outcome and not the *rejected* one: nothing
           * was proved about an existing attempt here, so no existing record's
           * evidence was refused. The restored attempt's own temporal authority is
           * whatever the decode it was built from supports
           * (`attemptFromDecoded`), and a malformed stream restores a
           * `durable-incomplete` attempt rather than a durable-complete one.
           */
          state.counters.settlementStreamsUncorrelated += 1
          /**
           * The turn TTFT is `turn/start -> first chunk DSH's predicate accepts`,
           * and a restored attempt brings that instant with it: `decoded` carries
           * the boundary from the compact stream itself, so a name-bearing
           * tool-call delta whose argument fragment stayed empty is counted
           * exactly as the live path counts it. Taking the earliest *sample*
           * instead — as an earlier revision did — would silently miss that
           * boundary and report `—` for a TTFT the live session had measured.
           *
           * `firstTokenObserved` is the same one-way freeze the live path uses, so
           * replaying a settlement can never move an instant already recorded.
           */
          const restoredFirstTokenMs = Number.isFinite(restored.firstTokenMs)
            ? restored.firstTokenMs
            : restored.samples.reduce(
              (earliest, sample) => (Number.isFinite(sample.timeMs) && (earliest === null || sample.timeMs < earliest)
                ? sample.timeMs
                : earliest),
              null,
            )
          store.firstTokenObserved(record, { timeMs: restoredFirstTokenMs })
          state.durableAttempts = (state.durableAttempts ?? 0) + 1
          log('durable attempt restored', sessionId, restored.attemptId, restored.samples.length)
        }
        if (state.openAttemptId === attemptId) state.openAttemptId = null
        state.presenter.apply({
          type: 'attempt-settle',
          attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('attempt settle', sessionId, attemptId, event.settlementKind, event.attemptOutcome)
        return
      }

      case NORMALIZED_KIND.ATTEMPT_ABANDON: {
        const record = lookupRecord(state, event.turn)
        const attemptId = event.attemptId ?? state.openAttemptId
        if (record !== null && attemptId !== null && attemptId !== undefined) {
          const attempt = record.attemptIndex.get(attemptId)
          if (attempt !== undefined) {
            store.settleAttempt(attempt, {
              settledAtMs: event.timeMs ?? null,
              settlementKind: event.settlementKind ?? 'none',
              surfaceCommitted: false,
              attemptOutcome: event.attemptOutcome ?? 'abandoned',
            })
          }
        }
        if (state.openAttemptId === attemptId) state.openAttemptId = null
        state.presenter.apply({
          type: 'attempt-abandon',
          attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs ?? null,
        })
        log('attempt abandoned', sessionId, attemptId)
        return
      }

      case NORMALIZED_KIND.RETRY_SCHEDULED: {
        const record = lookupRecord(state, event.turn)
        if (record !== null) applyRetryOutcomes(record.attempts, [event])
        state.presenter.apply({
          type: 'retry',
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('retry scheduled', sessionId, event.turn, event.step)
        return
      }

      case NORMALIZED_KIND.TOOL_CALL: {
        const record = lookupRecord(state, event.turn)
        if (record === null) return
        store.toolStarted(record, { callId: event.callId, name: event.name, timeMs: event.timeMs })
        state.presenter.apply({ type: 'tool-start', turn: record.turn, timeMs: event.timeMs, name: event.name })
        log('tool start', sessionId, event.name)
        return
      }

      case NORMALIZED_KIND.TOOL_RESULT: {
        const record = lookupRecord(state, event.turn)
        if (record === null) return
        const call = store.toolSettled(record, {
          callId: event.callId,
          timeMs: event.timeMs,
          status: event.status,
        })
        if (call === null) {
          state.unmatchedToolResults = (state.unmatchedToolResults ?? 0) + 1
          return
        }
        state.counters.matchedToolResults += 1
        state.presenter.apply({ type: 'tool-end', turn: record.turn, timeMs: event.timeMs })
        log('tool end', sessionId, call.name, event.status)
        return
      }

      case NORMALIZED_KIND.TURN_END: {
        state.counters.normalizedTurnEndSeen += 1
        let record = lookupRecord(state, event.turn)
        if (record === null) {
          /**
           * §25: a terminal boundary with no record to close is **not** silent.
           *
           * The record is normally present — `turn/start` opened it, or a
           * transient row adopted the turn — but the published window is a live
           * *tail*, so a client that attached after the turn began can receive
           * `turn/end` for a turn whose opening row is outside the window and
           * whose transient rows were already superseded.
           *
           * The turn genuinely ended: DSH published the authoritative boundary. The
           * record is therefore reconstructed from the turn's own **durable
           * evidence**, which the feed has been retaining since the window
           * generation began — the `assistant/message` settlements with their
           * embedded compact streams, the `tool/call` and `tool/result` boundaries,
           * the step and retry rows:
           *
           *     feed.turnEvents(turn) -> materializeReconstructedTurn()
           *         -> store.beginAttempt/acceptChunk/setAttemptUsage/settleAttempt
           *         -> store.toolStarted/toolSettled
           *         -> store.endTurn() -> aggregateTurn -> curveSource -> attemptTraces
           *
           * Two earlier revisions are worth naming, because both look plausible and
           * both are wrong. Phase 7D opened an **empty** record here and closed it,
           * so the card appeared with zero attempts, zero tokens and no tools while
           * the evidence for all of them was in the window it had just read. Decoding
           * that evidence here would have created a third durable parser; every field
           * below instead comes from `reconstructFromDurable`
           * (`src/dsh/durable-path.js`), which stays the only module that decodes a
           * settlement.
           *
           * Nothing is fabricated. `startMs` is whatever the retained evidence
           * actually contains: with no `turn/start` row it stays `null`, exactly as
           * the mid-turn-attach path leaves it, so no elapsed time and no TTFT is
           * measured from the reconstruction. `observedTurnStart` is consulted only
           * for a turn whose `turn/start` this session *did* observe but whose record
           * is gone — the reconstruction reports the same instant — never as a
           * substitute for a boundary nobody saw.
           */
          state.counters.turnEndLookupMiss += 1
          state.counters.turnEndReconstructed += 1
          const observed = state.observedTurnStart
          const observedStartMs = observed !== null && observed.turn === event.turn ? observed.timeMs : null
          const materialized = materializeReconstructedTurn({
            store,
            sessionId,
            turn: event.turn,
            events: state.feed.turnEvents(event.turn),
          })
          record = materialized.record
          if (Number.isFinite(observedStartMs)) {
            store.turnStartObserved(record, { timeMs: observedStartMs })
          }
          /**
           * The machine must own the turn identity before it can settle it: a
           * session whose machine is still `inactive` refuses a `turn-end`
           * (`live-state.js` `wrongTurn`), which is correct for a stray boundary
           * and wrong for this one. Opening the turn as a **recovered** boundary
           * is the same construction the mid-turn attach uses — it is inferred,
           * so it carries no start instant of its own.
           */
          state.presenter.apply({ type: 'turn-start', turn: event.turn, timeMs: null, recovered: true })
          state.feedIssues = state.feedIssues ?? []
          if (state.feedIssues.length < 100) {
            state.feedIssues.push({
              kind: CONTROLLER_ISSUE.TURN_END_WITHOUT_RECORD,
              detail: {
                turn: event.turn,
                seq: event.seq,
                reconstructedAttempts: materialized.reconstructed.attempts.length,
                reconstructedTools: materialized.reconstructed.tools.length,
                startKnown: Number.isFinite(record.startMs),
              },
            })
          }
          log('turn/end without a record; reconstructed from durable evidence', sessionId, event.turn)
        } else {
          state.counters.turnEndLookupHit += 1
        }
        state.counters.storeEndTurnCalled += 1
        const settled = store.endTurn(record, { timeMs: event.timeMs, status: event.status, statusNote: event.note })
        state.counters.settledSnapshotBuilt += 1
        state.currentRecord = null
        state.openAttemptId = null
        state.observedTurnStart = null
        state.presenter.apply({ type: 'turn-end', turn: event.turn, timeMs: event.timeMs, status: event.status })
        state.counters.presenterTurnEndApplied += 1
        /**
         * The settled turn is now readable. Both the settled snapshot and the
         * settled machine are in place before the projection is invalidated, so
         * the very next `project()` returns the completed card — never `null`
         * followed by a card one tick later.
         */
        invalidate(state)
        log('turn close', sessionId, event.turn, event.status)
        if (Array.isArray(settled?.consistencyIssues) && settled.consistencyIssues.length > 0) {
          log('quality downgrade', ...settled.consistencyIssues)
        }
        return
      }

      case NORMALIZED_KIND.IGNORED:
        state.ignoredEvents = (state.ignoredEvents ?? 0) + 1
        return

      default:
        state.unknownEvents = (state.unknownEvents ?? 0) + 1
    }
  }

  return {
    refreshMs,
    store,

    /**
     * Subscribe one session's eventSource exactly once. Returns `true` when a
     * subscription now exists for this session (fresh or already attached).
     */
    attach(sessionId) {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') return false
      if (sessionsMap.has(sessionId)) return true
      const binding = typeof sessions?.binding === 'function' ? sessions.binding(sessionId) : undefined
      if (binding === undefined || binding === null || binding.eventSource === undefined || binding.eventSource === null) {
        log('binding unavailable', sessionId)
        return false
      }
      const source = binding.eventSource
      const state = {
        sessionId,
        presenter: new LivePresenter(),
        feed: null,
        unsub: null,
        currentRecord: null,
        openAttemptId: null,
        ignoredEvents: 0,
        droppedDeltas: 0,
        unmatchedToolResults: 0,
        unknownEvents: 0,
        /**
         * The start instant of the open turn, as the durable `turn/start` row
         * declared it, tagged with the turn it belongs to. Kept beside the record
         * so a `turn/end` that arrives after its own opening row left the window
         * can still close the turn with the observed boundary rather than a
         * `null` one — and scoped by turn, because a start observed for one turn
         * is not evidence about another.
         */
        observedTurnStart: null,
        /**
         * Completion-path counters. Debug-only and off by default: each is an
         * integer incremented inside a handler that already runs, nothing is
         * allocated per event, and they are read only by `diagnostics()`.
         */
        counters: {
          normalizedTurnEndSeen: 0,
          turnEndLookupHit: 0,
          turnEndLookupMiss: 0,
          /**
           * A terminal record materialized from the turn's available durable
           * evidence. Phase 7D.1 narrows what this counter may be read as: before it,
           * the miss path opened an empty record and closed it, so the counter was
           * satisfied by a reconstruction that had consumed nothing. It now counts
           * one reconciliation only — `turn/end` arrived, no record existed, and a
           * record was built from `feed.turnEvents(turn)` through
           * `reconstructFromDurable`. It deliberately does **not** claim the evidence
           * was non-empty: a turn whose only visible row is its own `turn/end`
           * reconstructs to an empty turn, which is the correct answer and is counted
           * here too. Read it as "the miss was reconciled", never as "metrics were
           * recovered" — the issue detail carries the recovered attempt and tool
           * counts for a caller that needs the distinction.
           */
          turnEndReconstructed: 0,
          storeEndTurnCalled: 0,
          presenterTurnEndApplied: 0,
          settledSnapshotBuilt: 0,
          matchedToolResults: 0,
          /**
           * The mixed plane, counted where it is decided (Phase 9.4.4, split into
           * three facts in Phase 9.4.5).
           *
           * Three outcomes are distinguishable, and collapsing any two of them
           * would misstate what happened:
           *
           *   - `settlementStreamsReconciled` — the correlation was proved **and**
           *     the decoded stream was complete, so it replaced that attempt's
           *     stream-derived evidence;
           *   - `settlementStreamsUncorrelated` — no unique attempt was proved to
           *     own the settlement (or none existed at all), so the existing
           *     durable-restoration policy restored it as its own attempt;
           *   - `settlementStreamsRejected` — the correlation **was** proved and the
           *     reconciliation refused anyway, which today means `decoded.complete
           *     !== true`. The transient evidence stands.
           *
           * Phase 9.4.4 counted both non-reconciled outcomes as
           * `settlementStreamsUncorrelated`. That was false for the rejected case:
           * the settlement *was* correlated, and the attempt it was correlated to
           * is exactly the record the refusal had to protect. Reading "the
           * correlation failed" from a refused decode is how a replaced-stream
           * regression would have looked identical to an incomplete decode.
           */
          settlementStreamsReconciled: 0,
          settlementStreamsUncorrelated: 0,
          settlementStreamsRejected: 0,
        },
        /** The kind of view the last `project()` returned. */
        projectedViewKind: null,
      }
      state.feed = new SessionEventFeed({
        sessionId,
        onEvent: event => {
          applyEvent(state, event)
          // Every handled event invalidates presentation. The listener is the
          // scheduler's coalescing notify, so this stays cheap even at one
          // call per streamed delta (no render happens here — the scheduler
          // throttles, and the visible ticker already covers updates).
          emit()
        },
        onIssue: issue => {
          state.feedIssues = state.feedIssues ?? []
          if (state.feedIssues.length < 100) state.feedIssues.push(issue)
          log('feed issue', sessionId, issue.kind, issue.detail)
        },
      })
      const read = () => {
        try {
          state.feed.applyWindow(source.getSnapshot())
        } catch (error) {
          log('event window read failed', sessionId, error)
        }
      }
      // Subscribe first, then the initial full pass: a mutation racing the
      // attach is delivered by the subscription and the revision guard makes
      // the overlapping read idempotent.
      state.unsub = source.subscribe(read)
      read()
      sessionsMap.set(sessionId, state)
      log('session attach', sessionId)
      return true
    },

    /** Detach presentation interest; the subscription itself stays (see docs). */
    detach(sessionId) {
      log('session detach', sessionId)
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * The current presentation model for one session.
     *
     * Precedence, frozen in Phase 4: an open turn wins over a settled one. The
     * completed card and the live meter are never both available, so the switch
     * is a single state advance:
     *
     *   - a settled machine projects the latest settled turn (the card);
     *   - a `turn/end` therefore replaces the pill with the card in the same
     *     publish — there is no intermediate "nothing" frame;
     *   - a following `turn/start` replaces the card with the pill in the same
     *     publish — the old card never lingers beside a new turn.
     *
     * The result is memoized per `(session, projection identity)`: while nothing
     * that can change the picture has changed, the same object is returned, so a
     * static card cannot be rebuilt once per ingested delta. The identity of a
     * completed card is its turn, which is exactly the rule "one card per settled
     * turn".
     */
    project(sessionId, atMs = nowMs()) {
      const state = sessionsMap.get(sessionId)
      if (disposed || typeof sessionId !== 'string' || state === undefined) {
        return { kind: 'hidden', state: 'inactive', turn: null }
      }
      /**
       * The settled turn is read as evidence, once per session state object, in
       * the same synchronous step that reads the meter — which is what makes the
       * live/completed handover atomic rather than a two-tick sequence.
       */
      if (state.settledRead === undefined) state.settledRead = store.latestSettled(sessionId)
      const snapshot = store.liveSnapshot(sessionId, atMs)
      const key = projectionKey(state, snapshot, atMs)
      const cached = state.viewCache
      if (cached !== undefined && cached.key === key && cached.sessionId === sessionId) return cached.view

      const view = state.presenter.project(snapshot, atMs, state.settledRead)
      state.viewCache = { key, sessionId, view }
      state.projectedViewKind = view.kind
      return view
    },

    /**
     * Diagnostics for tests and debug tooling.
     *
     * Two groups, each counted where the fact happens rather than derived later:
     * the feed's raw-vs-interpreted counters answer "did the wire deliver it", and
     * the controller's answer "what did the plugin do with it". A terminal
     * boundary lost on the completion path is then readable as the first counter
     * that stayed at zero — `rawTurnEndSeen` for a wire that never published it,
     * `turnEndLookupMiss` for a boundary that arrived with no record to close.
     */
    diagnostics(sessionId) {
      const state = sessionsMap.get(sessionId)
      if (state === undefined) return null
      const meter = store.liveBySession.get(sessionId)
      const unresolved = meter === undefined ? 0 : meter.runningTools().length
      return {
        feedIssues: state.feedIssues ?? [],
        ignoredEvents: state.ignoredEvents ?? 0,
        droppedDeltas: state.droppedDeltas ?? 0,
        unmatchedToolResults: state.unmatchedToolResults ?? 0,
        unknownEvents: state.unknownEvents ?? 0,
        projectedViewKind: state.projectedViewKind ?? null,
        /**
         * §37 keeps three quantities apart, and these are the live pair.
         *
         * `liveRunningTools` is `live.runningTools().length`: the calls the meter
         * still holds unresolved. `livePresentedToolCount` is what the live pill
         * would actually print — the same number, but only while the tool stage
         * owns the view. They differ in exactly one situation, and it is the one
         * §27 describes: a turn that ended with a call whose result was never
         * observed. Presentation closes; the unresolved call stays on the record
         * as incomplete evidence rather than being cleared or given an end time.
         *
         * Both are read from the meter's own state rather than from a snapshot: a
         * snapshot evaluated at the wall clock *evicts* expired samples from the
         * rolling window, so a diagnostic that took one would silently change the
         * rate it was only supposed to observe.
         */
        liveRunningTools: unresolved,
        livePresentedToolCount: meter !== undefined && meter.phase === 'tool' ? unresolved : 0,
        counters: { ...(state.feed?.counters ?? {}), ...state.counters },
      }
    },

    /** Attached session ids, for lifecycle assertions. */
    attachedSessions() {
      return [...sessionsMap.keys()]
    },

    /** Tear down every subscription and all stored state (HMR / unload). */
    dispose() {
      if (disposed) return
      disposed = true
      for (const state of sessionsMap.values()) {
        try { state.unsub?.() } catch { /* best effort */ }
      }
      sessionsMap.clear()
      listeners.clear()
      store.dispose()
      log('controller disposed')
    },
  }
}

;Object.assign(__exports, { CONTROLLER_ISSUE, createController })
			},
			"src/client/live/refresh.js": function (__exports) {
/**
 * Presentation refresh scheduler.
 *
 * The ingestion path is high-frequency (hundreds to thousands of deltas per
 * attempt — the recorded t5 fixture alone has 1315 transient frames), while
 * React must render at a bounded cadence. The contract:
 *
 *   - while the meter is visible, exactly ONE interval renders, at
 *     `intervalMs` (default `DEFAULT_PRESENTATION_REFRESH_MS` from
 *     `./cadence.js` — the single source for the selected cadence);
 *   - while the meter is hidden, an event schedules at most one coalesced
 *     zero-delay render, so a turn start becomes visible immediately without
 *     per-event rendering;
 *   - `stop()`/`dispose()` clear every timer — unmount, HMR remount and
 *     session switches must never leave an interval behind;
 *   - at no point are there more than two live timers (one interval, one
 *     pending leading render).
 *
 * Deltas are never dropped on the data side: the scheduler throttles
 * *presentation only*. The timer implementations are injectable so tests can
 * assert the structural properties without wall-clock benchmarks.
 */

const { DEFAULT_PRESENTATION_REFRESH_MS } = __req("src/client/live/cadence.js")



/**
 * @param {{
 *   intervalMs?: number,
 *   onRender: () => void,
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout,
 *   setIntervalImpl?: typeof setInterval,
 *   clearIntervalImpl?: typeof clearInterval,
 * }} options
 */
function createPresentationScheduler({
  intervalMs = DEFAULT_PRESENTATION_REFRESH_MS,
  onRender,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  if (typeof onRender !== 'function') throw new TypeError('scheduler requires an onRender callback')
  if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) throw new TypeError('intervalMs must be a finite number > 0')

  let intervalId = null
  let leadId = null
  let disposed = false

  function flushLead() {
    leadId = null
    if (!disposed) onRender()
  }

  return {
    intervalMs,

    /** Whether the periodic presentation ticker is running. */
    get ticking() {
      return intervalId !== null
    },

    /** Whether `dispose()` has permanently disabled this scheduler. */
    get disposed() {
      return disposed
    },

    /** Count of live timers this scheduler owns (0..2), for structural tests. */
    get timerCount() {
      return (intervalId === null ? 0 : 1) + (leadId === null ? 0 : 1)
    },

    /**
     * Data-side notification. While the ticker runs it already covers the
     * update; while hidden, one coalesced zero-delay render is scheduled.
     */
    notify() {
      if (disposed || intervalId !== null) return
      if (leadId === null) leadId = setTimeoutImpl(flushLead, 0)
    },

    /** Begin the bounded periodic refresh (called while the view is visible). */
    start() {
      if (disposed || intervalId !== null) return
      intervalId = setIntervalImpl(onRender, intervalMs)
    },

    /** Stop the ticker (called when the view hides or the component unmounts). */
    stop() {
      if (intervalId !== null) {
        clearIntervalImpl(intervalId)
        intervalId = null
      }
      if (leadId !== null) {
        clearTimeoutImpl(leadId)
        leadId = null
      }
    },

    /** Final cleanup: no timer may survive this call. */
    dispose() {
      disposed = true
      this.stop()
    },
  }
}

;Object.assign(__exports, { DEFAULT_PRESENTATION_REFRESH_MS, createPresentationScheduler })
			},
			"src/client/live/live-format.js": function (__exports) {
/**
 * Live-view formatting.
 *
 * Formatting rules with a correctness dimension:
 *
 *   - a live TPS value always carries `≈`: its quality is `estimated`
 *     unconditionally (METRICS_SPEC §11.5), so a bare number would imply a
 *     provider-exactness that does not exist;
 *   - absent evidence renders as the shared em dash, never as `0`;
 *   - tool names truncate with an ellipsis instead of stretching the pill;
 *   - a multi-tool label always distinguishes itself from a single tool.
 */

const { countdownParts, formatCountdown, formatDuration, formatSeconds, formatTps, DASH } = __req("src/client/format.js")

/**
 * Approximate TPS rendering: `≈338`, `≈38.4`, `—` for absent evidence.
 * Exact values would render bare, but live values are never exact.
 */
function formatApproxTps(value, approximate = true) {
  if (!Number.isFinite(value)) return DASH
  return approximate ? `≈${formatTps(value)}` : formatTps(value)
}

/** Turn elapsed / stage elapsed: `17.3s`, `2m22s` (shared duration rules). */
function formatElapsed(ms) {
  return formatDuration(ms)
}

/** TTFT stopwatch and waiting stopwatch: `2.80 s`. */
function formatStopwatch(ms, digits = 2) {
  return formatCountdown(ms, digits)
}

/**
 * The same stopwatch as separately styleable parts: `2.80` + `s`.
 *
 * The live pill renders the number at the top of its type scale and the unit two
 * steps below it, which is only possible if the two are separate runs.
 *
 * A non-finite duration is `{ value: '—', unit: null }` — the shared em dash with
 * no unit, this file's rule for absent evidence — and **not** a zeroed stopwatch.
 * The distinction matters for the live pill: `0` is a measured zero-length
 * duration, while `null` means the duration does not exist (no phase episode is
 * open yet, or the turn start was never observed).
 */
function stopwatchParts(ms, digits = 2) {
  return countdownParts(ms, digits)
}

/** Long tool names are truncated so the pill never overflows. */
function truncateToolName(name, max = 20) {
  if (typeof name !== 'string' || name.length === 0) return DASH
  if (name.length <= max) return name
  return `${name.slice(0, max - 1)}…`
}

/**
 * Compact tool label:
 *
 *   1 tool   `pwsh`            (long names truncate)
 *   2+ tools `pwsh +1`         (first name plus how many others)
 *   unknown  `×2`
 *
 * The count suffix is locale-independent on purpose: digits stay tabular and
 * the single/multi distinction survives every locale.
 */
function formatToolLabel(names, count) {
  const list = Array.isArray(names) ? names.filter(name => typeof name === 'string' && name.length > 0) : []
  // A count is a number of calls: it is rounded before use so a fractional input
  // can never render as `+1.7000000000000002`.
  const total = Number.isFinite(count) && count > 0 ? Math.round(count) : list.length
  if (total <= 0) return DASH
  if (total === 1) return truncateToolName(list[0] ?? DASH)
  const first = list.length > 0 ? `${truncateToolName(list[0])} ` : ''
  return `${first}+${total - 1}`
}



;Object.assign(__exports, { DASH, formatTps, formatApproxTps, formatElapsed, formatStopwatch, stopwatchParts, truncateToolName, formatToolLabel })
			},
			"src/client/live/LiveMeter.js": function (__exports) {
/**
 * Live meter pill (browser only — this module imports `react`, so Node tests must
 * not import it directly; `test/client-bundle.test.js` loads it through the built
 * bundle with a stubbed module table).
 *
 * Rendering contract:
 *
 *   - the component receives a finished view model from `LivePresenter` and
 *     formats strings; it never parses events, never computes TPS/TTFT/tool
 *     time, and never touches raw `SessionEvent` shapes;
 *   - presentation lifecycle — the single presentation ticker, the session
 *     subscription and the reference-counted style tag — belongs to
 *     `MeterRoot.js`, which chooses between this pill and the completed card;
 *   - **one dominant number per state.** Every branch renders its own value
 *     through `.dsh-tpm-number` (the `1.7 x` step of the plugin's type scale) and
 *     keeps labels, units and elapsed readings strictly below it. Reference:
 *     `docs/assets/reference-live-streaming.png`, where the rate is the focus and
 *     the elapsed reading is visibly subordinate;
 *   - high-frequency numbers are plain text: NO `aria-live` region, so a screen
 *     reader is never read a new TPS twenty times a second. The root carries a
 *     per-state `aria-label` and `data-state` instead.
 */

const { createElement: h } = __ext("react")
const { formatApproxTps, formatElapsed, formatToolLabel, stopwatchParts } = __req("src/client/live/live-format.js")

/**
 * Debug counters (always cheap increments; read only via the debug handle).
 * They exist because the browser is the only place where the full chain
 * controller-notify -> scheduler -> setView -> DOM can be observed together.
 */
const diagnostics = {
  schedulerCreated: 0,
  notifyCalls: 0,
  renderCalls: 0,
  refreshCalls: 0,
  currentScheduler: null,
}

function meterDiagnostics() {
  return diagnostics
}

/** Accessibility name per presentation state — transitions, not digits. */
function stateLabelKey(view) {
  switch (view.kind) {
    case 'ttft': return 'ttft'
    case 'streaming': return view.phase === 'reasoning' ? 'thinking' : 'output'
    /** The same phase label while the episode is still below its warm-up count. */
    case 'warming': return view.phase === 'reasoning' ? 'thinking' : 'output'
    case 'tool': return 'tool'
    case 'waiting': return 'waiting'
    case 'transition': return 'transition'
    default: return 'meterLabel'
  }
}

/** A value and its unit as one non-wrapping run: `2.80` `s`, `≈338` `tokens/s`. */
function metric(value, unit, { tone = 'primary', className = 'dsh-tpm-number' } = {}) {
  return h('span', { className: 'dsh-tpm-metric' }, [
    h('span', { key: 'v', className, 'data-tone': tone }, value),
    unit === null ? null : h('span', { key: 'u', className: 'dsh-tpm-unit' }, unit),
  ])
}

/**
 * Separator plus turn-elapsed run, or nothing.
 *
 * The turn elapsed is `null` when the turn start was not observed (a page that
 * attached mid-turn adopts the open turn without its `turn/start`); rendering
 * `0 s` there would be a fabricated number, so the run is omitted entirely.
 */
function elapsedRun(view) {
  if (!Number.isFinite(view.elapsedMs)) return []
  return [
    h('span', { key: 's', className: 'dsh-tpm-sep' }),
    h('span', { key: 'e', className: 'dsh-tpm-elapsed' }, formatElapsed(view.elapsedMs)),
  ]
}

function pillContent(view, label) {
  switch (view.kind) {
    case 'ttft': {
      /**
       * The running first-response counter is the state's only number, so it is
       * the state's focus: `2.80 S` beside the state label.
       *
       * The duration is passed through uncoerced. `stopwatchParts` renders a
       * non-finite duration as the shared em dash with no unit, which is the
       * honest reading for a turn whose `turn/start` was never observed: `0.00 S`
       * would be a fabricated measurement (`docs/METRICS_SPEC.md` §4).
       */
      const parts = stopwatchParts(view.counterMs)
      return [
        metric(parts.value, parts.unit),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
      ]
    }

    case 'streaming':
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        metric(formatApproxTps(view.tps, view.approximate), 'tokens/s', { tone: 'accent' }),
        ...elapsedRun(view),
      ]

    /**
     * The episode's warm-up: no rate is published until it has enough samples, so
     * the pill shows the phase label and the episode's own elapsed counter. The
     * element structure is the same as the `waiting` branch — label, stopwatch,
     * turn elapsed — so the presentation stays inside the frozen visual design.
     *
     * With no episode open at all (a boundary-only first token, before the first
     * magnitude sample) the counter is absent rather than zero, and renders as the
     * em dash with no unit.
     */
    case 'warming': {
      const parts = stopwatchParts(view.counterMs)
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        metric(parts.value, parts.unit),
        ...elapsedRun(view),
      ]
    }

    case 'tool':
      return [
        h('span', { key: 'n', className: 'dsh-tpm-tool' }, formatToolLabel(view.names, view.count)),
        h('span', { key: 'g', className: 'dsh-tpm-stage' }, `· ${formatElapsed(view.toolElapsedMs ?? 0)}`),
        ...elapsedRun(view),
      ]

    case 'waiting': {
      const parts = stopwatchParts(view.waitMs)
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        metric(parts.value, parts.unit),
        ...elapsedRun(view),
      ]
    }

    case 'transition':
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, `${label}…`),
        ...elapsedRun(view),
      ]

    default:
      return null
  }
}

/**
 * The live pill for one projected view.
 *
 * @param {{view: object, translate: (key: string) => string}} props
 */
function LivePill({ view, translate }) {
  const t = typeof translate === 'function' ? translate : (key => key)
  const label = t(stateLabelKey(view))
  const ariaLabel = Number.isFinite(view.elapsedMs)
    ? `${label} · ${formatElapsed(view.elapsedMs)}`
    : label
  return h('div', {
    className: 'dsh-tpm-root',
    'data-kind': 'live',
    'data-state': view.state,
    'data-turn': view.turn ?? '',
    'aria-label': ariaLabel,
  }, h('div', { className: 'dsh-tpm-pill' }, pillContent(view, label)))
}

;Object.assign(__exports, { meterDiagnostics, LivePill })
			},
			"src/client/completed/metric-cell.js": function (__exports) {
/**
 * One principal metric column — pure, React-free, and shared.
 *
 * Extracted from the card shell so the summary grid and the curve panel render
 * columns through the **same** function. The curve view keeps two of the four
 * columns, and "the same cell, built the same way" is what makes that statement
 * literally true rather than visually similar.
 */

/** Visible secondary text for one column, resolved from locale keys. */
function secondaryText(secondary, translate) {
  if (secondary === null || secondary === undefined) return null
  if (secondary.kind === 'phase') return secondary.text
  if (secondary.kind === 'elapsed') return `${translate(secondary.labelKey)} ${secondary.display}`
  if (secondary.kind === 'status') {
    /** `statusKey` already names the locale key (`status.completed`). */
    const status = translate(secondary.statusKey)
    return secondary.detail === null || secondary.detail === undefined ? status : `${status} · ${secondary.detail}`
  }
  return null
}

/**
 * One principal column.
 *
 * The accessible name is built from the visible label, value and secondary line,
 * so the four numbers are never announced as four unlabelled figures. The visible
 * text stays exactly the design; the fuller phrase lives in the accessible name,
 * which is also why the card needs no `title` attribute or tooltip.
 */
function metricCellTree(createElement, { cell, translate }) {
  const label = translate(cell.labelKey)
  const unit = cell.unit
  const secondary = secondaryText(cell.secondary, translate)
  const ariaLabel = [
    label,
    cell.available ? `${cell.display}${unit === null ? '' : ` ${unit}`}` : translate('unavailable'),
    secondary,
  ].filter(part => part !== null && part !== undefined && part !== '').join(', ')

  return createElement('div', {
    className: 'dsh-tpm-cell',
    'data-metric': cell.key,
    'data-quality': cell.quality,
    'data-approximate': cell.approximate ? 'true' : 'false',
    role: 'group',
    'aria-label': ariaLabel,
  }, [
    createElement('div', { key: 'label', className: 'dsh-tpm-cell-label' }, label),
    createElement('div', { key: 'value', className: 'dsh-tpm-cell-value' }, [
      createElement('span', { key: 'number', className: 'dsh-tpm-cell-number' }, cell.display),
      unit === null ? null : createElement('span', { key: 'unit', className: 'dsh-tpm-cell-unit' }, unit),
    ]),
    secondary === null
      ? null
      : createElement('div', {
        key: 'sub',
        className: 'dsh-tpm-cell-sub',
        'data-tone': cell.secondary.tone ?? 'neutral',
      }, secondary),
  ])
}

;Object.assign(__exports, { secondaryText, metricCellTree })
			},
			"src/client/completed/curve-tree.js": function (__exports) {
/**
 * Curve-panel element tree — pure, React-free.
 *
 * The panel is the alternate view inside the completed card, not a tooltip: it
 * replaces the two TPS columns in the *same* four-column grid, so the
 * generated-token and TTFT columns keep their exact positions and dividers when
 * the card switches. That is a structural choice, not a styling one — the
 * reference puts the curve in the left half and the two surviving metrics on the
 * right, and reusing the grid makes the two views differ by one element instead
 * of by one layout.
 *
 * Geometry decisions (axis ceiling, evidence spans, peak placement) belong to
 * `curve-view-model.js`; this module only turns them into elements. The SVG is
 * `aria-hidden` and the panel carries one textual description instead, so a
 * screen reader is never handed a polyline it cannot read while the accessible
 * summary says the same thing twice.
 */

const { metricCellTree } = __req("src/client/completed/metric-cell.js")

/** Legend order is fixed so the swatches never swap between turns. */
const LEGEND_ORDER = Object.freeze(['reasoning', 'output'])

/** Locale key for one series' legend label. */
function legendKey(key) {
  return key === 'reasoning' ? 'thinking' : 'output'
}

/**
 * Legend row: `思考 [swatch] 输出 [swatch]` on the left, the peak on the right.
 *
 * The swatch follows its label, which is the reference's order, and the label is
 * always present — colour is never the only channel that identifies a series.
 * A phase with no drawable evidence keeps its legend entry and is marked
 * `data-absent`, because removing the entry would silently answer a question the
 * reader is still asking.
 */
function legendTree(createElement, curveView, translate) {
  const items = LEGEND_ORDER.map(key => {
    const series = curveView.series.find(candidate => candidate.key === key)
    const present = series?.present === true
    return createElement('span', {
      key,
      className: 'dsh-tpm-legend-item',
      'data-series': key,
      'data-absent': present ? 'false' : 'true',
    }, [
      createElement('span', { key: 'label', className: 'dsh-tpm-legend-label' }, translate(legendKey(key))),
      createElement('span', { key: 'swatch', className: 'dsh-tpm-legend-swatch', 'aria-hidden': 'true' }),
    ])
  })

  /**
   * The peak is a point of an estimated series, so it carries `≈` even when the
   * turn's token total is exact. The locale supplies the word; the widget never
   * prints a bare number here.
   */
  const peak = createElement('span', {
    className: 'dsh-tpm-peak',
    'data-approximate': curveView.peak.approximate ? 'true' : 'false',
  }, [
    createElement('span', { key: 'label', className: 'dsh-tpm-peak-label' }, translate('peak')),
    createElement('span', { key: 'value', className: 'dsh-tpm-peak-value' }, curveView.peak.display),
    createElement('span', { key: 'unit', className: 'dsh-tpm-peak-unit' }, curveView.peak.unit),
  ])

  return createElement('div', { className: 'dsh-tpm-curve-head' }, [
    createElement('div', { key: 'legend', className: 'dsh-tpm-legend' }, items),
    createElement('div', { key: 'peak', className: 'dsh-tpm-peak-slot' }, peak),
  ])
}

/**
 * Plot area: one path element per drawable **run**, the axis ceiling, and the
 * peak marker.
 *
 * A phase may appear in more than one episode, so the renderer receives a list of
 * runs per series and emits one `<path>` for each. Two runs are two elements, never
 * one element with two subpaths, because the separation is the statement: the
 * curve genuinely stopped and started again, and the reader must see a gap rather
 * than a line drawn through a stretch where nothing was generated. No vertical
 * attempt-boundary marker is added — the break itself is the whole signal, and a
 * divider per attempt would decorate the chart with information the reader did not
 * ask for.
 *
 * `viewBox="0 0 100 48"` with `preserveAspectRatio="none"` and a non-scaling
 * stroke keeps the y scale at one unit per unit at any container width, which is
 * also why the peak marker is an HTML element positioned in percentages rather
 * than an SVG circle: a circle inside a non-uniformly stretched viewBox would
 * render as an ellipse.
 *
 * The marker sits inside `.dsh-tpm-plot-area` and the axis ceiling outside it,
 * because `left`/`top` percentages resolve against the containing block's
 * padding box — sharing that box with the axis label would push every marker off
 * its vertex.
 */
function plotTree(createElement, curveView, translate) {
  const paths = []
  for (const series of curveView.series) {
    for (const [index, run] of series.runs.entries()) {
      if (run.present !== true || typeof run.path !== 'string') continue
      paths.push(createElement('path', {
        /**
         * `attemptId` is retained on the element so a future diagnostic can point
         * at one call, but it is not rendered as anything.
         */
        key: `${series.key}:${run.attemptId ?? 'unknown'}:${index}`,
        className: 'dsh-tpm-series',
        'data-series': series.key,
        'data-run': String(index),
        'data-attempt': run.attemptId === null ? '' : String(run.attemptId),
        d: run.path,
        vectorEffect: 'non-scaling-stroke',
      }))
    }
  }

  const svg = createElement('svg', {
    key: 'svg',
    className: 'dsh-tpm-plot-svg',
    viewBox: `0 0 ${curveView.width} ${curveView.height}`,
    preserveAspectRatio: 'none',
    focusable: 'false',
    'aria-hidden': 'true',
  }, paths)

  const area = [svg]

  /**
   * Point markers for one-vertex runs.
   *
   * A run that holds a single measurement cannot be a path, and until Phase 7 it was
   * therefore invisible — including when that measurement was the turn's peak, which
   * left the card printing a peak the chart could not point at. The marker is an HTML
   * element rather than an SVG circle for the same reason the peak dot is: the viewBox
   * is stretched non-uniformly, so a circle drawn inside it would render as an
   * ellipse.
   *
   * It is `aria-hidden`, like the rest of the plot, because the accessible summary of
   * the chart is the panel's `aria-label`; a screen reader gains nothing from a
   * decorative dot. It carries its series in `data-series` and its tone through the
   * same class channel the legend uses, and it does **not** count toward
   * `data-points`: a marker is not a vertex, and inflating the drawn count would make
   * the chart's own bound unmeasurable.
   *
   * `data-peak` is the one visual distinction between two markers. A chart of a long
   * agent turn can hold many ordinary single-measurement stretches, and drawing every
   * one of them at the peak's size made the trace read as a field of peaks; an
   * ordinary marker is small and subdued, and only the measurement the card prints as
   * the peak keeps the stronger marker. The measured instant is the same either way.
   */
  for (const [index, marker] of (Array.isArray(curveView.markers) ? curveView.markers : []).entries()) {
    area.push(createElement('span', {
      key: `singleton:${marker.series}:${marker.attemptId ?? 'unknown'}:${index}`,
      className: 'dsh-tpm-singleton-dot',
      'data-series': marker.series,
      'data-attempt': marker.attemptId === null ? '' : String(marker.attemptId),
      'data-tps': String(marker.tps),
      'data-peak': marker.isPeak === true ? 'true' : 'false',
      'aria-hidden': 'true',
      style: {
        left: `${marker.x}%`,
        top: `${(marker.y / curveView.height) * 100}%`,
      },
    }))
  }

  if (curveView.peak.x !== null && curveView.peak.y !== null) {
    area.push(createElement('span', {
      key: 'dot',
      className: 'dsh-tpm-peak-dot',
      'data-leader': curveView.peak.leader,
      'aria-hidden': 'true',
      style: {
        left: `${curveView.peak.x}%`,
        top: `${(curveView.peak.y / curveView.height) * 100}%`,
      },
    }))
  }
  /**
   * The placeholder appears only when the chart has **nothing at all** to place: no
   * path vertex and no marker. A turn whose only evidence is singleton runs has
   * markers, so it renders them instead of claiming the curve is unavailable —
   * that substitution was the visible half of the singleton defect.
   */
  if (curveView.drawnPoints === 0 && curveView.markers.length === 0) {
    area.push(createElement('span', {
      key: 'empty',
      className: 'dsh-tpm-plot-empty',
    }, translate('curveUnavailable')))
  }

  return createElement('div', {
    className: 'dsh-tpm-plot',
    'data-points': curveView.drawnPoints,
    /**
     * Markers are counted separately from vertices, and published so a test can
     * assert the two are never conflated: `data-points` is what the chart-wide
     * render budget bounds, `data-markers` is decoration layered on top of it.
     */
    'data-markers': curveView.markers.length,
  }, [
    createElement('div', { key: 'area', className: 'dsh-tpm-plot-area' }, area),
    createElement('span', { key: 'axis', className: 'dsh-tpm-axis-max' }, curveView.axis.display),
  ])
}

/**
 * The panel: the legend/peak head, the plot, and the two metric columns the
 * curve view keeps.
 *
 * @param {(tag: string, props: object, children?: unknown) => object} createElement
 * @param {object} curveView `curveViewModel` output
 * @param {readonly object[]} keptColumns the card's trailing metric columns
 * @param {(key: string) => string} translate
 */
function curveTree(createElement, curveView, keptColumns, translate) {
  const t = typeof translate === 'function' ? translate : (key => key)
  return [
    createElement('div', {
      key: 'curve',
      className: 'dsh-tpm-curve-panel',
      role: 'group',
      'aria-label': `${t('curveLabel')} · ${t('peak')} ${curveView.peak.display} ${curveView.peak.unit}`,
    }, [
      legendTree(createElement, curveView, t),
      plotTree(createElement, curveView, t),
    ]),
    ...keptColumns.map(cell => metricCellTree(createElement, { cell, translate: t })),
  ]
}

;Object.assign(__exports, { curveTree })
			},
			"src/client/completed/compact-summary.js": function (__exports) {
/**
 * The collapsed card's one summary line — pure, React-free.
 *
 * A collapsed row is only worth its space if it still answers the question the
 * reader opened the card for. `Performance >` would not, so the row carries the
 * settlement status and the four principal readings on one line, exactly as the
 * official DSH TodoPanel carries `已完成 19` on its own collapsed row.
 *
 * The single rule this module exists to enforce: **it reads, it never recomputes.**
 * Every number below is a string `src/client/ui-model.js` already decided —
 * `view.columns[i].display` carries the finished formatting and, where the metric
 * is approximate, the `≈` marker; `view.columns[i].unit` is `null` for a metric
 * with no value, which is what keeps an unavailable reading as `—` instead of
 * turning it into a unit-bearing `— tokens/s`. Nothing here divides, sums, rounds,
 * calibrates or decides quality, so the compact row and the expanded detail cannot
 * disagree about a number: they are the same string.
 *
 * A dropped column is not an available column, and the two are kept apart below:
 * the loop skips a part that has no display text at all, while a reading whose
 * value is genuinely absent prints its em dash.
 */

/**
 * The four principal readings, in the card's fixed column order, each joined to
 * the locale word that names it.
 *
 * `thinking`/`output` are reused rather than duplicated so the compact row, the
 * curve legend and the column labels can never drift apart.
 */
const COMPACT_PARTS = Object.freeze([
  Object.freeze({ key: 'reasoningTps', labelKey: 'thinking' }),
  Object.freeze({ key: 'outputTps', labelKey: 'output' }),
  Object.freeze({ key: 'generatedTokens', labelKey: null }),
  Object.freeze({ key: 'ttft', labelKey: 'colTtft' }),
])

/**
 * Compose the collapsed row's progress text.
 *
 * The parts are joined with the same ` · ` separator the footer uses, so the card
 * reads as one instrument rather than as two unrelated reading styles.
 *
 * @param {object} view `completedViewModel` output
 * @param {(key: string) => string} [translate]
 * @returns {string} one line, always non-empty for a settled view
 */
function compactSummary(view, translate) {
  const t = typeof translate === 'function' ? translate : (key => key)
  const parts = [t(`status.${view.status}`)]

  for (const part of COMPACT_PARTS) {
    const column = findColumn(view, part.key)
    if (column === null) continue
    /** A unit is present only when the reading is: `—` never grows a unit. */
    const reading = column.unit === null || column.unit === undefined
      ? column.display
      : `${column.display} ${column.unit}`
    parts.push(part.labelKey === null ? reading : `${t(part.labelKey)} ${reading}`)
  }

  return parts.join(' · ')
}

/** One column of the view model by metric key, or `null` when the view has none. */
function findColumn(view, key) {
  const columns = Array.isArray(view?.columns) ? view.columns : []
  const column = columns.find(candidate => candidate?.key === key)
  if (column === undefined) return null
  if (typeof column.display !== 'string' || column.display.length === 0) return null
  return column
}

;Object.assign(__exports, { compactSummary })
			},
			"src/client/completed/completed-tree.js": function (__exports) {
/**
 * Completed-card element tree — pure, React-free.
 *
 * The card's structure, its visible strings, its accessible names and the
 * decision to hide an item (a turn with no tool call, a phase with no secondary
 * line, the whole detail region while collapsed) are all decided here.
 * `CompletedMeter.js` is the thin React binding over this module, which keeps the
 * render layer thin and lets the tree be tested in Node with a recording
 * `createElement` rather than a DOM.
 *
 * ## Two nested decisions, two different owners
 *
 * The card shell answers *is the detail on screen*: a `button.dsh-tpm-card-header`
 * spanning the full row, carrying `aria-expanded`, the title, a one-line summary
 * and a chevron. It mirrors the official DSH TodoPanel header, down to the
 * direction of the chevron — `ChevronUp` while collapsed, `ChevronDown` while
 * expanded — because matching the host is the point of the round.
 *
 * The detail region answers *which view is on screen*: the metric summary by
 * default, the throughput curve while hovered or focused. **The two do not share
 * an element.** The curve handlers and the focus stop are bound to
 * `.dsh-tpm-detail`, never to the card, so tabbing onto the expand/collapse
 * button cannot reveal a chart — a reader who only wanted to reopen the card must
 * not have the view change under them.
 *
 * While collapsed the detail is **not rendered at all**, rather than hidden with
 * `opacity` or `visibility`. A hidden-but-present region would keep its height
 * above the composer, which is the specific cost this round exists to remove, and
 * it would also leave four metric groups in the accessibility tree of a row that
 * visually exposes one line.
 *
 * The two views are stacked in one grid cell rather than swapped, so the expanded
 * card's height is the taller of the two and a switch cannot resize it. The hidden
 * layer is `aria-hidden` and `pointer-events: none`, so assistive technology is
 * never handed two copies of the turn's numbers at once.
 *
 * The tree never computes geometry: the curve panel arrives finished from
 * `curve-view-model.js` and is assembled by `curve-tree.js`. It never computes a
 * metric either — the collapsed row and the four columns read the same
 * `view.columns` display strings (`./compact-summary.js`).
 */

const { metricCellTree, secondaryText } = __req("src/client/completed/metric-cell.js")
const { curveTree } = __req("src/client/completed/curve-tree.js")
const { compactSummary } = __req("src/client/completed/compact-summary.js")



/**
 * The card's decorative leading glyph, in the host's 16x16 slot.
 *
 * The official panel passes a primitives-package icon here. This plugin has no
 * such dependency and will not add one for a single glyph, so the mark is inline
 * SVG at the same size, drawn in `currentColor` so it follows the host theme, and
 * `aria-hidden` because the title beside it already names the card.
 *
 * The glyph itself is a meter face: a dial arc with a needle at roughly
 * two-thirds deflection.
 */
function leadGlyphTree(createElement) {
  return createElement('svg', {
    key: 'glyph',
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    'aria-hidden': 'true',
    focusable: 'false',
  }, [
    createElement('path', {
      key: 'arc',
      d: 'M2.2 12.4a6.9 6.9 0 0 1 11.6 0',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.4',
      strokeLinecap: 'round',
    }),
    createElement('path', {
      key: 'needle',
      d: 'M8 12.1 11.3 6.9',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.4',
      strokeLinecap: 'round',
    }),
  ])
}

/**
 * The chevron, whose direction is the host's rather than the conventional one.
 *
 * DSH's TodoPanel shows `ChevronUp` while collapsed and `ChevronDown` while
 * expanded — the icon promises what the click will do to the panel below the row,
 * not which end of the list you are looking at. Keeping the same direction is what
 * makes the two stacked panels in one composer read as one control family.
 */
function chevronTree(createElement, collapsed) {
  const d = collapsed ? 'M4 9.8 8 5.8l4 4' : 'M4 6.2 8 10.2l4-4'
  return createElement('span', {
    key: 'chevron',
    className: 'dsh-tpm-card-chevron',
    'aria-hidden': 'true',
  }, createElement('svg', {
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    'aria-hidden': 'true',
    focusable: 'false',
  }, createElement('path', {
    d,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.5',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  })))
}

/**
 * The one-row header: lead, title, summary, chevron.
 *
 * The whole row is the button, which is the host's structure and also the reason
 * the hit target is the full card width rather than a 16 px chevron.
 */
function headerTree(createElement, view, t, collapsed, onToggle) {
  const props = {
    key: 'header',
    className: 'dsh-tpm-card-header',
    type: 'button',
    'aria-expanded': collapsed ? 'false' : 'true',
    /**
     * The full name of the card is the accessible one; the visible title is the
     * short word, because a 21-character title would crowd out the summary line
     * it sits beside.
     */
    'aria-label': `${t('completedLabel')} · ${t('turnLabel')} ${view.turn ?? ''} · ${t(`status.${view.status}`)}`,
  }
  if (typeof onToggle === 'function') props.onClick = onToggle

  return createElement('button', props, [
    createElement('span', { key: 'lead', className: 'dsh-tpm-card-lead', 'aria-hidden': 'true' }, leadGlyphTree(createElement)),
    createElement('span', { key: 'title', className: 'dsh-tpm-card-title' }, t('performanceTitle')),
    createElement('span', { key: 'progress', className: 'dsh-tpm-card-progress' }, compactSummary(view, t)),
    chevronTree(createElement, collapsed),
  ])
}

/**
 * Footer items. Tools lead because they are the only footer fact that can be
 * absent: a turn with no tool call hides the tool item entirely rather than
 * printing "0 tools", and the separator is a CSS pseudo-element so the line
 * never starts or ends with a bullet.
 */
function footerTree(createElement, view, translate) {
  const tools = view.tools ?? { count: 0, wallDisplay: '' }
  const items = []
  if (tools.count > 0) items.push(`${translate('tools')} ${tools.count} · ${tools.wallDisplay}`)
  if (view.attemptCount > 0) items.push(`${translate('attempts')} ${view.attemptCount}`)
  items.push(translate(`status.${view.status}`))
  return createElement('div', { key: 'foot', className: 'dsh-tpm-foot' },
    items.map((text, index) => createElement('span', { key: `${index}`, className: 'dsh-tpm-foot-item' }, text)))
}

/**
 * One stacked layer.
 *
 * `data-visible` drives the cross-fade in CSS; `aria-hidden` is the
 * accessibility half of the same decision and is a real attribute rather than a
 * style, so it survives a stylesheet that fails to load.
 */
function viewLayer(createElement, key, visible, children) {
  return createElement('div', {
    key,
    className: 'dsh-tpm-view',
    'data-view': key,
    'data-visible': visible ? 'true' : 'false',
    'aria-hidden': visible ? 'false' : 'true',
  }, createElement('div', { className: 'dsh-tpm-cells' }, children))
}

/**
 * The expanded detail: the two stacked views and the footer.
 *
 * This is the region that owns the curve, so this is where the focus stop, the
 * pointer handlers and the hint live. `tabindex` is attached only when a curve
 * exists — a focus stop that changes nothing is worse than no stop at all — and
 * the hint is attached with it, so the reason the region is focusable is
 * discoverable rather than implied.
 */
function detailTree(createElement, view, t, mode, curveView, interaction, interactive) {
  const layers = [
    viewLayer(createElement, 'summary', mode === 'summary', view.columns.map(cell => (
      metricCellTree(createElement, { cell, translate: t })
    ))),
  ]
  if (interactive) {
    /**
     * The curve view replaces the first two columns with one panel spanning the
     * same two tracks; the trailing columns are the very same cells the summary
     * renders, at the very same grid positions.
     */
    layers.push(viewLayer(createElement, 'curve', mode === 'curve',
      curveTree(createElement, curveView, view.columns.slice(2), t)))
  }

  const props = { key: 'detail', className: 'dsh-tpm-detail' }
  if (interactive) {
    props.tabIndex = 0
    props['aria-description'] = t('curveHint')
    /** Only handlers that were actually supplied become props. */
    for (const [prop, handler] of [
      ['onMouseEnter', interaction.onEnter],
      ['onMouseLeave', interaction.onLeave],
      ['onFocus', interaction.onFocus],
      ['onBlur', interaction.onBlur],
    ]) {
      if (typeof handler === 'function') props[prop] = handler
    }
  }

  return createElement('div', props, [
    createElement('div', { key: 'views', className: 'dsh-tpm-views' }, layers),
    footerTree(createElement, view, t),
  ])
}

/**
 * The whole card.
 *
 * @param {(tag: string, props: object, children?: unknown) => object} createElement
 * @param {object} view `completedViewModel` output
 * @param {(key: string) => string} translate
 * @param {{
 *   collapsed?: boolean,
 *   mode?: 'summary'|'curve',
 *   curveView?: object|null,
 *   onToggle?: Function,
 *   onEnter?: Function, onLeave?: Function, onFocus?: Function, onBlur?: Function,
 * }} [interaction] presentation state and handlers owned by `CompletedMeter`
 */
function completedTree(createElement, view, translate, interaction = {}) {
  const t = typeof translate === 'function' ? translate : (key => key)
  /**
   * Collapsed is the default here as well as in the state machine, so a caller
   * that passes no presentation state at all — a test, a future embed — gets the
   * compact row rather than an accidental full panel.
   */
  const collapsed = interaction.collapsed !== false
  const mode = interaction.mode === 'curve' ? 'curve' : 'summary'
  const curveView = interaction.curveView ?? null
  const interactive = curveView !== null

  const card = [
    headerTree(createElement, view, t, collapsed, interaction.onToggle),
  ]
  if (!collapsed) {
    card.push(detailTree(createElement, view, t, mode, curveView, interaction, interactive))
  }

  return createElement('div', {
    className: 'dsh-tpm-root',
    'data-kind': 'completed',
    'data-status': view.status,
    'data-quality': view.quality?.overall ?? 'unavailable',
    /**
     * `data-view` keeps its Phase 5 meaning — which *detail* view is on screen —
     * because browser diagnostics read it. The collapsed decision is a separate
     * attribute for the same reason: while collapsed the card is still showing
     * the summary, so `data-view="summary"` stays true and truthful.
     */
    'data-collapsed': collapsed ? 'true' : 'false',
    'data-view': mode,
    'data-turn': view.turn ?? '',
    ...(view.sessionId === null || view.sessionId === undefined ? {} : { 'data-session': view.sessionId }),
  }, createElement('div', {
    className: 'dsh-tpm-card',
    /**
     * Phase 5 put the accessible name on the card because the card *was* the
     * interactive surface. Phase 9 split that surface in two: the header button
     * carries the expand/collapse name, so the card keeps the grouping role and
     * the accessible name and hands the button its own. The name is therefore
     * still reachable, and no reader meets the same label twice on one control.
     */
    role: 'group',
    'aria-label': `${t('completedLabel')} · ${t('turnLabel')} ${view.turn ?? ''} · ${t(`status.${view.status}`)}`,
  }, createElement('div', { className: 'dsh-tpm-card-body' }, card)))
}

;Object.assign(__exports, { metricCellTree, secondaryText, completedTree })
			},
			"src/client/completed/curve-view-model.js": function (__exports) {
/**
 * Curve view model — the single seam between the settled snapshot and the SVG.
 *
 * The data flow is fixed by the architecture, and this module is the only place
 * it may bend:
 *
 *     settled snapshot (already decoded, aggregated, calibrated, compressed,
 *                       windowed, run-split and downsampled)
 *         -> curveViewModel(settled)          <- this module
 *         -> SVG element tree                 (`curve-tree.js`)
 *
 * The React layer therefore never decodes an event, aggregates a turn, compresses
 * an attempt axis, rolls a TPS window, splits a phase into episodes or downsamples
 * a raw delta — it renders numbers and path strings that were decided here. That
 * matters because those six operations are the statistics; a component that
 * recomputed any of them would be a second, silently divergent definition of TPS.
 *
 * **One measurement per attempt, several tones.** Since Phase 7C the curve is one
 * attempt-local trailing-one-second **total** throughput trace per model attempt,
 * and a phase is a *colour* of that one measurement rather than a rate of its own:
 * `source.curve.attempts[].runs` carries the phase-coloured subruns of each trace.
 * Two subruns that meet at a phase transition share their boundary vertex, so this
 * module emits one `M...L...` path per subrun and never joins two *attempts* —
 * the join between two calls is a fabricated straight line through a tool wait,
 * which is a stretch where nothing was generated.
 *
 * Geometry is expressed in a fixed logical viewBox (`0 0 100 48`) that the SVG
 * stretches to its container with `preserveAspectRatio="none"` and
 * `vector-effect="non-scaling-stroke"`. A chart whose y-scale depended on the
 * container width would make the same turn look like a different turn at a
 * different window size; a fixed viewBox does not.
 */

const { DASH, formatTps, formatTokens } = __req("src/client/format.js")

/** Logical drawing box. Height is chosen so the curve panel matches the summary. */
const CURVE_VIEW_WIDTH = 100
const CURVE_PLOT_HEIGHT = 48

/** Vertical inset reserved so a peak touching the axis maximum is not clipped. */
const PLOT_INSET = 3

/** Axis labels are read as magnitudes, so they never carry the `≈` of a rate. */
function formatAxis(value) {
  if (!Number.isFinite(value) || value <= 0) return DASH
  return formatTokens(value)
}

/**
 * Smallest member of the 1/2/2.5/5 x 10^k ladder that is `>= value`.
 *
 * A raw maximum as the axis ceiling (e.g. `673`) would place the peak exactly on
 * the top gridline with no headroom and produce unreadable axis labels; a ladder
 * ceiling keeps the peak visible and the label round. Deterministic by
 * construction, which is what lets the geometry be snapshot-tested.
 */
function niceCeiling(value) {
  if (!(Number.isFinite(value) && value > 0)) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  for (const step of [1, 2, 2.5, 5]) {
    if (value <= step * base * (1 + 1e-9)) return step * base
  }
  return 10 * base
}

/** x coordinate of one compressed instant, or `null` when it is not drawable. */
function xOf(timeMs, durationMs) {
  if (!Number.isFinite(timeMs)) return null
  if (!(durationMs > 0)) return 0
  return Math.min(CURVE_VIEW_WIDTH, Math.max(0, (timeMs / durationMs) * CURVE_VIEW_WIDTH))
}

/** y coordinate of one rate against the axis ceiling. */
function yOf(tps, axisMax) {
  const usable = CURVE_PLOT_HEIGHT - PLOT_INSET * 2
  const ratio = axisMax > 0 ? Math.min(1, Math.max(0, tps / axisMax)) : 0
  return CURVE_PLOT_HEIGHT - PLOT_INSET - ratio * usable
}

/** Two decimals is well below one device pixel in a `100`-wide stretched viewBox. */
function round(value) {
  return Math.round(value * 100) / 100
}

/**
 * Turn one run's vertices into coordinates and a single-subpath `d` string.
 *
 * A run shorter than two vertices is not drawable **as a line**: one point is a
 * measurement, not a segment. It is reported as `present: false` with its
 * coordinates intact, and — since Phase 7 — with `marker` set, so the renderer can
 * place a point where the measurement actually is.
 *
 * ## A vertex with no rate is a position, not a value
 *
 * Since Phase 9.4 a vertex the shared publication policy withholds carries
 * `tps: null` rather than a fabricated `0` (`src/core/rate-publication.js`), and a
 * zero-width attempt's single vertex is exactly that: its opening anchor. Those
 * vertices were dropped from the geometry entirely, which made the run empty and
 * cost the chart the marker that shows the attempt happened at all. The renderer
 * wants the opposite: `data-tps="null"` is how it says "something was here and
 * nothing was measured".
 *
 * So a vertex with a non-finite rate keeps its **position** but contributes no
 * **value**: it can never enter `coordinates`, never becomes a run's `peak`, and
 * never takes part in the peak comparison in `buildSeries`. A run whose only
 * vertex is unmeasured is still a singleton — drawn at the axis floor, one
 * plot-height below any real measurement — and the distinction survives to the
 * DOM, where `String(null)` is `"null"` rather than `"0"`.
 *
 * ## Why a marker, and why not a second vertex
 *
 * A run can legitimately hold one vertex: an attempt that produced a single delta has
 * zero width, and an episode whose phase falls silent immediately after one delta has
 * a tail grid with no whole step left inside its bound. That measurement can be the
 * turn's peak, which meant the card printed a peak the chart could not locate —
 * `test/completed-tree.test.js` recorded it as a known mismatch and Phase 7 closed it.
 *
 * The tempting repair is to duplicate the vertex so a line exists. That would be a
 * fabrication: two vertices at one instant draw a segment the data does not contain,
 * and a two-point series would then satisfy `present`, inflating `drawnPoints`,
 * `drawnRuns` and the legend's presence claim. The marker adds no vertex, carries the
 * same tone as its series, is `aria-hidden`, and adds nothing to any statistic.
 */
function buildRun(run, durationMs, axisMax) {
  const coordinates = []
  /**
   * The same vertices, carrying their position but not necessarily a rate. A run of
   * exactly one of these is still a marker; see the note above.
   */
  const vertices = []
  for (const point of Array.isArray(run?.points) ? run.points : []) {
    if (!Number.isFinite(point?.timeMs)) continue
    const x = xOf(point.timeMs, durationMs)
    if (x === null) continue
    const measured = Number.isFinite(point.tps)
    const vertex = {
      x,
      /** `y` is the axis floor when there is no rate to place: a position, not a value. */
      y: measured ? yOf(point.tps, axisMax) : yOf(0, axisMax),
      tps: measured ? point.tps : null,
      timeMs: point.timeMs,
      attemptId: run.attemptId ?? null,
    }
    vertices.push(vertex)
    if (measured) coordinates.push(vertex)
  }

  if (coordinates.length < 2) {
    /**
     * The one vertex the chart places as a dot. A measured vertex always wins; when the
     * run holds no measurement at all the earliest vertex is still placed, so the chart
     * shows that the attempt existed rather than nothing. A run with two or more
     * unmeasured vertices is a **gap**, not a dot: no rule picks one of them, and
     * picking one would place a single point where the evidence is a stretch.
     */
    const markerFor = coordinates.length === 1
      ? coordinates[0]
      : (vertices.length === 1 ? vertices[0] : null)
    /**
     * The run's own maximum, or `null` when it holds no measurement. An unmeasured
     * vertex is deliberately excluded: it is not a zero, and letting it compete would
     * fabricate a rate for it.
     */
    let peak = null
    for (const point of coordinates) if (peak === null || point.tps > peak.tps) peak = point
    return {
      attemptId: run?.attemptId ?? null,
      startMs: run?.startMs ?? null,
      endMs: run?.endMs ?? null,
      present: false,
      path: null,
      coordinates,
      vertices,
      points: coordinates.length,
      peak,
      /**
       * A point the chart must draw even though it cannot draw a line to it. `null`
       * for an empty run, so a caller can distinguish "one measurement" from
       * "nothing measured" without inspecting `coordinates`.
       */
      marker: markerFor,
      /**
       * Stated explicitly so the HTML layer does not have to infer it: exactly one
       * vertex, drawn as a marker. A longer run never carries this flag, and a
       * refused run (zero vertices) never does either.
       */
      singleton: markerFor !== null,
    }
  }

  /**
   * One `M`, then `L` for every other vertex. This string is deliberately
   * self-contained: joining two runs' strings would produce
   * `M...L... M...L...` — which is two subpaths, so the break would still be
   * correct — but a renderer that instead concatenated their *coordinates* would
   * draw the bridging line this whole structure exists to forbid.
   *
   * Only measured vertices reach here, so no line is ever drawn through a vertex
   * that carries no rate.
   */
  const path = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`)
    .join(' ')

  let peak = coordinates[0]
  for (const point of coordinates) if (point.tps > peak.tps) peak = point

  return {
    attemptId: run?.attemptId ?? null,
    startMs: run?.startMs ?? null,
    endMs: run?.endMs ?? null,
    present: true,
    path,
    coordinates,
    vertices,
    points: coordinates.length,
    peak,
    /** A drawable run is never a singleton: it has a real segment. */
    marker: null,
    singleton: false,
  }
}

/** One series entry: every run of one phase, each with its own path. */
function buildSeries(entry, durationMs, axisMax) {
  const runs = (Array.isArray(entry?.runs) ? entry.runs : []).map(run => buildRun(run, durationMs, axisMax))
  const drawable = runs.filter(run => run.present)
  /**
   * The peak spans every run, drawable or not. A run of one vertex cannot be drawn
   * as a line, but its measurement is real, and the turn peak is a statistic — a
   * rendering limitation may not lower a published number.
   */
  let peak = null
  for (const run of runs) {
    if (run.peak === null) continue
    if (peak === null || run.peak.tps > peak.tps) peak = run.peak
  }
  return {
    key: entry?.key ?? null,
    tone: entry?.tone ?? null,
    present: drawable.length > 0,
    runs,
    /**
     * One entry per run that holds exactly one vertex. These are drawn as point
     * markers, so a one-vertex run that carries the turn's peak has a position on
     * the chart instead of existing only as a printed number. Kept as its own list
     * rather than folded into `coordinates`, because a marker is not a vertex of a
     * path and must not be counted as one.
     */
    markers: runs.filter(run => run.singleton).map(run => run.marker),
    /** Concatenated vertices of every run, for a caller that wants one array. */
    coordinates: runs.flatMap(run => run.coordinates),
    /**
     * Path vertices only. A singleton run contributes **zero** here rather than one:
     * this count feeds `drawnPoints`, which is what bounds the SVG, and a marker is a
     * separate element with its own count.
     */
    points: runs.filter(run => run.present).reduce((sum, run) => sum + run.points, 0),
    /** The single strongest vertex across this phase's runs, or `null`. */
    peak,
    /**
     * A single path string covering every run, for a caller that cannot render a
     * list. Each run opens its own `M`, so the subpaths are still disjoint even
     * here: this is a convenience, not a licence to join them.
     */
    path: drawable.length === 0 ? null : drawable.map(run => run.path).join(' '),
  }
}

/**
 * Rebuild run structure from a pre-Phase-6 snapshot's flat `reasoning`/`output`
 * arrays.
 *
 * An older snapshot carries no runs, and a phase's evidence is bounded by the
 * intervals `phaseSpans` recorded. A snapshot older still carries neither, and
 * then the whole array is one run — the only honest reading of "no availability
 * metadata". This path exists so a stale snapshot degrades to the old drawing
 * rather than to an empty chart.
 */
function legacyRuns(curve, key) {
  const points = Array.isArray(curve?.[key]) ? curve[key] : []
  if (points.length === 0) return []
  const spans = curve?.phaseSpans
  const span = spans !== null && typeof spans === 'object' ? (spans[key] ?? null) : undefined
  if (span === null) return []
  const filtered = span === undefined
    ? points
    : points.filter(point => Number.isFinite(point?.timeMs) && point.timeMs >= span.startMs && point.timeMs <= span.endMs)
  if (filtered.length === 0) return []
  return [{
    attemptId: null,
    phase: key,
    startMs: filtered[0].timeMs,
    endMs: filtered[filtered.length - 1].timeMs,
    attemptTokens: null,
    points: filtered,
  }]
}

/** The run list of one series, from the modern structure or the legacy one. */
function runsOf(curve, key, legacy) {
  const entry = Array.isArray(curve?.series)
    ? curve.series.find(candidate => candidate?.key === key)
    : undefined
  if (entry !== undefined) return entry
  return { key, tone: key === 'output' ? 'accent' : 'neutral', runs: legacyRuns(curve, key) }
}

/**
 * Every phase-coloured subrun of one curve, in draw order.
 *
 * The per-attempt structure is the geometry; the per-phase `series` is a view of it
 * built for the legend. Reading the geometry from the attempt traces is what keeps
 * "one measurement per attempt, colour-segmented" true no matter how a caller
 * chooses to group the runs.
 */
function runsOfAll(curve) {
  const attempts = Array.isArray(curve?.attempts) ? curve.attempts : null
  if (attempts === null) return null
  const runs = []
  for (const attempt of attempts) {
    for (const run of Array.isArray(attempt?.runs) ? attempt.runs : []) runs.push(run)
  }
  return runs
}

/**
 * Whether the curve's magnitudes were anchored to provider usage.
 *
 * Narrow on purpose: `curve.source.calibrated` is `true` only when **every**
 * contributing attempt was anchored. A partially calibrated curve is not a calibrated
 * curve, and a caller that wants the finer statement reads `calibrationCoverage`.
 */
function calibratedOf(curve) {
  return curve?.source?.calibrated === true
}

/**
 * How much of the curve a provider total anchored: `full`, `partial`, `none` or
 * `fallback` (`src/core/curve-source.js`).
 *
 * It is carried onto the view model rather than printed, because the compact card
 * already shows the peak with its `≈` and the panel shows the quality axes — a third
 * line of provenance would be clutter. A caller that wants to annotate the chart reads
 * it here instead of re-deriving it from the per-attempt flags.
 *
 * A curve with no `source` at all — a pre-Phase-7C snapshot — reports `null` rather
 * than a level it cannot substantiate.
 */
function calibrationCoverageOf(curve) {
  const coverage = curve?.source?.calibrationCoverage
  return typeof coverage === 'string' ? coverage : null
}

/**
 * Build the curve panel's view model.
 *
 * @param {object|null|undefined} settled the settled turn snapshot
 * @returns {object|null} `null` when the turn carries no curve at all, which is
 *   what makes the completed card non-interactive for that turn
 */
function curveViewModel(settled) {
  const curve = settled?.curve
  if (!curve || typeof curve !== 'object') return null

  const durationMs = Number.isFinite(curve.durationMs) ? Math.max(0, curve.durationMs) : 0
  /**
   * The published peak, or `null` when nothing was publishable.
   *
   * `curve.peakTps` is `null` — never `0` — when the shared rate-publication policy
   * withheld every vertex (`src/core/rate-publication.js`), and the two readings are
   * not interchangeable. "No publishable peak measurement" and "a measured peak of
   * zero" are different facts about the turn, and collapsing the first into `0` made
   * this view model assert the second. Carrying the `null` through is what keeps
   * `peak.value` honest; the printed `display` and the geometry are untouched, so the
   * card renders exactly as before (Phase 9.4.1).
   */
  const peakValue = Number.isFinite(curve.peakTps) ? Math.max(0, curve.peakTps) : null
  /**
   * The axis is scaled by the **full-series** peak, never by the drawn points:
   * downsampling is a drawing budget and may not rescale the chart either.
   * `downsampleRun` guarantees the peak-bearing point survives, so the drawn
   * curve reaches the top of the axis rather than falling short of it.
   *
   * Axis geometry is arithmetic and cannot take a `null`, so the published `null` is
   * projected onto `0` at this one seam and nowhere else — `niceCeiling`'s floor keeps
   * the scale well-defined, and the result is the `1` ceiling an unpublished peak has
   * always produced. Everything below reads `axisPeak`; nothing downstream of this line
   * lets the `null` into a quotient, a ratio or a comparison.
   */
  const axisPeak = peakValue ?? 0
  const axisMax = niceCeiling(axisPeak)

  /**
   * The runs come from the attempt traces when the curve carries them, because those
   * are the geometry: one total trace per model attempt, cut into phase-coloured
   * subruns. The per-phase `series` is only a view — and on a pre-Phase-7C snapshot,
   * which has no `attempts`, it is the whole of the evidence.
   */
  const attemptRuns = runsOfAll(curve)
  const reasoning = buildSeries({
    key: 'reasoning',
    tone: 'neutral',
    runs: attemptRuns === null ? runsOf(curve, 'reasoning').runs : attemptRuns.filter(run => run.phase === 'reasoning'),
  }, durationMs, axisMax)
  const output = buildSeries({
    key: 'output',
    tone: 'accent',
    runs: attemptRuns === null ? runsOf(curve, 'output').runs : attemptRuns.filter(run => run.phase === 'output'),
  }, durationMs, axisMax)

  /**
   * The series holding the global peak, so the marker sits on it. A tie resolves to
   * `reasoning`, because the comparison is strict and `reasoning` is scanned first —
   * the same earliest-wins rule `buildSeries` applies inside a series, which keeps the
   * position stable between two runs over equal input.
   */
  const leader = (output.peak?.tps ?? -1) > (reasoning.peak?.tps ?? -1) ? 'output' : 'reasoning'
  const leaderSeries = leader === 'output' ? output : reasoning
  /**
   * One marker per attempted transition, not one per run.
   *
   * A phase transition whose shared seam is the **only** vertex either side draws
   * produces two singleton runs holding the same vertex, and emitting one marker per
   * run would stack two dots on one measurement and charge it twice against the render
   * budget. Since the seam is shared, both subpaths place the same vertex at the same
   * coordinate, so a measurement is identified by the attempt that produced it plus the
   * instant it sits at — not by position alone, because two zero-width attempts can
   * legitimately share a coordinate, and `test/completed-interaction.test.js` holds that
   * case.
   */
  const singletonByMeasurement = new Map()
  for (const series of [
    { key: 'reasoning', tone: 'neutral', built: reasoning },
    { key: 'output', tone: 'accent', built: output },
  ]) {
    for (const marker of series.built.markers) {
      const key = `${marker.attemptId ?? ''}@${marker.timeMs}`
      if (singletonByMeasurement.has(key)) continue
      singletonByMeasurement.set(key, {
        ...marker,
        x: round(marker.x),
        y: round(marker.y),
        series: series.key,
        tone: series.tone,
      })
    }
  }
  const markers = [...singletonByMeasurement.values()]
  /**
   * The same list, divided by series. It is a **filter of the enriched markers**, not the raw
   * `run.marker` list `buildSeries` collected, so a caller reading `series[].markers` gets the
   * tone and the originating series name each marker was de-duplicated under — and so the two
   * access paths cannot drift into describing the same dot differently.
   */
  const markersOf = key => markers.filter(marker => marker.series === key)
  const drawnPoints = reasoning.points + output.points
  const drawnRuns = reasoning.runs.filter(run => run.present).length
    + output.runs.filter(run => run.present).length
  /**
   * Whether any subpath has positive length. A run of two vertices **at the same
   * instant** — which a single-delta attempt whose successor owns the coordinate can
   * produce — is a real run with no segment, so counting runs would call the chart
   * drawable while nothing is drawn.
   */
  const hasSegment = reasoning.runs.concat(output.runs).some(run => (
    run.present && run.coordinates.length >= 2
    && run.coordinates[run.coordinates.length - 1].x > run.coordinates[0].x
  ))

  /**
   * The marker is placed only when the leading series' strongest **drawn** vertex is the
   * measurement the card prints.
   *
   * `peak.value` is the full-series maximum, measured before any budget is applied,
   * because a drawing limit may not move a reported statistic. The position, by contrast,
   * can only come from a vertex that survived onto the chart. Those two coincide whenever
   * the peak-bearing run is drawn — `allocateRunBudgets` seats it first, whatever its
   * length, and `downsampleRun` keeps its maximum — but they come apart if it is not,
   * and the failure is silent and misleading: the card prints `≈1000` and the dot lands on
   * a 400 tokens/s vertex, one pixel apart, with nothing on screen to distinguish them.
   *
   * Placing nothing is the honest degradation: a missing dot is visibly missing, and it is
   * what `curve.renderBudget.peakRetained` reports in words. Placing a different
   * measurement is not.
   */
  const placedPeak = peakValue !== null
    && leaderSeries.peak !== null
    && Math.abs(leaderSeries.peak.tps - peakValue) < 1e-9
    ? leaderSeries.peak
    : null

  return {
    kind: 'curve',
    durationMs,
    width: CURVE_VIEW_WIDTH,
    height: CURVE_PLOT_HEIGHT,
    axis: { max: axisMax, display: formatAxis(axisMax) },
    /**
     * Both series are always listed, in a fixed order, so the legend never
     * changes shape between turns. `present: false` means the phase produced
     * nothing to draw — an honest "no evidence", not a zero line. `present` says
     * whether the phase has a **drawable segment**, which is what its legend entry
     * claims; a phase whose only evidence is a single measured instant is marked
     * `markersOnly` instead, so the two are never conflated.
     */
    series: [
      { key: 'reasoning', tone: 'neutral', ...reasoning, markers: markersOf('reasoning') },
      { key: 'output', tone: 'accent', ...output, markers: markersOf('output') },
    ],
    /**
     * Whether the **whole** curve's magnitudes were anchored to authoritative provider
     * usage (`curve.source.calibrated`). The chart shows this only through the peak's
     * `≈`; a caller that wants to annotate provenance reads it here rather than
     * re-deriving it. It is `true` for `full` coverage only.
     */
    calibrated: calibratedOf(curve),
    /**
     * The same provenance, stated as coverage: `full`, `partial`, `none` or `fallback`.
     * `calibrated === false` covers three different situations — no usage at all, some
     * attempts anchored, and a join that could not be trusted — and they are not
     * interchangeable.
     */
    calibrationCoverage: calibrationCoverageOf(curve),
    /**
     * Per-phase colour segmentation of the same traces, carried through for
     * diagnostics and for tests that assert no drawable path crosses a stretch where
     * the model produced nothing.
     */
    phaseRuns: curve.phaseRuns ?? { reasoning: [], output: [] },
    /**
     * The peak is a sample of a shape-estimated series, so it is `≈` even when
     * the generated total is exact — a curve point is not a provider-certified
     * maximum (`docs/METRICS_SPEC.md` §9). `x`/`y` place the marker on the
     * measurement itself, and they are `null` when that measurement is not on the
     * chart — never a position borrowed from a weaker vertex.
     *
     * `value` is the published magnitude or `null`: it is `null` **only** when the
     * curve published no peak at all, and `0` means a measured peak of zero. The
     * `display` string is deliberately unchanged by that distinction — a peak that is
     * absent and a peak that is zero both print the em dash — because the point of the
     * split is to stop the field asserting a measurement, not to alter the card.
     */
    peak: {
      value: peakValue,
      display: axisPeak > 0 ? `≈${formatTps(axisPeak)}` : DASH,
      unit: 'tokens/s',
      approximate: true,
      leader,
      x: placedPeak === null ? null : round(placedPeak.x),
      y: placedPeak === null ? null : round(placedPeak.y),
    },
    /**
     * Drawn **path** vertices, so a test can assert the SVG input is bounded. A run of one
     * vertex contributes zero: it is drawn as a point marker, not as a vertex of a line,
     * and counting it here would make this number mean two different things.
     */
    drawnPoints,
    /** Rendered subpath count: one per drawable run, never one per series. */
    drawnRuns,
    /**
     * Point markers for one-vertex runs, one per measured instant.
     *
     * Each carries the tone of its own series, so a reasoning singleton and an output
     * singleton are distinguishable by the same channel the legend already uses. They
     * are markers, not data: the SVG is `aria-hidden` and so are they, and no count on
     * this object includes them — `renderElementPoints` below adds them explicitly.
     *
     * `isPeak` says whether this marker **is** the published peak, which is the one
     * visual distinction the plot makes between two markers: an ordinary singleton is
     * small and subdued, and only the peak keeps the stronger marker. A chart of forty
     * ordinary beads must not read as forty peaks.
     */
    markers: markers.map(marker => (
      placedPeak !== null
      && marker.timeMs === placedPeak.timeMs
      && Math.abs(marker.tps - placedPeak.tps) < 1e-9
        ? { ...marker, isPeak: true }
        : { ...marker, isPeak: false }
    )),
    /**
     * The quantity the chart-wide render budget bounds: line vertices **plus** singleton
     * markers, its own named sum.
     *
     * `drawnPoints` counts one half of what the plot emits and `markers.length` the other,
     * and naming the first `drawnPoints` invited a bound assertion that measured the chart
     * while leaving every marker outside it. The two remain separate because they are
     * different things — a vertex of a polyline and a standalone dot — but no caller has to
     * add them up by hand to check the bound. A phase-transition seam is counted in
     * `drawnPoints` twice, because both subpaths do emit it.
     */
    renderElementPoints: drawnPoints + markers.length,
    /**
     * True when the chart's only evidence is single-vertex runs. The renderer
     * needs it because `drawnRuns === 0` with `markers.length > 0` is a chart that has
     * something to show and no line to show it with — the case that must not render
     * the "no curve" placeholder.
     */
    markersOnly: !hasSegment && markers.length > 0,
  }
}

;Object.assign(__exports, { CURVE_VIEW_WIDTH, CURVE_PLOT_HEIGHT, niceCeiling, curveViewModel })
			},
			"src/client/completed/view-mode.js": function (__exports) {
/**
 * Completed-card presentation state — the whole interaction state machine, pure.
 *
 * A settled card carries **two** orthogonal presentation decisions, and they are
 * deliberately kept apart because they answer different questions:
 *
 *   - `collapsed` — is the detail on screen at all? Every newly materialized
 *     card starts collapsed, so a transcript of twenty settled turns is twenty
 *     compact rows rather than twenty metric panels stacked above the composer;
 *   - `mode` — while the detail *is* on screen, is it showing the metric summary
 *     or the throughput curve? The curve appears while the reader points at or
 *     focuses the detail and disappears when they stop.
 *
 * Because they are orthogonal, the reader can never reach a settled card that is
 * expanded-but-curve-first: collapsing resets the mode, so expanding always opens
 * the summary. That rule exists so the two decisions cannot drift into a state
 * the reader did not ask for, and it is the reason `toggle` writes both fields
 * rather than flipping one of them.
 *
 * Three further decisions are worth stating because they are not obvious:
 *
 *   - **Focus is the touch path.** A tap focuses a `tabindex="0"` element in
 *     every current mobile browser, so there is no separate touch handler and no
 *     `:hover` emulation to keep in sync. Blurring returns to the summary.
 *   - **A blur that stays inside the card does not close the curve.** `blur`
 *     fires while focus moves between elements, so without the guard a future
 *     focusable child would make the view flicker shut on the way to it.
 *   - **The header is not part of the curve surface.** The expand/collapse button
 *     and the curve hover live on different elements, so a reader who tabs onto
 *     the toggle never has the chart appear under their cursor. That separation is
 *     structural (`completed-tree.js` binds the handlers to `.dsh-tpm-detail`), and
 *     `nextCompletedPresentation` states the half of it that is state: an
 *     `enter`/`focus` event while collapsed changes nothing at all.
 *
 * An un-interactive detail (a turn with no curve data) can never leave the
 * summary: there is nothing behind the hover, so nothing may appear to be.
 */

const COMPLETED_VIEW_SUMMARY = 'summary'
const COMPLETED_VIEW_CURVE = 'curve'

/** Presentation state of one settled card. `collapsed` is the default for every new card. */
function defaultCompletedPresentationState() {
  return { collapsed: true, mode: COMPLETED_VIEW_SUMMARY }
}

/**
 * One transition of the completed card's presentation state.
 *
 * `toggle` is the header button; `enter`/`leave`/`focus`/`blur` are the detail
 * region's pointer and keyboard events; `reset` is a new settled view arriving.
 * Events that the current state does not admit are no-ops rather than resets,
 * which is what keeps a stray `mouseleave` from collapsing an open card.
 *
 * @param {{collapsed: boolean, mode: 'summary'|'curve'}} state current presentation state
 * @param {{type: string, staysInside?: boolean}} event one presentation event
 * @param {{interactive: boolean}} context whether an alternate view exists
 * @returns {{collapsed: boolean, mode: 'summary'|'curve'}} the next presentation state
 */
function nextCompletedPresentation(state, event, { interactive }) {
  const current = normalizePresentation(state)

  switch (event?.type) {
    case 'reset':
      return defaultCompletedPresentationState()
    case 'toggle':
      /**
       * Collapsing resets the mode, which is what makes "expand always opens the
       * summary" true even for a reader who was last looking at the curve.
       */
      return current.collapsed
        ? { collapsed: false, mode: COMPLETED_VIEW_SUMMARY }
        : defaultCompletedPresentationState()
    default:
      break
  }

  /** Nothing behind the header: a collapsed card ignores hover and focus entirely. */
  if (current.collapsed) return current

  return { collapsed: false, mode: nextViewMode(current.mode, event, { interactive }) }
}

/**
 * The mode half of the machine on its own.
 *
 * Retained as its own exported contract because the curve transitions are the
 * tested Phase 5 behaviour and because `nextCompletedPresentation` is only their
 * caller: whatever this function says about the curve stays true for the card.
 *
 * @param {'summary'|'curve'} mode current mode
 * @param {{type: string, staysInside?: boolean}} event one interaction event
 * @param {{interactive: boolean}} context whether an alternate view exists
 * @returns {'summary'|'curve'} the next mode
 */
function nextViewMode(mode, event, { interactive }) {
  /**
   * An un-interactive card has no alternate view, so it is in the summary by
   * invariant — not merely by the absence of an event that would open the curve.
   */
  if (!interactive) return COMPLETED_VIEW_SUMMARY

  switch (event?.type) {
    case 'enter':
    case 'focus':
      return COMPLETED_VIEW_CURVE
    case 'leave':
    case 'reset':
      return COMPLETED_VIEW_SUMMARY
    case 'blur':
      return event.staysInside === true ? mode : COMPLETED_VIEW_SUMMARY
    default:
      return mode
  }
}

/**
 * Coerce an untrusted state object into the two-field shape.
 *
 * A state that did not come from `defaultCompletedPresentationState` — a stale
 * value from an earlier revision of this module, or a hand-written literal in a
 * test — must not be able to produce a card that is `undefined`-collapsed, which
 * would render the detail. Anything unrecognized degrades to the default.
 */
function normalizePresentation(state) {
  return {
    collapsed: state?.collapsed !== false,
    mode: state?.mode === COMPLETED_VIEW_CURVE ? COMPLETED_VIEW_CURVE : COMPLETED_VIEW_SUMMARY,
  }
}

;Object.assign(__exports, { COMPLETED_VIEW_SUMMARY, COMPLETED_VIEW_CURVE, defaultCompletedPresentationState, nextCompletedPresentation, nextViewMode })
			},
			"src/client/completed/CompletedMeter.js": function (__exports) {
/**
 * Completed turn card (browser only — this module imports `react`, so Node tests
 * must not import it directly; the structural assertions live in
 * `test/completed-tree.test.js`, which exercises `completed-tree.js` with a
 * recording `createElement`).
 *
 * Rendering contract:
 *
 *   - the component receives a finished `completedViewModel` and renders fields.
 *     It never reads a `SessionEvent`, never sees a settled snapshot, never
 *     computes a rate, a token count, a duration or a quality marker, and never
 *     decides whether `≈` applies — `src/client/ui-model.js` already decided;
 *   - geometry is not computed here either: `curveViewModel` runs once per
 *     settled turn and the SVG receives finished path data;
 *   - it owns **no timer**. A completed turn is static, so there is no ticker
 *     here, no elapsed refresh and no rolling value. The card changes only when a
 *     new view model arrives (session switch, next turn's end, rebaseline), or
 *     when the reader asks for it — by expanding the row, or by pointing at or
 *     focusing the detail it revealed;
 *   - the presentation state is `nextCompletedPresentation` in `./view-mode.js`,
 *     which is where the collapse, reset, hover/focus/blur rules are stated and
 *     tested. This file only translates DOM events into that function's
 *     vocabulary.
 *
 * Two pieces of state is the whole component. They are held as **one** value
 * rather than two `useState` calls because they are written together by the
 * transitions that matter — a collapse is simultaneously "hide the detail" and
 * "forget the curve" — and splitting them would allow a render in which the card
 * is collapsed but still remembers the curve, which is exactly the state the
 * round forbids.
 */

const { createElement: h, useEffect, useRef, useState } = __ext("react")
const { completedTree } = __req("src/client/completed/completed-tree.js")
const { curveViewModel } = __req("src/client/completed/curve-view-model.js")
const { defaultCompletedPresentationState, nextCompletedPresentation } = __req("src/client/completed/view-mode.js")

/**
 * The card.
 *
 * @param {{view: object, translate: (key: string) => string}} props
 */
function CompletedMeter({ view, translate }) {
  /**
   * Built once per settled turn. `view` is memoized by the controller per
   * `(session, turn)`, so hovering does not rebuild the geometry while a new turn
   * does. The effect below is the only other writer, and it runs exactly when the
   * turn changes.
   */
  const [curveView, setCurveView] = useState(() => curveViewModel(view))
  const [presentation, setPresentation] = useState(defaultCompletedPresentationState)

  const previousView = useRef(view)
  useEffect(() => {
    if (previousView.current === view) return
    previousView.current = view
    setCurveView(curveViewModel(view))
    /**
     * A new settled view is a new card. Phase 5 reset the detail mode here; Phase
     * 9 resets the collapse with it, so the next turn arrives as a compact row
     * rather than as whatever the previous turn was left showing. This is also
     * what makes a reload and a session switch-back start collapsed: both
     * materialize the component afresh and both land here.
     */
    setPresentation(defaultCompletedPresentationState())
  }, [view])

  /** No curve means nothing is hidden behind hover, so the detail stays inert. */
  const interactive = curveView !== null
  const dispatch = (event) => setPresentation(current => nextCompletedPresentation(current, event, { interactive }))

  return completedTree(h, view, translate, {
    collapsed: presentation.collapsed,
    mode: presentation.mode,
    curveView,
    onToggle: () => dispatch({ type: 'toggle' }),
    onEnter: () => dispatch({ type: 'enter' }),
    onLeave: () => dispatch({ type: 'leave' }),
    onFocus: () => dispatch({ type: 'focus' }),
    onBlur: (event) => {
      const next = event?.relatedTarget
      const staysInside = next !== null && next !== undefined && event?.currentTarget?.contains?.(next) === true
      dispatch({ type: 'blur', staysInside })
    },
  })
}

;Object.assign(__exports, { CompletedMeter })
			},
			"src/client/live/live-css.js": function (__exports) {
/**
 * Scoped stylesheet for the live meter.
 *
 * Reference: `docs/assets/reference-live-ttft.png` and
 * `docs/assets/reference-live-streaming.png`. Measured from those captures,
 * corrected to CSS pixels against the composer placeholder's ink height: a
 * centred horizontal pill roughly 49 px tall, radius about 10 px, one filled
 * surface, and a single dominant number per state.
 *
 * What that measurement changed, relative to the functional skeleton:
 *
 *   - the reference's first visual focus is the *number*, not a text row. Each
 *     state therefore renders its number through `.dsh-tpm-number` at
 *     `1.7 x` the host content size, and everything else is `0.95 x`-`1.25 x`;
 *   - the unit is a separate baseline-aligned run at `0.95 x` instead of being
 *     glued to the digits at the same size;
 *   - the pill keeps the reference's generous horizontal padding (about 1.55 em)
 *     so the number is not crowded against the border;
 *   - the separator is a hairline that stretches the content height, which is
 *     what makes one pill read as two regions rather than one run-on sentence.
 *
 * Delivery and scoping rules are documented once in `../base-css.js`.
 */

const LIVE_STYLE_ID = 'dsh-tpm-live-style'

const LIVE_CSS = `
.dsh-tpm-pill {
  box-sizing: border-box;
  max-width: min(100%, var(--dsh-composer-card-max-width, 100%));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: calc(var(--dsh-tpm-font) * .5);
  padding: calc(var(--dsh-tpm-font) * .62) calc(var(--dsh-tpm-font) * 1.55);
  border-radius: 10px;
  border: .5px solid var(--dsh-tpm-hairline);
  background: var(--dsh-tpm-surface);
  color: var(--dsw-alias-label-primary, #3c3c3d);
  line-height: 1.25;
}
.dsh-tpm-number {
  font-size: calc(var(--dsh-tpm-font) * 1.7);
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -.01em;
  color: var(--dsw-alias-label-primary, #3c3c3d);
}
.dsh-tpm-number[data-tone="accent"] {
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-unit {
  font-size: calc(var(--dsh-tpm-font) * .95);
  font-weight: 400;
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-label {
  font-size: calc(var(--dsh-tpm-font) * .95);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-stage {
  font-size: calc(var(--dsh-tpm-font) * 1.15);
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-elapsed {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-tool {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  max-width: 16em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-tpm-sep {
  width: .5px;
  align-self: stretch;
  min-height: calc(var(--dsh-tpm-font) * 1.6);
  background: var(--dsh-tpm-hairline);
}
/* A number and its unit are one visual token: keep them from wrapping apart. */
.dsh-tpm-metric {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .25);
  white-space: nowrap;
}
`

;Object.assign(__exports, { LIVE_STYLE_ID, LIVE_CSS })
			},
			"src/client/completed/completed-css.js": function (__exports) {
/**
 * Scoped stylesheet for the completed turn card.
 *
 * ## Two reference layers, deliberately not mixed
 *
 * The **card surface** is no longer a measurement. Phase 9 takes it from the
 * official DSH TodoPanel, because the completed card and the todo panel are
 * sibling rows in one composer dock and two panels with different corners, fills
 * and shadows read as two plugins rather than as one product. The contract below
 * is copied from
 * `packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css` at
 * DSH `0.1.7-rc.2` (reference commit `477b4f4`), token for token — no sampled hex,
 * no hand-chosen radius, no fallback for a token this version is pinned to.
 *
 * The **expanded detail** keeps the Phase 5 metric grid, measured from
 * `docs/assets/reference-completed-summary.png` and
 * `docs/assets/reference-hover-curve.png`:
 *
 *   - **four equal columns** with a hairline between each, and the first label's
 *     ink 26 px from the card edge;
 *   - a three-row rhythm per column: 13 px label, 22 px value, 12 px secondary;
 *   - the curve view replaces the **first two** columns with one panel spanning
 *     the same two grid tracks, so the generated-token and TTFT columns keep
 *     their exact positions and dividers across the switch.
 *
 * The two layers meet at one number. The card shell now carries the host's
 * `padding: 6px 12px`, so the detail's own inline padding is `26px - 12px = 14px`
 * rather than the 26 px it used to carry alone: the reference geometry is a
 * *distance from the card edge*, not a padding of one particular element, and it
 * survives the shell change only because it is restated on the inner one.
 *
 * Both detail views are stacked in one grid cell (`.dsh-tpm-views`), which is
 * what makes the expanded card's height stable: the container is as tall as the
 * taller view and a switch cannot change it — at any width, at any host font size,
 * and without measuring anything in JavaScript.
 *
 * Delivery and scoping rules are documented once in `../base-css.js`.
 */

const COMPLETED_STYLE_ID = 'dsh-tpm-completed-style'

/**
 * The host's dock geometry, as a repeated expression rather than a variable.
 *
 * DSH's TodoPanel writes the two `calc()`s out in full; this constant keeps the
 * two roots from drifting apart if a future phase has to revisit one of them,
 * while the emitted CSS stays the same tokens in the same order.
 */
const DOCK_WIDTH = 'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance)'
  + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)'
  + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))'
const DOCK_MAX_WIDTH = 'calc(var(--dsh-composer-card-max-width)'
  + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)'
  + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))'

const COMPLETED_CSS = `
/* The dock seat. Width, centring and the panel surface come from the host's own
   dock formula, so the completed card's left and right edges land on the todo
   panel's rather than near them. The live pill keeps its own contract: it is a
   different row with a different reference and is not touched here. */
.dsh-tpm-root[data-kind="completed"] {
  box-sizing: border-box;
  width: ${DOCK_WIDTH};
  max-width: ${DOCK_MAX_WIDTH};
  margin: 0 auto;
  display: block;
  justify-content: flex-start;
}
/* The panel itself: TodoPanel's surface, unchanged. \`border: 0\` and the
   elevation-stroke variable are the host's pair — the hairline an outlined panel
   would draw is replaced by the elevation's own stroke, which is why the card
   below declares no border of its own. */
.dsh-tpm-card {
  box-sizing: border-box;
  width: 100%;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  box-shadow: var(--dsw-elevation-panel);
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  line-height: 1.4;
}
/* The host's body rhythm: 6px 12px with an 8px column gap. The gap is unused
   while collapsed, which is correct — a one-row panel is one row. */
.dsh-tpm-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 12px;
}
/* The whole header row is the button, as in the host. The background and border
   are reset rather than the button being replaced by a div, so the control keeps
   its keyboard and pointer semantics. */
.dsh-tpm-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.dsh-tpm-card-header:focus-visible {
  outline: 2px solid var(--dsh-tpm-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.dsh-tpm-card-lead {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-card-title {
  flex: none;
  font-size: 13px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #3c3c3d);
}
/* The one line the collapsed row is for. \`flex: auto\` with \`min-width: 0\` is what
   makes the ellipsis reachable: without the zero floor the flex item refuses to
   shrink below its content and the row pushes the chevron off the card instead. */
.dsh-tpm-card-progress {
  flex: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-card-chevron {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
/* The detail is rendered only while expanded, so it needs no collapsed rule —
   there is no hidden state to keep out of the layout or the accessibility tree. */
.dsh-tpm-detail {
  display: flex;
  flex-direction: column;
  /* The reference keeps its first label 26px from the card edge; 12px of that is
     the shell's own inline padding. */
  padding: 4px 14px 0;
}
/* The detail is focusable only when it has an alternate view to reveal, and the
   ring is replaced rather than removed. */
.dsh-tpm-detail:focus-visible {
  outline: 2px solid var(--dsh-tpm-accent);
  outline-offset: 2px;
}
.dsh-tpm-views {
  display: grid;
}
.dsh-tpm-view {
  grid-area: 1 / 1;
  transition: opacity 220ms ease;
}
.dsh-tpm-view[data-visible="false"] {
  opacity: 0;
  pointer-events: none;
}
.dsh-tpm-cells {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: start;
}
.dsh-tpm-cell {
  min-width: 0;
  padding-inline: calc(var(--dsh-tpm-font) * 2);
}
.dsh-tpm-cell + .dsh-tpm-cell,
.dsh-tpm-curve-panel + .dsh-tpm-cell {
  border-inline-start: .5px solid var(--dsh-tpm-hairline);
}
.dsh-tpm-cell-label {
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-cell-value {
  display: flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .28);
  min-width: 0;
  margin: calc(var(--dsh-tpm-font) * .3) 0 calc(var(--dsh-tpm-font) * .45);
}
.dsh-tpm-cell-number {
  font-size: calc(var(--dsh-tpm-font) * 1.7);
  line-height: 1.28;
  font-weight: 600;
  letter-spacing: -.01em;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  white-space: nowrap;
}
.dsh-tpm-cell[data-metric="outputTps"] .dsh-tpm-cell-number {
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-cell-unit {
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.2;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  white-space: nowrap;
}
.dsh-tpm-cell-sub {
  font-size: calc(var(--dsh-tpm-font) * .92);
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary, #7f8287);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-cell-sub[data-tone="warn"] { color: var(--dsw-alias-state-warn-label, #b26a00); }
.dsh-tpm-cell-sub[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d03050); }
.dsh-tpm-curve-panel {
  grid-column: span 2;
  min-width: 0;
  padding-inline: calc(var(--dsh-tpm-font) * 2);
  display: flex;
  flex-direction: column;
}
.dsh-tpm-curve-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(var(--dsh-tpm-font) * .75);
  min-width: 0;
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.45;
}
.dsh-tpm-legend {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .85);
  min-width: 0;
  overflow: hidden;
}
.dsh-tpm-legend-item {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .38);
  color: var(--dsw-alias-label-secondary, #7f8287);
  white-space: nowrap;
}
.dsh-tpm-legend-item[data-absent="true"] { opacity: .45; }
.dsh-tpm-legend-swatch {
  width: calc(var(--dsh-tpm-font) * .5);
  height: calc(var(--dsh-tpm-font) * .5);
  border-radius: 1px;
  background: var(--dsw-alias-label-tertiary, #a2a4a6);
  transform: translateY(-1px);
}
.dsh-tpm-legend-item[data-series="output"] .dsh-tpm-legend-swatch {
  background: var(--dsh-tpm-accent);
}
.dsh-tpm-peak {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .32);
  white-space: nowrap;
}
.dsh-tpm-peak-label { color: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-peak-value {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  font-weight: 600;
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-peak-unit { color: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-plot {
  display: flex;
  align-items: stretch;
  height: calc(var(--dsh-tpm-font) * 3.7);
  margin-top: calc(var(--dsh-tpm-font) * .43);
  min-width: 0;
}
.dsh-tpm-plot-area {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-tpm-plot-svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.dsh-tpm-series {
  fill: none;
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.dsh-tpm-series[data-series="reasoning"] { stroke: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-series[data-series="output"] { stroke: var(--dsh-tpm-accent); }
.dsh-tpm-peak-dot {
  position: absolute;
  width: calc(var(--dsh-tpm-font) * .42);
  height: calc(var(--dsh-tpm-font) * .42);
  margin: 0;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-peak-dot[data-leader="output"] { background: var(--dsh-tpm-accent); }
/*
   Two marker levels, because one size for both made a chart of many single-measurement
   stretches read as a field of peaks. 0.24 x font is roughly a quarter of the plot
   height and about half the previous 0.42, which was the size the peak uses and is
   the size that made dozens of ordinary beads dominate the trace; the opacity is kept
   below 1 for the same reason. The labels, the legend and the printed peak are
   unchanged, so nothing a reader relies on became smaller — only the decoration.
   Both tones resolve through DSH aliases, so light and dark themes follow the host
   without a second rule. */
.dsh-tpm-singleton-dot {
  position: absolute;
  width: calc(var(--dsh-tpm-font) * .24);
  height: calc(var(--dsh-tpm-font) * .24);
  margin: 0;
  border-radius: 50%;
  opacity: .75;
  transform: translate(-50%, -50%);
  background: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-singleton-dot[data-series="output"] { background: var(--dsh-tpm-accent); }
/* A singleton that *is* the published peak keeps the peak's own size: the peak dot
   is drawn at the same coordinate, and a smaller circle would leave a visible ring
   of the larger one behind it. */
.dsh-tpm-singleton-dot[data-peak="true"] {
  width: calc(var(--dsh-tpm-font) * .42);
  height: calc(var(--dsh-tpm-font) * .42);
  opacity: 1;
}
.dsh-tpm-axis-max {
  flex: 0 0 auto;
  align-self: flex-start;
  padding-inline-start: calc(var(--dsh-tpm-font) * .4);
  font-size: calc(var(--dsh-tpm-font) * .85);
  line-height: 1;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-plot-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  font-size: calc(var(--dsh-tpm-font) * .92);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .35) calc(var(--dsh-tpm-font) * .8);
  /* The same 26px-from-the-card-edge rule as the cells, less the 14px the detail
     already carries. */
  margin: calc(var(--dsh-tpm-font) * .6) calc(var(--dsh-tpm-font) * .92) 0;
  padding-top: calc(var(--dsh-tpm-font) * .5);
  border-top: .5px solid var(--dsh-tpm-hairline);
  font-size: calc(var(--dsh-tpm-font) * .85);
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-foot-item {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-foot-item + .dsh-tpm-foot-item::before {
  content: '·';
  margin-inline-end: calc(var(--dsh-tpm-font) * .8);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
@media (max-width: 34rem) {
  .dsh-tpm-cells {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: calc(var(--dsh-tpm-font) * .8);
  }
  .dsh-tpm-cell:nth-child(odd) { border-inline-start-color: transparent; }
  .dsh-tpm-cell:nth-child(n + 3) {
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
  .dsh-tpm-curve-panel + .dsh-tpm-cell {
    border-inline-start-color: transparent;
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
  .dsh-tpm-curve-panel + .dsh-tpm-cell + .dsh-tpm-cell {
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
}
`

;Object.assign(__exports, { COMPLETED_STYLE_ID, COMPLETED_CSS })
			},
			"src/client/base-css.js": function (__exports) {
/**
 * Shared scoped tokens for the plugin's two stylesheets.
 *
 * Delivered as a module string for the same reason as the view stylesheets: a
 * DSH factory bundle has no CSS import mechanism, and the module system claims
 * `style[data-plugin]` tags for HMR bookkeeping. `MeterRoot.js` concatenates
 * this block with the live and completed sheets into one tag.
 *
 * Rules:
 *   - every selector is scoped under `.dsh-tpm-root`; the only exception is the
 *     documented `body[data-ds-dark-theme] .dsh-tpm-root` theme override, which
 *     is the selector the shipped DSH theme CSS itself uses;
 *   - no element selectors, no `body` typography, no global `div`/`span`/`svg`
 *     rules — the plugin must not be able to restyle anything it does not own;
 *   - every colour resolves through a host `--dsw-*` alias token so light and
 *     dark come from the active DSH theme; the fallbacks exist only so a missing
 *     token degrades to a readable value;
 *   - **one type scale.** `--dsh-tpm-font` follows the host's secondary content
 *     size (the same variable `StatsPills` reads), and every other size is a
 *     multiple of it. A user who changes DSH's font size therefore scales the
 *     whole meter with the surrounding UI instead of leaving one card behind.
 */

/**
 * `--dsh-tpm-accent` is the plugin's single self-defined value.
 *
 * Measured from `docs/assets/reference-completed-summary.png`, whose output-rate
 * number is `#fb8147`. That exact value scores 2.31:1 against the reference's own
 * card surface, which is below the 3:1 floor for large text, so the shipped
 * accent keeps the reference's hue (about 21 degrees) and darkens it to 3.4:1 —
 * closer to the reference than the previous `#d9480f` while remaining legible.
 * `docs/IMPLEMENTATION_LOG.md` records the measurement and the deviation.
 */
const BASE_STYLE_ID = 'dsh-tpm-base-style'

const BASE_CSS = `
.dsh-tpm-root {
  --dsh-tpm-font: var(--dsh-content-font-size-secondary, 13px);
  --dsh-tpm-accent: #d9600f;
  --dsh-tpm-surface: var(--dsw-alias-bg-module-platform, var(--dsw-specific-tip, rgba(127, 130, 135, .10)));
  --dsh-tpm-hairline: var(--dsw-alias-separator-primary, var(--dsw-alias-border-l1, rgba(127, 130, 135, .28)));
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  display: flex;
  justify-content: center;
  font-size: var(--dsh-tpm-font);
  font-variant-numeric: tabular-nums;
}
body[data-ds-dark-theme] .dsh-tpm-root {
  --dsh-tpm-accent: #ff9a5c;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-tpm-root * {
    transition: none !important;
    animation: none !important;
  }
}
`

;Object.assign(__exports, { BASE_STYLE_ID, BASE_CSS })
			},
			"src/client/live/MeterRoot.js": function (__exports) {
/**
 * Meter root: the one slot component for this plugin.
 *
 * It owns the presentation lifecycle that both views share, and nothing else:
 *
 *   - `inactive`/no session, and only then, renders nothing;
 *   - the live pill while a turn is open;
 *   - the completed card once the session's turn has settled;
 *   - exactly one subscription per attached session (attach is idempotent);
 *   - exactly one presentation ticker while a **live** view is on screen, at the
 *     single cadence owned by `./cadence.js`, and **no timer at all** while the
 *     completed card is on screen. A settled turn is static, so the card is
 *     written once and never re-rendered by a clock; the scheduler stops on the
 *     same state advance that reveals it;
 *   - one reference-counted style tag for the whole plugin (live pill CSS and
 *     completed card CSS together), removed with the last unmount so HMR cannot
 *     accumulate `style` elements.
 *
 * Live and completed are mutually exclusive by construction: the projection comes
 * from a single state advance in the controller (see `controller.js` `project`),
 * so a `turn/end` publish yields the card immediately and a following
 * `turn/start` yields the pill immediately.
 *
 * ## One state update per presentation tick
 *
 * `onRender` calls `refreshView()` and nothing else. An earlier revision also
 * called a `useReducer` bump to "force" the render; the audit that removed it:
 *
 *   - `refreshView` calls `setView` with the object `controller.project(id,
 *     Date.now())` returned;
 *   - the projection key includes the presentation instant
 *     (`controller.js` `projectionKey`), so a tick never re-uses the cached
 *     view object — `setView` therefore always receives a new identity and
 *     always schedules exactly one render;
 *   - a second dispatcher in the same tick could therefore only ever add a
 *     redundant update, and at the selected cadence that is a measurable cost
 *     with no visible effect.
 *
 * The invariant is asserted by `test/meter-root.test.js`, which drives a real
 * `onRender` through a recording React stub and counts dispatches per tick.
 */

const { createElement: h, useEffect, useRef, useState } = __ext("react")
const { createPresentationScheduler } = __req("src/client/live/refresh.js")
const { LivePill, meterDiagnostics } = __req("src/client/live/LiveMeter.js")
const { CompletedMeter } = __req("src/client/completed/CompletedMeter.js")
const { LIVE_CSS, LIVE_STYLE_ID } = __req("src/client/live/live-css.js")
const { COMPLETED_CSS } = __req("src/client/completed/completed-css.js")
const { BASE_CSS } = __req("src/client/base-css.js")

/** Reference count for the plugin's single style tag. */
let styleUsers = 0

/**
 * Shared tokens first, then the pill sheet, then the card sheet. The order is
 * the cascade: the base block declares the tokens both view sheets consume, and
 * neither view sheet redeclares them.
 */
const PLUGIN_CSS = `${BASE_CSS}\n${LIVE_CSS}\n${COMPLETED_CSS}`

/**
 * A projection that cannot change until an event arrives.
 *
 * A completed card is the only such view: it is a pure function of the settled
 * turn, so it is rebuilt once per event and never by a clock. `hidden` is *not*
 * static in this sense — it means "no view for this session", and the meter is
 * not on screen to be rebuilt — which is why the ticker's own lifecycle below
 * tests `view.kind !== 'hidden'` separately.
 */
function isStatic(view) {
  return view.kind === 'completed'
}

function acquireStyle() {
  let element = document.getElementById(LIVE_STYLE_ID)
  if (element === null) {
    element = document.createElement('style')
    element.id = LIVE_STYLE_ID
    element.setAttribute('data-plugin', 'dsh-turn-performance-meter')
    element.textContent = PLUGIN_CSS
    document.head.appendChild(element)
  }
  styleUsers += 1
  return () => {
    styleUsers = Math.max(0, styleUsers - 1)
    if (styleUsers === 0) {
      const owned = document.getElementById(LIVE_STYLE_ID)
      if (owned !== null) owned.remove()
    }
  }
}

/**
 * Build the slot component. The controller and translate function close over the
 * registration site (`src/client/main.js`), so the component itself stays a pure
 * function of `(props, controller state)`.
 *
 * @param {{controller: object, t: (key: string) => string, debug?: boolean}} options
 */
function makeMeterSlot({ controller, t, debug = false }) {
  const translate = typeof t === 'function' ? t : (key => key)

  return function TurnPerformanceMeter(props) {
    const sessionId = typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null

    // Debug-only: report the seat's actual prop shape once per session value, so
    // a missing `sessionId` standard prop shows up as itself rather than as a
    // silently hidden meter. No per-delta logging exists anywhere.
    const seenSession = useRef(null)
    if (debug && seenSession.current !== sessionId) {
      seenSession.current = sessionId
      try {
        console.debug('[dsh-tpm] slot prop shape', Object.keys(props ?? {}), 'sessionId =', sessionId)
      } catch { /* diagnostics must never break render */ }
    }

    /**
     * The projected view is *state*, refreshed only by the presentation
     * scheduler (once per mount/session change, and while live on each tick) —
     * never during render. The slot's owner re-renders its occupants on every
     * chat update; if each of those renders re-projected `Date.now()`, the DOM
     * would update at the chat's cadence and bypass the throttle.
     */
    const [view, setView] = useState(() => (
      sessionId === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(sessionId, Date.now())
    ))

    const sessionIdRef = useRef(sessionId)
    sessionIdRef.current = sessionId
    const viewRef = useRef(view)
    viewRef.current = view
    const refreshView = () => {
      meterDiagnostics().refreshCalls += 1
      const id = sessionIdRef.current
      setView(id === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(id, Date.now()))
    }

    /** Created once per mounted meter; disposed implicitly by the effect below. */
    const [scheduler] = useState(() => {
      const diagnostics = meterDiagnostics()
      diagnostics.schedulerCreated += 1
      const created = createPresentationScheduler({
        intervalMs: controller.refreshMs,
        // Exactly one state update per tick: `refreshView` owns the render.
        onRender: () => {
          diagnostics.renderCalls += 1
          refreshView()
        },
      })
      diagnostics.currentScheduler = created
      return created
    })

    useEffect(() => acquireStyle(), [])

    useEffect(() => {
      if (sessionId === null) {
        refreshView()
        return undefined
      }
      const attached = controller.attach(sessionId)
      if (debug) {
        try { console.debug('[dsh-tpm] attach', sessionId, '=>', attached) } catch { /* diagnostics */ }
      }
      refreshView()
      return controller.subscribe(() => {
        meterDiagnostics().notifyCalls += 1
        /**
         * A static projection can only change on a new event, so it is rebuilt
         * once per event and never re-rendered by a timer. `refreshView` runs
         * directly instead of through the scheduler, which is what leaves **no
         * timer** for a completed card: the scheduler is never even notified.
         */
        if (isStatic(viewRef.current)) refreshView()
        else scheduler.notify()
      })
    }, [sessionId, controller, scheduler, debug])

    // The single presentation ticker: on only while a live view is visible,
    // stopped on hide, on completion and on unmount. Ingestion is never
    // throttled.
    const visible = view.kind !== 'hidden'
    const live = visible && !isStatic(view)
    useEffect(() => {
      if (!live) {
        scheduler.stop()
        return undefined
      }
      scheduler.start()
      return () => scheduler.stop()
    }, [live, scheduler])

    if (!visible) return null
    if (view.kind === 'completed') return h(CompletedMeter, { view, translate })
    return h(LivePill, { view, translate })
  }
}

;Object.assign(__exports, { makeMeterSlot })
			},
			"src/client/live/locale.js": function (__exports) {
/**
 * Locale dictionary and translate wrapper.
 *
 * Visible production strings go through the DSH Client locale service
 * (`ctx.locale.register(ns, {en, zh})` + `ctx.locale.bind(ns)`, verified at
 * `dsh-client-locale/lib/types/client/index.d.ts:198-215`). The wrapper keeps
 * an in-module English fallback so a locale-service failure degrades to a
 * readable label instead of to raw keys.
 *
 * Tool names and numeric units stay locale-independent: `tokens/s` and the
 * `pwsh +1` count suffix are identical in both locales, which is also what the
 * reference screenshots show.
 */

const LOCALE_NS = 'turnPerformanceMeter'

const LOCALE_DICTS = Object.freeze({
  en: Object.freeze({
    meterLabel: 'Live turn performance',
    ttft: 'first response timer',
    thinking: 'thinking',
    output: 'output',
    waiting: 'waiting for model',
    transition: 'processing',
    tool: 'tool',
    tpsUnit: 'tokens/s',
    // Completed card. `performanceTitle` is the compact header's visible title:
    // short enough to sit beside a one-line summary, unlike `completedLabel`,
    // which stays the accessible name of the card and the button.
    performanceTitle: 'Performance',
    completedLabel: 'Turn performance summary',
    colReasoningTps: 'Reasoning TPS',
    colOutputTps: 'Output TPS',
    colGeneratedTokens: 'Generated Tokens',
    colTtft: 'TTFT',
    elapsed: 'elapsed',
    tools: 'tools',
    attempts: 'attempts',
    'status.completed': 'completed',
    'status.interrupted': 'interrupted',
    'status.errored': 'errored',
    'status.max-tokens': 'token limit reached',
    turnLabel: 'turn',
    unavailable: 'unavailable',
    'quality.exact': 'exact',
    'quality.approximate': 'approximate',
    // Curve view: the legend reuses `thinking`/`output`, so only the panel's own
    // copy and the peak readout need entries here.
    curveLabel: 'Throughput curve',
    curveHint: 'Hover or focus for the throughput curve',
    curveUnavailable: 'no throughput samples',
    peak: 'peak',
  }),
  zh: Object.freeze({
    meterLabel: '实时性能',
    ttft: '首响应计时',
    thinking: '思考',
    output: '输出',
    waiting: '等待模型',
    transition: '处理中',
    tool: '工具',
    tpsUnit: 'tokens/s',
    performanceTitle: '性能',
    completedLabel: '本轮性能统计',
    colReasoningTps: '思考 TPS',
    colOutputTps: '输出 TPS',
    colGeneratedTokens: '生成 Tokens',
    colTtft: '首响应',
    elapsed: '总用时',
    tools: '工具',
    attempts: '模型调用',
    'status.completed': '已完成',
    'status.interrupted': '已中断',
    'status.errored': '出错',
    'status.max-tokens': '达到 Token 上限',
    turnLabel: '第',
    unavailable: '不可用',
    'quality.exact': '精确',
    'quality.approximate': '近似',
    curveLabel: '吞吐曲线',
    curveHint: '悬停或聚焦查看吞吐曲线',
    curveUnavailable: '无吞吐采样',
    peak: '峰值',
  }),
})

/**
 * Wrap the locale-bound translate function with an English fallback.
 *
 * `bind(ns)` returns a function looked up against the active language at call
 * time, so locale switches are picked up on the next render. If the service is
 * absent, throws, or returns the key itself, the built-in `en` entry (or the
 * key) is used — never `undefined` in visible UI.
 *
 * @param {unknown} rawT the `ctx.locale.bind(LOCALE_NS)` result, or null
 * @returns {(key: string) => string}
 */
function wrapTranslate(rawT) {
  return (key) => {
    if (typeof rawT === 'function') {
      try {
        const value = rawT(key)
        if (typeof value === 'string' && value.length > 0 && value !== key) return value
      } catch { /* fall through to the built-in dictionary */ }
    }
    return LOCALE_DICTS.en[key] ?? key
  }
}

;Object.assign(__exports, { LOCALE_NS, LOCALE_DICTS, wrapTranslate })
			},
			"src/client/main.js": function (__exports) {
/**
 * Browser plugin entry (the bundle's module exports).
 *
 * Wiring, in order:
 *   1. register the `turnPerformanceMeter` locale namespace (en + zh);
 *   2. create the presentation controller over `ctx.sessions`;
 *   3. dispose both on fiber teardown (HMR-safe);
 *   4. inject an independent `turn-performance-meter` entry into
 *      `conversation.input.dock` — the verified full-width seat **above the
 *      composer card**, which is where the reference layout puts the meter.
 *
 * ## Why the seat moved (Phase 5B)
 *
 * Phase 3 registered in `conversation.composer.dock`, documented by DSH as
 * "Ambient entries below the composer card". That seat is *below* the composer
 * and already holds the native chat statistics (`client-ui-chat` `StatsPills`,
 * id `stats`), so the meter rendered between the input box and the numbers it
 * was competing with for width and attention.
 *
 * DSH exposes the correct region as `conversation.input.dock`
 * (`kind: 'list'`, `scope: 'session'`, `owner: InputZone`, "Full-width entries
 * above the composer card"), rendered by the owner immediately before
 * `inputBar`:
 *
 *     zone !== undefined && renderSlot("conversation.input.dock", zone),
 *     inputBar
 *
 * Native `stats` is untouched: it keeps its own seat and its own id.
 *
 * ## Order (changed in Phase 7)
 *
 * `order` is ascending within the list, and the shipped occupants of this seat are
 * `todo` (0), `goal` (10) and `queue` (20). Phase 5 placed this entry at `order: 30`
 * — last, directly above the composer — on the reasoning that adjacency to the
 * composer is what the reference layout shows.
 *
 * A screenshot of the real interface showed why that is wrong. Those three occupants
 * are **full-width cards** and the meter is a content-sized pill, so rendering the
 * narrow pill last put it between a wide card and the composer and left a band of
 * empty width on both sides of it: the stack read as card, then an orphan, then the
 * input. The reference ordering is `telemetry -> task state -> input`, and the
 * measured evidence is in `docs/IMPLEMENTATION_LOG.md` (Phase 7 dock placement).
 *
 * `SLOT_ORDER` is therefore **-10**, which is before every currently shipped occupant
 * and yields:
 *
 *     turn-performance-meter   -10
 *     todo                       0
 *     goal                      10
 *     queue                     20
 *     composer
 *
 * This is a `list` slot with ascending order and nothing else: DSH defines no
 * `alwaysFirst`, `pinTop` or equivalent, so the honest claim is "first among all
 * currently shipped `conversation.input.dock` occupants", **not** "above every
 * third-party entry". Any plugin may register a lower finite order. A finite value is
 * used deliberately; `Number.NEGATIVE_INFINITY` would be an unsupported claim on the
 * ordering contract and would also break any future DSH sorting that assumes
 * comparability.
 *
 * Native `stats` is untouched: it keeps its own seat (`conversation.composer.dock`,
 * below the composer) and its own id.
 *
 * Service keys (`slots`, `sessions`, `locale`) are the Cordis service names;
 * the package names they arrive from are declared in `package.json`
 * `dsh.client.inject`. React itself comes from the browser module table seed —
 * never from a runtime dependency.
 */

const { createController } = __req("src/client/live/controller.js")
const { makeMeterSlot } = __req("src/client/live/MeterRoot.js")
const { meterDiagnostics } = __req("src/client/live/LiveMeter.js")
const { LOCALE_DICTS, LOCALE_NS, wrapTranslate } = __req("src/client/live/locale.js")
const { DEFAULT_PRESENTATION_REFRESH_MS, REFRESH_OVERRIDE_STORAGE_KEY, resolvePresentationRefreshMs } = __req("src/client/live/cadence.js")

const inject = ['slots', 'sessions', 'locale']

/** The seat this plugin occupies, and the id it must never reuse. */
const SLOT_NAME = 'conversation.input.dock'
const SLOT_ID = 'turn-performance-meter'
/**
 * First among the shipped occupants (`todo` 0, `goal` 10, `queue` 20), so the stack
 * reads telemetry, then task state, then the composer.
 *
 * The value is finite on purpose. No DSH slot contract defines a top pin, so the
 * claim is bounded: a third-party entry at a lower order would precede this one.
 */
const SLOT_ORDER = -10

/**
 * Diagnostic switch (default OFF). When the browser local-storage key
 * `dsh-turn-performance-meter.debug` is `1`, the controller logs lifecycle
 * events (session attach, turn open/close, attempt/tool boundaries, quality
 * downgrades, rebaselines) through `console.debug` and publishes a read-only
 * diagnostics handle on `window.__dshTurnPerformanceMeter`. Per-delta logging
 * never happens, in either mode.
 */
function debugEnabled() {
  try {
    return typeof window !== 'undefined'
      && window.localStorage?.getItem('dsh-turn-performance-meter.debug') === '1'
  } catch {
    return false
  }
}

/**
 * Debug-only cadence override, read once at apply time.
 *
 * This exists so the Phase 5A A/B could run the *production* code path at
 * 200 ms, 50 ms and 10 ms without three rebuilds. It is unreachable unless the
 * diagnostic switch is already on, so the shipped cadence has exactly one
 * source (`./live/cadence.js`) and no persisted value can change it.
 */
function cadenceOverride() {
  try {
    return typeof window === 'undefined'
      ? null
      : window.localStorage?.getItem(REFRESH_OVERRIDE_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function apply(ctx) {
  const debug = debugEnabled()

  let disposeLocale = () => {}
  try {
    const result = ctx.locale?.register?.(LOCALE_NS, LOCALE_DICTS)
    if (typeof result === 'function') disposeLocale = result
  } catch { /* a missing locale service must not block the meter */ }

  let rawTranslate = null
  try {
    rawTranslate = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : null
  } catch { /* fall back to the built-in dictionary */ }
  const t = wrapTranslate(rawTranslate)

  const refreshMs = debug
    ? resolvePresentationRefreshMs(cadenceOverride())
    : DEFAULT_PRESENTATION_REFRESH_MS

  const controller = createController({ sessions: ctx.sessions, debug, refreshMs })

  /**
   * Cordis effect semantics: `ctx.effect(fn)` runs `fn` as setup and calls the
   * **returned** function at fiber teardown — the same shape as the shipped
   * `ctx.effect(() => ctx.webServer.register(...))` call sites. Registering the
   * disposal body directly would dispose the controller at startup, which is
   * exactly the failure this comment exists to prevent.
   *
   * The whole debug handle is built **inside** the setup callback, including the
   * `meter()` accessor. An earlier revision attached `meter` right after
   * `ctx.effect(...)` returned; that silently produced a handle without its
   * accessor in the browser, because the setup callback had not run yet and the
   * assignment threw into its own `catch`. One construction site, one lifetime.
   */
  ctx.effect(() => {
    if (debug) {
      try {
        window.__dshTurnPerformanceMeter = {
          controller,
          diagnostics: (sessionId) => controller.diagnostics(sessionId),
          attachedSessions: () => controller.attachedSessions(),
          meter: () => {
            const diag = meterDiagnostics()
            const scheduler = diag.currentScheduler
            return {
              /** Selected/overridden cadence actually handed to the scheduler. */
              refreshMs: controller.refreshMs,
              productionRefreshMs: DEFAULT_PRESENTATION_REFRESH_MS,
              schedulerCreated: diag.schedulerCreated,
              notifyCalls: diag.notifyCalls,
              renderCalls: diag.renderCalls,
              refreshCalls: diag.refreshCalls,
              scheduler: scheduler === null ? null : {
                ticking: scheduler.ticking,
                disposed: scheduler.disposed,
                timerCount: scheduler.timerCount,
                intervalMs: scheduler.intervalMs,
              },
            }
          },
        }
      } catch { /* diagnostics must never break telemetry */ }
    }
    return () => {
      controller.dispose()
      if (debug) {
        try { delete window.__dshTurnPerformanceMeter } catch { /* ignore */ }
      }
      try { disposeLocale() } catch { /* best effort */ }
    }
  })

  ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
    name: SLOT_NAME,
    id: SLOT_ID,
    order: SLOT_ORDER,
  }, makeMeterSlot({ controller, t, debug })))
}

;Object.assign(__exports, { inject, SLOT_NAME, SLOT_ID, SLOT_ORDER, apply })
			}
		}
		return __req("src/client/main.js")
	},
})
