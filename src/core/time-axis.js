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
 *   - an attempt's local x ends at its **terminal phase episode's end**: the
 *     attempt's settlement instant when one is known, and its last generated
 *     delta otherwise. That tail is model-attempt elapsed time under the
 *     MiMo-style definition — the numerator freezes while the denominator
 *     advances — so it is drawn rather than discarded. Nothing else is
 *     allocated after it: not for the next call's TTFT, not for the tool that
 *     follows;
 *   - the next attempt starts at the previous attempt's end, so tools,
 *     inter-attempt waiting and the next call's TTFT consume no width.
 *
 * The last two rules are one rule applied to every attempt, including the final
 * one: the axis is model-attempt time, and a tool wait between two attempts is
 * not. The final attempt is not a special case.
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
 *     attempt's own first delta. A phase episode's cumulative clock is defined
 *     on *this* clock: it is a property of one model call, not of the
 *     concatenated axis.
 *
 * The earlier revision published only `activeTimeMs` and then filtered it per
 * attempt. For the first attempt the two happen to coincide, so the code looked
 * correct; for every later attempt the "local" clock silently started at the
 * turn-global offset and its opening vertices read a rate assembled from nothing
 * (`test/curve-attempt-boundary.test.js`).
 *
 * A tool gap therefore has zero coordinate width *and* remains an absolute
 * episode boundary. Compressed coordinates being continuous does not make the
 * phase clock continuous, and code that conflates the two credits one model call
 * with another call's tokens.
 */

/**
 * @param {readonly {
 *   attemptId?:string, samples?:readonly object[], settledAtMs?:number|null,
 *   phaseCuts?:readonly {timeMs:number, phase:string}[],
 * }[]} attempts
 * @returns {{
 *   samples: object[],
 *   cuts: object[],
 *   durationMs: number,
 *   segments: {
 *     attemptId:string|null, startMs:number, endMs:number, localEndMs:number,
 *     sampleCount:number, phaseCutCount:number, preOriginCutCount:number,
 *   }[],
 * }}
 *   `cuts` are the attempts' **non-magnitude phase boundaries** on the same two
 *   clocks the samples carry. A cut that precedes its attempt's first generated
 *   sample has no coordinate on this axis — an attempt's local zero is its first
 *   delta, so a boundary before it lies outside the axis entirely — and is counted
 *   in `segments[].preOriginCutCount` rather than clamped onto zero, which would
 *   invent a pre-sample instant the evidence does not contain.
 */
export function compressAttempts(attempts) {
  const out = []
  const cuts = []
  const segments = []
  let offsetMs = 0
  if (!Array.isArray(attempts)) return { samples: out, cuts, durationMs: 0, segments }

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
        /** Attempt-local instant: the clock a phase episode is measured on. */
        attemptTimeMs: localMs,
        /** Turn-compressed coordinate: the clock the chart is drawn against. */
        activeTimeMs: offsetMs + localMs,
        /** Authoritative stream ordinal, so the tie-break at one instant is stated, not implied. */
        sampleOrder: entry.sampleOrder,
      })
    }
    /**
     * **The attempt's width is its terminal episode's end minus its first delta.**
     * The settlement instant ends the terminal episode (Phase 9.2), so an attempt
     * that settled 40 ms after its last delta owns those 40 ms of clock; an attempt
     * whose settlement was never observed keeps the last delta as its end. A
     * settlement recorded *before* the last delta is clock skew and is refused
     * rather than allowed to shrink real generation time.
     */
    const settledAtMs = Number.isFinite(attempt.settledAtMs) ? attempt.settledAtMs : null
    const span = Math.max(
      0,
      last - first,
      settledAtMs === null ? 0 : Math.max(0, settledAtMs - first),
    )
    /**
     * The attempt's phase cuts, on the attempt-local and turn-compressed clocks.
     * They are mapped by the **same** subtraction the samples use, so a cut and a
     * sample that share an absolute instant share a coordinate, and a cut is never
     * given a width of its own: the axis is model-attempt time, and a boundary is
     * an instant on it rather than a stretch of it.
     */
    const attemptCuts = []
    let preOriginCutCount = 0
    for (const cut of Array.isArray(attempt.phaseCuts) ? attempt.phaseCuts : []) {
      if (!cut || !Number.isFinite(cut.timeMs)) continue
      const localMs = cut.timeMs - first
      if (localMs < 0) {
        preOriginCutCount += 1
        continue
      }
      attemptCuts.push({
        attemptId,
        timeMs: cut.timeMs,
        phase: cut.phase ?? null,
        /** Attempt-local instant: the clock an episode is measured on. */
        attemptTimeMs: localMs,
        /** Turn-compressed coordinate: the clock the chart is drawn against. */
        activeTimeMs: offsetMs + localMs,
      })
    }
    attemptCuts.sort((a, b) => a.attemptTimeMs - b.attemptTimeMs)
    cuts.push(...attemptCuts)
    segments.push({
      attemptId,
      startMs: offsetMs,
      endMs: offsetMs + span,
      /** The attempt's own width, so a caller need not re-derive it. */
      localEndMs: span,
      sampleCount: samples.length,
      /** Boundaries that closed an episode inside this attempt's own width. */
      phaseCutCount: attemptCuts.length,
      /** Boundaries that precede the attempt's first delta and own no coordinate here. */
      preOriginCutCount,
    })
    offsetMs += span
  }

  /**
   * **Every segment's `endMs` is the attempt's terminal episode end**, and therefore
   * also the coordinate at which the next attempt opens. Those are the same instant by
   * construction — the concatenation is what removes tool wait and next-call TTFT from the
   * axis — so no separate "where the next attempt starts" field is published, and no field
   * distinguishes the final attempt from any other.
   *
   * The previous revision ended every attempt at its last generated delta, on the reasoning
   * that a vertex past it is post-generation time. That reasoning was correct for the tool
   * and inter-attempt waits it was written for and wrong for the attempt's own settlement
   * tail, which is model-attempt elapsed time: under the MiMo-style phase-cumulative
   * definition the terminal episode runs to settlement, and a curve that stopped drawing at
   * the last delta would silently drop the decay that tail produces.
   */

  return { samples: out, cuts, durationMs: offsetMs, segments }
}
