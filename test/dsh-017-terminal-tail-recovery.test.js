/**
 * Phase 7D.1 — terminal-tail reconstruction correctness.
 *
 * Phase 7D closed the *lifecycle* half of the `turn/end` record-miss defect: the
 * controller no longer returns silently, so a terminal boundary always produces a
 * completed card. It did not close the *metric* half. On the baseline this test
 * file was written against (`3602ce9179be22bcdc4259303546ebae4b827436`), the miss
 * path called `store.beginTurn(...)` on a fresh record and immediately
 * `store.endTurn(...)` on it, so every durable fact the turn had already published
 * into the very same window — the `assistant/message` settlements, their embedded
 * compact streams, usage, `tool/call` and `tool/result` boundaries — was dropped on
 * the floor on the way to that empty record. The card closed; its numbers were not
 * reconstructed from the evidence.
 *
 * The correction under test is the equality contract, not the card's existence:
 *
 *     terminal-tail recovery  ≈  durable reconstruction of the same evidence
 *
 * for every field the available durable evidence determines, and `unavailable`
 * (never a fabricated value) for every field that depends on a boundary the tail
 * does not contain.
 *
 * The three references the assertions are stated against are deliberate:
 *
 *   R1  `reconstructFromDurable()` over the tail's own events — the canonical
 *       durable pipeline, reduced into `TurnTelemetryStore` exactly as
 *       `test/helpers/equivalence.js` does it. This is the target equality.
 *   R2  `reconstructFromDurable()` over the full original recording, which *does*
 *       contain `turn/start`. It is used to prove the tail loses exactly the
 *       start-dependent fields and nothing else.
 *   R3  the raw durable rows, for provenance only.
 *
 * Nothing here re-derives a metric: every expected value comes from the existing
 * engine, so a disagreement is a disagreement about evidence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { reconstructFromDurable } from '../src/dsh/durable-path.js'
import { turnEndStatus } from '../src/dsh/adapter.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'
import { loadTargetFixture } from './helpers/fixtures.js'
import { createWindowDriver } from './helpers/assistant-stream-fold.js'

const SESSION = 'fixture-mujjrw4r-1'
const TURN = 1
/** Seq 4 is `turn/start`; the tail under test begins immediately after it. */
const TAIL_FROM_SEQ = 5

const FIXTURE = loadTargetFixture('t01-sequential-tools')
const FULL_EVENTS = FIXTURE.durable.map(row => row.event)
const TAIL_EVENTS = FULL_EVENTS.filter(event => event.seq >= TAIL_FROM_SEQ)

/* ------------------------------------------------------------------ *
 * The reference pipeline: durable reconstruction -> TurnTelemetryStore
 * ------------------------------------------------------------------ */

/**
 * Reduce a durable reconstruction through the store, the way `path B` does.
 *
 * This is the *canonical* reduction, not a second implementation of one: it calls
 * the same three store methods the controller calls (`beginAttempt`,
 * `acceptChunk`, `settleAttempt`) with the values `reconstructFromDurable`
 * produced. Its only local decisions are the store-internal attempt identity, which
 * the durable plane does not carry and which cannot be compared across paths, and
 * `settlementEventType`, which `settleAttempt` does not accept because it is not part
 * of the settlement *state* — it is the durable surface's own type, and the store
 * record carries it beside the state.
 */
function referenceView(events, label) {
  const reconstructed = reconstructFromDurable({ sessionId: SESSION, turn: TURN, events })
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: SESSION, turn: TURN, timeMs: reconstructed.turnStartMs })
  for (const attempt of reconstructed.attempts) {
    const stored = store.beginAttempt(record, {
      attemptId: `settlement:${attempt.settlementSeq}`,
      step: attempt.step,
      startedAtMs: attempt.startedAtMs,
    })
    for (const entry of attempt.chunks) {
      store.acceptChunk(record, stored, { timeMs: entry.timeMs, chunk: entry.chunk })
    }
    if (attempt.usage !== null) store.setAttemptUsage(stored, attempt.usage, attempt.usageSource)
    store.settleAttempt(stored, {
      settledAtMs: attempt.settledAtMs,
      settlementKind: attempt.settlementKind,
      surfaceCommitted: attempt.surfaceCommitted,
      attemptOutcome: attempt.attemptOutcome,
      usage: attempt.usage,
      usageSource: attempt.usageSource,
      settlementSeq: attempt.settlementSeq,
    })
    stored.settlementEventType = attempt.settlementEventType ?? null
    stored.interrupted = attempt.interrupted === true
  }
  for (const tool of reconstructed.tools) {
    store.toolStarted(record, { callId: tool.callId, name: tool.name, timeMs: tool.startMs })
    if (tool.endMs !== undefined) {
      store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status })
    }
  }
  const settled = store.endTurn(record, {
    timeMs: reconstructed.turnEndMs,
    status: reconstructed.status ?? 'completed',
    statusNote: reconstructed.statusNote,
  })
  return { label, reconstructed, record, settled }
}

const R1_TAIL = referenceView(TAIL_EVENTS, 'R1 tail')
const R2_FULL = referenceView(FULL_EVENTS, 'R2 full')

/* ------------------------------------------------------------------ *
 * The controller under test
 * ------------------------------------------------------------------ */

function harness() {
  const driver = createWindowDriver()
  const sessions = { binding: () => ({ eventSource: { getSnapshot: driver.getSnapshot, subscribe: driver.subscribe } }) }
  const controller = createController({ sessions })
  assert.equal(controller.attach(SESSION), true)
  return {
    driver,
    controller,
    record: turn => controller.store.turns.get(`${SESSION}::${turn}`),
    project: atMs => controller.project(SESSION, atMs),
    diagnostics: () => controller.diagnostics(SESSION),
    dispose: () => controller.dispose(),
  }
}

/** Only the fields the store's own record carries, so no field can be silently absent. */
function comparableRecord(record) {
  return {
    turn: record.turn,
    startMs: record.startMs ?? null,
    endMs: record.endMs ?? null,
    firstTokenMs: record.firstTokenMs ?? null,
    status: record.status ?? null,
    statusNote: record.statusNote ?? null,
    attempts: record.attempts.map(attempt => ({
      step: attempt.step ?? null,
      settlementKind: attempt.settlementKind ?? null,
      surfaceCommitted: attempt.surfaceCommitted === true,
      attemptOutcome: attempt.attemptOutcome ?? null,
      usage: attempt.usage ?? null,
      usageSource: attempt.usageSource ?? null,
      settlementSeq: attempt.settlementSeq ?? null,
      settlementEventType: attempt.settlementEventType ?? null,
      sampleCount: (attempt.samples ?? []).length,
      sampleTimes: (attempt.samples ?? []).map(sample => sample.timeMs),
      phaseSegments: segmentPhases(attempt.samples ?? []),
    })),
    tools: record.tools.map(call => ({
      callId: call.callId,
      name: call.name,
      startMs: call.startMs,
      endMs: call.endMs ?? null,
      status: call.status,
    })),
  }
}

function segmentPhases(samples) {
  const segments = []
  for (const sample of samples) {
    const last = segments.at(-1)
    if (last !== undefined && last.phase === sample.phase) last.count += 1
    else segments.push({ phase: sample.phase, count: 1 })
  }
  return segments
}

/**
 * The settled metric tuple the card is built from.
 *
 * `ttftMs` and `turnElapsedMs` are **excluded by design**: both are intervals from
 * the turn start, and the tail contains no `turn/start`, so their correct value is
 * `null`. They are asserted separately, as the unknown-boundary contract.
 */
function comparableMetrics(settled) {
  return {
    status: settled.status,
    reasonStatusKnown: turnEndStatus({ kind: 'completed' }).known,
    attemptCount: settled.attemptCount,
    contributingAttemptCount: settled.contributingAttemptCount,
    emptyAttemptCount: settled.emptyAttemptCount,
    generatedTokens: settled.generatedTokens,
    observedGeneratedTokens: settled.observedGeneratedTokens,
    reasoningTokens: settled.reasoningTokens,
    nonReasoningTokens: settled.nonReasoningTokens,
    reasoningTps: settled.reasoningTps,
    outputTps: settled.outputTps,
    reasoningMs: settled.reasoningMs,
    outputMs: settled.outputMs,
    temporalAllocationMode: settled.temporalAllocationMode,
    phaseTokensQuality: settled.phaseTokensQuality,
    splitQuality: settled.splitQuality,
    usageComplete: settled.usageComplete,
    splitComplete: settled.splitComplete,
    splitUsable: settled.splitUsable,
    qualityTokenTotal: settled.quality.tokenTotalQuality,
    qualityPhaseSplit: settled.quality.phaseSplitQuality,
    qualityTemporalShape: settled.quality.temporalShapeQuality,
    consistencyIssues: settled.consistencyIssues,
    tools: {
      count: settled.tools.count,
      completedCount: settled.tools.completedCount,
      runningCount: settled.tools.runningCount,
      workMs: settled.tools.workMs,
      wallMs: settled.tools.wallMs,
      failedCount: settled.tools.failedCount,
      names: settled.tools.names,
    },
    curve: {
      aligned: settled.curve.source.aligned,
      calibrated: settled.curve.source.calibrated,
      calibrationCoverage: settled.curve.source.calibrationCoverage,
      contributingAttemptCount: settled.curve.source.contributingAttemptCount,
      calibratedAttemptCount: settled.curve.source.calibratedAttemptCount,
      sourceIssues: settled.curve.source.issues,
      peakTps: settled.curve.peakTps,
      durationMs: settled.curve.durationMs,
      sampleEveryMs: settled.curve.sampleEveryMs,
      maxSeriesPoints: settled.curve.maxSeriesPoints,
      attemptCount: settled.curve.attempts.length,
      attemptDurations: settled.curve.attempts.map(attempt => attempt.durationMs),
      attemptSampleCounts: settled.curve.attempts.map(attempt => attempt.sampleCount),
      attemptTokens: settled.curve.attempts.map(attempt => attempt.tokens),
      attemptCalibrated: settled.curve.attempts.map(attempt => attempt.calibrated),
      segmentOffsets: settled.curve.segments.map(segment => `${segment.startMs}-${segment.endMs}`),
      seriesLengths: settled.curve.series.map(entry => `${entry.key}:${entry.runs.reduce((sum, run) => sum + run.points.length, 0)}`),
      quality: settled.curve.quality,
      renderBudgetTotal: settled.curve.renderBudget.total,
      renderBudgetAllocated: settled.curve.renderBudget.allocated,
      renderBudgetElements: settled.curve.renderBudget.elementPoints,
    },
  }
}

/* ------------------------------------------------------------------ *
 * §15 A — the main blocker
 * ------------------------------------------------------------------ */

test('a terminal durable tail without turn/start reconstructs the turn\'s durable metrics', () => {
  /**
   * The fixture is a real DSH 0.1.7-rc.2 capture: three model settlements, two
   * strictly sequential `pwsh` calls with their results, and a `completed`
   * `turn/end`. The tail keeps every one of those rows and removes exactly the
   * `turn/start` boundary (seq 4), which is what a live window looks like when the
   * tail has slid past the opening row.
   *
   * Pre-fix behaviour, recorded on baseline 3602ce9: the recovered record held
   * `attempts.length === 0` and `tools.length === 0`, so the completed card
   * printed 0 attempts, 0 generated tokens and no tools while the durable evidence
   * for all three was in the same window.
   */
  assert.equal(TAIL_EVENTS.some(event => event.type === 'turn/start'), false, 'the tail deliberately omits turn/start')
  assert.equal(TAIL_EVENTS.filter(event => event.type === 'assistant/message').length, 3)
  assert.equal(TAIL_EVENTS.filter(event => event.type === 'tool/call').length, 2)
  assert.equal(TAIL_EVENTS.filter(event => event.type === 'tool/result').length, 2)
  assert.equal(TAIL_EVENTS.filter(event => event.type === 'turn/end').length, 1)

  /** The reference must be non-trivial, or the equality below would be vacuous. */
  assert.equal(R1_TAIL.reconstructed.attempts.length, 3, 'reference: three durable settlements')
  assert.equal(R1_TAIL.reconstructed.tools.length, 2, 'reference: two durable tool calls')
  assert.equal(R1_TAIL.settled.generatedTokens, 147)
  assert.equal(R1_TAIL.settled.tools.completedCount, 2)

  const h = harness()
  h.driver.replace(TAIL_EVENTS.map(event => ({ type: 'event', event })))
  const view = h.project(1790497159000)

  assert.equal(view.kind, 'completed', 'the terminal boundary still closes the turn')
  assert.equal(view.turn, TURN)

  const record = h.record(TURN)
  assert.notEqual(record, undefined, 'a record exists for the recovered turn')

  assert.deepEqual(
    comparableRecord(record),
    comparableRecord(R1_TAIL.record),
    'recovered record == durable reconstruction of the same tail',
  )

  const settled = record.settled
  assert.notEqual(settled, null, 'the recovered record carries a settled snapshot')
  assert.deepEqual(
    comparableMetrics(settled),
    comparableMetrics(R1_TAIL.settled),
    'recovered metrics == durable reconstruction metrics',
  )

  h.dispose()
})

test('terminal-tail reconstruction reaches the same metric pipeline as a normal completed turn', () => {
  /**
   * The recovery must re-enter `aggregateTurn -> curveSource -> attemptTraces`, not
   * assemble a card of its own. Two consequences are asserted: the curve is
   * *calibrated* (its integral is anchored to the provider totals that were in the
   * tail), and the chart's attempt count matches the turn's.
   */
  const h = harness()
  h.driver.replace(TAIL_EVENTS.map(event => ({ type: 'event', event })))
  const view = h.project(1790497159000)
  const settled = h.record(TURN).settled

  assert.equal(settled.curve.source.calibrationCoverage, 'full')
  assert.equal(settled.curve.source.calibrated, true)
  assert.equal(settled.curve.attempts.length, settled.attemptCount)
  assert.equal(settled.curve.peakTps, R1_TAIL.settled.curve.peakTps)
  assert.equal(settled.curve.peakTps > 0, true, 'a durable tail with settlements has a real peak')
  assert.equal(settled.generatedTokens, 147, 'the provider totals in the tail are counted')
  assert.equal(view.columns.length > 0, true, 'the card is a real completed projection')
  h.dispose()
})

test('tail recovery and full durable reconstruction differ only in start-dependent fields', () => {
  /**
   * The full recording contains the `turn/start` row, so it can report TTFT and
   * elapsed; the tail cannot, and must not be made to by inferring a start from the
   * first delta, a `step/start`, a `tool/call`, the attach time or the clock. This
   * is the frozen boundary: the recovery is required to equal the durable
   * reconstruction *of the evidence it actually has*.
   */
  const h = harness()
  h.driver.replace(TAIL_EVENTS.map(event => ({ type: 'event', event })))
  h.project(1790497159000)
  const settled = h.record(TURN).settled

  assert.equal(R2_FULL.reconstructed.turnStartMs, 1790497151824, 'the full reference has the observed start')
  assert.equal(R2_FULL.settled.ttftMs, 2340)
  assert.equal(R2_FULL.settled.turnElapsedMs, 6938)
  assert.equal(R1_TAIL.reconstructed.turnStartMs, null, 'the tail reference has no start')
  assert.equal(R1_TAIL.settled.ttftMs, null)
  assert.equal(R1_TAIL.settled.turnElapsedMs, null)

  assert.equal(settled.ttftMs, null, 'TTFT is unavailable, not fabricated')
  assert.equal(settled.turnElapsedMs, null, 'elapsed is unavailable, not fabricated')

  /** Everything the tail *can* determine is identical between the two references. */
  const startFreeTail = comparableMetrics(R1_TAIL.settled)
  const startFreeFull = comparableMetrics(R2_FULL.settled)
  assert.deepEqual(startFreeTail, startFreeFull, 'the tail loses only the start-dependent fields')
  assert.deepEqual(
    comparableMetrics(settled),
    startFreeFull,
    'and the recovery is start-free equal to the full durable reconstruction',
  )
  h.dispose()
})

/* ------------------------------------------------------------------ *
 * §11 — firstToken evidence without a start boundary
 * ------------------------------------------------------------------ */

test('firstTokenMs is recovered from durable samples while TTFT stays unavailable', () => {
  /**
   * `record.firstTokenMs` is the absolute time of the earliest generated sample,
   * and the embedded compact stream inside the settlement preserves those
   * timestamps, so it *is* durable evidence. TTFT is a different claim — an
   * interval from `turn/start` — and with no start it is not computable. A known
   * first token beside an unavailable TTFT is the correct state here, not a bug.
   */
  const h = harness()
  h.driver.replace(TAIL_EVENTS.map(event => ({ type: 'event', event })))
  h.project(1790497159000)
  const record = h.record(TURN)

  assert.equal(R1_TAIL.record.firstTokenMs, 1790497154164, 'reference first token')
  assert.equal(record.firstTokenMs, 1790497154164, 'recovered from the durable generated samples')
  assert.equal(record.startMs, null, 'no start was observed, so none is fabricated')
  assert.equal(record.settled.ttftMs, null, 'TTFT needs both boundaries; only one exists')
  assert.equal(h.controller.store.liveSnapshot(SESSION, 1790497159000).ttftMs, null, 'the meter agrees')
  h.dispose()
})

/* ------------------------------------------------------------------ *
 * §15 A (incremental form) — append, not replace
 * ------------------------------------------------------------------ */

test('the same recovery happens when the tail arrives one append at a time', () => {
  /**
   * `replace` and `append` are different generations of the same evidence. The
   * retention mechanism must not depend on having seen one bulk snapshot: every
   * durable row is retained as it arrives, whichever change kind carried it.
   */
  const h = harness()
  for (const event of TAIL_EVENTS) h.driver.append({ type: 'event', event })
  const view = h.project(1790497159000)
  assert.equal(view.kind, 'completed')
  assert.deepEqual(
    comparableMetrics(h.record(TURN).settled),
    comparableMetrics(R1_TAIL.settled),
    'incremental ingestion reconstructs the same turn',
  )
  assert.equal(h.diagnostics().counters.turnEndLookupMiss, 1)
  h.dispose()
})

/* ------------------------------------------------------------------ *
 * §8 — the settle-assistant route that carries a durable entry
 * ------------------------------------------------------------------ */

test('a settlement delivered through settle-assistant is retained as evidence', () => {
  /**
   * The window contract at
   * `dsh-api-session-controller/lib/types/client/contract/events.d.ts:41-61`
   * declares `settle-assistant` as carrying an optional durable entry, and the real
   * fold uses that route for interrupted messages and non-surface settlements. A
   * retention mechanism hooked only into the `append` path would lose every one of
   * those rows, and the recovered turn would then be missing an attempt.
   *
   * Both settlements in the tail are delivered this way, so the assertion has teeth:
   * an unreconstructed recovery reports zero attempts, a reconstruction from
   * appended rows alone reports one, and only a retention path that covers the
   * settlement route reports both.
   */
  const settlements = TAIL_EVENTS.filter(event => event.type === 'assistant/message')
  assert.equal(settlements.length, 3, 'the fixture carries three settlements')
  const viaSettlementRoute = settlements.slice(0, 2)
  const viaAppend = settlements.slice(2)

  const h = harness()
  for (const event of TAIL_EVENTS) {
    if (event.type === 'assistant/message' || event.type === 'turn/end') continue
    h.driver.append({ type: 'event', event })
  }
  // The two earliest settlements never travel through an `append`: they are inserted
  // into the window only as the entry of a `settle-assistant` change.
  for (const [index, settlement] of viaSettlementRoute.entries()) {
    h.driver.settleAssistant(`s:${index + 1}`, { type: 'event', event: settlement })
  }
  for (const settlement of viaAppend) h.driver.append({ type: 'event', event: settlement })
  h.driver.append({ type: 'event', event: TAIL_EVENTS.find(event => event.type === 'turn/end') })

  const record = h.record(TURN)
  assert.notEqual(record, undefined)
  assert.equal(record.attempts.length, 3, 'all three settlements were retained, by both routes')
  for (const settlement of viaSettlementRoute) {
    const matched = record.attempts.filter(attempt => attempt.settlementSeq === settlement.seq)
    assert.equal(matched.length, 1, `settle-assistant entry seq ${settlement.seq} became a durable attempt`)
    assert.equal(matched[0].samples.length > 0, true, 'with its embedded stream decoded')
  }
  assert.equal(record.settled.generatedTokens, 147, 'and the provider totals came with them')
  assert.equal(record.tools.length, 2, 'the tool boundaries in the window were paired')
  h.dispose()
})

/* ------------------------------------------------------------------ *
 * §13 — the minimal boundary
 * ------------------------------------------------------------------ */

test('a window whose only evidence is turn/end closes with no invented data', () => {
  /**
   * §15 B. The terminal boundary is authoritative and the turn must close, but the
   * window carries nothing else about it. The correct reconstruction is empty: no
   * attempts, no tokens, no tools, no duration, no samples. Manufacturing any of
   * them to make the card look complete is the failure this asserts against.
   */
  const h = harness()
  h.driver.append({ type: 'event', event: { type: 'turn/end', seq: 40, time: 5000, data: { turn: 9, reason: { kind: 'completed' } } } })
  const view = h.project(5100)

  assert.equal(view.kind, 'completed', 'the lifecycle closes unconditionally')
  assert.equal(view.turn, 9)
  const record = h.record(9)
  const settled = record.settled

  assert.equal(record.attempts.length, 0, 'no attempt is invented')
  assert.equal(record.tools.length, 0, 'no tool is invented')
  assert.equal(record.startMs, null, 'no start is invented')
  assert.equal(record.firstTokenMs, null, 'no first token is invented')
  assert.equal(settled.attemptCount, 0)
  /**
   * `generatedTokens` is `null` rather than `0`, and that is the frozen rule rather
   * than a defect: `aggregateTurn` reports the turn total only when every
   * contributing attempt carried a provider counter (`usageComplete`), and falls
   * back to `observedGeneratedTokens` — which *is* the measured zero here — when
   * coverage is incomplete. `null` means "no evidence for this phase" and renders as
   * an em dash, which is the honest reading of a turn with no attempts at all.
   */
  assert.equal(settled.generatedTokens, null, 'no provider total exists to report')
  assert.equal(settled.observedGeneratedTokens, 0, 'and the measured partial sum is a real zero')
  assert.equal(settled.usageAttemptCount, 0)
  assert.equal(settled.reasoningTokens, null)
  assert.equal(settled.ttftMs, null)
  assert.equal(settled.turnElapsedMs, null)
  assert.equal(settled.tools.count, 0)
  assert.equal(settled.tools.workMs, 0)
  assert.equal(settled.tools.wallMs, 0)
  assert.equal(settled.curve.attempts.length, 0)
  assert.equal(settled.curve.peakTps, 0)
  assert.equal(settled.curve.source.calibrationCoverage, 'none', 'nothing was calibrated, and that is not a fallback')
  assert.equal(settled.curve.source.aligned, true, 'an empty join is aligned, not refused')
  h.dispose()
})

/* ------------------------------------------------------------------ *
 * §15 C — the existing full durable reload must not regress
 * ------------------------------------------------------------------ */

test('a full durable window containing turn/start is unchanged by this phase', () => {
  /**
   * §15 C. The `turn/start`-present case takes the ordinary path — the boundary
   * opens the record, no miss occurs — and must stay exactly equal to the durable
   * reconstruction, TTFT and elapsed included.
   */
  const h = harness()
  h.driver.replace(FULL_EVENTS.map(event => ({ type: 'event', event })))
  const view = h.project(1790497159000)

  assert.equal(view.kind, 'completed')
  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.turnEndLookupMiss, 0, 'the opening row was in the window')
  assert.equal(diagnostics.counters.turnEndLookupHit, 1)

  const record = h.record(TURN)
  assert.deepEqual(comparableRecord(record), comparableRecord(R2_FULL.record))
  assert.deepEqual(comparableMetrics(record.settled), comparableMetrics(R2_FULL.settled))
  assert.equal(record.startMs, 1790497151824)
  assert.equal(record.settled.ttftMs, 2340)
  assert.equal(record.settled.turnElapsedMs, 6938)
  h.dispose()
})

/* ------------------------------------------------------------------ *
 * §15 I / J — rebaseline and session isolation
 * ------------------------------------------------------------------ */

test('a rebaseline drops the previous generation\'s evidence', () => {
  /**
   * §9. `replace` is a new window generation. If retained evidence survived it, an
   * old generation's `assistant/message` could be reconstructed together with a new
   * generation's `turn/end`, which is cross-generation contamination: a turn would
   * report metrics assembled from two different windows.
   *
   * The new generation here is *minimal*: it holds `turn/end` and nothing else. The
   * contamination signature is therefore an attempt or a tool appearing in it.
   */
  const h = harness()
  h.driver.replace(TAIL_EVENTS.map(event => ({ type: 'event', event })))
  h.project(1790497159000)
  assert.equal(h.record(TURN).attempts.length, 3, 'the first generation reconstructed its attempts')

  const secondGenerationTurn = 7
  h.driver.replace([
    { type: 'event', event: { type: 'turn/end', seq: 60, time: 9000, data: { turn: secondGenerationTurn, reason: { kind: 'completed' } } } },
  ])
  const view = h.project(9100)

  assert.equal(view.kind, 'completed')
  assert.equal(view.turn, secondGenerationTurn)
  const record = h.record(secondGenerationTurn)
  assert.equal(record.attempts.length, 0, 'no previous-generation settlement entered the new generation')
  assert.equal(record.tools.length, 0, 'no previous-generation tool interval entered it')
  assert.equal(record.settled.observedGeneratedTokens, 0, 'and no previous-generation token total was carried over')
  assert.equal(record.settled.curve.peakTps, 0)

  /** The previous generation's own record is gone with its window. */
  assert.equal(h.record(TURN), undefined, 'the superseded generation left no turn record behind')
  h.dispose()
})

test('retained evidence is isolated per session', () => {
  /**
   * §15 J. Two sessions run concurrently and their windows are independent. A
   * recovery for session B must never reach session A's retained durable rows, even
   * when both sessions use the same turn number.
   */
  const drivers = new Map()
  const sessions = {
    binding: (id) => {
      if (!drivers.has(id)) drivers.set(id, createWindowDriver())
      const driver = drivers.get(id)
      return { eventSource: { getSnapshot: driver.getSnapshot, subscribe: driver.subscribe } }
    },
  }
  const controller = createController({ sessions })
  assert.equal(controller.attach('sess-a'), true)
  assert.equal(controller.attach('sess-b'), true)

  // Session A observes a full turn, so its evidence is complete and retained.
  drivers.get('sess-a').replace(TAIL_EVENTS.map(event => ({ type: 'event', event })))
  controller.project('sess-a', 1790497159000)
  assert.equal(controller.store.turns.get('sess-a::1').attempts.length, 3, 'session A reconstructed its turn')

  // Session B sees only the terminal boundary of its own turn 1.
  drivers.get('sess-b').append({ type: 'event', event: { type: 'turn/end', seq: 80, time: 9000, data: { turn: 1, reason: { kind: 'completed' } } } })
  const viewB = controller.project('sess-b', 9100)

  assert.equal(viewB.kind, 'completed')
  const recordB = controller.store.turns.get('sess-b::1')
  assert.equal(recordB.attempts.length, 0, 'session B did not inherit session A\'s settlements')
  assert.equal(recordB.tools.length, 0, 'nor its tool intervals')
  assert.equal(recordB.settled.observedGeneratedTokens, 0, 'nor its token totals')

  // And session A is untouched by session B's terminal boundary.
  assert.equal(controller.store.turns.get('sess-a::1').attempts.length, 3)
  assert.equal(controller.store.turns.get('sess-a::1').settled.generatedTokens, 147)
  controller.dispose()
})

/* ------------------------------------------------------------------ *
 * §7 — recovery must not corrupt the following turn
 * ------------------------------------------------------------------ */

test('a recovered terminal turn does not leak into the turn that follows it', () => {
  /**
   * The recovery materializes attempts into the store, and the store's `LiveMeter`
   * is per session. A recovered turn that left samples or a running-tool set behind
   * would corrupt the next turn's live rate — which is the reason the recovery has
   * to go through the store rather than be assembled beside it.
   *
   * The pill is warm-up aware (Phase 9.2): one generated sample is below
   * `MIN_WARMUP_SAMPLES`, so the honest reading of the first delta is the episode's
   * elapsed counter; the rate appears once the episode has enough samples, and it
   * is the episode-cumulative average over the episode's own clock.
   */
  const h = harness()
  h.driver.replace(TAIL_EVENTS.map(event => ({ type: 'event', event })))
  h.project(1790497159000)

  // A second turn, observed normally and live, after the recovery.
  h.driver.append({ type: 'event', event: { type: 'turn/start', seq: 41, time: 1790497159000, data: { turn: 2 } } })
  h.driver.append({ type: 'event', event: { type: 'step/start', seq: 42, time: 1790497159010, data: { turn: 2, step: 1 } } })
  const delta = (seq, time, index) => ({
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time,
      data: { attemptId: 'sess:2', turn: 2, step: 1, chunk: { type: 'text-delta', index, text: 'hello' } },
    },
  })
  h.driver.append(delta(43, 1790497159100, 0))

  const warm = h.project(1790497159100)
  assert.equal(warm.kind, 'warming', 'one sample is below the warm-up count: the pill shows the episode counter, never a rate')
  assert.equal(warm.state, 'streaming-output')
  assert.equal(warm.turn, 2)
  assert.equal(warm.samples, 1)
  assert.equal(warm.required, 3)

  // Two more deltas reach the warm-up count; the rate is the episode-cumulative average.
  h.driver.append(delta(44, 1790497159200, 1))
  h.driver.append(delta(45, 1790497159300, 2))
  const live = h.project(1790497159300)
  assert.equal(live.kind, 'streaming', 'the next turn streams normally once its episode warms up')
  assert.equal(live.turn, 2)
  const expectedTps = Math.round(
    3 * heuristicTokenWeight('hello') * 1000 / (1790497159300 - 1790497159100),
  )
  assert.equal(live.tps, expectedTps, 'the episode-cumulative average over the episode\'s own clock')
  assert.equal(h.diagnostics().liveRunningTools, 0, 'no recovered tool is left running')
  assert.equal(h.controller.store.live(SESSION).turn, 2)
  assert.equal(h.controller.store.live(SESSION).firstTokenMs, 1790497159100, 'the new turn stamps its own first token')
  h.dispose()
})
