/**
 * The completed x-axis is compressed **model-generation time**, and it stops at the
 * attempt's last model-producing delta (Phase 7C.1).
 *
 * ## The defect these tests were written against
 *
 * `compressAttempts` already measured an attempt's compressed width as the span
 * between its first and last generated delta, and `curve.durationMs` is the sum of
 * those widths. The final attempt's *trace*, however, was sampled one full window
 * past its last delta — a special rule that existed only because nothing followed
 * that attempt to compete for the axis:
 *
 *     attemptTrace:  tailLimitMs = segment.hasSuccessor
 *       ? segment.nextStartMs - startMs
 *       : bodyEndMs + windowMs          <-- final attempt only
 *
 * Those vertices carry compressed coordinates strictly greater than
 * `curve.durationMs`, and `xOf(timeMs, durationMs)` clamps every value above the
 * duration to `CURVE_VIEW_WIDTH`. Several distinct instants therefore landed on one
 * x coordinate, which the SVG draws as a vertical stroke at the chart's right edge —
 * a shape the evidence does not contain.
 *
 * ## The rule this file freezes
 *
 * For **every** attempt, including the last:
 *
 *   - x = 0 is its first model-producing delta;
 *   - x = end is its last model-producing delta;
 *   - every wall-time interval **between** those deltas is preserved in full, so an
 *     intra-attempt stall keeps its width and never becomes an attempt boundary;
 *   - nothing is allocated after the last model-producing delta, because host
 *     settlement tail is excluded from generation duration (`docs/METRICS_SPEC.md`
 *     §7, §8.1) and a per-attempt window decay is not generation.
 *
 * A tool wait and a retry still own zero width, and the attempt that follows still
 * opens on the coordinate its predecessor closed on.
 *
 * ## The endpoint anchor
 *
 * Stopping the body grid at the attempt's bound would silently drop a final delta
 * that does not sit on the 250 ms cadence — a delta at 510 ms would be sampled at
 * 500 only. The body instants are therefore the union of the cadence grid and the
 * attempt's own final model-producing instant, deduplicated and ascending, which is
 * why an off-grid last delta is always a vertex of its own.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { attemptTrace, visualRunsOf } from '../src/core/curve.js'
import { compressAttempts } from '../src/core/time-axis.js'

/** 400 characters weigh exactly 100 by `heuristicTokenWeight`. */
const DELTA_CHARS = 400

function outputChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

function reasoningChunk(text) {
  return { type: 'reasoning-delta', index: 0, text }
}

/**
 * One attempt, driven through the store exactly as the host drives it.
 *
 * `chunks` are `[timeMs, kind]` pairs; a `usage` may be supplied to anchor the
 * magnitudes. The attempt's own compressed end is its last generated delta, which is
 * the value every assertion below is written against.
 */
function driveOneAttempt(store, chunks, { usage = null } = {}) {
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  for (const [timeMs, kind] of chunks) {
    store.acceptChunk(record, attempt, {
      timeMs,
      chunk: kind === 'reasoning' ? reasoningChunk('x'.repeat(DELTA_CHARS)) : outputChunk('x'.repeat(DELTA_CHARS)),
    })
  }
  const last = chunks.length > 0 ? chunks[chunks.length - 1][0] : 0
  store.settleAttempt(attempt, {
    settledAtMs: last + 50,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage,
    settlementSeq: 1,
  })
  return store.endTurn(record, { timeMs: last + 5000, status: 'completed' })
}

/** The trace of one attempt of a settled curve. */
function traceOf(settled, attemptId = 'a') {
  return settled.curve.attempts.find(attempt => attempt.attemptId === attemptId)
}

// ---------------------------------------------------------------------------
// 1. The right edge
// ---------------------------------------------------------------------------

test('the final attempt draws no vertex after its last model-producing delta', () => {
  /**
   * The minimal counterexample, in the exact shape the audit named: one attempt,
   * deltas at 0 ms and 500 ms, a 1000 ms window and a 250 ms cadence.
   *
   * The attempt's compressed width is 500 ms. The previous rule sampled a full
   * window past that — 750, 1000, 1250, 1500 — so five distinct instants were mapped
   * onto `x = 100` and the SVG closed with a vertical drop that no delta produced.
   */
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [500, 'output']])
  const curve = settled.curve
  const trace = traceOf(settled)

  assert.equal(curve.durationMs, 500, 'the axis is the attempt\'s own generation span')
  assert.equal(trace.localEndMs, 500)
  assert.equal(trace.endMs, 500)
  assert.deepEqual(trace.points.map(point => point.timeMs), [0, 250, 500],
    'the trace covers the body grid and stops on the last delta')
  assert.deepEqual(trace.points.map(point => point.tps), [100, 100, 200],
    'and every vertex is the trailing one-second total the deltas support')
})

test('several distinct post-generation instants no longer collapse onto x = 100', () => {
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [500, 'output']])
  const view = curveViewModel(settled)

  const atRightEdge = []
  for (const series of view.series) {
    for (const run of series.runs) {
      for (const coordinate of run.coordinates) {
        if (coordinate.x >= 100 - 1e-9) atRightEdge.push(coordinate)
      }
    }
  }
  assert.equal(atRightEdge.length, 1,
    `post-generation tail collapses several distinct instants onto one x coordinate; `
    + `${atRightEdge.length} vertices sit at x = 100 (${atRightEdge.map(c => c.timeMs).join(', ')})`)
  assert.equal(atRightEdge[0].timeMs, settled.curve.durationMs,
    'the only vertex on the right edge is the attempt\'s own final measurement')
})

test('no point of any completed attempt exceeds that attempt\'s compressed end', () => {
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [500, 'output']])
  for (const attempt of settled.curve.attempts) {
    const segment = settled.curve.segments.find(candidate => candidate.attemptId === attempt.attemptId)
    for (const point of attempt.points) {
      assert.ok(point.timeMs <= segment.endMs + 1e-9,
        `${attempt.attemptId}: vertex ${point.timeMs} is past the attempt's own end ${segment.endMs}`)
    }
  }
  for (const attempt of settled.curve.attempts) {
    assert.ok(attempt.points.at(-1).timeMs <= settled.curve.durationMs + 1e-9,
      'and no vertex is past the chart\'s own duration')
  }
})

// ---------------------------------------------------------------------------
// 2. The endpoint anchor
// ---------------------------------------------------------------------------

test('an off-grid final delta is retained as the trace\'s own last vertex', () => {
  /**
   * A pure 250 ms ladder would give `0, 250, 500` and omit the delta that actually
   * arrived at 510 ms — the instant the attempt stopped producing. The body instants
   * are the union of the cadence grid and the attempt's final model-producing
   * instant, so 510 is drawn.
   */
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [510, 'output']])
  const trace = traceOf(settled)

  assert.equal(settled.curve.durationMs, 510)
  assert.deepEqual(trace.points.map(point => point.timeMs), [0, 250, 500, 510],
    'the cadence grid union the real final instant, deduplicated and ascending')
  assert.equal(trace.points.at(-1).timeMs, 510,
    'the final vertex is the attempt\'s final model-producing coordinate')
})

test('a final delta exactly on the cadence is not duplicated', () => {
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [500, 'output']])
  const times = traceOf(settled).points.map(point => point.timeMs)
  assert.deepEqual(times, [0, 250, 500])
  assert.equal(new Set(times).size, times.length, 'the union de-duplicates the shared instant')
})

test('an attempt shorter than one cadence step keeps both of its real endpoints', () => {
  /**
   * Two deltas 40 ms apart. The cadence contributes the opening instant only, so the
   * trace is two vertices: the first delta and the last. The 250 ms tail ladder the
   * previous rule would have added is invented width, not generation.
   */
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [40, 'output']])
  const trace = traceOf(settled)
  assert.equal(settled.curve.durationMs, 40)
  assert.deepEqual(trace.points.map(point => point.timeMs), [0, 40])
  assert.deepEqual(trace.points.map(point => point.tps), [100, 200],
    'both deltas are inside the one-second window at 40 ms')
})

test('a one-delta attempt stays a single vertex', () => {
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output']])
  const trace = traceOf(settled)
  assert.equal(settled.curve.durationMs, 0, 'a single delta is a zero-width attempt')
  assert.equal(trace.points.length, 1)
  assert.deepEqual(trace.points.map(point => [point.timeMs, point.tps]), [[0, 100]])
  assert.equal(trace.points.at(-1).timeMs, 0)
})

test('a very long attempt still ends on its last delta', () => {
  const chunks = []
  for (let at = 0; at <= 60_000; at += 500) chunks.push([at, 'output'])
  const settled = driveOneAttempt(new TurnTelemetryStore(), chunks)
  const trace = traceOf(settled)
  assert.equal(settled.curve.durationMs, 60_000)
  assert.equal(trace.points.at(-1).timeMs, 60_000)
  assert.equal(trace.points.at(-1).localMs, 60_000)
  assert.ok(trace.points.length >= 240, `the long trace was thinned to ${trace.points.length} vertices`)
})

// ---------------------------------------------------------------------------
// 3. What the rule must NOT remove
// ---------------------------------------------------------------------------

test('an intra-attempt stall keeps its full width and stays inside one attempt', () => {
  /**
   * The distinction this test exists for: a four-second silence **between** two
   * deltas is model-generation time and is drawn at full width, while the tail after
   * the **last** delta is not. Removing the artificial tail must leave the stall
   * untouched.
   */
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [4000, 'output']])
  const trace = traceOf(settled)

  assert.equal(settled.curve.durationMs, 4000, 'the stall is part of the attempt\'s width')
  assert.equal(trace.points.at(-1).timeMs, 4000)
  assert.deepEqual(trace.points.map(point => point.timeMs),
    [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3250, 3500, 3750, 4000])
  assert.equal(trace.points.find(point => point.timeMs === 2000).tps, 0,
    'the stall is drawn as a real zero, not cut out')
  assert.equal(trace.points.find(point => point.timeMs === 4000).tps, 100,
    'and the resumption measures its own window alone')
  assert.equal(settled.curve.peakTps, 100)
})

test('a tool gap between two attempts still owns zero width', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const a = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, a, { timeMs: 0, chunk: outputChunk('x'.repeat(DELTA_CHARS)) })
  store.acceptChunk(record, a, { timeMs: 500, chunk: outputChunk('x'.repeat(DELTA_CHARS)) })
  store.settleAttempt(a, { settledAtMs: 550, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  store.toolStarted(record, { callId: 't1', name: 'pwsh', timeMs: 600 })
  store.toolSettled(record, { callId: 't1', timeMs: 120_000, status: 'ok' })

  const b = store.beginAttempt(record, { attemptId: 'b', step: 2, startedAtMs: 120_100 })
  store.acceptChunk(record, b, { timeMs: 120_100, chunk: outputChunk('y'.repeat(40)) })
  store.acceptChunk(record, b, { timeMs: 120_600, chunk: outputChunk('y'.repeat(40)) })
  store.settleAttempt(b, { settledAtMs: 120_650, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  const settled = store.endTurn(record, { timeMs: 121_000, status: 'completed' })
  assert.equal(settled.curve.durationMs, 500 + 500,
    'two minutes of tool wait and the next call\'s TTFT consume no width at all')
  assert.deepEqual(settled.curve.segments.map(segment => [segment.startMs, segment.endMs]),
    [[0, 500], [500, 1000]])
  assert.equal(traceOf(settled, 'a').points.at(-1).timeMs, 500, 'A ends where B begins')
  assert.equal(traceOf(settled, 'b').points[0].timeMs, 500, 'and B opens on that same coordinate')
  assert.equal(traceOf(settled, 'b').points.at(-1).timeMs, 1000)
})

test('a retry still resets the window and shares the abandoned attempt\'s coordinate', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })

  const abandoned = store.beginAttempt(record, { attemptId: 'retry-1', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, abandoned, { timeMs: 0, chunk: outputChunk('a'.repeat(2000)) })
  store.settleAttempt(abandoned, { settledAtMs: 50, settlementKind: 'attempt', surfaceCommitted: false, attemptOutcome: 'retried' })

  const retry = store.beginAttempt(record, { attemptId: 'retry-2', step: 1, startedAtMs: 100 })
  store.acceptChunk(record, retry, { timeMs: 100, chunk: outputChunk('b'.repeat(40)) })
  store.settleAttempt(retry, { settledAtMs: 150, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  const settled = store.endTurn(record, { timeMs: 300, status: 'completed' })
  const first = traceOf(settled, 'retry-1')
  const second = traceOf(settled, 'retry-2')
  assert.equal(second.startMs, 0, 'the retry opens on the coordinate the abandoned prefix owned')
  assert.deepEqual(first.points.map(point => point.timeMs), [0], 'the abandoned attempt is one measurement')
  assert.deepEqual(second.points.map(point => point.timeMs), [0], 'and the retry is its own single measurement')
  assert.equal(second.points[0].tps, 10, 'never the abandoned prefix\'s 500 added to its own 10')
  assert.equal(settled.curve.peakTps, 500, 'and the abandoned attempt keeps its own peak')
})

// ---------------------------------------------------------------------------
// 4. Peak and render budget are unaffected by removing decay vertices
// ---------------------------------------------------------------------------

/**
 * The superseded sampling rule, kept as an executable reference: the attempt's own
 * cadence grid from local zero to its last delta, **plus one window of tail
 * vertices** one cadence step past it.
 *
 * It is the literal trailing window over the same evidence, so it cannot disagree
 * with production about a rate — only about which instants are sampled. That is
 * exactly what makes it usable as the "old peak" side of the regression below.
 */
function withTailSeries(samples, { windowMs = 1000, sampleEveryMs = 250 } = {}) {
  /** The samples the trace was measured from, on the attempt-local clock it used. */
  const local = samples
    .map(sample => ({ at: sample.attemptTimeMs, tokens: sample.tokens }))
    .sort((left, right) => left.at - right.at)
  if (local.length === 0) return []
  const last = local[local.length - 1].at
  const instants = []
  for (let at = 0; at <= last + 1e-9; at += sampleEveryMs) instants.push(at)
  for (let at = last + sampleEveryMs; at <= last + windowMs + 1e-9; at += sampleEveryMs) instants.push(at)
  return instants.map(at => ({
    timeMs: at,
    tps: local
      .filter(sample => sample.at <= at && sample.at > at - windowMs)
      .reduce((sum, sample) => sum + sample.tokens, 0) * 1000 / windowMs,
  }))
}

test('removing the artificial decay cannot change the peak', () => {
  /**
   * The peak is the maximum of the **full** rolling trace. A tail vertex can only
   * lose samples as its window advances, so the tail is a non-increasing run of
   * candidates and none of them can be the maximum unless the terminal one repeats a
   * value the body already reached. Removing the tail therefore deletes candidates
   * that were never strictly strongest, and the published peak is unchanged —
   * asserted here against a series that still carries the tail.
   *
   * The old sampler is reproduced literally rather than called: the segment fields
   * that used to select the tail no longer exist, which is the point of the change.
   */
  const cases = [
    { chunks: [[0, 'output'], [500, 'output']] },
    { chunks: [[0, 'output'], [4000, 'output']] },
    { chunks: [[0, 'output'], [510, 'output']] },
    {
      /** One attempt whose whole script is off the cadence, so the tail is drawn on it. */
      chunks: [[0, 'output'], [3000, 'output'], [8000, 'reasoning'], [8510, 'reasoning']],
    },
  ]
  for (const { chunks } of cases) {
    const settled = driveOneAttempt(new TurnTelemetryStore(), chunks)
    const trace = traceOf(settled)
    const old = withTailSeries(trace.samples)
    /** The superseded rule really does carry decay the new one does not: four whole steps of it. */
    const tailVertices = old.filter(point => point.timeMs > trace.points.at(-1).timeMs + 1e-9)
    assert.equal(tailVertices.length, 4,
      `${JSON.stringify(chunks)}: the superseded rule sampled a one-window tail past the last delta`)

    /**
     * The instants the two samplers share carry the same measurement: the change
     * removes vertices and never rewrites one.
     */
    const shared = trace.points.filter(point => old.some(candidate => candidate.timeMs === point.timeMs))
    assert.ok(shared.length >= trace.points.length - 1,
      'at most the off-grid endpoint is sampled by one rule and not the other')
    for (const point of shared) {
      assert.equal(old.find(candidate => candidate.timeMs === point.timeMs).tps, point.tps,
        `vertex ${point.timeMs} must measure the same rate either way`)
    }
    assert.equal(settled.curve.peakTps, Math.max(...old.map(point => point.tps)),
      `peak must not depend on whether the post-generation decay is sampled (${JSON.stringify(chunks)})`)
  }
})

test('the render budget still bounds the chart, and the budget constant is unchanged', () => {
  const chunks = []
  for (let at = 0; at <= 40_000; at += 250) chunks.push([at, 'output'])
  const settled = driveOneAttempt(new TurnTelemetryStore(), chunks)
  const view = curveViewModel(settled)

  assert.ok(settled.curve.renderBudget.elementPoints <= 512)
  assert.ok(view.renderElementPoints <= 512,
    `the view model would hand the SVG ${view.renderElementPoints} elements`)
  assert.ok(view.drawnPoints <= settled.curve.renderBudget.allocated)
})

// ---------------------------------------------------------------------------
// 5. The phase-order contract, reached through the same evidence
// ---------------------------------------------------------------------------

test('simultaneous phases keep the authoritative stream order for the label', () => {
  /**
   * `LiveMeter.streamingPhase` is the phase of the **last accepted generated
   * sample**, so when two deltas share an instant the one the stream delivered last
   * owns the label. DSH evidence carries that order twice: the transient frame index
   * and the durable compact stream member order. It is evidence, and it replaces the
   * arbitrary `reasoning < output` tie-break the completed curve used to apply.
   *
   * The numeric rate is order-independent — the window holds both deltas either way —
   * so only the label may differ, and it must differ in one direction only.
   */
  const outputFirst = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']])
  const reasoningFirst = driveOneAttempt(new TurnTelemetryStore(), [[0, 'reasoning'], [0, 'output']])

  const outputFirstPoint = traceOf(outputFirst).points[0]
  const reasoningFirstPoint = traceOf(reasoningFirst).points[0]

  assert.equal(outputFirstPoint.tps, 200, 'both deltas are inside the window')
  assert.equal(reasoningFirstPoint.tps, 200, 'in either delivery order')
  assert.equal(outputFirstPoint.activePhase, 'reasoning',
    'output then reasoning: the reasoning delta is the last authoritative sample')
  assert.equal(reasoningFirstPoint.activePhase, 'output',
    'reasoning then output: the output delta is the last authoritative sample')
  assert.notEqual(outputFirstPoint.activePhase, reasoningFirstPoint.activePhase,
    'the phase label follows the stream order, not a fixed phase hierarchy')
})

test('a simultaneous pair produces one labelled run, never a seam or a gap', () => {
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [0, 'reasoning']])
  const trace = settled.curve.attempts[0]
  assert.equal(trace.points.length, 1, 'one instant, one measurement')
  assert.deepEqual(trace.runs.map(run => run.phase), ['reasoning'],
    'one run, carrying the phase of the last authoritative sample')
  assert.equal(trace.runs[0].pointCount, 1)
  assert.equal(trace.points[0].tps, 200, 'and the rate is the sum of both phases')
})

test('visualRunsOf keeps every phase stretch contiguous and gap-free', () => {
  /**
   * The trace grid carries an `activePhase` at **every** vertex, so the maximal
   * stretches of one label are adjacent: `next.first === stretch.last + 1`. The
   * boundary of a change is therefore always the outgoing stretch's own last vertex,
   * and the incoming coloured path opens on it. There is no silence for an algorithm
   * to divide, and no horizontal gap exists at a tone change.
   */
  const points = [
    { timeMs: 0, activePhase: 'reasoning' },
    { timeMs: 250, activePhase: 'reasoning' },
    { timeMs: 500, activePhase: 'reasoning' },
    { timeMs: 3000, activePhase: 'output' },
    { timeMs: 3250, activePhase: 'output' },
  ]
  const runs = visualRunsOf(points)
  assert.deepEqual(runs.map(run => [run.phase, run.startIndex, run.endIndex]),
    [['reasoning', 0, 2], ['output', 2, 4]])
  for (let index = 1; index < runs.length; index += 1) {
    assert.equal(runs[index - 1].endIndex, runs[index].startIndex,
      'consecutive runs share exactly one vertex')
    assert.equal(runs[index].startIndex, runs[index - 1].endIndex,
      'and the incoming run opens on the outgoing run\'s last labelled vertex')
  }
})

test('the pure helpers agree with the settled curve on the corrected axis', () => {
  const settled = driveOneAttempt(new TurnTelemetryStore(), [[0, 'output'], [510, 'output']])
  const segment = settled.curve.segments[0]
  const compressed = compressAttempts([{
    attemptId: 'a',
    samples: [{ timeMs: 0, phase: 'output', tokens: 100 }, { timeMs: 510, phase: 'output', tokens: 100 }],
  }])
  assert.equal(compressed.durationMs, segment.endMs)

  const rebuilt = attemptTrace(compressed.segments[0], compressed.samples)
  const published = traceOf(settled)
  assert.deepEqual(
    rebuilt.points.map(point => [point.localMs, point.timeMs, point.tps, point.activePhase]),
    published.points.map(point => [point.localMs, point.timeMs, point.tps, point.activePhase]),
  )
})
