/**
 * Presentation scheduler: structural performance contract (Phase 3 §24).
 *
 * The properties under test are structural, not wall-clock benchmarks:
 * ingestion may be high-frequency, but at most two timers ever exist, renders
 * happen only on the bounded ticker while visible, one coalesced render covers
 * the hidden state, and stop/dispose leave zero timers behind.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createPresentationScheduler } from '../src/client/live/refresh.js'

function fakeTimers() {
  let nextId = 1
  const timeouts = new Map()
  const intervals = new Map()
  return {
    setTimeoutImpl: (fn) => { const id = nextId++; timeouts.set(id, fn); return id },
    clearTimeoutImpl: (id) => { timeouts.delete(id) },
    setIntervalImpl: (fn) => { const id = nextId++; intervals.set(id, fn); return id },
    clearIntervalImpl: (id) => { intervals.delete(id) },
    timeoutCount: () => timeouts.size,
    intervalCount: () => intervals.size,
    fireTimeouts() {
      for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn() }
    },
    fireIntervals(times) {
      for (let round = 0; round < times; round += 1) {
        for (const [, fn] of [...intervals]) fn()
      }
    },
  }
}

function makeScheduler(onRender, timers) {
  return createPresentationScheduler({
    intervalMs: 200,
    onRender,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  })
}

test('100 notifications while hidden coalesce into exactly one leading render', () => {
  const timers = fakeTimers()
  let renders = 0
  const scheduler = makeScheduler(() => { renders += 1 }, timers)
  for (let index = 0; index < 100; index += 1) scheduler.notify()
  assert.equal(scheduler.timerCount, 1, 'one coalesced leading timer, not one per event')
  assert.equal(timers.timeoutCount(), 1)
  timers.fireTimeouts()
  assert.equal(renders, 1)
  assert.equal(scheduler.timerCount, 0)
  scheduler.dispose()
})

test('while ticking, notifications add no timers and renders come only from the ticker', () => {
  const timers = fakeTimers()
  let renders = 0
  const scheduler = makeScheduler(() => { renders += 1 }, timers)
  scheduler.start()
  assert.equal(scheduler.ticking, true)
  assert.equal(scheduler.timerCount, 1)

  // A high-frequency burst (the shape of a 1300-delta attempt) creates no
  // additional timers and no immediate renders.
  for (let index = 0; index < 1315; index += 1) scheduler.notify()
  assert.equal(scheduler.timerCount, 1, 'the ticker already covers presentation')
  assert.equal(timers.timeoutCount(), 0, 'no lead timers while ticking')
  assert.equal(renders, 0, 'the data burst itself never renders')

  // Renders happen only at the bounded cadence: 20 ticks => 20 renders,
  // regardless of the 1315 ingested events.
  timers.fireIntervals(20)
  assert.equal(renders, 20)
  assert.ok(renders < 1315 / 5, 'presentation updates are far fewer than delta count')
  scheduler.dispose()
})

test('stop and dispose leave zero timers; a disposed scheduler is inert', () => {
  const timers = fakeTimers()
  let renders = 0
  const scheduler = makeScheduler(() => { renders += 1 }, timers)
  scheduler.start()
  scheduler.notify()
  assert.ok(scheduler.timerCount <= 2, 'at most one interval plus one leading render')

  scheduler.stop()
  assert.equal(scheduler.timerCount, 0)
  assert.equal(timers.timeoutCount(), 0)
  assert.equal(timers.intervalCount(), 0)

  scheduler.dispose()
  scheduler.notify()
  scheduler.start()
  assert.equal(scheduler.timerCount, 0, 'a disposed scheduler never arms a timer again')
  timers.fireIntervals(5)
  timers.fireTimeouts()
  assert.equal(renders, 0)
})

test('restarting after a hide/show cycle works and still owns at most two timers', () => {
  const timers = fakeTimers()
  let renders = 0
  const scheduler = makeScheduler(() => { renders += 1 }, timers)
  scheduler.start()
  scheduler.stop()
  scheduler.start()
  assert.equal(scheduler.timerCount, 1)
  scheduler.notify()
  assert.equal(scheduler.timerCount, 1, 'notify while ticking is a no-op')
  timers.fireIntervals(3)
  assert.equal(renders, 3)
  scheduler.dispose()
})

test('invalid scheduler configuration is rejected instead of arming a broken timer', () => {
  assert.throws(() => createPresentationScheduler({ intervalMs: 0, onRender() {} }), TypeError)
  assert.throws(() => createPresentationScheduler({ intervalMs: -5, onRender() {} }), TypeError)
  assert.throws(() => createPresentationScheduler({ intervalMs: Number.NaN, onRender() {} }), TypeError)
  assert.throws(() => createPresentationScheduler({ intervalMs: 200 }), TypeError)
})
