/**
 * Meter root: the one slot component for this plugin.
 *
 * It owns the presentation lifecycle that both views share, and nothing else:
 *
 *   - `inactive`/no session, and only then, renders nothing;
 *   - the live pill while a turn is open;
 *   - the completed card once the session's turn has settled;
 *   - exactly one subscription per attached session (attach is idempotent);
 *   - exactly one presentation ticker while a **live** view is on screen, at the
 *     single cadence owned by `./cadence.js`, and **no timer at all** while the
 *     completed card is on screen. A settled turn is static, so the card is
 *     written once and never re-rendered by a clock; the scheduler stops on the
 *     same state advance that reveals it;
 *   - one reference-counted style tag for the whole plugin (live pill CSS and
 *     completed card CSS together), removed with the last unmount so HMR cannot
 *     accumulate `style` elements.
 *
 * Live and completed are mutually exclusive by construction: the projection comes
 * from a single state advance in the controller (see `controller.js` `project`),
 * so a `turn/end` publish yields the card immediately and a following
 * `turn/start` yields the pill immediately.
 *
 * ## One state update per presentation tick
 *
 * `onRender` calls `refreshView()` and nothing else. An earlier revision also
 * called a `useReducer` bump to "force" the render; the audit that removed it:
 *
 *   - `refreshView` calls `setView` with the object `controller.project(id,
 *     Date.now())` returned;
 *   - the projection key includes the presentation instant
 *     (`controller.js` `projectionKey`), so a tick never re-uses the cached
 *     view object — `setView` therefore always receives a new identity and
 *     always schedules exactly one render;
 *   - a second dispatcher in the same tick could therefore only ever add a
 *     redundant update, and at the selected cadence that is a measurable cost
 *     with no visible effect.
 *
 * The invariant is asserted by `test/meter-root.test.js`, which drives a real
 * `onRender` through a recording React stub and counts dispatches per tick.
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPresentationScheduler } from './refresh.js'
import { LivePill, meterDiagnostics } from './LiveMeter.js'
import { CompletedMeter } from '../completed/CompletedMeter.js'
import { LIVE_CSS, LIVE_STYLE_ID } from './live-css.js'
import { COMPLETED_CSS } from '../completed/completed-css.js'
import { BASE_CSS } from '../base-css.js'

/** Reference count for the plugin's single style tag. */
let styleUsers = 0

/**
 * Shared tokens first, then the pill sheet, then the card sheet. The order is
 * the cascade: the base block declares the tokens both view sheets consume, and
 * neither view sheet redeclares them.
 */
const PLUGIN_CSS = `${BASE_CSS}\n${LIVE_CSS}\n${COMPLETED_CSS}`

/**
 * A projection that cannot change until an event arrives.
 *
 * A completed card is the only such view: it is a pure function of the settled
 * turn, so it is rebuilt once per event and never by a clock. `hidden` is *not*
 * static in this sense — it means "no view for this session", and the meter is
 * not on screen to be rebuilt — which is why the ticker's own lifecycle below
 * tests `view.kind !== 'hidden'` separately.
 */
function isStatic(view) {
  return view.kind === 'completed'
}

/** Whether the browser document is currently in the foreground. */
function isDocumentVisible(doc) {
  if (!doc) return true
  return doc.visibilityState === 'visible'
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
 * @param {{
 *   controller: object,
 *   t: (key: string) => string,
 *   debug?: boolean,
 *   documentTarget?: Document | object | null,
 *   windowTarget?: Window | object | null,
 * }} options
 */
export function makeMeterSlot({ controller, t, debug = false, documentTarget, windowTarget }) {
  const translate = typeof t === 'function' ? t : (key => key)
  const doc = documentTarget !== undefined ? documentTarget : (typeof document !== 'undefined' ? document : null)
  const win = windowTarget !== undefined ? windowTarget : (typeof window !== 'undefined' ? window : null)

  return function TurnPerformanceMeter(props) {
    const sessionId = typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null

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
     * never during render. The slot's owner re-renders its occupants on every
     * chat update; if each of those renders re-projected `Date.now()`, the DOM
     * would update at the chat's cadence and bypass the throttle.
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
    const foregroundDirtyRef = useRef(true)
    const lastRecoverRef = useRef(0)

    const refreshView = () => {
      meterDiagnostics().refreshCalls += 1
      const id = sessionIdRef.current
      const nextView = id === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(id, Date.now())
      viewRef.current = nextView
      setView(nextView)
    }

    /** Created once per mounted meter; disposed implicitly by the effect below. */
    const [scheduler] = useState(() => {
      const diagnostics = meterDiagnostics()
      diagnostics.schedulerCreated += 1
      const created = createPresentationScheduler({
        intervalMs: controller.refreshMs,
        // Exactly one state update per tick: `refreshView` owns the render.
        onRender: () => {
          diagnostics.renderCalls += 1
          refreshView()
        },
      })
      diagnostics.currentScheduler = created
      return created
    })

    /**
     * Authoritative foreground recovery (Phase 10.1R Section 11, Phase 10.1R.1 Section 2):
     *
     * Every transition hidden -> visible permits EXACTLY ONE authoritative recovery
     * regardless of how recently a previous foreground recovery occurred.
     * Duplicate lifecycle events (visibilitychange, focus, pageshow) belonging to the
     * same foreground edge are coalesced without a second destructive recovery.
     *
     * 1. consume dirty foreground generation
     * 2. controller.resync(current session)
     * 3. authoritative projection from the recovered controller state
     * 4. setView immediately (recovery render edge outside 10 Hz cadence)
     * 5. if resulting view is live: resume/start scheduler; else leave stopped.
     */
    const recoverForeground = (reason) => {
      if (!isDocumentVisible(doc)) return
      if (!foregroundDirtyRef.current) return
      foregroundDirtyRef.current = false
      const now = Date.now()
      lastRecoverRef.current = now

      const id = sessionIdRef.current
      if (id !== null && typeof controller.resync === 'function') {
        controller.resync(id, reason)
      }
      meterDiagnostics().refreshCalls += 1
      const recoveredView = id === null
        ? { kind: 'hidden', state: 'inactive', turn: null }
        : controller.project(id, now)
      viewRef.current = recoveredView
      setView(recoveredView)
      scheduler.resume()
      const isLive = recoveredView.kind !== 'hidden' && !isStatic(recoveredView)
      if (isLive) {
        scheduler.start()
      } else {
        scheduler.stop()
      }
    }

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
        // Gate presentation notifications by document foreground state:
        // when document is backgrounded, do not churn React updates or timers.
        if (!isDocumentVisible(doc)) return
        /**
         * A static projection can only change on a new event, so it is rebuilt
         * once per event and never re-rendered by a timer. `refreshView` runs
         * directly instead of through the scheduler, which is what leaves **no
         * timer** for a completed card: the scheduler is never even notified.
         */
        if (isStatic(viewRef.current)) refreshView()
        else scheduler.notify()
      })
    }, [sessionId, controller, scheduler, debug, doc])

    // Document visibility lifecycle (Phase 10.1R Section 10-12):
    // Minimization / backgrounding suspends the presentation ticker.
    // Foreground transitions trigger authoritative resync and immediate render.
    useEffect(() => {
      if (!doc && !win) return undefined

      const onVisibilityChange = () => {
        if (!isDocumentVisible(doc)) {
          foregroundDirtyRef.current = true
          scheduler.suspend()
        } else {
          recoverForeground('visibilitychange')
        }
      }

      const onPageShow = () => {
        if (isDocumentVisible(doc)) {
          recoverForeground('pageshow')
        }
      }

      const onFocus = () => {
        if (isDocumentVisible(doc)) {
          recoverForeground('focus')
        }
      }

      if (doc?.addEventListener) {
        doc.addEventListener('visibilitychange', onVisibilityChange)
      }
      if (win?.addEventListener) {
        win.addEventListener('pageshow', onPageShow)
        win.addEventListener('focus', onFocus)
      }

      if (!isDocumentVisible(doc)) {
        foregroundDirtyRef.current = true
        scheduler.suspend()
      }

      return () => {
        if (doc?.removeEventListener) {
          doc.removeEventListener('visibilitychange', onVisibilityChange)
        }
        if (win?.removeEventListener) {
          win.removeEventListener('pageshow', onPageShow)
          win.removeEventListener('focus', onFocus)
        }
      }
    }, [scheduler, doc, win])

    // The single presentation ticker: on only while a live view is visible in foreground,
    // suspended when document is backgrounded, stopped on completion and on unmount.
    // Ingestion is never throttled.
    const visible = view.kind !== 'hidden'
    const live = visible && !isStatic(view)
    useEffect(() => {
      if (!isDocumentVisible(doc)) {
        scheduler.suspend()
        return undefined
      }
      if (!live) {
        scheduler.stop()
        return undefined
      }
      scheduler.resume()
      scheduler.start()
      return () => scheduler.stop()
    }, [live, scheduler, doc])

    if (!visible) return null
    if (view.kind === 'completed') return h(CompletedMeter, { view, translate })
    return h(LivePill, { view, translate })
  }
}
