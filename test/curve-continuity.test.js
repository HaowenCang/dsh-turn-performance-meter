/**
 * Phase 10.1 — Multi-Attempt Completed-Curve Continuity.
 *
 * Dedicated regression fixtures distinguishing:
 *   A. hard attempt-boundary segmentation;
 *   B. rate-publication gate (null TPS);
 *   C. chart-wide render-budget refusal.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { curveTree } from '../src/client/completed/curve-tree.js'
import { rec, byClass } from './helpers/completed-tree.js'
import { MAX_RENDER_POINTS_TOTAL } from '../src/core/curve.js'
import { compressAttempts } from '../src/core/time-axis.js'

function outputChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

function reasoningChunk(text) {
  return { type: 'reasoning-delta', index: 0, text }
}

function toolArgsChunk(id, text) {
  return { type: 'tool-call-delta', index: 0, id, argumentsDelta: text }
}

/**
 * Small explanatory fixture:
 * 3 contributing attempts, 2 tool intervals.
 * Output A -> tool -> Output B -> tool -> Output C.
 */
function driveSmallExplanatoryTurn() {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's-small', turn: 1, timeMs: 0 })

  // Attempt A: output episode, 4 deltas across 150 ms
  const a = store.beginAttempt(record, { attemptId: 'call-a', step: 1, startedAtMs: 0 })
  for (let d = 0; d < 4; d++) {
    store.acceptChunk(record, a, { timeMs: d * 50, chunk: outputChunk('x'.repeat(400)) })
  }
  store.settleAttempt(a, {
    settledAtMs: 150,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 400 },
    settlementSeq: 1,
  })

  // Tool 1: 850 ms wall time
  store.toolStarted(record, { callId: 'tool-1', name: 'search', timeMs: 200 })
  store.toolSettled(record, { callId: 'tool-1', timeMs: 1050, status: 'ok' })

  // Attempt B: output episode, 4 deltas across 150 ms
  const b = store.beginAttempt(record, { attemptId: 'call-b', step: 2, startedAtMs: 1100 })
  for (let d = 0; d < 4; d++) {
    store.acceptChunk(record, b, { timeMs: 1100 + d * 50, chunk: outputChunk('y'.repeat(400)) })
  }
  store.settleAttempt(b, {
    settledAtMs: 1250,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 400 },
    settlementSeq: 2,
  })

  // Tool 2: 750 ms wall time
  store.toolStarted(record, { callId: 'tool-2', name: 'read', timeMs: 1300 })
  store.toolSettled(record, { callId: 'tool-2', timeMs: 2050, status: 'ok' })

  // Attempt C: output episode, 4 deltas across 150 ms
  const c = store.beginAttempt(record, { attemptId: 'call-c', step: 3, startedAtMs: 2100 })
  for (let d = 0; d < 4; d++) {
    store.acceptChunk(record, c, { timeMs: 2100 + d * 50, chunk: outputChunk('z'.repeat(400)) })
  }
  store.settleAttempt(c, {
    settledAtMs: 2250,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 400 },
    settlementSeq: 3,
  })

  const settled = store.endTurn(record, { timeMs: 2300, status: 'completed' })
  return { store, record, settled }
}

/**
 * Stress fixture:
 * 202 contributing model attempts, 201 tool intervals.
 */
function driveStressTurn(attemptCount = 202) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's-stress', turn: 1, timeMs: 0 })
  let wallMs = 0

  for (let i = 0; i < attemptCount; i++) {
    const attempt = store.beginAttempt(record, { attemptId: `call-${i}`, step: i + 1, startedAtMs: wallMs })
    // Primarily output episodes with 4 deltas across 150 ms
    for (let d = 0; d < 4; d++) {
      store.acceptChunk(record, attempt, {
        timeMs: wallMs + d * 50,
        chunk: outputChunk(`call-${i}-delta-${d}`.padEnd(100, '.')),
      })
    }
    wallMs += 150
    store.settleAttempt(attempt, {
      settledAtMs: wallMs,
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
      usage: { outputTokens: 100 },
      settlementSeq: i + 1,
    })

    if (i < attemptCount - 1) {
      store.toolStarted(record, { callId: `tool-${i}`, name: 'exec', timeMs: wallMs })
      wallMs += 250
      store.toolSettled(record, { callId: `tool-${i}`, timeMs: wallMs, status: 'ok' })
      wallMs += 50
    }
  }

  const settled = store.endTurn(record, { timeMs: wallMs + 10, status: 'completed' })
  return { store, record, settled }
}

test('small fixture: compressed axis removes tool waits and verifies attempt boundaries', () => {
  const { settled } = driveSmallExplanatoryTurn()
  const curve = settled.curve

  assert.equal(curve.attempts.length, 3, 'number of attempts == 3')
  assert.equal(settled.tools.count, 2, 'number of tools == 2')

  // Tool waits are non-zero in wall time (850ms and 750ms)
  // Compressed axis removes them: A is [0, 150], B is [150, 300], C is [300, 450]
  assert.equal(curve.durationMs, 450)
  assert.equal(curve.segments[0].startMs, 0)
  assert.equal(curve.segments[0].endMs, 150)
  assert.equal(curve.segments[1].startMs, 150)
  assert.equal(curve.segments[1].endMs, 300)
  assert.equal(curve.segments[2].startMs, 300)
  assert.equal(curve.segments[2].endMs, 450)

  assert.equal(curve.segments[0].endMs, curve.segments[1].startMs, 'A.endMs == B.startMs')
  assert.equal(curve.segments[1].endMs, curve.segments[2].startMs, 'B.endMs == C.startMs')

  // All 3 output runs contain real finite measurements
  for (const attempt of curve.attempts) {
    const published = attempt.points.filter(p => p.publishable && Number.isFinite(p.tps))
    assert.ok(published.length >= 2, `${attempt.attemptId} has >= 2 finite measurements`)
  }
})

test('small fixture: presentation stitching creates exactly 2 connectors and preserves drawnPoints', () => {
  const { settled } = driveSmallExplanatoryTurn()
  const curve = settled.curve
  const view = curveViewModel({ curve })

  assert.equal(view.connectorCount, 2, 'two connectors between A->B and B->C')
  assert.equal(view.connectors.length, 2)
  assert.equal(view.connectors[0].outgoingAttemptId, 'call-a')
  assert.equal(view.connectors[0].incomingAttemptId, 'call-b')
  assert.equal(view.connectors[0].phase, 'output')
  assert.equal(view.connectors[1].outgoingAttemptId, 'call-b')
  assert.equal(view.connectors[1].incomingAttemptId, 'call-c')
  assert.equal(view.connectors[1].phase, 'output')

  // Verify connectors do NOT alter drawnPoints or peak
  assert.equal(view.drawnPoints, 6, '3 runs with 2 points each = 6 drawn points (unchanged)')
  assert.equal(view.markers.length, 0)
  assert.equal(view.renderElementPoints, 6)
  assert.ok(Number.isFinite(view.peak.value))

  // Verify tree rendering
  const tree = curveTree(rec, view, [], k => k)
  const plots = byClass(tree[0], 'dsh-tpm-plot')
  assert.equal(plots.length, 1)
  assert.equal(plots[0].props['data-connectors'], 2)
  assert.equal(plots[0].props['data-points'], 6)

  const connectorPaths = byClass(tree[0], 'dsh-tpm-connector')
  assert.equal(connectorPaths.length, 2)
  assert.equal(connectorPaths[0].props['data-connector'], 'true')
  assert.equal(connectorPaths[0].props['data-from-attempt'], 'call-a')
  assert.equal(connectorPaths[0].props['data-to-attempt'], 'call-b')
  assert.equal(connectorPaths[1].props['data-connector'], 'true')
  assert.equal(connectorPaths[1].props['data-from-attempt'], 'call-b')
  assert.equal(connectorPaths[1].props['data-to-attempt'], 'call-c')
})

test('stress fixture: decomposes gap causes and verifies 169 continuity connectors', () => {
  const { settled } = driveStressTurn(202)
  const curve = settled.curve
  const view = curveViewModel({ curve })

  const attemptCount = curve.attempts.length
  const toolCount = settled.tools.count
  const outputSeries = view.series.find(s => s.key === 'output')
  const reasoningSeries = view.series.find(s => s.key === 'reasoning')

  const outputRunCount = outputSeries?.runs.length ?? 0
  const reasoningRunCount = reasoningSeries?.runs.length ?? 0
  const allAttemptRuns = curve.attempts.flatMap(a => a.runs)
  const budgetRefusedRuns = curve.renderBudget?.degradedRuns ?? 0
  const degradedRunCount = allAttemptRuns.filter(r => r.degraded).length
  const publishableRuns = outputSeries.runs.filter(r => r.present).length
  const singletonRuns = outputSeries.runs.filter(r => r.singleton).length
  // Runs that had points but where no point was publishable (gate-withheld entirely)
  const gateWithheldRuns = allAttemptRuns.filter(r => !r.degraded && r.points.length > 0 && r.points.every(p => !p.publishable)).length

  assert.equal(attemptCount, 202)
  assert.equal(toolCount, 201)
  assert.equal(outputRunCount, 202)
  assert.equal(reasoningRunCount, 0)

  // Three causes of gaps identified and measured:
  // A. Hard attempt-boundary segmentation: 170 publishable runs were rendered as separate disjoint paths
  assert.equal(publishableRuns, 170)
  // B. Rate publication gate (null TPS): each attempt begins with opening anchor null TPS, but has publishable later points
  assert.equal(singletonRuns, 0)
  assert.equal(gateWithheldRuns, 0)
  // C. Chart-wide render-budget refusal: 32 runs refused due to MAX_RENDER_POINTS_TOTAL = 512
  assert.equal(budgetRefusedRuns, 32)
  assert.equal(degradedRunCount, 32)
  assert.equal(publishableRuns + budgetRefusedRuns, 202)

  // Continuity connectors bridge consecutive publishable runs of the same phase:
  // 170 publishable runs in sequence produce exactly 169 presentation connectors
  assert.equal(view.connectorCount, 169)
  assert.equal(view.connectors.length, 169)

  // Invariants: drawnPoints strictly within MAX_RENDER_POINTS_TOTAL
  assert.ok(view.drawnPoints <= MAX_RENDER_POINTS_TOTAL)
  assert.equal(view.drawnPoints, 170 * 2, '340 points')

  // No connector connects to or from a degraded run
  for (const c of view.connectors) {
    const fromAttemptIndex = parseInt(c.outgoingAttemptId.replace('call-', ''), 10)
    const toAttemptIndex = parseInt(c.incomingAttemptId.replace('call-', ''), 10)
    assert.equal(toAttemptIndex, fromAttemptIndex + 1)
    assert.ok(fromAttemptIndex < 170)
    assert.ok(toAttemptIndex < 170)
  }
})

test('rule validation: phase transitions across attempt boundaries do NOT connect', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's-phase-diff', turn: 1, timeMs: 0 })

  // Attempt 1: reasoning
  const a = store.beginAttempt(record, { attemptId: 'att-1', step: 1, startedAtMs: 0 })
  for (let d = 0; d < 4; d++) store.acceptChunk(record, a, { timeMs: d * 50, chunk: reasoningChunk('r'.repeat(400)) })
  store.settleAttempt(a, {
    settledAtMs: 150,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { reasoningTokens: 400 },
    settlementSeq: 1,
  })

  // Tool
  store.toolStarted(record, { callId: 't-1', name: 'search', timeMs: 200 })
  store.toolSettled(record, { callId: 't-1', timeMs: 1000, status: 'ok' })

  // Attempt 2: output
  const b = store.beginAttempt(record, { attemptId: 'att-2', step: 2, startedAtMs: 1050 })
  for (let d = 0; d < 4; d++) store.acceptChunk(record, b, { timeMs: 1050 + d * 50, chunk: outputChunk('o'.repeat(400)) })
  store.settleAttempt(b, {
    settledAtMs: 1200,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 400 },
    settlementSeq: 2,
  })

  const settled = store.endTurn(record, { timeMs: 1300, status: 'completed' })
  const view = curveViewModel({ curve: settled.curve })

  // Outgoing phase is reasoning, incoming phase is output -> must NOT connect!
  assert.equal(view.connectorCount, 0, 'no connector across phase transition')
})

test('rule validation: phase cuts between attempts prevent visual stitching', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's-cut', turn: 1, timeMs: 0 })

  const nameOnlyDelta = {
    type: 'tool-call-delta',
    index: 0,
    id: 'call_1',
    name: 'pwsh',
    argumentsDelta: '',
  }

  // Attempt 1: reasoning, cut at 180ms by nameOnlyDelta to output
  const a = store.beginAttempt(record, { attemptId: 'att-cut-1', step: 1, startedAtMs: 0 })
  for (let d = 0; d < 4; d++) store.acceptChunk(record, a, { timeMs: d * 50, chunk: reasoningChunk('r'.repeat(400)) })
  store.acceptChunk(record, a, { timeMs: 180, chunk: nameOnlyDelta })
  store.settleAttempt(a, {
    settledAtMs: 200,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { reasoningTokens: 400 },
    settlementSeq: 1,
  })

  // Tool
  store.toolStarted(record, { callId: 't-1', name: 'search', timeMs: 300 })
  store.toolSettled(record, { callId: 't-1', timeMs: 1000, status: 'ok' })

  // Attempt 2: reasoning
  const b = store.beginAttempt(record, { attemptId: 'att-cut-2', step: 2, startedAtMs: 1050 })
  for (let d = 0; d < 4; d++) store.acceptChunk(record, b, { timeMs: 1050 + d * 50, chunk: reasoningChunk('r'.repeat(400)) })
  store.settleAttempt(b, {
    settledAtMs: 1200,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { reasoningTokens: 400 },
    settlementSeq: 2,
  })

  const settled = store.endTurn(record, { timeMs: 1300, status: 'completed' })
  const view = curveViewModel({ curve: settled.curve })

  // There was a phase cut ending attempt 1's episode early, so attempts are not contiguous same-phase generation
  assert.equal(view.connectorCount, 0, 'phase cut prevents continuity connector')
})

test('retry boundary: connects visually when same-phase and consecutive, preserving metric reset', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's-retry', turn: 1, timeMs: 0 })

  // Attempt 1: output, but gets retried (e.g. rate limit or recoverable error)
  const a = store.beginAttempt(record, { attemptId: 'att-retry-1', step: 1, startedAtMs: 0 })
  for (let d = 0; d < 4; d++) store.acceptChunk(record, a, { timeMs: d * 50, chunk: outputChunk('o'.repeat(400)) })
  store.settleAttempt(a, {
    settledAtMs: 150,
    settlementKind: 'assistant/attempt',
    surfaceCommitted: false,
    attemptOutcome: 'retried',
    usage: { outputTokens: 400 },
    settlementSeq: 1,
  })

  // Attempt 2: retry attempt, output
  const b = store.beginAttempt(record, { attemptId: 'att-retry-2', step: 1, startedAtMs: 200 })
  for (let d = 0; d < 4; d++) store.acceptChunk(record, b, { timeMs: 200 + d * 50, chunk: outputChunk('r'.repeat(400)) })
  store.settleAttempt(b, {
    settledAtMs: 350,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 400 },
    settlementSeq: 2,
  })

  const settled = store.endTurn(record, { timeMs: 400, status: 'completed' })
  const curve = settled.curve
  const view = curveViewModel({ curve })

  // Metric reset is preserved: Attempt 2 has localMs starting from 0 and independent rate samples
  const attB = curve.attempts[1]
  assert.equal(attB.points[0].localMs, 0)
  assert.equal(attB.points[0].episodeElapsedMs, 0)
  assert.equal(attB.points[0].episodeSampleCount, 1)

  // Visual continuity: both are output, consecutive on compressed axis, publishable -> connected!
  assert.equal(view.connectorCount, 1)
  assert.equal(view.connectors[0].outgoingAttemptId, 'att-retry-1')
  assert.equal(view.connectors[0].incomingAttemptId, 'att-retry-2')
})

test('metric invariance: connectors do not alter statistics, durations, peaks or drawnPoints', () => {
  const { settled: smallSettled } = driveSmallExplanatoryTurn()
  const smallView = curveViewModel(smallSettled)

  // Turn-level metrics
  assert.equal(smallSettled.generatedTokens, 1200)
  assert.equal(smallSettled.phaseTokens.output, 1200)
  assert.equal(smallSettled.phaseTokens.reasoning, null)
  assert.equal(smallSettled.turnElapsedMs, 2300) // Wall time
  assert.equal(smallSettled.curve.durationMs, 450) // Active/compressed time
  assert.ok(smallSettled.outputTps > 0)
  assert.equal(smallSettled.curve.peakTps, smallView.peak.value)

  // View-level counts
  assert.equal(smallView.drawnPoints, 6)
  assert.equal(smallView.markers.length, 0)
  assert.equal(smallView.connectorCount, 2)
  // connectors are strictly accounted separately:
  assert.notEqual(smallView.drawnPoints, smallView.drawnPoints + smallView.connectorCount)
  assert.equal(smallView.drawnPoints + smallView.markers.length, smallView.renderElementPoints)

  const { settled: stressSettled } = driveStressTurn(202)
  const stressView = curveViewModel(stressSettled)

  assert.equal(stressSettled.generatedTokens, 202 * 100)
  assert.equal(stressSettled.curve.attempts.length, 202)
  assert.equal(stressSettled.curve.peakTps, stressView.peak.value)
  assert.equal(stressView.drawnPoints, 170 * 2)
  assert.equal(stressView.connectorCount, 169)
  assert.equal(stressView.renderElementPoints, 170 * 2)
})

test('Section 9 control: aggregate output TPS > published curve peak when short episodes contribute to aggregate', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's-sec9', turn: 1, timeMs: 0 })

  // 10 very short output episodes, each with 2 deltas (under 100 ms or under 3 samples)
  // They contribute tokens to the summary aggregate, but publication gate withholds curve TPS
  for (let i = 0; i < 10; i++) {
    const attempt = store.beginAttempt(record, { attemptId: `call-${i}`, step: i + 1, startedAtMs: i * 200 })
    store.acceptChunk(record, attempt, { timeMs: i * 200, chunk: outputChunk('x'.repeat(400)) }) // 100 tokens
    store.acceptChunk(record, attempt, { timeMs: i * 200 + 40, chunk: outputChunk('x'.repeat(400)) }) // 100 tokens
    store.settleAttempt(attempt, {
      settledAtMs: i * 200 + 50,
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
      usage: { outputTokens: 200 },
      settlementSeq: i + 1,
    })
  }

  const settled = store.endTurn(record, { timeMs: 2500, status: 'completed' })
  // Total output tokens: 2000 tokens over 10 * 50 ms = 500 ms -> 4000 tokens/s aggregate
  assert.ok(settled.outputTps > 0, 'outputTps aggregate is positive')
  // But every episode was only 50 ms / 2 samples, below MIN_RATE_SAMPLES (3) and MIN_RATE_ELAPSED_MS (100)
  // So curve peak is null!
  assert.equal(settled.curve.peakTps, null, 'curve peak is null because publication gate withheld all points')
  // Thus aggregate output TPS > published curve peak (null / unavailable)
  assert.ok((settled.outputTps ?? 0) > (settled.curve.peakTps ?? 0))
})
