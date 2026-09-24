/**
 * Durable (settlement) reconstruction path — path B.
 *
 * Path B reads only what survives a reload: the durable session log. It takes
 * turn and step boundaries, tool call/result pairs, and, for every attempt, the
 * compact `AssistantStreamRecord[]` embedded in its settlement, which it
 * decodes with the strict decoder. It never consults a transient frame.
 *
 * The point of path B is that a completed turn's card must be reconstructible
 * from the durable log alone. If the two paths disagree on a settled turn, the
 * live path is the one that is wrong, because only the durable log is replayable
 * evidence.
 */

import { isTokenDelta } from '../core/delta-accounting.js'
import { heuristicTokenWeight, sampleFromChunk } from '../core/token-allocation.js'
import { applyRetryOutcomes, settlementClassification, turnEndStatus } from './adapter.js'
import { decodeStreamRecords } from './stream-decoder.js'

/**
 * Reconstruct a turn from durable events.
 *
 * @param {{
 *   sessionId: string,
 *   turn: number,
 *   events: readonly object[],
 *   estimate?: Function,
 * }} input
 */
export function reconstructFromDurable({ sessionId, turn, events = [], estimate }) {
  const ordered = [...events]
    .filter(event => event && typeof event === 'object' && typeof event.type === 'string')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

  const result = {
    sessionId: sessionId ?? null,
    turn: turn ?? null,
    turnStartMs: null,
    turnEndMs: null,
    status: null,
    statusNote: null,
    statusKnown: null,
    endReason: null,
    attempts: [],
    tools: [],
    steps: new Map(),
    issues: [],
    ignoredEventCount: 0,
    /** Scheduled durable retries (`llm/retry`), for attempt-outcome correlation. */
    retries: [],
    /** Raw evidence retained for auditing: the settlements exactly as recorded. */
    settlements: [],
  }

  const toolByCallId = new Map()
  const toolOrder = []

  for (const event of ordered) {
    const data = event.data ?? {}
    if (data.turn !== undefined && data.turn !== turn) continue
    switch (event.type) {
      case 'turn/start':
        result.turnStartMs = result.turnStartMs === null ? event.time : Math.min(result.turnStartMs, event.time)
        break
      case 'turn/end': {
        const mapped = turnEndStatus(data.reason)
        result.turnEndMs = event.time
        result.status = mapped.status
        result.statusNote = mapped.note
        result.statusKnown = mapped.known
        result.endReason = data.reason ?? null
        break
      }
      case 'step/start': {
        const step = result.steps.get(data.step) ?? { step: data.step, startMs: null, endMs: null }
        step.startMs = step.startMs === null ? event.time : Math.min(step.startMs, event.time)
        result.steps.set(data.step, step)
        break
      }
      case 'step/end': {
        const step = result.steps.get(data.step) ?? { step: data.step, startMs: null, endMs: null }
        step.endMs = event.time
        result.steps.set(data.step, step)
        break
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const decoded = decodeStreamRecords(data.stream)
        const issues = decoded.issues.map(issue => ({ ...issue, where: 'durable-stream', seq: event.seq }))
        result.issues.push(...issues)
        const durableUsage = data.usage && typeof data.usage === 'object' && Number.isFinite(data.usage.outputTokens)
          ? data.usage
          : null
        const inStreamUsage = durableUsage === null ? lastUsageChunk(decoded) : null
        const attempt = {
          attemptId: null,
          turn: data.turn ?? turn,
          step: data.step ?? null,
          ...settlementClassification(event.type, data),
          samples: [],
          chunks: decoded.chunks,
          decoded,
          usage: durableUsage ?? inStreamUsage,
          usageSource: durableUsage !== null ? 'assistant-settlement' : (inStreamUsage !== null ? 'in-stream-usage-chunk' : null),
          startedAtMs: null,
          settledAtMs: event.time,
          settlementSeq: event.seq,
          settlementEventType: event.type,
          interrupted: data.interrupted === true,
          issues,
          streamQuality: decoded.quality,
        }
        if (estimate !== undefined) {
          attempt.samples = samplesFromChunks(decoded.chunks, estimate)
        } else {
          attempt.samples = samplesFromChunks(decoded.chunks)
        }
        result.attempts.push(attempt)
        result.settlements.push({
          seq: event.seq,
          time: event.time,
          type: event.type,
          turn: data.turn,
          step: data.step,
          usage: durableUsage,
          interrupted: data.interrupted === true,
          recordCount: decoded.recordCount,
          deltaCount: decoded.deltaCount,
          streamQuality: decoded.quality,
        })
        break
      }
      case 'llm/retry':
        result.retries.push({
          kind: 'retry-scheduled',
          seq: event.seq,
          timeMs: event.time,
          turn: data.turn,
          step: data.step,
          retryId: typeof data.retryId === 'string' ? data.retryId : null,
          retry: Number.isFinite(data.retry) ? data.retry : null,
        })
        break
      case 'tool/call': {
        if (typeof data.callId !== 'string') {
          result.issues.push({ kind: 'tool-call-without-call-id', seq: event.seq })
          break
        }
        const record = toolByCallId.get(data.callId) ?? {
          callId: data.callId,
          name: data.name ?? null,
          startMs: event.time,
          status: 'running',
          argumentsRaw: data.arguments ?? null,
          step: data.step ?? null,
        }
        record.startMs = Math.min(record.startMs, event.time)
        if (typeof data.name === 'string') record.name = data.name
        toolByCallId.set(data.callId, record)
        if (!toolOrder.includes(data.callId)) toolOrder.push(data.callId)
        break
      }
      case 'tool/result': {
        const callId = Array.isArray(data.message?.content) ? data.message.content[0]?.toolCallId ?? null : null
        if (callId === null) {
          result.issues.push({ kind: 'tool-result-without-call-id', seq: event.seq })
          break
        }
        const record = toolByCallId.get(callId)
        if (record === undefined) {
          result.issues.push({ kind: 'unmatched-tool-result', seq: event.seq, callId })
          break
        }
        const block = data.message.content[0]
        record.endMs = event.time
        record.status = data.error !== undefined || block?.isError === true ? 'error' : 'ok'
        record.errorName = data.error?.name ?? null
        break
      }
      default:
        result.ignoredEventCount += 1
    }
  }

  result.tools = toolOrder.map(callId => toolByCallId.get(callId))
  for (const record of result.tools) {
    if (record.endMs === undefined) {
      result.issues.push({ kind: 'unmatched-tool-call', callId: record.callId, name: record.name })
    }
  }

  // Attempt order is settlement order, which is step order for a normal turn.
  result.attempts.sort((a, b) => (a.settlementSeq ?? 0) - (b.settlementSeq ?? 0))
  // An `assistant/attempt` outcome is `unknown` until a durable `llm/retry`
  // proves it was retried; the correlation runs after every settlement is in
  // place so ordering inside the log cannot hide the pairing.
  applyRetryOutcomes(result.attempts, result.retries)
  return result
}

function lastUsageChunk(decoded) {
  for (let index = decoded.chunks.length - 1; index >= 0; index -= 1) {
    const chunk = decoded.chunks[index].chunk
    if (chunk?.type === 'usage' && chunk.usage && Number.isFinite(chunk.usage.outputTokens)) return chunk.usage
  }
  return null
}

function samplesFromChunks(chunks, estimate = heuristicTokenWeight) {
  const samples = []
  for (const entry of chunks) {
    const sample = sampleFromChunk(entry.timeMs, entry.chunk, estimate)
    if (sample !== null) samples.push(sample)
  }
  return samples
}

/**
 * Settlement chronology for one turn, in durable order.
 *
 * This is the raw material of the generation-tail measurement: it pairs the
 * last non-empty model-producing delta of an attempt with the wall-clock time
 * at which DSH committed that attempt's settlement.
 */
export function settlementChronology(turnRecord) {
  return turnRecord.attempts.map(attempt => ({
    settlementSeq: attempt.settlementSeq,
    settlementEventType: attempt.settlementEventType,
    settlementTimeMs: attempt.settledAtMs,
    turn: attempt.turn,
    step: attempt.step,
    usage: attempt.usage,
    interrupted: attempt.interrupted,
    streamQuality: attempt.streamQuality,
    lastDeltaTimeMs: lastGeneratedDeltaTime(attempt.chunks),
    firstDeltaTimeMs: firstGeneratedDeltaTime(attempt.chunks),
    deltaCount: attempt.decoded?.deltaCount ?? 0,
  }))
}

function lastGeneratedDeltaTime(chunks) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (isTokenDelta(chunks[index].chunk)) return chunks[index].timeMs
  }
  return null
}

function firstGeneratedDeltaTime(chunks) {
  for (const entry of chunks) {
    if (isTokenDelta(entry.chunk)) return entry.timeMs
  }
  return null
}
