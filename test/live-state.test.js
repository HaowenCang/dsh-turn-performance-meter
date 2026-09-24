/**
 * The explicit live-UI state machine (UI_SPEC §3).
 *
 * Each test pins one written entry/exit condition of the eight-state
 * machine. The states exist precisely so the React layer never infers the
 * situation from possibly-undefined snapshot fields.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { LIVE_UI_EVENT, LiveUiState, initialLiveUi, reduceLiveUi } from '../src/client/live/live-state.js'

function applyAll(machine, events) {
  let state = machine
  const seen = [state.state]
  for (const event of events) {
    state = reduceLiveUi(state, event)
    seen.push(state.state)
  }
  return { state, seen }
}

test('the eight declared live states exist with their exact names', () => {
  assert.deepEqual(
    Object.values(LiveUiState).sort(),
    [
      'inactive',
      'pending-first-token',
      'settled',
      'streaming-output',
      'streaming-reasoning',
      'tool-running',
      'transition',
      'waiting-model',
    ],
  )
  assert.equal(initialLiveUi().state, LiveUiState.INACTIVE)
})

test('turn/start enters pending-first-token and a replayed turn/start does not restart it', () => {
  const open = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 1000 })
  assert.equal(open.state, LiveUiState.PENDING_FIRST_TOKEN)
  assert.equal(open.ttftFrozen, false)

  // First delta freezes the turn TTFT.
  const streaming = reduceLiveUi(open, { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'reasoning', timeMs: 1400 })
  assert.equal(streaming.state, LiveUiState.STREAMING_REASONING)
  assert.equal(streaming.ttftFrozen, true)

  // A replayed durable turn/start (reload) must not rewind the frozen marker.
  const replayed = reduceLiveUi(streaming, { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 1000 })
  assert.equal(replayed, streaming, 'same turn + already open => no state change')
})

test('the first model-producing delta freezes TTFT; later LLM calls never return to pending-first-token', () => {
  const { state } = applyAll(initialLiveUi(), [
    { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 },
    { type: LIVE_UI_EVENT.STEP_START, turn: 1, step: 1, timeMs: 10 },
    { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'output', timeMs: 400 },
    // tool boundary
    { type: LIVE_UI_EVENT.TOOL_START, turn: 1, timeMs: 500, name: 'pwsh' },
    { type: LIVE_UI_EVENT.TOOL_END, turn: 1, timeMs: 1500 },
    { type: LIVE_UI_EVENT.STEP_START, turn: 1, step: 2, timeMs: 1510 },
    { type: LIVE_UI_EVENT.ATTEMPT_START, attemptId: 's:2', turn: 1, timeMs: 1520 },
    { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'reasoning', timeMs: 1900 },
  ])
  assert.equal(state.state, LiveUiState.STREAMING_REASONING)
  assert.equal(state.ttftFrozen, true)

  // The only path back to pending-first-token is a new turn.
  const nextTurn = reduceLiveUi(state, { type: LIVE_UI_EVENT.TURN_START, turn: 2, timeMs: 9000 })
  assert.equal(nextTurn.state, LiveUiState.PENDING_FIRST_TOKEN)
  assert.equal(nextTurn.ttftFrozen, false)
})

test('delta phase decides streaming-reasoning vs streaming-output, including tool arguments as output', () => {
  let machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'reasoning', timeMs: 1 })
  assert.equal(machine.state, LiveUiState.STREAMING_REASONING)
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'output', timeMs: 2 })
  assert.equal(machine.state, LiveUiState.STREAMING_OUTPUT, 'text and tool-call argument deltas are the output phase')
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'reasoning', timeMs: 3 })
  assert.equal(machine.state, LiveUiState.STREAMING_REASONING)
})

test('parallel tools stay in tool-running until the last one settles, then transition', () => {
  let machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'output', timeMs: 100 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.ATTEMPT_SETTLE, turn: 1, timeMs: 150 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TOOL_START, turn: 1, timeMs: 200, name: 'read' })
  assert.equal(machine.state, LiveUiState.TOOL_RUNNING)
  assert.equal(machine.activeTools, 1)
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TOOL_START, turn: 1, timeMs: 250, name: 'grep' })
  assert.equal(machine.activeTools, 2)
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TOOL_END, turn: 1, timeMs: 400 })
  assert.equal(machine.state, LiveUiState.TOOL_RUNNING, 'one of two tools is still running')
  assert.equal(machine.activeTools, 1)
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TOOL_END, turn: 1, timeMs: 900 })
  assert.equal(machine.state, LiveUiState.TRANSITION, 'the gap after the last tool is the neutral transition stage')
  assert.equal(machine.activeTools, 0)
  assert.equal(machine.sinceMs, 900)
})

test('a tool stage cannot appear before the turn existed, and a settlement during tools keeps the tool view', () => {
  const idle = initialLiveUi()
  const afterTool = reduceLiveUi(idle, { type: LIVE_UI_EVENT.TOOL_START, turn: 1, timeMs: 0, name: 'pwsh' })
  assert.equal(afterTool, idle, 'events for a machine with no open turn change nothing')

  let machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'output', timeMs: 10 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TOOL_START, turn: 1, timeMs: 20, name: 'pwsh' })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.ATTEMPT_SETTLE, turn: 1, timeMs: 25 })
  assert.equal(machine.state, LiveUiState.TOOL_RUNNING, 'a settlement does not end running tools')
})

test('tool -> transition -> step/start reaches waiting-model, which never reopens the TTFT stage', () => {
  const { state, seen } = applyAll(initialLiveUi(), [
    { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 },
    { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'output', timeMs: 500 },
    { type: LIVE_UI_EVENT.TOOL_START, turn: 1, timeMs: 600, name: 'pwsh' },
    { type: LIVE_UI_EVENT.TOOL_END, turn: 1, timeMs: 2600 },
    { type: LIVE_UI_EVENT.STEP_START, turn: 1, step: 2, timeMs: 2610 },
    { type: LIVE_UI_EVENT.ATTEMPT_START, attemptId: 's:2', turn: 1, timeMs: 2620 },
  ])
  assert.deepEqual(seen, [
    'inactive',
    'pending-first-token',
    'streaming-output',
    'tool-running',
    'transition',
    'waiting-model',
    'waiting-model',
  ])
  assert.equal(state.state, LiveUiState.WAITING_MODEL)
  assert.equal(state.sinceMs, 2620, 'the wait stopwatch restarts at the new attempt')
  assert.equal(state.ttftFrozen, true, 'waiting-model is only reachable after the TTFT froze')
})

test('a tool ending before the first token keeps the turn in pending-first-token', () => {
  let machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TOOL_START, turn: 1, timeMs: 100, name: 'x' })
  assert.equal(machine.state, LiveUiState.TOOL_RUNNING)
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TOOL_END, turn: 1, timeMs: 200 })
  assert.equal(machine.state, LiveUiState.PENDING_FIRST_TOKEN, 'the turn TTFT stage is still open')
  assert.equal(machine.ttftFrozen, false)
})

test('attempt settlement and a scheduled retry both enter the neutral transition stage', () => {
  let machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 1, phase: 'reasoning', timeMs: 200 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.ATTEMPT_SETTLE, turn: 1, timeMs: 300 })
  assert.equal(machine.state, LiveUiState.TRANSITION)
  assert.equal(machine.sinceMs, 300)

  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.RETRY, turn: 1, timeMs: 800 })
  assert.equal(machine.state, LiveUiState.TRANSITION)
  assert.equal(machine.sinceMs, 800, 'the retry backoff restarts the neutral stopwatch')

  // The retried attempt's new identity waits for its first delta.
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.ATTEMPT_START, attemptId: 's:2', turn: 1, timeMs: 1300 })
  assert.equal(machine.state, LiveUiState.WAITING_MODEL)
})

test('turn/end settles the machine for every status and clears tool activity', () => {
  for (const status of ['completed', 'interrupted', 'errored']) {
    let machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 4, timeMs: 0 })
    machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 10 })
    machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TOOL_START, turn: 4, timeMs: 20, name: 'pwsh' })
    machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TURN_END, turn: 4, timeMs: 30, status })
    assert.equal(machine.state, LiveUiState.SETTLED, `turn end with status ${status} exits live mode`)
    assert.equal(machine.activeTools, 0)
    // After settling, other events do not resurrect the meter.
    machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 4, phase: 'output', timeMs: 40 })
    assert.equal(machine.state, LiveUiState.SETTLED)
  }
})

test('events naming a different turn than the one on screen are ignored', () => {
  let machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 7, timeMs: 0 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 7, phase: 'output', timeMs: 10 })
  const frozen = machine
  const alien = reduceLiveUi(machine, { type: LIVE_UI_EVENT.DELTA, turn: 8, phase: 'reasoning', timeMs: 20 })
  assert.equal(alien, frozen, 'turn isolation inside one machine')
  const alienEnd = reduceLiveUi(machine, { type: LIVE_UI_EVENT.TURN_END, turn: 8, timeMs: 30, status: 'completed' })
  assert.equal(alienEnd, frozen, 'another session-turn cannot settle this one')
})

test('a reset returns the machine to inactive and malformed events never throw', () => {
  let machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 })
  machine = reduceLiveUi(machine, { type: LIVE_UI_EVENT.RESET })
  assert.equal(machine.state, LiveUiState.INACTIVE)

  const before = machine
  for (const junk of [null, undefined, 42, 'delta', {}, { type: 'unknown-kind' }]) {
    assert.equal(reduceLiveUi(before, junk), before, `junk event ${String(junk)} is a no-op`)
  }
})

test('reducer purity: an unchanged event returns the identical object', () => {
  const machine = reduceLiveUi(initialLiveUi(), { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 })
  // Same turn/start replayed: identical reference, not a copy.
  assert.equal(reduceLiveUi(machine, { type: LIVE_UI_EVENT.TURN_START, turn: 1, timeMs: 0 }), machine)
})
