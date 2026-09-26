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
import { NORMALIZED_KIND, applyRetryOutcomes, attemptFromDecoded } from '../../dsh/index.js'
import { SessionEventFeed } from '../../dsh/client-feed.js'
import { LivePresenter } from './live-presenter.js'
import { DEFAULT_PRESENTATION_REFRESH_MS } from './cadence.js'

/**
 * Identity of a projected view: equal keys mean the picture is unchanged.
 *
 * The point of the key is the completed card. A settled turn's projection depends
 * on nothing that ticks, so its key is constant and the card is built exactly once
 * per settled turn even though events keep arriving. Every live field that can
 * change the rendering is enumerated, and anything not enumerated (per-delta
 * counters, sample arrays) deliberately cannot change a live value on its own —
 * the live view is a one-second window plus a wall clock, both of which are in
 * the key.
 */
function projectionKey(state, snapshot, atMs) {
  const machine = state.presenter.machine
  const phase = snapshot?.phase ?? 'none'
  if (machine.state === 'settled') return `settled:${machine.turn ?? ''}`
  const clock = Number.isFinite(atMs) ? atMs : 0
  /**
   * `turnElapsedMs` is in the key because every live view prints a running
   * elapsed value; a settled view prints none, which is why its key omits the
   * clock entirely and stays stable while deltas keep arriving.
   */
  return [
    machine.state,
    machine.turn ?? '',
    phase,
    Number.isFinite(snapshot?.turnElapsedMs) ? snapshot.turnElapsedMs : '',
    phase === 'streaming' ? Math.round(snapshot.tps ?? 0) : '',
    phase === 'tool' ? snapshot.runningToolCount ?? 0 : '',
    phase === 'tool' ? Math.round(snapshot.toolElapsedMs ?? 0) : '',
    machine.sinceMs ?? '',
    clock,
  ].join('|')
}

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
  refreshMs = DEFAULT_PRESENTATION_REFRESH_MS,
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

  /** Drop whatever the last projection cached, including its settled-turn read. */
  function invalidate(state) {
    state.viewCache = undefined
    state.settledRead = undefined
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
        invalidate(state)
        return
      }

      case NORMALIZED_KIND.TURN_START: {
        /**
         * `recovered` marks a boundary the feed *derived* from transient
         * evidence (mid-turn attach) rather than observed as a durable event.
         * The record is opened with an unknown start time (`timeMs: null`), so
         * TTFT and turn elapsed stay unknown instead of being measured from the
         * reload.
         */
        const recovered = event.recovered === true
        state.currentRecord = store.beginTurn({
          sessionId,
          turn: event.turn,
          timeMs: recovered ? null : event.timeMs,
        })
        /**
         * The durable `turn/start` can arrive **after** the turn was adopted: the
         * window is a live tail, so a reconnect (or the tail sliding back over
         * the row) publishes it mid-turn. It is then an upgrade of an unknown
         * start to the observed one, never a restart of the metrics — the
         * attempt boundaries, deltas and first-token stamp already collected for
         * this turn are kept. The inverse is impossible by construction: only a
         * `recovered` event carries `timeMs: null`, and such an event is emitted
         * exactly once per turn, when the turn is first adopted.
         */
        store.turnStartObserved(state.currentRecord, { timeMs: event.timeMs })
        state.presenter.apply({ type: 'turn-start', turn: event.turn, timeMs: event.timeMs, recovered })
        /** A new turn supersedes the previous card in this same advance. */
        state.settledRead = undefined
        log(recovered ? 'turn adopted (mid-turn attach)' : 'turn open', sessionId, event.turn)
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
        let attemptId = event.attemptId ?? state.openAttemptId
        /**
         * A durable settlement arriving as a plain event carries no `attemptId`,
         * so it is correlated to the one attempt of its `(turn, step)` that has
         * not settled yet. The correlation demands a *unique* candidate: if two
         * unsettled attempts share the step, the settlement belongs to neither
         * provably, and the durable record is restored as its own attempt instead
         * of being attached to a guess.
         */
        if ((attemptId === null || attemptId === undefined) && record !== null && Number.isFinite(event.step)) {
          const open = record.attempts.filter(candidate => (
            candidate.settlementKind === 'none' && candidate.step === event.step
          ))
          if (open.length === 1) attemptId = open[0].attemptId
        }
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
        } else if (record !== null && event.decoded !== undefined) {
          /**
           * Durable-only settlement: the window carries the settlement (and its
           * embedded compact stream), but the attempt's transient rows are gone —
           * the reload case. The durable record is the complete evidence for that
           * attempt, so it is restored from the decode rather than dropped: a
           * refresh must be able to show the last completed turn without ever
           * having observed it live. Nothing is invented here — the attempt's
           * samples, usage and settlement metadata all come from the durable row.
           */
          const restored = attemptFromDecoded({
            attemptId: `durable:${event.seq ?? record.attempts.length}`,
            turn: record.turn,
            step: event.step ?? null,
            decoded: event.decoded,
            usage: event.usage ?? null,
            usageSource: event.usageSource ?? null,
            settlementKind: event.settlementKind,
            surfaceCommitted: event.surfaceCommitted,
            attemptOutcome: event.attemptOutcome,
            settledAtMs: event.timeMs,
            settlementSeq: event.seq,
            settlementEventType: event.eventType ?? null,
            interrupted: event.interrupted === true,
            issues: event.issues ?? [],
          })
          record.attempts.push(restored)
          record.attemptIndex.set(restored.attemptId, restored)
          /**
           * The turn TTFT is `turn/start -> first non-empty model-producing
           * delta`, and a restored attempt brings that delta with it. Taking the
           * earliest sample timestamp here is what lets a card rebuilt after a
           * reload report the same TTFT the live session froze, instead of `—`.
           */
          for (const sample of restored.samples) {
            if (!Number.isFinite(sample.timeMs)) continue
            record.firstTokenMs = record.firstTokenMs === null
              ? sample.timeMs
              : Math.min(record.firstTokenMs, sample.timeMs)
          }
          state.durableAttempts = (state.durableAttempts ?? 0) + 1
          log('durable attempt restored', sessionId, restored.attemptId, restored.samples.length)
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
        /**
         * The settled turn is now readable. Both the settled snapshot and the
         * settled machine are in place before the projection is invalidated, so
         * the very next `project()` returns the completed card — never `null`
         * followed by a card one tick later.
         */
        invalidate(state)
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

    /**
     * The current presentation model for one session.
     *
     * Precedence, frozen in Phase 4: an open turn wins over a settled one. The
     * completed card and the live meter are never both available, so the switch
     * is a single state advance:
     *
     *   - a settled machine projects the latest settled turn (the card);
     *   - a `turn/end` therefore replaces the pill with the card in the same
     *     publish — there is no intermediate "nothing" frame;
     *   - a following `turn/start` replaces the card with the pill in the same
     *     publish — the old card never lingers beside a new turn.
     *
     * The result is memoized per `(session, projection identity)`: while nothing
     * that can change the picture has changed, the same object is returned, so a
     * static card cannot be rebuilt once per ingested delta. The identity of a
     * completed card is its turn, which is exactly the rule "one card per settled
     * turn".
     */
    project(sessionId, atMs = nowMs()) {
      const state = sessionsMap.get(sessionId)
      if (disposed || typeof sessionId !== 'string' || state === undefined) {
        return { kind: 'hidden', state: 'inactive', turn: null }
      }
      /**
       * The settled turn is read as evidence, once per session state object, in
       * the same synchronous step that reads the meter — which is what makes the
       * live/completed handover atomic rather than a two-tick sequence.
       */
      if (state.settledRead === undefined) state.settledRead = store.latestSettled(sessionId)
      const snapshot = store.liveSnapshot(sessionId, atMs)
      const key = projectionKey(state, snapshot, atMs)
      const cached = state.viewCache
      if (cached !== undefined && cached.key === key && cached.sessionId === sessionId) return cached.view

      const view = state.presenter.project(snapshot, atMs, state.settledRead)
      state.viewCache = { key, sessionId, view }
      return view
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
