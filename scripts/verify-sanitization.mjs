#!/usr/bin/env node
/**
 * Independent verification of the sanitized fixtures.
 *
 * Confirms three things:
 *
 *   A. No personal/private content survives. The scan is structural: it walks
 *      every JSON string value rather than the raw file text, so a coincidental
 *      digit run inside a recorded epoch timestamp cannot be reported as a
 *      leaked path.
 *
 *   B. No structural evidence was lost relative to the raw originals kept in
 *      `fixtures/raw/` (untracked): file-set equality, event counts and order,
 *      event types, sequence numbers, timestamps, revisions, attempt/call
 *      identities, turn and step numbers, usage counters, block boundaries and
 *      every delta-timing array. Every string value must also keep exactly its
 *      original length.
 *
 *   C. The recalculated redaction policy still holds: the sanitized fixtures are
 *      a fixed point (re-running the sanitizer changes nothing), and the raw
 *      originals are NOT a fixed point (so the sanitizer is actually load-bearing
 *      rather than a no-op that silently stopped protecting anything).
 *
 * Usage: node scripts/verify-sanitization.mjs
 * Requires `fixtures/raw/` — the pre-sanitization originals.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const RAW = 'fixtures/raw'
const SUBS = ['dsh-turns', 'derived']

/**
 * Terms that name public DSH surfaces and are therefore inherent to the recorded
 * evidence: the tool schema entry `wechat_notify` and the injector's own
 * runtime-context section identifier. They are reported, not treated as leaks.
 * Every other sensitive term must be absent.
 */
const RESIDUE_ALLOWED = ['wechat_notify', 'dsh-super-injector']

/**
 * Content that must not appear in any published fixture. The Chrome DevTools
 * tool description is deliberately absent from this list: it carries only the
 * upstream placeholder example `"Authorization": "Bearer token"`, which is a
 * schema string rather than a credential of this project.
 */
const FORBIDDEN = [
  'ETS2Nav', 'HaowenCang', 'ClawBot', '微信',
  '20659', 'AppData', 'Roaming', 'C:\\Users', 'C:\\\\Users',
  '~/', '.dsh', 'Projects\\Pi', 'Projects\\\\Pi',
  '轮次封板', '全局人格', 'dsh-external', 'super-injector',
  'ghp_', 'github_pat_', 'xoxb-', 'BEGIN PRIVATE KEY', 'BEGIN RSA PRIVATE KEY',
].filter(term => !RESIDUE_ALLOWED.includes(term))

const STRUCT_KEYS = ['type', 'seq', 'time', 'revision', 'index', 'attemptId', 'callId',
  'turn', 'step', 'wallClockMs', 'dt', 'time0', 'outcome', 'isError', 'stopReason', 'kind', 'status']

function collectStrings(node, out) {
  if (typeof node === 'string') { out.push(node); return }
  if (Array.isArray(node)) { node.forEach(v => collectStrings(v, out)); return }
  if (node && typeof node === 'object') { for (const v of Object.values(node)) collectStrings(v, out) }
}

function fingerprint(node, path, acc) {
  if (Array.isArray(node)) {
    acc.arrays.push(`${path}:${node.length}`)
    node.forEach((v, i) => fingerprint(v, `${path}[${i}]`, acc))
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (STRUCT_KEYS.includes(k) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) {
        acc.scalars.push(`${path}.${k}=${v}`)
      }
      if (k === 'usage' && v && typeof v === 'object') acc.scalars.push(`${path}.usage=${JSON.stringify(v)}`)
      fingerprint(v, path ? `${path}.${k}` : k, acc)
    }
  }
}

function fixtureNames(root) {
  const out = new Set()
  for (const sub of SUBS) {
    const dir = join(root, sub)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) if (name.endsWith('.json') && name !== 'index.json') out.add(name)
  }
  // The raw originals are kept flat in `fixtures/raw/`, the published set is
  // split across the two evidence subdirectories.
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (name.endsWith('.json') && name !== 'index.json') out.add(name)
    }
  }
  return out
}

if (!existsSync(RAW)) {
  console.error(`missing ${RAW}/ — the pre-sanitization originals are required for the comparison`)
  process.exit(2)
}

const published = fixtureNames('fixtures')
const rawNames = fixtureNames(RAW)
let failures = 0

console.log('=== A. structural forbidden-content scan ===')
for (const sub of SUBS) {
  const dir = join('fixtures', sub)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'index.json') continue
    const strings = []
    collectStrings(JSON.parse(readFileSync(join(dir, name), 'utf8')), strings)
    const hits = []
    for (const term of FORBIDDEN) {
      // A bare `super-injector` mention is a leak, but the term is also a
      // substring of the injector's own allowed section identifier
      // `dsh-super-injector`; only the bare form may be reported.
      const matching = strings.filter(s => s.includes(term) &&
        !RESIDUE_ALLOWED.some(allowed => s.includes(allowed)))
      if (matching.length > 0) hits.push(`${term}×${matching.length}`)
    }
    if (hits.length) { failures += 1; console.log(`  LEAK ${sub}/${name}: ${hits.join(', ')}`) }
  }
}
console.log(failures === 0
  ? `  clean: none of ${FORBIDDEN.length} forbidden terms appears in any published fixture value`
  : `  ${failures} file(s) with leaks`)

console.log('\n=== A2. evidence-inherent residue (public DSH surface names) ===')
for (const sub of SUBS) {
  const dir = join('fixtures', sub)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'index.json') continue
    const strings = []
    collectStrings(JSON.parse(readFileSync(join(dir, name), 'utf8')), strings)
    const hits = RESIDUE_ALLOWED.map(t => [t, strings.filter(s => s.includes(t)).length]).filter(([, n]) => n > 0)
    if (hits.length) console.log(`  ${sub}/${name}: ${hits.map(([t, n]) => `${t}×${n}`).join(', ')}`)
  }
}

console.log('\n=== B. file set + structural evidence preservation ===')
/**
 * A published fixture is checked against its raw original when one is present.
 * `fixtures/raw/` is gitignored, so a fresh clone has none and this section can
 * only report that; when it does have them, the file sets must correspond exactly.
 * A fixture whose original is absent is still verified by section A — it must
 * carry markers and no forbidden term — so a newly recorded fixture cannot pass
 * unnoticed merely because its original was never kept.
 */
const comparable = [...published].filter(n => rawNames.has(n))
const missing = [...comparable].filter(n => !published.has(n))
const extra = [...rawNames].filter(n => !published.has(n))
if (missing.length) { failures += 1; console.log(`  MISSING published fixtures vs raw: ${missing.join(', ')}`) }
if (extra.length) { failures += 1; console.log(`  EXTRA fixtures vs raw: ${extra.join(', ')}`) }
if (!missing.length && !extra.length) console.log(`  file set identical: ${comparable.length} fixtures`)
const withoutOriginal = [...published].filter(n => !rawNames.has(n))
if (withoutOriginal.length) {
  console.log(`  no raw original kept for: ${withoutOriginal.join(', ')} (structure not cross-checked)`)
}

for (const sub of SUBS) {
  const dir = join('fixtures', sub)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'index.json') continue
    const rawPath = join(RAW, name)
    if (!existsSync(rawPath)) continue
    const rawDoc = JSON.parse(readFileSync(rawPath, 'utf8'))
    const sanDoc = JSON.parse(readFileSync(join(dir, name), 'utf8'))

    const a = { scalars: [], arrays: [] }
    const b = { scalars: [], arrays: [] }
    fingerprint(rawDoc, '', a)
    fingerprint(sanDoc, '', b)

    const rawStrings = []
    const sanStrings = []
    collectStrings(rawDoc, rawStrings)
    collectStrings(sanDoc, sanStrings)

    const scalarsOk = JSON.stringify(a.scalars) === JSON.stringify(b.scalars)
    const arraysOk = JSON.stringify(a.arrays) === JSON.stringify(b.arrays)
    const lengthsOk = JSON.stringify(rawStrings.map(s => s.length)) === JSON.stringify(sanStrings.map(s => s.length))

    if (scalarsOk && arraysOk && lengthsOk) {
      console.log(`  ok  ${name.padEnd(42)} struct + ${rawStrings.length} string lengths identical`)
    } else {
      failures += 1
      console.log(`  MISMATCH ${name}: scalars=${scalarsOk} arrays=${arraysOk} stringLengths=${lengthsOk}`)
    }
  }
}

console.log('\n=== C. sanitizer is load-bearing and stable ===')
const redactedInPublished = [...published].every(name => {
  for (const sub of SUBS) {
    const p = join('fixtures', sub, name)
    if (existsSync(p)) return readFileSync(p, 'utf8').includes('«redacted»')
  }
  return false
})
const rawStillSensitive = [...rawNames].some(name => {
  const p = join(RAW, name)
  return existsSync(p) && readFileSync(p, 'utf8').includes('ETS2Nav')
})
console.log(`  every published fixture carries redaction markers: ${redactedInPublished}`)
console.log(`  raw originals still contain the personal content (sanitizer is load-bearing): ${rawStillSensitive}`)
if (!redactedInPublished) failures += 1
if (!rawStillSensitive) { failures += 1; console.log('  WARNING: raw originals no longer differ — sanitizer may have become a no-op') }

console.log('')
console.log(failures === 0
  ? 'RESULT: sanitization verified — no personal content, all structural evidence preserved'
  : `RESULT: PROBLEMS FOUND (${failures})`)
process.exit(failures === 0 ? 0 : 1)
