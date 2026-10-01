/**
 * Phase 9.4.4 — a durable settlement reconciles the transient attempt it settles.
 *
 * ## The defect this file freezes
 *
 * Phase 9.4.3 made a non-magnitude phase cut first-class *attempt* evidence, so a
 * completed card could close the outgoing TPS episode where the live pill had. The
 * repair covered both reconstruction planes — but not the **mixed** one, which is
 * the plane a reload actually produces:
 *
 *     partial transient attempt already exists      (the tail after the reload)
 *   + authoritative durable settlement with its
 *     full decoded compact stream                   (the whole attempt)
 *
 * On `eb45c26` the controller correlated those two correctly and then settled the
 * existing attempt with `store.settleAttempt(attempt, …)` alone. `event.decoded`
 * was ignored. The attempt therefore kept only the transient tail it happened to
 * have seen, and the completed card disagreed with the same turn's full-evidence
 * card on every stream-derived metric.
 *
 * Measured on `eb45c26` through the real wire
 * (`SessionEventFeed` -> live controller -> `TurnTelemetryStore`), for one attempt
 * whose authoritative stream is `turn/start 0`, reasoning samples `0/50/100`, a
 * name-bearing `tool-call-delta` with an empty `argumentsDelta` at `120`, output
 * samples `300/350/400`, settlement at `400` — with the replacement window holding
 * only the post-cut transient tail:
 *
 *     attempt.samples    300/350/400          (3 of 6; the reasoning half is gone)
 *     attempt.phaseCuts  []                   (the 120 boundary is gone)
 *     record.firstTokenMs 300                 (should be 0)
 *     curve durationMs   100                  (should be 400)
 *     reasoningMs        0, reasoningTps null (should be 120 and 2500)
 *     outputMs           100, outputTps 3000
 *     curve vertices     2, one `output` run 0..100
 *     peakTps            3000
 *
 * ## The contract
 *
 *     A durable settlement carries the authoritative compact stream for its
 *     attempt. When the controller already holds a transient attempt that the
 *     settlement is uniquely correlated to, the durable evidence **reconciles**
 *     that attempt: its stream-derived evidence becomes one decode of the
 *     durable stream, and its transient identity and lifecycle are preserved.
 *
 * The chosen strategy is **authoritative replacement** of the stream-derived
 * fields (`samples`, `phaseCuts`) plus the turn's one-way first-token upgrade —
 * never an array union. See `TurnTelemetryStore.reconcileAttemptStream` for why:
 * the transient and durable planes have no shared per-delta identity, so a union
 * could double-count an overlapped sample and could not order a same-timestamp
 * pair. Replacement is idempotent, cannot duplicate a cut, and cannot reorder a
 * delta.
 *
 * ## What this file drives, and what it deliberately does not
 *
 * Every case goes through the real wire: `fakeSessionsService` publishes real
 * `SessionEventWindow` changes, `SessionEventFeed` normalizes them, the live
 * controller routes them, and `TurnTelemetryStore` records them. `replace` is the
 * actual `SessionEventChange{kind:'replace'}` rebaseline, not a hand-built partial
 * store — §9 of the phase brief asks for exactly that, because a hand-built store
 * would not exercise the generation boundary the audit found missing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { materializeReconstructedTurn } from '../src/dsh/reconstruction.js'
import { turnKey } from '../src/core/types.js'
import { durableEntry, fakeSessionsService, transientEntry } from './helpers/live-replay.js'

/* ----------------------------------------------------------------- fixtures */

/** A generated delta carrying `tokens` heuristic tokens (four characters each). */
const outputDelta = tokens => ({ type: 'text-delta', index: 0, text: 'x'.repeat(tokens * 4) })
const reasoningDelta = tokens => ({ type: 'reasoning-delta', index: 0, text: 'x'.repeat(tokens * 4) })

/** A name-bearing tool-call delta whose argument fragment has not arrived yet. */
const NAME_ONLY_DELTA = Object.freeze({
  type: 'tool-call-delta',
  index: 0,
  id: 'call_1',
  name: 'pwsh',
  argumentsDelta: '',
})

/**
 * The authoritative compact stream of the principal attempt: three reasoning
 * samples, a non-magnitude phase cut, three output samples.
 *
 * The boundary is a raw `chunk` record rather than a run member, and that is not
 * an accident of the fixture: a run member is always a non-empty string, and a
 * non-empty argument fragment *is* a magnitude. The one chunk shape that is
 * first-token evidence without magnitude can therefore only travel as a raw
 * record — which is exactly what DSH's accumulator emits for it.
 */
function principalStream() {
  return [
    { type: 'reasoning-chunks', time0: 0, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] },
    { type: 'chunk', time: 120, chunk: NAME_ONLY_DELTA },
    { type: 'text-chunks', time0: 300, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] },
  ]
}

/** The same attempt with no phase cut: one phase, one continuous episode. */
function overlapStream() {
  return [
    { type: 'reasoning-chunks', time0: 0, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] },
    { type: 'text-chunks', time0: 300, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] },
  ]
}

const text = tokens => 'x'.repeat(tokens * 4)

/** The complete transient plane of the principal attempt. */
function fullTransient(attemptId = 'a1', { turn = 1, step = 1 } = {}) {
  return [
    transientEntry(attemptId, 0, reasoningDelta(100), { turn, step }),
    transientEntry(attemptId, 50, reasoningDelta(100), { turn, step }),
    transientEntry(attemptId, 100, reasoningDelta(100), { turn, step }),
    transientEntry(attemptId, 120, NAME_ONLY_DELTA, { turn, step }),
    transientEntry(attemptId, 300, outputDelta(100), { turn, step }),
    transientEntry(attemptId, 350, outputDelta(100), { turn, step }),
    transientEntry(attemptId, 400, outputDelta(100), { turn, step }),
  ]
}

/** Only what a window beginning after the phase cut can still contain. */
function tailTransient(attemptId = 'a1', { turn = 1, step = 1 } = {}) {
  return [
    transientEntry(attemptId, 300, outputDelta(100), { turn, step }),
    transientEntry(attemptId, 350, outputDelta(100), { turn, step }),
    transientEntry(attemptId, 400, outputDelta(100), { turn, step }),
  ]
}

const turnStartRow = (timeMs = 0, turn = 1) => durableEntry('turn/start', 1, timeMs, { turn })
const turnEndRow = (timeMs = 400, turn = 1) => durableEntry(
  'turn/end',
  99,
  timeMs,
  { turn, reason: { kind: 'completed' } },
)

function settlementRow({
  seq = 2,
  timeMs = 400,
  turn = 1,
  step = 1,
  stream,
  type = 'assistant/message',
  usage,
} = {}) {
  const data = { turn, step, stream: stream ?? principalStream() }
  if (usage !== undefined) data.usage = usage
  return durableEntry(type, seq, timeMs, data)
}

/* -------------------------------------------------------------- wire driver */

/**
 * A controller attached to one session's fake event source, driven the way the
 * browser drives it: `replace` publishes a whole window (a reload/rebaseline),
 * `push` appends one live tail entry, `settle` is the fold's atomic attempt
 * retirement.
 */
function attached(sessionId) {
  const sessions = fakeSessionsService()
  const source = sessions.createSource(sessionId)
  const controller = createController({ sessions })
  assert.equal(controller.attach(sessionId), true, 'the fake binding must be resolvable')
  let revision = 1
  return {
    sessionId,
    sessions,
    source,
    controller,
    push(entry) { source.appendEntry(entry, (revision += 1)); return controller },
    replace(entries) { source.replaceEntries(entries, (revision += 1)); return controller },
    settle(attemptId, entry) { source.settleAssistant(attemptId, entry, (revision += 1)); return controller },
    dispose() { controller.dispose() },
  }
}

const recordOf = (harness, turn = 1) => harness.controller.store.turns.get(turnKey(harness.sessionId, turn))
const attemptOf = (harness, index = 0, turn = 1) => recordOf(harness, turn)?.attempts[index] ?? null

/* ------------------------------------------------------- the parity surface */

/**
 * Every metric §7 enumerates, as plain data, with reconstruction-local attempt
 * identity projected out.
 *
 * Attempt identity is the one thing the two planes cannot agree on by
 * construction: a transient attempt is keyed by the client fold's process-local
 * `attemptId`, a restored one by its settlement sequence. Everything else is a
 * function of the evidence and must be equal.
 */
function paritySurface(harness, turn = 1) {
  const record = recordOf(harness, turn)
  assert.notEqual(record, undefined, 'the turn must have a record')
  const settled = record.settled
  assert.notEqual(settled, null, 'the turn must be settled')
  return {
    startMs: record.startMs ?? null,
    firstTokenMs: record.firstTokenMs ?? null,
    settledFirstTokenMs: settled.firstTokenMs ?? null,
    ttftMs: settled.ttftMs ?? null,
    attempts: record.attempts.map(attempt => ({
      step: attempt.step ?? null,
      settlementKind: attempt.settlementKind,
      surfaceCommitted: attempt.surfaceCommitted === true,
      attemptOutcome: attempt.attemptOutcome,
      settledAtMs: attempt.settledAtMs ?? null,
      settlementSeq: attempt.settlementSeq ?? null,
      usage: attempt.usage ?? null,
      usageSource: attempt.usageSource ?? null,
      samples: attempt.samples.map(sample => ({
        timeMs: sample.timeMs,
        tokens: sample.tokens,
        phase: sample.phase,
      })),
      phaseCuts: (attempt.phaseCuts ?? []).map(cut => ({ timeMs: cut.timeMs, phase: cut.phase })),
    })),
    durationMs: settled.curve.durationMs,
    segments: settled.curve.segments.map(segment => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      sampleCount: segment.sampleCount,
    })),
    reasoningMs: settled.reasoningMs ?? null,
    outputMs: settled.outputMs ?? null,
    reasoningTps: settled.reasoningTps ?? null,
    outputTps: settled.outputTps ?? null,
    peakTps: settled.curve.peakTps ?? null,
    phasePeaks: settled.curve.series.map(entry => ({ key: entry.key, present: entry.present, peak: entry.peak ?? null })),
    curveQuality: settled.curve.quality,
    qualityAxes: settled.curve.qualityAxes,
    generated: {
      generatedTokens: settled.generatedTokens ?? null,
      reasoningTokens: settled.reasoningTokens ?? null,
      nonReasoningTokens: settled.nonReasoningTokens ?? null,
      tokenTotalQuality: settled.quality?.tokenTotalQuality ?? null,
      phaseSplitQuality: settled.quality?.phaseSplitQuality ?? null,
      calibrated: settled.curve.source.calibrated,
      calibrationCoverage: settled.curve.source.calibrationCoverage,
    },
    traces: settled.curve.attempts.map(trace => ({
      startMs: trace.startMs,
      endMs: trace.endMs,
      localEndMs: trace.localEndMs,
      durationMs: trace.durationMs,
      sampleCount: trace.sampleCount,
      tokens: trace.tokens,
      calibratedTokens: trace.calibratedTokens ?? null,
      cuts: trace.cuts.map(cut => ({ timeMs: cut.timeMs, localMs: cut.localMs, phase: cut.phase })),
      points: trace.points.map(point => ({
        timeMs: point.timeMs,
        localMs: point.localMs,
        activePhase: point.activePhase ?? null,
        tps: point.tps ?? null,
        episodeStartMs: point.episodeStartMs ?? null,
        episodeElapsedMs: point.episodeElapsedMs ?? null,
        episodeSampleCount: point.episodeSampleCount ?? null,
        episodeMass: point.episodeMass ?? null,
        rateUnavailableReason: point.rateUnavailableReason ?? null,
      })),
      visualRuns: trace.runs.map(run => ({
        phase: run.phase,
        startIndex: run.startIndex,
        endIndex: run.endIndex,
        startMs: run.startMs,
        endMs: run.endMs,
        pointCount: run.pointCount,
        peak: run.peak ?? null,
      })),
    })),
  }
}

/** The sample stream of one attempt as `timeMs:tokens:phase` strings. */
const sampleKey = attempt => attempt.samples.map(sample => `${sample.timeMs}:${sample.tokens}:${sample.phase}`)

/* =========================================================================
 * PRINCIPAL — the mixed path against the full-evidence reference
 * ========================================================================= */

/**
 * The reload/rebaseline scenario: generation 1 holds the complete window, the
 * replacement window holds only the post-cut tail, and the durable settlement
 * then arrives with the whole stream.
 */
function mixedHarness(sessionId, { withTurnStart = false } = {}) {
  const harness = attached(sessionId)
  harness.replace([...fullTransient()])
  harness.replace([...(withTurnStart ? [turnStartRow(0)] : []), ...tailTransient()])
  harness.push(settlementRow())
  harness.push(turnEndRow())
  return harness
}

/**
 * The full-evidence control for the same scenario: the replacement window is
 * itself complete, so the transient plane alone already holds every delta and the
 * boundary. Same wire, same settlement, same `turn/end` — the only difference is
 * how much of the stream the reload could still see.
 */
function referenceHarness(sessionId, { withTurnStart = false } = {}) {
  const harness = attached(sessionId)
  harness.replace([...fullTransient()])
  harness.replace([...(withTurnStart ? [turnStartRow(0)] : []), ...fullTransient()])
  harness.push(settlementRow())
  harness.push(turnEndRow())
  return harness
}

test('PRINCIPAL — reload after the phase cut: the durable settlement completes the transient attempt', () => {
  const mixed = mixedHarness('s-944-mixed')
  const reference = referenceHarness('s-944-reference')

  const attempt = attemptOf(mixed)
  assert.notEqual(attempt, null, 'the replacement window adopted the turn and opened its attempt')

  /**
   * The evidence the settlement restored. The attempt's sample stream is now one
   * decode of the durable stream — six samples, in stream order, each with its own
   * magnitude — and the boundary is the cut the durable stream declares.
   */
  assert.deepEqual(sampleKey(attempt), [
    '0:100:reasoning',
    '50:100:reasoning',
    '100:100:reasoning',
    '300:100:output',
    '350:100:output',
    '400:100:output',
  ], 'the attempt holds exactly one decode of the authoritative stream')
  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 120, phase: 'output' }],
    'and exactly the cuts that decode declares')
  assert.equal(attempt.samples.every(sample => sample.tokens > 0), true,
    'no sample was invented to carry the boundary')

  /** Identity and lifecycle are the transient attempt's; only the evidence changed. */
  assert.equal(attempt.attemptId, 'a1', 'the correlated attempt keeps its process-local identity')
  assert.equal(attempt.settlementKind, 'message')
  assert.equal(attempt.surfaceCommitted, true)
  assert.equal(attempt.attemptOutcome, 'committed')
  assert.equal(attempt.settledAtMs, 400)
  assert.equal(attempt.settlementSeq, 2)

  /** The turn's TTFT boundary moved back to the durable first token, one-way. */
  assert.equal(recordOf(mixed).firstTokenMs, 0,
    'the earlier authoritative first token replaced the later transient one')
  assert.equal(recordOf(mixed).startMs, null,
    'no `turn/start` was in the replacement window, and none is fabricated')
  assert.equal(recordOf(mixed).settled.ttftMs, null,
    'TTFT stays unknown without a turn start, even though the first token is known')

  /** The completed numbers are the full-evidence numbers. */
  const settled = recordOf(mixed).settled
  assert.equal(settled.curve.durationMs, 400)
  assert.equal(settled.reasoningMs, 120, 'the cut closes reasoning at 120, not at the next output sample')
  assert.equal(settled.outputMs, 100)
  assert.equal(settled.reasoningTps, 2500)
  assert.equal(settled.outputTps, 3000)
  assert.equal(settled.curve.peakTps, 3000)

  const trace = settled.curve.attempts[0]
  assert.deepEqual(trace.cuts, [{ timeMs: 120, localMs: 120, phase: 'output' }])
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps ?? null]), [
    [0, null],
    [100, 3000],
    [120, 2500],
    [300, null],
    [400, 3000],
  ], 'no vertex is measured across the 120 -> 300 gap')
  assert.deepEqual(trace.runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 2],
    ['output', 3, 4],
  ], 'the cut separates the two phase runs')

  /** And the whole surface equals the full-evidence reference, identity projected out. */
  assert.deepEqual(paritySurface(mixed), paritySurface(reference),
    'the mixed path and the full-evidence path must be indistinguishable')
})

test('PRINCIPAL — with the turn boundary observed, TTFT is the durable first token', () => {
  const mixed = mixedHarness('s-944-mixed-start', { withTurnStart: true })
  const reference = referenceHarness('s-944-reference-start', { withTurnStart: true })

  assert.equal(recordOf(mixed).startMs, 0, 'the durable turn/start is in the replacement window')
  assert.equal(recordOf(mixed).firstTokenMs, 0, 'and the durable first token is the boundary chunk at 0')
  assert.equal(recordOf(mixed).settled.ttftMs, 0)
  assert.equal(recordOf(mixed).settled.turnStartMs, 0)
  assert.deepEqual(paritySurface(mixed), paritySurface(reference))
})

test('PRINCIPAL — the mixed path is also the pure-durable path, identity projected out', () => {
  const mixed = mixedHarness('s-944-mixed-durable-parity')

  /**
   * The independent plane: no transient frame ever existed. `turn/end` finds no
   * record and materializes the turn from the durable evidence alone. Phase 9.4.3
   * left this path correct, and the reconciliation must not make the two disagree.
   */
  const store = new TurnTelemetryStore()
  const materialized = materializeReconstructedTurn({
    store,
    sessionId: 's-944-pure-durable',
    turn: 1,
    events: [settlementRow().event, turnEndRow().event],
  })
  const settled = store.endTurn(materialized.record, { timeMs: 400, status: 'completed' })

  const surface = paritySurface(mixed)
  assert.deepEqual(surface.traces, settled.curve.attempts.map(trace => ({
    startMs: trace.startMs,
    endMs: trace.endMs,
    localEndMs: trace.localEndMs,
    durationMs: trace.durationMs,
    sampleCount: trace.sampleCount,
    tokens: trace.tokens,
    calibratedTokens: trace.calibratedTokens ?? null,
    cuts: trace.cuts.map(cut => ({ timeMs: cut.timeMs, localMs: cut.localMs, phase: cut.phase })),
    points: trace.points.map(point => ({
      timeMs: point.timeMs,
      localMs: point.localMs,
      activePhase: point.activePhase ?? null,
      tps: point.tps ?? null,
      episodeStartMs: point.episodeStartMs ?? null,
      episodeElapsedMs: point.episodeElapsedMs ?? null,
      episodeSampleCount: point.episodeSampleCount ?? null,
      episodeMass: point.episodeMass ?? null,
      rateUnavailableReason: point.rateUnavailableReason ?? null,
    })),
    visualRuns: trace.runs.map(run => ({
      phase: run.phase,
      startIndex: run.startIndex,
      endIndex: run.endIndex,
      startMs: run.startMs,
      endMs: run.endMs,
      pointCount: run.pointCount,
      peak: run.peak ?? null,
    })),
  })), 'the reconciled trace equals the purely durable one')
  assert.deepEqual(surface.attempts[0].samples, materialized.record.attempts[0].samples.map(sample => ({
    timeMs: sample.timeMs,
    tokens: sample.tokens,
    phase: sample.phase,
  })))
  assert.equal(surface.reasoningMs, settled.reasoningMs)
  assert.equal(surface.outputMs, settled.outputMs)
  assert.equal(surface.reasoningTps, settled.reasoningTps)
  assert.equal(surface.outputTps, settled.outputTps)
  assert.equal(surface.peakTps, settled.curve.peakTps)
})

/* =========================================================================
 * A — overlap without a phase cut
 * ========================================================================= */

test('CASE A — transient tail overlapping the durable stream duplicates no sample and no token', () => {
  const harness = attached('s-944-a')
  harness.replace([...fullTransient()])
  harness.replace([...tailTransient()])
  harness.push(settlementRow({ stream: overlapStream() }))
  harness.push(turnEndRow())

  const attempt = attemptOf(harness)
  assert.deepEqual(sampleKey(attempt), [
    '0:100:reasoning',
    '50:100:reasoning',
    '100:100:reasoning',
    '300:100:output',
    '350:100:output',
    '400:100:output',
  ], 'the three tail samples the reload saw are not appended to the six the durable stream holds')
  assert.equal(attempt.samples.length, new Set(attempt.samples.map(sample => sample.timeMs)).size,
    'no timestamp appears twice')
  assert.deepEqual(attempt.phaseCuts, [], 'and this stream declares no cut to invent')

  const settled = recordOf(harness).settled
  assert.equal(settled.curve.attempts[0].tokens, 600, 'the generated mass is the stream sum, not the union')
  assert.equal(settled.curve.durationMs, 400)
  /**
   * No cut means no seam: the reasoning episode is the one the samples describe,
   * and it runs until the first output magnitude sample at 300. That stretch is
   * exactly what the cut at 120 shortens in the principal case, which is why this
   * case is the control for "the reconciliation invented no boundary".
   */
  assert.equal(settled.reasoningMs, 300)
  assert.equal(settled.outputMs, 100)
  assert.equal(settled.curve.peakTps, 3000)
  /**
   * With no cut the two phase runs meet on one **shared** transition vertex, which
   * is the documented no-cut geometry. The principal case is the contrast: there,
   * the cut ends the reasoning run and the output run opens on its own first
   * magnitude sample, so nothing is drawn across the gap.
   */
  assert.deepEqual(settled.curve.attempts[0].runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 2],
    ['output', 2, 4],
  ])
})

/* =========================================================================
 * B — the boundary is visible in both planes
 * ========================================================================= */

test('CASE B — a boundary seen transiently and durably is recorded exactly once', () => {
  const harness = attached('s-944-b')
  harness.replace([...fullTransient()])
  harness.replace([
    transientEntry('a1', 120, NAME_ONLY_DELTA),
    ...tailTransient(),
  ])
  harness.push(settlementRow())
  harness.push(turnEndRow())

  const attempt = attemptOf(harness)
  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 120, phase: 'output' }],
    'replacement cannot double a cut the way a union would')
  assert.equal(attempt.phaseCuts.length, 1)
  assert.deepEqual(sampleKey(attempt), [
    '0:100:reasoning', '50:100:reasoning', '100:100:reasoning',
    '300:100:output', '350:100:output', '400:100:output',
  ], 'the boundary still contributes no sample on either plane')

  const trace = recordOf(harness).settled.curve.attempts[0]
  assert.deepEqual(trace.cuts.map(cut => [cut.timeMs, cut.localMs, cut.phase]), [[120, 120, 'output']],
    'and the completed trace carries it once')
  assert.equal(recordOf(harness).settled.reasoningMs, 120)
})

/* =========================================================================
 * C — the boundary existed only before the reload
 * ========================================================================= */

test('CASE C — a boundary only the pre-reload generation saw is restored by the settlement', () => {
  const harness = attached('s-944-c')
  harness.replace([...fullTransient()])
  harness.replace([...tailTransient()])

  /** Before the settlement, the tail generation has no cut and no reasoning half. */
  const partial = attemptOf(harness)
  assert.deepEqual(partial.phaseCuts, [], 'the replacement window begins after the cut, so it holds none')
  assert.equal(partial.samples.length, 3)
  assert.equal(recordOf(harness).firstTokenMs, 300)
  assert.equal(recordOf(harness).startMs, null)

  harness.push(settlementRow())

  assert.deepEqual(attemptOf(harness).phaseCuts, [{ timeMs: 120, phase: 'output' }],
    'the durable stream restores the boundary the superseded generation had seen')
  assert.equal(attemptOf(harness).samples.length, 6)
  assert.equal(recordOf(harness).firstTokenMs, 0, 'and the earlier authoritative first token')

  harness.push(turnEndRow())
  const settled = recordOf(harness).settled
  assert.equal(settled.reasoningMs, 120, 'the summary charges the 120 -> 300 gap to neither phase')
  assert.equal(settled.outputMs, 100)
  assert.equal(settled.reasoningTps, 2500)
})

/* =========================================================================
 * D — earlier magnitude existed only before the reload
 * ========================================================================= */

test('CASE D — magnitude only the pre-reload generation saw is restored, and reaches summary and curve', () => {
  const harness = attached('s-944-d')
  harness.replace([...fullTransient()])
  harness.replace([...tailTransient()])

  assert.equal(recordOf(harness).settled, null)
  harness.push(settlementRow())
  harness.push(turnEndRow())

  const settled = recordOf(harness).settled
  const trace = settled.curve.attempts[0]
  assert.equal(trace.sampleCount, 6, 'the curve is drawn from the restored magnitude')
  assert.equal(trace.tokens, 600)
  assert.equal(trace.startMs, 0, 'the trajectory begins at the restored reasoning sample')
  assert.equal(trace.endMs, 400)
  assert.equal(settled.reasoningTokens === null || settled.reasoningTokens >= 0, true)
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps ?? null]), [
    [0, null], [100, 3000], [120, 2500], [300, null], [400, 3000],
  ], 'including the reasoning episode the tail generation had no evidence for')
  assert.equal(settled.curve.peakTps, 3000)
  assert.equal(settled.curve.qualityAxes.temporalShapeQuality, 'estimated')
})

/* =========================================================================
 * E — the pure durable control
 * ========================================================================= */

test('CASE E — a settlement with no transient rows still restores its own attempt, unchanged', () => {
  const harness = attached('s-944-e')
  harness.push(settlementRow())
  harness.push(turnEndRow())

  const record = recordOf(harness)
  const attempt = record.attempts[0]
  assert.equal(record.attempts.length, 1, 'the durable settlement is restored as its own attempt')
  assert.equal(attempt.attemptId, 'settlement:2',
    'a reconstruction-local identity, derived from the settlement sequence')
  assert.deepEqual(sampleKey(attempt), [
    '0:100:reasoning', '50:100:reasoning', '100:100:reasoning',
    '300:100:output', '350:100:output', '400:100:output',
  ])
  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 120, phase: 'output' }])
  assert.equal(record.startMs, null, 'turn/start was never observed, so no start is invented')
  assert.equal(record.firstTokenMs, 0)
  assert.equal(record.settled.ttftMs, null)

  const trace = record.settled.curve.attempts[0]
  assert.equal(trace.sampleCount, 6)
  assert.equal(trace.tokens, 600)
  assert.deepEqual(trace.cuts.map(cut => [cut.timeMs, cut.localMs, cut.phase]), [[120, 120, 'output']])
  assert.equal(record.settled.reasoningMs, 120)
  assert.equal(record.settled.outputMs, 100)
  assert.equal(record.settled.reasoningTps, 2500)
  assert.equal(record.settled.outputTps, 3000)
  assert.equal(record.settled.curve.peakTps, 3000)
})

/* =========================================================================
 * F — the pure live control
 * ========================================================================= */

test('CASE F — an attempt with no durable stream is untouched by the reconciliation', () => {
  const harness = attached('s-944-f')
  harness.replace([...fullTransient()])
  harness.push(durableEntry('turn/start', 1, 0, { turn: 1 }))
  harness.push(turnEndRow())

  const record = recordOf(harness)
  const attempt = record.attempts[0]
  assert.equal(attempt.attemptId, 'a1')
  assert.equal(attempt.settlementKind, 'none', 'no durable settlement was ever observed')
  assert.equal(attempt.settlementSeq, undefined)
  assert.deepEqual(sampleKey(attempt), [
    '0:100:reasoning', '50:100:reasoning', '100:100:reasoning',
    '300:100:output', '350:100:output', '400:100:output',
  ])
  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 120, phase: 'output' }])
  assert.equal(record.startMs, 0)
  assert.equal(record.firstTokenMs, 0)
  assert.equal(record.settled.ttftMs, 0)

  /**
   * The open attempt's terminal episode has no settlement instant to end it, so
   * its duration is absent rather than fabricated — the `68ba746` semantics this
   * phase must not disturb.
   */
  assert.equal(record.settled.outputMs, 0)
  assert.equal(record.settled.outputTps, null)
  assert.equal(record.settled.reasoningMs, 120)
  assert.equal(record.settled.reasoningTps, 2500)
  assert.equal(record.settled.curve.peakTps, 3000)
})

/* =========================================================================
 * G — retry / multiple attempts
 * ========================================================================= */

test('CASE G — each settlement reconciles only the attempt it is correlated to', () => {
  const harness = attached('s-944-g')
  harness.replace([
    turnStartRow(0),
    transientEntry('a1', 300, outputDelta(100)),
    transientEntry('a1', 350, outputDelta(100)),
    transientEntry('a1', 400, outputDelta(100)),
    transientEntry('a2', 400, outputDelta(50)),
    transientEntry('a2', 450, outputDelta(50)),
    transientEntry('a2', 500, outputDelta(50)),
  ])

  const before = recordOf(harness)
  assert.equal(before.attempts.length, 2, 'two attempts of one (turn, step) — a retry chain')
  assert.deepEqual(sampleKey(attemptOf(harness, 0)), ['300:100:output', '350:100:output', '400:100:output'])
  assert.deepEqual(sampleKey(attemptOf(harness, 1)), ['400:50:output', '450:50:output', '500:50:output'])

  /** The first attempt is retired with **its own** settlement. */
  harness.settle('a1', settlementRow({ seq: 5 }))

  assert.deepEqual(sampleKey(attemptOf(harness, 0)), [
    '0:100:reasoning', '50:100:reasoning', '100:100:reasoning',
    '300:100:output', '350:100:output', '400:100:output',
  ], 'a1 is reconciled from its own stream')
  assert.deepEqual(attemptOf(harness, 0).phaseCuts, [{ timeMs: 120, phase: 'output' }])
  assert.deepEqual(sampleKey(attemptOf(harness, 1)), ['400:50:output', '450:50:output', '500:50:output'],
    'a2 is not touched by a settlement that names a1')
  assert.deepEqual(attemptOf(harness, 1).phaseCuts, [])

  /** The second attempt is retired with **its own** settlement. */
  harness.settle('a2', settlementRow({
    seq: 6,
    timeMs: 500,
    stream: [{ type: 'text-chunks', time0: 400, index: 0, dt: [50, 50], texts: [text(50), text(50), text(50)] }],
  }))

  assert.deepEqual(sampleKey(attemptOf(harness, 1)), ['400:50:output', '450:50:output', '500:50:output'],
    'a2 keeps its own stream')
  assert.deepEqual(attemptOf(harness, 1).phaseCuts, [])
  assert.equal(attemptOf(harness, 1).settlementSeq, 6)
  assert.deepEqual(sampleKey(attemptOf(harness, 0)), [
    '0:100:reasoning', '50:100:reasoning', '100:100:reasoning',
    '300:100:output', '350:100:output', '400:100:output',
  ], 'and reconciling a2 does not re-open or rewrite a1')

  harness.push(turnEndRow(500))
  const settled = recordOf(harness).settled
  assert.equal(settled.curve.attempts.length, 2)
  assert.deepEqual(settled.curve.attempts.map(trace => trace.tokens), [600, 150])
  assert.deepEqual(settled.curve.attempts.map(trace => trace.sampleCount), [6, 3])
})

/* =========================================================================
 * H — ambiguous correlation
 * ========================================================================= */

test('CASE H — an unprovable correlation is never guessed; the durable restoration policy stands', () => {
  /**
   * Three attempts of one `(turn, step)`, which is what a retry chain produces. The
   * first settlement is appended while the feed still holds an open attempt, so it
   * is correlated by identity; the second then arrives with **no** attempt
   * identity and two unsettled candidates on the same step. The correlation must
   * refuse, and the durable record must be restored as its own attempt rather than
   * merged into either candidate.
   */
  const harness = attached('s-944-h')
  harness.replace([
    turnStartRow(0),
    transientEntry('a1', 300, outputDelta(100)),
    transientEntry('a2', 350, outputDelta(100)),
    transientEntry('a3', 400, outputDelta(100)),
  ])
  assert.equal(recordOf(harness).attempts.length, 3)

  harness.push(settlementRow({ seq: 5 }))
  assert.deepEqual(attemptOf(harness, 2).phaseCuts, [{ timeMs: 120, phase: 'output' }],
    'the correlated attempt was reconciled')
  assert.equal(attemptOf(harness, 2).samples.length, 6)

  harness.push(settlementRow({ seq: 6, stream: overlapStream() }))

  const record = recordOf(harness)
  assert.equal(record.attempts.length, 4, 'the ambiguous settlement restored its own attempt')
  const restored = record.attempts[3]
  assert.notEqual(restored.attemptId, 'a1')
  assert.notEqual(restored.attemptId, 'a2')
  assert.equal(restored.attemptId, 'durable:6',
    'the durable-restoration identity policy is unchanged')
  assert.deepEqual(sampleKey(restored), [
    '0:100:reasoning', '50:100:reasoning', '100:100:reasoning',
    '300:100:output', '350:100:output', '400:100:output',
  ])
  assert.deepEqual(sampleKey(attemptOf(harness, 0)), ['300:100:output'],
    'no candidate was guessed into, and neither was rewritten')
  assert.deepEqual(sampleKey(attemptOf(harness, 1)), ['350:100:output'])
  assert.deepEqual(attemptOf(harness, 0).phaseCuts, [])
  assert.deepEqual(attemptOf(harness, 1).phaseCuts, [])

  const counters = harness.controller.diagnostics(harness.sessionId).counters
  assert.equal(counters.settlementStreamsReconciled, 1, 'one settlement proved its attempt')
  assert.equal(counters.settlementStreamsUncorrelated, 1, 'one did not, and it is counted rather than silent')
})

/* =========================================================================
 * §9 — the actual `replace` / rebaseline controller regression
 * ========================================================================= */

test('§9 — replace clears the old generation, the new one reconciles, turn/end completes the card', () => {
  const harness = attached('s-944-rebaseline')

  /* 1 — generation 1 observes the whole turn. */
  harness.replace([turnStartRow(0), ...fullTransient()])
  const firstGeneration = recordOf(harness)
  const firstAttempt = attemptOf(harness)
  assert.equal(firstAttempt.samples.length, 6, 'generation 1 saw the complete stream')
  assert.deepEqual(firstAttempt.phaseCuts, [{ timeMs: 120, phase: 'output' }])
  assert.equal(firstGeneration.firstTokenMs, 0)

  /* 2 — the window is replaced: the store is rebaselined, not extended. */
  harness.replace([...tailTransient()])
  const secondGeneration = recordOf(harness)
  assert.notEqual(secondGeneration, firstGeneration,
    '`replace` opens a new generation of evidence rather than reusing the old record')
  assert.equal(secondGeneration.attempts.length, 1, 'the superseded generation contributed no attempt')
  assert.equal(firstAttempt.samples.length, 6, 'and its own record is left exactly as it was')

  /* 3 — the new generation adopts the turn mid-flight and collects only the tail. */
  assert.equal(secondGeneration.startMs, null, 'adopted mid-turn: no turn/start in this window')
  assert.equal(secondGeneration.firstTokenMs, 300, 'the tail generation froze the later first token')
  assert.deepEqual(sampleKey(attemptOf(harness)), ['300:100:output', '350:100:output', '400:100:output'])
  assert.deepEqual(attemptOf(harness).phaseCuts, [], 'and holds no cut: it begins after the boundary')
  assert.equal(secondGeneration.settled, null)

  /* 4 — the authoritative settlement arrives with the complete compact stream. */
  harness.push(settlementRow())
  const reconciled = attemptOf(harness)
  assert.equal(reconciled.attemptId, 'a1', 'the settlement completed the attempt the reload had opened')
  assert.equal(secondGeneration.attempts.length, 1, 'no second attempt was created for it')
  assert.equal(reconciled.samples.length, 6)
  assert.deepEqual(reconciled.phaseCuts, [{ timeMs: 120, phase: 'output' }])
  assert.equal(secondGeneration.firstTokenMs, 0)

  /* 5 — turn/end publishes the full completed card. */
  harness.push(turnEndRow())
  const settled = secondGeneration.settled
  assert.notEqual(settled, null, 'the terminal boundary produced a card')
  assert.equal(settled.reasoningMs, 120)
  assert.equal(settled.outputMs, 100)
  assert.equal(settled.reasoningTps, 2500)
  assert.equal(settled.outputTps, 3000)
  assert.equal(settled.curve.peakTps, 3000)
  assert.deepEqual(settled.curve.attempts[0].runs.map(run => [run.phase, run.startIndex, run.endIndex]), [
    ['reasoning', 0, 2],
    ['output', 3, 4],
  ])

  /** The card the reload published equals the card the full window published. */
  const reference = referenceHarness('s-944-rebaseline-reference')
  assert.deepEqual(paritySurface(harness), paritySurface(reference))

  harness.dispose()
  reference.dispose()
})

/* =========================================================================
 * §5 — the reconciliation edits the record, never the live presentation
 * ========================================================================= */

test('§5 — the reconciliation does not replay the historical stream through the live meter', () => {
  const harness = attached('s-944-meter')
  harness.replace([...fullTransient()])
  harness.replace([...tailTransient()])

  const before = harness.controller.store.liveSnapshot('s-944-meter', 400)
  assert.equal(before.tps, 3000, 'the live pill measured the tail episode the session actually showed')
  assert.equal(before.activePhase, 'output')
  assert.equal(before.episodeElapsedMs, 100)
  assert.equal(before.episodeSampleCount, 3)

  harness.push(settlementRow())

  /**
   * The live observations already made are historical presentation facts. A
   * replay would have re-opened the reasoning phase the pill had already left and
   * reset the frozen first token, so this is the assertion that fails if the
   * reconciliation is ever routed through `acceptChunk`.
   */
  const after = harness.controller.store.liveSnapshot('s-944-meter', 400)
  assert.deepEqual(after, before, 'the live snapshot is byte-for-byte what it was before the settlement')
  assert.equal(after.tps, 3000)
  assert.equal(after.activePhase, 'output')
  assert.equal(after.episodeElapsedMs, 100, 'the episode clock the live pill opened is untouched')
  assert.equal(after.step, 1)
  assert.equal(after.attemptId, 'a1')
  assert.equal(after.ttftMs, null, 'and no TTFT was invented from a turn start nobody observed')

  /** The record, by contrast, was completed. */
  assert.equal(attemptOf(harness).samples.length, 6)
  assert.deepEqual(attemptOf(harness).phaseCuts, [{ timeMs: 120, phase: 'output' }])
  assert.equal(recordOf(harness).firstTokenMs, 0)
})

/* =========================================================================
 * §6 — the one-way first-token rule
 * ========================================================================= */
test('§6 — durable first-token evidence may move the boundary earlier, never later', () => {
  const harness = attached('s-944-ttft')
  harness.replace([
    transientEntry('a1', 300, outputDelta(100)),
    transientEntry('a1', 350, outputDelta(100)),
    transientEntry('a1', 400, outputDelta(100)),
  ])
  assert.equal(recordOf(harness).firstTokenMs, 300)

  /** An authoritative stream whose first token is later than the live one cannot move it forward. */
  harness.push(settlementRow({
    stream: [{ type: 'text-chunks', time0: 400, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] }],
  }))
  assert.equal(recordOf(harness).firstTokenMs, 300,
    'later durable evidence may not move a recorded first token forward')
  assert.deepEqual(sampleKey(attemptOf(harness)), ['400:100:output', '450:100:output', '500:100:output'],
    'while the stream-derived evidence is still replaced by the authoritative decode')

  /** And the turn start is still unknown, so no TTFT is fabricated from the earlier one. */
  assert.equal(recordOf(harness).startMs, null)
  assert.equal(recordOf(harness).settled, null)
  harness.push(turnEndRow())
  assert.equal(recordOf(harness).settled.ttftMs, null,
    'TTFT remains null while turnStartMs is null')
  assert.equal(recordOf(harness).settled.curve.attempts[0].sampleCount, 3,
    'and the three restored samples are the attempt\'s own')
})

/* =========================================================================
 * The settlement stream that cannot be trusted is not applied
 * ========================================================================= */

test('an incomplete durable decode leaves the transient evidence in place', () => {
  const harness = attached('s-944-incomplete')
  harness.replace([turnStartRow(0), ...tailTransient()])

  /** A stream that lost a record: the decoder cannot claim it is the whole attempt. */
  harness.push(settlementRow({
    stream: [
      { type: 'reasoning-chunks', time0: 0, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] },
      { type: 'chunk', time: 120, chunk: NAME_ONLY_DELTA },
      { type: 'text-chunks', time0: 300, index: 0, dt: [50], texts: [text(100), text(100), text(100)] },
    ],
  }))
  harness.push(turnEndRow())

  const attempt = attemptOf(harness)
  assert.deepEqual(sampleKey(attempt), ['300:100:output', '350:100:output', '400:100:output'],
    'a partial decode is not authoritative and replaces nothing')
  assert.deepEqual(attempt.phaseCuts, [])
  assert.equal(recordOf(harness).firstTokenMs, 300)
  assert.equal(attempt.settlementKind, 'message', 'the settlement itself is still recorded')

  const counters = harness.controller.diagnostics(harness.sessionId).counters
  assert.equal(counters.settlementStreamsReconciled, 0)
  assert.equal(counters.settlementStreamsUncorrelated, 1)
})
