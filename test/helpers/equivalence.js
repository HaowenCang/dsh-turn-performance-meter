/**
 * Live-vs-durable equivalence harness.
 *
 * Phase 2 must prove that one settled turn produces the same statistics through
 * two independent readings of the evidence:
 *
 *   path A  the transient plane — `agent/assistant-stream` frames (or the
 *           client-folded `assistant/live-chunk` rows), plus durable turn,
 *           step and tool boundaries. Path A never reads a compact
 *           `AssistantStreamRecord`.
 *   path B  the durable plane only — every settlement's embedded compact
 *           stream, decoded strictly.
 *
 * Both paths are driven into the same pure engine
 * (`TurnTelemetryStore` -> `aggregateTurn` -> `compressAttempts` -> curve), so a
 * disagreement is a disagreement about evidence, not about formulas.
 *
 * The comparison is deliberately split into two kinds of assertion:
 *
 *   - **exact** for anything copied from an envelope time or an integer provider
 *     counter: TTFT, tool durations, token totals, phase segmentation of the
 *     stream, and the compressed chart coordinates;
 *   - **within tolerance** for values derived from a shape weight, where
 *     `METRICS_SPEC.md` allows a local TPS difference. The tolerance is stated
 *     per metric and no semantic difference (present vs absent, phase swap,
 *     status change) is ever tolerated.
 */

import { TurnTelemetryStore } from '../../src/host/telemetry-design.js'
import { accumulateLive } from '../../src/dsh/live-path.js'
import { reconstructFromDurable, settlementChronology } from '../../src/dsh/durable-path.js'
import { settlementClassification, turnEndStatus } from '../../src/dsh/adapter.js'
import { attributePhaseDurations } from '../../src/core/phase-duration.js'
import { compressAttempts } from '../../src/core/time-axis.js'
import { rollingTpsSeries, peakTps } from '../../src/core/curve.js'

/** Local TPS difference allowed between paths, in tokens/s. */
export const TPS_TOLERANCE = 1e-9

/**
 * Run path A over one fixture.
 *
 * @param {object} fixture
 * @param {{useLiveChunks?:boolean}} [options]
 */
export function runLivePath(fixture, options = {}) {
  const sessionId = fixture.sessionId
  const durableEvents = fixture.durable.map(row => row.event)
  const frames = options.useLiveChunks === true
    ? []
    : fixture.transient.map(row => row.frame)
  const liveChunks = options.useLiveChunks === true
    ? fixture.transient.filter(row => row.frame.type === 'chunk').map(row => ({
      type: 'transient',
      event: {
        type: 'assistant/live-chunk',
        seq: null,
        time: row.frame.time,
        data: {
          attemptId: row.frame.attemptId,
          turn: null,
          step: null,
          chunk: row.frame.chunk,
        },
      },
    }))
    : []

  const turn = fixture.durable.find(row => row.event.type === 'turn/start')?.event.data.turn ?? null
  const accumulator = accumulateLive({ sessionId, frames, liveChunks, durableEvents })

  // Attempt identity exists only on the transient plane, so a settlement's
  // usage is attached through the transient `end` frame's `settlementSeq`, which
  // is the durable sequence of that attempt's settlement.
  const settlementBySeq = new Map()
  for (const row of fixture.durable) {
    const event = row.event
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    settlementBySeq.set(event.seq, event)
  }
  for (const frame of fixture.transient.map(row => row.frame)) {
    if (frame.type !== 'end' || frame.outcome?.kind !== 'committed') continue
    const settlement = settlementBySeq.get(frame.outcome.seq)
    if (settlement === undefined) continue
    const data = settlement.data
    const classification = settlementClassification(settlement.type, data)
    accumulator.acceptSettlementIdentity({
      attemptId: frame.attemptId,
      turn: data.turn ?? null,
      step: data.step ?? null,
      usage: data.usage && Number.isFinite(data.usage.outputTokens) ? data.usage : null,
      usageSource: data.usage ? 'assistant-settlement' : null,
      ...classification,
      interrupted: data.interrupted === true,
      settledAtMs: settlement.time,
      seq: settlement.seq,
      eventType: settlement.type,
    })
  }

  return { sessionId, turn, accumulator, durableEvents }
}

/**
 * Path A, reduced to the settled metric view through the shared engine.
 */
export function liveSettledView(fixture, options = {}) {
  const { sessionId, turn, accumulator } = runLivePath(fixture, options)
  const store = new TurnTelemetryStore()
  const turnStart = accumulator.turnStartMs
  const record = store.beginTurn({ sessionId, turn, timeMs: turnStart })

  for (const attempt of accumulator.attemptList()) {
    const stored = store.beginAttempt(record, {
      attemptId: attempt.attemptId,
      step: attempt.step,
      startedAtMs: attempt.startedAtMs,
    })
    for (const entry of attempt.chunks) {
      store.acceptChunk(record, stored, { timeMs: entry.timeMs, chunk: entry.chunk })
    }
    if (attempt.usage !== null) store.setAttemptUsage(stored, attempt.usage, attempt.usageSource)
    store.settleAttempt(stored, {
      settledAtMs: attempt.settledAtMs,
      settlementKind: attempt.settlementKind,
      surfaceCommitted: attempt.surfaceCommitted,
      attemptOutcome: attempt.attemptOutcome,
      usage: attempt.usage,
      usageSource: attempt.usageSource,
      settlementSeq: attempt.settlementSeq,
    })
  }
  for (const tool of accumulator.toolList()) {
    store.toolStarted(record, { callId: tool.callId, name: tool.name, timeMs: tool.startMs })
    if (tool.endMs !== undefined) store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status })
  }

  const endEvent = accumulator.turnEndMs
  const settled = store.endTurn(record, {
    timeMs: endEvent,
    status: accumulator.status ?? 'completed',
    statusNote: accumulator.statusNote,
  })

  return {
    sessionId,
    turn,
    record,
    settled,
    accumulator,
    /** Convenience alias for the three-axis quality of the settled view. */
    quality: settled.quality,
    /** Live-plane defects, which must not silently vanish into a number. */
    issues: accumulator.issues,
    attemptIssues: accumulator.attemptList().map(attempt => ({ attemptId: attempt.attemptId, issues: attempt.issues })),
  }
}

/**
 * Path B: durable reconstruction, reduced through the same engine.
 */
export function durableSettledView(fixture) {
  const sessionId = fixture.sessionId
  const events = fixture.durable.map(row => row.event)
  const turn = events.find(event => event.type === 'turn/start')?.data.turn ?? null
  const reconstructed = reconstructFromDurable({ sessionId, turn, events })

  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId, turn, timeMs: reconstructed.turnStartMs })
  for (const attempt of reconstructed.attempts) {
    // The durable plane has no attempt identity, so a deterministic one is
    // derived from the settlement sequence. It is used only as a store key and
    // is excluded from cross-path comparison.
    const attemptId = `settlement:${attempt.settlementSeq}`
    const stored = store.beginAttempt(record, { attemptId, step: attempt.step, startedAtMs: attempt.startedAtMs })
    for (const entry of attempt.chunks) {
      store.acceptChunk(record, stored, { timeMs: entry.timeMs, chunk: entry.chunk })
    }
    if (attempt.usage !== null) store.setAttemptUsage(stored, attempt.usage, attempt.usageSource)
    store.settleAttempt(stored, {
      settledAtMs: attempt.settledAtMs,
      settlementKind: attempt.settlementKind,
      surfaceCommitted: attempt.surfaceCommitted,
      attemptOutcome: attempt.attemptOutcome,
      usage: attempt.usage,
      usageSource: attempt.usageSource,
      settlementSeq: attempt.settlementSeq,
    })
  }
  for (const tool of reconstructed.tools) {
    store.toolStarted(record, { callId: tool.callId, name: tool.name, timeMs: tool.startMs })
    if (tool.endMs !== undefined) store.toolSettled(record, { callId: tool.callId, timeMs: tool.endMs, status: tool.status })
  }

  const settled = store.endTurn(record, {
    timeMs: reconstructed.turnEndMs,
    status: reconstructed.status ?? 'completed',
    statusNote: reconstructed.statusNote,
  })

  return {
    sessionId,
    turn,
    record,
    settled,
    reconstructed,
    /** Convenience alias for the three-axis quality of the settled view. */
    quality: settled.quality,
    issues: reconstructed.issues,
  }
}

/**
 * One attempt's phase segmentation, as a comparable value.
 *
 * Reads the decoded chunk stream when it is available and the normalized
 * samples otherwise, so the same helper works on a store attempt (which keeps
 * samples) and on a decoded attempt (which keeps chunks). Segment boundaries
 * come straight from delta timestamps, so this is an exact quantity: if it
 * differs between paths, one path lost or reordered deltas.
 */
export function phaseSegments(attempt) {
  const entries = Array.isArray(attempt?.chunks) && attempt.chunks.length > 0
    ? attempt.chunks.map(entry => ({ timeMs: entry.timeMs, phase: phaseOf(entry.chunk), text: textOf(entry.chunk) }))
    : (attempt?.samples ?? []).map(sample => ({ timeMs: sample.timeMs, phase: sample.phase, text: '' }))

  const segments = []
  for (const entry of entries) {
    if (entry.phase === null || entry.phase === undefined) continue
    const last = segments.at(-1)
    if (last !== undefined && last.phase === entry.phase) {
      last.deltaCount += 1
      last.endMs = entry.timeMs
      last.bytes += entry.text.length
    } else {
      segments.push({ phase: entry.phase, startMs: entry.timeMs, endMs: entry.timeMs, deltaCount: 1, bytes: entry.text.length })
    }
  }
  return segments
}

function phaseOf(chunk) {
  if (chunk?.type === 'reasoning-delta' && chunk.text !== '') return 'reasoning'
  if (chunk?.type === 'text-delta' && chunk.text !== '') return 'output'
  if (chunk?.type === 'tool-call-delta' && (chunk.argumentsDelta !== '' || chunk.name !== undefined)) return 'output'
  return null
}

function textOf(chunk) {
  if (chunk?.type === 'reasoning-delta' || chunk?.type === 'text-delta') return chunk.text ?? ''
  if (chunk?.type === 'tool-call-delta') return chunk.argumentsDelta ?? ''
  return ''
}

/** Compressed chart coordinates plus both rolling series and their peak. */
export function chartView(attempts) {
  const compressed = compressAttempts(attempts)
  const reasoning = rollingTpsSeries(compressed.samples, { phase: 'reasoning', durationMs: compressed.durationMs })
  const output = rollingTpsSeries(compressed.samples, { phase: 'output', durationMs: compressed.durationMs })
  return {
    durationMs: compressed.durationMs,
    segments: compressed.segments,
    coordinates: compressed.samples.map(sample => ({
      activeTimeMs: sample.activeTimeMs,
      phase: sample.phase,
    })),
    /**
     * Attempt boundary positions on the compressed clock. The two paths name
     * attempts differently — the transient plane carries DSH's real
     * `attemptId`, the durable log carries none — so identity is compared
     * separately and only these coordinates are compared positionally.
     */
    segmentOffsets: compressed.segments.map(segment => `${segment.startMs}-${segment.endMs}`),
    reasoning,
    output,
    peakTps: peakTps(reasoning, output),
  }
}

/**
 * The full comparable metric tuple for one settled view.
 *
 * TPS values and chart coordinates derived from shape weights are compared with
 * `TPS_TOLERANCE`; everything else is compared exactly.
 */
export function metricTuple(view) {
  const { settled } = view
  const attempts = view.record.attempts
  return {
    status: settled.status,
    ttftMs: settled.ttftMs,
    turnElapsedMs: settled.turnElapsedMs,
    generatedTokens: settled.generatedTokens,
    observedGeneratedTokens: settled.observedGeneratedTokens,
    reasoningTokens: settled.reasoningTokens,
    nonReasoningTokens: settled.nonReasoningTokens,
    reasoningTps: settled.reasoningTps,
    outputTps: settled.outputTps,
    reasoningMs: settled.reasoningMs,
    outputMs: settled.outputMs,
    attemptCount: settled.attemptCount,
    contributingAttemptCount: settled.contributingAttemptCount,
    usageComplete: settled.usageComplete,
    splitComplete: settled.splitComplete,
    quality: settled.quality,
    toolWorkMs: settled.tools.workMs,
    toolWallMs: settled.tools.wallMs,
    toolCount: settled.tools.completedCount,
    toolRunningCount: settled.tools.runningCount,
    toolNames: settled.tools.names.join(','),
    /** Tool name per call, in call order; 'pwsh,pwsh' is two distinct calls. */
    toolNameSequence: view.record.tools.map(call => call.name).join(','),
    /** Per-call durations, taken from the record so the pair order is visible. */
    toolDurations: view.record.tools
      .map(call => (Number.isFinite(call.endMs) ? call.endMs - call.startMs : null))
      .join(','),
    toolCallIds: view.record.tools.map(call => call.callId).join(','),
    toolErrorCount: settled.tools.failedCount,
    /**
     * Model-generated tool-call argument bytes. Measured from the decoded
     * chunks in path B and from the accepted transient frames in path A, so it
     * is a genuine cross-path check that tool arguments belong to output.
     */
    toolArgumentBytes: chunksOf(view).reduce((sum, entry) => (
      entry.chunk?.type === 'tool-call-delta' ? sum + (entry.chunk.argumentsDelta?.length ?? 0) : sum
    ), 0),
    /** Same accounting for ordinary visible text. */
    textBytes: chunksOf(view).reduce((sum, entry) => (
      entry.chunk?.type === 'text-delta' ? sum + (entry.chunk.text?.length ?? 0) : sum
    ), 0),
    attempts: attempts.map(attempt => ({
      step: attempt.step,
      /**
       * The three attempt-settlement concepts kept separate: settlement kind,
       * surface visibility, execution outcome. A path that fabricated
       * `abandoned` from `assistant/attempt` would differ here.
       */
      settlement: `${attempt.settlementKind ?? 'none'}/${attempt.surfaceCommitted === true}/${attempt.attemptOutcome ?? 'unknown'}`,
      sampleCount: attempt.sampleCount,
      reasoningMs: attempt.reasoningMs,
      outputMs: attempt.outputMs,
      phases: phaseSegments(attempt),
      usage: attempt.usage,
    })),
    chart: chartView(attempts),
  }
}

/** Every decoded chunk behind one view, whichever path produced it. */
export function chunksOf(view) {
  if (view.accumulator !== undefined) {
    return view.accumulator.attemptList().flatMap(attempt => attempt.chunks)
  }
  if (view.reconstructed !== undefined) {
    return view.reconstructed.attempts.flatMap(attempt => attempt.chunks)
  }
  return []
}

/**
 * Structural comparison of two metric tuples.
 *
 * @returns {{exact: object[], tolerant: object[], semantic: object[]}}
 */
export function compareTuples(a, b) {
  const exact = []
  const tolerant = []
  const semantic = []

  const same = (path, left, right) => {
    const equal = Object.is(left, right)
    const record = { path, left, right, equal }
    if (!equal) semantic.push(record)
    else exact.push(record)
  }
  const close = (path, left, right, tolerance) => {
    const record = { path, left, right, tolerance }
    if (typeof left !== 'number' || typeof right !== 'number') {
      record.equal = Object.is(left, right)
      if (!record.equal) semantic.push(record)
      else exact.push(record)
      return
    }
    record.delta = Math.abs(left - right)
    record.equal = record.delta <= tolerance
    if (record.equal) tolerant.push(record)
    else semantic.push(record)
  }

  same('status', a.status, b.status)
  same('attemptCount', a.attemptCount, b.attemptCount)
  same('contributingAttemptCount', a.contributingAttemptCount, b.contributingAttemptCount)
  same('usageComplete', a.usageComplete, b.usageComplete)
  same('splitComplete', a.splitComplete, b.splitComplete)
  same('generatedTokens', a.generatedTokens, b.generatedTokens)
  same('observedGeneratedTokens', a.observedGeneratedTokens, b.observedGeneratedTokens)
  same('reasoningTokens', a.reasoningTokens, b.reasoningTokens)
  same('nonReasoningTokens', a.nonReasoningTokens, b.nonReasoningTokens)
  same('ttftMs', a.ttftMs, b.ttftMs)
  same('turnElapsedMs', a.turnElapsedMs, b.turnElapsedMs)
  same('reasoningMs', a.reasoningMs, b.reasoningMs)
  same('outputMs', a.outputMs, b.outputMs)
  same('toolWorkMs', a.toolWorkMs, b.toolWorkMs)
  same('toolWallMs', a.toolWallMs, b.toolWallMs)
  same('toolCount', a.toolCount, b.toolCount)
  same('toolRunningCount', a.toolRunningCount, b.toolRunningCount)
  same('toolErrorCount', a.toolErrorCount, b.toolErrorCount)
  same('toolNames', a.toolNames, b.toolNames)
  same('toolNameSequence', a.toolNameSequence, b.toolNameSequence)
  same('toolDurations', a.toolDurations, b.toolDurations)
  same('toolCallIds', a.toolCallIds, b.toolCallIds)
  same('toolArgumentBytes', a.toolArgumentBytes, b.toolArgumentBytes)
  same('textBytes', a.textBytes, b.textBytes)
  same('chart.durationMs', a.chart.durationMs, b.chart.durationMs)
  same('chart.segmentCount', a.chart.segments.length, b.chart.segments.length)
  same('chart.segmentOffsets', a.chart.segmentOffsets.join(','), b.chart.segmentOffsets.join(','))
  same('chart.coordinateCount', a.chart.coordinates.length, b.chart.coordinates.length)
  same('chart.coordinates', hashOf(a.chart.coordinates), hashOf(b.chart.coordinates))
  same('quality.tokenTotalQuality', a.quality.tokenTotalQuality, b.quality.tokenTotalQuality)
  same('quality.phaseSplitQuality', a.quality.phaseSplitQuality, b.quality.phaseSplitQuality)
  same('quality.temporalShapeQuality', a.quality.temporalShapeQuality, b.quality.temporalShapeQuality)

  same('attempts.segmentation', describeSegments(a.attempts), describeSegments(b.attempts))
  same('attempts.sampleCounts', a.attempts.map(x => x.sampleCount).join(','), b.attempts.map(x => x.sampleCount).join(','))
  same('attempts.settlements', a.attempts.map(x => x.settlement).join(','), b.attempts.map(x => x.settlement).join(','))
  same('attempts.usage', describeUsage(a.attempts), describeUsage(b.attempts))
  same('attempts.reasoningMs', a.attempts.map(x => x.reasoningMs).join(','), b.attempts.map(x => x.reasoningMs).join(','))
  same('attempts.outputMs', a.attempts.map(x => x.outputMs).join(','), b.attempts.map(x => x.outputMs).join(','))

  close('reasoningTps', a.reasoningTps, b.reasoningTps, TPS_TOLERANCE)
  close('outputTps', a.outputTps, b.outputTps, TPS_TOLERANCE)
  close('chart.peakTps', a.chart.peakTps, b.chart.peakTps, TPS_TOLERANCE)
  close('chart.reasoning.integral', integral(a.chart.reasoning), integral(b.chart.reasoning), 1e-6)
  close('chart.output.integral', integral(a.chart.output), integral(b.chart.output), 1e-6)
  same('chart.seriesLengths', `${a.chart.reasoning.length},${a.chart.output.length}`, `${b.chart.reasoning.length},${b.chart.output.length}`)

  return { exact, tolerant, semantic }
}

function integral(series) {
  if (!Array.isArray(series) || series.length === 0) return null
  let sum = 0
  for (const point of series) sum += point.tps ?? 0
  return sum
}

/** Short stable digest, so a mismatch prints a diffable value instead of a wall of JSON. */
function hashOf(value) {
  const text = JSON.stringify(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return `${text.length}:${hash.toString(16)}`
}

function describeSegments(attempts) {
  return attempts
    .map(attempt => attempt.phases.map(segment => `${segment.phase}@${segment.deltaCount}`).join('>'))
    .join('|')
}

function describeUsage(attempts) {
  return attempts
    .map(attempt => (attempt.usage === null
      ? 'none'
      : `${attempt.usage.outputTokens}/${attempt.usage.reasoningTokens ?? 'na'}`))
    .join(',')
}

/** Phase durations from the raw decoded chunks, independent of the engine. */
export function phaseDurationsFromChunks(attempt) {
  const samples = []
  for (const entry of attempt.chunks ?? []) {
    const phase = phaseOf(entry.chunk)
    if (phase === null) continue
    samples.push({ timeMs: entry.timeMs, phase })
  }
  return attributePhaseDurations(samples)
}

export { settlementChronology, turnEndStatus }
