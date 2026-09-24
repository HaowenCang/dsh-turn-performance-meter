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
  const durations = attributePhaseDurations(samples)
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
     * Whether the stream carries at least one non-empty reasoning delta. This
     * is the stream-side evidence half of the `reasoningTokens = 0` consistency
     * guard: provider aggregate usage and stream phase evidence must agree
     * before a split may be called exact.
     */
    hasReasoningStream: samples.some(sample => sample.phase === 'reasoning'),
    reasoningMs: durations.reasoningMs,
    outputMs: durations.outputMs,
    spanMs: durations.spanMs,
    usage,
    /** Where the usage came from, so a recovered total stays distinguishable. */
    usageSource: attempt?.usageSource ?? (usage === null ? null : 'attempt'),
    /** Whether this attempt's per-delta allocation is anchored to a total. */
    totalAnchored: calibration.totalAnchored,
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
   * Consistency guard: provider aggregate usage versus stream phase evidence.
   * An attempt whose stream carries non-empty reasoning deltas while its usage
   * reports `reasoningTokens === 0` is an internal contradiction in the
   * evidence. The authoritative `outputTokens` total stays trusted (it is the
   * only total the provider reports), but the reasoning/output split derived
   * from the conflicting counter may never be called exact, and the conflict
   * must be reported rather than silently ignored.
   */
  const consistencyIssues = []
  for (const attempt of reduced) {
    if (attempt.usage === null || attempt.usage.reasoningTokens !== 0) continue
    if (!attempt.hasReasoningStream) continue
    consistencyIssues.push(
      `attempt ${attempt.attemptId ?? attempt.step ?? '?'}: provider reported reasoningTokens=0 `
      + 'but the stream carries non-empty reasoning deltas; the phase split is downgraded',
    )
  }
  const splitConflict = consistencyIssues.length > 0

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

  // Phase denominators: sums of measured generation time. Attempts whose phase
  // duration is not measurable (fewer than two generated deltas in that phase)
  // are excluded from the sum and counted, so the rate can be marked optimistic
  // rather than exact.
  const reasoningDurations = reduced.map(a => a.reasoningMs)
  const outputDurations = reduced.map(a => a.outputMs)
  const reasoningMs = reasoningDurations.reduce((sum, ms) => sum + (ms ?? 0), 0)
  const outputMs = outputDurations.reduce((sum, ms) => sum + (ms ?? 0), 0)
  const reasoningMeasured = reasoningDurations.filter(ms => ms !== null && ms > 0).length
  const outputMeasured = outputDurations.filter(ms => ms !== null && ms > 0).length

  // Per-attempt allocations summed across the turn. For an attempt with usage
  // these are calibrated values anchored to the authoritative total; for an
  // attempt without usage they are raw shape weights. Reported for diagnostics
  // only — neither figure is a measured token count, so they never become a
  // published TPS numerator.
  const shapeTokens = reduced.reduce(
    (sum, a) => ({
      reasoning: sum.reasoning + (a.reasoningTokens ?? a.shapeReasoning),
      output: sum.output + (a.outputTokens ?? a.shapeOutput),
    }),
    { reasoning: 0, output: 0 },
  )

  const reasoningTps = observedReasoningTokens !== null && observedReasoningTokens > 0 && reasoningMs > 0
    ? observedReasoningTokens * 1000 / reasoningMs
    : null
  const outputTps = observedNonReasoningTokens !== null && observedNonReasoningTokens > 0 && outputMs > 0
    ? observedNonReasoningTokens * 1000 / outputMs
    : null

  const reasoningTokensReported = reduced.some(a => a.usage !== null && a.usage.reasoningTokens !== null)
  const reasoningQuality = reasoningTps === null
    ? MetricQuality.UNAVAILABLE
    : rateQuality({
      measuredRatio: measuredRatio(reasoningMeasured, reduced.length),
      tokensExact: splitComplete,
      phaseSplitExact: splitComplete && !splitConflict,
    })
  const outputQuality = outputTps === null
    ? MetricQuality.UNAVAILABLE
    : rateQuality({
      measuredRatio: measuredRatio(outputMeasured, reduced.length),
      tokensExact: splitComplete,
      phaseSplitExact: splitComplete && !splitConflict,
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
    reasoningStreamConflict: splitConflict,
    hasReasoningDeltas: reduced.some(a => a.shapeReasoning > 0),
    hasOutputDeltas: reduced.some(a => a.shapeOutput > 0),
    durable: input.durable === true,
    timestampsComplete: input.timestampsComplete !== false,
    anchored: reduced.length > 0 && reduced.every(a => a.totalAnchored === true),
    sampleCount: reduced.reduce((sum, a) => sum + a.sampleCount, 0),
  })

  return {
    turn: input.turn ?? null,
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
    splitQuality: splitConflict
      ? MetricQuality.ESTIMATED
      : (splitComplete
        ? MetricQuality.EXACT
        : (withUsage.length > 0 ? MetricQuality.ESTIMATED : MetricQuality.UNAVAILABLE)),
    /**
     * Provider-aggregate versus stream-evidence contradictions detected while
     * aggregating. Empty array means the two evidence sources agreed.
     */
    consistencyIssues,

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
    /** Shape-weighted token sums; diagnostics only, never a published rate numerator. */
    shapeTokens,

    // Coverage / diagnostics.
    attemptCount: attempts.length,
    contributingAttemptCount: reduced.length,
    emptyAttemptCount,
    usageAttemptCount: withUsage.length,
    usageComplete,
    splitComplete,
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

export { PHASE }
