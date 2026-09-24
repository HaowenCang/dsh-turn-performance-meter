/**
 * View-model shaping: the live pill branch and — from Phase 4 — the completed
 * card branch, which is the only seam between a settled turn snapshot and the
 * React component.
 *
 * Everything the card displays is decided here, so these tests are where the
 * display contract lives: which values are published, which carry `≈`, which
 * render `—`, what the secondary lines say, and the fact that no fifth column
 * exists.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { liveViewModel, completedViewModel, completedStatusOf } from '../src/client/ui-model.js'
import { MetricQuality } from '../src/core/metric-quality.js'
import { QualityLevel } from '../src/core/quality-model.js'
import { loadFixture } from './helpers/fixtures.js'
import { durableSettledView } from './helpers/equivalence.js'

/** A quality object shaped exactly like `qualityAxes()` output. */
function quality(tokenTotalQuality, phaseSplitQuality) {
  return {
    tokenTotalQuality,
    phaseSplitQuality,
    temporalShapeQuality: QualityLevel.RECONSTRUCTED,
    approximateTokenTotal: tokenTotalQuality !== QualityLevel.EXACT,
    approximatePhaseSplit: phaseSplitQuality !== QualityLevel.EXACT,
    displayTokenTotal: tokenTotalQuality === QualityLevel.EXACT ? 'exact'
      : (tokenTotalQuality === QualityLevel.UNAVAILABLE ? 'unavailable' : 'approximate'),
    displayPhaseSplit: phaseSplitQuality === QualityLevel.EXACT ? 'exact'
      : (phaseSplitQuality === QualityLevel.UNAVAILABLE ? 'unavailable' : 'approximate'),
    notes: [],
  }
}

/** The reference-scale card: everything exact. */
function exactSettled(overrides = {}) {
  return {
    sessionId: 'session-1',
    turn: 12,
    status: 'completed',
    statusNote: null,
    reasoningTps: 345.123,
    reasoningTpsQuality: MetricQuality.EXACT,
    reasoningMs: 108_200,
    outputTps: 676.4,
    outputTpsQuality: MetricQuality.EXACT,
    outputMs: 25_400,
    phaseTokens: { reasoning: 37_498, output: 17_272 },
    generatedTokens: 54_770,
    observedGeneratedTokens: 54_770,
    turnElapsedMs: 133_600,
    ttftMs: 1440,
    attemptCount: 4,
    tools: { count: 4, completedCount: 4, workMs: 12_800, wallMs: 12_800, failedCount: 0, names: ['pwsh'] },
    quality: quality(QualityLevel.EXACT, QualityLevel.EXACT),
    consistencyIssues: [],
    ...overrides,
  }
}

const columnOf = (view, key) => view.columns.find(column => column.key === key)

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
  const view = completedViewModel(exactSettled())

  assert.deepEqual(view.columns.map(column => column.key), ['reasoningTps', 'outputTps', 'generatedTokens', 'ttft'])
  assert.equal(view.columns.length, 4, 'tool statistics must not become a fifth column')
  assert.equal(view.kind, 'completed')
  assert.equal(view.state, 'settled', 'the machine state both views expose')
  assert.equal(view.turn, 12)
  assert.equal(view.sessionId, 'session-1')

  // Exact values render bare: no `≈` anywhere in the four headlines.
  assert.equal(columnOf(view, 'reasoningTps').display, '345')
  assert.equal(columnOf(view, 'reasoningTps').approximate, false)
  assert.equal(columnOf(view, 'reasoningTps').unit, 'tokens/s')
  assert.equal(columnOf(view, 'outputTps').display, '676')
  assert.equal(columnOf(view, 'generatedTokens').display, '54,770')
  assert.equal(columnOf(view, 'generatedTokens').unit, 'tokens')
  assert.equal(columnOf(view, 'ttft').display, '1.44')
  assert.equal(columnOf(view, 'ttft').unit, 's')
})

test('the four secondary lines carry duration, tokens, elapsed and status', () => {
  const view = completedViewModel(exactSettled())
  assert.equal(columnOf(view, 'reasoningTps').secondary.text, '108.2s · 37,498')
  assert.equal(columnOf(view, 'outputTps').secondary.text, '25.4s · 17,272')
  assert.equal(columnOf(view, 'generatedTokens').secondary.kind, 'elapsed')
  assert.equal(columnOf(view, 'generatedTokens').secondary.display, '133.6s')
  assert.equal(columnOf(view, 'generatedTokens').secondary.ms, 133_600)
  assert.equal(columnOf(view, 'ttft').secondary.kind, 'status')
  assert.equal(columnOf(view, 'ttft').secondary.statusKey, 'status.completed')
  assert.equal(view.status, 'completed')
})

test('the elapsed secondary line keeps the second scale expected by the reference', () => {
  const twoMinutes = completedViewModel(exactSettled({ turnElapsedMs: 162_400 }))
  assert.equal(columnOf(twoMinutes, 'generatedTokens').secondary.display, '162.4s')
  const underAMinute = completedViewModel(exactSettled({ turnElapsedMs: 8_085 }))
  assert.equal(columnOf(underAMinute, 'generatedTokens').secondary.display, '8.1s')
  assert.equal(columnOf(underAMinute, 'generatedTokens').secondary.ms, 8_085)
})

test('an approximate total is prefixed with ≈ and is not the exact number', () => {
  const view = completedViewModel(exactSettled({
    generatedTokens: null,
    observedGeneratedTokens: 1_200,
    quality: quality(QualityLevel.PARTIAL, QualityLevel.ESTIMATED),
    phaseTokens: { reasoning: 700, output: 500 },
    reasoningTpsQuality: MetricQuality.ESTIMATED,
    outputTpsQuality: MetricQuality.ESTIMATED,
  }))
  const generated = columnOf(view, 'generatedTokens')
  assert.equal(generated.display, '≈1,200')
  assert.equal(generated.approximate, true)
  assert.equal(generated.value, 1_200)
  assert.equal(view.quality.displayTokenTotal, 'approximate')
  assert.equal(view.quality.overall, MetricQuality.ESTIMATED)
})

test('an unavailable total renders an em dash and never a zero', () => {
  const view = completedViewModel(exactSettled({
    generatedTokens: null,
    observedGeneratedTokens: 0,
    quality: quality(QualityLevel.UNAVAILABLE, QualityLevel.UNAVAILABLE),
    phaseTokens: { reasoning: null, output: null },
    reasoningTps: null,
    reasoningTpsQuality: MetricQuality.UNAVAILABLE,
    outputTps: null,
    outputTpsQuality: MetricQuality.UNAVAILABLE,
    reasoningMs: 0,
    outputMs: 0,
  }))
  for (const key of ['reasoningTps', 'outputTps', 'generatedTokens']) {
    const column = columnOf(view, key)
    assert.equal(column.display, '—', `${key} must be an em dash`)
    assert.equal(column.value, null)
    assert.equal(column.available, false)
    assert.notEqual(column.display, '0')
  }
  assert.equal(columnOf(view, 'reasoningTps').unit, null, 'an absent value has no unit')
})

test('a partially derived rate never prints one bare number and one approximate one', () => {
  const view = completedViewModel(exactSettled({
    quality: quality(QualityLevel.EXACT, QualityLevel.ESTIMATED),
    reasoningTpsQuality: MetricQuality.CALIBRATED,
    outputTpsQuality: MetricQuality.CALIBRATED,
    phaseTokens: { reasoning: 37_498, output: 17_272 },
    reasoningMs: 108_200,
    outputMs: 25_400,
  }))
  for (const key of ['reasoningTps', 'outputTps']) {
    const column = columnOf(view, key)
    assert.equal(column.approximate, true, `${key} carries ≈ because the split is not exact`)
    assert.equal(column.display.startsWith('≈'), true)
    assert.equal(column.secondary.approximate, true, 'the token count on the same chain carries ≈ too')
    assert.equal(column.secondary.text.startsWith('108.2s · ≈') || column.secondary.text.startsWith('25.4s · ≈'), true)
  }
  // The total is authoritative, so it stays bare: the axes are independent.
  assert.equal(columnOf(view, 'generatedTokens').display, '54,770')
  assert.equal(columnOf(view, 'generatedTokens').approximate, false)
})

test('a phase with no tokens shows the duration and an em dash, not a zero count', () => {
  const view = completedViewModel(exactSettled({
    quality: quality(QualityLevel.EXACT, QualityLevel.UNAVAILABLE),
    phaseTokens: { reasoning: 37_498, output: null },
    outputTps: null,
    outputTpsQuality: MetricQuality.UNAVAILABLE,
    outputMs: 25_400,
  }))
  assert.equal(columnOf(view, 'reasoningTps').secondary.text, '108.2s · ≈37,498')
  assert.equal(columnOf(view, 'outputTps').secondary.text, '25.4s · —')
})

test('a phase with no evidence at all omits the secondary line instead of inventing one', () => {
  const view = completedViewModel(exactSettled({
    reasoningTps: null,
    reasoningTpsQuality: MetricQuality.UNAVAILABLE,
    reasoningMs: 0,
    phaseTokens: { reasoning: null, output: 17_272 },
  }))
  assert.equal(columnOf(view, 'reasoningTps').secondary, null)
  assert.equal(columnOf(view, 'reasoningTps').display, '—')
})

test('tool statistics stay on the footer and never become a column', () => {
  const view = completedViewModel(exactSettled())
  assert.equal(view.tools.count, 4)
  assert.equal(view.tools.wallMs, 12_800)
  assert.equal(view.tools.wallDisplay, '12.8s')
  assert.equal(view.tools.workMs, 12_800)
  assert.equal(view.columns.some(column => column.key.includes('tool')), false)
  assert.equal(columnOf(view, 'ttft').secondary.kind, 'status')
})

test('a turn with no tool call reports zero tools so the footer can hide the item', () => {
  const view = completedViewModel(exactSettled({ tools: { count: 0, wallMs: 0, workMs: 0, names: [] } }))
  assert.equal(view.tools.count, 0)
  assert.equal(view.tools.wallDisplay, '0.0s')
  assert.equal(view.columns.length, 4, 'no tools still does not change the column set')
})

test('turn status is the settlement status, including max-tokens as its own label', () => {
  assert.deepEqual(completedStatusOf('completed', null), { kind: 'completed', detail: null, tone: 'neutral' })
  assert.equal(completedStatusOf('interrupted', 'aborted:user').kind, 'interrupted')
  assert.equal(completedStatusOf('interrupted', 'aborted:user').detail, 'aborted:user')
  assert.equal(completedStatusOf('interrupted', 'aborted:user').tone, 'warn')
  assert.equal(completedStatusOf('errored', 'RATE_LIMIT').tone, 'error')
  assert.equal(completedStatusOf('completed', 'max-tokens').kind, 'max-tokens',
    'a truncated turn is completed but must not read as an unqualified completion')

  const truncated = completedViewModel(exactSettled({ statusNote: 'max-tokens' }))
  assert.equal(truncated.status, 'max-tokens')
  assert.equal(columnOf(truncated, 'ttft').secondary.statusKey, 'status.max-tokens')
  assert.equal(columnOf(truncated, 'ttft').secondary.tone, 'warn')
})

test('an errored turn is still a full card: status never removes the metrics', () => {
  const view = completedViewModel(exactSettled({ status: 'errored', statusNote: 'RATE_LIMIT' }))
  assert.equal(view.status, 'errored')
  assert.equal(view.columns.length, 4)
  assert.equal(columnOf(view, 'generatedTokens').display, '54,770')
  assert.equal(columnOf(view, 'ttft').secondary.detail, 'RATE_LIMIT')
  assert.equal(columnOf(view, 'ttft').secondary.tone, 'error')
})

test('missing TTFT renders an em dash while the rest of the card stays intact', () => {
  const view = completedViewModel(exactSettled({ ttftMs: null }))
  assert.equal(columnOf(view, 'ttft').display, '—')
  assert.equal(columnOf(view, 'ttft').available, false)
  assert.equal(columnOf(view, 'ttft').unit, null)
  assert.equal(columnOf(view, 'generatedTokens').display, '54,770')
})

test('the view model keeps the curve for Phase 5 and the projection identity for the cache', () => {
  const withCurve = completedViewModel(exactSettled({ curve: { durationMs: 1000, segments: [], reasoning: [], output: [], peakTps: 0 } }))
  assert.equal(withCurve.curve.durationMs, 1000)
  assert.equal(withCurve.projectionKey, 'completed:session-1:12')
  const withoutCurve = completedViewModel(exactSettled())
  assert.equal(withoutCurve.curve, null, 'a turn with no recorded shape has no curve object')
})

test('consistency issues travel with the view model without becoming visible copy', () => {
  const issue = 'attempt a1: provider reported reasoningTokens=0 but the stream carries non-empty reasoning deltas'
  const view = completedViewModel(exactSettled({
    consistencyIssues: [issue],
    quality: quality(QualityLevel.EXACT, QualityLevel.ESTIMATED),
    reasoningTpsQuality: MetricQuality.ESTIMATED,
  }))
  assert.deepEqual(view.consistencyIssues, [issue])
  /** The conflict reaches the numbers as a downgrade, not as a banner. */
  assert.equal(columnOf(view, 'reasoningTps').approximate, true)
  assert.equal(columnOf(view, 'reasoningTps').display.startsWith('≈'), true)
  assert.equal(columnOf(view, 'generatedTokens').display, '54,770', 'the authoritative total is untouched')
  const rendered = JSON.stringify(view.columns)
  assert.equal(rendered.includes('reasoningTokens=0'), false, 'no technical notice leaks into the four cells')
  assert.equal(rendered.includes('consistency'), false)
})

test('an exact rate over a non-exact split keeps the reference shape: bare rate, approximate count', () => {
  /**
   * `phaseSplitQuality` qualifies the reasoning/output *division*. When the rate
   * itself is anchored to an exact total over complete measured timing it stays
   * exact, so the headline number is bare while the count it divides carries `≈`.
   * This is the one arrangement that looks asymmetrical and is nevertheless
   * correct: they are two different derivation chains.
   */
  const view = completedViewModel(exactSettled({
    quality: quality(QualityLevel.EXACT, QualityLevel.ESTIMATED),
    reasoningTpsQuality: MetricQuality.EXACT,
    outputTpsQuality: MetricQuality.EXACT,
  }))
  assert.equal(columnOf(view, 'reasoningTps').display, '345')
  assert.equal(columnOf(view, 'reasoningTps').approximate, false)
  assert.equal(columnOf(view, 'reasoningTps').secondary.text, '108.2s · ≈37,498')
  assert.equal(columnOf(view, 'reasoningTps').secondary.approximate, true)
})

test('the card is a pure function of the settled snapshot', () => {
  const settled = exactSettled()
  const before = JSON.stringify(settled)
  const first = completedViewModel(settled)
  const second = completedViewModel(settled)
  assert.equal(JSON.stringify(settled), before, 'the view model must not mutate its input')
  assert.deepEqual(first, second, 'same snapshot, same view model')
})

test('every recorded fixture produces a card whose four columns are well formed', () => {
  for (const name of ['t1-reasoning-tool-reasoning', 't2-pwsh-write-edit', 't3-interrupted-mid-reasoning',
    't4-reasoning-tool-deepseek-official', 't5-reasoning-text-deepseek-official']) {
    const view = completedViewModel(durableSettledView(loadFixture(name)).settled)
    assert.ok(view, `${name}: the card must exist`)
    assert.deepEqual(view.columns.map(column => column.key), ['reasoningTps', 'outputTps', 'generatedTokens', 'ttft'])
    for (const column of view.columns) {
      const text = String(column.display)
      assert.equal(/NaN|Infinity|undefined|null/.test(text), false, `${name}/${column.key}: unusable display "${text}"`)
      assert.notEqual(text, '0 tokens/s', `${name}/${column.key}: zero is never a substitute for unknown`)
      if (column.display === '—') {
        assert.equal(column.available, false)
        assert.equal(column.unit, null)
      } else {
        assert.equal(column.available, true)
        if (column.display.startsWith('≈')) assert.equal(column.approximate, true, `${name}/${column.key}: ≈ implies approximate`)
        else assert.equal(column.approximate, false, `${name}/${column.key}: a bare number must be exact`)
      }
      if (column.secondary !== null && column.secondary.kind === 'phase') {
        assert.equal(/NaN|Infinity|undefined/.test(column.secondary.text), false)
        /**
         * The consistency rule, per line: the duration and the token count of one
         * phase are one derivation chain, so an approximate count may never be
         * printed without its own `≈`. The *rate* above the line follows its own
         * quality, because a rate can be unmeasurable even when its numerator is
         * an exact provider counter.
         */
        const tokensPart = column.secondary.text.split('· ')[1]
        if (column.secondary.approximate) {
          assert.equal(tokensPart.startsWith('≈'), true, `${name}/${column.key}: an approximate count needs ≈`)
        } else {
          assert.equal(tokensPart.startsWith('≈'), false, `${name}/${column.key}: an exact count must be bare`)
        }
        assert.equal(tokensPart === '—', !/\d/.test(tokensPart), `${name}/${column.key}: a missing count is an em dash`)
      }
    }
  }
})
