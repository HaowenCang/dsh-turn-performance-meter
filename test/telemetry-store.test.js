import test from 'node:test'
import assert from 'node:assert/strict'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { MetricQuality } from '../src/core/metric-quality.js'

function chunk(type, text) {
  if (type === 'reasoning') return { type: 'reasoning-delta', index: 0, text }
  if (type === 'tool') return { type: 'tool-call-delta', index: 1, id: 'call_1', argumentsDelta: text }
  return { type: 'text-delta', index: 0, text }
}

/** Drive one full multi-call turn: A -> tool -> B -> tool -> C. */
function driveMultiCallTurn(store, sessionId = 's1') {
  const record = store.beginTurn({ sessionId, turn: 1, timeMs: 0 })

  const a = store.beginAttempt(record, { attemptId: 'a1', step: 1, startedAtMs: 100 })
  store.acceptChunk(record, a, { timeMs: 1000, chunk: chunk('reasoning', 'think') })
  store.acceptChunk(record, a, { timeMs: 2000, chunk: chunk('reasoning', 'more') })
  store.acceptChunk(record, a, { timeMs: 2000, chunk: chunk('tool', '{"cmd":"ls"}') })
  store.acceptChunk(record, a, { timeMs: 3000, chunk: chunk('tool', '"}"') })
  store.settleAttempt(a, {
    settledAtMs: 3500,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 100, reasoningTokens: 40 },
  })

  store.toolStarted(record, { callId: 'c1', name: 'pwsh', timeMs: 3600 })
  store.toolSettled(record, { callId: 'c1', timeMs: 66_000, status: 'ok' })

  const b = store.beginAttempt(record, { attemptId: 'b1', step: 2, startedAtMs: 66_500 })
  store.acceptChunk(record, b, { timeMs: 67_000, chunk: chunk('reasoning', 'plan the write') })
  store.acceptChunk(record, b, { timeMs: 70_000, chunk: chunk('reasoning', 'confirm the path') })
  store.acceptChunk(record, b, { timeMs: 70_000, chunk: chunk('output', 'writing the file ') })
  store.acceptChunk(record, b, { timeMs: 73_000, chunk: chunk('tool', '{"file_path":"a.js"}') })
  store.settleAttempt(b, {
    settledAtMs: 73_500,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 900, reasoningTokens: 360 },
  })

  store.toolStarted(record, { callId: 'c2', name: 'write', timeMs: 73_600 })
  store.toolSettled(record, { callId: 'c2', timeMs: 93_600, status: 'ok' })

  const c = store.beginAttempt(record, { attemptId: 'c1', step: 3, startedAtMs: 94_000 })
  store.acceptChunk(record, c, { timeMs: 95_000, chunk: chunk('output', 'done') })
  store.acceptChunk(record, c, { timeMs: 99_000, chunk: chunk('output', ' finished') })
  store.settleAttempt(c, {
    settledAtMs: 99_500,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 500, reasoningTokens: 0 },
  })

  return { record, settled: store.endTurn(record, { timeMs: 100_000, status: 'completed' }) }
}

test('a full multi-call turn aggregates turn-level sums rather than per-call averages', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveMultiCallTurn(store)

  // Reasoning: attempt A 40 tokens over 1000 ms (1000 -> 2000), attempt B 360
  // tokens over 3000 ms. Turn sum: 400 tokens over 4000 ms of reasoning time.
  assert.equal(settled.reasoningTokens, 400)
  assert.equal(settled.reasoningMs, 4000)
  assert.equal(settled.reasoningTps, 100)

  // The per-attempt reasoning rates are 40 and 120; the turn value is neither of
  // them and is not their mean (80).
  assert.notEqual(settled.reasoningTps, (40 + 120) / 2)

  // Non-reasoning output: (100-40) + (900-360) + (500-0) = 60 + 540 + 500 = 1100
  // tokens over A 1000 + B 3000 + C 4000 = 8000 ms of model output time.
  assert.equal(settled.nonReasoningTokens, 60 + 540 + 500)
  assert.equal(settled.outputMs, 1000 + 3000 + 4000)
  assert.equal(settled.outputTps, 1100 * 1000 / 8000)

  // The forbidden arithmetic mean over attempts would be
  // (60/1 + 180/3 + 125/4) / 3 = 50.4 output tokens/s; the weighted turn value is
  // 137.5. Averaging per-attempt rates is what this test exists to prevent.
  assert.notEqual(settled.outputTps, (60 / 1 + 180 / 3 + 125 / 4) / 3)

  assert.equal(settled.generatedTokens, 1500)
  assert.equal(settled.generatedTokensQuality, MetricQuality.EXACT)
  assert.equal(settled.splitComplete, true)
  assert.equal(settled.ttftMs, 1000)
  assert.equal(settled.turnElapsedMs, 100_000)
  assert.equal(settled.attemptCount, 3)
  assert.equal(settled.contributingAttemptCount, 3)
})

test('tool latency excludes the model time and is reported as both sums', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveMultiCallTurn(store)
  assert.equal(settled.tools.count, 2)
  assert.equal(settled.tools.workMs, 62_400 + 20_000)
  assert.equal(settled.tools.wallMs, 82_400, 'the two tools never overlap here')
  assert.deepEqual(settled.tools.names, ['pwsh', 'write'])
})

test('the curve is compressed: tool waits and next-call TTFT contribute no width', () => {
  const store = new TurnTelemetryStore()
  const { settled } = driveMultiCallTurn(store)
  // Model-generated spans: 2000 (A) + 6000 (B) + 4000 (C) = 12 000 ms, against a
  // 100 000 ms turn. The curve must reflect the 12 s, not the 100 s.
  assert.equal(settled.curve.durationMs, 12_000)
  assert.deepEqual(settled.curve.segments.map(s => [s.startMs, s.endMs]), [
    [0, 2000], [2000, 8000], [8000, 12_000],
  ])
  assert.equal(settled.curve.reasoning.at(-1).timeMs, 12_000)
  assert.equal(settled.curve.output.at(-1).timeMs, 12_000)
  assert.equal(settled.curve.quality, 'calibrated')
  assert.ok(settled.curve.peakTps > 0)
})

test('the live window is reset at each attempt and reports no TPS while a tool runs', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const a = store.beginAttempt(record, { attemptId: 'a1', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, a, { timeMs: 100, chunk: chunk('output', 'x'.repeat(400)) })

  const streaming = store.liveSnapshot('s1', 200)
  assert.equal(streaming.phase, 'streaming')
  assert.equal(streaming.tpsQuality, MetricQuality.ESTIMATED)
  assert.equal(streaming.activePhase, 'output')
  assert.ok(streaming.tps > 0)

  store.toolStarted(record, { callId: 'c1', name: 'pwsh', timeMs: 300 })
  const tooling = store.liveSnapshot('s1', 2000)
  assert.equal(tooling.phase, 'tool')
  assert.equal(tooling.tps, null, 'never a stale or zero TPS while a tool runs')
  assert.equal(tooling.toolElapsedMs, 1700)

  store.toolSettled(record, { callId: 'c1', timeMs: 2050, status: 'ok' })
  const b = store.beginAttempt(record, { attemptId: 'b1', step: 2, startedAtMs: 2100 })
  assert.equal(b.attemptId, 'b1')
  assert.equal(store.liveSnapshot('s1', 2100).tps, 0, 'the new attempt starts from an empty window')

  store.acceptChunk(record, b, { timeMs: 2200, chunk: chunk('output', 'y'.repeat(40)) })
  const after = store.liveSnapshot('s1', 2300)
  assert.equal(after.phase, 'streaming')
  assert.ok(after.tps < streaming.tps, 'only the new attempt tokens are in the window')
})

test('two sessions never share a live window or a turn record', () => {
  const store = new TurnTelemetryStore()
  const s1 = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const s2 = store.beginTurn({ sessionId: 's2', turn: 1, timeMs: 0 })

  const a1 = store.beginAttempt(s1, { attemptId: 'x', step: 1 })
  store.acceptChunk(s1, a1, { timeMs: 100, chunk: chunk('output', 'a'.repeat(400)) })
  const a2 = store.beginAttempt(s2, { attemptId: 'y', step: 1 })
  store.acceptChunk(s2, a2, { timeMs: 100, chunk: chunk('output', 'b') })

  const one = store.liveSnapshot('s1', 200)
  const two = store.liveSnapshot('s2', 200)
  assert.ok(one.tps > two.tps * 10, 'each session keeps its own rolling window')

  store.endTurn(s1, { timeMs: 1000, status: 'completed' })
  assert.equal(store.latestSettled('s1').turn, 1)
  assert.equal(store.latestSettled('s2'), null, 'a settled turn in one session is not visible in the other')
})

test('replaying a durable turn/start does not discard what was already observed', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 7, timeMs: 0 })
  const a = store.beginAttempt(record, { attemptId: 'a1', step: 1 })
  store.acceptChunk(record, a, { timeMs: 100, chunk: chunk('output', 'keep me') })

  const replayed = store.beginTurn({ sessionId: 's1', turn: 7, timeMs: 0 })
  assert.equal(replayed, record)
  assert.equal(replayed.attempts.length, 1)
  assert.equal(replayed.attempts[0].samples.length, 1)
})

test('an attempt that never streamed does not create an empty phase denominator', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  store.beginAttempt(record, { attemptId: 'empty', step: 1 })
  const b = store.beginAttempt(record, { attemptId: 'b1', step: 1 })
  store.acceptChunk(record, b, { timeMs: 0, chunk: chunk('output', 'a') })
  store.acceptChunk(record, b, { timeMs: 2000, chunk: chunk('output', 'b') })
  const settled = store.endTurn(record, { timeMs: 3000, status: 'completed' })
  assert.equal(settled.outputMs, 2000)
  assert.equal(settled.emptyAttemptCount, 1)
})

test('a usage chunk mid-stream is captured without becoming a sample', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const a = store.beginAttempt(record, { attemptId: 'a1', step: 1 })
  store.acceptChunk(record, a, { timeMs: 0, chunk: chunk('output', 'hi') })
  store.acceptChunk(record, a, {
    timeMs: 100,
    chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 42, reasoningTokens: 12 } },
  })
  assert.equal(a.samples.length, 1, 'a usage chunk is not a generated delta')
  assert.equal(a.usage.outputTokens, 42)
})

test('history is bounded and dispose clears every session', () => {
  const store = new TurnTelemetryStore({ historyLimit: 2 })
  for (let turn = 1; turn <= 4; turn += 1) {
    const record = store.beginTurn({ sessionId: 's1', turn, timeMs: turn * 1000 })
    const a = store.beginAttempt(record, { attemptId: `a${turn}`, step: 1 })
    store.acceptChunk(record, a, { timeMs: turn * 1000, chunk: chunk('output', 'x') })
    store.endTurn(record, { timeMs: turn * 1000 + 500, status: 'completed' })
  }
  const retained = [...store.turns.keys()]
  assert.equal(retained.length, 2)
  assert.equal(store.latestSettled('s1').turn, 4, 'the newest settled turn survives pruning')

  store.dispose()
  assert.equal(store.turns.size, 0)
  assert.equal(store.liveBySession.size, 0)
  assert.deepEqual(store.liveSnapshot('s1', 0), { phase: 'idle' })
})
