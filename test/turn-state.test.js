import test from 'node:test'
import assert from 'node:assert/strict'
import { settleFromTurnEndReason, reduceTurnState, initialTurnState, TurnPhase } from '../src/core/turn-state.js'

test('verified turn/end reasons map to the three card statuses', () => {
  assert.deepEqual(settleFromTurnEndReason({ kind: 'completed' }), { status: 'completed', note: null })
  assert.deepEqual(settleFromTurnEndReason({ kind: 'max-tokens' }), { status: 'completed', note: 'max-tokens' })
  assert.deepEqual(settleFromTurnEndReason({ kind: 'aborted', reason: { kind: 'user' } }), {
    status: 'interrupted',
    note: 'aborted:user',
  })
  assert.deepEqual(settleFromTurnEndReason({ kind: 'interrupted' }), {
    status: 'interrupted',
    note: 'crash-orphaned',
  })
  assert.deepEqual(settleFromTurnEndReason({ kind: 'blocked' }), { status: 'errored', note: 'blocked' })
  assert.equal(settleFromTurnEndReason({ kind: 'error', error: { code: 'RATE_LIMIT' } }).status, 'errored')
  assert.equal(settleFromTurnEndReason({ kind: 'error', error: { code: 'RATE_LIMIT' } }).note, 'RATE_LIMIT')
})

test('an unknown future reason settles without claiming a known cause', () => {
  const settled = settleFromTurnEndReason({ kind: 'some-future-kind' })
  assert.equal(settled.status, 'completed')
  assert.equal(settled.note, 'some-future-kind')
  assert.equal(settleFromTurnEndReason(undefined).note, 'unknown-reason')
})

test('lifecycle walks pending -> streaming -> tool -> pending -> streaming', () => {
  let state = initialTurnState()
  assert.equal(state.phase, TurnPhase.IDLE)

  state = reduceTurnState(state, { type: 'TURN_STARTED', turn: 3, timeMs: 0 })
  assert.equal(state.phase, TurnPhase.PENDING)

  state = reduceTurnState(state, { type: 'ATTEMPT_STARTED', attemptId: 'a1' })
  state = reduceTurnState(state, { type: 'FIRST_DELTA', timeMs: 1200 })
  assert.equal(state.phase, TurnPhase.STREAMING)
  assert.equal(state.firstTokenMs, 1200)

  state = reduceTurnState(state, { type: 'TOOL_STARTED', callId: 'c1' })
  assert.equal(state.phase, TurnPhase.TOOL)
  assert.equal(state.activeAttemptId, null, 'no attempt is streaming while a tool runs')

  state = reduceTurnState(state, { type: 'TOOL_ENDED', callId: 'c1' })
  assert.equal(state.phase, TurnPhase.PENDING)

  state = reduceTurnState(state, { type: 'ATTEMPT_STARTED', attemptId: 'a2' })
  state = reduceTurnState(state, { type: 'DELTA', timeMs: 9000 })
  assert.equal(state.phase, TurnPhase.STREAMING)
  assert.equal(state.firstTokenMs, 1200, 'TTFT is never redefined by a later model call')
})

test('parallel tools keep the phase at tool until the last one ends', () => {
  let state = reduceTurnState(initialTurnState(), { type: 'TURN_STARTED', turn: 1, timeMs: 0 })
  state = reduceTurnState(state, { type: 'TOOL_STARTED', callId: 'c1' })
  state = reduceTurnState(state, { type: 'TOOL_STARTED', callId: 'c2' })
  state = reduceTurnState(state, { type: 'TOOL_ENDED', callId: 'c1' })
  assert.equal(state.phase, TurnPhase.TOOL)
  assert.deepEqual([...state.activeToolIds], ['c2'])
  state = reduceTurnState(state, { type: 'TOOL_ENDED', callId: 'c2' })
  assert.equal(state.phase, TurnPhase.PENDING)
})

test('turn end settles the status and clears live identities', () => {
  let state = reduceTurnState(initialTurnState(), { type: 'TURN_STARTED', turn: 1, timeMs: 0 })
  state = reduceTurnState(state, { type: 'ATTEMPT_STARTED', attemptId: 'a1' })
  state = reduceTurnState(state, { type: 'TOOL_STARTED', callId: 'c1' })
  state = reduceTurnState(state, {
    type: 'TURN_ENDED',
    timeMs: 5000,
    reason: { kind: 'aborted', reason: { kind: 'user' } },
  })
  assert.equal(state.phase, TurnPhase.INTERRUPTED)
  assert.equal(state.status, 'interrupted')
  assert.equal(state.settledAtMs, 5000)
  assert.equal(state.activeAttemptId, null)
  assert.equal(state.activeToolIds.size, 0)
})

test('a new TURN_STARTED replaces the previous turn rather than merging with it', () => {
  let state = reduceTurnState(initialTurnState(), { type: 'TURN_STARTED', turn: 1, timeMs: 0 })
  state = reduceTurnState(state, { type: 'FIRST_DELTA', timeMs: 300 })
  state = reduceTurnState(state, { type: 'TURN_STARTED', turn: 2, timeMs: 99_000 })
  assert.equal(state.turn, 2)
  assert.equal(state.firstTokenMs, null, 'the previous turn cannot leak its TTFT into the next')
  assert.equal(state.turnStartMs, 99_000)
})
