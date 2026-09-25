/**
 * Completed-turn TPS curve: a trailing one-second rolling series sampled on the
 * compressed active clock, plus the peak of the full series.
 *
 * The window and cadence are deliberately the same conceptual window the live
 * meter uses (docs/METRICS_SPEC.md §8.2), so a point read off the curve at time
 * `t` means the same thing as the live pill did at that instant.
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
 * Curve points are `estimated` before provider usage arrives and `calibrated`
 * afterwards; they are never `exact`. `peakTps` is the peak of the **full**
 * rolling series — computed before any downsampling — and it must still be
 * labelled as an estimate, because a series sample is not a provider-certified
 * maximum (docs/METRICS_SPEC.md §9).
 */

export const DEFAULT_WINDOW_MS = 1000
export const DEFAULT_SAMPLE_EVERY_MS = 250

/** Largest rendered series the SVG layer is allowed to receive. */
export const DEFAULT_MAX_POINTS = 512

/**
 * Smallest budget that can hold the guaranteed anchors: the first point, the
 * last point and the global maximum are three distinct indices in the worst case.
 * A smaller budget is unsatisfiable rather than merely tight.
 */
export const MIN_MAX_POINTS = 3

function assertPositive(value, label) {
  if (!(Number.isFinite(value) && value > 0)) throw new TypeError(`${label} must be a finite number > 0`)
}

/**
 * Build one phase's rolling TPS series on a single, continuous clock.
 *
 * The window is half-open, `(t - windowMs, t]`: a sample exactly one window old
 * has left the measurement and a sample exactly at `t` is in it
 * (`docs/METRICS_SPEC.md` §8.1/§8.2). That is the convention
 * `SlidingWindowMeter` implements for the live pill, which is what makes a curve
 * vertex and a live reading comparable at the same attempt-local instant.
 *
 * **The opening vertex is measured separately, and it is not cosmetic.** An
 * attempt's local zero *is* its first delta: the axis is defined so the call
 * starts where its first token lands, so a half-open window there is
 * `(-windowMs, 0]` and contains nothing. Reporting `0 tokens/s` on the vertex that
 * carries the call's first tokens would be a fabricated trough. The opening vertex
 * therefore measures the attempt's own first instant — the samples at local zero —
 * which under `perAttemptSeries` is exactly the delta the call opened with.
 *
 * **A trailing run is sampled on a shifted grid.** The decay past an attempt's
 * last sample is sampled at `localEnd + sampleEveryMs`, `localEnd + 2 *
 * sampleEveryMs`, … rather than on the grid anchored at local zero. Both grids
 * place every vertex on a multiple of `sampleEveryMs`, but only the shifted one
 * keeps every window inside `(last − windowMs, last]`: anchoring the grid at zero
 * makes the final vertex a truncated half-window and reports a rate no
 * definition produces. The shift is the smallest one that leaves the tail
 * on-spec, and it is applied only to that tail — the attempt's own body is
 * sampled from its local zero.
 *
 * **One clock, one window.** This function has no notion of an attempt, so
 * calling it across an attempt boundary bridges two model calls — the exact
 * defect Phase 6 removed. Completed curves go through `perAttemptSeries`, which
 * calls this once per attempt; the concatenating overload here exists for callers
 * that genuinely hold a single uninterrupted stream.
 *
 * `fromMs`/`toMs`/`offsetMs` express "sample a bounded stretch of one attempt's
 * local clock" without weakening the above: the window is always measured on the
 * same coordinate the samples carry, and `offsetMs` only relabels the emitted
 * `timeMs`. A bounded call therefore never reaches outside `[fromMs, toMs]`.
 *
 * @param {readonly object[]} samples compressed samples carrying `activeTimeMs`
 * @param {{
 *   phase?:string|null,
 *   windowMs?:number,
 *   sampleEveryMs?:number,
 *   durationMs?:number,
 *   fromMs?:number,
 *   toMs?:number,
 *   offsetMs?:number,
 * }} [options]
 * @returns {{timeMs:number, tps:number, localMs:number}[]}
 */
export function rollingTpsSeries(samples, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const sampleEveryMs = options.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS
  assertPositive(windowMs, 'windowMs')
  assertPositive(sampleEveryMs, 'sampleEveryMs')

  const phase = options.phase ?? null
  const filtered = (Array.isArray(samples) ? samples : [])
    .filter(s => s && (phase === null || s.phase === phase) && Number.isFinite(s.activeTimeMs))
    .slice()
    .sort((a, b) => a.activeTimeMs - b.activeTimeMs)

  const offsetMs = Number.isFinite(options.offsetMs) ? options.offsetMs : 0
  const sampleEnd = Math.max(0, filtered.length > 0 ? filtered[filtered.length - 1].activeTimeMs : 0)
  const toMs = Number.isFinite(options.toMs) ? Math.max(0, options.toMs)
    : (Number.isFinite(options.durationMs) ? Math.max(0, options.durationMs) : sampleEnd)
  const fromMs = Number.isFinite(options.fromMs) ? Math.max(0, options.fromMs) : 0
  /**
   * Where the attempt stops producing in this phase. Past that instant the tail
   * grid takes over, so the vertices before it sit on the attempt's own 250 ms
   * grid and the vertices after it sit one step further out — which is what keeps
   * every window a whole `(t - windowMs, t]`.
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
   * floating-point error over a ten-minute turn would otherwise put the last
   * vertex off the grid it claims to be on.
   *
   * The body grid always starts at `fromMs`, so an attempt's opening vertex is
   * drawn even when it produced a single delta; the tail grid starts one step past
   * the last sample, so it never repeats a vertex the body already drew.
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

  for (const localMs of instants) {
    while (right < filtered.length && filtered[right].activeTimeMs <= localMs) {
      total += filtered[right].tokens ?? filtered[right].weight ?? 0
      right += 1
    }
    /**
     * The lower bound is clamped at the attempt's own zero **at the opening
     * vertex only**, so that vertex can see the delta the call opened with;
     * clamping at every vertex would hold a sample for an extra window and produce
     * a different, wrong series.
     *
     * Both bounds are expressed on the **same** clock the samples carry:
     * `offsetMs` relabels the emitted `timeMs` and must not enter this comparison,
     * because folding it into the bound while the cursors stayed local is what once
     * left a claim of 100 tokens/s on an instant whose only sample had already been
     * evicted.
     */
    const lowerExclusive = localMs <= fromMs
      ? Number.NEGATIVE_INFINITY
      : localMs - windowMs
    while (left < right && filtered[left].activeTimeMs <= lowerExclusive) {
      total -= filtered[left].tokens ?? filtered[left].weight ?? 0
      left += 1
    }
    result.push({ timeMs: offsetMs + localMs, localMs, tps: Math.max(0, total) * 1000 / windowMs })
  }
  return result
}

/**
 * Per-attempt rolling series: the completed curve's actual construction.
 *
 * Each segment is measured on its **own** local clock and only then relabelled to
 * the turn's compressed coordinate by `segment.startMs`. Two attempts that share
 * the compressed coordinate `x` therefore share no window: the last vertex of A
 * and the first vertex of B are computed from disjoint sample sets, whatever the
 * x distance between them happens to be.
 *
 * A run is sampled over `[0, localEnd + windowMs]` so the trailing decay of an
 * attempt's final tokens is drawn: those tokens really do contribute to the rate
 * for one window after they arrive, and `phaseRuns` marks exactly that stretch as
 * evidenced. That decay is then clamped by the **earlier of two** limits, and both
 * are needed:
 *
 *   - `segment.nextStartMs`, the compressed coordinate at which the next attempt
 *     begins. A window is a per-attempt measurement, so an attempt's decay may not
 *     be drawn across the next call — including the degenerate case where the two
 *     attempts share a coordinate, which is what a retry whose abandoned prefix
 *     produced a single delta looks like;
 *   - `localEnd + windowMs`, for the last attempt, which owns its own tail.
 *
 * `attemptTokens` is the sum this attempt ever produced in this phase. It is
 * carried so that a caller — or a test — can account for every vertex without
 * re-deriving it.
 *
 * @param {readonly {
 *   attemptId?:string|null, startMs:number, endMs?:number,
 *   localEndMs?:number, nextStartMs?:number,
 * }[]} segments
 * @param {readonly object[]} samples compressed samples carrying `attemptId` and `activeTimeMs`
 * @param {{phase:string, windowMs?:number, sampleEveryMs?:number}} options
 * @returns {object[]} one run per segment that produced evidence in this phase
 */
export function perAttemptSeries(segments, samples, options = {}) {
  const phase = options.phase
  if (typeof phase !== 'string') throw new TypeError('phase is required')
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const sampleEveryMs = options.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS

  const allSamples = Array.isArray(samples) ? samples : []
  /**
   * Episode structure comes from `phaseRuns`, so the drawable vertices and the
   * availability intervals are the same object graph rather than two independent
   * derivations that can drift apart.
   */
  const episodes = phaseRuns(allSamples, segments, windowMs, options.durationMs)[phase] ?? []
  const runs = []
  for (const episode of episodes) {
    const segment = (Array.isArray(segments) ? segments : []).find(
      candidate => (candidate?.attemptId ?? null) === episode.attemptId && Number.isFinite(candidate?.startMs),
    )
    const segmentStartMs = Number.isFinite(segment?.startMs) ? segment.startMs : 0
    /**
     * The episode's bounds, expressed on the attempt's own clock. The window this
     * function measures must be on the same clock the samples are read on:
     * `activeTimeMs` is a turn-compressed coordinate, and only the first attempt's
     * happens to coincide with its local one.
     */
    const fromMs = Math.max(0, episode.startMs - segmentStartMs)
    /**
     * The body grid runs from the episode's first sample to its **last
     * token-producing** sample; past that the tail grid takes over. Using the
     * episode's bounded end here instead would start the tail one window too early
     * and drop the sample the episode ends on.
     */
    const bodyEndMs = Number.isFinite(episode.lastSampleMs)
      ? Math.max(fromMs, episode.lastSampleMs - segmentStartMs)
      : Math.max(fromMs, episode.endMs - segmentStartMs)
    /**
     * The episode's bounded end, which already includes its one-window tail. The
     * body grid stops at the last delta and the tail grid continues from there, so
     * the two grids meet without repeating a vertex and every window stays a whole
     * `(t - windowMs, t]`.
     */
    const toMs = Math.max(bodyEndMs, episode.endMs - segmentStartMs)
    /**
     * Each attempt's samples are re-based to its own clock, and every sample of the
     * attempt is retained: a window opened before the episode's first sample can
     * legitimately reach back past it, and excluding those samples would measure a
     * window against a truncated history.
     */
    const perAttempt = allSamples
      .filter(sample => (
        sample
        && (sample.attemptId ?? null) === episode.attemptId
        && sample.phase === phase
      ))
      .map(sample => ({
        ...sample,
        activeTimeMs: Number.isFinite(sample.attemptTimeMs)
          ? Math.max(0, sample.attemptTimeMs)
          : Math.max(0, (sample.activeTimeMs ?? 0) - segmentStartMs),
      }))
      .sort((a, b) => a.activeTimeMs - b.activeTimeMs)
    const points = rollingTpsSeries(perAttempt, {
      phase,
      windowMs,
      sampleEveryMs,
      offsetMs: segmentStartMs,
      fromMs,
      toMs,
      /** Past this episode's last delta the tail grid takes over. */
      sampleEndMs: bodyEndMs,
    })
    let attemptTokens = 0
    for (const sample of perAttempt) attemptTokens += sample.tokens ?? sample.weight ?? 0
    const own = perAttempt.filter(sample => sample.activeTimeMs <= bodyEndMs + 1e-9)
    runs.push({
      attemptId: episode.attemptId,
      phase,
      startMs: episode.startMs,
      endMs: episode.endMs,
      /** Compressed coordinate the run's last vertex is drawn at, inclusive. */
      drawnToMs: points.length > 0 ? points[points.length - 1].timeMs : episode.startMs,
      localDurationMs: bodyEndMs,
      sampleCount: own.length,
      attemptTokens,
      /**
       * Every vertex carries its attempt identity. A caller that concatenates the
       * runs into one flat list — as the settled snapshot does for compatibility —
       * can therefore still recover the segmentation it needs, instead of having to
       * treat the list as one bridged series.
       */
      points: points.map(point => ({ ...point, attemptId: episode.attemptId })),
    })
  }
  return runs
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
 * Evidence intervals of each phase on the compressed clock — one per episode.
 *
 * A rolling series is defined for every sampled instant, but a phase that has not
 * started yet and a phase that has finished both read as zero. Those zeros are
 * arithmetically correct and visually misleading: a renderer that draws the
 * reasoning series across an output-only stretch is not showing "reasoning
 * throughput collapsed", it is showing "reasoning is over" — two different facts,
 * and only one of them is a throughput statement.
 *
 * The previous revision returned **one** interval per phase, from the first
 * sample to the last sample plus a window. That cannot describe a real turn.
 * `Reasoning A -> Output A -> Tool -> Reasoning B` puts two reasoning episodes on
 * one curve, and the single interval spanned the output-only stretch between
 * them; drawing that interval emits a flat zero line straight through a region
 * where reasoning was simply absent, which is the same lie in a new place.
 *
 * The unit here is therefore an **episode**, with three rules that follow from how
 * a rolling window behaves:
 *
 *   1. an episode starts at its first token-producing sample. Before that the
 *      phase produced nothing to measure;
 *   2. an episode ends one rolling window after its last token-producing sample,
 *      because those tokens keep contributing to the rate for exactly that long
 *      and the decay is a readable part of the series. The tail is clamped to the
 *      attempt's own end, so it can never reach into the next call;
 *   3. two same-phase episodes of one attempt merge when the second begins at or
 *      before the first one's tail: the window between them never reached zero, so
 *      there is no absent stretch to preserve. A longer silence splits them, and a
 *      change of `attemptId` splits them unconditionally.
 *
 * A phase with no samples has no runs. Series values are never altered; this is
 * availability metadata.
 *
 * @param {readonly {activeTimeMs?:number, phase?:string|null, attemptId?:string|null}[]} samples
 * @param {readonly {attemptId?:string|null, startMs:number, endMs?:number, nextStartMs?:number}[]} segments
 *   the compressed segment each attempt occupies, in turn order
 * @param {number} [windowMs] rolling window an episode's tail is extended by
 * @param {number|null} [durationMs] the axis end, so the final attempt's tail is
 *   bounded exactly where its drawn series is
 * @returns {{reasoning: object[], output: object[]}} runs in ascending `startMs`
 */
export function phaseRuns(samples, segments, windowMs = DEFAULT_WINDOW_MS, durationMs = null) {
  const tail = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0
  const all = Array.isArray(samples) ? samples : []
  const ordered = (Array.isArray(segments) ? segments : []).filter(
    segment => segment && typeof segment === 'object' && Number.isFinite(segment.startMs),
  )

  const runsFor = (phase) => {
    const runs = []
    /**
     * The coordinate at which each open episode stopped accepting samples. Kept
     * beside the run list rather than on the returned object, because it is a
     * merge bookkeeping detail and not part of the run's published meaning.
     */
    const runClosedAt = new Map()
    /**
     * Segment order, not sample order: an out-of-order or late sample must not be
     * able to open a second run for an attempt that already has one.
     */
    for (const segment of ordered) {
      const attemptId = segment.attemptId ?? null
      const local = all
        .filter(sample => (
          sample
          && sample.phase === phase
          && (sample.attemptId ?? null) === attemptId
          && Number.isFinite(sample.activeTimeMs)
        ))
        .sort((a, b) => a.activeTimeMs - b.activeTimeMs)
      if (local.length === 0) continue
      const attemptEndMs = Number.isFinite(segment.endMs) ? segment.endMs : segment.startMs
      /**
       * The interval is bounded exactly where the drawable series is bounded, so
       * the availability metadata and the vertices cannot disagree.
       *
       * An attempt capped by a following call is cut at the coordinate that call
       * owns. The final attempt has no such cap: it keeps the ordinary
       * `lastSample + windowMs` interval, which is what shows its last tokens
       * expiring rather than the curve stopping dead on the final delta.
       */
      const cappedMs = segment.hasSuccessor === true && Number.isFinite(segment.nextStartMs)
        ? segment.nextStartMs
        : null
      const tailLimitMs = cappedMs === null
        ? attemptEndMs + tail
        : cappedMs
      const boundMs = Math.max(attemptEndMs, Math.min(attemptEndMs + tail, tailLimitMs))
      for (const sample of local) {
        const at = Math.max(0, sample.activeTimeMs)
        const endMs = Math.min(at + tail, boundMs)
        const current = runs.length > 0 ? runs[runs.length - 1] : null
        /**
         * Merge only when the new sample genuinely falls inside the episode already
         * open **and the episode has not been closed by an attempt boundary**. The
         * attempt test is not redundant with the `attemptId` equality below: a
         * later attempt receives coordinates its predecessor still owned, so
         * without it two attempts that share a coordinate would merge into one run
         * no matter how different their samples are.
         */
        const closedAtMs = current === null ? null : runClosedAt.get(current)
        const mergeable = current !== null
          && current.attemptId === attemptId
          && (closedAtMs === null || at <= closedAtMs)
          && at <= current.endMs
        if (mergeable) {
          /**
           * The tail is extended, never shortened. A merged episode's evidence
           * window is the union of its samples' contributions, and the second
           * sample of a pair can be *earlier* than the first one's tail — an output
           * sample at 8 s inside a window opened at 2 s must not retract the
           * interval back to 3 s and drop the four seconds in between.
           */
          current.endMs = Math.max(current.endMs, endMs)
          current.lastSampleMs = Math.max(current.lastSampleMs, at)
          current.sampleCount += 1
        } else {
          const opened = {
            attemptId,
            phase,
            startMs: at,
            endMs: Math.max(at, endMs),
            firstSampleMs: at,
            lastSampleMs: at,
            sampleCount: 1,
          }
          runs.push(opened)
          /**
           * The coordinate at which this attempt stopped being able to extend an
           * episode. Samples of the same attempt are non-decreasing, so they all
           * sit at or below it; a later attempt's samples sit above it whenever
           * that attempt owns a distinct coordinate.
           */
          runClosedAt.set(opened, attemptEndMs)
        }
      }
    }
    return runs
  }

  return { reasoning: runsFor('reasoning'), output: runsFor('output') }
}

/**
 * Single-interval evidence view, retained for callers that only ask when a phase
 * began and ended.
 *
 * It is derived from `phaseRuns`, so it can never disagree with the multi-episode
 * structure. It must not be used to decide what to draw: between the first and
 * last run of a phase there may be stretches where the phase is absent, and this
 * shape cannot express that.
 *
 * @deprecated for rendering — use `phaseRuns`.
 */
export function phaseSpans(samples, segments, windowMs = DEFAULT_WINDOW_MS, durationMs = null) {
  const runs = phaseRuns(samples, segments, windowMs, durationMs)
  const outer = list => (list.length === 0
    ? null
    : { startMs: list[0].startMs, endMs: list[list.length - 1].endMs })
  return { reasoning: outer(runs.reasoning), output: outer(runs.output) }
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
 *   4. the surviving local extrema, **ranked by prominence** when they do not
 *      all fit;
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
 * Determinism: ties in the global extreme resolve to the earliest index, and
 * ties in prominence resolve to the earliest index, so two runs over equal input
 * return equal output.
 *
 * @param {readonly {timeMs:number, tps:number}[]} series
 * @param {number} [maxPoints] budget; must be `>= MIN_MAX_POINTS`
 * @returns {{timeMs:number, tps:number}[]} at most `maxPoints` points, in
 *   non-decreasing `timeMs` order, drawn from the input objects themselves
 */
export function downsampleSeries(series, maxPoints = DEFAULT_MAX_POINTS) {
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

  /** 4. Local extrema, each with the prominence that ranks it. */
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
