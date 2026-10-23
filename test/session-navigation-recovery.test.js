/**
 * Phase 12.0 — session navigation / generation-replacement regression matrix.
 *
 * These tests exist because of a real runtime defect in dsh-turn-performance-meter
 * v0.1.6 on DSH 0.2.1-rc.2: after navigating main agent -> subagent -> main, a
 * session's live meter could stay frozen on the phase it had before the
 * navigation (tool / waiting model) while the underlying agent had advanced.
 *
 * The mechanism the matrix pins down (verified against the 0.2.1-rc.2 client
 * session controller, see dev/phase12/upstream/lifecycle-report.md):
 *
 *   1. `UiWorkspaceService.replaceMain` retains the target session with source
 *      `mainView` and then releases the previous reference;
 *   2. the previous session's last reference reaching zero runs
 *      `retireScope(id)`, which drops the binding and disposes that Session
 *      object (and its `MutableSessionEventSource`);
 *   3. navigating back re-materializes the scope, producing a **new** Session
 *      and a **new** event source whose revision restarts;
 *   4. v0.1.6 `controller.attach(id)` returned early for an already-known
 *      session, so the plugin kept its subscription on the retired source and
 *      never replayed the new generation's authoritative window;
 *   5. only document foreground events called `resync`, and a session switch is
 *      not a foreground event.
 *
 * Every test drives the real controller / feed / store / presenter, and the
 * component-level tests drive the real `MeterRoot` bundle through a recording
 * React stub. `test/helpers/session-navigation.js` models the scope lifecycle.
 *
 * Coverage:
 *   A1/T01 main session generation replacement
 *   A2/T02 subagent session generation replacement
 *   A3/T05 binding unavailable then materialized (binding-ready)
 *   A4/T07 same source, revision advanced, authoritative recovery
 *   A5/T03 A->B->A with the page permanently visible
 *   A6/T11 concurrent sessions, no cross-session contamination
 *   C4/T08/T09/T10 atomic rebind edge cases (revision equality, rollback, stale source)
 *   C5 pending binding is not presented as live evidence
 *   C7 first frame after a session switch is associated with the current sessionId
 *   T04/T12/T13/T14 repeated navigation and phase advances while away
 *   T06/T15/T16/T17/T18/T19/T20 idempotency, lifecycle, cadence, metrics, isolation
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { bundleClient } from '../scripts/bundle-client.mjs'
import { DEFAULT_PRESENTATION_REFRESH_MS } from '../src/client/live/cadence.js'
import { loadFixture } from './helpers/fixtures.js'
import { fakeTimerRegistry, fixtureEntries } from './helpers/live-replay.js'
import {
  createFakeSource,
  createNavigationController,
  toolResult,
  turnEnd,
  turnWindow,
  viewKey,
} from './helpers/session-navigation.js'

/* ================================================================== *
 * Controller-level helpers
 * ================================================================== */

/** Attach `id` to its currently materialized generation and show `phase`. */
function openSession(sessions, controller, id, phase, revision = 4) {
  const source = sessions.materialize(id, createFakeSource(id))
  source.replace(turnWindow(phase), revision)
  assert.equal(controller.attach(id), true, `${id} must attach while its binding exists`)
  return source
}

/** The UI releases the previous mainView reference: DSH retires the scope. */
function navigateAway(sessions, id) {
  assert.equal(sessions.retire(id), true, `${id} must have been materialized before navigating away`)
}

/**
 * The UI navigates back: DSH materializes a **new** generation, then the
 * component-side activation path runs (`attach`; `MeterRoot` calls
 * `ensureCurrentBinding`, whose public equivalent for the session is attach).
 *
 * The source is populated before materialization because a real fresh
 * `MutableSessionEventSource` is already at revision 0 when the scope becomes
 * bindable, and the history `replace` that follows is a later publication.
 */
function navigateBack(sessions, controller, id, phase, revision = 9) {
  const source = createFakeSource(id)
  source.replace(turnWindow(phase), revision)
  sessions.materialize(id, source)
  const attached = controller.attach(id)
  return { source, attached }
}

const samplesOf = (controller, sessionId) => [...controller.store.turns.values()]
  .filter(record => record.sessionId === sessionId)
  .flatMap(record => record.attempts.flatMap(attempt => attempt.samples))

const toolsOf = (controller, sessionId) => [...controller.store.turns.values()]
  .filter(record => record.sessionId === sessionId)
  .flatMap(record => record.tools)

/* ================================================================== *
 * A1/T01 — main session source generation replacement
 * ================================================================== */

test('A1/T01. main session A1->A2: activation rebinds the new source and drops the stale tool phase', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const sourceA1 = openSession(sessions, controller, 'A', 'tool', 6)
    assert.equal(viewKey(controller.project('A', 1200)), 'tool-running', 'A starts in the tool phase')
    assert.equal(sourceA1.listenerCount(), 1, 'A1 subscription exists')

    // Switch to the subagent session: A's last reference is released.
    navigateAway(sessions, 'A')
    assert.equal(sessions.binding('A'), undefined, 'retiring the scope removes the binding')

    // Back to A: a fresh generation is materialized; A2 has already moved on.
    const { source: sourceA2, attached } = navigateBack(sessions, controller, 'A', 'streaming', 1)
    assert.equal(attached, true)

    // The new generation is subscribed, the retired one is not.
    assert.equal(sourceA1.listenerCount(), 0, 'old generation must be unsubscribed')
    assert.equal(sourceA2.listenerCount(), 1, 'new generation must be subscribed')
    assert.equal(sessions.listenerCount('A'), 1)

    const view = controller.project('A', 1300)
    assert.equal(viewKey(view), 'streaming-output', 'the meter catches up with A2 instead of staying in tool')
    assert.equal(view.turn, 1)

    const diagnostics = controller.diagnostics('A')
    assert.equal(diagnostics.eventSourceRebinds, 1, 'exactly one rebind was recorded')
    assert.equal(diagnostics.liveRunningTools, 0, 'the superseded generation tool call is gone')
    assert.equal(diagnostics.lastFeedRevision, 1, 'the feed is rebased on the new generation revision')
    assert.equal(diagnostics.lastSourceRevision, 1)
    assert.equal(toolsOf(controller, 'A').length, 0, 'no A1 tool survives into the A2 generation')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * A2/T02 — subagent source generation replacement, parent unpolluted
 * ================================================================== */

test('A2/T02. subagent B1->B2 rebinds independently and leaves A untouched', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const sourceA = openSession(sessions, controller, 'A', 'streaming', 11)
    const sourceB1 = openSession(sessions, controller, 'B', 'tool', 5)
    const viewABefore = controller.project('A', 1300)
    const revisionABefore = controller.diagnostics('A').lastFeedRevision
    const samplesABefore = samplesOf(controller, 'A').length

    navigateAway(sessions, 'B')
    const { source: sourceB2 } = navigateBack(sessions, controller, 'B', 'completed', 2)

    assert.equal(sourceB1.listenerCount(), 0)
    assert.equal(sourceB2.listenerCount(), 1)
    assert.equal(viewKey(controller.project('B', 6000)), 'settled', 'B shows its new completed generation')
    assert.equal(controller.project('B', 6000).turn, 1)

    assert.equal(viewKey(controller.project('A', 1300)), viewKey(viewABefore), 'A view unchanged by B rebind')
    assert.equal(controller.diagnostics('A').lastFeedRevision, revisionABefore, 'A feed revision unchanged')
    assert.equal(samplesOf(controller, 'A').length, samplesABefore, 'A samples unchanged')
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 0, 'A was never rebound')
    assert.equal(sourceA.listenerCount(), 1)
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * A3/T05 — binding initially unavailable, materialized later
 * ================================================================== */

test('A3/T05. binding missing at activation, materialized later: attach happens from the retention signal', () => {
  const { sessions, controller } = createNavigationController()
  try {
    // The component activates before DSH has retained the session.
    assert.equal(controller.attach('B'), false, 'no binding yet -> no attach (contract preserved)')
    assert.equal(sessions.listenerCount('B'), 0)
    assert.equal(controller.project('B', 1000).kind, 'hidden')

    // DSH materializes the scope and publishes the retention change.
    const source = sessions.materialize('B', createFakeSource('B'))
    source.replace(turnWindow('streaming'), 3)

    assert.deepEqual(controller.attachedSessions(), ['B'], 'the binding-ready signal attached the session')
    assert.equal(source.listenerCount(), 1, 'exactly one subscription after materialization')
    assert.equal(viewKey(controller.project('B', 1300)), 'streaming-output')

    // The scope retires again: the plugin must not keep presenting the frozen
    // generation as a live claim, and must not clear the historical store.
    sessions.retire('B')
    assert.equal(controller.project('B', 1300).kind, 'hidden', 'a missing binding suppresses stale live evidence')
    assert.equal(source.listenerCount(), 0, 'the retired generation listener is released')
    assert.equal(controller.attach('B'), false, 'attach reports that no current binding exists')

    // Re-materialization restores the true state without a manual resync.
    const source2 = sessions.materialize('B', createFakeSource('B'))
    source2.replace(turnWindow('completed'), 1)
    assert.equal(source2.listenerCount(), 1, 'binding-ready reattached exactly once')
    assert.equal(viewKey(controller.project('B', 6000)), 'settled')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * A4/T07 — same source, authoritative revision advanced while away
 * ================================================================== */

test('A4/T07. same source with a missed revision window: activation replays the authoritative window', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const source = openSession(sessions, controller, 'A', 'tool', 20)
    assert.equal(viewKey(controller.project('A', 1200)), 'tool-running')

    // The session kept running and the authoritative window moved to 35 while
    // this client was not looking at that session (its callback did not run).
    source.replaceUnobserved(turnWindow('completed'), 35)
    assert.equal(controller.diagnostics('A').lastFeedRevision, 20)

    // Session activation runs the authoritative resync.
    assert.equal(controller.attach('A'), true)
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 0, 'the source identity did not change')
    assert.ok(controller.diagnostics('A').revisionGapsDetected >= 1, 'the missed window was detected as a gap')
    assert.equal(controller.diagnostics('A').lastFeedRevision, 35)
    assert.equal(viewKey(controller.project('A', 6000)), 'settled', 'the completed card appears, not the stale tool')

    const record = [...controller.store.turns.values()].find(candidate => candidate.sessionId === 'A')
    assert.ok(record.attempts.length >= 1)
    assert.equal(record.tools.length, 0, 'the old tool belongs to a superseded window and is rebuilt away')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * A5/T03 — A -> B -> A with the page permanently visible
 * ================================================================== */

test('A5/T03. A->B->A with the page visible: recovery comes from session activation, not foreground events', () => {
  const { sessions, controller } = createNavigationController()
  const doc = createMockDocument('visible')
  try {
    const sourceA1 = openSession(sessions, controller, 'A', 'tool', 4)
    const sourceB = openSession(sessions, controller, 'B', 'tool', 3)

    // Navigate to B (the page stays visible throughout; no visibility/focus events).
    navigateAway(sessions, 'A')
    assert.equal(sourceA1.listenerCount(), 0)
    assert.equal(sourceB.listenerCount(), 1)

    // B advances, then navigate back to A with A2 already completed.
    sourceB.replace(turnWindow('streaming-after-waiting'), 8)
    assert.equal(viewKey(controller.project('B', 1400)), 'streaming-output')
    const { source: sourceA2 } = navigateBack(sessions, controller, 'A', 'completed', 0)

    assert.equal(sourceA2.listenerCount(), 1)
    assert.equal(viewKey(controller.project('A', 6000)), 'settled', 'A recovered to the authoritative completed state')
    assert.equal(doc.visibilityChanges, 0, 'no visibilitychange was emitted')
    assert.equal(doc.foregroundEvents, 0, 'no foreground event was needed')
    assert.equal(controller.diagnostics('A').foregroundResyncs, 0, 'foreground recovery is not the trigger')
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 1)
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * A6/T08/T09/T10 — atomic rebind edge cases
 * ================================================================== */

test('A6/T08. generation changed but the revision number is identical: identity still forces a rebaseline', () => {
  const { sessions, controller } = createNavigationController()
  try {
    openSession(sessions, controller, 'A', 'tool', 7)
    assert.equal(viewKey(controller.project('A', 1200)), 'tool-running')

    navigateAway(sessions, 'A')
    const { source } = navigateBack(sessions, controller, 'A', 'streaming', 7)

    assert.equal(source.revision(), 7)
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 1)
    assert.equal(viewKey(controller.project('A', 1300)), 'streaming-output', 'same numeric revision on a new source must still rebaseline')
  } finally {
    controller.dispose()
  }
})

test('A6/T09. generation changed and revision rolled back to 0: the new generation is accepted', () => {
  const { sessions, controller } = createNavigationController()
  try {
    openSession(sessions, controller, 'A', 'tool', 42)
    navigateAway(sessions, 'A')

    // A brand-new event source starts at revision 0 with an empty window. The
    // rebind must adopt that source even though the previous generation sat at
    // 42. Because the empty window is the pre-history generation, the previous
    // evidence is retained until the first authoritative publication (revision
    // 1), which must then be applied.
    const source = sessions.materialize('A', createFakeSource('A'))
    assert.equal(source.revision(), 0)
    assert.equal(controller.attach('A'), true)
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 1, 'the source identity change was adopted')
    assert.equal(controller.diagnostics('A').generationAwaiting, true, 'the pre-history window is not a generation rebaseline')
    assert.equal(controller.diagnostics('A').lastFeedRevision, 42, 'old evidence is retained until history publishes')

    source.replace(turnWindow('completed'), 1)
    assert.equal(controller.diagnostics('A').generationAwaiting, false)
    assert.equal(controller.diagnostics('A').lastFeedRevision, 1)
    assert.equal(viewKey(controller.project('A', 6000)), 'settled')
  } finally {
    controller.dispose()
  }
})

test('A6/T10. stale source after unsubscribe cannot update the new generation', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const old = openSession(sessions, controller, 'A', 'tool', 12)
    navigateAway(sessions, 'A')
    const { source: current } = navigateBack(sessions, controller, 'A', 'streaming', 2)

    const viewBefore = viewKey(controller.project('A', 1300))
    const samplesBefore = samplesOf(controller, 'A').length
    const toolsBefore = toolsOf(controller, 'A').length
    const revisionBefore = controller.diagnostics('A').lastFeedRevision
    const rebindsBefore = controller.diagnostics('A').eventSourceRebinds

    // Tail mutations on the disposed generation must be inert.
    old.append(turnEnd({ turn: 2, seq: 90, time: 9000 }), 99)
    old.replaceUnobserved(turnWindow('completed', { turn: 2 }), 100)

    assert.equal(viewKey(controller.project('A', 1300)), viewBefore)
    assert.equal(samplesOf(controller, 'A').length, samplesBefore)
    assert.equal(toolsOf(controller, 'A').length, toolsBefore)
    assert.equal(controller.diagnostics('A').lastFeedRevision, revisionBefore)
    assert.equal(controller.diagnostics('A').eventSourceRebinds, rebindsBefore, 'no rebind on a late old-generation callback')
    assert.equal(current.listenerCount(), 1)
    assert.equal(old.listenerCount(), 0)
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * C5 — pending binding is never presented as live evidence
 * ================================================================== */

test('C5. a temporarily missing binding hides stale live evidence but keeps settled history', () => {
  const { sessions, controller } = createNavigationController()
  try {
    // A live phase is not evidence about the session once its binding is gone.
    openSession(sessions, controller, 'A', 'tool', 3)
    sessions.retire('A')
    assert.equal(controller.project('A', 1200).kind, 'hidden', 'live tool evidence is suppressed while the binding is missing')

    // The next generation first publishes an empty pre-history window: the live
    // claim stays suppressed (not re-presented as current).
    const source2 = sessions.materialize('A', createFakeSource('A'))
    assert.equal(controller.diagnostics('A').generationAwaiting, true, 'the pre-history generation is not treated as evidence')
    assert.equal(controller.project('A', 1300).kind, 'hidden', 'no stale live claim survives the pre-history window')

    // When the authoritative window arrives the true state is rebuilt.
    source2.replace(turnWindow('completed'), 1)
    controller.attach('A')
    assert.equal(controller.diagnostics('A').generationAwaiting, false)
    assert.equal(viewKey(controller.project('A', 6000)), 'settled')

    // Now a settled card is real history. Losing the binding must not erase it,
    // and a re-materialized pre-history window must keep showing it.
    sessions.retire('A')
    assert.equal(viewKey(controller.project('A', 6000)), 'settled', 'settled history stays readable while pending')
    const source3 = sessions.materialize('A', createFakeSource('A'))
    assert.equal(controller.diagnostics('A').generationAwaiting, true)
    assert.equal(viewKey(controller.project('A', 6000)), 'settled', 'the settled card survives the pre-history window')
    source3.replace(turnWindow('completed'), 1)
    assert.equal(viewKey(controller.project('A', 6000)), 'settled')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * C7 — first frame is associated with the active sessionId
 * ================================================================== */

test('C7. returning from B to A never paints B\'s last live view as A\'s current state', async () => {
  const bundle = await loadMeterBundle()
  const timers = fakeTimerRegistry()
  const doc = createMockDocument('visible')
  const win = createMockWindow()
  const { sessions, controller } = createNavigationController()
  try {
    const sourceA = openSession(sessions, controller, 'A', 'tool', 4)
    const sourceB = openSession(sessions, controller, 'B', 'streaming', 2)

    const runtime = createReactRuntime()
    const factory = bundle.createFactory({ document: doc, timers })
    const { makeMeterSlot } = factory(spec => spec === 'react' ? runtime.react : null)
    const Component = makeMeterSlot({ controller, t: key => key, documentTarget: doc, windowTarget: win })
    const harness = createSlotHarness({ Component, runtime })

    harness.update({ sessionId: 'B' })
    assert.equal(harness.view().kind, 'streaming')

    // Navigate to A. Before activation effects run, the render must already be
    // associated with A — never B's streaming view.
    sourceA.replace(turnWindow('completed'), 20)
    navigateAway(sessions, 'B')
    const { source: sourceA2 } = navigateBack(sessions, controller, 'A', 'completed', 0)
    const firstElement = harness.render({ sessionId: 'A' })
    assert.equal(firstElement.props.view.kind, 'completed', 'first render after the switch uses A\'s recovered view')
    assert.equal(firstElement.props.view.sessionId, 'A', 'the painted view is associated with A')
    harness.commit()
    assert.equal(viewKey(harness.view()), 'settled')
    assert.equal(sourceA.listenerCount(), 0)
    assert.equal(sourceA2.listenerCount(), 1)
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * T04/T12/T13/T14 — repeated navigation, phase advances while away
 * ================================================================== */

test('T04. A->B->A->B repeated navigation leaves no stale phase in either session', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const phases = [
      ['A', 'tool'],
      ['B', 'waiting-model'],
      ['A', 'streaming'],
      ['B', 'completed'],
      ['A', 'completed'],
      ['B', 'tool'],
    ]
    let previous = null
    for (const [id, phase] of phases) {
      if (previous !== null && previous === id) {
        // Same session twice in a row cannot happen in this script; keep the
        // guard so the fixture stays honest.
        throw new Error('script error')
      }
      if (sessions.isMaterialized(id)) sessions.retire(id)
      const source = sessions.materialize(id, createFakeSource(id))
      source.replace(turnWindow(phase), 7)
      assert.equal(controller.attach(id), true)
      const at = phase === 'completed' ? 6000 : 1400
      assert.equal(viewKey(controller.project(id, at)), phase === 'completed' ? 'settled' : viewKeyOfPhase(phase), `${id} shows ${phase}`)
      previous = id
    }
    assert.equal(sessions.listenerCount('A'), 1, 'A keeps one subscription on its current generation')
    assert.equal(sessions.listenerCount('B'), 1)
  } finally {
    controller.dispose()
  }
})

function viewKeyOfPhase(phase) {
  switch (phase) {
    case 'tool': return 'tool-running'
    case 'waiting-model': return 'waiting-model'
    case 'streaming': return 'streaming-output'
    case 'completed': return 'settled'
    default: throw new Error(`unknown phase ${phase}`)
  }
}

test('T12. leaving during a tool call and returning after the tool finished never stays on the tool', () => {
  const { sessions, controller } = createNavigationController()
  try {
    openSession(sessions, controller, 'A', 'tool', 5)
    assert.equal(viewKey(controller.project('A', 1200)), 'tool-running')
    navigateAway(sessions, 'A')
    navigateBack(sessions, controller, 'A', 'streaming-after-waiting', 9)
    assert.equal(viewKey(controller.project('A', 1400)), 'streaming-output', 'the finished tool is not shown as current')
  } finally {
    controller.dispose()
  }
})

test('T13. leaving while waiting for the model and returning during streaming recovers the stream', () => {
  const { sessions, controller } = createNavigationController()
  try {
    openSession(sessions, controller, 'A', 'waiting-model', 5)
    assert.equal(viewKey(controller.project('A', 1300)), 'waiting-model')
    navigateAway(sessions, 'A')
    navigateBack(sessions, controller, 'A', 'streaming-after-waiting', 9)
    assert.equal(viewKey(controller.project('A', 1400)), 'streaming-output')
  } finally {
    controller.dispose()
  }
})

test('T14. a turn that ended while away returns as a completed card', () => {
  const { sessions, controller } = createNavigationController()
  try {
    openSession(sessions, controller, 'A', 'streaming', 4)
    navigateAway(sessions, 'A')
    navigateBack(sessions, controller, 'A', 'completed', 1)
    const view = controller.project('A', 6000)
    assert.equal(view.kind, 'completed')
    assert.equal(view.state, 'settled')
    assert.equal(view.turn, 1)
    assert.equal(view.status, 'completed')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * T06 — same source + same revision activation is idempotent
 * ================================================================== */

test('T06. same source and same revision activation is idempotent (no extra subscription or metric work)', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const source = openSession(sessions, controller, 'A', 'streaming', 5)
    const samples = samplesOf(controller, 'A').length
    const tools = toolsOf(controller, 'A').length
    const revision = controller.diagnostics('A').lastFeedRevision
    const view = viewKey(controller.project('A', 1300))

    for (let i = 0; i < 5; i += 1) assert.equal(controller.attach('A'), true)

    assert.equal(source.listenerCount(), 1, 'still exactly one subscription')
    assert.equal(sessions.listenerCount('A'), 1)
    assert.equal(samplesOf(controller, 'A').length, samples, 'no duplicated samples')
    assert.equal(toolsOf(controller, 'A').length, tools)
    assert.equal(controller.diagnostics('A').lastFeedRevision, revision)
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 0)
    assert.equal(viewKey(controller.project('A', 1300)), view)
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * T11/T20 — concurrent sessions and resync isolation
 * ================================================================== */

test('T11. concurrently active main and subagent sessions never contaminate each other', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const sourceA = openSession(sessions, controller, 'A', 'streaming', 9)
    const sourceB = openSession(sessions, controller, 'B', 'tool', 9)

    // Interleave live traffic on both sessions.
    sourceA.append(turnEnd({ turn: 1 }), 10)
    sourceB.append(toolResult({ turn: 1 }), 10)

    assert.equal(viewKey(controller.project('A', 6000)), 'settled')
    assert.equal(viewKey(controller.project('B', 1300)), 'transition')

    const recordsA = [...controller.store.turns.values()].filter(record => record.sessionId === 'A')
    const recordsB = [...controller.store.turns.values()].filter(record => record.sessionId === 'B')
    assert.ok(recordsA.length >= 1 && recordsB.length >= 1)
    assert.equal(recordsA.every(record => record.sessionId === 'A'), true)
    assert.equal(recordsB.every(record => record.sessionId === 'B'), true)

    // A rebind of A must not clear or advance B.
    const bView = viewKey(controller.project('B', 1300))
    const bRevision = controller.diagnostics('B').lastFeedRevision
    const bSamples = samplesOf(controller, 'B').length
    navigateAway(sessions, 'A')
    const { source: sourceA2 } = navigateBack(sessions, controller, 'A', 'completed', 0)

    assert.equal(viewKey(controller.project('B', 1300)), bView)
    assert.equal(controller.diagnostics('B').lastFeedRevision, bRevision)
    assert.equal(samplesOf(controller, 'B').length, bSamples)
    assert.equal(controller.diagnostics('B').eventSourceRebinds, 0)
    assert.equal(sourceB.listenerCount(), 1)
    assert.equal(sourceA2.listenerCount(), 1)
  } finally {
    controller.dispose()
  }
})

test('T20. controller.resync of one session never resets another session', () => {
  const { sessions, controller } = createNavigationController()
  try {
    openSession(sessions, controller, 'A', 'streaming', 2)
    const sourceB = openSession(sessions, controller, 'B', 'tool', 3)
    const before = {
      view: viewKey(controller.project('B', 1300)),
      revision: controller.diagnostics('B').lastFeedRevision,
      samples: samplesOf(controller, 'B').length,
      counters: { ...controller.diagnostics('B').counters },
    }

    const result = controller.resync('A', 'foreground-A')
    assert.equal(result.resynced, true)

    assert.equal(viewKey(controller.project('B', 1300)), before.view)
    assert.equal(controller.diagnostics('B').lastFeedRevision, before.revision)
    assert.equal(samplesOf(controller, 'B').length, before.samples)
    assert.deepEqual(controller.diagnostics('B').counters, before.counters, 'B counters untouched')
    assert.equal(sourceB.listenerCount(), 1)
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * T15 — unmount / remount: no duplicate subscriptions, styles or timers
 * ================================================================== */

test('T15. unmount/remount cycles do not leak subscriptions, styles or timers', async () => {
  const bundle = await loadMeterBundle()
  const timers = fakeTimerRegistry()
  const doc = createMockDocument('visible')
  const win = createMockWindow()
  const { sessions, controller } = createNavigationController()
  const mount = () => {
    // A real remount discards the component's hook state; the plugin controller
    // (created once at plugin apply) survives, exactly as in the browser.
    const runtime = createReactRuntime()
    const factory = bundle.createFactory({ document: doc, timers })
    const { makeMeterSlot } = factory(spec => spec === 'react' ? runtime.react : null)
    const Component = makeMeterSlot({ controller, t: key => key, documentTarget: doc, windowTarget: win })
    const harness = createSlotHarness({ Component, runtime })
    harness.update({ sessionId: 'A' })
    return harness
  }
  try {
    const source = openSession(sessions, controller, 'A', 'streaming', 4)

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const harness = mount()
      assert.equal(source.listenerCount(), 1, `cycle ${cycle}: one controller subscription`)
      assert.equal(doc.styleCount(), 1, `cycle ${cycle}: one style tag`)
      assert.equal(harness.scheduler().ticking, true, `cycle ${cycle}: live ticker running`)
      harness.unmount()
      assert.equal(doc.styleCount(), 0, `cycle ${cycle}: style released on unmount`)
      assert.equal(harness.scheduler().timerCount, 0, `cycle ${cycle}: no timer survives unmount`)
    }

    const harness = mount()
    assert.equal(source.listenerCount(), 1, 'a fresh mount still subscribes exactly once')
    harness.unmount()
    assert.equal(source.listenerCount(), 1, 'controller-level ingestion survives a component unmount')
    controller.dispose()
    assert.equal(source.listenerCount(), 0, 'controller.dispose releases the session subscription')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * T16 — browser hidden -> visible recovery is not degraded
 * ================================================================== */

test('T16. hidden -> visible foreground recovery still rebinds a replaced generation', async () => {
  const bundle = await loadMeterBundle()
  const timers = fakeTimerRegistry()
  const doc = createMockDocument('visible')
  const win = createMockWindow()
  const { sessions, controller } = createNavigationController()
  try {
    const oldSource = openSession(sessions, controller, 'A', 'tool', 4)
    const runtime = createReactRuntime()
    const factory = bundle.createFactory({ document: doc, timers })
    const { makeMeterSlot } = factory(spec => spec === 'react' ? runtime.react : null)
    const Component = makeMeterSlot({ controller, t: key => key, documentTarget: doc, windowTarget: win })
    const harness = createSlotHarness({ Component, runtime })
    harness.update({ sessionId: 'A' })
    assert.equal(viewKey(harness.view()), 'tool-running')

    doc.setVisibility('hidden')
    assert.equal(harness.scheduler().suspended, true)
    assert.equal(harness.scheduler().timerCount, 0)

    // While hidden, navigation replaced A's generation and the turn completed.
    sessions.retire('A')
    const next = createFakeSource('A')
    next.replace(turnWindow('completed'), 1)
    sessions.materialize('A', next)
    oldSource.dispose()

    doc.setVisibility('visible')
    assert.ok(controller.diagnostics('A').foregroundResyncs >= 1, 'foreground recovery ran')
    assert.equal(oldSource.listenerCount(), 0, 'retired generation unsubscribed')
    assert.equal(next.listenerCount(), 1, 'new generation subscribed')
    assert.equal(viewKey(harness.view()), 'settled', 'the recovered view is the completed card')
    assert.equal(harness.scheduler().timerCount, 0, 'a completed card leaves no timer')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * T17/T18 — cadence, completion timer, metrics/curve unchanged
 * ================================================================== */

test('T17. 100 ms cadence is frozen and a completed card stops the presentation ticker', async () => {
  assert.equal(DEFAULT_PRESENTATION_REFRESH_MS, 100)

  const bundle = await loadMeterBundle()
  const timers = fakeTimerRegistry()
  const doc = createMockDocument('visible')
  const win = createMockWindow()
  const { sessions, controller } = createNavigationController()
  try {
    const source = openSession(sessions, controller, 'A', 'streaming', 2)
    const runtime = createReactRuntime()
    const factory = bundle.createFactory({ document: doc, timers })
    const { makeMeterSlot } = factory(spec => spec === 'react' ? runtime.react : null)
    const Component = makeMeterSlot({ controller, t: key => key, documentTarget: doc, windowTarget: win })
    const harness = createSlotHarness({ Component, runtime })
    harness.update({ sessionId: 'A' })

    assert.equal(controller.refreshMs, 100)
    assert.equal(harness.scheduler().intervalMs, 100)
    assert.equal(harness.scheduler().ticking, true)
    assert.equal(harness.scheduler().timerCount, 1, 'a live view owns exactly one interval')

    timers.fireIntervals(2)
    assert.equal(viewKey(harness.view()), 'streaming-output', 'the ticker projects the live view at the frozen cadence')

    // The turn completes; one bounded tick rebuilds the static card and the
    // component's live effect then stops the ticker.
    source.append(turnEnd({ turn: 1 }), 3)
    timers.fireIntervals(1)
    harness.render({ sessionId: 'A' })
    harness.commit()
    assert.equal(viewKey(harness.view()), 'settled')
    assert.equal(harness.scheduler().ticking, false, 'the completed card stops the ticker')
    assert.equal(harness.scheduler().timerCount, 0, 'the completed card leaves zero timers')
  } finally {
    controller.dispose()
  }
})

test('T18. a navigation rebuild reproduces the same completed curve and peak statistics as a fresh replay', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const entries = fixtureEntries(fixture)
  const nowMs = Math.max(...entries.map(entry => entry.event.time))
  const sessionId = fixture.sessionId
  const { sessions, controller } = createNavigationController()
  try {
    // A clean load of the complete authoritative window.
    const first = createFakeSource(sessionId)
    first.replace(entries, 1)
    sessions.materialize(sessionId, first)
    assert.equal(controller.attach(sessionId), true)
    const freshCard = controller.project(sessionId, nowMs)
    assert.equal(freshCard.kind, 'completed')
    const freshStats = curveStats(freshCard)

    // The same window reached through navigation: retire, materialize a new
    // generation, rebind. The completed card must be byte-for-byte equivalent
    // in its curve, peaks, columns and quality (no metric algorithm drift).
    // First prove the navigation path actually ran: a cached projection of the
    // previous generation would make a metric comparison meaningless.
    sessions.retire(sessionId)
    const rebuilt = createFakeSource(sessionId)
    rebuilt.replace(entries, 2)
    sessions.materialize(sessionId, rebuilt)
    assert.equal(controller.attach(sessionId), true)
    assert.equal(controller.diagnostics(sessionId).eventSourceRebinds, 1, 'a new generation was rebound')
    assert.equal(first.listenerCount(), 0, 'the superseded source was unsubscribed')
    assert.equal(rebuilt.listenerCount(), 1, 'the new source is subscribed exactly once')
    assert.equal(controller.diagnostics(sessionId).lastFeedRevision, 2, 'the feed was rebased on the new generation')
    const recoveredCard = controller.project(sessionId, nowMs)

    assert.equal(recoveredCard.kind, 'completed')
    assert.equal(recoveredCard, controller.project(sessionId, nowMs), 'the recovered card is a stable projection')
    assert.ok(recoveredCard.curve.segments.length >= 1, 'the completed curve has at least one attempt segment')
    assert.deepEqual(curveStats(recoveredCard), freshStats, 'curve/peak/attempt statistics are identical after a rebind')
  } finally {
    controller.dispose()
  }
})

function curveStats(view) {
  return {
    attemptCount: view.attemptCount,
    peakTps: view.curve.peakTps,
    curveSegments: view.curve.segments.map(segment => ({
      attemptId: segment.attemptId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      sampleCount: segment.sampleCount,
    })),
    seriesPeaks: view.curve.series.map(series => ({ key: series.key, peak: series.peak, present: series.present })),
    columnValues: view.columns.map(column => ({ key: column.key, value: column.value, display: column.display })),
    quality: view.quality,
  }
}

/* ================================================================== *
 * T19 — repeated navigation does not grow resources without bound
 * ================================================================== */

test('T19. repeated navigation keeps subscriptions, sessions and retained turns bounded', () => {
  const { sessions, controller } = createNavigationController()
  try {
    openSession(sessions, controller, 'A', 'tool', 4)
    openSession(sessions, controller, 'B', 'tool', 4)

    for (let round = 0; round < 25; round += 1) {
      sessions.retire('A')
      const nextA = sessions.materialize('A', createFakeSource('A'))
      nextA.replace(turnWindow(round % 2 === 0 ? 'streaming' : 'completed'), round + 1)
      assert.equal(controller.attach('A'), true)

      sessions.retire('B')
      const nextB = sessions.materialize('B', createFakeSource('B'))
      nextB.replace(turnWindow(round % 2 === 0 ? 'waiting-model' : 'tool'), round + 1)
      assert.equal(controller.attach('B'), true)
    }

    assert.equal(controller.attachedSessions().length, 2, 'the session map is bounded')
    assert.equal(sessions.listenerCount('A'), 1, 'one subscription for A')
    assert.equal(sessions.listenerCount('B'), 1, 'one subscription for B')
    assert.equal(sessions.retainListenerCount('A'), 1, 'one retention watch for A')
    assert.equal(sessions.retainListenerCount('B'), 1, 'one retention watch for B')

    for (const sessionId of ['A', 'B']) {
      const records = [...controller.store.turns.values()].filter(record => record.sessionId === sessionId)
      assert.ok(records.length <= 1, `${sessionId} keeps only its current generation's turn (saw ${records.length})`)
      assert.ok(controller.feed(sessionId).retainedTurnCount() <= 1)
    }
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * T21-T23 — remount, non-retainInfo hosts, and shared scope retention
 * ================================================================== */

/** A fresh dock instance over the shared controller (one real remount). */
async function mountFreshDock(bundle, { controller, doc, win, timers }) {
  const runtime = createReactRuntime()
  const factory = bundle.createFactory({ document: doc, timers })
  const { makeMeterSlot } = factory(spec => spec === 'react' ? runtime.react : null)
  const Component = makeMeterSlot({ controller, t: key => key, documentTarget: doc, windowTarget: win })
  return createSlotHarness({ Component, runtime })
}

test('T21. a fresh dock mount after a generation replacement recovers before its stable frame', async () => {
  const bundle = await loadMeterBundle()
  const timers = fakeTimerRegistry()
  const doc = createMockDocument('visible')
  const win = createMockWindow()
  const { sessions, controller } = createNavigationController()
  try {
    const sourceA1 = openSession(sessions, controller, 'A', 'tool', 4)

    // First mount on A paints the tool phase, then the dock unmounts.
    const first = await mountFreshDock(bundle, { controller, doc, win, timers })
    first.update({ sessionId: 'A' })
    assert.equal(viewKey(first.view()), 'tool-running')
    first.unmount()

    // Navigation replaced the generation while no dock was mounted.
    sessions.retire('A')
    const sourceA2 = createFakeSource('A')
    sourceA2.replace(turnWindow('completed'), 1)
    sessions.materialize('A', sourceA2)

    // A fresh dock instance mounts for the same sessionId. The layout effect
    // must rebind and re-render before the first stable frame.
    const second = await mountFreshDock(bundle, { controller, doc, win, timers })
    second.render({ sessionId: 'A' })
    second.commit()
    const stableFrame = second.render({ sessionId: 'A' })
    assert.equal(stableFrame.props.view.kind, 'completed', 'the stable frame is the recovered completed card')
    assert.equal(viewKey(second.view()), 'settled')
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 1)
    assert.equal(sourceA1.listenerCount(), 0, 'the retired source is unsubscribed')
    assert.equal(sourceA2.listenerCount(), 1, 'the current source is subscribed exactly once')
  } finally {
    controller.dispose()
  }
})

test('T22. a host without retainInfo keeps activation identity-aware; pending resync/dispose stay safe', () => {
  const { sessions, controller } = createNavigationController({ withRetainInfo: false })
  try {
    const sourceA1 = openSession(sessions, controller, 'A', 'tool', 4)
    sessions.retire('A')
    assert.equal(controller.attach('A'), false, 'no current binding')
    assert.equal(controller.project('A', 1200).kind, 'hidden', 'stale live evidence is suppressed even without a retention signal')
    assert.equal(controller.diagnostics('A').bindingPending, true)

    // Without the public binding-ready signal the controller keeps its last
    // subscription (it cannot know when to retry); the next activation still
    // compares identity and rebinds correctly.
    assert.equal(sourceA1.listenerCount(), 1, 'fallback host keeps the last subscription until activation')
    assert.equal(controller.resync('A', 'pending-resync').resynced, false, 'resync while pending is a safe no-op')

    const sourceA2 = createFakeSource('A')
    sourceA2.replace(turnWindow('completed'), 1)
    sessions.materialize('A', sourceA2)
    assert.equal(controller.attach('A'), true, 'the next activation attaches the new generation')
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 1)
    assert.equal(sourceA1.listenerCount(), 0, 'the stale subscription is released on rebind')
    assert.equal(sourceA2.listenerCount(), 1)
    assert.equal(viewKey(controller.project('A', 6000)), 'settled')

    // Disposing while a binding is pending leaves no listener behind. Without a
    // retainInfo signal retirement is only discovered by the next activation.
    sessions.retire('A')
    assert.equal(controller.attach('A'), false, 'activation discovers the missing binding')
    assert.equal(controller.diagnostics('A').bindingPending, true)
    controller.dispose()
    assert.equal(sourceA2.listenerCount(), 0)
    assert.equal(controller.project('A', 6000).kind, 'hidden')
  } finally {
    controller.dispose()
  }
})

test('T23. a concurrent sidebarView retention keeps the generation alive: same source, no rebind', () => {
  const { sessions, controller } = createNavigationController()
  try {
    const source = openSession(sessions, controller, 'A', 'streaming', 3)
    const viewBefore = viewKey(controller.project('A', 1300))
    const revisionBefore = controller.diagnostics('A').lastFeedRevision

    // While the hidden session is also retained by a right-sidebar panel, the
    // main-view reference can be released without retiring the scope.
    sessions.setRetention('A', { referenceCount: 2, retainedBy: { mainView: 1, sidebarView: 1 } })
    sessions.setRetention('A', { referenceCount: 1, retainedBy: { sidebarView: 1 } })
    assert.equal(controller.diagnostics('A').bindingPending, false, 'binding remains available')

    // Re-activation sees the SAME source object: authoritative resync, no rebind.
    assert.equal(controller.attach('A'), true)
    assert.equal(controller.diagnostics('A').eventSourceRebinds, 0, 'same generation is not rebound')
    assert.equal(source.listenerCount(), 1, 'still exactly one subscription')
    assert.equal(viewKey(controller.project('A', 1300)), viewBefore)
    assert.equal(controller.diagnostics('A').lastFeedRevision, revisionBefore)

    // A later authoritative window on that same source is picked up normally.
    source.replace(turnWindow('completed'), 4)
    assert.equal(viewKey(controller.project('A', 6000)), 'settled')
  } finally {
    controller.dispose()
  }
})

/* ================================================================== *
 * Recording React + component harness
 * ================================================================== */

let meterBundleCode = null

async function loadMeterBundle() {
  if (meterBundleCode === null) meterBundleCode = await bundleClient({ entryId: 'src/client/live/MeterRoot.js' })
  return {
    createFactory({ document: doc, timers }) {
      let registration = null
      const sandbox = {
        window: { __ModuleLoader__: { load: reg => { registration = reg.factory } } },
        document: doc,
        console: { debug() {}, log() {}, warn() {}, error() {} },
        Date,
        setTimeout: timers.setTimeoutImpl,
        clearTimeout: timers.clearTimeoutImpl,
        setInterval: timers.setIntervalImpl,
        clearInterval: timers.clearIntervalImpl,
      }
      vm.runInNewContext(meterBundleCode, sandbox)
      let factory = registration
      return function create(require) {
        return factory(require)
      }
    },
  }
}

/**
 * A minimal React hook runtime good enough to drive `MeterRoot` deterministically:
 * hook slots persist across renders, effects with changed deps are re-run after
 * their cleanup, and effects without deps run on every commit.
 */
function createReactRuntime() {
  const states = []
  const refs = []
  const effectSlots = []
  let stateIndex = 0
  let refIndex = 0
  let effectIndex = 0
  let currentEffects = []

  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef(initial) {
      const index = refIndex++
      if (index >= refs.length) refs.push({ current: initial })
      return refs[index]
    },
    useState(initial) {
      const index = stateIndex++
      if (index >= states.length) states.push(typeof initial === 'function' ? initial() : initial)
      const setter = value => {
        states[index] = typeof value === 'function' ? value(states[index]) : value
      }
      return [states[index], setter]
    },
    useEffect(fn, deps) {
      currentEffects[effectIndex++] = { fn, deps }
    },
  }
  react.useLayoutEffect = (fn, deps) => {
    currentEffects[effectIndex++] = { fn, deps }
  }

  return {
    react,
    states,
    /** Call before each render. */
    beginRender() {
      stateIndex = 0
      refIndex = 0
      effectIndex = 0
      currentEffects = []
    },
    /** Run this render's effects (cleanup first when deps changed). */
    commit() {
      const effects = currentEffects
      effects.forEach((effect, index) => {
        const previous = effectSlots[index]
        const sameDeps = previous !== undefined
          && previous.deps !== undefined
          && effect.deps !== undefined
          && previous.deps.length === effect.deps.length
          && previous.deps.every((value, depIndex) => Object.is(value, effect.deps[depIndex]))
        if (sameDeps) return
        if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
        const cleanup = effect.fn()
        effectSlots[index] = {
          deps: effect.deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        }
      })
    },
    unmount() {
      for (let index = effectSlots.length - 1; index >= 0; index -= 1) {
        const slot = effectSlots[index]
        if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
        effectSlots[index] = undefined
      }
    },
  }
}

function createSlotHarness({ Component, runtime }) {
  let lastElement = null
  return {
    render(props) {
      runtime.beginRender()
      lastElement = Component(props)
      return lastElement
    },
    commit() {
      runtime.commit()
    },
    update(props) {
      this.render(props)
      runtime.commit()
      return this
    },
    unmount() {
      runtime.unmount()
    },
    view: () => runtime.states[0],
    scheduler: () => runtime.states[1],
    element: () => lastElement,
  }
}

/* ================================================================== *
 * DOM / window mocks (the page stays visible unless a test changes it)
 * ================================================================== */

function createMockDocument(initialVisibility = 'visible') {
  const documentListeners = new Map()
  const styles = []
  let visibilityState = initialVisibility
  const doc = {
    visibilityChanges: 0,
    foregroundEvents: 0,
    get visibilityState() { return visibilityState },
    setVisibility(next) {
      visibilityState = next
      doc.visibilityChanges += 1
      for (const handler of documentListeners.get('visibilitychange') ?? []) handler()
    },
    addEventListener(name, handler) {
      if (!documentListeners.has(name)) documentListeners.set(name, [])
      documentListeners.get(name).push(handler)
    },
    removeEventListener(name, handler) {
      const handlers = documentListeners.get(name) ?? []
      const index = handlers.indexOf(handler)
      if (index >= 0) handlers.splice(index, 1)
    },
    getElementById(id) {
      return styles.find(style => style.id === id) ?? null
    },
    createElement() {
      const element = {
        id: '',
        textContent: '',
        setAttribute() {},
        remove() {
          const index = styles.indexOf(element)
          if (index >= 0) styles.splice(index, 1)
        },
      }
      return element
    },
    head: {
      appendChild(element) { styles.push(element) },
    },
    styleCount() { return styles.length },
  }
  return doc
}

function createMockWindow() {
  const listeners = new Map()
  return {
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
    },
    removeEventListener(name, handler) {
      const handlers = listeners.get(name) ?? []
      const index = handlers.indexOf(handler)
      if (index >= 0) handlers.splice(index, 1)
    },
    fire(name) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler()
    },
  }
}
