/**
 * Phase 7A.1 — generation ownership across a window `replace`.
 *
 * `SessionEventFeed` documents `replace` as a **rebaseline**: the complete contiguous
 * window was swapped (initial snapshot, reload, reconnect), so every piece of
 * generation state it owns is dropped and the new window is replayed from scratch. That
 * is what the feed does, and `test/dsh-client-feed.test.js` asserts it.
 *
 * The controller did not honour the same generation. On `window-rebaseline` it reset the
 * presentation machine and forgot which record and attempt it was addressing — but the
 * **evidence** lives in `TurnTelemetryStore`, and the store was left untouched. The
 * replay then re-entered attempts the superseded window had already contributed to:
 *
 *     generation 1: turn/start(1000), transient a@1100 "x"   -> attempt a, 1 sample
 *     replace with the same two rows
 *     feed:  dedupe cleared, both rows re-delivered
 *     store: record for turn 1 still present, attempt a still present
 *     -> acceptChunk() appends the replayed delta to the *same* attempt
 *     -> attempt a, 2 samples
 *
 * Every derived quantity follows the duplicated samples: tokens, the curve, the settling
 * attempt's stream. The card is then a function of how many times the window happened to
 * be republished rather than of what the session did.
 *
 * The repair gives the store the same generation boundary the feed already has:
 * `TurnTelemetryStore.rebaselineSession(sessionId)` drops that session's turn records and
 * its `LiveMeter`, and the controller calls it **before** the presenter reset, so the
 * replay rebuilds the projection from the replacement window alone:
 *
 *     store.rebaselineSession(sessionId)   <- evidence, the actual metric state
 *     presenter.reset()                    <- machine state
 *     currentRecord / openAttemptId = null
 *     invalidate()                         <- memoized projections
 *     ... feed replays the replacement window ...
 *
 * It is deliberately **not** a dedupe key over `timeMs + text` or `attemptId + time`.
 * Stable dedupe would mask the symptom while leaving the previous generation's state in
 * memory, which is exactly the state the replacement window is authoritative about.
 *
 * The property that matters is the last section: after a `replace`, a controller must be
 * indistinguishable from a fresh controller that loaded the replacement window directly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { turnKey } from '../src/core/types.js'
import { durableEntry, fakeSessionsService, transientEntry } from './helpers/live-replay.js'

const output = text => ({ type: 'text-delta', index: 0, text })

/**
 * A controller attached to one session's fake event source.
 *
 * `push` appends one live tail entry and `replace` swaps the whole window, both with a
 * monotonically increasing revision, which is what `MutableSessionEventSource` publishes.
 */
function attached(sessionId) {
  const sessions = fakeSessionsService()
  const source = sessions.createSource(sessionId)
  const controller = createController({ sessions })
  assert.equal(controller.attach(sessionId), true, 'the fake binding must be resolvable')
  let revision = 1
  return {
    sessions,
    source,
    controller,
    push(entry) {
      source.appendEntry(entry, (revision += 1))
      return controller
    },
    replace(entries) {
      source.replaceEntries(entries, (revision += 1))
      return controller
    },
    /**
     * The fold's atomic attempt settlement: the transient rows of `attemptId` are
     * superseded by the durable `entry` in one revision, or dropped when `entry` is
     * `undefined` (a bare abandonment).
     */
    settle(attemptId, entry) {
      source.settleAssistant(attemptId, entry, (revision += 1))
      return controller
    },
    dispose() { controller.dispose() },
  }
}

/**
 * A fresh controller whose very first window **is** `entries`.
 *
 * The window is installed before `attach`, so the feed consumes it as the initial full
 * pass rather than as a rebaseline — a page loading this window for the first time, with
 * no previous generation to reconcile against.
 */
function freshOverWindow(sessionId, entries) {
  const sessions = fakeSessionsService()
  const source = sessions.createSource(sessionId)
  source.replaceEntries(entries, 1)
  const controller = createController({ sessions })
  assert.equal(controller.attach(sessionId), true)
  return controller
}

/**
 * The telemetry a controller holds for one session, as plain data.
 *
 * This is the projection's real input — not the view model built from it — so comparing
 * two of these compares the evidence, the sampling and the settlement metadata at once.
 */
function telemetryOf(controller, sessionId) {
  return [...controller.store.turns.values()]
    .filter(record => record.sessionId === sessionId)
    .map(record => ({
      turn: record.turn,
      startMs: record.startMs,
      endMs: record.endMs,
      firstTokenMs: record.firstTokenMs,
      status: record.status,
      attempts: record.attempts.map(attempt => ({
        attemptId: attempt.attemptId,
        step: attempt.step,
        settlementKind: attempt.settlementKind,
        surfaceCommitted: attempt.surfaceCommitted,
        attemptOutcome: attempt.attemptOutcome,
        usage: attempt.usage ?? null,
        samples: attempt.samples.map(sample => ({
          timeMs: sample.timeMs,
          tokens: sample.tokens,
          phase: sample.phase,
          attemptId: sample.attemptId ?? null,
        })),
      })),
      tools: record.tools.map(call => ({
        callId: call.callId,
        name: call.name,
        startMs: call.startMs,
        endMs: call.endMs,
        status: call.status,
      })),
      settled: record.settled === null,
    }))
    .sort((left, right) => left.turn - right.turn)
}

/** The single turn record of one session, or `undefined`. */
const recordOf = (controller, sessionId, turn = 1) => controller.store.turns.get(turnKey(sessionId, turn))

/* ------------------------------------------------------- the counterexample itself */

test('a replace replays the same transient evidence without duplicating the sample', () => {
  const run = attached('s-dup')
  run.push(durableEntry('turn/start', 4, 1000, { turn: 1 }))
  run.push(transientEntry('a', 1100, output('x')))

  const before = recordOf(run.controller, 's-dup')
  assert.equal(before.attempts.length, 1)
  assert.equal(before.attempts[0].samples.length, 1, 'one delta is one sample')

  /**
   * The rebaseline: the same wire evidence, republished as a new window generation. The
   * rows are new objects, so the feed's identity-keyed transient dedupe cannot be what
   * makes the difference — the generation boundary has to be.
   */
  run.replace([
    durableEntry('turn/start', 4, 1000, { turn: 1 }),
    transientEntry('a', 1100, output('x')),
  ])

  const after = recordOf(run.controller, 's-dup')
  assert.ok(after !== undefined, 'the replacement window rebuilds the turn')
  assert.equal(after.attempts.length, 1, 'and rebuilds exactly one attempt')
  assert.equal(after.attempts[0].samples.length, 1,
    `the replayed delta was appended to an attempt the superseded window already owned: ${after.attempts[0].samples.length} samples`)
  assert.equal(after.attempts[0].samples[0].timeMs, 1100, 'and it is the measurement from the replacement window')
  run.dispose()
})

test('a rebuilt turn carries the same samples as a fresh controller over the replacement window', () => {
  const entries = [
    durableEntry('turn/start', 4, 1000, { turn: 1 }),
    transientEntry('a', 1100, output('x')),
    transientEntry('a', 1200, output('y')),
  ]
  const run = attached('s-count')
  for (const entry of entries) run.push(entry)
  assert.equal(recordOf(run.controller, 's-count').attempts[0].samples.length, 2)

  run.replace(entries.map(entry => structuredClone(entry)))
  const fresh = freshOverWindow('s-count', entries.map(entry => structuredClone(entry)))

  assert.equal(recordOf(run.controller, 's-count').attempts[0].samples.length, 2,
    'the replacement window holds two deltas, so the rebuilt attempt holds two')
  assert.deepEqual(telemetryOf(run.controller, 's-count'), telemetryOf(fresh, 's-count'))
  assert.deepEqual(run.controller.project('s-count', 1300), fresh.project('s-count', 1300))
  run.dispose()
  fresh.dispose()
})

test('a partial replacement does not keep evidence the new window does not contain', () => {
  const run = attached('s-partial')
  run.push(durableEntry('turn/start', 4, 1000, { turn: 1 }))
  run.push(transientEntry('a', 1100, output('x')))
  run.push(transientEntry('a', 1200, output('y')))

  /**
   * The replacement window is *shorter*: it holds one of the two deltas. Evidence the
   * superseded generation observed but the new one does not publish is not carried over —
   * the window is the authority on what this session did, and a stale sample would be a
   * measurement nothing in the current window supports.
   */
  run.replace([
    durableEntry('turn/start', 4, 1000, { turn: 1 }),
    transientEntry('a', 1100, output('x')),
  ])
  const after = recordOf(run.controller, 's-partial')
  assert.deepEqual(after.attempts[0].samples.map(sample => sample.timeMs), [1100],
    'the delta the replacement window dropped is not retained')
  run.dispose()
})

/* ---------------------------------------------------- adoption and upgrade paths */

test('a replacement window that begins mid-turn re-adopts the open turn', () => {
  const run = attached('s-adopt')
  run.push(durableEntry('turn/start', 4, 1000, { turn: 1 }))
  run.push(transientEntry('a', 1100, output('x')))
  run.push(transientEntry('a', 1200, output('y')))

  /** No `turn/start` in the replacement window at all: a live tail, adopted from transient evidence. */
  run.replace([
    transientEntry('a', 1100, output('x'), { step: 1 }),
    transientEntry('a', 1200, output('y'), { step: 1 }),
  ])

  const record = recordOf(run.controller, 's-adopt')
  assert.ok(record !== undefined, 'the transient tail re-creates the turn')
  assert.equal(record.startMs, null, 'the start is still unobserved, so nothing is measured from the reload')
  assert.equal(record.attempts[0].samples.length, 2, 'and both deltas of the new generation are kept, exactly once')

  const view = run.controller.project('s-adopt', 1300)
  assert.equal(view.kind, 'streaming', 'the live meter is rebuilt from the replacement window')
  assert.ok(view.tps > 0, 'and reports the rate the window actually measured')
  assert.equal(view.elapsedMs, null,
    'elapsed is unknown rather than zero: the turn start is not in this window')
  run.dispose()
})

test('an authoritative turn/start still upgrades a recovered record after a replace', () => {
  const run = attached('s-upgrade')
  run.push(durableEntry('turn/start', 4, 1000, { turn: 1 }))
  run.push(transientEntry('a', 1100, output('x')))
  run.replace([transientEntry('a', 1100, output('x'))])

  const recovered = recordOf(run.controller, 's-upgrade')
  assert.equal(recovered.startMs, null, 'adopted mid-turn: unknown start')
  assert.equal(recovered.firstTokenMs, 1100, 'the first token instant is observed, not derived')

  /** The durable boundary enters the new generation, one row later than the tail. */
  run.push(durableEntry('turn/start', 5, 1000, { turn: 1 }))
  const upgraded = recordOf(run.controller, 's-upgrade')
  assert.equal(upgraded, recovered, 'the upgrade is not a restart: the same record')
  assert.equal(upgraded.startMs, 1000, 'the observed start replaces the unknown one, one way only')
  assert.equal(upgraded.attempts[0].samples.length, 1, 'and no evidence is replayed by the upgrade')

  const view = run.controller.project('s-upgrade', 1300)
  assert.equal(view.kind, 'streaming')
  assert.equal(view.elapsedMs, 300, 'elapsed becomes computable over the same evidence')
  run.dispose()
})

/* --------------------------------------------- completed reconstruction and tools */

const settlementEntries = () => [
  durableEntry('turn/start', 4, 1000, { turn: 1 }),
  durableEntry('step/start', 5, 1010, { turn: 1, step: 1 }),
  durableEntry('assistant/message', 9, 1700, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'first attempt' }] },
    usage: { inputTokens: 10, outputTokens: 40, reasoningTokens: 0 },
    stream: [
      { type: 'chunk', time: 1100, chunk: output('first ') },
      { type: 'chunk', time: 1600, chunk: output('attempt') },
    ],
  }),
  durableEntry('turn/end', 12, 1800, { turn: 1, reason: { kind: 'completed' } }),
]

test('a completed turn rebuilt by a replace equals a fresh controller over the same window', () => {
  /**
   * Generation 1 reaches the card the ordinary way: durable boundaries plus the live
   * transient deltas, closed by the fold's atomic settlement.
   */
  const run = attached('s-complete')
  run.push(durableEntry('turn/start', 4, 1000, { turn: 1 }))
  run.push(durableEntry('step/start', 5, 1010, { turn: 1, step: 1 }))
  run.push(transientEntry('a', 1100, output('first ')))
  run.push(transientEntry('a', 1600, output('attempt')))
  const settlement = durableEntry('assistant/message', 9, 1700, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'first attempt' }] },
    usage: { inputTokens: 10, outputTokens: 40, reasoningTokens: 0 },
    stream: [
      { type: 'chunk', time: 1100, chunk: output('first ') },
      { type: 'chunk', time: 1600, chunk: output('attempt') },
    ],
  })
  run.push(settlement)
  run.settle('a', settlement)
  run.push(durableEntry('turn/end', 12, 1800, { turn: 1, reason: { kind: 'completed' } }))
  const before = run.controller.project('s-complete', 2000)
  assert.equal(before.kind, 'completed', 'generation 1 produced a card')

  /** The reload: the replacement window is the durable plane, replaying the same turn whole. */
  const window = settlementEntries()
  run.replace(window)
  const rebuilt = run.controller.project('s-complete', 2000)

  const fresh = freshOverWindow('s-complete', settlementEntries())
  const freshView = fresh.project('s-complete', 2000)

  assert.equal(rebuilt.kind, 'completed', 'the card is rebuilt, not lost')
  assert.deepEqual(telemetryOf(run.controller, 's-complete'), telemetryOf(fresh, 's-complete'),
    'the rebuilt turn carries the same attempts, samples, usage and tools as a fresh load')
  assert.deepEqual(rebuilt, freshView,
    'and the card itself is identical, so no token, attempt or tool call was counted twice')

  const record = recordOf(run.controller, 's-complete')
  assert.equal(record.attempts.length, 1, 'the durable settlement replayed into the restored attempt, not beside it')
  assert.deepEqual(record.attempts[0].samples.map(sample => sample.timeMs), [1100, 1600])
  assert.equal(record.attempts[0].usage.outputTokens, 40)
  /**
   * The generated total is the token count the duplicated-sample defect corrupted: the
   * superseded generation's attempt and the restored durable attempt both held the same
   * two deltas, and both were counted.
   */
  assert.equal(record.settled.generatedTokens, 40)
  assert.equal(record.settled.observedGeneratedTokens, 40)
  run.dispose()
  fresh.dispose()
})

test('a rebaseline onto a settled turn shows the card and no live meter', () => {
  const run = attached('s-settled-only')
  run.push(durableEntry('turn/start', 4, 1000, { turn: 1 }))
  run.push(transientEntry('a', 1100, output('live-only')))
  run.replace(settlementEntries())

  const view = run.controller.project('s-settled-only', 2000)
  assert.equal(view.kind, 'completed', 'a window holding only a finished turn yields the card')
  assert.equal(view.turn, 1)
  assert.equal(view.columns.length, 4)

  /** TTFT, the curve and the generated total all come back from the durable row. */
  const record = recordOf(run.controller, 's-settled-only')
  assert.equal(record.firstTokenMs, 1100, 'the settled attempt restores the instant it produced its first token')
  assert.equal(record.settled.ttftMs, 100, 'and TTFT is the same interval a live observation would have frozen')
  assert.equal(record.settled.curve.peakTps > 0, true, 'the curve is rebuilt from the embedded stream')
  assert.equal(record.settled.tools.count, 0, 'and a turn with no tool row reports no tool')
  run.dispose()
})

test('tool state that the replacement window does not contain does not survive it', () => {
  const run = attached('s-tool')
  run.push(durableEntry('turn/start', 4, 1000, { turn: 1 }))
  run.push(transientEntry('a', 1100, output('x')))
  run.push(durableEntry('tool/call', 6, 1200, { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }))
  assert.equal(recordOf(run.controller, 's-tool').tools.length, 1)
  assert.equal(run.controller.project('s-tool', 1300).kind, 'tool', 'the live view is in the tool stage')

  /** The replacement window has the turn and its delta, but no tool row of any kind. */
  run.replace([
    durableEntry('turn/start', 4, 1000, { turn: 1 }),
    transientEntry('a', 1100, output('x')),
  ])

  const record = recordOf(run.controller, 's-tool')
  assert.equal(record.tools.length, 0, 'the tool call belongs to the superseded window')
  const view = run.controller.project('s-tool', 1300)
  assert.notEqual(view.kind, 'tool', 'and no timer is left claiming a call is still running')
  assert.equal(view.kind, 'streaming', 'the rebuilt live state follows the replacement window')
  run.dispose()
})

/* -------------------------------------------------------------- session isolation */

test('a rebaseline is scoped to one session and leaves every other session untouched', () => {
  const sessions = fakeSessionsService()
  const sourceA = sessions.createSource('s-a')
  const sourceB = sessions.createSource('s-b')
  const controller = createController({ sessions })
  controller.attach('s-a')
  controller.attach('s-b')
  let revision = 1

  sourceA.appendEntry(durableEntry('turn/start', 4, 1000, { turn: 1 }), (revision += 1))
  sourceA.appendEntry(transientEntry('a', 1100, output('x')), (revision += 1))
  sourceB.appendEntry(durableEntry('turn/start', 4, 1000, { turn: 1 }), (revision += 1))
  sourceB.appendEntry(transientEntry('b', 1100, output('x')), (revision += 1))
  sourceB.appendEntry(transientEntry('b', 1200, output('y')), (revision += 1))
  sourceB.appendEntry(durableEntry('turn/end', 12, 1300, { turn: 1, reason: { kind: 'completed' } }), (revision += 1))

  const bRecord = recordOf(controller, 's-b')
  const bSettled = controller.store.latestSettled('s-b')
  const bView = controller.project('s-b', 1400)
  assert.equal(bView.kind, 'completed')

  /** Session A is rebaselined; session B is running a different session's conversation. */
  sourceA.replaceEntries([
    durableEntry('turn/start', 4, 1000, { turn: 1 }),
    transientEntry('a', 1100, output('x')),
  ], (revision += 1))

  assert.equal(recordOf(controller, 's-a').attempts[0].samples.length, 1,
    'A is rebuilt from its replacement window')
  assert.equal(recordOf(controller, 's-b'), bRecord,
    'B keeps the very record it had: the reset is session-scoped, not a store-wide clear')
  assert.equal(recordOf(controller, 's-b').attempts[0].samples.length, 2)
  assert.deepEqual(controller.store.latestSettled('s-b'), bSettled, 'and B\'s settled turn is untouched')
  assert.deepEqual(controller.project('s-b', 1400), bView, 'so B renders exactly what it rendered before')
  assert.equal(controller.attachedSessions().length, 2, 'both sessions stay attached')
  controller.dispose()
})

test('repeating a replace over the same window is idempotent', () => {
  const window = [
    durableEntry('turn/start', 4, 1000, { turn: 1 }),
    transientEntry('a', 1100, output('x')),
    transientEntry('a', 1200, output('y')),
  ]
  const run = attached('s-idem')
  run.replace(window.map(entry => structuredClone(entry)))
  const first = telemetryOf(run.controller, 's-idem')
  const firstView = run.controller.project('s-idem', 1300)

  run.replace(window.map(entry => structuredClone(entry)))
  assert.deepEqual(telemetryOf(run.controller, 's-idem'), first, 'a second rebaseline rebuilds, it does not accumulate')
  assert.deepEqual(run.controller.project('s-idem', 1300), firstView)

  run.replace(window.map(entry => structuredClone(entry)))
  assert.deepEqual(telemetryOf(run.controller, 's-idem'), first, 'and a third')
  assert.equal(recordOf(run.controller, 's-idem').attempts[0].samples.length, 2,
    'the sample count follows the window, not the number of replays')
  run.dispose()
})

test('a rebaseline with no turn at all leaves nothing behind from the previous generation', () => {
  const run = attached('s-empty')
  run.push(durableEntry('turn/start', 4, 1000, { turn: 1 }))
  run.push(transientEntry('a', 1100, output('x')))
  run.settle('a', undefined)
  run.replace([])

  assert.equal(recordOf(run.controller, 's-empty'), undefined, 'the previous generation is not retained')
  assert.equal(run.controller.store.liveSnapshot('s-empty', 1200).phase, 'idle',
    'and its live meter is gone with it rather than left mid-stream')
  const view = run.controller.project('s-empty', 1200)
  assert.equal(view.kind, 'hidden')
  assert.equal(view.turn, null)
  assert.equal(run.controller.store.latestSettled('s-empty'), null)
  run.dispose()
})

/* -------------------------------------------------------- the reset in isolation */

test('rebaselineSession drops one session\'s turns and its live meter, and nothing else', () => {
  const store = new TurnTelemetryStore()
  const a = store.beginTurn({ sessionId: 's-a', turn: 1, timeMs: 1000 })
  store.beginAttempt(a, { attemptId: 'a1', step: 1, startedAtMs: 1000 })
  store.acceptChunk(a, a.attempts[0], { timeMs: 1100, chunk: output('x') })
  const b = store.beginTurn({ sessionId: 's-b', turn: 1, timeMs: 1000 })
  store.beginAttempt(b, { attemptId: 'b1', step: 1, startedAtMs: 1000 })
  store.acceptChunk(b, b.attempts[0], { timeMs: 1100, chunk: output('y') })
  store.endTurn(b, { timeMs: 1200, status: 'completed' })
  const bSettled = store.latestSettled('s-b')

  assert.equal(store.liveSnapshot('s-a', 1100).phase, 'streaming')
  assert.equal(store.rebaselineSession('s-a'), 1, 'one turn record was removed')

  assert.equal(store.turns.has(turnKey('s-a', 1)), false, 'the session\'s turn records are gone')
  assert.equal(store.liveSnapshot('s-a', 1100).phase, 'idle', 'and so is its live meter')
  assert.equal(store.liveSnapshot('s-b', 1150).phase, 'settled', 'while B keeps its own meter')
  assert.equal(store.turns.get(turnKey('s-b', 1)), b)
  assert.deepEqual(store.latestSettled('s-b'), bSettled)

  /** A reset for a session that owns nothing is a no-op rather than an error. */
  assert.equal(store.rebaselineSession('s-unknown'), 0)
  assert.equal(store.rebaselineSession(''), 0)
  assert.equal(store.liveSnapshot('s-b', 1150).phase, 'settled', 'and it cannot disturb an unrelated session')

  /** The meter a rebaselined session gets next is a new one, not the state that was dropped. */
  const rebuilt = store.beginTurn({ sessionId: 's-a', turn: 1, timeMs: 1000 })
  assert.notEqual(rebuilt, a)
  assert.deepEqual(rebuilt.attempts, [], 'the rebuilt record starts empty')
})
