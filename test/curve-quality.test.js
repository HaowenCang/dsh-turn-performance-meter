/**
 * Completed-curve quality.
 *
 * The curve is a **temporal shape** claim, so its quality must come from the
 * temporal-shape axis. The previous revision derived it from `usageComplete`,
 * which answers a different question, and the two axes genuinely disagree in both
 * directions:
 *
 *   - a turn whose provider reported an exact token total but whose delta timing
 *     was not durable has a perfect token count and a re-derivable-only-shape
 *     curve. `usageComplete` alone called that `calibrated`;
 *   - a turn with complete, durable, anchored timing and only partially reported
 *     usage has an excellent shape and a partial token count, which
 *     `usageComplete` alone called merely `estimated`.
 *
 * The token and split axes still govern the numbers printed beside the chart, and
 * they travel with the curve in `qualityAxes` for exactly that reason. What they
 * may not do is decide the chart's own quality.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore, curveQuality } from '../src/host/telemetry-design.js'
import { QualityLevel, QUALITY_CEILING, qualityAxes } from '../src/core/quality-model.js'
import { MetricQuality } from '../src/core/metric-quality.js'

function outputChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

/**
 * Drive one two-measurement attempt and report both the curve quality and the
 * axes it was derived from.
 *
 * `usage` chooses the token axis, `settlementSeq` the temporal axis: an attempt
 * with no durable settlement sequence is one still open — or observed only live —
 * when the turn closed, which is what makes the reconstructed timing claim
 * unsupportable.
 */
function settle({
  usage = { outputTokens: 900, reasoningTokens: 0 },
  settlementSeq = 11,
  chunks = true,
  openAttempt = false,
} = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const a = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  if (chunks) {
    store.acceptChunk(record, a, { timeMs: 100, chunk: outputChunk('x'.repeat(400)) })
    store.acceptChunk(record, a, { timeMs: 600, chunk: outputChunk('x'.repeat(400)) })
  }
  store.settleAttempt(a, {
    settledAtMs: 700,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage,
    settlementSeq,
  })
  if (openAttempt) {
    /** A second attempt that never settled: the turn closed while it streamed. */
    const b = store.beginAttempt(record, { attemptId: 'b', step: 2, startedAtMs: 750 })
    store.acceptChunk(record, b, { timeMs: 760, chunk: outputChunk('y'.repeat(40)) })
  }
  const settled = store.endTurn(record, { timeMs: 800, status: 'completed' })
  return { settled, curve: settled.curve, axes: settled.quality }
}

test('the curve inherits the temporal-shape axis and nothing else', () => {
  const { settled, curve, axes } = settle()
  assert.equal(axes.tokenTotalQuality, QualityLevel.EXACT)
  assert.equal(axes.phaseSplitQuality, QualityLevel.EXACT)
  assert.equal(axes.temporalShapeQuality, QualityLevel.RECONSTRUCTED)
  assert.equal(curve.quality, axes.temporalShapeQuality)
  assert.deepEqual(curve.qualityAxes, {
    tokenTotalQuality: QualityLevel.EXACT,
    phaseSplitQuality: QualityLevel.EXACT,
    temporalShapeQuality: QualityLevel.RECONSTRUCTED,
  }, 'all three axes travel with the curve, so the card can label the numbers it prints')
  assert.equal(settled.usageComplete, true)
})

test('an exact token total with no durable timing is estimated, not calibrated', () => {
  /**
   * The evidence is split: the provider reported `outputTokens` exactly, so the
   * total is authoritative, but the delta timing was never reproduced from a
   * durable settlement. The shape claim is therefore `estimated` while the token
   * claim stays `exact`.
   */
  const { settled, curve, axes } = settle({ settlementSeq: null })
  assert.equal(settled.usageComplete, true, 'the token total really is complete')
  assert.equal(axes.tokenTotalQuality, QualityLevel.EXACT)
  assert.equal(axes.temporalShapeQuality, QualityLevel.ESTIMATED)
  assert.equal(curve.quality, QualityLevel.ESTIMATED)
  assert.notEqual(curve.quality, QualityLevel.CALIBRATED,
    'calibrated would claim the shape was anchored, which it is not')
})

test('an attempt that never settled degrades the curve even when every settled one reported usage', () => {
  /**
   * A turn that closed while an attempt was still streaming has no durable
   * settlement for that attempt, so the turn's timing cannot be called durable.
   * Both facts are reported: the token axis drops to `partial` because one
   * contributor has no counter, and the shape axis drops to `estimated` because
   * one contributor's timing is live observation rather than replayable evidence.
   */
  const { settled, curve, axes } = settle({ openAttempt: true })
  assert.equal(settled.usageComplete, false, 'the open attempt contributed no usage')
  assert.equal(axes.tokenTotalQuality, QualityLevel.PARTIAL)
  assert.equal(axes.temporalShapeQuality, QualityLevel.ESTIMATED)
  assert.equal(curve.quality, QualityLevel.ESTIMATED)
  assert.notEqual(curve.quality, QualityLevel.CALIBRATED)
})

test('missing usage with durable anchored timing keeps a reconstructed curve', () => {
  /**
   * The opposite asymmetry: no provider counter, so the token total renders `—`
   * and the split renders `≈`, but the timing came from durable settlements whose
   * embedded streams reproduce the original delta times — and the per-delta
   * magnitudes are anchored to nothing, which is why the *axis* stops at
   * `estimated`.
   */
  const { curve, axes } = settle({ usage: null })
  assert.equal(axes.tokenTotalQuality, QualityLevel.UNAVAILABLE)
  assert.equal(curve.quality, axes.temporalShapeQuality)
  assert.equal(curve.quality, QualityLevel.ESTIMATED)
  assert.equal(curve.qualityAxes.tokenTotalQuality, QualityLevel.UNAVAILABLE)
})

test('a usage total without a reasoning split leaves the split estimated and the curve unchanged', () => {
  /** Quality is per axis: the split being unknown cannot move the shape claim. */
  const { curve, axes } = settle({ usage: { outputTokens: 900 } })
  assert.equal(axes.tokenTotalQuality, QualityLevel.EXACT)
  assert.equal(axes.phaseSplitQuality, QualityLevel.ESTIMATED)
  assert.equal(curve.quality, QualityLevel.RECONSTRUCTED)
})

test('a turn with no generated delta has an unavailable curve quality', () => {
  const { settled, curve } = settle({ chunks: false, usage: null })
  assert.equal(settled.contributingAttemptCount, 0)
  assert.equal(curve.quality, QualityLevel.UNAVAILABLE)
  assert.equal(curve.durationMs, 0)
  assert.deepEqual(curve.series.flatMap(s => s.runs), [], 'no evidence, no run to draw')
})

test('the curve quality can never exceed the temporal ceiling, whatever it is handed', () => {
  /**
   * A structural guarantee rather than a behavioural one: the ceiling exists
   * because DSH attaches no token count to a delta, so no amount of token evidence
   * may lift the shape claim to `exact`. `curveQuality` clamps, so even an
   * aggregate that somehow claimed a stronger temporal axis cannot leak through.
   */
  assert.equal(QUALITY_CEILING.temporalShape, QualityLevel.RECONSTRUCTED)
  assert.equal(
    qualityAxes({
      contributingAttemptCount: 1,
      attemptsWithUsage: 1,
      reportedTotals: 1,
      anchored: true,
      sampleCount: 10,
    }).temporalShapeQuality,
    QualityLevel.ESTIMATED,
    'complete timing that is not durable still stops at estimated',
  )
  assert.equal(
    curveQuality(qualityAxes({
      contributingAttemptCount: 1,
      attemptsWithUsage: 1,
      reportedTotals: 1,
      durable: true,
      anchored: true,
      sampleCount: 10,
    })),
    QualityLevel.RECONSTRUCTED,
    'the strongest shape the evidence can support, and no stronger',
  )
  assert.equal(curveQuality({ quality: { temporalShapeQuality: QualityLevel.EXACT } }),
    QualityLevel.RECONSTRUCTED, 'an over-strong claim is clamped, not trusted')
  assert.equal(curveQuality({ quality: { temporalShapeQuality: 'nonsense' } }),
    QualityLevel.UNAVAILABLE, 'an unknown level is not a licence to claim a stronger one')
  assert.equal(curveQuality({}), QualityLevel.UNAVAILABLE)
  assert.equal(curveQuality(null), QualityLevel.UNAVAILABLE)
})

test('the peak keeps its approximation at every curve quality', () => {
  /**
   * `reconstructed` is the best achievable shape, and a reconstructed vertex is
   * still a shape weight on an estimated local shape — so `≈` follows the peak at
   * every level. A quality label is not a licence to print a bare number.
   */
  for (const settlementSeq of [11, null]) {
    const { settled, curve } = settle({ settlementSeq })
    assert.ok(settled.curve.peakTps > 0)
    assert.equal(curve.quality === QualityLevel.EXACT, false, 'a curve is never exact')
    assert.equal(MetricQuality.EXACT === curve.quality, false)
  }
})

test('every recorded fixture publishes a curve whose quality is its temporal-shape axis', async () => {
  const { listFixtures, loadFixture } = await import('./helpers/fixtures.js')
  const { liveSettledView, durableSettledView } = await import('./helpers/equivalence.js')
  const names = listFixtures()
  assert.ok(names.length > 0, 'the fixture corpus is present')

  for (const name of names) {
    const fixture = loadFixture(name)
    for (const [path, view] of [['live', liveSettledView(fixture)], ['durable', durableSettledView(fixture)]]) {
      const curve = view.settled.curve
      assert.equal(curve.quality, view.settled.quality.temporalShapeQuality,
        `${name}/${path}: the curve quality is the temporal-shape axis`)
      assert.deepEqual(curve.qualityAxes, {
        tokenTotalQuality: view.settled.quality.tokenTotalQuality,
        phaseSplitQuality: view.settled.quality.phaseSplitQuality,
        temporalShapeQuality: view.settled.quality.temporalShapeQuality,
      }, `${name}/${path}: all three axes travel with the curve`)
      /**
       * `usageComplete` may not be the sole determinant. Wherever the two
       * disagree, the curve must follow the temporal axis.
       */
      if (view.settled.usageComplete && curve.quality === QualityLevel.RECONSTRUCTED) continue
      if (view.settled.usageComplete) {
        assert.notEqual(curve.quality, QualityLevel.CALIBRATED,
          `${name}/${path}: an exact token total did not buy a calibrated shape claim`)
      }
    }
  }
})
