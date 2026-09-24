/**
 * The settled curve -> SVG seam.
 *
 * `curveViewModel` is the only place the chart's geometry is decided, so these
 * assertions are about numbers: the axis ceiling, which stretch of each series is
 * drawn, where the peak marker lands, and that nothing in the view model claims a
 * provider-exact maximum. The element tree is checked separately in
 * `test/completed-interaction.test.js`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CURVE_PLOT_HEIGHT,
  CURVE_VIEW_WIDTH,
  curveViewModel,
  niceCeiling,
} from '../src/client/completed/curve-view-model.js'
import { DEFAULT_MAX_POINTS, downsampleSeries, phaseSpans } from '../src/core/curve.js'

/** A settled snapshot as `telemetry-design.js` produces one. */
function settledCurve(overrides = {}) {
  return {
    curve: {
      durationMs: 20_000,
      segments: [{ attemptId: 'a', startMs: 0, endMs: 20_000 }],
      reasoning: [
        { timeMs: 0, tps: 50 },
        { timeMs: 2500, tps: 400 },
        { timeMs: 5000, tps: 300 },
      ],
      output: [
        { timeMs: 5000, tps: 0 },
        { timeMs: 10_000, tps: 700 },
        { timeMs: 20_000, tps: 120 },
      ],
      peakTps: 700,
      phaseSpans: { reasoning: { startMs: 0, endMs: 6000 }, output: { startMs: 5000, endMs: 20_000 } },
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
   * The ceiling is derived from `peakTps` (700, a full-series statistic), not
   * from the largest drawn point. A renderer that scaled to the drawn points
   * would let downsampling silently rescale the chart.
   */
  assert.equal(view.axis.max, 1000)
  assert.equal(view.axis.max >= view.peak.value, true)
  assert.equal(curveViewModel(settledCurve({ peakTps: 900 })).axis.max, 1000)
})

test('each series is drawn only over its own evidence span', () => {
  const view = curveViewModel(settledCurve())
  const reasoning = view.series.find(series => series.key === 'reasoning')
  const output = view.series.find(series => series.key === 'output')

  assert.equal(reasoning.present, true)
  assert.equal(output.present, true)
  /**
   * Reasoning is evidenced to 6 s; its 20 s point is outside the span and must
   * not be drawn, because a zero there would read as "reasoning collapsed"
   * rather than "reasoning ended".
   */
  assert.equal(reasoning.coordinates.every(point => point.timeMs <= 6000), true)
  assert.equal(output.coordinates.every(point => point.timeMs >= 5000), true)
  assert.equal(output.coordinates.some(point => point.timeMs < 5000), false,
    'the output series never covers the reasoning stretch')
})

test('a phase with no evidence is absent rather than drawn as a flat zero line', () => {
  const view = curveViewModel(settledCurve({
    reasoning: [{ timeMs: 0, tps: 0 }, { timeMs: 1000, tps: 0 }, { timeMs: 2000, tps: 0 }],
    peakTps: 700,
    phaseSpans: { reasoning: null, output: { startMs: 0, endMs: 20_000 } },
  }))
  const reasoning = view.series.find(series => series.key === 'reasoning')
  assert.equal(reasoning.present, false, 'no span means no line')
  assert.equal(reasoning.path, null)
  assert.equal(view.series.length, 2, 'the legend still lists the phase, so its absence is visible')
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
  const view = curveViewModel(settledCurve({ quality: 'calibrated' }))
  assert.equal(view.peak.approximate, true)
  assert.equal(view.peak.display.startsWith('≈'), true)
})

test('the view model carries no more points than the downsample budget allowed', () => {
  const reasoning = []
  const output = []
  for (let i = 0; i <= 3000; i += 1) reasoning.push({ timeMs: i * 250, tps: (i % 11) * 90 })
  for (let i = 0; i <= 3000; i += 1) output.push({ timeMs: i * 250, tps: (i % 7) * 130 })
  const durationMs = 3000 * 250
  /** Compressed samples carry `activeTimeMs`; that is what `phaseSpans` reads. */
  const samples = [
    ...reasoning.map(p => ({ activeTimeMs: p.timeMs, phase: 'reasoning' })),
    ...output.map(p => ({ activeTimeMs: p.timeMs, phase: 'output' })),
  ]
  const view = curveViewModel({
    curve: {
      durationMs,
      reasoning: downsampleSeries(reasoning),
      output: downsampleSeries(output),
      peakTps: Math.max(...reasoning.map(p => p.tps), ...output.map(p => p.tps)),
      phaseSpans: phaseSpans(samples, durationMs, 1000),
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
    reasoning: [{ timeMs: 0, tps: 0 }, { timeMs: 0, tps: 0 }],
    output: [{ timeMs: 0, tps: 0 }, { timeMs: 0, tps: 0 }],
    peakTps: 0,
    phaseSpans: { reasoning: { startMs: 0, endMs: 0 }, output: { startMs: 0, endMs: 0 } },
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
    if (series.path === null) continue
    assert.equal(/NaN|Infinity|undefined/.test(series.path), false)
    assert.equal(series.path.startsWith('M'), true)
    let previous = -1
    for (const point of series.coordinates) {
      assert.ok(point.x >= 0 && point.x <= CURVE_VIEW_WIDTH)
      assert.ok(point.y >= 0 && point.y <= CURVE_PLOT_HEIGHT)
      assert.ok(point.x >= previous, 'x never decreases')
      previous = point.x
    }
  }
})

test('the view model is a pure function of the settled curve', () => {
  const settled = settledCurve()
  assert.deepEqual(curveViewModel(settled), curveViewModel(settled))
  const frozen = JSON.stringify(curveViewModel(settled))
  /** The input is not mutated, so the projection cache cannot be poisoned. */
  curveViewModel(settled)
  assert.equal(JSON.stringify(curveViewModel(settled)), frozen)
})
