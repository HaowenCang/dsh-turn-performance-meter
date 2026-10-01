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
 * that tail is drawn as well. A vertex that is not a measurement — an episode whose own
 * clock has not advanced, or which holds fewer than three deltas — publishes `tps: null`
 * rather than a fabricated zero, so the estimator above is stated only where it applies.
 * `DEFAULT_WINDOW_MS` and `totalRollingTpsSeries` no longer exist anywhere in the rate
 * path.
 *
 * ## The grid, the publication gate and the two caps this file freezes
 *
 *   - the vertex grid is **each episode's own** 100 ms ladder (`DEFAULT_SAMPLE_EVERY_MS`),
 *     from that episode's own origin to the instant the next episode opens — or to the
 *     attempt's own end instant, for the terminal episode — with the end instant appended
 *     when it does not fall on the ladder. An episode opening at 250 ms is therefore
 *     sampled at 250, 350, 450, …, and the attempt-global grid that used to put a vertex
 *     at 300 ms no longer exists (`test/curve-rate-publication.test.js` freezes why: that
 *     50 ms denominator was published as a rate);
 *   - **a vertex is a measurement only when the shared publication policy admits it**
 *     (`src/core/rate-publication.js`): at least `MIN_RATE_SAMPLES` contributing samples
 *     *and* at least `MIN_RATE_ELAPSED_MS` of the episode's own clock. Every other vertex
 *     carries `tps: null` — never a fabricated `0` — with the episode facts that explain
 *     the refusal. A publishable rate is `Math.round(mass * 1000 / elapsed)`, unclamped;
 *   - `peakTps` is the maximum over the **publishable** points of the published series,
 *     exactly as MiMo's own peak is the maximum of its published series, and it is `null`
 *     when no point is publishable. No clamp exists in the rate path: a rate above MiMo's
 *     Ultra `200 <= TPS <= 1564` visibility gate survives intact;
 *   - the published series holds at most 200 points (`MAX_SERIES_POINTS`). A series at
 *     or below the cap is returned unchanged — a copy of the array, the same objects;
 *     a longer one is resampled to **exactly** 200 points evenly spaced in time across
 *     the full span, each target taking the nearest raw sample (ties resolve to the
 *     earlier one) with no interpolation and no averaging.
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
   * Four 100-token deltas — at 0, 120, 250 and 550 ms — inside **one** episode whose own
   * ladder therefore runs `0, 100, 200, …` from its own origin at 0 ms, while the attempt
   * ends at 660 ms, off the ladder. Ladder instants are not sample instants: 200 ms is a
   * vertex with only two deltas in force, and 600 ms is one that holds the whole episode.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 120, phase: 'output', tokens: 100 },
    { activeTimeMs: 250, phase: 'output', tokens: 100 },
    { activeTimeMs: 550, phase: 'output', tokens: 100 },
  ], { durationMs: 660, sampleEndMs: 660 })

  assert.deepEqual(points.map(point => point.localMs), [0, 100, 200, 300, 400, 500, 600, 660])
  assert.deepEqual(points.map(point => point.timeMs), [0, 100, 200, 300, 400, 500, 600, 660],
    'without an offset the emitted instant is the local one')

  /**
   * The episode's mass is frozen between deltas while its clock advances, so a vertex
   * measures `mass * 1000 / elapsed` with the mass that had arrived by that instant. The
   * episode is below the gates for its first two ladder points: at 0 ms there is no
   * elapsed clock at all, and at 100 ms one sample is not a rate, so both publish nothing
   * rather than a fabricated zero.
   */
  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, null],
    [100, null],
    [200, null],                            // below the sample gate: two deltas in force
    [300, Math.round(300 * 1000 / 300)],    // three deltas in force: 300 tokens over 300 ms
    [400, Math.round(300 * 1000 / 400)],    // frozen: 300 tokens over 400 ms
    [500, Math.round(300 * 1000 / 500)],    // frozen: 300 tokens over 500 ms
    [600, Math.round(400 * 1000 / 600)],    // the 550 ms delta joins: 400 tokens over 600 ms
    [660, Math.round(400 * 1000 / 660)],    // and dilutes to the attempt's own end instant
  ])
  assert.deepEqual(points.map(point => point.tps), [null, null, null, 1000, 750, 600, 667, 606])
  assert.equal(points.at(-1).localMs, 660,
    'the off-ladder end instant is a vertex of its own')
  assert.deepEqual(points.map(point => point.publishable), [false, false, false, true, true, true, true, true],
    'the gates admit the episode from its third delta and its third full ladder step')

  /**
   * An end instant already on the ladder is not emitted twice: deduplication keeps the
   * grid a grid, and the vertex that ends the attempt is the same object as the descent's
   * own last ladder point — here the 500 ms instant, which is both the settlement and the
   * fifth step of the episode's own ladder.
   */
  const onLadder = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 150, phase: 'output', tokens: 100 },
    { activeTimeMs: 250, phase: 'output', tokens: 100 },
    { activeTimeMs: 500, phase: 'output', tokens: 100 },
  ], { durationMs: 500, sampleEndMs: 500 })
  assert.deepEqual(onLadder.map(point => point.localMs), [0, 100, 200, 300, 400, 500])
  assert.equal(onLadder.filter(point => point.localMs === 500).length, 1,
    'the on-ladder end instant is emitted once, not appended after itself')
  assert.deepEqual(onLadder.map(point => point.tps), [null, null, null, 1000, 750, 800],
    'and the endpoint publishes the whole episode: 400 tokens over its own 500 ms')
})

test('a phase transition opens a new episode: its clock and its numerator both reset', () => {
  /**
   * Three reasoning deltas at 0, 100 and 400 ms, then three output deltas at 500, 550 and
   * 600 ms. The output episode owns only its own three deltas and only the time since
   * 500 ms, and it is sampled on **its own** ladder from its own origin.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 100, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 400, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 500, phase: 'output', tokens: 100 },
    { activeTimeMs: 550, phase: 'output', tokens: 100 },
    { activeTimeMs: 600, phase: 'output', tokens: 100 },
  ], { durationMs: 600 })

  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, null], [300, null], [400, 750],
    [500, null], [600, 3000],
  ])
  assert.deepEqual(points.map(point => point.activePhase),
    ['reasoning', 'reasoning', 'reasoning', 'reasoning', 'reasoning', 'output', 'output'])

  /**
   * The decisive pair. The reasoning episode holds only two of its three deltas for the
   * whole first 300 ms of its ladder, so those vertices are below the sample gate and
   * publish nothing; its third delta admits it at 400 ms with `round(300 * 1000 / 400)`.
   *
   * At the seam the output episode opens with `elapsed == 0`, so the vertex publishes
   * **nothing** — `null`, with `rateUnavailableReason` naming the opening anchor, where
   * the old anchor published a measured zero. One ladder step later the episode's own
   * evidence is a rate: three 100-token deltas over the 100 ms since it opened,
   * `300 * 1000 / 100 = 3000`. An estimator that carried the reasoning episode's mass or
   * clock across the transition cannot produce that number: a bridged numerator would
   * read `600 * 1000 / 600 = 1000` at this vertex.
   */
  assert.equal(points[5].tps, null)
  assert.equal(points[5].rateUnavailableReason, 'opening-anchor')
  assert.equal(points[5].episodeStartMs, 500, 'the output episode owns the seam as its own origin')
  assert.equal(points[6].tps, Math.round(300 * 1000 / (600 - 500)))
  assert.equal(points[6].tps, 3000)
})

test('a stall decays hyperbolically: the numerator freezes while the denominator advances', () => {
  /**
   * Three 100-token deltas — at 0, 50 and 150 ms — and then nothing for the rest of the
   * episode: the last delta at 150 ms opens a 2850 ms silence in the same phase, drawn to
   * the attempt's end at 3000 ms. The frozen numerator is the 300 tokens that had arrived
   * by 150 ms, and every vertex from 200 ms on measures it against an advancing clock:
   * `round(300000 / t)`.
   *
   * The warm-up is part of the scenario rather than an inconvenience: had the third delta
   * arrived after the silence, the episode would be below the sample gate at every vertex
   * of the stall and the hyperbola this test exists for would be withheld rather than
   * drawn. Two vertices below the gate survive at the start — the opening anchor and the
   * vertex at 100 ms held by only two samples.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 50, phase: 'output', tokens: 100 },
    { activeTimeMs: 150, phase: 'output', tokens: 100 },
  ], { durationMs: 3000, sampleEndMs: 3000 })

  assert.equal(points.length, 31, 'the 100 ms ladder spans 0 to 3000 inclusive')
  const stall = points.filter(point => point.localMs >= 200 && point.localMs <= 2900)
  assert.equal(stall.length, 28)

  assert.equal(points.find(point => point.localMs === 200).tps, 1500)
  assert.equal(points.find(point => point.localMs === 1000).tps, 300)
  assert.equal(points.find(point => point.localMs === 2000).tps, 150)
  assert.equal(points.find(point => point.localMs === 2900).tps, 103)

  for (const point of stall) {
    assert.ok(point.tps > 0,
      `a stall never reaches exactly zero; the vertex at ${point.localMs} ms reads ${point.tps}`)
    assert.ok(Math.abs(point.tps - 300000 / point.localMs) <= 0.5,
      `the vertex at ${point.localMs} ms must be the frozen 300-token numerator over the advancing clock`)
  }
  for (let index = 1; index < stall.length; index += 1) {
    assert.ok(stall[index].tps < stall[index - 1].tps,
      'the decay is strictly monotone while the numerator is frozen')
  }

  /**
   * The stall holds no zero at all: every vertex of it is publishable, and the two
   * vertices the gates do withhold — the opening anchor and the below-warm-up vertex at
   * 100 ms — carry `null` rather than a fabricated `0`.
   */
  assert.deepEqual(points.filter(point => point.tps === 0).map(point => point.localMs), [])
  assert.deepEqual(points.filter(point => !point.publishable).map(point => [point.localMs, point.rateUnavailableReason]), [
    [0, 'opening-anchor'],
    [100, 'below-sample-warmup'],
  ])
  assert.equal(points.at(-1).localMs, 3000)
  assert.equal(points.at(-1).tps, Math.round(300 * 1000 / 3000))
  assert.equal(points.at(-1).tps, 100)
})

test('each attempt owns its episode clock: the trace resets at the attempt boundary', () => {
  const attempts = [
    {
      attemptId: 'a',
      settledAtMs: 50,
      samples: [
        { timeMs: 0, phase: 'output', tokens: 100 },
        { timeMs: 20, phase: 'output', tokens: 100 },
        { timeMs: 40, phase: 'output', tokens: 100 },
      ],
    },
    {
      attemptId: 'b',
      settledAtMs: 1100,
      samples: [
        { timeMs: 1000, phase: 'output', tokens: 100 },
        { timeMs: 1050, phase: 'output', tokens: 100 },
        { timeMs: 1100, phase: 'output', tokens: 100 },
      ],
    },
  ]
  const compressed = compressAttempts(attempts)
  assert.deepEqual(compressed.samples.map(sample => sample.attemptTimeMs), [0, 20, 40, 0, 50, 100],
    'every attempt\'s local clock starts at its own first delta')
  assert.deepEqual(compressed.segments.map(segment => [segment.startMs, segment.endMs]), [[0, 50], [50, 150]])

  const traces = attemptTraces(compressed.segments, compressed.samples, { sampleEveryMs: 100 })
  assert.deepEqual(traces.map(trace => trace.attemptId), ['a', 'b'])
  /**
   * Attempt A owns only two tenths of a second, so nothing inside it passes the elapsed
   * gate even though its three deltas satisfy the sample gate — its whole trace is
   * withheld. That is the fact the next assertion rests on: attempt B's closing vertex
   * would have read far higher had A's tokens reached it.
   */
  assert.deepEqual(traces[0].points.map(point => [point.localMs, point.tps]), [[0, null], [50, null]])
  assert.equal(traces[0].points.at(-1).episodeSampleCount, 3,
    'the gate that refuses A is its elapsed clock, not its sample count')
  assert.equal(traces[0].points.at(-1).rateUnavailableReason, 'below-elapsed-horizon')
  for (const point of traces[0].points) assert.equal(point.publishable, false)
  assert.deepEqual(traces[1].points.map(point => [point.localMs, point.tps]), [[0, null], [100, 3000]])
  assert.deepEqual(traces[1].points.map(point => point.timeMs), [50, 150],
    'the trace is measured on the attempt\'s own clock and only then relabelled onto the compressed axis')
  assert.deepEqual(traces[1].points.map(point => point.activePhase), ['output', 'output'])
  assert.equal(traces[1].points.at(-1).tps, Math.round(300 * 1000 / 100),
    'B\'s own three deltas over B\'s own first 100 ms')

  /**
   * Attempt B's trace is exactly the trace of the same attempt measured alone. A bridged
   * episode would have read `round(600 * 1000 / 150) = 4000` at B's closing vertex,
   * crediting B with attempt A's tokens and attempt A's clock.
   */
  const lone = compressAttempts([attempts[1]])
  const loneTraces = attemptTraces(lone.segments, lone.samples, { sampleEveryMs: 100 })
  assert.deepEqual(
    traces[1].points.map(point => [point.localMs, point.tps]),
    loneTraces[0].points.map(point => [point.localMs, point.tps]),
    'no sample of attempt A enters attempt B\'s episode',
  )
  assert.equal(traces[1].tokens, 300, 'and B\'s trace carries only B\'s tokens')
  assert.deepEqual(traces[1].samples.map(sample => sample.attemptId), ['b', 'b', 'b'],
    'every sample B\'s trace holds belongs to B')
})

test('the terminal tail is drawn from the last delta to the settlement instant', () => {
  const settledTail = (settledAtMs) => {
    const store = new TurnTelemetryStore()
    const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
    const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
    for (const at of [0, 100, 150]) store.acceptChunk(record, attempt, { timeMs: at, chunk: deltaOf(400) })
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
   * Three 100-token deltas — at 0, 100 and 150 ms — and a settlement at 250 ms. The
   * terminal episode extends from its last delta to the settlement instant, so the trace
   * is drawn across the tail: the numerator freezes at 300 tokens while the clock
   * advances past the instant the model last produced anything.
   */
  const curve = settledTail(250)
  assert.equal(curve.durationMs, 250)
  assert.equal(curve.segments[0].endMs, 250)
  const points = curve.attempts[0].points
  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, null],
    [100, null],
    [200, Math.round(300 * 1000 / 200)],
    [250, Math.round(300 * 1000 / 250)],
  ])
  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, 1500], [250, 1200],
  ])
  assert.equal(points.at(-1).localMs, 250,
    'the trace is drawn to the settlement instant, past the last generated delta')
  assert.equal(points.at(-1).tps, Math.round(300 * 1000 / 250))
  assert.equal(points.at(-1).tps, 1200)
  assert.ok(points.at(-1).tps < points[2].tps,
    'and the tail decays: the frozen numerator divides by a larger denominator')

  /**
   * The contrast: without a settlement the attempt owns no time past its last delta, so
   * the trace closes on the 150 ms instant that delta arrived at, and the 250 ms tail of
   * the settled curve is not invented. The tail is not a drawing convention — it is the
   * settlement's own clock. The closing vertex is a measurement, and the two before it
   * are withheld by the gates.
   */
  const bare = settledTail(null)
  assert.equal(bare.durationMs, 150, 'an unsettled attempt ends on its last delta')
  assert.deepEqual(bare.attempts[0].points.map(point => [point.localMs, point.tps]),
    [[0, null], [100, null], [150, Math.round(300 * 1000 / 150)]])
  assert.equal(bare.attempts[0].points.at(-1).tps, 2000)
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
   * Three 100-token deltas at local 0, 100 and 200 ms and a settlement tail of 20 s, so
   * the one episode's own ladder is the 201 instants `0, 100, …, 20000` and the cap must
   * thin it. The episode passes both gates from its third delta on, so from 200 ms every
   * raw value is the frozen 300 tokens over the advancing clock — `round(300000 / t)`,
   * the independent re-derivation used below; the two vertices before it publish nothing.
   */
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 20000 }, [
    { attemptId: 'a', attemptTimeMs: 0, activeTimeMs: 0, phase: 'output', tokens: 100 },
    { attemptId: 'a', attemptTimeMs: 100, activeTimeMs: 100, phase: 'output', tokens: 100 },
    { attemptId: 'a', attemptTimeMs: 200, activeTimeMs: 200, phase: 'output', tokens: 100 },
  ])
  assert.equal(trace.points.length, 200)

  assert.deepEqual([trace.points[0].localMs, trace.points[0].tps], [0, null],
    'the opening anchor is not a measurement, so it is not a zero either')
  assert.deepEqual([trace.points.at(-1).localMs, trace.points.at(-1).tps], [20000, 15])

  for (let index = 0; index < 200; index += 1) {
    const expected = 100 * Math.round(200 * index / 199)
    assert.equal(trace.points[index].localMs, expected,
      `target ${20000 * index / 199} ms must take the nearest raw ladder instant`)
    if (trace.points[index].localMs >= 200) {
      assert.equal(trace.points[index].tps, Math.round(300 * 1000 / trace.points[index].localMs))
    } else {
      assert.equal(trace.points[index].tps, null,
        'before its third delta the episode is below the sample gate at every vertex')
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
   * Three 2000-token deltas — at 0, 100 and 150 ms — against a 1 s end instant: the whole
   * publishable episode sits at or above MiMo Ultra's `200 <= TPS <= 1564` visibility
   * gate's ceiling, so any clamp in the rate path would be visible as a capped value. The
   * first two vertices are withheld, and the first publishable vertex lands exactly on
   * 1564, which the strict comparison below therefore excludes by rule rather than by
   * accident.
   */
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 1000 }, [
    { attemptId: 'a', attemptTimeMs: 0, activeTimeMs: 0, phase: 'output', tokens: 2000 },
    { attemptId: 'a', attemptTimeMs: 100, activeTimeMs: 100, phase: 'output', tokens: 2000 },
    { attemptId: 'a', attemptTimeMs: 150, activeTimeMs: 150, phase: 'output', tokens: 2000 },
  ])
  assert.deepEqual(trace.points.map(point => point.tps),
    [null, null, 30000, 20000, 15000, 12000, 10000, 8571, 7500, 6667, 6000])
  assert.deepEqual(trace.points.map(point => point.localMs),
    [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
  assert.equal(trace.points[2].tps, Math.round(6000 * 1000 / 200),
    'the episode owns its whole 6000-token mass from its third delta on')
  assert.equal(trace.points.at(-1).tps, Math.round(6000 * 1000 / 1000))
  assert.equal(trace.points.at(-1).tps, 6000, 'the sustained value, not a clamped 1564')
  assert.ok(trace.points.slice(3).every(point => point.tps > 1564),
    'every measured vertex past the 1564 boundary exceeds the Ultra visibility gate')
  assert.equal(peakTps(trace.points), 30000)
})

test('the published peak is the maximum of the published series', () => {
  const seriesA = [{ timeMs: 0, tps: 10 }, { timeMs: 100, tps: 900 }]
  const seriesB = [{ timeMs: 0, tps: 30 }, { timeMs: 100, tps: 700 }]

  assert.equal(peakTps(seriesA, seriesB), 900)
  assert.equal(peakTps(seriesA, seriesB), Math.max(...[...seriesA, ...seriesB].map(point => point.tps)))
  assert.equal(peakTps(), null, 'no series holds no publishable rate, which is not a peak of zero')
  assert.equal(peakTps([], undefined, seriesB), 700, 'and non-series arguments are skipped')
  const withheld = [{ timeMs: 0, tps: null }, { timeMs: 100, tps: null }]
  assert.equal(peakTps(withheld), null,
    'a series whose every vertex is below the gates has no peak, rather than a measured zero')
  assert.equal(peakTps([{ timeMs: 0, tps: null }, { timeMs: 100, tps: 400 }]), 400,
    'and one publishable vertex among withheld ones is the peak')
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
