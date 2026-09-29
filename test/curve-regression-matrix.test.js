/**
 * The completed-curve regression matrix (Phase 9.2).
 *
 * One named scenario per frozen curve semantic, so a future change that fixes one
 * behaviour and quietly breaks another is caught by name rather than by a single large
 * assertion block. Every scenario asserts the **published numbers**: the exact vertex
 * list of the settled snapshot, derived from the script by the phase-cumulative
 * definition — the mass of the episode in force over its own elapsed clock, `Math.round`,
 * the opening instant published as `0`, the trace running from local zero to the
 * attempt's own end instant — and never read back out of the curve.
 *
 * ## The semantics this file freezes
 *
 *   - **One attempt, one trace, one episode clock per phase stretch.** A vertex at
 *     attempt-local `t` reports `round(mass * 1000 / (t - firstSampleOfEpisode))` over the
 *     maximal run of consecutive same-phase samples of *that attempt*. A phase change
 *     resets the clock and the numerator; two attempts sharing a compressed coordinate
 *     share no clock at all.
 *   - **A stall decays hyperbolically and never reaches exactly zero.** The numerator
 *     freezes while the denominator advances, so a silence inside an attempt is drawn at
 *     full width as a strictly decreasing stretch — not as a window reaching zero, and
 *     not as a hole between two runs.
 *   - **The terminal generated-delta → settlement tail is model time and is drawn.**
 *     The attempt's end instant is its settlement when one is known and not earlier than
 *     its last delta; a settlement recorded *before* the last delta is clock skew and is
 *     refused rather than allowed to shrink real generation time.
 *   - **Tool waits and inter-attempt waits own no coordinate and no denominator.** The
 *     next attempt opens exactly where the previous one's clock stopped.
 *   - **The published series is capped at 200 points**, nearest-neighbour, no
 *     interpolation, and `peakTps` is the maximum of that published series — the maximum
 *     over attempts, never their sum.
 *
 * The matrix covers: reasoning-only; output-only; reasoning→output; reasoning→output→
 * reasoning; a long intra-attempt stall; a burst then silence; two attempts separated by
 * a long tool wait; a single-delta attempt of zero width; a very long attempt; and a
 * multi-attempt turn whose peak is the largest single call. The invariant
 * `peakTps(...curve.attempts.map(attempt => attempt.points)) === curve.peakTps` is
 * asserted on every settled snapshot this file builds.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { DEFAULT_SAMPLE_EVERY_MS, MAX_SERIES_POINTS, peakTps } from '../src/core/curve.js'

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })

/**
 * Drive one turn from a compact script and return its settled view.
 *
 * `attempts` entries are `{id, step, at, chunks: [[wallMs, kind, text]], settledAtMs,
 * usage}`; `tools` entries are `{callId, name, startMs, endMs}`. A settlement defaulting
 * to the attempt's own start means "no tail", which is the shape of an attempt whose
 * settlement was never observed later than its last delta.
 */
function build({ attempts = [], tools = [], endMs = 0, status = 'completed' } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  for (const spec of attempts) {
    const attempt = store.beginAttempt(record, { attemptId: spec.id, step: spec.step, startedAtMs: spec.at })
    for (const [timeMs, kind, text] of spec.chunks ?? []) {
      store.acceptChunk(record, attempt, {
        timeMs,
        chunk: kind === 'reasoning' ? reasoning(text) : output(text),
      })
    }
    store.settleAttempt(attempt, {
      settledAtMs: spec.settledAtMs ?? spec.at,
      settlementKind: spec.settlementKind ?? 'message',
      surfaceCommitted: spec.surfaceCommitted ?? true,
      attemptOutcome: spec.attemptOutcome ?? 'committed',
      usage: spec.usage ?? null,
      settlementSeq: spec.settlementSeq ?? spec.step ?? 1,
    })
  }
  for (const tool of tools) {
    store.toolStarted(record, { callId: tool.callId, name: tool.name ?? 'pwsh', timeMs: tool.startMs })
    store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status ?? 'ok' })
  }
  const settled = store.endTurn(record, { timeMs: endMs, status })
  const curve = settled.curve
  /**
   * The invariant this file asserts on every snapshot it builds: the turn peak is the
   * maximum of the **published** per-attempt series, and never anything assembled from
   * two attempts.
   */
  assert.equal(curve.peakTps, peakTps(...curve.attempts.map(attempt => attempt.points)),
    'the turn peak must be the maximum of the published per-attempt series')
  return { store, record, settled, curve }
}

/** One attempt's full trace, by attempt id. */
function attemptOf(curve, id) {
  return curve.attempts.find(candidate => candidate.attemptId === id)
}

/** The runs of one phase, in draw order. */
function runsOf(curve, key) {
  return curve.series.find(series => series.key === key).runs
}

test('reasoning-only: one episode climbs on its own clock and decays to settlement', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [[0, 'reasoning', 'x'.repeat(40)], [300, 'reasoning', 'x'.repeat(40)]],
      settledAtMs: 500,
    }],
    endMs: 600,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 100], [200, 50], [300, 67], [400, 50], [500, 40],
  ], 'ten tokens accumulate while the episode clock advances; the tail to settlement is drawn')
  assert.equal(trace.points.every(point => point.activePhase === 'reasoning'), true)
  assert.equal(curve.durationMs, 500)
  assert.equal(runsOf(curve, 'reasoning').length, 1)
  assert.equal(runsOf(curve, 'output').length, 0, 'a phase that produced nothing has no run, not a flat zero')
  assert.equal(curve.peakTps, 100)
})

test('output-only: the same estimator over text deltas', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [[0, 'output', 'x'.repeat(40)], [700, 'output', 'x'.repeat(40)]],
      settledAtMs: 1000,
    }],
    endMs: 1100,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 100], [200, 50], [300, 33], [400, 25], [500, 20],
    [600, 17], [700, 29], [800, 25], [900, 22], [1000, 20],
  ], 'the second delta doubles the numerator at 700 ms and dilutes as the clock advances')
  assert.equal(trace.points.every(point => point.activePhase === 'output'), true)
  assert.equal(curve.peakTps, 100)
})

test('reasoning then output: the transition resets the magnitude and shares its vertex', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'reasoning', 'x'.repeat(40)], [200, 'reasoning', 'x'.repeat(40)],
        [500, 'output', 'x'.repeat(40)], [800, 'output', 'x'.repeat(40)],
      ],
      settledAtMs: 1100,
    }],
    endMs: 1200,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 100], [200, 100], [300, 67], [400, 50],
    [500, 0], [600, 100], [700, 50], [800, 67], [900, 50], [1000, 40], [1100, 33],
  ], 'the output episode opens at zero on its own clock and climbs on its own evidence')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 4], ['output', 4, 11],
  ], 'the two subpaths meet on the shared seam vertex')
  assert.equal(trace.points[4].localMs, 400)
  assert.equal(trace.points[4].activePhase, 'reasoning',
    'the seam is the outgoing stretch\'s own last labelled vertex')
  assert.equal(trace.points[5].tps, 0, 'and the new episode opens at zero on the vertex after it')
  assert.equal(trace.runs[0].points.at(-1), trace.runs[1].points[0],
    'the seam is one measurement, emitted by both subpaths')
  assert.equal(curve.peakTps, 100)
})

test('reasoning → output → reasoning: three episodes, three runs, one trace', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'reasoning', 'x'.repeat(40)], [100, 'reasoning', 'x'.repeat(40)],
        [300, 'output', 'x'.repeat(40)],
        [500, 'reasoning', 'x'.repeat(40)],
      ],
      settledAtMs: 700,
    }],
    endMs: 800,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 200], [200, 100], [300, 0], [400, 100], [500, 0], [600, 100], [700, 50],
  ], 'each phase stretch owns its clock: two resets, two climbs')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 2], ['output', 2, 4], ['reasoning', 4, 7],
  ])
  for (let index = 1; index < trace.runs.length; index += 1) {
    assert.equal(trace.runs[index - 1].points.at(-1), trace.runs[index].points[0],
      'a tone change is a shared vertex, not a gap')
  }
  assert.equal(trace.runs.reduce((sum, run) => sum + run.pointCount, 0),
    trace.points.length + trace.runs.length - 1,
    'the runs tile the trace grid, charging the shared seam once per subpath')
  assert.equal(curve.peakTps, 200)
})

test('a long intra-attempt stall decays hyperbolically and strictly', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [[0, 'output', 'x'.repeat(400)], [3000, 'output', 'x'.repeat(400)]],
      settledAtMs: 3200,
    }],
    endMs: 3300,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.samples.map(sample => sample.activeTimeMs), [0, 3000],
    'the stall is a real silence: no sample arrives inside it')
  assert.deepEqual(trace.points.map(point => point.tps), [
    0,
    1000, 500, 333, 250, 200, 167, 143, 125, 111, 100, 91, 83, 77, 71, 67, 63, 59, 56, 53, 50,
    48, 45, 43, 42, 40, 38, 37, 36, 34,
    67, 65, 63,
  ], 'one hundred tokens frozen while the denominator advances: mass 100 over t milliseconds')

  /**
   * The stall itself, vertex by vertex: from the first ladder instant after the delta to
   * the instant before the model resumes, the value must fall at every step. A windowed
   * estimator would have reached zero here; the cumulative one cannot.
   */
  const decay = trace.points.slice(1, 30)
  for (let index = 1; index < decay.length; index += 1) {
    assert.ok(decay[index].tps < decay[index - 1].tps,
      `the stall must decay strictly while no sample arrives: ${decay[index - 1].tps} at `
      + `${decay[index - 1].localMs} ms, then ${decay[index].tps} at ${decay[index].localMs} ms`)
  }
  assert.equal(decay.every(point => point.tps > 0), true,
    'the hyperbolic decay never reaches exactly zero while the attempt is alive')
  assert.equal(trace.points[30].localMs, 3000)
  assert.equal(trace.points[30].tps, 67, 'the resumed delta dilutes the frozen stretch')
  assert.equal(trace.points[30].activePhase, 'output', 'and the silence was carried by the phase that last produced')
  assert.equal(curve.durationMs, 3200, 'the stall and the settlement tail are model time and keep their width')
  assert.equal(runsOf(curve, 'output').length, 1, 'one phase, one run, however long the silence')
})

test('a burst then silence: the trace decays across the whole settlement tail', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'output', 'x'.repeat(40)], [100, 'output', 'x'.repeat(40)], [200, 'output', 'x'.repeat(40)],
      ],
      settledAtMs: 3000,
    }],
    endMs: 3100,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => point.tps), [
    0, 200, 150, 100, 75, 60, 50, 43, 38, 33, 30, 27, 25, 23, 21, 20,
    19, 18, 17, 16, 15, 14, 14, 13, 13, 12, 12, 11, 11, 10, 10,
  ], 'thirty tokens over three seconds of clock: the tail is drawn to settlement')
  assert.equal(trace.points.at(-1).localMs, 3000)
  assert.equal(trace.points.at(-1).tps, 10, 'and it never reaches exactly zero')
  assert.equal(trace.points.slice(3).every(point => point.tps > 0), true)
  assert.equal(curve.durationMs, 3000, 'the silence after the last delta is the attempt\'s own elapsed time')
  assert.equal(runsOf(curve, 'output').length, 1)
})

test('a tool wait owns no axis width and no denominator', () => {
  const { curve } = build({
    attempts: [
      {
        id: 'a',
        step: 1,
        at: 0,
        chunks: [[0, 'output', 'x'.repeat(400)], [400, 'output', 'x'.repeat(400)]],
        settledAtMs: 500,
      },
      {
        id: 'b',
        step: 2,
        at: 100_000,
        chunks: [[100_000, 'output', 'x'.repeat(40)], [100_100, 'output', 'x'.repeat(40)]],
        settledAtMs: 100_200,
      },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 600, endMs: 99_000 }],
    endMs: 101_000,
  })
  assert.equal(curve.durationMs, 700, 'a 98.4 s tool contributes nothing to the axis')
  assert.deepEqual(curve.segments.map(segment => [segment.attemptId, segment.startMs, segment.endMs]), [
    ['a', 0, 500], ['b', 500, 700],
  ], 'attempt B opens exactly where attempt A\'s clock stopped')
  assert.deepEqual(attemptOf(curve, 'a').points.map(point => point.tps), [0, 1000, 500, 333, 500, 400],
    'A is measured on its own clock up to its settlement')
  assert.deepEqual(attemptOf(curve, 'b').points.map(point => point.tps), [0, 200, 100],
    'B opens at zero on its own clock: the tool wait is in no denominator')
  assert.equal(attemptOf(curve, 'b').points[0].timeMs, 500, 'and it starts at the abutting coordinate')
  assert.equal(curve.peakTps, 1000)
})

test('a single-delta attempt is one vertex of zero width', () => {
  const { curve } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(40)]], settledAtMs: 0 }],
    endMs: 100,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps, point.activePhase]), [[0, 0, 'output']],
    'the opening instant has no elapsed clock, so it publishes the anchor zero')
  assert.equal(curve.durationMs, 0, 'the attempt owns no width')
  assert.deepEqual(curve.segments.map(segment => [segment.startMs, segment.endMs]), [[0, 0]])
  assert.equal(curve.peakTps, 0, 'the only published vertex is the anchor')
  assert.equal(trace.tokens, 10)

  /** The same one delta with a settlement tail: the tail is drawn, still from one sample. */
  const { curve: tailed } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(40)]], settledAtMs: 200 }],
    endMs: 300,
  })
  assert.deepEqual(attemptOf(tailed, 'a').points.map(point => [point.localMs, point.tps]),
    [[0, 0], [100, 100], [200, 50]])
})

test('a very long attempt is resampled to exactly 200 nearest-neighbour points', () => {
  const chunks = []
  for (let index = 0; index <= 300; index += 1) {
    chunks.push([index * 100, 'output', '字'.repeat(index + 1)])
  }
  const { curve } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks, settledAtMs: 30_000 }],
    endMs: 31_000,
  })
  const trace = attemptOf(curve, 'a')
  const points = trace.points
  assert.equal(MAX_SERIES_POINTS, 200)
  assert.equal(curve.maxSeriesPoints, MAX_SERIES_POINTS)
  assert.equal(30_000 / DEFAULT_SAMPLE_EVERY_MS + 1, 301, 'the raw ladder would be 301 vertices')
  assert.equal(points.length, MAX_SERIES_POINTS, 'a longer series is resampled to exactly the cap')
  assert.equal(points[0].localMs, 0)
  assert.equal(points[0].tps, 0)
  assert.equal(points[1].localMs, 200,
    'the first target falls nearest the second raw sample (49.2 ms away) rather than the first (50.8 ms)')
  assert.equal(points[1].tps, 30)
  assert.equal(points.at(-1).localMs, 30_000)
  assert.equal(points.at(-1).tps, 1515)
  assert.equal(points.some(point => point.localMs === 100), false,
    'a raw sample the resampling skips is a value the card does not report')

  /** Every published point is a raw sample's own value: nearest-neighbour, no interpolation. */
  const massAt = localMs => {
    const index = localMs / DEFAULT_SAMPLE_EVERY_MS
    return (index + 1) * (index + 2) / 2
  }
  for (const point of points) {
    const expected = point.localMs === 0 ? 0 : Math.round(massAt(point.localMs) * 1000 / point.localMs)
    assert.equal(point.tps, expected, `at local ${point.localMs} the published value is the raw sample's own`)
  }
  assert.equal(curve.peakTps, 1515)
  assert.equal(curve.peakTps, peakTps(points), 'the peak is the maximum of the published series')
})

test('the published peak is taken after the cap, so a skipped spike is not reported', () => {
  /**
   * One 400-token delta followed by thirty seconds of silence. The raw series peaks at
   * 4000 tokens/s on its second vertex; the 200-point resampling skips that vertex (its
   * first target lands on 200 ms), so the published series peaks at 2000. The cap is a
   * stored-series fidelity decision and the published peak is the maximum of the
   * published series — a value the resampling skips is a value the card does not report.
   */
  const { curve } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(1600)]], settledAtMs: 30_000 }],
    endMs: 31_000,
  })
  const points = attemptOf(curve, 'a').points
  assert.equal(points.length, MAX_SERIES_POINTS)
  assert.equal(points.some(point => point.localMs === 100), false, 'the raw peak vertex is skipped by the cap')
  assert.equal(Math.round(400 * 1000 / 100), 4000, 'the raw series would peak at 4000')
  assert.equal(points[1].localMs, 200)
  assert.equal(points[1].tps, 2000)
  assert.equal(curve.peakTps, 2000, 'the published peak is the maximum of the published series')
  assert.equal(curve.peakTps, peakTps(points))
})

test('the turn peak is the maximum over the per-attempt published series, never a sum', () => {
  const { curve } = build({
    attempts: [
      {
        id: 'a',
        step: 1,
        at: 0,
        chunks: [[0, 'output', 'x'.repeat(400)], [100, 'output', 'x'.repeat(400)]],
        settledAtMs: 200,
      },
      {
        id: 'b',
        step: 2,
        at: 10_000,
        chunks: [[10_000, 'output', 'x'.repeat(40)], [10_100, 'output', 'x'.repeat(40)]],
        settledAtMs: 10_200,
      },
      { id: 'c', step: 3, at: 20_000, chunks: [[20_000, 'output', 'x'.repeat(40)]], settledAtMs: 20_200 },
    ],
    endMs: 21_000,
  })
  assert.equal(curve.attempts.length, 3)
  assert.deepEqual(curve.attempts.map(attempt => attempt.attemptId), ['a', 'b', 'c'])
  assert.deepEqual(attemptOf(curve, 'a').points.map(point => point.tps), [0, 2000, 1000])
  assert.deepEqual(attemptOf(curve, 'b').points.map(point => point.tps), [0, 200, 100])
  assert.deepEqual(attemptOf(curve, 'c').points.map(point => point.tps), [0, 100, 50])
  assert.deepEqual(curve.attempts.map(attempt => peakTps(attempt.points)), [2000, 200, 100])
  assert.equal(curve.peakTps, 2000, 'the fastest single call decides')
  assert.notEqual(curve.peakTps, 2300, 'never the three attempts added together')
  assert.equal(peakTps(...curve.attempts.map(attempt => attempt.points)), curve.peakTps,
    'the invariant: the published peak is the maximum of the published series')
  assert.equal(curve.durationMs, 600, 'and the axis is the three attempts\' own widths')
})
