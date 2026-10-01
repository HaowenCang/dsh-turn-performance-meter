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
export const MIN_RATE_SAMPLES = 3

/** Episode elapsed time, in milliseconds, below which no rate is publishable. */
export const MIN_RATE_ELAPSED_MS = 100

/**
 * Why a vertex or a live snapshot carries no rate.
 *
 * `null` is reserved for "publishable"; every other value names a fact about the
 * evidence rather than a judgement about the number.
 */
export const RateUnavailable = Object.freeze({
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
export function rateAvailability(state = {}) {
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
export function rateIsPublishable(state) {
  return rateAvailability(state).publishable
}
