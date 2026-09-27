/**
 * Fixture loading for the DSH evidence tests.
 *
 * Three corpora, and the directory each fixture lives in is its provenance:
 *
 *   fixtures/dsh-turns/    recorded on DSH 0.1.5-rc.2 — legacy evidence
 *   fixtures/dsh-0.1.7/    recorded on DSH 0.1.7-rc.2 — the current target
 *   fixtures/derived/      deterministic mutations, always carrying a
 *                          `syntheticMutation` provenance block
 *
 * Phase 7D makes the split load-bearing rather than cosmetic. A 0.1.5 capture
 * no longer describes the `tool/result` shape, `settle-assistant` semantics or
 * the turn completion lifecycle, so it may only be cited for the things that
 * did not change: pure metric arithmetic, decoder robustness, and the history
 * of what was verified when. `loadFixture` reads the legacy directory and
 * `loadTargetFixture` reads the 0.1.7 one, so a test that needs current
 * evidence cannot reach for the old bytes by accident.
 *
 * Nothing in this module rewrites a fixture: the tests are required to pass
 * against the recorded bytes.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(here, '..', '..')
/** DSH 0.1.5-rc.2 captures. Legacy evidence; see the module docstring. */
export const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'dsh-turns')
/** DSH 0.1.7-rc.2 captures — the compatibility target of this project. */
export const TARGET_FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'dsh-0.1.7')
export const DERIVED_DIR = join(REPO_ROOT, 'fixtures', 'derived')

/** One real recording from the legacy (0.1.5-rc.2) corpus. */
export function loadFixture(name) {
  return loadJson(join(FIXTURE_DIR, `${name}.json`))
}

/** One real recording from the current-target (0.1.7-rc.2) corpus. */
export function loadTargetFixture(name) {
  const fixture = loadJson(join(TARGET_FIXTURE_DIR, `${name}.json`))
  if (fixture.dshVersion !== '0.1.7-rc.2') {
    throw new Error(`${name} declares dshVersion ${String(fixture.dshVersion)}; the target corpus must be 0.1.7-rc.2`)
  }
  if (fixture.captureFamily !== '0.1.7') {
    throw new Error(`${name} is not marked captureFamily 0.1.7: refusing to treat it as target evidence`)
  }
  return fixture
}

/** One synthetic derivative of a real recording. */
export function loadDerived(name) {
  const fixture = loadJson(join(DERIVED_DIR, `${name}.json`))
  if (fixture.syntheticMutation === undefined) {
    throw new Error(`${name} is not marked as synthetic: refusing to treat it as observed evidence`)
  }
  return fixture
}

function loadJson(path) {
  if (!existsSync(path)) throw new Error(`fixture not found: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Every real fixture file name, without extension. */
export function listFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter(name => name.endsWith('.json') && name !== 'index.json')
    .map(name => name.replace(/\.json$/, ''))
}

/** Every current-target (0.1.7-rc.2) fixture file name, without extension. */
export function listTargetFixtures() {
  return readdirSync(TARGET_FIXTURE_DIR)
    .filter(name => name.endsWith('.json') && name !== 'index.json')
    .map(name => name.replace(/\.json$/, ''))
}

/** Every derived fixture file name, without extension. */
export function listDerived() {
  return readdirSync(DERIVED_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => name.replace(/\.json$/, ''))
}

/** Durable session events of one fixture, in recorded order. */
export function durableEventsOf(fixture) {
  return fixture.durable.map(row => row.event)
}

/**
 * Transient frames of one fixture, in recorded order.
 *
 * A fixture kept from a host-side recorder holds `agent/assistant-stream`
 * frames. The client-folded `assistant/live-chunk` form is the same evidence
 * after one transport hop, and the adapter is required to accept both, so the
 * tests exercise both.
 */
export function transientFramesOf(fixture) {
  return fixture.transient.map(row => row.frame)
}

/** The client-folded view of the recorded transient plane. */
export function liveChunksOf(fixture) {
  return transientFramesOf(fixture).filter(frame => frame.type === 'chunk').map(frame => ({
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq: null,
      time: frame.time,
      data: {
        attemptId: frame.attemptId,
        turn: null,
        step: null,
        chunk: frame.chunk,
      },
    },
  }))
}
