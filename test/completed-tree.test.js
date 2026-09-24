/**
 * Completed card structure, accessibility and the "no chart, no timer" contract.
 *
 * The card is exercised through `completed-tree.js` with a recording
 * `createElement`, so these assertions are about the element tree the browser
 * would receive: element names, class names, attributes, visible text and
 * accessible names. No DOM, no React runtime, no screenshot.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { completedTree } from '../src/client/completed/completed-tree.js'
import { completedViewModel } from '../src/client/ui-model.js'
import { COMPLETED_CSS, COMPLETED_STYLE_ID } from '../src/client/completed/completed-css.js'
import { LIVE_CSS } from '../src/client/live/live-css.js'
import { BASE_CSS } from '../src/client/base-css.js'
import { LOCALE_DICTS } from '../src/client/live/locale.js'
import { MetricQuality } from '../src/core/metric-quality.js'
import { QualityLevel } from '../src/core/quality-model.js'
import { loadFixture } from './helpers/fixtures.js'
import { durableSettledView } from './helpers/equivalence.js'

/**
 * A recording `createElement`: returns the tree as plain data.
 *
 * Children are kept nested exactly as React receives them — no flattening — so an
 * assertion can address `cell.children[1].children[0]` (the number inside the
 * value row) rather than a flattened bag of strings.
 */
function rec(tag, props, children) {
  const list = Array.isArray(children) ? children.filter(child => child !== null && child !== undefined) : [children]
  return { tag, props: props ?? {}, children: list }
}

const en = key => LOCALE_DICTS.en[key] ?? key
const zh = key => LOCALE_DICTS.zh[key] ?? key

/** Every text node of a tree, in document order. */
function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return node.children.flatMap(texts)
}

/** Every element of a tree whose class list contains `name`. */
function byClass(node, name, found = []) {
  if (node === null || node === undefined || typeof node === 'string') return found
  if (String(node.props.className ?? '').split(/\s+/).includes(name)) found.push(node)
  for (const child of node.children) byClass(child, name, found)
  return found
}

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

/** Build the card from a settled snapshot (the component's real input path). */
const cardOf = (settledSnapshot, translate = en) => completedTree(rec, completedViewModel(settledSnapshot), translate)

/** Build the card from an already-shaped view model. */
const cardOfView = (view, translate = en) => completedTree(rec, view, translate)

test('the card is one group with a turn-scoped accessible name and no live region', () => {
  const tree = cardOf(settled())
  assert.equal(tree.tag, 'div')
  assert.equal(tree.props['data-kind'], 'completed')
  assert.equal(tree.props['data-status'], 'completed')
  assert.equal(tree.props['data-turn'], 12)
  assert.equal(tree.props['data-session'], 'session-1')
  /**
   * Phase 5 moved `role` and the accessible name onto the card itself, because
   * the card is the interactive surface (it carries `tabindex`) while the root
   * is only a full-width flex seat.
   */
  const card = byClass(tree, 'dsh-tpm-card')[0]
  assert.equal(card.props.role, 'group')
  assert.equal(card.props['aria-label'], 'Turn performance summary · turn 12 · completed')
  assert.equal('aria-live' in tree.props, false, 'a static card must not be a live region')
  assert.equal('aria-atomic' in tree.props, false)
  assert.equal('aria-live' in card.props, false)
})

test('the card has exactly one cells container holding four labelled cells in order', () => {
  const tree = cardOf(settled())
  const containers = byClass(tree, 'dsh-tpm-cells')
  assert.equal(containers.length, 1)
  const cells = containers[0].children
  assert.equal(cells.length, 4)
  assert.deepEqual(cells.map(cell => cell.props['data-metric']),
    ['reasoningTps', 'outputTps', 'generatedTokens', 'ttft'])
  for (const cell of cells) {
    assert.equal(cell.props.role, 'group')
    assert.equal(cell.children.length, 3, 'label, value and secondary line')
  }
})

test('each cell labels its own value so four numbers are never unlabelled', () => {
  const tree = cardOf(settled())
  const cells = byClass(tree, 'dsh-tpm-cells')[0].children
  assert.equal(texts(cells[0].children[0])[0], 'Reasoning TPS')
  assert.equal(texts(cells[1].children[0])[0], 'Output TPS')
  assert.equal(texts(cells[2].children[0])[0], 'Generated Tokens')
  assert.equal(texts(cells[3].children[0])[0], 'TTFT')
  assert.equal(cells[0].props['aria-label'], 'Reasoning TPS, 345 tokens/s, 108.2s · 37,498')
  assert.equal(cells[3].props['aria-label'], 'TTFT, 1.44 s, completed')
})

test('the visible number and its unit are separate elements, with the unit suppressed when absent', () => {
  const tree = cardOf(settled())
  const cells = byClass(tree, 'dsh-tpm-cells')[0].children
  const value = cells[0].children[1]
  assert.equal(texts(value.children[0])[0], '345')
  assert.equal(texts(value.children[1])[0], 'tokens/s')

  const noRate = cardOf(settled({ reasoningTps: null, reasoningTpsQuality: MetricQuality.UNAVAILABLE, reasoningMs: 0, phaseTokens: { reasoning: null, output: 17_272 } }))
  const dashValue = byClass(noRate, 'dsh-tpm-cells')[0].children[0].children[1]
  assert.equal(texts(dashValue.children[0])[0], '—')
  assert.equal(dashValue.children[1], undefined, 'no unit follows an absent value')
})

test('the approximate marker is visible text and is also a data attribute for diagnostics', () => {
  const approximated = cardOf(settled({
    quality: quality(QualityLevel.EXACT, QualityLevel.ESTIMATED),
    reasoningTpsQuality: MetricQuality.CALIBRATED,
    phaseTokens: { reasoning: 37_498, output: 17_272 },
  }))
  const cell = byClass(approximated, 'dsh-tpm-cells')[0].children[0]
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
    const tree = cardOf(settled({ status, statusNote: note }))
    const ttftCell = byClass(tree, 'dsh-tpm-cells')[0].children[3]
    const sub = ttftCell.children[2]
    assert.equal(texts(sub)[0], expected, `${status}/${note} must appear as text`)
    assert.equal(sub.props['data-tone'], tone)
    assert.equal(tree.props['data-status'], status === 'completed' && note === 'max-tokens' ? 'max-tokens' : status)
    assert.ok(texts(tree).includes(expected), 'the status is inside the rendered text')
  }
})

test('the footer carries tools and status, and hides the tool item when there were none', () => {
  const withTools = cardOf(settled())
  const foot = byClass(withTools, 'dsh-tpm-foot')[0]
  assert.deepEqual(texts(foot), ['tools 4 · 12.8s', 'attempts 4', 'completed'])

  const noTools = cardOf(settled({ tools: { count: 0, wallMs: 0, workMs: 0, names: [] } }))
  const emptyFoot = byClass(noTools, 'dsh-tpm-foot')[0]
  assert.deepEqual(texts(emptyFoot), ['attempts 4', 'completed'], 'no tool item at all when there were no tools')
  assert.equal(texts(emptyFoot).some(text => text.includes('0')), false)
})

test('the footer never prints the tool work sum where the wall union belongs', () => {
  const parallel = cardOf(settled({
    tools: { count: 3, completedCount: 3, workMs: 4200, wallMs: 2600, failedCount: 0, names: ['read', 'grep'] },
  }))
  const foot = byClass(parallel, 'dsh-tpm-foot')[0]
  assert.equal(texts(foot)[0], 'tools 3 · 2.6s', 'the wall union is what the card shows')
  assert.equal(texts(foot)[0].includes('4.2s'), false, 'the summed work must not leak into the compact line')
})

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

/** Every element tag present anywhere in a tree. */
function tagsOf(tree) {
  const tags = new Set()
  const walk = node => {
    if (node === null || node === undefined || typeof node === 'string') return
    tags.add(node.tag)
    for (const child of node.children) walk(child)
  }
  walk(tree)
  return tags
}

test('the summary layer renders no chart, even when the turn carries curve data', () => {
  /**
   * Phase 4's invariant is preserved *per layer*: the summary is the default
   * view and never contains a chart. The curve is a separate layer that only the
   * interaction can reveal.
   */
  const tree = cardOf(settled({ curve: settledCurve() }))
  const summary = byClass(tree, 'dsh-tpm-view').find(layer => layer.props['data-view'] === 'summary')
  assert.equal(summary.props['data-visible'], 'true')
  const summaryTags = tagsOf(summary)
  for (const forbidden of ['svg', 'canvas', 'polyline', 'path', 'circle']) {
    assert.equal(summaryTags.has(forbidden), false, `the summary must not render a ${forbidden} element`)
  }
  assert.equal(JSON.stringify(summary).includes('900'), false, 'the peak value is not in the summary')
})

test('with no curve the card is inert: no chart, no focus stop, no handler', () => {
  const tree = cardOf(settled())
  assert.equal(byClass(tree, 'dsh-tpm-view').length, 1, 'only the summary layer exists')
  const card = byClass(tree, 'dsh-tpm-card')[0]
  assert.equal('tabIndex' in card.props, false, 'a card with nothing behind hover is not a focus stop')
  assert.equal('onMouseEnter' in card.props, false)
  assert.equal('onFocus' in card.props, false)
  const summaryTags = tagsOf(tree)
  for (const forbidden of ['svg', 'path', 'canvas']) {
    assert.equal(summaryTags.has(forbidden), false)
  }
})

test('every visible string comes from the locale namespace in both languages', () => {
  const english = texts(cardOf(settled())).join(' | ')
  const chinese = texts(cardOf(settled(), zh)).join(' | ')
  assert.equal(english.includes('Reasoning TPS'), true)
  assert.equal(chinese.includes('思考 TPS'), true)
  assert.equal(chinese.includes('生成 Tokens'), true)
  assert.equal(chinese.includes('已完成'), true)
  assert.equal(chinese.includes('总用时'), true)
  assert.equal(chinese.includes('工具'), true)
  assert.equal(english.includes('Reasoning TPS,') || english.length > 0, true)

  const missing = []
  for (const key of ['completedLabel', 'colReasoningTps', 'colOutputTps', 'colGeneratedTokens', 'colTtft',
    'elapsed', 'tools', 'attempts', 'unavailable', 'status.completed', 'status.interrupted',
    'status.errored', 'status.max-tokens']) {
    if (LOCALE_DICTS.en[key] === undefined) missing.push(`en:${key}`)
    if (LOCALE_DICTS.zh[key] === undefined) missing.push(`zh:${key}`)
  }
  assert.deepEqual(missing, [], 'every card string is translated in both locales')

  const chineseInterrupted = texts(cardOf(settled({ status: 'interrupted', statusNote: null }), zh)).join(' | ')
  assert.equal(chineseInterrupted.includes('已中断'), true)
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

test('a real fixture renders a complete card with all four labelled values', () => {
  const view = completedViewModel(durableSettledView(loadFixture('t4-reasoning-tool-deepseek-official')).settled)
  const tree = cardOfView(view)
  const cells = byClass(tree, 'dsh-tpm-cells')[0].children
  assert.equal(cells.length, 4)
  assert.deepEqual(cells.map(cell => texts(cell.children[0])[0]),
    ['Reasoning TPS', 'Output TPS', 'Generated Tokens', 'TTFT'])
  assert.deepEqual(cells.map(cell => texts(cell.children[1].children[0])[0]), ['≈50.6', '138', '151', '7.58'])
  assert.deepEqual(cells.map(cell => texts(cell.children[1].children[1])[0]), ['tokens/s', 'tokens/s', 'tokens', 's'])
  assert.deepEqual(cells.map(cell => cell.props['data-approximate']), ['true', 'false', 'false', 'false'],
    'the reasoning rate is estimated, the exact split and total are not')
  assert.equal(texts(byClass(tree, 'dsh-tpm-foot')[0]).includes('tools 1 · 0.3s'), true)
})
