/**
 * Completed-card element tree — pure, React-free.
 *
 * The card's structure, its visible strings, its accessible names and the
 * decision to hide an item (a turn with no tool call, a phase with no secondary
 * line, the whole detail region while collapsed) are all decided here.
 * `CompletedMeter.js` is the thin React binding over this module, which keeps the
 * render layer thin and lets the tree be tested in Node with a recording
 * `createElement` rather than a DOM.
 *
 * ## Two nested decisions, two different owners
 *
 * The card shell answers *is the detail on screen*: a `button.dsh-tpm-card-header`
 * spanning the full row, carrying `aria-expanded`, the title, a one-line summary
 * and a chevron. It mirrors the official DSH TodoPanel header, down to the
 * direction of the chevron — `ChevronUp` while collapsed, `ChevronDown` while
 * expanded — because matching the host is the point of the round.
 *
 * The detail region answers *which view is on screen*: the metric summary by
 * default, the throughput curve while hovered or focused. **The two do not share
 * an element.** The curve handlers and the focus stop are bound to
 * `.dsh-tpm-detail`, never to the card, so tabbing onto the expand/collapse
 * button cannot reveal a chart — a reader who only wanted to reopen the card must
 * not have the view change under them.
 *
 * While collapsed the detail is **not rendered at all**, rather than hidden with
 * `opacity` or `visibility`. A hidden-but-present region would keep its height
 * above the composer, which is the specific cost this round exists to remove, and
 * it would also leave four metric groups in the accessibility tree of a row that
 * visually exposes one line.
 *
 * The two views are stacked in one grid cell rather than swapped, so the expanded
 * card's height is the taller of the two and a switch cannot resize it. The hidden
 * layer is `aria-hidden` and `pointer-events: none`, so assistive technology is
 * never handed two copies of the turn's numbers at once.
 *
 * The tree never computes geometry: the curve panel arrives finished from
 * `curve-view-model.js` and is assembled by `curve-tree.js`. It never computes a
 * metric either — the collapsed row and the four columns read the same
 * `view.columns` display strings (`./compact-summary.js`).
 */

import { metricCellTree, secondaryText } from './metric-cell.js'
import { curveTree } from './curve-tree.js'
import { compactSummary } from './compact-summary.js'

export { metricCellTree, secondaryText }

/**
 * The card's decorative leading glyph, in the host's 16x16 slot.
 *
 * The official panel passes a primitives-package icon here. This plugin has no
 * such dependency and will not add one for a single glyph, so the mark is inline
 * SVG at the same size, drawn in `currentColor` so it follows the host theme, and
 * `aria-hidden` because the title beside it already names the card.
 *
 * The glyph itself is a meter face: a dial arc with a needle at roughly
 * two-thirds deflection.
 */
function leadGlyphTree(createElement) {
  return createElement('svg', {
    key: 'glyph',
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    'aria-hidden': 'true',
    focusable: 'false',
  }, [
    createElement('path', {
      key: 'arc',
      d: 'M2.2 12.4a6.9 6.9 0 0 1 11.6 0',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.4',
      strokeLinecap: 'round',
    }),
    createElement('path', {
      key: 'needle',
      d: 'M8 12.1 11.3 6.9',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.4',
      strokeLinecap: 'round',
    }),
  ])
}

/**
 * The chevron, whose direction is the host's rather than the conventional one.
 *
 * DSH's TodoPanel shows `ChevronUp` while collapsed and `ChevronDown` while
 * expanded — the icon promises what the click will do to the panel below the row,
 * not which end of the list you are looking at. Keeping the same direction is what
 * makes the two stacked panels in one composer read as one control family.
 */
function chevronTree(createElement, collapsed) {
  const d = collapsed ? 'M4 9.8 8 5.8l4 4' : 'M4 6.2 8 10.2l4-4'
  return createElement('span', {
    key: 'chevron',
    className: 'dsh-tpm-card-chevron',
    'aria-hidden': 'true',
  }, createElement('svg', {
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    'aria-hidden': 'true',
    focusable: 'false',
  }, createElement('path', {
    d,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.5',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  })))
}

/**
 * The one-row header: lead, title, summary, chevron.
 *
 * The whole row is the button, which is the host's structure and also the reason
 * the hit target is the full card width rather than a 16 px chevron.
 */
function headerTree(createElement, view, t, collapsed, onToggle) {
  const props = {
    key: 'header',
    className: 'dsh-tpm-card-header',
    type: 'button',
    'aria-expanded': collapsed ? 'false' : 'true',
    /**
     * The full name of the card is the accessible one; the visible title is the
     * short word, because a 21-character title would crowd out the summary line
     * it sits beside.
     */
    'aria-label': `${t('completedLabel')} · ${t('turnLabel')} ${view.turn ?? ''} · ${t(`status.${view.status}`)}`,
  }
  if (typeof onToggle === 'function') props.onClick = onToggle

  return createElement('button', props, [
    createElement('span', { key: 'lead', className: 'dsh-tpm-card-lead', 'aria-hidden': 'true' }, leadGlyphTree(createElement)),
    createElement('span', { key: 'title', className: 'dsh-tpm-card-title' }, t('performanceTitle')),
    createElement('span', { key: 'progress', className: 'dsh-tpm-card-progress' }, compactSummary(view, t)),
    chevronTree(createElement, collapsed),
  ])
}

/**
 * Footer items. Tools lead because they are the only footer fact that can be
 * absent: a turn with no tool call hides the tool item entirely rather than
 * printing "0 tools", and the separator is a CSS pseudo-element so the line
 * never starts or ends with a bullet.
 */
function footerTree(createElement, view, translate) {
  const tools = view.tools ?? { count: 0, wallDisplay: '' }
  const items = []
  if (tools.count > 0) items.push(`${translate('tools')} ${tools.count} · ${tools.wallDisplay}`)
  if (view.attemptCount > 0) items.push(`${translate('attempts')} ${view.attemptCount}`)
  items.push(translate(`status.${view.status}`))
  return createElement('div', { key: 'foot', className: 'dsh-tpm-foot' },
    items.map((text, index) => createElement('span', { key: `${index}`, className: 'dsh-tpm-foot-item' }, text)))
}

/**
 * One stacked layer.
 *
 * `data-visible` drives the cross-fade in CSS; `aria-hidden` is the
 * accessibility half of the same decision and is a real attribute rather than a
 * style, so it survives a stylesheet that fails to load.
 */
function viewLayer(createElement, key, visible, children) {
  return createElement('div', {
    key,
    className: 'dsh-tpm-view',
    'data-view': key,
    'data-visible': visible ? 'true' : 'false',
    'aria-hidden': visible ? 'false' : 'true',
  }, createElement('div', { className: 'dsh-tpm-cells' }, children))
}

/**
 * The expanded detail: the two stacked views and the footer.
 *
 * This is the region that owns the curve, so this is where the focus stop, the
 * pointer handlers and the hint live. `tabindex` is attached only when a curve
 * exists — a focus stop that changes nothing is worse than no stop at all — and
 * the hint is attached with it, so the reason the region is focusable is
 * discoverable rather than implied.
 */
function detailTree(createElement, view, t, mode, curveView, interaction, interactive) {
  const layers = [
    viewLayer(createElement, 'summary', mode === 'summary', view.columns.map(cell => (
      metricCellTree(createElement, { cell, translate: t })
    ))),
  ]
  if (interactive) {
    /**
     * The curve view replaces the first two columns with one panel spanning the
     * same two tracks; the trailing columns are the very same cells the summary
     * renders, at the very same grid positions.
     */
    layers.push(viewLayer(createElement, 'curve', mode === 'curve',
      curveTree(createElement, curveView, view.columns.slice(2), t)))
  }

  const props = { key: 'detail', className: 'dsh-tpm-detail' }
  if (interactive) {
    props.tabIndex = 0
    props['aria-description'] = t('curveHint')
    /** Only handlers that were actually supplied become props. */
    for (const [prop, handler] of [
      ['onMouseEnter', interaction.onEnter],
      ['onMouseLeave', interaction.onLeave],
      ['onFocus', interaction.onFocus],
      ['onBlur', interaction.onBlur],
    ]) {
      if (typeof handler === 'function') props[prop] = handler
    }
  }

  return createElement('div', props, [
    createElement('div', { key: 'views', className: 'dsh-tpm-views' }, layers),
    footerTree(createElement, view, t),
  ])
}

/**
 * The whole card.
 *
 * @param {(tag: string, props: object, children?: unknown) => object} createElement
 * @param {object} view `completedViewModel` output
 * @param {(key: string) => string} translate
 * @param {{
 *   collapsed?: boolean,
 *   mode?: 'summary'|'curve',
 *   curveView?: object|null,
 *   onToggle?: Function,
 *   onEnter?: Function, onLeave?: Function, onFocus?: Function, onBlur?: Function,
 * }} [interaction] presentation state and handlers owned by `CompletedMeter`
 */
export function completedTree(createElement, view, translate, interaction = {}) {
  const t = typeof translate === 'function' ? translate : (key => key)
  /**
   * Collapsed is the default here as well as in the state machine, so a caller
   * that passes no presentation state at all — a test, a future embed — gets the
   * compact row rather than an accidental full panel.
   */
  const collapsed = interaction.collapsed !== false
  const mode = interaction.mode === 'curve' ? 'curve' : 'summary'
  const curveView = interaction.curveView ?? null
  const interactive = curveView !== null

  const card = [
    headerTree(createElement, view, t, collapsed, interaction.onToggle),
  ]
  if (!collapsed) {
    card.push(detailTree(createElement, view, t, mode, curveView, interaction, interactive))
  }

  return createElement('div', {
    className: 'dsh-tpm-root',
    'data-kind': 'completed',
    'data-status': view.status,
    'data-quality': view.quality?.overall ?? 'unavailable',
    /**
     * `data-view` keeps its Phase 5 meaning — which *detail* view is on screen —
     * because browser diagnostics read it. The collapsed decision is a separate
     * attribute for the same reason: while collapsed the card is still showing
     * the summary, so `data-view="summary"` stays true and truthful.
     */
    'data-collapsed': collapsed ? 'true' : 'false',
    'data-view': mode,
    'data-turn': view.turn ?? '',
    ...(view.sessionId === null || view.sessionId === undefined ? {} : { 'data-session': view.sessionId }),
  }, createElement('div', {
    className: 'dsh-tpm-card',
    /**
     * Phase 5 put the accessible name on the card because the card *was* the
     * interactive surface. Phase 9 split that surface in two: the header button
     * carries the expand/collapse name, so the card keeps the grouping role and
     * the accessible name and hands the button its own. The name is therefore
     * still reachable, and no reader meets the same label twice on one control.
     */
    role: 'group',
    'aria-label': `${t('completedLabel')} · ${t('turnLabel')} ${view.turn ?? ''} · ${t(`status.${view.status}`)}`,
  }, createElement('div', { className: 'dsh-tpm-card-body' }, card)))
}
