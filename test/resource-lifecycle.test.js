/**
 * Phase 12.0R — deterministic session resource-lifecycle regression.
 *
 * Phase 12.0 made `controller.attach` identity-aware: a session that is still in
 * `sessionsMap` is no longer assumed to be subscribed to its current binding, and
 * a retired generation is replaced atomically. What it did **not** bound was the
 * controller's own bookkeeping:
 *
 *   - `sessionsMap` (sessionId -> state: presenter, SessionEventFeed retaining up
 *     to `MAX_RETAINED_TURNS` of durable evidence, currentRecord, ...) grows one
 *     entry per session ever visited. That growth is **intended**: a settled
 *     card must stay readable after the user navigates away, and the store keeps
 *     the telemetry for it.
 *   - `retentionWatches` (sessionId -> `ctx.sessions.retainInfo` unsubscribe)
 *     grows one listener per distinct session ever visited and, before this
 *     phase, was never released until `dispose()`. A retired session is
 *     **inactive**: its scope is gone and its old eventSource can never publish
 *     again, so a permanent retention listener is a leak, not a feature.
 *
 * Desired post-fix semantics encoded here (RED on the unfixed Phase 12.0 tree,
 * GREEN after the 12.0R fix):
 *
 *   (a) a session with a current live binding holds exactly one retention watch
 *       and exactly one eventSource subscription;
 *   (b) when the session's scope retires (retainInfo 1 -> 0), the watch is
 *       released and the old eventSource subscription removed, while the
 *       session's telemetry / settled history remains in `sessionsMap`/store;
 *   (c) revisiting a retired session (fresh generation materialized, then the
 *       activation path runs) recovers authoritatively — rebind or pre-history
 *       `generationAwaiting` adoption, one subscription, exactly one re-armed
 *       watch — and retiring it again releases that watch;
 *   (d) with 120 distinct sessions and interleaved subagent-like lifecycles,
 *       after every session retires: `sessionsMap` keeps all 120 sessions with
 *       their retained turn records (intended), every retention observer
 *       callback and every eventSource subscription is released, and a sample
 *       of revisits recovers with exactly one watch/subscription each;
 *   (e) repeated activation / retirement never double-subscribes or
 *       double-watches.
 *
 * Cardinality is measured through the fake host (`sessions.retainListenerCount`
 * and `source.listenerCount`), so the RED numbers are meaningful even before
 * `controller.lifecycle()` exists. `lifecycle()` itself is covered separately.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createFakeSource,
  createNavigationController,
  outputChunk,
  toolResult,
  turnWindow,
  viewKey,
} from './helpers/session-navigation.js'

/* ================================================================== *
 * Deterministic session population and lifecycle drivers
 * ================================================================== */

/** Total distinct sessions in the large-scale scenario (`main` + subagents). */
const TOTAL_SESSIONS = 120

/** `main` plus 119 subagent session ids; deterministic, no randomness. */
function sessionIds(total = TOTAL_SESSIONS) {
  return [
    'main',
    ...Array.from({ length: total - 1 }, (_, index) => `subagent-${String(index).padStart(3, '0')}`),
  ]
}

/** Total active retention observer callbacks over a set of session ids. */
function retentionCallbacks(sessions, ids) {
  return ids.reduce((total, id) => total + sessions.retainListenerCount(id), 0)
}

/** Active eventSource subscriptions across every source object ever created. */
function eventSourceSubscriptions(sources) {
  return sources.reduce((total, source) => total + source.listenerCount(), 0)
}

/** Turn records the telemetry store still holds for one session. */
function recordsOf(controller, sessionId) {
  return [...controller.store.turns.values()].filter(record => record.sessionId === sessionId)
}

/**
 * One realistic live generation for `id`.
 *
 * A fresh scope generation is materialized with an authoritative window in
 * `phase` (the same `turnWindow` streams the Phase 12.0 matrix drives through the
 * real feed), the activation path attaches it, then the turn advances the way a
 * real subagent turn does: a streamed delta, an optional tool round-trip and,
 * when `settle` is set, the authoritative completed window.
 *
 * The source is returned so the caller can assert the subscription identity it
 * created (the fake host deletes retired scopes, so `sessions.listenerCount`
 * cannot see stale sources — the retained source object is the only proof that a
 * leaked listener is still installed).
 */
function liveGeneration(sessions, controller, id, {
  phase = 'streaming',
  revision = 3,
  turn = 1,
  settle = false,
} = {}) {
  const source = createFakeSource(id)
  source.replace(turnWindow(phase, { turn }), revision)
  sessions.materialize(id, source)
  assert.equal(controller.attach(id), true, `${id} must attach to the generation it just materialized`)
  // A live delta after the attach: the subscription must already be delivering.
  source.append(outputChunk('att-live', 1400, 'live delta ', { turn, step: 1 }), revision + 1)
  if (phase === 'tool') {
    source.append(toolResult({ turn, seq: 9, time: 1500, callId: 'call-1' }), revision + 2)
    source.replace(turnWindow('streaming-after-waiting', { turn }), revision + 3)
  }
  if (settle) source.replace(turnWindow('completed', { turn }), revision + 4)
  return source
}

/** The UI releases the session's last reference: DSH retires the scope. */
function navigateAway(sessions, id) {
  assert.equal(sessions.retire(id), true, `${id} must have been materialized before retiring it`)
}

/** Attach `id` once and report the two cardinalities that make it live. */
function liveBindingOf(sessions, controller, source) {
  return {
    subscriptions: source.listenerCount(),
    watches: sessions.retainListenerCount(source.sessionId),
  }
}

/* ================================================================== *
 * L1 — a live generation has exactly one watch and one subscription
 * ================================================================== */

test('L1. a live generation holds exactly one eventSource subscription and exactly one retention watch', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const source = createFakeSource('main')
    source.replace(turnWindow('streaming'), 3)
    sessions.materialize('main', source)
    assert.equal(controller.attach('main'), true, 'the current binding is attachable')

    assert.deepEqual(liveBindingOf(sessions, controller, source), { subscriptions: 1, watches: 1 })
    assert.equal(sessions.listenerCount('main'), 1, 'the fake host agrees there is one eventSource listener')

    // Repeated activation (attach / resync / explicit ensureCurrentBinding) on
    // the same live generation must not add a second subscription or watch.
    controller.attach('main')
    controller.resync('main', 'test-foreground')
    controller.ensureCurrentBinding('main', 'test-activation')
    assert.deepEqual(
      liveBindingOf(sessions, controller, source),
      { subscriptions: 1, watches: 1 },
      'repeated activation must stay idempotent',
    )

    // A window publication delivers through the one subscription (the listener
    // is live, not a bookkeeping entry).
    source.replace(turnWindow('tool'), 4)
    assert.equal(viewKey(controller.project('main', 1200)), 'tool-running')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * L2 — retirement releases live resources but keeps telemetry
 * ================================================================== */

test('L2. retiring a scope releases its watch and subscription while keeping the settled telemetry', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const source = liveGeneration(sessions, controller, 'main', { phase: 'tool', revision: 3, settle: true })
    assert.equal(source.listenerCount(), 1, 'the live generation is subscribed')
    assert.equal(sessions.retainListenerCount('main'), 1, 'the live generation has one watch')
    assert.equal(viewKey(controller.project('main', 6000)), 'settled', 'the turn is a completed card before leaving')

    navigateAway(sessions, 'main')

    // The retired generation can never publish again.
    assert.equal(source.listenerCount(), 0, 'the retired generation must have no subscription left')
    assert.equal(sessions.listenerCount('main'), 0)
    assert.equal(
      sessions.retainListenerCount('main'),
      0,
      'a retired (inactive) session must not keep a retention watch installed; '
        + `saw ${sessions.retainListenerCount('main')} active callback(s)`,
    )

    // Intended historical retention: the session stays known and its settled
    // telemetry is still readable and still in the store.
    assert.ok(controller.attachedSessions().includes('main'), 'the session stays in sessionsMap')
    const records = recordsOf(controller, 'main')
    assert.equal(records.length, 1, 'the settled turn record is retained')
    assert.equal(viewKey(controller.project('main', 6000)), 'settled', 'the completed card stays readable after retiring')
    assert.ok(controller.feed('main') !== null, 'the feed state is retained')
    assert.ok(controller.feed('main').retainedTurnCount() >= 1, 'durable turn evidence is retained')

    // Retiring an already-retired scope is a host no-op and cannot re-arm the watch.
    assert.equal(sessions.retire('main'), false, 'a second retire is a no-op')
    assert.equal(sessions.retainListenerCount('main'), 0, 'a repeated retire must not re-install a watch')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * L3 — returning to a retired session recovers authoritatively
 * ================================================================== */

test('L3. revisiting a retired session recovers with one subscription and exactly one re-armed watch', () => {
  const { sessions, controller } = createNavigationController()
  try {
    // First visit: a live generation that is then navigated away from mid-turn.
    const first = liveGeneration(sessions, controller, 'main', { phase: 'tool', revision: 3 })
    assert.equal(first.listenerCount(), 1)
    navigateAway(sessions, 'main')
    assert.equal(first.listenerCount(), 0)
    assert.equal(
      sessions.retainListenerCount('main'),
      0,
      'retirement releases the watch before the revisit; '
        + `saw ${sessions.retainListenerCount('main')} active callback(s)`,
    )

    // Return: DSH materializes a fresh scope generation whose window has already
    // moved on to a completed turn. The activation path must rebind it.
    const second = createFakeSource('main')
    second.replace(turnWindow('completed'), 1)
    sessions.materialize('main', second)
    assert.equal(controller.attach('main'), true, 'returning to a retired session attaches its new generation')
    assert.equal(controller.diagnostics('main').generationAwaiting, false, 'the new generation is adopted, not deferred')
    assert.equal(first.listenerCount(), 0, 'the superseded generation is unsubscribed')
    assert.equal(second.listenerCount(), 1, 'the current generation is subscribed exactly once')
    assert.equal(
      sessions.retainListenerCount('main'),
      1,
      'activation re-arms exactly one watch; '
        + `saw ${sessions.retainListenerCount('main')}`,
    )
    assert.equal(viewKey(controller.project('main', 6000)), 'settled', 'the authoritative view is rebuilt')

    navigateAway(sessions, 'main')
    assert.equal(second.listenerCount(), 0, 'retiring again releases the subscription')
    assert.equal(sessions.retainListenerCount('main'), 0, 'retiring again releases the re-armed watch')
    assert.equal(recordsOf(controller, 'main').length, 1, 'telemetry survives the retire/revisit/retire cycle')
  } finally {
    controller.dispose()
  }
})

test('L3b. returning into a pre-history generation defers adoption, then adopts it with one watch and subscription', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const first = liveGeneration(sessions, controller, 'subagent-000', { phase: 'streaming', revision: 5 })
    navigateAway(sessions, 'subagent-000')
    assert.equal(
      sessions.retainListenerCount('subagent-000'),
      0,
      'retirement releases the watch; saw '
        + `${sessions.retainListenerCount('subagent-000')} active callback(s)`,
    )

    // A real re-materialized scope publishes revision 0 with an empty window
    // before its history RPC completes: the activation subscribes and defers.
    const second = createFakeSource('subagent-000')
    sessions.materialize('subagent-000', second)
    assert.equal(controller.attach('subagent-000'), true)
    assert.equal(controller.diagnostics('subagent-000').generationAwaiting, true, 'the pre-history generation is deferred')
    assert.equal(second.listenerCount(), 1, 'exactly one subscription is installed for the deferred generation')
    assert.equal(sessions.retainListenerCount('subagent-000'), 1, 'exactly one watch is armed for the deferred generation')

    // The authoritative history arrives and is adopted through the live one subscription.
    second.replace(turnWindow('completed'), 6)
    assert.equal(controller.diagnostics('subagent-000').generationAwaiting, false, 'the deferred generation is adopted')
    assert.equal(second.listenerCount(), 1, 'adoption does not add a second subscription')
    assert.equal(sessions.retainListenerCount('subagent-000'), 1, 'adoption does not add a second watch')
    assert.equal(viewKey(controller.project('subagent-000', 6000)), 'settled', 'the authoritative view is rebuilt')

    navigateAway(sessions, 'subagent-000')
    assert.equal(second.listenerCount(), 0)
    assert.equal(sessions.retainListenerCount('subagent-000'), 0)
    assert.deepEqual(
      recordsOf(controller, 'subagent-000').map(record => record.turn),
      [1],
      'the adopted turn remains retained',
    )
    void first
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * L4 — 120 interleaved subagent-like session lifecycles
 * ================================================================== */

test('L4. 120 interleaved session lifecycles retain telemetry but release every watch and subscription', t => {
  const { sessions, controller } = createNavigationController()
  const ids = sessionIds()
  const allSources = []
  const track = source => { allSources.push(source); return source }
  try {
    // A realistic population: one main session stays live while subagents come
    // and go. Subagents are grouped into three lifecycle shapes.
    const longLived = ids.slice(1, 41) // 40 ids, 3 generations each
    const revisited = ids.slice(41, 61) // 20 ids, first visit + one revisit
    const transient = ids.slice(61) // 59 ids, one live generation each

    track(liveGeneration(sessions, controller, 'main', { phase: 'streaming', revision: 2, settle: true }))

    // Three retire -> materialize rounds for the long-lived subagents, while the
    // main session stays live: concurrent main+child generations throughout.
    const roundPhases = ['tool', 'waiting-model', 'completed']
    for (let round = 0; round < roundPhases.length; round += 1) {
      for (const id of longLived) {
        track(liveGeneration(sessions, controller, id, {
          phase: roundPhases[round],
          revision: 3 + round,
          turn: 1,
          settle: round === roundPhases.length - 1,
        }))
      }
      if (round < roundPhases.length - 1) {
        for (const id of longLived) navigateAway(sessions, id)
      }
    }

    // One first visit, navigate away, then return once with a fresh generation.
    for (const id of revisited) {
      track(liveGeneration(sessions, controller, id, { phase: 'tool', revision: 3 }))
    }
    for (const id of revisited) navigateAway(sessions, id)
    for (const id of revisited) {
      track(liveGeneration(sessions, controller, id, { phase: 'waiting-model', revision: 1, settle: true }))
    }

    // Concurrent subagents that start and finish while the main turn is live.
    transient.forEach((id, index) => {
      track(liveGeneration(sessions, controller, id, {
        phase: index % 2 === 0 ? 'streaming' : 'tool',
        revision: 4 + (index % 3),
        settle: true,
      }))
    })

    // Mid-scenario invariant: every currently live session has exactly one
    // subscription and exactly one watch (concurrency must not double either).
    assert.equal(controller.attachedSessions().length, TOTAL_SESSIONS, 'all sessions are known while live')
    for (const id of ids) {
      const current = sessions.sourceOf(id)
      assert.ok(current !== undefined, `${id} must currently have a binding`)
      assert.equal(current.listenerCount(), 1, `${id} must have exactly one live eventSource subscription`)
      assert.equal(sessions.retainListenerCount(id), 1, `${id} must have exactly one live retention watch`)
    }

    // Every session is now navigated away from. A retired session is inactive:
    // its scope is gone, so no live observer may remain.
    for (const id of ids) navigateAway(sessions, id)

    const callbacks = retentionCallbacks(sessions, ids)
    const subscriptions = eventSourceSubscriptions(allSources)
    const retainedRecords = ids.map(id => recordsOf(controller, id).length)
    const retainedTurnCounts = ids.map(id => controller.feed(id)?.retainedTurnCount() ?? 0)
    const retainedSessions = ids.filter(id => controller.feed(id) !== null).length
    const settledCards = ids.filter(id => viewKey(controller.project(id, 9000)) === 'settled').length
    const lifecycle = typeof controller.lifecycle === 'function' ? controller.lifecycle() : null

    t.diagnostic(JSON.stringify({
      sessionsMap: controller.attachedSessions().length,
      retentionCallbacks: callbacks,
      retentionWatches: lifecycle?.retentionWatches ?? callbacks,
      eventSourceSubscriptions: subscriptions,
      storeTurns: controller.store.turns.size,
      sessionsWithRecords: retainedRecords.filter(count => count > 0).length,
      sessionsWithRetainedTurns: retainedTurnCounts.filter(count => count > 0).length,
      retainedSessions,
      settledCards,
    }))

    // (d) Intended historical retention: all 120 sessions stay known, with their
    // retained turn records and their settled cards readable. Nothing is evicted.
    assert.equal(controller.attachedSessions().length, TOTAL_SESSIONS, 'sessionsMap retains one entry per visited session')
    assert.equal(controller.store.turns.size, TOTAL_SESSIONS, 'every session keeps its retained turn record')
    assert.equal(retainedRecords.filter(count => count > 0).length, TOTAL_SESSIONS, 'every visited session still has a turn record')
    assert.equal(retainedTurnCounts.filter(count => count > 0).length, TOTAL_SESSIONS, 'every session still retains durable turn evidence')
    assert.equal(retainedSessions, TOTAL_SESSIONS, 'every session still has a readable feed')
    assert.equal(settledCards, TOTAL_SESSIONS, 'every session still projects its settled card')

    // (d) Not intended: live observers for inactive sessions.
    assert.equal(
      callbacks,
      0,
      `after retiring all ${TOTAL_SESSIONS} sessions, active retention observer callbacks must be 0; `
        + `saw ${callbacks} callbacks (${lifecycle === null ? 'summed retainListenerCount' : 'retentionWatches=' + lifecycle.retentionWatches})`,
    )
    assert.equal(
      subscriptions,
      0,
      `after retiring all ${TOTAL_SESSIONS} sessions, active eventSource subscriptions must be 0; saw ${subscriptions}`,
    )

    // Revisit a deterministic sample of >= 12 sessions and prove authoritative
    // recovery: one subscription and exactly one re-armed watch each.
    const sample = ids.filter((_, index) => index % 7 === 0)
    assert.ok(sample.length >= 12, `the revisit sample must be large enough (got ${sample.length})`)
    const sampleSources = new Map()
    for (const id of sample) {
      const source = createFakeSource(id)
      source.replace(turnWindow('completed', { turn: 2 }), 11)
      sessions.materialize(id, source)
      assert.equal(controller.attach(id), true, `${id} must recover on revisit`)
      sampleSources.set(id, source)
      allSources.push(source)
    }
    for (const id of sample) {
      const source = sampleSources.get(id)
      assert.equal(controller.diagnostics(id).generationAwaiting, false, `${id} adopts the re-materialized generation`)
      assert.equal(source.listenerCount(), 1, `${id} must have exactly one subscription after the revisit`)
      assert.equal(sessions.retainListenerCount(id), 1, `${id} must have exactly one re-armed watch after the revisit`)
      assert.equal(viewKey(controller.project(id, 9000)), 'settled', `${id} projects the recovered completed card`)
    }
    assert.equal(retentionCallbacks(sessions, ids), sample.length, 'only the revisited sessions hold a watch')
    assert.equal(eventSourceSubscriptions(allSources), sample.length, 'only the revisited sessions hold a subscription')

    // Retire the sample again: release, and telemetry still present.
    for (const id of sample) navigateAway(sessions, id)
    assert.equal(retentionCallbacks(sessions, ids), 0, 'retiring the revisited sessions releases their watches')
    assert.equal(eventSourceSubscriptions(allSources), 0, 'retiring the revisited sessions releases their subscriptions')
    assert.equal(controller.attachedSessions().length, TOTAL_SESSIONS, 'the revisit does not drop known sessions')
    assert.equal(controller.store.turns.size, TOTAL_SESSIONS, 'the revisit keeps every session\'s telemetry')
    for (const id of sample) {
      assert.equal(recordsOf(controller, id).length, 1, `${id} keeps its retained record after the second retire`)
    }
  } finally {
    controller.dispose()
    assert.equal(eventSourceSubscriptions(allSources), 0, 'dispose leaves no subscription behind')
  }
})

/* ================================================================== *
 * L5 — controller.lifecycle() resource report
 * ================================================================== */

test('L5. controller.lifecycle() reports the bounded live resource cardinalities', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const ids = sessionIds(6)
    for (const id of ids) liveGeneration(sessions, controller, id, { phase: 'streaming', revision: 3 })

    const live = controller.lifecycle()
    assert.equal(typeof live, 'object', 'lifecycle() returns the resource report')
    assert.equal(live.sessions, ids.length, 'lifecycle() counts one state per attached session')
    assert.equal(live.retentionWatches, ids.length, 'lifecycle() counts one watch per live session')
    assert.equal(live.disposed, false, 'a live controller is not disposed')
    assert.equal(typeof live.listeners, 'number', 'lifecycle() reports a numeric listener count')

    for (const id of ids) navigateAway(sessions, id)
    const retired = controller.lifecycle()
    assert.equal(retired.sessions, ids.length, 'retired sessions stay known (intended historical retention)')
    assert.equal(retired.retentionWatches, 0, 'retiring every scope leaves zero retention watches')
    assert.equal(retired.disposed, false)

    controller.dispose()
    const disposed = controller.lifecycle()
    assert.equal(disposed.disposed, true)
    assert.equal(disposed.sessions, 0)
    assert.equal(disposed.retentionWatches, 0)
    assert.equal(disposed.listeners, 0)
  } finally {
    controller.dispose()
  }
})
