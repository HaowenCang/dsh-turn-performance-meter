/**
 * MiMo-style phase-episode duration attribution for one model attempt.
 *
 * Normative policy (docs/METRICS_SPEC.md §7 "Phase-duration policy", superseded
 * by Phase 9.2), which this module is the only implementation of:
 *
 *  1. TTFT — the interval from attempt start to the first generated delta — is
 *     excluded, because an episode begins at its first generated sample.
 *  2. Tool and inter-attempt time is excluded: this function only ever sees one
 *     attempt's own samples plus that attempt's own settlement instant. The next
 *     attempt's samples and the tools between them are not inputs.
 *  3. An attempt is cut into **contiguous phase episodes**. Each episode's
 *     duration is `episodeEnd - episodeStart` where
 *
 *       episodeStart = the episode's first generated sample, and
 *       episodeEnd   = the first generated sample of the next episode, or —
 *                      for the terminal episode — the attempt's settlement time.
 *
 *     This intentionally includes stalls inside model generation (the gap
 *     between two samples of one episode is charged to that episode) and,
 *     for the terminal episode, the final generated-delta → settlement tail.
 *     That tail is model-attempt elapsed time under the MiMo-style definition
 *     (`docs/MIMO_RUNTIME_METRICS.md` §5.4: `settlementTime - outputStartTime`),
 *     and charging it is the deliberate Phase 9.2 change from the old
 *     inter-delta contract.
 *
 *  3b. **A non-magnitude phase cut ends the outgoing episode early (Phase
 *     9.4.3).** A name-bearing `tool-call-delta` with an empty `argumentsDelta`
 *     carries no magnitude but does declare a phase (`tokenEvidence()`), and the
 *     live meter closes the outgoing episode at that instant. The summary must
 *     close it at the same instant, or the silent stretch between the boundary and
 *     the incoming phase's first magnitude sample is charged to a phase that had
 *     already stopped producing — the principal fixture of `docs/METRICS_SPEC.md`
 *     §8.7 read `reasoningMs 300 / reasoningTps 1000` where the episode is 120 ms
 *     of reasoning and a 180 ms stretch that belongs to no phase at all.
 *
 *     The cut closes the episode and opens nothing: the incoming episode still
 *     begins at its first magnitude sample, and the stretch between the two is
 *     charged to neither phase. A cut that declares the phase already in force
 *     changes nothing, exactly as it changes nothing live.
 *
 *     The rule is implemented once, in {@link buildPhaseEpisodes}, because three
 *     consumers read it — the live estimator, the completed curve and this
 *     summary — and a second copy of the episode boundary would be free to drift
 *     from the one the chart draws.
 *  4. Reasoning and output never double-count: the episodes are disjoint and
 *     ordered, so a reasoning -> output -> reasoning interleave produces three
 *     disjoint durations rather than overlapping `[first,last]` spans.
 *  5. Degenerate attempts never produce division by zero or infinite TPS. An
 *     episode with no positive measurable duration — a single sample whose
 *     successor starts at the same instant, or a terminal episode whose
 *     settlement instant is unknown or not later than its start — reports
 *     `durationMs: null`, never `0`: "no evidence" and "measured zero duration"
 *     are different facts and only the former is true. Consumers translate
 *     `null` duration plus non-zero tokens into `unavailable` quality rather
 *     than an infinite rate.
 *
 * What is deliberately **not** charged: the attempt's own TTFT, the tool time
 * between two attempts, and the inter-attempt wait. None of them is model
 * generation, and none of them reaches this function.
 */

export const PHASE = Object.freeze({ REASONING: 'reasoning', OUTPUT: 'output' })

function toSamples(samples) {
  if (!Array.isArray(samples)) return []
  return samples
    .filter(sample => sample && Number.isFinite(sample.timeMs))
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs)
}

/** One attempt's non-magnitude phase boundaries, ascending, finite and phase-bearing. */
function toCuts(cuts) {
  if (!Array.isArray(cuts)) return []
  return cuts
    .filter(cut => cut && Number.isFinite(cut.timeMs) && (cut.phase === PHASE.REASONING || cut.phase === PHASE.OUTPUT))
    .map(cut => ({ timeMs: cut.timeMs, phase: cut.phase }))
    .sort((a, b) => a.timeMs - b.timeMs)
}

/**
 * Cut one attempt's ordered samples into phase episodes, honouring its phase cuts.
 *
 * This is the **one** implementation of the episode boundary, and it is shared by
 * the completed curve (`src/core/curve.js` samples its ladder from the returned
 * episodes) and by the summary (`attributePhaseDurations` sums their durations).
 * Two copies of this walk would be free to disagree about where a phase stopped,
 * which is exactly the class of defect the cut exists to remove.
 *
 * An episode opens at a generated sample whose phase differs from the open
 * episode's — or at any sample when no episode is open — and ends at the earliest
 * of
 *
 *   - the next episode's opening sample,
 *   - a **phase cut** declaring a different phase (a non-magnitude boundary),
 *   - the attempt's own end (`endMs`, i.e. its settlement instant).
 *
 * A cut contributes no sample, no sample count and no magnitude: it closes the
 * outgoing episode and opens nothing, so the stretch that follows it belongs to no
 * episode until a magnitude sample opens one. A cut declaring the phase already in
 * force is inert, which is what keeps a same-phase boundary from splitting a valid
 * episode.
 *
 * @param {readonly {timeMs:number, phase?:string|null}[]} samples ascending stream order
 * @param {{cuts?:readonly {timeMs:number, phase?:string|null}[], endMs?:number|null}} [options]
 * @returns {{
 *   episodes: {
 *     phase:string|null, startMs:number, startIndex:number, lastSampleMs:number,
 *     boundMs:number|null, closedByCut:boolean, sampleCount:number, mass:number,
 *   }[],
 *   episodeIndexBySample: number[],
 * }}
 *   `boundMs` is the episode's own end instant, or `null` for a terminal episode
 *   whose attempt end is unknown. `episodeIndexBySample[i]` is the episode sample
 *   `i` belongs to, so a caller can accumulate an episode's mass incrementally.
 */
export function buildPhaseEpisodes(samples, options = {}) {
  const ordered = Array.isArray(samples) ? samples : []
  const cuts = toCuts(options.cuts)
  const endMs = Number.isFinite(options.endMs) ? options.endMs : null

  /**
   * Samples and cuts merged on one clock, **cut first** at a shared instant.
   *
   * The order is the stream's own: DSH delivers the boundary delta before the
   * delta that confirms its phase, so at one millisecond the cut is the earlier
   * fact. `Array.prototype.sort` is stable, so the samples keep the ascending
   * order (and the stream ordinal) they arrived in.
   */
  const events = []
  for (let index = 0; index < ordered.length; index += 1) {
    if (Number.isFinite(ordered[index]?.timeMs)) events.push({ at: ordered[index].timeMs, sampleIndex: index, cut: null })
  }
  for (const cut of cuts) events.push({ at: cut.timeMs, sampleIndex: -1, cut })
  events.sort((left, right) => (
    left.at - right.at || (left.cut === null ? 1 : 0) - (right.cut === null ? 1 : 0)
  ))

  const episodes = []
  const episodeIndexBySample = ordered.map(() => -1)
  let current = null
  for (const event of events) {
    if (event.cut !== null) {
      const declared = event.cut.phase
      if (current !== null && declared !== current.phase && event.cut.timeMs >= current.startMs) {
        current.boundMs = event.cut.timeMs
        current.closedByCut = true
        current = null
      }
      continue
    }
    const sample = ordered[event.sampleIndex]
    if (sample === null || sample === undefined) continue
    const phase = sample.phase ?? null
    if (current !== null && phase !== current.phase) {
      current.boundMs = sample.timeMs
      current = null
    }
    if (current === null) {
      current = {
        phase,
        startMs: sample.timeMs,
        startIndex: event.sampleIndex,
        lastSampleMs: sample.timeMs,
        boundMs: null,
        closedByCut: false,
        sampleCount: 0,
        mass: 0,
      }
      episodes.push(current)
    }
    current.lastSampleMs = sample.timeMs
    current.sampleCount += 1
    current.mass += sample.tokens ?? sample.weight ?? 0
    episodeIndexBySample[event.sampleIndex] = episodes.length - 1
  }

  /**
   * The terminal episode's own end. A settlement stamped *before* the attempt's
   * last delta is clock skew and is refused rather than allowed to shrink real
   * generation time — the same rule `compressAttempts` applies to the attempt's
   * width. A cut-closed terminal episode keeps its cut: the attempt's later clock
   * belongs to no episode, and charging it to the phase that already stopped is
   * the defect this whole mechanism removes.
   */
  const terminal = episodes[episodes.length - 1]
  if (terminal !== undefined && terminal.boundMs === null && endMs !== null) {
    terminal.boundMs = Math.max(endMs, terminal.lastSampleMs)
  }
  return { episodes, episodeIndexBySample }
}

/**
 * Cut one attempt's ordered samples into contiguous phase episodes and measure each.
 *
 * The episode list is the shared vocabulary of the live estimator, the completed
 * summary and the curve: all three read "the phase of the newest sample at or
 * before an instant" and "the first sample of that episode" from the same rule —
 * `buildPhaseEpisodes` above, which is the only place the boundary is computed.
 *
 * @param {readonly {timeMs:number, phase?:string|null}[]} ordered samples, ascending
 * @param {number|null} settledAtMs the attempt's settlement instant, or `null`
 * @param {readonly {timeMs:number, phase?:string|null}[]} [cuts] the attempt's
 *   non-magnitude phase boundaries; each one ends the episode in force without
 *   opening a new one (`docs/METRICS_SPEC.md` §8.7)
 * @returns {{
 *   phase:string|null, startMs:number, lastSampleMs:number,
 *   endMs:number|null, durationMs:number|null, sampleCount:number,
 * }[]}
 */
export function phaseEpisodes(ordered, settledAtMs = null, cuts = []) {
  /**
   * Only samples with a finite instant take part, exactly as before: an attempt's
   * malformed timestamp cannot create an episode, and it cannot shift one either.
   */
  const timed = Array.isArray(ordered) ? ordered.filter(sample => sample && Number.isFinite(sample.timeMs)) : []
  const { episodes } = buildPhaseEpisodes(timed, {
    cuts,
    endMs: Number.isFinite(settledAtMs) ? settledAtMs : null,
  })
  return episodes.map(episode => {
    /**
     * A non-terminal episode ends where the next one begins — which is *after*
     * its own last sample whenever the stream fell silent across the boundary,
     * and at the same instant when the two phases interleave with no gap. A
     * cut-closed episode ends at the cut instead, and the stretch after it is
     * charged to no phase. The terminal episode ends at the attempt's settlement
     * instant, never before its own last sample (see `buildPhaseEpisodes`).
     */
    const endMs = episode.boundMs
    return {
      phase: episode.phase,
      startMs: episode.startMs,
      lastSampleMs: episode.lastSampleMs,
      endMs,
      /** `null` means "not measurable"; `0` would claim a measured zero duration. */
      durationMs: endMs === null || !(endMs > episode.startMs) ? null : endMs - episode.startMs,
      sampleCount: episode.sampleCount,
    }
  })
}

/**
 * Sum one phase's measurable episode durations.
 *
 * @returns {{ms:number|null, episodeCount:number, measuredCount:number}}
 *   `ms` is `null` when the phase has no measurable episode at all; otherwise it
 *   is the sum of the measurable ones, and `measuredCount < episodeCount` states
 *   that the denominator is short of the phase's full generation time.
 */
function phaseDuration(episodes, phase) {
  const owned = episodes.filter(episode => episode.phase === phase)
  let ms = 0
  let measured = 0
  for (const episode of owned) {
    if (episode.durationMs === null) continue
    ms += episode.durationMs
    measured += 1
  }
  return {
    ms: measured > 0 ? ms : null,
    episodeCount: owned.length,
    measuredCount: measured,
  }
}

/**
 * Attribute one attempt's phase-episode durations.
 *
 * @param {readonly {timeMs:number, phase:'reasoning'|'output'}[]} samples
 * @param {{settledAtMs?:number|null, phaseCuts?:readonly {timeMs:number, phase:string}[]}} [options]
 *   `settledAtMs` ends the terminal episode; without it the terminal episode is
 *   unmeasurable (`null`), never zero. `phaseCuts` are the attempt's
 *   non-magnitude phase boundaries: each one ends the episode in force at its own
 *   instant and opens nothing, so the stretch that follows belongs to no phase.
 * @returns {{
 *   reasoningMs:number|null,
 *   outputMs:number|null,
 *   reasoningEpisodeCount:number,
 *   reasoningMeasuredEpisodes:number,
 *   outputEpisodeCount:number,
 *   outputMeasuredEpisodes:number,
 *   spanMs:number,
 *   sampleCount:number,
 *   generatedCount:number,
 *   episodes:object[],
 * }}
 */
export function attributePhaseDurations(samples, options = {}) {
  const ordered = toSamples(samples)
  const settledAtMs = Number.isFinite(options?.settledAtMs) ? options.settledAtMs : null
  const episodes = phaseEpisodes(ordered, settledAtMs, options?.phaseCuts)
  const reasoning = phaseDuration(episodes, PHASE.REASONING)
  const output = phaseDuration(episodes, PHASE.OUTPUT)

  const first = ordered[0]?.timeMs
  const last = ordered[ordered.length - 1]?.timeMs
  return {
    reasoningMs: reasoning.ms,
    outputMs: output.ms,
    reasoningEpisodeCount: reasoning.episodeCount,
    reasoningMeasuredEpisodes: reasoning.measuredCount,
    outputEpisodeCount: output.episodeCount,
    outputMeasuredEpisodes: output.measuredCount,
    spanMs: ordered.length > 1 ? Math.max(0, last - first) : 0,
    sampleCount: ordered.length,
    generatedCount: ordered.length,
    episodes,
  }
}
