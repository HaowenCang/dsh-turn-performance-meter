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
import { tokenEvidence } from '../../core/delta-accounting.js'
import { NORMALIZED_KIND, applyRetryOutcomes, attemptFromDecoded } from '../../dsh/index.js'
import { SessionEventFeed } from '../../dsh/client-feed.js'
import { materializeReconstructedTurn } from '../../dsh/reconstruction.js'
import { LivePresenter } from './live-presenter.js'
import { DEFAULT_PRESENTATION_REFRESH_MS } from './cadence.js'

/**
 * Controller-level diagnostics raised on the completion path.
 *
 * `TURN_END_WITHOUT_RECORD` is the one that matters: §25 requires a lost terminal
 * boundary to be visible, because the alternative — a silent early return — is
 * indistinguishable from a turn that never ended.
 */
export const CONTROLLER_ISSUE = Object.freeze({
  TURN_END_WITHOUT_RECORD: 'turn-end-without-record',
})

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
        //
        // The store is reset **first**, and it is the step that matters. The
        // presenter machine and the two identifiers below are presentation state;
        // the evidence is `store.turns` (attempts, samples, usage, tool intervals)
        // and the per-session `LiveMeter`, and both outlive a presenter reset.
        // Leaving them in place makes the replay land inside attempts the
        // superseded generation already filled — `beginTurn` is idempotent and
        // `beginAttempt` returns the existing attempt — so a replayed delta is
        // appended rather than replacing, and the turn reports one sample per
        // republication of the window.
        //
        // The reset is scoped to this session: a rebaseline of one conversation is
        // not evidence about any other.
        log('stream gap/rebaseline', sessionId)
        store.rebaselineSession(sessionId)
        state.presenter.apply({ type: 'reset' })
        state.currentRecord = null
        state.openAttemptId = null
        state.observedTurnStart = null
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
        /**
         * Only an *observed* boundary is kept: a recovered adoption carries
         * `timeMs: null` and must not become the start a later reconstruction
         * reports as measured.
         */
        if (!recovered && Number.isFinite(event.timeMs)) {
          state.observedTurnStart = { turn: event.turn, timeMs: event.timeMs }
        }
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
        if (sample !== null) {
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
        /**
         * No accepted sample — and that no longer ends the story. A name-bearing
         * `tool-call-delta` whose argument fragment is still empty is accepted by
         * DSH's `isTokenDelta` and rejected by `classifyDelta`, so it produces no
         * TPS-shape sample while remaining the model's **first token**. Returning
         * here is exactly the defect Phase 9.4 removes: the machine stayed in
         * `pending-first-token` and the pill kept rendering the first-response
         * stopwatch after the boundary had passed.
         *
         * The boundary is applied as a delta event so the machine advances to its
         * streaming stage, and nothing else happens: the store has frozen the
         * turn's TTFT, updated the phase identity, and recorded the phase cut it
         * declares, and it has opened **no** magnitude episode — so no episode
         * clock, no numerator and no rate exist for a chunk whose argument text
         * does not exist yet. (Before Phase 9.4.2 this comment claimed the
         * boundary had opened the episode clock. It never should have: a
         * boundary-only delta carries no magnitude, so an origin taken from it
         * would have been a denominator origin the completed curve could not
         * reproduce.)
         */
        const evidence = tokenEvidence(event.chunk)
        if (!evidence.countsAsToken) return
        state.presenter.apply({
          type: 'delta',
          attemptId: event.attemptId,
          turn: record.turn,
          phase: evidence.phase,
          timeMs: event.timeMs,
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
            /**
             * ## The mixed plane: the settlement completes the attempt it settles
             *
             * This is the one path where both planes already hold evidence for the
             * *same* attempt. A reload leaves a transient attempt holding only the
             * tail its window could still see, and the settlement that closes that
             * attempt carries the authoritative complete compact stream. Phase
             * 9.4.3 taught the completed curve to read a non-magnitude phase cut,
             * but only the two *pure* planes routed it: here the correlation
             * succeeded, `settleAttempt` ran, and `event.decoded` was ignored — so
             * a boundary, and every delta before the reload, survived on the live
             * card and vanished from the reloaded one.
             *
             * Correlating and then discarding is also the one combination the
             * correlation rules do **not** justify. A proven correlation is a
             * statement that this settlement's stream *is* this attempt's stream,
             * and a settlement's embedded stream is the whole attempt: replacing
             * the stream-derived evidence with it is completing the record, not
             * merging two records. The alternative — appending — is unavailable in
             * principle, because the two planes share no per-delta identity and an
             * overlapped delta would be counted twice (`reconcileAttemptStream`).
             *
             * The refusal is as load-bearing as the replacement: a decode with any
             * malformed record is not the whole attempt, so it is declined and the
             * transient evidence — which may well hold deltas the decode lost —
             * is left exactly as it stands. Phase 9.4.5 names the second half of
             * that: an attempt whose decode was refused keeps its `live` temporal
             * authority, so the settled card reports an `estimated` shape. A finite
             * `settlementSeq` and an authoritative usage counter are still recorded
             * — the settlement happened and the tokens are the provider's — but
             * neither of them says the attempt's *timeline* is a durable
             * reconstruction. The refusal is counted as
             * `settlementStreamsRejected`, not as an unproved correlation.
             */
            if (event.decoded !== undefined) {
              const reconciliation = store.reconcileAttemptStream(record, attempt, { decoded: event.decoded })
              if (reconciliation.reconciled) state.counters.settlementStreamsReconciled += 1
              else state.counters.settlementStreamsRejected += 1
              log(
                'attempt stream reconciled', sessionId, attemptId, reconciliation.reason,
                reconciliation.samples, reconciliation.cuts,
              )
            }
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
            /**
             * Which durable surface settled the attempt. `settleAttempt` does not
             * carry it — it is not part of the settlement *state* the store is asked
             * to record — so it is attached to the restored attempt directly, which is
             * what the durable reconstruction path publishes and therefore what makes
             * a restored attempt comparable with a reconstructed one.
             */
            settlementEventType: event.eventType ?? null,
            interrupted: event.interrupted === true,
            issues: event.issues ?? [],
          })
          record.attempts.push(restored)
          record.attemptIndex.set(restored.attemptId, restored)
          /**
           * The settlement carried a decoded stream and could not be joined to an
           * existing attempt — either no attempt was proved to own it, or more than
           * one candidate made the pairing unprovable and the correlation refused to
           * guess. Counted, so a refused join is visible in `diagnostics()` rather
           * than indistinguishable from a settlement that never carried a stream.
           *
           * This is the *uncorrelated* outcome and not the *rejected* one: nothing
           * was proved about an existing attempt here, so no existing record's
           * evidence was refused. The restored attempt's own temporal authority is
           * whatever the decode it was built from supports
           * (`attemptFromDecoded`), and a malformed stream restores a
           * `durable-incomplete` attempt rather than a durable-complete one.
           */
          state.counters.settlementStreamsUncorrelated += 1
          /**
           * The turn TTFT is `turn/start -> first chunk DSH's predicate accepts`,
           * and a restored attempt brings that instant with it: `decoded` carries
           * the boundary from the compact stream itself, so a name-bearing
           * tool-call delta whose argument fragment stayed empty is counted
           * exactly as the live path counts it. Taking the earliest *sample*
           * instead — as an earlier revision did — would silently miss that
           * boundary and report `—` for a TTFT the live session had measured.
           *
           * `firstTokenObserved` is the same one-way freeze the live path uses, so
           * replaying a settlement can never move an instant already recorded.
           */
          const restoredFirstTokenMs = Number.isFinite(restored.firstTokenMs)
            ? restored.firstTokenMs
            : restored.samples.reduce(
              (earliest, sample) => (Number.isFinite(sample.timeMs) && (earliest === null || sample.timeMs < earliest)
                ? sample.timeMs
                : earliest),
              null,
            )
          store.firstTokenObserved(record, { timeMs: restoredFirstTokenMs })
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
        state.counters.matchedToolResults += 1
        state.presenter.apply({ type: 'tool-end', turn: record.turn, timeMs: event.timeMs })
        log('tool end', sessionId, call.name, event.status)
        return
      }

      case NORMALIZED_KIND.TURN_END: {
        state.counters.normalizedTurnEndSeen += 1
        let record = lookupRecord(state, event.turn)
        if (record === null) {
          /**
           * §25: a terminal boundary with no record to close is **not** silent.
           *
           * The record is normally present — `turn/start` opened it, or a
           * transient row adopted the turn — but the published window is a live
           * *tail*, so a client that attached after the turn began can receive
           * `turn/end` for a turn whose opening row is outside the window and
           * whose transient rows were already superseded.
           *
           * The turn genuinely ended: DSH published the authoritative boundary. The
           * record is therefore reconstructed from the turn's own **durable
           * evidence**, which the feed has been retaining since the window
           * generation began — the `assistant/message` settlements with their
           * embedded compact streams, the `tool/call` and `tool/result` boundaries,
           * the step and retry rows:
           *
           *     feed.turnEvents(turn) -> materializeReconstructedTurn()
           *         -> store.beginAttempt/acceptChunk/setAttemptUsage/settleAttempt
           *         -> store.toolStarted/toolSettled
           *         -> store.endTurn() -> aggregateTurn -> curveSource -> attemptTraces
           *
           * Two earlier revisions are worth naming, because both look plausible and
           * both are wrong. Phase 7D opened an **empty** record here and closed it,
           * so the card appeared with zero attempts, zero tokens and no tools while
           * the evidence for all of them was in the window it had just read. Decoding
           * that evidence here would have created a third durable parser; every field
           * below instead comes from `reconstructFromDurable`
           * (`src/dsh/durable-path.js`), which stays the only module that decodes a
           * settlement.
           *
           * Nothing is fabricated. `startMs` is whatever the retained evidence
           * actually contains: with no `turn/start` row it stays `null`, exactly as
           * the mid-turn-attach path leaves it, so no elapsed time and no TTFT is
           * measured from the reconstruction. `observedTurnStart` is consulted only
           * for a turn whose `turn/start` this session *did* observe but whose record
           * is gone — the reconstruction reports the same instant — never as a
           * substitute for a boundary nobody saw.
           */
          state.counters.turnEndLookupMiss += 1
          state.counters.turnEndReconstructed += 1
          const observed = state.observedTurnStart
          const observedStartMs = observed !== null && observed.turn === event.turn ? observed.timeMs : null
          const materialized = materializeReconstructedTurn({
            store,
            sessionId,
            turn: event.turn,
            events: state.feed.turnEvents(event.turn),
          })
          record = materialized.record
          if (Number.isFinite(observedStartMs)) {
            store.turnStartObserved(record, { timeMs: observedStartMs })
          }
          /**
           * The machine must own the turn identity before it can settle it: a
           * session whose machine is still `inactive` refuses a `turn-end`
           * (`live-state.js` `wrongTurn`), which is correct for a stray boundary
           * and wrong for this one. Opening the turn as a **recovered** boundary
           * is the same construction the mid-turn attach uses — it is inferred,
           * so it carries no start instant of its own.
           */
          state.presenter.apply({ type: 'turn-start', turn: event.turn, timeMs: null, recovered: true })
          state.feedIssues = state.feedIssues ?? []
          if (state.feedIssues.length < 100) {
            state.feedIssues.push({
              kind: CONTROLLER_ISSUE.TURN_END_WITHOUT_RECORD,
              detail: {
                turn: event.turn,
                seq: event.seq,
                reconstructedAttempts: materialized.reconstructed.attempts.length,
                reconstructedTools: materialized.reconstructed.tools.length,
                startKnown: Number.isFinite(record.startMs),
              },
            })
          }
          log('turn/end without a record; reconstructed from durable evidence', sessionId, event.turn)
        } else {
          state.counters.turnEndLookupHit += 1
        }
        state.counters.storeEndTurnCalled += 1
        const settled = store.endTurn(record, { timeMs: event.timeMs, status: event.status, statusNote: event.note })
        state.counters.settledSnapshotBuilt += 1
        state.currentRecord = null
        state.openAttemptId = null
        state.observedTurnStart = null
        state.presenter.apply({ type: 'turn-end', turn: event.turn, timeMs: event.timeMs, status: event.status })
        state.counters.presenterTurnEndApplied += 1
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
        currentEventSource: source,
        currentRecord: null,
        openAttemptId: null,
        ignoredEvents: 0,
        droppedDeltas: 0,
        unmatchedToolResults: 0,
        unknownEvents: 0,
        /**
         * The start instant of the open turn, as the durable `turn/start` row
         * declared it, tagged with the turn it belongs to. Kept beside the record
         * so a `turn/end` that arrives after its own opening row left the window
         * can still close the turn with the observed boundary rather than a
         * `null` one — and scoped by turn, because a start observed for one turn
         * is not evidence about another.
         */
        observedTurnStart: null,
        /**
         * Completion-path counters. Debug-only and off by default: each is an
         * integer incremented inside a handler that already runs, nothing is
         * allocated per event, and they are read only by `diagnostics()`.
         */
        counters: {
          normalizedTurnEndSeen: 0,
          turnEndLookupHit: 0,
          turnEndLookupMiss: 0,
          /**
           * A terminal record materialized from the turn's available durable
           * evidence. Phase 7D.1 narrows what this counter may be read as: before it,
           * the miss path opened an empty record and closed it, so the counter was
           * satisfied by a reconstruction that had consumed nothing. It now counts
           * one reconciliation only — `turn/end` arrived, no record existed, and a
           * record was built from `feed.turnEvents(turn)` through
           * `reconstructFromDurable`. It deliberately does **not** claim the evidence
           * was non-empty: a turn whose only visible row is its own `turn/end`
           * reconstructs to an empty turn, which is the correct answer and is counted
           * here too. Read it as "the miss was reconciled", never as "metrics were
           * recovered" — the issue detail carries the recovered attempt and tool
           * counts for a caller that needs the distinction.
           */
          turnEndReconstructed: 0,
          storeEndTurnCalled: 0,
          presenterTurnEndApplied: 0,
          settledSnapshotBuilt: 0,
          matchedToolResults: 0,
          /**
           * The mixed plane, counted where it is decided (Phase 9.4.4, split into
           * three facts in Phase 9.4.5).
           *
           * Three outcomes are distinguishable, and collapsing any two of them
           * would misstate what happened:
           *
           *   - `settlementStreamsReconciled` — the correlation was proved **and**
           *     the decoded stream was complete, so it replaced that attempt's
           *     stream-derived evidence;
           *   - `settlementStreamsUncorrelated` — no unique attempt was proved to
           *     own the settlement (or none existed at all), so the existing
           *     durable-restoration policy restored it as its own attempt;
           *   - `settlementStreamsRejected` — the correlation **was** proved and the
           *     reconciliation refused anyway, which today means `decoded.complete
           *     !== true`. The transient evidence stands.
           *
           * Phase 9.4.4 counted both non-reconciled outcomes as
           * `settlementStreamsUncorrelated`. That was false for the rejected case:
           * the settlement *was* correlated, and the attempt it was correlated to
           * is exactly the record the refusal had to protect. Reading "the
           * correlation failed" from a refused decode is how a replaced-stream
           * regression would have looked identical to an incomplete decode.
           */
          settlementStreamsReconciled: 0,
          settlementStreamsUncorrelated: 0,
          settlementStreamsRejected: 0,
          eventSourceRebinds: 0,
          foregroundResyncs: 0,
        },
        /** The kind of view the last `project()` returned. */
        projectedViewKind: null,
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
          const snap = state.currentEventSource?.getSnapshot?.()
          if (snap) state.feed.applyWindow(snap)
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
     * Authoritative foreground resynchronization (Phase 10.1R).
     *
     * 1. Resolves the current session binding.
     * 2. Inspects current binding.eventSource and detects source identity replacement.
     * 3. On source replacement: unbinds old source, adopts new source, subscribes,
     *    and performs a full generation rebaseline (restarting revision numbering).
     * 4. On same source identity: obtains authoritative snapshot and feeds through
     *    recovery-safe SessionEventFeed (which detects revision gaps and rebaselines if needed).
     * 5. Invalidates presentation cache and records foreground recovery diagnostics.
     *
     * @param {string} sessionId
     * @param {string} [reason]
     * @returns {object} diagnostic result
     */
    resync(sessionId, reason = 'foreground-recovery') {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') {
        return { resynced: false, reason: 'invalid-session' }
      }
      let state = sessionsMap.get(sessionId)
      if (state === undefined) {
        const attached = this.attach(sessionId)
        if (!attached) return { resynced: false, reason: 'binding-unavailable', sessionId }
        state = sessionsMap.get(sessionId)
        if (state === undefined) return { resynced: false, reason: 'state-unavailable', sessionId }
      }

      const binding = typeof sessions?.binding === 'function' ? sessions.binding(sessionId) : undefined
      if (binding === undefined || binding === null || binding.eventSource === undefined || binding.eventSource === null) {
        return { resynced: false, reason: 'no-binding', sessionId }
      }

      const currentSource = binding.eventSource
      let sourceRebound = false

      if (state.currentEventSource !== currentSource) {
        sourceRebound = true
        state.counters.eventSourceRebinds = (state.counters.eventSourceRebinds ?? 0) + 1
        log('eventSource rebind', sessionId)
        if (typeof state.unsub === 'function') {
          try { state.unsub() } catch { /* ignore */ }
          state.unsub = null
        }
        state.currentEventSource = currentSource
        const read = () => {
          try {
            const snap = state.currentEventSource?.getSnapshot?.()
            if (snap) state.feed.applyWindow(snap)
          } catch (error) {
            log('event window read failed', sessionId, error)
          }
        }
        state.unsub = currentSource.subscribe(read)

        const snapshot = currentSource.getSnapshot()
        state.feed.rebaseline()
        state.feed.revision = Number.isFinite(snapshot?.revision) ? snapshot.revision : -1
        if (Array.isArray(snapshot?.entries)) {
          state.feed.processEntries(snapshot.entries)
        }
        invalidate(state)
        emit()
      } else {
        const snapshot = currentSource.getSnapshot()
        state.feed.applyWindow(snapshot)
        invalidate(state)
      }

      state.counters.foregroundResyncs = (state.counters.foregroundResyncs ?? 0) + 1

      return {
        resynced: true,
        sessionId,
        reason,
        sourceRebound,
        lastFeedRevision: state.feed?.revision ?? -1,
        lastSourceRevision: currentSource.getSnapshot?.()?.revision ?? -1,
        revisionGapsDetected: state.feed?.counters?.revisionGapsDetected ?? 0,
        revisionGapRebaselines: state.feed?.counters?.revisionGapRebaselines ?? 0,
        eventSourceRebinds: state.counters?.eventSourceRebinds ?? 0,
        foregroundResyncs: state.counters?.foregroundResyncs ?? 0,
      }
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
      state.projectedViewKind = view.kind
      return view
    },

    /**
     * Diagnostics for tests and debug tooling.
     *
     * Two groups, each counted where the fact happens rather than derived later:
     * the feed's raw-vs-interpreted counters answer "did the wire deliver it", and
     * the controller's answer "what did the plugin do with it". A terminal
     * boundary lost on the completion path is then readable as the first counter
     * that stayed at zero — `rawTurnEndSeen` for a wire that never published it,
     * `turnEndLookupMiss` for a boundary that arrived with no record to close.
     */
    diagnostics(sessionId) {
      const state = sessionsMap.get(sessionId)
      if (state === undefined) return null
      const meter = store.liveBySession.get(sessionId)
      const unresolved = meter === undefined ? 0 : meter.runningTools().length
      return {
        feedIssues: state.feedIssues ?? [],
        ignoredEvents: state.ignoredEvents ?? 0,
        droppedDeltas: state.droppedDeltas ?? 0,
        unmatchedToolResults: state.unmatchedToolResults ?? 0,
        unknownEvents: state.unknownEvents ?? 0,
        projectedViewKind: state.projectedViewKind ?? null,
        /**
         * §37 keeps three quantities apart, and these are the live pair.
         *
         * `liveRunningTools` is `live.runningTools().length`: the calls the meter
         * still holds unresolved. `livePresentedToolCount` is what the live pill
         * would actually print — the same number, but only while the tool stage
         * owns the view. They differ in exactly one situation, and it is the one
         * §27 describes: a turn that ended with a call whose result was never
         * observed. Presentation closes; the unresolved call stays on the record
         * as incomplete evidence rather than being cleared or given an end time.
         *
         * Both are read from the meter's own state rather than from a snapshot: a
         * snapshot evaluated at the wall clock *evicts* expired samples from the
         * rolling window, so a diagnostic that took one would silently change the
         * rate it was only supposed to observe.
         */
        liveRunningTools: unresolved,
        livePresentedToolCount: meter !== undefined && meter.phase === 'tool' ? unresolved : 0,
        foregroundResyncs: state.counters?.foregroundResyncs ?? 0,
        eventSourceRebinds: state.counters?.eventSourceRebinds ?? 0,
        revisionGapsDetected: state.feed?.counters?.revisionGapsDetected ?? 0,
        revisionGapRebaselines: state.feed?.counters?.revisionGapRebaselines ?? 0,
        lastFeedRevision: state.feed?.revision ?? -1,
        lastSourceRevision: state.currentEventSource?.getSnapshot?.()?.revision ?? -1,
        counters: { ...(state.feed?.counters ?? {}), ...state.counters },
      }
    },

    /** Attached session ids, for lifecycle assertions. */
    attachedSessions() {
      return [...sessionsMap.keys()]
    },

    /** Sessions service reference (for diagnostics and lifecycle inspections). */
    get sessions() {
      return sessions
    },

    /** Read internal session feed by id (diagnostic inspection). */
    feed(sessionId) {
      return sessionsMap.get(sessionId)?.feed ?? null
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
