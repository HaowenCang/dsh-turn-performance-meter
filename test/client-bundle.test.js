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
  assert.equal(injected[0].name, 'conversation.composer.dock', 'the verified composer dock seat')

  const registration = injected[0].factory()
  assert.equal(registration.options.id, 'turn-performance-meter', 'an independent id; the native stats id stays untouched')
  assert.equal(registration.options.name, 'conversation.composer.dock')
  assert.equal(registration.options.order, -10, 'positioned directly beside the composer')
  assert.equal(typeof registration.component, 'function', 'a React component is registered')

  // Teardown (HMR/unload): `ctx.effect` runs its callback as setup NOW and
  // calls the returned disposer at fiber teardown.
  assert.equal(effects.length, 1)
  const dispose = effects[0]()
  assert.equal(typeof dispose, 'function', 'the effect returns its disposer')
  assert.doesNotThrow(() => dispose())
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
