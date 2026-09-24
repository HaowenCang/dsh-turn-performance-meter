/**
 * Metric quality is ordered from strongest to weakest evidence. It exists so
 * that no display path can pretend a live estimate is a provider-exact number
 * (docs/METRICS_SPEC.md §11).
 */
export const MetricQuality = Object.freeze({
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
export function isMetricQuality(value) {
  return RANK.has(value)
}

/** Return the weakest quality among the supplied values. */
export function weakestQuality(...values) {
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
export function rateQuality({ measuredRatio = 1, tokensExact = true, phaseSplitExact = true } = {}) {
  if (!(measuredRatio > 0)) return MetricQuality.UNAVAILABLE
  if (measuredRatio < 1) return MetricQuality.ESTIMATED
  if (!phaseSplitExact) return MetricQuality.CALIBRATED
  return tokensExact ? MetricQuality.EXACT : MetricQuality.ESTIMATED
}
