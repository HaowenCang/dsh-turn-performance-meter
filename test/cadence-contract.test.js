/**
 * The presentation-cadence contract: where the number is allowed to live.
 *
 * Presentation cadence and metric cadence are different concepts that happen to
 * be expressed in milliseconds. Phase 6 removed the dead `refreshMs` option from
 * the core and the store; Phase 9.2 removed the trailing window itself
 * (`windowMs`, `SlidingWindowMeter`, `DEFAULT_WINDOW_MS`) and moved the selected
 * presentation cadence to 100 ms. What remains must be exactly:
 *
 *   - `100` — the selected presentation cadence, only in
 *     `src/client/live/cadence.js` (whose candidate list also records the
 *     measured 200 / 50 / 10 ms values, because a record of an A/B run is not a
 *     second definition);
 *   - `100` — the completed curve's sampling cadence
 *     (`DEFAULT_SAMPLE_EVERY_MS` in `src/core/curve.js`). It is a metric
 *     definition: how often a measurement is recorded, not how often a screen
 *     is painted. The two are documented as different concepts in the cadence
 *     module.
 *
 * This file is a **source-level** test on purpose. A behavioural test cannot
 * catch a dead option: the `refreshMs` option existed for months without
 * changing a single rendered frame, which is precisely why it survived. What is
 * assertable is where the numbers appear in the source graph.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PRESENTATION_REFRESH_MS,
  PRESENTATION_REFRESH_CANDIDATES_MS,
  REFRESH_OVERRIDE_STORAGE_KEY,
  resolvePresentationRefreshMs,
} from '../src/client/live/cadence.js'
import * as curveModule from '../src/core/curve.js'
import * as coreIndex from '../src/core/index.js'
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

test('the 100 ms cadence is defined once and only in cadence.js', () => {
  const allowedSites = []
  for (const file of CLIENT_FILES) {
    const source = code(file)
    const where = relative(ROOT, file).replaceAll('\\', '/')
    /**
     * A bare `100` in client code could be a pixel, a percentage or a rounding
     * constant, so the search is for the shapes that mean *interval*: `100`
     * assigned to a time-named identifier, or handed to `setInterval` as its
     * delay. The candidate list `[200, 100, 50, 10]` is an array of measurements
     * rather than an assignment to one, so it is deliberately not matched.
     */
    const cadenceLike = /(?:interval|refresh|delay|timeout|cadence)\w*\s*[:=]\s*100\b/i.test(source)
      || /setInterval\([^)]*,\s*100\b/.test(source)
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
  assert.equal(DEFAULT_PRESENTATION_REFRESH_MS, 100)
  assert.deepEqual(PRESENTATION_REFRESH_CANDIDATES_MS, [200, 100, 50, 10],
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

test('core LiveMeter takes no options and owns no timing contract', () => {
  const meter = new LiveMeter()
  assert.equal('windowMs' in meter, false, 'the trailing window is gone')
  assert.equal('refreshMs' in meter, false, 'the meter owns no refresh interval')
  assert.equal('meter' in meter, false, 'no sliding-window sub-meter remains')
  assert.equal(LiveMeter.length, 0, 'the constructor declares no options at all')

  /**
   * A caller cannot re-introduce one by hand: whatever it passes is ignored,
   * because there is nothing to store it in.
   */
  const configured = new LiveMeter({ windowMs: 500, refreshMs: 5 })
  assert.equal('windowMs' in configured, false)
  assert.equal('refreshMs' in configured, false)
  assert.deepEqual(configured.snapshot(1), { phase: 'idle' })
})

test('the store exposes neither a window nor a cadence option', () => {
  const store = new TurnTelemetryStore()
  assert.equal('windowMs' in store, false, 'Phase 9.2 removed the window option')
  assert.equal('refreshMs' in store, false, 'the store schedules nothing')

  /** Whatever a caller passes is inert rather than silently half-honoured. */
  const ignored = new TurnTelemetryStore({ windowMs: 400, refreshMs: 7 })
  assert.equal('windowMs' in ignored, false)
  assert.equal('refreshMs' in ignored, false)

  const meter = ignored.live('s1')
  assert.ok(meter instanceof LiveMeter, 'the store creates the optionless meter')
  assert.equal('windowMs' in meter, false)
})

test('the curve sampling cadence is a metric constant in the core, not a UI cadence', () => {
  assert.equal(curveModule.DEFAULT_SAMPLE_EVERY_MS, 100)
  const curve = readFileSync(join(ROOT, 'src', 'core', 'curve.js'), 'utf8')
  assert.match(curve, /export const DEFAULT_SAMPLE_EVERY_MS = 100/)
  /**
   * And the separation is stated where a future reader might "unify" the two
   * numbers: the cadence module names `DEFAULT_SAMPLE_EVERY_MS` and says it is a
   * different concept.
   */
  const cadence = readFileSync(join(ROOT, 'src', 'client', 'live', 'cadence.js'), 'utf8')
  assert.match(cadence, /DEFAULT_SAMPLE_EVERY_MS/, 'cadence.js records why its number is not the curve sampling')
})

test('no trailing window remains anywhere in the rate path', () => {
  assert.equal(existsSync(join(ROOT, 'src', 'core', 'sliding-window.js')), false,
    'SlidingWindowMeter and its module were removed in Phase 9.2')

  for (const file of [...CORE_FILES, ...HOST_FILES]) {
    const source = code(file)
    const where = relative(ROOT, file).replaceAll('\\', '/')
    assert.equal(/windowMs|SlidingWindowMeter|DEFAULT_WINDOW_MS/.test(source), false,
      `${where} still carries a trailing window`)
  }

  assert.equal('SlidingWindowMeter' in coreIndex, false,
    'the engine no longer exports a sliding window')
  assert.equal('DEFAULT_WINDOW_MS' in curveModule, false,
    'the trailing-window constant is gone from the curve module')
  assert.equal('LiveMeter' in coreIndex, true)
})
