/**
 * Browser event-window feed: `SessionEventWindow` -> normalized engine events.
 *
 * This is the Phase 3 seam chosen in Phase 0: the Client
 * `ctx.sessions.binding(id).eventSource` publishes every window mutation
 * synchronously, and one window carries **both** evidence planes — durable
 * `SessionEvent` rows (`type: 'event'`) and client-folded transient
 * `assistant/live-chunk` rows (`type: 'transient'`). No host telemetry channel,
 * no session projection, no synthetic durable events, no DOM scraping.
 *
 * The feed is the only module that understands the window wire shape
 * (`change.kind`, entry discriminants). Everything it emits is a normalized
 * event in this project's vocabulary, ready for `TurnTelemetryStore` and the
 * live UI state machine. It holds no timers, no statistics and no React.
 *
 * Window-change semantics (verified at
 * `dsh-api-session-controller/lib/types/client/contract/events.d.ts:41-61`):
 *
 *   replace          the complete contiguous window was swapped (initial
 *                    snapshot, reload rebaseline) — reset and replay it
 *   append           new tail entries arrived — feed exactly those
 *   prepend          older history was paged in — irrelevant to the live tail,
 *                    and ingesting it after newer events would replay stale
 *                    turns out of order, so it is deliberately ignored
 *   settle-assistant attemptId, with or without a durable settlement entry
 *
 * ## `settle-assistant` is ambiguous in DSH 0.1.7-rc.2, and this is where it is resolved
 *
 * The published contract calls the entry optional and the 0.1.5 reading treated
 * "entry absent" as synonym for "attempt abandoned". The local 0.1.7 install
 * disproves that reading. `ClientAssistantStream` publishes the same bare
 * `settleAssistant(attemptId)` from **two** different situations
 * (`dsh-api-session-controller/lib/client.js:1445-1539`, `:617-648`):
 *
 *   normal successful retirement
 *     the attempt's durable `assistant/message` is published (non-interrupted),
 *     a `retainedAttempt` is recorded, and when the matching `step/end` is
 *     published the fold returns `{type:'publish', entry, retireAttemptId}` —
 *     the session then appends the step end **and** calls
 *     `eventSource.settleAssistant(attemptId)` with no entry, purely to discard
 *     transient rows that a durable node already supersedes.
 *
 *   true abandonment
 *     the attempt's `end` frame carries `outcome.kind === 'abandoned'` and no
 *     settlement is pending; the fold returns `{type:'abandonment', attemptId}`
 *     and the session calls the same bare `settleAssistant(attemptId)`.
 *
 * `entry === undefined` therefore proves nothing on its own. What distinguishes
 * them is state the feed can hold from evidence it has already seen: whether a
 * durable, non-interrupted settlement has already been observed for this
 * attempt. A bare settle for an attempt that already has one is **transient
 * retirement only** and emits no second attempt outcome; a bare settle for an
 * attempt that has none is the abandonment path.
 */

import { NORMALIZED_KIND, normalizeDurableEvent, normalizeLiveChunk } from './adapter.js'

/** Feed-level diagnostics; every entry names why evidence could not be used. */
export const FEED_ISSUE = Object.freeze({
  MALFORMED_WINDOW: 'malformed-window',
  UNKNOWN_CHANGE: 'unknown-window-change',
  MISSING_CHANGE_ENTRIES: 'missing-change-entries',
  MALFORMED_ENTRY: 'malformed-entry',
  DUPLICATE_TRANSIENT: 'duplicate-transient-row',
  DUPLICATE_DURABLE: 'duplicate-durable-event',
  UNMATCHED_SETTLEMENT: 'settlement-without-attempt-id',
  /**
   * A transient row naming a turn this client has already finished with. The
   * row is not delivered — re-opening a settled turn would resurrect a closed
   * record and a card that has already been built — but it is recorded, because
   * a late frame is a real wire behaviour and silence would hide it.
   */
  LATE_TURN_ROW: 'transient-row-of-a-finished-turn',
  /**
   * A durable row of a turn this client has already closed. The same rule as
   * `LATE_TURN_ROW`, on the durable plane: `turn/end` is terminal for live
   * presentation, so a trailing tool boundary cannot re-open the turn.
   */
  LATE_TURN_EVENT: 'durable-event-of-a-finished-turn',
  /**
   * A bare `settle-assistant` naming an attempt the feed never saw open, with no
   * durable settlement waiting to be retired. Read as abandonment, and recorded
   * because the identity could not be resolved from held evidence.
   */
  UNRESOLVED_SETTLEMENT: 'bare-settlement-without-known-attempt',
})

/** The key under which an attempt's `(turn, step)` is registered. */
function stepKey(turn, step) {
  return Number.isFinite(turn) && Number.isFinite(step) ? `${turn}:${step}` : null
}

export class SessionEventFeed {
  /**
   * @param {{
   *   sessionId: string,
   *   onEvent: (event: object) => void,
   *   onIssue?: (issue: {kind: string, detail?: unknown}) => void,
   * }} options
   */
  constructor({ sessionId, onEvent, onIssue = () => {} }) {
    this.sessionId = sessionId ?? null
    this.onEvent = onEvent
    this.onIssue = onIssue
    /** Whether the initial full window pass has happened. */
    this.initialized = false
    this.revision = -1
    /** Durable sequence dedupe within the current window generation. */
    this.durableSeqs = new Set()
    /** Transient row dedupe keyed by the fold's event object identity. */
    this.transientRows = new WeakSet()
    /** The transient attempt that has not received a durable settlement yet. */
    this.openAttemptId = null
    /** Open turn number, or `null`. */
    this.openTurn = null
    /**
     * Turns this feed has seen close (`turn/end`). A late transient row of any
     * of them must not re-open the turn: its record has already been settled and
     * its evidence handed to the completed card. Keyed by identity rather than a
     * single "last settled" number, because a settlement can be followed by rows
     * of an older turn.
     */
    this.settledTurns = new Set()
    /**
     * The highest turn number observed so far, or `null`. Turns are ordered
     * within a session, so a transient row below it is late evidence of a turn
     * the feed has already moved past (`adoptTurn`).
     */
    this.highestTurn = null
    /**
     * Attempts whose transient rows arrived, with the `(turn, step)` those rows
     * named. This is the only place an `attemptId` — a process-local identity
     * that never enters the durable log — can be tied to a durable coordinate.
     */
    this.attemptSteps = new Map()
    /**
     * Attempts that received a durable settlement **directly** — the
     * `settle-assistant` route that names the attempt and carries its entry
     * (interrupted messages, `assistant/attempt`). A bare settle for one of
     * these can only be a retirement.
     */
    this.settledAttemptIds = new Set()
    /**
     * Durable, non-interrupted `assistant/message` settlements published but not
     * yet retired, oldest first, keyed by their durable `(turn, step)`.
     *
     * DSH's fold retains exactly one such settlement per step and releases it
     * when that step's `step/end` is published, calling the bare
     * `settleAssistant(attemptId)` at that moment. The queue is therefore both
     * the proof that a retirement is happening and the budget that stops one
     * settlement from excusing a *later* attempt in the same step.
     */
    this.pendingSettlements = []
    this.issues = []
    /** Counts of deliberately skipped window changes, for diagnostics. */
    this.ignoredPrepends = 0
    this.eventCount = 0
    /** Debug-only counters; `controller.diagnostics()` reads them. */
    this.counters = {
      rawDurableEvents: 0,
      rawTransientRows: 0,
      rawToolCalls: 0,
      rawToolResults: 0,
      matchedToolResults: 0,
      unmatchedToolResults: 0,
      malformedToolResults: 0,
      rawTurnEndSeen: 0,
      normalizedTurnEndSeen: 0,
      bareSettleSeen: 0,
      settlementsWithEntry: 0,
      retirementsResolved: 0,
      abandonmentsResolved: 0,
      lateTurnRows: 0,
      lateTurnEvents: 0,
    }
  }

  issue(kind, detail) {
    const record = detail === undefined ? { kind } : { kind, detail }
    this.issues.push(record)
    this.onIssue(record)
  }

  emit(event) {
    this.eventCount += 1
    this.onEvent(event)
  }

  /** Consume one published window snapshot (idempotent per revision). */
  applyWindow(window) {
    if (window === null || typeof window !== 'object' || !Array.isArray(window.entries)) {
      this.issue(FEED_ISSUE.MALFORMED_WINDOW)
      return
    }
    const change = window.change && typeof window.change === 'object' ? window.change : { kind: 'replace' }

    if (!this.initialized) {
      this.initialized = true
      this.revision = Number.isFinite(window.revision) ? window.revision : -1
      this.processEntries(window.entries)
      return
    }

    if (Number.isFinite(window.revision) && window.revision <= this.revision) return
    if (Number.isFinite(window.revision)) this.revision = window.revision

    switch (change.kind) {
      case 'append':
        if (!Array.isArray(change.entries)) {
          this.issue(FEED_ISSUE.MISSING_CHANGE_ENTRIES, 'append')
          return
        }
        this.processEntries(change.entries)
        return
      case 'prepend':
        // Older history: outside the live tail and out of chronological order
        // relative to what has already been consumed. Counted, never guessed at.
        this.ignoredPrepends += 1
        return
      case 'replace':
        this.rebaseline()
        this.processEntries(window.entries)
        return
      case 'settle-assistant':
        this.applySettlement(change)
        return
      default:
        this.issue(FEED_ISSUE.UNKNOWN_CHANGE, change.kind)
    }
  }

  /**
   * A `replace` is a rebaseline (reload, reconnect, window swap). All previous
   * dedupe state belongs to the superseded window generation; replaying the new
   * window from scratch is what keeps the live state consistent with the rows
   * the fold actually publishes now.
   */
  rebaseline() {
    this.durableSeqs = new Set()
    this.transientRows = new WeakSet()
    this.openAttemptId = null
    this.openTurn = null
    /**
     * The turn-adoption guards are generation state too. A new window is a new
     * set of rows: a turn this client had already closed may legitimately be
     * the open turn of the replayed window, and a window may begin at any turn.
     * Keeping the previous generation's `highestTurn` would refuse the adoption
     * the reload just made necessary.
     */
    this.settledTurns = new Set()
    this.highestTurn = null
    this.attemptSteps = new Map()
    this.settledAttemptIds = new Set()
    this.pendingSettlements = []
    this.emit({ kind: 'window-rebaseline', timeMs: null })
  }

  /**
   * Whether a durable settlement is available to retire one bare settle, and by
   * which route it was resolved.
   *
   * Three routes, in order of strength. The attempt's own identity is the only
   * proof that needs no coordinate; the outstanding-settlement queue is how a
   * settlement — which names no `attemptId` — is matched to the attempt whose
   * `(turn, step)` its transient rows declared; and a single queued settlement
   * still covers an attempt whose rows this client never saw, because DSH
   * retires one attempt per published settlement.
   */
  durableSettlementFor(attemptId) {
    if (this.settledAttemptIds.has(attemptId)) return { route: 'attempt-identity', key: null, index: -1 }
    if (this.pendingSettlements.length === 0) return null
    const key = this.attemptSteps.get(attemptId)
    if (key !== undefined) {
      const index = this.pendingSettlements.findIndex(entry => entry.key === key)
      if (index >= 0) return { route: 'pending-coordinate', key, index }
      return null
    }
    /**
     * The attempt's coordinate is unknown. Two or more outstanding settlements
     * leave the pairing unprovable, and the settle is recorded as unresolved
     * rather than attached to a guess.
     */
    if (this.pendingSettlements.length === 1) return { route: 'pending-unique', key: null, index: 0 }
    return null
  }

  consumeSettlement(route) {
    if (!Number.isFinite(route.index) || route.index < 0) return
    this.pendingSettlements.splice(route.index, 1)
  }

  applySettlement(change) {
    const attemptId = typeof change.attemptId === 'string' ? change.attemptId : null
    const entry = change.entry
    if (attemptId === null) {
      this.issue(FEED_ISSUE.UNMATCHED_SETTLEMENT)
      return
    }
    if (entry === undefined || entry === null) {
      this.counters.bareSettleSeen += 1
      const durable = this.durableSettlementFor(attemptId)
      if (this.openAttemptId === attemptId) this.openAttemptId = null
      if (durable !== null) {
        /**
         * Normal successful retirement. The durable settlement was already fed
         * from the `append` that published it, and the machine has already left
         * the streaming state on that event; emitting a second attempt outcome
         * here would overwrite a committed outcome with an abandonment and is
         * exactly the 0.1.5-era defect this branch exists to prevent.
         */
        this.consumeSettlement(durable)
        this.counters.retirementsResolved += 1
        return
      }
      if (this.attemptSteps.get(attemptId) === undefined) {
        this.issue(FEED_ISSUE.UNRESOLVED_SETTLEMENT, { attemptId, route: 'abandonment' })
      }
      this.counters.abandonmentsResolved += 1
      this.emit({
        kind: NORMALIZED_KIND.ATTEMPT_ABANDON,
        attemptId,
        turn: this.openTurn,
        timeMs: null,
        settlementKind: 'none',
        surfaceCommitted: false,
        attemptOutcome: 'abandoned',
      })
      return
    }
    this.counters.settlementsWithEntry += 1
    const event = entry.event
    if (event && typeof event === 'object' && Number.isFinite(event.seq)) this.durableSeqs.add(event.seq)
    const normalized = normalizeDurableEvent(event)
    if (normalized.kind !== NORMALIZED_KIND.ATTEMPT_SETTLE) {
      this.issue(FEED_ISSUE.UNMATCHED_SETTLEMENT, normalized.kind)
      return
    }
    /**
     * A settlement delivered **with** its entry is DSH's immediate path:
     * interrupted messages and non-surface `assistant/attempt` settlements. It
     * is a durable settlement for this attempt, so a later bare settle for the
     * same attempt is a retirement and not a second outcome.
     */
    this.registerDurableSettlement(normalized, { attemptId, queue: false })
    if (this.openAttemptId === attemptId) this.openAttemptId = null
    this.emit({ ...normalized, attemptId })
  }

  /**
   * Record that one durable settlement landed.
   *
   * Two routes reach a durable settlement, and they differ in what they leave
   * behind. A settlement delivered **with** its entry is DSH's immediate route
   * (interrupted messages, `assistant/attempt`): it names the attempt, the
   * transient rows are superseded at that instant, and nothing stays
   * outstanding. A settlement appended as a plain durable row is a
   * non-interrupted `assistant/message`, which the fold retains until the owning
   * `step/end` is published and only then retires with a bare settle — that one
   * is queued, and `queue: false` is what keeps an immediately-retired
   * settlement from excusing a later attempt in the same step.
   */
  registerDurableSettlement(normalized, { attemptId = null, queue = true } = {}) {
    if (attemptId !== null) this.settledAttemptIds.add(attemptId)
    if (!queue) return
    const key = stepKey(normalized.turn, normalized.step)
    const retains = normalized.eventType === 'assistant/message' && normalized.interrupted !== true
    if (retains && key !== null && !this.pendingSettlements.some(entry => entry.key === key)) {
      this.pendingSettlements.push({ key, seq: normalized.seq ?? null })
    }
  }

  /**
   * Derive the open-turn boundary from transient evidence.
   *
   * The published window is a live *tail*: after a reload — or after a
   * `replace` rebaseline, which is what a reconnect produces — the open turn's
   * `turn/start` row is normally outside it. A page that attaches mid-turn then
   * knows the turn only from the `turn` field of its transient rows. Without a
   * boundary every turn-scoped event is discarded ("belongs to no turn") and
   * the live view never appears at all.
   *
   * The first transient row naming a turn the feed is not tracking is therefore
   * adopted as the boundary — the same client-side derivation the attempt
   * boundary below already relies on. The emitted event carries
   * `recovered: true` because it is *inferred*, not observed: consumers must not
   * restart turn-scoped stopwatches from it, and the turn's start time stays
   * unknown (`timeMs: null`) so TTFT is never measured from the reload.
   *
   * A turn already closed by a durable `turn/end` is never re-opened, and a turn
   * the feed has already moved past is never re-adopted: both guards are per turn
   * identity, because a turn number is an identity and the rows of one turn can
   * arrive interleaved with another's. A row that names no *finite* turn adopts
   * nothing — there is nothing to name, and guessing one would attach this
   * client's evidence to a turn it cannot identify.
   */
  adoptTurn(turn) {
    if (!Number.isFinite(turn)) return false
    if (turn === this.openTurn) return false
    if (this.settledTurns.has(turn)) return false
    /** Turns are ordered, so a row below the highest observed one is late evidence of a past turn. */
    if (Number.isFinite(this.highestTurn) && turn < this.highestTurn) return false
    this.markTurnSeen(turn)
    this.openTurn = turn
    this.emit({ kind: NORMALIZED_KIND.TURN_START, turn, timeMs: null, recovered: true })
    return true
  }

  /**
   * Record that a turn number has been observed, whichever plane named it.
   *
   * This is the ordering watermark `adoptTurn` compares against, and it is fed
   * by transient rows and durable turn rows alike: a turn established by a
   * durable boundary — a row the client *did* observe, fully — must not later be
   * re-opened by the synthetic path either.
   */
  markTurnSeen(turn) {
    if (!Number.isFinite(turn)) return
    if (!Number.isFinite(this.highestTurn) || turn > this.highestTurn) this.highestTurn = turn
  }

  /**
   * Drop a transient row that belongs to a turn this feed has already finished
   * with, and record why.
   *
   * The row is *not* delivered. A turn closed by `turn/end` has a settled record
   * and a card; feeding a late delta into it would re-open a turn the session
   * ended, and the attempt identity it carries is no longer open, so the value it
   * would contribute is not the live view's business. Dropping it silently would
   * hide a real wire behaviour, so it is counted as an issue.
   */
  dropLateRow(turn, attemptId) {
    this.counters.lateTurnRows += 1
    this.issue(FEED_ISSUE.LATE_TURN_ROW, { turn, attemptId })
  }

  processEntries(entries) {
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') {
        this.issue(FEED_ISSUE.MALFORMED_ENTRY)
        continue
      }
      if (entry.type === 'transient') {
        this.processTransient(entry.event)
        continue
      }
      if (entry.type === 'event') {
        this.processDurable(entry.event)
        continue
      }
      this.issue(FEED_ISSUE.MALFORMED_ENTRY, entry.type)
    }
  }

  processTransient(row) {
    if (row === null || typeof row !== 'object') {
      this.issue(FEED_ISSUE.MALFORMED_ENTRY)
      return
    }
    if (this.transientRows.has(row)) {
      this.issue(FEED_ISSUE.DUPLICATE_TRANSIENT)
      return
    }
    this.transientRows.add(row)
    this.counters.rawTransientRows += 1
    const normalized = normalizeLiveChunk(row)
    if (normalized.kind === NORMALIZED_KIND.IGNORED) {
      this.issue(FEED_ISSUE.MALFORMED_ENTRY, normalized.reason)
      return
    }
    // Attempt identity exists only on the transient plane: a change of
    // `attemptId` between consecutive rows is the client-side attempt
    // boundary (the browser never sees the host `start` frame).
    this.markTurnSeen(normalized.turn)
    const adopted = this.adoptTurn(normalized.turn)
    if (!adopted && Number.isFinite(normalized.turn)) {
      /**
       * The row names a finite turn that was not adopted. Either the turn is
       * already the open one — the ordinary case, every row after the first —
       * or it is a turn this client has finished with, and its late evidence is
       * dropped rather than re-attached to a settled record.
       */
      if (normalized.turn !== this.openTurn) {
        this.dropLateRow(normalized.turn, normalized.attemptId)
        return
      }
    }
    /**
     * Tie the process-local attempt to its durable coordinate. The settlement
     * event never names an `attemptId`, so this registration is the only way a
     * later bare `settle-assistant` can be resolved against durable evidence.
     */
    const key = stepKey(normalized.turn, normalized.step)
    if (key !== null) this.attemptSteps.set(normalized.attemptId, key)
    if (normalized.attemptId !== this.openAttemptId) {
      this.openAttemptId = normalized.attemptId
      this.emit({
        kind: NORMALIZED_KIND.ATTEMPT_START,
        attemptId: normalized.attemptId,
        turn: normalized.turn,
        step: normalized.step,
        timeMs: normalized.timeMs,
      })
    }
    this.emit({
      kind: NORMALIZED_KIND.ATTEMPT_DELTA,
      attemptId: normalized.attemptId,
      turn: normalized.turn,
      step: normalized.step,
      timeMs: normalized.timeMs,
      chunk: normalized.chunk,
      phase: normalized.phase,
      countsAsToken: normalized.countsAsToken,
    })
  }

  processDurable(event) {
    if (event === null || typeof event !== 'object' || !Number.isFinite(event.seq)) {
      this.issue(FEED_ISSUE.MALFORMED_ENTRY)
      return
    }
    if (this.durableSeqs.has(event.seq)) {
      this.issue(FEED_ISSUE.DUPLICATE_DURABLE, event.seq)
      return
    }
    this.durableSeqs.add(event.seq)
    this.counters.rawDurableEvents += 1
    const normalized = normalizeDurableEvent(event)
    switch (normalized.kind) {
      case NORMALIZED_KIND.IGNORED:
        return
      case NORMALIZED_KIND.TURN_START:
        this.openTurn = normalized.turn
        this.markTurnSeen(normalized.turn)
        this.emit(normalized)
        return
      case NORMALIZED_KIND.TURN_END:
        this.counters.rawTurnEndSeen += 1
        this.counters.normalizedTurnEndSeen += 1
        this.openTurn = null
        this.openAttemptId = null
        if (Number.isFinite(normalized.turn)) this.settledTurns.add(normalized.turn)
        this.markTurnSeen(normalized.turn)
        this.emit(normalized)
        return
      case NORMALIZED_KIND.ATTEMPT_SETTLE:
        this.registerDurableSettlement(normalized)
        // No `settle-assistant` change here (fixture-style replay, or a fold
        // that appends the row): correlate to the open transient attempt when
        // one exists. Attempt identity is never invented when none does.
        this.emit({ ...normalized, attemptId: this.openAttemptId })
        if (this.openAttemptId !== null) this.openAttemptId = null
        return
      case NORMALIZED_KIND.TOOL_CALL:
        this.counters.rawToolCalls += 1
        if (this.dropIfSettled(normalized)) return
        this.emit(normalized)
        return
      case NORMALIZED_KIND.TOOL_RESULT:
        this.counters.rawToolResults += 1
        if (normalized.malformed === true) this.counters.malformedToolResults += 1
        if (this.dropIfSettled(normalized)) return
        this.emit(normalized)
        return
      default:
        /**
         * `turn/end` is terminal for live presentation: a trailing `step/start`,
         * `step/end`, retry or delta of a closed turn is counted and dropped so
         * it cannot resurrect the turn the session already ended.
         */
        if (this.dropIfSettled(normalized)) return
        this.emit(normalized)
    }
  }

  /**
   * Suppress a durable row belonging to a turn that has already been closed by
   * `turn/end`. Returns whether the row was dropped.
   */
  dropIfSettled(normalized) {
    if (!Number.isFinite(normalized.turn)) return false
    if (!this.settledTurns.has(normalized.turn)) return false
    this.counters.lateTurnEvents += 1
    this.issue(FEED_ISSUE.LATE_TURN_EVENT, { turn: normalized.turn, kind: normalized.kind, seq: normalized.seq })
    return true
  }
}
