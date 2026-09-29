/**
 * The live meter's Phase 9.2 contract: a MiMo-style phase-cumulative average.
 *
 * For the active **phase episode** — the maximal run of consecutive same-phase
 * generated samples of the active attempt — the published rate is
 *
 *     Math.round(episodeMass * 1000 / (nowMs - episodeStartMs))
 *
 * Every case here is deterministic: the clock is the explicit `nowMs` argument
 * of `snapshot()`, sample times are plain integers, and no timer, wall clock or
 * sleep participates (`docs/METRICS_SPEC.md` §6).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LiveMeter,
  LivePhase,
  MIN_WARMUP_SAMPLES,
  FIRST_OUTPUT_GUARD_MS,
} from '../src/core/live-metrics.js'
import { MetricQuality } from '../src/core/metric-quality.js'

/** A live turn and attempt; `nowMs` is supplied explicitly at every read. */
function liveMeter({ turn = 1, turnStartMs = 0, attemptId = 'a1', attemptStartMs = 100 } = {}) {
  const meter = new LiveMeter()
  meter.turnStarted({ turn, timeMs: turnStartMs })
  meter.attemptStarted({ attemptId, step: 1, timeMs: attemptStartMs })
  return meter
}

/** Accept one generated sample of `phase` at `timeMs`. */
function push(meter, timeMs, phase, weight, attemptId = 'a1') {
  const accepted = meter.acceptSample({ timeMs, phase, weight, attemptId })
  assert.equal(accepted, true, `the sample at ${timeMs} ms must be accepted`)
}

test('a steady phase reports the cumulative average of its episode', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)
  push(meter, 1100, 'output', 10)
  push(meter, 1200, 'output', 10)

  // 30 tokens over 200 ms.
  const first = meter.snapshot(1200)
  assert.equal(first.tps, 150)
  assert.equal(first.tpsQuality, MetricQuality.ESTIMATED)
  assert.equal(first.activePhase, 'output')
  assert.equal(first.episodeElapsedMs, 200)
  assert.equal(first.episodeSampleCount, 3)
  assert.equal(first.warmupSamples, MIN_WARMUP_SAMPLES)
  assert.equal(first.fallback, false)

  // The numerator freezes while the clock advances: 30 tokens over 400 ms.
  assert.equal(meter.snapshot(1400).tps, 75)
})

test('a bursty phase accumulates across its bursts instead of resetting', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 100)
  push(meter, 1100, 'output', 100)
  push(meter, 1200, 'output', 100)
  assert.equal(meter.snapshot(1200).tps, 1500, '300 tokens over 200 ms')

  // A 1.8 s silence, then the burst resumes inside the same episode.
  push(meter, 3000, 'output', 300)
  assert.equal(meter.snapshot(3000).tps, 300, '600 tokens over 2000 ms')

  push(meter, 3100, 'output', 100)
  assert.equal(meter.snapshot(3100).tps, 333, '700 tokens over 2100 ms (700000 / 2100 = 333.33)')

  push(meter, 3200, 'output', 100)
  const last = meter.snapshot(3200)
  assert.equal(last.tps, 364, '800 tokens over 2200 ms (800000 / 2200 = 363.63)')
  assert.equal(last.episodeSampleCount, 6)
  assert.equal(last.episodeElapsedMs, 2200)
})

test('a 500 ms stall decays the rate while the numerator freezes', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)
  push(meter, 1100, 'output', 10)
  push(meter, 1200, 'output', 10)
  assert.equal(meter.snapshot(1200).tps, 150)

  // 30 tokens over 700 ms: 30000 / 700 = 42.857.
  const stalled = meter.snapshot(1700)
  assert.equal(stalled.tps, 43)
  assert.equal(stalled.episodeSampleCount, 3, 'no sample arrived during the stall')
})

test('a 1500 ms stall keeps decaying and never reaches zero', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)
  push(meter, 1100, 'output', 10)
  push(meter, 1200, 'output', 10)

  /**
   * 30 tokens, elapsed 300..1700 ms:
   *   30000/300 = 100, /500 = 60, /700 = 42.857 -> 43, /1000 = 30,
   *   /1200 = 25, /1500 = 20, /1700 = 17.647 -> 18.
   */
  const series = [1300, 1500, 1700, 2000, 2200, 2500, 2700].map(at => meter.snapshot(at).tps)
  assert.deepEqual(series, [100, 60, 43, 30, 25, 20, 18])

  for (let index = 1; index < series.length; index += 1) {
    assert.ok(series[index] < series[index - 1], `rate must strictly decrease: ${series[index - 1]} -> ${series[index]}`)
  }
  // One second after the last sample the readout is still positive: there is no
  // window to fall out of, so it can never jump to exactly zero by rule.
  assert.equal(meter.snapshot(2200).tps, 25, '30000 / (2200 - 1000) = 25')
  assert.ok(series.every(rate => rate > 0))
})

test('a phase change restarts the clock and the numerator: reasoning -> output', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)

  // The first output sample opens a fresh episode: warming, no rate yet. No
  // snapshot was taken during reasoning, so the first-output guard is not armed.
  push(meter, 1300, 'output', 5)
  const warming = meter.snapshot(1300)
  assert.equal(warming.tps, null)
  assert.equal(warming.fallback, false)
  assert.equal(warming.episodeSampleCount, 1)
  assert.equal(warming.episodeElapsedMs, 0)

  push(meter, 1400, 'output', 5)
  assert.equal(meter.snapshot(1400).tps, null, 'two samples still warm up')

  push(meter, 1500, 'output', 5)
  // 15 output tokens over 200 ms. The reasoning mass (30) and its clock are not
  // carried: 45 tokens would read 225.
  assert.equal(meter.snapshot(1500).tps, 75)
})

test('a phase change restarts the clock and the numerator: output -> reasoning', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)
  push(meter, 1100, 'output', 10)
  push(meter, 1200, 'output', 10)
  assert.equal(meter.snapshot(1200).tps, 150)

  push(meter, 1300, 'reasoning', 4)
  push(meter, 1400, 'reasoning', 4)
  push(meter, 1500, 'reasoning', 4)
  // 12 reasoning tokens over 200 ms; bridging the output mass would read 210.
  const snapshot = meter.snapshot(1500)
  assert.equal(snapshot.tps, 60)
  assert.equal(snapshot.activePhase, 'reasoning')
})

test('a new attempt is a hard boundary for the episode', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)
  push(meter, 1100, 'output', 10)
  push(meter, 1200, 'output', 10)
  assert.equal(meter.snapshot(1200).tps, 150)

  meter.attemptStarted({ attemptId: 'a2', step: 2, timeMs: 1300 })
  const boundary = meter.snapshot(1300)
  assert.equal(boundary.phase, LivePhase.PENDING)
  assert.equal(boundary.tps, null)
  assert.equal(boundary.episodeSampleCount, 0, 'the previous attempt episode is discarded')

  push(meter, 1400, 'output', 100, 'a2')
  assert.equal(meter.snapshot(1400).tps, null, 'the new attempt starts from zero')
  push(meter, 1500, 'output', 100, 'a2')
  push(meter, 1600, 'output', 100, 'a2')
  assert.equal(meter.snapshot(1600).tps, 1500, '300 tokens over 200 ms of the new attempt')

  // A late frame naming the superseded attempt is rejected, so it cannot bridge
  // the two calls either.
  assert.equal(meter.acceptSample({ timeMs: 1700, phase: 'output', weight: 100, attemptId: 'a1' }), false)
  const late = meter.snapshot(1700)
  assert.equal(late.episodeSampleCount, 3)
  assert.equal(late.tps, 1000, '300 tokens over 300 ms; the rejected frame added nothing')
})

test('while a tool runs the meter publishes no rate and carries no decay', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)
  push(meter, 1100, 'output', 10)
  push(meter, 1200, 'output', 10)
  assert.equal(meter.snapshot(1200).tps, 150)

  meter.toolStarted({ callId: 'c1', name: 'pwsh', timeMs: 1300 })
  const during = meter.snapshot(1500)
  assert.equal(during.phase, LivePhase.TOOL)
  assert.equal(during.tps, null, 'null, not the frozen 150 and not a decaying value')
  assert.equal(during.tpsQuality, MetricQuality.UNAVAILABLE)
  assert.equal(during.runningToolCount, 1)
  assert.deepEqual(during.runningToolNames, ['pwsh'])
  assert.equal(during.toolElapsedMs, 200)

  // At 2300 ms the old episode's decay would read 30000/1300 = 23; a tool wait
  // does not continue the cumulative decay.
  assert.equal(meter.snapshot(2300).tps, null)
  assert.equal(meter.snapshot(2300).toolElapsedMs, 1000)
  assert.equal(meter.snapshot(5000).tps, null)
})

test('after a tool the next attempt starts a fresh episode from zero', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)
  push(meter, 1100, 'output', 10)
  push(meter, 1200, 'output', 10)
  meter.toolStarted({ callId: 'c1', name: 'pwsh', timeMs: 1300 })

  meter.toolSettled({ callId: 'c1', timeMs: 5000 })
  const settled = meter.snapshot(5000)
  assert.equal(settled.phase, LivePhase.PENDING)
  assert.equal(settled.tps, null)
  assert.equal(settled.episodeSampleCount, 0)

  meter.attemptStarted({ attemptId: 'a2', step: 2, timeMs: 5100 })
  push(meter, 5200, 'output', 1, 'a2')
  push(meter, 5300, 'output', 1, 'a2')
  push(meter, 5400, 'output', 1, 'a2')
  // 3 tokens over 200 ms of the second attempt. The old episode's mass and its
  // clock are gone: the tool wait is charged to nothing.
  const resumed = meter.snapshot(5400)
  assert.equal(resumed.tps, 15)
  assert.equal(resumed.episodeElapsedMs, 200)
  assert.equal(resumed.episodeSampleCount, 3)
})

test('the rate is withheld until the episode holds MIN_WARMUP_SAMPLES samples', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)

  const one = meter.snapshot(1000)
  assert.equal(one.tps, null)
  assert.equal(one.tpsQuality, MetricQuality.UNAVAILABLE)
  assert.equal(one.episodeSampleCount, 1)
  assert.equal(one.episodeElapsedMs, 0)
  assert.equal(one.warmupSamples, MIN_WARMUP_SAMPLES)

  push(meter, 1100, 'output', 10)
  const two = meter.snapshot(1150)
  assert.equal(two.tps, null, 'two samples still warm up')
  assert.equal(two.episodeSampleCount, 2)
  assert.equal(two.episodeElapsedMs, 150)

  push(meter, 1200, 'output', 10)
  const three = meter.snapshot(1200)
  assert.equal(three.tps, 150, 'the third sample publishes the episode rate')
  assert.equal(three.tpsQuality, MetricQuality.ESTIMATED)
  assert.equal(three.episodeSampleCount, 3)
})

test('three samples at one instant still publish no rate', () => {
  const meter = liveMeter()
  push(meter, 1000, 'output', 10)
  push(meter, 1000, 'output', 10)
  push(meter, 1000, 'output', 10)

  const snapshot = meter.snapshot(1000)
  assert.equal(snapshot.episodeSampleCount, 3)
  assert.equal(snapshot.episodeElapsedMs, 0)
  assert.equal(snapshot.tps, null, 'a zero-elapsed quotient is never published')
})

test('a read before the episode begins yields no rate, not a negative one', () => {
  const meter = liveMeter()
  push(meter, 5000, 'output', 30)

  const before = meter.snapshot(4000)
  assert.equal(before.tps, null)
  assert.equal(before.episodeElapsedMs, 0, 'elapsed is clamped at zero')

  push(meter, 5100, 'output', 30)
  push(meter, 5200, 'output', 30)
  assert.equal(meter.snapshot(5200).tps, 450, '90 tokens over 200 ms once the clock catches up')
})

test('the first output samples reuse the last positive reasoning rate', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  assert.equal(meter.snapshot(1200).tps, 150, 'the reasoning rate is published and remembered')

  push(meter, 1300, 'output', 1)
  const guarded = meter.snapshot(1300)
  assert.equal(guarded.tps, 150, 'the reasoning rate stands in for the warming output episode')
  assert.equal(guarded.fallback, true)
  assert.equal(guarded.activePhase, 'output')
  assert.equal(guarded.episodeSampleCount, 1)

  const later = meter.snapshot(1800)
  assert.equal(later.tps, 150, 'still inside the 1000 ms guard, still no output rate of its own')
  assert.equal(later.fallback, true)
})

test('the guard expires after FIRST_OUTPUT_GUARD_MS', () => {
  assert.equal(FIRST_OUTPUT_GUARD_MS, 1000)

  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  meter.snapshot(1200)

  push(meter, 1300, 'output', 1)
  // Exactly 1000 ms after the output episode started the guard still applies.
  assert.equal(meter.snapshot(2300).tps, 150)
  assert.equal(meter.snapshot(2300).fallback, true)

  const expired = meter.snapshot(2301)
  assert.equal(expired.tps, null, 'one millisecond later the fallback is gone')
  assert.equal(expired.fallback, false)
  assert.equal(expired.tpsQuality, MetricQuality.UNAVAILABLE)
})

test('the guard never overwrites a valid positive output rate', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  meter.snapshot(1200)

  push(meter, 1300, 'output', 5)
  push(meter, 1400, 'output', 5)
  assert.equal(meter.snapshot(1400).tps, 150, 'two output samples cannot publish, so the guard applies')
  assert.equal(meter.snapshot(1400).fallback, true)

  push(meter, 1500, 'output', 5)
  const own = meter.snapshot(1500)
  assert.equal(own.tps, 75, 'the output episode publishes its own 15 tokens over 200 ms')
  assert.equal(own.fallback, false)
})

test('the guard does not survive a tool wait', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  meter.snapshot(1200)

  meter.toolStarted({ callId: 'c1', name: 'pwsh', timeMs: 1300 })
  assert.equal(meter.lastPositiveReasoningRate, null, 'the tool start clears the guard')

  meter.toolSettled({ callId: 'c1', timeMs: 1400 })
  meter.attemptStarted({ attemptId: 'a2', step: 2, timeMs: 1500 })
  push(meter, 1600, 'output', 1, 'a2')
  const snapshot = meter.snapshot(1600)
  assert.equal(snapshot.tps, null)
  assert.equal(snapshot.fallback, false)
})

test('the guard does not survive an attempt boundary', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  meter.snapshot(1200)

  meter.attemptStarted({ attemptId: 'a2', step: 2, timeMs: 1300 })
  assert.equal(meter.lastPositiveReasoningRate, null, 'the attempt start clears the guard')

  push(meter, 1400, 'output', 1, 'a2')
  const snapshot = meter.snapshot(1400)
  assert.equal(snapshot.tps, null)
  assert.equal(snapshot.fallback, false)
})

test('the guard does not survive a turn boundary', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  meter.snapshot(1200)

  meter.turnSettled({ timeMs: 1300, status: 'completed' })
  assert.equal(meter.lastPositiveReasoningRate, null, 'the turn settlement clears the guard')
  assert.equal(meter.snapshot(1300).phase, LivePhase.SETTLED)
  assert.equal(meter.snapshot(1300).tps, null)

  meter.turnStarted({ turn: 2, timeMs: 2000 })
  meter.attemptStarted({ attemptId: 'b1', step: 1, timeMs: 2100 })
  push(meter, 2200, 'output', 1, 'b1')
  const snapshot = meter.snapshot(2200)
  assert.equal(snapshot.tps, null)
  assert.equal(snapshot.fallback, false)
})

test('an in-stream usage chunk supplies the episode numerator once a baseline exists', () => {
  const meter = liveMeter()
  // Episode one of each phase, before any usage chunk is known.
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  push(meter, 1300, 'output', 10)
  push(meter, 1400, 'output', 10)
  push(meter, 1500, 'output', 10)

  meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: 100, reasoningTokens: 40 } })

  // The second reasoning episode opens while the counters are known and the
  // provider split agrees with the phases the stream has shown, so a baseline is
  // taken: the episode's mass will be `counter - 40`.
  push(meter, 2000, 'reasoning', 7)
  assert.deepEqual(meter.episodeUsageBaseline, { phase: 'reasoning', counter: 40 })

  push(meter, 2100, 'reasoning', 7)
  push(meter, 2200, 'reasoning', 7)

  // The counter grows to 55; the episode delta is 55 - 40 = 15 over 200 ms.
  // The shape mass (21 tokens) would read 105 instead.
  meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: 130, reasoningTokens: 55 } })
  assert.equal(meter.evidence().splitUsable, true)
  assert.equal(meter.snapshot(2200).tps, 75)
})

test('without an in-stream usage chunk the numerator stays the shape mass', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)

  assert.equal(meter.episodeUsageBaseline, null)
  assert.equal(meter.snapshot(1200).tps, 150, '30 shape tokens over 200 ms')
})

test('an in-stream usage chunk must carry a finite outputTokens to be recorded', () => {
  const meter = liveMeter()
  assert.equal(meter.observeUsage({ attemptId: 'a1', usage: { reasoningTokens: 5 } }), false)
  assert.equal(meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: Number.NaN } }), false)
  assert.equal(meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: Number.POSITIVE_INFINITY } }), false)
  assert.equal(meter.observeUsage({ attemptId: 'a1', usage: null }), false)
  assert.equal(meter.observeUsage({ attemptId: 'other', usage: { outputTokens: 10 } }), false)
  assert.equal(meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: 10, reasoningTokens: 0 } }), true)
})

test('a usage chunk arriving inside an episode never retroactively explains it', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  push(meter, 1300, 'output', 10)
  push(meter, 1400, 'output', 10)
  push(meter, 1500, 'output', 10)

  // The chunk arrives while the output episode is already running.
  meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: 100, reasoningTokens: 40 } })
  push(meter, 1600, 'output', 10)

  const snapshot = meter.snapshot(1600)
  assert.equal(meter.episodeUsageBaseline, null, 'the episode began before the counter was known')
  assert.equal(meter.evidence().splitUsable, true, 'the split itself is usable...')
  assert.equal(snapshot.tps, 133, '...but this episode keeps its shape mass: 40 tokens over 300 ms')
})

test('a split contradicted by the stream falls back to shape: reasoningTokens 0 beside reasoning deltas', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)

  meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: 100, reasoningTokens: 0 } })
  push(meter, 1300, 'reasoning', 10)
  push(meter, 1400, 'reasoning', 10)

  const evidence = meter.evidence()
  assert.equal(evidence.splitUsable, false)
  assert.ok(evidence.contradictions.some(entry => entry.kind === 'reasoning-zero-with-deltas'))
  // Shape: 50 tokens over 400 ms. A zeroed reasoning counter would claim 0.
  assert.equal(meter.snapshot(1400).tps, 125)
})

test('a split contradicted by the stream falls back to shape: reasoningTokens > outputTokens', () => {
  const meter = liveMeter()
  meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: 30, reasoningTokens: 40 } })

  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  push(meter, 1300, 'output', 10)
  push(meter, 1400, 'output', 10)
  push(meter, 1500, 'output', 10)

  const evidence = meter.evidence()
  assert.equal(evidence.splitUsable, false)
  assert.ok(evidence.contradictions.some(entry => entry.kind === 'impossible-split'))
  assert.equal(meter.snapshot(1500).tps, 150, 'the output episode keeps its shape mass')

  // A later episode may not anchor to the impossible counters either.
  push(meter, 2000, 'reasoning', 5)
  push(meter, 2100, 'reasoning', 5)
  push(meter, 2200, 'reasoning', 5)
  assert.equal(meter.episodeUsageBaseline, null)
  assert.equal(meter.snapshot(2200).tps, 75, '15 shape tokens over 200 ms')
})

test('a baseline is abandoned when the split is later contradicted', () => {
  const meter = liveMeter()
  push(meter, 1000, 'reasoning', 10)
  push(meter, 1100, 'reasoning', 10)
  push(meter, 1200, 'reasoning', 10)
  push(meter, 1300, 'output', 10)
  push(meter, 1400, 'output', 10)
  push(meter, 1500, 'output', 10)
  meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: 100, reasoningTokens: 40 } })

  push(meter, 2000, 'reasoning', 5)
  push(meter, 2100, 'reasoning', 5)
  push(meter, 2200, 'reasoning', 5)
  assert.deepEqual(meter.episodeUsageBaseline, { phase: 'reasoning', counter: 40 })

  // `outputTokens - reasoningTokens` becomes zero while output deltas exist:
  // the split is contradicted, so the baseline may not be used.
  meter.observeUsage({ attemptId: 'a1', usage: { outputTokens: 44, reasoningTokens: 44 } })
  const evidence = meter.evidence()
  assert.equal(evidence.splitUsable, false)
  assert.ok(evidence.contradictions.some(entry => entry.kind === 'output-zero-with-deltas'))
  // Shape: 15 tokens over 200 ms. The stale counter delta would read 20.
  assert.equal(meter.snapshot(2200).tps, 75)
})

test('TTFT is measured once per turn and never redefined by a later call', () => {
  const meter = liveMeter()
  push(meter, 400, 'output', 1)
  assert.equal(meter.snapshot(500).ttftMs, 400)

  meter.toolStarted({ callId: 'c1', name: 'pwsh', timeMs: 600 })
  meter.toolSettled({ callId: 'c1', timeMs: 2000 })
  meter.attemptStarted({ attemptId: 'a2', step: 2, timeMs: 2100 })
  push(meter, 3000, 'output', 1, 'a2')

  assert.equal(meter.snapshot(3100).ttftMs, 400, 'the second call must not redefine turn TTFT')
})

test('an unobserved turn start reports elapsed and TTFT as unknown, never as zero', () => {
  /**
   * The adopted mid-turn boundary (`client-feed.adoptTurn`) opens the turn with
   * `timeMs: null`. `0 ms` would be a fabricated measurement for a turn that may
   * have been running for minutes, so both elapsed and TTFT are `null` while the
   * episode rate itself stays measurable from the deltas.
   */
  const meter = liveMeter({ turn: 3, turnStartMs: null })
  push(meter, 5100, 'output', 40)
  push(meter, 5200, 'output', 40)
  push(meter, 5300, 'output', 40)

  const snapshot = meter.snapshot(5300)
  assert.equal(snapshot.turnElapsedMs, null, 'elapsed is unknown')
  assert.equal(snapshot.ttftMs, null, 'TTFT is unknown')
  assert.equal(snapshot.tps, 600, '120 tokens over 200 ms of the episode')
})

test('parallel tools keep counting the continuous activity episode until the last one settles', () => {
  const meter = liveMeter()
  meter.toolStarted({ callId: 'c1', name: 'read', timeMs: 100 })
  meter.toolStarted({ callId: 'c2', name: 'grep', timeMs: 150 })
  meter.toolSettled({ callId: 'c1', timeMs: 300 })

  const mid = meter.snapshot(400)
  assert.equal(mid.phase, LivePhase.TOOL)
  assert.equal(mid.runningToolCount, 1)
  // The live tool timer is the current continuous tool activity episode, not the
  // oldest still-running call: c2 joined c1's episode at 150 < 300, so the
  // episode still starts at 100.
  assert.equal(mid.toolElapsedMs, 300, 'measured from the episode start, not the surviving call')

  meter.toolSettled({ callId: 'c2', timeMs: 500 })
  assert.equal(meter.snapshot(600).phase, LivePhase.PENDING)
  assert.equal(meter.toolEpisodeStartMs, null, 'the episode closed with the last running call')
})

test('a tool arriving after a quiet gap opens a new tool episode', () => {
  const meter = liveMeter()
  meter.toolStarted({ callId: 'c1', name: 'pwsh', timeMs: 1000 })
  meter.toolSettled({ callId: 'c1', timeMs: 2000 })
  meter.toolStarted({ callId: 'c2', name: 'write', timeMs: 9000 })
  // The union of [1000,2000) and [9000,...) has two components; the current one
  // starts at 9000, so the live timer must not bridge the gap.
  assert.equal(meter.snapshot(9500).toolElapsedMs, 500)
})

test('a settled turn reports no live TPS', () => {
  const meter = liveMeter()
  push(meter, 300, 'output', 10)
  meter.turnSettled({ timeMs: 1000, status: 'completed' })

  const snapshot = meter.snapshot(1000)
  assert.equal(snapshot.phase, LivePhase.SETTLED)
  assert.equal(snapshot.tps, null)
  assert.equal(snapshot.tpsQuality, MetricQuality.UNAVAILABLE)
})

test('an idle meter is hidden rather than showing zeros', () => {
  const meter = new LiveMeter()
  assert.deepEqual(meter.snapshot(1), { phase: LivePhase.IDLE })
})
