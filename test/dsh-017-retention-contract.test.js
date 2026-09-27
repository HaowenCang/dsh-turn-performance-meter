/**
 * Phase 7D.1.1 — the durable-evidence retention contract.
 *
 * `SessionEventFeed` retains every durable row of the current window generation,
 * keyed by turn, so a `turn/end` published for a turn whose opening `turn/start` is
 * outside the live tail can be reconstructed from real evidence instead of closing
 * an empty record. The retention is a bounded memory structure, and a bounded
 * structure has an eviction policy — which is a contract, not an implementation
 * detail, because the consumer depends on *which* evidence survives.
 *
 * The policy this file pins is **least-recently-updated**: when admitting a turn
 * would exceed `MAX_RETAINED_TURNS`, the retained turn with the oldest last arrival
 * is released, and recording another durable row of a turn refreshes that turn's
 * position. The choice follows from the consumer: the turn a `turn/end` miss can ask
 * about is a turn that was publishing evidence moments earlier, so under this policy
 * it is always the most recently refreshed entry and never the eviction candidate.
 *
 * On baseline `dd4b194a349fe9a3dd9b126bd84241dff82221c7` the *implementation* already
 * behaved this way — `record()` deletes the turn's key before re-inserting it, and a
 * JavaScript `Map` iterates in insertion order — but the code comments, the module
 * docstring and three project documents all described the opposite policy
 * ("oldest turn evicted first", "re-recording preserves its original position",
 * "first-seen order"). Implementation and documentation disagreed, so the contract
 * was undecidable from the repository. These tests make the implemented policy the
 * stated one and the stated one testable.
 *
 * The eviction assertions are deliberately observable through the public surface
 * (`retainedTurnCount()`, `turnEvents()`) rather than through the pool's internals,
 * so they constrain the shipped behaviour rather than a private field.
 *
 * Two routes reach the retention, and this file uses both for what each one is able to
 * show. `retainDurable(row)` is the storage primitive: it retains exactly the row it is
 * given, which is what makes capacity and ordering assertions readable as arithmetic.
 * `applyWindow(...)` is the wire route, and it is the only route that also *admits* —
 * a durable `seq` is recorded as seen at admission, before retention is attempted, so a
 * duplicate is refused there and never reaches the pool at all. Where a test is about a
 * duplicate, it goes through `applyWindow`; the pool-level cases that must be pinned
 * past eviction live in `dsh-017-durable-identity.test.js`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { MAX_RETAINED_TURNS, SessionEventFeed } from '../src/dsh/client-feed.js'

function makeFeed() {
  const events = []
  const issues = []
  const feed = new SessionEventFeed({
    sessionId: 'retention-session',
    onEvent: event => events.push(event),
    onIssue: issue => issues.push(issue),
  })
  return { feed, events, issues }
}

/** One raw durable row of `turn`, exactly the shape the pool keys on. */
function row(turn, seq, type = 'assistant/message') {
  return { type, seq, time: 1000 + seq, data: { turn, step: 1 } }
}

/** Retain `rows` through the feed's own public entry point. */
function retainAll(feed, rows) {
  for (const retained of rows) feed.retainDurable(retained)
}

/**
 * Wrap raw durable rows as window entries.
 *
 * `applyWindow` consumes the wire shape — `{type:'event', event}` — not bare
 * `SessionEvent` rows, so a test that establishes a generation through the real
 * window route has to wrap them; feeding bare rows would be reported as malformed
 * entries and nothing would be retained.
 */
function windowEntries(rows) {
  return rows.map(retained => ({ type: 'event', event: retained }))
}

/** Turn numbers currently resident, ascending, read through the public surface. */
function residentTurns(feed, candidates) {
  return candidates.filter(turn => feed.turnEvents(turn).length > 0)
}

const ALL_32 = Array.from({ length: MAX_RETAINED_TURNS }, (_, index) => index + 1)

/* ------------------------------------------------------------------ *
 * Capacity
 * ------------------------------------------------------------------ */

test('retainedTurnCount never exceeds MAX_RETAINED_TURNS', () => {
  const { feed } = makeFeed()
  assert.equal(MAX_RETAINED_TURNS, 32, 'the bound under test is the documented one')

  for (let turn = 1; turn <= MAX_RETAINED_TURNS; turn += 1) {
    feed.retainDurable(row(turn, turn))
    assert.equal(feed.retainedTurnCount(), turn, `after turn ${turn}`)
  }
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'exactly at the bound')

  /** Every further turn evicts one predecessor: the bound is a hard ceiling. */
  for (let turn = MAX_RETAINED_TURNS + 1; turn <= MAX_RETAINED_TURNS * 3; turn += 1) {
    feed.retainDurable(row(turn, turn))
    assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, `still bounded after turn ${turn}`)
  }

  /** Rows within one turn are unbounded by this structure, and that is the stated budget. */
  const rowsOfOneTurn = 200
  for (let index = 0; index < rowsOfOneTurn; index += 1) feed.retainDurable(row(999, 10000 + index))
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'a heavy turn costs one slot, not one slot per row')
})

/* ------------------------------------------------------------------ *
 * The eviction policy itself
 * ------------------------------------------------------------------ */

test('the evicted turn is the least recently updated one, not the first one seen', () => {
  /**
   * The decisive case. After turns 1..32, turn 1 receives another durable row and
   * turn 33 arrives. First-seen FIFO must evict turn 1 (it was seen first);
   * least-recently-updated must evict turn 2 (its last arrival is the oldest).
   */
  const { feed } = makeFeed()
  retainAll(feed, ALL_32.map(turn => row(turn, turn)))
  feed.retainDurable(row(1, 100, 'tool/result'))

  assert.deepEqual(feed.turnEvents(1).map(retained => retained.seq), [1, 100], 'turn 1 holds both its rows, in arrival order')
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'refreshing a resident turn costs no slot')

  feed.retainDurable(row(33, 200))

  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS)
  assert.deepEqual(feed.turnEvents(2), [], 'turn 2 was evicted: its last arrival was the oldest')
  assert.deepEqual(feed.turnEvents(1).map(retained => retained.seq), [1, 100], 'the refreshed turn survived')
  assert.deepEqual(feed.turnEvents(33).map(retained => retained.seq), [200], 'the new turn was admitted')
  assert.deepEqual(
    residentTurns(feed, [...ALL_32, 33]),
    [1, ...ALL_32.slice(2), 33],
    'exactly turn 2 left: the resident set is turn 1 plus turns 3..33',
  )
})

test('a turn that keeps publishing evidence is never evicted by the bookkeeping', () => {
  /**
   * The property the policy exists for. A long-running turn is interleaved with 64
   * short turns — twice the bound — and must remain resident throughout, because
   * every one of its own rows refreshes it and it is never the oldest last arrival
   * for longer than one admission.
   */
  const { feed } = makeFeed()
  const longTurn = 1
  let seq = 1

  feed.retainDurable(row(longTurn, seq++, 'turn/start'))
  for (let turn = 2; turn <= 65; turn += 1) {
    feed.retainDurable(row(turn, seq++))
    feed.retainDurable(row(longTurn, seq++, 'step/start'))
    assert.equal(feed.retainedTurnCount() <= MAX_RETAINED_TURNS, true, `bounded after turn ${turn}`)
    assert.equal(feed.turnEvents(longTurn).length > 0, true, `the long turn is still resident after turn ${turn}`)
  }

  const retained = feed.turnEvents(longTurn)
  assert.equal(retained.length, 65, 'every row of the long turn was kept')
  /** The long turn's own sequence numbers: 1, then one per short turn, interleaved. */
  assert.deepEqual(
    retained.map(entry => entry.seq),
    Array.from({ length: 65 }, (_, index) => index * 2 + 1),
    'in arrival order',
  )
  assert.equal(retained[0].type, 'turn/start', 'including the opening boundary the reconstruction needs')
})

test('an evicted turn reports no evidence at all', () => {
  /**
   * The consumer's contract: `turnEvents(turn)` answers `[]` for a turn whose
   * evidence was released, which is what makes the caller reconstruct an empty turn
   * rather than a turn assembled from a neighbour's rows. An out-of-range or
   * non-numeric turn answers the same way.
   *
   * The arithmetic matters here. Forty rows are admissions of *one* turn, so they
   * occupy one slot; the turns then admitted are 2..33, which is 33 slots' worth and
   * therefore one eviction. The released turn is the least recently updated resident,
   * which is turn 1 — the turn holding all forty rows.
   */
  const { feed } = makeFeed()
  const rows = []
  for (let index = 0; index < 40; index += 1) rows.push(row(1, index + 1))
  retainAll(feed, rows)
  assert.equal(feed.turnEvents(1).length, 40, 'the turn is resident')
  assert.equal(feed.retainedTurnCount(), 1, 'as a single slot, however many rows it holds')

  for (let turn = 2; turn <= MAX_RETAINED_TURNS + 1; turn += 1) feed.retainDurable(row(turn, 1000 + turn))

  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'the bound is respected')
  assert.deepEqual(feed.turnEvents(1), [], 'turn 1 was the least recently updated and is gone')
  assert.equal(feed.turnEvents(2).length, 1, 'turn 2 is resident: only one turn had to be released')
  assert.equal(feed.turnEvents(MAX_RETAINED_TURNS + 1).length, 1, 'and the newest turn is present')
  assert.deepEqual(
    residentTurns(feed, Array.from({ length: MAX_RETAINED_TURNS + 1 }, (_, index) => index + 1)),
    Array.from({ length: MAX_RETAINED_TURNS }, (_, index) => index + 2),
    'the resident set is exactly turns 2..33',
  )
  assert.deepEqual(feed.turnEvents(9999), [], 'an unknown turn has no evidence')
  assert.deepEqual(feed.turnEvents(null), [], 'a non-numeric turn has no evidence')
})

/* ------------------------------------------------------------------ *
 * What retention must not change
 * ------------------------------------------------------------------ */

test('a surviving turn returns its rows in durable arrival order, interleaved arrivals included', () => {
  const { feed } = makeFeed()
  const arrivals = [
    row(1, 7, 'turn/start'),
    row(2, 8, 'turn/start'),
    row(1, 9, 'step/start'),
    row(3, 10, 'turn/start'),
    row(1, 11, 'assistant/message'),
    row(2, 12, 'assistant/message'),
    row(1, 13, 'tool/call'),
  ]
  retainAll(feed, arrivals)

  assert.deepEqual(feed.turnEvents(1).map(entry => entry.seq), [7, 9, 11, 13], 'turn 1: its own rows, arrival order')
  assert.deepEqual(feed.turnEvents(2).map(entry => entry.seq), [8, 12], 'turn 2: likewise, despite interleaving')
  assert.deepEqual(feed.turnEvents(3).map(entry => entry.seq), [10])
  assert.deepEqual(
    feed.turnEvents(1).map(entry => entry.type),
    ['turn/start', 'step/start', 'assistant/message', 'tool/call'],
    'the raw rows are stored undecoded and unreordered',
  )
  assert.equal(feed.turnEvents(1)[0], arrivals[0], 'the retained object is the one that arrived, by identity')
})

test('a duplicate seq neither duplicates a row nor refreshes its turn', () => {
  /**
   * Two separate guarantees. A replayed row must not appear twice in `turnEvents`,
   * and — because a duplicate is refused at admission, before retention is touched —
   * it must not count as activity either. Otherwise replaying one generation's rows in
   * order would refresh every turn in replay order and could evict a turn that the
   * same evidence delivered once would have kept.
   *
   * The observable consequence is the eviction victim. Turns 1..32 are resident and
   * their last arrivals are in that order, so admitting turn 33 releases turn 1 —
   * unless a re-delivered row of turn 1 had refreshed it, in which case turn 2 would
   * be released instead.
   *
   * The replay travels the real `append` route rather than calling `retainDurable`
   * directly: admission is what refuses a duplicate, and `retainDurable` is the
   * storage primitive *below* that gate (see `dsh-017-durable-identity.test.js` for
   * the post-eviction case, where the row itself has been released).
   */
  const { feed } = makeFeed()
  const generation = ALL_32.map(turn => row(turn, turn))
  feed.applyWindow({ entries: windowEntries(generation), revision: 1, change: { kind: 'replace', entries: windowEntries(generation) } })

  const replayed = row(1, 1)
  feed.applyWindow({ entries: windowEntries([replayed]), revision: 2, change: { kind: 'append', entries: windowEntries([replayed]) } })
  assert.deepEqual(feed.turnEvents(1).map(entry => entry.seq), [1], 'the duplicate did not duplicate the row')
  assert.equal(feed.counters.retainedDurableEvents, MAX_RETAINED_TURNS, 'and was not counted as an admission')

  feed.retainDurable(row(33, 200))
  assert.deepEqual(feed.turnEvents(1), [], 'the duplicate did not refresh turn 1: it was released')
  assert.equal(feed.turnEvents(2).length, 1, 'turn 2 is resident, so no other turn was released')
  assert.deepEqual(feed.turnEvents(33).map(entry => entry.seq), [200])
  assert.deepEqual(
    residentTurns(feed, [...ALL_32, 33]),
    [...ALL_32.slice(1), 33],
    'exactly turns 2..33 remain',
  )
})

/* ------------------------------------------------------------------ *
 * Generation boundary
 * ------------------------------------------------------------------ */

test('a rebaseline clears the whole pool, not just its dedupe state', () => {
  /**
   * §9 of the phase contract. A `replace` is a new window generation: sequence
   * numbers are not guaranteed to be disjoint across generations, and retaining one
   * generation's settlement beside another's `turn/end` would assemble a turn's
   * metrics from two windows. The counter resets with the pool, since it is scoped
   * to the generation.
   *
   * Both generations are established through the real `applyWindow` route, because
   * that is the route the contract is about and because a row pre-retained out of
   * band would be refused as a duplicate once the window carried it.
   */
  const { feed, events } = makeFeed()
  const generation1 = Array.from({ length: MAX_RETAINED_TURNS }, (_, index) => row(index + 1, index + 1))
  feed.applyWindow({ entries: windowEntries(generation1), revision: 1, change: { kind: 'replace', entries: windowEntries(generation1) } })
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'the first generation filled the bound')
  assert.equal(feed.counters.retainedDurableEvents, MAX_RETAINED_TURNS)

  const generation2 = [row(77, 5000, 'turn/start')]
  feed.applyWindow({ entries: windowEntries(generation2), revision: 2, change: { kind: 'replace', entries: windowEntries(generation2) } })

  assert.equal(feed.retainedTurnCount(), 1, 'only the new generation is retained')
  assert.equal(feed.counters.retainedDurableEvents, 1, 'and its cumulative counter starts from zero')
  for (const turn of ALL_32) assert.deepEqual(feed.turnEvents(turn), [], `turn ${turn} did not survive the rebaseline`)
  assert.deepEqual(feed.turnEvents(77).map(entry => entry.seq), [5000], 'the new generation\'s row is retained')
  assert.equal(events.some(event => event.kind === 'window-rebaseline'), true, 'the generation boundary is published')

  /** A seq released with the old generation is freely reusable in the new one. */
  const appended = [row(78, 1, 'turn/start')]
  feed.applyWindow({ entries: windowEntries([...generation2, ...appended]), revision: 3, change: { kind: 'append', entries: windowEntries(appended) } })
  assert.deepEqual(feed.turnEvents(78).map(entry => entry.seq), [1], 'seq 1 is admissible again in the new generation')
  assert.equal(feed.counters.retainedDurableEvents, 2, 'and it counted as a second admission, not a duplicate')
})

/* ------------------------------------------------------------------ *
 * retainedDurableEvents semantics
 * ------------------------------------------------------------------ */

test('retainedDurableEvents is a cumulative admission count, not the current row count', () => {
  /**
   * The counter is incremented once per durable `seq` admitted to the generation, and
   * is never decremented on eviction. Its contract is therefore "distinct durable rows
   * admitted into retention during this generation", and a consumer that reads it as
   * current occupancy is reading it wrong. The live occupancy has a separate, honest
   * accessor (`retainedTurnCount()`), so the difference is asserted here rather than
   * papered over with a decrement.
   *
   * The rows travel the real `append` route, because admission is what the counter
   * counts; `retainDurable` alone is the storage primitive below that gate and does
   * not admit anything.
   */
  const { feed } = makeFeed()
  const admitted = MAX_RETAINED_TURNS + 8
  const first = [row(1, 1)]
  feed.applyWindow({ entries: windowEntries(first), revision: 1, change: { kind: 'replace', entries: windowEntries(first) } })
  for (let turn = 2; turn <= admitted; turn += 1) {
    const appended = [row(turn, turn)]
    feed.applyWindow({ entries: windowEntries(appended), revision: turn, change: { kind: 'append', entries: windowEntries(appended) } })
  }

  const currentlyHeld = residentTurns(feed, Array.from({ length: admitted }, (_, index) => index + 1))
  assert.equal(feed.counters.retainedDurableEvents, admitted, 'cumulative: every admission counted once')
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'current occupancy is bounded, and reported separately')
  assert.equal(currentlyHeld.length, MAX_RETAINED_TURNS, 'exactly the bound is resident')
  assert.equal(
    feed.counters.retainedDurableEvents > feed.retainedTurnCount(),
    true,
    'after eviction the counter is strictly greater than the occupancy, which is what makes it cumulative',
  )

  /** A duplicate is not an admission. */
  const replay = [row(admitted, admitted)]
  feed.applyWindow({ entries: windowEntries(replay), revision: 1000, change: { kind: 'append', entries: windowEntries(replay) } })
  assert.equal(feed.counters.retainedDurableEvents, admitted, 'a refused duplicate did not increment the counter')
  /** Neither is a row that names no finite turn: there is no turn to retrieve it by. */
  const unkeyable = [{ type: 'event', event: { type: 'assistant/message', seq: 99999, time: 1, data: {} } }]
  feed.applyWindow({ entries: unkeyable, revision: 1001, change: { kind: 'append', entries: unkeyable } })
  assert.equal(feed.counters.retainedDurableEvents, admitted, 'an unkeyable row is not retained, and not an admission')
  assert.equal(feed.retainedTurnCount(), MAX_RETAINED_TURNS, 'and it occupies no slot')
})

/* ------------------------------------------------------------------ *
 * Documentation / implementation agreement
 * ------------------------------------------------------------------ */

test('the retention policy is stated once, as least-recently-updated, across source and docs', () => {
  /**
   * The defect this phase closes was a documentation/implementation disagreement, so
   * the retired vocabulary is asserted absent rather than merely edited. The three
   * patterns below described first-seen FIFO, which this structure does not implement.
   *
   * Quoted spans are masked out before the search, so a document may still *quote* the
   * retired wording when recording that it was wrong — the correction note in
   * `IMPLEMENTATION_LOG.md` lists it among the claims that were false, and a regex that
   * forbade the quotation would forbid the audit trail. A quoted phrase is a mention;
   * an unquoted one is an assertion, and only the assertion is rejected here.
   */
  const sources = {
    'src/dsh/client-feed.js': readFileSync(new URL('../src/dsh/client-feed.js', import.meta.url), 'utf8'),
    'docs/ARCHITECTURE.md': readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
    'docs/IMPLEMENTATION_LOG.md': readFileSync(new URL('../docs/IMPLEMENTATION_LOG.md', import.meta.url), 'utf8'),
    'docs/TASKS.md': readFileSync(new URL('../docs/TASKS.md', import.meta.url), 'utf8'),
  }
  /**
   * Replace every `"…"` span with blanks, so only asserted prose remains. The span
   * pattern allows newlines (quoted claims wrap across lines in these documents) but
   * not nested quotes; replacing with spaces rather than deleting keeps every
   * remaining offset and every line boundary intact.
   */
  const withoutQuotations = text => text.replace(/"[^"]*"/gs, match => match.replace(/[^\n]/g, ' '))
  const retired = [
    /re-recording a turn preserves its original position/i,
    /evicted in the order it was first\s+seen/i,
    /first-seen FIFO is the policy/i,
  ]
  for (const [name, text] of Object.entries(sources)) {
    const asserted = withoutQuotations(text)
    for (const pattern of retired) {
      assert.equal(pattern.test(asserted), false, `${name} must not assert the retired first-seen policy (${pattern})`)
    }
  }

  const feedSource = sources['src/dsh/client-feed.js']
  assert.equal(/least.recently.updated/i.test(feedSource), true, 'the source states the implemented policy')
  assert.equal(/least.recently.updated/i.test(sources['docs/ARCHITECTURE.md']), true, 'and ARCHITECTURE.md agrees')
  /** The two named quantities are also stated where a reader would look for them. */
  assert.equal(
    /cumulative ingest count/i.test(sources['docs/ARCHITECTURE.md']),
    true,
    'ARCHITECTURE.md states what retainedDurableEvents counts',
  )
  assert.equal(
    /never decremented/i.test(sources['docs/ARCHITECTURE.md']),
    true,
    'including that eviction does not decrement it',
  )
})
