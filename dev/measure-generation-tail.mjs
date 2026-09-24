/**
 * Generation-tail duration: the measurement that fixes the phase-duration
 * policy's last open question.
 *
 * `docs/METRICS_SPEC.md` §7 leaves one branch open: whether the interval from an
 * attempt's last generated delta to its settlement may be charged to the decode
 * denominator. Charging it is only correct when the settlement timestamp tracks
 * model decoding rather than host commit bookkeeping.
 *
 * This script measures that directly on the recorded fixtures:
 *
 *   tailMs = assistant settlement event time
 *          - last non-empty model-producing delta time
 *
 * and reports it per attempt, next to the generation span it would extend, so
 * the decision can be made on observed numbers instead of convenience.
 *
 *   node dev/measure-generation-tail.mjs [--json]
 *
 * Nothing here writes a file or changes a policy; the conclusion is recorded in
 * `docs/IMPLEMENTATION_LOG.md` and `docs/METRICS_SPEC.md`.
 */

import { listFixtures, loadFixture } from '../test/helpers/fixtures.js'
import { durableSettledView } from '../test/helpers/equivalence.js'
import { isTokenDelta } from '../src/core/delta-accounting.js'

const asJson = process.argv.includes('--json')
const rows = []

for (const name of listFixtures()) {
  const fixture = loadFixture(name)
  const view = durableSettledView(fixture)

  for (const attempt of view.reconstructed.attempts) {
    const generated = attempt.chunks.filter(entry => isTokenDelta(entry.chunk))
    const lastDelta = generated.length > 0 ? generated[generated.length - 1] : null
    const firstDelta = generated.length > 0 ? generated[0] : null
    const lastChunk = attempt.chunks.at(-1) ?? null
    const usageChunk = [...attempt.chunks].reverse().find(entry => entry.chunk?.type === 'usage') ?? null
    const finishChunk = [...attempt.chunks].reverse().find(entry => entry.chunk?.type === 'finish') ?? null

    rows.push({
      fixture: name,
      settlementSeq: attempt.settlementSeq,
      eventType: attempt.settlementEventType,
      step: attempt.step,
      generatedDeltaCount: generated.length,
      totalChunkCount: attempt.chunks.length,
      firstDeltaMs: firstDelta?.timeMs ?? null,
      lastDeltaMs: lastDelta?.timeMs ?? null,
      lastChunkType: lastChunk?.chunk?.type ?? null,
      lastChunkMs: lastChunk?.timeMs ?? null,
      usageChunkMs: usageChunk?.timeMs ?? null,
      finishChunkMs: finishChunk?.timeMs ?? null,
      settlementTimeMs: attempt.settledAtMs,
      /** The number under investigation. */
      tailMs: lastDelta !== null && Number.isFinite(attempt.settledAtMs)
        ? attempt.settledAtMs - lastDelta.timeMs
        : null,
      /** What the tail would add relative to the observed generation span. */
      generationSpanMs: firstDelta !== null && lastDelta !== null ? lastDelta.timeMs - firstDelta.timeMs : null,
      usage: attempt.usage,
      interrupted: attempt.interrupted,
    })
  }
}

if (asJson) {
  console.log(JSON.stringify({ measurements: rows }, null, 2))
} else {
  const header = ['fixture', 'seq', 'step', 'deltas', 'span_ms', 'tail_ms', 'tail/span', 'last_chunk', 'settled']
  console.log(header.join('\t'))
  for (const row of rows) {
    const ratio = row.tailMs !== null && row.generationSpanMs > 0
      ? (row.tailMs / row.generationSpanMs).toFixed(3)
      : 'n/a'
    console.log([
      row.fixture,
      row.settlementSeq,
      row.step,
      row.generatedDeltaCount,
      row.generationSpanMs ?? 'n/a',
      row.tailMs ?? 'n/a',
      ratio,
      row.lastChunkType ?? 'n/a',
      row.interrupted ? 'interrupted' : 'ok',
    ].join('\t'))
  }

  const tails = rows.map(row => row.tailMs).filter(value => Number.isFinite(value))
  const spans = rows.map(row => row.generationSpanMs).filter(value => Number.isFinite(value) && value > 0)
  const summary = {
    attempts: rows.length,
    attemptsWithTail: tails.length,
    minTailMs: tails.length > 0 ? Math.min(...tails) : null,
    maxTailMs: tails.length > 0 ? Math.max(...tails) : null,
    meanTailMs: tails.length > 0 ? tails.reduce((a, b) => a + b, 0) / tails.length : null,
    minSpanMs: spans.length > 0 ? Math.min(...spans) : null,
    maxSpanMs: spans.length > 0 ? Math.max(...spans) : null,
  }
  console.log('\nsummary')
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key}: ${typeof value === 'number' ? value.toFixed(2) : value}`)
  }
}
