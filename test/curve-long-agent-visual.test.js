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
 * stretch, no horizontal gap at a tone change, an internall stall inside an attempt, a hard
 * reset between attempts, and a chart that never exceeds `MAX_RENDER_POINTS_TOTAL`.
 *
 * No exact path count, marker count or element count is frozen. Those are properties of the
 * turn's own delivery pattern, and pinning them would make the test fail on a legitimate
 * recording rather than on a regression. What is frozen is the *shape of the improvement*:
 * the marker count must be a small fraction of the attempt count rather than a multiple of it,
 * and no attempt may contribute more than one marker.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { MAX_RENDER_POINTS_TOTAL, peakTps } from '../src/core/curve.js'

const CALLS = 24

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
       * A stalling call also spaces its own tool-call arguments more than one window apart, so
       * the phase really does fall silent inside itself. That is the shape the rejected
       * episode-based drawing turned into additional subpaths.
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
   * a stretch of measured zero **between** two producing stretches, and it is drawn rather
   * than cut out. The last vertex of a trace is always zero (the final delta expires), so the
   * stall is identified by a zero that has a non-zero vertex after it.
   */
  const stalled = curve.attempts.filter(attempt => attempt.points.some((point, index) => (
    point.tps === 0 && attempt.points.slice(index + 1).some(later => later.tps > 0)
  )))
  assert.equal(stalled.length, Math.ceil(CALLS / 4),
    'every fourth call stalls inside its own stream, and the stall is visible')
  for (const attempt of stalled) {
    assert.equal(attempt.runs.length, 2,
      `${attempt.attemptId}: a stall is not a phase change, so it does not add a subpath`)
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
    'and the published peak is the maximum over the unbudgeted traces')
})

test('the long turn keeps its attempt resets and its zero-width tools', () => {
  const { settled } = driveLongAgentTurn()
  const curve = settled.curve

  /**
   * The chart is one subpath sequence per call, and every call owns its own trace: no window
   * crosses a boundary, so no attempt is credited with a neighbour's tokens.
   */
  for (const [index, attempt] of curve.attempts.entries()) {
    const ceiling = attempt.tokens
    for (const point of attempt.points) {
      assert.ok(point.tps <= ceiling + 1e-9,
        `${attempt.attemptId} at ${point.localMs} claims ${point.tps} tokens/s from ${ceiling} tokens`)
    }
    assert.equal(attempt.startMs, curve.segments[index].startMs)
  }
  /** Tool time consumes no width: the axis is the sum of the calls' own spans. */
  const ownSpans = curve.segments.reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0)
  assert.equal(curve.durationMs, ownSpans)
  assert.ok(curve.durationMs > 60_000,
    `the axis keeps every call's own width, including the four-second stalls; measured ${curve.durationMs}`)
  assert.ok(curve.durationMs < 2 * 60_000,
    `and it is model generation only, so it stays close to a minute; measured ${curve.durationMs}`)
  /** The turn's wall clock is much larger than the axis, because the tools are in it. */
  assert.ok(settled.turnElapsedMs > curve.durationMs + 20_000,
    `the ${CALLS - 1} tools cost real time that the axis does not carry: `
    + `turn ${settled.turnElapsedMs} ms against axis ${curve.durationMs} ms`)
  /**
   * Every call ends on its own last delta, so an attempt draws nothing past the coordinate it
   * owns. That is now one rule rather than two: the previous revision gave the **final** call a
   * one-window tail and cut every earlier one at its successor's start, which meant an attempt's
   * own evidence was drawn differently depending on where it happened to sit in the turn.
   */
  const finalAttempt = curve.attempts[curve.attempts.length - 1]
  assert.equal(finalAttempt.points.at(-1).timeMs, curve.durationMs,
    'the last call ends on its own last delta, which is the axis end')
  for (const [index, attempt] of curve.attempts.entries()) {
    assert.equal(attempt.points.at(-1).timeMs, curve.segments[index].endMs,
      `${attempt.attemptId} ends on the last coordinate it owns`)
  }

  /** The peak is a per-call maximum, so no multi-call sum can exceed any call's own ceiling. */
  const strongest = Math.max(...curve.attempts.map(attempt => attempt.tokens))
  assert.ok(curve.peakTps <= strongest + 1e-9,
    `the peak ${curve.peakTps} cannot exceed the strongest call's own total ${strongest}`)
})

test('the old episode-based geometry is measurably worse on the same turn', () => {
  /**
   * An executable statement of the improvement, computed from the same fixture.
   *
   * The rejected rule is re-derived here rather than imported: partition each phase's samples
   * into episodes by the single "gap longer than one window" rule, and count what the chart
   * would have had to draw — one subpath per episode, and one singleton marker per episode
   * that holds a single grid vertex. That is the geometry the screenshot showed.
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
        if (samples[index].activeTimeMs > samples[index - 1].activeTimeMs + curve.windowMs) episodes += 1
      }
      legacyRuns += episodes
      /**
       * An episode whose span is under one sampling step has only its opening instant, which
       * the old renderer drew as a point marker. That is the bead.
       */
      let open = samples[0]
      for (let index = 1; index <= samples.length; index += 1) {
        const closes = index === samples.length
          || samples[index].activeTimeMs > samples[index - 1].activeTimeMs + curve.windowMs
        if (!closes) continue
        const last = samples[index - 1]
        if (last.activeTimeMs - open.activeTimeMs < curve.sampleEveryMs) legacyMarkers += 1
        open = samples[index]
      }
    }
  }
  const newRuns = runsOf(curve).length

  /**
   * The comparison that matters, and the one the screenshot shows: the old geometry's subpath
   * count grows with the number of *silences* as well as the number of calls, while the new
   * one grows with the number of phase stretches alone.
   */
  assert.ok(newRuns <= 2 * CALLS, `the corrected geometry drew ${newRuns} subpaths`)
  assert.ok(legacyRuns >= newRuns,
    `the rejected geometry must not draw fewer subpaths than the corrected one (${legacyRuns} vs ${newRuns})`)
  /**
   * The stall fixture is what makes the rejected rule visibly worse here: every stalling call
   * splits each of its two phases into two episodes, so the old drawing needed strictly more
   * subpaths for the same evidence.
   */
  assert.ok(legacyRuns > newRuns,
    `the four-second stalls must cost the rejected rule subpaths; it drew ${legacyRuns} against ${newRuns}`)

  /**
   * The bead count is the visible half of the same defect, and the fixture reproduces it: the
   * rejected rule turns each short single-vertex phase episode into a point marker. The
   * corrected geometry draws the same evidence as continuous traces and produces **no**
   * markers at all on this turn, because every call streams for more than a second.
   */
  const view = curveViewModel({ curve })
  assert.ok(legacyMarkers > 0,
    'the fixture must reproduce the bead: the rejected rule found no singleton episode to draw')
  assert.equal(view.markers.length, 0,
    `the corrected chart must not carry beads; it carries ${view.markers.length}`)
  assert.ok(view.markers.length < legacyMarkers,
    `the corrected geometry must draw fewer singleton markers than the rejected one `
    + `(${view.markers.length} against ${legacyMarkers})`)
})
