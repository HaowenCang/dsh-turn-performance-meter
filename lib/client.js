/**
 * GENERATED FILE — do not edit.
 * Rebuild with: npm run build:client
 * Source graph: src/client/main.js + its imports (scripts/bundle-client.mjs).
 */
window.__ModuleLoader__.load({
	id: "dsh-turn-performance-meter",
	factory(require) {
		'use strict'
		const __cache = new Map()
		function __ext(spec) { return require(spec) }
		function __req(id) {
			const hit = __cache.get(id)
			if (hit !== undefined) return hit
			const factory = __modules[id]
			if (factory === undefined) throw new Error('dsh-turn-performance-meter bundle: unknown module ' + id)
			const record = { exports: {} }
			__cache.set(id, record.exports)
			factory(record.exports)
			return record.exports
		}
		const __modules = {
			"src/core/sliding-window.js": function (__exports) {
/**
 * Trailing rolling-window token meter.
 *
 * The samples may be calibrated token counts or live token-shape estimates;
 * quality is tracked by the caller. The window is closed on the left and open on
 * the right — a sample exactly `windowMs` old no longer counts — which is the
 * boundary the metric spec writes as `(t - 1000 ms, t]`.
 *
 * The meter is bound to one **model attempt identity**. `reset` is mandatory at
 * every new attempt so a later model call can never inherit tokens from a call
 * that a tool or a retry separated it from
 * (docs/METRICS_SPEC.md §6).
 */
class SlidingWindowMeter {
  constructor(windowMs = 1000) {
    if (!(windowMs > 0) || !Number.isFinite(windowMs)) throw new TypeError('windowMs must be a finite number > 0')
    this.windowMs = windowMs
    this.samples = []
    this.attemptId = null
  }

  /**
   * Drop every sample and adopt a new attempt identity.
   * @param {string|null} attemptId identity of the attempt the window now serves
   */
  reset(attemptId = null) {
    this.samples.length = 0
    this.attemptId = attemptId
  }

  /**
   * Start a new attempt epoch. Returns `true` when the identity actually
   * changed, so callers can distinguish "new attempt" from a repeated frame of
   * the attempt already being measured.
   */
  beginAttempt(attemptId) {
    const changed = this.attemptId !== attemptId
    if (changed) this.reset(attemptId)
    return changed
  }

  /** Whether the meter currently holds any sample inside the live horizon. */
  get isEmpty() {
    return this.samples.length === 0
  }

  /** Number of retained samples (all of them are newer than the last evaluated `nowMs`). */
  get size() {
    return this.samples.length
  }

  /** Timestamp of the newest retained sample, or `null`. */
  newestTimeMs() {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1].timeMs : null
  }

  add(timeMs, tokenWeight) {
    if (!Number.isFinite(timeMs)) throw new TypeError('timeMs must be finite')
    if (!(tokenWeight >= 0) || !Number.isFinite(tokenWeight)) {
      throw new TypeError('tokenWeight must be a finite non-negative number')
    }
    if (tokenWeight === 0) return
    this.samples.push({ timeMs, tokenWeight })
  }

  /** Add a whole batch of `{timeMs, weight|tokens}` records. */
  addAll(records) {
    if (!Array.isArray(records)) return
    for (const record of records) {
      if (!record) continue
      const weight = record.tokens ?? record.weight
      if (weight === undefined) continue
      this.add(record.timeMs, weight)
    }
  }

  /**
   * Current trailing-window TPS at `nowMs`.
   *
   * Samples strictly in the future of `nowMs` are retained but not counted, so
   * the value is a function of the requested instant rather than of arrival
   * order. Expired samples are evicted from the head.
   */
  value(nowMs) {
    if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite')
    const lowerExclusive = nowMs - this.windowMs
    while (this.samples.length && this.samples[0].timeMs <= lowerExclusive) {
      this.samples.shift()
    }
    let weight = 0
    for (const sample of this.samples) {
      if (sample.timeMs <= nowMs) weight += sample.tokenWeight
    }
    return weight * 1000 / this.windowMs
  }
}

;Object.assign(__exports, { SlidingWindowMeter })
			},
			"src/core/metric-quality.js": function (__exports) {
/**
 * Metric quality is ordered from strongest to weakest evidence. It exists so
 * that no display path can pretend a live estimate is a provider-exact number
 * (docs/METRICS_SPEC.md §11).
 */
const MetricQuality = Object.freeze({
  EXACT: 'exact',
  CALIBRATED: 'calibrated',
  ESTIMATED: 'estimated',
  UNAVAILABLE: 'unavailable',
})

const ORDER = Object.freeze([
  MetricQuality.EXACT,
  MetricQuality.CALIBRATED,
  MetricQuality.ESTIMATED,
  MetricQuality.UNAVAILABLE,
])

const RANK = new Map(ORDER.map((quality, index) => [quality, index]))

/** Whether the value is one of the four declared qualities. */
function isMetricQuality(value) {
  return RANK.has(value)
}

/** Return the weakest quality among the supplied values. */
function weakestQuality(...values) {
  if (values.length === 0) return MetricQuality.UNAVAILABLE
  let weakest = MetricQuality.EXACT
  for (const value of values) {
    const rank = RANK.get(value)
    if (rank === undefined) return MetricQuality.UNAVAILABLE
    if (rank > RANK.get(weakest)) weakest = value
  }
  return weakest
}

/**
 * Quality of an aggregate whose denominator is the sum of phase durations.
 *
 * `null` duration is deliberately not coerced to zero: a single-delta attempt
 * has no measurable generation interval, so any rate computed from it would be
 * fabricated. Callers receive `unavailable` and must render `—`.
 *
 * `measuredRatio` is the share of contributing attempts that supplied a
 * duration. Below 1 the aggregate under-counts the true generation time, so the
 * resulting rate is optimistic and cannot be `exact`.
 */
function rateQuality({ measuredRatio = 1, tokensExact = true, phaseSplitExact = true } = {}) {
  if (!(measuredRatio > 0)) return MetricQuality.UNAVAILABLE
  if (measuredRatio < 1) return MetricQuality.ESTIMATED
  if (!phaseSplitExact) return MetricQuality.CALIBRATED
  return tokensExact ? MetricQuality.EXACT : MetricQuality.ESTIMATED
}

;Object.assign(__exports, { MetricQuality, isMetricQuality, weakestQuality, rateQuality })
			},
			"src/core/phase-duration.js": function (__exports) {
/**
 * Deterministic phase-duration attribution for one model attempt.
 *
 * Normative policy (docs/METRICS_SPEC.md §7 "Phase-duration policy"), which this
 * module is the only implementation of:
 *
 *  1. TTFT — the interval from attempt start to the first generated delta — is
 *     excluded, because the samples begin at the first generated delta.
 *  2. Tool and inter-attempt time is excluded: this function only ever sees one
 *     attempt's own samples, and only intervals between two samples of that
 *     attempt are charged.
 *  3. Intra-stream stalls between consecutive generated deltas are retained:
 *     every gap is charged to the phase of the *earlier* delta. A 3 s stall
 *     inside a reasoning stream is model-delivery instability and must lower the
 *     reported reasoning TPS, not disappear.
 *  4. Reasoning and output never double-count: each pairwise interval is charged
 *     to exactly one phase, so a reasoning -> output -> reasoning interleave
 *     produces three disjoint intervals rather than overlapping `[first,last]`
 *     spans.
 *  5. Degenerate attempts never produce division by zero or infinite TPS. An
 *     attempt with fewer than two generated deltas, or with all deltas sharing
 *     one timestamp, yields `null` durations, never `0`: "no evidence" and
 *     "measured zero duration" are different facts and only the former is true.
 *     Consumers translate `null` duration plus non-zero tokens into
 *     `unavailable` quality rather than an infinite rate.
 *
 * The trailing interval from the last generated delta to attempt settlement is
 * deliberately **not** charged. DSH's settlement timestamp is a host commit
 * boundary (`assistant/message` event time), not a provider decode boundary, so
 * charging it would mix host overhead into the decode denominator. This is the
 * documented fallback branch of METRICS_SPEC §7.
 */

const PHASE = Object.freeze({ REASONING: 'reasoning', OUTPUT: 'output' })

function toSamples(samples) {
  if (!Array.isArray(samples)) return []
  return samples
    .filter(sample => sample && Number.isFinite(sample.timeMs))
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs)
}

/**
 * Attribute one attempt's inter-delta intervals to phases.
 *
 * @param {readonly {timeMs:number, phase:'reasoning'|'output'}[]} samples
 * @returns {{
 *   reasoningMs:number|null,
 *   outputMs:number|null,
 *   spanMs:number,
 *   sampleCount:number,
 *   generatedCount:number,
 * }}
 */
function attributePhaseDurations(samples) {
  const ordered = toSamples(samples)
  let reasoningMs = 0
  let outputMs = 0
  let reasoningSeen = false
  let outputSeen = false

  for (let i = 1; i < ordered.length; i += 1) {
    const gap = ordered[i].timeMs - ordered[i - 1].timeMs
    if (!(gap > 0)) continue
    if (ordered[i - 1].phase === PHASE.REASONING) {
      reasoningMs += gap
      reasoningSeen = true
    } else if (ordered[i - 1].phase === PHASE.OUTPUT) {
      outputMs += gap
      outputSeen = true
    }
  }

  const first = ordered[0]?.timeMs
  const last = ordered.at(-1)?.timeMs
  return {
    reasoningMs: reasoningSeen ? reasoningMs : null,
    outputMs: outputSeen ? outputMs : null,
    spanMs: ordered.length > 1 ? Math.max(0, last - first) : 0,
    sampleCount: ordered.length,
    generatedCount: ordered.length,
  }
}

;Object.assign(__exports, { PHASE, attributePhaseDurations })
			},
			"src/core/live-metrics.js": function (__exports) {
/**
 * Live meter state and snapshots.
 *
 * This is the only place the "what is happening right now" question is answered,
 * and it exists so the client half contains no statistics of its own. It is
 * transport-agnostic: it consumes *normalized* events, which `src/host` (or the
 * browser adapter) produces from verified DSH data.
 *
 * Frozen behaviours implemented here:
 *
 *   - the trailing window is bound to one model attempt and is reset at every new
 *     attempt, so two calls separated by a tool or a retry never mix
 *     (docs/METRICS_SPEC.md §6);
 *   - while no attempt is streaming — including while a tool runs — the meter
 *     reports `tps: null` and a phase of `tool`/`pending`, never a stale or zero
 *     TPS dressed up as current (UI_SPEC §3.3);
 *   - TTFT is measured once per turn, from turn start to the first non-empty
 *     generated delta, and is never redefined by a later call
 *     (docs/METRICS_SPEC.md §4).
 */

const { SlidingWindowMeter } = __req("src/core/sliding-window.js")
const { MetricQuality } = __req("src/core/metric-quality.js")
const { PHASE } = __req("src/core/phase-duration.js")

const LivePhase = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  STREAMING: 'streaming',
  TOOL: 'tool',
  SETTLED: 'settled',
})

class LiveMeter {
  /**
   * @param {{windowMs?:number}} [options]
   */
  constructor(options = {}) {
    /**
     * The measured interval. Named `windowMs` because it is a definition of the
     * rate, not a schedule: this class owns no timer and never will. A `refreshMs`
     * option used to sit beside it and was removed in Phase 6 — it described a
     * presentation cadence the meter never drove, and the only cadence in the
     * project is `src/client/live/cadence.js`. Keeping a second, dead copy of that
     * number here invited a future reader to change the wrong one.
     */
    this.windowMs = options.windowMs ?? 1000
    this.meter = new SlidingWindowMeter(this.windowMs)
    this.reset()
  }

  reset() {
    this.turn = null
    this.turnStartMs = null
    this.turnEndMs = null
    this.firstTokenMs = null
    this.attemptId = null
    this.step = null
    this.phase = LivePhase.IDLE
    this.status = null
    /** Insertion-ordered so the compact label lists tools in call order. */
    this.tools = new Map()
    /**
     * Start of the current *continuous* tool-activity episode: the earliest
     * boundary of the union of overlapping tool intervals that is still open.
     * A tool starting while another runs extends the episode; an episode ends
     * only when the last running call settles. This is the wall-clock figure
     * the compact live timer shows (`toolWall`, never a sum of call durations).
     */
    this.toolEpisodeStartMs = null
    this.lastDeltaMs = null
    /** Phase of the most recent generated sample of the active attempt. */
    this.streamingPhase = null
    this.meter.reset(null)
  }

  /** Begin a new turn; any previous turn's live state is discarded. */
  turnStarted({ turn, timeMs }) {
    this.reset()
    this.turn = turn
    this.turnStartMs = timeMs
    this.phase = LivePhase.PENDING
  }

  /**
   * Record the turn's start now that it has been observed.
   *
   * Two orderings reach this method. A page that attached mid-turn adopted the
   * open turn with an unknown start, and the turn's own `turn/start` row later
   * enters the window (a reconnect, or the window sliding back far enough): the
   * missing instant is then *recovered*, not redefined. Second, the ordinary
   * case calls it on every durable `turn/start` after `turnStarted`, where a
   * finite start is already present.
   *
   * Both elapsed time and turn TTFT are defined as intervals from the turn's
   * start, so recording that instant late does not move either measurement: it
   * is the same arithmetic on the same evidence, and the first token timestamp
   * was already stamped when its delta arrived. What the call changes is
   * whether the metric is *computable* — a finite start turns an unknown into a
   * measured value, which is strictly more evidence than was held before.
   *
   * The converse is refused: an observed start is never replaced by a later
   * non-finite one, so authority can only be added, never withdrawn. The first
   * finite observation wins because a turn has exactly one start.
   *
   * @param {{turn:number|null, timeMs:number|null}} input
   * @returns {boolean} whether the recorded start changed
   */
  turnStartObserved({ turn, timeMs }) {
    if (turn === null || turn === undefined) return false
    if (turn !== this.turn) return false
    if (Number.isFinite(this.turnStartMs)) return false
    if (!Number.isFinite(timeMs)) return false
    this.turnStartMs = timeMs
    return true
  }

  /**
   * Begin a new model attempt. Always resets the window: a new attempt identity
   * is exactly the boundary across which a rolling window must not be bridged.
   * @returns {boolean} whether the identity actually changed
   */
  attemptStarted({ attemptId, step = null, timeMs = null }) {
    const changed = this.meter.beginAttempt(attemptId)
    this.attemptId = attemptId
    this.step = step
    this.streamingPhase = null
    // A model attempt cannot be generating while tools are still running, so the
    // phase leaves `tool` only once the last one has settled.
    if (this.runningTools().length === 0) this.phase = LivePhase.PENDING
    if (Number.isFinite(timeMs)) this.attemptStartMs = timeMs
    return changed
  }

  /**
   * Accept one generated sample (`{timeMs, phase, tokens|weight}`). Non-generated
   * chunks must have been filtered out upstream by `sampleFromChunk`.
   *
   * A sample carrying an `attemptId` other than the active one is rejected: a
   * late frame from an attempt the turn has already moved past must not enter the
   * current window, or the rolling rate would bridge two model calls.
   */
  acceptSample(sample) {
    if (!sample || !Number.isFinite(sample.timeMs)) return false
    if (this.turn === null) return false
    if (sample.attemptId !== undefined && sample.attemptId !== null && sample.attemptId !== this.attemptId) {
      return false
    }
    const weight = sample.tokens ?? sample.weight
    if (!(weight > 0) || !Number.isFinite(weight)) return false
    if (this.firstTokenMs === null) this.firstTokenMs = sample.timeMs
    this.lastDeltaMs = sample.timeMs
    this.phase = LivePhase.STREAMING
    this.streamingPhase = sample.phase ?? null
    this.meter.add(sample.timeMs, weight)
    return true
  }

  /** Which phase the active attempt is currently generating, or `null`. */
  activePhase() {
    return this.streamingPhase
  }

  toolStarted({ callId, name, timeMs }) {
    const wasRunning = this.runningTools().length > 0
    this.tools.set(callId, { callId, name: name ?? 'tool', startMs: timeMs, endMs: null, status: 'running' })
    // A call starting while others run belongs to the same continuous episode;
    // only the first call of a quiet period opens a new one.
    if (!wasRunning) this.toolEpisodeStartMs = timeMs
    this.phase = LivePhase.TOOL
    // The model is not generating while a tool runs, so the attempt window is
    // cleared rather than frozen: a later frame must not read a stale speed.
    this.meter.reset(null)
    this.attemptId = null
  }

  toolSettled({ callId, timeMs, status = 'ok' }) {
    const call = this.tools.get(callId)
    if (call) {
      call.endMs = timeMs
      call.status = status
    }
    if (this.runningTools().length === 0) {
      // The continuous activity interval ended with the last running call.
      this.toolEpisodeStartMs = null
      if (this.phase === LivePhase.TOOL) this.phase = LivePhase.PENDING
    }
  }

  runningTools() {
    return [...this.tools.values()].filter(call => call.endMs === null)
  }

  turnSettled({ timeMs, status = 'completed' }) {
    this.turnEndMs = timeMs
    this.status = status
    this.phase = LivePhase.SETTLED
    this.meter.reset(null)
    this.attemptId = null
  }

  /**
   * Current wall clock, clamped so a paused tab cannot produce negative elapsed
   * times or count samples from the future.
   */
  clock(nowMs) {
    if (!Number.isFinite(nowMs)) return this.lastDeltaMs ?? this.turnStartMs ?? 0
    return Math.max(this.turnStartMs ?? nowMs, nowMs)
  }

  /**
   * The live view snapshot. `tps` is `null` whenever no model attempt is
   * generating, so a renderer cannot accidentally print a stale rate.
   */
  snapshot(nowMs) {
    if (this.turn === null) return { phase: LivePhase.IDLE }
    const now = this.clock(nowMs)
    /**
     * `null`, never `0`, when the turn start was not observed: a page that
     * attaches mid-turn adopts the open turn without its `turn/start` boundary
     * (see `client-feed`), and "elapsed 0 s" would then be a fabricated number
     * for a turn that may have been running for minutes.
     */
    const elapsedMs = Number.isFinite(this.turnStartMs) ? Math.max(0, now - this.turnStartMs) : null
    const base = {
      turn: this.turn,
      phase: this.phase,
      turnElapsedMs: elapsedMs,
      ttftMs: this.firstTokenMs !== null && Number.isFinite(this.turnStartMs)
        ? Math.max(0, this.firstTokenMs - this.turnStartMs)
        : null,
      attemptId: this.attemptId,
      step: this.step,
    }

    if (this.phase === LivePhase.STREAMING && this.meter.attemptId !== null) {
      const tps = this.meter.value(now)
      return {
        ...base,
        tps,
        /**
         * Live TPS is a shape estimate anchored to nothing yet: DSH streams no
         * per-delta token counts, so the value cannot be `exact` until provider
         * usage arrives and calibration happens after settlement.
         */
        tpsQuality: MetricQuality.ESTIMATED,
        activePhase: this.activePhase(),
      }
    }

    if (this.phase === LivePhase.TOOL) {
      const running = this.runningTools()
      return {
        ...base,
        tps: null,
        tpsQuality: MetricQuality.UNAVAILABLE,
        runningToolCount: running.length,
        runningToolNames: running.map(call => call.name),
        /**
         * Wall-clock duration of the current continuous tool-activity episode
         * (the open union interval), not the sum and not merely the oldest
         * still-running call: a call that joined an already-running episode
         * keeps the episode's original start even after the first call ends.
         */
        toolElapsedMs: this.toolEpisodeStartMs === null ? 0 : Math.max(0, now - this.toolEpisodeStartMs),
        toolEpisodeStartMs: this.toolEpisodeStartMs,
      }
    }

    /**
     * Pending — turn open, or an attempt begun with no generated delta yet. The
     * window is knowingly empty, so the value is a measured zero rather than
     * absent evidence: the UI shows a running TTFT counter here, not a rate.
     */
    if (this.phase === LivePhase.PENDING && this.meter.attemptId !== null) {
      return { ...base, tps: 0, tpsQuality: MetricQuality.ESTIMATED }
    }

    return { ...base, tps: null, tpsQuality: MetricQuality.UNAVAILABLE }
  }
}



;Object.assign(__exports, { PHASE, LivePhase, LiveMeter })
			},
			"src/core/delta-accounting.js": function (__exports) {
/**
 * Delta accounting: which DSH stream/chunk shapes contribute to model-output
 * telemetry, and how the compact durable stream runs reconstruct their exact
 * timed delta sequence.
 *
 * Local evidence for these shapes (DSH 0.1.5-rc.2):
 *   @deepseek-ai/dsh-llm/lib/types/types.d.ts:359-389       StreamChunk union
 *   @deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts:16-40  AssistantStreamRecord
 *   @deepseek-ai/dsh-llm/lib/index.js:1206-1246             expandAssistantStream
 *   @deepseek-ai/dsh-llm/lib/index.js:1495-1505             validateRun (dt invariants)
 *   @deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts:72-78  isTokenDelta
 *
 * Nothing here is imported from DSH: `@deepseek-ai/dsh-llm` declares no
 * `dsh.client` manifest, so its modules are not requireable from a browser
 * bundle (see docs/IMPLEMENTATION_LOG.md). This module is the single
 * implementation of the rule for both halves.
 */

/** Content kinds this project accounts for. `null` means "not model output". */
const MODEL_PHASE = Object.freeze({ REASONING: 'reasoning', OUTPUT: 'output' })

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Whether one chunk carries the model's first output token, mirroring DSH's
 * `isTokenDelta`: true for a non-empty text, reasoning or tool-argument
 * fragment and for every name-bearing tool-call delta; false for block, usage
 * and finish chunks.
 *
 * @param {unknown} chunk
 * @returns {boolean}
 */
function isTokenDelta(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return isNonEmptyString(chunk.text)
    case 'tool-call-delta':
      // DSH's predicate is `argumentsDelta !== '' || name !== undefined`, i.e. a
      // name-*bearing* delta qualifies even when the name is the empty string
      // (`dsh-llm/lib/types/assistant-stream.js`, isTokenDelta). The accumulator
      // can emit such a delta: an empty name degrades to a raw `chunk` record,
      // whose expansion restores `name: ''`. Matching DSH exactly matters here
      // because this predicate defines the first-token boundary used by TTFT.
      return isNonEmptyString(chunk.argumentsDelta) || chunk.name !== undefined
    default:
      return false
  }
}

/**
 * Map one StreamChunk to the phase it contributes tokens to.
 *
 * `tool-call-delta.argumentsDelta` is model output: shell commands, file
 * bodies, edit patches and any other tool arguments are generated by the
 * model. Tool results never reach this function.
 *
 * @param {unknown} chunk
 * @returns {'reasoning'|'output'|null}
 */
function classifyDelta(chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  if (chunk.type === 'reasoning-delta' && isNonEmptyString(chunk.text)) return MODEL_PHASE.REASONING
  if (chunk.type === 'text-delta' && isNonEmptyString(chunk.text)) return MODEL_PHASE.OUTPUT
  if (chunk.type === 'tool-call-delta' && isNonEmptyString(chunk.argumentsDelta)) return MODEL_PHASE.OUTPUT
  return null
}

/** Generated text of one chunk, or the empty string for non-generated chunks. */
function deltaText(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  switch (chunk.type) {
    case 'reasoning-delta':
    case 'text-delta':
      return typeof chunk.text === 'string' ? chunk.text : ''
    case 'tool-call-delta':
      return typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
    default:
      return ''
  }
}

/** One in-stream `usage` chunk carries authoritative aggregate usage mid-attempt. */
function usageFromChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  if (chunk.type !== 'usage') return null
  const usage = chunk.usage
  if (!usage || typeof usage !== 'object') return null
  return Number.isFinite(usage.outputTokens) ? usage : null
}

/**
 * Rebuild the exact timed delta sequence of one compact durable stream.
 *
 * `dt` is a per-step gap array with `dt.length === members.length - 1`; member
 * `i > 0` occurs `dt[i - 1]` ms after member `i - 1`
 * (`dsh-llm/lib/index.js:1218-1220`, invariant at `:1499`). Delta boundaries are
 * therefore preserved exactly, which is what lets the completed curve keep real
 * intra-stream stalls after a reload.
 *
 * Malformed records are skipped rather than throwing: a curve with one missing
 * run degrades, while an exception would lose the whole turn card.
 *
 * @param {readonly object[]} records compact `AssistantStreamRecord` values
 * @returns {{timeMs:number, chunk:object}[]} timed chunks in stream order
 */
function expandAssistantStream(records) {
  const out = []
  if (!Array.isArray(records)) return out
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      if (Number.isFinite(record.time) && record.chunk && typeof record.chunk === 'object') {
        out.push({ timeMs: record.time, chunk: record.chunk })
      }
      continue
    }
    const members = runMembers(record)
    if (members === null) continue
    const dt = Array.isArray(record.dt) ? record.dt : null
    if (members.length > 1 && (dt === null || dt.length !== members.length - 1)) continue
    let timeMs = record.time0
    if (!Number.isFinite(timeMs)) continue
    for (let i = 0; i < members.length; i += 1) {
      if (i > 0) {
        const gap = dt[i - 1]
        if (!Number.isFinite(gap)) { timeMs = NaN; break }
        timeMs += gap
      }
      const chunk = runMemberChunk(record, members[i])
      if (chunk === null) continue
      out.push({ timeMs, chunk })
    }
  }
  return out
}

function runMembers(record) {
  if (record.type === 'tool-call-chunks') return Array.isArray(record.args) ? record.args : null
  if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
    return Array.isArray(record.texts) ? record.texts : null
  }
  return null
}

function runMemberChunk(record, member) {
  // A member that is not a string cannot reconstruct a delta; skipping it keeps
  // one malformed member from costing the whole run.
  if (typeof member !== 'string') return null
  if (record.type === 'text-chunks') {
    return { type: 'text-delta', index: record.index, text: member }
  }
  if (record.type === 'reasoning-chunks') {
    return { type: 'reasoning-delta', index: record.index, text: member }
  }
  const chunk = { type: 'tool-call-delta', index: record.index, id: record.id, argumentsDelta: member }
  if (typeof record.name === 'string') chunk.name = record.name
  return chunk
}

/** Time of the first member that {@link isTokenDelta} accepts, or `null`. */
function firstTokenTime(timedChunks) {
  if (!Array.isArray(timedChunks)) return null
  for (const entry of timedChunks) {
    if (!entry || !Number.isFinite(entry.timeMs)) continue
    if (isTokenDelta(entry.chunk)) return entry.timeMs
  }
  return null
}

/**
 * Why one compact stream record could not be decoded exactly.
 *
 * These are the *whole* failure surface. Anything not listed here is decoded,
 * so a caller that sees an empty `issues` array has every original delta
 * boundary, in order, with its exact reconstructed timestamp.
 */
const DECODE_ISSUE = Object.freeze({
  /** The record is not a JSON object. */
  NOT_AN_OBJECT: 'not-an-object',
  /** `record.type` is absent or unrecognized. */
  UNKNOWN_TYPE: 'unknown-type',
  /** The record has keys outside its declared shape. */
  UNEXPECTED_KEYS: 'unexpected-keys',
  /** A required key is missing. */
  MISSING_KEYS: 'missing-keys',
  /** The member array (`texts`/`args`) is absent, not an array, or holds a non-string. */
  BAD_MEMBERS: 'bad-members',
  /** The member array is empty, which the accumulator never produces. */
  EMPTY_RUN: 'empty-run',
  /** `time0`/`time` is not a safe integer. */
  BAD_TIME: 'bad-time',
  /** `dt` is absent, not an array of safe integers, or not exactly members - 1 long. */
  BAD_DT: 'bad-dt',
  /** Reconstructed member times leave the safe-integer range. */
  TIME_OVERFLOW: 'time-overflow',
  /** A tool-call run has no usable `id`. */
  BAD_CALL_ID: 'bad-call-id',
  /** A raw `chunk` record carries no usable chunk object. */
  BAD_RAW_CHUNK: 'bad-raw-chunk',
})

function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function exactKeys(record, keys) {
  const own = Object.keys(record)
  if (own.length !== keys.length) return false
  return keys.every(key => Object.hasOwn(record, key))
}

/** Decide the member array and the issue for one non-`chunk` record. */
function strictRunMembers(type, record) {
  const label = type === 'tool-call-chunks' ? 'args' : 'texts'
  const value = record[label]
  if (!Array.isArray(value)) return { members: null, issue: DECODE_ISSUE.BAD_MEMBERS }
  if (value.some(member => typeof member !== 'string')) return { members: null, issue: DECODE_ISSUE.BAD_MEMBERS }
  // The accumulator always packs at least one member, so an empty run is a
  // malformed record rather than an attempt that produced nothing.
  if (value.length === 0) return { members: null, issue: DECODE_ISSUE.EMPTY_RUN }
  return { members: value, issue: null }
}

/**
 * Strict decoder for DSH's compact durable `AssistantStreamRecord[]`.
 *
 * This is the validating counterpart of {@link expandAssistantStream}, which
 * exists for the tolerant live path. The two differ deliberately:
 *
 *   - `expandAssistantStream` never throws and skips what it cannot read, so a
 *     single corrupt record costs one curve segment instead of the whole card;
 *   - this decoder reports *every* deviation with its record index and never
 *     fabricates a delta. It is the one a durable reconstruction must use,
 *     because a reconstruction that silently drops half a stream would produce
 *     a TPS curve that looks authoritative and is wrong.
 *
 * The validation rules mirror `validateRecord`/`validateRun`
 * (`dsh-llm/lib/types/assistant-stream.js`): exact key sets, non-empty string
 * member arrays, safe-integer `time0`/`time`, `dt.length === members - 1` with
 * safe-integer entries, non-empty `id`, and non-empty `name` when present.
 *
 * @param {unknown} records candidate compact records
 * @returns {{
 *   chunks: {timeMs:number, chunk:object, recordIndex:number, memberIndex:number}[],
 *   issues: {kind:string, recordIndex:number, detail?:unknown}[],
 *   issuesTruncated: boolean,
 *   recordCount: number,
 *   decodedRecordCount: number,
 *   deltaCount: number,
 *   firstTimeMs: number|null,
 *   lastTimeMs: number|null,
 *   complete: boolean,
 * }}
 */
function decodeAssistantStream(records, { maxIssues = 50 } = {}) {
  const chunks = []
  const issues = []
  let issuesTruncated = false
  const list = Array.isArray(records) ? records : null

  const report = (kind, recordIndex, detail) => {
    if (issues.length >= maxIssues) { issuesTruncated = true; return }
    issues.push(detail === undefined ? { kind, recordIndex } : { kind, recordIndex, detail })
  }

  if (list === null) {
    report(Array.isArray(records) ? DECODE_ISSUE.NOT_AN_OBJECT : DECODE_ISSUE.NOT_AN_OBJECT, -1, records)
    return {
      chunks,
      issues,
      issuesTruncated,
      recordCount: 0,
      decodedRecordCount: 0,
      deltaCount: 0,
      firstTimeMs: null,
      lastTimeMs: null,
      complete: false,
    }
  }

  for (let recordIndex = 0; recordIndex < list.length; recordIndex += 1) {
    const candidate = list[recordIndex]
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      report(DECODE_ISSUE.NOT_AN_OBJECT, recordIndex)
      continue
    }
    const type = candidate.type
    if (type === 'chunk') {
      if (!exactKeys(candidate, ['type', 'time', 'chunk'])) {
        report(DECODE_ISSUE.UNEXPECTED_KEYS, recordIndex, Object.keys(candidate))
        continue
      }
      if (!isSafeInteger(candidate.time)) {
        report(DECODE_ISSUE.BAD_TIME, recordIndex, candidate.time)
        continue
      }
      const chunk = candidate.chunk
      if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) {
        report(DECODE_ISSUE.BAD_RAW_CHUNK, recordIndex)
        continue
      }
      chunks.push({ timeMs: candidate.time, chunk, recordIndex, memberIndex: 0 })
      continue
    }

    if (type !== 'text-chunks' && type !== 'reasoning-chunks' && type !== 'tool-call-chunks') {
      report(DECODE_ISSUE.UNKNOWN_TYPE, recordIndex, type)
      continue
    }

    const isToolRun = type === 'tool-call-chunks'
    const memberLabel = isToolRun ? 'args' : 'texts'
    const keys = isToolRun
      ? (Object.hasOwn(candidate, 'name')
        ? ['type', 'time0', 'index', 'dt', 'id', 'name', 'args']
        : ['type', 'time0', 'index', 'dt', 'id', 'args'])
      : ['type', 'time0', 'index', 'dt', 'texts']
    if (!exactKeys(candidate, keys)) {
      const own = Object.keys(candidate)
      const missing = keys.filter(key => !own.includes(key))
      report(missing.length > 0 ? DECODE_ISSUE.MISSING_KEYS : DECODE_ISSUE.UNEXPECTED_KEYS, recordIndex, {
        expected: keys,
        own,
      })
      continue
    }
    if (!isSafeInteger(candidate.time0)) {
      report(DECODE_ISSUE.BAD_TIME, recordIndex, candidate.time0)
      continue
    }
    const membersResult = strictRunMembers(type, candidate)
    if (membersResult.members === null) {
      report(membersResult.issue, recordIndex, candidate[memberLabel])
      continue
    }
    const members = membersResult.members
    const dt = candidate.dt
    if (!Array.isArray(dt) || dt.length !== members.length - 1 || dt.some(gap => !isSafeInteger(gap))) {
      report(DECODE_ISSUE.BAD_DT, recordIndex, { dtLength: Array.isArray(dt) ? dt.length : null, memberCount: members.length })
      continue
    }
    if (isToolRun) {
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
        report(DECODE_ISSUE.BAD_CALL_ID, recordIndex, candidate.id)
        continue
      }
      if (candidate.name !== undefined && (typeof candidate.name !== 'string' || candidate.name.length === 0)) {
        report(DECODE_ISSUE.BAD_MEMBERS, recordIndex, { name: candidate.name })
        continue
      }
    }

    let timeMs = candidate.time0
    let overflowed = false
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      if (memberIndex > 0) {
        timeMs += dt[memberIndex - 1]
        if (!Number.isSafeInteger(timeMs)) { overflowed = true; break }
      }
      const chunk = isToolRun
        ? toolCallChunk(candidate, members[memberIndex])
        : deltaChunk(type, candidate.index, members[memberIndex])
      chunks.push({ timeMs, chunk, recordIndex, memberIndex })
    }
    if (overflowed) {
      // Members already produced stay in `chunks`: dropping them would discard
      // real evidence, and `complete` already reports that the run is short.
      report(DECODE_ISSUE.TIME_OVERFLOW, recordIndex)
    }
  }

  const times = chunks.map(entry => entry.timeMs)
  return {
    chunks,
    issues,
    issuesTruncated,
    recordCount: list.length,
    decodedRecordCount: new Set(chunks.map(entry => entry.recordIndex)).size,
    deltaCount: chunks.length,
    firstTimeMs: times.length > 0 ? Math.min(...times) : null,
    lastTimeMs: times.length > 0 ? Math.max(...times) : null,
    complete: issues.length === 0,
  }
}

function deltaChunk(type, index, text) {
  return type === 'text-chunks'
    ? { type: 'text-delta', index, text }
    : { type: 'reasoning-delta', index, text }
}

function toolCallChunk(record, argumentsDelta) {
  const chunk = { type: 'tool-call-delta', index: record.index, id: record.id, argumentsDelta }
  if (typeof record.name === 'string') chunk.name = record.name
  return chunk
}

;Object.assign(__exports, { MODEL_PHASE, isTokenDelta, classifyDelta, deltaText, usageFromChunk, expandAssistantStream, firstTokenTime, DECODE_ISSUE, decodeAssistantStream })
			},
			"src/core/token-allocation.js": function (__exports) {
const { MetricQuality } = __req("src/core/metric-quality.js")
const { classifyDelta, deltaText } = __req("src/core/delta-accounting.js")

/**
 * Live token-shape weighting and post-hoc calibration.
 *
 * DSH does not attach an exact token count to each streamed delta; provider
 * usage arrives as an aggregate (`TokenUsage`). Every per-delta number this
 * module produces is therefore a *shape*, and the only honest operations are
 * (a) label it estimated and (b) rescale the shape so its integral equals the
 * authoritative aggregate once that aggregate is known.
 *
 * Calibration guarantees, asserted by tests:
 *   - the rescaled per-phase float integral equals the exact aggregate total
 *     exactly (relative error < 1e-9), because the sum of the scaling products
 *     is algebraically the total;
 *   - a phase with tokens but no shape weight distributes evenly rather than
 *     dividing by zero;
 *   - a phase with no samples keeps its authoritative total with zero samples
 *     when the total is zero, and reports the shortfall otherwise instead of
 *     inventing curve points.
 */

/**
 * Fallback shape weight for live display only. This is **not** a tokenizer and
 * must never be presented as provider-exact: the project rules forbid assuming
 * GPT/tiktoken tokenization for DeepSeek or any other route, and DSH's own token
 * meter uses an approximate character heuristic when provider-exact usage is
 * unavailable.
 *
 * CJK-like code points weigh 1; everything else weighs 0.25. The ratio is a
 * deliberate coarse prior (roughly one token per CJK character, roughly four
 * Latin characters per token) whose only role is to shape the live and curve
 * series until calibration replaces it.
 */
function heuristicTokenWeight(text) {
  if (!text) return 0
  let weight = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    const cjk = (cp >= 0x3400 && cp <= 0x9fff)
      || (cp >= 0x3040 && cp <= 0x30ff)
      || (cp >= 0xac00 && cp <= 0xd7af)
      || (cp >= 0xf900 && cp <= 0xfaff)
    weight += cjk ? 1 : 0.25
  }
  return weight
}

/**
 * Build one chart/live sample from a chunk, or `null` when the chunk carries no
 * generated content (block, usage and finish chunks carry none).
 *
 * @param {number} timeMs
 * @param {unknown} chunk
 * @param {(text:string, phase:string, chunk:unknown)=>number} [estimate]
 */
function sampleFromChunk(timeMs, chunk, estimate = heuristicTokenWeight) {
  const phase = classifyDelta(chunk)
  if (phase === null) return null
  if (!Number.isFinite(timeMs)) return null
  const text = deltaText(chunk)
  const weight = estimate(text, phase, chunk)
  if (!(weight > 0) || !Number.isFinite(weight)) {
    // A generated delta whose shape weight is zero is still evidence that
    // generation happened. Give it a minimal non-zero shape so it cannot vanish
    // from the series; calibration later fixes its magnitude.
    return { timeMs, phase, weight: Number.EPSILON, tokens: Number.EPSILON, quality: MetricQuality.ESTIMATED }
  }
  return { timeMs, phase, weight, tokens: weight, quality: MetricQuality.ESTIMATED }
}

/** Sample a whole timed chunk list, dropping non-generated chunks. */
function samplesFromTimedChunks(timedChunks, estimate = heuristicTokenWeight) {
  const out = []
  if (!Array.isArray(timedChunks)) return out
  for (const entry of timedChunks) {
    if (!entry) continue
    const sample = sampleFromChunk(entry.timeMs, entry.chunk, estimate)
    if (sample !== null) out.push(sample)
  }
  return out
}

/**
 * Rescale one phase's shape weights so their integral equals `exactTokens`.
 * Pure: returns new objects and never mutates the input.
 */
function calibratePhase(samples, exactTokens) {
  if (!Array.isArray(samples)) return []
  if (!Number.isFinite(exactTokens) || exactTokens < 0) return samples.slice()
  if (samples.length === 0) return []
  const totalWeight = samples.reduce((sum, s) => sum + Math.max(0, s.weight ?? 0), 0)
  const each = exactTokens / samples.length
  if (!(totalWeight > 0)) {
    return samples.map(s => ({ ...s, tokens: each, quality: MetricQuality.CALIBRATED }))
  }
  const scale = exactTokens / totalWeight
  return samples.map(s => ({
    ...s,
    tokens: Math.max(0, s.weight ?? 0) * scale,
    quality: MetricQuality.CALIBRATED,
  }))
}

/**
 * Calibrate one attempt's samples against authoritative provider usage and
 * report how trustworthy the reasoning/output split is.
 *
 * `reasoningTokens`, when present, is already included in `outputTokens`
 * (verified local contract at `dsh-llm/lib/types/types.d.ts:136-150`), so the
 * non-reasoning output total is `outputTokens - reasoningTokens`. The two
 * counters are never added.
 *
 * @param {readonly object[]} samples
 * @param {{outputTokens?:number, reasoningTokens?:number}|null|undefined} usage
 * @returns {{
 *   samples: object[],
 *   phaseTokens: {reasoning:number|null, output:number|null},
 *   totalTokens: number|null,
 *   totalQuality: string,
 *   splitQuality: string,
 *   totalAnchored: boolean,
 *   note: string|null,
 * }}
 */
function calibrateAttemptSamples(samples, usage) {
  const list = Array.isArray(samples) ? samples : []
  const outputTokens = usage?.outputTokens
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    return {
      // No authoritative anchor exists, so the per-delta allocation stays at the
      // raw shape weight and is labelled `estimated`. It is never presented as a
      // token count.
      samples: list.map(s => ({
        ...s,
        tokens: Math.max(0, s.weight ?? 0),
        quality: MetricQuality.ESTIMATED,
      })),
      phaseTokens: { reasoning: null, output: null },
      totalTokens: null,
      totalQuality: MetricQuality.UNAVAILABLE,
      splitQuality: MetricQuality.UNAVAILABLE,
      totalAnchored: false,
      note: 'no authoritative usage',
    }
  }

  const reasoningTokens = usage?.reasoningTokens
  const splitExact = Number.isFinite(reasoningTokens) && reasoningTokens >= 0

  if (splitExact) {
    const reasoningTotal = Math.max(0, reasoningTokens)
    const outputTotal = Math.max(0, outputTokens - reasoningTotal)
    const reasoningSamples = calibratePhase(list.filter(s => s.phase === 'reasoning'), reasoningTotal)
    const outputSamples = calibratePhase(list.filter(s => s.phase === 'output'), outputTotal)
    let ri = 0
    let oi = 0
    const merged = list.map(s => (s.phase === 'reasoning' ? reasoningSamples[ri++] : outputSamples[oi++]))
    const missing = []
    if (reasoningTotal > 0 && reasoningSamples.length === 0) missing.push('reasoning')
    if (outputTotal > 0 && outputSamples.length === 0) missing.push('output')
    return {
      samples: merged,
      phaseTokens: { reasoning: reasoningTotal, output: outputTotal },
      totalTokens: outputTokens,
      totalQuality: MetricQuality.EXACT,
      splitQuality: missing.length > 0 ? MetricQuality.UNAVAILABLE : MetricQuality.EXACT,
      totalAnchored: true,
      note: missing.length > 0
        ? `authoritative ${missing.join(' and ')} tokens reported but the stream carried no such deltas`
        : null,
    }
  }

  // Only the combined output total is authoritative. Rescale every sample by one
  // common factor so the whole-attempt integral matches exactly, and mark the
  // reasoning/output split estimated: the split was never measured, so claiming
  // it is exact would be a fabrication (docs/METRICS_SPEC.md §8.3).
  const phaseWeights = { reasoning: 0, output: 0 }
  for (const s of list) {
    if (s.phase === 'reasoning') phaseWeights.reasoning += Math.max(0, s.weight ?? 0)
    else if (s.phase === 'output') phaseWeights.output += Math.max(0, s.weight ?? 0)
  }
  const totalWeight = phaseWeights.reasoning + phaseWeights.output
  const scale = totalWeight > 0 ? outputTokens / totalWeight : 0
  const rescaled = list.map(s => ({
    ...s,
    tokens: totalWeight > 0
      ? Math.max(0, s.weight ?? 0) * scale
      : (list.length > 0 ? outputTokens / list.length : 0),
    quality: MetricQuality.CALIBRATED,
  }))
  return {
    samples: rescaled,
    phaseTokens: {
      reasoning: totalWeight > 0 ? phaseWeights.reasoning * scale : null,
      output: totalWeight > 0 ? phaseWeights.output * scale : null,
    },
    totalTokens: outputTokens,
    totalQuality: MetricQuality.EXACT,
    splitQuality: MetricQuality.ESTIMATED,
    totalAnchored: true,
    note: 'reasoningTokens absent: whole-attempt integral anchored, reasoning/output split estimated',
  }
}

;Object.assign(__exports, { heuristicTokenWeight, sampleFromChunk, samplesFromTimedChunks, calibratePhase, calibrateAttemptSamples })
			},
			"src/core/time-axis.js": function (__exports) {
/**
 * The compressed curve clock.
 *
 * The completed chart diagnoses model throughput stability, not end-to-end turn
 * latency, so its x-axis is an *active model-generation* coordinate:
 *
 *   - an attempt's local x = 0 is its first non-empty generated delta, so the
 *     attempt's own TTFT consumes no width;
 *   - distances between deltas inside one attempt are preserved exactly, which
 *     keeps real intra-stream stalls visible;
 *   - an attempt's local x ends at its **last** generated delta. Nothing is
 *     allocated after it — not for the host settlement, not for the next call's
 *     TTFT and not for the one-second window the last tokens decay over;
 *   - the next attempt starts at the previous attempt's last delta, so tools,
 *     inter-attempt waiting and the next call's TTFT consume no width.
 *
 * The last two rules are one rule applied to every attempt, including the final
 * one: the axis is model generation, and a per-attempt window decay is a
 * measurement convention rather than generation. The final attempt is not a
 * special case.
 *
 * Formally this is a piecewise-linear remap of wall time. It is implemented as
 * explicit per-attempt concatenation rather than as one global clock minus
 * subtracted wall intervals, because concatenation cannot silently mis-attribute
 * a gap that spans a boundary.
 *
 * **Two clocks per sample, and conflating them is a real defect.** Each
 * compressed sample carries both, because the curve needs both:
 *
 *   - `activeTimeMs` is the **turn-compressed coordinate**, continuous across
 *     attempts. It is what the x-axis is drawn against and what `phaseRuns`
 *     reports its intervals in;
 *   - `attemptTimeMs` is the **attempt-local** instant, measured from that
 *     attempt's own first delta. A trailing one-second TPS window is defined on
 *     *this* clock: it is a property of one model call, not of the concatenated
 *     axis.
 *
 * The earlier revision published only `activeTimeMs` and then filtered it per
 * attempt. For the first attempt the two happen to coincide, so the code looked
 * correct; for every later attempt the "local" window silently started at the
 * turn-global offset and its opening vertices read a rate assembled from nothing
 * (`test/curve-attempt-boundary.test.js`).
 *
 * A tool gap therefore has zero coordinate width *and* remains an absolute window
 * boundary. Compressed coordinates being continuous does not make the statistical
 * window continuous, and code that conflates the two credits one model call with
 * another call's tokens.
 */

/**
 * @param {readonly {attemptId?:string, samples?:readonly object[]}[]} attempts
 * @returns {{
 *   samples: object[],
 *   durationMs: number,
 *   segments: {
 *     attemptId:string|null, startMs:number, endMs:number, localEndMs:number,
 *     sampleCount:number,
 *   }[],
 * }}
 */
function compressAttempts(attempts) {
  const out = []
  const segments = []
  let offsetMs = 0
  if (!Array.isArray(attempts)) return { samples: out, durationMs: 0, segments }

  for (const attempt of attempts) {
    if (!attempt) continue
    const stored = Array.isArray(attempt.samples)
      ? attempt.samples.filter(s => s && Number.isFinite(s.timeMs))
      : []
    /**
     * **The stored arrays are the authoritative order.** `TurnTelemetryStore.acceptChunk`
     * appends, and both reconstruction paths preserve the decoded member order —
     * `attemptFromDecoded` walks `decoded.chunks` in order and the live path appends each
     * frame as it arrives. Position in the array is therefore the order the model's stream
     * delivered the deltas in, and it is the only evidence of that order this project has.
     *
     * The ordinal is captured **before** any timestamp sort, so a delta that arrives later
     * but carries an earlier clock still sorts after its predecessor at the same instant.
     * It is published as `sampleOrder` so nothing downstream has to infer the order from a
     * phase name or from whichever array a caller happens to hand in.
     */
    const ordered = stored.map((sample, index) => ({
      sample,
      sampleOrder: Number.isFinite(sample.sampleOrder) ? sample.sampleOrder : index,
    }))
    ordered.sort((a, b) => (
      a.sample.timeMs - b.sample.timeMs
      || a.sampleOrder - b.sampleOrder
    ))
    const samples = ordered.map(entry => entry.sample)
    if (samples.length === 0) continue
    const first = samples[0].timeMs
    const last = samples[samples.length - 1].timeMs
    const attemptId = attempt.attemptId ?? null
    for (const entry of ordered) {
      const localMs = Math.max(0, entry.sample.timeMs - first)
      out.push({
        ...entry.sample,
        attemptId,
        /** Attempt-local instant: the clock the rolling window is measured on. */
        attemptTimeMs: localMs,
        /** Turn-compressed coordinate: the clock the chart is drawn against. */
        activeTimeMs: offsetMs + localMs,
        /** Authoritative stream ordinal, so the tie-break at one instant is stated, not implied. */
        sampleOrder: entry.sampleOrder,
      })
    }
    const span = Math.max(0, last - first)
    segments.push({
      attemptId,
      startMs: offsetMs,
      endMs: offsetMs + span,
      /** The attempt's own width, so a caller need not re-derive it. */
      localEndMs: span,
      sampleCount: samples.length,
    })
    offsetMs += span
  }

  /**
   * **Every segment's `endMs` is the attempt's last model-producing delta**, and therefore
   * also the coordinate at which the next attempt opens. Those are the same instant by
   * construction — the concatenation is what removes tool wait and next-call TTFT from the
   * axis — so no separate "where the next attempt starts" field is published, and no field
   * distinguishes the final attempt from any other.
   *
   * The previous revision published `hasSuccessor`/`nextStartMs` and used the pair to give
   * the **final** attempt one window of extra sampled tail, on the reasoning that nothing
   * followed it to compete for those coordinates. That rule was wrong about what the axis
   * measures: a vertex past the last delta is post-generation time, which `docs/METRICS_SPEC.md`
   * §7 excludes from generation duration and §8.1 excludes from the axis. Because
   * `curve.durationMs` is the sum of these spans, those vertices carried coordinates above
   * the chart's own duration and every one of them was clamped onto `x = 100` — a vertical
   * stroke at the right edge that no delta produced
   * (`test/curve-axis-endpoint.test.js`).
   */

  return { samples: out, durationMs: offsetMs, segments }
}

;Object.assign(__exports, { compressAttempts })
			},
			"src/core/quality-model.js": function (__exports) {
/**
 * Three-axis metric quality model.
 *
 * A single quality label for a whole curve cannot express what the evidence
 * actually supports. The same turn routinely has an exactly known token total, an
 * estimated reasoning/output split, and a reconstructed temporal shape, and
 * collapsing those into one word forces one of them to be misreported.
 *
 * Three axes are therefore tracked independently:
 *
 *   tokenTotalQuality     how well the *total* generated tokens are known
 *   phaseSplitQuality     how well that total is divided into reasoning vs output
 *   temporalShapeQuality  how well the *timing* of generation is known
 *
 * Their acceptance criteria are the semantic examples frozen in
 * `docs/METRICS_SPEC.md`. The strongest achievable value differs per axis, and
 * that asymmetry is the point:
 *
 *   - `tokenTotalQuality` can reach `exact`, because providers report aggregate
 *     output tokens;
 *   - `phaseSplitQuality` can reach `exact`, because some routes also report
 *     `reasoningTokens` — and only then, because a split nobody measured must
 *     never be called exact;
 *   - `temporalShapeQuality` can **never** reach `exact`. DSH attaches no token
 *     count to a delta, so every curve point is a shape weight, rescaled or not.
 *     The best achievable value is `reconstructed`: exact phase integrals on an
 *     estimated local shape. This is enforced structurally by the per-axis
 *     maximum below, not by convention.
 */

const { MetricQuality } = __req("src/core/metric-quality.js")

/**
 * Ordered weakest-to-strongest. `partial` and `reconstructed` are additions to
 * the four frozen levels, not replacements: `partial` distinguishes "some
 * contributors were authoritative and some were not" from a wholesale estimate,
 * and `reconstructed` distinguishes "shape weight with an exact anchor and exact
 * timing" from "rough estimate".
 */
const QualityLevel = Object.freeze({
  UNAVAILABLE: 'unavailable',
  ESTIMATED: 'estimated',
  PARTIAL: 'partial',
  RECONSTRUCTED: 'reconstructed',
  CALIBRATED: 'calibrated',
  EXACT: 'exact',
})

const RANK = Object.freeze({
  [QualityLevel.UNAVAILABLE]: 0,
  [QualityLevel.ESTIMATED]: 1,
  [QualityLevel.PARTIAL]: 2,
  [QualityLevel.RECONSTRUCTED]: 3,
  [QualityLevel.CALIBRATED]: 4,
  [QualityLevel.EXACT]: 5,
})

/** The strongest value each axis may ever carry. */
const QUALITY_CEILING = Object.freeze({
  tokenTotal: QualityLevel.EXACT,
  phaseSplit: QualityLevel.EXACT,
  temporalShape: QualityLevel.RECONSTRUCTED,
})

const QUALITY_AXIS = Object.freeze({
  TOKEN_TOTAL: 'tokenTotal',
  PHASE_SPLIT: 'phaseSplit',
  TEMPORAL_SHAPE: 'temporalShape',
})

/** Whether a value is one of the six declared levels. */
function isQualityLevel(value) {
  return Object.hasOwn(RANK, value)
}

/** The weaker of two levels. */
function weakestLevel(a, b) {
  if (!isQualityLevel(a)) return QualityLevel.UNAVAILABLE
  if (!isQualityLevel(b)) return QualityLevel.UNAVAILABLE
  return RANK[a] <= RANK[b] ? a : b
}

/** Clamp a level to its axis ceiling. */
function clampToAxis(axis, level) {
  const ceiling = QUALITY_CEILING[axis]
  if (ceiling === undefined) return QualityLevel.UNAVAILABLE
  if (!isQualityLevel(level)) return QualityLevel.UNAVAILABLE
  return RANK[level] <= RANK[ceiling] ? level : ceiling
}

/**
 * Quality of the generated-token total.
 *
 * @param {{
 *   contributingAttemptCount: number,
 *   attemptsWithUsage: number,
 *   recoveredTotals: number,
 *   reportedTotals: number,
 * }} input
 */
function tokenTotalQuality({
  contributingAttemptCount = 0,
  attemptsWithUsage = 0,
  recoveredTotals = 0,
  reportedTotals = 0,
} = {}) {
  if (contributingAttemptCount === 0) return QualityLevel.UNAVAILABLE
  if (attemptsWithUsage === 0) return QualityLevel.UNAVAILABLE
  if (recoveredTotals > 0) return QualityLevel.PARTIAL
  if (attemptsWithUsage === contributingAttemptCount) return QualityLevel.EXACT
  if (reportedTotals > 0) return QualityLevel.PARTIAL
  return QualityLevel.UNAVAILABLE
}

/**
 * Quality of the reasoning/output split.
 *
 * A split is only `exact` when every contributing attempt that carries the total
 * also carries an authoritative `reasoningTokens`. When the totals are exact but
 * the split is not, the honest answer is `estimated`: the shape prior still divides
 * the anchored total, and that division was never measured.
 *
 * When *some* contributors reported the counter and some did not, this axis answers
 * `estimated` rather than the token-total axis's `partial`. That asymmetry is
 * deliberate and is the two axes disagreeing on purpose: `tokenTotalQuality` is a
 * sum, so the sum of the attempts that reported is a real, publishable quantity
 * that is merely incomplete; the split is a *division*, and a division over a
 * population where one member has no counter cannot be published as partly
 * measured. It stays `estimated` — the shape prior still divides an anchored
 * total — which is the conservative answer and the one `docs/METRICS_SPEC.md`
 * §8.3 records.
 *
 * `reasoningStreamConflict` is the consistency guard: a provider that reports
 * `reasoningTokens === 0` while the stream carries non-empty reasoning deltas
 * contradicts itself, and a split derived from that counter can never be
 * `exact` however many attempts reported it.
 */
function phaseSplitQuality({
  contributingAttemptCount = 0,
  attemptsWithSplit = 0,
  attemptsWithUsage = 0,
  splitIsAnchored = false,
  hasReasoningDeltas = false,
  hasOutputDeltas = false,
  reasoningStreamConflict = false,
} = {}) {
  if (contributingAttemptCount === 0) return QualityLevel.UNAVAILABLE
  if (attemptsWithSplit === 0) {
    // No counter at all. If only one phase is present in the stream, the other
    // phase is empty by observation rather than by assumption, and the reported
    // split is still a shape division of an authoritative total.
    if (!hasReasoningDeltas && !hasOutputDeltas) return QualityLevel.UNAVAILABLE
    return attemptsWithUsage > 0 ? QualityLevel.ESTIMATED : QualityLevel.UNAVAILABLE
  }
  if (attemptsWithSplit === contributingAttemptCount && !reasoningStreamConflict) return QualityLevel.EXACT
  return QualityLevel.ESTIMATED
}

/**
 * Quality of the temporal shape.
 *
 * `durable` and `timestampsComplete` describe the *evidence*, not the accuracy:
 * reconstructed timestamps are exact copies of the original envelope times, but
 * the token magnitude carried at each timestamp is a shape weight, so no timing
 * evidence can lift the axis past `reconstructed`.
 */
function temporalShapeQuality({
  durable = false,
  timestampsComplete = true,
  anchored = false,
  sampleCount = 0,
} = {}) {
  if (sampleCount === 0) return QualityLevel.UNAVAILABLE
  // Anchored means the phase integrals are the authoritative provider totals;
  // unanchored means the curve is still raw shape weight magnitudes.
  if (!anchored) return QualityLevel.ESTIMATED
  if (!timestampsComplete) return QualityLevel.ESTIMATED
  // `durable` records *where* the timestamps came from. A durable settlement's
  // embedded stream reproduces the original envelope times exactly, which is
  // why the anchored durable case reads `reconstructed` while a live one does
  // not: the live pane can be re-baselined or lose frames.
  return durable ? QualityLevel.RECONSTRUCTED : QualityLevel.ESTIMATED
}

/**
 * Assemble the three-axis quality object, enforcing the ceilings.
 *
 * @returns {{
 *   tokenTotalQuality: string,
 *   phaseSplitQuality: string,
 *   temporalShapeQuality: string,
 *   approximateTokenTotal: boolean,
 *   approximatePhaseSplit: boolean,
 *   displayTokenTotal: 'exact'|'approximate'|'unavailable',
 *   displayPhaseSplit: 'exact'|'approximate'|'unavailable',
 *   notes: string[],
 * }}
 */
function qualityAxes(input = {}) {
  const tokenTotal = clampToAxis(QUALITY_AXIS.TOKEN_TOTAL, tokenTotalQuality(input))
  let phaseSplit = clampToAxis(QUALITY_AXIS.PHASE_SPLIT, phaseSplitQuality(input))
  // A split cannot be better known than the total it divides.
  phaseSplit = weakestLevel(phaseSplit, tokenTotal)
  // The consistency guard is a hard ceiling on this axis: provider aggregate
  // usage contradicting the stream's phase evidence downgrades the split to at
  // most `estimated`, regardless of how many attempts reported the counter.
  if (input.reasoningStreamConflict === true) {
    phaseSplit = weakestLevel(phaseSplit, QualityLevel.ESTIMATED)
  }
  const temporalShape = clampToAxis(QUALITY_AXIS.TEMPORAL_SHAPE, temporalShapeQuality(input))

  const notes = []
  if (input.recoveredTotals > 0) {
    notes.push(`${input.recoveredTotals} of ${input.contributingAttemptCount} attempts reported no usage; their totals were recovered from the stream`)
  }
  if (input.reasoningStreamConflict === true) {
    notes.push('provider reported reasoningTokens=0 while the stream carries reasoning deltas; the reasoning/output split is downgraded')
  }
  if (tokenTotal === QualityLevel.EXACT && phaseSplit !== QualityLevel.EXACT && input.reasoningStreamConflict !== true) {
    notes.push('generated-token total is authoritative but the reasoning/output split is not reported by the provider')
  }
  if (temporalShape === QualityLevel.RECONSTRUCTED) {
    notes.push('phase integrals are anchored to authoritative totals; the local curve shape remains a delta-shape estimate')
  }

  return {
    tokenTotalQuality: tokenTotal,
    phaseSplitQuality: phaseSplit,
    temporalShapeQuality: temporalShape,
    approximateTokenTotal: tokenTotal !== QualityLevel.EXACT,
    approximatePhaseSplit: phaseSplit !== QualityLevel.EXACT,
    displayTokenTotal: displayMode(tokenTotal),
    displayPhaseSplit: displayMode(phaseSplit),
    notes,
  }
}

function displayMode(level) {
  if (level === QualityLevel.EXACT) return 'exact'
  if (level === QualityLevel.UNAVAILABLE) return 'unavailable'
  return 'approximate'
}

/**
 * Whether a rate or chart value derived from these axes must render with an
 * approximate marker. Live values are always approximate: no per-delta provider
 * count exists, so nothing measured live can be `exact`.
 */
function requiresApproximateMarker(level) {
  return level !== QualityLevel.EXACT && level !== QualityLevel.UNAVAILABLE
}



;Object.assign(__exports, { MetricQuality, QualityLevel, QUALITY_CEILING, QUALITY_AXIS, isQualityLevel, weakestLevel, clampToAxis, tokenTotalQuality, phaseSplitQuality, temporalShapeQuality, qualityAxes, requiresApproximateMarker })
			},
			"src/core/tool-timing.js": function (__exports) {
/**
 * Tool latency: per-call durations plus the two required aggregates.
 *
 * `workMs` is the arithmetic sum of every completed call duration.
 * `wallMs` is the measure of the **union** of the same intervals, so parallel
 * calls are not counted twice. `workMs >= wallMs` always holds, with equality
 * exactly when no two counted calls overlap (docs/METRICS_SPEC.md §5).
 *
 * A call with no result yet is running and contributes to neither total: an open
 * interval has no measurable duration, and treating its "duration so far" as
 * completed latency would double-count when it closes.
 */

/** Merge completed intervals and return their union length in ms. */
function unionDurationMs(intervals) {
  const normalized = intervals
    .filter(x => x && Number.isFinite(x.startMs) && Number.isFinite(x.endMs) && x.endMs >= x.startMs)
    .map(x => ({ startMs: x.startMs, endMs: x.endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  if (!normalized.length) return 0
  let total = 0
  let start = normalized[0].startMs
  let end = normalized[0].endMs
  for (let i = 1; i < normalized.length; i += 1) {
    const next = normalized[i]
    if (next.startMs <= end) {
      end = Math.max(end, next.endMs)
    } else {
      total += end - start
      start = next.startMs
      end = next.endMs
    }
  }
  return total + end - start
}

function isCompleted(call) {
  return call
    && Number.isFinite(call.startMs)
    && Number.isFinite(call.endMs)
    && call.endMs >= call.startMs
}

/**
 * Summarize a turn's tool calls.
 *
 * @param {readonly object[]} calls normalized `ToolCallRecord` values
 */
function summarizeToolCalls(calls) {
  const list = (Array.isArray(calls) ? calls : []).filter(call => call && typeof call === 'object')
  const completed = list.filter(isCompleted)
  const intervals = completed.map(call => ({ startMs: call.startMs, endMs: call.endMs }))
  const running = list.filter(call => !isCompleted(call))
  return {
    /** Every call seen, running or settled. */
    count: list.length,
    /** Calls with a result, i.e. the calls the two durations describe. */
    completedCount: completed.length,
    /** Calls whose result has not arrived. */
    runningCount: running.length,
    /** Sum of completed individual durations. */
    workMs: completed.reduce((sum, call) => sum + call.endMs - call.startMs, 0),
    /** Union of the same intervals; the figure the compact UI shows. */
    wallMs: unionDurationMs(intervals),
    failedCount: list.filter(call => call.status === 'error' || call.status === 'failed').length,
    cancelledCount: list.filter(call => call.status === 'cancelled').length,
    /** Distinct tool names in first-seen order, for the compact `a, b +1` label. */
    names: [...new Set(list.map(call => call && call.name).filter(name => typeof name === 'string' && name.length > 0))],
  }
}

;Object.assign(__exports, { unionDurationMs, summarizeToolCalls })
			},
			"src/core/aggregate-turn.js": function (__exports) {
/**
 * Attempt-level reduction and turn-level aggregation.
 *
 * The statistical unit is the whole **turn**. A turn may contain several model
 * attempts, retries and tool calls, and the completed TPS values are ratios of
 * turn-level sums:
 *
 *   reasoning TPS = sum(reasoning tokens) / sum(reasoning generation time)
 *   output TPS    = sum(non-reasoning output tokens) / sum(output generation time)
 *
 * An arithmetic mean of per-step or per-attempt TPS values is never computed
 * here or anywhere else (docs/METRICS_SPEC.md §1, §7).
 *
 * Provider usage semantics: `reasoningTokens`, when present, is already included
 * in `outputTokens`, so non-reasoning output is `outputTokens - reasoningTokens`.
 * The two counters are never added.
 */

const { MetricQuality, rateQuality, weakestQuality } = __req("src/core/metric-quality.js")
const { QualityLevel, qualityAxes, QUALITY_AXIS, clampToAxis } = __req("src/core/quality-model.js")
const { summarizeToolCalls } = __req("src/core/tool-timing.js")
const { attributePhaseDurations, PHASE } = __req("src/core/phase-duration.js")
const { calibrateAttemptSamples } = __req("src/core/token-allocation.js")

/** Mask a usage object into the fields this project reads, or `null` when unusable. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const outputTokens = usage.outputTokens
  if (!Number.isFinite(outputTokens) || outputTokens < 0) return null
  const reasoningTokens = Number.isFinite(usage.reasoningTokens) && usage.reasoningTokens >= 0
    ? usage.reasoningTokens
    : null
  return {
    outputTokens,
    reasoningTokens,
    nonReasoningTokens: reasoningTokens === null ? null : Math.max(0, outputTokens - reasoningTokens),
  }
}

/**
 * Whether an attempt contributes a phase denominator to the turn.
 *
 * An attempt that produced no generated delta contributes nothing measurable and
 * must not appear in a turn, because including it would introduce a zero-length
 * phase and make the aggregate look worse than the evidence supports. An attempt
 * that produced generated deltas does contribute even when it settled without a
 * surface message or its outcome is unknown: its observed generation time really
 * was spent on this turn.
 */
function isContributingAttempt(attempt) {
  return Array.isArray(attempt?.samples) && attempt.samples.length > 0
}

/**
 * Reduce one normalized attempt to its measured facts.
 *
 * @param {object} attempt `{attemptId, turn, step, samples, usage, status}`
 */
function reduceAttempt(attempt) {
  const samples = Array.isArray(attempt?.samples) ? attempt.samples : []
  const durations = attributePhaseDurations(samples)
  const usage = normalizeUsage(attempt?.usage)
  const calibration = calibrateAttemptSamples(samples, usage ?? undefined)

  const reasoningTokens = calibration.phaseTokens.reasoning
  const outputTokens = calibration.phaseTokens.output
  const totalTokens = calibration.totalTokens
  // With no authoritative usage the phase totals are unknown; the per-phase
  // allocation sum is then the raw shape weight, which is reported as a shape
  // rather than as a token count.
  const shapeReasoning = phaseShapeSum(calibration.samples, 'reasoning')
  const shapeOutput = phaseShapeSum(calibration.samples, 'output')

  return {
    attemptId: attempt?.attemptId ?? null,
    turn: attempt?.turn ?? null,
    step: attempt?.step ?? null,
    /** Settlement type, surface visibility and execution outcome stay separate. */
    settlementKind: attempt?.settlementKind ?? 'none',
    surfaceCommitted: attempt?.surfaceCommitted === true,
    attemptOutcome: attempt?.attemptOutcome ?? 'unknown',
    sampleCount: samples.length,
    /**
     * Whether the stream carries at least one non-empty reasoning delta. This
     * is the stream-side evidence half of the `reasoningTokens = 0` consistency
     * guard: provider aggregate usage and stream phase evidence must agree
     * before a split may be called exact.
     */
    hasReasoningStream: samples.some(sample => sample.phase === 'reasoning'),
    reasoningMs: durations.reasoningMs,
    outputMs: durations.outputMs,
    spanMs: durations.spanMs,
    usage,
    /** Where the usage came from, so a recovered total stays distinguishable. */
    usageSource: attempt?.usageSource ?? (usage === null ? null : 'attempt'),
    /** Whether this attempt's per-delta allocation is anchored to a total. */
    totalAnchored: calibration.totalAnchored,
    calibration,
    reasoningTokens,
    outputTokens,
    totalTokens,
    shapeReasoning,
    shapeOutput,
    /** Anchored to usage but not split exactly. */
    splitQuality: calibration.splitQuality,
  }
}

function phaseShapeSum(samples, phase) {
  let sum = 0
  for (const sample of samples) {
    if (sample.phase === phase) sum += sample.tokens ?? sample.weight ?? 0
  }
  return sum
}

/**
 * Turn-level aggregation.
 *
 * @param {{
 *   turn?: number|null,
 *   sessionId?: string|null,
 *   turnStartMs?: number,
 *   turnEndMs?: number|null,
 *   firstTokenMs?: number|null,
 *   attempts?: readonly object[],
 *   tools?: readonly object[],
 *   status?: 'completed'|'interrupted'|'errored',
 * }} [input]
 */
function aggregateTurn(input = {}) {
  const attempts = Array.isArray(input.attempts) ? input.attempts : []
  const tools = Array.isArray(input.tools) ? input.tools : []
  const status = input.status ?? 'completed'

  const contributing = attempts.filter(isContributingAttempt)
  const reduced = contributing.map(reduceAttempt)
  /** Attempts that never emitted a generated delta: real events, no throughput evidence. */
  const emptyAttemptCount = attempts.length - contributing.length

  const withUsage = reduced.filter(a => a.usage !== null)
  const usageComplete = reduced.length > 0 && withUsage.length === reduced.length
  const splitComplete = usageComplete && withUsage.every(a => a.usage.reasoningTokens !== null)

  /**
   * Consistency guard: provider aggregate usage versus stream phase evidence.
   * An attempt whose stream carries non-empty reasoning deltas while its usage
   * reports `reasoningTokens === 0` is an internal contradiction in the
   * evidence. The authoritative `outputTokens` total stays trusted (it is the
   * only total the provider reports), but the reasoning/output split derived
   * from the conflicting counter may never be called exact, and the conflict
   * must be reported rather than silently ignored.
   */
  const consistencyIssues = []
  for (const attempt of reduced) {
    if (attempt.usage === null || attempt.usage.reasoningTokens !== 0) continue
    if (!attempt.hasReasoningStream) continue
    consistencyIssues.push(
      `attempt ${attempt.attemptId ?? attempt.step ?? '?'}: provider reported reasoningTokens=0 `
      + 'but the stream carries non-empty reasoning deltas; the phase split is downgraded',
    )
  }
  const splitConflict = consistencyIssues.length > 0

  // Authoritative token totals. A missing counter is never silently treated as
  // zero: when coverage is incomplete the turn total is reported as unavailable
  // together with the partial sum that *is* observed, so the UI can show "≈" or
  // "—" honestly instead of under-reporting.
  const observedGeneratedTokens = withUsage.reduce((sum, a) => sum + a.usage.outputTokens, 0)
  const generatedTokens = usageComplete ? observedGeneratedTokens : null
  const observedReasoningTokens = splitComplete
    ? withUsage.reduce((sum, a) => sum + a.usage.reasoningTokens, 0)
    : null
  const observedNonReasoningTokens = splitComplete
    ? withUsage.reduce((sum, a) => sum + a.usage.nonReasoningTokens, 0)
    : null

  // Phase denominators: sums of measured generation time. Attempts whose phase
  // duration is not measurable (fewer than two generated deltas in that phase)
  // are excluded from the sum and counted, so the rate can be marked optimistic
  // rather than exact.
  const reasoningDurations = reduced.map(a => a.reasoningMs)
  const outputDurations = reduced.map(a => a.outputMs)
  const reasoningMs = reasoningDurations.reduce((sum, ms) => sum + (ms ?? 0), 0)
  const outputMs = outputDurations.reduce((sum, ms) => sum + (ms ?? 0), 0)
  const reasoningMeasured = reasoningDurations.filter(ms => ms !== null && ms > 0).length
  const outputMeasured = outputDurations.filter(ms => ms !== null && ms > 0).length

  /**
   * Per-attempt phase allocations summed across the turn. For an attempt with
   * usage these are calibrated values anchored to the authoritative total, so
   * their sum equals that total exactly; for an attempt without usage they are
   * raw shape weights. They are the *only* per-phase token magnitudes this
   * project has when the provider reports no `reasoningTokens`, and
   * `calibrateAttemptSamples` already rescales them so each attempt's phases sum
   * to that attempt's authoritative total — which is what makes an anchored
   * division of a known total honest, and what makes the unanchored case read as
   * `≈`. Rounding across many attempts can leave the sum a fraction off the
   * total, so the output phase absorbs the residual; the reported pair therefore
   * always adds up to the reported total.
   */
  const allocatedTokens = reduced.reduce(
    (sum, a) => ({
      reasoning: sum.reasoning + (a.reasoningTokens ?? a.shapeReasoning),
      output: sum.output + (a.outputTokens ?? a.shapeOutput),
    }),
    { reasoning: 0, output: 0 },
  )
  const allocatedTotal = allocatedTokens.reasoning + allocatedTokens.output
  /**
   * The residual correction is applied **only** when an authoritative total
   * exists to correct toward. Without one there is nothing to reconcile, and
   * subtracting the allocation from a zero observed sum would manufacture a
   * negative phase magnitude. Attempts that reported no usage contribute their
   * raw shape weight instead, which is why the resulting phase pair is then a
   * shape estimate rather than an anchored division.
   */
  const anchored = observedGeneratedTokens > 0
  const shapeTokens = anchored ? {
    reasoning: allocatedTokens.reasoning,
    output: allocatedTokens.output + (observedGeneratedTokens - allocatedTotal),
  } : allocatedTokens

  /**
   * The per-phase totals the card publishes: the provider counters when the
   * provider reported them, the anchored allocation otherwise. A phase with no
   * evidence at all stays `null` and renders `—`; it is never shown as `0`.
   */
  const phaseTokens = splitComplete
    ? { reasoning: observedReasoningTokens, output: observedNonReasoningTokens }
    : {
      reasoning: shapeTokens.reasoning > 0 ? shapeTokens.reasoning : null,
      output: shapeTokens.output > 0 ? shapeTokens.output : null,
    }
  /** Whether those per-phase counters are measured, anchored, or absent. */
  const phaseTokensQuality = splitComplete
    ? MetricQuality.EXACT
    : (usageComplete ? MetricQuality.ESTIMATED
      : (withUsage.length > 0 ? MetricQuality.PARTIAL : MetricQuality.UNAVAILABLE))

  // Phase rates divide whatever per-phase magnitude is published by the measured
  // generation time of that phase. A rate whose numerator is not measured is
  // reported at the quality of that numerator, so `≈` follows the number rather
  // than the field name.
  const reasoningTps = phaseTokens.reasoning !== null && phaseTokens.reasoning > 0 && reasoningMs > 0
    ? phaseTokens.reasoning * 1000 / reasoningMs
    : null
  const outputTps = phaseTokens.output !== null && phaseTokens.output > 0 && outputMs > 0
    ? phaseTokens.output * 1000 / outputMs
    : null

  const reasoningTokensReported = reduced.some(a => a.usage !== null && a.usage.reasoningTokens !== null)
  const reasoningQuality = reasoningTps === null
    ? MetricQuality.UNAVAILABLE
    : rateQuality({
      measuredRatio: measuredRatio(reasoningMeasured, reduced.length),
      tokensExact: splitComplete,
      phaseSplitExact: splitComplete && !splitConflict,
    })
  const outputQuality = outputTps === null
    ? MetricQuality.UNAVAILABLE
    : rateQuality({
      measuredRatio: measuredRatio(outputMeasured, reduced.length),
      tokensExact: splitComplete,
      phaseSplitExact: splitComplete && !splitConflict,
    })

  const ttftMs = Number.isFinite(input.firstTokenMs) && Number.isFinite(input.turnStartMs)
    ? Math.max(0, input.firstTokenMs - input.turnStartMs)
    : null
  const turnElapsedMs = Number.isFinite(input.turnEndMs) && Number.isFinite(input.turnStartMs)
    ? Math.max(0, input.turnEndMs - input.turnStartMs)
    : null

  /**
   * Three-axis quality, replacing the single blended label the scaffold used.
   * A turn whose token total is authoritative but whose reasoning split is not
   * reported must be able to say exactly that, which one label cannot express.
   */
  const quality = qualityAxes({
    contributingAttemptCount: reduced.length,
    attemptsWithUsage: withUsage.length,
    // An attempt whose usage came from an in-stream usage chunk is authoritative
    // too, but it is recorded with a source, so a recovered total is detectable.
    recoveredTotals: reduced.filter(a => a.usage !== null && a.usageSource === 'recovered').length,
    reportedTotals: withUsage.length,
    attemptsWithSplit: withUsage.filter(a => a.usage.reasoningTokens !== null).length,
    splitIsAnchored: splitComplete,
    reasoningStreamConflict: splitConflict,
    hasReasoningDeltas: reduced.some(a => a.shapeReasoning > 0),
    hasOutputDeltas: reduced.some(a => a.shapeOutput > 0),
    durable: input.durable === true,
    timestampsComplete: input.timestampsComplete !== false,
    anchored: reduced.length > 0 && reduced.every(a => a.totalAnchored === true),
    /**
     * The count the temporal axis is measured from. Without it `temporalShapeQuality`
     * answers `unavailable` — there is no shape to describe — so omitting it here
     * silently capped the strongest achievable curve quality at `estimated`.
     */
    sampleCount: reduced.reduce((sum, a) => sum + a.sampleCount, 0),
  })

  return {
    turn: input.turn ?? null,
    /**
     * Carried through rather than re-derived: the card states which session's turn
     * it describes, and the aggregation layer is the last place that knows it
     * before the view model is built.
     */
    sessionId: input.sessionId ?? null,
    status,
    turnStartMs: Number.isFinite(input.turnStartMs) ? input.turnStartMs : null,
    turnEndMs: Number.isFinite(input.turnEndMs) ? input.turnEndMs : null,
    ttftMs,
    /** Wall-clock turn duration; includes model waits and tools by design (§10). */
    turnElapsedMs,

    // Four principal columns.
    reasoningTps,
    reasoningTpsQuality: reasoningQuality,
    outputTps,
    outputTpsQuality: outputQuality,
    generatedTokens,
    /** Partial sum over attempts that did report usage; diagnostic, never the headline. */
    observedGeneratedTokens,
    generatedTokensQuality: usageComplete
      ? MetricQuality.EXACT
      : (withUsage.length > 0 ? MetricQuality.ESTIMATED : MetricQuality.UNAVAILABLE),
    reasoningTokens: observedReasoningTokens,
    nonReasoningTokens: observedNonReasoningTokens,
    /**
     * Per-phase token magnitudes actually fit to publish: the provider counters
     * when it reported them, otherwise the anchored phase allocation of the
     * authoritative total. `null` means "no evidence for this phase", never `0`.
     */
    phaseTokens,
    phaseTokensQuality,
    splitQuality: splitConflict
      ? MetricQuality.ESTIMATED
      : (splitComplete
        ? MetricQuality.EXACT
        : (withUsage.length > 0 ? MetricQuality.ESTIMATED : MetricQuality.UNAVAILABLE)),
    /**
     * Provider-aggregate versus stream-evidence contradictions detected while
     * aggregating. Empty array means the two evidence sources agreed.
     */
    consistencyIssues,

    /**
     * The quality model actually used by display code. `quality.tokenTotalQuality`
     * answers "is the generated-token total trustworthy", `.phaseSplitQuality`
     * answers "is the reasoning/output division trustworthy", and
     * `.temporalShapeQuality` answers "how good is the timing shape".
     */
    quality,

    // Phase denominators, for the secondary lines.
    reasoningMs,
    reasoningMeasuredAttempts: reasoningMeasured,
    outputMs,
    outputMeasuredAttempts: outputMeasured,
    /** Shape-weighted token sums; their phase pair sums to the observed total. */
    shapeTokens,

    // Coverage / diagnostics.
    attemptCount: attempts.length,
    contributingAttemptCount: reduced.length,
    emptyAttemptCount,
    usageAttemptCount: withUsage.length,
    usageComplete,
    splitComplete,
    reasoningTokensReported,
    attemptBreakdown: reduced,

    tools: summarizeToolCalls(tools),
    /**
     * Retained for callers that only want the four frozen levels. It is the
     * weakest of the three axes, so it can never be better than the honest
     * answer; new code should read `quality` instead.
     */
    overallQuality: weakestQuality(
      generatedTokens === null ? MetricQuality.UNAVAILABLE : MetricQuality.EXACT,
      reasoningQuality,
    ),
    /** Reasoning/output phase coverage, for the secondary lines. */
    measuredPhaseShare: {
      reasoning: measuredRatio(reasoningMeasured, reduced.length),
      output: measuredRatio(outputMeasured, reduced.length),
    },
  }
}

function measuredRatio(measured, total) {
  if (total === 0) return 0
  return measured / total
}



;Object.assign(__exports, { PHASE, normalizeUsage, isContributingAttempt, reduceAttempt, aggregateTurn })
			},
			"src/core/curve-source.js": function (__exports) {
/**
 * Curve source: the ephemeral, calibrated input the completed curve is drawn from.
 *
 * ## Why this module exists
 *
 * Two magnitude systems live in this project and they are not interchangeable:
 *
 *   - the raw **shape weight** `sampleFromChunk` attaches to each streamed delta,
 *     produced by `heuristicTokenWeight` (0.25 per Latin code point, 1 per CJK
 *     one). It is a coarse prior whose only job is to say *where* tokens went;
 *   - the **provider-calibrated** per-delta allocation `calibrateAttemptSamples`
 *     produces once authoritative usage is known, whose integral over an attempt
 *     equals that attempt's `outputTokens` exactly.
 *
 * `aggregateTurn` builds the published metrics — `generatedTokens`, the per-phase
 * token counts, `reasoningTps`, `outputTps` — from the second. The completed curve
 * was built from the first, because `settle()` read `record.attempts` directly.
 * A card could therefore print `Generated Tokens: 900` beside a curve whose whole
 * integrated area was 200. This module removes that possibility by construction:
 * the curve's samples come from `aggregate.attemptBreakdown[].calibration.samples`,
 * which is the one place calibration is performed.
 *
 * ## What the curve source is, and what it is not
 *
 * It is a **join**, not a second calibration. Calibration happens exactly once, in
 * `calibrateAttemptSamples`, and this module reads its output. No scaling,
 * re-weighting or re-derivation of token magnitudes occurs here — a duplicate
 * implementation would be free to drift from the one the printed numbers use,
 * which is the defect this module exists to close.
 *
 * The raw evidence is never mutated. `record.attempts[].samples` stays the
 * provenance: it is what `compressAttempts` reads for timestamps, and what the
 * fallback below returns when no calibration is available to join against.
 *
 * ## The alignment contract
 *
 * `aggregate.attemptBreakdown` is built by `aggregateTurn` from the attempts that
 * contributed evidence, in `record.attempts` order:
 *
 *     record.attempts.filter(isContributingAttempt).map(reduceAttempt)
 *
 * The join is therefore positional and the two lists are the same length. Position
 * alone is not treated as sufficient: wherever both sides publish an `attemptId`
 * and a `step`, they must agree, and a disagreement is reported in `issues` and
 * **degrades the whole join to the raw shape** rather than attaching one attempt's
 * calibration to another. A silent mismatch would be worse than the defect being
 * fixed, because the resulting numbers would look calibrated.
 *
 * ## Fallback
 *
 * The join either happens or it does not. When it does not, `calibrationCoverage` is
 * `fallback`, `calibratedForCurve` is `false`, and the curve carries the raw shape
 * weight under `curveQuality`'s ordinary `estimated` reading.
 *
 * ## Coverage, and why a boolean was not enough
 *
 * The join can succeed while only **part** of the curve is anchored: three contributing
 * attempts, two of which reported usage, produce a curve whose first two stretches are
 * calibrated to provider counters and whose third is still the coarse shape weight. Both
 * magnitudes are legitimate best estimates — per-delta allocation is reconstructed either
 * way, so the peak is `≈` at every coverage level, and dropping the unanchored attempt
 * would remove real generation from the chart — but a curve one third of which is
 * unanchored is not a *calibrated curve*.
 *
 * The previous revision reported `calibratedForCurve: calibratedCount > 0`, so that turn
 * was published as calibrated and every consumer that read the boolean — including
 * `curveViewModel.calibrated` — was told the whole curve was anchored. Coverage is now
 * stated explicitly as `calibrationCoverage`, and `calibratedForCurve` is narrowed to its
 * honest meaning: **full coverage only**.
 */

const { MetricQuality } = __req("src/core/metric-quality.js")
const { isContributingAttempt } = __req("src/core/aggregate-turn.js")

/**
 * How much of the curve an authoritative provider total anchored.
 *
 *   - `full`     — the join is aligned and **every** contributing attempt is anchored;
 *   - `partial`  — the join is aligned and some, but not all, are;
 *   - `none`     — the join is aligned and none are, which is the ordinary
 *                  no-usage turn and is not an error;
 *   - `fallback` — the join could not be trusted, so nothing is calibrated and the
 *                  whole curve is the raw shape weight.
 *
 * `none` and `fallback` are deliberately different: the first says the evidence
 * contains no provider total, the second says the evidence could not be joined. A
 * consumer that treated missing usage as corruption would report a defect where
 * there is only a quality level.
 */
const CalibrationCoverage = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  NONE: 'none',
  FALLBACK: 'fallback',
})

/** Fields on `record.attempts` that are shared with every calibration sample. */
function withCalibratedSamples(attempt, samples, anchored) {
  return {
    ...attempt,
    /**
     * The attempt's samples replaced by their calibrated allocation. Every other
     * field — `attemptId`, `step`, `turn`, `usage`, `settlementKind`, `startedAtMs`,
     * `settledAtMs`, `settlementSeq` — is carried through untouched, so a curve
     * vertex remains attributable to the same attempt the aggregate reduced.
     */
    samples,
    /**
     * Whether an authoritative provider total anchored these magnitudes. `false`
     * means the samples are the raw shape weights relabelled by the same function,
     * which is arithmetically identical and is what keeps "missing usage stays
     * estimated" true — but it is never reported as a calibration.
     */
    anchored,
  }
}

/**
 * Normalize one calibration sample for curve consumption.
 *
 * `calibrateAttemptSamples` already writes both `tokens` and `quality`, so this is
 * a shape guarantee rather than a transformation: a caller cannot receive a curve
 * sample whose magnitude field is missing or whose quality is unstated.
 */
function curveSample(sample) {
  return {
    ...sample,
    tokens: Number.isFinite(sample?.tokens) ? sample.tokens : Math.max(0, sample?.weight ?? 0),
    quality: sample?.quality ?? MetricQuality.ESTIMATED,
  }
}

/**
 * Join the stored attempts with their calibrated reductions.
 *
 * @param {readonly object[]} attempts `record.attempts`, in turn order
 * @param {readonly object[]} breakdown `aggregate.attemptBreakdown`, in reduction order
 * @returns {{
 *   attempts: object[],
 *   aligned: boolean,
 *   calibratedForCurve: boolean,
 *   calibrationCoverage: 'full'|'partial'|'none'|'fallback',
 *   contributingCount: number,
 *   calibratedCount: number,
 *   rawFallbackAttemptIds: (string|null)[],
 *   issues: string[],
 * }}
 *   `attempts` is the list `compressAttempts` must be given; it is never shorter
 *   than the raw contributing list, and it carries calibrated magnitudes for every
 *   attempt the join could be trusted for. `calibratedForCurve` is `true` only for
 *   `full` coverage — it is a statement about the whole curve, never about whether
 *   any attempt was calibrated.
 */
function curveSource(attempts, breakdown) {
  const raw = Array.isArray(attempts) ? attempts : []
  const reduced = Array.isArray(breakdown) ? breakdown : []
  const contributing = raw.filter(isContributingAttempt)
  const issues = []

  if (contributing.length !== reduced.length) {
    issues.push(
      `curve source misaligned: ${contributing.length} contributing attempts against `
      + `${reduced.length} reduced attempts`,
    )
  }

  const pairs = Math.min(contributing.length, reduced.length)
  for (let index = 0; index < pairs; index += 1) {
    const attempt = contributing[index]
    const entry = reduced[index]
    const attemptId = attempt?.attemptId ?? null
    const reducedId = entry?.attemptId ?? null
    /**
     * Identity is asserted only where **both** sides publish one. An attempt with no
     * `attemptId` and a reduction with none agree by absence; the earlier revision of
     * this contract would have had to invent a placeholder to compare, which is how a
     * positional join silently becomes a wrong one.
     */
    if (attemptId !== null && reducedId !== null && attemptId !== reducedId) {
      issues.push(
        `curve source misaligned at position ${index}: attempt ${attemptId} reduced as ${reducedId}`,
      )
    }
    const step = attempt?.step ?? null
    const reducedStep = entry?.step ?? null
    if (step !== null && reducedStep !== null && step !== reducedStep) {
      issues.push(
        `curve source misaligned at position ${index}: attempt ${attemptId ?? '?'} has step ${step} `
        + `reduced as step ${reducedStep}`,
      )
    }
    const calibrated = entry?.calibration?.samples
    if (!Array.isArray(calibrated)) {
      issues.push(`curve source misaligned at position ${index}: no calibration samples for attempt ${attemptId ?? '?'}`)
    } else if (calibrated.length !== (attempt?.samples?.length ?? 0)) {
      issues.push(
        `curve source misaligned at position ${index}: attempt ${attemptId ?? '?'} has `
        + `${attempt?.samples?.length ?? 0} samples against ${calibrated.length} calibrated ones`,
      )
    }
  }

  const aligned = issues.length === 0
  if (!aligned) {
    /**
     * The whole join is refused, not repaired per attempt. A partial join would leave
     * the curve measured in two magnitude systems at once with nothing on screen to
     * say which vertex belongs to which — the original defect, applied unevenly.
     */
    return {
      attempts: raw,
      aligned: false,
      calibratedForCurve: false,
      calibrationCoverage: CalibrationCoverage.FALLBACK,
      contributingCount: contributing.length,
      calibratedCount: 0,
      rawFallbackAttemptIds: contributing.map(attempt => attempt?.attemptId ?? null),
      issues,
    }
  }

  const calibratedCount = reduced.filter(entry => entry?.calibration?.totalAnchored === true).length
  /**
   * The curve's magnitude provenance, stated as coverage rather than as a yes/no.
   *
   * `calibratedForCurve` means "the **whole** curve is anchored", so it requires a
   * non-empty contributing set: zero attempts cover nothing, and `0 === 0` must not
   * be read as completeness.
   */
  const calibrationCoverage = calibratedCount === 0
    ? CalibrationCoverage.NONE
    : (calibratedCount === contributing.length ? CalibrationCoverage.FULL : CalibrationCoverage.PARTIAL)
  const calibratedForCurve = contributing.length > 0
    && calibratedCount === contributing.length

  if (calibratedCount === 0) {
    return {
      attempts: raw,
      aligned: true,
      calibratedForCurve,
      calibrationCoverage,
      contributingCount: contributing.length,
      calibratedCount: 0,
      rawFallbackAttemptIds: [],
      issues,
    }
  }

  const calibrated = contributing.map((attempt, index) => withCalibratedSamples(
    attempt,
    (reduced[index].calibration.samples ?? []).map(curveSample),
    reduced[index].calibration.totalAnchored === true,
  ))
  /**
   * Attempts that produced no generated delta are retained, not dropped: an empty
   * attempt contributes no samples and therefore no width, and removing it here
   * would make the curve's attempt list disagree with the turn's own count. The
   * walk is positional because `contributing` is a filter of `raw`, so the two
   * lists have a known, stable correspondence.
   */
  let cursor = 0
  const joined = raw.map((attempt) => {
    if (!isContributingAttempt(attempt)) return attempt
    const next = calibrated[cursor]
    cursor += 1
    return next
  })

  return {
    attempts: joined,
    aligned: true,
    calibratedForCurve,
    calibrationCoverage,
    contributingCount: contributing.length,
    calibratedCount,
    rawFallbackAttemptIds: [],
    issues,
  }
}

;Object.assign(__exports, { CalibrationCoverage, curveSource })
			},
			"src/core/curve.js": function (__exports) {
/**
 * Completed-turn TPS curve: one attempt-local trailing-one-second **total**
 * throughput trace per model attempt, segmented into visual phases.
 *
 * The window and cadence are the same the live meter uses
 * (docs/METRICS_SPEC.md §8.2): a curve vertex at attempt-local `t` reports
 *
 *     sum of every generated sample of that attempt with timestamp in (t - 1000 ms, t]
 *
 * across **all** phases — reasoning deltas, text deltas and tool-call argument
 * deltas alike. That is exactly what `LiveMeter` measures: it holds one
 * `SlidingWindowMeter` per active attempt and feeds it every generated sample,
 * using `streamingPhase` only to *label* the newest one. Reasoning and output are
 * therefore visual phases of one measurement, never two rate definitions.
 *
 * Two different milliseconds live in this module and must not be conflated:
 *
 *   - `DEFAULT_WINDOW_MS` (1000 ms) is the interval a rate is *measured* over.
 *     It is a definition, not a refresh rate;
 *   - `DEFAULT_SAMPLE_EVERY_MS` (250 ms) is how often that measurement is
 *     *recorded* for the completed chart. It is independent of the live
 *     presentation cadence in `src/client/live/cadence.js`: streaming a screen
 *     at 20 Hz does not make a one-second window any shorter, and a finer curve
 *     grid is a separate, separately-argued decision.
 *
 * Curve magnitudes are `estimated` before provider usage arrives and `calibrated`
 * afterwards; they are never `exact`. `peakTps` is the maximum of the **full**
 * rolling series — computed before any downsampling — and it must still be
 * labelled as an estimate, because a series sample is not a provider-certified
 * maximum (docs/METRICS_SPEC.md §9).
 */

const DEFAULT_WINDOW_MS = 1000
const DEFAULT_SAMPLE_EVERY_MS = 250

/** Largest rendered series the SVG layer is allowed to receive. */
const DEFAULT_MAX_POINTS = 512

/**
 * Largest number of vertices **one chart** may receive across every series, every
 * run and both phases.
 *
 * `DEFAULT_MAX_POINTS` bounds per run, which is not a bound on a chart: a hundred
 * runs of 512 points each would be 51 200 SVG vertices, and the card renders inside
 * a conversation that may hold several of them. This is the budget the settled
 * snapshot actually allocates, and `allocateRunBudgets` is what divides it.
 */
const MAX_RENDER_POINTS_TOTAL = 512

/**
 * Smallest budget that can hold the guaranteed anchors: the first point, the last
 * point and the global maximum are three distinct indices in the worst case.
 * A smaller budget is unsatisfiable rather than merely tight.
 */
const MIN_MAX_POINTS = 3

function assertPositive(value, label) {
  if (!(Number.isFinite(value) && value > 0)) throw new TypeError(`${label} must be a finite number > 0`)
}

/**
 * Authoritative stream ordinal of one sample.
 *
 * The order in which a model's deltas were delivered is **evidence**, and it is the only
 * evidence there is for which of two simultaneous samples is the newer one. DSH carries it
 * twice — the transient frame index and the durable compact stream member order — and both
 * reconstruct into the stored attempt's `samples` array in that order, which
 * `compressAttempts` publishes per sample as `sampleOrder`.
 *
 * A sample that already carries the ordinal keeps it. One that does not takes its position
 * in the list it arrived in, which is the same fact stated by the array itself and is what
 * keeps a direct caller of `totalRollingTpsSeries` well defined.
 */
function ordinalOf(sample, index) {
  return Number.isFinite(sample?.sampleOrder) ? sample.sampleOrder : index
}

/**
 * Ascending instant, then the authoritative stream ordinal — **never** the phase.
 *
 * The second key is load-bearing rather than cosmetic. `activePhase` is the label of the
 * newest sample at or before a vertex, and a reasoning delta and a text delta can share one
 * timestamp, so something has to decide which of them is newer. The previous revision
 * decided it with a fixed phase hierarchy (`reasoning` before `output`, so `output` always
 * won) on the reasoning that a deterministic rule beats the sort's stability. Determinism
 * is not the same as agreement: `LiveMeter.streamingPhase` is the phase of the last
 * **accepted** sample, so for a pair delivered text-then-reasoning the live pill says
 * `reasoning` while the completed vertex said `output`. Two halves of one project
 * disagreed about one stream.
 *
 * Ordering by the ordinal reproduces the live semantics exactly, because the ordinal *is*
 * the live order. It does not weaken reproducibility: the ordinal is derived from the
 * stored evidence, not from which array the transport happened to hand the curve. And it
 * changes no number — a window holds every sample at an instant whatever their order — so
 * only the label moves (`test/curve-stream-order.test.js`).
 */

/**
 * Rolling TPS trace of one attempt, over **every** generated sample of that attempt.
 *
 * The window is half-open, `(t - windowMs, t]`: a sample exactly one window old has
 * left the measurement and a sample exactly at `t` is in it
 * (`docs/METRICS_SPEC.md` §8.1/§8.2). That is the convention `SlidingWindowMeter`
 * implements for the live pill, which is what makes a curve vertex and a live
 * reading comparable at the same attempt-local instant.
 *
 * **Every vertex uses one bound, including an opening vertex.** An attempt's local
 * zero *is* its first delta, so a reader may expect an opening vertex to need
 * rescuing from an empty window. It does not: at `localMs = 0` the ordinary bound
 * is `-windowMs`, and a sample at zero lies inside `(-windowMs, 0]`. The opening
 * delta is therefore included by the arithmetic rather than by a special case.
 * Phase 6 briefly carried a special case —
 * `localMs <= fromMs ? -Infinity : localMs - windowMs` — and Phase 7 removed it:
 * `fromMs` is an *episode* bound, the clamp fired at every episode opening, and it
 * readmitted samples the trailing definition had already evicted.
 *
 * **A phase is never filtered out.** The `phase` option the previous revision took
 * was the cross-phase defect: filtering by phase produced two partial rates where
 * the live meter produced one total. What a phase contributes here is the
 * `activePhase` **label** on each vertex — the phase of the latest generated sample
 * at or before that instant, which is `LiveMeter.streamingPhase` restated. The
 * label changes where the tone changes; it never changes the number.
 *
 * **The grid ends where the evidence ends.** Vertices run from `fromMs` on the
 * `sampleEveryMs` ladder to the last sample at or before `toMs`, and the attempt's own
 * final instant is appended when it does not fall on the ladder. Nothing is sampled
 * after it: a vertex past the last delta measures a window the model has stopped
 * feeding, and on the completed chart it would carry a coordinate larger than
 * `curve.durationMs` and be clamped onto `x = 100` — a vertical stroke at the right
 * edge that the evidence does not contain
 * (`test/curve-axis-endpoint.test.js`).
 *
 * **One clock, one window.** This function has no notion of an attempt, so calling
 * it across an attempt boundary bridges two model calls — the exact defect Phase 6
 * removed. Completed curves go through `attemptTraces`, which calls it once per
 * attempt; the concatenating overload here exists for callers that genuinely hold a
 * single uninterrupted stream.
 *
 * `fromMs`/`toMs`/`offsetMs` express "sample a bounded stretch of one attempt's
 * local clock" without weakening the above: the window is always measured on the
 * same coordinate the samples carry, and `offsetMs` only relabels the emitted
 * `timeMs`. A bounded call therefore never reaches outside `[fromMs, toMs]`.
 *
 * @param {readonly object[]} samples samples carrying `activeTimeMs`, `phase` and `tokens`/`weight`
 * @param {{
 *   windowMs?:number,
 *   sampleEveryMs?:number,
 *   durationMs?:number,
 *   fromMs?:number,
 *   toMs?:number,
 *   offsetMs?:number,
 *   sampleEndMs?:number,
 * }} [options]
 * @returns {{
 *   timeMs:number, localMs:number, tps:number,
 *   activePhase:string|null, attemptId:string|null,
 * }[]}
 */
function totalRollingTpsSeries(samples, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const sampleEveryMs = options.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS
  assertPositive(windowMs, 'windowMs')
  assertPositive(sampleEveryMs, 'sampleEveryMs')

  const filtered = (Array.isArray(samples) ? samples : [])
    /**
     * The authoritative ordinal is attached to a **copy**, so the caller's sample objects
     * are never written to, and the sort below has one key to read per entry rather than a
     * side lookup into the input array.
     */
    .map((sample, index) => (sample === null || sample === undefined
      ? null
      : { ...sample, sampleOrder: ordinalOf(sample, index) }))
    .filter(sample => sample !== null && Number.isFinite(sample.activeTimeMs))
    /**
     * Ascending instant, then the authoritative ordinal. See `ordinalOf` above: the second
     * key reproduces `LiveMeter.streamingPhase`'s answer for a simultaneous pair instead of
     * imposing a phase hierarchy on it.
     */
    .sort((a, b) => a.activeTimeMs - b.activeTimeMs || a.sampleOrder - b.sampleOrder)

  const offsetMs = Number.isFinite(options.offsetMs) ? options.offsetMs : 0
  const sampleEnd = Math.max(0, filtered.length > 0 ? filtered[filtered.length - 1].activeTimeMs : 0)
  const toMs = Number.isFinite(options.toMs) ? Math.max(0, options.toMs)
    : (Number.isFinite(options.durationMs) ? Math.max(0, options.durationMs) : sampleEnd)
  const fromMs = Number.isFinite(options.fromMs) ? Math.max(0, options.fromMs) : 0
  /**
   * `sampleEndMs` is where the attempt stops producing, and it is also the last instant the
   * trace is sampled at. `toMs` bounds it from above so a bounded call still never reaches
   * outside `[fromMs, toMs]`; the emitted endpoint is the last sample itself, so an off-grid
   * final delta remains a vertex rather than being rounded to the cadence.
   */
  const sampleEndMs = Number.isFinite(options.sampleEndMs)
    ? Math.max(0, options.sampleEndMs)
    : Math.max(0, Math.min(sampleEnd, toMs))

  const result = []
  let left = 0
  let right = 0
  let total = 0
  /**
   * Vertex instants, built explicitly rather than by accumulating `+= every`:
   * floating-point error over a ten-minute turn would otherwise put the last vertex
   * off the grid it claims to be on.
   *
   * The set is the **union of the cadence ladder and the attempt's own end instant**.
   * The ladder alone would drop a final delta that does not fall on the cadence — a
   * delta at 510 ms would be sampled at 500 and the instant the model stopped
   * producing would never be drawn. The end instant alone would drop the shape
   * samples in between. Their union, deduplicated and ascending, is what makes the
   * attempt's real endpoint an unconditional vertex while leaving the cadence intact
   * (`test/curve-axis-endpoint.test.js`).
   *
   * The ladder starts at `fromMs`, so a run's opening vertex is drawn even when it
   * produced a single delta. There is no second ladder: a vertex past `bodyEndMs`
   * would be post-generation time and would be clamped onto the chart's right edge.
   */
  const instants = []
  const bodyEndMs = Math.max(fromMs, Math.min(sampleEndMs, toMs))
  for (let step = 0; ; step += 1) {
    const at = fromMs + step * sampleEveryMs
    if (at > bodyEndMs + 1e-9) break
    instants.push(at)
  }
  if (bodyEndMs > instants[instants.length - 1] + 1e-9) instants.push(bodyEndMs)

  /** Index into `filtered` of the newest sample at or before `localMs`, or `-1`. */
  let newest = -1

  for (const localMs of instants) {
    while (right < filtered.length && filtered[right].activeTimeMs <= localMs) {
      total += filtered[right].tokens ?? filtered[right].weight ?? 0
      newest = right
      right += 1
    }
    /**
     * The lower bound is the trailing-window definition itself, uniformly:
     * `(localMs - windowMs, localMs]`. There is no opening-vertex special case, and
     * Phase 7 removed the one that existed.
     *
     * The removed clamp read `localMs <= fromMs ? -Infinity : localMs - windowMs`.
     * It was written to keep an attempt's *first* vertex from reporting `0 tokens/s`
     * on the delta the call opened with, on the reasoning that local zero is the
     * attempt's opening delta and `(-windowMs, 0]` contains nothing. That reasoning is
     * sound about the attempt and wrong about the coordinate: `localMs == fromMs` is
     * true at **every** episode's first vertex, because `fromMs` is the episode bound.
     * An attempt that fell silent for longer than one window produced a second
     * episode, and at that episode's opening instant the bound collapsed to negative
     * infinity and readmitted samples the trailing window had already evicted
     * (docs/METRICS_SPEC.md §8.2). The clamp was also unnecessary for the case it was
     * written for: at an attempt's local zero, `localMs - windowMs` is `-windowMs`, and
     * a sample at zero lies inside `(-windowMs, 0]`.
     *
     * Both bounds are expressed on the **same** clock the samples carry: `offsetMs`
     * relabels the emitted `timeMs` and must not enter this comparison, because
     * folding it into the bound while the cursors stayed local is what once left a
     * claim of 100 tokens/s on an instant whose only sample had already been evicted.
     */
    const lowerExclusive = localMs - windowMs
    while (left < right && filtered[left].activeTimeMs <= lowerExclusive) {
      total -= filtered[left].tokens ?? filtered[left].weight ?? 0
      left += 1
    }
    /**
     * The label comes from the newest sample at or before this instant, which is the
     * same rule `LiveMeter.streamingPhase` applies. It is never evicted by the left
     * cursor: a sample at or before `localMs` is strictly newer than
     * `localMs - windowMs`, so it is inside the window whenever it exists.
     */
    result.push({
      timeMs: offsetMs + localMs,
      localMs,
      tps: Math.max(0, total) * 1000 / windowMs,
      activePhase: newest >= 0 ? (filtered[newest].phase ?? null) : null,
      attemptId: newest >= 0 ? (filtered[newest].attemptId ?? null) : null,
    })
  }
  return result
}

/**
 * One attempt's total throughput trace, measured on its own clock and relabelled.
 *
 * Each attempt is measured on its **own** local clock and only then relabelled to
 * the turn's compressed coordinate by `attemptTimeMs + segment.startMs`. Two
 * attempts that share the compressed coordinate `x` therefore share no window: the
 * last vertex of A and the first vertex of B are computed from disjoint sample sets,
 * whatever the x distance between them happens to be.
 *
 * **A trace is sampled from the attempt's first delta to its last one, and no
 * further.** The sampled instants are the union of two sets:
 *
 *   - the attempt's own cadence ladder, `0, sampleEveryMs, 2 * sampleEveryMs, …`, up
 *     to its last model-producing delta;
 *   - that last model-producing instant itself.
 *
 * The union is what makes the attempt's **real** endpoint a vertex even when it does
 * not fall on the cadence: a call whose final delta arrives at 510 ms is sampled at
 * `0, 250, 500, 510`, not at `0, 250, 500`, so the instant the model stopped
 * producing is always drawn. Deduplication is what keeps an on-cadence endpoint from
 * being emitted twice.
 *
 * Every attempt obeys this identically, so the final attempt is not a special case
 * and no attempt receives synthetic width merely for being last. Tool waits,
 * inter-attempt waits and next-call TTFT still own no coordinate at all: they lie
 * between one attempt's last delta and the next one's first, where this trace has no
 * vertex and the next trace's local zero is the same compressed coordinate.
 *
 * A real stall **inside** the attempt is preserved in full, because it lies between
 * two deltas rather than after the last one: the grid runs across it and the trailing
 * rate decays to zero. That is the fact the chart exists to show, and it is different
 * in kind from a decay drawn past the point where the model stopped.
 *
 * @param {{attemptId?:string|null, step?:number|null, startMs:number, endMs?:number,
 *   localEndMs?:number}} segment
 * @param {readonly object[]} samples compressed samples carrying `attemptId` and `activeTimeMs`
 * @param {{
 *   windowMs?:number, sampleEveryMs?:number, attemptId?:string|null, calibrated?:boolean,
 * }} [options]
 * @returns {{
 *   attemptId:string|null, startMs:number, endMs:number, localEndMs:number,
 *   durationMs:number, sampleCount:number, tokens:number, calibratedTokens:number|null,
 *   calibrated:boolean, samples:object[], points:object[], visualRuns:object[],
 * }}
 */
function attemptTrace(segment, samples, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const sampleEveryMs = options.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS
  const attemptId = options.attemptId ?? segment?.attemptId ?? null
  const startMs = Number.isFinite(segment?.startMs) ? segment.startMs : 0
  const endMs = Number.isFinite(segment?.endMs) ? segment.endMs : startMs

  /**
   * Every sample of the attempt is retained, whatever its phase: a window opened
   * before a phase's first sample can legitimately reach back into the other phase,
   * and excluding those samples would measure a window against a truncated history.
   */
  const perAttempt = (Array.isArray(samples) ? samples : [])
    .filter(sample => (
      sample
      && (sample.attemptId ?? null) === attemptId
      && Number.isFinite(sample.activeTimeMs)
    ))
    .map((sample, index) => ({
      ...sample,
      activeTimeMs: Number.isFinite(sample.attemptTimeMs)
        ? Math.max(0, sample.attemptTimeMs)
        : Math.max(0, (sample.activeTimeMs ?? 0) - startMs),
      /** The authoritative ordinal, carried explicitly into the sort below. */
      sampleOrder: ordinalOf(sample, index),
    }))
    /**
     * The same tie-break `totalRollingTpsSeries` applies — instant, then authoritative
     * ordinal — so the two agree on which simultaneous sample supplied a vertex's label.
     */
    .sort((a, b) => a.activeTimeMs - b.activeTimeMs || a.sampleOrder - b.sampleOrder)

  let tokens = 0
  let calibratedTokens = null
  for (const sample of perAttempt) {
    const value = sample.tokens ?? sample.weight ?? 0
    tokens += value
    if (sample.quality === 'calibrated') calibratedTokens = (calibratedTokens ?? 0) + value
  }

  if (perAttempt.length === 0) {
    return {
      attemptId,
      startMs,
      endMs,
      localEndMs: Math.max(0, endMs - startMs),
      durationMs: 0,
      sampleCount: 0,
      tokens: 0,
      calibratedTokens,
      calibrated: options.calibrated === true,
      samples: [],
      points: [],
      visualRuns: [],
    }
  }

  const lastSampleMs = perAttempt[perAttempt.length - 1].activeTimeMs
  const boundedEndMs = Math.max(0, endMs - startMs)
  /**
   * **The trace stops where the attempt stopped producing.** `bodyEndMs` is the attempt's
   * own last model-producing instant — the coordinate `curve.durationMs` already accounts
   * for — and it is the only bound, for every attempt including the last.
   *
   * The previous revision gave the final attempt `bodyEndMs + windowMs` and sampled a
   * one-window decay past it. Those vertices are post-generation time: the axis is model
   * generation (`docs/METRICS_SPEC.md` §8.1), the host settlement tail is excluded from
   * generation duration (§7), and a vertex carrying a coordinate larger than the chart's
   * own duration is clamped onto `x = 100` by `xOf(timeMs, durationMs)`. Several distinct
   * instants therefore landed on one x coordinate and the SVG closed with a vertical stroke
   * the evidence does not contain (`test/curve-axis-endpoint.test.js`).
   *
   * What this does **not** remove: a silence between two deltas *inside* the attempt. That
   * straddles real model-generation time, the grid runs across it, and the trailing rate
   * decays to zero and climbs again — the stall stays visible at full width (§8.2.1).
   * The distinction is "between deltas" versus "after the last one", not "short" versus
   * "long".
   */
  const bodyEndMs = Math.max(0, Math.min(lastSampleMs, boundedEndMs))
  const toMs = bodyEndMs

  const points = totalRollingTpsSeries(perAttempt, {
    windowMs,
    sampleEveryMs,
    offsetMs: startMs,
    fromMs: 0,
    toMs,
    sampleEndMs: bodyEndMs,
  })

  return {
    attemptId,
    startMs,
    endMs,
    localEndMs: boundedEndMs,
    durationMs: toMs,
    sampleCount: perAttempt.length,
    tokens,
    calibratedTokens,
    calibrated: options.calibrated === true,
    samples: perAttempt,
    points,
    visualRuns: visualRunsOf(points),
  }
}

/**
 * One attempt's trace, cut into phase stretches that meet at a shared boundary vertex.
 *
 * This is the whole of the colour model. Each vertex carries the phase of the latest generated
 * sample at or before it, and the trace is cut where that label changes.
 *
 * ## Why the cut is the outgoing stretch's own last vertex
 *
 * `activePhase` persists until new phase evidence arrives, so a label is carried by **every**
 * vertex of the trace: there is no vertex without a phase, and therefore no silence between two
 * stretches. The maximal stretches of one label are contiguous by construction —
 * `next.first === stretch.last + 1` — and the boundary of a change is the last vertex still
 * labelled with the outgoing phase.
 *
 * The incoming coloured path opens on that same vertex, which is what makes a tone change a
 * seam rather than a hole: the two subpaths meet at one instant, one measured rate, one object.
 * The next vertex then carries the new phase.
 *
 * A long silence is **not** divided between the two tones, and no rule here could divide it: a
 * silence inside one phase is simply a stretch of zero-valued vertices that all carry that
 * phase, and it is drawn in that phase's tone at full width, because a stall inside a model call
 * is a throughput fact the chart exists to show (`docs/METRICS_SPEC.md` §8.2.1). An earlier
 * revision described the cut as "the midpoint of the label change"; for a trace whose every
 * vertex is labelled, the midpoint of two adjacent indices is `floor((last + last + 1) / 2)`,
 * which is `last` — the same index. The formula was correct and its description was not, so the
 * formula is gone and the rule is stated directly.
 *
 * The invariants this produces, and the ones the renderer and its tests rely on:
 *
 *     runs[i].endIndex === runs[i + 1].startIndex
 *     sum(runs[i].pointCount) === points.length + (runs.length - 1)
 *
 * Statistics come first; colour segmentation is applied to them afterwards, and a vertex with
 * no sample at or before it (`activePhase === null`, which cannot occur for a non-empty trace)
 * opens a run of its own rather than being merged away.
 *
 * @param {readonly {activePhase?:string|null}[]} points
 * @returns {{phase:string|null, startIndex:number, endIndex:number, pointCount:number}[]}
 */
function visualRunsOf(points) {
  const list = Array.isArray(points) ? points : []
  if (list.length === 0) return []
  const labelAt = index => list[index]?.activePhase ?? null

  /** Maximal stretches of one label, before any boundary is shared. */
  const stretches = []
  let start = 0
  while (start < list.length) {
    const phase = labelAt(start)
    let last = start
    while (last + 1 < list.length && labelAt(last + 1) === phase) last += 1
    stretches.push({ phase, first: start, last })
    start = last + 1
  }

  const runs = []
  for (const [index, stretch] of stretches.entries()) {
    const previous = runs[runs.length - 1]
    /**
     * A run opens on the vertex the previous one closed on, so a tone change is a seam rather
     * than a blank horizontal gap. That vertex is shared, not duplicated: it is one index in
     * the trace's own grid, emitted by both paths and charged to both by the render budget.
     */
    const from = previous === undefined ? stretch.first : previous.endIndex
    /**
     * The shared vertex: the final vertex carrying this stretch's phase, which is also the
     * vertex in front of the next stretch. It is one index either way, which is what makes the
     * two subpaths meet.
     */
    const to = stretch.last
    runs.push({ phase: stretch.phase, startIndex: from, endIndex: to, pointCount: to - from + 1 })
  }
  return runs
}

/**
 * The per-attempt trace list the completed curve is drawn from, in turn order.
 *
 * @param {readonly object[]} segments `compressAttempts` segments, in turn order
 * @param {readonly object[]} samples `compressAttempts` samples
 * @param {{windowMs?:number, sampleEveryMs?:number,
 *   calibratedAttemptIds?:ReadonlySet<string|null>}} [options]
 * @returns {object[]} one trace per segment that produced evidence
 */
function attemptTraces(segments, samples, options = {}) {
  const ordered = (Array.isArray(segments) ? segments : []).filter(
    segment => segment && typeof segment === 'object' && Number.isFinite(segment.startMs),
  )
  const calibrated = options.calibratedAttemptIds
  const traces = []
  for (const segment of ordered) {
    const trace = attemptTrace(segment, samples, {
      windowMs: options.windowMs,
      sampleEveryMs: options.sampleEveryMs,
      calibrated: calibrated instanceof Set ? calibrated.has(segment.attemptId ?? null) : false,
    })
    if (trace.points.length === 0) continue
    traces.push(trace)
  }
  return traces
}

/**
 * Peak across any number of **full** series.
 *
 * The name says `Tps` and not `RenderedTps` on purpose: this is a statistic over
 * the rolling series as computed, and it must be evaluated before
 * `downsampleSeries` runs. Taking the maximum of the *drawn* points instead
 * would make a chart setting — how many points the SVG is allowed — silently
 * change a number the card reports.
 */
function peakTps(...seriesList) {
  let peak = 0
  for (const series of seriesList) {
    if (!Array.isArray(series)) continue
    for (const point of series) {
      const value = point?.tps
      if (Number.isFinite(value) && value > peak) peak = value
    }
  }
  return peak
}

/**
 * Colour segmentation of the attempt traces, keyed by phase.
 *
 * This is the phase-keyed view of the same runs `attemptTrace().visualRuns` publishes
 * per attempt, and it exists because two callers want different keys for one fact:
 * the chart draws per attempt, and a diagnostic or a test asks "where does reasoning
 * have evidence at all". Deriving both from one `visualRunsOf` pass is what keeps
 * them from drifting apart.
 *
 * A phase that produced nothing has no run. That is an absence of evidence, and it is
 * never drawn as a flat zero line: "never reasoned here" and "reasoning throughput
 * fell to zero" are different facts.
 *
 * @param {readonly object[]} traces `attemptTraces` output
 * @returns {{reasoning: object[], output: object[]}} runs in draw order
 */
function phaseRuns(traces) {
  const out = { reasoning: [], output: [] }
  for (const trace of Array.isArray(traces) ? traces : []) {
    for (const run of trace?.visualRuns ?? []) {
      if (run.phase !== 'reasoning' && run.phase !== 'output') continue
      const points = (trace.points ?? []).slice(run.startIndex, run.endIndex + 1)
      if (points.length === 0) continue
      out[run.phase].push({
        attemptId: trace.attemptId ?? null,
        phase: run.phase,
        startMs: points[0].timeMs,
        endMs: points[points.length - 1].timeMs,
        startIndex: run.startIndex,
        endIndex: run.endIndex,
        pointCount: points.length,
        points,
      })
    }
  }
  return out
}

/**
 * Single-interval evidence view, retained for callers that only ask when a phase
 * began and ended.
 *
 * It is derived from `phaseRuns`, so it can never disagree with the colour
 * segmentation. It must not be used to decide what to draw: between the first and
 * last run of a phase there may be stretches where the phase is absent, and this
 * shape cannot express that.
 *
 * @deprecated for rendering — use `phaseRuns` or `attemptTrace().visualRuns`.
 */
function phaseSpans(traces) {
  const runs = phaseRuns(traces)
  const outer = list => (list.length === 0
    ? null
    : { startMs: list[0].startMs, endMs: list[list.length - 1].endMs })
  return { reasoning: outer(runs.reasoning), output: outer(runs.output) }
}

/** Rate a series' point carries, in either supported field spelling. */
function rateOf(point) {
  const value = point?.tps ?? point?.tokens ?? point?.weight
  return Number.isFinite(value) ? value : null
}

/**
 * What a run costs to draw **at all**, which is not what it could be thinned to.
 *
 * A run of one or two vertices is already at full resolution: `downsampleSeries`
 * refuses a budget below `MIN_MAX_POINTS` precisely because it cannot honour the
 * three anchors, and duplicating a vertex to reach the minimum would draw a segment
 * the data does not contain. Its irreducible cost is therefore its own length. Every
 * longer run costs `MIN_MAX_POINTS`, the smallest allowance that keeps its first
 * point, its last point and its maximum.
 *
 * This is the unit the allocation is denominated in, and stating it as a function of
 * length alone is what makes the priority order total: every run is comparable to
 * every other, whatever their lengths, so no priority band can end at a length
 * boundary.
 */
function minimumRunCost(length) {
  if (!Number.isFinite(length) || length <= 0) return 0
  return length < MIN_MAX_POINTS ? length : MIN_MAX_POINTS
}

/**
 * Divide one chart-wide rendering budget across the runs that will be drawn.
 *
 * `downsampleSeries` bounds *one* run. Nothing bounded the sum, so the SVG could
 * grow with the number of episodes: a turn with a hundred phase alternations
 * produced a hundred runs of up to 512 vertices each, and the card's element count
 * became a function of the model's delivery pattern rather than of a design
 * decision. This function is the missing global bound.
 *
 * Three constraints, in priority order, because a budget smaller than the number of
 * runs must degrade predictably rather than silently:
 *
 *   1. **The global peak keeps a drawable budget — whatever length its run is.** The
 *      run whose series carries the chart's maximum rate is seated first and is never
 *      thinned to a point per run. Without this, a many-run turn could drop the one
 *      vertex the card's printed peak refers to, and the chart would contradict its
 *      own number.
 *   2. **Every run keeps its own first and last vertex.** `downsampleSeries` treats
 *      those as unconditional anchors, so a run whose allocation is below its
 *      irreducible cost cannot honour the anchors its own contract promises.
 *      Allocations are therefore `0` or at least `minimumRunCost(length)`, and a `0`
 *      is an explicit "not drawable", not a silently truncated run.
 *   3. **Remaining budget is shared out in the ranked order**, which serves the
 *      shorter run first whenever two runs cost the same. Above `MIN_MAX_POINTS`
 *      every run costs three, so the length tie-break decides most charts, and it
 *      resolves towards the shorter run: a long stretch is described by fewer
 *      vertices before a dense one is topped up, because the short run is the one
 *      whose whole shape still fits. Ranking by length is the cheapest approximation
 *      of vertex density that does not require inspecting the values here, and it is
 *      deterministic.
 *
 * ## One priority order, not one per run length
 *
 * Phase 7A implemented the above as two passes partitioned by length: long runs were
 * seated in ranked order, then the one- and two-vertex runs were served **in raw index
 * order**. The peak band existed only inside the first pass, so it vanished exactly at
 * the class boundary. A chart whose maximum lived in a one-vertex run — a single heavy
 * delta in an attempt of zero width, which `compressAttempts` produces routinely — was
 * skipped by the anchor pass for being short and then competed in the second pass as an
 * ordinary run, on index alone. Two ordinary short runs ahead of it consumed the last
 * vertices of a saturated budget and the peak was refused:
 *
 *     170 runs x 3 vertices = 510 allocated; remaining 2
 *     index 170 (tps 10) -> 1, index 171 (tps 20) -> 1, index 172 (tps 9999) -> 0
 *
 * The repair is not a third pass. It is a single order over all runs, ranked by
 * retention priority and denominated in `minimumRunCost`, so "the peak-bearing run is
 * first" is a property of the whole allocation rather than of one of its stages. A
 * one-vertex run is not a lesser citizen of that order; it is simply the cheapest one.
 *
 * The allocation is a **pure function of run lengths and the budget**, and it is
 * applied per run. Flattening the runs into one series, downsampling that and
 * cutting it back apart is the one construction this module forbids: the cut points
 * would not fall on run boundaries, so a bridged line could appear across a stretch
 * where the phase produced nothing.
 *
 * Degradation policy when even the anchors do not fit: runs are refused in reverse
 * priority order, so the peak-bearing run is the last to be refused, and a run
 * given `0` is reported as `points: 0` with `degraded: true`. A caller must render
 * it as absent. The policy is stated rather than implied because an unbounded DOM is
 * the failure mode this function exists to remove.
 *
 * `peakRetained` reports whether the maximum actually survived. It is `false` only in
 * the formal corner where `minimumRunCost` of the peak-bearing run exceeds the whole
 * budget — unreachable at `MAX_RENDER_POINTS_TOTAL` (512), where the cost is at most
 * `MIN_MAX_POINTS` — and it exists so that corner cannot be reported as a preservation.
 *
 * @param {readonly {points?: readonly unknown[], length?: number}[]} runs in draw order
 * @param {number} [totalBudget] chart-wide vertex budget
 * @returns {{
 *   budgets:number[], total:number, allocated:number, degraded:number[],
 *   peakIndex:number, peakRetained:boolean,
 * }}
 *   `budgets[i]` is the allowance for `runs[i]`, `degraded` lists the indices that
 *   received `0`, `peakIndex` names the run carrying the chart maximum (`-1` when no
 *   run holds a finite rate) and `peakRetained` says whether it was seated
 */
function allocateRunBudgets(runs, totalBudget = MAX_RENDER_POINTS_TOTAL) {
  const list = Array.isArray(runs) ? runs : []
  const budget = Number.isFinite(totalBudget) && totalBudget > 0 ? Math.floor(totalBudget) : 0
  /**
   * A run's length, from its own `points` or from the explicit `length` a caller may
   * publish instead. The second form exists because a visual run is a slice of its
   * attempt's grid rather than a copy of it, and the allocation only ever needs the
   * count.
   */
  const lengths = list.map(run => (
    Number.isFinite(run?.length) ? Math.max(0, Math.floor(run.length))
      : (Array.isArray(run?.points) ? run.points.length : 0)
  ))
  const budgets = lengths.map(() => 0)
  if (list.length === 0 || budget <= 0) {
    return {
      budgets,
      total: budget,
      allocated: 0,
      degraded: lengths.map((_, index) => index),
      peakIndex: -1,
      /** Nothing was drawn, so nothing can be claimed as retained. */
      peakRetained: false,
    }
  }

  /**
   * The chart's maximum rate, recovered from the runs themselves rather than passed
   * in, so this function cannot be handed a peak that disagrees with the points it
   * is budgeting. The earliest run wins a tie, which keeps the allocation stable
   * when two runs share the maximum.
   */
  let peakIndex = -1
  let peakValue = Number.NEGATIVE_INFINITY
  for (let i = 0; i < lengths.length; i += 1) {
    for (const point of (Array.isArray(list[i].points) ? list[i].points : [])) {
      const rate = rateOf(point)
      if (rate !== null && rate > peakValue) {
        peakValue = rate
        peakIndex = i
      }
    }
  }
  /**
   * Exactly one run carries the priority band. `peakValue` starts below every finite
   * rate — `0` is finite — so a run is identified whenever any run holds a finite one,
   * including an all-zero chart, whose maximum is `0` and whose earliest run carries it.
   * Only a chart with no finite rate anywhere leaves `peakIndex` at `-1`, and only then
   * does no run receive priority, which is the correct reading rather than a fallback.
   */
  const conveysPeak = index => index === peakIndex

  /**
   * **The one priority order.** After the peak band, runs are ranked by what they
   * irreducibly cost (so the most runs survive a tight budget), then by **ascending
   * length** — the shorter run wins the tie, matching the surplus pass below, which
   * grants its vertices "to the shorter run first" — then by original index, which
   * makes the result a pure function of the input.
   *
   * The length tie-break is load-bearing rather than decorative: every run longer than
   * `MIN_MAX_POINTS` costs exactly `MIN_MAX_POINTS`, so cost alone cannot separate them
   * and the shorter run is the one served first among equals.
   */
  const ranked = lengths.map((length, index) => ({ index, length, cost: minimumRunCost(length) }))
    .sort((left, right) => (
      Number(conveysPeak(right.index)) - Number(conveysPeak(left.index))
      || left.cost - right.cost
      || left.length - right.length
      || left.index - right.index
    ))

  /**
   * **Minimum cost first, for every run, in that one order.** A run that does not fit is
   * left at `0` — refused outright rather than thinned below its own anchor contract —
   * and the ranking guarantees the peak-bearing run is the last one that could ever be
   * refused, whatever its length.
   *
   * Seating a run at its own minimum is also what keeps an unrunnable allowance off the
   * wire: `minimumRunCost` is the smallest value `downsampleSeries` can honour for that
   * length, so nothing between one and three is ever published for a longer run.
   */
  let allocated = 0
  const seated = new Set()
  for (const entry of ranked) {
    if (entry.cost === 0) continue
    if (allocated + entry.cost > budget) continue
    budgets[entry.index] = entry.cost
    allocated += entry.cost
    seated.add(entry.index)
  }

  /**
   * Surplus, shared out so that equal fairness goes to the shorter run first:
   * one vertex at a time around the ranking, which is what keeps a two-vertex run
   * from being starved by a four-hundred-vertex one. The loop terminates because
   * every pass either grants a vertex or finds nothing left to grant.
   *
   * Refused runs are skipped, and that guard is the one that matters: a run the seating
   * pass could not seat at its minimum must stay at `0`, because topping it up with
   * whatever surplus remains would hand it an allowance below its own irreducible cost —
   * an allowance `downsampleSeries` refuses outright and which cannot honour the first,
   * last and peak anchors it promises. A run is drawable at its minimum or it is not
   * drawable at all; there is no third state.
   */
  let remaining = budget - allocated
  while (remaining > 0) {
    let served = false
    for (const entry of ranked) {
      if (remaining <= 0) break
      if (!seated.has(entry.index)) continue
      const capacity = lengths[entry.index] - budgets[entry.index]
      if (capacity <= 0) continue
      const share = Math.max(1, Math.floor(remaining / ranked.length))
      const grant = Math.min(capacity, share)
      budgets[entry.index] += grant
      remaining -= grant
      served = true
    }
    if (!served) break
  }

  const degraded = []
  for (let i = 0; i < lengths.length; i += 1) {
    if (budgets[i] === 0 && lengths[i] > 0) degraded.push(i)
  }
  return {
    budgets,
    total: budget,
    allocated: budgets.reduce((sum, value) => sum + value, 0),
    degraded,
    peakIndex,
    /**
     * Vacuously true when there is no maximum to keep: a chart of nothing but zeros has
     * not lost anything. The only `false` is "the run carrying the chart's maximum could
     * not be drawn", which a caller must not present as a preserved peak.
     */
    peakRetained: peakIndex === -1 || budgets[peakIndex] > 0,
  }
}

/** Index of the first finite global maximum (or minimum) of a series. */
function extremeIndex(points, direction) {
  let best = -1
  let bestValue = 0
  for (let i = 0; i < points.length; i += 1) {
    const value = points[i]?.tps
    if (!Number.isFinite(value)) continue
    if (best === -1 || (direction > 0 ? value > bestValue : value < bestValue)) {
      best = i
      bestValue = value
    }
  }
  return best
}

/**
 * Reduce a series to at most `maxPoints` for rendering.
 *
 * Retention is a **priority list**, not one heuristic, because the budget can be
 * smaller than the number of interesting points and something has to give. In
 * order:
 *
 *   1. the two endpoints — the series must still start and end where it did;
 *   2. the global maximum — this is the point the card's `peak` refers to, and a
 *      rendering choice may never delete it;
 *   3. the global minimum — the trough a stall produces;
 *   4. `required`, a set of indices the caller cannot afford to lose (a **rendering
 *      seam**: a colour-transition vertex shared with the neighbouring run);
 *   5. uniform shape samples with whatever budget is left, so a long flat run
 *      still has vertices to be drawn with.
 *
 * The previous revision kept every local extremum and then, on budget overflow,
 * thinned that set by uniform stride — which is exactly the operation that can
 * step over the single global spike the chart exists to show. Ranking extrema by
 * prominence and reserving the anchors before anything else makes the peak and
 * the trough unconditional; `test/curve.test.js` carries the counterexample that
 * defeats the old stride.
 *
 * `required` sits between the trough and the shape samples because it is a
 * structural obligation rather than a shape preference: dropping a seam vertex
 * would reopen, as a blank horizontal gap, a tone change that is not a stall.
 *
 * Determinism: ties in the global extreme resolve to the earliest index, and
 * ties in prominence resolve to the earliest index, so two runs over equal input
 * return equal output.
 *
 * @param {readonly {timeMs:number, tps:number}[]} series
 * @param {number} [maxPoints] budget; must be `>= MIN_MAX_POINTS`
 * @param {{required?: ReadonlySet<number>}} [options]
 * @returns {{timeMs:number, tps:number}[]} at most `maxPoints` points, in
 *   non-decreasing `timeMs` order, drawn from the input objects themselves
 */
function downsampleSeries(series, maxPoints = DEFAULT_MAX_POINTS, options = {}) {
  const points = Array.isArray(series) ? series : []
  if (!(Number.isFinite(maxPoints) && maxPoints >= MIN_MAX_POINTS)) {
    /**
     * Refusing is the only honest answer: first, last and the global maximum
     * cannot all survive in fewer than three points, and silently breaking one
     * of the three guarantees would be a worse failure than a loud one.
     */
    throw new TypeError(`maxPoints must be a finite number >= ${MIN_MAX_POINTS}`)
  }
  if (points.length <= maxPoints) return points.slice()

  const lastIndex = points.length - 1
  /** 1-3. Mandatory anchors, in priority order; the Set de-duplicates them. */
  const keep = new Set()
  keep.add(0)
  keep.add(lastIndex)
  const peakIndex = extremeIndex(points, 1)
  if (peakIndex >= 0) keep.add(peakIndex)
  /**
   * The trough is the *recommended* fourth anchor rather than a guaranteed one:
   * a three-point budget must still be able to honour the three hard guarantees,
   * so the trough yields when there is no room for it and never the other way
   * round.
   */
  const troughIndex = extremeIndex(points, -1)
  if (troughIndex >= 0 && keep.size < maxPoints) keep.add(troughIndex)

  /** 4a. Seam vertices the caller requires, taken before any shape preference. */
  const required = options.required
  if (required instanceof Set) {
    for (const index of [...required].sort((a, b) => a - b)) {
      if (keep.size >= maxPoints) break
      if (Number.isInteger(index) && index >= 0 && index < points.length) keep.add(index)
    }
  }

  /** 4b. Local extrema, each with the prominence that ranks it. */
  const extrema = []
  for (let i = 1; i < lastIndex; i += 1) {
    const prev = points[i - 1]?.tps
    const here = points[i]?.tps
    const next = points[i + 1]?.tps
    if (!Number.isFinite(prev) || !Number.isFinite(here) || !Number.isFinite(next)) continue
    if (!((here > prev && here >= next) || (here < prev && here <= next))) continue
    extrema.push({ index: i, prominence: Math.abs(here - (prev + next) / 2) })
  }
  extrema.sort((left, right) => (
    right.prominence - left.prominence || left.index - right.index
  ))
  for (const extremum of extrema) {
    if (keep.size >= maxPoints) break
    keep.add(extremum.index)
  }

  /** 5. Whatever budget remains goes to evenly spaced shape samples. */
  const remaining = maxPoints - keep.size
  if (remaining > 0) {
    const stride = lastIndex / (remaining + 1)
    for (let k = 1; k <= remaining; k += 1) keep.add(Math.round(k * stride))
  }

  /**
   * Ascending index emission, then an explicit `timeMs` ordering: the drawn path
   * requires non-decreasing x, and guaranteeing it here means a caller cannot
   * produce a self-crossing polyline by handing in an out-of-order series. The
   * index tie-break keeps the sort stable, so equal timestamps keep input order.
   */
  const ordered = [...keep]
    .filter(index => index >= 0 && index < points.length)
    .sort((a, b) => a - b)
  const selected = ordered.map(index => points[index])
  selected.sort((left, right) => (
    (Number.isFinite(left?.timeMs) ? left.timeMs : 0) - (Number.isFinite(right?.timeMs) ? right.timeMs : 0)
  ))
  return selected
}

/**
 * Downsample one visual run without breaking the seams it shares with its neighbours.
 *
 * A visual run is a slice of its attempt's vertex grid, and at a phase transition it
 * shares its first or last vertex with the neighbouring run. Downsampling each run
 * independently would therefore be free to thin away **exactly** the vertex the two
 * runs have in common — the reasoning subpath would stop at its own last surviving
 * vertex and the output subpath would start at its own, leaving a blank horizontal
 * gap that looks like a stall and is not one (docs/METRICS_SPEC.md §8.6).
 *
 * The seam is protected by reserving the slice's own endpoints, which is also what
 * `downsampleSeries` does unconditionally for the first and last point: a run's
 * opening and closing vertices are anchors of its own contract. The two ends and the
 * four anchors fit in any budget of at least `MIN_MAX_POINTS`, because the reserve
 * happens before the shape samples and prefers those same anchors.
 *
 * @param {readonly object[]} points the slice, ascending
 * @param {number} budget at least `MIN_MAX_POINTS`, or the slice's own length
 * @returns {object[]} at most `budget` points, endpoints preserved
 */
function downsampleRun(points, budget) {
  const list = Array.isArray(points) ? points : []
  if (!(Number.isFinite(budget) && budget >= MIN_MAX_POINTS)) {
    throw new TypeError(`budget must be a finite number >= ${MIN_MAX_POINTS}`)
  }
  if (list.length <= budget) return list.slice()
  /**
   * The seam is the slice's own two endpoints, so reserving them is exactly what
   * keeps the tone change continuous. They are emitted in ascending `timeMs` order
   * like every other returned series.
   */
  const required = new Set([0, list.length - 1])
  const selected = downsampleSeries(list, budget, { required })
  selected.sort((left, right) => (
    (Number.isFinite(left?.timeMs) ? left.timeMs : 0) - (Number.isFinite(right?.timeMs) ? right.timeMs : 0)
  ))
  return selected
}

;Object.assign(__exports, { DEFAULT_WINDOW_MS, DEFAULT_SAMPLE_EVERY_MS, DEFAULT_MAX_POINTS, MAX_RENDER_POINTS_TOTAL, MIN_MAX_POINTS, totalRollingTpsSeries, attemptTrace, visualRunsOf, attemptTraces, peakTps, phaseRuns, phaseSpans, minimumRunCost, allocateRunBudgets, downsampleSeries, downsampleRun })
			},
			"src/core/types.js": function (__exports) {
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
function turnKey(sessionId, turn) {
  return `${String(sessionId)}::${String(turn)}`
}



;Object.assign(__exports, { turnKey })
			},
			"src/host/telemetry-design.js": function (__exports) {
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

const { LiveMeter, LivePhase } = __req("src/core/live-metrics.js")
const { sampleFromChunk, heuristicTokenWeight } = __req("src/core/token-allocation.js")
const { compressAttempts } = __req("src/core/time-axis.js")
const { curveSource } = __req("src/core/curve-source.js")
const { DEFAULT_SAMPLE_EVERY_MS: CURVE_SAMPLE_EVERY_MS, DEFAULT_WINDOW_MS: CURVE_WINDOW_MS, MAX_RENDER_POINTS_TOTAL, MIN_MAX_POINTS, allocateRunBudgets, attemptTraces, downsampleRun, peakTps, phaseRuns, visualRunsOf } = __req("src/core/curve.js")
const { aggregateTurn } = __req("src/core/aggregate-turn.js")
const { QualityLevel, clampToAxis, QUALITY_AXIS } = __req("src/core/quality-model.js")
const { turnKey } = __req("src/core/types.js")

/** How many settled turns are retained per session, newest first. */
const DEFAULT_HISTORY_LIMIT = 4

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
function curveQuality(aggregate) {
  const axes = aggregate?.quality ?? aggregate
  const level = axes?.temporalShapeQuality
  if (level === undefined) return QualityLevel.UNAVAILABLE
  return clampToAxis(QUALITY_AXIS.TEMPORAL_SHAPE, level)
}

class TurnTelemetryStore {
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

    // The curve is built from the same compressed clock the live meter used, so
    // a point read off it means the same thing the pill showed at that instant.
    const compressed = compressAttempts(source.attempts)

    /**
     * The rolling series is one **attempt-local total trace** per model attempt.
     * This ordering is the specification.
     *
     * The compressed clock concatenates attempts so a tool gap has no width, but a
     * trailing one-second window is a property of one model call. Rolling one window
     * across the concatenated list made the opening vertices of attempt B count
     * attempt A's trailing tokens — the two numbers are drawn a single pixel apart
     * and describe different calls, which is precisely the case a reader cannot
     * detect by looking at the chart. `attemptTraces` measures each attempt on its
     * own clock; `test/curve-attempt-boundary.test.js` carries the counterexample
     * that the previous implementation fails.
     *
     * Within one attempt the trace is **total**: every generated sample counts,
     * whatever its phase, which is what `LiveMeter` measures. Reasoning and output
     * are visual phases of that one measurement, carried on each vertex as
     * `activePhase`; they are not two rate definitions. The previous revision built
     * a separate per-phase series for each, so at a reasoning-to-output transition
     * the live pill showed the sum of both contributions while neither drawn line
     * did, and `peakTps` took the larger of two partial rates.
     */
    const traces = attemptTraces(compressed.segments, compressed.samples, {
      windowMs: CURVE_WINDOW_MS,
      sampleEveryMs: CURVE_SAMPLE_EVERY_MS,
      calibratedAttemptIds: calibratedIds,
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
     * `peakTps` below still reads the **full** series, and `downsampleRun`
     * independently guarantees the maximum survives into whatever budget it is
     * given, so the budget can thin the drawing but never move a reported number.
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
         * The **unbudgeted** total trace, so a test or a diagnostic can read the
         * series the peak was measured on. The renderer must use `runs`.
         */
        points: trace.points,
        /**
         * The attempt's own curve-source samples, on its attempt-local clock, exactly
         * as the rolling window read them. They are the bridge between a printed token
         * total and a drawn vertex, which is why they are published rather than left
         * to be reassembled from the runs.
         */
        samples: trace.samples,
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
        peak: runs.reduce((highest, run) => Math.max(highest, run.peak), 0),
      }
    })

    /**
     * The same allocation, counted the way the chart is drawn. `lineVertices` is the
     * number of path vertices the SVG will receive — runs of two or more points — and
     * `markers` is the number of one-vertex runs, each of which becomes a point marker
     * rather than a vertex of a line. Their sum is what `MAX_RENDER_POINTS_TOTAL`
     * bounds; see `renderBudget` below for why the two are never published as one
     * number called `drawnPoints`.
     *
     * A phase-transition vertex is charged **once**, to both of the runs that share it,
     * because it is drawn as the endpoint of both subpaths. That is why the sum below
     * is the honest count of emitted vertices and why the seam can never push the
     * chart past its own bound.
     */
    let lineVertices = 0
    let markers = 0
    for (const entry of series) {
      for (const run of entry.runs) {
        if (run.points.length >= 2) lineVertices += run.points.length
        else if (run.points.length === 1) markers += 1
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

;Object.assign(__exports, { DEFAULT_HISTORY_LIMIT, curveQuality, TurnTelemetryStore })
			},
			"src/dsh/raw.js": function (__exports) {
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
const DSH_RAW_KIND = Object.freeze({
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
function isDurableSessionEventEntry(entry) {
  if (!isObject(entry)) return false
  // Wrapped form: `{ type: 'event', event }`.
  if (entry.type === 'event') return isDurableSessionEventEntry(entry.event)
  if (typeof entry.type !== 'string' || entry.type === '') return false
  if (!Number.isFinite(entry.seq)) return false
  if (!Number.isFinite(entry.time)) return false
  return isObject(entry.data)
}

/** A client-folded transient row: `{type:'assistant/live-chunk', seq, time, data:{attemptId, chunk}}`. */
function isTransientLiveChunkEntry(entry) {
  if (!isObject(entry)) return false
  if (entry.type === 'transient') return isTransientLiveChunkEntry(entry.event)
  if (entry.type !== 'assistant/live-chunk') return false
  return isObject(entry.data) && typeof entry.data.attemptId === 'string'
}

/** A host-published assistant-stream frame. */
function isAssistantStreamFrame(value) {
  if (!isObject(value)) return false
  if (value.type !== 'start' && value.type !== 'chunk' && value.type !== 'end') return false
  return typeof value.attemptId === 'string'
}

/** Classify one raw entry without interpreting it. */
function classifyRawEntry(entry) {
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
function sessionKeyOf(entry) {
  if (!isObject(entry)) return null
  if (typeof entry.sessionId === 'string' && entry.sessionId !== '') return entry.sessionId
  if (isObject(entry.session) && entry.session.id !== undefined) return String(entry.session.id)
  return null
}

;Object.assign(__exports, { DSH_RAW_KIND, isDurableSessionEventEntry, isTransientLiveChunkEntry, isAssistantStreamFrame, classifyRawEntry, sessionKeyOf })
			},
			"src/dsh/stream-decoder.js": function (__exports) {
/**
 * Durable `AssistantStreamRecord` decoder — the DSH-facing surface.
 *
 * The decoding rules themselves live in `src/core/delta-accounting.js`
 * (`decodeAssistantStream` / `expandAssistantStream`) so that exactly one
 * implementation of the rule exists and `src/core` stays free of DSH imports.
 * This module adds only what is DSH-specific: locating the record array inside
 * a settlement payload, and turning decoder issues into this project's
 * quality vocabulary.
 *
 * What a successful decode guarantees, and therefore what the durable
 * reconstruction path is allowed to assume:
 *
 *   - every delta of the attempt, in logical stream order;
 *   - each delta's exact reconstructed wall-clock time, hence the exact gap
 *     (`dt`) to its predecessor;
 *   - the phase of each delta: `text-delta` and `tool-call-delta` are output,
 *     `reasoning-delta` is reasoning;
 *   - the block boundaries, because `block-start`/`block-end` are never packed
 *     into runs and therefore survive as raw `chunk` records;
 *   - the in-stream `usage` chunk and the `finish` chunk, likewise raw.
 *
 * When any record is malformed the decode reports it and marks itself
 * incomplete. It never invents a delta and never silently drops one: a stream
 * that lost a record yields a *lower quality* observation, which is a different
 * claim from an exact one.
 */

const { DECODE_ISSUE, decodeAssistantStream, expandAssistantStream, firstTokenTime, isTokenDelta } = __req("src/core/delta-accounting.js")
const { MetricQuality } = __req("src/core/metric-quality.js")

/** Chunk kinds a decoded stream can carry, in the vocabulary the core uses. */
const RECORD_KIND = Object.freeze({
  DELTA: 'delta',
  RAW: 'raw',
})

/** Event types that settle one attempt and embed its stream. */
const SETTLEMENT_EVENT_TYPES = Object.freeze(['assistant/message', 'assistant/attempt'])

/** How much of the stream survived decoding, as a metric-quality value. */
function decodeQuality(result) {
  if (!result || result.recordCount === 0) return MetricQuality.UNAVAILABLE
  if (result.deltaCount === 0 && result.recordCount > 0) return MetricQuality.UNAVAILABLE
  return result.complete ? MetricQuality.EXACT : MetricQuality.ESTIMATED
}

/**
 * Decode the compact records of one durable settlement.
 *
 * @param {unknown} records `assistant/message.stream` or `assistant/attempt.stream`
 * @param {{maxIssues?:number}} [options]
 * @returns {{
 *   chunks: {timeMs:number, chunk:object, recordIndex:number, memberIndex:number}[],
 *   issues: object[],
 *   issuesTruncated: boolean,
 *   recordCount: number,
 *   decodedRecordCount: number,
 *   deltaCount: number,
 *   firstTimeMs: number|null,
 *   lastTimeMs: number|null,
 *   complete: boolean,
 *   quality: string,
 *   generatedChunkCount: number,
 *   firstTokenTimeMs: number|null,
 * }}
 */
function decodeStreamRecords(records, options = {}) {
  const result = decodeAssistantStream(records, options)
  return decorate(result)
}

/**
 * Tolerant decode for the live path.
 *
 * The transient plane arrives one frame at a time and a rebaseline can hand the
 * client a compact prefix mid-attempt, so the tolerant reader is the right one
 * there: losing one curve segment beats losing the meter. It reports the same
 * issue vocabulary by re-deriving it, so a caller can tell the two apart.
 */
function expandAssistantStreamRaw(records) {
  const tolerant = expandAssistantStream(records)
  const strict = decodeAssistantStream(records, { maxIssues: 50 })
  const chunks = tolerant.map((entry, index) => ({
    timeMs: entry.timeMs,
    chunk: entry.chunk,
    recordIndex: -1,
    memberIndex: index,
  }))
  const times = chunks.map(entry => entry.timeMs)
  return decorate({
    chunks,
    issues: strict.issues,
    issuesTruncated: strict.issuesTruncated,
    recordCount: strict.recordCount,
    decodedRecordCount: strict.decodedRecordCount,
    deltaCount: strict.deltaCount,
    firstTimeMs: times.length > 0 ? Math.min(...times) : null,
    lastTimeMs: times.length > 0 ? Math.max(...times) : null,
    complete: strict.complete,
  })
}

function decorate(result) {
  const generated = result.chunks.filter(entry => isTokenDelta(entry.chunk))
  return {
    ...result,
    quality: decodeQuality(result),
    generatedChunkCount: generated.length,
    firstTokenTimeMs: firstTokenTime(result.chunks),
  }
}

/** Time of the first member this project counts as a generated first token. */
function firstTokenTimeOf(chunks) {
  return firstTokenTime(chunks)
}



;Object.assign(__exports, { DECODE_ISSUE, expandAssistantStream: expandAssistantStreamRaw, RECORD_KIND, SETTLEMENT_EVENT_TYPES, decodeQuality, decodeStreamRecords, expandAssistantStreamRaw, firstTokenTimeOf })
			},
			"src/dsh/adapter.js": function (__exports) {
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

const { classifyDelta, deltaText, isTokenDelta, usageFromChunk } = __req("src/core/delta-accounting.js")
const { MetricQuality, weakestQuality } = __req("src/core/metric-quality.js")
const { heuristicTokenWeight, sampleFromChunk } = __req("src/core/token-allocation.js")
const { decodeStreamRecords, SETTLEMENT_EVENT_TYPES } = __req("src/dsh/stream-decoder.js")

/** Normalized event kinds emitted by the mapping step. */
const NORMALIZED_KIND = Object.freeze({
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
const SETTLEMENT_KIND = Object.freeze({
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
const ATTEMPT_OUTCOME = Object.freeze({
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
function settlementClassification(eventType, data = {}) {
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
function transientEndClassification(outcome) {
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
function turnEndStatus(reason) {
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
function normalizeDurableEvent(event) {
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
function normalizeLiveChunk(entry) {
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
function normalizeStreamFrame(frame) {
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
function attemptFromDecoded({
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
function attemptEvidenceQuality(attempt) {
  const usageQuality = attempt?.usage === null || attempt?.usage === undefined
    ? MetricQuality.UNAVAILABLE
    : MetricQuality.EXACT
  const streamQuality = attempt?.decoded?.quality ?? MetricQuality.UNAVAILABLE
  return weakestQuality(streamQuality, usageQuality)
}



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
function applyRetryOutcomes(attempts, retries) {
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

;Object.assign(__exports, { SETTLEMENT_EVENT_TYPES, NORMALIZED_KIND, SETTLEMENT_KIND, ATTEMPT_OUTCOME, settlementClassification, transientEndClassification, turnEndStatus, normalizeDurableEvent, normalizeLiveChunk, normalizeStreamFrame, attemptFromDecoded, attemptEvidenceQuality, applyRetryOutcomes })
			},
			"src/dsh/live-path.js": function (__exports) {
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

const { MetricQuality } = __req("src/core/metric-quality.js")
const { heuristicTokenWeight, sampleFromChunk } = __req("src/core/token-allocation.js")
const { NORMALIZED_KIND, applyRetryOutcomes, normalizeDurableEvent, normalizeLiveChunk, normalizeStreamFrame, settlementClassification } = __req("src/dsh/adapter.js")

/** Why a transient frame was not accepted into the attempt. */
const FRAME_ISSUE = Object.freeze({
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
class LiveTurnAccumulator {
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
function accumulateLive({
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



;Object.assign(__exports, { settlementClassification, FRAME_ISSUE, LiveTurnAccumulator, accumulateLive })
			},
			"src/dsh/durable-path.js": function (__exports) {
/**
 * Durable (settlement) reconstruction path — path B.
 *
 * Path B reads only what survives a reload: the durable session log. It takes
 * turn and step boundaries, tool call/result pairs, and, for every attempt, the
 * compact `AssistantStreamRecord[]` embedded in its settlement, which it
 * decodes with the strict decoder. It never consults a transient frame.
 *
 * The point of path B is that a completed turn's card must be reconstructible
 * from the durable log alone. If the two paths disagree on a settled turn, the
 * live path is the one that is wrong, because only the durable log is replayable
 * evidence.
 */

const { isTokenDelta } = __req("src/core/delta-accounting.js")
const { heuristicTokenWeight, sampleFromChunk } = __req("src/core/token-allocation.js")
const { applyRetryOutcomes, settlementClassification, turnEndStatus } = __req("src/dsh/adapter.js")
const { decodeStreamRecords } = __req("src/dsh/stream-decoder.js")

/**
 * Reconstruct a turn from durable events.
 *
 * @param {{
 *   sessionId: string,
 *   turn: number,
 *   events: readonly object[],
 *   estimate?: Function,
 * }} input
 */
function reconstructFromDurable({ sessionId, turn, events = [], estimate }) {
  const ordered = [...events]
    .filter(event => event && typeof event === 'object' && typeof event.type === 'string')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

  const result = {
    sessionId: sessionId ?? null,
    turn: turn ?? null,
    turnStartMs: null,
    turnEndMs: null,
    status: null,
    statusNote: null,
    statusKnown: null,
    endReason: null,
    attempts: [],
    tools: [],
    steps: new Map(),
    issues: [],
    ignoredEventCount: 0,
    /** Scheduled durable retries (`llm/retry`), for attempt-outcome correlation. */
    retries: [],
    /** Raw evidence retained for auditing: the settlements exactly as recorded. */
    settlements: [],
  }

  const toolByCallId = new Map()
  const toolOrder = []

  for (const event of ordered) {
    const data = event.data ?? {}
    if (data.turn !== undefined && data.turn !== turn) continue
    switch (event.type) {
      case 'turn/start':
        result.turnStartMs = result.turnStartMs === null ? event.time : Math.min(result.turnStartMs, event.time)
        break
      case 'turn/end': {
        const mapped = turnEndStatus(data.reason)
        result.turnEndMs = event.time
        result.status = mapped.status
        result.statusNote = mapped.note
        result.statusKnown = mapped.known
        result.endReason = data.reason ?? null
        break
      }
      case 'step/start': {
        const step = result.steps.get(data.step) ?? { step: data.step, startMs: null, endMs: null }
        step.startMs = step.startMs === null ? event.time : Math.min(step.startMs, event.time)
        result.steps.set(data.step, step)
        break
      }
      case 'step/end': {
        const step = result.steps.get(data.step) ?? { step: data.step, startMs: null, endMs: null }
        step.endMs = event.time
        result.steps.set(data.step, step)
        break
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const decoded = decodeStreamRecords(data.stream)
        const issues = decoded.issues.map(issue => ({ ...issue, where: 'durable-stream', seq: event.seq }))
        result.issues.push(...issues)
        const durableUsage = data.usage && typeof data.usage === 'object' && Number.isFinite(data.usage.outputTokens)
          ? data.usage
          : null
        const inStreamUsage = durableUsage === null ? lastUsageChunk(decoded) : null
        const attempt = {
          attemptId: null,
          turn: data.turn ?? turn,
          step: data.step ?? null,
          ...settlementClassification(event.type, data),
          samples: [],
          chunks: decoded.chunks,
          decoded,
          usage: durableUsage ?? inStreamUsage,
          usageSource: durableUsage !== null ? 'assistant-settlement' : (inStreamUsage !== null ? 'in-stream-usage-chunk' : null),
          startedAtMs: null,
          settledAtMs: event.time,
          settlementSeq: event.seq,
          settlementEventType: event.type,
          interrupted: data.interrupted === true,
          issues,
          streamQuality: decoded.quality,
        }
        if (estimate !== undefined) {
          attempt.samples = samplesFromChunks(decoded.chunks, estimate)
        } else {
          attempt.samples = samplesFromChunks(decoded.chunks)
        }
        result.attempts.push(attempt)
        result.settlements.push({
          seq: event.seq,
          time: event.time,
          type: event.type,
          turn: data.turn,
          step: data.step,
          usage: durableUsage,
          interrupted: data.interrupted === true,
          recordCount: decoded.recordCount,
          deltaCount: decoded.deltaCount,
          streamQuality: decoded.quality,
        })
        break
      }
      case 'llm/retry':
        result.retries.push({
          kind: 'retry-scheduled',
          seq: event.seq,
          timeMs: event.time,
          turn: data.turn,
          step: data.step,
          retryId: typeof data.retryId === 'string' ? data.retryId : null,
          retry: Number.isFinite(data.retry) ? data.retry : null,
        })
        break
      case 'tool/call': {
        if (typeof data.callId !== 'string') {
          result.issues.push({ kind: 'tool-call-without-call-id', seq: event.seq })
          break
        }
        const record = toolByCallId.get(data.callId) ?? {
          callId: data.callId,
          name: data.name ?? null,
          startMs: event.time,
          status: 'running',
          argumentsRaw: data.arguments ?? null,
          step: data.step ?? null,
        }
        record.startMs = Math.min(record.startMs, event.time)
        if (typeof data.name === 'string') record.name = data.name
        toolByCallId.set(data.callId, record)
        if (!toolOrder.includes(data.callId)) toolOrder.push(data.callId)
        break
      }
      case 'tool/result': {
        const callId = Array.isArray(data.message?.content) ? data.message.content[0]?.toolCallId ?? null : null
        if (callId === null) {
          result.issues.push({ kind: 'tool-result-without-call-id', seq: event.seq })
          break
        }
        const record = toolByCallId.get(callId)
        if (record === undefined) {
          result.issues.push({ kind: 'unmatched-tool-result', seq: event.seq, callId })
          break
        }
        const block = data.message.content[0]
        record.endMs = event.time
        record.status = data.error !== undefined || block?.isError === true ? 'error' : 'ok'
        record.errorName = data.error?.name ?? null
        break
      }
      default:
        result.ignoredEventCount += 1
    }
  }

  result.tools = toolOrder.map(callId => toolByCallId.get(callId))
  for (const record of result.tools) {
    if (record.endMs === undefined) {
      result.issues.push({ kind: 'unmatched-tool-call', callId: record.callId, name: record.name })
    }
  }

  // Attempt order is settlement order, which is step order for a normal turn.
  result.attempts.sort((a, b) => (a.settlementSeq ?? 0) - (b.settlementSeq ?? 0))
  // An `assistant/attempt` outcome is `unknown` until a durable `llm/retry`
  // proves it was retried; the correlation runs after every settlement is in
  // place so ordering inside the log cannot hide the pairing.
  applyRetryOutcomes(result.attempts, result.retries)
  return result
}

function lastUsageChunk(decoded) {
  for (let index = decoded.chunks.length - 1; index >= 0; index -= 1) {
    const chunk = decoded.chunks[index].chunk
    if (chunk?.type === 'usage' && chunk.usage && Number.isFinite(chunk.usage.outputTokens)) return chunk.usage
  }
  return null
}

function samplesFromChunks(chunks, estimate = heuristicTokenWeight) {
  const samples = []
  for (const entry of chunks) {
    const sample = sampleFromChunk(entry.timeMs, entry.chunk, estimate)
    if (sample !== null) samples.push(sample)
  }
  return samples
}

/**
 * Settlement chronology for one turn, in durable order.
 *
 * This is the raw material of the generation-tail measurement: it pairs the
 * last non-empty model-producing delta of an attempt with the wall-clock time
 * at which DSH committed that attempt's settlement.
 */
function settlementChronology(turnRecord) {
  return turnRecord.attempts.map(attempt => ({
    settlementSeq: attempt.settlementSeq,
    settlementEventType: attempt.settlementEventType,
    settlementTimeMs: attempt.settledAtMs,
    turn: attempt.turn,
    step: attempt.step,
    usage: attempt.usage,
    interrupted: attempt.interrupted,
    streamQuality: attempt.streamQuality,
    lastDeltaTimeMs: lastGeneratedDeltaTime(attempt.chunks),
    firstDeltaTimeMs: firstGeneratedDeltaTime(attempt.chunks),
    deltaCount: attempt.decoded?.deltaCount ?? 0,
  }))
}

function lastGeneratedDeltaTime(chunks) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (isTokenDelta(chunks[index].chunk)) return chunks[index].timeMs
  }
  return null
}

function firstGeneratedDeltaTime(chunks) {
  for (const entry of chunks) {
    if (isTokenDelta(entry.chunk)) return entry.timeMs
  }
  return null
}

;Object.assign(__exports, { reconstructFromDurable, settlementChronology })
			},
			"src/dsh/index.js": function (__exports) {
/**
 * DSH adapter layer.
 *
 * The single responsibility of this directory is to translate **verified DSH
 * 0.1.5-rc.2 raw evidence** into this project's normalized engine events. No
 * other layer may know about DSH field names:
 *
 *   src/core   pure statistics, zero `@deepseek-ai/*` imports
 *   src/dsh    raw evidence  ->  normalized events   (this directory)
 *   src/host   in-memory store over normalized events
 *   src/client presentation only
 *
 * Evidence locations for every shape handled here are recorded in
 * `docs/IMPLEMENTATION_LOG.md`. Where DSH's runtime and DSH's published notes
 * disagree, the installed runtime wins and the divergence is logged.
 */

const { DSH_RAW_KIND } = __req("src/dsh/raw.js")
const { classifyRawEntry } = __req("src/dsh/raw.js")
const { isAssistantStreamFrame } = __req("src/dsh/raw.js")
const { isDurableSessionEventEntry } = __req("src/dsh/raw.js")
const { isTransientLiveChunkEntry } = __req("src/dsh/raw.js")
const { sessionKeyOf } = __req("src/dsh/raw.js")

const { DECODE_ISSUE } = __req("src/dsh/stream-decoder.js")
const { RECORD_KIND } = __req("src/dsh/stream-decoder.js")
const { SETTLEMENT_EVENT_TYPES } = __req("src/dsh/stream-decoder.js")
const { decodeQuality } = __req("src/dsh/stream-decoder.js")
const { decodeStreamRecords } = __req("src/dsh/stream-decoder.js")
const { expandAssistantStream } = __req("src/dsh/stream-decoder.js")
const { expandAssistantStreamRaw } = __req("src/dsh/stream-decoder.js")
const { firstTokenTimeOf } = __req("src/dsh/stream-decoder.js")

const { ATTEMPT_OUTCOME } = __req("src/dsh/adapter.js")
const { NORMALIZED_KIND } = __req("src/dsh/adapter.js")
const { SETTLEMENT_KIND } = __req("src/dsh/adapter.js")
const { applyRetryOutcomes } = __req("src/dsh/adapter.js")
const { attemptEvidenceQuality } = __req("src/dsh/adapter.js")
const { attemptFromDecoded } = __req("src/dsh/adapter.js")
const { normalizeDurableEvent } = __req("src/dsh/adapter.js")
const { normalizeLiveChunk } = __req("src/dsh/adapter.js")
const { normalizeStreamFrame } = __req("src/dsh/adapter.js")
const { settlementClassification } = __req("src/dsh/adapter.js")
const { transientEndClassification } = __req("src/dsh/adapter.js")
const { turnEndStatus } = __req("src/dsh/adapter.js")

const { FRAME_ISSUE } = __req("src/dsh/live-path.js")
const { LiveTurnAccumulator } = __req("src/dsh/live-path.js")
const { accumulateLive } = __req("src/dsh/live-path.js")

const { reconstructFromDurable } = __req("src/dsh/durable-path.js")
const { settlementChronology } = __req("src/dsh/durable-path.js")

;Object.assign(__exports, { DSH_RAW_KIND, classifyRawEntry, isAssistantStreamFrame, isDurableSessionEventEntry, isTransientLiveChunkEntry, sessionKeyOf, DECODE_ISSUE, RECORD_KIND, SETTLEMENT_EVENT_TYPES, decodeQuality, decodeStreamRecords, expandAssistantStream, expandAssistantStreamRaw, firstTokenTimeOf, ATTEMPT_OUTCOME, NORMALIZED_KIND, SETTLEMENT_KIND, applyRetryOutcomes, attemptEvidenceQuality, attemptFromDecoded, normalizeDurableEvent, normalizeLiveChunk, normalizeStreamFrame, settlementClassification, transientEndClassification, turnEndStatus, FRAME_ISSUE, LiveTurnAccumulator, accumulateLive, reconstructFromDurable, settlementChronology })
			},
			"src/dsh/client-feed.js": function (__exports) {
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

const { NORMALIZED_KIND, normalizeDurableEvent, normalizeLiveChunk } = __req("src/dsh/adapter.js")

/** Feed-level diagnostics; every entry names why evidence could not be used. */
const FEED_ISSUE = Object.freeze({
  MALFORMED_WINDOW: 'malformed-window',
  UNKNOWN_CHANGE: 'unknown-window-change',
  MISSING_CHANGE_ENTRIES: 'missing-change-entries',
  MALFORMED_ENTRY: 'malformed-entry',
  DUPLICATE_TRANSIENT: 'duplicate-transient-row',
  DUPLICATE_DURABLE: 'duplicate-durable-event',
  UNMATCHED_SETTLEMENT: 'settlement-without-attempt-id',
  /**
   * A transient row naming a turn this client has already finished with. The
   * row is not delivered — re-opening a settled turn would resurrect a closed
   * record and a card that has already been built — but it is recorded, because
   * a late frame is a real wire behaviour and silence would hide it.
   */
  LATE_TURN_ROW: 'transient-row-of-a-finished-turn',
})

class SessionEventFeed {
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
    /**
     * Turns this feed has seen close (`turn/end`). A late transient row of any
     * of them must not re-open the turn: its record has already been settled and
     * its evidence handed to the completed card. Keyed by identity rather than a
     * single "last settled" number, because a settlement can be followed by rows
     * of an older turn.
     */
    this.settledTurns = new Set()
    /**
     * The highest turn number observed so far, or `null`. Turns are ordered
     * within a session, so a transient row below it is late evidence of a turn
     * the feed has already moved past (`adoptTurn`).
     */
    this.highestTurn = null
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
    /**
     * The turn-adoption guards are generation state too. A new window is a new
     * set of rows: a turn this client had already closed may legitimately be
     * the open turn of the replayed window, and a window may begin at any turn.
     * Keeping the previous generation's `highestTurn` would refuse the adoption
     * the reload just made necessary.
     */
    this.settledTurns = new Set()
    this.highestTurn = null
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

  /**
   * Derive the open-turn boundary from transient evidence.
   *
   * The published window is a live *tail*: after a reload — or after a
   * `replace` rebaseline, which is what a reconnect produces — the open turn's
   * `turn/start` row is normally outside it. A page that attaches mid-turn then
   * knows the turn only from the `turn` field of its transient rows. Without a
   * boundary every turn-scoped event is discarded ("belongs to no turn") and
   * the live view never appears at all.
   *
   * The first transient row naming a turn the feed is not tracking is therefore
   * adopted as the boundary — the same client-side derivation the attempt
   * boundary below already relies on. The emitted event carries
   * `recovered: true` because it is *inferred*, not observed: consumers must not
   * restart turn-scoped stopwatches from it, and the turn's start time stays
   * unknown (`timeMs: null`) so TTFT is never measured from the reload.
   *
   * A turn already closed by a durable `turn/end` is never re-opened, and a turn
   * the feed has already moved past is never re-adopted: both guards are per turn
   * identity, because a turn number is an identity and the rows of one turn can
   * arrive interleaved with another's. A row that names no *finite* turn adopts
   * nothing — there is nothing to name, and guessing one would attach this
   * client's evidence to a turn it cannot identify.
   */
  adoptTurn(turn) {
    if (!Number.isFinite(turn)) return false
    if (turn === this.openTurn) return false
    if (this.settledTurns.has(turn)) return false
    /** Turns are ordered, so a row below the highest observed one is late evidence of a past turn. */
    if (Number.isFinite(this.highestTurn) && turn < this.highestTurn) return false
    this.markTurnSeen(turn)
    this.openTurn = turn
    this.emit({ kind: NORMALIZED_KIND.TURN_START, turn, timeMs: null, recovered: true })
    return true
  }

  /**
   * Record that a turn number has been observed, whichever plane named it.
   *
   * This is the ordering watermark `adoptTurn` compares against, and it is fed
   * by transient rows and durable turn rows alike: a turn established by a
   * durable boundary — a row the client *did* observe, fully — must not later be
   * re-opened by the synthetic path either.
   */
  markTurnSeen(turn) {
    if (!Number.isFinite(turn)) return
    if (!Number.isFinite(this.highestTurn) || turn > this.highestTurn) this.highestTurn = turn
  }

  /**
   * Drop a transient row that belongs to a turn this feed has already finished
   * with, and record why.
   *
   * The row is *not* delivered. A turn closed by `turn/end` has a settled record
   * and a card; feeding a late delta into it would re-open a turn the session
   * ended, and the attempt identity it carries is no longer open, so the value it
   * would contribute is not the live view's business. Dropping it silently would
   * hide a real wire behaviour, so it is counted as an issue.
   */
  dropLateRow(turn, attemptId) {
    this.issue(FEED_ISSUE.LATE_TURN_ROW, { turn, attemptId })
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
    this.markTurnSeen(normalized.turn)
    const adopted = this.adoptTurn(normalized.turn)
    if (!adopted && Number.isFinite(normalized.turn)) {
      /**
       * The row names a finite turn that was not adopted. Either the turn is
       * already the open one — the ordinary case, every row after the first —
       * or it is a turn this client has finished with, and its late evidence is
       * dropped rather than re-attached to a settled record.
       */
      if (normalized.turn !== this.openTurn) {
        this.dropLateRow(normalized.turn, normalized.attemptId)
        return
      }
    }
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
        this.markTurnSeen(normalized.turn)
        this.emit(normalized)
        return
      case NORMALIZED_KIND.TURN_END:
        this.openTurn = null
        this.openAttemptId = null
        if (Number.isFinite(normalized.turn)) this.settledTurns.add(normalized.turn)
        this.markTurnSeen(normalized.turn)
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

;Object.assign(__exports, { FEED_ISSUE, SessionEventFeed })
			},
			"src/client/format.js": function (__exports) {
/**
 * Display formatting.
 *
 * Two rules govern everything here:
 *
 *   1. Absent evidence renders as an em dash. A missing measurement must never
 *      be shown as `0`, because that would claim a measured zero.
 *   2. Quality is *not* baked into the string. Whether a value deserves a `≈`
 *      prefix or a quality indicator is decided by the renderer from the
 *      metric's declared quality, so the exactness claim has exactly one home.
 */

const DASH = '—'

function formatSeconds(ms, digits = 1) {
  if (!Number.isFinite(ms)) return DASH
  return `${(ms / 1000).toFixed(digits)}s`
}

/**
 * Running stopwatch split into its number and its unit.
 *
 * The reference renders the first-response counter as a large number followed by
 * a visibly smaller unit, so the two parts must be separately styleable. Keeping
 * the split here — next to the rules that decide the digits — means the visible
 * pair and `formatCountdown`'s flat string can never disagree about precision.
 *
 * @returns {{value: string, unit: string|null}} `unit` is `null` for absent evidence
 */
function countdownParts(ms, digits = 2) {
  if (!Number.isFinite(ms)) return { value: DASH, unit: null }
  return { value: (ms / 1000).toFixed(digits), unit: 's' }
}

/** Running TTFT counter form: `2.80 s`. */
function formatCountdown(ms, digits = 2) {
  const parts = countdownParts(ms, digits)
  return parts.unit === null ? parts.value : `${parts.value} ${parts.unit}`
}

/**
 * Rate and magnitude display. Three-significant-figure behaviour without
 * exponent notation at the low end, where token rates are most often read.
 *
 * The same function formats the card's TPS values and its token magnitudes,
 * because both are "a number with a unit" and the specification freezes one
 * formatter for the card rather than one per column. Counts of a thousand or more
 * therefore keep locale grouping: `54,770` is the reference's number, and
 * compacting it to `54770` would be a formatting accident rather than a layout
 * decision. `formatTokens` remains the explicit integer formatter for secondary
 * lines.
 */
function formatTps(value) {
  if (!Number.isFinite(value)) return DASH
  /**
   * Round **before** choosing the precision band. `9.999` must read `10.0`, not
   * `10.00`: picking the band from the unrounded value would print a
   * two-decimal number for a value already past ten.
   */
  const rounded = Math.round(value * 100) / 100
  if (rounded >= 1000) return formatTokens(rounded)
  if (rounded >= 100) return Math.round(rounded).toString()
  if (rounded >= 10) return rounded.toFixed(1)
  return rounded.toFixed(2)
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return DASH
  const rounded = Math.round(value)
  // `-0` is a display artefact of rounding, not a magnitude: it must not reach
  // the DOM as `-0`.
  return (rounded === 0 ? 0 : rounded).toLocaleString('en-US')
}

/** Compact elapsed form used on secondary lines: `133.6s`, `2m42s`. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`
}



;Object.assign(__exports, { DASH, formatSeconds, countdownParts, formatCountdown, formatTps, formatTokens, formatDuration })
			},
			"src/client/ui-model.js": function (__exports) {
/**
 * Pure view-model shaping.
 *
 * Keeping this layer pure means the component tree contains no statistics and no
 * transport knowledge, so screenshots and component tests are independent of
 * DSH. The inputs are the snapshots produced by `src/core/live-metrics.js` and
 * the settled turn record from `src/host/telemetry-design.js`.
 *
 * The completed half of this module is the **only** seam between the settled
 * snapshot and the completed card: quality, approximate markers, em-dash
 * fallbacks and every displayed string are decided here, so the React component
 * renders fields instead of interpreting statistics.
 */

const { MetricQuality, weakestQuality } = __req("src/core/metric-quality.js")
const { QualityLevel, requiresApproximateMarker } = __req("src/core/quality-model.js")
const { formatSeconds, formatTps, formatTokens, DASH } = __req("src/client/format.js")

/** Shared shape for a value that may legitimately be absent. */
function value(value, quality) {
  return { value: value ?? null, quality: quality ?? MetricQuality.UNAVAILABLE, available: value !== null && value !== undefined }
}

/**
 * Live branch selection. `idle` and `settled` both render nothing here: an idle
 * meter has no turn, and a settled turn belongs to the completed card.
 */
function liveViewModel(snapshot) {
  if (!snapshot || snapshot.phase === 'idle' || snapshot.phase === 'settled') return { kind: 'hidden' }

  if (snapshot.phase === 'tool') {
    return {
      kind: 'tool',
      turn: snapshot.turn,
      runningToolCount: snapshot.runningToolCount ?? 0,
      runningToolNames: snapshot.runningToolNames ?? [],
      /** The compact label prefers a single tool name and falls back to a count. */
      label: (snapshot.runningToolCount ?? 0) === 1
        ? (snapshot.runningToolNames?.[0] ?? 'tool')
        : `Tools ${snapshot.runningToolCount ?? 0}`,
      toolElapsed: value(snapshot.toolElapsedMs ?? null, MetricQuality.EXACT),
      turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
    }
  }

  if (snapshot.phase === 'streaming') {
    return {
      kind: 'streaming',
      turn: snapshot.turn,
      activePhase: snapshot.activePhase ?? null,
      /**
       * Live TPS is a shape estimate until provider usage arrives after
       * settlement, so it is never presented as exact.
       */
      tps: value(snapshot.tps ?? null, snapshot.tpsQuality ?? MetricQuality.ESTIMATED),
      turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
    }
  }

  // Pending: turn open, no generated delta yet. The UI shows the TTFT counter.
  return {
    kind: 'ttft',
    turn: snapshot.turn,
    /** Running counter: the final TTFT is not known until the first delta lands. */
    ttft: value(snapshot.ttftMs ?? null, snapshot.ttftMs === null ? MetricQuality.ESTIMATED : MetricQuality.EXACT),
    turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
  }
}

/**
 * Turn status as the card must present it.
 *
 * `status` is the settlement outcome derived from `turn/end`; `statusNote`
 * carries the finer fact (why it was aborted, which ceiling truncated it). The
 * truncated case is its own presentation kind because "completed" alone would
 * hide that the model stopped at a token ceiling.
 */
function completedStatusOf(status, statusNote) {
  if (status === 'interrupted') return { kind: 'interrupted', detail: statusNote ?? null, tone: 'warn' }
  if (status === 'errored') return { kind: 'errored', detail: statusNote ?? null, tone: 'error' }
  if (statusNote === 'max-tokens') return { kind: 'max-tokens', detail: null, tone: 'warn' }
  return { kind: 'completed', detail: statusNote ?? null, tone: 'neutral' }
}

/**
 * Duration on a secondary line.
 *
 * The completed card uses the reference's one-decimal **second** scale at every
 * magnitude (`108.2s`, `133.6s`), because these lines are read against the
 * reference layout and against each other; the shared `formatDuration` helper's
 * minute form stays the live pill's format, where a running turn can be read for
 * hours and compactness matters more than comparison.
 */
function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH
  return formatSeconds(ms, 1)
}

/**
 * A duration paired with a token count on one secondary line.
 *
 * The two halves are one derivation chain, so they share one approximate
 * decision: a token count that is not measured may never be printed bare next to
 * a rate that carries `≈`. A phase with no tokens and no duration is omitted
 * rather than printed as a zero.
 */
function phaseSecondary(durationMs, tokens, approximateTokens) {
  const parts = []
  const hasDuration = Number.isFinite(durationMs) && durationMs > 0
  const hasTokens = tokens !== null && tokens !== undefined
  if (hasDuration) parts.push(durationText(durationMs))
  if (hasTokens) parts.push(`${approximateTokens ? '≈' : ''}${formatTokens(tokens)}`)
  else if (hasDuration) parts.push(DASH)
  return parts.length === 0 ? null : { kind: 'phase', text: parts.join(' · '), approximate: approximateTokens === true }
}

/**
 * One of the four principal columns.
 *
 * `display` is resolved here rather than in the component, and `format` lets a
 * column state its own unit convention: token magnitudes read through
 * three-significant-figure formatting (`345`, `54,770`), while a duration in
 * seconds is always two decimals (`1.44`), so a 1440 ms TTFT can never be
 * printed as the token-like `1,440`.
 */
function metricCell({ key, labelKey, value: metricValue, unit = null, secondary = null, approximate = false, format = formatTps }) {
  const available = metricValue.value !== null && metricValue.value !== undefined
  return {
    key,
    labelKey,
    value: metricValue.value,
    display: available ? (approximate ? `≈${format(metricValue.value)}` : format(metricValue.value)) : DASH,
    unit: available ? unit : null,
    quality: metricValue.quality,
    approximate: approximate && available,
    available,
    secondary,
  }
}

/**
 * Completed card view model.
 *
 * Four principal columns are fixed by the UI specification and always present in
 * the same order; tool statistics stay on the footer line and never become a
 * fifth column. Display quality follows the settled snapshot's three-axis model:
 *
 *   - `tokenTotalQuality === exact`  -> a bare generated-token total;
 *   - anything weaker                -> `≈` on the number it qualifies;
 *   - `phaseSplitQuality === exact`   -> bare reasoning/output rates and counts;
 *   - `unavailable`                  -> `—`, never `0`.
 */
function completedViewModel(settled) {
  if (!settled || !['completed', 'interrupted', 'errored'].includes(settled.status)) return null

  const quality = settled.quality ?? {}
  const tokenTotalExact = quality.tokenTotalQuality === QualityLevel.EXACT
  const phaseSplitExact = quality.phaseSplitQuality === QualityLevel.EXACT

  /**
   * A partial total has a real observed sum but no complete evidence: publishing
   * the exact figure would claim coverage the turn does not have, so the partial
   * sum is shown with `≈` and the field is explicitly marked partial.
   */
  /**
   * A partial or recovered total has a real sum but no complete evidence:
   * publishing it bare would claim coverage the turn does not have, and `0` is
   * never a substitute for "not measured", so only a genuine observed sum is
   * published and it is always marked approximate.
   */
  const observed = Number.isFinite(settled.observedGeneratedTokens) ? settled.observedGeneratedTokens : 0
  const generatedValue = Number.isFinite(settled.generatedTokens)
    ? settled.generatedTokens
    : (observed > 0 ? observed : null)
  /** Only a fully authoritative total may be printed without `≈`. */
  const generatedApproximate = !tokenTotalExact

  const tools = settled.tools ?? {}
  const status = completedStatusOf(settled.status, settled.statusNote)
  const phaseTokens = settled.phaseTokens ?? { reasoning: null, output: null }
  /** Counters derived from the provider split are exact; everything else is not. */
  const phaseCountsApproximate = !phaseSplitExact

  const columns = [
    metricCell({
      key: 'reasoningTps',
      labelKey: 'colReasoningTps',
      unit: 'tokens/s',
      value: value(settled.reasoningTps ?? null, settled.reasoningTpsQuality),
      approximate: requiresApproximateMarker(settled.reasoningTpsQuality),
      secondary: phaseSecondary(settled.reasoningMs, phaseTokens.reasoning, phaseCountsApproximate),
    }),
    metricCell({
      key: 'outputTps',
      labelKey: 'colOutputTps',
      unit: 'tokens/s',
      value: value(settled.outputTps ?? null, settled.outputTpsQuality),
      approximate: requiresApproximateMarker(settled.outputTpsQuality),
      secondary: phaseSecondary(settled.outputMs, phaseTokens.output, phaseCountsApproximate),
    }),
    metricCell({
      key: 'generatedTokens',
      labelKey: 'colGeneratedTokens',
      unit: 'tokens',
      value: value(generatedValue, quality.tokenTotalQuality ?? MetricQuality.UNAVAILABLE),
      approximate: generatedApproximate,
      secondary: Number.isFinite(settled.turnElapsedMs)
        ? { kind: 'elapsed', labelKey: 'elapsed', ms: settled.turnElapsedMs, display: durationText(settled.turnElapsedMs) }
        : null,
    }),
    metricCell({
      key: 'ttft',
      labelKey: 'colTtft',
      unit: 's',
      value: value(settled.ttftMs ?? null, MetricQuality.EXACT),
      /** Bare two-decimal seconds; the `s` unit is rendered by the column. */
      format: milliseconds => Number.isFinite(milliseconds) ? (milliseconds / 1000).toFixed(2) : DASH,
      secondary: { kind: 'status', statusKey: `status.${status.kind}`, detail: status.detail, tone: status.tone },
    }),
  ]

  return {
    kind: 'completed',
    /**
     * The live state machine's terminal state. Both views expose `state` so the
     * projection identity used by the controller's cache is uniform across them.
     */
    state: 'settled',
    sessionId: settled.sessionId ?? null,
    turn: settled.turn,
    /** Turn identity for the projection cache: one string per settled view. */
    projectionKey: `completed:${settled.sessionId ?? ''}:${settled.turn ?? ''}`,
    status: status.kind,
    statusDetail: settled.statusNote ?? null,
    columns,
    elapsedMs: Number.isFinite(settled.turnElapsedMs) ? settled.turnElapsedMs : null,
    elapsedDisplay: durationText(settled.turnElapsedMs),
    tools: {
      count: tools.count ?? 0,
      completedCount: tools.completedCount ?? 0,
      wallMs: tools.wallMs ?? 0,
      wallDisplay: durationText(tools.wallMs ?? 0),
      workMs: tools.workMs ?? 0,
      workDisplay: durationText(tools.workMs ?? 0),
      failedCount: tools.failedCount ?? 0,
      names: tools.names ?? [],
    },
    attemptCount: settled.attemptCount ?? 0,
    quality: {
      tokenTotalQuality: quality.tokenTotalQuality ?? QualityLevel.UNAVAILABLE,
      phaseSplitQuality: quality.phaseSplitQuality ?? QualityLevel.UNAVAILABLE,
      displayTokenTotal: quality.displayTokenTotal ?? 'unavailable',
      displayPhaseSplit: quality.displayPhaseSplit ?? 'unavailable',
      /** Weakest axis: what a single `data-quality` attribute may say. */
      overall: weakestQuality(
        quality.tokenTotalQuality === QualityLevel.EXACT ? MetricQuality.EXACT : MetricQuality.ESTIMATED,
        quality.phaseSplitQuality === QualityLevel.EXACT ? MetricQuality.EXACT : MetricQuality.ESTIMATED,
      ),
    },
    /**
     * Provider/stream contradictions observed while aggregating. Never printed in
     * the production card (the quality downgrade already reaches the numbers); it
     * travels for diagnostics and for Phase 8's settings surface.
     */
    consistencyIssues: Array.isArray(settled.consistencyIssues) ? settled.consistencyIssues : [],
    /**
     * Retained for Phase 5's hover/focus curve view. Phase 4 renders no chart and
     * the component must not read this field.
     */
    curve: settled.curve ?? null,
  }
}

;Object.assign(__exports, { liveViewModel, completedStatusOf, completedViewModel })
			},
			"src/client/live/live-state.js": function (__exports) {
/**
 * The explicit live-UI state machine.
 *
 * The eight presentation states are frozen in `docs/UI_SPEC.md` §3. The rule
 * this module exists to enforce: a React component never *guesses* the current
 * situation from a handful of possibly-undefined fields. Every transition is an
 * explicit reaction to one normalized event, and every state has a written
 * entry and exit condition.
 *
 *   inactive              no open turn for this session — render nothing
 *   pending-first-token   turn/start seen, no first model-producing delta yet;
 *                         the turn's ONE TTFT stopwatch stage
 *   streaming-reasoning   active attempt generating reasoning deltas
 *   streaming-output      active attempt generating text / tool-argument deltas
 *   tool-running          at least one tool call active — no model TPS
 *   waiting-model         turn TTFT already frozen; a new step/attempt is
 *                         started or imminent, no delta yet — never the TTFT
 *                         counter again
 *   transition            brief neutral gap (settlement before tool/call, tool
 *                         result before next step/start, retry backoff) — no
 *                         stale TPS
 *   settled               turn/end received — exit live mode immediately
 *
 * The machine tracks the *model side* plus a tool-activity counter; numeric
 * values (TPS, elapsed, tool timer) are read from the `LiveMeter` snapshot by
 * the presenter, never recomputed here.
 */

const LiveUiState = Object.freeze({
  INACTIVE: 'inactive',
  PENDING_FIRST_TOKEN: 'pending-first-token',
  STREAMING_REASONING: 'streaming-reasoning',
  STREAMING_OUTPUT: 'streaming-output',
  TOOL_RUNNING: 'tool-running',
  WAITING_MODEL: 'waiting-model',
  TRANSITION: 'transition',
  SETTLED: 'settled',
})

function initialLiveUi() {
  return {
    state: LiveUiState.INACTIVE,
    turn: null,
    /** Frozen by the first accepted model-producing delta of the turn. */
    ttftFrozen: false,
    /** Entry time of the current waiting/transition stage, for its stopwatch. */
    sinceMs: null,
    /** Active tool-call counter; > 0 means the tool-running stage owns the view. */
    activeTools: 0,
  }
}

/** Events are normalized vocabulary only — never raw DSH shapes. */
const LIVE_UI_EVENT = Object.freeze({
  TURN_START: 'turn-start',
  TURN_END: 'turn-end',
  STEP_START: 'step-start',
  ATTEMPT_START: 'attempt-start',
  DELTA: 'delta',
  ATTEMPT_SETTLE: 'attempt-settle',
  ATTEMPT_ABANDON: 'attempt-abandon',
  RETRY: 'retry',
  TOOL_START: 'tool-start',
  TOOL_END: 'tool-end',
  RESET: 'reset',
})

const { INACTIVE, PENDING_FIRST_TOKEN, STREAMING_REASONING, STREAMING_OUTPUT, TOOL_RUNNING, WAITING_MODEL, TRANSITION, SETTLED } = LiveUiState

/** An event naming a different turn than the one on screen changes nothing. */
function wrongTurn(machine, event) {
  if (machine.state === INACTIVE) return true
  if (event.turn === undefined || event.turn === null) return false
  if (machine.turn === null) return false
  return event.turn !== machine.turn
}

function settleTo(machine, event) {
  // A settlement does not end running tools; the tool stage keeps the view
  // until the last call settles.
  if (machine.activeTools > 0) return machine
  return { ...machine, state: TRANSITION, sinceMs: event.timeMs ?? machine.sinceMs }
}

/**
 * Reduce the live UI machine by one normalized event. Pure: returns the same
 * object when the event changes nothing, so callers can detect no-ops.
 */
function reduceLiveUi(machine, event) {
  if (event === null || typeof event !== 'object') return machine
  switch (event.type) {
    case LIVE_UI_EVENT.RESET:
      return initialLiveUi()

    case LIVE_UI_EVENT.TURN_START: {
      // A replayed durable turn/start for the open turn must not restart the
      // TTFT stage or wipe the frozen marker.
      if (machine.state !== INACTIVE && machine.state !== SETTLED && event.turn === machine.turn) return machine
      /**
       * Adopted boundary (`recovered`): the page attached mid-turn and the
       * open turn's `turn/start` was outside the published window, so this
       * turn's TTFT was never observed *here*. The turn opens in the neutral
       * waiting stage with the TTFT stopwatch already frozen as unknown —
       * restarting it would print a TTFT measured from the reload.
       */
      if (event.recovered === true) {
        return {
          state: WAITING_MODEL,
          turn: event.turn ?? machine.turn,
          ttftFrozen: true,
          sinceMs: null,
          activeTools: 0,
        }
      }
      return {
        state: PENDING_FIRST_TOKEN,
        turn: event.turn ?? machine.turn,
        ttftFrozen: false,
        sinceMs: event.timeMs ?? null,
        activeTools: 0,
      }
    }

    case LIVE_UI_EVENT.TURN_END: {
      if (wrongTurn(machine, event)) return machine
      return { ...machine, state: SETTLED, sinceMs: event.timeMs ?? machine.sinceMs, activeTools: 0 }
    }

    case LIVE_UI_EVENT.STEP_START: {
      if (wrongTurn(machine, event) || machine.state === SETTLED) return machine
      if (machine.activeTools > 0) return machine
      if (!machine.ttftFrozen) {
        // The turn's one and only first-token stage: later step boundaries
        // must not restart it.
        return { ...machine, state: PENDING_FIRST_TOKEN }
      }
      return { ...machine, state: WAITING_MODEL, sinceMs: event.timeMs ?? null }
    }

    case LIVE_UI_EVENT.ATTEMPT_START: {
      if (wrongTurn(machine, event) || machine.state === SETTLED) return machine
      if (machine.activeTools > 0) return machine
      if (!machine.ttftFrozen) return { ...machine, state: PENDING_FIRST_TOKEN }
      // Turn TTFT is already frozen; a later attempt can only wait.
      return { ...machine, state: WAITING_MODEL, sinceMs: event.timeMs ?? null }
    }

    case LIVE_UI_EVENT.DELTA: {
      if (wrongTurn(machine, event) || machine.state === SETTLED) return machine
      if (machine.state === INACTIVE) return machine
      const phase = event.phase === 'reasoning' ? STREAMING_REASONING : STREAMING_OUTPUT
      // The first accepted delta of the turn freezes the TTFT stopwatch. No
      // later event in this turn ever returns to pending-first-token.
      return { ...machine, state: phase, ttftFrozen: true, sinceMs: machine.sinceMs }
    }

    case LIVE_UI_EVENT.ATTEMPT_SETTLE: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      return settleTo(machine, event)
    }

    case LIVE_UI_EVENT.ATTEMPT_ABANDON: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      return settleTo(machine, event)
    }

    case LIVE_UI_EVENT.RETRY: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      // Retry backoff is a neutral gap: no model deltas, no tool yet.
      return settleTo(machine, event)
    }

    case LIVE_UI_EVENT.TOOL_START: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      return { ...machine, activeTools: machine.activeTools + 1, state: TOOL_RUNNING }
    }

    case LIVE_UI_EVENT.TOOL_END: {
      if (wrongTurn(machine, event) || machine.state === SETTLED || machine.state === INACTIVE) return machine
      const remaining = Math.max(0, machine.activeTools - 1)
      if (remaining > 0) return { ...machine, activeTools: remaining }
      // The last tool ended. Until the next step/start arrives the UI is in
      // the neutral gap the specification calls transition; if the turn never
      // produced a first token the TTFT stage is still the honest view.
      if (!machine.ttftFrozen) return { ...machine, activeTools: 0, state: PENDING_FIRST_TOKEN }
      return { ...machine, activeTools: 0, state: TRANSITION, sinceMs: event.timeMs ?? null }
    }

    default:
      return machine
  }
}

;Object.assign(__exports, { LiveUiState, initialLiveUi, LIVE_UI_EVENT, reduceLiveUi })
			},
			"src/client/live/live-presenter.js": function (__exports) {
/**
 * Live presenter: machine state + LiveMeter snapshot -> render view model.
 *
 * Layering rule enforced here: statistics (trailing TPS, TTFT, tool-episode
 * wall time, turn elapsed) come from the `LiveMeter` snapshot untouched; the
 * state machine decides *what kind* of view this is; the presenter combines the
 * two and applies the defensive guards. The React layer receives a finished
 * view model and computes nothing.
 *
 * Defensive guards, each of which fails toward "show less", never toward
 * "show a stale number":
 *
 *   - machine inactive/settled, or meter idle/settled  -> hidden
 *   - streaming state without a live streaming snapshot -> transition
 *     (a settlement or tool event the machine has not folded yet must not leak
 *     the previous TPS)
 *   - pending state with an already-frozen TTFT        -> waiting
 *   - tool stage resolved from the machine OR the meter -> tool view, values
 *     strictly from the meter snapshot
 *
 * Every view carries `approximate` derived from metric quality: live TPS is
 * `estimated`, so it always renders with `≈`.
 */

const { MetricQuality, requiresApproximateMarker } = __req("src/core/quality-model.js")
const { completedViewModel } = __req("src/client/ui-model.js")
const { LiveUiState, initialLiveUi, reduceLiveUi } = __req("src/client/live/live-state.js")

const HIDDEN_STATES = new Set([LiveUiState.INACTIVE, LiveUiState.SETTLED])

class LivePresenter {
  /** @param {object} [machine] initial machine state (per session instance) */
  constructor(machine = initialLiveUi()) {
    this.machine = machine
  }

  /** Apply one normalized event to the state machine; returns the event count. */
  apply(event) {
    this.machine = reduceLiveUi(this.machine, event)
    return this.machine
  }

  /**
   * Project the current presentation model.
   *
   * Precedence is frozen: an open turn always wins over a settled one, so a new
   * `turn/start` removes the previous card in the same state advance that opens
   * the new turn.
   *
   * @param {object|null} snapshot `LiveMeter.snapshot(nowMs)` output
   * @param {number} nowMs presentation instant (wall clock)
   * @param {object|null} [settled] this session's latest settled snapshot
   */
  project(snapshot, nowMs, settled = null) {
    const machine = this.machine

    /**
     * Completed branch. It is reached from `settled`, never from the meter: the
     * card is a static projection of the settled turn record, and the settled
     * *machine* (not merely a settled meter) is what proves the turn this session
     * most recently observed has ended. A session whose machine is still
     * `inactive` has no card to show.
     */
    if (machine.state === LiveUiState.SETTLED) {
      return completedViewModel(settled) ?? hidden(machine)
    }

    if (HIDDEN_STATES.has(machine.state)) return hidden(machine)
    if (!snapshot || snapshot.phase === 'idle' || snapshot.phase === 'settled') return hidden(machine)

    const turn = machine.turn ?? snapshot.turn ?? null
    /**
     * `null` when the turn start was not observed (mid-turn attach): the pill
     * then omits the elapsed run instead of printing `0 s`. Never a stale or
     * fabricated number.
     */
    const elapsedMs = Number.isFinite(snapshot.turnElapsedMs) ? snapshot.turnElapsedMs : null

    // Tool stage: both the machine's activity counter and the meter's phase
    // are accepted as evidence, so a missed event cannot show a stale TPS.
    const tooling = machine.state === LiveUiState.TOOL_RUNNING || snapshot.phase === 'tool'
    if (tooling) {
      if (snapshot.phase === 'tool') {
        return {
          kind: 'tool',
          state: LiveUiState.TOOL_RUNNING,
          turn,
          count: snapshot.runningToolCount ?? 0,
          names: snapshot.runningToolNames ?? [],
          toolElapsedMs: snapshot.toolElapsedMs ?? 0,
          elapsedMs,
        }
      }
      // The machine believes tools run but the meter does not: inconsistent
      // evidence. The neutral transition view is the only honest rendering.
      return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
    }

    switch (machine.state) {
      case LiveUiState.PENDING_FIRST_TOKEN: {
        if (snapshot.ttftMs === null) {
          return { kind: 'ttft', state: machine.state, turn, counterMs: elapsedMs, elapsedMs }
        }
        // The meter already froze the turn TTFT; the machine lagged a delta.
        return { kind: 'waiting', state: LiveUiState.WAITING_MODEL, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
      }

      case LiveUiState.STREAMING_REASONING:
      case LiveUiState.STREAMING_OUTPUT: {
        const phase = machine.state === LiveUiState.STREAMING_REASONING ? 'reasoning' : 'output'
        if (snapshot.phase === 'streaming' && Number.isFinite(snapshot.tps)) {
          const quality = snapshot.tpsQuality ?? MetricQuality.ESTIMATED
          return {
            kind: 'streaming',
            state: machine.state,
            turn,
            phase,
            tps: snapshot.tps,
            quality,
            /** Live TPS is estimated unconditionally; `≈` is mandatory. */
            approximate: requiresApproximateMarker(quality),
            elapsedMs,
          }
        }
        // Streaming state without streaming evidence: never render the last
        // TPS as if it were current.
        return { kind: 'transition', state: LiveUiState.TRANSITION, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }
      }

      case LiveUiState.WAITING_MODEL:
        return { kind: 'waiting', state: machine.state, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }

      case LiveUiState.TRANSITION:
        return { kind: 'transition', state: machine.state, turn, elapsedMs, waitMs: stageWait(machine, nowMs) }

      default:
        return hidden(machine)
    }
  }
}

function hidden(machine) {
  return { kind: 'hidden', state: machine.state, turn: machine.turn }
}

function stageWait(machine, nowMs) {
  if (!Number.isFinite(machine.sinceMs) || !Number.isFinite(nowMs)) return 0
  return Math.max(0, nowMs - machine.sinceMs)
}

;Object.assign(__exports, { LivePresenter })
			},
			"src/client/live/cadence.js": function (__exports) {
/**
 * The live presentation cadence — the single source of truth.
 *
 * Before this module the same conceptual number existed in three places: the
 * controller's own default, the scheduler's own default and the value the meter
 * root handed the scheduler. Three defaults for one contract drift apart, and a
 * cadence that drifts is a cadence nobody measured. Everything that needs the
 * number now imports it from here.
 *
 * What this number is **not**:
 *
 *   - it is not the data-ingestion rate. Every model delta enters the store;
 *     the cadence bounds *presentation* only (`docs/METRICS_SPEC.md` §6);
 *   - it is not the rolling TPS window. That is a one-second trailing window
 *     (`src/core/sliding-window.js`) and it is deliberately independent: a
 *     faster screen refresh must not shorten the interval a rate is measured
 *     over;
 *   - it is not the completed curve's sampling cadence. That is
 *     `DEFAULT_SAMPLE_EVERY_MS` in `src/core/curve.js`, and the two are
 *     different concepts that happen to be expressed in milliseconds.
 *
 * `PRESENTATION_REFRESH_CANDIDATES_MS` records the three cadences that were
 * actually measured in a browser (Phase 5A A/B). The selection rationale is in
 * `docs/IMPLEMENTATION_LOG.md`; the constant below is the winner.
 */

/**
 * Selected production cadence: 50 ms (20 presentation updates per second).
 *
 * Chosen from measured evidence rather than from the assumption that a higher
 * number is smoother — see the Phase 5A table in `docs/IMPLEMENTATION_LOG.md`.
 * 200 ms (the previous default) is retained only as a reference point.
 */
const DEFAULT_PRESENTATION_REFRESH_MS = 50

/** The cadences the Phase 5A browser A/B actually ran, slowest first. */
const PRESENTATION_REFRESH_CANDIDATES_MS = Object.freeze([200, 50, 10])

/**
 * Debug-only override key. Read exclusively while the diagnostic switch is on,
 * so the production cadence cannot be changed by anything a user can leave
 * behind in local storage.
 */
const REFRESH_OVERRIDE_STORAGE_KEY = 'dsh-turn-performance-meter.refreshMs'

/**
 * Coerce a stored override into a usable cadence.
 *
 * Anything that is not a finite positive number — absent key, empty string,
 * `NaN`, a negative interval — resolves to the selected production cadence
 * rather than to a broken `setInterval`, because a scheduler constructed with
 * `intervalMs <= 0` throws and would take the whole meter down with it.
 *
 * @param {unknown} candidate raw value (typically a local-storage string)
 * @returns {number} a finite interval in milliseconds
 */
function resolvePresentationRefreshMs(candidate) {
  const value = Number(candidate)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRESENTATION_REFRESH_MS
}

;Object.assign(__exports, { DEFAULT_PRESENTATION_REFRESH_MS, PRESENTATION_REFRESH_CANDIDATES_MS, REFRESH_OVERRIDE_STORAGE_KEY, resolvePresentationRefreshMs })
			},
			"src/client/live/controller.js": function (__exports) {
/**
 * Client presentation controller: the runtime wire between the DSH event
 * window, the telemetry store and the per-session live UI machines.
 *
 * Data flow (frozen architecture):
 *
 *   ctx.sessions.binding(id).eventSource   (SessionEventWindow, both planes)
 *       -> SessionEventFeed                (src/dsh: window wire -> normalized)
 *       -> TurnTelemetryStore + LivePresenter (per session, keyed state)
 *       -> React LiveMeter                 (throttled presentation only)
 *
 * Invariants this class exists to keep:
 *
 *   1. **Session/turn isolation.** One presenter (and therefore one UI state
 *      machine) per session; the store is keyed by `(sessionId, turn)`. There
 *      is no global "current turn" anywhere.
 *   2. **One subscription per session.** `attach` is idempotent; switching
 *      sessions back and forth can never double-subscribe an eventSource.
 *   3. **No statistics here.** The controller routes events; TPS, TTFT, tool
 *      wall time and elapsed come from `LiveMeter` snapshots.
 *   4. **Bounded lifecycle.** `dispose()` unsubscribes every eventSource and
 *      disposes the store — the HMR path.
 */

const { TurnTelemetryStore } = __req("src/host/telemetry-design.js")
const { turnKey } = __req("src/core/types.js")
const { NORMALIZED_KIND, applyRetryOutcomes, attemptFromDecoded } = __req("src/dsh/index.js")
const { SessionEventFeed } = __req("src/dsh/client-feed.js")
const { LivePresenter } = __req("src/client/live/live-presenter.js")
const { DEFAULT_PRESENTATION_REFRESH_MS } = __req("src/client/live/cadence.js")

/**
 * Identity of a projected view: equal keys mean the picture is unchanged.
 *
 * The point of the key is the completed card. A settled turn's projection depends
 * on nothing that ticks, so its key is constant and the card is built exactly once
 * per settled turn even though events keep arriving. Every live field that can
 * change the rendering is enumerated, and anything not enumerated (per-delta
 * counters, sample arrays) deliberately cannot change a live value on its own —
 * the live view is a one-second window plus a wall clock, both of which are in
 * the key.
 */
function projectionKey(state, snapshot, atMs) {
  const machine = state.presenter.machine
  const phase = snapshot?.phase ?? 'none'
  if (machine.state === 'settled') return `settled:${machine.turn ?? ''}`
  const clock = Number.isFinite(atMs) ? atMs : 0
  /**
   * `turnElapsedMs` is in the key because every live view prints a running
   * elapsed value; a settled view prints none, which is why its key omits the
   * clock entirely and stays stable while deltas keep arriving.
   */
  return [
    machine.state,
    machine.turn ?? '',
    phase,
    Number.isFinite(snapshot?.turnElapsedMs) ? snapshot.turnElapsedMs : '',
    phase === 'streaming' ? Math.round(snapshot.tps ?? 0) : '',
    phase === 'tool' ? snapshot.runningToolCount ?? 0 : '',
    phase === 'tool' ? Math.round(snapshot.toolElapsedMs ?? 0) : '',
    machine.sinceMs ?? '',
    clock,
  ].join('|')
}

/**
 * @param {{
 *   sessions?: {binding?: (id: string) => {eventSource: object}|undefined},
 *   refreshMs?: number,
 *   debug?: boolean,
 *   nowMs?: () => number,
 * }} [options]
 */
function createController({
  sessions,
  refreshMs = DEFAULT_PRESENTATION_REFRESH_MS,
  debug = false,
  nowMs = () => Date.now(),
} = {}) {
  const store = new TurnTelemetryStore()
  /** @type {Map<string, object>} sessionId -> session state */
  const sessionsMap = new Map()
  const listeners = new Set()
  let disposed = false

  const log = debug
    ? (...args) => { try { console.debug('[dsh-turn-performance-meter]', ...args) } catch { /* never break telemetry for a log */ } }
    : () => {}

  function emit() {
    if (disposed) return
    for (const listener of [...listeners]) {
      try { listener() } catch { /* a broken listener must not stop ingestion */ }
    }
  }

  /** Resolve the turn record an event belongs to; `null` when none exists. */
  function lookupRecord(state, turn) {
    if (Number.isFinite(turn)) return store.turns.get(turnKey(state.sessionId, turn)) ?? null
    return state.currentRecord
  }

  /** Drop whatever the last projection cached, including its settled-turn read. */
  function invalidate(state) {
    state.viewCache = undefined
    state.settledRead = undefined
  }

  function applyEvent(state, event) {
    const sessionId = state.sessionId
    switch (event.kind) {
      case 'window-rebaseline': {
        // A `replace` swapped the window (reload/reconnect). Local live state
        // belongs to the superseded window; replay begins from a clean machine
        // rather than fabricating continuity.
        //
        // The store is reset **first**, and it is the step that matters. The
        // presenter machine and the two identifiers below are presentation state;
        // the evidence is `store.turns` (attempts, samples, usage, tool intervals)
        // and the per-session `LiveMeter`, and both outlive a presenter reset.
        // Leaving them in place makes the replay land inside attempts the
        // superseded generation already filled — `beginTurn` is idempotent and
        // `beginAttempt` returns the existing attempt — so a replayed delta is
        // appended rather than replacing, and the turn reports one sample per
        // republication of the window.
        //
        // The reset is scoped to this session: a rebaseline of one conversation is
        // not evidence about any other.
        log('stream gap/rebaseline', sessionId)
        store.rebaselineSession(sessionId)
        state.presenter.apply({ type: 'reset' })
        state.currentRecord = null
        state.openAttemptId = null
        invalidate(state)
        return
      }

      case NORMALIZED_KIND.TURN_START: {
        /**
         * `recovered` marks a boundary the feed *derived* from transient
         * evidence (mid-turn attach) rather than observed as a durable event.
         * The record is opened with an unknown start time (`timeMs: null`), so
         * TTFT and turn elapsed stay unknown instead of being measured from the
         * reload.
         */
        const recovered = event.recovered === true
        state.currentRecord = store.beginTurn({
          sessionId,
          turn: event.turn,
          timeMs: recovered ? null : event.timeMs,
        })
        /**
         * The durable `turn/start` can arrive **after** the turn was adopted: the
         * window is a live tail, so a reconnect (or the tail sliding back over
         * the row) publishes it mid-turn. It is then an upgrade of an unknown
         * start to the observed one, never a restart of the metrics — the
         * attempt boundaries, deltas and first-token stamp already collected for
         * this turn are kept. The inverse is impossible by construction: only a
         * `recovered` event carries `timeMs: null`, and such an event is emitted
         * exactly once per turn, when the turn is first adopted.
         */
        store.turnStartObserved(state.currentRecord, { timeMs: event.timeMs })
        state.presenter.apply({ type: 'turn-start', turn: event.turn, timeMs: event.timeMs, recovered })
        /** A new turn supersedes the previous card in this same advance. */
        state.settledRead = undefined
        log(recovered ? 'turn adopted (mid-turn attach)' : 'turn open', sessionId, event.turn)
        return
      }

      case NORMALIZED_KIND.STEP_START: {
        state.presenter.apply({ type: 'step-start', turn: event.turn, step: event.step, timeMs: event.timeMs })
        return
      }

      case NORMALIZED_KIND.STEP_END:
        return

      case NORMALIZED_KIND.ATTEMPT_START: {
        const record = lookupRecord(state, event.turn)
        if (record !== null) {
          store.beginAttempt(record, { attemptId: event.attemptId, step: event.step, startedAtMs: event.timeMs })
        }
        state.openAttemptId = event.attemptId
        state.presenter.apply({
          type: 'attempt-start',
          attemptId: event.attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('attempt start', sessionId, event.attemptId)
        return
      }

      case NORMALIZED_KIND.ATTEMPT_DELTA: {
        const record = lookupRecord(state, event.turn)
        if (record === null) {
          // No turn boundary has been observed (a window that no longer
          // contains this turn's `turn/start`). Fabricating a start time would
          // corrupt TTFT, so the delta is reported and dropped instead.
          state.droppedDeltas = (state.droppedDeltas ?? 0) + 1
          return
        }
        let attempt = record.attemptIndex.get(event.attemptId)
        if (attempt === undefined) {
          // The feed always emits `attempt-start` before an attempt's first
          // delta; this is the defensive path for a mid-turn attach.
          attempt = store.beginAttempt(record, {
            attemptId: event.attemptId,
            step: event.step ?? null,
            startedAtMs: event.timeMs,
          })
        }
        const sample = store.acceptChunk(record, attempt, { timeMs: event.timeMs, chunk: event.chunk })
        if (sample === null) return
        // Only model-producing deltas drive the state machine; the machine's
        // first accepted delta is what freezes the turn TTFT stage.
        state.presenter.apply({
          type: 'delta',
          attemptId: event.attemptId,
          turn: record.turn,
          phase: sample.phase,
          timeMs: sample.timeMs,
        })
        return
      }

      case NORMALIZED_KIND.ATTEMPT_SETTLE: {
        const record = lookupRecord(state, event.turn)
        let attemptId = event.attemptId ?? state.openAttemptId
        /**
         * A durable settlement arriving as a plain event carries no `attemptId`,
         * so it is correlated to the one attempt of its `(turn, step)` that has
         * not settled yet. The correlation demands a *unique* candidate: if two
         * unsettled attempts share the step, the settlement belongs to neither
         * provably, and the durable record is restored as its own attempt instead
         * of being attached to a guess.
         */
        if ((attemptId === null || attemptId === undefined) && record !== null && Number.isFinite(event.step)) {
          const open = record.attempts.filter(candidate => (
            candidate.settlementKind === 'none' && candidate.step === event.step
          ))
          if (open.length === 1) attemptId = open[0].attemptId
        }
        if (record !== null && attemptId !== null && attemptId !== undefined) {
          const attempt = record.attemptIndex.get(attemptId)
          if (attempt !== undefined) {
            store.settleAttempt(attempt, {
              settledAtMs: event.timeMs,
              settlementKind: event.settlementKind,
              surfaceCommitted: event.surfaceCommitted,
              attemptOutcome: event.attemptOutcome,
              usage: event.usage ?? null,
              usageSource: event.usageSource ?? null,
              settlementSeq: event.seq,
            })
          }
        } else if (record !== null && event.decoded !== undefined) {
          /**
           * Durable-only settlement: the window carries the settlement (and its
           * embedded compact stream), but the attempt's transient rows are gone —
           * the reload case. The durable record is the complete evidence for that
           * attempt, so it is restored from the decode rather than dropped: a
           * refresh must be able to show the last completed turn without ever
           * having observed it live. Nothing is invented here — the attempt's
           * samples, usage and settlement metadata all come from the durable row.
           */
          const restored = attemptFromDecoded({
            attemptId: `durable:${event.seq ?? record.attempts.length}`,
            turn: record.turn,
            step: event.step ?? null,
            decoded: event.decoded,
            usage: event.usage ?? null,
            usageSource: event.usageSource ?? null,
            settlementKind: event.settlementKind,
            surfaceCommitted: event.surfaceCommitted,
            attemptOutcome: event.attemptOutcome,
            settledAtMs: event.timeMs,
            settlementSeq: event.seq,
            settlementEventType: event.eventType ?? null,
            interrupted: event.interrupted === true,
            issues: event.issues ?? [],
          })
          record.attempts.push(restored)
          record.attemptIndex.set(restored.attemptId, restored)
          /**
           * The turn TTFT is `turn/start -> first non-empty model-producing
           * delta`, and a restored attempt brings that delta with it. Taking the
           * earliest sample timestamp here is what lets a card rebuilt after a
           * reload report the same TTFT the live session froze, instead of `—`.
           */
          for (const sample of restored.samples) {
            if (!Number.isFinite(sample.timeMs)) continue
            record.firstTokenMs = record.firstTokenMs === null
              ? sample.timeMs
              : Math.min(record.firstTokenMs, sample.timeMs)
          }
          state.durableAttempts = (state.durableAttempts ?? 0) + 1
          log('durable attempt restored', sessionId, restored.attemptId, restored.samples.length)
        }
        if (state.openAttemptId === attemptId) state.openAttemptId = null
        state.presenter.apply({
          type: 'attempt-settle',
          attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('attempt settle', sessionId, attemptId, event.settlementKind, event.attemptOutcome)
        return
      }

      case NORMALIZED_KIND.ATTEMPT_ABANDON: {
        const record = lookupRecord(state, event.turn)
        const attemptId = event.attemptId ?? state.openAttemptId
        if (record !== null && attemptId !== null && attemptId !== undefined) {
          const attempt = record.attemptIndex.get(attemptId)
          if (attempt !== undefined) {
            store.settleAttempt(attempt, {
              settledAtMs: event.timeMs ?? null,
              settlementKind: event.settlementKind ?? 'none',
              surfaceCommitted: false,
              attemptOutcome: event.attemptOutcome ?? 'abandoned',
            })
          }
        }
        if (state.openAttemptId === attemptId) state.openAttemptId = null
        state.presenter.apply({
          type: 'attempt-abandon',
          attemptId,
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs ?? null,
        })
        log('attempt abandoned', sessionId, attemptId)
        return
      }

      case NORMALIZED_KIND.RETRY_SCHEDULED: {
        const record = lookupRecord(state, event.turn)
        if (record !== null) applyRetryOutcomes(record.attempts, [event])
        state.presenter.apply({
          type: 'retry',
          turn: record !== null ? record.turn : event.turn,
          timeMs: event.timeMs,
        })
        log('retry scheduled', sessionId, event.turn, event.step)
        return
      }

      case NORMALIZED_KIND.TOOL_CALL: {
        const record = lookupRecord(state, event.turn)
        if (record === null) return
        store.toolStarted(record, { callId: event.callId, name: event.name, timeMs: event.timeMs })
        state.presenter.apply({ type: 'tool-start', turn: record.turn, timeMs: event.timeMs, name: event.name })
        log('tool start', sessionId, event.name)
        return
      }

      case NORMALIZED_KIND.TOOL_RESULT: {
        const record = lookupRecord(state, event.turn)
        if (record === null) return
        const call = store.toolSettled(record, {
          callId: event.callId,
          timeMs: event.timeMs,
          status: event.status,
        })
        if (call === null) {
          state.unmatchedToolResults = (state.unmatchedToolResults ?? 0) + 1
          return
        }
        state.presenter.apply({ type: 'tool-end', turn: record.turn, timeMs: event.timeMs })
        log('tool end', sessionId, call.name, event.status)
        return
      }

      case NORMALIZED_KIND.TURN_END: {
        const record = lookupRecord(state, event.turn)
        if (record === null) return
        const settled = store.endTurn(record, { timeMs: event.timeMs, status: event.status, statusNote: event.note })
        state.currentRecord = null
        state.openAttemptId = null
        state.presenter.apply({ type: 'turn-end', turn: event.turn, timeMs: event.timeMs, status: event.status })
        /**
         * The settled turn is now readable. Both the settled snapshot and the
         * settled machine are in place before the projection is invalidated, so
         * the very next `project()` returns the completed card — never `null`
         * followed by a card one tick later.
         */
        invalidate(state)
        log('turn close', sessionId, event.turn, event.status)
        if (Array.isArray(settled?.consistencyIssues) && settled.consistencyIssues.length > 0) {
          log('quality downgrade', ...settled.consistencyIssues)
        }
        return
      }

      case NORMALIZED_KIND.IGNORED:
        state.ignoredEvents = (state.ignoredEvents ?? 0) + 1
        return

      default:
        state.unknownEvents = (state.unknownEvents ?? 0) + 1
    }
  }

  return {
    refreshMs,
    store,

    /**
     * Subscribe one session's eventSource exactly once. Returns `true` when a
     * subscription now exists for this session (fresh or already attached).
     */
    attach(sessionId) {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') return false
      if (sessionsMap.has(sessionId)) return true
      const binding = typeof sessions?.binding === 'function' ? sessions.binding(sessionId) : undefined
      if (binding === undefined || binding === null || binding.eventSource === undefined || binding.eventSource === null) {
        log('binding unavailable', sessionId)
        return false
      }
      const source = binding.eventSource
      const state = {
        sessionId,
        presenter: new LivePresenter(),
        feed: null,
        unsub: null,
        currentRecord: null,
        openAttemptId: null,
        ignoredEvents: 0,
        droppedDeltas: 0,
        unmatchedToolResults: 0,
        unknownEvents: 0,
      }
      state.feed = new SessionEventFeed({
        sessionId,
        onEvent: event => {
          applyEvent(state, event)
          // Every handled event invalidates presentation. The listener is the
          // scheduler's coalescing notify, so this stays cheap even at one
          // call per streamed delta (no render happens here — the scheduler
          // throttles, and the visible ticker already covers updates).
          emit()
        },
        onIssue: issue => {
          state.feedIssues = state.feedIssues ?? []
          if (state.feedIssues.length < 100) state.feedIssues.push(issue)
          log('feed issue', sessionId, issue.kind, issue.detail)
        },
      })
      const read = () => {
        try {
          state.feed.applyWindow(source.getSnapshot())
        } catch (error) {
          log('event window read failed', sessionId, error)
        }
      }
      // Subscribe first, then the initial full pass: a mutation racing the
      // attach is delivered by the subscription and the revision guard makes
      // the overlapping read idempotent.
      state.unsub = source.subscribe(read)
      read()
      sessionsMap.set(sessionId, state)
      log('session attach', sessionId)
      return true
    },

    /** Detach presentation interest; the subscription itself stays (see docs). */
    detach(sessionId) {
      log('session detach', sessionId)
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * The current presentation model for one session.
     *
     * Precedence, frozen in Phase 4: an open turn wins over a settled one. The
     * completed card and the live meter are never both available, so the switch
     * is a single state advance:
     *
     *   - a settled machine projects the latest settled turn (the card);
     *   - a `turn/end` therefore replaces the pill with the card in the same
     *     publish — there is no intermediate "nothing" frame;
     *   - a following `turn/start` replaces the card with the pill in the same
     *     publish — the old card never lingers beside a new turn.
     *
     * The result is memoized per `(session, projection identity)`: while nothing
     * that can change the picture has changed, the same object is returned, so a
     * static card cannot be rebuilt once per ingested delta. The identity of a
     * completed card is its turn, which is exactly the rule "one card per settled
     * turn".
     */
    project(sessionId, atMs = nowMs()) {
      const state = sessionsMap.get(sessionId)
      if (disposed || typeof sessionId !== 'string' || state === undefined) {
        return { kind: 'hidden', state: 'inactive', turn: null }
      }
      /**
       * The settled turn is read as evidence, once per session state object, in
       * the same synchronous step that reads the meter — which is what makes the
       * live/completed handover atomic rather than a two-tick sequence.
       */
      if (state.settledRead === undefined) state.settledRead = store.latestSettled(sessionId)
      const snapshot = store.liveSnapshot(sessionId, atMs)
      const key = projectionKey(state, snapshot, atMs)
      const cached = state.viewCache
      if (cached !== undefined && cached.key === key && cached.sessionId === sessionId) return cached.view

      const view = state.presenter.project(snapshot, atMs, state.settledRead)
      state.viewCache = { key, sessionId, view }
      return view
    },

    /** Diagnostics for tests and debug tooling. */
    diagnostics(sessionId) {
      const state = sessionsMap.get(sessionId)
      if (state === undefined) return null
      return {
        feedIssues: state.feedIssues ?? [],
        ignoredEvents: state.ignoredEvents ?? 0,
        droppedDeltas: state.droppedDeltas ?? 0,
        unmatchedToolResults: state.unmatchedToolResults ?? 0,
        unknownEvents: state.unknownEvents ?? 0,
      }
    },

    /** Attached session ids, for lifecycle assertions. */
    attachedSessions() {
      return [...sessionsMap.keys()]
    },

    /** Tear down every subscription and all stored state (HMR / unload). */
    dispose() {
      if (disposed) return
      disposed = true
      for (const state of sessionsMap.values()) {
        try { state.unsub?.() } catch { /* best effort */ }
      }
      sessionsMap.clear()
      listeners.clear()
      store.dispose()
      log('controller disposed')
    },
  }
}

;Object.assign(__exports, { createController })
			},
			"src/client/live/refresh.js": function (__exports) {
/**
 * Presentation refresh scheduler.
 *
 * The ingestion path is high-frequency (hundreds to thousands of deltas per
 * attempt — the recorded t5 fixture alone has 1315 transient frames), while
 * React must render at a bounded cadence. The contract:
 *
 *   - while the meter is visible, exactly ONE interval renders, at
 *     `intervalMs` (default `DEFAULT_PRESENTATION_REFRESH_MS` from
 *     `./cadence.js` — the single source for the selected cadence);
 *   - while the meter is hidden, an event schedules at most one coalesced
 *     zero-delay render, so a turn start becomes visible immediately without
 *     per-event rendering;
 *   - `stop()`/`dispose()` clear every timer — unmount, HMR remount and
 *     session switches must never leave an interval behind;
 *   - at no point are there more than two live timers (one interval, one
 *     pending leading render).
 *
 * Deltas are never dropped on the data side: the scheduler throttles
 * *presentation only*. The timer implementations are injectable so tests can
 * assert the structural properties without wall-clock benchmarks.
 */

const { DEFAULT_PRESENTATION_REFRESH_MS } = __req("src/client/live/cadence.js")



/**
 * @param {{
 *   intervalMs?: number,
 *   onRender: () => void,
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout,
 *   setIntervalImpl?: typeof setInterval,
 *   clearIntervalImpl?: typeof clearInterval,
 * }} options
 */
function createPresentationScheduler({
  intervalMs = DEFAULT_PRESENTATION_REFRESH_MS,
  onRender,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  if (typeof onRender !== 'function') throw new TypeError('scheduler requires an onRender callback')
  if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) throw new TypeError('intervalMs must be a finite number > 0')

  let intervalId = null
  let leadId = null
  let disposed = false

  function flushLead() {
    leadId = null
    if (!disposed) onRender()
  }

  return {
    intervalMs,

    /** Whether the periodic presentation ticker is running. */
    get ticking() {
      return intervalId !== null
    },

    /** Whether `dispose()` has permanently disabled this scheduler. */
    get disposed() {
      return disposed
    },

    /** Count of live timers this scheduler owns (0..2), for structural tests. */
    get timerCount() {
      return (intervalId === null ? 0 : 1) + (leadId === null ? 0 : 1)
    },

    /**
     * Data-side notification. While the ticker runs it already covers the
     * update; while hidden, one coalesced zero-delay render is scheduled.
     */
    notify() {
      if (disposed || intervalId !== null) return
      if (leadId === null) leadId = setTimeoutImpl(flushLead, 0)
    },

    /** Begin the bounded periodic refresh (called while the view is visible). */
    start() {
      if (disposed || intervalId !== null) return
      intervalId = setIntervalImpl(onRender, intervalMs)
    },

    /** Stop the ticker (called when the view hides or the component unmounts). */
    stop() {
      if (intervalId !== null) {
        clearIntervalImpl(intervalId)
        intervalId = null
      }
      if (leadId !== null) {
        clearTimeoutImpl(leadId)
        leadId = null
      }
    },

    /** Final cleanup: no timer may survive this call. */
    dispose() {
      disposed = true
      this.stop()
    },
  }
}

;Object.assign(__exports, { DEFAULT_PRESENTATION_REFRESH_MS, createPresentationScheduler })
			},
			"src/client/live/live-format.js": function (__exports) {
/**
 * Live-view formatting.
 *
 * Formatting rules with a correctness dimension:
 *
 *   - a live TPS value always carries `≈`: its quality is `estimated`
 *     unconditionally (METRICS_SPEC §11.5), so a bare number would imply a
 *     provider-exactness that does not exist;
 *   - absent evidence renders as the shared em dash, never as `0`;
 *   - tool names truncate with an ellipsis instead of stretching the pill;
 *   - a multi-tool label always distinguishes itself from a single tool.
 */

const { countdownParts, formatCountdown, formatDuration, formatSeconds, formatTps, DASH } = __req("src/client/format.js")

/**
 * Approximate TPS rendering: `≈338`, `≈38.4`, `—` for absent evidence.
 * Exact values would render bare, but live values are never exact.
 */
function formatApproxTps(value, approximate = true) {
  if (!Number.isFinite(value)) return DASH
  return approximate ? `≈${formatTps(value)}` : formatTps(value)
}

/** Turn elapsed / stage elapsed: `17.3s`, `2m22s` (shared duration rules). */
function formatElapsed(ms) {
  return formatDuration(ms)
}

/** TTFT stopwatch and waiting stopwatch: `2.80 s`. */
function formatStopwatch(ms, digits = 2) {
  return formatCountdown(ms, digits)
}

/**
 * The same stopwatch as separately styleable parts: `2.80` + `s`.
 *
 * The live pill renders the number at the top of its type scale and the unit two
 * steps below it, which is only possible if the two are separate runs.
 */
function stopwatchParts(ms, digits = 2) {
  return countdownParts(ms, digits)
}

/** Long tool names are truncated so the pill never overflows. */
function truncateToolName(name, max = 20) {
  if (typeof name !== 'string' || name.length === 0) return DASH
  if (name.length <= max) return name
  return `${name.slice(0, max - 1)}…`
}

/**
 * Compact tool label:
 *
 *   1 tool   `pwsh`            (long names truncate)
 *   2+ tools `pwsh +1`         (first name plus how many others)
 *   unknown  `×2`
 *
 * The count suffix is locale-independent on purpose: digits stay tabular and
 * the single/multi distinction survives every locale.
 */
function formatToolLabel(names, count) {
  const list = Array.isArray(names) ? names.filter(name => typeof name === 'string' && name.length > 0) : []
  // A count is a number of calls: it is rounded before use so a fractional input
  // can never render as `+1.7000000000000002`.
  const total = Number.isFinite(count) && count > 0 ? Math.round(count) : list.length
  if (total <= 0) return DASH
  if (total === 1) return truncateToolName(list[0] ?? DASH)
  const first = list.length > 0 ? `${truncateToolName(list[0])} ` : ''
  return `${first}+${total - 1}`
}



;Object.assign(__exports, { DASH, formatTps, formatApproxTps, formatElapsed, formatStopwatch, stopwatchParts, truncateToolName, formatToolLabel })
			},
			"src/client/live/LiveMeter.js": function (__exports) {
/**
 * Live meter pill (browser only — this module imports `react`, so Node tests must
 * not import it directly; `test/client-bundle.test.js` loads it through the built
 * bundle with a stubbed module table).
 *
 * Rendering contract:
 *
 *   - the component receives a finished view model from `LivePresenter` and
 *     formats strings; it never parses events, never computes TPS/TTFT/tool
 *     time, and never touches raw `SessionEvent` shapes;
 *   - presentation lifecycle — the single presentation ticker, the session
 *     subscription and the reference-counted style tag — belongs to
 *     `MeterRoot.js`, which chooses between this pill and the completed card;
 *   - **one dominant number per state.** Every branch renders its own value
 *     through `.dsh-tpm-number` (the `1.7 x` step of the plugin's type scale) and
 *     keeps labels, units and elapsed readings strictly below it. Reference:
 *     `docs/assets/reference-live-streaming.png`, where the rate is the focus and
 *     the elapsed reading is visibly subordinate;
 *   - high-frequency numbers are plain text: NO `aria-live` region, so a screen
 *     reader is never read a new TPS twenty times a second. The root carries a
 *     per-state `aria-label` and `data-state` instead.
 */

const { createElement: h } = __ext("react")
const { formatApproxTps, formatElapsed, formatToolLabel, stopwatchParts } = __req("src/client/live/live-format.js")

/**
 * Debug counters (always cheap increments; read only via the debug handle).
 * They exist because the browser is the only place where the full chain
 * controller-notify -> scheduler -> setView -> DOM can be observed together.
 */
const diagnostics = {
  schedulerCreated: 0,
  notifyCalls: 0,
  renderCalls: 0,
  refreshCalls: 0,
  currentScheduler: null,
}

function meterDiagnostics() {
  return diagnostics
}

/** Accessibility name per presentation state — transitions, not digits. */
function stateLabelKey(view) {
  switch (view.kind) {
    case 'ttft': return 'ttft'
    case 'streaming': return view.phase === 'reasoning' ? 'thinking' : 'output'
    case 'tool': return 'tool'
    case 'waiting': return 'waiting'
    case 'transition': return 'transition'
    default: return 'meterLabel'
  }
}

/** A value and its unit as one non-wrapping run: `2.80` `s`, `≈338` `tokens/s`. */
function metric(value, unit, { tone = 'primary', className = 'dsh-tpm-number' } = {}) {
  return h('span', { className: 'dsh-tpm-metric' }, [
    h('span', { key: 'v', className, 'data-tone': tone }, value),
    unit === null ? null : h('span', { key: 'u', className: 'dsh-tpm-unit' }, unit),
  ])
}

/**
 * Separator plus turn-elapsed run, or nothing.
 *
 * The turn elapsed is `null` when the turn start was not observed (a page that
 * attached mid-turn adopts the open turn without its `turn/start`); rendering
 * `0 s` there would be a fabricated number, so the run is omitted entirely.
 */
function elapsedRun(view) {
  if (!Number.isFinite(view.elapsedMs)) return []
  return [
    h('span', { key: 's', className: 'dsh-tpm-sep' }),
    h('span', { key: 'e', className: 'dsh-tpm-elapsed' }, formatElapsed(view.elapsedMs)),
  ]
}

function pillContent(view, label) {
  switch (view.kind) {
    case 'ttft': {
      /**
       * The running first-response counter is the state's only number, so it is
       * the state's focus: `2.80 S` beside the state label.
       */
      const parts = stopwatchParts(view.counterMs ?? 0)
      return [
        metric(parts.value, parts.unit),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
      ]
    }

    case 'streaming':
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        metric(formatApproxTps(view.tps, view.approximate), 'tokens/s', { tone: 'accent' }),
        ...elapsedRun(view),
      ]

    case 'tool':
      return [
        h('span', { key: 'n', className: 'dsh-tpm-tool' }, formatToolLabel(view.names, view.count)),
        h('span', { key: 'g', className: 'dsh-tpm-stage' }, `· ${formatElapsed(view.toolElapsedMs ?? 0)}`),
        ...elapsedRun(view),
      ]

    case 'waiting': {
      const parts = stopwatchParts(view.waitMs ?? 0)
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        metric(parts.value, parts.unit),
        ...elapsedRun(view),
      ]
    }

    case 'transition':
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, `${label}…`),
        ...elapsedRun(view),
      ]

    default:
      return null
  }
}

/**
 * The live pill for one projected view.
 *
 * @param {{view: object, translate: (key: string) => string}} props
 */
function LivePill({ view, translate }) {
  const t = typeof translate === 'function' ? translate : (key => key)
  const label = t(stateLabelKey(view))
  const ariaLabel = Number.isFinite(view.elapsedMs)
    ? `${label} · ${formatElapsed(view.elapsedMs)}`
    : label
  return h('div', {
    className: 'dsh-tpm-root',
    'data-kind': 'live',
    'data-state': view.state,
    'data-turn': view.turn ?? '',
    'aria-label': ariaLabel,
  }, h('div', { className: 'dsh-tpm-pill' }, pillContent(view, label)))
}

;Object.assign(__exports, { meterDiagnostics, LivePill })
			},
			"src/client/completed/metric-cell.js": function (__exports) {
/**
 * One principal metric column — pure, React-free, and shared.
 *
 * Extracted from the card shell so the summary grid and the curve panel render
 * columns through the **same** function. The curve view keeps two of the four
 * columns, and "the same cell, built the same way" is what makes that statement
 * literally true rather than visually similar.
 */

/** Visible secondary text for one column, resolved from locale keys. */
function secondaryText(secondary, translate) {
  if (secondary === null || secondary === undefined) return null
  if (secondary.kind === 'phase') return secondary.text
  if (secondary.kind === 'elapsed') return `${translate(secondary.labelKey)} ${secondary.display}`
  if (secondary.kind === 'status') {
    /** `statusKey` already names the locale key (`status.completed`). */
    const status = translate(secondary.statusKey)
    return secondary.detail === null || secondary.detail === undefined ? status : `${status} · ${secondary.detail}`
  }
  return null
}

/**
 * One principal column.
 *
 * The accessible name is built from the visible label, value and secondary line,
 * so the four numbers are never announced as four unlabelled figures. The visible
 * text stays exactly the design; the fuller phrase lives in the accessible name,
 * which is also why the card needs no `title` attribute or tooltip.
 */
function metricCellTree(createElement, { cell, translate }) {
  const label = translate(cell.labelKey)
  const unit = cell.unit
  const secondary = secondaryText(cell.secondary, translate)
  const ariaLabel = [
    label,
    cell.available ? `${cell.display}${unit === null ? '' : ` ${unit}`}` : translate('unavailable'),
    secondary,
  ].filter(part => part !== null && part !== undefined && part !== '').join(', ')

  return createElement('div', {
    className: 'dsh-tpm-cell',
    'data-metric': cell.key,
    'data-quality': cell.quality,
    'data-approximate': cell.approximate ? 'true' : 'false',
    role: 'group',
    'aria-label': ariaLabel,
  }, [
    createElement('div', { key: 'label', className: 'dsh-tpm-cell-label' }, label),
    createElement('div', { key: 'value', className: 'dsh-tpm-cell-value' }, [
      createElement('span', { key: 'number', className: 'dsh-tpm-cell-number' }, cell.display),
      unit === null ? null : createElement('span', { key: 'unit', className: 'dsh-tpm-cell-unit' }, unit),
    ]),
    secondary === null
      ? null
      : createElement('div', {
        key: 'sub',
        className: 'dsh-tpm-cell-sub',
        'data-tone': cell.secondary.tone ?? 'neutral',
      }, secondary),
  ])
}

;Object.assign(__exports, { secondaryText, metricCellTree })
			},
			"src/client/completed/curve-tree.js": function (__exports) {
/**
 * Curve-panel element tree — pure, React-free.
 *
 * The panel is the alternate view inside the completed card, not a tooltip: it
 * replaces the two TPS columns in the *same* four-column grid, so the
 * generated-token and TTFT columns keep their exact positions and dividers when
 * the card switches. That is a structural choice, not a styling one — the
 * reference puts the curve in the left half and the two surviving metrics on the
 * right, and reusing the grid makes the two views differ by one element instead
 * of by one layout.
 *
 * Geometry decisions (axis ceiling, evidence spans, peak placement) belong to
 * `curve-view-model.js`; this module only turns them into elements. The SVG is
 * `aria-hidden` and the panel carries one textual description instead, so a
 * screen reader is never handed a polyline it cannot read while the accessible
 * summary says the same thing twice.
 */

const { metricCellTree } = __req("src/client/completed/metric-cell.js")

/** Legend order is fixed so the swatches never swap between turns. */
const LEGEND_ORDER = Object.freeze(['reasoning', 'output'])

/** Locale key for one series' legend label. */
function legendKey(key) {
  return key === 'reasoning' ? 'thinking' : 'output'
}

/**
 * Legend row: `思考 [swatch] 输出 [swatch]` on the left, the peak on the right.
 *
 * The swatch follows its label, which is the reference's order, and the label is
 * always present — colour is never the only channel that identifies a series.
 * A phase with no drawable evidence keeps its legend entry and is marked
 * `data-absent`, because removing the entry would silently answer a question the
 * reader is still asking.
 */
function legendTree(createElement, curveView, translate) {
  const items = LEGEND_ORDER.map(key => {
    const series = curveView.series.find(candidate => candidate.key === key)
    const present = series?.present === true
    return createElement('span', {
      key,
      className: 'dsh-tpm-legend-item',
      'data-series': key,
      'data-absent': present ? 'false' : 'true',
    }, [
      createElement('span', { key: 'label', className: 'dsh-tpm-legend-label' }, translate(legendKey(key))),
      createElement('span', { key: 'swatch', className: 'dsh-tpm-legend-swatch', 'aria-hidden': 'true' }),
    ])
  })

  /**
   * The peak is a point of an estimated series, so it carries `≈` even when the
   * turn's token total is exact. The locale supplies the word; the widget never
   * prints a bare number here.
   */
  const peak = createElement('span', {
    className: 'dsh-tpm-peak',
    'data-approximate': curveView.peak.approximate ? 'true' : 'false',
  }, [
    createElement('span', { key: 'label', className: 'dsh-tpm-peak-label' }, translate('peak')),
    createElement('span', { key: 'value', className: 'dsh-tpm-peak-value' }, curveView.peak.display),
    createElement('span', { key: 'unit', className: 'dsh-tpm-peak-unit' }, curveView.peak.unit),
  ])

  return createElement('div', { className: 'dsh-tpm-curve-head' }, [
    createElement('div', { key: 'legend', className: 'dsh-tpm-legend' }, items),
    createElement('div', { key: 'peak', className: 'dsh-tpm-peak-slot' }, peak),
  ])
}

/**
 * Plot area: one path element per drawable **run**, the axis ceiling, and the
 * peak marker.
 *
 * A phase may appear in more than one episode, so the renderer receives a list of
 * runs per series and emits one `<path>` for each. Two runs are two elements, never
 * one element with two subpaths, because the separation is the statement: the
 * curve genuinely stopped and started again, and the reader must see a gap rather
 * than a line drawn through a stretch where nothing was generated. No vertical
 * attempt-boundary marker is added — the break itself is the whole signal, and a
 * divider per attempt would decorate the chart with information the reader did not
 * ask for.
 *
 * `viewBox="0 0 100 48"` with `preserveAspectRatio="none"` and a non-scaling
 * stroke keeps the y scale at one unit per unit at any container width, which is
 * also why the peak marker is an HTML element positioned in percentages rather
 * than an SVG circle: a circle inside a non-uniformly stretched viewBox would
 * render as an ellipse.
 *
 * The marker sits inside `.dsh-tpm-plot-area` and the axis ceiling outside it,
 * because `left`/`top` percentages resolve against the containing block's
 * padding box — sharing that box with the axis label would push every marker off
 * its vertex.
 */
function plotTree(createElement, curveView, translate) {
  const paths = []
  for (const series of curveView.series) {
    for (const [index, run] of series.runs.entries()) {
      if (run.present !== true || typeof run.path !== 'string') continue
      paths.push(createElement('path', {
        /**
         * `attemptId` is retained on the element so a future diagnostic can point
         * at one call, but it is not rendered as anything.
         */
        key: `${series.key}:${run.attemptId ?? 'unknown'}:${index}`,
        className: 'dsh-tpm-series',
        'data-series': series.key,
        'data-run': String(index),
        'data-attempt': run.attemptId === null ? '' : String(run.attemptId),
        d: run.path,
        vectorEffect: 'non-scaling-stroke',
      }))
    }
  }

  const svg = createElement('svg', {
    key: 'svg',
    className: 'dsh-tpm-plot-svg',
    viewBox: `0 0 ${curveView.width} ${curveView.height}`,
    preserveAspectRatio: 'none',
    focusable: 'false',
    'aria-hidden': 'true',
  }, paths)

  const area = [svg]

  /**
   * Point markers for one-vertex runs.
   *
   * A run that holds a single measurement cannot be a path, and until Phase 7 it was
   * therefore invisible — including when that measurement was the turn's peak, which
   * left the card printing a peak the chart could not point at. The marker is an HTML
   * element rather than an SVG circle for the same reason the peak dot is: the viewBox
   * is stretched non-uniformly, so a circle drawn inside it would render as an
   * ellipse.
   *
   * It is `aria-hidden`, like the rest of the plot, because the accessible summary of
   * the chart is the panel's `aria-label`; a screen reader gains nothing from a
   * decorative dot. It carries its series in `data-series` and its tone through the
   * same class channel the legend uses, and it does **not** count toward
   * `data-points`: a marker is not a vertex, and inflating the drawn count would make
   * the chart's own bound unmeasurable.
   *
   * `data-peak` is the one visual distinction between two markers. A chart of a long
   * agent turn can hold many ordinary single-measurement stretches, and drawing every
   * one of them at the peak's size made the trace read as a field of peaks; an
   * ordinary marker is small and subdued, and only the measurement the card prints as
   * the peak keeps the stronger marker. The measured instant is the same either way.
   */
  for (const [index, marker] of (Array.isArray(curveView.markers) ? curveView.markers : []).entries()) {
    area.push(createElement('span', {
      key: `singleton:${marker.series}:${marker.attemptId ?? 'unknown'}:${index}`,
      className: 'dsh-tpm-singleton-dot',
      'data-series': marker.series,
      'data-attempt': marker.attemptId === null ? '' : String(marker.attemptId),
      'data-tps': String(marker.tps),
      'data-peak': marker.isPeak === true ? 'true' : 'false',
      'aria-hidden': 'true',
      style: {
        left: `${marker.x}%`,
        top: `${(marker.y / curveView.height) * 100}%`,
      },
    }))
  }

  if (curveView.peak.x !== null && curveView.peak.y !== null) {
    area.push(createElement('span', {
      key: 'dot',
      className: 'dsh-tpm-peak-dot',
      'data-leader': curveView.peak.leader,
      'aria-hidden': 'true',
      style: {
        left: `${curveView.peak.x}%`,
        top: `${(curveView.peak.y / curveView.height) * 100}%`,
      },
    }))
  }
  /**
   * The placeholder appears only when the chart has **nothing at all** to place: no
   * path vertex and no marker. A turn whose only evidence is singleton runs has
   * markers, so it renders them instead of claiming the curve is unavailable —
   * that substitution was the visible half of the singleton defect.
   */
  if (curveView.drawnPoints === 0 && curveView.markers.length === 0) {
    area.push(createElement('span', {
      key: 'empty',
      className: 'dsh-tpm-plot-empty',
    }, translate('curveUnavailable')))
  }

  return createElement('div', {
    className: 'dsh-tpm-plot',
    'data-points': curveView.drawnPoints,
    /**
     * Markers are counted separately from vertices, and published so a test can
     * assert the two are never conflated: `data-points` is what the chart-wide
     * render budget bounds, `data-markers` is decoration layered on top of it.
     */
    'data-markers': curveView.markers.length,
  }, [
    createElement('div', { key: 'area', className: 'dsh-tpm-plot-area' }, area),
    createElement('span', { key: 'axis', className: 'dsh-tpm-axis-max' }, curveView.axis.display),
  ])
}

/**
 * The panel: the legend/peak head, the plot, and the two metric columns the
 * curve view keeps.
 *
 * @param {(tag: string, props: object, children?: unknown) => object} createElement
 * @param {object} curveView `curveViewModel` output
 * @param {readonly object[]} keptColumns the card's trailing metric columns
 * @param {(key: string) => string} translate
 */
function curveTree(createElement, curveView, keptColumns, translate) {
  const t = typeof translate === 'function' ? translate : (key => key)
  return [
    createElement('div', {
      key: 'curve',
      className: 'dsh-tpm-curve-panel',
      role: 'group',
      'aria-label': `${t('curveLabel')} · ${t('peak')} ${curveView.peak.display} ${curveView.peak.unit}`,
    }, [
      legendTree(createElement, curveView, t),
      plotTree(createElement, curveView, t),
    ]),
    ...keptColumns.map(cell => metricCellTree(createElement, { cell, translate: t })),
  ]
}

;Object.assign(__exports, { curveTree })
			},
			"src/client/completed/completed-tree.js": function (__exports) {
/**
 * Completed-card element tree — pure, React-free.
 *
 * The card's structure, its visible strings, its accessible names and the
 * decision to hide an item (a turn with no tool call, a phase with no secondary
 * line) are all decided here. `CompletedMeter.js` is the thin React binding over
 * this module, which keeps the render layer thin and lets the tree be tested in
 * Node with a recording `createElement` rather than a DOM.
 *
 * The card carries **two** views of the same settled turn and shows one at a
 * time: the metric summary (default) and the throughput curve (while hovered or
 * focused). They are stacked in one grid cell rather than swapped, so the card's
 * height is the taller of the two and a switch cannot resize it. The hidden
 * layer is `aria-hidden` and `pointer-events: none`, so assistive technology is
 * never handed two copies of the turn's numbers at once.
 *
 * The tree never computes geometry: the curve panel arrives finished from
 * `curve-view-model.js` and is assembled by `curve-tree.js`.
 */

const { metricCellTree, secondaryText } = __req("src/client/completed/metric-cell.js")
const { curveTree } = __req("src/client/completed/curve-tree.js")



/**
 * Footer items. Tools lead because they are the only footer fact that can be
 * absent: a turn with no tool call hides the tool item entirely rather than
 * printing "0 tools", and the separator is a CSS pseudo-element so the line
 * never starts or ends with a bullet.
 */
function footerTree(createElement, view, translate) {
  const tools = view.tools ?? { count: 0, wallDisplay: '' }
  const items = []
  if (tools.count > 0) items.push(`${translate('tools')} ${tools.count} · ${tools.wallDisplay}`)
  if (view.attemptCount > 0) items.push(`${translate('attempts')} ${view.attemptCount}`)
  items.push(translate(`status.${view.status}`))
  return createElement('div', { key: 'foot', className: 'dsh-tpm-foot' },
    items.map((text, index) => createElement('span', { key: `${index}`, className: 'dsh-tpm-foot-item' }, text)))
}

/**
 * One stacked layer.
 *
 * `data-visible` drives the cross-fade in CSS; `aria-hidden` is the
 * accessibility half of the same decision and is a real attribute rather than a
 * style, so it survives a stylesheet that fails to load.
 */
function viewLayer(createElement, key, visible, children) {
  return createElement('div', {
    key,
    className: 'dsh-tpm-view',
    'data-view': key,
    'data-visible': visible ? 'true' : 'false',
    'aria-hidden': visible ? 'false' : 'true',
  }, createElement('div', { className: 'dsh-tpm-cells' }, children))
}

/**
 * The whole card.
 *
 * @param {(tag: string, props: object, children?: unknown) => object} createElement
 * @param {object} view `completedViewModel` output
 * @param {(key: string) => string} translate
 * @param {{
 *   mode?: 'summary'|'curve',
 *   curveView?: object|null,
 *   onEnter?: Function, onLeave?: Function, onFocus?: Function, onBlur?: Function,
 * }} [interaction] presentation state and handlers owned by `CompletedMeter`
 */
function completedTree(createElement, view, translate, interaction = {}) {
  const t = typeof translate === 'function' ? translate : (key => key)
  const mode = interaction.mode === 'curve' ? 'curve' : 'summary'
  const curveView = interaction.curveView ?? null
  const interactive = curveView !== null
  const statusText = t(`status.${view.status}`)

  const layers = [
    viewLayer(createElement, 'summary', mode === 'summary', view.columns.map(cell => (
      metricCellTree(createElement, { cell, translate: t })
    ))),
  ]
  if (interactive) {
    /**
     * The curve view replaces the first two columns with one panel spanning the
     * same two tracks; the trailing columns are the very same cells the summary
     * renders, at the very same grid positions.
     */
    layers.push(viewLayer(createElement, 'curve', mode === 'curve',
      curveTree(createElement, curveView, view.columns.slice(2), t)))
  }

  const cardProps = {
    className: 'dsh-tpm-card',
    role: 'group',
    'aria-label': `${t('completedLabel')} · ${t('turnLabel')} ${view.turn ?? ''} · ${statusText}`,
  }
  if (interactive) {
    /**
     * Focusability is tied to the alternate view: a card with nothing behind
     * hover must not sit in the tab order, because a focus stop that changes
     * nothing is worse than no stop at all.
     */
    cardProps.tabIndex = 0
    cardProps['aria-description'] = t('curveHint')
    /** Only handlers that were actually supplied become props. */
    for (const [prop, handler] of [
      ['onMouseEnter', interaction.onEnter],
      ['onMouseLeave', interaction.onLeave],
      ['onFocus', interaction.onFocus],
      ['onBlur', interaction.onBlur],
    ]) {
      if (typeof handler === 'function') cardProps[prop] = handler
    }
  }

  return createElement('div', {
    className: 'dsh-tpm-root',
    'data-kind': 'completed',
    'data-status': view.status,
    'data-quality': view.quality?.overall ?? 'unavailable',
    'data-view': mode,
    'data-turn': view.turn ?? '',
    ...(view.sessionId === null || view.sessionId === undefined ? {} : { 'data-session': view.sessionId }),
  }, [
    createElement('div', { key: 'card', ...cardProps }, [
      createElement('div', { key: 'views', className: 'dsh-tpm-views' }, layers),
      footerTree(createElement, view, t),
    ]),
  ])
}

;Object.assign(__exports, { metricCellTree, secondaryText, completedTree })
			},
			"src/client/completed/curve-view-model.js": function (__exports) {
/**
 * Curve view model — the single seam between the settled snapshot and the SVG.
 *
 * The data flow is fixed by the architecture, and this module is the only place
 * it may bend:
 *
 *     settled snapshot (already decoded, aggregated, calibrated, compressed,
 *                       windowed, run-split and downsampled)
 *         -> curveViewModel(settled)          <- this module
 *         -> SVG element tree                 (`curve-tree.js`)
 *
 * The React layer therefore never decodes an event, aggregates a turn, compresses
 * an attempt axis, rolls a TPS window, splits a phase into episodes or downsamples
 * a raw delta — it renders numbers and path strings that were decided here. That
 * matters because those six operations are the statistics; a component that
 * recomputed any of them would be a second, silently divergent definition of TPS.
 *
 * **One measurement per attempt, several tones.** Since Phase 7C the curve is one
 * attempt-local trailing-one-second **total** throughput trace per model attempt,
 * and a phase is a *colour* of that one measurement rather than a rate of its own:
 * `source.curve.attempts[].runs` carries the phase-coloured subruns of each trace.
 * Two subruns that meet at a phase transition share their boundary vertex, so this
 * module emits one `M...L...` path per subrun and never joins two *attempts* —
 * the join between two calls is a fabricated straight line through a tool wait,
 * which is a stretch where nothing was generated.
 *
 * Geometry is expressed in a fixed logical viewBox (`0 0 100 48`) that the SVG
 * stretches to its container with `preserveAspectRatio="none"` and
 * `vector-effect="non-scaling-stroke"`. A chart whose y-scale depended on the
 * container width would make the same turn look like a different turn at a
 * different window size; a fixed viewBox does not.
 */

const { DASH, formatTps, formatTokens } = __req("src/client/format.js")

/** Logical drawing box. Height is chosen so the curve panel matches the summary. */
const CURVE_VIEW_WIDTH = 100
const CURVE_PLOT_HEIGHT = 48

/** Vertical inset reserved so a peak touching the axis maximum is not clipped. */
const PLOT_INSET = 3

/** Axis labels are read as magnitudes, so they never carry the `≈` of a rate. */
function formatAxis(value) {
  if (!Number.isFinite(value) || value <= 0) return DASH
  return formatTokens(value)
}

/**
 * Smallest member of the 1/2/2.5/5 x 10^k ladder that is `>= value`.
 *
 * A raw maximum as the axis ceiling (e.g. `673`) would place the peak exactly on
 * the top gridline with no headroom and produce unreadable axis labels; a ladder
 * ceiling keeps the peak visible and the label round. Deterministic by
 * construction, which is what lets the geometry be snapshot-tested.
 */
function niceCeiling(value) {
  if (!(Number.isFinite(value) && value > 0)) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  for (const step of [1, 2, 2.5, 5]) {
    if (value <= step * base * (1 + 1e-9)) return step * base
  }
  return 10 * base
}

/** x coordinate of one compressed instant, or `null` when it is not drawable. */
function xOf(timeMs, durationMs) {
  if (!Number.isFinite(timeMs)) return null
  if (!(durationMs > 0)) return 0
  return Math.min(CURVE_VIEW_WIDTH, Math.max(0, (timeMs / durationMs) * CURVE_VIEW_WIDTH))
}

/** y coordinate of one rate against the axis ceiling. */
function yOf(tps, axisMax) {
  const usable = CURVE_PLOT_HEIGHT - PLOT_INSET * 2
  const ratio = axisMax > 0 ? Math.min(1, Math.max(0, tps / axisMax)) : 0
  return CURVE_PLOT_HEIGHT - PLOT_INSET - ratio * usable
}

/** Two decimals is well below one device pixel in a `100`-wide stretched viewBox. */
function round(value) {
  return Math.round(value * 100) / 100
}

/**
 * Turn one run's vertices into coordinates and a single-subpath `d` string.
 *
 * A run shorter than two vertices is not drawable **as a line**: one point is a
 * measurement, not a segment. It is reported as `present: false` with its
 * coordinates intact, and — since Phase 7 — with `marker` set, so the renderer can
 * place a point where the measurement actually is.
 *
 * ## Why a marker, and why not a second vertex
 *
 * A run can legitimately hold one vertex: an attempt that produced a single delta has
 * zero width, and an episode whose phase falls silent immediately after one delta has
 * a tail grid with no whole step left inside its bound. That measurement can be the
 * turn's peak, which meant the card printed a peak the chart could not locate —
 * `test/completed-tree.test.js` recorded it as a known mismatch and Phase 7 closed it.
 *
 * The tempting repair is to duplicate the vertex so a line exists. That would be a
 * fabrication: two vertices at one instant draw a segment the data does not contain,
 * and a two-point series would then satisfy `present`, inflating `drawnPoints`,
 * `drawnRuns` and the legend's presence claim. The marker adds no vertex, carries the
 * same tone as its series, is `aria-hidden`, and adds nothing to any statistic.
 */
function buildRun(run, durationMs, axisMax) {
  const coordinates = []
  for (const point of Array.isArray(run?.points) ? run.points : []) {
    if (!Number.isFinite(point?.timeMs) || !Number.isFinite(point?.tps)) continue
    const x = xOf(point.timeMs, durationMs)
    if (x === null) continue
    coordinates.push({
      x,
      y: yOf(point.tps, axisMax),
      tps: point.tps,
      timeMs: point.timeMs,
      attemptId: run.attemptId ?? null,
    })
  }

  if (coordinates.length < 2) {
    const single = coordinates.length === 1 ? coordinates[0] : null
    return {
      attemptId: run?.attemptId ?? null,
      startMs: run?.startMs ?? null,
      endMs: run?.endMs ?? null,
      present: false,
      path: null,
      coordinates,
      points: coordinates.length,
      peak: single,
      /**
       * A point the chart must draw even though it cannot draw a line to it. `null`
       * for an empty run, so a caller can distinguish "one measurement" from
       * "nothing measured" without inspecting `coordinates`.
       */
      marker: single,
      /**
       * Stated explicitly so the HTML layer does not have to infer it: exactly one
       * vertex, drawn as a marker. A longer run never carries this flag, and a
       * refused run (zero vertices) never does either.
       */
      singleton: single !== null,
    }
  }

  /**
   * One `M`, then `L` for every other vertex. This string is deliberately
   * self-contained: joining two runs' strings would produce
   * `M...L... M...L...` — which is two subpaths, so the break would still be
   * correct — but a renderer that instead concatenated their *coordinates* would
   * draw the bridging line this whole structure exists to forbid.
   */
  const path = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`)
    .join(' ')

  let peak = coordinates[0]
  for (const point of coordinates) if (point.tps > peak.tps) peak = point

  return {
    attemptId: run?.attemptId ?? null,
    startMs: run?.startMs ?? null,
    endMs: run?.endMs ?? null,
    present: true,
    path,
    coordinates,
    points: coordinates.length,
    peak,
    /** A drawable run is never a singleton: it has a real segment. */
    marker: null,
    singleton: false,
  }
}

/** One series entry: every run of one phase, each with its own path. */
function buildSeries(entry, durationMs, axisMax) {
  const runs = (Array.isArray(entry?.runs) ? entry.runs : []).map(run => buildRun(run, durationMs, axisMax))
  const drawable = runs.filter(run => run.present)
  /**
   * The peak spans every run, drawable or not. A run of one vertex cannot be drawn
   * as a line, but its measurement is real, and the turn peak is a statistic — a
   * rendering limitation may not lower a published number.
   */
  let peak = null
  for (const run of runs) {
    if (run.peak === null) continue
    if (peak === null || run.peak.tps > peak.tps) peak = run.peak
  }
  return {
    key: entry?.key ?? null,
    tone: entry?.tone ?? null,
    present: drawable.length > 0,
    runs,
    /**
     * One entry per run that holds exactly one vertex. These are drawn as point
     * markers, so a one-vertex run that carries the turn's peak has a position on
     * the chart instead of existing only as a printed number. Kept as its own list
     * rather than folded into `coordinates`, because a marker is not a vertex of a
     * path and must not be counted as one.
     */
    markers: runs.filter(run => run.singleton).map(run => run.marker),
    /** Concatenated vertices of every run, for a caller that wants one array. */
    coordinates: runs.flatMap(run => run.coordinates),
    /**
     * Path vertices only. A singleton run contributes **zero** here rather than one:
     * this count feeds `drawnPoints`, which is what bounds the SVG, and a marker is a
     * separate element with its own count.
     */
    points: runs.filter(run => run.present).reduce((sum, run) => sum + run.points, 0),
    /** The single strongest vertex across this phase's runs, or `null`. */
    peak,
    /**
     * A single path string covering every run, for a caller that cannot render a
     * list. Each run opens its own `M`, so the subpaths are still disjoint even
     * here: this is a convenience, not a licence to join them.
     */
    path: drawable.length === 0 ? null : drawable.map(run => run.path).join(' '),
  }
}

/**
 * Rebuild run structure from a pre-Phase-6 snapshot's flat `reasoning`/`output`
 * arrays.
 *
 * An older snapshot carries no runs, and a phase's evidence is bounded by the
 * intervals `phaseSpans` recorded. A snapshot older still carries neither, and
 * then the whole array is one run — the only honest reading of "no availability
 * metadata". This path exists so a stale snapshot degrades to the old drawing
 * rather than to an empty chart.
 */
function legacyRuns(curve, key) {
  const points = Array.isArray(curve?.[key]) ? curve[key] : []
  if (points.length === 0) return []
  const spans = curve?.phaseSpans
  const span = spans !== null && typeof spans === 'object' ? (spans[key] ?? null) : undefined
  if (span === null) return []
  const filtered = span === undefined
    ? points
    : points.filter(point => Number.isFinite(point?.timeMs) && point.timeMs >= span.startMs && point.timeMs <= span.endMs)
  if (filtered.length === 0) return []
  return [{
    attemptId: null,
    phase: key,
    startMs: filtered[0].timeMs,
    endMs: filtered[filtered.length - 1].timeMs,
    attemptTokens: null,
    points: filtered,
  }]
}

/** The run list of one series, from the modern structure or the legacy one. */
function runsOf(curve, key, legacy) {
  const entry = Array.isArray(curve?.series)
    ? curve.series.find(candidate => candidate?.key === key)
    : undefined
  if (entry !== undefined) return entry
  return { key, tone: key === 'output' ? 'accent' : 'neutral', runs: legacyRuns(curve, key) }
}

/**
 * Every phase-coloured subrun of one curve, in draw order.
 *
 * The per-attempt structure is the geometry; the per-phase `series` is a view of it
 * built for the legend. Reading the geometry from the attempt traces is what keeps
 * "one measurement per attempt, colour-segmented" true no matter how a caller
 * chooses to group the runs.
 */
function runsOfAll(curve) {
  const attempts = Array.isArray(curve?.attempts) ? curve.attempts : null
  if (attempts === null) return null
  const runs = []
  for (const attempt of attempts) {
    for (const run of Array.isArray(attempt?.runs) ? attempt.runs : []) runs.push(run)
  }
  return runs
}

/**
 * Whether the curve's magnitudes were anchored to provider usage.
 *
 * Narrow on purpose: `curve.source.calibrated` is `true` only when **every**
 * contributing attempt was anchored. A partially calibrated curve is not a calibrated
 * curve, and a caller that wants the finer statement reads `calibrationCoverage`.
 */
function calibratedOf(curve) {
  return curve?.source?.calibrated === true
}

/**
 * How much of the curve a provider total anchored: `full`, `partial`, `none` or
 * `fallback` (`src/core/curve-source.js`).
 *
 * It is carried onto the view model rather than printed, because the compact card
 * already shows the peak with its `≈` and the panel shows the quality axes — a third
 * line of provenance would be clutter. A caller that wants to annotate the chart reads
 * it here instead of re-deriving it from the per-attempt flags.
 *
 * A curve with no `source` at all — a pre-Phase-7C snapshot — reports `null` rather
 * than a level it cannot substantiate.
 */
function calibrationCoverageOf(curve) {
  const coverage = curve?.source?.calibrationCoverage
  return typeof coverage === 'string' ? coverage : null
}

/**
 * Build the curve panel's view model.
 *
 * @param {object|null|undefined} settled the settled turn snapshot
 * @returns {object|null} `null` when the turn carries no curve at all, which is
 *   what makes the completed card non-interactive for that turn
 */
function curveViewModel(settled) {
  const curve = settled?.curve
  if (!curve || typeof curve !== 'object') return null

  const durationMs = Number.isFinite(curve.durationMs) ? Math.max(0, curve.durationMs) : 0
  /**
   * The axis is scaled by the **full-series** peak, never by the drawn points:
   * downsampling is a drawing budget and may not rescale the chart either.
   * `downsampleRun` guarantees the peak-bearing point survives, so the drawn
   * curve reaches the top of the axis rather than falling short of it.
   */
  const peakValue = Number.isFinite(curve.peakTps) ? Math.max(0, curve.peakTps) : 0
  const axisMax = niceCeiling(peakValue)

  /**
   * The runs come from the attempt traces when the curve carries them, because those
   * are the geometry: one total trace per model attempt, cut into phase-coloured
   * subruns. The per-phase `series` is only a view — and on a pre-Phase-7C snapshot,
   * which has no `attempts`, it is the whole of the evidence.
   */
  const attemptRuns = runsOfAll(curve)
  const reasoning = buildSeries({
    key: 'reasoning',
    tone: 'neutral',
    runs: attemptRuns === null ? runsOf(curve, 'reasoning').runs : attemptRuns.filter(run => run.phase === 'reasoning'),
  }, durationMs, axisMax)
  const output = buildSeries({
    key: 'output',
    tone: 'accent',
    runs: attemptRuns === null ? runsOf(curve, 'output').runs : attemptRuns.filter(run => run.phase === 'output'),
  }, durationMs, axisMax)

  /**
   * The series holding the global peak, so the marker sits on it. A tie resolves to
   * `reasoning`, because the comparison is strict and `reasoning` is scanned first —
   * the same earliest-wins rule `buildSeries` applies inside a series, which keeps the
   * position stable between two runs over equal input.
   */
  const leader = (output.peak?.tps ?? -1) > (reasoning.peak?.tps ?? -1) ? 'output' : 'reasoning'
  const leaderSeries = leader === 'output' ? output : reasoning
  /**
   * One marker per attempted transition, not one per run.
   *
   * A phase transition whose shared seam is the **only** vertex either side draws
   * produces two singleton runs holding the same vertex, and emitting one marker per
   * run would stack two dots on one measurement and charge it twice against the render
   * budget. Since the seam is shared, both subpaths place the same vertex at the same
   * coordinate, so a measurement is identified by the attempt that produced it plus the
   * instant it sits at — not by position alone, because two zero-width attempts can
   * legitimately share a coordinate, and `test/completed-interaction.test.js` holds that
   * case.
   */
  const singletonByMeasurement = new Map()
  for (const series of [
    { key: 'reasoning', tone: 'neutral', built: reasoning },
    { key: 'output', tone: 'accent', built: output },
  ]) {
    for (const marker of series.built.markers) {
      const key = `${marker.attemptId ?? ''}@${marker.timeMs}`
      if (singletonByMeasurement.has(key)) continue
      singletonByMeasurement.set(key, {
        ...marker,
        x: round(marker.x),
        y: round(marker.y),
        series: series.key,
        tone: series.tone,
      })
    }
  }
  const markers = [...singletonByMeasurement.values()]
  /**
   * The same list, divided by series. It is a **filter of the enriched markers**, not the raw
   * `run.marker` list `buildSeries` collected, so a caller reading `series[].markers` gets the
   * tone and the originating series name each marker was de-duplicated under — and so the two
   * access paths cannot drift into describing the same dot differently.
   */
  const markersOf = key => markers.filter(marker => marker.series === key)
  const drawnPoints = reasoning.points + output.points
  const drawnRuns = reasoning.runs.filter(run => run.present).length
    + output.runs.filter(run => run.present).length
  /**
   * Whether any subpath has positive length. A run of two vertices **at the same
   * instant** — which a single-delta attempt whose successor owns the coordinate can
   * produce — is a real run with no segment, so counting runs would call the chart
   * drawable while nothing is drawn.
   */
  const hasSegment = reasoning.runs.concat(output.runs).some(run => (
    run.present && run.coordinates.length >= 2
    && run.coordinates[run.coordinates.length - 1].x > run.coordinates[0].x
  ))

  /**
   * The marker is placed only when the leading series' strongest **drawn** vertex is the
   * measurement the card prints.
   *
   * `peak.value` is the full-series maximum, measured before any budget is applied,
   * because a drawing limit may not move a reported statistic. The position, by contrast,
   * can only come from a vertex that survived onto the chart. Those two coincide whenever
   * the peak-bearing run is drawn — `allocateRunBudgets` seats it first, whatever its
   * length, and `downsampleRun` keeps its maximum — but they come apart if it is not,
   * and the failure is silent and misleading: the card prints `≈1000` and the dot lands on
   * a 400 tokens/s vertex, one pixel apart, with nothing on screen to distinguish them.
   *
   * Placing nothing is the honest degradation: a missing dot is visibly missing, and it is
   * what `curve.renderBudget.peakRetained` reports in words. Placing a different
   * measurement is not.
   */
  const placedPeak = leaderSeries.peak !== null && Math.abs(leaderSeries.peak.tps - peakValue) < 1e-9
    ? leaderSeries.peak
    : null

  return {
    kind: 'curve',
    durationMs,
    width: CURVE_VIEW_WIDTH,
    height: CURVE_PLOT_HEIGHT,
    axis: { max: axisMax, display: formatAxis(axisMax) },
    /**
     * Both series are always listed, in a fixed order, so the legend never
     * changes shape between turns. `present: false` means the phase produced
     * nothing to draw — an honest "no evidence", not a zero line. `present` says
     * whether the phase has a **drawable segment**, which is what its legend entry
     * claims; a phase whose only evidence is a single measured instant is marked
     * `markersOnly` instead, so the two are never conflated.
     */
    series: [
      { key: 'reasoning', tone: 'neutral', ...reasoning, markers: markersOf('reasoning') },
      { key: 'output', tone: 'accent', ...output, markers: markersOf('output') },
    ],
    /**
     * Whether the **whole** curve's magnitudes were anchored to authoritative provider
     * usage (`curve.source.calibrated`). The chart shows this only through the peak's
     * `≈`; a caller that wants to annotate provenance reads it here rather than
     * re-deriving it. It is `true` for `full` coverage only.
     */
    calibrated: calibratedOf(curve),
    /**
     * The same provenance, stated as coverage: `full`, `partial`, `none` or `fallback`.
     * `calibrated === false` covers three different situations — no usage at all, some
     * attempts anchored, and a join that could not be trusted — and they are not
     * interchangeable.
     */
    calibrationCoverage: calibrationCoverageOf(curve),
    /**
     * Per-phase colour segmentation of the same traces, carried through for
     * diagnostics and for tests that assert no drawable path crosses a stretch where
     * the model produced nothing.
     */
    phaseRuns: curve.phaseRuns ?? { reasoning: [], output: [] },
    /**
     * The peak is a sample of a shape-estimated series, so it is `≈` even when
     * the generated total is exact — a curve point is not a provider-certified
     * maximum (`docs/METRICS_SPEC.md` §9). `x`/`y` place the marker on the
     * measurement itself, and they are `null` when that measurement is not on the
     * chart — never a position borrowed from a weaker vertex.
     */
    peak: {
      value: peakValue,
      display: peakValue > 0 ? `≈${formatTps(peakValue)}` : DASH,
      unit: 'tokens/s',
      approximate: true,
      leader,
      x: placedPeak === null ? null : round(placedPeak.x),
      y: placedPeak === null ? null : round(placedPeak.y),
    },
    /**
     * Drawn **path** vertices, so a test can assert the SVG input is bounded. A run of one
     * vertex contributes zero: it is drawn as a point marker, not as a vertex of a line,
     * and counting it here would make this number mean two different things.
     */
    drawnPoints,
    /** Rendered subpath count: one per drawable run, never one per series. */
    drawnRuns,
    /**
     * Point markers for one-vertex runs, one per measured instant.
     *
     * Each carries the tone of its own series, so a reasoning singleton and an output
     * singleton are distinguishable by the same channel the legend already uses. They
     * are markers, not data: the SVG is `aria-hidden` and so are they, and no count on
     * this object includes them — `renderElementPoints` below adds them explicitly.
     *
     * `isPeak` says whether this marker **is** the published peak, which is the one
     * visual distinction the plot makes between two markers: an ordinary singleton is
     * small and subdued, and only the peak keeps the stronger marker. A chart of forty
     * ordinary beads must not read as forty peaks.
     */
    markers: markers.map(marker => (
      placedPeak !== null
      && marker.timeMs === placedPeak.timeMs
      && Math.abs(marker.tps - placedPeak.tps) < 1e-9
        ? { ...marker, isPeak: true }
        : { ...marker, isPeak: false }
    )),
    /**
     * The quantity the chart-wide render budget bounds: line vertices **plus** singleton
     * markers, its own named sum.
     *
     * `drawnPoints` counts one half of what the plot emits and `markers.length` the other,
     * and naming the first `drawnPoints` invited a bound assertion that measured the chart
     * while leaving every marker outside it. The two remain separate because they are
     * different things — a vertex of a polyline and a standalone dot — but no caller has to
     * add them up by hand to check the bound. A phase-transition seam is counted in
     * `drawnPoints` twice, because both subpaths do emit it.
     */
    renderElementPoints: drawnPoints + markers.length,
    /**
     * True when the chart's only evidence is single-vertex runs. The renderer
     * needs it because `drawnRuns === 0` with `markers.length > 0` is a chart that has
     * something to show and no line to show it with — the case that must not render
     * the "no curve" placeholder.
     */
    markersOnly: !hasSegment && markers.length > 0,
  }
}

;Object.assign(__exports, { CURVE_VIEW_WIDTH, CURVE_PLOT_HEIGHT, niceCeiling, curveViewModel })
			},
			"src/client/completed/view-mode.js": function (__exports) {
/**
 * Completed-card presentation mode — the whole interaction state machine, pure.
 *
 * The card shows one of two views of the same settled turn: the metric summary
 * by default, the throughput curve while the reader is pointing at or focused on
 * it. That is the entire interaction, so it lives in one pure function that a
 * Node test can drive through every transition without a DOM, and
 * `CompletedMeter.js` is left with nothing but the wiring.
 *
 * Two decisions are worth stating because they are not obvious:
 *
 *   - **Focus is the touch path.** A tap focuses a `tabindex="0"` element in
 *     every current mobile browser, so there is no separate touch handler and no
 *     `:hover` emulation to keep in sync. Blurring returns to the summary.
 *   - **A blur that stays inside the card does not close the curve.** `blur`
 *     fires while focus moves between elements, so without the guard a future
 *     focusable child would make the view flicker shut on the way to it.
 *
 * An un-interactive card (a turn with no curve data) can never leave the
 * summary: there is nothing behind the hover, so nothing may appear to be.
 */

const COMPLETED_VIEW_SUMMARY = 'summary'
const COMPLETED_VIEW_CURVE = 'curve'

/**
 * @param {'summary'|'curve'} mode current mode
 * @param {{type: string, staysInside?: boolean}} event one interaction event
 * @param {{interactive: boolean}} context whether an alternate view exists
 * @returns {'summary'|'curve'} the next mode
 */
function nextViewMode(mode, event, { interactive }) {
  /**
   * An un-interactive card has no alternate view, so it is in the summary by
   * invariant — not merely by the absence of an event that would open the curve.
   */
  if (!interactive) return COMPLETED_VIEW_SUMMARY

  switch (event?.type) {
    case 'enter':
    case 'focus':
      return COMPLETED_VIEW_CURVE
    case 'leave':
    case 'reset':
      return COMPLETED_VIEW_SUMMARY
    case 'blur':
      return event.staysInside === true ? mode : COMPLETED_VIEW_SUMMARY
    default:
      return mode
  }
}

;Object.assign(__exports, { COMPLETED_VIEW_SUMMARY, COMPLETED_VIEW_CURVE, nextViewMode })
			},
			"src/client/completed/CompletedMeter.js": function (__exports) {
/**
 * Completed turn card (browser only — this module imports `react`, so Node tests
 * must not import it directly; the structural assertions live in
 * `test/completed-tree.test.js`, which exercises `completed-tree.js` with a
 * recording `createElement`).
 *
 * Rendering contract:
 *
 *   - the component receives a finished `completedViewModel` and renders fields.
 *     It never reads a `SessionEvent`, never sees a settled snapshot, never
 *     computes a rate, a token count, a duration or a quality marker, and never
 *     decides whether `≈` applies — `src/client/ui-model.js` already decided;
 *   - geometry is not computed here either: `curveViewModel` runs once per
 *     settled turn and the SVG receives finished path data;
 *   - it owns **no timer**. A completed turn is static, so there is no ticker
 *     here, no elapsed refresh and no rolling value. The card changes only when a
 *     new view model arrives (session switch, next turn's end, rebaseline), or
 *     when the reader asks for the other view;
 *   - the interaction is `nextViewMode` in `./view-mode.js`, which is where the
 *     hover/focus/blur rules are stated and tested. This file only translates DOM
 *     events into that function's vocabulary.
 */

const { createElement: h, useEffect, useRef, useState } = __ext("react")
const { completedTree } = __req("src/client/completed/completed-tree.js")
const { curveViewModel } = __req("src/client/completed/curve-view-model.js")
const { COMPLETED_VIEW_SUMMARY, nextViewMode } = __req("src/client/completed/view-mode.js")

/**
 * The card.
 *
 * @param {{view: object, translate: (key: string) => string}} props
 */
function CompletedMeter({ view, translate }) {
  /**
   * Built once per settled turn. `view` is memoized by the controller per
   * `(session, turn)`, so hovering does not rebuild the geometry while a new turn
   * does. The effect below is the only other writer, and it runs exactly when the
   * turn changes.
   */
  const [curveView, setCurveView] = useState(() => curveViewModel(view))
  const [mode, setMode] = useState(COMPLETED_VIEW_SUMMARY)

  const previousView = useRef(view)
  useEffect(() => {
    if (previousView.current === view) return
    previousView.current = view
    setCurveView(curveViewModel(view))
    setMode(COMPLETED_VIEW_SUMMARY)
  }, [view])

  /** No curve means nothing is hidden behind hover, so the card stays inert. */
  const interactive = curveView !== null
  const dispatch = (event) => setMode(current => nextViewMode(current, event, { interactive }))

  return completedTree(h, view, translate, {
    mode,
    curveView,
    onEnter: () => dispatch({ type: 'enter' }),
    onLeave: () => dispatch({ type: 'leave' }),
    onFocus: () => dispatch({ type: 'focus' }),
    onBlur: (event) => {
      const next = event?.relatedTarget
      const staysInside = next !== null && next !== undefined && event?.currentTarget?.contains?.(next) === true
      dispatch({ type: 'blur', staysInside })
    },
  })
}

;Object.assign(__exports, { CompletedMeter })
			},
			"src/client/live/live-css.js": function (__exports) {
/**
 * Scoped stylesheet for the live meter.
 *
 * Reference: `docs/assets/reference-live-ttft.png` and
 * `docs/assets/reference-live-streaming.png`. Measured from those captures,
 * corrected to CSS pixels against the composer placeholder's ink height: a
 * centred horizontal pill roughly 49 px tall, radius about 10 px, one filled
 * surface, and a single dominant number per state.
 *
 * What that measurement changed, relative to the functional skeleton:
 *
 *   - the reference's first visual focus is the *number*, not a text row. Each
 *     state therefore renders its number through `.dsh-tpm-number` at
 *     `1.7 x` the host content size, and everything else is `0.95 x`-`1.25 x`;
 *   - the unit is a separate baseline-aligned run at `0.95 x` instead of being
 *     glued to the digits at the same size;
 *   - the pill keeps the reference's generous horizontal padding (about 1.55 em)
 *     so the number is not crowded against the border;
 *   - the separator is a hairline that stretches the content height, which is
 *     what makes one pill read as two regions rather than one run-on sentence.
 *
 * Delivery and scoping rules are documented once in `../base-css.js`.
 */

const LIVE_STYLE_ID = 'dsh-tpm-live-style'

const LIVE_CSS = `
.dsh-tpm-pill {
  box-sizing: border-box;
  max-width: min(100%, var(--dsh-composer-card-max-width, 100%));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: calc(var(--dsh-tpm-font) * .5);
  padding: calc(var(--dsh-tpm-font) * .62) calc(var(--dsh-tpm-font) * 1.55);
  border-radius: 10px;
  border: .5px solid var(--dsh-tpm-hairline);
  background: var(--dsh-tpm-surface);
  color: var(--dsw-alias-label-primary, #3c3c3d);
  line-height: 1.25;
}
.dsh-tpm-number {
  font-size: calc(var(--dsh-tpm-font) * 1.7);
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -.01em;
  color: var(--dsw-alias-label-primary, #3c3c3d);
}
.dsh-tpm-number[data-tone="accent"] {
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-unit {
  font-size: calc(var(--dsh-tpm-font) * .95);
  font-weight: 400;
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-label {
  font-size: calc(var(--dsh-tpm-font) * .95);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-stage {
  font-size: calc(var(--dsh-tpm-font) * 1.15);
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-elapsed {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-tool {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  max-width: 16em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-tpm-sep {
  width: .5px;
  align-self: stretch;
  min-height: calc(var(--dsh-tpm-font) * 1.6);
  background: var(--dsh-tpm-hairline);
}
/* A number and its unit are one visual token: keep them from wrapping apart. */
.dsh-tpm-metric {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .25);
  white-space: nowrap;
}
`

;Object.assign(__exports, { LIVE_STYLE_ID, LIVE_CSS })
			},
			"src/client/completed/completed-css.js": function (__exports) {
/**
 * Scoped stylesheet for the completed turn card.
 *
 * References: `docs/assets/reference-completed-summary.png` (the metric grid)
 * and `docs/assets/reference-hover-curve.png` (the alternate view). Both are
 * measured in `docs/IMPLEMENTATION_LOG.md`; the numbers that shaped this file:
 *
 *   - card surface `#f8f7f5` and a roughly 10 px corner radius;
 *   - **four equal columns** with a hairline between each and about 26 px of
 *     inline padding inside every column, so the first label's ink lands about
 *     26 px from the card edge;
 *   - a three-row rhythm per column: 13 px label, 22 px value, 12 px secondary,
 *     with 20 px of card padding above and below. That is about 113 px of card,
 *     which is what the reference measures;
 *   - the curve view replaces the **first two** columns with one panel spanning
 *     the same two grid tracks, so the generated-token and TTFT columns keep
 *     their exact positions and dividers across the switch.
 *
 * Both views are stacked in one grid cell (`.dsh-tpm-views`), which is what makes
 * the card height stable: the container is as tall as the taller view and a
 * switch cannot change it — at any width, at any host font size, and without
 * measuring anything in JavaScript.
 *
 * Delivery and scoping rules are documented once in `../base-css.js`.
 */

const COMPLETED_STYLE_ID = 'dsh-tpm-completed-style'

const COMPLETED_CSS = `
.dsh-tpm-card {
  box-sizing: border-box;
  width: 100%;
  max-width: min(100%, var(--dsh-composer-card-max-width, 100%));
  padding: calc(var(--dsh-tpm-font) * 1.55) 0;
  border-radius: 10px;
  border: .5px solid var(--dsh-tpm-hairline);
  background: var(--dsh-tpm-surface);
  color: var(--dsw-alias-label-primary, #3c3c3d);
  line-height: 1.4;
}
/* The card is focusable only when it has an alternate view to reveal, and the
   ring is replaced rather than removed. */
.dsh-tpm-card:focus-visible {
  outline: 2px solid var(--dsh-tpm-accent);
  outline-offset: 2px;
}
.dsh-tpm-views {
  display: grid;
}
.dsh-tpm-view {
  grid-area: 1 / 1;
  transition: opacity 220ms ease;
}
.dsh-tpm-view[data-visible="false"] {
  opacity: 0;
  pointer-events: none;
}
.dsh-tpm-cells {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: start;
}
.dsh-tpm-cell {
  min-width: 0;
  padding-inline: calc(var(--dsh-tpm-font) * 2);
}
.dsh-tpm-cell + .dsh-tpm-cell,
.dsh-tpm-curve-panel + .dsh-tpm-cell {
  border-inline-start: .5px solid var(--dsh-tpm-hairline);
}
.dsh-tpm-cell-label {
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-cell-value {
  display: flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .28);
  min-width: 0;
  margin: calc(var(--dsh-tpm-font) * .3) 0 calc(var(--dsh-tpm-font) * .45);
}
.dsh-tpm-cell-number {
  font-size: calc(var(--dsh-tpm-font) * 1.7);
  line-height: 1.28;
  font-weight: 600;
  letter-spacing: -.01em;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  white-space: nowrap;
}
.dsh-tpm-cell[data-metric="outputTps"] .dsh-tpm-cell-number {
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-cell-unit {
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.2;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  white-space: nowrap;
}
.dsh-tpm-cell-sub {
  font-size: calc(var(--dsh-tpm-font) * .92);
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary, #7f8287);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-cell-sub[data-tone="warn"] { color: var(--dsw-alias-state-warn-label, #b26a00); }
.dsh-tpm-cell-sub[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d03050); }
.dsh-tpm-curve-panel {
  grid-column: span 2;
  min-width: 0;
  padding-inline: calc(var(--dsh-tpm-font) * 2);
  display: flex;
  flex-direction: column;
}
.dsh-tpm-curve-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(var(--dsh-tpm-font) * .75);
  min-width: 0;
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.45;
}
.dsh-tpm-legend {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .85);
  min-width: 0;
  overflow: hidden;
}
.dsh-tpm-legend-item {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .38);
  color: var(--dsw-alias-label-secondary, #7f8287);
  white-space: nowrap;
}
.dsh-tpm-legend-item[data-absent="true"] { opacity: .45; }
.dsh-tpm-legend-swatch {
  width: calc(var(--dsh-tpm-font) * .5);
  height: calc(var(--dsh-tpm-font) * .5);
  border-radius: 1px;
  background: var(--dsw-alias-label-tertiary, #a2a4a6);
  transform: translateY(-1px);
}
.dsh-tpm-legend-item[data-series="output"] .dsh-tpm-legend-swatch {
  background: var(--dsh-tpm-accent);
}
.dsh-tpm-peak {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .32);
  white-space: nowrap;
}
.dsh-tpm-peak-label { color: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-peak-value {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  font-weight: 600;
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-peak-unit { color: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-plot {
  display: flex;
  align-items: stretch;
  height: calc(var(--dsh-tpm-font) * 3.7);
  margin-top: calc(var(--dsh-tpm-font) * .43);
  min-width: 0;
}
.dsh-tpm-plot-area {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-tpm-plot-svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.dsh-tpm-series {
  fill: none;
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.dsh-tpm-series[data-series="reasoning"] { stroke: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-series[data-series="output"] { stroke: var(--dsh-tpm-accent); }
.dsh-tpm-peak-dot {
  position: absolute;
  width: calc(var(--dsh-tpm-font) * .42);
  height: calc(var(--dsh-tpm-font) * .42);
  margin: 0;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-peak-dot[data-leader="output"] { background: var(--dsh-tpm-accent); }
/*
   Two marker levels, because one size for both made a chart of many single-measurement
   stretches read as a field of peaks. 0.24 x font is roughly a quarter of the plot
   height and about half the previous 0.42, which was the size the peak uses and is
   the size that made dozens of ordinary beads dominate the trace; the opacity is kept
   below 1 for the same reason. The labels, the legend and the printed peak are
   unchanged, so nothing a reader relies on became smaller — only the decoration.
   Both tones resolve through DSH aliases, so light and dark themes follow the host
   without a second rule. */
.dsh-tpm-singleton-dot {
  position: absolute;
  width: calc(var(--dsh-tpm-font) * .24);
  height: calc(var(--dsh-tpm-font) * .24);
  margin: 0;
  border-radius: 50%;
  opacity: .75;
  transform: translate(-50%, -50%);
  background: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-singleton-dot[data-series="output"] { background: var(--dsh-tpm-accent); }
/* A singleton that *is* the published peak keeps the peak's own size: the peak dot
   is drawn at the same coordinate, and a smaller circle would leave a visible ring
   of the larger one behind it. */
.dsh-tpm-singleton-dot[data-peak="true"] {
  width: calc(var(--dsh-tpm-font) * .42);
  height: calc(var(--dsh-tpm-font) * .42);
  opacity: 1;
}
.dsh-tpm-axis-max {
  flex: 0 0 auto;
  align-self: flex-start;
  padding-inline-start: calc(var(--dsh-tpm-font) * .4);
  font-size: calc(var(--dsh-tpm-font) * .85);
  line-height: 1;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-plot-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  font-size: calc(var(--dsh-tpm-font) * .92);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .35) calc(var(--dsh-tpm-font) * .8);
  margin: calc(var(--dsh-tpm-font) * .6) calc(var(--dsh-tpm-font) * 2) 0;
  padding-top: calc(var(--dsh-tpm-font) * .5);
  border-top: .5px solid var(--dsh-tpm-hairline);
  font-size: calc(var(--dsh-tpm-font) * .85);
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-foot-item {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-foot-item + .dsh-tpm-foot-item::before {
  content: '·';
  margin-inline-end: calc(var(--dsh-tpm-font) * .8);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
@media (max-width: 34rem) {
  .dsh-tpm-cells {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: calc(var(--dsh-tpm-font) * .8);
  }
  .dsh-tpm-cell:nth-child(odd) { border-inline-start-color: transparent; }
  .dsh-tpm-cell:nth-child(n + 3) {
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
  .dsh-tpm-curve-panel + .dsh-tpm-cell {
    border-inline-start-color: transparent;
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
  .dsh-tpm-curve-panel + .dsh-tpm-cell + .dsh-tpm-cell {
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
}
`

;Object.assign(__exports, { COMPLETED_STYLE_ID, COMPLETED_CSS })
			},
			"src/client/base-css.js": function (__exports) {
/**
 * Shared scoped tokens for the plugin's two stylesheets.
 *
 * Delivered as a module string for the same reason as the view stylesheets: a
 * DSH factory bundle has no CSS import mechanism, and the module system claims
 * `style[data-plugin]` tags for HMR bookkeeping. `MeterRoot.js` concatenates
 * this block with the live and completed sheets into one tag.
 *
 * Rules:
 *   - every selector is scoped under `.dsh-tpm-root`; the only exception is the
 *     documented `body[data-ds-dark-theme] .dsh-tpm-root` theme override, which
 *     is the selector the shipped DSH theme CSS itself uses;
 *   - no element selectors, no `body` typography, no global `div`/`span`/`svg`
 *     rules — the plugin must not be able to restyle anything it does not own;
 *   - every colour resolves through a host `--dsw-*` alias token so light and
 *     dark come from the active DSH theme; the fallbacks exist only so a missing
 *     token degrades to a readable value;
 *   - **one type scale.** `--dsh-tpm-font` follows the host's secondary content
 *     size (the same variable `StatsPills` reads), and every other size is a
 *     multiple of it. A user who changes DSH's font size therefore scales the
 *     whole meter with the surrounding UI instead of leaving one card behind.
 */

/**
 * `--dsh-tpm-accent` is the plugin's single self-defined value.
 *
 * Measured from `docs/assets/reference-completed-summary.png`, whose output-rate
 * number is `#fb8147`. That exact value scores 2.31:1 against the reference's own
 * card surface, which is below the 3:1 floor for large text, so the shipped
 * accent keeps the reference's hue (about 21 degrees) and darkens it to 3.4:1 —
 * closer to the reference than the previous `#d9480f` while remaining legible.
 * `docs/IMPLEMENTATION_LOG.md` records the measurement and the deviation.
 */
const BASE_STYLE_ID = 'dsh-tpm-base-style'

const BASE_CSS = `
.dsh-tpm-root {
  --dsh-tpm-font: var(--dsh-content-font-size-secondary, 13px);
  --dsh-tpm-accent: #d9600f;
  --dsh-tpm-surface: var(--dsw-alias-bg-module-platform, var(--dsw-specific-tip, rgba(127, 130, 135, .10)));
  --dsh-tpm-hairline: var(--dsw-alias-separator-primary, var(--dsw-alias-border-l1, rgba(127, 130, 135, .28)));
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  display: flex;
  justify-content: center;
  font-size: var(--dsh-tpm-font);
  font-variant-numeric: tabular-nums;
}
body[data-ds-dark-theme] .dsh-tpm-root {
  --dsh-tpm-accent: #ff9a5c;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-tpm-root * {
    transition: none !important;
    animation: none !important;
  }
}
`

;Object.assign(__exports, { BASE_STYLE_ID, BASE_CSS })
			},
			"src/client/live/MeterRoot.js": function (__exports) {
/**
 * Meter root: the one slot component for this plugin.
 *
 * It owns the presentation lifecycle that both views share, and nothing else:
 *
 *   - `inactive`/no session, and only then, renders nothing;
 *   - the live pill while a turn is open;
 *   - the completed card once the session's turn has settled;
 *   - exactly one subscription per attached session (attach is idempotent);
 *   - exactly one presentation ticker while a **live** view is on screen, at the
 *     single cadence owned by `./cadence.js`, and **no timer at all** while the
 *     completed card is on screen. A settled turn is static, so the card is
 *     written once and never re-rendered by a clock; the scheduler stops on the
 *     same state advance that reveals it;
 *   - one reference-counted style tag for the whole plugin (live pill CSS and
 *     completed card CSS together), removed with the last unmount so HMR cannot
 *     accumulate `style` elements.
 *
 * Live and completed are mutually exclusive by construction: the projection comes
 * from a single state advance in the controller (see `controller.js` `project`),
 * so a `turn/end` publish yields the card immediately and a following
 * `turn/start` yields the pill immediately.
 *
 * ## One state update per presentation tick
 *
 * `onRender` calls `refreshView()` and nothing else. An earlier revision also
 * called a `useReducer` bump to "force" the render; the audit that removed it:
 *
 *   - `refreshView` calls `setView` with the object `controller.project(id,
 *     Date.now())` returned;
 *   - the projection key includes the presentation instant
 *     (`controller.js` `projectionKey`), so a tick never re-uses the cached
 *     view object — `setView` therefore always receives a new identity and
 *     always schedules exactly one render;
 *   - a second dispatcher in the same tick could therefore only ever add a
 *     redundant update, and at the selected cadence that is a measurable cost
 *     with no visible effect.
 *
 * The invariant is asserted by `test/meter-root.test.js`, which drives a real
 * `onRender` through a recording React stub and counts dispatches per tick.
 */

const { createElement: h, useEffect, useRef, useState } = __ext("react")
const { createPresentationScheduler } = __req("src/client/live/refresh.js")
const { LivePill, meterDiagnostics } = __req("src/client/live/LiveMeter.js")
const { CompletedMeter } = __req("src/client/completed/CompletedMeter.js")
const { LIVE_CSS, LIVE_STYLE_ID } = __req("src/client/live/live-css.js")
const { COMPLETED_CSS } = __req("src/client/completed/completed-css.js")
const { BASE_CSS } = __req("src/client/base-css.js")

/** Reference count for the plugin's single style tag. */
let styleUsers = 0

/**
 * Shared tokens first, then the pill sheet, then the card sheet. The order is
 * the cascade: the base block declares the tokens both view sheets consume, and
 * neither view sheet redeclares them.
 */
const PLUGIN_CSS = `${BASE_CSS}\n${LIVE_CSS}\n${COMPLETED_CSS}`

/** A projection that cannot change until an event arrives. */
function isStatic(view) {
  return view.kind === 'completed'
}

function acquireStyle() {
  let element = document.getElementById(LIVE_STYLE_ID)
  if (element === null) {
    element = document.createElement('style')
    element.id = LIVE_STYLE_ID
    element.setAttribute('data-plugin', 'dsh-turn-performance-meter')
    element.textContent = PLUGIN_CSS
    document.head.appendChild(element)
  }
  styleUsers += 1
  return () => {
    styleUsers = Math.max(0, styleUsers - 1)
    if (styleUsers === 0) {
      const owned = document.getElementById(LIVE_STYLE_ID)
      if (owned !== null) owned.remove()
    }
  }
}

/**
 * Build the slot component. The controller and translate function close over the
 * registration site (`src/client/main.js`), so the component itself stays a pure
 * function of `(props, controller state)`.
 *
 * @param {{controller: object, t: (key: string) => string, debug?: boolean}} options
 */
function makeMeterSlot({ controller, t, debug = false }) {
  const translate = typeof t === 'function' ? t : (key => key)

  return function TurnPerformanceMeter(props) {
    const sessionId = typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null

    // Debug-only: report the seat's actual prop shape once per session value, so
    // a missing `sessionId` standard prop shows up as itself rather than as a
    // silently hidden meter. No per-delta logging exists anywhere.
    const seenSession = useRef(null)
    if (debug && seenSession.current !== sessionId) {
      seenSession.current = sessionId
      try {
        console.debug('[dsh-tpm] slot prop shape', Object.keys(props ?? {}), 'sessionId =', sessionId)
      } catch { /* diagnostics must never break render */ }
    }

    /**
     * The projected view is *state*, refreshed only by the presentation
     * scheduler (once per mount/session change, and while live on each tick) —
     * never during render. The slot's owner re-renders its occupants on every
     * chat update; if each of those renders re-projected `Date.now()`, the DOM
     * would update at the chat's cadence and bypass the throttle.
     */
    const [view, setView] = useState(() => (
      sessionId === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(sessionId, Date.now())
    ))

    const sessionIdRef = useRef(sessionId)
    sessionIdRef.current = sessionId
    const viewRef = useRef(view)
    viewRef.current = view
    const refreshView = () => {
      meterDiagnostics().refreshCalls += 1
      const id = sessionIdRef.current
      setView(id === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(id, Date.now()))
    }

    /** Created once per mounted meter; disposed implicitly by the effect below. */
    const [scheduler] = useState(() => {
      const diagnostics = meterDiagnostics()
      diagnostics.schedulerCreated += 1
      const created = createPresentationScheduler({
        intervalMs: controller.refreshMs,
        // Exactly one state update per tick: `refreshView` owns the render.
        onRender: () => {
          diagnostics.renderCalls += 1
          refreshView()
        },
      })
      diagnostics.currentScheduler = created
      return created
    })

    useEffect(() => acquireStyle(), [])

    useEffect(() => {
      if (sessionId === null) {
        refreshView()
        return undefined
      }
      const attached = controller.attach(sessionId)
      if (debug) {
        try { console.debug('[dsh-tpm] attach', sessionId, '=>', attached) } catch { /* diagnostics */ }
      }
      refreshView()
      return controller.subscribe(() => {
        meterDiagnostics().notifyCalls += 1
        /**
         * A static projection can only change on a new event, so it is rebuilt
         * once per event and never re-rendered by a timer. `refreshView` runs
         * directly instead of through the scheduler, which is what leaves **no
         * timer** for a completed card: the scheduler is never even notified.
         */
        if (isStatic(viewRef.current)) refreshView()
        else scheduler.notify()
      })
    }, [sessionId, controller, scheduler, debug])

    // The single presentation ticker: on only while a live view is visible,
    // stopped on hide, on completion and on unmount. Ingestion is never
    // throttled.
    const visible = view.kind !== 'hidden'
    const live = visible && !isStatic(view)
    useEffect(() => {
      if (!live) {
        scheduler.stop()
        return undefined
      }
      scheduler.start()
      return () => scheduler.stop()
    }, [live, scheduler])

    if (!visible) return null
    if (view.kind === 'completed') return h(CompletedMeter, { view, translate })
    return h(LivePill, { view, translate })
  }
}

;Object.assign(__exports, { makeMeterSlot })
			},
			"src/client/live/locale.js": function (__exports) {
/**
 * Locale dictionary and translate wrapper.
 *
 * Visible production strings go through the DSH Client locale service
 * (`ctx.locale.register(ns, {en, zh})` + `ctx.locale.bind(ns)`, verified at
 * `dsh-client-locale/lib/types/client/index.d.ts:198-215`). The wrapper keeps
 * an in-module English fallback so a locale-service failure degrades to a
 * readable label instead of to raw keys.
 *
 * Tool names and numeric units stay locale-independent: `tokens/s` and the
 * `pwsh +1` count suffix are identical in both locales, which is also what the
 * reference screenshots show.
 */

const LOCALE_NS = 'turnPerformanceMeter'

const LOCALE_DICTS = Object.freeze({
  en: Object.freeze({
    meterLabel: 'Live turn performance',
    ttft: 'first response timer',
    thinking: 'thinking',
    output: 'output',
    waiting: 'waiting for model',
    transition: 'processing',
    tool: 'tool',
    tpsUnit: 'tokens/s',
    // Completed card: four principal column labels, then the footer/status copy.
    completedLabel: 'Turn performance summary',
    colReasoningTps: 'Reasoning TPS',
    colOutputTps: 'Output TPS',
    colGeneratedTokens: 'Generated Tokens',
    colTtft: 'TTFT',
    elapsed: 'elapsed',
    tools: 'tools',
    attempts: 'attempts',
    'status.completed': 'completed',
    'status.interrupted': 'interrupted',
    'status.errored': 'errored',
    'status.max-tokens': 'token limit reached',
    turnLabel: 'turn',
    unavailable: 'unavailable',
    'quality.exact': 'exact',
    'quality.approximate': 'approximate',
    // Curve view: the legend reuses `thinking`/`output`, so only the panel's own
    // copy and the peak readout need entries here.
    curveLabel: 'Throughput curve',
    curveHint: 'Hover or focus for the throughput curve',
    curveUnavailable: 'no throughput samples',
    peak: 'peak',
  }),
  zh: Object.freeze({
    meterLabel: '实时性能',
    ttft: '首响应计时',
    thinking: '思考',
    output: '输出',
    waiting: '等待模型',
    transition: '处理中',
    tool: '工具',
    tpsUnit: 'tokens/s',
    completedLabel: '本轮性能统计',
    colReasoningTps: '思考 TPS',
    colOutputTps: '输出 TPS',
    colGeneratedTokens: '生成 Tokens',
    colTtft: '首响应',
    elapsed: '总用时',
    tools: '工具',
    attempts: '模型调用',
    'status.completed': '已完成',
    'status.interrupted': '已中断',
    'status.errored': '出错',
    'status.max-tokens': '达到 Token 上限',
    turnLabel: '第',
    unavailable: '不可用',
    'quality.exact': '精确',
    'quality.approximate': '近似',
    curveLabel: '吞吐曲线',
    curveHint: '悬停或聚焦查看吞吐曲线',
    curveUnavailable: '无吞吐采样',
    peak: '峰值',
  }),
})

/**
 * Wrap the locale-bound translate function with an English fallback.
 *
 * `bind(ns)` returns a function looked up against the active language at call
 * time, so locale switches are picked up on the next render. If the service is
 * absent, throws, or returns the key itself, the built-in `en` entry (or the
 * key) is used — never `undefined` in visible UI.
 *
 * @param {unknown} rawT the `ctx.locale.bind(LOCALE_NS)` result, or null
 * @returns {(key: string) => string}
 */
function wrapTranslate(rawT) {
  return (key) => {
    if (typeof rawT === 'function') {
      try {
        const value = rawT(key)
        if (typeof value === 'string' && value.length > 0 && value !== key) return value
      } catch { /* fall through to the built-in dictionary */ }
    }
    return LOCALE_DICTS.en[key] ?? key
  }
}

;Object.assign(__exports, { LOCALE_NS, LOCALE_DICTS, wrapTranslate })
			},
			"src/client/main.js": function (__exports) {
/**
 * Browser plugin entry (the bundle's module exports).
 *
 * Wiring, in order:
 *   1. register the `turnPerformanceMeter` locale namespace (en + zh);
 *   2. create the presentation controller over `ctx.sessions`;
 *   3. dispose both on fiber teardown (HMR-safe);
 *   4. inject an independent `turn-performance-meter` entry into
 *      `conversation.input.dock` — the verified full-width seat **above the
 *      composer card**, which is where the reference layout puts the meter.
 *
 * ## Why the seat moved (Phase 5B)
 *
 * Phase 3 registered in `conversation.composer.dock`, documented by DSH as
 * "Ambient entries below the composer card". That seat is *below* the composer
 * and already holds the native chat statistics (`client-ui-chat` `StatsPills`,
 * id `stats`), so the meter rendered between the input box and the numbers it
 * was competing with for width and attention.
 *
 * DSH exposes the correct region as `conversation.input.dock`
 * (`kind: 'list'`, `scope: 'session'`, `owner: InputZone`, "Full-width entries
 * above the composer card"), rendered by the owner immediately before
 * `inputBar`:
 *
 *     zone !== undefined && renderSlot("conversation.input.dock", zone),
 *     inputBar
 *
 * Native `stats` is untouched: it keeps its own seat and its own id.
 *
 * ## Order (changed in Phase 7)
 *
 * `order` is ascending within the list, and the shipped occupants of this seat are
 * `todo` (0), `goal` (10) and `queue` (20). Phase 5 placed this entry at `order: 30`
 * — last, directly above the composer — on the reasoning that adjacency to the
 * composer is what the reference layout shows.
 *
 * A screenshot of the real interface showed why that is wrong. Those three occupants
 * are **full-width cards** and the meter is a content-sized pill, so rendering the
 * narrow pill last put it between a wide card and the composer and left a band of
 * empty width on both sides of it: the stack read as card, then an orphan, then the
 * input. The reference ordering is `telemetry -> task state -> input`, and the
 * measured evidence is in `docs/IMPLEMENTATION_LOG.md` (Phase 7 dock placement).
 *
 * `SLOT_ORDER` is therefore **-10**, which is before every currently shipped occupant
 * and yields:
 *
 *     turn-performance-meter   -10
 *     todo                       0
 *     goal                      10
 *     queue                     20
 *     composer
 *
 * This is a `list` slot with ascending order and nothing else: DSH defines no
 * `alwaysFirst`, `pinTop` or equivalent, so the honest claim is "first among all
 * currently shipped `conversation.input.dock` occupants", **not** "above every
 * third-party entry". Any plugin may register a lower finite order. A finite value is
 * used deliberately; `Number.NEGATIVE_INFINITY` would be an unsupported claim on the
 * ordering contract and would also break any future DSH sorting that assumes
 * comparability.
 *
 * Native `stats` is untouched: it keeps its own seat (`conversation.composer.dock`,
 * below the composer) and its own id.
 *
 * Service keys (`slots`, `sessions`, `locale`) are the Cordis service names;
 * the package names they arrive from are declared in `package.json`
 * `dsh.client.inject`. React itself comes from the browser module table seed —
 * never from a runtime dependency.
 */

const { createController } = __req("src/client/live/controller.js")
const { makeMeterSlot } = __req("src/client/live/MeterRoot.js")
const { meterDiagnostics } = __req("src/client/live/LiveMeter.js")
const { LOCALE_DICTS, LOCALE_NS, wrapTranslate } = __req("src/client/live/locale.js")
const { DEFAULT_PRESENTATION_REFRESH_MS, REFRESH_OVERRIDE_STORAGE_KEY, resolvePresentationRefreshMs } = __req("src/client/live/cadence.js")

const inject = ['slots', 'sessions', 'locale']

/** The seat this plugin occupies, and the id it must never reuse. */
const SLOT_NAME = 'conversation.input.dock'
const SLOT_ID = 'turn-performance-meter'
/**
 * First among the shipped occupants (`todo` 0, `goal` 10, `queue` 20), so the stack
 * reads telemetry, then task state, then the composer.
 *
 * The value is finite on purpose. No DSH slot contract defines a top pin, so the
 * claim is bounded: a third-party entry at a lower order would precede this one.
 */
const SLOT_ORDER = -10

/**
 * Diagnostic switch (default OFF). When the browser local-storage key
 * `dsh-turn-performance-meter.debug` is `1`, the controller logs lifecycle
 * events (session attach, turn open/close, attempt/tool boundaries, quality
 * downgrades, rebaselines) through `console.debug` and publishes a read-only
 * diagnostics handle on `window.__dshTurnPerformanceMeter`. Per-delta logging
 * never happens, in either mode.
 */
function debugEnabled() {
  try {
    return typeof window !== 'undefined'
      && window.localStorage?.getItem('dsh-turn-performance-meter.debug') === '1'
  } catch {
    return false
  }
}

/**
 * Debug-only cadence override, read once at apply time.
 *
 * This exists so the Phase 5A A/B could run the *production* code path at
 * 200 ms, 50 ms and 10 ms without three rebuilds. It is unreachable unless the
 * diagnostic switch is already on, so the shipped cadence has exactly one
 * source (`./live/cadence.js`) and no persisted value can change it.
 */
function cadenceOverride() {
  try {
    return typeof window === 'undefined'
      ? null
      : window.localStorage?.getItem(REFRESH_OVERRIDE_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function apply(ctx) {
  const debug = debugEnabled()

  let disposeLocale = () => {}
  try {
    const result = ctx.locale?.register?.(LOCALE_NS, LOCALE_DICTS)
    if (typeof result === 'function') disposeLocale = result
  } catch { /* a missing locale service must not block the meter */ }

  let rawTranslate = null
  try {
    rawTranslate = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : null
  } catch { /* fall back to the built-in dictionary */ }
  const t = wrapTranslate(rawTranslate)

  const refreshMs = debug
    ? resolvePresentationRefreshMs(cadenceOverride())
    : DEFAULT_PRESENTATION_REFRESH_MS

  const controller = createController({ sessions: ctx.sessions, debug, refreshMs })

  /**
   * Cordis effect semantics: `ctx.effect(fn)` runs `fn` as setup and calls the
   * **returned** function at fiber teardown — the same shape as the shipped
   * `ctx.effect(() => ctx.webServer.register(...))` call sites. Registering the
   * disposal body directly would dispose the controller at startup, which is
   * exactly the failure this comment exists to prevent.
   *
   * The whole debug handle is built **inside** the setup callback, including the
   * `meter()` accessor. An earlier revision attached `meter` right after
   * `ctx.effect(...)` returned; that silently produced a handle without its
   * accessor in the browser, because the setup callback had not run yet and the
   * assignment threw into its own `catch`. One construction site, one lifetime.
   */
  ctx.effect(() => {
    if (debug) {
      try {
        window.__dshTurnPerformanceMeter = {
          controller,
          diagnostics: (sessionId) => controller.diagnostics(sessionId),
          attachedSessions: () => controller.attachedSessions(),
          meter: () => {
            const diag = meterDiagnostics()
            const scheduler = diag.currentScheduler
            return {
              /** Selected/overridden cadence actually handed to the scheduler. */
              refreshMs: controller.refreshMs,
              productionRefreshMs: DEFAULT_PRESENTATION_REFRESH_MS,
              schedulerCreated: diag.schedulerCreated,
              notifyCalls: diag.notifyCalls,
              renderCalls: diag.renderCalls,
              refreshCalls: diag.refreshCalls,
              scheduler: scheduler === null ? null : {
                ticking: scheduler.ticking,
                disposed: scheduler.disposed,
                timerCount: scheduler.timerCount,
                intervalMs: scheduler.intervalMs,
              },
            }
          },
        }
      } catch { /* diagnostics must never break telemetry */ }
    }
    return () => {
      controller.dispose()
      if (debug) {
        try { delete window.__dshTurnPerformanceMeter } catch { /* ignore */ }
      }
      try { disposeLocale() } catch { /* best effort */ }
    }
  })

  ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
    name: SLOT_NAME,
    id: SLOT_ID,
    order: SLOT_ORDER,
  }, makeMeterSlot({ controller, t, debug })))
}

;Object.assign(__exports, { inject, SLOT_NAME, SLOT_ID, SLOT_ORDER, apply })
			}
		}
		return __req("src/client/main.js")
	},
})
