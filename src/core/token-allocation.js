import { MetricQuality } from './metric-quality.js'
import { classifyDelta, deltaText } from './delta-accounting.js'
import { TemporalAllocationMode, analyzePhaseEvidence } from './phase-evidence.js'

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
 *   - `totalAnchored === true` implies the sample integral equals the attempt's
 *     authoritative `outputTokens` exactly (relative error < 1e-9), because the
 *     scaling products sum algebraically to that total. This holds in **both**
 *     anchored modes and is the Phase 7C.2 invariant;
 *   - the per-phase exact split is used only when the provider counters and the
 *     observed stream phases agree (`analyzePhaseEvidence`). A phase the provider
 *     counted but the stream never showed cannot be placed in time, so the whole
 *     attempt falls back to one common scale — the phase's tokens stay inside the
 *     total instead of being dropped with it;
 *   - a phase with tokens but no shape weight distributes evenly rather than
 *     dividing by zero;
 *   - a contradiction is never repaired by inventing a sample, never by assigning
 *     zero tokens to a phase the stream really recorded, and never by silently
 *     clamping an impossible split into a plausible one.
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
 * Calibrate one attempt's samples against authoritative provider usage, and report
 * how much of that usage the stream's own evidence supports.
 *
 * `reasoningTokens`, when present, is already included in `outputTokens`
 * (verified local contract at `dsh-llm/lib/types/types.d.ts:136-150`), so the
 * non-reasoning output total is `outputTokens - reasoningTokens`. The two
 * counters are never added.
 *
 * ## The invariant this function now guarantees
 *
 *     totalAnchored === true  =>  sum(samples[].tokens) === outputTokens
 *
 * The previous revision could violate it. With `reasoningTokens > 0` and **no**
 * reasoning delta in the stream it calibrated the output phase against
 * `outputTokens - reasoningTokens` and the (empty) reasoning phase against
 * `reasoningTokens`, then published `totalAnchored: true`. The reasoning tokens
 * were silently dropped from the curve: the samples summed to
 * `outputTokens - reasoningTokens` while every consumer was told the attempt was
 * anchored. `totalAnchored` now means exactly what it says, because the
 * exact-split branch is entered only when the provider counters and the observed
 * phases agree (`analyzePhaseEvidence`).
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
 *   temporalAllocationMode: string,
 *   evidence: object,
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
      temporalAllocationMode: TemporalAllocationMode.UNANCHORED,
      evidence: analyzePhaseEvidence(list, null, undefined),
      note: 'no authoritative usage',
    }
  }

  const evidence = analyzePhaseEvidence(list, outputTokens, usage?.reasoningTokens)

  if (evidence.splitUsable) {
    /**
     * The provider total **and** its phase split can both be mapped onto observed
     * stream evidence, so each phase is calibrated against its own counter. This is
     * the only branch that may claim an exact per-phase temporal allocation.
     */
    const reasoningSamples = calibratePhase(
      list.filter(s => s.phase === 'reasoning'),
      evidence.reasoningTotal,
    )
    const outputSamples = calibratePhase(
      list.filter(s => s.phase === 'output'),
      evidence.outputTotal,
    )
    let ri = 0
    let oi = 0
    const merged = list.map(s => (s.phase === 'reasoning' ? reasoningSamples[ri++] : outputSamples[oi++]))
    return {
      samples: merged,
      phaseTokens: { reasoning: evidence.reasoningTotal, output: evidence.outputTotal },
      totalTokens: outputTokens,
      totalQuality: MetricQuality.EXACT,
      splitQuality: MetricQuality.EXACT,
      totalAnchored: true,
      temporalAllocationMode: TemporalAllocationMode.PHASE_ANCHORED,
      evidence,
      note: null,
    }
  }

  /**
   * Fallback: the provider total is authoritative, the phase split is not usable
   * as a temporal allocation. This covers both the absent counter and every
   * contradiction `analyzePhaseEvidence` reports.
   *
   * One common factor is applied across **every** observed generated sample, so
   * the whole-attempt integral is the authoritative total and the observed
   * temporal shape and phase labels are preserved. Per the Phase 7C.2 brief:
   * a missing phase is neither invented, nor discarded, nor allowed to zero a
   * phase the stream really recorded. What is *not* claimed is that the
   * phase-temporal allocation is exact — hence `total-anchored`.
   *
   * The provider's phase counters are still reported in `phaseTokens` when a split
   * exists: they are a provider summary fact (docs/METRICS_SPEC.md §8.3), separate
   * from the curve's temporal allocation, and the split quality says how far they
   * may be trusted.
   */
  const rescaled = calibrateTotally(list, outputTokens)
  /**
   * A contradicted split withholds the phase pair; an absent one does not. `splitAvailable`
   * is true in exactly the contradiction cases that reach this branch, so the two
   * conditions are stated separately rather than folded into one.
   */
  const splitWithheld = evidence.contradictions.length > 0 || evidence.splitAvailable
  return {
    samples: rescaled,
    /**
     * What may be published as the per-phase division of the total.
     *
     * A **contradicted** split is refused: the provider's counters are not republished as
     * the phase pair, because doing so was half of the 7C.2 defect — the pair read
     * `reasoning 74 / output 70` while the curve carried 70. The provider's own numbers stay
     * available as the summary fact they are, in `evidence.contradictions[]`, and the
     * anchored attribution of the observed samples is published instead.
     *
     * An **absent** split is a quality level, not a conflict, and keeps its long-standing
     * reading: the shape division of the anchored total
     * (`docs/METRICS_SPEC.md` §8.3, frozen in Phase 4).
     */
    phaseTokens: splitWithheld
      ? publishablePhasePair(evidence.reasoningTotal, evidence.outputTotal)
      : attributedPhaseTokens(rescaled),
    totalTokens: outputTokens,
    totalQuality: MetricQuality.EXACT,
    splitQuality: evidence.splitAvailable ? MetricQuality.UNAVAILABLE : MetricQuality.ESTIMATED,
    totalAnchored: true,
    temporalAllocationMode: TemporalAllocationMode.TOTAL_ANCHORED,
    evidence,
    note: evidence.notes.length > 0
      ? evidence.notes.join('; ')
      : 'reasoningTokens absent: whole-attempt integral anchored, reasoning/output split estimated',
  }
}

/**
 * A per-phase pair fit to publish, from a provider split that was contradicted.
 *
 * The counters are a provider summary fact and are retained as such, but only where each is a
 * real count. An impossible split carries `NaN` in one or both members (see
 * `analyzePhaseEvidence`), and a non-finite counter is published as `null` — "no evidence" —
 * rather than as a negative number or a clamped zero.
 */
function publishablePhasePair(reasoning, output) {
  return {
    reasoning: Number.isFinite(reasoning) ? reasoning : null,
    output: Number.isFinite(output) ? output : null,
  }
}

/**
 * Sum the rescaled samples per phase and report each phase as a count, or `null` when the
 * phase has no evidence at all. `null` and `0` are different facts and only a phase that
 * really produced nothing gets the latter, which the caller decides from the split counters.
 */
function attributedPhaseTokens(samples) {
  let reasoning = 0
  let output = 0
  for (const sample of samples) {
    const tokens = Math.max(0, sample.tokens ?? sample.weight ?? 0)
    if (sample.phase === 'reasoning') reasoning += tokens
    else if (sample.phase === 'output') output += tokens
  }
  return {
    reasoning: reasoning > 0 ? reasoning : null,
    output: output > 0 ? output : null,
  }
}

/**
 * Apply one common scale to every observed generated sample so their integral is
 * `exactTokens`.
 *
 * Shared by the absent-counter case and every contradictory-split case, because
 * the mathematics is identical and duplicating it is how the two paths drifted
 * apart before. When the samples carry no positive weight at all the total is
 * divided evenly rather than by zero.
 */
export function calibrateTotally(samples, exactTokens) {
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
