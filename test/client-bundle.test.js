/**
 * The generated browser bundle (`client.js`).
 *
 * The DSH browser module table executes a single classic script whose factory
 * resolves only seed words and registered package ids, so `src/` is bundled by
 * `scripts/bundle-client.mjs`. These tests execute the real bundle inside a
 * sandboxed realm with a stubbed module table and assert the load contract:
 * registration shape, factory exports, externals discipline (React from the
 * seed only, never `@deepseek-ai/*`), deterministic output, slot registration
 * and effect teardown — without a browser.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { bundleClient } from '../scripts/bundle-client.mjs'

const text = await bundleClient()

function materialize(externals = {}) {
  const registrations = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) { registrations.push(registration) },
      },
    },
    console,
  }
  vm.runInNewContext(text, sandbox, { filename: 'client.js' })
  assert.equal(registrations.length, 1, 'the bundle registers exactly one module')
  const registration = registrations[0]
  const requested = []
  const requireStub = (spec) => {
    requested.push(spec)
    if (Object.hasOwn(externals, spec)) return externals[spec]
    throw new Error(`bundle required an unexpected module table word: ${spec}`)
  }
  const exports = registration.require === undefined ? registration.factory(requireStub) : null
  return { registration, exports, requested }
}

const reactStub = {
  createElement: (...args) => ({ __element: args }),
  useEffect: () => {},
  useReducer: () => [0, () => {}],
  useRef: () => ({ current: null }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
}

test('the bundle is deterministic and matches the committed client.js', async () => {
  assert.equal(text, await bundleClient(), 'two builds produce byte-identical output')
  const committed = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(committed, text, 'client.js on disk is exactly what src/ produces (stale bundle guard)')
})

test('the bundle registers the plugin id and materializes exports through the module table contract', () => {
  const { registration, exports, requested } = materialize({ react: reactStub })
  assert.equal(registration.id, 'dsh-turn-performance-meter')
  assert.equal(typeof registration.factory, 'function')
  assert.deepEqual(requested.filter(spec => spec !== 'react'), [], 'react is the only module-table word requested')
  assert.equal(
    requested.every(spec => !spec.startsWith('@deepseek-ai/')),
    true,
    'the client half never requires a host-only @deepseek-ai package',
  )
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.apply === 'function' && exports.inject.includes('slots'), true)
  assert.ok(exports.inject.includes('sessions'))
  assert.ok(exports.inject.includes('locale'))
  assert.ok(!text.includes('__ext("@deepseek-ai'), 'no @deepseek-ai external escapes into the bundle')
})

test('apply registers the locale namespace, the additive slot entry and a disposable effect', () => {
  const { exports } = materialize({ react: reactStub })

  const registered = []
  const injected = []
  const effects = []
  let boundTranslateCalls = 0

  const ctx = {
    locale: {
      register(ns, dicts) {
        assert.equal(ns, 'turnPerformanceMeter')
        assert.equal(typeof dicts.en, 'object')
        assert.equal(typeof dicts.zh, 'object')
        assert.equal(dicts.zh.ttft, '首响应计时')
        assert.equal(dicts.en.ttft, 'first response timer')
        return () => { registered.localeDisposed = true }
      },
      bind(ns) {
        boundTranslateCalls += 1
        assert.equal(ns, 'turnPerformanceMeter')
        return null
      },
    },
    sessions: { binding: () => undefined },
    slots: {
      inject(name, factory) { injected.push({ name, factory }) },
      register(options, component) { return { options, component } },
    },
    effect(fn) { effects.push(fn) },
  }

  exports.apply(ctx)
  assert.equal(boundTranslateCalls, 1)
  assert.equal(injected.length, 1)
  assert.equal(injected[0].name, 'conversation.input.dock',
    'the verified full-width seat above the composer card')

  const registration = injected[0].factory()
  assert.equal(registration.options.id, 'turn-performance-meter', 'an independent id; the native stats id stays untouched')
  assert.equal(registration.options.name, 'conversation.input.dock')
  /**
   * The seat's shipped occupants are `todo` (0), `goal` (10) and `queue` (20), and
   * order is ascending, so `-10` places this entry **first** — telemetry, then task
   * state, then the composer. Phase 5 shipped `30`, which put the content-sized pill
   * below three full-width cards; Phase 7 corrected it against the real interface.
   */
  assert.equal(registration.options.order, -10, 'first among the shipped occupants, above the native state panels')
  assert.equal(typeof registration.component, 'function', 'a React component is registered')

  // Teardown (HMR/unload): `ctx.effect` runs its callback as setup NOW and
  // calls the returned disposer at fiber teardown.
  assert.equal(effects.length, 1)
  const dispose = effects[0]()
  assert.equal(typeof dispose, 'function', 'the effect returns its disposer')
  assert.doesNotThrow(() => dispose())
})

test('the plugin never occupies the composer dock, so the native stats keep their seat', () => {
  /**
   * The migration is a *removal*, not a reordering: with `order: -10` in
   * `conversation.composer.dock` the meter rendered between the composer and the
   * native `stats` pill (id `stats`, `client-ui-chat`). Both facts are asserted
   * against the shipped bundle, because a stale re-export or a leftover
   * registration would otherwise reintroduce the old seat silently.
   */
  const { exports, requested } = materialize({ react: reactStub })
  assert.equal(exports.SLOT_NAME, 'conversation.input.dock')
  assert.equal(exports.SLOT_ORDER, -10)
  assert.equal(exports.SLOT_ID, 'turn-performance-meter')
  /**
   * The ordering contract, asserted against the shipped module rather than a local
   * constant: every currently shipped occupant of `conversation.input.dock` must
   * sort **after** this entry. The list below is the verified upstream registration
   * order, and the comparison is the same ascending comparison the slot performs.
   */
  const SHIPPED_OCCUPANTS = Object.freeze([
    { id: 'todo', order: 0 },
    { id: 'goal', order: 10 },
    { id: 'queue', order: 20 },
  ])
  for (const occupant of SHIPPED_OCCUPANTS) {
    assert.ok(exports.SLOT_ORDER < occupant.order,
      `${occupant.id} (order ${occupant.order}) must render below the meter (order ${exports.SLOT_ORDER})`)
  }
  assert.deepEqual(
    [...SHIPPED_OCCUPANTS, { id: exports.SLOT_ID, order: exports.SLOT_ORDER }]
      .sort((left, right) => left.order - right.order)
      .map(entry => entry.id),
    ['turn-performance-meter', 'todo', 'goal', 'queue'],
    'ascending order yields the target stack: meter, task state, then the composer',
  )
  assert.equal(Number.isFinite(exports.SLOT_ORDER), true,
    'a finite order: no slot contract defines a top pin, so the claim stays bounded')
  /**
   * The quoted form, not the bare word: the module keeps the migration's history
   * in prose comments, and a test that forbade the *name* would forbid explaining
   * why the seat changed. What must never come back is a registration literal.
   */
  assert.equal(text.includes("'conversation.composer.dock'"), false,
    'the superseded seat is gone from the executable bundle, not merely reordered')
  assert.equal(requested.includes('react'), true)

  /** Only one `register` call happens, and it never claims the shipped id. */
  const registrations = []
  const ctx = {
    locale: { register: () => () => {}, bind: () => null },
    sessions: { binding: () => undefined },
    slots: {
      inject: (name, factory) => { factory() },
      register: (options, component) => { registrations.push({ options, component }); return { options, component } },
    },
    effect: fn => fn(),
  }
  exports.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.id === 'stats', false,
    'the native statistics occupant id must never be reused, which would replace it')
})

test('a second apply/teardown cycle leaves no cross-generation state (HMR remount shape)', () => {
  const { exports } = materialize({ react: reactStub })
  const makeCtx = () => {
    const state = { injects: 0, effects: [] }
    return {
      state,
      ctx: {
        locale: { register: () => () => {}, bind: () => null },
        sessions: { binding: () => undefined },
        slots: {
          inject: () => { state.injects += 1 },
          register: (options, component) => ({ options, component }),
        },
        effect: fn => state.effects.push(fn),
      },
    }
  }
  const first = makeCtx()
  exports.apply(first.ctx)
  assert.equal(first.state.effects.length, 1)
  const firstDispose = first.state.effects[0]()
  assert.equal(typeof firstDispose, 'function')
  assert.doesNotThrow(() => firstDispose())

  const second = makeCtx()
  exports.apply(second.ctx)
  assert.equal(second.state.injects, 1, 'the remount registers exactly one slot entry')
  assert.equal(first.state.injects, 1, 'the previous generation registered nothing extra')
  const secondDispose = second.state.effects[0]()
  assert.doesNotThrow(() => secondDispose())
})

test('the bundle carries all three stylesheets and exactly one style tag id', async () => {
  /**
   * HMR discipline: one `#dsh-tpm-live-style` element holds the shared token
   * block, the pill CSS *and* the card CSS, so a remount cannot accumulate
   * `style` elements and the views can never disagree about the tokens they read.
   */
  const { BASE_CSS } = await import('../src/client/base-css.js')
  const { LIVE_CSS, LIVE_STYLE_ID } = await import('../src/client/live/live-css.js')
  const { COMPLETED_CSS, COMPLETED_STYLE_ID } = await import('../src/client/completed/completed-css.js')
  const root = await readFile(new URL('../src/client/live/MeterRoot.js', import.meta.url), 'utf8')
  assert.equal(text.includes(LIVE_STYLE_ID), true)
  assert.equal(root.includes('COMPLETED_STYLE_ID'), false, 'the card CSS declares no tag of its own')
  assert.equal(COMPLETED_STYLE_ID === LIVE_STYLE_ID, false, 'the two stylesheets have distinct ids')
  assert.equal((text.match(/document\.createElement\('style'\)/g) ?? []).length, 1,
    'exactly one style tag is ever created')
  for (const selector of ['.dsh-tpm-pill', '.dsh-tpm-number', '.dsh-tpm-sep']) {
    assert.equal(LIVE_CSS.includes(selector), true, `the pill CSS is bundled (${selector})`)
  }
  assert.equal(BASE_CSS.includes('.dsh-tpm-root'), true, 'the shared token block owns the root')
  for (const selector of ['.dsh-tpm-card', '.dsh-tpm-cells', '.dsh-tpm-cell', '.dsh-tpm-foot']) {
    assert.equal(COMPLETED_CSS.includes(selector), true, `the card CSS is bundled (${selector})`)
  }
  assert.equal(BASE_CSS.includes('--dsh-tpm-font: var(--dsh-content-font-size-secondary, 13px)'), true,
    'the plugin type scale follows the host content size')
  /** The curve view's own vocabulary, which is what Phase 5 added. */
  for (const selector of ['.dsh-tpm-curve-panel', '.dsh-tpm-plot', '.dsh-tpm-series', '.dsh-tpm-legend-swatch']) {
    assert.equal(COMPLETED_CSS.includes(selector), true, `the curve CSS is bundled (${selector})`)
  }
  assert.equal(text.includes('src/client/completed/CompletedMeter.js'), true, 'the card component is in the graph')
  assert.equal(text.includes('src/client/completed/completed-tree.js'), true, 'the card tree is in the graph')
  assert.equal(text.includes('src/client/completed/curve-view-model.js'), true, 'the curve seam is in the graph')
  assert.equal(text.includes('src/client/completed/curve-tree.js'), true, 'the SVG tree is in the graph')
  assert.equal(text.includes('src/client/live/MeterRoot.js'), true, 'the meter root owns the shared lifecycle')
})

test('the chart is hand-built SVG with no charting dependency', () => {
  /**
   * The brief forbids d3/chart.js/echarts/recharts and any comparable payload.
   * The visible consequence is that the only drawing primitive in the bundle is
   * a plain `path` element built from a string this repository produced.
   */
  assert.equal(text.includes("createElement('path'"), true, 'the curve is a hand-built path element')
  for (const forbidden of ['d3-', 'chart.js', 'echarts', 'recharts', 'createElementNS', "'canvas'"]) {
    assert.equal(text.includes(forbidden), false, `no charting dependency or canvas fallback (${forbidden})`)
  }
  assert.equal(/from\s+'[^.'][^']*'/.test(text), false, 'the bundle has no bare-specifier import left')
  assert.equal(text.includes('viewBox'), true, 'the plot is a fixed logical viewBox, not a measured canvas')
})
