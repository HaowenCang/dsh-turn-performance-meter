/**
 * The DSH raw-evidence -> normalized-event mapping.
 *
 * The field mapping is the project's most version-sensitive surface: DSH is
 * evolving, and a field rename that nobody notices would silently turn a
 * measured boundary into `undefined`. These tests pin the mapping against real
 * recorded events, so a rename shows up as a failure rather than as a metric
 * that quietly became zero.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ATTEMPT_OUTCOME,
  DSH_RAW_KIND,
  NORMALIZED_KIND,
  SETTLEMENT_KIND,
  applyRetryOutcomes,
  classifyRawEntry,
  isAssistantStreamFrame,
  isDurableSessionEventEntry,
  isTransientLiveChunkEntry,
  normalizeDurableEvent,
  normalizeLiveChunk,
  normalizeStreamFrame,
  settlementClassification,
  turnEndStatus,
} from '../src/dsh/index.js'
import { loadFixture } from './helpers/fixtures.js'

const event = (type, seq, time, data) => ({ type, seq, time, data })

test('durable turn, step and tool boundaries map onto normalized events', () => {
  assert.deepEqual(
    normalizeDurableEvent(event('turn/start', 4, 1000, { turn: 1 })),
    { kind: NORMALIZED_KIND.TURN_START, seq: 4, timeMs: 1000, turn: 1 },
  )
  assert.deepEqual(
    normalizeDurableEvent(event('step/start', 6, 1010, { turn: 1, step: 2 })),
    { kind: NORMALIZED_KIND.STEP_START, seq: 6, timeMs: 1010, turn: 1, step: 2 },
  )
  assert.deepEqual(
    normalizeDurableEvent(event('step/end', 7, 1020, { turn: 1, step: 2 })),
    { kind: NORMALIZED_KIND.STEP_END, seq: 7, timeMs: 1020, turn: 1, step: 2 },
  )

  const call = normalizeDurableEvent(event('tool/call', 17, 1100, {
    turn: 1,
    step: 1,
    callId: 'call_1',
    name: 'pwsh',
    arguments: '{"command":"Get-Date"}',
  }))
  assert.equal(call.kind, NORMALIZED_KIND.TOOL_CALL)
  assert.equal(call.callId, 'call_1')
  assert.equal(call.name, 'pwsh')
  assert.equal(call.argumentsRaw, '{"command":"Get-Date"}')
  assert.equal(call.timeMs, 1100)

  const result = normalizeDurableEvent(event('tool/result', 18, 1200, {
    turn: 1,
    step: 1,
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [], isError: false }] },
  }))
  assert.equal(result.kind, NORMALIZED_KIND.TOOL_RESULT)
  assert.equal(result.callId, 'call_1')
  assert.equal(result.status, 'ok')
  assert.equal(result.timeMs, 1200)
})

test('a tool error is distinguishable without reading the result payload as output', () => {
  const failed = normalizeDurableEvent(event('tool/result', 20, 1300, {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'tool-result', toolCallId: 'call_2', content: [], isError: true }] },
    error: { name: 'ToolFailure', code: 'E_FAIL' },
  }))
  assert.equal(failed.status, 'error')
  assert.equal(failed.errorName, 'ToolFailure')
})

test('the four verified turn/end reasons map to the three card statuses', () => {
  assert.deepEqual(turnEndStatus({ kind: 'completed' }), { status: 'completed', known: true, note: null })
  assert.deepEqual(turnEndStatus({ kind: 'aborted', reason: { kind: 'user' } }), {
    status: 'interrupted',
    known: true,
    note: 'cancelled (user)',
  })
  assert.deepEqual(turnEndStatus({ kind: 'interrupted' }), {
    status: 'interrupted',
    known: true,
    note: 'turn was closed after a crash',
  })
  assert.equal(turnEndStatus({ kind: 'blocked' }).status, 'errored')
  assert.equal(turnEndStatus({ kind: 'error', error: { message: 'x', code: 'UNKNOWN' } }).status, 'errored')
  const maxTokens = turnEndStatus({ kind: 'max-tokens' })
  assert.equal(maxTokens.status, 'completed')
  assert.match(maxTokens.note, /ceiling/)
})

test('an unknown future turn/end reason never claims a known cause', () => {
  const mapped = turnEndStatus({ kind: 'something-new' })
  assert.equal(mapped.status, 'errored')
  assert.equal(mapped.known, false)
  assert.equal(turnEndStatus(undefined).known, false)
  const normalized = normalizeDurableEvent(event('turn/end', 25, 2000, { turn: 1, reason: { kind: 'something-new' } }))
  assert.equal(normalized.statusKnown, false)
  assert.deepEqual(normalized.rawReason, { kind: 'something-new' })
})

test('a settlement reports its stream quality, usage source and interruption marker', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const settlement = fixture.durable
    .map(row => row.event)
    .find(e => e.type === 'assistant/message')

  const normalized = normalizeDurableEvent(settlement)
  assert.equal(normalized.kind, NORMALIZED_KIND.ATTEMPT_SETTLE)
  assert.equal(normalized.turn, 1)
  assert.equal(normalized.step, 1)
  assert.equal(normalized.eventType, 'assistant/message')
  assert.equal(normalized.settlementKind, SETTLEMENT_KIND.MESSAGE)
  assert.equal(normalized.surfaceCommitted, true)
  assert.equal(normalized.attemptOutcome, ATTEMPT_OUTCOME.COMMITTED)
  assert.equal(normalized.interrupted, false)
  assert.equal(normalized.usageSource, 'assistant-settlement')
  assert.equal(normalized.usage.reasoningTokens, 74)
  assert.equal(normalized.decoded.quality, 'exact')
  assert.deepEqual(normalized.issues, [])
})

test('assistant/attempt is a durable non-surface settlement, never a fabricated abandonment', () => {
  // Verified against the local 0.1.5-rc.2 source:
  //   dsh-session/lib/types/types.d.ts:318-327 — "One model attempt that
  //   committed no surface message … reached settlement"; abandonment is the
  //   transient `AssistantStreamFrame.end.outcome.kind === 'abandoned'`
  //   ("live abandonment without one [durable settlement]").
  const attemptSettle = normalizeDurableEvent(event('assistant/attempt', 40, 4000, {
    turn: 1,
    step: 2,
    stream: [{ type: 'text-chunks', time0: 3900, index: 0, dt: [], texts: ['partial'] }],
  }))
  assert.equal(attemptSettle.kind, NORMALIZED_KIND.ATTEMPT_SETTLE, 'it IS a durable settlement')
  assert.equal(attemptSettle.settlementKind, SETTLEMENT_KIND.ATTEMPT)
  assert.equal(attemptSettle.surfaceCommitted, false)
  assert.equal(attemptSettle.attemptOutcome, ATTEMPT_OUTCOME.UNKNOWN, 'the durable payload carries no cause')

  const interrupted = settlementClassification('assistant/message', { interrupted: true })
  assert.deepEqual(interrupted, {
    settlementKind: SETTLEMENT_KIND.MESSAGE,
    surfaceCommitted: true,
    attemptOutcome: ATTEMPT_OUTCOME.INTERRUPTED,
  })

  const normal = settlementClassification('assistant/message', {})
  assert.equal(normal.attemptOutcome, ATTEMPT_OUTCOME.COMMITTED)
  assert.equal(normal.surfaceCommitted, true)

  // The only source of `abandoned`: a transient end frame with no settlement.
  const transientAbandon = normalizeStreamFrame({
    type: 'end', attemptId: 's:1', revision: 3, index: 2, outcome: { kind: 'abandoned' },
  })
  assert.equal(transientAbandon.kind, NORMALIZED_KIND.ATTEMPT_ABANDON)
  assert.equal(transientAbandon.attemptOutcome, ATTEMPT_OUTCOME.ABANDONED)
  assert.equal(transientAbandon.settlementKind, SETTLEMENT_KIND.NONE)
})

test('llm/retry is normalized and proves a retried assistant/attempt outcome', () => {
  const retry = normalizeDurableEvent(event('llm/retry', 51, 5000, {
    turn: 1,
    step: 3,
    retryId: 'r-1',
    retry: 1,
    provider: 'deepseek-official',
    mode: 'normal',
    policyKey: 'default',
    failure: { message: 'boom', code: 'RATE_LIMIT' },
    delayMs: 250,
  }))
  assert.equal(retry.kind, NORMALIZED_KIND.RETRY_SCHEDULED)
  assert.equal(retry.turn, 1)
  assert.equal(retry.step, 3)
  assert.equal(retry.retryId, 'r-1')

  // A failed attempt settled at seq 50 in the same step; the retry at seq 51
  // proves it was retried. An attempt in another step is untouched, and a
  // surface message is never rewritten.
  const attempts = [
    { turn: 1, step: 3, settlementKind: 'attempt', settlementSeq: 50, attemptOutcome: 'unknown' },
    { turn: 1, step: 4, settlementKind: 'attempt', settlementSeq: 49, attemptOutcome: 'unknown' },
    { turn: 1, step: 3, settlementKind: 'message', settlementSeq: 52, attemptOutcome: 'committed' },
  ]
  assert.equal(applyRetryOutcomes(attempts, [retry]), 1)
  assert.equal(attempts[0].attemptOutcome, 'retried')
  assert.equal(attempts[1].attemptOutcome, 'unknown', 'a different step is not proven')
  assert.equal(attempts[2].attemptOutcome, 'committed')
  // Idempotent: a second pass changes nothing.
  assert.equal(applyRetryOutcomes(attempts, [retry]), 0)
})

test('usage falls back to an in-stream usage chunk when the settlement has none', () => {
  const normalized = normalizeDurableEvent(event('assistant/message', 30, 3000, {
    turn: 1,
    step: 1,
    stream: [
      { type: 'text-chunks', time0: 2900, index: 0, dt: [], texts: ['hi'] },
      { type: 'chunk', time: 2990, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 11, reasoningTokens: 4 } } },
    ],
  }))
  assert.equal(normalized.usageSource, 'in-stream-usage-chunk')
  assert.equal(normalized.usage.outputTokens, 11)
})

test('a client-folded live chunk maps onto a delta with its own timestamp', () => {
  const row = {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq: 16.5,
      time: 1790229021408,
      data: {
        attemptId: 's:1',
        turn: 1,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'pwsh', argumentsDelta: '{"a"' },
      },
    },
  }
  const normalized = normalizeLiveChunk(row)
  assert.equal(normalized.kind, NORMALIZED_KIND.ATTEMPT_DELTA)
  assert.equal(normalized.timeMs, 1790229021408, 'time lives on the row, not on data')
  assert.equal(normalized.attemptId, 's:1')
  assert.equal(normalized.phase, 'output')
  assert.equal(normalized.countsAsToken, true)
  assert.equal(normalized.text, '{"a"')
  // The unwrapped form is accepted too: a consumer may hold either.
  assert.equal(normalizeLiveChunk(row.event).timeMs, 1790229021408)
  assert.equal(normalizeLiveChunk({ type: 'assistant/live-chunk', data: {} }).kind, NORMALIZED_KIND.IGNORED)
})

test('host assistant-stream frames map for all three frame kinds', () => {
  const start = normalizeStreamFrame({ type: 'start', attemptId: 's:1', revision: 1, turn: 2, step: 3 })
  assert.deepEqual(start, {
    kind: NORMALIZED_KIND.ATTEMPT_START,
    attemptId: 's:1',
    revision: 1,
    turn: 2,
    step: 3,
    startedAfterSeq: null,
  })

  const chunk = normalizeStreamFrame({
    type: 'chunk',
    attemptId: 's:1',
    revision: 5,
    index: 4,
    time: 1234,
    chunk: { type: 'reasoning-delta', index: 0, text: 'think' },
  })
  assert.equal(chunk.kind, NORMALIZED_KIND.ATTEMPT_DELTA)
  assert.equal(chunk.timeMs, 1234)
  assert.equal(chunk.phase, 'reasoning')

  const committed = normalizeStreamFrame({
    type: 'end',
    attemptId: 's:1',
    revision: 9,
    index: 8,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 23 },
  })
  assert.equal(committed.kind, NORMALIZED_KIND.ATTEMPT_SETTLE)
  assert.equal(committed.settlementSeq, 23)
  assert.equal(committed.settlementEventType, 'assistant/message')

  const abandoned = normalizeStreamFrame({ type: 'end', attemptId: 's:1', revision: 9, index: 8, outcome: { kind: 'abandoned' } })
  assert.equal(abandoned.kind, NORMALIZED_KIND.ATTEMPT_ABANDON)
  assert.equal(abandoned.settlementSeq, null)

  assert.equal(normalizeStreamFrame({ type: 'chunk', index: 0 }).kind, NORMALIZED_KIND.IGNORED)
})

test('raw entry classification separates the two planes without interpreting them', () => {
  assert.equal(classifyRawEntry({ type: 'turn/start', seq: 0, time: 1, data: {} }), DSH_RAW_KIND.DURABLE)
  assert.equal(classifyRawEntry({ type: 'event', event: { type: 'turn/end', seq: 1, time: 2, data: {} } }), DSH_RAW_KIND.DURABLE)
  assert.equal(
    classifyRawEntry({ type: 'assistant/live-chunk', seq: 1, time: 2, data: { attemptId: 'a', chunk: {} } }),
    DSH_RAW_KIND.TRANSIENT,
  )
  assert.equal(
    classifyRawEntry({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 1, time: 2, data: { attemptId: 'a' } } }),
    DSH_RAW_KIND.TRANSIENT,
  )
  assert.equal(classifyRawEntry({ type: 'chunk', attemptId: 'a', revision: 2, index: 1, time: 3, chunk: {} }), DSH_RAW_KIND.STREAM_FRAME)
  assert.equal(classifyRawEntry({ type: 'turn/start', data: {} }), DSH_RAW_KIND.UNKNOWN, 'a missing seq is not a session event')
  assert.equal(classifyRawEntry(null), DSH_RAW_KIND.UNKNOWN)
  assert.equal(isDurableSessionEventEntry({ type: 'turn/start', seq: 0, time: 1, data: {} }), true)
  assert.equal(isTransientLiveChunkEntry({ type: 'assistant/live-chunk', time: 1, data: { attemptId: 'a' } }), true)
  assert.equal(isAssistantStreamFrame({ type: 'start', attemptId: 'a' }), true)
  assert.equal(isAssistantStreamFrame({ type: 'chunk' }), false, 'a frame without an attemptId is unusable')
})

test('unknown and malformed session events are ignored, not guessed at', () => {
  assert.equal(normalizeDurableEvent(event('session/title', 14, 100, { title: 'x' })).kind, NORMALIZED_KIND.IGNORED)
  assert.equal(normalizeDurableEvent(event('something/unknown', 15, 100, {})).kind, NORMALIZED_KIND.IGNORED)
  assert.equal(normalizeDurableEvent(null).kind, NORMALIZED_KIND.IGNORED)
  assert.equal(normalizeDurableEvent({ type: 42 }).kind, NORMALIZED_KIND.IGNORED)
})
