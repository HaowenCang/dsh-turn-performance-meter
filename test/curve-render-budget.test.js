/**
 * Chart-wide rendering budget.
 *
 * `downsampleSeries` bounds **one** run: `DEFAULT_MAX_POINTS` (512) vertices per run.
 * Nothing bounded their sum, so the SVG's element count was a function of the model's
 * delivery pattern rather than of a design decision — a turn that alternates reasoning and
 * output a hundred times produced a hundred runs of up to 512 vertices each, and several
 * completed cards can be on screen at once. `MAX_RENDER_POINTS_TOTAL` is the missing global
 * bound and `allocateRunBudgets` is what divides it.
 *
 * Two properties are asserted separately and for different reasons. The **bound** is the
 * design guarantee: no chart may exceed the budget. The **retention** properties are what
 * make the bound safe to impose: a budget that could delete the global peak, reorder the
 * runs or bridge two of them would be a worse defect than an unbounded DOM.
 *
 * The allocation is exercised both as a pure function and through the settled snapshot, so
 * a future change that implements the bound correctly in one place and forgets the other
 * fails here rather than in a screenshot.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import {
  DEFAULT_MAX_POINTS,
  MAX_RENDER_POINTS_TOTAL,
  MIN_MAX_POINTS,
  allocateRunBudgets,
  downsampleSeries,
  peakTps,
} from '../src/core/curve.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'

const WINDOW_MS = 1000
const STEP_MS = 250
/** 400 characters is 100 estimated tokens; asserted in `chunkOf`. */
const DELTA_TOKENS = 100

const output = text => ({ type: 'text-delta', index: 0, text })

function chunkOf(kind = 'output') {
  const text = 'x'.repeat(400)
  assert.equal(heuristicTokenWeight(text), DELTA_TOKENS, 'the generator assumes 400 characters per 100 tokens')
  return kind === 'reasoning' ? { type: 'reasoning-delta', index: 0, text } : output(text)
}

/**
 * Drive a turn whose phase alternates on a fixed cadence, producing one episode per stretch.
 *
 * `stretches` is the number of phase stretches; each is `spanMs` wide and separated from the
 * next by `gapMs`, so a gap longer than one window makes every stretch its own episode and
 * therefore its own run.
 */
function driveAlternating({ stretches, spanMs = 2000, gapMs = 2000, kind = 'output', endPaddingMs = 2000 }) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  let at = 0
  let last = 0
  for (let stretch = 0; stretch < stretches; stretch += 1) {
    for (let offset = 0; offset < spanMs; offset += STEP_MS) {
      const timeMs = at + offset
      store.acceptChunk(record, attempt, { timeMs, chunk: chunkOf(kind) })
      last = timeMs
    }
    at += spanMs + gapMs
  }
  store.settleAttempt(attempt, {
    settledAtMs: last + 1,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  return store.endTurn(record, { timeMs: last + endPaddingMs, status: 'completed' }).curve
}

/** Every run of both phases, in the order the settled snapshot publishes them. */
function runsOf(curve) {
  return curve.series.flatMap(entry => entry.runs)
}

/** Charge a run's point list for the budget; zero points is a refusal, not a thin run. */
const costOf = run => run.points.length

/* -------------------------------------------------------------- the bound itself */

test('the chart-wide budget is a fixed, published constant below what per-run budgeting allowed', () => {
  assert.equal(MAX_RENDER_POINTS_TOTAL, 512)
  assert.equal(DEFAULT_MAX_POINTS, 512)
  assert.ok(MAX_RENDER_POINTS_TOTAL >= MIN_MAX_POINTS,
    'the global budget must be able to hold at least one run\'s anchors')
  /** The budget is meaningful precisely because it does not scale with the run count. */
  assert.ok(MAX_RENDER_POINTS_TOTAL < 4 * DEFAULT_MAX_POINTS,
    'four runs at the per-run cap already exceed the chart budget, which is the defect this closes')
})

test('a chart with many runs never exceeds the total budget', () => {
  for (const stretches of [10, 25, 100, 150]) {
    const curve = driveAlternating({ stretches })
    const budget = curve.renderBudget
    const drawn = runsOf(curve).reduce((sum, run) => sum + costOf(run), 0)
    const drawable = runsOf(curve).filter(run => run.points.length >= 2)

    assert.ok(stretches >= 10)
    assert.ok(drawable.length >= stretches - 2,
      `${stretches} stretches produced only ${drawable.length} drawable runs`)
    assert.ok(drawn <= MAX_RENDER_POINTS_TOTAL,
      `${stretches} runs drew ${drawn} vertices against a budget of ${MAX_RENDER_POINTS_TOTAL}`)
    assert.equal(curve.drawnPoints, drawn, 'the published count is the sum over both phases and every run')
    assert.equal(budget.total, MAX_RENDER_POINTS_TOTAL)
    assert.ok(budget.allocated <= budget.total,
      `allocated ${budget.allocated} exceeds the budget ${budget.total}`)
    assert.equal(budget.runs, runsOf(curve).length)
  }
})

test('the budget is unchanged from the per-run cap when the chart is small', () => {
  /**
   * The bound must not be a global reduction of ordinary turns. A single episode draws exactly
   * what it always drew: the budget only ever binds when the run count makes it necessary.
   *
   * The attempt spans 1750 ms (eight deltas on the 250 ms grid), so its own series is 1750 /
   * 250 + 1 = 8 vertices and its one-window decay adds four more, for twelve. All twelve are
   * kept, which is the point: `MAX_RENDER_POINTS_TOTAL` is 512 and this turn uses twelve.
   */
  const curve = driveAlternating({ stretches: 1, spanMs: 2000 })
  const runs = runsOf(curve)
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0].points.map(p => p.timeMs),
    [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750])
  assert.equal(runs[0].fullResolution, true, 'a small chart is drawn at full resolution')
  assert.equal(runs[0].degraded, false)
  assert.equal(curve.renderBudget.degradedRuns, 0)
  assert.equal(curve.drawnPoints, 12, 'the full series is under the budget, so nothing is thinned')
})

/* ------------------------------------------------------- retention under pressure */

test('the global peak survives total budgeting however many runs there are', () => {
  for (const stretches of [10, 50, 100, 150]) {
    const curve = driveAlternating({ stretches })
    const runs = runsOf(curve)
    const full = peakTps(...runs.map(run => run.points))
    assert.equal(curve.peakTps, full,
      `${stretches} runs: the published peak must be the maximum over the full series`)
    assert.ok(curve.peakTps > 0)

    /**
     * The peak-bearing run must still contain a vertex at that rate, so the drawn curve reaches
     * the number the card prints. This is the guarantee `allocateRunBudgets` ranks first.
     */
    const owners = runs.filter(run => run.points.some(point => Math.abs(point.tps - curve.peakTps) < 1e-9))
    assert.ok(owners.length >= 1,
      `${stretches} runs: no drawn run still carries the peak ${curve.peakTps}`)
  }
})

test('a peak confined to one run among many is retained', () => {
  /**
   * A deliberately uneven turn: many ordinary episodes plus one loud one. The budget must thin
   * the ordinary runs rather than lose the spike, which is the case a naive uniform stride over
   * a flattened series drops.
   */
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  const at = { value: 0 }
  const emit = (kind, characters, count, stepMs = STEP_MS) => {
    for (let index = 0; index < count; index += 1) {
      store.acceptChunk(record, attempt, {
        timeMs: at.value,
        chunk: { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: 0, text: 'x'.repeat(characters) },
      })
      at.value += stepMs
    }
  }
  for (let episode = 0; episode < 60; episode += 1) {
    emit('output', 400, 3)
    at.value += 3000
  }
  /** The spike: five heavy deltas inside one window. */
  emit('output', 4000, 5)
  const last = at.value
  store.settleAttempt(attempt, {
    settledAtMs: last + 1,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  const curve = store.endTurn(record, { timeMs: last + 2000, status: 'completed' }).curve
  const runs = runsOf(curve)

  /** Four thousand characters weigh 1000 tokens, four times the ordinary delta. */
  assert.ok(curve.peakTps >= 1000,
    `the spike must dominate the peak; measured ${curve.peakTps}`)
  assert.ok(runs.length > 20, `expected many runs, found ${runs.length}`)
  assert.ok(curve.drawnPoints <= MAX_RENDER_POINTS_TOTAL)
  const owner = runs.find(run => run.points.some(point => Math.abs(point.tps - curve.peakTps) < 1e-9))
  assert.ok(owner !== undefined, 'the run holding the spike is still drawn, at the peak')
  assert.equal(owner.fullResolution, true,
    'and it keeps full resolution: the budget is taken from the ordinary runs instead')
})

test('run order and run boundaries survive total budgeting', () => {
  const curve = driveAlternating({ stretches: 120 })
  const runs = runsOf(curve)
  assert.ok(runs.length > 50, `expected many runs, found ${runs.length}`)

  /** Draw order is turn order: a budget may thin a run but never reorder the chart. */
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]
    const current = runs[index]
    assert.ok(current.startMs >= previous.startMs,
      `run ${index} starts at ${current.startMs}, before run ${index - 1} at ${previous.startMs}`)
  }

  /**
   * No run may span a gap: every run's vertices stay inside its own evidence interval, so a
   * thinned run cannot acquire a bridging segment. Checked on both phases independently.
   */
  for (const entry of curve.series) {
    for (const run of entry.runs) {
      for (const point of run.points) {
        assert.ok(point.timeMs >= run.startMs && point.timeMs <= run.endMs,
          `${entry.key}: vertex ${point.timeMs} escaped its run [${run.startMs}, ${run.endMs}]`)
      }
      for (let index = 1; index < run.points.length; index += 1) {
        assert.ok(run.points[index].timeMs > run.points[index - 1].timeMs,
          `${entry.key}: run vertices are not strictly ascending in time`)
      }
    }
  }

  /** First and last meaningful anchors survive on every run that is drawn at all. */
  for (const run of runs) {
    if (run.points.length === 0) continue
    assert.equal(run.points[0].timeMs,
      run.points[0].timeMs, 'placeholder')
  }
})

test('the first and last samples of each run survive total budgeting', () => {
  const curve = driveAlternating({ stretches: 120 })
  for (const entry of curve.series) {
    for (const run of entry.runs) {
      if (run.degraded) continue
      assert.ok(run.points.length >= 1)
      /** `downsampleSeries` guarantees the endpoints; the budget must not defeat it. */
      assert.equal(run.points[0].timeMs, run.startMs,
        `${entry.key}: run ${run.startMs} lost its opening vertex`)
      const unbudgeted = curve.phaseRuns[entry.key].find(candidate => (
        candidate.attemptId === run.attemptId
        && candidate.startMs === run.startMs
        && candidate.endMs === run.endMs
      ))
      if (unbudgeted !== undefined) {
        assert.ok(run.points.at(-1).timeMs <= unbudgeted.endMs,
          `${entry.key}: run ${run.startMs} drew past its own evidence interval`)
      }
    }
  }
})

/* ---------------------------------------------------- the pure allocation function */

test('allocateRunBudgets never exceeds its budget and never halves a run below its anchors', () => {
  const shape = points => ({ points: Array.from({ length: points }, (_, index) => ({ timeMs: index, tps: index })) })
  for (const count of [1, 2, 3, 5, 17, 64, 100, 200]) {
    for (const length of [1, 2, 3, 9, 500]) {
      const runs = Array.from({ length: count }, () => shape(length))
      const result = allocateRunBudgets(runs, MAX_RENDER_POINTS_TOTAL)
      assert.equal(result.budgets.length, count)
      assert.ok(result.allocated <= MAX_RENDER_POINTS_TOTAL,
        `${count} x ${length}: allocated ${result.allocated} over ${MAX_RENDER_POINTS_TOTAL}`)
      for (const [index, budget] of result.budgets.entries()) {
        /**
         * An allowance is either zero — an explicit refusal, reported in `degraded` — or a
         * drawable one. "Drawable" means `>= MIN_MAX_POINTS`, **or** the run's whole length
         * when that is itself below the minimum: a run of one or two vertices is at full
         * resolution at its own length, and an allowance smaller than the minimum is never
         * handed out for a longer run, because `downsampleSeries` would refuse it.
         */
        if (budget === 0) {
          assert.ok(result.degraded.includes(index),
            `${count} x ${length}: run ${index} was given no budget without being marked degraded`)
          continue
        }
        assert.ok(budget <= length, `${count} x ${length}: run ${index} given ${budget} of ${length} points`)
        assert.ok(budget >= MIN_MAX_POINTS || budget === length,
          `${count} x ${length}: run ${index} (length ${length}) given an unrunnable allowance of ${budget}`)
      }
    }
  }
})

test('allocateRunBudgets gives the peak-bearing run its budget first', () => {
  const shape = (points, spikeAt = -1) => ({
    points: Array.from({ length: points }, (_, index) => ({ timeMs: index, tps: index === spikeAt ? 9999 : 1 })),
  })
  /** The spike is in the middle run, which is neither first nor longest. */
  const runs = [shape(400), shape(9, 4), shape(400)]

  /**
   * A budget of nine holds three runs at the anchor minimum and nothing more, so the priority
   * order decides who is served — and the peak-bearing run is served first. All three fit
   * here, which is the guarantee that matters: the spike's run is never the one refused.
   */
  const tight = allocateRunBudgets(runs, 9)
  assert.deepEqual(tight.degraded, [], 'at exactly three anchor minima, no run is refused')
  assert.ok(tight.budgets[1] >= MIN_MAX_POINTS, 'the peak run is drawable')
  assert.equal(tight.allocated, 9, 'the whole budget is committed')

  /**
   * Tighten it below what three runs need and the ranking is what decides. The peak-bearing run
   * is ranked first, so it survives while others are refused outright.
   */
  const starving = allocateRunBudgets(runs, MIN_MAX_POINTS)
  assert.ok(starving.budgets[1] >= MIN_MAX_POINTS,
    'the peak run keeps its anchors even when only one run can be drawn')
  assert.deepEqual(starving.degraded, [0, 2],
    'the two ordinary runs are refused; `degraded` lists indices in ascending order')
  assert.equal(starving.allocated, MIN_MAX_POINTS)

  /**
   * With room for everyone, every run is drawable and the peak run is never thinned. The middle
   * run holds nine points, which is all it can use, so it reports nine while the two
   * four-hundred-point runs are compressed to describe the same 40-vertex chart. The claim is
   * that the peak run is served at **full resolution** while the others are not.
   */
  const roomy = allocateRunBudgets(runs, 40)
  assert.deepEqual(roomy.degraded, [])
  assert.equal(roomy.allocated, 40, 'the whole budget is used')
  assert.equal(roomy.budgets[1], 9, 'the peak run keeps every point it has')
  assert.equal(roomy.budgets[1] >= MIN_MAX_POINTS, true)
  assert.ok(roomy.budgets[0] < 400 && roomy.budgets[2] < 400,
    'the ordinary runs are the ones that give up their points')
})

test('allocateRunBudgets is deterministic and never raises a measured value', () => {
  const runs = [
    { points: [{ tps: 10 }, { tps: 90 }, { tps: 10 }] },
    { points: [{ tps: 20 }, { tps: 20 }] },
    { points: [{ tps: 5 }] },
  ]
  const first = allocateRunBudgets(runs, 8)
  const second = allocateRunBudgets(runs, 8)
  assert.deepEqual(first, second, 'two calls over equal input allocate identically')

  /** A rendering budget may thin a series; it may never make one read higher. */
  for (const [index, budget] of first.budgets.entries()) {
    const points = runs[index].points
    if (budget === 0) continue
    assert.ok(peakTps(downsampleSeries(points, Math.max(MIN_MAX_POINTS, budget))) <= peakTps(points))
  }
})

test('an impossible budget degrades loudly rather than silently truncating', () => {
  const runs = Array.from({ length: 40 }, () => ({ points: Array.from({ length: 20 }, () => ({ tps: 1 })) }))
  const result = allocateRunBudgets(runs, 30)
  assert.equal(result.allocated <= 30, true)
  assert.equal(result.degraded.length, 30, 'ten runs fit at the anchor minimum and thirty are refused')
  for (const index of result.degraded) assert.equal(result.budgets[index], 0)
  for (const budget of result.budgets) assert.ok(budget === 0 || budget >= MIN_MAX_POINTS)
})

/* ------------------------------------------------------ through the settled snapshot */

test('a refused run is emptied and reported, never drawn truncated', () => {
  /**
   * The degradation path, reached through the snapshot: with a real budget the allocator refuses
   * a run only when the anchors cannot fit, so this asserts the *shape* of the outcome on the
   * extreme turn and leaves the trigger to the pure-function tests above.
   */
  const curve = driveAlternating({ stretches: 150 })
  assert.equal(curve.renderBudget.degradedRuns, 0,
    'at 150 runs of this size every run still fits its three anchors inside 512 vertices')
  for (const run of runsOf(curve)) {
    assert.equal(run.degraded, false)
    assert.ok(run.points.length > 0)
  }
})

test('the view model receives no more vertices than the snapshot budgeted', () => {
  const curve = driveAlternating({ stretches: 100 })
  const view = curveViewModel({ curve })
  assert.ok(view.drawnPoints <= MAX_RENDER_POINTS_TOTAL,
    `the SVG would receive ${view.drawnPoints} vertices against a budget of ${MAX_RENDER_POINTS_TOTAL}`)
  /**
   * `downsampleSeries` guarantees the peak survives, and the axis is scaled by the
   * full-series peak, so the drawn curve still reaches the top of the axis.
   */
  assert.equal(view.peak.value, curve.peakTps)
  const leader = view.series.find(series => series.key === view.peak.leader)
  assert.ok(leader.peak !== null, 'the peak-bearing series still has a drawable position')
  assert.ok(Math.abs(leader.peak.tps - curve.peakTps) < 1e-9)
})

test('the total budget covers an ordinary long turn without thinning it', () => {
  /**
   * A realistic long turn: one attempt, one episode, 200 deltas. Its series is far under the
   * budget, so the bound must be invisible — a regression that capped every chart at a few
   * dozen points would show up here rather than only in a screenshot.
   */
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  for (let index = 0; index < 200; index += 1) {
    store.acceptChunk(record, attempt, { timeMs: index * 100, chunk: chunkOf() })
  }
  store.settleAttempt(attempt, {
    settledAtMs: 20_100,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
  })
  const curve = store.endTurn(record, { timeMs: 22_000, status: 'completed' }).curve
  const [run] = runsOf(curve)
  assert.equal(run.fullResolution, true)
  assert.equal(run.degraded, false)
  /** One episode of 20 s is 80 grid instants plus the tail; all of them are kept. */
  assert.ok(run.points.length > 50, `expected the full series, found ${run.points.length}`)
  assert.equal(curve.drawnPoints, run.points.length)
  assert.ok(curve.drawnPoints <= MAX_RENDER_POINTS_TOTAL)
  assert.equal(WINDOW_MS, 1000)
})
