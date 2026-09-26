# UI Specification

## 1. Visual references

Use the supplied assets as visual references, not as DOM/source code dependencies:

- `assets/reference-live-ttft.png` — pending/first-response timer;
- `assets/reference-live-streaming.png` — compact streaming TPS pill;
- `assets/reference-completed-summary.png` — completed default four-column layout;
- `assets/reference-hover-curve.png` — completed hover curve layout.

The target is stylistic equivalence, not pixel copying of another site's proprietary theme classes. Rebuild the component with DSH theme primitives/tokens and plugin-scoped styles.

## 2. Placement

Target slot: `conversation.input.dock` — DSH's `kind: 'list'`, `scope: 'session'` seat documented as
"Full-width entries above the composer card" (owner `InputZone`, owner props `{ session, input }`, standard props
including `sessionId`).

Phase 3 used `conversation.composer.dock` ("Ambient entries below the composer card"), which put the meter
between the composer and the native statistics it competed with. Phase 5B moved it; the composer dock is no
longer registered at all.

`order: -10` places the meter **first** in that seat — telemetry, task state, composer — because `order` is ascending
and the seat's shipped occupants are `todo` 0, `goal` 10 and `queue` 20. The value is finite on purpose: no slot
contract defines a top pin, so the claim stays "first among all currently shipped occupants".

The component must share the composer card's width constraint
(`max-width: var(--dsh-composer-card-max-width)`) and must not use a floating overlay. It must not inspect
another plugin's DOM to determine position.

Keep a distinct slot id `turn-performance-meter`. Do not overwrite the native `stats` entry: it stays in
`conversation.composer.dock`, at its own id, untouched.

## 3. Live mode — no curve

The live component is driven by an explicit eight-state UI machine
(`src/client/live/live-state.js`): `inactive` · `pending-first-token` ·
`streaming-reasoning` · `streaming-output` · `tool-running` · `waiting-model` ·
`transition` · `settled`. Every rendering decision comes from that machine plus
the `LiveMeter` snapshot; the component never infers state from missing fields.
Verified live in the running DSH client (Phase 3), with the presentation
throttled to a single 50 ms ticker (Phase 5A; the constant lives in
`src/client/live/cadence.js`).

**Adopted turn boundary (`recovered`).** When the page attaches mid-turn — a reload, or a reconnect that produces a `replace` window — the open turn's
`turn/start` row is normally outside the published tail. The boundary is then *derived* from the transient rows' own `turn` field and marked
`recovered`; the turn opens directly in `waiting-model` with the TTFT stopwatch frozen **as unknown**. It never enters `pending-first-token`, because
that stage's counter would be measured from the reload. For such a turn the pill omits the turn-elapsed run (§3.2–§3.5 show it as the trailing
`n.n s`) instead of printing `0 s`; the tool-stage timer, TPS and tool labels are unaffected, since those are measured from deltas and events the
page did observe.

The omission is not permanent. If the durable `turn/start` later enters the client's evidence, the turn start is upgraded to the observed instant and
the elapsed run reappears with the recovered value on the next presentation tick; the TTFT stopwatch is not restarted either way, and the live pane
never states a TTFT of its own for an adopted turn. The *completed* card is a separate rendering path: it reports the turn's TTFT when the durable
`turn/start` was part of the evidence the card was built from, and renders an em dash when it was not (see `METRICS_SPEC.md` §4).

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

On the matching `turn/end` the live meter hands the slot to the completed card **in the same state advance**: the next
projection is the card, never a blank frame. The two views are mutually exclusive by construction — one projection
function decides which of them exists — so a clock tick, a parent re-render or a late event can never show both or
neither.

## 3A. Presentation throttling

Event ingestion is per-delta; rendering is a single presentation ticker per mounted meter at
`DEFAULT_PRESENTATION_REFRESH_MS` = 50 ms (Phase 5A; 200 / 50 / 10 ms were measured in a browser and 50 ms was
selected — see `IMPLEMENTATION_LOG.md`). The projected view is *state*: parent re-renders reuse the stored view, so
the ticker — not the chat's update cadence — is the only writer of visible numbers. Each tick produces **exactly one**
state update: the projection key includes the presentation instant, so the tick's view is always a new object and a
second "force render" dispatch would be pure duplication. Ticks are destroyed on hide, unmount and HMR; a hidden meter
uses one coalesced zero-delay render per event burst. Deltas are never dropped to save renders.

The ticker is a **live-view** resource. A completed card is static, so the ticker is stopped the moment the card
appears and is never restarted for it: the card is projected once per incoming event and the projection is memoized by
turn, so an unchanged settled turn returns the identical view object and React renders nothing. A settled session
therefore holds no interval, no leading timer and no rolling value.

## 4. Completed default view

Four principal columns with thin separators; the same four in the same order in every state, including `interrupted`
and `errored`:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Reasoning TPS │ Output TPS │ Generated Tokens │ TTFT               │
│ 345 token/s   │ 676 token/s│ 54,770           │ 1.44 s             │
│ 108.2s·37,498 │ 25.4s·17,272│ elapsed 133.6s  │ completed          │
├────────────────────────────────────────────────────────────────────┤
│ tools 4 · 12.8s · attempts 4 · completed                           │
└────────────────────────────────────────────────────────────────────┘
```

Implemented in Phase 4 and frozen here:

- the four columns are built by `src/client/ui-model.js::completedViewModel`, which is the **only** seam between the
  settled snapshot and the card. The React layer renders fields; it performs no arithmetic, no quality inference and
  no `≈` decision;
- `Generated Tokens` is the provider output total for the turn (reasoning included, never `input + output`, never
  `outputTokens + reasoningTokens`). The label is not `Total Tokens`;
- each phase cell's secondary line is `<duration> · <tokens>`, and both halves of that line carry the *same*
  approximate decision, because they are one derivation chain. The rate above the line keeps its own quality: a rate
  can be unmeasurable while its numerator is an exact provider counter;
- an absent value renders `—` with no unit; a `0 tokens/s` is never substituted for an unknown rate, and a measured
  zero is never hidden;
- the footer carries the tool summary using **`toolWallMs`** (the union of tool intervals, so parallel calls are not
  double counted) and the attempt count. A turn with no tool call omits the tool item entirely rather than printing
  `0 tools`. `toolWorkMs` stays in the view model for later detail surfaces;
- the status is text: `completed` · `interrupted` · `errored` · `token limit reached` (a `max-tokens` settlement is a
  completion with a ceiling, and says so). Failure states change the status text and its tone only — they never
  recolour the metrics, because the card reports throughput, not an error;
- the card is `role="group"` with a per-turn accessible name and per-cell accessible names built from label, value,
  unit and secondary line. It has **no `aria-live` region**: a settled turn is not an announcement;
- no chart in the summary layer, and no interactive element *in that layer*. `view.curve` is read by
  `curve-view-model.js`, never by the summary render path;
- Phase 5F made the **card** interactive: when the turn carries a curve the card is `tabindex="0"`, opens the curve on
  hover or focus, and closes it on leave, blur or turn change. A turn with no curve yields an inert, unfocusable card,
  because a focus stop that reveals nothing is worse than none. All of that is `src/client/completed/view-mode.js`.

The card is a static projection of the settled record. It is never recomputed from raw events, and it does not rebuild
itself on a timer.

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

The chart occupies the card's **left half** — the curve panel spans the first two of the four grid tracks, so
Generated Tokens and TTFT keep their exact positions, labels, values and dividers across the switch. The plot is a
hand-built SVG with **one `path` element per drawable run** in a fixed `0 0 100 48` viewBox with
`preserveAspectRatio="none"` and a non-scaling stroke; the point count is bounded by `DEFAULT_MAX_POINTS`. No charting
dependency and no canvas.

Implemented in Phase 5:

- the legend lists both phases in a fixed order with a text label *and* a swatch, so colour is never the only channel;
  a phase with no drawable evidence keeps its legend entry and is marked `data-absent`;
- the peak readout sits at the top right of the panel and always carries `≈`;
- the axis ceiling is a 1/2/2.5/5 x 10^k round-up of the **full-series** peak, labelled at the plot's right edge;
- each series is drawn only over its own evidence episodes, so a finished phase is not drawn as a flat zero line;
- the peak marker is an HTML element positioned in percentages, not an SVG `circle`, because a circle inside a
  non-uniformly stretched viewBox would render as an ellipse.

Corrected in Phase 6, with no visual redesign:

- **one path per run, never one path per series.** A phase may be present in more than one episode, and each episode's
  path element carries `data-series`, `data-run` and `data-attempt`. Two runs are two elements rather than one element
  with two subpaths, because the separation is the statement; the break itself is the whole signal, so no vertical
  attempt-boundary marker is added.
- **`curve.quality` is the temporal-shape axis** (`docs/METRICS_SPEC.md` §8.4). The peak's `≈` is unaffected: a curve
  vertex is a shape weight, so the marker is approximate at every quality level.

The transition is a 220 ms opacity crossfade on two stacked grid layers. `prefers-reduced-motion` removes the fade
without removing the switch. Because the layers are stacked in one grid cell, the card's height is the taller of the
two views at every width and host font size — measured identical in both views at 1440 px (149 px) and at 520 px
(240 px).

## 6. Curve behavior

- mandatory in completed hover/focus mode;
- two series: reasoning and output;
- reasoning uses a subdued neutral line; output uses one accent color;
- tool execution consumes zero x-axis width;
- next model invocation starts immediately where previous attempt's chart segment ends;
- **attempt boundaries break the path rather than joining it.** An attempt's one-window decay is clamped at the
  coordinate the next attempt owns, and the two attempts are separate runs; a single line across the boundary would
  interpolate between two calls' measurements. No marker is drawn — the break is the whole signal, and `attemptId`
  stays on every run for diagnostics;
- optional attempt/tool boundary markers are disabled by default;
- one horizontal guide/scale label is sufficient; avoid a dense chart grid;
- peak label is computed from the **full** per-attempt rolling series, before downsampling, and is rendered with `≈`;
- preserve intra-model stream stalls because those are relevant to throughput stability;
- a phase is drawn only over the intervals where it has evidence (`curve.phaseRuns[...]`, one entry per episode);
  outside those intervals the series reads zero because the phase is absent, not because its throughput collapsed, so
  no zero plateau is drawn and the legend marks the series absent instead. A phase present in two episodes yields two
  paths with a visible gap rather than one interval spanning the stretch between them.

## 7. Responsive behavior

The live pill uses `width: 100%` / `max-width: content` inside a centered flex root — no fixed rem widths — and its
inline-flex wrap allows the secondary value to drop to a second line before anything overflows.

The completed card is a CSS grid: `repeat(4, minmax(0, 1fr))` at normal composer widths, collapsing to
`repeat(2, minmax(0, 1fr))` below a single `34rem` breakpoint, where the separators are re-drawn as a top border on the
second row and the outer padding is trimmed. `minmax(0, 1fr)` is what lets a cell shrink below its content width
instead of forcing the row wider, so the card cannot overflow horizontally at any width and no column is ever crushed
to unreadable. The breakpoint is expressed against the card's own container width, not against a browser width, and no
fixed pixel width exists anywhere in the card. The curve panel spans two tracks at every width, so it goes full width
when the grid collapses. At narrow composer widths:

- preserve readable primary values before secondary text;
- allow secondary lines to truncate with an accessible description if necessary (they already carry the full text in
  the cell's `aria-label`);
- reduce chart right-side labels before collapsing main metrics;
- never cause horizontal page overflow;
- curve view may lower sample density but must not omit an entire series silently.

## 8. Accessibility

- completed card must expose curve view on keyboard focus, not hover only;
- numbers and labels require sufficient contrast in both host themes. The output accent is the plugin's one
  self-defined colour: the reference's `#fb8147` scores 2.31:1 on the reference card surface, so the shipped value
  keeps its hue and darkens to `#d9600f` light / `#ff9a5c` dark;
- color is not the sole distinction between reasoning/output: legend text remains present;
- card status should be available to assistive technology;
- rapid live numerical updates should not be an aggressive `aria-live` stream; announce state transitions rather than every 50 ms tick.
  The implemented live meter ships **no live region at all**: the root carries a per-state `aria-label`
  (`<state label> · <elapsed>`), the state's text label (思考/输出/pwsh/等待模型/处理中…) is real DOM text, and the
  high-frequency digits are ordinary text — so a screen reader is never read a new TPS twenty times a second;
- `prefers-reduced-motion` cancels every transition and animation inside the plugin root (verified in CSS).

Phase 4 fixed the completed card's accessibility contract:

- the root is `role="group"` with the accessible name `本轮性能统计 · 第 <turn> · <status>` (`Turn performance summary ·
  turn <n> · <status>`), and it carries `data-kind`, `data-status`, `data-quality` and the turn/session as data
  attributes for diagnostics;
- each of the four cells is its own `role="group"` whose accessible name is `label, value unit, secondary line`
  (for example `Reasoning TPS, ≈345 tokens/s, 108.2s · ≈37,498`), so the numbers are never announced unlabelled. The
  visible text remains exactly the reference layout; the fuller phrase lives in the accessible name rather than in a
  `title` tooltip;
- the turn status is real text in both the status cell and the footer, so it does not depend on colour. Colour carries
  a tone hint only (`data-tone="warn"` / `"error"` on the secondary line), and never repaints the card;
- the card contains no interactive element and no `tabindex` **in its summary layer**; Phase 5F added the focus path
  as a `tabindex="0"` card with a `:focus-visible` ring, present only when the turn carries a curve;
- the only animation in the card is the 220 ms opacity cross-fade between the two stacked views, which
  `prefers-reduced-motion` cancels;
- the hidden view stays in the DOM for a stable height but is `aria-hidden="true"` with `pointer-events: none`, so
  assistive technology is never handed two copies of the turn's numbers;
- the SVG plot is `aria-hidden` and the curve panel carries one textual description
  (`Throughput curve · peak ≈543 tokens/s`), because a polyline is not a readable description.

## 9. Localization

Visible production strings must go through the DSH Client locale service or the locally verified equivalent. Required baseline locales: English and Simplified Chinese — implemented as the `turnPerformanceMeter` namespace (`ctx.locale.register(ns, {en, zh})` + `ctx.locale.bind(ns)`, with an in-module `en` fallback if the service is absent). Tool names, `tokens/s` and the `+N` count suffix are deliberately locale-independent. The debug scaffold string is temporary and must not survive production release — removed in Phase 3 together with the localStorage placeholder gate.

Phase 4 extended the namespace with the card's strings; the frozen Chinese wording is:

| Key | English | 中文 |
|---|---|---|
| `completedLabel` | Turn performance summary | 本轮性能统计 |
| `colReasoningTps` | Reasoning TPS | 思考 TPS |
| `colOutputTps` | Output TPS | 输出 TPS |
| `colGeneratedTokens` | Generated Tokens | 生成 Tokens |
| `colTtft` | TTFT | 首响应 |
| `elapsed` | elapsed | 总用时 |
| `tools` | tools | 工具 |
| `attempts` | attempts | 模型调用 |
| `status.completed` | completed | 已完成 |
| `status.interrupted` | interrupted | 已中断 |
| `status.errored` | errored | 出错 |
| `status.max-tokens` | token limit reached | 达到 Token 上限 |
| `unavailable` | unavailable | 不可用 |
| `curveLabel` | Throughput curve | 吞吐曲线 |
| `curveHint` | Hover or focus for the throughput curve | 悬停或聚焦查看吞吐曲线 |
| `curveUnavailable` | no throughput samples | 无吞吐采样 |
| `peak` | peak | 峰值 |

Phase 5's curve panel adds four keys and reuses two existing ones: the legend labels are the live state labels
`thinking` / `output` (思考 / 输出), which is exactly what the reference legend shows, and the axis ceiling and the
peak magnitude are formatted numbers rather than translated strings.

`≈` and `—` are locale-independent glyphs and are not translated; the status detail that follows a status word (for
example `aborted:user`) is diagnostic metadata and stays in its recorded form. A missing key degrades to the key
itself, never to `undefined`.
