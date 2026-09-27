/**
 * Harvest raw fixture recordings into committed scenario fixtures.
 *
 * The raw JSONL under the DSH home is produced by `dev/fixture-recorder` and is
 * the evidence: it is never edited. This script only *selects and reshapes* it
 * into a stable, reviewable per-scenario file:
 *
 *   fixtures/dsh-turns/<name>.json      family `0.1.5` (recorded on 0.1.5-rc.2)
 *   fixtures/dsh-0.1.7/<name>.json      family `0.1.7` (recorded on 0.1.7-rc.2)
 *
 * Usage:
 *   node dev/harvest-fixtures.mjs                 # all scenarios below
 *   node dev/harvest-fixtures.mjs A1 C1           # selected scenarios
 *   node dev/harvest-fixtures.mjs --list
 *
 * Two rules are enforced here and must stay enforced:
 *   1. `durable` and `transient` are copied verbatim, including every stream
 *      record and every delta. No normalization, no reordering, no dropping.
 *   2. A fixture derived from another fixture records its provenance in
 *      `syntheticMutation`; it never overwrites or replaces the original.
 *
 * Phase 7D adds the `family` dimension. A fixture is evidence about the DSH
 * version that produced it and nothing else: the 0.1.5 captures no longer
 * describe the `tool/result` shape, `settle-assistant` semantics or the turn
 * completion lifecycle, so they are kept in their own directory and the 0.1.7
 * captures in theirs. Mixing them would let a reader cite the wrong baseline.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const rawDir = process.env.FIXTURE_RAW_DIR
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'turn-meter-fixtures', 'raw')

/** Where each capture family is published, keyed by family name. */
const FAMILY_DIRS = {
  '0.1.5': 'dsh-turns',
  '0.1.7': 'dsh-0.1.7',
}

/** One committed scenario. `sessionId` selects the raw recording. */
export const SCENARIOS = [
  {
    name: 't1-reasoning-tool-reasoning',
    sessionId: 'fixture-muf44tre-1',
    capturedAt: '2026-04-25',
    dshVersion: '0.1.5-rc.2',
    scenario: 'One turn, two model attempts. Attempt 1 emitted two sequential pwsh tool-call arguments; attempt 2 answered with ordinary text.',
    covers: ['multi-attempt turn', 'pwsh tool arguments as model output', 'sequential tools', 'provider usage without reasoningTokens'],
  },
  {
    name: 't2-pwsh-write-edit',
    sessionId: 'fixture-muf46zj3-2',
    capturedAt: '2026-04-25',
    dshVersion: '0.1.5-rc.2',
    scenario: 'One turn, four model attempts. Model reasoning plus a write call, an edit call, a pwsh call, then a final text answer.',
    covers: ['reasoning block in the same attempt as a tool call', 'write and edit payloads as model output', 'four attempts in one turn', 'tool results excluded from output'],
  },
  {
    name: 't3-interrupted-mid-reasoning',
    sessionId: 'fixture-muf471nx-3',
    capturedAt: '2026-04-25',
    dshVersion: '0.1.5-rc.2',
    scenario: 'One turn, one attempt, cancelled by user request 9 s into a long reasoning stream. The settlement carries interrupted:true and no usage.',
    covers: ['user interruption mid-reasoning', 'aborted turn status', 'partial observed throughput without usage'],
  },
  {
    name: 't4-reasoning-tool-deepseek-official',
    sessionId: 'fixture-muf49uxv-1',
    capturedAt: '2026-04-25',
    dshVersion: '0.1.5-rc.2',
    scenario: 'The same shape as t1 but on the deepseek-official adapter, which reports provider reasoningTokens. One turn, two attempts.',
    covers: ['authoritative reasoningTokens present', 'reasoning + tool call in one attempt', 'exact phase split'],
  },
  {
    name: 't5-reasoning-text-deepseek-official',
    sessionId: 'fixture-muf49yr9-2',
    capturedAt: '2026-04-25',
    dshVersion: '0.1.5-rc.2',
    scenario: 'One turn, one attempt on the deepseek-official adapter: a 1038-fragment reasoning stream followed by a 269-fragment text stream, with authoritative reasoningTokens.',
    covers: ['reasoning then output phase interleave', 'long stream with real intra-stream stalls', 'exact phase split'],
  },
  // ---- Phase 6 additions ---------------------------------------------------
  {
    name: 't6-tool-only-deepseek-official',
    sessionId: 'fixture-muh3cccb-4',
    capturedAt: '2026-04-26',
    dshVersion: '0.1.5-rc.2',
    scenario: 'One turn, four attempts, three pwsh calls, on the deepseek-official adapter. Every attempt after the first emitted reasoning and a tool call and no surface text, so the turn\'s generated output is tool-call argument and reasoning only; the last attempt settled with no tool call and no message.',
    covers: [
      'tool-only turn: no assistant text at all',
      'tool-call arguments counted as model output',
      'reasoning present in a tool-only attempt',
      'an attempt that settled without a surface message',
      'authoritative reasoningTokens on the tool-only path',
    ],
  },
  {
    name: 't7-failing-pwsh-deepseek-official',
    sessionId: 'fixture-muh3e9dj-5',
    capturedAt: '2026-04-26',
    dshVersion: '0.1.5-rc.2',
    scenario: 'One turn, two attempts. Attempt 1 called pwsh with a parameter that does not exist; DSH still recorded the call as successful and delivered the PowerShell error text as the tool result. Attempt 2 answered with ordinary text.',
    covers: [
      'a failed shell command inside a successful tool call',
      'stderr delivered as tool output rather than as a tool error',
      'tool status and turn status stay separate',
      'turn still completes after a failing command',
    ],
  },
  {
    name: 't8-reasoning-no-retry-deepseek-official',
    sessionId: 'fixture-muh38jd1-3',
    capturedAt: '2026-04-26',
    dshVersion: '0.1.5-rc.2',
    scenario: 'One turn, one attempt on the deepseek-official adapter with reasoningEffort high. The route was asked for a step-by-step answer specifically to see whether a provider retry would be scheduled; the recording contains no llm/retry event, so this fixture is negative evidence about retry frequency on this route rather than an example of one.',
    covers: [
      'model/selection recorded in the durable log',
      'reasoning-only attempt with authoritative reasoningTokens',
      'no llm/retry on this route under this prompt',
    ],
  },
  // ---- Phase 7D additions: the 0.1.7-rc.2 authoritative corpus -------------
  {
    name: 't01-sequential-tools',
    family: '0.1.7',
    sessionId: 'fixture-mujjrw4r-1',
    capturedAt: '2026-09-27',
    dshVersion: '0.1.7-rc.2',
    scenario: 'One turn, three model attempts, two strictly sequential pwsh calls and never more than one running at a time. Shape: model -> pwsh -> model -> pwsh -> model -> completed, with `turn/end` reason kind `completed`.',
    covers: [
      'the 0.1.7 first-class tool-role result message',
      'message.toolCallId as the call identity (content blocks carry none)',
      'message.isError at the top level of the tool-role message',
      'sequential tool calls that must never accumulate as concurrent',
      'step/end between each tool call and the next attempt',
      'a normally completed turn whose turn/end row is present',
      'three transient attempts, each with a start and an end frame',
    ],
  },
]

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const scenario of SCENARIOS) console.log(`${scenario.name}  ←  ${scenario.sessionId}`)
  process.exit(0)
}
const selected = args.filter(arg => !arg.startsWith('--'))
const wanted = selected.length === 0
  ? SCENARIOS
  : SCENARIOS.filter(scenario => selected.includes(scenario.name) || selected.includes(scenario.sessionId))
if (wanted.length === 0) {
  console.error(`no scenario matched ${selected.join(', ')}`)
  process.exit(2)
}

/** Family of one scenario; a scenario without an explicit family is a 0.1.5 capture. */
function familyOf(scenario) {
  return scenario.family ?? '0.1.5'
}

/** Per-family output directory and merged index, so the two corpora never mix. */
const familyState = new Map()
function stateFor(family) {
  const existing = familyState.get(family)
  if (existing !== undefined) return existing
  const outDir = join(repoRoot, 'fixtures', FAMILY_DIRS[family] ?? family)
  mkdirSync(outDir, { recursive: true })
  /**
   * The 0.1.5 index has always lived at `fixtures/index.json`; a later family
   * keeps its index **inside** its own directory, because the sanitization
   * verifier treats every `*.json` at the fixtures root as a published fixture
   * (`scripts/verify-sanitization.mjs` `fixtureNames`). An index parked beside
   * the corpora would be scanned as evidence and reported as missing redaction
   * markers, which is a false alarm about a file that is not evidence at all.
   */
  const indexPath = family === '0.1.5'
    ? join(repoRoot, 'fixtures', 'index.json')
    : join(outDir, 'index.json')
  /**
   * The index is **merged**, not replaced. A selective harvest used to drop every
   * unselected fixture from the index, so `node dev/harvest-fixtures.mjs t6-...`
   * silently erased the record of t1–t5 even though their files were untouched.
   */
  const existingIndex = (() => {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
      return Array.isArray(parsed.fixtures) ? parsed.fixtures : []
    } catch {
      return []
    }
  })()
  const state = {
    outDir,
    family,
    indexPath,
    merged: new Map(existingIndex.map(entry => [entry.fixture, entry])),
    wrote: [],
  }
  familyState.set(family, state)
  return state
}

for (const scenario of wanted) {
  const family = familyOf(scenario)
  const state = stateFor(family)
  const outDir = state.outDir
  const rawPath = join(rawDir, `${scenario.sessionId}.jsonl`)
  let rows
  try {
    rows = readFileSync(rawPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    console.error(`SKIP ${scenario.name}: cannot read ${rawPath}: ${String(error)}`)
    continue
  }

  const durable = rows.filter(row => row.plane === 'durable')
    .map(row => ({ wallClockMs: row.wallClockMs, event: row.sessionEvent }))
  const transient = rows.filter(row => row.plane === 'transient')
    .map(row => ({ wallClockMs: row.wallClockMs, frame: row.frame }))
  const meta = rows.filter(row => row.plane === 'meta')

  const turnStarts = durable.filter(row => row.event.type === 'turn/start')
  const turnEnds = durable.filter(row => row.event.type === 'turn/end')
  const settlements = durable.filter(row => row.event.type === 'assistant/message' || row.event.type === 'assistant/attempt')
  const firstEventTime = durable[0]?.event?.time ?? null
  const lastEventTime = durable.at(-1)?.event?.time ?? null

  const fixture = {
    fixture: scenario.name,
    capturedAt: scenario.capturedAt,
    dshVersion: scenario.dshVersion,
    captureFamily: family,
    sessionId: scenario.sessionId,
    scenario: scenario.scenario,
    covers: scenario.covers,
    provenance: {
      recorder: 'dev/fixture-recorder (@dsh-external/dsh-turn-meter-fixture-recorder)',
      recordingStartedAtMs: meta[0]?.wallClockMs ?? null,
      durablePlane: 'ctx.on("session/event", (session, event) => …) — verbatim SessionEvent envelopes',
      transientPlane: 'ctx.on("agent/assistant-stream", ({agent, frame}) => …) — verbatim AssistantStreamFrame values',
      note: 'Both planes are copied without normalization, reordering or omission.',
    },
    summary: {
      durableEventCount: durable.length,
      transientFrameCount: transient.length,
      turnStartCount: turnStarts.length,
      turnEndCount: turnEnds.length,
      settlementCount: settlements.length,
      firstEventTimeMs: firstEventTime,
      lastEventTimeMs: lastEventTime,
      turnEndReasons: turnEnds.map(row => row.event.data.reason?.kind ?? null),
      /**
       * `tool/result` call pairing, read the way the target DSH version stores
       * it. Recorded per fixture so the shape a capture proves is visible in the
       * fixture itself rather than asserted only by a test.
       */
      toolCallCount: durable.filter(row => row.event.type === 'tool/call').length,
      toolResultCount: durable.filter(row => row.event.type === 'tool/result').length,
      toolResultShape: (() => {
        const first = durable.find(row => row.event.type === 'tool/result')
        if (first === undefined) return null
        const message = first.event.data?.message ?? {}
        return {
          role: message.role ?? null,
          identityLocation: typeof message.toolCallId === 'string' ? 'message.toolCallId'
            : Array.isArray(message.content) && typeof message.content[0]?.toolCallId === 'string'
              ? 'message.content[0].toolCallId'
              : 'none',
          isErrorLocation: typeof message.isError === 'boolean' ? 'message.isError'
            : Array.isArray(message.content) && typeof message.content[0]?.isError === 'boolean'
              ? 'message.content[0].isError'
              : 'none',
        }
      })(),
      settlements: settlements.map(row => {
        const data = row.event.data
        return {
          seq: row.event.seq,
          time: row.event.time,
          type: row.event.type,
          turn: data.turn,
          step: data.step,
          usage: data.usage ?? null,
          interrupted: data.interrupted ?? false,
          streamRecordCount: Array.isArray(data.stream) ? data.stream.length : 0,
        }
      }),
    },
    durable,
    transient,
    meta,
  }

  const outPath = join(outDir, `${scenario.name}.json`)
  writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  const bytes = readFileSync(outPath).length
  console.log(`wrote ${outPath} (${(bytes / 1024).toFixed(1)} KiB, durable ${durable.length}, transient ${transient.length})`)
  state.merged.set(scenario.name, {
    fixture: scenario.name,
    sessionId: scenario.sessionId,
    scenario: scenario.scenario,
    dshVersion: scenario.dshVersion,
    captureFamily: family,
    durableEventCount: durable.length,
    transientFrameCount: transient.length,
  })
  state.wrote.push(scenario.name)
}

/** Newest scenario order, so each index reads in recording order. */
for (const state of familyState.values()) {
  const ordered = SCENARIOS
    .filter(scenario => familyOf(scenario) === state.family)
    .map(scenario => state.merged.get(scenario.name))
    .filter(entry => entry !== undefined)
  writeFileSync(state.indexPath, `${JSON.stringify({ fixtures: ordered }, null, 2)}\n`)
  console.log(`index ${state.indexPath}: ${ordered.length} fixtures`)
}
