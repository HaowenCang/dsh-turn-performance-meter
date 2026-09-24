import test from 'node:test'
import assert from 'node:assert/strict'
import { downsampleSeries, peakTps, rollingTpsSeries } from '../src/core/curve.js'

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
