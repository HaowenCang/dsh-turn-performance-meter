/**
 * Live meter pill (browser only — this module imports `react`, so Node tests must
 * not import it directly; `test/client-bundle.test.js` loads it through the built
 * bundle with a stubbed module table).
 *
 * Rendering contract:
 *
 *   - the component receives a finished view model from `LivePresenter` and
 *     formats strings; it never parses events, never computes TPS/TTFT/tool
 *     time, and never touches raw `SessionEvent` shapes;
 *   - presentation lifecycle — the single 200 ms ticker, the session
 *     subscription and the reference-counted style tag — belongs to
 *     `MeterRoot.js`, which chooses between this pill and the completed card;
 *   - high-frequency numbers are plain text: NO `aria-live` region, so a screen
 *     reader is never read a new TPS five times a second. The root carries a
 *     per-state `aria-label` and `data-state` instead.
 */

import { createElement as h } from 'react'
import { formatApproxTps, formatElapsed, formatStopwatch, formatToolLabel } from './live-format.js'

/**
 * Debug counters (always cheap increments; read only via the debug handle).
 * They exist because the browser is the only place where the full chain
 * controller-notify -> scheduler -> setView -> DOM can be observed together.
 */
const diagnostics = {
  schedulerCreated: 0,
  notifyCalls: 0,
  renderCalls: 0,
  refreshCalls: 0,
  currentScheduler: null,
}

export function meterDiagnostics() {
  return diagnostics
}

/** Accessibility name per presentation state — transitions, not digits. */
function stateLabelKey(view) {
  switch (view.kind) {
    case 'ttft': return 'ttft'
    case 'streaming': return view.phase === 'reasoning' ? 'thinking' : 'output'
    case 'tool': return 'tool'
    case 'waiting': return 'waiting'
    case 'transition': return 'transition'
    default: return 'meterLabel'
  }
}

function pillContent(view, label) {
  switch (view.kind) {
    case 'ttft':
      return [
        h('span', { key: 'c', className: 'dsh-tpm-lead' }, formatStopwatch(view.counterMs ?? 0)),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
      ]

    case 'streaming':
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        h('span', { key: 't', className: 'dsh-tpm-tps' }, formatApproxTps(view.tps, view.approximate)),
        h('span', { key: 'u', className: 'dsh-tpm-unit' }, 'tokens/s'),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'e', className: 'dsh-tpm-elapsed' }, formatElapsed(view.elapsedMs ?? 0)),
      ]

    case 'tool':
      return [
        h('span', { key: 'n', className: 'dsh-tpm-tool' }, formatToolLabel(view.names, view.count)),
        h('span', { key: 'g', className: 'dsh-tpm-stage' }, `· ${formatElapsed(view.toolElapsedMs ?? 0)}`),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'e', className: 'dsh-tpm-elapsed' }, formatElapsed(view.elapsedMs ?? 0)),
      ]

    case 'waiting':
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        h('span', { key: 'g', className: 'dsh-tpm-stage' }, `· ${formatStopwatch(view.waitMs ?? 0)}`),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'e', className: 'dsh-tpm-elapsed' }, formatElapsed(view.elapsedMs ?? 0)),
      ]

    case 'transition':
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, `${label}…`),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'e', className: 'dsh-tpm-elapsed' }, formatElapsed(view.elapsedMs ?? 0)),
      ]

    default:
      return null
  }
}

/**
 * The live pill for one projected view.
 *
 * @param {{view: object, translate: (key: string) => string}} props
 */
export function LivePill({ view, translate }) {
  const t = typeof translate === 'function' ? translate : (key => key)
  const label = t(stateLabelKey(view))
  const ariaLabel = `${label} · ${formatElapsed(view.elapsedMs ?? 0)}`
  return h('div', {
    className: 'dsh-tpm-root',
    'data-state': view.state,
    'data-turn': view.turn ?? '',
    'aria-label': ariaLabel,
  }, h('div', { className: 'dsh-tpm-pill' }, pillContent(view, label)))
}
