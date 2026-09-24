/**
 * Raw DSH evidence discriminants.
 *
 * These predicates are the *only* place that inspects the DSH wire shape of an
 * incoming record. Everything downstream consumes normalized events.
 *
 * Verified shapes (DSH 0.1.5-rc.2, see docs/IMPLEMENTATION_LOG.md):
 *   SessionEvent                 dsh-session/lib/types/types.d.ts:460-479
 *   SessionEventLikeEntry        dsh-api-session-controller/lib/types/client/contract/events.d.ts:20-26
 *   AssistantLiveChunkEvent      …/events.d.ts:6-16
 *   AssistantStreamFrame         dsh-agent/lib/types/runtime-types.d.ts:100-137
 */

/** Which of the two evidence planes one raw entry belongs to. */
export const DSH_RAW_KIND = Object.freeze({
  /** A durable `SessionEvent` envelope. */
  DURABLE: 'durable',
  /** A client-folded `assistant/live-chunk` transient row. */
  TRANSIENT: 'transient',
  /** A host-published `agent/assistant-stream` frame. */
  STREAM_FRAME: 'stream-frame',
  /** None of the above. */
  UNKNOWN: 'unknown',
})

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A durable session envelope: `{type, seq, time, data}` with a non-empty string type. */
export function isDurableSessionEventEntry(entry) {
  if (!isObject(entry)) return false
  // Wrapped form: `{ type: 'event', event }`.
  if (entry.type === 'event') return isDurableSessionEventEntry(entry.event)
  if (typeof entry.type !== 'string' || entry.type === '') return false
  if (!Number.isFinite(entry.seq)) return false
  if (!Number.isFinite(entry.time)) return false
  return isObject(entry.data)
}

/** A client-folded transient row: `{type:'assistant/live-chunk', seq, time, data:{attemptId, chunk}}`. */
export function isTransientLiveChunkEntry(entry) {
  if (!isObject(entry)) return false
  if (entry.type === 'transient') return isTransientLiveChunkEntry(entry.event)
  if (entry.type !== 'assistant/live-chunk') return false
  return isObject(entry.data) && typeof entry.data.attemptId === 'string'
}

/** A host-published assistant-stream frame. */
export function isAssistantStreamFrame(value) {
  if (!isObject(value)) return false
  if (value.type !== 'start' && value.type !== 'chunk' && value.type !== 'end') return false
  return typeof value.attemptId === 'string'
}

/** Classify one raw entry without interpreting it. */
export function classifyRawEntry(entry) {
  if (isAssistantStreamFrame(entry)) return DSH_RAW_KIND.STREAM_FRAME
  if (isTransientLiveChunkEntry(entry)) return DSH_RAW_KIND.TRANSIENT
  if (isDurableSessionEventEntry(entry)) return DSH_RAW_KIND.DURABLE
  return DSH_RAW_KIND.UNKNOWN
}

/**
 * Identity of the session a raw entry belongs to, or `null`.
 *
 * The durable plane carries the session outside the envelope (the listener's
 * `session` argument), so callers pass the session explicitly when they have it
 * and fall back to this reader for wrapped fixture forms.
 */
export function sessionKeyOf(entry) {
  if (!isObject(entry)) return null
  if (typeof entry.sessionId === 'string' && entry.sessionId !== '') return entry.sessionId
  if (isObject(entry.session) && entry.session.id !== undefined) return String(entry.session.id)
  return null
}
