/**
 * Independent reference implementation of the completed throughput trace.
 *
 * Everything asserted here is computed by a **second algorithm**, written for this file
 * and sharing no code with `src/core/curve.js`. The curve module was previously verified
 * mostly by expectations derived from its own output — Phase 6 recorded the per-attempt
 * structure by reading the run list back — and an implementation cannot be its own
 * witness for the definition it implements. The Phase 7 audit found the
 * episode-opening defect precisely because it re-derived the window from the frozen
 * definition instead.
 *
 * The reference is deliberately small. It makes four choices that keep it independent,
 * and three of them are the **opposite** of what the previous revision of this file had
 * to do:
 *
 *   1. **The window is the literal definition**, `(t - windowMs, t]`, tested with two
 *      strict comparisons on the sample's own attempt-local instant. There is no opening
 *      case, no clamping and no attempt or phase state — the loop cannot express one.
 *   2. **The window is total.** Every generated sample of the attempt counts, whatever
 *      its phase. The previous reference measured one phase at a time, because that is
 *      what production did; a reference that kept doing so would now be checking the
 *      wrong definition. Where a phase appears at all, it appears as a **label**.
 *   3. **The grid is the union of the body ladder and the tail ladder.** The body is
 *      anchored at the attempt's first sample; the tail is anchored one sampling step
 *      past the attempt's last sample, and stops one window after it. There is no
 *      episode partition, so there is no per-episode grid and no gap rule: a silence
 *      inside an attempt is a stretch of the grid on which the window happens to be
 *      empty.
 *   4. **Episodes are still computed** — by the single rule that consecutive samples of
 *      one attempt further apart than one window are in different episodes — but only so
 *      that the *resumption* instants can be asserted against their own windows. They
 *      decide no drawing.
 *
 * The comparison is then made vertex by vertex: every instant production emits must be on
 * the reference grid and must carry exactly the reference's rate, and no vertex may be
 * missing from the set the reference says is drawable. A production series that invented a
 * vertex, dropped one, or measured a different sample set fails.
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
 * A single burst; two bursts; a gap below, at and above the window; many bursts; reasoning
 * and output alternating; attempt boundaries; retries; and two generated families over
 * many turns.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'
import {
  DEFAULT_SAMPLE_EVERY_MS,
  DEFAULT_WINDOW_MS,
  attemptTrace,
  peakTps,
} from '../src/core/curve.js'
import { compressAttempts } from '../src/core/time-axis.js'

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
 *
 * It returns both the settled curve (production) and the compressed sample list, because
 * the reference's structural checks are made against the compressed coordinates rather
 * than against a hand-computed offset.
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
  const curve = store.endTurn(record, { timeMs: maxWallMs + 2 * WINDOW_MS, status: 'completed' }).curve
  /** The same compressed evidence production read, for the structural checks. */
  const raw = attempts.map(spec => ({
    attemptId: spec.id,
    samples: (spec.local ?? []).map(([localMs, kind]) => ({
      timeMs: localMs,
      phase: kind,
      weight: DELTA_TOKENS,
      tokens: DELTA_TOKENS,
      attemptId: spec.id,
    })),
  }))
  return { curve, compressed: compressAttempts(raw) }
}

/** Reference samples of one attempt, on the attempt-local clock. */
function referenceSamples(spec) {
  return (spec.local ?? [])
    .map(([localMs, kind]) => ({ localMs, kind, weight: DELTA_TOKENS }))
    .sort((left, right) => left.localMs - right.localMs)
}

/**
 * Partition one attempt's samples into episodes, by the single rule that a gap longer than
 * one window separates them.
 *
 * This decides no drawing — the grid below ignores it — and exists so that the instants at
 * which a silent model resumes can be asserted individually. Those are the instants every
 * rolling-window defect in this project's history has landed on.
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
 * The loop has no state, so it cannot carry a sample past its window; it has no notion of
 * an episode, so it cannot treat a resumption differently from any other instant; and it
 * has no phase argument, so it cannot report a share of the rate instead of the rate.
 */
function referenceTps(samples, atMs) {
  let tokens = 0
  for (const sample of samples) {
    if (sample.localMs <= atMs && sample.localMs > atMs - WINDOW_MS) tokens += sample.weight
  }
  return tokens * 1000 / WINDOW_MS
}

/**
 * Reference grid of one attempt: every instant the sampling rule can place a vertex on,
 * ascending.
 *
 * The body is the 250 ms ladder from the attempt's first sample through its last
 * token-producing sample. The tail continues one step past the last sample until one whole
 * window has been sampled, so every tail window is a whole `(t - windowMs, t]` rather than
 * a truncated one. A silence inside the attempt is simply a stretch of the body ladder.
 */
function gridOf(samples, { hasSuccessor = false, nextStartMs = null, endMs = 0 } = {}) {
  if (samples.length === 0) return []
  const first = samples[0].localMs
  const last = samples[samples.length - 1].localMs
  const bodyEnd = Math.min(last, endMs)
  const instants = []
  for (let at = first; at <= bodyEnd + 1e-9; at += STEP_MS) instants.push(Math.round(at))
  /**
   * An attempt followed by another call is cut at the coordinate that call owns, so its
   * tail is bounded by `nextStartMs`; the final attempt keeps the ordinary one-window
   * tail because nothing follows it to compete for those coordinates.
   */
  const tailLimit = hasSuccessor && nextStartMs !== null
    ? Math.max(bodyEnd, nextStartMs)
    : bodyEnd + WINDOW_MS
  for (let at = last + STEP_MS; at <= tailLimit + 1e-9; at += STEP_MS) instants.push(Math.round(at))
  return [...new Set(instants)].sort((left, right) => left - right)
}

/**
 * Compare **every** vertex of one attempt against the reference.
 *
 * The production side is the attempt's unbudgeted trace, folded with its own keyed runs so
 * that the phase labels are exercised too: `attempts[].points` is the statistics and
 * `attempts[].runs` is the colour segmentation of them, and both are checked.
 */
function compareAttempt(settledCurve, spec, segments, { expectVertices = 1 } = {}) {
  const segment = segments.find(candidate => candidate.attemptId === spec.id)
  assert.ok(segment !== undefined, `${spec.id}: the compressed clock has a segment for it`)
  const samples = referenceSamples(spec)
  const trace = settledCurve.attempts.find(candidate => candidate.attemptId === spec.id)
  assert.ok(trace !== undefined, `${spec.id}: the settled curve carries a trace for it`)

  const index = new Set(gridOf(samples, segment))
  const referenceRuns = trace.points.map(point => referenceTps(samples, point.localMs))

  let compared = 0
  for (const [position, point] of trace.points.entries()) {
    assert.equal(point.attemptId, spec.id, 'every vertex carries its attempt identity')
    assert.ok(index.has(point.localMs),
      `${spec.id}: production emitted a vertex at local ${point.localMs}, which is not on the reference grid`)
    assert.equal(point.tps, referenceRuns[position],
      `${spec.id} at local ${point.localMs}: reference says ${referenceRuns[position]}, production says ${point.tps}`)
    compared += 1
  }
  assert.ok(compared >= expectVertices,
    `${spec.id}: the comparison covered ${compared} vertices, expected at least ${expectVertices}`)

  /**
   * The grid is complete, not merely a subset: every instant the reference says is
   * drawable must be drawn. A curve that stopped at its first burst would pass the loop
   * above and fail here.
   */
  assert.deepEqual(trace.points.map(point => point.localMs), [...index].sort((left, right) => left - right),
    `${spec.id}: the trace covers every instant the reference grid names`)

  /**
   * The colour segmentation partitions the same trace: consecutive runs share their
   * boundary vertex, and every vertex carries the phase of the newest sample at or before
   * it — which is what the live meter's `streamingPhase` reports.
   */
  let expectedPhase = null
  for (const [position, point] of trace.points.entries()) {
    let newest = null
    for (const sample of samples) if (sample.localMs <= point.localMs) newest = sample
    const phase = newest === null ? null : newest.kind
    if (phase !== expectedPhase) {
      assert.equal(point.activePhase, phase,
        `${spec.id} at local ${point.localMs}: the phase label must change exactly where the newest sample does`)
      expectedPhase = phase
    }
    assert.equal(point.activePhase, phase, `${spec.id} at local ${point.localMs}: phase label`)
  }
  if (trace.runs.length > 1) {
    for (let position = 1; position < trace.runs.length; position += 1) {
      const previous = trace.runs[position - 1]
      const current = trace.runs[position]
      assert.equal(previous.points.at(-1), current.points[0],
        `${spec.id}: runs ${position - 1} and ${position} must share their boundary vertex`)
      assert.notEqual(previous.phase, current.phase, `${spec.id}: adjacent runs differ in phase or are one run`)
    }
  }
  return { vertices: compared, episodes: episodesOf(samples).length, runs: trace.runs.length }
}

/**
 * The independent global peak.
 *
 * It shares no code with production beyond the sample weights: for every instant on every
 * attempt's reference grid, it sums the literal trailing window over that attempt's whole
 * script, and takes the maximum. `curve.peakTps` must equal it.
 */
function referencePeak({ attempts, compressed }) {
  let peak = 0
  for (const spec of attempts) {
    const segment = compressed.segments.find(candidate => candidate.attemptId === spec.id)
    if (segment === undefined) continue
    const samples = referenceSamples(spec)
    for (const at of gridOf(samples, segment)) peak = Math.max(peak, referenceTps(samples, at))
  }
  return peak
}

// ---------------------------------------------------------------------------
// Named scenarios: one per frozen curve semantic named in the Phase 7 plan.
// ---------------------------------------------------------------------------

test('reference agreement: one burst, two measurements half a window apart', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }
  const { curve, compressed } = drive({ attempts: [attempt] })
  compareAttempt(curve, attempt, compressed.segments, { expectVertices: 7 })
  /** The shape the project has always drawn, restated as the reference's answer. */
  assert.deepEqual(curve.attempts[0].points.map(p => p.tps), [100, 100, 200, 200, 100, 100, 0])
})

test('reference agreement: two bursts three windows apart', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [3000, 'output']] }
  const { curve, compressed } = drive({ attempts: [attempt] })
  const result = compareAttempt(curve, attempt, compressed.segments)
  assert.equal(result.episodes, 2, 'the reference sees two bursts')
  assert.equal(result.runs, 1, 'and the drawing keeps them on one run, because the phase never changed')
  /**
   * The Phase 7 counterexample, asserted through the reference rather than through a
   * hand-written expectation: the resumption instant measures its own window alone.
   */
  const points = curve.attempts[0].points
  assert.equal(points.find(point => point.localMs === 3000).tps, 100)
  assert.equal(points.find(point => point.localMs === 2000).tps, 0, 'and the silence between them is drawn')
  /** The whole ladder, so a shift of one step in either direction fails. */
  assert.deepEqual(points.map(point => [point.localMs, point.tps]), [
    [0, 100], [250, 100], [500, 100], [750, 100], [1000, 0],
    [1250, 0], [1500, 0], [1750, 0], [2000, 0], [2250, 0], [2500, 0], [2750, 0],
    [3000, 100], [3250, 100], [3500, 100], [3750, 100], [4000, 0],
  ], 'the body ladder runs across the silence and the tail ladder closes it')
})

test('reference agreement: a gap below the window is one continuous climb', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [750, 'output']] }
  const { curve, compressed } = drive({ attempts: [attempt] })
  const result = compareAttempt(curve, attempt, compressed.segments, { expectVertices: 8 })
  assert.equal(result.episodes, 1)
  assert.equal(curve.attempts[0].points.find(point => point.localMs === 750).tps, 200,
    'both deltas are inside the window at 750 ms')
})

test('reference agreement: a gap of exactly one window, and the sample at zero expires at its far edge', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [1000, 'output']] }
  const { curve, compressed } = drive({ attempts: [attempt] })
  compareAttempt(curve, attempt, compressed.segments, { expectVertices: 7 })
  /**
   * At local 1000 the window is `(0, 1000]`, so the sample at zero has expired at exactly
   * the instant the second one arrives. The reference says the same thing without being
   * told about episodes at all.
   */
  assert.equal(curve.attempts[0].points.find(point => point.localMs === 1000).tps, 100)
  assert.equal(referenceTps(referenceSamples(attempt), 1000), 100)
})

test('reference agreement: a gap of one window plus one step, on and off the grid', () => {
  /**
   * The gap is expressed on the sampling grid so that the boundary is exact: 1000 ms never
   * empties the window and 1250 ms does. An off-grid gap such as 1001 ms also empties it,
   * and the resumption is then measured on the first grid instant at or after it.
   */
  const onGrid = { id: 'a', step: 1, local: [[0, 'output'], [1250, 'output']] }
  const first = drive({ attempts: [onGrid] })
  const onGridResult = compareAttempt(first.curve, onGrid, first.compressed.segments)
  assert.equal(onGridResult.episodes, 2)
  assert.equal(first.curve.attempts[0].points.find(point => point.localMs === 1000).tps, 0,
    'the window is empty at 1000 ms, exactly one window after the first delta')
  assert.equal(first.curve.attempts[0].points.find(point => point.localMs === 1250).tps, 100)

  const offGrid = { id: 'a', step: 1, local: [[0, 'output'], [1001, 'output']] }
  const second = drive({ attempts: [offGrid] })
  compareAttempt(second.curve, offGrid, second.compressed.segments)
  assert.deepEqual(second.curve.attempts[0].points.map(point => [point.localMs, point.tps]), [
    [0, 100], [250, 100], [500, 100], [750, 100], [1000, 0],
    [1251, 100], [1501, 100], [1751, 100], [2001, 0],
  ], 'an off-grid resumption shifts the tail ladder one step out, so every window it measures is whole')
})

test('reference agreement: three bursts in one attempt', () => {
  const attempt = { id: 'a', step: 1, local: [[0, 'output'], [1250, 'output'], [2500, 'output']] }
  const { curve, compressed } = drive({ attempts: [attempt] })
  const result = compareAttempt(curve, attempt, compressed.segments)
  assert.equal(result.episodes, 3, 'three genuinely separate bursts')
  assert.equal(result.runs, 1, 'and one coloured run, because the phase never changed')
  assert.equal(curve.peakTps, 100, 'no window ever holds two of them')
})

test('reference agreement: reasoning and output alternating inside one attempt', () => {
  const attempt = {
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [500, 'reasoning'], [3000, 'output'], [3500, 'output'], [7000, 'reasoning']],
  }
  const { curve, compressed } = drive({ attempts: [attempt] })
  const result = compareAttempt(curve, attempt, compressed.segments)
  assert.equal(result.runs, 3, 'reasoning, output, reasoning: three coloured runs of one trace')

  /**
   * The cross-phase rule, stated against the reference: at a transition the window holds
   * **both** phases' tokens. At local 3500 the window is `(2500, 3500]` and holds the two
   * output deltas alone, so the value is 200 — twice what either delta alone would give,
   * and the number a phase-filtered curve could not produce.
   */
  const points = curve.attempts[0].points
  const samples = referenceSamples(attempt)
  for (const localMs of [0, 500, 1000, 3000, 3500, 4000, 7000, 7500]) {
    const point = points.find(candidate => candidate.localMs === localMs)
    assert.ok(point !== undefined, `the trace samples ${localMs}`)
    assert.equal(point.tps, referenceTps(samples, localMs),
      `at ${localMs} the trace must be the total window over every phase`)
  }
  assert.equal(points.find(point => point.localMs === 500).tps, 200,
    'two reasoning deltas half a window apart: 200')
  assert.equal(points.find(point => point.localMs === 3500).tps, 200,
    'two output deltas half a window apart: also 200, and on a different phase')
  assert.equal(points.find(point => point.localMs === 2000).tps, 0,
    'the silence between the phases is a real zero, not a gap in the trace')

  /** A different offset, where the two phases really do share a window. */
  const overlapping = {
    id: 'b',
    step: 1,
    local: [[0, 'reasoning'], [500, 'output']],
  }
  const second = drive({ attempts: [overlapping] })
  const at500 = second.curve.attempts[0].points.find(point => point.localMs === 500)
  assert.equal(at500.tps, 200, 'reasoning + output in one window: the total, never one phase\'s share')
  assert.equal(at500.activePhase, 'output', 'and labelled with the newest sample\'s phase')
})

test('reference agreement: across an attempt boundary, each call is measured on its own clock', () => {
  const first = { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }
  const second = { id: 'b', step: 2, local: [[0, 'output'], [500, 'output']] }
  const { curve, compressed } = drive({
    attempts: [first, second],
    tools: [{ callId: 't1', startMs: 1000, endMs: 60_000 }],
  })
  compareAttempt(curve, first, compressed.segments, { expectVertices: 3 })
  compareAttempt(curve, second, compressed.segments, { expectVertices: 7 })
  /**
   * Both calls stream the same shape, so the two traces must report the same numbers. A
   * bridged window would make the second one larger; the reference measures each over its
   * own script, which is the per-attempt partition restated.
   */
  assert.deepEqual(curve.attempts[1].points.map(p => p.tps), [100, 100, 200, 200, 100, 100, 0])
  assert.deepEqual(curve.attempts[0].points.map(p => p.tps), [100, 100, 200],
    'attempt A is measured on its own clock up to the coordinate attempt B takes over')
  assert.equal(curve.peakTps, 200)
})

test('reference agreement: across a retry boundary the abandoned call seeds nothing', () => {
  const abandoned = { id: 'retry-1', step: 1, local: [[0, 'output'], [500, 'output']], retried: true }
  const replacement = { id: 'retry-2', step: 1, local: [[0, 'output'], [500, 'output']] }
  const { curve, compressed } = drive({ attempts: [abandoned, replacement] })
  compareAttempt(curve, abandoned, compressed.segments)
  compareAttempt(curve, replacement, compressed.segments)
  /**
   * Both attempts share the compressed coordinate zero, so only the attempt identity can
   * keep them apart. Each opens on its own window, which holds one delta: 100, never the
   * other call's 200.
   */
  assert.deepEqual(curve.attempts.map(attempt => attempt.points[0].tps), [100, 100])
  assert.equal(curve.peakTps, 200, 'an attempt still owns its own measurement')
})

// ---------------------------------------------------------------------------
// The independent peak.
// ---------------------------------------------------------------------------

test('the published peak equals the brute-force total-window reference', () => {
  const attempts = [
    { id: 'a', step: 1, local: [[0, 'reasoning'], [500, 'output'], [1000, 'reasoning']] },
    { id: 'b', step: 2, local: [[0, 'output'], [3000, 'output']] },
    { id: 'c', step: 3, local: [[0, 'reasoning'], [250, 'reasoning'], [500, 'reasoning']] },
  ]
  const { curve, compressed } = drive({
    attempts,
    tools: [{ callId: 't1', startMs: 1500, endMs: 40_000 }],
  })
  const reference = referencePeak({ attempts, compressed })
  assert.ok(reference > 0)
  assert.equal(curve.peakTps, reference,
    `the published peak ${curve.peakTps} must equal the independent reference ${reference}`)
  /**
   * And it is not a phase share: attempt `c` streams three reasoning deltas half a window
   * apart, so its total window holds 300 tokens while either phase alone would hold 300 as
   * well — attempt `a` is where the two differ, and it is the one that decides.
   */
  assert.equal(curve.peakTps, 300)
})

test('every recorded generated family agrees with the brute-force reference, peaks included', () => {
  const specs = generatedAttempts(60)
  let vertices = 0
  let multiEpisode = 0
  let multiRun = 0
  for (const spec of specs) {
    const { curve, compressed } = drive({ attempts: [spec] })
    const result = compareAttempt(curve, spec, compressed.segments)
    assert.equal(curve.peakTps, referencePeak({ attempts: [spec], compressed }),
      `${spec.id}: the published peak must equal the independent reference`)
    vertices += result.vertices
    if (result.episodes > 1) multiEpisode += 1
    if (result.runs > 1) multiRun += 1
  }
  /**
   * Coverage floors: the point of the parameterization is that it exercises more than
   * single-burst turns, and a future change that quietly made every case trivial would
   * otherwise still pass.
   */
  assert.ok(vertices > 300, `the generated set covered ${vertices} vertices`)
  assert.ok(multiEpisode >= 20, `only ${multiEpisode} of ${specs.length} generated turns had multiple bursts`)
  assert.equal(multiRun, 0, 'single-phase attempts never produce more than one coloured run')
})

test('generated turns never resurrect an expired sample at a resumption instant', () => {
  /**
   * The Phase 7 defect, stated as a property over every generated case: at an instant where
   * a silent model resumes, the rate must equal the literal trailing window over the whole
   * attempt. An implementation that reopened the window would disagree exactly there, and
   * the counterexample in `test/curve-episode-opening.test.js` is the minimal instance.
   *
   * The instants are taken from the reference's own episode partition, so this test does
   * not depend on production having a notion of episodes at all — which, since Phase 7C, it
   * does not.
   */
  const specs = generatedAttempts(60)
  let resumptions = 0
  for (const spec of specs) {
    const { curve } = drive({ attempts: [spec] })
    const samples = referenceSamples(spec)
    const openings = new Set(episodesOf(samples).map(episode => episode.firstSampleMs))
    for (const point of curve.attempts[0].points) {
      if (!openings.has(point.localMs)) continue
      resumptions += 1
      assert.equal(point.tps, referenceTps(samples, point.localMs),
        `${spec.id}: the resumption vertex at ${point.localMs} did not measure its own window`)
    }
  }
  assert.ok(resumptions >= 20, `only ${resumptions} resumption instants were exercised`)
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
 * Generated single-phase attempts: one to five token-producing instants, gaps drawn from a
 * set spanning below, at and above the window.
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

test('both phases of a generated alternating turn match the brute-force reference', () => {
  const random = seeded(0xa17e)
  let vertices = 0
  let transitions = 0
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
    const { curve, compressed } = drive({ attempts: [spec] })
    const result = compareAttempt(curve, spec, compressed.segments)
    vertices += result.vertices
    transitions += result.runs - 1
    assert.equal(curve.peakTps, referencePeak({ attempts: [spec], compressed }))

    /**
     * No vertex may sit outside every burst the reference found for its own phase — the
     * structural claim that a run covers only its own phase's evidence — and the phase label on
     * every vertex must be the newest sample's, which the comparison above already asserted one
     * vertex at a time.
     *
     * A run opens either inside its own phase's labelled stretch or on the shared seam in front
     * of it, which carries the previous tone. That seam is the one vertex a run may hold from
     * outside its own phase, and it is exactly what keeps the two subpaths continuous.
     */
    const runs = curve.attempts[0].runs
    for (const [index, run] of runs.entries()) {
      const foreign = new Set(run.points.map(point => point.activePhase).filter(phase => phase !== run.phase))
      if (foreign.size === 0) continue
      assert.ok(index > 0, `${run.phase}: only a run that follows another may open on a shared seam`)
      assert.deepEqual([...foreign], [runs[index - 1].phase],
        `${run.phase}: and only on the tone it follows`)
    }
  }
  assert.ok(vertices > 100, `the alternating set covered ${vertices} vertices`)
  assert.ok(transitions >= 20, `the alternating set covered ${transitions} phase transitions`)
})

test('a trace is a function of one attempt alone, whatever its neighbours do', () => {
  /**
   * The strongest available structural check on the per-attempt partition. The same script
   * is driven twice: once as the only call of its turn, and once as the **second** call,
   * after a first call that occupies exactly the same compressed width. The two placements
   * give the attempt the same compressed coordinates and the same "owns its own tail"
   * status, so its trace must be identical vertex for vertex. Only a window that never read
   * a neighbouring attempt's samples can survive that.
   */
  const subject = {
    id: 'subject',
    step: 2,
    local: [[0, 'reasoning'], [400, 'output'], [5000, 'output'], [5400, 'reasoning']],
  }
  const identicalBefore = {
    id: 'before',
    step: 1,
    local: [[0, 'output'], [400, 'reasoning'], [5000, 'output'], [5400, 'output']],
  }
  const alone = drive({ attempts: [subject] })
  const after = drive({
    attempts: [identicalBefore, subject],
    tools: [{ callId: 't1', startMs: 6000, endMs: 40_000 }],
  })

  const traceOf = (curve) => {
    const trace = curve.attempts.find(candidate => candidate.attemptId === 'subject')
    return {
      startMs: trace.startMs,
      /**
       * Every vertex stored on its **attempt-local** clock, which is the clock the window
       * is defined on and therefore the one two placements can legitimately be compared
       * on. The compressed coordinate is compared separately, as the offset it is.
       */
      points: trace.points.map(point => [point.localMs, point.tps, point.activePhase]),
      /** The runs, re-based to the attempt's own start for the same reason. */
      runs: trace.runs.map(run => [
        run.phase,
        run.points[0].timeMs - trace.startMs,
        run.points.at(-1).timeMs - trace.startMs,
      ]),
    }
  }
  const solo = traceOf(alone.curve)
  const embedded = traceOf(after.curve)
  assert.equal(embedded.startMs, 5400,
    'the second placement is shifted by exactly the first call\'s compressed width')
  assert.deepEqual(embedded.points, solo.points,
    'attempt `subject` measures the same rates and the same phase labels wherever it sits on the axis')
  assert.deepEqual(embedded.runs, solo.runs,
    'and the same colour segmentation, so no neighbouring call reached into it')

  /** The reference agrees with both. */
  compareAttempt(alone.curve, subject, alone.compressed.segments)
  compareAttempt(after.curve, subject, after.compressed.segments)

  /**
   * The one thing a neighbour legitimately changes: an attempt followed by another call is
   * cut at the coordinate that call owns, so its tail cannot be drawn over coordinates the
   * next call is about to use. The cut is a width limit, never a magnitude one — the
   * vertices that survive it carry the same values they would have carried alone.
   */
  const first = drive({
    attempts: [
      { id: 'subject', step: 1, local: subject.local },
      { id: 'after', step: 2, local: [[0, 'output'], [250, 'output']] },
    ],
    tools: [{ callId: 't1', startMs: 6000, endMs: 40_000 }],
  })
  const cut = first.curve.attempts.find(candidate => candidate.attemptId === 'subject')
  const boundary = first.compressed.segments[0].nextStartMs
  assert.ok(cut.points.at(-1).timeMs <= boundary + 1e-9,
    `the trace may not be drawn past the coordinate the next attempt owns (${cut.points.at(-1).timeMs} <= ${boundary})`)
  assert.ok(boundary - cut.points.at(-1).timeMs < STEP_MS,
    'and it reaches to within one sampling step of it, rather than stopping at the last delta')
  const soloPoints = new Map(solo.points.map(entry => [entry[0], entry[1]]))
  for (const point of cut.points) {
    assert.equal(point.tps, soloPoints.get(point.localMs),
      `the cut must not move a value: ${point.localMs} ms reads ${point.tps}`)
  }
})

test('the compressed axis and the trace agree on where each attempt ends', () => {
  /**
   * A structural check that does not go through the window at all: an attempt's trace can
   * never draw past the coordinate that attempt owns. The final attempt owns its own
   * one-window tail; every earlier one is cut where its successor begins.
   */
  const attempts = [
    { id: 'a', step: 1, local: [[0, 'output'], [1000, 'output']] },
    { id: 'b', step: 2, local: [[0, 'reasoning'], [700, 'output']] },
    { id: 'c', step: 3, local: [[0, 'output']] },
  ]
  const { curve, compressed } = drive({
    attempts,
    tools: [
      { callId: 't1', startMs: 2000, endMs: 30_000 },
      { callId: 't2', startMs: 31_000, endMs: 90_000 },
    ],
  })
  for (const [index, segment] of compressed.segments.entries()) {
    const trace = curve.attempts[index]
    assert.equal(trace.startMs, segment.startMs)
    assert.equal(trace.endMs, segment.endMs)
    const drawn = trace.points.map(point => point.timeMs)
    assert.equal(drawn[0], segment.startMs, 'a trace opens on its own attempt\'s first coordinate')
    const limit = segment.hasSuccessor ? segment.nextStartMs : segment.endMs + WINDOW_MS
    assert.ok(drawn.at(-1) <= limit + 1e-9,
      `${segment.attemptId}: the trace reaches ${drawn.at(-1)}, past its own limit ${limit}`)
  }
  /** The whole chart fits the axis, and the axis is model generation only. */
  assert.equal(curve.durationMs, compressed.durationMs)
  assert.equal(curve.durationMs, 1000 + 700 + 0, 'a tool gap and a zero-width attempt consume no width')
  assert.equal(peakTps(...curve.attempts.map(attempt => attempt.points)), curve.peakTps)
})

test('the attempt trace helper reproduces what the settled curve publishes', () => {
  /**
   * `attemptTrace` is the pure function `settle()` calls. Re-deriving one attempt's trace
   * from the compressed samples and the segment must reproduce the published vertex list
   * exactly, which is what keeps the pure layer and the store from drifting.
   */
  const attempts = [
    { id: 'a', step: 1, local: [[0, 'reasoning'], [600, 'output']] },
    { id: 'b', step: 2, local: [[0, 'output'], [250, 'output'], [5000, 'reasoning']] },
  ]
  const { curve, compressed } = drive({ attempts, tools: [{ callId: 't1', startMs: 1000, endMs: 9000 }] })
  for (const segment of compressed.segments) {
    const rebuilt = attemptTrace(segment, compressed.samples)
    const published = curve.attempts.find(candidate => candidate.attemptId === segment.attemptId)
    assert.deepEqual(
      rebuilt.points.map(point => [point.localMs, point.timeMs, point.tps, point.activePhase]),
      published.points.map(point => [point.localMs, point.timeMs, point.tps, point.activePhase]),
      `${segment.attemptId}: the pure helper and the settled curve agree vertex for vertex`,
    )
    assert.deepEqual(
      rebuilt.visualRuns.map(run => [run.phase, run.startIndex, run.endIndex]),
      published.runs.map((run, index) => [run.phase, run.startIndex, run.endIndex]),
      `${segment.attemptId}: and on the colour segmentation`,
    )
  }
})
