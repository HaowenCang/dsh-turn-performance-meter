/**
 * DSH adapter layer.
 *
 * The single responsibility of this directory is to translate **verified DSH
 * 0.1.5-rc.2 raw evidence** into this project's normalized engine events. No
 * other layer may know about DSH field names:
 *
 *   src/core   pure statistics, zero `@deepseek-ai/*` imports
 *   src/dsh    raw evidence  ->  normalized events   (this directory)
 *   src/host   in-memory store over normalized events
 *   src/client presentation only
 *
 * Evidence locations for every shape handled here are recorded in
 * `docs/IMPLEMENTATION_LOG.md`. Where DSH's runtime and DSH's published notes
 * disagree, the installed runtime wins and the divergence is logged.
 */

export {
  DSH_RAW_KIND,
  classifyRawEntry,
  isAssistantStreamFrame,
  isDurableSessionEventEntry,
  isTransientLiveChunkEntry,
  sessionKeyOf,
} from './raw.js'

export {
  DECODE_ISSUE,
  RECORD_KIND,
  SETTLEMENT_EVENT_TYPES,
  decodeQuality,
  decodeStreamRecords,
  expandAssistantStream,
  expandAssistantStreamRaw,
  firstTokenTimeOf,
} from './stream-decoder.js'

export {
  ATTEMPT_OUTCOME,
  NORMALIZED_KIND,
  SETTLEMENT_KIND,
  applyRetryOutcomes,
  attemptEvidenceQuality,
  attemptFromDecoded,
  normalizeDurableEvent,
  normalizeLiveChunk,
  normalizeStreamFrame,
  settlementClassification,
  transientEndClassification,
  turnEndStatus,
} from './adapter.js'

export {
  FRAME_ISSUE,
  LiveTurnAccumulator,
  accumulateLive,
} from './live-path.js'

export { reconstructFromDurable, settlementChronology } from './durable-path.js'
