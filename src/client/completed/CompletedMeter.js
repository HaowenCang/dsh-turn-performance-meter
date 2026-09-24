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
 *   - it owns **no timer**: a completed turn is static, so there is no ticker
 *     here, no elapsed refresh and no rolling value. The card changes only when a
 *     new view model arrives (session switch, next turn's end, rebaseline);
 *   - `role="group"` with a per-turn accessible name, because this is static
 *     content that must not be announced as a live region;
 *   - Phase 4 renders **no chart**. Hover and focus change nothing here.
 */

import { createElement as h } from 'react'
import { completedTree } from './completed-tree.js'

/**
 * The card.
 *
 * @param {{view: object, translate: (key: string) => string}} props
 */
export function CompletedMeter({ view, translate }) {
  return completedTree(h, view, translate)
}
