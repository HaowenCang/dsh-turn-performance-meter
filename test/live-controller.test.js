/**
 * Live controller: fixture-driven replay, session isolation and lifecycle.
 *
 * The fixture replays run real `SessionEventFeed` + `TurnTelemetryStore` +
 * `LivePresenter` chains over verified window semantics, feeding each
 * recording's two evidence planes in their original timestamp order. What is
 * asserted is the presentation state sequence and the structural performance
 * contract — not hard-coded copies of one example trace.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { LiveUiState } from '../src/client/live/live-state.js'
import { turnKey } from '../src/core/types.js'
import { loadFixture } from './helpers/fixtures.js'
import {
  compressStates,
  durableEntry,
  expectedSampleCount,
  fakeSessionsService,
  fixtureEntries,
  replayFixture,
  transientEntry,
  viewKey,
} from './helpers/live-replay.js'

const STREAMING_STATES = new Set([LiveUiState.STREAMING_REASONING, LiveUiState.STREAMING_OUTPUT])

test('t1 replay: pending -> streaming -> tool -> waiting -> streaming -> settled, TTFT stage visited once', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const replay = replayFixture(fixture)
  try {
    const keys = replay.captures.map(viewKey)
    const runs = compressStates(keys)

    assert.equal(runs[0], 'hidden(inactive)', 'before turn/start nothing renders')
    assert.equal(runs[1], LiveUiState.PENDING_FIRST_TOKEN, 'turn/start opens the first-token stage')

    const firstStreaming = runs.findIndex(state => STREAMING_STATES.has(state))
    assert.ok(firstStreaming > 0, 'the turn did stream')
    assert.equal(
      runs.slice(0, firstStreaming).some(state => state === LiveUiState.PENDING_FIRST_TOKEN),
      true,
    )
    assert.equal(
      runs.slice(firstStreaming + 1).includes(LiveUiState.PENDING_FIRST_TOKEN),
      false,
      'a later LLM call never re-enters the turn TTFT stage',
    )

    assert.ok(runs.includes(LiveUiState.TOOL_RUNNING), 'a tool stage occurred')
    assert.ok(runs.includes(LiveUiState.TRANSITION), 'settlement/tool gaps pass through the neutral stage')
    assert.ok(runs.includes(LiveUiState.WAITING_MODEL), 'post-tool model waits are waiting-model')
    assert.equal(runs.at(-1), `hidden(${LiveUiState.SETTLED})`, 'turn/end exits live mode')

    // Every streaming run is a model phase; tools never leak a TPS view.
    for (const view of replay.captures) {
      if (view.kind === 'tool' || view.kind === 'transition' || view.kind === 'waiting' || view.kind === 'ttft' || view.kind === 'hidden') {
        assert.equal('tps' in view, false, `no TPS field may exist on ${view.kind}`)
      }
      if (view.kind === 'streaming') {
        assert.equal(view.approximate, true, 'live TPS always renders with ≈')
        assert.ok(['reasoning', 'output'].includes(view.phase))
      }
    }
  } finally {
    replay.dispose()
  }
})

test('t2 replay: the write, edit and pwsh tool stages are all visible with their names', () => {
  const fixture = loadFixture('t2-pwsh-write-edit')
  const replay = replayFixture(fixture)
  try {
    const toolNames = []
    for (const view of replay.captures) {
      if (view.kind !== 'tool') continue
      const name = view.names[0] ?? ''
      if (toolNames[toolNames.length - 1] !== name) toolNames.push(name)
    }
    assert.deepEqual(toolNames, ['write', 'edit', 'pwsh'], 'all three recorded tool stages, in order')
    // Concurrent-tool labelling is exercised separately by the format tests;
    // here the count field must always reflect the meter.
    for (const view of replay.captures) {
      if (view.kind === 'tool') assert.ok(view.count >= 1)
    }
    const runs = compressStates(replay.captures.map(viewKey))
    assert.equal(runs.at(-1), `hidden(${LiveUiState.SETTLED})`)
  } finally {
    replay.dispose()
  }
})

test('t3 replay: an interrupted turn exits live mode and leaves no ticker behind', () => {
  const fixture = loadFixture('t3-interrupted-mid-reasoning')
  const replay = replayFixture(fixture, { withScheduler: true })
  try {
    const keys = replay.captures.map(viewKey)
    assert.equal(keys.at(-1), `hidden(${LiveUiState.SETTLED})`, 'turn/end(aborted) settles regardless of status')
    assert.equal(replay.controller.project(fixture.sessionId, replay.nowMs).kind, 'hidden')

    // The visibility effect stops the ticker when the view hides.
    const stats = replay.stats()
    assert.equal(stats.timerCount, 0, 'no interval or leading timer survives the settled state')
    assert.ok(stats.maxTimers <= 2, `at most two timers ever existed, saw ${stats.maxTimers}`)
    assert.ok(stats.renders >= 0)
  } finally {
    replay.dispose()
  }
})

test('t5 replay: every delta is ingested while presentation renders stay far below delta count', () => {
  const fixture = loadFixture('t5-reasoning-text-deepseek-official')
  const transientCount = fixture.transient.filter(row => row.frame.type === 'chunk').length
  assert.ok(transientCount > 1000, `t5 is the high-frequency fixture (${transientCount} transient chunks)`)

  const replay = replayFixture(fixture, { withScheduler: true })
  try {
    // 1. Ingestion is complete: the store holds an accepted sample for every
    //    transient row that carries generated content.
    const record = [...replay.controller.store.turns.values()].find(
      candidate => candidate.sessionId === fixture.sessionId,
    )
    assert.ok(record, 'the turn record exists')
    const samples = record.attempts.reduce((sum, attempt) => sum + attempt.samples.length, 0)
    assert.equal(samples, expectedSampleCount(fixture), 'no delta was dropped on the data side')
    const diagnostics = replay.controller.diagnostics(fixture.sessionId)
    assert.equal(diagnostics.droppedDeltas, 0, 'the window contained the turn boundary')
    assert.equal(diagnostics.unknownEvents, 0)

    // 2. Presentation is throttled structurally: renders happen only on the
    //    bounded ticker (driven here at >=200 ms of fixture time), plus the
    //    single coalesced leading render while hidden.
    const stats = replay.stats()
    const spanMs = replay.nowMs
    const tickerBudget = Math.ceil(spanMs / 200) + 2
    assert.ok(stats.renders > 0, 'the meter did render while visible')
    assert.ok(stats.renders <= tickerBudget, `renders ${stats.renders} bounded by ticker budget ${tickerBudget}`)
    assert.ok(stats.renders < transientCount / 5, `renders (${stats.renders}) far below delta count (${transientCount})`)
    assert.ok(stats.maxTimers <= 2, `never more than two timers, saw ${stats.maxTimers}`)
    assert.equal(stats.timerCount, 0, 'the ticker stopped when the turn settled')
  } finally {
    replay.dispose()
  }
})

test('session switch: A and B never share machines, subscriptions or resets', () => {
  const sessions = fakeSessionsService()
  const sourceA = sessions.createSource('session-A')
  const sourceB = sessions.createSource('session-B')
  const controller = createController({ sessions })

  assert.equal(controller.attach('session-A'), true)
  // Idempotent attach: switching back must not create a second subscription.
  assert.equal(controller.attach('session-A'), true)
  assert.equal(sessions.listenerCount('session-A'), 1, 'exactly one eventSource subscription for A')

  // A starts streaming.
  let revision = 1
  const aStart = durableEntry('turn/start', 1, 100, { turn: 1 })
  const aChunk = transientEntry('a:1', 200, { type: 'text-delta', index: 0, text: 'from-A' })
  sourceA.replaceEntries([aChunk ? aStart : aStart], (revision += 1))
  sourceA.appendEntry(aStart, (revision += 1)) // duplicate seq: reported, ignored
  sourceA.appendEntry(aChunk, (revision += 1))
  const viewA = controller.project('session-A', 250)
  assert.equal(viewA.kind, 'streaming', 'A streams')
  assert.equal(viewA.turn, 1)

  // B attaches idle, then runs its own turn.
  assert.equal(controller.attach('session-B'), true)
  assert.equal(controller.project('session-B', 250).kind, 'hidden', 'B has no observed turn yet')

  const bStart = durableEntry('turn/start', 1, 100, { turn: 1 })
  const bChunk = transientEntry('b:1', 200, { type: 'text-delta', index: 0, text: 'from-B' })
  sourceB.replaceEntries([], (revision += 1))
  sourceB.appendEntry(bStart, (revision += 1))
  sourceB.appendEntry(bChunk, (revision += 1))
  const viewB = controller.project('session-B', 250)
  assert.equal(viewB.kind, 'streaming', 'B streams')

  // B settles: A must be untouched (no shared currentTurn, no wrong reset).
  sourceB.appendEntry(
    durableEntry('turn/end', 5, 500, { turn: 1, reason: { kind: 'completed' } }),
    (revision += 1),
  )
  assert.equal(controller.project('session-B', 500).kind, 'hidden')
  assert.equal(controller.project('session-A', 500).kind, 'streaming', 'A still streams after B settled')
  assert.equal(controller.project('session-A', 500).turn, 1)

  // Two sessions = two subscriptions, one each.
  assert.equal(sessions.listenerCount('session-A'), 1)
  assert.equal(sessions.listenerCount('session-B'), 1)

  // HMR teardown: dispose detaches every subscription; a fresh controller
  // re-attaches exactly once (no double subscription after remount).
  controller.dispose()
  assert.equal(sessions.listenerCount('session-A'), 0)
  assert.equal(sessions.listenerCount('session-B'), 0)
  assert.equal(controller.project('session-A', 500).kind, 'hidden', 'a disposed controller renders nothing')

  const fresh = createController({ sessions })
  fresh.attach('session-A')
  assert.equal(sessions.listenerCount('session-A'), 1)
  fresh.dispose()
  assert.equal(sessions.listenerCount('session-A'), 0)
})

test('settle-assistant + llm/retry: durable attempts settle with separated concepts and retried proven', () => {
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-retry')
  const controller = createController({ sessions })
  controller.attach('s-retry')

  const textChunk = text => ({ type: 'text-delta', index: 0, text })
  let revision = 1
  const push = entry => { source.appendEntry(entry, (revision += 1)); return controller.project('s-retry', entry.type === 'transient' ? entry.event.time : entry.event.time) }

  push(durableEntry('turn/start', 1, 1000, { turn: 1 }))
  push(durableEntry('step/start', 2, 1010, { turn: 1, step: 1 }))
  const viewPending = controller.project('s-retry', 1010)
  assert.equal(viewPending.kind, 'ttft', 'pending-first-token before any delta')

  push(transientEntry('s:1', 1200, textChunk('partial answer')))
  const viewStreaming = controller.project('s-retry', 1300)
  assert.equal(viewStreaming.kind, 'streaming')
  assert.equal(viewStreaming.phase, 'output')

  // The failed attempt settles durably as assistant/attempt via the fold.
  const attemptSettle = durableEntry('assistant/attempt', 5, 1500, {
    turn: 1,
    step: 1,
    stream: [{ type: 'text-chunks', time0: 1200, index: 0, dt: [], texts: ['partial answer'] }],
  })
  source.settleAssistant('s:1', attemptSettle, (revision += 1))
  const viewAfterSettle = controller.project('s-retry', 1500)
  assert.equal(viewAfterSettle.kind, 'transition', 'no stale TPS after the settlement')

  // The retry is a durable non-surface event naming the same turn/step.
  push(durableEntry('llm/retry', 6, 1700, {
    turn: 1,
    step: 1,
    retryId: 'r-1',
    retry: 1,
    provider: 'deepseek-official',
    mode: 'normal',
    policyKey: 'default',
    failure: { message: 'boom', code: 'RATE_LIMIT' },
    delayMs: 100,
  }))
  const viewRetry = controller.project('s-retry', 1700)
  assert.equal(viewRetry.kind, 'transition', 'retry backoff is a neutral gap')

  // The retried attempt starts, streams, and commits as a surface message.
  push(transientEntry('s:2', 2000, textChunk('final answer')))
  const viewWait = controller.project('s-retry', 2000)
  assert.equal(viewWait.kind, 'streaming')
  const messageSettle = durableEntry('assistant/message', 9, 2400, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [] },
    stream: [{ type: 'text-chunks', time0: 2000, index: 0, dt: [300], texts: ['final answer', ' done'] }],
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  source.settleAssistant('s:2', messageSettle, (revision += 1))
  push(durableEntry('step/end', 10, 2450, { turn: 1, step: 1 }))
  push(durableEntry('turn/end', 11, 2500, { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(controller.project('s-retry', 2500).kind, 'hidden')

  // Store-level audit: the three settlement concepts stayed separated, and
  // `retried` was derived from durable evidence rather than guessed.
  const record = controller.store.turns.get(turnKey('s-retry', 1))
  const [first, second] = record.attempts
  assert.equal(first.settlementKind, 'attempt', 'assistant/attempt is a durable settlement')
  assert.equal(first.surfaceCommitted, false)
  assert.equal(first.attemptOutcome, 'retried', 'the llm/retry naming this step proves the outcome')
  assert.equal(second.settlementKind, 'message')
  assert.equal(second.surfaceCommitted, true)
  assert.equal(second.attemptOutcome, 'committed')
  controller.dispose()
})

test('malformed window entries never crash the controller or the presentation', () => {
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-junk')
  const controller = createController({ sessions })
  controller.attach('s-junk')
  let revision = 1
  const junk = [null, 7, { type: 'weird' }, { type: 'event', event: 'not-an-event' }, { type: 'transient' }, undefined]
  assert.doesNotThrow(() => {
    for (const entry of junk) source.appendEntry(entry, (revision += 1))
  })
  assert.equal(controller.project('s-junk', 1).kind, 'hidden', 'junk changes nothing visible')
  const diagnostics = controller.diagnostics('s-junk')
  assert.ok(diagnostics.feedIssues.length >= 5, 'every unusable entry was reported')
  controller.dispose()
})

test('an eventSource that throws on read degrades to a diagnostic instead of breaking attach', () => {
  const sessions = {
    binding() {
      return {
        eventSource: {
          getSnapshot() { throw new Error('transport broken') },
          subscribe() { return () => {} },
        },
      }
    },
  }
  const controller = createController({ sessions, debug: false })
  assert.equal(controller.attach('s-broken'), true, 'attach itself must not throw')
  assert.equal(controller.project('s-broken', 1).kind, 'hidden')
  controller.dispose()
})

test('an unattached or unknown session projects hidden, not an error', () => {
  const controller = createController({ sessions: { binding: () => undefined } })
  assert.equal(controller.attach('missing'), false, 'no binding -> no subscription')
  assert.equal(controller.project('missing', 1).kind, 'hidden')
  assert.equal(controller.project(undefined, 1).kind, 'hidden')
  assert.equal(controller.diagnostics('missing'), null)
  controller.dispose()
  assert.equal(controller.project('missing', 1).kind, 'hidden', 'a disposed controller stays hidden')
})

test('fixture entries are a chronological interleave of both planes', () => {
  for (const name of ['t1-reasoning-tool-reasoning', 't2-pwsh-write-edit', 't3-interrupted-mid-reasoning', 't5-reasoning-text-deepseek-official']) {
    const fixture = loadFixture(name)
    const entries = fixtureEntries(fixture)
    assert.equal(entries.length, fixture.durable.length + fixture.transient.filter(row => row.frame.type === 'chunk').length)
    let last = -Infinity
    for (const entry of entries) {
      const time = entry.type === 'event' ? entry.event.time : entry.event.time
      assert.ok(time >= last, `${name}: entry times must be non-decreasing (${time} after ${last})`)
      last = time
    }
  }
})
