/**
 * The completed-curve regression matrix (Phase 9.2, re-frozen under the Phase 9.4
 * publication policy).
 *
 * One named scenario per frozen curve semantic, so a future change that fixes one
 * behaviour and quietly breaks another is caught by name rather than by a single large
 * assertion block. Every scenario asserts the **published numbers**: the exact vertex
 * list of the settled snapshot, derived from the script by the phase-cumulative
 * definition — the mass of the episode in force over its own elapsed clock, `Math.round`,
 * `tps: null` wherever the shared publication policy withholds the rate, the trace running
 * from each episode's own origin to the attempt's own end instant — and never read back
 * out of the curve.
 *
 * ## The semantics this file freezes
 *
 *   - **One attempt, one trace, one episode clock per phase stretch.** A vertex at
 *     attempt-local `t` reports `round(mass * 1000 / (t - firstSampleOfEpisode))` over the
 *     maximal run of consecutive same-phase samples of *that attempt*. A phase change
 *     resets the clock and the numerator; two attempts sharing a compressed coordinate
 *     share no clock at all.
 *   - **The vertex grid is each episode's own 100 ms ladder.** One episode's vertices are
 *     `episodeStart, episodeStart + 100, …` up to the instant the next episode opens — or
 *     the attempt's own end, for the terminal episode — plus the attempt's end instant when
 *     it does not fall on that ladder. An episode opening between two instants of an
 *     attempt-global grid used to acquire a first denominator of one step's remainder, 1 ms
 *     in the worst case; on this grid that vertex does not exist, and no episode is ever
 *     measured over less than a full step of its own clock.
 *   - **A vertex is a measurement only when the shared publication policy admits it**
 *     (`src/core/rate-publication.js`): at least three contributing samples *and* at least
 *     100 ms of the episode's own clock. Every other vertex carries `tps: null` — never a
 *     fabricated `0` — with `publishable: false` and the reason it was withheld. Every
 *     episode below therefore carries at least three deltas, which is the smallest fixture
 *     the corrected contract can express.
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
 *     interpolation, and `peakTps` is the maximum of its **publishable** points — `null`
 *     when no vertex passed the gates, rather than a fabricated zero — taken over
 *     attempts, never as their sum.
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
      /** Three deltas of ten estimated tokens each: the smallest episode the gates admit. */
      chunks: [
        [0, 'reasoning', 'x'.repeat(40)],
        [100, 'reasoning', 'x'.repeat(40)],
        [200, 'reasoning', 'x'.repeat(40)],
      ],
      settledAtMs: 500,
    }],
    endMs: 600,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, 150], [300, 100], [400, 75], [500, 60],
  ], 'the opening vertex has no elapsed clock and the second holds two samples, so both are '
    + 'withheld; from 200 ms the episode\'s thirty tokens over its own clock: 30 * 1000 / 200 = 150, '
    + '30 * 1000 / 300 = 100, 30 * 1000 / 400 = 75, 30 * 1000 / 500 = 60')
  assert.equal(trace.points[0].publishable, false)
  assert.equal(trace.points[0].rateUnavailableReason, 'opening-anchor',
    'the episode\'s own origin is not a measurement, and says so rather than publishing a zero')
  assert.equal(trace.points[1].rateUnavailableReason, 'below-sample-warmup',
    'two contributing samples are not a rate, however far the episode clock has advanced')
  assert.equal(trace.points.every(point => point.activePhase === 'reasoning'), true)
  assert.equal(curve.durationMs, 500)
  assert.equal(runsOf(curve, 'reasoning').length, 1)
  assert.equal(runsOf(curve, 'output').length, 0, 'a phase that produced nothing has no run, not a flat zero')
  assert.equal(curve.peakTps, 150)
})

test('output-only: the same estimator over text deltas', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'output', 'x'.repeat(40)], [100, 'output', 'x'.repeat(40)], [200, 'output', 'x'.repeat(40)],
        [700, 'output', 'x'.repeat(40)],
      ],
      settledAtMs: 1000,
    }],
    endMs: 1100,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, 150], [300, 100], [400, 75], [500, 60], [600, 50],
    [700, 57], [800, 50], [900, 44], [1000, 40],
  ], 'the fourth delta raises the numerator at 700 ms — 40 * 1000 / 700 = 57 — and the clock '
    + 'dilutes it again: 40 * 1000 / 800 = 50, / 900 = 44, / 1000 = 40')
  assert.equal(trace.points.every(point => point.activePhase === 'output'), true)
  assert.equal(curve.peakTps, 150)
})

test('reasoning then output: the transition resets the magnitude and shares its vertex', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'reasoning', 'x'.repeat(40)], [100, 'reasoning', 'x'.repeat(40)], [200, 'reasoning', 'x'.repeat(40)],
        [500, 'output', 'x'.repeat(40)], [600, 'output', 'x'.repeat(40)], [700, 'output', 'x'.repeat(40)],
      ],
      settledAtMs: 1100,
    }],
    endMs: 1200,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, 150], [300, 100], [400, 75],
    [500, null], [600, null], [700, 150], [800, 100], [900, 75], [1000, 60], [1100, 50],
  ], 'each episode is measured on its own ladder: three ten-token deltas over 200 ms is 150, and '
    + 'the output episode opens its own clock and ladder at 500 ms — no 50 ms denominator exists '
    + 'between them, and its own climb is 30 * 1000 / 200 = 150 at 700 ms')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 4], ['output', 4, 11],
  ], 'the two subpaths meet on the shared seam vertex')
  assert.equal(trace.points[4].localMs, 400)
  assert.equal(trace.points[4].activePhase, 'reasoning',
    'the seam is the outgoing stretch\'s own last labelled vertex')
  assert.equal(trace.points[4].tps, 75, 'and it carries the outgoing episode\'s own last measurement')
  assert.equal(trace.points[5].tps, null, 'the new episode opens on the vertex after it')
  assert.equal(trace.points[5].rateUnavailableReason, 'opening-anchor',
    'its elapsed clock is zero, so it publishes nothing at all')
  assert.equal(trace.runs[0].points.at(-1), trace.runs[1].points[0],
    'the seam is one measurement, emitted by both subpaths')
  assert.equal(curve.peakTps, 150)
})

test('reasoning → output → reasoning: three episodes, three runs, one trace', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'reasoning', 'x'.repeat(40)], [100, 'reasoning', 'x'.repeat(40)], [200, 'reasoning', 'x'.repeat(40)],
        [300, 'output', 'x'.repeat(40)], [400, 'output', 'x'.repeat(40)], [500, 'output', 'x'.repeat(40)],
        [600, 'reasoning', 'x'.repeat(40)], [700, 'reasoning', 'x'.repeat(40)], [800, 'reasoning', 'x'.repeat(40)],
      ],
      settledAtMs: 900,
    }],
    endMs: 1000,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, 150],
    [300, null], [400, null], [500, 150],
    [600, null], [700, null], [800, 150], [900, 100],
  ], 'each phase stretch owns its clock and its own ladder: two resets, two climbs, and a third '
    + 'episode that opens at 600 ms and publishes nothing until its own third delta and its own '
    + 'first full step have both arrived')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 2], ['output', 2, 5], ['reasoning', 5, 9],
  ])
  for (let index = 1; index < trace.runs.length; index += 1) {
    assert.equal(trace.runs[index - 1].points.at(-1), trace.runs[index].points[0],
      'a tone change is a shared vertex, not a gap')
  }
  assert.equal(trace.runs.reduce((sum, run) => sum + run.pointCount, 0),
    trace.points.length + trace.runs.length - 1,
    'the runs tile the trace grid, charging the shared seam once per subpath')
  assert.equal(curve.peakTps, 150)
})

test('a long intra-attempt stall decays hyperbolically and strictly', () => {
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'output', 'x'.repeat(400)], [100, 'output', 'x'.repeat(400)], [200, 'output', 'x'.repeat(400)],
        [3000, 'output', 'x'.repeat(400)],
      ],
      settledAtMs: 3200,
    }],
    endMs: 3300,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.samples.map(sample => sample.activeTimeMs), [0, 100, 200, 3000],
    'the stall is a real silence: no sample arrives between 200 ms and 3000 ms')
  assert.deepEqual(trace.points.map(point => point.tps), [
    null, null,
    1500, 1000, 750, 600, 500, 429, 375, 333, 300, 273, 250, 231, 214, 200, 188, 176, 167, 158,
    150, 143, 136, 130, 125, 120, 115, 111, 107, 103,
    133, 129, 125,
  ], 'three hundred tokens frozen while the denominator advances: 300 * 1000 / 200 = 1500 falling '
    + 'to 300 * 1000 / 2900 = 103, with the first two vertices withheld by the gates; the delta '
    + 'resuming at 3000 ms raises the numerator to 400 and the clock dilutes it again')

  /**
   * The stall itself, vertex by vertex: from the episode's first published instant to the
   * instant before the model resumes, the value must fall at every step. A windowed
   * estimator would have reached zero here; the cumulative one cannot.
   */
  const decay = trace.points.slice(2, 30)
  for (let index = 1; index < decay.length; index += 1) {
    assert.ok(decay[index].tps < decay[index - 1].tps,
      `the stall must decay strictly while no sample arrives: ${decay[index - 1].tps} at `
      + `${decay[index - 1].localMs} ms, then ${decay[index].tps} at ${decay[index].localMs} ms`)
  }
  assert.equal(decay.every(point => point.tps > 0), true,
    'the hyperbolic decay never reaches exactly zero while the attempt is alive')
  assert.equal(trace.points[30].localMs, 3000)
  assert.equal(trace.points[30].tps, 133, 'the resumed delta raises the frozen stretch: 400 * 1000 / 3000')
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
    null, null, 150, 100, 75, 60, 50, 43, 38, 33, 30, 27, 25, 23, 21, 20,
    19, 18, 17, 16, 15, 14, 14, 13, 13, 12, 12, 11, 11, 10, 10,
  ], 'thirty tokens over three seconds of clock: the anchor and the two-sample vertex are withheld, '
    + 'then 30 * 1000 / 200 = 150 decays to 30 * 1000 / 3000 = 10 as the tail is drawn to settlement')
  assert.equal(trace.points.at(-1).localMs, 3000)
  assert.equal(trace.points.at(-1).tps, 10, 'and it never reaches exactly zero')
  assert.equal(trace.points.slice(2).every(point => point.tps > 0), true)
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
        chunks: [
          [0, 'output', 'x'.repeat(400)], [100, 'output', 'x'.repeat(400)], [400, 'output', 'x'.repeat(400)],
        ],
        settledAtMs: 500,
      },
      {
        id: 'b',
        step: 2,
        at: 100_000,
        chunks: [
          [100_000, 'output', 'x'.repeat(40)],
          [100_100, 'output', 'x'.repeat(40)],
          [100_200, 'output', 'x'.repeat(40)],
        ],
        settledAtMs: 100_300,
      },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 600, endMs: 99_000 }],
    endMs: 101_000,
  })
  assert.equal(curve.durationMs, 800, 'a 98.4 s tool contributes nothing to the axis')
  assert.deepEqual(curve.segments.map(segment => [segment.attemptId, segment.startMs, segment.endMs]), [
    ['a', 0, 500], ['b', 500, 800],
  ], 'attempt B opens exactly where attempt A\'s clock stopped')
  assert.deepEqual(attemptOf(curve, 'a').points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, null], [300, null], [400, 750], [500, 600],
  ], 'A is measured on its own clock up to its settlement: the third delta admits the episode at '
    + '400 ms, 300 * 1000 / 400 = 750, then 300 * 1000 / 500 = 600')
  assert.deepEqual(attemptOf(curve, 'b').points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, 150], [300, 100],
  ], 'B opens at zero on its own clock: the tool wait is in no denominator')
  assert.equal(attemptOf(curve, 'b').points[0].timeMs, 500, 'and it starts at the abutting coordinate')
  assert.equal(curve.peakTps, 750)
})

test('a single-delta attempt is one vertex of zero width', () => {
  const { curve } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(40)]], settledAtMs: 0 }],
    endMs: 100,
  })
  const trace = attemptOf(curve, 'a')
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps, point.activePhase]), [[0, null, 'output']],
    'the opening instant has no elapsed clock and one contributing sample, so it publishes nothing')
  assert.equal(trace.points[0].publishable, false)
  assert.equal(trace.points[0].rateUnavailableReason, 'opening-anchor')
  assert.equal(curve.durationMs, 0, 'the attempt owns no width')
  assert.deepEqual(curve.segments.map(segment => [segment.startMs, segment.endMs]), [[0, 0]])
  assert.equal(curve.peakTps, null, 'one delta is not a rate, so the turn has no peak at all')
  assert.equal(trace.tokens, 10)

  /** The same one delta with a settlement tail: the tail is drawn, still from one sample. */
  const { curve: tailed } = build({
    attempts: [{ id: 'a', step: 1, at: 0, chunks: [[0, 'output', 'x'.repeat(40)]], settledAtMs: 200 }],
    endMs: 300,
  })
  assert.deepEqual(attemptOf(tailed, 'a').points.map(point => [point.localMs, point.tps]),
    [[0, null], [100, null], [200, null]],
    'the tail is drawn vertex by vertex, and every vertex is withheld: one sample is below the '
    + 'sample gate however far the episode clock has advanced')
  assert.deepEqual(attemptOf(tailed, 'a').points.map(point => point.rateUnavailableReason),
    ['opening-anchor', 'below-sample-warmup', 'below-sample-warmup'])
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
  assert.equal(points[0].tps, null, 'the opening anchor of the one episode is not a rate')
  assert.equal(points[0].rateUnavailableReason, 'opening-anchor')
  assert.equal(points[1].localMs, 200,
    'the first target falls nearest the second raw sample (49.2 ms away) rather than the first (50.8 ms)')
  assert.equal(points[1].tps, 30, 'the raw 200 ms vertex\'s own value: six tokens over 200 ms')
  assert.equal(points.at(-1).localMs, 30_000)
  assert.equal(points.at(-1).tps, 1515)
  assert.equal(points.some(point => point.localMs === 100), false,
    'the raw ladder has a vertex at 100 ms and the published series does not: the cap is nearest-neighbour')

  /**
   * Every published point is a raw sample's own value: nearest-neighbour, no interpolation.
   * The samples arrive one per ladder step, so the vertex at index `k` holds `k + 1` of them
   * and only the third onward can be published at all.
   */
  const massAt = localMs => {
    const index = localMs / DEFAULT_SAMPLE_EVERY_MS
    return (index + 1) * (index + 2) / 2
  }
  for (const point of points) {
    const samples = point.localMs / DEFAULT_SAMPLE_EVERY_MS + 1
    const expected = samples < 3 ? null : Math.round(massAt(point.localMs) * 1000 / point.localMs)
    assert.equal(point.tps, expected,
      `at local ${point.localMs} the published value is the raw sample's own, over its ${samples} samples`)
  }
  assert.equal(curve.peakTps, 1515)
  assert.equal(curve.peakTps, peakTps(points), 'the peak is the maximum of the published series')
})

test('the published peak is taken after the cap, so a skipped spike is not reported', () => {
  /**
   * A 400-token opening delta, then two ten-token deltas at 50 and 100 ms that bring the
   * episode over the sample gate, then thirty seconds of silence. The raw series peaks at
   * `420 * 1000 / 100 = 4200` on the vertex at 100 ms; the 200-point resampling skips that
   * vertex (its first target lands on 200 ms), so the published series peaks at 2100. The cap
   * is a stored-series fidelity decision and the published peak is the maximum of the
   * published series — a value the resampling skips is a value the card does not report.
   */
  const { curve } = build({
    attempts: [{
      id: 'a',
      step: 1,
      at: 0,
      chunks: [
        [0, 'output', 'x'.repeat(1600)], [50, 'output', 'x'.repeat(40)], [100, 'output', 'x'.repeat(40)],
      ],
      settledAtMs: 30_000,
    }],
    endMs: 31_000,
  })
  const trace = attemptOf(curve, 'a')
  const points = trace.points
  assert.deepEqual(trace.samples.map(sample => sample.activeTimeMs), [0, 50, 100],
    'all three deltas are inside the first 100 ms, so the raw peak vertex is a measurement')
  assert.equal(points.length, MAX_SERIES_POINTS)
  assert.equal(points.some(point => point.localMs === 100), false, 'the raw peak vertex is skipped by the cap')
  assert.equal(Math.round(420 * 1000 / 100), 4200, 'the raw series would peak at 4200')
  assert.equal(points[1].localMs, 200)
  assert.equal(points[1].tps, Math.round(420 * 1000 / 200), 'the raw 200 ms vertex\'s own value')
  assert.equal(points[1].tps, 2100)
  assert.equal(curve.peakTps, 2100, 'the published peak is the maximum of the published series')
  assert.equal(curve.peakTps, peakTps(points))
})

test('the turn peak is the maximum over the per-attempt published series, never a sum', () => {
  const { curve } = build({
    attempts: [
      {
        id: 'a',
        step: 1,
        at: 0,
        chunks: [
          [0, 'output', 'x'.repeat(400)], [100, 'output', 'x'.repeat(400)], [200, 'output', 'x'.repeat(400)],
        ],
        settledAtMs: 300,
      },
      {
        id: 'b',
        step: 2,
        at: 10_000,
        chunks: [
          [10_000, 'output', 'x'.repeat(40)], [10_100, 'output', 'x'.repeat(40)], [10_200, 'output', 'x'.repeat(40)],
        ],
        settledAtMs: 10_300,
      },
      {
        id: 'c',
        step: 3,
        at: 20_000,
        chunks: [
          [20_000, 'output', 'x'.repeat(40)], [20_100, 'output', 'x'.repeat(40)], [20_200, 'output', 'x'.repeat(40)],
        ],
        settledAtMs: 20_300,
      },
    ],
    endMs: 21_000,
  })
  assert.equal(curve.attempts.length, 3)
  assert.deepEqual(curve.attempts.map(attempt => attempt.attemptId), ['a', 'b', 'c'])
  assert.deepEqual(attemptOf(curve, 'a').points.map(point => point.tps), [null, null, 1500, 1000])
  assert.deepEqual(attemptOf(curve, 'b').points.map(point => point.tps), [null, null, 150, 100])
  assert.deepEqual(attemptOf(curve, 'c').points.map(point => point.tps), [null, null, 150, 100])
  assert.deepEqual(curve.attempts.map(attempt => peakTps(attempt.points)), [1500, 150, 150])
  assert.equal(curve.peakTps, 1500, 'the fastest single call decides')
  assert.notEqual(curve.peakTps, 1800, 'never the three attempts added together')
  assert.equal(peakTps(...curve.attempts.map(attempt => attempt.points)), curve.peakTps,
    'the invariant: the published peak is the maximum of the published series')
  assert.equal(curve.durationMs, 900, 'and the axis is the three attempts\' own widths')
})
