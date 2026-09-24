import test from 'node:test'
import assert from 'node:assert/strict'
import { MetricQuality, isMetricQuality, rateQuality, weakestQuality } from '../src/core/metric-quality.js'

test('weakestQuality returns the weakest evidence among its arguments', () => {
  assert.equal(weakestQuality(MetricQuality.EXACT, MetricQuality.CALIBRATED), MetricQuality.CALIBRATED)
  assert.equal(weakestQuality(MetricQuality.EXACT, MetricQuality.ESTIMATED, MetricQuality.CALIBRATED), MetricQuality.ESTIMATED)
  assert.equal(weakestQuality(MetricQuality.UNAVAILABLE, MetricQuality.EXACT), MetricQuality.UNAVAILABLE)
  assert.equal(weakestQuality(MetricQuality.EXACT), MetricQuality.EXACT)
})

test('an empty or unknown quality set degrades to unavailable rather than to exact', () => {
  assert.equal(weakestQuality(), MetricQuality.UNAVAILABLE)
  assert.equal(weakestQuality(MetricQuality.EXACT, 'guessed'), MetricQuality.UNAVAILABLE)
})

test('rateQuality refuses to call a partially measured denominator exact', () => {
  assert.equal(rateQuality({ measuredRatio: 1 }), MetricQuality.EXACT)
  assert.equal(rateQuality({ measuredRatio: 2 / 3 }), MetricQuality.ESTIMATED)
  assert.equal(rateQuality({ measuredRatio: 0 }), MetricQuality.UNAVAILABLE)
  assert.equal(rateQuality({ measuredRatio: Number.NaN }), MetricQuality.UNAVAILABLE)
})

test('a complete denominator with an inexact numerator is never exact', () => {
  assert.equal(rateQuality({ measuredRatio: 1, tokensExact: false }), MetricQuality.ESTIMATED)
  assert.equal(rateQuality({ measuredRatio: 1, phaseSplitExact: false }), MetricQuality.CALIBRATED)
})

test('isMetricQuality accepts exactly the four declared values', () => {
  for (const value of Object.values(MetricQuality)) assert.equal(isMetricQuality(value), true)
  assert.equal(isMetricQuality('exact-ish'), false)
  assert.equal(isMetricQuality(undefined), false)
})
