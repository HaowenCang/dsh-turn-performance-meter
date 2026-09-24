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

import { MetricQuality } from './metric-quality.js'

/**
 * Ordered weakest-to-strongest. `partial` and `reconstructed` are additions to
 * the four frozen levels, not replacements: `partial` distinguishes "some
 * contributors were authoritative and some were not" from a wholesale estimate,
 * and `reconstructed` distinguishes "shape weight with an exact anchor and exact
 * timing" from "rough estimate".
 */
export const QualityLevel = Object.freeze({
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
export const QUALITY_CEILING = Object.freeze({
  tokenTotal: QualityLevel.EXACT,
  phaseSplit: QualityLevel.EXACT,
  temporalShape: QualityLevel.RECONSTRUCTED,
})

export const QUALITY_AXIS = Object.freeze({
  TOKEN_TOTAL: 'tokenTotal',
  PHASE_SPLIT: 'phaseSplit',
  TEMPORAL_SHAPE: 'temporalShape',
})

/** Whether a value is one of the six declared levels. */
export function isQualityLevel(value) {
  return Object.hasOwn(RANK, value)
}

/** The weaker of two levels. */
export function weakestLevel(a, b) {
  if (!isQualityLevel(a)) return QualityLevel.UNAVAILABLE
  if (!isQualityLevel(b)) return QualityLevel.UNAVAILABLE
  return RANK[a] <= RANK[b] ? a : b
}

/** Clamp a level to its axis ceiling. */
export function clampToAxis(axis, level) {
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
export function tokenTotalQuality({
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
 * A split is only `exact` when every contributing attempt that carries the
 * total also carries an authoritative `reasoningTokens`. When the totals are
 * exact but the split is not, the honest answer is `estimated`: the shape prior
 * still divides the anchored total, and that division was never measured.
 *
 * `reasoningStreamConflict` is the consistency guard: a provider that reports
 * `reasoningTokens === 0` while the stream carries non-empty reasoning deltas
 * contradicts itself, and a split derived from that counter can never be
 * `exact` however many attempts reported it.
 */
export function phaseSplitQuality({
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
export function temporalShapeQuality({
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
export function qualityAxes(input = {}) {
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
    notes.push('provider reported reasoningTokens=0 while the stream carries reasoning deltas; the reasoning/output split is downgraded')
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
export function requiresApproximateMarker(level) {
  return level !== QualityLevel.EXACT && level !== QualityLevel.UNAVAILABLE
}

export { MetricQuality }
