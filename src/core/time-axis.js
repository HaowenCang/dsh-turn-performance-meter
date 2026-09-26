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
export function compressAttempts(attempts) {
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
