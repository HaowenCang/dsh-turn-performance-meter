import test from 'node:test'
import assert from 'node:assert/strict'
import { liveViewModel, completedViewModel } from '../src/client/ui-model.js'
import { MetricQuality } from '../src/core/metric-quality.js'

test('no turn means nothing is rendered', () => {
  assert.deepEqual(liveViewModel(null), { kind: 'hidden' })
  assert.deepEqual(liveViewModel({ phase: 'idle' }), { kind: 'hidden' })
  assert.deepEqual(liveViewModel({ phase: 'settled', turn: 1 }), { kind: 'hidden' })
})

test('pending shows a running TTFT counter, not a rate', () => {
  const view = liveViewModel({ turn: 4, phase: 'pending', ttftMs: null, turnElapsedMs: 2800 })
  assert.equal(view.kind, 'ttft')
  assert.equal(view.ttft.value, null)
  assert.equal(view.ttft.available, false)
  assert.equal(view.turnElapsed.value, 2800)
})

test('streaming shows the live TPS with its quality and never a curve', () => {
  const view = liveViewModel({
    turn: 4,
    phase: 'streaming',
    tps: 338.4,
    tpsQuality: MetricQuality.ESTIMATED,
    activePhase: 'output',
    turnElapsedMs: 14_300,
  })
  assert.equal(view.kind, 'streaming')
  assert.equal(view.tps.value, 338.4)
  assert.equal(view.tps.quality, MetricQuality.ESTIMATED)
  assert.equal(view.activePhase, 'output')
  assert.equal('curve' in view, false, 'live mode has no curve')
})

test('a tool phase shows the tool timer and no TPS at all', () => {
  const single = liveViewModel({
    turn: 4,
    phase: 'tool',
    tps: null,
    runningToolCount: 1,
    runningToolNames: ['pwsh'],
    toolElapsedMs: 2310,
    turnElapsedMs: 17_900,
  })
  assert.equal(single.kind, 'tool')
  assert.equal(single.label, 'pwsh')
  assert.equal(single.toolElapsed.value, 2310)

  const parallel = liveViewModel({
    turn: 4,
    phase: 'tool',
    runningToolCount: 2,
    runningToolNames: ['read', 'grep'],
    toolElapsedMs: 900,
    turnElapsedMs: 1000,
  })
  assert.equal(parallel.label, 'Tools 2')
})

test('only the three settled statuses produce a completed card', () => {
  assert.equal(completedViewModel(null), null)
  assert.equal(completedViewModel({ status: 'running' }), null)
  for (const status of ['completed', 'interrupted', 'errored']) {
    assert.equal(completedViewModel({ status, turn: 1, tools: {} }).status, status)
  }
})

test('the completed card always has the four fixed principal columns in order', () => {
  const view = completedViewModel({
    status: 'completed',
    turn: 12,
    reasoningTps: 345,
    reasoningTpsQuality: MetricQuality.EXACT,
    reasoningMs: 108_200,
    reasoningTokens: 37_498,
    outputTps: 676,
    outputTpsQuality: MetricQuality.EXACT,
    outputMs: 25_400,
    nonReasoningTokens: 17_272,
    generatedTokens: 54_770,
    generatedTokensQuality: MetricQuality.EXACT,
    ttftMs: 1440,
    turnElapsedMs: 133_600,
    tools: { count: 4, workMs: 12_800, wallMs: 12_800, names: ['pwsh'] },
  })
  assert.deepEqual(view.columns.map(c => c.key), ['reasoningTps', 'outputTps', 'generatedTokens', 'ttft'])
  assert.equal(view.columns.length, 4, 'tool statistics must not become a fifth column')
  assert.equal(view.columns[0].secondary.text, '108.2s · 37,498')
  assert.equal(view.columns[2].secondary.label, 'elapsed')
  assert.equal(view.columns[3].secondary.wallMs, 12_800)
  assert.equal(view.detail.toolWorkMs, 12_800)
})

test('an incomplete turn total is shown as approximate rather than as the exact number', () => {
  const view = completedViewModel({
    status: 'completed',
    turn: 1,
    generatedTokens: null,
    generatedTokensQuality: MetricQuality.ESTIMATED,
    observedGeneratedTokens: 1200,
    tools: {},
  })
  const column = view.columns.find(c => c.key === 'generatedTokens')
  assert.equal(column.value.available, false)
  assert.equal(column.approximate, true)
  assert.equal(column.fallbackValue, 1200)
})

test('missing reasoningTokens leaves the split unavailable without touching the total', () => {
  const view = completedViewModel({
    status: 'completed',
    turn: 1,
    generatedTokens: 1000,
    generatedTokensQuality: MetricQuality.EXACT,
    reasoningTokens: null,
    reasoningTps: null,
    reasoningTpsQuality: MetricQuality.UNAVAILABLE,
    nonReasoningTokens: null,
    outputTps: null,
    outputTpsQuality: MetricQuality.UNAVAILABLE,
    tools: {},
  })
  assert.equal(view.columns[0].value.available, false)
  assert.equal(view.columns[0].value.quality, MetricQuality.UNAVAILABLE)
  assert.equal(view.columns[2].value.value, 1000, 'the total stays exact')
})

test('interruption status reaches both the detail line and assistive text', () => {
  const view = completedViewModel({
    status: 'interrupted',
    statusNote: 'aborted:user',
    turn: 1,
    tools: {},
  })
  assert.equal(view.statusDetail, 'interrupted · aborted:user')
  assert.equal(view.columns[3].secondary.status, 'interrupted')
})
