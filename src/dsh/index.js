/**
 * DSH adapter layer.
 *
 * The single responsibility of this directory is to translate **verified DSH
 * 0.1.7-rc.2 raw evidence** into this project's normalized engine events. No
 * other layer may know about DSH field names:
 *
 *   src/core   pure statistics, zero `@deepseek-ai/*` imports
 *   src/dsh    raw evidence  ->  normalized events   (this directory)
 *   src/host   in-memory store over normalized events
 *   src/client presentation only
 *
 * ## Compatibility baseline (changed in Phase 7D)
 *
 * The target runtime is `@deepseek-ai/dsh` **0.1.7-rc.2**, public reference
 * commit `477b4f420553e8a52c2fbccc464d7561b239c443`, as installed locally at
 * `%APPDATA%/npm/node_modules/@deepseek-ai/dsh`. The 0.1.5-rc.2 line is **not**
 * the contract any more. Where the two differ, the local install wins and the
 * divergence is recorded in `docs/IMPLEMENTATION_LOG.md`; the field-by-field
 * comparison lives in `docs/DSH_API_NOTES.md` §13.
 *
 * Evidence locations for every shape handled here are recorded in
 * `docs/IMPLEMENTATION_LOG.md`.
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
  TOOL_RESULT_SHAPE,
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
