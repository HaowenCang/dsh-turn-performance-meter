/**
 * Completed card structure, accessibility and the "no chart, no timer" contract.
 *
 * The card is exercised through `completed-tree.js` with a recording
 * `createElement`, so these assertions are about the element tree the browser
 * would receive: element names, class names, attributes, visible text and
 * accessible names. No DOM, no React runtime, no screenshot.
 *
 * Phase 9 added a second, outer presentation decision, and the file is organised
 * around it: the collapsed row is asserted to be *structurally* one row — the
 * detail, its four metric groups and the footer must not exist in the tree at
 * all, not merely be invisible — and the expanded card is asserted to be the
 * Phase 5 card, unchanged, one click below.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { completedViewModel } from '../src/client/ui-model.js'
import { compactSummary } from '../src/client/completed/compact-summary.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { COMPLETED_CSS, COMPLETED_STYLE_ID } from '../src/client/completed/completed-css.js'
import { LIVE_CSS } from '../src/client/live/live-css.js'
import { BASE_CSS } from '../src/client/base-css.js'
import { LOCALE_DICTS } from '../src/client/live/locale.js'
import { DASH } from '../src/client/format.js'
import { MetricQuality } from '../src/core/metric-quality.js'
import { QualityLevel } from '../src/core/quality-model.js'
import { loadFixture } from './helpers/fixtures.js'
import { durableSettledView } from './helpers/equivalence.js'
import { byClass, cardOfSettled, cardOfView, layer, one, tagsOf, texts } from './helpers/completed-tree.js'

const en = key => LOCALE_DICTS.en[key] ?? key
const zh = key => LOCALE_DICTS.zh[key] ?? key

function quality(tokenTotalQuality, phaseSplitQuality) {
  return {
    tokenTotalQuality,
    phaseSplitQuality,
    temporalShapeQuality: QualityLevel.RECONSTRUCTED,
    displayTokenTotal: tokenTotalQuality === QualityLevel.EXACT ? 'exact' : 'approximate',
    displayPhaseSplit: phaseSplitQuality === QualityLevel.EXACT ? 'exact' : 'approximate',
    notes: [],
  }
}

function settled(overrides = {}) {
  return {
    sessionId: 'session-1',
    turn: 12,
    status: 'completed',
    statusNote: null,
    reasoningTps: 345.123,
    reasoningTpsQuality: MetricQuality.EXACT,
    reasoningMs: 108_200,
    outputTps: 676.4,
    outputTpsQuality: MetricQuality.EXACT,
    outputMs: 25_400,
    phaseTokens: { reasoning: 37_498, output: 17_272 },
    generatedTokens: 54_770,
    observedGeneratedTokens: 54_770,
    turnElapsedMs: 133_600,
    ttftMs: 1440,
    attemptCount: 4,
    tools: { count: 4, completedCount: 4, workMs: 12_800, wallMs: 12_800, failedCount: 0, names: ['pwsh'] },
    quality: quality(QualityLevel.EXACT, QualityLevel.EXACT),
    consistencyIssues: [],
    ...overrides,
  }
}

/**
 * Build the card from a settled snapshot. The detail is on screen by default:
 * `{ collapsed: true }` builds the compact row instead.
 */
const cardOf = (settledSnapshot, translate = en, interaction = {}) => (
  cardOfSettled(settledSnapshot, completedViewModel, translate, interaction)
)

/** The default card with the detail revealed — the shape the Phase 5 tests describe. */
const expanded = (settledSnapshot, translate = en) => cardOf(settledSnapshot, translate)

/** The default card as a settled turn actually arrives: collapsed. */
const collapsed = (settledSnapshot, translate = en) => (
  cardOfSettled(settledSnapshot, completedViewModel, translate, { collapsed: true })
)

/** The header button of a card. */
const headerOf = tree => one(tree, 'dsh-tpm-card-header')

/** `curveViewModel` is a pure shaping step, so these tests call it directly. */
const curveViewOf = view => curveViewModel(view)

/* ------------------------------------------------------- collapsed structure */

test('a settled card is collapsed by default: one header row and no detail at all', () => {
  const tree = collapsed(settled())

  assert.equal(tree.props['data-kind'], 'completed')
  assert.equal(tree.props['data-collapsed'], 'true')
  /**
   * `data-view` keeps its Phase 5 meaning. A collapsed card is still showing the
   * summary — it is showing less of it — so the attribute must not be overloaded
   * with a third value.
   */
  assert.equal(tree.props['data-view'], 'summary')

  const header = headerOf(tree)
  assert.equal(header.tag, 'button', 'the whole row is the control')
  assert.equal(header.props.type, 'button')
  assert.equal(header.props['aria-expanded'], 'false')
  assert.equal(byClass(tree, 'dsh-tpm-card-header').length, 1, 'exactly one toggle')

  /**
   * The point of the round. `opacity: 0` or `visibility: hidden` would keep the
   * detail's height above the composer, which is the cost the collapse exists to
   * remove, and would also leave four metric groups in the accessibility tree of
   * a row that shows one line.
   */
  assert.equal(byClass(tree, 'dsh-tpm-detail').length, 0, 'the detail is not rendered')
  assert.equal(byClass(tree, 'dsh-tpm-cells').length, 0, 'no metric cells')
  assert.equal(byClass(tree, 'dsh-tpm-cell').length, 0)
  assert.equal(byClass(tree, 'dsh-tpm-foot').length, 0, 'no footer')
  assert.equal(byClass(tree, 'dsh-tpm-view').length, 0, 'no view layer')
  assert.equal(byClass(tree, 'dsh-tpm-plot-svg').length, 0)
  /**
   * The only SVG left is the two decorative header glyphs, so the check is on where
   * `path` may appear rather than on whether it exists. Everything the *chart* is
   * made of — the plot, a series, a marker, the spanning curve panel — must be
   * absent, because a collapsed row that still built one would pay the cost for
   * nothing.
   */
  assert.deepEqual(byClass(tree, 'dsh-tpm-plot'), [])
  assert.deepEqual(byClass(tree, 'dsh-tpm-series'), [])
  assert.deepEqual(byClass(tree, 'dsh-tpm-peak-dot'), [])
  assert.deepEqual(byClass(tree, 'dsh-tpm-curve-panel'), [])
  assert.deepEqual(tagsOf(one(tree, 'dsh-tpm-card-body')).has('canvas'), false)
})

test('the collapsed header is lead, title, one-line summary and chevron', () => {
  const header = headerOf(collapsed(settled()))
  const children = header.children.filter(child => child !== null && child !== undefined)
  assert.deepEqual(children.map(child => child.props.className),
    ['dsh-tpm-card-lead', 'dsh-tpm-card-title', 'dsh-tpm-card-progress', 'dsh-tpm-card-chevron'],
    'the host TodoPanel row order')

  assert.equal(texts(one(header, 'dsh-tpm-card-title'))[0], 'Performance',
    'the short visible title, not the 21-character accessible name')
  assert.equal(byClass(header, 'dsh-tpm-card-lead').length, 1)

  /** Both decorative glyphs are outside the accessibility tree. */
  const glyphs = byClass(header, 'dsh-tpm-card-lead')[0].children
    .concat(byClass(header, 'dsh-tpm-card-chevron')[0].children)
  assert.equal(glyphs.length, 2, 'the lead SVG and the chevron SVG')
  for (const glyph of glyphs) {
    assert.equal(glyph.tag, 'svg')
    assert.equal(glyph.props['aria-hidden'], 'true', 'a decorative glyph must not be announced')
    assert.equal(glyph.props.focusable, 'false')
    assert.equal(glyph.props.width, '16')
    assert.equal(glyph.props.height, '16')
  }
  for (const wrapper of byClass(header, 'dsh-tpm-card-lead').concat(byClass(header, 'dsh-tpm-card-chevron'))) {
    assert.equal(wrapper.props['aria-hidden'], 'true')
  }
})

test('the chevron points the way the host points it: up while collapsed, down while expanded', () => {
  /**
   * DSH's TodoPanel shows `ChevronUp` collapsed and `ChevronDown` expanded. The
   * conventional pairing is the reverse, so this is asserted rather than assumed:
   * a later reader "fixing" the direction would otherwise break the host contract
   * silently.
   */
  const pathOf = tree => byClass(headerOf(tree), 'dsh-tpm-card-chevron')[0].children[0].children[0].props.d
  const up = pathOf(collapsed(settled()))
  const down = pathOf(expanded(settled()))
  assert.notEqual(up, down)
  assert.equal(up, 'M4 9.8 8 5.8l4 4', 'an upward chevron while collapsed')
  assert.equal(down, 'M4 6.2 8 10.2l4-4', 'a downward chevron while expanded')
})

/* ------------------------------------------------------- expanded structure */

test('expanding reveals the Phase 5 card unchanged, one click below the header', () => {
  const tree = expanded(settled())
  assert.equal(tree.props['data-collapsed'], 'false')
  assert.equal(headerOf(tree).props['aria-expanded'], 'true')

  const detail = one(tree, 'dsh-tpm-detail')
  assert.ok(detail !== undefined, 'the detail exists')
  assert.equal(byClass(tree, 'dsh-tpm-cells').length, 1,
    'one cells container: this turn carries no curve, so there is no second layer')
  assert.equal(byClass(tree, 'dsh-tpm-foot').length, 1)

  const summaryCells = one(layer(tree, 'summary'), 'dsh-tpm-cells').children
  assert.equal(summaryCells.length, 4, 'four metric cells')
  assert.deepEqual(summaryCells.map(cell => cell.props['data-metric']),
    ['reasoningTps', 'outputTps', 'generatedTokens', 'ttft'])
})

test('the card is one group with a turn-scoped accessible name and no live region', () => {
  const tree = expanded(settled())
  assert.equal(tree.tag, 'div')
  assert.equal(tree.props['data-kind'], 'completed')
  assert.equal(tree.props['data-status'], 'completed')
  assert.equal(tree.props['data-turn'], 12)
  assert.equal(tree.props['data-session'], 'session-1')
  /**
   * The name moved from the card to the header button when the card stopped being
   * the interactive surface, and the card kept it as its group name. Both are
   * asserted because a reader must not meet two differently-worded names for one
   * region.
   */
  const card = one(tree, 'dsh-tpm-card')
  assert.equal(card.props.role, 'group')
  assert.equal(card.props['aria-label'], 'Turn performance summary · turn 12 · completed')
  assert.equal(headerOf(tree).props['aria-label'], card.props['aria-label'])
  assert.equal('aria-live' in tree.props, false, 'a static card must not be a live region')
  assert.equal('aria-atomic' in tree.props, false)
  assert.equal('aria-live' in card.props, false)
})

test('the card has exactly one summary cells container holding four labelled cells in order', () => {
  const tree = expanded(settled())
  const cells = one(layer(tree, 'summary'), 'dsh-tpm-cells').children
  assert.equal(cells.length, 4)
  assert.deepEqual(cells.map(cell => cell.props['data-metric']),
    ['reasoningTps', 'outputTps', 'generatedTokens', 'ttft'])
  for (const cell of cells) {
    assert.equal(cell.props.role, 'group')
    assert.equal(cell.children.length, 3, 'label, value and secondary line')
  }
})

test('each cell labels its own value so four numbers are never unlabelled', () => {
  const tree = expanded(settled())
  const cells = one(layer(tree, 'summary'), 'dsh-tpm-cells').children
  assert.equal(texts(cells[0].children[0])[0], 'Reasoning TPS')
  assert.equal(texts(cells[1].children[0])[0], 'Output TPS')
  assert.equal(texts(cells[2].children[0])[0], 'Generated Tokens')
  assert.equal(texts(cells[3].children[0])[0], 'TTFT')
  assert.equal(cells[0].props['aria-label'], 'Reasoning TPS, 345 tokens/s, 108.2s · 37,498')
  assert.equal(cells[3].props['aria-label'], 'TTFT, 1.44 s, completed')
})

test('the visible number and its unit are separate elements, with the unit suppressed when absent', () => {
  const tree = expanded(settled())
  const cells = one(layer(tree, 'summary'), 'dsh-tpm-cells').children
  const value = cells[0].children[1]
  assert.equal(texts(value.children[0])[0], '345')
  assert.equal(texts(value.children[1])[0], 'tokens/s')

  const noRate = expanded(settled({ reasoningTps: null, reasoningTpsQuality: MetricQuality.UNAVAILABLE, reasoningMs: 0, phaseTokens: { reasoning: null, output: 17_272 } }))
  const dashValue = one(layer(noRate, 'summary'), 'dsh-tpm-cells').children[0].children[1]
  assert.equal(texts(dashValue.children[0])[0], '—')
  assert.equal(dashValue.children[1], undefined, 'no unit follows an absent value')
})

test('the approximate marker is visible text and is also a data attribute for diagnostics', () => {
  const approximated = expanded(settled({
    quality: quality(QualityLevel.EXACT, QualityLevel.ESTIMATED),
    reasoningTpsQuality: MetricQuality.CALIBRATED,
    phaseTokens: { reasoning: 37_498, output: 17_272 },
  }))
  const cell = one(layer(approximated, 'summary'), 'dsh-tpm-cells').children[0]
  assert.equal(cell.props['data-approximate'], 'true')
  assert.equal(texts(cell.children[1].children[0])[0], '≈345')
  assert.equal(texts(cell.children[2])[0], '108.2s · ≈37,498', 'the same chain carries ≈ on the count too')
})

test('the status is real text, not only a colour, and its tone is a data attribute', () => {
  for (const [status, note, expected, tone] of [
    ['completed', null, 'completed', 'neutral'],
    ['interrupted', 'cancelled (user)', 'interrupted · cancelled (user)', 'warn'],
    ['errored', 'RATE_LIMIT', 'errored · RATE_LIMIT', 'error'],
    ['completed', 'max-tokens', 'token limit reached', 'warn'],
  ]) {
    const tree = expanded(settled({ status, statusNote: note }))
    const ttftCell = one(layer(tree, 'summary'), 'dsh-tpm-cells').children[3]
    const sub = ttftCell.children[2]
    assert.equal(texts(sub)[0], expected, `${status}/${note} must appear as text`)
    assert.equal(sub.props['data-tone'], tone)
    assert.equal(tree.props['data-status'], status === 'completed' && note === 'max-tokens' ? 'max-tokens' : status)
    assert.ok(texts(tree).includes(expected), 'the status is inside the rendered text')
  }
})

test('the footer carries tools and status, and hides the tool item when there were none', () => {
  const withTools = expanded(settled())
  assert.deepEqual(texts(one(withTools, 'dsh-tpm-foot')), ['tools 4 · 12.8s', 'attempts 4', 'completed'])

  const noTools = expanded(settled({ tools: { count: 0, wallMs: 0, workMs: 0, names: [] } }))
  const emptyFoot = one(noTools, 'dsh-tpm-foot')
  assert.deepEqual(texts(emptyFoot), ['attempts 4', 'completed'], 'no tool item at all when there were no tools')
  assert.equal(texts(emptyFoot).some(text => text.includes('0')), false)
})

test('the footer never prints the tool work sum where the wall union belongs', () => {
  const parallel = expanded(settled({
    tools: { count: 3, completedCount: 3, workMs: 4200, wallMs: 2600, failedCount: 0, names: ['read', 'grep'] },
  }))
  const foot = one(parallel, 'dsh-tpm-foot')
  assert.equal(texts(foot)[0], 'tools 3 · 2.6s', 'the wall union is what the card shows')
  assert.equal(texts(foot)[0].includes('4.2s'), false, 'the summed work must not leak into the compact line')
})

/* ----------------------------------------------------------- compact summary */

test('the collapsed row is one line carrying the status and all four readings', () => {
  const line = texts(one(collapsed(settled()), 'dsh-tpm-card-progress')).join('')
  assert.equal(line,
    'completed · thinking 345 tokens/s · output 676 tokens/s · 54,770 tokens · TTFT 1.44 s')
  assert.equal(texts(one(collapsed(settled()), 'dsh-tpm-card-title'))[0], 'Performance')
})

test('the compact line reuses the detail displays rather than re-deriving them', () => {
  /**
   * The single most important property of the compact row: it is a *selection* of
   * already-formatted strings, not a second formatter. Building the expectation
   * out of `view.columns` means a re-derivation that happens to agree today still
   * fails the day the two disagree — and the assertion names which one it is.
   */
  const cases = [
    settled(),
    settled({ quality: quality(QualityLevel.EXACT, QualityLevel.ESTIMATED), reasoningTpsQuality: MetricQuality.CALIBRATED }),
    settled({ quality: quality(QualityLevel.ESTIMATED, QualityLevel.UNAVAILABLE), generatedTokens: null, observedGeneratedTokens: 12_345 }),
    settled({ ttftMs: null, reasoningTps: null, reasoningTpsQuality: MetricQuality.UNAVAILABLE, outputTps: null, outputTpsQuality: MetricQuality.UNAVAILABLE }),
    settled({ status: 'interrupted', statusNote: 'cancelled (user)' }),
  ]
  for (const snapshot of cases) {
    const view = completedViewModel(snapshot)
    const [reasoning, output, tokens, ttft] = view.columns
    const reading = column => (column.unit === null ? column.display : `${column.display} ${column.unit}`)
    const expected = [
      en(`status.${view.status}`),
      `${en('thinking')} ${reading(reasoning)}`,
      `${en('output')} ${reading(output)}`,
      reading(tokens),
      `${en('colTtft')} ${reading(ttft)}`,
    ].join(' · ')
    assert.equal(compactSummary(view, en), expected)
    /** The same string is what the collapsed row actually renders. */
    assert.equal(texts(one(cardOfSettled(snapshot, completedViewModel, en, { collapsed: true }), 'dsh-tpm-card-progress')).join(''), expected)
  }
})

test('an unavailable reading is the em dash on the compact line, never a zero', () => {
  const view = completedViewModel(settled({
    reasoningTps: null,
    reasoningTpsQuality: MetricQuality.UNAVAILABLE,
    reasoningMs: 0,
    outputTps: null,
    outputTpsQuality: MetricQuality.UNAVAILABLE,
    outputMs: 0,
    phaseTokens: { reasoning: null, output: null },
    generatedTokens: null,
    observedGeneratedTokens: 0,
    ttftMs: null,
  }))
  const line = compactSummary(view, en)
  assert.equal(line, `completed · thinking ${DASH} · output ${DASH} · ${DASH} · TTFT ${DASH}`)
  assert.equal(/\b0\b/.test(line), false, 'no reading became a fabricated zero')
  /** A dash never grows a unit, so `— tokens` cannot be misread as "no tokens". */
  assert.equal(line.includes(`${DASH} tokens`), false)
  assert.equal(line.includes(`${DASH} s`), false)
  assert.equal(line.includes(`${DASH} tokens/s`), false)
})

test('the compact line states the real settlement status for every outcome', () => {
  for (const [status, note, expected] of [
    ['completed', null, 'completed'],
    ['interrupted', null, 'interrupted'],
    ['interrupted', 'cancelled (user)', 'interrupted'],
    ['errored', 'RATE_LIMIT', 'errored'],
    ['completed', 'max-tokens', 'token limit reached'],
  ]) {
    const tree = collapsed(settled({ status, statusNote: note }))
    const line = texts(one(tree, 'dsh-tpm-card-progress')).join('')
    assert.equal(line.startsWith(`${expected} · `), true, `${status}/${note} -> ${line}`)
    /** The status word also ends the button's name, so it is never colour-only. */
    assert.equal(headerOf(tree).props['aria-label'].endsWith(expected), true)
  }
  const chinese = texts(one(collapsed(settled({ status: 'errored', statusNote: null }), zh), 'dsh-tpm-card-progress')).join('')
  assert.equal(chinese.startsWith('出错 · '), true)
})

/* ------------------------------------------------------------- accessibility */

/** A settled curve with two drawable series, as `telemetry-design.js` shapes one. */
function settledCurve(overrides = {}) {
  return {
    durationMs: 20_000,
    segments: [{ attemptId: 'a', startMs: 0, endMs: 20_000 }],
    reasoning: [
      { timeMs: 0, tps: 0 },
      { timeMs: 5000, tps: 300 },
      { timeMs: 10_000, tps: 320 },
    ],
    output: [
      { timeMs: 10_000, tps: 0 },
      { timeMs: 14_000, tps: 600 },
      { timeMs: 20_000, tps: 900 },
    ],
    peakTps: 900,
    phaseSpans: { reasoning: { startMs: 0, endMs: 10_000 }, output: { startMs: 10_000, endMs: 20_000 } },
    quality: 'estimated',
    sampleEveryMs: 250,
    windowMs: 1000,
    ...overrides,
  }
}

test('the detail is a focus stop with a described hint exactly when a curve exists', () => {
  const handlers = {
    onEnter: () => {},
    onLeave: () => {},
    onFocus: () => {},
    onBlur: () => {},
  }
  const view = completedViewModel(settled({ curve: settledCurve() }))
  const wired = cardOfView(view, en, { mode: 'summary', curveView: curveViewOf(view), ...handlers })
  const detail = one(wired, 'dsh-tpm-detail')
  assert.equal(detail.props.tabIndex, 0)
  assert.equal(detail.props['aria-description'], 'Hover or focus for the throughput curve')
  assert.equal(detail.props.onMouseEnter, handlers.onEnter)
  assert.equal(detail.props.onMouseLeave, handlers.onLeave)
  assert.equal(detail.props.onFocus, handlers.onFocus)
  assert.equal(detail.props.onBlur, handlers.onBlur)

  /**
   * The curve lives on the detail, never on the card or the header. A reader who
   * tabs onto the expand/collapse button must not have the chart appear under
   * them, so neither of those two elements may carry a handler or a focus stop.
   */
  const card = one(wired, 'dsh-tpm-card')
  const header = headerOf(wired)
  for (const element of [card, header]) {
    for (const prop of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur']) {
      assert.equal(prop in element.props, false, `${prop} must not be on ${element.props.className}`)
    }
  }
  assert.equal('tabIndex' in card.props, false)
  assert.equal('tabIndex' in header.props, false, 'the button is focusable natively, not by tabindex')

  /**
   * The tree attaches only the handlers it was given: a detail whose owner passed
   * none must not emit `onMouseEnter={undefined}` props.
   */
  const unwired = one(cardOfView(view, en, { curveView: curveViewOf(view) }), 'dsh-tpm-detail')
  assert.equal(unwired.props.tabIndex, 0, 'still focusable: the curve exists')
  assert.equal('onMouseEnter' in unwired.props, false)

  const inert = one(cardOf(settled()), 'dsh-tpm-detail')
  assert.equal('tabIndex' in inert.props, false)
  assert.equal('onMouseEnter' in inert.props, false)
  assert.equal('aria-description' in inert.props, false)
})

test('a collapsed card exposes no focus stop below the header', () => {
  const view = completedViewModel(settled({ curve: settledCurve() }))
  const tree = cardOfView(view, en, { collapsed: true, curveView: curveViewOf(view) })
  assert.equal(byClass(tree, 'dsh-tpm-detail').length, 0, 'nothing focusable is rendered below the row')
  assert.deepEqual(byClass(tree, 'dsh-tpm-card-header').map(el => el.props.tabIndex), [undefined],
    'the toggle is the only stop, and it is natively focusable')
})

/* ------------------------------------------------------------------ styling */

test('the summary layer renders no chart, even when the turn carries curve data', () => {
  /**
   * Phase 4's invariant is preserved *per layer*: the summary is the default
   * view and never contains a chart. The curve is a separate layer that only the
   * interaction can reveal.
   */
  const tree = expanded(settled({ curve: settledCurve() }))
  const summary = layer(tree, 'summary')
  assert.equal(summary.props['data-visible'], 'true')
  const summaryTags = tagsOf(summary)
  for (const forbidden of ['svg', 'canvas', 'polyline', 'path', 'circle']) {
    assert.equal(summaryTags.has(forbidden), false, `the summary must not render a ${forbidden} element`)
  }
  assert.equal(JSON.stringify(summary).includes('900'), false, 'the peak value is not in the summary')
})

test('with no curve the detail is inert: no chart, no focus stop, no handler', () => {
  const tree = expanded(settled())
  assert.equal(byClass(tree, 'dsh-tpm-view').length, 1, 'only the summary layer exists')
  const detail = one(tree, 'dsh-tpm-detail')
  assert.equal('tabIndex' in detail.props, false, 'a detail with nothing behind hover is not a focus stop')
  assert.equal('onMouseEnter' in detail.props, false)
  assert.equal('onFocus' in detail.props, false)
  /** No path, plot or panel anywhere inside the detail; the header glyphs are outside it. */
  assert.deepEqual(byClass(detail, 'dsh-tpm-plot-svg'), [])
  assert.deepEqual(byClass(detail, 'dsh-tpm-series'), [])
  assert.equal(tagsOf(detail).has('path'), false, 'the detail draws nothing at all')
})

test('the completed surface is the host TodoPanel contract, not a measured one', () => {
  const surface = COMPLETED_CSS.slice(COMPLETED_CSS.indexOf('.dsh-tpm-card {'), COMPLETED_CSS.indexOf('.dsh-tpm-card-body'))
  for (const token of [
    'border-radius: var(--dsw-radius-lg)',
    'background: var(--dsw-specific-menu)',
    'backdrop-filter: var(--dsw-menu-backdrop-filter)',
    'box-shadow: var(--dsw-elevation-panel)',
    '--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)',
    'border: 0',
    'overflow: hidden',
  ]) {
    assert.ok(surface.includes(token), `the card surface declares ${token}`)
  }
  /** The earlier self-chosen surface decisions are gone, not merely overridden later. */
  assert.equal(/border-radius:\s*10px/.test(COMPLETED_CSS), false, 'no hand-chosen radius on the card')
  assert.equal(COMPLETED_CSS.includes('background: var(--dsh-tpm-surface)'), false,
    'the completed card no longer uses the plugin-local surface token')
  assert.equal(/border:\s*\.5px solid/.test(surface), false, 'no hand-drawn outer card stroke')
  assert.equal(COMPLETED_CSS.includes('#f8f7f5'), false, 'no sampled hex survived')

  /**
   * The live pill keeps its own Phase 5 surface. It is a different row with a
   * different reference and this round does not touch it, which is exactly why the
   * prohibitions above are scoped to the card selector rather than the sheet.
   */
  assert.ok(LIVE_CSS.includes('.dsh-tpm-pill'), 'the live pill sheet is unchanged')
  assert.ok(LIVE_CSS.includes('background: var(--dsh-tpm-surface)'), 'and keeps the plugin surface')
  assert.ok(LIVE_CSS.includes('border-radius: 10px'), 'and keeps its own radius')
  assert.ok(BASE_CSS.includes('--dsh-tpm-surface:'), 'the token still exists for the pill')
})

test('the completed root reuses the host dock width formula and nothing else does', () => {
  const rootBlock = COMPLETED_CSS.slice(
    COMPLETED_CSS.indexOf('.dsh-tpm-root[data-kind="completed"] {'),
    COMPLETED_CSS.indexOf('.dsh-tpm-card {'),
  )
  for (const token of [
    'var(--dsh-composer-side-clearance)',
    'var(--dsh-composer-dock-inset)',
    'var(--dsh-composer-card-max-width)',
  ]) {
    assert.ok(rootBlock.includes(token), `the completed root resolves ${token}`)
  }
  /** The host's own shape: two clearances, four insets for the width, four for the floor. */
  assert.equal((rootBlock.match(/var\(--dsh-composer-side-clearance\)/g) ?? []).length, 2)
  assert.equal((rootBlock.match(/var\(--dsh-composer-dock-inset\)/g) ?? []).length, 8,
    'four insets in the width and four in the max-width')
  assert.ok(rootBlock.includes('margin: 0 auto'), 'centred exactly as the host centres its panel')

  /** The live pill's width contract is untouched. */
  assert.equal(/dsh-composer-side-clearance/.test(LIVE_CSS), false)
  assert.equal(/dsh-composer-dock-inset/.test(LIVE_CSS), false)
  assert.ok(LIVE_CSS.includes('max-width: min(100%, var(--dsh-composer-card-max-width, 100%))'),
    'the pill keeps its own max-width form, fallback included')
})

test('the collapsed row cannot wrap and cannot push the chevron out', () => {
  const progress = COMPLETED_CSS.slice(
    COMPLETED_CSS.indexOf('.dsh-tpm-card-progress {'),
    COMPLETED_CSS.indexOf('.dsh-tpm-card-chevron {'),
  )
  for (const declaration of [
    'flex: auto',
    'min-width: 0',
    'overflow: hidden',
    'text-overflow: ellipsis',
    'white-space: nowrap',
  ]) {
    assert.ok(progress.includes(declaration), `the progress line declares ${declaration}`)
  }
  /** Title and chevron are rigid, so the summary is what yields at a narrow width. */
  for (const selector of ['.dsh-tpm-card-title {', '.dsh-tpm-card-chevron {', '.dsh-tpm-card-lead {']) {
    const start = COMPLETED_CSS.indexOf(selector)
    const block = COMPLETED_CSS.slice(start, COMPLETED_CSS.indexOf('}', start))
    assert.ok(block.includes('flex: none'), `${selector} must not shrink away`)
  }
  assert.ok(COMPLETED_CSS.includes('@media (max-width: 34rem)'), 'the two-column wrap is retained')
  const media = COMPLETED_CSS.slice(COMPLETED_CSS.indexOf('@media (max-width: 34rem)'))
  assert.ok(media.includes('repeat(2, minmax(0, 1fr))'), 'four columns become two')
})

test('the header and detail carry a real focus ring and never remove the outline', () => {
  for (const selector of ['.dsh-tpm-card-header:focus-visible {', '.dsh-tpm-detail:focus-visible {']) {
    assert.ok(COMPLETED_CSS.includes(selector), `${selector} is styled`)
  }
  assert.ok(COMPLETED_CSS.includes('outline: 2px solid'), 'a real outline, not a border swap')
  assert.equal(/outline:\s*none/.test(COMPLETED_CSS), false, 'the outline is replaced, never removed')
  assert.equal(/outline:\s*0(?!\.)/.test(COMPLETED_CSS), false)
  /**
   * The header button resets its own chrome, so the one rule that could have
   * removed the ring is a bare `:focus` rule; there is none.
   */
  assert.equal(/\.dsh-tpm-card-header:focus\s*\{/.test(COMPLETED_CSS), false)
})

test('reduced motion removes the cross-fade without removing the switch', () => {
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
  for (const file of ['completed-tree.js', 'view-mode.js', 'compact-summary.js']) {
    const source = await readFile(new URL(`../src/client/completed/${file}`, import.meta.url), 'utf8')
    for (const forbidden of ['setInterval', 'setTimeout', 'requestAnimationFrame', 'Date.now']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`)
    }
  }
})

/* -------------------------------------------------------------- stylesheet */

test('every compact string comes from the locale namespace in both languages', () => {
  const english = texts(collapsed(settled())).join(' | ')
  const chinese = texts(collapsed(settled(), zh)).join(' | ')
  assert.equal(english.includes('Performance'), true)
  assert.equal(chinese.includes('性能'), true)
  assert.equal(chinese.includes('已完成'), true)
  assert.equal(chinese.includes('思考'), true)
  assert.equal(chinese.includes('输出'), true)
  /** The visible title must not be the long accessible name. */
  assert.equal(english.includes('Turn performance summary ·'), false)
  assert.equal(LOCALE_DICTS.en.performanceTitle, 'Performance')
  assert.equal(LOCALE_DICTS.zh.performanceTitle, '性能')

  const chineseInterrupted = texts(collapsed(settled({ status: 'interrupted', statusNote: null }), zh)).join(' | ')
  assert.equal(chineseInterrupted.includes('已中断'), true)
})

test('every visible string comes from the locale namespace in both languages', () => {
  const english = texts(expanded(settled())).join(' | ')
  const chinese = texts(expanded(settled(), zh)).join(' | ')
  assert.equal(english.includes('Reasoning TPS'), true)
  assert.equal(chinese.includes('思考 TPS'), true)
  assert.equal(chinese.includes('生成 Tokens'), true)
  assert.equal(chinese.includes('已完成'), true)
  assert.equal(chinese.includes('总用时'), true)
  assert.equal(chinese.includes('工具'), true)

  const missing = []
  for (const key of ['performanceTitle', 'completedLabel', 'colReasoningTps', 'colOutputTps', 'colGeneratedTokens', 'colTtft',
    'elapsed', 'tools', 'attempts', 'unavailable', 'status.completed', 'status.interrupted',
    'status.errored', 'status.max-tokens']) {
    if (LOCALE_DICTS.en[key] === undefined) missing.push(`en:${key}`)
    if (LOCALE_DICTS.zh[key] === undefined) missing.push(`zh:${key}`)
  }
  assert.deepEqual(missing, [], 'every card string is translated in both locales')
})

test('the card stylesheet is scoped, responsive and theme-token driven', () => {
  /**
   * Phase 5 split the single stylesheet into a shared token block plus one sheet
   * per view. The scoping and theme obligations therefore have to be checked
   * across all three, not against the card sheet alone.
   */
  const sheets = `${BASE_CSS}\n${LIVE_CSS}\n${COMPLETED_CSS}`
  assert.ok(BASE_CSS.includes('.dsh-tpm-root'), 'the plugin is scoped under its own root class')
  assert.equal(/(^|\n)\s*(body|html|div|span|svg|\*)\s*[,{]/.test(sheets), false,
    'no global or element selector anywhere in the plugin CSS')
  assert.equal(/(^|\n)body\[data-ds-dark-theme\]\s+\.dsh-tpm-root\s*\{/.test(sheets), true,
    'the only bare-body selector is the documented dark-theme override')
  assert.ok(COMPLETED_CSS.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'), 'four fluid columns, no fixed width')
  assert.ok(COMPLETED_CSS.includes('repeat(2, minmax(0, 1fr))'), 'a two-column wrap exists for narrow widths')
  assert.equal(/\d+\.?\d*rem(?!;)/.test(COMPLETED_CSS.replace(/max-width: 34rem/, '')), false,
    'no hard-coded component width beyond the single breakpoint')
  assert.equal(COMPLETED_CSS.includes('44.25rem'), false)
  for (const token of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l1', '--dsw-alias-bg-module-platform']) {
    assert.ok(sheets.includes(token), `the plugin resolves ${token} from the host theme`)
  }
  /**
   * The completed surface follows the host theme by construction: it declares host
   * tokens only, so there is no completed light/dark hex to keep in sync and no
   * second rule that could disagree with the first. The `var(--token, fallback)`
   * pairs are stripped before the scan, because a fallback *is* the token contract:
   * it only ever resolves when the host failed to provide the token at all.
   */
  const withoutTokenFallbacks = COMPLETED_CSS.replace(/var\([^()]*(?:\([^()]*\))?[^()]*\)/g, 'var()')
  assert.equal(/\.dsh-tpm-card\s*\{[^}]*#[0-9a-fA-F]{3,8}/.test(withoutTokenFallbacks), false,
    'no theme-independent hex colour on the completed surface')
  assert.equal(/\.dsh-tpm-card\s*\{[^}]*rgba\(/.test(COMPLETED_CSS), false,
    'no rgba fallback on the completed surface')
  assert.ok(COMPLETED_CSS.includes('background: var(--dsw-specific-menu)'),
    'and the background is the host menu surface, resolved rather than approximated')
  assert.ok(BASE_CSS.includes('body[data-ds-dark-theme]'), 'the accent has a dark override')
  /**
   * `prefers-reduced-motion` legitimately resets both properties, so the
   * "nothing animates" obligation is checked after removing that block.
   */
  const withoutReducedMotion = sheets.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/, '')
  assert.equal(/animation:/.test(withoutReducedMotion), false, 'nothing in the plugin animates')
  assert.equal(/transition:(?!\s*opacity)/.test(withoutReducedMotion), false,
    'the only transition is the opacity cross-fade')
  assert.ok(COMPLETED_CSS.includes('transition: opacity 220ms ease'), 'the cross-fade is 220 ms')
  assert.ok(BASE_CSS.includes('prefers-reduced-motion'), 'reduced motion is honoured')
  assert.equal(COMPLETED_STYLE_ID, 'dsh-tpm-completed-style')
})

test('the plugin keeps exactly one style tag id for both views', async () => {
  const root = await import('node:fs/promises').then(fs => fs.readFile(
    new URL('../src/client/live/MeterRoot.js', import.meta.url), 'utf8'))
  assert.equal(root.includes('LIVE_STYLE_ID'), true)
  assert.equal(root.includes('COMPLETED_STYLE_ID'), false,
    'the card CSS is content, not a second tag: HMR cannot accumulate styles')
  assert.equal(root.includes('COMPLETED_CSS'), true)
})

test('a real fixture renders a collapsed row and a complete expanded card', () => {
  const view = completedViewModel(durableSettledView(loadFixture('t4-reasoning-tool-deepseek-official')).settled)

  const row = texts(one(cardOfView(view, en, { collapsed: true }), 'dsh-tpm-card-progress')).join('')
  assert.equal(row, 'completed · thinking ≈50.6 tokens/s · output 138 tokens/s · 151 tokens · TTFT 7.58 s')

  const tree = cardOfView(view, en)
  const cells = one(layer(tree, 'summary'), 'dsh-tpm-cells').children
  assert.equal(cells.length, 4)
  assert.deepEqual(cells.map(cell => texts(cell.children[0])[0]),
    ['Reasoning TPS', 'Output TPS', 'Generated Tokens', 'TTFT'])
  assert.deepEqual(cells.map(cell => texts(cell.children[1].children[0])[0]), ['≈50.6', '138', '151', '7.58'])
  assert.deepEqual(cells.map(cell => texts(cell.children[1].children[1])[0]), ['tokens/s', 'tokens/s', 'tokens', 's'])
  assert.deepEqual(cells.map(cell => cell.props['data-approximate']), ['true', 'false', 'false', 'false'],
    'the reasoning rate is estimated, the exact split and total are not')
  assert.equal(texts(one(tree, 'dsh-tpm-foot')).includes('tools 1 · 0.3s'), true)
})
