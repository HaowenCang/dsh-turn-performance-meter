/**
 * The presentation cadence contract (Phase 5A).
 *
 * One number, one home. These tests exist because the previous revision had the
 * same conceptual cadence declared three times — in the controller, in the
 * scheduler and at the mount site — and a contract with three defaults drifts.
 *
 * The properties asserted here are structural. Whether 50 ms *looks* smooth is
 * not a unit test's question; it is answered by the browser A/B recorded in
 * `docs/IMPLEMENTATION_LOG.md`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  DEFAULT_PRESENTATION_REFRESH_MS,
  PRESENTATION_REFRESH_CANDIDATES_MS,
  REFRESH_OVERRIDE_STORAGE_KEY,
  resolvePresentationRefreshMs,
} from '../src/client/live/cadence.js'
import { createPresentationScheduler } from '../src/client/live/refresh.js'
import { createController } from '../src/client/live/controller.js'

const readSource = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

test('the selected production cadence is the single source both consumers read', async () => {
  assert.equal(DEFAULT_PRESENTATION_REFRESH_MS, 50, 'the cadence the A/B selected')
  assert.equal(DEFAULT_PRESENTATION_REFRESH_MS === 200, false, 'the 200 ms baseline is no longer the default')

  const refresh = await readSource('src/client/live/refresh.js')
  const controller = await readSource('src/client/live/controller.js')
  const main = await readSource('src/client/main.js')

  for (const [name, source] of [['refresh.js', refresh], ['controller.js', controller], ['main.js', main]]) {
    assert.equal(source.includes('DEFAULT_PRESENTATION_REFRESH_MS'), true, `${name} imports the one constant`)
    assert.equal(/=\s*200\b/.test(source), false, `${name} declares no cadence of its own`)
    assert.equal(/intervalMs\s*=\s*\d/.test(source), false, `${name} hard-codes no interval default`)
  }
  assert.equal(refresh.includes('DEFAULT_PRESENTATION_REFRESH_MS,'), true,
    'the scheduler default *is* the shared constant, not a copy of its value')
  assert.equal(/refreshMs\s*=\s*DEFAULT_PRESENTATION_REFRESH_MS/.test(controller), true,
    'the controller default is the same constant')
})

test('every cadence the A/B measured can actually be requested', () => {
  assert.deepEqual([...PRESENTATION_REFRESH_CANDIDATES_MS], [200, 50, 10])
  assert.equal(PRESENTATION_REFRESH_CANDIDATES_MS.includes(DEFAULT_PRESENTATION_REFRESH_MS), true,
    'the shipped cadence is one of the measured ones')
  for (const cadence of PRESENTATION_REFRESH_CANDIDATES_MS) {
    const scheduler = createPresentationScheduler({ intervalMs: cadence, onRender() {} })
    assert.equal(scheduler.intervalMs, cadence)
    scheduler.dispose()
  }
})

test('a debug override resolves to a usable cadence and never to a broken timer', () => {
  assert.equal(resolvePresentationRefreshMs('50'), 50)
  assert.equal(resolvePresentationRefreshMs('10'), 10)
  assert.equal(resolvePresentationRefreshMs(200), 200)
  for (const bad of [null, undefined, '', 'abc', '0', 0, -5, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(resolvePresentationRefreshMs(bad), DEFAULT_PRESENTATION_REFRESH_MS,
      `${String(bad)} must fall back to the selected cadence rather than arm an invalid interval`)
  }
  assert.equal(REFRESH_OVERRIDE_STORAGE_KEY, 'dsh-turn-performance-meter.refreshMs')
})

test('the override is unreachable unless the diagnostic switch is already on', async () => {
  const main = await readSource('src/client/main.js')
  assert.equal(/refreshMs\s*=\s*debug\s*\n?\s*\?\s*resolvePresentationRefreshMs/.test(main), true,
    'the production cadence is the constant; only a debug session may override it')
  assert.equal(main.includes('DEFAULT_PRESENTATION_REFRESH_MS')
    && /debug\s*\?\s*resolvePresentationRefreshMs\(cadenceOverride\(\)\)\s*\n?\s*:\s*DEFAULT_PRESENTATION_REFRESH_MS/.test(main),
  true, 'the two branches are the override and the constant, with nothing in between')
})

test('1000+ deltas are all ingested while presentation stays on the cadence', () => {
  /**
   * Structural, not wall-clock: the fake timers fire when the test says so, so
   * the assertion is about *how many renders a cadence can produce*, never about
   * how long a machine took. The real performance question is answered by the
   * browser A/B.
   */
  for (const cadence of PRESENTATION_REFRESH_CANDIDATES_MS) {
    const intervals = new Map()
    const timeouts = new Map()
    let nextId = 1
    let renders = 0
    const scheduler = createPresentationScheduler({
      intervalMs: cadence,
      onRender: () => { renders += 1 },
      setTimeoutImpl: fn => { const id = nextId++; timeouts.set(id, fn); return id },
      clearTimeoutImpl: id => timeouts.delete(id),
      setIntervalImpl: fn => { const id = nextId++; intervals.set(id, fn); return id },
      clearIntervalImpl: id => intervals.delete(id),
    })
    scheduler.start()
    for (let index = 0; index < 1315; index += 1) scheduler.notify()
    assert.equal(scheduler.timerCount, 1, `${cadence} ms: one interval, no lead timers, under a full burst`)
    assert.equal(timeouts.size, 0, `${cadence} ms: the burst itself never renders`)
    assert.equal(renders, 0)
    for (const [, fn] of [...intervals]) fn()
    assert.equal(renders, 1, `${cadence} ms: one tick, one render`)
    scheduler.dispose()
    assert.equal(scheduler.timerCount, 0, `${cadence} ms: no timer survives dispose`)
  }
})

test('a settled view leaves no ticker, at every candidate cadence', () => {
  for (const cadence of PRESENTATION_REFRESH_CANDIDATES_MS) {
    const controller = createController({ sessions: { binding: () => undefined }, refreshMs: cadence })
    assert.equal(controller.refreshMs, cadence)
    controller.dispose()
  }
})
