/**
 * Phase 6 runtime robustness.
 *
 * The Phase 5 audit found two statistical defects. This file is the other half of
 * the phase: the runtime shapes that a real session produces and that no frozen
 * statistic may be allowed to mis-handle — sequential and concurrent tools, a
 * tool-only turn, an empty turn, an abandoned attempt, retries before and after a
 * tool, a provider error, a failing tool, incomplete usage, missing counters and
 * missing timestamps, a window rebaseline, a reload mid-turn, and duplicate or
 * out-of-order frames.
 *
 * Each scenario is built through the real `TurnTelemetryStore`, so what is
 * asserted is the shipped behaviour rather than a restatement of it. Where the
 * scenario needs a shape no recorded turn contains — a tool error envelope, a
 * concurrent tool pair, a rebaseline — this file says so explicitly and builds it
 * from the verified DSH event vocabulary rather than pretending a recording
 * exists.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { MetricQuality } from '../src/core/metric-quality.js'
import { QualityLevel } from '../src/core/quality-model.js'
import { LivePhase } from '../src/core/live-metrics.js'
import { turnKey } from '../src/core/types.js'
import { createController } from '../src/client/live/controller.js'
import { formatToolLabel } from '../src/client/live/live-format.js'
import { loadFixture, listFixtures } from './helpers/fixtures.js'
import { liveSettledView, durableSettledView } from './helpers/equivalence.js'
import { durableEntry, fakeSessionsService } from './helpers/live-replay.js'

const output = text => ({ type: 'text-delta', index: 0, text })
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })
const toolArgs = text => ({ type: 'tool-call-delta', index: 1, id: 'call', argumentsDelta: text })

/**
 * Drive one turn from a compact script. `attempts` entries are
 * `{ id, step, at, chunks, usage, settlementKind, surfaceCommitted, attemptOutcome, settlementSeq }`.
 */
function drive({
  attempts = [],
  tools = [],
  endMs = 0,
  status = 'completed',
  statusNote = null,
} = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  for (const spec of attempts) {
    const attempt = store.beginAttempt(record, { attemptId: spec.id, step: spec.step, startedAtMs: spec.at })
    for (const [timeMs, chunk] of spec.chunks ?? []) {
      store.acceptChunk(record, attempt, { timeMs, chunk })
    }
    if (spec.usageChunk !== undefined) {
      store.acceptChunk(record, attempt, { timeMs: spec.at, chunk: { type: 'usage', usage: spec.usageChunk } })
    }
    store.settleAttempt(attempt, {
      settledAtMs: spec.settledAtMs ?? spec.at,
      settlementKind: spec.settlementKind ?? 'message',
      surfaceCommitted: spec.surfaceCommitted ?? (spec.settlementKind ?? 'message') === 'message',
      attemptOutcome: spec.attemptOutcome ?? 'committed',
      usage: spec.usage ?? null,
      usageSource: spec.usageSource ?? null,
      settlementSeq: spec.settlementSeq ?? 1,
    })
  }
  for (const tool of tools) {
    store.toolStarted(record, { callId: tool.callId, name: tool.name, timeMs: tool.startMs })
    if (tool.endMs !== undefined) {
      store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status ?? 'ok' })
    }
    if (tool.settleBeforeEnd === true) store.toolSettled(record, { callId: tool.callId, timeMs: tool.startMs, status: 'ok' })
  }
  return {
    store,
    record,
    settled: store.endTurn(record, { timeMs: endMs, status, statusNote }),
    live: nowMs => store.liveSnapshot('s1', nowMs),
  }
}

// ── tools ──────────────────────────────────────────────────────────────────

test('multiple sequential tools: work equals wall and the curve keeps zero tool width', () => {
  const { settled } = drive({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, output('x'.repeat(400))], [500, output('x'.repeat(400))]] },
      { id: 'b', step: 2, at: 10_000, chunks: [[10_000, output('y'.repeat(400))], [10_500, output('y'.repeat(400))]] },
      { id: 'c', step: 3, at: 20_000, chunks: [[20_000, output('z'.repeat(400))], [20_500, output('z'.repeat(400))]] },
    ],
    tools: [
      { callId: 'c1', name: 'pwsh', startMs: 600, endMs: 5000 },
      { callId: 'c2', name: 'write', startMs: 10_600, endMs: 15_000 },
    ],
    endMs: 21_000,
  })
  assert.equal(settled.tools.count, 2)
  assert.equal(settled.tools.workMs, 4400 + 4400)
  assert.equal(settled.tools.wallMs, 4400 + 4400, 'non-overlapping tools cannot be double-counted')
  assert.equal(settled.curve.durationMs, 1500, 'three 500 ms attempts, no tool width')
  assert.equal(settled.curve.segments.length, 3)
})

test('concurrent tools: summed work exceeds the wall union, and the live timer measures the union', () => {
  const { store, record } = drive({})
  /**
   * Three calls overlapping in one episode: each runs 10 s, but the union is 12 s.
   * `workMs > wallMs` is the documented expectation, not a defect
   * (docs/METRICS_SPEC.md §5).
   */
  store.toolStarted(record, { callId: 'a', name: 'pwsh', timeMs: 0 })
  store.toolStarted(record, { callId: 'b', name: 'pwsh', timeMs: 1000 })
  store.toolStarted(record, { callId: 'c', name: 'read', timeMs: 2000 })
  const during = store.liveSnapshot('s1', 2000)
  assert.equal(during.phase, LivePhase.TOOL)
  assert.equal(during.runningToolCount, 3)
  assert.equal(during.toolElapsedMs, 2000, 'the episode clock starts at the first call, not the latest')
  assert.equal(during.tps, null, 'a tool stage never shows a rate')

  store.toolSettled(record, { callId: 'a', name: 'pwsh', timeMs: 10_000, status: 'ok' })
  store.toolSettled(record, { callId: 'b', name: 'pwsh', timeMs: 11_000, status: 'ok' })
  store.toolSettled(record, { callId: 'c', name: 'read', timeMs: 12_000, status: 'ok' })

  const attempt = store.beginAttempt(record, { attemptId: 'after', step: 1, startedAtMs: 12_100 })
  store.acceptChunk(record, attempt, { timeMs: 12_200, chunk: output('done') })
  store.settleAttempt(attempt, { settledAtMs: 12_300, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })
  const settled = store.endTurn(record, { timeMs: 12_400, status: 'completed' })

  assert.equal(settled.tools.workMs, 10_000 + 10_000 + 10_000, 'each call contributes its own duration')
  assert.equal(settled.tools.wallMs, 12_000, 'the union is measured once')
  assert.ok(settled.tools.workMs > settled.tools.wallMs, 'paragraph 5 of the spec: work may exceed wall')
  assert.deepEqual(settled.tools.names, ['pwsh', 'read'], 'distinct names, in first-seen order')
  assert.equal(settled.tools.count, 3, 'but three calls, which is what the label counts')
})

test('the live tool label stays compact from one call to ten', () => {
  /**
   * The pill must not grow with the tool count. The label is `first +N`, and a long
   * first name truncates, so an arbitrary number of concurrent calls cannot widen it
   * without bound. `formatToolLabel` receives the **distinct** names and the call
   * count, so ten concurrent calls of one tool read `pwsh +9` rather than ten names.
   */
  const cases = [
    [['pwsh'], 1, 'pwsh'],
    [['pwsh', 'read'], 2, 'pwsh +1'],
    [['pwsh', 'read', 'write', 'edit', 'grep'], 5, 'pwsh +4'],
    [['pwsh'], 10, 'pwsh +9'],
    [Array.from({ length: 10 }, (_, i) => `tool${i}`), 10, 'tool0 +9'],
    [['a-very-long-tool-name-indeed'], 1, 'a-very-long-tool-na…'],
    [['a-very-long-tool-name-indeed', 'x'], 2, 'a-very-long-tool-na… +1'],
    [[], 0, DASH_LABEL],
  ]
  for (const [names, count, expected] of cases) {
    const label = formatToolLabel(names, count)
    assert.equal(label, expected)
    assert.ok(label.length <= 24, `"${label}" stays within a narrow pill`)
  }
  /**
   * A count with no name at all still distinguishes itself from a single call: it
   * renders `+N`, which is a count and not a name. Ten calls never render as ten
   * names.
   */
  assert.equal(formatToolLabel([], 3), '+2')
  const ten = formatToolLabel(Array.from({ length: 10 }, (_, i) => `tool${i}`), 10)
  assert.equal(ten.includes('tool9'), false, 'only the first name is printed')
  for (const count of [1, 2, 5, 10, 50]) {
    const label = formatToolLabel(['pwsh'], count)
    assert.ok(label.length <= 8, `${count} calls render as "${label}"`)
  }
})

const DASH_LABEL = '—'

// ── turn shapes ────────────────────────────────────────────────────────────

test('a tool-only turn is a full card, and the curve shows only the phases that exist', () => {
  const { settled } = drive({
    attempts: [
      {
        id: 'a',
        step: 1,
        at: 0,
        chunks: [[0, toolArgs('{"command":"Write-Output 1"}')], [500, toolArgs('}')]],
        usage: { outputTokens: 120, reasoningTokens: 0 },
      },
    ],
    tools: [{ callId: 'c1', name: 'pwsh', startMs: 600, endMs: 1600 }],
    endMs: 2000,
  })
  /** Tool-call arguments are model output: the turn generated tokens. */
  assert.equal(settled.generatedTokens, 120)
  /**
   * `reasoningTokens: 0` from a provider that also reported no reasoning delta is
   * the one case where a per-phase zero is a measurement rather than a fabrication:
   * both evidence sources agree that the phase produced nothing, so the paired
   * counter reads `0` and is not an em dash.
   */
  assert.equal(settled.phaseTokens.reasoning, 0)
  assert.equal(settled.consistencyIssues.length, 0, 'the two evidence sources agree')
  assert.ok(settled.outputTps > 0, 'the output phase is measurable')
  const outputSeries = settled.curve.series.find(series => series.key === 'output')
  const reasoningSeries = settled.curve.series.find(series => series.key === 'reasoning')
  assert.ok(outputSeries.runs.length > 0, 'the output phase is drawn')
  assert.deepEqual(reasoningSeries.runs, [], 'a phase with no delta contributes no path')
  assert.equal(reasoningSeries.present, false)
  assert.equal(settled.status, 'completed')
  assert.equal(settled.tools.count, 1)
})

test('the recorded tool-only turn really has no assistant text', () => {
  /**
   * `t6` is a real deepseek-official turn whose attempts each emitted reasoning
   * plus a tool call and no surface text. It is the only recorded evidence for
   * the tool-only shape, so the fixture is asserted rather than trusted.
   */
  const fixture = loadFixture('t6-tool-only-deepseek-official')
  const { settled } = liveSettledView(fixture)
  assert.equal(settled.status, 'completed')
  assert.ok(settled.generatedTokens > 0, 'the turn generated tokens')
  assert.ok(settled.tools.count >= 3, 'and it called tools')

  /**
   * No settlement's stream carries a non-empty `text-delta`: every generated
   * chunk is reasoning or a tool-call argument.
   */
  let textDeltas = 0
  for (const row of fixture.durable) {
    const stream = row.event.data?.stream
    if (!Array.isArray(stream)) continue
    for (const record of stream) {
      if (record?.chunk?.type === 'text-delta' && (record.chunk.text ?? '') !== '') textDeltas += 1
    }
  }
  assert.equal(textDeltas, 0, 'a tool-only turn emits no assistant text at all')

  /** And the curve reports it that way: reasoning plus tool-argument output. */
  const outputRuns = settled.curve.series.find(series => series.key === 'output').runs
  assert.ok(outputRuns.length > 0, 'tool-call arguments are drawn as output')
  assert.equal(settled.curve.quality, QualityLevel.RECONSTRUCTED)
})

test('an empty-output turn reports unavailable rather than a zero', () => {
  /**
   * `turn/start -> turn/end` with no model-producing delta. The provider said
   * nothing about how many tokens were generated, so the honest value is
   * `null` — never `0`, which would be a measurement nobody made.
   */
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 100 })
  store.settleAttempt(record.attempts[0], {
    settledAtMs: 200,
    settlementKind: 'message',
    surfaceCommitted: false,
    attemptOutcome: 'unknown',
  })
  const settled = store.endTurn(record, { timeMs: 300, status: 'completed' })

  assert.equal(settled.generatedTokens, null, 'no provider counter, so unavailable')
  assert.equal(settled.ttftMs, null, 'no first token, so no TTFT')
  assert.equal(settled.reasoningTps, null)
  assert.equal(settled.outputTps, null)
  assert.equal(settled.generatedTokensQuality, MetricQuality.UNAVAILABLE)
  assert.equal(settled.emptyAttemptCount, 1)
  assert.equal(settled.contributingAttemptCount, 0)
  assert.equal(settled.curve.durationMs, 0)
  assert.deepEqual(settled.curve.series.flatMap(series => series.runs), [], 'nothing to draw')
  assert.equal(settled.curve.quality, QualityLevel.UNAVAILABLE)
  assert.equal(settled.status, 'completed', 'the card still renders, on its status')
})

test('an abandoned attempt keeps its prefix as evidence and downgrades the timing claim', () => {
  const { settled } = drive({
    attempts: [
      {
        id: 'streaming',
        step: 1,
        at: 0,
        chunks: [[0, output('partial')], [400, output(' more')]],
        settlementKind: 'none',
        surfaceCommitted: false,
        attemptOutcome: 'abandoned',
        settlementSeq: null,
        usage: null,
      },
      {
        id: 'final',
        step: 1,
        at: 5000,
        chunks: [[5000, output('recovered')], [5500, output(' text')]],
        usage: { outputTokens: 90, reasoningTokens: 0 },
      },
    ],
    endMs: 6000,
  })
  /**
   * Phase 3 froze the distinction: `assistant/attempt` is a durable settlement,
   * not an abandonment. An abandoned attempt is one whose *transient* frame
   * reported `outcome.kind === 'abandoned'`; here that prefix still contributes
   * its observed shape, and the turn's timing claim is dropped because one
   * attempt has no durable settlement.
   */
  assert.equal(settled.attemptCount, 2)
  assert.equal(settled.contributingAttemptCount, 2, 'the abandoned prefix is real generation')
  assert.equal(settled.usageComplete, false)
  assert.equal(settled.splitComplete, false)
  assert.equal(settled.quality.temporalShapeQuality, QualityLevel.ESTIMATED,
    'an attempt with no settlement sequence cannot support a reconstructed shape')
  assert.equal(settled.curve.quality, QualityLevel.ESTIMATED)
  assert.ok(settled.observedGeneratedTokens > 0, 'the partial sum is reported, not discarded')
  assert.equal(settled.generatedTokens, null, 'and never presented as the total')
})

// ── retries and errors ─────────────────────────────────────────────────────

test('a retry before a tool resets the window on both sides of the boundary', () => {
  const { settled, live } = drive({
    attempts: [
      {
        id: 'first',
        step: 1,
        at: 0,
        chunks: [[0, output('a'.repeat(2000))], [500, output('a'.repeat(2000))]],
        settlementKind: 'attempt',
        surfaceCommitted: false,
        attemptOutcome: 'retried',
      },
      {
        id: 'second',
        step: 1,
        at: 600,
        chunks: [[600, output('b'.repeat(40))], [1100, output('b'.repeat(40))]],
      },
    ],
    endMs: 2200,
  })
  const runs = settled.curve.series.find(series => series.key === 'output').runs
  assert.deepEqual(runs.map(run => run.attemptId), ['first', 'second'])
  /**
   * The abandoned attempt's own series is measured on its own window, and the
   * replacement's on its own. Both attempts carry the same *shape* — one measurement
   * at local zero and one half a window later — so the relationship between them is
   * the assertion: each of the replacement's vertices is a tenth of the abandoned
   * attempt's at the same local instant, whatever the estimator's absolute scale.
   *
   * A bridged window would put `firstTokens + secondTokens` in the replacement's
   * opening vertex and break that ratio at the first vertex.
   */
  const ratio = runs[0].attemptTokens / runs[1].attemptTokens
  assert.ok(ratio >= 9.5, `the two attempts differ by ${ratio.toFixed(2)}×`)
  assert.equal(runs[1].points.length, runs[0].points.length + 4,
    'the replacement owns the axis tail, so it carries four more vertices')
  for (let index = 0; index < runs[0].points.length; index += 1) {
    const mine = runs[1].points[index]
    const theirs = runs[0].points[index]
    assert.equal(mine.timeMs - runs[1].startMs, theirs.timeMs - runs[0].startMs,
      'the two series are sampled at the same attempt-local instants')
    assert.ok(Math.abs(mine.tps * ratio - theirs.tps) < 1e-9,
      `local ${theirs.timeMs - runs[0].startMs}: ${mine.tps} × ${ratio.toFixed(2)} ≠ ${theirs.tps}`)
  }
  assert.ok(runs[1].attemptTokens < runs[0].attemptTokens / 9, 'the replacement generated far less')
  /**
   * The decisive check: the abandoned attempt's tokens never appear in the
   * replacement's series. A bridged window would put `firstTokens + secondTokens` in
   * the replacement's opening vertex, which would break the tenfold ratio at the
   * first vertex rather than merely shifting it.
   */
  assert.ok(runs[1].points.every(point => point.tps <= runs[1].attemptTokens * 1000 / 1000 + 1e-9),
    'every vertex of the retry is bounded by the retry\'s own tokens')
  assert.equal(settled.attemptBreakdown.map(a => a.attemptOutcome).join(','), 'retried,committed')
  assert.equal(settled.curve.quality, QualityLevel.ESTIMATED,
    'the abandoned attempt has no settlement sequence, so the timing claim is dropped')
})

test('a retry after a tool resets the window again, and the tool keeps zero width', () => {
  const { settled } = drive({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, output('x'.repeat(400))], [500, output('x'.repeat(400))]] },
      {
        id: 'b',
        step: 2,
        at: 6000,
        chunks: [[6000, output('y'.repeat(4000))], [6500, output('y'.repeat(4000))]],
        settlementKind: 'attempt',
        surfaceCommitted: false,
        attemptOutcome: 'retried',
      },
      { id: 'c', step: 2, at: 7000, chunks: [[7000, output('z'.repeat(40))], [7500, output('z'.repeat(40))]] },
    ],
    tools: [{ callId: 't1', name: 'pwsh', startMs: 600, endMs: 5000 }],
    endMs: 8000,
  })
  const runs = settled.curve.series.find(series => series.key === 'output').runs
  assert.deepEqual(runs.map(run => run.attemptId), ['a', 'b', 'c'],
    'the abandoned attempt and its replacement are separate runs')
  assert.equal(settled.curve.durationMs, 500 + 500 + 500, 'the 4.4 s tool contributes no width')
  assert.deepEqual(runs[2].points.map(p => p.tps), [10, 10, 20, 20, 10, 10, 0],
    'the second retry starts empty, whatever the first two attempts measured')
  assert.ok(settled.curve.peakTps >= 1000)
})

test('a provider error is a status, and the attempts it left behind are still measured', () => {
  const { settled } = drive({
    attempts: [
      {
        id: 'a',
        step: 1,
        at: 0,
        chunks: [[0, reasoning('thinking')], [900, reasoning(' more')]],
        settlementKind: 'attempt',
        surfaceCommitted: false,
        attemptOutcome: 'stream-error',
        usage: null,
        usageSource: null,
      },
    ],
    endMs: 1000,
    status: 'errored',
    statusNote: 'provider stream failed',
  })
  assert.equal(settled.status, 'errored', 'the turn status follows turn/end, not the attempt')
  assert.equal(settled.attemptBreakdown[0].attemptOutcome, 'stream-error')
  assert.equal(settled.contributingAttemptCount, 1, 'the attempt generated tokens before failing')
  assert.equal(settled.reasoningMs, 900, 'its generation time is real and is measured')
  assert.equal(settled.generatedTokens, null, 'but no provider total exists')
  assert.equal(settled.curve.quality, QualityLevel.ESTIMATED)
  assert.equal(settled.curve.durationMs, 900)
  /** An errored turn is still a card: status removes no metric. */
  assert.equal(settled.phaseTokensQuality, MetricQuality.UNAVAILABLE)
})

test('a failed tool does not fail the turn, and the tool status stays separate', () => {
  /**
   * `tool/result` with an `error` envelope (or `isError: true`) marks the **call**
   * as failed. It says nothing about the turn: the model commonly recovers, and
   * the recorded `t7` turn shows the milder version of the same shape — a shell
   * command that failed while DSH recorded the call itself as successful.
   */
  const failed = drive({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, output('trying')], [500, output(' a tool')]] },
      { id: 'b', step: 1, at: 3000, chunks: [[3000, output('recovered')], [3500, output(' anyway')]] },
    ],
    tools: [{ callId: 'c1', name: 'pwsh', startMs: 600, endMs: 2600, status: 'error' }],
    endMs: 4000,
  })
  assert.equal(failed.settled.tools.failedCount, 1)
  assert.equal(failed.settled.tools.completedCount, 1, 'a failed call still completed')
  assert.equal(failed.settled.status, 'completed', 'the turn recovered and completed')
  assert.equal(failed.settled.generatedTokens, null)
  assert.ok(failed.settled.tools.workMs > 0, 'the failed call still cost wall time')

  /** The recorded turn: the call succeeded as far as DSH is concerned. */
  const fixture = loadFixture('t7-failing-pwsh-deepseek-official')
  const recorded = liveSettledView(fixture).settled
  assert.equal(recorded.status, 'completed')
  assert.equal(recorded.tools.completedCount, 1)
  assert.equal(recorded.tools.failedCount, 0,
    'DSH delivered the PowerShell error as tool output, so the call itself is not an error')
  assert.ok(recorded.tools.workMs > 0)
  assert.ok(recorded.generatedTokens > 0, 'and the turn still produced a full card')
})

// ── evidence gaps ──────────────────────────────────────────────────────────

test('a duplicate row object is deduplicated, not double counted', () => {
  /**
   * A re-attach, a lagging subscription or a replayed page can publish the same
   * window row twice. The feed identifies a row by object identity, so the second
   * delivery of the same row must reach neither the samples nor the rolling window:
   * counting it would double the measured throughput of one delta.
   */
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-dupes')
  const controller = createController({ sessions })
  controller.attach('s-dupes')
  let revision = 1
  source.appendEntry(durableEntry('turn/start', 4, 1000, { turn: 1 }), (revision += 1))
  const row = {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq: 7,
      time: 1100,
      data: {
        attemptId: 'a:1',
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(400) },
      },
    },
  }
  source.appendEntry(row, (revision += 1))
  const once = controller.project('s-dupes', 1200)
  assert.equal(once.kind, 'streaming')
  const record = controller.store.turns.get(turnKey('s-dupes', 1))
  assert.equal(record.attempts[0].samples.length, 1)

  /** The same row object delivered again under a new window revision. */
  source.appendEntry(row, (revision += 1))
  const twice = controller.project('s-dupes', 1200)
  assert.equal(twice.tps, once.tps, 'a duplicate row cannot change the rate')
  assert.equal(record.attempts[0].samples.length, 1, 'and it is stored once')
  assert.equal(controller.diagnostics('s-dupes').feedIssues.some(issue => issue.kind === 'duplicate-transient-row'), true,
    'the duplicate is reported rather than silently ignored')
  controller.dispose()
})

test('a late frame for a superseded attempt lands in the completed curve but never in the live window', () => {
  /**
   * Late frames arrive after the turn has moved on. Two different answers are
   * correct here and they are not in conflict: the **completed** curve is built from
   * what each attempt really produced, so a late delta extends its own attempt; the
   * **live** window is bound to the active attempt, so the same frame can never enter
   * the newer attempt's rate.
   */
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const a = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 100 })
  store.acceptChunk(record, a, { timeMs: 200, chunk: output('x'.repeat(400)) })
  store.acceptChunk(record, a, { timeMs: 700, chunk: output('x'.repeat(400)) })
  store.settleAttempt(a, { settledAtMs: 800, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  /** Attempt `b` becomes the active attempt, then a late frame for `a` arrives. */
  const b = store.beginAttempt(record, { attemptId: 'b', step: 2, startedAtMs: 900 })
  store.acceptChunk(record, b, { timeMs: 1000, chunk: output('y'.repeat(40)) })
  const beforeLate = store.liveSnapshot('s1', 1000).tps
  const late = store.acceptChunk(record, a, { timeMs: 500, chunk: output('x'.repeat(4000)) })

  assert.ok(late !== null, 'the late frame is stored against its own attempt')
  assert.equal(a.samples.length, 3, 'the closed attempt keeps every delta it really produced')
  assert.deepEqual(b.samples.map(sample => sample.timeMs), [1000], 'the live attempt gains nothing')
  assert.equal(store.liveSnapshot('s1', 1000).tps, beforeLate,
    'and the live rate is unchanged: the meter rejects a sample from another attempt')

  const settled = store.endTurn(record, { timeMs: 1100, status: 'completed' })
  const runs = settled.curve.series.find(series => series.key === 'output').runs
  assert.deepEqual(runs.map(run => run.attemptId), ['a', 'b'],
    'the late frame extends the attempt that owns it, not the one that was streaming')
  const runB = runs[1]
  assert.ok(runB.points.every(point => point.tps <= runB.attemptTokens * 1000 / 1000 + 1e-9),
    'and it never inflates the newer attempt\'s ceiling')
  const runA = runs.find(run => run.attemptId === 'a')
  assert.ok(runA.attemptTokens > 1000, 'attempt A owns all three of its deltas')
})

test('a delta with no matching turn is reported and dropped, never attached to a guess', () => {
  const sessions = fakeSessionsService()
  const source = sessions.createSource('s-orphan')
  const controller = createController({ sessions })
  controller.attach('s-orphan')
  let revision = 1
  /** No `turn/start` in this window, so nothing can own the delta. */
  source.appendEntry({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 1, time: 1100, data: { attemptId: 'a:1', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'orphan' } } } }, (revision += 1))
  const view = controller.project('s-orphan', 1200)
  assert.equal(view.kind, 'hidden', 'nothing renders without a turn')
  assert.equal(controller.diagnostics('s-orphan').droppedDeltas, 1, 'and the drop is counted')
  assert.equal(controller.store.turns.size, 0, 'no turn record is fabricated for it')
  controller.dispose()
})

test('incomplete usage reports the partial sum and an estimated total, never a fabricated one', () => {
  const { settled } = drive({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, output('x'.repeat(400))], [500, output('x'.repeat(400))]], usage: { outputTokens: 500, reasoningTokens: 100 } },
      { id: 'b', step: 2, at: 3000, chunks: [[3000, output('y'.repeat(400))], [3500, output('y'.repeat(400))]], usage: null },
    ],
    endMs: 4000,
  })
  assert.equal(settled.usageComplete, false)
  assert.equal(settled.generatedTokens, null, 'one counter is missing, so the total is not published')
  assert.equal(settled.observedGeneratedTokens, 500, 'but the partial sum is reported as evidence')
  assert.equal(settled.generatedTokensQuality, MetricQuality.ESTIMATED)
  assert.equal(settled.quality.tokenTotalQuality, QualityLevel.PARTIAL,
    'some contributors were authoritative and some were not')
  /**
   * The split axis answers `estimated`, not `partial`, and the asymmetry is
   * deliberate: a *sum* over the attempts that reported is a real publishable
   * quantity, so the total axis has a `partial` answer; a *division* over a
   * population with a silent member does not, so the split stays `estimated`
   * (`docs/METRICS_SPEC.md` §8.3).
   */
  assert.equal(settled.quality.phaseSplitQuality, QualityLevel.ESTIMATED)
  assert.notEqual(settled.quality.phaseSplitQuality, QualityLevel.EXACT)
  /**
   * The curve is untouched by the token axis in the sense that matters — its
   * quality is the temporal axis and never `usageComplete` — but the temporal axis
   * itself is anchored only when every contributing attempt carries an
   * authoritative total. Attempt `b` has none, so the shape stops at `estimated`
   * even though the timing is durable. The asymmetry is the reason the axes are
   * separate in the first place.
   */
  assert.equal(settled.quality.temporalShapeQuality, QualityLevel.ESTIMATED)
  assert.equal(settled.curve.quality, QualityLevel.ESTIMATED)
  assert.notEqual(settled.curve.quality, QualityLevel.CALIBRATED)
})

test('missing reasoningTokens anchors the total and never claims an exact split', () => {
  const { settled } = drive({
    attempts: [
      { id: 'a', step: 1, at: 0, chunks: [[0, reasoning('think')], [400, output('answer')]], usage: { outputTokens: 300 } },
    ],
    endMs: 1000,
  })
  assert.equal(settled.usageComplete, true)
  assert.equal(settled.generatedTokens, 300, 'the total is authoritative')
  assert.equal(settled.splitComplete, false)
  assert.equal(settled.reasoningTokens, null)
  assert.equal(settled.nonReasoningTokens, null)
  assert.equal(settled.quality.tokenTotalQuality, QualityLevel.EXACT)
  assert.equal(settled.quality.phaseSplitQuality, QualityLevel.ESTIMATED)
  assert.equal(settled.quality.displayTokenTotal, 'exact')
  assert.equal(settled.quality.displayPhaseSplit, 'approximate')
  assert.ok(settled.phaseTokens.reasoning > 0, 'the anchor still divides the total by shape')
})

test('missing timestamps are refused rather than defaulted to zero', () => {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId: 's1', turn: 1, timeMs: 0 })
  const attempt = store.beginAttempt(record, { attemptId: 'a', step: 1, startedAtMs: 0 })
  store.acceptChunk(record, attempt, { timeMs: 100, chunk: output('x') })
  store.acceptChunk(record, attempt, { timeMs: Number.NaN, chunk: output('y') })
  store.acceptChunk(record, attempt, { timeMs: 300, chunk: output('z') })
  store.settleAttempt(attempt, { settledAtMs: 400, settlementKind: 'message', surfaceCommitted: true, attemptOutcome: 'committed' })

  assert.equal(attempt.samples.length, 2, 'a delta with no timestamp is not a sample')
  const settled = store.endTurn(record, { timeMs: 500, status: 'completed' })
  assert.equal(settled.timestampsComplete, undefined)
  /**
   * The curve is still built from the samples that do carry a timestamp, and no
   * vertex is placed at zero by default. The turn's timing claim is `estimated`
   * because an attempt with no settlement sequence cannot support more.
   */
  assert.equal(settled.curve.durationMs, 200)
  for (const series of settled.curve.series) {
    for (const run of series.runs) {
      for (const point of run.points) {
        assert.ok(Number.isFinite(point.timeMs) && Number.isFinite(point.localMs))
      }
    }
  }
})

// ── the recorded corpus ────────────────────────────────────────────────────

test('every recorded turn survives the full settle path under both readings', () => {
  /**
   * One structural invariant over the whole corpus, including the Phase 6
   * additions: the live path and the durable-only path must produce the same card,
   * no curve vertex may be non-finite, and every run must obey its own attempt's
   * ceiling. A new recording is covered by this without a new test.
   */
  const names = listFixtures()
  assert.ok(names.length >= 8, `expected at least eight recorded turns, found ${names.length}`)
  for (const name of names) {
    const fixture = loadFixture(name)
    for (const [path, view] of [['live', liveSettledView(fixture)], ['durable', durableSettledView(fixture)]]) {
      const { settled, record } = view
      const where = `${name}/${path}`
      assert.ok(settled.attemptCount > 0 || settled.status === null, `${where} has attempts`)
      for (const series of settled.curve.series) {
        for (const run of series.runs) {
          const attempt = record.attempts.find(candidate => candidate.attemptId === run.attemptId)
          if (attempt === undefined) continue
          const ceiling = attempt.samples.reduce((sum, sample) => sum + sample.tokens, 0)
          for (const point of run.points) {
            assert.ok(Number.isFinite(point.tps), `${where} ${run.attemptId} has a finite rate`)
            assert.ok(point.tps <= ceiling + 1e-6,
              `${where} ${run.attemptId} at ${point.timeMs} claims ${point.tps} from ${ceiling} tokens`)
          }
          assert.equal(run.peak, Math.max(...run.points.map(p => p.tps)), `${where} run peak`)
        }
      }
      assert.equal(settled.curve.quality, settled.quality.temporalShapeQuality, `${where} curve quality`)
    }
  }
})

test('the recorded corpus contains no provider retry, and that is reported as such', () => {
  /**
   * Phase 6 asked for a recorded `provider-error retry` fixture. Three attempts
   * were made (t4, t5 and t8 on the deepseek-official route, including one prompt
   * aimed specifically at a long reasoning turn) and **none** scheduled an
   * `llm/retry`. This test pins that down as evidence rather than leaving it as a
   * claim in a report: if a future recording does contain one, the assertion below
   * fails and the retry path stops being untested against real data.
   */
  for (const name of listFixtures()) {
    const fixture = loadFixture(name)
    const retries = fixture.durable.filter(row => row.event.type === 'llm/retry')
    assert.equal(retries.length, 0, `${name} unexpectedly contains a provider retry — add a real retry test`)
  }
})
