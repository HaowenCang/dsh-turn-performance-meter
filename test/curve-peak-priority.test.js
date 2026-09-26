/**
 * Phase 7A.1 — retention priority across **every** run length.
 *
 * `allocateRunBudgets` bounded the chart, but it did so in two passes that were
 * partitioned by run length: a first pass seated long runs (`length >=
 * MIN_MAX_POINTS`) in ranked order, and a second pass handed the remainder to the
 * one- and two-vertex runs **in raw index order**. The peak-bearing run was ranked
 * first inside the first pass only. Whenever the chart's global maximum lived in a
 * one- or two-vertex run, the priority band disappeared exactly at the class
 * boundary: the run was skipped by the anchor pass for being short, and then
 * competed in the second pass as an ordinary run, on index alone.
 *
 * The counterexample frozen in the first test below is not exotic. A saturated
 * chart is the *only* situation in which the allocation matters at all, and in that
 * situation two earlier short runs consume the last two vertices the singleton peak
 * needed. The chart then printed a peak it could not draw, which is the specific
 * failure `MAX_RENDER_POINTS_TOTAL` was introduced to prevent.
 *
 * The repair replaces the two passes with **one** priority order over all runs,
 * where each run costs at least what it irreducibly is:
 *
 *     length 0 -> 0        length 1 -> 1        length 2 -> 2        length >= 3 -> 3
 *
 * Nothing here duplicates a vertex to raise a short run to the long-run minimum: a
 * one-vertex run is a single measurement, and the one thing it must never become is
 * a three-point series that draws a segment the data does not contain.
 *
 * The last two sections exercise the same allocation through the settled snapshot
 * and the curve view model, because the defect is only observable to a reader if the
 * printed peak and the placed marker disagree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import {
  MAX_RENDER_POINTS_TOTAL,
  MIN_MAX_POINTS,
  allocateRunBudgets,
  minimumRunCost,
} from '../src/core/curve.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { completedTree } from '../src/client/completed/completed-tree.js'
import { COMPLETED_VIEW_CURVE } from '../src/client/completed/view-mode.js'
import { completedViewModel } from '../src/client/ui-model.js'
import { LOCALE_DICTS } from '../src/client/live/locale.js'
import { formatTps } from '../src/client/format.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'

/** A run of `length` vertices whose rate is `tps` everywhere. */
function runOf(length, tps = 1) {
  return { points: Array.from({ length }, (_, index) => ({ timeMs: index * 250, tps })) }
}

/** One singleton measurement at rate `tps`. */
const singleton = tps => ({ points: [{ timeMs: 0, tps }] })

/* ------------------------------------------- minimal element-tree plumbing */

function rec(tag, props, children) {
  const list = Array.isArray(children) ? children.filter(child => child !== null && child !== undefined) : [children]
  return { tag, props: props ?? {}, children: list }
}

const translate = key => LOCALE_DICTS.en[key] ?? key

function byClass(node, name, found = []) {
  if (node === null || node === undefined || typeof node === 'string') return found
  if (String(node.props.className ?? '').split(/\s+/).includes(name)) found.push(node)
  for (const child of node.children) byClass(child, name, found)
  return found
}

function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return node.children.flatMap(texts)
}

/* ------------------------------------------------- the counterexample itself */

test('the irreducible cost of a run is its own length below the anchor minimum', () => {
  /**
   * The unit the whole allocation is denominated in, and the reason the priority order is
   * total: every run has a cost, so every run is comparable to every other and no band can
   * end at a length boundary. A one- or two-vertex run cannot be thinned — it is already at
   * full resolution — so its cost is its length, and nothing here rounds it up to three.
   */
  assert.equal(minimumRunCost(0), 0, 'a run with no evidence costs nothing and is never seated')
  assert.equal(minimumRunCost(1), 1)
  assert.equal(minimumRunCost(2), 2)
  assert.equal(minimumRunCost(MIN_MAX_POINTS), MIN_MAX_POINTS)
  assert.equal(minimumRunCost(400), MIN_MAX_POINTS, 'a long run costs its three anchors, not its length')
  assert.equal(minimumRunCost(Number.NaN), 0, 'a non-finite length is not a run')
  assert.equal(minimumRunCost(-5), 0)
})

test('a singleton global peak is seated before ordinary short runs under a saturated budget', () => {
  /**
   * 170 ordinary three-vertex runs cost 170 x 3 = 510 of the 512-vertex budget in the
   * anchor pass, so the two vertices that remain are the whole of the second pass.
   * Three singletons follow them, and the **global peak is the last of the three** —
   * behind two ordinary one-vertex runs in index order.
   *
   * Old behaviour: the anchor pass skipped all three for being shorter than
   * `MIN_MAX_POINTS`, the second pass walked indices 170, 171 and 172 in order, and
   * the budget ran out on the first two. The peak-bearing run received `0` while two
   * runs twenty times weaker were drawn.
   */
  const ordinary = Array.from({ length: 170 }, () => runOf(MIN_MAX_POINTS))
  const runs = [
    ...ordinary,
    singleton(10),
    singleton(20),
    /** Index 172: the chart's maximum, in a one-vertex run, last in input order. */
    singleton(9999),
  ]
  const peakIndex = 172
  assert.equal(runs.length, 173)

  const result = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
  assert.ok(result.budgets[peakIndex] > 0,
    `the run carrying the chart maximum ${runs[peakIndex].points[0].tps} was refused: budgets ${JSON.stringify(result.budgets.slice(170))}`)
  assert.equal(result.degraded.includes(peakIndex), false,
    'and it is not reported as degraded: the peak is the last run that may be refused')
  assert.equal(result.peakRetained, true,
    'the allocation states that the chart maximum survived into the rendering')
  assert.equal(result.peakIndex, peakIndex, 'and names the run that carries it')

  /** The bound itself is unchanged: seating the peak is not paid for by exceeding the chart. */
  assert.ok(result.allocated <= MAX_RENDER_POINTS_TOTAL,
    `allocated ${result.allocated} exceeds ${MAX_RENDER_POINTS_TOTAL}`)
})

test('a two-vertex global peak is seated before ordinary short runs under a saturated budget', () => {
  const ordinary = Array.from({ length: 170 }, () => runOf(MIN_MAX_POINTS))
  const runs = [...ordinary, singleton(10), runOf(2, 20), runOf(2, 9999)]
  const peakIndex = 172

  const result = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
  assert.ok(result.budgets[peakIndex] > 0, 'a two-vertex peak-bearing run is drawable under saturation')
  assert.equal(result.peakRetained, true)
  assert.equal(result.peakIndex, peakIndex)
  assert.ok(result.allocated <= MAX_RENDER_POINTS_TOTAL)
})

test('a long global peak keeps its priority under the same saturated budget', () => {
  /** The guarantee Phase 7A already provided: the same scenario with a long peak run must not regress. */
  const ordinary = Array.from({ length: 170 }, () => runOf(MIN_MAX_POINTS))
  const runs = [...ordinary, singleton(10), singleton(20), runOf(9, 9999)]
  const peakIndex = 172

  const result = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
  assert.ok(result.budgets[peakIndex] >= MIN_MAX_POINTS,
    'the long peak-bearing run keeps a drawable allowance')
  assert.equal(result.peakRetained, true)
  assert.ok(result.allocated <= MAX_RENDER_POINTS_TOTAL)
})

/* ------------------------------------------------ the equal-cost length tie-break */

test('runs of equal irreducible cost are served shortest first, whatever their input order', () => {
  /**
   * Every run longer than `MIN_MAX_POINTS` costs exactly `MIN_MAX_POINTS`, so the seating
   * pass cannot separate two long runs from each other by cost, and the length tie-break is
   * what decides which equal-cost run is served. The ranking this round corrected had a
   * comment claiming a dense run is preferred at equal cost; the code sorts by ascending
   * length, matching the surplus rule below it — "equal fairness goes to the shorter run
   * first". These assertions freeze the rule the code actually implements.
   *
   * The fixture separates the two readings. The long run is nine vertices and the flat run
   * three, and the budget seats only one of them, so the tie-break alone decides which one is
   * drawn: ascending length keeps the flat run, and a ranking that preferred the longer run at
   * equal cost would seat the nine-vertex one instead.
   */
  const flat = () => runOf(3)
  const long = () => runOf(9)
  const peak = singleton(9999)

  /** Budget five: one for the peak band, so cost three seats exactly one of the two runs. */
  const flatFirst = allocateRunBudgets([flat(), long(), peak], 5)
  assert.equal(flatFirst.peakIndex, 2, 'the peak band leads regardless of length')
  assert.equal(flatFirst.budgets[0], 3,
    'the flat run is seated at its own length, which is its full resolution')
  assert.equal(flatFirst.budgets[1], 0, 'and the nine-vertex run is refused rather than part-drawn')
  assert.deepEqual(flatFirst.degraded, [1])

  /**
   * The rule is positional rather than incidental, and that is the observable difference: the
   * same two runs in either input order receive the same allowances, because ascending length
   * puts the three-vertex run ahead of the nine-vertex one whichever index each was given. A
   * ranking that preferred the longer run at equal cost would give the nine-vertex run the seat
   * in both orders, since cost alone cannot separate the two.
   */
  const longFirst = allocateRunBudgets([long(), flat(), peak], 5)
  assert.equal(longFirst.peakIndex, 2)
  assert.deepEqual(longFirst.budgets, [0, 3, 1],
    'the shorter run keeps the seat even when it arrives second in the input')
  assert.deepEqual(
    { flat: longFirst.budgets[1], long: longFirst.budgets[0] },
    { flat: flatFirst.budgets[0], long: flatFirst.budgets[1] },
    'the tie resolves by length, so the input order cannot move an allowance between the runs')
  assert.notDeepEqual(longFirst.budgets, [3, 3, 1], 'and the wider run is not preferred at equal cost')

  /**
   * Once both fit, the tie-break is a distribution choice rather than a licence to exceed the
   * chart: the same two runs under a wider budget are both drawn, and the total stays bounded.
   */
  const both = allocateRunBudgets([flat(), long(), peak], 7)
  assert.deepEqual(both.budgets, [3, 3, 1])
  assert.equal(both.degraded.length, 0)
  assert.ok(both.allocated <= 7)

  /**
   * A uniform chart has no length tie to break, which is why the ordering rule needs a mixed
   * fixture: with every run at one length, cost and length agree and the index decides.
   */
  const uniform = allocateRunBudgets([runOf(9), runOf(9), runOf(9), peak], 7)
  assert.deepEqual(uniform.budgets, [3, 3, 0, 1],
    'equal length, equal cost, so the earliest indices are served first')
})

/* --------------------------------------- priority is independent of input order */
test('the priority band follows the peak run to the front of the input', () => {
  const runs = [singleton(9999), ...Array.from({ length: 170 }, () => runOf(MIN_MAX_POINTS)), singleton(10), singleton(20)]
  const result = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
  assert.ok(result.budgets[0] > 0, 'the first run carries the peak and is seated')
  assert.equal(result.peakIndex, 0)
  assert.equal(result.peakRetained, true)
})

test('the priority band follows the peak run to the end of the input', () => {
  const runs = [...Array.from({ length: 170 }, () => runOf(MIN_MAX_POINTS)), singleton(10), singleton(20), singleton(9999)]
  const result = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
  assert.ok(result.budgets.at(-1) > 0, 'the last run carries the peak and is seated')
  assert.equal(result.peakIndex, runs.length - 1)
  assert.equal(result.peakRetained, true)
})

test('an equal peak resolves to the earliest run and allocates deterministically', () => {
  const runs = [...Array.from({ length: 170 }, () => runOf(MIN_MAX_POINTS)), singleton(500), singleton(500), singleton(500)]
  const first = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
  const second = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)

  /** The single priority band must land on exactly one run, and the rule is "earliest". */
  assert.equal(first.peakIndex, 170, 'a tie is won by the earliest run')
  assert.equal(first.peakRetained, true)
  assert.deepEqual(first, second, 'two calls over equal input allocate identically')
  assert.deepEqual(allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL), first,
    'and a third call agrees with both: nothing here reads shared or mutable state')
})

/* -------------------------------------------------- the allocation contract holds */

test('the unified allocation never exceeds the budget, never refuses the peak, never halves a run', () => {
  const shapes = { singleton: 1, pair: 2, minimum: MIN_MAX_POINTS, long: 40 }
  for (const [label, length] of Object.entries(shapes)) {
    for (const count of [1, 3, 17, 100, 170, 200, 400]) {
      /**
       * The peak is placed in the **last** run, which is the position a length-partitioned
       * allocator starves, and every other run is given the same length so the ranking has
       * nothing else to distinguish them by.
       */
      const runs = Array.from({ length: count }, (_, index) => runOf(length, index === count - 1 ? 9999 : 1))
      const result = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
      const peakIndex = count - 1

      assert.equal(result.budgets.length, count)
      assert.ok(result.allocated <= MAX_RENDER_POINTS_TOTAL,
        `${label} x ${count}: allocated ${result.allocated} over ${MAX_RENDER_POINTS_TOTAL}`)
      assert.equal(result.peakIndex, peakIndex, `${label} x ${count}: peak run not identified`)
      assert.equal(result.peakRetained, true,
        `${label} x ${count}: the peak-bearing run was refused outright`)
      assert.ok(result.budgets[peakIndex] > 0, `${label} x ${count}: peak allowance is zero`)

      for (const [index, budget] of result.budgets.entries()) {
        if (budget === 0) {
          assert.ok(result.degraded.includes(index),
            `${label} x ${count}: run ${index} was given no budget without being reported`)
          continue
        }
        assert.ok(budget <= length, `${label} x ${count}: run ${index} given ${budget} of ${length} vertices`)
        /**
         * The allowance is either the run's whole length, or at least the minimum a series can be
         * thinned to. A three-or-more-vertex run with an allowance of one or two is the specific
         * value `downsampleSeries` refuses, and the allocator must never publish it.
         */
        assert.ok(budget === length || budget >= MIN_MAX_POINTS,
          `${label} x ${count}: run ${index} (length ${length}) received the unrunnable allowance ${budget}`)
      }
    }
  }
})

test('a refused run keeps an allowance of exactly zero', () => {
  const runs = [...Array.from({ length: 200 }, () => runOf(20)), singleton(9999)]
  const result = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
  assert.ok(result.degraded.length > 0, 'a chart of 201 runs cannot fit its anchors in 512 vertices')
  for (const index of result.degraded) {
    assert.equal(result.budgets[index], 0, `refused run ${index} must be emptied, not thinned`)
  }
  /** Refusal is a reported state, never a silently truncated run. */
  for (const [index, budget] of result.budgets.entries()) {
    if (budget === 0) assert.ok(result.degraded.includes(index))
  }
  assert.equal(result.budgets.at(-1), 1, 'the singleton peak is seated at its own length')
  assert.equal(result.peakRetained, true)
})

test('a budget too small for the peak run is refused explicitly rather than claimed as retained', () => {
  /**
   * The formal corner: the chart maximum lives in a run whose irreducible cost exceeds the
   * whole budget. Nothing can place it, and the one dishonest answer would be to report the
   * peak as drawn. `peakRetained: false` is that report, and `degraded` names the run.
   *
   * With the production budget of 512 and a minimum run cost of at most `MIN_MAX_POINTS`,
   * this state is unreachable — it is asserted here so the field cannot quietly become
   * "always true" and stop meaning anything.
   */
  const runs = [runOf(5, 10), runOf(5, 9999)]
  const result = allocateRunBudgets(runs, 2)
  assert.equal(result.total, 2)
  assert.equal(result.peakIndex, 1)
  assert.equal(result.budgets[1], 0, 'the peak run cannot be drawn inside two vertices')
  assert.equal(result.peakRetained, false, 'and the allocation says so rather than implying otherwise')
  assert.deepEqual(result.degraded, [0, 1])

  /**
   * A chart whose every rate is zero still has a maximum — zero — and the earliest run that
   * carries it is the one the priority band belongs to. That is not a loss either.
   */
  const flat = allocateRunBudgets([{ points: [{ timeMs: 0, tps: 0 }] }], MAX_RENDER_POINTS_TOTAL)
  assert.equal(flat.peakIndex, 0, 'the earliest run holds the maximum of an all-zero series')
  assert.equal(flat.peakRetained, true)
  assert.equal(flat.budgets[0], 1)

  /** A run with no finite rate at all leaves the chart with no maximum to keep. */
  const unmeasured = allocateRunBudgets([{ points: [{ timeMs: 0 }] }], MAX_RENDER_POINTS_TOTAL)
  assert.equal(unmeasured.peakIndex, -1, 'no finite rate means no peak-bearing run')
  assert.equal(unmeasured.peakRetained, true, 'and therefore nothing that could have been dropped')
  assert.equal(unmeasured.budgets[0], 1, 'the vertex is still drawn: it is a measurement, just not a rate')
})

/* ------------------------------------------------ through the settled snapshot */

const WINDOW_MS = 1000
const STEP_MS = 250
const STRETCHES = 200
const STRETCH_SPAN_MS = 2000
const STRETCH_GAP_MS = 2000
const DELTA_CHARS = 400
const DELTA_TOKENS = 100
/** Four 100-token deltas inside a one-second window: the rate every long run carries. */
const LONG_RUN_TPS = 400
/**
 * The three single-vertex attempts are driven as `tokens` because at a one-second window a
 * one-delta attempt's rate *is* its token weight. The last of them is the chart's maximum,
 * and it is placed deliberately behind two weaker short runs — the input order the old
 * length-partitioned allocation walked straight through.
 */
const SINGLETON_TPS = [10, 20, 9999]
const PEAK_TPS = SINGLETON_TPS[2]

const textDelta = text => ({ type: 'text-delta', index: 0, text })
const reasoningDelta = text => ({ type: 'reasoning-delta', index: 0, text })

/**
 * A delta whose weight is exactly `tokens`. `heuristicTokenWeight` is four characters per
 * token, so the character count is chosen to land on the rate the scenario needs rather than
 * the other way round.
 */
function chunkWeighing(tokens) {
  const text = 'x'.repeat(tokens * 4)
  assert.equal(heuristicTokenWeight(text), tokens, `the generator assumes ${tokens * 4} characters weigh ${tokens} tokens`)
  return textDelta(text)
}

/**
 * A saturated turn ending in a **singleton global peak**.
 *
 * `STRETCHES` output stretches and `STRETCHES` reasoning stretches, each its own episode
 * because they are separated by more than one rolling window, produce `2 x STRETCHES` runs
 * of a dozen vertices: 400 runs against a 512-vertex chart budget, which is saturation.
 *
 * Three single-vertex attempts follow. `singletonTps` exists so the peak can be placed
 * behind two weaker short runs, which is the input order the old two-pass allocation walked
 * straight through the counterexample in. A fourth, trailing attempt is required by the
 * clock rather than by the scenario: `compressAttempts` gives an attempt zero width when it
 * produced a single delta, so the peak attempt is capped by its successor at its own
 * coordinate and its episode collapses to that one instant — an attempt with a successor is
 * the only way to obtain a genuine one-vertex run through the real pipeline.
 */
function driveSaturatedSingletonPeak({ singletonTps = SINGLETON_TPS } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const heavy = store.beginAttempt(record, { attemptId: 'heavy', step: 1, startedAtMs: 0 })
  let at = 0
  let last = 0
  for (let stretch = 0; stretch < STRETCHES; stretch += 1) {
    for (let offset = 0; offset < STRETCH_SPAN_MS; offset += STEP_MS) {
      const timeMs = at + offset
      store.acceptChunk(record, heavy, { timeMs, chunk: textDelta('x'.repeat(DELTA_CHARS)) })
      store.acceptChunk(record, heavy, { timeMs, chunk: reasoningDelta('x'.repeat(DELTA_CHARS)) })
      last = timeMs
    }
    at += STRETCH_SPAN_MS + STRETCH_GAP_MS
  }
  store.settleAttempt(heavy, {
    settledAtMs: last + 1,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  /** Three one-delta attempts: `tps == tokens` at a one-second window, so the cost is the rate. */
  for (const [index, tokens] of singletonTps.entries()) {
    const attempt = store.beginAttempt(record, { attemptId: `short-${index}`, step: 2 + index, startedAtMs: at })
    store.acceptChunk(record, attempt, { timeMs: at, chunk: chunkWeighing(tokens) })
    store.settleAttempt(attempt, {
      settledAtMs: at + 1,
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
    })
    at += 1000
  }
  /** The successor that collapses the peak attempt's episode to its single instant. */
  const tail = store.beginAttempt(record, { attemptId: 'tail', step: 9, startedAtMs: at })
  store.acceptChunk(record, tail, { timeMs: at, chunk: textDelta('x'.repeat(DELTA_CHARS)) })
  store.settleAttempt(tail, {
    settledAtMs: at + 1,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })

  return store.endTurn(record, { timeMs: at + 2000, status: 'completed' })
}

const runsOf = settled => settled.curve.series.flatMap(entry => entry.runs)

test('a saturated chart keeps a singleton global peak and the budget that bounds it', () => {
  assert.equal(heuristicTokenWeight('x'.repeat(DELTA_CHARS)), DELTA_TOKENS)
  const settled = driveSaturatedSingletonPeak()
  const curve = settled.curve
  const runs = runsOf(settled)

  assert.ok(runs.length > 400, `expected a saturated chart, found ${runs.length} runs`)
  assert.equal(curve.renderBudget.total, MAX_RENDER_POINTS_TOTAL)

  const sampled = runs.filter(run => run.points.length === 1)
  assert.equal(sampled.length, 3, 'the three one-delta attempts each contribute a one-vertex run')
  assert.deepEqual(sampled.map(run => run.points[0].tps), SINGLETON_TPS,
    'and each still carries the measurement it was created with')
  const peakRun = runs.find(run => run.points.some(point => point.tps === PEAK_TPS))
  assert.ok(peakRun !== undefined,
    `the ${PEAK_TPS} tokens/s singleton is not drawn at all; published peak is ${curve.peakTps}`)
  assert.equal(peakRun.degraded, false)
  assert.equal(curve.peakTps, PEAK_TPS,
    'the printed peak is the singleton measurement, not a rate assembled from the long runs')
  assert.equal(curve.renderBudget.peakRetained, true)
  assert.equal(runs[curve.renderBudget.peakRun], peakRun,
    'the published peak index names the run that carries the maximum')
  /** The long runs really are the weaker evidence here: the peak is not a tie. */
  const longRunPeaks = runs.filter(run => run.points.length > 1).map(run => run.peak)
  assert.ok(longRunPeaks.every(peak => peak <= LONG_RUN_TPS),
    `a long run measured more than ${LONG_RUN_TPS} tokens/s: ${Math.max(...longRunPeaks)}`)
  assert.equal(Math.max(...longRunPeaks), LONG_RUN_TPS, 'and the strongest of them is the expected rate')

  /** Chart-wide bound: path vertices **and** singleton markers together are what 512 bounds. */
  assert.ok(curve.renderBudget.elementPoints <= MAX_RENDER_POINTS_TOTAL,
    `the chart would receive ${curve.renderBudget.elementPoints} elements against ${MAX_RENDER_POINTS_TOTAL}`)
  assert.ok(curve.drawnPoints <= MAX_RENDER_POINTS_TOTAL)
  assert.equal(
    curve.renderBudget.elementPoints,
    curve.renderBudget.lineVertices + curve.renderBudget.markers,
  )
})

test('a refused long run is emptied rather than thinned below its anchors', () => {
  const settled = driveSaturatedSingletonPeak()
  const runs = runsOf(settled)
  const refused = runs.filter(run => run.degraded)
  assert.ok(refused.length > 0,
    'a 400-run chart against a 512-vertex budget must refuse runs; the refusal path is not dead code')
  for (const run of refused) {
    assert.deepEqual(run.points, [], 'a refused run carries no vertices')
    assert.equal(run.fullResolution, false)
  }
  for (const run of runs) {
    if (run.degraded || run.points.length === 0) continue
    const length = run.points.length
    assert.ok(length === 1 || length === 2 || length >= MIN_MAX_POINTS || run.fullResolution,
      `run ${run.startMs} was published with ${length} vertices, an allowance its own contract refuses`)
  }
})

/* ------------------------------------------------------- peak value and position */

test('the printed peak and the placed marker are the same measurement', () => {
  const settled = driveSaturatedSingletonPeak()
  const curve = settled.curve
  const view = curveViewModel({ curve })
  assert.equal(view.peak.value, curve.peakTps, 'the view model prints the settled peak')
  assert.equal(view.peak.value, PEAK_TPS)

  const output = view.series.find(series => series.key === 'output')
  assert.ok(output.markers.some(candidate => candidate.tps === PEAK_TPS),
    `no singleton marker stands at ${PEAK_TPS} tokens/s; the placed markers are ${JSON.stringify(view.markers.map(m => m.tps))}`)
  /** The rounded list the SVG layer receives, so the comparison below is on rendered coordinates. */
  const marker = view.markers.find(candidate => candidate.tps === PEAK_TPS)
  assert.equal(marker.series, 'output', 'the peak measurement belongs to the output series')

  /**
   * The defect this test exists for: `peak.value` was the full-series maximum while `x`/`y`
   * were taken from whichever series happened to lead the *drawn* points. Once the singleton
   * peak was starved, the card printed `≈9,999` and placed the dot on a 400 tokens/s vertex —
   * two different measurements, one pixel apart, and nothing on screen to tell them apart.
   */
  assert.equal(view.peak.x, marker.x, 'the peak marker sits on the vertex that measured the peak')
  assert.equal(view.peak.y, marker.y)
  assert.equal(view.peak.leader, 'output')

  /** And the same claim through the rendered card, which is what a reader actually sees. */
  const card = completedTree(rec, completedViewModel(settled), translate, {
    mode: COMPLETED_VIEW_CURVE,
    curveView: view,
  })
  const panel = byClass(card, 'dsh-tpm-curve-panel')[0]
  assert.ok(panel !== undefined, 'the curve panel renders')
  assert.deepEqual(texts(byClass(panel, 'dsh-tpm-peak')[0]), ['peak', view.peak.display, 'tokens/s'])
  assert.equal(view.peak.display, `≈${formatTps(PEAK_TPS)}`)

  const [dot] = byClass(panel, 'dsh-tpm-peak-dot')
  assert.ok(dot !== undefined, 'the peak has a position on the chart')
  const placed = byClass(panel, 'dsh-tpm-singleton-dot')
  const atPeak = placed.filter(node => node.props['data-tps'] === String(PEAK_TPS))
  assert.equal(atPeak.length, 1, 'exactly one marker stands for the peak measurement')
  assert.equal(dot.props.style.left, atPeak[0].props.style.left,
    'the peak dot is drawn on the marker that measured it')
  assert.equal(dot.props.style.top, atPeak[0].props.style.top)
  assert.equal(dot.props['data-leader'], 'output')
})

test('a saturated curve never places the peak dot on a different measurement', () => {
  const settled = driveSaturatedSingletonPeak()
  const curve = settled.curve
  const view = curveViewModel({ curve })

  /**
   * Whatever the allocation decides, the position must be *the* measurement or nothing at all.
   * A dot at a different rate is the one outcome that is worse than no dot.
   */
  const positions = [
    ...view.markers.map(marker => ({ tps: marker.tps, x: marker.x, y: marker.y })),
    ...view.series.flatMap(series => series.runs.flatMap(run => run.coordinates.map(point => ({ tps: point.tps, x: point.x, y: point.y })))),
  ]
  if (view.peak.x === null) {
    assert.equal(view.peak.y, null, 'a peak with no position is placed nowhere')
  } else {
    const placed = positions.filter(point => Math.abs(point.x - view.peak.x) < 1e-9 && Math.abs(point.y - view.peak.y) < 1e-9)
    assert.ok(placed.length > 0, 'a placed peak must coincide with a drawn vertex or marker')
    assert.ok(placed.every(point => Math.abs(point.tps - view.peak.value) < 1e-9),
      `the peak dot sits on ${placed.map(point => point.tps).join(', ')} while the card prints ${view.peak.value}`)
  }
})

/* --------------------------------------------------------- the chart-wide bound */

test('line vertices plus singleton markers are bounded by the chart budget together', () => {
  const settled = driveSaturatedSingletonPeak()
  const curve = settled.curve
  const view = curveViewModel({ curve })

  /**
   * `curve.drawnPoints` counts every budgeted vertex, singleton runs included, because the
   * allocator charges one vertex for each. `curveViewModel.drawnPoints` counts **path
   * vertices only** — a marker is not a vertex of a line — and publishes the markers
   * separately. Naming the two the same thing made the bound assertable while leaving half
   * the SVG elements out of it, so the sum is now its own published quantity.
   */
  assert.equal(view.renderElementPoints, view.drawnPoints + view.markers.length)
  assert.equal(view.renderElementPoints, curve.renderBudget.elementPoints,
    'the view model and the snapshot agree on how many elements the chart will receive')
  assert.ok(view.renderElementPoints <= MAX_RENDER_POINTS_TOTAL,
    `the SVG would receive ${view.renderElementPoints} elements against a budget of ${MAX_RENDER_POINTS_TOTAL}`)

  const markers = view.series.reduce((sum, series) => sum + series.markers.length, 0)
  assert.equal(view.markers.length, markers)
  assert.equal(curve.renderBudget.markers, markers, 'and the snapshot counted the same markers')
  assert.equal(curve.renderBudget.lineVertices, view.drawnPoints)
  assert.equal(WINDOW_MS, 1000, 'the rolling window the rates above are measured over')
})
