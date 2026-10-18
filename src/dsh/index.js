/**
 * DSH adapter layer.
 *
 * The single responsibility of this directory is to translate **verified DSH
 * 0.2.1-rc.2 raw evidence** into this project's normalized engine events. No
 * other layer may know about DSH field names:
 *
 *   src/core   pure statistics, zero `@deepseek-ai/*` imports
 *   src/dsh    raw evidence  ->  normalized events   (this directory)
 *   src/host   in-memory store over normalized events
 *   src/client presentation only
 *
 * ## Compatibility baseline (moved to 0.2.1-rc.2 in Phase 11.0)
 *
 * The target runtime is `@deepseek-ai/dsh` **0.2.1-rc.2**, public reference
 * commit `687f282e8625c6b8d11ff58211a90524be2e4317`, installed for the isolated
 * Phase 11.0 runtime acceptance. The 0.2.0-rc.2 line (reference commit
 * `639ed015397290b3745d163aafe02ffee4aa3f84`) was the target from Phase 9.3
 * through Phase 10.1R.1; the 0.1.7-rc.2 and 0.1.5-rc.2 lines are **not** the
 * contract any more.
 *
 * Phase 11.0 re-audited every declaration this directory reads against
 * 0.2.1-rc.2. The session, event-window and assistant-stream declarations the
 * adapter consumes are byte-identical to 0.2.0-rc.2 (`contract/events.ts`,
 * `session-wire-event.ts`, `sessions/assistant-stream.ts`, `contract/session.ts`,
 * `contract/snapshot.ts`, `assistant-stream.ts`); the declarations that did
 * change add provider metadata, experimental plugin records and client slots, or
 * touch subagent/install plumbing this directory does not read. No adapter code
 * moved. The "0.1.7-rc.2" references that remain in the modules below are the
 * dates of the audits that established each shape — recorded evidence that
 * occurred on that version — not stale targets. The comparison lives in
 * `docs/DSH_API_NOTES.md` §15.
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
