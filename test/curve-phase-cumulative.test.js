/**
 * The completed curve's Phase 9.2 statistic: a **phase-cumulative** average.
 *
 * ## What replaced the trailing window
 *
 * Until Phase 9.2 a vertex reported a trailing-one-second total: the mass of every
 * generated sample inside `(t - 1000, t]`, whatever phase it belonged to. The published
 * estimator is now the one the live pill uses (docs/METRICS_SPEC.md §8.2): the mass of
 * the **current phase episode** divided by the wall time since that episode began —
 *
 *     tps(t) = Math.round(mass(samples of the episode at or before t) * 1000
 *                         / (t - firstSampleOfThatEpisode))
 *
 * An episode is the maximal run of consecutive same-phase samples, so a phase change
 * opens a new episode and resets both the clock and the numerator; a silence inside one
 * episode freezes the numerator while the denominator advances, which draws the stall
 * as a continuous hyperbolic decay that never reaches exactly zero; and the terminal
 * episode runs from its last generated delta to the attempt's settlement instant, so
 * that tail is drawn as well. `DEFAULT_WINDOW_MS` and `totalRollingTpsSeries` no longer
 * exist anywhere in the rate path.
 *
 * ## The grid and the two caps this file freezes
 *
 *   - the vertex grid is the attempt's own 100 ms ladder (`DEFAULT_SAMPLE_EVERY_MS`),
 *     from its local zero to its own end instant, with that end instant appended when
 *     it does not fall on the ladder;
 *   - the published series holds at most 200 points (`MAX_SERIES_POINTS`). A series at
 *     or below the cap is returned unchanged — a copy of the array, the same objects;
 *     a longer one is resampled to **exactly** 200 points evenly spaced in time across
 *     the full span, each target taking the nearest raw sample (ties resolve to the
 *     earlier one) with no interpolation and no averaging;
 *   - `peakTps` is the maximum of the **published** series, exactly as MiMo's own peak
 *     is the maximum of its published series, and no clamp exists in the rate path: a
 *     rate above MiMo's Ultra `200 <= TPS <= 1564` visibility gate survives intact.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as curveModule from '../src/core/curve.js'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { compressAttempts } from '../src/core/time-axis.js'
import {
  DEFAULT_SAMPLE_EVERY_MS,
  MAX_SERIES_POINTS,
  attemptTrace,
  attemptTraces,
  capSeriesPoints,
  cumulativePhaseTpsSeries,
  peakTps,
} from '../src/core/curve.js'

const outputChunk = text => ({ type: 'text-delta', index: 0, text })

/** A 400-character Latin delta weighs 100 estimated tokens (`heuristicTokenWeight`). */
const deltaOf = chars => outputChunk('x'.repeat(chars))

// ---------------------------------------------------------------------------
// 1. The vertex grid and the episode statistic
// ---------------------------------------------------------------------------

test('vertices sit on the 100 ms ladder, with the attempt end appended when it is off-ladder', () => {
  assert.equal(DEFAULT_SAMPLE_EVERY_MS, 100)

  /**
   * Two 100-token deltas, at 0 ms and at 550 ms, one episode. The ladder stops at the
   * last whole step inside the bound (500 ms) and the attempt's own end instant (550 ms)
   * is appended because it does not fall on the ladder.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 550, phase: 'output', tokens: 100 },
  ], { durationMs: 550 })

  assert.deepEqual(points.map(point => point.localMs), [0, 100, 200, 300, 400, 500, 550])
  assert.deepEqual(points.map(point => point.tps), [0, 1000, 500, 333, 250, 200, 364])
  assert.deepEqual(points.map(point => point.timeMs), [0, 100, 200, 300, 400, 500, 550],
    'without an offset the emitted instant is the local one')

  /**
   * An end instant already on the ladder is not emitted twice: deduplication keeps the
   * grid a grid.
   */
  const onLadder = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 500, phase: 'output', tokens: 100 },
  ], { durationMs: 500 })
  assert.deepEqual(onLadder.map(point => point.localMs), [0, 100, 200, 300, 400, 500])
  assert.deepEqual(onLadder.map(point => point.tps), [0, 1000, 500, 333, 250, 400])
})

test('a phase transition opens a new episode: its clock and its numerator both reset', () => {
  /**
   * One reasoning delta at 0 ms, two output deltas at 500 ms and 600 ms. The output
   * episode owns only its own two deltas and only the time since 500 ms.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 500, phase: 'output', tokens: 100 },
    { activeTimeMs: 600, phase: 'output', tokens: 100 },
  ], { durationMs: 600 })

  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 1000], [200, 500], [300, 333], [400, 250],
    [500, 0], [600, 2000],
  ])
  assert.deepEqual(points.map(point => point.activePhase),
    ['reasoning', 'reasoning', 'reasoning', 'reasoning', 'reasoning', 'output', 'output'])

  /**
   * The decisive pair. At the seam the new episode opens with `elapsed == 0`, so the
   * vertex is `0` — the anchor, not a measurement. One ladder step later the output
   * episode publishes its own cumulative average: its two 100-token deltas over the
   * 100 ms since it opened, `200 * 1000 / 100 = 2000`. An estimator that carried the
   * reasoning episode's mass or clock across the transition cannot produce that number:
   * a bridged numerator would read `300 * 1000 / 600 = 500` at this vertex.
   */
  assert.equal(points[5].tps, 0)
  assert.equal(points[6].tps, Math.round(200 * 1000 / (600 - 500)))
  assert.equal(points[6].tps, 2000)
})

test('a stall decays hyperbolically: the numerator freezes while the denominator advances', () => {
  /**
   * One 100-token delta at 0 ms, the next at 3000 ms, the same phase throughout — a
   * three-second silence inside one episode. Every vertex of the silence measures the
   * same frozen 100 tokens against an advancing clock: `round(100000 / t)`.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 3000, phase: 'output', tokens: 100 },
  ], { durationMs: 3000 })

  assert.equal(points.length, 31, 'the 100 ms ladder spans 0 to 3000 inclusive')
  const stall = points.filter(point => point.localMs >= 100 && point.localMs <= 2900)
  assert.equal(stall.length, 29)

  assert.equal(points.find(point => point.localMs === 100).tps, 1000)
  assert.equal(points.find(point => point.localMs === 1000).tps, 100)
  assert.equal(points.find(point => point.localMs === 2000).tps, 50)
  assert.equal(points.find(point => point.localMs === 2900).tps, 34)

  for (const point of stall) {
    assert.ok(point.tps > 0,
      `a stall never reaches exactly zero; the vertex at ${point.localMs} ms reads ${point.tps}`)
    assert.ok(Math.abs(point.tps - 100000 / point.localMs) <= 0.5,
      `the vertex at ${point.localMs} ms must be the frozen 100-token numerator over the advancing clock`)
  }
  for (let index = 1; index < stall.length; index += 1) {
    assert.ok(stall[index].tps < stall[index - 1].tps,
      'the decay is strictly monotone while the numerator is frozen')
  }

  /**
   * The only zero in the whole trace is the episode's opening anchor; the resumed
   * delta re-opens the numerator at the frozen mass plus its own 100 tokens.
   */
  assert.deepEqual(points.filter(point => point.tps === 0).map(point => point.localMs), [0])
  assert.equal(points.at(-1).localMs, 3000)
  assert.equal(points.at(-1).tps, Math.round(200 * 1000 / 3000))
  assert.equal(points.at(-1).tps, 67)
})

test('each attempt owns its episode clock: the trace resets at the attempt boundary', () => {
  const attempts = [
    { attemptId: 'a', settledAtMs: 50, samples: [{ timeMs: 0, phase: 'output', tokens: 100 }] },
    { attemptId: 'b', settledAtMs: 1100, samples: [{ timeMs: 1000, phase: 'output', tokens: 100 }] },
  ]
  const compressed = compressAttempts(attempts)
  assert.deepEqual(compressed.samples.map(sample => sample.attemptTimeMs), [0, 0],
    'every attempt\'s local clock starts at its own first delta')
  assert.deepEqual(compressed.segments.map(segment => [segment.startMs, segment.endMs]), [[0, 50], [50, 150]])

  const traces = attemptTraces(compressed.segments, compressed.samples, { sampleEveryMs: 100 })
  assert.deepEqual(traces.map(trace => trace.attemptId), ['a', 'b'])
  assert.deepEqual(traces[0].points.map(point => [point.localMs, point.tps]), [[0, 0], [50, 2000]])
  assert.deepEqual(traces[1].points.map(point => [point.localMs, point.tps]), [[0, 0], [100, 1000]])
  assert.deepEqual(traces[1].points.map(point => point.timeMs), [50, 150],
    'the trace is measured on the attempt\'s own clock and only then relabelled onto the compressed axis')
  assert.deepEqual(traces[1].points.map(point => point.activePhase), ['output', 'output'])

  /**
   * Attempt B's trace is exactly the trace of the same attempt measured alone. A bridged
   * episode would have read `round(200 * 1000 / 150) = 1333` at B's closing vertex,
   * crediting B with attempt A's tokens and attempt A's clock.
   */
  const lone = compressAttempts([attempts[1]])
  const loneTraces = attemptTraces(lone.segments, lone.samples, { sampleEveryMs: 100 })
  assert.deepEqual(
    traces[1].points.map(point => [point.localMs, point.tps]),
    loneTraces[0].points.map(point => [point.localMs, point.tps]),
    'no sample of attempt A enters attempt B\'s episode',
  )
  assert.equal(traces[1].tokens, 100, 'and B\'s trace carries only B\'s tokens')
  assert.deepEqual(traces[1].samples.map(sample => sample.attemptId), ['b'])
})

test('the terminal tail is drawn from the last delta to the settlement instant', () => {
  const settledTail = (settledAtMs) => {
    const store = new TurnTelemetryStore()
    const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
    const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
    store.acceptChunk(record, attempt, { timeMs: 0, chunk: deltaOf(400) })
    store.settleAttempt(attempt, settledAtMs === null
      ? { settlementKind: 'attempt', surfaceCommitted: false, attemptOutcome: 'unknown' }
      : {
        settledAtMs,
        settlementKind: 'message',
        surfaceCommitted: true,
        attemptOutcome: 'committed',
      })
    return store.endTurn(record, { timeMs: 500, status: 'completed' }).curve
  }

  /**
   * One 100-token delta at 0 ms, settled at 250 ms. The terminal episode extends from
   * the delta to the settlement instant, so the trace is drawn across the tail: the
   * numerator is frozen at 100 tokens while the clock advances to 250.
   */
  const curve = settledTail(250)
  assert.equal(curve.durationMs, 250)
  assert.equal(curve.segments[0].endMs, 250)
  const points = curve.attempts[0].points
  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 1000], [200, 500], [250, 400],
  ])
  assert.equal(points.at(-1).localMs, 250,
    'the trace is drawn to the settlement instant, past the last generated delta')
  assert.equal(points.at(-1).tps, Math.round(100 * 1000 / 250))
  assert.equal(points.at(-1).tps, 400)

  /**
   * The contrast: without a settlement the attempt has zero width and the trace is its
   * opening vertex alone. The tail is not invented — it is the settlement's own clock.
   */
  const bare = settledTail(null)
  assert.equal(bare.durationMs, 0)
  assert.deepEqual(bare.attempts[0].points.map(point => [point.localMs, point.tps]), [[0, 0]])
})

// ---------------------------------------------------------------------------
// 2. The published-series cap
// ---------------------------------------------------------------------------

test('a series of at most 200 points is returned unchanged: a copy of the same objects', () => {
  assert.equal(MAX_SERIES_POINTS, 200)

  const series = [
    { timeMs: 0, tps: 10 },
    { timeMs: 50, tps: 20 },
    { timeMs: 120, tps: 30 },
  ]
  const capped = capSeriesPoints(series, 200)
  assert.notStrictEqual(capped, series, 'the cap returns a copy rather than the caller\'s array')
  assert.equal(capped.length, 3)
  for (let index = 0; index < series.length; index += 1) {
    assert.strictEqual(capped[index], series[index], 'the cap reuses the source objects, it never rewrites them')
  }

  const exactlyAtCap = Array.from({ length: 200 }, (_, index) => ({ timeMs: index * 100, tps: index }))
  const untouched = capSeriesPoints(exactlyAtCap, 200)
  assert.equal(untouched.length, 200)
  for (let index = 0; index < 200; index += 1) assert.strictEqual(untouched[index], exactlyAtCap[index])

  assert.deepEqual(capSeriesPoints(series).map(point => point.tps), [10, 20, 30],
    'the default cap is MAX_SERIES_POINTS')
})

test('a longer series is resampled to exactly 200 points, each the nearest raw sample', () => {
  /**
   * 250 raw samples at 10 ms spacing, capped to 200. The targets are the 200 evenly
   * spaced instants `0 + 2490 * k / 199`; the nearest sample to a target `t` among the
   * multiples of 10 is `10 * round(t / 10)`, and no target of this fixture falls exactly
   * halfway between two samples, so the tie-to-earlier rule is not exercised here (the
   * next test exercises it directly).
   */
  const series = Array.from({ length: 250 }, (_, index) => ({ timeMs: index * 10, tps: index }))
  const capped = capSeriesPoints(series, 200)
  assert.equal(capped.length, 200)

  const first = series[0].timeMs
  const last = series[series.length - 1].timeMs
  for (let index = 0; index < 200; index += 1) {
    const target = first + (last - first) * index / 199
    assert.strictEqual(capped[index], series[Math.round(target / 10)],
      `target ${target} ms must take the nearest raw sample`)
  }

  /** Specific expected source samples, computed by hand from the same targets. */
  assert.strictEqual(capped[0], series[0])
  assert.strictEqual(capped[1], series[1], 'target 12.51 ms: 10 ms is nearer than 20 ms')
  assert.strictEqual(capped[2], series[3], 'target 25.03 ms: 30 ms is nearer than 20 ms')
  assert.strictEqual(capped[100], series[125], 'target 1251.26 ms: 1250 ms is nearer than 1260 ms')
  assert.strictEqual(capped[198], series[248], 'target 2477.49 ms: 2480 ms is nearer than 2470 ms')
  assert.strictEqual(capped[199], series[249], 'the last target is the last sample')

  for (let index = 1; index < capped.length; index += 1) {
    assert.ok(capped[index].timeMs >= capped[index - 1].timeMs, 'the resampled series ascends in time')
  }
})

test('resampling resolves a tie to the earlier sample and never interpolates', () => {
  /** Four samples at 0/10/20/30 ms, three targets at 0/15/30: 15 ms is exactly between two samples. */
  const tie = [{ timeMs: 0 }, { timeMs: 10 }, { timeMs: 20 }, { timeMs: 30 }]
  const capped = capSeriesPoints(tie, 3)
  assert.equal(capped.length, 3)
  assert.strictEqual(capped[0], tie[0])
  assert.strictEqual(capped[1], tie[1], 'the target at 15 ms resolves to the earlier of 10 ms and 20 ms')
  assert.strictEqual(capped[2], tie[3])
  assert.deepEqual(capped.map(point => point.timeMs), [0, 10, 30])

  /**
   * A sample may be selected twice when two targets fall closest to it: the targets at
   * 66.67 ms and 100 ms both take the 100 ms sample, which is what "nearest raw sample,
   * no interpolation" means at the dense end of a sparse series.
   */
  const clustered = [0, 1, 2, 3, 4, 5, 100].map(timeMs => ({ timeMs }))
  const picked = capSeriesPoints(clustered, 4)
  assert.deepEqual(picked.map(point => point.timeMs), [0, 5, 100, 100])
  assert.strictEqual(picked[0], clustered[0])
  assert.strictEqual(picked[1], clustered[5])
  assert.strictEqual(picked[2], clustered[6])
  assert.strictEqual(picked[3], clustered[6])

  /** No interpolation: every returned point is one of the input objects, not a new one. */
  const sources = new Set(clustered)
  for (const point of picked) {
    assert.ok(sources.has(point), 'the resampled series holds source objects, never interpolated ones')
  }
})

test('a trace whose grid exceeds the cap publishes exactly 200 nearest-neighbour points', () => {
  /**
   * One 100-token delta at local 0 and a settlement tail of 20 s, so the raw grid is the
   * 201 instants `0, 100, …, 20000` and the cap must thin it. The frozen numerator keeps
   * every raw value at `round(100000 / t)` for `t > 0`, which is the independent
   * re-derivation used below.
   */
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 20000 }, [
    { attemptId: 'a', attemptTimeMs: 0, activeTimeMs: 0, phase: 'output', tokens: 100 },
  ])
  assert.equal(trace.points.length, 200)

  assert.deepEqual([trace.points[0].localMs, trace.points[0].tps], [0, 0])
  assert.deepEqual([trace.points.at(-1).localMs, trace.points.at(-1).tps], [20000, 5])

  for (let index = 0; index < 200; index += 1) {
    const expected = 100 * Math.round(200 * index / 199)
    assert.equal(trace.points[index].localMs, expected,
      `target ${20000 * index / 199} ms must take the nearest raw ladder instant`)
    if (trace.points[index].localMs > 0) {
      assert.equal(trace.points[index].tps, Math.round(100 * 1000 / trace.points[index].localMs))
    }
  }
  assert.ok(trace.points.every(point => point.localMs % 100 === 0),
    'every published vertex is a raw ladder instant, never an interpolated one')
})

// ---------------------------------------------------------------------------
// 3. The published peak
// ---------------------------------------------------------------------------

test('rates above 1564 are published unclamped', () => {
  /**
   * One 2000-token delta at local 0 against a 1 s tail: the whole episode is far above
   * MiMo Ultra's `200 <= TPS <= 1564` visibility gate, so any clamp in the rate path
   * would be visible as a capped value.
   */
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 1000 }, [
    { attemptId: 'a', attemptTimeMs: 0, activeTimeMs: 0, phase: 'output', tokens: 2000 },
  ])
  assert.deepEqual(trace.points.map(point => point.tps),
    [0, 20000, 10000, 6667, 5000, 4000, 3333, 2857, 2500, 2222, 2000])
  assert.equal(trace.points.at(-1).tps, 2000, 'the sustained value is 2000, not a clamped 1564')
  assert.ok(trace.points.slice(1).every(point => point.tps > 1564),
    'every measured vertex of the episode exceeds the Ultra visibility gate')
  assert.equal(peakTps(trace.points), 20000)
})

test('the published peak is the maximum of the published series', () => {
  const seriesA = [{ timeMs: 0, tps: 10 }, { timeMs: 100, tps: 900 }]
  const seriesB = [{ timeMs: 0, tps: 30 }, { timeMs: 100, tps: 700 }]

  assert.equal(peakTps(seriesA, seriesB), 900)
  assert.equal(peakTps(seriesA, seriesB), Math.max(...[...seriesA, ...seriesB].map(point => point.tps)))
  assert.equal(peakTps(), 0, 'no series is a peak of zero, not a failure')
  assert.equal(peakTps([], undefined, seriesB), 700, 'and non-series arguments are skipped')
})

test('the peak is read from the published series, not from a raw series the cap thinned', () => {
  /**
   * MiMo's `peakTps` is the maximum of its **published** series, and this project's is
   * the maximum of the capped series for the same reason: a value the resampling skips
   * is a value the card does not report. The spike below sits at 1 ms, which is never
   * the nearest sample of any target, so the published peak is the flat 1 tokens/s.
   */
  const raw = Array.from({ length: 300 }, (_, index) => ({ timeMs: index, tps: 1 }))
  raw[1] = { timeMs: 1, tps: 9999 }
  const published = capSeriesPoints(raw, 200)

  assert.equal(published.length, 200)
  assert.ok(!published.includes(raw[1]), 'the 1 ms spike is not among the nearest-neighbour selections')
  assert.equal(Math.max(...raw.map(point => point.tps)), 9999, 'the raw spike really exists')
  assert.equal(peakTps(published), 1)
  assert.equal(peakTps(published), Math.max(...published.map(point => point.tps)))
})

test('the trailing-window statistic no longer exists in the module', () => {
  assert.ok(!('DEFAULT_WINDOW_MS' in curveModule), 'DEFAULT_WINDOW_MS was removed in Phase 9.2')
  assert.ok(!('totalRollingTpsSeries' in curveModule), 'totalRollingTpsSeries was removed in Phase 9.2')
})
