/**
 * Release Phase A — v0.1.7 `engines.dsh` compatibility range.
 *
 * v0.1.7 replaces the exact `@deepseek-ai/dsh` peer with one `engines.dsh`
 * range, `>=0.2.1-rc.2 <0.2.2-0`. The host compatibility evaluator
 * (`packages/boot/app-boot/src/plugin-compatibility.ts`) gives an own
 * `engines.dsh` range precedence and ignores `peerDependencies`; it compares
 * with `semver.satisfies(runtime, range, { includePrerelease: true })`. This
 * file pins the declaration and that evaluator's decision.
 *
 * Two evaluation paths are used on purpose:
 *
 *   1. When an installed DSH `dsh-app-boot` evaluator is resolvable — from
 *      `DSH_APP_BOOT_LIB`, or from the sibling isolated toolchains used for
 *      release acceptance — every matrix row and the precedence case are
 *      decided by the host's **real** `evaluatePluginCompatibility`.
 *   2. The portable comparator below mirrors semver precedence so the suite is
 *      self-contained on a machine without a DSH install; the assertions are
 *      the same either way, so no test is skipped or weakened. The release
 *      machine runs path 1 and records the host-evaluator result in
 *      `docs/DSH_API_NOTES.md` §17.
 *
 * This file does not re-assert the wire-shape evidence: the rc.2 layer
 * (`test/dsh-021-contract.test.js`), the rc.3 layer
 * (`test/dsh-021-rc3-contract.test.js`) and the 0.2.0 layer
 * (`test/dsh-020-contract.test.js`) keep it, un-restamped.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const RANGE = '>=0.2.1-rc.2 <0.2.2-0'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * Installed DSH evaluator locations. The first entry is the portable hook; the
 * sibling toolchains are the isolated environments this release is accepted on.
 * Missing paths are tolerated: the portable comparator still decides.
 */
function evaluatorCandidates() {
  const parent = dirname(REPO_ROOT)
  return [
    process.env.DSH_APP_BOOT_LIB,
    join(parent, '_phase13-runtime', 'dsh-0.2.1-rc.3', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
    join(parent, '_phase11-runtime', 'dsh-0.2.1-rc.2', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
  ].filter(candidate => typeof candidate === 'string' && candidate !== '' && existsSync(candidate))
}

/** The host evaluator, or `null` when no installed DSH can be resolved. */
async function loadHostEvaluator() {
  for (const candidate of evaluatorCandidates()) {
    try {
      const imported = await import(pathToFileURL(candidate).href)
      if (typeof imported.evaluatePluginCompatibility === 'function') {
        return {
          lib: candidate,
          evaluate: imported.evaluatePluginCompatibility,
          runtimeVersion: imported.getDshRuntimeVersion(),
        }
      }
    } catch {
      // A path that exists but cannot be imported is not a usable evaluator.
    }
  }
  return null
}

const hostEvaluator = await loadHostEvaluator()

// ---------------------------------------------------------------------------
// Portable semver comparator (mirror of semver precedence, not a replacement)
// ---------------------------------------------------------------------------

const VERSION_RX = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function parseVersion(version) {
  const match = VERSION_RX.exec(version)
  assert.ok(match, `a valid semantic version is required, got ${JSON.stringify(version)}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Semver 2.0.0 precedence: build metadata is irrelevant, prerelease orders below release. */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (index >= a.prerelease.length) return -1
    if (index >= b.prerelease.length) return 1
    const comparison = compareIdentifiers(a.prerelease[index], b.prerelease[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

function comparatorSatisfied(version, comparator) {
  const match = /^(>=|<)(.+)$/.exec(comparator)
  assert.ok(match, `the declared range contains an unsupported comparator ${JSON.stringify(comparator)}`)
  const comparison = compareVersions(version, match[2])
  return match[1] === '>=' ? comparison >= 0 : comparison < 0
}

/** The range is a plain space-separated AND of comparators, exactly as declared. */
function satisfiesRange(version, range) {
  const comparators = range.trim().split(/\s+/)
  assert.ok(comparators.length > 0, 'the range must not be empty')
  return comparators.every(comparator => comparatorSatisfied(version, comparator))
}

/**
 * One compatibility decision: the host evaluator when available, otherwise the
 * portable mirror. A rejected result carries the unmet `engines.dsh` range.
 */
function evaluate(manifestValue, runtimeVersion) {
  if (hostEvaluator !== null) {
    const issue = hostEvaluator.evaluate(manifestValue, {}, runtimeVersion)
    return issue === undefined ? { accepted: true } : { accepted: false, requirement: issue.requirements['engines.dsh'] }
  }
  return satisfiesRange(runtimeVersion, manifestValue.engines.dsh)
    ? { accepted: true }
    : { accepted: false, requirement: manifestValue.engines.dsh }
}

// ---------------------------------------------------------------------------
// Manifest declaration
// ---------------------------------------------------------------------------

test('the published declaration carries exactly one engines.dsh range and no DSH peer', () => {
  assert.equal(manifest.name, 'dsh-turn-performance-meter')
  assert.equal(manifest.version, '0.1.7', 'the release version is the prepared v0.1.7 release')
  assert.deepEqual(manifest.engines, { dsh: RANGE }, 'engines.dsh is the only engine entry')
  assert.equal(Object.hasOwn(manifest.engines, 'node'), false, 'no engines.node constraint is added without evidence')
  assert.equal(manifest.peerDependencies, undefined, 'the superseded exact DSH peer is removed, not left beside the range')
  assert.equal(Object.hasOwn(manifest, 'peerDependenciesMeta'), false, 'no peer metadata is added')

  /** The range must not be widened to a wildcard or an open bound. */
  assert.equal(manifest.engines.dsh.includes('*'), false, 'no wildcard')
  assert.equal(manifest.engines.dsh.includes('||'), false, 'no union')
  assert.match(manifest.engines.dsh, /^>=0\.2\.1-rc\.2 <0\.2\.2-0$/, 'both bounds are exact and ordered')

  /** The rest of the distribution metadata is preserved. */
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.deepEqual(manifest.files, ['index.js', 'client.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE'])
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
  ])
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
})

test('the release machine decides the matrix with the installed host evaluator, not only with the mirror', () => {
  /**
   * This assertion records which decision path the suite actually exercised.
   * Failing here would mean the release gate silently degraded to the portable
   * mirror on a machine that has the isolated DSH toolchains.
   */
  assert.notEqual(hostEvaluator, null, 'an installed DSH app-boot evaluator must be resolvable on the release machine')
  assert.ok(
    ['0.2.1-rc.2', '0.2.1-rc.3'].includes(hostEvaluator.runtimeVersion),
    `the installed evaluator should be one of the accepted runtimes, got ${hostEvaluator.runtimeVersion}`,
  )
  assert.equal(typeof hostEvaluator.evaluate, 'function')
})

// ---------------------------------------------------------------------------
// Range boundary matrix
// ---------------------------------------------------------------------------

/**
 * Every runtime on either side of a bound. The accepted future rows are range
 * decisions only — they are not device acceptance (see docs/DSH_API_NOTES.md).
 */
const MATRIX = [
  ['0.2.0-rc.2', false],
  ['0.2.1-rc.1', false],
  ['0.2.1-rc.2', true],
  ['0.2.1-rc.3', true],
  ['0.2.1-rc.4', true],
  ['0.2.1', true],
  ['0.2.2-rc.1', false],
  ['0.2.2', false],
]

test('the engines.dsh range accepts exactly the >=0.2.1-rc.2 <0.2.2-0 matrix', () => {
  for (const [runtimeVersion, expected] of MATRIX) {
    const decision = evaluate(manifest, runtimeVersion)
    assert.equal(decision.accepted, expected, `runtime ${runtimeVersion} must be ${expected ? 'ACCEPT' : 'REJECT'}`)
    if (expected === false) {
      assert.equal(decision.requirement, RANGE, `a rejected runtime reports the declared range, got ${JSON.stringify(decision.requirement)}`)
    }
    /** The portable mirror must agree, so the committed matrix is self-contained too. */
    assert.equal(satisfiesRange(runtimeVersion, RANGE), expected, `semver precedence for ${runtimeVersion}`)
  }
})

test('the boundary is inclusive at rc.2 and exclusive at the 0.2.2-0 prerelease', () => {
  /** The lower bound is inclusive: rc.2 itself is accepted. */
  assert.equal(evaluate(manifest, '0.2.1-rc.2').accepted, true)
  /** rc.1 is below the lower bound and rejected. */
  assert.equal(evaluate(manifest, '0.2.1-rc.1').accepted, false)
  /**
   * `<0.2.2-0` excludes the whole 0.2.2 line: the `-0` sentinel sorts below
   * every real prerelease of 0.2.2, and below the 0.2.2 release itself.
   */
  assert.equal(satisfiesRange('0.2.2-0', RANGE), false)
  assert.equal(satisfiesRange('0.2.2-rc.1', RANGE), false)
  assert.equal(satisfiesRange('0.2.2', RANGE), false)
  assert.equal(evaluate(manifest, '0.2.2-rc.1').accepted, false)
  assert.equal(evaluate(manifest, '0.2.2').accepted, false)
})

// ---------------------------------------------------------------------------
// engines.dsh precedence over a mismatched DSH peer
// ---------------------------------------------------------------------------

test('the host evaluator gives engines.dsh precedence over a deliberately mismatched DSH peer', () => {
  /**
   * A test-only manifest: the production manifest must not carry a DSH peer at
   * all. This is the exact precedence rule the host documents — "an own
   * `engines.dsh` range decides alone and peerDependencies are ignored" — so a
   * valid engines range must win even when the peer cannot be satisfied.
   */
  const priorityManifest = {
    name: 'dsh-turn-performance-meter',
    version: '0.1.7',
    engines: { dsh: RANGE },
    peerDependencies: { '@deepseek-ai/dsh': '0.0.0-deliberately-mismatched' },
  }

  for (const runtimeVersion of ['0.2.1-rc.2', '0.2.1-rc.3']) {
    const decision = evaluate(priorityManifest, runtimeVersion)
    assert.equal(decision.accepted, true, `engines.dsh must decide alone on ${runtimeVersion}`)
  }
  /** Negative control on the same shape: a failing engines range decides alone too. */
  const reverseManifest = {
    name: 'dsh-turn-performance-meter',
    version: '0.1.7',
    engines: { dsh: '^9.9.9' },
    peerDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' },
  }
  const reverse = evaluate(reverseManifest, '0.2.1-rc.2')
  assert.equal(reverse.accepted, false, 'a failing engines.dsh range is not rescued by a matching peer')
  assert.equal(reverse.requirement, '^9.9.9', 'the unmet requirement is reported as engines.dsh, not as a peer')

  /** Peer-only fallback remains the documented behaviour when engines.dsh is absent. */
  const peerOnlyManifest = {
    name: 'dsh-turn-performance-meter',
    version: '0.1.6',
    peerDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' },
  }
  assert.equal(evaluate(peerOnlyManifest, '0.2.1-rc.2').accepted, true)
  assert.equal(evaluate(peerOnlyManifest, '0.2.1-rc.3').accepted, false)
})

test('a non-DSH peer is irrelevant once engines.dsh decides', () => {
  const withNonDshPeer = {
    name: 'dsh-turn-performance-meter',
    version: '0.1.7',
    engines: { dsh: RANGE },
    peerDependencies: { 'left-pad': '^1.0.0' },
  }
  assert.equal(evaluate(withNonDshPeer, '0.2.1-rc.3').accepted, true)
})
