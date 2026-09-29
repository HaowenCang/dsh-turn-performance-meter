/**
 * The live presentation cadence — the single source of truth.
 *
 * Before this module the same conceptual number existed in three places: the
 * controller's own default, the scheduler's own default and the value the meter
 * root handed the scheduler. Three defaults for one contract drift apart, and a
 * cadence that drifts is a cadence nobody measured. Everything that needs the
 * number now imports it from here.
 *
 * What this number is **not**:
 *
 *   - it is not the data-ingestion rate. Every model delta enters the store;
 *     the cadence bounds *presentation* only (`docs/METRICS_SPEC.md` §6);
 *   - it is not a rate-measurement window. Phase 9.2 removed the trailing window
 *     entirely: the live rate is a phase-cumulative average, so there is no
 *     interval for a refresh to shorten;
 *   - it is not the completed curve's sampling cadence. That is
 *     `DEFAULT_SAMPLE_EVERY_MS` in `src/core/curve.js`, and the two are
 *     different concepts that happen to be expressed in milliseconds.
 *
 * `PRESENTATION_REFRESH_CANDIDATES_MS` records the cadences that were actually
 * measured in a browser (Phase 5A A/B, and the Phase 9.2 comparison against
 * MiMo's ~100 ms). The selection rationale is in
 * `docs/IMPLEMENTATION_LOG.md`; the constant below is the winner.
 */

/**
 * Selected production cadence: 100 ms (10 presentation updates per second).
 *
 * Phase 9.2 moved the selection from 50 ms to 100 ms as a **fidelity** decision
 * rather than a performance one: MiMo's metric sampling and its visible
 * presentation are both ~100 ms (`docs/MIMO_RUNTIME_METRICS.md` §3), so a DSH
 * readout that updates on the same grid is directly comparable with it. 50 ms
 * (the Phase 5A winner) and 200 ms (the original baseline) are retained as
 * measured reference points, and the diagnostic override still reaches all three.
 */
export const DEFAULT_PRESENTATION_REFRESH_MS = 100

/** The cadences the browser A/B runs actually measured, slowest first. */
export const PRESENTATION_REFRESH_CANDIDATES_MS = Object.freeze([200, 100, 50, 10])

/**
 * Debug-only override key. Read exclusively while the diagnostic switch is on,
 * so the production cadence cannot be changed by anything a user can leave
 * behind in local storage.
 */
export const REFRESH_OVERRIDE_STORAGE_KEY = 'dsh-turn-performance-meter.refreshMs'

/**
 * Coerce a stored override into a usable cadence.
 *
 * Anything that is not a finite positive number — absent key, empty string,
 * `NaN`, a negative interval — resolves to the selected production cadence
 * rather than to a broken `setInterval`, because a scheduler constructed with
 * `intervalMs <= 0` throws and would take the whole meter down with it.
 *
 * @param {unknown} candidate raw value (typically a local-storage string)
 * @returns {number} a finite interval in milliseconds
 */
export function resolvePresentationRefreshMs(candidate) {
  const value = Number(candidate)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRESENTATION_REFRESH_MS
}
