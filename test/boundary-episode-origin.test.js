/**
 * Phase 9.4.2 — a boundary-only first token does not open the TPS episode clock.
 *
 * ## The defect this file freezes
 *
 * Phase 9.4 made a name-bearing `tool-call-delta` with an empty `argumentsDelta`
 * the turn's first token (`tokenEvidence().countsAsToken`, `isTokenDelta`), and
 * `LiveMeter.observeTokenBoundary` opened the phase episode **at the boundary
 * instant** while contributing no magnitude:
 *
 *     this.episodeStartMs = timeMs          // boundary, not a magnitude sample
 *     this.episodeTokenMass = 0
 *     this.episodeSampleCount = 0
 *     this.episodeUsageBaseline = this.usageBaselineFor(nextPhase)
 *
 * That made a boundary-only instant the denominator origin of a phase episode
 * whose numerator is entirely sample-based, and the completed curve never sees
 * the boundary at all: `compressAttempts` starts an attempt's local clock at its
 * first **generated sample**, and `cumulativePhaseTpsSeries` opens an episode at
 * its first sample's `activeTimeMs`. Live and completed therefore measured the
 * same phase episode from two different origins.
 *
 * Measured on baseline `6506bd0` with the fixture of §2 below — turn start
 * `t = 0`, name-only boundary at `t = 100`, three 100-token output samples at
 * `t = 200 / 250 / 300` — through the real store/live/curve path:
 *
 *     live episode origin  = 100 ms      completed episode origin = 200 ms
 *     live mass            = 300         completed mass           = 300
 *     live sample count    = 3           completed sample count   = 3
 *     live elapsed         = 200 ms      completed elapsed        = 100 ms
 *     live TPS             = 1500        completed TPS            = 3000
 *
 * ## The invariant frozen here
 *
 * Three concepts, deliberately distinct:
 *
 *     TTFT boundary             first chunk DSH's `isTokenDelta` accepts
 *     TPS magnitude sample      a generated sample carrying `tokens`/`weight`
 *     TPS episode origin        the first magnitude sample of that phase episode
 *
 * A boundary-only delta establishes the first and the phase identity, and neither
 * of the others. So for the fixture above:
 *
 *     TTFT origin              = 100 ms
 *     output TPS episode start = 200 ms
 *
 * The provider-counter baseline moves with the same origin: it is the counter
 * snapshot known when the episode's **first magnitude sample** opened it, never
 * one taken at a boundary that opened no episode. Numerator and denominator then
 * describe one interval.
 *
 * Every test drives the real path — `TurnTelemetryStore.acceptChunk` (host),
 * `liveSnapshot` (live) and `endTurn().curve` (curve) — or the real controller
 * for the presentation half. No test constructs or mutates a `LiveMeter`
 * directly; the meter is only *read*, through the store that owns it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import {
  MIN_RATE_ELAPSED_MS,
  MIN_RATE_SAMPLES,
} from '../src/core/rate-publication.js'
import { MIN_WARMUP_SAMPLES } from '../src/core/live-metrics.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { createController } from '../src/client/live/controller.js'
import { DASH } from '../src/client/format.js'
import { durableEntry, fakeSessionsService, transientEntry } from './helpers/live-replay.js'

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

/**
 * The session's live meter, read-only.
 *
 * `liveSnapshot` publishes the derived values (`tps`, `episodeElapsedMs`,
 * `episodeSampleCount`); the meter itself holds the episode **origin** and the
 * provider baseline those values are computed from, and a test of
 * origin-parity has to name them.
 */
const meterOf = (store, sessionId) => store.liveBySession.get(sessionId)

/** One settlement row, in the shape `settleAttempt` receives from the host. */
const settle = (settledAtMs, seq = 1) => ({
  settledAtMs,
  settlementKind: 'message',
  surfaceCommitted: true,
  attemptOutcome: 'committed',
  settlementSeq: seq,
  usage: null,
})

/** Close the turn and return its settled snapshot. */
function close(store, record, atMs) {
  const settled = store.endTurn(record, { timeMs: atMs, status: 'completed' })
  return settled
}

/** Every vertex of every attempt trace of one settled turn. */
function allPoints(settled) {
  return (settled.curve?.attempts ?? []).flatMap(trace => trace.points ?? [])
}

/* ------------------------------------------- Case A — a boundary and nothing */

test('CASE A — a boundary-only delta freezes TTFT and opens no TPS episode', () => {
  /**
   * Baseline `6506bd0`: `episodeElapsedMs` was `0` at the boundary and advanced
   * with the clock (`50` at 1150, `500` at 1600) while mass and sample count
   * stayed `0`, so the pill carried a TPS clock for an episode with no numerator
   * and no samples. The fixed contract is that the boundary establishes the TTFT
   * origin and the phase identity, and no episode origin at all.
   */
  const { store, record, attempt } = openTurn({ sessionId: 's-942-a', turnStartMs: 1_000 })

  assert.equal(store.acceptChunk(record, attempt, { timeMs: 1_100, chunk: NAME_ONLY_DELTA }), null,
    'a boundary-only delta is never a TPS-shape sample')

  const atBoundary = store.liveSnapshot('s-942-a', 1_100)
  assert.equal(atBoundary.ttftMs, 100, 'the boundary freezes turn TTFT: 1100 against turn start 1000')
  assert.equal(atBoundary.phase, 'streaming', 'the live machine leaves Pending at the boundary')
  assert.equal(atBoundary.activePhase, 'output', 'and the streaming phase identity is known immediately')
  assert.equal(atBoundary.episodeElapsedMs, null,
    'no magnitude sample exists, so no TPS episode clock has started')
  assert.equal(atBoundary.episodeSampleCount, 0, 'and the episode holds no fabricated sample')
  assert.equal(atBoundary.tps, null, 'no rate can be published from boundary evidence alone')
  assert.equal(atBoundary.tpsQuality, 'unavailable')
  assert.equal(store.liveSnapshot('s-942-a', 1_150).episodeElapsedMs, null,
    'the clock does not advance while no magnitude is open')
  assert.equal(store.liveSnapshot('s-942-a', 1_600).episodeElapsedMs, null)
  assert.equal(store.liveSnapshot('s-942-a', 1_600).tps, null)

  assert.equal(record.firstTokenMs, 1_100, 'the settled record keeps the frozen boundary')
  assert.equal(attempt.samples.length, 0, 'and no magnitude is invented to go with it')

  const settled = close(store, record, 1_600)
  assert.equal(settled.ttftMs, 100, 'the completed card reports the TTFT the live pill froze')
  assert.equal(settled.curve.peakTps, null, 'a boundary-only turn publishes no peak')
  assert.equal(allPoints(settled).some(point => Number.isFinite(point.tps)), false,
    'no vertex of a boundary-only turn carries a rate')
})

/* ------------------------ Case B — boundary then same-phase magnitude samples */

test('CASE B — the 100/200/250/300 fixture: live and completed share one episode origin', () => {
  /**
   * The deterministic fixture of the phase brief. Baseline `6506bd0` measured
   * live `origin 100 / elapsed 200 / TPS 1500` against the curve's
   * `origin 200 / elapsed 100 / TPS 3000`.
   *
   * The curve's own coordinate is attempt-local: `compressAttempts` sets an
   * attempt's local zero to its **first generated sample** (`src/core/time-axis.js`),
   * which for this fixture is the sample at `t = 200`. The parity assertions below
   * therefore compare the same interval twice: the live snapshot's absolute
   * figures against the curve vertex's figures translated through that documented
   * local zero.
   */
  const SESSION = 's-942-b'
  const BOUNDARY_MS = 100
  const SAMPLES_MS = [200, 250, 300]
  const LOCAL_ZERO_MS = SAMPLES_MS[0]
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  assert.equal(store.acceptChunk(record, attempt, { timeMs: BOUNDARY_MS, chunk: NAME_ONLY_DELTA }), null)
  assert.equal(store.liveSnapshot(SESSION, BOUNDARY_MS).episodeElapsedMs, null,
    'the boundary at 100 ms starts no episode clock')
  assert.equal(store.liveSnapshot(SESSION, 150).episodeElapsedMs, null)

  for (const timeMs of SAMPLES_MS) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }

  const live = store.liveSnapshot(SESSION, 300)
  const meter = meterOf(store, SESSION)
  /**
   * Read the meter's own fields **now**: closing the turn below clears the
   * episode, and this test compares the live episode against the completed one.
   */
  const liveOriginMs = meter.episodeStartMs
  const liveMass = meter.episodeTokenMass
  assert.equal(live.ttftMs, 100, 'TTFT origin stays the boundary instant')
  assert.equal(liveOriginMs, 200, 'the TPS episode origin is the first magnitude sample')
  assert.notEqual(liveOriginMs, BOUNDARY_MS,
    'the boundary is not the sample-based denominator origin')
  assert.equal(live.episodeElapsedMs, 100, 'elapsed is measured from that origin: 300 - 200')
  assert.equal(live.episodeSampleCount, 3)
  assert.equal(liveMass, 300)
  assert.equal(live.tps, 3000, '300 tokens over the episode\'s own 100 ms')
  assert.equal(live.fallback, false)

  store.settleAttempt(attempt, settle(300))
  const settled = close(store, record, 300)
  const trace = settled.curve.attempts.find(entry => entry.attemptId === 'a1')
  assert.equal(trace.samples.length, 3, 'the boundary contributes no sample to the completed stream')
  assert.deepEqual(trace.samples.map(sample => sample.timeMs), SAMPLES_MS,
    'the curve streams exactly the three magnitude-bearing samples')

  const vertex = trace.points.find(point => point.localMs === 300 - LOCAL_ZERO_MS)
  assert.ok(vertex !== undefined, 'the curve samples the instant the live pill was read at')
  assert.equal(vertex.tps, 3000, 'the curve publishes the rate the live pill published')
  assert.equal(vertex.episodeElapsedMs, 100)
  assert.equal(vertex.episodeSampleCount, 3)
  assert.equal(vertex.episodeMass, 300)
  assert.equal(LOCAL_ZERO_MS + vertex.episodeStartMs, 200,
    'translated through the curve\'s local zero, the completed episode origin is the same 200 ms instant')
  /**
   * The translation is taken from the trace's own evidence — its first sample's
   * absolute timestamp is the instant its local zero denotes — so the parity does
   * not depend on the fixture constant above.
   */
  assert.equal(trace.samples[0].timeMs, LOCAL_ZERO_MS, 'the attempt\'s local zero is its first generated sample')
  assert.equal(trace.samples[0].timeMs + vertex.episodeStartMs, liveOriginMs,
    'the curve\'s episode origin and the live meter\'s are the same instant on the turn clock')
  assert.equal(settled.curve.peakTps, 3000)

  /** The parity itself, stated as equalities rather than as two coincidences. */
  assert.equal(live.episodeElapsedMs, vertex.episodeElapsedMs)
  assert.equal(live.episodeSampleCount, vertex.episodeSampleCount)
  assert.equal(liveMass, vertex.episodeMass)
  assert.equal(live.tps, vertex.tps)
})

/* ---------------------- Case C — reasoning -> boundary-only output -> output */

test('CASE C — a boundary-only phase transition is immediate and opens no output clock', () => {
  /**
   * The reasoning episode must end at the boundary and the output episode must
   * begin at its first output magnitude sample. Baseline `6506bd0` opened the
   * output episode at the boundary (120 ms), which also armed the first-output
   * guard there: at 200 ms the pill republished the *reasoning* rate as a
   * fallback for an output episode that had produced nothing yet.
   */
  const SESSION = 's-942-c'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  assert.equal(store.liveSnapshot(SESSION, 100).tps, 3000,
    'the reasoning episode publishes its own 300 tokens over 100 ms')

  store.acceptChunk(record, attempt, { timeMs: 120, chunk: NAME_ONLY_DELTA })
  const atBoundary = store.liveSnapshot(SESSION, 120)
  assert.equal(atBoundary.activePhase, 'output', 'the phase identity changes immediately')
  assert.equal(atBoundary.episodeElapsedMs, null, 'and no output TPS clock is started')
  assert.equal(atBoundary.episodeSampleCount, 0)
  assert.equal(meterOf(store, SESSION).episodeTokenMass, 0, 'the reasoning numerator does not bridge')
  assert.equal(atBoundary.tps, null,
    'the reasoning rate is not silently extended through an output phase that has produced nothing')
  assert.equal(atBoundary.fallback, false)
  assert.equal(store.liveSnapshot(SESSION, 200).tps, null, 'and still not at 200 ms')

  for (const timeMs of [300, 350, 400]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  const live = store.liveSnapshot(SESSION, 400)
  assert.equal(meterOf(store, SESSION).episodeStartMs, 300,
    'the first output magnitude sample opens the output episode')
  assert.equal(live.episodeElapsedMs, 100)
  assert.equal(live.episodeSampleCount, 3)
  assert.equal(live.tps, 3000, '300 output tokens over 100 ms; a bridge from reasoning would read 6000')
})

/* -------------------------- Case C2 — where the first-output guard is anchored */

test('CASE C2 — the first-output guard is anchored at the output episode\'s magnitude origin', () => {
  /**
   * §15's guard is "the first 1000 ms of an output episode". With the episode
   * origin defined as its first magnitude sample, the guard window starts there
   * and not at a boundary that opened no episode — otherwise a boundary-only
   * instant would still define an output clock, which is the defect this phase
   * removes. The guard itself is preserved: it still stands in for a warming
   * output episode and still expires after `FIRST_OUTPUT_GUARD_MS`.
   */
  const SESSION = 's-942-c2'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  assert.equal(store.liveSnapshot(SESSION, 100).tps, 3000, 'the reasoning rate is published and remembered')

  store.acceptChunk(record, attempt, { timeMs: 120, chunk: NAME_ONLY_DELTA })
  assert.equal(store.liveSnapshot(SESSION, 1_250).fallback, false,
    'with no output magnitude there is no output episode to guard')

  store.acceptChunk(record, attempt, { timeMs: 300, chunk: outputDelta(100) })
  const guarded = store.liveSnapshot(SESSION, 350)
  assert.equal(guarded.fallback, true, 'inside the guard: the output episode is warming')
  assert.equal(guarded.tps, 3000, 'the last positive reasoning rate stands in')

  assert.equal(store.liveSnapshot(SESSION, 1_250).fallback, true,
    '950 ms after the episode\'s own origin the guard still applies')
  const expired = store.liveSnapshot(SESSION, 1_301)
  assert.equal(expired.fallback, false, 'one millisecond past FIRST_OUTPUT_GUARD_MS it is gone')
  assert.equal(expired.tps, null)
})

/* ------------------- Case D — a same-phase boundary inside an active episode */

test('CASE D — a same-phase boundary does not reset a valid output episode', () => {
  /**
   * The boundary's role here is TTFT/state evidence only. The episode that is
   * already magnitude-open keeps its origin, mass and sample count, live and in
   * the completed curve.
   */
  const SESSION = 's-942-d'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  for (const timeMs of [200, 250, 300]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  const before = store.liveSnapshot(SESSION, 300)
  assert.equal(meterOf(store, SESSION).episodeStartMs, 200)
  assert.equal(before.tps, 3000)

  store.acceptChunk(record, attempt, { timeMs: 350, chunk: NAME_ONLY_DELTA })
  const after = store.liveSnapshot(SESSION, 350)
  assert.equal(meterOf(store, SESSION).episodeStartMs, 200, 'the origin is untouched')
  assert.equal(meterOf(store, SESSION).episodeTokenMass, 300, 'the numerator is untouched')
  assert.equal(after.episodeSampleCount, 3, 'the sample count is untouched')
  assert.equal(after.episodeElapsedMs, 150, 'the episode clock simply advanced')

  for (const timeMs of [400, 450]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(200) })
  }
  const live = store.liveSnapshot(SESSION, 450)
  assert.equal(meterOf(store, SESSION).episodeStartMs, 200)
  assert.equal(live.episodeElapsedMs, 250)
  assert.equal(live.episodeSampleCount, 5)
  assert.equal(live.tps, 2800, '700 tokens over the episode\'s own 250 ms')

  store.settleAttempt(attempt, settle(450))
  const settled = close(store, record, 450)
  const trace = settled.curve.attempts.find(entry => entry.attemptId === 'a1')
  const vertex = trace.points.find(point => point.localMs === 250)
  assert.equal(vertex.episodeElapsedMs, 250, 'the curve sees one continuous output episode')
  assert.equal(vertex.episodeSampleCount, 5)
  assert.equal(vertex.episodeMass, 700)
  assert.equal(vertex.tps, live.tps, 'live and completed agree across a same-phase boundary too')
})

/* ------------------------------------ Case E — the provider-counter baseline */

test('CASE E1 — usage becoming known after the boundary still anchors the real episode start', () => {
  /**
   * §4 case A of the brief. The boundary happens with no usage known, and the
   * counters arrive in between it and the first output magnitude sample. The
   * episode that the magnitude sample opens must be able to take the baseline the
   * provider-counter contract requires — baseline `6506bd0` could not, because it
   * had already opened the episode with `episodeUsageBaseline: null` and
   * `observeUsage` deliberately never explains an episode retroactively.
   *
   * With the fix the numerator is the counter delta since the **episode's** own
   * origin (`630 - 600 = 30` over 100 ms) rather than the shape mass, which is the
   * observable proof that a baseline exists and belongs to that origin.
   */
  const SESSION = 's-942-e1'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  assert.equal(store.liveSnapshot(SESSION, 100).tps, 3000,
    'the reasoning episode opened before any counter was known, so it keeps its shape mass')

  store.acceptChunk(record, attempt, { timeMs: 120, chunk: NAME_ONLY_DELTA })
  store.acceptChunk(record, attempt, {
    timeMs: 150,
    chunk: { type: 'usage', usage: { outputTokens: 900, reasoningTokens: 300 } },
  })
  assert.equal(meterOf(store, SESSION).episodeStartMs, null,
    'a usage chunk is not a sample and starts no episode clock either')

  for (const timeMs of [200, 250]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  assert.deepEqual(meterOf(store, SESSION).episodeUsageBaseline, { phase: 'output', counter: 600 },
    'the first output magnitude sample takes the baseline the counters support')

  store.acceptChunk(record, attempt, {
    timeMs: 280,
    chunk: { type: 'usage', usage: { outputTokens: 950, reasoningTokens: 320 } },
  })
  store.acceptChunk(record, attempt, { timeMs: 300, chunk: outputDelta(100) })

  const live = store.liveSnapshot(SESSION, 300)
  assert.equal(meterOf(store, SESSION).episodeStartMs, 200)
  assert.deepEqual(meterOf(store, SESSION).episodeMass(), { mass: 30, source: 'provider-counter' })
  assert.equal(live.episodeElapsedMs, 100, 'numerator and denominator share the [200, 300] interval')
  assert.equal(live.episodeSampleCount, 3)
  assert.equal(live.tps, 300, '30 counter tokens over the episode\'s own 100 ms')
})

test('CASE E2 — usage known before the boundary is re-baselined at the magnitude origin', () => {
  /**
   * §4 case B of the brief, and the sharpest form of the temporal misalignment.
   *
   * Baseline `6506bd0` took the baseline at the boundary (320 ms) from the
   * counters then known (`outputTotal 600`) and then measured the counters again
   * at 500 ms, so its numerator `670 - 600 = 70` spanned `[320, 500]` while its
   * denominator spanned `[320, 500]` too — self-consistent, but describing an
   * interval the completed curve never measures, because the curve's episode
   * begins at the first output magnitude sample (400 ms) and its own numerator
   * there is `670 - 660 = 10`.
   *
   * After the fix the episode that opens at 400 ms carries the counters known at
   * that instant (`outputTotal 660`), so both the live numerator and the live
   * denominator describe `[400, 500]` — the same interval the curve measures.
   */
  const SESSION = 's-942-e2'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })
  const usage = (timeMs, outputTokens, reasoningTokens) => store.acceptChunk(record, attempt, {
    timeMs,
    chunk: { type: 'usage', usage: { outputTokens, reasoningTokens } },
  })

  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  for (const timeMs of [150, 200]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  usage(250, 900, 300)
  store.acceptChunk(record, attempt, { timeMs: 300, chunk: reasoningDelta(100) })
  assert.equal(store.liveSnapshot(SESSION, 300).tps, 2000, '300 reasoning shape tokens over 150 ms')

  store.acceptChunk(record, attempt, { timeMs: 320, chunk: NAME_ONLY_DELTA })
  assert.equal(meterOf(store, SESSION).episodeStartMs, null,
    'the boundary re-baselines nothing: there is no open episode to attach a counter to')
  assert.equal(meterOf(store, SESSION).episodeUsageBaseline, null)

  usage(350, 1000, 340)
  store.acceptChunk(record, attempt, { timeMs: 400, chunk: outputDelta(100) })
  assert.deepEqual(meterOf(store, SESSION).episodeUsageBaseline, { phase: 'output', counter: 660 },
    'the baseline is the counter snapshot known when the magnitude episode opened, not the boundary\'s')

  usage(420, 1030, 360)
  store.acceptChunk(record, attempt, { timeMs: 450, chunk: outputDelta(100) })
  store.acceptChunk(record, attempt, { timeMs: 500, chunk: outputDelta(100) })

  const live = store.liveSnapshot(SESSION, 500)
  assert.equal(meterOf(store, SESSION).episodeStartMs, 400)
  assert.deepEqual(meterOf(store, SESSION).episodeMass(), { mass: 10, source: 'provider-counter' })
  assert.equal(live.episodeElapsedMs, 100, 'the denominator is the same [400, 500] interval')
  assert.equal(live.episodeSampleCount, 3)
  assert.equal(live.tps, 100, '10 counter tokens over the episode\'s own 100 ms')
  assert.notEqual(meterOf(store, SESSION).episodeUsageBaseline.counter, 600,
    'the pre-boundary counter is not the episode\'s baseline')
})

test('CASE E3 — an episode that opens with no counters known keeps its shape mass', () => {
  /**
   * The control for E1/E2: the provider-counter policy itself is unchanged. A
   * usage chunk arriving *inside* an episode still never explains it
   * retroactively.
   */
  const SESSION = 's-942-e3'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })

  for (const timeMs of [0, 50, 100]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(100) })
  }
  store.acceptChunk(record, attempt, {
    timeMs: 150,
    chunk: { type: 'usage', usage: { outputTokens: 900, reasoningTokens: 300 } },
  })
  store.acceptChunk(record, attempt, { timeMs: 200, chunk: outputDelta(100) })

  assert.equal(meterOf(store, SESSION).episodeUsageBaseline, null)
  assert.deepEqual(meterOf(store, SESSION).episodeMass(), { mass: 400, source: 'shape' })
  assert.equal(store.liveSnapshot(SESSION, 200).tps, 2000, '400 shape tokens over 200 ms, as before')
})

/* --------------------------------------------- Case F — a retry / new attempt */

test('CASE F — a new attempt resets the episode and never the turn TTFT', () => {
  const SESSION = 's-942-f'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 1_000 })

  for (const timeMs of [1_100, 1_150, 1_200]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: reasoningDelta(100) })
  }
  assert.equal(store.liveSnapshot(SESSION, 1_200).ttftMs, 100, 'the turn TTFT is frozen at 1100')
  assert.equal(store.liveSnapshot(SESSION, 1_200).tps, 3000)

  const retry = store.beginAttempt(record, { attemptId: 'a2', step: 2, startedAtMs: 1_250 })
  const boundary = store.liveSnapshot(SESSION, 1_250)
  assert.equal(boundary.episodeElapsedMs, null, 'the previous episode and its clock are gone')
  assert.equal(boundary.episodeSampleCount, 0)
  assert.equal(boundary.tps, null)
  assert.equal(meterOf(store, SESSION).episodeUsageBaseline, null)
  assert.equal(boundary.ttftMs, 100, 'turn TTFT is turn-level and does not reset with the attempt')

  store.acceptChunk(record, retry, { timeMs: 1_260, chunk: NAME_ONLY_DELTA })
  const afterBoundary = store.liveSnapshot(SESSION, 1_260)
  assert.equal(afterBoundary.episodeElapsedMs, null, 'a boundary in the new attempt opens no clock')
  assert.equal(afterBoundary.episodeSampleCount, 0)
  assert.equal(afterBoundary.ttftMs, 100)

  for (const timeMs of [1_300, 1_350, 1_400]) {
    store.acceptChunk(record, retry, { timeMs, chunk: outputDelta(100) })
  }
  const live = store.liveSnapshot(SESSION, 1_400)
  assert.equal(meterOf(store, SESSION).episodeStartMs, 1_300, 'the retry opens its own episode')
  assert.equal(live.episodeElapsedMs, 100)
  assert.equal(live.episodeSampleCount, 3)
  assert.equal(live.tps, 3000)
  assert.equal(live.ttftMs, 100, 'and the retry still cannot redefine the turn\'s first token')
  assert.equal(attempt.samples.length, 3, 'the first attempt keeps its own evidence')
  assert.equal(retry.samples.length, 3)
})

/* ------------------------------------ Case G — the Phase 9.4 gates are kept */

test('CASE G — the shared publication gates are unchanged and the former spikes stay gone', () => {
  assert.equal(MIN_RATE_SAMPLES, 3)
  assert.equal(MIN_RATE_ELAPSED_MS, 100)
  assert.equal(MIN_WARMUP_SAMPLES, MIN_RATE_SAMPLES)

  /**
   * §16 CASE 6 as a compact re-proof: the reasoning episode warms up on its own
   * ladder and the phase switches to output at 299 ms — one millisecond before the
   * old attempt-global vertex — where the released tree published a 500 000
   * tokens/s peak from a 1 ms denominator.
   */
  const SESSION = 's-942-g'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: reasoningDelta(60) })
  store.acceptChunk(record, attempt, { timeMs: 150, chunk: reasoningDelta(60) })
  store.acceptChunk(record, attempt, { timeMs: 299, chunk: outputDelta(500) })
  for (const timeMs of [400, 500, 600, 700, 800]) {
    store.acceptChunk(record, attempt, { timeMs, chunk: outputDelta(50) })
  }
  store.settleAttempt(attempt, {
    ...settle(900),
    usage: { outputTokens: 870, reasoningTokens: 120 },
  })
  const settled = close(store, record, 900)
  const trace = settled.curve.attempts[0]

  assert.equal(settled.curve.peakTps, 2000, '600 tokens over the episode\'s own 300 ms')
  const published = trace.points.filter(point => Number.isFinite(point.tps))
  assert.ok(published.length > 0)
  for (const point of published) {
    assert.ok(point.episodeElapsedMs >= MIN_RATE_ELAPSED_MS,
      `the rate at ${point.localMs} ms used a ${point.episodeElapsedMs} ms denominator`)
    assert.ok(point.episodeSampleCount >= MIN_RATE_SAMPLES,
      `the rate at ${point.localMs} ms used ${point.episodeSampleCount} samples`)
  }
  assert.equal(published.some(point => point.episodeElapsedMs === 1), false,
    'no one-millisecond denominator survives anywhere')
  assert.equal(trace.peakProvenance.episodeStartMs, 299)
  assert.equal(trace.peakProvenance.elapsedMs, 300)
})

/* ------------------------------------ Case H — an unavailable peak stays null */

test('CASE H — no publishable vertex means a null peak, never a measured zero', () => {
  const SESSION = 's-942-h'
  const { store, record, attempt } = openTurn({ sessionId: SESSION, turnStartMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 100, chunk: NAME_ONLY_DELTA })
  store.settleAttempt(attempt, settle(400))
  const settled = close(store, record, 400)

  assert.equal(settled.curve.peakTps, null)
  const view = curveViewModel(settled)
  assert.equal(view.peak.value, null, 'unavailable is null, distinct from a measured zero')
  assert.equal(view.peak.display, DASH, 'and the card prints an em dash')
  assert.equal(view.peak.x, null)
  assert.equal(view.peak.y, null)

  /** A boundary-only turn has no vertex at all, so nothing can be promoted. */
  assert.equal(allPoints(settled).length, 0)
})

/* ------------------------------------------------ the presentation half (§3) */

test('CASE A/C on the live path — the pill leaves 首响应计时 and warms from the first sample', () => {
  /**
   * The same fixture driven through the real controller, so the presentation
   * consequence is asserted where it is rendered. Baseline `6506bd0`: the boundary
   * froze TTFT correctly, but the warming counter was already 100 ms ahead of the
   * completed curve at the first magnitude sample.
   */
  const SESSION = 's-942-ui'
  const sessions = fakeSessionsService()
  const source = sessions.createSource(SESSION)
  const controller = createController({ sessions })
  assert.equal(controller.attach(SESSION), true)

  const entries = [
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    transientEntry('a1', 1_100, NAME_ONLY_DELTA),
    transientEntry('a1', 1_200, outputDelta(100)),
    transientEntry('a1', 1_250, outputDelta(100)),
    transientEntry('a1', 1_300, outputDelta(100)),
  ]
  const captures = []
  let revision = 0
  let nowMs = 0
  captures.push({ atMs: nowMs, view: controller.project(SESSION, nowMs) })
  for (const entry of entries) {
    nowMs = entry.event.time
    source.appendEntry(entry, (revision += 1))
    captures.push({ atMs: nowMs, view: controller.project(SESSION, nowMs) })
  }

  try {
    const kinds = captures.map(capture => capture.view.kind)
    assert.equal(kinds.includes('ttft'), true, 'the turn opens on the first-response stopwatch')
    const boundaryIndex = kinds.indexOf('warming')
    assert.ok(boundaryIndex > 0, 'the boundary leaves it for the warming presentation')
    assert.equal(kinds.slice(boundaryIndex).includes('ttft'), false,
      'and it never returns to 首响应计时 in this turn')

    const atBoundary = captures[boundaryIndex].view
    assert.equal(atBoundary.samples, 0, 'the boundary contributes no sample')
    assert.equal(atBoundary.counterMs, 0, 'and no episode clock')

    const afterFirstSample = captures[boundaryIndex + 1].view
    assert.equal(afterFirstSample.kind, 'warming')
    assert.equal(afterFirstSample.counterMs, 0,
      'the episode clock starts at the first magnitude sample, not 100 ms earlier')

    const live = controller.store.liveSnapshot(SESSION, 1_300)
    assert.equal(live.ttftMs, 100)
    assert.equal(live.tps, 3000, '300 tokens over the episode\'s own 100 ms')
    assert.equal(kinds.at(-1), 'streaming')
  } finally {
    controller.dispose()
  }
})
