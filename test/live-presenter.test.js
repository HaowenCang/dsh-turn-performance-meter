/**
 * Live presenter projection: machine state + LiveMeter snapshot -> view model.
 *
 * The guards under test all fail toward "show less": a mismatch between the
 * state machine and the meter must surface as a neutral transition or a hidden
 * view, never as a stale or zero TPS.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { LivePresenter } from '../src/client/live/live-presenter.js'
import { LIVE_UI_EVENT, LiveUiState } from '../src/client/live/live-state.js'
import { MetricQuality } from '../src/core/metric-quality.js'

/** A plausible streaming snapshot with overridable fields. */
function streamingSnapshot(extra = {}) {
  return {
    turn: 4,
    phase: 'streaming',
    tps: 338.4,
    tpsQuality: MetricQuality.ESTIMATED,
    activePhase: 'output',
    turnElapsedMs: 14_300,
    ttftMs: 1200,
    ...extra,
  }
}

function startedPresenter(events = []) {
  const presenter = new LivePresenter()
  presenter.apply({ type: LIVE_UI_EVENT.TURN_START, turn: 4, timeMs: 0 })
  for (const event of events) presenter.apply(event)
  return presenter
}

test('an inactive or settled machine projects hidden, whatever the snapshot says', () => {
  const inactive = new LivePresenter()
  assert.equal(inactive.project(streamingSnapshot(), 1000).kind, 'hidden')
  assert.equal(inactive.project(null, 1000).kind, 'hidden')

  const presenter = startedPresenter([
    { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 100 },
    { type: LIVE_UI_EVENT.TURN_END, turn: 4, timeMs: 500, status: 'interrupted' },
  ])
  /**
   * A settled machine is no longer hidden: it projects the completed card when
   * one is available. With no settled snapshot to read — the case here — it still
   * shows nothing rather than a guess.
   */
  const withoutSettled = presenter.project(streamingSnapshot(), 600)
  assert.equal(withoutSettled.kind, 'hidden', 'no settled snapshot, no card')
  assert.equal(withoutSettled.state, LiveUiState.SETTLED)

  const withSettled = presenter.project(streamingSnapshot(), 600, {
    sessionId: 's',
    turn: 4,
    status: 'interrupted',
    statusNote: 'aborted:user',
    tools: { count: 0 },
    columns: undefined,
  })
  assert.equal(withSettled.kind, 'completed')
  assert.equal(withSettled.state, LiveUiState.SETTLED)
  assert.equal(withSettled.status, 'interrupted')
  assert.equal(withSettled.columns.length, 4)
})

test('the settled branch takes precedence over any meter evidence', () => {
  const presenter = startedPresenter([
    { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'reasoning', timeMs: 100 },
    { type: LIVE_UI_EVENT.TURN_END, turn: 4, timeMs: 500, status: 'completed' },
  ])
  // Even a streaming snapshot cannot revive the pill: the card wins outright.
  const view = presenter.project(streamingSnapshot(), 600, { turn: 4, status: 'completed', tools: {} })
  assert.equal(view.kind, 'completed')
  assert.equal('tps' in view, false)
  assert.equal('elapsedMs' in view, true)
})

test('a settled machine with a junk settled payload shows nothing rather than a broken card', () => {
  const presenter = startedPresenter([{ type: LIVE_UI_EVENT.TURN_END, turn: 4, timeMs: 500, status: 'completed' }])
  for (const junk of [null, undefined, {}, { status: 'running' }, 'nope', 7]) {
    assert.equal(presenter.project(streamingSnapshot(), 600, junk).kind, 'hidden', `junk settled ${JSON.stringify(junk)}`)
  }
})

test('an open turn always outranks a completed card', () => {
  const presenter = startedPresenter([
    { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 100 },
    { type: LIVE_UI_EVENT.TURN_END, turn: 4, timeMs: 500, status: 'completed' },
    { type: LIVE_UI_EVENT.TURN_START, turn: 5, timeMs: 600 },
  ])
  const settled = { turn: 4, status: 'completed', tools: {} }
  const view = presenter.project({ turn: 5, phase: 'pending', ttftMs: null, turnElapsedMs: 100 }, 700, settled)
  assert.equal(view.kind, 'ttft', 'the new turn owns the slot; the previous card is gone')
  assert.equal(view.turn, 5)
  assert.equal(view.kind === 'completed', false)
})

test('pending-first-token projects the running TTFT stopwatch, never a rate', () => {
  const presenter = startedPresenter()
  const view = presenter.project({ turn: 4, phase: 'pending', ttftMs: null, tps: null, turnElapsedMs: 2800 }, 2800)
  assert.equal(view.kind, 'ttft')
  assert.equal(view.state, LiveUiState.PENDING_FIRST_TOKEN)
  assert.equal(view.counterMs, 2800, 'the stopwatch reads the turn elapsed')
  assert.equal('tps' in view, false, 'no rate exists before the first token')
})

test('streaming projects the trailing TPS with mandatory approximation', () => {
  const presenter = startedPresenter([
    { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'reasoning', timeMs: 1300 },
  ])
  const view = presenter.project(streamingSnapshot({ activePhase: 'reasoning' }), 14_300)
  assert.equal(view.kind, 'streaming')
  assert.equal(view.state, LiveUiState.STREAMING_REASONING)
  assert.equal(view.phase, 'reasoning')
  assert.equal(view.tps, 338.4)
  assert.equal(view.quality, MetricQuality.ESTIMATED)
  assert.equal(view.approximate, true, 'live TPS is estimated unconditionally -> always ≈')
  assert.equal(view.elapsedMs, 14_300)
  assert.equal('curve' in view, false, 'live mode has no curve')
})

test('a streaming state without streaming meter evidence degrades to transition (no stale TPS)', () => {
  const presenter = startedPresenter([
    { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 1300 },
    // Settlement folded into the machine but the snapshot lags one tick:
    { type: LIVE_UI_EVENT.ATTEMPT_SETTLE, turn: 4, timeMs: 5000 },
  ])
  // Machine says transition; even if it still said streaming, a non-streaming
  // snapshot must not leak the previous 338.
  const machineStillStreaming = new LivePresenter()
  machineStillStreaming.apply({ type: LIVE_UI_EVENT.TURN_START, turn: 4, timeMs: 0 })
  machineStillStreaming.apply({ type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 1300 })
  const view = machineStillStreaming.project({ turn: 4, phase: 'pending', ttftMs: 1300, tps: null, turnElapsedMs: 6000 }, 6000)
  assert.equal(view.kind, 'transition', 'streaming state + non-streaming snapshot => neutral, not the old number')
  assert.equal('tps' in view, false)

  const settledView = presenter.project({ turn: 4, phase: 'pending', ttftMs: 1300, tps: null, turnElapsedMs: 5100 }, 5100)
  assert.equal(settledView.kind, 'transition')
})

test('the tool stage projects names, count and episode timer, with no TPS field at all', () => {
  const presenter = startedPresenter([
    { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 100 },
    { type: LIVE_UI_EVENT.ATTEMPT_SETTLE, turn: 4, timeMs: 200 },
    { type: LIVE_UI_EVENT.TOOL_START, turn: 4, timeMs: 300, name: 'pwsh' },
    { type: LIVE_UI_EVENT.TOOL_START, turn: 4, timeMs: 350, name: 'write' },
  ])
  const view = presenter.project({
    turn: 4,
    phase: 'tool',
    tps: null,
    runningToolCount: 2,
    runningToolNames: ['pwsh', 'write'],
    toolElapsedMs: 2310,
    turnElapsedMs: 17_900,
  }, 17_900)
  assert.equal(view.kind, 'tool')
  assert.equal(view.state, LiveUiState.TOOL_RUNNING)
  assert.equal(view.count, 2)
  assert.deepEqual(view.names, ['pwsh', 'write'])
  assert.equal(view.toolElapsedMs, 2310, 'the tool episode wall time comes from the meter, untouched')
  assert.equal('tps' in view, false, 'no stale TPS field exists on the tool view')
  assert.equal('approximate' in view, false)
})

test('a machine that says tools run while the meter disagrees shows transition, never a TPS', () => {
  const presenter = startedPresenter([
    { type: LIVE_UI_EVENT.TOOL_START, turn: 4, timeMs: 100, name: 'pwsh' },
  ])
  // Meter reports streaming (inconsistent evidence), machine reports tools.
  const view = presenter.project(streamingSnapshot(), 5000)
  assert.equal(view.kind, 'transition', 'inconsistent evidence degrades to the neutral stage')
  assert.equal('tps' in view, false)
})

test('waiting-model projects its own stopwatch and never the TTFT counter', () => {
  const presenter = startedPresenter([
    { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 500 },
    { type: LIVE_UI_EVENT.TOOL_START, turn: 4, timeMs: 600, name: 'pwsh' },
    { type: LIVE_UI_EVENT.TOOL_END, turn: 4, timeMs: 2600 },
    { type: LIVE_UI_EVENT.STEP_START, turn: 4, step: 2, timeMs: 2610 },
  ])
  const view = presenter.project({ turn: 4, phase: 'pending', ttftMs: 500, tps: null, turnElapsedMs: 3470 }, 3470)
  assert.equal(view.kind, 'waiting', 'after the turn TTFT froze, waiting replaces the first-token stage')
  assert.notEqual(view.kind, 'ttft')
  assert.equal(view.state, LiveUiState.WAITING_MODEL)
  assert.equal(view.waitMs, 3470 - 2610)
  assert.equal('counterMs' in view, false)
})

test('a meter with no turn projects hidden even when a machine believes otherwise', () => {
  const presenter = startedPresenter([{ type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 100 }])
  assert.equal(presenter.project({ phase: 'idle' }, 1000).kind, 'hidden')
  assert.equal(presenter.project(null, 1000).kind, 'hidden')
  assert.equal(presenter.project({ phase: 'settled', turn: 4 }, 1000).kind, 'hidden')
})

test('two presenters (two sessions) never share machine state', () => {
  const a = startedPresenter([{ type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 100 }])
  const b = new LivePresenter()
  assert.equal(a.project(streamingSnapshot(), 1000).kind, 'streaming')
  assert.equal(b.project(streamingSnapshot(), 1000).kind, 'hidden', 'session B has no observed turn')
  // Events for B do not disturb A.
  b.apply({ type: LIVE_UI_EVENT.TURN_START, turn: 9, timeMs: 0 })
  assert.equal(a.project(streamingSnapshot(), 1000).kind, 'streaming')
  assert.equal(a.machine.turn, 4)
})
