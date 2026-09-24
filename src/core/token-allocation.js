import { MetricQuality } from './metric-quality.js'
import { classifyDelta, deltaText } from './delta-accounting.js'

/**
 * Live token-shape weighting and post-hoc calibration.
 *
 * DSH does not attach an exact token count to each streamed delta; provider
 * usage arrives as an aggregate (`TokenUsage`). Every per-delta number this
 * module produces is therefore a *shape*, and the only honest operations are
 * (a) label it estimated and (b) rescale the shape so its integral equals the
 * authoritative aggregate once that aggregate is known.
 *
 * Calibration guarantees, asserted by tests:
 *   - the rescaled per-phase float integral equals the exact aggregate total
 *     exactly (relative error < 1e-9), because the sum of the scaling products
 *     is algebraically the total;
 *   - a phase with tokens but no shape weight distributes evenly rather than
 *     dividing by zero;
 *   - a phase with no samples keeps its authoritative total with zero samples
 *     when the total is zero, and reports the shortfall otherwise instead of
 *     inventing curve points.
 */

/**
 * Fallback shape weight for live display only. This is **not** a tokenizer and
 * must never be presented as provider-exact: the project rules forbid assuming
 * GPT/tiktoken tokenization for DeepSeek or any other route, and DSH's own token
 * meter uses an approximate character heuristic when provider-exact usage is
 * unavailable.
 *
 * CJK-like code points weigh 1; everything else weighs 0.25. The ratio is a
 * deliberate coarse prior (roughly one token per CJK character, roughly four
 * Latin characters per token) whose only role is to shape the live and curve
 * series until calibration replaces it.
 */
export function heuristicTokenWeight(text) {
  if (!text) return 0
  let weight = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    const cjk = (cp >= 0x3400 && cp <= 0x9fff)
      || (cp >= 0x3040 && cp <= 0x30ff)
      || (cp >= 0xac00 && cp <= 0xd7af)
      || (cp >= 0xf900 && cp <= 0xfaff)
    weight += cjk ? 1 : 0.25
  }
  return weight
}

/**
 * Build one chart/live sample from a chunk, or `null` when the chunk carries no
 * generated content (block, usage and finish chunks carry none).
 *
 * @param {number} timeMs
 * @param {unknown} chunk
 * @param {(text:string, phase:string, chunk:unknown)=>number} [estimate]
 */
export function sampleFromChunk(timeMs, chunk, estimate = heuristicTokenWeight) {
  const phase = classifyDelta(chunk)
  if (phase === null) return null
  if (!Number.isFinite(timeMs)) return null
  const text = deltaText(chunk)
  const weight = estimate(text, phase, chunk)
  if (!(weight > 0) || !Number.isFinite(weight)) {
    // A generated delta whose shape weight is zero is still evidence that
    // generation happened. Give it a minimal non-zero shape so it cannot vanish
    // from the series; calibration later fixes its magnitude.
    return { timeMs, phase, weight: Number.EPSILON, tokens: Number.EPSILON, quality: MetricQuality.ESTIMATED }
  }
  return { timeMs, phase, weight, tokens: weight, quality: MetricQuality.ESTIMATED }
}

/** Sample a whole timed chunk list, dropping non-generated chunks. */
export function samplesFromTimedChunks(timedChunks, estimate = heuristicTokenWeight) {
  const out = []
  if (!Array.isArray(timedChunks)) return out
  for (const entry of timedChunks) {
    if (!entry) continue
    const sample = sampleFromChunk(entry.timeMs, entry.chunk, estimate)
    if (sample !== null) out.push(sample)
  }
  return out
}

/**
 * Rescale one phase's shape weights so their integral equals `exactTokens`.
 * Pure: returns new objects and never mutates the input.
 */
export function calibratePhase(samples, exactTokens) {
  if (!Array.isArray(samples)) return []
  if (!Number.isFinite(exactTokens) || exactTokens < 0) return samples.slice()
  if (samples.length === 0) return []
  const totalWeight = samples.reduce((sum, s) => sum + Math.max(0, s.weight ?? 0), 0)
  const each = exactTokens / samples.length
  if (!(totalWeight > 0)) {
    return samples.map(s => ({ ...s, tokens: each, quality: MetricQuality.CALIBRATED }))
  }
  const scale = exactTokens / totalWeight
  return samples.map(s => ({
    ...s,
    tokens: Math.max(0, s.weight ?? 0) * scale,
    quality: MetricQuality.CALIBRATED,
  }))
}

/**
 * Calibrate one attempt's samples against authoritative provider usage and
 * report how trustworthy the reasoning/output split is.
 *
 * `reasoningTokens`, when present, is already included in `outputTokens`
 * (verified local contract at `dsh-llm/lib/types/types.d.ts:136-150`), so the
 * non-reasoning output total is `outputTokens - reasoningTokens`. The two
 * counters are never added.
 *
 * @param {readonly object[]} samples
 * @param {{outputTokens?:number, reasoningTokens?:number}|null|undefined} usage
 * @returns {{
 *   samples: object[],
 *   phaseTokens: {reasoning:number|null, output:number|null},
 *   totalTokens: number|null,
 *   totalQuality: string,
 *   splitQuality: string,
 *   totalAnchored: boolean,
 *   note: string|null,
 * }}
 */
export function calibrateAttemptSamples(samples, usage) {
  const list = Array.isArray(samples) ? samples : []
  const outputTokens = usage?.outputTokens
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    return {
      // No authoritative anchor exists, so the per-delta allocation stays at the
      // raw shape weight and is labelled `estimated`. It is never presented as a
      // token count.
      samples: list.map(s => ({
        ...s,
        tokens: Math.max(0, s.weight ?? 0),
        quality: MetricQuality.ESTIMATED,
      })),
      phaseTokens: { reasoning: null, output: null },
      totalTokens: null,
      totalQuality: MetricQuality.UNAVAILABLE,
      splitQuality: MetricQuality.UNAVAILABLE,
      totalAnchored: false,
      note: 'no authoritative usage',
    }
  }

  const reasoningTokens = usage?.reasoningTokens
  const splitExact = Number.isFinite(reasoningTokens) && reasoningTokens >= 0

  if (splitExact) {
    const reasoningTotal = Math.max(0, reasoningTokens)
    const outputTotal = Math.max(0, outputTokens - reasoningTotal)
    const reasoningSamples = calibratePhase(list.filter(s => s.phase === 'reasoning'), reasoningTotal)
    const outputSamples = calibratePhase(list.filter(s => s.phase === 'output'), outputTotal)
    let ri = 0
    let oi = 0
    const merged = list.map(s => (s.phase === 'reasoning' ? reasoningSamples[ri++] : outputSamples[oi++]))
    const missing = []
    if (reasoningTotal > 0 && reasoningSamples.length === 0) missing.push('reasoning')
    if (outputTotal > 0 && outputSamples.length === 0) missing.push('output')
    return {
      samples: merged,
      phaseTokens: { reasoning: reasoningTotal, output: outputTotal },
      totalTokens: outputTokens,
      totalQuality: MetricQuality.EXACT,
      splitQuality: missing.length > 0 ? MetricQuality.UNAVAILABLE : MetricQuality.EXACT,
      totalAnchored: true,
      note: missing.length > 0
        ? `authoritative ${missing.join(' and ')} tokens reported but the stream carried no such deltas`
        : null,
    }
  }

  // Only the combined output total is authoritative. Rescale every sample by one
  // common factor so the whole-attempt integral matches exactly, and mark the
  // reasoning/output split estimated: the split was never measured, so claiming
  // it is exact would be a fabrication (docs/METRICS_SPEC.md §8.3).
  const phaseWeights = { reasoning: 0, output: 0 }
  for (const s of list) {
    if (s.phase === 'reasoning') phaseWeights.reasoning += Math.max(0, s.weight ?? 0)
    else if (s.phase === 'output') phaseWeights.output += Math.max(0, s.weight ?? 0)
  }
  const totalWeight = phaseWeights.reasoning + phaseWeights.output
  const scale = totalWeight > 0 ? outputTokens / totalWeight : 0
  const rescaled = list.map(s => ({
    ...s,
    tokens: totalWeight > 0
      ? Math.max(0, s.weight ?? 0) * scale
      : (list.length > 0 ? outputTokens / list.length : 0),
    quality: MetricQuality.CALIBRATED,
  }))
  return {
    samples: rescaled,
    phaseTokens: {
      reasoning: totalWeight > 0 ? phaseWeights.reasoning * scale : null,
      output: totalWeight > 0 ? phaseWeights.output * scale : null,
    },
    totalTokens: outputTokens,
    totalQuality: MetricQuality.EXACT,
    splitQuality: MetricQuality.ESTIMATED,
    totalAnchored: true,
    note: 'reasoningTokens absent: whole-attempt integral anchored, reasoning/output split estimated',
  }
}
