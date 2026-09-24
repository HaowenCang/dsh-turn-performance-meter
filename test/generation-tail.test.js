/**
 * Generation-tail measurement, reproduced offline from the recorded fixtures.
 *
 * This is the evidence behind the frozen decision in `docs/METRICS_SPEC.md` §7:
 * the phase-duration denominator ends at the last non-empty model-producing
 * delta, and the interval up to the durable settlement is **not** charged.
 *
 * The decision rests on three facts, all measured here:
 *   1. for every attempt that completed normally, the last recorded chunk is the
 *      stream's own `finish` chunk, and it arrives within a few milliseconds of
 *      the settlement;
 *   2. the settlement therefore trails the *stream*, not the decode loop, and
 *      the gap is host commit work;
 *   3. the gap is not proportional to generation length, which is what a
 *      decode-bearing interval would look like.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { listFixtures, loadFixture } from './helpers/fixtures.js'
import { durableSettledView } from './helpers/equivalence.js'
import { isTokenDelta } from '../src/core/delta-accounting.js'

/** Measure the tail and the generation span of every attempt in every fixture. */
function measureAll() {
  const rows = []
  for (const name of listFixtures()) {
    const view = durableSettledView(loadFixture(name))
    for (const attempt of view.reconstructed.attempts) {
      const generated = attempt.chunks.filter(entry => isTokenDelta(entry.chunk))
      const last = generated.at(-1) ?? null
      const first = generated[0] ?? null
      const lastChunk = attempt.chunks.at(-1) ?? null
      rows.push({
        fixture: name,
        settlementSeq: attempt.settlementSeq,
        interrupted: attempt.interrupted,
        firstDeltaMs: first?.timeMs ?? null,
        lastDeltaMs: last?.timeMs ?? null,
        lastChunkType: lastChunk?.chunk?.type ?? null,
        lastChunkMs: lastChunk?.timeMs ?? null,
        settlementTimeMs: attempt.settledAtMs,
        tailMs: last === null ? null : attempt.settledAtMs - last.timeMs,
        spanMs: first === null || last === null ? null : last.timeMs - first.timeMs,
      })
    }
  }
  return rows
}

const rows = measureAll()
const settled = rows.filter(row => !row.interrupted)

test('every recorded settlement was measured, so the conclusion is not based on a subset', () => {
  assert.ok(rows.length >= 10, `expected at least 10 recorded attempts, measured ${rows.length}`)
  assert.ok(settled.length >= 9)
  for (const row of rows) {
    assert.ok(Number.isFinite(row.tailMs), `${row.fixture}#${row.settlementSeq} has no measurable tail`)
    assert.ok(row.tailMs >= 0, `${row.fixture}#${row.settlementSeq} settled before its last delta`)
  }
})

test('a normally completed attempt ends its stream before the durable settlement', () => {
  for (const row of settled) {
    assert.equal(
      row.lastChunkType,
      'finish',
      `${row.fixture}#${row.settlementSeq}: the last recorded chunk should be the stream's own finish`,
    )
    assert.ok(
      row.lastChunkMs >= row.lastDeltaMs,
      `${row.fixture}#${row.settlementSeq}: finish must not precede the last delta`,
    )
  }
})

test('the settlement trails the stream finish, which makes the tail host commit work', () => {
  // Measured range: 1 ms to 8 ms between the stream's own finish and the durable
  // settlement. The bound is deliberately loose — it is asserting an order of
  // magnitude, not a machine-specific constant.
  for (const row of settled) {
    const streamTailMs = row.settlementTimeMs - row.lastChunkMs
    assert.ok(
      streamTailMs >= 0 && streamTailMs <= 20,
      `${row.fixture}#${row.settlementSeq}: finish -> settlement gap was ${streamTailMs} ms`,
    )
  }
})

test('the tail is a near-constant host cost, not a function of generation length', () => {
  const spans = settled.map(row => row.spanMs)
  const tails = settled.map(row => row.tailMs)
  const longest = settled.reduce((best, row) => (row.spanMs > best.spanMs ? row : best), settled[0])

  assert.ok(Math.max(...spans) > 20000, 'the set must contain a long generation to compare against')
  assert.ok(Math.max(...tails) <= 100, `the largest normal tail was ${Math.max(...tails)} ms`)
  // The 33.8 s attempt has a single-digit tail; a decode-bearing interval would
  // have grown with the stream.
  assert.ok(longest.tailMs <= 50, `the longest attempt had a ${longest.tailMs} ms tail`)
})

test('an interrupted attempt has no finish chunk and a larger settle gap, which is finalization', () => {
  const interrupted = rows.filter(row => row.interrupted)
  assert.ok(interrupted.length >= 1, 'the fixture set must contain a real interruption')
  for (const row of interrupted) {
    assert.notEqual(row.lastChunkType, 'finish', 'an aborted stream never emits finish')
    assert.equal(row.lastChunkType, 'reasoning-delta')
    // The 260 ms measured here is prefix finalization and durable commit, i.e.
    // precisely the class of work the policy refuses to charge to decode.
    assert.ok(row.tailMs > 100, `interrupted finalization cost measured ${row.tailMs} ms`)
  }
})

test('charging the tail would change a short attempt materially and a long one almost not at all', () => {
  // Stated as a ratio so the decision is justified by magnitude, not taste.
  const ratios = settled
    .filter(row => row.spanMs > 0)
    .map(row => ({ fixture: row.fixture, seq: row.settlementSeq, ratio: row.tailMs / row.spanMs }))
  const worst = ratios.reduce((best, row) => (row.ratio > best.ratio ? row : best), ratios[0])
  const best = ratios.reduce((best, row) => (row.ratio < best.ratio ? row : best), ratios[0])

  assert.ok(worst.ratio > 0.1, 'at least one short attempt is materially affected by the tail')
  assert.ok(best.ratio < 0.01, 'at least one long attempt is effectively unaffected by the tail')
})
