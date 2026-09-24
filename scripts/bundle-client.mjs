/**
 * Minimal deterministic ESM bundler for this plugin's browser half.
 *
 * Why one exists: a DSH client bundle is a **single classic script** that only
 * registers `window.__ModuleLoader__.load({id, factory})`; the factory's
 * synchronous `require` resolves seed words and registered package ids, never
 * relative paths (verified in `dsh-client-modules/lib/client.js`). Shipped
 * plugins bundle with tsdown, which is not installed on this machine, and
 * installing a bundler dependency would contradict the project's
 * dependency-free verification story.
 *
 * The supported subset is exactly what `src/` uses, and the build fails loudly
 * on anything outside it:
 *
 *   import { a, b as c } from './relative.js' | 'react'
 *   import Default from 'external'
 *   import './side-effect.js'
 *   export { a, b as c } from './relative.js'
 *   export { a, b as c }                 (local re-export of existing bindings)
 *   export const/let/function/class/async function NAME
 *   export {}
 *
 * Rejected (throws): `export *`, `export default`, unresolved residual
 * import/export statements, module cycles, unknown relative targets.
 *
 * The emitted module graph is executed in dependency order inside one factory
 * closure, with each module body wrapped as `function (__exports) {...}` and
 * imports destructured from memoized `__req(id)` results. This is sound for
 * this codebase because there are no cycles and no live-binding mutations of
 * exported names (all exports are `const`/`function`/`class` values finalized
 * before any importer reads them); both properties are asserted by
 * `test/client-bundle.test.js`.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CLIENT_ENTRY = 'src/client/main.js'
export const CLIENT_BUNDLE_ID = 'dsh-turn-performance-meter'

const IMPORT_BRACED = /^import\s+\{([\s\S]*?)\}\s*from\s+'([^']+)'[ \t]*;?/gm
const IMPORT_DEFAULT = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+)'[ \t]*;?/gm
const IMPORT_BARE = /^import\s+'([^']+)'[ \t]*;?/gm
const EXPORT_FROM = /^export\s+\{([\s\S]*?)\}\s*from\s+'([^']+)'[ \t]*;?/gm
const EXPORT_LOCAL = /^export\s+\{([\s\S]*?)\}[ \t]*;?/gm
export const EXPORT_DECL = /^export\s+((?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*))/gm
const RESIDUAL = /^[ \t]*(?:import|export)\s/m
/**
 * The `export` keyword must be gone after the transform. Anchored on line
 * starts *and* statement boundaries so a glued mid-line `export const` (which
 * `RESIDUAL` cannot see) is still caught.
 */
const RESIDUAL_EXPORT = /(^|[^\w'$])export\s+(?:default\b|\*|const\b|let\b|var\b|function\b|class\b|async\b)/m

/** Parse `a, b as c` into `[{name, alias}]`; strips comments and empties. */
function parseNames(block) {
  const out = []
  for (const raw of block.split(',')) {
    const line = raw.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (line === '') continue
    const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(line)
    if (match === null) throw new Error(`bundle: unsupported import/export specifier ${JSON.stringify(line)}`)
    out.push({ name: match[1], alias: match[2] ?? match[1] })
  }
  return out
}

function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../')
}

/** Resolve a relative specifier to a repo-root posix module id. */
function resolveId(spec, fromId) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromId), spec))
  if (!resolved.startsWith('src/')) {
    throw new Error(`bundle: ${fromId} imports ${spec} which escapes src/ (${resolved})`)
  }
  if (!resolved.endsWith('.js')) throw new Error(`bundle: ${fromId} imports ${spec} without a .js target`)
  return resolved
}

/** Transform one module: returns `{body, exports: [{exported, local}]}`. */
export function transformModule(source, id) {
  const exports = []
  let body = source

  // 1. Named imports (possibly multi-line).
  body = body.replace(IMPORT_BRACED, (match, block, spec) => {
    const names = parseNames(block)
    const target = isRelative(spec) ? `__req(${JSON.stringify(resolveId(spec, id))})` : `__ext(${JSON.stringify(spec)})`
    const destructure = names.map(({ name, alias }) => (name === alias ? name : `${name}: ${alias}`)).join(', ')
    return `const { ${destructure} } = ${target}`
  })

  // 2. Default imports (external packages only in this codebase).
  body = body.replace(IMPORT_DEFAULT, (match, name, spec) => {
    if (isRelative(spec)) throw new Error(`bundle: ${id} default-imports a relative module (${spec}); use a named import`)
    return `const ${name} = __ext(${JSON.stringify(spec)})`
  })

  // 3. Bare side-effect imports.
  body = body.replace(IMPORT_BARE, (match, spec) => {
    const target = isRelative(spec) ? `__req(${JSON.stringify(resolveId(spec, id))})` : `__ext(${JSON.stringify(spec)})`
    return `void ${target}`
  })

  // 4. Re-exports from a dependency (the index barrels).
  body = body.replace(EXPORT_FROM, (match, block, spec) => {
    if (!isRelative(spec)) throw new Error(`bundle: ${id} re-exports from an external package (${spec})`)
    const depId = resolveId(spec, id)
    const names = parseNames(block)
    const bindings = names.map(({ name, alias }) => (
      name === alias
        ? `const { ${name} } = __req(${JSON.stringify(depId)})`
        : `const { ${name}: ${alias} } = __req(${JSON.stringify(depId)})`
    )).join('\n')
    for (const { alias } of names) exports.push({ exported: alias, local: alias })
    return bindings
  })

  // 5. Local re-export lists (`export { a as b }` over existing bindings).
  body = body.replace(EXPORT_LOCAL, (match, block) => {
    for (const { name, alias } of parseNames(block)) exports.push({ exported: alias, local: name })
    return ''
  })

  // 6. Exported declarations: keep the declaration, drop the keyword.
  body = body.replace(EXPORT_DECL, (match, statement, name) => {
    exports.push({ exported: name, local: name })
    return statement
  })

  if (/^export\s+\*/m.test(body)) throw new Error(`bundle: ${id} uses export * , which this bundler rejects`)
  if (/^export\s+default/m.test(body)) throw new Error(`bundle: ${id} uses export default, which this bundler rejects`)
  if (RESIDUAL.test(body) || RESIDUAL_EXPORT.test(body)) {
    const offending = body.split('\n').find(line => /^[ \t]*(?:import|export)\s/.test(line) || /(^|[^\w'$])export\s+(?:const|function|class)/.test(line))
    throw new Error(`bundle: ${id} retains an unsupported import/export statement: ${offending?.trim()}`)
  }

  const assign = exports.length === 0
    ? ''
    : `\n;Object.assign(__exports, { ${exports.map(({ exported, local }) => (
      exported === local ? exported : `${exported}: ${local}`
    )).join(', ')} })`
  return { body: `${body}${assign}`, exports }
}

/** Walk the module graph from the entry in dependency-first order. */
export async function collectModules(rootDir, entryId = CLIENT_ENTRY) {
  const ordered = []
  const state = new Map() // id -> 'visiting' | 'done'
  const sources = new Map()

  async function visit(id, stack) {
    const seen = state.get(id)
    if (seen === 'done') return
    if (seen === 'visiting') {
      throw new Error(`bundle: module cycle detected: ${[...stack, id].join(' -> ')}`)
    }
    state.set(id, 'visiting')
    const file = path.join(rootDir, id)
    const source = await readFile(file, 'utf8')
    sources.set(id, source)

    // Discover dependencies by running the transform for its import targets.
    const deps = []
    const collectBraced = (match, block, spec) => {
      if (isRelative(spec)) deps.push(resolveId(spec, id))
      return match
    }
    let scan = source
    scan = scan.replace(IMPORT_BRACED, collectBraced)
    scan = scan.replace(IMPORT_DEFAULT, (match, name, spec) => {
      if (isRelative(spec)) deps.push(resolveId(spec, id))
      return match
    })
    scan = scan.replace(IMPORT_BARE, (match, spec) => {
      if (isRelative(spec)) deps.push(resolveId(spec, id))
      return match
    })
    scan = scan.replace(EXPORT_FROM, (match, block, spec) => {
      if (isRelative(spec)) deps.push(resolveId(spec, id))
      return match
    })

    for (const dep of deps) await visit(dep, [...stack, id])
    state.set(id, 'done')
    ordered.push(id)
  }

  await visit(entryId, [])
  return { ordered, sources }
}

/** Build the complete classic-script bundle text for `client.js`. */
export async function bundleClient({ rootDir = REPO_ROOT_DEFAULT, entryId = CLIENT_ENTRY, bundleId = CLIENT_BUNDLE_ID } = {}) {
  const { ordered, sources } = await collectModules(rootDir, entryId)
  const chunks = []
  for (const id of ordered) {
    const { body } = transformModule(sources.get(id), id)
    chunks.push(`\t\t\t${JSON.stringify(id)}: function (__exports) {\n${body}\n\t\t\t}`)
  }
  return `/**
 * GENERATED FILE — do not edit.
 * Rebuild with: npm run build:client
 * Source graph: src/client/main.js + its imports (scripts/bundle-client.mjs).
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(bundleId)},
\tfactory(require) {
\t\t'use strict'
\t\tconst __cache = new Map()
\t\tfunction __ext(spec) { return require(spec) }
\t\tfunction __req(id) {
\t\t\tconst hit = __cache.get(id)
\t\t\tif (hit !== undefined) return hit
\t\t\tconst factory = __modules[id]
\t\t\tif (factory === undefined) throw new Error('dsh-turn-performance-meter bundle: unknown module ' + id)
\t\t\tconst record = { exports: {} }
\t\t\t__cache.set(id, record.exports)
\t\t\tfactory(record.exports)
\t\t\treturn record.exports
\t\t}
\t\tconst __modules = {
${chunks.join(',\n')}
\t\t}
\t\treturn __req(${JSON.stringify(entryId)})
\t},
})
`
}
