/**
 * Completed-card presentation mode — the whole interaction state machine, pure.
 *
 * The card shows one of two views of the same settled turn: the metric summary
 * by default, the throughput curve while the reader is pointing at or focused on
 * it. That is the entire interaction, so it lives in one pure function that a
 * Node test can drive through every transition without a DOM, and
 * `CompletedMeter.js` is left with nothing but the wiring.
 *
 * Two decisions are worth stating because they are not obvious:
 *
 *   - **Focus is the touch path.** A tap focuses a `tabindex="0"` element in
 *     every current mobile browser, so there is no separate touch handler and no
 *     `:hover` emulation to keep in sync. Blurring returns to the summary.
 *   - **A blur that stays inside the card does not close the curve.** `blur`
 *     fires while focus moves between elements, so without the guard a future
 *     focusable child would make the view flicker shut on the way to it.
 *
 * An un-interactive card (a turn with no curve data) can never leave the
 * summary: there is nothing behind the hover, so nothing may appear to be.
 */

export const COMPLETED_VIEW_SUMMARY = 'summary'
export const COMPLETED_VIEW_CURVE = 'curve'

/**
 * @param {'summary'|'curve'} mode current mode
 * @param {{type: string, staysInside?: boolean}} event one interaction event
 * @param {{interactive: boolean}} context whether an alternate view exists
 * @returns {'summary'|'curve'} the next mode
 */
export function nextViewMode(mode, event, { interactive }) {
  /**
   * An un-interactive card has no alternate view, so it is in the summary by
   * invariant — not merely by the absence of an event that would open the curve.
   */
  if (!interactive) return COMPLETED_VIEW_SUMMARY

  switch (event?.type) {
    case 'enter':
    case 'focus':
      return COMPLETED_VIEW_CURVE
    case 'leave':
    case 'reset':
      return COMPLETED_VIEW_SUMMARY
    case 'blur':
      return event.staysInside === true ? mode : COMPLETED_VIEW_SUMMARY
    default:
      return mode
  }
}
