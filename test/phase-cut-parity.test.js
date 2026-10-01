/**
 * Phase 9.4.3 — a non-magnitude phase cut closes the outgoing TPS episode on the
 * completed curve without opening the incoming one.
 *
 * ## The defect this file freezes
 *
 * The live meter has closed the outgoing episode at a non-magnitude phase boundary
 * since Phase 9.4.2 (`LiveMeter.observeTokenBoundary`), and the completed curve had
 * no record of that boundary at all: `attempt.samples` holds magnitude-bearing
 * deltas only, and `cumulativePhaseTpsSeries` segmented episodes from the phase of
 * consecutive samples. The curve therefore continued the outgoing episode until the
 * **first magnitude sample of the new phase**, and published the decay across a
 * stretch the live pill had already left.
 *
 * Measured on baseline `68ba746` with the principal fixture — turn start `0`,
 * reasoning samples at `0/50/100` (100 shape tokens each), a name-bearing
 * `tool-call-delta` with an empty `argumentsDelta` at `120` declaring `output`,
 * output samples at `300/350/400` — through the real store path:
 *
 *     live at 120   activePhase output, tps null, episodeElapsedMs null, samples 0
 *     live at 200   activePhase output, tps null, episodeElapsedMs null, samples 0
 *     curve at 200  activePhase reasoning, episodeStartMs 0, elapsed 200,
 *                   sampleCount 3, mass 300, tps 1500        <- the defect
 *     curve runs    reasoning 0..200, output 200..400          (one shared seam)
 *     summary       reasoningMs 300, reasoningTps 1000         (the 120->300 gap
 *                                                              charged to reasoning)
 *
 * `test/boundary-episode-origin.test.js` CASE I already recorded the *other* half
 * of the same missing evidence (`reasoning -> output boundary -> reasoning`); this
 * file is the principal fixture, where the boundary's declared phase is confirmed
 * by the magnitude samples that follow it, so there is no ambiguity to resolve.
 *
 * ## The contract
 *
 *     A non-magnitude phase boundary may close the outgoing TPS episode without
 *     opening the incoming TPS episode.
 *
 * The cut is recorded as its own attempt-level evidence (a `{timeMs, phase}` entry
 * in `attempt.phaseCuts`), never as a sample: it contributes no magnitude, no
 * sample count and no roster of its own. Both reconstruction planes feed it
 * through the same `TurnTelemetryStore.acceptChunk` call, so a reloaded card
 * recovers the identical cut (case G below).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { MIN_RATE_ELAPSED_MS, MIN_RATE_SAMPLES } from '../src/core/rate-publication.js'
import { MIN_WARMUP_SAMPLES } from '../src/core/live-metrics.js'
import { materializeReconstructedTurn } from '../src/dsh/reconstruction.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'

/* ----------------------------------------------------------------- fixtures */

/** A name-bearing tool-call delta whose argument fragment has not arrived yet. */
const NAME_ONLY_DELTA = Object.freeze({
  type: 'tool-call-delta',
  index: 0,
  id: 'call_1',
  name: 'pwsh',
  argumentsDelta: '',
})

/** A generated delta carrying `tokens` heuristic tokens (four characters each). */
const outputDelta = tokens => ({ type: 'text-delta', index: 0, text: 'x'.repeat(tokens * 4) })
const reasoningDelta = tokens => ({ type: 'reasoning-delta', index: 0, text: 'x'.repeat(tokens * 4) })

/** A store, a turn and its first attempt, opened the way the host opens them. */
function openTurn({ sessionId, turn = 1, turnStartMs = 0, attemptId = 'a1', step = 1 } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId, turn, timeMs: turnStartMs })
  const attempt = store.beginAttempt(record, { attemptId, step, startedAtMs: turnStartMs })
  return { store, record, attempt }
}

const settleRow = (settledAtMs, seq = 1, usage = null) => ({
  settledAtMs,
  settlementKind: 'message',
  surfaceCommitted: true,
  attemptOutcome: 'committed',
  settlementSeq: seq,
  usage,
})

/** The trace of one attempt of a settled turn. */
const traceOf = (settled, attemptId) => settled.curve.attempts.find(entry => entry.attemptId === attemptId)

/** Ascending measured rates of one trace, as `[localMs, tps]` pairs. */
const measuredPairs = trace => trace.points
  .filter(point => Number.isFinite(point.tps))
  .map(point => [point.localMs, point.tps])

/* --------------------------------------- A — the principal non-magnitude cut */

test('CASE A — reasoning / output boundary / delayed output: the cut closes reasoning and opens no output clock', () => {
  const SESSION = 's-943-a'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  assert.equal(store.liveSnapshot(SESSION, 100).tps, 3000,
    '300 reasoning shape tokens over the episode\'s own 100 ms')

  assert.equal(store.acceptChunk(record, attempt, { timeMs: 120, chunk: NAME_ONLY_DELTA }), null,
    'the boundary is never a TPS-shape sample')
  const atBoundary = store.liveSnapshot(SESSION, 120)
  assert.equal(atBoundary.activePhase, 'output', 'the phase identity changes at the boundary')
  assert.equal(atBoundary.episodeElapsedMs, null)
  assert.equal(atBoundary.episodeSampleCount, 0)
  assert.equal(atBoundary.tps, null)

  const at200 = store.liveSnapshot(SESSION, 200)
  assert.equal(at200.activePhase, 'output', 'the live pill is still in the declared output phase')
  assert.equal(at200.episodeElapsedMs, null, 'and still holds no episode clock')
  assert.equal(at200.episodeSampleCount, 0)
  assert.equal(at200.tps, null)
  assert.equal(at200.fallback, false, 'the reasoning rate is not extended across a phase that produced nothing')

  for (const timeMs of [300, 350, 400]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }

  /**
   * The cut is its own evidence. It is recorded once, at the boundary instant,
   * carrying the phase the boundary declared; it is not in `attempt.samples`.
   */
  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 120, phase: 'output' }],
    'the boundary is recorded as a phase cut, not converted into a sample')
  assert.deepEqual(attempt.samples.map(sample => sample.timeMs), [0, 50, 100, 300, 350, 400],
    'the boundary contributes no sample and no timestamp to the sample stream')
  assert.equal(attempt.samples.every(sample => sample.tokens > 0), true,
    'and every stored sample still carries real generated mass')

  store.settleAttempt(attempt, settleRow(400))
  const settled = store.endTurn(record, { timeMs: 400, status: 'completed' })
  const trace = traceOf(settled, 'a1')

  /** The cut on the curve's own clock, and the trace it produced. */
  assert.deepEqual(trace.cuts, [{ timeMs: 120, localMs: 120, phase: 'output' }],
    'the completed trace carries the same cut on the attempt-local clock')

  const reasoningPoints = trace.points.filter(point => point.activePhase === 'reasoning')
  assert.deepEqual(reasoningPoints.map(point => point.localMs), [0, 100, 120],
    'the reasoning episode is drawn up to the cut and no further')
  assert.equal(trace.points.some(point => point.activePhase === 'reasoning' && point.localMs > 120), false,
    'no reasoning vertex survives after the cut')
  assert.equal(trace.points.some(point => point.localMs > 120 && point.localMs < 300), false,
    'and nothing at all is sampled in the 120 -> 300 gap')

  const closing = reasoningPoints[reasoningPoints.length - 1]
  assert.equal(closing.timeMs, 120, 'the closing vertex is the cut instant on the compressed axis')
  assert.equal(closing.episodeStartMs, 0, 'the outgoing episode keeps its own origin')
  assert.equal(closing.episodeEndMs, 120, 'and ends at the cut')
  assert.equal(closing.episodeElapsedMs, 120)
  assert.equal(closing.episodeSampleCount, 3, 'the cut itself contributes no sample count')
  assert.equal(closing.episodeMass, 300, 'and no magnitude')
  assert.equal(closing.tps, 2500, '300 shape tokens over the episode\'s real 120 ms')
  assert.equal(closing.rateUnavailableReason, null)

  const outputPoints = trace.points.filter(point => point.activePhase === 'output')
  assert.deepEqual(outputPoints.map(point => point.localMs), [300, 400],
    'no output vertex exists before the first output magnitude sample, and the episode is sampled on its own 100 ms ladder from its own origin')
  assert.equal(outputPoints[0].episodeStartMs, 300,
    'the incoming episode opens at its first magnitude sample, not at the cut')
  assert.equal(outputPoints[0].episodeElapsedMs, 0)
  assert.equal(outputPoints[0].episodeSampleCount, 1)
  assert.equal(outputPoints[0].tps, null, 'and its opening anchor is not a rate')
  assert.deepEqual(measuredPairs(trace), [[100, 3000], [120, 2500], [400, 3000]],
    'only the real episode measurements are published')

  assert.equal(settled.curve.peakTps, 3000, 'the published peak is unchanged by the cut')

  /**
   * The drawable geometry: the two phase stretches no longer share a seam, so no
   * segment crosses the gap and no output measurement is fabricated at the cut.
   */
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 2],
    ['output', 3, 4],
  ], 'the cut ends the reasoning run; the output run opens on its own first vertex')
  assert.equal(trace.runs[0].endMs, 120)
  assert.equal(trace.runs[1].startMs, 300)
  assert.equal(trace.runs[1].points[0].timeMs, 300,
    'the output run carries no reasoning vertex: the outgoing episode\'s last measurement is not borrowed')

  const view = curveViewModel(settled)
  const reasoningSeries = view.series.find(entry => entry.key === 'reasoning')
  const outputSeries = view.series.find(entry => entry.key === 'output')
  const reasoningDrawn = reasoningSeries.coordinates
  const outputDrawn = outputSeries.coordinates
  assert.deepEqual(reasoningDrawn.map(point => point.x), [25, 30],
    'the reasoning subpath stops at the cut: x 120 of a 400 ms axis')
  assert.deepEqual(outputDrawn.map(point => point.x), [100],
    'and the output episode\'s one publishable vertex is its own closing instant')
  assert.equal(reasoningDrawn.at(-1).x < outputDrawn[0].x, true,
    'the two stretches are disjoint: no drawn segment crosses 120 -> 300')
  assert.equal(outputSeries.present, false,
    'one measured vertex is a point marker, not a fabricated segment')
  assert.deepEqual(outputSeries.markers.map(marker => marker.timeMs), [400])
  assert.equal(reasoningSeries.peak.tps, 3000)
  assert.equal(outputSeries.peak.tps, 3000)
  assert.equal(view.peak.value, 3000)

  /**
   * The summary arithmetic reads the same cut. Before the fix the 120 -> 300 gap
   * was charged to the reasoning denominator (300 ms), which understated the
   * phase rate by a factor of 2.5.
   */
  assert.equal(settled.reasoningMs, 120, 'the reasoning denominator is the episode, not the gap')
  assert.equal(settled.reasoningTps, 2500, '300 reasoning tokens over the episode\'s own 120 ms')
  assert.equal(settled.outputMs, 100, 'the output episode owns its own 100 ms')
  assert.equal(settled.outputTps, 3000)
  /**
   * TTFT is the turn's **first** token, and this fixture's first token is the
   * reasoning delta at the turn start itself: the boundary at 120 is not the first
   * token and `firstTokenObserved` is one-way, so it does not move the stamp. What
   * the boundary owns is the phase identity and the cut.
   */
  assert.equal(settled.ttftMs, 0)
  assert.equal(record.firstTokenMs, 0)
})

/* -------------------------------- B — a cut before the first magnitude sample */

test('CASE B — a boundary before the first magnitude sample adds no width and no cut vertex', () => {
  /**
   * Phase 9.4.2's invariant, restated under the new evidence: `compressAttempts`
   * starts an attempt's local clock at its first **generated sample**, so a
   * boundary that precedes every sample owns no coordinate on the curve axis. It
   * is still the TTFT boundary, and it must not become a negative local time, a
   * fake pre-sample width or a vertex.
   */
  const SESSION = 's-943-b'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  assert.equal(store.acceptChunk(record, attempt, { timeMs: 100, chunk: NAME_ONLY_DELTA }), null)
  assert.equal(store.liveSnapshot(SESSION, 100).ttftMs, 100, 'the boundary is the TTFT origin')
  assert.equal(store.liveSnapshot(SESSION, 100).episodeElapsedMs, null)

  for (const timeMs of [200, 250, 300]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  store.settleAttempt(attempt, settleRow(300))
  const settled = store.endTurn(record, { timeMs: 300, status: 'completed' })
  const trace = traceOf(settled, 'a1')

  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 100, phase: 'output' }],
    'the attempt keeps the boundary as evidence')
  assert.deepEqual(trace.cuts, [],
    'but it has no coordinate on the attempt clock, so the trace carries no cut')
  assert.equal(settled.curve.durationMs, 100,
    'the attempt\'s axis width is its own 200 -> 300 generation, with no pre-sample width')
  assert.deepEqual(settled.curve.segments.map(segment => [segment.startMs, segment.endMs]), [[0, 100]])
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [[0, null], [100, 3000]],
    'the trace is the three output samples and nothing else')
  assert.equal(trace.points[0].episodeStartMs, 0, 'the output episode opens at its own first magnitude sample')
  assert.equal(trace.points[1].episodeSampleCount, 3)
  assert.equal(trace.points[1].episodeElapsedMs, 100)
  assert.equal(settled.curve.peakTps, 3000)
  assert.equal(settled.ttftMs, 100, 'TTFT remains the boundary instant')
  assert.equal(settled.reasoningTps, null, 'no reasoning episode exists, so no reasoning rate is published')
  assert.equal(settled.outputTps, 3000)
})

/* ------------------------------------------- C — a same-phase boundary is inert */

test('CASE C — a same-phase boundary neither cuts nor resets a valid episode', () => {
  const SESSION = 's-943-c'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  for (const timeMs of [200, 250, 300]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  assert.equal(store.acceptChunk(record, attempt, { timeMs: 350, chunk: NAME_ONLY_DELTA }), null)
  const afterBoundary = store.liveSnapshot(SESSION, 350)
  assert.equal(afterBoundary.activePhase, 'output')
  assert.equal(afterBoundary.episodeElapsedMs, 150, 'the episode clock simply advanced')
  assert.equal(afterBoundary.episodeSampleCount, 3, 'and its sample count is untouched')

  for (const timeMs of [400, 450]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(200) })
  }
  const live = store.liveSnapshot(SESSION, 450)
  assert.equal(live.episodeSampleCount, 5)
  assert.equal(live.tps, 2800, '700 output tokens over the episode\'s own 250 ms')

  store.settleAttempt(attempt, settleRow(450))
  const settled = store.endTurn(record, { timeMs: 450, status: 'completed' })
  const trace = traceOf(settled, 'a1')

  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 350, phase: 'output' }],
    'the same-phase boundary is recorded as evidence rather than dropped')
  assert.equal(trace.runs.length, 1, 'and it cuts nothing: one output run, one episode')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [['output', 0, 3]])
  const closing = trace.points.at(-1)
  assert.equal(closing.localMs, 250, 'the trace is sampled on the episode\'s own ladder, from its own origin')
  assert.equal(closing.episodeStartMs, 0, 'the episode keeps the origin its first sample gave it')
  assert.equal(closing.episodeEndMs, 250)
  assert.equal(closing.episodeSampleCount, 5, 'the boundary is not a sample')
  assert.equal(closing.episodeMass, 700)
  assert.equal(closing.tps, live.tps, 'live and completed still agree across a same-phase boundary')
  assert.equal(settled.outputMs, 250)
  assert.equal(settled.outputTps, 2800)
})

/* --------------------------------- D — an ordinary magnitude phase transition */

test('CASE D — an ordinary magnitude transition keeps its shared seam and its episode clocks', () => {
  /**
   * The control: when the new phase is announced by a magnitude sample and no
   * boundary chunk exists, the cut machinery must change nothing. The two runs
   * still meet on one shared vertex, because the outgoing episode ends exactly
   * where the incoming one opens.
   */
  const SESSION = 's-943-d'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  for (const timeMs of [150, 200, 250]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  store.settleAttempt(attempt, settleRow(250))
  const settled = store.endTurn(record, { timeMs: 250, status: 'completed' })
  const trace = traceOf(settled, 'a1')

  assert.deepEqual(attempt.phaseCuts, [], 'no boundary chunk, no cut')
  assert.deepEqual(trace.cuts, [])
  assert.deepEqual(trace.points.map(point => [point.localMs, point.activePhase]), [
    [0, 'reasoning'], [100, 'reasoning'], [150, 'output'], [250, 'output'],
  ], 'each episode is sampled on its own ladder from its own origin')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 1],
    ['output', 1, 3],
  ], 'the incoming run opens on the outgoing run\'s last vertex: the seam is shared')
  /**
   * Two different instants, and the difference is the shared seam: the outgoing
   * **episode** ends at the transition sample (150), and the outgoing **run** is
   * drawn up to the vertex the incoming run borrows (100).
   */
  assert.equal(trace.points[1].episodeEndMs, 150, 'the outgoing episode ends where the incoming one begins')
  assert.equal(trace.runs[0].endMs, 100, 'the outgoing subpath is drawn to the shared seam vertex')
  assert.equal(trace.runs[1].startMs, 100)
  assert.equal(trace.points[2].episodeStartMs, 150)
  assert.equal(trace.points[2].episodeElapsedMs, 0, 'the transition vertex is an opening anchor, not a rate')
  assert.equal(trace.points[2].tps, null)
  assert.equal(settled.curve.peakTps, 3000)
  assert.equal(settled.reasoningMs, 150, 'the outgoing episode runs to the transition sample')
  assert.equal(settled.outputMs, 100)
})

/* ------------------------------------------------ E — retry / tool boundaries */

test('CASE E — a cut never leaks across an attempt boundary', () => {
  const SESSION = 's-943-e'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 1_000 })

  for (const timeMs of [1_000, 1_050, 1_100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  store.acceptChunk(record, attempt, { timeMs: 1_120, chunk: NAME_ONLY_DELTA })
  store.settleAttempt(attempt, settleRow(1_120, 1))
  store.toolStarted(record, { callId: 'call_1', name: 'pwsh', timeMs: 1_150 })
  store.toolSettled(record, { callId: 'call_1', timeMs: 1_200, status: 'ok' })

  const retry = store.beginAttempt(record, { attemptId: 'a2', step: 2, startedAtMs: 1_250 })
  for (const timeMs of [1_300, 1_350, 1_400]) {
    store.acceptChunk(record, retry, { timeMs, chunk: outputDelta(100) })
  }
  store.settleAttempt(retry, settleRow(1_400, 2))
  const settled = store.endTurn(record, { timeMs: 1_400, status: 'completed' })

  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 1_120, phase: 'output' }])
  assert.deepEqual(retry.phaseCuts, [], 'the retry owns no cut of its own')

  const first = traceOf(settled, 'a1')
  const second = traceOf(settled, 'a2')
  /** The trace clock is the attempt-local one, so the cut sits at local 120. */
  assert.deepEqual(first.cuts, [{ timeMs: 120, localMs: 120, phase: 'output' }])
  assert.deepEqual(second.cuts, [], 'and the first attempt\'s cut is not on the retry\'s clock')
  assert.deepEqual(first.points.map(point => [point.localMs, point.activePhase]),
    [[0, 'reasoning'], [100, 'reasoning'], [120, 'reasoning']])
  assert.deepEqual(second.points.map(point => [point.localMs, point.activePhase]),
    [[0, 'output'], [100, 'output']],
    'the retry is a clean output episode from its own first sample')
  assert.equal(second.runs.length, 1)
  assert.equal(second.runs[0].startIndex, 0)
  assert.equal(second.points[1].episodeStartMs, 0, 'the retry opens its own episode')
  assert.equal(second.points[1].episodeSampleCount, 3)
  assert.equal(settled.ttftMs, 0, 'the turn TTFT is still the first attempt\'s first token (its own delta at 1000)')
})

/* ---------------------------------------------------- F — provider baselines */

test('CASE F — the incoming episode takes its provider baseline at its first magnitude sample', () => {
  /**
   * The cut is not an episode origin, so it is not a baseline instant either: the
   * counter snapshot the output numerator is measured from is the one known when
   * the episode's **first magnitude sample** opened it (Phase 9.4.2's rule, kept).
   */
  const SESSION = 's-943-f'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })
  const usage = (timeMs, outputTokens, reasoningTokens) => store.acceptChunk(record, attempt, {
    timeMs,
    chunk: { type: 'usage', usage: { outputTokens, reasoningTokens } },
  })

  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  usage(110, 900, 300)
  store.acceptChunk(record, attempt, { timeMs: 120, chunk: NAME_ONLY_DELTA })
  assert.equal(store.liveBySession.get(SESSION).episodeStartMs, null,
    'the boundary starts no episode and therefore takes no baseline')
  assert.equal(store.liveBySession.get(SESSION).episodeUsageBaseline, null)

  for (const timeMs of [300, 350]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  assert.deepEqual(store.liveBySession.get(SESSION).episodeUsageBaseline,
    { phase: 'output', counter: 600 },
    'the baseline is the counter known when the first output magnitude sample opened the episode')

  usage(380, 950, 320)
  store.acceptChunk(record, attempt, { timeMs: 400, chunk: outputDelta(100) })
  const live = store.liveSnapshot(SESSION, 400)
  assert.equal(store.liveBySession.get(SESSION).episodeStartMs, 300)
  assert.deepEqual(store.liveBySession.get(SESSION).episodeMass(), { mass: 30, source: 'provider-counter' })
  assert.equal(live.episodeElapsedMs, 100)
  assert.equal(live.episodeSampleCount, 3)
  assert.equal(live.tps, 300, '30 counter tokens over the episode\'s own 100 ms')

  store.settleAttempt(attempt, settleRow(400))
  const settled = store.endTurn(record, { timeMs: 400, status: 'completed' })
  const trace = traceOf(settled, 'a1')
  const outputPoints = trace.points.filter(point => point.activePhase === 'output')
  assert.equal(outputPoints[0].localMs, 300, 'and the completed curve opens the same episode at the same instant')
  assert.equal(outputPoints[0].episodeStartMs, 300)
  assert.equal(outputPoints[0].episodeSampleCount, 1)
})

/* --------------------------------------------- G — durable reconstruction parity */

/**
 * The durable settlement's embedded compact stream for the principal fixture.
 *
 * `tool-call-chunks` with `args: ['']` is the shape DSH's accumulator produces for a
 * name-bearing delta whose argument fragment has not arrived — recorded evidence:
 * `docs/IMPLEMENTATION_LOG.md` counts 56 of 62 decoded deltas of `fixtures/dsh-turns/t1`
 * step 1 as `tool-call-delta` with `argumentsDelta: ""` and `name: "pwsh"` — and the
 * strict decoder accepts it (`time0` 120, `dt` `[]`, one member).
 */
function durableStream() {
  return [
    { type: 'reasoning-chunks', time0: 0, index: 0, dt: [50, 50], texts: ['x'.repeat(400), 'x'.repeat(400), 'x'.repeat(400)] },
    { type: 'tool-call-chunks', time0: 120, index: 0, dt: [], id: 'call_1', name: 'pwsh', args: [''] },
    { type: 'text-chunks', time0: 300, index: 0, dt: [50, 50], texts: ['x'.repeat(400), 'x'.repeat(400), 'x'.repeat(400)] },
  ]
}

test('CASE G — the durable reconstruction recovers the identical cut, gap and peak', () => {
  const STREAM = durableStream()

  /** Plane 1: the transient path, driven chunk by chunk. */
  const live = openTurn({ sessionId: 's-943-g-live', turnStartMs: 0 })
  for (const entry of [
    [0, reasoningDelta(100)], [50, reasoningDelta(100)], [100, reasoningDelta(100)],
    [120, NAME_ONLY_DELTA],
    [300, outputDelta(100)], [350, outputDelta(100)], [400, outputDelta(100)],
  ]) {
    live.store.acceptChunk(live.record, live.attempt, { timeMs: entry[0], chunk: entry[1] })
  }
  live.store.settleAttempt(live.attempt, settleRow(400))
  const transient = live.store.endTurn(live.record, { timeMs: 400, status: 'completed' })

  /** Plane 2: the durable settlement, decoded and materialized after a reload. */
  const store = new TurnTelemetryStore()
  const { record } = materializeReconstructedTurn({
    store,
    sessionId: 's-943-g-durable',
    turn: 1,
    events: [
      { seq: 1, type: 'turn/start', time: 0, data: { turn: 1 } },
      { seq: 2, type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
      { seq: 3, type: 'assistant/message', time: 400, data: { turn: 1, step: 1, stream: STREAM } },
      { seq: 4, type: 'turn/end', time: 400, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const durable = store.endTurn(record, { timeMs: 400, status: 'completed' })

  const rebuilt = record.attempts[0]
  assert.deepEqual(rebuilt.phaseCuts, [{ timeMs: 120, phase: 'output' }],
    'the durable plane recovers the cut the transient plane recorded')
  assert.equal(rebuilt.samples.length, 6, 'and still fabricates no sample for the boundary member')

  /** The two completed cards must be the same card. */
  assert.equal(durable.ttftMs, transient.ttftMs)
  assert.equal(durable.ttftMs, 0,
    'both planes freeze the same first token — the fixture\'s first reasoning delta, at the turn start')
  assert.equal(durable.curve.peakTps, transient.curve.peakTps)
  assert.equal(durable.curve.peakTps, 3000)
  assert.equal(durable.curve.durationMs, transient.curve.durationMs)
  /** `attemptId` is reconstruction-local (a durable log carries none), so it is excluded. */
  assert.deepEqual(
    durable.curve.segments.map(({ attemptId, ...rest }) => rest),
    transient.curve.segments.map(({ attemptId, ...rest }) => rest),
    'including the attempt width and the cut count `compressAttempts` derived',
  )
  assert.deepEqual(durable.curve.segments.map(segment => segment.phaseCutCount), [1],
    'and the durable plane mapped the recovered boundary onto the compressed clock')

  const durableTrace = durable.curve.attempts[0]
  const transientTrace = transient.curve.attempts[0]
  /** `attemptId` is reconstruction-local (a durable log carries none), so it is excluded. */
  const project = trace => ({
    cuts: trace.cuts,
    samples: trace.samples.map(sample => [sample.timeMs, sample.phase, sample.tokens]),
    points: trace.points.map(point => [
      point.timeMs, point.tps, point.activePhase, point.episodeStartMs, point.episodeEndMs,
      point.episodeElapsedMs, point.episodeSampleCount, point.episodeMass,
    ]),
    runs: trace.runs.map(run => [run.phase, run.startMs, run.endMs, run.startIndex, run.endIndex]),
  })
  assert.deepEqual(project(durableTrace), project(transientTrace),
    'the durable reconstruction produces the identical cut, gap, vertices and runs')

  const summary = settled => [
    settled.reasoningMs, settled.reasoningTps, settled.outputMs, settled.outputTps, settled.generatedTokens,
  ]
  assert.deepEqual(summary(durable), summary(transient), 'and the identical summary arithmetic')
  assert.deepEqual(summary(durable), [120, 2500, 100, 3000, null])
})

/* ------------------------------------------------ H — publication gates kept */

test('CASE H — the cut fabricates no peak, no mass, no sample and no zero', () => {
  assert.equal(MIN_RATE_SAMPLES, 3)
  assert.equal(MIN_RATE_ELAPSED_MS, 100)
  assert.equal(MIN_WARMUP_SAMPLES, MIN_RATE_SAMPLES)

  const SESSION = 's-943-h'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })
  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  store.acceptChunk(record, attempt, { timeMs: 120, chunk: NAME_ONLY_DELTA })
  for (const timeMs of [300, 350, 400]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  store.settleAttempt(attempt, settleRow(400))
  const settled = store.endTurn(record, { timeMs: 400, status: 'completed' })
  const trace = traceOf(settled, 'a1')

  for (const point of trace.points) {
    if (Number.isFinite(point.tps)) {
      assert.equal(point.publishable, true)
      assert.ok(point.episodeElapsedMs >= MIN_RATE_ELAPSED_MS)
      assert.ok(point.episodeSampleCount >= MIN_RATE_SAMPLES, 'a published rate needs its three samples')
      assert.equal(point.rateUnavailableReason, null)
    } else {
      assert.equal(point.tps, null, 'a withheld vertex is null, never a measured zero')
      assert.equal(point.publishable, false)
      assert.equal(typeof point.rateUnavailableReason, 'string')
    }
  }
  assert.equal(trace.points.some(point => point.tps === 0), false, 'no fabricated zero anywhere')
  assert.equal(trace.samples.some(sample => !(sample.tokens > 0)), false, 'no zero-token fake sample')
  assert.equal(trace.samples.some(sample => sample.timeMs === 120), false, 'no sample at the cut')
  assert.equal(trace.tokens, 600, 'the trace integral is the six real samples and nothing else')
  assert.equal(settled.curve.peakTps, Math.max(...measuredPairs(trace).map(pair => pair[1])))
  assert.equal(settled.curve.peakProvenance.episodeSampleCount >= MIN_RATE_SAMPLES, true,
    'the published peak names an episode that passed the gate')
  /**
   * Both episode closings measure 3000 tokens/s (reasoning `300 / 100 ms`, output
   * `300 / 100 ms`), and the documented tie rule resolves a shared maximum to the
   * earliest vertex — the cut does not change that.
   */
  assert.equal(settled.curve.peakProvenance.tps, 3000)
  assert.equal(settled.curve.peakProvenance.phase, 'reasoning')
  assert.equal(settled.curve.peakProvenance.elapsedMs, 100)
  /**
   * The peak-bearing vertex is inside a run the chart draws, so the printed number
   * and the geometry still describe one measurement (a cut may not orphan it).
   */
  assert.equal(trace.runs.some(run => run.points.some(point => point.tps === settled.curve.peakTps)), true)
})
