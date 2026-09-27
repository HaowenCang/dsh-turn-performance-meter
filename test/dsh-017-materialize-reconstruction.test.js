/**
 * Phase 7D.1.1 — the reconstruction-materialization API's start boundary.
 *
 * `materializeReconstructedTurn()` exists to turn a turn's retained durable rows
 * into a normal `TurnTelemetryStore` record. The module's own docstring freezes
 * one rule about where the record's start may come from:
 *
 *     A turn start may only come from actual durable `turn/start` evidence.
 *
 * `reconstructFromDurable()` already honours that rule: `turnStartMs` is `null`
 * unless the turn's own `turn/start` row is in the evidence. The exported
 * materialization function is the last place where the rule can be undone, and
 * on baseline `dd4b194` it was: the `timeMs` input parameter reached
 * `store.beginTurn()` as `reconstructed.turnStartMs ?? timeMs`, so any caller
 * holding an arbitrary finite wall clock could hand the reconstructed turn a
 * start it never observed.
 *
 * That is not a cosmetic signature wart. `startMs` is the anchor every
 * start-dependent metric is measured from, so a fabricated start propagates into
 * TTFT and into turn elapsed — the two numbers whose whole value is that they
 * were measured. The defect is latent rather than live only because the one
 * production caller (`src/client/live/controller.js`, the `turn/end` lookup-miss
 * path) happens not to pass `timeMs`; the exported API still permits it, and a
 * permitted fabrication is a contract defect whether or not today's caller uses
 * it.
 *
 * The correction removes the parameter rather than ignoring it, so the
 * fabrication is not expressible at the API level. These tests are therefore
 * stated against the rule, not against the parameter: they assert `null`, and
 * they pass an adversarial clock through the object spread, which is the only
 * route that remains open once the named parameter is gone.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { materializeReconstructedTurn } from '../src/dsh/reconstruction.js'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { loadTargetFixture } from './helpers/fixtures.js'

const SESSION = 'fixture-mujjrw4r-1'
const TURN = 1

const FIXTURE = loadTargetFixture('t01-sequential-tools')
/** The recorded start boundary, deliberately excluded from every tail below. */
const DURABLE_TURN_START = FIXTURE.durable.find(row => row.event.type === 'turn/start').event
const DURABLE_TURN_END = FIXTURE.durable.find(row => row.event.type === 'turn/end').event

/**
 * The durable tail this defect is stated against: settlements and a terminal
 * boundary, and no `turn/start`. It is the shape a live window has when its tail
 * has slid past the opening row.
 */
const TAIL_WITHOUT_START = FIXTURE.durable
  .map(row => row.event)
  .filter(event => event.type !== 'turn/start' && event.seq <= DURABLE_TURN_END.seq)

/** A plausible, finite, and entirely invented wall clock. */
const FAKE_TIME_MS = 9000000000000

/** Materialize a tail and close it, the way the controller's miss path does. */
function materializeAndClose(events, extraInput) {
  const store = new TurnTelemetryStore()
  const materialized = materializeReconstructedTurn({
    store,
    sessionId: SESSION,
    turn: TURN,
    events,
    ...extraInput,
  })
  const settled = store.endTurn(materialized.record, {
    timeMs: DURABLE_TURN_END.time,
    status: 'completed',
  })
  return { store, ...materialized, settled }
}

test('the reconstruction fixture is non-trivial and really omits turn/start', () => {
  assert.equal(TAIL_WITHOUT_START.some(event => event.type === 'turn/start'), false, 'no start boundary in the tail')
  assert.equal(TAIL_WITHOUT_START.filter(event => event.type === 'assistant/message').length, 3)
  assert.equal(TAIL_WITHOUT_START.filter(event => event.type === 'tool/call').length, 2)
  assert.equal(TAIL_WITHOUT_START.filter(event => event.type === 'tool/result').length, 2)
  assert.equal(TAIL_WITHOUT_START.at(-1).type, 'turn/end', 'the terminal boundary is present')
  assert.equal(DURABLE_TURN_START.seq, 4, 'the excluded opening row is the recorded turn/start')
})

test('a caller-supplied clock cannot invent a reconstructed turn start', () => {
  /**
   * Pre-fix evidence, recorded on baseline
   * `dd4b194a349fe9a3dd9b126bd84241dff82221c7` with
   * `timeMs: 9000000000000` and no `turn/start` row in the events:
   *
   *     record.startMs        null  ->  9000000000000   (the caller's clock)
   *     record.firstTokenMs   1790497154164             (durable, unchanged)
   *     settled.ttftMs        null  ->  0               (clamped, not measured)
   *     settled.turnElapsedMs null  ->  0               (clamped, not measured)
   *
   * The interval fields are the sharper half of the defect. The invented start
   * is far in the future of the recorded first token, so `aggregateTurn` clamps
   * the negative intervals to zero: instead of reporting an *unavailable* metric,
   * the card reports a **measured-looking `0 ms`** that no evidence produced. The
   * three `null` assertions below all failed on that baseline.
   */
  const { record, settled, reconstructed } = materializeAndClose(TAIL_WITHOUT_START, { timeMs: FAKE_TIME_MS })

  assert.equal(reconstructed.turnStartMs, null, 'the durable parser observed no start')
  assert.equal(record.startMs, null, 'no start may be fabricated from a caller clock')
  assert.equal(settled.ttftMs, null, 'TTFT is an interval from a start nobody observed')
  assert.equal(settled.turnElapsedMs, null, 'and so is turn elapsed')
  assert.notEqual(record.startMs, FAKE_TIME_MS, 'the arbitrary clock is not adopted as a boundary')
  assert.notEqual(settled.ttftMs, 0, 'and an unobserved interval is absent, not a measured zero')
  assert.notEqual(settled.turnElapsedMs, 0, 'likewise for elapsed')
  /** What the tail *does* establish is untouched by the fix. */
  assert.equal(record.firstTokenMs, 1790497154164, 'the durable first-token stamp is still recovered')
  assert.equal(record.attempts.length, 3)
  assert.equal(record.tools.length, 2)
  assert.equal(settled.generatedTokens, 147)
})

test('an adversarial clock smuggled past the named parameter still cannot invent a start', () => {
  /**
   * With the parameter removed, `{...extra}` remains the only way a caller can
   * put `timeMs` on the input object. It must be inert: the input is destructured
   * by name, and no unnamed member reaches the store.
   */
  const { record, settled } = materializeAndClose(TAIL_WITHOUT_START, { timeMs: FAKE_TIME_MS, startMs: FAKE_TIME_MS, turnStartMs: FAKE_TIME_MS })
  assert.equal(record.startMs, null)
  assert.equal(settled.ttftMs, null)
  assert.equal(settled.turnElapsedMs, null)
})

test('the same tail with its turn/start present still measures TTFT and elapsed', () => {
  /**
   * The non-fabrication rule must not become a refusal to use real evidence. When
   * the opening row *is* in the events, the reconstructed start is the recorded
   * one and both intervals are computable — the phase-7D.1 reference values for
   * this fixture.
   */
  const events = FIXTURE.durable.map(row => row.event).filter(event => event.seq <= DURABLE_TURN_END.seq)
  const { record, settled } = materializeAndClose(events)

  assert.equal(record.startMs, 1790497151824, 'the observed start is adopted')
  assert.equal(settled.turnElapsedMs, 6938, 'elapsed is measured from it')
  assert.equal(typeof settled.ttftMs, 'number', 'and TTFT is computable')
})
