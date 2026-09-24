/**
 * Live-vs-durable equivalence on real DSH recordings.
 *
 * Every fixture is one real turn recorded from the local DSH 0.1.5-rc.2 host
 * (`dev/fixture-recorder`), so these assertions are about observed evidence
 * rather than about a hand-written example.
 *
 * The requirement: for the same completed turn, path A (transient plane plus
 * durable boundaries) and path B (durable settlements only) must agree on
 *   phase segmentation, reasoning/output/generated token totals, active
 *   generation duration, compressed chart coordinates, peak TPS, tool-argument
 *   output accounting, tool durations, TTFT and the quality metadata,
 * with a numerical tolerance allowed only where `METRICS_SPEC.md` defines one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { listFixtures, loadFixture } from './helpers/fixtures.js'
import {
  chunksOf,
  compareTuples,
  durableSettledView,
  liveSettledView,
  metricTuple,
  phaseSegments,
} from './helpers/equivalence.js'
import { isTokenDelta } from '../src/core/delta-accounting.js'

const names = listFixtures()

function assertEquivalent(a, b, context) {
  const { exact, tolerant, semantic } = compareTuples(a, b)
  const failures = semantic.map(item => `${item.path}: ${JSON.stringify(item.left)} vs ${JSON.stringify(item.right)}`)
  assert.deepEqual(failures, [], `${context}: semantic differences between the live and durable paths`)
  return { exactCount: exact.length, tolerantCount: tolerant.length }
}

test('every recorded fixture is discoverable and self-describing', () => {
  assert.ok(names.length >= 5, `expected the recorded fixture set, found ${names.length}`)
  for (const name of names) {
    const fixture = loadFixture(name)
    assert.equal(fixture.fixture, name)
    assert.equal(typeof fixture.dshVersion, 'string')
    assert.equal(typeof fixture.scenario, 'string')
    assert.ok(fixture.durable.length > 0, `${name} has no durable events`)
    assert.ok(fixture.summary.turnStartCount >= 1, `${name} has no turn/start`)
    assert.ok(fixture.transient.length > 0, `${name} has no transient frames`)
    assert.equal(fixture.syntheticMutation, undefined, `${name} is a committed fixture and must not be synthetic`)
  }
})

for (const name of names) {
  test(`${name}: the live path and the durable path agree on every metric`, () => {
    const fixture = loadFixture(name)
    const live = liveSettledView(fixture)
    const durable = durableSettledView(fixture)
    const liveMetrics = metricTuple(live)
    const durableMetrics = metricTuple(durable)

    assertEquivalent(liveMetrics, durableMetrics, name)

    // The comparison must be a real one: if either path had produced nothing,
    // the equality above would be vacuous.
    assert.ok(liveMetrics.chart.coordinates.length > 0, `${name}: live path produced no chart samples`)
    assert.ok(durableMetrics.chart.coordinates.length > 0, `${name}: durable path produced no chart samples`)
    assert.equal(
      liveMetrics.chart.coordinates.length,
      durableMetrics.chart.coordinates.length,
      `${name}: the two paths disagree on how many generated deltas exist`,
    )
  })

  test(`${name}: the client-folded live-chunk form is equivalent to the host frame form`, () => {
    const fixture = loadFixture(name)
    const fromFrames = metricTuple(liveSettledView(fixture))
    const fromLiveChunks = metricTuple(liveSettledView(fixture, { useLiveChunks: true }))
    assertEquivalent(fromFrames, fromLiveChunks, `${name} (frame form vs client-folded form)`)
  })

  test(`${name}: the durable decode is lossless against the recorded transient frames`, () => {
    const fixture = loadFixture(name)
    // The strongest available claim about losslessness: for every attempt, the
    // decoded durable stream and the recorded live frames contain the same
    // generated deltas at the same timestamps in the same order. This is what
    // makes path A and path B independent *readings of the same evidence*.
    const durable = durableSettledView(fixture)
    const live = liveSettledView(fixture)
    const durableChunks = chunksOf(durable).filter(entry => isTokenDelta(entry.chunk))
    const liveChunks = chunksOf(live).filter(entry => isTokenDelta(entry.chunk))

    assert.equal(durableChunks.length, liveChunks.length, `${name}: generated delta count differs`)
    assert.deepEqual(
      durableChunks.map(entry => `${entry.timeMs}:${entry.chunk.type}:${entry.chunk.text ?? entry.chunk.argumentsDelta ?? ''}`),
      liveChunks.map(entry => `${entry.timeMs}:${entry.chunk.type}:${entry.chunk.text ?? entry.chunk.argumentsDelta ?? ''}`),
      `${name}: the compact durable stream did not reproduce the live delta sequence exactly`,
    )
  })
}

test('t1: two attempts with two sequential tools are segmented identically', () => {
  const fixture = loadFixture('t1-reasoning-tool-reasoning')
  const live = metricTuple(liveSettledView(fixture))
  const durable = metricTuple(durableSettledView(fixture))

  assert.equal(durable.attemptCount, 2, 't1 was recorded with two model attempts')
  assert.equal(durable.toolCount, 2, 't1 was recorded with two tool calls')
  assert.equal(durable.toolNameSequence, 'pwsh,pwsh', 'two sequential calls to the same tool')
  assert.equal(durable.toolNames, 'pwsh', 'the compact label deduplicates the tool name')
  assert.equal(durable.usageComplete, true)
  assert.equal(durable.splitComplete, false, 'this route does not report reasoningTokens')
  assert.equal(durable.quality.tokenTotalQuality, 'exact')
  assert.equal(durable.quality.phaseSplitQuality, 'estimated')
  assert.equal(durable.quality.temporalShapeQuality, 'reconstructed')
  assert.deepEqual(durable.chart.coordinates, live.chart.coordinates)
  assert.deepEqual(durable.attempts.map(a => a.phases), live.attempts.map(a => a.phases))
})

test('t2: four attempts mixing pwsh, write and edit are segmented identically', () => {
  const fixture = loadFixture('t2-pwsh-write-edit')
  const live = metricTuple(liveSettledView(fixture))
  const durable = metricTuple(durableSettledView(fixture))

  assert.equal(durable.attemptCount, 4)
  assert.equal(durable.toolNameSequence, 'write,edit,pwsh')
  assert.ok(durable.toolArgumentBytes > 200, 'write and edit payloads must be counted as model output')
  assert.equal(durable.toolArgumentBytes, live.toolArgumentBytes)
  // The first attempt carries reasoning and a tool call in the same attempt, so
  // its segmentation has two phases in a fixed order.
  assert.deepEqual(durable.attempts[0].phases.map(segment => segment.phase), ['reasoning', 'output'])
  assert.deepEqual(live.attempts[0].phases.map(segment => segment.phase), ['reasoning', 'output'])
  assert.equal(durable.toolWorkMs >= durable.toolWallMs, true)
})

test('t4: the deepseek-official route reports an exact reasoning split on both paths', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const live = metricTuple(liveSettledView(fixture))
  const durable = metricTuple(durableSettledView(fixture))

  assert.equal(durable.splitComplete, true, 'this route reports reasoningTokens')
  assert.equal(durable.quality.tokenTotalQuality, 'exact')
  assert.equal(durable.quality.phaseSplitQuality, 'exact')
  assert.equal(durable.quality.temporalShapeQuality, 'reconstructed')
  assert.equal(live.quality.phaseSplitQuality, 'exact')
  assert.equal(durable.reasoningTokens + durable.nonReasoningTokens, durable.generatedTokens)
  assert.equal(live.generatedTokens, durable.generatedTokens)
})

test('t5: a 1300-delta attempt decodes to the same chart on both paths', () => {
  const fixture = loadFixture('t5-reasoning-text-deepseek-official')
  const live = liveSettledView(fixture)
  const durable = durableSettledView(fixture)
  const liveMetrics = metricTuple(live)
  const durableMetrics = metricTuple(durable)

  assert.ok(durableMetrics.chart.coordinates.length > 1200, 't5 is the long-stream fixture')
  assert.ok(liveMetrics.chart.coordinates.length > 1200)
  assert.equal(liveMetrics.chart.durationMs, durableMetrics.chart.durationMs)
  assert.equal(liveMetrics.chart.peakTps, durableMetrics.chart.peakTps)
  assert.equal(durable.quality.phaseSplitQuality, 'exact')
  assert.equal(live.quality.phaseSplitQuality, 'exact')

  // Intra-stream stalls must survive: the reasoning phase spans seconds while
  // carrying 1038 deltas, so at least one second-long window is not empty.
  assert.ok(durableMetrics.reasoningMs > 1000, 't5 reasoning lasts more than one second')
  assert.ok(durableMetrics.outputMs > 1000, 't5 output lasts more than one second')
})
test('t3: an interrupted turn settles identically and is never reported as completed', () => {
  const fixture = loadFixture('t3-interrupted-mid-reasoning')
  const live = liveSettledView(fixture)
  const durable = durableSettledView(fixture)
  const liveMetrics = metricTuple(live)
  const durableMetrics = metricTuple(durable)

  assert.equal(durableMetrics.status, 'interrupted')
  assert.equal(liveMetrics.status, 'interrupted')
  assert.equal(durableMetrics.quality.tokenTotalQuality, 'unavailable', 'no usage was reported for the aborted attempt')
  assert.equal(durableMetrics.generatedTokens, null)
  assert.equal(durableMetrics.observedGeneratedTokens, 0)
  assert.ok(durableMetrics.chart.coordinates.length > 600, 'the partial stream is still real evidence')
  assertEquivalent(liveMetrics, durableMetrics, 't3')
})

test('phase segmentation is identical element-by-element, not merely equal in count', () => {
  for (const name of names) {
    const fixture = loadFixture(name)
    const live = liveSettledView(fixture)
    const durable = durableSettledView(fixture)
    assert.deepEqual(
      durable.record.attempts.map(attempt => phaseSegments(attempt)),
      live.record.attempts.map(attempt => phaseSegments(attempt)),
      `${name}: phase segmentation differs`,
    )
  }
})
