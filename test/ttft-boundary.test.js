/**
 * Phase 9.4 — the turn TTFT boundary is DSH's own first-token predicate.
 *
 * ## The defect this file freezes
 *
 * `isTokenDelta` (`dsh-llm/lib/types/assistant-stream.js`, 0.2.0-rc.2) answers
 * `true` for a **name-bearing** `tool-call-delta` even when `argumentsDelta` is
 * empty — the model has begun emitting a call and its name is the evidence:
 *
 *     case 'tool-call-delta':
 *         return chunk.argumentsDelta !== '' || chunk.name !== undefined;
 *
 * The plugin's own `isTokenDelta` says the same thing, and the adapter publishes
 * it as the normalized `countsAsToken` fact. Three consumers nevertheless
 * disagreed with that fact before this phase:
 *
 *   - `classifyDelta` returns `null` for that chunk (there is no argument text to
 *     attribute), so `sampleFromChunk` returns `null`;
 *   - `controller.ATTEMPT_DELTA` returned early on `sample === null`, so the
 *     presenter never learned a delta happened and the machine stayed in
 *     `pending-first-token`;
 *   - `LiveMeter.firstTokenMs` was frozen only by `acceptSample`, which requires
 *     a positive magnitude, so the turn TTFT stayed unavailable — the pill kept
 *     rendering the 首响应计时 stopwatch after the model had already produced its
 *     first token boundary.
 *
 * ## The invariant frozen here
 *
 *     countsAsToken === true
 *       => firstTokenMs is frozen exactly once, at that chunk's timestamp
 *       => the live machine leaves PENDING_FIRST_TOKEN
 *
 * and this holds **without fabricating a token magnitude**: the boundary chunk
 * contributes no TPS-shape mass and no episode sample, so it can never publish a
 * rate of its own. A `tool-call-delta` with **no name and empty arguments** is
 * not token evidence at all and must stay ignored.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createController } from '../src/client/live/controller.js'
import { LiveUiState } from '../src/client/live/live-state.js'
import { MODEL_PHASE, classifyDelta, isTokenDelta, tokenEvidence } from '../src/core/delta-accounting.js'
import { turnKey } from '../src/core/types.js'
import { attemptFromDecoded } from '../src/dsh/adapter.js'
import { decodeStreamRecords } from '../src/dsh/stream-decoder.js'
import { durableEntry, fakeSessionsService, transientEntry } from './helpers/live-replay.js'

const SESSION = 's-ttft'

/** A name-bearing tool-call delta whose argument fragment has not arrived yet. */
const NAME_ONLY_DELTA = Object.freeze({
  type: 'tool-call-delta',
  index: 0,
  id: 'call_1',
  name: 'pwsh',
  argumentsDelta: '',
})

/** The same shape DSH's accumulator can emit with a degraded, empty name. */
const EMPTY_NAME_DELTA = Object.freeze({
  type: 'tool-call-delta',
  index: 0,
  id: 'call_1',
  name: '',
  argumentsDelta: '',
})

/** No name and no arguments: not token evidence under any reading. */
const ANONYMOUS_EMPTY_DELTA = Object.freeze({
  type: 'tool-call-delta',
  index: 0,
  id: 'call_1',
  argumentsDelta: '',
})

/**
 * Drive one hand-built window through the real controller.
 *
 * Entries are appended one at a time (the live tail), and the presentation is
 * captured after each, which is what lets a test assert both "the value is
 * frozen" and "the view never returns to an earlier stage".
 */
function drive(entries) {
  const sessions = fakeSessionsService()
  const source = sessions.createSource(SESSION)
  const controller = createController({ sessions })
  assert.equal(controller.attach(SESSION), true, 'the fake binding must be resolvable')

  const captures = []
  let revision = 0
  let nowMs = 0
  const capture = () => {
    captures.push({ atMs: nowMs, view: controller.project(SESSION, nowMs) })
  }
  capture()
  for (const entry of entries) {
    nowMs = entry.type === 'event' ? entry.event.time : entry.event.time
    source.appendEntry(entry, (revision += 1))
    capture()
  }
  return {
    controller,
    captures,
    entries,
    nowMs,
    kinds: () => captures.map(entry => entry.view.kind),
    /** The live meter snapshot at the last observed instant. */
    snapshot: () => controller.store.liveSnapshot(SESSION, nowMs),
    record: () => controller.store.turns.get(turnKey(SESSION, 1)) ?? null,
    dispose: () => controller.dispose(),
  }
}

test('a name-bearing tool-call delta with empty arguments freezes the live TTFT boundary', () => {
  const replay = drive([
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    transientEntry('a1', 1_100, NAME_ONLY_DELTA),
  ])
  try {
    const snapshot = replay.snapshot()
    assert.equal(snapshot.ttftMs, 100,
      'the boundary instant is the turn TTFT: first token at 1100 against turn start 1000')
    assert.equal(snapshot.tps, null,
      'a boundary-only delta carries no magnitude, so it cannot publish a rate')
    assert.equal(snapshot.episodeSampleCount, 0,
      'and it contributes no sample to the episode it opens')

    const record = replay.record()
    assert.equal(record.firstTokenMs, 1_100,
      'the settled record freezes the same instant the live meter did')
    assert.equal(record.attempts[0].samples.length, 0,
      'no token magnitude is fabricated merely to repair TTFT')

    const kinds = replay.kinds()
    assert.equal(kinds.at(-1), 'warming',
      'the UI leaves the first-response stopwatch: the boundary is frozen and the episode is warming')
    assert.equal(kinds.includes('ttft'), true, 'the stopwatch existed before the boundary')
    assert.equal(kinds.slice(kinds.indexOf('warming')).includes('ttft'), false,
      'and it is never rendered again in this turn')
  } finally {
    replay.dispose()
  }
})

test('the same boundary holds for the empty-name form DSH can emit', () => {
  const replay = drive([
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    transientEntry('a1', 1_120, EMPTY_NAME_DELTA),
  ])
  try {
    assert.equal(replay.snapshot().ttftMs, 120,
      'DSH tests `name !== undefined`, so an empty name is still a name-bearing delta')
    assert.notEqual(replay.kinds().at(-1), 'ttft')
  } finally {
    replay.dispose()
  }
})

test('a no-name tool-call delta with empty arguments is not token evidence', () => {
  const replay = drive([
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    transientEntry('a1', 1_100, ANONYMOUS_EMPTY_DELTA),
  ])
  try {
    const snapshot = replay.snapshot()
    assert.equal(snapshot.ttftMs, null,
      'no name and no arguments is not the model\'s first token by any predicate')
    assert.equal(replay.record().firstTokenMs, null)
    assert.equal(replay.kinds().at(-1), 'ttft',
      'the first-response stopwatch is still the honest view')
  } finally {
    replay.dispose()
  }
})

test('a tool call and its result cannot return the turn to first-response timing', () => {
  const replay = drive([
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    transientEntry('a1', 1_100, NAME_ONLY_DELTA),
    durableEntry('tool/call', 2, 1_200, { turn: 1, step: 1, callId: 'call_1', name: 'pwsh' }),
    durableEntry('tool/result', 3, 1_400, {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'call_1' },
    }),
    transientEntry('a2', 1_500, NAME_ONLY_DELTA, { turn: 1, step: 2 }),
  ])
  try {
    const kinds = replay.kinds()
    const firstBoundary = kinds.indexOf('warming')
    assert.ok(firstBoundary > 0, 'the boundary produced a non-ttft view')
    assert.equal(kinds.slice(firstBoundary).includes('ttft'), false,
      'the tool stage, the tool result and the next attempt all keep the frozen boundary')
    assert.equal(replay.snapshot().ttftMs, 100,
      'TTFT is measured once per turn and is never redefined by a later call')
    for (const entry of replay.captures.slice(firstBoundary)) {
      assert.notEqual(entry.view.kind, 'ttft', `no first-response timing at ${entry.atMs} ms`)
    }
  } finally {
    replay.dispose()
  }
})

test('ordinary reasoning and text deltas keep their existing TTFT', () => {
  const reasoning = drive([
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    transientEntry('a1', 1_050, { type: 'reasoning-delta', index: 0, text: 'think' }),
    transientEntry('a1', 1_060, { type: 'text-delta', index: 1, text: 'answer' }),
  ])
  try {
    assert.equal(reasoning.snapshot().ttftMs, 50,
      'the first reasoning delta freezes TTFT at its own instant, as before')
    assert.equal(reasoning.record().firstTokenMs, 1_050)
    assert.equal(reasoning.snapshot().tps, null, 'one sample is still below the warm-up gate')
  } finally {
    reasoning.dispose()
  }

  const text = drive([
    durableEntry('turn/start', 1, 2_000, { turn: 1 }),
    transientEntry('a1', 2_030, { type: 'text-delta', index: 0, text: 'answer' }),
  ])
  try {
    assert.equal(text.snapshot().ttftMs, 30)
    assert.equal(text.kinds().at(-1), 'warming')
  } finally {
    text.dispose()
  }
})

test('a name-bearing delta that also carries arguments keeps its TPS-shape sample', () => {
  const replay = drive([
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    transientEntry('a1', 1_100, {
      type: 'tool-call-delta',
      index: 0,
      id: 'call_1',
      name: 'pwsh',
      argumentsDelta: '{"command":"ls"}',
    }),
  ])
  try {
    assert.equal(replay.snapshot().ttftMs, 100)
    assert.equal(replay.record().firstTokenMs, 1_100)
    assert.equal(replay.record().attempts[0].samples.length, 1,
      'an argument-bearing delta is still a real generated sample')
    assert.equal(replay.snapshot().episodeSampleCount, 1)
  } finally {
    replay.dispose()
  }
})

test('the durable reconstruction reports the same first-token instant as the live boundary', () => {
  /**
   * The same evidence, read from a compact durable stream instead of the
   * transient plane. A reload must not change what the turn's first token was:
   * `assistantStreamFirstTokenTime` and the live `isTokenDelta` boundary are one
   * rule, so the two reconstructions must agree to the millisecond.
   */
  const records = [
    { type: 'tool-call-chunks', time0: 1_100, index: 0, dt: [], id: 'call_1', name: 'pwsh', args: [''] },
    {
      type: 'tool-call-chunks',
      time0: 1_150,
      index: 0,
      dt: [10, 10],
      id: 'call_1',
      name: 'pwsh',
      args: ['{"command"', ':"ls"', '}'],
    },
  ]
  const decoded = decodeStreamRecords(records)
  assert.equal(decoded.complete, true, 'the fixture decodes exactly')

  const attempt = attemptFromDecoded({ attemptId: 'a1', turn: 1, step: 1, decoded })
  assert.equal(attempt.firstTokenMs, 1_100,
    'the name-bearing empty-argument run is the first token, so the reconstructed TTFT matches live')
  assert.equal(attempt.samples.length, 3,
    'and only the argument-bearing members become TPS-shape samples')
})

test('a reload rebuilds the same TTFT the live session froze', () => {
  const stream = [
    { type: 'tool-call-chunks', time0: 1_100, index: 0, dt: [], id: 'call_1', name: 'pwsh', args: [''] },
  ]
  const replay = drive([
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    /**
     * The durable settlement with its embedded compact stream, exactly as the
     * window publishes it after a reload: no transient rows survive, so the
     * attempt is restored from the decode.
     */
    durableEntry('assistant/message', 2, 1_250, {
      turn: 1,
      step: 1,
      stream,
      usage: { outputTokens: 0, reasoningTokens: null },
    }),
    durableEntry('turn/end', 3, 1_300, { turn: 1, reason: { kind: 'completed' } }),
  ])
  try {
    const record = replay.record()
    assert.equal(record.firstTokenMs, 1_100,
      'the restored turn freezes the durable first-token instant')
    assert.equal(record.settled.ttftMs, 100,
      'so the completed card reports the same 100 ms the live pill would have reported')
    assert.equal(replay.kinds().at(-1), 'completed')
  } finally {
    replay.dispose()
  }
})

test('the machine still owns exactly one first-response stage per turn', () => {
  const replay = drive([
    durableEntry('turn/start', 1, 1_000, { turn: 1 }),
    transientEntry('a1', 1_100, NAME_ONLY_DELTA),
    durableEntry('step/start', 2, 1_150, { turn: 1, step: 2 }),
    durableEntry('step/start', 3, 1_160, { turn: 1, step: 3 }),
  ])
  try {
    assert.equal(replay.kinds().includes('ttft'), true, 'the stage was visited once, before the boundary')
    assert.equal(replay.kinds().indexOf('ttft'), 1)
    assert.equal(LiveUiState.PENDING_FIRST_TOKEN, 'pending-first-token')
    assert.notEqual(replay.kinds().at(-1), 'ttft',
      'a later step boundary resolves to waiting-model and never re-enters the TTFT stage')
  } finally {
    replay.dispose()
  }
})

test('the boundary verdict separates "is a token" from "carries a magnitude"', () => {
  /**
   * §9's shape facts, asserted where the defect actually lived.
   *
   * Exactly one chunk shape makes DSH's first-token predicate and this project's
   * phase classifier disagree: a **name-bearing** `tool-call-delta` with an empty
   * `argumentsDelta`. `tokenEvidence` is the one place that resolves the
   * disagreement, and it resolves it in the only direction that keeps both facts
   * true: the chunk **is** the model's first token (`countsAsToken`) and it carries
   * **no** token magnitude (`contributesMagnitude`), so it freezes TTFT without
   * fabricating a sample.
   *
   * The table is the whole surface: three predicates over nine chunk shapes, with
   * the two equivalences that make the verdict consistent rather than a fourth
   * opinion. The behavioural half of the same contract — no sample emitted, the
   * episode sample count untouched — is driven through the store in
   * `test/phase94-regressions.test.js`, which is the file that can also be executed
   * against released v0.1.2.
   *
   * That baseline claim cannot be made for this test: v0.1.2 has no `tokenEvidence`,
   * so importing it here makes the whole file fail to load on the release (the six
   * pre-existing tests in this file were proven red against v0.1.2 before this import
   * was added). The verdict is asserted here because this is where the other
   * `isTokenDelta` facts live; its *consequences* are the ones the regression file
   * re-proves on any tree.
   */
  const OUTPUT = MODEL_PHASE.OUTPUT
  const REASONING = MODEL_PHASE.REASONING
  const shapes = [
    [NAME_ONLY_DELTA, true, OUTPUT, false],
    [EMPTY_NAME_DELTA, true, OUTPUT, false],
    [ANONYMOUS_EMPTY_DELTA, false, null, false],
    [{ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'pwsh', argumentsDelta: '{"command":"ls"}' },
      true, OUTPUT, true],
    [{ type: 'reasoning-delta', index: 0, text: 'think' }, true, REASONING, true],
    [{ type: 'text-delta', index: 0, text: 'answer' }, true, OUTPUT, true],
    [{ type: 'reasoning-delta', index: 0, text: '' }, false, null, false],
    [{ type: 'usage', usage: { outputTokens: 10 } }, false, null, false],
    [{ type: 'block-start', index: 0 }, false, null, false],
  ]

  for (const [chunk, countsAsToken, phase, contributesMagnitude] of shapes) {
    const label = `${chunk.type}${chunk.name === undefined ? '' : ` name=${JSON.stringify(chunk.name)}`}`
    const evidence = tokenEvidence(chunk)
    assert.deepEqual(evidence, { countsAsToken, phase, contributesMagnitude }, `the verdict for ${label}`)
    assert.equal(evidence.countsAsToken, isTokenDelta(chunk),
      `${label}: the boundary is DSH's own predicate, not a second opinion`)
    assert.equal(evidence.contributesMagnitude, classifyDelta(chunk) !== null,
      `${label}: a magnitude exists exactly when a phase attributes one`)
    if (evidence.countsAsToken) {
      assert.equal(evidence.phase, classifyDelta(chunk) ?? OUTPUT,
        `${label}: the boundary's phase falls back to output only where nothing was attributed`)
    }
  }

  /** The one disagreement, stated on its own: it is the TTFT defect in one line. */
  assert.equal(isTokenDelta(NAME_ONLY_DELTA), true)
  assert.equal(classifyDelta(NAME_ONLY_DELTA), null)
  assert.equal(tokenEvidence(NAME_ONLY_DELTA).countsAsToken, true)
  assert.equal(tokenEvidence(NAME_ONLY_DELTA).contributesMagnitude, false,
    'the repair is a boundary, never a magnitude: the delta has no argument text to weigh')
})
