import test from 'node:test'
import assert from 'node:assert/strict'
import { compressAttempts } from '../src/core/time-axis.js'

test('compressed chart removes tool/inter-attempt wall gaps and next-call TTFT', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 1000 }, { timeMs: 3000 }] },
    // 30 second tool gap before the next call.
    { attemptId: 'b', samples: [{ timeMs: 33_000 }, { timeMs: 34_000 }] },
  ])
  // Attempt A: local 0 and 2000. Attempt B starts immediately at 2000.
  assert.deepEqual(result.samples.map(x => x.activeTimeMs), [0, 2000, 2000, 3000])
  assert.equal(result.durationMs, 3000)
  assert.deepEqual(result.segments, [
    { attemptId: 'a', startMs: 0, endMs: 2000 },
    { attemptId: 'b', startMs: 2000, endMs: 3000 },
  ])
})

test('a long tool delay adds no horizontal width at all', () => {
  const samples = [{ timeMs: 0 }, { timeMs: 5000 }]
  const shortGap = compressAttempts([
    { attemptId: 'a', samples },
    { attemptId: 'b', samples: [{ timeMs: 6000 }, { timeMs: 9000 }] },
  ])
  const longGap = compressAttempts([
    { attemptId: 'a', samples },
    { attemptId: 'b', samples: [{ timeMs: 65_000 }, { timeMs: 68_000 }] },
  ])
  assert.equal(shortGap.durationMs, longGap.durationMs)
  assert.deepEqual(
    shortGap.samples.map(x => x.activeTimeMs),
    longGap.samples.map(x => x.activeTimeMs),
  )
})

test('an intra-stream stall keeps its full width inside the attempt', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 0 }, { timeMs: 12_000 }, { timeMs: 12_100 }] },
  ])
  assert.deepEqual(result.samples.map(x => x.activeTimeMs), [0, 12_000, 12_100])
  assert.equal(result.durationMs, 12_100)
})

test('attempts with no generated delta consume no width', () => {
  const result = compressAttempts([
    { attemptId: 'void', samples: [] },
    { attemptId: 'a', samples: [{ timeMs: 500 }, { timeMs: 1500 }] },
    { attemptId: 'void2', samples: null },
    { attemptId: 'b', samples: [{ timeMs: 99_000 }, { timeMs: 99_400 }] },
  ])
  assert.deepEqual(result.samples.map(x => x.activeTimeMs), [0, 1000, 1000, 1400])
  assert.equal(result.durationMs, 1400)
  assert.deepEqual(result.segments.map(s => s.attemptId), ['a', 'b'])
})

test('simultaneous deltas produce a zero-length segment without breaking the axis', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 10 }, { timeMs: 10 }] },
    { attemptId: 'b', samples: [{ timeMs: 20 }, { timeMs: 30 }] },
  ])
  assert.deepEqual(result.samples.map(x => x.activeTimeMs), [0, 0, 0, 10])
  assert.equal(result.durationMs, 10)
})
