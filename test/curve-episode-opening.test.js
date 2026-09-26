/**
 * Same-attempt, later-episode opening vertex.
 *
 * The independent Phase 7 audit found a second rolling-window defect that the
 * Phase 6 attempt-boundary fix did not cover. `rollingTpsSeries` carried this
 * lower bound:
 *
 *     const lowerExclusive = localMs <= fromMs
 *       ? Number.NEGATIVE_INFINITY
 *       : localMs - windowMs
 *
 * The special case was written for an attempt's *first* episode, where local zero
 * is the attempt's own opening delta and a half-open `(-windowMs, 0]` window has
 * nothing to measure — the reasoning was that reporting `0 tokens/s` on the vertex
 * carrying the call's first tokens would be a fabricated trough.
 *
 * Attempt-local zero is a **derived** coordinate, not an attempt-level one. An
 * attempt whose phase falls silent for longer than one window produces two
 * episodes, and the second episode's opening vertex sits at `localMs == fromMs`
 * again — for the episode, not for the attempt. The condition cannot tell the two
 * apart, so it reopened the window to negative infinity at an instant where the
 * frozen trailing definition `(t - windowMs, t]` has already evicted everything
 * older than `t - windowMs`.
 *
 * The consequence is a measured value no definition produces. An output delta at
 * attempt-local 0 ms and another at 3000 ms, one window of 1000 ms, is two episodes
 * `0 -> 1000` and `3000 -> 4000`. At the second episode's opening instant
 * `t = 3000` the window is `(2000, 3000]`, which contains the 3000 ms delta and
 * nothing else, so the rate is 100 tokens/s. The shipped code reported 200, having
 * resurrected a sample from three windows earlier because that vertex happened to
 * be an episode opening.
 *
 * Both episodes of this fixture belong to **one attempt**, so nothing here is an
 * attempt-boundary effect: the per-attempt partitioning Phase 6 introduced is
 * correct and orthogonal, and it is what the rest of this file holds fixed while
 * the window definition is corrected.
 *
 * Counterexample shape, frozen:
 *
 *     sample  attemptTimeMs = 0     weight = 100   -> 100 tokens/s
 *     sample  attemptTimeMs = 3000  weight = 100   -> one window (2000, 3000]
 *     windowMs = 1000                              -> second opening = 100, not 200
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
 * 400 characters is 100 estimated tokens, so each sample weighs exactly 100 and
 * every expected rate below is a whole multiple of 100.
 */
function driveTwoEpisodeAttempt(store, { secondSampleMs = 3000 } = {}) {
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
  return { record, curve, runs: curve.series.find(series => series.key === 'output').runs }
}

test('a later episode opening measures only its own trailing window', () => {
  const store = new TurnTelemetryStore()
  const { runs } = driveTwoEpisodeAttempt(store)

  assert.equal(runs.length, 2, 'a three-window silence splits one attempt into two episodes')
  assert.equal(runs[0].attemptId, runs[1].attemptId,
    'both episodes belong to the same attempt: this is not an attempt-boundary effect')
  assert.deepEqual(runs.map(run => [run.startMs, run.endMs]), [[0, 1000], [3000, 4000]])

  /**
   * The decisive assertion. The second episode opens at local 3000, so its window
   * is `(2000, 3000]`. The only sample inside it is the 3000 ms delta: 100 tokens
   * over 1000 ms is 100 tokens/s.
   */
  assert.equal(runs[1].points[0].localMs, 3000, 'the second episode opens at its own first sample')
  assert.equal(runs[1].points[0].tps, 100,
    `expected second episode opening TPS = 100, actual = ${runs[1].points[0].tps}`)

  assert.deepEqual(runs[1].points.map(p => p.tps), [100, 100, 100, 100, 0],
    'the second episode measures its own delta for one window and then expires')
})

test('the first episode opening still includes the attempt\'s own first sample', () => {
  const store = new TurnTelemetryStore()
  const { runs } = driveTwoEpisodeAttempt(store)

  /**
   * The behaviour the removed special case was written to protect, and which the
   * unified bound preserves for free: `localMs - windowMs` at local zero is
   * `-1000`, and a sample at zero lies inside `(-1000, 0]`. No negative-infinity
   * clamp is needed to include the opening delta, which is why removing it costs
   * nothing.
   */
  assert.equal(runs[0].points[0].localMs, 0)
  assert.equal(runs[0].points[0].tps, 100,
    'attempt local zero under a shifted bound still reports its opening delta')
  assert.deepEqual(runs[0].points.map(p => p.tps), [100, 100, 100, 100, 0])
  assert.equal(DEFAULT_WINDOW_MS, 1000)
  assert.equal(DEFAULT_SAMPLE_EVERY_MS, 250)
})

test('the episode split boundary is gap > window, and the eviction at the edge is half-open', () => {
  /**
   * `phaseRuns` rule 3: two same-phase episodes of one attempt merge when the
   * second begins at or before the first one's tail, because the window between
   * them never reached zero. A gap of exactly one window is therefore **one**
   * episode, not two — and inside that single episode no vertex is an episode
   * opening, so the special case never applies and the series must stay
   * continuous.
   */
  const oneWindow = driveTwoEpisodeAttempt(new TurnTelemetryStore(), { secondSampleMs: 1000 })
  assert.equal(oneWindow.runs.length, 1,
    'a gap of exactly one window leaves no absent stretch to preserve')
  /**
   * The merged episode reads 100 at every vertex, and that is not a defect: at
   * `t = 1000` the window is `(0, 1000]`, so the sample at zero expires at exactly
   * the instant the sample at 1000 arrives. Continuity here comes from the samples
   * abutting, not from either one being held beyond its window — which is why the
   * series never reaches 200. A value of 200 anywhere in this episode would require
   * the sample at zero to be measured one window late, the very defect Phase 7
   * corrected; this assertion is the seed-and-leak regression for the merged case.
   */
  assert.deepEqual(oneWindow.runs[0].points.map(p => p.tps), [100, 100, 100, 100, 100, 100, 100, 100, 0],
    'the merged episode is continuous through abutting samples, with no fabricated zero and no double count')

  /** One millisecond more and the window really did reach zero in between. */
  const pastWindow = driveTwoEpisodeAttempt(new TurnTelemetryStore(), { secondSampleMs: 1001 })
  assert.equal(pastWindow.runs.length, 2, 'gap = window + 1 is a genuine split')
  assert.equal(pastWindow.runs[1].points[0].localMs, 1001)
  /**
   * `(1, 1001]` excludes the sample at 0 — half-open on the left, as the live
   * meter's `SlidingWindowMeter` implements and `docs/METRICS_SPEC.md` §8.1
   * specifies.
   */
  assert.equal(pastWindow.runs[1].points[0].tps, 100,
    `gap = window + 1 must open on its own sample alone; got ${pastWindow.runs[1].points[0].tps}`)
})

test('the correction does not depend on the silence length, only on the window', () => {
  /**
   * Every gap below is longer than one window, so each opens a new episode at its
   * own first sample and each must read 100. The list is deliberately ragged
   * rather than generated, so a future refactor cannot satisfy it by construction.
   */
  for (const secondSampleMs of [1001, 1002, 1125, 1250, 1750, 2000, 3500, 8000]) {
    const { runs } = driveTwoEpisodeAttempt(new TurnTelemetryStore(), { secondSampleMs })
    assert.equal(runs.length, 2, `a ${secondSampleMs} ms gap is two episodes`)
    const opening = runs[1].points[0]
    assert.equal(opening.localMs, secondSampleMs,
      `a ${secondSampleMs} ms gap still opens the second episode at its first sample`)
    assert.equal(opening.tps, 100,
      `a ${secondSampleMs} ms gap must not resurrect the sample at 0; got ${opening.tps}`)
    /**
     * Independent upper bound: this attempt produced 100 tokens per episode, so
     * within one window no vertex can exceed 100 tokens/s. A resurrected sample
     * from an earlier episode is the only way to exceed it, which makes this
     * assertion a statement about the window rather than about a constant.
     */
    for (const run of runs) {
      for (const point of run.points) {
        assert.ok(point.tps <= 100 + 1e-9,
          `${secondSampleMs} ms gap: vertex ${point.timeMs} claims ${point.tps} tokens/s from one 100-token episode`)
      }
    }
  }
})

/**
 * Live-vs-completed equivalence for a **later episode of one attempt**.
 *
 * Phase 6 verified this across an attempt boundary, where the live meter's
 * `attemptStarted` reset and the completed curve's per-attempt partition are two
 * independent implementations of the same rule. The Phase 7 defect was not a boundary
 * effect at all: it lived inside one attempt, on the second episode's opening vertex.
 * The equivalence therefore has to be asserted there too, and it is the sharpest
 * available check, because the live meter never had the defect — its
 * `SlidingWindowMeter` rolls an unconditional `(t - windowMs, t]` and has no notion of
 * an episode — so the two implementations disagree exactly where the completed curve
 * went wrong.
 *
 * The fixture is the audit's own: output deltas at attempt-local 0 ms and 3000 ms, one
 * window of 1000 ms. The live meter is read at every 250 ms grid instant during the
 * attempt, with each chunk accepted before it is read, and every reading is then matched
 * against the completed curve's vertex at the same attempt-local instant.
 */
test('a later same-attempt episode: the completed curve equals what the live meter read', () => {
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
  const runs = curve.series.find(series => series.key === 'output').runs
  assert.equal(runs.length, 2, 'the silence splits the attempt into two episodes')

  /** The live reading at the second episode's opening, which is the disputed instant. */
  const liveAtOpening = live.find(point => point.localMs === 3000)
  assert.equal(liveAtOpening.tps, 100,
    'the live meter measures the trailing window and reports 100 at 3000 ms')

  /**
   * The decisive comparison. Every live reading must equal the completed curve's vertex at
   * the same attempt-local instant. `completed = 200, live = 100` is the defect this test
   * exists to make impossible; an instant the curve does not sample is skipped, because the
   * two grids are asserted equal elsewhere.
   */
  let compared = 0
  for (const reading of live) {
    if (!Number.isFinite(reading.tps)) continue
    const point = runs
      .flatMap(run => run.points)
      .find(candidate => candidate.localMs === reading.localMs)
    if (point === undefined) continue
    compared += 1
    assert.equal(point.tps, reading.tps,
      `attempt-local ${reading.localMs}: the live meter said ${reading.tps}, the completed curve says ${point.tps}`)
  }
  assert.ok(compared >= 9, `the comparison covered ${compared} instants`)

  /** The two instants that pin the fixture, restated as explicit values. */
  assert.equal(live.find(point => point.localMs === 1000).tps, 0,
    'the live meter expires the opening delta one window after it arrived')
  assert.deepEqual(runs[1].points.map(p => p.tps), [100, 100, 100, 100, 0])
  assert.equal(curve.peakTps, 100,
    'no window ever holds both deltas, so the completed peak is one delta, not two')
  assert.equal(runs[1].peak, 100, 'and the second run reports the same reading the live meter did')
})

test('a new attempt still resets the live window and the completed curve together', () => {
  /**
   * The Phase 6 result, re-asserted because the correction above changed the window
   * definition both paths share: the reset must survive it. Attempt B streams the same shape
   * as attempt A, so a bridged window would make its opening reading larger than A's — the one
   * outcome both implementations must refuse.
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
  const runs = curve.series.find(series => series.key === 'output').runs
  assert.deepEqual(runs.map(run => run.points[0].tps), [liveA, liveB],
    'and the completed curve reproduces both readings at their own openings')
  assert.equal(curve.peakTps, 100, 'never the 200 a bridged window would produce')
})
