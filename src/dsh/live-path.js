/**
 * Live (transient) accumulation path.
 *
 * This is path A of the equivalence requirement: consume the transient plane
 * exactly as a browser receives it — `agent/assistant-stream` frames or the
 * client-folded `assistant/live-chunk` rows they become — plus the durable
 * `turn/start`, `step/start`, `tool/call`, `tool/result` and `turn/end`
 * boundaries, and never touch a compact `AssistantStreamRecord`.
 *
 * The transient plane is fragile in a specific way that the durable plane is
 * not: it is ordered by a dense per-attempt `index`, it can be replayed, and it
 * can be re-baselined after a reload. This accumulator therefore validates the
 * index sequence instead of trusting arrival order, and it reports every
 * duplicate, gap and regression rather than folding them away.
 */

import { MetricQuality } from '../core/metric-quality.js'
import { heuristicTokenWeight, sampleFromChunk } from '../core/token-allocation.js'
import {
  NORMALIZED_KIND,
  applyRetryOutcomes,
  normalizeDurableEvent,
  normalizeLiveChunk,
  normalizeStreamFrame,
  settlementClassification,
} from './adapter.js'

/** Why a transient frame was not accepted into the attempt. */
export const FRAME_ISSUE = Object.freeze({
  DUPLICATE: 'duplicated-transient-frame',
  OUT_OF_ORDER: 'out-of-order-transient-frame',
  UNKNOWN_ATTEMPT: 'frame-for-unknown-attempt',
  MISSING_ATTEMPT_ID: 'frame-without-attempt-id',
  ATTEMPT_REOPENED: 'attempt-stream-reopened',
  MISSING_TIME: 'frame-without-timestamp',
})

/**
 * Accumulate one session's live evidence.
 *
 * Keyed by `(sessionId, turn)` at the caller's level; within one instance the
 * attempts are keyed by `attemptId`, because a turn may hold several attempts
 * and a tool may be running while the next attempt starts.
 */
export class LiveTurnAccumulator {
  /**
   * @param {{sessionId: string, estimate?: (text:string, phase:string, chunk:unknown)=>number}} options
   */
  constructor({ sessionId, estimate = heuristicTokenWeight } = {}) {
    this.sessionId = sessionId ?? null
    this.estimate = estimate
    this.turnStartMs = null
    this.turnEndMs = null
    this.status = null
    this.statusNote = null
    this.turnEndPayload = null
    this.attempts = new Map()
    this.attemptOrder = []
    this.tools = new Map()
    this.toolOrder = []
    this.steps = new Map()
    /** Scheduled durable retries, for outcome correlation (`llm/retry`). */
    this.retries = []
    /** Everything the live plane could not use, with its reason. */
    this.issues = []
    this.ignoredEvents = 0
    /** Attempts whose transient stream was still open when the caller read it. */
    this.openAttemptIds = new Set()
  }

  issue(kind, detail) {
    this.issues.push(detail === undefined ? { kind } : { kind, detail })
  }

  attempt(attemptId) {
    let attempt = this.attempts.get(attemptId)
    if (attempt === undefined) {
      attempt = {
        attemptId,
        turn: null,
        step: null,
        /** Settlement type: no durable settlement observed yet. */
        settlementKind: 'none',
        surfaceCommitted: false,
        /** Never fabricated: an open attempt's outcome is not known, and is *not* `abandoned`. */
        attemptOutcome: 'unknown',
        revision: null,
        nextIndex: 0,
        chunks: [],
        samples: [],
        usage: null,
        usageSource: null,
        startedAtMs: null,
        settledAtMs: null,
        settlementSeq: null,
        settlementEventType: null,
        interrupted: false,
        issues: [],
        /** Transient frames seen for this attempt, accepted or not. */
        frameCount: 0,
        acceptedFrameCount: 0,
      }
      this.attempts.set(attemptId, attempt)
      this.attemptOrder.push(attemptId)
      this.openAttemptIds.add(attemptId)
    }
    return attempt
  }

  /** Accept one `agent/assistant-stream` frame. */
  acceptStreamFrame(frame) {
    const normalized = normalizeStreamFrame(frame)
    switch (normalized.kind) {
      case NORMALIZED_KIND.ATTEMPT_START: {
        const existing = this.attempts.get(normalized.attemptId)
        if (existing !== undefined && existing.chunks.length > 0) {
          this.issue(FRAME_ISSUE.ATTEMPT_REOPENED, { attemptId: normalized.attemptId, revision: normalized.revision })
        }
        const attempt = this.attempt(normalized.attemptId)
        attempt.turn = normalized.turn ?? attempt.turn
        attempt.step = normalized.step ?? attempt.step
        attempt.revision = normalized.revision ?? attempt.revision
        attempt.startedAtMs = attempt.startedAtMs ?? null
        return
      }
      case NORMALIZED_KIND.ATTEMPT_DELTA: {
        this.acceptDelta({
          attemptId: normalized.attemptId,
          timeMs: normalized.timeMs,
          index: normalized.index,
          revision: normalized.revision,
          chunk: normalized.chunk,
        })
        return
      }
      case NORMALIZED_KIND.ATTEMPT_SETTLE:
      case NORMALIZED_KIND.ATTEMPT_ABANDON: {
        const attempt = this.attempt(normalized.attemptId)
        this.openAttemptIds.delete(normalized.attemptId)
        if (normalized.kind === NORMALIZED_KIND.ATTEMPT_ABANDON) {
          // Transient abandonment: no durable settlement exists for this
          // stream. This is the *only* place `abandoned` may be derived.
          attempt.settlementKind = normalized.settlementKind ?? 'none'
          attempt.surfaceCommitted = false
          attempt.attemptOutcome = normalized.attemptOutcome ?? 'abandoned'
          return
        }
        attempt.settlementSeq = normalized.settlementSeq
        attempt.settlementEventType = normalized.settlementEventType
        attempt.settlementKind = normalized.settlementKind
        attempt.surfaceCommitted = normalized.surfaceCommitted
        // The end frame's eventType is known but its `interrupted` marker is
        // not; `acceptSettlementIdentity` refines this from the durable payload.
        attempt.attemptOutcome = normalized.attemptOutcome
        return
      }
      default:
        this.issue(FRAME_ISSUE.MISSING_ATTEMPT_ID, normalized.reason ?? null)
    }
  }

  /** Accept one client-folded `assistant/live-chunk` row. */
  acceptLiveChunk(entry) {
    const normalized = normalizeLiveChunk(entry)
    if (normalized.kind === NORMALIZED_KIND.IGNORED) {
      this.issue(FRAME_ISSUE.MISSING_ATTEMPT_ID, normalized.reason ?? null)
      return
    }
    this.acceptDelta({
      attemptId: normalized.attemptId,
      timeMs: normalized.timeMs,
      index: null,
      revision: null,
      chunk: normalized.chunk,
      turn: normalized.turn,
      step: normalized.step,
      seq: normalized.seq,
    })
  }

  /**
   * Index-validated delta admission.
   *
   * `index` is the attempt's dense zero-based frame position. When it is
   * present, the accumulator requires it to be exactly the next expected value:
   * a repeat is a duplicated frame and a jump is a gap, and both make the
   * observed stream incomplete. Neither may be folded away, because both change
   * what the curve claims about time spent generating.
   */
  acceptDelta({ attemptId, timeMs, index, revision, chunk, turn = null, step = null, seq = null }) {
    if (typeof attemptId !== 'string' || attemptId === '') {
      this.issue(FRAME_ISSUE.MISSING_ATTEMPT_ID)
      return
    }
    const attempt = this.attempt(attemptId)
    if (turn !== null) attempt.turn = turn
    if (step !== null) attempt.step = step
    if (revision !== null && revision !== undefined) attempt.revision = revision
    attempt.frameCount += 1

    if (!Number.isFinite(timeMs)) {
      attempt.issues.push({ kind: FRAME_ISSUE.MISSING_TIME, index })
      this.issue(FRAME_ISSUE.MISSING_TIME, { attemptId, index })
      return
    }

    if (Number.isFinite(index)) {
      if (index < attempt.nextIndex) {
        attempt.issues.push({ kind: FRAME_ISSUE.DUPLICATE, index, expected: attempt.nextIndex })
        this.issue(FRAME_ISSUE.DUPLICATE, { attemptId, index, expected: attempt.nextIndex })
        return
      }
      if (index > attempt.nextIndex) {
        attempt.issues.push({ kind: FRAME_ISSUE.OUT_OF_ORDER, index, expected: attempt.nextIndex })
        this.issue(FRAME_ISSUE.OUT_OF_ORDER, { attemptId, index, expected: attempt.nextIndex })
      }
      attempt.nextIndex = index + 1
    }

    attempt.acceptedFrameCount += 1
    attempt.chunks.push({ timeMs, chunk, index, revision, seq })
    const sample = sampleFromChunk(timeMs, chunk, this.estimate)
    if (sample !== null) attempt.samples.push({ ...sample, attemptId })
  }

  /** Accept one durable session event (boundaries, tools, settlements). */
  acceptDurableEvent(event) {
    const normalized = normalizeDurableEvent(event)
    switch (normalized.kind) {
      case NORMALIZED_KIND.TURN_START:
        // Idempotent: a replayed durable `turn/start` must not discard samples.
        this.turnStartMs = Number.isFinite(this.turnStartMs) ? this.turnStartMs : normalized.timeMs
        return normalized
      case NORMALIZED_KIND.TURN_END:
        this.turnEndMs = normalized.timeMs
        this.status = normalized.status
        this.statusNote = normalized.note
        this.turnEndPayload = {
          reasonKind: normalized.reasonKind,
          statusKnown: normalized.statusKnown,
          rawReason: normalized.rawReason,
        }
        return normalized
      case NORMALIZED_KIND.STEP_START:
        this.steps.set(normalized.step, { step: normalized.step, startMs: normalized.timeMs, endMs: null })
        return normalized
      case NORMALIZED_KIND.STEP_END: {
        const step = this.steps.get(normalized.step) ?? { step: normalized.step, startMs: null, endMs: null }
        step.endMs = normalized.timeMs
        this.steps.set(normalized.step, step)
        return normalized
      }
      case NORMALIZED_KIND.ATTEMPT_SETTLE: {
        // A durable settlement carries no `attemptId`: DSH's attempt identity is
        // process-local and never enters the durable log. Path A therefore takes
        // a settlement's usage and status from `settlements` (see
        // `acceptSettlementIdentity`) and treats the durable settlement event
        // itself as a boundary only. Creating an attempt here would invent an
        // identity the evidence does not contain.
        return normalized
      }
      case NORMALIZED_KIND.RETRY_SCHEDULED:
        this.retries.push(normalized)
        this.correlateRetries()
        return normalized
      case NORMALIZED_KIND.TOOL_CALL: {
        if (normalized.callId === null) {
          this.issue('tool-call-without-call-id', { seq: normalized.seq })
          return normalized
        }
        const record = this.tools.get(normalized.callId) ?? {
          callId: normalized.callId,
          name: normalized.name,
          startMs: normalized.timeMs,
          endMs: undefined,
          status: 'running',
          parentCallId: undefined,
        }
        record.startMs = Math.min(record.startMs, normalized.timeMs)
        if (normalized.name !== null) record.name = normalized.name
        this.tools.set(normalized.callId, record)
        if (!this.toolOrder.includes(normalized.callId)) this.toolOrder.push(normalized.callId)
        return normalized
      }
      case NORMALIZED_KIND.TOOL_RESULT: {
        if (normalized.callId === null) {
          this.issue('tool-result-without-call-id', { seq: normalized.seq })
          return normalized
        }
        const record = this.tools.get(normalized.callId)
        if (record === undefined) {
          this.issue('unmatched-tool-result', { callId: normalized.callId, seq: normalized.seq })
          return normalized
        }
        record.endMs = normalized.timeMs
        record.status = normalized.status
        return normalized
      }
      default:
        this.ignoredEvents += 1
        return normalized
    }
  }

  /**
   * Fold a durable settlement's *identity and usage* into the live attempts.
   *
   * A settlement arriving through the durable plane is how the client learns an
   * attempt is over. It is not a source of deltas here: path A must not read the
   * compact stream, or the two paths would stop being independent.
   *
   * The three settlement concepts are passed explicitly when the caller has
   * them; otherwise they are re-derived from the settlement event type and the
   * `interrupted` marker, exactly as the durable path derives them.
   */
  acceptSettlementIdentity({
    attemptId,
    turn,
    step,
    usage,
    usageSource,
    settlementKind,
    surfaceCommitted,
    attemptOutcome,
    interrupted,
    settledAtMs,
    seq,
    eventType,
  }) {
    const attempt = this.attempt(attemptId)
    attempt.turn = turn ?? attempt.turn
    attempt.step = step ?? attempt.step
    attempt.settledAtMs = settledAtMs ?? attempt.settledAtMs
    attempt.settlementSeq = seq ?? attempt.settlementSeq
    attempt.settlementEventType = eventType ?? attempt.settlementEventType
    attempt.interrupted = interrupted === true
    const derived = settlementClassification(attempt.settlementEventType, { interrupted: attempt.interrupted })
    attempt.settlementKind = settlementKind ?? derived.settlementKind
    attempt.surfaceCommitted = surfaceCommitted ?? derived.surfaceCommitted
    attempt.attemptOutcome = attemptOutcome ?? derived.attemptOutcome
    if (usage !== null && usage !== undefined) {
      attempt.usage = usage
      attempt.usageSource = usageSource ?? attempt.usageSource
    }
    this.openAttemptIds.delete(attemptId)
    // A retry may have been seen before the settlement identity linked up
    // (batch replay processes durable events first); re-run the correlation.
    this.correlateRetries()
    return attempt
  }

  /**
   * Apply scheduled durable retries to the attempts they prove. Idempotent;
   * called again whenever a retry or a settlement identity lands.
   */
  correlateRetries() {
    if (this.retries.length === 0) return 0
    return applyRetryOutcomes(this.attemptList().filter(Boolean), this.retries)
  }

  /** Attempts in the order their first frame arrived. */
  attemptList() {
    return this.attemptOrder.map(attemptId => this.attempts.get(attemptId))
  }

  toolList() {
    return this.toolOrder.map(callId => this.tools.get(callId))
  }

  /** Whether the live plane is complete enough to be called exact. */
  liveQuality() {
    if (this.issues.length > 0) return MetricQuality.ESTIMATED
    if (this.attemptList().length === 0) return MetricQuality.UNAVAILABLE
    return MetricQuality.ESTIMATED
  }
}

/**
 * Path A entry point: replay a recorded transient plane plus the durable
 * boundaries, and return the normalized attempts and tools.
 *
 * `settlements` carries only identity and usage, never streams — see
 * `acceptSettlementIdentity`.
 */
export function accumulateLive({
  sessionId,
  frames = [],
  liveChunks = [],
  durableEvents = [],
  settlements = [],
  estimate = heuristicTokenWeight,
}) {
  const accumulator = new LiveTurnAccumulator({ sessionId, estimate })
  for (const event of durableEvents) accumulator.acceptDurableEvent(event)
  for (const frame of frames) accumulator.acceptStreamFrame(frame)
  for (const row of liveChunks) accumulator.acceptLiveChunk(row)
  for (const settlement of settlements) accumulator.acceptSettlementIdentity(settlement)
  // Batch replay processes durable events before settlement identities exist;
  // a retry seen in that order could not yet be correlated. Re-run now that
  // every identity has been folded in.
  accumulator.correlateRetries()
  return accumulator
}

export { settlementClassification }
