# Task Breakdown

Do the phases in order. A later phase may refine an earlier one, but no phase is complete merely because the UI "looks right".

## Phase 0 — Local DSH reconnaissance

- [x] Record `dsh --version` and active `web` profile details. → `0.1.5-rc.2`, profile `web`
- [x] Run `dsh plugin --profile web list --depth 2`. → exit 0, 109 packages
- [x] Inspect the composed web config. → 704 lines on stdout; the command then aborts on two pre-existing patch entries targeting absent rows (recorded in `IMPLEMENTATION_LOG.md`)
- [x] Inspect the live `conversation.composer.dock` slot contract and occupants if local tooling exposes it. → the installed `cordis_inspect` has no `what:"client"`; the generated `CLIENT_SLOT_API` in the shipped bundle was used instead, and the missing live `slots.snapshot()` query is recorded as a residual risk
- [x] Locate the local installed APIs corresponding to `agent/assistant-stream`, transient assistant chunks, turn boundaries, tool call/result, assistant attempt/retry and token usage.
- [x] Decide whether telemetry aggregation will live host-side, client-side, or split; document the reason. → client-side read model over `ctx.sessions.binding(id).eventSource`; host projection rejected on evidence
- [x] Record all API differences from `DSH_API_NOTES.md` in `IMPLEMENTATION_LOG.md`.

Acceptance gate: no production integration code is written against an unverified API assumption.

## Phase 1 — Pure metric engine

- [x] Complete/adjust normalized data types.
- [x] Implement deterministic phase-duration attribution without overlap.
- [x] Implement 1-second rolling live meter.
- [x] Ensure meter resets at every new model attempt.
- [x] Implement exact turn aggregation from provider usage.
- [x] Implement reasoning/output split quality handling.
- [x] Implement tool work time + wall-union time.
- [x] Implement compressed attempt concatenation time axis.
- [x] Implement calibrated curve allocation and rolling series.
- [x] Add edge-case tests for one-delta attempts, simultaneous timestamps, zero duration, missing usage and missing reasoningTokens.

Acceptance gate: pure tests pass without DSH runtime. → `npm run verify` exit 0, 110/110 tests pass, no DSH import anywhere in `src/core`, `src/host` or `src/client`.

## Phase 2 — DSH telemetry normalization

- [x] Start a `TurnRecord` at durable turn start. → `src/dsh/durable-path.js` (`turn/start.time`), `src/dsh/live-path.js`
- [x] Start/reset `AttemptRecord` from verified assistant-stream attempt start. → `LiveTurnAccumulator.acceptStreamFrame('start')`; `src/core` `LiveMeter.beginAttempt` resets the window per `attemptId`
- [x] Capture timestamped non-empty reasoning/text/tool-call deltas. → `src/dsh/adapter.js` `normalizeLiveChunk` / `normalizeStreamFrame` + `src/core/token-allocation.js`
- [x] Capture provider usage without double-counting reasoningTokens. → two carriers (`assistant/message.usage`, in-stream `usage` chunk), one preference order, `usageSource` recorded; `nonReasoningTokens = outputTokens - reasoningTokens`
- [x] Capture attempt end/abandon/retry semantics. → transient `end` frame `outcome.kind` (`committed`/`abandoned`) + `outcome.seq` linking to the durable settlement; `settlementStatus`
- [x] Pair tool call/result by call id, including nested/parallel calls if exposed. → `tool/call` ↔ `tool/result` by `callId`; unmatched calls and results both reported, never guessed
- [x] Close turn on exact durable turn end and map status to completed/interrupted/errored. → `turnEndStatus` implements the verified `TurnEndReasonMap`, including `max-tokens` → `completed` with a note and an unknown-kind fallback
- [x] Reconstruct the latest completed turn after reload from durable evidence where possible. → `reconstructFromDurable` decodes every settlement's compact stream strictly; equivalence with the live path is asserted per fixture
- [x] Ensure state is keyed by session + turn, not global. → `TurnTelemetryStore` keyed by `turnKey(sessionId, turn)`, one `LiveMeter` per session

Acceptance gate: recorded normalized fixtures from real DSH turns match the expected event chronology. → met; see `docs/IMPLEMENTATION_LOG.md` §2. Nine fixtures (five recorded, four declared synthetic derivatives) reproduce every assertion offline.


## Phase 3 — Live Client Integration & Live Meter UI (frozen scope)

Data path (no new host channel, no projection, no DOM scraping):

```text
ctx.sessions.binding(id).eventSource -> src/dsh/client-feed (window wire -> normalized)
  -> TurnTelemetryStore + per-session LivePresenter -> React LiveMeter (throttled)
```

- [x] Preflight semantic audit A: `assistant/attempt` re-modeled as a durable non-surface settlement; `abandoned`
      reserved for transient `end.outcome.kind === 'abandoned'`; `llm/retry` proves `retried`; unknown stays unknown.
      → `settlementKind` / `surfaceCommitted` / `attemptOutcome` on every `AttemptRecord` (METRICS_SPEC §13.1)
- [x] Preflight semantic audit B: `reasoningTokens === 0` + non-empty reasoning stream consistency guard;
      `phaseSplitQuality !== exact`, `consistencyIssues` + quality note (METRICS_SPEC §11.6)
- [x] Warm-up contract documented and tested (METRICS_SPEC §6)
- [x] Live tool timer = current continuous tool-activity episode, documented (METRICS_SPEC §5)
- [x] Explicit eight-state UI machine: inactive / pending-first-token / streaming-reasoning / streaming-output /
      tool-running / waiting-model / transition / settled, with written entry/exit conditions
- [x] Pending state displays the running first-response stopwatch (turn TTFT freezes once; later calls never reopen it)
- [x] Streaming states display the current trailing-1s TPS of the active attempt — never a turn/step average —
      always with `≈`; tool-call arguments count as output
- [x] Tool state displays the episode wall timer and tool label(s); no stale TPS and no forced `0 tokens/s`
- [x] Waiting/transition stages render neutral text with no TPS field
- [x] Presentation refresh: single ~200 ms ticker per mounted meter; projected view stored as state so parent
      re-renders cannot bypass the throttle; deltas never dropped; timers destroyed on hide/unmount/HMR
- [x] Session/turn isolation: per-session feed + machine + store keys; idempotent attach (one eventSource
      subscription per session); dispose unsubscribes everything
- [x] `conversation.composer.dock` mount under the independent id `turn-performance-meter` (`order: -10`), native
      `stats` occupant untouched
- [x] English + Simplified Chinese locale strings via `ctx.locale`; scoped CSS with host `--dsw-*` tokens, plugin
      accent with `body[data-ds-dark-theme]` override, `prefers-reduced-motion` honored, no fixed rem widths
- [x] Debug localStorage placeholder (`dsh-turn-performance-meter.debugPlaceholder`) removed; optional debug flag
      `dsh-turn-performance-meter.debug` added (default off, lifecycle logs only)
- [x] Verify light/dark theme (accent computed in both modes live) and real browser states (pending / streaming /
      tool-running / waiting / settled) → `dev/screenshots/phase3/` + timestamped DOM captures in
      `IMPLEMENTATION_LOG.md` §3.9
- [x] Build pipeline: deterministic `scripts/bundle-client.mjs` → `client.js` (+ `lib/client.js` mirror for the
      local injector); `verify-structure.mjs` fails on a stale bundle

Acceptance gate: `npm run verify` exit 0 with all Phase 0–2 tests intact, fixture-driven replay tests for t1/t2/t3/t5,
high-frequency stream test, and a real DSH web-profile mount whose console shows the full live state sequence for
no-tool, pwsh and multi-tool turns. → met; see `IMPLEMENTATION_LOG.md` §3.

## Phase 4 — Completed summary

- [x] Turn end replaces live meter with completed card. → one state advance in `controller.project`; asserted by
      `test/completed-lifecycle.test.js` (no blank frame between the pill and the card)
- [x] Four-column layout: Reasoning TPS / Output TPS / Generated Tokens / TTFT. → fixed order, always four; tool
      statistics live on the footer line (`src/client/ui-model.js` + `src/client/completed/`)
- [x] Reasoning/output values are turn-level weighted aggregates. → `aggregateTurn` sums the turn; the card renders
      only what the settled snapshot already computed
- [x] Generated Tokens uses correct provider output semantics. → sum of `outputTokens` for contributing attempts;
      `nonReasoningTokens = outputTokens - reasoningTokens`, never a sum
- [x] Secondary lines show phase duration/token counts, total turn elapsed and tool wall timing/status. → the four
      secondary lines plus the footer `工具 N · <wall> · 模型调用 N · <status>`
- [x] Interrupted and errored turns are explicitly labeled. → `interrupted` / `errored` / `token limit reached` status
      text, with the four columns intact and no card-wide error styling
- [x] Estimated/unavailable fields follow quality display rules. → `exact` bare, anything weaker `≈`, `unavailable`
      `—`; a phase token count on the same derivation chain as an approximate rate carries `≈` too
- [x] Completed card consumes the settled snapshot only; `completedViewModel` is the single completed UI seam and
      React performs no statistics
- [x] Completed card is static: no ticker, no rolling value, no timer of any kind; the view is memoized per settled turn
- [x] Reload reconstruction: a durable-only window (no transient plane at all) rebuilds the same card
- [x] `dev/fixture-recorder` removed from the running web profile (disabled tombstone retained)

Acceptance gate: a turn with at least three LLM calls and two tools computes the same totals as an independent fixture
calculation. → met; `t2` (4 attempts, 3 tools: write/edit/pwsh) and `t1` (2 attempts, 2 tools) are asserted from the
recorded bytes through both the live-observed and the durable-only paths, and every fixture is additionally replayed
through the real controller in `test/completed-lifecycle.test.js`.

## Phase 5 — Mandatory completed TPS curve

All items landed. `docs/IMPLEMENTATION_LOG.md` §Phase 5 carries the measurements; `dev/screenshots/phase5/`
holds the browser evidence.

- [x] Build compressed active model-generation x-axis. (`TurnTelemetryStore.settle` emits `curve` with
      `durationMs`, segments, downsampled series, `peakTps` and `phaseSpans`; `src/client/` never recomputes it)
- [x] Prove a long tool delay does not add chart width. (`test/curve.test.js`, 1 s vs 60 s identical geometry)
- [x] Preserve stalls within one model stream.
- [x] Generate reasoning/output rolling 1 s series at bounded render cadence. (250 ms grid, unchanged by the
      Phase 5A presentation cadence)
- [x] Calibrate curve phase integrals to exact final usage where possible. (`curve.quality`)
- [x] Show peak of the full pre-downsample, calibrated series — with `≈`, because a curve sample is not a
      provider-certified maximum.
- [x] SVG point count is bounded for long turns, and the budget can no longer cost the global extreme.
- [x] Default completed card is summary; hover/focus cross-fades to curve view; mouseout/blur restores summary.
- [x] Respect reduced-motion preference.

Phase 5 also closed four items that were not in the Phase 5 list but were real: the 200 ms presentation default
(now 50 ms, measured), the wrong dock seat (now `conversation.input.dock`), the under-styled live/card surfaces,
and the redundant second state update per tick.

Acceptance gate: a fixture containing a 60 s tool call produces virtually the same horizontal curve proportions as the same model samples with a 1 s tool call — met, and asserted rather than observed.

## Phase 6 — Robustness

Phase 6 opened with two blocking corrections from the Phase 5 independent code audit. They are prerequisites for the
robustness rows below rather than part of them: with a rounded curve the robustness evidence would have been evidence
about the wrong formula.

- [x] **Blocking A** — the completed rolling TPS window is measured per attempt and never concatenated across an
      attempt boundary, even though the compressed x-axis is continuous. `perAttemptSeries` measures each attempt on
      its own clock; `compressAttempts` publishes both clocks (`activeTimeMs`, `attemptTimeMs`) so a caller cannot
      mistake one for the other; the counterexample file reproduces the rejected pipeline and fails it.
- [x] **Blocking B** — phase evidence is a list of episodes rather than one interval per phase, and the SVG emits one
      path per episode. A single interval spanning an output-only stretch drew a flat zero line through a region where
      the phase was simply absent.
- [x] **Correction C** — `curve.quality` is `quality.temporalShapeQuality`, not `usageComplete`.
- [x] **Correction D** — the dead `refreshMs` option was removed from core `LiveMeter` and `TurnTelemetryStore`, and a
      source-level test now holds the separation: presentation cadence exists only in `src/client/live/cadence.js`.

- [x] Multiple tool calls, including parallel calls — sequential (`t1`, `t2`, `t6`) and synthetic concurrent sets with
      `workMs > wallMs`, an episode-bounded live timer, and a compact label bounded from 1 to 10 calls.
- [x] Tool-only/empty-output edge conditions — `t6` is a recorded tool-only turn (four attempts, no assistant text);
      the empty-output turn is synthetic, because a turn with no model delta produces no transient frames to record, and
      it reports `null` rather than `0` for every value the provider did not supply.
- [x] Reasoning-only prefix then tool call — `t1`, `t2`, `t6`.
- [x] Visible output + tool-call arguments in same attempt — `t2`, `t6`, `t7`.
- [x] Very large write/edit payload — `t2`.
- [x] User interruption mid-reasoning and mid-tool-argument generation — `t3` records the mid-reasoning case; the
      mid-tool-argument case is covered synthetically (an `abandoned` attempt with a partial prefix), because the
      recorded cancellation landed in reasoning.
- [x] Provider error and retry — the retry path is covered synthetically before **and** after a tool, including a retry
      whose abandoned prefix produced a single delta and therefore shares a compressed coordinate. A **recorded** retry
      was not obtained: `t4`, `t5` and `t8` were recorded on the official route specifically to look for one and none
      scheduled an `llm/retry`. `test/runtime-robustness.test.js` asserts that absence, so a future recording carrying
      one fails the test and the gap becomes visible instead of staying in a report.
- [x] Missing `reasoningTokens` — `d1`, `t1`, `t2`, plus the whole-corpus sweep.
- [x] Missing usage for an abandoned attempt — synthetic, and `t3` covers the recorded no-usage settlement.
- [x] Reconnect/reload while turn is active if DSH supports baseline reconstruction — a `replace` window is a
      rebaseline; the open turn is never rebuilt as a card, a durably settled attempt is restored with its original
      delta timestamps, and a window that no longer holds the turn renders nothing.
- [x] Switching sessions does not leak another session's current TPS/card — unchanged from Phase 3/4, re-asserted.
- [x] Disposal/HMR leaves no timers/subscriptions behind — unchanged from Phase 3/4, re-asserted.

Phase 6 also fixed one live-path defect found while writing the out-of-order test: `acceptChunk` passed a sample to
the live meter without its `attemptId`, so the meter's own attempt-identity guard was unreachable and a late frame for
a superseded attempt could enter the newer attempt's rolling rate. The sample is now stamped before it reaches the
meter.

Acceptance gate: no NaN/Infinity, no stale cross-session state, no falsely exact metric.

## Phase 7 — Integration and visual verification

- [ ] `npm run verify` passes.
- [ ] Install local bundle in `web` profile using locally verified plugin-manager command/UI.
- [ ] Confirm component mounts in the intended composer slot.
- [ ] Compare live/summary/hover states against `docs/assets` references at normal and narrow widths.
- [ ] Test light and dark themes.
- [ ] Test keyboard focus access to curve view.
- [ ] Capture screenshots for all primary states.
- [ ] Confirm native stats coexistence/replacement strategy is deliberate.
- [ ] Remove debug scaffold behavior and temporary diagnostics not needed for release.

Acceptance gate: end-to-end multi-tool turn passes functional and visual checks.

## Phase 7A.1 — Final correctness closure (external audit)

Two correctness blockers found by an independent audit of the Phase 7A commit `c0d2a60`. Each was reproduced by a test
observed to fail before the production change, and each is recorded in `docs/IMPLEMENTATION_LOG.md` with its
counterexample, the behaviour that shipped and the invariant that replaces it.

- [x] BLOCKER A — a global peak living in a one- or two-vertex run could be starved: the allocation was partitioned by
      run length, so the peak's priority band vanished at the class boundary and two ordinary short runs could take
      the last vertices of a saturated budget (`[1,1,0]`).
- [x] Replace the two length-partitioned passes with one priority order denominated in `minimumRunCost(length)`, so
      the peak-bearing run is seated first whatever its length and no run is handed an allowance below its own cost.
- [x] Publish `peakIndex`/`peakRetained`, and place the view model's peak dot only on the vertex that measured the
      printed value (`null` otherwise) — never on a weaker vertex of the drawn series.
- [x] Freeze the chart-wide element bound as `lineVertices + markers = elementPoints <= MAX_RENDER_POINTS_TOTAL`, with
      both `drawnPoints` meanings documented where they are defined.
- [x] BLOCKER B — a window `replace` replayed evidence into a `TurnTelemetryStore` that still owned the previous
      generation, duplicating samples into attempts the superseded window had already filled.
- [x] Add `TurnTelemetryStore.rebaselineSession(sessionId)` and call it before the presenter reset on
      `window-rebaseline`, scoped to one session.
- [x] Establish and test `controller-after-replace == fresh-controller-over-replacement-window` for an open turn, a
      completed turn and a mid-turn tail.
- [x] `npm run build:client` + `npm run verify`: 508 baseline tests retained, 27 added, **535 pass / 0 fail**, bundle
      fresh.
- [x] Phase 5–7 frozen behaviours re-run and unregressed: 0 ms / 3000 ms episode opening = 100 (never 200), attempt
      reset and retry, mid-turn adoption, authoritative turn-start upgrade, completed reconstruction,
      `SLOT_ORDER === -10`.
- [x] Push to `origin/main` without rewriting `05ffd0d`, `c4c8ef0` or `c0d2a60`.

Acceptance gate: the turn-meter correctness gate is ready for external audit. Phase 7B (browser/E2E/visual matrix) is
deliberately **not** started.

## Phase 8 — Release readiness

- [ ] Update README from scaffold status to implemented status.
- [ ] Document exact supported DSH version(s) tested.
- [ ] Document known provider/token-quality limitations.
- [ ] Add changelog/release notes if publishing.
- [ ] Ensure package does not modify DSH core and has no accidental credentials/log dumps.
- [ ] Final `npm run verify` and local reinstall/restart smoke test.

Final output to the user should include: changed files, exact test commands/results, DSH version, install command, known limitations, and screenshots or precise visual-verification notes.
