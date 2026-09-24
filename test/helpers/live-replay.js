/**
 * Replay helpers for the Phase 3 live-path tests.
 *
 * `fakeSessionsService` reproduces the verified `ctx.sessions.binding(id)`
 * + `SessionEventSource` contract (`getSnapshot` / `subscribe` returning an
 * unsubscribe, synchronous publication, `change` payloads) so the controller
 * and feed run against the same window semantics as the browser, with no DSH
 * process. The window mutation helpers implement the four `SessionEventChange`
 * kinds exactly as `MutableSessionEventSource` publishes them.
 *
 * `fixtureEntries` interleaves a recording's durable rows and transient
 * `assistant/live-chunk` rows into one chronological entry stream — the shape
 * the client fold actually publishes — by stable-sorting on the shared wall
 * clock the recorder captured both planes with.
 */

import assert from 'node:assert/strict'
import { createController } from '../../src/client/live/controller.js'
import { createPresentationScheduler } from '../../src/client/live/refresh.js'
import { sampleFromChunk } from '../../src/core/token-allocation.js'

/** A `SessionEventSource` stand-in with the verified surface. */
export function fakeSessionsService() {
  const sources = new Map()
  return {
    binding(id) {
      const source = sources.get(id)
      return source === undefined ? undefined : { eventSource: source }
    },
    createSource(sessionId) {
      let window = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
      const listeners = new Set()
      const source = {
        getSnapshot: () => window,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        listenerCount: () => listeners.size,
        publish(change, revision) {
          window = { entries: window.entries, hasMore: false, revision, change }
          for (const listener of [...listeners]) listener()
        },
        /** `append`: one live tail entry (SessionEventChange{kind:'append'}). */
        appendEntry(entry, revision) {
          window = {
            entries: [...window.entries, entry],
            hasMore: window.hasMore,
            revision,
            change: { kind: 'append', entries: [entry] },
          }
          for (const listener of [...listeners]) listener()
        },
        /** `replace`: the complete window was swapped (reload/rebaseline). */
        replaceEntries(entries, revision) {
          window = { entries: [...entries], hasMore: false, revision, change: { kind: 'replace', entries: [...entries] } }
          for (const listener of [...listeners]) listener()
        },
        /** `prepend`: an older page (must be ignored by the feed). */
        prependEntries(entries, revision) {
          window = {
            entries: [...entries, ...window.entries],
            hasMore: true,
            revision,
            change: { kind: 'prepend', entries: [...entries] },
          }
          for (const listener of [...listeners]) listener()
        },
        /**
         * `settle-assistant`: the fold atomically supersedes one attempt's
         * transient rows with its durable settlement (or drops them for a bare
         * abandonment when `entry` is undefined).
         */
        settleAssistant(attemptId, entry, revision) {
          const rows = window.entries
          const firstIndex = rows.findIndex(row => row.type === 'transient' && row.event?.data?.attemptId === attemptId)
          const kept = rows.filter(row => !(row.type === 'transient' && row.event?.data?.attemptId === attemptId))
          if (firstIndex >= 0 && entry !== undefined) kept.splice(firstIndex, 0, entry)
          window = {
            entries: kept,
            hasMore: window.hasMore,
            revision,
            change: { kind: 'settle-assistant', attemptId, ...(entry === undefined ? {} : { entry }) },
          }
          for (const listener of [...listeners]) listener()
        },
      }
      sources.set(sessionId, source)
      return source
    },
    listenerCount(sessionId) {
      return sources.get(sessionId)?.listenerCount() ?? 0
    },
  }
}

export function durableEntry(type, seq, time, data) {
  return { type: 'event', event: { type, seq, time, data } }
}

export function transientEntry(attemptId, time, chunk, { turn = 1, step = 1 } = {}) {
  return {
    type: 'transient',
    event: { type: 'assistant/live-chunk', seq: time, time, data: { attemptId, turn, step, chunk } },
  }
}

function entryTime(entry) {
  if (entry?.type === 'event') return Number(entry.event?.time) ? entry.event.time : 0
  if (entry?.type === 'transient') return Number(entry.event?.time) ? entry.event.time : 0
  return 0
}

/** One fixture as the chronological entry stream the browser would publish. */
export function fixtureEntries(fixture) {
  const durable = fixture.durable.map(row => ({ type: 'event', event: row.event }))
  const transient = fixture.transient
    .filter(row => row.frame.type === 'chunk')
    .map(row => ({
      type: 'transient',
      event: {
        type: 'assistant/live-chunk',
        seq: row.frame.index ?? 0,
        time: row.frame.time,
        data: {
          attemptId: row.frame.attemptId,
          turn: null,
          step: null,
          chunk: row.frame.chunk,
        },
      },
    }))
  // Stable sort on the shared recorder clock: durable rows tie-break first,
  // which is the recorded order (step boundaries precede the frames they gate).
  return [...durable, ...transient].sort((a, b) => entryTime(a) - entryTime(b))
}

/**
 * Replay one fixture through a real controller, capturing the presentation
 * state after every published entry — plus the component-equivalent ticker
 * lifecycle (start while visible, stop while hidden), so render/timer
 * accounting mirrors the React layer structurally.
 */
export function replayFixture(fixture, { withScheduler = false } = {}) {
  const entries = fixtureEntries(fixture)
  const sessions = fakeSessionsService()
  const source = sessions.createSource(fixture.sessionId)
  const controller = createController({ sessions })
  const attached = controller.attach(fixture.sessionId)
  assert.equal(attached, true, 'the fake binding must be resolvable')

  const nowMs = entries.length > 0 ? Math.max(...entries.map(entryTime)) : 0
  const captures = []
  let renders = 0
  let maxTimers = 0
  const timers = fakeTimerRegistry()
  const scheduler = withScheduler
    ? createPresentationScheduler({
      intervalMs: 200,
      onRender: () => { renders += 1 },
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    })
    : null
  if (scheduler !== null) controller.subscribe(scheduler.notify)

  const capture = () => {
    const view = controller.project(fixture.sessionId, nowMs)
    captures.push(view)
    if (scheduler !== null) {
      /**
       * The component's ticker lifecycle, structurally: the ticker runs for any
       * visible view except the static completed card, and is stopped for a
       * hidden view and for the card. A settled turn is static — it is rebuilt on
       * the next event and never re-rendered by a clock — so a completed card
       * leaves **zero** timers behind, exactly as a hidden view does.
       */
      const staticView = view.kind === 'hidden' || view.kind === 'completed'
      if (staticView) scheduler.stop()
      else if (!scheduler.ticking) scheduler.start()
      maxTimers = Math.max(maxTimers, scheduler.timerCount)
    }
    return view
  }

  capture()
  let revision = 1
  let lastIntervalFireMs = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    source.appendEntry(entry, (revision += 1))
    const view = capture()
    if (scheduler !== null) {
      // Structural stand-in for real time: the coalesced leading render fires
      // as soon as the loop yields, and the periodic ticker fires only when
      // the fixture's own clock has advanced by its interval while visible.
      timers.fireTimeouts()
      if (scheduler.ticking && entryTime(entry) - lastIntervalFireMs >= scheduler.intervalMs) {
        timers.fireIntervals(1)
        lastIntervalFireMs = entryTime(entry)
      }
      void view
    }
  }

  return {
    fixture,
    sessions,
    source,
    controller,
    captures,
    nowMs,
    entries,
    scheduler,
    stats: () => ({ renders, maxTimers, timerCount: scheduler?.timerCount ?? 0 }),
    /** Advance the fake presentation ticker by `n` bounded refreshes. */
    tick(n) { timers.fireIntervals(n); timers.fireTimeouts() },
    dispose() { scheduler?.dispose(); controller.dispose() },
  }
}

/** Adjacent-duplicate compression of a state list: one entry per stage run. */
export function compressStates(states) {
  const runs = []
  for (const state of states) {
    if (runs[runs.length - 1] !== state) runs.push(state)
  }
  return states.length === 0 ? [] : runs
}

/** Compact view descriptor used in assertions: `state` or `hidden(state)`. */
export function viewKey(view) {
  return view.kind === 'hidden' ? `hidden(${view.state})` : view.state
}

export function fakeTimerRegistry() {
  let nextId = 1
  const timeouts = new Map()
  const intervals = new Map()
  return {
    setTimeoutImpl: (fn) => { const id = nextId++; timeouts.set(id, fn); return id },
    clearTimeoutImpl: (id) => { timeouts.delete(id) },
    setIntervalImpl: (fn) => { const id = nextId++; intervals.set(id, fn); return id },
    clearIntervalImpl: (id) => { intervals.delete(id) },
    timeoutCount: () => timeouts.size,
    intervalCount: () => intervals.size,
    fireIntervals(times) {
      for (let round = 0; round < times; round += 1) {
        for (const [, fn] of [...intervals]) fn()
      }
    },
    fireTimeouts() {
      for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn() }
    },
  }
}

/** How many of a fixture's transient rows become accepted token samples. */
export function expectedSampleCount(fixture) {
  let count = 0
  for (const row of fixture.transient) {
    if (row.frame.type !== 'chunk') continue
    if (sampleFromChunk(row.frame.time, row.frame.chunk) !== null) count += 1
  }
  return count
}
