/**
 * Same-timestamp phase labels follow the **authoritative stream order** (Phase 7C.1,
 * re-frozen under the Phase 9.2 phase-cumulative estimator).
 *
 * ## The defect this file was written against
 *
 * `LiveMeter.streamingPhase` is the phase of the last **accepted** generated sample. The
 * completed curve restated that as "the phase of the newest sample at or before each
 * vertex", but broke ties between simultaneous samples with a total order over the phases
 * themselves — `reasoning` before `output` — on the reasoning that a deterministic rule is
 * better than the sort's stability.
 *
 * Determinism is not the same as agreement. The tie-break made `output` win *every*
 * simultaneous pair, so an attempt that wrote text and then reasoned at one instant was
 * labelled `output`, while the live pill for the same stream showed `reasoning`. And it
 * discarded evidence the host already carries: the transient frame index, and the durable
 * compact stream member order. Array order inside `record.attempts[].samples` **is** that
 * order — `TurnTelemetryStore.acceptChunk` appends, and both reconstruction paths
 * (`attemptFromDecoded`, the live path's own append) preserve the decoded member order.
 *
 * ## What Phase 9.2 changed about the consequence
 *
 * Under the trailing-window estimator the delivery order of two simultaneous samples moved
 * only the label: a one-second window held both deltas whatever order they arrived in, and
 * the number was order-independent. The phase-cumulative estimator resets its clock and its
 * numerator at every phase change, so the **last** member of a simultaneous pair decides
 * which episode is in force at that instant — and therefore both the label **and** the
 * number. That is exactly the live semantics: `LiveMeter.streamingPhase` is the phase of
 * the last accepted sample, and its episode clock starts at that sample.
 *
 * ## What is frozen here
 *
 *   - determinism: one stream, one series — twice over;
 *   - the tie-break: the authoritative ordinal (`sampleOrder`), never a phase hierarchy
 *     and never the array a caller happens to hand in;
 *   - one labelled run for a simultaneous pair;
 *   - an attempt boundary resets the label and the episode together.
 *
 * The live-versus-durable section below asserts the cross-feed consequence: the two feeds
 * must agree on the numbers, the labels and the tones, which is only possible if both
 * preserve the delta order the estimator reads.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { attemptTrace, cumulativePhaseTpsSeries } from '../src/core/curve.js'
import { compressAttempts } from '../src/core/time-axis.js'

const outputChunk = text => ({ type: 'text-delta', index: 0, text })
const reasoningChunk = text => ({ type: 'reasoning-delta', index: 0, text })

/**
 * One attempt whose deltas are delivered in the order given: `[timeMs, kind, chars]`.
 * 400 Latin characters weigh 100 estimated tokens, so the default entries below carry
 * round numbers.
 */
function driveOrdered(store, script) {
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  for (const [timeMs, kind, chars = 400] of script) {
    store.acceptChunk(record, attempt, {
      timeMs,
      chunk: kind === 'reasoning' ? reasoningChunk('x'.repeat(chars)) : outputChunk('x'.repeat(chars)),
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

/**
 * Two curated samples at one instant, in the delivery order given. The magnitudes belong
 * to the **phases** (output 20, reasoning 10), not to the positions, so the two orders are
 * the same pair of deltas delivered differently.
 */
function simultaneous(first, second) {
  const tokensOf = phase => (phase === 'output' ? 20 : 10)
  return [
    { attemptId: 'a', activeTimeMs: 0, phase: first, tokens: tokensOf(first) },
    { attemptId: 'a', activeTimeMs: 0, phase: second, tokens: tokensOf(second) },
  ]
}

// ---------------------------------------------------------------------------
// 1. The counterexample
// ---------------------------------------------------------------------------

test('the last authoritative sample at an instant owns the vertex label', () => {
  /**
   * The audit's counterexample: one attempt, one instant, an `output` delta delivered
   * first and a `reasoning` delta second. The reasoning delta is the last member, so it
   * opens the episode in force at that instant.
   */
  const settled = driveOrdered(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']])
  const points = settled.curve.attempts[0].points

  assert.equal(points[0].tps, 0, 'the episode opens at this instant, so its elapsed time is zero')
  assert.equal(points[0].activePhase, 'reasoning',
    `live semantics after the second sample are reasoning; the completed curve says ${points[0].activePhase}`)
  assert.equal(points.at(-1).activePhase, 'reasoning')
  assert.equal(points.at(-1).tps, 2000,
    'and the episode in force is the reasoning delta\'s own: its 100 tokens over its own 50 ms')
})

test('the reverse stream order produces the opposite label from the same evidence', () => {
  const settled = driveOrdered(new TurnTelemetryStore(), [[0, 'reasoning'], [0, 'output']])
  const points = settled.curve.attempts[0].points

  assert.equal(points[0].tps, 0)
  assert.equal(points[0].activePhase, 'output',
    'reasoning then output: the output delta is the last authoritative member')
  assert.equal(points.at(-1).activePhase, 'output')
  assert.equal(points.at(-1).tps, 2000)
})

test('the pair decides which episode supplies the number, not only the label', () => {
  /**
   * Two simultaneous deltas with different magnitudes: 200 estimated tokens of output and
   * 100 of reasoning. Whichever is delivered last opens the episode in force, and that
   * episode's own mass and clock produce the number — so the same evidence read in the two
   * delivery orders publishes different rates. The totals are identical either way; only
   * the episode boundary moved.
   */
  const outputFirst = driveOrdered(new TurnTelemetryStore(), [[0, 'output', 800], [0, 'reasoning', 400]])
  const reasoningFirst = driveOrdered(new TurnTelemetryStore(), [[0, 'reasoning', 400], [0, 'output', 800]])
  const a = outputFirst.curve.attempts[0]
  const b = reasoningFirst.curve.attempts[0]

  assert.deepEqual(a.points.map(point => point.activePhase), ['reasoning', 'reasoning'])
  assert.deepEqual(b.points.map(point => point.activePhase), ['output', 'output'])

  assert.equal(a.points.at(-1).tps, Math.round(100 * 1000 / 50),
    'output then reasoning: the reasoning episode measures its own 100 tokens over its own 50 ms')
  assert.equal(b.points.at(-1).tps, Math.round(200 * 1000 / 50),
    'reasoning then output: the output episode measures its own 200 tokens over its own 50 ms')
  assert.equal(a.points.at(-1).tps, 2000)
  assert.equal(b.points.at(-1).tps, 4000)

  assert.equal(a.tokens, 300, 'the same evidence whichever episode is in force')
  assert.equal(b.tokens, 300)
  assert.equal(outputFirst.curve.peakTps, 2000)
  assert.equal(reasoningFirst.curve.peakTps, 4000)
})

test('the same evidence in the same order produces the same series, twice', () => {
  /** The estimator is a pure function of the ordered evidence; no state leaks between runs. */
  const seriesOf = settled => settled.curve.attempts[0].points
    .map(point => [point.localMs, point.tps, point.activePhase])
  assert.deepEqual(
    seriesOf(driveOrdered(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']])),
    seriesOf(driveOrdered(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']])),
  )

  const samples = simultaneous('output', 'reasoning')
  const once = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, samples)
  const twice = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, samples.map(sample => ({ ...sample })))
  assert.deepEqual(
    once.points.map(point => [point.localMs, point.tps, point.activePhase]),
    twice.points.map(point => [point.localMs, point.tps, point.activePhase]),
  )
  assert.deepEqual(
    cumulativePhaseTpsSeries(samples, { durationMs: 100, sampleEndMs: 100 })
      .map(point => [point.localMs, point.tps]),
    cumulativePhaseTpsSeries(samples.map(sample => ({ ...sample })), { durationMs: 100, sampleEndMs: 100 })
      .map(point => [point.localMs, point.tps]),
  )
})

test('an explicit ordinal survives compression and outranks array position', () => {
  /**
   * The ordinal is published by `compressAttempts` as `sampleOrder`, so the ordering is
   * explicit in the curve layer rather than implied by whichever array a caller happens to
   * hand in.
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

  /**
   * The array below lists the output delta first, but its ordinal says it is the later
   * member. If array position decided the tie, the reasoning delta would be the last
   * member, the episode in force would be reasoning (10 tokens, rate 100) and the label
   * would be `reasoning`; the ordinal makes the output delta the later member instead
   * (20 tokens, rate 200, label `output`).
   */
  const shuffled = [
    { attemptId: 'a', activeTimeMs: 0, phase: 'output', tokens: 20, sampleOrder: 1 },
    { attemptId: 'a', activeTimeMs: 0, phase: 'reasoning', tokens: 10, sampleOrder: 0 },
  ]
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, shuffled)
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [[0, 0], [100, 200]])
  assert.equal(trace.points.at(-1).activePhase, 'output',
    'the ordinal, not the array position, decides: sampleOrder 1 is the later member')
})

test('the series sampler and the attempt trace resolve a tie the same way', () => {
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, simultaneous('output', 'reasoning'))
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps, point.activePhase]), [
    [0, 0, 'reasoning'], [100, 100, 'reasoning'],
  ])

  const reversed = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, simultaneous('reasoning', 'output'))
  assert.deepEqual(reversed.points.map(point => [point.localMs, point.tps, point.activePhase]), [
    [0, 0, 'output'], [100, 200, 'output'],
  ])

  /** The standalone sampler is the same rule, reached without a segment. */
  const series = cumulativePhaseTpsSeries(simultaneous('output', 'reasoning'), {
    durationMs: 100,
    sampleEndMs: 100,
  })
  assert.deepEqual(
    series.map(point => [point.localMs, point.tps, point.activePhase]),
    trace.points.map(point => [point.localMs, point.tps, point.activePhase]),
  )
})

// ---------------------------------------------------------------------------
// 2. Visual tone and the seam
// ---------------------------------------------------------------------------

test('a simultaneous pair yields one labelled run, in the later member\'s tone', () => {
  const settled = driveOrdered(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']])
  const trace = settled.curve.attempts[0]

  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning'],
    'one labelled run: the pair opens a single episode, named by its later member')
  assert.equal(trace.runs[0].pointCount, trace.points.length,
    'and the whole trace belongs to it — there is no second tone to cut at')

  const view = curveViewModel(settled)
  const reasoning = view.series.find(series => series.key === 'reasoning')
  const output = view.series.find(series => series.key === 'output')
  assert.equal(reasoning.present, true, 'the labelled run has a drawable segment')
  assert.equal(output.present, false, 'and nothing is painted in the output tone')
  assert.equal(reasoning.markers.length, 0)
  assert.equal(output.markers.length, 0)
  assert.equal(output.tone, 'accent', 'the two tones the legend already distinguishes')
  assert.equal(reasoning.tone, 'neutral')
})

// ---------------------------------------------------------------------------
// 3. Live / durable equivalence
// ---------------------------------------------------------------------------

test('a live-fed session and a durable-feed session agree on rate, label and tone', async () => {
  /**
   * Phase 2 established that durable reconstruction preserves delta order. This is the
   * Phase 7C.1 regression on the same fact, re-asserted for the Phase 9.2 phase-cumulative
   * estimator: the two feeds must agree not only on the numbers but on `activePhase` and on
   * the tone the chart paints. Under the cumulative estimator the stake is higher than it
   * was under the window — a vertex's *number* is the cumulative average of the episode its
   * newest sample opened, so a delta that one feed drops or reorders moves the value, not
   * merely the colour.
   *
   * Both paths are driven into the same engine, so a disagreement here is a disagreement
   * about evidence order and nothing else.
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

test('a retry still resets the phase label and the episode, not merely the window', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const abandoned = store.beginAttempt(record, { attemptId: 'retry-1', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, abandoned, { timeMs: 0, chunk: outputChunk('a'.repeat(400)) })
  store.settleAttempt(abandoned, {
    settledAtMs: 50,
    settlementKind: 'attempt',
    surfaceCommitted: false,
    attemptOutcome: 'retried',
  })

  const retry = store.beginAttempt(record, { attemptId: 'retry-2', step: 1, startedAtMs: 100 })
  store.acceptChunk(record, retry, { timeMs: 100, chunk: reasoningChunk('b'.repeat(400)) })
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
  assert.equal(second.points[0].tps, 0, 'its episode opens at its own local zero')
  assert.equal(second.points.at(-1).tps, 2000,
    'nor does it inherit the abandoned prefix\'s tokens: 100 over its own 50 ms, not 200')
  assert.equal(first.points.at(-1).tps, 2000)
})
