/**
 * Same-timestamp phase labels follow the **authoritative stream order** (Phase 7C.1).
 *
 * ## The defect this file was written against
 *
 * `LiveMeter.streamingPhase` is the phase of the last **accepted** generated sample.
 * The completed curve restated that as "the phase of the newest sample at or before
 * each vertex", but broke ties between simultaneous samples with a total order over
 * the phases themselves — `reasoning` before `output` — on the reasoning that a
 * deterministic rule is better than the sort's stability.
 *
 * Determinism is not the same as agreement. The tie-break made `output` win *every*
 * simultaneous pair, so an attempt that wrote text and then reasoned at one instant
 * was labelled `output`, while the live pill for the same stream showed `reasoning`.
 * And it discarded evidence the host already carries: the transient frame index, and
 * the durable compact stream member order. Array order inside
 * `record.attempts[].samples` **is** that order — `TurnTelemetryStore.acceptChunk`
 * appends, and both reconstruction paths (`attemptFromDecoded`, the live path's own
 * append) preserve the decoded member order.
 *
 * ## What is frozen here
 *
 * The curve layer sorts by `time`, then by an explicit authoritative ordinal derived
 * from the sample's position in that array — never by phase. Consequences:
 *
 *   - the **numeric** TPS is unchanged, because a window holds every sample at an
 *     instant whatever order they arrived in;
 *   - the **phase label** may legitimately differ between two delivery orders, and it
 *     follows the last member of the pair.
 *
 * ## Why `curve.test.js`'s old expectation was wrong
 *
 * That file asserted `arrival order cannot change the series`, comparing two
 * `totalRollingTpsSeries` outputs with `deepEqual`. The equality holds for the rate
 * and fails for the label, and the label is part of the series — so the assertion was
 * freezing the phase hierarchy rather than an invariant. It is restated here in the
 * form that is true: order cannot change the numbers, and it does decide the label.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { attemptTrace, totalRollingTpsSeries } from '../src/core/curve.js'
import { compressAttempts } from '../src/core/time-axis.js'

const DELTA_CHARS = 400

const outputChunk = text => ({ type: 'text-delta', index: 0, text })
const reasoningChunk = text => ({ type: 'reasoning-delta', index: 0, text })

/** One attempt whose deltas are delivered in the order given. */
function driveOrdered(store, script) {
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  for (const [timeMs, kind] of script) {
    store.acceptChunk(record, attempt, {
      timeMs,
      chunk: kind === 'reasoning' ? reasoningChunk('x'.repeat(DELTA_CHARS)) : outputChunk('x'.repeat(DELTA_CHARS)),
    })
  }
  store.settleAttempt(attempt, {
    settledAtMs: 50,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    settlementSeq: 1,
  })
  return store.endTurn(record, { timeMs: 1000, status: 'completed' })
}

/** Two curated samples at one instant, in the order given. */
function simultaneous(first, second) {
  return [
    { attemptId: 'a', activeTimeMs: 0, phase: first, tokens: 20 },
    { attemptId: 'a', activeTimeMs: 0, phase: second, tokens: 10 },
  ]
}

// ---------------------------------------------------------------------------
// 1. The counterexample
// ---------------------------------------------------------------------------

test('the last authoritative sample at an instant owns the vertex label', () => {
  /**
   * The audit's counterexample: one attempt, one instant, an `output` delta delivered
   * first and a `reasoning` delta second. Both contribute to the rate.
   */
  const settled = driveOrdered(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']])
  const point = settled.curve.attempts[0].points[0]

  assert.equal(point.tps, 200, 'both deltas are inside the one-second window')
  assert.equal(point.activePhase, 'reasoning',
    `live semantics after the second sample are reasoning; the completed curve says ${point.activePhase}`)
})

test('the reverse stream order produces the opposite label from the same evidence', () => {
  const settled = driveOrdered(new TurnTelemetryStore(), [[0, 'reasoning'], [0, 'output']])
  const point = settled.curve.attempts[0].points[0]
  assert.equal(point.tps, 200)
  assert.equal(point.activePhase, 'output',
    'reasoning then output: the output delta is the last authoritative member')
})

test('the two orders agree on the rate and differ only in the label', () => {
  const outputFirst = driveOrdered(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']]).curve
  const reasoningFirst = driveOrdered(new TurnTelemetryStore(), [[0, 'reasoning'], [0, 'output']]).curve

  assert.deepEqual(
    outputFirst.attempts[0].points.map(point => point.tps),
    reasoningFirst.attempts[0].points.map(point => point.tps),
    'same timestamp and same tokens: the numeric series is order-independent',
  )
  assert.equal(outputFirst.peakTps, reasoningFirst.peakTps, 'down to the published peak')
  assert.deepEqual(
    outputFirst.attempts[0].points.map(point => point.activePhase),
    ['reasoning'],
  )
  assert.deepEqual(
    reasoningFirst.attempts[0].points.map(point => point.activePhase),
    ['output'],
    'and the label is the one fact the order decides',
  )
})

test('the series sampler and the attempt trace resolve a tie the same way', () => {
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 0 }, simultaneous('output', 'reasoning'))
  assert.equal(trace.points[0].activePhase, 'reasoning')
  assert.equal(trace.points[0].tps, 30)

  const reversed = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 0 }, simultaneous('reasoning', 'output'))
  assert.equal(reversed.points[0].activePhase, 'output')
  assert.equal(reversed.points[0].tps, 30)

  /** The standalone sampler is the same rule, reached without a segment. */
  const series = totalRollingTpsSeries(simultaneous('output', 'reasoning'), { durationMs: 0 })
  assert.equal(series[0].activePhase, 'reasoning')
  assert.equal(series[0].tps, 30)
})

test('an explicit ordinal survives compression and outranks array position', () => {
  /**
   * The ordinal is published by `compressAttempts` as `sampleOrder`, so the ordering
   * is explicit in the curve layer rather than implied by whichever array a caller
   * happens to hand in. A sample carrying it is sorted by it.
   */
  const compressed = compressAttempts([{
    attemptId: 'a',
    samples: [
      { timeMs: 0, phase: 'output', tokens: 20 },
      { timeMs: 0, phase: 'reasoning', tokens: 10 },
    ],
  }])
  assert.deepEqual(compressed.samples.map(sample => sample.sampleOrder), [0, 1],
    'the ordinal is the position in the stored attempt, which is the stream order')

  const shuffled = [
    { attemptId: 'a', activeTimeMs: 0, phase: 'output', tokens: 20, sampleOrder: 1 },
    { attemptId: 'a', activeTimeMs: 0, phase: 'reasoning', tokens: 10, sampleOrder: 0 },
  ]
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 0 }, shuffled)
  assert.equal(trace.points[0].activePhase, 'output',
    'the ordinal, not the array position, decides: sampleOrder 1 is the later member')
  assert.equal(trace.points[0].tps, 30)
})

// ---------------------------------------------------------------------------
// 2. Visual tone and the seam
// ---------------------------------------------------------------------------

test('a simultaneous pair yields one run, labelled with the later member\'s tone', () => {
  const settled = driveOrdered(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']])
  const trace = settled.curve.attempts[0]

  assert.equal(trace.points.length, 1, 'one instant is one measurement, not two vertices')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning'])
  const view = curveViewModel(settled)
  const reasoning = view.series.find(series => series.key === 'reasoning')
  const output = view.series.find(series => series.key === 'output')
  assert.equal(reasoning.present, false, 'a one-vertex run is a marker, not a path')
  assert.equal(reasoning.markers.length, 1, 'the measurement keeps the reasoning tone')
  assert.equal(output.markers.length, 0, 'and it is not also drawn in the output tone')
  assert.equal(reasoning.markers[0].series, 'reasoning')
  assert.equal(output.tone, 'accent', 'the two tones the legend already distinguishes')
  assert.equal(reasoning.tone, 'neutral')
})

// ---------------------------------------------------------------------------
// 3. Live / durable equivalence
// ---------------------------------------------------------------------------

test('a live-fed session and a durable-feed session agree on rate, label and tone', async () => {
  /**
   * Phase 2 established that durable reconstruction preserves delta order. This is
   * the Phase 7C.1 regression on the same fact: the two feeds must agree not only on
   * the numbers but on `activePhase` and on the tone the chart paints, which is the
   * half of the output the old phase tie-break could silently move.
   *
   * Both paths are driven into the same engine, so a disagreement here is a
   * disagreement about evidence order and nothing else.
   */
  const { durableSettledView, liveSettledView } = await import('./helpers/equivalence.js')
  const { loadFixture, listFixtures } = await import('./helpers/fixtures.js')

  let compared = 0
  for (const name of listFixtures()) {
    const fixture = loadFixture(name)
    const durable = durableSettledView(fixture).settled?.curve
    const live = liveSettledView(fixture).settled?.curve
    if (!durable || !live) continue

    assert.deepEqual(
      durable.attempts.map(attempt => attempt.points.map(point => [point.timeMs, point.tps])),
      live.attempts.map(attempt => attempt.points.map(point => [point.timeMs, point.tps])),
      `${name}: numeric series must be identical between the two feeds`,
    )
    assert.deepEqual(
      durable.attempts.map(attempt => attempt.points.map(point => point.activePhase)),
      live.attempts.map(attempt => attempt.points.map(point => point.activePhase)),
      `${name}: and so must the phase labels`,
    )
    assert.deepEqual(
      durable.series.map(series => series.runs.map(run => run.phase)),
      live.series.map(series => series.runs.map(run => run.phase)),
      `${name}: the visual tones the chart paints must be identical too`,
    )
    compared += 1
  }
  assert.ok(compared > 0, 'at least one fixture was compared')
})

// ---------------------------------------------------------------------------
// 4. A retry reset is unaffected
// ---------------------------------------------------------------------------

test('a retry still resets the phase label, not merely the window', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const abandoned = store.beginAttempt(record, { attemptId: 'retry-1', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, abandoned, { timeMs: 0, chunk: outputChunk('a'.repeat(DELTA_CHARS)) })
  store.settleAttempt(abandoned, {
    settledAtMs: 50,
    settlementKind: 'attempt',
    surfaceCommitted: false,
    attemptOutcome: 'retried',
  })

  const retry = store.beginAttempt(record, { attemptId: 'retry-2', step: 1, startedAtMs: 100 })
  store.acceptChunk(record, retry, { timeMs: 100, chunk: reasoningChunk('b'.repeat(DELTA_CHARS)) })
  store.settleAttempt(retry, {
    settledAtMs: 150,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  const settled = store.endTurn(record, { timeMs: 300, status: 'completed' })
  const [first, second] = settled.curve.attempts
  assert.equal(first.points[0].activePhase, 'output', 'the abandoned prefix keeps its own tone')
  assert.equal(second.points[0].activePhase, 'reasoning',
    'and the retry is labelled from its own first sample, never the abandoned one')
  assert.equal(second.points[0].tps, 100, 'nor does it inherit the abandoned prefix\'s tokens')
})
