/**
 * Meter root: the one slot component for this plugin.
 *
 * It owns the presentation lifecycle that both views share, and nothing else:
 *
 *   - `inactive`/no session, and only then, renders nothing;
 *   - the live pill while a turn is open;
 *   - the completed card once the session's turn has settled;
 *   - exactly one subscription per attached session (attach is idempotent);
 *   - exactly one ~200 ms presentation ticker while a **live** view is on screen,
 *     and **no timer at all** while the completed card is on screen. A settled
 *     turn is static, so the card is written once and never re-rendered by a
 *     clock; the scheduler stops on the same state advance that reveals it;
 *   - one reference-counted style tag for the whole plugin (live pill CSS and
 *     completed card CSS together), removed with the last unmount so HMR cannot
 *     accumulate `style` elements.
 *
 * Live and completed are mutually exclusive by construction: the projection comes
 * from a single state advance in the controller (see `controller.js` `project`),
 * so a `turn/end` publish yields the card immediately and a following
 * `turn/start` yields the pill immediately.
 */

import { createElement as h, useEffect, useReducer, useRef, useState } from 'react'
import { createPresentationScheduler } from './refresh.js'
import { LivePill, meterDiagnostics } from './LiveMeter.js'
import { CompletedMeter } from '../completed/CompletedMeter.js'
import { LIVE_CSS, LIVE_STYLE_ID } from './live-css.js'
import { COMPLETED_CSS } from '../completed/completed-css.js'

/** Reference count for the plugin's single style tag. */
let styleUsers = 0

/** Live pill CSS first, card CSS second; both are scoped under `.dsh-tpm-root`. */
const PLUGIN_CSS = `${LIVE_CSS}\n${COMPLETED_CSS}`

/** A projection that cannot change until an event arrives. */
function isStatic(view) {
  return view.kind === 'completed'
}

function acquireStyle() {
  let element = document.getElementById(LIVE_STYLE_ID)
  if (element === null) {
    element = document.createElement('style')
    element.id = LIVE_STYLE_ID
    element.setAttribute('data-plugin', 'dsh-turn-performance-meter')
    element.textContent = PLUGIN_CSS
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

/**
 * Build the slot component. The controller and translate function close over the
 * registration site (`src/client/main.js`), so the component itself stays a pure
 * function of `(props, controller state)`.
 *
 * @param {{controller: object, t: (key: string) => string, debug?: boolean}} options
 */
export function makeMeterSlot({ controller, t, debug = false }) {
  const translate = typeof t === 'function' ? t : (key => key)

  return function TurnPerformanceMeter(props) {
    const sessionId = typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
    const [, bump] = useReducer(count => count + 1, 0)

    // Debug-only: report the seat's actual prop shape once per session value, so
    // a missing `sessionId` standard prop shows up as itself rather than as a
    // silently hidden meter. No per-delta logging exists anywhere.
    const seenSession = useRef(null)
    if (debug && seenSession.current !== sessionId) {
      seenSession.current = sessionId
      try {
        console.debug('[dsh-tpm] slot prop shape', Object.keys(props ?? {}), 'sessionId =', sessionId)
      } catch { /* diagnostics must never break render */ }
    }

    /**
     * The projected view is *state*, refreshed only by the presentation
     * scheduler (once per mount/session change, and while live on each tick) —
     * never during render. The conversation dock re-renders its occupants on
     * every chat update; if each of those renders re-projected `Date.now()`, the
     * DOM would update at the chat's cadence and bypass the throttle.
     */
    const [view, setView] = useState(() => (
      sessionId === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(sessionId, Date.now())
    ))

    const sessionIdRef = useRef(sessionId)
    sessionIdRef.current = sessionId
    const viewRef = useRef(view)
    viewRef.current = view
    const refreshView = () => {
      meterDiagnostics().refreshCalls += 1
      const id = sessionIdRef.current
      setView(id === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(id, Date.now()))
    }

    /** Created once per mounted meter; disposed implicitly by the effect below. */
    const [scheduler] = useState(() => {
      const diagnostics = meterDiagnostics()
      diagnostics.schedulerCreated += 1
      const created = createPresentationScheduler({
        intervalMs: controller.refreshMs,
        onRender: () => {
          diagnostics.renderCalls += 1
          refreshView()
          bump()
        },
      })
      diagnostics.currentScheduler = created
      return created
    })

    useEffect(() => acquireStyle(), [])

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
        meterDiagnostics().notifyCalls += 1
        /**
         * A static projection can only change on a new event, so it is rebuilt
         * once per event and never re-rendered by a timer. `refreshView` runs
         * directly instead of through the scheduler, which is what leaves **no
         * timer** for a completed card: the scheduler is never even notified.
         */
        if (isStatic(viewRef.current)) refreshView()
        else scheduler.notify()
      })
    }, [sessionId, controller, scheduler, debug])

    // The single presentation ticker: on only while a live view is visible,
    // stopped on hide, on completion and on unmount. Ingestion is never
    // throttled.
    const visible = view.kind !== 'hidden'
    const live = visible && !isStatic(view)
    useEffect(() => {
      if (!live) {
        scheduler.stop()
        return undefined
      }
      scheduler.start()
      return () => scheduler.stop()
    }, [live, scheduler])

    if (!visible) return null
    if (view.kind === 'completed') return h(CompletedMeter, { view, translate })
    return h(LivePill, { view, translate })
  }
}
