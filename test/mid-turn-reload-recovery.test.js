/**
 * Mid-turn reload recovery: the adopted turn boundary and its authoritative upgrade.
 *
 * The published session window is a live **tail**. A page that reloads (or reconnects,
 * which produces a `replace`) in the middle of a turn therefore holds no `turn/start`
 * row for the open turn, and the whole turn used to be invisible to that page instance:
 * `reduceLiveUi` discarded every turn-scoped event while `inactive`, and the controller
 * dropped deltas whose turn had no record.
 *
 * The repair has two halves, and this file is the boundary between them.
 *
 * The **synthetic** half derives the boundary from evidence the page does have: the
 * first transient row naming a turn the feed is not tracking is adopted
 * (`SessionEventFeed.adoptTurn`) and emitted as a `turn-start` carrying
 * `recovered: true` and `timeMs: null`. Every turn-scoped metric that depends on the
 * turn's start — elapsed, TTFT — is then unknown rather than measured from the reload,
 * and renders as absent rather than as `0 s`.
 *
 * The **authoritative** half is the one that must not be forgotten: the durable
 * `turn/start` can still enter this client afterwards, and it then carries the turn's
 * real start. `beginTurn` is idempotent (replaying a durable boundary must not discard
 * observed samples), so the upgrade is its own explicit step — `turnStartObserved` on
 * the store and on the meter. The tests below pin both directions of that step: an
 * unknown start is upgraded when the observation arrives, and an observed start is
 * never overwritten by a later synthetic one.
 *
 * The scenarios are driven through the real controller, feed, store and presenter, with
 * the fake session service reproducing the verified `SessionEventWindow` semantics, so
 * what is asserted is the shipped path rather than a restatement of it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { FEED_ISSUE, SessionEventFeed } from '../src/dsh/client-feed.js'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { LiveMeter } from '../src/core/live-metrics.js'
import { createController } from '../src/client/live/controller.js'
import { formatElapsed } from '../src/client/live/live-format.js'
import { liveViewModel, completedViewModel } from '../src/client/ui-model.js'
import { DASH } from '../src/client/format.js'
import { durableEntry, fakeSessionsService, transientEntry } from './helpers/live-replay.js'

/** The committed browser bundle, read once: the rendering layer's source of truth. */
const BUNDLE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const TURN = 42
const output = text => ({ type: 'text-delta', index: 0, text })
/** A 400-character delta weighs 100 estimated tokens (`heuristicTokenWeight`). */
const HEAVY = 'x'.repeat(400)

function collectFeed() {
  const events = []
  const issues = []
  const feed = new SessionEventFeed({
    sessionId: 's1',
    onEvent: event => events.push(event),
    onIssue: issue => issues.push(issue),
  })
  return { feed, events, issues }
}

/** The window a reloaded page sees: transient rows only, no `turn/start`. */
function replaceWithTail(feed, rows, revision = 1) {
  feed.applyWindow({ entries: rows, revision, change: { kind: 'replace', entries: rows } })
}

/** One live tail entry, as `MutableSessionEventSource` publishes an `append`. */
function appendRow(feed, row, revision) {
  feed.applyWindow({ entries: [row], revision, change: { kind: 'append', entries: [row] } })
}

const turnStartRow = (turn, time) => durableEntry('turn/start', turn, time, { turn })

/**
 * Drive the controller through the reload shape: attach on a window whose only row is a
 * transient delta of an untracked turn, then keep appending rows to that live tail.
 */
function reloadedMidTurn({ firstTime = 1100 } = {}) {
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s')
  const controller = createController({ sessions })
  controller.attach('s')
  let revision = 1
  const append = row => { source.appendEntry(row, (revision += 1)) }
  append(transientEntry('a:1', firstTime, output('mid'), { turn: TURN }))
  return { controller, source, append }
}

/* ------------------------------------------------------------------ feed level */

test('a recovered turn adopts an authoritative start when it is later observed', () => {
  const { feed, events } = collectFeed()

  /** Step 1-5: reload, no durable boundary in the window, first transient names turn 42. */
  replaceWithTail(feed, [transientEntry('s:1', 1100, output('mid'), { turn: TURN })])
  assert.deepEqual(events.map(event => event.kind), ['turn-start', 'attempt-start', 'attempt-delta'])
  assert.equal(events[0].turn, TURN)
  assert.equal(events[0].recovered, true, 'the boundary is synthetic and says so')
  assert.equal(events[0].timeMs, null, 'and it knows no start time')

  /**
   * Step 7: a real durable `turn/start` for the same turn is published into the window
   * (a reconnect, or the tail sliding back over the row). The boundary is no longer
   * synthetic, and it now carries the turn's true start.
   */
  events.length = 0
  appendRow(feed, turnStartRow(TURN, 1000), 2)
  const observed = events.find(event => event.kind === 'turn-start')
  assert.ok(observed !== undefined, 'the durable boundary reaches the controller')
  assert.equal(observed.turn, TURN)
  assert.equal(observed.timeMs, 1000, 'with the authoritative start time')
  assert.notEqual(observed.recovered, true, 'and it is an observation, not an adoption')
  assert.equal(observed.recovered, undefined)
})

test('the adopted boundary precedes its attempt and its first delta', () => {
  const { feed, events } = collectFeed()
  replaceWithTail(feed, [transientEntry('s:1', 1100, output('mid'), { turn: TURN })])

  /**
   * The order is the contract. An `attempt-start` emitted before the turn boundary
   * reaches a presenter whose machine is still `inactive`, where every turn-scoped
   * event is discarded as belonging to the wrong turn — the attempt boundary would be
   * lost and the first delta would open the machine with no attempt context.
   */
  assert.deepEqual(events.map(event => event.kind), ['turn-start', 'attempt-start', 'attempt-delta'])
  assert.equal(events[0].recovered, true)
  assert.equal(events[0].turn, TURN)
  assert.equal(events[1].turn, TURN, 'the attempt belongs to the adopted turn')
  assert.equal(events[1].attemptId, 's:1')
  assert.equal(events[2].turn, TURN)
  assert.equal(events[2].attemptId, 's:1')
  assert.ok(events[0].timeMs === null && events[0].timeMs < events[1].timeMs,
    'the synthetic boundary carries no instant, so it cannot be mistaken for one')
})

test('one recovered turn is adopted exactly once however many transient rows arrive', () => {
  const { feed, events } = collectFeed()
  replaceWithTail(feed, [transientEntry('s:1', 1100, output('a'), { turn: TURN })])
  assert.equal(events.filter(event => event.kind === 'turn-start').length, 1)

  /** Ten thousand further rows of the same turn: same record, no second boundary. */
  const rows = []
  for (let index = 0; index < 10_000; index += 1) {
    const row = transientEntry('s:1', 1200 + index, output('x'), { turn: TURN })
    rows.push(row)
    appendRow(feed, row, index + 2)
  }
  const turnStarts = events.filter(event => event.kind === 'turn-start')
  assert.equal(turnStarts.length, 1, 'a turn opens once; a delta is not a boundary')
  assert.equal(turnStarts[0].recovered, true)
  assert.equal(events.filter(event => event.kind === 'attempt-start').length, 1,
    'and the attempt identity is unchanged across all of them')
  assert.equal(events.filter(event => event.kind === 'attempt-delta').length, 10_001,
    'every row still arrives as its own delta')
  assert.equal(feed.issues.length, 0)
  void rows
})

test('an unknown transient without turn identity is still dropped, never guessed', () => {
  const { feed, events } = collectFeed()
  const row = transientEntry('s:1', 1100, output('x'), { turn: null })
  replaceWithTail(feed, [row])
  assert.equal(events.some(event => event.kind === 'turn-start'), false,
    'a row with no turn cannot name a turn to adopt')
  assert.deepEqual(events.map(event => event.kind), ['attempt-start', 'attempt-delta'])
  assert.equal(feed.highestTurn, null, 'and no turn number was recorded from it')

  /** A non-finite turn is not an identity either. */
  for (const turn of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
    const other = collectFeed()
    /** Built raw, because the shared helper defaults an absent turn to 1. */
    const bad = {
      type: 'transient',
      event: { type: 'assistant/live-chunk', seq: 1, time: 1200, data: { attemptId: 's:1', turn, step: 1, chunk: output('y') } },
    }
    replaceWithTail(other.feed, [bad])
    assert.equal(other.events.some(event => event.kind === 'turn-start'), false, `turn ${String(turn)} adopts nothing`)
    assert.equal(other.feed.highestTurn, null, `turn ${String(turn)} is not an ordering watermark`)
  }
})

test('a closed turn is never re-opened by a late transient row, but a future turn is adopted', () => {
  const { feed, events, issues } = collectFeed()
  const ending = [
    transientEntry('s:1', 1100, output('a'), { turn: TURN }),
    durableEntry('turn/end', 9, 1400, { turn: TURN, reason: { kind: 'completed' } }),
  ]
  replaceWithTail(feed, ending)
  assert.equal(events.filter(event => event.kind === 'turn-end').length, 1)

  /**
   * Late evidence of the closed turn is dropped and recorded. It must not create a second
   * boundary (which would re-open `waiting-model` and re-show a live meter for a turn the
   * session ended), and it must not be re-attached to the settled record either.
   */
  events.length = 0
  issues.length = 0
  appendRow(feed, transientEntry('s:1', 1500, output('late'), { turn: TURN }), 2)
  assert.equal(events.some(event => event.kind === 'turn-start'), false,
    'the closed turn is not adopted again')
  assert.equal(events.some(event => event.kind === 'attempt-delta' && event.turn === TURN), false,
    'and its late delta is not delivered into the settled record')
  assert.deepEqual(events, [], 'nothing at all is emitted for a row of a finished turn')
  assert.deepEqual(issues.map(issue => issue.kind), [FEED_ISSUE.LATE_TURN_ROW],
    'the drop is reported as evidence rather than happening silently')

  /**
   * The guard is per turn identity, not a global "no adoption after a `turn/end`": turn
   * 43 is future evidence and must be adopted normally. A global rule would leave the
   * rest of the session invisible.
   */
  events.length = 0
  appendRow(feed, transientEntry('s:2', 1600, output('next'), { turn: TURN + 1 }), 3)
  assert.deepEqual(events.map(event => event.kind), ['turn-start', 'attempt-start', 'attempt-delta'])
  assert.equal(events[0].turn, TURN + 1)
  assert.equal(events[0].recovered, true)
})

test('a late frame of a superseded turn does not re-adopt it', () => {
  const { feed, events, issues } = collectFeed()
  replaceWithTail(feed, [transientEntry('s:1', 1100, output('a'), { turn: TURN })])
  appendRow(feed, transientEntry('s:2', 1200, output('b'), { turn: TURN + 1 }), 2)
  assert.equal(events.filter(event => event.kind === 'turn-start').length, 2, 'the second turn opens')

  events.length = 0
  issues.length = 0
  appendRow(feed, transientEntry('s:3', 1300, output('c'), { turn: TURN }), 3)
  assert.equal(events.some(event => event.kind === 'turn-start'), false,
    'a stale row of the previous turn cannot reopen it: the open turn is 43')
  assert.deepEqual(issues.map(issue => issue.kind), [FEED_ISSUE.LATE_TURN_ROW],
    'and the stale row is recorded as a drop rather than silently re-attached')
})

/* ------------------------------------------------------------- controller level */

test('a reloaded page recovers the live meter with an unknown elapsed and TTFT', () => {
  const { controller, append } = reloadedMidTurn()
  append(transientEntry('a:1', 1200, output(HEAVY), { turn: TURN }))
  /** Read while the newest delta is still inside the one-second window. */
  const view = controller.project('s', 1200)

  assert.equal(view.kind, 'streaming', 'the adopted turn renders its live pill')
  assert.equal(view.turn, TURN)
  assert.equal(view.elapsedMs, null, 'the turn start was not observed, so the elapsed run is omitted')
  assert.equal(controller.diagnostics('s').droppedDeltas, 0, 'and no delta was dropped for lack of a turn')
  assert.equal(controller.store.turns.size, 1, 'exactly one turn record exists')

  const snapshot = controller.store.liveSnapshot('s', 1200)
  assert.equal(snapshot.turnElapsedMs, null, 'elapsed is unknown, never the time since the reload')
  assert.equal(snapshot.ttftMs, null, 'TTFT is unknown: the reload instant is not the turn start')
  assert.ok(snapshot.tps > 0, 'the trailing rate is measurable from the deltas the page did observe')

  /** Long after the last observed delta the rate goes quiet again, as it must. */
  assert.equal(controller.store.liveSnapshot('s', 5200).tps, 0,
    'an empty trailing window is a measured zero, not a stale rate')
  assert.equal(controller.store.liveSnapshot('s', 5200).turnElapsedMs, null,
    'and the elapsed stays unknown however long the page watches')
  controller.dispose()
})

test('the live elapsed and TTFT are measured once the durable start is observed', () => {
  const { controller, append } = reloadedMidTurn()
  assert.equal(controller.project('s', 5200).elapsedMs, null)

  /** The durable boundary finally enters this client's evidence. */
  append(turnStartRow(TURN, 1000))
  const view = controller.project('s', 5200)

  assert.equal(view.kind, 'streaming', 'the same turn, still open')
  assert.equal(view.elapsedMs, 4200, 'elapsed is now measured from the observed turn start')
  const snapshot = controller.store.liveSnapshot('s', 5200)
  assert.equal(snapshot.ttftMs, 100, 'and TTFT is the observed first delta minus the observed start')
  assert.equal(controller.store.turns.size, 1, 'the upgrade reuses the record: no second turn was created')
  const record = [...controller.store.turns.values()][0]
  assert.equal(record.startMs, 1000, 'the record start was upgraded in place')
  controller.dispose()
})

test('an observed start is never downgraded by later synthetic evidence', () => {
  const { controller, append } = reloadedMidTurn()
  append(turnStartRow(TURN, 1000))
  const record = [...controller.store.turns.values()][0]
  assert.equal(record.startMs, 1000)

  /**
   * The only synthetic boundary that exists is the adoption itself, which happens once and
   * only when the turn is first seen. Even so, the store is asserted directly: the upgrade
   * is one-way, so no path — present or future — can return an observed start to unknown.
   */
  const store = new TurnTelemetryStore()
  const fresh = store.beginTurn({ sessionId: 's2', turn: 7, timeMs: 1000 })
  assert.equal(store.turnStartObserved(fresh, { timeMs: null }), false, 'a null start is not evidence')
  assert.equal(fresh.startMs, 1000, 'authority can only be added, never withdrawn')
  assert.equal(store.turnStartObserved(fresh, { timeMs: 5000 }), false, 'nor is a later finite value a new start')
  assert.equal(fresh.startMs, 1000, 'a turn has exactly one start, and the first observation is it')
  assert.equal(store.live('s2').turnStartMs, 1000)
  controller.dispose()
})

test('the meter upgrades an unknown turn start without restarting the window', () => {
  const meter = new LiveMeter({ windowMs: 1000 })
  meter.turnStarted({ turn: TURN, timeMs: null })
  meter.attemptStarted({ attemptId: 'a:1', step: 1, timeMs: 1100 })
  meter.acceptSample({ timeMs: 1100, phase: 'output', weight: 100, attemptId: 'a:1' })

  assert.equal(meter.snapshot(1200).turnElapsedMs, null)
  assert.equal(meter.snapshot(1200).ttftMs, null)
  assert.equal(meter.snapshot(1200).tps, 100, 'the window is rolling on the observed deltas')

  assert.equal(meter.turnStartObserved({ turn: TURN, timeMs: 1000 }), true)
  const upgraded = meter.snapshot(1200)
  assert.equal(upgraded.turnElapsedMs, 200, 'elapsed is recomputed from the observed start')
  assert.equal(upgraded.ttftMs, 100, 'and TTFT is the same first delta against the same start')
  assert.equal(upgraded.tps, 100, 'the rolling window was not reset by the upgrade')

  /** Idempotent, and closed to a turn the meter is not tracking. */
  assert.equal(meter.turnStartObserved({ turn: TURN, timeMs: 1000 }), false)
  assert.equal(meter.turnStartObserved({ turn: TURN + 1, timeMs: 1000 }), false)
  assert.equal(meter.turnStartObserved({ turn: null, timeMs: 1000 }), false)
  assert.equal(meter.turnStartObserved({ turn: TURN, timeMs: Number.NaN }), false)
  assert.equal(meter.snapshot(1200).turnElapsedMs, 200)
})

test('a completed card reports TTFT from an observed start and unavailable without one', () => {
  /**
   * Case A: the authoritative `turn/start` did enter this client's evidence. The card's
   * TTFT is then `first model-producing delta - turn/start`, over exactly the two
   * observations that define it — not over the reload.
   */
  const withStart = new TurnTelemetryStore()
  const observed = withStart.beginTurn({ sessionId: 'sA', turn: TURN, timeMs: 1000 })
  const attemptA = withStart.beginAttempt(observed, { attemptId: 'a:1', step: 1, startedAtMs: 1100 })
  withStart.acceptChunk(observed, attemptA, { timeMs: 1250, chunk: output(HEAVY) })
  withStart.settleAttempt(attemptA, {
    settledAtMs: 1400,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  const settledA = withStart.endTurn(observed, { timeMs: 2000, status: 'completed' })
  assert.equal(settledA.ttftMs, 250, 'first delta 1250 minus turn start 1000')
  assert.equal(settledA.turnElapsedMs, 1000)
  assert.equal(cardColumn(settledA, 'ttft').value, 250)

  /**
   * Case B: the turn started before the page attached and the durable `turn/start` never
   * entered this client, even though the settlement did carry absolute stream timestamps.
   * A stream timestamp proves *when a delta was produced*, never when the turn started, so
   * the card must report TTFT as unavailable. Deriving it from the settlement would
   * silently substitute "time from the reload" for the metric.
   */
  const withoutStart = new TurnTelemetryStore()
  const adopted = withoutStart.beginTurn({ sessionId: 'sB', turn: TURN, timeMs: null })
  const attemptB = withoutStart.beginAttempt(adopted, { attemptId: 'a:1', step: 1, startedAtMs: 1100 })
  withoutStart.acceptChunk(adopted, attemptB, { timeMs: 1250, chunk: output(HEAVY) })
  withoutStart.settleAttempt(attemptB, {
    settledAtMs: 1400,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { inputTokens: 10, outputTokens: 100 },
    settlementSeq: 9,
  })
  const settledB = withoutStart.endTurn(adopted, { timeMs: 2000, status: 'completed' })
  assert.equal(settledB.turnStartMs, null, 'the start was never observed')
  assert.equal(settledB.ttftMs, null, 'so TTFT is unavailable, not approximate and not zero')
  assert.equal(settledB.turnElapsedMs, null, 'and elapsed is unavailable with it')
  /**
   * The curve is unaffected, and deliberately so: its coordinates come from the attempt's own
   * samples, whose absolute timestamps the page *did* observe. An unknown turn start therefore
   * removes two turn-level metrics without touching the evidence behind the chart.
   */
  assert.equal(settledB.curve.series.flatMap(entry => entry.runs).length > 0, true,
    'the chart is still built from the samples the page observed')
  assert.ok(settledB.generatedTokens > 0, 'the rest of the card is unaffected: the evidence that exists is still reported')

  const card = completedViewModel(settledB)
  assert.ok(card !== null)
  const ttft = card.columns.find(column => column.key === 'ttft')
  assert.equal(ttft.value, null, 'the column carries no value at all')
  assert.equal(ttft.available, false, 'and is marked unavailable rather than exact')
  assert.equal(ttft.display, DASH, 'and it renders as an em dash, never as a number')
  assert.equal(ttft.unit, null)
})

/* ------------------------------------------------- nullable elapsed, end to end */

test('an unknown turn elapsed stays null through the view model and the formatter', () => {
  const { controller, append } = reloadedMidTurn()
  const view = controller.project('s', 5200)
  assert.equal(view.elapsedMs, null, 'the presenter publishes an unknown elapsed as null, never as 0')

  const snapshot = controller.store.liveSnapshot('s', 5200)
  assert.equal(liveViewModel(snapshot).turnElapsed.value, null,
    'and the pure view model carries the same absence rather than a zero')

  /**
   * `formatElapsed` is the last stop before the DOM, and it renders an absent value as an em
   * dash. The pill does not even reach it — it omits the elapsed run when the value is not
   * finite (`elapsedRun` in `LiveMeter.js`) — so no path exists by which a `0.00 s` could be
   * printed for a turn whose start was never observed.
   */
  assert.equal(formatElapsed(null), DASH)
  assert.equal(formatElapsed(undefined), DASH)
  assert.equal(formatElapsed(Number.NaN), DASH)
  assert.notEqual(formatElapsed(null), formatElapsed(0), 'unknown and zero are different renderings')

  /**
   * The bundle is checked structurally as well, because the pill's React tree cannot be
   * imported in Node (the client half requires `react` from the DSH module table): the
   * fabricated zero was a `?? 0` coalesce at exactly these call sites, and it is gone.
   */
  assert.equal(/formatElapsed\(view\.elapsedMs[^)]*\)/.test(BUNDLE), true,
    'the elapsed run formats the presenter value directly')
  assert.equal(/formatElapsed\(view\.elapsedMs \?\? 0\)/.test(BUNDLE), false,
    'and never coalesces an unknown elapsed to zero')

  /** Once the start is observed, the same value becomes a measured duration. */
  append(turnStartRow(TURN, 1000))
  assert.equal(controller.project('s', 5200).elapsedMs, 4200)
  assert.equal(formatElapsed(controller.project('s', 5200).elapsedMs), '4.2s')
  assert.equal(liveViewModel(controller.store.liveSnapshot('s', 5200)).turnElapsed.available, true)
  controller.dispose()
})

/* -------------------------------------------------------------------- helpers */

/** One column of the completed card, by key. */
function cardColumn(settled, key) {
  const view = completedViewModel(settled)
  assert.ok(view !== null, 'the settled snapshot must produce a card')
  const column = view.columns.find(candidate => candidate.key === key)
  assert.ok(column !== undefined, `the card must have a ${key} column`)
  return column
}
