/**
 * Phase 7D — turn completion, terminality and the 0.1.7 reason vocabulary.
 *
 * These are the properties §26–§28, §35–§39 freeze. They are stated against the
 * normalized vocabulary and the real controller, so they hold for any transport
 * that produces the same evidence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { NORMALIZED_KIND, turnEndStatus } from '../src/dsh/index.js'
import { SessionEventFeed } from '../src/dsh/client-feed.js'
import { createWindowDriver } from './helpers/assistant-stream-fold.js'

const SESSION = 'sess-017-completion'

const EVENT = (type, seq, time, data) => ({ type: 'event', event: { type, seq, time, data, surfaceOp: 'append' } })
const TRANSIENT = (attemptId, time, chunk, { turn = 1, step = 1 } = {}) => ({
  type: 'transient',
  event: { type: 'assistant/live-chunk', seq: time, time, data: { attemptId, turn, step, chunk } },
})
const DELTA = { type: 'text-delta', index: 0, text: 'x' }

function harness() {
  const driver = createWindowDriver()
  const sessions = { binding: () => ({ eventSource: { getSnapshot: driver.getSnapshot, subscribe: driver.subscribe } }) }
  const controller = createController({ sessions })
  assert.equal(controller.attach(SESSION), true)
  return {
    driver,
    controller,
    record: turn => controller.store.turns.get(`${SESSION}::${turn}`),
    project: atMs => controller.project(SESSION, atMs),
    diagnostics: () => controller.diagnostics(SESSION),
    dispose: () => controller.dispose(),
  }
}

test('every current 0.1.7 TurnEndReason variant terminates the turn', () => {
  /**
   * The complete local vocabulary, audited field by field against
   * `dsh-session/lib/types/types.d.ts:165-208`:
   * `completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted`,
   * `forked`. `forked` is the variant the 0.1.5 baseline did not have.
   */
  const cases = [
    [{ kind: 'completed' }, 'completed', true],
    [{ kind: 'max-tokens' }, 'completed', true],
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'interrupted', true],
    [{ kind: 'aborted', reason: { kind: 'parent' } }, 'interrupted', true],
    [{ kind: 'aborted', reason: { kind: 'hook', reason: 'x' } }, 'interrupted', true],
    [{ kind: 'aborted', reason: { kind: 'disposed' } }, 'interrupted', true],
    [{ kind: 'aborted', reason: { kind: 'legacy' } }, 'interrupted', true],
    [{ kind: 'blocked' }, 'errored', true],
    [{ kind: 'error', error: { message: 'boom', code: 'RATE_LIMIT' } }, 'errored', true],
    [{ kind: 'interrupted' }, 'interrupted', true],
    /**
     * Fork-seed construction closed a turn that was still open at the fork
     * boundary. It is not a completion and not an error: the turn genuinely did
     * not finish, so it is an interruption, and it is never reported as unknown.
     */
    [{ kind: 'forked' }, 'interrupted', true],
  ]
  for (const [reason, status, known] of cases) {
    const mapped = turnEndStatus(reason)
    assert.equal(mapped.status, status, `${reason.kind} -> ${status}`)
    assert.equal(mapped.known, known, `${reason.kind} is recognized`)
  }

  // An unknown future kind still closes the turn, with `known: false`.
  const unknown = turnEndStatus({ kind: 'something-new' })
  assert.equal(unknown.status, 'errored')
  assert.equal(unknown.known, false, 'an unrecognized kind never claims a known cause')
  assert.equal(turnEndStatus(undefined).known, false)
})

test('each reason kind settles a live turn through the controller', () => {
  for (const reason of [
    { kind: 'completed' }, { kind: 'max-tokens' }, { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'blocked' }, { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } },
    { kind: 'interrupted' }, { kind: 'forked' }, { kind: 'brand-new-kind' },
  ]) {
    const h = harness()
    h.driver.append(EVENT('turn/start', 1, 1000, { turn: 1 }))
    h.driver.append(EVENT('step/start', 2, 1010, { turn: 1, step: 1 }))
    h.driver.append(TRANSIENT('s:1', 1100, DELTA))
    h.driver.append(EVENT('tool/call', 3, 1200, { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }))

    // A tool is still running when the turn ends: §27 requires the live view to
    // close unconditionally anyway.
    h.driver.append(EVENT('turn/end', 4, 5000, { turn: 1, reason }))
    const view = h.project(5100)
    assert.equal(view.kind, 'completed', `${reason.kind} settles the turn`)
    const diagnostics = h.diagnostics()
    assert.equal(diagnostics.livePresentedToolCount, 0, `${reason.kind}: the live view closes`)
    assert.equal(diagnostics.liveRunningTools, 1, `${reason.kind}: the unresolved call stays on the record`)
    assert.equal(diagnostics.counters.presenterTurnEndApplied, 1)
    h.dispose()
  }
})

test('turn end closes the live view with an unresolved call, and the record keeps it incomplete', () => {
  const h = harness()
  h.driver.append(EVENT('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(EVENT('tool/call', 2, 2000, { turn: 1, step: 1, callId: 'never-answered', name: 'pwsh', arguments: '{}' }))
  assert.equal(h.diagnostics().livePresentedToolCount, 1, 'the pill is live while the call is open')

  h.driver.append(EVENT('turn/end', 3, 9000, { turn: 1, reason: { kind: 'completed' } }))
  const view = h.project(9100)
  assert.equal(view.kind, 'completed')
  assert.equal(h.diagnostics().livePresentedToolCount, 0, 'presentation lifecycle is closed')
  assert.equal(h.diagnostics().liveRunningTools, 1, 'the meter still holds the call as unresolved')

  /**
   * §27: evidence completeness is a different question. The call's result was
   * never observed, so its interval stays open and no end time is invented to
   * make the footer clean.
   */
  const record = h.record(1)
  assert.equal(record.tools.length, 1)
  assert.equal(record.tools[0].endMs, null, 'the unobserved end is never fabricated')
  assert.equal(view.tools.count, 1, 'it is still counted as a historical call')
  assert.equal(view.tools.completedCount, 0, 'and reported as incomplete')
  h.dispose()
})

test('late evidence cannot resurrect a turn that reached turn/end', () => {
  const h = harness()
  h.driver.append(EVENT('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(EVENT('step/start', 2, 1010, { turn: 1, step: 1 }))
  h.driver.append(TRANSIENT('s:1', 1100, DELTA))
  h.driver.append(EVENT('tool/call', 3, 1200, { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }))
  h.driver.append(EVENT('turn/end', 4, 2000, { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(h.project(2100).kind, 'completed')

  // A late transient row, a late tool boundary, a late step boundary and a late
  // settle-assistant retirement — every one of them arrives after the boundary.
  h.driver.append(TRANSIENT('s:1', 2500, DELTA))
  h.driver.append(EVENT('tool/result', 5, 2600, {
    turn: 1,
    step: 1,
    message: { id: 'm', role: 'tool', source: { kind: 'tool' }, toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'late' }] },
  }))
  h.driver.append(TRANSIENT('s:2', 2700, DELTA))
  h.driver.settleAssistant('s:1')
  h.driver.append(EVENT('step/start', 6, 2800, { turn: 1, step: 2 }))

  const after = h.project(2900)
  assert.equal(after.kind, 'completed', 'the settled turn stays settled')
  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.livePresentedToolCount, 0, 'no live tool is resurrected')
  assert.ok(diagnostics.counters.lateTurnRows >= 2, 'the late transient rows are counted')
  assert.ok(diagnostics.counters.lateTurnEvents >= 1, 'the late durable rows are counted')
  assert.ok(diagnostics.feedIssues.some(issue => issue.kind === 'transient-row-of-a-finished-turn'))
  assert.ok(diagnostics.feedIssues.some(issue => issue.kind === 'durable-event-of-a-finished-turn'))
  h.dispose()
})

test('a turn/end with no record is diagnosed, not silently dropped', () => {
  /**
   * §25. The published window is a live tail, so a client can receive the
   * authoritative terminal boundary for a turn whose opening row it never saw.
   * At the baseline SHA the controller returned early and the boundary vanished
   * without trace; the record is now reconstructed from the durable event and
   * the miss is counted.
   */
  const h = harness()
  // No `turn/start`: the window begins after it.
  h.driver.append(EVENT('tool/call', 20, 2000, { turn: 3, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }))
  h.driver.append(EVENT('turn/end', 21, 4000, { turn: 3, reason: { kind: 'completed' } }))

  const view = h.project(4100)
  assert.equal(view.kind, 'completed', 'the authoritative boundary still produces the card')
  assert.equal(view.turn, 3)
  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.normalizedTurnEndSeen, 1)
  assert.equal(diagnostics.counters.turnEndLookupMiss, 1, 'the miss is counted')
  assert.equal(diagnostics.counters.turnEndReconstructed, 1)
  assert.equal(diagnostics.counters.storeEndTurnCalled, 1)
  assert.equal(diagnostics.counters.presenterTurnEndApplied, 1)
  assert.ok(diagnostics.feedIssues.some(issue => issue.kind === 'turn-end-without-record'))
  h.dispose()
})

test('a reconstructed record reports an unknown start rather than a fabricated one', () => {
  const h = harness()
  h.driver.append(EVENT('turn/end', 30, 4000, { turn: 5, reason: { kind: 'completed' } }))
  const view = h.project(4100)
  assert.equal(view.kind, 'completed')
  assert.equal(h.record(5).startMs, null, 'the start was never observed, so it stays unknown')
  assert.equal(view.elapsedMs, null, 'elapsed is not invented from the reconstruction')
  h.dispose()
})

test('a reload rebuilds the same completed card from the durable window', () => {
  const h = harness()
  const durable = [
    EVENT('turn/start', 1, 1000, { turn: 1 }),
    EVENT('step/start', 2, 1010, { turn: 1, step: 1 }),
    EVENT('assistant/message', 3, 1500, {
      turn: 1,
      step: 1,
      message: { id: 'm1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'hi' }] },
      stream: [{ type: 'text-chunks', time0: 1200, index: 0, dt: [300], texts: ['hi'] }],
      usage: { inputTokens: 5, outputTokens: 3 },
    }),
    EVENT('tool/call', 4, 1600, { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }),
    EVENT('tool/result', 5, 1900, {
      turn: 1,
      step: 1,
      message: { id: 'm2', role: 'tool', source: { kind: 'tool' }, toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] },
    }),
    EVENT('step/end', 6, 1950, { turn: 1, step: 1 }),
    EVENT('turn/end', 7, 2000, { turn: 1, reason: { kind: 'completed' } }),
  ]

  // First pass: live ingestion of the same rows, one append at a time.
  for (const entry of durable) h.driver.append(entry)
  const live = h.project(2100)
  assert.equal(live.kind, 'completed')
  const liveText = JSON.stringify({ columns: live.columns, tools: live.tools, status: live.status, elapsedMs: live.elapsedMs })

  // Reload: a `replace` with the durable window and NO transient rows at all.
  h.driver.replace(durable)
  const reloaded = h.project(2100)
  assert.equal(reloaded.kind, 'completed', 'the card survives the reload')
  assert.equal(reloaded.state, 'settled')
  assert.equal(
    JSON.stringify({ columns: reloaded.columns, tools: reloaded.tools, status: reloaded.status, elapsedMs: reloaded.elapsedMs }),
    liveText,
    'the reconstructed card equals the one built live',
  )
  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.rawTransientRows, 0, 'the reconstruction is purely durable')
  assert.equal(diagnostics.counters.turnEndLookupMiss, 0)
  assert.equal(diagnostics.liveRunningTools, 0)
  assert.notEqual(reloaded.kind, 'tool')
  assert.notEqual(reloaded.kind, 'streaming')
  assert.notEqual(reloaded.kind, 'waiting')
  h.dispose()
})

test('a completed turn with many historical tools keeps the two counts apart', () => {
  const h = harness()
  h.driver.append(EVENT('turn/start', 1, 1000, { turn: 1 }))
  let seq = 1
  for (let i = 1; i <= 20; i += 1) {
    h.driver.append(EVENT('tool/call', (seq += 1), 1000 + i * 100, { turn: 1, step: 1, callId: `c${i}`, name: 'pwsh', arguments: '{}' }))
    h.driver.append(EVENT('tool/result', (seq += 1), 1000 + i * 100 + 40, {
      turn: 1,
      step: 1,
      message: { id: `m${i}`, role: 'tool', source: { kind: 'tool' }, toolCallId: `c${i}`, isError: false, content: [{ type: 'text', text: 'ok' }] },
    }))
  }
  h.driver.append(EVENT('turn/end', (seq += 1), 9000, { turn: 1, reason: { kind: 'completed' } }))

  const view = h.project(9100)
  assert.equal(view.kind, 'completed')
  assert.equal(view.tools.count, 20, 'the footer reports the historical tool count')
  assert.equal(h.diagnostics().liveRunningTools, 0, 'and the live count is zero')
  assert.equal(h.record(1).tools.length, 20)
  assert.equal(h.controller.store.live(SESSION).runningTools().length, 0)
  h.dispose()
})

test('the window contract delivers replace, append, prepend and settle-assistant', () => {
  /**
   * §39: the four `SessionEventChange` kinds of 0.1.7-rc.2
   * (`dsh-api-session-controller/lib/types/client/contract/events.d.ts:41-54`).
   * `prepend` is deliberately ignored; the others are asserted through the feed
   * directly so the mapping is visible without a controller in the way.
   */
  const seen = []
  const issues = []
  const feed = new SessionEventFeed({ sessionId: 's', onEvent: e => seen.push(e), onIssue: i => issues.push(i) })

  feed.applyWindow({ entries: [EVENT('turn/start', 1, 1000, { turn: 1 })], revision: 1, change: { kind: 'replace', entries: [] } })
  assert.deepEqual(seen.map(e => e.kind), [NORMALIZED_KIND.TURN_START])

  feed.applyWindow({ entries: [], revision: 2, change: { kind: 'append', entries: [EVENT('step/start', 2, 1010, { turn: 1, step: 1 })] } })
  assert.equal(seen[seen.length - 1].kind, NORMALIZED_KIND.STEP_START)

  const before = seen.length
  feed.applyWindow({ entries: [], revision: 3, change: { kind: 'prepend', entries: [EVENT('step/start', 0, 500, { turn: 1, step: 0 })] } })
  assert.equal(seen.length, before, 'older history is ignored, never replayed out of order')
  assert.equal(feed.ignoredPrepends, 1)

  const settlement = EVENT('assistant/message', 4, 1500, {
    turn: 1,
    step: 1,
    message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [] },
    stream: [{ type: 'text-chunks', time0: 1200, index: 0, dt: [300], texts: ['hi'] }],
  })
  feed.applyWindow({ entries: [], revision: 4, change: { kind: 'settle-assistant', attemptId: 'a:1', entry: settlement } })
  const settle = seen[seen.length - 1]
  assert.equal(settle.kind, NORMALIZED_KIND.ATTEMPT_SETTLE)
  assert.equal(settle.attemptId, 'a:1', 'the attempt identity travels with the settlement')

  // A bare settle with no durable settlement in evidence is an abandonment.
  feed.applyWindow({ entries: [], revision: 5, change: { kind: 'settle-assistant', attemptId: 'a:2' } })
  assert.equal(seen[seen.length - 1].kind, NORMALIZED_KIND.ATTEMPT_ABANDON)
  assert.equal(seen[seen.length - 1].attemptId, 'a:2')
})
