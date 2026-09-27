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

Phase 7A.1 additions (all in `npm run verify`) — the second external audit's two blockers, each test file written and
observed failing against `c0d2a60` before the production change, so the counterexample is demonstrated rather than
asserted:

- `test/curve-peak-priority.test.js` — the chart budget's retention priority across **all** run lengths. The
  counterexample is the pure allocator over 170 three-vertex runs plus three singletons whose last one carries 9999
  tokens/s (old budgets `[1,1,0]` — the peak refused; new budgets `[1,1,1]` with an ordinary long run yielding). It
  then pins the matrix: a two-vertex and a long peak run under the same saturated budget, the peak first and last in
  input order, an equal peak resolving to the earliest run, repeated-call determinism, `allocated <= 512`, refused runs
  staying exactly `0`, and no run receiving an unrunnable one- or two-vertex allowance when it holds three or more.
  Four further tests drive the same scenario through `TurnTelemetryStore -> settled.curve -> curveViewModel ->
  completedTree`, with the singleton peak produced by the real clock (200 output stretches, 200 reasoning stretches,
  three one-delta attempts and the successor attempt that collapses the peak episode to one instant): the peak run is
  drawn, `renderBudget.peakRun` names it, `peakTps` is its rate, the printed `≈9,999` sits on the marker whose
  `data-tps` is `9999`, and no other marker or vertex shares the peak dot's coordinate. The chart-wide element
  accounting is asserted as `lineVertices + markers === elementPoints <= 512` rather than on `drawnPoints` alone;
- `test/rebaseline-generation.test.js` — window generations. Every case is controller-level through
  `fakeSessionsService()` + `createController()`, not the feed alone, because the defect was in what the store owned
  across the boundary: the counterexample (generation 1's single sample becoming two after a `replace` with the same
  two rows); rebuilt sample counts equal to a fresh controller's; a shorter replacement window not retaining the delta
  it dropped; a replacement window beginning mid-turn re-adopting the open turn with an unknown start and a rebuilt
  live rate; a recovered record still upgrading when the authoritative `turn/start` arrives in the new generation; a
  completed turn rebuilt by a replace comparing **deep-equal** to a fresh controller over the same window on both the
  telemetry and the rendered card; a completed-only window yielding the card and no live meter; tool state absent from
  the window not surviving it; a rebaseline of session A leaving session B's record, settled snapshot and rendering
  identical by identity; idempotence over three consecutive replaces; an empty replacement window leaving nothing
  behind; and `rebaselineSession` itself, including its no-op on an unknown session and its refusal to disturb an
  unrelated one.

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
  `conversation.input.dock`, order `-10`, asserted both as a literal and by sorting against the shipped occupants),
  the absence of the superseded composer-dock literal, `ctx.effect`
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

Phase 6 additions (all in `npm run verify`; the browser pass is reported separately, see §3):

- `test/curve-attempt-boundary.test.js` — **the counterexample file.** It reproduces the rejected Phase 5 pipeline
  verbatim (one window rolled across the concatenated sample list, with the verified half-open window so the
  comparison isolates the boundary defect rather than a window convention) and asserts the rates it produces: 210 at
  the shared coordinate, 120 one window into the next call, where the corrected construction reports 200 and 20. It
  then asserts the corrected per-attempt series, a retry that resets the window, a retry whose abandoned prefix
  produced a single delta and therefore shares the coordinate, the 250 ms grid, the decay-tail clamp, and — the
  strongest invariant in the file — that the reconstructed curve agrees with `LiveMeter` at every attempt-local
  instant the live meter was read at;
- `test/curve-regression-matrix.test.js` — one named scenario per frozen curve semantic: window reset at a boundary,
  a previous attempt's tokens unable to enter the next window (with an independent per-attempt upper bound), tool time
  at zero width *and* a window reset, retry reset, peaks not inflating each other, multiple reasoning runs, multiple
  output runs, same-phase merge/split at exactly one window, runs never merging across an attempt, one subpath per run
  with exactly one crossing of the boundary in the coordinate list, no vertex drawn through an absent interval, the
  turn peak over the full per-attempt series before downsampling, downsample budget independence, an internal stall
  keeping its width, and the plain single-attempt shape unchanged;
- `test/curve-quality.test.js` — `curve.quality === quality.temporalShapeQuality` and the two axes disagreeing in both
  directions (an exact token total with no durable settlement is `estimated`, not `calibrated`; partial usage with
  durable anchored timing keeps its shape quality); a turn with no generated delta publishing `unavailable`; the
  ceiling clamped so an over-strong claim cannot leak through; and a sweep over **every recorded fixture** through both
  the live and the durable path;
- `test/cadence-contract.test.js` — a **source-level** contract, because a dead option cannot be caught behaviourally:
  `src/core/` and `src/host/` contain no `refreshMs`, no `setInterval`/`setTimeout`/`requestAnimationFrame` and no
  reference to the presentation cadence, with comments and string literals stripped so prose may still explain why;
  the 50 ms interval is declared exactly once, in `src/client/live/cadence.js`; the scheduler and controller both take
  it from there; `LiveMeter` has no `refreshMs` property even when one is passed; and the 1000 ms window plus the
  250 ms curve cadence are core metric constants;
- `test/runtime-robustness.test.js` — the runtime shapes: sequential tools, concurrent tools (`workMs > wallMs`, live
  timer on the union), the compact tool label from 1 to 10 calls, a tool-only turn, the **recorded** tool-only turn
  asserted to carry no assistant text at all, an empty-output turn reporting `null` rather than `0`, an abandoned
  attempt keeping its prefix while the timing claim degrades, a retry before a tool and a retry after one, a provider
  error as a status with the failed attempt still measured, a failed tool not failing the turn (plus the recorded
  weaker shape where DSH recorded a failing command as a successful call), incomplete usage, a missing
  `reasoningTokens`, a timestamp-less delta refused rather than defaulted, a duplicate row object deduplicated, a late
  frame for a superseded attempt landing in the completed curve but never in the live window, an orphan delta counted
  and dropped, a whole-corpus sweep under both readings, and the absence of `llm/retry` from every recording stated as
  a test rather than as a claim;
- `test/completed-lifecycle.test.js` (added cases) — reload mid-turn: an open turn is never rebuilt as a completed
  card and the pill degrades to a neutral stage with no rate; a durably settled attempt is restored with its original
  delta timestamps and its usage, so TTFT is derivable again; and a rebaseline into a window that no longer contains
  the turn at all renders nothing rather than a guess;
- `test/curve.test.js`, `test/curve-view-model.test.js`, `test/telemetry-store.test.js`, `test/time-axis.test.js`,
  `test/helpers/equivalence.js` — updated to the new structures: `phaseRuns` episodes with the merge/split rule and
  attempt-boundary split, the tail bound, `attemptTimeMs` alongside `activeTimeMs`, `hasSuccessor` on the segment,
  per-run paths in the view model, the legacy single-array snapshot still drawing, and the equivalence harness
  building per-attempt series so it cannot agree with itself while disagreeing with the product.


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
  input, refusal of an unsatisfiable budget, the phase-evidence boundaries (including "absent phase, absent span"),
  and a bounded render for a ten-minute turn;
- `test/curve-view-model.test.js` — the settled curve → geometry seam: `null` when there is no curve, a round axis
  ceiling derived from the full-series peak, per-phase evidence clipping with no invented zero line, an absent phase
  kept in the legend but not drawn, an approximate peak placed on the leading series, finite and ordered coordinates,
  a zero-length turn, purity, and the point bound;
- `test/completed-interaction.test.js` — the whole hover/focus machine, the two stacked layers, `aria-hidden` on
  exactly the hidden one, the two kept columns at their original grid tracks, the SVG hidden from assistive
  technology with one textual description, the peak marker in percentages, focusability tied to the presence of a
  curve, the `:focus-visible` ring replacing rather than removing the outline, reduced motion, no timer in the card at
  any mode, and both locales.

Phase 7C additions (all in `npm run verify`). The two defect files were written first and **observed failing** against
`b7bda66` before any production change, so both counterexamples are demonstrated rather than asserted:

- `test/curve-calibration.test.js` — the completed curve's magnitude system. The failing example is the minimal
  instance: one attempt, two 400-character deltas half a window apart, settled with `outputTokens: 900`. Raw shape sum
  200, calibrated samples `[450, 450]`, and `peakTps` was **200** where the calibrated answer is **900**. It then
  freezes the matrix: the exact split calibrating both phases, one common scale when `reasoningTokens` is absent, no
  usage leaving the estimated shape and inventing nothing, per-attempt independent scales, tool-call arguments inside
  the calibrated total, the calibrated sample sum equalling `outputTokens`, a vertex never calling itself exact, and
  the Phase 7B reproduction printed as a diagnostic table (**raw shape peak 100, calibrated peak 365.2, provider total
  365**, with the rejected per-phase peak shown to sit below the turn's own mean);
- `test/curve-source.test.js` — the join. Positional and verified on `attemptId`/`step`/sample count; a disagreement in
  any of them degrades the **whole** join to the raw shape and reports every symptom rather than the first; the raw
  evidence is asserted unmutated by identity and by value; an empty attempt is carried through so the source's attempt
  list matches the turn's; and the source re-derives exactly the numbers `aggregateTurn` published;
- `test/curve-total-rolling.test.js` — the cross-phase counterexample: one reasoning delta at 0 and one output delta at
  500 against a 1000-token provider total. The rejected per-phase pipeline peaks at 500; the corrected total window
  reads **1000** at that instant and so does the published peak. It then asserts the completed trace vertex for vertex
  against `SlidingWindowMeter`'s rule restated independently, the `activePhase` label rule, and the shared seam;
- `test/curve-trace-matrix.test.js` — the fourteen-scenario acceptance matrix: reasoning-only, output-only,
  reasoning→output within and beyond one window, reasoning→output→reasoning, a long internal stall decaying to zero and
  resuming, a tool gap at zero width, a next attempt and a retry each resetting the window as a subpath break, a phase
  boundary as a colour change rather than a statistical reset or an x gap, the global peak as the maximum over every
  attempt-local total vertex, and the published provenance shape;
- `test/curve-long-agent-visual.test.js` — the visual regression, on a 24-call turn with 23 tools and a four-second
  stall inside every fourth call. It asserts two subpaths per call (`reasoning` then tool-call arguments) sharing their
  seam, a stall adding no subpath, zero singleton markers on the corrected chart, the chart staying inside
  `MAX_RENDER_POINTS_TOTAL`, the peak surviving on a drawn run, and — computed from the same fixture — the rejected
  episode-based rule needing strictly more subpaths and producing 18 markers for the same evidence;
- `test/curve-reference-window.test.js` — rewritten around the total window. The reference is now the literal
  definition over **all** phases, with the body ladder plus the one-step-shifted tail ladder and no episode partition;
  the comparison is vertex by vertex in both directions (nothing invented, nothing missing), plus the structural
  claims, plus the independent brute-force peak over every attempt;
- `test/curve.test.js` — the pure sampler and reducer: the total window, the label-not-filter rule, a deterministic
  tie-break when a reasoning and a text delta share an instant, the seam invariants of `visualRunsOf` (including a
  gapped transition), `downsampleRun`'s seam protection at every budget, and `attemptTrace`'s two clocks;
- `test/curve-regression-matrix.test.js`, `test/curve-attempt-boundary.test.js`, `test/curve-episode-opening.test.js`,
  `test/curve-render-budget.test.js`, `test/curve-peak-priority.test.js`, `test/telemetry-store.test.js`,
  `test/runtime-robustness.test.js`, `test/completed-tree.test.js` — the existing suites, corrected where they encoded
  the superseded geometry. Every changed expectation carries its old contract in a comment beside it; the reasons are
  collected in `docs/IMPLEMENTATION_LOG.md` §"Phase 7C".

Phase 7C.2 additions. The failing case was strengthened **before** any production change and observed failing against
`534ff8f`, so the anchored-integral violation is demonstrated rather than asserted. The measured baseline on the patched
`t4` fixture was `outputTokens: 144`, `reasoningTokens: 74`, observed phases `{output: 27, reasoning: 0}`, old calibrated
sample sum **70**, new sample sum **144**.

- `test/phase-evidence.test.js` — the contradiction matrix, at both the calibration and the turn level. The sixteen
  required cases are covered as: (1) a valid exact split still calibrating each phase to its own counter; (2) an absent
  `reasoningTokens` remaining a normal total-only calibration with an empty issue list, including a single-observed-phase
  variant and a no-total variant; (3–7) counterexamples A–D plus the two output-phase directions; (8) tool-call argument
  samples inside the anchored total in every mode; (9) a retry pair calibrated independently, where one attempt is
  `total-anchored` and the other `phase-anchored` and the turn reports the weaker of the two; (10) partial usage; (11) no
  usage; (14) no fabrication, no loss and no zeroing across five usage shapes; (15) the peak staying approximate at every
  mode; (16) the **recorded** instance — `t6-tool-only-deepseek-official` step 4 reports `outputTokens: 282` beside
  `reasoningTokens: 281` over 281 reasoning deltas and no output delta, and the old algorithm integrated to 281;
  plus a symmetry test over all five issue kinds and an explicit assertion that an impossible split is never clamped
  into a plausible one;
- `test/curve-source.test.js` — the general anchored-integral sweep, which is the invariant stated as a property rather
  than as a second worked example: for **every** contributing attempt of **every** real and derived fixture, on both the
  durable and the live plane, `totalAnchored === true` implies `sum(calibration.samples.tokens) === outputTokens`; and for
  every fully usage-covered turn the curve-source sample total equals the printed `generatedTokens`, which is the
  curve/card consistency half of the same statement. Measured on the fixed tree: 50 anchored attempts, 0 short integrals,
  22 curve/card comparisons, 0 mismatches. The same sweep under `534ff8f` reports 2 violations — the patched `t4`
  fixture (70 against 144) and the recorded `t6` step 4 (281 against 282);
- `test/dsh-degradation.test.js` — the existing *"a provider total with no deltas of that phase is reported, not
  invented"* test **extended, not replaced**. Its original assertions are kept and the stronger invariant is added: the
  provider counter retained, no fabricated reasoning sample, the calibrated sample sum equal to `outputTokens`, the
  mode `total-anchored`, the split quality degraded while the total quality stays `exact`, the coverage still `full`,
  no silent loss of the missing phase's tokens, and the peak still approximate;
- `test/quality-model.test.js` — one expectation corrected, because it encoded the defect (see
  `docs/IMPLEMENTATION_LOG.md` §"Phase 7C.2").

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

A tool call whose result carries an error envelope, or `isError: true`. Verify the **call** is marked failed, the
**turn** is unaffected, and the model's recovery after the failure is measured normally. The recorded `t7` fixture
covers the weaker real shape: a shell command that failed while DSH recorded the call itself as successful, because
its error text arrived as ordinary tool output.

Tool starts and returns error. Verify duration is counted as tool latency, result text is excluded from model output, turn status follows DSH's eventual turn outcome.

### K. Tool-only turn

The model emits a tool call and ends without any assistant text. Verify the generated total still counts the tool-call
argument, output TPS is computed if output-phase evidence exists, the completed card is still produced, and the curve
draws only the phases that actually occurred. Covered by the recorded `t6` fixture, which carries four such attempts.

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

Phase 6 status for the same rows, reported honestly:

- **served bundle verified in the live page.** The page was reloaded against the rebuilt plugin and the browser
  fetched `/plugins/??dsh-turn-performance-meter/client.js` (200, 326 997 bytes) and confirmed the Phase 6 code is in
  it: `attemptTokens`, `drawnToMs`, `phaseRuns`, `localMs`, `qualityAxes`, `curveQuality`, `data-run`,
  `DEFAULT_PRESENTATION_REFRESH_MS = 50`, and **no** `this.refreshMs` anywhere. The live pill rendered on that page
  (`dsh-tpm*` classes present) and the console carried no plugin error — only unrelated pre-existing
  `/api/pet/*` 404s from another installed plugin;
- **the completed card and the multi-run curve were not re-captured as pixels in this round.** Producing one requires
  a settled turn in a browser that is observing it; the available authenticated page is the session running this work,
  and a second page opened in an isolated browser context is refused by the host with
  `dsh web authentication required`. The card's element tree, its data path, the multi-run SVG structure, the
  tool-only card and the reload-mid-turn behaviour are therefore covered by the test suite rather than by a screenshot,
  and that gap is stated rather than papered over;
- `dev_reload_package` against this plugin **hung** and returned no result. The served bundle was verified directly
  instead, which is the stronger check for a client bundle. The injector's own logs show why the reload is fragile
  here: the self-reload watcher fired two seconds after `client.js` was rewritten and recorded
  `watch-precheck-blocked`, so a reload raced with a bundle write in the same directory.

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

## 7. Phase 7D — DSH 0.1.7-rc.2 migration

The whole suite targets the locally installed `0.1.7-rc.2`; §13 of `docs/DSH_API_NOTES.md` records the declarations the
new cases are written against. Five files were added, 36 tests in total, and each asserts a contract the 0.1.5-era
assumption got wrong or never covered.

- `test/dsh-017-tool-result.test.js` (6 tests) — the tool-role result contract and nothing else. The identity is read
  from `message.toolCallId`, the failure flag from `message.isError`, and the structured `data.error` is admitted only
  on a message already flagged failed; a result whose identity is unreadable fails closed, closes no call and is
  counted rather than repaired by position; and the legacy 0.1.5 nested shape is proved reachable only for a message
  that does not declare `role: 'tool'`, so a 0.1.7 message can never be answered from its content blocks.
- `test/dsh-017-tool-concurrency.test.js` (7 tests) — the sequential-tool defect class directly. A hundred strictly
  sequential calls never exceed one running tool; the running count steps 3 → 2 → 1 → 0; the tool wall time is the union
  of the intervals and not their sum; mixed tool names are counted per call; a malformed result closes nothing; a failed
  tool still finishes; and a result pairs with its call by identity when the results arrive out of order.
- `test/dsh-017-settlement.test.js` (7 tests) — retirement versus abandonment. The expectations are derived from
  `test/helpers/assistant-stream-fold.js`, a faithful port of the real `ClientAssistantStream` algebra, so the test
  exercises the same decision the shipped fold makes rather than a paraphrase of it: a bare settle with a matching
  durable settlement is a retirement, a bare settle with none is an abandonment, one queued settlement cannot excuse a
  later attempt in the same step, and a directly settled attempt cannot be re-labelled by a later bare call.
- `test/dsh-017-completion.test.js` (9 tests) — the turn completion lifecycle. All seven `TurnEndReason` variants
  terminate the turn with the right status, including `forked`; a turn ends with a call still unresolved; evidence
  arriving after the boundary cannot resurrect the turn; a `turn/end` with no record is counted, recorded and repaired
  by reconstruction from the durable window; a reload rebuilds the same card; historical and live tool counts stay
  separate; and the four window-change kinds are each exercised end to end.
- `test/dsh-017-fixtures.test.js` (8 tests) — the versioned 0.1.7 fixture corpus. Every capture declares its family and
  provenance; every recorded result uses the tool-role shape; every call pairs with exactly one result by identity; the
  turn carries a durable `turn/end` row and is a normally completed turn; a replay leaves no unmatched result and no
  running call, and a replay through the controller ends settled with no live pill; the durable reconstruction path
  pairs the same results through the same contract site; and the transient plane carries three attempts, each bounded by
  a start and an end frame.

Baseline for this phase: **685 tests, 685 pass, 0 fail** (648 before the phase). `npm run verify` runs
`scripts/verify-structure.mjs` and then the Node test runner over `test/*.test.js`. Sanitization is a separate gate —
`node scripts/verify-sanitization.mjs` — and it now also covers `fixtures/dsh-0.1.7/` alongside the 0.1.5 capture family
and the derived mutations.

## 8. Phase 7D.1 — terminal-tail durable metric reconstruction

One defect, one file of new tests, no frozen semantic touched. The subject is the equality

```text
terminal-tail recovery  ==  durable reconstruction of the same evidence
```

and its complement: a field the tail's evidence does not determine must be `unavailable`, never inferred.

- `test/dsh-017-terminal-tail-recovery.test.js` (11 tests). The tail under test is the real
  `fixtures/dsh-0.1.7/t01-sequential-tools.json` recording with `turn/start` (seq 4) removed and nothing else: 3
  `assistant/message`, 2 `tool/call`, 2 `tool/result`, the step boundaries and `turn/end`, with no transient row at all.
  Expected values are never written by hand — they come from `reconstructFromDurable()` over the same tail reduced
  through `TurnTelemetryStore`, so a disagreement is a disagreement about evidence rather than about a literal.
  - **the main blocker** — a terminal durable tail without `turn/start` reconstructs the turn's durable metrics:
    attempts, per-attempt sample times and phase segmentation, usage and its source, settlement kind/outcome/sequence,
    tool intervals and statuses, `startMs`, `firstTokenMs`, status and note, duration, and the whole settled metric
    tuple including `temporalAllocationMode` and the three quality axes — compared field by field against a second
    reference built from the **full** recording, which proves the tail loses exactly the start-dependent fields;
  - **the metric pipeline** — the recovered curve is `full`-coverage calibrated, its attempt count matches the turn's,
    and its peak equals the reference peak, which is what shows the recovery re-entered `aggregateTurn → curveSource →
    attemptTraces` rather than assembling a card of its own;
  - **unknown boundaries** — TTFT and turn elapsed are `null` with no `turn/start`, while `firstTokenMs` is recovered
    from the durable generated samples; no value is inferred from a first delta, a `step/start`, a `tool/call`, the
    attach instant or the clock;
  - **ingestion routes** — the same equality holds when the tail arrives one `append` at a time, and when settlements
    are inserted by `settle-assistant` with their entry rather than appended, which is the route DSH uses for
    interrupted messages and non-surface `attempt` settlements;
  - **minimal evidence** — a window whose only row is `turn/end` closes terminally with zero attempts, zero tools, no
    start, no TTFT, no elapsed, no samples and no fabricated duration;
  - **no regression** — a full durable window containing `turn/start` takes the ordinary path with
    `turnEndLookupMiss` 0 and equals the full-recording reference including TTFT and elapsed;
  - **generation and session isolation** — a `replace` drops the superseded generation's retained evidence, so no old
    settlement can be reconstructed together with a new `turn/end`; two sessions using the same turn number do not
    share retained rows; and a recovered turn leaves nothing behind for the turn that follows it.

## 9. Phase 7D.1.1 — reconstruction contract and retention-policy closure

A closure phase: no metric engine, no UI, no curve semantics and no DSH contract touched. Its subject is two latent
contract defects that the Phase 7D.1 audit exposed, both of the same kind — a rule the source stated that the code did
not enforce, or an invariant the code implemented that the documentation denied. Both were addressed failing-test-first.

- `test/dsh-017-materialize-reconstruction.test.js` (4 tests). The exported
  `materializeReconstructedTurn()` accepted a `timeMs` input and passed it to `beginTurn` as
  `reconstructed.turnStartMs ?? timeMs`, so any caller holding an arbitrary finite clock could give a reconstructed turn
  a start it never observed. The fixture is `fixtures/dsh-0.1.7/t01-sequential-tools.json` with `turn/start` (seq 4)
  removed and the terminal boundary kept, and the input is a plausible invented clock.
  - **pre-fix evidence, baseline `dd4b194`** — `record.startMs` `null` -> `9000000000000`;
    `settled.ttftMs` `null` -> `0`; `settled.turnElapsedMs` `null` -> `0`. The interval fields are the sharper half: with
    a start placed after the recorded first token the aggregate clamps the negative intervals, so the card reports a
    **measured-looking `0 ms`** where `null` (the em-dash rendering) is the honest answer. Two of the four cases failed on
    that baseline.
  - **the fix** — the parameter is deleted rather than ignored, so the fallback is not expressible; the start is
    `reconstructed.turnStartMs` and nothing else can reach it. A caller holding an observed boundary applies it through
    `store.turnStartObserved()`, the one-way upgrade the controller's miss path already uses.
  - **the adversarial route** — once the named parameter is gone, the only remaining route is an unnamed `timeMs` on the
    input object; that case is asserted inert, so the guard cannot be defeated by object spreading.
  - **the complement** — the same tail *with* `turn/start` still yields `startMs` 1790497151824, `turnElapsedMs` 6938
    and a numeric TTFT, so refusing fabrication did not become refusing evidence.
- `test/dsh-017-retention-contract.test.js` (9 tests). The bounded per-generation durable-evidence retention had one
  policy in its implementation and the opposite in its comments and documentation. `DurableEvidencePool.record()`
  deletes a turn's key before re-inserting it, and a JavaScript `Map` iterates in insertion order, so the released turn
  was the least recently *updated* one — while the source, `ARCHITECTURE.md`, `TASKS.md` and `IMPLEMENTATION_LOG.md` all
  described "oldest released first" / "first-seen" semantics.
  - **the chosen policy** — least-recently-updated, which is also the policy the consumer wants: the turn a `turn/end`
    miss can ask about has been publishing evidence moments earlier and is therefore the most recently refreshed entry,
    whereas first-seen FIFO would release a long turn that began 33 turns ago while it was still running. The
    implementation was kept; the comments and all four documents now state it.
  - **the decisive case** — turns 1..32 resident, a further durable row for turn 1, then turn 33: turn **2** is released
    and turn 1 survives with both its rows. First-seen FIFO would release turn 1.
  - **the property the policy exists for** — a long turn interleaved with 64 shorter ones (twice the bound) keeps all 65
    of its rows, in arrival order, starting with the `turn/start` the reconstruction needs.
  - **the rest of the matrix** — the bound is a hard ceiling at `MAX_RETAINED_TURNS = 32` and a turn's row count never
    costs more than one slot; an evicted turn answers `turnEvents() === []` (as do unknown and non-numeric turns); a
    survivor's rows come back in durable arrival order with the retained objects identical by reference; a duplicate
    `seq` neither duplicates a row **nor counts as activity** (so a replayed window cannot refresh turns in replay order
    and change the victim); a `replace` clears the pool, resets the cumulative counter and frees the old generation's
    sequence numbers for reuse; and `counters.retainedDurableEvents` is asserted to be a cumulative ingest count that
    exceeds current occupancy after eviction, with current occupancy reported separately by `retainedTurnCount()`.
  - **documentation/implementation agreement is itself a test** — the retired first-seen vocabulary is asserted absent
    from the source and all four documents, and the implemented policy is asserted present in the source and in
    `ARCHITECTURE.md`. A future re-wording that reintroduces the old claim fails the suite rather than passing silently.

Verification for this phase is reported as a **local** result: the repository has no CI runner, so `npm run verify` here
is a local test result and is not described as CI-verified anywhere.
