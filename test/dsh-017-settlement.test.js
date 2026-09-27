/**
 * Phase 7D — `settle-assistant` retirement versus true abandonment.
 *
 * The 0.1.5-era reading of the window contract treated a bare
 * `settle-assistant` (no `entry`) as synonymous with abandonment. The local
 * 0.1.7 install disproves that: `ClientAssistantStream` issues the identical
 * bare `settleAssistant(attemptId)` for a **normal successful message** being
 * retired at its `step/end`, and for a genuinely abandoned attempt. See
 * `test/helpers/assistant-stream-fold.js` for the ported algebra and
 * `docs/DSH_API_NOTES.md` §13 for the source lines.
 *
 * Both sequences below are produced by running the ported fold over the durable
 * rows and assistant frames a real session emits, so the assertions are about
 * the plugin's reading of the wire, not about a hand-written literal.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { ATTEMPT_OUTCOME, NORMALIZED_KIND } from '../src/dsh/index.js'
import { createAssistantStreamFold, createWindowDriver } from './helpers/assistant-stream-fold.js'

const SESSION = 'sess-017-settlement'

function durableEntry(type, seq, time, data, extra = {}) {
  return { type: 'event', event: { type, seq, time, data, ...extra } }
}

/** A minimal successful assistant settlement with one generated delta. */
function assistantMessage(seq, time, { turn = 1, step = 1, interrupted } = {}) {
  const data = {
    turn,
    step,
    message: { id: `msg-${seq}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'done' }] },
    stream: [{ type: 'text-chunks', time0: time - 300, index: 0, dt: [300], texts: ['done'] }],
    usage: { inputTokens: 10, outputTokens: 4 },
  }
  if (interrupted === true) data.interrupted = true
  return durableEntry('assistant/message', seq, time, data, { surfaceOp: 'append' })
}

/**
 * Drive one session through the controller using the real fold, and expose the
 * normalized event stream the feed produced plus the projection after every
 * window publication.
 */
function harness() {
  const driver = createWindowDriver()
  const fold = createAssistantStreamFold()
  const sessions = {
    binding: () => ({ eventSource: { getSnapshot: driver.getSnapshot, subscribe: driver.subscribe } }),
  }
  const controller = createController({ sessions })
  assert.equal(controller.attach(SESSION), true)

  function deliver(frame) {
    const result = fold.acceptFrame(frame)
    driver.applyResult(result)
    return result
  }
  function durable(entry) {
    const result = fold.acceptDurable(entry)
    driver.applyResult(result)
    return result
  }

  return {
    driver,
    fold,
    controller,
    durable,
    deliver,
    project: atMs => controller.project(SESSION, atMs),
    diagnostics: () => controller.diagnostics(SESSION),
    dispose: () => controller.dispose(),
  }
}

test('a successful message retired by a bare settle-assistant is NOT an abandonment', () => {
  const h = harness()

  // turn/start, attempt start frame, one delta, the durable message, step/end.
  h.driver.append(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(durableEntry('step/start', 2, 1010, { turn: 1, step: 1 }))
  assert.equal(h.deliver({ type: 'start', attemptId: 's:1', revision: 1, startedAfterSeq: 2, turn: 1, step: 1 }), undefined)
  h.deliver({ type: 'chunk', attemptId: 's:1', revision: 1, index: 0, time: 1100, chunk: { type: 'text-delta', index: 0, text: 'done' } })

  const settlement = assistantMessage(4, 1500)
  assert.equal(h.durable(settlement), undefined, 'a matching settlement is staged while the attempt is open')
  assert.deepEqual(h.fold.state().pendingSeqs, [4], 'staged, not yet published')

  // The end frame releases it; a non-interrupted message is retained, so the
  // release is an ordinary publish with no retire id yet.
  const released = h.deliver({ type: 'end', attemptId: 's:1', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 } })
  assert.equal(released.type, 'publish')
  assert.equal(released.retireAttemptId, undefined)
  assert.deepEqual(h.fold.state().retained, { attemptId: 's:1', turn: 1, step: 1 })

  // step/end is what retires it: the same bare settle-assistant an abandonment
  // would use, with `entry === undefined`.
  const stepEnd = durableEntry('step/end', 5, 1600, { turn: 1, step: 1 })
  const retire = h.durable(stepEnd)
  assert.equal(retire.type, 'publish')
  assert.equal(retire.retireAttemptId, 's:1')

  /**
   * The defect this test was written against: at the baseline SHA the feed read
   * the bare settle as abandonment and emitted `attempt-abandon`, overwriting
   * the committed outcome of an attempt the session had already durably settled.
   */
  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.retirementsResolved, 1, 'the bare settle is resolved as a retirement')
  assert.equal(diagnostics.counters.abandonmentsResolved, 0, 'no abandonment is invented')
  assert.equal(diagnostics.counters.bareSettleSeen, 1)
  assert.ok(
    !diagnostics.feedIssues.some(issue => issue.kind === 'settle-assistant-without-durable-settlement'),
    'no unresolved-settlement issue is raised',
  )

  // The turn ends normally and the machine settles: the pill is replaced by the
  // completed card in the same state advance, with no intermediate frame.
  h.driver.append(durableEntry('turn/end', 6, 1700, { turn: 1, reason: { kind: 'completed' } }))
  const view = h.project(1800)
  assert.equal(view.kind, 'completed', 'a settled turn projects its card immediately')
  const turnEnd = h.controller.diagnostics(SESSION).counters
  assert.equal(turnEnd.normalizedTurnEndSeen, 1)
  assert.equal(turnEnd.turnEndLookupHit, 1)
  assert.equal(turnEnd.storeEndTurnCalled, 1)
  assert.equal(turnEnd.presenterTurnEndApplied, 1)
  assert.equal(turnEnd.settledSnapshotBuilt, 1)
  assert.equal(h.controller.store.turns.get(`${SESSION}::1`).status, 'completed')
  h.dispose()
})

test('the committed outcome of a retired attempt survives the retirement', () => {
  const h = harness()
  h.driver.append(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(durableEntry('step/start', 2, 1010, { turn: 1, step: 1 }))
  h.deliver({ type: 'start', attemptId: 's:1', revision: 1, startedAfterSeq: 2, turn: 1, step: 1 })
  h.deliver({ type: 'chunk', attemptId: 's:1', revision: 1, index: 0, time: 1100, chunk: { type: 'text-delta', index: 0, text: 'done' } })
  h.durable(assistantMessage(4, 1500))
  h.deliver({ type: 'end', attemptId: 's:1', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 } })
  h.durable(durableEntry('step/end', 5, 1600, { turn: 1, step: 1 }))

  const record = h.controller.store.turns.get(`${SESSION}::1`)
  const attempt = record.attemptIndex.get('s:1')
  assert.ok(attempt, 'the transient attempt identity is the one the settlement was folded into')
  assert.equal(attempt.attemptOutcome, ATTEMPT_OUTCOME.COMMITTED, 'the retirement must not rewrite the outcome')
  assert.equal(attempt.settlementKind, 'message')
  assert.equal(attempt.surfaceCommitted, true)
  h.dispose()
})

test('a true abandonment is still an abandonment, exactly once', () => {
  const h = harness()
  h.driver.append(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(durableEntry('step/start', 2, 1010, { turn: 1, step: 1 }))
  h.deliver({ type: 'start', attemptId: 's:9', revision: 1, startedAfterSeq: 2, turn: 1, step: 1 })
  h.deliver({ type: 'chunk', attemptId: 's:9', revision: 1, index: 0, time: 1100, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } })

  /**
   * No durable settlement exists for this attempt: the end frame itself says so.
   * `ClientAssistantStream` returns `{type:'abandonment'}` and the session issues
   * the same bare `settleAssistant` a retirement uses.
   */
  assert.deepEqual(h.fold.state().pendingSeqs, [], 'nothing was staged: no durable settlement exists')
  const result = h.deliver({ type: 'end', attemptId: 's:9', revision: 1, index: 1, outcome: { kind: 'abandoned' } })
  assert.deepEqual(result, { type: 'abandonment', attemptId: 's:9' })

  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.abandonmentsResolved, 1, 'read as abandonment')
  assert.equal(diagnostics.counters.retirementsResolved, 0, 'never as a retirement')

  const record = h.controller.store.turns.get(`${SESSION}::1`)
  const attempt = record.attemptIndex.get('s:9')
  assert.equal(attempt.attemptOutcome, ATTEMPT_OUTCOME.ABANDONED)
  assert.equal(attempt.surfaceCommitted, false)
  assert.equal(attempt.settlementKind, 'none')

  h.driver.append(durableEntry('turn/end', 6, 1700, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
  assert.equal(record.status, 'interrupted')
  h.dispose()
})

test('an interrupted settlement delivered with its entry is a settlement, not an abandonment', () => {
  const h = harness()
  h.driver.append(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(durableEntry('step/start', 2, 1010, { turn: 1, step: 1 }))
  h.deliver({ type: 'start', attemptId: 's:3', revision: 1, startedAfterSeq: 2, turn: 1, step: 1 })
  h.deliver({ type: 'chunk', attemptId: 's:3', revision: 1, index: 0, time: 1100, chunk: { type: 'text-delta', index: 0, text: 'partial' } })

  const settlement = assistantMessage(4, 1500, { interrupted: true })
  h.durable(settlement)
  const result = h.deliver({ type: 'end', attemptId: 's:3', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 } })
  assert.equal(result.type, 'settlement', 'an interrupted message is retired immediately with its entry')
  assert.equal(h.fold.state().retained, null, 'nothing is retained')

  const record = h.controller.store.turns.get(`${SESSION}::1`)
  const attempt = record.attemptIndex.get('s:3')
  assert.equal(attempt.attemptOutcome, ATTEMPT_OUTCOME.INTERRUPTED)
  assert.equal(attempt.surfaceCommitted, true)
  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.settlementsWithEntry, 1)
  assert.equal(diagnostics.counters.abandonmentsResolved, 0)
  h.dispose()
})

test('a later attempt in the same step is not excused by an earlier attempt\'s retirement', () => {
  const h = harness()
  h.driver.append(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(durableEntry('step/start', 2, 1010, { turn: 1, step: 1 }))

  // Attempt A commits and is retired at its step end.
  h.deliver({ type: 'start', attemptId: 's:A', revision: 1, startedAfterSeq: 2, turn: 1, step: 1 })
  h.deliver({ type: 'chunk', attemptId: 's:A', revision: 1, index: 0, time: 1100, chunk: { type: 'text-delta', index: 0, text: 'a' } })
  h.durable(assistantMessage(4, 1500))
  h.deliver({ type: 'end', attemptId: 's:A', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 } })
  h.durable(durableEntry('step/end', 5, 1600, { turn: 1, step: 1 }))
  assert.equal(h.diagnostics().counters.retirementsResolved, 1)

  // Attempt B runs in the same (turn, step) and is genuinely abandoned.
  h.deliver({ type: 'start', attemptId: 's:B', revision: 2, startedAfterSeq: 5, turn: 1, step: 1 })
  h.deliver({ type: 'chunk', attemptId: 's:B', revision: 2, index: 0, time: 1700, chunk: { type: 'reasoning-delta', index: 0, text: 'b' } })
  const result = h.deliver({ type: 'end', attemptId: 's:B', revision: 2, index: 1, outcome: { kind: 'abandoned' } })
  assert.deepEqual(result, { type: 'abandonment', attemptId: 's:B' })

  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.abandonmentsResolved, 1, 'the retirement budget was already spent')
  assert.equal(diagnostics.counters.retirementsResolved, 1)
  const record = h.controller.store.turns.get(`${SESSION}::1`)
  assert.equal(record.attemptIndex.get('s:B').attemptOutcome, ATTEMPT_OUTCOME.ABANDONED)
  h.dispose()
})

test('a normal retirement is not an abandonment even when the feed never saw the attempt rows', () => {
  const h = harness()
  /**
   * The page attached after the transient rows were already superseded but
   * before `step/end`: the durable settlement is in the window, the attempt
   * identity is not. One outstanding settlement still proves the retirement.
   */
  h.driver.append(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  h.driver.append(durableEntry('step/start', 2, 1010, { turn: 1, step: 1 }))
  // Published directly, as the fold does when no attempt is open.
  const settlement = assistantMessage(4, 1500)
  assert.equal(h.durable(settlement).type, 'publish')
  h.driver.append(durableEntry('step/end', 5, 1600, { turn: 1, step: 1 }))
  h.driver.settleAssistant('s:ghost')

  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.retirementsResolved, 1)
  assert.equal(diagnostics.counters.abandonmentsResolved, 0)
  h.dispose()
})

test('a bare settle with no outstanding settlement and no known attempt is recorded, not silent', () => {
  const h = harness()
  h.driver.append(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  h.driver.settleAssistant('s:unknown')
  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.abandonmentsResolved, 1)
  assert.ok(
    diagnostics.feedIssues.some(issue => issue.kind === 'bare-settlement-without-known-attempt'),
    'the unresolvable identity is diagnosed',
  )
  h.dispose()
})
