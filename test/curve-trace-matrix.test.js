/**
 * The phase-cumulative trace, scenario by scenario.
 *
 * `test/curve-reference-cumulative.test.js` checks the arithmetic against an independent
 * brute-force reference; `test/curve-regression-matrix.test.js` holds one named scenario per
 * frozen semantic. This file is the **acceptance matrix** for the Phase 9.2 statistic and the
 * trace it runs on, stated as the smallest case that can distinguish them from their
 * predecessors:
 *
 *   - a curve vertex at attempt-local `t` reports the phase-cumulative average of the episode
 *     in force — `round(mass * 1000 / (t - firstSampleOfEpisode))` — so a phase change resets
 *     the clock and the numerator, a silence decays hyperbolically and never reaches exactly
 *     zero, and the terminal episode runs to the attempt's settlement instant
 *     (`docs/METRICS_SPEC.md` §8.2);
 *   - the trace is one attempt-local **total** trace per model attempt, sampled on the 100 ms
 *     ladder to the attempt's own end instant, which is appended when it does not fall on the
 *     ladder;
 *   - tool gaps, retries and inter-attempt waits own no coordinate and no denominator: the
 *     next attempt opens exactly where the previous attempt's clock stopped.
 *
 * Each scenario also asserts the property a chart reader depends on most: that a phase change
 * is a colour hand-off rather than a horizontal gap, and that a tool gap consumes no x-axis
 * width. Every expected rate is written as an explicit `mass * 1000 / elapsed` derivation, so
 * the numbers come from the definition rather than from a run.
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

/** The attempt-local instants whose published vertex is exactly zero. */
const zerosOf = trace => trace.points.filter(point => point.tps === 0).map(point => point.localMs)

/* ------------------------------------------------------------------ 1-3. single phase */

test('a reasoning-only attempt is one reasoning-coloured run', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [500, 'reasoning']],
    /** A half-second settlement tail: the terminal episode is drawn to the attempt's end. */
    tailMs: 500,
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(ladder(trace), [
    [0, 0], [100, 1000], [200, 500], [300, 333], [400, 250],
    [500, 400], [600, 333], [700, 286], [800, 250], [900, 222], [1000, 200],
  ], 'the episode opens on its anchor; 100 tokens over the first step is 1000 tokens/s, the second '
    + 'delta doubles the numerator at 500 ms, and the frozen 200 tokens dilute to settlement')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning'], 'one phase, one coloured run')
  assert.equal(curve.series.find(entry => entry.key === 'reasoning').present, true)
  assert.deepEqual(curve.series.find(entry => entry.key === 'output').runs, [],
    'a phase with no evidence has no run, and is never a flat zero line')
  assert.equal(curve.peakTps, 1000, 'the peak is the episode\'s first step, 100 * 1000 / 100')
})

test('an output-only attempt is one output-coloured run', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(ladder(trace), [
    [0, 0], [100, 1000], [200, 500], [300, 333], [400, 250], [500, 400],
  ], 'the same estimator over text deltas, ending on the attempt\'s own last instant')
  assert.deepEqual(trace.runs.map(run => run.phase), ['output'])
  assert.deepEqual(curve.series.find(entry => entry.key === 'reasoning').runs, [])
  assert.equal(curve.peakTps, 1000)
})

test('reasoning then output resets the episode clock and shares its seam vertex', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [500, 'output']],
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
  assert.equal(at(trace, 500), 0,
    'and the new episode opens with no elapsed clock: the anchor, not a measurement')
  assert.equal(at(trace, 550), 2000,
    'one 100-token output delta over the 50 ms settlement tail is 2000 tokens/s')
  assert.equal(trace.points.at(-1).localMs, 550,
    'the attempt\'s own end instant is appended because it does not fall on the ladder')
})

test('reasoning -> output across a silence: the old episode decays, the new one opens on its own clock', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [3000, 'output']],
    tailMs: 100,
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning', 'output'])
  assert.equal(at(trace, 2000), 50,
    'the silence is a value on the trace: one 100-token delta frozen while the clock advances')
  assert.equal(at(trace, 3000), 0, 'the output episode opens on its own clock at the phase change')
  assert.equal(at(trace, 3100), 1000, 'and measures its own delta over its own first step')
  assert.deepEqual(zerosOf(trace), [0, 3000],
    'a stall decays hyperbolically and never reaches exactly zero; the only zeros are the two '
    + 'episode openings')
  assert.equal(trace.runs[0].points.at(-1).timeMs, trace.runs[1].points[0].timeMs,
    'the two tones still meet, on the vertex where the phase changes')
})

test('reasoning -> output -> reasoning alternates tones without splitting the trace', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [500, 'reasoning'], [3000, 'output'], [3500, 'output'], [7000, 'reasoning']],
    tailMs: 100,
  }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning', 'output', 'reasoning'])
  for (let index = 1; index < trace.runs.length; index += 1) {
    assert.equal(trace.runs[index - 1].points.at(-1).timeMs, trace.runs[index].points[0].timeMs)
  }
  assert.equal(at(trace, 3500), 400, 'the output burst: its two deltas over the 500 ms since it opened')
  assert.deepEqual(zerosOf(trace), [0, 3000, 7000],
    'each phase change opens a new episode, and each opening is the only zero its stretch carries')
})

/* ----------------------------------------------------------------- 6-7. intra-attempt stall */

test('a long internal stall decays hyperbolically and then dilutes', () => {
  const { curve } = drive([{ id: 'a', step: 1, local: [[0, 'output'], [4000, 'output']], tailMs: 100 }])
  const trace = traceOf(curve, 'a')
  assert.deepEqual(trace.runs.map(run => run.phase), ['output'],
    'a stall is not a phase change, so it is not a new run')
  assert.equal(curve.durationMs, 4100, 'the stall and the settlement tail keep their full width on the axis')
  assert.equal(trace.points.at(-1).timeMs, curve.durationMs,
    'and the trace ends on the attempt\'s own end instant')
  assert.equal(at(trace, 1000), 100, 'one delta frozen: 100 tokens over one second')
  assert.equal(at(trace, 2000), 50)
  assert.equal(at(trace, 3900), 26, 'the hyperbolic decay at the end of the silence')
  assert.equal(at(trace, 4000), 50, 'the resumed delta doubles the numerator: 200 tokens over 4000 ms')

  /**
   * The stall itself, vertex by vertex. The numerator is frozen while the denominator
   * advances, so the stretch is non-increasing and never reaches exactly zero; over its
   * first twenty-nine vertices the ratio falls fast enough that `Math.round` cannot tie,
   * so the decay is strictly hyperbolic there.
   */
  const decay = trace.points.filter(point => point.localMs >= 100 && point.localMs <= 3900)
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
  assert.equal(curve.peakTps, 1000, 'the peak is the episode\'s first step, 100 * 1000 / 100')
})

/* --------------------------------------------------------------- 8. tool gaps have no width */

test('a tool gap consumes zero x-axis width and still resets the episode clock', () => {
  const withoutTool = drive([
    { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] },
    { id: 'b', step: 2, local: [[0, 'output'], [500, 'output']] },
  ])
  const withTool = drive([
    { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']], tools: [{ durationMs: 60_000 }] },
    { id: 'b', step: 2, local: [[0, 'output'], [500, 'output']] },
  ])
  assert.deepEqual(
    withTool.curve.attempts.map(attempt => ladder(attempt)),
    withoutTool.curve.attempts.map(attempt => ladder(attempt)),
    'a 60 s tool makes no difference at all to the drawn trace',
  )
  assert.equal(withTool.curve.durationMs, withoutTool.curve.durationMs)
  assert.equal(withTool.curve.durationMs, 1000, 'the axis is model generation only')
  assert.deepEqual(withTool.curve.segments.map(segment => [segment.startMs, segment.endMs]),
    [[0, 500], [500, 1000]], 'the two calls are adjacent after compression')
})

/* ------------------------------------------------------------------- 9-11. attempt boundaries */

test('the next attempt resets the episode clock and the boundary is a subpath break', () => {
  const { curve } = drive([
    { id: 'a', step: 1, local: [[0, 'output'], [500, 'output']], tools: [{ durationMs: 30_000 }] },
    { id: 'b', step: 2, local: [[0, 'output'], [2500, 'output']] },
  ])
  const first = traceOf(curve, 'a')
  const second = traceOf(curve, 'b')
  /**
   * Attempt A is measured on its own clock to its own end; attempt B opens on the coordinate
   * A closed on, but on a clock of its own: its two deltas are two and a half seconds apart,
   * so its opening vertex is the fresh anchor and its single 100-token burst dilutes from
   * 1000 tokens/s at the first step to 80 at its own last instant.
   */
  assert.deepEqual(ladder(first), [[0, 0], [100, 1000], [200, 500], [300, 333], [400, 250], [500, 400]],
    'A stops on its own last instant, its second delta still diluting')
  assert.deepEqual(ladder(second), [
    [0, 0], [100, 1000], [200, 500], [300, 333], [400, 250], [500, 200], [600, 167], [700, 143],
    [800, 125], [900, 111], [1000, 100], [1100, 91], [1200, 83], [1300, 77], [1400, 71], [1500, 67],
    [1600, 63], [1700, 59], [1800, 56], [1900, 53], [2000, 50], [2100, 48], [2200, 45], [2300, 43],
    [2400, 42], [2500, 80],
  ], 'attempt B never inherits attempt A\'s tokens: its own single delta dilutes for two '
    + 'and a half seconds, and the second one doubles the numerator at 2500 ms')

  assert.equal(second.startMs, first.startMs + 500,
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
  assert.equal(first.points.at(-1).tps, 400, 'A closes on its own measurement')
  assert.equal(second.points[0].tps, 0,
    'and B opens on its own anchor, which is a different number from the same coordinate')
})

test('a retry resets the episode clock just as a new attempt does', () => {
  const { curve } = drive([
    { id: 'first', step: 1, local: [[0, 'output'], [500, 'output']], retried: true },
    { id: 'second', step: 1, local: [[0, 'output'], [500, 'output']] },
  ])
  const first = traceOf(curve, 'first')
  const second = traceOf(curve, 'second')
  assert.equal(second.startMs, first.startMs + 500,
    'the abandoned prefix keeps its own half-second, and the successor begins after it')
  assert.deepEqual(ladder(first), [[0, 0], [100, 1000], [200, 500], [300, 333], [400, 250], [500, 400]],
    'the abandoned prefix ends on its own last coordinate, which the successor takes over')
  assert.deepEqual(ladder(second), [[0, 0], [100, 1000], [200, 500], [300, 333], [400, 250], [500, 400]],
    'and the retry measures its own clock alone, ending on its own last delta')
})

/* ---------------------------------------------------- 12-13. colour is not a statistical reset */

test('a phase boundary is a colour change and an episode reset, never an x gap', () => {
  const { curve } = drive([{
    id: 'a',
    step: 1,
    local: [[0, 'reasoning'], [250, 'reasoning'], [500, 'output'], [750, 'output'], [1000, 'output']],
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
  assert.equal(afterSeam.tps, 0,
    'the episode reset is statistical as well: the new clock has not advanced yet, so it reads 0')
  assert.equal(at(trace, 1000), 600,
    'by the attempt\'s end the output episode measures its three 100-token deltas over its own '
    + '500 ms: 300 * 1000 / 500')

  /** The trace is contiguous: consecutive vertices are one sampling step apart throughout. */
  for (let index = 1; index < trace.points.length; index += 1) {
    assert.equal(trace.points[index].localMs - trace.points[index - 1].localMs, DEFAULT_SAMPLE_EVERY_MS,
      'no vertex of the trace is missing, across the colour change or anywhere else')
  }
  /** And the seam is charged once per subpath, which is what the budget counts. */
  assert.equal(first.pointCount + second.pointCount, trace.points.length + 1)
})

/* ---------------------------------------------------------------- 14. the peak, independently */

test('the global peak is the maximum over every attempt-local phase-cumulative vertex', () => {
  const { curve } = drive([
    { id: 'a', step: 1, local: [[0, 'reasoning'], [500, 'output']], tools: [{ durationMs: 10_000 }] },
    { id: 'b', step: 2, local: [[0, 'output'], [250, 'output'], [500, 'output']] },
    /** 1200 characters weigh 300 tokens: a heavier call, so the peak has one owner. */
    { id: 'c', step: 3, local: [[0, 'reasoning'], [250, 'reasoning'], [500, 'reasoning'], [750, 'reasoning']], characters: 1200 },
  ])
  const reference = Math.max(...curve.attempts.map(attempt => peakTps(attempt.points)))
  assert.equal(curve.peakTps, reference)
  const owner = curve.attempts.find(attempt => peakTps(attempt.points) === reference)
  assert.equal(owner.attemptId, 'c',
    'the heaviest single call owns the peak: 300 tokens over its first step')
  assert.equal(reference, 3000, '300 * 1000 / 100')
  /** The two other calls are strictly weaker, so the peak is not a tie. */
  assert.deepEqual(curve.attempts.map(attempt => peakTps(attempt.points)),
    [1000, 1000, 3000])
  /** And no run reports more than the trace it was cut from. */
  for (const attempt of curve.attempts) {
    for (const run of attempt.runs) {
      assert.ok(run.peak <= peakTps(attempt.points) + 1e-9)
    }
  }
})

test('the curve publishes its magnitude provenance, and the fallback is explicit', () => {
  const calibrated = drive([{ id: 'a', step: 1, local: [[0, 'output'], [500, 'output']] }])
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
