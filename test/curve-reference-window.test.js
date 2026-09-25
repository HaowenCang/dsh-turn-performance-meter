/**
 * Independent reference implementation of the rolling-window series.
 *
 * Everything asserted here is computed by a **second algorithm**, written for this file
 * and sharing no code with `src/core/curve.js`. The curve module was previously verified
 * mostly by expectations derived from its own output — Phase 6 recorded the per-attempt
 * structure by reading the run list back — and an implementation cannot be its own witness
 * for the definition it implements. The Phase 7 audit found the episode-opening defect
 * precisely because it re-derived the window from the frozen definition instead.
 *
 * The reference makes three choices that keep it independent:
 *
 *   1. **The window is the literal definition.** `(t - windowMs, t]`, tested with two
 *      strict comparisons on the sample's own attempt-local instant. There is no opening
 *      case, no clamping and no attempt or phase state — the loop cannot express one.
 *   2. **Episodes are partitioned by a single rule**: consecutive samples of one attempt
 *      and phase further apart than one window are in different episodes. This is a
 *      single-pass scan, not a rebuild of `phaseRuns`.
 *   3. **The vertex grid is derived from the episode's own bounds** — its first sample and
 *      its last token-producing sample — rather than from the run the production library
 *      returned.
 *
 * The comparison is then made vertex by vertex: every instant production emits must be on
 * the reference grid, and must carry exactly the reference's rate. A production series that
 * invented a vertex or measured a different sample set fails.
 *
 * ## The sample population
 *
 * The reference reads its samples from the **script that was driven into the store**, not
 * from the settled snapshot. That is deliberate and it is the whole point: a reference that
 * recovered its sample weights by differencing the curve's own `tps` column would be
 * reading the answer off the thing it is checking. The script is ground truth, it is
 * written on the attempt-local clock the window is defined on, and its token weights come
 * from `heuristicTokenWeight` — the same estimator production uses, so that the *weights*
 * are not a second variable in the comparison while the *window arithmetic* is.
 *
 * ## What each scenario covers
 *
 * A single episode; two episodes; a gap below, at and above the window; three episodes;
 * reasoning and output alternating; an attempt boundary; a retry boundary; and two
 * generated families over many turns. Gaps are whole 250 ms steps and every delta weighs
 * 100 tokens, so every window edge is an exact integer and the comparison is exact
 * arithmetic rather than a tolerance question.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'
import { DEFAULT_SAMPLE_EVERY_MS, DEFAULT_WINDOW_MS } from '../src/core/curve.js'

const WINDOW_MS = DEFAULT_WINDOW_MS
const STEP_MS = DEFAULT_SAMPLE_EVERY_MS
/** Weight of every generated delta, asserted rather than assumed in `chunkOf`. */
const DELTA_TOKENS = 100

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })

/** One chunk weighing exactly `DELTA_TOKENS`, or a loud failure if the heuristic moved. */
function chunkOf(kind) {
  const text = 'x'.repeat(DELTA_TOKENS * 4)
  const weight = heuristicTokenWeight(text)
  assert.equal(weight, DELTA_TOKENS,
    `the generator assumes ${DELTA_TOKENS * 4} characters weigh ${DELTA_TOKENS}; measured ${weight}`)
  return (kind === 'reasoning' ? reasoning : output)(text)
}

/**
 * Drive one turn from a script written on the **attempt-local** clock.
 *
 * `attempts` entries are `{ id, step, local: [[localMs, kind], ...], retried? }`; `tools`
 * entries are `{ callId, startMs, endMs }` on the wall clock, and only their existence
 * matters to the curve, which compresses tool time to zero width.
 *
 * The driver places each attempt on the compressed axis itself — the concatenation rule
 * `compressAttempts` documents — and converts every local instant to the wall time the
 * store needs. That conversion is stated here rather than delegated, so the reference side
 * of this file is readable without following two coordinate systems.
 */
function drive({ attempts, tools = [] }) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  let offsetMs = 0
  let maxWallMs = 0

  for (const spec of attempts) {
    const local = [...(spec.local ?? [])].sort((left, right) => left[0] - right[0])
    /**
     * Every attempt's script must open at local zero, because attempt-local zero *is* the
     * attempt's first delta: `compressAttempts` rebases each attempt to its own first
     * sample, so a script starting anywhere else would silently be shifted and the
     * reference would be comparing two different clocks. Refusing loudly here is what keeps
     * the rest of this file's arithmetic honest.
     */
    if (local.length > 0) {
      assert.equal(local[0][0], 0,
        `${spec.id}: the script must open at attempt-local 0; it opens at ${local[0][0]}`)
    }
    const startedAtMs = offsetMs
    const attempt = store.beginAttempt(record, { attemptId: spec.id, step: spec.step, startedAtMs })
    for (const [localMs, kind] of local) {
      const wallMs = startedAtMs + localMs
      store.acceptChunk(record, attempt, { timeMs: wallMs, chunk: chunkOf(kind) })
      maxWallMs = Math.max(maxWallMs, wallMs)
    }
    store.settleAttempt(attempt, {
      settledAtMs: maxWallMs + 1,
      settlementKind: spec.retried === true ? 'attempt' : 'message',
      surfaceCommitted: spec.retried !== true,
      attemptOutcome: spec.retried === true ? 'retried' : 'committed',
      settlementSeq: spec.step,
    })
    /** The attempt's own width is the span of its local clock; a retry reuses it. */
    const span = local.length === 0 ? 0 : local[local.length - 1][0]
    offsetMs += span
  }

  for (const tool of tools) {
    store.toolStarted(record, { callId: tool.callId, name: tool.name ?? 'pwsh', timeMs: tool.startMs })
    store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status ?? 'ok' })
  }
  return store.endTurn(record, { timeMs: maxWallMs + 2 * WINDOW_MS, status: 'completed' }).curve
}

/** Reference samples of one attempt and phase, on the attempt-local clock. */
function referenceSamples(spec, kind) {
  return (spec.local ?? [])
    .filter(([, sampleKind]) => sampleKind === kind)
    .map(([localMs]) => ({ localMs, weight: DELTA_TOKENS }))
    .sort((left, right) => left.localMs - right.localMs)
}

/**
 * Partition one phase's samples of one attempt into episodes, by the single rule that a gap
 * longer than one window separates them.
 *
 * The samples are on their attempt-local clock and already in delivery order, so the scan is
 * one pass with no sort and no merge bookkeeping: the rule alone decides, which is what
 * makes this reference readable against the frozen definition rather than against
 * `phaseRuns`.
 */
function episodesOf(samples) {
  const episodes = []
  let current = null
  for (const sample of samples) {
    if (current === null || sample.localMs > current.lastSampleMs + WINDOW_MS) {
      current = { firstSampleMs: sample.localMs, lastSampleMs: sample.localMs }
      episodes.push(current)
    }
    current.lastSampleMs = Math.max(current.lastSampleMs, sample.localMs)
  }
  return episodes
}

/**
 * Reference rate at one instant: the literal trailing window over the whole attempt.
 *
 * The loop has no state, so it cannot carry a sample past its window, and it has no notion of
 * an episode, so it cannot treat an episode opening differently from any other instant. Both
 * properties are what the production library got wrong.
 */
function referenceTps(samples, atMs) {
  let tokens = 0
  for (const sample of samples) {
    if (sample.localMs <= atMs && sample.localMs > atMs - WINDOW_MS) tokens += sample.weight
  }
  return tokens * 1000 / WINDOW_MS
}

/**
 * Reference grid of one attempt and phase: every instant the sampling rule can place a vertex
 * on, ascending.
 *
 * A run is sampled from its first sample on the attempt's grid, and its decay past its last
 * token-producing sample is sampled one step at a time from that sample. The union is the
 * whole interval from the episode's first sample to one window past its last sample, on the
 * 250 ms grid. Expressing it as that interval rather than as two separate ramps matters when
 * episodes are exactly one window apart: the second episode's body grid then interleaves with
 * the first one's tail grid, so an instant such as 1250 ms belongs to the reference even
 * though neither ramp alone contains it.
 */
function gridOf(samples) {
  const instants = new Set()
  for (const episode of episodesOf(samples)) {
    for (let at = episode.firstSampleMs; at <= episode.lastSampleMs + WINDOW_MS; at += STEP_MS) {
      instants.add(Math.round(at))
    }
  }
  return [...instants].sort((left, right) => left - right)
}

/**
 * Compare **every** run of one attempt and phase against the reference.
 *
 * All runs are folded into one list, which is itself a claim: a phase that falls silent for
 * longer than one window produces several runs, and a comparison that only checked the first
 * would let a defect hide in the second — which is exactly where the Phase 7 defect lived.
 */
function compareAll(curve, kind, spec) {
  const entry = curve.series.find(series => series.key === kind)
  assert.ok(entry !== undefined, `the settled curve has a ${kind} series`)
  const runs = entry.runs.filter(candidate => candidate.attemptId === spec.id)
  const samples = referenceSamples(spec, kind)
  assert.equal(runs.length > 0, samples.length > 0,
    `${kind}/${spec.id}: ${samples.length} reference samples produced ${runs.length} runs`)

  const episodes = episodesOf(samples)
  const index = new Set(gridOf(samples))

  let vertices = 0
  for (const run of runs) {
    /**
     * Vertex by vertex, two claims: the instant is on the reference grid, and it carries
     * exactly the reference's rate. The first refuses an invented vertex; the second refuses
     * a vertex measured over the wrong sample set, which is what the Phase 7 defect produced.
     */
    for (const point of run.points) {
      assert.equal(point.attemptId, spec.id, 'every vertex carries its attempt identity')
      assert.ok(index.has(point.localMs),
        `${kind}/${spec.id}: production emitted a vertex at local ${point.localMs}, which is on no episode grid`)
      assert.equal(point.tps, referenceTps(samples, point.localMs),
        `${kind}/${spec.id} at local ${point.localMs}: reference says ${referenceTps(samples, point.localMs)}, production says ${point.tps}`)
    }
    /**
     * Consecutive vertices must be exactly one sampling step apart: no hole and no duplicate
     * instant. The step is asserted on the **time difference** rather than on adjacency in the
     * grid, because an attempt's body grid and its tail grids are both anchored at episode
     * bounds and can be offset from one another by less than a step — three episodes separated
     * by exactly one window produce grids that interleave.
     */
    for (let position = 1; position < run.points.length; position += 1) {
      const gap = run.points[position].localMs - run.points[position - 1].localMs
      assert.equal(gap, STEP_MS,
        `${kind}/${spec.id}: vertices at local ${run.points[position - 1].localMs} and ${run.points[position].localMs} are ${gap} ms apart, not one sampling step`)
    }
    vertices += run.points.length
  }

  if (runs.length > 0) {
    /**
     * The attempt's first run opens on its first episode's first sample. How far a tail is
     * drawn is an availability question `phaseRuns` documents, so no upper endpoint is
     * asserted here; the grid membership above is the bound that matters.
     */
    assert.equal(runs[0].points[0].localMs, episodes[0].firstSampleMs,
      `${kind}/${spec.id}: the run opens on its first episode's first sample`)
  }
  return { runs: runs.length, vertices, episodes: episodes.length }
}

/** Assert agreement, and that the comparison covered enough vertices to mean something. */
function assertAgrees(curve, kind, spec, { expectVertices = 1, expectEpisodes = null } = {}) {
  const result = compareAll(curve, kind, spec)
  assert.ok(result.vertices >= expectVertices,
    `${kind}/${spec.id}: the comparison covered ${result.vertices} vertices, expected at least ${expectVertices}`)
  if (expectEpisodes !== null) {
    assert.equal(result.episodes, expectEpisodes,
      `${kind}/${spec.id}: the reference found ${result.episodes} episodes, expected ${expectEpisodes}`)
  }
  return result
}

/** The runs of one phase, in draw order. */
function runsOf(curve, kind) {
  return curve.series.find(series => series.key === kind).runs
}

// ---------------------------------------------------------------------------
// Named scenarios: one per frozen curve semantic named in the Phase 7 plan.
// ---------------------------------------------------------------------------

test('reference agreement: one episode, two measurements half a window apart', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }
  const curve = drive({ attempts: [attempt] })
  assertAgrees(curve, 'output', attempt, { expectVertices: 7, expectEpisodes: 1 })
  /** The shape the project has always drawn, restated as the reference's answer. */
  assert.deepEqual(runsOf(curve, 'output')[0].points.map(p => p.tps), [100, 100, 200, 200, 100, 100, 0])
})

test('reference agreement: two episodes three windows apart', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [3000, 'output']] }
  const curve = drive({ attempts: [attempt] })
  assertAgrees(curve, 'output', attempt, { expectVertices: 5, expectEpisodes: 2 })
  const [first, second] = runsOf(curve, 'output')
  /**
   * The Phase 7 counterexample, asserted through the reference rather than through a
   * hand-written expectation: the second episode opens on its own window alone.
   */
  assert.equal(second.points[0].localMs, 3000)
  assert.equal(second.points[0].tps, 100)
  assert.equal(first.points.map(p => p.tps).join(','), '100,100,100,100,0')
})

test('reference agreement: a gap below the window is one episode', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [750, 'output']] }
  const curve = drive({ attempts: [attempt] })
  assertAgrees(curve, 'output', attempt, { expectVertices: 8, expectEpisodes: 1 })
})

test('reference agreement: a gap of exactly one window is one episode, and the sample at zero expires at its far edge', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [1000, 'output']] }
  const curve = drive({ attempts: [attempt] })
  assertAgrees(curve, 'output', attempt, { expectVertices: 7, expectEpisodes: 1 })
  /**
   * At local 1000 the window is `(0, 1000]`, so the sample at zero has expired at exactly the
   * instant the second one arrives. The reference says the same thing without being told about
   * episodes at all.
   */
  assert.equal(runsOf(curve, 'output')[0].points.find(p => p.localMs === 1000).tps, 100)
  assert.equal(referenceTps(referenceSamples(attempt, 'output'), 1000), 100)
})

test('reference agreement: a gap of one window plus one step splits', () => {
  /**
   * The gap is expressed on the sampling grid, so the boundary is exact: 1000 ms merges and
   * 1250 ms splits. An off-grid gap such as 1001 ms also splits, and
   * `test/curve-episode-opening.test.js` covers it; this file stays on whole steps so every
   * window edge is an integer.
   */
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [1250, 'output']] }
  const curve = drive({ attempts: [attempt] })
  assertAgrees(curve, 'output', attempt, { expectVertices: 5, expectEpisodes: 2 })
  const second = runsOf(curve, 'output')[1]
  assert.equal(second.points[0].localMs, 1250)
  assert.equal(second.points[0].tps, 100)
})

test('reference agreement: three episodes in one attempt', () => {
  /**
   * Gaps of one window plus one step. A gap of exactly one window would **merge** under
   * `phaseRuns` rule 3 — the window between them never reached zero — and that boundary has
   * its own scenario above; here the point is three genuinely separate episodes, each opening
   * on its own delta alone.
   */
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [1250, 'output'], [2500, 'output']] }
  const curve = drive({ attempts: [attempt] })
  assertAgrees(curve, 'output', attempt, { expectVertices: 15, expectEpisodes: 3 })
  const runs = runsOf(curve, 'output')
  assert.equal(runs.length, 3)
  /** Five vertices per episode: the opening delta and its one-window decay. */
  assert.deepEqual(runs.map(run => run.points.length), [5, 5, 5])
  assert.deepEqual(runs.map(run => run.points[0].tps), [100, 100, 100])
  assert.equal(curve.peakTps, 100)
})

test('reference agreement: reasoning and output alternating inside one attempt', () => {
  const attempt = {
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [3000, 'output'], [6000, 'reasoning']],
  }
  const curve = drive({ attempts: [attempt] })
  assertAgrees(curve, 'reasoning', attempt, { expectVertices: 10, expectEpisodes: 2 })
  assertAgrees(curve, 'output', attempt, { expectVertices: 5, expectEpisodes: 1 })
  const reasonRuns = runsOf(curve, 'reasoning')
  assert.equal(reasonRuns.length, 2, 'the output stretch is an absence for reasoning')
  assert.deepEqual(reasonRuns.map(run => run.points[0].tps), [100, 100])
})

test('reference agreement: across an attempt boundary, each call is measured on its own clock', () => {
  const first = { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }
  const second = { id: 'b', step: 2, local: [[0, 'output'], [500, 'output']] }
  const curve = drive({
    attempts: [first, second],
    tools: [{ callId: 't1', startMs: 1000, endMs: 60_000 }],
  })
  assertAgrees(curve, 'output', first, { expectVertices: 3, expectEpisodes: 1 })
  assertAgrees(curve, 'output', second, { expectVertices: 7, expectEpisodes: 1 })
  /**
   * Both calls stream the same shape, so the two runs must report the same numbers. A bridged
   * window would make the second one larger; the reference measures each over its own samples,
   * which is the per-attempt partition restated.
   */
  const [runA, runB] = runsOf(curve, 'output')
  assert.deepEqual(runB.points.map(p => p.tps), [100, 100, 200, 200, 100, 100, 0])
  assert.equal(runA.points.at(-1).tps, 200)
  assert.equal(curve.peakTps, 200)
})

test('reference agreement: across a retry boundary the abandoned call seeds nothing', () => {
  const abandoned = { id: 'retry-1', step: 1, local: [[0, 'output'], [500, 'output']], retried: true }
  const replacement = { id: 'retry-2', step: 1, local: [[0, 'output'], [500, 'output']] }
  const curve = drive({ attempts: [abandoned, replacement] })
  assertAgrees(curve, 'output', abandoned, { expectVertices: 3, expectEpisodes: 1 })
  assertAgrees(curve, 'output', replacement, { expectVertices: 7, expectEpisodes: 1 })
  const runs = runsOf(curve, 'output')
  /**
   * Both attempts share the compressed coordinate zero, so only the attempt identity can keep
   * them apart. Each opens on its own window, which holds one delta: 100, never the other
   * call's 200.
   */
  assert.deepEqual(runs.map(run => run.points[0].tps), [100, 100])
  assert.equal(curve.peakTps, 200, 'an attempt still owns its own measurement')
})

// ---------------------------------------------------------------------------
// Parameterized equivalence over generated turns.
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
 * Generated single-phase attempts: one to five token-producing instants, gaps drawn from a set
 * spanning below, at and above the window.
 */
function generatedAttempts(count) {
  const GAPS = [0, 250, 500, 750, 1000, 1250, 1500, 2000, 3000, 4000]
  const attempts = []
  for (let index = 0; index < count; index += 1) {
    const random = seeded(0x5eed + index * 7919)
    const sampleCount = 1 + Math.floor(random() * 5)
    const local = []
    let at = 0
    for (let step = 0; step < sampleCount; step += 1) {
      if (step > 0) at += GAPS[Math.floor(random() * GAPS.length)]
      local.push([at, 'output'])
    }
    attempts.push({ id: `g${index}`, step: 1, local })
  }
  return attempts
}

test('every vertex of a generated turn matches the brute-force reference', () => {
  const specs = generatedAttempts(60)
  let vertices = 0
  let multiEpisode = 0
  for (const spec of specs) {
    const curve = drive({ attempts: [spec] })
    const result = compareAll(curve, 'output', spec)
    assert.ok(result.vertices > 0, `${spec.id}: the generated attempt produced no vertices`)
    vertices += result.vertices
    if (result.episodes > 1) multiEpisode += 1
  }
  /**
   * Coverage floors: the point of the parameterization is that it exercises more than
   * single-episode turns, and a future change that quietly made every case trivial would
   * otherwise still pass.
   */
  assert.ok(vertices > 300, `the generated set covered ${vertices} vertices`)
  assert.ok(multiEpisode >= 20, `only ${multiEpisode} of ${specs.length} generated turns had multiple episodes`)
})

test('generated turns never resurrect an expired sample at an episode opening', () => {
  /**
   * The Phase 7 defect, stated as a property over every generated case: at an episode's opening
   * instant the rate must equal the literal trailing window over that episode's own attempt. An
   * implementation that reopened the window would disagree exactly there, and the counterexample
   * in `test/curve-episode-opening.test.js` is the minimal instance.
   */
  const specs = generatedAttempts(60)
  let openings = 0
  for (const spec of specs) {
    const curve = drive({ attempts: [spec] })
    const samples = referenceSamples(spec, 'output')
    const openingsLocal = new Set(episodesOf(samples).map(episode => episode.firstSampleMs))
    for (const run of runsOf(curve, 'output')) {
      for (const point of run.points) {
        if (!openingsLocal.has(point.localMs)) continue
        openings += 1
        assert.equal(point.tps, referenceTps(samples, point.localMs),
          `${spec.id}: the opening vertex at ${point.localMs} did not measure its own window`)
      }
    }
  }
  assert.ok(openings >= 20, `only ${openings} episode openings were exercised`)
})

test('both phases of a generated alternating turn match the brute-force reference', () => {
  const random = seeded(0xa17e)
  let vertices = 0
  for (let index = 0; index < 24; index += 1) {
    const local = []
    let at = 0
    /** Phase runs are contiguous, so each block is one phase's stretch. */
    for (let block = 0; block < 2 + Math.floor(random() * 3); block += 1) {
      const kind = block % 2 === 0 ? 'reasoning' : 'output'
      const count = 1 + Math.floor(random() * 3)
      for (let step = 0; step < count; step += 1) {
        if (local.length > 0) at += STEP_MS * (1 + Math.floor(random() * 6))
        local.push([at, kind])
      }
      at += WINDOW_MS * (1 + Math.floor(random() * 3))
    }
    const spec = { id: 'alt', step: 1, local }
    const curve = drive({ attempts: [spec] })
    for (const kind of ['reasoning', 'output']) {
      if (referenceSamples(spec, kind).length === 0) continue
      const result = compareAll(curve, kind, spec)
      vertices += result.vertices
      assert.ok(result.vertices > 0, `${kind}: a phase with samples produced no vertices`)

      /**
       * No vertex may sit outside every episode the reference found — the structural claim that
       * a run covers only its own phase's evidence.
       */
      const episodes = episodesOf(referenceSamples(spec, kind))
      for (const run of runsOf(curve, kind)) {
        for (const point of run.points) {
          const covered = episodes.some(candidate => (
            point.localMs >= candidate.firstSampleMs
            && point.localMs <= candidate.lastSampleMs + WINDOW_MS
          ))
          assert.ok(covered,
            `${kind}: vertex at local ${point.localMs} is outside every episode the reference found`)
        }
      }
    }
  }
  assert.ok(vertices > 100, `the alternating set covered ${vertices} vertices`)
})
