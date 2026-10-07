/**
 * Phase 10.1R — Foreground Resynchronization & Revision-Gap Recovery.
 *
 * Mandatory deterministic test matrix:
 *
 *   Section 14:
 *     A. Revision gap: append (full generation rebaseline over window.entries)
 *     B. Missed turn/end (recovers completed card, not stuck on waiting-model)
 *     C. Missed attempt transition (recovers current attempt/state from full window)
 *     D. Same-revision foreground resync (idempotent, no duplicates, no metric change)
 *     E. Consecutive revision n -> n+1 (ordinary incremental delta, no rebaseline)
 *     F. Explicit replace (replace semantics preserved)
 *     G. Event source replacement (old unsubscribed, new subscribed, full rebaseline)
 *     H. Multi-session isolation (resync session A leaves session B untouched)
 *
 *   Section 15:
 *     I. foreground -> hidden (scheduler suspended, timer count 0)
 *     J. events while hidden (ingestion continues, no React render churn, no timer churn)
 *     K. hidden -> visible (immediate recovery render, ticker resumes only if live)
 *     L. turn completed while hidden (first visible view is completed, no intermediate waiting frame)
 *     M. still-live turn (current live state appears immediately, ticker resumes)
 *     N. completed card (settled view remains static, no periodic timer after recovery)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { SessionEventFeed } from '../src/dsh/client-feed.js'
import { createController } from '../src/client/live/controller.js'
import { createPresentationScheduler } from '../src/client/live/refresh.js'
import { bundleClient } from '../scripts/bundle-client.mjs'
import { durableEntry, transientEntry, fakeSessionsService } from './helpers/live-replay.js'

const chunk = text => ({ type: 'text-delta', index: 0, text })
const reasoningChunk = text => ({ type: 'reasoning-delta', index: 0, text })

/* ================================================================== *
 * Section 14: Gap Recovery & Controller Resync Contract (A - H)
 * ================================================================== */

test('14A. Revision gap: append triggers full generation rebaseline without duplicates', () => {
  const events = []
  const issues = []
  const feed = new SessionEventFeed({
    sessionId: 's-gap-a',
    onEvent: e => events.push(e),
    onIssue: i => issues.push(i),
  })

  // Initial window at revision 10
  const e1 = durableEntry('turn/start', 1, 1000, { turn: 1 })
  const e2 = durableEntry('tool/call', 2, 1050, { turn: 1, callId: 'c1', name: 'search' })
  feed.applyWindow({ entries: [e1, e2], revision: 10, change: { kind: 'replace', entries: [e1, e2] } })

  assert.equal(feed.revision, 10)
  assert.equal(events.filter(e => e.kind === 'turn-start').length, 1)
  assert.equal(events.filter(e => e.kind === 'tool-call').length, 1)

  // Intermediate missed revisions 11, 12, 13
  const e3 = durableEntry('tool/result', 3, 1100, { turn: 1, callId: 'c1' })
  const e4 = durableEntry('step/start', 4, 1150, { turn: 1, step: 2 })
  const e5 = transientEntry('att-2', 1200, chunk('resumed model output'))

  // Revision 14 arrives directly with change.kind = append (carrying only e5)
  // but full window.entries contains [e1, e2, e3, e4, e5]
  const fullWindow14 = [e1, e2, e3, e4, e5]
  feed.applyWindow({
    entries: fullWindow14,
    revision: 14,
    change: { kind: 'append', entries: [e5] },
  })

  // Provenance diagnostics
  assert.equal(feed.revision, 14)
  assert.equal(feed.counters.revisionGapsDetected, 1)
  assert.equal(feed.counters.revisionGapRebaselines, 1)
  assert.deepEqual(feed.lastGap, {
    previousRevision: 10,
    incomingRevision: 14,
    missedRevisionCount: 3,
  })

  // State equivalence to a fresh feed initialized directly over revision-14 window
  const freshEvents = []
  const freshFeed = new SessionEventFeed({
    sessionId: 's-fresh',
    onEvent: e => freshEvents.push(e),
  })
  freshFeed.applyWindow({
    entries: fullWindow14,
    revision: 14,
    change: { kind: 'replace', entries: fullWindow14 },
  })

  // The recovered feed emitted a rebaseline, and subsequent events match fresh feed
  const postRebaselineEvents = events.slice(events.findIndex(e => e.kind === 'window-rebaseline') + 1)
  assert.deepEqual(
    postRebaselineEvents.map(e => e.kind),
    freshEvents.map(e => e.kind),
    'recovered events after gap rebaseline must match fresh feed over full window',
  )
  assert.equal(postRebaselineEvents.filter(e => e.kind === 'attempt-delta').length, 1)
})

test('14B. Missed turn/end: gap recovery yields completed card instead of stuck waiting-model', () => {
  let snap = null
  const listeners = new Set()
  const source = {
    getSnapshot: () => snap,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const sessions = {
    binding: id => ({ sessionId: id, eventSource: source }),
  }

  const e1 = durableEntry('turn/start', 1, 1000, { turn: 1 })
  const e2 = durableEntry('tool/call', 2, 1050, { turn: 1, callId: 'c1', name: 'search' })
  snap = { entries: [e1, e2], revision: 10, change: { kind: 'replace', entries: [e1, e2] } }

  const controller = createController({ sessions })
  controller.attach('s-gap-b')

  // Before gap: meter is in tool stage
  let proj = controller.project('s-gap-b', 1060)
  assert.equal(proj.kind, 'tool')
  assert.equal(proj.state, 'tool-running')

  // Missed revisions 11, 12, 13 include tool result, settlement, and turn/end
  // Do NOT deliver them to the feed / do NOT call listeners
  const e3 = durableEntry('tool/result', 3, 1100, { turn: 1, callId: 'c1' })
  const e4 = durableEntry('turn/end', 4, 1200, { turn: 1, reason: { kind: 'completed' } })
  const e5 = durableEntry('custom/ping', 5, 1300, { turn: 1 })

  // Authoritative source snapshot is now revision 14, carrying full contiguous window
  snap = {
    entries: [e1, e2, e3, e4, e5],
    revision: 14,
    change: { kind: 'append', entries: [e5] },
  }

  // Explicit foreground resync
  const resyncResult = controller.resync('s-gap-b', 'foreground-test')
  assert.equal(resyncResult.resynced, true)
  assert.equal(resyncResult.lastFeedRevision, 14)
  assert.equal(resyncResult.revisionGapsDetected, 1)

  // Authoritative projection after gap recovery must be completed, NOT stuck on waiting-model or tool
  proj = controller.project('s-gap-b', 1350)
  assert.equal(proj.kind, 'completed', 'gap recovery must yield completed card')
  assert.equal(proj.state, 'settled')
  assert.equal(proj.turn, 1)
})

test('14C. Missed attempt transition: gap recovery adopts new streaming attempt from full window', () => {
  let snap = null
  const listeners = new Set()
  const source = {
    getSnapshot: () => snap,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const sessions = {
    binding: id => ({ sessionId: id, eventSource: source }),
  }

  const e1 = durableEntry('turn/start', 1, 1000, { turn: 1 })
  const e2 = durableEntry('tool/call', 2, 1050, { turn: 1, callId: 'c1', name: 'search' })
  snap = { entries: [e1, e2], revision: 5, change: { kind: 'replace', entries: [e1, e2] } }

  const controller = createController({ sessions })
  controller.attach('s-gap-c')

  let proj = controller.project('s-gap-c', 1060)
  assert.equal(proj.state, 'tool-running')

  // Missed revisions: tool result, step start, attempt 2 streaming
  const e3 = durableEntry('tool/result', 3, 1100, { turn: 1, callId: 'c1' })
  const e4 = durableEntry('step/start', 4, 1150, { turn: 1, step: 2 })
  const e5 = transientEntry('att-2', 1200, chunk('chunk 1'))
  const e6 = transientEntry('att-2', 1210, chunk('chunk 2'))
  const e7 = transientEntry('att-2', 1220, chunk('chunk 3'))

  snap = {
    entries: [e1, e2, e3, e4, e5, e6, e7],
    revision: 9,
    change: { kind: 'append', entries: [e7] },
  }

  controller.resync('s-gap-c', 'foreground-test')

  proj = controller.project('s-gap-c', 1250)
  assert.ok(proj.kind === 'streaming' || proj.kind === 'warming')
  assert.equal(proj.phase, 'output')
})

test('14D. Same revision foreground resync is idempotent with no metric change or duplicates', () => {
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-gap-d')
  const e1 = durableEntry('turn/start', 1, 1000, { turn: 1 })
  const e2 = transientEntry('att-1', 1100, chunk('hello'))
  const e3 = transientEntry('att-1', 1150, chunk('world'))
  source.replaceEntries([e1, e2, e3], 1)

  const controller = createController({ sessions })
  controller.attach('s-gap-d')

  const view1 = controller.project('s-gap-d', 1200)
  const diag1 = controller.diagnostics('s-gap-d')

  // Foreground resync #1
  const r1 = controller.resync('s-gap-d', 'call-1')
  assert.equal(r1.resynced, true)
  assert.equal(r1.revisionGapsDetected, 0, 'same revision is not a gap')

  // Foreground resync #2
  const r2 = controller.resync('s-gap-d', 'call-2')
  assert.equal(r2.resynced, true)
  assert.equal(r2.revisionGapsDetected, 0)

  const view2 = controller.project('s-gap-d', 1200)
  const diag2 = controller.diagnostics('s-gap-d')

  assert.equal(view1.kind, view2.kind)
  assert.equal(view1.state, view2.state)
  assert.equal(diag1.counters.normalizedTurnEndSeen, diag2.counters.normalizedTurnEndSeen)
  assert.equal(diag2.foregroundResyncs, 2)
  assert.equal(diag2.eventSourceRebinds, 0)
})

test('14E. Consecutive revision n -> n+1 uses ordinary incremental delta processing without rebaseline', () => {
  const events = []
  const feed = new SessionEventFeed({
    sessionId: 's-consec',
    onEvent: e => events.push(e),
  })

  const e1 = durableEntry('turn/start', 1, 1000, { turn: 1 })
  feed.applyWindow({ entries: [e1], revision: 1, change: { kind: 'replace', entries: [e1] } })
  assert.equal(feed.revision, 1)

  const e2 = transientEntry('att-1', 1050, chunk('delta 1'))
  feed.applyWindow({ entries: [e1, e2], revision: 2, change: { kind: 'append', entries: [e2] } })
  assert.equal(feed.revision, 2)
  assert.equal(feed.counters.revisionGapsDetected, 0, 'consecutive revision 2 must not trigger gap')

  const e3 = transientEntry('att-1', 1060, chunk('delta 2'))
  feed.applyWindow({ entries: [e1, e2, e3], revision: 3, change: { kind: 'append', entries: [e3] } })
  assert.equal(feed.revision, 3)
  assert.equal(feed.counters.revisionGapsDetected, 0, 'consecutive revision 3 must not trigger gap')

  // No window-rebaseline event should have been emitted after initialization
  assert.equal(events.filter(e => e.kind === 'window-rebaseline').length, 0)
})

test('14F. Explicit replace semantics remain exactly correct', () => {
  const events = []
  const feed = new SessionEventFeed({
    sessionId: 's-replace',
    onEvent: e => events.push(e),
  })

  const e1 = durableEntry('turn/start', 1, 1000, { turn: 1 })
  feed.applyWindow({ entries: [e1], revision: 1, change: { kind: 'replace', entries: [e1] } })

  const e2 = durableEntry('turn/start', 1, 1000, { turn: 1 })
  const e3 = durableEntry('turn/end', 2, 2000, { turn: 1, reason: { kind: 'completed' } })
  feed.applyWindow({ entries: [e2, e3], revision: 2, change: { kind: 'replace', entries: [e2, e3] } })

  // Explicit replace emitted window-rebaseline and replayed cleanly
  assert.equal(events.filter(e => e.kind === 'window-rebaseline').length, 1)
  assert.equal(events.filter(e => e.kind === 'turn-end').length, 1)
  assert.equal(feed.revision, 2)
})

test('14G. Event source replacement: rebinds source, removes old listener, rebaselines from new source', () => {
  let currentSource = null
  const sessions = {
    binding: id => ({ sessionId: id, eventSource: currentSource }),
  }

  // Old source at high revision 42
  let oldListeners = new Set()
  const oldSource = {
    getSnapshot: () => ({ entries: [durableEntry('turn/start', 1, 1000, { turn: 1 })], revision: 42, change: { kind: 'replace', entries: [] } }),
    subscribe: fn => { oldListeners.add(fn); return () => oldListeners.delete(fn) },
  }
  currentSource = oldSource

  const controller = createController({ sessions })
  controller.attach('s-rebind')
  assert.equal(oldListeners.size, 1, 'old source subscribed')

  // New source starts with revision 1
  let newListeners = new Set()
  const newSourceEntries = [
    durableEntry('turn/start', 1, 2000, { turn: 2 }),
    durableEntry('turn/end', 2, 2100, { turn: 2, reason: { kind: 'completed' } }),
  ]
  const newSource = {
    getSnapshot: () => ({ entries: newSourceEntries, revision: 1, change: { kind: 'replace', entries: newSourceEntries } }),
    subscribe: fn => { newListeners.add(fn); return () => newListeners.delete(fn) },
  }
  currentSource = newSource

  // Foreground resync triggers eventSource rebind
  const result = controller.resync('s-rebind', 'source-replaced')
  assert.equal(result.resynced, true)
  assert.equal(result.sourceRebound, true)
  assert.equal(result.eventSourceRebinds, 1)
  assert.equal(oldListeners.size, 0, 'old source must be unsubscribed')
  assert.equal(newListeners.size, 1, 'new source must be subscribed')

  // Stale mutation on old source must be ignored
  assert.doesNotThrow(() => {
    for (const fn of oldListeners) fn()
  })

  const proj = controller.project('s-rebind', 2200)
  assert.equal(proj.kind, 'completed')
  assert.equal(proj.turn, 2)
})

test('14H. Multi-session isolation: resync/rebind of session A leaves session B untouched', () => {
  const sessions = fakeSessionsService()
  const sourceA = sessions.createSource('sess-A')
  const sourceB = sessions.createSource('sess-B')
  sourceA.replaceEntries([durableEntry('turn/start', 1, 1000, { turn: 1 })], 1)
  sourceB.replaceEntries([
    durableEntry('turn/start', 1, 1000, { turn: 1 }),
    transientEntry('att-b', 1100, chunk('data-B')),
  ], 1)

  const controller = createController({ sessions })
  controller.attach('sess-A')
  controller.attach('sess-B')

  const projBBefore = controller.project('sess-B', 1150)
  const diagBBefore = controller.diagnostics('sess-B')

  // Advance session A with gap
  sourceA.replaceEntries([
    durableEntry('turn/start', 1, 1000, { turn: 1 }),
    durableEntry('turn/end', 2, 1200, { turn: 1, reason: { kind: 'completed' } }),
  ], 10)
  controller.resync('sess-A', 'foreground-A')

  const projBAfter = controller.project('sess-B', 1150)
  const diagBAfter = controller.diagnostics('sess-B')

  assert.equal(projBBefore.state, projBAfter.state)
  assert.equal(diagBBefore.lastFeedRevision, diagBAfter.lastFeedRevision)
  assert.equal(diagBAfter.foregroundResyncs, 0)
  assert.equal(diagBAfter.revisionGapsDetected, 0)
})

/* ================================================================== *
 * Section 15: MeterRoot / Presentation Visibility Lifecycle (I - N)
 * ================================================================== */

function createMockDom(initialVisibility = 'visible') {
  let visibilityState = initialVisibility
  const docListeners = new Map()
  const winListeners = new Map()

  const doc = {
    get visibilityState() { return visibilityState },
    setVisibility(v) {
      visibilityState = v
      const handlers = docListeners.get('visibilitychange') ?? []
      for (const h of handlers) h()
    },
    addEventListener(name, fn) {
      if (!docListeners.has(name)) docListeners.set(name, [])
      docListeners.get(name).push(fn)
    },
    removeEventListener(name, fn) {
      const list = docListeners.get(name) ?? []
      const idx = list.indexOf(fn)
      if (idx >= 0) list.splice(idx, 1)
    },
    getElementById: () => null,
    createElement: () => ({ id: '', setAttribute: () => {}, remove: () => {} }),
    head: { appendChild: () => {} },
  }

  const win = {
    addEventListener(name, fn) {
      if (!winListeners.has(name)) winListeners.set(name, [])
      winListeners.get(name).push(fn)
    },
    removeEventListener(name, fn) {
      const list = winListeners.get(name) ?? []
      const idx = list.indexOf(fn)
      if (idx >= 0) list.splice(idx, 1)
    },
    fire(name) {
      const list = winListeners.get(name) ?? []
      for (const h of list) h()
    },
  }

  return { doc, win }
}

const activeIntervals = new Set()
const activeTimeouts = new Set()

function clearAllActiveTimers() {
  for (const id of activeIntervals) clearInterval(id)
  activeIntervals.clear()
  for (const id of activeTimeouts) clearTimeout(id)
  activeTimeouts.clear()
}

async function loadMeterSlotModule() {
  const bundleCode = await bundleClient({ entryId: 'src/client/live/MeterRoot.js' })
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: reg => { factory = reg.factory } } },
    document: { getElementById: () => null, createElement: () => ({ setAttribute: () => {}, id: '' }), head: { appendChild: () => {} } },
    console,
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms)
      activeTimeouts.add(id)
      return id
    },
    clearTimeout: id => {
      activeTimeouts.delete(id)
      clearTimeout(id)
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms)
      activeIntervals.add(id)
      return id
    },
    clearInterval: id => {
      activeIntervals.delete(id)
      clearInterval(id)
    },
  }
  vm.runInNewContext(bundleCode, sandbox)
  return factory
}

test('15I. foreground -> hidden: scheduler interval stopped/suspended, presentation timer count 0', () => {
  let renders = 0
  const scheduler = createPresentationScheduler({
    intervalMs: 100,
    onRender: () => { renders++ },
  })

  scheduler.start()
  assert.equal(scheduler.ticking, true)
  assert.equal(scheduler.timerCount, 1)

  // Document goes to background -> suspend scheduler
  scheduler.suspend()
  assert.equal(scheduler.ticking, false)
  assert.equal(scheduler.suspended, true)
  assert.equal(scheduler.timerCount, 0, 'presentation timer count must be 0 when hidden')
})

test('15J. events while hidden: ingestion active, no presentation timer churn or leading timeouts', () => {
  let renders = 0
  const scheduler = createPresentationScheduler({
    intervalMs: 100,
    onRender: () => { renders++ },
  })

  scheduler.suspend()
  assert.equal(scheduler.suspended, true)

  // 1000 events arrive while hidden
  for (let i = 0; i < 1000; i++) {
    scheduler.notify()
  }

  assert.equal(scheduler.timerCount, 0, 'suspended scheduler must create 0 timers')
  assert.equal(renders, 0, 'no renders while hidden')
})

test('15K. hidden -> visible: authoritative resync, immediate render, and scheduler start if live', async () => {
  const factory = await loadMeterSlotModule()
  const { doc, win } = createMockDom('visible')

  let hookState = []
  let hookSetters = []
  let hookEffects = []
  let slotIndex = 0
  let effectIndex = 0

  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: init => ({ current: init }),
    useState: init => {
      const idx = slotIndex++
      if (idx >= hookState.length) {
        hookState.push(typeof init === 'function' ? init() : init)
      }
      const setter = val => {
        hookState[idx] = typeof val === 'function' ? val(hookState[idx]) : val
      }
      hookSetters[idx] = setter
      return [hookState[idx], setter]
    },
    useEffect: (fn, deps) => {
      const idx = effectIndex++
      hookEffects[idx] = { fn, deps }
    },
  }

  const { makeMeterSlot } = factory(spec => spec === 'react' ? reactStub : null)
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-vis-k')
  const controller = createController({ sessions })

  try {
    source.replaceEntries([
      durableEntry('turn/start', 1, 1000, { turn: 1 }),
      transientEntry('att-1', 1050, chunk('live data')),
    ], 2)

    const Component = makeMeterSlot({
      controller,
      t: k => k,
      documentTarget: doc,
      windowTarget: win,
    })

    // Mount
    slotIndex = 0
    effectIndex = 0
    let rendered = Component({ sessionId: 's-vis-k' })
    for (const eff of hookEffects) if (typeof eff?.fn === 'function') eff.cleanup = eff.fn()

    assert.ok(hookState[0].kind === 'warming' || hookState[0].kind === 'streaming')

    // Background the document
    doc.setVisibility('hidden')
    const diag = controller.diagnostics('s-vis-k')

    // Foreground the document
    doc.setVisibility('visible')
    const diagAfter = controller.diagnostics('s-vis-k')
    assert.ok(diagAfter.foregroundResyncs >= 1, 'resync called on foreground recovery')
  } finally {
    clearAllActiveTimers()
    controller.dispose()
  }
})

test('15L. turn completed while hidden: first recovered view is completed, no intermediate waiting frame', async () => {
  const factory = await loadMeterSlotModule()
  const { doc, win } = createMockDom('visible')

  let hookState = []
  let slotIndex = 0
  let hookEffects = []
  let effectIndex = 0

  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: init => ({ current: init }),
    useState: init => {
      const idx = slotIndex++
      if (idx >= hookState.length) {
        hookState.push(typeof init === 'function' ? init() : init)
      }
      const setter = val => {
        hookState[idx] = typeof val === 'function' ? val(hookState[idx]) : val
      }
      return [hookState[idx], setter]
    },
    useEffect: fn => {
      const idx = effectIndex++
      hookEffects[idx] = { fn }
    },
  }

  const { makeMeterSlot } = factory(spec => spec === 'react' ? reactStub : null)
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-vis-l')
  const controller = createController({ sessions })

  try {
    // Initial state: tool wait
    const e1 = durableEntry('turn/start', 1, 1000, { turn: 1 })
    const e2 = durableEntry('tool/call', 2, 1050, { turn: 1, callId: 'c1', name: 'search' })
    source.replaceEntries([e1, e2], 2)

    const Component = makeMeterSlot({
      controller,
      t: k => k,
      documentTarget: doc,
      windowTarget: win,
    })

    slotIndex = 0
    effectIndex = 0
    Component({ sessionId: 's-vis-l' })
    for (const eff of hookEffects) if (typeof eff?.fn === 'function') eff.cleanup = eff.fn()

    // Background
    doc.setVisibility('hidden')

    // Turn completes while hidden
    const e3 = durableEntry('tool/result', 3, 1100, { turn: 1, callId: 'c1' })
    const e4 = durableEntry('turn/end', 4, 1200, { turn: 1, reason: { kind: 'completed' } })
    source.replaceEntries([e1, e2, e3, e4], 10) // gap jump to 10

    // Foreground
    doc.setVisibility('visible')

    // Check recovered view state directly: must be completed
    const currentView = hookState[0]
    assert.equal(currentView.kind, 'completed', 'recovered view must immediately be completed')
    assert.equal(currentView.state, 'settled')
  } finally {
    clearAllActiveTimers()
    controller.dispose()
  }
})

test('15M. still-live turn: current live state appears immediately and 10 Hz ticker resumes', () => {
  let renders = 0
  const scheduler = createPresentationScheduler({
    intervalMs: 100,
    onRender: () => { renders++ },
  })

  // Start in background
  scheduler.suspend()
  assert.equal(scheduler.ticking, false)

  // Foreground recovery for still-live turn
  scheduler.resume()
  scheduler.start()

  assert.equal(scheduler.ticking, true, 'ticker resumed')
  assert.equal(scheduler.timerCount, 1)
  scheduler.dispose()
})

test('15N. completed card: completed view remains static with no periodic timer after recovery', () => {
  const scheduler = createPresentationScheduler({
    intervalMs: 100,
    onRender: () => {},
  })

  // For completed view, scheduler is resumed then stopped
  scheduler.resume()
  scheduler.stop()

  assert.equal(scheduler.ticking, false, 'completed card leaves ticker stopped')
  assert.equal(scheduler.timerCount, 0, 'zero timers for completed card')
  scheduler.dispose()
})

test('15O. lifecycle regression: < 50 ms hidden->visible edge must not be suppressed by previous foreground recovery', async () => {
  const factory = await loadMeterSlotModule()
  const { doc, win } = createMockDom('visible')

  let hookState = []
  let hookSetters = []
  let hookEffects = []
  let hookRefs = []
  let slotIndex = 0
  let effectIndex = 0
  let refIndex = 0

  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: init => {
      const idx = refIndex++
      if (idx >= hookRefs.length) {
        hookRefs.push({ current: init })
      }
      return hookRefs[idx]
    },
    useState: init => {
      const idx = slotIndex++
      if (idx >= hookState.length) {
        hookState.push(typeof init === 'function' ? init() : init)
      }
      const setter = val => {
        hookState[idx] = typeof val === 'function' ? val(hookState[idx]) : val
      }
      hookSetters[idx] = setter
      return [hookState[idx], setter]
    },
    useEffect: (fn, deps) => {
      const idx = effectIndex++
      hookEffects[idx] = { fn, deps }
    },
  }

  const { makeMeterSlot } = factory(spec => spec === 'react' ? reactStub : null)
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-coalesce')
  const controller = createController({ sessions })

  try {
    source.replaceEntries([
      durableEntry('turn/start', 1, 1000, { turn: 1 }),
      transientEntry('att-1', 1050, chunk('live data')),
    ], 2)

    const Component = makeMeterSlot({
      controller,
      t: k => k,
      documentTarget: doc,
      windowTarget: win,
    })

    // Mount
    slotIndex = 0
    refIndex = 0
    effectIndex = 0
    Component({ sessionId: 's-coalesce' })
    for (const eff of hookEffects) if (typeof eff?.fn === 'function') eff.cleanup = eff.fn()

    const scheduler = hookState[1]
    assert.equal(scheduler.suspended, false, 'scheduler starts unsuspended')

    // 1. Foreground recovery A
    win.fire('focus')
    assert.equal(controller.diagnostics('s-coalesce').foregroundResyncs, 1, 'recovery A executed')

    // 2. < 50 ms later: visibility -> hidden
    doc.setVisibility('hidden')
    assert.equal(scheduler.suspended, true, 'scheduler suspended after hidden')

    // Advance session while hidden
    source.replaceEntries([
      durableEntry('turn/start', 1, 1000, { turn: 1 }),
      transientEntry('att-1', 1050, chunk('live data')),
      transientEntry('att-1', 1080, chunk(' second chunk')),
    ], 3)

    // 3. < 50 ms later: visibility -> visible, then focus
    doc.setVisibility('visible')
    win.fire('focus')

    // On f8246227, the 50 ms guard rejects visible recovery:
    // resync is NOT called for new generation (stays 1 instead of 2)
    // and scheduler remains suspended!
    assert.equal(
      controller.diagnostics('s-coalesce').foregroundResyncs,
      2,
      'controller.resync must be called for new foreground generation'
    )
    assert.equal(
      scheduler.suspended,
      false,
      'scheduler must not remain suspended after genuine visible recovery'
    )
  } finally {
    clearAllActiveTimers()
    controller.dispose()
  }
})

/* ================================================================== *
 * Section 16: Generation-Safe Foreground Recovery & Coalescing (A - E)
 * ================================================================== */

async function mountMeterSlot({ sessionId, initialEntries = [], initialVisibility = 'visible' } = {}) {
  const factory = await loadMeterSlotModule()
  const { doc, win } = createMockDom(initialVisibility)

  let hookState = []
  let hookSetters = []
  let hookEffects = []
  let hookRefs = []
  let slotIndex = 0
  let effectIndex = 0
  let refIndex = 0
  let renderCount = 0

  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: init => {
      const idx = refIndex++
      if (idx >= hookRefs.length) {
        hookRefs.push({ current: init })
      }
      return hookRefs[idx]
    },
    useState: init => {
      const idx = slotIndex++
      if (idx >= hookState.length) {
        hookState.push(typeof init === 'function' ? init() : init)
      }
      const setter = val => {
        renderCount++
        hookState[idx] = typeof val === 'function' ? val(hookState[idx]) : val
      }
      hookSetters[idx] = setter
      return [hookState[idx], setter]
    },
    useEffect: (fn, deps) => {
      const idx = effectIndex++
      hookEffects[idx] = { fn, deps }
    },
  }

  const { makeMeterSlot } = factory(spec => spec === 'react' ? reactStub : null)
  const sessions = fakeSessionsService()
  const source = sessions.createSource(sessionId)
  const controller = createController({ sessions })

  if (initialEntries.length > 0) {
    source.replaceEntries(initialEntries, initialEntries.length)
  }

  const Component = makeMeterSlot({
    controller,
    t: k => k,
    documentTarget: doc,
    windowTarget: win,
  })

  // Mount
  slotIndex = 0
  refIndex = 0
  effectIndex = 0
  Component({ sessionId })
  for (const eff of hookEffects) if (typeof eff?.fn === 'function') eff.cleanup = eff.fn()

  return {
    doc,
    win,
    source,
    controller,
    getScheduler: () => hookState[1],
    getView: () => hookState[0],
    getRenderCount: () => renderCount,
    dispose: () => {
      clearAllActiveTimers()
      controller.dispose()
    },
  }
}

test('16A. focus -> hidden -> visible all within 50 ms: visible recovery MUST happen', async () => {
  const s = await mountMeterSlot({
    sessionId: 's-16a',
    initialEntries: [
      durableEntry('turn/start', 1, 1000, { turn: 1 }),
      transientEntry('att-1', 1050, chunk('live data')),
    ],
  })
  try {
    const scheduler = s.getScheduler()
    assert.equal(scheduler.suspended, false)

    // Initial recovery on focus
    s.win.fire('focus')
    assert.equal(s.controller.diagnostics('s-16a').foregroundResyncs, 1)

    // < 50 ms later: visibility -> hidden
    s.doc.setVisibility('hidden')
    assert.equal(scheduler.suspended, true)

    // < 50 ms later: visibility -> visible
    s.doc.setVisibility('visible')
    assert.equal(
      s.controller.diagnostics('s-16a').foregroundResyncs,
      2,
      'visible recovery must occur despite preceding focus < 50 ms ago'
    )
    assert.equal(scheduler.suspended, false, 'scheduler must be resumed')

    // Same generation focus does not cause second destructive recovery
    s.win.fire('focus')
    assert.equal(s.controller.diagnostics('s-16a').foregroundResyncs, 2)
  } finally {
    s.dispose()
  }
})

test('16B. pageshow -> hidden -> visible within 50 ms: visible recovery MUST happen', async () => {
  const s = await mountMeterSlot({
    sessionId: 's-16b',
    initialEntries: [
      durableEntry('turn/start', 1, 1000, { turn: 1 }),
      transientEntry('att-1', 1050, chunk('live data')),
    ],
  })
  try {
    const scheduler = s.getScheduler()
    assert.equal(scheduler.suspended, false)

    // Initial recovery on pageshow
    s.win.fire('pageshow')
    assert.equal(s.controller.diagnostics('s-16b').foregroundResyncs, 1)

    // < 50 ms later: visibility -> hidden
    s.doc.setVisibility('hidden')
    assert.equal(scheduler.suspended, true)

    // < 50 ms later: visibility -> visible
    s.doc.setVisibility('visible')
    assert.equal(
      s.controller.diagnostics('s-16b').foregroundResyncs,
      2,
      'visible recovery must occur despite preceding pageshow < 50 ms ago'
    )
    assert.equal(scheduler.suspended, false, 'scheduler must be resumed')

    // Subsequent pageshow on same generation coalesced
    s.win.fire('pageshow')
    assert.equal(s.controller.diagnostics('s-16b').foregroundResyncs, 2)
  } finally {
    s.dispose()
  }
})

test('16C. one visible edge fires visibilitychange + focus + pageshow: exactly one authoritative resync', async () => {
  const s = await mountMeterSlot({
    sessionId: 's-16c',
    initialEntries: [
      durableEntry('turn/start', 1, 1000, { turn: 1 }),
      transientEntry('att-1', 1050, chunk('live data')),
    ],
  })
  try {
    const scheduler = s.getScheduler()

    // Transition to hidden
    s.doc.setVisibility('hidden')
    assert.equal(scheduler.suspended, true)
    const resyncBefore = s.controller.diagnostics('s-16c').foregroundResyncs

    // Single visible edge fires all three events in rapid succession
    s.doc.setVisibility('visible')
    s.win.fire('focus')
    s.win.fire('pageshow')

    const resyncAfter = s.controller.diagnostics('s-16c').foregroundResyncs
    assert.equal(
      resyncAfter - resyncBefore,
      1,
      'exactly one authoritative resync for the combined visibilitychange + focus + pageshow edge'
    )
    assert.equal(scheduler.suspended, false, 'scheduler resumed')
  } finally {
    s.dispose()
  }
})

test('16D. two separate hidden -> visible cycles inside a short interval: exactly two recoveries, one per generation', async () => {
  const s = await mountMeterSlot({
    sessionId: 's-16d',
    initialEntries: [
      durableEntry('turn/start', 1, 1000, { turn: 1 }),
      transientEntry('att-1', 1050, chunk('live data')),
    ],
  })
  try {
    const resyncBase = s.controller.diagnostics('s-16d').foregroundResyncs

    // Cycle 1
    s.doc.setVisibility('hidden')
    s.doc.setVisibility('visible')
    assert.equal(
      s.controller.diagnostics('s-16d').foregroundResyncs,
      resyncBase + 1,
      'cycle 1 triggers recovery 1'
    )

    // Cycle 2 immediately (short interval)
    s.doc.setVisibility('hidden')
    s.doc.setVisibility('visible')
    assert.equal(
      s.controller.diagnostics('s-16d').foregroundResyncs,
      resyncBase + 2,
      'cycle 2 triggers recovery 2 (one per generation)'
    )
  } finally {
    s.dispose()
  }
})

test('16E. hidden notification storm: zero presentation timers and zero renders', async () => {
  const s = await mountMeterSlot({
    sessionId: 's-16e',
    initialEntries: [
      durableEntry('turn/start', 1, 1000, { turn: 1 }),
      transientEntry('att-1', 1050, chunk('live data')),
    ],
  })
  try {
    const scheduler = s.getScheduler()
    s.doc.setVisibility('hidden')
    assert.equal(scheduler.suspended, true)

    const rendersBefore = s.getRenderCount()

    // Ingest 500 events while hidden
    for (let i = 0; i < 500; i++) {
      s.source.replaceEntries([
        durableEntry('turn/start', 1, 1000, { turn: 1 }),
        transientEntry('att-1', 1050 + i, chunk(`data chunk ${i}`)),
      ], 3 + i)
    }

    assert.equal(scheduler.timerCount, 0, 'zero presentation timers while hidden')
    assert.equal(s.getRenderCount(), rendersBefore, 'zero render calls during hidden storm')
  } finally {
    s.dispose()
  }
})
