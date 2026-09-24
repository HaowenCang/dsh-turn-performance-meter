/**
 * Completed-turn TPS curve: a trailing one-second rolling series sampled on the
 * compressed active clock, plus the peak of the rendered series.
 *
 * The window and cadence are deliberately the same conceptual window the live
 * meter uses (docs/METRICS_SPEC.md §8.2), so a point read off the curve at time
 * `t` means the same thing as the live pill did at that instant.
 *
 * Curve points are `estimated` before provider usage arrives and `calibrated`
 * afterwards; they are never `exact`. `peakTps` is the peak of the *rendered*
 * series and must be labelled as such, not as a provider-certified maximum
 * (docs/METRICS_SPEC.md §9).
 */

export const DEFAULT_WINDOW_MS = 1000
export const DEFAULT_SAMPLE_EVERY_MS = 250

/** Largest rendered series the SVG layer is allowed to receive. */
export const DEFAULT_MAX_POINTS = 512

function assertPositive(value, label) {
  if (!(Number.isFinite(value) && value > 0)) throw new TypeError(`${label} must be a finite number > 0`)
}

/**
 * Build one phase's rolling TPS series on the compressed clock.
 *
 * @param {readonly object[]} samples compressed samples carrying `activeTimeMs`
 * @param {{phase?:string|null, windowMs?:number, sampleEveryMs?:number, durationMs?:number}} [options]
 * @returns {{timeMs:number, tps:number}[]}
 */
export function rollingTpsSeries(samples, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const sampleEveryMs = options.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS
  assertPositive(windowMs, 'windowMs')
  assertPositive(sampleEveryMs, 'sampleEveryMs')

  const phase = options.phase ?? null
  const filtered = (Array.isArray(samples) ? samples : [])
    .filter(s => s && (phase === null || s.phase === phase) && Number.isFinite(s.activeTimeMs))
    .slice()
    .sort((a, b) => a.activeTimeMs - b.activeTimeMs)

  const end = Number.isFinite(options.durationMs)
    ? Math.max(0, options.durationMs)
    : Math.max(0, filtered.length > 0 ? filtered[filtered.length - 1].activeTimeMs : 0)

  const result = []
  let left = 0
  let right = 0
  let total = 0
  const steps = Math.floor(end / sampleEveryMs + 1e-9)
  for (let step = 0; step <= steps; step += 1) {
    const t = step * sampleEveryMs
    while (right < filtered.length && filtered[right].activeTimeMs <= t) {
      total += filtered[right].tokens ?? filtered[right].weight ?? 0
      right += 1
    }
    const lowerExclusive = t - windowMs
    while (left < right && filtered[left].activeTimeMs <= lowerExclusive) {
      total -= filtered[left].tokens ?? filtered[left].weight ?? 0
      left += 1
    }
    result.push({ timeMs: t, tps: Math.max(0, total) * 1000 / windowMs })
  }
  return result
}

/** Peak of the rendered series across any number of series. */
export function peakTps(...seriesList) {
  let peak = 0
  for (const series of seriesList) {
    if (!Array.isArray(series)) continue
    for (const point of series) {
      const value = point?.tps
      if (Number.isFinite(value) && value > peak) peak = value
    }
  }
  return peak
}

/**
 * Reduce a series to at most `maxPoints` while preserving every local extremum
 * and both endpoints.
 *
 * Rendering density must be independent of collection density so a long turn
 * cannot produce an unbounded SVG path. Extrema are kept because the curve's
 * purpose is diagnosing throughput stability: a naive stride that stepped over
 * the single spike or the single stall would destroy the signal.
 *
 * @param {readonly {timeMs:number, tps:number}[]} series
 * @param {number} [maxPoints]
 */
export function downsampleSeries(series, maxPoints = DEFAULT_MAX_POINTS) {
  const points = Array.isArray(series) ? series : []
  if (!(Number.isFinite(maxPoints) && maxPoints >= 2) || points.length <= maxPoints) return points.slice()

  const keep = new Set([0, points.length - 1])
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1].tps
    const next = points[i + 1].tps
    const here = points[i].tps
    if ((here > prev && here >= next) || (here < prev && here <= next)) keep.add(i)
  }

  const remaining = maxPoints - keep.size
  if (remaining > 0) {
    const stride = (points.length - 1) / (remaining + 1)
    for (let k = 1; k <= remaining; k += 1) keep.add(Math.round(k * stride))
  }

  const ordered = [...keep].filter(i => i >= 0 && i < points.length).sort((a, b) => a - b)
  if (ordered.length <= maxPoints) return ordered.map(i => points[i])

  // Extremum-preserving set already exceeds the budget: thin it uniformly,
  // always keeping the first and last point.
  const thinned = []
  const stride = (ordered.length - 1) / (maxPoints - 1)
  for (let k = 0; k < maxPoints; k += 1) thinned.push(points[ordered[Math.round(k * stride)]])
  return thinned
}
