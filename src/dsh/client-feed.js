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
 *   settle-assistant attemptId + durable settlement entry atomically
 *                    superseding one attempt's transient rows (or a bare
 *                    abandonment when the entry is absent)
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
})

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
    this.issues = []
    /** Counts of deliberately skipped window changes, for diagnostics. */
    this.ignoredPrepends = 0
    this.eventCount = 0
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
    this.emit({ kind: 'window-rebaseline', timeMs: null })
  }

  applySettlement(change) {
    const attemptId = typeof change.attemptId === 'string' ? change.attemptId : null
    const entry = change.entry
    if (attemptId === null) {
      this.issue(FEED_ISSUE.UNMATCHED_SETTLEMENT)
      return
    }
    if (entry === undefined || entry === null) {
      // The fold publishes a bare settle-assistant when the attempt ended
      // without a durable settlement: transient abandonment, the only place
      // `abandoned` can be derived client-side.
      if (this.openAttemptId === attemptId) this.openAttemptId = null
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
    const event = entry.event
    if (event && typeof event === 'object' && Number.isFinite(event.seq)) this.durableSeqs.add(event.seq)
    const normalized = normalizeDurableEvent(event)
    if (normalized.kind !== NORMALIZED_KIND.ATTEMPT_SETTLE) {
      this.issue(FEED_ISSUE.UNMATCHED_SETTLEMENT, normalized.kind)
      return
    }
    if (this.openAttemptId === attemptId) this.openAttemptId = null
    this.emit({ ...normalized, attemptId })
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
        this.openTurn = null
        this.openAttemptId = null
        if (Number.isFinite(normalized.turn)) this.settledTurns.add(normalized.turn)
        this.markTurnSeen(normalized.turn)
        this.emit(normalized)
        return
      case NORMALIZED_KIND.ATTEMPT_SETTLE:
        // No `settle-assistant` change here (fixture-style replay, or a fold
        // that appends the row): correlate to the open transient attempt when
        // one exists. Attempt identity is never invented when none does.
        this.emit({ ...normalized, attemptId: this.openAttemptId })
        if (this.openAttemptId !== null) this.openAttemptId = null
        return
      default:
        this.emit(normalized)
    }
  }
}
