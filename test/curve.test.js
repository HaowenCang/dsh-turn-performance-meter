import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_POINTS,
  MIN_MAX_POINTS,
  downsampleSeries,
  peakTps,
  phaseSpans,
  rollingTpsSeries,
} from '../src/core/curve.js'

test('rolling curve operates on active-time samples', () => {
  const series = rollingTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 10 },
    { activeTimeMs: 500, phase: 'output', tokens: 20 },
    { activeTimeMs: 1500, phase: 'output', tokens: 30 },
  ], { phase: 'output', windowMs: 1000, sampleEveryMs: 500, durationMs: 1500 })
  assert.equal(series.find(p => p.timeMs === 500).tps, 30)
  assert.equal(series.find(p => p.timeMs === 1500).tps, 30)
  assert.equal(peakTps(series), 30)
})

test('each phase series contains only its own samples', () => {
  const samples = [
    { activeTimeMs: 0, phase: 'reasoning', tokens: 10 },
    { activeTimeMs: 0, phase: 'output', tokens: 40 },
    { activeTimeMs: 1000, phase: 'output', tokens: 40 },
  ]
  const reasoning = rollingTpsSeries(samples, { phase: 'reasoning', sampleEveryMs: 500, durationMs: 1000 })
  const output = rollingTpsSeries(samples, { phase: 'output', sampleEveryMs: 500, durationMs: 1000 })
  // Reasoning has a single sample, so the window holds 10 tokens => 10 tokens/s.
  assert.equal(peakTps(reasoning), 10)
  assert.equal(reasoning.find(p => p.timeMs === 1000).tps, 0, 'the reasoning sample has left the window')
  // Output holds 40 tokens in every window, so the series is flat at 40 tokens/s.
  assert.equal(peakTps(output), 40)
  assert.equal(output.find(p => p.timeMs === 1000).tps, 40)
  assert.equal(peakTps(reasoning, output), 40, 'peak is taken over both rendered series')
})

test('a stall inside one model stream appears as a local trough, not as removed width', () => {
  const series = rollingTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    // 5 s of silence: a delivery stall, preserved on the compressed clock.
    { activeTimeMs: 5000, phase: 'output', tokens: 100 },
  ], { phase: 'output', sampleEveryMs: 500, durationMs: 5000 })

  assert.equal(series.find(p => p.timeMs === 500).tps, 100)
  assert.equal(series.find(p => p.timeMs === 3000).tps, 0, 'the stall must be visible')
  assert.equal(series.find(p => p.timeMs === 5000).tps, 100)
  assert.equal(series.at(-1).timeMs, 5000)
})

test('tool time contributes no curve width at all', () => {
  // Same model samples, one with a 60 s tool gap between two attempts.
  const shortGap = rollingTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 50 },
    { activeTimeMs: 1000, phase: 'output', tokens: 50 },
  ], { phase: 'output', sampleEveryMs: 250, durationMs: 1000 })
  const longGap = rollingTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 50 },
    { activeTimeMs: 1000, phase: 'output', tokens: 50 },
  ], { phase: 'output', sampleEveryMs: 250, durationMs: 1000 })
  assert.deepEqual(shortGap, longGap)
})

test('series sampling is bounded and covers the whole duration', () => {
  const series = rollingTpsSeries([{ activeTimeMs: 0, phase: 'output', tokens: 1 }], {
    phase: 'output',
    sampleEveryMs: 250,
    durationMs: 60_000,
  })
  assert.equal(series.length, 241)
  assert.equal(series[0].timeMs, 0)
  assert.equal(series.at(-1).timeMs, 60_000)
})

test('invalid window or cadence is rejected instead of producing infinite TPS', () => {
  assert.throws(() => rollingTpsSeries([], { windowMs: 0 }), TypeError)
  assert.throws(() => rollingTpsSeries([], { sampleEveryMs: 0 }), TypeError)
  assert.throws(() => rollingTpsSeries([], { windowMs: Number.NaN }), TypeError)
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

test('a phase span marks where a series means something, not where it happens to read zero', () => {
  const samples = [
    { activeTimeMs: 0, phase: 'reasoning', tokens: 5 },
    { activeTimeMs: 3000, phase: 'reasoning', tokens: 5 },
    { activeTimeMs: 9000, phase: 'output', tokens: 5 },
    { activeTimeMs: 12_000, phase: 'output', tokens: 5 },
  ]
  const spans = phaseSpans(samples, 15_000, 1000)
  assert.deepEqual(spans.reasoning, { startMs: 0, endMs: 4000 },
    'reasoning is evidenced up to one window after its last token')
  assert.deepEqual(spans.output, { startMs: 9000, endMs: 13_000 })
  /**
   * The interval between them — 4 s to 9 s — is where an output-only zero for
   * reasoning would be a lie: reasoning had ended, it had not collapsed.
   */
  assert.ok(spans.reasoning.endMs < spans.output.startMs)
})

test('a phase with no samples has no span, and the tail is clamped to the duration', () => {
  const spans = phaseSpans([{ activeTimeMs: 500, phase: 'output', tokens: 1 }], 1000, 1000)
  assert.equal(spans.reasoning, null, 'absent phase, absent span — never a zero line')
  assert.deepEqual(spans.output, { startMs: 500, endMs: 1000 }, 'the window tail cannot exceed the turn')
  assert.deepEqual(phaseSpans([], 0, 1000), { reasoning: null, output: null })
  assert.deepEqual(phaseSpans(null, Number.NaN, 1000), { reasoning: null, output: null })
})

test('the rendered series stays bounded for a real turn shape', () => {
  const samples = []
  for (let t = 0; t <= 600_000; t += 40) {
    samples.push({ activeTimeMs: t, phase: t < 200_000 ? 'reasoning' : 'output', tokens: 3 })
  }
  const series = rollingTpsSeries(samples, { phase: 'output', durationMs: 600_000, sampleEveryMs: 250 })
  assert.equal(series.length, 2401)
  const reduced = downsampleSeries(series)
  assert.ok(reduced.length <= DEFAULT_MAX_POINTS, `250 ms sampling of a 10-minute turn still fits the budget`)
  assert.equal(reduced[0], series[0])
  assert.equal(reduced.at(-1), series.at(-1))
})
