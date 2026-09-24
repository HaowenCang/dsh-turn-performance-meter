/**
 * Write the browser bundle from the source graph.
 *
 * Two outputs, byte-identical:
 *   - `client.js`      the `exports['./client']` file DSH serves to the browser
 *   - `lib/client.js`  the conventional bundle location the local
 *                      `dsh-super-injector` validates before a runtime
 *                      injection (`lib/client.js` must exist, contain
 *                      `__ModuleLoader__`, declare `inject` with `slots`, and
 *                      register a known slot name)
 *
 * Output is deterministic: running this twice produces byte-identical text,
 * which is what lets `scripts/verify-structure.mjs` fail when `client.js` is
 * stale relative to `src/`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { bundleClient, REPO_ROOT_DEFAULT } from './bundle-client.mjs'

const rootDir = process.argv[2] ?? REPO_ROOT_DEFAULT
const text = await bundleClient({ rootDir })
await writeFile(new URL('../client.js', import.meta.url), text, 'utf8')
await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await writeFile(new URL('../lib/client.js', import.meta.url), text, 'utf8')
console.log(`client.js rebuilt (${text.length} bytes, mirrored to lib/client.js)`)
