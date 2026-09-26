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
  /**
   * A segment ends on its own last model-producing delta, which is also the coordinate the
   * next attempt opens on — the same instant, stated once.
   */
  assert.deepEqual(result.segments, [
    {
      attemptId: 'a',
      startMs: 0,
      endMs: 2000,
      localEndMs: 2000,
      sampleCount: 2,
    },
    {
      attemptId: 'b',
      startMs: 2000,
      endMs: 3000,
      localEndMs: 1000,
      sampleCount: 2,
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

test('every attempt is bounded by its own last delta, the final one included', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 0 }, { timeMs: 500 }] },
    { attemptId: 'b', samples: [{ timeMs: 900 }, { timeMs: 1400 }] },
    { attemptId: 'c', samples: [{ timeMs: 2000 }, { timeMs: 2500 }] },
  ])
  assert.deepEqual(result.segments.map(s => [s.startMs, s.endMs]), [
    [0, 500],
    [500, 1000],
    [1000, 1500],
  ])
  assert.equal(result.segments.at(-1).endMs, result.durationMs,
    'the final attempt ends on its own last delta, at the axis end and never past it')
  for (let index = 1; index < result.segments.length; index += 1) {
    assert.equal(result.segments[index - 1].endMs, result.segments[index].startMs,
      'and each attempt opens on the coordinate its predecessor closed on')
  }
  assert.equal('nextStartMs' in result.segments[0], false,
    'the successor bound is gone: it was the same coordinate as endMs, and it existed only to give the final attempt a tail')
  assert.equal('hasSuccessor' in result.segments[0], false)
})

test('the authoritative stream ordinal survives compression', () => {
  /**
   * Array position in the stored attempt **is** the stream order, and `compressAttempts` is
   * where it becomes explicit: the ordinal is captured before any timestamp sort and
   * published as `sampleOrder`, so the curve layer never has to infer an order from a phase
   * name or from whichever array a caller hands in.
   */
  const result = compressAttempts([{
    attemptId: 'a',
    samples: [
      { timeMs: 0, phase: 'output', tokens: 20 },
      { timeMs: 0, phase: 'reasoning', tokens: 10 },
      { timeMs: 500, phase: 'output', tokens: 5 },
    ],
  }])
  assert.deepEqual(result.samples.map(sample => sample.sampleOrder), [0, 1, 2])
  assert.deepEqual(result.samples.map(sample => sample.phase), ['output', 'reasoning', 'output'],
    'two samples at one instant keep the order they were stored in')

  /** A sample that already carries an ordinal keeps it rather than being renumbered. */
  const restamped = compressAttempts([{
    attemptId: 'a',
    samples: [
      { timeMs: 0, phase: 'output', sampleOrder: 7 },
      { timeMs: 0, phase: 'reasoning', sampleOrder: 2 },
    ],
  }])
  assert.deepEqual(restamped.samples.map(sample => sample.sampleOrder), [2, 7],
    'and the samples are emitted in that ordinal order, not in array order')
  assert.deepEqual(restamped.samples.map(sample => sample.phase), ['reasoning', 'output'])
})

test('a zero-width attempt with two simultaneous deltas keeps both', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 0, phase: 'output' }, { timeMs: 0, phase: 'reasoning' }] },
  ])
  assert.equal(result.durationMs, 0)
  assert.deepEqual(result.samples.map(sample => [sample.attemptTimeMs, sample.sampleOrder]), [[0, 0], [0, 1]])
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
