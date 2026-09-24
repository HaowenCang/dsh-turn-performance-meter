/**
 * Derive synthetic fixtures from a real recording, with recorded provenance.
 *
 *   node dev/mutate-fixtures.mjs [--write]
 *
 * Policy (docs/TASKS.md, Phase 2 item 1D): a scenario that cannot be produced
 * by a real provider run may be constructed by a *minimal transformation* of a
 * real fixture, provided the transformation is explicit, deterministic and
 * reproducible, and provided the original fixture is kept unchanged. This
 * script is that transformation, and it is the only writer of
 * `fixtures/derived/`.
 *
 * Every derived fixture carries a `syntheticMutation` object naming the source
 * fixture and each applied change, so no consumer can mistake it for observed
 * evidence. Nothing here edits `fixtures/dsh-turns/`.
 *
 * Without `--write` the script only reports what it would produce.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sourceDir = join(repoRoot, 'fixtures', 'dsh-turns')
const outDir = join(repoRoot, 'fixtures', 'derived')
const write = process.argv.includes('--write')

const clone = value => JSON.parse(JSON.stringify(value))

/**
 * D1 — the provider reports an output total but no reasoning split.
 *
 * This is the *common* real condition for routes that do not report
 * `reasoningTokens`, and it is what t1 and t2 already show. Deriving it from
 * t5 (which does report the split) isolates the effect of the missing counter
 * on an otherwise identical stream, which is the comparison the quality model
 * has to survive.
 */
function dropReasoningTokens(source) {
  const next = clone(source)
  const touched = []
  for (const row of next.durable) {
    const data = row.event.data
    if (data && typeof data.usage === 'object' && data.usage !== null && 'reasoningTokens' in data.usage) {
      touched.push({ seq: row.event.seq, type: row.event.type, removed: data.usage.reasoningTokens })
      delete data.usage.reasoningTokens
    }
  }
  for (const row of next.transient) {
    const chunk = row.frame?.chunk
    if (chunk?.type === 'usage' && chunk.usage && 'reasoningTokens' in chunk.usage) {
      touched.push({ frameIndex: row.frame.index, type: 'in-stream usage chunk', removed: chunk.usage.reasoningTokens })
      delete chunk.usage.reasoningTokens
    }
  }
  return {
    next,
    mutation: {
      kind: 'drop-reasoning-tokens',
      description: 'Remove reasoningTokens from every provider usage carrier (durable settlement and in-stream usage chunk); outputTokens stays authoritative.',
      touched,
    },
  }
}

/**
 * D2 — usage is present for one attempt and absent for another.
 *
 * Built from t4, whose two attempts both settle with usage. The second
 * settlement loses its usage object, which is exactly the shape an abandoned or
 * failed attempt leaves behind (t3 shows the real no-usage case, but it has no
 * sibling attempt to be incomplete against). The turn aggregate must then be
 * unavailable rather than silently summing the one attempt that did report.
 */
function dropOneAttemptUsage(source) {
  const next = clone(source)
  const settlements = next.durable.filter(row => row.event.type === 'assistant/message' || row.event.type === 'assistant/attempt')
  if (settlements.length < 2) throw new Error('drop-one-attempt-usage needs a fixture with two settlements')
  const target = settlements.at(-1)
  const removed = target.event.data.usage ?? null
  delete target.event.data.usage
  return {
    next,
    mutation: {
      kind: 'drop-one-attempt-usage',
      description: 'Remove the usage object from the last assistant settlement, leaving the turn with partial usage coverage.',
      touched: [{ seq: target.event.seq, type: target.event.type, removed }],
    },
  }
}

/**
 * D3 — a retried attempt left no surface message.
 *
 * The last settlement is converted from `assistant/message` to
 * `assistant/attempt`, which is DSH's own durable record for "one model attempt
 * that committed no surface message" (verified at
 * `dsh-session/lib/types/types.d.ts:318-327`). The stream is untouched. This
 * reproduces the retry/abandonment shape without a live provider failure.
 */
function convertSettlementToAttempt(source) {
  const next = clone(source)
  const target = next.durable.filter(row => row.event.type === 'assistant/message').at(-1)
  if (target === undefined) throw new Error('convert-settlement-to-attempt needs an assistant/message settlement')
  const hadMessage = target.event.data.message !== undefined
  const hadUsage = target.event.data.usage !== undefined
  delete target.event.data.message
  delete target.event.data.usage
  delete target.event.data.interrupted
  target.event.type = 'assistant/attempt'
  return {
    next,
    mutation: {
      kind: 'convert-settlement-to-attempt',
      description: 'Convert the last assistant/message settlement into an assistant/attempt settlement, DSH\'s durable record for an attempt that committed no surface message. The embedded stream is unchanged.',
      touched: [{ seq: target.event.seq, removedMessage: hadMessage, removedUsage: hadUsage }],
    },
  }
}

/**
 * D4 — a tool call with no matching result.
 *
 * Built from t2, which has three tool calls. The last `tool/result` is removed
 * and no other field changes, which is what a turn interrupted while a tool is
 * still running leaves in the durable log. `toolWorkMs` must not count it and
 * `toolWallMs` must stay defined.
 */
function dropToolResult(source) {
  const next = clone(source)
  const results = next.durable.filter(row => row.event.type === 'tool/result')
  if (results.length === 0) throw new Error('drop-tool-result needs a fixture with a tool result')
  const target = results.at(-1)
  const index = next.durable.indexOf(target)
  next.durable.splice(index, 1)
  return {
    next,
    mutation: {
      kind: 'drop-tool-result',
      description: 'Remove the last tool/result event, leaving one tool/call unmatched, as an interruption during tool execution leaves it.',
      touched: [{ seq: target.event.seq, callId: target.event.data.message?.content?.[0]?.toolCallId ?? null }],
    },
  }
}

const DERIVATIONS = [
  { name: 'd1-no-reasoning-tokens', from: 't5-reasoning-text-deepseek-official', apply: dropReasoningTokens },
  { name: 'd2-partial-usage', from: 't4-reasoning-tool-deepseek-official', apply: dropOneAttemptUsage },
  { name: 'd3-attempt-without-message', from: 't4-reasoning-tool-deepseek-official', apply: convertSettlementToAttempt },
  { name: 'd4-unmatched-tool-result', from: 't2-pwsh-write-edit', apply: dropToolResult },
]

if (write) mkdirSync(outDir, { recursive: true })

for (const derivation of DERIVATIONS) {
  const sourcePath = join(sourceDir, `${derivation.from}.json`)
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  const { next, mutation } = derivation.apply(source)
  const derived = {
    ...next,
    fixture: derivation.name,
    scenario: `Synthetic derivative of ${derivation.from}: ${mutation.description}`,
    covers: [...(source.covers ?? []), `synthetic: ${mutation.kind}`],
    syntheticMutation: {
      ...mutation,
      sourceFixture: derivation.from,
      sourceSessionId: source.sessionId,
      generator: 'dev/mutate-fixtures.mjs',
      rationale: 'Minimal deterministic transformation of a real recording; the source fixture is preserved unchanged.',
    },
  }
  const outPath = join(outDir, `${derivation.name}.json`)
  if (write) writeFileSync(outPath, `${JSON.stringify(derived, null, 2)}\n`, 'utf8')
  console.log(`${write ? 'wrote' : 'would write'} ${outPath}`)
  console.log(`  kind: ${mutation.kind}`)
  console.log(`  touched: ${JSON.stringify(mutation.touched).slice(0, 200)}`)
}
