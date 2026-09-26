/**
 * The total rolling trace, scenario by scenario.
 *
 * `test/curve-reference-window.test.js` checks the arithmetic against an independent
 * brute-force reference; `test/curve-regression-matrix.test.js` holds one named scenario per
 * frozen semantic. This file is the **acceptance matrix** for the two semantics Phase 7C
 * introduced, stated as the smallest case that can distinguish them from their predecessors:
 *
 *   - the completed curve is one attempt-local trailing-one-second **total** throughput trace
 *     per model attempt, over every phase (`docs/METRICS_SPEC.md` §8.2);
 *   - the rolling window resets at every attempt, tool gap and retry, while an
 *     **intra-attempt** stall keeps its full width and decays visibly to zero (§8.5, §8.6).
 *
 * Each scenario also asserts the property a chart reader depends on most: that a phase change
 * is a colour hand-off rather than a horizontal gap, and that a tool gap consumes no x-axis
 * width. Every expected rate is written as a multiple of `RATE`, the rate one delta sustains
 * alone, so the numbers are derived from the window definition rather than transcribed from a
 * run.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'
import { DEFAULT_SAMPLE_EVERY_MS, peakTps } from '../src/core/curve.js'

/**
 * Every delta in this file weighs exactly 100 raw shape units — 400 Latin characters at the
 * documented four-characters-per-token prior — so a one-second window holding one of them
 * reads `100 tokens/s` and every expected value below is a whole multiple of it.
 */
const DELTA_CHARACTERS = 400
const DELTA_WEIGHT = 100
/** The rate one delta sustains alone: its weight over a one-second window. */
const RATE = DELTA_WEIGHT
/** Two such deltas inside one window. */
const TWICE = 2 * RATE

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })

/** One delta weighing exactly `DELTA_WEIGHT`, asserted rather than assumed. */
function weighing(kind) {
  const text = 'x'.repeat(DELTA_CHARACTERS)
  assert.equal(heuristicTokenWeight(text), DELTA_WEIGHT,
    `the generator assumes ${DELTA_CHARACTERS} characters weigh ${DELTA_WEIGHT}`)
  return kind === 'reasoning' ? reasoning(text) : output(text)
}

/**
 * Drive a turn from a script on the **attempt-local** clock.
 *
 * `attempts` entries are `{ id, step, local: [[localMs, kind], ...], retried?, tools? }`; a
 * tool is `{ durationMs }` and is placed after the attempt's last delta, so the tool gap is
 * real wall time that the compressed axis removes.
 */
function drive(attempts, { endPaddingMs = 2000 } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  let offsetMs = 0
  let maxWallMs = 0
  for (const spec of attempts) {
    const attempt = store.beginAttempt(record, { attemptId: spec.id, step: spec.step, startedAtMs: offsetMs })
    for (const [localMs, kind] of [...(spec.local ?? [])].sort((a, b) => a[0] - b[0])) {
      const wallMs = offsetMs + localMs
      store.acceptChunk(record, attempt, { timeMs: wallMs, chunk: weighing(kind) })
      maxWallMs = Math.max(maxWallMs, wallMs)
    }
    store.settleAttempt(attempt, {
      settledAtMs: maxWallMs + 1,
      settlementKind: spec.retried === true ? 'attempt' : 'message',
      surfaceCommitted: spec.retried !== true,
      attemptOutcome: spec.retried === true ? 'retried' : 'committed',
      settlementSeq: spec.step,
    })
    const span = (spec.local ?? []).length === 0
      ? 0
      : Math.max(...spec.local.map(entry => entry[0]))
    offsetMs += span
    for (const [index, tool] of (spec.tools ?? []).entries()) {
      store.toolStarted(record, { callId: `${spec.id}-t${index}`, name: 'pwsh', timeMs: offsetMs + 10 })
      store.toolSettled(record, {
        callId: `${spec.id}-t${index}`,
        timeMs: offsetMs + 10 + tool.durationMs,
        status: 'ok',
      })
    }
    offsetMs += 100
  }
  const curve = store.endTurn(record, { timeMs: maxWallMs + endPaddingMs, status: 'completed' }).curve
  return { store, record, curve }
}

const traceOf = (curve, id) => curve.attempts.find(attempt => attempt.attemptId === id)

/** Local instants and rates, as the compact form every scenario asserts against. */
const ladder = trace => trace.points.map(point => [point.localMs, point.tps])

/** Rate of one vertex, by attempt-local instant, or `undefined`. */
const at = (trace, localMs) => trace.points.find(point => point.localMs === localMs)?.tps

/* ------------------------------------------------------------------ 1-3. single phase */

test('a reasoning-only attempt is one reasoning-coloured run', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: [[0, 'reasoning'], [500, 'reasoning']] }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(ladder(trace), [
    [0, RATE], [250, RATE], [500, TWICE],
  ], 'one delta, then two inside the window at the attempt\'s own final delta, where the trace stops')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning'], 'one phase, one coloured run')
  assert.equal(curve.series.find(entry => entry.key === 'reasoning').present, true)
  assert.deepEqual(curve.series.find(entry => entry.key === 'output').runs, [],
    'a phase with no evidence has no run, and is never a flat zero line')
  assert.equal(curve.peakTps, TWICE)
})

test('an output-only attempt is one output-coloured run', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['output'])
  assert.deepEqual(curve.series.find(entry => entry.key === 'reasoning').runs, [])
  assert.equal(curve.peakTps, TWICE)
})

test('reasoning then output inside one window is one rate with two tones', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: [[0, 'reasoning'], [500, 'output']] }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning', 'output'],
    'two stretches of one trace, two coloured subpaths')
  const [first, second] = trace.runs
  assert.equal(first.points.at(-1), second.points[0],
    'the tone changes on a shared boundary vertex, not across a gap')
  assert.equal(at(trace, 500), TWICE,
    'and that vertex measures both contributions in one window')
  assert.deepEqual(trace.points.filter(point => point.localMs <= 500).map(point => point.tps),
    [RATE, RATE, TWICE])
  /**
   * The rate never resets at a colour boundary: it is one trailing window throughout, and the
   * attempt's own end is the last vertex it has. The window's later behaviour — the reasoning
   * delta expiring one second after it arrived — lies past that end, so it is not drawn; the
   * attempt's whole width is what the axis measures (`docs/METRICS_SPEC.md` §8.1).
   */
  assert.equal(trace.points.at(-1).localMs, 500)
})

test('reasoning -> output after more than one window leaves a visible zero between them', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: [[0, 'reasoning'], [3000, 'output']] }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning', 'output'])
  assert.equal(at(trace, 2000), 0, 'the silence is a value on the trace, not a hole in it')
  assert.equal(at(trace, 3000), RATE, 'and the resumption measures its own window alone')
  assert.equal(trace.runs[0].points.at(-1).timeMs, trace.runs[1].points[0].timeMs,
    'the two tones still meet, on the vertex where the phase changes')
})

test('reasoning -> output -> reasoning alternates tones without splitting the measurement', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [500, 'reasoning'], [3000, 'output'], [3500, 'output'], [7000, 'reasoning']],
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning', 'output', 'reasoning'])
  for (let index = 1; index < trace.runs.length; index += 1) {
    assert.equal(trace.runs[index - 1].points.at(-1).timeMs, trace.runs[index].points[0].timeMs)
  }
  assert.equal(at(trace, 3500), TWICE, 'the output burst is measured in full')
  assert.equal(at(trace, 2000), 0, 'and each silence is a real zero')
})

/* ----------------------------------------------------------------- 6-7. intra-attempt stall */

test('a long internal stall decays visibly to zero and then resumes', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: [[0, 'output'], [4000, 'output']] }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(ladder(trace), [
    [0, RATE], [250, RATE], [500, RATE], [750, RATE],
    [1000, 0], [1250, 0], [1500, 0], [1750, 0], [2000, 0], [2250, 0], [2500, 0], [2750, 0],
    [3000, 0], [3250, 0], [3500, 0], [3750, 0],
    [4000, RATE],
  ], 'the stall is twelve whole 250 ms vertices of measured zero, and the trace climbs again on the '
    + 'resumed delta — which is also where it ends, because the model stopped producing there')
  assert.equal(trace.runs.length, 1, 'a stall is not a phase change, so it is not a new run')
  assert.equal(curve.durationMs, 4000, 'and the stall keeps its full width on the axis')
  assert.equal(trace.points.at(-1).timeMs, curve.durationMs,
    'the trace ends on the axis end rather than on a decay past it')
  assert.equal(curve.peakTps, RATE,
    'two deltas four windows apart never share a window, so the peak is one delta')
})
/* --------------------------------------------------------------- 8. tool gaps have no width */

test('a tool gap consumes zero x-axis width and still resets the window', () => {
  const withoutTool = drive([
    { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] },
    { id: 'b', step: 2, local: [[0, 'output'], [500, 'output']] },
  ])
  const withTool = drive([
    { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']], tools: [{ durationMs: 60_000 }] },
    { id: 'b', step: 2, local: [[0, 'output'], [500, 'output']] },
  ])
  assert.deepEqual(
    withTool.curve.attempts.map(attempt => ladder(attempt)),
    withoutTool.curve.attempts.map(attempt => ladder(attempt)),
    'a 60 s tool makes no difference at all to the drawn trace',
  )
  assert.equal(withTool.curve.durationMs, withoutTool.curve.durationMs)
  assert.equal(withTool.curve.durationMs, 1000, 'the axis is model generation only')
  assert.deepEqual(withTool.curve.segments.map(segment => [segment.startMs, segment.endMs]),
    [[0, 500], [500, 1000]], 'the two calls are adjacent after compression')
})

/* ------------------------------------------------------------------- 9-11. attempt boundaries */

test('the next attempt resets the window and the boundary is a subpath break', () => {
  const { curve } = drive([
    { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']], tools: [{ durationMs: 30_000 }] },
    { id: 'b', step: 2, local: [[0, 'output'], [2500, 'output']] },
  ])
  const first = traceOf(curve, 'a')
  const second = traceOf(curve, 'b')
  /**
   * Attempt A ends on its own last delta; attempt B opens on that same coordinate and runs to
   * its own end. The previous expectation gave B four vertices of one-window decay past its
   * last delta — and, before that, gave A a cut it no longer needs, since A's own end *is* the
   * coordinate B begins at. The values that survive carry what each call's own window produced.
   */
  assert.deepEqual(ladder(first), [[0, RATE], [250, RATE], [500, TWICE]],
    'A stops on its own strongest measurement, both of its deltas still inside the window')
  assert.deepEqual(ladder(second), [
    [0, RATE], [250, RATE], [500, RATE], [750, RATE],
    [1000, 0], [1250, 0], [1500, 0], [1750, 0], [2000, 0], [2250, 0],
    [2500, RATE],
  ], 'attempt B never inherits attempt A\'s trailing tokens: its two deltas are two and a half '
    + 'seconds apart, so the window is empty between them and the peak is one delta')

  assert.equal(second.startMs, first.startMs + 500,
    'the two traces occupy adjacent compressed stretches')
  assert.deepEqual(first.runs.map(run => run.attemptId), ['a'])
  assert.deepEqual(second.runs.map(run => run.attemptId), ['b'])
  /** Two separate subpaths: no drawable path joins the two attempts. */
  const paths = [...first.runs, ...second.runs]
  assert.equal(paths.length, 2, 'one subpath per attempt here')
  assert.equal(paths[0].points.at(-1).attemptId, 'a')
  assert.equal(paths[1].points[0].attemptId, 'b')
  /** The two attempts meet at one coordinate and report their own numbers there. */
  assert.equal(first.points.at(-1).timeMs, second.points[0].timeMs)
  assert.equal(first.points.at(-1).tps, TWICE,
    'A closes on its own strongest measurement, both of its deltas still inside the window')
  assert.equal(second.points[0].tps, RATE,
    'and B opens on its first delta alone, which is a different number from the same coordinate')
})

test('a retry resets the window just as a new attempt does', () => {
  const { curve } = drive([
    { id: 'first', step: 1, local: [[0, 'output'], [500, 'output']], retried: true },
    { id: 'second', step: 1, local: [[0, 'output'], [500, 'output']] },
  ])
  const first = traceOf(curve, 'first')
  const second = traceOf(curve, 'second')
  assert.equal(second.startMs, first.startMs + 500,
    'the abandoned prefix keeps its own half-second, and the successor begins after it')
  assert.deepEqual(ladder(first), [[0, RATE], [250, RATE], [500, TWICE]],
    'the abandoned prefix ends on its own last coordinate, which the successor takes over')
  assert.deepEqual(ladder(second), [
    [0, RATE], [250, RATE], [500, TWICE],
  ], 'and the retry measures its own window alone, ending on its own last delta')
})

/* ---------------------------------------------------- 12-13. colour is not a statistical reset */

test('a phase boundary is a colour change, never a statistical reset or an x gap', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [250, 'reasoning'], [500, 'output'], [750, 'output'], [1000, 'output']],
  }])
  const trace = traceOf(curve, 'a')
  const [first, second] = trace.runs
  assert.equal(first.phase, 'reasoning')
  assert.equal(second.phase, 'output')

  /** Shared boundary vertex: same instant, same measured rate, one object. */
  assert.equal(first.points.at(-1), second.points[0])
  assert.equal(first.points.at(-1).timeMs, second.points[0].timeMs)
  assert.equal(first.points.at(-1).tps, second.points[0].tps)
  /**
   * The seam is the outgoing stretch's last labelled vertex, which is the last one still
   * labelled `reasoning`. Both subpaths draw it, so the tone changes on a measured vertex
   * rather than across a gap; the vertex keeps the phase the meter was reporting at that
   * instant, which is exactly what `streamingPhase` would have said. (An earlier revision
   * described this as the midpoint of the label change; the two stretch boundaries are
   * adjacent indices, so the formula evaluated to this same vertex.)
   */
  assert.equal(first.points.at(-1).activePhase, 'reasoning')
  assert.equal(second.points[0].activePhase, 'reasoning')
  const afterSeam = second.points[1]
  assert.equal(afterSeam.activePhase, 'output',
    'and the next vertex the output subpath draws is the first one labelled with the new phase')

  /** The trace is contiguous: consecutive vertices are one sampling step apart throughout. */
  for (let index = 1; index < trace.points.length; index += 1) {
    assert.equal(trace.points[index].localMs - trace.points[index - 1].localMs, DEFAULT_SAMPLE_EVERY_MS,
      'no vertex of the trace is missing, across the colour change or anywhere else')
  }
  /** And the seam is charged once per subpath, which is what the budget counts. */
  assert.equal(first.pointCount + second.pointCount, trace.points.length + 1)
})

/* ---------------------------------------------------------------- 14. the peak, independently */

test('the global peak is the maximum over every attempt-local total vertex', () => {
  const { curve } = drive([
    { id: 'a', step: 1, local: [[0, 'reasoning'], [500, 'output']], tools: [{ durationMs: 10_000 }] },
    { id: 'b', step: 2, local: [[0, 'output'], [250, 'output'], [500, 'output']] },
    { id: 'c', step: 3, local: [[0, 'reasoning'], [250, 'reasoning'], [500, 'reasoning'], [750, 'reasoning']] },
  ])
  const reference = Math.max(...curve.attempts.map(attempt => peakTps(attempt.points)))
  assert.equal(curve.peakTps, reference)
  const owner = curve.attempts.find(attempt => peakTps(attempt.points) === reference)
  assert.equal(owner.attemptId, 'c',
    'four reasoning deltas inside one window are the fastest burst in this turn')
  assert.equal(reference, 4 * RATE)
  /** The two other bursts are strictly weaker, so the peak is not a tie. */
  assert.deepEqual(curve.attempts.map(attempt => peakTps(attempt.points)),
    [TWICE, 3 * RATE, 4 * RATE])
  /** And no run reports more than the trace it was cut from. */
  for (const attempt of curve.attempts) {
    for (const run of attempt.runs) {
      assert.ok(run.peak <= peakTps(attempt.points) + 1e-9)
    }
  }
})

test('the curve publishes its magnitude provenance, and the fallback is explicit', () => {
  const calibrated = drive([{ id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }])
  assert.equal(calibrated.curve.source.aligned, true)
  assert.deepEqual(calibrated.curve.source.issues, [])

  /**
   * The store path always produces an aligned join — the two lists come from one reduction —
   * so the degradation branch is exercised in `test/curve-source.test.js` against the pure
   * function. What this asserts is the shape a caller can rely on: the provenance travels
   * with the curve and is a boolean rather than an absent field.
   */
  assert.equal(typeof calibrated.curve.source.calibrated, 'boolean')
  assert.equal(calibrated.curve.source.contributingAttemptCount, 1)
  assert.deepEqual(calibrated.curve.source.rawFallbackAttemptIds, [])
})
