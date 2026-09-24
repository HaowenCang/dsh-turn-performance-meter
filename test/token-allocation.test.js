import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calibrateAttemptSamples,
  calibratePhase,
  heuristicTokenWeight,
  sampleFromChunk,
  samplesFromTimedChunks,
} from '../src/core/token-allocation.js'
import { MetricQuality } from '../src/core/metric-quality.js'

function sumTokens(samples, phase) {
  return samples.filter(s => s.phase === phase).reduce((sum, s) => sum + s.tokens, 0)
}

test('calibration preserves exact reasoning/non-reasoning aggregate totals', () => {
  const samples = [
    { phase: 'reasoning', weight: 1 }, { phase: 'reasoning', weight: 3 },
    { phase: 'output', weight: 2 }, { phase: 'output', weight: 2 },
  ]
  const result = calibrateAttemptSamples(samples, { outputTokens: 30, reasoningTokens: 10 })

  assert.equal(sumTokens(result.samples, 'reasoning'), 10)
  assert.equal(sumTokens(result.samples, 'output'), 20)
  assert.equal(result.totalTokens, 30)
  assert.equal(result.splitQuality, MetricQuality.EXACT)
  assert.equal(result.totalQuality, MetricQuality.EXACT)
  // Reasoning is never added to output: 10 + 20 === outputTokens, not 30 + 10.
  assert.equal(result.phaseTokens.reasoning + result.phaseTokens.output, result.totalTokens)
})

test('calibration on a non-integer shape set still matches the exact total to floating-point tolerance', () => {
  const samples = [
    { phase: 'reasoning', weight: 3.7 }, { phase: 'reasoning', weight: 11.2 }, { phase: 'reasoning', weight: 0.9 },
    { phase: 'output', weight: 5.5 }, { phase: 'output', weight: 27.3 }, { phase: 'output', weight: 0.1 },
  ]
  const result = calibrateAttemptSamples(samples, { outputTokens: 54770, reasoningTokens: 37498 })
  const reasoning = sumTokens(result.samples, 'reasoning')
  const output = sumTokens(result.samples, 'output')

  assert.ok(Math.abs(reasoning - 37498) / 37498 < 1e-9, `reasoning integral ${reasoning}`)
  assert.ok(Math.abs(output - 17272) / 17272 < 1e-9, `output integral ${output}`)
})

test('missing reasoningTokens anchors the total but never claims an exact split', () => {
  const samples = [
    { phase: 'reasoning', weight: 10 }, { phase: 'reasoning', weight: 30 },
    { phase: 'output', weight: 30 }, { phase: 'output', weight: 30 },
  ]
  const result = calibrateAttemptSamples(samples, { outputTokens: 1000 })

  assert.equal(result.totalTokens, 1000)
  assert.equal(result.totalQuality, MetricQuality.EXACT)
  assert.equal(result.splitQuality, MetricQuality.ESTIMATED, 'the split was never measured')
  assert.equal(result.totalAnchored, true)
  assert.ok(Math.abs(sumTokens(result.samples, 'reasoning') + sumTokens(result.samples, 'output') - 1000) < 1e-9)
  assert.equal(result.note, 'reasoningTokens absent: whole-attempt integral anchored, reasoning/output split estimated')
})

test('a phase with tokens but no shape weight distributes evenly instead of dividing by zero', () => {
  const result = calibrateAttemptSamples(
    [{ phase: 'output', weight: 0 }, { phase: 'output', weight: 0 }],
    { outputTokens: 10, reasoningTokens: 0 },
  )
  assert.deepEqual(result.samples.map(s => s.tokens), [5, 5])
  assert.equal(result.splitQuality, MetricQuality.EXACT)
})

test('an authoritative phase total with no samples is reported as an unavailable split, not a silent zero', () => {
  const result = calibrateAttemptSamples(
    [{ phase: 'output', weight: 1 }],
    { outputTokens: 100, reasoningTokens: 40 },
  )
  assert.equal(result.splitQuality, MetricQuality.UNAVAILABLE)
  assert.equal(result.phaseTokens.reasoning, 40)
  assert.equal(result.phaseTokens.output, 60)
  assert.match(result.note, /reasoning tokens reported but the stream carried no such deltas/)
})

test('calibration without authoritative usage leaves the shape estimated', () => {
  const result = calibrateAttemptSamples([{ phase: 'output', weight: 4 }], null)
  assert.equal(result.totalTokens, null)
  assert.equal(result.totalQuality, MetricQuality.UNAVAILABLE)
  assert.equal(result.splitQuality, MetricQuality.UNAVAILABLE)
  assert.equal(result.totalAnchored, false)
  // The per-delta allocation is still a shape estimate; the caller decides how to
  // label it, and `totalQuality` above is the authoritative answer.
  assert.equal(result.samples[0].tokens, 4)
})

test('calibratePhase is pure and never mutates its input', () => {
  const input = [{ phase: 'output', weight: 2 }, { phase: 'output', weight: 6 }]
  const frozen = JSON.stringify(input)
  const out = calibratePhase(input, 80)
  assert.equal(JSON.stringify(input), frozen)
  assert.notEqual(out[0], input[0])
  assert.deepEqual(out.map(s => s.tokens), [20, 60])
})

test('heuristic shape weight is documented-coarse, not a tokenizer', () => {
  assert.equal(heuristicTokenWeight(''), 0)
  assert.equal(heuristicTokenWeight('abcd'), 1)
  assert.equal(heuristicTokenWeight('\u4e2d\u6587\u6d4b\u8bd5'), 4)
  assert.equal(heuristicTokenWeight('\u4e2da'), 1.25)
})

test('zero-weight generated deltas stay in the series instead of vanishing', () => {
  const sample = sampleFromChunk(1000, { type: 'text-delta', text: '\u200b' })
  assert.ok(sample.weight > 0)
  assert.equal(sample.quality, MetricQuality.ESTIMATED)
})

test('samplesFromTimedChunks drops non-generated chunks and keeps delta boundaries', () => {
  const samples = samplesFromTimedChunks([
    { timeMs: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { timeMs: 10, chunk: { type: 'reasoning-delta', text: 'think' } },
    { timeMs: 20, chunk: { type: 'text-delta', text: '' } },
    { timeMs: 30, chunk: { type: 'tool-call-delta', id: 'c1', argumentsDelta: 'gs' } },
    { timeMs: 40, chunk: { type: 'finish', reason: 'stop' } },
  ])
  assert.deepEqual(samples.map(s => [s.timeMs, s.phase]), [[10, 'reasoning'], [30, 'output']])
})
