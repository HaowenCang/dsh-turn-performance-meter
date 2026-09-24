import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyDelta,
  deltaText,
  expandAssistantStream,
  firstTokenTime,
  isTokenDelta,
  usageFromChunk,
} from '../src/core/delta-accounting.js'

test('tool-call arguments are model output; tool results are not stream chunks', () => {
  assert.equal(classifyDelta({ type: 'tool-call-delta', argumentsDelta: '{"x":1}' }), 'output')
  assert.equal(classifyDelta({ type: 'reasoning-delta', text: 'think' }), 'reasoning')
  assert.equal(classifyDelta({ type: 'text-delta', text: 'answer' }), 'output')

  // A pwsh command, a write-file body and an edit patch are all tool-call
  // arguments, so all three are model output.
  assert.equal(classifyDelta({ type: 'tool-call-delta', argumentsDelta: 'Get-ChildItem -Recurse' }), 'output')
  assert.equal(classifyDelta({ type: 'tool-call-delta', argumentsDelta: '{"file_path":"a.js","content":"…"}' }), 'output')
  assert.equal(classifyDelta({ type: 'tool-call-delta', argumentsDelta: '<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>>' }), 'output')
})

test('empty and non-generated chunks contribute nothing', () => {
  assert.equal(classifyDelta({ type: 'text-delta', text: '' }), null)
  assert.equal(classifyDelta({ type: 'reasoning-delta', text: '' }), null)
  assert.equal(classifyDelta({ type: 'tool-call-delta', argumentsDelta: '' }), null)
  assert.equal(classifyDelta({ type: 'block-start', index: 0, blockType: 'text' }), null)
  assert.equal(classifyDelta({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }), null)
  assert.equal(classifyDelta({ type: 'finish', reason: 'stop' }), null)
  assert.equal(classifyDelta(null), null)
})

test('isTokenDelta matches the verified DSH first-token predicate', () => {
  assert.equal(isTokenDelta({ type: 'text-delta', text: 'a' }), true)
  assert.equal(isTokenDelta({ type: 'reasoning-delta', text: 'a' }), true)
  assert.equal(isTokenDelta({ type: 'tool-call-delta', id: 'c1', argumentsDelta: '{' }), true)
  // A name-bearing tool-call delta counts even with an empty argument fragment.
  assert.equal(isTokenDelta({ type: 'tool-call-delta', id: 'c1', name: 'pwsh', argumentsDelta: '' }), true)
  assert.equal(isTokenDelta({ type: 'tool-call-delta', id: 'c1', argumentsDelta: '' }), false)
  assert.equal(isTokenDelta({ type: 'text-delta', text: '' }), false)
  assert.equal(isTokenDelta({ type: 'block-end', index: 0, block: {} }), false)
  assert.equal(isTokenDelta({ type: 'usage', usage: {} }), false)
  assert.equal(isTokenDelta({ type: 'finish', reason: 'stop' }), false)
})

test('deltaText reads only generated content', () => {
  assert.equal(deltaText({ type: 'text-delta', text: 'hi' }), 'hi')
  assert.equal(deltaText({ type: 'reasoning-delta', text: 'hm' }), 'hm')
  assert.equal(deltaText({ type: 'tool-call-delta', argumentsDelta: '{}' }), '{}')
  assert.equal(deltaText({ type: 'usage', usage: {} }), '')
})

test('usage chunks expose authoritative aggregate usage mid-attempt', () => {
  assert.deepEqual(
    usageFromChunk({ type: 'usage', usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 8 } }),
    { inputTokens: 10, outputTokens: 20, reasoningTokens: 8 },
  )
  assert.equal(usageFromChunk({ type: 'usage', usage: { inputTokens: 10 } }), null)
  assert.equal(usageFromChunk({ type: 'text-delta', text: 'x' }), null)
})

test('compact stream runs expand with every delta boundary and reconstructed time preserved', () => {
  // dt is a per-step gap array whose length is members - 1 (verified invariant),
  // so member i>0 occurs dt[i-1] ms after member i-1.
  const expanded = expandAssistantStream([
    { type: 'reasoning-chunks', time0: 1000, index: 0, dt: [10, 10], texts: ['a', 'b', 'c'] },
    { type: 'tool-call-chunks', time0: 1030, index: 1, dt: [5], id: 'call_1', name: 'pwsh', args: ['{"cmd"', ':"ls"}'] },
    { type: 'chunk', time: 1040, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 9 } } },
  ])

  assert.equal(expanded.length, 6)
  assert.deepEqual(expanded.map(entry => entry.timeMs), [1000, 1010, 1020, 1030, 1035, 1040])
  assert.deepEqual(expanded.map(entry => entry.chunk.type), [
    'reasoning-delta', 'reasoning-delta', 'reasoning-delta', 'tool-call-delta', 'tool-call-delta', 'usage',
  ])
  assert.equal(expanded[3].chunk.name, 'pwsh')
  assert.equal(expanded[3].chunk.id, 'call_1')
  assert.equal(expanded[3].chunk.argumentsDelta, '{"cmd"')
  assert.equal(expanded[4].chunk.argumentsDelta, ':"ls"}')
})

test('a single-member run needs no dt entry', () => {
  const expanded = expandAssistantStream([
    { type: 'text-chunks', time0: 500, index: 0, dt: [], texts: ['only'] },
  ])
  assert.deepEqual(expanded, [{ timeMs: 500, chunk: { type: 'text-delta', index: 0, text: 'only' } }])
})

test('malformed stream records degrade instead of throwing away the turn', () => {
  const expanded = expandAssistantStream([
    // dt length must be members - 1; a mismatch makes the whole run unreadable.
    { type: 'reasoning-chunks', time0: 100, index: 0, dt: [1, 2], texts: ['x', 'y'] },
    { type: 'text-chunks', time0: 250, index: 0, dt: [], texts: ['solo'] },
    { type: 'chunk', time: 'nope', chunk: { type: 'finish', reason: 'stop' } },
    null,
    { type: 'text-chunks', time0: 300, index: 0, dt: [1], texts: ['a', 'b'] },
  ])
  assert.deepEqual(expanded.map(entry => entry.timeMs), [250, 300, 301])
  assert.deepEqual(expanded.map(entry => entry.chunk.text), ['solo', 'a', 'b'])
  assert.equal(expanded.some(entry => entry.chunk.type === 'reasoning-delta'), false)
})

test('firstTokenTime ignores leading empty and non-generated chunks', () => {
  assert.equal(firstTokenTime([
    { timeMs: 900, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { timeMs: 950, chunk: { type: 'text-delta', text: '' } },
    { timeMs: 1000, chunk: { type: 'text-delta', text: 'hello' } },
  ]), 1000)
  assert.equal(firstTokenTime([{ timeMs: 900, chunk: { type: 'finish', reason: 'stop' } }]), null)
  assert.equal(firstTokenTime([]), null)
})
