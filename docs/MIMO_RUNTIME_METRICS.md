# MiMo Ultra Runtime Metrics — Reverse-Engineering Report (Phase 9.1)

Target site: <https://aistudio.xiaomimimo.com/#/ultra/>
Target DSH: `0.1.7-rc.2`. Repository baseline: `080ff9a7631b3bb1f4e243460cce2688eab7909e` (v0.1.1).

This document is evidence, not code. It records what the MiMo Ultra web client actually does with
runtime metrics, how each fact was established, and how confident the evidence is. It does **not**
copy MiMo source; the formulas below are restatements of measured behaviour, corroborated against the
shipped bundles only where the black-box measurements left a gap.

Confidence vocabulary (as required by the phase brief):

| Label | Meaning |
|---|---|
| **CONFIRMED** | directly supplied by network/server, or stated unambiguously by code that was read |
| **MEASURED** | established repeatedly from runtime instrumentation |
| **INFERRED** | best-fitting model, not directly exposed |
| **UNKNOWN** | evidence insufficient |

---

## 1. Method and evidence layers

The brief fixed the order of evidence. It was followed.

1. **Black-box first.** An in-page probe (`window.__mimoProbe`) was installed into the live
   authenticated tab. It wrapped `window.fetch` (SSE bodies read through `ReadableStream.tee()`, so
   the application consumed an untouched branch) and ran a `MutationObserver` over `document.body`
   recording every metric-card text change with `performance.now()` timestamps. All timestamps below
   are on the page's own `performance.now()` clock unless stated otherwise.
2. **Network layer.** Every SSE frame was recorded as `{t, event, type, contentLength, usage fields}`.
   No conversation text was retained — only lengths, event names, field names and counters.
3. **Static corroboration.** Only after the display behaviour was measured, the shipped bundles were
   read for the specific identifiers the measurements had already exposed (`outputTps`,
   `thinkingTps`, `thinkingEndIdx`, `peakTps`, `samples`). The bundles are minified; the identifiers
   that mattered were not, and every formula below was first observed as behaviour.

**Authentication material was never read, recorded or reported.** No cookies, tokens, headers or
credentials appear in this document or in any file added by this phase.

### 1.1 Measurement runs

Five generations were driven through the real UI (typing into the composer through the native value
setter and submitting with the real send button). Prompts were ordinary technical requests; no
private conversation content is reproduced here.

| # | Shape of run | thinking tokens | output tokens | thinking dur | output dur | total dur | first response | thinking TPS | output TPS | samples |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | trivial ("say hello") | 30 | 4 | 0.031 s | 0.681 s | — | 4.42 s | — | — | — |
| 2 | small code answer | 14 | 163 | 0.031 s | 0.681 s | 9.905 s | 9.224 s | 0 | 63 | 6 |
| 3 | large single-file game | 19 630 | 14 653 | 50.39 s | 71.986 s | 174.492 s | 102.506 s | 387 | 680 | 200 |
| 4 | medium explanation | 34 | 747 | 0.252 s | 4.836 s | 7.284 s | 2.448 s | 0 | 137 | 48 |
| 5 | medium code answer | 1 315 | 1 955 | 3.597 s | 7.314 s | 8.236 s | 0.922 s | 327 | 492 | 71 |

Runs 1 and 2 were captured with the early probe revision and lack the frame-level fields added later;
they are retained because they bracket the short-generation behaviour (6-sample and 2-sample series).

---

## 2. Stream transport

**SSE over `fetch`, not WebSocket and not `EventSource`. CONFIRMED.**

- `POST /fastchat/open-apis/bot/chat` returns `content-type: text/event-stream` and is consumed by
  the application through `response.body.getReader()`. MEASURED (the response body was teed and read
  independently while the UI rendered normally).
- Event vocabulary observed across all runs: `dialogId`, `usage`, `message`, `finish`. MEASURED.
- `message` frames carry `{type: "text", content: <string>}`. **Every** content frame — reasoning
  text and answer text alike — is `type: "text"`; there is no separate reasoning event type. MEASURED.
- `usage` frames carry cumulative counters at the frame's top level:
  `{promptTokens, completionTokens, totalTokens, nativeUsage: {completion_tokens, prompt_tokens,
  total_tokens, prompt_tokens_details: {cached_tokens}, completion_tokens_details:
  {reasoning_tokens}}}`. MEASURED.
- Reasoning and answer text are separated **inside the content stream** by markers, not by event
  type. The client watches the accumulated content for a start marker and an end marker and stamps
  `thinkingStartAt` / `thinkingEndAt` from them. CONFIRMED (corroborated code path, consistent with
  the measured `thinkingDurationSec` values below).

### 2.1 Network event cadence

MEASURED on run 3 (the longest run, 913 frames over 172 s):

| Quantity | Value |
|---|---|
| `usage` frames | 457 |
| `message` frames | 454 |
| inter-`usage` interval, median | 149 ms |
| inter-`usage` interval, mean | 152.9 ms |
| p10 / p90 | 0 ms / 294.2 ms |
| min / max | 0 ms (bursts) / 1419.6 ms |

Frames arrive in **bursts**: several frames can share one millisecond, then a gap of several hundred
milliseconds follows. The server does not emit at a fixed cadence, and it does not stream
progressively at all for short answers — the "hello world" run delivered its entire answer in one
burst 4.3 s after the request.

---

## 3. The three cadences

The brief required these to be separated explicitly. They are genuinely three different numbers.

### 3.1 A — model/network chunk cadence

Not fixed. Median inter-frame interval 149 ms with bursts and multi-second silences (§2.1).
MEASURED.

### 3.2 B — metric sampling cadence: **100 ms**

The client runs one interval per active message:

- every **100 ms** it recomputes the live TPS and pushes `{tMs, tps, isThinking}` onto a raw series;
- `tMs` is milliseconds since the first content character of the message.

CONFIRMED by code, and independently MEASURED three times from the recorded series length:

| Run | streaming span after first char | raw samples expected at 100 ms | samples delivered |
|---|---|---|---|
| 2 | 0.681 s | 6.8 | 6 |
| 4 | 4.836 s | 48.4 | 48 |
| 5 | 7.314 s | 73.1 | 71 |

and from the phase boundary index (`thinkingEndIdx`), which is the last sample whose source tick was
still in the reasoning phase:

| Run | thinking duration | expected thinking ticks | `thinkingEndIdx + 1` |
|---|---|---|---|
| 4 | 0.252 s | 2.5 | 2 |
| 5 | 3.597 s | 36.0 | 35 |

The metric is therefore **sampled at 10 Hz**, independently of how fast frames arrive.

### 3.3 C — UI presentation cadence: **~100 ms**

MEASURED. The live readout's text changed at intervals of 90–110 ms (run 4 deltas, in ms, between
consecutive commits of the readout: 75, 94.3, 96.1, 109.2, 60.1, 95.9, 83.6, 113.1, 97.8, 92.6, 97.5).
That is the sampling tick surfacing through React; SSE events can additionally force a recompute, so
the presentation cadence is *at most* one tick old and never slower than ~100 ms in practice.

The two constants are distinct in the client's own architecture: the 100 ms interval drives **both**
the sample series and the state write, so sampling cadence and presentation cadence coincide there.
For DSH they do not have to (§7).

---

## 4. Token accounting

### 4.1 Reasoning tokens — CONFIRMED

Reasoning tokens are taken from the provider's native usage counter:

```
thinkingTokens = usage.nativeUsage.completion_tokens_details.reasoning_tokens
```

The client states its own provenance explicitly: the metrics payload it saves contains the literal
field `thinkingTokenSource: "native_usage_reasoning_tokens"`. This is the strongest form of evidence
in the whole investigation — the site declares the source rather than implying it.

`thinkingTokens` is read at the moment the thinking **end marker** is observed, and frozen then.

### 4.2 Output tokens — CONFIRMED

Live and final output tokens are a **difference of cumulative provider counters**, not a tokenizer:

```
outputTokens = completionTokens - outputBaselineCompletionTokens
```

`outputBaselineCompletionTokens` is anchored when output begins: on the first refresh after the
thinking phase completes, the baseline is set to the current `completionTokens`, and it is re-anchored
once more on the first refresh where the counter has grown, so the baseline lands on the value the
counter held when the first answer token appeared. MEASURED + corroborated.

No client-side tokenizer was observed anywhere in the metrics path. The displayed counts track the
provider counters exactly (run 3: 34 283 − 19 630 = 14 653, which is the number the card printed).

### 4.3 Generated-token semantics

```
generatedTokens (card) = completionTokens = reasoningTokens + outputTokens
```

The card's "Total Tokens" cell is `completionTokens`. MEASURED: run 3 printed 34 283 with
19 630 reasoning + 14 653 output; run 4 printed 781; run 5 printed 3 270. Reasoning is **inside**
the total, never added to it.

Tool-call tokens do not exist in this product surface (no tool calls were observed in any run); the
question is UNKNOWN for this client and is not claimed either way.

---

## 5. TPS formulas

All values are integers: every rate is `Math.round(...)` of a quotient. Durations are printed with
one decimal (`.toFixed(1)`), the first-response figure with two (`.toFixed(2)`).

### 5.1 Live reasoning TPS (thinking in progress) — CONFIRMED

```
thinkingTps = round( reasoningTokensSoFar / elapsedSinceFirstContentCharacter )
```

`elapsedSinceFirstContentCharacter` is the same clock that stamps the samples, and it starts at the
first content character of the message — which, when the model reasons, is the first character of the
reasoning block. This is a **cumulative phase average**, not a trailing window.

Behavioural signature, MEASURED (run 3): the live value climbed 211 → 279 → … → 390 over the
thinking phase and never reset; the individual samples carry ±10 noise because the numerator only
moves when a frame arrives while the denominator advances every tick.

### 5.2 Live output TPS — CONFIRMED

```
outputTps = round( outputTokens / elapsedSinceOutputStart )
```

with its own clock: `elapsedSinceOutputStart` restarts when the first answer token arrives. The
phase transition therefore **resets the rate clock** — the output rate is measured from a fresh phase
boundary, not from the request start. MEASURED (run 3: the series jumps from 390 to 1564 at the
phase boundary, then decays toward the steady answer rate).

A guard exists for the first second of the output phase: if the computed rate is not positive while
the last positive thinking rate is still fresh (≤ 1 s into the output phase), the thinking rate is
reused rather than displaying a spurious zero. CONFIRMED (code path), consistent with the observed
1564 burst.

### 5.3 Completed reasoning TPS — CONFIRMED

```
thinkingTps(final) = round( (thinkingTokens - baseline) / thinkingDurationSec )
```

where `thinkingDurationSec` is the wall-clock interval between the two reasoning markers
(start marker seen → end marker seen), and `baseline` is the small reasoning count already present
when the thinking baseline was anchored. The guard is `thinkingDurationSec >= 0.2`, otherwise the
final value is `0`.

The baseline is not zero and not the full count; it is roughly **0.7 % of the thinking tokens** in
run 3 (≈130 of 19 630) and ≈11 % in run 5 (≈139 of 1 315). Reproducing the value exactly therefore
requires the same anchoring rule, not just the ratio.

### 5.4 Completed output TPS — CONFIRMED

```
outputTps(final) = round( outputTokens / (settlementTime - outputStartTime) )
```

`settlementTime` is the moment the client finalises the message, i.e. **after** the stream's `finish`
frame, not at the last frame. This is why the final printed value is systematically below the last
live reading (run 3: last live 758 → printed 680; the extra elapsed time is charged to the
denominator).

### 5.5 Durations — CONFIRMED (identity holds on every run)

```
firstResponseTimeSec = firstContentCharTime - requestStartTime
outputDurationSec    = settlementTime - firstContentCharTime
totalDurationSec     = firstResponseTimeSec + outputDurationSec
                     = settlementTime - requestStartTime
```

Verified arithmetically on all four runs that reported the pair: 9.905 = 9.224 + 0.681;
174.492 = 102.506 + 71.986; 7.284 = 2.448 + 4.836; 8.236 = 0.922 + 7.314.

**Naming warning for anyone reading MiMo's payload:** `outputDurationSec` is *not* the answer phase.
It is the whole post-first-character streaming span, reasoning included. The card's answer-phase
figure is derived at render time as `outputDurationSec − thinkingDurationSec`.

---

## 6. TTFT / "first response"

**Start:** the client's own request-start stamp, taken in the same tick that opens the request —
measured to be **15–30 ms before the HTTP request is actually issued** (three runs: 16.5 ms,
28.6 ms, 15.6 ms; run 1 is an outlier at ~140 ms, likely request assembly).
**End:** the first **content character** received — which for a reasoning model is the first
reasoning character, not the first answer character.

```
firstResponseTimeSec = firstContentCharTime - requestStartTime
```

MEASURED against an independent frame clock (first `message` frame − fetch issuance):

| Run | reported | measured (first content frame − fetch) | implied pre-fetch stamp |
|---|---|---|---|
| 2 | 9.224 s | 9.208 s | 16.5 ms |
| 3 | 102.506 s | 102.477 s | 28.6 ms |
| 5 | 0.922 s | 0.906 s | 15.6 ms |

**Special TTFT question answered:** the displayed first-response figure is anchored to the first
**reasoning** content when the model reasons. MEASURED — in run 3 the first content frame is a
reasoning frame and the reported 102.506 s matches that frame, not the first answer frame, which
arrived 50 s later.

Timer resolution: the underlying value is computed from millisecond timestamps; the display rounds to
two decimals. No 10 ms quantisation was observed in the stored values. MEASURED.

---

## 7. The sample series

The raw 100 ms series is post-processed before it is stored and drawn:

- **Downsampling.** If the series has more than **200** points it is resampled to exactly 200 points
  evenly spaced in time across the full span, each point taken as the nearest raw sample
  (nearest-neighbour, no interpolation). MEASURED: run 3 produced ~720 raw ticks and published
  exactly 200 samples; runs 2, 4 and 5 stayed below the cap and published 6, 48 and 71.
- **Cap.** Every published value is clamped to **1564**. MEASURED: run 3's `peakTps` is exactly 1564
  while the observed live readout reached 1521 before the clamp region. The constant behaves as a
  display ceiling for absurd rates.
- **`thinkingEndIdx`** is the index of the last published sample whose source tick was still in the
  reasoning phase (`-1` when the run never entered it). MEASURED: run 3 → 143, run 5 → 34, run 4 → 1,
  run 2 → −1.
- **`peakTps`** is the maximum of the **published, clamped** series, not of the raw series.
  MEASURED: run 3 peak = 1564 = the clamp.

---

## 8. Warm-up, gating and rounding

### 8.1 Warm-up — MEASURED

The readout does **not** appear immediately and does not show `0` or `—`. While waiting, the card
shows a plain elapsed-time counter. The rate readout appears only when the current phase's value is
plausible:

```
visible  ⟺  200 ≤ tps ≤ 1564  AND  phaseSseCount ≥ 3
```

MEASURED: run 4's output rate never reached 200, and its card never displayed a TPS cell at all
(it printed only Total Tokens / Total duration / First Response). Run 2 likewise (`outputTps` 63).
Run 3's readout first appeared ~0.5 s into the thinking phase, at 262 tokens/s — i.e. the first tick
whose value cleared 200.

There is no partial-window rule to reproduce: the estimator is a cumulative average, so the first
visible value is already a full average over the observed span.

### 8.2 Rounding — CONFIRMED

`Math.round` to integer for every rate. Durations `.toFixed(1)`; first response `.toFixed(2)`.
The published samples are the rounded values, so a series of repeated integers (…789, 789, 789…)
is a genuine steady state, not a stalled display.

### 8.3 Completed-card cell rules — CONFIRMED

- reasoning cell requires: thinking completed, 200 ≤ thinkingTps ≤ 1564, ≥ 3 reasoning updates,
  duration > 0, tokens > 0;
- output cell requires: 200 ≤ outputTps ≤ 1564, ≥ 3 output updates, duration > 0, tokens > 0;
- answer-phase footer = `(outputDurationSec − thinkingDurationSec, completionTokens − thinkingTokens)`;
- reasoning footer = `(thinkingDurationSec, thinkingTokens)`;
- total cell = `completionTokens` with footer `outputDurationSec`;
- first response cell = `firstResponseTimeSec` (2 dp) with a "Completed" state label.

This is why the same product prints a TPS card for one message and a tokens-only card for the next:
the difference is the plausibility gate, not the presence of data.

---

## 9. Stall behaviour — MEASURED (run 3)

Run 3 contained a genuine multi-second silence mid-stream. Observed behaviour:

- the numerator freezes (no new frames → `completionTokens` unchanged);
- the denominator advances every 100 ms tick;
- the readout therefore **decays continuously** toward zero, hyperbolically, and does not jump to
  zero after any window;
- the readout never disappears during an active phase, and it does not fall back to a spinner once
  it has appeared.

This is the signature of a **cumulative phase average**. It is *not* a trailing window (which would
reach exactly zero one window after the last frame and stay there), and it is not an
event-triggered value (which would freeze at the last rate).

Because a phase average never forgets, a stall costs the phase its rate permanently — the value
recovers only as new tokens dilute the frozen stretch.

---

## 10. Settlement behaviour — MEASURED + CONFIRMED

On `finish` the client stops the 100 ms tick and computes the final numbers **once**, at settlement
time — not by reusing the last live value:

| Value | Before (last live) | After (settled) |
|---|---|---|
| run 3 output TPS | 758 | 680 |
| run 3 thinking TPS | 390 | 387 |
| run 3 answer tokens printed | 14 653 | 14 653 (unchanged) |

So: reasoning TPS changes once on settlement (recomputed against the marker-to-marker duration);
output TPS changes once (recomputed against the settlement timestamp); token counts do not change.

**Live and completed formulas are different formulas** (§5.1 vs §5.3, §5.2 vs §5.4). Neither is a
rounding of the other.

---

## 11. Required answer table

```
MiMo stream transport:            SSE over fetch (text/event-stream); events dialogId / usage /
                                  message / finish. No WebSocket, no EventSource.
                                  CONFIRMED
MiMo network event cadence:       not fixed; bursts + silences; median inter-usage-frame 149 ms,
                                  p90 294 ms, max 1.4 s.                        MEASURED
MiMo UI refresh cadence:          ~100 ms (10 Hz), matching the sampling tick.    MEASURED
MiMo TPS update cadence:          100 ms metric sampling; 200-point stored series. CONFIRMED

Reasoning token source:           native usage reasoning_tokens (self-declared by the client).
                                  CONFIRMED
Output token source:              completionTokens − output baseline (provider counters).
                                  CONFIRMED
Generated-token source:           completionTokens.                              CONFIRMED

Live reasoning TPS formula:       round(reasoningTokensSoFar / elapsedSinceFirstContentChar)
                                  — cumulative phase average.                    CONFIRMED
Live output TPS formula:          round(outputTokens / elapsedSinceOutputStart)
                                  — cumulative phase average on a fresh clock.   CONFIRMED

Completed reasoning TPS formula:  round((thinkingTokens − baseline) / thinkingDurationSec),
                                  thinkingDurationSec = marker-to-marker wall clock.
                                  CONFIRMED
Completed output TPS formula:     round(outputTokens / (settlementTime − outputStartTime)).
                                  CONFIRMED

Window size:                      none — no trailing window anywhere in the rate path; the
                                  denominator is phase elapsed time.             CONFIRMED
Smoothing:                        none beyond Math.round; the series is raw samples. CONFIRMED
Stall behaviour:                  continuous hyperbolic decay (frozen numerator / advancing
                                  denominator); never zero-by-window, never hidden. MEASURED
Phase reset behaviour:            output phase starts a fresh clock at the first answer token;
                                  the reasoning clock is never reused for output.  MEASURED

TTFT start:                       client request-start stamp, ~15–30 ms before the HTTP request.
                                  MEASURED
TTFT end:                         first content character (reasoning counts).      MEASURED

Settlement behaviour:             tick stops; rates recomputed once at settlement time against
                                  settlement-anchored denominators; token counts unchanged.
                                  MEASURED + CONFIRMED
```

---

## 12. What DSH cannot reproduce, and why

| MiMo behaviour | DSH evidence | Verdict |
|---|---|---|
| Authoritative per-frame token counters | DSH streams text deltas; `TokenUsage` arrives at attempt settlement | The *counters* are available at settlement, not per frame. Live rates cannot be exact. |
| Native `reasoning_tokens` per frame | DSH `TokenUsage.reasoningTokens` exists but is attempt-scoped | The final split is exact; the live split is a shape estimate. |
| Reasoning/answer separation by in-stream markers | DSH separates by `reasoning-delta` vs `text-delta` chunk type | **DSH is stronger here** — phase identity is explicit and needs no marker parsing. |
| Request-start stamp a few ms before fetch | DSH has durable `turn/start` and attempt boundaries | Equivalent boundary exists; DSH's is authoritative rather than client-local. |
| Settlement-time recomputation | DSH has durable `assistant/message` / `turn/end` | Equivalent. |

---

## 13. Conflict with the frozen DSH curve semantics (implementation gate)

The identified MiMo live estimator is a **cumulative phase average**. The DSH plugin's live pill is a
**trailing one-second total-throughput window**, and `docs/METRICS_SPEC.md` §8.2 freezes the property
that *a completed curve vertex and a live pill reading at the same instant are the same measurement*
— the same one-second window, the same stall locations, the same phase-transition locations. That
property is asserted by `test/curve-total-rolling.test.js`.

Aligning the live pill with MiMo therefore requires either

1. changing the completed curve's statistic to match a phase-cumulative live pill, or
2. accepting that the live pill and the curve no longer measure the same thing.

Both are changes to frozen curve semantics. Phase 9.1's brief (§42) instructs:

> If a required algorithm conflicts with existing curve semantics: STOP and report before changing
> the curve.

This report is that STOP. **No production metric change was made in this phase.** The evidence above
is committed so a later phase can decide between (1), (2) and a third option — keeping DSH's trailing
window and documenting it as a deliberate, better-evidenced divergence:

| Aspect | MiMo | DSH (unchanged) |
|---|---|---|
| live estimator | cumulative phase average, phase-local clocks | trailing 1000 ms total window, attempt-local |
| stall | hyperbolic decay, never zero | decays to zero one window after the last delta |
| phase transition | rate clock resets | window continues across the transition |
| sampling | 100 ms explicit tick | event-driven; presentation bounded at 50 ms |
| presentation | ~100 ms | 50 ms (finer) |
| completed rate | tokens / wall-clock phase span | tokens / attributed inter-delta generation time |
| plausibility gate | hides rates outside [200, 1564] | always shows with `≈` |

The DSH column is not obviously worse on any row: it is finer in presentation, it shows more
information in the low-rate regime, and its completed rates are anchored to measured active
generation time rather than to wall clock. That is the honest basis for the recommendation in the
final report.
