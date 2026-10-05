/**
 * Phase 9.3 — DSH 0.2.0-rc.2 compatibility layer.
 *
 * The normative runtime moved from `0.1.7-rc.2` to `0.2.0-rc.2` in Phase 9.3.
 * Every declaration this plugin reads was re-audited against the locally
 * installed `0.2.0-rc.2` and against the public reference commit
 * `639ed015397290b3745d163aafe02ffee4aa3f84`, and all fourteen are
 * **byte-identical** to their `0.1.7-rc.2`
 * (`477b4f420553e8a52c2fbccc464d7561b239c443`) form:
 *
 *   `packages/core/session/src/types.ts`
 *   `packages/llm/llm/src/types.ts`
 *   `packages/llm/llm/src/assistant-stream.ts`
 *   `packages/api/session-controller/src/client/contract/events.ts`
 *   `packages/api/session-controller/src/client/session-wire-event.ts`
 *   `packages/api/session-controller/src/client/sessions/assistant-stream.ts`
 *   `packages/api/session-controller/src/client/sessions/session.ts`
 *   `packages/api/session-controller/src/client/contract/session.ts`
 *   `packages/api/session-controller/src/client/contract/snapshot.ts`
 *   `packages/client/ui-conversation/src/client/contract/slots.ts`
 *   `packages/boot/app-boot/src/plugin-compatibility.ts`
 *   `packages/boot/plugin-manager/src/install-spec.ts`
 *   `packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx`
 *   `packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css`
 *
 * `src/dsh/**` therefore moved no code, and the Phase 9.2 metric semantics are
 * untouched. This file is deliberately **narrow**: it does not restate the
 * metric arithmetic or the Phase 7D lifecycle matrix, which
 * `test/dsh-017-*.test.js` already covers and which stays stamped with the
 * 0.1.7 evidence it was recorded on. What it pins is the claim the migration
 * actually makes — the wire evidence the plugin consumes on 0.2.0-rc.2 still
 * has the shape the adapter expects:
 *
 *   SessionEvent envelope    `seq` / `time` / `type` / `data`
 *   turn boundaries          `turn/start`, `turn/end`
 *   settlements              `assistant/message`, `assistant/attempt`
 *   tool plane               `tool/call`, `tool/result`
 *   compact durable stream   `AssistantStreamRecord` `time0` + `dt[]`
 *   stream chunks            `reasoning-delta`, `text-delta`, `tool-call-delta`, `usage`, `finish`
 *   transient retirement     the bare `settle-assistant`
 *   window changes           `replace`, `prepend`, `append`, `settle-assistant`
 *   compatibility metadata   `peerDependencies` pinned exactly
 *
 * Declaration sites for each group are recorded in `docs/DSH_API_NOTES.md` §14.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { createController } from '../src/client/live/controller.js'
import { DEFAULT_PRESENTATION_REFRESH_MS } from '../src/client/live/cadence.js'
import { SessionEventFeed } from '../src/dsh/client-feed.js'
import {
  ATTEMPT_OUTCOME,
  NORMALIZED_KIND,
  SETTLEMENT_KIND,
  TOOL_RESULT_SHAPE,
  decodeStreamRecords,
  normalizeDurableEvent,
  normalizeLiveChunk,
} from '../src/dsh/index.js'
import { createWindowDriver } from './helpers/assistant-stream-fold.js'

const SESSION = 'sess-020-contract'

/** The two reference commits, kept beside the assertions that depend on them. */
const REFERENCE_020 = '639ed015397290b3745d163aafe02ffee4aa3f84'
const REFERENCE_017 = '477b4f420553e8a52c2fbccc464d7561b239c443'

/**
 * One raw durable `SessionEvent` in the 0.2.0 envelope shape:
 * `{ type, seq, time, data }`, with the surface intent alongside it.
 */
function durableEvent(type, seq, time, data, extra = {}) {
  return { type, seq, time, data, ...extra }
}

/** The same event as the window entry the client actually receives. */
function durableEntry(type, seq, time, data, extra = {}) {
  return { type: 'event', event: durableEvent(type, seq, time, data, extra) }
}

/** One client-folded transient row, in the 0.2.0 `AssistantLiveChunkEvent` shape. */
function transientEntry(attemptId, seq, time, chunk, { turn = 1, step = 1 } = {}) {
  return { type: 'transient', event: { type: 'assistant/live-chunk', seq, time, data: { attemptId, turn, step, chunk } } }
}

/**
 * A durable settlement carrying a compact stream, in the 0.2.0 shape:
 * `assistant/message` owns `{ turn, step, message, stream, usage?, interrupted? }`
 * and `assistant/attempt` owns `{ turn, step, stream }`.
 */
function settlementEvent(type, seq, time, { turn = 1, step = 1, stream = [], usage, interrupted } = {}) {
  const data = { turn, step, stream }
  if (type === 'assistant/message') {
    data.message = { id: `msg-${seq}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'ok' }] }
    if (usage !== undefined) data.usage = usage
    if (interrupted === true) data.interrupted = true
  }
  return durableEvent(type, seq, time, data, type === 'assistant/message' ? { surfaceOp: 'append' } : {})
}

/** The window-entry form of {@link settlementEvent}. */
function settlementEntry(type, seq, time, options) {
  return { type: 'event', event: settlementEvent(type, seq, time, options) }
}

// ---------------------------------------------------------------------------
// Compatibility metadata
// ---------------------------------------------------------------------------

test('the DSH peer is pinned exactly to 0.2.0-rc.2, and the package version is the release that carries it', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  /**
   * §8 of the phase contract: exact version only. `^0.2.0-rc.2`,
   * `>=0.2.0-rc.2`, `0.2.x`, `*` and the dual `0.1.7-rc.2 || 0.2.0-rc.2` range
   * are all rejected here. Each of them would admit a runtime this project has
   * never exercised, and the dual range in particular would blur the
   * `v0.1.1 -> 0.1.7-rc.2` / `v0.1.2 -> 0.2.0-rc.2` release boundary.
   */
  const range = manifest.peerDependencies['@deepseek-ai/dsh']
  assert.equal(range, '0.2.0-rc.2')
  assert.deepEqual(Object.keys(manifest.peerDependencies), ['@deepseek-ai/dsh'], 'the DSH peer is the only peer')

  for (const operator of ['^', '~', '>', '<', '*', '||', 'x', 'X', ' - ']) {
    assert.equal(range.includes(operator), false, `the peer must not contain the range syntax ${JSON.stringify(operator)}`)
  }
  assert.match(range, /^\d+\.\d+\.\d+-rc\.\d+$/, 'the peer is an exact prerelease version, not a range')

  // §10: the peer migration itself never moved the version; the version bump
  // belongs to the release round that ships this peer, and the two must stay
  // paired so the published artifact cannot claim a runtime its version does
  // not name.
  assert.equal(manifest.version, '0.1.4', 'the release round carries the version paired with the 0.2.0-rc.2 peer')
})

// ---------------------------------------------------------------------------
// SessionEvent envelope and turn boundaries
// ---------------------------------------------------------------------------

test('the SessionEvent envelope is read as seq/time/type/data, not as a flattened payload', () => {
  const row = durableEvent('turn/start', 7, 1700000000000, { turn: 3 })
  const normalized = normalizeDurableEvent(row)
  assert.equal(normalized.kind, NORMALIZED_KIND.TURN_START)
  assert.equal(normalized.turn, 3)
  assert.equal(normalized.seq, 7, 'seq comes from the envelope')
  assert.equal(normalized.timeMs, 1700000000000, 'time comes from the envelope')

  /**
   * The counter-shape: the payload is `data`, so a `turn` sitting at the top
   * level of the row is not the event's turn. A reader that flattened the
   * envelope would answer 99 here.
   */
  const misplaced = durableEvent('turn/start', 8, 1, { turn: 3 })
  misplaced.turn = 99
  assert.equal(normalizeDurableEvent(misplaced).turn, 3)

  assert.equal(normalizeDurableEvent(durableEvent('turn/start', 9, 1, {})).turn, undefined)
  assert.equal(normalizeDurableEvent('turn/start').kind, NORMALIZED_KIND.IGNORED)
  assert.equal(normalizeDurableEvent({ type: 'turn/start', seq: 1 }).kind, NORMALIZED_KIND.TURN_START)
})

test('turn/start and turn/end are recognized, and the end reason is read from data.reason', () => {
  const start = normalizeDurableEvent(durableEvent('turn/start', 1, 1000, { turn: 1 }))
  assert.equal(start.kind, NORMALIZED_KIND.TURN_START)
  assert.equal(start.timeMs, 1000)

  const end = normalizeDurableEvent(durableEvent('turn/end', 60, 9000, { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(end.kind, NORMALIZED_KIND.TURN_END)
  assert.equal(end.status, 'completed')
  assert.equal(end.reasonKind, 'completed')
  assert.equal(end.statusKnown, true)
  assert.equal(end.timeMs, 9000)

  const maxTokens = normalizeDurableEvent(durableEvent('turn/end', 61, 9001, { turn: 1, reason: { kind: 'max-tokens' } }))
  assert.equal(maxTokens.status, 'completed')
  assert.match(maxTokens.note, /truncated/)

  /** A reason kind outside the frozen vocabulary is not reported as a known cause. */
  const unknown = normalizeDurableEvent(durableEvent('turn/end', 62, 9002, { turn: 1, reason: { kind: 'invented-later' } }))
  assert.equal(unknown.statusKnown, false)
  assert.equal(unknown.status, 'errored')
  assert.equal(unknown.rawReason.kind, 'invented-later')
})

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

test('assistant/message and assistant/attempt are both settlements, separated by settlement kind rather than by shape', () => {
  const message = normalizeDurableEvent(settlementEvent('assistant/message', 10, 5000, {
    stream: [{ type: 'text-chunks', time0: 4000, index: 0, dt: [1000], texts: ['ok'] }],
  }))
  assert.equal(message.kind, NORMALIZED_KIND.ATTEMPT_SETTLE)
  assert.equal(message.eventType, 'assistant/message')
  assert.equal(message.settlementKind, SETTLEMENT_KIND.MESSAGE)
  assert.equal(message.surfaceCommitted, true)
  assert.equal(message.attemptOutcome, ATTEMPT_OUTCOME.COMMITTED)
  assert.equal(message.interrupted, false)

  const attempt = normalizeDurableEvent(settlementEvent('assistant/attempt', 11, 6000, {
    stream: [{ type: 'text-chunks', time0: 5500, index: 0, dt: [500], texts: ['partial'] }],
  }))
  assert.equal(attempt.kind, NORMALIZED_KIND.ATTEMPT_SETTLE)
  assert.equal(attempt.eventType, 'assistant/attempt')
  assert.equal(attempt.settlementKind, SETTLEMENT_KIND.ATTEMPT)
  assert.equal(attempt.surfaceCommitted, false)
  /**
   * A durable non-surface settlement is **not** an abandonment — abandonment is
   * the transient condition of having no durable settlement at all.
   */
  assert.equal(attempt.attemptOutcome, ATTEMPT_OUTCOME.UNKNOWN)
})

test('an interrupted assistant/message finalizes its delivered prefix and carries no undispatched tool call', () => {
  const stream = [
    { type: 'reasoning-chunks', time0: 1000, index: 0, dt: [50, 60], texts: ['a', 'b', 'c'] },
    { type: 'chunk', time: 1120, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ]
  const normalized = normalizeDurableEvent(settlementEvent('assistant/message', 12, 7000, { stream, interrupted: true }))
  assert.equal(normalized.settlementKind, SETTLEMENT_KIND.MESSAGE)
  assert.equal(normalized.surfaceCommitted, true)
  assert.equal(normalized.attemptOutcome, ATTEMPT_OUTCOME.INTERRUPTED)
  assert.equal(normalized.interrupted, true)
  assert.equal(normalized.decoded.chunks.length, 4, 'the delivered prefix is intact')
  assert.equal(normalized.decoded.chunks.filter(entry => entry.chunk.type === 'tool-call-delta').length, 0)
})

// ---------------------------------------------------------------------------
// Tool plane
// ---------------------------------------------------------------------------

test('tool/call and tool/result keep the 0.2.0 tool-role message as the sole identity site', () => {
  const call = normalizeDurableEvent(durableEvent('tool/call', 20, 1000, {
    turn: 1, step: 1, callId: 'call_a', name: 'pwsh', arguments: '{"command":"ls"}',
  }))
  assert.equal(call.kind, NORMALIZED_KIND.TOOL_CALL)
  assert.equal(call.callId, 'call_a')
  assert.equal(call.name, 'pwsh')
  assert.equal(call.argumentsRaw, '{"command":"ls"}')
  assert.equal(call.timeMs, 1000)

  const ok = normalizeDurableEvent(durableEvent('tool/result', 21, 2000, {
    turn: 1,
    step: 1,
    message: { id: 'r1', role: 'tool', toolCallId: 'call_a', source: { kind: 'tool' }, content: [{ type: 'text', text: 'a.txt' }] },
  }))
  assert.equal(ok.kind, NORMALIZED_KIND.TOOL_RESULT)
  assert.equal(ok.callId, 'call_a')
  assert.equal(ok.callIdSource, TOOL_RESULT_SHAPE.TOOL_MESSAGE)
  assert.equal(ok.status, 'ok')
  assert.equal(ok.malformed, false)
  assert.equal(ok.timeMs, 2000, 'a tool/result carries no timestamp of its own; the envelope supplies it')

  const failed = normalizeDurableEvent(durableEvent('tool/result', 22, 2100, {
    turn: 1,
    step: 1,
    message: { id: 'r2', role: 'tool', toolCallId: 'call_b', source: { kind: 'tool' }, isError: true, content: [] },
    error: { name: 'ToolFailure', code: 'E_TOOL', reason: 'nope' },
  }))
  assert.equal(failed.status, 'error')
  assert.equal(failed.errorName, 'ToolFailure')
  assert.equal(failed.errorCode, 'E_TOOL')

  /**
   * Fail closed: a tool-role message whose identity cannot be read is malformed
   * and closes no call. `content[0].toolCallId` is not a fallback for a message
   * that declares its own role, so this case cannot be repaired by position.
   */
  const malformed = normalizeDurableEvent(durableEvent('tool/result', 23, 2200, {
    turn: 1,
    step: 1,
    message: { id: 'r3', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'x', toolCallId: 'call_c' }] },
  }))
  assert.equal(malformed.callId, null)
  assert.equal(malformed.callIdSource, TOOL_RESULT_SHAPE.MALFORMED)
  assert.equal(malformed.malformed, true)
})

// ---------------------------------------------------------------------------
// Transient live rows
// ---------------------------------------------------------------------------

test('the client-folded assistant/live-chunk row is still the transient shape the live path consumes', () => {
  const normalized = normalizeLiveChunk(transientEntry('attempt-1', 31, 1200, { type: 'reasoning-delta', index: 0, text: 'think' }))
  assert.equal(normalized.kind, NORMALIZED_KIND.ATTEMPT_DELTA)
  assert.equal(normalized.attemptId, 'attempt-1')
  assert.equal(normalized.timeMs, 1200, 'time sits on the row, not on data')
  assert.equal(normalized.turn, 1)
  assert.equal(normalized.step, 1)
  assert.equal(normalized.phase, 'reasoning')
  assert.equal(normalized.countsAsToken, true)

  /** A live row is only usable when `data.attemptId` is a string. */
  const anonymous = normalizeLiveChunk({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 1, time: 1, data: { chunk: {} } } })
  assert.equal(anonymous.kind, NORMALIZED_KIND.IGNORED)
  assert.equal(normalizeLiveChunk(durableEntry('turn/start', 1, 1, { turn: 1 })).kind, NORMALIZED_KIND.IGNORED)
})

// ---------------------------------------------------------------------------
// Compact durable stream: AssistantStreamRecord timing and dt reconstruction
// ---------------------------------------------------------------------------

test('AssistantStreamRecord reconstructs exact per-delta timestamps from time0 plus the dt gaps', () => {
  const decoded = decodeStreamRecords([
    { type: 'reasoning-chunks', time0: 1000, index: 0, dt: [40, 60], texts: ['a', 'b', 'c'] },
    { type: 'text-chunks', time0: 1200, index: 1, dt: [10], texts: ['x', 'y'] },
    { type: 'tool-call-chunks', time0: 1300, index: 2, dt: [5], id: 'call_a', name: 'pwsh', args: ['{"a"', ':1}'] },
  ])
  assert.equal(decoded.complete, true)
  assert.deepEqual(decoded.chunks.map(entry => entry.timeMs), [1000, 1040, 1100, 1200, 1210, 1300, 1305])

  const kinds = decoded.chunks.map(entry => entry.chunk.type)
  assert.deepEqual(kinds, [
    'reasoning-delta', 'reasoning-delta', 'reasoning-delta',
    'text-delta', 'text-delta',
    'tool-call-delta', 'tool-call-delta',
  ])

  const call = decoded.chunks[5].chunk
  assert.equal(call.id, 'call_a', 'the run id is the tool-call identity')
  assert.equal(call.name, 'pwsh')
  assert.equal(call.argumentsDelta, '{"a"')

  /**
   * `dt.length === members.length - 1` is the invariant DSH validates before
   * writing a run. A run that breaks it is reported rather than silently
   * resynchronized, so the curve degrades in quality instead of inventing a
   * boundary.
   */
  const broken = decodeStreamRecords([{ type: 'text-chunks', time0: 1000, index: 0, dt: [10, 10, 10], texts: ['a', 'b'] }])
  assert.equal(broken.complete, false)
  assert.equal(broken.chunks.length, 0)
  assert.deepEqual(broken.issues.map(issue => issue.kind), ['bad-dt'])
})

// ---------------------------------------------------------------------------
// StreamChunk variants
// ---------------------------------------------------------------------------

test('every consumed StreamChunk variant survives decoding, and only the generated ones become samples', () => {
  const stream = [
    { type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [10], texts: ['r1', 'r2'] },
    { type: 'chunk', time: 1030, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'r1r2' } } },
    { type: 'text-chunks', time0: 1040, index: 1, dt: [10], texts: ['t1', 't2'] },
    { type: 'tool-call-chunks', time0: 1060, index: 2, dt: [], id: 'call_a', name: 'pwsh', args: ['{"command":"ls"}'] },
    { type: 'chunk', time: 1070, chunk: { type: 'usage', usage: { inputTokens: 11, outputTokens: 22, reasoningTokens: 7 } } },
    { type: 'chunk', time: 1080, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ]
  const decoded = decodeStreamRecords(stream)
  assert.equal(decoded.complete, true)
  assert.equal(decoded.recordCount, 7)

  const kinds = decoded.chunks.map(entry => entry.chunk.type)
  for (const required of ['reasoning-delta', 'text-delta', 'tool-call-delta', 'usage', 'finish', 'block-start', 'block-end']) {
    assert.ok(kinds.includes(required), `the decoded stream must still carry ${required}`)
  }

  /** Every non-delta chunk survives as a raw record carrying its own envelope time. */
  const usage = decoded.chunks.find(entry => entry.chunk.type === 'usage')
  assert.equal(usage.timeMs, 1070)
  assert.equal(usage.chunk.usage.outputTokens, 22)
  assert.equal(usage.chunk.usage.reasoningTokens, 7)
  assert.equal(decoded.chunks.find(entry => entry.chunk.type === 'finish').timeMs, 1080)

  /** The generated set is the delta set: a usage or finish chunk is not a token. */
  assert.equal(decoded.generatedChunkCount, 5, 'reasoning x2, text x2, tool-call x1')
  assert.equal(decoded.firstTokenTimeMs, 1010)
})

test('in-stream usage is a first-class estimator input, and a durable usage supersedes it', () => {
  const stream = [
    { type: 'text-chunks', time0: 1000, index: 0, dt: [100], texts: ['a', 'b'] },
    { type: 'chunk', time: 1200, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 41 } } },
    { type: 'chunk', time: 1210, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ]

  const inStream = normalizeDurableEvent(settlementEvent('assistant/attempt', 40, 1300, { stream }))
  assert.deepEqual(inStream.usage, { inputTokens: 3, outputTokens: 41 })
  assert.equal(inStream.usageSource, 'in-stream-usage-chunk')

  const durable = normalizeDurableEvent(settlementEvent('assistant/message', 41, 1300, {
    stream,
    usage: { inputTokens: 3, outputTokens: 99 },
  }))
  assert.equal(durable.usageSource, 'assistant-settlement', 'the durable settlement usage is authoritative')
  assert.equal(durable.usage.outputTokens, 99)

  /**
   * A provider that emits no in-stream usage is **not** a compatibility failure:
   * the shape-weight fallback is part of the design, so the attempt still decodes
   * and still yields generated samples with no usage attached.
   */
  const noUsage = normalizeDurableEvent(settlementEvent('assistant/attempt', 42, 1400, {
    stream: [{ type: 'text-chunks', time0: 1000, index: 0, dt: [100], texts: ['a', 'b'] }],
  }))
  assert.equal(noUsage.usage, null)
  assert.equal(noUsage.usageSource, null)
  assert.equal(noUsage.decoded.generatedChunkCount, 2)
})

// ---------------------------------------------------------------------------
// Window changes
// ---------------------------------------------------------------------------

test('all four SessionEventChange kinds are routed: replace, prepend, append and settle-assistant', () => {
  const feed = new SessionEventFeed({ sessionId: SESSION, onEvent: () => {} })

  feed.applyWindow({ entries: [], revision: 1, change: { kind: 'replace', entries: [] } })
  assert.equal(feed.initialized, true)

  feed.applyWindow({ entries: [], revision: 2, change: { kind: 'append', entries: [durableEntry('turn/start', 1, 1000, { turn: 1 })] } })
  assert.equal(feed.openTurn, 1)

  /** `prepend` is older history: counted and never guessed at. */
  feed.applyWindow({ entries: [], revision: 3, change: { kind: 'prepend', entries: [durableEntry('turn/start', 0, 500, { turn: 0 })] } })
  assert.equal(feed.ignoredPrepends, 1)
  assert.equal(feed.openTurn, 1, 'a prepend must not adopt an older turn')

  /** `replace` is a rebaseline: the whole generation state is dropped. */
  feed.applyWindow({ entries: [], revision: 4, change: { kind: 'replace', entries: [] } })
  assert.equal(feed.openTurn, null)
  assert.equal(feed.highestTurn, null)
  assert.equal(feed.retainedTurnCount(), 0)

  /** A stale revision is inert whatever its change kind. */
  feed.applyWindow({ entries: [], revision: 2, change: { kind: 'append', entries: [durableEntry('turn/start', 9, 1, { turn: 9 })] } })
  assert.equal(feed.openTurn, null)

  assert.deepEqual(feed.issues, [], 'every 0.2.0 change kind is understood')
  assert.equal(feed.counters.unknownEvents ?? 0, 0)
})

test('a bare settle-assistant is resolved from held evidence: retirement after a durable settlement, abandonment without one', () => {
  const retirement = new SessionEventFeed({ sessionId: SESSION, onEvent: () => {} })
  const events = []
  retirement.onEvent = event => events.push(event)

  retirement.applyWindow({
    entries: [transientEntry('attempt-1', 1, 1100, { type: 'text-delta', index: 0, text: 'x' })],
    revision: 1,
    change: { kind: 'replace', entries: [] },
  })
  retirement.applyWindow({
    entries: [],
    revision: 2,
    change: {
      kind: 'append',
      entries: [settlementEntry('assistant/message', 4, 1500, {
        stream: [{ type: 'text-chunks', time0: 1400, index: 0, dt: [100], texts: ['x'] }],
      })],
    },
  })
  events.length = 0

  retirement.applyWindow({ entries: [], revision: 3, change: { kind: 'settle-assistant', attemptId: 'attempt-1' } })
  assert.equal(retirement.counters.bareSettleSeen, 1)
  assert.equal(retirement.counters.retirementsResolved, 1)
  assert.equal(retirement.counters.abandonmentsResolved, 0)
  assert.deepEqual(events, [], 'a retirement publishes no second attempt outcome')
  assert.deepEqual(retirement.issues, [])

  const abandonment = new SessionEventFeed({ sessionId: SESSION, onEvent: () => {} })
  const abandoned = []
  abandonment.onEvent = event => abandoned.push(event)
  abandonment.applyWindow({
    entries: [transientEntry('attempt-2', 1, 1100, { type: 'text-delta', index: 0, text: 'x' })],
    revision: 1,
    change: { kind: 'replace', entries: [] },
  })
  abandoned.length = 0
  abandonment.applyWindow({ entries: [], revision: 2, change: { kind: 'settle-assistant', attemptId: 'attempt-2' } })

  assert.equal(abandonment.counters.abandonmentsResolved, 1)
  const outcome = abandoned.filter(event => event.attemptId === 'attempt-2')
  assert.equal(outcome.length, 1)
  assert.equal(outcome[0].kind, NORMALIZED_KIND.ATTEMPT_ABANDON)
  assert.equal(outcome[0].attemptOutcome, ATTEMPT_OUTCOME.ABANDONED)
  assert.equal(outcome[0].settlementKind, SETTLEMENT_KIND.NONE)
})

test('a settle-assistant carrying its entry is a direct settlement, and the durable seq it carries is admitted once', () => {
  const feed = new SessionEventFeed({ sessionId: SESSION, onEvent: () => {} })
  feed.applyWindow({ entries: [], revision: 1, change: { kind: 'replace', entries: [] } })

  const entry = settlementEntry('assistant/attempt', 5, 1500, {
    stream: [{ type: 'text-chunks', time0: 1400, index: 0, dt: [100], texts: ['x'] }],
  })
  feed.applyWindow({ entries: [], revision: 2, change: { kind: 'settle-assistant', attemptId: 'attempt-3', entry } })
  assert.equal(feed.counters.settlementsWithEntry, 1)
  assert.equal(feed.settledAttemptIds.has('attempt-3'), true)
  assert.equal(feed.turnEvents(1).length, 1, 'the entry is retained for reconstruction')

  feed.applyWindow({ entries: [entry], revision: 3, change: { kind: 'append', entries: [entry] } })
  assert.equal(feed.turnEvents(1).length, 1, 'the same seq delivered twice is retained once')
  assert.ok(feed.issues.some(issue => issue.kind === 'duplicate-durable-event'))
})

// ---------------------------------------------------------------------------
// End-to-end: one 0.2.0-shaped turn
// ---------------------------------------------------------------------------

/** One settled turn's column, or `undefined` when the card does not carry it. */
function column(view, key) {
  return view.columns.find(entry => entry.key === key)
}

/**
 * Drive one session through the real controller with 0.2.0-shaped evidence. The
 * window driver reproduces `MutableSessionEventSource`; the fold that produces
 * `settle-assistant` changes is the ported `ClientAssistantStream` algebra,
 * unchanged between the two reference commits.
 */
function harness() {
  const driver = createWindowDriver()
  const sessions = {
    binding: () => ({ eventSource: { getSnapshot: driver.getSnapshot, subscribe: driver.subscribe } }),
  }
  const controller = createController({ sessions })
  assert.equal(controller.attach(SESSION), true)
  return {
    driver,
    controller,
    project: atMs => controller.project(SESSION, atMs),
    diagnostics: () => controller.diagnostics(SESSION),
    dispose: () => controller.dispose(),
  }
}

test('an idle session with an empty 0.2.0-shaped window shows no live meter', () => {
  const h = harness()
  assert.equal(h.project(1000).kind, 'hidden')
  h.dispose()
})

test('one 0.2.0-shaped turn goes live on its first generated delta and settles to the completed card', () => {
  const h = harness()

  h.driver.append(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(durableEntry('step/start', 2, 1010, { turn: 1, step: 1 }))

  /**
   * An open turn with no generated token yet shows the first-response timer, not
   * a rate: `tps` is absent rather than zero-forged.
   */
  const waiting = h.project(1010)
  assert.equal(waiting.kind, 'ttft')
  assert.equal(waiting.turn, 1)
  assert.equal(waiting.tps, undefined)

  h.driver.append(transientEntry('attempt-1', 3, 1050, { type: 'block-start', index: 0, blockType: 'reasoning' }))
  assert.equal(h.project(1050).kind, 'ttft', 'a block boundary is not a generated token')

  h.driver.append(transientEntry('attempt-1', 4, 1100, { type: 'reasoning-delta', index: 0, text: 'thinking' }))
  const warming = h.project(1100)
  assert.equal(warming.kind, 'warming', 'one sample is below the three-sample gate, so the counter is shown')
  assert.equal(warming.tps, undefined)

  h.driver.append(transientEntry('attempt-1', 5, 1200, { type: 'reasoning-delta', index: 0, text: ' harder' }))
  h.driver.append(transientEntry('attempt-1', 6, 1250, { type: 'reasoning-delta', index: 0, text: ' more' }))
  const live = h.project(1300)
  assert.equal(live.kind, 'streaming')
  assert.equal(live.turn, 1)
  assert.equal(live.phase, 'reasoning')
  assert.ok(Number.isFinite(live.tps) && live.tps > 0, 'the phase-cumulative rate is finite once three samples exist')

  // The attempt settles with a durable assistant/message carrying its compact stream.
  const stream = [
    { type: 'chunk', time: 1050, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'reasoning-chunks', time0: 1100, index: 0, dt: [100, 50], texts: ['thinking', ' harder', ' more'] },
    { type: 'chunk', time: 1250, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 30 } } },
    { type: 'chunk', time: 1260, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ]
  h.driver.append(settlementEntry('assistant/message', 7, 1300, { stream, usage: { inputTokens: 12, outputTokens: 30 } }))
  h.driver.append(durableEntry('step/end', 8, 1320, { turn: 1, step: 1 }))
  h.driver.append(durableEntry('turn/end', 9, 1400, { turn: 1, reason: { kind: 'completed' } }))

  const settled = h.project(2000)
  assert.equal(settled.kind, 'completed')
  assert.equal(settled.turn, 1)
  assert.equal(settled.status, 'completed')
  assert.equal(settled.attemptCount, 1)
  assert.equal(column(settled, 'generatedTokens').value, 30)
  assert.equal(column(settled, 'generatedTokens').quality, 'exact')
  assert.ok(Number.isFinite(column(settled, 'reasoningTps').value))
  assert.ok(Number.isFinite(column(settled, 'ttft').value))
  assert.equal(column(settled, 'outputTps').available, false, 'no text was generated, so output TPS is unavailable rather than zero')
  assert.notEqual(settled.curve, null, 'the settled card carries its throughput curve')

  assert.equal(h.diagnostics().counters.turnEndLookupMiss, 0, 'the opening turn/start was inside the window')
  assert.deepEqual(h.diagnostics().feedIssues, [])

  h.dispose()
})

test('the live presentation cadence stays at 100 ms under the new runtime', () => {
  /**
   * §14 of the phase contract: the migration changes the runtime, not the Phase
   * 9.2 presentation contract. The cadence is a presentation bound and has no
   * relationship to the DSH version.
   */
  assert.equal(DEFAULT_PRESENTATION_REFRESH_MS, 100)
})

test('both reference commits are named where the compatibility claim is made', () => {
  /**
   * The claim recorded in `docs/DSH_API_NOTES.md` §14 is a comparison between
   * two commits, so both are pinned here. A future edit that changes one without
   * re-running the comparison fails rather than passing silently.
   */
  assert.equal(REFERENCE_020, '639ed015397290b3745d163aafe02ffee4aa3f84')
  assert.equal(REFERENCE_017, '477b4f420553e8a52c2fbccc464d7561b239c443')
  assert.notEqual(REFERENCE_020, REFERENCE_017)
})
