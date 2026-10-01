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
- `test/curve-phase-cumulative.test.js` (Phase 9.2) — the statistic itself: the 100 ms vertex ladder plus the appended
  off-ladder end instant; the reasoning→output episode reset (the seam vertex reads `0` and the next vertex is the new
  episode's own average); a stall's hyperbolic decay (frozen numerator, advancing denominator, strictly decreasing);
  the attempt reset (a trace equals the same attempt measured alone); the terminal settlement tail; the 200-point
  stored-series cap with nearest-neighbour selection, no interpolation and `peak == max(published series)`; and the
  unclamped rates above 1564;
- `test/curve-trace-matrix.test.js` — the fourteen-scenario acceptance matrix: reasoning-only, output-only,
  reasoning→output, reasoning→output→reasoning, a long internal stall decaying hyperbolically and resuming, a tool gap
  at zero width, a next attempt and a retry each resetting the episode as a subpath break, a phase boundary as a colour
  change *and* an episode reset, the global peak as the maximum over every attempt's published series, and the
  published provenance shape;
- `test/curve-long-agent-visual.test.js` — the visual regression, on a 24-call turn with 23 tools and a four-second
  stall inside every fourth call. It asserts two subpaths per call (`reasoning` then tool-call arguments) sharing their
  seam, a stall adding no subpath, zero singleton markers on the corrected chart, the chart staying inside
  `MAX_RENDER_POINTS_TOTAL`, the peak surviving on a drawn run, and — computed from the same fixture — the rejected
  episode-based rule needing strictly more subpaths and producing 18 markers for the same evidence;
- `test/curve-reference-cumulative.test.js` (Phase 9.2, replacing the deleted `curve-reference-window.test.js`) — an
  independent second algorithm that shares no code with `src/`: it walks left from the newest sample to the maximal
  same-phase run and re-derives `Math.round(mass * 1000 / elapsed)` vertex by vertex, over a generated matrix of single
  and paired attempts (steady, bursty, stalls, phase alternations, single-sample episodes, simultaneous timestamps,
  zero-width attempts, settlements earlier/later than the last delta, estimated and calibrated magnitudes). It compares
  the settled `curve.attempts[].points`, the pure `attemptTrace(...).points` and a direct
  `cumulativePhaseTpsSeries` call, and asserts the compressed coordinates and each attempt's published integral;
- `test/curve.test.js` — the pure sampler and reducer: the phase-cumulative statistic, the label-not-filter rule, a
  deterministic tie-break when a reasoning and a text delta share an instant (the ordinal decides the episode as well as
  the label), the seam invariants of `visualRunsOf`, `downsampleRun`'s seam protection at every budget, and
  `attemptTrace`'s two clocks;
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
    sequence numbers for reuse; and `counters.retainedDurableEvents` is asserted to be a cumulative admission count that
    exceeds current occupancy after eviction, with current occupancy reported separately by `retainedTurnCount()`. The
    duplicate and counter cases travel the real `append` route, because admission — not storage — is what refuses a
    duplicate; `retainDurable()` is the storage primitive *below* that gate, and the cases that must be pinned after
    eviction live in the file below.
  - **documentation/implementation agreement is itself a test** — the retired first-seen vocabulary is asserted absent
    from the source and all four documents, and the implemented policy is asserted present in the source and in
    `ARCHITECTURE.md`. A future re-wording that reintroduces the old claim fails the suite rather than passing silently.
- `test/dsh-017-durable-identity.test.js` (5 tests, Phase 7D.1.2). Durable `seq` identity in one generation is
  **generation-wide**, and every durable entry route passes the single admission gate that enforces it. The defect these
  tests were written against is an ordering interaction: the retention pool held its own `seq` set, eviction trimmed it,
  and retention ran before the feed's generation-wide duplicate check — so a replayed row of an evicted turn was refused
  by ingestion and accepted by retention in the same call.
  - **post-eviction duplicate by `append` (§8)** — turns 1..32 resident, turn 33 admitted, turn 1 released; the replayed
    row is then appended and four further turns are admitted. The assertion is a **control comparison**, because a
    counter or a row count cannot distinguish acceptance from refusal: an accepted duplicate pushes the pool back to its
    bound, so the harm is that a later legitimate turn is released. The control replays the identical legitimate rows
    without the duplicate, and the two resident sets and counters must agree.
  - **post-eviction duplicate by `settle-assistant` (§7)** — the same fact on the other durable route. The settlement is
    delivered once, retained once, admitted once, normalized into exactly one `attempt-settle`, and the repeat produces a
    `duplicate-durable-event` diagnostic and nothing else. A second `attempt-settle` would overwrite a committed attempt
    outcome, so this fails closed rather than trusting the fold never to re-publish.
  - **a duplicate of a still-resident row** — pinned so the fix cannot narrow the pre-existing case: no duplicated row,
    no refreshed retention position, and turn 1 is still the eviction victim when turn 33 arrives.
  - **the complement (§9)** — `rebaseline()` is the only boundary that clears seq identity: generation 1 admits seq 1,
    generation 2 admits seq 1 again as new evidence, and generation 2 then refuses its own duplicate of it. The fix is
    not process-lifetime dedupe.
  - **the counter's matrix (§10)** — eviction does not decrement `retainedDurableEvents`; a duplicate does not increment
    it whether the original row is resident or evicted; a row naming no turn is admitted as an identity but is not
    counted, because it cannot be retrieved; `rebaseline()` resets it to zero; and a seq admitted in the replayed
    generation counts again.

Verification for this phase is reported as a **local** result: the repository has no CI runner, so `npm run verify` here
is a local test result and is not described as CI-verified anywhere.

## 10. Phase 9.3 — DSH 0.2.0-rc.2 compatibility

The normative runtime moved to `0.2.0-rc.2`, and the testing question this phase asks is narrow: does the wire evidence
the plugin consumes still have the shape the adapter expects? The audit that answers it is in `docs/DSH_API_NOTES.md`
§14 — fourteen upstream declarations compared by blob hash across the two reference commits, all identical, plus a read
of the installed runtime's own declarations. This section records the automated layer only.

- `test/dsh-020-contract.test.js` (17 tests, one file). It is deliberately **not** a second copy of the semantic suite:
  the metric arithmetic, the curve statistics and the Phase 7D lifecycle matrix are already covered, and
  `test/dsh-017-*.test.js` stays stamped with the 0.1.7 evidence it was recorded on. What this file pins is the contract
  surface, grouped as eight claims plus a metadata claim.
  - **the compatibility pin** — `peerDependencies['@deepseek-ai/dsh']` is exactly `0.2.0-rc.2`, it is the only peer, and
    it contains none of `^ ~ > < * || x X` or a hyphen range, so the declared runtime is the one this project has
    exercised and no range admits another. `version` is asserted to still be `0.1.1`, because the bump belongs to the
    release phase. The two reference commits are asserted as literals, so a future edit that changes one without
    re-running the comparison fails rather than passing silently.
  - **the envelope** — `seq` and `time` are read from the envelope rather than from `data`, proved by a counter-shape row
    that also carries a top-level `turn`; a row without `data` still normalizes, and a non-event is ignored.
  - **the boundaries** — `turn/start` and `turn/end` normalize with the reason read from `data.reason`; an unknown
    reason kind is reported as `statusKnown: false` and `errored` rather than as a known cause.
  - **the settlements** — `assistant/message` and `assistant/attempt` are both attempt settlements, distinguished by
    `settlementKind` and `surfaceCommitted` rather than by shape; a durable non-surface settlement is asserted **not** to
    be an abandonment; an interrupted message is asserted to keep its delivered prefix and to carry no undispatched
    tool-call delta.
  - **the tool plane** — `tool/call` supplies `callId`, `name` and the raw argument string; `tool/result` takes its
    identity from `message.toolCallId` and its failure flag from `message.isError`, and the structured `data.error` is
    read only alongside a failed message. A tool-role message with no readable identity is asserted `malformed` and
    closes nothing — `content[0].toolCallId` is never a fallback for a message that declares its own role.
  - **the transient row** — `assistant/live-chunk` keeps `time` on the row rather than on `data`, and a row without a
    string `attemptId` is refused.
  - **compact-stream timing** — `time0` plus the `dt[]` gaps reconstruct exact per-delta timestamps for all three run
    kinds, and the tool-call run's `id`/`name`/`args` survive. A run whose `dt` length breaks the
    `members.length - 1` invariant is reported (`bad-dt`) rather than resynchronized.
  - **the stream chunks** — a seven-record stream is asserted to still carry `reasoning-delta`, `text-delta`,
    `tool-call-delta`, `usage` and `finish`, with `block-start`/`block-end` surviving as raw records whose envelope time
    is preserved. The generated set is the delta set: five of the nine decoded chunks, with `firstTokenTimeMs` from the
    first reasoning fragment.
  - **in-stream usage** — a `usage` chunk inside a settlement's compact stream becomes the attempt's usage with source
    `in-stream-usage-chunk`, a durable `data.usage` supersedes it as `assistant-settlement`, and a stream with no usage
    at all still decodes and still yields samples — the shape-weight fallback is part of the design, not a compatibility
    failure.
  - **the window changes** — all four `SessionEventChange` kinds are routed: `append` is processed, `prepend` is counted
    and never adopted, `replace` clears the generation state, `settle-assistant` reaches the settlement path, and a stale
    revision is inert. The feed is asserted to record no issue across the four.
  - **the settle-assistant ambiguity** — a bare settle after a durable settlement is a retirement that publishes no
    second attempt outcome, and a bare settle with none is an abandonment; a settle carrying its entry is a direct
    settlement whose durable `seq` is admitted exactly once even when the same row later arrives by `append`.
  - **one end-to-end turn** — an idle session with an empty window shows no meter; an open turn with no generated token
    shows the first-response timer with `tps` absent rather than zero-forged; one and two reasoning deltas stay below the
    three-sample gate and show the counter; three deltas produce a finite phase-cumulative rate; and the settled card's
    `generatedTokens` equals the durable usage with `outputTps` **unavailable** rather than zero, because no text was
    generated. The diagnostics are asserted clean (`turnEndLookupMiss` 0, no feed issues).
  - **the cadence** — `DEFAULT_PRESENTATION_REFRESH_MS` is asserted to be 100, because the runtime moved and the Phase
    9.2 presentation contract did not.

Totals for this phase: **763 tests, 763 pass, 0 fail, 0 skipped, 0 todo** (746 before the phase). `npm run verify` runs
`scripts/verify-structure.mjs` and then the Node test runner over `test/*.test.js`; sanitization remains a separate gate
(`node scripts/verify-sanitization.mjs`) and reports no personal content with all structural evidence preserved.

The runtime half of the phase is **not** covered by this file and is not claimed to be. It was established by direct
observation on DSH `0.2.0-rc.2` — a live turn's DOM cadence, phase transitions, last live values and settled values, the
collapse/expand/curve interactions, a reload reconstruction and a session switch — and recorded in
`docs/IMPLEMENTATION_LOG.md` (Phase 9.3). A test cannot assert a browser's presentation cadence against a real host, so
no test pretends to.

Verification for this phase is likewise reported as a **local** result: the repository has no CI runner, so
`npm run verify` here is a local test result and is not described as CI-verified anywhere.

## 11. Phase 9.3.1 — background settlement presentation

The subject is a presentation outcome rather than a statistic: after a page reload, a turn that settles while the browser
tab is backgrounded must advance the completed card to the newest turn on its own, with no reload and no user action. A
statistical assertion cannot reach it, because the difference between "the card advanced" and "the card stayed" is not a
number — it is which settled turn the projection names. The deterministic layer therefore asserts *identities and
ordering*, and the browser layer, which the brief requires, is a trial protocol whose record is kept in
`docs/IMPLEMENTATION_LOG.md` (Phase 9.3.1).

- `test/background-settlement.test.js` (5 tests). The harness runs the real `SessionEventFeed` +
  `TurnTelemetryStore` + `LivePresenter` chain over the verified window semantics, with the presentation driven the way
  `MeterRoot` drives it: a 100 ms scheduler whose tick renders through `onRender`, and ingestion that never projects on
  its own. `settleInBackground` ingests a settlement and a terminal boundary with the ticker stopped and **asserts** that
  no projection happened in between, which is the structural equivalent of a throttled background tab — not a
  simulation of one, but the same sequence of calls the browser makes.
  - **the first projection after a background settlement** is asserted to be the newest settled turn, its kind to be
    `completed`, and its identity to be the newest turn's own — never the previous card. The durable reference
    (`store.latestSettled`) is asserted first, so a failure distinguishes ingestion from presentation.
  - **settlement before the next scheduled tick, then one tick** — the settlement and `turn/end` both arrive with the
    ticker stopped; exactly one scheduled render follows, and it renders the newest turn, agreeing with a direct
    projection.
  - **the completed-view identity follows the newest settled turn** — a new settled turn is a new view object with a new
    identity, and while nothing changes the settled view is memoized *by identity*, including across a moved clock.
  - **a settlement never observed live** — the `turnEndLookupMiss` path, where the durable settlement and the terminal
    boundary arrive for a turn whose opening row is outside the live tail; the card is still that turn, reconstructed
    from durable evidence.
  - **projection is what advances the card** — the inverse statement of the defect: the store holds the newest turn
    immediately, and only a projection can put it on screen. This is the assertion that makes the recorded observation a
    *presentation* question rather than an ingestion one.

The regression is required to be load-bearing, not merely green: with the controller's `turn/end` invalidation removed,
all five tests fail and the first projection returns the previous turn's card, which is the recorded symptom. That
experiment is part of the round's evidence and is recorded in the implementation log.

Totals after this phase: **768 tests, 768 pass, 0 fail, 0 skipped, 0 todo** (763 before the phase). `npm run verify` runs
`scripts/verify-structure.mjs` and then the Node test runner over `test/*.test.js`; sanitization remains a separate gate
(`node scripts/verify-sanitization.mjs`).

The browser half is a trial protocol, not a test, and is not claimed to be one: 11 trials of the recorded sequence on an
isolated DSH `0.2.0-rc.2` host, with the browser window minimized for the settlement and `requestAnimationFrame` gaps of
1000–1004 ms as the backgrounding record. `document.visibilityState` is **not** the criterion, because on this
workstation neither activating another tab nor raising a topmost cover window makes the page report `hidden`, whereas
minimizing stops the page being painted and serviced. Per-trial values are tabulated in
`docs/IMPLEMENTATION_LOG.md` (Phase 9.3.1 §3), including trial 11, which advances the card 2 → 3 rather than 1 → 2 so the
superseded card is one the store already held.

## 12. Phase 9.4 — TTFT boundary and episode TPS opening stabilization

Two defects in v0.1.2 were repaired at their causes, and both were first **reproduced on the released commit**. The
reproduction used a read-only `git archive` extraction of `58685f0` into
`E:\Projects\DSHarness\_recovery-backups\phase94-baseline\repo` — no checkout, reset or stash — and one
implementation-neutral harness run against both trees. That is what makes the new tests regression tests rather than
restatements of the current behaviour.

### 12.1 BUG A — the first-token boundary (§9)

`isTokenDelta({type:'tool-call-delta', name:'pwsh', argumentsDelta:''})` is `true` on DSH `0.2.0-rc.2` while
`classifyDelta` of the same chunk is `null`. On v0.1.2 the same chunk through `TurnTelemetryStore.acceptChunk` left
`record.firstTokenMs` at `null` and produced no sample; the fixed tree stamps `1200` and still produces no sample. The
released controller's `if (sample === null) return` is where the boundary died, which is why the live state machine shows
the identical `pending-first-token → streaming-output` transition in **both** trees when driven directly: the machine was
never the defect, the call that would have driven it was.

Coverage, in `test/ttft-boundary.test.js` and `test/phase94-regressions.test.js`:

- **A/B** a name-bearing empty-arguments delta freezes TTFT (live snapshot `ttftMs` and store `firstTokenMs`) and
  fabricates no mass (`acceptChunk` returns `null`, `samples` 0, `episodeSampleCount` 0, `tps` `null`);
- **B** the machine leaves `pending-first-token` rather than staying on first-response timing;
- **C/H** a tool call, its tool result and a retry never redefine the frozen instant — the released tree moved the turn's
  TTFT to the retry's delta (`900`), the fixed tree keeps `200`;
- **D** a tool-call delta with **no name** and empty arguments is not token evidence;
- **E/F** ordinary non-empty reasoning and text deltas are unchanged (controls, green on both trees by design);
- **G** a durable reconstruction carrying a name-bearing empty-arguments tool call reports the **same** instant as the
  live path (`1100` both), which v0.1.2 could not do because its adapter did not publish `firstTokenTimeMs` at all;
- the §9 shape table asserts `countsAsToken` / `contributesMagnitude` / the phase across nine chunk shapes and the
  `isTokenDelta`-vs-`classifyDelta` disagreement directly.

Two honest limits are recorded rather than smoothed over. The §9 shape table itself cannot be *executed* against v0.1.2
(the module exports no `tokenEvidence`, so the file fails to load there); its behavioural consequences are covered by the
tests above, which were. And D/E/F are guards rather than regressions, because the clauses say "ignored" and "unchanged" —
they are labelled `(control)` and are not counted as coverage.

### 12.2 BUG B — the episode TPS opening and the peak (§16)

| §16 case | fixture | v0.1.2 | fixed |
| --- | --- | --- | --- |
| CASE 1 | phase opens at 250 ms | `2000` | unavailable (episode never reaches 3 samples) |
| CASE 2 | phase opens at 299 ms (1 ms remainder) | **`100 000`** | see CASE 6 below |
| CASE 3 | three samples share one instant, episode ends inside the horizon | `600`, anchor published as `0` | `null`, reasons `opening-anchor` / `below-elapsed-horizon` |
| CASE 4 | three samples inside 50 ms, episode ends inside the horizon | `600` | `null` |
| CASE 5 | three samples over ≥100 ms | `200` | `150` (the episode's own first eligible vertex) |
| CASE 6 | heavy first delta after an off-grid transition at 299 ms | **`500 000`** | `2000` (600 tokens / 300 ms, 3 samples) |
| CASE 7 | one sample / two samples | `4000` / `3000` | `null` |

**CASE 3/4 needed a reading decision, and the reading is stated rather than assumed.** "Three samples inside 50 ms" is
only *unavailable* when the episode cannot reach the horizon; if the episode continues past it, its first ladder vertex at
exactly `elapsedMs = 100` with three contributing samples is publishable **by §10's own constants**, and publishing `300`
for a 30-token fixture there is correct rather than a leak. The tests therefore settle the attempt inside the horizon, and
the horizon-reaching form is kept beside them as an explicitly-labelled **control** — v0.1.2 agrees with the fixed tree on
it, so it is not claimed as a regression.

**CASE 6 is also the preservation test**, which is what stops the repair from being over-broad. Every quantity that must
not move is asserted equal across the two trees: sample-weight sum `870`, attempt tokens `870`, `generatedTokens` /
`observedGeneratedTokens` `null` / `0`, `outputTps` `1247.920133111481`, `reasoningTps` `401.33779264214047`,
`ttftMs` `0`, `attemptCount` `1`. Only the invalid peak changes. The winning vertex's provenance names its own evidence —
attempt, phase, episode origin, point instant, elapsed, sample count, mass, calibration quality and contributing sample
timestamps — so a future four- or five-figure peak can be audited instead of guessed about, and it reaches no renderer.

`test/curve-rate-publication.test.js` additionally freezes the two former spikes (`100 tokens / 50 ms` and
`200 tokens / 1 ms`) as absent, and asserts that the peak is `null` — never `0` — when nothing is publishable, with the
card rendering `峰值 —`.

### 12.3 The renderer consequence of `null`-instead-of-`0`

Changing a withheld vertex from `0` to `null` moved work into the renderer, and the recovered round had not carried it
through. Two properties are asserted here:

- a zero-width attempt's single vertex is drawn as a point marker carrying `data-tps="null"` on the axis floor, rather
  than being dropped and leaving the chart unable to show that the attempt happened. v0.1.2 rendered the same marker with
  `data-tps="0"`, so the assertion is a genuine before/after;
- `renderBudget.elementPoints` and `curveViewModel.renderElementPoints` are one quantity and agree: `lineVertices` counts
  the **measured** vertices the SVG receives (on a dense fixture `480` allocated versus `240` emitted), while
  `curve.drawnPoints` keeps its distinct meaning as the allocator's own count. The equality is asserted as strict
  equality over measured vertices, never weakened to `<=`.

### 12.4 Real-machine acceptance — OBSERVED (Phase 9.4.1, 2026-10-01)

The isolated-profile protocol was executed end to end in a **new** disposable profile `tpm-phase941-runtime` created from
the shipped web template via `--from-default-profile` (bundle list only; nothing read from or copied out of any protected
profile), its own port `19388`, the development checkout linked into it only, no compatibility exemption at peer
`0.2.0-rc.2`, and the plugin confirmed loaded from the isolated profile's own `__DSH_BOOT__`. The route that unblocked it
is the already-authorized `command-goat` provider selecting an existing shared credential **by reference**
(`apiKeyEnv: COMMAND_GOAT_API_KEY`) — the shared store was read, never written, and no secret was read, printed or
persisted.

Six real turns were run through `dsh 0.2.0-rc.2` in a throwaway headless Chrome driven over CDP against port `19388`
only, asserted before navigation:

- **General runtime — PASS.** Idle renders no meter; the live pill appears at `t+219 ms` on `首响应计时`; it freezes to
  `思考 ≈67.0 tokens/s` at `t+10245 ms`; settlement produces the collapsed card
  `已完成 · 思考 ≈109 tokens/s · 输出 ≈318 tokens/s · 838 tokens · 首响应 10.03 s`; expanding shows the four cells and the
  curve (`峰值 ≈318 tokens/s`, axis `500`); a `Page.reload` reconstructs the card with a byte-identical progress string.
  **Zero** console errors.
- **Bug A — the exact name-only boundary WAS observed.** Three tool-first trials produced, as the first chunk
  `isTokenDelta` accepts, a name-bearing `tool-call-delta` with `argumentsDelta: ""` — preceded only by a
  `block-start(blockType: "tool-call")`. TTFT froze at that instant (`ttftMs 4376` against a boundary 4381 ms after send),
  the UI left `首响应计时`, the tool ran (`read`), the follow-up attempt answered, and the next turn worked. That turn
  published **no** peak: `peakTps: null`, every vertex withheld by name, `峰值 —`, no fabricated dot. (A fourth tool-first
  trial was reasoning-first and is counted as an early-tool turn, not a boundary observation.)
- **Bug B — real provenance.** On a 3,644-token, three-attempt turn the published peak `453` carries `elapsedMs 100`,
  `episodeSampleCount 15`, `phase reasoning`, `temporalAllocationMode total-anchored`, `sampleQuality calibrated` and
  `contributingSampleTimes` of exactly 15 entries. No opening anchor won and no clamp exists. Peak/phase-average ratios
  were `1.00`, `2.39` and `0.92` — none near the `10 ×` escalation threshold.
- **§13 invariant scan — 0 violations** over **264 published** and **11 withheld** vertices: no published vertex used
  `elapsed < 100 ms` or `episodeSampleCount < 3`, and every withheld vertex named its reason.

Containment: the operator's `web` instance (PID `21088`, port `3080`) and desktop instance (PID `46308`, port `19387`)
were never a test target, never restarted, and `profiles\web` shows **0 files written after task start**. `profiles\desktop`
did change during the window, and the change is attributed rather than attributed away: its own plugin-manager log records
two rejected `dsh-mail-notify@0.4.0` installs (both rolled back) plus a GUI-settings rewrite of `cordis.patch.yml` — none
of which any command this task issued could produce. One blank session landed in the shared `dsh-mail-notify` workspace
bucket before the composer's workspace chip was moved, and is left in place. `docs/IMPLEMENTATION_LOG.md` (Phase 9.4.1)
carries the full measurements.

### 12.5 Totals

**805 tests, 805 pass, 0 fail, 0 skipped, 0 todo** (768 before Phase 9.4, 804 before this round). `npm run verify` runs
`scripts/verify-structure.mjs` and then the Node test runner over `test/*.test.js`; sanitization remains a separate gate
(`node scripts/verify-sanitization.mjs`), and it passes. `git diff --check` is clean. No test was skipped, todo'd or
deleted, and no tolerance was widened, to reach that state.

## 13. Phase 9.4.2 — boundary-only TTFT evidence vs the TPS episode clock

One defect, one file. `LiveMeter.observeTokenBoundary` opened the phase episode **at the boundary instant** for a
name-bearing empty-arguments `tool-call-delta`, so the live pill's phase-cumulative denominator ran from a TTFT instant
the completed curve never sees (the curve opens an episode at its first sample) and `episodeUsageBaseline` was attached to
that same wrong instant. `src/core/live-metrics.js` now establishes only the TTFT boundary and the phase identity there;
`acceptSample` remains the sole opener of an episode. `src/core/curve.js`, `src/core/time-axis.js`, the DSH adapter and
the publication gates were **not** modified.

### 13.1 The fixture, and the pre-fix measurement

```text
turn start  t = 0
boundary    t = 100   name-bearing tool-call-delta, argumentsDelta "", phase fallback output
samples     t = 200 / 250 / 300   output, 100 tokens each
```

Measured through the real path (`TurnTelemetryStore` → `liveSnapshot` → `endTurn().curve`) on baseline `6506bd0` versus
the fixed tree:

| quantity | `6506bd0` live | `6506bd0` curve | fixed live | fixed curve |
| --- | --- | --- | --- | --- |
| episode origin | `100` | `200` | `200` | `200` |
| elapsed at `t = 300` | `200` | `100` | `100` | `100` |
| mass / sample count | `300` / `3` | `300` / `3` | `300` / `3` | `300` / `3` |
| TPS at `t = 300` | `1500` | `3000` | `3000` | `3000` |

The curve's coordinate is attempt-local (its zero is the first generated sample, `src/core/time-axis.js`); the test
translates a vertex through that documented zero before comparing, and compares the two halves as equalities rather than
as two coincidences.

### 13.2 The matrix — `test/boundary-episode-origin.test.js`

Every case drives the store/live/curve path or the real controller; no test constructs or mutates a `LiveMeter`.

| case | proves | `6506bd0` | fixed |
| --- | --- | --- | --- |
| A — pure boundary | TTFT freezes, the phase identity is `output`, `episodeElapsedMs` is `null`, mass `0`, count `0`, no rate, and a boundary-only turn has no publishable vertex and a `null` peak | FAIL | PASS |
| B — the fixture above | live and completed use one origin: `200` / `100 ms` / `3` / `300` / `3000`, asserted as four equalities plus the absolute origin | FAIL | PASS |
| C — reasoning → boundary-only output → output | phase transition immediate, reasoning episode not bridged (`3000`, not `6000`), no output clock and no guard before the first output magnitude sample | FAIL | PASS |
| C2 — first-output guard | the guard is anchored at the output episode's own origin: `950 ms` after the first output sample it still stands in; one millisecond past `FIRST_OUTPUT_GUARD_MS` it is gone | FAIL | PASS |
| D — same-phase boundary inside an active episode | the origin (`200`), numerator (`300`) and sample count (`3`) are untouched, and live and curve still agree after it | PASS (control) | PASS |
| E1 — usage known after the boundary | the first magnitude sample takes the baseline the provider contract needs (`{output, 600}`), and the numerator is a counter delta (`30`) over the episode's own `100 ms` | FAIL | PASS |
| E2 — usage known before the boundary | the pre-boundary counter (`600`) is not the baseline; the magnitude origin takes `660`, and the numerator (`10`) is measured from the episode's own origin | FAIL | PASS |
| E3 — no counters when the episode opened | unchanged policy: a usage chunk inside an episode still never explains it retroactively (shape mass kept) | PASS (control) | PASS |
| D2 — baseline across a same-phase boundary | an episode's provider baseline (`{output, 700}`), origin and counter delta survive a same-phase boundary: `50` counter tokens over `200 ms` → `250` | PASS (control) | PASS |
| F — retry / new attempt | the episode, numerator, count and baseline reset; a boundary in the new attempt opens no clock; turn TTFT stays frozen at `100` | FAIL | PASS |
| G — Phase 9.4 gates | `MIN_RATE_SAMPLES = 3`, `MIN_RATE_ELAPSED_MS = 100`, and the §16 CASE 6 `299 ms` fixture still peaks at `2000` with no sub-`100 ms` denominator | PASS (control) | PASS |
| H — unavailable peak | `curve.peakTps` `null`, `peak.value` `null`, `peak.display` `—`, no fabricated marker | PASS (control) | PASS |
| A/C on the live path | the pill leaves `首响应计时` at the boundary, never returns, and warms from the first magnitude sample rather than 100 ms earlier; its absent episode clock is `null`, not a measured `0` | FAIL | PASS |
| pill stopwatch slots | source-level guard: no `?? 0` coercion of `counterMs`/`waitMs` at the three stopwatch slots, so an absent duration cannot print as `0.00 s` | FAIL | PASS |
| I — recorded limitation | a `reasoning` delta after a boundary-only `output` delta still splits the live episode (origin `150`, `3000`) while the curve merges the run (origin `0`, `600 tokens over 250 ms`, `2400`); pre-existing, belongs to the phase fallback, deliberately not repaired | PASS (characterization) | PASS |
| absent stopwatch duration (`test/live-format.test.js`) | `stopwatchParts(null)` is `{ '—', null }` and `stopwatchParts(0)` stays `{ '0.00', 's' }`: absent evidence is not a measured zero | PASS | PASS |

The matrix was run against a read-only `git worktree` at `6506bd0` (created and removed for the measurement; the working
tree was never reset, stashed or checked out): **15 tests, 6 pass, 9 fail** on the baseline and **15 pass, 0 fail** on the
fixed tree. Six baseline-passing cases are labelled in the file as controls or as a characterization (D, D2, E3, G, H, I);
they are not counted as coverage of this defect.

### 13.4 Independent review response (second change set)

An independent adversarial source review of the first change set confirmed the three-line repair, the untouched curve and
the absence of any prohibited technique, and raised three findings. Two are corrections, one is a repair:

- **a surviving divergence of a different class is recorded, not repaired** — CASE I above. It belongs to the boundary's
  phase fallback (`output` is the declared phase for a chunk `classifyDelta` cannot attribute), and repairing it would
  require the declared phase to be provisional until a sample confirms it, which `METRICS_SPEC.md` §4/§5 do not provide
  for. It is frozen as a labelled characterization that passes on both trees, and stated as such in §6 of that file.
- **the provider-counter claim was overstated** — the counter is a step function sampled at usage-chunk cadence, so its
  delta window can start before the episode origin and end before the clock does, by up to one usage interval at each end.
  The code was already correct; the wording in `METRICS_SPEC.md` §4/§6.1 and in the E1/E2 messages was not, and now states
  the invariant as "the baseline shares the episode's origin".
- **a fabricated `0.00 s` episode counter is repaired** — with no episode open the pill printed a measured-looking zero
  for a duration that does not exist, against this project's own rule. The presenter now publishes `null` and the three
  stopwatch slots pass the duration to `stopwatchParts` uncoerced, which already renders `{ '—', null }`. A measured zero
  (`stopwatchParts(0)`) still renders `0.00 s`. One glyph in one state; no visual redesign, and `src/core/live-metrics.js`
  is unchanged by this round.

Coverage added by the review response: CASE D2 (baseline across a same-phase boundary), the labelled `publishedRate`
null-origin hazard in CASE C, the latent no-episode `episodeMass()` in CASE A, the trace-evidence parity translation in
CASE B (replacing an assertion that reduced to a fixture constant), the pill call-site source guard, and the
`test/live-format.test.js` absent-stopwatch case.

### 13.5 Totals

**821 tests, 821 pass, 0 fail, 0 skipped, 0 todo** (805 before this phase). `npm run verify` passes,
`node scripts/verify-sanitization.mjs` passes, `git diff --check` is clean, `client.js` and `lib/client.js` are
byte-identical, and `package.json` remains version `0.1.2` with peer `@deepseek-ai/dsh` `0.2.0-rc.2`. No test was
skipped, todo'd or deleted, and no tolerance was widened, to reach that state. No real-machine run was performed in this
phase, by design.

## 14. Phase 9.4.3 �� non-magnitude phase boundary / completed-curve cut parity

One defect, one missing record. The live meter closed the outgoing phase episode at a non-magnitude boundary
(Phase 9.4.2) and the completed curve had no evidence of that boundary at all, so it continued the outgoing episode
until the incoming phase's first magnitude sample. This section states what is deterministic, what was measured on
which baseline, and which claims are cross-path rather than single-path.

### 14.1 The principal fixture and the pre-fix measurement

```text
turn start  t = 0

reasoning sample  t = 0     mass 100
reasoning sample  t = 50    mass 100
reasoning sample  t = 100   mass 100

name-bearing empty-args tool-call boundary   t = 120   tokenEvidence.phase = output, contributesMagnitude = false

output sample     t = 300   mass 100
output sample     t = 350   mass 100
output sample     t = 400   mass 100
```

Driven through `TurnTelemetryStore -> liveSnapshot -> settleAttempt -> endTurn -> completed curve` on baseline
`68ba746` and on the fixed tree:

| quantity | `68ba746` live | `68ba746` curve | fixed live | fixed curve |
| --- | --- | --- | --- | --- |
| state at `t = 120` / `t = 200` | `output`, `tps null`, no episode clock | reasoning episode still in force | `output`, `tps null`, no episode clock | no vertex at `200` at all |
| vertex at `t = 200` | �� | `activePhase reasoning`, origin `0`, elapsed `200`, count `3`, mass `300`, `tps 1500` | �� | does not exist |
| reasoning episode end | �� | `300` (the output episode's first sample) | �� | `120` (the cut) |
| reasoning vertices | �� | `0 / 100 / 200 / 300` | �� | `0 / 100 / 120` (`tps 3000 / 2500` at the last two) |
| output episode origin | `300` | `300` | `300` | `300` |
| runs | �� | reasoning `[0..2]`, output `[2..4]` (shared seam) | �� | reasoning `[0..2]`, output `[3..4]` (a hole) |
| summary | �� | `reasoningMs 300`, `reasoningTps 1000` | �� | `reasoningMs 120`, `reasoningTps 2500` |
| peak | �� | `3000` | �� | `3000` |

The pre-fix trace is a measurement, not an inference: `dev/scratch/phase943-probe.mjs` prints it and the output is
recorded in the phase's implementation-log entry. `test/phase-cut-parity.test.js` was written and executed **before**
any source change, and the final version of the file was re-run against a clean worktree at `68ba746` after the change
was committed: **6 of its 8 cases fail there** (A, B, C, D, E, G). CASE F (the provider baseline) and CASE H (the
publication-gate and no-fabrication scan) are labelled controls that pass on both trees, and CASE D's baseline failure
is its `trace.cuts` evidence assertion — its geometry assertions hold on both trees, which is what the case controls.

### 14.2 The matrix

| case | fixture | proves | `68ba746` | fixed |
| --- | --- | --- | --- | --- |
| A | reasoning `0/50/100`, boundary `120`, output `300/350/400` | the cut closes reasoning at `120` and opens no output clock: no reasoning vertex after `120`, nothing sampled in `120 -> 300`, output origin `300`, disjoint runs, `reasoningMs 120` | FAIL | PASS |
| B | boundary `100`, output `200/250/300` | a cut before the first magnitude sample owns no coordinate: `durationMs 100`, `trace.cuts []`, `segments[].preOriginCutCount 1`, TTFT `100`, output origin `200` | FAIL | PASS |
| C | output `200/250/300`, same-phase boundary `350`, output `400/450` | the boundary is recorded evidence and cuts nothing: one run, one episode, origin `200`, count `5`, mass `700`, `tps 2800` | FAIL | PASS |
| D | reasoning `0/50/100` -> output `150/200/250` | the ordinary magnitude transition is unchanged: the runs still share their seam, the outgoing episode still ends at the transition sample | FAIL (only the new `cuts` field) | PASS |
| E | attempt `a1` with a boundary + tool + retry `a2` | no cut leaks across an attempt boundary: `a1.cuts` present, `a2.cuts []`, the retry opens its own episode | FAIL | PASS |
| F | usage chunks around a boundary | the incoming episode takes its provider baseline at its **first magnitude sample**, not at the cut (`{phase: output, counter: 600}`, mass `30`, `tps 300`) | PASS (control) | PASS |
| G | the principal fixture, encoded as a compact `AssistantStreamRecord[]` | the durable reconstruction recovers the identical cut, gap, vertices, runs and summary through `materializeReconstructedTurn` | FAIL | PASS |
| H | the principal fixture | the publication gates are untouched (`MIN_RATE_SAMPLES 3`, `MIN_RATE_ELAPSED_MS 100`), every published vertex names its episode, no `0` is fabricated, no zero-token sample exists, the trace integral is the six real samples, and the peak-bearing vertex is inside a drawn run | PASS (control) | PASS |
| I | reasoning `0/50/100`, boundary `120`, reasoning `150/200/250` | the phase-reversion class is **resolved** by the same evidence: the curve splits where the live meter splits and the two halves agree on origin, count, mass and rate | characterized (old divergence asserted) | PASS (new equalities asserted) |

CASE I is the one behavioural change beyond the principal defect, and it is deliberate: the earlier record asserted
`live.tps !== curve.tps` for that fixture (`3000` against the merged episode's `2400`) because the curve could not see
the boundary. It can now, so both semantics are written into the same test �� the old measurement as the "before" half of
its own record, the new equalities as the contract �� and the boundary's declared phase remains a documented fallback.
The class was not deleted, renamed away or weakened.

### 14.3 Cross-path (durable/reload) coverage

`test/helpers/equivalence.js` now passes `compressed.cuts` into `attemptTraces` and compares `attempts.phaseCuts`
between the two planes in `compareTuples`. The harness therefore models the shipped curve instead of the pre-fix
geometry, and every recorded fixture is compared for cut evidence as well as for token totals, phase segmentation,
chart coordinates and peak. Measured across `fixtures/dsh-turns/*` on the fixed tree:

| fixture | live cuts | durable cuts | reasoning denominator (without -> with) |
| --- | --- | --- | --- |
| `t1-reasoning-tool-reasoning` | 2 | 2 | `null -> null` (the cuts sit in output-only attempts) |
| `t2-pwsh-write-edit` | 3 | 3 | step 1: `1251 -> 1250` ms |
| `t3-interrupted-mid-reasoning` | 0 | 0 | `4041 -> 4041` ms |
| `t4-reasoning-tool-deepseek-official` | 1 | 1 | step 1: `1463 -> 1425` ms (`��50.6` -> `��51.9`) |
| `t5-reasoning-text-deepseek-official` | 0 | 0 | `26296 -> 26296` ms |
| `t6-tool-only-deepseek-official` | 3 | 3 | step 1: `533 -> 504` ms |
| `t7-failing-pwsh-deepseek-official` | 1 | 1 | step 1: `473 -> 449` ms |
| `t8-reasoning-no-retry-deepseek-official` | 0 | 0 | `697 -> 697` ms |

The two planes agree on every row, and `reasoningTps` is identical between them for every fixture. Three fixtures
contain no boundary at all and are bit-for-bit unchanged, which is the non-regression half of the same table.

### 14.4 Totals

**838 tests, 838 pass, 0 fail, 0 skipped, 0 todo** (821 before this phase). Baseline evidence: against a clean worktree
at `68ba746`, the new suite alone is **6 fail / 2 pass** — the two passes are the labelled CASE F and CASE H controls.
`npm run verify` runs
`scripts/verify-structure.mjs` and then the Node test runner over `test/*.test.js`; sanitization remains a separate gate
(`node scripts/verify-sanitization.mjs`) and passes. `git diff --check` is clean. No test was skipped, todo'd or
deleted, and no tolerance was widened, to reach that state. No runtime acceptance was performed: Phase 9.4.3 is
deterministic/source-only, and no DSH profile was started, stopped, attached to, installed into, modified or deleted.

## 15. Phase 9.4.4 — durable settlement reconciliation of a partial live attempt

### 15.1 The mixed plane, and the pre-fix measurement

Phase 9.4.3 covered the two **pure** planes. A reload produces the mixed one: a partial transient attempt is already
open, and the authoritative durable settlement then arrives carrying the attempt's complete decoded stream. On
`eb45c26` the controller correlated the two correctly and then called `store.settleAttempt(attempt, …)` alone, ignoring
`event.decoded`, so the attempt kept only the tail its replacement window could still see.

Every case in `test/settlement-reconciliation.test.js` is driven through the real wire —
`SessionEventFeed` → live controller → `TurnTelemetryStore` — with a real
`SessionEventChange{kind:'replace'}` rebaseline rather than a hand-built partial store. The principal fixture:

```text
turn start  t = 0
reasoning sample 0 / 50 / 100        mass 100 each
name-bearing empty-args tool-call boundary  t = 120   declares output, contributesMagnitude false
output sample 300 / 350 / 400        mass 100 each
settlement  t = 400                  assistant/message carrying the whole compact stream

generation 1  the complete window
replace       only the post-cut transient tail: output 300 / 350 / 400
append        the durable assistant/message with the complete stream
append        turn/end
```

| quantity | `eb45c26` | fixed |
| --- | --- | --- |
| `attempt.samples` | `300/350/400` (3 of 6) | `0/50/100` reasoning + `300/350/400` output (6) |
| `attempt.phaseCuts` | `[]` | `[{timeMs 120, phase output}]` |
| `record.firstTokenMs` | `300` | `0` |
| `curve.durationMs` | `100` | `400` |
| `curve.segments` | `[0..100]/3` | `[0..400]/6` |
| `curve.cuts` | `[]` | `[{120, local 120, output}]` |
| `reasoningMs` / `reasoningTps` | `0` / `null` | `120` / `2500` |
| `outputMs` / `outputTps` | `100` / `3000` | `100` / `3000` |
| curve vertices (`localMs = tps`) | `0 = null`, `100 = 3000` | `0 = null`, `100 = 3000`, `120 = 2500`, `300 = null`, `400 = 3000` |
| visual runs | `output[0..1] 0–100` | `reasoning[0..2] 0–120`, `output[3..4] 300–400` |
| `peakTps` | `3000` | `3000` |
| `ttftMs` | `null` (no `turn/start` in the replacement window, and none fabricated) | `null`; `0` when the durable `turn/start` is in the window |

The full-evidence control — the same wire, the same settlement and the same `turn/end`, with the complete stream in the
replacement generation — reads `6 samples`, `phaseCuts [{120, output}]`, `durationMs 400`, `reasoningMs 120`,
`reasoningTps 2500`, `outputMs 100`, `outputTps 3000`, `peakTps 3000` and the two disjoint runs; the pure-durable
`materializeReconstructedTurn` of the same rows reads the same. `paritySurface()` compares all of it, projecting out
reconstruction-local attempt identity explicitly.

`test/settlement-reconciliation.test.js` was written and executed **before** any source change and re-run against a
clean worktree at `eb45c26` afterwards: **13 of its 15 cases fail there**. The two that pass on both trees are labelled
controls — CASE E (pure durable, already correct after Phase 9.4.3) and CASE F (pure live, untouched by this phase).

### 15.2 The matrix

| case | scenario | proves | `eb45c26` | fixed |
| --- | --- | --- | --- | --- |
| PRINCIPAL | reload after the cut, tail-only replacement window, full durable settlement | the settlement completes the correlated attempt; the whole surface equals the full-evidence reference | FAIL | PASS |
| PRINCIPAL+start | the same with a durable `turn/start` in the window | `ttftMs 0`, identical to the full-evidence path | FAIL | PASS |
| PRINCIPAL/durable | the mixed trace against `materializeReconstructedTurn` | the mixed and purely durable planes agree | FAIL | PASS |
| A | the transient tail overlaps the durable stream, no cut | no duplicate sample or token; one continuous reasoning episode (`reasoningMs 300`); the documented shared transition seam | FAIL | PASS |
| B | the boundary is visible in both planes | exactly one cut on the attempt and on the trace; the boundary contributes no sample | FAIL | PASS |
| C | the boundary existed only before the reload | the cut is restored; `reasoningMs 120`, `outputMs 100`, `reasoningTps 2500` | FAIL | PASS |
| D | pre-reload magnitude restored | the curve is drawn from 6 samples / 600 shape tokens; `peakTps 3000`; axes unchanged | FAIL | PASS |
| E | pure durable control | unchanged: `settlement:2`, 6 samples, 1 cut, `startMs null`, `firstTokenMs 0`, `ttftMs null` | PASS | PASS |
| F | pure live control | unchanged: `settlementKind none`, 6 samples, 1 cut, `ttftMs 0`, absent terminal duration (`outputMs 0`, `outputTps null`) | PASS | PASS |
| G | retry chain: two attempts in one `(turn, step)` | each settlement reconciles only its own attempt; no merge; a second reconciliation does not rewrite the first | FAIL | PASS |
| H | ambiguous correlation, and one settlement that is provable | the correlation refuses; the durable row is restored as its own `durable:6` attempt; neither candidate is written | FAIL | PASS |
| §9 | the actual `replace` rebaseline | old generation cleared (a new record object, the old one left at 6 samples), new generation adopts mid-turn with 3 tail samples and no cut, the settlement reconciles, `turn/end` publishes the full card | FAIL | PASS |
| §5 | the live meter | the live snapshot is byte-for-byte unchanged by the reconciliation | FAIL | PASS |
| §6 | one-way first token | a later durable first token does not move a recorded one forward, while the stream-derived evidence is still replaced; `ttftMs` stays `null` | FAIL | PASS |
| — | incomplete decode | a stream that lost a record replaces nothing, the settlement is still recorded, the refusal is counted | FAIL | PASS |

### 15.3 Diagnostics

`diagnostics(sessionId).counters` gains `settlementStreamsReconciled` and `settlementStreamsUncorrelated`, incremented
where the decision is made. CASE H asserts `1 / 1` (one settlement proved its attempt by identity, one could not be
proven and took the durable-restoration path); the incomplete-decode case asserts `0 / 1`.

### 15.4 Totals

**853 tests, 853 pass, 0 fail, 0 skipped, 0 todo** (838 before this phase) — **15 new deterministic tests**, all in
`test/settlement-reconciliation.test.js`. No test was skipped, todo'd or deleted, and no tolerance was widened. The
Phase 9.4.3 regression set re-runs green at 78/78. `npm run verify` runs `scripts/verify-structure.mjs` and then the
Node test runner over `test/*.test.js`; sanitization remains a separate gate (`node scripts/verify-sanitization.mjs`)
and passes; `git diff --check` is clean. No runtime acceptance was performed: Phase 9.4.4 is deterministic/source-only,
and no DSH profile was started, stopped, attached to, installed into, modified or deleted.
