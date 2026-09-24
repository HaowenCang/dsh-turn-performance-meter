/**
 * Curve view model — the single seam between the settled snapshot and the SVG.
 *
 * The data flow is fixed by the architecture, and this module is the only place
 * it may bend:
 *
 *     settled snapshot (already decoded, aggregated, calibrated, compressed,
 *                       windowed and downsampled)
 *         -> curveViewModel(settled)          <- this module
 *         -> SVG element tree                 (`curve-tree.js`)
 *
 * The React layer therefore never decodes an event, aggregates a turn, compresses
 * an attempt axis, rolls a TPS window or downsamples a raw delta — it renders
 * numbers and path strings that were decided here. That matters because those
 * five operations are the statistics; a component that recomputed any of them
 * would be a second, silently divergent definition of TPS.
 *
 * Geometry is expressed in a fixed logical viewBox (`0 0 100 48`) that the SVG
 * stretches to its container with `preserveAspectRatio="none"` and
 * `vector-effect="non-scaling-stroke"`. A chart whose y-scale depended on the
 * container width would make the same turn look like a different turn at a
 * different window size; a fixed viewBox does not.
 */

import { DASH, formatTps, formatTokens } from '../format.js'

/** Logical drawing box. Height is chosen so the curve panel matches the summary. */
export const CURVE_VIEW_WIDTH = 100
export const CURVE_PLOT_HEIGHT = 48

/** Vertical inset reserved so a peak touching the axis maximum is not clipped. */
const PLOT_INSET = 3

/** Axis labels are read as magnitudes, so they never carry the `≈` of a rate. */
function formatAxis(value) {
  if (!Number.isFinite(value) || value <= 0) return DASH
  return formatTokens(value)
}

/**
 * Smallest member of the 1/2/2.5/5 x 10^k ladder that is `>= value`.
 *
 * A raw maximum as the axis ceiling (e.g. `673`) would place the peak exactly on
 * the top gridline with no headroom and produce unreadable axis labels; a ladder
 * ceiling keeps the peak visible and the label round. Deterministic by
 * construction, which is what lets the geometry be snapshot-tested.
 */
export function niceCeiling(value) {
  if (!(Number.isFinite(value) && value > 0)) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  for (const step of [1, 2, 2.5, 5]) {
    if (value <= step * base * (1 + 1e-9)) return step * base
  }
  return 10 * base
}

/** x coordinate of one compressed instant, or `null` when it is not drawable. */
function xOf(timeMs, durationMs) {
  if (!Number.isFinite(timeMs)) return null
  if (!(durationMs > 0)) return 0
  return Math.min(CURVE_VIEW_WIDTH, Math.max(0, (timeMs / durationMs) * CURVE_VIEW_WIDTH))
}

/** y coordinate of one rate against the axis ceiling. */
function yOf(tps, axisMax) {
  const usable = CURVE_PLOT_HEIGHT - PLOT_INSET * 2
  const ratio = axisMax > 0 ? Math.min(1, Math.max(0, tps / axisMax)) : 0
  return CURVE_PLOT_HEIGHT - PLOT_INSET - ratio * usable
}

/** Coordinates and a path string for one series' drawable stretch. */
function buildSeries(points, span, durationMs, axisMax) {
  /**
   * Three states, and they mean different things:
   *
   *   - `undefined` — the snapshot carries no span metadata at all (an older
   *     curve object). Nothing is filtered;
   *   - `null` — the phase has no evidence in this turn. Nothing is drawn;
   *   - an object — only that interval is drawn.
   *
   * Collapsing the first two would make a legacy snapshot lose both curves.
   */
  if (span === null) return { present: false, points: 0, path: null, coordinates: [], peak: null }

  const drawn = []
  for (const point of Array.isArray(points) ? points : []) {
    if (!Number.isFinite(point?.timeMs) || !Number.isFinite(point?.tps)) continue
    /**
     * Only the stretch where this phase has evidence is drawn. Outside it the
     * series reads zero because the phase is absent, and drawing that as a flat
     * zero line would present "reasoning has ended" as "reasoning throughput
     * collapsed" (see `phaseSpans` in `src/core/curve.js`).
     */
    if (span !== undefined && (point.timeMs < span.startMs || point.timeMs > span.endMs)) continue
    const x = xOf(point.timeMs, durationMs)
    if (x === null) continue
    drawn.push({ x, y: yOf(point.tps, axisMax), tps: point.tps, timeMs: point.timeMs })
  }

  if (drawn.length < 2) {
    return { present: false, points: drawn.length, path: null, coordinates: drawn, peak: null }
  }

  const path = drawn
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`)
    .join(' ')

  let peak = drawn[0]
  for (const point of drawn) if (point.tps > peak.tps) peak = point
  return { present: true, points: drawn.length, path, coordinates: drawn, peak }
}

/** Two decimals is well below one device pixel in a `100`-wide stretched viewBox. */
function round(value) {
  return Math.round(value * 100) / 100
}

/**
 * Build the curve panel's view model.
 *
 * @param {object|null|undefined} settled the settled turn snapshot
 * @returns {object|null} `null` when the turn carries no curve at all, which is
 *   what makes the completed card non-interactive for that turn
 */
export function curveViewModel(settled) {
  const curve = settled?.curve
  if (!curve || typeof curve !== 'object') return null

  const durationMs = Number.isFinite(curve.durationMs) ? Math.max(0, curve.durationMs) : 0
  /**
   * A snapshot that predates `phaseSpans` carries no availability metadata, so
   * `undefined` means "draw what is there" rather than "this phase is absent".
   */
  const hasSpans = curve.phaseSpans !== null && typeof curve.phaseSpans === 'object'
  const spanOf = phase => (hasSpans ? (curve.phaseSpans[phase] ?? null) : undefined)
  /**
   * The axis is scaled by the **full-series** peak, never by the drawn points:
   * downsampling is a drawing budget and may not rescale the chart either.
   * `downsampleSeries` guarantees the peak-bearing point survives, so the drawn
   * curve reaches the top of the axis rather than falling short of it.
   */
  const peakValue = Number.isFinite(curve.peakTps) ? Math.max(0, curve.peakTps) : 0
  const axisMax = niceCeiling(peakValue)

  const reasoning = buildSeries(curve.reasoning, spanOf('reasoning'), durationMs, axisMax)
  const output = buildSeries(curve.output, spanOf('output'), durationMs, axisMax)

  /** The series that actually holds the global peak, so the marker sits on it. */
  const leader = (output.peak?.tps ?? -1) > (reasoning.peak?.tps ?? -1) ? 'output' : 'reasoning'
  const leaderSeries = leader === 'output' ? output : reasoning

  return {
    kind: 'curve',
    durationMs,
    width: CURVE_VIEW_WIDTH,
    height: CURVE_PLOT_HEIGHT,
    axis: { max: axisMax, display: formatAxis(axisMax) },
    /**
     * Both series are always listed, in a fixed order, so the legend never
     * changes shape between turns. `present: false` means the phase produced
     * nothing to draw — an honest "no evidence", not a zero line.
     */
    series: [
      { key: 'reasoning', tone: 'neutral', ...reasoning },
      { key: 'output', tone: 'accent', ...output },
    ],
    /**
     * The peak is a sample of a shape-estimated series, so it is `≈` even when
     * the generated total is exact — a curve point is not a provider-certified
     * maximum (`docs/METRICS_SPEC.md` §9). `x`/`y` place the marker on the
     * leader series; they are `null` when nothing is drawable.
     */
    peak: {
      value: peakValue,
      display: peakValue > 0 ? `≈${formatTps(peakValue)}` : DASH,
      unit: 'tokens/s',
      approximate: true,
      leader,
      x: leaderSeries.peak === null ? null : round(leaderSeries.peak.x),
      y: leaderSeries.peak === null ? null : round(leaderSeries.peak.y),
    },
    /** Drawn vertex count, so a test can assert the SVG input is bounded. */
    drawnPoints: reasoning.points + output.points,
  }
}
