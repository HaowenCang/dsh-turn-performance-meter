/**
 * Durable reconstruction -> materialized `TurnTelemetryStore` turn record.
 *
 * This is the bridge Phase 7D.1 adds. It exists for exactly one situation, and it
 * is worth stating which one, because the module is otherwise easy to mistake for a
 * second reconstruction path:
 *
 *   The published window is a live **tail**. A client that attached after a turn
 *   began — a fresh page on a running session, a reload whose tail has slid past
 *   the opening row, a reconnect — can receive the turn's authoritative `turn/end`
 *   while holding no record for it, because nothing in the window ever opened the
 *   turn. The durable facts of that turn are nevertheless in the same window: the
 *   `assistant/message` settlements with their embedded compact streams, the
 *   `tool/call` and `tool/result` boundaries, the step boundaries, the retries.
 *
 * Phase 7D closed the *lifecycle* half of that case: the boundary was no longer
 * dropped, and a completed card appeared. It opened an **empty** record
 * (`beginTurn` immediately followed by `endTurn`), so the card closed with zero
 * attempts, zero tokens and no tools while the evidence for all of them sat in the
 * window it had just read. This module closes the metric half.
 *
 * ## What it does, and what it deliberately does not
 *
 * Every durable fact comes from `reconstructFromDurable` (`durable-path.js`), which
 * remains the project's only durable parser. This module performs no decoding, no
 * tool pairing, no retry correlation and no settlement classification of its own: it
 * calls that pipeline and routes its output into the store through the store's own
 * methods — the same `beginAttempt` / `acceptChunk` / `setAttemptUsage` /
 * `settleAttempt` / `toolStarted` / `toolSettled` sequence the live path uses, so
 * the recovered record is indistinguishable from a record the live path built, and
 * therefore enters `aggregateTurn` -> `calibration` -> `curveSource` ->
 * `attemptTraces` with no side channel of its own. A `tail recovery curve` would be
 * a second set of curve arithmetic, and a second set of curve arithmetic is free to
 * disagree with the printed numbers.
 *
 * ## No unavailable fact is fabricated
 *
 * Two rules, both load-bearing:
 *
 *   **The turn start is only what the tail observed.** `turnStartMs` is
 *   `reconstructFromDurable().turnStartMs`, which is `null` unless the turn's own
 *   `turn/start` row is in the evidence. The first model delta, a `step/start`, a
 *   `tool/call`, the moment this client attached and the current wall clock are all
 *   tempting substitutes and all forbidden: TTFT and turn elapsed are intervals from
 *   the start, so inventing one would print a measured-looking number for a turn
 *   whose beginning nobody saw. `null` is the correct answer, and the UI already
 *   renders it as "—".
 *
 *   **Sample timestamps are only what the settlement recorded.** Each attempt's
 *   samples are the ones `acceptChunk` derives from the settlement's own embedded
 *   compact stream, so `firstTokenMs` is the earliest *observed* generated sample.
 *   That is durable evidence and may be recovered. It is not TTFT: TTFT needs the
 *   start as well, so a recovered turn can legitimately hold a known first token
 *   beside an unavailable TTFT, and the aggregate computes it that way for free.
 */

import { reconstructFromDurable } from './durable-path.js'

/**
 * Deterministic, reconstruction-local identity for a materialized attempt.
 *
 * DSH's durable log carries no `attemptId` — the identity is process-local to the
 * client fold and never appears in a settlement — so a recovered attempt has no
 * provider identity to adopt, and inventing one would present a reconstruction-local
 * key as an external fact. The key is nonetheless needed, because the store, the
 * curve sources and the attempt traces are all keyed by it.
 *
 * It is derived from the settlement's own sequence number, so replaying the same
 * evidence always yields the same identity: a wall clock or a random UUID would make
 * two replays of one window disagree, which is precisely what durable reconstruction
 * exists to prevent.
 *
 * The `#n` suffix appears only in the impossible case of two settlements sharing one
 * sequence number, and it is still a function of the evidence rather than of time.
 *
 * @param {number|null|undefined} settlementSeq
 * @param {number} duplicateIndex how many attempts already claimed this sequence
 */
export function reconstructedAttemptId(settlementSeq, duplicateIndex = 0) {
  const base = Number.isFinite(settlementSeq) ? `settlement:${settlementSeq}` : 'settlement:unknown'
  return duplicateIndex === 0 ? base : `${base}#${duplicateIndex}`
}

/**
 * Build a `TurnTelemetryStore` turn record from a turn's durable evidence.
 *
 * The returned record is a normal store record: it carries attempts, samples,
 * usage, tool intervals, a first-token stamp and (once the caller closes it) a
 * settled snapshot computed by the ordinary pipeline. The caller owns the turn's
 * terminal boundary for the same reason the live path does — it has the
 * authoritative `turn/end` envelope — so this function deliberately does not call
 * `endTurn`.
 *
 * @param {{
 *   store: object,
 *   sessionId: string,
 *   turn: number,
 *   events: readonly object[],
 *   timeMs?: number|null,
 *   estimate?: Function,
 * }} input
 * @returns {{record: object, reconstructed: object}}
 */
export function materializeReconstructedTurn({ store, sessionId, turn, events = [], timeMs = null, estimate }) {
  const reconstructed = reconstructFromDurable({ sessionId, turn, events, ...(estimate === undefined ? {} : { estimate }) })

  /**
   * `beginTurn` is idempotent, so a record already holding evidence for this turn is
   * extended rather than discarded. On the path this module exists for there is no
   * such record — the caller reached it precisely because the lookup missed — but
   * the idempotence is what keeps the function safe to call twice.
   */
  const record = store.beginTurn({ sessionId, turn, timeMs: reconstructed.turnStartMs ?? timeMs })

  /**
   * An observed start is recorded through the one-way upgrade rather than by
   * assignment. The upgrade only ever adds authority (`turnStartObserved` refuses to
   * replace a finite start, and refuses a non-finite one), so recovery cannot
   * withdraw a boundary the live path had already measured, and the per-session
   * `LiveMeter` learns the instant for the same turn.
   */
  store.turnStartObserved(record, { timeMs: reconstructed.turnStartMs })

  const seenAttemptIds = new Set()
  const duplicates = new Map()
  for (const attempt of reconstructed.attempts) {
    const seq = attempt.settlementSeq
    const duplicateIndex = duplicates.get(seq) ?? 0
    duplicates.set(seq, duplicateIndex + 1)
    let attemptId = reconstructedAttemptId(seq, duplicateIndex)
    while (seenAttemptIds.has(attemptId)) attemptId = `${attemptId}#`
    seenAttemptIds.add(attemptId)

    const stored = store.beginAttempt(record, {
      attemptId,
      step: attempt.step ?? null,
      startedAtMs: attempt.startedAtMs ?? null,
    })

    /**
     * The samples are produced by `acceptChunk` from the settlement's own embedded
     * stream, not copied from `reconstructFromDurable`'s per-attempt sample array.
     * The two run the same rule over the same chunks and therefore agree, and routing
     * through the store is what keeps the per-session `LiveMeter` consistent with the
     * record instead of letting the two drift. A malformed stream (no chunk array)
     * contributes no samples rather than a guess.
     */
    if (Array.isArray(attempt.chunks)) {
      for (const entry of attempt.chunks) {
        store.acceptChunk(record, stored, { timeMs: entry.timeMs, chunk: entry.chunk })
      }
    }

    const usage = isUsage(attempt.usage) ? attempt.usage : null
    if (usage !== null) store.setAttemptUsage(stored, usage, attempt.usageSource ?? 'assistant-settlement')

    store.settleAttempt(stored, {
      settledAtMs: Number.isFinite(attempt.settledAtMs) ? attempt.settledAtMs : null,
      settlementKind: attempt.settlementKind ?? 'none',
      surfaceCommitted: attempt.surfaceCommitted === true,
      attemptOutcome: attempt.attemptOutcome ?? 'unknown',
      usage,
      usageSource: attempt.usageSource ?? null,
      settlementSeq: Number.isFinite(attempt.settlementSeq) ? attempt.settlementSeq : null,
    })
    stored.settlementEventType = attempt.settlementEventType ?? null
    stored.interrupted = attempt.interrupted === true
  }

  for (const tool of reconstructed.tools) {
    if (typeof tool.callId !== 'string' || !Number.isFinite(tool.startMs)) continue
    store.toolStarted(record, { callId: tool.callId, name: tool.name ?? null, timeMs: tool.startMs })
    /**
     * A call whose result is not in the evidence keeps `endMs: null` and stays
     * incomplete. Giving it the turn's end, the next call's start or the current
     * clock would turn an unobserved boundary into a measured duration.
     */
    if (Number.isFinite(tool.endMs)) {
      store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status ?? 'ok' })
    }
  }

  return { record, reconstructed }
}

function isUsage(usage) {
  return usage !== null && typeof usage === 'object' && Number.isFinite(usage.outputTokens)
}
