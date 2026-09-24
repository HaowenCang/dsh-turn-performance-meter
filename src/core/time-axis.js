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
 *   - the next attempt starts at the previous attempt's last delta, so tools,
 *     inter-attempt waiting and the next call's TTFT consume no width.
 *
 * Formally this is a piecewise-linear remap of wall time. It is implemented as
 * explicit per-attempt concatenation rather than as one global clock minus
 * subtracted wall intervals, because concatenation cannot silently mis-attribute
 * a gap that spans a boundary.
 */

/**
 * @param {readonly {attemptId?:string, samples?:readonly object[]}[]} attempts
 * @returns {{samples: object[], durationMs:number, segments: {attemptId:string|null, startMs:number, endMs:number}[]}}
 */
export function compressAttempts(attempts) {
  const out = []
  const segments = []
  let offsetMs = 0
  if (!Array.isArray(attempts)) return { samples: out, durationMs: 0, segments }

  for (const attempt of attempts) {
    if (!attempt) continue
    const samples = Array.isArray(attempt.samples)
      ? attempt.samples.filter(s => s && Number.isFinite(s.timeMs)).slice().sort((a, b) => a.timeMs - b.timeMs)
      : []
    if (samples.length === 0) continue
    const first = samples[0].timeMs
    const last = samples[samples.length - 1].timeMs
    const attemptId = attempt.attemptId ?? null
    for (const sample of samples) {
      out.push({
        ...sample,
        attemptId,
        activeTimeMs: offsetMs + Math.max(0, sample.timeMs - first),
      })
    }
    const span = Math.max(0, last - first)
    segments.push({ attemptId, startMs: offsetMs, endMs: offsetMs + span })
    offsetMs += span
  }

  return { samples: out, durationMs: offsetMs, segments }
}
