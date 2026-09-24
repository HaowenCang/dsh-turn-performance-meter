/**
 * Inspect one raw fixture recording produced by `dev/fixture-recorder`.
 *
 * Usage:
 *   node dev/inspect-recording.mjs <sessionId|path> [--transient N]
 *
 * Prints the durable chronology, then the transient frame chronology, using
 * Node's JSON parser so nothing is mangled by a shell's own serializer.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const rawDir = process.env.FIXTURE_RAW_DIR
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'turn-meter-fixtures', 'raw')

const arg = process.argv[2]
if (!arg) {
  console.error('usage: node dev/inspect-recording.mjs <sessionId|path> [--transient N]')
  process.exit(2)
}
const transientLimit = (() => {
  const index = process.argv.indexOf('--transient')
  return index === -1 ? 12 : Number(process.argv[index + 1])
})()

const file = arg.endsWith('.jsonl') ? arg : join(rawDir, `${arg}.jsonl`)
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))

const durable = rows.filter(row => row.plane === 'durable')
const transient = rows.filter(row => row.plane === 'transient')
const meta = rows.filter(row => row.plane === 'meta')

console.log(`file: ${file}`)
console.log(`rows: ${rows.length} (durable ${durable.length}, transient ${transient.length}, meta ${meta.length})`)

console.log('\n── meta ──')
for (const row of meta) console.log(`${row.kind} ${JSON.stringify(row.detail ?? {})}`)

console.log('\n── durable ──')
for (const row of durable) {
  const event = row.sessionEvent
  const data = event.data ?? {}
  let extra = ''
  if (event.type === 'assistant/message') {
    extra = ` usage=${JSON.stringify(data.usage ?? null)} streamRecords=${data.stream?.length ?? 0}`
      + ` interrupted=${data.interrupted ?? false} blocks=${data.message?.content?.map(b => b.type).join(',') ?? ''}`
    const records = data.stream ?? []
    extra += ` recordTypes=${records.map(r => `${r.type}${r.type.endsWith('chunks') ? `[${(r.texts ?? r.args)?.length ?? 0}]` : ''}`).join(' ')}`
  } else if (event.type === 'assistant/attempt') {
    extra = ` streamRecords=${data.stream?.length ?? 0}`
  } else if (event.type === 'tool/call') {
    extra = ` name=${data.name} callId=${data.callId} step=${data.step} args=${JSON.stringify(data.arguments).slice(0, 90)}`
  } else if (event.type === 'tool/result') {
    const block = data.message?.content?.[0] ?? {}
    extra = ` callId=${block.toolCallId} isError=${block.isError} text=${JSON.stringify(block.content ?? null).slice(0, 70)}`
  } else if (event.type === 'turn/end') {
    extra = ` turn=${data.turn} reason=${JSON.stringify(data.reason)}`
  } else if (event.type === 'step/start' || event.type === 'step/end') {
    extra = ` turn=${data.turn} step=${data.step}`
  }
  console.log(`seq=${String(event.seq).padStart(4)} t=${event.time} ${event.type}${extra}`)
}

console.log(`\n── transient (first ${transientLimit}) ──`)
for (const row of transient.slice(0, transientLimit)) {
  const frame = row.frame
  const tail = frame.type === 'chunk'
    ? ` index=${frame.index} time=${frame.time} chunk=${JSON.stringify(frame.chunk).slice(0, 120)}`
    : frame.type === 'end'
      ? ` index=${frame.index} outcome=${JSON.stringify(frame.outcome)}`
      : ` turn=${frame.turn} step=${frame.step}`
  console.log(`${frame.type.padEnd(6)} attempt=${frame.attemptId} rev=${frame.revision}${tail}`)
}
if (transient.length > transientLimit) {
  console.log('…')
  for (const row of transient.slice(-4)) {
    const frame = row.frame
    const tail = frame.type === 'chunk'
      ? ` index=${frame.index} time=${frame.time} chunk=${JSON.stringify(frame.chunk).slice(0, 120)}`
      : frame.type === 'end'
        ? ` index=${frame.index} outcome=${JSON.stringify(frame.outcome)}`
        : ` turn=${frame.turn} step=${frame.step}`
    console.log(`${frame.type.padEnd(6)} attempt=${frame.attemptId} rev=${frame.revision}${tail}`)
  }
}

const attempts = new Map()
for (const row of transient) {
  const frame = row.frame
  const entry = attempts.get(frame.attemptId) ?? { start: null, chunks: 0, end: null, revs: new Set() }
  if (frame.type === 'start') entry.start = frame
  else if (frame.type === 'chunk') entry.chunks += 1
  else entry.end = frame
  entry.revs.add(frame.revision)
  attempts.set(frame.attemptId, entry)
}
console.log('\n── attempt summary ──')
for (const [attemptId, entry] of attempts) {
  console.log(`${attemptId}: chunks=${entry.chunks} revisions=[${[...entry.revs].join(',')}]`
    + ` start=${entry.start ? `turn=${entry.start.turn} step=${entry.start.step} rev=${entry.start.revision}` : '—'}`
    + ` end=${entry.end ? `index=${entry.end.index} outcome=${JSON.stringify(entry.end.outcome)}` : '—'}`)
}
