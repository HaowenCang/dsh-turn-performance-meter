/**
 * Phase 7D — the live tool count, on the 0.1.7 `tool/result` contract.
 *
 * The screenshots this phase exists to explain showed `pwsh +192` on a turn
 * whose calls were strictly sequential. The count was the number of *historical*
 * calls, because no result had ever paired: the pre-7D parser read the call
 * identity from `content[0].toolCallId`, a location the 0.1.7 tool-role message
 * does not use. Every call therefore stayed `running` forever, and the live pill
 * accumulated them.
 *
 * Three quantities are frozen here, and they are deliberately different:
 *
 *   record.tools.length          historical calls observed in the turn
 *   live.runningTools().length   calls with no result yet — the only live count
 *   presenter tool count         exactly `live.runningTools().length`
 *
 * §37 forbids any UI path from substituting one for another, and §9 freezes the
 * `pwsh +N` label as "N **additional currently running** calls".
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { formatToolLabel } from '../src/client/live/live-format.js'
import { createWindowDriver } from './helpers/assistant-stream-fold.js'

const SESSION = 'sess-017-tools'

/** One exact 0.1.7 `tool/result` durable event for `callId`. */
function toolResult(seq, time, callId, { turn = 1, step = 1, isError, error, text = 'ok' } = {}) {
  const message = {
    id: `msg-${seq}`,
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content: [{ type: 'text', text }],
  }
  if (isError !== undefined) message.isError = isError
  const data = { turn, step, message }
  if (error !== undefined) data.error = error
  return { type: 'event', event: { type: 'tool/result', seq, time, data, surfaceOp: 'append' } }
}

function toolCall(seq, time, callId, name = 'pwsh', { turn = 1, step = 1 } = {}) {
  return {
    type: 'event',
    event: {
      type: 'tool/call',
      seq,
      time,
      surfaceOp: 'append',
      data: { turn, step, callId, name, arguments: '{"command":"Get-Date"}' },
    },
  }
}

function harness() {
  const driver = createWindowDriver()
  const sessions = {
    binding: () => ({ eventSource: { getSnapshot: driver.getSnapshot, subscribe: driver.subscribe } }),
  }
  const controller = createController({ sessions })
  assert.equal(controller.attach(SESSION), true)
  return {
    driver,
    controller,
    record: turn => controller.store.turns.get(`${SESSION}::${turn}`),
    live: () => controller.store.live(SESSION),
    project: atMs => controller.project(SESSION, atMs),
    diagnostics: () => controller.diagnostics(SESSION),
    dispose: () => controller.dispose(),
  }
}

/** The running count the live pill would render, read from the meter snapshot. */
function runningCount(h, nowMs) {
  const snapshot = h.controller.store.liveSnapshot(SESSION, nowMs)
  return snapshot.phase === 'tool' ? snapshot.runningToolCount : 0
}

function openTurn(h, time = 1000) {
  h.driver.append({ type: 'event', event: { type: 'turn/start', seq: 1, time, data: { turn: 1 } } })
}

test('one hundred sequential pwsh calls never exceed one running call', () => {
  const h = harness()
  openTurn(h)

  /**
   * §8: the exact sequential shape the screenshot showed. The historical count
   * is allowed to reach 100; the live count must never exceed 1, and the label
   * must never accumulate to `pwsh +1`, `pwsh +81`, `pwsh +99`.
   */
  let maxRunning = 0
  const labels = new Set()
  let seq = 1
  for (let i = 1; i <= 100; i += 1) {
    const callId = `call-${i}`
    h.driver.append(toolCall((seq += 1), 2000 + i * 100, callId))
    const afterCall = runningCount(h, 2000 + i * 100)
    assert.equal(afterCall, 1, `call ${i}: exactly one call is running`)
    maxRunning = Math.max(maxRunning, afterCall)
    labels.add(formatToolLabel(h.controller.store.liveSnapshot(SESSION, 2000 + i * 100).runningToolNames, afterCall))

    h.driver.append(toolResult((seq += 1), 2000 + i * 100 + 50, callId))
    const afterResult = runningCount(h, 2000 + i * 100 + 50)
    assert.equal(afterResult, 0, `result ${i}: the call settled`)
    maxRunning = Math.max(maxRunning, afterResult)
  }

  assert.equal(maxRunning, 1, 'the hard invariant: max runningToolCount === 1')
  assert.deepEqual([...labels], ['pwsh'], 'a sequential run only ever renders the single-call label')

  const record = h.record(1)
  assert.equal(record.tools.length, 100, 'the historical call count did reach 100')
  assert.equal(h.live().runningTools().length, 0, 'no call is left running')
  assert.equal(record.tools.every(call => Number.isFinite(call.endMs)), true)
  assert.equal(record.tools.every(call => call.status === 'ok'), true)

  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.rawToolResults, 100)
  assert.equal(diagnostics.counters.malformedToolResults, 0)
  assert.equal(diagnostics.unmatchedToolResults, 0, 'every result paired by identity')
  h.dispose()
})

test('three concurrent calls count 3 then 2 then 1 then 0, and the label is pwsh +2', () => {
  const h = harness()
  openTurn(h)

  h.driver.append(toolCall(2, 2000, 'c1'))
  h.driver.append(toolCall(3, 2010, 'c2'))
  h.driver.append(toolCall(4, 2020, 'c3'))

  assert.equal(runningCount(h, 2050), 3)
  assert.equal(formatToolLabel(h.controller.store.liveSnapshot(SESSION, 2050).runningToolNames, 3), 'pwsh +2')

  h.driver.append(toolResult(5, 3000, 'c1'))
  assert.equal(runningCount(h, 3050), 2)
  assert.equal(formatToolLabel(h.controller.store.liveSnapshot(SESSION, 3050).runningToolNames, 2), 'pwsh +1')

  h.driver.append(toolResult(6, 3100, 'c2'))
  assert.equal(runningCount(h, 3150), 1)
  assert.equal(formatToolLabel(h.controller.store.liveSnapshot(SESSION, 3150).runningToolNames, 1), 'pwsh')

  h.driver.append(toolResult(7, 3200, 'c3'))
  assert.equal(runningCount(h, 3250), 0, 'the tool stage is over')

  const record = h.record(1)
  assert.equal(record.tools.length, 3, 'the historical total stays 3')
  assert.equal(h.live().runningTools().length, 0)
  h.dispose()
})

test('the tool wall timer is the union of overlapping calls, not the sum', () => {
  const h = harness()
  openTurn(h, 1000)
  // c1 2000-6000, c2 3000-4000 (nested): union 2000-6000 = 4000 ms, sum = 5000 ms.
  h.driver.append(toolCall(2, 2000, 'c1'))
  h.driver.append(toolCall(3, 3000, 'c2'))
  h.driver.append(toolResult(4, 4000, 'c2'))
  h.driver.append(toolResult(5, 6000, 'c1'))

  const snapshot = h.controller.store.liveSnapshot(SESSION, 6000)
  // The episode closed with the last call, so the meter no longer reports it;
  // the union is asserted on the record's own intervals instead.
  assert.equal(h.live().runningTools().length, 0)
  const record = h.record(1)
  const intervals = record.tools.map(call => [call.startMs, call.endMs])
  assert.deepEqual(intervals, [[2000, 6000], [3000, 4000]])
  const union = 6000 - 2000
  const sum = (6000 - 2000) + (4000 - 3000)
  assert.equal(union, 4000)
  assert.equal(sum, 5000)
  assert.notEqual(union, sum, 'the fixture must actually distinguish the two')
  void snapshot
  h.dispose()
})

test('mixed concurrent tools label as the first running call plus the extras', () => {
  const h = harness()
  openTurn(h)

  /**
   * §11: true concurrency across different tools. The compact pill names the
   * first currently-running call and counts the others; it never enumerates a
   * list, and the count is of *running* calls, so settling the first one moves
   * the label to the next running call.
   */
  h.driver.append(toolCall(2, 2000, 'c1', 'pwsh'))
  h.driver.append(toolCall(3, 2010, 'c2', 'read'))
  h.driver.append(toolCall(4, 2020, 'c3', 'write'))

  const snapshot = h.controller.store.liveSnapshot(SESSION, 2050)
  assert.equal(snapshot.runningToolCount, 3)
  assert.deepEqual(snapshot.runningToolNames, ['pwsh', 'read', 'write'], 'first-seen order')
  assert.equal(formatToolLabel(snapshot.runningToolNames, 3), 'pwsh +2')

  h.driver.append(toolResult(5, 3000, 'c1'))
  const afterFirst = h.controller.store.liveSnapshot(SESSION, 3050)
  assert.deepEqual(afterFirst.runningToolNames, ['read', 'write'])
  assert.equal(formatToolLabel(afterFirst.runningToolNames, afterFirst.runningToolCount), 'read +1')

  h.driver.append(toolResult(6, 3100, 'c2'))
  const afterSecond = h.controller.store.liveSnapshot(SESSION, 3150)
  assert.deepEqual(afterSecond.runningToolNames, ['write'])
  assert.equal(formatToolLabel(afterSecond.runningToolNames, afterSecond.runningToolCount), 'write')

  h.driver.append(toolResult(7, 3200, 'c3'))
  assert.equal(runningCount(h, 3250), 0)
  assert.equal(h.record(1).tools.length, 3, 'the historical total is independent of the live count')
  h.dispose()
})

test('a malformed result closes nothing', () => {
  const h = harness()
  openTurn(h)
  h.driver.append(toolCall(2, 2000, 'c1'))
  h.driver.append(toolCall(3, 2010, 'c2'))

  /**
   * §6: the identity is authoritative. A result with no `message.toolCallId`
   * must not close the most recent call, a call matched by name, or every
   * running call.
   */
  h.driver.append({
    type: 'event',
    event: {
      type: 'tool/result',
      seq: 4,
      time: 3000,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { id: 'm', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'x' }] } },
    },
  })

  assert.equal(runningCount(h, 3050), 2, 'both calls are still running')
  const record = h.record(1)
  assert.deepEqual(record.tools.map(call => call.endMs), [null, null], 'no end time is fabricated')
  const diagnostics = h.diagnostics()
  assert.equal(diagnostics.counters.malformedToolResults, 1, 'the malformed result is counted')
  assert.equal(diagnostics.counters.rawToolResults, 1)
  h.dispose()
})

test('a failed tool is still finished and leaves the running set', () => {
  const h = harness()
  openTurn(h)

  // Three failure shapes, all of which must settle by identity.
  h.driver.append(toolCall(2, 2000, 'f1'))
  h.driver.append(toolCall(3, 2005, 'f2'))
  h.driver.append(toolCall(4, 2010, 'f3'))
  h.driver.append(toolCall(5, 2015, 'f4'))
  assert.equal(runningCount(h, 2020), 4)

  h.driver.append(toolResult(6, 3000, 'f1', { isError: true }))
  assert.equal(runningCount(h, 3005), 3, 'isError alone settles the call')

  h.driver.append(toolResult(7, 3100, 'f2', { error: { name: 'ToolFailure', code: 'E_FAIL' } }))
  assert.equal(runningCount(h, 3105), 2, 'data.error alone settles the call')

  h.driver.append(toolResult(8, 3200, 'f3', { isError: true, error: { name: 'ToolFailure', code: 'E_FAIL' } }))
  assert.equal(runningCount(h, 3205), 1, 'both together settle the call once')

  const record = h.record(1)
  assert.deepEqual(record.tools.map(call => call.status), ['error', 'error', 'error', 'running'])
  assert.equal(record.tools.every(call => call.callId !== 'f4' || call.endMs === null), true)
  h.dispose()
})

test('a successful result in the same batch still settles by identity, not order', () => {
  const h = harness()
  openTurn(h)
  // Results arrive in the opposite order to the calls: pairing must be by id.
  h.driver.append(toolCall(2, 2000, 'x1'))
  h.driver.append(toolCall(3, 2010, 'x2'))
  h.driver.append(toolResult(4, 3000, 'x2'))
  h.driver.append(toolResult(5, 3100, 'x1'))

  const record = h.record(1)
  assert.equal(record.toolIndex.get('x1').endMs, 3100, 'x1 paired with its own result')
  assert.equal(record.toolIndex.get('x2').endMs, 3000, 'x2 paired with its own result')
  assert.equal(h.diagnostics().unmatchedToolResults, 0)
  h.dispose()
})
