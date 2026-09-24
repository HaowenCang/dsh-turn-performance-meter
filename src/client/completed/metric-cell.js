/**
 * One principal metric column — pure, React-free, and shared.
 *
 * Extracted from the card shell so the summary grid and the curve panel render
 * columns through the **same** function. The curve view keeps two of the four
 * columns, and "the same cell, built the same way" is what makes that statement
 * literally true rather than visually similar.
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
