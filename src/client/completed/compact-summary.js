/**
 * The collapsed card's one summary line — pure, React-free.
 *
 * A collapsed row is only worth its space if it still answers the question the
 * reader opened the card for. `Performance >` would not, so the row carries the
 * settlement status and the four principal readings on one line, exactly as the
 * official DSH TodoPanel carries `已完成 19` on its own collapsed row.
 *
 * The single rule this module exists to enforce: **it reads, it never recomputes.**
 * Every number below is a string `src/client/ui-model.js` already decided —
 * `view.columns[i].display` carries the finished formatting and, where the metric
 * is approximate, the `≈` marker; `view.columns[i].unit` is `null` for a metric
 * with no value, which is what keeps an unavailable reading as `—` instead of
 * turning it into a unit-bearing `— tokens/s`. Nothing here divides, sums, rounds,
 * calibrates or decides quality, so the compact row and the expanded detail cannot
 * disagree about a number: they are the same string.
 *
 * A dropped column is not an available column, and the two are kept apart below:
 * the loop skips a part that has no display text at all, while a reading whose
 * value is genuinely absent prints its em dash.
 */

/**
 * The four principal readings, in the card's fixed column order, each joined to
 * the locale word that names it.
 *
 * `thinking`/`output` are reused rather than duplicated so the compact row, the
 * curve legend and the column labels can never drift apart.
 */
const COMPACT_PARTS = Object.freeze([
  Object.freeze({ key: 'reasoningTps', labelKey: 'thinking' }),
  Object.freeze({ key: 'outputTps', labelKey: 'output' }),
  Object.freeze({ key: 'generatedTokens', labelKey: null }),
  Object.freeze({ key: 'ttft', labelKey: 'colTtft' }),
])

/**
 * Compose the collapsed row's progress text.
 *
 * The parts are joined with the same ` · ` separator the footer uses, so the card
 * reads as one instrument rather than as two unrelated reading styles.
 *
 * @param {object} view `completedViewModel` output
 * @param {(key: string) => string} [translate]
 * @returns {string} one line, always non-empty for a settled view
 */
export function compactSummary(view, translate) {
  const t = typeof translate === 'function' ? translate : (key => key)
  const parts = [t(`status.${view.status}`)]

  for (const part of COMPACT_PARTS) {
    const column = findColumn(view, part.key)
    if (column === null) continue
    /** A unit is present only when the reading is: `—` never grows a unit. */
    const reading = column.unit === null || column.unit === undefined
      ? column.display
      : `${column.display} ${column.unit}`
    parts.push(part.labelKey === null ? reading : `${t(part.labelKey)} ${reading}`)
  }

  return parts.join(' · ')
}

/** One column of the view model by metric key, or `null` when the view has none. */
function findColumn(view, key) {
  const columns = Array.isArray(view?.columns) ? view.columns : []
  const column = columns.find(candidate => candidate?.key === key)
  if (column === undefined) return null
  if (typeof column.display !== 'string' || column.display.length === 0) return null
  return column
}
