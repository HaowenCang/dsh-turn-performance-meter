/**
 * Public surface of the pure metric engine.
 *
 * The browser half and the telemetry store both import from here, so no formula
 * can exist in two places. Nothing in this directory imports DSH: the client
 * bundle cannot require `@deepseek-ai/dsh-llm` or `@deepseek-ai/dsh-session`
 * (neither declares a `dsh.client` manifest), and keeping the engine free of DSH
 * imports is also what lets it be tested without a DSH runtime.
 */

export { MetricQuality, isMetricQuality, rateQuality, weakestQuality } from './metric-quality.js'

export {
  QUALITY_AXIS,
  QUALITY_CEILING,
  QualityLevel,
  clampToAxis,
  isQualityLevel,
  phaseSplitQuality,
  qualityAxes,
  requiresApproximateMarker,
  temporalShapeQuality,
  tokenTotalQuality,
  weakestLevel,
} from './quality-model.js'

export {
  DECODE_ISSUE,
  MODEL_PHASE,
  classifyDelta,
  decodeAssistantStream,
  deltaText,
  expandAssistantStream,
  firstTokenTime,
  isTokenDelta,
  usageFromChunk,
} from './delta-accounting.js'

export { PHASE, attributePhaseDurations } from './phase-duration.js'

export {
  calibrateAttemptSamples,
  calibratePhase,
  heuristicTokenWeight,
  sampleFromChunk,
  samplesFromTimedChunks,
} from './token-allocation.js'

export { SlidingWindowMeter } from './sliding-window.js'

export { LiveMeter, LivePhase } from './live-metrics.js'

export { summarizeToolCalls, unionDurationMs } from './tool-timing.js'

export { compressAttempts } from './time-axis.js'

export {
  DEFAULT_MAX_POINTS,
  DEFAULT_SAMPLE_EVERY_MS,
  DEFAULT_WINDOW_MS,
  MAX_RENDER_POINTS_TOTAL,
  MIN_MAX_POINTS,
  allocateRunBudgets,
  attemptTrace,
  attemptTraces,
  downsampleRun,
  downsampleSeries,
  minimumRunCost,
  peakTps,
  phaseRuns,
  phaseSpans,
  totalRollingTpsSeries,
  visualRunsOf,
} from './curve.js'

export { curveSource } from './curve-source.js'

export { aggregateTurn, isContributingAttempt, normalizeUsage, reduceAttempt } from './aggregate-turn.js'

export { TURN_STATUS, TurnPhase, initialTurnState, reduceTurnState, settleFromTurnEndReason } from './turn-state.js'

export { turnKey } from './types.js'
