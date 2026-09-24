/**
 * SessionEventFeed: `SessionEventWindow` wire -> normalized events.
 *
 * The window-change semantics under test are the ones verified at
 * `dsh-api-session-controller/lib/types/client/contract/events.d.ts:41-61`:
 * replace / append / prepend / settle-assistant, revision-guarded, with both
 * evidence planes deduplicated so a replayed window never double-counts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { FEED_ISSUE, SessionEventFeed } from '../src/dsh/client-feed.js'
import { durableEntry, transientEntry } from './helpers/live-replay.js'

function collect() {
  const events = []
  const issues = []
  const feed = new SessionEventFeed({
    sessionId: 's1',
    onEvent: event => events.push(event),
    onIssue: issue => issues.push(issue),
  })
  return { feed, events, issues }
}

const chunk = text => ({ type: 'text-delta', index: 0, text })

test('the initial window pass emits its entries in order, both planes interleaved', () => {
  const { feed, events } = collect()
  const entries = [
    durableEntry('turn/start', 1, 1000, { turn: 1 }),
    transientEntry('s:1', 1100, chunk('hello')),
    durableEntry('step/end', 3, 1200, { turn: 1, step: 1 }),
    durableEntry('turn/end', 4, 1300, { turn: 1, reason: { kind: 'completed' } }),
  ]
  feed.applyWindow({ entries, revision: 1, change: { kind: 'replace', entries } })
  assert.deepEqual(events.map(event => event.kind), [
    'turn-start', 'attempt-start', 'attempt-delta', 'step-end', 'turn-end',
  ])
  assert.equal(events[1].attemptId, 's:1', 'the attempt boundary comes from the transient attemptId change')
  assert.equal(events[1].timeMs, 1100)
  assert.equal(events[2].phase, 'output')
})

test('an already-processed revision is ignored instead of replayed', () => {
  const { feed, events } = collect()
  const entries = [durableEntry('turn/start', 1, 1000, { turn: 1 })]
  feed.applyWindow({ entries, revision: 5, change: { kind: 'replace', entries } })
  const before = events.length
  feed.applyWindow({ entries, revision: 5, change: { kind: 'replace', entries } })
  feed.applyWindow({ entries, revision: 3, change: { kind: 'replace', entries } })
  assert.equal(events.length, before, 'stale snapshots produce nothing')
})

test('append feeds new entries; a repeated durable seq or transient row is reported, not recounted', () => {
  const { feed, events, issues } = collect()
  const first = durableEntry('turn/start', 1, 1000, { turn: 1 })
  feed.applyWindow({ entries: [first], revision: 1, change: { kind: 'replace', entries: [first] } })

  const row = transientEntry('s:1', 1100, chunk('a'))
  feed.applyWindow({ entries: [first, row], revision: 2, change: { kind: 'append', entries: [row] } })
  const deltas = events.filter(event => event.kind === 'attempt-delta').length
  assert.equal(deltas, 1)

  // The same transient event object and the same durable seq pushed again.
  feed.applyWindow({ entries: [first, row], revision: 3, change: { kind: 'append', entries: [row] } })
  feed.applyWindow({ entries: [first, row], revision: 4, change: { kind: 'append', entries: [first] } })
  assert.equal(events.filter(event => event.kind === 'attempt-delta').length, 1, 'no double count')
  assert.equal(events.filter(event => event.kind === 'turn-start').length, 1)
  assert.ok(issues.some(issue => issue.kind === FEED_ISSUE.DUPLICATE_TRANSIENT))
  assert.ok(issues.some(issue => issue.kind === FEED_ISSUE.DUPLICATE_DURABLE))
})

test('prepend pages in older history and is deliberately not ingested', () => {
  const { feed, events } = collect()
  const current = durableEntry('turn/start', 10, 2000, { turn: 2 })
  feed.applyWindow({ entries: [current], revision: 1, change: { kind: 'replace', entries: [current] } })
  const older = [durableEntry('turn/start', 1, 100, { turn: 1 }), durableEntry('turn/end', 2, 200, { turn: 1, reason: { kind: 'completed' } })]
  feed.applyWindow({
    entries: [...older, current],
    revision: 2,
    change: { kind: 'prepend', entries: older },
  })
  assert.equal(feed.ignoredPrepends, 1)
  assert.equal(events.length, 1, 'stale history never reaches the state machines')
})

test('replace rebaselines: local state resets and the new window replays from scratch', () => {
  const { feed, events } = collect()
  const first = [durableEntry('turn/start', 1, 1000, { turn: 1 }), transientEntry('s:1', 1100, chunk('old'))]
  feed.applyWindow({ entries: first, revision: 1, change: { kind: 'replace', entries: first } })
  const second = [durableEntry('turn/start', 1, 1000, { turn: 1 }), transientEntry('s:1', 1900, chunk('fresh'))]
  feed.applyWindow({ entries: second, revision: 9, change: { kind: 'replace', entries: second } })
  assert.equal(events.filter(event => event.kind === 'window-rebaseline').length, 1)
  // Dedupe state belongs to the old generation: the same seq re-enters as new
  // evidence of the current window.
  assert.equal(events.filter(event => event.kind === 'attempt-delta').length, 2, 'one per window generation')
  assert.equal(events.filter(event => event.kind === 'attempt-start').length, 2, 'the replayed attempt re-opens')
})

test('settle-assistant carries the attempt identity into the settlement; a bare one is an abandonment', () => {
  const { feed, events } = collect()
  const seed = [durableEntry('turn/start', 1, 1000, { turn: 1 }), transientEntry('s:1', 1100, chunk('x'))]
  feed.applyWindow({ entries: seed, revision: 1, change: { kind: 'replace', entries: seed } })

  const settlement = durableEntry('assistant/message', 5, 1500, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [] },
    stream: [{ type: 'text-chunks', time0: 1100, index: 0, dt: [400], texts: ['x', 'y'] }],
  })
  feed.applyWindow({ entries: [...seed, settlement], revision: 2, change: { kind: 'settle-assistant', attemptId: 's:1', entry: settlement } })
  const settle = events.find(event => event.kind === 'attempt-settle')
  assert.ok(settle, 'the settlement is delivered with its transient identity')
  assert.equal(settle.attemptId, 's:1')
  assert.equal(settle.settlementKind, 'message')
  assert.equal(settle.surfaceCommitted, true)
  assert.equal(settle.attemptOutcome, 'committed')

  // Second attempt: transient rows exist, then a bare settle-assistant
  // (attempt ended with no durable settlement at all).
  const row2 = transientEntry('s:2', 2000, chunk('z'))
  feed.applyWindow({ entries: [...seed, settlement, row2], revision: 3, change: { kind: 'append', entries: [row2] } })
  feed.applyWindow({ entries: [...seed, settlement], revision: 4, change: { kind: 'settle-assistant', attemptId: 's:2' } })
  const abandon = events.find(event => event.kind === 'attempt-abandon')
  assert.ok(abandon, 'a bare settle-assistant is transient abandonment')
  assert.equal(abandon.attemptId, 's:2')
  assert.equal(abandon.attemptOutcome, 'abandoned')
  assert.equal(abandon.settlementKind, 'none')
})

test('a plain durable settlement is correlated to the open transient attempt when one exists', () => {
  const { feed, events } = collect()
  const entries = [
    durableEntry('turn/start', 1, 1000, { turn: 1 }),
    transientEntry('s:1', 1100, chunk('x')),
    durableEntry('assistant/attempt', 5, 1500, {
      turn: 1,
      step: 1,
      stream: [{ type: 'text-chunks', time0: 1100, index: 0, dt: [400], texts: ['x', 'y'] }],
    }),
  ]
  feed.applyWindow({ entries, revision: 1, change: { kind: 'replace', entries } })
  const settle = events.find(event => event.kind === 'attempt-settle')
  assert.equal(settle.attemptId, 's:1')
  assert.equal(settle.settlementKind, 'attempt', 'assistant/attempt IS a durable settlement')
  assert.equal(settle.surfaceCommitted, false)
  assert.equal(settle.attemptOutcome, 'unknown', 'the durable payload proves no cause; no guessing')
})

test('malformed windows, changes and entries degrade into issues without throwing', () => {
  const { feed, issues } = collect()
  assert.doesNotThrow(() => feed.applyWindow(null))
  assert.doesNotThrow(() => feed.applyWindow({ entries: 'nope' }))
  assert.ok(issues.some(issue => issue.kind === FEED_ISSUE.MALFORMED_WINDOW))

  const seed = []
  feed.applyWindow({ entries: seed, revision: 1, change: { kind: 'replace', entries: seed } })
  assert.doesNotThrow(() => feed.applyWindow({ entries: seed, revision: 2, change: { kind: 'quantum-flux', entries: [] } }))
  assert.ok(issues.some(issue => issue.kind === FEED_ISSUE.UNKNOWN_CHANGE))
  assert.doesNotThrow(() => feed.applyWindow({ entries: seed, revision: 3, change: { kind: 'append' } }))
  assert.ok(issues.some(issue => issue.kind === FEED_ISSUE.MISSING_CHANGE_ENTRIES))

  const garbage = [null, 42, { type: 'weird' }, { type: 'event', event: null }, { type: 'transient' }]
  assert.doesNotThrow(() => feed.applyWindow({ entries: garbage, revision: 4, change: { kind: 'append', entries: garbage } }))
  assert.ok(feed.issues.filter(issue => issue.kind === FEED_ISSUE.MALFORMED_ENTRY).length >= 4)
})
