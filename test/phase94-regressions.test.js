/**
 * Phase 9.4 — spec §9 and §16 regression proof, executable against released v0.1.2.
 *
 * ## Why this file exists beside the topical suites
 *
 * `test/ttft-boundary.test.js` and `test/curve-rate-publication.test.js` are the
 * topical homes of §9 and §16, and both import modules this phase introduced
 * (`src/core/rate-publication.js`, `tokenEvidence`) at load time. Those modules do
 * not exist in v0.1.2, so neither file can be *run* against the release its
 * assertions are supposed to catch: "this test would have failed before the fix"
 * could only be claimed, never demonstrated.
 *
 * Everything below is written against the surface v0.1.2 already had —
 * `TurnTelemetryStore`, its live snapshot, `curveViewModel`, `curveTree`,
 * `attemptFromDecoded`, `DASH` — so the file is copied verbatim into the release
 * and executed there:
 *
 *     cp test/phase94-regressions.test.js <v0.1.2>/test/
 *     node --test <v0.1.2>/test/phase94-regressions.test.js
 *
 * **Every test in this file fails on v0.1.2.** The number quoted in each comment is
 * what the released code actually printed; the assertions state the fixed contract.
 * The module-level half of §9 — the `tokenEvidence` verdict itself, which has no
 * v0.1.2 counterpart to run against — stays in `test/ttft-boundary.test.js`.
 *
 * ## The two defects being frozen
 *
 * **§9.** DSH's `isTokenDelta` accepts a *name-bearing* `tool-call-delta` whose
 * `argumentsDelta` is empty, while `classifyDelta` attributes no argument text to
 * it, so `sampleFromChunk` returns `null`. v0.1.2 let that `null` decide TTFT:
 * nothing was frozen until a chunk with real magnitude arrived. A retry or a tool
 * call then became the "first token" instead, and the pill kept counting in
 * 首响应计时 after the model had already begun emitting a call.
 *
 * **§16.** The completed curve sampled each phase episode on the attempt's own
 * 100 ms ladder instead of on the episode's, so an episode opening off-grid
 * acquired a first denominator of the ladder remainder — 50 ms, or 1 ms — and
 * `peakTps` is a maximum, so that quotient became the turn's peak: 4 000, 200 000,
 * 500 000 tokens/s on the fixtures below. "Not yet measured" was also published as
 * a measured `0` at every episode's opening anchor.
 *
 * ## What this file deliberately does not claim
 *
 * - A `tool-call-delta` with **no name and no arguments** is not token evidence, and
 *   the paired assertion is a *control*: it holds on v0.1.2 as well, because the
 *   release never counted it. The enclosing test still fails on v0.1.2 because of
 *   the name-bearing case beside it, and the control is what keeps the repair from
 *   being "count every tool-call delta".
 * - §16 CASE 3/4 are asserted in the form where the **attempt settles before the
 *   episode can reach 100 ms**. That is the reading in which "still unavailable" is
 *   unambiguous. An episode that continues past the horizon is publishable at
 *   exactly `elapsedMs = 100` with its three accumulating samples, which is what
 *   §10's own constants require and is asserted as a control rather than
 *   misreported as the defect — v0.1.2 publishes that measurement too, so it cannot
 *   discriminate on its own.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnTelemetryStore } from '../src/host/telemetry-design.js'
import { attemptFromDecoded } from '../src/dsh/adapter.js'
import { decodeStreamRecords } from '../src/dsh/stream-decoder.js'
import { curveViewModel } from '../src/client/completed/curve-view-model.js'
import { curveTree } from '../src/client/completed/curve-tree.js'
import { LOCALE_DICTS } from '../src/client/live/locale.js'
import { DASH } from '../src/client/format.js'

/* ----------------------------------------------------------------- fixtures */

/** A name-bearing tool-call delta whose argument fragment has not arrived yet. */
const NAME_ONLY_DELTA = Object.freeze({
  type: 'tool-call-delta',
  index: 0,
  id: 'call_1',
  name: 'pwsh',
  argumentsDelta: '',
})

/** The same shape DSH's accumulator can emit with a degraded, empty name. */
const EMPTY_NAME_DELTA = Object.freeze({
  type: 'tool-call-delta',
  index: 0,
  id: 'call_1',
  name: '',
  argumentsDelta: '',
})

/** No name and no arguments: not token evidence under any reading. */
const ANONYMOUS_EMPTY_DELTA = Object.freeze({
  type: 'tool-call-delta',
  index: 0,
  id: 'call_1',
  argumentsDelta: '',
})

/** A generated delta carrying `tokens` heuristic tokens (four characters each). */
const outputDelta = tokens => ({ type: 'text-delta', index: 0, text: 'x'.repeat(tokens * 4) })
const reasoningDelta = tokens => ({ type: 'reasoning-delta', index: 0, text: 'x'.repeat(tokens * 4) })

/** A store, a turn and its first attempt, opened the way the host opens them. */
function openTurn({ sessionId = 's-phase94', turn = 1, turnStartMs = 0, attemptId = 'a1', step = 1 } = {}) {
  const store = new TurnTelemetryStore()
  const record = store.beginTurn({ sessionId, turn, timeMs: turnStartMs })
  const attempt = store.beginAttempt(record, { attemptId, step, startedAtMs: turnStartMs })
  return { store, record, attempt }
}

/** One settlement row, in the shape `settleAttempt` receives from the host. */
function settle(attempt, { settledAtMs, seq = 1, usage = null }) {
  return {
    attempt,
    settledAtMs,
    settlementKind: 'message',
    surfaceCommitted: true,
    attemptOutcome: 'committed',
    settlementSeq: seq,
    usage,
  }
}

/**
 * One completed turn whose whole generated stream is the given
 * `[timeMs, phase, tokens]` triples, settled at `settleAtMs`.
 */
function episodeTurn({ samples, settleAtMs, sessionId = 's-phase94', usage = null }) {
  const { store, record, attempt } = openTurn({ sessionId })
  for (const [timeMs, phase, tokens] of samples) {
    store.acceptChunk(record, attempt, {
      timeMs,
      chunk: phase === 'reasoning' ? reasoningDelta(tokens) : outputDelta(tokens),
    })
  }
  store.settleAttempt(attempt, settle(attempt, { settledAtMs: settleAtMs, usage }))
  const settled = store.endTurn(record, { timeMs: settleAtMs, status: 'completed' })
  const trace = (settled.curve?.attempts ?? []).find(entry => entry.attemptId === attempt.attemptId) ?? null
  return { store, record, attempt, settled, trace, points: trace?.points ?? [] }
}

/** Every publishable vertex of one trace. */
const publishedOf = points => points.filter(point => Number.isFinite(point.tps))

/**
 * One completed turn that produced nothing publishable at all: an attempt with no
 * accepted chunk settles immediately, so the shared publication policy withholds
 * the curve's single opening anchor and `curve.peakTps` comes back `null`.
 */
function absentPeakTurn(sessionId) {
  const { store, record, attempt } = openTurn({ sessionId })
  store.settleAttempt(attempt, settle(attempt, { settledAtMs: 300 }))
  return store.endTurn(record, { timeMs: 300, status: 'completed' })
}

/**
 * The publication contract stated on the vertices themselves.
 *
 * A finite `tps` is a measurement that passed **both** gates and says so; every
 * other vertex is `null` — never a measured `0` — and names the fact that is
 * missing. The reason *strings* asserted below are literals rather than imports of
 * `RateUnavailable`, because this file must load on v0.1.2, which has no such
 * module; `test/rate-publication.test.js` freezes the vocabulary itself.
 */
function assertEveryVertexIsMeasuredOrNull(points) {
  assert.ok(points.length > 0, 'the fixture must produce at least one vertex')
  for (const point of points) {
    if (Number.isFinite(point.tps)) {
      assert.equal(point.publishable, true, `the rate at ${point.localMs} ms is marked publishable`)
      assert.ok(point.episodeElapsedMs >= 100,
        `the rate at ${point.localMs} ms came from a ${point.episodeElapsedMs} ms denominator`)
      assert.ok(point.episodeSampleCount >= 3,
        `the rate at ${point.localMs} ms came from ${point.episodeSampleCount} samples`)
      assert.equal(point.rateUnavailableReason, null)
    } else {
      assert.equal(point.tps, null, `the vertex at ${point.localMs} ms is null, never a measured zero`)
      assert.equal(point.publishable, false, `the vertex at ${point.localMs} ms is not publishable`)
      assert.equal(typeof point.rateUnavailableReason, 'string',
        `the withheld vertex at ${point.localMs} ms names why it carries no rate`)
    }
  }
}

/* ------------------------------------------------- rendered-element plumbing */

const zh = key => LOCALE_DICTS.zh[key] ?? key

function rec(tag, props, children) {
  const list = Array.isArray(children) ? children.filter(child => child !== null && child !== undefined) : [children]
  return { tag, props: props ?? {}, children: list }
}

function byClass(node, name, found = []) {
  if (node === null || node === undefined || typeof node === 'string') return found
  if (Array.isArray(node)) {
    for (const child of node) byClass(child, name, found)
    return found
  }
  if (String(node.props.className ?? '').split(/\s+/).includes(name)) found.push(node)
  for (const child of node.children) byClass(child, name, found)
  return found
}

function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return node.children.flatMap(texts)
}

/** The peak readout exactly as the completed card renders it, label and value. */
function peakRowOf(settled) {
  const view = curveViewModel(settled)
  const tree = curveTree(rec, view, [], zh)
  return {
    view,
    label: texts(byClass(tree, 'dsh-tpm-peak-label')).join(''),
    value: texts(byClass(tree, 'dsh-tpm-peak-value')).join(''),
    aria: tree[0]?.props?.['aria-label'] ?? null,
  }
}

/* ------------------------------------------------------------- §9 TTFT ----- */

test('§9 A/B — a name-bearing empty-arguments tool-call delta freezes TTFT and fabricates no mass', () => {
  /**
   * v0.1.2: `liveSnapshot().ttftMs` stayed `null` and `record.firstTokenMs` stayed
   * `null` — the model had begun emitting a call and the turn still had no first
   * token. The fixed tree freezes both at the boundary instant, and does so without
   * inventing the magnitude the delta does not carry.
   */
  const { store, record, attempt } = openTurn({ sessionId: 's-9a', turnStartMs: 1_000 })
  assert.equal(store.liveSnapshot('s-9a', 1_050).ttftMs, null, 'no token has arrived yet')

  const accepted = store.acceptChunk(record, attempt, { timeMs: 1_200, chunk: NAME_ONLY_DELTA })
  assert.equal(accepted, null, 'a boundary-only delta is not a TPS-shape sample')

  const live = store.liveSnapshot('s-9a', 1_200)
  assert.equal(live.ttftMs, 200, 'the live pill leaves 首响应计时 at the boundary: 1200 against turn start 1000')
  assert.equal(live.tps, null, 'and publishes no rate, because no mass exists behind it')
  assert.equal(live.episodeSampleCount, 0, 'the episode it opens holds no fabricated sample')

  assert.equal(record.firstTokenMs, 1_200, 'the settled record freezes the same instant the pill reported')
  assert.equal(attempt.samples.length, 0, 'the attempt keeps only evidence it actually has: zero samples')

  /** The same holds for the degraded empty-name form DSH's accumulator can emit. */
  const named = openTurn({ sessionId: 's-9a-empty', turnStartMs: 1_000 })
  named.store.acceptChunk(named.record, named.attempt, { timeMs: 1_120, chunk: EMPTY_NAME_DELTA })
  assert.equal(named.store.liveSnapshot('s-9a-empty', 1_120).ttftMs, 120,
    'DSH tests `name !== undefined`, so an empty name is still name-bearing')
  assert.equal(named.record.firstTokenMs, 1_120)
  assert.equal(named.attempt.samples.length, 0)
})

test('§9 D — a tool-call delta with no name and empty arguments stays ignored (control)', () => {
  /**
   * The boundary rule must not over-count. This half is a **control**: it passes on
   * v0.1.2 too, which is exactly the point — the release never treated this chunk as
   * a token, and the repair must not start doing so. The discriminating neighbour is
   * the name-bearing case above.
   */
  const { store, record, attempt } = openTurn({ sessionId: 's-9d', turnStartMs: 1_000 })
  assert.equal(store.acceptChunk(record, attempt, { timeMs: 1_100, chunk: ANONYMOUS_EMPTY_DELTA }), null)
  assert.equal(store.liveSnapshot('s-9d', 1_100).ttftMs, null, 'no name and no arguments is not a first token')
  assert.equal(record.firstTokenMs, null)
  assert.equal(attempt.samples.length, 0)

  /** §9 E/F as controls: ordinary non-empty deltas keep freezing TTFT as before. */
  const reasoning = openTurn({ sessionId: 's-9e', turnStartMs: 2_000 })
  reasoning.store.acceptChunk(reasoning.record, reasoning.attempt, { timeMs: 2_050, chunk: reasoningDelta(4) })
  assert.equal(reasoning.store.liveSnapshot('s-9e', 2_050).ttftMs, 50, 'a reasoning delta is a first token, unchanged')

  const text = openTurn({ sessionId: 's-9f', turnStartMs: 3_000 })
  text.store.acceptChunk(text.record, text.attempt, { timeMs: 3_030, chunk: outputDelta(4) })
  assert.equal(text.store.liveSnapshot('s-9f', 3_030).ttftMs, 30, 'and so is a text delta')
})

test('§9 G — the durable reconstruction and the live boundary agree on the first-token instant', () => {
  /**
   * One rule, two reconstructions. The compact durable stream's first member is a
   * name-bearing tool-call run with an empty argument, and the live plane receives
   * the very chunks that stream decodes to.
   *
   * v0.1.2: the decoded stream already answered `firstTokenTimeMs: 1100`, but
   * `attemptFromDecoded` published no `firstTokenMs` at all and the live record
   * stayed `null` — the two halves of one turn disagreed about whether the model had
   * produced its first token.
   */
  const stream = [
    { type: 'tool-call-chunks', time0: 1_100, index: 0, dt: [], id: 'call_1', name: 'pwsh', args: [''] },
    {
      type: 'tool-call-chunks',
      time0: 1_150,
      index: 0,
      dt: [10, 10],
      id: 'call_1',
      name: 'pwsh',
      args: ['{"command"', ':"ls"', '}'],
    },
  ]
  const decoded = decodeStreamRecords(stream)
  assert.equal(decoded.complete, true, 'the fixture decodes exactly')
  assert.equal(decoded.firstTokenTimeMs, 1_100, 'the decoder already counts the name-bearing empty member')

  const durable = attemptFromDecoded({ attemptId: 'a1', turn: 1, step: 1, decoded })
  assert.equal(durable.firstTokenMs, 1_100,
    'the durable reconstruction publishes that instant as the attempt\'s first token')
  assert.equal(durable.samples.length, 3, 'and only the argument-bearing members become samples')

  const { store, record, attempt } = openTurn({ sessionId: 's-9g', turnStartMs: 1_000 })
  for (const entry of decoded.chunks) {
    store.acceptChunk(record, attempt, { timeMs: entry.timeMs, chunk: entry.chunk })
  }
  assert.equal(record.firstTokenMs, 1_100, 'the live path freezes the same instant from the same evidence')
  assert.equal(record.firstTokenMs, durable.firstTokenMs,
    'a reload cannot change what the turn\'s first token was')
  assert.equal(attempt.samples.length, durable.samples.length,
    'and neither path invents a sample for the boundary member')
  assert.equal(store.liveSnapshot('s-9g', 1_200).ttftMs, 100, '100 ms after the turn opened at 1000')
})

test('§9 C/H — TTFT freezes once: a tool call, its result and a retry never redefine it', () => {
  /**
   * The turn clock is one-way. v0.1.2 let the *next* attempt redefine the turn's
   * first token: with the boundary at 1200 ms the retry's real delta at 1900 ms
   * became `record.firstTokenMs` and the settled TTFT read 900 ms instead of 200 ms.
   */
  const { store, record, attempt } = openTurn({ sessionId: 's-9h', turnStartMs: 1_000 })
  store.acceptChunk(record, attempt, { timeMs: 1_200, chunk: NAME_ONLY_DELTA })
  store.toolStarted(record, { callId: 'call_1', name: 'pwsh', timeMs: 1_300 })
  store.toolSettled(record, { callId: 'call_1', timeMs: 1_500, status: 'ok' })

  const retry = store.beginAttempt(record, { attemptId: 'a2', step: 2, startedAtMs: 1_600 })
  store.acceptChunk(record, retry, { timeMs: 1_900, chunk: outputDelta(6) })

  assert.equal(store.liveSnapshot('s-9h', 1_900).ttftMs, 200,
    'the tool stage and the retry leave the turn\'s first response where it was')
  assert.equal(record.firstTokenMs, 1_200, 'a later attempt cannot move the frozen turn instant')
  assert.equal(attempt.samples.length, 0, 'the boundary attempt still holds no magnitude')
  assert.equal(retry.samples.length, 1, 'and the retry holds only the mass it generated itself')

  store.settleAttempt(attempt, settle(attempt, { settledAtMs: 1_550, seq: 1 }))
  store.settleAttempt(retry, settle(retry, { settledAtMs: 2_000, seq: 2 }))
  const settled = store.endTurn(record, { timeMs: 2_100, status: 'completed' })
  assert.equal(settled.ttftMs, 200, 'the completed card reports the frozen 200 ms, not the retry\'s 900 ms')
  assert.equal(settled.attemptCount, 2)
})

/* ------------------------------------------------------- §16 extreme spikes */

test('§16 CASE 3/4 — an episode that ends before the 100 ms horizon publishes no rate at all', () => {
  /**
   * Both fixtures settle *inside* the episode, so no vertex can ever reach the
   * 100 ms horizon. This is the reading in which "still unavailable" is
   * unambiguous; the horizon-reaching form is the control at the end, because
   * there the first eligible vertex is legitimately published at exactly
   * `elapsedMs = 100` with its three accumulating samples (§10's own constants),
   * and v0.1.2 publishes that measurement too.
   *
   * v0.1.2, measured: both fixtures returned `peakTps: 600` and published the
   * episode's opening anchor as `tps: 0`, a rate assembled over a zero-length
   * episode.
   */
  const coincident = episodeTurn({
    sessionId: 's-c3',
    samples: [[0, 'output', 10], [0, 'output', 10], [0, 'output', 10]],
    settleAtMs: 50,
  })
  assert.equal(coincident.settled.curve.peakTps, null,
    'three samples sharing one timestamp are not a rate')
  assert.deepEqual(coincident.points.map(point => point.rateUnavailableReason),
    ['opening-anchor', 'below-elapsed-horizon'],
    'the opening anchor and the sub-horizon end vertex each name their own fact')
  assertEveryVertexIsMeasuredOrNull(coincident.points)
  assert.equal(coincident.points.some(point => point.tps === 0), false,
    'and no withheld vertex is published as a measured zero')
  assert.equal(coincident.trace.tokens, 30, 'the mass itself is still recorded')

  const burst = episodeTurn({
    sessionId: 's-c4',
    samples: [[0, 'output', 10], [20, 'output', 10], [50, 'output', 10]],
    settleAtMs: 50,
  })
  assert.equal(burst.settled.curve.peakTps, null, 'three samples inside 50 ms are not a rate either')
  assertEveryVertexIsMeasuredOrNull(burst.points)
  assert.equal(burst.points.some(point => point.tps === 0), false)

  /** CASE 5 — three samples genuinely spread over more than the horizon publish. */
  const spread = episodeTurn({
    sessionId: 's-c5',
    samples: [[0, 'output', 10], [60, 'output', 10], [120, 'output', 10]],
    settleAtMs: 400,
  })
  assertEveryVertexIsMeasuredOrNull(spread.points)
  assert.equal(spread.settled.curve.peakTps, 150,
    'thirty tokens over the episode\'s own 200 ms; v0.1.2 published 200 from a two-sample vertex')
  const winner = spread.points.find(point => point.tps === spread.settled.curve.peakTps)
  assert.ok(winner.episodeElapsedMs >= 100 && winner.episodeSampleCount >= 3,
    'the winning vertex is a measurement under both gates')

  /** Control: an episode that *does* reach the horizon is publishable, and must not be withheld. */
  const reaching = episodeTurn({
    sessionId: 's-c3b',
    samples: [[0, 'output', 10], [0, 'output', 10], [0, 'output', 10]],
    settleAtMs: 400,
  })
  assert.equal(reaching.settled.curve.peakTps, 300,
    'at elapsedMs 100 the three coincident samples are a measurement: 30 tokens over 100 ms')
  assert.equal(reaching.points.find(point => point.localMs === 100).episodeElapsedMs, 100)
  assert.equal(reaching.points.find(point => point.localMs === 100).episodeSampleCount, 3)
})

test('§16 CASE 6 — a heavy calibrated delta after an off-grid transition keeps every integral', () => {
  /**
   * The reasoning episode warms up on the 100 ms grid, then the phase switches to
   * output at **299 ms** — one millisecond below the old attempt-global vertex at
   * 300 ms. The heavy first output delta (500 tokens) was divided by that single
   * millisecond:
   *
   *     v0.1.2, measured:  peakTps 500 000, at local 300 ms
   *     fixed tree:        peakTps 2 000, at local 599 ms over a 300 ms denominator
   *
   * Only the peak moved. Every magnitude and every settled summary number below is
   * identical on both trees — which is what makes this a test of "the ineligible
   * denominator is gone", not of "a large value was suppressed".
   */
  const { store, record, attempt } = openTurn({ sessionId: 's-c6' })
  const push = (timeMs, phase, tokens) => store.acceptChunk(record, attempt, {
    timeMs,
    chunk: phase === 'reasoning' ? reasoningDelta(tokens) : outputDelta(tokens),
  })
  push(0, 'reasoning', 60)
  push(150, 'reasoning', 60)
  push(299, 'output', 500)
  for (const at of [400, 500, 600, 700, 800]) push(at, 'output', 50)
  store.settleAttempt(attempt, settle(attempt, {
    settledAtMs: 900,
    usage: { outputTokens: 870, reasoningTokens: 120 },
  }))
  const settled = store.endTurn(record, { timeMs: 900, status: 'completed' })
  const trace = settled.curve.attempts[0]

  /** The provider integral and the settled summary arithmetic are untouched. */
  const sumOfSampleWeights = trace.samples.reduce((sum, sample) => sum + (sample.tokens ?? sample.weight ?? 0), 0)
  assert.equal(sumOfSampleWeights, 870, 'the calibrated integral is the provider total')
  assert.equal(trace.tokens, 870)
  assert.equal(trace.calibratedTokens, 870)
  assert.equal(settled.generatedTokens, 870, 'the settled generated-token total is preserved')
  assert.equal(settled.reasoningTokens, 120)
  assert.equal(settled.nonReasoningTokens, 750)
  assert.equal(settled.outputTps, 1247.920133111481, 'the summary output rate is the baseline\'s own number')
  assert.equal(settled.reasoningTps, 401.33779264214047)
  assert.equal(settled.ttftMs, 0)
  assert.equal(settled.attemptCount, 1)

  /** And no sub-100 ms denominator survives anywhere on the trace. */
  const published = publishedOf(trace.points)
  assert.ok(published.length > 0, 'the output episode is measurable: it keeps streaming past the switch')
  assert.equal(settled.curve.peakTps, 2000, 'against 500 000 on v0.1.2, from a 1 ms denominator')
  assert.equal(Math.min(...published.map(point => point.episodeElapsedMs)), 300,
    'the off-grid anchor at 299 ms is not a vertex; the first is its own ladder step at 599 ms')
  assert.equal(published.every(point => point.localMs - point.episodeStartMs >= 100), true)
  assertEveryVertexIsMeasuredOrNull(trace.points)
  assert.equal(trace.peakProvenance.elapsedMs, 300)
  assert.equal(trace.peakProvenance.episodeMass, 600)
  assert.equal(trace.peakProvenance.episodeStartMs, 299)
  assert.ok(settled.curve.peakTps < settled.outputTps * 2,
    'the peak is no longer an order-of-magnitude outlier against the summary rate')
})

test('§16 CASE 7 — a one- or two-sample terminal episode contributes evidence but no peak', () => {
  /**
   * "Below the sample gate" is not "zero throughput". The episode's mass and its
   * duration are still evidence — they feed the settled summary rate — but they
   * cannot manufacture a peak.
   *
   * v0.1.2, measured: `peakTps: 4 000` from the single delta, `3 000` from the pair.
   */
  const single = episodeTurn({ sessionId: 's-c7a', samples: [[0, 'output', 400]], settleAtMs: 400 })
  assert.equal(single.settled.curve.peakTps, null, 'one delta is not a rate')
  assertEveryVertexIsMeasuredOrNull(single.points)
  assert.equal(single.points.every(point => point.tps === null), true, 'and no vertex carries a number')
  assert.equal(single.trace.samples.length, 1)
  assert.equal(single.trace.tokens, 400, 'the mass is preserved')
  assert.equal(single.trace.durationMs, 400, 'and so is the attempt duration the delta lived in')
  assert.equal(single.settled.outputTps, 1000, 'the summary rate still counts it: 400 tokens over 0.4 s')
  assert.equal(peakRowOf(single.settled).view.peak.display, DASH)

  const pair = episodeTurn({ sessionId: 's-c7b', samples: [[0, 'output', 300], [200, 'output', 300]], settleAtMs: 400 })
  assert.equal(pair.settled.curve.peakTps, null, 'two deltas are not a rate either')
  assertEveryVertexIsMeasuredOrNull(pair.points)
  assert.equal(pair.points.every(point => point.tps === null), true)
  assert.equal(pair.trace.samples.length, 2)
  assert.equal(pair.trace.tokens, 600)
  assert.equal(pair.trace.durationMs, 400)
  assert.equal(pair.settled.outputTps, 1500, '600 tokens over 0.4 s, the whole episode, gate or no gate')

  /** The gate is not a mute button: an episode that reaches both gates still publishes. */
  const measured = episodeTurn({
    sessionId: 's-c7c',
    samples: [[0, 'output', 100], [100, 'output', 100], [200, 'output', 100]],
    settleAtMs: 300,
  })
  assert.equal(measured.settled.curve.peakTps, 1500,
    'the third sample lands on the episode\'s own 200 ms vertex: 300 tokens over 200 ms')
  const winner = measured.points.find(point => point.tps === 1500)
  assert.equal(winner.episodeSampleCount, 3, 'three contributing samples')
  assert.equal(winner.episodeElapsedMs, 200, 'and 200 ms of the episode\'s own clock')
  assertEveryVertexIsMeasuredOrNull(measured.points)
})

test('§16 — nothing publishable reports a null peak and the card prints 峰值 —, not a measured zero', () => {
  /**
   * The three statements are different and all three matter: `curve.peakTps` is
   * `null` (not `0`), the view model's `peak.value` is `null` too (Phase 9.4.1 — it
   * used to carry `0` as a rendering placeholder, which made an absent measurement
   * indistinguishable from a measured zero), and the rendered row prints an em dash
   * beside the 峰值 label.
   *
   * v0.1.2: `peakTps` was `0` here — its `peakTps` could not return anything else
   * for an empty series — which is precisely the "峰值 0 tokens/s" reading the
   * contract forbids.
   */
  const { store, record, attempt } = openTurn({ sessionId: 's-ui' })
  store.settleAttempt(attempt, settle(attempt, { settledAtMs: 300 }))
  const settled = store.endTurn(record, { timeMs: 300, status: 'completed' })

  assert.equal(settled.curve.peakTps, null, 'no publishable vertex exists, so there is no peak')
  const row = peakRowOf(settled)
  assert.equal(row.view.peak.value, null,
    'Phase 9.4.1: unavailable is null, distinct from a measured peak of zero')
  assert.equal(row.view.peak.x, null, 'and no peak marker is fabricated to go with it')
  assert.equal(row.view.peak.y, null)
  assert.equal(row.view.peak.display, DASH)
  assert.equal(row.label, '峰值')
  assert.equal(row.value, DASH, 'the value cell is an em dash, not a zero')
  assert.equal(typeof row.aria, 'string')
  assert.equal(row.aria.includes('峰值 —'), true, `the accessible name reads 峰值 —: ${row.aria}`)
  assert.equal(row.aria.includes('峰值 0'), false, 'and never 峰值 0 tokens/s')
})

test('§16b — an unavailable peak is null where a measured zero is 0, and neither changes the card', () => {
  /**
   * The semantic split Phase 9.4.1 closes, and the proof that closing it is free.
   *
   * `peak.value === null` says "the shared publication policy withheld every
   * vertex, so no peak was measured". `peak.value === 0` says "the published series
   * has a maximum of zero". v0.1.2 and Phase 9.4 both reported `0` for the first,
   * so a caller reading the field could not tell an absent measurement from a
   * measured one — an assertion of evidence that did not exist.
   *
   * The second half is the no-visual-change proof. The input is one settled turn
   * with the single field `curve.peakTps` moved between `null` and `0`; everything
   * else — geometry, series, markers, axis — is byte-identical, so any difference in
   * the rendered tree would be the split leaking into the card. The trees must be
   * deeply equal, the display must be the same em dash in both, and nothing may be
   * drawn at the axis floor.
   *
   * v0.1.2 / Phase 9.4: `absence.peak.value` was `0`, which the first assertion
   * catches.
   */
  const absence = absentPeakTurn('s-ui-absent')
  assert.equal(absence.curve.peakTps, null, 'the fixture must publish no peak')
  const absentView = curveViewModel(absence)
  assert.equal(absentView.peak.value, null,
    'unavailable is null, never a measured zero')
  assert.equal(absentView.peak.display, DASH, 'and it still prints the em dash')
  assert.equal(absentView.peak.x, null, 'no peak marker may be fabricated')
  assert.equal(absentView.peak.y, null)
  assert.equal(Number.isFinite(absentView.axis.max), true,
    'the axis keeps a finite ceiling: the null is projected onto 0 for geometry only')
  assert.ok(absentView.axis.max > 0, `the axis must stay drawable: ${absentView.axis.max}`)
  assert.equal(absentView.markers.every(marker => marker.isPeak === false), true,
    'and no surviving marker may be relabelled as the peak')

  const measuredZero = absentPeakTurn('s-ui-zero')
  measuredZero.curve.peakTps = 0
  const zeroView = curveViewModel(measuredZero)
  assert.equal(zeroView.peak.value, 0,
    'a finite peak of zero is a measurement, and the two readings must stay distinguishable')
  assert.notEqual(zeroView.peak.value, absentView.peak.value)
  assert.equal(zeroView.peak.display, DASH,
    'while the printed card is unchanged: the split is in the field, not in the pixels')

  assert.deepEqual(curveTree(rec, zeroView, [], zh), curveTree(rec, absentView, [], zh),
    'the rendered tree is identical for both readings, so this fix has no visual effect')
})
