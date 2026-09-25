/**
 * Cross-attempt rolling-window regression.
 *
 * The compressed curve clock joins attempts end-to-start so that tool waits and
 * next-call TTFT consume no horizontal width. That concatenation is a *coordinate*
 * operation on the x-axis only. The trailing one-second TPS window is a
 * *statistical* operation bound to one model attempt, and the live meter has
 * always reset it at every new attempt (`src/core/live-metrics.js`,
 * `attemptStarted` -> `SlidingWindowMeter.beginAttempt`).
 *
 * The completed curve must agree. Before Phase 6, `settle()` in
 * `src/host/telemetry-design.js` fed the whole concatenated sample list into one
 * call of `rollingTpsSeries`, which filters on `activeTimeMs` and `phase` and
 * never reads `attemptId`. Two consequences followed:
 *
 *   - the opening points of attempt B were computed from a window that still held
 *     attempt A's trailing tokens, so the completed curve credited B with A's
 *     throughput immediately after a tool gap;
 *   - `peakTps` was taken over that bridged series, so the card could report a
 *     peak that no single model call ever reached.
 *
 * `legacyCompletedSeries` below is the old pipeline verbatim, kept as an
 * executable counterexample: it must fail the assertion the corrected pipeline
 * passes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import {
  DEFAULT_SAMPLE_EVERY_MS,
  DEFAULT_WINDOW_MS,
  downsampleSeries,
  peakTps,
  rollingTpsSeries,
} from '../src/core/curve.js'

function outputChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

/**
 * The rejected implementation, kept as an executable counterexample.
 *
 * This is what the shipped code did: concatenate every attempt's samples onto the
 * turn-compressed clock and roll **one** window across the whole list. The window
 * convention below is the verified metric contract — half-open on the left,
 * `(t - windowMs, t]`, as `SlidingWindowMeter` implements and
 * `docs/METRICS_SPEC.md` §8.1 specifies — so this reproduction differs from the
 * corrected pipeline in exactly one respect: its samples are never partitioned by
 * attempt. That isolation is what makes the comparison a measurement of the
 * boundary defect rather than of two different window definitions.
 *
 * The grid is anchored at the attempt's own start with a tail shifted past the
 * last sample, matching `rollingTpsSeries`.
 */
function legacyCompletedSeries(record, phase, windowMs = DEFAULT_WINDOW_MS) {
  const samples = []
  const segments = []
  let offsetMs = 0
  for (const attempt of record.attempts) {
    if (!Array.isArray(attempt.samples) || attempt.samples.length === 0) continue
    const first = attempt.samples[0].timeMs
    const last = attempt.samples[attempt.samples.length - 1].timeMs
    for (const sample of attempt.samples) {
      samples.push({ ...sample, attemptId: attempt.attemptId, activeTimeMs: offsetMs + (sample.timeMs - first) })
    }
    segments.push({ attemptId: attempt.attemptId, startMs: offsetMs, endMs: offsetMs + (last - first) })
    offsetMs += last - first
  }
  const sampleEndMs = offsetMs
  const tailStart = samples.length > 0 ? samples[samples.length - 1].activeTimeMs : 0
  const grid = []
  for (let step = 0; ; step += 1) {
    const at = step * DEFAULT_SAMPLE_EVERY_MS
    if (at > tailStart + 1e-9) break
    grid.push(at)
  }
  for (let step = 1; ; step += 1) {
    const at = tailStart + step * DEFAULT_SAMPLE_EVERY_MS
    if (at > sampleEndMs + windowMs + 1e-9) break
    grid.push(at)
  }
  const ordered = samples.slice().sort((a, b) => a.activeTimeMs - b.activeTimeMs)
  const series = grid.map((t) => {
    let total = 0
    for (const sample of ordered) {
      if (sample.phase !== phase) continue
      if (sample.activeTimeMs <= t && sample.activeTimeMs > t - windowMs) {
        total += sample.tokens ?? sample.weight ?? 0
      }
    }
    return { timeMs: t, tps: total * 1000 / windowMs }
  })
  return { durationMs: offsetMs, segments, series }
}

/**
 * Two attempts, one tool between them, no retry and no error.
 *
 * Attempt A: 100 estimated tokens at its local t=0 and 100 more at its local
 * t=500, then a 60 s tool call. Attempt B: 10 tokens at its local t=0 and 10 more
 * at its local t=500.
 *
 * Both attempts occupy exactly [0, 500] of compressed width, so A spans [0, 500]
 * and B spans [500, 1000] and every sample lands on a 250 ms grid vertex. A's two
 * measurements are half a window apart, so A genuinely reaches 200 tokens/s; B's
 * are also half a window apart, so B reaches 20. The two rates differ by a factor
 * of ten, which is what makes a bridged window unmistakable.
 */
function driveToolSeparatedTurn(store) {
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const a = store.beginAttempt(record, { attemptId: 'attempt-a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, a, { timeMs: 1000, chunk: outputChunk('x'.repeat(400)) })
  store.acceptChunk(record, a, { timeMs: 1500, chunk: outputChunk('x'.repeat(400)) })
  store.settleAttempt(a, {
    settledAtMs: 1550,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  store.toolStarted(record, { callId: 'tool-1', name: 'pwsh', timeMs: 1600 })
  store.toolSettled(record, { callId: 'tool-1', timeMs: 61_600, status: 'ok' })

  const b = store.beginAttempt(record, { attemptId: 'attempt-b', step: 2, startedAtMs: 61_700 })
  store.acceptChunk(record, b, { timeMs: 61_700, chunk: outputChunk('y'.repeat(40)) })
  store.acceptChunk(record, b, { timeMs: 62_200, chunk: outputChunk('y'.repeat(40)) })
  store.settleAttempt(b, {
    settledAtMs: 62_250,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  return { record, settled: store.endTurn(record, { timeMs: 62_500, status: 'completed' }) }
}

test('the completed rolling window is reset at an attempt boundary, not bridged across a tool gap', () => {
  const store = new TurnTelemetryStore()
  const { record, settled } = driveToolSeparatedTurn(store)
  const curve = settled.curve

  /**
   * The counterexample first, because it is the invariant this file exists for.
   *
   * Ground truth for this turn, in compressed coordinates: attempt A's samples sit
   * at 0 and 500 with 100 tokens each, attempt B's at 500 and 1000 with 10 each, so
   * the boundary at 500 is a 250 ms grid vertex that both attempts own part of.
   *
   * The rejected pipeline rolls one window over the concatenated list. At vertex
   * 1000 its window contains A's sample at 500 together with B's samples at 500 and
   * 1000, and it reports 120 tokens/s for an attempt that had produced 20 tokens in
   * total. B never ran at 120; its own ceiling is 20.
   */
  const legacy = legacyCompletedSeries(record, 'output')
  assert.deepEqual(legacy.segments.map(s => [s.startMs, s.endMs]), [[0, 500], [500, 1000]],
    'the old compressed clock was already continuous; only its window was wrong')
  assert.deepEqual(legacy.series.map(p => `${p.timeMs}:${p.tps}`).join(' '),
    '0:100 250:100 500:210 750:210 1000:120 1250:120 1500:10 1750:10 2000:0',
    'the rejected pipeline really does bridge the boundary; this is the regression, not a hypothetical')
  assert.equal(legacy.series.find(p => p.timeMs === 1000).tps, 120,
    'the vertex a half-second into attempt B carries A\'s 100 on top of B\'s own 20')

  // The compressed clock itself is still continuous: B starts where A ended.
  assert.equal(curve.durationMs, 500 + 500, 'tool time and next-call TTFT still consume no width')
  assert.deepEqual(curve.segments.map(s => [s.attemptId, s.startMs, s.endMs]), [
    ['attempt-a', 0, 500],
    ['attempt-b', 500, 1000],
  ])

  /**
   * The corrected curve: per-attempt windows on concatenated coordinates.
   *
   * Each run is sampled on its own 250 ms grid over `(t - 1000, t]` and stops where
   * its own attempt stops, so A covers [0, 500] and B covers [500, 1000]. A's two
   * measurements are half a second apart, so both fit at t=500 and A reads 200
   * tokens/s there; B's are half a second apart too, so B reads 20 at t=1000.
   */
  const output = curve.series.find(series => series.key === 'output')
  assert.deepEqual(output.runs.map(run => run.attemptId), ['attempt-a', 'attempt-b'],
    'one run per attempt, in turn order')

  const [runA, runB] = output.runs
  assert.deepEqual(runA.points.map(p => p.timeMs), [0, 250, 500])
  assert.deepEqual(runA.points.map(p => p.tps), [100, 100, 200],
    'attempt A reads only its own measurements and reaches 200 tokens/s at its own end')

  assert.equal(runB.points[0].timeMs, 500, 'attempt B opens at the shared compressed coordinate')
  assert.deepEqual(runB.points.map(p => p.tps), [10, 10, 20, 20, 10, 10, 0],
    'B climbs on its own evidence alone and never borrows A\'s 100')

  /**
   * The decisive comparison. The two runs meet at one compressed coordinate — A's
   * last vertex and B's first are both at 500 — and they report different numbers
   * computed from different samples: A's own 200 from its two measurements, B's own
   * 10 from the single delta it had produced by then. The rejected pipeline
   * produced one value for that coordinate, 210, for an attempt whose entire output
   * was 20 tokens, and still reported 120 at 1000 against B's honest 20.
   */
  assert.equal(runA.points.at(-1).tps, 200)
  assert.equal(runB.points[0].tps, 10)
  assert.equal(runB.peak, 20)
  assert.equal(runB.points.at(-1).tps, 0,
    'B\'s own decay is drawn, and it is B\'s: the tail is not clamped to a shorter axis')
  assert.equal(legacy.series.find(p => p.timeMs === 500).tps, 210,
    'the bridged pipeline adds the two calls together at the coordinate they share')
  assert.equal(legacy.series.find(p => p.timeMs === 1000).tps, 120,
    'and it is still 100 tokens/s above B\'s own reading one window into the new call')

  assert.equal(curve.peakTps, 200,
    'the turn peak is the max over per-attempt series, never a sum across the boundary')
  assert.equal(runPeak(curve, 'output'), 200)
})

test('no sampling instant carries a rate the owning attempt cannot support', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveToolSeparatedTurn(store)

  /**
   * Independent upper bound. Within one attempt a trailing one-second window can
   * hold at most everything that attempt ever produced, so
   * `tps <= attemptTokens * 1000 / windowMs` must hold at every vertex. Only a
   * window fed by a neighbouring attempt can exceed it.
   */
  for (const series of settled.curve.series) {
    const expectedTotal = series.key === 'output' ? { 'attempt-a': 200, 'attempt-b': 20 } : null
    if (expectedTotal === null) {
      /**
       * This turn contains no reasoning delta at all, so the reasoning series has
       * no run. A phase with no evidence must not be drawn as a flat zero line:
       * "never reasoned here" is not "reasoning throughput fell to zero".
       */
      assert.deepEqual(series.runs, [], 'a phase with no evidence produces no run')
      assert.equal(series.present, false)
      continue
    }
    assert.deepEqual(series.runs.map(run => run.attemptId), ['attempt-a', 'attempt-b'])
    for (const run of series.runs) {
      assert.equal(run.attemptTokens, expectedTotal[run.attemptId],
        `${run.attemptId}/${series.key} reports only its own token total`)
      /** No vertex may claim more than the attempt's whole output in one window. */
      const bound = run.attemptTokens * 1000 / DEFAULT_WINDOW_MS
      for (const point of run.points) {
        assert.ok(point.tps <= bound + 1e-9,
          `${run.attemptId}/${series.key} point ${point.timeMs} claims ${point.tps} tokens/s from at most ${run.attemptTokens} tokens`)
      }
      assert.equal(run.peak, Math.max(...run.points.map(p => p.tps)),
        'a run\'s reported peak is the maximum of its own vertices')
    }
  }
})

test('the bound is broken by the bridged pipeline and respected by the corrected one', () => {
  const store = new TurnTelemetryStore()
  const { record, settled } = driveToolSeparatedTurn(store)

  /**
   * Independent check on the counterexample: attempt B produced 20 tokens in total
   * and its own run lasts half a second, so no honest rate attributed to it can
   * exceed 20 tokens/s. The rejected pipeline's vertex at 1000 is 120.
   */
  const boundB = 20 * 1000 / DEFAULT_WINDOW_MS
  const legacy = legacyCompletedSeries(record, 'output')
  const segments = settled.curve.segments
  const boundaryOfB = segments[1].startMs
  assert.equal(boundaryOfB, 500)
  assert.ok(legacy.series.find(p => p.timeMs === 1000).tps > boundB,
    'the rejected vertex attributed to attempt B exceeds what B produced')

  const runB = settled.curve.series.find(series => series.key === 'output').runs[1]
  for (const point of runB.points) {
    assert.ok(point.tps <= boundB + 1e-9,
      `corrected run ${runB.attemptId} stays within ${boundB} tokens/s at ${point.timeMs}`)
  }
})

test('a retry is a hard window reset for the completed curve too', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  /**
   * The abandoned attempt streams a large prefix, then its replacement streams a
   * small one. They are deliberately the same shape and ten times apart in
   * magnitude, so a window seeded by the abandoned prefix is unmistakable.
   */
  const attempt = store.beginAttempt(record, { attemptId: 'retry-1', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: outputChunk('a'.repeat(800)) })
  store.acceptChunk(record, attempt, { timeMs: 500, chunk: outputChunk('a'.repeat(800)) })
  store.settleAttempt(attempt, {
    settledAtMs: 550,
    settlementKind: 'attempt',
    surfaceCommitted: false,
    attemptOutcome: 'retried',
  })

  const retry = store.beginAttempt(record, { attemptId: 'retry-2', step: 1, startedAtMs: 600 })
  store.acceptChunk(record, retry, { timeMs: 600, chunk: outputChunk('b'.repeat(80)) })
  store.acceptChunk(record, retry, { timeMs: 1100, chunk: outputChunk('b'.repeat(80)) })
  store.settleAttempt(retry, {
    settledAtMs: 1150,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  const curve = store.endTurn(record, { timeMs: 1200, status: 'completed' }).curve
  const runs = curve.series.find(series => series.key === 'output').runs
  assert.deepEqual(runs.map(run => run.attemptId), ['retry-1', 'retry-2'])
  assert.equal(runs[1].startMs, 500,
    'the retry opens at the abandoned attempt\'s last coordinate, as the compressed clock requires')

  assert.deepEqual(runs[0].points.map(p => p.tps), [200, 200, 400],
    'the abandoned attempt keeps its own 200 tokens per measurement')
  assert.deepEqual(runs[1].points.map(p => p.tps), [20, 20, 40, 40, 20, 20, 0],
    'a retry resets the measurement window: the abandoned prefix may not seed it')
  assert.equal(runs[1].points[0].timeMs, 500,
    'and the retry\'s first vertex sits at the shared coordinate, where it reads its own 20 and not 220')
  assert.equal(runs[1].peak, 40)

  assert.equal(curve.peakTps, 400,
    'the abandoned attempt still owns its own 400 tokens/s measurement')
})

test('a retry whose abandoned prefix produced one delta shares the coordinate without sharing a window', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const attempt = store.beginAttempt(record, { attemptId: 'retry-1', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 100, chunk: outputChunk('a'.repeat(2000)) })
  store.settleAttempt(attempt, {
    settledAtMs: 150,
    settlementKind: 'attempt',
    surfaceCommitted: false,
    attemptOutcome: 'retried',
  })

  const retry = store.beginAttempt(record, { attemptId: 'retry-2', step: 1, startedAtMs: 200 })
  store.acceptChunk(record, retry, { timeMs: 200, chunk: outputChunk('b'.repeat(40)) })
  store.settleAttempt(retry, {
    settledAtMs: 260,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  const curve = store.endTurn(record, { timeMs: 300, status: 'completed' }).curve
  const runs = curve.series.find(series => series.key === 'output').runs
  assert.deepEqual(runs.map(run => run.attemptId), ['retry-1', 'retry-2'])
  assert.equal(runs[0].endMs, 0, 'a single delta is a zero-length attempt')
  assert.equal(runs[1].startMs, 0, 'so both attempts occupy the coordinate zero')
  assert.deepEqual(runs[0].points.map(p => p.tps), [500],
    'the abandoned attempt is one measurement, drawn as one vertex')
  assert.deepEqual(runs[1].points.map(p => p.tps), [10, 10, 10, 10, 0],
    'and the retry is its own series, never 510')
  /**
   * Two attempts on one coordinate is the sharpest form of the invariant: the
   * compressed axis cannot separate them at all, so only a per-attempt window can
   * keep their samples apart.
   */
  assert.equal(runs[0].drawnToMs, 0, 'the first attempt owns no coordinate to decay over')
  assert.equal(curve.peakTps, 500)
})

test('each attempt is sampled on the same 250 ms grid, over one window of 1000 ms', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveToolSeparatedTurn(store)
  const curve = settled.curve

  assert.equal(curve.windowMs, DEFAULT_WINDOW_MS)
  assert.equal(curve.sampleEveryMs, DEFAULT_SAMPLE_EVERY_MS)

  const [runA, runB] = curve.series.find(series => series.key === 'output').runs
  /**
   * A run is sampled on its own 250 ms grid, from its own local zero out to its
   * decay limit. A's limit is B's start, because B begins exactly where A ends.
   */
  assert.deepEqual(runA.points.map(p => p.timeMs), [0, 250, 500],
    'the first attempt is sampled on the same grid the single-attempt case always used')
  assert.deepEqual(runB.points.map(p => p.timeMs), [500, 750, 1000, 1250, 1500, 1750, 2000],
    'A stops at the boundary; B is re-based to its own start and re-offset to the shared clock')
  assert.equal(runA.points.map(p => p.localMs).at(-1), 500)
  assert.equal(runB.localDurationMs, 500, 'a run reports its own width for the sampler')
  assert.equal(runB.points[0].localMs, 0, 'its first vertex is local zero, not the shared coordinate')
  assert.equal(runB.points[0].timeMs, 500, 'and it is drawn at the shared coordinate')
})

test('an attempt\'s decay tail is drawn, clamped to the next attempt rather than to its own end', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  /** One measuring instant, then a 3 s silence, then one more — both in one call. */
  const a = store.beginAttempt(record, { attemptId: 'tail-a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, a, { timeMs: 0, chunk: outputChunk('x'.repeat(400)) })
  store.acceptChunk(record, a, { timeMs: 3000, chunk: outputChunk('x'.repeat(400)) })
  store.settleAttempt(a, { settledAtMs: 3050, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  const curve = store.endTurn(record, { timeMs: 3100, status: 'completed' }).curve
  const runs = curve.series.find(series => series.key === 'output').runs

  /**
   * A 3 s silence is three windows long, so it is two evidence episodes rather than
   * one interval spanning the gap. Each episode nevertheless keeps its own
   * one-second decay: the reader watches the rate hold and then fall to zero instead
   * of the curve stopping dead on the last delta.
   *
   * The tail vertices sit on a grid anchored at the episode's last delta
   * (`last + k*250`) rather than at zero, so each of their windows is a whole
   * `(t - windowMs, t]` and the decay reaches a true zero rather than stopping on a
   * truncated window.
   */
  assert.equal(runs.length, 2, 'the stall splits the episode')
  assert.deepEqual(runs.map(run => [run.startMs, run.endMs]), [[0, 1000], [3000, 4000]])
  assert.deepEqual(runs[0].points.map(p => p.timeMs), [0, 250, 500, 750, 1000])
  assert.deepEqual(runs[0].points.map(p => p.tps), [100, 100, 100, 100, 0],
    'the opening delta is measured for one window and then expires')
  assert.deepEqual(runs[1].points.map(p => p.timeMs), [3000, 3250, 3500, 3750, 4000])
  /**
   * The second episode opens on its own delta, at 100 and not 200.
   *
   * This expectation previously read `[200, 100, 100, 100, 0]`: `rollingTpsSeries`
   * clamped the lower bound to negative infinity whenever `localMs == fromMs`, which
   * is true at **every** episode opening and not only at an attempt's first, so the
   * second episode readmitted the sample from local zero that its `(2000, 3000]`
   * window had already evicted. The independent Phase 7 audit found it and
   * `test/curve-episode-opening.test.js` carries the standalone counterexample.
   *
   * Both episodes here belong to **one** attempt, so this is not an attempt-boundary
   * effect: Section 6 of the Phase 6 fix remains correct and is what the rest of this
   * file holds fixed, while the window definition itself is now uniform.
   */
  assert.deepEqual(runs[1].points.map(p => p.tps), [100, 100, 100, 100, 0],
    'the closing delta opens on its own measurement alone: expected 100, not 200')
  assert.equal(curve.peakTps, 100,
    'no window ever holds both deltas three seconds apart, so neither the run peak nor the turn peak is 200')
})

test('an intermediate attempt draws no decay tail, because the next call owns those coordinates', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  /** A measures once; B, which follows immediately, measures twice. */
  const a = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, a, { timeMs: 0, chunk: outputChunk('x'.repeat(400)) })
  store.settleAttempt(a, { settledAtMs: 50, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  const b = store.beginAttempt(record, { attemptId: 'b', step: 2, startedAtMs: 100 })
  store.acceptChunk(record, b, { timeMs: 100, chunk: outputChunk('y'.repeat(40)) })
  store.acceptChunk(record, b, { timeMs: 600, chunk: outputChunk('y'.repeat(40)) })
  store.settleAttempt(b, { settledAtMs: 650, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  const curve = store.endTurn(record, { timeMs: 700, status: 'completed' }).curve
  const [runA, runB] = curve.series.find(series => series.key === 'output').runs

  /**
   * A produced one delta, so A's own width is zero and B begins at the same
   * coordinate. A's single measurement is drawn as one vertex and stops there: the
   * tail it would otherwise draw belongs to coordinates B is about to use.
   */
  assert.equal(runA.points.length, 1, 'no tail for an attempt whose coordinates are already taken')
  assert.deepEqual(runA.points.map(p => p.tps), [100])
  assert.equal(runA.drawnToMs, 0)
  assert.deepEqual(runB.points.map(p => p.timeMs), [0, 250, 500, 750, 1000, 1250, 1500])
  assert.deepEqual(runB.points.map(p => p.tps), [10, 10, 20, 20, 10, 10, 0])
  assert.equal(runB.peak, 20)
  assert.equal(curve.peakTps, 100)
})

test('a rendering budget still cannot move the reported peak, whatever the attempt split', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveToolSeparatedTurn(store)
  const curve = settled.curve

  const full = seriesOf(curve, 'output')
  assert.equal(curve.peakTps, peakTps(...full),
    'the reported peak is the max over the full per-attempt series, evaluated before downsampling')

  for (const series of curve.series) {
    for (const run of series.runs) {
      assert.ok(peakTps(downsampleSeries(run.points, 3)) <= peakTps(run.points),
        'a rendering budget may never raise a measured value')
    }
  }

  /**
   * The global maximum sits at the **end of the second attempt**, so the run list
   * itself must carry it: a peak counted over the concatenated runs is still the
   * peak, and no per-attempt averaging may dilute it.
   */
  assert.equal(runPeak(curve, 'output'), 200,
    'the strongest vertex is the second attempt\'s own end, not an average of the two')
})

/** Every full per-attempt series of one phase. */
function seriesOf(curve, key) {
  return curve.series.find(series => series.key === key).runs.map(run => run.points)
}

/** Highest rate any vertex of one phase's runs carries. */
function runPeak(curve, key) {
  return peakTps(...seriesOf(curve, key))
}

/**
 * Live-vs-completed equivalence.
 *
 * The live pane and the completed card are two renderings of one definition, so
 * for every attempt-local instant τ the completed reconstruction must report the
 * rate `LiveMeter` reported at the same instant for the same attempt. The check
 * that makes this worth stating is the one across a boundary: the live meter is
 * read during the run, before the turn has any durable settlement, and the curve
 * is rebuilt afterwards from the stored samples. If those two disagree, at least
 * one of them is not the frozen definition.
 */
test('the reconstructed per-attempt curve agrees with the live meter at the same attempt-local instants', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const a = store.beginAttempt(record, { attemptId: 'attempt-a', step: 1, startedAtMs: 1000 })
  /**
   * Read live at each vertex, with the chunk accepted first, and feed those
   * readings back as the expected curve. Reading before acceptance would compare
   * the curve against a meter that had not yet been told about the delta it is
   * standing on. Sample pairs are half a window apart so the rate is non-trivial.
   */
  const liveA = []
  for (const [timeMs, count] of [[1000, 400], [1250, 0], [1500, 400], [2000, 400]]) {
    if (count > 0) store.acceptChunk(record, a, { timeMs, chunk: outputChunk('x'.repeat(count)) })
    liveA.push({ localMs: timeMs - 1000, tps: store.liveSnapshot('s1', timeMs).tps })
  }
  store.settleAttempt(a, {
    settledAtMs: 2050,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  store.toolStarted(record, { callId: 'tool-1', name: 'pwsh', timeMs: 2100 })
  assert.equal(store.liveSnapshot('s1', 30_000).tps, null, 'a tool gap has no rate at all')

  store.toolSettled(record, { callId: 'tool-1', timeMs: 62_000, status: 'ok' })
  const b = store.beginAttempt(record, { attemptId: 'attempt-b', step: 2, startedAtMs: 62_100 })
  /** The attempt begins with an empty window: the retry/tool reset, read live. */
  assert.equal(store.liveSnapshot('s1', 62_100).tps, 0)

  const liveB = []
  for (const [timeMs, count] of [[62_100, 40], [62_350, 0], [62_600, 40]]) {
    if (count > 0) store.acceptChunk(record, b, { timeMs, chunk: outputChunk('y'.repeat(count)) })
    liveB.push({ localMs: timeMs - 62_100, tps: store.liveSnapshot('s1', timeMs).tps })
  }
  store.settleAttempt(b, {
    settledAtMs: 62_650,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  const curve = store.endTurn(record, { timeMs: 63_000, status: 'completed' }).curve
  const runs = curve.series.find(series => series.key === 'output').runs
  assert.deepEqual(runs.map(run => run.attemptId), ['attempt-a', 'attempt-b'])

  for (const [index, live] of [liveA, liveB].entries()) {
    const run = runs[index]
    const offsetMs = run.points[0].timeMs
    for (const reading of live) {
      if (!Number.isFinite(reading.tps)) continue
      const point = run.points.find(p => p.timeMs === offsetMs + reading.localMs)
      assert.ok(point !== undefined,
        `${run.attemptId} is sampled at local ${reading.localMs}`)
      assert.equal(point.tps, reading.tps,
        `${run.attemptId} at local ${reading.localMs}: live said ${reading.tps}, the reconstructed curve says ${point.tps}`)
    }
  }

  /**
   * Summary of the readings this test pins down.
   *
   * Attempt A: measurements at local 0, 500 and 1000, so the live meter reads
   * 100, then 100, then 200 as the second measurement enters the window, and stays
   * at 200 because the third arrives exactly as the first expires. Attempt B
   * repeats that shape at a tenth of the magnitude: 10, 10, 20.
   */
  assert.deepEqual(liveA.map(r => r.tps), [100, 100, 200, 200])
  assert.deepEqual(liveB.map(r => r.tps), [10, 10, 20])
  assert.deepEqual(runs[0].points.map(p => p.tps), [100, 100, 200, 200, 200])
  assert.deepEqual(runs[1].points.map(p => p.tps), [10, 10, 20, 20, 10, 10, 0])
  assert.equal(runPeak({ series: [{ key: 'output', runs: [runs[1]] }] }, 'output'), 20,
    'attempt B peaks on its own two measurements, ten times below attempt A')
})
