/**
 * The durable `AssistantStreamRecord` decoder.
 *
 * Two obligations are tested here:
 *
 *   - a well-formed compact stream decodes to **every** delta, in order, with its
 *     exact reconstructed timestamp, and the `dt` accumulation rule is the one
 *     DSH itself uses;
 *   - a malformed run is reported, never repaired by invention. The specific
 *     failure mode this guards against is the dangerous one: a decoder that skips
 *     a broken run silently produces a curve that looks authoritative and is
 *     wrong.
 *
 * The rules mirror `validateRecord`/`validateRun` in
 * `dsh-llm/lib/types/assistant-stream.js` (0.1.5-rc.2).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DECODE_ISSUE,
  decodeAssistantStream,
  expandAssistantStream,
  isTokenDelta,
} from '../src/core/delta-accounting.js'
import {
  decodeQuality,
  decodeStreamRecords,
  expandAssistantStreamRaw,
} from '../src/dsh/stream-decoder.js'
import { loadFixture } from './helpers/fixtures.js'

test('dt is a per-step gap array and reconstructs every member timestamp', () => {
  const result = decodeAssistantStream([
    { type: 'reasoning-chunks', time0: 1000, index: 0, dt: [10, 10], texts: ['a', 'b', 'c'] },
    { type: 'chunk', time: 1040, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } } },
    { type: 'tool-call-chunks', time0: 1050, index: 1, dt: [5], id: 'call_1', name: 'pwsh', args: ['{"a"', ':1}'] },
  ])
  assert.equal(result.complete, true)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.chunks.map(entry => entry.timeMs), [1000, 1010, 1020, 1040, 1050, 1055])
  assert.deepEqual(result.chunks.map(entry => entry.chunk.type), [
    'reasoning-delta', 'reasoning-delta', 'reasoning-delta', 'block-end', 'tool-call-delta', 'tool-call-delta',
  ])
  assert.equal(result.chunks[4].chunk.argumentsDelta, '{"a"')
  assert.equal(result.chunks[5].chunk.argumentsDelta, ':1}')
  assert.equal(result.chunks[4].chunk.name, 'pwsh')
  assert.equal(result.decodedRecordCount, 3)
  assert.equal(result.deltaCount, 6)
  assert.equal(result.firstTimeMs, 1000)
  assert.equal(result.lastTimeMs, 1055)
})

test('a single-member run needs no dt entry', () => {
  const result = decodeAssistantStream([{ type: 'text-chunks', time0: 500, index: 0, dt: [], texts: ['only'] }])
  assert.equal(result.complete, true)
  assert.deepEqual(result.chunks, [
    { timeMs: 500, chunk: { type: 'text-delta', index: 0, text: 'only' }, recordIndex: 0, memberIndex: 0 },
  ])
})

test('block, usage and finish chunks survive as raw records between runs', () => {
  const result = decodeAssistantStream([
    { type: 'chunk', time: 10, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'text-chunks', time0: 20, index: 0, dt: [], texts: ['hi'] },
    { type: 'chunk', time: 30, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 5 } } },
    { type: 'chunk', time: 31, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.chunks.map(entry => `${entry.timeMs}:${entry.chunk.type}`),
    ['10:block-start', '20:text-delta', '30:usage', '31:finish'],
  )
})

test('each malformed shape is reported with its own issue kind and produces no delta', () => {
  const cases = [
    { name: 'null record', record: null, issue: DECODE_ISSUE.NOT_AN_OBJECT },
    { name: 'unknown type', record: { type: 'mystery', time0: 1 }, issue: DECODE_ISSUE.UNKNOWN_TYPE },
    {
      name: 'dt length mismatch',
      record: { type: 'reasoning-chunks', time0: 1, index: 0, dt: [1, 2], texts: ['a', 'b'] },
      issue: DECODE_ISSUE.BAD_DT,
    },
    {
      name: 'dt not an integer array',
      record: { type: 'text-chunks', time0: 1, index: 0, dt: [1.5], texts: ['a', 'b'] },
      issue: DECODE_ISSUE.BAD_DT,
    },
    {
      name: 'non-string member',
      record: { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [42] },
      issue: DECODE_ISSUE.BAD_MEMBERS,
    },
    {
      name: 'empty run',
      record: { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [] },
      issue: DECODE_ISSUE.EMPTY_RUN,
    },
    {
      name: 'non-integer time0',
      record: { type: 'text-chunks', time0: 1.25, index: 0, dt: [], texts: ['a'] },
      issue: DECODE_ISSUE.BAD_TIME,
    },
    {
      name: 'extra key',
      record: { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'], extra: true },
      issue: DECODE_ISSUE.UNEXPECTED_KEYS,
    },
    {
      name: 'missing key',
      record: { type: 'tool-call-chunks', time0: 1, index: 0, dt: [], args: ['{}'] },
      issue: DECODE_ISSUE.MISSING_KEYS,
    },
    {
      name: 'empty call id',
      record: { type: 'tool-call-chunks', time0: 1, index: 0, dt: [], id: '', args: ['{}'] },
      issue: DECODE_ISSUE.BAD_CALL_ID,
    },
    {
      name: 'empty tool name',
      record: { type: 'tool-call-chunks', time0: 1, index: 0, dt: [], id: 'c', name: '', args: ['{}'] },
      issue: DECODE_ISSUE.BAD_MEMBERS,
    },
    {
      name: 'raw chunk with unusable chunk',
      record: { type: 'chunk', time: 5, chunk: null },
      issue: DECODE_ISSUE.BAD_RAW_CHUNK,
    },
    {
      name: 'raw chunk with unusable time',
      record: { type: 'chunk', time: 'now', chunk: { type: 'finish', reason: { kind: 'stop' } } },
      issue: DECODE_ISSUE.BAD_TIME,
    },
  ]

  for (const { name, record, issue } of cases) {
    const result = decodeAssistantStream([record])
    assert.equal(result.issues.length, 1, `${name}: expected exactly one reported issue`)
    assert.equal(result.issues[0].kind, issue, `${name}: wrong issue kind`)
    assert.equal(result.issues[0].recordIndex, 0, `${name}: issue must name its record`)
    assert.equal(result.deltaCount, 0, `${name}: no delta may be fabricated`)
    assert.equal(result.complete, false, `${name}: an issue must mark the decode incomplete`)
    assert.equal(decodeQuality(result), 'unavailable')
  }
})

test('one broken run degrades the decode instead of silently shrinking the stream', () => {
  const result = decodeStreamRecords([
    { type: 'reasoning-chunks', time0: 100, index: 0, dt: [1, 2], texts: ['x', 'y'] },
    { type: 'text-chunks', time0: 250, index: 0, dt: [], texts: ['solo'] },
    { type: 'text-chunks', time0: 300, index: 0, dt: [1], texts: ['a', 'b'] },
  ])
  assert.equal(result.complete, false)
  assert.equal(result.issues[0].kind, DECODE_ISSUE.BAD_DT)
  // The good runs still decode: the card degrades, it does not disappear.
  assert.deepEqual(result.chunks.map(entry => entry.chunk.text), ['solo', 'a', 'b'])
  assert.equal(result.quality, 'estimated', 'a partially decoded stream is estimated, never exact')
})

test('the tolerant reader reports the same defects as the strict decoder', () => {
  const records = [
    { type: 'reasoning-chunks', time0: 100, index: 0, dt: [1, 2], texts: ['x', 'y'] },
    { type: 'text-chunks', time0: 250, index: 0, dt: [], texts: ['solo'] },
  ]
  const tolerant = expandAssistantStreamRaw(records)
  assert.equal(tolerant.complete, false)
  assert.deepEqual(tolerant.issues.map(issue => issue.kind), [DECODE_ISSUE.BAD_DT])
  assert.deepEqual(tolerant.chunks.map(entry => entry.chunk.text), ['solo'])
})

test('the plain tolerant expansion keeps its original contract for the live path', () => {
  const expanded = expandAssistantStream([
    { type: 'reasoning-chunks', time0: 100, index: 0, dt: [1, 2], texts: ['x', 'y'] },
    { type: 'text-chunks', time0: 250, index: 0, dt: [], texts: ['solo'] },
    null,
    { type: 'chunk', time: 'nope', chunk: { type: 'finish', reason: 'stop' } },
  ])
  assert.deepEqual(expanded.map(entry => entry.chunk.text), ['solo'])
})

test('time overflow is reported and the members already produced are kept', () => {
  const result = decodeAssistantStream([
    { type: 'text-chunks', time0: Number.MAX_SAFE_INTEGER - 1, index: 0, dt: [5], texts: ['a', 'b'] },
  ])
  assert.equal(result.chunks.length, 1, 'the member before the overflow is real evidence and stays')
  assert.equal(result.complete, false)
  assert.deepEqual(result.issues.map(issue => issue.kind), [DECODE_ISSUE.TIME_OVERFLOW])
})

test('a non-array input degrades to unavailable rather than throwing', () => {
  for (const value of [undefined, null, 'nope', 42, {}]) {
    const result = decodeStreamRecords(value)
    assert.equal(result.quality, 'unavailable')
    assert.equal(result.chunks.length, 0)
    assert.equal(result.issues.length, 1)
  }
})

test('every recorded fixture decodes completely and losslessly', () => {
  for (const name of ['t1-reasoning-tool-reasoning', 't2-pwsh-write-edit', 't3-interrupted-mid-reasoning', 't4-reasoning-tool-deepseek-official', 't5-reasoning-text-deepseek-official']) {
    const fixture = loadFixture(name)
    const settlements = fixture.durable
      .map(row => row.event)
      .filter(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')
    assert.ok(settlements.length > 0, `${name}: no settlement to decode`)

    for (const event of settlements) {
      const decoded = decodeStreamRecords(event.data.stream)
      assert.equal(decoded.complete, true, `${name} seq=${event.seq}: real records must decode completely`)
      assert.deepEqual(decoded.issues, [], `${name} seq=${event.seq}`)
      assert.equal(decoded.quality, 'exact')
      assert.ok(decoded.deltaCount > 0, `${name} seq=${event.seq}: a settlement carried no delta`)

      // Every timestamp must be monotonically non-decreasing in stream order,
      // which is the property the whole curve depends on.
      for (let index = 1; index < decoded.chunks.length; index += 1) {
        assert.ok(
          decoded.chunks[index].timeMs >= decoded.chunks[index - 1].timeMs,
          `${name} seq=${event.seq}: reconstructed times went backwards at ${index}`,
        )
      }
    }
  }
})

test('a real fixture decodes to the same generated deltas the live plane recorded', () => {
  const fixture = loadFixture('t4-reasoning-tool-deepseek-official')
  const event = fixture.durable.map(row => row.event).find(e => e.type === 'assistant/message')
  const decoded = decodeStreamRecords(event.data.stream)
  const expected = fixture.transient
    .map(row => row.frame)
    .filter(frame => frame.type === 'chunk' && frame.attemptId.endsWith(':1'))
    .map(frame => frame.chunk)
    .filter(isTokenDelta)

  assert.deepEqual(
    decoded.chunks.filter(entry => isTokenDelta(entry.chunk)).map(entry => ({
      timeMs: entry.timeMs,
      type: entry.chunk.type,
      text: entry.chunk.text ?? entry.chunk.argumentsDelta,
    })),
    expected.map(chunk => ({
      timeMs: fixture.transient.find(row => row.frame.type === 'chunk' && row.frame.chunk === chunk)?.frame.time ?? null,
      type: chunk.type,
      text: chunk.text ?? chunk.argumentsDelta,
    })),
  )
})
