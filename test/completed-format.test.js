/**
 * Formatter edge cases.
 *
 * Every number the user can see passes through these functions, so this file is
 * the place where "no `NaN`, no `Infinity`, no `-0`, no `undefined`" is enforced
 * rather than assumed. The rules are asserted against the values a real turn
 * produces: a 54,770-token turn, a 345 TPS rate, a 0.42 s tool call, a turn that
 * ran for two minutes, and an absent measurement.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { formatCountdown, formatDuration, formatSeconds, formatTokens, formatTps, DASH } from '../src/client/format.js'
import { formatApproxTps, formatElapsed, formatStopwatch, formatToolLabel, truncateToolName } from '../src/client/live/live-format.js'

/** Anything that must never reach the DOM. */
const FORBIDDEN = /NaN|Infinity|undefined|null|\[object/
const BAD = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'abc', {}, []]

test('no formatter ever emits NaN, Infinity, undefined, null or -0', () => {
  const cases = [...BAD, -0, -1, -0.4, 0, 0.0001, 0.9999, 1, 1e-9, 999.999, 1000, 1234.5, 1e9]
  for (const value of cases) {
    for (const [name, fn] of [
      ['formatSeconds', formatSeconds],
      ['formatCountdown', formatCountdown],
      ['formatTps', formatTps],
      ['formatTokens', formatTokens],
      ['formatDuration', formatDuration],
      ['formatApproxTps', formatApproxTps],
      ['formatElapsed', formatElapsed],
      ['formatStopwatch', formatStopwatch],
    ]) {
      const text = String(fn(value))
      assert.equal(FORBIDDEN.test(text), false, `${name}(${String(value)}) produced "${text}"`)
      assert.equal(Object.is(Number(text), -0), false, `${name}(${String(value)}) produced a negative zero`)
      assert.notEqual(text, '', `${name}(${String(value)}) produced an empty string`)
    }
  }
})

test('an absent measurement is always the shared em dash', () => {
  assert.equal(DASH, '—')
  assert.equal(formatSeconds(null), DASH)
  assert.equal(formatTps(Number.NaN), DASH)
  assert.equal(formatTokens(undefined), DASH)
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), DASH)
  assert.equal(formatApproxTps(null, true), DASH)
  assert.equal(formatToolLabel([], 0), DASH)
  assert.equal(truncateToolName(''), DASH)
})

test('a negative duration is treated as absent, not as a negative time', () => {
  assert.equal(formatDuration(-1), DASH)
  assert.equal(formatDuration(-60_000), DASH)
  assert.equal(formatSeconds(-1), '-0.0s', 'the seconds formatter keeps its fixed precision contract')
  assert.equal(Object.is(formatTokens(-0), '0'), true, 'a rounded negative zero prints as 0')
})

test('TPS keeps three significant digits at every magnitude', () => {
  assert.equal(formatTps(345.123), '345')
  assert.equal(formatTps(676.4), '676')
  assert.equal(formatTps(76.5432), '76.5')
  assert.equal(formatTps(7.65432), '7.65')
  assert.equal(formatTps(0.5), '0.50')
  assert.equal(formatTps(0), '0.00', 'a measured zero rate is a real number, not an absence')
  assert.equal(formatTps(9.999), '10.0', 'rounding across a boundary stays in the larger band')
})

test('a token magnitude of a thousand or more keeps its locale grouping', () => {
  assert.equal(formatTps(54_770), '54,770')
  assert.equal(formatTps(1_308), '1,308')
  assert.equal(formatTps(999.4), '999')
  assert.equal(formatTokens(54_770), '54,770')
  assert.equal(formatTokens(1_308), '1,308')
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999.6), '1,000', 'display rounding must not lose the grouping')
})

test('the approximate marker is a prefix, never a tilde', () => {
  assert.equal(formatApproxTps(345.123, true), '≈345')
  assert.equal(formatApproxTps(345.123, false), '345')
  assert.equal(formatApproxTps(38.44, true), '≈38.4')
  for (const text of [formatApproxTps(1, true), formatApproxTps(999, true), formatApproxTps(54_770, true)]) {
    assert.equal(text.startsWith('≈'), true)
    assert.equal(text.includes('~'), false, 'the ASCII tilde is not the approximate marker')
  }
})

test('durations read in seconds below a minute and in minutes above it', () => {
  assert.equal(formatDuration(0), '0.0s')
  assert.equal(formatDuration(914), '0.9s')
  assert.equal(formatDuration(8085), '8.1s')
  assert.equal(formatDuration(59_949), '59.9s')
  assert.equal(formatDuration(60_000), '1m00s')
  assert.equal(formatDuration(133_600), '2m14s')
  assert.equal(formatDuration(162_400), '2m42s')
  assert.equal(formatDuration(3_600_000), '60m00s')
})

test('the card keeps one-decimal seconds at every magnitude', () => {
  // The card's own scale: `108.2s`, `133.6s`. Asserted here because the two
  // duration scales exist side by side and must not be swapped by accident.
  assert.equal(formatSeconds(108_200, 1), '108.2s')
  assert.equal(formatSeconds(133_600, 1), '133.6s')
  assert.equal(formatSeconds(1440, 2), '1.44s')
  assert.equal(formatSeconds(4980, 2), '4.98s')
  assert.equal(formatSeconds(4420, 2), '4.42s')
})

test('the running stopwatch shows hundredths and the card value does not', () => {
  assert.equal(formatStopwatch(2800), '2.80 s')
  assert.equal(formatStopwatch(0), '0.00 s')
  assert.equal(formatSeconds(2800, 2), '2.80s')
})

test('tool labels distinguish one call from several in every locale', () => {
  assert.equal(formatToolLabel(['pwsh'], 1), 'pwsh')
  assert.equal(formatToolLabel(['pwsh', 'read'], 2), 'pwsh +1')
  assert.equal(formatToolLabel(['pwsh', 'read', 'grep'], 3), 'pwsh +2')
  assert.equal(formatToolLabel(['a-very-long-tool-name-here', 'x'], 2), 'a-very-long-tool-na… +1')
  assert.equal(truncateToolName('a-very-long-tool-name-here', 10), 'a-very-lo…')
  assert.equal(truncateToolName('short'), 'short')
})

test('a fractional count never produces a fractional tool label', () => {
  const label = formatToolLabel(['pwsh'], 2.7)
  assert.equal(label, 'pwsh +2', 'the count is rounded, not carried as a fraction')
  assert.equal(/\./.test(label), false)
  assert.equal(formatToolLabel(['pwsh'], Number.NaN), 'pwsh')
  assert.equal(formatToolLabel(undefined, 3), '+2')
})
