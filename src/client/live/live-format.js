/**
 * Live-view formatting.
 *
 * Formatting rules with a correctness dimension:
 *
 *   - a live TPS value always carries `≈`: its quality is `estimated`
 *     unconditionally (METRICS_SPEC §11.5), so a bare number would imply a
 *     provider-exactness that does not exist;
 *   - absent evidence renders as the shared em dash, never as `0`;
 *   - tool names truncate with an ellipsis instead of stretching the pill;
 *   - a multi-tool label always distinguishes itself from a single tool.
 */

import { countdownParts, formatCountdown, formatDuration, formatSeconds, formatTps, DASH } from '../format.js'

/**
 * Approximate TPS rendering: `≈338`, `≈38.4`, `—` for absent evidence.
 * Exact values would render bare, but live values are never exact.
 */
export function formatApproxTps(value, approximate = true) {
  if (!Number.isFinite(value)) return DASH
  return approximate ? `≈${formatTps(value)}` : formatTps(value)
}

/** Turn elapsed / stage elapsed: `17.3s`, `2m22s` (shared duration rules). */
export function formatElapsed(ms) {
  return formatDuration(ms)
}

/** TTFT stopwatch and waiting stopwatch: `2.80 s`. */
export function formatStopwatch(ms, digits = 2) {
  return formatCountdown(ms, digits)
}

/**
 * The same stopwatch as separately styleable parts: `2.80` + `s`.
 *
 * The live pill renders the number at the top of its type scale and the unit two
 * steps below it, which is only possible if the two are separate runs.
 */
export function stopwatchParts(ms, digits = 2) {
  return countdownParts(ms, digits)
}

/** Long tool names are truncated so the pill never overflows. */
export function truncateToolName(name, max = 20) {
  if (typeof name !== 'string' || name.length === 0) return DASH
  if (name.length <= max) return name
  return `${name.slice(0, max - 1)}…`
}

/**
 * Compact tool label:
 *
 *   1 tool   `pwsh`            (long names truncate)
 *   2+ tools `pwsh +1`         (first name plus how many others)
 *   unknown  `×2`
 *
 * The count suffix is locale-independent on purpose: digits stay tabular and
 * the single/multi distinction survives every locale.
 */
export function formatToolLabel(names, count) {
  const list = Array.isArray(names) ? names.filter(name => typeof name === 'string' && name.length > 0) : []
  // A count is a number of calls: it is rounded before use so a fractional input
  // can never render as `+1.7000000000000002`.
  const total = Number.isFinite(count) && count > 0 ? Math.round(count) : list.length
  if (total <= 0) return DASH
  if (total === 1) return truncateToolName(list[0] ?? DASH)
  const first = list.length > 0 ? `${truncateToolName(list[0])} ` : ''
  return `${first}+${total - 1}`
}

export { DASH, formatTps }
