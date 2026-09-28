/**
 * The completed card's presentation state as the *component* owns it.
 *
 * `test/completed-interaction.test.js` proves the state machine and the element tree
 * are right in isolation. Two questions cannot be answered there, because both are
 * about React's lifecycle rather than about a transition:
 *
 *   - **A new settled view resets the card.** A reader who expanded turn 1 must not
 *     have turn 2 arrive already open, and the reset has to happen on the view
 *     *changing* rather than on every render. That is an effect with a dependency, so
 *     it needs a real render sequence and a real view identity;
 *   - **nothing else resets it, and nothing arms a clock.** A parent re-render that
 *     hands the component the same view object must leave the expanded card open, and
 *     a settled card must arm no timer while any of it happens.
 *
 * The subject is `src/client/completed/CompletedMeter.js` itself, loaded through a
 * synchronous `module.registerHooks()` loader that substitutes a recording React for
 * the real one. That is what makes the component — rather than a copy of its logic —
 * the thing under test: `completedTree` already takes `createElement` as a parameter,
 * so the recording element factory is the only other piece the host would have
 * provided.
 *
 * The views are **real view models**, built by `completedViewModel` from settled
 * snapshots, so the identity the effect depends on is the identity the controller
 * really produces, and the strings on the collapsed row are the strings the card
 * really prints.
 *
 * No screenshot is taken here, and none could be: this file answers "which state does
 * the component write" and not "what does the result look like". The browser evidence
 * for the latter is `dev/screenshots/phase9/`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

/**
 * A recording React, installed before `CompletedMeter` is imported.
 *
 * Hooks are positional and keyed by `slot`, which is enough because the component is
 * a single function that always calls its hooks in the same order. **`useRef` keeps
 * its box across renders, as React does, and that faithfulness is load-bearing
 * rather than decorative:** the component compares `previousView.current` against the
 * incoming `view` inside its effect, so a box that reset every render would make the
 * comparison always true and would mask a missing dependency array — the test would
 * pass for the wrong reason. `useState` likewise keeps its value, so a click that
 * dispatches a state update is visible to the next render.
 *
 * `useEffect` honours its dependency array the way React does, and that comparison is
 * the only thing deciding whether the reset runs — which is the behaviour under test.
 * Effects settle in a second pass after the render returns, as they do in React, so a
 * reset is never observable during the render that scheduled it.
 */
function reactRecorder() {
  const state = new Map()
  const refs = new Map()
  const previousDeps = new Map()
  let slot = 0
  let pending = []
  let owner = null
  /** Timers the component asked the host to arm. A settled card must add none. */
  const armed = []

  const api = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const key = `${owner}:${slot++}`
      if (!state.has(key)) state.set(key, typeof initial === 'function' ? initial() : initial)
      const set = (next) => {
        state.set(key, typeof next === 'function' ? next(state.get(key)) : next)
      }
      return [state.get(key), set]
    },
    useRef(initial) {
      const key = `${owner}:${slot++}`
      if (!refs.has(key)) refs.set(key, { current: initial })
      return refs.get(key)
    },
    useEffect(effect, deps) {
      pending.push({ effect, deps })
    },
  }

  return {
    api,
    armed,
    /**
     * Render one component function once and settle its effects, as React would: the
     * render pass returns the tree first, and only then do the effects whose
     * dependencies moved run.
     */
    render(name, component, props) {
      owner = name
      slot = 0
      pending = []
      const tree = component(props)
      /** The effects this pass registered, in hook order, with their dependencies. */
      const registered = pending
      registered.forEach((entry, index) => {
        const key = `${name}:${index}`
        const previous = previousDeps.get(key)
        const changed = previous === undefined
          || entry.deps === undefined
          || entry.deps.length !== previous.length
          || entry.deps.some((value, at) => !Object.is(value, previous[at]))
        if (!changed) return
        previousDeps.set(key, entry.deps)
        entry.effect()
      })
      return tree
    },
  }
}

const recorder = reactRecorder()

/**
 * Substitute the recording React for the real one, which is the only host-provided
 * module `CompletedMeter.js` reaches for. `registerHooks` is synchronous and applies
 * to the dynamic import below, so the component never sees the real React.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: 'stub:react', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'stub:react') {
      return {
        format: 'module',
        source: 'const api = globalThis.__dshTpmReactStub;\n'
          + 'export const createElement = api.createElement;\n'
          + 'export const useState = api.useState;\n'
          + 'export const useRef = api.useRef;\n'
          + 'export const useEffect = api.useEffect;\n'
          + 'export default api;\n',
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

// eslint-disable-next-line no-underscore-dangle
globalThis.__dshTpmReactStub = recorder.api
const { completedViewModel } = await import('../src/client/ui-model.js')
const { CompletedMeter } = await import('../src/client/completed/CompletedMeter.js')

const { MetricQuality } = await import('../src/core/metric-quality.js')
const { QualityLevel } = await import('../src/core/quality-model.js')

/** A settled snapshot for one turn, so two views differ by turn and by total. */
function settled(turn, generatedTokens) {
  return {
    sessionId: 'session-1',
    turn,
    status: 'completed',
    statusNote: null,
    reasoningTps: 345,
    reasoningTpsQuality: MetricQuality.EXACT,
    reasoningMs: 108_200,
    outputTps: 676,
    outputTpsQuality: MetricQuality.EXACT,
    outputMs: 25_400,
    phaseTokens: { reasoning: 37_498, output: 17_272 },
    generatedTokens,
    observedGeneratedTokens: generatedTokens,
    turnElapsedMs: 133_600,
    ttftMs: 1440,
    attemptCount: 4,
    tools: { count: 4, completedCount: 4, workMs: 12_800, wallMs: 12_800, failedCount: 0, names: ['pwsh'] },
    quality: {
      tokenTotalQuality: QualityLevel.EXACT,
      phaseSplitQuality: QualityLevel.EXACT,
      temporalShapeQuality: QualityLevel.RECONSTRUCTED,
      displayTokenTotal: 'exact',
      displayPhaseSplit: 'exact',
      notes: [],
    },
    consistencyIssues: [],
    curve: null,
  }
}

/** The English half of the locale dictionary, as `wrapTranslate` would resolve it. */
const TRANSLATIONS = Object.freeze({
  performanceTitle: 'Performance',
  completedLabel: 'Turn performance summary',
  colReasoningTps: 'Reasoning TPS',
  colOutputTps: 'Output TPS',
  colGeneratedTokens: 'Generated Tokens',
  colTtft: 'TTFT',
  elapsed: 'elapsed',
  tools: 'tools',
  attempts: 'attempts',
  thinking: 'thinking',
  output: 'output',
  'status.completed': 'completed',
  'status.interrupted': 'interrupted',
  'status.errored': 'errored',
  'status.max-tokens': 'token limit reached',
  turnLabel: 'turn',
})
const en = key => TRANSLATIONS[key] ?? key

/**
 * Find the first element with `className` in a recorded tree.
 *
 * `createElement` collects its variadic children, so a subtree is an arbitrarily
 * nested mix of elements, arrays and strings — the same shape React itself accepts.
 * Flattening here is what lets the assertions address the tree the way React's
 * reconciler would.
 */
function findByClass(node, className) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, className)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (String(node.props?.className ?? '').split(/\s+/).includes(className)) return node
  return findByClass(node.children ?? [], className)
}

/** Every text node of a subtree, in document order, with nested arrays flattened. */
function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.children ?? [])
}

const headerOf = tree => findByClass(tree, 'dsh-tpm-card-header')
const detailOf = tree => findByClass(tree, 'dsh-tpm-detail')
const progressOf = tree => texts(findByClass(tree, 'dsh-tpm-card-progress')).join('')

/**
 * Mount the component over a view the test can swap underneath it.
 *
 * `render` is what React does on a state update: the recording React keeps the hook
 * state between calls, so the component resumes where the previous render left it.
 * `setView` hands the *next* render a different view object, which is the exact change
 * a settled turn, a reload and a session switch-back all produce — the effect
 * dependency is the view identity, so passing a new one is the whole signal.
 */
function mount(turn = 1, generatedTokens = 54_770) {
  let view = completedViewModel(settled(turn, generatedTokens))
  return {
    armed: recorder.armed,
    render: () => recorder.render('meter', CompletedMeter, { view, translate: en }),
    setView: (next) => { view = next },
    viewOf: (atTurn, tokens) => completedViewModel(settled(atTurn, tokens)),
  }
}

test('a freshly mounted completed card is collapsed, and the detail is not rendered', () => {
  const meter = mount()
  const tree = meter.render()
  assert.equal(tree.props['data-kind'], 'completed')
  assert.equal(tree.props['data-collapsed'], 'true')
  assert.equal(tree.props['data-view'], 'summary', 'a collapsed card is still on the summary')
  assert.equal(headerOf(tree).props['aria-expanded'], 'false')
  assert.equal(detailOf(tree), undefined, 'the detail is not merely hidden, it is absent')
})

test('clicking the header expands into the summary, and clicking again collapses it', () => {
  const meter = mount()
  headerOf(meter.render()).props.onClick()
  const opened = meter.render()
  assert.equal(opened.props['data-collapsed'], 'false')
  assert.equal(opened.props['data-view'], 'summary', 'expanding always opens the summary first')
  assert.equal(headerOf(opened).props['aria-expanded'], 'true')
  assert.ok(detailOf(opened) !== undefined, 'the detail is rendered')

  headerOf(opened).props.onClick()
  const closed = meter.render()
  assert.equal(closed.props['data-collapsed'], 'true')
  assert.equal(detailOf(closed), undefined, 'collapsed means not rendered, not merely hidden')
})

test('a re-render with the same view object leaves the reader where they were', () => {
  const meter = mount()
  headerOf(meter.render()).props.onClick()
  assert.equal(meter.render().props['data-collapsed'], 'false')
  /**
   * The effect's dependency is the view object, so an unrelated parent re-render
   * passes the same object and must not reset anything. If this fails, the card would
   * collapse under the reader whenever the surrounding chat re-rendered.
   */
  for (let index = 0; index < 5; index += 1) {
    assert.equal(meter.render().props['data-collapsed'], 'false', 'the expanded card survives a re-render')
  }
})

test('a settled card arms no timer, through expansion, collapse and a new turn', () => {
  const meter = mount()
  headerOf(meter.render()).props.onClick()
  meter.render()
  headerOf(meter.render()).props.onClick()
  meter.render()
  meter.setView(meter.viewOf(2, 12))
  meter.render()
  assert.deepEqual(meter.armed, [], 'collapse is event-driven: no interval, no timeout, no ticker')
})

test('a second settled turn arrives collapsed, whatever the reader left the first one showing', () => {
  const meter = mount()
  /**
   * Leave turn 1 **expanded**, which is the state that must not survive. The click is
   * read off the tree the previous render produced, because that tree's handler is the
   * one bound to the state the reader is actually in.
   */
  headerOf(meter.render()).props.onClick()
  const expandedFirst = meter.render()
  assert.equal(expandedFirst.props['data-collapsed'], 'false', 'the reader left turn 1 expanded')
  assert.equal(expandedFirst.props['data-turn'], 1)

  meter.setView(meter.viewOf(2, 12))
  /**
   * Two renders, because the reset is a *dispatched* state update: React applies it
   * after the render that scheduled it, exactly as it would for a click. The render in
   * which the new view is first seen may still paint the previous state; the render
   * that follows it may not.
   */
  meter.render()
  const tree = meter.render()
  assert.equal(tree.props['data-turn'], 2, 'the card follows the newest settled turn')
  assert.equal(tree.props['data-collapsed'], 'true', 'a new settled view is a new card')
  assert.equal(tree.props['data-view'], 'summary')
  assert.equal(detailOf(tree), undefined)
  assert.equal(headerOf(tree).props['aria-expanded'], 'false')
})

test('a collapsed card still prints the new turn readings, so the reset is not a blank row', () => {
  const meter = mount()
  const before = progressOf(meter.render())
  assert.equal(before.startsWith('completed · '), true, before)
  assert.equal(before.includes('54,770 tokens'), true, before)

  meter.setView(meter.viewOf(2, 12))
  const after = progressOf(meter.render())
  assert.equal(after.startsWith('completed · '), true, after)
  /** The card's own three-significant-figure formatter decides this, not the row. */
  assert.equal(after.includes('12.0 tokens'), true, `the new turn's total is on the row: ${after}`)
  assert.notEqual(after, before, 'and it is not the previous turn row left on screen')
})
