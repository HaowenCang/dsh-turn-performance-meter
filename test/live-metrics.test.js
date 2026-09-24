import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveMeter, LivePhase } from '../src/core/live-metrics.js'

function streamingMeter() {
  const meter = new LiveMeter({ windowMs: 1000 })
  meter.turnStarted({ turn: 1, timeMs: 0 })
  meter.attemptStarted({ attemptId: 'a1', step: 1, timeMs: 100 })
  return meter
}

test('live TPS is the trailing one-second window of the active attempt', () => {
  const meter = streamingMeter()
  meter.acceptSample({ timeMs: 1000, phase: 'output', weight: 10, attemptId: 'a1' })
  meter.acceptSample({ timeMs: 1500, phase: 'output', weight: 20, attemptId: 'a1' })

  assert.equal(meter.snapshot(1999).tps, 30)
  // The window is (t - 1000, t]: a sample exactly 1000 ms old no longer counts.
  assert.equal(meter.snapshot(2000).tps, 20)
  assert.equal(meter.snapshot(2500).tps, 0)
})

test('TTFT is measured once per turn and never redefined by a later call', () => {
  const meter = streamingMeter()
  meter.acceptSample({ timeMs: 400, phase: 'output', weight: 1, attemptId: 'a1' })
  assert.equal(meter.snapshot(500).ttftMs, 400)

  meter.toolStarted({ callId: 'c1', name: 'pwsh', timeMs: 600 })
  meter.toolSettled({ callId: 'c1', timeMs: 2000 })
  meter.attemptStarted({ attemptId: 'a2', step: 2, timeMs: 2100 })
  meter.acceptSample({ timeMs: 3000, phase: 'output', weight: 1, attemptId: 'a2' })

  assert.equal(meter.snapshot(3100).ttftMs, 400, 'the second call must not redefine turn TTFT')
})

test('a new attempt resets the window: a tool boundary never mixes two calls', () => {
  const meter = streamingMeter()
  meter.acceptSample({ timeMs: 500, phase: 'output', weight: 100, attemptId: 'a1' })
  assert.equal(meter.snapshot(600).tps, 100)

  meter.attemptStarted({ attemptId: 'a2', step: 1, timeMs: 700 })
  assert.equal(meter.snapshot(700).tps, 0, 'the previous attempt tokens must not bridge')

  meter.acceptSample({ timeMs: 800, phase: 'output', weight: 7, attemptId: 'a2' })
  assert.equal(meter.snapshot(900).tps, 7)
})

test('while a tool runs the meter reports no TPS at all rather than a stale or zero value', () => {
  const meter = streamingMeter()
  meter.acceptSample({ timeMs: 500, phase: 'output', weight: 100, attemptId: 'a1' })
  meter.toolStarted({ callId: 'c1', name: 'pwsh', timeMs: 600 })

  const during = meter.snapshot(700)
  assert.equal(during.phase, LivePhase.TOOL)
  assert.equal(during.tps, null, 'null, not 0 and not the frozen 100')
  assert.equal(during.runningToolCount, 1)
  assert.deepEqual(during.runningToolNames, ['pwsh'])
  assert.equal(during.toolElapsedMs, 100)
  assert.equal(during.turnElapsedMs, 700)
})

test('a late frame from a superseded attempt is rejected', () => {
  const meter = streamingMeter()
  meter.attemptStarted({ attemptId: 'a2', step: 1, timeMs: 200 })
  const accepted = meter.acceptSample({ timeMs: 300, phase: 'output', weight: 50, attemptId: 'a1' })
  assert.equal(accepted, false)
  assert.equal(meter.snapshot(300).tps, 0)
})

test('parallel tools keep counting the continuous activity episode until the last one settles', () => {
  const meter = streamingMeter()
  meter.toolStarted({ callId: 'c1', name: 'read', timeMs: 100 })
  meter.toolStarted({ callId: 'c2', name: 'grep', timeMs: 150 })
  meter.toolSettled({ callId: 'c1', timeMs: 300 })

  const mid = meter.snapshot(400)
  assert.equal(mid.phase, LivePhase.TOOL)
  assert.equal(mid.runningToolCount, 1)
  // Phase 3 contract: the live tool timer is the current continuous tool
  // activity episode (toolWall), not the oldest still-running call. c2 joined
  // c1's episode at 150 < 300, so the episode still starts at 100.
  assert.equal(mid.toolElapsedMs, 300, 'measured from the episode start, not the surviving call')

  meter.toolSettled({ callId: 'c2', timeMs: 500 })
  assert.equal(meter.snapshot(600).phase, LivePhase.PENDING)
  assert.equal(meter.toolEpisodeStartMs, null, 'the episode closed with the last running call')
})

test('a tool arriving after a quiet gap opens a new tool episode', () => {
  const meter = streamingMeter()
  meter.toolStarted({ callId: 'c1', name: 'pwsh', timeMs: 1000 })
  meter.toolSettled({ callId: 'c1', timeMs: 2000 })
  meter.toolStarted({ callId: 'c2', name: 'write', timeMs: 9000 })
  // The union of [1000,2000) and [9000,…) has two components; the current one
  // starts at 9000, so the live timer must not bridge the gap.
  assert.equal(meter.snapshot(9500).toolElapsedMs, 500)
})

test('a settled turn reports no live TPS', () => {
  const meter = streamingMeter()
  meter.acceptSample({ timeMs: 300, phase: 'output', weight: 10, attemptId: 'a1' })
  meter.turnSettled({ timeMs: 1000, status: 'completed' })
  assert.equal(meter.snapshot(1000).phase, LivePhase.SETTLED)
  assert.equal(meter.snapshot(1000).tps, null)
})

test('samples carrying a future timestamp are retained but not counted', () => {
  const meter = streamingMeter()
  meter.acceptSample({ timeMs: 5000, phase: 'output', weight: 30, attemptId: 'a1' })
  assert.equal(meter.snapshot(1000).tps, 0)
  assert.equal(meter.snapshot(5000).tps, 30)
})

test('idle meter is hidden rather than showing zeros', () => {
  const meter = new LiveMeter({ windowMs: 1000 })
  assert.deepEqual(meter.snapshot(1), { phase: LivePhase.IDLE })
})
