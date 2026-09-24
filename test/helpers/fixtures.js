/**
 * Fixture loading for the DSH evidence tests.
 *
 * Fixtures under `fixtures/dsh-turns/` are real recordings; fixtures under
 * `fixtures/derived/` are deterministic mutations of them and always carry a
 * `syntheticMutation` provenance block. Nothing in this module rewrites a
 * fixture: the tests are required to pass against the recorded bytes.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(here, '..', '..')
export const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'dsh-turns')
export const DERIVED_DIR = join(REPO_ROOT, 'fixtures', 'derived')

/** One real recording. */
export function loadFixture(name) {
  return loadJson(join(FIXTURE_DIR, `${name}.json`))
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
