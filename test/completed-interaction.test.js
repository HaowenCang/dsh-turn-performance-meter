/**
 * Completed-card interaction, accessibility and the curve element tree.
 *
 * Two layers are tested here and they answer different questions:
 *
 *   - `view-mode.js` is the whole interaction state machine, so every transition
 *     the brief lists (hover, mouseleave, focus, blur, focus-inside, reset) is
 *     driven directly and exhaustively;
 *   - `completed-tree.js` receives that mode and must produce the accessibility
 *     consequences: exactly one layer exposed, `aria-hidden` on the other, a
 *     focus stop only when there is something behind it, and an SVG that a screen
 *     reader is never asked to read.
 *
 * What is *not* here is whether the result looks like the reference. That is a
 * browser question, answered by `dev/screenshots/phase5/`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { completedTree } from '../src/client/completed/completed-tree.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { COMPLETED_CSS } from '../src/client/completed/completed-css.js'
import {
  COMPLETED_VIEW_CURVE,
  COMPLETED_VIEW_SUMMARY,
  nextViewMode,
} from '../src/client/completed/view-mode.js'
import { completedViewModel } from '../src/client/ui-model.js'
import { LOCALE_DICTS } from '../src/client/live/locale.js'
import { MetricQuality } from '../src/core/metric-quality.js'
import { QualityLevel } from '../src/core/quality-model.js'

function rec(tag, props, children) {
  const list = Array.isArray(children) ? children.filter(child => child !== null && child !== undefined) : [children]
  return { tag, props: props ?? {}, children: list }
}

const en = key => LOCALE_DICTS.en[key] ?? key
const zh = key => LOCALE_DICTS.zh[key] ?? key

function byClass(node, name, found = []) {
  if (node === null || node === undefined || typeof node === 'string') return found
  if (String(node.props.className ?? '').split(/\s+/).includes(name)) found.push(node)
  for (const child of node.children) byClass(child, name, found)
  return found
}

function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return node.children.flatMap(texts)
}

const settledCurve = () => ({
  durationMs: 20_000,
  segments: [],
  reasoning: [{ timeMs: 0, tps: 40 }, { timeMs: 5000, tps: 380 }],
  output: [{ timeMs: 5000, tps: 0 }, { timeMs: 20_000, tps: 700 }],
  peakTps: 700,
  phaseSpans: { reasoning: { startMs: 0, endMs: 6000 }, output: { startMs: 5000, endMs: 20_000 } },
  quality: 'estimated',
  sampleEveryMs: 250,
  windowMs: 1000,
})

function viewOf(curve = null) {
  return completedViewModel({
    sessionId: 'session-1',
    turn: 7,
    status: 'completed',
    statusNote: null,
    reasoningTps: 345,
    reasoningTpsQuality: MetricQuality.EXACT,
    reasoningMs: 108_200,
    outputTps: 676,
    outputTpsQuality: MetricQuality.EXACT,
    outputMs: 25_400,
    phaseTokens: { reasoning: 37_498, output: 17_272 },
    generatedTokens: 54_770,
    observedGeneratedTokens: 54_770,
    turnElapsedMs: 133_600,
    ttftMs: 1440,
    attemptCount: 4,
    tools: { count: 4, completedCount: 4, wallMs: 12_800, workMs: 12_800, failedCount: 0, names: ['pwsh'] },
    quality: {
      tokenTotalQuality: QualityLevel.EXACT,
      phaseSplitQuality: QualityLevel.EXACT,
      temporalShapeQuality: QualityLevel.RECONSTRUCTED,
      displayTokenTotal: 'exact',
      displayPhaseSplit: 'exact',
      notes: [],
    },
    consistencyIssues: [],
    curve,
  })
}

/** The card as `CompletedMeter` builds it for one mode. */
function cardWith(curve, mode, translate = en) {
  const view = viewOf(curve)
  return completedTree(rec, view, translate, { mode, curveView: curveViewModel(view) })
}

const layer = (tree, name) => byClass(tree, 'dsh-tpm-view').find(node => node.props['data-view'] === name)

/* ------------------------------------------------------------------ view mode */

test('hover and focus open the curve, leave and blur close it, and nothing else moves it', () => {
  const interactive = { interactive: true }
  assert.equal(nextViewMode(COMPLETED_VIEW_SUMMARY, { type: 'enter' }, interactive), COMPLETED_VIEW_CURVE)
  assert.equal(nextViewMode(COMPLETED_VIEW_CURVE, { type: 'leave' }, interactive), COMPLETED_VIEW_SUMMARY)
  assert.equal(nextViewMode(COMPLETED_VIEW_SUMMARY, { type: 'focus' }, interactive), COMPLETED_VIEW_CURVE)
  assert.equal(nextViewMode(COMPLETED_VIEW_CURVE, { type: 'blur' }, interactive), COMPLETED_VIEW_SUMMARY)
  assert.equal(nextViewMode(COMPLETED_VIEW_CURVE, { type: 'reset' }, interactive), COMPLETED_VIEW_SUMMARY)
  /** Unknown events are inert rather than a mode reset. */
  assert.equal(nextViewMode(COMPLETED_VIEW_CURVE, { type: 'scroll' }, interactive), COMPLETED_VIEW_CURVE)
  assert.equal(nextViewMode(COMPLETED_VIEW_SUMMARY, undefined, interactive), COMPLETED_VIEW_SUMMARY)
})

test('a blur that stays inside the card keeps the curve open', () => {
  const interactive = { interactive: true }
  assert.equal(nextViewMode(COMPLETED_VIEW_CURVE, { type: 'blur', staysInside: true }, interactive),
    COMPLETED_VIEW_CURVE, 'focus moving to a child must not flicker the view shut')
  assert.equal(nextViewMode(COMPLETED_VIEW_CURVE, { type: 'blur', staysInside: false }, interactive),
    COMPLETED_VIEW_SUMMARY)
})

test('a card with no alternate view is in the summary by invariant', () => {
  const inert = { interactive: false }
  for (const type of ['enter', 'focus', 'leave', 'blur', 'reset', 'scroll']) {
    assert.equal(nextViewMode(COMPLETED_VIEW_SUMMARY, { type }, inert), COMPLETED_VIEW_SUMMARY)
    /** Even a mode left over from a previous turn collapses: there is nothing to show. */
    assert.equal(nextViewMode(COMPLETED_VIEW_CURVE, { type }, inert), COMPLETED_VIEW_SUMMARY)
    assert.equal(nextViewMode(COMPLETED_VIEW_CURVE, { type, staysInside: true }, inert), COMPLETED_VIEW_SUMMARY)
  }
})

/* --------------------------------------------------------------- card structure */

test('the default view is the summary and the curve layer is hidden and inert', () => {
  const tree = cardWith(settledCurve(), COMPLETED_VIEW_SUMMARY)
  assert.equal(tree.props['data-view'], 'summary')
  const summary = layer(tree, 'summary')
  const curve = layer(tree, 'curve')
  assert.equal(summary.props['data-visible'], 'true')
  assert.equal(curve.props['data-visible'], 'false')
  assert.equal(summary.props['aria-hidden'], 'false')
  assert.equal(curve.props['aria-hidden'], 'true', 'the hidden layer is not announced')
})

test('the curve view exposes the curve and hides the summary, without duplicating content', () => {
  const tree = cardWith(settledCurve(), COMPLETED_VIEW_CURVE)
  assert.equal(tree.props['data-view'], 'curve')
  assert.equal(layer(tree, 'summary').props['aria-hidden'], 'true')
  assert.equal(layer(tree, 'curve').props['aria-hidden'], 'false')
  /** Exactly one layer is exposed at any instant: no screen reader sees two copies. */
  const exposed = byClass(tree, 'dsh-tpm-view').filter(node => node.props['aria-hidden'] === 'false')
  assert.equal(exposed.length, 1)
})

test('the curve view keeps the trailing two columns in their original grid tracks', () => {
  const summaryCells = byClass(layer(cardWith(settledCurve(), COMPLETED_VIEW_SUMMARY), 'summary'), 'dsh-tpm-cells')[0].children
  const curveCells = byClass(layer(cardWith(settledCurve(), COMPLETED_VIEW_CURVE), 'curve'), 'dsh-tpm-cells')[0].children
  assert.deepEqual(summaryCells.map(cell => cell.props['data-metric']),
    ['reasoningTps', 'outputTps', 'generatedTokens', 'ttft'])
  assert.equal(curveCells.length, 3, 'one spanning panel plus the two kept columns')
  assert.equal(curveCells[0].props.className, 'dsh-tpm-curve-panel')
  assert.deepEqual(curveCells.slice(1).map(cell => cell.props['data-metric']), ['generatedTokens', 'ttft'],
    'the token total and the TTFT keep their positions, labels and values')
  assert.deepEqual(texts(curveCells[1].children[1].children[0]), texts(summaryCells[2].children[1].children[0]))
  assert.deepEqual(texts(curveCells[2].children[1].children[0]), texts(summaryCells[3].children[1].children[0]))
})

/* ------------------------------------------------------------------------ svg */

test('the plot is one hand-built path per present series, and the SVG is hidden from AT', () => {
  const curve = layer(cardWith(settledCurve(), COMPLETED_VIEW_CURVE), 'curve')
  const svg = byClass(curve, 'dsh-tpm-plot-svg')[0]
  assert.equal(svg.tag, 'svg')
  assert.equal(svg.props['aria-hidden'], 'true', 'a polyline is not a readable description')
  assert.equal(svg.props.focusable, 'false')
  assert.equal(svg.props.preserveAspectRatio, 'none')
  assert.equal(svg.props.viewBox, '0 0 100 48')

  const paths = byClass(curve, 'dsh-tpm-series')
  assert.equal(paths.length, 2, 'reasoning and output, separately')
  assert.deepEqual(paths.map(path => path.props['data-series']), ['reasoning', 'output'])
  for (const path of paths) {
    assert.equal(path.tag, 'path')
    assert.equal(path.props.vectorEffect, 'non-scaling-stroke', 'the stroke must not be stretched with the box')
    assert.match(path.props.d, /^M[-\d.]+ [-\d.]+( L[-\d.]+ [-\d.]+)+$/)
    assert.equal(/NaN|Infinity|undefined/.test(path.props.d), false)
  }
  for (const forbidden of ['circle', 'canvas', 'polyline']) {
    assert.equal(byClass(curve, forbidden).length, 0, `no ${forbidden} element`)
  }
})

test('the curve panel describes itself in words and marks the peak as approximate', () => {
  const curve = layer(cardWith(settledCurve(), COMPLETED_VIEW_CURVE), 'curve')
  const panel = byClass(curve, 'dsh-tpm-curve-panel')[0]
  assert.equal(panel.props.role, 'group')
  assert.equal(panel.props['aria-label'], 'Throughput curve · peak ≈700 tokens/s')

  const peak = byClass(curve, 'dsh-tpm-peak')[0]
  assert.equal(peak.props['data-approximate'], 'true')
  assert.deepEqual(texts(peak), ['peak', '≈700', 'tokens/s'])

  /** Colour is never the only channel: every series carries a written label. */
  const legend = byClass(curve, 'dsh-tpm-legend')[0]
  assert.deepEqual(texts(legend), ['thinking', 'output'])
  assert.deepEqual(byClass(legend, 'dsh-tpm-legend-item').map(item => item.props['data-series']),
    ['reasoning', 'output'])
})

test('an absent phase keeps its legend entry and is marked, not silently dropped', () => {
  const curveData = { ...settledCurve(), phaseSpans: { reasoning: null, output: { startMs: 5000, endMs: 20_000 } } }
  const curve = layer(cardWith(curveData, COMPLETED_VIEW_CURVE), 'curve')
  const items = byClass(curve, 'dsh-tpm-legend-item')
  assert.deepEqual(items.map(item => item.props['data-absent']), ['true', 'false'])
  assert.deepEqual(texts(byClass(curve, 'dsh-tpm-legend')[0]), ['thinking', 'output'],
    'the reader is still told the phase exists')
  assert.equal(byClass(curve, 'dsh-tpm-series').length, 1, 'but no line is invented for it')
})

test('a curve with nothing drawable still renders the card, with a written empty state', () => {
  const curveData = {
    ...settledCurve(),
    reasoning: [],
    output: [],
    peakTps: 0,
    phaseSpans: { reasoning: null, output: null },
  }
  const curve = layer(cardWith(curveData, COMPLETED_VIEW_CURVE), 'curve')
  assert.equal(byClass(curve, 'dsh-tpm-series').length, 0)
  assert.deepEqual(texts(byClass(curve, 'dsh-tpm-plot-empty')[0]), ['no throughput samples'])
  assert.deepEqual(texts(byClass(curve, 'dsh-tpm-peak')[0]), ['peak', '—', 'tokens/s'])
  assert.equal(byClass(curve, 'dsh-tpm-peak-dot').length, 0, 'no marker without a leader point')
})

test('the peak marker is placed in percentages and never as raw pixels', () => {
  const curve = layer(cardWith(settledCurve(), COMPLETED_VIEW_CURVE), 'curve')
  const dot = byClass(curve, 'dsh-tpm-peak-dot')[0]
  assert.equal(dot.props['data-leader'], 'output')
  assert.equal(dot.props['aria-hidden'], 'true')
  assert.match(dot.props.style.left, /^[\d.]+%$/)
  assert.match(dot.props.style.top, /^[\d.]+%$/, 'a percentage survives a host font-size change')
})

/* -------------------------------------------------- singleton (one-vertex) runs */

/**
 * A curve carrying explicit `series` runs, so a one-vertex run can be placed on the panel
 * exactly as the settled snapshot would deliver it.
 */
function singletonCurve(runs, { peakTps = null } = {}) {
  const series = [
    { key: 'reasoning', tone: 'neutral', runs: Array.isArray(runs.reasoning) ? runs.reasoning : [] },
    { key: 'output', tone: 'accent', runs: Array.isArray(runs.output) ? runs.output : [] },
  ]
  const peak = peakTps ?? Math.max(
    0,
    ...series.flatMap(entry => entry.runs.flatMap(run => run.points.map(point => point.tps))),
  )
  return { ...settledCurve(), series, peakTps: peak }
}

const singletonRun = (attemptId, timeMs, tps) => ({ attemptId, points: [{ timeMs, tps }] })

test('a one-vertex run is drawn as a point marker, not as a fabricated line', () => {
  const curve = singletonCurve({ output: [singletonRun('a', 0, 500)] })
  const panel = layer(cardWith(curve, COMPLETED_VIEW_CURVE), 'curve')

  /**
   * No path, because one measurement is not a segment: duplicating the vertex to manufacture
   * a line would draw a trend the data does not contain.
   */
  assert.equal(byClass(panel, 'dsh-tpm-series').length, 0, 'no line is invented for one vertex')

  const markers = byClass(panel, 'dsh-tpm-singleton-dot')
  assert.equal(markers.length, 1, 'the measurement is placed instead')
  const [marker] = markers
  assert.equal(marker.tag, 'span', 'an HTML marker, so the non-uniform viewBox cannot squash it')
  assert.equal(marker.props['data-series'], 'output', 'it carries its own series')
  assert.equal(marker.props['data-attempt'], 'a')
  assert.equal(marker.props['data-tps'], '500', 'and the measurement it stands for')
  assert.equal(marker.props['aria-hidden'], 'true', 'decorative: the panel label is the description')
  assert.match(marker.props.style.left, /^[\d.]+%$/)
  assert.match(marker.props.style.top, /^[\d.]+%$/)

  /**
   * The marker is not a vertex. `data-points` is the quantity the chart-wide render budget
   * bounds, so counting markers there would make the bound unmeasurable.
   */
  const plot = byClass(panel, 'dsh-tpm-plot')[0]
  assert.equal(plot.props['data-points'], 0)
  assert.equal(plot.props['data-markers'], 1)
  assert.equal(byClass(panel, 'dsh-tpm-plot-empty').length, 0,
    'a chart with a marker has something to show and must not claim the curve is unavailable')
})

test('a singleton reasoning run and a singleton output run are told apart by series and tone', () => {
  const curve = singletonCurve({
    reasoning: [singletonRun('r', 0, 120)],
    output: [singletonRun('o', 4000, 640)],
  })
  const panel = layer(cardWith(curve, COMPLETED_VIEW_CURVE), 'curve')
  const markers = byClass(panel, 'dsh-tpm-singleton-dot')
  assert.equal(markers.length, 2, 'both phases are placed')
  assert.deepEqual(markers.map(marker => marker.props['data-series']), ['reasoning', 'output'],
    'phase order is fixed, as the legend order is')
  assert.deepEqual(markers.map(marker => marker.props['data-tps']), ['120', '640'])
  assert.deepEqual(markers.map(marker => marker.props.style.left).length, 2)
  /** The tone channel the legend already uses, so colour is available without being the only one. */
  assert.ok(COMPLETED_CSS.includes('.dsh-tpm-singleton-dot[data-series="output"]'),
    'the output marker has its own tone rule')
  assert.ok(COMPLETED_CSS.includes('.dsh-tpm-singleton-dot'),
    'and the base rule colours the reasoning marker')
})

test('a singleton that is the turn peak coincides with the peak marker rather than displacing it', () => {
  const curve = singletonCurve({ output: [singletonRun('a', 0, 900)] })
  const panel = layer(cardWith(curve, COMPLETED_VIEW_CURVE), 'curve')
  const [marker] = byClass(panel, 'dsh-tpm-singleton-dot')
  const [dot] = byClass(panel, 'dsh-tpm-peak-dot')
  assert.ok(dot !== undefined, 'the peak is still marked: a rendering limit may not drop it')
  /**
   * The whole point of the singleton marker: the printed peak now has a position on the chart.
   * The two markers land on the same coordinate, which is the correct outcome and not a
   * duplication to be avoided.
   */
  assert.equal(marker.props.style.left, dot.props.style.left)
  assert.equal(marker.props.style.top, dot.props.style.top)
  assert.deepEqual(texts(byClass(panel, 'dsh-tpm-peak')[0]), ['peak', '≈900', 'tokens/s'])
})

test('several singleton runs of one phase are all placed, one marker each', () => {
  const curve = singletonCurve({
    output: [
      singletonRun('a', 0, 100),
      singletonRun('b', 0, 200),
      singletonRun('c', 6000, 300),
    ],
  })
  const panel = layer(cardWith(curve, COMPLETED_VIEW_CURVE), 'curve')
  const markers = byClass(panel, 'dsh-tpm-singleton-dot')
  assert.equal(markers.length, 3, 'every measurement gets a position, including two on one coordinate')
  assert.deepEqual(markers.map(marker => marker.props['data-attempt']), ['a', 'b', 'c'])
  assert.deepEqual(markers.map(marker => marker.props['data-tps']), ['100', '200', '300'])
  assert.equal(byClass(panel, 'dsh-tpm-plot')[0].props['data-points'], 0)
  assert.equal(byClass(panel, 'dsh-tpm-plot')[0].props['data-markers'], 3)
  assert.equal(byClass(panel, 'dsh-tpm-series').length, 0, 'still no fabricated segments')
})

/* -------------------------------------------------------------- focusability */

test('the card is a focus stop with a described hint exactly when a curve exists', () => {
  const handlers = {
    onEnter: () => {},
    onLeave: () => {},
    onFocus: () => {},
    onBlur: () => {},
  }
  const view = viewOf(settledCurve())
  const wired = completedTree(rec, view, en, { mode: COMPLETED_VIEW_SUMMARY, curveView: curveViewModel(view), ...handlers })
  const card = byClass(wired, 'dsh-tpm-card')[0]
  assert.equal(card.props.tabIndex, 0)
  assert.equal(card.props['aria-description'], 'Hover or focus for the throughput curve')
  assert.equal(card.props.role, 'group')
  assert.equal(card.props.onMouseEnter, handlers.onEnter)
  assert.equal(card.props.onMouseLeave, handlers.onLeave)
  assert.equal(card.props.onFocus, handlers.onFocus)
  assert.equal(card.props.onBlur, handlers.onBlur)

  /**
   * The tree attaches only the handlers it was given: a card whose owner passed
   * none must not emit `onMouseEnter={undefined}` props.
   */
  const unwired = byClass(cardWith(settledCurve(), COMPLETED_VIEW_SUMMARY), 'dsh-tpm-card')[0]
  assert.equal(unwired.props.tabIndex, 0, 'still focusable: the curve exists')
  assert.equal('onMouseEnter' in unwired.props, false)

  const inert = byClass(cardWith(null, COMPLETED_VIEW_SUMMARY), 'dsh-tpm-card')[0]
  assert.equal('tabIndex' in inert.props, false)
  assert.equal('onMouseEnter' in inert.props, false)
  assert.equal('aria-description' in inert.props, false)
})

test('the card keeps a focus ring rule instead of removing the outline', async () => {
  assert.ok(COMPLETED_CSS.includes('.dsh-tpm-card:focus-visible'), 'the ring is on focus-visible only')
  assert.ok(COMPLETED_CSS.includes('outline: 2px solid'), 'a real outline, not a border swap')
  assert.equal(/outline:\s*none/.test(COMPLETED_CSS), false, 'the outline is replaced, never removed')
  assert.equal(/outline:\s*0(?!\.)/.test(COMPLETED_CSS), false)
})

test('reduced motion removes the cross-fade without removing the switch', async () => {
  const { BASE_CSS } = await import('../src/client/base-css.js')
  assert.ok(BASE_CSS.includes('@media (prefers-reduced-motion: reduce)'))
  assert.ok(BASE_CSS.includes('transition: none !important'), 'the fade is cancelled')
  assert.equal(BASE_CSS.includes('opacity: 0 !important'), false, 'the hidden layer is still hidden, not faded')
})

test('the completed card owns no timer at any mode', async () => {
  const { readFile } = await import('node:fs/promises')
  const meter = await readFile(new URL('../src/client/completed/CompletedMeter.js', import.meta.url), 'utf8')
  for (const forbidden of ['setInterval', 'setTimeout', 'requestAnimationFrame']) {
    assert.equal(meter.includes(forbidden), false, `a settled card must not arm ${forbidden}`)
  }
  const tree = await readFile(new URL('../src/client/completed/completed-tree.js', import.meta.url), 'utf8')
  for (const forbidden of ['setInterval', 'setTimeout', 'requestAnimationFrame', 'Date.now']) {
    assert.equal(tree.includes(forbidden), false)
  }
})

test('both locales carry every string the alternate view prints', () => {
  const curve = layer(cardWith(settledCurve(), COMPLETED_VIEW_CURVE, zh), 'curve')
  const text = texts(curve).join(' | ')
  assert.equal(text.includes('思考'), true)
  assert.equal(text.includes('输出'), true)
  assert.equal(text.includes('峰值'), true)
  for (const key of ['curveLabel', 'curveHint', 'curveUnavailable', 'peak']) {
    assert.equal(typeof LOCALE_DICTS.en[key], 'string', `en:${key}`)
    assert.equal(typeof LOCALE_DICTS.zh[key], 'string', `zh:${key}`)
  }
  const card = cardWith(settledCurve(), COMPLETED_VIEW_CURVE, zh)
  assert.equal(byClass(card, 'dsh-tpm-card')[0].props['aria-description'], '悬停或聚焦查看吞吐曲线')
})
