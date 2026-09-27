/**
 * Host entry for dsh-turn-performance-meter.
 *
 * This plugin intentionally has no host-side telemetry bridge. Runtime
 * telemetry is consumed in the browser client from
 * `ctx.sessions.binding(sessionId).eventSource`; that seam is the production
 * data path, and docs/ARCHITECTURE.md records why a host projection was
 * rejected on evidence.
 *
 * The host entry exists only as the DSH plugin/bundle entry point: DSH loads
 * this module, reads `name`, and calls `apply`. `apply` registers nothing
 * because there is nothing host-side to register — no interception, no
 * middleware, and no DSH core source is patched.
 */
export const name = 'dsh-turn-performance-meter'

export function apply() {}
