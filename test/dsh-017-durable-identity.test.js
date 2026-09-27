/**
 * Phase 7D.1.2 — durable seq identity is generation-wide.
 *
 * `SessionEventFeed` retains raw durable rows keyed by turn so a `turn/end` whose
 * opening row is outside the live tail can still be reconstructed, and it guards
 * ingestion with a duplicate check so a replayed window never double-counts. On
 * baseline `b188511e80653f2cb9d54a046fdeabe1fc0e1e4a` those two mechanisms held
 * **different** notions of which rows had been seen:
 *
 *   `DurableEvidencePool.seqs`        released a row's seq when its turn was evicted
 *   `SessionEventFeed.durableSeqs`    generation-wide, cleared only by `rebaseline()`
 *
 * and retention ran *before* the generation-wide duplicate check. A durable row
 * therefore had a window in which it was no longer a duplicate for retention but was
 * still a duplicate for ingestion:
 *
 *   1. retain turns 1..32 (seqs 1..32)
 *   2. admit turn 33 → turn 1 is evicted, and `pool.seqs` forgets seq 1
 *   3. replay `row(turn 1, seq 1)` in the same generation
 *   4. `retainDurable` re-admits it — a new row, a refreshed turn position, an
 *      incremented `retainedDurableEvents`, and one more turn in the pool
 *   5. only then `durableSeqs` rejects it as `DUPLICATE_DURABLE` and the normalized
 *      event is dropped
 *
 * The result was a row that ingestion refused still mutating retention, which
 * contradicts two frozen statements: "a duplicate seq does not count as activity",
 * and `retainedDurableEvents` = the unique durable rows admitted during the
 * generation. The second case below covers the other durable entry route —
 * `settle-assistant` carrying its entry — which had the same ordering and emitted a
 * second `attempt-settle` for a settlement it had already delivered.
 *
 * Since a duplicate is refused only when its seq is still in the retention set, the
 * reachable form of the defect is precisely the post-eviction one: a duplicate whose
 * row has already been released. (A duplicate of a *resident* row is refused before
 * the map is touched, and the third test pins that pre-existing behaviour rather than
 * replacing it.) The decisive assertion is therefore a **control comparison** — the
 * same legitimate evidence, delivered once with and once without the replayed row,
 * must leave the same turns resident. A counter or a row-count assertion would not
 * distinguish "the duplicate was re-admitted" from "it was refused", because a
 * re-admission that pushes the pool back to its bound is a no-op on both.
 *
 * Every case is driven through `applyWindow`, the real wire route. The defect is an
 * *ordering* interaction between retention and the generation-wide dedupe, so calling
 * `retainDurable` directly would step over exactly the seam under test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { FEED_ISSUE, MAX_RETAINED_TURNS, SessionEventFeed } from '../src/dsh/client-feed.js'

function makeFeed(sessionId = 'durable-identity') {
  const events = []
  const issues = []
  const feed = new SessionEventFeed({
    sessionId,
    onEvent: event => events.push(event),
    onIssue: issue => issues.push(issue),
  })
  return { feed, events, issues }
}

/** One raw durable row of `turn`, exactly the shape the retention pool keys on. */
function row(turn, seq, type = 'assistant/message') {
  return { type, seq, time: 1000 + seq, data: { turn, step: 1 } }
}

/** Wire entries for raw durable rows: `applyWindow` consumes `{type:'event', event}`. */
function entriesOf(rows) {
  return rows.map(event => ({ type: 'event', event }))
}

/** Turn numbers currently resident, ascending, read through the public surface. */
function residentTurns(feed, candidates) {
  return candidates.filter(turn => feed.turnEvents(turn).length > 0)
}

const ALL_32 = Array.from({ length: MAX_RETAINED_TURNS }, (_, index) => index + 1)

/** Establish a window generation whose complete contents are `rows`. */
function establish(feed, rows, revision) {
  feed.applyWindow({ entries: entriesOf(rows), revision, change: { kind: 'replace', entries: entriesOf(rows) } })
}

/** Append `rows` as one published change. */
function appendRows(feed, revision, rows) {
  feed.applyWindow({ entries: entriesOf(rows), revision, change: { kind: 'append', entries: entriesOf(rows) } })
}

/* ------------------------------------------------------------------ *
 * Route 1 — a duplicate appended as a window entry
 * ------------------------------------------------------------------ */

test('a duplicate appended after its turn was evicted cannot re-enter retention', () => {
  /**
   * §8 of the phase contract. Turn 1 is resident, then evicted by the admission of
   * turn 33; the same generation then replays its row, and four further turns are
   * admitted. Every observable the retention has must be untouched by that replay,
   * while ingestion reports it as the duplicate it is — the contradiction stated as
   * assertions rather than as prose.
   *
   * The extra turns are what make the mutation visible. A re-admitted duplicate puts
   * the pool one turn over its bound and therefore releases a turn that the identical
   * evidence without the replay would have kept — turn 5 in this trace, whose only
   * offence is to be admitted two steps later. The control below replays exactly the
   * legitimate rows, so it *is* "the same evidence delivered once".
   */
  const { feed, events, issues } = makeFeed('durable-identity-append')
  const { feed: control } = makeFeed('durable-identity-append-control')
  establish(feed, ALL_32.map(turn => row(turn, turn)), 1)
  establish(control, ALL_32.map(turn => row(turn, turn)), 1)
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'the bound is filled by turns 1..32')
  assert.equal(feed.counters.retainedDurableEvents, MAX_RETAINED_TURNS)

  /** Admission of turn 33 exceeds the bound, so the least recently updated turn goes. */
  appendRows(feed, 2, [row(33, 33)])
  appendRows(control, 2, [row(33, 33)])
  assert.deepEqual(feed.turnEvents(1), [], 'turn 1 was the least recently updated: it is gone')
  assert.equal(feed.turnEvents(2).length, 1, 'turn 2 is resident')
  assert.equal(feed.counters.retainedDurableEvents, 33, 'thirty-three distinct seqs were admitted')

  const residentsBefore = residentTurns(feed, [...ALL_32, 33])
  const counterBefore = feed.counters.retainedDurableEvents
  const normalizedBefore = events.length
  const issuesBefore = issues.length

  /** The replay: the same durable row, by seq, of a turn eviction has released. */
  const duplicate = [row(1, 1)]
  appendRows(feed, 3, duplicate)

  assert.deepEqual(feed.turnEvents(1), [], 'the duplicate did not re-admit turn 1 into retention')
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'and the pool is back at its bound')
  assert.deepEqual(
    residentTurns(feed, [...ALL_32, 33]),
    residentsBefore,
    'the resident set is what the eviction left: no legitimate turn is missing',
  )
  assert.equal(feed.counters.retainedDurableEvents, counterBefore, 'a refused duplicate is not an admission')

  /** The contradiction the defect produced: refused by ingestion, and yet effective. */
  const duplicates = issues.slice(issuesBefore).filter(issue => issue.kind === FEED_ISSUE.DUPLICATE_DURABLE)
  assert.equal(duplicates.length, 1, 'ingestion rejected the replay as a duplicate')
  assert.equal(duplicates[0].detail, 1, 'naming the seq that was already admitted')
  assert.equal(events.length, normalizedBefore, 'and emitted no normalized event for it')

  /**
   * The control. Four more turns are admitted to both feeds; the only difference
   * between them is whether the replayed row was delivered.
   */
  for (let revision = 4; revision <= 7; revision += 1) {
    const turn = revision + 30
    appendRows(feed, revision, [row(turn, turn)])
    appendRows(control, revision, [row(turn, turn)])
  }

  assert.deepEqual(
    residentTurns(feed, [...ALL_32, 33, 34, 35, 36, 37]),
    residentTurns(control, [...ALL_32, 33, 34, 35, 36, 37]),
    'the refused duplicate changed nothing about who is resident: the replayed evidence is not evidence',
  )
  assert.equal(
    feed.counters.retainedDurableEvents,
    control.counters.retainedDurableEvents,
    'nor about how much distinct evidence the generation admitted',
  )
})

/* ------------------------------------------------------------------ *
 * Route 2 — a duplicate carried by `settle-assistant`
 * ------------------------------------------------------------------ */

test('a duplicate settle-assistant entry is delivered once, and is not an admission', () => {
  /**
   * The same row can arrive by the other durable route: `settle-assistant` carrying
   * its entry, which DSH uses for interrupted messages and non-surface
   * `assistant/attempt` settlements. Delivering it twice must not produce a second
   * settlement — a repeated `attempt-settle` overwrites an attempt outcome that is
   * already committed — and, as for an appended duplicate, must not count as an
   * admission of its turn.
   */
  const { feed, events, issues } = makeFeed('durable-identity-settle')
  const seed = [row(1, 1, 'turn/start'), row(1, 2, 'step/start')]
  establish(feed, seed, 1)
  assert.equal(feed.counters.retainedDurableEvents, 2)

  const settlement = row(1, 10, 'assistant/message')
  const deliver = revision => feed.applyWindow({
    entries: entriesOf([...seed, settlement]),
    revision,
    change: { kind: 'settle-assistant', attemptId: 's:1', entry: { type: 'event', event: settlement } },
  })

  deliver(2)
  assert.deepEqual(feed.turnEvents(1).map(entry => entry.seq), [1, 2, 10], 'the settlement entry was retained')
  assert.equal(feed.counters.retainedDurableEvents, 3, 'and admitted once')
  assert.equal(events.filter(event => event.kind === 'attempt-settle').length, 1, 'and normalized into one settlement')

  const normalizedBefore = events.length
  const issuesBefore = issues.length

  /** The identical change again, in the same generation. */
  deliver(3)

  assert.deepEqual(feed.turnEvents(1).map(entry => entry.seq), [1, 2, 10], 'the row is retained exactly once')
  assert.equal(feed.counters.retainedDurableEvents, 3, 'and admitted exactly once')
  assert.equal(
    events.filter(event => event.kind === 'attempt-settle').length,
    1,
    'no second settlement is emitted for the same durable row',
  )
  assert.equal(events.length, normalizedBefore, 'the duplicate emits nothing at all')
  assert.ok(
    issues.slice(issuesBefore).some(issue => issue.kind === FEED_ISSUE.DUPLICATE_DURABLE),
    'and is diagnosed as the duplicate it is',
  )
})

/* ------------------------------------------------------------------ *
 * A duplicate of a resident row — the behaviour that was already correct
 * ------------------------------------------------------------------ */

test('a duplicate of a row still resident does not duplicate it or refresh its turn', () => {
  /**
   * The pre-Phase 7D.1.2 case, pinned so the fix cannot narrow it. Turns 1..32 are
   * resident with turn 1 least recently updated; a duplicate of turn 1 arrives and
   * turn 33 is then admitted. The refused duplicate must not have refreshed turn 1,
   * or turn 2 would be released in its place.
   */
  const { feed } = makeFeed('durable-identity-resident-duplicate')
  establish(feed, ALL_32.map(turn => row(turn, turn)), 1)
  appendRows(feed, 2, [row(1, 1)])

  assert.deepEqual(feed.turnEvents(1).map(entry => entry.seq), [1], 'the duplicate did not duplicate the row')

  appendRows(feed, 3, [row(33, 33)])

  assert.deepEqual(feed.turnEvents(1), [], 'turn 1 is still the oldest arrival, so turn 1 is released')
  assert.equal(feed.turnEvents(2).length, 1, 'and turn 2 was not released in its place')
  assert.deepEqual(
    residentTurns(feed, [...ALL_32, 33]),
    [...ALL_32.slice(1), 33],
    'the resident set is turns 2..33, exactly as if the duplicate had never been delivered',
  )
})

/* ------------------------------------------------------------------ *
 * Generation boundary — the complement
 * ------------------------------------------------------------------ */

test('a rebaseline permits the next generation to reuse a seq the previous one admitted', () => {
  /**
   * §9. Generation-wide identity must not become process-lifetime identity: the seen
   * set is scoped to the window generation, because DSH's seq numbering is only
   * distinct *within* one. A `replace` releases the retained rows and the fact that
   * their seqs were seen; the counter resets with the pool, and the same seq is
   * admissible again — as new evidence, not as a duplicate.
   */
  const { feed } = makeFeed('durable-identity-reuse')
  establish(feed, [row(1, 1), row(2, 2)], 1)
  assert.equal(feed.counters.retainedDurableEvents, 2)
  assert.deepEqual(feed.turnEvents(1).map(entry => entry.seq), [1], 'seq 1 was admitted in generation 1')

  const generation2 = [row(9, 1, 'turn/start')]
  establish(feed, generation2, 2)
  assert.equal(feed.counters.retainedDurableEvents, 1, 'the counter is scoped to the generation')
  assert.deepEqual(feed.turnEvents(9).map(entry => entry.seq), [1], 'seq 1 is admissible again in generation 2')

  /** And identity is live again there: the new generation refuses its own duplicate. */
  appendRows(feed, 3, [row(9, 1, 'turn/start')])
  assert.equal(feed.counters.retainedDurableEvents, 1, 'the new generation refuses its own duplicate')
  assert.deepEqual(feed.turnEvents(9).map(entry => entry.seq), [1], 'without duplicating the row')
})

/* ------------------------------------------------------------------ *
 * The counter's exact contract
 * ------------------------------------------------------------------ */

test('retainedDurableEvents counts distinct admitted seqs for the generation, and nothing else', () => {
  /**
   * §10, as a matrix: eviction does not decrement it; a duplicate does not increment
   * it, whether the original row is still resident or was evicted; an unkeyable row is
   * not an admission; a rebaseline resets it; and a seq reused in the next generation
   * is new evidence there. Each clause is one assertion, so a future change that
   * satisfies some of them and not others fails here rather than in a consumer.
   */
  const { feed } = makeFeed('durable-identity-counter')
  establish(feed, ALL_32.map(turn => row(turn, turn)), 1)
  assert.equal(feed.counters.retainedDurableEvents, MAX_RETAINED_TURNS, 'each distinct seq admitted once')

  /** eviction: no decrement */
  appendRows(feed, 2, [row(33, 33)])
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'a turn was released to stay in bounds')
  assert.equal(feed.counters.retainedDurableEvents, 33, 'and the counter did not fall with it')

  /** duplicate of a resident row: no increment */
  appendRows(feed, 3, [row(33, 33)])
  assert.equal(feed.counters.retainedDurableEvents, 33, 'a duplicate of a resident row is not an admission')
  assert.deepEqual(feed.turnEvents(33).map(entry => entry.seq), [33], 'and did not duplicate the row')

  /** duplicate of an evicted row: no increment */
  appendRows(feed, 4, [row(1, 1)])
  assert.equal(feed.counters.retainedDurableEvents, 33, 'nor is a duplicate of an evicted row')
  assert.deepEqual(feed.turnEvents(1), [], 'and it stays evicted')

  /** unkeyable row: no increment */
  feed.retainDurable({ type: 'assistant/message', seq: 99999, data: {} })
  assert.equal(feed.counters.retainedDurableEvents, 33, 'a row naming no turn cannot be retrieved, so it is not retained')

  /** rebaseline: reset to zero */
  establish(feed, [row(77, 1, 'turn/start')], 200)
  assert.equal(feed.counters.retainedDurableEvents, 1, 'the generation boundary resets the counter')
  for (const turn of ALL_32) assert.deepEqual(feed.turnEvents(turn), [], `turn ${turn} did not survive the rebaseline`)

  /** same seq in the new generation: a new increment is allowed */
  appendRows(feed, 201, [row(78, 2, 'turn/start')])
  assert.equal(feed.counters.retainedDurableEvents, 2, 'a seq admitted in the replayed generation counted as new evidence')
  assert.deepEqual(feed.turnEvents(78).map(entry => entry.seq), [2], 'and its row is retrievable')
})
