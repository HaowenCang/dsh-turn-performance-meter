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

export function formatSeconds(ms, digits = 1) {
  if (!Number.isFinite(ms)) return DASH
  return `${(ms / 1000).toFixed(digits)}s`
}

/** Running TTFT counter form: `2.80 s`. */
export function formatCountdown(ms, digits = 2) {
  if (!Number.isFinite(ms)) return DASH
  return `${(ms / 1000).toFixed(digits)} s`
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
export function formatTps(value) {
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

export function formatTokens(value) {
  if (!Number.isFinite(value)) return DASH
  const rounded = Math.round(value)
  // `-0` is a display artefact of rounding, not a magnitude: it must not reach
  // the DOM as `-0`.
  return (rounded === 0 ? 0 : rounded).toLocaleString('en-US')
}

/** Compact elapsed form used on secondary lines: `133.6s`, `2m42s`. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`
}

export { DASH }
