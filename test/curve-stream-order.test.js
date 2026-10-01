/**
 * Same-timestamp phase labels follow the **authoritative stream order** (Phase 7C.1,
 * re-frozen under the Phase 9.2 phase-cumulative estimator and the Phase 9.4 publication
 * policy).
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
 * ## What Phase 9.4 added to every fixture
 *
 * A vertex is a measurement only when the episode in force holds at least three contributing
 * samples **and** at least 100 ms of its own clock (`src/core/rate-publication.js`), and a
 * withheld vertex carries `tps: null` rather than a fabricated `0`. A lone simultaneous pair
 * is therefore a label fixture and no longer a number fixture: with two deltas the episode the
 * pair opens can never publish. Every script below carries the same pair plus two follow-up
 * deltas in the phase the pair leaves in force and settles at 200 ms, which gives that episode
 * three samples and two measured vertices. The tie still decides both the label and the number;
 * what changed is how much evidence a number needs.
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
 * round numbers. `settledAtMs` is the attempt's own settlement instant, and therefore the end
 * of its trace: the scripts whose episode must publish a rate settle at 200 ms, which is two
 * cadence steps past the episode's origin.
 */
function driveOrdered(store, script, { settledAtMs = 50 } = {}) {
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  for (const [timeMs, kind, chars = 400] of script) {
    store.acceptChunk(record, attempt, {
      timeMs,
      chunk: kind === 'reasoning' ? reasoningChunk('x'.repeat(chars)) : outputChunk('x'.repeat(chars)),
    })
  }
  store.settleAttempt(attempt, {
    settledAtMs,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    settlementSeq: 1,
  })
  return store.endTurn(record, { timeMs: 1000, status: 'completed' })
}

/**
 * Two curated samples at one instant, in the delivery order given, plus the follow-up deltas
 * the publication policy requires. The magnitudes belong to the **phases** (output 20,
 * reasoning 10), not to the positions, so the two orders are the same pair of deltas delivered
 * differently; the follow-ups carry the later member's phase, so the episode the pair opens
 * reaches its third contributing sample — and its first full 100 ms — before the trace ends.
 */
function simultaneous(first, second) {
  const tokensOf = phase => (phase === 'output' ? 20 : 10)
  return [
    { attemptId: 'a', activeTimeMs: 0, phase: first, tokens: tokensOf(first) },
    { attemptId: 'a', activeTimeMs: 0, phase: second, tokens: tokensOf(second) },
    { attemptId: 'a', activeTimeMs: 50, phase: second, tokens: tokensOf(second) },
    { attemptId: 'a', activeTimeMs: 100, phase: second, tokens: tokensOf(second) },
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
   *
   * Two further reasoning deltas and a 200 ms settlement give that episode the three samples
   * and the 100 ms of its own clock the publication policy requires; the pair alone would
   * publish nothing at all.
   */
  const settled = driveOrdered(
    new TurnTelemetryStore(),
    [[0, 'output'], [0, 'reasoning'], [50, 'reasoning'], [100, 'reasoning']],
    { settledAtMs: 200 },
  )
  const points = settled.curve.attempts[0].points

  assert.equal(points[0].tps, null,
    'the episode opens at this instant, so it has no elapsed clock and publishes no rate')
  assert.equal(points[0].rateUnavailableReason, 'opening-anchor',
    'and it names that fact rather than publishing a measured zero')
  assert.equal(points[0].activePhase, 'reasoning',
    `live semantics after the second sample are reasoning; the completed curve says ${points[0].activePhase}`)
  assert.equal(points.at(-1).activePhase, 'reasoning')
  assert.equal(points.at(-1).tps, Math.round(300 * 1000 / 200),
    'and the episode in force is the reasoning episode\'s own: its three deltas\' 300 tokens '
    + 'over its own 200 ms')
  assert.equal(points.at(-1).tps, 1500)
  assert.equal(points[1].tps, Math.round(300 * 1000 / 100),
    'the first published step is those 300 tokens over the episode\'s own first 100 ms')
  assert.equal(points[1].tps, 3000)
})

test('the reverse stream order produces the opposite label from the same evidence', () => {
  const settled = driveOrdered(
    new TurnTelemetryStore(),
    [[0, 'reasoning'], [0, 'output'], [50, 'output'], [100, 'output']],
    { settledAtMs: 200 },
  )
  const points = settled.curve.attempts[0].points

  assert.equal(points[0].tps, null)
  assert.equal(points[0].rateUnavailableReason, 'opening-anchor')
  assert.equal(points[0].activePhase, 'output',
    'reasoning then output: the output delta is the last authoritative member')
  assert.equal(points.at(-1).activePhase, 'output')
  assert.equal(points.at(-1).tps, 1500)
  assert.equal(points[1].tps, 3000)
})

test('the pair decides which episode supplies the number, not only the label', () => {
  /**
   * Two simultaneous deltas with different magnitudes: 200 estimated tokens of output and
   * 100 of reasoning. Whichever is delivered last opens the episode in force, and that
   * episode's own mass and clock produce the number — so two scripts totalling the same 500
   * estimated tokens publish different rates. Each script adds two 100-token follow-ups in the
   * phase the pair leaves in force, which is what brings that episode over the three-sample
   * gate; the totals stay equal because the follow-ups weigh the same in both.
   */
  const outputFirst = driveOrdered(new TurnTelemetryStore(), [
    [0, 'output', 800], [0, 'reasoning', 400], [50, 'reasoning', 400], [100, 'reasoning', 400],
  ], { settledAtMs: 200 })
  const reasoningFirst = driveOrdered(new TurnTelemetryStore(), [
    [0, 'reasoning', 400], [0, 'output', 800], [50, 'output', 400], [100, 'output', 400],
  ], { settledAtMs: 200 })
  const a = outputFirst.curve.attempts[0]
  const b = reasoningFirst.curve.attempts[0]

  assert.deepEqual(a.points.map(point => point.activePhase), ['reasoning', 'reasoning', 'reasoning'])
  assert.deepEqual(b.points.map(point => point.activePhase), ['output', 'output', 'output'])

  assert.equal(a.points[1].tps, Math.round(300 * 1000 / 100),
    'output then reasoning: the reasoning episode measures its own three 100-token deltas '
    + 'over its own first 100 ms')
  assert.equal(b.points[1].tps, Math.round(400 * 1000 / 100),
    'reasoning then output: the output episode measures its own 200-token delta and two '
    + '100-token follow-ups over its own first 100 ms')
  assert.deepEqual(a.points.map(point => point.tps), [null, 3000, 1500])
  assert.deepEqual(b.points.map(point => point.tps), [null, 4000, 2000])

  assert.equal(a.tokens, 500, 'the same evidence whichever episode is in force')
  assert.equal(b.tokens, 500)
  assert.notEqual(a.points[1].tps, Math.round(500 * 1000 / 100),
    'and the numerator is the episode\'s own mass, never the whole attempt\'s')
  assert.equal(outputFirst.curve.peakTps, 3000)
  assert.equal(reasoningFirst.curve.peakTps, 4000)
})

test('the same evidence in the same order produces the same series, twice', () => {
  /** The estimator is a pure function of the ordered evidence; no state leaks between runs. */
  const seriesOf = settled => settled.curve.attempts[0].points
    .map(point => [point.localMs, point.tps, point.activePhase])
  const script = [[0, 'output'], [0, 'reasoning'], [50, 'reasoning'], [100, 'reasoning']]
  assert.deepEqual(
    seriesOf(driveOrdered(new TurnTelemetryStore(), script, { settledAtMs: 200 })),
    seriesOf(driveOrdered(new TurnTelemetryStore(), script, { settledAtMs: 200 })),
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
   * The array below lists the output delta first, but its ordinal says it is the later member
   * at instant 0. The two further output deltas at 50 and 100 ms belong to that same episode,
   * so the ordinal's reading is three 20-token samples over the episode's own first 100 ms.
   *
   * Array position would instead make the reasoning delta the later member at that instant:
   * the output episode would then open at 50 ms, hold two samples, and be withheld. That
   * counterfactual is asserted below, so this test fails if the ordinal ever stops deciding.
   */
  const shuffled = [
    { attemptId: 'a', activeTimeMs: 0, phase: 'output', tokens: 20, sampleOrder: 1 },
    { attemptId: 'a', activeTimeMs: 0, phase: 'reasoning', tokens: 10, sampleOrder: 0 },
    { attemptId: 'a', activeTimeMs: 50, phase: 'output', tokens: 20, sampleOrder: 2 },
    { attemptId: 'a', activeTimeMs: 100, phase: 'output', tokens: 20, sampleOrder: 3 },
  ]
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, shuffled)
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [[0, null], [100, 600]],
    'the output episode is in force: 60 * 1000 / 100 = 600 at the end of its own first step')
  assert.equal(trace.points.at(-1).activePhase, 'output',
    'the ordinal, not the array position, decides: sampleOrder 1 is the later member')
  assert.equal(trace.points.at(-1).episodeStartMs, 0,
    'so the episode in force opened at the shared instant, not at the first follow-up')
  assert.equal(trace.points.at(-1).episodeSampleCount, 3)

  /** The same four samples with array position as the only order: the episode opens too late. */
  const byArrayPosition = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, [
    { attemptId: 'a', activeTimeMs: 0, phase: 'output', tokens: 20 },
    { attemptId: 'a', activeTimeMs: 0, phase: 'reasoning', tokens: 10 },
    { attemptId: 'a', activeTimeMs: 50, phase: 'output', tokens: 20 },
    { attemptId: 'a', activeTimeMs: 100, phase: 'output', tokens: 20 },
  ])
  assert.deepEqual(byArrayPosition.points.map(point => [point.localMs, point.tps]),
    [[0, null], [50, null], [100, null]],
    'if array position decided, the output episode would open at 50 ms with two samples and '
    + 'publish nothing anywhere')
})

test('the series sampler and the attempt trace resolve a tie the same way', () => {
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, simultaneous('output', 'reasoning'))
  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps, point.activePhase]), [
    [0, null, 'reasoning'], [100, 300, 'reasoning'],
  ], 'the reasoning delta is the later member, and its episode publishes 30 * 1000 / 100 = 300')

  const reversed = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 100 }, simultaneous('reasoning', 'output'))
  assert.deepEqual(reversed.points.map(point => [point.localMs, point.tps, point.activePhase]), [
    [0, null, 'output'], [100, 600, 'output'],
  ], 'delivered the other way round the output episode is in force: 60 * 1000 / 100 = 600')

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
  const settled = driveOrdered(
    new TurnTelemetryStore(),
    [[0, 'output'], [0, 'reasoning'], [50, 'reasoning'], [100, 'reasoning']],
    { settledAtMs: 200 },
  )
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

  /** Three deltas per attempt: with two, neither episode could publish a rate at all. */
  const abandoned = store.beginAttempt(record, { attemptId: 'retry-1', step: 1, startedAtMs: 0 })
  for (const at of [0, 50, 100]) {
    store.acceptChunk(record, abandoned, { timeMs: at, chunk: outputChunk('a'.repeat(400)) })
  }
  store.settleAttempt(abandoned, {
    settledAtMs: 100,
    settlementKind: 'attempt',
    surfaceCommitted: false,
    attemptOutcome: 'retried',
  })

  const retry = store.beginAttempt(record, { attemptId: 'retry-2', step: 1, startedAtMs: 200 })
  for (const at of [200, 250, 300]) {
    store.acceptChunk(record, retry, { timeMs: at, chunk: reasoningChunk('b'.repeat(400)) })
  }
  store.settleAttempt(retry, {
    settledAtMs: 300,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  const settled = store.endTurn(record, { timeMs: 500, status: 'completed' })
  const [first, second] = settled.curve.attempts
  assert.equal(first.points[0].activePhase, 'output', 'the abandoned prefix keeps its own tone')
  assert.equal(second.points[0].activePhase, 'reasoning',
    'and the retry is labelled from its own first sample, never the abandoned one')
  assert.equal(second.points[0].tps, null, 'its episode opens at its own local zero')
  assert.equal(second.points[0].rateUnavailableReason, 'opening-anchor')
  assert.equal(second.points.at(-1).tps, Math.round(300 * 1000 / 100),
    'nor does it inherit the abandoned prefix\'s tokens: 300 over its own 100 ms, not 600')
  assert.equal(second.points.at(-1).tps, 3000)
  assert.equal(first.points.at(-1).tps, 3000)
})
