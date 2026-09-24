# Test Plan

## 1. Pure unit tests

The initial scaffold already covers:

- rolling-window boundary semantics;
- reset between attempts;
- parallel tool sum vs wall-union duration;
- tool-call arguments classified as model output;
- calibration totals;
- weighted turn TPS aggregation;
- compressed time axis removes inter-attempt/tool gap;
- rolling curve operates on active time.

Add tests for every bug discovered during integration.

Phase 3 additions (all in `npm run verify`):

- `test/live-state.test.js` — the eight-state machine: entry/exit conditions, TTFT frozen once, parallel tools,
  tool→transition→waiting, retry transition, wrong-turn isolation, settled-for-every-status, junk no-ops;
- `test/live-presenter.test.js` — projection guards (hidden when inactive/settled/idle; streaming state without
  streaming evidence degrades to transition, never a stale TPS; tool view carries no TPS field; waiting never shows
  the TTFT counter; `approximate === true` for live TPS; two presenters never share state);
- `test/live-format.test.js` — `≈` contract, stopwatch/elapsed formats, tool-name truncation, single vs multi tool
  labels;
- `test/live-refresh.test.js` — scheduler structure: 100 notifications coalesce to one leading render, ticker-bounded
  renders, ≤2 timers, stop/dispose leave zero, disposed scheduler inert, invalid config rejected;
- `test/dsh-client-feed.test.js` — window wire: ordered initial pass, revision guard, append dedupe (durable seq +
  transient identity), prepend ignored, replace rebaselines, settle-assistant with/without entry (settlement vs bare
  abandonment), plain-durable settlement correlated to the open attempt, malformed everything degrades to issues;
- `test/live-controller.test.js` — fixture-driven replay of t1/t2/t3/t5 (state sequences, tool names write/edit/pwsh,
  interrupted exit with ticker stopped, >1000-delta ingestion with ticker-bounded renders), session-switch isolation,
  idempotent attach / dispose cleanup (HMR shape), settle-assistant + `llm/retry` outcome derivation, malformed
  windows never crash;
- `test/client-bundle.test.js` — deterministic bundle, committed `client.js` freshness, module-table contract
  (React the only external, no `@deepseek-ai/*`), slot registration (`id: turn-performance-meter`,
  `conversation.input.dock`, order 30), the absence of the superseded composer-dock literal, `ctx.effect`
  setup/disposer semantics, remount shape, and the no-charting-dependency assertion;
- audit tests inside existing files — settlement concepts (`assistant/attempt` ≠ `abandoned`), `llm/retry` →
  `retried`, `reasoningTokens=0` + reasoning stream consistency conflict (unit, aggregate, and fixture-patched), the
  frozen window warm-up contract, the tool-episode live timer.

Phase 4 additions (all in `npm run verify`):

- `test/ui-model.test.js` — the completed view model: four fixed columns in order, exact/approximate/unavailable
  rendering per field, the `≈` consistency rule between a rate and the token count on its own derivation chain,
  secondary-line text, status kinds including `max-tokens`, footer tool figures, TTFT/elapsed, curve retention, the
  purity of the projection, and a well-formedness sweep over every recorded fixture;
- `test/completed-tree.test.js` — the rendered element tree: `role="group"` card with a per-turn accessible name and
  **no** live region, four labelled cells with per-cell accessible names, visible `≈` as text plus its `data-*`
  mirror, status as real text with a tone attribute, the footer hiding the tool item when there are no tools and never
  printing the summed work where the wall union belongs, **no chart in the summary layer**, an inert card when the
  turn carries no curve, both locales, and the card CSS contract (scoped selectors, `repeat(4, minmax(0, 1fr))` grid
  with a two-column wrap, host theme tokens, opacity-only transition, one style-tag id);
- `test/completed-lifecycle.test.js` — the controller's precedence rule: an open turn beats a settled one; live →
  completed is one advance with no blank frame; completed → a new `turn/start` returns the pill in one advance; a
  second settled turn replaces the first card; session A/B isolation; the **durable-only window** (no transient row at
  all) rebuilding the same card as the live-observed path for t1/t3/t4/t5 and for every fixture; the attempts restored
  from the embedded compact streams with a derived `firstTokenMs`; a `replace` window (page load/reconnect) reaching
  the same card; the card surviving a rebaseline; an abandoned-only turn still settling to a card; a disposed
  controller rendering nothing; and the static guarantee — fifty re-projections plus late unrelated events return the
  *identical* view object;
- `test/completed-format.test.js` — formatter edge cases: no `NaN`/`Infinity`/`undefined`/`null`/negative zero ever
  reaches a display string, the em dash for absent evidence, the three-significant-digit TPS bands including the
  `9.999 → 10.0` rounding boundary, locale grouping for token magnitudes, `≈` as a prefix (never `~`), the card's
  one-decimal second scale, and integer-only tool labels.

Phase 5 additions (all in `npm run verify`; the browser A/B and the screenshot set are separate evidence):

- `test/cadence.test.js` — one cadence constant and no second default in `refresh.js`, `controller.js` or `main.js`;
  200 / 50 / 10 ms all constructible; an override resolves to a usable interval or falls back, never to a broken
  timer; the override is reachable only while the diagnostic switch is on; 1 315 notifications under each cadence
  produce one timer and one render per tick, and `dispose` leaves none;
- `test/live-refresh.test.js` — the scheduler's structural contract at **every measured cadence**, not at one
  hard-coded 200 ms;
- `test/completed-lifecycle.test.js` (added case) — every live presentation instant is a distinct view object, which
  is what makes a single `setView` per tick sufficient and the removed `useReducer` bump provably redundant;
- `test/curve.test.js` (added cases) — the stride counterexample that defeats the previous downsample, anchors at
  every budget, no invented peak, earliest-index tie-breaking and determinism, non-decreasing x for an unordered
  input, refusal of an unsatisfiable budget, `phaseSpans` boundaries (including "absent phase, absent span"), and a
  bounded render for a ten-minute turn;
- `test/curve-view-model.test.js` — the settled curve → geometry seam: `null` when there is no curve, a round axis
  ceiling derived from the full-series peak, per-phase evidence clipping with no invented zero line, an absent phase
  kept in the legend but not drawn, an approximate peak placed on the leading series, finite and ordered coordinates,
  a zero-length turn, purity, and the point bound;
- `test/completed-interaction.test.js` — the whole hover/focus machine (`enter`/`focus` → curve, `leave`/`blur`/
  `reset` → summary, focus-inside stays open, un-interactive card is summary by invariant), the two stacked layers,
  `aria-hidden` on exactly the hidden one, the two kept columns at their original grid tracks, the SVG hidden from
  assistive technology with one textual description, the peak marker in percentages, focusability tied to the presence
  of a curve, the `:focus-visible` ring replacing rather than removing the outline, reduced motion, no timer in the
  card at any mode, and both locales.

## 2. Required metric fixtures

### A. Single call, text only

One turn, one model attempt, no tool, no reasoning. Verify TTFT, generated tokens, output TPS, curve, no reasoning metric.

### B. Reasoning then final text

Provider reports `outputTokens=1000`, `reasoningTokens=600`. Verify reasoning=600 and non-reasoning output=400; never report 1600 generated tokens.

### C. Tool-heavy call

Model emits short reasoning plus a large `write` or `edit` tool argument. Verify the tool payload contributes to output TPS/tokens and the tool result does not.

### D. Multi-call turn with long tool wait

```text
LLM A 4s -> tool 60s -> LLM B 6s -> tool 20s -> LLM C 5s
```

Verify:

- turn elapsed includes ~95s plus request overhead;
- final TPS denominators exclude 80s tool time;
- curve width is based on model-attempt generated spans only;
- live rolling meter resets after each tool.

### E. Parallel tools

Two calls overlap 50%. Verify `toolWorkMs > toolWallMs`; user-facing compact tool duration uses wall-union time.

### F. Retry

Attempt 1 emits partial tokens, fails/retries, attempt 2 succeeds. Verify live reset and final quality according to available usage for attempt 1.

### G. Interruption

Stop during reasoning, during normal text, and during tool-call argument generation. Verify final status is interrupted and partial observed throughput does not become falsely complete/exact.

### H. Missing reasoningTokens

Stream clearly contains reasoning deltas but provider usage exposes only `outputTokens`. Verify generated total may be exact while reasoning/output split is not labeled exact.

### I. Tool error

Tool starts and returns error. Verify duration is counted as tool latency, result text is excluded from model output, turn status follows DSH's eventual turn outcome.

### J. Cross-session isolation

Run two sessions and switch quickly. Verify no card/TPS samples leak between session ids.

## 3. Browser/UI tests

Automate where local DSH test infrastructure permits:

- component hidden with no relevant turn;
- pending TTFT pill;
- streaming TPS pill;
- tool timer pill;
- completed summary;
- hover switches to curve;
- mouseout returns summary;
- keyboard focus provides curve access;
- no curve in live mode;
- narrow layout does not overflow;
- reduced-motion disables/reduces transition;
- light/dark screenshots.

Phase 3 (live rows) executed against the real running DSH web client with Chrome DevTools automation; evidence in
`IMPLEMENTATION_LOG.md` §3.9 and `dev/screenshots/phase3/`:

- hidden with no open turn — verified (post-settle, idle, and mid-turn-attach cases);
- pending TTFT pill — screenshots (`turnb-pending-first-token.png`, `turnc-*.jpg`, …, and Phase 5's
  `01-live-ttft.png`) plus a cadence-bounded DOM trace;
- streaming TPS pill — screenshot (`turng-streaming-output.jpg`, `≈` marker visible) plus DOM trace with per-tick
  `思考/输出 ≈N tokens/s` values;
- tool timer pill — timestamped DOM trace (`pwsh · 0.3 s | 3.6 s`, episode restarts across sequential calls); a
  pixel capture of this seconds-long state was not achieved (agent-to-agent tool-call latency exceeds the window) —
  recorded honestly below;
- completed summary / hover / curve — Phase 4/5 rows, still open;
- no curve in live mode — asserted in unit tests and confirmed in the live DOM (no chart element exists);
- light/dark — plugin accent computed as `#d9480f` (light) / `#ff922b` (dark override) in the live page;
- console free of plugin errors; native stats pills present beside the meter.

Phase 4 status for the completed rows, reported honestly:

- completed summary — **structurally verified, visually partial.** The card's element tree, accessibility, text and
  CSS contract are asserted in `test/completed-tree.test.js` (14 tests) and its data path in `test/ui-model.test.js`,
  `test/completed-lifecycle.test.js` and `test/completed-format.test.js`; the live page confirmed the plugin loads,
  renders the live pill and installs the style tag containing the card CSS. A pixel capture of the rendered card in
  the real DSH client was **not obtained** in this round: the host serializes turns, so a fresh short turn could not
  run while this session's own turn was open, and the two DSH tabs available for reload-based verification became
  unresponsive to DevTools evaluation while re-rendering multi-megabyte conversations. This is an environment
  limitation of the round, not a passing claim;
- hover/focus curve — Phase 5; Phase 4 deliberately renders no chart and no interactive element, which is asserted;
- narrow layout / light-dark screenshots of the card — same limitation as above; the CSS contract (fluid four-column
  grid, `repeat(2, 1fr)` wrap, host `--dsw-*` tokens) is covered by test rather than by pixels.

## 4. Performance tests

Generate synthetic streams with at least 100k delta fragments and long turns. Ensure:

- UI render cadence is bounded and not one React render per delta;
- retained curve points are downsampled/bounded after settlement;
- completed card hover is immediate;
- memory for old turns is bounded to the latest displayed turn unless persistent history is an explicit later feature.

Phase 3 concretized the first requirement structurally (no wall-clock benchmarks): the t5 replay (>1300 transient
frames) asserts every delta is ingested (`droppedDeltas === 0`, sample count == recorded generated-delta count), that
renders happen only on the bounded ticker (render count ≤ `ceil(turnSpan/200ms) + 2` and `< deltas / 5`), that never
more than two scheduler timers exist, and that the ticker stops when the turn settles. The live browser run added
the same evidence end-to-end: during a 113-second streaming turn the ticker produced a render every ~204 ms while
per-delta ingestion ran unthrottled (`notifyCalls` per delta, `renderCalls` per tick — `IMPLEMENTATION_LOG.md` §3.9).

Phase 4 makes the completed card's cost a **structural** property rather than a measurement. The card is built from
the settled snapshot once, at `turn/end`; the projection is keyed by turn identity, so re-projecting an unchanged
settled turn returns the identical object and React has nothing to re-render; and the presentation ticker is stopped
for the card, so a completed session owns no interval and no timer. `test/completed-lifecycle.test.js` asserts the
identity directly (fifty re-projections plus late unrelated events return the same object) and asserts zero surviving
timers on the t3 replay's card. Render complexity with respect to the turn's sample count is therefore O(1) for the
card: the only O(samples) work happens inside `settle()`, which runs exactly once per turn.

## 5. Manual real-model verification

Use at least:

1. one ordinary answer;
2. one reasoning-heavy answer;
3. one `pwsh` call;
4. one write/edit call with a substantial payload;
5. a turn with at least two tools and three model invocations;
6. one manually stopped turn;
7. one retry/error case if safely reproducible.

For each run, record:

- model/provider;
- DSH version;
- turn/step/attempt counts;
- provider usage totals;
- tool durations;
- card values;
- any quality labels;
- screenshot of live and completed/curve states.

## 6. Numerical validation tolerance

Exact aggregate provider token counters: integer equality.

Tool/TTFT durable timestamps: equality to recorded timestamps, allowing only display rounding.

Calibrated curve integral: phase sum should match authoritative phase token total within floating-point tolerance (`< 1e-9` relative for pure calculation before render rounding).

UI displayed TPS: tolerance determined by display rounding, not by silently changing underlying metrics.
