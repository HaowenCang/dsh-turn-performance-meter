/**
 * Curve view model — the single seam between the settled snapshot and the SVG.
 *
 * The data flow is fixed by the architecture, and this module is the only place
 * it may bend:
 *
 *     settled snapshot (already decoded, aggregated, calibrated, compressed,
 *                       windowed, run-split and downsampled)
 *         -> curveViewModel(settled)          <- this module
 *         -> SVG element tree                 (`curve-tree.js`)
 *
 * The React layer therefore never decodes an event, aggregates a turn, compresses
 * an attempt axis, rolls a TPS window, splits a phase into episodes or downsamples
 * a raw delta — it renders numbers and path strings that were decided here. That
 * matters because those six operations are the statistics; a component that
 * recomputed any of them would be a second, silently divergent definition of TPS.
 *
 * **One series, several paths.** A phase may be present in more than one
 * *episode*: `Reasoning A -> Output A -> Tool -> Reasoning B` puts two reasoning
 * runs on one curve, and `source.curve.series[].runs` carries them separately. This
 * module turns each run into its own `M...L...` path and never joins two runs,
 * because the join is a fabricated straight line through a stretch where the phase
 * produced nothing. The reader sees a gap, which is what happened.
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

/** Two decimals is well below one device pixel in a `100`-wide stretched viewBox. */
function round(value) {
  return Math.round(value * 100) / 100
}

/**
 * Turn one run's vertices into coordinates and a single-subpath `d` string.
 *
 * A run shorter than two vertices is not drawable **as a line**: one point is a
 * measurement, not a segment. It is reported as `present: false` with its
 * coordinates intact, and — since Phase 7 — with `marker` set, so the renderer can
 * place a point where the measurement actually is.
 *
 * ## Why a marker, and why not a second vertex
 *
 * A run can legitimately hold one vertex: an attempt that produced a single delta has
 * zero width, and an episode whose phase falls silent immediately after one delta has
 * a tail grid with no whole step left inside its bound. That measurement can be the
 * turn's peak, which meant the card printed a peak the chart could not locate —
 * `test/completed-tree.test.js` recorded it as a known mismatch and Phase 7 closed it.
 *
 * The tempting repair is to duplicate the vertex so a line exists. That would be a
 * fabrication: two vertices at one instant draw a segment the data does not contain,
 * and a two-point series would then satisfy `present`, inflating `drawnPoints`,
 * `drawnRuns` and the legend's presence claim. The marker adds no vertex, carries the
 * same tone as its series, is `aria-hidden`, and adds nothing to any statistic.
 */
function buildRun(run, durationMs, axisMax) {
  const coordinates = []
  for (const point of Array.isArray(run?.points) ? run.points : []) {
    if (!Number.isFinite(point?.timeMs) || !Number.isFinite(point?.tps)) continue
    const x = xOf(point.timeMs, durationMs)
    if (x === null) continue
    coordinates.push({
      x,
      y: yOf(point.tps, axisMax),
      tps: point.tps,
      timeMs: point.timeMs,
      attemptId: run.attemptId ?? null,
    })
  }

  if (coordinates.length < 2) {
    const single = coordinates.length === 1 ? coordinates[0] : null
    return {
      attemptId: run?.attemptId ?? null,
      startMs: run?.startMs ?? null,
      endMs: run?.endMs ?? null,
      present: false,
      path: null,
      coordinates,
      points: coordinates.length,
      peak: single,
      /**
       * A point the chart must draw even though it cannot draw a line to it. `null`
       * for an empty run, so a caller can distinguish "one measurement" from
       * "nothing measured" without inspecting `coordinates`.
       */
      marker: single,
      /**
       * Stated explicitly so the HTML layer does not have to infer it: exactly one
       * vertex, drawn as a marker. A longer run never carries this flag, and a
       * refused run (zero vertices) never does either.
       */
      singleton: single !== null,
    }
  }

  /**
   * One `M`, then `L` for every other vertex. This string is deliberately
   * self-contained: joining two runs' strings would produce
   * `M...L... M...L...` — which is two subpaths, so the break would still be
   * correct — but a renderer that instead concatenated their *coordinates* would
   * draw the bridging line this whole structure exists to forbid.
   */
  const path = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`)
    .join(' ')

  let peak = coordinates[0]
  for (const point of coordinates) if (point.tps > peak.tps) peak = point

  return {
    attemptId: run?.attemptId ?? null,
    startMs: run?.startMs ?? null,
    endMs: run?.endMs ?? null,
    present: true,
    path,
    coordinates,
    points: coordinates.length,
    peak,
    /** A drawable run is never a singleton: it has a real segment. */
    marker: null,
    singleton: false,
  }
}

/** One series entry: every run of one phase, each with its own path. */
function buildSeries(entry, durationMs, axisMax) {
  const runs = (Array.isArray(entry?.runs) ? entry.runs : []).map(run => buildRun(run, durationMs, axisMax))
  const drawable = runs.filter(run => run.present)
  /**
   * The peak spans every run, drawable or not. A run of one vertex cannot be drawn
   * as a line, but its measurement is real, and the turn peak is a statistic — a
   * rendering limitation may not lower a published number.
   */
  let peak = null
  for (const run of runs) {
    if (run.peak === null) continue
    if (peak === null || run.peak.tps > peak.tps) peak = run.peak
  }
  return {
    key: entry?.key ?? null,
    tone: entry?.tone ?? null,
    present: drawable.length > 0,
    runs,
    /**
     * One entry per run that holds exactly one vertex. These are drawn as point
     * markers, so a one-vertex run that carries the turn's peak has a position on
     * the chart instead of existing only as a printed number. Kept as its own list
     * rather than folded into `coordinates`, because a marker is not a vertex of a
     * path and must not be counted as one.
     */
    markers: runs.filter(run => run.singleton).map(run => run.marker),
    /** Concatenated vertices of every run, for a caller that wants one array. */
    coordinates: runs.flatMap(run => run.coordinates),
    /**
     * Path vertices only. A singleton run contributes **zero** here rather than one:
     * this count feeds `drawnPoints`, which is what bounds the SVG, and a marker is a
     * separate element with its own count.
     */
    points: runs.filter(run => run.present).reduce((sum, run) => sum + run.points, 0),
    /** The single strongest vertex across this phase's runs, or `null`. */
    peak,
    /**
     * A single path string covering every run, for a caller that cannot render a
     * list. Each run opens its own `M`, so the subpaths are still disjoint even
     * here: this is a convenience, not a licence to join them.
     */
    path: drawable.length === 0 ? null : drawable.map(run => run.path).join(' '),
  }
}

/**
 * Rebuild run structure from a pre-Phase-6 snapshot's flat `reasoning`/`output`
 * arrays.
 *
 * An older snapshot carries no runs, and a phase's evidence is bounded by the
 * intervals `phaseSpans` recorded. A snapshot older still carries neither, and
 * then the whole array is one run — the only honest reading of "no availability
 * metadata". This path exists so a stale snapshot degrades to the old drawing
 * rather than to an empty chart.
 */
function legacyRuns(curve, key) {
  const points = Array.isArray(curve?.[key]) ? curve[key] : []
  if (points.length === 0) return []
  const spans = curve?.phaseSpans
  const span = spans !== null && typeof spans === 'object' ? (spans[key] ?? null) : undefined
  if (span === null) return []
  const filtered = span === undefined
    ? points
    : points.filter(point => Number.isFinite(point?.timeMs) && point.timeMs >= span.startMs && point.timeMs <= span.endMs)
  if (filtered.length === 0) return []
  return [{
    attemptId: null,
    phase: key,
    startMs: filtered[0].timeMs,
    endMs: filtered[filtered.length - 1].timeMs,
    attemptTokens: null,
    points: filtered,
  }]
}

/** The run list of one series, from the modern structure or the legacy one. */
function runsOf(curve, key, legacy) {
  const entry = Array.isArray(curve?.series)
    ? curve.series.find(candidate => candidate?.key === key)
    : undefined
  if (entry !== undefined) return entry
  return { key, tone: key === 'output' ? 'accent' : 'neutral', runs: legacyRuns(curve, key) }
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
   * The axis is scaled by the **full-series** peak, never by the drawn points:
   * downsampling is a drawing budget and may not rescale the chart either.
   * `downsampleSeries` guarantees the peak-bearing point survives, so the drawn
   * curve reaches the top of the axis rather than falling short of it.
   */
  const peakValue = Number.isFinite(curve.peakTps) ? Math.max(0, curve.peakTps) : 0
  const axisMax = niceCeiling(peakValue)

  const reasoning = buildSeries(runsOf(curve, 'reasoning'), durationMs, axisMax)
  const output = buildSeries(runsOf(curve, 'output'), durationMs, axisMax)

  /**
   * The series holding the global peak, so the marker sits on it. A tie resolves to
   * `reasoning`, because the comparison is strict and `reasoning` is scanned first —
   * the same earliest-wins rule `buildSeries` applies inside a series, which keeps the
   * position stable between two runs over equal input.
   */
  const leader = (output.peak?.tps ?? -1) > (reasoning.peak?.tps ?? -1) ? 'output' : 'reasoning'
  const leaderSeries = leader === 'output' ? output : reasoning
  /**
   * The marker is placed only when the leading series' strongest **drawn** vertex is the
   * measurement the card prints.
   *
   * `peak.value` is the full-series maximum, measured before any budget is applied,
   * because a drawing limit may not move a reported statistic. The position, by contrast,
   * can only come from a vertex that survived onto the chart. Those two coincide whenever
   * the peak-bearing run is drawn — `allocateRunBudgets` seats it first, whatever its
   * length, and `downsampleSeries` keeps its maximum — but they come apart if it is not,
   * and the failure is silent and misleading: the card prints `≈1000` and the dot lands on
   * a 400 tokens/s vertex, one pixel apart, with nothing on screen to distinguish them.
   *
   * Placing nothing is the honest degradation: a missing dot is visibly missing, and it is
   * what `curve.renderBudget.peakRetained` reports in words. Placing a different
   * measurement is not.
   */
  const placedPeak = leaderSeries.peak !== null && Math.abs(leaderSeries.peak.tps - peakValue) < 1e-9
    ? leaderSeries.peak
    : null

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
     * Per-phase episode intervals, carried through for diagnostics and for tests
     * that assert no drawable path crosses an absent stretch.
     */
    phaseRuns: curve.phaseRuns ?? { reasoning: [], output: [] },
    /**
     * The peak is a sample of a shape-estimated series, so it is `≈` even when
     * the generated total is exact — a curve point is not a provider-certified
     * maximum (`docs/METRICS_SPEC.md` §9). `x`/`y` place the marker on the
     * measurement itself, and they are `null` when that measurement is not on the
     * chart — never a position borrowed from a weaker vertex.
     */
    peak: {
      value: peakValue,
      display: peakValue > 0 ? `≈${formatTps(peakValue)}` : DASH,
      unit: 'tokens/s',
      approximate: true,
      leader,
      x: placedPeak === null ? null : round(placedPeak.x),
      y: placedPeak === null ? null : round(placedPeak.y),
    },
    /**
     * Drawn **path** vertices, so a test can assert the SVG input is bounded. A run of one
     * vertex contributes zero: it is drawn as a point marker, not as a vertex of a line,
     * and counting it here would make this number mean two different things.
     */
    drawnPoints: reasoning.points + output.points,
    /** Rendered subpath count: one per drawable run, never one per series. */
    drawnRuns: reasoning.runs.filter(run => run.present).length
      + output.runs.filter(run => run.present).length,
    /**
     * Point markers for one-vertex runs, in a fixed series order.
     *
     * Each carries the tone of its own series, so a reasoning singleton and an output
     * singleton are distinguishable by the same channel the legend already uses. They
     * are markers, not data: the SVG is `aria-hidden` and so are they, and no count on
     * this object includes them — `renderElementPoints` below adds them explicitly.
     */
    markers: [
      ...reasoning.markers.map(marker => ({ ...marker, series: 'reasoning', tone: 'neutral' })),
      ...output.markers.map(marker => ({ ...marker, series: 'output', tone: 'accent' })),
    ].map(marker => ({ ...marker, x: round(marker.x), y: round(marker.y) })),
    /**
     * The quantity the chart-wide render budget bounds: line vertices **plus** singleton
     * markers, its own named sum.
     *
     * `drawnPoints` counts one half of what the plot emits and `markers.length` the other,
     * and naming the first `drawnPoints` invited a bound assertion that measured the chart
     * while leaving every marker outside it. The two remain separate because they are
     * different things — a vertex of a polyline and a standalone dot — but no caller has to
     * add them up by hand to check the bound.
     */
    renderElementPoints: reasoning.points + output.points + reasoning.markers.length + output.markers.length,
    /**
     * True when the only evidence a phase has is single-vertex runs. The renderer
     * needs it because `drawnRuns === 0` with `markers.length > 0` is a chart that has
     * something to show and no line to show it with — the case that must not render
     * the "no curve" placeholder.
     */
    markersOnly: reasoning.runs.every(run => !run.present) && output.runs.every(run => !run.present)
      && (reasoning.markers.length + output.markers.length) > 0,
  }
}
