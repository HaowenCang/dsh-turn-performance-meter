/**
 * Generation-tail measurement, reproduced offline from the recorded fixtures.
 *
 * The measurements in this file are unchanged since Phase 2; what they *mean*
 * changed in Phase 9.2. Three facts, all measured here:
 *
 *   1. for every attempt that completed normally, the last recorded chunk is the
 *      stream's own `finish` chunk, and it arrives within a few milliseconds of
 *      the settlement;
 *   2. the settlement therefore trails the *stream*, not the decode loop, and the
 *      last-delta -> settlement gap is host commit and prefix-finalization work;
 *   3. the gap is not proportional to generation length, which is what a
 *      decode-bearing interval would look like.
 *
 * The old policy used those facts to **exclude** the trailing interval from the
 * phase-duration denominator (`docs/METRICS_SPEC.md` §7, superseded). Phase 9.2
 * charges it to the terminal phase episode instead: the target statistic is
 * MiMo's phase-episode wall time (`outputTokens / (settlementTime -
 * outputStartTime)`), under which the terminal generated-delta -> settlement tail
 * is model-attempt elapsed time. The measurements below are therefore kept as
 * the *size of what is now charged*, and the terminal-episode assertions state
 * the new rule directly:
 *
 *     terminal episode duration = settledAtMs - first sample of that episode
 *
 * and `null` — never `0` — when no settlement was observed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { listFixtures, loadFixture } from './helpers/fixtures.js'
import { durableSettledView } from './helpers/equivalence.js'
import { classifyDelta, isTokenDelta } from '../src/core/delta-accounting.js'
import { phaseEpisodes } from '../src/core/phase-duration.js'

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

/** The engine's sample list for one decoded attempt: generated deltas only. */
function samplesOf(attempt) {
  const samples = []
  for (const entry of attempt.chunks) {
    const phase = classifyDelta(entry.chunk)
    if (phase === null) continue
    samples.push({ timeMs: entry.timeMs, phase })
  }
  return samples
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

test('the settlement trails the stream finish by a near-constant host cost', () => {
  // Measured range: 1 ms to 8 ms between the stream's own finish and the durable
  // settlement. This is the interval Phase 9.2 charges to the terminal episode,
  // together with the last-delta -> finish interval: the measurement is retained,
  // the decision about what the denominator means changed. The bound is
  // deliberately loose — it is asserting an order of magnitude, not a
  // machine-specific constant.
  for (const row of settled) {
    const streamTailMs = row.settlementTimeMs - row.lastChunkMs
    assert.ok(
      streamTailMs >= 0 && streamTailMs <= 20,
      `${row.fixture}#${row.settlementSeq}: finish -> settlement gap was ${streamTailMs} ms`,
    )
  }
})

test('the charged tail is a near-constant host cost, not a function of generation length', () => {
  const spans = settled.map(row => row.spanMs)
  const tails = settled.map(row => row.tailMs)
  const longest = settled.reduce((best, row) => (row.spanMs > best.spanMs ? row : best), settled[0])

  assert.ok(Math.max(...spans) > 20000, 'the set must contain a long generation to compare against')
  assert.ok(Math.max(...tails) <= 100, `the largest normal tail was ${Math.max(...tails)} ms`)
  // The 33.8 s attempt has a single-digit tail, so charging it cannot distort a
  // long attempt; a decode-bearing interval would have grown with the stream.
  assert.ok(longest.tailMs <= 50, `the longest attempt had a ${longest.tailMs} ms tail`)
})

test('an interrupted attempt has no finish chunk and a larger settle gap, which is finalization', () => {
  const interrupted = rows.filter(row => row.interrupted)
  assert.ok(interrupted.length >= 1, 'the fixture set must contain a real interruption')
  for (const row of interrupted) {
    assert.notEqual(row.lastChunkType, 'finish', 'an aborted stream never emits finish')
    assert.equal(row.lastChunkType, 'reasoning-delta')
    // The 260 ms measured here is prefix finalization and durable commit, i.e.
    // host work rather than decode work. Phase 9.2 still charges it to the
    // terminal episode as model-attempt elapsed time, and this measurement is
    // what makes the size of that charge visible.
    assert.ok(row.tailMs > 100, `interrupted finalization cost measured ${row.tailMs} ms`)
  }
})

test('the charged tail is a material share of a short attempt and a negligible share of a long one', () => {
  // Stated as a ratio so the cost of the Phase 9.2 decision is visible by
  // magnitude rather than by taste.
  const ratios = settled
    .filter(row => row.spanMs > 0)
    .map(row => ({ fixture: row.fixture, seq: row.settlementSeq, ratio: row.tailMs / row.spanMs }))
  const worst = ratios.reduce((best, row) => (row.ratio > best.ratio ? row : best), ratios[0])
  const best = ratios.reduce((best, row) => (row.ratio < best.ratio ? row : best), ratios[0])

  assert.ok(worst.ratio > 0.1, 'at least one short attempt is materially affected by the tail')
  assert.ok(best.ratio < 0.01, 'at least one long attempt is effectively unaffected by the tail')
})

test('a completed attempt charges the terminal tail, and an unobserved settlement is null — never zero', () => {
  /**
   * The Phase 9.2 rule, asserted on every recorded attempt. The expected start of
   * the terminal episode is derived independently of the engine — the last
   * maximal run of one phase in the sample list — and the duration must then be
   * exactly `settledAtMs - that start`. Two degenerate forms are pinned too: an
   * unknown settlement instant is `null`, and a settlement stamped before the
   * episode's own evidence cannot shrink it (clock skew is refused), never `0`.
   */
  let checked = 0
  for (const name of listFixtures()) {
    const view = durableSettledView(loadFixture(name))
    for (const attempt of view.reconstructed.attempts) {
      const label = `${name}#${attempt.settlementSeq}`
      const samples = samplesOf(attempt)
      assert.ok(samples.length > 0, `${label}: a contributing attempt carries samples`)
      assert.ok(Number.isFinite(attempt.settledAtMs), `${label}: the recorded settlement carries an instant`)

      /** The terminal episode's first sample: the last maximal same-phase run. */
      let startIndex = samples.length - 1
      while (startIndex > 0 && samples[startIndex - 1].phase === samples[startIndex].phase) startIndex -= 1
      const terminalStartMs = samples[startIndex].timeMs
      const lastSampleMs = samples[samples.length - 1].timeMs
      assert.ok(attempt.settledAtMs >= lastSampleMs,
        `${label}: the recorded settlement trails the stream rather than skewing it`)

      const terminal = phaseEpisodes(samples, attempt.settledAtMs).at(-1)
      assert.equal(terminal.startMs, terminalStartMs,
        `${label}: the terminal episode starts at its first sample`)
      assert.equal(terminal.endMs, attempt.settledAtMs,
        `${label}: and ends at the attempt's settlement instant`)
      assert.equal(terminal.durationMs, attempt.settledAtMs - terminalStartMs,
        `${label}: the terminal generated-delta -> settlement tail is charged to it`)
      assert.ok(terminal.durationMs > 0,
        `${label}: a settlement later than the episode start is measurable`)

      /** No settlement instant: the same episode is unmeasurable, not zero. */
      const unobserved = phaseEpisodes(samples, null).at(-1)
      assert.equal(unobserved.durationMs, null, `${label}: no settlement, no duration`)
      assert.notEqual(unobserved.durationMs, 0, `${label}: null is "not measurable", never a measured zero`)
      assert.equal(unobserved.endMs, null, `${label}: and there is no end instant either`)

      /**
       * A settlement stamped at the episode's own start is clock skew. It cannot
       * pull the episode below the evidence it contains: the end is the later of
       * the settlement and the episode's last sample, and a single-sample episode
       * (which has no span of its own) is the case that reports `null`.
       */
      const skewed = phaseEpisodes(samples, terminalStartMs).at(-1)
      assert.equal(skewed.endMs, Math.max(terminalStartMs, lastSampleMs),
        `${label}: a skewed settlement never pulls the episode below its own last sample`)
      assert.equal(skewed.durationMs,
        lastSampleMs > terminalStartMs ? lastSampleMs - terminalStartMs : null,
        `${label}: the episode keeps its measured span`)
      assert.notEqual(skewed.durationMs, 0)

      checked += 1
    }
  }
  assert.ok(checked >= 10, `expected the recorded attempts, checked ${checked}`)
})
