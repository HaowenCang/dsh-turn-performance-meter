/**
 * The completed-curve regression matrix.
 *
 * `test/curve-attempt-boundary.test.js` is the counterexample file: it proves the
 * Phase 5 defect existed and that the Phase 6 construction fixes it. This file is
 * the **matrix**: one named scenario per frozen curve semantic, so a future change
 * that fixes one behaviour and quietly breaks another is caught by name rather
 * than by a single large assertion block.
 *
 * The invariant under all of it: tool time is compressed to zero width on the
 * x-axis, but the one-second rolling window is a property of one model attempt and
 * is never concatenated across attempts with it
 * (`docs/METRICS_SPEC.md` §8.2, §6).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { DEFAULT_WINDOW_MS, peakTps } from '../src/core/curve.js'

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

/** The runs of one phase, in turn order. */
function runsOf(curve, key) {
  return curve.series.find(series => series.key === key).runs
}

test('the window resets at an attempt boundary', () => {
  /**
   * Two attempts of two measurements each, with a 60 s tool between them. Attempt A
   * ends on 200 tokens/s; attempt B's own measurements are a tenth of that. If the
   * window crossed the boundary, B's opening vertices would inherit A's trailing
   * 100.
   */
  const { curve } = build({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)], [1000, 'output', 'x'.repeat(400)]] },
      { id: 'b', step: 2, at: 10_100, chunks: [[10_100, 'output', 'y'.repeat(40)], [11_100, 'output', 'y'.repeat(40)]] },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 1100, endMs: 10_000 }],
    endMs: 12_000,
  })
  const [runA, runB] = runsOf(curve, 'output')
  assert.equal(runA.points.at(-1).tps, 100)
  assert.deepEqual(runB.points.map(p => p.tps), [10, 10, 10, 10, 10, 10, 10, 10, 0],
    'attempt B starts from an empty window, whatever attempt A measured')
  assert.equal(runB.peak, 10)
  assert.equal(curve.peakTps, 100, 'the peak is a per-attempt maximum')
})

test('a previous attempt\'s tokens cannot enter the next attempt\'s window', () => {
  /**
   * The strongest form: attempt A streams heavily up to the last instant before
   * the boundary, and attempt B produces a single small delta. Every vertex
   * attributed to B must be bounded by B's own total.
   */
  const { curve } = build({
    attempts: [
      {
        id: 'a',
        step: 1,
        at: 0,
        chunks: [
          [0, 'output', 'x'.repeat(4000)],
          [250, 'output', 'x'.repeat(4000)],
          [400, 'output', 'x'.repeat(4000)],
        ],
      },
      { id: 'b', step: 2, at: 30_000, chunks: [[30_000, 'output', 'y'.repeat(8)]] },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 500, endMs: 29_000 }],
    endMs: 31_000,
  })
  const runs = runsOf(curve, 'output')
  assert.equal(runs.length, 2)
  const runB = runs[1]
  assert.equal(runB.attemptTokens, 2, 'attempt B produced two estimated tokens')
  assert.equal(runB.peak, 2, 'its ceiling is two tokens per second, and it reaches it')
  for (const point of runB.points) {
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
  const [first, second] = runsOf(curve, 'output')
  assert.deepEqual(first.points.map(p => p.tps), [200, 200, 400])
  assert.deepEqual(second.points.map(p => p.tps), [20, 20, 40, 40, 20, 20, 0],
    'the retry is measured on its own window')
  assert.equal(second.points[0].timeMs, first.points.at(-1).timeMs,
    'and it still opens at the abandoned attempt\'s last coordinate')
  assert.equal(second.peak, 40)
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
  const [runA, runB] = runsOf(curve, 'output')
  assert.equal(runA.peak, 1000, 'attempt A: its 2000 tokens measured across a half-open window')
  assert.equal(runB.peak, 10, 'attempt B: its own 20 tokens, ten times smaller')
  assert.equal(curve.peakTps, peakTps(runA.points, runB.points))
  assert.equal(curve.peakTps, 1000, 'the turn peak is the larger single-attempt maximum')
  assert.notEqual(curve.peakTps, 1010, 'and never the two added together')
})

test('multiple reasoning runs inside one attempt are separate runs', () => {
  /**
   * `Reasoning -> Output -> Reasoning` at a 3 s spacing: each reasoning episode's
   * window expires before the next begins, so there is a real absence between them
   * and a single span would draw a zero line through it.
   */
  const { curve } = build({
    attempts: [{
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
    }],
    endMs: 10_000,
  })
  const reasonRuns = runsOf(curve, 'reasoning')
  assert.equal(reasonRuns.length, 2, 'two episodes, two runs')
  assert.deepEqual(reasonRuns.map(run => [run.startMs, run.endMs]), [[0, 1500], [8000, 9500]],
    'each run covers its own episode and its own one-window tail')
  assert.ok(reasonRuns[0].endMs < reasonRuns[1].startMs, 'with a real gap between them')

  /**
   * And no vertex of either run falls outside its own interval, so a renderer can
   * never receive a reasoning point from the output-only stretch.
   */
  for (const run of reasonRuns) {
    for (const point of run.points) {
      assert.ok(point.timeMs >= run.startMs && point.timeMs <= run.endMs,
        `vertex ${point.timeMs} lies outside its run [${run.startMs}, ${run.endMs}]`)
    }
  }
  assert.equal(reasonRuns[0].endMs, 1500, 'the first episode decays to zero and stops')
  assert.equal(reasonRuns[1].startMs, 8000)
})

test('multiple output runs inside one attempt are separate runs', () => {
  const { curve } = build({
    attempts: [{
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
    }],
    endMs: 11_000,
  })
  const outRuns = runsOf(curve, 'output')
  assert.equal(outRuns.length, 2)
  assert.deepEqual(outRuns.map(run => [run.startMs, run.endMs]), [[0, 1500], [9000, 10_500]])
  /** The reasoning interval between them is not covered by any output run. */
  const reasonRuns = runsOf(curve, 'reasoning')
  assert.equal(reasonRuns.length, 1)
  assert.ok(outRuns[0].endMs < reasonRuns[0].startMs && reasonRuns[0].endMs < outRuns[1].startMs)
  for (const run of outRuns) {
    assert.equal(run.points.every(p => p.timeMs >= run.startMs && p.timeMs <= run.endMs), true,
      `${run.startMs}-${run.endMs} carries only its own vertices`)
  }
})

test('same-phase episodes split past one window and merge within it', () => {
  const samples = (spacing) => build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [[0, 'output', 'o1'], [spacing, 'output', 'o2']],
    }],
    endMs: spacing + 5000,
  })
  assert.equal(runsOf(samples(DEFAULT_WINDOW_MS).curve, 'output').length, 1,
    'a gap of exactly one window never closed the window, so it stays one run')
  assert.equal(runsOf(samples(DEFAULT_WINDOW_MS + 1).curve, 'output').length, 2,
    'one millisecond more is an absence and splits the run')
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
  const runs = runsOf(curve, 'output')
  assert.equal(runs.length, 2, 'a change of attempt splits unconditionally')
  assert.deepEqual(runs.map(run => run.attemptId), ['a', 'b'])
  assert.equal(runs[0].startMs, 0)
  assert.equal(runs[1].startMs, 0, 'both attempts occupy the same coordinate, and still do not merge')
  assert.deepEqual(runs[0].points.map(p => p.tps), [10])
  assert.deepEqual(runs[1].points.map(p => p.tps), [10, 10, 10, 10, 0],
    'and neither inherits the other\'s tokens')
})

test('a later attempt\'s sample cannot be absorbed into an earlier attempt\'s episode', () => {
  /**
   * Attempt A's window is still open when attempt B produces its first delta, and B
   * begins on a coordinate A also owns. Merging the two would create one run whose
   * series mixes two calls, so the boundary closes A's episode before B is read.
   */
  const { curve } = build({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)]] },
      { id: 'b', step: 2, at: 200, chunks: [[200, 'output', 'y'.repeat(40)], [700, 'output', 'y'.repeat(40)]] },
    ],
    endMs: 3000,
  })
  const runs = runsOf(curve, 'output')
  assert.deepEqual(runs.map(run => run.attemptId), ['a', 'b'])
  assert.equal(runs[0].points.length, 1, 'attempt A is one vertex and stops there')
  assert.equal(runs[0].drawnToMs, 0, 'it owns no coordinate beyond its single measurement')
  assert.equal(runs[1].startMs, 0, 'attempt B opens on the coordinate A owned')
  assert.deepEqual(runs[1].points.map(p => p.tps), [10, 10, 20, 20, 10, 10, 0])
  assert.equal(curve.peakTps, 100)
})

test('the SVG receives one subpath per run and no line joins two attempts', () => {
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
  assert.deepEqual(runs.map(run => [run.startMs, run.endMs]), [[0, 500], [500, 2000]],
    'A stops where B begins; B owns the axis up to its own one-window tail')

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

test('no vertex is drawn through an absent phase interval', () => {
  /**
   * Every vertex of a run lies inside one of that phase's own evidence intervals,
   * so the renderer never receives a point from a stretch where the phase had
   * produced nothing.
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
  for (const key of ['reasoning', 'output']) {
    const intervals = curve.phaseRuns[key]
    assert.ok(intervals.length > 0, `${key} has evidence intervals`)
    for (const run of runsOf(curve, key)) {
      for (const point of run.points) {
        const inside = curve.phaseRuns[key].some(interval => (
          interval.attemptId === point.attemptId
          && point.timeMs >= interval.startMs
          && point.timeMs <= interval.endMs
        ))
        assert.ok(inside,
          `${key} vertex at ${point.timeMs} lies outside every ${key} evidence interval`)
      }
    }
  }
  /** And the absent stretch really exists: output is silent from 3.5 s to 7 s. */
  const outputRuns = runsOf(curve, 'output')
  assert.equal(outputRuns.length, 1)
  assert.ok(outputRuns[0].endMs <= 7000)
})

test('the turn peak is taken over the per-attempt full series, before downsampling', () => {
  /**
   * A long turn whose single spike sits inside one attempt. The rendered series is
   * downsampled; the reported peak must be the full-series statistic, and the
   * downsampling must be unable to move it.
   */
  const chunks = []
  for (let t = 0; t <= 60_000; t += 40) {
    chunks.push([t, 'reasoning', 'r'])
    chunks.push([t, 'output', 'o'])
  }
  const { curve } = build({ attempts: [{ id: 'a', step: 1, at: 0, chunks }], endMs: 61_000 })
  const fullOutput = runsOf(curve, 'output').flatMap(run => run.points)
  assert.ok(fullOutput.length > 200, 'the full series is long enough to need a budget')
  assert.equal(curve.peakTps, peakTps(...curve.series.flatMap(s => s.runs.map(r => r.points))))
  assert.ok(curve.peakTps > 0)
  /**
   * The peak is a full-series maximum, not a maximum of the retained vertices — but
   * `downsampleSeries` guarantees the maximum survives, so on real data the two
   * coincide. What matters is that a *smaller* budget cannot change the number.
   */
  assert.equal(Number.isFinite(curve.peakTps), true)
})

test('downsampling preserves the peak policy on every run whatever the budget', async () => {
  const { downsampleSeries } = await import('../src/core/curve.js')
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

test('an internal stall keeps its full width inside the attempt', () => {
  /** A delivery stall is model time, so it is drawn; a tool gap is not. */
  const { curve } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'o'.repeat(400)], [4000, 'output', 'o'.repeat(400)]] }],
    endMs: 6000,
  })
  assert.equal(curve.durationMs, 4000, 'the stall is part of the attempt\'s width')

  /**
   * A 4 s silence is four windows long, so it is two evidence episodes — before the
   * stall and after it — rather than one interval spanning it. That is the point:
   * the gap is drawn as a gap, not as a zero line claiming throughput collapsed
   * across it.
   */
  const runs = runsOf(curve, 'output')
  assert.equal(runs.length, 2, 'the stall splits the episode')
  assert.deepEqual(runs.map(run => [run.startMs, run.endMs]), [[0, 1000], [4000, 5000]])
  assert.deepEqual(runs[0].points.map(p => p.tps), [100, 100, 100, 100, 0],
    'the first delta is measured and then decays')
  /**
   * The second episode's opening vertex measures `(3000, 4000]` and nothing older,
   * so it reads only the delta that opened it: 100 tokens/s.
   *
   * This assertion previously read `0.5` — that is, 100 tokens/s from the sample at
   * local zero plus the 400 at local 4000, counted together on an instant where only
   * the second one was inside the window. It was the Phase 7 audit's second defect,
   * and in this scenario the leaked sample was four windows stale. The two episodes
   * belong to one attempt, so no attempt-boundary reasoning is involved: the window
   * definition alone decides the number, and it excludes the first delta.
   */
  assert.deepEqual(runs[1].points.map(p => p.tps), [100, 100, 100, 100, 0],
    'the second episode opens on its own delta alone, never on the first episode\'s expired one')
  assert.ok(runs[0].endMs < runs[1].startMs, 'and the stall is visible between them')
  assert.equal(curve.peakTps, 100,
    'two 100-token deltas four windows apart never coexist in one window, so the turn peak is one delta')
  assert.equal(runs[1].attemptTokens, 200,
    'the attempt produced both deltas, and the second run accounts for the whole attempt')
  for (const run of runs) {
    for (const point of run.points) {
      assert.ok(point.tps <= 100 + 1e-9,
        `vertex ${point.timeMs} claims ${point.tps} tokens/s, but no single window of this attempt holds more than one delta`)
    }
  }
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
   * The regression matrix must not have redefined the ordinary case. One attempt,
   * two measurements half a window apart: 100, then 200, over the attempt's own
   * 500 ms.
   */
  const { curve } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(400)], [500, 'output', 'x'.repeat(400)]] }],
    endMs: 2000,
  })
  const runs = runsOf(curve, 'output')
  assert.equal(runs.length, 1, 'one episode, one run')
  assert.deepEqual(runs[0].points.map(p => p.timeMs), [0, 250, 500, 750, 1000, 1250, 1500])
  assert.deepEqual(runs[0].points.map(p => p.tps), [100, 100, 200, 200, 100, 100, 0],
    'the single-attempt series the project has always drawn: rise, peak, one-window decay')
  assert.equal(runs[0].peak, 200)
  assert.equal(runs[0].endMs, 1500, 'the run covers the attempt plus its own one-window tail')
  assert.equal(curve.durationMs, 500, 'and the axis itself is still only the attempt\'s own width')
  assert.equal(curve.peakTps, 200)
})
