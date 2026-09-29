/**
 * Episode openings under the Phase 9.2 phase-cumulative estimator.
 *
 * ## What this file used to freeze, and what it freezes now
 *
 * The previous revision of this file guarded a trailing-window opening bound: the
 * special case that reopened `(-windowMs, 0]` at an attempt's local zero, and the Phase 7
 * defect it caused at a *resumed* episode inside the same attempt. The window itself no
 * longer exists. The estimator is now the cumulative average of the current phase
 * episode —
 *
 *     tps(t) = Math.round(mass(samples of the episode at or before t) * 1000
 *                         / (t - firstSampleOfThatEpisode))
 *
 * — where an episode is the maximal run of consecutive same-phase samples. Four
 * consequences of that definition are frozen here:
 *
 *   1. **an episode's opening vertex is `0` with `elapsed == 0`.** The vertex that
 *      coincides with the episode's first sample has no elapsed time yet, so it carries
 *      the anchor `0` rather than a division — and it carries it however heavy that first
 *      sample is. It is not a measured zero, and it is not a fabricated trough: the very
 *      next vertex already publishes the episode's full average;
 *   2. **the next vertex is the full cumulative average over the episode so far** — every
 *      sample of the episode at or before the instant, over the whole time since the
 *      episode opened, never a one-step rate;
 *   3. **a second episode of the same phase resets its own clock and its own mass.** A
 *      phase that falls silent and returns is a new episode, not a continuation: it owns
 *      neither the earlier episode's elapsed time nor its tokens;
 *   4. **a phase transition is a shared seam, not a gap.** The two runs that meet at a
 *      transition share one vertex — `runs[i].endIndex === runs[i + 1].startIndex`, one
 *      index in the attempt's own grid, drawn by both subpaths.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { attemptTrace, cumulativePhaseTpsSeries } from '../src/core/curve.js'

const outputChunk = text => ({ type: 'text-delta', index: 0, text })
const reasoningChunk = text => ({ type: 'reasoning-delta', index: 0, text })

// ---------------------------------------------------------------------------
// 1. The opening vertex
// ---------------------------------------------------------------------------

test('an episode opens at 0 because its elapsed time is zero, not because its mass is', () => {
  /**
   * One 400-token delta at local 0, drawn across a 300 ms tail. The opening vertex is
   * `0` while the episode already holds 400 tokens: the zero is the anchor for
   * `elapsed == 0`, and the vertex one ladder step later is the full average.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 400 },
  ], { durationMs: 300, sampleEndMs: 300 })

  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 4000], [200, 2000], [300, 1333],
  ])
  assert.equal(points[0].localMs, 0, 'the opening vertex sits on the episode\'s first sample')
  assert.equal(points[0].tps, 0)
  assert.equal(points[0].activePhase, 'output', 'and it is labelled with that episode\'s phase')

  /**
   * The next vertex is the full cumulative average over the episode so far:
   * `mass(400) * 1000 / (100 - 0) = 4000`. An elapsed time of anything but zero at the
   * opening vertex would have published a rate there; the definition publishes none.
   */
  assert.equal(points[1].tps, Math.round(400 * 1000 / (100 - 0)))
  assert.equal(points[1].tps, 4000)
})

test('the next vertex is the full cumulative average over the episode so far', () => {
  /**
   * Two deltas of one episode — 100 tokens at local 0, 50 tokens at local 50 — and a
   * settlement tail to 200 ms. The vertex at 100 ms carries both deltas over the whole
   * 100 ms since the episode opened, and the vertex at 200 ms carries the same mass over
   * the episode's own 200 ms: the cumulative average grows by accumulation, not by
   * forgetting.
   */
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 200 }, [
    { attemptId: 'a', attemptTimeMs: 0, activeTimeMs: 0, phase: 'output', tokens: 100 },
    { attemptId: 'a', attemptTimeMs: 50, activeTimeMs: 50, phase: 'output', tokens: 50 },
  ], { sampleEveryMs: 100 })

  assert.deepEqual(trace.points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 1500], [200, 750],
  ])
  assert.equal(trace.points[1].tps, Math.round((100 + 50) * 1000 / (100 - 0)))
  assert.equal(trace.points[2].tps, Math.round((100 + 50) * 1000 / (200 - 0)))
  assert.deepEqual(trace.points.map(point => point.activePhase), ['output', 'output', 'output'])
})

// ---------------------------------------------------------------------------
// 2. A second episode of the same phase
// ---------------------------------------------------------------------------

test('a second episode of the same phase after an intervening phase resets its own clock and mass', () => {
  /**
   * Output, reasoning, output again — the third episode is the same **phase** as the
   * first, but not the same episode. It opens its own clock at 600 ms and accumulates
   * only its own two deltas, so its 100 ms vertex reads `200 * 1000 / 100 = 2000`.
   * Carrying either the earlier output episode's mass (which would give 3000) or the
   * attempt's own clock (which would give `300 * 1000 / 700 ≈ 429`) is refused by the
   * definition.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 300, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 600, phase: 'output', tokens: 100 },
    { activeTimeMs: 700, phase: 'output', tokens: 100 },
  ], { durationMs: 700 })

  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 1000], [200, 500],
    [300, 0], [400, 1000], [500, 500],
    [600, 0], [700, 2000],
  ])
  assert.deepEqual(points.map(point => point.activePhase),
    ['output', 'output', 'output', 'reasoning', 'reasoning', 'reasoning', 'output', 'output'])

  assert.equal(points[6].tps, 0, 'the second output episode opens with elapsed == 0, exactly like the first')
  assert.equal(points[7].tps, Math.round(200 * 1000 / (700 - 600)))
  assert.equal(points[7].tps, 2000)
})

test('an episode that opens between two grid instants has no zero vertex: its first sampled vertex measures from the opening', () => {
  /**
   * The reasoning episode opens at 0; the output episode opens at 250 ms, which is not a
   * ladder instant. The opening vertex therefore does not exist on the grid — but the
   * clock still started at the opening, so the vertex at 300 ms measures 50 ms of the
   * output episode, `100 * 1000 / 50 = 2000`, not 100 ms from the previous vertex.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 250, phase: 'output', tokens: 100 },
  ], { durationMs: 400, sampleEndMs: 400 })

  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, 0], [100, 1000], [200, 500], [300, 2000], [400, 667],
  ])
  assert.deepEqual(points.filter(point => point.tps === 0).map(point => point.localMs), [0],
    'the only zero vertex is the attempt\'s own opening: the off-ladder episode opens no anchor')
  assert.equal(points.find(point => point.localMs === 300).tps, Math.round(100 * 1000 / (300 - 250)))
})

// ---------------------------------------------------------------------------
// 3. The transition seam
// ---------------------------------------------------------------------------

test('a phase transition seam is shared by the two runs: runs[i].endIndex === runs[i+1].startIndex', () => {
  /**
   * One attempt with three episodes — output, reasoning, output — driven through the
   * settled pipeline, because the seam is a property of the **runs** the chart draws:
   * the outgoing run ends on the last vertex still labelled with its phase, and the
   * incoming run opens on that same vertex, which is what makes a tone change a seam
   * rather than a blank horizontal gap.
   */
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: outputChunk('x'.repeat(400)) })
  store.acceptChunk(record, attempt, { timeMs: 300, chunk: reasoningChunk('x'.repeat(400)) })
  store.acceptChunk(record, attempt, { timeMs: 600, chunk: outputChunk('x'.repeat(400)) })
  store.acceptChunk(record, attempt, { timeMs: 700, chunk: outputChunk('x'.repeat(400)) })
  store.settleAttempt(attempt, {
    settledAtMs: 700,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  const curve = store.endTurn(record, { timeMs: 800, status: 'completed' }).curve
  const trace = curve.attempts[0]
  const runs = trace.runs

  assert.deepEqual(runs.map(run => run.phase), ['output', 'reasoning', 'output'])
  for (let index = 0; index + 1 < runs.length; index += 1) {
    assert.equal(runs[index].endIndex, runs[index + 1].startIndex,
      'the two subpaths meet on one vertex rather than ending and restarting')
  }
  assert.equal(runs.reduce((sum, run) => sum + run.pointCount, 0), trace.points.length + runs.length - 1,
    'each seam vertex is counted once by each of the two runs that share it')

  /**
   * The shared vertex is **one object** in the trace's grid, drawn by both subpaths —
   * the same instant, the same measurement, one identity. A copy per run would turn one
   * measurement into two objects that merely agree.
   */
  assert.strictEqual(runs[0].points.at(-1), runs[1].points[0])
  assert.strictEqual(runs[1].points.at(-1), runs[2].points[0])
  assert.equal(runs[0].points.at(-1).localMs, 200)
  assert.equal(runs[0].points.at(-1).activePhase, 'output',
    'the seam keeps the outgoing episode\'s phase, which is what makes it a seam')
  assert.equal(runs[1].points[1].activePhase, 'reasoning',
    'and the first vertex beyond the seam is the one the new episode labels')
  assert.equal(runs[1].points[1].localMs, 300)
  assert.equal(runs[1].points[1].tps, 0,
    'that vertex is the reasoning episode\'s opening anchor')
})
