/**
 * Normalized telemetry store.
 *
 * This layer sits between the DSH adapter and the pure metric engine. It knows
 * nothing about DSH Context types and holds no browser resources: the adapter
 * feeds it verified events, and it produces the live snapshot and the settled
 * turn record that the UI consumes.
 *
 * Two invariants it exists to enforce:
 *
 *   1. **Isolation.** All state is keyed by `(sessionId, turn)`. There is no
 *      global "current turn", because two sessions can run at once and a
 *      background turn must never supply another session's numbers.
 *   2. **One formula site.** Durations, calibration and turn aggregation come
 *      from `src/core`; this class only routes facts into them.
 */

import { LiveMeter, LivePhase } from '../core/live-metrics.js'
import { sampleFromChunk, heuristicTokenWeight } from '../core/token-allocation.js'
import { compressAttempts } from '../core/time-axis.js'
import { rollingTpsSeries, peakTps, downsampleSeries } from '../core/curve.js'
import { aggregateTurn } from '../core/aggregate-turn.js'
import { turnKey } from '../core/types.js'

/** How many settled turns are retained per session, newest first. */
export const DEFAULT_HISTORY_LIMIT = 4

export class TurnTelemetryStore {
  /**
   * @param {{estimateTokens?:Function, historyLimit?:number, windowMs?:number, refreshMs?:number}} [options]
   */
  constructor(options = {}) {
    this.estimateTokens = options.estimateTokens ?? heuristicTokenWeight
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    /** @type {Map<string, object>} keyed by `sessionId::turn` */
    this.turns = new Map()
    /** @type {Map<string, LiveMeter>} one live meter per session, so sessions cannot share a window. */
    this.liveBySession = new Map()
  }

  /**
   * The live meter serving one session. Created on demand: the meter is
   * per-session state, and a session that is not selected still owns its own.
   */
  live(sessionId) {
    let meter = this.liveBySession.get(sessionId)
    if (meter === undefined) {
      meter = new LiveMeter({ windowMs: this.windowMs ?? 1000, refreshMs: this.refreshMs ?? 200 })
      this.liveBySession.set(sessionId, meter)
    }
    return meter
  }

  /**
   * Open a turn. Idempotent: replaying the same durable `turn/start` (reload,
   * reconnect) must not discard samples already observed for it.
   */
  beginTurn({ sessionId, turn, timeMs }) {
    const key = turnKey(sessionId, turn)
    let record = this.turns.get(key)
    if (record === undefined) {
      record = {
        sessionId,
        turn,
        startMs: timeMs,
        endMs: null,
        firstTokenMs: null,
        status: null,
        statusNote: null,
        attempts: [],
        tools: [],
        attemptIndex: new Map(),
        toolIndex: new Map(),
        settled: null,
      }
      this.turns.set(key, record)
    }
    const meter = this.live(sessionId)
    if (meter.turn !== turn) meter.turnStarted({ turn, timeMs })
    return record
  }

  /**
   * Begin an attempt. A new `attemptId` is a hard window boundary: it is exactly
   * the signal that the previous call ended, whether it committed, settled
   * without a surface message, or is being retried.
   */
  beginAttempt(record, { attemptId, step = null, startedAtMs = null }) {
    let attempt = record.attemptIndex.get(attemptId)
    if (attempt === undefined) {
      attempt = {
        attemptId,
        turn: record.turn,
        step,
        samples: [],
        usage: null,
        /** No durable settlement observed yet — an open attempt is not "abandoned". */
        settlementKind: 'none',
        surfaceCommitted: false,
        attemptOutcome: 'unknown',
        startedAtMs,
        settledAtMs: null,
      }
      record.attempts.push(attempt)
      record.attemptIndex.set(attemptId, attempt)
    }
    this.live(record.sessionId).attemptStarted({ attemptId, step, timeMs: startedAtMs })
    return attempt
  }

  /**
   * Accept one streamed chunk. Non-generated chunks (block, usage, finish) are
   * ignored by `sampleFromChunk`; a `usage` chunk additionally updates the
   * attempt's authoritative usage without becoming a sample.
   *
   * @returns {object|null} the accepted sample, or `null`
   */
  acceptChunk(record, attempt, { timeMs, chunk }) {
    if (chunk && chunk.type === 'usage' && chunk.usage) {
      attempt.usage = chunk.usage
      return null
    }
    const sample = sampleFromChunk(timeMs, chunk, this.estimateTokens)
    if (sample === null) return null
    record.firstTokenMs ??= timeMs
    attempt.samples.push(sample)
    this.live(record.sessionId).acceptSample(sample)
    return sample
  }

  /** Attach authoritative usage from a durable settlement. */
  setAttemptUsage(attempt, usage, source = 'assistant-settlement') {
    if (!usage) return
    attempt.usage = usage
    /**
     * Which carrier the counter came from. Two carriers exist — the settlement
     * and an in-stream `usage` chunk — and only one of them may be used, so the
     * provenance is kept rather than inferred later.
     */
    attempt.usageSource = source
  }

  /**
   * Record an attempt settlement.
   *
   * The three concepts travel separately and are never collapsed into one
   * `status` string: `settlementKind` is which durable surface settled the
   * attempt (`message`/`attempt`/`none`), `surfaceCommitted` says whether a
   * model-visible message exists, and `attemptOutcome` is the execution
   * outcome (`committed`/`interrupted`/`abandoned`/`retried`/`unknown`/…).
   * Defaults describe "durable non-surface settlement of unknown cause" only
   * when the caller passes `settlementKind: 'attempt'` explicitly; otherwise
   * the message-settlement defaults apply.
   */
  settleAttempt(
    attempt,
    {
      settledAtMs = null,
      settlementKind = 'message',
      surfaceCommitted = settlementKind === 'message',
      attemptOutcome = 'unknown',
      usage = null,
      usageSource = null,
      settlementSeq = null,
    } = {},
  ) {
    attempt.settledAtMs = settledAtMs
    attempt.settlementKind = settlementKind
    attempt.surfaceCommitted = surfaceCommitted === true
    attempt.attemptOutcome = attemptOutcome
    if (usage) {
      attempt.usage = usage
      if (usageSource !== null) attempt.usageSource = usageSource
    }
    /**
     * The durable sequence of the settlement that closed this attempt. Absence
     * is meaningful: an attempt still open when the turn closes has no settled
     * durable stream, so the turn's temporal shape can only be `estimated`.
     */
    if (Number.isFinite(settlementSeq)) attempt.settlementSeq = settlementSeq
  }

  toolStarted(record, { callId, name, timeMs }) {
    if (record.toolIndex.has(callId)) return record.toolIndex.get(callId)
    const call = { callId, name, startMs: timeMs, endMs: null, status: 'running' }
    record.tools.push(call)
    record.toolIndex.set(callId, call)
    this.live(record.sessionId).toolStarted({ callId, name, timeMs })
    return call
  }

  /** Pair a result with its call. An unpaired result is dropped rather than guessed. */
  toolSettled(record, { callId, timeMs, status = 'ok' }) {
    const call = record.toolIndex.get(callId)
    if (call === undefined) return null
    call.endMs = timeMs
    call.status = status
    this.live(record.sessionId).toolSettled({ callId, timeMs, status })
    return call
  }

  /**
   * Close the turn and compute the settled view. `status` comes from the verified
   * `turn/end.reason` mapping in `src/core/turn-state.js`.
   */
  endTurn(record, { timeMs, status = 'completed', statusNote = null, reason = undefined } = {}) {
    record.endMs = timeMs
    record.status = status
    record.statusNote = statusNote
    if (reason !== undefined) record.reason = reason
    this.live(record.sessionId).turnSettled({ timeMs, status })
    record.settled = this.settle(record)
    this.pruneHistory(record.sessionId)
    return record.settled
  }

  /** Compute the settled snapshot for one turn. Pure over the stored records. */
  settle(record) {
    /**
     * Whether the delta timing in hand is durable evidence rather than live
     * observation. Every attempt carries a `settlementSeq` once its durable
     * settlement has been seen, and a durable settlement's embedded stream
     * reproduces the original delta timestamps exactly — that is what makes the
     * settled temporal shape `reconstructed` instead of `estimated`. An attempt
     * still streaming when the turn closes has no settlement and degrades the
     * whole turn's timing claim, which is the honest outcome.
     */
    const durableShape = record.attempts.length > 0
      && record.attempts.every(attempt => Number.isFinite(attempt.settlementSeq))
    const timestampsComplete = record.attempts.every(attempt => (
      (attempt.samples ?? []).every(sample => Number.isFinite(sample.timeMs))
    ))

    const aggregate = aggregateTurn({
      turn: record.turn,
      sessionId: record.sessionId,
      turnStartMs: record.startMs,
      turnEndMs: record.endMs,
      firstTokenMs: record.firstTokenMs,
      attempts: record.attempts,
      tools: record.tools,
      status: record.status ?? 'completed',
      durable: durableShape,
      timestampsComplete,
    })

    // The curve is built from the same compressed clock the live meter used, so
    // a point read off it means the same thing the pill showed at that instant.
    const compressed = compressAttempts(record.attempts)
    const reasoningSeries = rollingTpsSeries(compressed.samples, {
      phase: 'reasoning',
      durationMs: compressed.durationMs,
    })
    const outputSeries = rollingTpsSeries(compressed.samples, {
      phase: 'output',
      durationMs: compressed.durationMs,
    })

    return {
      ...aggregate,
      statusNote: record.statusNote,
      curve: {
        durationMs: compressed.durationMs,
        segments: compressed.segments,
        reasoning: downsampleSeries(reasoningSeries),
        output: downsampleSeries(outputSeries),
        peakTps: peakTps(reasoningSeries, outputSeries),
        /** Curve points are shape estimates; their phase integrals are anchored to usage. */
        quality: aggregate.usageComplete ? 'calibrated' : 'estimated',
        sampleEveryMs: 250,
        windowMs: 1000,
      },
    }
  }

  /** Current live snapshot for one session, or `{phase:'idle'}`. */
  liveSnapshot(sessionId, nowMs) {
    const meter = this.liveBySession.get(sessionId)
    return meter === undefined ? { phase: LivePhase.IDLE } : meter.snapshot(nowMs)
  }

  /** Latest settled turn for one session, newest by turn number. */
  latestSettled(sessionId) {
    let best = null
    for (const record of this.turns.values()) {
      if (record.sessionId !== sessionId || record.settled === null) continue
      if (best === null || record.turn > best.turn) best = record.settled
    }
    return best
  }

  /** Drop the oldest settled turns so memory stays bounded. */
  pruneHistory(sessionId) {
    const settled = [...this.turns.values()]
      .filter(record => record.sessionId === sessionId && record.settled !== null)
      .sort((a, b) => a.turn - b.turn)
    while (settled.length > this.historyLimit) {
      const victim = settled.shift()
      this.turns.delete(turnKey(victim.sessionId, victim.turn))
    }
  }

  /**
   * Release every resource. The store owns no timers or listeners, but clearing
   * is still required so an HMR reload cannot leave a previous generation's
   * state addressing the same sessions.
   */
  dispose() {
    this.turns.clear()
    this.liveBySession.clear()
  }
}
