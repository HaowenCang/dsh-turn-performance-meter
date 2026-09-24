#!/usr/bin/env node
/**
 * Deterministic public-release sanitizer for the recorded DSH fixtures.
 *
 * The fixtures under `fixtures/` are real recordings. Because a recorded request
 * carries the whole prompt context the host sent, those recordings also captured
 * content that must not be published from a public repository:
 *
 *   1. The maintainer's personal `~/.dsh/AGENTS.md` content, inlined verbatim by
 *      the host, plus the local injector's runtime-context block (private project
 *      names, private remote URLs, local provisioning rules).
 *   2. Machine-specific absolute paths (`C:\Users\<name>\...`, local profile and
 *      plugin directories).
 *   3. A locally scoped dev-only package name.
 *
 * The script replaces exactly those regions and nothing else. It is deliberately
 * **length-preserving**: every substituted region has the same JavaScript string
 * length as the text it replaced, so the recorded token magnitude, stream delta
 * boundaries, timing, usage and event ordering are unchanged. Only the text
 * payload of the redacted regions differs, and each redaction is visibly marked.
 *
 * Structural fields of the recording (event types, sequence numbers, `seq`,
 * `revision`, `attemptId`, `callId`, `turn`, `step`, `time`, `wallClockMs`,
 * `dt` arrays, `usage` counters, block boundaries) are never touched.
 *
 * The transform is idempotent: running it on an already-sanitized fixture is a
 * no-op, and `--check` verifies that without writing.
 *
 * Usage:
 *   node scripts/sanitize-fixtures.mjs            # sanitize in place
 *   node scripts/sanitize-fixtures.mjs --check    # report only; exit 1 if dirty
 *   node scripts/sanitize-fixtures.mjs --dir DIR  # operate on another directory
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(here, '..')

const MARKER = '«redacted»'
const SEP = ' · '

/**
 * Build a deterministic string of exactly `length` UTF-16 code units.
 *
 * `«redacted»` is 10 code units and the separator 3, so a length of `10 + 3k` is
 * filled by `k + 1` repetitions. Any other length is filled by repetition and
 * truncated at the exact target length, which keeps the transform deterministic
 * and byte-size-stable instead of silently resizing the evidence.
 */
function redactKeepLength(length) {
  if (length <= 0) return ''
  if (length <= MARKER.length) return MARKER.slice(0, length)
  const repeats = Math.floor((length + SEP.length) / (MARKER.length + SEP.length))
  let out = (MARKER + SEP).repeat(repeats)
  if (out.length < length) out += MARKER
  return out.slice(0, length)
}

/** Replace `[start, end)` of `text` with a marker of identical length. */
function redactRange(text, start, end) {
  return text.slice(0, start) + redactKeepLength(end - start) + text.slice(end)
}

/**
 * Region rules, applied to every JSON string value in the recorded planes.
 *
 * Rules run to a fixed point so nested and overlapping matches settle. Each
 * rule's replacement preserves the matched region's length exactly.
 */
const RULES = [
  {
    id: 'personal-workspace-instructions',
    // The personal instruction body inlined after its provenance header, up to
    // (excluding) the trailing `</system-reminder>` that closes the block.
    re: /Instructions from: [^\n]*\n\n[\s\S]*?(?=\n\n<\/system-reminder>)/g,
    describe: 'personal ~/.dsh/AGENTS.md content inlined into the recorded prompt',
  },
  {
    id: 'runtime-context-block',
    // The local injector's runtime-context payload: from the "Current runtime
    // context." preamble to the end of the text value.
    re: /Current runtime context\.[\s\S]*$/g,
    describe: 'local injector runtime-context payload',
  },
  {
    id: 'runtime-context-section',
    // The system-prompt snapshot section carrying the same injector payload.
    re: /本环境装有[^\n]*$/g,
    describe: 'local injector runtime-context snapshot section',
  },
  {
    id: 'home-directory',
    // Greedy: a home path is redacted entire, including every nested segment, so
    // no `\AppData\Roaming\...`-style tail is left behind to disclose the machine.
    re: /[A-Za-z]:\\Users\\[A-Za-z0-9._\\-]*/g,
    describe: 'absolute user home path (whole path)',
  },
  {
    id: 'project-path',
    re: /[A-Za-z]:\\Projects\\[A-Za-z0-9._\\-]+/g,
    describe: 'absolute local project path',
  },
  {
    id: 'profile-glob',
    re: /~\/\.dsh\/[A-Za-z0-9._*\-/]*\*/g,
    describe: 'local DSH profile glob',
  },
  {
    id: 'profile-directory',
    re: /~\/\.dsh\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g,
    describe: 'local DSH profile/plugin directory',
  },
  {
    id: 'constructing-tool-description',
    re: /扫描 ~\/\.dsh\/profiles[\s\S]*?--check 只查不写/g,
    describe: 'local injector tool description carrying private paths',
  },
  {
    id: 'local-package-scope',
    re: /@dsh-external\//g,
    describe: 'locally scoped dev-only package name',
  },
  {
    id: 'personal-notification-channel',
    re: /通过微信给用户发一条通知，复用本机 ClawBot 微信通道。/g,
    describe: 'personal notification-channel tool description',
  },
]

function sanitizeValue(value) {
  let text = value
  const applied = new Map()
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      const matches = [...text.matchAll(rule.re)].reverse()
      for (const match of matches) {
        const start = match.index
        const end = start + match[0].length
        const next = redactRange(text, start, end)
        if (next !== text) changed = true
        text = next
        applied.set(rule.id, (applied.get(rule.id) ?? 0) + 1)
      }
    }
    if (!changed) break
  }
  return { text, applied }
}

function walk(node, apply) {
  if (typeof node === 'string') return apply(node)
  if (Array.isArray(node)) return node.map(item => walk(item, apply))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(node)) out[key] = walk(value, apply)
    return out
  }
  return node
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const dirFlag = args.indexOf('--dir')
const targetRoot = dirFlag >= 0 && args[dirFlag + 1] ? resolve(args[dirFlag + 1]) : join(REPO_ROOT, 'fixtures')

const targets = []
for (const sub of ['dsh-turns', 'derived']) {
  const dir = join(targetRoot, sub)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.json') && name !== 'index.json') targets.push(join(dir, name))
  }
}

if (targets.length === 0) {
  console.error(`no fixtures found under ${targetRoot}`)
  process.exit(1)
}

let dirty = 0
let lengthViolations = 0
const totals = new Map()

for (const file of targets) {
  const original = readFileSync(file, 'utf8')
  const parsed = JSON.parse(original)
  const perFile = new Map()

  // Invariant: redactions preserve string length by construction, and the
  // document must re-serialize to itself. Note that byte size legitimately
  // changes slightly, because the multi-byte `«redacted»` marker has a different
  // UTF-8 width than some of the CJK text it replaces; the JavaScript string
  // length — the measure every consumer in this project uses for token
  // magnitude, delta boundaries and timing — is what must stay identical.
  const sanitized = walk(parsed, value => {
    const { text, applied } = sanitizeValue(value)
    if (text !== value) {
      if (text.length !== value.length) lengthViolations += 1
      for (const [id, count] of applied) perFile.set(id, (perFile.get(id) ?? 0) + count)
    }
    return text
  })

  const output = JSON.stringify(sanitized, null, 2) + '\n'
  const changed = output !== original
  const short = file.slice(REPO_ROOT.length + 1)

  // Serialization stability: the sanitized fixture must round-trip unchanged, so
  // the file on disk is exactly what a consumer parses.
  if (changed && JSON.stringify(JSON.parse(output), null, 2) + '\n' !== output) {
    console.error(`UNSTABLE SERIALIZATION in ${short}`)
    process.exit(2)
  }

  if (changed) {
    dirty += 1
    for (const [id, count] of perFile) totals.set(id, (totals.get(id) ?? 0) + count)
    if (!checkOnly) writeFileSync(file, output)
    console.log(`${checkOnly ? 'DIRTY' : 'SANITIZED'}  ${short}  (${[...perFile].map(([k, v]) => `${k}×${v}`).join(', ')})`)
  } else {
    console.log(`clean    ${short}`)
  }
}

console.log('')
if (totals.size) {
  console.log('regions replaced by rule:')
  for (const [id, count] of [...totals].sort()) {
    const rule = RULES.find(r => r.id === id)
    console.log(`  ${id}: ${count}  — ${rule ? rule.describe : ''}`)
  }
  console.log('')
}
console.log(`${targets.length} fixtures scanned, ${dirty} modified${checkOnly ? ' (check only)' : ''}`)
if (lengthViolations) console.log(`length violations: ${lengthViolations}`)

if (checkOnly && dirty > 0) process.exit(1)
