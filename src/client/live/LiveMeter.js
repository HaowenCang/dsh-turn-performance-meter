/**
 * Live meter React component (browser only — this module imports `react`, so
 * Node tests must not import it directly; `test/client-bundle.test.js` loads
 * it through the built bundle with a stubbed module table).
 *
 * Rendering contract:
 *
 *   - the component receives a finished view model from `LivePresenter` and
 *     formats strings; it never parses events, never computes TPS/TTFT/tool
 *     time, and never touches raw `SessionEvent` shapes;
 *   - exactly one presentation ticker per mounted meter (200 ms default),
 *     started while visible and cleared whenever it is not — unmount, HMR
 *     remount and session switches all destroy it;
 *   - high-frequency numbers are plain text: NO `aria-live` region, so a
 *     screen reader is never read a new TPS five times a second. The root
 *     carries a per-state `aria-label` and `data-state` instead;
 *   - the style tag is reference-counted: at most one `#dsh-tpm-live-style`
 *     exists at any time, and the last unmount removes it (HMR-clean).
 */

import { createElement as h, useEffect, useReducer, useRef, useState } from 'react'
import { createPresentationScheduler } from './refresh.js'
import { formatApproxTps, formatElapsed, formatStopwatch, formatToolLabel } from './live-format.js'
import { LIVE_CSS, LIVE_STYLE_ID } from './live-css.js'

/** Reference count for the shared style tag. */
let styleUsers = 0

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

function acquireStyle() {
  let element = document.getElementById(LIVE_STYLE_ID)
  if (element === null) {
    element = document.createElement('style')
    element.id = LIVE_STYLE_ID
    element.setAttribute('data-plugin', 'dsh-turn-performance-meter')
    element.textContent = LIVE_CSS
    document.head.appendChild(element)
  }
  styleUsers += 1
  return () => {
    styleUsers = Math.max(0, styleUsers - 1)
    if (styleUsers === 0) {
      const owned = document.getElementById(LIVE_STYLE_ID)
      if (owned !== null) owned.remove()
    }
  }
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

function pill(view, label) {
  const ariaLabel = `${label} · ${formatElapsed(view.elapsedMs ?? 0)}`
  return h('div', { className: 'dsh-tpm-root', 'data-state': view.state, 'data-turn': view.turn ?? '', 'aria-label': ariaLabel },
    h('div', { className: 'dsh-tpm-pill' }, pillContent(view, label)))
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
 * Build the slot component. The controller and translate function close over
 * the registration site (`src/client/main.js`), so the component itself stays
 * a pure function of `(props, controller state)`.
 *
 * @param {{controller: object, t: (key: string) => string, debug?: boolean}} options
 */
export function makeMeterSlot({ controller, t, debug = false }) {
  const label = typeof t === 'function' ? t : (key => key)

  return function TurnPerformanceMeter(props) {
    const sessionId = typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
    const [, bump] = useReducer(count => count + 1, 0)

    // Debug-only: report the seat's actual prop shape once per session value,
    // so a missing `sessionId` standard prop shows up as itself rather than as
    // a silently hidden meter. No per-delta logging exists anywhere.
    const seenSession = useRef(null)
    if (debug && seenSession.current !== sessionId) {
      seenSession.current = sessionId
      try {
        console.debug('[dsh-tpm] slot prop shape', Object.keys(props ?? {}), 'sessionId =', sessionId)
      } catch { /* diagnostics must never break render */ }
    }

    /**
     * The projected view is *state*, refreshed only by the presentation
     * scheduler (and once per mount/session change) — never during render.
     * The conversation dock re-renders its occupants on every chat update
     * (streaming chunks arrive far faster than the refresh interval); if each
     * of those renders re-projected `Date.now()`, the DOM would update at the
     * chat's cadence and bypass the 100–250 ms presentation throttle. Keeping
     * the last projected view in state means parent re-renders reuse identical
     * values, and the ticker remains the only writer of visible numbers.
     */
    const [view, setView] = useState(() => (
      sessionId === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(sessionId, Date.now())
    ))

    const sessionIdRef = useRef(sessionId)
    sessionIdRef.current = sessionId
    const refreshView = () => {
      diagnostics.refreshCalls += 1
      const id = sessionIdRef.current
      setView(id === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(id, Date.now()))
    }

    const schedulerRef = useRef(null)
    if (schedulerRef.current === null) {
      diagnostics.schedulerCreated += 1
      schedulerRef.current = createPresentationScheduler({
        intervalMs: controller.refreshMs,
        onRender: () => {
          diagnostics.renderCalls += 1
          refreshView()
          bump()
        },
      })
      diagnostics.currentScheduler = schedulerRef.current
    }
    const scheduler = schedulerRef.current

    useEffect(() => acquireStyle(), [])

    // One eventSource subscription per session (attach is idempotent); the
    // unsubscribe runs on session switch and on unmount/HMR. The view is
    // re-projected here so a session switch never shows the old session's
    // numbers while waiting for the next ticker tick.
    useEffect(() => {
      if (sessionId === null) {
        refreshView()
        return undefined
      }
      const attached = controller.attach(sessionId)
      if (debug) {
        try { console.debug('[dsh-tpm] attach', sessionId, '=>', attached) } catch { /* diagnostics */ }
      }
      refreshView()
      return controller.subscribe(() => {
        diagnostics.notifyCalls += 1
        scheduler.notify()
      })
    }, [sessionId, controller, scheduler, debug])

    // The single presentation ticker: on only while visible, destroyed on
    // hide and on unmount. Data-side ingestion is never throttled.
    const visible = view.kind !== 'hidden'
    diagnostics.renderCalls += 0 // render itself is counted separately from ticker renders
    useEffect(() => {
      if (!visible) {
        scheduler.stop()
        return undefined
      }
      scheduler.start()
      return () => scheduler.stop()
    }, [visible, scheduler])

    if (!visible) return null
    return pill(view, label(stateLabelKey(view)))
  }
}
