/**
 * The completed curve must be measured in the **calibrated** magnitude system.
 *
 * ## The defect this file was written against
 *
 * Two magnitude systems exist in this project and they are not interchangeable:
 *
 *   - the raw **shape weight** `sampleFromChunk` assigns to every streamed delta
 *     (`heuristicTokenWeight`: 0.25 per Latin code point, 1 per CJK one). It is a
 *     coarse prior whose only job is to describe *where* tokens went;
 *   - the **provider-calibrated** per-delta allocation
 *     `calibrateAttemptSamples` produces once authoritative usage is known, whose
 *     integral over an attempt equals that attempt's `outputTokens` exactly.
 *
 * The aggregate metrics (`generatedTokens`, `phaseTokens`, `reasoningTps`,
 * `outputTps`) are built from the second. The completed curve was built from the
 * first, because `settle()` called `compressAttempts(record.attempts)` — the raw
 * evidence — while `aggregateTurn` calibrated a *copy* of the same samples into
 * `attemptBreakdown[].calibration.samples`. A single card therefore printed
 * `Generated Tokens: 900` beside a curve whose total area was 300, and the `≈`
 * peak was read off the smaller of the two systems.
 *
 * The example below is the smallest fixture the corrected publication policy can
 * express: **three** deltas of 400 Latin characters each — two of them 100 ms apart
 * and the third half a second after the first — on the phase-cumulative statistic of
 * `docs/METRICS_SPEC.md` §8.2. A rate needs three contributing samples *and* 100 ms
 * of the episode's own clock (`src/core/rate-publication.js`), so a two-delta episode
 * publishes no rate at all however long it runs; the fixture is enriched rather than
 * the property dropped, and the magnitudes themselves are untouched by that gate.
 *
 *   raw shape sum         = 300        (3 x 400 x 0.25)
 *   provider outputTokens = 900
 *   calibrated samples    = 300, 300, 300   (one common scale of 3)
 *   curve at local 500    = 1800 tokens/s   <- expected (900 tokens / the episode's 0.5 s)
 *   curve at local 500    = 600 tokens/s    <- the raw shape weight's answer
 *
 * ## What is frozen here
 *
 * The raw samples remain the provenance and are never mutated: calibration
 * produces an ephemeral curve input, and `attemptBreakdown[].calibration.samples`
 * is the single place the rescaling happens. `test/curve-source.test.js` holds the
 * alignment contract between the two lists; this file holds the magnitudes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'
import { DEFAULT_SAMPLE_EVERY_MS, MAX_SERIES_POINTS, peakTps } from '../src/core/curve.js'
import { MIN_RATE_ELAPSED_MS, MIN_RATE_SAMPLES } from '../src/core/rate-publication.js'

/**
 * The trailing window the rejected pipeline of the Phase 7B reproduction measured
 * over. It is frozen here as a local constant because the reproduction is of a
 * superseded statistic: no module exports it any more (Phase 9.2).
 */
const LEGACY_WINDOW_MS = 1000
/** 400 Latin characters, asserted rather than assumed by `outputChunk`. */
const DELTA_CHARACTERS = 400
const RAW_DELTA_WEIGHT = 100

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })

/** One text delta weighing exactly `RAW_DELTA_WEIGHT` raw shape units. */
function outputChunk() {
  const text = 'x'.repeat(DELTA_CHARACTERS)
  assert.equal(heuristicTokenWeight(text), RAW_DELTA_WEIGHT,
    `the generator assumes ${DELTA_CHARACTERS} characters weigh ${RAW_DELTA_WEIGHT}`)
  return output(text)
}

/**
 * One attempt, three output deltas — the first two 100 ms apart and the third half a
 * second after the first — settled with authoritative usage.
 *
 * Three deltas are the smallest episode that can publish a rate at all: the shared
 * publication policy requires `MIN_RATE_SAMPLES` contributing samples as well as
 * `MIN_RATE_ELAPSED_MS` of the episode's own clock (`src/core/rate-publication.js`),
 * so a two-delta fixture can no longer express the magnitudes this file freezes.
 *
 * The attempt-local instants the curve is measured at are 0, 100, …, 500 and then the
 * settlement at 550, because attempt-local zero *is* the first delta: they are the
 * single episode's own ladder.
 */
function driveThreeDeltaTurn({ outputTokens, reasoningTokens = undefined } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: outputChunk() })
  store.acceptChunk(record, attempt, { timeMs: 100, chunk: outputChunk() })
  store.acceptChunk(record, attempt, { timeMs: 500, chunk: outputChunk() })
  const usage = reasoningTokens === undefined ? { outputTokens } : { outputTokens, reasoningTokens }
  store.settleAttempt(attempt, {
    settledAtMs: 550,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage,
    /** A durable settlement, so the turn's temporal shape reaches its ceiling. */
    settlementSeq: 1,
  })
  return { record, settled: store.endTurn(record, { timeMs: 600, status: 'completed' }) }
}

/** Every curve vertex of one attempt, in draw order, across both visual phases. */
function verticesOf(curve, attemptId) {
  const out = []
  for (const attempt of curve.attempts ?? []) {
    if (attempt.attemptId !== attemptId) continue
    for (const point of attempt.points ?? []) out.push(point)
  }
  return out
}

/** TPS the settled curve reports at one attempt-local instant. */
function tpsAt(curve, attemptId, localMs) {
  const point = verticesOf(curve, attemptId).find(candidate => candidate.localMs === localMs)
  return point === undefined ? undefined : point.tps
}

test('the completed curve consumes provider-calibrated magnitudes, not the raw shape weight', () => {
  const { settled } = driveThreeDeltaTurn({ outputTokens: 900, reasoningTokens: 0 })
  const attempt = settled.attemptBreakdown[0]

  /**
   * The raw evidence is untouched. Its sum is the shape weight, and it is the
   * provenance the calibration is derived from rather than a number the curve may
   * be measured in.
   */
  const rawSum = attempt.calibration.samples.reduce((sum, sample) => sum + (sample.weight ?? 0), 0)
  assert.equal(rawSum, 3 * RAW_DELTA_WEIGHT, 'the raw shape sum is 300, and stays 300')

  /** The calibrated allocation sums to the authoritative total. */
  const calibratedSum = attempt.calibration.samples.reduce((sum, sample) => sum + sample.tokens, 0)
  assert.ok(Math.abs(calibratedSum - 900) < 1e-9,
    `the calibrated samples must sum to outputTokens; they sum to ${calibratedSum}`)
  assert.deepEqual(attempt.calibration.samples.map(sample => sample.tokens), [300, 300, 300],
    'three equal 100-unit deltas share the 900-token total: one common scale of 3')

  /**
   * The curve's own magnitudes. `points` is the attempt's published (capped)
   * phase-cumulative series, so at attempt-local 500 the output episode's 900
   * calibrated tokens are averaged over the 500 ms since it opened.
   *
   * 500 ms is also the episode's first **publishable** vertex: the vertices before it
   * hold one or two samples, which the shared publication policy refuses whatever
   * elapsed time they carry. The peak is the maximum of that published series, so it
   * is this same 1800 — the old grid's 100 ms step, which published the opening
   * delta's 450 tokens against 0.1 s, is not a measurement any more.
   */
  assert.equal(tpsAt(settled.curve, 'a', 500), 1800,
    '900 calibrated tokens over the episode\'s 500 ms')
  assert.equal(tpsAt(settled.curve, 'a', 400), null,
    'the vertices the policy withholds are withheld by the sample gate, not by the magnitude system')
  assert.equal(settled.curve.peakTps, 1800,
    'the peak is the maximum of the calibrated cumulative series, not of a raw one')
  assert.equal(
    peakTps(...settled.curve.attempts.map(attempt => attempt.points)),
    settled.curve.peakTps,
    'the published peak is the maximum of the published series',
  )

  /**
   * The old pipeline, stated as a number: the raw shape weights produce 600 at the
   * same instant because the episode holds 100 + 100 + 100 over its 500 ms.
   */
  assert.notEqual(tpsAt(settled.curve, 'a', 500), 600,
    'a curve still reading the raw shape weight is the defect this test froze')
})

test('the curve total and the card total are the same magnitude system', () => {
  const { settled } = driveThreeDeltaTurn({ outputTokens: 900, reasoningTokens: 0 })

  /**
   * The one statement the two halves of the card must agree on: the sum of the
   * attempt's curve-source samples is the printed generated-token total. A curve
   * integrated over a different magnitude system than the number printed beside it
   * is the whole defect.
   */
  const curveTokens = (settled.curve.attempts ?? [])
    .reduce((sum, attempt) => sum + attempt.calibratedTokens, 0)
  assert.equal(curveTokens, settled.generatedTokens)
  assert.equal(settled.generatedTokens, 900)

  /** And the same total is what the curve's own shape integrates to. */
  for (const attempt of settled.curve.attempts) {
    const summed = attempt.samples.reduce((sum, sample) => sum + sample.tokens, 0)
    assert.ok(Math.abs(summed - attempt.calibratedTokens) < 1e-9,
      `${attempt.attemptId}: the curve samples must integrate to the calibrated total`)
  }
})

test('a curve vertex carries the calibrated quality, and never calls itself exact', () => {
  const { settled } = driveThreeDeltaTurn({ outputTokens: 900, reasoningTokens: 0 })
  for (const sample of settled.curve.attempts[0].samples) {
    assert.equal(sample.quality, 'calibrated',
      'a vertex whose magnitude came from provider usage is calibrated, not exact')
  }
  /**
   * The curve as a whole is a temporal-shape claim, and the temporal-shape axis has
   * a hard ceiling of `reconstructed` because no per-delta token count was ever
   * streamed. A calibrated magnitude does not lift that ceiling.
   */
  assert.equal(settled.curve.quality, 'reconstructed')
})

test('without authoritative usage the curve keeps the estimated raw shape', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: outputChunk() })
  store.acceptChunk(record, attempt, { timeMs: 100, chunk: outputChunk() })
  store.acceptChunk(record, attempt, { timeMs: 500, chunk: outputChunk() })
  store.settleAttempt(attempt, {
    settledAtMs: 550,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  const settled = store.endTurn(record, { timeMs: 600, status: 'completed' })

  assert.equal(settled.generatedTokens, null, 'no provider total exists to invent')
  assert.equal(tpsAt(settled.curve, 'a', 500), 3 * RAW_DELTA_WEIGHT * 1000 / 500,
    'with no anchor the curve keeps the raw shape: 300 units over the episode\'s 500 ms, i.e. 600')
  assert.equal(settled.curve.peakTps, 3 * RAW_DELTA_WEIGHT * 1000 / 500,
    'and its peak is that own first publishable vertex: three deltas are needed before any rate exists')
  for (const sample of settled.curve.attempts[0].samples) {
    assert.equal(sample.quality, 'estimated', 'an unanchored magnitude is never calibrated')
  }
})

test('tool-call argument deltas are part of the calibrated curve total', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: output('x'.repeat(400)) })
  store.acceptChunk(record, attempt, { timeMs: 100, chunk: output('x'.repeat(400)) })
  store.acceptChunk(record, attempt, {
    timeMs: 500,
    chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'pwsh', argumentsDelta: 'y'.repeat(400) },
  })
  store.settleAttempt(attempt, {
    settledAtMs: 550,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 900, reasoningTokens: 0 },
  })
  const settled = store.endTurn(record, { timeMs: 600, status: 'completed' })

  assert.deepEqual(settled.curve.attempts[0].samples.map(sample => sample.phase),
    ['output', 'output', 'output'],
    'tool-call arguments are model output, not a third phase')
  assert.equal(settled.curve.attempts[0].calibratedTokens, 900,
    'the tool-call argument delta is inside the calibrated total')
  assert.equal(tpsAt(settled.curve, 'a', 500), 1800,
    'all three deltas share the output episode, so its 900 tokens are averaged over its 500 ms')
})

test('the curve samples a new attempt from its own calibrated total', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const first = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, first, { timeMs: 0, chunk: outputChunk() })
  store.acceptChunk(record, first, { timeMs: 100, chunk: outputChunk() })
  store.acceptChunk(record, first, { timeMs: 500, chunk: outputChunk() })
  store.settleAttempt(first, {
    settledAtMs: 550,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 900, reasoningTokens: 0 },
  })

  store.toolStarted(record, { callId: 'tool-1', name: 'pwsh', timeMs: 600 })
  store.toolSettled(record, { callId: 'tool-1', timeMs: 60_600, status: 'ok' })

  const second = store.beginAttempt(record, { attemptId: 'b', step: 2, startedAtMs: 60_700 })
  store.acceptChunk(record, second, { timeMs: 60_700, chunk: outputChunk() })
  store.acceptChunk(record, second, { timeMs: 60_800, chunk: outputChunk() })
  store.acceptChunk(record, second, { timeMs: 61_200, chunk: outputChunk() })
  store.settleAttempt(second, {
    settledAtMs: 61_250,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 300, reasoningTokens: 0 },
  })

  const settled = store.endTurn(record, { timeMs: 61_300, status: 'completed' })
  const [a, b] = settled.curve.attempts
  assert.equal(a.calibratedTokens, 900, 'the first attempt keeps its own provider total')
  assert.equal(b.calibratedTokens, 300, 'the second is calibrated against its own')
  assert.equal(tpsAt(settled.curve, 'a', 500), 1800)
  assert.equal(tpsAt(settled.curve, 'b', 500), 600,
    'each attempt is measured in its own calibrated system, never a shared scale')
  assert.equal(settled.curve.peakTps, 1800,
    'and the peak is the first attempt\'s own 900 tokens over its own 500 ms, not the second\'s scale')
})

test('the trace is sampled at the documented cadence and ends at the attempt\'s own settlement', () => {
  const { settled } = driveThreeDeltaTurn({ outputTokens: 900, reasoningTokens: 0 })
  assert.equal(settled.curve.sampleEveryMs, DEFAULT_SAMPLE_EVERY_MS)
  assert.equal(settled.curve.maxSeriesPoints, MAX_SERIES_POINTS)
  /**
   * There is no statistical window to publish beside the cadence: the estimator is a
   * phase-cumulative average, so `sampleEveryMs` is a sampling decision and the cap is a
   * fidelity one. The trace runs on the 100 ms ladder from local zero to the attempt's end
   * instant — its settlement at 550 ms — and that off-ladder end is appended as the last
   * vertex, where the terminal episode's tail decays as its 900 tokens are averaged over
   * the attempt's whole 550 ms clock. This attempt has one episode, so that episode's own
   * ladder is the attempt's own; a second phase would open a ladder of its own starting at
   * its own first delta (`src/core/curve.js`).
   */
  assert.deepEqual(settled.curve.attempts[0].points.map(point => point.localMs),
    [0, 100, 200, 300, 400, 500, 550])
  assert.equal(settled.curve.attempts[0].points.at(-1).tps, Math.round(900 * 1000 / 550),
    'the last vertex averages the calibrated total over the attempt\'s own clock')
  assert.equal(settled.curve.attempts[0].points.at(-1).tps, 1636)
  assert.equal(settled.curve.durationMs, 550)
})

/**
 * The Phase 7B reproduction, as a diagnostic table.
 *
 * Phase 7B observed a turn in the browser that settled at `generatedTokens: 365` over a
 * 1530 ms curve span — a mean of 238.6 tokens/s — while `peakTps` was 63.75. That is
 * impossible for a maximum measured over the whole turn, and it is the observation Known
 * Limitation #14 recorded.
 *
 * The scenario below reproduces the **structure** of that turn rather than its provider
 * timings, which the task explicitly does not require: a short agent call with a reasoning
 * stretch and a tool-call argument stretch — the second opening half a second after the
 * first — settled with an authoritative usage report of 365 tokens. Each stretch carries
 * three deltas, the smallest episode the corrected publication policy can measure at all:
 * a rate needs three contributing samples and 100 ms of the episode's own clock, so the
 * one-delta-per-phase form of this evidence publishes no rate anywhere.
 *
 * The rejected per-phase pipeline's best answer over that evidence is one phase's 300 raw
 * units over its one-second window, `300` tokens/s, which sits below the turn's own mean of
 * 561.5 tokens/s; that is the contradiction, reproduced rather than described. The mean is
 * recorded as a diagnostic and deliberately not asserted as an invariant: a cumulative
 * phase average uses an episode-local denominator (`docs/METRICS_SPEC.md` §9).
 *
 * The pre-9.4 curve's answer on the two-delta form of this evidence is recorded as
 * `supersededFiftyMsSpike`, because that is exactly where its 5300 came from: the
 * attempt-global grid put a vertex 50 ms after the output episode opened — at the
 * settlement — and 265 calibrated tokens over that denominator is 5300 tokens/s. The
 * per-episode ladder samples each episode from its own origin, so a 50 ms denominator is
 * not withheld here, it does not exist as a vertex. The corrected peak is the output
 * episode's own first full step, and the published series is checked against an independent
 * re-derivation of that definition.
 */
test('the Phase 7B reproduction: raw shape peak, calibrated peak, and the provider total', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })

  /** The provider's authoritative report, and the split it anchors. */
  const providerOutputTokens = 365
  const providerReasoningTokens = 100
  /** What that split leaves for the non-reasoning phase: 365 - 100 = 265. */
  const outputShareTokens = providerOutputTokens - providerReasoningTokens
  /** Each phase holds three equal 100-unit deltas, so each phase weighs 300 raw units. */
  const phaseRawWeight = 3 * RAW_DELTA_WEIGHT

  /** Three reasoning deltas, then three tool-call argument deltas half a second later. */
  for (const at of [0, 100, 200]) {
    store.acceptChunk(record, attempt, { timeMs: at, chunk: reasoning('x'.repeat(400)) })
  }
  for (const at of [500, 550, 600]) {
    store.acceptChunk(record, attempt, {
      timeMs: at,
      chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'pwsh', argumentsDelta: 'y'.repeat(400) },
    })
  }
  store.settleAttempt(attempt, {
    settledAtMs: 650,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    /** The provider total, far above the 600 raw shape units the six deltas weigh. */
    usage: { outputTokens: providerOutputTokens, reasoningTokens: providerReasoningTokens },
    settlementSeq: 1,
  })
  const settled = store.endTurn(record, { timeMs: 1000, status: 'completed' })
  const curve = settled.curve
  const samples = settled.attemptBreakdown[0].calibration.samples

  /**
   * The rejected pipeline: per-phase rolling series over the raw shape weights, with the
   * one-second window frozen as `LEGACY_WINDOW_MS`. This is a reproduction of a superseded
   * statistic, not a reference for the published one.
   */
  const legacyPeakOf = (phase) => {
    let peak = 0
    for (let at = 0; at <= 2000; at += 250) {
      let total = 0
      for (const sample of attempt.samples) {
        if (sample.phase !== phase) continue
        const localMs = sample.timeMs
        if (localMs <= at && localMs > at - LEGACY_WINDOW_MS) total += sample.weight
      }
      peak = Math.max(peak, total * 1000 / LEGACY_WINDOW_MS)
    }
    return peak
  }

  const table = {
    rawHeuristicSum: attempt.samples.reduce((sum, sample) => sum + sample.weight, 0),
    calibratedSum: samples.reduce((sum, sample) => sum + sample.tokens, 0),
    providerOutputTokens: settled.generatedTokens,
    curveSpanMs: curve.durationMs,
    oldRawReferencePeak: Math.max(legacyPeakOf('reasoning'), legacyPeakOf('output')),
    oldRawPhasePeaks: { reasoning: legacyPeakOf('reasoning'), output: legacyPeakOf('output') },
    /**
     * The pre-9.4 publication rule's answer, as a derivation rather than a measurement of
     * this trace: the attempt-global grid sampled the output episode at the settlement, 50 ms
     * after it opened, so its 265 calibrated tokens were divided by 50 ms. No vertex of the
     * corrected trace carries that denominator.
     */
    supersededFiftyMsSpike: Math.round(outputShareTokens * 1000 / 50),
    newCalibratedPeak: curve.peakTps,
    calibrationScale: samples[0].tokens / samples[0].weight,
    turnMeanRate: settled.generatedTokens * 1000 / curve.durationMs,
    reasoningTps: settled.reasoningTps,
    outputTps: settled.outputTps,
  }

  /** The totals agree: the curve and the card are one magnitude system now. */
  assert.equal(table.providerOutputTokens, 365)
  assert.ok(Math.abs(table.calibratedSum - table.providerOutputTokens) < 1e-9,
    `the calibrated samples must sum to the provider total: ${table.calibratedSum}`)
  assert.equal(table.rawHeuristicSum, 600, 'six 100-unit deltas of raw shape weight')

  /**
   * The exact provider split anchors each phase against its own counter: three equal
   * 100-unit reasoning deltas share `reasoningTokens: 100`, and the three equal output
   * deltas share the 265 that are left. Each sample carries its raw weight times its
   * phase's scale, which is the derivation written here.
   */
  const phaseAllocation = phaseTokens => [0, 1, 2].map(() => RAW_DELTA_WEIGHT * (phaseTokens / phaseRawWeight))
  assert.deepEqual(samples.map(sample => sample.tokens),
    [...phaseAllocation(providerReasoningTokens), ...phaseAllocation(outputShareTokens)],
    'the exact reasoning split anchors the two phases separately')

  /**
   * The contradiction Phase 7B recorded, reproduced — and in its sharpest form. The rejected
   * pipeline measured each phase separately over a frozen one-second window, so neither of its
   * two lines could hold more than one phase's own deltas: three 100-unit reasoning deltas
   * inside the window weigh 300 raw units, and the output phase is the same. The rejected
   * pipeline's best answer is therefore 300 tokens/s, still below the turn's own mean.
   */
  assert.equal(table.oldRawReferencePeak, 300,
    'the rejected pipeline\'s best answer is one phase\'s share, never the total')
  assert.equal(table.oldRawPhasePeaks.reasoning, 300)
  assert.equal(table.oldRawPhasePeaks.output, 300)
  assert.ok(table.oldRawReferencePeak < table.turnMeanRate,
    'a maximum below the turn\'s own mean is the contradiction Known Limitation #14 recorded')

  /**
   * Where the old spike came from, stated rather than measured: 265 calibrated output
   * tokens over the 50 ms the attempt-global grid gave the output episode — the tail
   * between its first delta and the settlement. The per-episode ladder samples that episode
   * from its own origin instead, so its first full step is 100 ms and publishes 2650.
   */
  assert.equal(table.supersededFiftyMsSpike, 5300,
    'the pre-9.4 peak on the two-delta form of this evidence: 265 tokens / 50 ms')
  assert.equal(table.newCalibratedPeak, 2650,
    'the corrected peak: the output episode\'s own 265 tokens over its own first 100 ms')

  /**
   * The corrected peak, and the independent re-derivation it must equal: enumerate each
   * phase episode's **own** ladder — from the episode's first sample to the instant the next
   * episode opens, or the attempt's end for the terminal one — plus the attempt's end instant,
   * and for every instant recompute the episode in force, its cumulative mass and its own
   * elapsed clock. A vertex is a measurement only when the episode holds
   * `MIN_RATE_SAMPLES` samples and `MIN_RATE_ELAPSED_MS` of its own clock. The production
   * sampler is used on neither side of this comparison.
   */
  const reference = (() => {
    const endMs = curve.attempts[0].durationMs
    const origins = samples
      .map((sample, index) => (index === 0 || sample.phase !== samples[index - 1].phase ? index : -1))
      .filter(index => index >= 0)

    const instants = new Set([endMs])
    for (const [position, origin] of origins.entries()) {
      const next = origins[position + 1]
      const bound = next === undefined ? endMs : Math.min(samples[next].timeMs, endMs)
      for (let at = samples[origin].timeMs; at <= bound; at += DEFAULT_SAMPLE_EVERY_MS) instants.add(at)
    }

    let peak = null
    for (const at of [...instants].sort((a, b) => a - b)) {
      let newest = -1
      for (let index = 0; index < samples.length; index += 1) {
        if (samples[index].timeMs <= at) newest = index
      }
      if (newest < 0) continue
      /** The maximal same-phase run containing the newest sample seen so far. */
      let start = newest
      while (start > 0 && samples[start - 1].phase === samples[newest].phase) start -= 1
      const sampleCount = newest - start + 1
      const elapsed = at - samples[start].timeMs
      if (sampleCount < MIN_RATE_SAMPLES || elapsed < MIN_RATE_ELAPSED_MS) continue
      let mass = 0
      for (let index = start; index <= newest; index += 1) mass += samples[index].tokens
      const tps = Math.round(mass * 1000 / elapsed)
      if (peak === null || tps > peak) peak = tps
    }
    return peak
  })()
  assert.equal(table.newCalibratedPeak, reference,
    'the published peak equals the independent phase-cumulative reference')
  assert.deepEqual(curve.attempts[0].points.map(point => point.tps),
    [null, null, 500, 333, 250, null, 2650, 1767],
    'the opening vertices publish nothing, the reasoning episode decays as its clock '
    + 'advances, the output episode resets the magnitude at the transition, and its own '
    + 'first full step publishes 2650')

  /**
   * The other direction, on a different script: a provider count **above** the raw shape raises
   * the curve and the peak with it, from 600 (three 100-unit deltas over the episode's 500 ms,
   * asserted unanchored above) to 1800 (three 300-token deltas over the same 500 ms). Both
   * directions are the same statement — the curve is measured in the printed system — and
   * asserting only one of them would let a one-way implementation pass.
   */
  const scaledUp = driveThreeDeltaTurn({ outputTokens: 900, reasoningTokens: 0 })
  assert.equal(scaledUp.settled.curve.peakTps, 3 * 300 * 1000 / 500,
    'a calibration above 1 raises the whole trace, peak included')
  assert.equal(scaledUp.settled.curve.peakTps, 1800)
  assert.ok(scaledUp.settled.curve.peakTps > 3 * RAW_DELTA_WEIGHT * 1000 / 500,
    'and it is strictly above the same evidence left at the raw shape weight')

  /** Recorded for the report; the assertions above are what make it a test. */
  settled.curve.diagnostic = table
  assert.ok(
    Object.values(table).filter(value => typeof value === 'number').every(value => Number.isFinite(value)),
    `every scalar diagnostic must be a finite number: ${JSON.stringify(table)}`,
  )
})
