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

export const PHASE = Object.freeze({ REASONING: 'reasoning', OUTPUT: 'output' })

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
export function attributePhaseDurations(samples) {
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
