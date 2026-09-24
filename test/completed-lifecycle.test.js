/**
 * Completed-card lifecycle: the live/completed handover, session isolation, the
 * durable-only (reload) reconstruction path, and the static-card guarantees.
 *
 * The unit under test is the controller's `project()`, which is the single place
 * the precedence rule lives: an open turn wins over a settled one, and the
 * handover happens inside one state advance rather than across two ticks.
 *
 * The reload case is the important one. `replayFixture` interleaves the recorded
 * transient plane with the durable plane, which is what a browser sees while it is
 * open **and** already had the turn observed live. A page that is loaded after the
 * turn finished never sees the transient plane at all; its window holds only the
 * durable rows, including the compact stream embedded in each settlement. Path B
 * (`durable-only`) below is that window.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { LiveUiState } from '../src/client/live/live-state.js'
import { completedViewModel } from '../src/client/ui-model.js'
import { QualityLevel } from '../src/core/quality-model.js'
import { loadFixture, listFixtures } from './helpers/fixtures.js'
import { durableSettledView, liveSettledView } from './helpers/equivalence.js'
import { durableEntry, fakeSessionsService, fixtureEntries, transientEntry } from './helpers/live-replay.js'

/** A window containing only the durable plane, in recorded order. */
function durableOnlyEntries(fixture) {
  return fixture.durable.map(row => ({ type: 'event', event: row.event }))
}

/**
 * Replay a window through a real controller and return its presentation sequence.
 * Every entry is published as an `append`, which is what a live tail does; the
 * initial `replace` pass is exercised separately below.
 */
function replayWindow(entries, sessionId) {
  const sessions = fakeSessionsService()
  const source = sessions.createSource(sessionId)
  const controller = createController({ sessions })
  assert.equal(controller.attach(sessionId), true)
  const views = []
  let revision = 1
  const nowMs = entries.length > 0
    ? Math.max(...entries.map(entry => Number(entry.event?.time) || 0))
    : 0
  views.push(controller.project(sessionId, nowMs))
  for (const entry of entries) {
    source.appendEntry(entry, (revision += 1))
    views.push(controller.project(sessionId, nowMs))
  }
  return { sessions, source, controller, views, nowMs, dispose: () => controller.dispose() }
}

test('durable-only window: a turn never observed live still produces the card', () => {
  for (const name of ['t1-reasoning-tool-reasoning', 't4-reasoning-tool-deepseek-official', 't5-reasoning-text-deepseek-official']) {
    const fixture = loadFixture(name)
    const entries = durableOnlyEntries(fixture)
    assert.equal(entries.some(entry => entry.type === 'transient'), false, 'no transient row may be present')

    const replay = replayWindow(entries, fixture.sessionId)
    try {
      const card = replay.views.at(-1)
      assert.equal(card.kind, 'completed', `${name}: the reload window must end in a card`)
      assert.equal(card.turn, 1)
      assert.equal(card.columns.length, 4)

      /**
       * The card must be the *same* card the live-observed path produces. Both
       * readings are compared through the view model, so a divergence is a
       * divergence about evidence rather than about formatting.
       */
      const fromLive = completedViewModel(liveSettledView(fixture).settled)
      assert.deepEqual(card.columns, fromLive.columns, `${name}: the two evidence paths must agree on the card`)
      assert.deepEqual(card.tools, fromLive.tools)
      assert.deepEqual(card.quality, fromLive.quality)
      assert.equal(card.status, fromLive.status)
      assert.equal(card.elapsedMs, fromLive.elapsedMs)
      assert.equal(card.attemptCount, fromLive.attemptCount)

      // And it agrees with path B reduced independently.
      const fromDurable = completedViewModel(durableSettledView(fixture).settled)
      assert.deepEqual(card.columns, fromDurable.columns)
    } finally {
      replay.dispose()
    }
  }
})

test('durable-only window: the attempts are restored from the embedded streams, not dropped', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const replay = replayWindow(durableOnlyEntries(fixture), fixture.sessionId)
  try {
    const record = [...replay.controller.store.turns.values()][0]
    assert.ok(record, 'the turn record exists from the durable boundary alone')
    assert.equal(record.attempts.length, 2, 'both settlements restored their attempt')
    for (const attempt of record.attempts) {
      assert.ok(attempt.samples.length > 0, 'a restored attempt carries its decoded samples')
      assert.equal(Number.isFinite(attempt.settlementSeq), true)
      assert.equal(attempt.usage !== null, true)
    }
    const diagnostics = replay.controller.diagnostics(fixture.sessionId)
    assert.equal(diagnostics.droppedDeltas, 0)
    assert.equal(diagnostics.unknownEvents, 0)
  } finally {
    replay.dispose()
  }
})

test('durable-only window: the interrupted fixture still reconstructs an interrupted card', () => {
  const fixture = loadFixture('t3-interrupted-mid-reasoning')
  const replay = replayWindow(durableOnlyEntries(fixture), fixture.sessionId)
  try {
    const card = replay.views.at(-1)
    assert.equal(card.kind, 'completed')
    assert.equal(card.status, 'interrupted')
    assert.equal(card.quality.tokenTotalQuality, QualityLevel.UNAVAILABLE)
    assert.equal(card.columns.find(column => column.key === 'generatedTokens').display, '—',
      'an interrupted turn with no usage is never given a fabricated total')
    assert.equal(card.columns.find(column => column.key === 'ttft').display, '4.98',
      'the TTFT survives the reload even when the token total does not')
    assert.deepEqual(
      card.columns,
      completedViewModel(liveSettledView(fixture).settled).columns,
      'the reload path and the live path agree on the interrupted card too',
    )
  } finally {
    replay.dispose()
  }
})

test('a reload that publishes the whole window as one `replace` reaches the same card', () => {
  const fixture = loadFixture('t5-reasoning-text-deepseek-official')
  const sessions = fakeSessionsService()
  const source = sessions.createSource(fixture.sessionId)
  const controller = createController({ sessions })
  controller.attach(fixture.sessionId)
  // The mount-time snapshot: one complete window, already settled.
  source.replaceEntries(durableOnlyEntries(fixture), 1)
  const card = controller.project(fixture.sessionId, 40_000)
  assert.equal(card.kind, 'completed')
  assert.equal(card.turn, 1)
  assert.deepEqual(card.columns, completedViewModel(durableSettledView(fixture).settled).columns)
  controller.dispose()
})

test('live -> completed is one advance: the next projection is the card, never a blank', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const entries = fixtureEntries(fixture)
  const sessions = fakeSessionsService()
  const source = sessions.createSource(fixture.sessionId)
  const controller = createController({ sessions })
  controller.attach(fixture.sessionId)

  let revision = 1
  const endIndex = entries.findIndex(entry => entry.type === 'event' && entry.event?.type === 'turn/end')
  assert.ok(endIndex > 0)
  for (const entry of entries.slice(0, endIndex)) source.appendEntry(entry, (revision += 1))

  const before = controller.project(fixture.sessionId, 5000)
  assert.equal(before.kind === 'hidden', false, 'the turn was live immediately before its end')

  source.appendEntry(entries[endIndex], (revision += 1))
  const after = controller.project(fixture.sessionId, 8085)
  assert.equal(after.kind, 'completed', 'the very next projection is the card')
  assert.equal(after.turn, 1)
  assert.equal(after.status, 'completed')
  assert.equal(controller.project(fixture.sessionId, 8085).kind, 'completed', 'and it stays the card')
  controller.dispose()
})

test('completed -> a new turn returns the pill immediately and never shows both', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const sessions = fakeSessionsService()
  const source = sessions.createSource(fixture.sessionId)
  const controller = createController({ sessions })
  controller.attach(fixture.sessionId)

  let revision = 1
  for (const entry of durableOnlyEntries(fixture)) source.appendEntry(entry, (revision += 1))
  assert.equal(controller.project(fixture.sessionId, 10_000).kind, 'completed')

  // The next user prompt opens turn 2.
  source.appendEntry(durableEntry('turn/start', 90, 20_000, { turn: 2 }), (revision += 1))
  const pending = controller.project(fixture.sessionId, 20_000)
  assert.equal(pending.kind, 'ttft', 'the new turn takes the slot as a first-token stopwatch')
  assert.equal(pending.turn, 2)
  assert.equal(controller.project(fixture.sessionId, 20_000).columns, undefined,
    'no card fields exist while a turn is open')

  // It streams, then settles into its own card.
  source.appendEntry(transientEntry('t2:1', 20_400, { type: 'text-delta', index: 0, text: 'second answer' }, { turn: 2 }), (revision += 1))
  const streaming = controller.project(fixture.sessionId, 20_400)
  assert.equal(['streaming', 'waiting'].includes(streaming.kind), true, 'the model side owns the slot again')
  assert.equal(streaming.kind === 'completed', false)
  /**
   * The settlement carries the same compact stream shape the real log does
   * (`text-chunks` with `dt` gaps), so this exercises the durable settlement the
   * way a recorded turn delivers it rather than a field-free stub.
   */
  source.appendEntry(
    durableEntry('assistant/message', 91, 20_900, {
      turn: 2,
      step: 1,
      message: { role: 'assistant', content: [] },
      stream: [
        { type: 'text-chunks', time0: 20_400, index: 0, dt: [200, 300], texts: ['second answer', ' done', '!'] },
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 12, reasoningTokens: 0 } } },
      ],
      usage: { inputTokens: 10, outputTokens: 12, reasoningTokens: 0 },
    }),
    (revision += 1),
  )
  source.appendEntry(durableEntry('turn/end', 92, 21_000, { turn: 2, reason: { kind: 'completed' } }), (revision += 1))
  const secondCard = controller.project(fixture.sessionId, 21_000)
  assert.equal(secondCard.kind, 'completed')
  assert.equal(secondCard.turn, 2, 'the card follows the newest settled turn')
  assert.equal(secondCard.columns.find(column => column.key === 'generatedTokens').value, 12)
  assert.equal(secondCard.attemptCount, 1, 'the new card describes the new turn only, not both turns')
  controller.dispose()
})

test('every live presentation tick yields a fresh view object, so one state update per tick is enough', () => {
  /**
   * Phase 5A removed a second `useReducer` dispatch from the meter's render
   * callback. That is only safe if `setView` always receives a *new identity*
   * while a turn is live — otherwise React would bail out of the update and the
   * clock would freeze. The projection key includes the presentation instant, so
   * this is the property that makes the removal provable rather than hopeful.
   */
  const fixture = loadFixture('t5-reasoning-text-deepseek-official')
  const entries = fixtureEntries(fixture)
  const sessions = fakeSessionsService()
  const source = sessions.createSource(fixture.sessionId)
  const controller = createController({ sessions })
  controller.attach(fixture.sessionId)
  let revision = 1
  // Stop short of the turn's end so the machine stays live.
  for (const entry of entries) {
    if (entry?.type === 'event' && entry.event?.type === 'turn/end') break
    source.appendEntry(entry, (revision += 1))
  }

  const liveAt = (atMs) => controller.project(fixture.sessionId, atMs)
  const first = liveAt(10_000)
  assert.equal(first.kind === 'hidden', false, 'the fixture is mid-turn at this instant')

  const identities = new Set()
  for (let index = 0; index < 40; index += 1) identities.add(liveAt(10_000 + index))
  assert.equal(identities.size, 40, 'each distinct instant is a distinct object: setView always schedules a render')

  /** The memo still collapses repeats at one instant; the clock is what bypasses it. */
  assert.equal(liveAt(10_000), liveAt(10_000), 'the same instant returns the same object')
  assert.notEqual(liveAt(10_000), liveAt(10_001), 'the next tick is a new object, so one setView is a real update')
  controller.dispose()
})

test('a completed card is not rebuilt once per ingested delta', () => {
  const fixture = loadFixture('t5-reasoning-text-deepseek-official')
  const entries = fixtureEntries(fixture)
  const sessions = fakeSessionsService()
  const source = sessions.createSource(fixture.sessionId)
  const controller = createController({ sessions })
  controller.attach(fixture.sessionId)
  let revision = 1
  for (const entry of entries) source.appendEntry(entry, (revision += 1))

  const first = controller.project(fixture.sessionId, 36_757)
  assert.equal(first.kind, 'completed')
  // Identity, not equality: the same object must come back, so a React state
  // update cannot fire for an unchanged static card.
  for (let index = 0; index < 50; index += 1) {
    assert.equal(controller.project(fixture.sessionId, 36_757 + index), first)
  }
  // Extra durable traffic after the turn closed changes nothing either.
  source.appendEntry(durableEntry('step/start', 900, 37_000, { turn: 1, step: 9 }), (revision += 1))
  assert.equal(controller.project(fixture.sessionId, 37_000), first, 'an unrelated late event does not rebuild the card')
  controller.dispose()
})

test('a second settled turn replaces the first card, and the cache follows the turn', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const sessions = fakeSessionsService()
  const source = sessions.createSource(fixture.sessionId)
  const controller = createController({ sessions })
  controller.attach(fixture.sessionId)
  let revision = 1
  for (const entry of fixtureEntries(fixture)) source.appendEntry(entry, (revision += 1))
  const first = controller.project(fixture.sessionId, 8085)
  assert.equal(first.turn, 1)

  source.appendEntry(durableEntry('turn/start', 90, 9000, { turn: 2 }), (revision += 1))
  source.appendEntry(transientEntry('n:1', 9100, { type: 'text-delta', index: 0, text: 'hi' }, { turn: 2 }), (revision += 1))
  source.appendEntry(durableEntry('turn/end', 91, 9200, { turn: 2, reason: { kind: 'completed' } }), (revision += 1))
  const second = controller.project(fixture.sessionId, 9200)
  assert.equal(second.kind, 'completed')
  assert.equal(second.turn, 2)
  assert.notEqual(second, first, 'a new settled turn is a new view object')
  assert.equal(controller.project(fixture.sessionId, 9200), second)
  controller.dispose()
})

test('session isolation: each session shows its own card and its own turn', () => {
  const sessions = fakeSessionsService()
  const sourceA = sessions.createSource('session-A')
  const sourceB = sessions.createSource('session-B')
  const controller = createController({ sessions })
  controller.attach('session-A')
  controller.attach('session-B')

  const fixtureA = loadFixture('t4-reasoning-tool-deepseek-official')
  const fixtureB = loadFixture('t5-reasoning-text-deepseek-official')
  let revision = 1
  for (const entry of durableOnlyEntries(fixtureA)) sourceA.appendEntry(entry, (revision += 1))
  for (const entry of durableOnlyEntries(fixtureB)) sourceB.appendEntry(entry, (revision += 1))

  const cardA = controller.project('session-A', 100_000)
  const cardB = controller.project('session-B', 100_000)
  assert.equal(cardA.kind, 'completed')
  assert.equal(cardB.kind, 'completed')
  assert.equal(cardA.sessionId, 'session-A')
  assert.equal(cardB.sessionId, 'session-B')
  assert.notDeepEqual(cardA.columns, cardB.columns, 'two sessions never share a card')
  assert.equal(cardA.columns.find(column => column.key === 'generatedTokens').value, 151)
  assert.equal(cardB.columns.find(column => column.key === 'generatedTokens').value, 1308)

  // A session with no observed turn keeps rendering nothing.
  sessions.createSource('session-C')
  assert.equal(controller.attach('session-C'), true)
  assert.deepEqual(controller.project('session-C', 100_000), { kind: 'hidden', state: 'inactive', turn: null })

  // An open turn in A does not disturb B's card.
  sourceA.appendEntry(durableEntry('turn/start', 900, 120_000, { turn: 2 }), (revision += 1))
  assert.equal(controller.project('session-A', 120_000).kind, 'ttft')
  assert.equal(controller.project('session-B', 120_000).kind, 'completed')
  assert.equal(controller.project('session-B', 120_000).columns.find(c => c.key === 'generatedTokens').value, 1308)
  controller.dispose()
})

test('every recorded fixture reaches a card through the durable window alone', () => {
  for (const name of listFixtures()) {
    const fixture = loadFixture(name)
    const replay = replayWindow(durableOnlyEntries(fixture), fixture.sessionId)
    try {
      const card = replay.views.at(-1)
      assert.equal(card.kind, 'completed', `${name}: no card`)
      assert.equal(['completed', 'interrupted', 'errored'].includes(card.status), true)
      assert.equal(card.columns.length, 4)
      assert.equal(card.sessionId, fixture.sessionId, `${name}: the card names its session`)
    } finally {
      replay.dispose()
    }
  }
})

test('a rebaseline drops live state but the rebuilt window still yields the card', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const sessions = fakeSessionsService()
  const source = sessions.createSource(fixture.sessionId)
  const controller = createController({ sessions })
  controller.attach(fixture.sessionId)
  let revision = 1
  for (const entry of fixtureEntries(fixture)) source.appendEntry(entry, (revision += 1))
  assert.equal(controller.project(fixture.sessionId, 10_581).kind, 'completed')

  // A window swap (reconnect) replays the durable plane from scratch.
  source.replaceEntries(durableOnlyEntries(fixture), (revision += 1))
  const after = controller.project(fixture.sessionId, 10_581)
  assert.equal(after.kind, 'completed', 'the card survives a rebaseline')
  assert.equal(after.turn, 1)
  assert.equal(after.columns.length, 4)
  assert.equal(
    controller.project(fixture.sessionId, 10_581),
    after,
    'and it is memoized again after the replay',
  )
  controller.dispose()
})

test('an abandoned attempt inside a turn does not block its card', () => {
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-abandon')
  const controller = createController({ sessions })
  controller.attach('s-abandon')
  let revision = 1
  source.appendEntry(durableEntry('turn/start', 1, 1000, { turn: 1 }), (revision += 1))
  source.appendEntry(transientEntry('a:1', 1100, { type: 'text-delta', index: 0, text: 'partial' }), (revision += 1))
  source.settleAssistant('a:1', undefined, (revision += 1))
  assert.equal(controller.project('s-abandon', 1200).kind, 'transition', 'a bare settlement is a neutral gap')
  source.appendEntry(durableEntry('turn/end', 2, 1300, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }), (revision += 1))
  const card = controller.project('s-abandon', 1300)
  assert.equal(card.kind, 'completed')
  assert.equal(card.status, 'interrupted', 'a turn whose only attempt was abandoned still reports its settlement status')
  controller.dispose()
})

test('a disposed controller renders nothing, card included', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const replay = replayWindow(durableOnlyEntries(fixture), fixture.sessionId)
  assert.equal(replay.views.at(-1).kind, 'completed')
  replay.dispose()
  assert.deepEqual(replay.controller.project(fixture.sessionId, 8085), { kind: 'hidden', state: 'inactive', turn: null })
})

test('the projection key of a completed card is its turn, and the live key is not static', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const entries = fixtureEntries(fixture)
  const replay = replayWindow(entries, fixture.sessionId)
  try {
    const streamed = replay.views.filter(view => view.kind === 'streaming')
    assert.ok(streamed.length > 0)
    assert.equal(LiveUiState.SETTLED, 'settled')
    const card = replay.views.at(-1)
    assert.equal(card.projectionKey, `completed:${fixture.sessionId}:1`)
  } finally {
    replay.dispose()
  }
})
