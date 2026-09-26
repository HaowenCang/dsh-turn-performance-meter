/**
 * The curve source: the join between the stored attempts and their calibrated allocation.
 *
 * ## What is frozen here
 *
 * Calibration happens exactly once, in `calibrateAttemptSamples`, and this module reads its
 * output. It is a **join**, not a second algorithm: a duplicate scaling rule would be free
 * to drift from the one the card's printed token totals use, which is exactly the defect
 * Phase 7C removed.
 *
 * The invariants, in the order the acceptance gate names them:
 *
 *   1. with authoritative usage, the curve-source samples of an attempt sum to its
 *      `outputTokens`;
 *   2. when the provider also reports `reasoningTokens`, the reasoning samples sum to that
 *      counter and the output samples to `outputTokens - reasoningTokens`;
 *   3. when only `outputTokens` exists, one common scale is applied across both phases, the
 *      split stays `estimated`, and the combined samples still sum to `outputTokens`;
 *   4. with no usage at all, the magnitudes stay the raw shape and `calibratedForCurve` is
 *      `false` — no provider total is invented;
 *   5. the raw evidence is never mutated: `record.attempts[].samples` remains the
 *      provenance, and the join produces new objects;
 *   6. the join is **positional and verified**. A disagreement in `attemptId`, `step` or
 *      sample count degrades the whole join to the raw shape rather than attaching one
 *      attempt's calibration to another.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveSource } from '../src/core/curve-source.js'
import { aggregateTurn } from '../src/core/aggregate-turn.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'

const DELTA_CHARACTERS = 400
const RAW_DELTA_WEIGHT = 100

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })

function deltaChunk(kind) {
  const text = 'x'.repeat(DELTA_CHARACTERS)
  assert.equal(heuristicTokenWeight(text), RAW_DELTA_WEIGHT,
    `the generator assumes ${DELTA_CHARACTERS} characters weigh ${RAW_DELTA_WEIGHT}`)
  return kind === 'reasoning' ? reasoning(text) : output(text)
}

/** Drive one turn from a script; `usage` may be `null` for an attempt with none. */
function drive(attempts) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  attempts.forEach((spec, index) => {
    const attempt = store.beginAttempt(record, { attemptId: spec.id, step: spec.step ?? index + 1, startedAtMs: 0 })
    for (const [timeMs, kind] of spec.script) {
      store.acceptChunk(record, attempt, { timeMs, chunk: deltaChunk(kind) })
    }
    store.settleAttempt(attempt, {
      settledAtMs: 0,
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
      usage: spec.usage ?? null,
      settlementSeq: spec.step ?? index + 1,
    })
  })
  return { store, record, settled: store.endTurn(record, { timeMs: 10_000, status: 'completed' }) }
}

/** Sum one phase's curve-source magnitudes for one attempt of a source. */
function phaseSum(attempt, phase) {
  return (attempt.samples ?? [])
    .filter(sample => sample.phase === phase)
    .reduce((sum, sample) => sum + sample.tokens, 0)
}

const sumOf = attempt => (attempt.samples ?? []).reduce((sum, sample) => sum + sample.tokens, 0)

test('with authoritative usage the curve samples sum to the provider total', () => {
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'output'], [500, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
  ])
  const source = curveSource(record.attempts, settled.attemptBreakdown)
  assert.equal(source.aligned, true)
  assert.equal(source.calibratedForCurve, true)
  assert.equal(source.calibrationCoverage, 'full')
  assert.equal(source.calibratedCount, 1)
  assert.deepEqual(source.issues, [])

  const [attempt] = source.attempts
  assert.ok(Math.abs(sumOf(attempt) - 900) < 1e-9,
    `the calibrated samples must sum to outputTokens; they sum to ${sumOf(attempt)}`)
  assert.deepEqual(attempt.samples.map(sample => sample.tokens), [450, 450])
  assert.equal(attempt.anchored, true)
  for (const sample of attempt.samples) {
    assert.equal(sample.quality, 'calibrated')
    /** The provenance is carried through, not replaced. */
    assert.equal(sample.weight, RAW_DELTA_WEIGHT, 'the raw shape weight survives on the sample')
  }
})

test('an exact reasoning split calibrates both phases to the provider counters', () => {
  const { record, settled } = drive([
    {
      id: 'a',
      script: [[0, 'reasoning'], [500, 'reasoning'], [1000, 'output']],
      usage: { outputTokens: 1000, reasoningTokens: 600 },
    },
  ])
  const [attempt] = curveSource(record.attempts, settled.attemptBreakdown).attempts
  assert.ok(Math.abs(phaseSum(attempt, 'reasoning') - 600) < 1e-9)
  assert.ok(Math.abs(phaseSum(attempt, 'output') - 400) < 1e-9)
  assert.ok(Math.abs(sumOf(attempt) - 1000) < 1e-9)
  /** The two counters are never added: reasoning is a subset of output. */
  assert.equal(sumOf(attempt), 600 + 400)
  assert.notEqual(sumOf(attempt), 600 + 1000)
})

test('without reasoningTokens one common scale is applied and the split stays estimated', () => {
  const { record, settled } = drive([
    {
      id: 'a',
      script: [[0, 'reasoning'], [500, 'reasoning'], [1000, 'output']],
      usage: { outputTokens: 1200 },
    },
  ])
  const aggregateAttempt = settled.attemptBreakdown[0]
  const [attempt] = curveSource(record.attempts, settled.attemptBreakdown).attempts
  assert.equal(aggregateAttempt.calibration.splitQuality, 'estimated',
    'the split was never measured, so claiming it exact would be a fabrication')
  /** One scale for both phases: the ratio of the raw shapes is preserved exactly. */
  assert.ok(Math.abs(phaseSum(attempt, 'reasoning') / phaseSum(attempt, 'output') - 2) < 1e-9,
    'the raw reasoning:output ratio of 2:1 survives the common scale')
  assert.ok(Math.abs(sumOf(attempt) - 1200) < 1e-9,
    'and the combined samples still sum to the provider total')
})

test('missing usage leaves the estimated raw shape and invents nothing', () => {
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'output'], [500, 'output']], usage: null },
  ])
  const source = curveSource(record.attempts, settled.attemptBreakdown)
  assert.equal(source.calibratedForCurve, false, 'no anchor exists to calibrate toward')
  assert.equal(source.calibratedCount, 0)
  assert.equal(settled.generatedTokens, null)

  const [attempt] = source.attempts
  assert.equal(sumOf(attempt), 2 * RAW_DELTA_WEIGHT, 'the raw shape is kept as it was measured')
  assert.equal(attempt.anchored, undefined, 'and is never labelled anchored')
  for (const sample of attempt.samples) assert.equal(sample.quality, 'estimated')
})

test('attempts are calibrated independently, one scale each', () => {
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'output'], [500, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
    { id: 'b', script: [[0, 'output'], [500, 'output']], usage: { outputTokens: 300, reasoningTokens: 0 } },
    { id: 'c', script: [[0, 'output'], [500, 'output']], usage: null },
  ])
  const source = curveSource(record.attempts, settled.attemptBreakdown)
  assert.equal(source.contributingCount, 3)
  assert.equal(source.calibratedCount, 2)
  assert.deepEqual(source.attempts.map(attempt => sumOf(attempt)),
    [900, 300, 2 * RAW_DELTA_WEIGHT],
    'each attempt carries its own provider anchor, and the unanchored one its own shape')
  assert.deepEqual(source.attempts.map(attempt => attempt.anchored), [true, true, false],
    'an attempt inside an aligned join that reported no usage is explicitly unanchored')
  /**
   * **The curve as a whole is not calibrated.** Two of three attempts are anchored, so the
   * provenance is `partial` and `calibratedForCurve` — which means "the whole curve" — is
   * false. The previous revision reported `true` here because *some* attempt was calibrated,
   * which told every consumer of the boolean that a curve one third of which was still a raw
   * heuristic shape was a calibrated curve.
   */
  assert.equal(source.calibrationCoverage, 'partial')
  assert.equal(source.calibratedForCurve, false)
  assert.deepEqual(source.issues, [],
    'and the missing usage is not an alignment problem: it is a magnitude-quality one')
})

test('tool-call argument samples are inside the calibrated total', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: deltaChunk('output') })
  store.acceptChunk(record, attempt, {
    timeMs: 500,
    chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'pwsh', argumentsDelta: 'x'.repeat(400) },
  })
  store.settleAttempt(attempt, {
    settledAtMs: 550,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 900, reasoningTokens: 0 },
    settlementSeq: 1,
  })
  const settled = store.endTurn(record, { timeMs: 1000, status: 'completed' })

  const [curveAttempt] = curveSource(record.attempts, settled.attemptBreakdown).attempts
  assert.deepEqual(curveAttempt.samples.map(sample => sample.phase), ['output', 'output'],
    'tool-call arguments are model output, not a third phase')
  assert.equal(sumOf(curveAttempt), 900, 'and they are inside the calibrated total')
})

test('the raw evidence is never mutated by the join', () => {
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'output'], [500, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
  ])
  const before = record.attempts[0].samples.map(sample => ({ ...sample }))
  const source = curveSource(record.attempts, settled.attemptBreakdown)

  assert.notEqual(source.attempts[0], record.attempts[0], 'the join produces a new attempt object')
  assert.deepEqual(record.attempts[0].samples, before,
    'the stored samples are untouched: they remain the provenance')
  assert.deepEqual(record.attempts[0].samples.map(sample => sample.tokens), [100, 100],
    'including their raw shape magnitudes')
})

test('a sample-count mismatch degrades the whole join rather than half of it', () => {
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'output'], [500, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
  ])
  const broken = settled.attemptBreakdown.map(entry => ({
    ...entry,
    calibration: { ...entry.calibration, samples: entry.calibration.samples.slice(0, 1) },
  }))
  const source = curveSource(record.attempts, broken)
  assert.equal(source.aligned, false)
  assert.equal(source.calibratedForCurve, false)
  assert.equal(source.attempts, record.attempts, 'the raw evidence is returned untouched')
  assert.match(source.issues.join(' '), /misaligned/)
  assert.match(source.issues.join(' '), /samples against/)
})

test('an attemptId disagreement degrades the join and names both identities', () => {
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
    { id: 'b', script: [[0, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
  ])
  /** Swap the two reductions: positionally plausible, identity-wise wrong. */
  const swapped = [settled.attemptBreakdown[1], settled.attemptBreakdown[0]]
  const source = curveSource(record.attempts, swapped)
  assert.equal(source.aligned, false)
  assert.equal(source.calibratedForCurve, false)
  /**
   * Both positions are reported, and each swap is caught by **every** check that can see
   * it: the identities disagree and the sample counts differ, because the two attempts
   * produced different numbers of deltas. Reporting all of them is the point — a join that
   * stopped at the first symptom would still be attaching one attempt's calibration to
   * another.
   */
  assert.equal(source.issues.length, 4)
  assert.match(source.issues[0], /attempt a reduced as b/)
  assert.match(source.issues[2], /attempt b reduced as a/)
  assert.deepEqual(source.rawFallbackAttemptIds, ['a', 'b'])
})

test('a reduced-attempt shortfall degrades the join', () => {
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
    { id: 'b', script: [[0, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
  ])
  const source = curveSource(record.attempts, settled.attemptBreakdown.slice(0, 1))
  assert.equal(source.aligned, false)
  assert.match(source.issues[0], /2 contributing attempts against 1 reduced attempts/)
})

test('a step disagreement degrades the join even when the identities agree', () => {
  const { record, settled } = drive([
    { id: 'a', step: 4, script: [[0, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
  ])
  const renamed = settled.attemptBreakdown.map(entry => ({ ...entry, step: 5 }))
  const source = curveSource(record.attempts, renamed)
  assert.equal(source.aligned, false)
  assert.match(source.issues[0], /step 4 reduced as step 5/)
})

test('an attempt with no samples is carried through the join untouched', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const empty = store.beginAttempt(record, { attemptId: 'empty', step: 1, startedAtMs: 0 })
  store.settleAttempt(empty, { settledAtMs: 0, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })
  const real = store.beginAttempt(record, { attemptId: 'real', step: 2, startedAtMs: 100 })
  store.acceptChunk(record, real, { timeMs: 100, chunk: deltaChunk('output') })
  store.settleAttempt(real, {
    settledAtMs: 150,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 500, reasoningTokens: 0 },
    settlementSeq: 2,
  })
  const settled = store.endTurn(record, { timeMs: 1000, status: 'completed' })

  const source = curveSource(record.attempts, settled.attemptBreakdown)
  assert.deepEqual(source.attempts.map(attempt => attempt.attemptId), ['empty', 'real'],
    'the empty attempt is retained, so the source agrees with the turn\'s own attempt count')
  assert.equal(source.contributingCount, 1, 'but it is not a contributing attempt')
  assert.equal(source.attempts[0], record.attempts[0], 'and it is passed through by identity')
  assert.equal(sumOf(source.attempts[1]), 500)
})

test('the source is a pure function of the two lists it is given', () => {
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'output'], [500, 'output']], usage: { outputTokens: 900, reasoningTokens: 0 } },
  ])
  const first = curveSource(record.attempts, settled.attemptBreakdown)
  const second = curveSource(record.attempts, settled.attemptBreakdown)
  assert.deepEqual(
    first.attempts.map(attempt => attempt.samples.map(sample => sample.tokens)),
    second.attempts.map(attempt => attempt.samples.map(sample => sample.tokens)),
    'determinism',
  )
  /** Degenerate inputs degrade to the raw list rather than throwing. */
  assert.equal(curveSource(null, null).attempts.length, 0)
  assert.equal(curveSource([], []).aligned, true)
  assert.equal(curveSource([], []).calibratedForCurve, false)
})

test('the join is the same reduction the aggregate published', () => {
  /**
   * The end-to-end statement: `aggregateTurn` calibrates once, and the source the curve is
   * drawn from is that calibration rather than a second one. Every attempt's curve total is
   * therefore the same number the aggregate anchored, which is what makes the printed
   * generated-token total and the curve one magnitude system.
   */
  const { record, settled } = drive([
    { id: 'a', script: [[0, 'reasoning'], [500, 'output']], usage: { outputTokens: 800, reasoningTokens: 300 } },
    { id: 'b', script: [[0, 'output']], usage: { outputTokens: 200 } },
  ])
  const source = curveSource(record.attempts, settled.attemptBreakdown)
  const totals = source.attempts.map(attempt => sumOf(attempt))
  assert.ok(Math.abs(totals[0] - 800) < 1e-9)
  assert.ok(Math.abs(totals[1] - 200) < 1e-9)
  assert.equal(totals.reduce((sum, value) => sum + value, 0), settled.observedGeneratedTokens,
    'and their sum is the partial total the aggregate observed')

  /**
   * The aggregate is a pure function of the record, so re-running it cannot change the
   * numbers the source joined against.
   */
  const again = aggregateTurn({
    turn: record.turn,
    sessionId: record.sessionId,
    turnStartMs: record.startMs,
    turnEndMs: record.endMs,
    firstTokenMs: record.firstTokenMs,
    attempts: record.attempts,
    tools: record.tools,
    status: 'completed',
  })
  assert.deepEqual(
    again.attemptBreakdown.map(entry => entry.calibration.samples.map(sample => sample.tokens)),
    settled.attemptBreakdown.map(entry => entry.calibration.samples.map(sample => sample.tokens)),
  )
})
