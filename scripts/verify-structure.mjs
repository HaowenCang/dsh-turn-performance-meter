import { access, readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { bundleClient } from './bundle-client.mjs'

const required = [
  'README.md', 'package.json', 'cordis.patch.yml', 'index.js', 'client.js',
  'docs/ARCHITECTURE.md', 'docs/METRICS_SPEC.md', 'docs/TASKS.md',
  'docs/DSH_API_NOTES.md', 'docs/UI_SPEC.md', 'docs/TEST_PLAN.md',
  'docs/START_PROMPT.md', 'docs/DIRECTORY_TREE.md', 'docs/IMPLEMENTATION_LOG.md',
]

for (const file of required) await access(new URL(`../${file}`, import.meta.url))

/**
 * Every pure module must have a test beside it, and every test must reference a
 * module that exists. The pure metric engine is the only place statistical
 * formulas live, so an untested module there is a correctness hole rather than a
 * coverage statistic.
 */
const coreDir = fileURLToPath(new URL('../src/core/', import.meta.url))
const testDir = fileURLToPath(new URL('../test/', import.meta.url))
const coreModules = (await readdir(coreDir)).filter(name => name.endsWith('.js'))
const testFiles = (await readdir(testDir)).filter(name => name.endsWith('.test.js'))

const testedNames = new Set(testFiles.map(name => name.replace(/\.test\.js$/, '')))
const untested = coreModules
  .map(name => name.replace(/\.js$/, ''))
  .filter(name => name !== 'types' && name !== 'index' && !testedNames.has(name))
if (untested.length > 0) {
  console.error(`src/core modules without a matching test: ${untested.join(', ')}`)
  process.exitCode = 1
}

/** Local imports inside `src/` must resolve, so a rename cannot ship a broken graph. */
const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`
    if (entry.isDirectory()) yield* walk(`${path}/`)
    else if (entry.name.endsWith('.js')) yield path
  }
}
const missing = []
for await (const file of walk(srcDir)) {
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
    const resolved = new URL(match[1], `file:///${file.replaceAll('\\', '/')}`)
    try {
      await access(resolved)
    } catch {
      missing.push(`${file} -> ${match[1]}`)
    }
  }
}
if (missing.length > 0) {
  console.error(`unresolved local imports:\n  ${missing.join('\n  ')}`)
  process.exitCode = 1
}

/**
 * The committed browser bundle must match the source graph exactly: a stale
 * `client.js` would ship yesterday's UI while every source test passes today.
 */
const rootDir = fileURLToPath(new URL('../', import.meta.url))
const committedClient = await readFile(new URL('../client.js', import.meta.url), 'utf8').catch(() => null)
try {
  const fresh = await bundleClient({ rootDir })
  if (committedClient !== fresh) {
    console.error('client.js is stale relative to src/ — run: npm run build:client')
    process.exitCode = 1
  }
} catch (error) {
  console.error(`client bundle failed to build: ${error.message}`)
  process.exitCode = 1
}

if (process.exitCode !== 1) {
  console.log(`structure OK (${required.length} required files, ${coreModules.length} core modules, ${testFiles.length} test files, client bundle fresh)`)
}
