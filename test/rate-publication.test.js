/**
 * The shared rate-publication policy: two gates, no clamping.
 *
 * The interesting assertions here are the ones about what the policy refuses and
 * about what it does **not** do. A gate that quietly clamped a large value would
 * pass every "is the spike gone" test in this project while destroying the
 * measurement the chart exists to show, so the absence of clamping is asserted
 * directly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_RATE_ELAPSED_MS,
  MIN_RATE_SAMPLES,
  RateUnavailable,
  rateAvailability,
  rateIsPublishable,
} from '../src/core/rate-publication.js'

test('the gate is samples >= 3 and elapsed >= 100 ms, inclusive at the boundary', () => {
  assert.equal(MIN_RATE_SAMPLES, 3)
  assert.equal(MIN_RATE_ELAPSED_MS, 100)
  assert.equal(rateIsPublishable({ sampleCount: 3, elapsedMs: 100 }), true)
  assert.equal(rateIsPublishable({ sampleCount: 4, elapsedMs: 101 }), true)
  assert.equal(rateIsPublishable({ sampleCount: 3, elapsedMs: 99.999 }), false)
  assert.equal(rateIsPublishable({ sampleCount: 2, elapsedMs: 100 }), false)
  assert.equal(rateIsPublishable({ sampleCount: 1, elapsedMs: 10_000 }), false)
})

test('nothing without an episode is publishable', () => {
  assert.deepEqual(rateAvailability(), { publishable: false, reason: RateUnavailable.NO_EPISODE })
  assert.deepEqual(rateAvailability({ sampleCount: 0, elapsedMs: 500 }),
    { publishable: false, reason: RateUnavailable.NO_EPISODE })
  assert.deepEqual(rateAvailability({ sampleCount: null, elapsedMs: 500 }),
    { publishable: false, reason: RateUnavailable.NO_EPISODE })
  assert.deepEqual(rateAvailability({ sampleCount: NaN, elapsedMs: 500 }),
    { publishable: false, reason: RateUnavailable.NO_EPISODE })
})

test('each refusal names the fact that is missing, in order of specificity', () => {
  assert.deepEqual(rateAvailability({ sampleCount: 1, elapsedMs: 0 }),
    { publishable: false, reason: RateUnavailable.OPENING_ANCHOR })
  assert.deepEqual(rateAvailability({ sampleCount: 5, elapsedMs: null }),
    { publishable: false, reason: RateUnavailable.OPENING_ANCHOR })
  assert.deepEqual(rateAvailability({ sampleCount: 5, elapsedMs: 1 }),
    { publishable: false, reason: RateUnavailable.BELOW_ELAPSED_HORIZON })
  assert.deepEqual(rateAvailability({ sampleCount: 1, elapsedMs: 99 }),
    { publishable: false, reason: RateUnavailable.BELOW_ELAPSED_HORIZON },
    'the horizon is reported before the sample count: it is the coarser fact')
  assert.deepEqual(rateAvailability({ sampleCount: 2, elapsedMs: 100 }),
    { publishable: false, reason: RateUnavailable.BELOW_SAMPLE_WARMUP })
  assert.deepEqual(rateAvailability({ sampleCount: 3, elapsedMs: 100 }),
    { publishable: true, reason: null })
})

test('the policy is a pure function of the two counts', () => {
  const state = { sampleCount: 3, elapsedMs: 100 }
  const first = rateAvailability(state)
  const second = rateAvailability(state)
  assert.notEqual(first, second, 'a fresh object each call, so no caller can mutate a shared verdict')
  assert.deepEqual(first, second)
  assert.deepEqual(state, { sampleCount: 3, elapsedMs: 100 }, 'the input is never written to')
})

test('the policy never clamps, smooths or caps a publishable rate', () => {
  /**
   * The gate answers eligibility only. A value that passes both gates is
   * published exactly as computed — the 1564 tokens/s ceiling MiMo applies is
   * deliberately absent, and so is every smoothing operation: those would change
   * a number that the evidence does support, which is not what the defect was.
   */
  const source = String(rateAvailability)
  for (const forbidden of ['clamp', 'min(', 'ema', 'winsor']) {
    assert.equal(source.includes(forbidden), false, `the policy must not contain ${forbidden}`)
  }
  assert.equal(rateIsPublishable({ sampleCount: 1_000, elapsedMs: 100_000 }), true,
    'a very large rate from a long, well-sampled episode is a measurement like any other')
  assert.equal(rateIsPublishable({ sampleCount: 3, elapsedMs: 100 }), true,
    'and the boundary itself is publishable rather than suspicious')
})

test('the four refusal reasons are a closed vocabulary', () => {
  assert.deepEqual(Object.values(RateUnavailable).sort(), [
    'below-elapsed-horizon',
    'below-sample-warmup',
    'no-episode',
    'opening-anchor',
  ])
  assert.equal(Object.isFrozen(RateUnavailable), true)
})
