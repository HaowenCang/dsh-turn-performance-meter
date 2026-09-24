/**
 * Pure view-model shaping.
 *
 * Keeping this layer pure means the component tree contains no statistics and no
 * transport knowledge, so screenshots and component tests are independent of
 * DSH. The inputs are the snapshots produced by `src/core/live-metrics.js` and
 * `src/host/telemetry-design.js`.
 */

import { MetricQuality } from '../core/metric-quality.js'

/** Shared shape for a value that may legitimately be absent. */
function value(value, quality) {
  return { value: value ?? null, quality: quality ?? MetricQuality.UNAVAILABLE, available: value !== null && value !== undefined }
}

/**
 * Live branch selection. `idle` and `settled` both render nothing: an idle meter
 * has no turn, and a settled turn is the completed card's job.
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
 * Completed card view model.
 *
 * Four principal columns are fixed by the UI specification; tool statistics stay
 * on secondary lines and never become a fifth permanent column.
 */
export function completedViewModel(settled) {
  if (!settled || !['completed', 'interrupted', 'errored'].includes(settled.status)) return null

  const tools = settled.tools ?? {}
  const statusLabel = settled.status
  const statusDetail = settled.statusNote === null || settled.statusNote === undefined
    ? statusLabel
    : `${statusLabel} · ${settled.statusNote}`

  return {
    kind: 'completed',
    turn: settled.turn,
    status: settled.status,
    statusDetail,
    columns: [
      {
        key: 'reasoningTps',
        value: value(settled.reasoningTps, settled.reasoningTpsQuality),
        unit: 'tokens/s',
        secondary: secondary(`duration · tokens`, settled.reasoningMs, settled.reasoningTokens),
      },
      {
        key: 'outputTps',
        value: value(settled.outputTps, settled.outputTpsQuality),
        unit: 'tokens/s',
        secondary: secondary(`duration · tokens`, settled.outputMs, settled.nonReasoningTokens),
      },
      {
        key: 'generatedTokens',
        value: value(settled.generatedTokens, settled.generatedTokensQuality),
        unit: 'tokens',
        /** A partial sum is shown with `≈`, never as the exact total. */
        approximate: settled.generatedTokens === null && settled.observedGeneratedTokens > 0,
        fallbackValue: settled.generatedTokens === null ? settled.observedGeneratedTokens : null,
        secondary: settled.turnElapsedMs === null ? null : { label: 'elapsed', ms: settled.turnElapsedMs },
      },
      {
        key: 'ttft',
        value: value(settled.ttftMs, settled.ttftMs === null ? MetricQuality.UNAVAILABLE : MetricQuality.EXACT),
        unit: 's',
        secondary: {
          label: 'tools',
          count: tools.count ?? 0,
          wallMs: tools.wallMs ?? 0,
          status: statusLabel,
        },
      },
    ],
    /** Detail line, deliberately not a fifth column. */
    detail: {
      toolCount: tools.count ?? 0,
      toolWorkMs: tools.workMs ?? 0,
      toolWallMs: tools.wallMs ?? 0,
      failedToolCount: tools.failedCount ?? 0,
      toolNames: tools.names ?? [],
      attemptCount: settled.attemptCount ?? 0,
      usageComplete: settled.usageComplete === true,
      splitComplete: settled.splitComplete === true,
    },
    curve: settled.curve ?? null,
  }
}

function secondary(label, ms, tokens) {
  const parts = []
  if (Number.isFinite(ms) && ms > 0) parts.push(`${(ms / 1000).toFixed(1)}s`)
  if (Number.isFinite(tokens)) parts.push(`${Math.round(tokens).toLocaleString('en-US')}`)
  return parts.length === 0 ? null : { label, text: parts.join(' · ') }
}
