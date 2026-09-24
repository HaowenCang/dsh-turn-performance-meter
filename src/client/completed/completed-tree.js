/**
 * Completed-card element tree — pure, React-free.
 *
 * The card's structure, its visible strings, its accessible names and the
 * decision to hide an item (a turn with no tool call, a phase with no secondary
 * line) are all decided here. `CompletedMeter.js` is the two-line React binding
 * over this module, which keeps the render layer thin and lets the tree be tested
 * in Node with a recording `createElement` rather than a DOM.
 *
 * The tree never consults `view.curve`: Phase 5 owns the chart view, and Phase 4
 * must not be able to draw one by accident.
 */

/** Visible secondary text for one column, resolved from locale keys. */
export function secondaryText(secondary, translate) {
  if (secondary === null || secondary === undefined) return null
  if (secondary.kind === 'phase') return secondary.text
  if (secondary.kind === 'elapsed') return `${translate(secondary.labelKey)} ${secondary.display}`
  if (secondary.kind === 'status') {
    /** `statusKey` already names the locale key (`status.completed`). */
    const status = translate(secondary.statusKey)
    return secondary.detail === null || secondary.detail === undefined ? status : `${status} · ${secondary.detail}`
  }
  return null
}

/**
 * One principal column.
 *
 * The accessible name is built from the visible label, value and secondary line,
 * so the four numbers are never announced as four unlabelled figures. The visible
 * text stays exactly the design; the fuller phrase lives in the accessible name,
 * which is also why the card needs no `title` attribute or tooltip.
 */
export function metricCellTree(createElement, { cell, translate }) {
  const label = translate(cell.labelKey)
  const unit = cell.unit
  const secondary = secondaryText(cell.secondary, translate)
  const ariaLabel = [
    label,
    cell.available ? `${cell.display}${unit === null ? '' : ` ${unit}`}` : translate('unavailable'),
    secondary,
  ].filter(part => part !== null && part !== undefined && part !== '').join(', ')

  return createElement('div', {
    className: 'dsh-tpm-cell',
    'data-metric': cell.key,
    'data-quality': cell.quality,
    'data-approximate': cell.approximate ? 'true' : 'false',
    role: 'group',
    'aria-label': ariaLabel,
  }, [
    createElement('div', { key: 'label', className: 'dsh-tpm-cell-label' }, label),
    createElement('div', { key: 'value', className: 'dsh-tpm-cell-value' }, [
      createElement('span', { key: 'number', className: 'dsh-tpm-cell-number' }, cell.display),
      unit === null ? null : createElement('span', { key: 'unit', className: 'dsh-tpm-cell-unit' }, unit),
    ]),
    secondary === null
      ? null
      : createElement('div', {
        key: 'sub',
        className: 'dsh-tpm-cell-sub',
        'data-tone': cell.secondary.tone ?? 'neutral',
      }, secondary),
  ])
}

/**
 * The whole card.
 *
 * @param {(tag: string, props: object, children?: unknown) => object} createElement
 * @param {object} view `completedViewModel` output
 * @param {(key: string) => string} translate
 */
export function completedTree(createElement, view, translate) {
  const t = typeof translate === 'function' ? translate : (key => key)
  const tools = view.tools ?? { count: 0, wallDisplay: '' }
  const statusText = t(`status.${view.status}`)

  /**
   * Footer items. Tools lead because they are the only footer fact that can be
   * absent: a turn with no tool call hides the tool item entirely rather than
   * printing "0 tools", and the separator is a CSS pseudo-element so the line
   * never starts or ends with a bullet.
   */
  const footer = []
  if (tools.count > 0) footer.push(`${t('tools')} ${tools.count} · ${tools.wallDisplay}`)
  if (view.attemptCount > 0) footer.push(`${t('attempts')} ${view.attemptCount}`)
  footer.push(statusText)

  return createElement('div', {
    className: 'dsh-tpm-root',
    'data-kind': 'completed',
    'data-status': view.status,
    'data-quality': view.quality?.overall ?? 'unavailable',
    role: 'group',
    'aria-label': `${t('completedLabel')} · ${t('turnLabel')} ${view.turn ?? ''} · ${statusText}`,
    'data-turn': view.turn ?? '',
    ...(view.sessionId === null || view.sessionId === undefined ? {} : { 'data-session': view.sessionId }),
  }, [
    createElement('div', { key: 'card', className: 'dsh-tpm-card' }, [
      createElement('div', { key: 'cells', className: 'dsh-tpm-cells' },
        view.columns.map(cell => metricCellTree(createElement, { cell, translate: t }))),
      createElement('div', { key: 'foot', className: 'dsh-tpm-foot' },
        footer.map((text, index) => createElement('span', { key: `${index}`, className: 'dsh-tpm-foot-item' }, text))),
    ]),
  ])
}
