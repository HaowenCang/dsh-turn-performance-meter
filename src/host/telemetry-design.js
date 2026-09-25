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
import {
  DEFAULT_SAMPLE_EVERY_MS as CURVE_SAMPLE_EVERY_MS,
  DEFAULT_WINDOW_MS as CURVE_WINDOW_MS,
  MAX_RENDER_POINTS_TOTAL,
  MIN_MAX_POINTS,
  allocateRunBudgets,
  downsampleSeries,
  peakTps,
  perAttemptSeries,
  phaseRuns,
} from '../core/curve.js'
import { aggregateTurn } from '../core/aggregate-turn.js'
import { QualityLevel, clampToAxis, QUALITY_AXIS } from '../core/quality-model.js'
import { turnKey } from '../core/types.js'

/** How many settled turns are retained per session, newest first. */
export const DEFAULT_HISTORY_LIMIT = 4

/**
 * Quality of the completed curve.
 *
 * A curve is a **temporal shape** claim, so it is governed by the temporal-shape
 * axis and by nothing else. The previous revision derived it from
 * `usageComplete`, which answers a different question: a turn whose provider
 * reported an exact token total but whose delta timestamps were incomplete was
 * labelled `calibrated`, and `calibrated` is a claim about the *shape* that the
 * evidence does not support. Meanwhile a turn with complete, durable, anchored
 * timing and only partially reported usage was labelled `estimated`, which
 * understates what is known.
 *
 * The token and split axes still govern the numbers printed beside the chart, so
 * they travel with the curve in `curve.qualityAxes` rather than being folded into
 * this one label.
 *
 * The ceiling is structural: `temporalShape` can never exceed `reconstructed`,
 * because DSH attaches no token count to a delta and every vertex is therefore a
 * shape weight. That is why the peak keeps its `≈` at every quality level.
 *
 * The argument may be a settled aggregate (which nests the axes under `quality`)
 * or a bare axes object; both are accepted so that a caller holding only the axes
 * cannot accidentally get `unavailable` back.
 */
export function curveQuality(aggregate) {
  const axes = aggregate?.quality ?? aggregate
  const level = axes?.temporalShapeQuality
  if (level === undefined) return QualityLevel.UNAVAILABLE
  return clampToAxis(QUALITY_AXIS.TEMPORAL_SHAPE, level)
}

export class TurnTelemetryStore {
  /**
   * @param {{estimateTokens?:Function, historyLimit?:number, windowMs?:number}} [options]
   */
  constructor(options = {}) {
    this.estimateTokens = options.estimateTokens ?? heuristicTokenWeight
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    /**
     * The trailing window a rate is measured over. It is a *metric* contract, not
     * a refresh rate: nothing in `src/core` or `src/host` schedules presentation,
     * and the only presentation cadence in the project lives in
     * `src/client/live/cadence.js`. A `refreshMs` option was removed here in
     * Phase 6 because it implied otherwise while driving no timer at all.
     */
    this.windowMs = options.windowMs ?? CURVE_WINDOW_MS
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
      meter = new LiveMeter({ windowMs: this.windowMs })
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
   * The sample is stamped with the attempt it belongs to **before** it reaches the
   * live meter. The meter's window is bound to one attempt and rejects a sample
   * naming another one, and that guard is only reachable if the identity travels
   * with the sample: a late frame for an attempt the turn has already moved past
   * therefore cannot enter the newer attempt's rolling rate, even though the closed
   * attempt still keeps it for the completed curve.
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
    const stamped = { ...sample, attemptId: attempt.attemptId ?? null }
    attempt.samples.push(stamped)
    this.live(record.sessionId).acceptSample(stamped)
    return stamped
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

    /**
     * The rolling series is built **per attempt**, then relabelled onto the
     * compressed coordinate. This ordering is the specification.
     *
     * The compressed clock concatenates attempts so a tool gap has no width, but
     * a trailing one-second window is a property of one model call. Rolling one
     * window across the concatenated list made the opening vertices of attempt B
     * count attempt A's trailing tokens — the two numbers are drawn a single pixel
     * apart and describe different calls, which is precisely the case a reader
     * cannot detect by looking at the chart. `perAttemptSeries` measures each
     * attempt on its own clock; `test/curve-attempt-boundary.test.js` carries the
     * counterexample that the previous implementation fails.
     */
    const series = [
      { key: 'reasoning', tone: 'neutral', phase: 'reasoning' },
      { key: 'output', tone: 'accent', phase: 'output' },
    ].map(({ key, tone, phase }) => {
      const runs = perAttemptSeries(compressed.segments, compressed.samples, {
        phase,
        windowMs: CURVE_WINDOW_MS,
        sampleEveryMs: CURVE_SAMPLE_EVERY_MS,
        /** The last attempt may draw its decay as far as the axis it was given. */
        durationMs: compressed.durationMs,
      })
      return { key, tone, phase, runs }
    })

    /**
     * The chart-wide point budget, allocated **before** any downsampling runs.
     *
     * `downsampleSeries` bounds one run, and one run is not a chart: a turn that
     * alternates reasoning and output a hundred times produced a hundred runs of up
     * to `DEFAULT_MAX_POINTS` vertices each, so the SVG's element count followed the
     * model's delivery pattern. Both phases are budgeted together because they are
     * drawn into one plot area and share one axis.
     *
     * The allocation is computed over the run lists and then applied per run. The
     * runs are never flattened, downsampled as one series and cut back apart: the
     * cut points would not fall on run boundaries, and a single bridged polyline
     * across a stretch where a phase produced nothing is exactly the defect the
     * per-attempt and per-episode structure exists to prevent.
     *
     * `peakTps` below still reads the **full** series, and `downsampleSeries`
     * independently guarantees the maximum survives into whatever budget it is
     * given, so the budget can thin the drawing but never move a reported number.
     */
    const drawables = series.flatMap(entry => entry.runs)
    const allocation = allocateRunBudgets(drawables, MAX_RENDER_POINTS_TOTAL)
    let cursor = 0

    const budgeted = series.map((entry) => {
      const runs = entry.runs.map((run) => {
        const allowance = allocation.budgets[cursor] ?? run.points.length
        const refused = allocation.degraded.includes(cursor)
        cursor += 1
        /**
         * Two runs bypass `downsampleSeries` and keep their measured vertices: a
         * refused run keeps none, and a run of one or two vertices keeps all of them.
         * The second case matters because `downsampleSeries` refuses a budget below
         * `MIN_MAX_POINTS` by design — it cannot honour the three anchors — and a run
         * that already has fewer vertices than that is at full resolution. Such a run
         * is a **singleton measurement**, drawn as a point marker rather than as a
         * line (`src/client/completed/curve-view-model.js`), which is why carrying it
         * through is not the same as inventing a second vertex to draw a segment with.
         */
        const measured = run.points.length < MIN_MAX_POINTS
        const points = refused
          ? []
          : (measured ? run.points.slice() : downsampleSeries(run.points, allowance))
        return {
          ...run,
          points,
          peak: peakTps(run.points),
          degraded: refused,
          /**
           * `false` when the run is drawn under a reduced allowance. A caller that
           * wants to annotate a thinned run can read it; nothing renders it.
           */
          fullResolution: !refused && allowance >= run.points.length,
        }
      })
      return {
        key: entry.key,
        tone: entry.tone,
        phase: entry.phase,
        present: runs.some(run => run.points.length >= 2),
        runs,
      }
    })

    /**
     * Runs the allocator had to refuse outright, because even the three anchors that
     * `downsampleSeries` guarantees could not fit inside the chart budget. This is
     * the documented degradation: a refused run is **not drawn at all** rather than
     * drawn truncated, and the count is published so the condition is inspectable
     * instead of silent.
     */
    const degradedRuns = allocation.degraded.length

    /**
     * `peakTps` is measured on the **full** series, before downsampling. The
     * order of the two expressions in `curve` below is the specification, not an
     * accident: the rendered point count is a drawing budget, and a drawing
     * budget must never move a reported statistic. `downsampleSeries`
     * independently guarantees that the point bearing this maximum survives into
     * the rendered series, so the drawn curve and the printed peak agree.
     *
     * The peak is the maximum over every per-attempt series. It is never a sum
     * and never an average across attempts: the turn's peak rate is the fastest
     * any single call ran, not a quantity assembled from two calls.
     *
     * `phaseRuns` records, per phase, the intervals over which that phase has
     * actual evidence: from each episode's first token-producing sample to its
     * last one plus the rolling window, clamped to its own attempt. Outside those
     * intervals the series reads zero because the phase **is not producing**, not
     * because its throughput collapsed, and a renderer must not draw the two the
     * same way. A turn with two reasoning episodes gets two runs, so no drawable
     * path is ever asked to bridge an output-only stretch.
     *
     * `renderBudget` publishes the allocation itself, so a test or a diagnostic can
     * assert the chart-wide bound without re-deriving it from the point counts.
     */
    return {
      ...aggregate,
      statusNote: record.statusNote,
      curve: {
        durationMs: compressed.durationMs,
        segments: compressed.segments,
        series: budgeted,
        phaseRuns: phaseRuns(compressed.samples, compressed.segments, CURVE_WINDOW_MS, compressed.durationMs),
        peakTps: peakTps(...series.flatMap(entry => entry.runs.map(run => run.points))),
        /**
         * Flat concatenations of the per-attempt series, retained for callers that
         * want one array of vertices. They carry `attemptId` on every point; a
         * renderer must segment on it rather than joining the array into one path.
         * They are the **budgeted** series, so a caller cannot accidentally render
         * an unbounded list through this compatibility path.
         */
        reasoning: budgeted[0].runs.flatMap(run => run.points),
        output: budgeted[1].runs.flatMap(run => run.points),
        /**
         * The chart-wide rendering budget, and what became of it. `allocated` is at
         * or below `total`, and `degradedRuns` counts the runs refused outright when
         * the anchors did not fit — the documented degradation, published rather
         * than silent.
         */
        renderBudget: {
          total: allocation.total,
          allocated: allocation.allocated,
          runs: allocation.budgets.length,
          degradedRuns,
        },
        /**
         * Total vertices the SVG will receive, summed over both phases and every
         * run. This is the quantity `MAX_RENDER_POINTS_TOTAL` bounds.
         */
        drawnPoints: budgeted.reduce(
          (sum, entry) => sum + entry.runs.reduce((inner, run) => inner + run.points.length, 0),
          0,
        ),
        /**
         * Curve quality follows the **temporal shape** axis, not the token axis.
         * A curve is a shape claim, so an exactly known token total with
         * incomplete timestamps is an estimated shape, and `usageComplete` alone
         * cannot express that. See `curveQuality` below.
         */
        quality: curveQuality(aggregate),
        qualityAxes: {
          tokenTotalQuality: aggregate.quality.tokenTotalQuality,
          phaseSplitQuality: aggregate.quality.phaseSplitQuality,
          temporalShapeQuality: aggregate.quality.temporalShapeQuality,
        },
        sampleEveryMs: CURVE_SAMPLE_EVERY_MS,
        windowMs: CURVE_WINDOW_MS,
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
