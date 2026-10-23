/**
 * Phase 12.0 — session navigation / generation-replacement harness.
 *
 * The browser bug this harness exists to reproduce deterministically is a
 * **client session scope generation replacement**, not an ordinary event-window
 * mutation:
 *
 *   navigate A -> B
 *     DSH's `UiWorkspaceService.replaceMain` retains B with source `mainView`
 *     and then releases A's reference. A's last reference reaching zero calls
 *     `retireScope(A)`, which deletes the binding and disposes A's Session
 *     object (and with it A's `MutableSessionEventSource`).
 *
 *   navigate back to A
 *     `retain(A)` re-materializes the scope, which constructs a **new** Session
 *     and therefore a **new** `MutableSessionEventSource` whose revision starts
 *     again at 0. The previous source object still exists in the page, still
 *     has the plugin's listener registered, and is never mutated again.
 *
 * The fakes below model exactly that surface:
 *
 *   - `binding(id)` returns `{ eventSource }` only while a scope is materialized;
 *   - `retainInfo(id)` is the public `ObservableSnapshot<SessionRetainInfo>` the
 *     DSH client service exposes, and it notifies on retain/release;
 *   - `materialize` / `retire` are the test driver for the real UI navigation
 *     steps (they are not plugin APIs);
 *   - a fake source can mutate its window **without** notifying subscribers,
 *     which models a window update this client genuinely did not observe.
 *
 * Every builder here produces entries in the exact shapes the existing live
 * tests use (`durableEntry` / `transientEntry` from `./live-replay.js`), so the
 * controller, feed, store and presenter run their real code paths.
 */

import { createController } from '../../src/client/live/controller.js'
import { durableEntry, transientEntry } from './live-replay.js'

/** The projection the slot renders for "no session / no view". */
export const HIDDEN_VIEW = Object.freeze({ kind: 'hidden', state: 'inactive', turn: null })

const EMPTY_RETAIN = Object.freeze({ referenceCount: 0, retainedBy: Object.freeze({}) })

/**
 * A `SessionEventSource` stand-in with the verified surface plus two explicit
 * window-mutation modes:
 *
 *   - `replace` / `append` publish synchronously to subscribers (the real
 *     `MutableSessionEventSource` behaviour);
 *   - `replaceUnobserved` / `appendUnobserved` move the authoritative window
 *     forward without invoking subscribers — the deterministic model of a
 *     client that did not observe an update (used to prove that an
 *     authoritative resync, not a lucky live callback, is what recovers).
 */
export function createFakeSource(sessionId = '') {
  let window = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  const listeners = new Set()

  const publish = next => {
    window = next
    for (const listener of [...listeners]) listener()
  }

  return {
    sessionId,
    getSnapshot: () => window,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    listenerCount: () => listeners.size,
    revision: () => window.revision,
    replace(entries, revision) {
      publish({
        entries: [...entries],
        hasMore: false,
        revision,
        change: { kind: 'replace', entries: [...entries] },
      })
    },
    append(entry, revision) {
      publish({
        entries: [...window.entries, entry],
        hasMore: window.hasMore,
        revision,
        change: { kind: 'append', entries: [entry] },
      })
    },
    replaceUnobserved(entries, revision) {
      window = {
        entries: [...entries],
        hasMore: false,
        revision,
        change: { kind: 'replace', entries: [...entries] },
      }
    },
    appendUnobserved(entry, revision) {
      window = {
        entries: [...window.entries, entry],
        hasMore: window.hasMore,
        revision,
        change: { kind: 'append', entries: [entry] },
      }
    },
    /** Replace the window and notify subscribers with an explicit replay of it. */
    replay(entries, revision) {
      publish({
        entries: [...entries],
        hasMore: false,
        revision,
        change: { kind: 'replace', entries: [...entries] },
      })
    },
    dispose() {
      listeners.clear()
      window = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
    },
  }
}

/**
 * Fake `ctx.sessions` that owns scope materialization.
 *
 * `retainInfo` deliberately mirrors the real snapshot semantics: it returns the
 * frozen `{ referenceCount, retainedBy }` value, its `subscribe` only adds a
 * listener (it never retains anything), and a notification is published only
 * when the snapshot identity actually changes.
 */
export function createNavigationSessions({ withRetainInfo = true } = {}) {
  /** @type {Map<string, {source: object, retain: object}>} */
  const scopes = new Map()
  /** @type {Map<string, {listeners: Set<() => void>, published: object}>} */
  const observers = new Map()

  const observerFor = id => {
    let observer = observers.get(id)
    if (observer === undefined) {
      observer = { listeners: new Set(), published: undefined }
      observers.set(id, observer)
    }
    return observer
  }

  const retentionSnapshot = id => scopes.get(id)?.retain ?? EMPTY_RETAIN

  const notify = id => {
    const observer = observers.get(id)
    if (observer === undefined) return
    const snapshot = retentionSnapshot(id)
    if (observer.published === snapshot) return
    observer.published = snapshot
    for (const listener of [...observer.listeners]) listener()
  }

  const retained = (retainedBy = { mainView: 1 }) => Object.freeze({
    referenceCount: 1,
    retainedBy: Object.freeze({ ...retainedBy }),
  })

  const sessions = {
    binding(id) {
      const record = scopes.get(id)
      if (record === undefined) return undefined
      return { sessionId: id, eventSource: record.source }
    },
    /**
     * Test driver only: the UI retain → scope materialization step. A fresh
     * generation is installed, so the eventSource object identity changes even
     * when the previous generation's revision was higher.
     */
    materialize(id, source = createFakeSource(id), retainedBy) {
      scopes.set(id, { source, retain: retained(retainedBy) })
      notify(id)
      return source
    },
    /** Test driver only: the last reference is released → DSH retires the scope. */
    retire(id) {
      if (!scopes.delete(id)) return false
      notify(id)
      return true
    },
    /**
     * Test driver only: replace the generation while retaining the session.
     * (DSH itself only replaces a generation through retire → materialize, but
     * the controller must compare identity rather than assume that ordering.)
     */
    replaceGeneration(id, source = createFakeSource(id), retainedBy) {
      scopes.set(id, { source, retain: retained(retainedBy) })
      notify(id)
      return source
    },
    /** Test driver only: change the publication without touching the source. */
    setRetention(id, retention) {
      const record = scopes.get(id)
      if (record === undefined) return
      record.retain = Object.freeze({
        referenceCount: retention.referenceCount,
        retainedBy: Object.freeze({ ...(retention.retainedBy ?? {}) }),
      })
      notify(id)
    },
    listenerCount(id) {
      return scopes.get(id)?.source.listenerCount() ?? 0
    },
    retainListenerCount(id) {
      return observers.get(id)?.listeners.size ?? 0
    },
    isMaterialized(id) {
      return scopes.has(id)
    },
    sourceOf(id) {
      return scopes.get(id)?.source
    },
    retainSnapshot: id => retentionSnapshot(id),
  }

  if (withRetainInfo) {
    sessions.retainInfo = id => {
      const observer = observerFor(id)
      observer.published = retentionSnapshot(id)
      return {
        getSnapshot: () => retentionSnapshot(id),
        subscribe(listener) {
          observer.listeners.add(listener)
          return () => { observer.listeners.delete(listener) }
        },
      }
    }
  }

  return sessions
}

/** A controller over the navigation-aware fake sessions. */
export function createNavigationController(options = {}) {
  const sessions = createNavigationSessions(options)
  const controller = createController({ sessions })
  return { sessions, controller }
}

/* ------------------------------------------------------------------ *
 * Window builders
 *
 * These are the same entry shapes the existing live tests drive through the
 * real SessionEventFeed; the projection assertions in the Phase 12.0 matrix
 * are therefore about routing/generation, never about synthetic metric values.
 * ------------------------------------------------------------------ */

export const outputChunk = (attemptId, timeMs, text, { turn = 1, step = 1 } = {}) => (
  transientEntry(attemptId, timeMs, { type: 'text-delta', index: 0, text }, { turn, step })
)

export const reasoningDelta = (attemptId, timeMs, text, { turn = 1, step = 1 } = {}) => (
  transientEntry(attemptId, timeMs, { type: 'reasoning-delta', index: 0, text }, { turn, step })
)

export const turnStart = ({ turn = 1, seq = 1, time = 1000 } = {}) => (
  durableEntry('turn/start', seq, time, { turn })
)

export const stepStart = ({ turn = 1, step = 1, seq = 2, time = 1010 } = {}) => (
  durableEntry('step/start', seq, time, { turn, step })
)

export const toolCall = ({ turn = 1, step = 1, seq = 3, time = 1100, callId = 'call-1', name = 'pwsh' } = {}) => (
  durableEntry('tool/call', seq, time, { turn, step, callId, name, arguments: '{}' })
)

export const toolResult = ({ turn = 1, step = 1, seq = 4, time = 1200, callId = 'call-1' } = {}) => (
  durableEntry('tool/result', seq, time, {
    turn,
    step,
    // The 0.2.x contract reads the call identity from the tool-role message.
    message: {
      id: `result-${seq}`,
      role: 'tool',
      toolCallId: callId,
      source: { kind: 'tool' },
      content: [{ type: 'text', text: 'ok' }],
    },
  })
)

export const turnEnd = ({ turn = 1, seq = 50, time = 5000, reason = 'completed' } = {}) => (
  durableEntry('turn/end', seq, time, { turn, reason: { kind: reason } })
)

/**
 * Entry stream for one turn whose currently displayed phase is `phase`.
 *
 * The streams are cumulative, exactly like a real session window: each phase
 * window contains every earlier row of the same turn, so a rebaseline over the
 * current window can rebuild the same live state from scratch.
 */
export function turnWindow(phase, { turn = 1 } = {}) {
  const start = [turnStart({ turn }), stepStart({ turn })]
  switch (phase) {
    case 'waiting-model': {
      const stream = [outputChunk('att-1', 1050, 'thinking about it', { turn })]
      return [
        ...start,
        ...stream,
        toolCall({ turn }),
        toolResult({ turn }),
        // The next step boundary after the tool is what the UI calls waiting-model.
        stepStart({ turn, step: 2, seq: 6, time: 1250 }),
      ]
    }
    case 'tool': {
      const stream = [outputChunk('att-1', 1050, 'thinking about it', { turn })]
      return [...start, ...stream, toolCall({ turn })]
    }
    case 'streaming-after-waiting': {
      return [
        ...turnWindow('waiting-model', { turn }),
        outputChunk('att-2', 1300, 'resumed ', { turn, step: 2 }),
        outputChunk('att-2', 1310, 'model ', { turn, step: 2 }),
        outputChunk('att-2', 1320, 'output', { turn, step: 2 }),
      ]
    }
    case 'streaming': {
      const stream = [
        outputChunk('att-1', 1060, 'after tool ', { turn }),
        outputChunk('att-1', 1070, 'second ', { turn }),
        outputChunk('att-1', 1080, 'third', { turn }),
      ]
      return [...start, ...stream]
    }
    case 'completed': {
      const stream = [
        outputChunk('att-1', 1060, 'final ', { turn }),
        outputChunk('att-1', 1070, 'answer ', { turn }),
        outputChunk('att-1', 1080, 'text', { turn }),
      ]
      return [...start, ...stream, turnEnd({ turn })]
    }
    default:
      throw new Error(`unknown phase ${phase}`)
  }
}

/**
 * A fresh event-source generation whose authoritative window shows `phase`.
 *
 * `revision` is deliberately chosen by the caller so the matrix can express
 * "new generation, same revision number" (T08) and "new generation, revision
 * fell back to zero" (T09).
 */
export function nextGeneration(phase, options = {}) {
  const { revision = 7, turn = 1, entries } = options
  const source = createFakeSource(options.sessionId ?? '')
  source.replace(entries ?? turnWindow(phase, { turn }), revision)
  return source
}

/** Compact view key used in assertions. */
export function viewKey(view) {
  return view.kind === 'hidden' ? `hidden(${view.state})` : view.state
}
