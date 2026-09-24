/**
 * Curve-panel element tree — pure, React-free.
 *
 * The panel is the alternate view inside the completed card, not a tooltip: it
 * replaces the two TPS columns in the *same* four-column grid, so the
 * generated-token and TTFT columns keep their exact positions and dividers when
 * the card switches. That is a structural choice, not a styling one — the
 * reference puts the curve in the left half and the two surviving metrics on the
 * right, and reusing the grid makes the two views differ by one element instead
 * of by one layout.
 *
 * Geometry decisions (axis ceiling, evidence spans, peak placement) belong to
 * `curve-view-model.js`; this module only turns them into elements. The SVG is
 * `aria-hidden` and the panel carries one textual description instead, so a
 * screen reader is never handed a polyline it cannot read while the accessible
 * summary says the same thing twice.
 */

import { metricCellTree } from './metric-cell.js'

/** Legend order is fixed so the swatches never swap between turns. */
const LEGEND_ORDER = Object.freeze(['reasoning', 'output'])

/** Locale key for one series' legend label. */
function legendKey(key) {
  return key === 'reasoning' ? 'thinking' : 'output'
}

/**
 * Legend row: `思考 [swatch] 输出 [swatch]` on the left, the peak on the right.
 *
 * The swatch follows its label, which is the reference's order, and the label is
 * always present — colour is never the only channel that identifies a series.
 * A phase with no drawable evidence keeps its legend entry and is marked
 * `data-absent`, because removing the entry would silently answer a question the
 * reader is still asking.
 */
function legendTree(createElement, curveView, translate) {
  const items = LEGEND_ORDER.map(key => {
    const series = curveView.series.find(candidate => candidate.key === key)
    const present = series?.present === true
    return createElement('span', {
      key,
      className: 'dsh-tpm-legend-item',
      'data-series': key,
      'data-absent': present ? 'false' : 'true',
    }, [
      createElement('span', { key: 'label', className: 'dsh-tpm-legend-label' }, translate(legendKey(key))),
      createElement('span', { key: 'swatch', className: 'dsh-tpm-legend-swatch', 'aria-hidden': 'true' }),
    ])
  })

  /**
   * The peak is a point of an estimated series, so it carries `≈` even when the
   * turn's token total is exact. The locale supplies the word; the widget never
   * prints a bare number here.
   */
  const peak = createElement('span', {
    className: 'dsh-tpm-peak',
    'data-approximate': curveView.peak.approximate ? 'true' : 'false',
  }, [
    createElement('span', { key: 'label', className: 'dsh-tpm-peak-label' }, translate('peak')),
    createElement('span', { key: 'value', className: 'dsh-tpm-peak-value' }, curveView.peak.display),
    createElement('span', { key: 'unit', className: 'dsh-tpm-peak-unit' }, curveView.peak.unit),
  ])

  return createElement('div', { className: 'dsh-tpm-curve-head' }, [
    createElement('div', { key: 'legend', className: 'dsh-tpm-legend' }, items),
    createElement('div', { key: 'peak', className: 'dsh-tpm-peak-slot' }, peak),
  ])
}

/**
 * Plot area: one path per present series, the axis ceiling, and the peak marker.
 *
 * `viewBox="0 0 100 48"` with `preserveAspectRatio="none"` and a non-scaling
 * stroke keeps the y scale at one unit per unit at any container width, which is
 * also why the peak marker is an HTML element positioned in percentages rather
 * than an SVG circle: a circle inside a non-uniformly stretched viewBox would
 * render as an ellipse.
 *
 * The marker sits inside `.dsh-tpm-plot-area` and the axis ceiling outside it,
 * because `left`/`top` percentages resolve against the containing block's
 * padding box — sharing that box with the axis label would push every marker off
 * its vertex.
 */
function plotTree(createElement, curveView, translate) {
  const paths = []
  for (const series of curveView.series) {
    if (series.present !== true || typeof series.path !== 'string') continue
    paths.push(createElement('path', {
      key: series.key,
      className: 'dsh-tpm-series',
      'data-series': series.key,
      d: series.path,
      vectorEffect: 'non-scaling-stroke',
    }))
  }

  const svg = createElement('svg', {
    key: 'svg',
    className: 'dsh-tpm-plot-svg',
    viewBox: `0 0 ${curveView.width} ${curveView.height}`,
    preserveAspectRatio: 'none',
    focusable: 'false',
    'aria-hidden': 'true',
  }, paths)

  const area = [svg]
  if (curveView.peak.x !== null && curveView.peak.y !== null) {
    area.push(createElement('span', {
      key: 'dot',
      className: 'dsh-tpm-peak-dot',
      'data-leader': curveView.peak.leader,
      'aria-hidden': 'true',
      style: {
        left: `${curveView.peak.x}%`,
        top: `${(curveView.peak.y / curveView.height) * 100}%`,
      },
    }))
  }
  if (curveView.drawnPoints === 0) {
    area.push(createElement('span', {
      key: 'empty',
      className: 'dsh-tpm-plot-empty',
    }, translate('curveUnavailable')))
  }

  return createElement('div', { className: 'dsh-tpm-plot', 'data-points': curveView.drawnPoints }, [
    createElement('div', { key: 'area', className: 'dsh-tpm-plot-area' }, area),
    createElement('span', { key: 'axis', className: 'dsh-tpm-axis-max' }, curveView.axis.display),
  ])
}

/**
 * The panel: the legend/peak head, the plot, and the two metric columns the
 * curve view keeps.
 *
 * @param {(tag: string, props: object, children?: unknown) => object} createElement
 * @param {object} curveView `curveViewModel` output
 * @param {readonly object[]} keptColumns the card's trailing metric columns
 * @param {(key: string) => string} translate
 */
export function curveTree(createElement, curveView, keptColumns, translate) {
  const t = typeof translate === 'function' ? translate : (key => key)
  return [
    createElement('div', {
      key: 'curve',
      className: 'dsh-tpm-curve-panel',
      role: 'group',
      'aria-label': `${t('curveLabel')} · ${t('peak')} ${curveView.peak.display} ${curveView.peak.unit}`,
    }, [
      legendTree(createElement, curveView, t),
      plotTree(createElement, curveView, t),
    ]),
    ...keptColumns.map(cell => metricCellTree(createElement, { cell, translate: t })),
  ]
}
