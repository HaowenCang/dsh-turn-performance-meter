/**
 * Degradation and corruption.
 *
 * One rule governs every case here: insufficient evidence must lower a quality
 * or produce `unavailable`. It must never be silently coerced to zero, and it
 * must never be reported as exact.
 *
 * The cases are the twelve named in the Phase 2 brief, and each is exercised on
 * either a real recording, a declared synthetic derivative of one, or a
 * minimal in-test mutation of a real compact stream.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { accumulateLive, LiveTurnAccumulator, FRAME_ISSUE } from '../src/dsh/live-path.js'
import { normalizeLiveChunk } from '../src/dsh/adapter.js'
import { decodeStreamRecords } from '../src/dsh/stream-decoder.js'
import { isTokenDelta } from '../src/core/delta-accounting.js'
import { loadDerived, loadFixture } from './helpers/fixtures.js'
import { durableSettledView, liveSettledView, metricTuple, runLivePath } from './helpers/equivalence.js'

const SETTLEMENT_TYPES = new Set(['assistant/message', 'assistant/attempt'])

/** Replace one session event's data in a fixture copy, without touching the file. */
function withPatchedEvent(fixture, predicate, patch) {
  const next = JSON.parse(JSON.stringify(fixture))
  const target = next.durable.map(row => row.event).find(predicate)
  if (target !== undefined) patch(target)
  return next
}

test('missing usage: the turn total becomes unavailable, the partial sum stays diagnostic', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  // Remove the settlement usage *and* any in-stream usage chunk: an in-stream
  // usage chunk is an authoritative carrier too, so leaving one in place would
  // make this test measure nothing (and the code that found it is doing the
  // right thing).
  const patched = withPatchedEvent(
    fixture,
    event => event.type === 'assistant/message' && event.data.step === 2,
    event => {
      delete event.data.usage
      event.data.stream = event.data.stream.filter(record => record.type !== 'chunk' || record.chunk.type !== 'usage')
    },
  )
  const view = durableSettledView(patched)
  assert.equal(view.settled.usageComplete, false)
  assert.equal(view.settled.generatedTokens, null, 'an incomplete total is never published as a number')
  assert.equal(view.settled.quality.tokenTotalQuality, 'partial')
  assert.equal(view.settled.quality.displayTokenTotal, 'approximate')
  assert.ok(view.settled.observedGeneratedTokens > 0, 'the observed prefix is still reported, as a diagnostic')
  assert.notEqual(view.settled.generatedTokens, view.settled.observedGeneratedTokens)
  // The rate whose numerator is incomplete must not be published either.
  assert.equal(view.settled.reasoningTps, null)
  assert.equal(view.settled.outputTps, null)
  assert.equal(view.settled.reasoningTpsQuality, 'unavailable')
})

test('an in-stream usage chunk is an authoritative carrier, not a shape estimate', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const event = fixture.durable.map(row => row.event).find(e => e.type === 'assistant/message' && e.data.step === 1)
  const inStream = event.data.stream.filter(record => record.type === 'chunk' && record.chunk.type === 'usage')
  assert.equal(inStream.length, 1, 'the recorded stream carries an in-stream usage chunk')

  // Remove only the settlement carrier: the in-stream chunk is now the only
  // authoritative counter for that attempt, and the engine must use it rather
  // than falling back to shape weights.
  const patched = withPatchedEvent(
    fixture,
    e => e.type === 'assistant/message' && e.data.step === 1,
    e => { delete e.data.usage },
  )
  const view = durableSettledView(patched)
  const first = view.settled.attemptBreakdown[0]
  assert.equal(first.usage.outputTokens, inStream[0].chunk.usage.outputTokens)
  assert.equal(first.usageSource, 'in-stream-usage-chunk')
  assert.equal(view.settled.usageAttemptCount, 2, 'both attempts still carry an authoritative total')
  assert.equal(view.settled.quality.tokenTotalQuality, 'exact')
})

test('missing usage on every attempt: nothing is claimed to be exact', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const patched = JSON.parse(JSON.stringify(fixture))
  for (const row of patched.durable) {
    if (!SETTLEMENT_TYPES.has(row.event.type)) continue
    delete row.event.data.usage
    row.event.data.stream = row.event.data.stream.filter(record => record.type !== 'chunk' || record.chunk.type !== 'usage')
  }
  const view = durableSettledView(patched)
  assert.equal(view.settled.usageAttemptCount, 0)
  assert.equal(view.settled.observedGeneratedTokens, 0, 'no usage means no observed sum, not a fabricated one')
  assert.equal(view.settled.generatedTokens, null)
  assert.equal(view.settled.quality.tokenTotalQuality, 'unavailable')
  assert.equal(view.settled.quality.displayTokenTotal, 'unavailable')
  // The stream is still real evidence, so timing is preserved.
  assert.ok(view.settled.outputMs > 0)
  assert.ok(metricTuple(view).chart.coordinates.length > 0)
})

test('missing reasoningTokens: the total stays exact, the split degrades', () => {
  const fixture = loadDerived('d1-no-reasoning-tokens')
  assert.equal(fixture.syntheticMutation.kind, 'drop-reasoning-tokens')
  const view = durableSettledView(fixture)

  assert.equal(view.settled.usageComplete, true)
  assert.equal(view.settled.splitComplete, false)
  assert.equal(view.settled.generatedTokens, 1308, 'the provider total is still authoritative')
  assert.equal(view.settled.reasoningTokens, null)
  assert.equal(view.settled.nonReasoningTokens, null)
  assert.equal(view.settled.quality.tokenTotalQuality, 'exact')
  assert.equal(view.settled.quality.phaseSplitQuality, 'estimated')
  assert.equal(view.settled.quality.temporalShapeQuality, 'reconstructed')
  assert.equal(view.settled.quality.displayTokenTotal, 'exact')
  assert.equal(view.settled.quality.displayPhaseSplit, 'approximate')

  // Calibration still anchors the whole-attempt integral to the exact total.
  const total = view.settled.attemptBreakdown.reduce((sum, attempt) => (
    sum + (attempt.reasoningTokens ?? 0) + (attempt.outputTokens ?? 0)
  ), 0)
  assert.ok(Math.abs(total - 1308) < 1e-6, `anchored integral drifted to ${total}`)
})

test('a provider total with no deltas of that phase is reported, not invented', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  // Strip every reasoning run from the first settlement: the provider still
  // reports reasoningTokens, so the split cannot be exact any more.
  const patched = withPatchedEvent(
    fixture,
    event => event.type === 'assistant/message' && event.data.step === 1,
    event => { event.data.stream = event.data.stream.filter(record => record.type !== 'reasoning-chunks') },
  )
  const view = durableSettledView(patched)
  const first = view.settled.attemptBreakdown[0]
  assert.equal(first.calibration.totalAnchored, true)
  assert.equal(first.calibration.splitQuality, 'unavailable')
  assert.match(first.calibration.note, /no such deltas/)
  assert.equal(first.usage.reasoningTokens, 74, 'the authoritative counter is still reported')
  assert.equal(first.reasoningTokens, 74, 'the phase total is the provider counter, not the empty shape sum')
})

test('missing delta timestamp: the decoder reports it and the sample never enters the series', () => {
  const decoded = decodeStreamRecords([
    { type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['ok'] },
    { type: 'chunk', time: 'soon', chunk: { type: 'text-delta', index: 0, text: 'lost' } },
  ])
  assert.equal(decoded.complete, false)
  assert.deepEqual(decoded.issues.map(issue => issue.kind), ['bad-time'])
  assert.deepEqual(decoded.chunks.map(entry => entry.chunk.text), ['ok'])
  assert.equal(decoded.quality, 'estimated')
})

test('a live frame without a timestamp is refused and lowers the live quality', () => {
  const accumulator = new LiveTurnAccumulator({ sessionId: 's' })
  accumulator.acceptStreamFrame({ type: 'start', attemptId: 's:1', revision: 1, turn: 1, step: 1 })
  accumulator.acceptStreamFrame({
    type: 'chunk',
    attemptId: 's:1',
    revision: 2,
    index: 0,
    time: undefined,
    chunk: { type: 'text-delta', index: 0, text: 'x' },
  })
  assert.deepEqual(accumulator.issues.map(issue => issue.kind), [FRAME_ISSUE.MISSING_TIME])
  assert.equal(accumulator.attemptList()[0].samples.length, 0)
  assert.equal(accumulator.liveQuality(), 'estimated')
})

test('a duplicated transient frame is refused, not double counted', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const frames = fixture.transient.map(row => row.frame)
  const doubled = [...frames]
  const firstChunk = frames.find(frame => frame.type === 'chunk')
  doubled.splice(frames.indexOf(firstChunk) + 1, 0, firstChunk)

  const accumulator = accumulateLive({
    sessionId: fixture.sessionId,
    frames: doubled,
    durableEvents: fixture.durable.map(row => row.event),
  })
  const attempt = accumulator.attemptList()[0]
  assert.equal(accumulator.issues.filter(issue => issue.kind === FRAME_ISSUE.DUPLICATE).length, 1)
  assert.equal(attempt.issues[0].kind, FRAME_ISSUE.DUPLICATE)
  assert.equal(attempt.acceptedFrameCount, attempt.frameCount - 1, 'the duplicate must not be accepted')

  // The accepted delta count must still equal the clean run's: a duplicate must
  // not add a sample anywhere in the turn.
  const clean = metricTuple(liveSettledView(fixture))
  const replayed = metricTuple(liveSettledView({ ...fixture, transient: doubled.map(frame => ({ frame })) }))
  const cleanSamples = liveSettledView(fixture).record.attempts.reduce((sum, a) => sum + a.samples.length, 0)
  const replayedSamples = liveSettledView({ ...fixture, transient: doubled.map(frame => ({ frame })) })
    .record.attempts.reduce((sum, a) => sum + a.samples.length, 0)
  assert.equal(replayedSamples, cleanSamples)
  assert.equal(replayed.chart.coordinates.length, clean.chart.coordinates.length)
  assert.equal(replayed.chart.durationMs, clean.chart.durationMs)
  assert.equal(replayed.chart.peakTps, clean.chart.peakTps)
})

test('an out-of-order transient frame is reported and the gap is visible', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const frames = fixture.transient.map(row => row.frame)
  const chunkIndexes = frames.map((frame, index) => (frame.type === 'chunk' ? index : -1)).filter(index => index >= 0)
  const reordered = [...frames]
  // Drop frame 3 so that frame 4 arrives with index 4 while index 3 is expected.
  reordered.splice(chunkIndexes[3], 1)

  const accumulator = accumulateLive({
    sessionId: fixture.sessionId,
    frames: reordered,
    durableEvents: fixture.durable.map(row => row.event),
  })
  const gaps = accumulator.issues.filter(issue => issue.kind === FRAME_ISSUE.OUT_OF_ORDER)
  assert.equal(gaps.length, 1, 'exactly one gap, reported once')
  assert.equal(gaps[0].detail.index, 4)
  assert.equal(gaps[0].detail.expected, 3)
  assert.equal(accumulator.liveQuality(), 'estimated')
})

test('a frame for an unknown attempt is reported rather than silently dropped', () => {
  const accumulator = new LiveTurnAccumulator({ sessionId: 's' })
  accumulator.acceptStreamFrame({
    type: 'chunk',
    attemptId: 'never-started',
    revision: 9,
    index: 5,
    time: 1000,
    chunk: { type: 'text-delta', index: 0, text: 'x' },
  })
  const attempt = accumulator.attemptList()[0]
  assert.equal(attempt.attemptId, 'never-started')
  assert.equal(attempt.issues[0].kind, FRAME_ISSUE.OUT_OF_ORDER, 'a non-zero first index is a gap, not a silent accept')
  assert.equal(accumulator.issues.length, 1)
})

test('an unmatched tool result is reported and no duration is invented', () => {
  const view = durableSettledView(loadDerived('d4-unmatched-tool-result'))
  const unmatched = view.issues.filter(issue => issue.kind === 'unmatched-tool-call')
  assert.equal(unmatched.length, 1, 'the call with no result must be reported')
  assert.equal(view.settled.tools.count, 3, 'the call is still counted as seen')
  assert.equal(view.settled.tools.completedCount, 2, 'only completed calls carry duration')
  assert.equal(view.settled.tools.runningCount, 1)
  assert.ok(view.settled.tools.workMs > 0)
  assert.ok(view.settled.tools.wallMs > 0)
  assert.ok(view.settled.tools.workMs >= view.settled.tools.wallMs)
  // The unmatched call contributes zero duration, not an inferred one.
  const measured = view.record.tools.map(call => (Number.isFinite(call.endMs) ? call.endMs - call.startMs : null))
  assert.ok(measured.includes(null))
})

test('an assistant/attempt settlement is kept as evidence and never claimed as a surface message', () => {
  const fixture = loadDerived('d3-attempt-without-message')
  assert.equal(fixture.syntheticMutation.kind, 'convert-settlement-to-attempt')
  const view = durableSettledView(fixture)
  const attempts = view.reconstructed.attempts
  assert.equal(attempts.length, 2)
  // Phase 3 semantic correction: `assistant/attempt` is a durable settlement
  // that committed no surface message (failed/retried/cancelled/stream-error),
  // not a transient abandonment. The outcome stays `unknown` because the
  // durable payload carries no cause and no `llm/retry` names this attempt.
  assert.deepEqual(
    {
      settlementKind: attempts[0].settlementKind,
      surfaceCommitted: attempts[0].surfaceCommitted,
      attemptOutcome: attempts[0].attemptOutcome,
    },
    { settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' },
  )
  assert.equal(attempts[1].settlementKind, 'attempt')
  assert.equal(attempts[1].surfaceCommitted, false)
  assert.equal(attempts[1].attemptOutcome, 'unknown')
  assert.notEqual(attempts[1].attemptOutcome, 'abandoned', 'abandoned may only come from a transient end frame')
  assert.equal(attempts[1].settlementEventType, 'assistant/attempt')
  // The converted settlement carries no usage, but the attempt's in-stream usage
  // chunk is recorded and is authoritative, so the counter survives conversion.
  // What must not happen is attributing usage to a *surface message* that was
  // never recorded: `assistant/attempt` has no `message` field at all.
  const settlement = view.reconstructed.settlements.find(item => item.seq === attempts[1].settlementSeq)
  assert.equal(settlement.type, 'assistant/attempt')
  assert.equal(attempts[1].usageSource === null || attempts[1].usageSource === 'in-stream-usage-chunk', true)
  // The non-surface attempt's deltas are still real generation time.
  assert.ok(attempts[1].decoded.deltaCount > 0)
  // The live path derives the same three concepts from the same evidence.
  const live = runLivePath(fixture).accumulator.attemptList()
  assert.equal(live[1].settlementKind, 'attempt')
  assert.equal(live[1].surfaceCommitted, false)
  assert.equal(live[1].attemptOutcome, 'unknown')
})

test('a retried attempt sequence keeps both attempts and their separate windows', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const frames = fixture.transient.map(row => row.frame)
  const attemptIds = [...new Set(frames.map(frame => frame.attemptId))]
  assert.equal(attemptIds.length, 2, 'the recording holds two attempt epochs')

  const accumulator = accumulateLive({
    sessionId: fixture.sessionId,
    frames,
    durableEvents: fixture.durable.map(row => row.event),
  })
  const attempts = accumulator.attemptList()
  assert.deepEqual(attempts.map(a => a.attemptId), attemptIds, 'attempts keep their own identity and order')
  assert.equal(attempts.length, 2)
  // Each attempt's samples stay inside that attempt: no window bridging.
  for (const attempt of attempts) {
    assert.ok(attempt.samples.every(sample => sample.attemptId === attempt.attemptId))
    const times = attempt.samples.map(sample => sample.timeMs)
    assert.ok(Math.max(...times) - Math.min(...times) < 2000, 'an attempt window must not span the tool gap')
  }
})

test('reasoningTokens=0 on a fixture that streamed reasoning downgrades the split, not the total', () => {
  // The recorded t4 step-1 attempt reports reasoningTokens=74 next to a
  // reasoning run. Forcing the counter to 0 creates the exact provider/stream
  // contradiction the Phase 3 guard exists for: aggregate usage says "no
  // reasoning tokens" while the stream carries non-empty reasoning deltas.
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const patched = withPatchedEvent(
    fixture,
    event => event.type === 'assistant/message' && event.data.step === 1,
    event => { event.data.usage.reasoningTokens = 0 },
  )
  const view = durableSettledView(patched)
  const q = view.settled.quality
  assert.equal(q.tokenTotalQuality, 'exact', 'the authoritative outputTokens total still anchors the turn')
  assert.notEqual(q.phaseSplitQuality, 'exact', 'a split contradicted by the stream is never exact')
  assert.equal(q.phaseSplitQuality, 'estimated')
  assert.equal(view.settled.splitQuality, 'estimated')
  assert.ok(view.settled.consistencyIssues.length >= 1)
  assert.match(view.settled.consistencyIssues[0], /reasoningTokens=0/)
  assert.ok(q.notes.some(note => /reasoningTokens=0/.test(note)))

  // The unmutated recording agrees with itself and keeps its exact split —
  // the guard must not fire on consistent evidence.
  const clean = durableSettledView(fixture)
  assert.deepEqual(clean.settled.consistencyIssues, [])
  assert.equal(clean.settled.quality.phaseSplitQuality, 'exact')
})

test('an interrupted turn is interrupted, not completed, on both paths', () => {
  const fixture = loadFixture('t3-interrupted-mid-reasoning')
  const durable = metricTuple(durableSettledView(fixture))
  const live = metricTuple(liveSettledView(fixture))
  assert.equal(durable.status, 'interrupted')
  assert.equal(live.status, 'interrupted')
  assert.equal(durable.usageComplete, false)
  assert.equal(durable.generatedTokens, null)
  assert.equal(durable.quality.tokenTotalQuality, 'unavailable')
  assert.equal(durable.quality.displayTokenTotal, 'unavailable')

  // The interruption is also recoverable from the settlement marker alone.
  const settlement = fixture.durable.map(row => row.event).find(event => event.type === 'assistant/message')
  assert.equal(settlement.data.interrupted, true)
})

test('zero-token and empty deltas never enter a series and never divide by zero', () => {
  const decoded = decodeStreamRecords([
    { type: 'chunk', time: 1, chunk: { type: 'text-delta', index: 0, text: '' } },
    { type: 'chunk', time: 2, chunk: { type: 'reasoning-delta', index: 0, text: '' } },
    { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'chunk', time: 4, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'assembled only' } } },
    { type: 'chunk', time: 5, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 7 } } },
    { type: 'chunk', time: 6, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])
  assert.equal(decoded.complete, true)
  assert.equal(decoded.deltaCount, 6, 'the chunks decode')
  assert.equal(decoded.generatedChunkCount, 0, 'none of them is a generated delta')

  // A settlement whose every delta is empty. The tool-call runs lose their
  // `name` too, because DSH itself stores a name-less tool-call delta as a raw
  // chunk precisely so that it does not count as a first token — which is why
  // `isTokenDelta` accepts a name-*bearing* delta with empty arguments.
  const view = durableSettledView(withPatchedEvent(
    loadFixture('t1-reasoning-tool-reasoning'),
    event => event.type === 'assistant/message' && event.data.step === 1,
    event => {
      event.data.stream = event.data.stream.map(record => {
        if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
          return { ...record, texts: record.texts.map(() => '') }
        }
        if (record.type === 'tool-call-chunks') {
          const { name, ...rest } = record
          return { ...rest, args: record.args.map(() => '') }
        }
        return record
      })
    },
  ))
  const attempt = view.settled.attemptBreakdown.find(item => item.step === 1)
  assert.equal(attempt, undefined, 'an attempt with no generated delta stops contributing to the turn')

  const reconstructed = view.reconstructed.attempts.find(item => item.step === 1)
  assert.equal(reconstructed.usage.outputTokens, 118, 'but its authoritative usage is still recorded')
  assert.equal(reconstructed.usageSource, 'assistant-settlement')
  assert.ok(reconstructed.decoded.deltaCount > 0, 'the delta boundaries are still decoded')
  assert.equal(reconstructed.decoded.generatedChunkCount, 0, 'but none of them carries generated content')
  assert.equal(view.settled.emptyAttemptCount, 1)
  assert.equal(view.settled.usageAttemptCount + view.settled.emptyAttemptCount, 2)
})

test('a phase with tokens but no measurable interval yields a rate or nothing, never NaN', () => {
  const view = durableSettledView(loadFixture('t1-reasoning-tool-reasoning'))
  assert.equal(Number.isNaN(view.settled.reasoningTps), false)
  assert.equal(Number.isNaN(view.settled.outputTps), false)
  for (const attempt of view.settled.attemptBreakdown) {
    assert.equal(attempt.reasoningMs === null || Number.isFinite(attempt.reasoningMs), true)
    assert.equal(attempt.outputMs === null || Number.isFinite(attempt.outputMs), true)
  }
  // A published rate is always a finite number: a zero-length denominator must
  // produce `null`, never `Infinity`.
  const published = [
    view.settled.reasoningTps,
    view.settled.outputTps,
    view.settled.tools.workMs,
    view.settled.tools.wallMs,
    view.settled.ttftMs,
    view.settled.turnElapsedMs,
  ]
  for (const value of published) {
    assert.equal(value === null || Number.isFinite(value), true, `non-finite metric: ${String(value)}`)
  }
})

test('an attempt with one generated delta yields no duration rather than an infinite rate', () => {
  const view = durableSettledView(withPatchedEvent(
    loadFixture('t1-reasoning-tool-reasoning'),
    event => event.type === 'assistant/message' && event.data.step === 2,
    event => {
      event.data.stream = event.data.stream.map(record => (
        record.type === 'text-chunks'
          ? { ...record, texts: [record.texts[0]], dt: [] }
          : record.type === 'reasoning-chunks' ? { ...record, texts: record.texts.map(() => '') } : record
      ))
    },
  ))
  const attempt = view.settled.attemptBreakdown.find(item => item.step === 2)
  assert.equal(attempt.sampleCount, 1)
  assert.equal(attempt.outputMs, null, 'one sample has no inter-delta interval')
  assert.equal(attempt.outputTokens, 16, 'the provider total is still known')
  // One attempt with no measurable interval makes the turn rate optimistic, so
  // it is at best `estimated`, and the published value is finite — never NaN and
  // never `Infinity` from a zero-length denominator.
  assert.ok(['estimated', 'unavailable'].includes(view.settled.outputTpsQuality))
  assert.equal(view.settled.outputTps === null || Number.isFinite(view.settled.outputTps), true)
  assert.ok(Number.isNaN(view.settled.outputTps) === false)
})

test('concurrent tools keep both individual durations and a non-double-counted union', () => {
  // A real recording has sequential tools; overlap is exercised on the same
  // normalized records by shifting the second call earlier, which is the only
  // property under test here and is applied to a copy.
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const patched = JSON.parse(JSON.stringify(fixture))
  const calls = patched.durable.filter(row => row.event.type === 'tool/call')
  const results = patched.durable.filter(row => row.event.type === 'tool/result')
  assert.equal(calls.length, 2)

  const firstDuration = results[0].event.time - calls[0].event.time
  calls[1].event.time = calls[0].event.time + Math.floor(firstDuration / 2)
  const secondDuration = results[1].event.time - calls[1].event.time

  const view = durableSettledView(patched)
  assert.equal(view.settled.tools.count, 2)
  assert.equal(view.settled.tools.workMs, firstDuration + secondDuration, 'work is the sum of both')
  assert.ok(view.settled.tools.wallMs < view.settled.tools.workMs, 'the union is shorter than the sum when calls overlap')
  assert.ok(view.settled.tools.wallMs >= Math.max(firstDuration, secondDuration))
})

test('a live plane with a lost frame is reported, and the durable plane still recovers it', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const frames = fixture.transient.map(row => row.frame)
  const withGap = [...frames]
  const chunkPositions = frames.map((frame, index) => (frame.type === 'chunk' ? index : -1)).filter(index => index >= 0)
  withGap.splice(chunkPositions[5], 1)

  const gapped = { ...fixture, transient: withGap.map(frame => ({ frame })) }
  const view = liveSettledView(gapped)
  assert.ok(view.issues.some(issue => issue.kind === FRAME_ISSUE.OUT_OF_ORDER), 'the gap must surface on the live view')

  // The live plane lost a delta; the durable plane did not, and that is exactly
  // the property that makes the durable reconstruction the authority after a
  // reload. The chart is the observable consequence.
  const cleanLive = metricTuple(liveSettledView(fixture))
  const gappedLive = metricTuple(view)
  const durable = metricTuple(durableSettledView(fixture))
  assert.equal(gappedLive.chart.coordinates.length, cleanLive.chart.coordinates.length - 1)
  assert.equal(gappedLive.chart.coordinates.length, durable.chart.coordinates.length - 1, 'the durable plane is unaffected')
  assert.equal(durable.chart.durationMs, cleanLive.chart.durationMs, 'losing a delta does not move the span endpoints')
})

test('the live path never reads a durable settlement stream', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const { accumulator } = runLivePath(fixture)
  // Every accepted sample must have come from a transient frame. If the live
  // path had consulted the compact stream, its sample count would still exceed
  // the recorded frame count.
  const recordedGenerated = fixture.transient
    .map(row => row.frame)
    .filter(frame => frame.type === 'chunk' && normalizeLiveChunk({
      type: 'assistant/live-chunk',
      time: frame.time,
      data: { attemptId: frame.attemptId, chunk: frame.chunk },
    }).phase !== null)
    .length
  const accepted = accumulator.attemptList().reduce((sum, attempt) => sum + attempt.samples.length, 0)
  assert.equal(accepted, recordedGenerated)
})
