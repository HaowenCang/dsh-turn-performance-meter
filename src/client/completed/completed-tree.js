/**
 * Completed-card element tree — pure, React-free.
 *
 * The card's structure, its visible strings, its accessible names and the
 * decision to hide an item (a turn with no tool call, a phase with no secondary
 * line) are all decided here. `CompletedMeter.js` is the thin React binding over
 * this module, which keeps the render layer thin and lets the tree be tested in
 * Node with a recording `createElement` rather than a DOM.
 *
 * The card carries **two** views of the same settled turn and shows one at a
 * time: the metric summary (default) and the throughput curve (while hovered or
 * focused). They are stacked in one grid cell rather than swapped, so the card's
 * height is the taller of the two and a switch cannot resize it. The hidden
 * layer is `aria-hidden` and `pointer-events: none`, so assistive technology is
 * never handed two copies of the turn's numbers at once.
 *
 * The tree never computes geometry: the curve panel arrives finished from
 * `curve-view-model.js` and is assembled by `curve-tree.js`.
 */

import { metricCellTree, secondaryText } from './metric-cell.js'
import { curveTree } from './curve-tree.js'

export { metricCellTree, secondaryText }

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
 * The whole card.
 *
 * @param {(tag: string, props: object, children?: unknown) => object} createElement
 * @param {object} view `completedViewModel` output
 * @param {(key: string) => string} translate
 * @param {{
 *   mode?: 'summary'|'curve',
 *   curveView?: object|null,
 *   onEnter?: Function, onLeave?: Function, onFocus?: Function, onBlur?: Function,
 * }} [interaction] presentation state and handlers owned by `CompletedMeter`
 */
export function completedTree(createElement, view, translate, interaction = {}) {
  const t = typeof translate === 'function' ? translate : (key => key)
  const mode = interaction.mode === 'curve' ? 'curve' : 'summary'
  const curveView = interaction.curveView ?? null
  const interactive = curveView !== null
  const statusText = t(`status.${view.status}`)

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

  const cardProps = {
    className: 'dsh-tpm-card',
    role: 'group',
    'aria-label': `${t('completedLabel')} · ${t('turnLabel')} ${view.turn ?? ''} · ${statusText}`,
  }
  if (interactive) {
    /**
     * Focusability is tied to the alternate view: a card with nothing behind
     * hover must not sit in the tab order, because a focus stop that changes
     * nothing is worse than no stop at all.
     */
    cardProps.tabIndex = 0
    cardProps['aria-description'] = t('curveHint')
    /** Only handlers that were actually supplied become props. */
    for (const [prop, handler] of [
      ['onMouseEnter', interaction.onEnter],
      ['onMouseLeave', interaction.onLeave],
      ['onFocus', interaction.onFocus],
      ['onBlur', interaction.onBlur],
    ]) {
      if (typeof handler === 'function') cardProps[prop] = handler
    }
  }

  return createElement('div', {
    className: 'dsh-tpm-root',
    'data-kind': 'completed',
    'data-status': view.status,
    'data-quality': view.quality?.overall ?? 'unavailable',
    'data-view': mode,
    'data-turn': view.turn ?? '',
    ...(view.sessionId === null || view.sessionId === undefined ? {} : { 'data-session': view.sessionId }),
  }, [
    createElement('div', { key: 'card', ...cardProps }, [
      createElement('div', { key: 'views', className: 'dsh-tpm-views' }, layers),
      footerTree(createElement, view, t),
    ]),
  ])
}
