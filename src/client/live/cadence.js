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
 *   - it is not the rolling TPS window. That is a one-second trailing window
 *     (`src/core/sliding-window.js`) and it is deliberately independent: a
 *     faster screen refresh must not shorten the interval a rate is measured
 *     over;
 *   - it is not the completed curve's sampling cadence. That is
 *     `DEFAULT_SAMPLE_EVERY_MS` in `src/core/curve.js`, and the two are
 *     different concepts that happen to be expressed in milliseconds.
 *
 * `PRESENTATION_REFRESH_CANDIDATES_MS` records the three cadences that were
 * actually measured in a browser (Phase 5A A/B). The selection rationale is in
 * `docs/IMPLEMENTATION_LOG.md`; the constant below is the winner.
 */

/**
 * Selected production cadence: 50 ms (20 presentation updates per second).
 *
 * Chosen from measured evidence rather than from the assumption that a higher
 * number is smoother — see the Phase 5A table in `docs/IMPLEMENTATION_LOG.md`.
 * 200 ms (the previous default) is retained only as a reference point.
 */
export const DEFAULT_PRESENTATION_REFRESH_MS = 50

/** The cadences the Phase 5A browser A/B actually ran, slowest first. */
export const PRESENTATION_REFRESH_CANDIDATES_MS = Object.freeze([200, 50, 10])

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
