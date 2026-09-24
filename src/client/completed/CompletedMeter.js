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
 *     when the reader asks for the other view;
 *   - the interaction is `nextViewMode` in `./view-mode.js`, which is where the
 *     hover/focus/blur rules are stated and tested. This file only translates DOM
 *     events into that function's vocabulary.
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import { completedTree } from './completed-tree.js'
import { curveViewModel } from './curve-view-model.js'
import { COMPLETED_VIEW_SUMMARY, nextViewMode } from './view-mode.js'

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
  const [mode, setMode] = useState(COMPLETED_VIEW_SUMMARY)

  const previousView = useRef(view)
  useEffect(() => {
    if (previousView.current === view) return
    previousView.current = view
    setCurveView(curveViewModel(view))
    setMode(COMPLETED_VIEW_SUMMARY)
  }, [view])

  /** No curve means nothing is hidden behind hover, so the card stays inert. */
  const interactive = curveView !== null
  const dispatch = (event) => setMode(current => nextViewMode(current, event, { interactive }))

  return completedTree(h, view, translate, {
    mode,
    curveView,
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
