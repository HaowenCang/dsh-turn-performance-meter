/**
 * Phase 7D — the authoritative DSH 0.1.7-rc.2 fixture corpus.
 *
 * `fixtures/dsh-0.1.7/` holds captures recorded on the real 0.1.7-rc.2 host with
 * `dev/fixture-recorder`, which records both evidence planes verbatim:
 *
 *   durable    `session/event`               — the append-only session log
 *   transient  `agent/assistant-stream`      — process-local stream frames
 *
 * The legacy corpus under `fixtures/dsh-turns/` was recorded on 0.1.5-rc.2 and
 * still proves the metric arithmetic, but it cannot prove the `tool/result`
 * shape, the `settle-assistant` semantics or the completion lifecycle: its
 * tool results are `user`-role messages carrying `content[0].toolCallId`, a
 * shape 0.1.7 no longer produces. These tests therefore run against the new
 * corpus, and every call/result pair is asserted **by identity** (§13, §38).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { accumulateLive } from '../src/dsh/index.js'
import { TOOL_RESULT_SHAPE, normalizeDurableEvent } from '../src/dsh/adapter.js'
import { reconstructFromDurable } from '../src/dsh/durable-path.js'
import { createController } from '../src/client/live/controller.js'
import { listTargetFixtures, loadTargetFixture } from './helpers/fixtures.js'
import { fixtureEntries } from './helpers/live-replay.js'

const FIXTURE = 't01-sequential-tools'

/** Durable `SessionEvent` rows of one fixture, in recorded order. */
function durableEvents(fixture) {
  return fixture.durable.map(row => row.event)
}

test('the target corpus is versioned, and every capture declares its provenance', () => {
  const names = listTargetFixtures()
  assert.ok(names.includes(FIXTURE), `expected ${FIXTURE} in fixtures/dsh-0.1.7/`)
  for (const name of names) {
    const fixture = loadTargetFixture(name)
    assert.equal(fixture.dshVersion, '0.1.7-rc.2', `${name}: the corpus is 0.1.7-rc.2 evidence`)
    assert.equal(fixture.captureFamily, '0.1.7')
    assert.ok(typeof fixture.capturedAt === 'string' && fixture.capturedAt.length > 0, `${name}: capture date`)
    assert.ok(typeof fixture.scenario === 'string' && fixture.scenario.length > 0, `${name}: scenario`)
    assert.ok(Array.isArray(fixture.durable) && fixture.durable.length > 0, `${name}: durable plane present`)
    assert.ok(Array.isArray(fixture.transient) && fixture.transient.length > 0, `${name}: transient plane present`)
  }
})

test('every recorded tool result uses the 0.1.7 tool-role message shape', () => {
  const fixture = loadTargetFixture(FIXTURE)
  const results = durableEvents(fixture).filter(event => event.type === 'tool/result')
  assert.ok(results.length > 0, 'the fixture must contain tool results to be evidence about them')

  for (const event of results) {
    const message = event.data.message
    assert.equal(message.role, 'tool', 'the result is a first-class tool-role message')
    assert.equal(typeof message.toolCallId, 'string', 'the call identity is a message field')
    assert.equal(typeof message.isError, 'boolean', 'the failure flag is a message field')
    assert.ok(Array.isArray(message.content), 'the content blocks are the result content')
    for (const block of message.content) {
      assert.equal(block.toolCallId, undefined, 'a content block never owns the call identity in 0.1.7')
      assert.equal(block.isError, undefined, 'a content block never owns the failure flag in 0.1.7')
    }
    const normalized = normalizeDurableEvent(event)
    assert.equal(normalized.callId, message.toolCallId, 'the adapter reads the identity from the message')
    assert.equal(normalized.callIdSource, TOOL_RESULT_SHAPE.TOOL_MESSAGE)
    assert.equal(normalized.status, message.isError ? 'error' : 'ok')
  }
})

test('every tool call pairs with exactly one result, by identity', () => {
  const fixture = loadTargetFixture(FIXTURE)
  const events = durableEvents(fixture)
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')

  assert.ok(calls.length >= 2, 'the scenario is a sequential multi-call turn')
  assert.equal(results.length, calls.length, '§38: every call in a normally completed turn has one result')

  const byCallId = new Map(calls.map(event => [event.data.callId, event]))
  for (const event of results) {
    const callId = event.data.message.toolCallId
    const call = byCallId.get(callId)
    assert.ok(call !== undefined, `result ${event.seq} names a call the log contains`)
    /**
     * The pairing is by identity and by nothing else: same turn and step, and
     * the result is strictly later in the log than the call it answers. Position
     * within the step, tool name and content are all explicitly not the key.
     */
    assert.equal(event.data.turn, call.data.turn)
    assert.equal(event.data.step, call.data.step)
    assert.ok(event.seq > call.seq, 'the result follows its call in the durable log')
    byCallId.delete(callId)
  }
  assert.equal(byCallId.size, 0, 'no call is left without a result')
})

test('the fixture is a normally completed turn with a durable turn/end row', () => {
  const fixture = loadTargetFixture(FIXTURE)
  const events = durableEvents(fixture)
  const turnEnd = events.filter(event => event.type === 'turn/end')
  assert.equal(turnEnd.length, 1)
  assert.equal(turnEnd[0].data.turn, 1)
  assert.equal(turnEnd[0].data.reason.kind, 'completed')
  assert.equal(fixture.summary.turnEndReasons[0], 'completed')
  // §23: 0.1.7 still has `turn/end`, and this capture is the local proof.
  assert.ok(turnEnd[0].seq > events.find(event => event.type === 'turn/start').seq)
})

test('replaying the target fixture leaves no unmatched result and no running call', () => {
  const fixture = loadTargetFixture(FIXTURE)

  /**
   * Path A: the transient plane plus the durable boundaries, with settlements
   * carrying only identity and usage. This is the same fold the browser applies.
   */
  const accumulator = accumulateLive({
    sessionId: fixture.sessionId,
    frames: fixture.transient.map(row => row.frame),
    durableEvents: durableEvents(fixture),
    settlements: [],
  })

  const tools = accumulator.toolList()
  assert.ok(tools.length > 0)
  assert.equal(
    accumulator.issues.filter(issue => issue.kind === 'unmatched-tool-result').length,
    0,
    'unmatchedToolResults == 0',
  )
  assert.equal(
    tools.filter(call => call.endMs === undefined || call.endMs === null).length,
    0,
    'runningToolCount == 0',
  )
  assert.equal(tools.every(call => Number.isFinite(call.endMs)), true, 'record.tools.every(endMs finite)')
  assert.equal(accumulator.turnEndMs !== null, true, 'the turn end boundary was observed')
  assert.equal(accumulator.status, 'completed')
})

test('replaying the target fixture through the controller ends settled, with no live pill', () => {
  const fixture = loadTargetFixture(FIXTURE)
  const entries = fixtureEntries(fixture)
  const listeners = new Set()
  let window = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  const source = {
    getSnapshot: () => window,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const controller = createController({ sessions: { binding: () => ({ eventSource: source }) } })
  assert.equal(controller.attach(fixture.sessionId), true)

  let revision = 1
  const lastTime = entries.length > 0 ? Math.max(...entries.map(e => e.event?.time ?? 0)) : 0
  const views = []
  for (const entry of entries) {
    window = { entries: [...window.entries, entry], hasMore: false, revision: (revision += 1), change: { kind: 'append', entries: [entry] } }
    for (const listener of [...listeners]) listener()
    views.push(controller.project(fixture.sessionId, lastTime))
  }

  const final = views[views.length - 1]
  assert.equal(final.kind, 'completed', 'a normally completed 0.1.7 turn projects the card')
  assert.equal(final.status, 'completed')
  assert.equal(final.tools.count, 2, 'the historical tool count is the recorded call count')
  assert.equal(final.tools.completedCount, 2, 'both calls carry a result, so neither is left incomplete')
  assert.equal(final.tools.failedCount, 0)
  assert.equal(final.attemptCount, 3, 'model -> tool -> model -> tool -> model')

  const diagnostics = controller.diagnostics(fixture.sessionId)
  assert.equal(diagnostics.counters.rawTurnEndSeen, 1)
  assert.equal(diagnostics.counters.normalizedTurnEndSeen, 1)
  assert.equal(diagnostics.counters.turnEndLookupMiss, 0)
  assert.equal(diagnostics.counters.storeEndTurnCalled, 1)
  assert.equal(diagnostics.counters.presenterTurnEndApplied, 1)
  assert.equal(diagnostics.counters.malformedToolResults, 0)
  assert.equal(diagnostics.unmatchedToolResults, 0)
  assert.equal(diagnostics.liveRunningTools, 0, 'no call is left running at the end of a completed turn')

  /**
   * §26: once the turn is settled, later evidence must not resurrect it. The
   * recorded planes are re-delivered after the fact, and the projection stays
   * the card.
   */
  for (const entry of entries.slice(-6)) {
    window = { entries: window.entries, hasMore: false, revision: (revision += 1), change: { kind: 'append', entries: [entry] } }
    for (const listener of [...listeners]) listener()
  }
  const after = controller.project(fixture.sessionId, lastTime + 5000)
  assert.equal(after.kind, 'completed', 'late evidence cannot turn a settled turn live again')
  assert.equal(controller.diagnostics(fixture.sessionId).liveRunningTools, 0)
  controller.dispose()
})

test('the durable reconstruction path pairs 0.1.7 results through the same contract site', () => {
  /**
   * §38 through path B. This is the regression that matters most for the 0.1.7
   * migration, because the identical `content[0].toolCallId` expression existed
   * in **two** files — `src/dsh/adapter.js` (the live path) and
   * `src/dsh/durable-path.js` (this one) — and fixing only the first would have
   * left every durable reconstruction unable to pair a single 0.1.7 result while
   * the live path paired all of them. The two now share one exported contract
   * site, and this test fails if that ever splits again.
   */
  const fixture = loadTargetFixture(FIXTURE)
  const built = reconstructFromDurable({
    sessionId: fixture.sessionId,
    turn: 1,
    events: durableEvents(fixture),
  })

  assert.equal(built.tools.length, 2, 'both calls were reconstructed')
  assert.equal(
    built.issues.filter(issue => issue.kind === 'tool-result-without-call-id').length,
    0,
    'no 0.1.7 result was rejected for lacking a call identity',
  )
  assert.equal(built.issues.filter(issue => issue.kind === 'unmatched-tool-result').length, 0)
  assert.equal(built.issues.filter(issue => issue.kind === 'unmatched-tool-call').length, 0)
  assert.equal(built.tools.every(call => Number.isFinite(call.endMs)), true)
  assert.equal(built.tools.every(call => call.status === 'ok'), true)
  assert.equal(built.status, 'completed')

  /**
   * The same event read by both paths must agree field for field: one contract,
   * one answer.
   */
  const result = durableEvents(fixture).find(event => event.type === 'tool/result')
  const viaAdapter = normalizeDurableEvent(result)
  const viaDurable = reconstructFromDurable({ sessionId: 'x', turn: 1, events: [result] })
  assert.equal(viaDurable.issues[0].kind, 'unmatched-tool-result', 'the call was not in this one-event log')
  assert.equal(viaDurable.issues[0].callId, viaAdapter.callId, 'both paths resolve the same identity')
  assert.equal(viaDurable.issues[0].callIdSource, undefined)
  assert.equal(viaAdapter.callIdSource, TOOL_RESULT_SHAPE.TOOL_MESSAGE)
})

test('the transient plane carries three attempts, each bounded by a start and an end frame', () => {
  const fixture = loadTargetFixture(FIXTURE)
  const frames = fixture.transient.map(row => row.frame)
  const starts = frames.filter(frame => frame.type === 'start')
  const ends = frames.filter(frame => frame.type === 'end')
  assert.equal(starts.length, 3, 'model -> tool -> model -> tool -> model')
  assert.equal(ends.length, 3)
  for (const frame of ends) {
    assert.equal(frame.outcome.kind, 'committed', 'every attempt in this capture committed a surface message')
    assert.equal(frame.outcome.eventType, 'assistant/message')
  }
  /**
   * Each attempt's settled seq names a real durable `assistant/message` row of
   * the same turn and step: that is the link the browser's fold uses to retain
   * and later retire an attempt, and it must be intact in the capture.
   */
  const settlements = durableEvents(fixture).filter(event => event.type === 'assistant/message')
  const settlementSeqs = new Set(settlements.map(event => event.seq))
  for (const frame of ends) {
    assert.ok(settlementSeqs.has(frame.outcome.seq), `end frame names durable seq ${frame.outcome.seq}`)
  }
})
