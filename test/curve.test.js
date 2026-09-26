/**
 * The rolling-window sampler and the render-time reducer, as pure functions.
 *
 * This file is the unit-level half of the curve contract; the scenario half lives in
 * `test/curve-reference-window.test.js` (an independent brute-force reference),
 * `test/curve-regression-matrix.test.js` (one named scenario per frozen semantic) and
 * `test/curve-attempt-boundary.test.js` (the cross-attempt counterexample).
 *
 * Two functions carry the whole definition:
 *
 *   - `totalRollingTpsSeries` rolls **one** trailing window over one attempt's samples,
 *     counting every phase, and labels each vertex with the phase of the newest sample at
 *     or before it. It has no notion of an attempt, which is why it must never be called
 *     across a boundary;
 *   - `downsampleSeries` reduces a series for rendering without ever being able to delete
 *     the global peak.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_POINTS,
  MIN_MAX_POINTS,
  attemptTrace,
  downsampleRun,
  downsampleSeries,
  peakTps,
  phaseRuns,
  phaseSpans,
  totalRollingTpsSeries,
  visualRunsOf,
} from '../src/core/curve.js'

test('the total rolling series counts every phase in one window', () => {
  const samples = [
    { activeTimeMs: 0, phase: 'reasoning', tokens: 600 },
    { activeTimeMs: 500, phase: 'output', tokens: 400 },
  ]
  const series = totalRollingTpsSeries(samples, { sampleEveryMs: 500, durationMs: 1500 })
  assert.equal(series.find(p => p.localMs === 0).tps, 600,
    'the opening vertex measures the reasoning delta alone')
  assert.equal(series.find(p => p.localMs === 500).tps, 1000,
    'at the transition the window holds 600 reasoning + 400 output')
  assert.equal(series.find(p => p.localMs === 1000).tps, 400,
    'one window later the reasoning delta has expired')
  assert.equal(peakTps(series), 1000)
})

test('the phase is a label on a vertex, never a filter of the series', () => {
  const samples = [
    { activeTimeMs: 0, phase: 'reasoning', tokens: 10 },
    { activeTimeMs: 750, phase: 'output', tokens: 90 },
  ]
  const series = totalRollingTpsSeries(samples, { sampleEveryMs: 250, durationMs: 1750 })
  assert.deepEqual(series.map(p => [p.localMs, p.activePhase]), [
    [0, 'reasoning'], [250, 'reasoning'], [500, 'reasoning'], [750, 'output'],
    [1000, 'output'], [1250, 'output'], [1500, 'output'], [1750, 'output'],
  ], 'the label changes exactly where the newest sample does')
  assert.deepEqual(series.map(p => p.tps), [10, 10, 10, 100, 90, 90, 90, 0],
    'and the rate is one total: at 750 ms both samples are inside the window')
})

test('an empty window reads zero, and the trough of a stall is a real zero', () => {
  const series = totalRollingTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    /** 5 s of silence: a delivery stall, preserved on the compressed clock. */
    { activeTimeMs: 5000, phase: 'output', tokens: 100 },
  ], { sampleEveryMs: 500, durationMs: 5000 })

  assert.equal(series.find(p => p.localMs === 500).tps, 100)
  assert.equal(series.find(p => p.localMs === 3000).tps, 0, 'the stall must be visible')
  assert.equal(series.find(p => p.localMs === 5000).tps, 100)
  assert.equal(series.at(-1).localMs, 5000)
})

test('simultaneous samples of two phases resolve to one deterministic label', () => {
  /**
   * A reasoning delta and a text delta can share a timestamp. The vertex's label is read off
   * the newest sample at or before it, so with a time-only sort that choice fell to the
   * sort's stability — the same evidence could label the same vertex `reasoning` or `output`
   * depending on which chunk the transport delivered first. The tie is now broken by phase,
   * and `output` wins because it sorts later.
   */
  const reasoningFirst = totalRollingTpsSeries([
    { activeTimeMs: 0, phase: 'reasoning', tokens: 10 },
    { activeTimeMs: 0, phase: 'output', tokens: 20 },
  ], { sampleEveryMs: 250, durationMs: 0 })
  const outputFirst = totalRollingTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 20 },
    { activeTimeMs: 0, phase: 'reasoning', tokens: 10 },
  ], { sampleEveryMs: 250, durationMs: 0 })
  assert.deepEqual(reasoningFirst, outputFirst, 'arrival order cannot change the series')
  assert.equal(reasoningFirst[0].activePhase, 'output', 'and the tie resolves to the later phase')
  assert.equal(reasoningFirst[0].tps, 30, 'both deltas are inside the window regardless')

  /** The same rule reaches the attempt trace, which sorts its own samples. */
  const trace = attemptTrace(
    { attemptId: 'a', startMs: 0, endMs: 0 },
    [
      { attemptId: 'a', attemptTimeMs: 0, activeTimeMs: 0, phase: 'output', tokens: 20 },
      { attemptId: 'a', attemptTimeMs: 0, activeTimeMs: 0, phase: 'reasoning', tokens: 10 },
    ],
  )
  assert.equal(trace.points[0].activePhase, 'output')
  assert.deepEqual(trace.visualRuns.map(run => run.phase), ['output'])
})

test('tool time contributes no curve width at all', () => {
  /**
   * The sampler never sees wall time: it is fed attempt-local coordinates, and
   * `compressAttempts` is what removes tool width before it gets here. Two identical
   * local scripts therefore produce identical series whatever separated them in wall
   * time, which is the whole of the "zero x width" guarantee at this layer.
   */
  const local = [
    { activeTimeMs: 0, phase: 'output', tokens: 50 },
    { activeTimeMs: 1000, phase: 'output', tokens: 50 },
  ]
  assert.deepEqual(
    totalRollingTpsSeries(local, { sampleEveryMs: 250, durationMs: 1000 }),
    totalRollingTpsSeries(local.map(s => ({ ...s })), { sampleEveryMs: 250, durationMs: 1000 }),
  )
})

test('series sampling is bounded and covers the whole duration', () => {
  const series = totalRollingTpsSeries([{ activeTimeMs: 0, phase: 'output', tokens: 1 }], {
    sampleEveryMs: 250,
    durationMs: 60_000,
  })
  assert.equal(series.length, 241)
  assert.equal(series[0].localMs, 0)
  assert.equal(series.at(-1).localMs, 60_000)
})

test('invalid window or cadence is rejected instead of producing infinite TPS', () => {
  assert.throws(() => totalRollingTpsSeries([], { windowMs: 0 }), TypeError)
  assert.throws(() => totalRollingTpsSeries([], { sampleEveryMs: 0 }), TypeError)
  assert.throws(() => totalRollingTpsSeries([], { windowMs: Number.NaN }), TypeError)
})

test('visual runs share their boundary vertex and cover the grid exactly once', () => {
  const points = [
    { timeMs: 0, activePhase: 'reasoning' },
    { timeMs: 250, activePhase: 'reasoning' },
    { timeMs: 500, activePhase: 'output' },
    { timeMs: 750, activePhase: 'output' },
    { timeMs: 1000, activePhase: 'reasoning' },
  ]
  const runs = visualRunsOf(points)
  assert.deepEqual(runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 1],
    ['output', 1, 3],
    ['reasoning', 3, 4],
  ], 'each run ends on the vertex the next one opens on, and the boundary is the midpoint '
    + 'between the last vertex of the old label and the first of the new one')
  assert.equal(runs.reduce((sum, run) => sum + run.pointCount, 0), points.length + runs.length - 1,
    'the shared seams are the only duplication')
  assert.deepEqual(visualRunsOf([]), [], 'no points, no runs')
  assert.deepEqual(visualRunsOf([{ timeMs: 0, activePhase: null }]).map(run => run.phase), [null],
    'a vertex with no sample at or before it opens its own run rather than being merged away')
  /**
   * A silence between the two labels moves the seam into the middle of it, so neither tone is
   * painted over a stretch its own phase did not produce, and the two still meet.
   */
  const gapped = visualRunsOf([
    { timeMs: 0, activePhase: 'reasoning' },
    { timeMs: 250, activePhase: 'reasoning' },
    { timeMs: 500, activePhase: 'reasoning' },
    { timeMs: 3000, activePhase: 'output' },
    { timeMs: 3250, activePhase: 'output' },
  ])
  assert.deepEqual(gapped.map(run => [run.phase, run.startIndex, run.endIndex]),
    [['reasoning', 0, 2], ['output', 2, 4]],
    'the seam lands on the last vertex still labelled reasoning, which is also the first the '
    + 'output run can open on: the midpoint of the silence')
})

test('a phase with no run is absent, never a flat zero line', () => {
  const trace = attemptTrace(
    { attemptId: 'a', startMs: 0, endMs: 1000 },
    [{ attemptId: 'a', attemptTimeMs: 500, activeTimeMs: 500, phase: 'output', tokens: 10 }],
    { sampleEveryMs: 250 },
  )
  const reasons = phaseRuns([trace])
  assert.deepEqual(reasons.reasoning, [], 'absent phase, no run')
  assert.equal(reasons.output.length, 1)
  assert.deepEqual(phaseSpans([]), { reasoning: null, output: null })
})

test('downsampling bounds the rendered point count and keeps extrema and endpoints', () => {
  const series = []
  for (let i = 0; i <= 5000; i += 1) series.push({ timeMs: i * 250, tps: 100 })
  series[2500].tps = 9000   // the one spike
  series[1000].tps = 1      // the one stall

  const reduced = downsampleSeries(series, 300)
  assert.ok(reduced.length <= 300, `got ${reduced.length} points`)
  assert.equal(reduced[0], series[0])
  assert.equal(reduced.at(-1), series.at(-1))
  assert.equal(peakTps(reduced), 9000, 'the spike must survive downsampling')
  assert.equal(Math.min(...reduced.map(p => p.tps)), 1, 'the stall must survive downsampling')
})

test('downsampling a short series leaves it untouched', () => {
  const series = [{ timeMs: 0, tps: 1 }, { timeMs: 250, tps: 2 }]
  assert.deepEqual(downsampleSeries(series, 300), series)
})

test('downsampling preserves point identity so the renderer can key them', () => {
  const series = Array.from({ length: 1000 }, (_, i) => ({ timeMs: i * 100, tps: (i % 7) * 10 }))
  const reduced = downsampleSeries(series, 64)
  assert.ok(reduced.length <= 64)
  for (const point of reduced) assert.ok(series.includes(point))
})

/**
 * A counterexample against the previous implementation.
 *
 * The old code kept every local extremum and then, when that set exceeded the
 * budget, thinned it by uniform stride. Alternating values make *every* interior
 * index a local extremum, and the peak is parked on an index the stride steps
 * over — so the old code silently dropped the one point the chart exists to
 * show. The copy below is the old algorithm verbatim; it must fail the
 * assertions the new one passes.
 */
function legacyDownsample(series, maxPoints) {
  const points = series
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
  const thinned = []
  const stride = (ordered.length - 1) / (maxPoints - 1)
  for (let k = 0; k < maxPoints; k += 1) thinned.push(points[ordered[Math.round(k * stride)]])
  return thinned
}

/** `extrema > budget`: every interior index is a local extremum. */
function extremumSaturatedSeries(length, peakIndex, peakValue, troughIndex, troughValue) {
  const series = Array.from({ length }, (_, i) => ({ timeMs: i * 250, tps: i % 2 === 0 ? 100 : 101 }))
  series[peakIndex] = { timeMs: peakIndex * 250, tps: peakValue }
  series[troughIndex] = { timeMs: troughIndex * 250, tps: troughValue }
  return series
}

test('a saturated extremum set cannot cost the global peak: the stride counterexample', () => {
  const series = extremumSaturatedSeries(2000, 5, 9999, 9, 1)
  const budget = 64

  const legacy = legacyDownsample(series, budget)
  assert.equal(peakTps(legacy), 101, 'the old stride is what loses the spike')
  assert.equal(Math.min(...legacy.map(point => point.tps)), 100, 'and the trough with it')

  const reduced = downsampleSeries(series, budget)
  assert.equal(peakTps(reduced), 9999, 'the global peak survives the budget')
  assert.equal(Math.min(...reduced.map(point => point.tps)), 1, 'the global trough survives too')
})

test('the rendered series always keeps the first point, the last point and both global extremes', () => {
  const series = extremumSaturatedSeries(1500, 733, 5000, 411, 2)
  for (const budget of [4, 8, 64, DEFAULT_MAX_POINTS]) {
    const reduced = downsampleSeries(series, budget)
    assert.ok(reduced.length <= budget, `budget ${budget} respected (got ${reduced.length})`)
    assert.equal(reduced[0].timeMs, 0, 'first point retained')
    assert.equal(reduced.at(-1).timeMs, series.at(-1).timeMs, 'last point retained')
    assert.equal(peakTps(reduced), 5000, 'global maximum retained')
    assert.equal(Math.min(...reduced.map(point => point.tps)), 2, 'global minimum retained')
  }
})

test('a three-point budget honours the three hard guarantees and yields the trough', () => {
  const series = extremumSaturatedSeries(1500, 733, 5000, 411, 2)
  const reduced = downsampleSeries(series, MIN_MAX_POINTS)
  assert.equal(reduced.length, 3)
  assert.equal(reduced[0].timeMs, 0)
  assert.equal(reduced.at(-1).timeMs, series.at(-1).timeMs)
  assert.equal(peakTps(reduced), 5000, 'the peak is guaranteed at every budget')
  assert.equal(reduced.some(point => point.tps === 2), false,
    'the recommended trough is what gives way when the budget cannot hold four anchors')
})

test('a required seam survives a budget that has no room for anything else', () => {
  /**
   * The seam is a structural obligation, not a shape preference: a run's first and last
   * vertex are what keep a phase transition continuous. A budget of exactly three holds
   * the two endpoints and the peak, and `required` can only ever name indices among them
   * — which is why the reserve cannot starve the peak it is seated after.
   */
  const series = extremumSaturatedSeries(400, 200, 9000, 100, 1)
  const required = new Set([0, series.length - 1])
  const reduced = downsampleSeries(series, MIN_MAX_POINTS, { required })
  assert.equal(reduced.length, 3)
  assert.equal(reduced[0], series[0], 'the opening seam vertex survives')
  assert.equal(reduced.at(-1), series.at(-1), 'and the closing one')
  assert.equal(peakTps(reduced), 9000, 'and the peak is still guaranteed')
})

test('downsampleRun protects the boundary vertex of a phase transition', () => {
  /**
   * A visual run is a slice of its attempt's grid, and at a phase transition it shares its
   * first or last vertex with the neighbouring run. Thinning each run independently would
   * be free to drop exactly that shared vertex, reopening as a blank horizontal gap a tone
   * change that is not a stall — so `downsampleRun` reserves both ends.
   */
  const slice = Array.from({ length: 200 }, (_, i) => ({ timeMs: i * 250, tps: i === 137 ? 4000 : 100 }))
  for (const budget of [MIN_MAX_POINTS, 4, 8, 64]) {
    const reduced = downsampleRun(slice, budget)
    assert.ok(reduced.length <= budget, `budget ${budget} respected`)
    assert.equal(reduced[0], slice[0], 'the outgoing seam vertex survives every budget')
    assert.equal(reduced.at(-1), slice[slice.length - 1], 'and so does the incoming one')
    assert.equal(peakTps(reduced), 4000, 'and the run\'s own maximum')
  }
  assert.throws(() => downsampleRun(slice, MIN_MAX_POINTS - 1), TypeError)
})

test('a short run is returned whole rather than thinned', () => {
  const slice = [{ timeMs: 0, tps: 1 }, { timeMs: 250, tps: 2 }]
  assert.deepEqual(downsampleRun(slice, MIN_MAX_POINTS), slice)
})

test('downsampling never invents a peak the full series does not have', () => {
  const series = extremumSaturatedSeries(1200, 200, 900, 800, 3)
  const reduced = downsampleSeries(series, 32)
  assert.ok(peakTps(reduced) <= peakTps(series), 'the rendered peak cannot exceed the measured one')
  assert.equal(peakTps(reduced), peakTps(series), 'and it must reach it')
})

test('the earliest index wins a tie, so equal input gives byte-identical output', () => {
  const series = Array.from({ length: 900 }, (_, i) => ({ timeMs: i * 250, tps: i % 3 === 0 ? 777 : 10 }))
  const first = downsampleSeries(series, 40)
  const second = downsampleSeries(series, 40)
  assert.deepEqual(first, second, 'determinism')
  assert.equal(first.find(point => point.tps === 777).timeMs, 0, 'the earliest of the tied maxima is kept')
})

test('rendered x is nondecreasing even when the input is not time-ordered', () => {
  const shuffled = Array.from({ length: 800 }, (_, i) => ({ timeMs: i * 250, tps: (i * 37) % 500 }))
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = (i * 7919) % (i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const reduced = downsampleSeries(shuffled, 48)
  for (let i = 1; i < reduced.length; i += 1) {
    assert.ok(reduced[i].timeMs >= reduced[i - 1].timeMs, 'the drawn path cannot double back on x')
  }
})

test('a budget that cannot hold the mandatory anchors is refused rather than silently broken', () => {
  const series = extremumSaturatedSeries(100, 4, 900, 90, 1)
  for (const bad of [0, 1, 2, Number.NaN, -1]) {
    assert.throws(() => downsampleSeries(series, bad), TypeError, `maxPoints ${bad} is unsatisfiable`)
  }
  assert.doesNotThrow(() => downsampleSeries(series, MIN_MAX_POINTS))
})

test('the rendered series stays bounded for a real turn shape', () => {
  const samples = []
  for (let t = 0; t <= 600_000; t += 40) {
    samples.push({ activeTimeMs: t, phase: t < 200_000 ? 'reasoning' : 'output', tokens: 3 })
  }
  const series = totalRollingTpsSeries(samples, { durationMs: 600_000, sampleEveryMs: 250 })
  assert.equal(series.length, 2401)
  const reduced = downsampleSeries(series)
  assert.ok(reduced.length <= DEFAULT_MAX_POINTS, '250 ms sampling of a 10-minute turn still fits the budget')
  assert.equal(reduced[0], series[0])
  assert.equal(reduced.at(-1), series.at(-1))
})

test('an attempt trace measures its own clock and relabels onto the compressed one', () => {
  const segment = { attemptId: 'b', startMs: 5000, endMs: 5500, hasSuccessor: false }
  const trace = attemptTrace(segment, [
    { attemptId: 'b', attemptTimeMs: 0, activeTimeMs: 5000, phase: 'output', tokens: 100 },
    { attemptId: 'b', attemptTimeMs: 500, activeTimeMs: 5500, phase: 'output', tokens: 100 },
  ], { sampleEveryMs: 250 })
  assert.deepEqual(trace.points.map(point => point.localMs), [0, 250, 500, 750, 1000, 1250, 1500])
  assert.deepEqual(trace.points.map(point => point.timeMs), [5000, 5250, 5500, 5750, 6000, 6250, 6500],
    'the drawn coordinate is the local one shifted by the segment start')
  assert.deepEqual(trace.points.map(point => point.tps), [100, 100, 200, 200, 100, 100, 0])
  assert.equal(trace.tokens, 200)
  assert.equal(trace.calibratedTokens, null, 'an estimated magnitude is never reported as calibrated')
})

test('an attempt with no samples produces no trace', () => {
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 0 }, [])
  assert.deepEqual(trace.points, [])
  assert.deepEqual(trace.visualRuns, [])
  assert.equal(trace.sampleCount, 0)
  assert.equal(trace.durationMs, 0)
})
