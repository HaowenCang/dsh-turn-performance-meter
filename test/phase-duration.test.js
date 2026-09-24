import test from 'node:test'
import assert from 'node:assert/strict'
import { attributePhaseDurations } from '../src/core/phase-duration.js'

test('TTFT is excluded: the first generated delta is time zero', () => {
  const d = attributePhaseDurations([
    { timeMs: 7000, phase: 'output' },
    { timeMs: 7200, phase: 'output' },
  ])
  // 7000 ms of pre-first-token wait is not charged to the decode denominator.
  assert.equal(d.outputMs, 200)
  assert.equal(d.reasoningMs, null)
})

test('intra-stream stalls are retained and charged to the earlier phase', () => {
  const d = attributePhaseDurations([
    { timeMs: 0, phase: 'reasoning' },
    { timeMs: 3000, phase: 'reasoning' },   // a real 3 s delivery stall
    { timeMs: 3100, phase: 'reasoning' },
  ])
  assert.equal(d.reasoningMs, 3100)
})

test('interleaved reasoning and output never double-count an interval', () => {
  const d = attributePhaseDurations([
    { timeMs: 0, phase: 'reasoning' },     // 0 -> 100 charged to reasoning
    { timeMs: 100, phase: 'output' },      // 100 -> 250 charged to output
    { timeMs: 250, phase: 'reasoning' },   // 250 -> 400 charged to reasoning
    { timeMs: 400, phase: 'output' },      // 400 -> 500 charged to output
    { timeMs: 500, phase: 'output' },
  ])
  assert.equal(d.reasoningMs, 100 + 150)
  assert.equal(d.outputMs, 150 + 100)
  // Disjoint, so the two denominators cover the whole span exactly once.
  assert.equal(d.reasoningMs + d.outputMs, d.spanMs)
  assert.equal(d.spanMs, 500)
})

test('a one-delta attempt has no measurable duration, not zero duration', () => {
  const d = attributePhaseDurations([{ timeMs: 42, phase: 'output' }])
  assert.equal(d.outputMs, null, 'null means "no evidence"; 0 would claim a measured zero')
  assert.equal(d.reasoningMs, null)
  assert.equal(d.spanMs, 0)
  assert.equal(d.sampleCount, 1)
})

test('simultaneous timestamps produce zero-length intervals that are not booked', () => {
  const d = attributePhaseDurations([
    { timeMs: 100, phase: 'reasoning' },
    { timeMs: 100, phase: 'reasoning' },
    { timeMs: 100, phase: 'output' },
    { timeMs: 400, phase: 'output' },
  ])
  assert.equal(d.reasoningMs, null, 'no positive reasoning interval exists')
  assert.equal(d.outputMs, 300)
})

test('an attempt with no samples is empty rather than zero-valued', () => {
  const d = attributePhaseDurations([])
  assert.equal(d.reasoningMs, null)
  assert.equal(d.outputMs, null)
  assert.equal(d.spanMs, 0)
  assert.equal(d.sampleCount, 0)
})

test('unordered input is sorted, and a backwards timestamp cannot create a negative duration', () => {
  const d = attributePhaseDurations([
    { timeMs: 300, phase: 'output' },
    { timeMs: 100, phase: 'output' },
    { timeMs: 200, phase: 'output' },
  ])
  assert.equal(d.outputMs, 200)
  assert.equal(d.spanMs, 200)
})

test('reasoning-only prefix then a tool call: the tool time is absent from the attempt', () => {
  const d = attributePhaseDurations([
    { timeMs: 1000, phase: 'reasoning' },
    { timeMs: 1400, phase: 'reasoning' },
  ])
  assert.equal(d.reasoningMs, 400)
  assert.equal(d.outputMs, null)
})
