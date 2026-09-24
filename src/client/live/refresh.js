/**
 * Presentation refresh scheduler.
 *
 * The ingestion path is high-frequency (hundreds to thousands of deltas per
 * attempt — the recorded t5 fixture alone has 1315 transient frames), while
 * React must render at a bounded cadence. The contract:
 *
 *   - while the meter is visible, exactly ONE interval renders, at
 *     `intervalMs` (default 200 ms -> at most ~5 FPS of number updates);
 *   - while the meter is hidden, an event schedules at most one coalesced
 *     zero-delay render, so a turn start becomes visible immediately without
 *     per-event rendering;
 *   - `stop()`/`dispose()` clear every timer — unmount, HMR remount and
 *     session switches must never leave an interval behind;
 *   - at no point are there more than two live timers (one interval, one
 *     pending leading render).
 *
 * Deltas are never dropped on the data side: the scheduler throttles
 * *presentation only*. The timer implementations are injectable so tests can
 * assert the structural properties without wall-clock benchmarks.
 */

/**
 * @param {{
 *   intervalMs?: number,
 *   onRender: () => void,
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout,
 *   setIntervalImpl?: typeof setInterval,
 *   clearIntervalImpl?: typeof clearInterval,
 * }} options
 */
export function createPresentationScheduler({
  intervalMs = 200,
  onRender,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  if (typeof onRender !== 'function') throw new TypeError('scheduler requires an onRender callback')
  if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) throw new TypeError('intervalMs must be a finite number > 0')

  let intervalId = null
  let leadId = null
  let disposed = false

  function flushLead() {
    leadId = null
    if (!disposed) onRender()
  }

  return {
    intervalMs,

    /** Whether the periodic presentation ticker is running. */
    get ticking() {
      return intervalId !== null
    },

    /** Whether `dispose()` has permanently disabled this scheduler. */
    get disposed() {
      return disposed
    },

    /** Count of live timers this scheduler owns (0..2), for structural tests. */
    get timerCount() {
      return (intervalId === null ? 0 : 1) + (leadId === null ? 0 : 1)
    },

    /**
     * Data-side notification. While the ticker runs it already covers the
     * update; while hidden, one coalesced zero-delay render is scheduled.
     */
    notify() {
      if (disposed || intervalId !== null) return
      if (leadId === null) leadId = setTimeoutImpl(flushLead, 0)
    },

    /** Begin the bounded periodic refresh (called while the view is visible). */
    start() {
      if (disposed || intervalId !== null) return
      intervalId = setIntervalImpl(onRender, intervalMs)
    },

    /** Stop the ticker (called when the view hides or the component unmounts). */
    stop() {
      if (intervalId !== null) {
        clearIntervalImpl(intervalId)
        intervalId = null
      }
      if (leadId !== null) {
        clearTimeoutImpl(leadId)
        leadId = null
      }
    },

    /** Final cleanup: no timer may survive this call. */
    dispose() {
      disposed = true
      this.stop()
    },
  }
}
