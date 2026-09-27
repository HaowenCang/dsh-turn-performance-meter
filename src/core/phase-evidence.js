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
export const TemporalAllocationMode = Object.freeze({
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
export const PhaseEvidenceIssue = Object.freeze({
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
export function analyzePhaseEvidence(samples, outputTokens, reasoningTokens) {
  const list = Array.isArray(samples) ? samples : []
  const hasReasoningSamples = list.some(sample => sample?.phase === 'reasoning')
  const hasOutputSamples = list.some(sample => sample?.phase === 'output')
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
      list.filter(sample => sample?.phase === 'reasoning').length,
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
      list.filter(sample => sample?.phase === 'output').length,
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
