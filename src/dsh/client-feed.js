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
        this.emit(normalized)
        return
      case NORMALIZED_KIND.TURN_END:
        this.openTurn = null
        this.openAttemptId = null
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
