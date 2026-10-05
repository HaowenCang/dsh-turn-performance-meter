/**
 * Live formatting: the ≈ contract, stopwatches and tool labels.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DASH,
  formatApproxTps,
  formatElapsed,
  formatStopwatch,
  formatToolLabel,
  stopwatchParts,
  truncateToolName,
} from '../src/client/live/live-format.js'
import { LIVE_CSS } from '../src/client/live/live-css.js'

test('an estimated live TPS always renders with ≈, an exact one never does', () => {
  assert.equal(formatApproxTps(338.4, true), '≈338')
  assert.equal(formatApproxTps(38.44, true), '≈38.4')
  assert.equal(formatApproxTps(338.4, false), '338', 'only an exact quality may drop the marker')
  assert.equal(formatApproxTps(null, true), DASH, 'absent evidence is an em dash, never ≈0')
  assert.equal(formatApproxTps(Number.NaN, true), DASH)
  assert.equal(formatApproxTps(Number.POSITIVE_INFINITY, true), DASH)
})

test('elapsed and stopwatch formats are distinct and stable', () => {
  assert.equal(formatElapsed(17_300), '17.3s')
  assert.equal(formatElapsed(2800), '2.8s')
  assert.equal(formatElapsed(142_000), '2m22s')
  assert.equal(formatElapsed(null), DASH)
  assert.equal(formatStopwatch(2800), '2.8 s')
  assert.equal(formatStopwatch(860), '0.9 s')
  assert.equal(formatStopwatch(3370), '3.4 s')
  assert.equal(formatStopwatch(0), '0.0 s')
  assert.equal(formatStopwatch(null), DASH)
})

test('stopwatch boundary rounding cases follow toFixed(1)', () => {
  assert.equal(formatStopwatch(1049), '1.0 s')
  assert.equal(formatStopwatch(1050), '1.1 s')
  assert.equal(formatStopwatch(1099), '1.1 s')
  assert.deepEqual(stopwatchParts(1049), { value: '1.0', unit: 's' })
  assert.deepEqual(stopwatchParts(1050), { value: '1.1', unit: 's' })
  assert.deepEqual(stopwatchParts(1099), { value: '1.1', unit: 's' })
})

test('an absent stopwatch duration is the em dash with no unit, never a zeroed counter', () => {
  /**
   * The pill passes its stopwatch duration straight to `stopwatchParts` (Phase
   * 9.4.2 removed the `?? 0` coercion at the three call sites), so this function is
   * where "the duration does not exist" is distinguished from "the duration is
   * zero".
   *
   * `{ value: '—', unit: null }` renders the em dash with **no** unit, which is the
   * rule for absent evidence (UI_SPEC §12); `{ value: '0.0', unit: 's' }` is a
   * measured zero-length duration and must keep rendering as one. The states that
   * reach the em dash are real: a boundary-only first token has opened no phase
   * episode, and a turn adopted mid-turn was never observed to start.
   */
  assert.deepEqual(stopwatchParts(null), { value: DASH, unit: null })
  assert.deepEqual(stopwatchParts(undefined), { value: DASH, unit: null })
  assert.deepEqual(stopwatchParts(Number.NaN), { value: DASH, unit: null })
  assert.deepEqual(stopwatchParts(Number.POSITIVE_INFINITY), { value: DASH, unit: null })
  assert.deepEqual(stopwatchParts(0), { value: '0.0', unit: 's' },
    'a measured zero is still a measurement')
  assert.deepEqual(stopwatchParts(2800), { value: '2.8', unit: 's' })
})

test('live stopwatch formatting is presentation-only and leaves internal view model unquantized', () => {
  const viewModel = {
    kind: 'waiting',
    waitMs: 3374,
    elapsedMs: 512_000,
  }
  assert.equal(viewModel.waitMs, 3374, 'underlying view/model value remains 3374')
  assert.equal(formatStopwatch(viewModel.waitMs), '3.4 s', 'formatted output is 3.4 s')
  assert.deepEqual(stopwatchParts(viewModel.waitMs), { value: '3.4', unit: 's' })
  assert.equal(viewModel.waitMs, 3374, 'formatting never mutates or quantizes the view model')

  const warmingView = {
    kind: 'warming',
    counterMs: 3374,
    elapsedMs: 12_000,
  }
  assert.equal(warmingView.counterMs, 3374)
  assert.equal(formatStopwatch(warmingView.counterMs), '3.4 s')
  assert.deepEqual(stopwatchParts(warmingView.counterMs), { value: '3.4', unit: 's' })
  assert.equal(warmingView.counterMs, 3374)
})

test('live pill CSS contract enforces shared typographic baseline without visual patch hacks', () => {
  const pillBlock = LIVE_CSS.match(/\.dsh-tpm-pill\s*\{([^}]+)\}/)?.[1]
  assert.ok(pillBlock, '.dsh-tpm-pill block exists')
  assert.match(pillBlock, /align-items:\s*baseline;/, '.dsh-tpm-pill uses align-items: baseline')

  const metricBlock = LIVE_CSS.match(/\.dsh-tpm-metric\s*\{([^}]+)\}/)?.[1]
  assert.ok(metricBlock, '.dsh-tpm-metric block exists')
  assert.match(metricBlock, /align-items:\s*baseline;/, '.dsh-tpm-metric uses align-items: baseline')

  const sepBlock = LIVE_CSS.match(/\.dsh-tpm-sep\s*\{([^}]+)\}/)?.[1]
  assert.ok(sepBlock, '.dsh-tpm-sep block exists')
  assert.match(sepBlock, /align-self:\s*stretch;/, '.dsh-tpm-sep retains align-self: stretch')

  assert.doesNotMatch(LIVE_CSS, /translateY/i, 'no translateY vertical shifts')
  assert.doesNotMatch(LIVE_CSS, /position:\s*relative/i, 'no position: relative vertical offsets')
  assert.doesNotMatch(LIVE_CSS, /margin-top:/i, 'no state-specific margin-top alignment')
  assert.doesNotMatch(LIVE_CSS, /top:/i, 'no top offset hacks')
})

test('long tool names truncate with an ellipsis instead of stretching the pill', () => {
  const long = 'extremely-long-tool-name-that-would-overflow-the-compact-pill'
  const truncated = truncateToolName(long)
  assert.equal(truncated.length, 20)
  assert.ok(truncated.endsWith('…'))
  assert.equal(truncateToolName('pwsh'), 'pwsh', 'short names pass through untouched')
  assert.equal(truncateToolName(''), DASH)
  assert.equal(truncateToolName(null), DASH)
})

test('the tool label distinguishes a single tool from concurrent tools', () => {
  assert.equal(formatToolLabel(['pwsh'], 1), 'pwsh')
  assert.equal(formatToolLabel(['pwsh', 'write'], 2), 'pwsh +1')
  assert.equal(formatToolLabel(['a-very-long-tool-name-that-keeps-going', 'b'], 2), 'a-very-long-tool-na… +1')
  assert.equal(formatToolLabel([], 3), '+2', 'even without names the count is visible')
  assert.equal(formatToolLabel([], 1), DASH, 'one unnamed tool has no label to show')
  assert.equal(formatToolLabel([], 0), DASH)
  assert.equal(formatToolLabel(undefined, undefined), DASH)
})
