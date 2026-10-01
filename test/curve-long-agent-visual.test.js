/**
 * The long-agent-turn visual regression.
 *
 * The user-facing defect Phase 7C was opened for was a chart, not a number: a 45-call agent
 * turn rendered as *dozens* of disconnected short traces, repeated saw-tooth restarts and a
 * field of large orange singleton dots, against a reference that reads as one throughput
 * trace whose tone changes by phase.
 *
 * The structural cause was that the drawing unit was the **phase episode**: each phase's
 * evidence was cut into episodes, each episode became its own run with its own one-window
 * tail, and each run was measured separately. A turn of `n` calls with `k` phase alternations
 * therefore produced on the order of `n x k` short traces instead of `n` traces, and the
 * phase transitions between them were blank rather than continuous.
 *
 * This file replays a representative long turn — more than twenty calls, more than nineteen
 * tools, reasoning and tool-call output cycling — through the real store, and measures the
 * chart the way a reader experiences it: how many subpaths, how many singleton markers, how
 * many of those markers are the peak, and how many rendered element points reach the SVG.
 *
 * ## What is asserted, and what is deliberately not
 *
 * The structural claims are exact: one trace per attempt, one subpath per contiguous phase
 * stretch, no horizontal gap at a tone change, an intra-attempt stall drawn as a hyperbolic
 * decay inside one attempt, a hard reset between attempts, and a chart that never exceeds
 * `MAX_RENDER_POINTS_TOTAL`.
 *
 * No exact path count, marker count or element count is frozen. Those are properties of the
 * turn's own delivery pattern, and pinning them would make the test fail on a legitimate
 * recording rather than on a regression. What is frozen is the *shape of the improvement*:
 * the marker count must be a small fraction of the attempt count rather than a multiple of it,
 * and no attempt may contribute more than one marker.
 *
 * Phase 9.2 changed the statistic the vertices carry — a phase-cumulative average over the
 * episode in force, not a trailing one-second window — so a stall is now a strictly decaying
 * stretch rather than a run of measured zeros. Phase 9.4 added the shared publication policy
 * (`src/core/rate-publication.js`) in front of that statistic: an episode needs three
 * contributing samples and 100 ms of its own clock before any of its vertices carries a rate,
 * and a vertex that fails either gate is published as `tps: null` with a
 * `rateUnavailableReason` — never as a measured zero. The geometry this file is about is
 * unchanged; what changed is that the leading vertices of a phase are withheld rather than
 * drawn on the axis floor.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { MAX_RENDER_POINTS_TOTAL, peakTps } from '../src/core/curve.js'

const CALLS = 24

/**
 * The superseded trailing one-second window. It exists in this file only as the parameter of
 * the rejected episode-splitting rule that the last test re-derives; the rate path has no
 * window (`docs/METRICS_SPEC.md` §8.2).
 */
const SUPERSEDED_WINDOW_MS = 1000

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })
const toolArgs = text => ({ type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: text })

/**
 * A representative long agent turn.
 *
 * Each of the `CALLS` model calls reasons for a while, emits a tool call whose arguments are
 * model output, is interrupted by a real tool, and then the next call begins. Every fourth
 * call emits a silent stretch inside itself, so intra-attempt stalls are part of the fixture,
 * and one call is deliberately huge so the peak is unambiguous.
 */
function driveLongAgentTurn() {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  let wallMs = 0
  let firstTokenMs = null

  for (let call = 0; call < CALLS; call += 1) {
    const attempt = store.beginAttempt(record, { attemptId: `call-${call}`, step: call + 1, startedAtMs: wallMs })
    /**
     * Reasoning first, then the tool call's arguments. The two phases are contiguous, which is
     * the ordinary shape of an agent call: the model thinks and then writes the call.
     */
    const reasoningDeltas = 3 + (call % 3)
    for (let index = 0; index < reasoningDeltas; index += 1) {
      const chunks = call === 11 ? 8 : 1
      for (let repeat = 0; repeat < chunks; repeat += 1) {
        store.acceptChunk(record, attempt, { timeMs: wallMs, chunk: reasoning('x'.repeat(200)) })
      }
      firstTokenMs ??= wallMs
      wallMs += 250
    }
    /** Every fourth call stalls for four seconds in the middle of its own stream. */
    const stalls = call % 4 === 3
    if (stalls) wallMs += 4000
    for (let index = 0; index < 3; index += 1) {
      store.acceptChunk(record, attempt, { timeMs: wallMs, chunk: toolArgs(`{"cmd":"step-${index}"}`) })
      /**
       * A stalling call also spaces its own tool-call arguments more than the superseded
       * window apart, so the phase really does fall silent inside itself. That is the shape
       * the rejected episode-based drawing turned into additional subpaths.
       */
      wallMs += stalls ? 2000 : 250
    }
    store.settleAttempt(attempt, {
      settledAtMs: wallMs,
      settlementKind: 'message',
      surfaceCommitted: true,
      attemptOutcome: 'committed',
      usage: { outputTokens: 400 + (call * 37) % 260, reasoningTokens: 120 + (call * 17) % 90 },
      settlementSeq: call + 1,
    })

    if (call < CALLS - 1) {
      store.toolStarted(record, { callId: `tool-${call}`, name: call % 3 === 0 ? 'pwsh' : 'write', timeMs: wallMs })
      wallMs += 1200 + (call * 137) % 4000
      store.toolSettled(record, { callId: `tool-${call}`, timeMs: wallMs, status: 'ok' })
      wallMs += 150
    }
  }

  const settled = store.endTurn(record, { timeMs: wallMs + 500, status: 'completed' })
  return { store, record, settled, firstTokenMs }
}

/** Every run of the curve, in draw order. */
const runsOf = curve => curve.attempts.flatMap(attempt => attempt.runs)

test('a long agent turn renders one trace per call rather than one per phase episode', () => {
  const { settled } = driveLongAgentTurn()
  const curve = settled.curve

  assert.equal(curve.attempts.length, CALLS, 'one model attempt per call')
  assert.equal(settled.tools.count, CALLS - 1, 'and a tool between each of them')

  /**
   * The structural fix, stated as the invariant that makes it true: a contiguous phase stretch
   * is one run, and the runs of an attempt meet at shared vertices. A call that reasons and
   * then writes a tool call therefore contributes **two** subpaths, never more — however long
   * its silences are and however many tools separate it from its neighbours.
   */
  for (const attempt of curve.attempts) {
    assert.deepEqual(attempt.runs.map(run => run.phase), ['reasoning', 'output'],
      `${attempt.attemptId}: reasoning then tool-call arguments, two phases, two subpaths`)
    assert.equal(attempt.runs[0].points.at(-1), attempt.runs[1].points[0],
      `${attempt.attemptId}: the tone changes on a shared vertex`)
  }
  assert.equal(runsOf(curve).length, 2 * CALLS,
    'the old episode-based geometry produced a run per silence as well; this one does not')

  /**
   * The stall really is in the fixture: the calls with a four-second silence inside them carry
   * a long **decaying** stretch between two producing stretches — the numerator freezes while
   * the denominator advances — and it is drawn rather than cut out. Ten consecutive strictly
   * decreasing vertices is a second of decay, which only a multi-second silence can produce:
   * between the ordinary deltas of this fixture the rate falls for at most three vertices.
   */
  const longestDecayOf = (attempt) => {
    let longest = 0
    let run = 0
    for (let index = 1; index < attempt.points.length; index += 1) {
      if (attempt.points[index].tps < attempt.points[index - 1].tps) {
        run += 1
        longest = Math.max(longest, run)
      } else run = 0
    }
    return longest
  }
  const stalled = curve.attempts.filter(attempt => longestDecayOf(attempt) >= 10)
  assert.equal(stalled.length, Math.ceil(CALLS / 4),
    'every fourth call stalls inside its own stream, and the stall is visible as a decay')
  for (const attempt of stalled) {
    assert.equal(attempt.runs.length, 2,
      `${attempt.attemptId}: a stall is not a phase change, so it does not add a subpath`)
  }
  /** And no other call decays for more than a fraction of a second. */
  for (const attempt of curve.attempts) {
    if (stalled.includes(attempt)) continue
    assert.ok(longestDecayOf(attempt) < 10,
      `${attempt.attemptId}: an unexpected long decay outside the stalling calls`)
  }
})

test('the long turn produces almost no singleton markers, and only the peak keeps the strong one', () => {
  const { settled } = driveLongAgentTurn()
  const curve = settled.curve
  const view = curveViewModel({ curve })

  /**
   * The visible half of the defect: the old geometry produced one large orange marker per
   * single-vertex phase episode, so a many-call turn was a field of beads. A singleton run is
   * now a genuine one-measurement attempt, and this fixture contains none — every call
   * streams for at least a second.
   */
  assert.equal(view.markers.length, 0,
    `a long turn of contiguous calls must not produce singleton beads; found ${view.markers.length}`)
  assert.equal(view.drawnRuns, 2 * CALLS, 'one subpath per phase stretch, and nothing else')
  assert.equal(view.series.filter(series => series.present).length, 2,
    'both phases have evidence, so both legend entries are live')

  /** The peak is therefore carried by a path vertex, and it is placed on it. */
  assert.equal(view.peak.value, curve.peakTps)
  assert.ok(view.peak.x !== null && view.peak.y !== null, 'the peak has a position on the chart')
  const leader = view.series.find(series => series.key === view.peak.leader)
  assert.ok(Math.abs(leader.peak.tps - curve.peakTps) < 1e-9,
    'and the leading series carries that measurement')
})

test('the chart stays inside the chart-wide render budget', () => {
  const { settled } = driveLongAgentTurn()
  const curve = settled.curve
  const view = curveViewModel({ curve })

  assert.ok(curve.renderBudget.elementPoints <= MAX_RENDER_POINTS_TOTAL,
    `the snapshot would emit ${curve.renderBudget.elementPoints} elements against ${MAX_RENDER_POINTS_TOTAL}`)
  assert.ok(view.renderElementPoints <= MAX_RENDER_POINTS_TOTAL,
    `the view model would hand the SVG ${view.renderElementPoints} elements`)
  assert.equal(view.renderElementPoints, view.drawnPoints + view.markers.length,
    'the bound counts path vertices and marker elements together')

  /** The peak survives the budget, so the dot sits on the printed number. */
  assert.equal(curve.renderBudget.peakRetained, true)
  const peakRun = runsOf(curve).find(run => run.points.some(point => Math.abs(point.tps - curve.peakTps) < 1e-9))
  assert.ok(peakRun !== undefined, 'the run carrying the peak is still drawn')
  assert.equal(peakRun.degraded, false)
  assert.equal(peakTps(...curve.attempts.map(attempt => attempt.points)), curve.peakTps,
    'and the published peak is the maximum over the attempt traces, before any render allowance')
})

test('the long turn keeps its attempt resets and its zero-width tools', () => {
  const { settled } = driveLongAgentTurn()
  const curve = settled.curve

  /**
   * The chart is one subpath sequence per call, and every call owns its own trace: no episode
   * clock crosses a boundary, so no attempt is credited with a neighbour's tokens. The sharp
   * check is an attempt's own first **published** vertex: recomputed from the attempt's own
   * samples, it must be the mass that attempt's episode had accumulated by that instant over
   * that episode's own elapsed clock. A series that bridged two calls would divide its
   * predecessor's mass by a clock that is not its own here.
   *
   * Its ladder's second instant is not that vertex. Under the Phase 9.4 publication policy a
   * rate exists only once the episode holds `MIN_RATE_SAMPLES` (three) samples and has run for
   * `MIN_RATE_ELAPSED_MS` (100 ms), and the reasoning episode reaches its third sample only at
   * local 500 — so the local-100 vertex is withheld as `below-sample-warmup` and its opening
   * anchor is `null` with `opening-anchor`, never the `0` a pre-9.4 curve drew there.
   */
  for (const [index, attempt] of curve.attempts.entries()) {
    assert.equal(attempt.startMs, curve.segments[index].startMs)
    assert.equal(attempt.points[0].localMs, 0, `${attempt.attemptId}: the trace opens on its own episode anchor`)
    assert.equal(attempt.points[0].tps, null,
      `${attempt.attemptId}: and that anchor is withheld rather than reported as a measured zero`)
    assert.equal(attempt.points[0].rateUnavailableReason, 'opening-anchor')
    assert.equal(attempt.points[1].localMs, 100, `${attempt.attemptId}: the ladder's first step`)
    /**
     * The first step is a measurement only when the policy admits it. Every call but the
     * double-wide one has contributed a single delta by then, which is below
     * `MIN_RATE_SAMPLES`; that call has stacked eight deltas into its opening instant, so its
     * step is a genuine three-plus-sample rate. Either way the vertex is measured against the
     * estimator — a withheld vertex may not carry a number, and a published one always does.
     */
    const firstStepMass = attempt.samples
      .filter(sample => sample.activeTimeMs <= 100)
      .reduce((sum, sample) => sum + sample.tokens, 0)
    const firstStepCount = attempt.samples.filter(sample => sample.activeTimeMs <= 100).length
    assert.equal(attempt.points[1].tps,
      firstStepCount >= 3 ? Math.round(firstStepMass * 1000 / 100) : null,
      `${attempt.attemptId}: the first step is the attempt's own mass over its own clock once the policy admits it`)
    if (firstStepCount < 3) {
      assert.equal(attempt.points[1].rateUnavailableReason, 'below-sample-warmup',
        `${attempt.attemptId}: ${firstStepCount} samples cannot carry a rate`)
    }
    const published = attempt.points.filter(point => point.publishable)
    assert.ok(published.length > 0, `${attempt.attemptId}: the attempt publishes no measurement at all`)
    for (const point of published) {
      const ownMass = attempt.samples
        .filter(sample => sample.phase === point.activePhase
          && sample.activeTimeMs <= point.localMs
          && sample.activeTimeMs >= point.episodeStartMs)
        .reduce((sum, sample) => sum + sample.tokens, 0)
      assert.equal(point.tps, Math.round(ownMass * 1000 / point.episodeElapsedMs),
        `${attempt.attemptId} at ${point.localMs}: the published vertex is the attempt's own mass over its own elapsed clock`)
      assert.ok(point.episodeElapsedMs >= 100 && point.episodeSampleCount >= 3,
        `${attempt.attemptId} at ${point.localMs}: a published rate must satisfy both gates`)
    }
    if (index > 0) {
      const previous = curve.attempts[index - 1]
      assert.equal(previous.points.at(-1).timeMs, attempt.points[0].timeMs,
        `${attempt.attemptId}: the attempts abut on one compressed coordinate`)
      const closing = previous.points.at(-1)
      assert.equal(closing.publishable, true,
        `${previous.attemptId}: the predecessor closes on a measurement of its own`)
      const closingMass = previous.samples
        .filter(sample => sample.phase === closing.activePhase
          && sample.activeTimeMs <= closing.localMs
          && sample.activeTimeMs >= closing.episodeStartMs)
        .reduce((sum, sample) => sum + sample.tokens, 0)
      assert.equal(closing.tps, Math.round(closingMass * 1000 / closing.episodeElapsedMs),
        `${previous.attemptId}: and that closing measurement is its own mass over its own clock`)
    }
  }
  /** Tool time consumes no width: the axis is the sum of the calls' own spans. */
  const ownSpans = curve.segments.reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0)
  assert.equal(curve.durationMs, ownSpans)
  assert.ok(curve.durationMs > 60_000,
    `the axis keeps every call's own width, including the four-second stalls and the settlement `
    + `tails; measured ${curve.durationMs}`)
  assert.ok(curve.durationMs < 2 * 60_000,
    `and it is model generation only, so it stays close to a minute; measured ${curve.durationMs}`)
  /** The turn's wall clock is much larger than the axis, because the tools are in it. */
  assert.ok(settled.turnElapsedMs > curve.durationMs + 20_000,
    `the ${CALLS - 1} tools cost real time that the axis does not carry: `
    + `turn ${settled.turnElapsedMs} ms against axis ${curve.durationMs} ms`)
  /**
   * Every call ends on its own terminal episode's end — its settlement instant — so an attempt
   * draws nothing past the coordinate it owns, and the final call's end is the axis end. That
   * is one rule for every attempt: the previous revision ended each call on its last delta and
   * gave the **final** one a one-window tail, which drew one attempt's evidence differently
   * depending on where it happened to sit in the turn.
   */
  const finalAttempt = curve.attempts[curve.attempts.length - 1]
  assert.equal(finalAttempt.points.at(-1).timeMs, curve.durationMs,
    'the last call ends on its own settlement instant, which is the axis end')
  for (const [index, attempt] of curve.attempts.entries()) {
    assert.equal(attempt.points.at(-1).timeMs, curve.segments[index].endMs,
      `${attempt.attemptId} ends on the last coordinate it owns`)
  }

  /**
   * The peak is a per-call maximum: the turn peak is the maximum over the attempts' own traces,
   * never a sum and never an average assembled across calls.
   */
  assert.equal(curve.peakTps, Math.max(...curve.attempts.map(attempt => peakTps(attempt.points))),
    'the turn peak is the strongest single call, not a quantity assembled from two calls')
  assert.ok(curve.peakTps <= Math.max(...curve.attempts.map(attempt => attempt.tokens)) * 20,
    'and it respects the strongest call\'s own mass over the smallest measurable clock')
})

test('the old episode-based geometry is measurably worse on the same turn', () => {
  /**
   * An executable statement of the improvement, computed from the same fixture.
   *
   * The rejected rule is re-derived here rather than imported: partition each phase's samples
   * into episodes by the single "gap longer than the superseded one-second window" rule, and
   * count what the chart would have had to draw — one subpath per episode, and one singleton
   * marker per episode that holds a single grid vertex. That is the geometry the screenshot
   * showed. The window constant is kept here, and only here, as the superseded parameter of a
   * rejected drawing rule; no rate in this file is measured with it.
   */
  const { settled } = driveLongAgentTurn()
  const curve = settled.curve

  let legacyRuns = 0
  let legacyMarkers = 0
  for (const attempt of curve.attempts) {
    for (const phase of ['reasoning', 'output']) {
      const samples = attempt.samples.filter(sample => sample.phase === phase)
      if (samples.length === 0) continue
      let episodes = 1
      for (let index = 1; index < samples.length; index += 1) {
        if (samples[index].activeTimeMs > samples[index - 1].activeTimeMs + SUPERSEDED_WINDOW_MS) episodes += 1
      }
      legacyRuns += episodes
      /**
       * An episode whose span is under one sampling step has only its opening instant, which
       * the old renderer drew as a point marker. That is the bead.
       */
      let open = samples[0]
      for (let index = 1; index <= samples.length; index += 1) {
        const closes = index === samples.length
          || samples[index].activeTimeMs > samples[index - 1].activeTimeMs + SUPERSEDED_WINDOW_MS
        if (!closes) continue
        const last = samples[index - 1]
        if (last.activeTimeMs - open.activeTimeMs < curve.sampleEveryMs) legacyMarkers += 1
        open = samples[index]
      }
    }
  }
  const newRuns = runsOf(curve).length

  /**
   * The comparison that matters, and the one the screenshot shows: the rejected geometry's
   * subpath count grows with the number of *silences* as well as the number of calls, while
   * the corrected one grows with the number of phase stretches alone. The fixture makes the
   * counts exact: every non-stalling call contributes two episodes, and every stalling call
   * splits its output phase into three single-delta episodes — `18 * 2 + 6 * 4 = 60` against
   * the corrected `2 * CALLS = 48`.
   */
  assert.equal(newRuns, 2 * CALLS, `the corrected geometry drew ${newRuns} subpaths`)
  assert.equal(legacyRuns, 60, 'the rejected rule needed sixty subpaths for the same evidence')
  assert.ok(legacyRuns > newRuns,
    `the four-second stalls must cost the rejected rule subpaths; it drew ${legacyRuns} against ${newRuns}`)

  /**
   * The bead count is the visible half of the same defect, and the fixture reproduces it: the
   * rejected rule turns each single-vertex phase episode into a point marker — one per spaced
   * tool-call delta, `6 * 3 = 18`. The corrected geometry draws the same evidence as
   * continuous traces and produces **no** markers at all on this turn, because every call
   * streams for more than a second.
   */
  const view = curveViewModel({ curve })
  assert.equal(legacyMarkers, 18, 'the fixture must reproduce the bead: three per stalling call')
  assert.equal(view.markers.length, 0,
    `the corrected chart must not carry beads; it carries ${view.markers.length}`)
  assert.ok(view.markers.length < legacyMarkers,
    `the corrected geometry must draw fewer singleton markers than the rejected one `
    + `(${view.markers.length} against ${legacyMarkers})`)
})
