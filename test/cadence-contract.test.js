/**
 * The presentation-cadence contract: where the number is allowed to live.
 *
 * Presentation cadence and metric cadence are different concepts that happen to
 * be expressed in milliseconds, and Phase 5 collapsed them in one place: core
 * `LiveMeter` carried a `refreshMs` option, `TurnTelemetryStore` passed one
 * through, and neither drove a timer. The store's contract then read as if the
 * core scheduled the screen. Phase 6 removed both.
 *
 * This file is a **source-level** test on purpose. A behavioural test cannot
 * catch a dead option: the option existed for months without changing a single
 * rendered frame, which is precisely why it survived. What is assertable is
 * where the numbers appear in the source graph — so the assertions below read
 * the files.
 *
 * Three numbers are legitimate and are checked as allowed:
 *
 *   - `50` — the selected presentation cadence, only in `src/client/live/cadence.js`
 *     (the reference list of measured candidates also names the 200 ms and 10 ms
 *     values, because a record of an A/B test is not a second definition);
 *   - `1000` — the rolling window a rate is *measured* over (`src/core/curve.js`,
 *     `src/core/sliding-window.js`). It is a metric definition;
 *   - `250` — the completed curve's sampling cadence (`src/core/curve.js`). It is
 *     also a metric definition: how often a measurement is recorded, not how
 *     often a screen is painted.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PRESENTATION_REFRESH_MS,
  PRESENTATION_REFRESH_CANDIDATES_MS,
  REFRESH_OVERRIDE_STORAGE_KEY,
  resolvePresentationRefreshMs,
} from '../src/client/live/cadence.js'
import { DEFAULT_SAMPLE_EVERY_MS, DEFAULT_WINDOW_MS } from '../src/core/curve.js'
import { LiveMeter } from '../src/core/live-metrics.js'
import { TurnTelemetryStore } from '../src/host/telemetry-design.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every `.js` source file under one directory, recursively. */
function sourceFiles(...segments) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.js')) out.push(path)
    }
  }
  walk(join(ROOT, ...segments))
  return out
}

/**
 * Source with comments and string literals removed.
 *
 * The contract under test is about *code*: a module may — and these modules do —
 * document in prose that a value is deliberately not a UI cadence, and that is the
 * opposite of a violation. Stripping comments and strings also means a mention of
 * `refreshMs` inside a message cannot satisfy a search for the option.
 */
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

const CORE_FILES = sourceFiles('src', 'core')
const HOST_FILES = sourceFiles('src', 'host')
const CLIENT_FILES = sourceFiles('src', 'client')

test('the core engine contains no presentation cadence at all', () => {
  assert.ok(CORE_FILES.length > 0)
  for (const file of CORE_FILES) {
    const source = code(file)
    const where = relative(ROOT, file).replaceAll('\\', '/')
    assert.equal(/presentation/i.test(source), false,
      `${where} mentions presentation in code: the core engine owns no screen`)
    assert.equal(/refreshMs/.test(source), false,
      `${where} still carries a refreshMs contract: metric timing is not UI timing`)
    assert.equal(/setInterval|setTimeout|requestAnimationFrame/.test(source), false,
      `${where} schedules a timer: the core must remain pure`)
    assert.equal(/DEFAULT_PRESENTATION_REFRESH_MS/.test(source), false,
      `${where} imports the presentation cadence`)
  }
})

test('the host store routes facts and owns no cadence either', () => {
  for (const file of HOST_FILES) {
    const source = code(file)
    const where = relative(ROOT, file).replaceAll('\\', '/')
    assert.equal(/refreshMs/.test(source), false, `${where} still carries refreshMs`)
    assert.equal(/setInterval|setTimeout|requestAnimationFrame/.test(source), false,
      `${where} schedules a timer`)
    assert.equal(/DEFAULT_PRESENTATION_REFRESH_MS/.test(source), false,
      `${where} imports the presentation cadence`)
  }
})

test('the 50 ms cadence is defined once and only in cadence.js', () => {
  const allowedSites = []
  for (const file of CLIENT_FILES) {
    const source = code(file)
    const where = relative(ROOT, file).replaceAll('\\', '/')
    /**
     * A bare `50` in client code could be a pixel, a percentage or a rounding
     * constant, so the search is for the shapes that mean *interval*: `50` assigned
     * to a time-named identifier, or handed to `setInterval` as its delay. The
     * candidate list `[200, 50, 10]` is an array of measurements rather than an
     * assignment to one, so it is deliberately not matched — and the 200 in it is
     * why a plain "the file contains 200" check would be wrong.
     */
    const cadenceLike = /(?:interval|refresh|delay|timeout|cadence)\w*\s*[:=]\s*50\b/i.test(source)
      || /setInterval\([^)]*,\s*50\b/.test(source)
    if (cadenceLike) allowedSites.push(where)
  }
  assert.deepEqual(allowedSites, ['src/client/live/cadence.js'],
    'the selected cadence is declared in one place; everything else imports it')
})

test('the live scheduler and the controller both take the cadence from cadence.js', () => {
  const scheduler = readFileSync(join(ROOT, 'src', 'client', 'live', 'refresh.js'), 'utf8')
  const controller = readFileSync(join(ROOT, 'src', 'client', 'live', 'controller.js'), 'utf8')
  for (const [where, source] of [['refresh.js', scheduler], ['controller.js', controller]]) {
    assert.match(source, /from '\.\/cadence\.js'/, `${where} imports the cadence module`)
    assert.match(source, /DEFAULT_PRESENTATION_REFRESH_MS/, `${where} uses the shared constant`)
  }
})

test('the cadence module declares the selected value and the measured candidates', () => {
  assert.equal(DEFAULT_PRESENTATION_REFRESH_MS, 50)
  assert.deepEqual(PRESENTATION_REFRESH_CANDIDATES_MS, [200, 50, 10],
    'the A/B record is retained; it is evidence, not a second definition')
  assert.equal(REFRESH_OVERRIDE_STORAGE_KEY.startsWith('dsh-turn-performance-meter.'), true)
})

test('a stored override is coerced, so a broken value cannot take the scheduler down', () => {
  for (const bad of [undefined, null, '', 'abc', Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    assert.equal(resolvePresentationRefreshMs(bad), DEFAULT_PRESENTATION_REFRESH_MS,
      `${String(bad)} resolves to the production cadence`)
  }
  assert.equal(resolvePresentationRefreshMs('10'), 10, 'a debug override is still honoured')
})

test('core LiveMeter has no presentation concept, and the window is a definition', () => {
  const meter = new LiveMeter()
  assert.equal(meter.windowMs, DEFAULT_WINDOW_MS)
  assert.equal('refreshMs' in meter, false,
    'the meter owns no refresh interval; removing the option is what makes that structural')
  assert.equal(Object.hasOwn(meter, 'refreshMs'), false)

  /**
   * A caller cannot re-introduce one by hand: whatever it passes is ignored,
   * because there is nothing to store it in.
   */
  const configured = new LiveMeter({ windowMs: 500, refreshMs: 5 })
  assert.equal(configured.windowMs, 500)
  assert.equal('refreshMs' in configured, false)

  /** The window is the only timing number core accepts, and it is validated. */
  assert.throws(() => new LiveMeter({ windowMs: 0 }), TypeError)
  assert.throws(() => new LiveMeter({ windowMs: Number.NaN }), TypeError)
})

test('the store exposes a window option and no cadence option', () => {
  const store = new TurnTelemetryStore()
  assert.equal(store.windowMs, DEFAULT_WINDOW_MS, 'the default window is the metric contract')
  assert.equal('refreshMs' in store, false)
  assert.equal(store.live('s1').windowMs, DEFAULT_WINDOW_MS)

  const tuned = new TurnTelemetryStore({ windowMs: 400 })
  assert.equal(tuned.windowMs, 400)
  assert.equal(tuned.live('s1').windowMs, 400, 'the window reaches the per-session meter')

  /** A `refreshMs` a caller passes is inert rather than silently half-honoured. */
  const ignored = new TurnTelemetryStore({ refreshMs: 7 })
  assert.equal('refreshMs' in ignored, false)
  assert.equal(ignored.live('s1').windowMs, DEFAULT_WINDOW_MS)
})

test('the curve sampling cadence is a metric constant in the core, not a UI cadence', () => {
  assert.equal(DEFAULT_SAMPLE_EVERY_MS, 250)
  assert.equal(DEFAULT_WINDOW_MS, 1000)
  const curve = readFileSync(join(ROOT, 'src', 'core', 'curve.js'), 'utf8')
  assert.match(curve, /export const DEFAULT_WINDOW_MS = 1000/)
  assert.match(curve, /export const DEFAULT_SAMPLE_EVERY_MS = 250/)
  /**
   * And the curve module states the separation, so a future reader does not
   * "unify" the two numbers.
   */
  assert.match(curve, /presentation cadence|client\/live\/cadence\.js/,
    'curve.js records why its cadence is not the UI cadence')
})

test('the 1000 ms window is declared in the metric modules the spec names', () => {
  const sliding = readFileSync(join(ROOT, 'src', 'core', 'sliding-window.js'), 'utf8')
  assert.match(sliding, /constructor\(windowMs = 1000\)/)
  const store = readFileSync(join(ROOT, 'src', 'host', 'telemetry-design.js'), 'utf8')
  assert.match(store, /CURVE_WINDOW_MS|DEFAULT_WINDOW_MS/,
    'the store takes the window from the core constant rather than re-typing it')
})
