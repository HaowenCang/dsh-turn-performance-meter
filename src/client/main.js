/**
 * Browser plugin entry (the bundle's module exports).
 *
 * Wiring, in order:
 *   1. register the `turnPerformanceMeter` locale namespace (en + zh);
 *   2. create the presentation controller over `ctx.sessions`;
 *   3. dispose both on fiber teardown (HMR-safe);
 *   4. inject an independent `turn-performance-meter` entry into
 *      `conversation.input.dock` — the verified full-width seat **above the
 *      composer card**, which is where the reference layout puts the meter.
 *
 * ## Why the seat moved (Phase 5B)
 *
 * Phase 3 registered in `conversation.composer.dock`, documented by DSH as
 * "Ambient entries below the composer card". That seat is *below* the composer
 * and already holds the native chat statistics (`client-ui-chat` `StatsPills`,
 * id `stats`), so the meter rendered between the input box and the numbers it
 * was competing with for width and attention.
 *
 * DSH exposes the correct region as `conversation.input.dock`
 * (`kind: 'list'`, `scope: 'session'`, `owner: InputZone`, "Full-width entries
 * above the composer card"), rendered by the owner immediately before
 * `inputBar`:
 *
 *     zone !== undefined && renderSlot("conversation.input.dock", zone),
 *     inputBar
 *
 * Native `stats` is untouched: it keeps its own seat and its own id.
 *
 * ## Order
 *
 * `order` is ascending within the list. The seat's shipped occupants are
 * `todo` (0), `goal` (10) and `queue` (20), so `order: 30` places this entry
 * **last** — directly above the composer card, below the native state panels.
 * A negative order would have floated the meter above `todo`/`goal`, i.e. the
 * one position that is *not* adjacent to the composer whenever a plan or a goal
 * bar is on screen.
 *
 * Service keys (`slots`, `sessions`, `locale`) are the Cordis service names;
 * the package names they arrive from are declared in `package.json`
 * `dsh.client.inject`. React itself comes from the browser module table seed —
 * never from a runtime dependency.
 */

import { createController } from './live/controller.js'
import { makeMeterSlot } from './live/MeterRoot.js'
import { meterDiagnostics } from './live/LiveMeter.js'
import { LOCALE_DICTS, LOCALE_NS, wrapTranslate } from './live/locale.js'
import {
  DEFAULT_PRESENTATION_REFRESH_MS,
  REFRESH_OVERRIDE_STORAGE_KEY,
  resolvePresentationRefreshMs,
} from './live/cadence.js'

export const inject = ['slots', 'sessions', 'locale']

/** The seat this plugin occupies, and the id it must never reuse. */
export const SLOT_NAME = 'conversation.input.dock'
export const SLOT_ID = 'turn-performance-meter'
/** Last among the shipped occupants (`todo` 0, `goal` 10, `queue` 20). */
export const SLOT_ORDER = 30

/**
 * Diagnostic switch (default OFF). When the browser local-storage key
 * `dsh-turn-performance-meter.debug` is `1`, the controller logs lifecycle
 * events (session attach, turn open/close, attempt/tool boundaries, quality
 * downgrades, rebaselines) through `console.debug` and publishes a read-only
 * diagnostics handle on `window.__dshTurnPerformanceMeter`. Per-delta logging
 * never happens, in either mode.
 */
function debugEnabled() {
  try {
    return typeof window !== 'undefined'
      && window.localStorage?.getItem('dsh-turn-performance-meter.debug') === '1'
  } catch {
    return false
  }
}

/**
 * Debug-only cadence override, read once at apply time.
 *
 * This exists so the Phase 5A A/B could run the *production* code path at
 * 200 ms, 50 ms and 10 ms without three rebuilds. It is unreachable unless the
 * diagnostic switch is already on, so the shipped cadence has exactly one
 * source (`./live/cadence.js`) and no persisted value can change it.
 */
function cadenceOverride() {
  try {
    return typeof window === 'undefined'
      ? null
      : window.localStorage?.getItem(REFRESH_OVERRIDE_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export function apply(ctx) {
  const debug = debugEnabled()

  let disposeLocale = () => {}
  try {
    const result = ctx.locale?.register?.(LOCALE_NS, LOCALE_DICTS)
    if (typeof result === 'function') disposeLocale = result
  } catch { /* a missing locale service must not block the meter */ }

  let rawTranslate = null
  try {
    rawTranslate = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : null
  } catch { /* fall back to the built-in dictionary */ }
  const t = wrapTranslate(rawTranslate)

  const refreshMs = debug
    ? resolvePresentationRefreshMs(cadenceOverride())
    : DEFAULT_PRESENTATION_REFRESH_MS

  const controller = createController({ sessions: ctx.sessions, debug, refreshMs })

  /**
   * Cordis effect semantics: `ctx.effect(fn)` runs `fn` as setup and calls the
   * **returned** function at fiber teardown — the same shape as the shipped
   * `ctx.effect(() => ctx.webServer.register(...))` call sites. Registering the
   * disposal body directly would dispose the controller at startup, which is
   * exactly the failure this comment exists to prevent.
   *
   * The whole debug handle is built **inside** the setup callback, including the
   * `meter()` accessor. An earlier revision attached `meter` right after
   * `ctx.effect(...)` returned; that silently produced a handle without its
   * accessor in the browser, because the setup callback had not run yet and the
   * assignment threw into its own `catch`. One construction site, one lifetime.
   */
  ctx.effect(() => {
    if (debug) {
      try {
        window.__dshTurnPerformanceMeter = {
          controller,
          diagnostics: (sessionId) => controller.diagnostics(sessionId),
          attachedSessions: () => controller.attachedSessions(),
          meter: () => {
            const diag = meterDiagnostics()
            const scheduler = diag.currentScheduler
            return {
              /** Selected/overridden cadence actually handed to the scheduler. */
              refreshMs: controller.refreshMs,
              productionRefreshMs: DEFAULT_PRESENTATION_REFRESH_MS,
              schedulerCreated: diag.schedulerCreated,
              notifyCalls: diag.notifyCalls,
              renderCalls: diag.renderCalls,
              refreshCalls: diag.refreshCalls,
              scheduler: scheduler === null ? null : {
                ticking: scheduler.ticking,
                disposed: scheduler.disposed,
                timerCount: scheduler.timerCount,
                intervalMs: scheduler.intervalMs,
              },
            }
          },
        }
      } catch { /* diagnostics must never break telemetry */ }
    }
    return () => {
      controller.dispose()
      if (debug) {
        try { delete window.__dshTurnPerformanceMeter } catch { /* ignore */ }
      }
      try { disposeLocale() } catch { /* best effort */ }
    }
  })

  ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
    name: SLOT_NAME,
    id: SLOT_ID,
    order: SLOT_ORDER,
  }, makeMeterSlot({ controller, t, debug })))
}
