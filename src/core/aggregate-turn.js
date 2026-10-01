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

import { MetricQuality, rateQuality, weakestQuality } from './metric-quality.js'
import { QualityLevel, qualityAxes, QUALITY_AXIS, clampToAxis } from './quality-model.js'
import { summarizeToolCalls } from './tool-timing.js'
import { attributePhaseDurations, PHASE } from './phase-duration.js'
import { calibrateAttemptSamples } from './token-allocation.js'
import { TemporalAllocationMode, PhaseEvidenceIssue } from './phase-evidence.js'

/** Mask a usage object into the fields this project reads, or `null` when unusable. */
export function normalizeUsage(usage) {
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
export function isContributingAttempt(attempt) {
  return Array.isArray(attempt?.samples) && attempt.samples.length > 0
}

/**
 * Reduce one normalized attempt to its measured facts.
 *
 * @param {object} attempt `{attemptId, turn, step, samples, usage, status}`
 */
export function reduceAttempt(attempt) {
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
export function aggregateTurn(input = {}) {
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

export { PHASE }
