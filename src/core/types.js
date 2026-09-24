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

export {}
