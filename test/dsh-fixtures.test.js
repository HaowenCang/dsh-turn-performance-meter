/**
 * Fixture contract: what a recorded fixture must contain, and what a synthetic
 * derivative must declare.
 *
 * The fixtures are evidence. If a fixture loses a property these tests require,
 * the correct response is to re-record it, not to relax the contract — otherwise
 * the equivalence tests would still pass while proving less.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { listDerived, listFixtures, loadDerived, loadFixture } from './helpers/fixtures.js'

const SETTLEMENT_TYPES = new Set(['assistant/message', 'assistant/attempt'])

test('every fixture records both evidence planes for exactly one turn', () => {
  for (const name of listFixtures()) {
    const fixture = loadFixture(name)
    const events = fixture.durable.map(row => row.event)
    const turns = new Set(events.filter(e => e.type === 'turn/start').map(e => e.data.turn))
    assert.equal(turns.size, 1, `${name}: a fixture must cover exactly one turn, found ${turns.size}`)
    assert.equal(fixture.summary.turnEndCount, 1, `${name}: the turn must be closed by a recorded turn/end`)
    assert.equal(fixture.durable[0].wallClockMs > 0, true, `${name}: raw rows must carry a recorder wall clock`)
  }
})

test('durable events keep a strictly increasing sequence and non-decreasing time', () => {
  for (const name of listFixtures()) {
    const fixture = loadFixture(name)
    const events = fixture.durable.map(row => row.event)
    for (let index = 1; index < events.length; index += 1) {
      assert.ok(events[index].seq > events[index - 1].seq, `${name}: seq went backwards at index ${index}`)
    }
    const turnEvents = events.filter(e => e.data?.turn === 1)
    for (let index = 1; index < turnEvents.length; index += 1) {
      assert.ok(turnEvents[index].time >= turnEvents[index - 1].time, `${name}: event time went backwards`)
    }
  }
})

test('every settlement carries a decodable compact stream and its own usage decision', () => {
  for (const name of listFixtures()) {
    const fixture = loadFixture(name)
    const settlements = fixture.durable.map(row => row.event).filter(e => SETTLEMENT_TYPES.has(e.type))
    assert.ok(settlements.length > 0, `${name}: no settlement recorded`)

    for (const settlement of settlements) {
      assert.ok(Array.isArray(settlement.data.stream), `${name} seq=${settlement.seq}: stream must be an array`)
      assert.ok(settlement.data.stream.length > 0, `${name} seq=${settlement.seq}: stream must not be empty`)
      assert.ok(Number.isFinite(settlement.time), `${name} seq=${settlement.seq}: settlement needs an envelope time`)
      if (settlement.data.usage !== undefined) {
        assert.ok(Number.isFinite(settlement.data.usage.outputTokens), `${name} seq=${settlement.seq}: usage needs outputTokens`)
      }
      if (settlement.data.interrupted !== undefined) {
        assert.equal(settlement.data.interrupted, true, `${name} seq=${settlement.seq}: the marker is only ever true when present`)
      }
    }
  }
})

test('every fixture records tool calls paired with results by call id', () => {
  for (const name of listFixtures()) {
    const fixture = loadFixture(name)
    const events = fixture.durable.map(row => row.event)
    const calls = events.filter(e => e.type === 'tool/call')
    const results = events.filter(e => e.type === 'tool/result')
    assert.equal(calls.length, results.length, `${name}: every recorded call must have a recorded result`)
    const callIds = new Set(calls.map(e => e.data.callId))
    for (const result of results) {
      const callId = result.data.message.content[0].toolCallId
      assert.ok(callIds.has(callId), `${name}: result for unknown call ${callId}`)
      assert.ok(result.time >= calls.find(e => e.data.callId === callId).time, `${name}: result precedes its call`)
    }
  }
})

test('every fixture records transient frames with a dense per-attempt index', () => {
  for (const name of listFixtures()) {
    const fixture = loadFixture(name)
    const byAttempt = new Map()
    for (const row of fixture.transient) {
      const frame = row.frame
      const list = byAttempt.get(frame.attemptId) ?? []
      list.push(frame)
      byAttempt.set(frame.attemptId, list)
    }
    assert.ok(byAttempt.size > 0, `${name}: no transient attempt recorded`)
    for (const [attemptId, frames] of byAttempt) {
      assert.equal(frames[0].type, 'start', `${name} ${attemptId}: an attempt must open with a start frame`)
      const chunks = frames.filter(frame => frame.type === 'chunk')
      assert.deepEqual(
        chunks.map(frame => frame.index),
        chunks.map((_, index) => index),
        `${name} ${attemptId}: chunk indices must be dense and zero-based`,
      )
      const ends = frames.filter(frame => frame.type === 'end')
      assert.equal(ends.length, 1, `${name} ${attemptId}: exactly one end frame`)
      assert.equal(ends[0].index, chunks.length, `${name} ${attemptId}: end index must equal the chunk count`)
    }
  }
})

test('a synthetic derivative names its source, its change, and never hides it', () => {
  const names = listDerived()
  assert.ok(names.length >= 4, `expected the synthetic set, found ${names.length}`)
  for (const name of names) {
    const fixture = loadDerived(name)
    const mutation = fixture.syntheticMutation
    assert.equal(typeof mutation.kind, 'string')
    assert.equal(typeof mutation.description, 'string')
    assert.equal(typeof mutation.sourceFixture, 'string')
    assert.equal(mutation.generator, 'dev/mutate-fixtures.mjs')
    assert.ok(Array.isArray(mutation.touched), 'the change must be enumerable')
    assert.equal(fixture.fixture, name)
    // The derivative must still be a full fixture, not a hand-written stub.
    assert.ok(fixture.durable.length > 5)
  }
})

test('a derivative of a fixture differs from its source only in the declared change', () => {
  // The `drop-reasoning-tokens` derivative must leave every other field alone;
  // that is what makes it a *minimal* transformation rather than a rewrite.
  const source = loadFixture('t5-reasoning-text-deepseek-official')
  const derived = loadDerived('d1-no-reasoning-tokens')
  assert.equal(derived.durable.length, source.durable.length)
  assert.equal(derived.transient.length, source.transient.length)

  let differences = 0
  for (let index = 0; index < source.durable.length; index += 1) {
    const a = JSON.stringify(source.durable[index].event)
    const b = JSON.stringify(derived.durable[index].event)
    if (a === b) continue
    differences += 1
    const event = source.durable[index].event
    assert.ok(SETTLEMENT_TYPES.has(event.type), `undeclared change on ${event.type} at ${index}`)
    const before = { ...source.durable[index].event.data.usage }
    const after = { ...derived.durable[index].event.data.usage }
    delete before.reasoningTokens
    assert.deepEqual(after, before, 'only reasoningTokens may be removed')
  }
  assert.equal(differences, derived.syntheticMutation.touched.filter(t => t.type !== 'in-stream usage chunk').length)
})
