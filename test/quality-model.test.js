/**
 * The three-axis quality model.
 *
 * `docs/METRICS_SPEC.md` fixes the *semantics*: a single label must not describe
 * a whole curve, because the same turn routinely has an exactly known token
 * total, an unreported reasoning split and a reconstructed temporal shape. These
 * tests pin each of the documented examples and the structural rules that keep
 * the axes honest.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  QUALITY_AXIS,
  QUALITY_CEILING,
  QualityLevel,
  clampToAxis,
  isQualityLevel,
  phaseSplitQuality,
  qualityAxes,
  requiresApproximateMarker,
  temporalShapeQuality,
  tokenTotalQuality,
  weakestLevel,
} from '../src/core/quality-model.js'
import { aggregateTurn } from '../src/core/aggregate-turn.js'
import { MetricQuality } from '../src/core/metric-quality.js'
import { loadDerived, loadFixture } from './helpers/fixtures.js'
import { durableSettledView } from './helpers/equivalence.js'

test('the four frozen levels keep their meaning and two additions are declared', () => {
  for (const level of ['exact', 'calibrated', 'estimated', 'unavailable']) {
    assert.equal(isQualityLevel(level), true, `${level} must remain a valid quality`)
  }
  assert.equal(isQualityLevel('partial'), true, 'partial distinguishes incomplete coverage from a wholesale estimate')
  assert.equal(isQualityLevel('reconstructed'), true, 'reconstructed distinguishes an anchored shape from a rough estimate')
  assert.equal(isQualityLevel('perfect'), false)
  assert.equal(weakestLevel('exact', 'estimated'), 'estimated')
  assert.equal(weakestLevel('reconstructed', 'estimated'), 'estimated')
  assert.equal(weakestLevel('unavailable', 'exact'), 'unavailable')
  assert.equal(weakestLevel('exact', 'nonsense'), 'unavailable', 'an unknown value degrades rather than passing through')
})

test('the temporal shape axis can never reach exact', () => {
  assert.equal(QUALITY_CEILING.temporalShape, 'reconstructed')
  assert.equal(clampToAxis(QUALITY_AXIS.TEMPORAL_SHAPE, 'exact'), 'reconstructed')
  assert.equal(clampToAxis(QUALITY_AXIS.TEMPORAL_SHAPE, 'calibrated'), 'reconstructed')
  // The strongest possible evidence still cannot lift it.
  assert.equal(temporalShapeQuality({
    durable: true,
    timestampsComplete: true,
    anchored: true,
    sampleCount: 10_000,
  }), 'reconstructed')
})

test('the token total axis can reach exact and the split can only follow it', () => {
  assert.equal(tokenTotalQuality({ contributingAttemptCount: 2, attemptsWithUsage: 2, reportedTotals: 2 }), 'exact')
  assert.equal(tokenTotalQuality({ contributingAttemptCount: 2, attemptsWithUsage: 1, reportedTotals: 1 }), 'partial')
  assert.equal(tokenTotalQuality({ contributingAttemptCount: 2, attemptsWithUsage: 0 }), 'unavailable')
  assert.equal(tokenTotalQuality({ contributingAttemptCount: 0 }), 'unavailable')

  // A split cannot be better known than the total it divides.
  const axes = qualityAxes({
    contributingAttemptCount: 2,
    attemptsWithUsage: 1,
    reportedTotals: 1,
    attemptsWithSplit: 1,
    hasReasoningDeltas: true,
    hasOutputDeltas: true,
  })
  assert.equal(axes.tokenTotalQuality, 'partial')
  assert.notEqual(axes.phaseSplitQuality, 'exact')
})

test('the documented semantic examples hold', () => {
  // provider outputTokens authoritative, reasoningTokens authoritative
  const both = qualityAxes({
    contributingAttemptCount: 1,
    attemptsWithUsage: 1,
    reportedTotals: 1,
    attemptsWithSplit: 1,
    hasReasoningDeltas: true,
    hasOutputDeltas: true,
    durable: true,
    anchored: true,
    sampleCount: 100,
  })
  assert.deepEqual(
    [both.tokenTotalQuality, both.phaseSplitQuality, both.temporalShapeQuality],
    ['exact', 'exact', 'reconstructed'],
  )

  // provider outputTokens authoritative, no reasoningTokens
  const noSplit = qualityAxes({
    contributingAttemptCount: 1,
    attemptsWithUsage: 1,
    reportedTotals: 1,
    attemptsWithSplit: 0,
    hasReasoningDeltas: true,
    hasOutputDeltas: true,
    durable: true,
    anchored: true,
    sampleCount: 100,
  })
  assert.deepEqual(
    [noSplit.tokenTotalQuality, noSplit.phaseSplitQuality, noSplit.temporalShapeQuality],
    ['exact', 'estimated', 'reconstructed'],
  )
  assert.equal(noSplit.approximateTokenTotal, false)
  assert.equal(noSplit.approximatePhaseSplit, true)

  // no provider usage at all
  const none = qualityAxes({
    contributingAttemptCount: 1,
    attemptsWithUsage: 0,
    attemptsWithSplit: 0,
    hasReasoningDeltas: true,
    hasOutputDeltas: true,
    durable: true,
    sampleCount: 100,
  })
  assert.deepEqual(
    [none.tokenTotalQuality, none.phaseSplitQuality, none.temporalShapeQuality],
    ['unavailable', 'unavailable', 'estimated'],
  )
  assert.equal(none.displayTokenTotal, 'unavailable')

  // no usage, no durable shape: the weakest honest reading
  const liveOnly = qualityAxes({
    contributingAttemptCount: 1,
    attemptsWithUsage: 0,
    hasReasoningDeltas: true,
    durable: false,
    sampleCount: 10,
  })
  assert.deepEqual(
    [liveOnly.tokenTotalQuality, liveOnly.phaseSplitQuality, liveOnly.temporalShapeQuality],
    ['unavailable', 'unavailable', 'estimated'],
  )

  // nothing at all
  const empty = qualityAxes({})
  assert.deepEqual(
    [empty.tokenTotalQuality, empty.phaseSplitQuality, empty.temporalShapeQuality],
    ['unavailable', 'unavailable', 'unavailable'],
  )
  assert.deepEqual(empty.notes, [])
})

test('a split with no reasoning counter is estimated, never exact and never unavailable-by-accident', () => {
  assert.equal(phaseSplitQuality({ contributingAttemptCount: 1, attemptsWithUsage: 1, attemptsWithSplit: 0, hasOutputDeltas: true }), 'estimated')
  assert.equal(phaseSplitQuality({ contributingAttemptCount: 2, attemptsWithUsage: 2, attemptsWithSplit: 1 }), 'estimated')
  assert.equal(phaseSplitQuality({ contributingAttemptCount: 2, attemptsWithUsage: 2, attemptsWithSplit: 2 }), 'exact')
  // No counter, no deltas of either phase: there is nothing to split.
  assert.equal(phaseSplitQuality({ contributingAttemptCount: 1, attemptsWithUsage: 1, attemptsWithSplit: 0 }), 'unavailable')
})

test('a missing delta timestamp degrades the temporal axis but not the token axes', () => {
  const axes = qualityAxes({
    contributingAttemptCount: 1,
    attemptsWithUsage: 1,
    reportedTotals: 1,
    attemptsWithSplit: 1,
    durable: true,
    timestampsComplete: false,
    anchored: true,
    sampleCount: 100,
  })
  assert.equal(axes.tokenTotalQuality, 'exact')
  assert.equal(axes.phaseSplitQuality, 'exact')
  assert.equal(axes.temporalShapeQuality, 'estimated')
})

test('an unanchored curve is estimated even when its timestamps are durable', () => {
  assert.equal(temporalShapeQuality({ durable: true, anchored: false, sampleCount: 5 }), 'estimated')
  assert.equal(temporalShapeQuality({ durable: false, anchored: true, sampleCount: 5 }), 'estimated')
  assert.equal(temporalShapeQuality({ durable: true, anchored: true, sampleCount: 5 }), 'reconstructed')
  assert.equal(temporalShapeQuality({ sampleCount: 0 }), 'unavailable')
})

test('only exact suppresses the approximate marker', () => {
  assert.equal(requiresApproximateMarker('exact'), false)
  assert.equal(requiresApproximateMarker('unavailable'), false)
  for (const level of ['calibrated', 'reconstructed', 'partial', 'estimated']) {
    assert.equal(requiresApproximateMarker(level), true, `${level} must be marked approximate`)
  }
})

test('a turn with a complete exact split reports exact totals and a reconstructed shape', () => {
  const view = durableSettledView(loadFixture('t4-reasoning-tool-deepseek-official'))
  const q = view.settled.quality
  assert.equal(q.tokenTotalQuality, 'exact')
  assert.equal(q.phaseSplitQuality, 'exact')
  assert.equal(q.temporalShapeQuality, 'reconstructed')
  assert.equal(q.approximateTokenTotal, false)
  assert.equal(q.approximatePhaseSplit, false)
  assert.equal(q.displayTokenTotal, 'exact')
  assert.ok(q.notes.some(note => /local curve shape/.test(note)))
})

test('a turn whose provider omits the reasoning counter reports exact totals with an approximate split', () => {
  const view = durableSettledView(loadFixture('t1-reasoning-tool-reasoning'))
  const q = view.settled.quality
  assert.equal(q.tokenTotalQuality, 'exact')
  assert.equal(q.phaseSplitQuality, 'estimated')
  assert.equal(q.temporalShapeQuality, 'reconstructed')
  assert.equal(q.approximateTokenTotal, false)
  assert.equal(q.approximatePhaseSplit, true)
  assert.ok(q.notes.some(note => /not reported by the provider/.test(note)))
})

test('the synthesized missing-reasoningTokens fixture reports the same axes as the recorded one', () => {
  const recorded = durableSettledView(loadFixture('t5-reasoning-text-deepseek-official')).settled.quality
  const derived = durableSettledView(loadDerived('d1-no-reasoning-tokens')).settled.quality
  assert.equal(recorded.phaseSplitQuality, 'exact')
  assert.equal(derived.phaseSplitQuality, 'estimated')
  assert.equal(derived.tokenTotalQuality, recorded.tokenTotalQuality, 'dropping the split must not disturb the total')
  assert.equal(derived.temporalShapeQuality, recorded.temporalShapeQuality)
})

test('a settlement that lost its usage still recovers the counter from the stream', () => {
  const derived = loadDerived('d2-partial-usage')
  assert.equal(derived.syntheticMutation.kind, 'drop-one-attempt-usage')
  const view = durableSettledView(derived)
  const last = view.reconstructed.attempts.at(-1)
  // The synthetic mutation removed the *settlement* carrier. Because DSH also
  // records an in-stream `usage` chunk, the authoritative counter survives; the
  // provenance is reported so a consumer can see which carrier supplied it.
  assert.equal(last.usageSource, 'in-stream-usage-chunk')
  const recorded = durableSettledView(loadFixture('t4-reasoning-tool-deepseek-official'))
  assert.equal(last.usage.outputTokens, recorded.reconstructed.attempts.at(-1).usage.outputTokens)
  assert.equal(view.settled.quality.tokenTotalQuality, recorded.settled.quality.tokenTotalQuality)
})

test('an attempt with no surface message still keeps its authoritative counter', () => {
  const view = durableSettledView(loadDerived('d3-attempt-without-message'))
  const nonSurface = view.reconstructed.attempts.at(-1)
  assert.equal(nonSurface.settlementKind, 'attempt')
  assert.equal(nonSurface.surfaceCommitted, false)
  assert.equal(nonSurface.attemptOutcome, 'unknown')
  assert.equal(nonSurface.usageSource, 'in-stream-usage-chunk')
  // The attempt really did consume provider output tokens, so excluding them
  // would under-report the turn. A settlement-level absence is not treated as an
  // accounting absence while an authoritative carrier exists.
  assert.equal(view.settled.quality.tokenTotalQuality, 'exact')
  assert.equal(view.settled.generatedTokens, view.settled.observedGeneratedTokens)
})

test('an interrupted turn with no usage never claims an exact total', () => {
  const view = durableSettledView(loadFixture('t3-interrupted-mid-reasoning'))
  assert.equal(view.settled.quality.tokenTotalQuality, 'unavailable')
  assert.equal(view.settled.quality.displayTokenTotal, 'unavailable')
  assert.equal(view.settled.generatedTokens, null)
})

test('the aggregate exposes the axes and keeps the legacy blended label as a floor', () => {
  const result = aggregateTurn({
    turn: 1,
    turnStartMs: 1000,
    turnEndMs: 2000,
    firstTokenMs: 1100,
    attempts: [{
      attemptId: 'a',
      samples: [
        { timeMs: 1100, phase: 'reasoning', weight: 1, tokens: 1 },
        { timeMs: 1200, phase: 'reasoning', weight: 1, tokens: 1 },
      ],
      usage: { outputTokens: 10, reasoningTokens: 4 },
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
    }],
    tools: [],
  })
  assert.equal(result.quality.tokenTotalQuality, 'exact')
  assert.equal(result.quality.phaseSplitQuality, 'exact')
  assert.equal(result.quality.temporalShapeQuality, 'estimated', 'a live-shaped aggregate has no durable claim')
  assert.deepEqual(result.consistencyIssues, [], 'stream and provider agree here')
  assert.equal(
    result.overallQuality,
    'exact',
    'the legacy blended label is the weakest of the published rates, and both rates are exact here',
  )
  assert.equal(Object.hasOwn(result, 'quality'), true)
})

test('reasoningTokens=0 with a non-empty reasoning stream can never report an exact split', () => {
  // Unit level: the quality model takes the conflict flag directly.
  const conflict = qualityAxes({
    contributingAttemptCount: 1,
    attemptsWithUsage: 1,
    reportedTotals: 1,
    attemptsWithSplit: 1,
    reasoningStreamConflict: true,
    hasReasoningDeltas: true,
    hasOutputDeltas: true,
    durable: true,
    anchored: true,
    sampleCount: 100,
  })
  assert.equal(conflict.tokenTotalQuality, 'exact', 'the authoritative outputTokens total is untouched')
  assert.notEqual(conflict.phaseSplitQuality, 'exact')
  assert.equal(conflict.phaseSplitQuality, 'estimated')
  assert.equal(conflict.approximatePhaseSplit, true)
  assert.equal(conflict.displayPhaseSplit, 'approximate')
  assert.ok(conflict.notes.some(note => /reasoningTokens=0/.test(note)))
  assert.equal(
    phaseSplitQuality({ contributingAttemptCount: 1, attemptsWithSplit: 1, reasoningStreamConflict: true }),
    'estimated',
  )

  // Aggregate level: provider usage says zero reasoning tokens while the
  // samples carry reasoning deltas — the exact Phase 3 guard scenario.
  const result = aggregateTurn({
    turn: 1,
    turnStartMs: 0,
    turnEndMs: 5000,
    firstTokenMs: 100,
    attempts: [{
      attemptId: 'conflicted',
      samples: [
        { timeMs: 100, phase: 'reasoning', weight: 5, tokens: 5 },
        { timeMs: 3000, phase: 'reasoning', weight: 5, tokens: 5 },
        { timeMs: 3000, phase: 'output', weight: 5, tokens: 5 },
        { timeMs: 4500, phase: 'output', weight: 5, tokens: 5 },
      ],
      usage: { outputTokens: 500, reasoningTokens: 0 },
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
    }],
    tools: [],
  })
  assert.equal(result.quality.tokenTotalQuality, 'exact')
  assert.notEqual(result.quality.phaseSplitQuality, 'exact')
  assert.notEqual(result.splitQuality, MetricQuality.EXACT, 'the legacy split label degrades too')
  assert.equal(result.consistencyIssues.length, 1)
  assert.match(result.consistencyIssues[0], /reasoningTokens=0/)
  assert.equal(result.outputTpsQuality !== MetricQuality.EXACT || result.outputTps === null, true,
    'a rate whose split is contradicted never claims exact')

  // A zero reasoning counter WITHOUT reasoning stream evidence stays exact:
  // that combination is consistent (tool-argument-only attempts, t4 step 2).
  const consistent = aggregateTurn({
    turn: 1,
    turnStartMs: 0,
    turnEndMs: 1000,
    attempts: [{
      attemptId: 'consistent',
      samples: [
        { timeMs: 100, phase: 'output', weight: 5, tokens: 5 },
        { timeMs: 500, phase: 'output', weight: 5, tokens: 5 },
      ],
      usage: { outputTokens: 7, reasoningTokens: 0 },
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
    }],
    tools: [],
  })
  assert.deepEqual(consistent.consistencyIssues, [])
  assert.equal(consistent.quality.phaseSplitQuality, 'exact')
})
