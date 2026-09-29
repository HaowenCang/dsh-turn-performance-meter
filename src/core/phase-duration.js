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

/**
 * Cut one attempt's ordered samples into contiguous phase episodes and measure each.
 *
 * The episode list is the shared vocabulary of the live estimator, the completed
 * summary and the curve: all three read "the phase of the newest sample at or
 * before an instant" and "the first sample of that episode" from the same rule.
 *
 * @param {readonly {timeMs:number, phase?:string|null}[]} ordered samples, ascending
 * @param {number|null} settledAtMs the attempt's settlement instant, or `null`
 * @returns {{
 *   phase:string|null, startMs:number, lastSampleMs:number,
 *   endMs:number|null, durationMs:number|null, sampleCount:number,
 * }[]}
 */
export function phaseEpisodes(ordered, settledAtMs = null) {
  const episodes = []
  for (const sample of ordered) {
    const phase = sample.phase ?? null
    const last = episodes[episodes.length - 1]
    if (last !== undefined && last.phase === phase) {
      last.lastSampleMs = sample.timeMs
      last.sampleCount += 1
      continue
    }
    episodes.push({ phase, startMs: sample.timeMs, lastSampleMs: sample.timeMs, sampleCount: 1 })
  }

  const terminal = Number.isFinite(settledAtMs) ? settledAtMs : null
  return episodes.map((episode, index) => {
    const next = episodes[index + 1]
    /**
     * A non-terminal episode ends where the next one begins — which is *after*
     * its own last sample whenever the stream fell silent across the boundary,
     * and at the same instant when the two phases interleave with no gap. The
     * terminal episode ends at the attempt's settlement instant, and never
     * before its own last sample: a settlement stamped earlier than a delta that
     * followed it is clock skew, and shrinking a measured episode below the
     * evidence it contains would make the summary rate exceed the chart's own
     * peak for the same attempt (`compressAttempts` refuses the same skew).
     */
    const endMs = next !== undefined
      ? next.startMs
      : (terminal === null ? null : Math.max(terminal, episode.lastSampleMs))
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
 * @param {{settledAtMs?:number|null}} [options] the attempt's settlement instant,
 *   which ends the terminal episode. Without it the terminal episode is
 *   unmeasurable (`null`), never zero.
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
  const episodes = phaseEpisodes(ordered, settledAtMs)
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
