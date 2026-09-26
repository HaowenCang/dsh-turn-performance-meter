/**
 * Same-attempt resumption inside one continuous trace.
 *
 * The independent Phase 7 audit found a rolling-window defect that the Phase 6
 * attempt-boundary fix did not cover. `rollingTpsSeries` carried this lower bound:
 *
 *     const lowerExclusive = localMs <= fromMs
 *       ? Number.NEGATIVE_INFINITY
 *       : localMs - windowMs
 *
 * The special case was written for an attempt's *first* episode, where local zero is
 * the attempt's own opening delta and a half-open `(-windowMs, 0]` window has nothing
 * to measure — the reasoning was that reporting `0 tokens/s` on the vertex carrying
 * the call's first tokens would be a fabricated trough.
 *
 * Attempt-local zero is a **derived** coordinate, not an attempt-level one. An attempt
 * whose phase fell silent for longer than one window produced two episodes, and the
 * second episode's opening vertex sat at `localMs == fromMs` again — for the episode,
 * not for the attempt. The condition could not tell the two apart, so it reopened the
 * window to negative infinity at an instant where the frozen trailing definition
 * `(t - windowMs, t]` had already evicted everything older than `t - windowMs`.
 *
 * The consequence was a measured value no definition produces. An output delta at
 * attempt-local 0 ms and another at 3000 ms, one window of 1000 ms, is two episodes
 * `0 -> 1000` and `3000 -> 4000`. At the second episode's opening instant `t = 3000`
 * the window is `(2000, 3000]`, which contains the 3000 ms delta and nothing else, so
 * the rate is 100 tokens/s. The shipped code reported 200, having resurrected a sample
 * from three windows earlier because that vertex happened to be an episode opening.
 *
 * ## What Phase 7C changed about the *drawing*, not about the number
 *
 * Both episodes of this fixture belong to **one attempt**, so nothing here was ever an
 * attempt-boundary effect, and the window definition Phase 7 corrected is unchanged.
 * What Phase 7C removed is the **episode cut**: the trace of one attempt is drawn
 * continuously across a silence, because a stall inside a model call is a throughput
 * fact the chart exists to show. The resumption instant is therefore no longer "the
 * opening vertex of a second run" but "a vertex at which the trailing rate climbs back
 * from zero" — and it must still read 100, never 200. Every assertion below is about
 * that number.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { DEFAULT_SAMPLE_EVERY_MS, DEFAULT_WINDOW_MS } from '../src/core/curve.js'

function outputChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

/**
 * One attempt, one phase, two token-producing instants three windows apart.
 *
 * 400 characters is 100 estimated tokens, so each sample weighs exactly 100 and every
 * expected rate below is a whole multiple of 100.
 */
function driveTwoEpisodeAttempt(store, { secondSampleMs = 3000, toMs = null } = {}) {
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'episode-attempt', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: outputChunk('x'.repeat(400)) })
  store.acceptChunk(record, attempt, { timeMs: secondSampleMs, chunk: outputChunk('x'.repeat(400)) })
  store.settleAttempt(attempt, {
    settledAtMs: secondSampleMs + 50,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  const curve = store.endTurn(record, { timeMs: secondSampleMs + 100, status: 'completed' }).curve
  const trace = curve.attempts[0]
  /**
   * Every vertex the window rule places, from local zero to the attempt's **own last
   * sample**. Since Phase 7C.1 there is one ladder and no tail: the axis is compressed model
   * generation, so it stops where the model stopped producing, and a resumption that falls
   * between two cadence instants is reached through the endpoint anchor instead.
   */
  const points = toMs === null
    ? trace.points
    : trace.points.filter(point => point.localMs <= toMs + 1e-9)
  return {
    record,
    curve,
    trace,
    points,
    runs: curve.series.find(series => series.key === 'output').runs,
  }
}

/** The trace's rate at one attempt-local instant. */
function tpsAt(points, localMs) {
  const point = points.find(candidate => candidate.localMs === localMs)
  return point === undefined ? undefined : point.tps
}

test('a resumption after a long silence measures only its own trailing window', () => {
  const store = new TurnTelemetryStore()
  const { points, runs } = driveTwoEpisodeAttempt(store)

  assert.equal(runs.length, 1, 'one call, one phase, one continuous coloured run')
  assert.equal(runs[0].attemptId, 'episode-attempt')
  assert.equal(points[0].localMs, 0)
  assert.equal(points.at(-1).localMs, 3000,
    'the trace covers the attempt and stops on its own last delta; it draws no one-window tail')

  /**
   * The decisive assertion. The model resumes at local 3000, so the window there is
   * `(2000, 3000]`. The only sample inside it is the 3000 ms delta: 100 tokens over
   * 1000 ms is 100 tokens/s.
   */
  assert.equal(tpsAt(points, 3000), 100,
    `expected resumption TPS = 100, actual = ${tpsAt(points, 3000)}`)
  assert.equal(tpsAt(points, 2750), 0, 'and the silence before it is a real zero on the same run')
})

test('the attempt\'s opening vertex still includes the attempt\'s own first sample', () => {
  const store = new TurnTelemetryStore()
  const { points } = driveTwoEpisodeAttempt(store)

  /**
   * The behaviour the removed special case was written to protect, and which the
   * unified bound preserves for free: `localMs - windowMs` at local zero is `-1000`,
   * and a sample at zero lies inside `(-1000, 0]`. No negative-infinity clamp is needed
   * to include the opening delta, which is why removing it costs nothing.
   */
  assert.equal(points[0].localMs, 0)
  assert.equal(points[0].tps, 100,
    'attempt local zero under an unclamped bound still reports its opening delta')
  assert.deepEqual(points.slice(0, 5).map(point => point.tps), [100, 100, 100, 100, 0],
    'and it decays to zero exactly one window later')
  assert.equal(DEFAULT_WINDOW_MS, 1000)
  assert.equal(DEFAULT_SAMPLE_EVERY_MS, 250)
})

test('a silence longer than one window is drawn, and the eviction at its edge is half-open', () => {
  /**
   * A gap of exactly one window never empties the trailing window, so the trace stays
   * continuous through it; one millisecond more and there is a genuine zero between the
   * two samples. Both are now values on **one** run rather than a split into two.
   */
  const oneWindow = driveTwoEpisodeAttempt(new TurnTelemetryStore(), { secondSampleMs: 1000 })
  assert.equal(oneWindow.runs.length, 1, 'one phase is always one run')
  /**
   * The trace reads 100 at every vertex of the first second, and that is not a defect:
   * at `t = 1000` the window is `(0, 1000]`, so the sample at zero expires at exactly
   * the instant the sample at 1000 arrives. Continuity here comes from the samples
   * abutting, not from either one being held beyond its window — which is why the
   * series never reaches 200 anywhere in the attempt. A value of 200 would require the
   * sample at zero to be measured one window late, the very defect Phase 7 corrected.
   */
  assert.deepEqual(oneWindow.points.map(point => point.tps),
    [100, 100, 100, 100, 100],
    'abutting samples keep the trace continuous, with no fabricated zero and no double count')
  assert.equal(Math.max(...oneWindow.points.map(point => point.tps)), 100)

  /** One millisecond more and the window really did reach zero in between. */
  const pastWindow = driveTwoEpisodeAttempt(new TurnTelemetryStore(), { secondSampleMs: 1001, toMs: 1001 })
  assert.equal(pastWindow.runs.length, 1, 'the silence does not split the run')
  assert.equal(pastWindow.points.at(-1).localMs, 1001,
    'the trace ends on the attempt\'s own final instant, off the cadence, because the endpoint is an anchor')
  /**
   * The vertices are the cadence ladder `0, 250, 500, 750, 1000` plus the attempt's own final
   * instant `1001`, which the anchor appends because it does not fall on a whole step.
   *
   * The vertex at 1001 measures `(1, 1001]`, which contains the sample at 1001 and excludes
   * the one at 0 — half-open on the left, as the live meter's `SlidingWindowMeter` implements
   * and `docs/METRICS_SPEC.md` §8.1 specifies. The previous expectation carried a tail ladder
   * out to `2001`; that ladder was post-generation time and is what Phase 7C.1 removed.
   */
  assert.deepEqual(pastWindow.points.map(point => [point.localMs, point.tps]), [
    [0, 100], [250, 100], [500, 100], [750, 100], [1000, 0], [1001, 100],
  ], 'gap = window + 1 opens on its own sample alone, after a real zero at the silence, and the '
    + 'trace ends where the model stopped producing')
})

test('the correction does not depend on the silence length, only on the window', () => {
  /**
   * Every gap below is longer than one window, so the resumption is measured against a
   * window that no longer holds the earlier burst, and the trace must reach 100 again
   * without ever exceeding it. The list is deliberately ragged rather than generated, so
   * a future refactor cannot satisfy it by construction.
   */
  for (const secondSampleMs of [1001, 1002, 1125, 1250, 1750, 2000, 3500, 8000]) {
    const { points } = driveTwoEpisodeAttempt(new TurnTelemetryStore(), { secondSampleMs })
    /**
     * Independent upper bound: this attempt produced 100 tokens per burst, so within one
     * window no vertex can exceed 100 tokens/s. A resurrected sample from an earlier
     * burst is the only way to exceed it, which makes this assertion a statement about
     * the window rather than about a constant.
     */
    for (const point of points) {
      assert.ok(point.tps <= 100 + 1e-9,
        `${secondSampleMs} ms gap: vertex ${point.timeMs} claims ${point.tps} tokens/s from one 100-token burst`)
    }
    /**
     * And it still measures the resumed burst: somewhere at or after the resumption the
     * trace is back at 100, and somewhere before it the trace had reached zero. A single
     * run with both in it is exactly what "a stall stays visible" means.
     */
    const resumption = points.find(point => point.localMs >= secondSampleMs && point.tps === 100)
    assert.ok(resumption !== undefined,
      `a ${secondSampleMs} ms gap must be followed by a measured 100 tokens/s, not a resurrected sample`)
    const before = points.filter(point => point.localMs < secondSampleMs)
    assert.equal(before.at(-1).tps, 0,
      `a ${secondSampleMs} ms gap must show a real zero at the end of the silence; got ${before.at(-1).tps}`)
  }
})

/**
 * Live-vs-completed equivalence inside one attempt.
 *
 * Phase 6 verified this across an attempt boundary, where the live meter's
 * `attemptStarted` reset and the completed curve's per-attempt partition are two
 * independent implementations of the same rule. The Phase 7 defect was not a boundary
 * effect at all: it lived inside one attempt, at the resumption instant. The
 * equivalence therefore has to be asserted there too, and it is the sharpest available
 * check, because the live meter never had the defect — its `SlidingWindowMeter` rolls
 * an unconditional `(t - windowMs, t]` and has no notion of an episode — so the two
 * implementations disagreed exactly where the completed curve went wrong.
 *
 * The fixture is the audit's own: output deltas at attempt-local 0 ms and 3000 ms, one
 * window of 1000 ms. The live meter is read at every 250 ms grid instant during the
 * attempt, with each chunk accepted before it is read, and every reading is then
 * matched against the completed curve's vertex at the same attempt-local instant.
 */
test('a resumption inside one attempt: the completed curve equals what the live meter read', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'episode-attempt', step: 1, startedAtMs: 0 })

  /**
   * Read live across the whole attempt, before any settlement exists, so the two values
   * come from genuinely different machinery: the meter's rolling window and the curve's
   * reconstruction from stored samples.
   */
  const live = []
  for (let localMs = 0; localMs <= 4000; localMs += DEFAULT_SAMPLE_EVERY_MS) {
    if (localMs === 0 || localMs === 3000) {
      store.acceptChunk(record, attempt, { timeMs: localMs, chunk: outputChunk('x'.repeat(400)) })
    }
    live.push({ localMs, tps: store.liveSnapshot('s1', localMs).tps })
  }
  store.settleAttempt(attempt, {
    settledAtMs: 3100,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  const curve = store.endTurn(record, { timeMs: 4100, status: 'completed' }).curve
  const points = curve.attempts[0].points

  /** The live reading at the resumption instant, which is the disputed one. */
  const liveAtOpening = live.find(point => point.localMs === 3000)
  assert.equal(liveAtOpening.tps, 100,
    'the live meter measures the trailing window and reports 100 at 3000 ms')

  /**
   * The decisive comparison. Every live reading must equal the completed curve's vertex
   * at the same attempt-local instant. `completed = 200, live = 100` is the defect this
   * test exists to make impossible; an instant the curve does not sample is skipped,
   * because the two grids are asserted equal elsewhere.
   */
  let compared = 0
  for (const reading of live) {
    if (!Number.isFinite(reading.tps)) continue
    const point = points.find(candidate => candidate.localMs === reading.localMs)
    if (point === undefined) continue
    compared += 1
    assert.equal(point.tps, reading.tps,
      `attempt-local ${reading.localMs}: the live meter said ${reading.tps}, the completed curve says ${point.tps}`)
  }
  assert.ok(compared >= 9, `the comparison covered ${compared} instants`)

  /** The two instants that pin the fixture, restated as explicit values. */
  assert.equal(live.find(point => point.localMs === 1000).tps, 0,
    'the live meter expires the opening delta one window after it arrived')
  assert.equal(tpsAt(points, 3000), 100)
  assert.equal(curve.peakTps, 100,
    'no window ever holds both deltas, so the completed peak is one delta, not two')
  assert.equal(curve.series.find(series => series.key === 'output').peak, 100,
    'and the drawn run reports the same reading the live meter did')
})

test('a new attempt still resets the live window and the completed curve together', () => {
  /**
   * The Phase 6 result, re-asserted because the corrections above changed the window
   * definition both paths share: the reset must survive it. Attempt B streams the same
   * shape as attempt A, so a bridged window would make its opening reading larger than
   * A's — the one outcome both implementations must refuse.
   */
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const a = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, a, { timeMs: 0, chunk: outputChunk('x'.repeat(400)) })
  const liveA = store.liveSnapshot('s1', 0).tps
  store.settleAttempt(a, {
    settledAtMs: 50,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  store.toolStarted(record, { callId: 't1', name: 'pwsh', timeMs: 100 })
  store.toolSettled(record, { callId: 't1', timeMs: 61_000, status: 'ok' })

  const b = store.beginAttempt(record, { attemptId: 'b', step: 2, startedAtMs: 61_100 })
  /** A fresh attempt's window is empty before its first delta, read live. */
  assert.equal(store.liveSnapshot('s1', 61_100).tps, 0)
  store.acceptChunk(record, b, { timeMs: 61_100, chunk: outputChunk('y'.repeat(400)) })
  const liveB = store.liveSnapshot('s1', 61_100).tps
  store.settleAttempt(b, {
    settledAtMs: 61_150,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  assert.equal(liveA, 100)
  assert.equal(liveB, 100,
    'the live meter reset at the new attempt; B is not reading A\'s 100 on top of its own')
  const curve = store.endTurn(record, { timeMs: 62_000, status: 'completed' }).curve
  assert.deepEqual(curve.attempts.map(attempt => attempt.points[0].tps), [liveA, liveB],
    'and the completed curve reproduces both readings at their own openings')
  assert.equal(curve.peakTps, 100, 'never the 200 a bridged window would produce')
})
