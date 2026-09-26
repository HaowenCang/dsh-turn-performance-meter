/**
 * The completed throughput curve must measure what the live pill measured.
 *
 * ## The defect this file was written against
 *
 * `LiveMeter` holds **one** `SlidingWindowMeter` per active attempt and feeds it
 * every generated sample of that attempt — reasoning deltas, text deltas and
 * tool-call argument deltas alike (`src/core/live-metrics.js`, `acceptSample`).
 * `streamingPhase` only *labels* the newest sample. The live TPS is therefore:
 *
 *     all generated tokens of the active attempt whose timestamps lie in (t - 1000, t]
 *
 * The completed curve was built differently: `settle()` produced one
 * `perAttemptSeries(..., phase: 'reasoning')` and one
 * `perAttemptSeries(..., phase: 'output')`, so at a reasoning-to-output transition
 * the live window held `reasoning + output` while the two drawn lines held
 * `reasoning only` and `output only`. Neither drawn line equalled the live
 * measurement, and `peakTps` took the maximum of the two partial rates, so the
 * published peak was structurally below the rate the same session displayed live.
 *
 * Minimal counterexample, frozen below in `legacyPhaseSeparatedSeries`: one
 * attempt, 400 calibrated reasoning tokens at attempt-local 0 ms and 400
 * calibrated output tokens at attempt-local 500 ms, against an authoritative total
 * of 800 tokens.
 *
 *     live / corrected total window at t = 500 : 400 + 400 = 800 tokens/s
 *     old reasoning-only line at t = 500       : 500 tokens/s
 *     old output-only line at t = 500          : 500 tokens/s
 *     old published peak                       : 500
 *
 * ## The corrected model
 *
 * Reasoning and output are **visual phases of one measurement**, not two rate
 * definitions. The curve is one attempt-local trailing-one-second total trace per
 * attempt, segmented by the phase of the latest model-producing sample at or
 * before each vertex (`activePhase`), which is exactly `LiveMeter.streamingPhase`.
 *
 * ## What is not claimed
 *
 * Live and completed magnitudes need not be numerically equal once provider usage
 * exists: live uses the heuristic shape weight and completed uses the calibrated
 * allocation, so a scale factor may separate them. What must be identical is the
 * *shape* — timestamps, attempt boundaries, the one-second window, phase-transition
 * locations and stall locations. The equality asserted here is therefore between
 * the completed curve and a live meter driven by the **same magnitudes**, which is
 * the only form of the contract that is true in both regimes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { heuristicTokenWeight } from '../src/core/token-allocation.js'
import { DEFAULT_WINDOW_MS } from '../src/core/curve.js'

const WINDOW_MS = DEFAULT_WINDOW_MS
const RAW_DELTA_WEIGHT = 100

const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })
const output = text => ({ type: 'text-delta', index: 0, text })

function chunkOf(kind) {
  const text = 'x'.repeat(400)
  assert.equal(heuristicTokenWeight(text), RAW_DELTA_WEIGHT)
  return kind === 'reasoning' ? reasoning(text) : output(text)
}

/**
 * The rejected implementation, kept as an executable counterexample.
 *
 * This is what `settle()` published: two independent rolling series, one per
 * phase, each measured only over its own phase's samples. Its magnitudes are
 * calibrated to the same provider totals production calibrates to — the
 * counterexample must differ from the corrected pipeline in exactly one respect,
 * the phase partition, or the comparison would measure two changes at once.
 */
function legacyPhaseSeparatedPeak(record) {
  const samples = []
  let offsetMs = 0
  for (const attempt of record.attempts) {
    if (!Array.isArray(attempt.samples) || attempt.samples.length === 0) continue
    const first = attempt.samples[0].timeMs
    const last = attempt.samples[attempt.samples.length - 1].timeMs
    /**
     * One common scale per attempt, which is the whole-attempt branch of
     * `calibrateAttemptSamples`: the corrected pipeline's magnitudes, so the only
     * variable left in the comparison is the phase filter below.
     */
    const rawTotal = attempt.samples.reduce((sum, sample) => sum + (sample.weight ?? 0), 0)
    const scale = rawTotal > 0 ? attempt.usage.outputTokens / rawTotal : 0
    for (const sample of attempt.samples) {
      samples.push({
        ...sample,
        tokens: (sample.weight ?? 0) * scale,
        activeTimeMs: offsetMs + (sample.timeMs - first),
      })
    }
    offsetMs += last - first
  }
  const peaks = {}
  for (const phase of ['reasoning', 'output']) {
    let peak = 0
    for (let at = 0; at <= offsetMs + WINDOW_MS; at += 250) {
      let total = 0
      for (const sample of samples) {
        if (sample.phase !== phase) continue
        if (sample.activeTimeMs <= at && sample.activeTimeMs > at - WINDOW_MS) {
          total += sample.tokens ?? sample.weight ?? 0
        }
      }
      peak = Math.max(peak, total * 1000 / WINDOW_MS)
    }
    peaks[phase] = peak
  }
  return peaks
}

/**
 * One attempt: a reasoning stretch and an output stretch half a window apart,
 * settled with authoritative usage that pins the two phases exactly.
 *
 * The raw weights are 100 and 100; the provider reports a 1000-token output total of
 * which 600 is reasoning, so the exact split is 600 and 400. The two phases are
 * deliberately unequal so that a phase-filtered rate is unmistakable against the
 * total.
 */
function driveCrossPhaseAttempt() {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 0, chunk: chunkOf('reasoning') })
  store.acceptChunk(record, attempt, { timeMs: 500, chunk: chunkOf('output') })
  store.settleAttempt(attempt, {
    settledAtMs: 550,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    usage: { outputTokens: 1000, reasoningTokens: 600 },
  })
  return { record, settled: store.endTurn(record, { timeMs: 600, status: 'completed' }) }
}

/** The attempt's total-rolling series, or `[]` when the curve has no such shape. */
function attemptPoints(curve, attemptId) {
  const attempt = (curve.attempts ?? []).find(candidate => candidate.attemptId === attemptId)
  return attempt === undefined ? [] : (attempt.points ?? [])
}

test('a reasoning-to-output transition inside one window reports both contributions', () => {
  const { record, settled } = driveCrossPhaseAttempt()

  /**
   * The counterexample first. The rejected phase-separated pipeline cannot report
   * more than one phase's tokens in a window, so its best answer for the shared
   * instant is the larger of the two phases' shares — and its published peak was
   * exactly that maximum, structurally below the rate the live pill displayed.
   */
  const legacy = legacyPhaseSeparatedPeak(record)
  assert.equal(legacy.reasoning, 500, 'the reasoning-only line is capped by the reasoning tokens alone')
  assert.equal(legacy.output, 500, 'and the output-only line by the output tokens alone')
  assert.equal(Math.max(legacy.reasoning, legacy.output), 500,
    'the rejected pipeline\'s peak is 500; this is the defect, not a hypothetical')

  const points = attemptPoints(settled.curve, 'a')
  const at500 = points.find(point => point.localMs === 500)
  assert.ok(at500 !== undefined, 'the corrected curve samples the transition instant')
  assert.equal(at500.tps, 1000,
    'at attempt-local 500 the trailing window holds 600 reasoning + 400 output tokens = 1000 tokens/s')
  assert.equal(settled.curve.peakTps, 1000,
    'and the published peak is the total-window rate, not one phase\'s share of it')
})

test('the completed total trace equals a live meter fed the same calibrated magnitudes', () => {
  const { settled } = driveCrossPhaseAttempt()
  const samples = settled.attemptBreakdown[0].calibration.samples
  assert.deepEqual(samples.map(sample => sample.tokens), [600, 400])

  /**
   * Independent re-implementation of the live rule: one trailing window per
   * attempt over **every** generated sample, whatever its phase. This is
   * `SlidingWindowMeter` restated rather than called, so the comparison cannot be
   * satisfied by two copies of the same bug.
   */
  const live = []
  for (let at = 0; at <= 1500; at += 250) {
    let total = 0
    samples.forEach((sample, index) => {
      const localMs = index === 0 ? 0 : 500
      if (localMs <= at && localMs > at - WINDOW_MS) total += sample.tokens
    })
    live.push({ localMs: at, tps: total * 1000 / WINDOW_MS })
  }

  const points = attemptPoints(settled.curve, 'a')
  assert.deepEqual(points.map(point => [point.localMs, point.tps]), live.map(entry => [entry.localMs, entry.tps]),
    'every attempt-local vertex must carry the live meter\'s own measurement')
})

test('each vertex names the phase of the latest sample at or before it, and only that', () => {
  const { settled } = driveCrossPhaseAttempt()
  const points = attemptPoints(settled.curve, 'a')
  const byLocal = new Map(points.map(point => [point.localMs, point]))

  assert.equal(byLocal.get(0).activePhase, 'reasoning',
    'at the opening instant the newest sample is the reasoning delta')
  assert.equal(byLocal.get(250).activePhase, 'reasoning', 'and it stays so until the next sample')
  assert.equal(byLocal.get(500).activePhase, 'output',
    'at the transition the newest sample is the output delta')
  assert.equal(byLocal.get(1000).activePhase, 'output', 'the tail keeps the closing phase')

  /**
   * The phase is a label, not a filter: the vertex at the transition carries both
   * contributions even though it is labelled output.
   */
  assert.equal(byLocal.get(500).tps, 1000)
})

test('phase colour is a rendering seam, not a statistical reset or a blank gap', () => {
  const { settled } = driveCrossPhaseAttempt()
  const attempt = settled.curve.attempts[0]
  const visual = attempt.runs ?? []

  assert.deepEqual(visual.map(run => run.phase), ['reasoning', 'output'],
    'one reasoning stretch followed by one output stretch')

  const [first, second] = visual
  /**
   * The two runs share their boundary vertex: same instant, same measurement, one object
   * identity. The boundary is the **midpoint** of the label change, so a phase change with no
   * silence between its samples puts the seam on the last vertex of the outgoing label —
   * which is what removes the artificial one-step blank a strict label partition would leave,
   * while keeping a long silence from being painted entirely in one tone.
   */
  const seamA = first.points.at(-1)
  const seamB = second.points[0]
  assert.equal(seamA.localMs, seamB.localMs, 'the colour boundary is not a horizontal gap')
  assert.equal(seamA.timeMs, seamB.timeMs, 'nor a gap on the drawn compressed axis')
  assert.equal(seamA.tps, seamB.tps,
    'the two subpaths meet on one measured vertex, so the rate is continuous across the tone change')

  /** The shared vertex is a real measurement of the single total window. */
  assert.equal(seamA, seamB, 'and it is one object, drawn by both paths')
  assert.equal(seamA.localMs, 250,
    'the label change is between local 250 and 500, so the seam is its midpoint rounded down')
  assert.equal(seamA.tps, 600)
  assert.equal(seamA.activePhase, 'reasoning', 'the seam keeps the phase the newest sample gave it')
  assert.equal(second.points[1].activePhase, 'output',
    'and the first vertex beyond the seam is the one the new phase labels')

  /** No vertex of either run is invented: every one is on the attempt's 250 ms grid. */
  for (const point of attempt.points) {
    assert.equal(point.localMs % 250, 0, `vertex ${point.localMs} is not on the 250 ms grid`)
  }

  /**
   * The seam vertex is shared, not duplicated: the attempt's own vertex list holds it
   * once, so the budget is charged for it once even though both subpaths emit it.
   */
  assert.equal(attempt.points.filter(point => point.localMs === 500).length, 1)
  assert.equal(first.points.length + second.points.length, attempt.points.length + 1,
    'the runs partition the grid with exactly one shared vertex per transition')
})
