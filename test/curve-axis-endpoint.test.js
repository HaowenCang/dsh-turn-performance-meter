/**
 * The completed x-axis is compressed **model-generation time**, and each attempt's
 * trace ends at that attempt's real end instant (Phase 9.2).
 *
 * ## The end instant
 *
 * `compressAttempts` measures an attempt's compressed width as the span from its first
 * generated delta to its **terminal episode's end**: the attempt's `settledAtMs` when
 * one is known, and its last generated delta otherwise. The terminal generated-delta →
 * settlement tail is model-attempt elapsed time under the MiMo-style definition — the
 * episode's numerator freezes while its denominator advances — so the trace is sampled
 * across it and drawn as a hyperbolic decay. A tool wait or the next call's TTFT is not
 * model-attempt time and owns no coordinate at all.
 *
 * ## The defect these tests were written against
 *
 * The previous revision ended every attempt's trace at its last model-producing delta
 * and then sampled the **final** attempt one full trailing window past it — a special
 * rule that existed only because nothing followed that attempt to compete for the axis.
 * Those vertices carried compressed coordinates strictly greater than
 * `curve.durationMs`, and `xOf(timeMs, durationMs)` clamps every value above the
 * duration to `CURVE_VIEW_WIDTH`: several distinct instants landed on one x coordinate,
 * and the SVG closed with a vertical stroke the evidence does not contain.
 *
 * ## The rule this file freezes
 *
 * For **every** attempt, including the last:
 *
 *   - x = 0 is its first model-producing delta;
 *   - the trace's last vertex is its real end instant, and nothing is sampled past it:
 *     no vertex ever carries a coordinate larger than the attempt's own segment end or
 *     than `curve.durationMs`;
 *   - the vertex grid is each episode's **own** 100 ms ladder, so an end instant that does
 *     not fall on the terminal episode's ladder is appended as a vertex of its own, and one
 *     that does fall on it is not duplicated;
 *   - an attempt that never settled ends at its last generated delta;
 *   - a phase transition stays a shared seam, never a blank gap.
 *
 * A tool wait and a retry still own zero width, and the attempt that follows still opens
 * on the coordinate its predecessor closed on.
 *
 * ## What this file deliberately does not test
 *
 * Whether a vertex publishes a rate is the shared publication policy's decision
 * (`src/core/rate-publication.js`, frozen by `test/curve-rate-publication.test.js`), not
 * the endpoint rule's. The fixtures here satisfy that policy where a rate is asserted —
 * three contributing deltas per episode — so that the endpoint assertions below are about
 * the endpoint and cannot be satisfied by a withheld vertex.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { MAX_SERIES_POINTS, attemptTrace, visualRunsOf } from '../src/core/curve.js'
import { compressAttempts } from '../src/core/time-axis.js'

/** 400 characters weigh exactly 100 by `heuristicTokenWeight` (0.25 per code point). */
const DELTA_TEXT = 'x'.repeat(400)

function outputChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

function reasoningChunk(text) {
  return { type: 'reasoning-delta', index: 0, text }
}

/**
 * One attempt, driven through the store exactly as the host drives it.
 *
 * `chunks` are `[timeMs, kind]` pairs. `settledAtMs` is the attempt's own settlement
 * instant; leaving it `null` leaves the attempt unsettled, which is the state in which
 * the attempt's last generated delta is its end.
 */
function driveOneAttempt(store, chunks, { settledAtMs = null } = {}) {
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  for (const [timeMs, kind] of chunks) {
    store.acceptChunk(record, attempt, {
      timeMs,
      chunk: kind === 'reasoning' ? reasoningChunk(DELTA_TEXT) : outputChunk(DELTA_TEXT),
    })
  }
  const last = chunks.length > 0 ? chunks[chunks.length - 1][0] : 0
  if (settledAtMs !== null) {
    store.settleAttempt(attempt, {
      settledAtMs,
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
      settlementSeq: 1,
    })
  }
  return { record, settled: store.endTurn(record, { timeMs: last + 5000, status: 'completed' }) }
}

/** The trace of one attempt of a settled curve. */
function traceOf(settled, attemptId = 'a') {
  return settled.curve.attempts.find(attempt => attempt.attemptId === attemptId)
}

/** Every coordinate the view model would hand the SVG, in draw order. */
function allCoordinates(view) {
  return view.series.flatMap(series => series.runs.flatMap(run => run.coordinates))
}

/**
 * No vertex of any attempt is drawn past that attempt's own end, and none is past the
 * chart's own duration. This is the invariant the clamp in `xOf` would otherwise hide:
 * a vertex beyond the duration is not rejected, it is silently piled onto `x = 100`.
 */
function assertNothingPastTheEnd(settled) {
  const curve = settled.curve
  for (const attempt of curve.attempts) {
    const segment = curve.segments.find(candidate => candidate.attemptId === attempt.attemptId)
    assert.ok(segment !== undefined, `${attempt.attemptId} has a compressed segment`)
    for (const point of attempt.points) {
      assert.ok(point.timeMs <= segment.endMs + 1e-9,
        `${attempt.attemptId}: vertex ${point.timeMs} is past the attempt's own end ${segment.endMs}`)
      assert.ok(point.timeMs <= curve.durationMs + 1e-9,
        `${attempt.attemptId}: vertex ${point.timeMs} is past the chart's own duration ${curve.durationMs}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The terminal tail
// ---------------------------------------------------------------------------

test('an attempt settling 400 ms after its last delta is sampled to that settlement, and the tail decays', () => {
  /**
   * Three deltas — at 0, 100 and 150 ms — then 250 ms of model-attempt time before the
   * settlement at 400 ms. The terminal episode's numerator freezes at the 300 tokens that
   * had arrived while its denominator advances, so the tail is the hyperbola
   * `300 * 1000 / t`, rounded: 1500, 1000, 750 — strictly decreasing and never zero by
   * rule. The two vertices before it are withheld by the gates, not drawn as zeros.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [100, 'output'], [150, 'output']], { settledAtMs: 400 })
  const curve = settled.curve
  const trace = traceOf(settled)

  assert.equal(curve.durationMs, 400, 'the settlement tail is part of the attempt\'s own width')
  assert.equal(trace.localEndMs, 400)
  assert.equal(trace.endMs, 400)
  assert.deepEqual(trace.points.map(point => point.localMs), [0, 100, 200, 300, 400])
  assert.deepEqual(trace.points.map(point => point.tps), [null, null, 1500, 1000, 750],
    'hand-computed: the frozen 300 tokens over 200, 300 and 400 ms, rounded')

  const tail = trace.points.slice(2)
  assert.equal(tail.length, 3, 'the tail is the vertices the episode is publishable at')
  for (let index = 1; index < tail.length; index += 1) {
    assert.ok(tail[index].tps < tail[index - 1].tps,
      `the frozen numerator decays as the denominator advances (${tail[index - 1].tps} -> ${tail[index].tps})`)
    assert.ok(tail[index].tps > 0, 'a hyperbolic decay never reaches zero')
  }
  assert.equal(trace.points.at(-1).timeMs, curve.durationMs, 'the last vertex is the attempt\'s real end')

  assertNothingPastTheEnd(settled)

  /**
   * The right edge of the chart holds exactly one vertex, and it is that end. Before the
   * end rule, post-generation instants past the duration were clamped onto `x = 100`,
   * stacking several distinct times on one coordinate.
   */
  const atRightEdge = allCoordinates(curveViewModel(settled)).filter(coordinate => coordinate.x >= 100 - 1e-9)
  assert.equal(atRightEdge.length, 1, 'exactly one vertex sits on the right edge')
  assert.equal(atRightEdge[0].timeMs, curve.durationMs)
})

// ---------------------------------------------------------------------------
// 2. An attempt with no settlement
// ---------------------------------------------------------------------------

test('an attempt with no settlement ends at its last delta', () => {
  /**
   * Three deltas at 0, 100 and 200 ms, and no settlement observed. The turn itself runs on
   * for another 5 s after the attempt's last delta, but an unsettled attempt owns no time
   * past the last delta it was seen to produce: nothing was observed there, so nothing is
   * sampled there.
   */
  const { record, settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [100, 'output'], [200, 'output']])
  const trace = traceOf(settled)

  assert.equal(record.endMs - record.startMs, 5200, 'the turn ran 5.2 s of wall time')
  assert.equal(settled.curve.durationMs, 200, 'an unsettled attempt ends on its last delta')
  assert.equal(trace.localEndMs, 200)
  assert.deepEqual(trace.points.map(point => [point.timeMs, point.tps]), [[0, null], [100, null], [200, 1500]],
    'hand-computed: the attempt\'s own 300 tokens over its own 200 ms, its last delta included')
  assert.equal(trace.points.at(-1).timeMs, 200)
  assertNothingPastTheEnd(settled)
})

// ---------------------------------------------------------------------------
// 3. The endpoint anchor
// ---------------------------------------------------------------------------

test('an off-grid end instant is appended as a vertex of its own', () => {
  /**
   * The terminal episode's own ladder runs from its first delta at 0 ms: `0 … 500` at 100 ms
   * steps, and the last delta arrives at 250 ms, between two of those instants. A pure
   * ladder would omit 510, the instant the attempt's clock stopped, so the vertex set is the
   * episode's ladder union the attempt's own end instant, and 510 is drawn.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [100, 'output'], [250, 'output']], { settledAtMs: 510 })
  const trace = traceOf(settled)

  assert.equal(settled.curve.durationMs, 510)
  assert.deepEqual(trace.points.map(point => point.timeMs), [0, 100, 200, 300, 400, 500, 510],
    'the episode\'s own ladder union the real end instant, deduplicated and ascending')
  assert.notEqual(510 % 100, 0, 'the end instant really is off the ladder')
  assert.equal(trace.points.at(-1).timeMs, 510, 'the last vertex is the instant the attempt ended')
  assert.equal(trace.points.at(-1).tps, Math.round(300 * 1000 / 510),
    'hand-computed: the episode\'s 300 tokens over its own 510 ms, rounded')
  assert.equal(trace.points.at(-1).tps, 588)
  assertNothingPastTheEnd(settled)
})

test('an end instant that falls exactly on the cadence is not duplicated', () => {
  /**
   * The last delta and the settlement both land at 500 ms, which is already a ladder point
   * of the episode that opened at 0. The union must emit that instant once: the end vertex
   * is appended only when it does not fall on the ladder.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [150, 'output'], [250, 'output'], [500, 'output']], {
    settledAtMs: 500,
  })
  const trace = traceOf(settled)
  const times = trace.points.map(point => point.timeMs)

  assert.equal(settled.curve.durationMs, 500)
  assert.deepEqual(times, [0, 100, 200, 300, 400, 500])
  assert.equal(new Set(times).size, times.length, 'the shared instant is emitted once')
  assert.equal(trace.points.at(-1).tps, 800, 'hand-computed: 400 * 1000 / 500, rounded')
  assert.deepEqual(trace.points.filter(point => point.publishable).map(point => [point.localMs, point.tps]),
    [[300, 1000], [400, 750], [500, 800]],
    'the episode is publishable at the three vertices it owns after its third delta, endpoint included')
  assertNothingPastTheEnd(settled)
})

test('a one-delta attempt is a single vertex', () => {
  /**
   * One delta at the local zero and no settlement: the attempt owns no time past the
   * instant it produced its only delta, so its trace is the single opening vertex. The
   * measurement is not lost — `tokens` still reports the delta's mass — the vertex is
   * simply the instant at which the attempt both began and ended, and a rate assembled
   * from a single delta over zero elapsed time is not a measurement, so it publishes
   * nothing rather than a zero.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output']])
  const trace = traceOf(settled)

  assert.equal(settled.curve.durationMs, 0, 'a single delta is a zero-width attempt')
  assert.equal(trace.points.length, 1)
  assert.deepEqual(trace.points.map(point => [point.timeMs, point.tps]), [[0, null]],
    'the opening vertex carries no rate: elapsed time is zero, so the measurement is withheld')
  assert.equal(trace.tokens, 100, 'the delta\'s mass is still reported')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [['output', 0, 0]])
  assertNothingPastTheEnd(settled)
})

test('a very long attempt still ends at its own end instant after the series cap', () => {
  /**
   * A 60 s attempt at one delta every 500 ms produces 601 ladder vertices, so the
   * published series is resampled to exactly `MAX_SERIES_POINTS` nearest-neighbour
   * points. The cap is a fidelity decision, not a redefinition of the endpoint: the last
   * resampling target is the end instant itself, so the capped series still closes on it.
   */
  const chunks = []
  for (let at = 0; at <= 60_000; at += 500) chunks.push([at, 'output'])
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), chunks)
  const trace = traceOf(settled)

  assert.equal(settled.curve.durationMs, 60_000)
  assert.equal(trace.sampleCount, 121)
  assert.equal(trace.points.length, MAX_SERIES_POINTS, 'the stored series is capped')
  assert.equal(trace.points[0].timeMs, 0, 'the cap keeps the opening vertex')
  assert.equal(trace.points.at(-1).timeMs, 60_000, 'and it keeps the closing one')
  assert.equal(trace.points.at(-1).localMs, 60_000)
  assertNothingPastTheEnd(settled)
})

// ---------------------------------------------------------------------------
// 4. What the rule must NOT remove
// ---------------------------------------------------------------------------

test('a phase transition is a shared seam, never a blank gap', () => {
  /**
   * Reasoning deltas at 0, 100 and 200 ms, then output deltas at 250, 300 and 350 ms, with
   * the settlement at 350. Every vertex carries a label, so the maximal same-label stretches
   * are adjacent and the two coloured subpaths meet on one vertex — the last vertex of the
   * outgoing stretch. Dropping it would reopen, as a blank horizontal gap, a tone change
   * that is not a stall. The transition also resets the magnitude: the output episode opens
   * on its own clock at 250 ms with its own mass, exactly as the reasoning episode opened on
   * its own at 0.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [
    [0, 'reasoning'], [100, 'reasoning'], [200, 'reasoning'],
    [250, 'output'], [300, 'output'], [350, 'output'],
  ], { settledAtMs: 350 })
  const trace = traceOf(settled)

  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps, point.activePhase]), [
    [0, null, 'reasoning'],
    [100, null, 'reasoning'],
    [200, Math.round(300 * 1000 / 200), 'reasoning'],
    [250, null, 'output'],
    [350, Math.round(300 * 1000 / 100), 'output'],
  ], 'each episode owns its own clock: the transition resets numerator and denominator')
  assert.equal(trace.points[2].tps, 1500, 'the reasoning episode: its three deltas over its own 200 ms')
  assert.equal(trace.points[3].rateUnavailableReason, 'opening-anchor',
    'the seam vertex opens the new episode, so it is not a measurement')
  assert.equal(trace.points.at(-1).tps, 3000, 'the output episode: its three deltas over its own 100 ms')

  assert.deepEqual(visualRunsOf(trace.points).map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 2],
    ['output', 2, 4],
  ], 'the boundary of a label change is the outgoing stretch\'s own last vertex')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 2],
    ['output', 2, 4],
  ])
  assert.equal(trace.runs[0].endIndex, trace.runs[1].startIndex, 'consecutive runs share exactly one vertex')
  assert.equal(trace.runs[0].points.at(-1), trace.runs[1].points[0],
    'the shared seam is one measurement, not two that merely agree')

  /**
   * The view model sees the same seam: the outgoing subpath ends on the coordinate the
   * incoming one opens on, so the tone change is drawn as a joint rather than as a gap.
   */
  const view = curveViewModel(settled)
  const reasoning = view.series.find(series => series.key === 'reasoning')
  const output = view.series.find(series => series.key === 'output')
  const seam = reasoning.runs[0].coordinates.at(-1)
  assert.equal(output.runs[0].coordinates[0].timeMs, seam.timeMs)
  assert.equal(output.runs[0].coordinates[0].x, seam.x)
  assert.ok(seam.x > 0, 'the seam is inside the plot, not on its left edge')
  assertNothingPastTheEnd(settled)
})

// ---------------------------------------------------------------------------
// 5. The pure helpers agree with the settled curve
// ---------------------------------------------------------------------------

test('the pure helpers agree with the settled curve about the end instant', () => {
  /**
   * `attemptTrace` is the pure function `settle()` calls, and `compressAttempts`
   * computes the end instant that is both the segment's width and the trace's last
   * vertex. Rebuilding one attempt from its own evidence must reproduce the published
   * trace exactly, endpoint included.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output']], { settledAtMs: 510 })
  const published = traceOf(settled)

  const compressed = compressAttempts([{
    attemptId: 'a',
    settledAtMs: 510,
    samples: [{ timeMs: 0, phase: 'output', tokens: 100, weight: 100 }],
  }])
  assert.equal(compressed.segments[0].localEndMs, 510)
  assert.equal(compressed.segments[0].endMs, settled.curve.durationMs,
    'the segment width is the attempt\'s own end instant')

  const rebuilt = attemptTrace(compressed.segments[0], compressed.samples)
  assert.deepEqual(
    rebuilt.points.map(point => [point.localMs, point.timeMs, point.tps, point.activePhase]),
    published.points.map(point => [point.localMs, point.timeMs, point.tps, point.activePhase]),
  )
  assert.equal(rebuilt.points.at(-1).timeMs, 510, 'the rebuilt trace ends on the settlement instant too')
})
