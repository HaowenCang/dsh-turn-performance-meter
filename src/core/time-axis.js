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
 *     nextStartMs:number, hasSuccessor:boolean, sampleCount:number,
 *   }[],
 * }}
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
      const localMs = Math.max(0, sample.timeMs - first)
      out.push({
        ...sample,
        attemptId,
        /** Attempt-local instant: the clock the rolling window is measured on. */
        attemptTimeMs: localMs,
        /** Turn-compressed coordinate: the clock the chart is drawn against. */
        activeTimeMs: offsetMs + localMs,
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
      /** Assigned below, once the following attempt is known. */
      nextStartMs: offsetMs + span,
      hasSuccessor: false,
    })
    offsetMs += span
  }

  /**
   * Publish where each attempt's compressed stretch stops. Every attempt but the
   * last is bounded by the attempt that follows it; the last one is bounded by its
   * own end, so an attempt is never drawn past the coordinate it owns.
   *
   * `hasSuccessor` is the separate flag that says whether `nextStartMs` is a real
   * cap or merely the axis end. Without it an attempt that happens to end exactly at
   * the axis end is indistinguishable from one followed by another call, and the
   * final attempt would lose the window decay that shows its last tokens expiring.
   *
   * `perAttemptSeries` reads both. An attempt that ends where another begins — the
   * common tool-separated case, and the degenerate case where both share a
   * coordinate — therefore draws no tail, which is correct: the next call's
   * vertices own those coordinates. The final attempt alone is free to draw its
   * one-second decay, because nothing follows it to compete for the axis.
   */
  for (let index = 0; index < segments.length; index += 1) {
    const next = segments[index + 1]
    segments[index].hasSuccessor = next !== undefined
    segments[index].nextStartMs = next === undefined ? segments[index].endMs : next.startMs
  }

  return { samples: out, durationMs: offsetMs, segments }
}
