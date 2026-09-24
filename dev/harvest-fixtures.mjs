/**
 * Harvest raw fixture recordings into committed scenario fixtures.
 *
 * The raw JSONL under the DSH home is produced by `dev/fixture-recorder` and is
 * the evidence: it is never edited. This script only *selects and reshapes* it
 * into a stable, reviewable per-scenario file:
 *
 *   fixtures/dsh-turns/<name>.json
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
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const rawDir = process.env.FIXTURE_RAW_DIR
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'turn-meter-fixtures', 'raw')
const outDir = join(repoRoot, 'fixtures', 'dsh-turns')

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

mkdirSync(outDir, { recursive: true })
const index = []

for (const scenario of wanted) {
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
  index.push({
    fixture: scenario.name,
    sessionId: scenario.sessionId,
    scenario: scenario.scenario,
    durableEventCount: durable.length,
    transientFrameCount: transient.length,
  })
}

writeFileSync(join(outDir, '..', 'index.json'), `${JSON.stringify({ fixtures: index }, null, 2)}\n`, 'utf8')
console.log(`index: ${index.length} fixtures`)
