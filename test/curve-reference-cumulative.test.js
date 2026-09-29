/**
 * Independent reference implementation of the Phase 9.2 phase-cumulative trace.
 *
 * Everything asserted here is computed by a **second algorithm**, written for this file
 * and sharing no code with `src/core/curve.js`. The curve module cannot be its own
 * witness for the estimator it implements: a reference that recovered its sample
 * magnitudes by differencing the curve's own `tps` column, or that reused the module's
 * episode cursor, would agree with any self-consistent defect. The Phase 7 audit found
 * the episode-opening defect precisely because the reference re-derived the definition
 * instead of reading it back.
 *
 * The reference is deliberately small. It restates the definition literally:
 *
 *   - the sample list is walked **once per vertex**, with no cursors and no state carried
 *     between vertices, so it cannot share a defect with the module's monotone scan;
 *   - the episode in force at a vertex is found by walking **left** from the newest
 *     sample at or before it, to the first phase change — the maximal run of consecutive
 *     same-phase samples containing it;
 *   - the rate is the literal `Math.round(mass * 1000 / elapsed)` of that episode's mass
 *     over its own clock, and the opening instant (`elapsed === 0`) publishes `0`;
 *   - the grid is the union of the attempt's `sampleEveryMs` ladder from local zero and
 *     the attempt's own end instant — its settlement when one is known and not earlier
 *     than its last delta, and its last delta otherwise.
 *
 * The comparison is vertex by vertex: every instant production emits must carry exactly
 * the reference's rate and label, no vertex may be missing, and the lengths must agree.
 *
 * ## Where the magnitudes come from
 *
 * The reference reads its magnitudes from the **script that was driven into the store**,
 * not from the settled snapshot: each generated delta's shape weight comes from
 * `heuristicTokenWeight`, and a calibrated case's magnitude is that weight times the
 * scale its own usage counters must induce. The scripts are ground truth, they are
 * written on the attempt-local clock the estimator is defined on, and the calibrated
 * scales are chosen so the induced allocation is exact — a case whose calibration did not
 * produce the expected magnitudes fails rather than hides.
 *
 * ## What the file covers
 *
 * Named cases for the semantics that are easy to get wrong — the phase-transition reset,
 * simultaneous timestamps, a settlement before the last delta, calibrated and
 * uncalibrated magnitudes, an attempt that produced nothing, and two attempts whose
 * compressed coordinates abut. Then a deterministic generated matrix over single- and
 * multi-attempt turns: steady, bursty, stalls, phase alternations, single-sample
 * episodes, simultaneous timestamps, zero-width attempts, with and without settlement
 * tails, at every magnitude mode. The matrix closes with coverage floors, so a change
 * that quietly made every generated case trivial fails rather than passes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'
import {
  DEFAULT_SAMPLE_EVERY_MS,
  MAX_SERIES_POINTS,
  attemptTrace,
  cumulativePhaseTpsSeries,
  peakTps,
} from '../src/core/curve.js'
import { compressAttempts } from '../src/core/time-axis.js'

const STEP_MS = DEFAULT_SAMPLE_EVERY_MS

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })

/**
 * One generated chunk whose shape weight is exactly `weight`.
 *
 * Latin text weighs a quarter per code point, so four code points per token. The
 * assertion is the generator's own guard: if the heuristic moved, every calibrated
 * expectation below would silently measure a different magnitude system.
 */
function chunkOf(kind, weight) {
  const text = 'x'.repeat(weight * 4)
  const measured = heuristicTokenWeight(text)
  assert.equal(measured, weight,
    `the generator assumes ${weight * 4} characters weigh ${weight}; measured ${measured}`)
  return kind === 'reasoning' ? reasoning(text) : output(text)
}

/**
 * How one case's usage counters scale its shape weights, and the usage object to drive.
 *
 * The scales are chosen so the induced allocation is exactly `weight * scale` for every
 * sample: `calibrated-split-2` maps each phase onto twice its own weight total (so both
 * the phase-anchored branch and the zero-counter branch scale by two), and
 * `calibrated-total-3` anchors one common factor of three across every sample.
 */
function magnitudePlan(spec) {
  const mode = spec.mode ?? 'estimated'
  const weights = spec.samples.map(sample => sample[2])
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const reasoningTotal = spec.samples
    .filter(sample => sample[1] === 'reasoning')
    .reduce((sum, sample) => sum + sample[2], 0)
  if (mode === 'estimated') return { scale: 1, usage: null }
  if (mode === 'calibrated-split-2') {
    return { scale: 2, usage: { outputTokens: 2 * total, reasoningTokens: 2 * reasoningTotal } }
  }
  if (mode === 'calibrated-total-3') {
    return { scale: 3, usage: { outputTokens: 3 * total } }
  }
  throw new Error(`unknown magnitude mode: ${mode}`)
}

/** The magnitude the estimator must read from one sample: calibrated tokens first, else the shape weight. */
function magnitudeOf(sample) {
  return sample.tokens ?? sample.weight ?? 0
}

/**
 * The independent reference series of one attempt, on the attempt-local clock.
 *
 * @param {{localMs:number, phase:string, tokens:number, weight:number}[]} samples
 * @param {{endMs:number, sampleEveryMs?:number}} options
 * @returns {{localMs:number, tps:number, activePhase:string|null}[]}
 */
function referenceSeries(samples, { endMs, sampleEveryMs = STEP_MS }) {
  const ordered = samples
    .map((sample, index) => ({ ...sample, order: index }))
    .sort((left, right) => left.localMs - right.localMs || left.order - right.order)

  /** The attempt's grid: its own cadence ladder, unioned with its real end instant. */
  const instants = []
  for (let step = 0; ; step += 1) {
    const at = step * sampleEveryMs
    if (at > endMs + 1e-9) break
    instants.push(at)
  }
  if (endMs > instants[instants.length - 1] + 1e-9) instants.push(endMs)

  return instants.map((at) => {
    /** The newest sample at or before the vertex, resolved by stream order at one instant. */
    let newest = -1
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].localMs <= at) newest = index
    }
    if (newest < 0) return { localMs: at, tps: 0, activePhase: null }
    /** The maximal same-phase run containing it: walk left to the first phase change. */
    let start = newest
    while (start > 0 && ordered[start - 1].phase === ordered[newest].phase) start -= 1
    let mass = 0
    for (let index = start; index <= newest; index += 1) mass += magnitudeOf(ordered[index])
    const elapsed = at - ordered[start].localMs
    return {
      localMs: at,
      tps: elapsed > 0 ? Math.round(mass * 1000 / elapsed) : 0,
      activePhase: ordered[newest].phase,
    }
  })
}

/**
 * Drive one turn through the store from a script written on the **attempt-local** clock.
 *
 * `specs` entries are `{id, step, samples: [[localMs, kind, weight], …], settledLocal,
 * mode}`. Attempts are placed apart on the wall clock so their stored timestamps are
 * distinct; the curve never reads the wall placement, only each attempt's own span.
 *
 * @returns {{curve: object, placed: {spec: object, wallStart: number, lastLocal: number}[]}}
 */
function drive(specs, { tools = [] } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const placed = []
  let wallCursor = 0

  for (const spec of specs) {
    const samples = spec.samples ?? []
    for (let index = 1; index < samples.length; index += 1) {
      assert.ok(samples[index][0] >= samples[index - 1][0],
        `${spec.id}: the script must be non-decreasing on its own clock`)
    }
    if (samples.length > 0) {
      assert.equal(samples[0][0], 0,
        `${spec.id}: attempt-local zero is the first delta; the script must open there`)
    }
    const wallStart = wallCursor
    const attempt = store.beginAttempt(record, { attemptId: spec.id, step: spec.step, startedAtMs: wallStart })
    for (const [localMs, kind, weight] of samples) {
      store.acceptChunk(record, attempt, { timeMs: wallStart + localMs, chunk: chunkOf(kind, weight) })
    }
    const lastLocal = samples.length === 0 ? 0 : samples[samples.length - 1][0]
    const plan = magnitudePlan(spec)
    store.settleAttempt(attempt, {
      settledAtMs: spec.settledLocal === null || spec.settledLocal === undefined
        ? null
        : wallStart + spec.settledLocal,
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
      usage: plan.usage,
      settlementSeq: spec.step ?? 1,
    })
    placed.push({ spec, wallStart, lastLocal })
    wallCursor = wallStart + lastLocal + 10_000
  }

  for (const tool of tools) {
    store.toolStarted(record, { callId: tool.callId, name: tool.name ?? 'pwsh', timeMs: tool.startMs })
    store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status ?? 'ok' })
  }

  const curve = store.endTurn(record, { timeMs: wallCursor + 5000, status: 'completed' }).curve
  return { curve, placed }
}

/**
 * The reference side of one turn: where each attempt sits on the compressed axis, what
 * its samples are, and the series the estimator must publish.
 *
 * Attempts that produced no generated delta own no coordinate and are skipped, which is
 * what `compressAttempts` does with them as well.
 */
function expectedOf(specs) {
  let offset = 0
  const entries = []
  for (const spec of specs) {
    const samples = spec.samples ?? []
    if (samples.length === 0) continue
    const lastLocal = samples[samples.length - 1][0]
    const endLocal = spec.settledLocal === null || spec.settledLocal === undefined
      ? lastLocal
      : Math.max(lastLocal, spec.settledLocal)
    const segment = { attemptId: spec.id, startMs: offset, endMs: offset + endLocal, localEndMs: endLocal }
    offset += endLocal
    const { scale } = magnitudePlan(spec)
    const localSamples = samples.map(([localMs, phase, weight], order) => ({
      attemptId: spec.id,
      localMs,
      phase,
      weight,
      tokens: weight * scale,
      order,
    }))
    entries.push({
      spec,
      segment,
      samples: localSamples,
      series: referenceSeries(localSamples, { endMs: endLocal }),
    })
  }
  return entries
}

/**
 * The joined attempts `curveSource` would hand to `compressAttempts`: every attempt's
 * samples carrying the calibrated magnitude the reference derived from the script.
 */
function joinedAttempts(specs, placed) {
  const byId = new Map(placed.map(entry => [entry.spec.id, entry]))
  return specs.map((spec) => {
    const { wallStart } = byId.get(spec.id)
    const { scale } = magnitudePlan(spec)
    return {
      attemptId: spec.id,
      settledAtMs: spec.settledLocal === null || spec.settledLocal === undefined
        ? null
        : wallStart + spec.settledLocal,
      samples: (spec.samples ?? []).map(([localMs, phase, weight]) => ({
        timeMs: wallStart + localMs,
        phase,
        weight,
        tokens: weight * scale,
        attemptId: spec.id,
      })),
    }
  })
}

/** Vertex-by-vertex agreement of one production series against the reference. */
function assertVertexAgreement(points, series, label) {
  assert.equal(points.length, series.length, `${label}: vertex count`)
  for (let index = 0; index < series.length; index += 1) {
    const point = points[index]
    const expected = series[index]
    assert.equal(point.localMs, expected.localMs,
      `${label}: vertex ${index} must sit at local ${expected.localMs}`)
    assert.equal(point.tps, expected.tps,
      `${label}: at local ${expected.localMs} the reference says ${expected.tps}, production says ${point.tps}`)
    assert.equal(point.activePhase, expected.activePhase,
      `${label}: at local ${expected.localMs} the label must be ${expected.activePhase}`)
  }
}

/**
 * Compare one driven turn against the reference, attempt by attempt.
 *
 * Three production surfaces are checked against the same reference series: the settled
 * snapshot's published points, the pure `attemptTrace` over the compressed evidence, and
 * a direct `cumulativePhaseTpsSeries` call. The compressed axis itself is checked first,
 * so a coordinate disagreement cannot be mistaken for an estimator disagreement.
 */
function compareTurn(driven, specs) {
  const { curve, placed } = driven
  const expected = expectedOf(specs)
  const compressed = compressAttempts(joinedAttempts(specs, placed))

  assert.deepEqual(
    compressed.segments.map(segment => [segment.attemptId, segment.startMs, segment.endMs, segment.localEndMs]),
    expected.map(entry => [entry.segment.attemptId, entry.segment.startMs, entry.segment.endMs, entry.segment.localEndMs]),
    'the compressed axis must place every attempt where the reference does',
  )
  assert.deepEqual(
    compressed.samples.map(sample => [sample.attemptId, sample.attemptTimeMs, sample.activeTimeMs, sample.sampleOrder]),
    expected.flatMap(entry => entry.samples.map(sample => (
      [sample.attemptId, sample.localMs, entry.segment.startMs + sample.localMs, sample.order]
    ))),
    'the compressed samples must carry the reference coordinates and stream order',
  )

  for (const entry of expected) {
    const { spec, segment, samples, series } = entry
    assert.ok(series.length <= MAX_SERIES_POINTS,
      `${spec.id}: the case must stay under the stored-series cap to be compared raw (${series.length} points)`)

    const published = curve.attempts.find(attempt => attempt.attemptId === spec.id)
    assert.ok(published !== undefined, `${spec.id}: the settled curve carries a trace`)
    assert.equal(published.sampleCount, samples.length, `${spec.id}: every sample is retained`)
    assert.equal(published.durationMs, segment.localEndMs, `${spec.id}: the trace runs to the attempt's own end`)
    assertVertexAgreement(published.points, series, `${spec.id} (settled)`)

    const trace = attemptTrace(
      compressed.segments.find(candidate => candidate.attemptId === spec.id),
      compressed.samples,
    )
    assertVertexAgreement(trace.points, series, `${spec.id} (attemptTrace)`)
    assert.deepEqual(trace.points, published.points,
      `${spec.id}: the pure helper and the settled snapshot must publish the same vertices`)

    const direct = cumulativePhaseTpsSeries(
      samples.map(sample => ({
        activeTimeMs: sample.localMs,
        phase: sample.phase,
        tokens: sample.tokens,
        weight: sample.weight,
      })),
      {
        sampleEveryMs: STEP_MS,
        /** `offsetMs` only relabels the emitted `timeMs`; `toMs` bounds the local clock. */
        offsetMs: segment.startMs,
        fromMs: 0,
        toMs: segment.localEndMs,
        sampleEndMs: segment.localEndMs,
      },
    )
    assert.equal(direct.length, series.length, `${spec.id}: the direct estimator emits every vertex`)
    for (let index = 0; index < series.length; index += 1) {
      assert.equal(direct[index].localMs, series[index].localMs, `${spec.id}: direct localMs`)
      assert.equal(direct[index].timeMs, segment.startMs + series[index].localMs, `${spec.id}: direct timeMs`)
      assert.equal(direct[index].tps, series[index].tps,
        `${spec.id}: at local ${series[index].localMs} the direct estimator says ${direct[index].tps}, `
        + `the reference says ${series[index].tps}`)
      assert.equal(direct[index].activePhase, series[index].activePhase,
        `${spec.id}: at local ${series[index].localMs} the direct label`)
    }

    const total = samples.reduce((sum, sample) => sum + magnitudeOf(sample), 0)
    assert.equal(published.tokens, total, `${spec.id}: the published attempt integral is the reference's mass`)
    if ((spec.mode ?? 'estimated') !== 'estimated') {
      assert.equal(published.calibrated, true, `${spec.id}: an anchored attempt is published as calibrated`)
      assert.equal(published.calibratedTokens, total, `${spec.id}: the calibrated integral is the anchored total`)
    }
  }

  assert.equal(curve.attempts.length, expected.length,
    'one trace per attempt that produced evidence, and no trace for one that did not')
  return { vertices: expected.reduce((sum, entry) => sum + entry.series.length, 0), expected }
}

// ---------------------------------------------------------------------------
// Named cases: the semantics that are easy to get wrong.
// ---------------------------------------------------------------------------

test('reference agreement: the episode clock resets at every phase transition', () => {
  const spec = {
    id: 'a',
    step: 1,
    mode: 'estimated',
    settledLocal: 700,
    samples: [[0, 'reasoning', 10], [100, 'reasoning', 10], [300, 'output', 10], [500, 'reasoning', 10]],
  }
  const driven = drive([spec])
  compareTurn(driven, [spec])
  /**
   * Reasoning, output, reasoning. Each transition opens a new episode: the output stretch
   * starts at its own sample, so its opening vertex is `0`, and the second reasoning
   * stretch does the same. The magnitude steps down at the boundary and climbs again on
   * the new episode's own evidence.
   */
  assert.deepEqual(
    driven.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    [
      [0, 0, 'reasoning'], [100, 200, 'reasoning'], [200, 100, 'reasoning'],
      [300, 0, 'output'], [400, 100, 'output'],
      [500, 0, 'reasoning'], [600, 100, 'reasoning'], [700, 50, 'reasoning'],
    ],
  )
  assert.equal(driven.curve.attempts[0].points[3].tps, 0,
    'the opening instant of a new episode carries no rate')
})

test('reference agreement: simultaneous timestamps follow the stream order', () => {
  /**
   * Two samples at one instant are ordered by the stream that delivered them. The
   * episode in force at that instant is the one the newer sample belongs to, so the same
   * pair of magnitudes reads as `output` or as `reasoning` depending on delivery order —
   * and the mass counted at the next vertex follows the same episode.
   */
  const reasoningFirst = {
    id: 'r-first',
    step: 1,
    mode: 'estimated',
    settledLocal: 100,
    samples: [[0, 'reasoning', 10], [0, 'output', 10], [100, 'output', 10]],
  }
  const outputFirst = {
    id: 'o-first',
    step: 1,
    mode: 'estimated',
    settledLocal: 100,
    samples: [[0, 'output', 10], [0, 'reasoning', 10], [100, 'reasoning', 10]],
  }
  const samePhase = {
    id: 'same',
    step: 1,
    mode: 'estimated',
    settledLocal: 100,
    samples: [[0, 'output', 10], [0, 'output', 10], [100, 'output', 10]],
  }

  const first = drive([reasoningFirst])
  compareTurn(first, [reasoningFirst])
  const second = drive([outputFirst])
  compareTurn(second, [outputFirst])
  const third = drive([samePhase])
  compareTurn(third, [samePhase])

  assert.deepEqual(
    first.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    [[0, 0, 'output'], [100, 200, 'output']],
    'delivered reasoning-then-output, the shared instant belongs to the output episode',
  )
  assert.deepEqual(
    second.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    [[0, 0, 'reasoning'], [100, 200, 'reasoning']],
    'delivered output-then-reasoning, the same instant belongs to the reasoning episode',
  )
  assert.deepEqual(
    third.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    [[0, 0, 'output'], [100, 300, 'output']],
    'two simultaneous same-phase samples both count toward one episode',
  )
})

test('reference agreement: a settlement before the last delta cannot shrink the attempt', () => {
  /**
   * Clock skew: the settlement is recorded 100 ms in, but the model kept producing to
   * 500 ms. The attempt's width is its real generation time, and the trace ends there.
   */
  const spec = {
    id: 'a',
    step: 1,
    mode: 'estimated',
    settledLocal: 100,
    samples: [[0, 'output', 10], [500, 'output', 10]],
  }
  const driven = drive([spec])
  compareTurn(driven, [spec])
  assert.equal(driven.curve.durationMs, 500, 'the attempt keeps its real generation time')
  assert.equal(driven.curve.attempts[0].points.at(-1).localMs, 500)
})

test('reference agreement: calibrated magnitudes are the published magnitudes', () => {
  /**
   * One script, three magnitude systems. The estimated twin carries the raw shape
   * weights; the anchored twins carry the same shape scaled so their integrals are the
   * provider's counters. The estimator is the same in all three — only the mass changes —
   * which is what makes the calibration join visible in the published numbers.
   */
  const base = {
    id: 'a',
    step: 1,
    samples: [[0, 'output', 10], [200, 'output', 10], [400, 'output', 10]],
    settledLocal: 500,
  }
  const estimated = { ...base, mode: 'estimated' }
  const doubled = { ...base, mode: 'calibrated-split-2' }
  const tripled = { ...base, mode: 'calibrated-total-3' }

  const plain = drive([estimated])
  compareTurn(plain, [estimated])
  const anchored = drive([doubled])
  compareTurn(anchored, [doubled])
  const common = drive([tripled])
  compareTurn(common, [tripled])

  assert.deepEqual(plain.curve.attempts[0].points.map(point => point.tps),
    [0, 100, 100, 67, 75, 60], 'the raw shape weights')
  assert.deepEqual(anchored.curve.attempts[0].points.map(point => point.tps),
    [0, 200, 200, 133, 150, 120], 'each sample scaled to twice its shape weight')
  assert.deepEqual(common.curve.attempts[0].points.map(point => point.tps),
    [0, 300, 300, 200, 225, 180], 'one common factor of three over every sample')

  assert.equal(plain.curve.attempts[0].tokens, 30)
  assert.equal(plain.curve.attempts[0].calibrated, false)
  assert.equal(plain.curve.attempts[0].calibratedTokens, null)
  assert.equal(plain.curve.source.calibrationCoverage, 'none')
  assert.equal(anchored.curve.attempts[0].tokens, 60, 'the anchored integral is the provider total')
  assert.equal(anchored.curve.attempts[0].calibrated, true)
  assert.equal(anchored.curve.attempts[0].calibratedTokens, 60)
  assert.equal(anchored.curve.source.calibrationCoverage, 'full')
  assert.equal(common.curve.attempts[0].calibrated, true)
  assert.equal(common.curve.attempts[0].tokens, 90)

  /** A mixed-phase attempt calibrated per phase: reasoning and output each scaled by two. */
  const mixed = {
    id: 'b',
    step: 1,
    mode: 'calibrated-split-2',
    settledLocal: 400,
    samples: [[0, 'reasoning', 10], [100, 'reasoning', 10], [300, 'output', 10]],
  }
  const mixedDriven = drive([mixed])
  compareTurn(mixedDriven, [mixed])
  assert.deepEqual(mixedDriven.curve.attempts[0].points.map(point => point.tps),
    [0, 400, 200, 0, 200], 'reasoning scaled to its own counter, output to its own')
  assert.equal(mixedDriven.curve.attempts[0].tokens, 60)
})

test('reference agreement: an attempt with no generated delta owns no trace and no width', () => {
  const empty = { id: 'empty', step: 1, mode: 'estimated', settledLocal: 5000, samples: [] }
  const real = {
    id: 'real',
    step: 2,
    mode: 'estimated',
    settledLocal: 200,
    samples: [[0, 'output', 10], [100, 'output', 10]],
  }
  const together = drive([empty, real])
  compareTurn(together, [empty, real])
  assert.equal(together.curve.attempts.length, 1, 'only the attempt that produced evidence is drawn')
  assert.equal(together.curve.segments.length, 1, 'and only it owns a coordinate')
  assert.equal(together.curve.segments[0].startMs, 0, 'the empty attempt consumes no width')

  const alone = drive([real])
  assert.deepEqual(
    together.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    alone.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    'the attempt after it measures exactly what it measures alone',
  )
})

test('reference agreement: abutting attempts are measured on their own clocks', () => {
  /**
   * The compressed axis concatenates the two attempts, so their coordinates touch. The
   * episode clocks do not: B opens on A's last coordinate and measures none of A's mass.
   * The strongest form of the claim is that each trace is identical whether it is driven
   * alone or beside the other call.
   */
  const first = {
    id: 'A',
    step: 1,
    mode: 'estimated',
    settledLocal: 700,
    samples: [[0, 'output', 10], [500, 'output', 10]],
  }
  const second = {
    id: 'B',
    step: 2,
    mode: 'estimated',
    settledLocal: 600,
    samples: [[0, 'output', 10], [300, 'reasoning', 10], [600, 'reasoning', 10]],
  }
  const together = drive([first, second])
  compareTurn(together, [first, second])
  assert.equal(together.curve.segments[1].startMs, together.curve.segments[0].endMs,
    'the two attempts share one compressed coordinate')
  assert.equal(together.curve.durationMs, 1300, 'the axis is the two attempts\' own widths')

  const [traceA, traceB] = together.curve.attempts
  assert.deepEqual(traceA.points.map(point => [point.localMs, point.tps]),
    [[0, 0], [100, 100], [200, 50], [300, 33], [400, 25], [500, 40], [600, 33], [700, 29]])
  assert.deepEqual(traceB.points.map(point => [point.localMs, point.tps, point.activePhase]),
    [[0, 0, 'output'], [100, 100, 'output'], [200, 50, 'output'],
      [300, 0, 'reasoning'], [400, 100, 'reasoning'], [500, 50, 'reasoning'], [600, 67, 'reasoning']])
  assert.equal(traceB.points[0].timeMs, traceA.points.at(-1).timeMs,
    'B opens on the coordinate A\'s clock stopped at')
  assert.equal(traceB.points[0].tps, 0, 'and it measures none of A\'s mass')

  const aloneA = drive([first])
  const aloneB = drive([second])
  assert.deepEqual(
    traceA.points.map(point => [point.localMs, point.tps, point.activePhase]),
    aloneA.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    'A reads the same wherever it sits on the axis',
  )
  assert.deepEqual(
    traceB.points.map(point => [point.localMs, point.tps, point.activePhase]),
    aloneB.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    'and so does B, whatever the neighbouring call measured',
  )
})

// ---------------------------------------------------------------------------
// Generated cases: a deterministic matrix over turn shapes and magnitude modes.
// ---------------------------------------------------------------------------

/** Deterministic 32-bit generator, so a failure is reproducible from its seed alone. */
function seeded(seed) {
  let state = (seed >>> 0) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 1_000_000) / 1_000_000
  }
}

/**
 * The generated set. Six shapes cycle with a seeded stream of gaps, weights, phases,
 * tails and magnitude modes:
 *
 *   0 steady            regular cadence, one phase
 *   1 bursty            random gaps, phases drawn per sample
 *   2 alternating       phase blocks of one to three samples
 *   3 stall             every gap is a long silence inside one phase
 *   4 single sample     one delta only, sometimes of zero width
 *   5 simultaneous      the second sample shares the first's instant, opposite phase
 */
function generatedSpecs(count) {
  const specs = []
  for (let index = 0; index < count; index += 1) {
    const random = seeded(0x5eed + index * 7919)
    const pick = list => list[Math.floor(random() * list.length)]
    const shape = index % 6
    const sampleCount = shape === 4 ? 1 : 2 + Math.floor(random() * 6)
    const samples = []
    let at = 0
    let phase = pick(['reasoning', 'output'])
    let blockRemaining = 0

    for (let step = 0; step < sampleCount; step += 1) {
      if (step > 0) {
        let gap = pick([0, 37, 50, 100, 150, 250, 500, 999, 1500])
        if (shape === 0) gap = pick([100, 150, 250])
        if (shape === 3) gap = pick([999, 1500])
        if (shape === 5 && step === 1) gap = 0
        at += gap
      }
      let kind
      if (shape === 5 && step === 1) {
        kind = samples[0][1] === 'reasoning' ? 'output' : 'reasoning'
      } else if (shape === 1 || shape === 5) {
        kind = pick(['reasoning', 'output'])
      } else if (shape === 2) {
        if (blockRemaining === 0) {
          if (step > 0) phase = phase === 'reasoning' ? 'output' : 'reasoning'
          blockRemaining = 1 + Math.floor(random() * 3)
        }
        blockRemaining -= 1
        kind = phase
      } else {
        kind = phase
      }
      samples.push([at, kind, pick([1, 10, 25, 100])])
    }

    const tail = index % 5 === 4 ? null : [0, 37, 250, 510][index % 4]
    specs.push({
      id: `g${index}`,
      step: index + 1,
      samples,
      settledLocal: tail === null ? null : at + tail,
      mode: ['estimated', 'calibrated-split-2', 'calibrated-total-3'][index % 3],
    })
  }
  return specs
}

/** Structural coverage of a generated set, computed from the scripts alone. */
function coverageOf(specs) {
  let multiEpisode = 0
  let singleSampleEpisodes = 0
  let simultaneous = 0
  let zeroWidth = 0
  let tails = 0
  let calibrated = 0
  for (const spec of specs) {
    const runs = []
    for (const sample of spec.samples) {
      const last = runs[runs.length - 1]
      if (last === undefined || last.phase !== sample[1]) runs.push({ phase: sample[1], count: 1 })
      else last.count += 1
    }
    if (runs.length > 1) multiEpisode += 1
    singleSampleEpisodes += runs.filter(run => run.count === 1).length
    if (spec.samples.some((sample, index) => index > 0 && sample[0] === spec.samples[index - 1][0])) {
      simultaneous += 1
    }
    const last = spec.samples[spec.samples.length - 1][0]
    const endLocal = spec.settledLocal === null ? last : Math.max(last, spec.settledLocal)
    if (endLocal === 0) zeroWidth += 1
    if (endLocal > last) tails += 1
    if ((spec.mode ?? 'estimated') !== 'estimated') calibrated += 1
  }
  return { multiEpisode, singleSampleEpisodes, simultaneous, zeroWidth, tails, calibrated }
}

test('generated turns: every published vertex agrees with the independent reference', () => {
  const specs = generatedSpecs(60)
  let vertices = 0
  for (const spec of specs) {
    const driven = drive([spec])
    vertices += compareTurn(driven, [spec]).vertices
  }

  const coverage = coverageOf(specs)
  assert.ok(vertices > 500, `the generated set covered ${vertices} vertices`)
  assert.ok(coverage.multiEpisode >= 20,
    `only ${coverage.multiEpisode} of ${specs.length} generated turns had multiple episodes`)
  assert.ok(coverage.singleSampleEpisodes >= 15,
    `only ${coverage.singleSampleEpisodes} single-sample episodes were exercised`)
  assert.ok(coverage.simultaneous >= 8,
    `only ${coverage.simultaneous} generated turns carried simultaneous timestamps`)
  assert.ok(coverage.zeroWidth >= 2, `only ${coverage.zeroWidth} zero-width attempts were exercised`)
  assert.ok(coverage.tails >= 20, `only ${coverage.tails} generated turns carried a settlement tail`)
  assert.ok(coverage.calibrated >= 20, `only ${coverage.calibrated} generated turns were calibrated`)
})

test('generated turns: two attempts per turn abut and never share a clock', () => {
  const specs = generatedSpecs(24)
  let pairs = 0
  for (let index = 0; index + 1 < specs.length; index += 2) {
    const pair = [specs[index], specs[index + 1]]
    const driven = drive(pair)
    compareTurn(driven, pair)
    assert.equal(driven.curve.segments[1].startMs, driven.curve.segments[0].endMs,
      `${pair[0].id}/${pair[1].id}: the second attempt opens where the first ended`)
    assert.equal(driven.curve.segments[1].startMs, driven.curve.segments[0].localEndMs,
      `${pair[0].id}/${pair[1].id}: the join is the first attempt's own width`)
    pairs += 1
  }
  assert.ok(pairs >= 12, `only ${pairs} two-attempt turns were exercised`)
})

test('the published peak is the maximum of the independently re-derived series', () => {
  const specs = generatedSpecs(30)
  for (const spec of specs) {
    const driven = drive([spec])
    const { expected } = compareTurn(driven, [spec])
    const referencePeak = Math.max(...expected.flatMap(entry => entry.series.map(point => point.tps)))
    assert.equal(driven.curve.peakTps, referencePeak,
      `${spec.id}: the published peak must be the reference maximum`)
  }

  /**
   * And on a multi-attempt turn it is the largest single attempt, never a sum: the heavy
   * call peaks at 1000 and the light one at 200, so the turn peak is 1000 rather than
   * 1200.
   */
  const heavy = {
    id: 'heavy',
    step: 1,
    mode: 'estimated',
    settledLocal: 500,
    samples: [[0, 'output', 100], [400, 'output', 100]],
  }
  const light = {
    id: 'light',
    step: 2,
    mode: 'estimated',
    settledLocal: 200,
    samples: [[0, 'output', 10], [100, 'output', 10]],
  }
  const together = drive([heavy, light])
  const { expected } = compareTurn(together, [heavy, light])
  const referenceMax = Math.max(...expected.flatMap(entry => entry.series.map(point => point.tps)))
  assert.equal(together.curve.peakTps, referenceMax)
  assert.equal(together.curve.peakTps, 1000)
  assert.notEqual(together.curve.peakTps, 1200, 'the peak is never the two attempts added together')
  assert.equal(together.curve.peakTps, peakTps(...together.curve.attempts.map(attempt => attempt.points)),
    'and it is the maximum of the published per-attempt series')
})
