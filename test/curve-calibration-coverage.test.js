/**
 * Curve calibration **coverage**: how much of the curve a provider total anchored.
 *
 * ## The defect this file was written against
 *
 * `curveSource` reported `calibratedForCurve: calibratedCount > 0`. A turn of three
 * contributing attempts in which two reported usage and one did not was therefore
 * published as a calibrated curve, and `curve.source.calibrated` — and
 * `curveViewModel.calibrated` downstream — read `true` for a curve one third of which
 * was still a raw heuristic shape.
 *
 * The mixed magnitudes themselves are not the defect, and this phase does **not**
 * remove them. An anchored attempt's estimate is calibrated to its provider counter;
 * an unanchored attempt's stays the coarse shape weight; both are legitimate best
 * estimates, the peak is printed with `≈` at every coverage level, and dropping the
 * unanchored attempt would remove real generation from the chart. What was wrong was
 * the **provenance claim**.
 *
 * ## What is frozen here
 *
 * `curve.source.calibrationCoverage` states the coverage explicitly:
 *
 *   | value      | condition                                              |
 *   |------------|--------------------------------------------------------|
 *   | `full`     | aligned, `contributingCount > 0`, all anchored         |
 *   | `partial`  | aligned, `0 < calibratedCount < contributingCount`      |
 *   | `none`     | aligned, `calibratedCount === 0`                        |
 *   | `fallback` | the join could not be trusted (`aligned === false`)     |
 *
 * `curve.source.calibrated` keeps its name but narrows to its honest meaning:
 * **full coverage only**. It is never `true` for a partially calibrated curve, and
 * `curveViewModel.calibrated` follows it.
 *
 * Absence of usage is evidence quality, never alignment corruption: an unanchored
 * attempt inside an aligned join raises no issue, and `aligned` stays `true`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveSource } from '../src/core/curve-source.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'

/** 400 characters weigh exactly 100 by `heuristicTokenWeight`. */
const DELTA_CHARS = 400

const outputChunk = text => ({ type: 'text-delta', index: 0, text })

/**
 * A turn of several attempts, each with two deltas half a window apart.
 *
 * `usages` is positional: `null` means the attempt reported no provider usage at all,
 * which is the case the coverage levels are about.
 */
function drive(usages) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  usages.forEach((usage, index) => {
    const attempt = store.beginAttempt(record, {
      attemptId: `attempt-${index + 1}`,
      step: index + 1,
      startedAtMs: index * 1000,
    })
    store.acceptChunk(record, attempt, { timeMs: index * 1000, chunk: outputChunk('x'.repeat(DELTA_CHARS)) })
    store.acceptChunk(record, attempt, { timeMs: index * 1000 + 500, chunk: outputChunk('x'.repeat(DELTA_CHARS)) })
    store.settleAttempt(attempt, {
      settledAtMs: index * 1000 + 550,
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
      usage,
      settlementSeq: index + 1,
    })
  })
  const settled = store.endTurn(record, { timeMs: usages.length * 1000 + 1000, status: 'completed' })
  return { record, settled }
}

const ANCHOR = { outputTokens: 900, reasoningTokens: 0 }

// ---------------------------------------------------------------------------
// 1. The four coverage levels
// ---------------------------------------------------------------------------

test('full coverage: every contributing attempt was anchored', () => {
  const { record, settled } = drive([ANCHOR, { outputTokens: 300, reasoningTokens: 0 }])
  const source = curveSource(record.attempts, settled.attemptBreakdown)

  assert.equal(source.aligned, true)
  assert.equal(source.contributingCount, 2)
  assert.equal(source.calibratedCount, 2)
  assert.equal(source.calibrationCoverage, 'full')
  assert.equal(source.calibratedForCurve, true, 'a fully anchored curve is a calibrated curve')
  assert.deepEqual(source.issues, [])

  assert.equal(settled.curve.source.calibrationCoverage, 'full')
  assert.equal(settled.curve.source.calibrated, true)
  assert.equal(curveViewModel(settled).calibrated, true)
})

test('partial coverage: some attempts were anchored and some were not', () => {
  /**
   * The audit's own case: A and B report usage, C does not. The join is aligned, two
   * of three attempts are anchored, and the curve as a whole is **not** calibrated.
   */
  const { record, settled } = drive([ANCHOR, { outputTokens: 300, reasoningTokens: 0 }, null])
  const source = curveSource(record.attempts, settled.attemptBreakdown)

  assert.equal(source.aligned, true, 'missing usage is a magnitude gap, not a misalignment')
  assert.equal(source.contributingCount, 3)
  assert.equal(source.calibratedCount, 2)
  assert.equal(source.calibrationCoverage, 'partial')
  assert.equal(source.calibratedForCurve, false,
    'a curve one third of which is a raw heuristic shape is not a calibrated curve')
  assert.deepEqual(source.issues, [],
    'an attempt with no usage raises no source issue: absence of usage is evidence quality')
  assert.deepEqual(source.rawFallbackAttemptIds, [],
    'and nothing fell back to the raw shape for an alignment reason')

  /** Per-attempt provenance is unchanged and remains readable. */
  assert.deepEqual(source.attempts.map(attempt => attempt.anchored), [true, true, false])
  assert.deepEqual(source.attempts.map(attempt => attempt.attemptId),
    ['attempt-1', 'attempt-2', 'attempt-3'])

  assert.equal(settled.curve.source.calibrationCoverage, 'partial')
  assert.equal(settled.curve.source.calibrated, false)
  assert.equal(settled.curve.source.contributingAttemptCount, 3)
  assert.equal(settled.curve.source.calibratedAttemptCount, 2)
  assert.equal(curveViewModel(settled).calibrated, false,
    '`curveViewModel.calibrated` means the whole curve, so it is false here')
})

test('no coverage: no attempt reported usage, and the raw shape is drawn honestly', () => {
  const { record, settled } = drive([null, null])
  const source = curveSource(record.attempts, settled.attemptBreakdown)

  assert.equal(source.aligned, true)
  assert.equal(source.contributingCount, 2)
  assert.equal(source.calibratedCount, 0)
  assert.equal(source.calibrationCoverage, 'none')
  assert.equal(source.calibratedForCurve, false)
  assert.deepEqual(source.issues, [])

  assert.equal(settled.curve.source.calibrationCoverage, 'none')
  assert.equal(settled.curve.source.calibrated, false)
  assert.equal(curveViewModel(settled).calibrated, false)

  /** Nothing was invented: the samples are the raw shape weights, relabelled. */
  for (const attempt of settled.curve.attempts) {
    assert.equal(attempt.tokens, 2 * 100)
    for (const sample of attempt.samples) assert.equal(sample.quality, 'estimated')
  }
})

test('fallback: an untrustworthy join degrades the whole curve, and says so', () => {
  const { record, settled } = drive([ANCHOR, ANCHOR])
  /** Positionally plausible, identity-wise wrong. */
  const swapped = [settled.attemptBreakdown[1], settled.attemptBreakdown[0]]
  const source = curveSource(record.attempts, swapped)

  assert.equal(source.aligned, false)
  assert.equal(source.calibrationCoverage, 'fallback')
  assert.equal(source.calibratedForCurve, false)
  assert.equal(source.calibratedCount, 0, 'a refused join anchors nothing')
  assert.deepEqual(source.rawFallbackAttemptIds, ['attempt-1', 'attempt-2'])
  assert.match(source.issues.join(' '), /misaligned/)

  /**
   * The settled curve is not rebuilt here, so the level is asserted through a source
   * of the same shape the store publishes.
   */
  assert.equal(source.attempts, record.attempts, 'the raw evidence is returned untouched')
})

test('an empty turn is `none`, never `full` by vacuous truth', () => {
  const source = curveSource([], [])
  assert.equal(source.aligned, true)
  assert.equal(source.contributingCount, 0)
  assert.equal(source.calibrationCoverage, 'none')
  assert.equal(source.calibratedForCurve, false,
    'coverage is a claim about evidence that exists, so zero attempts cover nothing')
})

// ---------------------------------------------------------------------------
// 2. The peak stays approximate at every coverage level
// ---------------------------------------------------------------------------

test('the peak remains approximate under full, partial and absent coverage', () => {
  /**
   * Per-delta allocation is reconstructed at every coverage level: a provider total
   * anchors an attempt's **integral**, never the individual vertices, and DSH attaches
   * no token count to a delta. An anchored winning attempt therefore does not make the
   * peak exact, and the user-facing representation is `≈` in every case.
   */
  const cases = [
    { name: 'full', usages: [ANCHOR, { outputTokens: 300, reasoningTokens: 0 }] },
    { name: 'partial', usages: [ANCHOR, { outputTokens: 300, reasoningTokens: 0 }, null] },
    { name: 'none', usages: [null, null] },
  ]
  for (const { name, usages } of cases) {
    const { settled } = drive(usages)
    const view = curveViewModel(settled)
    assert.ok(view.peak.value > 0, `${name}: the turn must have a peak to reason about`)
    assert.equal(view.peak.approximate, true, `${name}: the peak is still a sample of a reconstructed series`)
    assert.match(view.peak.display, /^≈/, `${name}: and it is printed with the approximation mark`)
  }
})

test('the winning attempt\'s anchoring does not upgrade the peak', () => {
  /**
   * The peak may come from an anchored attempt or from an unanchored one. Both are
   * estimates of the same kind, so identifying which one won must not change how the
   * number is presented — which is why the coverage level travels in the provenance
   * rather than in the peak's label.
   */
  const anchoredWins = drive([ANCHOR, null])
  const unanchoredWins = drive([{ outputTokens: 50, reasoningTokens: 0 }, null])

  const peakAttemptOf = settled => settled.curve.attempts
    .find(attempt => attempt.points.some(point => Math.abs(point.tps - settled.curve.peakTps) < 1e-9))

  const winnerA = peakAttemptOf(anchoredWins.settled)
  const winnerB = peakAttemptOf(unanchoredWins.settled)
  assert.equal(winnerA.calibrated, true, 'this fixture\'s peak comes from the anchored attempt')
  assert.equal(winnerB.calibrated, false, 'and this one\'s from the unanchored attempt')

  for (const { settled } of [anchoredWins, unanchoredWins]) {
    const view = curveViewModel(settled)
    assert.equal(view.peak.approximate, true)
    assert.equal(view.peak.display.startsWith('≈'), true)
    assert.equal(settled.curve.source.calibrationCoverage, 'partial')
  }
})

// ---------------------------------------------------------------------------
// 3. The view model carries the coverage, and does not overstate it
// ---------------------------------------------------------------------------

test('the view model reports the same coverage the curve source published', () => {
  for (const [usages, expected] of [
    [[ANCHOR], 'full'],
    [[ANCHOR, null], 'partial'],
    [[null, null], 'none'],
  ]) {
    const { settled } = drive(usages)
    const view = curveViewModel(settled)
    assert.equal(settled.curve.source.calibrationCoverage, expected)
    assert.equal(view.calibrationCoverage, expected)
    assert.equal(view.calibrated, expected === 'full',
      'the boolean keeps its narrow meaning: full coverage only')
  }
})
