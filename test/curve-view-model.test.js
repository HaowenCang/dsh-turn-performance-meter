/**
 * The settled curve -> SVG seam.
 *
 * `curveViewModel` is the only place the chart's geometry is decided, so these
 * assertions are about numbers: the axis ceiling, which stretch of each series is
 * drawn, how many subpaths the SVG receives, where the peak marker lands, and that
 * nothing in the view model claims a provider-exact maximum. The element tree is
 * checked separately in `test/completed-interaction.test.js`.
 *
 * Phase 6 changed the input shape this module consumes: a series is now a list of
 * **runs**, one per attempt episode, each with its own path. A single path could
 * not represent `Reasoning A -> Output A -> Reasoning B` without drawing a line
 * through the stretch where reasoning was absent, so the multi-run shape is the
 * fix rather than a refactor.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CURVE_PLOT_HEIGHT,
  CURVE_VIEW_WIDTH,
  curveViewModel,
  niceCeiling,
} from '../src/client/completed/curve-view-model.js'
import { formatTps } from '../src/client/format.js'
import { DEFAULT_MAX_POINTS, downsampleSeries } from '../src/core/curve.js'

/** One run as `telemetry-store.js` publishes it. */
function run(attemptId, points) {
  return {
    attemptId,
    startMs: points[0].timeMs,
    endMs: points[points.length - 1].timeMs,
    points,
  }
}

/**
 * A settled snapshot in the Phase 6 shape: reasoning in the first half, output in
 * the second, one attempt each.
 */
function settledCurve(overrides = {}) {
  return {
    curve: {
      durationMs: 20_000,
      segments: [
        { attemptId: 'a', startMs: 0, endMs: 5000 },
        { attemptId: 'b', startMs: 5000, endMs: 20_000 },
      ],
      series: [
        {
          key: 'reasoning',
          tone: 'neutral',
          runs: [run('a', [
            { timeMs: 0, tps: 50 },
            { timeMs: 2500, tps: 400 },
            { timeMs: 5000, tps: 300 },
          ])],
        },
        {
          key: 'output',
          tone: 'accent',
          runs: [run('b', [
            { timeMs: 5000, tps: 0 },
            { timeMs: 10_000, tps: 700 },
            { timeMs: 20_000, tps: 120 },
          ])],
        },
      ],
      peakTps: 700,
      quality: 'estimated',
      sampleEveryMs: 250,
      windowMs: 1000,
      ...overrides,
    },
  }
}

test('a turn with no curve produces no view model, which is what keeps the card inert', () => {
  assert.equal(curveViewModel(null), null)
  assert.equal(curveViewModel(undefined), null)
  assert.equal(curveViewModel({}), null)
  assert.equal(curveViewModel({ curve: null }), null)
})

test('the axis is a round ceiling of the full-series peak, never of the drawn points', () => {
  assert.equal(niceCeiling(673), 1000)
  assert.equal(niceCeiling(700), 1000)
  assert.equal(niceCeiling(500), 500)
  assert.equal(niceCeiling(120), 200)
  assert.equal(niceCeiling(1), 1)
  assert.equal(niceCeiling(0), 1)
  assert.equal(niceCeiling(Number.NaN), 1)

  const view = curveViewModel(settledCurve())
  /**
   * The ceiling is derived from `peakTps` (700, a full-series statistic), not from
   * the largest drawn point. A renderer that scaled to the drawn points would let
   * downsampling silently rescale the chart.
   */
  assert.equal(view.axis.max, 1000)
  assert.equal(view.axis.max >= view.peak.value, true)
  assert.equal(curveViewModel(settledCurve({ peakTps: 900 })).axis.max, 1000)
})

test('one series carries one path per run, and the runs are not joined into a single line', () => {
  const view = curveViewModel(settledCurve())
  const reasoning = view.series.find(series => series.key === 'reasoning')
  const output = view.series.find(series => series.key === 'output')

  assert.equal(reasoning.present, true)
  assert.equal(output.present, true)
  assert.equal(reasoning.runs.length, 1)
  assert.equal(reasoning.runs[0].attemptId, 'a')
  assert.equal(reasoning.runs[0].path.startsWith('M'), true)
  assert.equal(reasoning.runs[0].path.split('M').length - 1, 1, 'exactly one subpath per run')
})

test('a phase present in two episodes yields two disjoint subpaths, never one bridging line', () => {
  /**
   * `Reasoning -> Output -> Reasoning` inside one attempt: the reasoning series has
   * two episodes and the output-only stretch between them must appear as a gap. A
   * single path would interpolate straight across it, presenting "reasoning had
   * stopped" as "reasoning throughput fell".
   */
  const view = curveViewModel(settledCurve({
    series: [
      {
        key: 'reasoning',
        tone: 'neutral',
        runs: [
          run('a', [{ timeMs: 0, tps: 200 }, { timeMs: 1000, tps: 200 }]),
          run('a', [{ timeMs: 10_000, tps: 300 }, { timeMs: 11_000, tps: 300 }]),
        ],
      },
      { key: 'output', tone: 'accent', runs: [run('a', [{ timeMs: 1000, tps: 0 }, { timeMs: 9000, tps: 500 }])] },
    ],
    phaseRuns: {
      reasoning: [
        { attemptId: 'a', startMs: 0, endMs: 2000 },
        { attemptId: 'a', startMs: 10_000, endMs: 12_000 },
      ],
      output: [{ attemptId: 'a', startMs: 1000, endMs: 10_000 }],
    },
  }))

  const reasoning = view.series.find(series => series.key === 'reasoning')
  assert.equal(reasoning.runs.length, 2, 'two episodes, two runs')
  assert.deepEqual(reasoning.runs.map(r => r.attemptId), ['a', 'a'])
  assert.equal(reasoning.runs.every(r => r.present), true)
  assert.equal(reasoning.runs.every(r => r.path !== null), true)

  /** The gap is real: no vertex of the first run reaches into the second's stretch. */
  const [first, second] = reasoning.runs
  assert.equal(first.coordinates.at(-1).timeMs, 1000)
  assert.equal(second.coordinates[0].timeMs, 10_000)
  assert.ok(first.coordinates.at(-1).x < second.coordinates[0].x)

  /**
   * The convenience concatenation still opens one `M` per run, so even a caller
   * that renders `series.path` as a single element draws two subpaths.
   */
  assert.equal(reasoning.path.split('M').length - 1, 2, 'two subpaths, not one')
  assert.equal(view.drawnRuns, 3, 'two reasoning runs and one output run')
})

test('a phase with no runs is absent rather than drawn as a flat zero line', () => {
  const view = curveViewModel(settledCurve({
    series: [
      { key: 'reasoning', tone: 'neutral', runs: [] },
      { key: 'output', tone: 'accent', runs: [run('b', [{ timeMs: 0, tps: 10 }, { timeMs: 1000, tps: 20 }])] },
    ],
  }))
  const reasoning = view.series.find(series => series.key === 'reasoning')
  assert.equal(reasoning.present, false, 'no run means no line')
  assert.equal(reasoning.path, null)
  assert.equal(reasoning.runs.length, 0)
  assert.equal(view.series.length, 2, 'the legend still lists the phase, so its absence is visible')
})

test('a run of one vertex is not drawable as a line but is placed as a marker', () => {
  const view = curveViewModel(settledCurve({
    series: [
      { key: 'reasoning', tone: 'neutral', runs: [] },
      { key: 'output', tone: 'accent', runs: [run('a', [{ timeMs: 0, tps: 10 }])] },
    ],
    peakTps: 10,
  }))
  const output = view.series.find(series => series.key === 'output')
  assert.equal(output.runs.length, 1)
  assert.equal(output.runs[0].present, false, 'one point is a measurement, not a line')
  assert.equal(output.runs[0].path, null)
  assert.equal(output.runs[0].points, 1)
  assert.equal(output.runs[0].peak.tps, 10, 'the measurement itself is still reported on the run')
  assert.equal(output.present, false)
  /**
   * The series-level peak still spans that run: a rendering limitation may not
   * lower a published statistic. The axis is scaled by the settled `peakTps`, so
   * the marker has a position, but there is no line under it.
   */
  assert.equal(output.peak.tps, 10)
  assert.equal(output.path, null, 'nothing is drawn for a single vertex')
  assert.equal(view.peak.display, `≈${formatTps(10)}`, 'the peak is printed, with its approximation marker')
  /**
   * Phase 7 closed the mismatch this test used to record. `drawnPoints` counts
   * **path vertices**, and a singleton contributes none: it is not a vertex of any
   * line. The measurement is placed instead, as a marker, which is carried
   * separately so it can never inflate the count the render budget bounds.
   */
  assert.equal(view.drawnPoints, 0, 'a singleton contributes no path vertex')
  assert.equal(view.markers.length, 1, 'but it is placed on the chart')
  assert.equal(output.markers.length, 1, 'and it belongs to its own series')
  assert.equal(view.markersOnly, true, 'a chart of markers alone is not an unavailable curve')
  const [marker] = view.markers
  assert.equal(marker.series, 'output', 'a marker carries the series it measured')
  assert.equal(marker.tone, 'accent', 'and that series\' tone, not the leader\'s')
  assert.equal(marker.tps, 10)
  assert.equal(marker.attemptId, 'a')
  assert.ok(marker.x >= 0 && marker.x <= CURVE_VIEW_WIDTH)
  assert.ok(marker.y >= 0 && marker.y <= CURVE_PLOT_HEIGHT)
  /** Coincidence with the peak marker is required, not avoided. */
  assert.equal(marker.x, view.peak.x)
  assert.equal(marker.y, view.peak.y)
})

test('the peak marker is approximate, sits on the leading series and is placed inside the plot', () => {
  const view = curveViewModel(settledCurve())
  assert.equal(view.peak.approximate, true, 'a curve sample is never a provider-certified maximum')
  assert.equal(view.peak.display.startsWith('≈'), true, `the marker reads ${view.peak.display}`)
  assert.equal(view.peak.unit, 'tokens/s')
  assert.equal(view.peak.leader, 'output', '700 tokens/s is the output series peak')
  assert.ok(view.peak.x >= 0 && view.peak.x <= CURVE_VIEW_WIDTH)
  assert.ok(view.peak.y >= 0 && view.peak.y <= CURVE_PLOT_HEIGHT)
})

test('an exact token total does not make the peak exact', () => {
  const view = curveViewModel(settledCurve({ quality: 'reconstructed' }))
  assert.equal(view.peak.approximate, true)
  assert.equal(view.peak.display.startsWith('≈'), true)
})

test('a peak shared by both series resolves to reasoning, the earliest series scanned', () => {
  /**
   * The leader is chosen by a strict `>`, and `reasoning` is scanned first, so an equality
   * stays on the reasoning series. That is the same earliest-wins rule `buildSeries` applies
   * *inside* a series, where the comparison is also strict and the points are walked in
   * order — one rule at both levels rather than two.
   *
   * The tie is deliberately *exactly* equal: `placedPeak` is matched to `peak.value` with a
   * floating-point tolerance, so a tie resolved differently on the two sides would leave the
   * card printing a peak with no dot under it.
   */
  const shared = 700
  const view = curveViewModel(settledCurve({
    series: [
      {
        key: 'reasoning',
        tone: 'neutral',
        runs: [run('a', [
          { timeMs: 0, tps: 50 },
          { timeMs: 2500, tps: shared },
          { timeMs: 5000, tps: 300 },
        ])],
      },
      {
        key: 'output',
        tone: 'accent',
        runs: [run('b', [
          { timeMs: 5000, tps: 0 },
          { timeMs: 10_000, tps: shared },
          { timeMs: 20_000, tps: 120 },
        ])],
      },
    ],
    peakTps: shared,
  }))

  assert.equal(view.peak.leader, 'reasoning', 'a tie belongs to the series scanned first')
  assert.equal(view.peak.value, shared)
  assert.notEqual(view.peak.x, null, 'and the shared measurement still has a position')
  assert.notEqual(view.peak.y, null)
  /**
   * The dot must sit on the reasoning vertex, not the output one. Both vertices carry the same
   * rate, so `y` cannot tell them apart — the `x` axis can, because the two series reach the
   * shared maximum at 2500ms and 10000ms respectively. A leader that flipped would place the
   * marker above the same number at a visibly different time.
   */
  const reasoningPeak = view.series[0].peak
  const round2 = value => Math.round(value * 100) / 100
  assert.equal(reasoningPeak.tps, shared)
  assert.equal(reasoningPeak.timeMs, 2500, 'the reasoning vertex that holds the shared maximum')
  assert.equal(view.series[1].peak.timeMs, 10_000, 'and the output one, at a different time')
  assert.equal(view.peak.x, round2(reasoningPeak.x),
    'the marker is placed on the reasoning measurement, which is what the card prints')
  assert.ok(view.peak.x < round2(view.series[1].peak.x),
    `the placed marker sits at ${view.peak.x}, and the output vertex is at ${round2(view.series[1].peak.x)}`)
})

test('a strictly larger output peak still takes the leader', () => {
  /** The tie rule must not shadow the ordinary case: a real maximum on output still wins. */
  const view = curveViewModel(settledCurve())
  assert.equal(view.peak.leader, 'output')
  assert.equal(view.peak.value, 700)
  assert.equal(view.peak.x, view.series[1].peak.x)
})

test('the view model carries no more points than the downsample budget allowed', () => {
  const reasoning = []
  const output = []
  for (let i = 0; i <= 3000; i += 1) reasoning.push({ timeMs: i * 250, tps: (i % 11) * 90 })
  for (let i = 0; i <= 3000; i += 1) output.push({ timeMs: i * 250, tps: (i % 7) * 130 })
  const durationMs = 3000 * 250
  const view = curveViewModel({
    curve: {
      durationMs,
      series: [
        { key: 'reasoning', tone: 'neutral', runs: [run('a', downsampleSeries(reasoning))] },
        { key: 'output', tone: 'accent', runs: [run('a', downsampleSeries(output))] },
      ],
      peakTps: Math.max(...reasoning.map(p => p.tps), ...output.map(p => p.tps)),
    },
  })
  assert.ok(view.drawnPoints <= DEFAULT_MAX_POINTS * 2,
    `the SVG receives ${view.drawnPoints} vertices at most, from a 6002-point input`)
  for (const series of view.series) {
    assert.ok(series.points <= DEFAULT_MAX_POINTS)
    assert.equal(series.present, true)
  }
})

test('a zero-length turn still yields a drawable, finite view model', () => {
  const view = curveViewModel(settledCurve({
    durationMs: 0,
    series: [
      { key: 'reasoning', tone: 'neutral', runs: [run('a', [{ timeMs: 0, tps: 0 }, { timeMs: 0, tps: 0 }])] },
      { key: 'output', tone: 'accent', runs: [run('a', [{ timeMs: 0, tps: 0 }, { timeMs: 0, tps: 0 }])] },
    ],
    peakTps: 0,
  }))
  assert.equal(view.peak.display, '—', 'a measured zero is not a peak')
  assert.equal(Number.isFinite(view.axis.max), true)
  assert.deepEqual(view.axis, { max: 1, display: '1' })
  for (const series of view.series) {
    if (series.path === null) continue
    assert.equal(/NaN|Infinity|undefined/.test(series.path), false, 'no degenerate coordinate reaches the DOM')
  }
})

test('path coordinates are finite, bounded and in nondecreasing x order', () => {
  const view = curveViewModel(settledCurve())
  for (const series of view.series) {
    for (const each of series.runs) {
      if (each.path === null) continue
      assert.equal(/NaN|Infinity|undefined/.test(each.path), false)
      assert.equal(each.path.startsWith('M'), true)
      let previous = -1
      for (const point of each.coordinates) {
        assert.ok(point.x >= 0 && point.x <= CURVE_VIEW_WIDTH)
        assert.ok(point.y >= 0 && point.y <= CURVE_PLOT_HEIGHT)
        assert.ok(point.x >= previous, 'x never decreases')
        previous = point.x
      }
    }
  }
})

test('a snapshot that predates the run structure still draws, bounded by its phase spans', () => {
  /**
   * The legacy shape carries flat arrays and one interval per phase. It must
   * degrade to the old single-run drawing rather than to an empty chart, and the
   * interval must still suppress the zeros outside the phase's evidence.
   */
  const view = curveViewModel({
    curve: {
      durationMs: 20_000,
      reasoning: [{ timeMs: 0, tps: 50 }, { timeMs: 1000, tps: 50 }, { timeMs: 20_000, tps: 0 }],
      output: [{ timeMs: 5000, tps: 300 }, { timeMs: 9000, tps: 300 }],
      peakTps: 300,
      phaseSpans: {
        reasoning: { startMs: 0, endMs: 2000 },
        output: { startMs: 5000, endMs: 10_000 },
      },
    },
  })
  const reasoning = view.series.find(series => series.key === 'reasoning')
  const output = view.series.find(series => series.key === 'output')
  assert.equal(reasoning.present, true)
  assert.equal(output.present, true)
  assert.equal(reasoning.runs.length, 1, 'a legacy snapshot is one run per phase')
  assert.equal(reasoning.runs[0].attemptId, null, 'it carries no attempt identity to report')
  assert.equal(reasoning.coordinates.some(point => point.timeMs === 20_000), false,
    'the 20 s zero is outside the reasoning interval and is not drawn')
  assert.equal(output.coordinates.every(point => point.timeMs >= 5000), true)
})

test('a snapshot with no availability metadata at all draws the whole array', () => {
  const view = curveViewModel({
    curve: {
      durationMs: 10_000,
      reasoning: [{ timeMs: 0, tps: 10 }, { timeMs: 5000, tps: 20 }],
      output: [],
      peakTps: 20,
    },
  })
  const reasoning = view.series.find(series => series.key === 'reasoning')
  assert.equal(reasoning.present, true, 'nothing says the phase is absent, so it is drawn')
  assert.equal(reasoning.points, 2)
  assert.equal(view.series.find(series => series.key === 'output').present, false)
})

test('the view model is a pure function of the settled curve', () => {
  const settled = settledCurve()
  assert.deepEqual(curveViewModel(settled), curveViewModel(settled))
  const frozen = JSON.stringify(curveViewModel(settled))
  /** The input is not mutated, so the projection cache cannot be poisoned. */
  curveViewModel(settled)
  assert.equal(JSON.stringify(curveViewModel(settled)), frozen)
})
