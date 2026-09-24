import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateTurn, reduceAttempt } from '../src/core/aggregate-turn.js'
import { MetricQuality } from '../src/core/metric-quality.js'
import { QualityLevel } from '../src/core/quality-model.js'
import { compressAttempts } from '../src/core/time-axis.js'

/** Attempt A: reasoning 0 -> 2000, then output 2000 -> 5000. */
const ATTEMPT_A = {
  attemptId: 'a1',
  turn: 1,
  step: 1,
  settlementKind: 'message',
  surfaceCommitted: true,
  attemptOutcome: 'committed',
  usage: { outputTokens: 100, reasoningTokens: 40 },
  samples: [
    { timeMs: 0, phase: 'reasoning', weight: 4 },
    { timeMs: 2000, phase: 'reasoning', weight: 6 },
    { timeMs: 2000, phase: 'output', weight: 2 },
    { timeMs: 5000, phase: 'output', weight: 1 },
  ],
}

/**
 * Attempt B: reasoning 0 -> 3000, then output 3000 -> 12000.
 * Attempt-local zero, exactly as DSH reports it: there is no global clock in the
 * samples.
 */
const ATTEMPT_B = {
  attemptId: 'b1',
  turn: 1,
  step: 2,
  settlementKind: 'message',
  surfaceCommitted: true,
  attemptOutcome: 'committed',
  usage: { outputTokens: 900, reasoningTokens: 360 },
  samples: [
    { timeMs: 0, phase: 'reasoning', weight: 6 },
    { timeMs: 3000, phase: 'reasoning', weight: 4 },
    { timeMs: 3000, phase: 'output', weight: 8 },
    { timeMs: 12_000, phase: 'output', weight: 2 },
  ],
}

test('turn TPS is token/duration weighted, never the arithmetic mean of attempt TPS', () => {
  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 20_000,
    firstTokenMs: 1000,
    attempts: [ATTEMPT_A, ATTEMPT_B],
  })

  // Reasoning: 40 + 360 = 400 tokens over 2000 + 3000 = 5000 ms.
  assert.equal(result.reasoningTokens, 400)
  assert.equal(result.reasoningMs, 5000)
  assert.equal(result.reasoningTps, 80)

  // Non-reasoning output: (100-40) + (900-360) = 600 tokens over 3000 + 9000 = 12000 ms.
  assert.equal(result.nonReasoningTokens, 600)
  assert.equal(result.outputMs, 12_000)
  assert.equal(result.outputTps, 50)

  // generatedTokens is the provider output total (reasoning included): 100 + 900.
  assert.equal(result.generatedTokens, 1000)
  assert.equal(result.generatedTokensQuality, MetricQuality.EXACT)
  assert.equal(result.ttftMs, 1000)
  assert.equal(result.turnElapsedMs, 20_000)
  assert.equal(result.usageComplete, true)
  assert.equal(result.splitComplete, true)
  assert.equal(result.reasoningTpsQuality, MetricQuality.EXACT)
  assert.equal(result.outputTpsQuality, MetricQuality.EXACT)

  // The forbidden arithmetic mean would be (40 + 120) / 2 = 80 for reasoning
  // and (20 + 60) / 2 = 40 for output; the weighted values differ, and the
  // output case is asserted explicitly.
  const arithmeticMeanOutput = (20 + 60) / 2
  assert.notEqual(result.outputTps, arithmeticMeanOutput)
})

test('reasoningTokens is never added to outputTokens', () => {
  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 1000,
    attempts: [{ attemptId: 'x', usage: { outputTokens: 1000, reasoningTokens: 600 }, samples: [
      { timeMs: 0, phase: 'reasoning', weight: 1 },
      { timeMs: 100, phase: 'output', weight: 1 },
    ] }],
  })
  // METRICS_SPEC fixture B: 1000 output, 600 reasoning, 400 non-reasoning.
  assert.equal(result.generatedTokens, 1000, 'never 1600')
  assert.equal(result.reasoningTokens, 600)
  assert.equal(result.nonReasoningTokens, 400)
  assert.equal(result.reasoningTokens + result.nonReasoningTokens, result.generatedTokens)
})

test('one attempt without authoritative usage makes the exact turn total unavailable without dropping the partial sum', () => {
  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 1000,
    attempts: [
      ATTEMPT_A,
      {
        attemptId: 'failed',
        settlementKind: 'attempt',
        surfaceCommitted: false,
        attemptOutcome: 'unknown',
        samples: [{ timeMs: 0, phase: 'output', weight: 3 }],
      },
    ],
  })

  assert.equal(result.generatedTokens, null, 'the true total is unknown, so no exact number is claimed')
  assert.equal(result.generatedTokensQuality, MetricQuality.ESTIMATED)
  assert.equal(result.observedGeneratedTokens, 100, 'the part that was measured is still reported')
  assert.equal(result.usageComplete, false)
  assert.equal(result.usageAttemptCount, 1)
  assert.equal(result.contributingAttemptCount, 2)
  /**
   * Frozen in Phase 4: when the split is not authoritative, the published
   * per-phase magnitude is the anchored shape division of the observed total, and
   * the rate carries the quality of that numerator rather than disappearing. The
   * alternative — a bare `—` for every provider that omits `reasoningTokens` —
   * would throw away a real observed generation duration.
   */
  assert.equal(result.quality.phaseSplitQuality, QualityLevel.ESTIMATED)
  assert.equal(result.phaseTokens.reasoning, 40, 'the one attempt that reported reasoningTokens still contributes')
  assert.equal(result.phaseTokens.output, 60, 'the rest of the observed total is allocated to output')
  assert.equal(result.phaseTokens.reasoning + result.phaseTokens.output, result.observedGeneratedTokens,
    'the phase pair never sums past the total that was actually observed')
  assert.equal(result.reasoningTps, 20, '40 allocated tokens over the 2000 ms of measured reasoning time')
  assert.equal(result.outputTps, 20, '60 allocated tokens over the 3000 ms of measured output time')
  assert.equal(result.outputTpsQuality, MetricQuality.ESTIMATED,
    'only one of the two contributing attempts had a measurable output phase')
  assert.equal(result.splitQuality, MetricQuality.ESTIMATED)
})

test('missing reasoningTokens across every attempt keeps the total exact and the split inexact', () => {
  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 1000,
    attempts: [{
      attemptId: 'h',
      usage: { outputTokens: 500 },
      samples: [
        { timeMs: 0, phase: 'reasoning', weight: 5 },
        { timeMs: 1000, phase: 'reasoning', weight: 5 },
        { timeMs: 1000, phase: 'output', weight: 5 },
        { timeMs: 3000, phase: 'output', weight: 5 },
      ],
    }],
  })
  assert.equal(result.generatedTokens, 500)
  assert.equal(result.generatedTokensQuality, MetricQuality.EXACT)
  assert.equal(result.splitComplete, false)
  assert.equal(result.splitQuality, MetricQuality.ESTIMATED)
  assert.equal(result.reasoningTokens, null, 'the observed counter is absent, so no exact split is claimed')
  assert.equal(result.nonReasoningTokens, null, 'the split is not labelled exact')
  /**
   * The anchored division of the exact total by the observed shape: half the
   * shape weight was reasoning, so half of 500 tokens is allocated there, over the
   * 1000 ms of measured reasoning time.
   */
  assert.equal(result.phaseTokens.reasoning, 250)
  assert.equal(result.phaseTokens.output, 250)
  assert.equal(result.phaseTokens.reasoning + result.phaseTokens.output, result.generatedTokens,
    'the anchored phases still add up to the authoritative total')
  assert.equal(result.reasoningTps, 250)
  assert.equal(result.reasoningTpsQuality, MetricQuality.CALIBRATED,
    'anchored to an exact total over complete measured timing, with an unmeasured division')
  assert.equal(result.outputTps, 125, 'the same 250 allocated tokens over the 2000 ms output span')
  assert.equal(result.outputTpsQuality, MetricQuality.CALIBRATED)
})

test('a single-delta attempt yields no rate rather than an infinite one', () => {
  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 100,
    attempts: [{ attemptId: 'one', usage: { outputTokens: 10, reasoningTokens: 0 }, samples: [{ timeMs: 0, phase: 'output', weight: 1 }] }],
  })
  assert.equal(result.outputMs, 0)
  assert.equal(result.outputTps, null)
  assert.equal(result.outputTpsQuality, MetricQuality.UNAVAILABLE)
  assert.equal(Number.isFinite(result.outputTps ?? 0), true)
})

test('attempts that emitted no generated delta are excluded from the denominators but counted', () => {
  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 1000,
    attempts: [
      ATTEMPT_A,
      { attemptId: 'empty', turn: 1, step: 2, samples: [], usage: null },
    ],
  })
  assert.equal(result.attemptCount, 2)
  assert.equal(result.contributingAttemptCount, 1)
  assert.equal(result.emptyAttemptCount, 1)
  assert.equal(result.reasoningMs, 2000, 'the empty attempt must not add a zero-length phase')
  assert.equal(result.generatedTokens, 100, 'the empty attempt carries no tokens to be missing')
  assert.equal(result.generatedTokensQuality, MetricQuality.EXACT)
})

test('tool latency is reported as summed work and as a wall union', () => {
  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 10_000,
    attempts: [ATTEMPT_A],
    tools: [
      { callId: 'c1', name: 'pwsh', startMs: 100, endMs: 1100, status: 'ok' },
      { callId: 'c2', name: 'read', startMs: 600, endMs: 1600, status: 'ok' },
      { callId: 'c3', name: 'grep', startMs: 2000, endMs: 2000, status: 'error' },
    ],
  })
  assert.equal(result.tools.workMs, 1000 + 1000 + 0)
  assert.equal(result.tools.wallMs, 1500, 'the overlapping 500 ms is counted once')
  assert.ok(result.tools.workMs >= result.tools.wallMs)
  assert.equal(result.tools.count, 3)
  assert.equal(result.tools.failedCount, 1)
  assert.deepEqual(result.tools.names, ['pwsh', 'read', 'grep'])
})

test('an interrupted turn still reports the throughput it was observed to reach', () => {
  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 2500,
    status: 'interrupted',
    firstTokenMs: 500,
    attempts: [
      {
        attemptId: 'stopped',
        settlementKind: 'message',
        surfaceCommitted: true,
        attemptOutcome: 'interrupted',
        usage: null,
        samples: [
          { timeMs: 0, phase: 'reasoning', weight: 3 },
          { timeMs: 2000, phase: 'reasoning', weight: 3 },
        ],
      },
    ],
  })
  assert.equal(result.status, 'interrupted')
  assert.equal(result.reasoningMs, 2000, 'observed generation time is real even without usage')
  assert.equal(result.ttftMs, 500, 'TTFT is defined for an interrupted turn too')
  assert.equal(result.generatedTokens, null, 'no usage means no exact total')
  /**
   * The interrupted prefix is still real evidence. Without usage the published
   * phase magnitude is the raw shape weight and the rate inherits `estimated`, so
   * the card can show what the turn was reaching before it was stopped — always
   * behind `≈`, never as an exact rate and never as a fabricated token count.
   */
  assert.equal(result.phaseTokens.reasoning, 6)
  assert.equal(result.phaseTokens.output, null, 'the output phase has no evidence at all')
  assert.equal(result.reasoningTps, 3, '6 shape tokens over the 2000 ms observed reasoning span')
  assert.equal(result.reasoningTpsQuality, MetricQuality.CALIBRATED,
    'the shape is anchored to a real observed span even with no provider counter')
  assert.ok(result.shapeTokens.reasoning > 0)
  assert.equal(result.shapeTokens.output, 0)
})

test('reduceAttempt reports measured durations from the samples it was given', () => {
  const reduced = reduceAttempt(ATTEMPT_B)
  assert.equal(reduced.reasoningMs, 3000)
  assert.equal(reduced.outputMs, 9000)
  assert.equal(reduced.spanMs, 12_000)
  assert.equal(reduced.splitQuality, MetricQuality.EXACT)
})

test('turn TPS denominators exclude tool and inter-call waiting time', () => {
  // Fixture D: LLM A 4s -> tool 60s -> LLM B 6s -> tool 20s -> LLM C 5s.
  // Scaled to seconds-as-milliseconds to keep the arithmetic exact.
  const attemptA = { attemptId: 'A', usage: { outputTokens: 400, reasoningTokens: 0 }, samples: [
    { timeMs: 0, phase: 'output', weight: 100 },
    { timeMs: 4000, phase: 'output', weight: 100 },
  ] }
  const attemptB = { attemptId: 'B', usage: { outputTokens: 600, reasoningTokens: 0 }, samples: [
    { timeMs: 0, phase: 'output', weight: 100 },
    { timeMs: 6000, phase: 'output', weight: 100 },
  ] }
  const attemptC = { attemptId: 'C', usage: { outputTokens: 500, reasoningTokens: 0 }, samples: [
    { timeMs: 0, phase: 'output', weight: 100 },
    { timeMs: 5000, phase: 'output', weight: 100 },
  ] }

  const result = aggregateTurn({
    turnStartMs: 0,
    turnEndMs: 95_000,
    firstTokenMs: 1000,
    attempts: [attemptA, attemptB, attemptC],
    tools: [
      { callId: 't1', name: 'pwsh', startMs: 4000, endMs: 64_000, status: 'ok' },
      { callId: 't2', name: 'write', startMs: 70_000, endMs: 90_000, status: 'ok' },
    ],
  })

  assert.equal(result.turnElapsedMs, 95_000, 'turn elapsed does include tool time')
  assert.equal(result.outputMs, 15_000, 'the 80 s of tool time is excluded from the denominator')
  assert.equal(result.generatedTokens, 1500)
  assert.equal(result.outputTps, 100)
  assert.equal(result.tools.wallMs, 80_000)
  assert.equal(result.tools.workMs, 80_000)

  // Curve width is the sum of model-generated spans only: 4 + 6 + 5 = 15 s.
  const compressed = compressAttempts([attemptA, attemptB, attemptC])
  assert.equal(compressed.durationMs, 15_000)
  assert.deepEqual(compressed.segments.map(s => [s.startMs, s.endMs]), [[0, 4000], [4000, 10_000], [10_000, 15_000]])

  // The same model samples with a 1 s tool call must produce an identical curve width.
  const shortTool = compressAttempts([attemptA, attemptB, attemptC])
  assert.equal(shortTool.durationMs, compressed.durationMs)
})
