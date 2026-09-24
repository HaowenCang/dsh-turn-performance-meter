import test from 'node:test'
import assert from 'node:assert/strict'
import { SlidingWindowMeter } from '../src/core/sliding-window.js'

test('rolling window excludes samples at or before lower boundary', () => {
  const meter = new SlidingWindowMeter(1000)
  meter.add(1000, 10)
  meter.add(1500, 20)
  assert.equal(meter.value(1999), 30)
  assert.equal(meter.value(2000), 20)
})

test('reset prevents live TPS from bridging LLM attempts', () => {
  const meter = new SlidingWindowMeter(1000)
  meter.reset('a')
  meter.add(1000, 100)
  assert.equal(meter.value(1100), 100)
  meter.reset('b')
  assert.equal(meter.value(1100), 0)
})

test('beginAttempt resets only when the identity actually changes', () => {
  const meter = new SlidingWindowMeter(1000)
  assert.equal(meter.beginAttempt('a'), true)
  meter.add(1000, 50)
  assert.equal(meter.beginAttempt('a'), false, 'a repeated frame of the same attempt is not a boundary')
  assert.equal(meter.value(1000), 50)
  assert.equal(meter.beginAttempt('b'), true)
  assert.equal(meter.value(1000), 0)
})

test('zero-weight samples are not retained', () => {
  const meter = new SlidingWindowMeter(1000)
  meter.add(0, 0)
  assert.equal(meter.isEmpty, true)
  assert.equal(meter.value(0), 0)
})

test('samples in the future of the evaluated instant are retained but not counted', () => {
  const meter = new SlidingWindowMeter(1000)
  meter.add(5000, 30)
  assert.equal(meter.value(1000), 0)
  assert.equal(meter.value(5000), 30)
  assert.equal(meter.size, 1, 'eviction is driven by the live horizon, not by arrival order')
})

test('non-positive or non-finite window sizes are rejected', () => {
  assert.throws(() => new SlidingWindowMeter(0), TypeError)
  assert.throws(() => new SlidingWindowMeter(-1), TypeError)
  assert.throws(() => new SlidingWindowMeter(Number.NaN), TypeError)
})

test('invalid samples are rejected rather than silently poisoning the sum', () => {
  const meter = new SlidingWindowMeter(1000)
  assert.throws(() => meter.add(Number.NaN, 1), TypeError)
  assert.throws(() => meter.add(0, Number.NaN), TypeError)
  assert.throws(() => meter.add(0, -1), TypeError)
  assert.throws(() => meter.value(Number.NaN), TypeError)
})

test('a batch add of calibrated records uses tokens and falls back to weight', () => {
  const meter = new SlidingWindowMeter(1000)
  meter.addAll([
    { timeMs: 0, tokens: 10 },
    { timeMs: 100, weight: 5 },
    { timeMs: 200 },
    null,
  ])
  assert.equal(meter.value(500), 15)
  assert.equal(meter.newestTimeMs(), 100)
})

test('warm-up: a window younger than the full span divides by the full window without extrapolating', () => {
  // The frozen warm-up contract (METRICS_SPEC §6): while the active attempt has
  // been observed for less than the window length, the value counts exactly the
  // samples observed since the window opened and divides by the full 1000 ms.
  // It therefore ramps up with observed evidence and never claims a full-second
  // rate it has not seen; UI code renders this value directly with `≈`.
  const meter = new SlidingWindowMeter(1000)
  meter.beginAttempt('a')
  meter.add(100, 50)
  assert.equal(meter.value(150), 50, '50 tokens over an honest 1 s divisor, not an extrapolated 1000 tokens/s')
  meter.add(600, 50)
  assert.equal(meter.value(700), 100, 'warm-up accumulates observed evidence only')
  // Once the span exceeds the window the ordinary trailing semantics take over.
  assert.equal(meter.value(1150), 50, 'the sample at 100 has aged out of the 1 s window')
  // A new attempt restarts warm-up from an empty window.
  meter.beginAttempt('b')
  assert.equal(meter.value(1150), 0)
})
