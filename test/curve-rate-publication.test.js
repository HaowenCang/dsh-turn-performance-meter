/**
 * Phase 9.4 — a throughput measurement is published only when it is measured.
 *
 * ## The defect this file freezes
 *
 * The phase-cumulative estimator is
 *
 *     tps(t) = mass(samples of the current episode at or before t) * 1000
 *              / (t - firstSampleOfThatEpisode)
 *
 * and the vertex grid used to be the **attempt's own** 100 ms ladder. A phase
 * episode that opens between two ladder instants (250 ms is not a multiple of
 * 100) therefore acquired a first vertex whose denominator was the remainder of
 * the ladder step: 50 ms at 300 ms, and — for an episode opening at 299 ms — a
 * denominator of **1 ms**. `peakTps` is the maximum of every published vertex, so
 * that quotient was promoted to the turn's peak.
 *
 * Measured on the v0.1.2 baseline, with calibrated magnitudes:
 *
 *     episode at 250 ms, vertex 300 ms  ->  100 tokens / 50 ms  =  2 000
 *     episode at 299 ms, vertex 300 ms  ->  200 tokens /  1 ms  = 200 000
 *     calibrated fixture below          ->  peak 15 009 at a 50 ms denominator
 *
 * ## The contract that replaces it
 *
 * `src/core/rate-publication.js` is the **one** publication policy, shared by
 * the live meter and the completed curve:
 *
 *     publishable  <=>  episode sample count >= MIN_RATE_SAMPLES (3)
 *                  AND  elapsed since the episode opened >= MIN_RATE_ELAPSED_MS (100)
 *
 * The completed curve now samples each phase episode on **its own** ladder
 * (`episodeStart, episodeStart + 100, …`), so a sub-100 ms denominator is not
 * merely withheld: it no longer exists as a vertex. A vertex that is not
 * publishable carries `tps: null` — never a fabricated `0`, because "not
 * measured yet" and "measured zero" are different facts.
 *
 * `peakTps` is the maximum of the **publishable** points, `null` when there are
 * none, and the UI prints `—` for it. Nothing here clamps, smooths or winsorizes
 * a value: no EMA, no moving average, no hard ceiling. The spike is removed
 * because the denominator that produced it is no longer eligible, not because a
 * large number was suppressed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import {
  MIN_RATE_ELAPSED_MS,
  MIN_RATE_SAMPLES,
  RateUnavailable,
  rateAvailability,
  rateIsPublishable,
} from '../src/core/rate-publication.js'
import { MIN_WARMUP_SAMPLES, LiveMeter, LivePhase } from '../src/core/live-metrics.js'
import { cumulativePhaseTpsSeries, peakTps } from '../src/core/curve.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { DASH } from '../src/client/format.js'

const reasoningChunk = text => ({ type: 'reasoning-delta', index: 0, text })
const outputChunk = text => ({ type: 'text-delta', index: 0, text })

/** Every publishable vertex obeys the shared gate, and no other vertex has a rate. */
function assertPublicationContract(points) {
  for (const point of points) {
    const publishable = Number.isFinite(point.tps)
    if (publishable) {
      assert.ok(point.episodeElapsedMs >= MIN_RATE_ELAPSED_MS,
        `a rate at ${point.localMs} ms came from a ${point.episodeElapsedMs} ms episode denominator`)
      assert.ok(point.episodeSampleCount >= MIN_RATE_SAMPLES,
        `a rate at ${point.localMs} ms came from ${point.episodeSampleCount} samples`)
      assert.equal(point.publishable, true)
      assert.equal(point.rateUnavailableReason, null)
    } else {
      assert.equal(point.tps, null, 'an unavailable vertex is null, never a measured zero')
      assert.equal(point.publishable, false)
      assert.ok(Object.values(RateUnavailable).includes(point.rateUnavailableReason),
        `a withheld vertex states why: ${point.rateUnavailableReason}`)
    }
  }
}

test('the publication policy is one named contract shared by live and curve', () => {
  assert.equal(MIN_RATE_SAMPLES, 3)
  assert.equal(MIN_RATE_ELAPSED_MS, 100)
  assert.equal(MIN_WARMUP_SAMPLES, MIN_RATE_SAMPLES,
    'the live warm-up count is the shared sample gate, not a second constant')

  assert.equal(rateIsPublishable({ sampleCount: 3, elapsedMs: 100 }), true)
  assert.equal(rateIsPublishable({ sampleCount: 3, elapsedMs: 99 }), false)
  assert.equal(rateIsPublishable({ sampleCount: 2, elapsedMs: 100 }), false)
  assert.equal(rateIsPublishable({ sampleCount: 0, elapsedMs: 0 }), false)

  assert.deepEqual(rateAvailability({ sampleCount: 0, elapsedMs: null }),
    { publishable: false, reason: RateUnavailable.NO_EPISODE })
  assert.deepEqual(rateAvailability({ sampleCount: 1, elapsedMs: 0 }),
    { publishable: false, reason: RateUnavailable.OPENING_ANCHOR })
  assert.deepEqual(rateAvailability({ sampleCount: 3, elapsedMs: 50 }),
    { publishable: false, reason: RateUnavailable.BELOW_ELAPSED_HORIZON })
  assert.deepEqual(rateAvailability({ sampleCount: 2, elapsedMs: 500 }),
    { publishable: false, reason: RateUnavailable.BELOW_SAMPLE_WARMUP })
  assert.deepEqual(rateAvailability({ sampleCount: 3, elapsedMs: 500 }),
    { publishable: true, reason: null })
})

test('the live meter withholds a rate below the elapsed horizon', () => {
  const meter = new LiveMeter()
  meter.turnStarted({ turn: 1, timeMs: 0 })
  meter.attemptStarted({ attemptId: 'a', step: 1, timeMs: 0 })
  for (const at of [0, 10, 20]) {
    meter.acceptSample({ timeMs: at, phase: 'output', tokens: 100 })
  }
  assert.equal(meter.episodeSampleCount, 3, 'the sample gate alone is satisfied')
  assert.equal(meter.snapshot(50).tps, null, 'but 50 ms of episode clock is not a measurement')
  assert.equal(meter.snapshot(50).tpsQuality, 'unavailable')
  assert.equal(meter.snapshot(50).rateGateReason, RateUnavailable.BELOW_ELAPSED_HORIZON)
  assert.equal(meter.snapshot(99).tps, null)

  const at100 = meter.snapshot(100)
  assert.equal(at100.tps, Math.round(300 * 1000 / 100), 'at exactly the horizon the rate publishes')
  assert.equal(at100.tps, 3000)
  assert.equal(at100.rateGateReason, null)
})

test('an episode opening between grid instants publishes no sub-100 ms rate', () => {
  /**
   * The reasoning episode opens at 0; the output episode opens at 250 ms with
   * three samples. On the baseline the attempt-global grid put a vertex at
   * 300 ms whose denominator was `300 - 250 = 50 ms`, and its 200 tokens were
   * published as 4 000 tokens/s — the turn's peak.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 250, phase: 'output', tokens: 100 },
    { activeTimeMs: 300, phase: 'output', tokens: 100 },
    { activeTimeMs: 350, phase: 'output', tokens: 100 },
  ], { durationMs: 400, sampleEndMs: 400 })

  assertPublicationContract(points)
  assert.equal(points.find(point => point.localMs === 300)?.tps ?? null, null,
    'the 50 ms denominator is never published as a rate')

  const rates = points.filter(point => Number.isFinite(point.tps))
  assert.deepEqual(rates.map(point => point.localMs), [350, 400],
    'the output episode is sampled on its own ladder: 250 (anchor), 350, and the attempt end')
  assert.equal(rates[0].episodeElapsedMs, 100, 'the first valid rate has a full 100 ms denominator')
  assert.equal(rates[0].episodeSampleCount, 3)
  assert.equal(rates[0].tps, 3000, '300 tokens over its own 100 ms')
  assert.equal(peakTps(points), 3000, 'against 4 000 on the baseline, from a 50 ms denominator')
})

test('a one-millisecond denominator is never published', () => {
  /**
   * The extreme form of the same defect: an episode opening at 299 ms sat one
   * millisecond below the baseline's 300 ms grid point, and the two samples that
   * had arrived by then were divided by that single millisecond — 200 000
   * tokens/s, promoted to `peakTps`.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 299, phase: 'output', tokens: 100 },
    { activeTimeMs: 300, phase: 'output', tokens: 100 },
    { activeTimeMs: 301, phase: 'output', tokens: 100 },
  ], { durationMs: 400, sampleEndMs: 400 })

  assertPublicationContract(points)
  const rates = points.filter(point => Number.isFinite(point.tps))
  assert.deepEqual(rates.map(point => [point.localMs, point.episodeElapsedMs]), [[399, 100], [400, 101]])
  assert.equal(peakTps(points), 3000, 'against 200 000 on the baseline')
  for (const point of points) {
    if (!Number.isFinite(point.tps)) continue
    assert.ok(point.localMs - point.episodeStartMs >= MIN_RATE_ELAPSED_MS)
  }
})

test('an episode needs three contributing samples before any rate is published', () => {
  const twoSamples = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 900, phase: 'output', tokens: 100 },
  ], { durationMs: 1000, sampleEndMs: 1000 })
  assertPublicationContract(twoSamples)
  assert.deepEqual(twoSamples.filter(point => Number.isFinite(point.tps)), [],
    '900 ms of elapsed time cannot make two samples a rate')
  assert.equal(peakTps(twoSamples), null)

  const threeSamples = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 900, phase: 'output', tokens: 100 },
    { activeTimeMs: 950, phase: 'output', tokens: 100 },
  ], { durationMs: 1000, sampleEndMs: 1000 })
  const rates = threeSamples.filter(point => Number.isFinite(point.tps))
  assert.deepEqual(rates.map(point => [point.localMs, point.episodeElapsedMs, point.episodeSampleCount]), [
    [1000, 1000, 3],
  ], 'the third sample admits the episode at the next vertex of that episode\'s own ladder')
  assert.equal(rates[0].tps, 300, '300 tokens over the episode\'s whole second')
  for (const point of threeSamples.filter(candidate => !Number.isFinite(candidate.tps))) {
    assert.equal(point.rateUnavailableReason,
      point.localMs === 0 ? RateUnavailable.OPENING_ANCHOR : RateUnavailable.BELOW_SAMPLE_WARMUP)
  }
})

test('peakTps is the maximum of publishable points and is null when there are none', () => {
  const none = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 400 },
  ], { durationMs: 0, sampleEndMs: 0 })
  assert.equal(peakTps(none), null, 'a single delta is not a rate, so it is not a peak')
  assert.equal(peakTps(...[[], []]), null)
  assert.equal(peakTps([{ tps: 10 }, { tps: null }, { tps: 400 }]), 400)
  assert.equal(peakTps([{ tps: 10 }], [{ tps: null }]), 10)
})

test('a turn whose only episode is below the gates reports no peak and draws an em dash', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's94', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 100, chunk: outputChunk('x'.repeat(400)) })
  store.settleAttempt(attempt, {
    settledAtMs: 120,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  const settled = store.endTurn(record, { timeMs: 200, status: 'completed' })

  assert.equal(settled.curve.peakTps, null, 'no publishable point exists, so there is no peak')
  const view = curveViewModel(settled)
  assert.equal(view.peak.display, DASH, 'the card prints — rather than a fabricated number')
  assert.equal(view.peak.value, 0)
  assert.equal(view.series.every(entry => entry.peak === null), true)
})

test('the calibrated spike is removed without moving the token integral or the summary rates', () => {
  /**
   * A realistic total-anchored attempt: the provider total is 3 000 output
   * tokens, the reasoning/output split is not reported, three reasoning deltas
   * open an episode at 0 and four output deltas open one at 250 ms — off the
   * attempt grid. The final phase average is an ordinary number.
   *
   * Baseline (v0.1.2), measured:
   *   peakTps 15 009 at local 300 ms, i.e. 751 tokens / 50 ms
   *   points  [0,0] [100,14972] [200,11229] [300,15009] [400,5028] [500,3017]
   *   summary outputTps 3016.8434185901447, reasoningTps 8983.156581409856
   *   generatedTokens 3000, temporalShapeQuality estimated
   *
   * The gates change the vertex set, not the arithmetic: every magnitude below
   * is still the one `calibrateAttemptSamples` produced.
   */
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's94b', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  for (const at of [0, 100, 200]) {
    store.acceptChunk(record, attempt, { timeMs: at, chunk: reasoningChunk('x'.repeat(400)) })
  }
  store.acceptChunk(record, attempt, { timeMs: 250, chunk: outputChunk('x'.repeat(400)) })
  for (const at of [300, 350, 400]) {
    store.acceptChunk(record, attempt, { timeMs: at, chunk: outputChunk('x') })
  }
  store.settleAttempt(attempt, {
    settledAtMs: 500,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 3000, reasoningTokens: null },
  })
  const settled = store.endTurn(record, { timeMs: 560, status: 'completed' })
  const curve = settled.curve
  const trace = curve.attempts[0]

  /** The magnitudes are untouched: the integral is the provider's own total. */
  const integral = trace.samples.reduce((sum, sample) => sum + sample.tokens, 0)
  assert.ok(Math.abs(integral - 3000) < 1e-9, `the calibrated integral is 3000, got ${integral}`)
  assert.equal(trace.calibratedTokens !== null, true)
  assert.equal(settled.generatedTokens, 3000)

  /** The published summary rates are the baseline's own numbers, to the digit. */
  assert.equal(settled.outputTps, 3016.8434185901447)
  assert.equal(settled.reasoningTps, 8983.156581409856)
  assert.deepEqual(curve.qualityAxes, {
    tokenTotalQuality: 'exact',
    phaseSplitQuality: 'estimated',
    temporalShapeQuality: 'estimated',
  })

  /** And no sub-100 ms denominator survives, so the 50 ms spike is gone. */
  assertPublicationContract(trace.points)
  const rates = trace.points.filter(point => Number.isFinite(point.tps))
  assert.deepEqual(rates.map(point => [point.localMs, point.episodeElapsedMs, point.episodeSampleCount]), [
    [200, 200, 3],
    [350, 100, 3],
    [450, 200, 4],
    [500, 250, 4],
  ])
  assert.equal(curve.peakTps, 11229, 'against 15 009 on the baseline')
  assert.equal(rates.every(point => point.tps <= curve.peakTps), true)
  assert.equal(curve.peakTps, Math.max(...rates.map(point => point.tps)))
  assert.ok(curve.peakTps < 15009 * 0.8, 'the early-episode amplification is gone, not clamped')
  assert.ok(curve.peakTps / settled.outputTps < 10, 'no order-of-magnitude outlier remains')
})

test('the winning peak publishes debug-only provenance', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's94c', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  for (const at of [0, 100, 200]) {
    store.acceptChunk(record, attempt, { timeMs: at, chunk: reasoningChunk('x'.repeat(400)) })
  }
  store.acceptChunk(record, attempt, { timeMs: 250, chunk: outputChunk('x'.repeat(400)) })
  for (const at of [300, 350, 400]) {
    store.acceptChunk(record, attempt, { timeMs: at, chunk: outputChunk('x') })
  }
  store.settleAttempt(attempt, {
    settledAtMs: 500,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 3000, reasoningTokens: null },
  })
  const settled = store.endTurn(record, { timeMs: 560, status: 'completed' })
  const curve = settled.curve
  const provenance = curve.peakProvenance

  assert.ok(provenance !== null && typeof provenance === 'object', 'the peak carries its provenance')
  assert.deepEqual(Object.keys(provenance).sort(), [
    'attemptId',
    'calibrated',
    'contributingSampleTimes',
    'elapsedMs',
    'episodeMass',
    'episodeSampleCount',
    'episodeStartMs',
    'phase',
    'pointTimeMs',
    'sampleQuality',
    'temporalAllocationMode',
    'tps',
  ].sort())
  assert.equal(provenance.attemptId, 'a')
  assert.equal(provenance.tps, curve.peakTps)
  assert.equal(provenance.phase, 'reasoning')
  assert.ok(provenance.elapsedMs >= MIN_RATE_ELAPSED_MS)
  assert.ok(provenance.episodeSampleCount >= MIN_RATE_SAMPLES)
  assert.ok(provenance.episodeMass > 0)
  assert.equal(provenance.temporalAllocationMode, 'total-anchored')
  assert.equal(provenance.calibrated, true)
  assert.equal(provenance.sampleQuality, 'calibrated')
  assert.equal(provenance.contributingSampleTimes.length, provenance.episodeSampleCount)
  assert.deepEqual([...provenance.contributingSampleTimes].sort((a, b) => a - b), provenance.contributingSampleTimes)

  /** The attempt trace publishes its own provenance for the same winning point. */
  const trace = curve.attempts[0]
  assert.equal(trace.peakProvenance.tps, curve.peakTps)
  assert.equal(trace.peakProvenance.attemptId, 'a')

  /** The winning point exists, is publishable, and is the one the card prints. */
  const winner = trace.points.find(point => point.localMs === provenance.pointTimeMs - trace.startMs)
  assert.ok(winner !== undefined)
  assert.equal(winner.tps, curve.peakTps)
  assert.equal(winner.episodeStartMs, provenance.episodeStartMs)

  /** Diagnostics only: the rendered view model must not carry it. */
  const view = curveViewModel(settled)
  assert.equal('peakProvenance' in view, false, 'provenance never reaches the UI model')
  assert.equal(view.peak.value, curve.peakTps)
  assert.equal(JSON.stringify(view).includes('contributingSampleTimes'), false)
})

test('a phase-local ladder still decays across a silence and resets at a transition', () => {
  /**
   * The two behaviours the estimator exists for are unchanged by the gate: a
   * silence inside an episode still decays hyperbolically (the numerator freezes
   * while the denominator advances), and a phase transition still restarts both
   * the mass and the clock.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 900 },
    { activeTimeMs: 100, phase: 'output', tokens: 300 },
    { activeTimeMs: 200, phase: 'output', tokens: 300 },
    { activeTimeMs: 400, phase: 'reasoning', tokens: 300 },
    { activeTimeMs: 500, phase: 'reasoning', tokens: 300 },
    { activeTimeMs: 600, phase: 'reasoning', tokens: 300 },
  ], { durationMs: 800, sampleEndMs: 800 })

  assertPublicationContract(points)
  const rateAt = at => points.find(point => point.localMs === at).tps
  assert.equal(rateAt(100), null, 'two samples are still below the warm-up gate')
  assert.equal(rateAt(200), 7500, '1500 tokens over the episode\'s own 200 ms')
  assert.equal(rateAt(300), 5000, 'a silence decays: the numerator freezes, the clock advances')
  assert.equal(rateAt(400), null, 'the reasoning episode starts its own clock and mass at 400')
  assert.equal(rateAt(600), 4500, '900 reasoning tokens over 200 ms, never the earlier episode\'s mass')
  assert.equal(rateAt(800), 2250, 'and it keeps decaying to the attempt end')
})

test('a component that ignores the availability flag cannot read a rate where none was measured', () => {
  /**
   * The published series is the only surface a renderer reads. Every vertex below
   * the gates is `null`, so a naive `point.tps` consumer draws a gap rather than
   * a fabricated zero — the failure mode `tps: 0` would have produced.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 250, phase: 'output', tokens: 100 },
    { activeTimeMs: 300, phase: 'output', tokens: 100 },
    { activeTimeMs: 350, phase: 'output', tokens: 100 },
  ], { durationMs: 400, sampleEndMs: 400 })
  for (const point of points) {
    if (point.localMs <= 250) assert.equal(point.tps, null, `vertex ${point.localMs} is not a measurement`)
  }
  assert.equal(points.some(point => point.tps === 0), false, 'no withheld vertex is published as zero')

  /** The live meter agrees: an episode below the horizon publishes nothing either. */
  const meter = new LiveMeter()
  meter.turnStarted({ turn: 1, timeMs: 0 })
  meter.attemptStarted({ attemptId: 'a', step: 1, timeMs: 0 })
  for (const at of [0, 50, 100]) {
    meter.acceptSample({ timeMs: at, phase: 'output', tokens: 100 })
  }
  for (const at of [250, 260, 270]) {
    meter.acceptSample({ timeMs: at, phase: 'reasoning', tokens: 100 })
  }
  assert.equal(meter.phase, LivePhase.STREAMING)
  assert.equal(meter.activePhase(), 'reasoning')
  assert.equal(meter.snapshot(320).tps, null, '320 ms is 70 ms into the reasoning episode: warming')
  assert.equal(meter.snapshot(400).tps, Math.round(300 * 1000 / (400 - 250)))
  assert.equal(meter.snapshot(400).tps, 2000)
})
