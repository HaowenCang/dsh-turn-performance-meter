/**
 * Normalized domain types.
 *
 * These are this project's own records, deliberately independent of DSH wire
 * shapes so that `src/core` stays testable without a DSH runtime. The adapter
 * layer is responsible for translating verified DSH evidence into them; the
 * evidence locations are recorded in docs/IMPLEMENTATION_LOG.md.
 *
 * @typedef {'reasoning'|'output'} TokenPhase
 * @typedef {'exact'|'calibrated'|'estimated'|'unavailable'} MetricQualityValue
 * @typedef {'completed'|'interrupted'|'errored'} TurnStatus
 *
 * @typedef {Object} DeltaSample
 * @property {number} timeMs Wall-clock event timestamp (DSH `AssistantLiveChunkEvent.time`
 *   or a timestamp reconstructed from an `AssistantStreamRecord` run).
 * @property {TokenPhase} phase Which phase this delta's tokens belong to.
 * @property {number} weight Live token-shape estimate; never a provider count.
 * @property {number} [tokens] Calibrated allocation. Equal to `weight` until calibration.
 * @property {MetricQualityValue} [quality]
 * @property {number} [activeTimeMs] Compressed chart-clock coordinate (set by `compressAttempts`).
 * @property {string} [attemptId] Set by `compressAttempts` so a curve segment is attributable.
 *
 * @typedef {Object} NormalizedUsage
 * @property {number} outputTokens Provider output total, reasoning included.
 * @property {number|null} reasoningTokens `null` when the provider did not report it.
 * @property {number|null} nonReasoningTokens `outputTokens - reasoningTokens`, never a sum.
 *
 * @typedef {Object} AttemptRecord
 * @property {string} attemptId DSH `LlmAttemptId` for one streaming attempt.
 * @property {number} turn
 * @property {number} step
 * @property {DeltaSample[]} samples Generated deltas only.
 * @property {TemporalEvidenceAuthority} temporalEvidenceAuthority Where this
 *   attempt's `samples`/`phaseCuts` came from. See the enum below; it is the
 *   only field the settled temporal-shape gate may read.
 * @property {NormalizedUsage} [usage] From `assistant/message.usage` or an in-stream usage chunk.
 * @property {'message'|'attempt'|'none'} [settlementKind] Concept 1: which durable
 *   surface settled the attempt. `message` = `assistant/message`;
 *   `attempt` = `assistant/attempt` (durable settlement **without** a surface
 *   message — not an abandonment); `none` = no durable settlement observed.
 * @property {boolean} [surfaceCommitted] Concept 3: whether a model-visible
 *   assistant message exists for this attempt.
 * @property {'committed'|'interrupted'|'failed'|'retried'|'cancelled'|'stream-error'|'abandoned'|'unknown'} [attemptOutcome]
 *   Concept 2: the execution outcome. `abandoned` comes only from a transient
 *   `end` frame with `outcome.kind === 'abandoned'` (no durable settlement).
 *   When the durable evidence cannot prove a cause the value is `unknown`.
 * @property {number} [startedAtMs]
 * @property {number} [settledAtMs]
 *
 * @typedef {Object} ToolCallRecord
 * @property {string} callId DSH `ToolCallId`, the `tool/call` -> `tool/result` pair key.
 * @property {string} name
 * @property {number} startMs `tool/call` event time.
 * @property {number} [endMs] `tool/result` event time. Absent while running.
 * @property {'running'|'ok'|'error'|'cancelled'} status
 * @property {string} [parentCallId] When DSH exposes nested calls.
 *
 * @typedef {Object} TurnRecord
 * @property {string} sessionId State is always keyed by session as well as turn:
 *   two sessions can be active at once and must never share a live window.
 * @property {number} turn
 * @property {number} startMs `turn/start` event time.
 * @property {number} [endMs] `turn/end` event time.
 * @property {number} [firstTokenMs] First non-empty reasoning/text/tool-argument delta, turn-wide.
 * @property {TurnStatus} [status]
 * @property {AttemptRecord[]} attempts
 * @property {ToolCallRecord[]} tools
 */

/** Stable key for `(sessionId, turn)` isolation. */
export function turnKey(sessionId, turn) {
  return `${String(sessionId)}::${String(turn)}`
}

/**
 * Where one attempt's temporal sample stream actually comes from.
 *
 * Three facts are distinct and none of them implies another:
 *
 *   1. a durable settlement was observed for the attempt (`attempt.settlementSeq`);
 *   2. the settlement's embedded compact stream decoded completely
 *      (`decoded.complete === true`);
 *   3. that complete decode was **adopted** as the attempt's temporal evidence
 *      (its `samples`/`phaseCuts` *are* one decode of it).
 *
 * `settlementSeq` proves only (1). A settlement whose decode lost a record is
 * refused by the reconciliation, so the attempt keeps the transient samples its
 * window happened to see — evidence that is real but partial — and the settled
 * card must not describe that timeline as a reconstruction of the durable
 * stream. This field is the answer to (3), recorded where the decision is made
 * instead of being inferred later from incidental fields.
 *
 * The values are the three reachable states, and the field is never defaulted to
 * the strongest one: an unknown value is treated as `live`, so a construction
 * path that forgets to declare its source can only ever *understate* authority.
 *
 * @typedef {'live'|'durable-incomplete'|'durable-complete'} TemporalEvidenceAuthority
 */
export const TEMPORAL_EVIDENCE_AUTHORITY = Object.freeze({
  /**
   * The samples are the transient plane's own observation. This is a real
   * measurement — the live timestamps are the same envelope instants — but the
   * live pane can be re-baselined or lose frames, so it cannot support a
   * `reconstructed` shape claim. A settlement whose decode was refused leaves the
   * attempt here: nothing replaced its samples.
   */
  LIVE: 'live',
  /**
   * The samples are one decode of a durable stream, and that decode is known to
   * be **incomplete** (`decoded.complete !== true`). The attempt's evidence is
   * durable-derived but partial, so it is not authoritative either.
   */
  DURABLE_INCOMPLETE: 'durable-incomplete',
  /**
   * The samples are one **complete, authoritative** decode of the durable
   * stream. This is the only value that may support `temporalShapeQuality:
   * reconstructed` (`docs/METRICS_SPEC.md` §11).
   */
  DURABLE_COMPLETE: 'durable-complete',
})

/**
 * Strength ordering of the three authorities, weakest first.
 *
 * A claim about where evidence came from can be **raised** when better evidence
 * replaces the samples and can never be withdrawn afterwards, because nothing
 * removes a sample once it is recorded. Unknown or absent means `live`.
 */
export const TEMPORAL_EVIDENCE_RANK = Object.freeze({
  [TEMPORAL_EVIDENCE_AUTHORITY.LIVE]: 0,
  [TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_INCOMPLETE]: 1,
  [TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE]: 2,
})

/**
 * Whether one attempt's temporal sample stream is backed by a complete
 * authoritative durable decode.
 *
 * This is the single predicate the settled temporal-shape gate is allowed to
 * use. Anything other than the explicit `durable-complete` value — including a
 * missing field, `null`, an unknown string, or an attempt object built by a
 * path this project does not know about — answers `false`.
 *
 * @param {{temporalEvidenceAuthority?: string}|null|undefined} attempt
 * @returns {boolean}
 */
export function hasDurableTemporalAuthority(attempt) {
  return attempt?.temporalEvidenceAuthority === TEMPORAL_EVIDENCE_AUTHORITY.DURABLE_COMPLETE
}

export {}
