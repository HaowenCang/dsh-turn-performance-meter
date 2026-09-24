import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeToolCalls, unionDurationMs } from '../src/core/tool-timing.js'

test('parallel tools separate summed work from wall union', () => {
  const s = summarizeToolCalls([
    { startMs: 0, endMs: 1000, status: 'ok' },
    { startMs: 500, endMs: 1500, status: 'ok' },
  ])
  assert.equal(s.workMs, 2000)
  assert.equal(s.wallMs, 1500, 'the 500 ms overlap is counted once')
  assert.ok(s.workMs > s.wallMs)
})

test('non-overlapping tools have equal work and wall time', () => {
  const s = summarizeToolCalls([
    { startMs: 0, endMs: 1000, status: 'ok' },
    { startMs: 1000, endMs: 1500, status: 'ok' },
  ])
  assert.equal(s.workMs, 1500)
  assert.equal(s.wallMs, 1500)
})

test('a running call contributes to neither duration', () => {
  const s = summarizeToolCalls([
    { callId: 'c1', name: 'pwsh', startMs: 0, endMs: 1200, status: 'ok' },
    { callId: 'c2', name: 'read', startMs: 100, endMs: null, status: 'running' },
  ])
  assert.equal(s.count, 2)
  assert.equal(s.completedCount, 1)
  assert.equal(s.runningCount, 1)
  assert.equal(s.workMs, 1200)
  assert.equal(s.wallMs, 1200)
})

test('a zero-duration tool error is counted as latency zero without inflating anything', () => {
  const s = summarizeToolCalls([
    { callId: 'c1', name: 'grep', startMs: 500, endMs: 500, status: 'error' },
  ])
  assert.equal(s.workMs, 0)
  assert.equal(s.wallMs, 0)
  assert.equal(s.failedCount, 1)
})

test('nested intervals merge into one union run', () => {
  assert.equal(unionDurationMs([
    { startMs: 0, endMs: 1000 },
    { startMs: 200, endMs: 400 },
    { startMs: 600, endMs: 800 },
  ]), 1000)
})

test('malformed intervals are dropped rather than producing NaN', () => {
  const s = summarizeToolCalls([
    { startMs: 0, endMs: 1000, status: 'ok' },
    { startMs: 2000, endMs: 1000, status: 'ok' },
    { startMs: NaN, endMs: 5, status: 'ok' },
    null,
  ])
  assert.equal(Number.isFinite(s.workMs), true)
  assert.equal(Number.isFinite(s.wallMs), true)
  assert.equal(s.workMs, 1000)
  assert.equal(s.wallMs, 1000)
})

test('distinct tool names are listed once, in first-seen order', () => {
  const s = summarizeToolCalls([
    { callId: 'a', name: 'pwsh', startMs: 0, endMs: 1, status: 'ok' },
    { callId: 'b', name: 'read', startMs: 0, endMs: 1, status: 'ok' },
    { callId: 'c', name: 'pwsh', startMs: 0, endMs: 1, status: 'ok' },
  ])
  assert.deepEqual(s.names, ['pwsh', 'read'])
})
