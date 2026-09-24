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
 * TPS display. Three-significant-figure behaviour without exponent notation at
 * the low end, where token rates are most often read.
 */
export function formatTps(value) {
  if (!Number.isFinite(value)) return DASH
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function formatTokens(value) {
  if (!Number.isFinite(value)) return DASH
  return Math.round(value).toLocaleString('en-US')
}

/** Compact elapsed form used on secondary lines: `133.6s`, `2m42s`. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`
}

export { DASH }
