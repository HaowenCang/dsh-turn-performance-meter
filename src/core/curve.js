/**
 * Completed-turn TPS curve: a trailing one-second rolling series sampled on the
 * compressed active clock, plus the peak of the full series.
 *
 * The window and cadence are deliberately the same conceptual window the live
 * meter uses (docs/METRICS_SPEC.md §8.2), so a point read off the curve at time
 * `t` means the same thing as the live pill did at that instant.
 *
 * Two different milliseconds live in this module and must not be conflated:
 *
 *   - `DEFAULT_WINDOW_MS` (1000 ms) is the interval a rate is *measured* over.
 *     It is a definition, not a refresh rate;
 *   - `DEFAULT_SAMPLE_EVERY_MS` (250 ms) is how often that measurement is
 *     *recorded* for the completed chart. It is independent of the live
 *     presentation cadence in `src/client/live/cadence.js`: streaming a screen
 *     at 20 Hz does not make a one-second window any shorter, and a finer curve
 *     grid is a separate, separately-argued decision.
 *
 * Curve points are `estimated` before provider usage arrives and `calibrated`
 * afterwards; they are never `exact`. `peakTps` is the peak of the **full**
 * rolling series — computed before any downsampling — and it must still be
 * labelled as an estimate, because a series sample is not a provider-certified
 * maximum (docs/METRICS_SPEC.md §9).
 */

export const DEFAULT_WINDOW_MS = 1000
export const DEFAULT_SAMPLE_EVERY_MS = 250

/** Largest rendered series the SVG layer is allowed to receive. */
export const DEFAULT_MAX_POINTS = 512

/**
 * Smallest budget that can hold the guaranteed anchors: the first point, the
 * last point and the global maximum are three distinct indices in the worst case.
 * A smaller budget is unsatisfiable rather than merely tight.
 */
export const MIN_MAX_POINTS = 3

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

/**
 * Peak across any number of **full** series.
 *
 * The name says `Tps` and not `RenderedTps` on purpose: this is a statistic over
 * the rolling series as computed, and it must be evaluated before
 * `downsampleSeries` runs. Taking the maximum of the *drawn* points instead
 * would make a chart setting — how many points the SVG is allowed — silently
 * change a number the card reports.
 */
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
 * Evidence interval of each phase on the compressed clock.
 *
 * A rolling series is defined for every sampled instant, but a phase that has
 * not started yet and a phase that has finished both read as zero. Those zeros
 * are arithmetically correct and visually misleading: a renderer that draws the
 * reasoning series across an output-only stretch is not showing "reasoning
 * throughput collapsed", it is showing "reasoning is over" — two different
 * facts, and only one of them is a throughput statement.
 *
 * The interval returned here is the region in which the series *means* something:
 *
 *   - it starts at the phase's first token-producing sample. Before that the
 *     phase has produced nothing to measure;
 *   - it ends one rolling window after the phase's last token-producing sample,
 *     because those tokens keep contributing to the rate for exactly that long
 *     and the decay is a real, readable part of the series.
 *
 * A phase with no samples has no span. Series values themselves are never
 * altered; this is availability metadata.
 *
 * @param {readonly {activeTimeMs?:number, phase?:string|null}[]} samples
 * @param {number} durationMs compressed duration the span is clamped to
 * @param {number} [windowMs] rolling window the tail is extended by
 * @returns {{reasoning: {startMs:number, endMs:number}|null, output: {startMs:number, endMs:number}|null}}
 */
export function phaseSpans(samples, durationMs, windowMs = DEFAULT_WINDOW_MS) {
  const horizon = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
  const tail = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0
  const bounds = new Map()
  for (const sample of Array.isArray(samples) ? samples : []) {
    const phase = sample?.phase
    const at = sample?.activeTimeMs
    if (typeof phase !== 'string' || !Number.isFinite(at)) continue
    const current = bounds.get(phase)
    if (current === undefined) bounds.set(phase, { firstMs: at, lastMs: at })
    else {
      if (at < current.firstMs) current.firstMs = at
      if (at > current.lastMs) current.lastMs = at
    }
  }

  const spanFor = (phase) => {
    const bound = bounds.get(phase)
    if (bound === undefined) return null
    return {
      startMs: Math.max(0, Math.min(bound.firstMs, horizon)),
      endMs: Math.max(0, Math.min(bound.lastMs + tail, horizon)),
    }
  }

  return { reasoning: spanFor('reasoning'), output: spanFor('output') }
}

/** Index of the first finite global maximum (or minimum) of a series. */
function extremeIndex(points, direction) {
  let best = -1
  let bestValue = 0
  for (let i = 0; i < points.length; i += 1) {
    const value = points[i]?.tps
    if (!Number.isFinite(value)) continue
    if (best === -1 || (direction > 0 ? value > bestValue : value < bestValue)) {
      best = i
      bestValue = value
    }
  }
  return best
}

/**
 * Reduce a series to at most `maxPoints` for rendering.
 *
 * Retention is a **priority list**, not one heuristic, because the budget can be
 * smaller than the number of interesting points and something has to give. In
 * order:
 *
 *   1. the two endpoints — the series must still start and end where it did;
 *   2. the global maximum — this is the point the card's `peak` refers to, and a
 *      rendering choice may never delete it;
 *   3. the global minimum — the trough a stall produces;
 *   4. the surviving local extrema, **ranked by prominence** when they do not
 *      all fit;
 *   5. uniform shape samples with whatever budget is left, so a long flat run
 *      still has vertices to be drawn with.
 *
 * The previous revision kept every local extremum and then, on budget overflow,
 * thinned that set by uniform stride — which is exactly the operation that can
 * step over the single global spike the chart exists to show. Ranking extrema by
 * prominence and reserving the anchors before anything else makes the peak and
 * the trough unconditional; `test/curve.test.js` carries the counterexample that
 * defeats the old stride.
 *
 * Determinism: ties in the global extreme resolve to the earliest index, and
 * ties in prominence resolve to the earliest index, so two runs over equal input
 * return equal output.
 *
 * @param {readonly {timeMs:number, tps:number}[]} series
 * @param {number} [maxPoints] budget; must be `>= MIN_MAX_POINTS`
 * @returns {{timeMs:number, tps:number}[]} at most `maxPoints` points, in
 *   non-decreasing `timeMs` order, drawn from the input objects themselves
 */
export function downsampleSeries(series, maxPoints = DEFAULT_MAX_POINTS) {
  const points = Array.isArray(series) ? series : []
  if (!(Number.isFinite(maxPoints) && maxPoints >= MIN_MAX_POINTS)) {
    /**
     * Refusing is the only honest answer: first, last and the global maximum
     * cannot all survive in fewer than three points, and silently breaking one
     * of the three guarantees would be a worse failure than a loud one.
     */
    throw new TypeError(`maxPoints must be a finite number >= ${MIN_MAX_POINTS}`)
  }
  if (points.length <= maxPoints) return points.slice()

  const lastIndex = points.length - 1
  /** 1-3. Mandatory anchors, in priority order; the Set de-duplicates them. */
  const keep = new Set()
  keep.add(0)
  keep.add(lastIndex)
  const peakIndex = extremeIndex(points, 1)
  if (peakIndex >= 0) keep.add(peakIndex)
  /**
   * The trough is the *recommended* fourth anchor rather than a guaranteed one:
   * a three-point budget must still be able to honour the three hard guarantees,
   * so the trough yields when there is no room for it and never the other way
   * round.
   */
  const troughIndex = extremeIndex(points, -1)
  if (troughIndex >= 0 && keep.size < maxPoints) keep.add(troughIndex)

  /** 4. Local extrema, each with the prominence that ranks it. */
  const extrema = []
  for (let i = 1; i < lastIndex; i += 1) {
    const prev = points[i - 1]?.tps
    const here = points[i]?.tps
    const next = points[i + 1]?.tps
    if (!Number.isFinite(prev) || !Number.isFinite(here) || !Number.isFinite(next)) continue
    if (!((here > prev && here >= next) || (here < prev && here <= next))) continue
    extrema.push({ index: i, prominence: Math.abs(here - (prev + next) / 2) })
  }
  extrema.sort((left, right) => (
    right.prominence - left.prominence || left.index - right.index
  ))
  for (const extremum of extrema) {
    if (keep.size >= maxPoints) break
    keep.add(extremum.index)
  }

  /** 5. Whatever budget remains goes to evenly spaced shape samples. */
  const remaining = maxPoints - keep.size
  if (remaining > 0) {
    const stride = lastIndex / (remaining + 1)
    for (let k = 1; k <= remaining; k += 1) keep.add(Math.round(k * stride))
  }

  /**
   * Ascending index emission, then an explicit `timeMs` ordering: the drawn path
   * requires non-decreasing x, and guaranteeing it here means a caller cannot
   * produce a self-crossing polyline by handing in an out-of-order series. The
   * index tie-break keeps the sort stable, so equal timestamps keep input order.
   */
  const ordered = [...keep]
    .filter(index => index >= 0 && index < points.length)
    .sort((a, b) => a - b)
  const selected = ordered.map(index => points[index])
  selected.sort((left, right) => (
    (Number.isFinite(left?.timeMs) ? left.timeMs : 0) - (Number.isFinite(right?.timeMs) ? right.timeMs : 0)
  ))
  return selected
}
