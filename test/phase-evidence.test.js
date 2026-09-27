/**
 * Phase 7C.2 — the phase-evidence contradiction matrix and the anchored-integral invariant.
 *
 * ## The defect this file freezes out
 *
 * A provider can report an authoritative **total** (`outputTokens`) and, on some routes,
 * authoritative **phase counters** (`reasoningTokens`). The stream independently reports
 * **where** generation happened. When the two disagree about whether a phase is present,
 * the old pipeline calibrated each phase against its own counter anyway and then published
 * `totalAnchored: true`:
 *
 *     outputTokens = 144, reasoningTokens = 74, stream = output deltas only
 *     -> reasoning calibrated to 74 over zero samples, output calibrated to 70
 *     -> sum(samples) = 70        while totalAnchored = true and generatedTokens = 144
 *
 * The 74 reasoning tokens vanished from the curve while every consumer was told the attempt
 * was anchored. The invariant asserted throughout this file is the one that was missing:
 *
 *     totalAnchored === true   =>   sum(calibration.samples[].tokens) === outputTokens
 *
 * ## What is frozen here
 *
 *   1. the *valid* exact split still calibrates each phase to its own counter;
 *   2. an absent `reasoningTokens` is a quality level, not a conflict, and still uses one
 *      common scale;
 *   3. every contradiction direction — both phases, in both polarities, plus the
 *      impossible split — falls back to one common total scale;
 *   4. a missing observed phase never loses provider tokens and never gains a fabricated
 *      sample;
 *   5. a phase the stream really recorded is never zeroed because the provider claimed zero;
 *   6. `reasoningTokens > outputTokens` is never silently clamped into a plausible split;
 *   7. the quality model keeps the counted total independent from the phase mapping;
 *   8. the peak stays approximate at every allocation mode.
 *
 * The unit-level cases go through `calibrateAttemptSamples` and the turn-level ones through
 * `aggregateTurn`, because the contradiction rules used to live in both and disagree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { calibrateAttemptSamples } from '../src/core/token-allocation.js'
import { aggregateTurn } from '../src/core/aggregate-turn.js'
import { curveSource } from '../src/core/curve-source.js'
import { TemporalAllocationMode, PhaseEvidenceIssue } from '../src/core/phase-evidence.js'
import { QualityLevel } from '../src/core/quality-model.js'

const TOLERANCE = 1e-9

const reasoning = (timeMs, weight) => ({ timeMs, phase: 'reasoning', weight })
const output = (timeMs, weight) => ({ timeMs, phase: 'output', weight })

const sampleSum = samples => samples.reduce((sum, sample) => sum + sample.tokens, 0)
const phaseSum = (samples, phase) => samples
  .filter(sample => sample.phase === phase)
  .reduce((sum, sample) => sum + sample.tokens, 0)

/** One attempt for `aggregateTurn`, with the settlement concepts kept explicit. */
function attempt(samples, usage, attemptId = 'a') {
  return {
    attemptId,
    samples,
    usage,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  }
}

/** Aggregate a one-attempt turn and return both the turn and its single reduction. */
function turnOf(samples, usage, options = {}) {
  const settled = aggregateTurn({
    turn: 1,
    turnStartMs: 0,
    turnEndMs: 10_000,
    attempts: [attempt(samples, usage, options.attemptId ?? 'a')],
    tools: options.tools ?? [],
    ...(options.durable === undefined ? {} : { durable: options.durable }),
  })
  return { settled, first: settled.attemptBreakdown[0] }
}

/** Assert the Phase 7C.2 invariant on one reduced attempt. */
function assertAnchoredIntegral(entry, label) {
  const sum = sampleSum(entry.calibration.samples)
  assert.ok(
    Math.abs(sum - entry.usage.outputTokens) < TOLERANCE,
    `${label}: totalAnchored promises sum(samples) === outputTokens; ${sum} against ${entry.usage.outputTokens}`,
  )
}

// ── 1. the valid exact split must not regress ────────────────────────────────

test('1. a valid exact split still calibrates each phase to its own provider counter', () => {
  const samples = [reasoning(0, 10), reasoning(1000, 30), output(2000, 30), output(3000, 30)]
  const result = calibrateAttemptSamples(samples, { outputTokens: 1000, reasoningTokens: 600 })

  assert.equal(phaseSum(result.samples, 'reasoning'), 600)
  assert.equal(phaseSum(result.samples, 'output'), 400)
  assert.equal(sampleSum(result.samples), 1000)
  assert.equal(result.totalAnchored, true)
  assert.equal(result.splitQuality, 'exact')
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.PHASE_ANCHORED)
  assert.equal(result.evidence.splitUsable, true)
  assert.deepEqual(result.evidence.contradictions, [])
  assert.equal(result.note, null)
})

// ── 2. an absent counter is not a conflict ───────────────────────────────────

test('2. missing reasoningTokens is a normal total-only calibration, not a contradiction', () => {
  const samples = [reasoning(0, 10), reasoning(1000, 30), output(2000, 30), output(3000, 30)]
  const result = calibrateAttemptSamples(samples, { outputTokens: 1000 })

  assert.equal(sampleSum(result.samples), 1000)
  assert.equal(result.totalAnchored, true)
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.equal(result.splitQuality, 'estimated', 'the split was never measured')
  assert.deepEqual(result.evidence.contradictions, [], 'no counter arrived, so nothing was contradicted')
  /** The raw 1:3 reasoning:output shape ratio survives the one common scale. */
  assert.equal(phaseSum(result.samples, 'reasoning'), 400)
  assert.equal(phaseSum(result.samples, 'output'), 600)
  assert.equal(phaseSum(result.samples, 'reasoning') / phaseSum(result.samples, 'output'), 400 / 600)
})

test('2b. an absent counter with a single observed phase still reports no contradiction', () => {
  const result = calibrateAttemptSamples([output(0, 5), output(500, 5)], { outputTokens: 300 })
  assert.equal(sampleSum(result.samples), 300)
  assert.deepEqual(result.evidence.contradictions, [])
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
})

test('2c. no authoritative total at all leaves the magnitudes unanchored and silent about phases', () => {
  const result = calibrateAttemptSamples([output(0, 5), reasoning(500, 5)], null)
  assert.equal(result.totalAnchored, false)
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.UNANCHORED)
  assert.deepEqual(result.evidence.contradictions, [])
  assert.equal(result.phaseTokens.reasoning, null)
})

// ── 3. counterexample A: provider reasoning with no reasoning deltas ─────────

test('3. counterexample A — reasoningTokens > 0 with no reasoning delta keeps the total', () => {
  const samples = [output(0, 5), output(500, 5)]
  const result = calibrateAttemptSamples(samples, { outputTokens: 100, reasoningTokens: 70 })

  assert.equal(sampleSum(result.samples), 100, 'old behaviour calibrated this to 30')
  assert.notEqual(sampleSum(result.samples), 30)
  assert.equal(result.samples.filter(sample => sample.phase === 'reasoning').length, 0,
    'no reasoning sample may be invented')
  assert.equal(result.totalAnchored, true)
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.notEqual(result.splitQuality, 'exact')
  assert.deepEqual(result.evidence.contradictions.map(entry => entry.kind),
    [PhaseEvidenceIssue.REASONING_WITHOUT_DELTAS])
})

test('3b. counterexample A at turn level: the curve keeps the authoritative total', () => {
  const { settled, first } = turnOf(
    [output(0, 5), output(500, 5)],
    { outputTokens: 100, reasoningTokens: 70 },
  )

  assertAnchoredIntegral(first, 'counterexample A')
  assert.equal(settled.generatedTokens, 100)
  assert.equal(settled.quality.tokenTotalQuality, QualityLevel.EXACT,
    'the counted total is unaffected by the phase mapping')
  assert.notEqual(settled.quality.phaseSplitQuality, QualityLevel.EXACT)
  assert.equal(settled.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.equal(settled.phaseMismatchAttemptCount, 1)
  assert.ok(settled.consistencyIssues.length >= 1, 'the contradiction is reported, not swallowed')
  assert.equal(settled.phaseTokens.reasoning + settled.phaseTokens.output, 100,
    'the published phase pair is the anchored attribution, not the unusable provider split')

  const source = curveSource([attempt([output(0, 5), output(500, 5)], { outputTokens: 100, reasoningTokens: 70 })],
    settled.attemptBreakdown)
  assert.equal(source.calibrationCoverage, 'full')
  assert.equal(source.attempts[0].anchored, true)
  assert.equal(source.attempts[0].temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
})

// ── 4. counterexample B: provider reasoning = 0 beside real reasoning deltas ─

test('4. counterexample B — reasoningTokens = 0 no longer zeroes a real reasoning phase', () => {
  const samples = [reasoning(0, 5), reasoning(500, 5), output(1000, 5), output(1500, 5)]
  const result = calibrateAttemptSamples(samples, { outputTokens: 100, reasoningTokens: 0 })

  assert.equal(phaseSum(result.samples, 'reasoning'), 50,
    'the stream showed real reasoning generation, so its evidence is not zeroed')
  assert.notEqual(phaseSum(result.samples, 'reasoning'), 0)
  assert.equal(sampleSum(result.samples), 100)
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.deepEqual(result.evidence.contradictions.map(entry => entry.kind),
    [PhaseEvidenceIssue.REASONING_ZERO_WITH_DELTAS])
})

test('4b. counterexample B at turn level keeps a non-zero reasoning-coloured curve', () => {
  const samples = [reasoning(0, 5), reasoning(500, 5), output(1000, 5), output(1500, 5)]
  const { settled, first } = turnOf(samples, { outputTokens: 100, reasoningTokens: 0 })

  assertAnchoredIntegral(first, 'counterexample B')
  /**
   * The rejected reading gave `reasoning sample = 0, output sample = 100` because the
   * provider's zero counter was applied as the reasoning phase's exact temporal total. The
   * common scale instead divides the total across both observed phases, so each reasoning
   * delta keeps a real magnitude and the reasoning-coloured evidence stays on the curve.
   *
   * The distinction that matters here is between the two claims: `phaseTokens.reasoning` is
   * the provider's summary counter (0, as reported) and is *not* republished as the curve's
   * phase allocation; the per-delta samples are the temporal allocation, and they are what
   * must not be zeroed.
   */
  const reasoningSamples = first.calibration.samples.filter(sample => sample.phase === 'reasoning')
  assert.equal(reasoningSamples.length, 2)
  for (const sample of reasoningSamples) {
    assert.ok(sample.tokens > 0, 'a reasoning delta the stream really emitted is never calibrated to zero')
  }
  assert.equal(phaseSum(first.calibration.samples, 'reasoning'), 50)
  assert.equal(phaseSum(first.calibration.samples, 'output'), 50)
  assert.equal(first.calibration.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.notEqual(first.calibration.temporalAllocationMode, TemporalAllocationMode.PHASE_ANCHORED,
    'calibrating the reasoning phase to the contradicted 0 counter is the defect')

  assert.equal(settled.quality.tokenTotalQuality, QualityLevel.EXACT)
  assert.notEqual(settled.quality.phaseSplitQuality, QualityLevel.EXACT)
  assert.ok(settled.consistencyIssues.some(issue => /reasoningTokens=0/.test(issue)),
    'the original Phase 3 wording is preserved for this direction')
})

// ── 5 & 6. the output phase, both polarities ─────────────────────────────────

test('5. non-reasoning tokens with no output delta fall back to the total scale', () => {
  const samples = [reasoning(0, 5), reasoning(500, 5)]
  const result = calibrateAttemptSamples(samples, { outputTokens: 100, reasoningTokens: 40 })

  assert.equal(sampleSum(result.samples), 100)
  assert.equal(phaseSum(result.samples, 'reasoning'), 100,
    'all observed samples absorb the total when the output phase has no evidence')
  assert.equal(result.samples.filter(sample => sample.phase === 'output').length, 0)
  assert.deepEqual(result.evidence.contradictions.map(entry => entry.kind),
    [PhaseEvidenceIssue.OUTPUT_WITHOUT_DELTAS])
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
})

test('6. counterexample C — non-reasoning = 0 with output deltas is not calibrated to zero', () => {
  const samples = [reasoning(0, 5), output(500, 5), output(1000, 5)]
  const result = calibrateAttemptSamples(samples, { outputTokens: 100, reasoningTokens: 100 })

  assert.equal(sampleSum(result.samples), 100)
  assert.deepEqual(result.evidence.contradictions.map(entry => entry.kind),
    [PhaseEvidenceIssue.OUTPUT_ZERO_WITH_DELTAS])
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.notEqual(result.splitQuality, 'exact')
  /**
   * The point of the counterexample is that output deltas are never **zeroed** by the
   * provider's `non-reasoning = 0` claim. Every observed sample keeps whatever magnitude the
   * common scale gives it, so the output phase is non-zero whenever its own shape weight is.
   */
  assert.ok(phaseSum(result.samples, 'output') > 0,
    'the output phase keeps a real magnitude instead of being pinned to zero')
})

test('6b. counterexample C with non-degenerate output weight keeps a real output colour', () => {
  const samples = [reasoning(0, 1), output(500, 3), output(1000, 3)]
  const { settled, first } = turnOf(samples, { outputTokens: 100, reasoningTokens: 100 })

  assertAnchoredIntegral(first, 'counterexample C')
  /**
   * The provider says the non-reasoning phase produced **nothing**, while the stream clearly
   * emitted two output deltas. Calibrating that phase to its counter would zero two real
   * observations; the common scale gives every observed sample a magnitude instead. As in
   * 4b, the provider's `phaseTokens` remain its own summary statement — the curve's
   * allocation is the samples.
   */
  const outputSamples = first.calibration.samples.filter(sample => sample.phase === 'output')
  assert.equal(outputSamples.length, 2)
  for (const sample of outputSamples) {
    assert.ok(sample.tokens > 0, 'a real output delta is never zeroed by a provider claim of 0')
  }
  assert.ok(phaseSum(first.calibration.samples, 'reasoning') > 0)
  assert.equal(first.calibration.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.equal(settled.quality.tokenTotalQuality, QualityLevel.EXACT)
  assert.notEqual(settled.quality.phaseSplitQuality, QualityLevel.EXACT)
  assert.equal(settled.quality.displayPhaseSplit, 'approximate')
})

// ── 7. counterexample D: the impossible split ────────────────────────────────

test('7. counterexample D — reasoningTokens > outputTokens is refused, never clamped', () => {
  const samples = [reasoning(0, 5), output(1000, 5)]
  const result = calibrateAttemptSamples(samples, { outputTokens: 100, reasoningTokens: 120 })

  assert.equal(sampleSum(result.samples), 100, 'outputTokens itself is still authoritative')
  assert.equal(result.totalTokens, 100)
  assert.equal(result.totalAnchored, true)
  assert.equal(result.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.deepEqual(result.evidence.contradictions.map(entry => entry.kind),
    [PhaseEvidenceIssue.IMPOSSIBLE_SPLIT])
  assert.equal(result.evidence.splitUsable, false)
  assert.notEqual(result.splitQuality, 'exact')
  /**
   * The rejected readings: clamping to `outputTokens - reasoningTokens = 0` would publish a
   * fabricated zero for a phase the provider never said was empty, and keeping the raw
   * counter would publish a **negative** non-reasoning count. Both are refused, so neither
   * phase of the impossible split is published at all.
   */
  assert.equal(result.phaseTokens.output, null, 'no negative or clamped phase count is published')
  assert.equal(result.phaseTokens.reasoning, null)
  assert.equal(result.evidence.contradictions[0].provider, 120,
    'the provider counter itself is still reported, as the evidence it is')
})

test('7b. counterexample D at turn level reports the impossibility and keeps the curve anchored', () => {
  const samples = [reasoning(0, 5), output(1000, 5)]
  const { settled, first } = turnOf(samples, { outputTokens: 100, reasoningTokens: 120 })

  assertAnchoredIntegral(first, 'counterexample D')
  assert.equal(settled.generatedTokens, 100, 'the counted total survives an impossible split')
  assert.equal(settled.quality.tokenTotalQuality, QualityLevel.EXACT)
  assert.notEqual(settled.quality.phaseSplitQuality, QualityLevel.EXACT)
  assert.ok(settled.consistencyIssues.some(issue => /exceeds outputTokens/.test(issue)))
  assert.equal(settled.quality.approximatePhaseSplit, true)
})

// ── 8. tool-call arguments ───────────────────────────────────────────────────

test('8. tool-call argument samples are inside the anchored total in every mode', () => {
  /** A tool-call delta is model output: `classifyDelta` already labels it `output`. */
  const samples = [
    reasoning(0, 5),
    { timeMs: 500, phase: 'output', weight: 5 },
    { timeMs: 1000, phase: 'output', weight: 5 },
  ]
  for (const usage of [
    { outputTokens: 500, reasoningTokens: 200 },
    { outputTokens: 500, reasoningTokens: 600 },
    { outputTokens: 500 },
  ]) {
    const result = calibrateAttemptSamples(samples, usage)
    assert.ok(Math.abs(sampleSum(result.samples) - 500) < TOLERANCE,
      `${JSON.stringify(usage)} must still integrate to 500`)
    assert.equal(result.temporalAllocationMode !== TemporalAllocationMode.UNANCHORED, true)
  }
})

// ── 9. retries are calibrated independently ──────────────────────────────────

test('9. a retried attempt pair is calibrated independently, first attempt included', () => {
  const settled = aggregateTurn({
    turn: 1,
    turnStartMs: 0,
    turnEndMs: 20_000,
    attempts: [
      attempt([output(0, 5), output(500, 5)], { outputTokens: 80, reasoningTokens: 30 }, 'retry-1'),
      attempt([output(10_000, 5), output(10_500, 5)], { outputTokens: 40, reasoningTokens: 0 }, 'retry-2'),
    ],
  })

  assert.equal(settled.contributingAttemptCount, 2)
  for (const entry of settled.attemptBreakdown) assertAnchoredIntegral(entry, `retry ${entry.attemptId}`)
  assert.equal(settled.attemptBreakdown[0].temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED,
    'the first attempt contradicts the stream, so its phase mapping is refused')
  assert.equal(settled.attemptBreakdown[1].temporalAllocationMode, TemporalAllocationMode.PHASE_ANCHORED,
    'the second attempt agrees with the stream and keeps its exact phase calibration')
  assert.equal(settled.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED,
    'the turn reports the weakest mode among its attempts')
  assert.equal(settled.generatedTokens, 120)
})

// ── 10 & 11. coverage extremes ───────────────────────────────────────────────

test('10. partial usage across attempts anchors only the attempts that reported', () => {
  const settled = aggregateTurn({
    turn: 1,
    turnStartMs: 0,
    turnEndMs: 20_000,
    attempts: [
      attempt([output(0, 5), output(500, 5)], { outputTokens: 200, reasoningTokens: 0 }, 'a'),
      attempt([output(10_000, 5), output(10_500, 5)], null, 'b'),
    ],
  })

  assert.equal(settled.usageComplete, false)
  assert.equal(settled.generatedTokens, null, 'an incomplete total is never published as a number')
  assert.equal(settled.observedGeneratedTokens, 200)
  const [anchored, unanchored] = settled.attemptBreakdown
  assertAnchoredIntegral(anchored, 'the attempt with usage')
  assert.equal(anchored.totalAnchored, true)
  assert.equal(unanchored.totalAnchored, false)
  assert.equal(unanchored.temporalAllocationMode, TemporalAllocationMode.UNANCHORED)
  assert.deepEqual(settled.consistencyIssues, [], 'missing usage is a gap, not a contradiction')
})

test('11. a turn with no usage keeps estimated magnitudes and reports no contradiction', () => {
  const settled = aggregateTurn({
    turn: 1,
    turnStartMs: 0,
    turnEndMs: 5000,
    attempts: [attempt([output(0, 5), output(500, 5)], null)],
  })

  assert.equal(settled.usageAttemptCount, 0)
  assert.equal(settled.generatedTokens, null)
  assert.equal(settled.attemptBreakdown[0].totalAnchored, false)
  assert.deepEqual(settled.consistencyIssues, [])
  assert.equal(settled.temporalAllocationMode, TemporalAllocationMode.UNANCHORED)
  assert.equal(settled.quality.tokenTotalQuality, QualityLevel.UNAVAILABLE)
})

// ── 14 & 16. no fabrication, and the peak stays approximate ──────────────────

test('14. a phase contradiction never fabricates, never drops and never zeroes a sample', () => {
  const samples = [reasoning(0, 5), output(500, 5), output(1000, 5)]
  for (const usage of [
    { outputTokens: 100, reasoningTokens: 70 },
    { outputTokens: 100, reasoningTokens: 0 },
    { outputTokens: 100, reasoningTokens: 100 },
    { outputTokens: 100, reasoningTokens: 120 },
    { outputTokens: 100 },
  ]) {
    const result = calibrateAttemptSamples(samples, usage)
    assert.equal(result.samples.length, samples.length,
      `${JSON.stringify(usage)}: no sample may be added or removed`)
    assert.deepEqual(result.samples.map(sample => sample.timeMs), [0, 500, 1000],
      'the temporal positions are the stream\'s own, unchanged')
    assert.deepEqual(result.samples.map(sample => sample.phase), ['reasoning', 'output', 'output'],
      'the observed phase labels are preserved')
    for (const sample of result.samples) {
      assert.equal(Number.isFinite(sample.tokens), true)
      assert.ok(sample.tokens >= 0, 'no negative per-delta magnitude')
    }
  }
})

test('15. the peak stays approximate at every allocation mode', () => {
  const cases = [
    ['phase-anchored', { outputTokens: 1000, reasoningTokens: 600 }],
    ['total-anchored (absent counter)', { outputTokens: 1000 }],
    ['total-anchored (contradiction)', { outputTokens: 1000, reasoningTokens: 900 }],
  ]
  for (const [label, usage] of cases) {
    const { settled, first } = turnOf(
      [reasoning(0, 10), reasoning(1000, 10), output(2000, 10), output(3000, 10)],
      usage,
    )
    assertAnchoredIntegral(first, label)
    assert.notEqual(settled.quality.temporalShapeQuality, QualityLevel.EXACT,
      `${label}: a reconstructed shape is never exact`)
    assert.equal(settled.quality.displayPhaseSplit === 'exact',
      settled.quality.phaseSplitQuality === QualityLevel.EXACT)
    /**
     * The peak is a trailing-window rate over reconstructed per-delta magnitudes, so it
     * carries `≈` at every mode. Nothing here may expose a provider-exact peak.
     */
    const published = settled.phaseTokens.reasoning + settled.phaseTokens.output
    assert.ok(Math.abs(published - 1000) < TOLERANCE || settled.quality.phaseSplitQuality !== QualityLevel.EXACT,
      `${label}: the phase pair never exceeds the total it divides`)
  }
})

// ── the unit-level symmetry of the contradiction list ────────────────────────

test('the contradiction list is symmetric across both phases and both polarities', () => {
  const scenarios = [
    {
      label: 'reasoning counted, no reasoning delta',
      samples: [output(0, 5)],
      usage: { outputTokens: 100, reasoningTokens: 40 },
      kind: PhaseEvidenceIssue.REASONING_WITHOUT_DELTAS,
    },
    {
      label: 'reasoning zero, reasoning delta present',
      samples: [reasoning(0, 5), output(500, 5)],
      usage: { outputTokens: 100, reasoningTokens: 0 },
      kind: PhaseEvidenceIssue.REASONING_ZERO_WITH_DELTAS,
    },
    {
      label: 'non-reasoning counted, no output delta',
      samples: [reasoning(0, 5)],
      usage: { outputTokens: 100, reasoningTokens: 40 },
      kind: PhaseEvidenceIssue.OUTPUT_WITHOUT_DELTAS,
    },
    {
      label: 'non-reasoning zero, output delta present',
      samples: [output(0, 5)],
      usage: { outputTokens: 100, reasoningTokens: 100 },
      kind: PhaseEvidenceIssue.OUTPUT_ZERO_WITH_DELTAS,
    },
    {
      label: 'impossible split',
      samples: [output(0, 5)],
      usage: { outputTokens: 100, reasoningTokens: 120 },
      kind: PhaseEvidenceIssue.IMPOSSIBLE_SPLIT,
    },
  ]

  for (const scenario of scenarios) {
    const result = calibrateAttemptSamples(scenario.samples, scenario.usage)
    assert.ok(
      result.evidence.contradictions.some(entry => entry.kind === scenario.kind),
      `${scenario.label}: expected ${scenario.kind}, got `
      + JSON.stringify(result.evidence.contradictions.map(entry => entry.kind)),
    )
    assert.equal(sampleSum(result.samples), scenario.usage.outputTokens,
      `${scenario.label}: the invariant holds even while contradicting`)
  }

  /** The reasoning-zero-versus-reasoning-delta direction, stated on its own. */
  const zeroWithDeltas = calibrateAttemptSamples(
    [reasoning(0, 5), output(500, 5)],
    { outputTokens: 100, reasoningTokens: 0 },
  )
  assert.deepEqual(zeroWithDeltas.evidence.contradictions.map(entry => entry.kind),
    [PhaseEvidenceIssue.REASONING_ZERO_WITH_DELTAS])
  /** And a consistent pair yields none at all. */
  const consistent = calibrateAttemptSamples(
    [reasoning(0, 5), output(500, 5)],
    { outputTokens: 100, reasoningTokens: 40 },
  )
  assert.deepEqual(consistent.evidence.contradictions, [])
})

test('an impossible split is not silently clamped into a plausible one', () => {
  /**
   * The rejected reading: `Math.max(0, outputTokens - reasoningTokens)` produces a clean
   * `reasoning 120 / output 0` pair that looks like a provider measurement and is really an
   * artefact of clamping. The counters must be refused instead, and the refusal must be
   * visible.
   */
  const clamped = calibrateAttemptSamples(
    [reasoning(0, 5), output(500, 5)],
    { outputTokens: 100, reasoningTokens: 120 },
  )
  assert.equal(clamped.evidence.splitUsable, false)
  assert.notEqual(clamped.splitQuality, 'exact')
  assert.equal(clamped.phaseTokens.reasoning, null,
    'the impossible counter is withheld rather than republished as a split')
  assert.equal(clamped.phaseTokens.output, null, 'and is not clamped to a plausible zero')
  assert.equal(clamped.evidence.contradictions[0].provider, 120)
})

// ── 16. the recorded instance of the same defect class ───────────────────────

/**
 * The defect is not only reachable by mutation. `t6-tool-only-deepseek-official` is a real
 * recorded turn in which step 4 reports `outputTokens: 282` beside `reasoningTokens: 281` —
 * one implied non-reasoning token — while the stream carries 281 reasoning deltas and no
 * output delta at all.
 *
 * Under the pre-7C.2 algorithm the output phase was calibrated to that single implied token
 * over zero samples, so the samples integrated to 281 and the attempt was still published as
 * `totalAnchored: true`. The loss is only one token here, but it is the same arithmetic that
 * loses seventy-four in the patched-`t4` case: the size of the loss is
 * `outputTokens - reasoningTokens`, and the invariant is what makes the size irrelevant.
 */
test('16. the recorded t6 turn carries a real instance of the contradiction', async () => {
  const { loadFixture } = await import('./helpers/fixtures.js')
  const { durableSettledView } = await import('./helpers/equivalence.js')
  const view = durableSettledView(loadFixture('t6-tool-only-deepseek-official'))

  const step4 = view.settled.attemptBreakdown.find(entry => entry.step === 4)
  assert.ok(step4 !== undefined, 'the recorded turn has the four-attempt shape this test names')
  assert.equal(step4.usage.outputTokens, 282)
  assert.equal(step4.usage.reasoningTokens, 281)
  assert.equal(step4.usage.nonReasoningTokens, 1, 'the provider implies exactly one non-reasoning token')

  const counts = step4.calibration.samples.reduce((map, sample) => {
    map[sample.phase] = (map[sample.phase] ?? 0) + 1
    return map
  }, {})
  assert.deepEqual(counts, { reasoning: 281 }, 'and the stream emitted reasoning deltas only')

  /** The contradiction is detected, the allocation weakens, and the integral is preserved. */
  assert.deepEqual(step4.calibration.evidence.contradictions.map(entry => entry.kind),
    [PhaseEvidenceIssue.OUTPUT_WITHOUT_DELTAS])
  assert.equal(step4.calibration.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.equal(step4.totalAnchored, true)
  assertAnchoredIntegral(step4, 'recorded t6 step 4')

  /** The old algorithm's answer, as a number: 281 of the 282 counted tokens. */
  assert.ok(Math.abs(sampleSum(step4.calibration.samples) - 282) < TOLERANCE)
  assert.ok(sampleSum(step4.calibration.samples) > 281.5,
    'the implied non-reasoning token is inside the curve total, not dropped with its missing phase')

  /** The turn's other three attempts are unaffected and keep their exact phase-anchored split. */
  for (const entry of view.settled.attemptBreakdown) {
    if (entry.step === 4) continue
    assert.equal(entry.calibration.temporalAllocationMode, TemporalAllocationMode.PHASE_ANCHORED)
    assert.deepEqual(entry.calibration.evidence.contradictions, [])
    assertAnchoredIntegral(entry, `t6 step ${entry.step}`)
  }

  /** And the turn's own axes separate the two claims, as required. */
  assert.equal(view.settled.generatedTokens, 541)
  assert.equal(view.settled.quality.tokenTotalQuality, QualityLevel.EXACT)
  assert.notEqual(view.settled.quality.phaseSplitQuality, QualityLevel.EXACT)
  assert.equal(view.settled.temporalAllocationMode, TemporalAllocationMode.TOTAL_ANCHORED)
  assert.equal(view.settled.phaseMismatchAttemptCount, 1)
})
