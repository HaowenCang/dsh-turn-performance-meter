/**
 * Durable `AssistantStreamRecord` decoder — the DSH-facing surface.
 *
 * The decoding rules themselves live in `src/core/delta-accounting.js`
 * (`decodeAssistantStream` / `expandAssistantStream`) so that exactly one
 * implementation of the rule exists and `src/core` stays free of DSH imports.
 * This module adds only what is DSH-specific: locating the record array inside
 * a settlement payload, and turning decoder issues into this project's
 * quality vocabulary.
 *
 * What a successful decode guarantees, and therefore what the durable
 * reconstruction path is allowed to assume:
 *
 *   - every delta of the attempt, in logical stream order;
 *   - each delta's exact reconstructed wall-clock time, hence the exact gap
 *     (`dt`) to its predecessor;
 *   - the phase of each delta: `text-delta` and `tool-call-delta` are output,
 *     `reasoning-delta` is reasoning;
 *   - the block boundaries, because `block-start`/`block-end` are never packed
 *     into runs and therefore survive as raw `chunk` records;
 *   - the in-stream `usage` chunk and the `finish` chunk, likewise raw.
 *
 * When any record is malformed the decode reports it and marks itself
 * incomplete. It never invents a delta and never silently drops one: a stream
 * that lost a record yields a *lower quality* observation, which is a different
 * claim from an exact one.
 */

import {
  DECODE_ISSUE,
  decodeAssistantStream,
  expandAssistantStream,
  firstTokenTime,
  isTokenDelta,
} from '../core/delta-accounting.js'
import { MetricQuality } from '../core/metric-quality.js'

/** Chunk kinds a decoded stream can carry, in the vocabulary the core uses. */
export const RECORD_KIND = Object.freeze({
  DELTA: 'delta',
  RAW: 'raw',
})

/** Event types that settle one attempt and embed its stream. */
export const SETTLEMENT_EVENT_TYPES = Object.freeze(['assistant/message', 'assistant/attempt'])

/** How much of the stream survived decoding, as a metric-quality value. */
export function decodeQuality(result) {
  if (!result || result.recordCount === 0) return MetricQuality.UNAVAILABLE
  if (result.deltaCount === 0 && result.recordCount > 0) return MetricQuality.UNAVAILABLE
  return result.complete ? MetricQuality.EXACT : MetricQuality.ESTIMATED
}

/**
 * Decode the compact records of one durable settlement.
 *
 * @param {unknown} records `assistant/message.stream` or `assistant/attempt.stream`
 * @param {{maxIssues?:number}} [options]
 * @returns {{
 *   chunks: {timeMs:number, chunk:object, recordIndex:number, memberIndex:number}[],
 *   issues: object[],
 *   issuesTruncated: boolean,
 *   recordCount: number,
 *   decodedRecordCount: number,
 *   deltaCount: number,
 *   firstTimeMs: number|null,
 *   lastTimeMs: number|null,
 *   complete: boolean,
 *   quality: string,
 *   generatedChunkCount: number,
 *   firstTokenTimeMs: number|null,
 * }}
 */
export function decodeStreamRecords(records, options = {}) {
  const result = decodeAssistantStream(records, options)
  return decorate(result)
}

/**
 * Tolerant decode for the live path.
 *
 * The transient plane arrives one frame at a time and a rebaseline can hand the
 * client a compact prefix mid-attempt, so the tolerant reader is the right one
 * there: losing one curve segment beats losing the meter. It reports the same
 * issue vocabulary by re-deriving it, so a caller can tell the two apart.
 */
export function expandAssistantStreamRaw(records) {
  const tolerant = expandAssistantStream(records)
  const strict = decodeAssistantStream(records, { maxIssues: 50 })
  const chunks = tolerant.map((entry, index) => ({
    timeMs: entry.timeMs,
    chunk: entry.chunk,
    recordIndex: -1,
    memberIndex: index,
  }))
  const times = chunks.map(entry => entry.timeMs)
  return decorate({
    chunks,
    issues: strict.issues,
    issuesTruncated: strict.issuesTruncated,
    recordCount: strict.recordCount,
    decodedRecordCount: strict.decodedRecordCount,
    deltaCount: strict.deltaCount,
    firstTimeMs: times.length > 0 ? Math.min(...times) : null,
    lastTimeMs: times.length > 0 ? Math.max(...times) : null,
    complete: strict.complete,
  })
}

function decorate(result) {
  const generated = result.chunks.filter(entry => isTokenDelta(entry.chunk))
  return {
    ...result,
    quality: decodeQuality(result),
    generatedChunkCount: generated.length,
    firstTokenTimeMs: firstTokenTime(result.chunks),
  }
}

/** Time of the first member this project counts as a generated first token. */
export function firstTokenTimeOf(chunks) {
  return firstTokenTime(chunks)
}

export { DECODE_ISSUE, expandAssistantStreamRaw as expandAssistantStream }
