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
import { MODEL_PHASE, tokenEvidence } from '../core/delta-accounting.js'
import { compressAttempts } from '../core/time-axis.js'
import { curveSource } from '../core/curve-source.js'
import {
  DEFAULT_SAMPLE_EVERY_MS as CURVE_SAMPLE_EVERY_MS,
  MAX_RENDER_POINTS_TOTAL,
  MAX_SERIES_POINTS,
  MIN_MAX_POINTS,
  allocateRunBudgets,
  attemptTraces,
  downsampleRun,
  peakTps,
  phaseRuns,
  visualRunsOf,
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
   * @param {{estimateTokens?:Function, historyLimit?:number}} [options]
   */
  constructor(options = {}) {
    this.estimateTokens = options.estimateTokens ?? heuristicTokenWeight
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    /**
     * A `windowMs` option and its field were removed in Phase 9.2 with the trailing
     * window itself: the live rate is a phase-cumulative average and the completed
     * curve is sampled at `CURVE_SAMPLE_EVERY_MS`. The only presentation cadence in
     * the project still lives in `src/client/live/cadence.js`, and nothing here
     * schedules anything.
     */
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
      meter = new LiveMeter()
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
   * Record a turn's start time that was **observed after the record already
   * existed**.
   *
   * The one path that needs this is the mid-turn attach. A page that reloads
   * during a turn sees no `turn/start` in its window and adopts the open turn
   * from transient evidence (`SessionEventFeed.adoptTurn`, marked `recovered`),
   * which opens the record with `startMs: null` so nothing is measured from the
   * reload. If the durable `turn/start` row is later published into this client
   * — a reconnect, or the window sliding back over it — its timestamp is the
   * turn's real start, and `beginTurn` is idempotent and would otherwise keep
   * the record at `null` for the rest of the turn.
   *
   * Two rules make the upgrade safe. It is **one-way**: a node already holding a
   * finite start is left untouched, so re-observing a turn can never withdraw
   * authority or move a measurement that was already reported. And it is
   * **recomputed, not restarted**: `record.firstTokenMs` is the absolute time of
   * the first token-producing delta and is never rewritten here, so TTFT stays
   * `firstToken - turn/start` over the same evidence, and elapsed is the same
   * interval it always was — merely computable now.
   *
   * @returns {boolean} whether anything was upgraded
   */
  turnStartObserved(record, { timeMs }) {
    if (record === null || record === undefined) return false
    if (Number.isFinite(record.startMs) || !Number.isFinite(timeMs)) return false
    record.startMs = timeMs
    this.live(record.sessionId).turnStartObserved({ turn: record.turn, timeMs })
    return true
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
        /**
         * The attempt's **non-magnitude phase boundaries**, in stream order.
         *
         * A name-bearing `tool-call-delta` whose `argumentsDelta` is still empty is
         * DSH's first-token evidence and declares a phase, and it carries no
         * magnitude: `sampleFromChunk` returns `null` for it, so it can never be a
         * sample and must not be turned into one. Until Phase 9.4.3 the boundary
         * existed only in the live meter, and the completed curve — which segments
         * its episodes from `samples` alone — continued the outgoing phase until the
         * new phase's first magnitude sample, drawing a decay across a stretch the
         * live pill had already left.
         *
         * This array is that evidence, kept beside the samples rather than inside
         * them: `{timeMs, phase}` per boundary, appended in arrival order, never
         * deduplicated (a replayed frame is the same duplicate a replayed sample is)
         * and never given a magnitude, a sample count or a `sampleOrder`.
         */
        phaseCuts: [],
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
   * Freeze the turn's first-token instant, once.
   *
   * TTFT is `firstToken - turn/start`, and the first token is the first chunk
   * DSH's own predicate accepts (`tokenEvidence().countsAsToken`). The stamp is
   * one-way and additive: a later chunk can never move it forward, and an earlier
   * one can only replace it with an earlier instant — which is what lets a
   * durable reconstruction report the same TTFT a live session froze, whichever
   * order the two planes delivered their evidence in.
   *
   * `firstTokenMs` is deliberately *not* the earliest accepted sample. A
   * name-bearing tool-call delta with an empty argument fragment is the model's
   * first token and contributes no sample at all, so the two sets are not the
   * same, and treating them as one is what left the pill on the first-response
   * stopwatch after the boundary had passed.
   *
   * @returns {boolean} whether the recorded instant changed
   */
  firstTokenObserved(record, { timeMs }) {
    if (record === null || record === undefined) return false
    if (!Number.isFinite(timeMs)) return false
    if (!Number.isFinite(record.firstTokenMs)) {
      record.firstTokenMs = timeMs
      return true
    }
    if (timeMs < record.firstTokenMs) {
      record.firstTokenMs = timeMs
      return true
    }
    return false
  }

  /**
   * Record a non-magnitude **phase cut** on the attempt it happened in.
   *
   * The one chunk shape that reaches here is a name-bearing `tool-call-delta`
   * whose `argumentsDelta` is still empty: DSH's `isTokenDelta` accepts it while
   * `classifyDelta` attributes no argument text to it, so it is the model's first
   * token and not a TPS-shape sample. `tokenEvidence().phase` is the phase the
   * boundary declares, and it is never `null` for a chunk the predicate accepts.
   *
   * Two things this method deliberately does **not** do:
   *
   *   - it does not turn the boundary into a sample. A `{tokens: 0}` entry would
   *     enter the episode's numerator and its sample count, which is exactly the
   *     fabricated evidence the contract forbids;
   *   - it does not decide whether the cut closes anything. That question depends on
   *     the phase in force at the instant, which is the episode walk's answer
   *     (`src/core/phase-duration.js`), read identically by the completed curve and
   *     by the summary so the two cannot disagree. A same-phase boundary is
   *     therefore stored here and closes nothing.
   *
   * @returns {boolean} whether the cut was recorded
   */
  phaseCutObserved(attempt, { timeMs, phase }) {
    if (attempt === null || attempt === undefined) return false
    if (!Number.isFinite(timeMs)) return false
    if (phase !== MODEL_PHASE.REASONING && phase !== MODEL_PHASE.OUTPUT) return false
    if (!Array.isArray(attempt.phaseCuts)) attempt.phaseCuts = []
    attempt.phaseCuts.push({ timeMs, phase })
    return true
  }

  /**
   * Accept one streamed chunk. Non-generated chunks (block, usage, finish) are
   * ignored by `sampleFromChunk`; a `usage` chunk additionally updates the
   * attempt's authoritative usage without becoming a sample.
   *
   * The sample is stamped with the attempt it belongs to **before** it reaches the
   * live meter. The meter's episode is bound to one attempt and rejects a sample
   * naming another one, and that guard is only reachable if the identity travels
   * with the sample: a late frame for an attempt the turn has already moved past
   * therefore cannot enter the newer attempt's cumulative rate, even though the
   * closed attempt still keeps it for the completed curve.
   *
   * ## A chunk can be token evidence without being a sample
   *
   * DSH's `isTokenDelta` accepts a name-bearing `tool-call-delta` whose
   * `argumentsDelta` is empty, while `classifyDelta` attributes no argument text
   * to it and `sampleFromChunk` therefore returns `null`. The TTFT boundary and
   * the TPS-shape sample set are two different questions, and this method answers
   * both: the boundary freezes the turn's first token and moves the live meter out
   * of its first-response stage, and no magnitude is fabricated to make the sample
   * set look complete.
   *
   * @returns {object|null} the accepted sample, or `null`
   */
  acceptChunk(record, attempt, { timeMs, chunk }) {
    if (chunk && chunk.type === 'usage' && chunk.usage) {
      attempt.usage = chunk.usage
      /**
       * An in-stream `usage` chunk is not a generated sample, but it is evidence
       * the live estimator may use: the phase-cumulative numerator prefers an
       * authoritative provider counter over the shape weight for the episodes
       * that begin after the counter is known (`docs/METRICS_SPEC.md` §6).
       */
      this.live(record.sessionId).observeUsage({ attemptId: attempt.attemptId ?? null, usage: chunk.usage })
      return null
    }
    if (!Number.isFinite(timeMs)) return null
    const sample = sampleFromChunk(timeMs, chunk, this.estimateTokens)
    if (sample === null) {
      /**
       * No usable TPS-shape magnitude. That is not the same as "not model
       * output": the DSH first-token predicate may still accept the chunk, and
       * when it does, this is the turn's TTFT boundary.
       */
      const evidence = tokenEvidence(chunk)
      if (!evidence.countsAsToken) return null
      this.firstTokenObserved(record, { timeMs })
      /**
       * The boundary is also a **phase statement**, and Phase 9.4.3 records it as
       * one. It is not converted into a sample — that would fabricate a magnitude
       * and a sample count — and it is not discarded — that would leave the
       * completed curve bridging an episode the live meter had already closed. It
       * is stored as its own fact, on the attempt it belongs to, on the same clock
       * the samples carry.
       *
       * The predicate is the one `phaseCutOf` states for a decoded chunk: token
       * evidence the sample builder could not turn into a magnitude. The two forms
       * exist because this plane delivers one chunk at a time while a durable
       * settlement delivers a whole decoded stream, and both must publish the same
       * cut or a reloaded card would disagree with the live one.
       */
      if (!evidence.contributesMagnitude) {
        this.phaseCutObserved(attempt, { timeMs, phase: evidence.phase })
      }
      this.live(record.sessionId).observeTokenBoundary({
        attemptId: attempt.attemptId ?? null,
        timeMs,
        phase: evidence.phase,
      })
      return null
    }
    this.firstTokenObserved(record, { timeMs })
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

    /**
     * The ephemeral curve input: the stored attempts joined with the calibrated
     * per-delta allocation `aggregateTurn` has already computed. The raw evidence is
     * not touched — `record.attempts[].samples` remains the provenance — and no
     * second calibration algorithm lives here, because a duplicate would be free to
     * drift from the one the printed token totals use
     * (`src/core/curve-source.js`).
     */
    const source = curveSource(record.attempts, aggregate.attemptBreakdown)
    const calibratedIds = new Set(
      source.attempts
        .filter(attempt => attempt?.anchored === true)
        .map(attempt => attempt.attemptId ?? null),
    )
    /**
     * Each attempt's calibrated allocation mode, carried beside its samples.
     * `phase-anchored` means the provider's own phase split mapped onto the
     * observed stream; `total-anchored` means only the attempt's integral is
     * anchored. The distinction is not recoverable from a sample, so it travels
     * as a separate fact and is published on the peak's debug provenance.
     */
    const allocationModes = new Map()
    for (const attempt of source.attempts) {
      allocationModes.set(attempt?.attemptId ?? null, attempt?.temporalAllocationMode ?? null)
    }

    // The curve is built from the same compressed clock the live meter used, so
    // a point read off it means the same thing the pill showed at that instant.
    // The attempt's non-magnitude phase cuts are mapped onto that clock with the
    // samples, so a boundary the live half closed an episode at is a coordinate the
    // completed half can close it at too (`src/core/time-axis.js`).
    const compressed = compressAttempts(source.attempts)

    /**
     * The published series is one **attempt-local phase-cumulative trace** per model
     * attempt. This ordering is the specification.
     *
     * The compressed clock concatenates attempts so a tool gap has no width, but a
     * phase episode's clock is a property of one model call. Measuring across the
     * concatenated list would credit the opening vertices of attempt B with attempt
     * A's tokens — the two numbers are drawn a single pixel apart and describe
     * different calls, which is precisely the case a reader cannot detect by looking
     * at the chart. `attemptTraces` measures each attempt on its own clock;
     * `test/curve-attempt-boundary.test.js` carries the counterexample that the
     * previous implementation fails.
     *
     * Within one attempt the trace is **one measurement per phase episode**: every
     * generated sample counts toward the episode in force, whatever its phase, which
     * is what `LiveMeter` measures. Reasoning and output own their own episode clocks
     * and are carried on each vertex as `activePhase`; a phase transition therefore
     * resets the magnitude rather than producing two partial rates of one window.
     */
    const traces = attemptTraces(compressed.segments, compressed.samples, {
      sampleEveryMs: CURVE_SAMPLE_EVERY_MS,
      maxPoints: MAX_SERIES_POINTS,
      calibratedAttemptIds: calibratedIds,
      temporalAllocationModeByAttemptId: allocationModes,
      cuts: compressed.cuts,
    })

    /**
     * The vertex set of each attempt, as flat index ranges rather than copies. The
     * allocation below needs the length of every visual run and the renderer needs
     * its slice; neither needs a duplicated array per run, and a slice keeps the
     * shared phase-transition vertex the **same object** in both runs that meet on
     * it, which is what makes the tone change a seam rather than a fabricated
     * duplicate measurement.
     */
    const drawables = []
    for (const trace of traces) {
      for (const run of trace.visualRuns) {
        drawables.push({
          attemptId: trace.attemptId,
          phase: run.phase,
          /** Explicit length, because this run is a range and not its own array. */
          length: run.pointCount,
          points: trace.points.slice(run.startIndex, run.endIndex + 1),
          trace,
        })
      }
    }

    /**
     * The chart-wide point budget, allocated **before** any downsampling runs.
     *
     * `downsampleSeries` bounds one run, and one run is not a chart: a turn that
     * alternates reasoning and output a hundred times produced a hundred runs of up
     * to `DEFAULT_MAX_POINTS` vertices each, so the SVG's element count followed the
     * model's delivery pattern. Every phase is budgeted together because they are
     * drawn into one plot area and share one axis.
     *
     * The allocation is computed over the run list and then applied per run. The
     * attempts are never flattened, downsampled as one series and cut back apart: the
     * cut points would not fall on run boundaries, and a single bridged polyline
     * across a stretch where the model produced nothing is exactly the defect the
     * per-attempt structure exists to prevent.
     *
     * `peakTps` below still reads the **published** series — the attempt traces after
     * the MiMo-style 200-point cap, not after this budget — and `downsampleRun`
     * independently guarantees the maximum survives into whatever budget it is
     * given, so the render budget can thin the drawing but never move a reported
     * number.
     */
    const allocation = allocateRunBudgets(drawables, MAX_RENDER_POINTS_TOTAL)
    let cursor = 0
    const budgetedTraces = traces.map((trace) => {
      const runs = trace.visualRuns.map((run) => {
        const allowance = allocation.budgets[cursor] ?? run.pointCount
        const refused = allocation.degraded.includes(cursor)
        cursor += 1
        const full = trace.points.slice(run.startIndex, run.endIndex + 1)
        /**
         * Two cases bypass downsampling and keep their measured vertices: a refused
         * run keeps none, and a run of one or two vertices is already at full
         * resolution. The second matters because `downsampleSeries` refuses a budget
         * below `MIN_MAX_POINTS` by design — it cannot honour the three anchors — and
         * a run that already has fewer vertices than that has nothing to thin. Such a
         * run is a **singleton measurement**, drawn as a point marker rather than as
         * a line (`src/client/completed/curve-view-model.js`), which is why carrying
         * it through is not the same as inventing a second vertex to draw a segment
         * with.
         *
         * `downsampleRun` is what protects a phase transition: adjacent runs share
         * their boundary vertex, and thinning each run independently would be free to
         * drop exactly that shared vertex, reopening as a blank horizontal gap a tone
         * change that is not a stall.
         */
        const measured = full.length < MIN_MAX_POINTS
        const points = refused
          ? []
          /**
           * A run that fits keeps the trace's **own** vertex objects rather than copies. Two
           * reasons, and the second is the load-bearing one: the renderer only ever reads
           * them, so copying buys nothing; and the runs of one attempt meet on a shared
           * boundary vertex, so a copy per run would quietly turn one measurement drawn twice
           * into two objects that merely happen to agree. Identity is what lets a test — and a
           * future diagnostic — say "these two subpaths meet *here*" rather than "they end and
           * start at the same coordinate".
           */
          : (measured ? full : downsampleRun(full, allowance))
        return {
          attemptId: trace.attemptId,
          phase: run.phase,
          startIndex: run.startIndex,
          endIndex: run.endIndex,
          startMs: points.length > 0 ? points[0].timeMs : trace.startMs,
          endMs: points.length > 0 ? points[points.length - 1].timeMs : trace.startMs,
          pointCount: run.pointCount,
          points,
          peak: peakTps(points),
          degraded: refused,
          /**
           * `false` when the run is drawn under a reduced allowance. A caller that
           * wants to annotate a thinned run can read it; nothing renders it.
           */
          fullResolution: !refused && allowance >= run.pointCount,
        }
      })
      return {
        attemptId: trace.attemptId,
        startMs: trace.startMs,
        endMs: trace.endMs,
        localEndMs: trace.localEndMs,
        durationMs: trace.durationMs,
        sampleCount: trace.sampleCount,
        /**
         * The sum this attempt's curve samples carry. With calibration it equals the
         * attempt's authoritative `outputTokens`, which is what makes the printed
         * generated-token total and the curve the same magnitude system.
         */
        tokens: trace.tokens,
        calibratedTokens: trace.calibratedTokens,
        calibrated: trace.calibrated,
        /**
         * The **unbudgeted** published trace — the capped MiMo-style series the peak
         * is measured on. The renderer must use `runs`.
         */
        points: trace.points,
        /**
         * The attempt's own winning measurement, with the episode facts that
         * produced it. Debug-only; see `curve.peakProvenance` below.
         */
        peakProvenance: trace.peakProvenance,
        /**
         * The attempt's own curve-source samples, on its attempt-local clock, exactly
         * as the phase-cumulative estimator read them. They are the bridge between a
         * printed token total and a drawn vertex, which is why they are published
         * rather than left to be reassembled from the runs.
         */
        samples: trace.samples,
        /**
         * The attempt's non-magnitude phase boundaries, on the same clock as
         * `samples`. A gap in the drawn runs is one of these and the reason for it;
         * publishing the evidence is what lets a reader, a test or a diagnostic say
         * which boundary produced the hole instead of inferring it from geometry.
         */
        cuts: trace.cuts,
        /** The attempt's budgeted phase-coloured subruns, in ascending time order. */
        runs,
      }
    })

    /**
     * The per-phase view of the same runs, in the fixed legend order.
     *
     * It is a **view**, not a second measurement: every entry is one of the budgeted
     * visual runs of an attempt trace, so the legend, the peak and the drawn geometry
     * can never describe different series. A phase with no run is absent rather than
     * flat, because "never reasoned here" and "reasoning throughput fell to zero" are
     * different facts.
     */
    const series = ['reasoning', 'output'].map((key) => {
      const runs = []
      for (const attempt of budgetedTraces) {
        for (const run of attempt.runs) if (run.phase === key) runs.push(run)
      }
      return {
        key,
        tone: key === 'output' ? 'accent' : 'neutral',
        phase: key,
        present: runs.some(run => run.points.length >= 2),
        runs,
        /**
         * The phase's strongest **publishable** vertex, or `null` when the phase
         * produced no measurement that passed the shared publication policy. It is
         * read from the points rather than from `run.peak` so a phase whose runs
         * are all below the gates reports `null` instead of a fabricated zero.
         */
        peak: peakTps(...runs.map(run => run.points)),
      }
    })

    /**
     * The same allocation, counted the way the chart is drawn. `lineVertices` is the
     * number of path vertices the SVG will receive — runs of two or more **measured**
     * points — and `markers` is the number of one-vertex runs, each of which becomes a
     * point marker rather than a vertex of a line. Their sum is what
     * `MAX_RENDER_POINTS_TOTAL` bounds; see `renderBudget` below for why the two are
     * never published as one number called `drawnPoints`.
     *
     * A phase-transition vertex is charged **once**, to both of the runs that share it,
     * because it is drawn as the endpoint of both subpaths. That is why the sum below
     * is the honest count of emitted vertices and why the seam can never push the
     * chart past its own bound.
     *
     * ## Withheld vertices are spent from the allocation, not drawn
     *
     * The allocator charges a run for **every** vertex it holds, which is the right unit
     * for a budget: a vertex the publication policy later withholds still cost the run
     * its seat. What the chart *emits* is a different set, and this accounting exists to
     * state the emitted one, because it is the number `curveViewModel.renderElementPoints`
     * reports and the one a reader is checking against the bound.
     *
     * Since Phase 9.4 a withheld vertex carries `tps: null` instead of a fabricated `0`
     * (`src/core/rate-publication.js`), and no path is drawn through it. On a dense
     * fixture that is not a rounding difference: a three-delta attempt on a 250 ms grid
     * is allocated four vertices and measures two, so counting allocations would report
     * twice the elements the SVG receives and make the two published numbers disagree by
     * exactly the number of withheld vertices. Filtering here keeps the pair equal, which
     * is the property the budget tests assert, and keeps `elementPoints <= allocated <=
     * total` true in the only direction that matters.
     */
    const isMeasuredPoint = point => Number.isFinite(point?.tps)
    let lineVertices = 0
    let markers = 0
    for (const entry of series) {
      for (const run of entry.runs) {
        const points = Array.isArray(run.points) ? run.points : []
        const measured = points.filter(isMeasuredPoint).length
        if (measured >= 2) lineVertices += measured
        else if (points.length === 1) markers += 1
      }
    }

    /**
     * Runs the allocator had to refuse outright, because even the three anchors that
     * `downsampleSeries` guarantees could not fit inside the chart budget. This is
     * the documented degradation: a refused run is **not drawn at all** rather than
     * drawn truncated, and the count is published so the condition is inspectable
     * instead of silent.
     */
    const degradedRuns = allocation.degraded.length

    /**
     * `peakTps` is measured on the **full** series, before downsampling. The order of
     * the two expressions in `curve` below is the specification, not an accident: the
     * rendered point count is a drawing budget, and a drawing budget must never move a
     * reported statistic. `downsampleRun` independently guarantees that the point
     * bearing this maximum survives into the rendered series, so the drawn curve and
     * the printed peak agree.
     *
     * The peak is the maximum over every attempt's total trace. It is never a sum and
     * never an average across attempts: the turn's peak rate is the fastest any single
     * call ran, not a quantity assembled from two calls.
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
        /**
         * The curve's own magnitude provenance. `aligned: false` means the join
         * between the stored attempts and their calibrated reductions could not be
         * trusted, and the whole curve fell back to the raw shape weight rather than
         * attaching one attempt's calibration to another
         * (`src/core/curve-source.js`).
         *
         * `calibrated` means **the whole curve** is anchored, and `calibrationCoverage`
         * states that explicitly as `full` / `partial` / `none` / `fallback`. A turn
         * whose attempts reported usage unevenly is `partial`: some stretches are
         * anchored to a provider counter and some are still the coarse shape weight,
         * which is a legitimate best estimate and an inaccurate thing to call
         * "calibrated". The peak keeps its `≈` at every level, because per-delta
         * allocation is reconstructed in all of them.
         */
        source: {
          aligned: source.aligned,
          calibrated: source.calibratedForCurve,
          calibrationCoverage: source.calibrationCoverage,
          contributingAttemptCount: source.contributingCount,
          calibratedAttemptCount: source.calibratedCount,
          rawFallbackAttemptIds: source.rawFallbackAttemptIds,
          issues: source.issues,
        },
        /** The rendered geometry: one trace per attempt, split into phase-coloured runs. */
        attempts: budgetedTraces,
        series,
        /**
         * Per-phase colour segmentation of the same traces, for diagnostics and for
         * tests that ask where a phase has evidence at all. It is derived from the
         * attempt traces rather than measured separately.
         */
        phaseRuns: phaseRuns(traces),
        peakTps: peakTps(...traces.map(trace => trace.points)),
        /**
         * **Debug-only provenance of the published peak.**
         *
         * `peakTps` is a maximum, and a maximum says nothing about how it was
         * produced. The Phase 9.4 defect was exactly that: a peak whose value came
         * from a denominator — 50 ms, or one millisecond — that no surface
         * reported. This record publishes the winning attempt, phase, episode
         * origin, elapsed clock, contributing sample count and mass, the
         * calibration mode and the timestamps of the samples behind the number, so
         * a spike can be explained rather than merely observed.
         *
         * It is diagnostics and must not be rendered: no module in `src/client`
         * reads it, and `test/curve-rate-publication.test.js` asserts that the
         * composed view model does not carry it. `null` when nothing is
         * publishable, which is the same condition that makes `peakTps` `null`.
         */
        peakProvenance: traces.reduce(
          (best, trace) => (trace.peakProvenance === null
            ? best
            : (best === null || trace.peakProvenance.tps > best.tps ? trace.peakProvenance : best)),
          null,
        ),
        /**
         * Flat concatenations of the budgeted runs, retained for callers that want one
         * array of vertices. They carry `attemptId` on every point; a renderer must
         * segment on it rather than joining the array into one path.
         */
        reasoning: series[0].runs.flatMap(run => run.points),
        output: series[1].runs.flatMap(run => run.points),
        /**
         * The chart-wide rendering budget, and what became of it. `allocated` is at or
         * below `total`, and `degradedRuns` counts the runs refused outright when the
         * anchors did not fit — the documented degradation, published rather than
         * silent.
         *
         * `lineVertices` and `markers` split the same allocation the way the chart is
         * actually built: a run of two or more vertices becomes a path vertex, and a run
         * of one becomes a point marker
         * (`src/client/completed/curve-view-model.js`). `elementPoints` is their sum,
         * and it — not `drawnPoints` alone — is the quantity `MAX_RENDER_POINTS_TOTAL`
         * bounds, because a marker is an SVG-adjacent element just as a vertex is, and
         * a phase-transition vertex is emitted by both subpaths that share it.
         *
         * `peakRun` is the flat index of the run carrying the chart maximum in the
         * allocation's own run order, or `-1` when no run holds a finite rate.
         * `peakRetained` is false only when that run could not be seated at all, which
         * at a budget of 512 cannot happen; a caller that reads it must not present a
         * refused peak as a drawn one.
         */
        renderBudget: {
          total: allocation.total,
          allocated: allocation.allocated,
          runs: allocation.budgets.length,
          degradedRuns,
          lineVertices,
          markers,
          elementPoints: lineVertices + markers,
          peakRun: allocation.peakIndex,
          peakRetained: allocation.peakRetained,
        },
        /**
         * Every budgeted vertex, summed over both phases and every run. This is the
         * allocation's own accounting, so it counts a one-vertex run as the single
         * vertex it holds — which is what the allocator charged for it.
         *
         * It is therefore **not** the same quantity as `curveViewModel.drawnPoints`,
         * which counts path vertices only and reports markers separately. The two names
         * were once the same and the coincidence hid half the SVG from the bound: a
         * chart could assert `drawnPoints <= 512` while carrying any number of markers
         * on top. `renderBudget.elementPoints` is the sum that is actually bounded;
         * this field remains the allocator's accounting.
         */
        drawnPoints: series.reduce(
          (sum, entry) => sum + entry.runs.reduce((inner, run) => inner + run.points.length, 0),
          0,
        ),
        /**
         * Curve quality follows the **temporal shape** axis, not the token axis. A
         * curve is a shape claim, so an exactly known token total with incomplete
         * timestamps is an estimated shape, and `usageComplete` alone cannot express
         * that. See `curveQuality` below.
         */
        quality: curveQuality(aggregate),
        qualityAxes: {
          tokenTotalQuality: aggregate.quality.tokenTotalQuality,
          phaseSplitQuality: aggregate.quality.phaseSplitQuality,
          temporalShapeQuality: aggregate.quality.temporalShapeQuality,
        },
        sampleEveryMs: CURVE_SAMPLE_EVERY_MS,
        /**
         * The stored-series cap the published points obey. There is no statistical
         * window to publish beside it: the estimator is a phase-cumulative average,
         * so `sampleEveryMs` is a sampling decision and the cap is a fidelity one.
         */
        maxSeriesPoints: MAX_SERIES_POINTS,
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
   * Drop everything one session owns, because the window that produced it has been
   * superseded.
   *
   * A `replace` on the session event window is a **rebaseline**: the complete contiguous
   * window was swapped (reload, reconnect, window generation change), so the rows the feed
   * republishes are that session's authoritative evidence and whatever the previous
   * generation contributed is not. `SessionEventFeed` drops its own generation state for
   * exactly that reason; this method is the same boundary on the metric side, where the
   * evidence actually lives.
   *
   * Without it the replay re-enters attempts that already exist. `beginTurn` is
   * deliberately idempotent — re-observing the same durable `turn/start` must not discard
   * samples — and `beginAttempt` returns the existing attempt for a known `attemptId`, so
   * a replayed delta is appended to the very attempt the superseded window filled. The
   * turn then reports whatever the window happened to publish, counted once per
   * republication.
   *
   * Two things are removed, and both are needed. The turn records
   * (`this.turns`, keyed by `(sessionId, turn)`) carry attempts, samples, usage, tool
   * intervals and the computed settled snapshot; the `LiveMeter` in `this.liveBySession`
   * carries the rolling window, the frozen TTFT stage, the turn start and the running
   * tool set. Clearing one and keeping the other would leave a live rate assembled from a
   * window the client no longer believes in.
   *
   * The scope is one session. Two sessions run concurrently and their windows are
   * independent, so a rebaseline of one is not a reason to discard the other's evidence;
   * `dispose()` is the store-wide reset, and it is a different operation with a different
   * meaning.
   *
   * @param {string} sessionId
   * @returns {number} how many turn records were removed
   */
  rebaselineSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return 0
    let removed = 0
    /** Deleting during `Map` iteration is safe: entries not yet visited are still reached. */
    for (const [key, record] of this.turns) {
      if (record.sessionId !== sessionId) continue
      this.turns.delete(key)
      removed += 1
    }
    this.liveBySession.delete(sessionId)
    return removed
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
