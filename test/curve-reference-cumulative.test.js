/**
 * Independent reference implementation of the Phase 9.4 phase-cumulative trace.
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
 *   - the episodes are the maximal runs of consecutive same-phase samples, and the episode
 *     in force at a vertex is found by walking **left** from the newest sample at or before
 *     it to the first phase change;
 *   - the vertex grid is **each episode's own** `sampleEveryMs` ladder — from that episode's
 *     origin to the next episode's origin, or to the attempt's end for the terminal episode —
 *     unioned over the episodes, with the attempt's own end instant appended when the ladders
 *     do not already stop there. An episode opening off the cadence is therefore sampled from
 *     its own origin, and no vertex of it exists one remainder-step later;
 *   - the rate is the literal `Math.round(mass * 1000 / elapsed)` of that episode's mass over
 *     its own clock, and it is published **only** when the episode holds at least three
 *     contributing samples **and** at least 100 ms of its own elapsed time. Every other
 *     vertex publishes `null` — never `0` — together with the fact that withholds it
 *     (`opening-anchor`, `below-elapsed-horizon`, `below-sample-warmup`, `no-episode`) and the
 *     episode facts that explain the refusal.
 *
 * The two thresholds and the reason vocabulary are restated here as **literals** rather than
 * imported from `src/core/rate-publication.js`: an oracle that read the policy it is meant to
 * witness would agree with a silently changed threshold, and the whole point of this file is
 * that the contract is witnessed twice. `test/curve-rate-publication.test.js` freezes the
 * shared module's own values independently.
 *
 * The comparison is vertex by vertex **and field by field**: every instant production emits
 * must carry exactly the reference's instant, rate, availability flag, unavailability reason,
 * phase label and episode facts (`episodeStartMs`, `episodeElapsedMs`, `episodeSampleCount`,
 * `episodeMass`), no vertex may be missing, and the lengths must agree.
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
 * tails, at every magnitude mode. The matrix closes with coverage floors over both the
 * turn shapes and the publication outcome — publishable vertices and withheld ones — so a
 * change that quietly made every generated case trivial, or that made every vertex
 * publishable, fails rather than passes.
 *
 * Because a rate needs three contributing samples, every episode a named case asserts a
 * **number** for carries at least three deltas; episodes deliberately left below the gates
 * carry the withheld form of the same assertion (`tps: null` plus its reason).
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

/**
 * The publication policy of `src/core/rate-publication.js`, restated as literals.
 *
 * These are not imports on purpose: the reference must be able to disagree with the shipped
 * gate, and an import would make it structurally unable to.
 */
const REFERENCE_MIN_SAMPLES = 3
const REFERENCE_MIN_ELAPSED_MS = 100

/** Why a vertex carries no rate, restated as literals for the same reason. */
const REFERENCE_REASON = Object.freeze({
  NO_EPISODE: 'no-episode',
  OPENING_ANCHOR: 'opening-anchor',
  BELOW_ELAPSED_HORIZON: 'below-elapsed-horizon',
  BELOW_SAMPLE_WARMUP: 'below-sample-warmup',
})

/** Every field, beyond the instant, that a vertex must carry for the comparison to be exact. */
const VERTEX_FIELDS = [
  'tps',
  'publishable',
  'rateUnavailableReason',
  'activePhase',
  'episodeStartMs',
  'episodeElapsedMs',
  'episodeSampleCount',
  'episodeMass',
]

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
 * Why one in-force episode publishes no rate, in the order the facts are missing.
 *
 * The episode's own opening anchor outranks the elapsed horizon, which outranks the sample
 * count — the same order `rateAvailability` states, restated here rather than imported.
 */
function reasonAt({ elapsedMs, sampleCount }) {
  if (elapsedMs <= 0) return REFERENCE_REASON.OPENING_ANCHOR
  if (elapsedMs < REFERENCE_MIN_ELAPSED_MS) return REFERENCE_REASON.BELOW_ELAPSED_HORIZON
  if (sampleCount < REFERENCE_MIN_SAMPLES) return REFERENCE_REASON.BELOW_SAMPLE_WARMUP
  return null
}

/**
 * A vertex with no episode in force: no generated sample exists at or before it.
 *
 * With the per-episode grid the first vertex *is* a sample's own instant, so this is
 * unreachable for every call this file makes; it is restated because the shipped estimator
 * has the branch, and an oracle that silently omitted it could not witness it.
 */
function noEpisodeVertex(localMs) {
  return {
    localMs,
    tps: null,
    publishable: false,
    rateUnavailableReason: REFERENCE_REASON.NO_EPISODE,
    activePhase: null,
    episodeStartMs: null,
    episodeElapsedMs: 0,
    episodeSampleCount: 0,
    episodeMass: 0,
  }
}

/**
 * The independent reference series of one attempt, on the attempt-local clock.
 *
 * @param {{localMs:number, phase:string, tokens:number, weight:number}[]} samples
 * @param {{endMs:number, sampleEveryMs?:number}} options
 * @returns {{localMs:number, tps:number|null, publishable:boolean, rateUnavailableReason:string|null,
 *   activePhase:string|null, episodeStartMs:number|null, episodeElapsedMs:number,
 *   episodeSampleCount:number, episodeMass:number}[]}
 */
function referenceSeries(samples, { endMs, sampleEveryMs = STEP_MS }) {
  const ordered = samples
    .map((sample, index) => ({ ...sample, order: index }))
    .sort((left, right) => left.localMs - right.localMs || left.order - right.order)

  /** The episodes: the maximal runs of consecutive same-phase samples, by their origins. */
  const episodes = []
  for (let index = 0; index < ordered.length; index += 1) {
    const last = episodes[episodes.length - 1]
    if (last === undefined || last.phase !== ordered[index].phase) {
      episodes.push({ phase: ordered[index].phase, startIndex: index, startMs: ordered[index].localMs })
    }
  }

  /**
   * **Each episode's own ladder.** A non-terminal episode is sampled up to the instant the
   * next episode opens; the terminal one runs to the attempt's own end instant. Instants are
   * built by multiplication rather than by accumulating `+=`, so the last vertex cannot drift
   * off the grid it claims to be on.
   */
  const instants = []
  for (let index = 0; index < episodes.length; index += 1) {
    const episode = episodes[index]
    const next = episodes[index + 1]
    const boundMs = next === undefined ? endMs : Math.min(next.startMs, endMs)
    if (!(episode.startMs <= boundMs + 1e-9)) continue
    for (let step = 0; ; step += 1) {
      const at = episode.startMs + step * sampleEveryMs
      if (at > boundMs + 1e-9) break
      instants.push(at)
    }
  }
  instants.sort((left, right) => left - right)
  const vertices = []
  for (const at of instants) {
    if (vertices.length === 0 || at > vertices[vertices.length - 1] + 1e-9) vertices.push(at)
  }
  /** The attempt's own end instant is a vertex whether or not it falls on a ladder. */
  if (vertices.length === 0 || endMs > vertices[vertices.length - 1] + 1e-9) vertices.push(endMs)

  return vertices.map((at) => {
    /** The newest sample at or before the vertex, resolved by stream order at one instant. */
    let newest = -1
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].localMs <= at) newest = index
    }
    if (newest < 0) return noEpisodeVertex(at)
    /** The maximal same-phase run containing it: walk left to the first phase change. */
    let start = newest
    while (start > 0 && ordered[start - 1].phase === ordered[newest].phase) start -= 1
    let mass = 0
    for (let index = start; index <= newest; index += 1) mass += magnitudeOf(ordered[index])
    const elapsed = at - ordered[start].localMs
    const sampleCount = newest - start + 1
    const reason = reasonAt({ elapsedMs: elapsed, sampleCount })
    return {
      localMs: at,
      /** A withheld rate is `null`, never a fabricated zero. */
      tps: reason === null ? Math.round(mass * 1000 / elapsed) : null,
      publishable: reason === null,
      rateUnavailableReason: reason,
      activePhase: ordered[newest].phase,
      episodeStartMs: ordered[start].localMs,
      episodeElapsedMs: elapsed,
      episodeSampleCount: sampleCount,
      episodeMass: mass,
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

/** Vertex-by-vertex, field-by-field agreement of one production series against the reference. */
function assertVertexAgreement(points, series, label) {
  assert.equal(points.length, series.length, `${label}: vertex count`)
  for (let index = 0; index < series.length; index += 1) {
    const point = points[index]
    const expected = series[index]
    assert.equal(point.localMs, expected.localMs,
      `${label}: vertex ${index} must sit at local ${expected.localMs}`)
    for (const field of VERTEX_FIELDS) {
      assert.deepEqual(point[field], expected[field],
        `${label}: at local ${expected.localMs} the reference's ${field} is `
        + `${JSON.stringify(expected[field])}, production's is ${JSON.stringify(point[field])}`)
    }
  }
}

/** The reference's own peak: the largest published rate, or `null` when none was published. */
function referencePeakOf(expected) {
  const rates = expected.flatMap(entry => (
    entry.series.filter(point => point.publishable).map(point => point.tps)
  ))
  return rates.length === 0 ? null : Math.max(...rates)
}

/** How many reference vertices a turn published, and how many the gates withheld. */
function publicationOf(expected) {
  let published = 0
  let withheld = 0
  for (const entry of expected) {
    for (const point of entry.series) {
      if (point.publishable) published += 1
      else withheld += 1
    }
  }
  return { published, withheld }
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
    assertVertexAgreement(direct, series, `${spec.id} (direct)`)
    for (let index = 0; index < series.length; index += 1) {
      assert.equal(direct[index].timeMs, segment.startMs + series[index].localMs,
        `${spec.id}: direct timeMs at local ${series[index].localMs}`)
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
  /**
   * Reasoning, output, reasoning. Each transition opens a new episode with its own clock and
   * its own mass: the output stretch starts at its own sample, so its opening vertex is its
   * anchor — `tps: null`, not a rate — and the second reasoning stretch does the same. The
   * magnitude steps down at the boundary (450 to 300) and climbs again on the new episode's
   * own evidence. Every episode carries three deltas, the smallest number the publication
   * policy admits.
   */
  const spec = {
    id: 'a',
    step: 1,
    mode: 'estimated',
    settledLocal: 700,
    samples: [
      [0, 'reasoning', 30], [100, 'reasoning', 30], [200, 'reasoning', 30],
      [300, 'output', 10], [350, 'output', 10], [400, 'output', 10],
      [500, 'reasoning', 10], [550, 'reasoning', 10], [600, 'reasoning', 10],
    ],
  }
  const driven = drive([spec])
  compareTurn(driven, [spec])
  assert.deepEqual(
    driven.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    [
      [0, null, 'reasoning'], [100, null, 'reasoning'], [200, 450, 'reasoning'],
      [300, null, 'output'], [400, 300, 'output'],
      [500, null, 'reasoning'], [600, 300, 'reasoning'], [700, 150, 'reasoning'],
    ],
  )
  assert.equal(driven.curve.attempts[0].points[3].tps, null,
    'the opening instant of a new episode carries no rate')
  assert.equal(driven.curve.attempts[0].points[3].rateUnavailableReason, 'opening-anchor',
    'and it says the clock has not advanced rather than publishing a measured zero')
  assert.equal(driven.curve.attempts[0].points[4].episodeSampleCount, 3,
    'the output episode counts only its own three deltas')
  assert.equal(driven.curve.attempts[0].points[4].episodeMass, 30,
    'and carries none of the reasoning episode\'s mass')
})

test('reference agreement: simultaneous timestamps follow the stream order', () => {
  /**
   * Two samples at one instant are ordered by the stream that delivered them. The episode in
   * force at that instant is the one the newer sample belongs to, so the pair of magnitudes
   * delivered at local zero reads as `output` or as `reasoning` depending on the delivery
   * order — and the mass counted at the next vertex follows the same episode. The heavy
   * magnitude is placed on the phase that is delivered **second**, so the exclusion is
   * visible in the numbers: the same instants publish 150 or 1 500 depending on which
   * episode owns the shared anchor.
   */
  const reasoningFirst = {
    id: 'r-first',
    step: 1,
    mode: 'estimated',
    settledLocal: 200,
    samples: [[0, 'reasoning', 100], [0, 'output', 10], [100, 'output', 10], [200, 'output', 10]],
  }
  const outputFirst = {
    id: 'o-first',
    step: 1,
    mode: 'estimated',
    settledLocal: 200,
    samples: [[0, 'output', 10], [0, 'reasoning', 100], [100, 'reasoning', 100], [200, 'reasoning', 100]],
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
    [[0, null, 'output'], [100, null, 'output'], [200, 150, 'output']],
    'delivered reasoning-then-output, the shared instant belongs to the output episode, and the '
    + '100-unit reasoning delta at that instant is not in its mass',
  )
  assert.deepEqual(
    second.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    [[0, null, 'reasoning'], [100, null, 'reasoning'], [200, 1500, 'reasoning']],
    'delivered output-then-reasoning, the same instant belongs to the reasoning episode',
  )
  assert.deepEqual(
    third.curve.attempts[0].points.map(point => [point.localMs, point.tps, point.activePhase]),
    [[0, null, 'output'], [100, 300, 'output']],
    'two simultaneous same-phase samples both count toward one episode',
  )
})

test('reference agreement: a settlement before the last delta cannot shrink the attempt', () => {
  /**
   * Clock skew: the settlement is recorded 100 ms in, but the model kept producing to
   * 500 ms. The attempt's width is its real generation time, and the trace ends there.
   * The third delta is what admits the episode, and it is measured over the episode's
   * own half second rather than over the attempted settlement.
   */
  const spec = {
    id: 'a',
    step: 1,
    mode: 'estimated',
    settledLocal: 100,
    samples: [[0, 'output', 10], [100, 'output', 10], [500, 'output', 10]],
  }
  const driven = drive([spec])
  compareTurn(driven, [spec])
  assert.equal(driven.curve.durationMs, 500, 'the attempt keeps its real generation time')
  assert.equal(driven.curve.attempts[0].points.at(-1).localMs, 500)
  assert.deepEqual(driven.curve.attempts[0].points.map(point => [point.localMs, point.tps]), [
    [0, null], [100, null], [200, null], [300, null], [400, null], [500, 60],
  ], 'two deltas stay below the sample gate at every vertex; the third publishes 30 tokens over 500 ms')
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
    samples: [[0, 'output', 10], [200, 'output', 10], [400, 'output', 10], [600, 'output', 10]],
    settledLocal: 700,
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
    [null, null, null, null, 75, 60, 67, 57], 'the raw shape weights')
  assert.deepEqual(anchored.curve.attempts[0].points.map(point => point.tps),
    [null, null, null, null, 150, 120, 133, 114], 'each sample scaled to twice its shape weight')
  assert.deepEqual(common.curve.attempts[0].points.map(point => point.tps),
    [null, null, null, null, 225, 180, 200, 171], 'one common factor of three over every sample')

  assert.equal(plain.curve.attempts[0].tokens, 40)
  assert.equal(plain.curve.attempts[0].calibrated, false)
  assert.equal(plain.curve.attempts[0].calibratedTokens, null)
  assert.equal(plain.curve.source.calibrationCoverage, 'none')
  assert.equal(anchored.curve.attempts[0].tokens, 80, 'the anchored integral is the provider total')
  assert.equal(anchored.curve.attempts[0].calibrated, true)
  assert.equal(anchored.curve.attempts[0].calibratedTokens, 80)
  assert.equal(anchored.curve.source.calibrationCoverage, 'full')
  assert.equal(common.curve.attempts[0].calibrated, true)
  assert.equal(common.curve.attempts[0].tokens, 120)

  /**
   * A mixed-phase attempt calibrated per phase: both phases are scaled by two, but each
   * episode is measured over its own clock and its own mass, so the three heavy output
   * deltas read 1 800 while the three light reasoning deltas read 300.
   */
  const mixed = {
    id: 'b',
    step: 1,
    mode: 'calibrated-split-2',
    settledLocal: 400,
    samples: [
      [0, 'reasoning', 10], [100, 'reasoning', 10], [200, 'reasoning', 10],
      [300, 'output', 30], [350, 'output', 30], [400, 'output', 30],
    ],
  }
  const mixedDriven = drive([mixed])
  compareTurn(mixedDriven, [mixed])
  assert.deepEqual(mixedDriven.curve.attempts[0].points.map(point => [point.localMs, point.tps]),
    [[0, null], [100, null], [200, 300], [300, null], [400, 1800]],
    'reasoning scaled to its own counter, output to its own, each over its own episode clock')
  assert.equal(mixedDriven.curve.attempts[0].tokens, 240)
})

test('reference agreement: an attempt with no generated delta owns no trace and no width', () => {
  const empty = { id: 'empty', step: 1, mode: 'estimated', settledLocal: 5000, samples: [] }
  const real = {
    id: 'real',
    step: 2,
    mode: 'estimated',
    settledLocal: 200,
    samples: [[0, 'output', 10], [100, 'output', 10], [200, 'output', 10]],
  }
  const together = drive([empty, real])
  compareTurn(together, [empty, real])
  assert.equal(together.curve.attempts.length, 1, 'only the attempt that produced evidence is drawn')
  assert.equal(together.curve.segments.length, 1, 'and only it owns a coordinate')
  assert.equal(together.curve.segments[0].startMs, 0, 'the empty attempt consumes no width')
  assert.equal(together.curve.attempts[0].points.at(-1).tps, 150,
    'the attempt after the empty one is measured on its own evidence')

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
   * episode clocks do not: B opens on A's last coordinate and measures none of A's mass,
   * which is visible in its first publishable vertex — its own three deltas over its own
   * 200 ms, never A's tokens added to them. The strongest form of the claim is that each
   * trace is identical whether it is driven alone or beside the other call.
   */
  const first = {
    id: 'A',
    step: 1,
    mode: 'estimated',
    settledLocal: 700,
    samples: [[0, 'output', 10], [100, 'output', 10], [200, 'output', 10], [500, 'output', 10]],
  }
  const second = {
    id: 'B',
    step: 2,
    mode: 'estimated',
    settledLocal: 600,
    samples: [
      [0, 'output', 10], [100, 'output', 10], [200, 'output', 10],
      [300, 'reasoning', 10], [400, 'reasoning', 10], [500, 'reasoning', 10],
    ],
  }
  const together = drive([first, second])
  compareTurn(together, [first, second])
  assert.equal(together.curve.segments[1].startMs, together.curve.segments[0].endMs,
    'the two attempts share one compressed coordinate')
  assert.equal(together.curve.durationMs, 1300, 'the axis is the two attempts\' own widths')

  const [traceA, traceB] = together.curve.attempts
  assert.deepEqual(traceA.points.map(point => [point.localMs, point.tps]),
    [[0, null], [100, null], [200, 150], [300, 100], [400, 75], [500, 80], [600, 67], [700, 57]],
    'A decays hyperbolically across its silence and resumes when its fourth delta arrives')
  assert.deepEqual(traceB.points.map(point => [point.localMs, point.tps, point.activePhase]),
    [[0, null, 'output'], [100, null, 'output'], [200, 150, 'output'],
      [300, null, 'reasoning'], [400, null, 'reasoning'], [500, 150, 'reasoning'], [600, 100, 'reasoning']])
  assert.equal(traceB.points[0].timeMs, traceA.points.at(-1).timeMs,
    'B opens on the coordinate A\'s clock stopped at')
  assert.equal(traceB.points[2].tps, 150,
    'and its first publishable vertex is its own three deltas over its own 200 ms, not A\'s mass added')

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
 *
 * The shapes are kept as they are because the two facts they produce are the two the
 * publication policy is about: a shape whose episodes carry three deltas or more satisfies
 * the gates and publishes, and a shape whose episode carries one or two — a single-sample
 * attempt, a simultaneous pair, a one-sample phase block — is withheld with the reason that
 * names the missing fact. Both halves are part of the contract, and the coverage floors
 * below require both to be exercised in quantity.
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
  let published = 0
  let withheld = 0
  for (const spec of specs) {
    const driven = drive([spec])
    const compared = compareTurn(driven, [spec])
    vertices += compared.vertices
    const counts = publicationOf(compared.expected)
    published += counts.published
    withheld += counts.withheld
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
  /**
   * And the gates are exercised from both sides: the corpus must contain vertices that
   * publish (so the comparison covers measured rates) and vertices that are withheld (so it
   * covers the null rule and every reason for it).
   */
  assert.ok(published >= 200,
    `only ${published} of ${vertices} generated vertices passed the publication gates`)
  assert.ok(withheld >= 400,
    `only ${withheld} of ${vertices} generated vertices were withheld by the publication gates`)
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
  let measured = 0
  for (const spec of specs) {
    const driven = drive([spec])
    const { expected } = compareTurn(driven, [spec])
    const referencePeak = referencePeakOf(expected)
    assert.equal(driven.curve.peakTps, referencePeak,
      `${spec.id}: the published peak must be the reference maximum`)
    if (referencePeak !== null) measured += 1
  }
  /**
   * A turn whose every episode is below the gates has no peak at all — `null`, not a
   * fabricated zero — so an all-withheld corpus is a legitimate outcome for one case and a
   * defect for the corpus. The floor requires most generated turns to have a real maximum.
   */
  assert.ok(measured >= 12,
    `only ${measured} of ${specs.length} generated turns produced a publishable peak`)

  /**
   * And on a multi-attempt turn it is the largest single attempt, never a sum: the heavy
   * call peaks at 1000 and the light one at 200, so the turn peak is 1000 rather than
   * 1200. Both calls carry three deltas, so both really publish.
   */
  const heavy = {
    id: 'heavy',
    step: 1,
    mode: 'estimated',
    settledLocal: 500,
    samples: [[0, 'output', 100], [100, 'output', 100], [300, 'output', 100]],
  }
  const light = {
    id: 'light',
    step: 2,
    mode: 'estimated',
    settledLocal: 150,
    samples: [[0, 'output', 10], [100, 'output', 10], [150, 'output', 10]],
  }
  const together = drive([heavy, light])
  const { expected } = compareTurn(together, [heavy, light])
  const referenceMax = referencePeakOf(expected)
  assert.equal(together.curve.peakTps, referenceMax)
  assert.equal(together.curve.peakTps, 1000)
  assert.notEqual(together.curve.peakTps, 1200, 'the peak is never the two attempts added together')
  assert.equal(together.curve.peakTps, peakTps(...together.curve.attempts.map(attempt => attempt.points)),
    'and it is the maximum of the published per-attempt series')
})
