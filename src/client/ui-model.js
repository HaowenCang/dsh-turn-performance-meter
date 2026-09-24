/**
 * Pure view-model shaping.
 *
 * Keeping this layer pure means the component tree contains no statistics and no
 * transport knowledge, so screenshots and component tests are independent of
 * DSH. The inputs are the snapshots produced by `src/core/live-metrics.js` and
 * the settled turn record from `src/host/telemetry-design.js`.
 *
 * The completed half of this module is the **only** seam between the settled
 * snapshot and the completed card: quality, approximate markers, em-dash
 * fallbacks and every displayed string are decided here, so the React component
 * renders fields instead of interpreting statistics.
 */

import { MetricQuality, weakestQuality } from '../core/metric-quality.js'
import { QualityLevel, requiresApproximateMarker } from '../core/quality-model.js'
import { formatSeconds, formatTps, formatTokens, DASH } from './format.js'

/** Shared shape for a value that may legitimately be absent. */
function value(value, quality) {
  return { value: value ?? null, quality: quality ?? MetricQuality.UNAVAILABLE, available: value !== null && value !== undefined }
}

/**
 * Live branch selection. `idle` and `settled` both render nothing here: an idle
 * meter has no turn, and a settled turn belongs to the completed card.
 */
export function liveViewModel(snapshot) {
  if (!snapshot || snapshot.phase === 'idle' || snapshot.phase === 'settled') return { kind: 'hidden' }

  if (snapshot.phase === 'tool') {
    return {
      kind: 'tool',
      turn: snapshot.turn,
      runningToolCount: snapshot.runningToolCount ?? 0,
      runningToolNames: snapshot.runningToolNames ?? [],
      /** The compact label prefers a single tool name and falls back to a count. */
      label: (snapshot.runningToolCount ?? 0) === 1
        ? (snapshot.runningToolNames?.[0] ?? 'tool')
        : `Tools ${snapshot.runningToolCount ?? 0}`,
      toolElapsed: value(snapshot.toolElapsedMs ?? null, MetricQuality.EXACT),
      turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
    }
  }

  if (snapshot.phase === 'streaming') {
    return {
      kind: 'streaming',
      turn: snapshot.turn,
      activePhase: snapshot.activePhase ?? null,
      /**
       * Live TPS is a shape estimate until provider usage arrives after
       * settlement, so it is never presented as exact.
       */
      tps: value(snapshot.tps ?? null, snapshot.tpsQuality ?? MetricQuality.ESTIMATED),
      turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
    }
  }

  // Pending: turn open, no generated delta yet. The UI shows the TTFT counter.
  return {
    kind: 'ttft',
    turn: snapshot.turn,
    /** Running counter: the final TTFT is not known until the first delta lands. */
    ttft: value(snapshot.ttftMs ?? null, snapshot.ttftMs === null ? MetricQuality.ESTIMATED : MetricQuality.EXACT),
    turnElapsed: value(snapshot.turnElapsedMs ?? null, MetricQuality.EXACT),
  }
}

/**
 * Turn status as the card must present it.
 *
 * `status` is the settlement outcome derived from `turn/end`; `statusNote`
 * carries the finer fact (why it was aborted, which ceiling truncated it). The
 * truncated case is its own presentation kind because "completed" alone would
 * hide that the model stopped at a token ceiling.
 */
export function completedStatusOf(status, statusNote) {
  if (status === 'interrupted') return { kind: 'interrupted', detail: statusNote ?? null, tone: 'warn' }
  if (status === 'errored') return { kind: 'errored', detail: statusNote ?? null, tone: 'error' }
  if (statusNote === 'max-tokens') return { kind: 'max-tokens', detail: null, tone: 'warn' }
  return { kind: 'completed', detail: statusNote ?? null, tone: 'neutral' }
}

/**
 * Duration on a secondary line.
 *
 * The completed card uses the reference's one-decimal **second** scale at every
 * magnitude (`108.2s`, `133.6s`), because these lines are read against the
 * reference layout and against each other; the shared `formatDuration` helper's
 * minute form stays the live pill's format, where a running turn can be read for
 * hours and compactness matters more than comparison.
 */
function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH
  return formatSeconds(ms, 1)
}

/**
 * A duration paired with a token count on one secondary line.
 *
 * The two halves are one derivation chain, so they share one approximate
 * decision: a token count that is not measured may never be printed bare next to
 * a rate that carries `≈`. A phase with no tokens and no duration is omitted
 * rather than printed as a zero.
 */
function phaseSecondary(durationMs, tokens, approximateTokens) {
  const parts = []
  const hasDuration = Number.isFinite(durationMs) && durationMs > 0
  const hasTokens = tokens !== null && tokens !== undefined
  if (hasDuration) parts.push(durationText(durationMs))
  if (hasTokens) parts.push(`${approximateTokens ? '≈' : ''}${formatTokens(tokens)}`)
  else if (hasDuration) parts.push(DASH)
  return parts.length === 0 ? null : { kind: 'phase', text: parts.join(' · '), approximate: approximateTokens === true }
}

/**
 * One of the four principal columns.
 *
 * `display` is resolved here rather than in the component, and `format` lets a
 * column state its own unit convention: token magnitudes read through
 * three-significant-figure formatting (`345`, `54,770`), while a duration in
 * seconds is always two decimals (`1.44`), so a 1440 ms TTFT can never be
 * printed as the token-like `1,440`.
 */
function metricCell({ key, labelKey, value: metricValue, unit = null, secondary = null, approximate = false, format = formatTps }) {
  const available = metricValue.value !== null && metricValue.value !== undefined
  return {
    key,
    labelKey,
    value: metricValue.value,
    display: available ? (approximate ? `≈${format(metricValue.value)}` : format(metricValue.value)) : DASH,
    unit: available ? unit : null,
    quality: metricValue.quality,
    approximate: approximate && available,
    available,
    secondary,
  }
}

/**
 * Completed card view model.
 *
 * Four principal columns are fixed by the UI specification and always present in
 * the same order; tool statistics stay on the footer line and never become a
 * fifth column. Display quality follows the settled snapshot's three-axis model:
 *
 *   - `tokenTotalQuality === exact`  -> a bare generated-token total;
 *   - anything weaker                -> `≈` on the number it qualifies;
 *   - `phaseSplitQuality === exact`   -> bare reasoning/output rates and counts;
 *   - `unavailable`                  -> `—`, never `0`.
 */
export function completedViewModel(settled) {
  if (!settled || !['completed', 'interrupted', 'errored'].includes(settled.status)) return null

  const quality = settled.quality ?? {}
  const tokenTotalExact = quality.tokenTotalQuality === QualityLevel.EXACT
  const phaseSplitExact = quality.phaseSplitQuality === QualityLevel.EXACT

  /**
   * A partial total has a real observed sum but no complete evidence: publishing
   * the exact figure would claim coverage the turn does not have, so the partial
   * sum is shown with `≈` and the field is explicitly marked partial.
   */
  /**
   * A partial or recovered total has a real sum but no complete evidence:
   * publishing it bare would claim coverage the turn does not have, and `0` is
   * never a substitute for "not measured", so only a genuine observed sum is
   * published and it is always marked approximate.
   */
  const observed = Number.isFinite(settled.observedGeneratedTokens) ? settled.observedGeneratedTokens : 0
  const generatedValue = Number.isFinite(settled.generatedTokens)
    ? settled.generatedTokens
    : (observed > 0 ? observed : null)
  /** Only a fully authoritative total may be printed without `≈`. */
  const generatedApproximate = !tokenTotalExact

  const tools = settled.tools ?? {}
  const status = completedStatusOf(settled.status, settled.statusNote)
  const phaseTokens = settled.phaseTokens ?? { reasoning: null, output: null }
  /** Counters derived from the provider split are exact; everything else is not. */
  const phaseCountsApproximate = !phaseSplitExact

  const columns = [
    metricCell({
      key: 'reasoningTps',
      labelKey: 'colReasoningTps',
      unit: 'tokens/s',
      value: value(settled.reasoningTps ?? null, settled.reasoningTpsQuality),
      approximate: requiresApproximateMarker(settled.reasoningTpsQuality),
      secondary: phaseSecondary(settled.reasoningMs, phaseTokens.reasoning, phaseCountsApproximate),
    }),
    metricCell({
      key: 'outputTps',
      labelKey: 'colOutputTps',
      unit: 'tokens/s',
      value: value(settled.outputTps ?? null, settled.outputTpsQuality),
      approximate: requiresApproximateMarker(settled.outputTpsQuality),
      secondary: phaseSecondary(settled.outputMs, phaseTokens.output, phaseCountsApproximate),
    }),
    metricCell({
      key: 'generatedTokens',
      labelKey: 'colGeneratedTokens',
      unit: 'tokens',
      value: value(generatedValue, quality.tokenTotalQuality ?? MetricQuality.UNAVAILABLE),
      approximate: generatedApproximate,
      secondary: Number.isFinite(settled.turnElapsedMs)
        ? { kind: 'elapsed', labelKey: 'elapsed', ms: settled.turnElapsedMs, display: durationText(settled.turnElapsedMs) }
        : null,
    }),
    metricCell({
      key: 'ttft',
      labelKey: 'colTtft',
      unit: 's',
      value: value(settled.ttftMs ?? null, MetricQuality.EXACT),
      /** Bare two-decimal seconds; the `s` unit is rendered by the column. */
      format: milliseconds => Number.isFinite(milliseconds) ? (milliseconds / 1000).toFixed(2) : DASH,
      secondary: { kind: 'status', statusKey: `status.${status.kind}`, detail: status.detail, tone: status.tone },
    }),
  ]

  return {
    kind: 'completed',
    /**
     * The live state machine's terminal state. Both views expose `state` so the
     * projection identity used by the controller's cache is uniform across them.
     */
    state: 'settled',
    sessionId: settled.sessionId ?? null,
    turn: settled.turn,
    /** Turn identity for the projection cache: one string per settled view. */
    projectionKey: `completed:${settled.sessionId ?? ''}:${settled.turn ?? ''}`,
    status: status.kind,
    statusDetail: settled.statusNote ?? null,
    columns,
    elapsedMs: Number.isFinite(settled.turnElapsedMs) ? settled.turnElapsedMs : null,
    elapsedDisplay: durationText(settled.turnElapsedMs),
    tools: {
      count: tools.count ?? 0,
      completedCount: tools.completedCount ?? 0,
      wallMs: tools.wallMs ?? 0,
      wallDisplay: durationText(tools.wallMs ?? 0),
      workMs: tools.workMs ?? 0,
      workDisplay: durationText(tools.workMs ?? 0),
      failedCount: tools.failedCount ?? 0,
      names: tools.names ?? [],
    },
    attemptCount: settled.attemptCount ?? 0,
    quality: {
      tokenTotalQuality: quality.tokenTotalQuality ?? QualityLevel.UNAVAILABLE,
      phaseSplitQuality: quality.phaseSplitQuality ?? QualityLevel.UNAVAILABLE,
      displayTokenTotal: quality.displayTokenTotal ?? 'unavailable',
      displayPhaseSplit: quality.displayPhaseSplit ?? 'unavailable',
      /** Weakest axis: what a single `data-quality` attribute may say. */
      overall: weakestQuality(
        quality.tokenTotalQuality === QualityLevel.EXACT ? MetricQuality.EXACT : MetricQuality.ESTIMATED,
        quality.phaseSplitQuality === QualityLevel.EXACT ? MetricQuality.EXACT : MetricQuality.ESTIMATED,
      ),
    },
    /**
     * Provider/stream contradictions observed while aggregating. Never printed in
     * the production card (the quality downgrade already reaches the numbers); it
     * travels for diagnostics and for Phase 8's settings surface.
     */
    consistencyIssues: Array.isArray(settled.consistencyIssues) ? settled.consistencyIssues : [],
    /**
     * Retained for Phase 5's hover/focus curve view. Phase 4 renders no chart and
     * the component must not read this field.
     */
    curve: settled.curve ?? null,
  }
}
