/**
 * Episode openings under the Phase 9.2 phase-cumulative estimator, as corrected
 * by Phase 9.4.
 *
 * ## What this file froze, and what it freezes now
 *
 * The trailing-window estimator is long gone, and so is the attempt-global vertex
 * grid that replaced it. The estimator is the cumulative average of the current
 * phase episode —
 *
 *     tps(t) = Math.round(mass(samples of the episode at or before t) * 1000
 *                         / (t - firstSampleOfThatEpisode))
 *
 * — where an episode is the maximal run of consecutive same-phase samples, and it
 * is sampled on **its own** 100 ms ladder. Five consequences are frozen here:
 *
 *   1. **an episode's opening vertex carries no rate.** Its elapsed time is
 *      exactly zero, which is not a measurement: the vertex publishes
 *      `tps: null` with `rateUnavailableReason: 'opening-anchor'`, never `0`.
 *      "Not measured yet" and "measured zero" are different facts, and the chart
 *      draws the first as a gap;
 *   2. **the following vertices are the full cumulative average over the episode
 *      so far** — every sample of the episode at or before the instant, over the
 *      whole time since the episode opened, never a one-step rate — once the
 *      shared publication policy admits them (three samples, 100 ms);
 *   3. **a second episode of the same phase resets its own clock and its own
 *      mass.** A phase that falls silent and returns is a new episode, not a
 *      continuation: it owns neither the earlier episode's elapsed time nor its
 *      tokens;
 *   4. **an episode that opens off the attempt's grid is sampled from its own
 *      origin.** Its first vertex is its own opening instant, and its first
 *      publishable rate therefore has a full 100 ms denominator — the 50 ms
 *      remainder the old grid produced at 300 ms no longer exists as a vertex;
 *   5. **a phase transition is a shared seam, not a gap.** The two runs that meet
 *      at a transition share one vertex — `runs[i].endIndex === runs[i+1].startIndex`,
 *      one index in the attempt's own grid, drawn by both subpaths.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { attemptTrace, cumulativePhaseTpsSeries } from '../src/core/curve.js'
import { RateUnavailable } from '../src/core/rate-publication.js'

const outputChunk = text => ({ type: 'text-delta', index: 0, text })
const reasoningChunk = text => ({ type: 'reasoning-delta', index: 0, text })

/** `[localMs, tps]` for every vertex, so `null` is visible as the withheld rate it is. */
const rates = points => points.map(point => [point.localMs, point.tps])

// ---------------------------------------------------------------------------
// 1. The opening vertex
// ---------------------------------------------------------------------------

test('an episode opens without a rate: the anchor is unavailable, not a measured zero', () => {
  /**
   * Three deltas at 0, 50 and 80 ms, drawn across a 300 ms tail. The opening
   * vertex describes 1 sample over 0 ms: there is no quotient, so it publishes
   * `null` and says why. The vertex at 100 ms is the episode's full cumulative
   * average — all 800 tokens over the whole 100 ms since the episode opened.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 400 },
    { activeTimeMs: 50, phase: 'output', tokens: 200 },
    { activeTimeMs: 80, phase: 'output', tokens: 200 },
  ], { durationMs: 300, sampleEndMs: 300 })

  assert.deepEqual(rates(points), [
    [0, null], [100, 8000], [200, 4000], [300, 2667],
  ])
  assert.equal(points[0].localMs, 0, 'the opening vertex sits on the episode\'s first sample')
  assert.equal(points[0].publishable, false)
  assert.equal(points[0].rateUnavailableReason, RateUnavailable.OPENING_ANCHOR)
  assert.equal(points[0].activePhase, 'output', 'and it is labelled with that episode\'s phase')

  /**
   * The next vertex is the full cumulative average over the episode so far:
   * `mass(800) * 1000 / (100 - 0) = 8000`. An elapsed time of anything but zero at
   * the opening vertex would have published a rate there; the definition publishes none.
   */
  assert.equal(points[1].tps, Math.round(800 * 1000 / (100 - 0)))
  assert.equal(points[1].tps, 8000)
  assert.equal(points[1].episodeSampleCount, 3)
  assert.equal(points[1].publishable, true)
})

test('the following vertex is the full cumulative average over the episode so far', () => {
  /**
   * Three deltas — 100 tokens at 0, 50 at 50 ms, 50 at 80 ms — and a settlement
   * tail to 200 ms. The vertex at 100 ms carries all 200 tokens over the whole
   * 100 ms since the episode opened, and the vertex at 200 ms carries the same
   * mass over the episode's own 200 ms: the cumulative average grows by
   * accumulation, not by forgetting.
   */
  const trace = attemptTrace({ attemptId: 'a', startMs: 0, endMs: 200 }, [
    { attemptId: 'a', attemptTimeMs: 0, activeTimeMs: 0, phase: 'output', tokens: 100 },
    { attemptId: 'a', attemptTimeMs: 50, activeTimeMs: 50, phase: 'output', tokens: 50 },
    { attemptId: 'a', attemptTimeMs: 80, activeTimeMs: 80, phase: 'output', tokens: 50 },
  ], { sampleEveryMs: 100 })

  assert.deepEqual(rates(trace.points), [[0, null], [100, 2000], [200, 1000]])
  assert.equal(trace.points[1].tps, Math.round((100 + 50 + 50) * 1000 / (100 - 0)))
  assert.equal(trace.points[2].tps, Math.round(200 * 1000 / (200 - 0)))
  assert.deepEqual(trace.points.map(point => point.activePhase), ['output', 'output', 'output'])
})

// ---------------------------------------------------------------------------
// 2. A second episode of the same phase
// ---------------------------------------------------------------------------

test('a second episode of the same phase after an intervening phase resets its own clock and mass', () => {
  /**
   * Output, reasoning, output again — the third episode is the same **phase** as
   * the first, but not the same episode. Each episode owns three deltas of 100
   * tokens, so each publishes `300 * 1000 / 100 = 3000` at its own 100 ms vertex.
   * Carrying either the earlier output episode's mass (which would give more) or
   * the attempt's own clock (which would give `300 * 1000 / 700 ≈ 429`) is refused
   * by the definition.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'output', tokens: 100 },
    { activeTimeMs: 50, phase: 'output', tokens: 100 },
    { activeTimeMs: 100, phase: 'output', tokens: 100 },
    { activeTimeMs: 300, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 350, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 400, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 600, phase: 'output', tokens: 100 },
    { activeTimeMs: 650, phase: 'output', tokens: 100 },
    { activeTimeMs: 700, phase: 'output', tokens: 100 },
  ], { durationMs: 700, sampleEndMs: 700 })

  assert.deepEqual(rates(points), [
    [0, null], [100, 3000], [200, 1500],
    [300, null], [400, 3000], [500, 1500],
    [600, null], [700, 3000],
  ])
  assert.deepEqual(points.map(point => point.activePhase),
    ['output', 'output', 'output', 'reasoning', 'reasoning', 'reasoning', 'output', 'output'])

  assert.equal(points[6].tps, null, 'the second output episode opens on its own zero-elapsed anchor')
  assert.equal(points[6].rateUnavailableReason, RateUnavailable.OPENING_ANCHOR)
  assert.equal(points[7].tps, Math.round(300 * 1000 / (700 - 600)))
  assert.equal(points[7].tps, 3000)
})

test('an episode opening off the attempt grid is sampled on its own ladder, on its own clock', () => {
  /**
   * The reasoning episode opens at 0, the output episode at 250 ms — which is not
   * a multiple of the 100 ms cadence. Under the old attempt-global grid the next
   * vertex was 300 ms, so the output episode's first rate was `100 tokens / 50 ms`
   * — a spike assembled entirely from the remainder of a ladder step, and the
   * turn's `peakTps` on the v0.1.2 baseline.
   *
   * The episode is now sampled from its own origin, so no vertex of it exists
   * between 250 ms and 350 ms: the 50 ms denominator is not withheld, it does not
   * exist. Its first publishable rate has elapsed exactly 100 ms.
   */
  const points = cumulativePhaseTpsSeries([
    { activeTimeMs: 0, phase: 'reasoning', tokens: 100 },
    { activeTimeMs: 250, phase: 'output', tokens: 100 },
    { activeTimeMs: 300, phase: 'output', tokens: 100 },
    { activeTimeMs: 350, phase: 'output', tokens: 100 },
  ], { durationMs: 400, sampleEndMs: 400 })

  assert.deepEqual(points.map(point => point.localMs), [0, 100, 200, 250, 350, 400],
    'the output episode contributes 250, 350, … and never a vertex one grid step after 250')
  assert.equal(points.find(point => point.localMs === 300), undefined,
    'the 50 ms denominator is absent from the grid, not merely unpublished')

  const published = points.filter(point => point.publishable)
  assert.deepEqual(published.map(point => [point.localMs, point.episodeElapsedMs, point.tps]), [
    [350, 100, 3000],
    [400, 150, 2000],
  ])
  for (const point of points) {
    if (point.publishable) continue
    assert.equal(point.tps, null, 'and every withheld vertex says "no rate" rather than "zero"')
  }
})

// ---------------------------------------------------------------------------
// 3. The transition seam
// ---------------------------------------------------------------------------

test('a phase transition seam is shared by the two runs: runs[i].endIndex === runs[i+1].startIndex', () => {
  /**
   * One attempt with three episodes — output, reasoning, output — driven through
   * the settled pipeline, because the seam is a property of the **runs** the chart
   * draws: the outgoing run ends on the last vertex still labelled with its phase,
   * and the incoming run opens on that same vertex, which is what makes a tone
   * change a seam rather than a blank horizontal gap.
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
  assert.equal(runs[1].points[1].publishable, false,
    'that vertex is the reasoning episode\'s opening anchor: no elapsed time, no rate')
  assert.equal(runs[1].points[1].rateUnavailableReason, RateUnavailable.OPENING_ANCHOR)
  assert.equal(runs[1].points[1].tps, null)
  assert.equal(trace.points.every(point => point.tps === null), true,
    'and no episode here reaches the gates: one or two deltas are not a rate')
})
