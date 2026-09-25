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
    {
      attemptId: 'a',
      startMs: 0,
      endMs: 2000,
      localEndMs: 2000,
      sampleCount: 2,
      nextStartMs: 2000,
      hasSuccessor: true,
    },
    {
      attemptId: 'b',
      startMs: 2000,
      endMs: 3000,
      localEndMs: 1000,
      sampleCount: 2,
      nextStartMs: 3000,
      hasSuccessor: false,
    },
  ])
})

test('every sample carries both clocks, and only the first attempt\'s coincide', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 1000 }, { timeMs: 3000 }] },
    { attemptId: 'b', samples: [{ timeMs: 33_000 }, { timeMs: 34_000 }] },
  ])
  /**
   * `activeTimeMs` is the drawable coordinate; `attemptTimeMs` is the clock the
   * rolling window is measured on. Publishing only the first is what let the
   * completed curve roll a turn-global window while believing it was local.
   */
  assert.deepEqual(result.samples.map(x => x.activeTimeMs), [0, 2000, 2000, 3000])
  assert.deepEqual(result.samples.map(x => x.attemptTimeMs), [0, 2000, 0, 1000])
  for (const sample of result.samples) {
    const segment = result.segments.find(s => s.attemptId === sample.attemptId)
    assert.equal(sample.activeTimeMs, segment.startMs + sample.attemptTimeMs,
      'the coordinate is the attempt\'s own instant, offset to its place on the shared axis')
  }
})

test('the last attempt is bounded by its own end, earlier ones by the next start', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 0 }, { timeMs: 500 }] },
    { attemptId: 'b', samples: [{ timeMs: 900 }, { timeMs: 1400 }] },
    { attemptId: 'c', samples: [{ timeMs: 2000 }, { timeMs: 2500 }] },
  ])
  assert.deepEqual(result.segments.map(s => [s.startMs, s.endMs, s.nextStartMs]), [
    [0, 500, 500],
    [500, 1000, 1000],
    [1000, 1500, 1500],
  ])
  assert.equal(result.segments.at(-1).nextStartMs, result.segments.at(-1).endMs,
    'an attempt may never be drawn past the coordinate it owns')
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
