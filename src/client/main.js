/**
 * Browser plugin entry (the bundle's module exports).
 *
 * Wiring, in order:
 *   1. register the `turnPerformanceMeter` locale namespace (en + zh);
 *   2. create the presentation controller over `ctx.sessions`;
 *   3. dispose both on fiber teardown (HMR-safe);
 *   4. inject an independent `turn-performance-meter` entry into
 *      `conversation.composer.dock` — additive, `order: -10` places it
 *      directly beside the composer while the native `stats` occupant
 *      (order 0) stays untouched.
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

export const inject = ['slots', 'sessions', 'locale']

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

  const controller = createController({ sessions: ctx.sessions, debug })

  /**
   * Cordis effect semantics (verified live): `ctx.effect(fn)` runs `fn`
   * immediately as setup and calls the **returned** function at fiber
   * teardown — the same shape as the shipped `ctx.effect(() =>
   * ctx.webServer.register(...))` call sites. Registering the disposal body
   * directly would dispose the controller at startup, which is exactly the
   * failure this comment exists to prevent.
   */
  ctx.effect(() => {
    if (debug) {
      try {
        window.__dshTurnPerformanceMeter = {
          controller,
          diagnostics: (sessionId) => controller.diagnostics(sessionId),
          attachedSessions: () => controller.attachedSessions(),
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

  if (debug) {
    try {
      window.__dshTurnPerformanceMeter.meter = () => {
        const diag = meterDiagnostics()
        const scheduler = diag.currentScheduler
        return {
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
      }
    } catch { /* diagnostics must never break telemetry */ }
  }

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'turn-performance-meter',
    order: -10,
  }, makeMeterSlot({ controller, t, debug })))
}
