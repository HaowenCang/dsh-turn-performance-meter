/**
 * Client presentation controller: the runtime wire between the DSH event
 * window, the telemetry store and the per-session live UI machines.
 *
 * Data flow (frozen architecture):
 *
 *   ctx.sessions.binding(id).eventSource   (SessionEventWindow, both planes)
 *       -> SessionEventFeed                (src/dsh: window wire -> normalized)
 *       -> TurnTelemetryStore + LivePresenter (per session, keyed state)
 *       -> React LiveMeter                 (throttled presentation only)
 *
 * Invariants this class exists to keep:
 *
 *   1. **Session/turn isolation.** One presenter (and therefore one UI state
 *      machine) per session; the store is keyed by `(sessionId, turn)`. There
 *      is no global "current turn" anywhere.
 *   2. **One subscription per session.** `attach` is idempotent; switching
 *      sessions back and forth can never double-subscribe an eventSource.
 *   3. **No statistics here.** The controller routes events; TPS, TTFT, tool
 *      wall time and elapsed come from `LiveMeter` snapshots.
 *   4. **Bounded lifecycle.** `dispose()` unsubscribes every eventSource and
 *      disposes the store — the HMR path.
 */

import { TurnTelemetryStore } from '../../host/telemetry-design.js'
import { turnKey } from '../../core/types.js'
import { NORMALIZED_KIND, applyRetryOutcomes } from '../../dsh/index.js'
import { SessionEventFeed } from '../../dsh/client-feed.js'
import { LivePresenter } from './live-presenter.js'

/** Presentation refresh cadence: 200 ms == at most ~5 rendered updates/s. */
export const DEFAULT_REFRESH_MS = 200

/**
 * @param {{
 *   sessions?: {binding?: (id: string) => {eventSource: object}|undefined},
 *   refreshMs?: number,
 *   debug?: boolean,
 *   nowMs?: () => number,
 * }} [options]
 */
export function createController({
  sessions,
  refreshMs = DEFAULT_REFRESH_MS,
  debug = false,
  nowMs = () => Date.now(),
} = {}) {
  const store = new TurnTelemetryStore()
  /** @type {Map<string, object>} sessionId -> session state */
  const sessionsMap = new Map()
  const listeners = new Set()
  let disposed = false

  const log = debug
    ? (...args) => { try { console.debug('[dsh-turn-performance-meter]', ...args) } catch { /* never break telemetry for a log */ } }
    : () => {}

  function emit() {
    if (disposed) return
    for (const listener of [...listeners]) {
      try { listener() } catch { /* a broken listener must not stop ingestion */ }
    }
  }

  /** Resolve the turn record an event belongs to; `null` when none exists. */
  function lookupRecord(state, turn) {
    if (Number.isFinite(turn)) return store.turns.get(turnKey(state.sessionId, turn)) ?? null
    return state.currentRecord
  }

  function applyEvent(state, event) {
    const sessionId = state.sessionId
    switch (event.kind) {
      case 'window-rebaseline': {
        // A `replace` swapped the window (reload/reconnect). Local live state
        // belongs to the superseded window; replay begins from a clean machine
        // rather than fabricating continuity.
        log('stream gap/rebaseline', sessionId)
        state.presenter.apply({ type: 'reset' })
        state.currentRecord = null
        state.openAttemptId = null
        return
      }

      case NORMALIZED_KIND.TURN_START: {
        state.currentRecord = store.beginTurn({ sessionId, turn: event.turn, timeMs: event.timeMs })
        state.presenter.apply({ type: 'turn-start', turn: event.turn, timeMs: event.timeMs })
        log('turn open', sessionId, event.turn)
        return
      }

      case NORMALIZED_KIND.STEP_START: {
        state.presenter.apply({ type: 'step-start', turn: event.turn, step: event.step, timeMs: event.timeMs })
        return
      }

      case NORMALIZED_KIND.STEP_END:
        return

      case NORMALIZED_KIND.ATTEMPT_START: {
        const record = lookupRecord(state, event.turn)
        if (record !== null) {
          store.beginAttempt(record, { attemptId: event.attemptId, step: event.step, startedAtMs: event.timeMs })
        }
        state.openAttemptId = event.attemptId
        state.presenter.apply({
          type: 'attempt-start',
          attemptId: event.attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('attempt start', sessionId, event.attemptId)
        return
      }

      case NORMALIZED_KIND.ATTEMPT_DELTA: {
        const record = lookupRecord(state, event.turn)
        if (record === null) {
          // No turn boundary has been observed (a window that no longer
          // contains this turn's `turn/start`). Fabricating a start time would
          // corrupt TTFT, so the delta is reported and dropped instead.
          state.droppedDeltas = (state.droppedDeltas ?? 0) + 1
          return
        }
        let attempt = record.attemptIndex.get(event.attemptId)
        if (attempt === undefined) {
          // The feed always emits `attempt-start` before an attempt's first
          // delta; this is the defensive path for a mid-turn attach.
          attempt = store.beginAttempt(record, {
            attemptId: event.attemptId,
            step: event.step ?? null,
            startedAtMs: event.timeMs,
          })
        }
        const sample = store.acceptChunk(record, attempt, { timeMs: event.timeMs, chunk: event.chunk })
        if (sample === null) return
        // Only model-producing deltas drive the state machine; the machine's
        // first accepted delta is what freezes the turn TTFT stage.
        state.presenter.apply({
          type: 'delta',
          attemptId: event.attemptId,
          turn: record.turn,
          phase: sample.phase,
          timeMs: sample.timeMs,
        })
        return
      }

      case NORMALIZED_KIND.ATTEMPT_SETTLE: {
        const record = lookupRecord(state, event.turn)
        const attemptId = event.attemptId ?? state.openAttemptId
        if (record !== null && attemptId !== null && attemptId !== undefined) {
          const attempt = record.attemptIndex.get(attemptId)
          if (attempt !== undefined) {
            store.settleAttempt(attempt, {
              settledAtMs: event.timeMs,
              settlementKind: event.settlementKind,
              surfaceCommitted: event.surfaceCommitted,
              attemptOutcome: event.attemptOutcome,
              usage: event.usage ?? null,
              usageSource: event.usageSource ?? null,
              settlementSeq: event.seq,
            })
          }
        }
        if (state.openAttemptId === attemptId) state.openAttemptId = null
        state.presenter.apply({
          type: 'attempt-settle',
          attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('attempt settle', sessionId, attemptId, event.settlementKind, event.attemptOutcome)
        return
      }

      case NORMALIZED_KIND.ATTEMPT_ABANDON: {
        const record = lookupRecord(state, event.turn)
        const attemptId = event.attemptId ?? state.openAttemptId
        if (record !== null && attemptId !== null && attemptId !== undefined) {
          const attempt = record.attemptIndex.get(attemptId)
          if (attempt !== undefined) {
            store.settleAttempt(attempt, {
              settledAtMs: event.timeMs ?? null,
              settlementKind: event.settlementKind ?? 'none',
              surfaceCommitted: false,
              attemptOutcome: event.attemptOutcome ?? 'abandoned',
            })
          }
        }
        if (state.openAttemptId === attemptId) state.openAttemptId = null
        state.presenter.apply({
          type: 'attempt-abandon',
          attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs ?? null,
        })
        log('attempt abandoned', sessionId, attemptId)
        return
      }

      case NORMALIZED_KIND.RETRY_SCHEDULED: {
        const record = lookupRecord(state, event.turn)
        if (record !== null) applyRetryOutcomes(record.attempts, [event])
        state.presenter.apply({
          type: 'retry',
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('retry scheduled', sessionId, event.turn, event.step)
        return
      }

      case NORMALIZED_KIND.TOOL_CALL: {
        const record = lookupRecord(state, event.turn)
        if (record === null) return
        store.toolStarted(record, { callId: event.callId, name: event.name, timeMs: event.timeMs })
        state.presenter.apply({ type: 'tool-start', turn: record.turn, timeMs: event.timeMs, name: event.name })
        log('tool start', sessionId, event.name)
        return
      }

      case NORMALIZED_KIND.TOOL_RESULT: {
        const record = lookupRecord(state, event.turn)
        if (record === null) return
        const call = store.toolSettled(record, {
          callId: event.callId,
          timeMs: event.timeMs,
          status: event.status,
        })
        if (call === null) {
          state.unmatchedToolResults = (state.unmatchedToolResults ?? 0) + 1
          return
        }
        state.presenter.apply({ type: 'tool-end', turn: record.turn, timeMs: event.timeMs })
        log('tool end', sessionId, call.name, event.status)
        return
      }

      case NORMALIZED_KIND.TURN_END: {
        const record = lookupRecord(state, event.turn)
        if (record === null) return
        const settled = store.endTurn(record, { timeMs: event.timeMs, status: event.status, statusNote: event.note })
        state.currentRecord = null
        state.openAttemptId = null
        state.presenter.apply({ type: 'turn-end', turn: event.turn, timeMs: event.timeMs, status: event.status })
        log('turn close', sessionId, event.turn, event.status)
        if (Array.isArray(settled?.consistencyIssues) && settled.consistencyIssues.length > 0) {
          log('quality downgrade', ...settled.consistencyIssues)
        }
        return
      }

      case NORMALIZED_KIND.IGNORED:
        state.ignoredEvents = (state.ignoredEvents ?? 0) + 1
        return

      default:
        state.unknownEvents = (state.unknownEvents ?? 0) + 1
    }
  }

  return {
    refreshMs,
    store,

    /**
     * Subscribe one session's eventSource exactly once. Returns `true` when a
     * subscription now exists for this session (fresh or already attached).
     */
    attach(sessionId) {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') return false
      if (sessionsMap.has(sessionId)) return true
      const binding = typeof sessions?.binding === 'function' ? sessions.binding(sessionId) : undefined
      if (binding === undefined || binding === null || binding.eventSource === undefined || binding.eventSource === null) {
        log('binding unavailable', sessionId)
        return false
      }
      const source = binding.eventSource
      const state = {
        sessionId,
        presenter: new LivePresenter(),
        feed: null,
        unsub: null,
        currentRecord: null,
        openAttemptId: null,
        ignoredEvents: 0,
        droppedDeltas: 0,
        unmatchedToolResults: 0,
        unknownEvents: 0,
      }
      state.feed = new SessionEventFeed({
        sessionId,
        onEvent: event => {
          applyEvent(state, event)
          // Every handled event invalidates presentation. The listener is the
          // scheduler's coalescing notify, so this stays cheap even at one
          // call per streamed delta (no render happens here — the scheduler
          // throttles, and the visible ticker already covers updates).
          emit()
        },
        onIssue: issue => {
          state.feedIssues = state.feedIssues ?? []
          if (state.feedIssues.length < 100) state.feedIssues.push(issue)
          log('feed issue', sessionId, issue.kind, issue.detail)
        },
      })
      const read = () => {
        try {
          state.feed.applyWindow(source.getSnapshot())
        } catch (error) {
          log('event window read failed', sessionId, error)
        }
      }
      // Subscribe first, then the initial full pass: a mutation racing the
      // attach is delivered by the subscription and the revision guard makes
      // the overlapping read idempotent.
      state.unsub = source.subscribe(read)
      read()
      sessionsMap.set(sessionId, state)
      log('session attach', sessionId)
      return true
    },

    /** Detach presentation interest; the subscription itself stays (see docs). */
    detach(sessionId) {
      log('session detach', sessionId)
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** The current presentation model for one session (hidden when unknown). */
    project(sessionId, atMs = nowMs()) {
      if (disposed || typeof sessionId !== 'string' || !sessionsMap.has(sessionId)) {
        return { kind: 'hidden', state: 'inactive', turn: null }
      }
      const snapshot = store.liveSnapshot(sessionId, atMs)
      return sessionsMap.get(sessionId).presenter.project(snapshot, atMs)
    },

    /** Diagnostics for tests and debug tooling. */
    diagnostics(sessionId) {
      const state = sessionsMap.get(sessionId)
      if (state === undefined) return null
      return {
        feedIssues: state.feedIssues ?? [],
        ignoredEvents: state.ignoredEvents ?? 0,
        droppedDeltas: state.droppedDeltas ?? 0,
        unmatchedToolResults: state.unmatchedToolResults ?? 0,
        unknownEvents: state.unknownEvents ?? 0,
      }
    },

    /** Attached session ids, for lifecycle assertions. */
    attachedSessions() {
      return [...sessionsMap.keys()]
    },

    /** Tear down every subscription and all stored state (HMR / unload). */
    dispose() {
      if (disposed) return
      disposed = true
      for (const state of sessionsMap.values()) {
        try { state.unsub?.() } catch { /* best effort */ }
      }
      sessionsMap.clear()
      listeners.clear()
      store.dispose()
      log('controller disposed')
    },
  }
}
