/**
 * Completed turn card (browser only — this module imports `react`, so Node tests
 * must not import it directly; the structural assertions live in
 * `test/completed-tree.test.js`, which exercises `completed-tree.js` with a
 * recording `createElement`).
 *
 * Rendering contract:
 *
 *   - the component receives a finished `completedViewModel` and renders fields.
 *     It never reads a `SessionEvent`, never sees a settled snapshot, never
 *     computes a rate, a token count, a duration or a quality marker, and never
 *     decides whether `≈` applies — `src/client/ui-model.js` already decided;
 *   - geometry is not computed here either: `curveViewModel` runs once per
 *     settled turn and the SVG receives finished path data;
 *   - it owns **no timer**. A completed turn is static, so there is no ticker
 *     here, no elapsed refresh and no rolling value. The card changes only when a
 *     new view model arrives (session switch, next turn's end, rebaseline), or
 *     when the reader asks for it — by expanding the row, or by pointing at or
 *     focusing the detail it revealed;
 *   - the presentation state is `nextCompletedPresentation` in `./view-mode.js`,
 *     which is where the collapse, reset, hover/focus/blur rules are stated and
 *     tested. This file only translates DOM events into that function's
 *     vocabulary.
 *
 * Two pieces of state is the whole component. They are held as **one** value
 * rather than two `useState` calls because they are written together by the
 * transitions that matter — a collapse is simultaneously "hide the detail" and
 * "forget the curve" — and splitting them would allow a render in which the card
 * is collapsed but still remembers the curve, which is exactly the state the
 * round forbids.
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import { completedTree } from './completed-tree.js'
import { curveViewModel } from './curve-view-model.js'
import {
  defaultCompletedPresentationState,
  nextCompletedPresentation,
} from './view-mode.js'

/**
 * The card.
 *
 * @param {{view: object, translate: (key: string) => string}} props
 */
export function CompletedMeter({ view, translate }) {
  /**
   * Built once per settled turn. `view` is memoized by the controller per
   * `(session, turn)`, so hovering does not rebuild the geometry while a new turn
   * does. The effect below is the only other writer, and it runs exactly when the
   * turn changes.
   */
  const [curveView, setCurveView] = useState(() => curveViewModel(view))
  const [presentation, setPresentation] = useState(defaultCompletedPresentationState)

  const previousView = useRef(view)
  useEffect(() => {
    if (previousView.current === view) return
    previousView.current = view
    setCurveView(curveViewModel(view))
    /**
     * A new settled view is a new card. Phase 5 reset the detail mode here; Phase
     * 9 resets the collapse with it, so the next turn arrives as a compact row
     * rather than as whatever the previous turn was left showing. This is also
     * what makes a reload and a session switch-back start collapsed: both
     * materialize the component afresh and both land here.
     */
    setPresentation(defaultCompletedPresentationState())
  }, [view])

  /** No curve means nothing is hidden behind hover, so the detail stays inert. */
  const interactive = curveView !== null
  const dispatch = (event) => setPresentation(current => nextCompletedPresentation(current, event, { interactive }))

  return completedTree(h, view, translate, {
    collapsed: presentation.collapsed,
    mode: presentation.mode,
    curveView,
    onToggle: () => dispatch({ type: 'toggle' }),
    onEnter: () => dispatch({ type: 'enter' }),
    onLeave: () => dispatch({ type: 'leave' }),
    onFocus: () => dispatch({ type: 'focus' }),
    onBlur: (event) => {
      const next = event?.relatedTarget
      const staysInside = next !== null && next !== undefined && event?.currentTarget?.contains?.(next) === true
      dispatch({ type: 'blur', staysInside })
    },
  })
}
