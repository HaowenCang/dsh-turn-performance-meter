/**
 * The phase-cumulative trace, scenario by scenario.
 *
 * `test/curve-reference-cumulative.test.js` checks the arithmetic against an independent
 * brute-force reference; `test/curve-regression-matrix.test.js` holds one named scenario per
 * frozen semantic. This file is the **acceptance matrix** for the Phase 9.2 statistic and the
 * trace it runs on, as corrected by Phase 9.4, stated as the smallest case that can
 * distinguish them from their predecessors:
 *
 *   - a curve vertex at attempt-local `t` reports the phase-cumulative average of the episode
 *     in force — `round(mass * 1000 / (t - firstSampleOfEpisode))` — so a phase change resets
 *     the clock and the numerator, a silence decays hyperbolically and never reaches exactly
 *     zero, and the terminal episode runs to the attempt's settlement instant
 *     (`docs/METRICS_SPEC.md` §8.2);
 *   - the trace is one attempt-local **total** trace per model attempt, sampled on each
 *     episode's own 100 ms ladder to the attempt's own end instant, which is appended when it
 *     does not fall on that ladder;
 *   - a vertex is a measurement only when the shared publication policy admits it: at least
 *     three contributing samples **and** at least 100 ms of the episode's own clock. Every
 *     other vertex publishes `tps: null`, never `0`;
 *   - tool gaps, retries and inter-attempt waits own no coordinate and no denominator: the
 *     next attempt opens exactly where the previous attempt's clock stopped.
 *
 * Each scenario also asserts the property a chart reader depends on most: that a phase change
 * is a colour hand-off rather than a horizontal gap, and that a tool gap consumes no x-axis
 * width. Every expected rate is written as an explicit `mass * 1000 / elapsed` derivation, so
 * the numbers come from the definition rather than from a run. Because a publishable rate
 * needs three deltas, every episode below carries at least three, which is the smallest
 * scenario the corrected contract can express.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'
import { DEFAULT_SAMPLE_EVERY_MS, peakTps } from '../src/core/curve.js'

/**
 * Every delta in this file weighs exactly 100 raw shape units — 400 Latin characters at the
 * documented four-characters-per-token prior — so an episode's first step reads
 * `100 * 1000 / 100 = 1000` tokens/s and every expected value below is a whole multiple of it.
 */
const DELTA_CHARACTERS = 400
const DELTA_TOKENS = 100

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })

/** One delta weighing `characters / 4` tokens, asserted rather than assumed. */
function weighing(kind, characters = DELTA_CHARACTERS) {
  const text = 'x'.repeat(characters)
  assert.equal(heuristicTokenWeight(text), characters / 4,
    `the generator assumes ${characters} characters weigh ${characters / 4} tokens`)
  return kind === 'reasoning' ? reasoning(text) : output(text)
}

/**
 * Drive a turn from a script on the **attempt-local** clock.
 *
 * `attempts` entries are `{ id, step, local: [[localMs, kind], ...], characters?, tailMs?,
 * retried?, tools? }`; a tool is `{ durationMs }` and is placed after the attempt's last
 * delta, so the tool gap is real wall time that the compressed axis removes. `tailMs` is the
 * terminal generated-delta → settlement tail the attempt owns; `0` means its settlement was
 * never observed later than its last delta, so the trace ends on that delta.
 */
function drive(attempts, { endPaddingMs = 2000 } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  let offsetMs = 0
  let maxWallMs = 0
  for (const spec of attempts) {
    const attempt = store.beginAttempt(record, { attemptId: spec.id, step: spec.step, startedAtMs: offsetMs })
    const local = [...(spec.local ?? [])].sort((a, b) => a[0] - b[0])
    for (const [localMs, kind] of local) {
      const wallMs = offsetMs + localMs
      store.acceptChunk(record, attempt, { timeMs: wallMs, chunk: weighing(kind, spec.characters) })
      maxWallMs = Math.max(maxWallMs, wallMs)
    }
    const span = local.length === 0 ? 0 : local[local.length - 1][0]
    store.settleAttempt(attempt, {
      settledAtMs: offsetMs + span + (spec.tailMs ?? 0),
      settlementKind: spec.retried === true ? 'attempt' : 'message',
      surfaceCommitted: spec.retried !== true,
      attemptOutcome: spec.retried === true ? 'retried' : 'committed',
      settlementSeq: spec.step,
    })
    offsetMs += span
    for (const [index, tool] of (spec.tools ?? []).entries()) {
      store.toolStarted(record, { callId: `${spec.id}-t${index}`, name: 'pwsh', timeMs: offsetMs + 10 })
      store.toolSettled(record, {
        callId: `${spec.id}-t${index}`,
        timeMs: offsetMs + 10 + tool.durationMs,
        status: 'ok',
      })
    }
    offsetMs += 100
  }
  const curve = store.endTurn(record, { timeMs: maxWallMs + endPaddingMs, status: 'completed' }).curve
  return { store, record, curve }
}

const traceOf = (curve, id) => curve.attempts.find(attempt => attempt.attemptId === id)

/** Local instants and rates, as the compact form every scenario asserts against. */
const ladder = trace => trace.points.map(point => [point.localMs, point.tps])

/** Rate of one vertex, by attempt-local instant, or `undefined`. */
const at = (trace, localMs) => trace.points.find(point => point.localMs === localMs)?.tps

/** The attempt-local instants whose published vertex carries no measured rate. */
const unmeasuredOf = trace => trace.points.filter(point => point.tps === null).map(point => point.localMs)

/**
 * The three-delta burst every episode below opens with, and the four vertices it produces:
 * an opening anchor with no elapsed clock, a vertex still below the sample gate, and then the
 * episode's first two publishable rates.
 */
const BURST = [[0, 'output'], [100, 'output'], [200, 'output']]
const BURST_LADDER = [[0, null], [100, null], [200, 1500]]

/* ------------------------------------------------------------------ 1-3. single phase */

test('a reasoning-only attempt is one reasoning-coloured run', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [100, 'reasoning'], [200, 'reasoning']],
    /** An 800 ms settlement tail: the terminal episode is drawn to the attempt's end. */
    tailMs: 800,
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(ladder(trace), [
    [0, null], [100, null],
    [200, Math.round(300 * 1000 / 200)], [300, Math.round(300 * 1000 / 300)],
    [400, 750], [500, 600], [600, 500], [700, 429],
    [800, 375], [900, 333], [1000, 300],
  ], 'the episode opens on its anchor and admits no rate until three deltas and 100 ms have '
    + 'arrived; from 200 ms the frozen 300 tokens dilute to the attempt\'s settlement')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning'], 'one phase, one coloured run')
  assert.equal(curve.series.find(entry => entry.key === 'reasoning').present, true)
  assert.deepEqual(curve.series.find(entry => entry.key === 'output').runs, [],
    'a phase with no evidence has no run, and is never a flat zero line')
  assert.equal(curve.peakTps, 1500, 'the peak is the episode\'s first publishable step, 300 * 1000 / 200')
})

test('an output-only attempt is one output-coloured run', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: BURST, tailMs: 300 }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(ladder(trace), [
    ...BURST_LADDER,
    [300, 1000],
    [400, 750],
    [500, 600],
  ], 'the same estimator over text deltas, ending on the attempt\'s own last instant')
  assert.deepEqual(trace.runs.map(run => run.phase), ['output'])
  assert.deepEqual(curve.series.find(entry => entry.key === 'reasoning').runs, [])
  assert.equal(curve.peakTps, 1500)
})

test('reasoning then output resets the episode clock and shares its seam vertex', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [100, 'reasoning'], [200, 'reasoning'],
      [500, 'output'], [550, 'output'], [600, 'output']],
    /** The attempt settles 50 ms after its last delta, off the 100 ms ladder. */
    tailMs: 50,
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning', 'output'],
    'two stretches of one trace, two coloured subpaths')
  const [first, second] = trace.runs
  assert.equal(first.points.at(-1), second.points[0],
    'the tone changes on a shared boundary vertex, not across a gap')
  assert.equal(first.points.at(-1).localMs, 400, 'the seam is the outgoing stretch\'s last labelled vertex')
  assert.equal(at(trace, 500), null,
    'and the new episode opens with no elapsed clock: it publishes no rate at all')
  assert.equal(trace.points.find(point => point.localMs === 500).rateUnavailableReason, 'opening-anchor')
  assert.equal(at(trace, 600), 3000,
    'three 100-token output deltas over the episode\'s own first 100 ms of sampled clock')
  assert.equal(at(trace, 650), 2000,
    'and the 50 ms settlement tail dilutes them: 300 * 1000 / 150')
  assert.equal(trace.points.at(-1).localMs, 650,
    'the attempt\'s own end instant is appended because it does not fall on the ladder')
})

test('reasoning -> output across a silence: the old episode decays, the new one opens on its own clock', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [100, 'reasoning'], [200, 'reasoning'],
      [3000, 'output'], [3050, 'output'], [3100, 'output']],
    tailMs: 100,
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning', 'output'])
  assert.equal(at(trace, 2000), Math.round(300 * 1000 / 2000),
    'the silence is a value on the trace: three 100-token deltas frozen while the clock advances')
  assert.equal(at(trace, 2000), 150)
  assert.equal(at(trace, 3000), null, 'the output episode opens on its own clock at the phase change')
  assert.equal(at(trace, 3100), 3000, 'and measures its own three deltas over its own first step')
  assert.deepEqual(unmeasuredOf(trace),
    [0, 100, 3000],
    'a stall decays hyperbolically and never reaches exactly zero, so the only vertices without a '
    + 'rate are the openings their own gates withhold')
  assert.equal(trace.runs[0].points.at(-1).timeMs, trace.runs[1].points[0].timeMs,
    'the two tones still meet, on the vertex where the phase changes')
})

test('reasoning -> output -> reasoning alternates tones without splitting the trace', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [100, 'reasoning'], [200, 'reasoning'],
      [3000, 'output'], [3050, 'output'], [3100, 'output'],
      [7000, 'reasoning'], [7050, 'reasoning'], [7100, 'reasoning']],
    tailMs: 100,
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning', 'output', 'reasoning'])
  for (let index = 1; index < trace.runs.length; index += 1) {
    assert.equal(trace.runs[index - 1].points.at(-1).timeMs, trace.runs[index].points[0].timeMs)
  }
  assert.equal(at(trace, 3100), 3000, 'the output burst: its three deltas over its own first step')
  assert.equal(at(trace, 5000), Math.round(300 * 1000 / 2000),
    'and it dilutes while the output episode falls silent')
  assert.equal(at(trace, 7000), null, 'each phase change opens a new episode on its own anchor')
  assert.deepEqual(unmeasuredOf(trace), [0, 100, 3000, 7000],
    'every other vertex of every stretch carries a measured rate')
})

/* ----------------------------------------------------------------- 6-7. intra-attempt stall */

test('a long internal stall decays hyperbolically and then dilutes', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'output'], [100, 'output'], [200, 'output'], [4000, 'output']],
    tailMs: 100,
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['output'],
    'a stall is not a phase change, so it is not a new run')
  assert.equal(curve.durationMs, 4100, 'the stall and the settlement tail keep their full width on the axis')
  assert.equal(trace.points.at(-1).timeMs, curve.durationMs,
    'and the trace ends on the attempt\'s own end instant')
  assert.equal(at(trace, 200), 1500, 'three deltas over the episode\'s first 200 ms')
  assert.equal(at(trace, 3900), Math.round(300 * 1000 / 3900),
    'the hyperbolic decay at the end of the silence')
  assert.equal(at(trace, 3900), 77)
  assert.equal(at(trace, 4000), 100, 'the resumed delta raises the numerator: 400 tokens over 4000 ms')
  assert.equal(at(trace, 4100), Math.round(400 * 1000 / 4100))

  /**
   * The stall itself, vertex by vertex. The numerator is frozen while the denominator
   * advances, so the stretch is non-increasing and never reaches exactly zero; over its
   * first thirty-seven vertices the ratio falls fast enough that `Math.round` cannot tie,
   * so the decay is strictly hyperbolic there.
   */
  const decay = trace.points.filter(point => point.localMs >= 200 && point.localMs <= 3900)
  for (let index = 1; index < decay.length; index += 1) {
    assert.ok(decay[index].tps <= decay[index - 1].tps,
      `the stall must never rise while no sample arrives: ${decay[index - 1].tps} at `
      + `${decay[index - 1].localMs} ms, then ${decay[index].tps} at ${decay[index].localMs} ms`)
  }
  const strict = decay.filter(point => point.localMs <= 2900)
  for (let index = 1; index < strict.length; index += 1) {
    assert.ok(strict[index].tps < strict[index - 1].tps,
      `the decay must be strictly hyperbolic while the numerator is frozen, at ${strict[index].localMs} ms`)
  }
  assert.equal(decay.every(point => point.tps > 0), true,
    'the hyperbolic decay never reaches exactly zero while the attempt is alive')
  assert.equal(curve.peakTps, 1500, 'the peak is the episode\'s first publishable step')
})

/* --------------------------------------------------------------- 8. tool gaps have no width */

test('a tool gap consumes zero x-axis width and still resets the episode clock', () => {
  const withoutTool = drive([
    { id: 'a', step: 1, local: BURST },
    { id: 'b', step: 2, local: BURST },
  ])
  const withTool = drive([
    { id: 'a', step: 1, local: BURST, tools: [{ durationMs: 60_000 }] },
    { id: 'b', step: 2, local: BURST },
  ])
  assert.deepEqual(
    withTool.curve.attempts.map(attempt => ladder(attempt)),
    withoutTool.curve.attempts.map(attempt => ladder(attempt)),
    'a 60 s tool makes no difference at all to the drawn trace',
  )
  assert.equal(withTool.curve.durationMs, withoutTool.curve.durationMs)
  assert.equal(withTool.curve.durationMs, 400, 'the axis is model generation only')
  assert.deepEqual(withTool.curve.segments.map(segment => [segment.startMs, segment.endMs]),
    [[0, 200], [200, 400]], 'the two calls are adjacent after compression')
})

/* ------------------------------------------------------------------- 9-11. attempt boundaries */

test('the next attempt resets the episode clock and the boundary is a subpath break', () => {
  const { curve } = drive([
    { id: 'a', step: 1, local: BURST, tools: [{ durationMs: 30_000 }] },
    { id: 'b', step: 2, local: [[0, 'output'], [100, 'output'], [2500, 'output']], tailMs: 100 },
  ])
  const first = traceOf(curve, 'a')
  const second = traceOf(curve, 'b')
  /**
   * Attempt A is measured on its own clock to its own end; attempt B opens on the coordinate
   * A closed on, but on a clock of its own. B's third delta arrives two and a half seconds
   * after its second, so the episode holds only two samples for most of its stretch — and
   * therefore publishes no rate at all there, rather than a diluted number assembled from
   * attempt A's tokens.
   */
  assert.deepEqual(ladder(first), BURST_LADDER,
    'A stops on its own last instant')
  assert.equal(at(second, 500), null,
    'B publishes nothing from two samples, so it cannot inherit A\'s numerator at any instant')
  assert.equal(at(second, 2500), Math.round(300 * 1000 / 2500),
    'its own three deltas over its own 2500 ms: 120 tokens/s')
  assert.equal(at(second, 2500), 120)
  assert.equal(at(second, 2600), Math.round(300 * 1000 / 2600),
    'and the 100 ms settlement tail dilutes it')

  assert.equal(second.startMs, first.startMs + 200,
    'the two traces occupy adjacent compressed stretches')
  assert.deepEqual(first.runs.map(run => run.attemptId), ['a'])
  assert.deepEqual(second.runs.map(run => run.attemptId), ['b'])
  /** Two separate subpaths: no drawable path joins the two attempts. */
  const paths = [...first.runs, ...second.runs]
  assert.equal(paths.length, 2, 'one subpath per attempt here')
  assert.equal(paths[0].points.at(-1).attemptId, 'a')
  assert.equal(paths[1].points[0].attemptId, 'b')
  /** The two attempts meet at one coordinate and report their own numbers there. */
  assert.equal(first.points.at(-1).timeMs, second.points[0].timeMs)
  assert.equal(first.points.at(-1).tps, 1500, 'A closes on its own measurement')
  assert.equal(second.points[0].tps, null,
    'and B opens on its own anchor, which is not a measurement at all')
})

test('a retry resets the episode clock just as a new attempt does', () => {
  const { curve } = drive([
    { id: 'first', step: 1, local: BURST, retried: true },
    { id: 'second', step: 1, local: BURST },
  ])
  const first = traceOf(curve, 'first')
  const second = traceOf(curve, 'second')
  assert.equal(second.startMs, first.startMs + 200,
    'the abandoned prefix keeps its own two-tenths of a second, and the successor begins after it')
  assert.deepEqual(ladder(first), BURST_LADDER,
    'the abandoned prefix ends on its own last coordinate, which the successor takes over')
  assert.deepEqual(ladder(second), BURST_LADDER,
    'and the retry measures its own clock alone, ending on its own last delta')
})

/* ---------------------------------------------------- 12-13. colour is not a statistical reset */

test('a phase boundary is a colour change and an episode reset, never an x gap', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [250, 'reasoning'], [500, 'reasoning'],
      [750, 'output'], [1000, 'output'], [1250, 'output']],
  }])
  const trace = traceOf(curve, 'a')
  const [first, second] = trace.runs
  assert.equal(first.phase, 'reasoning')
  assert.equal(second.phase, 'output')

  /** Shared boundary vertex: same instant, same measured rate, one object. */
  assert.equal(first.points.at(-1), second.points[0])
  assert.equal(first.points.at(-1).timeMs, second.points[0].timeMs)
  assert.equal(first.points.at(-1).tps, second.points[0].tps)
  /**
   * The seam is the outgoing stretch's last labelled vertex, which is the last one still
   * labelled `reasoning`. Both subpaths draw it, so the tone changes on a measured vertex
   * rather than across a gap; the vertex keeps the phase the meter was reporting at that
   * instant, which is exactly what `streamingPhase` would have said.
   */
  assert.equal(first.points.at(-1).activePhase, 'reasoning')
  assert.equal(second.points[0].activePhase, 'reasoning')
  const afterSeam = second.points[1]
  assert.equal(afterSeam.activePhase, 'output',
    'and the next vertex the output subpath draws is the first one labelled with the new phase')
  assert.equal(afterSeam.tps, null,
    'the episode reset is statistical as well: the new clock has not advanced, so it publishes nothing')
  assert.equal(at(trace, 500), 600,
    'by the phase change the reasoning episode measures its three 100-token deltas over 500 ms')
  assert.equal(at(trace, 1250), 600,
    'and the output episode measures its own three over its own 500 ms, to the attempt\'s end')

  /**
   * The two episodes' ladders interleave into one cadence with no hole: an episode's own
   * ladder stops at the last step at or before the next episode's origin, so consecutive
   * vertices are never more than one cadence step apart — including across the colour change.
   */
  for (let index = 1; index < trace.points.length; index += 1) {
    const step = trace.points[index].localMs - trace.points[index - 1].localMs
    assert.ok(step > 0 && step <= DEFAULT_SAMPLE_EVERY_MS,
      `no vertex of the trace is missing: ${trace.points[index - 1].localMs} ms then `
      + `${trace.points[index].localMs} ms is ${step} ms, which is more than one cadence step`)
  }
  /** And the seam is charged once per subpath, which is what the budget counts. */
  assert.equal(first.pointCount + second.pointCount, trace.points.length + 1)
})

/* ---------------------------------------------------------------- 14. the peak, independently */

test('the global peak is the maximum over every attempt-local phase-cumulative vertex', () => {
  const { curve } = drive([
    { id: 'a', step: 1, local: BURST, tools: [{ durationMs: 10_000 }] },
    { id: 'b', step: 2, local: BURST },
    /** 1200 characters weigh 300 tokens: a heavier call, so the peak has one owner. */
    { id: 'c', step: 3, local: BURST, characters: 1200 },
  ])
  const reference = Math.max(...curve.attempts.map(attempt => peakTps(attempt.points)))
  assert.equal(curve.peakTps, reference)
  const owner = curve.attempts.find(attempt => peakTps(attempt.points) === reference)
  assert.equal(owner.attemptId, 'c',
    'the heaviest single call owns the peak: 900 tokens over its first 200 ms')
  assert.equal(reference, 4500, '3 * 300 * 1000 / 200')
  /** The two other calls are strictly weaker, so the peak is not a tie. */
  assert.deepEqual(curve.attempts.map(attempt => peakTps(attempt.points)),
    [1500, 1500, 4500])
  /** And no run reports more than the trace it was cut from. */
  for (const attempt of curve.attempts) {
    const tracePeak = peakTps(attempt.points)
    for (const run of attempt.runs) {
      assert.ok(run.peak === null || run.peak <= tracePeak + 1e-9)
    }
  }
  /** The peak's provenance names the same call, phase and vertex the maximum sits on. */
  assert.equal(curve.peakProvenance.attemptId, 'c')
  assert.equal(curve.peakProvenance.tps, reference)
  assert.equal(curve.peakProvenance.elapsedMs, 200)
  assert.equal(curve.peakProvenance.episodeSampleCount, 3)
})

test('the curve publishes its magnitude provenance, and the fallback is explicit', () => {
  const calibrated = drive([{ id: 'a', step: 1, local: BURST }])
  assert.equal(calibrated.curve.source.aligned, true)
  assert.deepEqual(calibrated.curve.source.issues, [])

  /**
   * The store path always produces an aligned join — the two lists come from one reduction —
   * so the degradation branch is exercised in `test/curve-source.test.js` against the pure
   * function. What this asserts is the shape a caller can rely on: the provenance travels
   * with the curve and is a boolean rather than an absent field.
   */
  assert.equal(typeof calibrated.curve.source.calibrated, 'boolean')
  assert.equal(calibrated.curve.source.contributingAttemptCount, 1)
  assert.deepEqual(calibrated.curve.source.rawFallbackAttemptIds, [])
})

test('an attempt whose episodes never reach the gates reports no peak, and says why', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(ladder(trace), [
    [0, null], [100, null], [200, null], [300, null], [400, null], [500, null],
  ], 'two deltas are below the sample gate at every vertex, so no rate is published anywhere')
  assert.equal(curve.peakTps, null, 'and a turn with no publishable vertex has no peak')
  assert.equal(curve.peakProvenance, null)
  assert.deepEqual(trace.points.filter(point => point.tps === 0), [],
    'a withheld vertex is never published as a measured zero')
})
