/**
 * DSH rc.2 raw evidence -> normalized engine events.
 *
 * This is the only module in the project that reads a DSH field name. Its
 * contract is deliberately narrow and total: given the durable events of one
 * session and the transient frames of one session, produce the normalized
 * `TurnRecord`/`AttemptRecord`/`ToolCallRecord` values that `src/core` consumes,
 * plus an explicit list of everything that had to be degraded on the way.
 *
 * Field mapping (raw -> normalized), with the local evidence for each shape:
 *
 * | DSH raw                                                    | normalized                                  |
 * |------------------------------------------------------------|---------------------------------------------|
 * | `SessionEvent<'turn/start'>.time`                          | `TurnRecord.startMs`                        |
 * | `SessionEvent<'turn/end'>.time`                            | `TurnRecord.endMs`                          |
 * | `SessionEvent<'turn/end'>.data.reason`                     | `TurnRecord.status` (+ `endReason`)         |
 * | `SessionEvent<'assistant/message'>{turn,step,stream,usage}`| one `AttemptRecord` (surface settlement)    |
 * | `SessionEvent<'assistant/attempt'>{turn,step,stream}`      | one `AttemptRecord` (durable non-surface settlement — **not** an abandonment) |
 * | `SessionEvent<'llm/retry'>`                                | `RETRY_SCHEDULED` (correlates `retried`)    |
 * | `AssistantStreamRecord.text-chunks`                        | `text-delta` samples (output phase)         |
 * | `AssistantStreamRecord.reasoning-chunks`                   | `reasoning-delta` samples (reasoning phase) |
 * | `AssistantStreamRecord.tool-call-chunks`                   | `tool-call-delta` samples (output phase)    |
 * | `AssistantStreamRecord.chunk`                              | block/usage/finish; no token sample         |
 * | `StreamChunk.usage.usage` (in-stream)                      | `AttemptRecord.usage` fallback              |
 * | `assistant/message.usage`                                  | `AttemptRecord.usage` (authoritative)       |
 * | `SessionEvent<'tool/call'>{callId,name,arguments}.time`    | `ToolCallRecord.startMs`                    |
 * | `SessionEvent<'tool/result'>.time`                         | `ToolCallRecord.endMs` + status             |
 * | `AssistantLiveChunkEvent.time`                             | `DeltaSample.timeMs` (live path)            |
 * | `AssistantLiveChunkEvent.data.attemptId`                   | `DeltaSample.attemptId` / attempt identity  |
 * | `AssistantStreamFrame{start,chunk,end}`                    | the same, before the client fold            |
 *
 * Nothing here computes statistics. Every number this module produces is a
 * measured boundary copied from an event envelope, or a token-shape weight
 * obtained from `src/core/token-allocation.js`.
 */

import {
  classifyDelta,
  deltaText,
  isTokenDelta,
  usageFromChunk,
} from '../core/delta-accounting.js'
import { MetricQuality, weakestQuality } from '../core/metric-quality.js'
import { heuristicTokenWeight, sampleFromChunk } from '../core/token-allocation.js'
import { decodeStreamRecords, SETTLEMENT_EVENT_TYPES } from './stream-decoder.js'

/** Normalized event kinds emitted by the mapping step. */
export const NORMALIZED_KIND = Object.freeze({
  TURN_START: 'turn-start',
  TURN_END: 'turn-end',
  STEP_START: 'step-start',
  STEP_END: 'step-end',
  ATTEMPT_START: 'attempt-start',
  ATTEMPT_DELTA: 'attempt-delta',
  ATTEMPT_SETTLE: 'attempt-settle',
  ATTEMPT_ABANDON: 'attempt-abandon',
  RETRY_SCHEDULED: 'retry-scheduled',
  TOOL_CALL: 'tool-call',
  TOOL_RESULT: 'tool-result',
  IGNORED: 'ignored',
})

/**
 * Which durable surface settled one attempt (settlement type — concept 1).
 *
 * Verified against `dsh-session/lib/types/types.d.ts:309-327` in the local
 * `0.1.5-rc.2` install:
 *
 *   `assistant/message` — an assembled assistant message on the model-visible
 *     surface; a turn cancelled mid-stream finalizes its delivered prefix as
 *     this event with `interrupted: true`.
 *   `assistant/attempt` — "one model attempt that committed no surface
 *     message. The embedded stream preserves a failed, retried, cancelled, or
 *     stream-error attempt that reached **settlement** without fabricating
 *     model-visible history."
 *
 * `NONE` means no durable settlement exists — either the attempt is still
 * open or it was transiently abandoned (`AssistantStreamFrame.end.outcome.kind
 * === 'abandoned'`, documented as "live abandonment without one [durable
 * settlement]", `dsh-agent/lib/types/runtime-types.d.ts:129-136`).
 */
export const SETTLEMENT_KIND = Object.freeze({
  MESSAGE: 'message',
  ATTEMPT: 'attempt',
  NONE: 'none',
})

/**
 * Execution outcome of one attempt (concept 2), strictly separated from the
 * settlement type and from surface visibility (concept 3).
 *
 * Only `committed`, `interrupted` and `abandoned` are directly readable from
 * rc.2 evidence. `failed`/`retried`/`cancelled`/`stream-error` are named by
 * the `assistant/attempt` doc comment as *possible* causes, but the durable
 * payload carries no cause field: `retried` is the single member derivable by
 * correlation (a later `llm/retry` event names the same turn/step —
 * `dsh-llm-retry` invariant code pairs them), and everything else stays
 * `unknown` rather than being guessed.
 */
export const ATTEMPT_OUTCOME = Object.freeze({
  COMMITTED: 'committed',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
  RETRIED: 'retried',
  CANCELLED: 'cancelled',
  STREAM_ERROR: 'stream-error',
  ABANDONED: 'abandoned',
  UNKNOWN: 'unknown',
})

/**
 * Classify one durable settlement into the three independent concepts.
 *
 * `assistant/attempt` is deliberately **not** mapped to `abandoned`: it is a
 * durable settlement (surface visibility lost, settlement preserved), while
 * abandonment is the transient condition of having no durable settlement at
 * all. When the cause of a non-surface settlement cannot be derived from
 * durable evidence the outcome is `unknown`.
 *
 * @param {string} eventType `assistant/message` | `assistant/attempt`
 * @param {{interrupted?: boolean}} [data] settlement payload
 * @returns {{settlementKind: string, surfaceCommitted: boolean, attemptOutcome: string}}
 */
export function settlementClassification(eventType, data = {}) {
  const surfaceCommitted = eventType === 'assistant/message'
  const settlementKind = surfaceCommitted
    ? SETTLEMENT_KIND.MESSAGE
    : eventType === 'assistant/attempt' ? SETTLEMENT_KIND.ATTEMPT : SETTLEMENT_KIND.NONE
  let attemptOutcome = ATTEMPT_OUTCOME.UNKNOWN
  if (data?.interrupted === true) attemptOutcome = ATTEMPT_OUTCOME.INTERRUPTED
  else if (surfaceCommitted) attemptOutcome = ATTEMPT_OUTCOME.COMMITTED
  return { settlementKind, surfaceCommitted, attemptOutcome }
}

/**
 * Classify a transient `end` frame outcome.
 *
 * `kind: 'abandoned'` is the **only** evidence for `ATTEMPT_OUTCOME.ABANDONED`:
 * a live stream that ended without any durable settlement.
 */
export function transientEndClassification(outcome) {
  if (outcome?.kind === 'committed') return settlementClassification(outcome.eventType, {})
  if (outcome?.kind === 'abandoned') {
    return {
      settlementKind: SETTLEMENT_KIND.NONE,
      surfaceCommitted: false,
      attemptOutcome: ATTEMPT_OUTCOME.ABANDONED,
    }
  }
  return {
    settlementKind: SETTLEMENT_KIND.NONE,
    surfaceCommitted: false,
    attemptOutcome: ATTEMPT_OUTCOME.UNKNOWN,
  }
}

const STATUS_BY_TURN_END = Object.freeze({
  completed: 'completed',
  'max-tokens': 'completed',
  aborted: 'interrupted',
  interrupted: 'interrupted',
  blocked: 'errored',
  error: 'errored',
})

/**
 * Map one durable `turn/end` reason to the card status, per the mapping table
 * frozen in `docs/IMPLEMENTATION_LOG.md`.
 *
 * An unknown future reason kind must not be reported as a known cause: it maps
 * to `errored` with `known: false`, and the caller surfaces the raw reason.
 */
export function turnEndStatus(reason) {
  const kind = reason && typeof reason === 'object' ? reason.kind : undefined
  if (typeof kind !== 'string') return { status: 'errored', known: false, note: 'turn/end carried no reason kind' }
  const status = STATUS_BY_TURN_END[kind]
  if (status === undefined) return { status: 'errored', known: false, note: `unrecognized turn/end reason "${kind}"` }
  if (kind === 'max-tokens') {
    return { status, known: true, note: 'output-token ceiling reached; generation is truncated' }
  }
  if (kind === 'aborted') {
    const cause = reason.reason?.kind ?? 'unknown'
    return { status, known: true, note: `cancelled (${cause})` }
  }
  if (kind === 'interrupted') {
    return { status, known: true, note: 'turn was closed after a crash' }
  }
  return { status, known: true, note: null }
}

/** Timestamps on a `tool/result` payload do not exist; the envelope carries them. */
function toolResultOutcome(data) {
  const block = Array.isArray(data?.message?.content) ? data.message.content[0] : undefined
  if (data?.error !== undefined || block?.isError === true) return 'error'
  return 'ok'
}

/** Read the usage carrier from a settlement, preferring the durable one. */
function settlementUsage(data, decoded) {
  const durable = data?.usage
  if (durable && typeof durable === 'object' && Number.isFinite(durable.outputTokens)) {
    return { usage: durable, source: 'assistant-settlement' }
  }
  for (let index = decoded.chunks.length - 1; index >= 0; index -= 1) {
    const usage = usageFromChunk(decoded.chunks[index].chunk)
    if (usage !== null) return { usage, source: 'in-stream-usage-chunk' }
  }
  return { usage: null, source: null }
}

/**
 * Turn one durable session event into zero or more normalized events.
 *
 * The returned values are the adapter's stable vocabulary; a caller that has to
 * branch on a raw DSH event type is a caller that should be reading
 * `NORMALIZED_KIND` instead.
 */
export function normalizeDurableEvent(event) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
    return { kind: NORMALIZED_KIND.IGNORED, reason: 'not a session event' }
  }
  const data = event.data ?? {}
  const common = { seq: event.seq, timeMs: event.time }
  switch (event.type) {
    case 'turn/start':
      return { kind: NORMALIZED_KIND.TURN_START, ...common, turn: data.turn }
    case 'turn/end': {
      const mapped = turnEndStatus(data.reason)
      return {
        kind: NORMALIZED_KIND.TURN_END,
        ...common,
        turn: data.turn,
        status: mapped.status,
        reasonKind: data.reason?.kind ?? null,
        statusKnown: mapped.known,
        note: mapped.note,
        rawReason: data.reason ?? null,
      }
    }
    case 'step/start':
      return { kind: NORMALIZED_KIND.STEP_START, ...common, turn: data.turn, step: data.step }
    case 'step/end':
      return { kind: NORMALIZED_KIND.STEP_END, ...common, turn: data.turn, step: data.step }
    case 'assistant/message':
    case 'assistant/attempt': {
      const decoded = decodeStreamRecords(data.stream)
      const { usage, source } = settlementUsage(data, decoded)
      const issues = decoded.issues.map(issue => ({ ...issue, where: 'durable-stream' }))
      return {
        kind: NORMALIZED_KIND.ATTEMPT_SETTLE,
        ...common,
        turn: data.turn,
        step: data.step,
        eventType: event.type,
        ...settlementClassification(event.type, data),
        interrupted: data.interrupted === true,
        decoded,
        usage,
        usageSource: source,
        issues,
        quality: decoded.quality,
      }
    }
    case 'llm/retry':
      /**
       * A scheduled durable retry (`dsh-llm-retry`): non-surface, appended
       * after the failed step's `assistant/attempt` settled, naming the same
       * turn/step. It is the one retry fact derivable from the durable log and
       * the only way an `assistant/attempt` outcome becomes knowable.
       */
      return {
        kind: NORMALIZED_KIND.RETRY_SCHEDULED,
        ...common,
        turn: data.turn,
        step: data.step,
        retryId: typeof data.retryId === 'string' ? data.retryId : null,
        retry: Number.isFinite(data.retry) ? data.retry : null,
      }
    case 'tool/call':
      return {
        kind: NORMALIZED_KIND.TOOL_CALL,
        ...common,
        turn: data.turn,
        step: data.step,
        callId: typeof data.callId === 'string' ? data.callId : null,
        name: typeof data.name === 'string' ? data.name : null,
        /**
         * The raw argument JSON exactly as the model produced it. It is kept for
         * evidence and for argument-length accounting; it is **not** a token
         * count and is never used as one.
         */
        argumentsRaw: typeof data.arguments === 'string' ? data.arguments : null,
      }
    case 'tool/result':
      return {
        kind: NORMALIZED_KIND.TOOL_RESULT,
        ...common,
        turn: data.turn,
        step: data.step,
        callId: Array.isArray(data.message?.content) ? data.message.content[0]?.toolCallId ?? null : null,
        status: toolResultOutcome(data),
        errorName: data.error?.name ?? null,
      }
    default:
      return { kind: NORMALIZED_KIND.IGNORED, reason: event.type, ...common }
  }
}

/**
 * Normalize one client-folded transient row (`assistant/live-chunk`).
 *
 * The client fold is what a browser actually sees, so this is the shape the
 * live path must consume. `time` sits on the row, not on `data`.
 */
export function normalizeLiveChunk(entry) {
  const row = entry?.type === 'transient' ? entry.event : entry
  const data = row?.data
  if (row?.type !== 'assistant/live-chunk' || !data || typeof data.attemptId !== 'string') {
    return { kind: NORMALIZED_KIND.IGNORED, reason: 'not a live chunk' }
  }
  return {
    kind: NORMALIZED_KIND.ATTEMPT_DELTA,
    timeMs: row.time,
    seq: row.seq,
    attemptId: data.attemptId,
    turn: data.turn,
    step: data.step,
    chunk: data.chunk,
    phase: classifyDelta(data.chunk),
    text: deltaText(data.chunk),
    countsAsToken: isTokenDelta(data.chunk),
  }
}

/**
 * Normalize one host `agent/assistant-stream` frame.
 *
 * The host frame is the earliest form of the same evidence: it carries
 * `attemptId`, `revision`, `index`, `time` and the chunk, and it is what the
 * client fold later turns into `assistant/live-chunk`. A `start` frame is the
 * only source of an attempt's `(turn, step)` before its first durable fact.
 */
export function normalizeStreamFrame(frame) {
  if (frame === null || typeof frame !== 'object' || typeof frame.attemptId !== 'string') {
    return { kind: NORMALIZED_KIND.IGNORED, reason: 'not a stream frame' }
  }
  if (frame.type === 'start') {
    return {
      kind: NORMALIZED_KIND.ATTEMPT_START,
      attemptId: frame.attemptId,
      revision: frame.revision,
      turn: frame.turn,
      step: frame.step,
      startedAfterSeq: frame.startedAfterSeq ?? null,
    }
  }
  if (frame.type === 'chunk') {
    return {
      kind: NORMALIZED_KIND.ATTEMPT_DELTA,
      timeMs: frame.time,
      attemptId: frame.attemptId,
      revision: frame.revision,
      index: frame.index,
      chunk: frame.chunk,
      phase: classifyDelta(frame.chunk),
      text: deltaText(frame.chunk),
      countsAsToken: isTokenDelta(frame.chunk),
    }
  }
  if (frame.type === 'end') {
    const outcome = frame.outcome ?? {}
    return {
      kind: outcome.kind === 'abandoned' ? NORMALIZED_KIND.ATTEMPT_ABANDON : NORMALIZED_KIND.ATTEMPT_SETTLE,
      attemptId: frame.attemptId,
      revision: frame.revision,
      index: frame.index,
      outcomeKind: outcome.kind ?? null,
      settlementEventType: outcome.eventType ?? null,
      settlementSeq: Number.isFinite(outcome.seq) ? outcome.seq : null,
      ...transientEndClassification(outcome),
    }
  }
  return { kind: NORMALIZED_KIND.IGNORED, reason: `unrecognized frame type ${String(frame.type)}` }
}

/**
 * Build one attempt record from decoded chunks plus its usage and identity.
 *
 * The attempt's `samples` are the generated deltas only; `chunks` keeps the
 * whole decoded stream so that block boundaries, `usage` and `finish` remain
 * available to a caller that needs them. Both come from the same decode, so the
 * sample set and the boundary set can never disagree.
 */
export function attemptFromDecoded({
  attemptId,
  turn,
  step,
  decoded,
  usage = null,
  usageSource = null,
  settlementKind = SETTLEMENT_KIND.NONE,
  surfaceCommitted = false,
  attemptOutcome = ATTEMPT_OUTCOME.UNKNOWN,
  startedAtMs = null,
  settledAtMs = null,
  settlementSeq = null,
  settlementEventType = null,
  interrupted = false,
  issues = [],
  estimate = heuristicTokenWeight,
}) {
  const samples = []
  for (const entry of decoded.chunks) {
    const sample = sampleFromChunk(entry.timeMs, entry.chunk, estimate)
    if (sample !== null) samples.push(sample)
  }
  return {
    attemptId: attemptId ?? null,
    turn: turn ?? null,
    step: step ?? null,
    settlementKind,
    surfaceCommitted,
    attemptOutcome,
    samples,
    chunks: decoded.chunks,
    decoded,
    usage,
    usageSource,
    startedAtMs,
    settledAtMs,
    settlementSeq,
    settlementEventType,
    interrupted,
    issues,
    /** Quality of the decoded stream itself, before any provider anchoring. */
    streamQuality: decoded.quality,
  }
}

/** Weakest quality over an attempt's stream decode and its usage availability. */
export function attemptEvidenceQuality(attempt) {
  const usageQuality = attempt?.usage === null || attempt?.usage === undefined
    ? MetricQuality.UNAVAILABLE
    : MetricQuality.EXACT
  const streamQuality = attempt?.decoded?.quality ?? MetricQuality.UNAVAILABLE
  return weakestQuality(streamQuality, usageQuality)
}

export { SETTLEMENT_EVENT_TYPES }

/**
 * Upgrade `assistant/attempt` outcomes that a durable `llm/retry` proves.
 *
 * Both correlation requirements come from `dsh-llm-retry`'s own invariant
 * checker: the retry names the same turn and step as the failed request, and
 * it is appended *after* that attempt settled. The most recent still-unknown
 * non-surface settlement preceding the retry inside the same step is therefore
 * the retried attempt. Attempts the correlation cannot prove keep `unknown`.
 *
 * Mutates the supplied attempt records in place and is idempotent: an outcome
 * already derived (or a retry already applied by sequence) is never rewritten.
 *
 * @param {readonly object[]} attempts attempt-likes carrying
 *   `{turn, step, settlementKind, settlementSeq, attemptOutcome}`
 * @param {readonly object[]} retries normalized `RETRY_SCHEDULED` events
 * @returns {number} how many attempts were upgraded to `retried`
 */
export function applyRetryOutcomes(attempts, retries) {
  if (!Array.isArray(attempts) || !Array.isArray(retries)) return 0
  let upgraded = 0
  const ordered = [...retries]
    .filter(retry => retry && Number.isFinite(retry.seq))
    .sort((a, b) => a.seq - b.seq)
  for (const retry of ordered) {
    let candidate = null
    for (const attempt of attempts) {
      if (attempt.settlementKind !== SETTLEMENT_KIND.ATTEMPT) continue
      if (attempt.attemptOutcome !== ATTEMPT_OUTCOME.UNKNOWN) continue
      if (!Number.isFinite(attempt.settlementSeq) || attempt.settlementSeq >= retry.seq) continue
      if (attempt.turn !== retry.turn || attempt.step !== retry.step) continue
      if (candidate === null || attempt.settlementSeq > candidate.settlementSeq) candidate = attempt
    }
    if (candidate !== null) {
      candidate.attemptOutcome = ATTEMPT_OUTCOME.RETRIED
      upgraded += 1
    }
  }
  return upgraded
}
