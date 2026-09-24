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
  truncateToolName,
} from '../src/client/live/live-format.js'

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
  assert.equal(formatStopwatch(2800), '2.80 s')
  assert.equal(formatStopwatch(860), '0.86 s')
  assert.equal(formatStopwatch(0), '0.00 s')
  assert.equal(formatStopwatch(null), DASH)
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
