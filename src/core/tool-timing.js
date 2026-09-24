/**
 * Tool latency: per-call durations plus the two required aggregates.
 *
 * `workMs` is the arithmetic sum of every completed call duration.
 * `wallMs` is the measure of the **union** of the same intervals, so parallel
 * calls are not counted twice. `workMs >= wallMs` always holds, with equality
 * exactly when no two counted calls overlap (docs/METRICS_SPEC.md §5).
 *
 * A call with no result yet is running and contributes to neither total: an open
 * interval has no measurable duration, and treating its "duration so far" as
 * completed latency would double-count when it closes.
 */

/** Merge completed intervals and return their union length in ms. */
export function unionDurationMs(intervals) {
  const normalized = intervals
    .filter(x => x && Number.isFinite(x.startMs) && Number.isFinite(x.endMs) && x.endMs >= x.startMs)
    .map(x => ({ startMs: x.startMs, endMs: x.endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  if (!normalized.length) return 0
  let total = 0
  let start = normalized[0].startMs
  let end = normalized[0].endMs
  for (let i = 1; i < normalized.length; i += 1) {
    const next = normalized[i]
    if (next.startMs <= end) {
      end = Math.max(end, next.endMs)
    } else {
      total += end - start
      start = next.startMs
      end = next.endMs
    }
  }
  return total + end - start
}

function isCompleted(call) {
  return call
    && Number.isFinite(call.startMs)
    && Number.isFinite(call.endMs)
    && call.endMs >= call.startMs
}

/**
 * Summarize a turn's tool calls.
 *
 * @param {readonly object[]} calls normalized `ToolCallRecord` values
 */
export function summarizeToolCalls(calls) {
  const list = (Array.isArray(calls) ? calls : []).filter(call => call && typeof call === 'object')
  const completed = list.filter(isCompleted)
  const intervals = completed.map(call => ({ startMs: call.startMs, endMs: call.endMs }))
  const running = list.filter(call => !isCompleted(call))
  return {
    /** Every call seen, running or settled. */
    count: list.length,
    /** Calls with a result, i.e. the calls the two durations describe. */
    completedCount: completed.length,
    /** Calls whose result has not arrived. */
    runningCount: running.length,
    /** Sum of completed individual durations. */
    workMs: completed.reduce((sum, call) => sum + call.endMs - call.startMs, 0),
    /** Union of the same intervals; the figure the compact UI shows. */
    wallMs: unionDurationMs(intervals),
    failedCount: list.filter(call => call.status === 'error' || call.status === 'failed').length,
    cancelledCount: list.filter(call => call.status === 'cancelled').length,
    /** Distinct tool names in first-seen order, for the compact `a, b +1` label. */
    names: [...new Set(list.map(call => call && call.name).filter(name => typeof name === 'string' && name.length > 0))],
  }
}
