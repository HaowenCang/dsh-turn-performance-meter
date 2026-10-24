/**
 * Phase 13.0 — DSH 0.2.1-rc.3 compatibility layer.
 *
 * The normative runtime moved from `0.2.1-rc.2` to `0.2.1-rc.3` in Phase 13.0.
 * This file pins the claim that migration makes, against the public reference
 * commit below and the isolated installed `0.2.1-rc.3` toolchain audited for it:
 *
 *   `1f81c047fc48fa190a683e469daa699857e9afe8`  (`0.2.1-rc.3`)
 *   `687f282e8625c6b8d11ff58211a90524be2e4317`  (`0.2.1-rc.2`, superseded)
 *
 * The interface audit is recorded in `docs/DSH_API_NOTES.md` §16. Only the
 * runtime target and the compatibility metadata move; no production source
 * changes in this phase. The `src/client/**` seat, the wire-evidence adapter and
 * the metric arithmetic are the Phase 12.0/12.0R code, unchanged.
 *
 * Release Phase A (v0.1.7) then replaced the exact peer with the
 * `engines.dsh` range `>=0.2.1-rc.2 <0.2.2-0`, which admits both rc.2 and rc.3
 * (and later non-breaking 0.2.1-line runtimes). The wire evidence below was
 * established on rc.3 and is not restamped; only the live compatibility
 * declaration moved.
 *
 * What this file pins:
 *
 *   compatibility metadata   v0.1.7 `engines.dsh` range, no DSH peer, no engines.node
 *   evidence boundary        the rc.2 and 0.2.0 layers stay as historical records
 *   shipped declaration      three Cordis injections, bundle patch, one dock seat
 *   host entry               the bundle row id/name the rc.3 loader resolves
 *   slot contract            `conversation.input.dock`, session scope, order -10
 *   rc.3 More menu           registers none of the slots this plugin owns
 *   wire evidence            SessionEvent envelope, turn boundaries, settlements,
 *                            tool plane, transient live chunks, compact streams
 *   retainInfo semantics     observe-only, released on retirement, re-armed on
 *                            the returning activation; source generation identity
 *                            is the only generation test (revision restarts at 0)
 *   frozen invariants        100 ms cadence, 3-sample / 100 ms rate gates
 *
 * The historical rc.2 wire-shape evidence remains in
 * `test/dsh-021-contract.test.js`, which is deliberately not restamped beyond
 * its cross-file peer guard; the 0.2.0 record remains in
 * `test/dsh-020-contract.test.js`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { createController } from '../src/client/live/controller.js'
import { DEFAULT_PRESENTATION_REFRESH_MS, PRESENTATION_REFRESH_CANDIDATES_MS } from '../src/client/live/cadence.js'
import { MIN_RATE_ELAPSED_MS, MIN_RATE_SAMPLES } from '../src/core/rate-publication.js'
import { SessionEventFeed } from '../src/dsh/client-feed.js'
import {
  ATTEMPT_OUTCOME,
  NORMALIZED_KIND,
  SETTLEMENT_KIND,
  TOOL_RESULT_SHAPE,
  decodeStreamRecords,
  normalizeDurableEvent,
  normalizeLiveChunk,
} from '../src/dsh/index.js'
import { durableEntry, transientEntry } from './helpers/live-replay.js'
import { createNavigationController, turnWindow } from './helpers/session-navigation.js'

const SESSION = 'sess-021-rc3-contract'

const readSource = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

/** The rc.3 target and the three commits the historical layers are stamped with. */
const REFERENCE_021_RC3 = '1f81c047fc48fa190a683e469daa699857e9afe8'
const REFERENCE_021_RC2 = '687f282e8625c6b8d11ff58211a90524be2e4317'
const REFERENCE_020 = '639ed015397290b3745d163aafe02ffee4aa3f84'
const REFERENCE_017 = '477b4f420553e8a52c2fbccc464d7561b239c443'

/** One `SessionEvent` row in the durable envelope shape the adapter reads. */
function durableEvent(type, seq, time, data) {
  return { type, seq, time, data }
}

/** A durable settlement event: `assistant/message` owns the usage, `assistant/attempt` does not. */
function settlementEvent(type, seq, time, { turn = 1, step = 1, stream = [], usage, interrupted } = {}) {
  const data = { turn, step, stream }
  if (type === 'assistant/message') {
    data.message = { id: `msg-${seq}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'ok' }] }
    if (usage !== undefined) data.usage = usage
    if (interrupted === true) data.interrupted = true
  }
  return durableEvent(type, seq, time, data)
}

const manifestOf = () => readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse)
const clientBundle = () => readFile(new URL('../client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Compatibility metadata and the evidence boundary
// ---------------------------------------------------------------------------

test('the v0.1.7 manifest declares the exact engines.dsh range, with no DSH peer and no node engine', async () => {
  const manifest = await manifestOf()

  /**
   * Release Phase A moved the compatibility declaration from the exact Phase
   * 13.0 peer to one `engines.dsh` range. The bounds are pinned literally:
   * `*`, `>=0.2.1`, `^0.2.1-rc.2` and any `||` union would admit runtimes the
   * project has not bounded, and an open upper bound would silently admit
   * 0.2.2+.
   */
  assert.equal(manifest.version, '0.1.7', 'the release version is the prepared v0.1.7 release')
  assert.equal(manifest.engines?.dsh, '>=0.2.1-rc.2 <0.2.2-0', 'the range is exact in both directions')
  assert.deepEqual(manifest.engines, { dsh: '>=0.2.1-rc.2 <0.2.2-0' }, 'engines.dsh is the only engine entry')
  assert.equal(Object.hasOwn(manifest.engines, 'node'), false, 'no engines.node constraint is added without evidence')

  /**
   * The superseded exact peer is removed, not left beside the engines range.
   * Leaving it would keep a contradictory exact requirement that pnpm would
   * still try to resolve even though the host evaluator ignores it once
   * `engines.dsh` is present.
   */
  assert.equal(manifest.peerDependencies, undefined, 'the exact @deepseek-ai/dsh peer is removed')
  assert.equal(manifest.version === '0.1.6', false, 'the unreleased 0.1.6 working-tree state is superseded')

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.files, ['index.js', 'client.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE'])
})

test('the 0.2.1-rc.3 reference commit is pinned beside the three historical commits', () => {
  assert.equal(REFERENCE_021_RC3, '1f81c047fc48fa190a683e469daa699857e9afe8')
  assert.equal(REFERENCE_021_RC2, '687f282e8625c6b8d11ff58211a90524be2e4317')
  assert.equal(REFERENCE_020, '639ed015397290b3745d163aafe02ffee4aa3f84')
  assert.equal(REFERENCE_017, '477b4f420553e8a52c2fbccc464d7561b239c443')
  for (const [left, right] of [
    [REFERENCE_021_RC3, REFERENCE_021_RC2],
    [REFERENCE_021_RC2, REFERENCE_020],
    [REFERENCE_020, REFERENCE_017],
  ]) {
    assert.notEqual(left, right, 'each runtime line keeps its own reference commit')
  }
})

test('the rc.2 and 0.2.0 contract layers are retained as historical evidence with the current-declaration guard', async () => {
  /**
   * A migration may not rewrite the evidence for the runtime it verified. The
   * historical layers keep their identity line and their own reference commit;
   * only the cross-file guard that points at the *working tree* peer moves, so
   * the two files cannot drift apart.
   */
  const rc2Layer = await readFile(new URL('./dsh-021-contract.test.js', import.meta.url), 'utf8')
  assert.match(rc2Layer, /DSH 0\.2\.1-rc\.2 compatibility layer/, 'the rc.2 layer keeps its Phase 11.0 identity')
  assert.ok(rc2Layer.includes(REFERENCE_021_RC2), 'the rc.2 layer keeps its reference commit')
  const declarationGuard = "assert.equal(manifest.engines?.dsh, '>=0.2.1-rc.2 <0.2.2-0'"
  assert.ok(
    rc2Layer.includes(declarationGuard),
    'the rc.2 layer carries the current-declaration guard so the layers cannot drift apart',
  )

  const rc20Layer = await readFile(new URL('./dsh-020-contract.test.js', import.meta.url), 'utf8')
  assert.match(rc20Layer, /DSH 0\.2\.0-rc\.2 compatibility layer/, 'the 0.2.0 layer keeps its Phase 9.3 identity')
  assert.ok(rc20Layer.includes(REFERENCE_020), 'the 0.2.0 layer keeps its reference commit')
  assert.ok(rc20Layer.includes(declarationGuard), 'the 0.2.0 layer carries the current-declaration guard')

  // No stale working-tree peer claim survives in a layer that is still normative.
  for (const layer of [rc2Layer, rc20Layer]) {
    assert.equal(layer.includes('const range = manifest.peerDependencies'), false, 'the live guard is not a peer read')
    assert.equal(layer.includes("assert.equal(range, '0.2.1-rc.2'"), false, 'the superseded exact pin is gone')
    assert.equal(layer.includes("assert.equal(range, '0.2.1-rc.3'"), false, 'the superseded exact pin is gone')
  }
})

// ---------------------------------------------------------------------------
// Shipped declaration: injections, bundle, host entry, dock seat
// ---------------------------------------------------------------------------

test('the shipped client declaration keeps the three Cordis injection packages and the dock seat', async () => {
  const manifest = await manifestOf()

  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
  ])

  const client = await clientBundle()
  assert.match(client, /conversation\.input\.dock/, 'the bundle registers the full-width seat above the composer')
  assert.match(client, /turn-performance-meter/, 'the bundle carries the plugin slot id')
  assert.match(client, /__ModuleLoader__/, 'the bundle is a DSH client module factory')
})

test('the host entry and bundle patch keep the names the rc.3 loader resolves', async () => {
  const host = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(host, /export const name = 'dsh-turn-performance-meter'/, 'the plugin name is the bundle row name')
  assert.match(host, /export function apply\(/, 'the host half exports the loadable apply entry')

  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- insert:/, 'the bundle patch contributes rows by insert')
  assert.match(patch, /- id: turn-performance-meter/, 'the inserted row id is stable')
  assert.match(patch, /name: dsh-turn-performance-meter/, 'the inserted row resolves the package by name')

  // The host half registers nothing: it exists only as the plugin/bundle entry point.
  assert.equal(/ctx\.\w+\.(register|inject)\(/.test(host), false, 'the host apply registers no service of its own')
})

test('the dock seat contract is unchanged: full-width session-scoped list entry, order -10, three services', async () => {
  const main = await readSource('src/client/main.js')

  /**
   * The browser plugin entry cannot be imported in a Node test (it pulls React
   * from the browser module table), so the seat declarations are read from the
   * source the bundle is built from. These are the exact declarations the rc.3
   * slot registry resolves.
   */
  assert.match(main, /export const inject = \['slots', 'sessions', 'locale'\]/, 'the Cordis service keys are unchanged')
  assert.match(main, /export const SLOT_NAME = 'conversation\.input\.dock'/, 'the full-width seat above the composer')
  assert.match(main, /export const SLOT_ID = 'turn-performance-meter'/, 'the slot id is stable')
  assert.match(main, /export const SLOT_ORDER = -10/, 'first among the shipped occupants')

  const order = Number((main.match(/export const SLOT_ORDER = (-?\d+(?:\.\d+)?)/) ?? [])[1])
  assert.equal(order, -10)
  assert.ok(order < 0 && Number.isFinite(order), 'the order is a finite negative pin')

  // The registration passes the same name, id and order to the registry.
  assert.match(main, /ctx\.slots\.inject\(SLOT_NAME, \(\) => ctx\.slots\.register\(\{/, 'the seat is injected through the slot service')
  assert.match(main, /name: SLOT_NAME,\s*\n\s*id: SLOT_ID,\s*\n\s*order: SLOT_ORDER,/, 'the registration is list-shaped and id/order-pinned')
})

test('the rc.3 conversation More menu owns no seat this plugin occupies: exactly one slot registration', async () => {
  const client = await clientBundle()

  /**
   * The rc.3 `ui-conversation` adds a More menu and its own slots. None of them
   * is `conversation.input.dock`, and the plugin still registers exactly one
   * seat — so the menu cannot duplicate, displace or steal the meter's dock.
   */
  for (const foreign of [
    'conversation.more',
    'conversation.header.more',
    'conversation.composer.more',
    'conversation.message.more',
    'conversation.session.more',
  ]) {
    assert.equal(client.includes(foreign), false, `the bundle must not register or read ${foreign}`)
  }
  assert.equal(client.includes('conversation.hero.options'), false, 'additive rc.3 hero seats are not consumed')

  /**
   * Exactly one registration in the whole bundle, and it is the dock. The native
   * `conversation.composer.dock` seat is not occupied by this plugin: it appears
   * only in the retained source commentary that explains why the seat moved.
   */
  const registrations = client.match(/slots\.register\(/g) ?? []
  assert.equal(registrations.length, 1, 'exactly one slot registration in the shipped bundle')
  const registerAt = client.indexOf('slots.register(')
  const registration = client.slice(registerAt, registerAt + 400)
  assert.match(registration, /name: SLOT_NAME,/, 'the one registration targets the declared dock seat')
  assert.match(registration, /order: SLOT_ORDER,/, 'the registration pins the same order')
  assert.match(client, /conversation\.input\.dock/, 'the bundle carries the dock seat name')
  assert.equal(/conversation\.composer\.dock\s*,/.test(client), false, 'the plugin does not register in the stats seat')
})

// ---------------------------------------------------------------------------
// Wire evidence: envelope, turn boundaries, settlements, tool plane
// ---------------------------------------------------------------------------

test('the SessionEvent envelope and the turn boundaries keep the rc.2 shape', () => {
  const start = normalizeDurableEvent(durableEvent('turn/start', 7, 1700000000000, { turn: 3 }))
  assert.equal(start.kind, NORMALIZED_KIND.TURN_START)
  assert.equal(start.turn, 3)
  assert.equal(start.seq, 7, 'seq comes from the envelope')
  assert.equal(start.timeMs, 1700000000000, 'time comes from the envelope')

  const end = normalizeDurableEvent(durableEvent('turn/end', 60, 9000, { turn: 3, reason: { kind: 'completed' } }))
  assert.equal(end.kind, NORMALIZED_KIND.TURN_END)
  assert.equal(end.status, 'completed')
  assert.equal(end.reasonKind, 'completed')
  assert.equal(end.timeMs, 9000)

  const unknown = normalizeDurableEvent(durableEvent('turn/end', 62, 9002, { turn: 3, reason: { kind: 'invented-later' } }))
  assert.equal(unknown.statusKnown, false)
  assert.equal(unknown.status, 'errored')
})

test('the settlements and the tool plane keep the rc.2 shape, including the tool-role identity site', () => {
  const message = normalizeDurableEvent(settlementEvent('assistant/message', 10, 5000, {
    stream: [{ type: 'text-chunks', time0: 4000, index: 0, dt: [1000], texts: ['ok'] }],
    usage: { inputTokens: 3, outputTokens: 2 },
  }))
  assert.equal(message.kind, NORMALIZED_KIND.ATTEMPT_SETTLE)
  assert.equal(message.settlementKind, SETTLEMENT_KIND.MESSAGE)
  assert.equal(message.attemptOutcome, ATTEMPT_OUTCOME.COMMITTED)
  assert.equal(message.usageSource, 'assistant-settlement')

  const attempt = normalizeDurableEvent(settlementEvent('assistant/attempt', 11, 6000, {
    stream: [{ type: 'text-chunks', time0: 5500, index: 0, dt: [500], texts: ['partial'] }],
  }))
  assert.equal(attempt.settlementKind, SETTLEMENT_KIND.ATTEMPT)
  assert.equal(attempt.surfaceCommitted, false)
  assert.equal(attempt.attemptOutcome, ATTEMPT_OUTCOME.UNKNOWN)

  const call = normalizeDurableEvent(durableEvent('tool/call', 20, 1000, {
    turn: 1, step: 1, callId: 'call_a', name: 'pwsh', arguments: '{"command":"ls"}',
  }))
  assert.equal(call.kind, NORMALIZED_KIND.TOOL_CALL)
  assert.equal(call.callId, 'call_a')
  assert.equal(call.name, 'pwsh')

  const result = normalizeDurableEvent(durableEvent('tool/result', 21, 2000, {
    turn: 1,
    step: 1,
    message: { id: 'r1', role: 'tool', toolCallId: 'call_a', source: { kind: 'tool' }, content: [{ type: 'text', text: 'ok' }] },
  }))
  assert.equal(result.kind, NORMALIZED_KIND.TOOL_RESULT)
  assert.equal(result.callId, 'call_a')
  assert.equal(result.callIdSource, TOOL_RESULT_SHAPE.TOOL_MESSAGE)
  assert.equal(result.timeMs, 2000, 'a tool/result carries no timestamp of its own; the envelope supplies it')
})

test('the transient assistant/live-chunk row and the four window change kinds are unchanged', () => {
  const live = normalizeLiveChunk(transientEntry('attempt-1', 1200, { type: 'reasoning-delta', index: 0, text: 'think' }))
  assert.equal(live.kind, NORMALIZED_KIND.ATTEMPT_DELTA)
  assert.equal(live.attemptId, 'attempt-1')
  assert.equal(live.timeMs, 1200, 'time sits on the row, not on data')
  assert.equal(live.phase, 'reasoning')
  assert.equal(normalizeLiveChunk(durableEntry('turn/start', 1, 1, { turn: 1 })).kind, NORMALIZED_KIND.IGNORED)

  const feed = new SessionEventFeed({ sessionId: SESSION, onEvent: () => {} })
  feed.applyWindow({ entries: [], revision: 1, change: { kind: 'replace', entries: [] } })
  assert.equal(feed.initialized, true)

  feed.applyWindow({ entries: [], revision: 2, change: { kind: 'append', entries: [durableEntry('turn/start', 1, 1000, { turn: 1 })] } })
  assert.equal(feed.openTurn, 1)

  feed.applyWindow({ entries: [], revision: 3, change: { kind: 'prepend', entries: [durableEntry('turn/start', 0, 500, { turn: 0 })] } })
  assert.equal(feed.ignoredPrepends, 1, 'older history is counted and never guessed at')
  assert.equal(feed.openTurn, 1)

  feed.applyWindow({ entries: [], revision: 4, change: { kind: 'replace', entries: [] } })
  assert.equal(feed.openTurn, null, 'replace is a rebaseline')

  feed.applyWindow({ entries: [], revision: 2, change: { kind: 'append', entries: [durableEntry('turn/start', 9, 1, { turn: 9 })] } })
  assert.equal(feed.openTurn, null, 'a stale revision is inert whatever its change kind')
  assert.deepEqual(feed.issues, [])
})

test('the compact AssistantStreamRecord timing and the generated-token set are unchanged', () => {
  const decoded = decodeStreamRecords([
    { type: 'reasoning-chunks', time0: 1000, index: 0, dt: [40, 60], texts: ['a', 'b', 'c'] },
    { type: 'text-chunks', time0: 1200, index: 1, dt: [10], texts: ['x', 'y'] },
    { type: 'tool-call-chunks', time0: 1300, index: 2, dt: [5], id: 'call_a', name: 'pwsh', args: ['{"a"', ':1}'] },
    { type: 'chunk', time: 1310, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 5 } } },
    { type: 'chunk', time: 1320, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])
  assert.equal(decoded.complete, true)
  assert.deepEqual(decoded.chunks.map(entry => entry.timeMs), [1000, 1040, 1100, 1200, 1210, 1300, 1305, 1310, 1320])
  assert.equal(decoded.firstTokenTimeMs, 1000)
  assert.equal(decoded.generatedChunkCount, 7, 'the generated set is the delta set; usage and finish are not tokens')
  // The run id is the tool-call identity; the arguments are reassembled from the parts.
  assert.equal(decoded.chunks[5].chunk.id, 'call_a')
  assert.equal(decoded.chunks[5].chunk.argumentsDelta, '{"a"')

  const broken = decodeStreamRecords([{ type: 'text-chunks', time0: 1000, index: 0, dt: [10, 10, 10], texts: ['a', 'b'] }])
  assert.equal(broken.complete, false, 'a broken dt run is reported rather than silently resynchronized')
  assert.equal(broken.chunks.length, 0)
})

// ---------------------------------------------------------------------------
// retainInfo semantics and source generation identity
// ---------------------------------------------------------------------------

test('retainInfo is observe-only: attaching subscribes once and retains nothing', () => {
  const { sessions, controller } = createNavigationController()
  const source = sessions.materialize(SESSION)
  source.replace(turnWindow('completed'), 7)

  /** The fake sessions object exposes no retain/release seam at all. */
  assert.equal(typeof sessions.retain, 'undefined')
  assert.equal(typeof sessions.retainScope, 'undefined')
  assert.equal(typeof sessions.retireScope, 'undefined')

  assert.equal(controller.attach(SESSION), true)
  const before = sessions.retainSnapshot(SESSION)
  assert.equal(before.referenceCount, 1, 'the scope was retained by the UI step, not by the plugin')
  assert.equal(sessions.retainListenerCount(SESSION), 1, 'the plugin owns exactly one retention observation')

  // Re-activating a live session is an idempotent authoritative window pass: no second watch.
  assert.equal(controller.attach(SESSION), true)
  assert.equal(sessions.retainListenerCount(SESSION), 1)
  assert.equal(source.listenerCount(), 1, 'exactly one eventSource subscription')
  assert.equal(controller.lifecycle().retentionWatches, 1)
  assert.deepEqual(
    sessions.retainSnapshot(SESSION),
    { referenceCount: 1, retainedBy: { mainView: 1 } },
    'subscribing to the retention snapshot changed no reference count',
  )
  controller.dispose()
})

test('a retired generation releases its watch, and the returning activation re-arms exactly one', () => {
  const { sessions, controller } = createNavigationController()
  const first = sessions.materialize(SESSION)
  first.replace(turnWindow('completed'), 7)
  assert.equal(controller.attach(SESSION), true)

  const settled = controller.project(SESSION, 9000)
  assert.equal(settled.kind, 'completed', 'the first generation settles to a completed card')
  assert.equal(controller.lifecycle().retentionWatches, 1)
  assert.equal(sessions.retainListenerCount(SESSION), 1)

  /**
   * Navigation away: DSH releases the last reference and retires the scope. The
   * retired generation can never publish again, so its eventSource listener is
   * released immediately and the plugin-owned retention watch is released too
   * (Phase 12.0R); what remains is bounded historical telemetry, not a live
   * subscription.
   */
  assert.equal(sessions.retire(SESSION), true)
  assert.equal(first.listenerCount(), 0, 'the retired generation keeps no plugin listener')
  assert.equal(sessions.retainListenerCount(SESSION), 0, 'the plugin-owned retention watch is released')
  assert.equal(controller.lifecycle().retentionWatches, 0)
  assert.equal(controller.diagnostics(SESSION).bindingPending, true, 'a missing binding is a state fact, not a live phase')
  /**
   * No live claim survives the retirement: the settled card is historical
   * telemetry and stays readable, while live phases (streaming, tool, waiting)
   * are suppressed because there is no generation that could authorise them.
   */
  const afterRetire = controller.project(SESSION, 9100)
  assert.equal(afterRetire.kind, 'completed', 'the settled card survives the retirement')
  assert.equal(afterRetire.status, 'completed')

  /**
   * Navigating back: DSH materializes a NEW scope whose Session owns a NEW
   * `MutableSessionEventSource` at revision 0, and the dock remounts, which is
   * the session activation that re-arms the watch. Identity — not revision — is
   * what the activation compares.
   */
  const second = sessions.materialize(SESSION)
  assert.notEqual(second, first, 'a new generation is a new source object')
  assert.equal(second.revision(), 0)
  assert.equal(controller.attach(SESSION), true, 'the returning dock mount runs a session activation')
  assert.equal(sessions.retainListenerCount(SESSION), 1, 'exactly one watch re-armed on the returning activation')
  assert.equal(controller.lifecycle().retentionWatches, 1)

  const awaiting = controller.diagnostics(SESSION)
  assert.equal(awaiting.bindingPending, false)
  assert.equal(awaiting.generationAwaiting, true, 'the empty revision-0 generation is deferred, not adopted')
  assert.equal(first.listenerCount(), 0)
  assert.equal(second.listenerCount(), 1, 'the new generation is subscribed once')
  assert.equal(controller.project(SESSION, 9200).kind, 'completed', 'the settled card survives the pre-history window')

  /** The first authoritative publication is adopted as the generation. */
  second.replace(turnWindow('completed'), 3)
  const adopted = controller.diagnostics(SESSION)
  assert.equal(adopted.generationAwaiting, false)
  assert.equal(adopted.bindingPending, false)
  assert.equal(adopted.lastFeedRevision, adopted.lastSourceRevision, 'the feed is resynchronized to the source')
  assert.equal(adopted.counters.eventSourceRebinds, 1, 'the generation change was a real rebind')
  assert.equal(second.listenerCount(), 1)
  assert.equal(controller.project(SESSION, 9300).kind, 'completed')
  controller.dispose()
})

test('a new session scope whose history arrives on the first publication adopts the same generation it deferred', () => {
  const { sessions } = createNavigationController()
  const controller = createController({ sessions })

  /** Activation before the scope is materialized: no binding, watch armed. */
  assert.equal(controller.attach(SESSION), false)
  assert.equal(controller.lifecycle().retentionWatches, 1, 'the binding-ready watch is the only live signal')

  const source = sessions.materialize(SESSION)
  source.replace([durableEntry('turn/start', 1, 1000, { turn: 1 })], 1)

  const diagnostics = controller.diagnostics(SESSION)
  assert.equal(diagnostics.bindingPending, false, 'the binding-ready edge resolved the pending state')
  assert.equal(diagnostics.lastFeedRevision, diagnostics.lastSourceRevision, 'the first publication is adopted authoritatively')
  assert.equal(source.listenerCount(), 1, 'the deferred generation was subscribed exactly once')
  assert.equal(controller.lifecycle().retentionWatches, 1, 'the binding-ready watch stayed armed')
  controller.dispose()
})
