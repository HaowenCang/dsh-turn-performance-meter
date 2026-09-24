# UI Specification

## 1. Visual references

Use the supplied assets as visual references, not as DOM/source code dependencies:

- `assets/reference-live-ttft.png` — pending/first-response timer;
- `assets/reference-live-streaming.png` — compact streaming TPS pill;
- `assets/reference-completed-summary.png` — completed default four-column layout;
- `assets/reference-hover-curve.png` — completed hover curve layout.

The target is stylistic equivalence, not pixel copying of another site's proprietary theme classes. Rebuild the component with DSH theme primitives/tokens and plugin-scoped styles.

## 2. Placement

Target slot: `conversation.composer.dock`.

The component must share the composer width constraint and should not use a floating overlay. It must not inspect another plugin's DOM to determine position.

During development, keep a distinct slot id `turn-performance-meter`. Do not overwrite the native `stats` entry until local runtime inspection establishes an explicit, stable reason to do so. If both native and custom statistics are visually redundant, prefer an opt-in configuration or documented replacement strategy rather than brittle DOM hiding.

## 3. Live mode — no curve

The live component is driven by an explicit eight-state UI machine
(`src/client/live/live-state.js`): `inactive` · `pending-first-token` ·
`streaming-reasoning` · `streaming-output` · `tool-running` · `waiting-model` ·
`transition` · `settled`. Every rendering decision comes from that machine plus
the `LiveMeter` snapshot; the component never infers state from missing fields.
Verified live in the running DSH client (Phase 3), with the presentation
throttled to a single 200 ms ticker.

### 3.1 Pending / TTFT

From `turn/start` until the first non-empty generated delta, render a centered compact pill similar to the reference:

```text
2.80 s   首响应计时
```

This number is a running TTFT counter (a stopwatch, not the final TTFT). Once the first model-producing delta arrives,
the turn TTFT freezes **once**; no later LLM call ever returns to this stage — later waits use §3.5. No TPS, no `≈`,
no curve here.

### 3.2 Streaming

Render a compact pill:

```text
思考  ≈345 tokens/s   |   12.8 s
输出  ≈676 tokens/s   |   17.3 s
```

- label = current phase of the active attempt (`思考` reasoning / `输出` output; tool-call arguments are output);
- large/accent number = trailing 1-second current TPS for the active model attempt;
- the approximate marker `≈` is **mandatory** — live TPS quality is `estimated` unconditionally;
- right number = turn wall elapsed time from `turn/start` to now;
- right-side numbers use tabular digits; `tokens/s` renders at a smaller unit size.

No chart appears during live streaming.

### 3.3 Tool execution

When at least one tool is running, clear/freeze the live TPS: never a stale rate and never a forced `0 tokens/s`
(tool execution is not model decode). The pill becomes the tool timer:

```text
pwsh · 2.31 s  |  17.9 s
pwsh +1 · 0.42 s | 7.0 s     (two or more concurrent/sequential calls in one episode)
```

The left timer is the current continuous tool-activity episode (wall clock — see METRICS_SPEC §5 "Live tool timer");
the right remains total turn elapsed. Single-tool labels truncate with an ellipsis when long; the count suffix keeps
single vs multiple distinguishable in every locale.

### 3.4 Transition

A brief neutral gap — attempt settlement before `tool/call`, `tool/result` before the next `step/start`, retry
backoff, or any machine/snapshot disagreement — renders `处理中… | <elapsed>` with **no TPS field at all**. A few
dozen milliseconds of ambiguity never produce a metric.

### 3.5 Waiting for model

After the turn TTFT has frozen, a new step/attempt started (or is imminent) but no model-producing delta has arrived:

```text
等待模型 · 0.86 s   |   18.7 s
```

This wait is not model generation time: it never enters the TPS denominator and never reopens the first-token stage.

### 3.6 Settled

On the matching `turn/end` the live meter exits immediately (`settled` → hidden). The completed card is a later
phase; no provisional summary is drawn here.

## 3A. Presentation throttling

Event ingestion is per-delta; rendering is a single ~200 ms presentation ticker per mounted meter (100–250 ms
acceptable). The projected view is *state*: parent re-renders reuse the stored view, so the ticker — not the chat's
update cadence — is the only writer of visible numbers. Ticks are destroyed on hide, unmount and HMR; a hidden meter
uses one coalesced zero-delay render per event burst. Deltas are never dropped to save renders.

## 4. Completed default view

Keep four principal columns with thin separators. Proposed content:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Reasoning TPS │ Output TPS │ Generated Tokens │ TTFT               │
│ 345 token/s   │ 676 token/s│ 54,770           │ 1.44 s             │
│ 108.2s·37,498 │ 25.4s·17,272│ elapsed 133.6s   │ tools 4 · 12.8s   │
└────────────────────────────────────────────────────────────────────┘
```

Status (`completed`, `interrupted`, `errored`) can share the fourth-column secondary line if tool details move to a small detail affordance. Preserve four main columns; do not add a fifth permanent tool column.

`Generated Tokens` is preferred over `Total Tokens` when the number means provider output only. If product copy later uses `Total Tokens`, it must clearly mean generated/output total rather than prompt+output billing total.

## 5. Completed hover/focus curve view

Mouse hover **and keyboard focus-within** switch the card's internal layout to the curve view. This is not a tooltip and not a popover.

Recommended composition follows the reference:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Reasoning ■  Output ■     Peak 730 token/s │ Generated │ TTFT      │
│                                               13,859      3.14 s    │
│   ───── reasoning curve ────╮                elapsed      tools...  │
│                             ╰━━ output curve                        │
└────────────────────────────────────────────────────────────────────┘
```

The chart occupies roughly 50–60% of width; Generated Tokens and TTFT remain visible on the right. Use SVG `polyline`/`path` with bounded point count. Do not use canvas unless measurements prove SVG inadequate.

The transition may use ~200–300 ms opacity/crossfade. Respect `prefers-reduced-motion` and disable/reduce non-essential animation.

## 6. Curve behavior

- mandatory in completed hover/focus mode;
- two series: reasoning and output;
- reasoning uses a subdued neutral line; output uses one accent color;
- tool execution consumes zero x-axis width;
- next model invocation starts immediately where previous attempt's chart segment ends;
- optional attempt/tool boundary markers are disabled by default;
- one horizontal guide/scale label is sufficient; avoid a dense chart grid;
- peak label is computed from rendered rolling-window series;
- preserve intra-model stream stalls because those are relevant to throughput stability.

## 7. Responsive behavior

The live pill uses `width: 100%` / `max-width: content` inside a centered flex root — no fixed rem widths — and its
inline-flex wrap allows the secondary value to drop to a second line before anything overflows. At narrow composer
widths:

- preserve readable primary values before secondary text;
- allow secondary lines to truncate with title/accessible description if necessary;
- reduce chart right-side labels before collapsing main metrics;
- never cause horizontal page overflow;
- curve view may lower sample density but must not omit an entire series silently.

## 8. Accessibility

- completed card must expose curve view on keyboard focus, not hover only;
- numbers and labels require sufficient contrast in both host themes;
- color is not the sole distinction between reasoning/output: legend text remains present;
- card status should be available to assistive technology;
- rapid live numerical updates should not be an aggressive `aria-live` stream; announce state transitions rather than every 100–250 ms tick.
  The implemented live meter ships **no live region at all**: the root carries a per-state `aria-label`
  (`<state label> · <elapsed>`), the state's text label (思考/输出/pwsh/等待模型/处理中…) is real DOM text, and the
  high-frequency digits are ordinary text — so a screen reader is never read a new TPS five times a second;
- `prefers-reduced-motion` disables the pill's only transition (verified in CSS).

## 9. Localization

Visible production strings must go through the DSH Client locale service or the locally verified equivalent. Required baseline locales: English and Simplified Chinese — implemented as the `turnPerformanceMeter` namespace (`ctx.locale.register(ns, {en, zh})` + `ctx.locale.bind(ns)`, with an in-module `en` fallback if the service is absent). Tool names, `tokens/s` and the `+N` count suffix are deliberately locale-independent. The debug scaffold string is temporary and must not survive production release — removed in Phase 3 together with the localStorage placeholder gate.
