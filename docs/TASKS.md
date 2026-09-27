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
      attempt boundary, even though the compressed x-axis is continuous. `attemptTrace` (then `perAttemptSeries`)
      measures each attempt on its own clock; `compressAttempts` publishes both clocks (`activeTimeMs`,
      `attemptTimeMs`) so a caller cannot mistake one for the other; the counterexample file reproduces the rejected
      pipeline and fails it.
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

## Phase 7C — Curve metric and rendering repair

Opened on an external audit of `b7bda66` with three findings: the completed curve was drawn in the raw heuristic
magnitude system while every printed number came from the calibrated one; the live meter and the completed curve were
measuring different rates because the curve was split by phase; and the real screenshot showed a fragmented, bead-like
trace rather than a throughput curve whose tone changes by phase. Each finding was reproduced by a test observed
failing before the production change.

- [x] **Finding A — the completed curve consumed raw heuristic magnitudes.** `settle()` called
      `compressAttempts(record.attempts)` while `aggregateTurn` calibrated a copy of the same samples into
      `attemptBreakdown[].calibration.samples`, so `Generated Tokens` and the curve's own area could differ by any
      factor. Add `src/core/curve-source.js`: the curve input is the stored attempts joined with that calibration,
      positionally and verified on `attemptId`/`step`/sample count, degrading **wholesale** to the raw shape when the
      join cannot be trusted. No second calibration algorithm exists.
- [x] **Finding B — live and completed curves measured different rates.** `LiveMeter` sums every generated sample of an
      attempt in one trailing window; the completed curve built one series per phase, so neither line equalled the
      live reading at a transition and `peakTps` was the larger of two partial rates. Replace `perAttemptSeries` with
      `attemptTrace`/`totalRollingTpsSeries`: one attempt-local total trace per call, with `activePhase` as a **label**.
- [x] **Finding C — the trace was fragmented.** The drawing unit was the phase episode, so one call could appear as
      several disconnected traces with blank regions between them, and every short episode became a large marker.
      Remove the episode cut; cut the attempt's trace into phase-coloured runs by `visualRunsOf`, whose seams are
      shared vertices; reserve those seams in `downsampleRun`; and give ordinary singleton markers their own smaller,
      subdued size so only the published peak keeps the strong one.
- [x] An intra-attempt stall stays visible as a full-width decay to zero; a tool wait and an inter-attempt wait keep
      zero x-axis width; an attempt boundary stays a hard window reset and a subpath break.
- [x] Freeze the peak as the maximum over every attempt-local total vertex, checked against a test-only brute-force
      reference over the calibrated samples. Retract the Phase 7B "peak ≥ mean" reading as a universal invariant.
- [x] Correct the live/completed equivalence contract: numeric equality is mandatory only when no authoritative usage
      exists or the calibration scale is 1; timestamps, attempt boundaries, window definition, phase-transition
      locations and stall locations must always be identical.
- [x] `npm run build:client` + `npm run verify`: 538 baseline tests retained apart from the expectations that encoded
      the superseded geometry, **586 pass / 0 fail**, bundle fresh.
- [x] Docs updated: `METRICS_SPEC.md` §8.2/§8.2.1/§8.2.2/§8.3/§8.5/§9, `ARCHITECTURE.md` §6, `UI_SPEC.md` §6,
      `TEST_PLAN.md` §1, and Known Limitation #14 replaced by its root cause, counterexample, corrected pipeline and
      verification.
- [x] Push to `origin/main` without rewriting `b7bda66` or any earlier commit.

Acceptance gate: the phase-7 curve work is complete and ready for external audit. Phase 8 is deliberately **not**
started.

## Phase 7D — DSH 0.1.7-rc.2 migration (complete)

Opened when the locally installed DSH had moved to `0.1.7-rc.2` and the plugin's live meter was observed accumulating
strictly sequential tool calls as though they were concurrent. The phase establishes the runtime baseline, reads the new
contracts out of the installed package, repairs the adapter, the client feed and the completion path, and freezes a
versioned 0.1.7 fixture corpus. Every contract claim below names the local declaration it was read from, and the
normative target from this phase onward is `0.1.7-rc.2` (public reference commit
`477b4f420553e8a52c2fbccc464d7561b239c443`).

- [x] Preflight proof of the runtime: `dsh --version` → `0.1.7-rc.2`, the executable and the active web process
      identified by path and PID, profile `web`, port 50001.
- [x] Baseline measurement at SHA `1f97cfa5bad329e54bdf69debbb40611935827ae`: 648 tests / 648 pass, and a pure
      in-process run of 100 strictly sequential `pwsh` calls recording max `runningToolCount` 100, labels reaching
      `pwsh +99`, 100 unmatched results and 100 tools still running.
- [x] Local contract inspection, field by field: `ToolResultMessage` (`role: 'tool'`, `toolCallId`, `isError`),
      `SessionEventMap['tool/result']`, the seven-variant `TurnEndReasonMap` including the new `forked`,
      `SessionEventChange`, `SessionEventWindow`/`SessionEventSource`, `AssistantLiveChunkEvent`,
      `SessionAssistantStreamFrame`, `ClientAssistantStreamResult`, and the v4 session log format. Recorded in
      `docs/DSH_API_NOTES.md` §13.
- [x] BLOCKER A — the 0.1.5 nested result shape was still the only decode path, so every 0.1.7 result failed to pair
      and each new call was added to the running set instead of replacing the previous one. Identity now comes from
      `message.toolCallId`; the legacy content-block read is labelled and unreachable for `role: 'tool'`.
- [x] Sequential, parallel and mixed tool regressions: the running count never exceeds the number of genuinely
      concurrent calls, the wall time stays a union rather than a sum, and pairing is by identity rather than order.
- [x] Settle-assistant migration: a bare `settleAssistant(attemptId)` is resolved from held evidence
      (`settledAttemptIds` plus a consumed `pendingSettlements` budget) instead of being read as an abandonment, which
      the 0.1.5-era code did for every successful retirement.
- [x] Completion trace and repair: the completion path was traced layer by layer (branches A–H), the reachable silent
      branch was counted, recorded and repaired by reconstruction from the durable window, and `rawTurnEndSeen` was
      added as the instrument that discriminates it from a boundary the wire never delivered.
- [x] 0.1.7 fixture corpus: `fixtures/dsh-0.1.7/t01-sequential-tools.json`, recorded from a live 0.1.7-rc.2 host, with
      its own shape summary and sanitization verified clean.
- [x] Legacy fixture classification: the eight 0.1.5-rc.2 captures keep their evidentiary role for metric arithmetic,
      decoder robustness and historical compatibility, and lose their evidentiary role for tool/result shape,
      settle-assistant semantics, turn completion lifecycle and window behaviour.
- [x] Docs updated: `DSH_API_NOTES.md` §13, `ARCHITECTURE.md` Phase 7D, `TEST_PLAN.md` §7, `IMPLEMENTATION_LOG.md`
      Phase 7D, `README.md` compatibility statement.
- [x] Second contract site found and fixed: the identical `content[0].toolCallId` read also existed in
      `src/dsh/durable-path.js`, which no live browser test exercises. Measured on the 0.1.7 fixture, path B
      reconstructed 2 calls with **0** finite end times at the baseline and 2 after the fix; both paths now share one
      exported contract site and a regression test asserts they resolve the same identity.
- [x] `npm run build:client` + `npm run verify`: **685 pass / 0 fail**, 37 tests above the 648-test baseline of
      `1f97cfa`, bundle fresh; `node scripts/verify-sanitization.mjs` passes with the new corpus included.
- [x] Clean-runtime browser evidence: a baseline-versus-fixed A/B on a five-call sequential turn, the completion
      lifecycle trace, and the reload equivalence, recorded under `dev/screenshots/phase7d/`.
- [x] Pushed to `origin/main`. `1f97cfa5bad329e54bdf69debbb40611935827ae` ->
      `5182344dc56553120e77d00fcaea11cf1416e57c`, three commits:
      `d70bbe5dd1f2e44078cb48fd1c2f47965464b8c3` (fix: tool results and completion),
      `e38cd0d1e1b0b9d1e5ab78054a8a9d7f7c9d5e02` (test: 0.1.7 integration fixtures),
      `5182344dc56553120e77d00fcaea11cf1416e57c` (docs: 0.1.7-rc.2 baseline).
      `git rev-list --left-right --count origin/main...HEAD` reports `0 0`.

Acceptance gate: the plugin is verified against the only DSH it claims, `0.1.7-rc.2`, and the sequential-tool defect
class that opened the phase is closed by regression test and by browser measurement.

## Phase 7D.1 — terminal-tail durable metric reconstruction (complete)

A correctness closure on the one thing Phase 7D left half-done. Phase 7D repaired the terminal **lifecycle** — a
`turn/end` with no open record no longer returns silently — but not the metric **reconstruction**: the miss path opened
an empty record and closed it, so a recovered card reported zero attempts, zero tokens and no tools while the turn's
durable evidence sat in the window the handler had just read. No frozen metric, UI or curve semantic was re-opened, and
Phase 8 was not begun.

Baseline SHA `3602ce9179be22bcdc4259303546ebae4b827436`, equal to `origin/main`, working tree clean.

- [x] Baseline re-verified rather than quoted: `git status` clean, `HEAD == origin/main == 3602ce9`, divergence `0 0`;
      `dsh --version` → `0.1.7-rc.2`; executable `C:\Users\20659\AppData\Roaming\npm\dsh.cmd`; the running web process
      resolved to `…/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open` (PID 38056) and the installed package
      declares `0.1.7-rc.2`.
- [x] Failing test written and run **before** any production change:
      `test/dsh-017-terminal-tail-recovery.test.js`, first case
      `a terminal durable tail without turn/start reconstructs the turn's durable metrics`, against baseline `3602ce9`.
      Recorded result — reference 3 attempts / 2 tools / 147 generated tokens / `full` calibration coverage against a
      recovered record of **0 attempts / 0 tools / `null` tokens / `none` coverage**; 10 of 11 cases failed.
- [x] Durable evidence retention added to `SessionEventFeed` (`DurableEvidencePool`, bounded at 32 turns, oldest
      released first), hooked into **both** entry routes — appended window entries and the entry carried by a
      `settle-assistant` change — cleared by `rebaseline()`, per feed so sessions stay isolated, expose-only through
      `turnEvents(turn)`, and decoding nothing.
- [x] `src/dsh/reconstruction.js` added: `materializeReconstructedTurn()` calls `reconstructFromDurable` and routes its
      output through the store's own methods, so the recovered record enters `aggregateTurn → curveSource →
      attemptTraces` and the ordinary completed pipeline. **No third durable parser**: no decoding, tool pairing, retry
      correlation or settlement classification outside `src/dsh/durable-path.js` and `src/dsh/adapter.js`.
- [x] `TURN_END` + missing record now consumes the turn's durable evidence instead of opening an empty record.
- [x] Unknown boundaries preserved: with no `turn/start` the recovery keeps `startMs` `null` and reports TTFT and turn
      elapsed as **unavailable**, while recovering `firstTokenMs` from the durable generated samples. No value inferred
      from a first delta, a `step/start`, a `tool/call`, the attach instant or the clock.
- [x] Minimal case preserved: a window whose only evidence is `turn/end` closes terminally with 0 attempts, 0 tools, no
      start, no TTFT, no elapsed and no fabricated sample or duration.
- [x] `turnEndReconstructed` semantics narrowed and documented: it counts one reconciliation from available durable
      evidence and deliberately does not claim the evidence was non-empty; the `turn-end-without-record` issue now
      carries `reconstructedAttempts`, `reconstructedTools` and `startKnown`. No counter without a reader was added.
- [x] Defect found inside Phase 7D.1's own scope: the `settle-assistant`-with-entry restore path already computed
      `settlementEventType` but never landed it on the store record, so a reload-rebuilt card published `null` for every
      attempt. Now attached beside the settlement state, matching the durable reconstruction path.
- [x] Regression matrix re-verified: `message.toolCallId` / `role: 'tool'` / `message.isError` and malformed-identity
      fail-closed unchanged (6 tests); 100 strictly sequential calls with maximum running count 1 and 0 unmatched
      results unchanged (7); bare `settle-assistant` retirement versus true abandonment unchanged (7); all seven
      `TurnEndReason` variants terminal and unknown reasons `statusKnown false` unchanged; late evidence cannot
      resurrect a settled turn; rebaseline and per-session isolation of retained evidence covered by new tests.
- [x] Fixture corpus audited honestly: `fixtures/dsh-0.1.7/` still holds exactly `index.json` and
      `t01-sequential-tools.json`. **No lifecycle fixture was added and the corpus is not complete.** The recorder
      observes only `ctx.on('session/event')` and `ctx.on('agent/assistant-stream')`; the `settle-assistant` window
      change is emitted by the browser-side `ClientAssistantStream` fold and is never visible to the host process, so no
      recorded fixture can contain one. Capturing it would require re-running the fold inside the host recorder (a
      derived, not observed, artifact) or a new browser-side tracing facility. The retirement/abandonment distinction is
      therefore covered by synthetic contract tests against the ported fold algebra, and is labelled synthetic.
- [x] Documentation audited — `IMPLEMENTATION_LOG.md` (Phase 7D correction note plus the Phase 7D.1 entry),
      `ARCHITECTURE.md`, `TEST_PLAN.md` §8, `TASKS.md`, `DSH_API_NOTES.md` §13.5. The sequential-tool distinction
      (`actual concurrency 1` / `buggy running set 100` / `historical call count 100` / `unmatched results 100 → 0`)
      was found **already correct on the baseline**; no documentation churn was required.
- [x] `npm run build:client` then `npm run verify`: **696 tests, 696 pass, 0 fail**, 11 above the Phase 7D figure of
      685; `node scripts/verify-sanitization.mjs` passes; `git diff --check` clean; bundle fresh.
- [x] Runtime evidence without a reload shortcut: `dsh --version` `0.1.7-rc.2` and the web host process re-identified;
      `window.__DSH_BOOT__` resolving the plugin to `…client.js&rev=7e89ed4086d7`, whose served module table contains
      `src/dsh/reconstruction.js` and no longer the old log line; a 3,945-sample 50 ms page sampler over a real turn
      recording five presentation states and **zero** `+N` labels; and a durable-only completed card on reopening an
      existing settled session, byte-stable across a two-second resample. The one case not reproduced in the browser —
      a window whose `turn/start` has actually slid out — is recorded as contract-plus-replay evidence rather than
      claimed as an observation.
- [x] Pushed to `origin/main`.

Acceptance gate: `turn/end` terminal recovery with no live record and available durable tail evidence closes the
lifecycle unconditionally **and** reconstructs the metrics from that evidence **and** fabricates no unavailable fact.

## Phase 8 — Release readiness

**NOT STARTED.** No task in this phase has been begun; the entries below remain the intended work, not a record. Two of
its bullets — the current README status and the exact supported DSH version — were satisfied early by Phase 7D
(`README.md` §0 and `docs/DSH_API_NOTES.md` §13); the rest are untouched.

- [ ] Update README from scaffold status to implemented status.
- [ ] Document exact supported DSH version(s) tested.
- [ ] Document known provider/token-quality limitations.
- [ ] Add changelog/release notes if publishing.
- [ ] Ensure package does not modify DSH core and has no accidental credentials/log dumps.
- [ ] Final `npm run verify` and local reinstall/restart smoke test.

Final output to the user should include: changed files, exact test commands/results, DSH version, install command, known limitations, and screenshots or precise visual-verification notes.
