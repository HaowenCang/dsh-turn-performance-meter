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
   * A segment ends on its **terminal episode's end** — the attempt's settlement instant
   * when one is known, its last generated delta otherwise — and that end is also the
   * coordinate the next attempt opens on, the same instant stated once. With no
   * settlement observed here, each attempt keeps its last delta as the bound.
   */
  assert.deepEqual(result.segments, [
    {
      attemptId: 'a',
      startMs: 0,
      endMs: 2000,
      localEndMs: 2000,
      sampleCount: 2,
      /** No non-magnitude phase boundary was recorded in either attempt. */
      phaseCutCount: 0,
      preOriginCutCount: 0,
    },
    {
      attemptId: 'b',
      startMs: 2000,
      endMs: 3000,
      localEndMs: 1000,
      sampleCount: 2,
      phaseCutCount: 0,
      preOriginCutCount: 0,
    },
  ])
  assert.deepEqual(result.cuts, [], 'no boundary means no cut on the compressed clock')
})

test('a phase cut is mapped onto the same two clocks the samples carry', () => {
  /**
   * The non-magnitude boundary is an **instant**, not a width: it is placed by the
   * same subtraction the samples use, so a cut and a sample that share an absolute
   * instant share a coordinate, and the attempt's own axis is unchanged by it.
   * A cut that precedes the attempt's first delta owns no coordinate at all — an
   * attempt's local zero is its first generated sample — so it is counted rather
   * than clamped onto zero, which would invent a pre-sample instant.
   */
  const result = compressAttempts([
    {
      attemptId: 'a',
      samples: [{ timeMs: 1000 }, { timeMs: 2000 }],
      settledAtMs: 3000,
      phaseCuts: [{ timeMs: 900, phase: 'output' }, { timeMs: 1500, phase: 'output' }],
    },
    { attemptId: 'b', samples: [{ timeMs: 33_000 }, { timeMs: 34_000 }], phaseCuts: [] },
  ])

  assert.deepEqual(result.cuts, [{
    attemptId: 'a',
    timeMs: 1500,
    phase: 'output',
    attemptTimeMs: 500,
    activeTimeMs: 500,
  }], 'the in-attempt cut keeps its absolute instant, its local one and its axis coordinate')
  assert.deepEqual(result.segments.map(segment => [
    segment.startMs, segment.endMs, segment.localEndMs, segment.phaseCutCount, segment.preOriginCutCount,
  ]), [
    [0, 2000, 2000, 1, 1],
    [2000, 3000, 1000, 0, 0],
  ], 'the attempt width is untouched, and the pre-origin boundary is counted rather than placed')
  assert.equal(result.durationMs, 3000)
})

test('every sample carries both clocks, and only the first attempt\'s coincide', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 1000 }, { timeMs: 3000 }] },
    { attemptId: 'b', samples: [{ timeMs: 33_000 }, { timeMs: 34_000 }] },
  ])
  /**
   * `activeTimeMs` is the drawable coordinate; `attemptTimeMs` is the clock a
   * phase episode is measured on. Publishing only the first is what let the
   * completed curve measure one attempt's episode on a turn-global clock while
   * believing it was local.
   */
  assert.deepEqual(result.samples.map(x => x.activeTimeMs), [0, 2000, 2000, 3000])
  assert.deepEqual(result.samples.map(x => x.attemptTimeMs), [0, 2000, 0, 1000])
  for (const sample of result.samples) {
    const segment = result.segments.find(s => s.attemptId === sample.attemptId)
    assert.equal(sample.activeTimeMs, segment.startMs + sample.attemptTimeMs,
      'the coordinate is the attempt\'s own instant, offset to its place on the shared axis')
  }
})

test('every attempt is bounded by its terminal episode end, the final one included', () => {
  /**
   * With no settlement observed, the terminal episode ends at the attempt's last
   * generated delta: the axis still stops there and the next attempt opens on that
   * same coordinate. This is the shape every attempt keeps when the evidence
   * contains no settlement instant.
   */
  const unobserved = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 0 }, { timeMs: 500 }] },
    { attemptId: 'b', samples: [{ timeMs: 900 }, { timeMs: 1400 }] },
    { attemptId: 'c', samples: [{ timeMs: 2000 }, { timeMs: 2500 }] },
  ])
  assert.deepEqual(unobserved.segments.map(s => [s.startMs, s.endMs]), [
    [0, 500],
    [500, 1000],
    [1000, 1500],
  ])
  assert.equal(unobserved.segments.at(-1).endMs, unobserved.durationMs,
    'the final attempt ends at the axis end and never past it')

  /**
   * With a settlement the terminal episode runs to it: that tail is model-attempt
   * elapsed time under the MiMo-style definition, so the segment is wider than the
   * last delta. A settlement recorded *before* the last delta is clock skew and is
   * refused rather than allowed to shrink real generation time.
   *
   *   a  samples 0..500, settles at 700      -> width 700   (tail charged)
   *   b  samples 900..1400, settles at 1400  -> width 500   (settlement on the last delta)
   *   c  samples 2000..2500, settles at 2400 -> width 500   (skew refused, last delta wins)
   */
  const settled = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 0 }, { timeMs: 500 }], settledAtMs: 700 },
    { attemptId: 'b', samples: [{ timeMs: 900 }, { timeMs: 1400 }], settledAtMs: 1400 },
    { attemptId: 'c', samples: [{ timeMs: 2000 }, { timeMs: 2500 }], settledAtMs: 2400 },
  ])
  assert.deepEqual(settled.segments.map(s => [s.startMs, s.endMs]), [
    [0, 700],
    [700, 1200],
    [1200, 1700],
  ])
  assert.deepEqual(settled.samples.map(x => x.activeTimeMs), [0, 500, 700, 1200, 1200, 1700])
  assert.equal(settled.segments[0].localEndMs, 700,
    'the settlement instant ends the terminal episode, past the last generated delta')
  assert.equal(settled.segments[2].localEndMs, 500,
    'a settlement before the last delta cannot shrink real generation time')
  assert.equal(settled.segments.at(-1).endMs, settled.durationMs,
    'the final attempt ends at the axis end and never past it')
  for (let index = 1; index < settled.segments.length; index += 1) {
    assert.equal(settled.segments[index - 1].endMs, settled.segments[index].startMs,
      'and each attempt opens on the coordinate its predecessor closed on')
  }
  assert.equal('nextStartMs' in settled.segments[0], false,
    'the successor bound is gone: it was the same coordinate as endMs, and it existed only to give the final attempt a tail')
  assert.equal('hasSuccessor' in settled.segments[0], false)
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

test('a long tool delay adds no horizontal width at all, while the charged tails still count', () => {
  const samples = [{ timeMs: 0 }, { timeMs: 5000 }]
  const shortGap = compressAttempts([
    { attemptId: 'a', samples, settledAtMs: 5100 },
    { attemptId: 'b', samples: [{ timeMs: 6000 }, { timeMs: 9000 }], settledAtMs: 9050 },
  ])
  const longGap = compressAttempts([
    { attemptId: 'a', samples, settledAtMs: 5100 },
    { attemptId: 'b', samples: [{ timeMs: 65_000 }, { timeMs: 68_000 }], settledAtMs: 68_050 },
  ])
  assert.equal(shortGap.durationMs, longGap.durationMs)
  assert.deepEqual(
    shortGap.samples.map(x => x.activeTimeMs),
    longGap.samples.map(x => x.activeTimeMs),
  )
  /**
   * The width is the attempts' own spans — A's 5100 ms including its charged
   * settlement tail, B's 3050 ms — and the tool wait between them (900 ms in one
   * variant, 59 900 ms in the other) contributes nothing.
   */
  assert.equal(shortGap.durationMs, 5100 + 3050)
})

test('an intra-stream stall keeps its full width inside the attempt, tail included', () => {
  const result = compressAttempts([
    { attemptId: 'a', samples: [{ timeMs: 0 }, { timeMs: 12_000 }, { timeMs: 12_100 }], settledAtMs: 12_350 },
  ])
  assert.deepEqual(result.samples.map(x => x.activeTimeMs), [0, 12_000, 12_100])
  assert.equal(result.durationMs, 12_350,
    'the 12 s stall keeps its full width and the 250 ms settlement tail is appended')
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
