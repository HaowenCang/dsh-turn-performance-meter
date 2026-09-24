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
export class SlidingWindowMeter {
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
