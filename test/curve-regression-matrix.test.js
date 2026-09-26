/**
 * The completed-curve regression matrix.
 *
 * `test/curve-attempt-boundary.test.js` is the counterexample file: it proves the
 * Phase 5 defect existed and that the Phase 6 construction fixes it. This file is
 * the **matrix**: one named scenario per frozen curve semantic, so a future change
 * that fixes one behaviour and quietly breaks another is caught by name rather
 * than by a single large assertion block.
 *
 * Two semantics are frozen here and they are independent of each other
 * (`docs/METRICS_SPEC.md` §8.2, §8.6):
 *
 *   - tool time is compressed to zero width on the x-axis, but the one-second
 *     rolling window is a property of one model attempt and is never concatenated
 *     across attempts with it;
 *   - within one attempt the window is **total** and covers every generated sample,
 *     whatever its phase. Reasoning and output are colours of one measurement, so a
 *     stall inside an attempt is a visible decay on one continuous trace rather than
 *     a split into separate per-phase episodes.
 *
 * ## What changed in Phase 7C, and why the expectations below look different
 *
 * The previous revision cut each attempt's evidence into **per-phase episodes** and
 * gave every episode its own run with its own one-window tail. Two consequences
 * followed, and both are now asserted **not** to happen:
 *
 *   - a phase that fell silent for more than one window produced a second run, so a
 *     single model call could appear as several disconnected traces. The stall was
 *     then drawn as a *blank* region between two runs rather than as the decay to
 *     zero it actually is;
 *   - measuring each phase separately meant no drawn line ever equalled the live
 *     pill, which reports reasoning **plus** output tokens in one window.
 *
 * The scenarios below keep their names and their inputs, and state the corrected
 * expectation with the reason it changed.
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
import { heuristicTokenWeight } from '../src/core/token-allocation.js'

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })

/**
 * Build a turn from a compact script.
 *
 * `attempts` entries are `{ id, step, at, chunks: [[wallMs, kind, text]], usage }`;
 * `tools` entries are `{ callId, name, startMs, endMs }`.
 */
function build({ attempts = [], tools = [], endMs = 0, status = 'completed' } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const stored = new Map()
  for (const spec of attempts) {
    const attempt = store.beginAttempt(record, { attemptId: spec.id, step: spec.step, startedAtMs: spec.at })
    stored.set(spec.id, attempt)
    for (const [timeMs, kind, text] of spec.chunks ?? []) {
      store.acceptChunk(record, attempt, { timeMs, chunk: kind === 'reasoning' ? reasoning(text) : output(text) })
    }
    store.settleAttempt(attempt, {
      settledAtMs: spec.settledAtMs ?? spec.at,
      settlementKind: spec.settlementKind ?? 'message',
      surfaceCommitted: spec.surfaceCommitted ?? true,
      attemptOutcome: spec.attemptOutcome ?? 'committed',
      usage: spec.usage ?? null,
      settlementSeq: spec.settlementSeq ?? 1,
    })
  }
  for (const tool of tools) {
    store.toolStarted(record, { callId: tool.callId, name: tool.name, timeMs: tool.startMs })
    store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status ?? 'ok' })
  }
  const settled = store.endTurn(record, { timeMs: endMs, status })
  return { store, record, stored, settled, curve: settled.curve }
}

/** The runs of one phase, in draw order. Each is a slice of an attempt's total trace. */
function runsOf(curve, key) {
  return curve.series.find(series => series.key === key).runs
}

/** One attempt's full trace, by attempt id. */
function attemptOf(curve, id) {
  return curve.attempts.find(candidate => candidate.attemptId === id)
}

/**
 * Expected rate at one attempt-local instant, derived from the **script** rather than
 * from the curve.
 *
 * It is the literal trailing window over every generated delta of the attempt, on the
 * attempt-local clock, using the same shape estimator production uses so that the
 * weights are not a second variable. The script is ground truth: reading the expected
 * rates back out of the curve's own `tps` column would be reading the answer off the
 * thing being checked.
 */
function referenceTps(chunks, attemptStartMs, atMs, windowMs = DEFAULT_WINDOW_MS) {
  let tokens = 0
  for (const [wallMs, , text] of chunks) {
    const localMs = wallMs - attemptStartMs
    if (localMs <= atMs && localMs > atMs - windowMs) tokens += heuristicTokenWeight(text)
  }
  return tokens * 1000 / windowMs
}

/** The 250 ms cadence ladder an attempt's trace is drawn on, from local zero to `toMs`. */
function gridTo(toMs) {
  const out = []
  for (let at = 0; at <= toMs + 1e-9; at += DEFAULT_SAMPLE_EVERY_MS) out.push(at)
  return out
}

/**
 * The attempt's sampled instants: the cadence ladder to its last delta, unioned with that
 * last delta when it does not fall on a whole step.
 *
 * The anchor is what makes the attempt's real endpoint a vertex; deduplication is what keeps
 * an on-cadence endpoint from appearing twice. There is no second ladder — since Phase 7C.1
 * every attempt, the final one included, stops where the model stopped producing.
 */
function instantsTo(lastSampleMs) {
  const out = gridTo(lastSampleMs)
  if (out[out.length - 1] < lastSampleMs - 1e-9) out.push(lastSampleMs)
  return out
}

/**
 * Assert every vertex of one attempt's trace against the script-derived window.
 *
 * `lastSampleMs` is the attempt's own last model-producing instant on its local clock, which
 * is both the endpoint anchor and the trace's final coordinate.
 */
function assertTraceMatchesScript(curve, spec, { toMs, lastSampleMs = toMs, expect = null } = {}) {
  const attempt = attemptOf(curve, spec.id)
  assert.ok(attempt !== undefined, `the curve carries attempt ${spec.id}`)
  assert.deepEqual(attempt.points.map(point => point.localMs), instantsTo(lastSampleMs),
    `${spec.id}: the trace is sampled on the attempt's own cadence, ending on its last delta`)
  const expected = instantsTo(lastSampleMs).map(at => referenceTps(spec.chunks, spec.at, at))
  assert.deepEqual(attempt.points.map(point => point.tps), expected,
    `${spec.id}: every vertex is the trailing one-second total over the script`)
  if (expect !== null) assert.deepEqual(attempt.points.map(point => point.tps), expect, `${spec.id}: named expectation`)
  return attempt
}

test('the window resets at an attempt boundary', () => {
  /**
   * Two attempts of two measurements each, with a 60 s tool between them. Attempt A
   * ends on 200 tokens/s; attempt B's own measurements are a tenth of that. If the
   * window crossed the boundary, B's opening vertices would inherit A's trailing 100.
   */
  const a = { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)], [1000, 'output', 'x'.repeat(400)]] }
  const b = { id: 'b', step: 2, at: 10_100, chunks: [[10_100, 'output', 'y'.repeat(40)], [11_100, 'output', 'y'.repeat(40)]] }
  const { curve } = build({
    attempts: [a, b],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 1100, endMs: 10_000 }],
    endMs: 12_000,
  })

  const traceA = assertTraceMatchesScript(curve, a, { toMs: 1000 })
  const traceB = assertTraceMatchesScript(curve, b, { toMs: 2000, lastSampleMs: 1000 })
  assert.deepEqual(traceA.points.map(point => point.tps), [100, 100, 100, 100, 100],
    'attempt A is measured on its own clock; at the shared coordinate its window is `(0, 1000]`, '
    + 'which holds the second delta alone because the first expired at exactly 0')
  assert.equal(traceB.points[0].timeMs, traceA.points.at(-1).timeMs,
    'the two traces meet at one compressed coordinate and share no window')
  assert.deepEqual(traceB.points.map(point => point.tps), [10, 10, 10, 10, 10],
    'attempt B starts from an empty window, whatever attempt A measured')
  assert.equal(runsOf(curve, 'output')[1].peak, 10)
  assert.equal(curve.peakTps, 100, 'the peak is a per-attempt maximum')
})

test('a previous attempt\'s tokens cannot enter the next attempt\'s window', () => {
  /**
   * The strongest form: attempt A streams heavily up to the last instant before
   * the boundary, and attempt B produces a single small delta. Every vertex
   * attributed to B must be bounded by B's own total.
   */
  const a = {
    id: 'a',
    step: 1,
    at: 0,
    chunks: [
      [0, 'output', 'x'.repeat(4000)],
      [250, 'output', 'x'.repeat(4000)],
      [400, 'output', 'x'.repeat(4000)],
    ],
  }
  const b = { id: 'b', step: 2, at: 30_000, chunks: [[30_000, 'output', 'y'.repeat(8)]] }
  const { curve } = build({
    attempts: [a, b],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 500, endMs: 29_000 }],
    endMs: 31_000,
  })
  const traceB = attemptOf(curve, 'b')
  assert.equal(traceB.tokens, 2, 'attempt B produced two estimated tokens')
  assert.equal(runsOf(curve, 'output')[1].peak, 2, 'its ceiling is two tokens per second, and it reaches it')
  for (const point of traceB.points) {
    assert.ok(point.tps <= 2, `${point.timeMs} claims ${point.tps} from a two-token attempt`)
  }
  assert.ok(curve.peakTps >= 1000, 'attempt A\'s own peak is large and unaffected')
})

test('tool time has zero x width and still resets the window', () => {
  /** The two halves of the invariant, asserted separately so neither can hide. */
  const { curve } = build({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)], [1000, 'output', 'x'.repeat(400)]] },
      { id: 'b', step: 2, at: 121_000, chunks: [[121_000, 'output', 'y'.repeat(40)]] },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 1100, endMs: 120_000 }],
    endMs: 122_000,
  })
  /**
   * Zero width: a 119 s tool contributes nothing, so the axis is exactly the two
   * attempts' own spans.
   */
  assert.equal(curve.durationMs, 1000, 'the axis measures model generation only')
  assert.equal(curve.segments[0].endMs, curve.segments[1].startMs,
    'attempt B starts exactly where attempt A ended')
  /** And the window still reset, because the axis being continuous is not a window. */
  assert.equal(runsOf(curve, 'output')[1].points[0].tps, 10)
})

test('a retry resets the completed window', () => {
  const { curve } = build({
    attempts: [
      {
        id: 'first',
        step: 1,
        at: 0,
        chunks: [[0, 'output', 'a'.repeat(800)], [500, 'output', 'a'.repeat(800)]],
        settlementKind: 'attempt',
        surfaceCommitted: false,
        attemptOutcome: 'retried',
      },
      { id: 'second', step: 1, at: 600, chunks: [[600, 'output', 'b'.repeat(80)], [1100, 'output', 'b'.repeat(80)]] },
    ],
    endMs: 2200,
  })
  const first = attemptOf(curve, 'first')
  const second = attemptOf(curve, 'second')
  assert.deepEqual(first.points.map(p => p.tps), [200, 200, 400])
  assert.deepEqual(second.points.map(p => p.tps), [20, 20, 40],
    'the retry is measured on its own window, from its own first delta to its own last')
  assert.equal(second.points[0].timeMs, first.points.at(-1).timeMs,
    'and it still opens at the abandoned attempt\'s last coordinate')
  assert.equal(runsOf(curve, 'output')[1].peak, 40)
})

test('attempt A\'s peak does not inflate attempt B\'s, and B\'s does not raise the turn peak above A\'s', () => {
  const { curve } = build({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(4000)], [1000, 'output', 'x'.repeat(4000)]] },
      { id: 'b', step: 2, at: 11_000, chunks: [[11_000, 'output', 'y'.repeat(40)], [12_000, 'output', 'y'.repeat(40)]] },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 1100, endMs: 10_000 }],
    endMs: 14_000,
  })
  const traceA = attemptOf(curve, 'a')
  const traceB = attemptOf(curve, 'b')
  assert.equal(peakTps(traceA.points), 1000, 'attempt A: its 2000 tokens measured across a half-open window')
  assert.equal(peakTps(traceB.points), 10, 'attempt B: its own 20 tokens, ten times smaller')
  assert.equal(curve.peakTps, peakTps(...curve.attempts.map(attempt => attempt.points)))
  assert.equal(curve.peakTps, 1000, 'the turn peak is the larger single-attempt maximum')
  assert.notEqual(curve.peakTps, 1010, 'and never the two added together')
})

test('a phase falling silent inside one attempt is one continuous trace, not two runs', () => {
  /**
   * `Reasoning -> Output -> Reasoning` with a 3 s output stretch.
   *
   * The previous revision split the reasoning evidence into two episodes and drew two
   * runs, leaving a blank horizontal region between them across the output-only
   * stretch. That region was then read as "reasoning stopped", which is true, but the
   * trace it belongs to is the attempt's total rate, and that rate did not stop: it
   * fell to zero when the model went quiet and recovered when reasoning resumed.
   *
   * Both facts are now visible in one trace per attempt. The correction is not a
   * cosmetic merge: it is what makes the stall visible as a stall.
   */
  const spec = {
    id: 'a',
    step: 1,
    at: 0,
    chunks: [
      [0, 'reasoning', 'r1'],
      [500, 'reasoning', 'r2'],
      [3000, 'output', 'o1'],
      [4000, 'output', 'o2'],
      [8000, 'reasoning', 'r3'],
      [8500, 'reasoning', 'r4'],
    ],
  }
  const { curve } = build({ attempts: [spec], endMs: 10_000 })
  assert.equal(curve.attempts.length, 1, 'one model call, one trace')
  const trace = assertTraceMatchesScript(curve, spec, { toMs: 8500 })

  /**
   * The output stretch is a **colour change**, not a break: the reasoning run ends on
   * the vertex the output run begins on, so the two subpaths meet and the tone is the
   * only thing that changes.
   */
  const reasonRuns = runsOf(curve, 'reasoning')
  /**
   * Two reasoning stretches of one trace, two coloured runs. The seam is the outgoing
   * stretch's last labelled vertex, so a long silence is carried by the tone that was
   * active across it rather than being repainted — and the two runs still meet, so no blank
   * horizontal gap is introduced. (The previous revision described this cut as the
   * "midpoint of the label change"; the two stretch boundaries are adjacent indices, so the
   * midpoint the formula computed was algebraically that same last vertex. The formula was
   * removed in Phase 7C.1 and the seam is unchanged.)
   */
  assert.equal(reasonRuns.length, 2, 'two reasoning stretches of one trace, two coloured runs')
  assert.deepEqual(reasonRuns.map(run => [run.startMs, run.endMs]), [[0, 2750], [7750, 8500]])
  const outputRuns = runsOf(curve, 'output')
  assert.equal(outputRuns.length, 1)
  assert.equal(outputRuns[0].startMs, reasonRuns[0].points.at(-1).timeMs,
    'and the output run starts exactly where the first reasoning run ends: the phase-transition seam')
  /** Consecutive runs of the attempt meet on one shared vertex throughout. */
  for (let index = 1; index < trace.runs.length; index += 1) {
    assert.equal(trace.runs[index - 1].points.at(-1), trace.runs[index].points[0],
      'a tone change is a shared vertex, not a gap')
  }

  /**
   * The silence between the two reasoning stretches is drawn: at 6000 ms the trailing
   * window holds nothing at all, and the trace reads zero.
   */
  const at6000 = trace.points.find(point => point.localMs === 6000)
  assert.equal(at6000.tps, 0, 'a real delivery stall is drawn as a real zero')
  assert.equal(at6000.activePhase, 'output', 'and it is labelled with the phase that last produced')

  /**
   * No vertex of any run leaves its own attempt, and every vertex is one the script
   * supports.
   */
  for (const run of [...reasonRuns, ...outputRuns]) {
    for (const point of run.points) {
      assert.equal(point.attemptId, 'a', 'every run vertex belongs to its own attempt')
      assert.equal(point.tps, referenceTps(spec.chunks, spec.at, point.localMs))
    }
  }
})

test('an output stretch that falls silent is one run whose rate decays to zero', () => {
  const spec = {
    id: 'a',
    step: 1,
    at: 0,
    chunks: [
      [0, 'output', 'o1'],
      [500, 'output', 'o2'],
      [5000, 'reasoning', 'r1'],
      [5500, 'reasoning', 'r2'],
      [9000, 'output', 'o3'],
      [9500, 'output', 'o4'],
    ],
  }
  const { curve } = build({ attempts: [spec], endMs: 11_000 })
  const trace = attemptOf(curve, 'a')
  const outRuns = runsOf(curve, 'output')
  assert.equal(outRuns.length, 2, 'two output stretches, two coloured runs of one trace')
  assert.deepEqual(outRuns.map(run => [run.startMs, run.endMs]), [[0, 4750], [8750, 9500]])
  /** The transitions in between are shared seams on adjacent vertices, not gaps. */
  for (let index = 1; index < trace.runs.length; index += 1) {
    assert.equal(trace.runs[index - 1].points.at(-1), trace.runs[index].points[0])
  }

  /**
   * The previous expectation was `[[0, 1500], [9000, 10500]]`: each stretch got its own
   * one-window tail and the reasoning stretch in between was left blank. The trace now
   * runs continuously across it, so the first output run reaches the reasoning
   * transition and the blank region is gone — the reasoning run occupies it, and the
   * rate over it is the attempt's own. Phase 7C.1 then removed the closing tail the run
   * used to carry past the attempt's last delta, so the second output run now ends on
   * 9500 rather than 10 500.
   */
  assert.equal(trace.points.find(point => point.localMs === 3000).tps, 0,
    'the silent stretch is a zero on the trace, not a hole in it')
  for (const run of outRuns) {
    assert.equal(run.points.every(p => p.timeMs >= run.startMs && p.timeMs <= run.endMs), true,
      `${run.startMs}-${run.endMs} carries only its own vertices`)
  }
})

test('a same-phase gap is a decay on one run, whatever its length', () => {
  /**
   * The previous revision split a phase's evidence into episodes whenever two of its
   * samples were further apart than one window. That rule is about where the *phase*
   * has evidence, and it was being applied to the *drawing*, which produced one run
   * per episode and a blank region between them.
   *
   * The drawing no longer asks that question. A gap is a gap: the trailing window
   * empties, the trace reaches zero, and it climbs again when the model resumes. The
   * number of runs is decided by phase changes alone, so a gap of one window and a gap
   * of ten produce the same single run with different values in it.
   */
  const gapOf = spacing => build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [[0, 'output', 'o1'], [spacing, 'output', 'o2']],
    }],
    endMs: spacing + 5000,
  })

  for (const spacing of [DEFAULT_WINDOW_MS, DEFAULT_WINDOW_MS + 1, 10 * DEFAULT_WINDOW_MS]) {
    const { curve } = gapOf(spacing)
    assert.equal(runsOf(curve, 'output').length, 1,
      `a ${spacing} ms gap inside one phase is still one coloured run`)
  }

  /**
   * The rate itself still distinguishes them, which is what a reader needs. Both
   * samples here are one-character deltas, so a window holding one of them reads
   * `0.25 tokens / 1 s = 0.5` tokens/s.
   */
  const touching = gapOf(DEFAULT_WINDOW_MS).curve
  const touchingSamples = attemptOf(touching, 'a').samples
  assert.equal(touchingSamples[1].activeTimeMs, DEFAULT_WINDOW_MS)
  assert.deepEqual(attemptOf(touching, 'a').points.map(point => point.tps),
    [0.5, 0.5, 0.5, 0.5, 0.5],
    'a gap of exactly one window keeps the window open through the whole attempt, which ends on its last delta')

  const split = gapOf(10 * DEFAULT_WINDOW_MS).curve
  const trace = attemptOf(split, 'a')
  const silent = trace.points.filter(point => point.tps === 0)
  assert.ok(silent.length >= 30, `a ten-window silence is a long visible zero: ${silent.length} vertices`)
  assert.equal(trace.points[0].tps, 0.5)
  assert.equal(trace.points.at(-1).tps, 0.5,
    'and the trace ends on the resumed delta rather than on a decay past it')
})

test('runs never merge across an attempt boundary', () => {
  /**
   * The sharpest form: two attempts whose only deltas share the compressed
   * coordinate zero, because each produced a single delta. The axis cannot separate
   * them at all, so only the attempt identity can — and it must.
   */
  const { curve } = build({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(40)]] },
      { id: 'b', step: 2, at: 100, chunks: [[100, 'output', 'y'.repeat(40)]] },
    ],
    endMs: 1500,
  })
  assert.deepEqual(curve.attempts.map(attempt => attempt.attemptId), ['a', 'b'],
    'a change of attempt splits unconditionally')
  assert.equal(curve.attempts[0].startMs, 0)
  assert.equal(curve.attempts[1].startMs, 0, 'both attempts occupy the same coordinate, and still do not merge')
  assert.deepEqual(curve.attempts[0].points.map(p => p.tps), [10])
  assert.deepEqual(curve.attempts[1].points.map(p => p.tps), [10],
    'and neither inherits the other\'s tokens')
})

test('a later attempt\'s sample cannot be absorbed into an earlier attempt\'s trace', () => {
  /**
   * Attempt A produces a single delta, so its own width is zero and attempt B begins on
   * the very coordinate A owns. A's trace is that one measurement and nothing else: it has
   * no coordinate of its own to decay over, and every coordinate past it belongs to B.
   */
  const { curve } = build({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)]] },
      { id: 'b', step: 2, at: 200, chunks: [[200, 'output', 'y'.repeat(40)], [700, 'output', 'y'.repeat(40)]] },
    ],
    endMs: 3000,
  })
  const traceA = attemptOf(curve, 'a')
  const traceB = attemptOf(curve, 'b')
  assert.equal(traceA.points.length, 1, 'attempt A is one vertex and stops there')
  assert.equal(traceA.points[0].timeMs, 0, 'it owns no coordinate beyond its single measurement')
  assert.equal(traceB.startMs, 0, 'attempt B opens on the coordinate A owned')
  assert.deepEqual(traceB.points.map(p => p.tps), [10, 10, 20])
  assert.equal(curve.peakTps, 100)
})

test('the SVG receives one subpath per coloured run and no line joins two attempts', () => {
  const { curve } = build({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)], [500, 'output', 'x'.repeat(400)]] },
      { id: 'b', step: 2, at: 9000, chunks: [[9000, 'output', 'y'.repeat(40)], [9500, 'output', 'y'.repeat(40)]] },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 600, endMs: 8000 }],
    endMs: 10_000,
  })
  const runs = runsOf(curve, 'output')
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map(run => run.attemptId), ['a', 'b'])
  assert.deepEqual(runs.map(run => [run.startMs, run.endMs]), [[0, 500], [500, 1000]],
    'A stops on its own last delta; B opens on that coordinate and ends on its own, which is the axis end')

  /**
   * The boundary test that matters: every vertex belongs to exactly one attempt,
   * and the coordinate list crosses the boundary exactly once. A renderer that
   * joined the two coordinate lists into one path would draw a segment from A's
   * last vertex to B's first, which is the line this structure exists to forbid.
   */
  const joined = [...runs[0].points, ...runs[1].points]
  const breaches = joined.filter((point, index) => index > 0 && point.attemptId !== joined[index - 1].attemptId)
  assert.equal(breaches.length, 1, 'the coordinate list crosses the boundary exactly once')
  assert.equal(breaches[0].attemptId, 'b', 'and the crossing is the only place the attempt changes')
  assert.equal(new Set(joined.map(p => `${p.attemptId}:${p.timeMs}`)).size, joined.length,
    'no vertex is claimed by two attempts')
  assert.equal(runs[0].points.at(-1).timeMs, 500)
  assert.equal(runs[1].points[0].timeMs, 500, 'the two runs meet at one coordinate and stay separate')
})

test('a colour transition shares its boundary vertex rather than leaving a gap', () => {
  /**
   * The rendering seam, asserted as geometry. A phase change is not a stall: the
   * outgoing run ends on the vertex the incoming run begins on, so the two subpaths
   * meet and the y value is continuous across the tone change.
   */
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'reasoning', 'r1'], [500, 'reasoning', 'r2'],
        [3000, 'output', 'o1'], [3500, 'output', 'o2'],
        [7000, 'reasoning', 'r3'], [7500, 'reasoning', 'r4'],
      ],
    }],
    endMs: 9000,
  })
  const trace = attemptOf(curve, 'a')
  const transitions = trace.points.filter((point, index) => (
    index > 0 && trace.points[index - 1].activePhase !== point.activePhase
  ))
  assert.equal(transitions.length, 2, 'two phase transitions on this trace')

  /**
   * Both transitions produce a **seam**, and it is the one vertex the two tones share: the last
   * vertex still carrying the outgoing phase. The previous description called it the midpoint of
   * the label change; since every vertex carries a phase the two stretch boundaries are adjacent
   * indices, so the midpoint formula evaluated to exactly that vertex. The formula is gone from
   * the implementation and the seam is asserted here as what it always was.
   */
  const seams = []
  for (let index = 1; index < trace.runs.length; index += 1) {
    const previous = trace.runs[index - 1]
    const current = trace.runs[index]
    assert.equal(previous.points.at(-1), current.points[0],
      `${previous.phase} -> ${current.phase}: the two subpaths share their boundary vertex`)
    seams.push({ at: current.points[0].localMs, from: previous.phase, to: current.phase })
  }
  assert.equal(seams.length, transitions.length, 'one seam per phase transition')
  assert.deepEqual(seams.map(seam => [seam.from, seam.to]),
    [['reasoning', 'output'], ['output', 'reasoning']])
  /**
   * The seam sits at or before the transition vertex, and never more than one sampling step
   * before it: it is the outgoing stretch's last labelled vertex.
   */
  for (const [index, seam] of seams.entries()) {
    assert.ok(seam.at <= transitions[index].localMs,
      `seam ${seam.at} must not be past the transition at ${transitions[index].localMs}`)
    assert.ok(transitions[index].localMs - seam.at <= 250,
      `and it must be within one sampling step of it, not at the far end of the silence`)
  }

  /**
   * And no subpath reaches across a stretch the model did not produce: every run's
   * vertices lie inside its own attempt, and the runs of one attempt tile the grid
   * with a shared vertex at every tone change.
   */
  const runs = trace.runs
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]
    const current = runs[index]
    assert.equal(previous.points.at(-1), current.points[0],
      `${previous.phase} -> ${current.phase}: the two subpaths share their boundary vertex`)
  }
  assert.equal(runs.reduce((sum, run) => sum + run.points.length, 0), trace.points.length + runs.length - 1,
    'the runs partition the trace grid, charging the shared seam once per subpath')
})

test('the turn peak is taken over the per-attempt full trace, before downsampling', () => {
  /**
   * A long turn whose single spike sits inside one attempt. The rendered trace is
   * downsampled; the reported peak must be the full-series statistic, and the
   * downsampling must be unable to move it.
   */
  const chunks = []
  for (let t = 0; t <= 60_000; t += 40) {
    chunks.push([t, 'reasoning', 'r'])
    chunks.push([t, 'output', 'o'])
  }
  const { curve } = build({ attempts: [{ id: 'a', step: 1, at: 0, chunks }], endMs: 61_000 })
  assert.equal(curve.peakTps, peakTps(...curve.attempts.map(attempt => attempt.points)),
    'the published peak is the maximum over the unbudgeted traces')
  assert.ok(curve.peakTps > 0)
  assert.ok(runsOf(curve, 'output').flatMap(run => run.points).length > 200,
    'the full trace is long enough to need a budget')
  assert.equal(Number.isFinite(curve.peakTps), true)
})

test('downsampling preserves the peak policy on every run whatever the budget', () => {
  const chunks = []
  for (let t = 0; t <= 20_000; t += 50) chunks.push([t, 'output', 'o'])
  chunks.push([9000, 'output', 'x'.repeat(4000)])
  const { curve } = build({ attempts: [{ id: 'a', step: 1, at: 0, chunks }], endMs: 21_000 })
  for (const run of runsOf(curve, 'output')) {
    for (const budget of [3, 8, 64, 512]) {
      const reduced = downsampleSeries(run.points, budget)
      assert.ok(reduced.length <= budget)
      assert.equal(peakTps(reduced), peakTps(run.points),
        `budget ${budget} retains the run's own maximum`)
    }
  }
})

test('an internal stall keeps its full width inside the attempt and is drawn as a decay', () => {
  /**
   * A delivery stall is model time, so it is drawn; a tool gap is not. The previous
   * revision proved this by splitting the evidence into two episodes with a blank
   * region between them — which was the right instinct applied to the wrong unit. The
   * stall belongs to the attempt, so it belongs to the attempt's trace, and the trace
   * shows it by decaying to zero and rising again.
   */
  const spec = { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'o'.repeat(400)], [4000, 'output', 'o'.repeat(400)]] }
  const { curve } = build({ attempts: [spec], endMs: 6000 })
  assert.equal(curve.durationMs, 4000, 'the stall is part of the attempt\'s width')

  const trace = assertTraceMatchesScript(curve, spec, { toMs: 4000 })
  assert.deepEqual(trace.points.map(point => point.tps),
    [100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100],
    'the whole four-second silence is drawn at full width, one zero per 250 ms vertex, '
    + 'and the trace climbs again on the resumed delta alone — which is also where it ends, '
    + 'because after that delta the model stopped producing')
  assert.equal(trace.points.find(point => point.localMs === 4000).tps, 100,
    'and the trace climbs again when the model resumes, on its own window alone')
  /**
   * The opening vertex measures `(3000, 4000]` and nothing older, so it reads only the
   * delta that arrived at 4000: 100 tokens/s. The Phase 7 audit's second defect read
   * `0.5` here — 100 tokens/s from the sample at local zero added to the 400 at local
   * 4000, on an instant where only the second one was inside the window.
   */
  assert.equal(curve.peakTps, 100,
    'two 100-token deltas four windows apart never coexist in one window, so the turn peak is one delta')
  assert.equal(trace.tokens, 200, 'the attempt produced both deltas')
  assert.equal(runsOf(curve, 'output').length, 1, 'and they are one coloured run of one trace')
})

test('every run reports a peak equal to its own strongest vertex', () => {
  const { curve } = build({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)], [400, 'output', 'x'.repeat(400)]] },
      { id: 'b', step: 2, at: 9000, chunks: [[9000, 'output', 'y'.repeat(40)], [13_000, 'output', 'y'.repeat(40)]] },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 500, endMs: 8000 }],
    endMs: 14_000,
  })
  for (const series of curve.series) {
    for (const run of series.runs) {
      assert.equal(run.peak, peakTps(run.points))
      assert.ok(run.peak >= 0)
    }
  }
})

test('the SSE-free turn shape — plain single attempt — is unchanged from the simple definition', () => {
  /**
   * The regression matrix must not have redefined the ordinary case. One attempt, two
   * measurements half a window apart: 100, then 200, over the attempt's own 500 ms — and the
   * trace stops there.
   *
   * The previous expectation carried four further vertices, `750, 1000, 1250, 1500`, with the
   * rates `200, 100, 100, 0`. They were a one-window decay drawn past the attempt's last
   * delta, and because `curve.durationMs` is 500 every one of them was clamped onto `x = 100`
   * — the right-edge vertical stroke Phase 7C.1 removed. The shape this test exists to protect
   * is the rise to the peak, and it is intact.
   */
  const { curve } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)], [500, 'output', 'x'.repeat(400)]] }],
    endMs: 2000,
  })
  const runs = runsOf(curve, 'output')
  assert.equal(runs.length, 1, 'one phase, one run')
  assert.deepEqual(runs[0].points.map(p => p.timeMs), [0, 250, 500])
  assert.deepEqual(runs[0].points.map(p => p.tps), [100, 100, 200],
    'the single-attempt series the project has always drawn: rise, then the peak at the attempt\'s own end')
  assert.equal(runs[0].peak, 200)
  assert.equal(runs[0].endMs, 500, 'the run covers the attempt, which is its own last delta')
  assert.equal(curve.durationMs, 500, 'and the axis is exactly the attempt\'s own width')
  assert.equal(runs[0].endMs, curve.durationMs,
    'the final run ends precisely on the axis end, drawing nothing past it')
  assert.equal(curve.peakTps, 200)
})
