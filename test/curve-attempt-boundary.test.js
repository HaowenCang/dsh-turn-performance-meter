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
 * call of `rollingTpsSeries`, which filtered on `activeTimeMs` and `phase` and
 * never read `attemptId`. Two consequences followed:
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
 *
 * ## Phase 7C: the counterexample's own magnitudes
 *
 * The same file previously also measured **one phase at a time**, because that is
 * what production did. The counterexample below therefore calibrates its samples to
 * the same provider totals production calibrates to and then sums them phase by
 * phase, so the only difference left between it and the corrected pipeline is the
 * attempt partition this file exists to test. The cross-phase defect has its own
 * counterexample in `test/curve-total-rolling.test.js`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import {
  DEFAULT_SAMPLE_EVERY_MS,
  DEFAULT_WINDOW_MS,
  downsampleSeries,
  peakTps,
} from '../src/core/curve.js'

function outputChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

/**
 * The rejected implementation, kept as an executable counterexample.
 *
 * This is what the shipped code did: concatenate every attempt's samples onto the
 * turn-compressed clock and roll **one** window across the whole list, then read
 * each phase out of that bridged series separately. The window convention below is
 * the verified metric contract — half-open on the left, `(t - windowMs, t]`, as
 * `SlidingWindowMeter` implements and `docs/METRICS_SPEC.md` §8.1 specifies — so
 * this reproduction differs from the corrected pipeline in exactly two respects:
 * its samples are never partitioned by attempt, and its rates are per phase. The
 * first is the defect this file measures; the second is the defect
 * `test/curve-total-rolling.test.js` measures.
 *
 * The grid is anchored at the turn's start with a tail shifted past the last
 * sample, matching the corrected sampler.
 */
function legacyCompletedSeries(record, phase, windowMs = DEFAULT_WINDOW_MS) {
  const samples = []
  let offsetMs = 0
  for (const attempt of record.attempts) {
    if (!Array.isArray(attempt.samples) || attempt.samples.length === 0) continue
    const first = attempt.samples[0].timeMs
    const last = attempt.samples[attempt.samples.length - 1].timeMs
    /**
     * One common scale per attempt, which is the whole-attempt branch of
     * `calibrateAttemptSamples`. Reproducing production's magnitudes is what keeps
     * the comparison a measurement of the partition and not of two scales.
     */
    const rawTotal = attempt.samples.reduce((sum, sample) => sum + (sample.weight ?? 0), 0)
    const scale = rawTotal > 0 && Number.isFinite(attempt.usage?.outputTokens)
      ? attempt.usage.outputTokens / rawTotal
      : 1
    for (const sample of attempt.samples) {
      samples.push({
        ...sample,
        tokens: (sample.weight ?? 0) * scale,
        activeTimeMs: offsetMs + (sample.timeMs - first),
      })
    }
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
  return { durationMs: offsetMs, segments: [], series }
}

/** Every vertex of every attempt's trace, with the attempt identity attached. */
function verticesOf(curve) {
  return curve.attempts.flatMap(attempt => attempt.points)
}

/** One attempt's trace, by id. */
function attemptOf(curve, id) {
  return curve.attempts.find(candidate => candidate.attemptId === id)
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
   * The corrected curve: a rolling window per attempt on concatenated coordinates.
   *
   * Each trace is sampled on its own 250 ms grid over `(t - 1000, t]` and stops where
   * its own attempt stops, so A covers [0, 500] and B covers [500, 1000]. A's two
   * measurements are half a second apart, so the window at t=500 is `(500-1000, 500]`
   * and holds both: 200 tokens/s. B's are half a second apart too, so B reaches 20.
   */
  const traceA = attemptOf(curve, 'attempt-a')
  const traceB = attemptOf(curve, 'attempt-b')
  assert.deepEqual(traceA.points.map(p => p.timeMs), [0, 250, 500])
  assert.deepEqual(traceA.points.map(p => p.tps), [100, 100, 200],
    'attempt A reads only its own measurements and reaches 200 tokens/s at its own end')

  assert.equal(traceB.points[0].timeMs, 500, 'attempt B opens at the shared compressed coordinate')
  assert.deepEqual(traceB.points.map(p => p.tps), [10, 10, 20],
    'B climbs on its own evidence alone and never borrows A\'s 100')

  /**
   * The decisive comparison. The two traces meet at one compressed coordinate — A's
   * last vertex and B's first are both at 500 — and they report different numbers
   * computed from different samples: A's own 200 from its two measurements, B's own
   * 10 from the single delta it had produced by then. The rejected pipeline produced
   * one value for that coordinate, 210, for an attempt whose entire output was 20
   * tokens, and still reported 120 at 1000 against B's honest 20.
   *
   * Phase 7C.1 removed the final attempt's one-window decay, so B's trace stops at its
   * own last delta — 1000, which is also the axis end — rather than drawing four more
   * vertices past it. Those vertices measured 20, 10, 10, 0 and were clamped onto
   * `x = 100`; the peak they were compared against is unchanged, which the assertion at
   * the end of this test states.
   */
  assert.equal(traceA.points.at(-1).tps, 200)
  assert.equal(traceB.points[0].tps, 10)
  assert.equal(curve.series.find(series => series.key === 'output').runs[1].peak, 20)
  assert.equal(traceB.points.at(-1).timeMs, 1000,
    'B ends on its own last delta, which is the last coordinate the axis owns')
  assert.equal(traceB.points.at(-1).tps, 20,
    'and the closing measurement is the one its own window produced')
  assert.equal(legacy.series.find(p => p.timeMs === 500).tps, 210,
    'the bridged pipeline adds the two calls together at the coordinate they share')
  assert.equal(legacy.series.find(p => p.timeMs === 1000).tps, 120,
    'and it is still 100 tokens/s above B\'s own reading one window into the new call')

  assert.equal(curve.peakTps, 200,
    'the turn peak is the max over per-attempt traces, never a sum across the boundary')
})

test('no sampling instant carries a rate the owning attempt cannot support', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveToolSeparatedTurn(store)

  /**
   * Independent upper bound. Within one attempt a trailing one-second window can hold
   * at most everything that attempt ever produced, so `tps <= attemptTokens * 1000 /
   * windowMs` must hold at every vertex. Only a window fed by a neighbouring attempt
   * can exceed it.
   */
  const expectedTotal = { 'attempt-a': 200, 'attempt-b': 20 }
  for (const attempt of settled.curve.attempts) {
    const bound = expectedTotal[attempt.attemptId] * 1000 / DEFAULT_WINDOW_MS
    assert.equal(attempt.tokens, expectedTotal[attempt.attemptId],
      `${attempt.attemptId} reports only its own token total`)
    /** No vertex may claim more than the attempt's whole output in one window. */
    for (const point of attempt.points) {
      assert.ok(point.tps <= bound + 1e-9,
        `${attempt.attemptId} point ${point.localMs} claims ${point.tps} tokens/s from at most ${attempt.tokens} tokens`)
    }
    for (const run of attempt.runs) {
      assert.equal(run.peak, peakTps(run.points),
        'a run\'s reported peak is the maximum of its own vertices')
    }
  }
  /**
   * A phase with no evidence must not be drawn as a flat zero line: "never reasoned
   * here" is not "reasoning throughput fell to zero".
   */
  const reasoning = settled.curve.series.find(series => series.key === 'reasoning')
  assert.deepEqual(reasoning.runs, [], 'this turn contains no reasoning delta at all')
  assert.equal(reasoning.present, false)
})

test('the bound is broken by the bridged pipeline and respected by the corrected one', () => {
  const store = new TurnTelemetryStore()
  const { record, settled } = driveToolSeparatedTurn(store)

  /**
   * Independent check on the counterexample: attempt B produced 20 tokens in total
   * and its own trace lasts half a second, so no honest rate attributed to it can
   * exceed 20 tokens/s. The rejected pipeline's vertex at 1000 is 120.
   */
  const boundB = 20 * 1000 / DEFAULT_WINDOW_MS
  const legacy = legacyCompletedSeries(record, 'output')
  const segments = settled.curve.segments
  const boundaryOfB = segments[1].startMs
  assert.equal(boundaryOfB, 500)
  assert.ok(legacy.series.find(p => p.timeMs === 1000).tps > boundB,
    'the rejected vertex attributed to attempt B exceeds what B produced')

  const traceB = attemptOf(settled.curve, 'attempt-b')
  for (const point of traceB.points) {
    assert.ok(point.tps <= boundB + 1e-9,
      `corrected trace ${traceB.attemptId} stays within ${boundB} tokens/s at ${point.localMs}`)
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
  const first = attemptOf(curve, 'retry-1')
  const second = attemptOf(curve, 'retry-2')
  assert.equal(second.startMs, 500,
    'the retry opens at the abandoned attempt\'s last coordinate, as the compressed clock requires')

  assert.deepEqual(first.points.map(p => p.tps), [200, 200, 400],
    'the abandoned attempt keeps its own 200 tokens per measurement')
  assert.deepEqual(second.points.map(p => p.tps), [20, 20, 40],
    'a retry resets the measurement window: the abandoned prefix may not seed it')
  assert.equal(second.points[0].timeMs, 500,
    'and the retry\'s first vertex sits at the shared coordinate, where it reads its own 20 and not 420')
  assert.equal(curve.series.find(series => series.key === 'output').runs[1].peak, 40)

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
  const first = attemptOf(curve, 'retry-1')
  const second = attemptOf(curve, 'retry-2')

  assert.equal(first.endMs, 0, 'a single delta is a zero-length attempt')
  assert.equal(second.startMs, 0, 'so both attempts occupy the coordinate zero')
  assert.deepEqual(first.points.map(p => p.tps), [500],
    'the abandoned attempt is one measurement, drawn as one vertex')
  assert.deepEqual(second.points.map(p => p.tps), [10],
    'and the retry is its own trace of one measurement, never 510')
  /**
   * Two attempts on one coordinate is the sharpest form of the invariant: the
   * compressed axis cannot separate them at all, so only a per-attempt window can
   * keep their samples apart.
   */
  assert.equal(first.points.at(-1).timeMs, 0, 'the first attempt owns no coordinate to decay over')
  assert.equal(curve.peakTps, 500)
})

test('each attempt is sampled on the same 250 ms grid, over one window of 1000 ms', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveToolSeparatedTurn(store)
  const curve = settled.curve

  assert.equal(curve.windowMs, DEFAULT_WINDOW_MS)
  assert.equal(curve.sampleEveryMs, DEFAULT_SAMPLE_EVERY_MS)

  const traceA = attemptOf(curve, 'attempt-a')
  const traceB = attemptOf(curve, 'attempt-b')
  /**
   * A trace is sampled on its own 250 ms grid, from its own local zero to its own last
   * delta. That endpoint is B's start for A, and the axis end for B: the two rules are one
   * rule, and neither attempt draws past the coordinate it owns.
   */
  assert.deepEqual(traceA.points.map(p => p.timeMs), [0, 250, 500],
    'the first attempt is sampled on the same grid the single-attempt case always used')
  assert.deepEqual(traceB.points.map(p => p.timeMs), [500, 750, 1000],
    'A stops at the boundary; B is re-based to its own start and re-offset to the shared clock')
  assert.equal(traceA.points.at(-1).localMs, 500)
  assert.equal(traceB.localEndMs, 500, 'an attempt reports its own width for the sampler')
  assert.equal(traceB.points[0].localMs, 0, 'its first vertex is local zero, not the shared coordinate')
  assert.equal(traceB.points[0].timeMs, 500, 'and it is drawn at the shared coordinate')
})

test('an attempt\'s trace ends on its own last delta, and the silence inside it stays drawn', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  /** One measuring instant, then a 3 s silence, then one more — both in one call. */
  const a = store.beginAttempt(record, { attemptId: 'tail-a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, a, { timeMs: 0, chunk: outputChunk('x'.repeat(400)) })
  store.acceptChunk(record, a, { timeMs: 3000, chunk: outputChunk('x'.repeat(400)) })
  store.settleAttempt(a, { settledAtMs: 3050, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  const curve = store.endTurn(record, { timeMs: 3100, status: 'completed' }).curve
  const trace = attemptOf(curve, 'tail-a')

  /**
   * The 3 s silence is **drawn**, at full width, inside the one attempt that produced
   * it. The previous revision instead split the evidence into two episodes and left a
   * blank region between them; the region is now part of the trace, and what it says is
   * that the trailing rate fell to zero and stayed there until the model resumed.
   *
   * The trace stops on the closing delta. The four vertices the previous expectation
   * carried past it — 3250, 3500, 3750, 4000 — were a one-window decay on an attempt that
   * had stopped producing, and they all mapped onto `x = 100`
   * (`test/curve-axis-endpoint.test.js`).
   */
  assert.deepEqual(trace.points.map(p => p.localMs), [
    0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750,
    3000,
  ])
  assert.deepEqual(trace.points.map(p => p.tps), [
    100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0,
    100,
  ], 'two bursts, one continuous trace, and a real zero between them')
  /**
   * The second burst opens on its own delta alone, at 100 and not 200.
   *
   * This expectation previously read `[200, 100, 100, 100, 0]` for the second episode:
   * `rollingTpsSeries` clamped the lower bound to negative infinity whenever
   * `localMs == fromMs`, which is true at **every** episode opening and not only at an
   * attempt's first, so the second episode readmitted the sample from local zero that
   * its `(2000, 3000]` window had already evicted. The independent Phase 7 audit found
   * it and `test/curve-episode-opening.test.js` carries the standalone counterexample.
   */
  assert.equal(trace.points.find(p => p.localMs === 3000).tps, 100,
    'the closing delta opens on its own measurement alone: expected 100, not 200')
  assert.equal(curve.peakTps, 100,
    'no window ever holds both deltas three seconds apart, so neither a run peak nor the turn peak is 200')
})

test('a one-delta attempt is one vertex, whether or not a successor follows it', () => {
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
  const traceA = attemptOf(curve, 'a')
  const traceB = attemptOf(curve, 'b')

  /**
   * A produced one delta, so A's own width is zero and B begins at the same coordinate. A's
   * single measurement is drawn as one vertex and stops there.
   *
   * Phase 7C.1 made this the rule for **every** attempt rather than only for one with a
   * successor: the previous revision gave the last attempt a one-window tail, so an
   * otherwise identical single-delta attempt drew five vertices when it happened to be
   * final and one when it did not. Which attempt an attempt is may not change what its own
   * evidence is worth.
   */
  assert.equal(traceA.points.length, 1, 'no tail for a one-delta attempt')
  assert.deepEqual(traceA.points.map(p => p.tps), [100])
  assert.equal(traceA.points.at(-1).timeMs, 0)
  assert.deepEqual(traceB.points.map(p => p.timeMs), [0, 250, 500])
  assert.deepEqual(traceB.points.map(p => p.tps), [10, 10, 20])
  assert.equal(curve.series.find(series => series.key === 'output').runs[1].peak, 20)
  assert.equal(curve.peakTps, 100)
})

test('a single-delta attempt is the same trace whether it is last or not', () => {
  /**
   * The "no attempt receives synthetic width merely because it is last" rule, asserted as an
   * equality between two placements of one script. The only difference between them is that a
   * successor exists in the second, and nothing about the attempt's own trace may depend on it.
   */
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const solo = store.beginAttempt(record, { attemptId: 'solo', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, solo, { timeMs: 0, chunk: outputChunk('x'.repeat(400)) })
  store.settleAttempt(solo, { settledAtMs: 50, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })
  const soloCurve = store.endTurn(record, { timeMs: 100, status: 'completed' }).curve

  const store2 = new TurnTelemetryStore()
  const record2 = store2.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const first = store2.beginAttempt(record2, { attemptId: 'first', step: 1, startedAtMs: 0 })
  store2.acceptChunk(record2, first, { timeMs: 0, chunk: outputChunk('x'.repeat(400)) })
  store2.settleAttempt(first, { settledAtMs: 50, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })
  const second = store2.beginAttempt(record2, { attemptId: 'second', step: 2, startedAtMs: 9000 })
  store2.acceptChunk(record2, second, { timeMs: 9000, chunk: outputChunk('y'.repeat(40)) })
  store2.settleAttempt(second, { settledAtMs: 9050, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })
  const withSuccessor = store2.endTurn(record2, { timeMs: 9100, status: 'completed' }).curve

  const alone = soloCurve.attempts[0]
  const embedded = attemptOf(withSuccessor, 'first')
  assert.deepEqual(embedded.points.map(p => [p.localMs, p.tps, p.activePhase]),
    alone.points.map(p => [p.localMs, p.tps, p.activePhase]),
    'the same evidence produces the same trace in either placement')
  assert.equal(embedded.points.length, 1)
})

test('a rendering budget still cannot move the reported peak, whatever the attempt split', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveToolSeparatedTurn(store)
  const curve = settled.curve

  const full = curve.attempts.map(attempt => attempt.points)
  assert.equal(curve.peakTps, peakTps(...full),
    'the reported peak is the max over the full per-attempt traces, evaluated before downsampling')

  for (const series of curve.series) {
    for (const run of series.runs) {
      assert.ok(peakTps(downsampleSeries(run.points, 3)) <= peakTps(run.points),
        'a rendering budget may never raise a measured value')
    }
  }

  /**
   * The global maximum sits at the **end of the first attempt**, so the attempt list
   * itself must carry it: a peak counted over the concatenated vertices is still the
   * peak, and no per-attempt averaging may dilute it.
   */
  assert.equal(peakTps(curve.attempts[0].points, curve.attempts[1].points), 200,
    'the strongest vertex is attempt A\'s own end, not an average of the two')
})

/**
 * Live-vs-completed relationship after calibration.
 *
 * The live pane and the completed card are two renderings of one **definition**, but
 * they are not two renderings of one **magnitude** once provider usage exists. The live
 * meter reads the heuristic shape weight, because that is all there is while the model
 * is still streaming; the completed curve reads the calibrated allocation, because
 * `aggregateTurn` has since anchored the shape to the provider's own total. A scale
 * factor may therefore separate them, and demanding numeric equality would forbid the
 * calibration the card's printed totals depend on.
 *
 * What must remain identical is the **shape**: which instants are sampled, where the
 * attempts begin and end, which phase each vertex belongs to, and where the stalls and
 * the phase transitions fall. That is what this test asserts, by driving the live meter
 * and the settled curve from the same stream and comparing their normalised shapes
 * rather than their numbers.
 *
 * `test/curve-total-rolling.test.js` asserts the numeric equality that **is** mandatory:
 * when both sides are fed the same calibrated magnitudes, every vertex matches the live
 * meter exactly.
 */
test('the completed curve preserves the live meter\'s shape, and rescales its magnitudes only when usage exists', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const a = store.beginAttempt(record, { attemptId: 'attempt-a', step: 1, startedAtMs: 1000 })
  /**
   * Read live at each vertex, with the chunk accepted first, so the live side is a
   * genuine measurement of the same stream the curve is later rebuilt from. Sample pairs
   * are half a window apart so the rate is non-trivial.
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
    /** An authoritative total, so the completed magnitudes are calibrated. */
    usage: { outputTokens: 2500, reasoningTokens: 0 },
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
  const traceA = attemptOf(curve, 'attempt-a')
  const traceB = attemptOf(curve, 'attempt-b')

  /** The timestamp shape is identical: every live instant is a sampled vertex. */
  for (const [trace, live] of [[traceA, liveA], [traceB, liveB]]) {
    for (const reading of live) {
      if (!Number.isFinite(reading.tps)) continue
      const point = trace.points.find(candidate => candidate.localMs === reading.localMs)
      assert.ok(point !== undefined,
        `${trace.attemptId} is sampled at local ${reading.localMs}, where the live meter read ${reading.tps}`)
    }
  }

  /**
   * Attempt A: the live readings and the calibrated curve, side by side.
   *
   * The live shape is 100, 100, 200, 200 — the three deltas entering and leaving a
   * one-second window. The calibrated curve is that shape multiplied by one common
   * factor, because the heuristic weights were 100 + 100 + 100 = 300 raw units against
   * an authoritative 2500. Attempt B, which reported no usage, is untouched.
   */
  assert.deepEqual(liveA.map(r => r.tps), [100, 100, 200, 200])
  const scale = 2500 / 300
  assert.deepEqual(traceA.points.slice(0, 4).map(p => p.tps), [100 * scale, 100 * scale, 200 * scale, 200 * scale],
    'the completed curve is the live shape under one common calibrated scale')
  assert.equal(traceA.calibratedTokens, 2500)
  assert.equal(traceA.calibrated, true)

  assert.deepEqual(liveB.map(r => r.tps), [10, 10, 20])
  assert.deepEqual(traceB.points.map(p => p.tps), [10, 10, 20],
    'an attempt with no usage keeps the live magnitudes exactly, and stops on its own last delta')
  assert.equal(traceB.calibratedTokens, null)
  assert.equal(traceB.calibrated, false)

  /** The shape that always survives calibration: the leading attempt still peaks first. */
  assert.ok(peakTps(traceA.points) > peakTps(traceB.points))
  assert.equal(curve.peakTps, peakTps(traceA.points))
})
