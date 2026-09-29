/**
 * The Phase 9.2 phase-duration policy, one attempt at a time.
 *
 * An attempt is cut into **contiguous phase episodes**. A non-terminal episode
 * ends where the next one begins; the terminal episode ends at the attempt's own
 * settlement instant. Its duration is `episodeEnd - episodeStart` — so a stall
 * inside an episode and the terminal settlement tail are charged, while TTFT,
 * tool waits and inter-attempt waits are not even inputs (`docs/METRICS_SPEC.md`
 * §7 "Phase-duration policy").
 *
 * Durations are attempt-local integers; nothing here reads a clock.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { attributePhaseDurations } from '../src/core/phase-duration.js'
import { compressAttempts } from '../src/core/time-axis.js'

test('a reasoning episode ends where the next phase begins', () => {
  const d = attributePhaseDurations([
    { timeMs: 0, phase: 'reasoning' },
    { timeMs: 1000, phase: 'reasoning' },
    { timeMs: 2000, phase: 'output' },
    { timeMs: 3000, phase: 'output' },
  ], { settledAtMs: 4000 })

  assert.equal(d.reasoningMs, 2000, '0 -> 2000, where the output episode opens')
  assert.equal(d.outputMs, 2000, '2000 -> 4000, the terminal settlement bound')
  assert.equal(d.reasoningEpisodeCount, 1)
  assert.equal(d.reasoningMeasuredEpisodes, 1)
  assert.equal(d.outputEpisodeCount, 1)
  assert.equal(d.outputMeasuredEpisodes, 1)
  assert.deepEqual(
    d.episodes.map(episode => [episode.phase, episode.startMs, episode.endMs, episode.durationMs]),
    [['reasoning', 0, 2000, 2000], ['output', 2000, 4000, 2000]],
  )
})

test('a silence across a phase boundary is charged to the earlier episode', () => {
  const d = attributePhaseDurations([
    { timeMs: 0, phase: 'reasoning' },
    { timeMs: 1000, phase: 'reasoning' },
    // The next generated sample is 2 s later and of the other phase.
    { timeMs: 3000, phase: 'output' },
  ], { settledAtMs: 4000 })

  // The episode ends where its successor *begins*, not at its own last sample:
  // the 2000 ms delivery silence belongs to the reasoning episode.
  assert.equal(d.reasoningMs, 3000)
  assert.equal(d.outputMs, 1000)
})

test('a reasoning-only attempt settles at its own tail', () => {
  const d = attributePhaseDurations([
    { timeMs: 0, phase: 'reasoning' },
    { timeMs: 1000, phase: 'reasoning' },
  ], { settledAtMs: 1500 })

  assert.equal(d.reasoningMs, 1500)
  assert.equal(d.outputMs, null, 'the output phase has no episode at all')
  assert.equal(d.outputEpisodeCount, 0)
  assert.equal(d.outputMeasuredEpisodes, 0)
})

test('an output-only attempt measures its terminal episode', () => {
  const d = attributePhaseDurations([
    { timeMs: 0, phase: 'output' },
    { timeMs: 2000, phase: 'output' },
  ], { settledAtMs: 2500 })

  assert.equal(d.outputMs, 2500)
  assert.equal(d.outputEpisodeCount, 1)
  assert.equal(d.outputMeasuredEpisodes, 1)
  assert.equal(d.reasoningMs, null)
  assert.equal(d.reasoningEpisodeCount, 0)
})

test('reasoning -> output -> reasoning produces three disjoint episodes', () => {
  const d = attributePhaseDurations([
    { timeMs: 0, phase: 'reasoning' },
    { timeMs: 100, phase: 'reasoning' },
    { timeMs: 100, phase: 'output' },
    { timeMs: 250, phase: 'output' },
    { timeMs: 250, phase: 'reasoning' },
    { timeMs: 400, phase: 'reasoning' },
  ], { settledAtMs: 500 })

  assert.equal(d.reasoningMs, 350, '100 ms (first episode) + 250 ms (terminal episode)')
  assert.equal(d.outputMs, 150)
  assert.equal(d.reasoningEpisodeCount, 2)
  assert.equal(d.reasoningMeasuredEpisodes, 2)
  assert.equal(d.outputEpisodeCount, 1)
  assert.equal(d.outputMeasuredEpisodes, 1)
  assert.deepEqual(
    d.episodes.map(episode => [episode.phase, episode.startMs, episode.endMs, episode.durationMs]),
    [['reasoning', 0, 100, 100], ['output', 100, 250, 150], ['reasoning', 250, 500, 250]],
  )
  // The episodes are disjoint and ordered, so the two denominators never
  // double-count an interval: together they cover first sample -> settlement once.
  assert.equal(d.reasoningMs + d.outputMs, 500)
})

test('a single generated sample is measurable only against its settlement', () => {
  const measured = attributePhaseDurations([{ timeMs: 42, phase: 'output' }], { settledAtMs: 100 })
  assert.equal(measured.outputMs, 58, '100 - 42')
  assert.equal(measured.outputMeasuredEpisodes, 1)
  assert.equal(measured.spanMs, 0, 'one sample spans no interval by itself')

  const unmeasured = attributePhaseDurations([{ timeMs: 42, phase: 'output' }])
  assert.equal(unmeasured.outputMs, null, 'no settlement, no measurable duration')
  assert.equal(unmeasured.outputEpisodeCount, 1)
  assert.equal(unmeasured.outputMeasuredEpisodes, 0)

  // A settlement that is not *later* than the episode start is not measurable
  // either — `null`, never a zero or negative duration.
  assert.equal(attributePhaseDurations([{ timeMs: 42, phase: 'output' }], { settledAtMs: 42 }).outputMs, null)
  assert.equal(attributePhaseDurations([{ timeMs: 42, phase: 'output' }], { settledAtMs: 40 }).outputMs, null)
})

test('samples at one instant book no zero-length episode', () => {
  const d = attributePhaseDurations([
    { timeMs: 100, phase: 'reasoning' },
    { timeMs: 100, phase: 'reasoning' },
    { timeMs: 100, phase: 'output' },
    { timeMs: 400, phase: 'output' },
  ], { settledAtMs: 500 })

  assert.equal(d.reasoningMs, null, 'the reasoning episode is zero-length: no positive interval exists')
  assert.equal(d.reasoningEpisodeCount, 1)
  assert.equal(d.reasoningMeasuredEpisodes, 0, 'the episode is reported, but not as measured')
  assert.equal(d.outputMs, 400)

  // The same rule for a terminal episode: settlement == start is not a duration.
  assert.equal(attributePhaseDurations([
    { timeMs: 100, phase: 'output' },
    { timeMs: 100, phase: 'output' },
  ], { settledAtMs: 100 }).outputMs, null)
  assert.equal(attributePhaseDurations([
    { timeMs: 100, phase: 'output' },
    { timeMs: 100, phase: 'output' },
  ], { settledAtMs: 150 }).outputMs, 50)
})

test('a large stall inside one episode is charged to it', () => {
  const d = attributePhaseDurations([
    { timeMs: 0, phase: 'reasoning' },
    { timeMs: 5000, phase: 'reasoning' },
    { timeMs: 6000, phase: 'output' },
  ], { settledAtMs: 7000 })

  // 0 -> 6000, where the output episode opens: the 5000 ms silence is model
  // delivery time and stays in the denominator.
  assert.equal(d.reasoningMs, 6000)
  assert.equal(d.outputMs, 1000)
})

test('the terminal settlement tail is charged; without a settlement it is unmeasurable', () => {
  const samples = [
    { timeMs: 0, phase: 'reasoning' },
    { timeMs: 1000, phase: 'reasoning' },
  ]

  assert.equal(attributePhaseDurations(samples, { settledAtMs: 3000 }).reasoningMs, 3000,
    'the 2000 ms generated-delta -> settlement tail belongs to the terminal episode')
  assert.equal(attributePhaseDurations(samples, { settledAtMs: 1000 }).reasoningMs, 1000,
    'a settlement at the last delta adds no tail')
  assert.equal(attributePhaseDurations(samples).reasoningMs, null,
    'without a settlement the terminal episode has no measurable end')
  assert.equal(attributePhaseDurations(samples, { settledAtMs: Number.NaN }).reasoningMs, null,
    'a non-finite settlement is treated as absent')
})

test('two attempts separated by a long tool wait charge only within-attempt time', () => {
  /**
   * One turn: attempt 1 streams for 2 s and settles 0.5 s later; a tool then runs
   * for 87 s; after a 10 s inter-attempt wait attempt 2 streams for 4 s and
   * settles 0.5 s later. The function is only ever handed one attempt's own
   * samples and that attempt's own settlement instant.
   */
  const attempt1 = [
    { timeMs: 0, phase: 'reasoning' },
    { timeMs: 2000, phase: 'reasoning' },
  ]
  const attempt2 = [
    { timeMs: 0, phase: 'output' },
    { timeMs: 4000, phase: 'output' },
  ]

  const first = attributePhaseDurations(attempt1, { settledAtMs: 2500 })
  const second = attributePhaseDurations(attempt2, { settledAtMs: 4500 })

  assert.equal(first.reasoningMs, 2500, '2000 ms of samples + the 500 ms within-attempt tail')
  assert.equal(second.outputMs, 4500, '4000 ms of samples + the 500 ms within-attempt tail')
  assert.deepEqual(
    first.episodes.map(episode => [episode.startMs, episode.lastSampleMs, episode.endMs, episode.durationMs]),
    [[0, 2000, 2500, 2500]],
  )

  // The tool wait (87 s) and the inter-attempt wait are never inputs: if either
  // entered a denominator the combined sum could not be 7 s, and the attempt's
  // own settlement tail (500 ms each) is what the terminal episodes end on.
  assert.equal(first.reasoningMs + second.outputMs, 7000)
  assert.ok(first.reasoningMs + second.outputMs < 87_000, 'the tool wait alone exceeds the whole denominator')
  assert.notEqual(first.reasoningMs + second.outputMs, 104_500, 'the turn wall span is not a denominator')

  // Without a settlement each terminal episode is unmeasurable — the figures
  // above come from the attempt's own settlement, never from the surrounding
  // tool or inter-attempt time.
  assert.equal(attributePhaseDurations(attempt1).reasoningMs, null)
  assert.equal(attributePhaseDurations(attempt2).outputMs, null)
})

test('unordered input is sorted, and a settlement cannot shrink an episode below its last sample', () => {
  const d = attributePhaseDurations([
    { timeMs: 300, phase: 'output' },
    { timeMs: 100, phase: 'output' },
    { timeMs: 200, phase: 'output' },
  ], { settledAtMs: 400 })

  assert.equal(d.outputMs, 300)
  assert.equal(d.episodes[0].startMs, 100, 'the earliest timestamp is the episode start')
  assert.equal(d.episodes[0].lastSampleMs, 300)

  /**
   * A settlement stamped earlier than a delta that followed it is clock skew.
   * The terminal episode ends at the **later** of its last sample and the
   * settlement, so the duration can never shrink below the evidence the episode
   * contains — the same refusal `compressAttempts` applies to the curve width.
   */
  const samples = [
    { timeMs: 100, phase: 'output' },
    { timeMs: 200, phase: 'output' },
  ]
  const beforeStart = attributePhaseDurations(samples, { settledAtMs: 50 })
  assert.equal(beforeStart.episodes[0].endMs, 200)
  assert.equal(beforeStart.outputMs, 100)

  const midEpisode = attributePhaseDurations(samples, { settledAtMs: 150 })
  assert.equal(midEpisode.episodes[0].endMs, 200)
  assert.equal(midEpisode.outputMs, 100)

  // The curve refuses the same skew, so both halves of the project agree on the
  // attempt's width for the same input.
  const compressed = compressAttempts([{ attemptId: 'skewed', samples, settledAtMs: 50 }])
  assert.equal(compressed.durationMs, 100)
})

test('an attempt with no samples reports nothing measurable', () => {
  const d = attributePhaseDurations([])
  assert.equal(d.reasoningMs, null)
  assert.equal(d.outputMs, null)
  assert.equal(d.reasoningEpisodeCount, 0)
  assert.equal(d.outputEpisodeCount, 0)
  assert.equal(d.spanMs, 0)
  assert.equal(d.sampleCount, 0)
  assert.deepEqual(d.episodes, [])
})
