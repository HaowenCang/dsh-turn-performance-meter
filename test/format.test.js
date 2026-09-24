import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSeconds, formatTps, formatTokens, formatCountdown } from '../src/client/format.js'
import { MetricQuality } from '../src/core/metric-quality.js'

test('an unavailable number renders as an em dash, never as zero or NaN', () => {
  assert.equal(formatSeconds(null), '—')
  assert.equal(formatSeconds(Number.NaN), '—')
  assert.equal(formatTps(null), '—')
  assert.equal(formatTps(Number.POSITIVE_INFINITY), '—')
  assert.equal(formatTokens(undefined), '—')
  assert.equal(formatCountdown(null), '—')
})

test('seconds are displayed with fixed precision', () => {
  assert.equal(formatSeconds(0), '0.0s')
  assert.equal(formatSeconds(1440), '1.4s')
  assert.equal(formatSeconds(2800), '2.8s')
  assert.equal(formatSeconds(2800, 2), '2.80s')
})

test('TPS keeps significant digits instead of collapsing to one significant figure', () => {
  assert.equal(formatTps(338.4), '338')
  assert.equal(formatTps(38.44), '38.4')
  assert.equal(formatTps(3.844), '3.84')
  assert.equal(formatTps(0), '0.00')
})

test('token totals are grouped for readability', () => {
  assert.equal(formatTokens(54770), '54,770')
  assert.equal(formatTokens(0), '0')
})

test('the countdown reads as a running counter', () => {
  assert.equal(formatCountdown(2800), '2.80 s')
  assert.equal(formatCountdown(0), '0.00 s')
})

test('quality is carried alongside the formatted value, not baked into it', () => {
  // The renderer decides between a plain number and a `≈` prefix; the formatter
  // must not make that decision, or the exactness claim would live in two places.
  assert.equal(formatTps(42), '42.0')
  assert.equal(MetricQuality.EXACT, 'exact')
})
