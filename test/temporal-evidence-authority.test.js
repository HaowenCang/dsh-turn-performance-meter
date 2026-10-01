/**
 * Phase 9.4.5 — durable shape authority and reconciliation-outcome provenance.
 *
 * ## The defect this file freezes
 *
 * Phase 9.4.4's reconciliation is correct and is not redesigned here: a correlated
 * partial transient attempt is completed by authoritative replacement from a
 * complete durable decode, `samples`/`phaseCuts` are replaced rather than unioned,
 * process-local identity is preserved, first-token evidence upgrades one way, the
 * historical stream is not replayed through `LiveMeter`, usage precedence is
 * unchanged, and an ambiguous correlation is never guessed.
 *
 * What it left behind was one source-level claim it could not support. The settled
 * temporal-shape gate read
 *
 *     durableShape = record.attempts.every(attempt => Number.isFinite(attempt.settlementSeq))
 *
 * and `settlementSeq` proves only that a durable **settlement was observed**. It
 * does not prove that the attempt's sample timeline came from a complete durable
 * stream. When a decode was incomplete the reconciliation correctly refused and the
 * attempt kept its transient tail — and the card then labelled that tail
 * `temporalShapeQuality: reconstructed`, which is exactly what `reconstructed` is
 * defined not to mean (`src/core/quality-model.js` §11).
 *
 * Measured through the real wire (`SessionEventFeed` -> live controller ->
 * `TurnTelemetryStore` -> `settle()` -> `aggregateTurn` -> `qualityAxes`) on
 * `5ef2f0d`, for a replacement window holding only the output samples at
 * `300/350/400` and a correlated `assistant/message` whose stream lost a record
 * while carrying `usage: { outputTokens: 600, reasoningTokens: 300 }`:
 *
 *     reconciliation refused                     (samples stayed 300/350/400)
 *     attempt.samples                            3 transient samples, unchanged
 *     attempt.phaseCuts                          [] (the 120 cut was not adopted)
 *     attempt.settlementSeq                      2 (finite)
 *     attempt.usage                              authoritative, source `assistant-settlement`
 *     attempt.calibration.totalAnchored          true
 *     settled.quality.tokenTotalQuality          exact
 *     settled.quality.temporalShapeQuality       reconstructed   <-- the defect
 *     settled.curve.qualityAxes.temporalShapeQuality   reconstructed   <-- the defect
 *     diagnostics counters                       reconciled 0 / uncorrelated 1
 *
 * After the repair the same fixture reads `estimated` on the temporal axis while the
 * token axis stays `exact`, and the refusal is counted as `rejected`.
 *
 * ## The three facts, kept separate
 *
 *     durable settlement observed          attempt.settlementSeq
 *     durable stream decoded completely    decoded.complete
 *     durable stream adopted as temporal
 *       evidence                           attempt.temporalEvidenceAuthority
 *
 * Only the third supports `reconstructed`, and it is written where the decision is
 * made (`TurnTelemetryStore.temporalEvidenceObserved`, called by the two paths that
 * adopt a decode) rather than inferred later from an incidental field.
 *
 * ## What this file drives
 *
 * Every wire-level case goes through the real ingest path — `fakeSessionsService`
 * publishes real `SessionEventWindow` changes, `SessionEventFeed` normalizes them,
 * the live controller routes them, and `TurnTelemetryStore` records them — so the
 * authority is established by the code that ships. The §9 case is the exception by
 * design: it calls each construction path directly, because its subject *is* the
 * value each path publishes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { materializeReconstructedTurn } from '../src/dsh/reconstruction.js'
import { reconstructFromDurable } from '../src/dsh/durable-path.js'
import { attemptFromDecoded } from '../src/dsh/adapter.js'
import { applyRetryOutcomes } from '../src/dsh/index.js'
import { decodeStreamRecords } from '../src/dsh/stream-decoder.js'
import {
  TEMPORAL_EVIDENCE_AUTHORITY,
  hasDurableTemporalAuthority,
  turnKey,
} from '../src/core/types.js'
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

const text = tokens => 'x'.repeat(tokens * 4)

/** The authoritative stream, decoded completely: 3 reasoning samples, a cut, 3 output samples. */
function completeStream() {
  return [
    { type: 'reasoning-chunks', time0: 0, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] },
    { type: 'chunk', time: 120, chunk: NAME_ONLY_DELTA },
    { type: 'text-chunks', time0: 300, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] },
  ]
}

/**
 * The same attempt with one malformed record: the output run declares one `dt` for
 * three members. The decoder reports `BAD_DT`, refuses that one record and marks the
 * decode incomplete, while still returning the reasoning half and the boundary chunk
 * — which is precisely the state the phase is about: a decoded result the controller
 * receives, that the reconciliation must refuse.
 */
function malformedStream() {
  return [
    { type: 'reasoning-chunks', time0: 0, index: 0, dt: [50, 50], texts: [text(100), text(100), text(100)] },
    { type: 'chunk', time: 120, chunk: NAME_ONLY_DELTA },
    { type: 'text-chunks', time0: 300, index: 0, dt: [50], texts: [text(100), text(100), text(100)] },
  ]
}

/** The authoritative usage counter, so the token axis is exact on both sides. */
const AUTHORITATIVE_USAGE = Object.freeze({ outputTokens: 600, reasoningTokens: 300 })

/** Only what a window beginning after the phase cut can still contain. */
function tailTransient(attemptId = 'a1', { turn = 1, step = 1 } = {}) {
  return [
    transientEntry(attemptId, 300, outputDelta(100), { turn, step }),
    transientEntry(attemptId, 350, outputDelta(100), { turn, step }),
    transientEntry(attemptId, 400, outputDelta(100), { turn, step }),
  ]
}

/** The complete transient plane of the principal attempt. */
function fullTransient(attemptId = 'a1', { turn = 1, step = 1 } = {}) {
  return [
    transientEntry(attemptId, 0, reasoningDelta(100), { turn, step }),
    transientEntry(attemptId, 50, reasoningDelta(100), { turn, step }),
    transientEntry(attemptId, 100, reasoningDelta(100), { turn, step }),
    transientEntry(attemptId, 120, NAME_ONLY_DELTA, { turn, step }),
    ...tailTransient(attemptId, { turn, step }),
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
  const data = { turn, step, stream: stream ?? completeStream() }
  if (usage !== undefined) data.usage = usage
  return durableEntry(type, seq, timeMs, data)
}

/* -------------------------------------------------------------- wire driver */

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
    counters() { return controller.diagnostics(sessionId)?.counters ?? {} },
    dispose() { controller.dispose() },
  }
}

const recordOf = (harness, turn = 1) => harness.controller.store.turns.get(turnKey(harness.sessionId, turn))
const attemptOf = (harness, index = 0, turn = 1) => recordOf(harness, turn)?.attempts[index] ?? null
const sampleKey = attempt => attempt.samples.map(sample => `${sample.timeMs}:${sample.tokens}:${sample.phase}`)

/* =========================================================================
 * PRINCIPAL — CASE B: incomplete decode with authoritative usage
 * ========================================================================= */

test('CASE B — a refused reconciliation never labels a transient tail reconstructed', () => {
  const harness = attached('s-945-b')
  harness.replace([...tailTransient()])
  harness.push(settlementRow({ stream: malformedStream(), usage: AUTHORITATIVE_USAGE }))
  harness.push(turnEndRow())

  const record = recordOf(harness)
  const attempt = attemptOf(harness)
  assert.notEqual(attempt, null, 'the replacement window opened the attempt')

  /* ---- the pre-fix state, unchanged by the repair: a real refusal ---- */

  assert.deepEqual(sampleKey(attempt), ['300:100:output', '350:100:output', '400:100:output'],
    'a partial decode is not authoritative, so the transient tail stands exactly as it was')
  assert.deepEqual(attempt.phaseCuts, [], 'and the boundary the decode lost is not adopted')
  assert.equal(Number.isFinite(attempt.settlementSeq), true,
    'the durable settlement itself was observed and is recorded')
  assert.equal(attempt.settlementSeq, 2)
  assert.equal(attempt.settlementKind, 'message')
  assert.equal(attempt.surfaceCommitted, true)
  assert.deepEqual(attempt.usage, { outputTokens: 600, reasoningTokens: 300 },
    'the authoritative usage is kept: a failed temporal reconstruction discards no token total')
  assert.equal(attempt.usageSource, 'assistant-settlement')
  assert.equal(attempt.attemptId, 'a1', 'the correlated attempt keeps its process-local identity')
  assert.equal(record.attempts.length, 1, 'no second attempt was invented for a proved correlation')

  /* ---- the defect: the temporal axis must not claim a reconstruction ---- */

  const settled = record.settled
  assert.equal(settled.attemptBreakdown[0].calibration.totalAnchored, true,
    'the only thing standing between this turn and `reconstructed` is where its timeline came from')
  assert.equal(settled.quality.tokenTotalQuality, 'exact', 'the provider counter is authoritative')
  assert.equal(settled.generatedTokens, 600)
  assert.equal(settled.quality.temporalShapeQuality, 'estimated',
    'a timeline observed live, never completed by a durable decode, is not a reconstruction')
  assert.equal(settled.curve.qualityAxes.temporalShapeQuality, 'estimated')
  assert.equal(settled.curve.quality, 'estimated')
  assert.notEqual(settled.curve.quality, 'unavailable',
    'valid transient shape evidence exists, so the axis degrades to estimated rather than disappearing')

  /* ---- and the attempt says where its evidence came from ---- */

  assert.equal(attempt.temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.LIVE,
    'a refusal replaces nothing, so the authority is the transient plane it kept')

  /* ---- §7: the outcome is the rejected one, not the uncorrelated one ---- */

  const counters = harness.counters()
  assert.equal(counters.settlementStreamsReconciled, 0)
  assert.equal(counters.settlementStreamsRejected, 1,
    'the correlation was proved and the decode was refused: its own outcome')
  assert.equal(counters.settlementStreamsUncorrelated, 0)
  harness.dispose()
})

/* =========================================================================
 * CASE G — correlated incomplete decode is `rejected`, not `uncorrelated`
 * ========================================================================= */

test('CASE G — a proved correlation whose decode was refused is never counted as uncorrelated', () => {
  const harness = attached('s-945-g')
  harness.replace([turnStartRow(0), ...tailTransient()])
  harness.push(settlementRow({ stream: malformedStream(), usage: AUTHORITATIVE_USAGE }))

  const record = recordOf(harness)
  assert.equal(record.attempts.length, 1, 'the correlation proved exactly one owner and created none')
  assert.equal(attemptOf(harness).attemptId, 'a1', 'the settlement joined the attempt it proved')
  assert.equal(attemptOf(harness).settlementSeq, 2, 'and settled it')

  const counters = harness.counters()
  assert.equal(counters.settlementStreamsRejected, 1)
  assert.equal(counters.settlementStreamsUncorrelated, 0,
    'the settlement *was* correlated; reading a refused decode as a failed correlation is the mislabel')
  assert.equal(counters.settlementStreamsReconciled, 0)
  harness.dispose()
})

/* =========================================================================
 * CASE A — complete mixed reconciliation is unchanged
 * ========================================================================= */

test('CASE A — a complete decode is still adopted and still supports a reconstructed shape', () => {
  const harness = attached('s-945-a')
  harness.replace([...fullTransient()])
  harness.replace([...tailTransient()])
  harness.push(settlementRow({ stream: completeStream(), usage: AUTHORITATIVE_USAGE }))
  harness.push(turnEndRow())

  const attempt = attemptOf(harness)
  assert.deepEqual(sampleKey(attempt), [
    '0:100:reasoning', '50:100:reasoning', '100:100:reasoning',
    '300:100:output', '350:100:output', '400:100:output',
  ], 'the Phase 9.4.4 replacement is untouched')
  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 120, phase: 'output' }])
  assert.equal(attempt.attemptId, 'a1', 'process-local identity preserved')
  assert.equal(attempt.settlementSeq, 2)
  assert.equal(attempt.temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE)

  const settled = recordOf(harness).settled
  assert.equal(settled.quality.temporalShapeQuality, 'reconstructed',
    'the adopted complete decode is durable authoritative temporal evidence')
  assert.equal(settled.curve.qualityAxes.temporalShapeQuality, 'reconstructed')
  assert.equal(settled.quality.tokenTotalQuality, 'exact')
  assert.equal(settled.reasoningMs, 120, 'and the 9.4.4 numbers are unchanged')
  assert.equal(settled.outputMs, 100)
  assert.equal(settled.reasoningTps, 2500)
  assert.equal(settled.outputTps, 3000)
  assert.equal(settled.curve.peakTps, 3000)
  assert.equal(harness.counters().settlementStreamsReconciled, 1)
  assert.equal(harness.counters().settlementStreamsRejected, 0)
  harness.dispose()
})

/* =========================================================================
 * CASE C — incomplete decode without usage keeps the no-fabrication rule
 * ========================================================================= */

test('CASE C — an incomplete decode without usage fabricates neither a total nor a shape', () => {
  const harness = attached('s-945-c')
  harness.replace([...tailTransient()])
  harness.push(settlementRow({ stream: malformedStream() }))
  harness.push(turnEndRow())

  const settled = recordOf(harness).settled
  assert.equal(settled.generatedTokens, null, 'no provider counter exists to publish')
  assert.equal(settled.usageComplete, false)
  assert.equal(settled.quality.tokenTotalQuality, 'unavailable')
  assert.equal(settled.quality.temporalShapeQuality, 'estimated',
    'the observed transient shape is real evidence and is not discarded')
  assert.equal(attemptOf(harness).temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.LIVE)
  assert.equal(attemptOf(harness).usage, null)
  assert.equal(harness.counters().settlementStreamsRejected, 1)
  harness.dispose()
})

/* =========================================================================
 * CASE D — pure durable reconstruction with a complete decode
 * ========================================================================= */

test('CASE D — a pure durable reconstruction of a complete stream still reads reconstructed', () => {
  const harness = attached('s-945-d')
  harness.push(settlementRow({ stream: completeStream(), usage: AUTHORITATIVE_USAGE }))
  harness.push(turnEndRow())

  const record = recordOf(harness)
  const attempt = record.attempts[0]
  assert.equal(record.attempts.length, 1, 'turn/end materialized the durable evidence')
  assert.equal(attempt.samples.length, 6)
  assert.deepEqual(attempt.phaseCuts, [{ timeMs: 120, phase: 'output' }])
  assert.equal(attempt.temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE,
    'the reconstruction plane adopted a complete decode')
  assert.equal(record.settled.quality.temporalShapeQuality, 'reconstructed')
  assert.equal(record.settled.quality.tokenTotalQuality, 'exact')
  assert.equal(record.settled.reasoningMs, 120)
  harness.dispose()
})

test('CASE D2 — a pure durable reconstruction of an incomplete stream is not reconstructed', () => {
  const harness = attached('s-945-d2')
  harness.push(settlementRow({ stream: malformedStream(), usage: AUTHORITATIVE_USAGE }))
  harness.push(turnEndRow())

  const attempt = recordOf(harness).attempts[0]
  assert.deepEqual(sampleKey(attempt), ['0:100:reasoning', '50:100:reasoning', '100:100:reasoning'],
    'the surviving half of the stream is still real evidence and is still restored')
  assert.equal(attempt.temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE,
    'durable-derived is not the same claim as durably authoritative')
  assert.equal(recordOf(harness).settled.quality.temporalShapeQuality, 'estimated')
  assert.equal(recordOf(harness).settled.quality.tokenTotalQuality, 'exact',
    'the provider total is untouched by the temporal refusal')
  harness.dispose()
})

/* =========================================================================
 * CASE E — pure live
 * ========================================================================= */

test('CASE E — a turn cannot become reconstructed merely by ending', () => {
  const harness = attached('s-945-e')
  harness.replace([turnStartRow(0), ...fullTransient()])
  harness.push(turnEndRow())

  const record = recordOf(harness)
  assert.equal(record.attempts[0].settlementKind, 'none', 'no durable settlement was observed')
  assert.equal(record.attempts[0].temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.LIVE)
  assert.equal(record.settled.quality.temporalShapeQuality, 'estimated')
  assert.equal(record.settled.curve.qualityAxes.temporalShapeQuality, 'estimated')
  /**
   * The token axis is unavailable here (no counter was ever reported) and the shape
   * axis is estimated; the two are independent readings of different evidence.
   */
  assert.equal(record.settled.quality.tokenTotalQuality, 'unavailable')
  harness.dispose()
})

/* =========================================================================
 * CASE F — ambiguous correlation
 * ========================================================================= */

test('CASE F — an unprovable correlation is still restored, and counted as uncorrelated', () => {
  const harness = attached('s-945-f')
  harness.replace([
    turnStartRow(0),
    transientEntry('a1', 300, outputDelta(100)),
    transientEntry('a2', 350, outputDelta(100)),
    transientEntry('a3', 400, outputDelta(100)),
  ])
  assert.equal(recordOf(harness).attempts.length, 3)

  /* The first settlement is correlated by identity; the second cannot be proved. */
  harness.settle('a3', settlementRow({ seq: 5, usage: AUTHORITATIVE_USAGE }))
  harness.push(settlementRow({ seq: 6, stream: completeStream(), usage: AUTHORITATIVE_USAGE }))

  const record = recordOf(harness)
  assert.equal(record.attempts.length, 4, 'the unprovable settlement restored its own attempt')
  const restored = record.attempts[3]
  assert.equal(restored.attemptId, 'durable:6', 'the durable-restoration identity policy is unchanged')
  assert.equal(restored.temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE,
    'the restored attempt’s authority follows the decode it was actually built from')
  assert.deepEqual(sampleKey(attemptOf(harness, 0)), ['300:100:output'], 'no candidate was guessed into')
  assert.deepEqual(sampleKey(attemptOf(harness, 1)), ['350:100:output'])

  const counters = harness.counters()
  assert.equal(counters.settlementStreamsUncorrelated, 1)
  assert.equal(counters.settlementStreamsRejected, 0,
    'nothing was refused: no existing record’s evidence was declined')
  assert.equal(counters.settlementStreamsReconciled, 1)
  harness.dispose()
})

/* =========================================================================
 * CASE H — retry / mixed temporal authority
 * ========================================================================= */

test('CASE H — the turn is constrained by the weakest contributing temporal evidence', () => {
  const harness = attached('s-945-h')
  harness.replace([
    turnStartRow(0),
    transientEntry('a1', 300, outputDelta(100), { step: 1 }),
    transientEntry('a1', 350, outputDelta(100), { step: 1 }),
    transientEntry('a1', 400, outputDelta(100), { step: 1 }),
    transientEntry('a2', 400, outputDelta(50), { step: 2 }),
    transientEntry('a2', 450, outputDelta(50), { step: 2 }),
    transientEntry('a2', 500, outputDelta(50), { step: 2 }),
  ])

  /* One attempt is completed by a complete decode; the other's decode is refused. */
  harness.settle('a1', settlementRow({ seq: 5, timeMs: 400, step: 1, stream: completeStream(), usage: AUTHORITATIVE_USAGE }))
  harness.settle('a2', settlementRow({ seq: 6, timeMs: 500, step: 2, stream: malformedStream(), usage: AUTHORITATIVE_USAGE }))
  harness.push(turnEndRow(500))

  const record = recordOf(harness)
  assert.equal(record.attempts.length, 2)
  assert.equal(record.attempts[0].temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE)
  assert.equal(record.attempts[1].temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.LIVE)
  assert.equal(record.attempts[1].samples.length, 3, 'the refused attempt keeps its own transient tail')

  const settled = record.settled
  assert.equal(settled.contributingAttemptCount, 2)
  assert.equal(settled.quality.temporalShapeQuality, 'estimated',
    'one live contributor forbids a turn-level reconstruction')
  assert.equal(settled.curve.qualityAxes.temporalShapeQuality, 'estimated')
  assert.equal(settled.quality.tokenTotalQuality, 'exact',
    'both attempts reported an authoritative counter, which the temporal gate cannot take away')
  assert.equal(harness.counters().settlementStreamsReconciled, 1)
  assert.equal(harness.counters().settlementStreamsRejected, 1)
  harness.dispose()
})

/* =========================================================================
 * CASE I — the axes stay independent
 * ========================================================================= */

test('CASE I — authoritative usage stays exact while the temporal axis stops at estimated', () => {
  const harness = attached('s-945-i')
  harness.replace([...tailTransient()])
  harness.push(settlementRow({ stream: malformedStream(), usage: AUTHORITATIVE_USAGE }))
  harness.push(turnEndRow())

  const settled = recordOf(harness).settled
  assert.deepEqual(
    [settled.quality.tokenTotalQuality, settled.quality.phaseSplitQuality, settled.quality.temporalShapeQuality],
    ['exact', 'estimated', 'estimated'],
    'the token total is counted by the provider; the split and the shape are temporal readings of a stream',
  )
  assert.equal(settled.quality.displayTokenTotal, 'exact')
  assert.equal(settled.generatedTokens, 600)
  assert.equal(settled.observedGeneratedTokens, 600)
  assert.equal(settled.curve.qualityAxes.tokenTotalQuality, 'exact')
  assert.equal(settled.curve.qualityAxes.temporalShapeQuality, 'estimated')
  harness.dispose()
})

/* =========================================================================
 * §9 — every attempt-construction path, audited
 * ========================================================================= */

/** The decoded form of one compact stream, as the adapter builds it. */
const decodedFrom = stream => decodeStreamRecords(stream)

/**
 * The construction paths §9 requires a disposition for, named exactly as they are
 * recorded below. The list is the audit: a path added to the store without an entry
 * here is a path whose authority nobody checked.
 */
const AUDITED_PATHS = Object.freeze([
  'TurnTelemetryStore.beginAttempt',
  'acceptChunk / live-built attempt',
  'attemptFromDecoded (complete decode)',
  'attemptFromDecoded (incomplete decode)',
  'reconstructFromDurable (complete stream)',
  'reconstructFromDurable (incomplete stream)',
  'materializeReconstructedTurn (complete stream)',
  'materializeReconstructedTurn (incomplete stream)',
  'controller durable-only restoration',
  'controller reconcileAttemptStream (adopted)',
  'controller reconcileAttemptStream (refused)',
  'open attempt at turn/end',
  'retry / assistant-attempt settlement',
])

test('§9 — every attempt-construction path publishes the temporal authority it can prove', () => {
  const complete = decodedFrom(completeStream())
  const incomplete = decodedFrom(malformedStream())
  assert.equal(complete.complete, true, 'the fixture decode is complete')
  assert.equal(incomplete.complete, false, 'and the other one is not')
  assert.ok(incomplete.chunks.length > 0, 'the incomplete decode still yields decodable material')

  const disposals = new Map()
  const record = (label, actual, expected, why) => {
    assert.equal(disposals.has(label), false, `${label}: dispositioned twice`)
    disposals.set(label, { actual, expected, why })
    assert.equal(actual, expected, `${label}: ${why}`)
  }

  /* 1 — a fresh store attempt, and 2 — the live-built attempt, are the transient plane. */
  {
    const store = new TurnTelemetryStore()
    const turn = store.beginTurn({ sessionId: 's9', turn: 1, timeMs: 0 })
    const opened = store.beginAttempt(turn, { attemptId: 'live', step: 1, startedAtMs: 0 })
    record('TurnTelemetryStore.beginAttempt', opened.temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.LIVE, 'an undeclared source is the transient plane, never durable')
    assert.equal(hasDurableTemporalAuthority(opened), false, 'and the gate refuses it')
    store.acceptChunk(turn, opened, { timeMs: 0, chunk: outputDelta(100) })
    store.acceptChunk(turn, opened, { timeMs: 100, chunk: outputDelta(100) })
    record('acceptChunk / live-built attempt', opened.temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.LIVE, 'a transient sample cannot make a timeline durable')
  }

  /* 3/4 — `attemptFromDecoded`, the durable-only restoration record. */
  {
    const fromComplete = attemptFromDecoded({ attemptId: 'd1', turn: 1, step: 1, decoded: complete })
    const fromIncomplete = attemptFromDecoded({ attemptId: 'd2', turn: 1, step: 1, decoded: incomplete })
    record('attemptFromDecoded (complete decode)', fromComplete.temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE, 'the samples are one complete decode')
    record('attemptFromDecoded (incomplete decode)', fromIncomplete.temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE, 'durable-derived but partial')
  }

  /* 5/6 — `reconstructFromDurable`, the durable parser. */
  {
    const events = [
      settlementRow({ stream: completeStream(), usage: AUTHORITATIVE_USAGE }).event,
      settlementRow({ seq: 3, stream: malformedStream(), usage: AUTHORITATIVE_USAGE }).event,
    ]
    const reconstructed = reconstructFromDurable({ sessionId: 's9', turn: 1, events })
    record('reconstructFromDurable (complete stream)', reconstructed.attempts[0].temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE, 'the reconstruction plane reads decoded.complete')
    record('reconstructFromDurable (incomplete stream)', reconstructed.attempts[1].temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE, 'and refuses to round it up')
  }

  /* 7/8 — `materializeReconstructedTurn`, which routes the parser into the store. */
  {
    const store = new TurnTelemetryStore()
    const materialized = materializeReconstructedTurn({
      store,
      sessionId: 's9',
      turn: 1,
      events: [settlementRow({ stream: completeStream(), usage: AUTHORITATIVE_USAGE }).event],
    })
    record('materializeReconstructedTurn (complete stream)',
      materialized.record.attempts[0].temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE, 'the store is told what the parser derived')

    const otherStore = new TurnTelemetryStore()
    const partial = materializeReconstructedTurn({
      store: otherStore,
      sessionId: 's9',
      turn: 1,
      events: [settlementRow({ stream: malformedStream(), usage: AUTHORITATIVE_USAGE }).event],
    })
    record('materializeReconstructedTurn (incomplete stream)',
      partial.record.attempts[0].temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE, 'a partial decode is not promoted by the store')
  }

  /* 9 — the controller’s durable-only restoration (§13.2), over the real wire. */
  {
    const harness = attached('s-945-audit-restore')
    harness.replace([
      turnStartRow(0),
      transientEntry('a1', 300, outputDelta(100)),
      transientEntry('a2', 350, outputDelta(100)),
    ])
    harness.push(settlementRow({ seq: 5, stream: completeStream(), usage: AUTHORITATIVE_USAGE }))
    record('controller durable-only restoration', recordOf(harness).attempts.at(-1).temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE, 'the restored attempt is the decode it was built from')
    harness.dispose()
  }

  /* 10/11 — a successful and a refused `reconcileAttemptStream`, over the real wire. */
  {
    const accepted = attached('s-945-audit-accept')
    accepted.replace([...tailTransient()])
    accepted.push(settlementRow({ stream: completeStream(), usage: AUTHORITATIVE_USAGE }))
    record('controller reconcileAttemptStream (adopted)', attemptOf(accepted).temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE, 'the replacement was applied')
    accepted.dispose()

    const refused = attached('s-945-audit-refuse')
    refused.replace([...tailTransient()])
    refused.push(settlementRow({ stream: malformedStream(), usage: AUTHORITATIVE_USAGE }))
    record('controller reconcileAttemptStream (refused)', attemptOf(refused).temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.LIVE, 'a refusal writes nothing, so the transient plane still stands')
    refused.dispose()
  }

  /* 12 — an attempt still open when the turn closes: no settlement at all. */
  {
    const store = new TurnTelemetryStore()
    const turn = store.beginTurn({ sessionId: 's9', turn: 1, timeMs: 0 })
    const open = store.beginAttempt(turn, { attemptId: 'open', step: 1, startedAtMs: 0 })
    store.acceptChunk(turn, open, { timeMs: 0, chunk: outputDelta(100) })
    store.acceptChunk(turn, open, { timeMs: 100, chunk: outputDelta(100) })
    record('open attempt at turn/end', open.temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.LIVE, 'the turn closing is not evidence about its samples')
    assert.equal(store.endTurn(turn, { timeMs: 300, status: 'completed' }).quality.temporalShapeQuality, 'estimated')
  }

  /* 13 — retry / `assistant/attempt`: a settlement with no stream ever adopted. */
  {
    const store = new TurnTelemetryStore()
    const turn = store.beginTurn({ sessionId: 's9', turn: 1, timeMs: 0 })
    const attempt = store.beginAttempt(turn, { attemptId: 'retry', step: 1, startedAtMs: 0 })
    store.acceptChunk(turn, attempt, { timeMs: 0, chunk: outputDelta(100) })
    store.acceptChunk(turn, attempt, { timeMs: 100, chunk: outputDelta(100) })
    store.settleAttempt(attempt, {
      settledAtMs: 200,
      settlementKind: 'attempt',
      surfaceCommitted: false,
      attemptOutcome: 'unknown',
      settlementSeq: 7,
    })
    applyRetryOutcomes(turn.attempts, [
      { kind: 'retry-scheduled', turn: 1, step: 1, seq: 8, timeMs: 250, retry: 1 },
    ])
    record('retry / assistant-attempt settlement', attempt.temporalEvidenceAuthority,
      TEMPORAL_EVIDENCE_AUTHORITY.LIVE, 'identity and outcome are lifecycle, not temporal authority')
    assert.equal(attempt.attemptOutcome, 'retried', 'the retry correlation really ran')
    assert.equal(attempt.settlementSeq, 7, 'and the settlement identity is still recorded')
  }

  assert.deepEqual([...disposals.keys()], [...AUDITED_PATHS],
    'every §9 path is dispositioned exactly once, and nothing else is')
  for (const [label, entry] of disposals) {
    assert.ok(entry.why.length > 20, `${label}: the disposition states why`)
  }
})

test('§9 — the authority is one-way upward and unknown values are never durable-complete', () => {
  const store = new TurnTelemetryStore()
  const turn = store.beginTurn({ sessionId: 's9b', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(turn, { attemptId: 'a', step: 1, startedAtMs: 0 })

  assert.equal(hasDurableTemporalAuthority(attempt), false)
  assert.equal(hasDurableTemporalAuthority({ temporalEvidenceAuthority: 'durable' }), false,
    'an unrecognised name is not a claim')
  assert.equal(hasDurableTemporalAuthority({}), false, 'a missing field is not a claim')
  assert.equal(hasDurableTemporalAuthority(null), false)

  assert.equal(store.temporalEvidenceObserved(attempt, { authority: 'not-a-real-authority' }), false,
    'an unknown authority cannot be recorded at all')
  assert.equal(attempt.temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.LIVE)

  assert.equal(store.temporalEvidenceObserved(attempt, { authority: TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE }), true)
  assert.equal(hasDurableTemporalAuthority(attempt), false, 'partial durable evidence is still not authoritative')
  assert.equal(store.temporalEvidenceObserved(attempt, { authority: TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE }), true)
  assert.equal(hasDurableTemporalAuthority(attempt), true)
  assert.equal(store.temporalEvidenceObserved(attempt, { authority: TEMPORAL_EVIDENCE_AUTHORITY.LIVE }), false,
    'a proven claim is never withdrawn')
  assert.equal(attempt.temporalEvidenceAuthority, TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE)
})
