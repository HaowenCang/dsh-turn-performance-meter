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

import { MetricQuality } from './metric-quality.js'
import { isContributingAttempt } from './aggregate-turn.js'

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
export const CalibrationCoverage = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  NONE: 'none',
  FALLBACK: 'fallback',
})

/** Fields on `record.attempts` that are shared with every calibration sample. */
function withCalibratedSamples(attempt, samples, anchored) {
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
export function curveSource(attempts, breakdown) {
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
