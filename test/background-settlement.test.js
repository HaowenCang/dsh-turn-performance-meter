/**
 * Background settlement: the completed card advances without a reload.
 *
 * Phase 9.3 recorded one observation and did not pursue it: after a page reload,
 * a new turn settled while the browser tab was backgrounded, and the completed
 * card kept showing the *previous* turn until the page was reloaded again. The
 * Phase 9.3.1 brief is to resolve that observation, and this file is its
 * deterministic half.
 *
 * ## What is modelled, and why this shape
 *
 * A backgrounded tab does not stop ingesting — the controller's subscription to
 * `SessionEventSource` is not a timer — but it stops *presenting*: the only
 * thing that calls `project()` from a live view is the 100 ms presentation
 * ticker (`src/client/live/refresh.js`), and a browser throttles background
 * timers. So the condition that matters is not "fewer events" but "no projection
 * at all between two events", and that is reproduced exactly: the settlement of
 * turn 2 is ingested with **zero** `project()` calls interleaved, and the next
 * question asked is what the first projection afterwards returns.
 *
 * Both arrival shapes are exercised, because they take different paths through
 * `applyEvent`: a settlement for a turn whose record is open closes a live
 * record, and a settlement for a turn whose opening row is outside the live tail
 * reconstructs one from durable evidence (the `turnEndLookupMiss` branch).
 *
 * ## What is asserted
 *
 * The store is the reference and the projection is the subject. Whatever the
 * page last rendered, `store.latestSettled(session)` must name the newest turn
 * the host settled, and `project()` must agree with it; a stale card is caught at
 * the layer that produced it. Nothing here asserts a *string* — the point is
 * turn identity and the projection cache's key, not formatting.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { createPresentationScheduler } from '../src/client/live/refresh.js'
import { DEFAULT_PRESENTATION_REFRESH_MS } from '../src/client/live/cadence.js'
import { durableEntry, fakeSessionsService, fakeTimerRegistry, transientEntry } from './helpers/live-replay.js'

const SESSION = 'session-background-settlement'

/** The cadence the browser really runs, read from its single source. */
const TICK_MS = DEFAULT_PRESENTATION_REFRESH_MS

const textChunk = text => ({ type: 'text-delta', index: 0, text })

/**
 * A harness whose presentation is driven the way the component drives it.
 *
 * `tick(n)` fires exactly `n` scheduled presentation refreshes and nothing else,
 * so every projection is attributable either to a tick or to an explicit call.
 * Ingestion is always separable from presentation, which is what lets the tests
 * state "the settlement arrived before the next tick" as a fact rather than as a
 * timing coincidence.
 */
function harness() {
  const sessions = fakeSessionsService()
  const source = sessions.createSource(SESSION)
  const controller = createController({ sessions })
  assert.equal(controller.attach(SESSION), true, 'the fake binding must resolve')

  const timers = fakeTimerRegistry()
  let renders = 0
  let lastRender = null
  let clock = 0
  let turn = 1
  let revision = 1
  let seq = 1

  const project = () => controller.project(SESSION, clock)

  const scheduler = createPresentationScheduler({
    intervalMs: TICK_MS,
    onRender: () => { renders += 1; lastRender = project() },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  })

  /** One durable row; the presentation clock never moves on ingestion alone. */
  const durable = (type, timeMs, data) => {
    source.appendEntry(durableEntry(type, (seq += 1), timeMs, data), (revision += 1))
  }
  const transient = (attemptId, timeMs, chunk) => {
    source.appendEntry(transientEntry(attemptId, timeMs, chunk, { turn }), (revision += 1))
  }
  /** A durable settlement: the fold drops the attempt's transient rows and inserts it. */
  const settle = (attemptId, timeMs, { step = 1, texts, usage, at }) => {
    source.settleAssistant(attemptId, durableEntry('assistant/message', at ?? (seq += 1), timeMs, {
      turn,
      step,
      message: { role: 'assistant', content: [] },
      stream: [{ type: 'text-chunks', time0: timeMs - texts.length * 10, index: 0, dt: [], texts }],
      ...(usage === undefined ? {} : { usage }),
    }), (revision += 1))
  }

  return {
    controller,
    source,
    scheduler,
    timers,
    project,
    durable,
    transient,
    settle,
    setTurn: next => { turn = next },
    /** The presentation clock a browser tick would carry. */
    setClock: value => { clock = value },
    advanceClock: ms => { clock += ms },
    getClock: () => clock,
    tick: (n = 1) => { timers.fireIntervals(n); timers.fireTimeouts() },
    renders: () => renders,
    lastRender: () => lastRender,
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
    isTicking: () => scheduler.ticking,
    /** `store.latestSettled` — the durable reference the card must agree with. */
    durableNewest: () => controller.store.latestSettled(SESSION),
    record: turnNumber => controller.store.turns.get(turnKey(SESSION, turnNumber)) ?? null,
    dispose() { scheduler.dispose(); controller.dispose() },
  }
}

/**
 * Turn 1 settled and presented as a card, then turn 2 opened and presented as the
 * live pill. On return, card A is on screen and the pill has replaced it.
 */
function upToLiveSecondTurn(h) {
  h.start()
  h.setTurn(1)
  h.durable('turn/start', 1000, { turn: 1 })
  h.durable('step/start', 1010, { turn: 1, step: 1 })
  for (let index = 0; index < 3; index += 1) h.transient('a:1', 1040 + index * 10, textChunk('first turn'))
  h.settle('a:1', 1200, { texts: ['first', ' turn'], usage: { inputTokens: 100, outputTokens: 40 } })
  h.durable('step/end', 1260, { turn: 1, step: 1 })
  h.durable('turn/end', 1300, { turn: 1, reason: { kind: 'completed' } })

  h.setClock(1400)
  const cardA = h.project()
  assert.equal(cardA.kind, 'completed', 'turn 1 presents as a card')
  assert.equal(cardA.turn, 1)
  h.tick(1)
  assert.equal(h.lastRender().turn, 1, 'the tick after turn 1 shows turn 1')

  h.setTurn(2)
  h.durable('turn/start', 3000, { turn: 2 })
  h.durable('step/start', 3010, { turn: 2, step: 1 })
  for (let index = 0; index < 3; index += 1) h.transient('b:1', 3040 + index * 10, textChunk('second turn'))

  h.setClock(3200)
  const pill = h.project()
  assert.equal(pill.kind, 'streaming', 'turn 2 presents as the live pill')
  assert.equal(pill.turn, 2)
  h.tick(1)
  assert.equal(h.lastRender().turn, 2)

  return { cardA, cardAKey: cardA.projectionKey }
}

/**
 * Settle turn 2 with the ticker stopped, so no projection observes either half
 * of the settlement. Returns the instant `turn/end` was published.
 */
function settleSecondTurnInBackground(h, { usage = { inputTokens: 200, outputTokens: 60 } } = {}) {
  const rendersBefore = h.renders()
  const tickingBefore = h.isTicking()
  h.stop()
  assert.equal(h.isTicking(), false, 'the background tab has no presentation ticker')

  h.settle('b:1', 3400, { texts: ['second', ' turn'], usage })
  h.durable('step/end', 3460, { turn: 2, step: 1 })
  h.durable('turn/end', 3500, { turn: 2, reason: { kind: 'completed' } })

  assert.equal(h.renders(), rendersBefore, 'a settlement must not itself render: that is the whole background case')
  return { rendersBefore, tickingBefore }
}

test('turn 2 settles while presentation is stopped: the first projection is turn 2, never turn 1', () => {
  const h = harness()
  try {
    upToLiveSecondTurn(h)
    settleSecondTurnInBackground(h)

    /**
     * The durable evidence is the reference. If this is turn 2 while the card is
     * turn 1, the defect is in presentation; if this is turn 1, the defect is
     * upstream of it, in ingestion.
     */
    assert.equal(h.durableNewest()?.turn, 2, 'the store holds turn 2 as the newest settled turn')

    const first = h.project()
    assert.equal(first.turn, 2, 'the first projection after a background settlement must be the newest turn')
    assert.equal(first.kind, 'completed')
    assert.equal(first.projectionKey, `completed:${SESSION}:2`, 'the card identity is the newest settled turn')
  } finally {
    h.dispose()
  }
})

test('settlement arrives before the next scheduled tick and one tick after both renders the newest turn', () => {
  const h = harness()
  try {
    upToLiveSecondTurn(h)
    const { rendersBefore } = settleSecondTurnInBackground(h)

    // Nothing scheduled has run since the settlement: no tick has occurred.
    assert.equal(h.renders(), rendersBefore)

    // One presentation tick after both the settlement and turn/end.
    h.advanceClock(TICK_MS)
    h.start()
    h.tick(1)
    assert.equal(h.renders(), rendersBefore + 1, 'exactly one render happened, and it was the scheduled tick')
    const rendered = h.lastRender()
    assert.equal(rendered.kind, 'completed')
    assert.equal(rendered.turn, 2, 'one tick after settlement plus turn/end renders the newest turn')

    const direct = h.project()
    assert.equal(direct.turn, 2, 'the tick and a direct projection agree')
  } finally {
    h.dispose()
  }
})

test('the completed-view cache key follows the newest settled turn', () => {
  const h = harness()
  try {
    const { cardA } = upToLiveSecondTurn(h)
    settleSecondTurnInBackground(h)

    const cardB = h.project()
    assert.equal(cardB.turn, 2)
    assert.notEqual(cardB, cardA, 'a new settled turn is a new view object, not the cached previous card')
    assert.notEqual(cardB.projectionKey, cardA.projectionKey, 'the completed identity is per settled turn')
    assert.equal(cardB.projectionKey, `completed:${SESSION}:2`)

    /**
     * A settled view depends on nothing that ticks, so while nothing changes the
     * projection is memoized: turn 2's card is built once and reused, not rebuilt
     * per ingested event. This is the other half of the same contract — the cache
     * must be invalidated by a new settlement and *not* by a clock.
     */
    const again = h.project()
    assert.equal(again, cardB, 'an unchanged settled view is returned by identity, as the memo promises')
    h.advanceClock(TICK_MS * 5)
    assert.equal(h.project(), cardB, 'a moved clock does not rebuild a settled card')
  } finally {
    h.dispose()
  }
})

test('a settlement that arrives without ever being observed live still presents its own card', () => {
  const h = harness()
  try {
    upToLiveSecondTurn(h)
    h.stop()

    /**
     * The live tail has moved past turn 2's opening row: the client sees a
     * durable settlement and a terminal boundary for a turn it never opened,
     * which is the `turnEndLookupMiss` path. The card must still be turn 2 —
     * reconstructed from durable evidence — and never turn 1.
     */
    h.setTurn(2)
    h.settle('c:1', 3600, { texts: ['orphan', ' settlement'], usage: { inputTokens: 300, outputTokens: 70 }, at: 901 })
    h.durable('turn/end', 3650, { turn: 2, reason: { kind: 'completed' } })

    assert.equal(h.durableNewest()?.turn, 2)
    const card = h.project()
    assert.equal(card.kind, 'completed')
    assert.equal(card.turn, 2)
    assert.notEqual(card.projectionKey, `completed:${SESSION}:1`)
  } finally {
    h.dispose()
  }
})

test('projection is what advances the card: an unprojected settlement stays invisible until asked for', () => {
  const h = harness()
  try {
    upToLiveSecondTurn(h)
    settleSecondTurnInBackground(h)

    /**
     * The inverse statement, and the reason the recorded observation is about
     * *presentation*: the controller holds turn 2 immediately, but the page can
     * only show it when something projects. This is exactly why the first
     * projection after a background settlement is the observable event that
     * matters, and why the component must schedule one.
     */
    assert.equal(h.durableNewest()?.turn, 2, 'the evidence is already there')
    assert.equal(h.project().turn, 2, 'the first request for a view returns the newest turn')
  } finally {
    h.dispose()
  }
})
