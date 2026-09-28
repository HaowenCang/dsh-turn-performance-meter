/**
 * Completed-card presentation state — the whole interaction state machine, pure.
 *
 * A settled card carries **two** orthogonal presentation decisions, and they are
 * deliberately kept apart because they answer different questions:
 *
 *   - `collapsed` — is the detail on screen at all? Every newly materialized
 *     card starts collapsed, so a transcript of twenty settled turns is twenty
 *     compact rows rather than twenty metric panels stacked above the composer;
 *   - `mode` — while the detail *is* on screen, is it showing the metric summary
 *     or the throughput curve? The curve appears while the reader points at or
 *     focuses the detail and disappears when they stop.
 *
 * Because they are orthogonal, the reader can never reach a settled card that is
 * expanded-but-curve-first: collapsing resets the mode, so expanding always opens
 * the summary. That rule exists so the two decisions cannot drift into a state
 * the reader did not ask for, and it is the reason `toggle` writes both fields
 * rather than flipping one of them.
 *
 * Three further decisions are worth stating because they are not obvious:
 *
 *   - **Focus is the touch path.** A tap focuses a `tabindex="0"` element in
 *     every current mobile browser, so there is no separate touch handler and no
 *     `:hover` emulation to keep in sync. Blurring returns to the summary.
 *   - **A blur that stays inside the card does not close the curve.** `blur`
 *     fires while focus moves between elements, so without the guard a future
 *     focusable child would make the view flicker shut on the way to it.
 *   - **The header is not part of the curve surface.** The expand/collapse button
 *     and the curve hover live on different elements, so a reader who tabs onto
 *     the toggle never has the chart appear under their cursor. That separation is
 *     structural (`completed-tree.js` binds the handlers to `.dsh-tpm-detail`), and
 *     `nextCompletedPresentation` states the half of it that is state: an
 *     `enter`/`focus` event while collapsed changes nothing at all.
 *
 * An un-interactive detail (a turn with no curve data) can never leave the
 * summary: there is nothing behind the hover, so nothing may appear to be.
 */

export const COMPLETED_VIEW_SUMMARY = 'summary'
export const COMPLETED_VIEW_CURVE = 'curve'

/** Presentation state of one settled card. `collapsed` is the default for every new card. */
export function defaultCompletedPresentationState() {
  return { collapsed: true, mode: COMPLETED_VIEW_SUMMARY }
}

/**
 * One transition of the completed card's presentation state.
 *
 * `toggle` is the header button; `enter`/`leave`/`focus`/`blur` are the detail
 * region's pointer and keyboard events; `reset` is a new settled view arriving.
 * Events that the current state does not admit are no-ops rather than resets,
 * which is what keeps a stray `mouseleave` from collapsing an open card.
 *
 * @param {{collapsed: boolean, mode: 'summary'|'curve'}} state current presentation state
 * @param {{type: string, staysInside?: boolean}} event one presentation event
 * @param {{interactive: boolean}} context whether an alternate view exists
 * @returns {{collapsed: boolean, mode: 'summary'|'curve'}} the next presentation state
 */
export function nextCompletedPresentation(state, event, { interactive }) {
  const current = normalizePresentation(state)

  switch (event?.type) {
    case 'reset':
      return defaultCompletedPresentationState()
    case 'toggle':
      /**
       * Collapsing resets the mode, which is what makes "expand always opens the
       * summary" true even for a reader who was last looking at the curve.
       */
      return current.collapsed
        ? { collapsed: false, mode: COMPLETED_VIEW_SUMMARY }
        : defaultCompletedPresentationState()
    default:
      break
  }

  /** Nothing behind the header: a collapsed card ignores hover and focus entirely. */
  if (current.collapsed) return current

  return { collapsed: false, mode: nextViewMode(current.mode, event, { interactive }) }
}

/**
 * The mode half of the machine on its own.
 *
 * Retained as its own exported contract because the curve transitions are the
 * tested Phase 5 behaviour and because `nextCompletedPresentation` is only their
 * caller: whatever this function says about the curve stays true for the card.
 *
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

/**
 * Coerce an untrusted state object into the two-field shape.
 *
 * A state that did not come from `defaultCompletedPresentationState` — a stale
 * value from an earlier revision of this module, or a hand-written literal in a
 * test — must not be able to produce a card that is `undefined`-collapsed, which
 * would render the detail. Anything unrecognized degrades to the default.
 */
function normalizePresentation(state) {
  return {
    collapsed: state?.collapsed !== false,
    mode: state?.mode === COMPLETED_VIEW_CURVE ? COMPLETED_VIEW_CURVE : COMPLETED_VIEW_SUMMARY,
  }
}
