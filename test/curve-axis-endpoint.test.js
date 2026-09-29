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
 *   - an end instant that does not fall on the 100 ms cadence is appended as a vertex
 *     of its own, and one that does fall on it is not duplicated;
 *   - an attempt that never settled ends at its last generated delta;
 *   - a phase transition stays a shared seam, never a blank gap.
 *
 * A tool wait and a retry still own zero width, and the attempt that follows still opens
 * on the coordinate its predecessor closed on.
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
   * One delta at the attempt's local zero, then 400 ms of model-attempt time before the
   * settlement. The terminal episode's numerator freezes at the delta's 100 tokens while
   * its denominator advances, so the tail is the hyperbola 100 * 1000 / t, rounded:
   * 1000, 500, 333, 250 — strictly decreasing and never zero by rule.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output']], { settledAtMs: 400 })
  const curve = settled.curve
  const trace = traceOf(settled)

  assert.equal(curve.durationMs, 400, 'the settlement tail is part of the attempt\'s own width')
  assert.equal(trace.localEndMs, 400)
  assert.equal(trace.endMs, 400)
  assert.deepEqual(trace.points.map(point => point.localMs), [0, 100, 200, 300, 400])
  assert.deepEqual(trace.points.map(point => point.tps), [0, 1000, 500, 333, 250],
    'hand-computed: 100 tokens over 100, 200, 300 and 400 ms, rounded')

  const tail = trace.points.slice(1)
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
   * The turn itself runs on for another 5 s after the attempt's last delta, but an
   * unsettled attempt owns no time past the last delta it was seen to produce: nothing
   * was observed there, so nothing is sampled there.
   */
  const { record, settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [100, 'output']])
  const trace = traceOf(settled)

  assert.equal(record.endMs - record.startMs, 5100, 'the turn ran 5.1 s of wall time')
  assert.equal(settled.curve.durationMs, 100, 'an unsettled attempt ends on its last delta')
  assert.equal(trace.localEndMs, 100)
  assert.deepEqual(trace.points.map(point => [point.timeMs, point.tps]), [[0, 0], [100, 2000]],
    'hand-computed: the attempt\'s own 200 tokens over its own 100 ms')
  assert.equal(trace.points.at(-1).timeMs, 100)
  assertNothingPastTheEnd(settled)
})

// ---------------------------------------------------------------------------
// 3. The endpoint anchor
// ---------------------------------------------------------------------------

test('an off-grid end instant is appended as a vertex of its own', () => {
  /**
   * A pure 100 ms ladder would give `0 … 500` and omit 510, the instant the attempt's
   * clock stopped. The vertex set is the union of the cadence and the attempt's own end
   * instant, so 510 is drawn.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output']], { settledAtMs: 510 })
  const trace = traceOf(settled)

  assert.equal(settled.curve.durationMs, 510)
  assert.deepEqual(trace.points.map(point => point.timeMs), [0, 100, 200, 300, 400, 500, 510],
    'the cadence grid union the real end instant, deduplicated and ascending')
  assert.notEqual(510 % 100, 0, 'the end instant really is off the cadence')
  assert.equal(trace.points.at(-1).timeMs, 510, 'the last vertex is the instant the attempt ended')
  assert.equal(trace.points.at(-1).tps, 196, 'hand-computed: 100 * 1000 / 510, rounded')
  assertNothingPastTheEnd(settled)
})

test('an end instant that falls exactly on the cadence is not duplicated', () => {
  /**
   * The final delta and the settlement coincide at 500 ms, which is already a ladder
   * point. The union must emit that instant once: the end vertex is appended only when
   * it does not fall on the cadence.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [500, 'output']], {
    settledAtMs: 500,
  })
  const trace = traceOf(settled)
  const times = trace.points.map(point => point.timeMs)

  assert.equal(settled.curve.durationMs, 500)
  assert.deepEqual(times, [0, 100, 200, 300, 400, 500])
  assert.equal(new Set(times).size, times.length, 'the shared instant is emitted once')
  assert.equal(trace.points.at(-1).tps, 400,
    'hand-computed: the second delta is inside the episode at the attempt\'s end')
  assertNothingPastTheEnd(settled)
})

test('a one-delta attempt is a single vertex', () => {
  /**
   * One delta at the local zero and no settlement: the attempt owns no time past the
   * instant it produced its only delta, so its trace is the single opening anchor. The
   * measurement is not lost — `tokens` still reports the delta's mass — the vertex is
   * simply the instant at which the attempt both began and ended.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output']])
  const trace = traceOf(settled)

  assert.equal(settled.curve.durationMs, 0, 'a single delta is a zero-width attempt')
  assert.equal(trace.points.length, 1)
  assert.deepEqual(trace.points.map(point => [point.timeMs, point.tps]), [[0, 0]],
    'the opening vertex carries no rate: elapsed time is zero')
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
   * Reasoning deltas at 0 and 100 ms, then output deltas at 200 and 300 ms, settled at
   * 350. Every vertex carries a label, so the maximal same-label stretches are adjacent
   * and the two coloured subpaths meet on one vertex — the last vertex of the outgoing
   * stretch. Dropping it would reopen, as a blank horizontal gap, a tone change that is
   * not a stall. The transition also resets the magnitude: the output episode opens on
   * its own clock at 200, exactly as the reasoning episode opened on its own at 0.
   */
  const { settled } = driveOneAttempt(new TurnTelemetryStore(), [
    [0, 'reasoning'], [100, 'reasoning'], [200, 'output'], [300, 'output'],
  ], { settledAtMs: 350 })
  const trace = traceOf(settled)

  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps, point.activePhase]), [
    [0, 0, 'reasoning'],
    [100, 2000, 'reasoning'],
    [200, 0, 'output'],
    [300, 2000, 'output'],
    [350, 1333, 'output'],
  ], 'each episode owns its own clock: the transition resets numerator and denominator')

  assert.deepEqual(visualRunsOf(trace.points).map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 1],
    ['output', 1, 4],
  ], 'the boundary of a label change is the outgoing stretch\'s own last vertex')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 1],
    ['output', 1, 4],
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
