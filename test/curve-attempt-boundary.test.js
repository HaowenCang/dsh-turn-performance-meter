/**
 * Cross-attempt measurement regression: an attempt is measured alone.
 *
 * The compressed curve clock joins attempts end-to-start so that a tool wait and the
 * next call's TTFT consume no horizontal width. That concatenation is a *coordinate*
 * operation on the x-axis only. The published rate is a *statistical* operation bound
 * to one model attempt: since Phase 9.2 it is the phase-cumulative average of the
 * episode in force — the mass of the current phase episode divided by the wall time
 * elapsed since that episode began — and an episode is the maximal run of consecutive
 * same-phase samples **within one attempt**. Since Phase 9.4 that average is also
 * subject to the shared publication policy (`src/core/rate-publication.js`): below
 * three contributing samples or below 100 ms of episode clock the vertex publishes
 * `tps: null` with a `rateUnavailableReason`, never a zero. The live meter has always
 * reset its episode at every new attempt (`src/core/live-metrics.js`); the completed
 * curve must agree.
 *
 * `cumulativePhaseTpsSeries` itself has no notion of an attempt, so one call across a
 * turn's concatenated samples bridges two model calls: the episode that opened in
 * attempt A never closes, and attempt B's vertices are measured against A's clock and
 * carry A's token mass. `settle()` avoids this by measuring one trace per attempt
 * (`attemptTraces`). `bridgedTpsAt` below keeps the defect as an executable
 * counterexample: a bridged measurement of the same evidence must disagree with every
 * published vertex it is compared to, and the published vertices must equal the
 * per-attempt computation.
 *
 * Every magnitude here is hand-computed from the raw shape weight — 0.25 per Latin
 * code point, so a 4000-character delta weighs 1000 — which keeps a failure a
 * statement about the estimator rather than about calibration.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { DEFAULT_SAMPLE_EVERY_MS, cumulativePhaseTpsSeries } from '../src/core/curve.js'
import { compressAttempts } from '../src/core/time-axis.js'

function outputChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

/** 4000 characters weigh exactly 1000 by `heuristicTokenWeight`. */
const HEAVY_DELTA = 'x'.repeat(4000)
/** 40 characters weigh exactly 10. */
const LIGHT_DELTA = 'y'.repeat(40)

/**
 * Two attempts, one tool between them, no retry and no error.
 *
 * Attempt A produces 3000 shape tokens in three deltas at its local 0, 100 and 150 ms and
 * settles at 150, so it owns the compressed span [0, 150]. A minute-long tool then runs.
 * Attempt B produces 30 shape tokens in three deltas at its local 0, 100 and 150 ms and
 * settles at 150, so it owns [150, 300] — the coordinate A closed on.
 *
 * Three deltas rather than two because a rate is only a measurement once the shared
 * publication policy admits it (`src/core/rate-publication.js`): an episode needs
 * `MIN_RATE_SAMPLES` (three) contributing samples **and** `MIN_RATE_ELAPSED_MS` (100 ms) of
 * its own clock. A two-delta attempt publishes nothing at all, which would make every
 * cross-attempt assertion below vacuous; with three deltas one sampling step apart the
 * attempt's closing vertex is its own three-sample episode measured over its own 150 ms.
 *
 * The two attempts differ by a factor of one hundred, so any vertex of B that
 * inherited A's mass would be unmistakable against B's own readings.
 */
function driveToolSeparatedTurn(store) {
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const a = store.beginAttempt(record, { attemptId: 'attempt-a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, a, { timeMs: 0, chunk: outputChunk(HEAVY_DELTA) })
  store.acceptChunk(record, a, { timeMs: 100, chunk: outputChunk(HEAVY_DELTA) })
  store.acceptChunk(record, a, { timeMs: 150, chunk: outputChunk(HEAVY_DELTA) })
  store.settleAttempt(a, {
    settledAtMs: 150,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    settlementSeq: 1,
  })

  store.toolStarted(record, { callId: 'tool-1', name: 'pwsh', timeMs: 200 })
  store.toolSettled(record, { callId: 'tool-1', timeMs: 60_200, status: 'ok' })

  const b = store.beginAttempt(record, { attemptId: 'attempt-b', step: 2, startedAtMs: 60_300 })
  store.acceptChunk(record, b, { timeMs: 60_300, chunk: outputChunk(LIGHT_DELTA) })
  store.acceptChunk(record, b, { timeMs: 60_400, chunk: outputChunk(LIGHT_DELTA) })
  store.acceptChunk(record, b, { timeMs: 60_450, chunk: outputChunk(LIGHT_DELTA) })
  store.settleAttempt(b, {
    settledAtMs: 60_450,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    settlementSeq: 2,
  })

  return { record, settled: store.endTurn(record, { timeMs: 60_500, status: 'completed' }) }
}

/** One attempt's trace, by id. */
function attemptOf(curve, id) {
  return curve.attempts.find(candidate => candidate.attemptId === id)
}

/**
 * The rejected measurement, kept as an executable counterexample: **one** series
 * across both attempts, evaluated at one compressed instant.
 *
 * `cumulativePhaseTpsSeries` has no notion of an attempt, so this is what a single
 * cross-attempt call reports at `t`: the episode that opened at A's first sample is
 * still in force, so B's instants are divided by A's elapsed clock and carry A's mass.
 * It is the defect the per-attempt partition removes.
 *
 * Evaluating at one instant is exact rather than an approximation: a vertex's value
 * depends only on the samples at or before `t`, so this is the number a full bridged
 * series publishes at that coordinate.
 */
function bridgedTpsAt(compressed, t) {
  const series = cumulativePhaseTpsSeries(compressed.samples, { fromMs: t, toMs: t, sampleEndMs: t })
  return series[0]?.tps ?? null
}

test('the tool-separated turn measures each attempt alone, and a bridged series disagrees', () => {
  const store = new TurnTelemetryStore()
  const { record, settled } = driveToolSeparatedTurn(store)
  const curve = settled.curve

  /**
   * The compressed clock is continuous: B opens on the coordinate A closed on, and the
   * 60 s tool wait and the next call's 100 ms TTFT own no width.
   */
  assert.equal(curve.durationMs, 150 + 150, 'the axis is the sum of the two attempt widths')
  assert.deepEqual(curve.segments.map(segment => [segment.attemptId, segment.startMs, segment.endMs]), [
    ['attempt-a', 0, 150],
    ['attempt-b', 150, 300],
  ], 'the two attempts abut: the gap between them has zero width')
  assert.equal(curve.sampleEveryMs, DEFAULT_SAMPLE_EVERY_MS)

  const traceA = attemptOf(curve, 'attempt-a')
  const traceB = attemptOf(curve, 'attempt-b')

  /**
   * Attempt A, hand-computed on its own clock. Its episode opens at its local zero
   * with the first 1000-token delta, and the policy withholds a rate until the
   * episode holds three samples and has run for 100 ms:
   *
   *     local   0: elapsed 0, 1 sample    -> the opening anchor, null
   *     local 100: elapsed 100, 2 samples -> below the three-sample warmup, null
   *     local 150: 3000 * 1000 / 150     = 20000
   */
  assert.equal(traceA.tokens, 3000, 'A reports only its own 3000 tokens')
  assert.deepEqual(traceA.points.map(point => [point.localMs, point.timeMs, point.tps]), [
    [0, 0, null],
    [100, 100, null],
    [150, 150, 20000],
  ], 'A\'s series is its own cumulative mass over its own episode clock')
  assert.deepEqual(traceA.points.slice(0, 2).map(point => point.rateUnavailableReason),
    ['opening-anchor', 'below-sample-warmup'],
    'and the two vertices it withholds name the fact that is missing, rather than reporting a zero')

  /**
   * Attempt B, hand-computed the same way. Its episode opens at its own local zero, so
   * its opening vertex is the anchor of B's clock — null — and not the 20067 a bridged
   * series reports at that coordinate (A's 3000 plus B's first 10, divided by A's 150 ms).
   */
  assert.equal(traceB.tokens, 30, 'B reports only its own 30 tokens')
  assert.deepEqual(traceB.points.map(point => [point.localMs, point.timeMs, point.tps]), [
    [0, 150, null],
    [100, 250, null],
    [150, 300, 200],
  ], 'B\'s series is its own cumulative mass over its own episode clock')

  assert.equal(traceA.points.at(-1).timeMs, 150, 'A ends where B begins')
  assert.equal(traceB.points[0].timeMs, 150, 'and B opens on that same coordinate')

  /**
   * The counterexample. No provider usage was reported, so `curveSource` passes the
   * stored attempts through and `compressAttempts` reproduces the exact sample list
   * the published traces were measured from — the bridged series differs from them in
   * the attempt partition alone, never in the evidence.
   *
   * One series across both attempts reports a different number at every coordinate it
   * shares with a published vertex, because the episode never restarts and the clock
   * never resets:
   *
   *     compressed 150: (3000 + 10) * 1000 / 150 = 20067   against B's own null
   *     compressed 250: (3000 + 20) * 1000 / 250 = 12080   against B's own null
   *     compressed 300: (3000 + 30) * 1000 / 300 = 10100   against B's own 200
   *     compressed 150:                            20067   against A's own 20000
   */
  const compressed = compressAttempts(record.attempts)
  assert.equal(compressed.durationMs, curve.durationMs)
  assert.equal(compressed.samples.length, 6)
  assert.equal(bridgedTpsAt(compressed, 150), 20067)
  assert.equal(bridgedTpsAt(compressed, 250), 12080)
  assert.equal(bridgedTpsAt(compressed, 300), 10100)

  assert.notEqual(traceB.points[0].tps, bridgedTpsAt(compressed, 150),
    'B\'s opening vertex is its own anchor, not A\'s mass over A\'s clock')
  assert.notEqual(traceB.points[1].tps, bridgedTpsAt(compressed, 250))
  assert.notEqual(traceB.points[2].tps, bridgedTpsAt(compressed, 300))
  assert.notEqual(traceA.points.at(-1).tps, bridgedTpsAt(compressed, 150),
    'and A\'s closing vertex never carries B\'s mass either')

  assert.equal(curve.peakTps, 20000, 'the turn peak is the max over the per-attempt traces')
})

test('a retry boundary resets the episode exactly as a tool gap does', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  /**
   * The abandoned attempt streams three 1000-token deltas one sampling step apart and
   * settles 100 ms later; its replacement is fifty times smaller. A retry is the signal
   * that the previous call ended, so it is the same hard boundary a tool gap is.
   */
  const abandoned = store.beginAttempt(record, { attemptId: 'retry-1', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, abandoned, { timeMs: 0, chunk: outputChunk(HEAVY_DELTA) })
  store.acceptChunk(record, abandoned, { timeMs: 50, chunk: outputChunk(HEAVY_DELTA) })
  store.acceptChunk(record, abandoned, { timeMs: 100, chunk: outputChunk(HEAVY_DELTA) })
  store.settleAttempt(abandoned, {
    settledAtMs: 100,
    settlementKind: 'attempt',
    surfaceCommitted: false,
    attemptOutcome: 'retried',
    settlementSeq: 1,
  })

  const retry = store.beginAttempt(record, { attemptId: 'retry-2', step: 1, startedAtMs: 100 })
  store.acceptChunk(record, retry, { timeMs: 100, chunk: outputChunk(LIGHT_DELTA) })
  store.acceptChunk(record, retry, { timeMs: 200, chunk: outputChunk(LIGHT_DELTA) })
  store.acceptChunk(record, retry, { timeMs: 250, chunk: outputChunk(LIGHT_DELTA) })
  store.settleAttempt(retry, {
    settledAtMs: 250,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    settlementSeq: 2,
  })

  const settled = store.endTurn(record, { timeMs: 300, status: 'completed' })
  const curve = settled.curve
  const first = attemptOf(curve, 'retry-1')
  const second = attemptOf(curve, 'retry-2')

  assert.equal(curve.durationMs, 100 + 150, 'the axis is the sum of the two attempt widths')
  assert.deepEqual(curve.segments.map(segment => [segment.attemptId, segment.startMs, segment.endMs]), [
    ['retry-1', 0, 100],
    ['retry-2', 100, 250],
  ], 'the retry opens on the coordinate the abandoned prefix closed on')

  /**
   * Three deltas one sampling step apart, so the abandoned attempt's own episode reaches
   * the three-sample warmup exactly on the vertex that means to measure it: 3000 tokens
   * over its own 100 ms is 30000, and its opening anchor is withheld rather than zero.
   */
  assert.deepEqual(first.points.map(point => [point.localMs, point.tps]), [[0, null], [100, 30000]],
    'the abandoned attempt keeps its own 3000 tokens over its own 100 ms')
  assert.deepEqual(second.points.map(point => [point.localMs, point.tps]),
    [[0, null], [100, null], [150, 200]],
    'the retry is its own trace: 30 tokens over its own clock, withheld until its third sample and its 100 ms')
  assert.equal(second.points[0].timeMs, 100)

  const compressed = compressAttempts(record.attempts)
  assert.equal(bridgedTpsAt(compressed, 50), null,
    'the bridged series at the retry boundary is still the abandoned attempt\'s own opening clock, so it is withheld too')
  assert.equal(bridgedTpsAt(compressed, 100), 30100,
    'one series across the retry boundary divides the abandoned mass plus the retry\'s first delta by the abandoned clock')
  assert.equal(bridgedTpsAt(compressed, 150), 20067)
  assert.equal(bridgedTpsAt(compressed, 200), 15100)
  assert.notEqual(second.points[0].tps, bridgedTpsAt(compressed, 100))
  assert.notEqual(second.points[1].tps, bridgedTpsAt(compressed, 150),
    'the retry\'s second vertex is its own withheld anchor, never the abandoned prefix\'s 20067')
  assert.notEqual(first.points.at(-1).tps, bridgedTpsAt(compressed, 100),
    'and the abandoned attempt\'s own closing vertex never carries the retry\'s mass')
  assert.equal(curve.peakTps, 30000, 'the abandoned attempt keeps its own peak')
})

test('no published vertex carries more than the owning attempt could support', () => {
  const store = new TurnTelemetryStore()
  const { record, settled } = driveToolSeparatedTurn(store)

  /**
   * An independent upper bound, derived from the estimator rather than from the
   * numbers above. Both attempts produce a single output episode that opens at their
   * local zero, so a vertex at local `t > 0` measures that episode's mass — at most
   * the attempt's whole token total — over `t` ms. The smallest positive `t` on an
   * attempt's grid is therefore the loosest bound every vertex of it must respect.
   */
  const ownTokens = { 'attempt-a': 3000, 'attempt-b': 30 }
  for (const attempt of settled.curve.attempts) {
    assert.equal(attempt.tokens, ownTokens[attempt.attemptId], `${attempt.attemptId} reports only its own total`)
    const positive = attempt.points.map(point => point.localMs).filter(value => value > 0)
    const bound = ownTokens[attempt.attemptId] * 1000 / Math.min(...positive)
    for (const point of attempt.points) {
      /**
       * A withheld vertex carries no rate at all, so the comparison is stated over the
       * published ones: `null <= bound` is a coercion, not a claim.
       */
      if (!point.publishable) continue
      assert.ok(point.tps <= bound + 1e-9,
        `${attempt.attemptId} vertex at local ${point.localMs} claims ${point.tps} tokens/s against a bound of ${bound}`)
    }
    /** And the bound is not vacuous here: the attempt really does publish a vertex. */
    assert.ok(attempt.points.some(point => point.publishable),
      `${attempt.attemptId} publishes no measurement at all, so its bound proves nothing`)
  }

  /**
   * The bridged series breaks the bound at every coordinate the two attempts share,
   * because the mass it divides is not the owning attempt's mass at all. B's smallest
   * positive elapsed is 100 ms, so no vertex of B's own trace can exceed 200 tokens/s;
   * the bridged series reports numbers in the five figures at B's own coordinates.
   */
  const compressed = compressAttempts(record.attempts)
  const boundB = ownTokens['attempt-b'] * 1000 / 100
  assert.equal(boundB, 300)
  for (const t of [150, 250, 300]) {
    assert.ok(bridgedTpsAt(compressed, t) > boundB,
      `the bridged vertex at ${t} (${bridgedTpsAt(compressed, t)}) exceeds what attempt B produced`)
  }
})
