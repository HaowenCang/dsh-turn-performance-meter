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
 *   - presentation lifecycle — the single presentation ticker, the session
 *     subscription and the reference-counted style tag — belongs to
 *     `MeterRoot.js`, which chooses between this pill and the completed card;
 *   - **one dominant number per state.** Every branch renders its own value
 *     through `.dsh-tpm-number` (the `1.7 x` step of the plugin's type scale) and
 *     keeps labels, units and elapsed readings strictly below it. Reference:
 *     `docs/assets/reference-live-streaming.png`, where the rate is the focus and
 *     the elapsed reading is visibly subordinate;
 *   - high-frequency numbers are plain text: NO `aria-live` region, so a screen
 *     reader is never read a new TPS twenty times a second. The root carries a
 *     per-state `aria-label` and `data-state` instead.
 */

import { createElement as h } from 'react'
import {
  formatApproxTps,
  formatElapsed,
  formatToolLabel,
  stopwatchParts,
} from './live-format.js'

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

/** A value and its unit as one non-wrapping run: `2.80` `s`, `≈338` `tokens/s`. */
function metric(value, unit, { tone = 'primary', className = 'dsh-tpm-number' } = {}) {
  return h('span', { className: 'dsh-tpm-metric' }, [
    h('span', { key: 'v', className, 'data-tone': tone }, value),
    unit === null ? null : h('span', { key: 'u', className: 'dsh-tpm-unit' }, unit),
  ])
}

function pillContent(view, label) {
  switch (view.kind) {
    case 'ttft': {
      /**
       * The running first-response counter is the state's only number, so it is
       * the state's focus: `2.80 S` beside the state label.
       */
      const parts = stopwatchParts(view.counterMs ?? 0)
      return [
        metric(parts.value, parts.unit),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
      ]
    }

    case 'streaming':
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        metric(formatApproxTps(view.tps, view.approximate), 'tokens/s', { tone: 'accent' }),
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

    case 'waiting': {
      const parts = stopwatchParts(view.waitMs ?? 0)
      return [
        h('span', { key: 'l', className: 'dsh-tpm-label' }, label),
        metric(parts.value, parts.unit),
        h('span', { key: 's', className: 'dsh-tpm-sep' }),
        h('span', { key: 'e', className: 'dsh-tpm-elapsed' }, formatElapsed(view.elapsedMs ?? 0)),
      ]
    }

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
    'data-kind': 'live',
    'data-state': view.state,
    'data-turn': view.turn ?? '',
    'aria-label': ariaLabel,
  }, h('div', { className: 'dsh-tpm-pill' }, pillContent(view, label)))
}
