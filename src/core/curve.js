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

export const DEFAULT_WINDOW_MS = 1000
export const DEFAULT_SAMPLE_EVERY_MS = 250

/** Largest rendered series the SVG layer is allowed to receive. */
export const DEFAULT_MAX_POINTS = 512

/**
 * Largest number of vertices **one chart** may receive across every series, every
 * run and both phases.
 *
 * `DEFAULT_MAX_POINTS` bounds per run, which is not a bound on a chart: a hundred
 * runs of 512 points each would be 51 200 SVG vertices, and the card renders inside
 * a conversation that may hold several of them. This is the budget the settled
 * snapshot actually allocates, and `allocateRunBudgets` is what divides it.
 */
export const MAX_RENDER_POINTS_TOTAL = 512

/**
 * Smallest budget that can hold the guaranteed anchors: the first point, the last
 * point and the global maximum are three distinct indices in the worst case.
 * A smaller budget is unsatisfiable rather than merely tight.
 */
export const MIN_MAX_POINTS = 3

function assertPositive(value, label) {
  if (!(Number.isFinite(value) && value > 0)) throw new TypeError(`${label} must be a finite number > 0`)
}

/**
 * Total order over the two content phases, so a tie between simultaneous samples resolves the
 * same way whatever order the transport delivered them in.
 *
 * The order itself is arbitrary; that it exists is not. `output` sorts **after**
 * `reasoning`, and since a vertex takes the label of the newest sample at or before it, an
 * attempt that produces a reasoning delta and a text delta at the same instant is labelled
 * with the output one — the phase the attempt is moving into, which is also what
 * `LiveMeter.streamingPhase` reports, because its last accepted sample of the batch is
 * whichever arrived last and the two halves of the project must agree on the tie.
 */
function comparePhase(left, right) {
  const rank = phase => (phase === 'reasoning' ? 0 : (phase === 'output' ? 1 : 2))
  return rank(left) - rank(right)
}

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
 * **A trailing run is sampled on a shifted grid.** The decay past a run's last
 * sample is sampled at `localEnd + sampleEveryMs`, `localEnd + 2 * sampleEveryMs`,
 * … rather than on the grid anchored at the run's start. Both grids place every
 * vertex on a multiple of `sampleEveryMs`, but only the shifted one keeps every
 * window inside `(last − windowMs, last]`: anchoring the grid at the start makes
 * the final vertex a truncated half-window and reports a rate no definition
 * produces.
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
export function totalRollingTpsSeries(samples, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const sampleEveryMs = options.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS
  assertPositive(windowMs, 'windowMs')
  assertPositive(sampleEveryMs, 'sampleEveryMs')

  const filtered = (Array.isArray(samples) ? samples : [])
    .filter(sample => sample && Number.isFinite(sample.activeTimeMs))
    .slice()
    /**
     * Ascending instant, then phase. The second key is load-bearing rather than cosmetic:
     * a reasoning delta and a text delta can share a timestamp, and the vertex's label is
     * read off the newest sample at or before it. Ordering by time alone left that choice to
     * the sort's stability, so the same evidence could label the same vertex `reasoning` or
     * `output` depending on which chunk the transport happened to deliver first — and a
     * phase-coloured chart whose colours depend on arrival order is not reproducible.
     */
    .sort((a, b) => a.activeTimeMs - b.activeTimeMs || comparePhase(a.phase, b.phase))

  const offsetMs = Number.isFinite(options.offsetMs) ? options.offsetMs : 0
  const sampleEnd = Math.max(0, filtered.length > 0 ? filtered[filtered.length - 1].activeTimeMs : 0)
  const toMs = Number.isFinite(options.toMs) ? Math.max(0, options.toMs)
    : (Number.isFinite(options.durationMs) ? Math.max(0, options.durationMs) : sampleEnd)
  const fromMs = Number.isFinite(options.fromMs) ? Math.max(0, options.fromMs) : 0
  /**
   * Where the attempt stops producing. Past that instant the tail grid takes over,
   * so the vertices before it sit on the attempt's own 250 ms grid and the vertices
   * after it sit one step further out — which is what keeps every window a whole
   * `(t - windowMs, t]`.
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
   * The body grid always starts at `fromMs`, so a run's opening vertex is drawn even
   * when it produced a single delta; the tail grid starts one step past the last
   * sample, so it never repeats a vertex the body already drew.
   */
  const instants = []
  const bodyEndMs = Math.max(fromMs, Math.min(sampleEndMs, toMs))
  for (let step = 0; ; step += 1) {
    const at = fromMs + step * sampleEveryMs
    if (at > bodyEndMs + 1e-9) break
    instants.push(at)
  }
  for (let step = 1; ; step += 1) {
    const at = sampleEndMs + step * sampleEveryMs
    if (at > toMs + 1e-9) break
    instants.push(at)
  }

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
 * A trace is sampled over the attempt's own body and then one window of tail, so the
 * trailing decay of its final tokens is drawn: those tokens really do contribute to
 * the rate for one window after they arrive. The tail is clamped by the **earlier of
 * two** limits, and both are needed:
 *
 *   - `segment.nextStartMs`, the compressed coordinate at which the next attempt
 *     begins. A window is a per-attempt measurement, so an attempt's decay may not be
 *     drawn across the next call — including the degenerate case where the two
 *     attempts share a coordinate, which is what a retry whose abandoned prefix
 *     produced a single delta looks like;
 *   - `localEnd + windowMs`, for the last attempt, which owns its own tail.
 *
 * `hasSuccessor` is what distinguishes the two: without it an attempt that happens to
 * end exactly at the axis end is indistinguishable from one followed by another call.
 *
 * A real stall **inside** the attempt is preserved in full: the grid runs across it
 * and the trailing rate decays to zero, because a model that stops delivering for
 * more than a window is a throughput fact the chart exists to show. That is
 * different from a tool wait or an inter-attempt wait, which own no coordinate at
 * all and are the reason the grid stops at the attempt's own bound.
 *
 * @param {{attemptId?:string|null, step?:number|null, startMs:number, endMs?:number,
 *   localEndMs?:number, nextStartMs?:number, hasSuccessor?:boolean}} segment
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
export function attemptTrace(segment, samples, options = {}) {
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
    .map(sample => ({
      ...sample,
      activeTimeMs: Number.isFinite(sample.attemptTimeMs)
        ? Math.max(0, sample.attemptTimeMs)
        : Math.max(0, (sample.activeTimeMs ?? 0) - startMs),
    }))
    /** The same deterministic tie-break `totalRollingTpsSeries` applies, so the two agree. */
    .sort((a, b) => a.activeTimeMs - b.activeTimeMs || comparePhase(a.phase, b.phase))

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
  const bodyEndMs = Math.max(0, Math.min(lastSampleMs, boundedEndMs))
  const tailLimitMs = segment?.hasSuccessor === true && Number.isFinite(segment?.nextStartMs)
    ? Math.max(bodyEndMs, segment.nextStartMs - startMs)
    : bodyEndMs + windowMs
  const toMs = Math.max(bodyEndMs, tailLimitMs)

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
 * ## Where the cut goes, and why it is not simply "where the label changes"
 *
 * Two facts pull in opposite directions. A tone change must **not** be drawn as a blank
 * horizontal gap, so consecutive runs have to meet; and a run must not claim coordinates its
 * own phase did not produce, or a long silence inside one phase would be painted with the
 * *wrong* tone for its whole length.
 *
 * Cutting at the first vertex of the new label satisfies the first and fails the second: an
 * attempt that reasons, falls silent for four seconds and then writes a tool call has a
 * four-second stretch of measured zero that would be attributed entirely to reasoning. Cutting
 * at the last vertex of the old label fails the first: the runs would then be separated by
 * exactly the silence, which on the 250 ms grid is a visible hole in an otherwise continuous
 * polyline — the defect this structure exists to remove.
 *
 * The boundary is therefore the **midpoint** of the change, rounded down: the outgoing run
 * keeps the earlier half of the silence and the incoming run the later half, and the two meet
 * on one shared vertex. A phase change with no silence between its samples — the ordinary
 * case, because a call reasons and then writes — still produces exactly adjacent runs sharing
 * the transition vertex, so nothing about the common shape changes.
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
export function visualRunsOf(points) {
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
     * A run opens on the vertex the previous one closed on, so the two subpaths meet there.
     * That vertex is shared, not duplicated: it is one index in the trace's own grid, emitted
     * by both paths and charged to both by the render budget.
     */
    const from = previous === undefined ? stretch.first : previous.endIndex
    const next = stretches[index + 1]
    const to = next === undefined
      ? stretch.last
      /**
       * The shared vertex: the last one still labelled with this stretch's phase when the
       * silence is even, and the first one labelled with the next phase when it is not. It is
       * the same index either way, which is what makes the two subpaths meet.
       */
      : Math.floor((stretch.last + next.first) / 2)
    runs.push({ phase: stretch.phase, startIndex: from, endIndex: to, pointCount: to - from + 1 })
  }
  /**
   * The final run must reach the trace's last vertex. A trailing silence whose midpoint falls
   * before the end would otherwise leave the closing zeros undrawn.
   */
  const final = runs[runs.length - 1]
  if (final !== undefined && final.endIndex < list.length - 1) {
    final.endIndex = list.length - 1
    final.pointCount = final.endIndex - final.startIndex + 1
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
export function attemptTraces(segments, samples, options = {}) {
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
export function peakTps(...seriesList) {
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
export function phaseRuns(traces) {
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
export function phaseSpans(traces) {
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
export function minimumRunCost(length) {
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
export function allocateRunBudgets(runs, totalBudget = MAX_RENDER_POINTS_TOTAL) {
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
export function downsampleSeries(series, maxPoints = DEFAULT_MAX_POINTS, options = {}) {
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
export function downsampleRun(points, budget) {
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
