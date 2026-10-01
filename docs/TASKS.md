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
- [x] Durable evidence retention added to `SessionEventFeed` (`DurableEvidencePool`, bounded at 32 turns, **least
      recently updated** turn released first — see Phase 7D.1.1 below, which corrected this line from "oldest released
      first"), hooked into **both** entry routes — appended window entries and the entry carried by a
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

## Phase 7D.1.1 — Reconstruction contract and Git gate closure

A closure phase. No metric engine, no UI, no curve semantics, and no change to the DSH 0.1.7-rc.2 `tool/result`,
`settle-assistant` or `turn/end` contracts. Baseline `dd4b194a349fe9a3dd9b126bd84241dff82221c7`, re-verified at the start
of the round rather than quoted (`HEAD == origin/main`, divergence `0 0`, working tree clean, `dsh --version` →
`0.1.7-rc.2`).

- [x] Main Phase 7D.1 repair re-verified as frozen and left untouched: `turn/end` + `lookupRecord == null` →
      `state.feed.turnEvents(turn)` → `materializeReconstructedTurn()` → `reconstructFromDurable()` → the store's normal
      methods → `store.endTurn()` → `aggregateTurn` → `curveSource` → `attemptTraces` → normal completed card. The
      Phase 7D empty-record path was **not** restored, and the unknown-boundary rule still holds: with no `turn/start`,
      `startMs` / `ttftMs` / `turnElapsedMs` stay `null` while `firstTokenMs` is recovered from durable samples.
- [x] **Defect A closed — the unsafe `timeMs` fallback is gone.** `materializeReconstructedTurn()` no longer accepts
      `timeMs` and no longer passes `reconstructed.turnStartMs ?? timeMs` to `beginTurn`; the parameter was deleted, not
      ignored, so the fabrication is inexpressible at the API level. Failing test written and run first on `dd4b194`:
      `test/dsh-017-materialize-reconstruction.test.js`, 2 of 4 cases failing, with `record.startMs` `null` →
      `9000000000000` and, worse, `settled.ttftMs` / `settled.turnElapsedMs` `null` → `0` — a measured-looking `0 ms`
      where the honest answer is "—". Post-fix: `startMs` `null`, `ttftMs` `null`, `turnElapsedMs` `null` under both the
      named-parameter call and an unnamed `timeMs` smuggled through object spreading, while the same tail *with*
      `turn/start` still reports `startMs` 1790497151824 / `turnElapsedMs` 6938. Callers were enumerated before deletion
      (`git grep`): the only production caller is the controller miss path, which never passed `timeMs`.
- [x] **Defect B closed — the retention eviction contract is now one policy in code, comments, docs and tests.** The
      implementation was and remains **least recently updated first**: `DurableEvidencePool.record()` deletes a turn's
      key before re-inserting it, so a Map's insertion order moves a revisited turn to the tail. The source comments, the
      module docstring, `ARCHITECTURE.md`, this file and `IMPLEMENTATION_LOG.md` claimed first-seen ("oldest released
      first", "re-recording preserves its original position"). The implementation is kept — it is the policy the
      consumer needs, since the turn a `turn/end` miss asks about is the one still producing evidence — and every
      first-seen claim was replaced. Tested by `test/dsh-017-retention-contract.test.js` (9 tests): hard ceiling at
      `MAX_RETAINED_TURNS = 32`; the decisive `1..32` + refresh `1` + add `33` → **turn 2** released; a long turn
      interleaved with 64 others keeps all 65 rows in arrival order; evicted turns answer `turnEvents() === []`;
      survivors keep durable arrival order and object identity; a duplicate `seq` neither duplicates a row nor counts as
      activity; `replace` clears the pool and frees the old generation's sequence numbers; and the retired first-seen
      vocabulary is asserted **absent** from source and docs so the disagreement cannot silently return.
- [x] `counters.retainedDurableEvents` semantics audited and documented as **cumulative** (unique rows admitted into
      retention this generation), not a current row count: it is never decremented on eviction and resets with the pool
      at a rebaseline. Current occupancy remains available through `retainedTurnCount()`. No new diagnostic state was
      introduced; a decrementing alternative was rejected as costlier than the distinction is worth.
- [x] **Git process deviation recorded rather than normalised.** Phase 7D.1 used one `--force-with-lease` after a
      post-push `--amend`, which rewrote the remote: `d0904db` and `dd4b194` are sibling commits sharing parent
      `d3982fe`. An independent GitHub audit found no unrelated or production commit loss, but "nothing was overwritten"
      is not an accurate description — the remote documentation commit **was** replaced. History will not be rewritten
      again to restate this.
- [x] Absolute Git rule for this phase, and for subsequent phases unless the user directs otherwise: no `--amend` after
      push, no rebase of pushed `main`, no `--force`, no `--force-with-lease`, no reset of remote `main`. New commits and
      an ordinary `git push origin main` only; a rejected push is reported as divergence and not resolved by force.
- [x] Documentation scope kept to the closure: `ARCHITECTURE.md`, `IMPLEMENTATION_LOG.md`, `TASKS.md`, `TEST_PLAN.md`.
      No unrelated document was edited.
- [x] Gates, reported as a **local test result** because this repository has no CI runner: `npm run build:client`
      rebuilt the bundle to 477,412 bytes mirrored to `lib/client.js`; `npm run verify` reports **709 tests, 709 pass,
      0 fail** (13 above the Phase 7D.1 figure of 696) with `structure OK (14 required files, 16 core modules,
      62 test files, client bundle fresh)`; `git diff --check` is clean; `node scripts/verify-sanitization.mjs` passes.
      `client.js` and `lib/client.js` are byte-identical, and the served bundle (entry rev `817e3b87a4e9`) contains this
      phase's code and comments.
- [x] Clean-runtime smoke without the reload shortcut: after a cache-ignoring page reload the plugin's live meter is
      mounted and rendering (`data-kind="live"`, `data-state="tool-running"`), and a settled session renders the
      completed card (`data-kind="completed"`, `生成 Tokens 1,513 tokens`, `总用时 66.9s`, `工具 8 · 35.8s`,
      `模型调用 9`). No new plugin console error; the page's remaining errors are the pre-existing DSH shell template
      artifact plus unrelated 404 polling. No long browser performance A/B was repeated — no presentation path changed.

Acceptance gate: a fake reconstruction start is impossible through the exported API; the retention eviction policy is
identical in implementation, comments, documentation and tests; every Phase 7D / 7D.1 regression still passes; the local
verify run reports 0 failures; and the phase lands as an ordinary fast-forward push with `HEAD == origin/main` and a clean
working tree, with no force operation of any kind.

## Phase 7D.1.2 — Generation-wide durable identity closure

The last small correctness closure after Phase 7D.1.1. No metric semantics, no UI, no curve arithmetic, no DSH
0.1.7-rc.2 contract, and no re-design of the eviction policy. Baseline
`b188511e80653f2cb9d54a046fdeabe1fc0e1e4a`, re-verified at the start of the round rather than quoted
(`HEAD == origin/main`, divergence `0 0`, working tree clean, `dsh --version` → `0.1.7-rc.2`).

- [x] Both Phase 7D.1.1 repairs re-verified as frozen and left untouched: `materializeReconstructedTurn()` still accepts
      no caller `timeMs`, a missing durable `turn/start` still yields `startMs` / `ttftMs` / `turnElapsedMs` `null` while
      a real `turn/start` is still used, and eviction is still least-recently-updated with another durable row of a turn
      refreshing its retention position.
- [x] **Defect closed — a duplicate `seq` can no longer touch retention.** Root cause: two structures answered "has this
      row been seen" differently. `DurableEvidencePool.seqs` released a row's seq on eviction while the feed's
      generation-wide `durableSeqs` did not, and `processDurable()` retained *before* the generation-wide duplicate
      check — so replaying `row(turn 1, seq 1)` after turn 1's eviction had that one call both re-admit the row (with a
      counter increment and a different later eviction victim) and reject it as `duplicate-durable-event`. Two frozen
      statements were violated: a duplicate does not count as activity, and `retainedDurableEvents` counts the distinct
      durable rows admitted during the generation.
- [x] **Fix — admission precedes retention, and identity lives in one set.** A single gate,
      `SessionEventFeed.admitDurable(event)`, records the `seq` as seen before retention is attempted and before
      normalization, so a row refused for either reason is refused for good; both durable entry routes call it.
      `DurableEvidencePool` now holds evidence bytes only — no seq set — so `record()` validates the turn and stores the
      row, and `evict()` is a single map `delete` per released turn with no walk over that turn's rows, since nothing
      outside the map is derived from them. Eviction forgets retained row bytes but not the fact that the `seq` was
      already seen; `rebaseline()` remains the only boundary that clears both, so the fix is not process-lifetime dedupe.
      Source comments state the real complexity and the two lifetimes; `docs/ARCHITECTURE.md` agrees.
- [x] **Second entry route closed.** `applySettlement()` previously retained the settlement and added its seq without any
      duplicate check, so a repeated `settle-assistant` entry refreshed its turn and emitted a second `attempt-settle`
      over an already-committed outcome. It now passes the same admission gate, fails closed, and records
      `duplicate-durable-event`. Normal retirement and abandonment semantics are unchanged.
- [x] `counters.retainedDurableEvents` now genuinely counts **distinct durable rows admitted into retention during the
      generation**: eviction does not decrement it, a duplicate does not increment it whether the original row is
      resident or evicted, a row naming no turn is admitted as an identity but not counted because `turnEvents(turn)`
      can never retrieve it, `rebaseline()` resets it, and a seq admitted in the replayed generation counts again.
- [x] Failing tests written and run **first**, on `b188511`: `test/dsh-017-durable-identity.test.js` (5 tests) failed 3
      of 5 — the post-eviction duplicate re-entered retention, the duplicate settlement emitted twice (`2 !== 1`), and
      the counter reached `34` where `33` is the contract. The two complements (a duplicate of a still-resident row, and
      seq reuse after a rebaseline) passed and were pinned. The decisive case is a **control comparison**: two feeds
      receive the same legitimate evidence and only one receives the replayed row, so the harm shows as a later
      legitimate turn being released rather than as a number that a re-admission back to the bound would hide.
- [x] Two Phase 7D.1.1 cases in `test/dsh-017-retention-contract.test.js` were moved onto the real `append` route, since
      admission is what refuses a duplicate and `retainDurable()` is the storage primitive below that gate; the
      assertions themselves are unchanged.
- [x] Gates, reported as a **local test result** because this repository has no CI runner: `npm run build:client`
      rebuilt the bundle to 481,581 bytes mirrored to `lib/client.js`; `npm run verify` reports **714 tests, 714 pass,
      0 fail** (5 above the Phase 7D.1.1 figure of 709) with `structure OK (14 required files, 16 core modules,
      63 test files, client bundle fresh)`; `git diff --check` is clean; `node scripts/verify-sanitization.mjs` passes;
      `client.js` and `lib/client.js` are byte-identical.
- [x] Minimal clean-runtime smoke, no `dev_reload_package` as evidence: after a cache-ignoring reload the plugin's
      loader entry is active and the live meter renders in the composer dock
      (`.dsh-tpm-root[data-kind="live"][data-state="tool-running"]`, `aria-label="工具 · 8m48s"`), the served bundle
      contains this phase's `admitDurable` gate and generation-wide identity vocabulary, and no new plugin console error
      appears. The completed card was not separately re-observed: live and completed are mutually exclusive projections of
      one slot and the conversation mounts only the turn being read, so a card cannot be mounted while the agent's own turn
      is running; card rendering stays covered by the `live-presenter` and `completed-lifecycle` suites. No long browser
      A/B was repeated, because no presentation path changed.
- [x] Documentation scope kept to `src/dsh/client-feed.js` comments, `docs/ARCHITECTURE.md`,
      `docs/IMPLEMENTATION_LOG.md`, `docs/TASKS.md` and `docs/TEST_PLAN.md`. No README or release material was touched.

Acceptance gate: a post-eviction duplicate cannot re-enter retention, refresh an LRU position, change an eviction victim
or increment `retainedDurableEvents`; a duplicate `settle-assistant` entry cannot emit a second settlement; durable seq
identity is generation-wide while `rebaseline()` still permits reuse in the next generation; the least-recently-updated
policy is unchanged for genuinely new evidence; every previous regression suite passes; the local verify run reports
0 failures; and the phase lands as an ordinary fast-forward push with `HEAD == origin/main` and a clean working tree,
with no force operation of any kind.

## Phase 8 — Release readiness (2026-09-27)

Release-readiness phase for a **local** plugin. No metric semantics, UI, curve arithmetic, DSH 0.1.7-rc.2 contract,
retention policy or eviction behaviour was changed. Baseline
`82ec58abb658c7bb7d0eedcbf248b8f6c8e3d0db`, re-verified at the start of the round rather than quoted (`HEAD == origin/main`,
divergence `0 0`, working tree clean, `dsh --version` → `0.1.7-rc.2`, `npm list -g @deepseek-ai/dsh` → `0.1.7-rc.2`).

- [x] **README rewritten as user documentation.** The top of the file is now what the plugin does, its support status and
      its install/usage path; the historical defect chronology was left in this file and in
      `docs/IMPLEMENTATION_LOG.md` rather than carried at the top. Stale status (`Phase 7D.1 complete; Phase 8 not
      started`), the stale build order (`Phases 0–7D.1 complete`), the wrong test-file count (60 → 63) and the two
      missing tree entries (`fixtures/dsh-0.1.7/`, `dev/recordings/`) were corrected; the key metric semantics (turn
      boundary, ratio-of-sums, live attempt-local 1 s window, `≈`, token accounting, `toolWallMs`, curve definition)
      were kept.
- [x] **Obsolete scaffold instructions removed, after verifying the key is gone.** The `debugPlaceholder`
      bootstrap-only slot-loading instructions and the "scaffold client is invisible by default" paragraph were deleted,
      not reworded: `git grep` over `src/`, `client.js` and `lib/client.js` finds no `debugPlaceholder` reader or
      writer anywhere. The surviving production diagnostics key `dsh-turn-performance-meter.debug` is documented as
      diagnostic-only, explicitly "not required for normal use", with the per-delta logging guarantee and the
      debug-gated `dsh-turn-performance-meter.refreshMs` override stated as its only reachable companion.
- [x] **README phase references updated.** `Phases 0–8 complete` and `Phase 8 (release readiness) complete` replace the
      old current-state claims; historical mentions of Phase 7D.1 inside dated phase records were left as history.
- [x] **`index.js` comment corrected to the real architecture.** The scaffold text ("The initial scaffold intentionally
      performs no interception. DeepSeek should implement the host-side telemetry bridge …") was wrong and is gone. The
      entry now states that telemetry is consumed in the browser client from `ctx.sessions.binding(sessionId).eventSource`,
      that `apply` registers nothing because there is nothing host-side to register, and that no DSH core source is
      patched. `export function apply() {}` was kept — no host hook was invented to make the file look substantial.
- [x] **Exact compatibility claim documented, and nothing wider.** `README.md` §2 states
      `Supported/tested: DSH 0.1.7-rc.2` with public reference commit `477b4f420553e8a52c2fbccc464d7561b239c443`, and
      explicitly refuses `0.1.7+`, `0.1.x` and "latest DSH". Re-verified this round against the local CLI, the locally
      installed package and the composed profile tree. The `0.1.5` captures under `fixtures/dsh-turns/` stay labelled
      historical metric/decoder evidence and **not** a supported runtime contract. No `package.json` peer range was
      invented.
- [x] **Known limitations written as a user-facing section.** `README.md` §6 records eight limits: live TPS is a
      heuristic delta weighting marked `≈`; completed totals depend on provider usage; the temporal curve's ceiling is
      `reconstructed`; a missing `turn/start` leaves TTFT and elapsed unavailable; retained durable evidence is bounded
      by `MAX_RETAINED_TURNS = 32` least-recently-updated and holds bytes only; the `0.1.7` recorded corpus is two files;
      the Phase 7D.1 terminal-tail case was not constructed in a browser; and verification is local because there is no
      CI runner.
- [x] **Install command verified against the real CLI instead of assumed.** `dsh --help` and
      `dsh plugin --profile <name> --help` show the manager forwards the remaining arguments to pnpm in the profile
      directory. Two disposable profiles were created for the probe and then deleted:
      `dsh plugin --profile p8-probe-file add "file:…"` and `… add "link:…"`. Both installed and both were reconciled
      into `dsh.profile.bundles` automatically, because this package declares `dsh.bundle.patch`. The measured
      difference decides the documented form: `link:` produced a `SymbolicLink` to the checkout, while `file:` produced a
      frozen copy through which a file created in the checkout afterwards never appeared — so `file:` would serve
      yesterday's `client.js` after the next `npm run build:client`. `README.md` §3 therefore documents `link:` with the
      reason, and uses a portable placeholder path rather than this machine's absolute path.
- [x] **A from-scratch install path was verified in a disposable web-template profile.**
      `dsh --profile p8-clone --from-default-profile web --dump-config` initializes a clone of the shipped web template
      without booting it; adding the plugin with the documented command then yielded
      `bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-turn-performance-meter]` and a 1,197-line composed
      tree containing `- id: turn-performance-meter`. All three probe profiles were removed afterwards and the real `web`
      profile was confirmed untouched: `package.json` SHA-256 `97A5BF67…A703` identical before and after, and
      `node_modules/dsh-turn-performance-meter` still a `SymbolicLink` to the checkout.
- [x] **No destructive uninstall/reinstall was performed, and no cold restart of the `web` profile.** The agent session
      executing this phase runs *inside* the `web` profile on `http://127.0.0.1:50001`; restarting that profile would
      terminate the session performing the verification. The stronger-than-loaded checks used instead are the
      disposable-profile install above and a served-bundle identity check (next bullet). This is reported as a boundary,
      not as a satisfied restart test.
- [x] **The bundle the browser is actually served was verified byte-for-byte against the repository.** The plugin client
      module is served inside a combined `GET /plugins/??…,dsh-turn-performance-meter/client.js&rev=9e8027cfe26a`
      response. The module slice — from its generated-file banner to the closing `})` of its `__ModuleLoader__.load`
      wrapper — hashes to SHA-256 `5dd9159438c7d2e47d5b6646375a8f5369c9d822930bac44b31ceb039860e6fb` over 481,580
      characters / 482,478 UTF-8 bytes, which is exactly the repository `client.js` minus its single trailing newline
      (the server's module-separator byte). The served artifact is the repository artifact.
- [x] **Bundle identity and freshness.** `npm run build:client` rewrote 481,581 bytes and mirrored them;
      `Get-FileHash client.js` and `Get-FileHash lib/client.js` are both
      `E45A0A738145AE7063C217F941E8E3F8D97E429DC3FE32E90D34D1F21D550A94`. `scripts/verify-structure.mjs` fails on a
      `client.js` stale relative to `src/`, and — new in this phase — also fails when the injector-validated
      `lib/client.js` mirror differs from `client.js` or is missing. Both paths were exercised: with `lib/client.js`
      sabotaged the check exited `1` with `lib/client.js differs from client.js — run: npm run build:client`, and after
      `npm run build:client` it exited `0` with the byte-identical mirror restored and no tracked modification.
- [x] **Secret/privacy audit on the whole tracked tree, not just `.gitignore`.** 175 tracked files: no `.env`, no
      credential store, no `*.log`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.har`, `*.pcap`, `*.sqlite`, `*.db`, no archive.
      `fixtures/raw/` is not tracked. Content scan over tracked files found **no real secret**: the `password` / `Bearer
      token` / `Cookie` hits are verbatim upstream Chrome DevTools MCP tool-schema descriptions inside recorded fixtures,
      the `BEGIN PRIVATE KEY` hits are the sanitizer's own detector patterns, and `secret` appears only in the log's
      record of an earlier scan. No real email address, no machine hostname (`DESKTOP-FENG`: 0 hits), no mailbox identity.
      The only disclosure class found is **recorded local verification paths** in documentation —
      `C:\Users\20659\…` in `docs/DSH_API_NOTES.md:266`, `docs/IMPLEMENTATION_LOG.md:2641-2642,3101-3102`,
      `docs/TASKS.md:341` — which is documentation of a real local command, not a credential; it was classified rather
      than mechanically redacted, because rewriting those rows would falsify evidence. Nothing entered Git history that
      needed to be removed. Scan rerun after `CHANGELOG.md` entered the final tree: no new sensitive content found, so the
      classifications above stand unchanged and only the tracked-file count moved, from 174 to 175.
- [x] **Fixture sanitization gate run.** `node scripts/verify-sanitization.mjs` exits `0`: none of 22 forbidden terms
      appears in any published fixture value; the 13 published fixtures keep their file set and every structural scalar,
      with 9 of them verified against untracked raw originals at identical string lengths; the sanitizer is confirmed
      load-bearing (raw originals are not a fixed point). 163 UUIDs inside fixtures are recorded session/attempt/call
      identities the tests depend on, which the sanitizer preserves by design. The only reported residue is the declared
      public DSH surface names `wechat_notify` and `dsh-super-injector`.
- [x] **Package contents audited without publishing.** `npm pack --dry-run` under `private: true` prints the tarball
      listing and writes nothing: 173 files, 2.35 MB packed / 8.53 MB unpacked.
      Contents are the plugin sources, tests, fixtures, docs, `dev/` tooling, both bundle copies and `LICENSE`. No
      `node_modules`, no `fixtures/raw/`, no logs, no credentials, no screenshots, no stray archives. The two tracked files
      npm omits are the `.gitignore` files withheld by the gitignore fallback, and no untracked file entered the listing.
      No `files` field or `.npmignore` was added: the installed artifact is a local DSH file bundle that needs the
      repository layout, and restructuring packaging for a hypothetical registry distribution was explicitly out of scope.
- [x] **No DSH core source modification is required.** `cordis.patch.yml` only inserts the bundle row
      (`id: turn-performance-meter`, `name: dsh-turn-performance-meter`); the three top-level insert rows in the `web`
      profile's own patch layer are the user's unrelated plugins, not this project's. `index.js` is a by-design no-op host
      entry. `package.json`'s `dsh` section declares only `bundle.patch` and the client platform/inject keys. Nothing in
      the install path edits DSH, any `node_modules` file, or the shipped package — verified by the disposable-profile
      install, which produced a working composition from the shipped web template alone.
- [x] **Runtime smoke on the real host, at release state.** Observed in the real DSH `0.1.7-rc.2` web client, without
      `dev_reload_package` and without HMR as evidence. *Idle:* a session with no turn renders no meter at all
      (`.dsh-tpm-root` count `0`, stable over 2.5 s), so there is no live pill without an active turn. *Streaming:* a
      50 ms DOM recorder captured 1,390 samples over 190 s with states `pending-first-token` (11), `streaming-reasoning`
      (345), `streaming-output` (139), `tool-running` (233), `waiting-model` (657); every live rate carried `≈`
      (`思考 ≈202 tokens/s` → `输出 ≈212 tokens/s`), and an element screenshot captured
      `data-kind="live" data-state="streaming-output" aria-label="输出 · 16m22s"` showing `输出 ≈79.5 tokens/s`.
      *Tool-running:* `data-kind="live" data-state="tool-running"`, `aria-label="工具 · 4m25s"`, text
      `mcp__chrome-devtool… · 0.6s 4m25s` — the running tool, its own elapsed time, the tool wall timer, and no TPS
      value at all. The waiting-model samples show a stopwatch rather than a stale rate.
- [x] **Completed card, curve interaction and reload durability observed.** A settled session was re-opened in a second
      tab: `data-kind="completed" data-status="completed" data-quality="estimated" data-view="summary"
      data-session="session-e6b63be6-f770-4833-8664-fdf6ee9d29e6"`, rendering
      `思考 TPS ≈204 tokens/s · 111.0s · ≈22,625`, `输出 TPS ≈307 tokens/s · 143.5s · ≈44,044`,
      `生成 Tokens 66,669 tokens`, `总用时 643.3s`, `首响应 2.99 s`, footer `工具 113 · 101.7s`, `模型调用 109`. The card
      is static — its text and attributes were identical across three samples spanning 3 s — and contains no live pill.
      Hovering the `.dsh-tpm-card` flipped `data-view` `summary → curve` with `aria-hidden` swapping from
      `["false","true"]` to `["true","false"]`; clearing hover returned to `summary`; `card.focus()` produced the same
      `curve` state with `document.activeElement === card`; `blur()` returned to `summary`. The curve renders 178
      non-empty phase-coloured `<path>` segments at `viewBox="0 0 100 48"` with the peak marker `峰值 ≈646 tokens/s`.
      After a cache-ignoring reload the same session re-rendered the same card with every number identical and no resumed
      ticker (static across 4 s), and the served bundle hash above was captured in that same post-reload page.
- [x] **No new plugin console error.** The reload left three error classes, all pre-existing and none from this plugin:
      a `Permissions policy violation: unload` shell message, shell/other-plugin 404 polling, and
      `TypeError: useSessionPendingInteraction is not a function` whose stack is entirely inside the DSH shell bundle
      `index-Q6zc2uHV.js` with no frame from this plugin, plus its consequent
      `slot entry crashed in 'conversation.session.header.utilities'` — a slot this plugin never registers in. Both were
      already recorded as a pre-existing DSH shell template artifact in the Phase 7D rounds.
- [x] **Gates, reported as a LOCAL TEST RESULT because this repository still has no CI runner** (verified: no `.github/`
      in the tracked tree, so no workflow was added and none exists):
      `npm run build:client` → `client.js rebuilt (481581 bytes, mirrored to lib/client.js)`;
      `npm run verify` → **714 tests, 714 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**, `duration_ms` 1078.3746, with
      `structure OK (14 required files, 16 core modules, 63 test files, client bundle fresh, lib/client.js mirrored)`;
      `git diff --check` clean; `node scripts/verify-sanitization.mjs` passes.
- [x] **npm publication, git tag and GitHub Release: N/A in Phase 8 — not requested then.** The package remains
      `private: true` at version `0.1.0`; Phase 8 ran no `npm publish`, no `npm access`, no `git tag` and no
      `gh release create`, and the README/CHANGELOG of that phase stated the local-only distribution rather than
      implying a registry one. The git tag and the GitHub Release were created in the later `v0.1.0` publication round
      recorded below; npm publication remains permanently out of scope for this project, because the package stays
      `private: true`.
- [x] **Changelog added as a user-facing summary, kept short.** `CHANGELOG.md` carries one entry, `0.1.0 — local release
      candidate (initial release)`, listing the features a user sees and the supported DSH version. The Phase 7D.x
      internal defects are deliberately not restated there; they stay in `docs/IMPLEMENTATION_LOG.md`.
- [x] **Stale current-state statements fixed repo-wide, historical ones left alone.** `docs/DIRECTORY_TREE.md` gained the
      missing `fixtures/dsh-0.1.7/` corpus, `src/dsh/reconstruction.js`, the `dsh-017-*` contract test family, the
      curve-primitive/live-seam test families, and the real `dev/screenshots/` phase set. The `docs/START_PROMPT.md`
      "Phase 0 → Phase 8" instruction and the dated historical remarks inside Phase 7 sections were left untouched,
      because they are history rather than current state.

Acceptance gate: baseline verified and unchanged; DSH exactly `0.1.7-rc.2`; every frozen correctness semantic untouched;
README current and user-facing rather than scaffold/stale; `index.js` describing the real client-only architecture; the
install command verified against the local CLI and documented portably; known limitations and the exact compatibility
claim documented honestly; no DSH core source modification required; the tracked-tree secret/privacy audit and the fixture
sanitization gate passing with no raw originals tracked; package contents audited and the package still private; no
external publish, tag or release performed; `client.js` and `lib/client.js` byte-identical and the bundle fresh; full
`npm run verify` at 0 fail; `git diff --check` clean; the runtime smoke (idle, streaming, tool-running, completed card,
curve hover/focus, reload durability) observed on the real host with no new plugin console error; and the phase landed as
an ordinary fast-forward push with `HEAD == origin/main`, divergence `0 0` and a clean working tree, with no force
operation of any kind.

Known evidence boundaries carried into the release report: the Phase 7D.1 terminal-tail case is still **not reproduced in
a browser** (real recorded durable bytes + real feed/controller replay + the DSH bounded-window contract); the completed
card and curve were observed in this phase, so the Phase 7D.1.2 gap is closed; the `web` profile was **not** cold-restarted,
because the verifying session runs inside it; and `npm run verify` remains a local result rather than CI.

## v0.1.0 publication (2026-09-27)

**Status: release plan — pending publication.** The public GitHub Release of the frozen `0.1.0` state. Documentation and
release mechanics only: no metric semantics, UI, curve arithmetic, adapter, retention or eviction change, and no
`package.json` edit. This section fixes the contract *before* the tag and the Release exist, and therefore does not yet
claim that either exists; the round's outcome is reported in the round's own final report rather than in a post-tag
commit, so that `main` HEAD and `v0.1.0` remain the same commit.

- [x] **Preflight against the audited baseline, before any modification.** `git fetch origin` → `HEAD == origin/main ==
      80057aebc9ea4d6b1cb487a2f850a12ed4faf438`, `git rev-list --left-right --count HEAD...origin/main` → `0 0`, working
      tree clean. `& "$env:APPDATA\npm\dsh.cmd" --version` → `0.1.7-rc.2`; `npm list -g @deepseek-ai/dsh --depth=0` →
      `@deepseek-ai/dsh@0.1.7-rc.2`. `gh auth status` → authenticated to `github.com` as `HaowenCang` with the `repo`
      scope, so Release/tag write access was confirmed **before** the first irreversible step rather than after it; the
      target repository is `HaowenCang/dsh-turn-performance-meter`, visibility `PUBLIC`, default branch `main`.
- [x] **`v0.1.0` confirmed absent on all three surfaces.** Local tag list empty, `git ls-remote --tags origin
      refs/tags/v0.1.0` empty, `gh release view v0.1.0` exiting non-zero with `release not found`. Nothing was
      overwritten, moved or deleted — an existing tag or Release would have stopped the round instead.
- [x] **Version and privacy frozen.** `package.json` reads `0.1.0 true`; `npm version` is deliberately **not** run, so no
      second version commit exists and the mapping stays `v0.1.0 ↔ package.json 0.1.0`. `private: true` is retained and
      no compatibility claim was widened: DSH `0.1.7-rc.2` remains the only supported version.
- [x] **Release-state documentation commit.** `README.md` status and install sections, `CHANGELOG.md` heading and
      distribution status, this file and `docs/IMPLEMENTATION_LOG.md` were updated to describe a GitHub Release instead
      of a local release candidate. The README now separates the §3.1 release-asset path (`file:` on
      `dsh-turn-performance-meter-0.1.0.tgz`, the recommended immutable installation, with the `.sha256` sidecar check)
      from the §3.2 development path (`link:`), and no longer presents `link:` as the distribution form. The CHANGELOG
      heading is `0.1.0 — Initial release` with its feature list preserved and no Phase 7D.x internal chronology added.
- [x] **Gates re-run at release state, reported as LOCAL TEST RESULTS** (verified again: no `.github/` in the tracked
      tree, so this repository has no CI runner):
      `npm run build:client` → `client.js rebuilt (481581 bytes, mirrored to lib/client.js)`; `npm run verify` →
      **714 tests, 714 pass, 0 fail** with `structure OK (…, client bundle fresh, lib/client.js mirrored)`;
      `node scripts/verify-sanitization.mjs` → PASS; `git diff --check` → clean. `client.js`, `lib/client.js`,
      `src/**` and `package.json` carry no release-induced modification.
- [x] **Release asset built from the release commit and inspected.** `npm pack --pack-destination <repo-external temp>`
      produced `dsh-turn-performance-meter-0.1.0.tgz` (173 packaged files) outside the repository, so no temporary JSON
      or tarball entered the tree. The listing was checked for `node_modules`, `fixtures/raw`, `.env`, logs, credentials,
      `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.har`/`*.pcap`/`*.sqlite`/`*.db` and stray repository-root files, and required
      entries (`package/package.json`, `package/index.js`, `package/client.js`, `package/lib/client.js`,
      `package/cordis.patch.yml`, `package/README.md`, `package/LICENSE`) were confirmed present. The release-state
      documentation edit legitimately changes packed/unpacked bytes and the SHA-256 relative to Phase 8; the frozen
      figure is the file count, not the byte size.
- [x] **SHA-256 sidecar written as an ASCII line.** `dsh-turn-performance-meter-0.1.0.tgz.sha256` holds
      `<lowercase hash>  <asset name>`; both files are the two Release assets.
- [x] **The actual release tarball installed into a disposable profile.** A disposable profile was initialized from the
      shipped web template (`dsh --profile <probe> --from-default-profile web --dump-config`) and then given the packed
      tarball through the documented `file:` form. The composed configuration contains `dsh-turn-performance-meter` and
      `turn-performance-meter`, with no compatibility rejection. The user's `web` profile was not touched.
- [ ] **Cold-start smoke on that disposable profile — the check Phase 8 could not perform.** Phase 8 verified a
      disposable-profile install and a served-bundle identity, but explicitly did **not** cold-restart any host, because
      the verifying session ran inside the `web` profile. This round's procedure is: stop the first disposable host, run
      the same disposable profile again on a port confirmed free first, and confirm the host starts, the web app is
      reachable, the plugin loader is active and the `dsh-turn-performance-meter` client bundle is served with no plugin
      startup error. The disposable host's processes are then closed and the disposable profile deleted; the `web`
      profile is untouched throughout.
- [ ] **Annotated tag and GitHub Release created only after every gate passed.** `git tag -a v0.1.0 <release commit>`
      followed by an ordinary `git push origin v0.1.0` — no force, no `--force-with-lease`, no re-tag. The Release is
      created with the audited notes file, `--verify-tag`, and `--latest`, and **not** with `--prerelease`, `--draft` or
      `--generate-notes`, so `draft = false`, `prerelease = false` and `latest = true` on tag `v0.1.0`.
- [ ] **Published assets re-downloaded and verified.** The `.tgz` is downloaded back from the Release and its SHA-256
      compared against the pre-upload hash, with the sidecar contents cross-checked; a mismatch is reported as a release
      asset integrity failure rather than passed over. The downloaded tarball is additionally installed into a second
      disposable profile, closing the chain release commit → `npm pack` → GitHub upload → GitHub download → DSH install.
- [x] **No post-tag documentation commit, and no `npm publish`.** The round ends with `main` HEAD, the peeled `v0.1.0`
      commit and the Release target all on one commit, so `main` is not ahead of the tag. npm publication was never in
      scope: the package stays `private: true`.

Acceptance gate: baseline `80057aeb…` re-verified and unchanged at preflight; DSH exactly `0.1.7-rc.2`; `gh` authenticated
with repository Release/tag write access before the first irreversible action; `v0.1.0` absent locally, remotely and on
GitHub before creation; `package.json` still `0.1.0` + `private: true` with no second version commit; documentation
describing a GitHub Release rather than a local candidate; 714/714 tests, sanitization PASS and `git diff --check` clean at
release state; the tarball built outside the repository from the release commit, inspected, checksummed and installed into
a disposable profile; the exact release tarball cold-starting successfully in a fresh DSH `0.1.7-rc.2` profile; annotated
tag `v0.1.0` peeled to the release commit and pushed without force; Release published as final/latest with exactly the two
assets; re-downloaded asset SHA-256 equal to the pre-upload value; `HEAD == origin/main`, divergence `0 0` and a clean
working tree at the end; and no force, no re-tag, no tag or Release deletion, no `npm publish`, no `npm access` and no
widened compatibility claim at any point.

## v0.1.1 — npm distribution (2026-09-28)

**Status: release plan — npm publication pending.** This round changes distribution only. No metric semantics, live TPS,
TTFT, curve arithmetic, tool accounting, DSH adapter contract, retention behaviour or client cadence is in scope, and
`src/**`, `client.js`, `lib/client.js`, `index.js` and `cordis.patch.yml` carry no round-induced modification. The round
outcome is reported in the round's own final report rather than in a post-publication commit, so that `main` HEAD and
`v0.1.1` stay on one commit.

- [x] **Baseline preflight against the frozen `v0.1.0` release, before any modification.** `git fetch origin --tags` →
      `HEAD == origin/main == 9bd54431bbbaa5b7701939ebe64f598520700dd9`, `git rev-list --left-right --count
      HEAD...origin/main` → `0 0`, working tree clean. `git rev-list -n 1 v0.1.0` → the same commit, so `v0.1.0` was
      confirmed present and unmoved rather than re-created. `& "$env:APPDATA\npm\dsh.cmd" --version` → `0.1.7-rc.2`;
      `npm list -g @deepseek-ai/dsh --depth=0` → `@deepseek-ai/dsh@0.1.7-rc.2`.
- [x] **npm registry reachability and authentication confirmed before the manifest was touched.** `npm ping
      --registry=https://registry.npmjs.org/` → `PONG`; `npm whoami --registry=https://registry.npmjs.org/` → exit `0`.
      Every registry operation in this round names the official registry explicitly. No `.npmrc` was read, and no token,
      OTP or credential was printed, logged or written to any document.
- [x] **DSH runtime availability on the public registry recorded.** `npm view @deepseek-ai/dsh@0.1.7-rc.2 version` →
      `0.1.7-rc.2`. Dist-tags at the time of the round: `latest` → `0.1.7-rc.2`, `next` → `0.1.7-rc.2`, `alpha` →
      `0.1.7-alpha.2`. The plugin's compatibility claim was **not** widened because `0.1.7-rc.2` happens to be `latest`.
- [x] **Package-name availability gate.** `npm view dsh-turn-performance-meter --json` and
      `npm view dsh-turn-performance-meter@0.1.1 --json` both returned `E404`: the name was unoccupied and no existing
      package was overwritten, renamed or re-scoped.
- [x] **DSH compatibility mechanism read from the installed runtime instead of assumed.** `@deepseek-ai/dsh-plugin-manager`
      pre-reads a named registry spec with `pnpm view <spec> name version peerDependencies --json` and then calls
      `evaluatePluginCompatibility` from `@deepseek-ai/dsh-app-boot`, which compares each `@deepseek-ai/dsh` or
      `@deepseek-ai/dsh-*` peer against the running runtime version using
      `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`. The runtime version is read from
      `@deepseek-ai/dsh-app-boot/package.json`, which is `0.1.7-rc.2`. Checked directly against the bundled `semver`:
      `0.1.7-rc.2` → `true`, `^0.1.7-rc.2` → `true`, `0.1.8` → `false`, `0.1.7` → `false`. The exact range is therefore a
      real gate and not a permissive one.
- [x] **Import graph inspected before any peer was declared.** `git grep -n "@deepseek-ai/"` over `src`, `index.js`,
      `client.js`, `lib/client.js` and `package.json` found **no real import or require** of any DSH package: every hit is
      prose, and every production import is relative. The three `@deepseek-ai/dsh-*` names in `package.json` sit under
      `dsh.client.inject`, which names host-provided client modules shipped inside the DSH installation, not npm
      dependencies. Only `@deepseek-ai/dsh` was declared as a peer; no `@deepseek-ai/dsh-*` peer was added mechanically.
- [x] **`package.json` converted to a public npm distribution.** `version` → `0.1.1`; the `private` field was **removed**
      rather than set to `false`; `peerDependencies` → `{ "@deepseek-ai/dsh": "0.1.7-rc.2" }` exactly;
      `publishConfig` → `{ "access": "public", "registry": "https://registry.npmjs.org/" }`; `repository`, `homepage`,
      `bugs` and `keywords` added. No personal email, no guessed `engines.node`, and no `preinstall` / `install` /
      `postinstall` / `prepare` script was introduced — the package remains a prebuilt artifact.
- [x] **Runtime-only `files` allowlist, with the entry points proven self-contained first.** `index.js` is a 714-byte
      no-op host entry with no imports, and `client.js` is a self-contained browser bundle with no runtime file read and
      no reference to `src/`. The allowlist is `index.js`, `client.js`, `lib/client.js`, `cordis.patch.yml`, `README.md`,
      `CHANGELOG.md`, `LICENSE`; `package.json` is auto-included, and `src/`, `test/`, `fixtures/`, `dev/`, `scripts/` and
      `docs/` are excluded. The repository-side `npm run verify` still requires `docs/**`, which stays in the checkout.
- [x] **Documentation moved from a GitHub-Release-only description to an npm-first description.** `README.md` status block
      now reads `Version: 0.1.1`, `Supported/tested: DSH 0.1.7-rc.2 only`, primary distribution npm, fallback the GitHub
      Release `.tgz`, development the `link:` checkout; §3 was restructured into the DSH `0.1.7-rc.2` prerequisite, the
      npm default install (unversioned and pinned, with an explicit note that the unversioned form resolves npm's
      `latest` dist-tag), the tarball fallback and the development checkout. The README paragraph that stated no
      compatibility-range field was declared — true of `0.1.0`, false of `0.1.1` — was replaced with the mechanism above.
      `CHANGELOG.md` gained `## 0.1.1 — npm distribution` and a corrected distribution-status line.
- [x] **Gates re-run at release state, reported as LOCAL TEST RESULTS** (this repository still has no CI runner):
      `npm run build:client` → `client.js rebuilt (481581 bytes, mirrored to lib/client.js)`, with `client.js` and
      `lib/client.js` left byte-identical to the committed bundle; `npm run verify` → **714 tests, 714 pass, 0 fail** with
      `structure OK (14 required files, 16 core modules, 63 test files, client bundle fresh, lib/client.js mirrored)`;
      `node scripts/verify-sanitization.mjs` → PASS; `git diff --check` → clean. `git diff -- src client.js
      lib/client.js index.js cordis.patch.yml` is **empty**: no production byte changed in this round.
- [x] **`npm publish` dry-run PASS.** `npm publish --dry-run --access public --tag latest
      --registry=https://registry.npmjs.org/` reported `dsh-turn-performance-meter@0.1.1`, 8 files, 294.4 kB packed,
      1.0 MB unpacked, shasum `55efeb484148e46a8749c7e1fb48acfcec5ee5ec`. The file list is exactly the runtime allowlist
      plus the auto-included `package.json`; no `src/`, `test/`, `fixtures/`, `dev/`, `scripts/`, `docs/`, `node_modules/`,
      `.env`, credential, log or raw fixture appears.
- [x] **Tarball built outside the repository and content-audited.** `npm pack --pack-destination <repo-external temp>`
      produced `dsh-turn-performance-meter-0.1.1.tgz`, whose `tar -tf` listing is `package/LICENSE`, `package/client.js`,
      `package/lib/client.js`, `package/index.js`, `package/package.json`, `package/CHANGELOG.md`, `package/README.md`,
      `package/cordis.patch.yml` — 8 entries and no excluded path. Nothing was written into the working tree.
- [x] **Packed manifest inspected field by field.** Extracted from the tarball: `name`, `version` `0.1.1`, no `private`
      field, `peerDependencies` exactly `{ "@deepseek-ai/dsh": "0.1.7-rc.2" }` as the only peer, `dsh.bundle.patch`
      `./cordis.patch.yml`, `exports` `.` → `./index.js` and `./client` → `./client.js`, `publishConfig.registry`
      `https://registry.npmjs.org/`, no lifecycle install script, no `engines`, no author/email.
- [x] **The actual release tarball installed into a disposable profile.** A disposable profile was initialized from the
      shipped web template (`dsh --profile <probe> --from-default-profile web --dump-config`) and then given the packed
      tarball through the documented `file:` form. The install succeeded with exit `0` and no `incompatible-version`
      rejection. `dsh-turn-performance-meter` appears in the profile's `dependencies` and in `dsh.profile.bundles`, and
      `turn-performance-meter` appears in the composed configuration. The installed manifest reads `version` `0.1.1` and
      peer `@deepseek-ai/dsh` `0.1.7-rc.2`; the installed file set is the same 8 runtime files, and the installed
      `client.js` SHA-256 equals the repository's. pnpm reported an unsatisfied-peer warning and did **not** auto-install
      `@deepseek-ai/dsh`; DSH's own runtime gate passed. The user's `web` profile was not touched.
- [x] **Cold start on that disposable profile — the runtime-only tarball question.** `dsh --profile <probe> --port
      <free-port> --no-open` started with a clean log (the only line is the printed URL) and no compatibility or plugin
      startup error. `GET /` returned `200`; the startup combo route listed `dsh-turn-performance-meter/client.js` and,
      fetched, returned `200` with the plugin bundle **present verbatim** — the served combo contains the repository
      `client.js` and the installed `client.js` byte-for-byte, probed at five offsets. The runtime-only npm tarball
      therefore cold-starts correctly. The host process was then closed, the port confirmed free and the disposable
      profile deleted.
- [ ] **Release commit pushed before publication.** `git add package.json README.md CHANGELOG.md
      docs/IMPLEMENTATION_LOG.md docs/TASKS.md`, one commit, one ordinary fast-forward `git push origin main`, then
      `HEAD == origin/main` and divergence `0 0` re-checked. No force.
- [ ] **`npm publish` — the first irreversible registry action.** Only after the pushed commit is re-verified and the
      version is still absent from the registry. If interactive 2FA cannot be completed safely in this environment, the
      round stops and reports the partial state rather than bypassing the control; no OTP is written to chat, docs,
      command history or report.
- [ ] **Registry metadata and artifact integrity verified, and the tarball downloaded back.** `dist-tags` must show
      `latest` → `0.1.1`; the version's peer must read `0.1.7-rc.2`; `dist.tarball`, `dist.integrity` and `dist.shasum`
      are recorded; and `npm pack` of the published version must reproduce `dist.shasum` and `dist.integrity`. The
      prepublish and registry tarballs are compared byte-first and, if the archive bytes differ, file-by-file.
- [ ] **Exact-version and unversioned registry installs, then a registry-installed cold start.** Two further disposable
      web-template profiles take `dsh-turn-performance-meter@0.1.1` and then the bare `dsh-turn-performance-meter` — the
      second being the command a user actually runs. Both must install `0.1.1`, enable the bundle automatically and place
      `turn-performance-meter` in the composition; the unversioned profile is then cold-started. All disposable profiles
      and processes are removed afterwards, and the real `web` profile is neither modified nor restarted.
- [ ] **Annotated tag and GitHub Release.** `git tag -a v0.1.1 <release commit>` and an ordinary `git push origin
      v0.1.1`, then a Release whose assets are the **registry-downloaded** tarball plus a `.sha256` sidecar, created with
      `--verify-tag` and `--latest` and without `--draft` or `--prerelease`.

Acceptance gate: baseline `9bd54431…` re-verified and unchanged at preflight with `v0.1.0` still pointing at it; DSH
exactly `0.1.7-rc.2` both installed and available on the official registry; npm authentication valid before any manifest
change; the package name unoccupied; the DSH peer evaluator read from the runtime and an exact, non-permissive peer
declared on the strength of an inspected import graph; `package.json` public, version `0.1.1`, `private` absent,
`publishConfig` locked to `https://registry.npmjs.org/`; the npm artifact reduced to the 8 runtime files with the
production diff empty; 714/714 tests, sanitization PASS and `git diff --check` clean at release state; the tarball built
outside the repository, audited entry by entry and manifest-checked, then installed and cold-started in a disposable DSH
profile; the release commit pushed without force before publication; `npm` publishing `0.1.1` with `latest` → `0.1.1`;
the registry artifact reproducing the local digest and matching the GitHub asset; the exact-version install, the
unversioned standard install and a registry-installed cold start all passing; annotated tag `v0.1.1` peeled to the release
commit; `HEAD == origin/main` with divergence `0 0` and a clean working tree at the end; and no force, no re-tag, no
`v0.1.0` movement, no `npm unpublish` and no widened compatibility claim at any point.

## Phase 9 — Completed Card Collapse & DSH Surface Alignment

- [x] **Baseline re-verified before any edit.** `HEAD == origin/main ==
      24f69c2c82901aed133ba3465d59b0f1fb584bf4`, divergence `0 0`, working tree clean, `v0.1.1` peeled to the same
      commit, DSH `0.1.7-rc.2` installed and confirmed by `npm list -g @deepseek-ai/dsh --depth=0`.
- [x] **The host visual contract read from DSH source, not estimated from a screenshot.** The installed package ships no
      `src/`, so `TodoPanel.module.css` was read out of `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`, where the
      sheet is embedded under its plugin-CSS tag, together with the `TodoPanel` component's own structure — `useState(true)`,
      a single `button` header with `aria-expanded`, the `lead / title / progress / chevron` order and the bundled chevron
      direction. Exact rules recorded in `IMPLEMENTATION_LOG.md`.
- [x] **Completed root adopts the host dock width formula**, scoped to `[data-kind="completed"]` so the live root keeps
      its own contract: two `--dsh-composer-side-clearance`, four `--dsh-composer-dock-inset`, `--dsh-composer-card-max-width`
      and `margin: 0 auto`.
- [x] **Completed surface replaced with host tokens.** `border: 0`, `--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)`,
      `border-radius: var(--dsw-radius-lg)`, `background: var(--dsw-specific-menu)`,
      `backdrop-filter: var(--dsh-menu-backdrop-filter)`, `box-shadow: var(--dsw-elevation-panel)`, `overflow: hidden`.
      No hex, no `rgba()`, no 10 px radius and no `.5px` outer stroke remain on this surface; the live pill keeps all four
      of its own, asserted by test.
- [x] **Collapsed / expanded presentation state, pure and tested.** `defaultCompletedPresentationState()` and
      `nextCompletedPresentation()` added to `src/client/completed/view-mode.js`; `nextViewMode` retained unchanged as the
      mode half. Collapsing resets the mode, so re-expanding always opens the summary; `enter`/`focus` on a collapsed card
      are no-ops.
- [x] **Default collapsed on every new materialization.** A single effect in `CompletedMeter.js`, keyed on the view
      identity, resets curve view and presentation together, so a new turn, a session switch-back and a page reload all
      arrive collapsed. Nothing is persisted: no session log, no `localStorage`, no profile config.
- [x] **Compact header carrying a real one-line summary.** `src/client/completed/compact-summary.js` composes the row from
      `view.status` and the already-formatted `view.columns[i].display` values and recomputes nothing; an unavailable
      reading is the em dash, and a dash never grows a unit. New locale key `performanceTitle` (`Performance` / `性能`).
- [x] **Header and curve separated by element.** The curve handlers and the focus stop move to `.dsh-tpm-detail`; the
      toggle button owns expand/collapse only. Tab order is toggle → detail, and header focus leaves `data-view` at
      `summary`.
- [x] **Detail padding moved rather than stacked.** The card shell takes the host's `6px 12px` / `gap: 8px`; the detail's
      inline padding becomes `14px` and the footer's inline margin `12px`, keeping the measured 26 px to the first label.
      The old `padding: calc(var(--dsh-tpm-font) * 1.55) 0` is gone from the outer card.
- [x] **`data-view` semantics preserved and the collapse kept separate.** `data-collapsed="true|false"` is a new attribute;
      `data-view` stays `summary|curve` and reads `summary` while collapsed.
- [x] **No timer regression.** The completed card arms nothing: asserted by reading the component sources and, in the
      browser harness, by counting the timers the component asked the host to arm across expand, collapse and a new turn.
- [x] **Automated gates.** `npm run build:client` (deterministic, mirrored); `npm run verify` → 747 tests, 747 pass, 0 fail,
      0 cancelled, 0 skipped, 0 todo, `structure OK (14 required files, 16 core modules, 64 test files, client bundle
      fresh, lib/client.js mirrored)`; `node scripts/verify-sanitization.mjs` → PASS; `git diff --check` → clean.
- [x] **Real-browser acceptance on DSH `0.1.7-rc.2`.** Computed-style equality with the live `[data-testid="todo-panel"]`
      for `borderRadius`, `backgroundColor`, `boxShadow`, `backdropFilter` and `borderTopWidth`, in light **and** dark;
      geometry deltas of `0` px on left, right and width; collapsed / expanded / curve / header-focus / reload behaviour
      driven through the real DOM; the live pill measured unchanged beside it. Screenshots in `dev/screenshots/phase9/`
      (gitignored, retained locally).
- [x] **Production diff confined to the completed card.** `git diff --name-only 24f69c2c...HEAD` touches
      `src/client/completed/**`, `src/client/live/locale.js`, the two generated bundle mirrors, `test/**`, `docs/**` and
      `CHANGELOG.md` only. `src/core/**`, `src/dsh/**` and `src/host/**` are unchanged.
- [x] **Version and release freeze held.** `package.json` remains `0.1.1`; no `npm version`, no `npm publish`, no
      `git tag`, no `gh release create`, and `v0.1.1` is not moved.
- [ ] **`v0.1.2` release.** Deliberately out of scope for this round and not started: it follows an independent review of
      Phase 9, in its own cycle.

Acceptance gate: the reviewed surface is the host's TodoPanel surface, token for token, verified by computed style
against the live panel in both themes and by a `0` px geometry delta; the collapsed row is the default for every new
materialization and carries the status plus all four readings without recomputing any of them; the expanded detail keeps
the Phase 5 four-column grid, footer and hover/focus curve unchanged; the curve, the header and the toggle stay on
separate elements so keyboard focus on the toggle cannot reveal a chart; no metric, curve, adapter, store or retention
semantics changed; and the version, the tag and the release state are exactly as they were at the baseline.

## Phase 9.3 — DSH 0.2.0-rc.2 compatibility migration (complete)

- [x] **Baseline re-verified before any edit.** `HEAD == origin/main ==
      b59de4854b3619651b81b386e38874b240e2413b`, divergence `0 0`, working tree clean, `dsh --version` →
      `0.2.0-rc.2`, `npm list -g @deepseek-ai/dsh --depth=0` → `@deepseek-ai/dsh@0.2.0-rc.2`. The Phase 9.2 commits
      `291e321` and `b59de48` were treated as the production candidate; neither was reverted and Phase 9.2 was not
      restarted.
- [x] **Upstream contract audit by blob hash, not by eye.** All fourteen declarations the plugin reads were resolved at
      both reference commits (`477b4f420553e8a52c2fbccc464d7561b239c443` and
      `639ed015397290b3745d163aafe02ffee4aa3f84`) with `git rev-parse <sha>:<path>` in a local checkout of
      `deepseek-ai/deepseek-harness` and compared. **14 of 14 identical.** Recorded in `docs/DSH_API_NOTES.md` §14.2.
- [x] **Installed-runtime confirmation, because the published package ships no `src/`.** Each contract was re-read from
      the installed `0.2.0-rc.2` tree — `dsh-session/lib/types/types.d.ts` (envelope, `turn/*`, `assistant/*`, `tool/*`),
      `dsh-llm/lib/types/types.d.ts` and `assistant-stream.d.ts` (`StreamChunk`, `AssistantStreamRecord`, `isTokenDelta`),
      `dsh-api-session-controller/lib/types/client/contract/events.d.ts` (`AssistantLiveChunkEvent`,
      `SessionEventChange`, `SessionEventWindow`) and `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`
      (`conversation.input.dock`). Declaration sites in §14.3.
- [x] **The compatibility gate's own semantics measured, not assumed.** `evaluatePluginCompatibility` was imported from
      the installed `dsh-app-boot` and invoked against the real manifest: with the declared peer it returns `undefined`
      (no incompatibility at all), while the control — the previous `0.1.7-rc.2` peer — returns an issue with
      `exempted: false`. The `semver.satisfies(..., { includePrerelease: true })` matrix is recorded in §14.4.
- [x] **Peer migrated to an exact version.** `peerDependencies` is now `{ "@deepseek-ai/dsh": "0.2.0-rc.2" }` — exact, the
      only peer, with no `^`, `~`, `>=`, `0.2.x`, `*` and no `0.1.7-rc.2 || 0.2.0-rc.2`. No exemption is used as a
      substitute and none is required.
- [x] **Dual-version compatibility deliberately not claimed.** The `v0.1.1 → 0.1.7-rc.2` and `v0.1.2 → 0.2.0-rc.2` matrix
      is documented as two separately bounded claims rather than one range, so the evidence boundary between the releases
      survives.
- [x] **No adapter migration invented.** Because the audited contracts are identical, `src/dsh/**` moved no code. The one
      edit in that tree is `src/dsh/index.js`'s header, which is the normative "the target runtime is X" statement; the
      remaining `0.1.7-rc.2` references in `src/dsh/**` are the dates of the audits that established each shape and were
      deliberately left as historical provenance. `src/core/**` and `src/host/**` are untouched.
- [x] **Narrow 0.2.0 contract layer added.** `test/dsh-020-contract.test.js` (17 tests) pins the envelope, the turn
      boundaries, both settlement types, the tool plane, the transient row, compact-stream `time0`+`dt` reconstruction,
      the five consumed `StreamChunk` variants, in-stream usage and its supersession, all four window-change kinds, the
      `settle-assistant` retirement/abandonment resolution, one end-to-end turn and the 100 ms cadence. The historical
      `test/dsh-017-*.test.js` files were **not** renamed or restamped.
- [x] **Documentation updated without rewriting history.** Current-target statements moved to `0.2.0-rc.2` and the new
      reference commit in `README.md` (§2.1 compatibility baseline, §3.1 prerequisite matrix), `docs/ARCHITECTURE.md`
      (Phase 9.3 subsection), `docs/DSH_API_NOTES.md` (§14, with §13 marked superseded-not-retracted),
      `docs/METRICS_SPEC.md` (no metric changed), `docs/TEST_PLAN.md` (§10), `docs/DIRECTORY_TREE.md` and `CHANGELOG.md`.
      Phase 7/8/9 records that state they occurred on `0.1.7` remain `0.1.7`.
- [x] **Automated gates.** `npm run build:client` → `client.js rebuilt (522309 bytes, mirrored to lib/client.js)`;
      `npm run verify` → **763 tests, 763 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**, `structure OK (14 required
      files, 15 core modules, 64 test files, client bundle fresh, lib/client.js mirrored)`;
      `node scripts/verify-sanitization.mjs` → PASS; `git diff --check` → clean.
- [x] **Runtime smoke on DSH `0.2.0-rc.2`.** Plugin loads, no compatibility rejection, no exemption; the meter mounts in
      `conversation.input.dock`; an idle session shows no meter; a live turn shows the meter; the settled card appears
      collapsed; expanding reveals the four-column summary; the hover/focus curve still renders both series; a reload
      reconstructs the card from durable evidence; two sessions stay isolated while both are attached; the console shows
      no plugin error.
- [x] **TPS acceptance against the phase's own target.** DOM metric cadence median **100 ms**; the reasoning → output
      phase transition observed; last live values and final settled values recorded for four turns, each matching the
      durable authoritative token totals exactly (6,799 / 1,652 / 3,701 / 1,934).
- [x] **Tool-state acceptance.** Tool-running states observed with the tool name and its own duration, TPS absent while a
      tool executes, and each following model attempt opening a fresh phase episode (counter reset to `0.01s`–`0.11s`).
      Eleven tool calls matched eleven results with `unmatchedToolResults` 0 and `turnEndLookupMiss` 0; eight bare
      `settle-assistant` calls were all resolved as retirements with zero abandonments.
- [x] **Package-install evidence in a disposable 0.2.0 profile.** `dsh --profile p93-rc2 --from-default-profile web`
      initialised the profile, then `dsh plugin --profile p93-rc2 add
      "link:E:/Projects/DSHarness/dsh-turn-performance-meter"` exited `0` with no incompatible-plugin rejection,
      `compatibility.json` **absent** (no exemption), and `dsh.profile.bundles` containing the package automatically. The
      profile was cold-started once and served the plugin normally, then deleted. The real `web` profile was not modified:
      its `package.json` SHA-256 is unchanged before and after.
- [x] **API-error exclusion honoured.** No 422/429/503 investigation, no provider configuration, endpoint or retry-policy
      repair, and no test added for those failures. The one error turn encountered was inside the disposable profile
      (missing model credential there) and is recorded as an environment failure rather than diagnosed.
- [x] **Version and release freeze held.** `package.json` remains `0.1.1`; no `npm version`, no `npm publish`, no
      `git tag`, no `gh release create`; `v0.1.1` is not moved.
- [x] **One non-reproducible presentation observation recorded, not investigated.** In a single sequence — page reloaded,
      then a new turn settled while the tab was not foreground — the completed card continued to display the previous
      turn's values until the page was reloaded again. It did not reproduce: the same page later advanced correctly to a
      new turn's card under the same conditions, and every card's numbers matched the durable log exactly. It involves no
      DSH contract, so it is recorded as an observation for a future round rather than pursued here. **Resolved in Phase
      9.3.1 — see below.**
- [ ] **`v0.1.2` release.** Deliberately out of scope and not started.

Acceptance gate: the normative runtime is `0.2.0-rc.2` and the exact peer declares it; every DSH declaration the plugin
consumes was re-audited against both the public reference commit and the installed runtime and found unchanged, so no
adapter, metric, curve, store or presentation semantics moved and no compatibility exemption is involved; the automated
suite passes with `fail = 0`; the plugin was observed working end to end on the new runtime with its Phase 9.2 TPS
semantics intact and its four settled cards numerically equal to the durable log; and the version, the tag and the
released artifacts are exactly as they were at the baseline.

## Phase 9.3.1 — Background settlement presentation verification (complete)

The Phase 9.3 observation above is the whole subject: after a page reload, a turn settled while the tab was backgrounded
and the completed card kept showing the previous turn until another reload. Metric semantics, the 100 ms cadence, curve
arithmetic, the DSH adapter, tool accounting, the visual design and the package version were frozen for this round; a
production change was permitted only if a reproducible presentation defect demanded a minimal one.

- [x] **Deterministic regression added first.** `test/background-settlement.test.js` (5 tests) ingests a settlement and a
      terminal boundary with **zero** projections interleaved — the structural equivalent of a throttled background tab —
      and requires the first projection afterwards to be the newest settled turn, its identity to be distinct from the
      previous card, its completed identity to follow the newest settled turn, and one 100 ms tick after both events to
      render that same turn. It covers both arrival shapes (a live record closed by `turn/end`, and a settlement
      reconstructed from durable evidence with no record), and it was checked against a deliberately defeated controller
      (the `turn/end` invalidation removed): all five tests fail there, and the first projection returns the previous
      card.
- [x] **Real-browser reproduction attempted 11 times on DSH `0.2.0-rc.2`.** A second isolated web host
      (`127.0.0.1:50077`, its own `DSH_HOME`, the plugin mounted from the workspace) ran the recorded sequence with a
      fresh session per trial: card for turn N visible after a full page reload → turn N+1 started → browser window
      minimized → turn N+1 settled → ≥1 s dwell → window restored with **no page reload**. Trial 11 is the stronger
      construction: it prepares two turns first, so the card it starts from is a *replacement* the store already holds
      (the advance observed is 2 → 3).
- [x] **11/11 trials advanced to the latest card without a reload; 0/11 stale-card reproductions.** In every
      minimize-verified trial the card had already advanced *before* the window was restored
      (`requestAnimationFrame` gaps of 1000–1004 ms while minimized), so the foreground-to-correct-card latency was 0 ms.
      Durable newest settled turn, store newest settled turn and DOM `data-turn` agreed in all eleven, with the
      generated-token column displaying the durable total.
- [x] **No production fix applied, and none warranted.** No metric arithmetic, adapter contract, cadence, curve, tool
      accounting, visual design or package version moved. The only source change is a docstring in
      `src/client/live/MeterRoot.js` whose `isStatic` description had named `hidden` — a case the function never handled
      and which the ticker's own lifecycle treats separately.
- [x] **Gates.** `npm run build:client` (bundle byte-identical to the committed one), `npm run verify` (`fail = 0`),
      `node scripts/verify-sanitization.mjs` (PASS), `git diff --check` (clean).
- [ ] **`v0.1.2` release.** Still deliberately out of scope: no `npm publish`, no tag, no GitHub Release.

Acceptance gate: the deterministic regression passes and is load-bearing on the baseline commit; eleven real-browser trials
of the recorded sequence all advance the completed card to the newest settled turn with no reload; durable, controller
and DOM newest-turn identities agree in every trial; and no production behaviour changed, so the round is a verification
result rather than a fix.

## v0.1.2 — DSH 0.2.0 and cumulative TPS (2026-09-29)

**Status: release round — npm publication pending.** This round releases Phase 9, 9.2 and 9.3, which are already in the
tree; it adds no feature and changes no metric. `git diff -- src client.js lib/client.js index.js cordis.patch.yml` is
**empty** at release state, so no production byte moved. It discharges the last open item of Phase 9.3.1 ("`v0.1.2`
release — still deliberately out of scope"). The outcome of the round is reported in the round's own final report rather
than in a post-publication commit, so that `main` HEAD and `v0.1.2` remain the same commit.

- [x] **Baseline preflight against the frozen `v0.1.1` release, before any modification.** `git fetch origin --tags` →
      `HEAD == origin/main == 5e697d8577501f16662f385c099eae1f8ca13af3`, divergence `0 0`, working tree clean.
      `git rev-list -n 1 v0.1.0` → `9bd54431bbbaa5b7701939ebe64f598520700dd9` and `git rev-list -n 1 v0.1.1` →
      `24f69c2c82901aed133ba3465d59b0f1fb584bf4`: both tags present and unmoved rather than re-created. `git rev-parse
      v0.1.2` → `unknown revision` (exit `128`), so the tag is absent. `dsh --version` → `0.2.0-rc.2`;
      `npm list -g @deepseek-ai/dsh --depth=0` → `@deepseek-ai/dsh@0.2.0-rc.2`.
- [x] **Pre-release test hygiene corrected, without touching behaviour.** The `harness()` object in
      `test/background-settlement.test.js` carried an unused member
      `record: turnNumber => controller.store.turns.get(turnKey(SESSION, turnNumber)) ?? null` referencing a `turnKey`
      that the file never imported. It was dead — the only occurrence of the name in the file was its own definition, and
      no call site existed — so it was **removed entirely** rather than satisfied with a new import. One line deleted, no
      production file touched.
- [x] **Release manifest.** `version` `0.1.1` → `0.1.2`. The peer is unchanged and still exact:
      `"peerDependencies": { "@deepseek-ai/dsh": "0.2.0-rc.2" }`, the only declared peer, and **not** widened to `^`, `~`,
      `>=`, `0.2.x` or a dual range. `publishConfig.registry` remains `https://registry.npmjs.org/` with `access: public`,
      the `files` allowlist remains runtime-only, and no `preinstall` / `install` / `postinstall` / `prepare` script was
      introduced.
- [x] **One release-induced test pin updated, and recorded as such rather than folded into the hygiene item.**
      `test/dsh-020-contract.test.js` asserted `manifest.version === '0.1.1'` with the comment that the bump to `0.1.2`
      "belongs to the later release phase". This round *is* that phase, so the assertion now reads `0.1.2`; the peer
      assertions around it — exact pin, single peer, no range syntax, exact-prerelease shape — are untouched. **This is
      the only test assertion the version bump invalidated**, established by grepping the suite for the old version.
- [x] **Release-facing documentation updated.** `README.md`: banner, §2 status block, §3.1 prerequisite table, §3.2 pinned
      install, §3.3 tarball/asset names and §7 repository map all move to `0.1.2`; the release matrix keeps both rows
      (`v0.1.1 → DSH 0.1.7-rc.2`, `v0.1.2 → DSH 0.2.0-rc.2`) and no historical `0.1.7` evidence was rewritten.
      `CHANGELOG.md`: `## Unreleased` promoted to `## 0.1.2 — 2026-09-29` with the release highlights, and the explicit
      statement that **no support claim is made beyond DSH `0.2.0-rc.2`**.
- [x] **Two stale metric paragraphs corrected in `README.md` §5, as documentation alignment only.** §5 still described
      the live meter as a "current trailing 1-second window" and §5.2 still described the curve as an "attempt-local
      trailing-one-second total throughput trace" summing `(t - 1000, t]`. Both were superseded by Phase 9.2 and
      contradicted `docs/METRICS_SPEC.md` §6/§8 — and `docs/METRICS_SPEC.md` §6 states that no trailing window exists
      anywhere in the rate path — while the same README §1 already described the phase-cumulative estimator. The two
      paragraphs now state the phase-cumulative statistic, the phase-local reset, the hyperbolic stall decay, the 100 ms
      sampling grid, the 200-point published-series cap and the 512-point chart render budget. No code, test or arithmetic
      changed; the correction makes the shipped README agree with the shipped behaviour it was already claiming in §1.
- [x] **Gates re-run at release state, reported as LOCAL TEST RESULTS** (this repository still has no CI runner):
      `npm run build:client` → `client.js rebuilt (522682 bytes, mirrored to lib/client.js)`, **byte-identical** to the
      committed bundle, so `git status` shows no bundle change; `npm run verify` → **768 tests, 768 pass, 0 fail**, with
      `structure OK (14 required files, 15 core modules, 65 test files, client bundle fresh, lib/client.js mirrored)`;
      `node scripts/verify-sanitization.mjs` → PASS; `git diff --check` → clean; and `client.js` and `lib/client.js` both
      SHA-256 `de920a21219e8d01c77703d18ec0dcd884975595b5fdbc6198f77c87d497138f`.
- [x] **npm registry reachability confirmed, and an authentication blocker found and reported rather than worked
      around.** `npm ping --registry=https://registry.npmjs.org/` → `PONG 1396ms`. `npm whoami
      --registry=https://registry.npmjs.org/` → **E401 Unauthorized** (the same round-1 probe returned exit `0` on
      `0.1.7-rc.2`). `~/.npmrc` does contain a `//registry.npmjs.org/:_authToken` entry, and an authenticated
      `npm access list packages` also returns E401, so the stored credential is rejected for authenticated operations
      while public reads still succeed (`npm owner ls` → `evan-williams <canghw2023@foxmail.com>`, exit `0`). **No token,
      OTP or credential value was printed, logged, written to any document or recorded in this round.** Publication is
      therefore blocked on the operator's credential, and no authentication control was bypassed.
- [x] **Name and version state recorded before publication.** `npm view dsh-turn-performance-meter versions --json` →
      `["0.1.1"]`; `npm view … dist-tags --json` → `{ "latest": "0.1.1" }`; `npm view
      dsh-turn-performance-meter@0.1.2 --json` → **E404**. Version `0.1.2` is absent, nothing is overwritten, and the
      publication precondition holds independently of the credential blocker.
- [x] **`npm publish` dry-run PASS.** `npm publish --dry-run --access public --tag latest
      --registry=https://registry.npmjs.org/` reported `dsh-turn-performance-meter@0.1.2`, **8 files**, 320.8 kB packed,
      1.1 MB unpacked, shasum `44655177439d2125d0f289a796d7108867813be6`. The file list is exactly the runtime allowlist
      plus the auto-included `package.json`; no `src/`, `test/`, `fixtures/`, `dev/`, `scripts/`, `docs/`,
      `node_modules/`, credential, log or raw fixture appears.
- [x] **Canonical tarball built outside the repository and audited.** `npm pack --pack-destination
      <repo-external temp>` produced `dsh-turn-performance-meter-0.1.2.tgz` (320 830 bytes) whose `tar -tf` listing is
      `package/LICENSE`, `package/client.js`, `package/lib/client.js`, `package/index.js`, `package/package.json`,
      `package/CHANGELOG.md`, `package/README.md`, `package/cordis.patch.yml` — 8 entries, no excluded path, nothing
      written into the working tree. Recorded digests: SHA-256
      `ade4a3c2e9ebf0ed75761755426a834cff0b3af3f76abdf797e8e93ab0177396`, SHA-1
      `44655177439d2125d0f289a796d7108867813be6`, SHA-512 integrity
      `sha512-6hZHHzcVadVGD8/Y5KKeR2MqNKqlK9wmbaJU+ENoOXyilYfKd6Z3uFSGwpGcHVdt/I+A/IVN+4PN453Pt4T+Ew==`. The SHA-1 and
      the integrity both reproduce the values npm computed for the dry-run artifact.
- [x] **Packed manifest inspected field by field.** Extracted from the tarball: `version` **`0.1.2`**,
      `peerDependencies` exactly `{ "@deepseek-ai/dsh": "0.2.0-rc.2" }` as the only peer, `publishConfig.registry`
      `https://registry.npmjs.org/`, `dsh.bundle.patch` `./cordis.patch.yml` present, **no** `private` field, and **no**
      lifecycle install script (only `test`, `build:client` and `verify`).
- [x] **The actual release tarball installed into a disposable web-template profile.** The profile was initialized with
      `dsh --profile <probe> --from-default-profile web --dump-config` and then given the packed tarball through the
      documented `file:` form. Install exited `0` with **no** `incompatible-version` rejection and **no** compatibility
      exemption. `dsh-turn-performance-meter` appears in the profile's `dependencies` and in `dsh.profile.bundles`, and
      `turn-performance-meter` appears in the composed configuration. The installed manifest reads `version` `0.1.2` and
      peer `@deepseek-ai/dsh` `0.2.0-rc.2`, has no `private` field and no lifecycle script, ships the same 8 runtime
      files, and its `client.js` SHA-256 equals the repository's.
- [x] **Cold start on that disposable profile.** The host started on a free port with a log whose only line is the
      printed URL, so no plugin startup error and no compatibility error occurred. `GET /` returned `200` with the plugin
      registered at `plugins/??dsh-turn-performance-meter/client.js&rev=10a2b2980515`; that route returned `200` and its
      payload contains the repository `client.js` **verbatim at offset 0**, the only difference being an 83-character
      trailing `//# sourceMappingURL` directive added by the module server. The host was then stopped, the port confirmed
      free and the disposable profile deleted; the real `web` profile was neither modified nor restarted.
- [ ] **Release preparation commit pushed before publication.** `git add package.json README.md CHANGELOG.md
      docs/TASKS.md docs/IMPLEMENTATION_LOG.md test/background-settlement.test.js test/dsh-020-contract.test.js`, one
      commit, one ordinary fast-forward `git push origin main`, then `HEAD == origin/main` and divergence `0 0` re-checked.
      No force.
- [ ] **Gates re-run from the exact pushed release commit, and the tarball re-packed from it.** `npm run build:client`,
      `npm run verify`, `node scripts/verify-sanitization.mjs` and `git diff --check` are re-run at the pushed commit and
      the artifact is re-packed there; the prepublish tarball is **not** reused.
- [ ] **`npm publish` — the irreversible registry action, currently blocked on credentials.** `npm whoami` must first
      return a valid identity; the version must still be absent. **If npm requires OTP/2FA, it is not bypassed** — the
      operator completes the publication manually and the round resumes from registry verification. No OTP is written to
      chat, docs, command history or report. No `npm unpublish` under any circumstance.
- [ ] **Registry metadata and artifact integrity verified, and the tarball downloaded back.** `dist-tags` must show
      `latest` → `0.1.2`; the version's peer must read `0.2.0-rc.2`; `dist.tarball`, `dist.integrity` and `dist.shasum`
      are recorded; and `npm pack` of the published version must reproduce `dist.shasum` and `dist.integrity`. The
      prepublish and registry tarballs are compared byte-first and, if the archive bytes differ, file-by-file. A content
      difference blocks the tag and the GitHub Release.
- [ ] **Exact-version and unversioned registry installs, then a registry-installed cold start.** Two further disposable
      web-template profiles take `dsh-turn-performance-meter@0.1.2` and then the bare `dsh-turn-performance-meter` — the
      second being the command a user actually runs. Both must install `0.1.2`, enable the bundle automatically and place
      `turn-performance-meter` in the composition; the unversioned profile is then cold-started. All disposable profiles
      and processes are removed afterwards, and the real `web` profile is neither modified nor restarted.
- [ ] **Annotated tag and GitHub Release, only after registry acceptance.** `git tag -a v0.1.2 <release commit>` and an
      ordinary `git push origin v0.1.2`, then a Release whose assets are the **registry-downloaded** tarball plus a
      `.sha256` sidecar, created with `--verify-tag` and `--latest` and without `--draft` or `--prerelease`.

Acceptance gate: baseline `5e697d85…` re-verified and unchanged at preflight with `v0.1.0` and `v0.1.1` still pointing at
their own commits and `v0.1.2` absent; DSH exactly `0.2.0-rc.2` both installed and declared as the only, exact peer;
`package.json` at version `0.1.2` with `publishConfig` locked to `https://registry.npmjs.org/`, the runtime-only allowlist
intact and no lifecycle install script; the production diff empty so no metric semantic moved in the release round; the
dead `turnKey` helper removed rather than imported; 768/768 tests, sanitization PASS and `git diff --check` clean at
release state; the tarball built outside the repository, audited entry by entry, manifest-checked and digest-recorded,
then installed and cold-started in a disposable DSH `0.2.0-rc.2` profile without a compatibility exemption; the release
commit pushed without force before publication; `npm` publishing `0.1.2` with `latest` → `0.1.2`; the registry artifact
reproducing the local digest and matching the GitHub asset; the exact-version install, the unversioned standard install
and a registry-installed cold start all passing; annotated tag `v0.1.2` peeled to the release commit; `HEAD == main ==
v0.1.2` with divergence `0 0` and a clean working tree at the end; and no force, no re-tag, no movement of `v0.1.0` or
`v0.1.1`, no widened compatibility claim, no claim beyond DSH `0.2.0-rc.2` and no credential or OTP recorded at any point.

## Phase 9.4 — TTFT boundary and episode TPS opening stabilization (complete)

Two defects identified independently in v0.1.2, repaired at their causes rather than at their symptoms. This round is also
a **recovery** round: the original Phase 9.4 session crashed and its conversation state was lost, so the work began by
recovering an uncommitted implementation from the working tree and auditing it against this list before extending it
(`docs/IMPLEMENTATION_LOG.md`, Phase 9.4 §1–2).

**BUG A — TTFT stayed in 首响应计时 after a name-bearing, empty-arguments tool-call delta.**

- [x] **Recover the interrupted work read-only before any write.** Git was inspected with `status`, `rev-parse`,
      `fetch --tags`, `rev-list --left-right --count`, `log`, `diff`, `diff --cached`, `stash list` and `reflog` only. No
      `reset`, `clean`, `checkout .`, `restore .`, `pull --rebase`, `rebase`, `stash push`, `gc` or `prune` was run.
- [x] **Classify the local state.** **CASE B — uncommitted Phase 9.4 work exists.** `HEAD` was exactly
      `58685f0abe023629eb776ecd5e75b626bd12c428`, the index was empty, there were no local commits beyond `origin/main`
      (divergence `0 0`) and no stash; 26 tracked files were modified and 10 files were untracked.
- [x] **Preserve before inspecting.** The complete `git diff` (816 428 bytes), the empty `git diff --cached`, the status
      list, the `HEAD` sha and all 10 untracked files were copied to
      `E:\Projects\DSHarness\_recovery-backups\phase94-20261001-005951` outside the repository.
- [x] **Audit the recovered work** change by change as KEEP / REPAIR / DROP. Nothing was discarded; one recovered claim
      (that a legitimate 10 000 tokens/s peak had been suppressed) was reproduced and disproved rather than trusted.
- [x] **Establish the DSH rule and confirm the defect.** `isTokenDelta({type:'tool-call-delta', name:'pwsh',
      argumentsDelta:''}) === true` on DSH `0.2.0-rc.2`, while `classifyDelta` of the same chunk is `null` and
      `sampleFromChunk` therefore yields no sample. Verified against v0.1.2: `record.firstTokenMs` stayed `null` and the
      attempt held `0` samples; the root cause is `src/client/live/controller.js`'s `if (sample === null) return`, which
      meant the boundary chunk never reached the presenter.
- [x] **Decouple TTFT from TPS mass.** `tokenEvidence()` publishes DSH's predicate, the phase, and whether the chunk also
      carries magnitude. `countsAsToken` freezes the turn's first token and advances the presenter; `contributesMagnitude`
      gates the sample. No magnitude is fabricated for a boundary-only delta.
- [x] **One first-token contract, not two.** `TurnTelemetryStore.firstTokenObserved` is the single one-way freeze, used by
      the live `acceptChunk` path and by the durable reconstruction; the adapter publishes `firstTokenMs` from the same
      predicate (`stream-decoder.firstTokenTimeMs`). Live and durable agree on the boundary.
- [x] **Turn-level TTFT, never attempt-level.** A new attempt, a retry and a tool boundary all leave an already-frozen
      turn TTFT untouched.
- [x] **Regression tests** for a name-bearing empty-arguments delta (freezes TTFT; presenter leaves `pending-first-token`),
      a name-absent empty-arguments delta (ignored), ordinary reasoning/text deltas (unchanged), a tool call and result
      that never return the card to first-response timing, durable/live agreement, and a single freeze across attempts.

**BUG B — completed `peakTps` reaching ≈23 500 tokens/s from a 1–99 ms denominator.**

- [x] **Root cause confirmed against v0.1.2 and reproduced numerically.** The attempt-global 100 ms ladder let a phase
      episode opening off-grid be first measured over the remainder of a step. Reproduced: a phase opening at 250 ms gave
      `peakTps = 2000` (`100 tokens / 50 ms`), one opening at 299 ms gave `peakTps = 100000` (`100 tokens / 1 ms`), and
      three samples sharing one timestamp were published as `300`.
- [x] **One shared named publication contract.** `MIN_RATE_SAMPLES = 3` and `MIN_RATE_ELAPSED_MS = 100` in
      `src/core/rate-publication.js`, imported by both halves; `MIN_WARMUP_SAMPLES` is now an alias rather than a second
      constant. No duplicated magic number remains.
- [x] **Fix the invalid condition, not the value.** No clamp, winsorization, EMA, moving average, arbitrary replacement
      ceiling or MiMo 1564 window exists anywhere in the path.
- [x] **Live TPS policy.** The elapsed horizon joins the existing three-sample gate; a rate is published only when both
      hold, and phase-local resets, the attempt reset, the 100 ms cadence, stall decay, tool-state null TPS and the
      first-output guard are preserved. No visual styling changed.
- [x] **Completed curve policy — the preferred implementation.** Each phase episode owns its own 100 ms ladder from its own
      origin, so a sub-100 ms denominator does not exist on the grid rather than being filtered afterwards. The attempt's
      real terminal settlement endpoint is still emitted as a vertex.
- [x] **Curve warm-up.** A one- or two-sample episode still exists in the provenance, contributes its calibrated token
      total and duration, and affects settled aggregates — but cannot manufacture a peak. A non-publishable rate is
      `null`/unavailable, never a measured `0`.
- [x] **Peak policy.** `peakTps = max(publishable rate points)`; opening anchors, sub-100 ms vertices, below-warm-up
      episodes, unavailable vertices and geometric-only anchors are all excluded, and `peakTps = null` when no eligible
      point exists so the UI prints `峰值 —` rather than `峰值 0 tokens/s`.
- [x] **No upper clamp.** A legitimately high peak that satisfies the evidence contract is published unchanged.
- [x] **Provenance for the winning peak.** Debug-only `peakProvenance` records attempt, phase, episode origin, point
      instant, elapsed, episode sample count, episode mass, calibration/quality, temporal allocation mode and the
      contributing sample timestamps. It reaches no renderer and never appears on the normal card.
- [x] **Extreme-spike regressions.** The 50 ms and 1 ms off-grid openings, three coincident samples, three samples inside
      50 ms with the episode ending inside the horizon, three samples over ≥100 ms becoming valid, a calibrated heavy
      first delta after an off-grid transition, and a one/two-sample terminal episode.
- [x] **Token integral preserved.** For the calibrated heavy-delta fixture the sample-weight sum, the settled generated
      totals, the phase averages, the attempt count and TTFT are identical between v0.1.2 and the fix; only the invalid
      peak changes (`500 000` → `2000`).

**Isolated real-machine acceptance (no operator environment used).**

- [x] **Running DSH instances inventoried read-only before any test** — PID, command line, profile and port — and recorded
      as the protected set. The measured mapping corrects the brief: port `19387` is the **desktop** host (PID `46308`,
      profile `desktop`) and the `web` profile (PID `21088`) listens on **3080**. Both are protected, and neither was used
      as a test target.
- [x] **A new disposable profile** with its own identity, directory, port and plugin install, created through the
      source-verified DSH `--from-default-profile` mechanism rather than by guessing, with no session data copied from a
      protected profile.
- [x] **Plugin linked only into the isolated profile**; no compatibility exemption required at peer `0.2.0-rc.2`, and the
      plugin's presence proven from the isolated profile's own `__DSH_BOOT__` and `dsh.profile.bundles`.
- [x] **Isolated host served exactly the committed bytes** — the repository `client.js` at byte offset 0 with only the
      module server's 83-byte `//# sourceMappingURL` trailer appended, and its `rev=` reproduced from the live file's
      metadata.
- [x] **Containment verified:** read-only before/after snapshots show `profiles\web` (7441 files) and `profiles\desktop`
      (3129 files) at **0 added / 0 removed / 0 changed**; both protected PIDs still alive on their own ports; protected
      ports never used by the test; no global process kill at any point.
- [x] **RESOLVED in Phase 9.4.1 — §22 real-machine TTFT test and §23 real-machine long-turn TPS test: OBSERVED.** A **new**
      disposable profile `tpm-phase941-runtime` (port `19388`, PID `4440`, fresh workspace, no compatibility exemption)
      ran the same plugin against the already-authorized `command-goat` route selected by `apiKeyEnv` **reference** — the
      shared credential store was read, never written, and no secret was read, printed or persisted. Six real turns ran
      through `dsh 0.2.0-rc.2`. **Bug A:** three tool-first trials produced the exact ideal wire shape as the first chunk
      `isTokenDelta` accepts — `tool-call-delta`, `name: "read"`, `argumentsDelta: ""`, preceded only by a
      `block-start(blockType: "tool-call")`; TTFT froze at that instant (`ttftMs 4376` vs a boundary 4381 ms after send),
      the UI left `首响应计时`, the tool ran, the follow-up answered, the next turn worked, and the turn published **no**
      peak rather than a fabricated one. **Bug B:** on a 3,644-token three-attempt turn the peak `453` carries
      `elapsedMs 100`, `episodeSampleCount 15`, `phase reasoning`, `sampleQuality calibrated` and 15
      `contributingSampleTimes`; no opening anchor won and no clamp exists. A full §13 scan over **264 published / 11
      withheld** vertices found **0 violations**. Peak/phase-average ratios were `1.00`, `2.39`, `0.92` — no §12
      escalation. Zero console errors. See `docs/IMPLEMENTATION_LOG.md` Phase 9.4.1 §5–§8.
- [x] **Disposable profile removed; the retained one left in place.** The previous round's blocker is gone, so there was
      nothing left to resume: `tpm-phase941-runtime` was deleted after `Resolve-Path` and its `package.json` identity
      (`dsh-profile-tpm-phase941-runtime`) were verified against the literal path, with no wildcard. The earlier
      `tpm-phase94-isolated` profile was independently confirmed **not running** and left untouched, which §15 permits.

**Gates, documentation and Git.**

- [x] `npm run build:client`, `npm run verify`, `node scripts/verify-sanitization.mjs`, `git diff --check`.
- [x] `docs/METRICS_SPEC.md`, `docs/IMPLEMENTATION_LOG.md`, `docs/TEST_PLAN.md`, `docs/TASKS.md` and
      `docs/DIRECTORY_TREE.md` updated; no historical Phase 9 evidence rewritten.
- [x] **Version frozen at `0.1.2`.** No `npm publish`, no `npm version`, no `v0.1.3` tag, no GitHub Release.
- [x] **Ordinary pushes only.** No `--amend` on a pushed commit, no rebase of pushed `main`, no `--force`, no
      `--force-with-lease`; `HEAD == origin/main`, divergence `0 0`, working tree clean at the end.

Acceptance gate: BUG A and BUG B both reproduced on released v0.1.2 and both repaired at their causes with baseline-proven
regressions; generated-token totals, reasoning-token inclusion, settlement usage, phase-duration attribution,
toolWall/toolWork, attempt count, turn elapsed, durable reconstruction and dedupe, tool identity and the `0.2.0` contract
all unchanged; `peakTps` either `null` or a measurement satisfying ≥3 samples and ≥100 ms; 0 failing tests; sanitization
PASS; `git diff --check` clean; the operator's running instances never used as a test target and their profile
directories measured unchanged; and no v0.1.3 publication of any kind.

**Outstanding for the resumed round:** the two real-machine acceptance items in §22/§23, which need a provider credential
the disposable profile does not have. The operator can unblock them by storing `DEEPSEEK_API_KEY` through the DSH
credentials service (or exporting it into the isolated launch environment); the isolated profile `tpm-phase94-isolated` is
retained so the run can resume without rebuilding the environment.

---

## Phase 9.4.1 — Isolated runtime acceptance closure (2026-10-01)

Phase 9.4's implementation is accepted as-is and was not redesigned; this round closed one view-model semantic gap, obtained
the real-machine evidence Phase 9.4 was blocked on, and determined release readiness. The previous provider/API failure was
out of scope and was neither diagnosed nor repaired.

**View-model hygiene.**

- [x] **`curveViewModel.peak.value` no longer conflates "unavailable" with "measured zero".** It is
      `Number.isFinite(curve.peakTps) ? Math.max(0, curve.peakTps) : null`; the axis geometry takes the `null` at exactly
      one seam (`const axisPeak = peakValue ?? 0`) so no `null` reaches a quotient, a ratio or a comparison, and the peak
      marker's guard short-circuits on `peakValue === null` before the subtraction that would coerce it.
- [x] **No visual difference, proven rather than asserted.** `peak.display` keeps its `axisPeak > 0` test, so the em dash
      and every rendered element are unchanged. New test `§16b` in `test/phase94-regressions.test.js` renders one settled
      turn through `curveTree` twice with only `curve.peakTps` moved between `null` and `0` and asserts `assert.deepEqual`
      on the two element trees; it also pins `peak.value === null`, `display === DASH`, `peak.x/y === null`, a finite
      positive `axis.max`, and `isPeak === false` on every marker.
- [x] **Two assertions that encoded the old semantics updated** (`test/curve-rate-publication.test.js`,
      `test/phase94-regressions.test.js` §16), with the axis-validity and no-fabricated-marker proofs added beside them.
- [x] **Confirmed on the real machine:** the tool-first turn rendered `峰值 —`, `axis-max 1`, no `dsh-tpm-peak-dot`, and
      `aria-label "吞吐曲线 · 峰值 — tokens/s"`.

**Real-machine acceptance, in a new disposable profile only.**

- [x] **Running DSH instances inventoried read-only first** — PID `21088` on `3080` (`web`) and PID `46308` on `19387`
      (`desktop`, the operator's live GUI) plus the operator's Chrome PID `43176` — and treated as the protected set. None
      was installed into, restarted, signalled, or attached to.
- [x] **A genuinely separate profile**: `tpm-phase941-runtime` created via the source-verified
      `--from-default-profile web --dump-config`, own directory, own identity, own unused port `19388`, fresh workspace,
      plugin linked only there, `version-exemptions` empty. Nothing copied from any protected profile.
- [x] **PATH A credential policy honoured**: the already-authorized `command-goat` route selected *by reference*
      (`apiKeyEnv: COMMAND_GOAT_API_KEY`). The shared store was read, never written; no credential value was read, printed,
      logged, exported or persisted; no credential was copied from a protected profile.
- [x] **General runtime PASS** — idle/no-meter, live pill, TTFT freeze, both phases, collapsed card, expanded summary,
      curve, reload reconstruction (identical progress string), zero console errors.
- [x] **Bug A PASS with the exact boundary observed** — `tool-call-delta` / `name: "read"` / `argumentsDelta: ""` as the
      first chunk `isTokenDelta` accepts, in three trials; TTFT froze there, the UI left `首响应计时`, the tool ran, and no
      TPS mass was fabricated.
- [x] **Bug B PASS** — real peak `453` with `elapsedMs 100`, `episodeSampleCount 15`, `total-anchored`, `calibrated`; no
      opening anchor; no clamp; peak/phase-average ratios `1.00` / `2.39` / `0.92`, so no §12 escalation.
- [x] **§13 invariants hold** — 264 published and 11 withheld vertices scanned, **0 violations**, every withheld vertex
      named.
- [x] **Containment measured and attributed** — `profiles\web` 0 files written after task start; the operator's two
      instances alive on their own ports throughout; the 8 files `profiles\desktop` did gain are its own plugin-manager's
      two rejected `dsh-mail-notify@0.4.0` installs (both rolled back) plus a GUI-settings rewrite, which no command this
      task issued could produce. One blank session in the shared `dsh-mail-notify` workspace bucket is reported and left
      in place.

**Gates, documentation and Git.**

- [x] `npm run build:client`, `npm run verify` (**805 pass, 0 fail, 0 skipped, 0 todo**), `node scripts/verify-sanitization.mjs`,
      `git diff --check`; `client.js` mirrored to `lib/client.js`.
- [x] `docs/IMPLEMENTATION_LOG.md`, `docs/TEST_PLAN.md`, `docs/TASKS.md` and `docs/METRICS_SPEC.md` updated; historical
      evidence not rewritten.
- [x] **Version frozen at `0.1.2`** with peer `@deepseek-ai/dsh` `0.2.0-rc.2`. No `npm publish`, no `npm version`, no
      `v0.1.3` tag, no GitHub Release.
- [x] **Ordinary pushes only.** No `--amend`, no rebase of pushed `main`, no `--force`, no `--force-with-lease`.

Acceptance gate: `peak.value` distinguishes unavailable from measured zero with no visual change; the general runtime path is
intact; Bug A's exact name-only boundary observed on the real provider stream with TTFT freezing there and no fabricated
mass; Bug B's real peak carries ≥100 ms, ≥3 samples and full provenance with no clamp and no escalation; §13 invariants
clean; the operator's environment never used as a test target, never restarted and measured untouched where measurable;
0 failing tests; sanitization PASS; `git diff --check` clean; and no v0.1.3 publication of any kind.

**Recommendation: READY FOR v0.1.3 RELEASE REVIEW.**

## Phase 9.4.2 — Boundary-only TTFT evidence / TPS episode-origin parity closure (2026-10-01)

One narrowly scoped source-level defect found by independent review after Phase 9.4.1. Phase 9.4.1's real-machine
acceptance remains valid for what it observed (Bug A's name-bearing empty-arguments boundary, Bug B's rate-publication
gates, and the `null` unavailable-peak semantics); none of those repairs was redesigned. This phase is a deterministic
source-contract closure: **no DSH profile was started, stopped, attached to or installed into, no browser/runtime
acceptance was repeated, and the retained `tpm-phase94-isolated` profile was not touched.**

**Baseline and starting state.**

- [x] `git fetch origin`; `HEAD == origin/main == 6506bd0cc8f9ef348eb7cf6418db60d5ad98f6dc`; divergence `0 0`; working
      tree clean. No history was repaired, amended, rebased or forced at any point.

**The defect, reproduced before it was repaired.**

- [x] The brief's fixture (turn start `0`, name-only empty-arguments `tool-call-delta` at `100`, 100-token output samples
      at `200 / 250 / 300`) was driven through the real store/live/curve path and **measured** on `6506bd0`: live
      `origin 100 / elapsed 200 / TPS 1500` against the curve's `origin 200 / elapsed 100 / TPS 3000`.
- [x] Root cause: `LiveMeter.observeTokenBoundary` set `episodeStartMs` (and `episodeUsageBaseline`) at the boundary
      instant, so a TTFT boundary that carries no magnitude became the sample-based denominator origin — and the
      provider-counter numerator's origin with it.

**The repair.**

- [x] `src/core/live-metrics.js` only: a boundary establishes the TTFT instant and the streaming phase identity, and
      `acceptSample` remains the sole opener of an episode (origin = the first magnitude sample, baseline taken there).
      A same-phase boundary inside an already magnitude-open episode resets nothing.
- [x] The first-output guard was audited because it reads `episodeStartMs`: it cannot fire before an episode exists, and
      its window is now the output episode's own, so the reasoning rate is never extended across a phase that has
      produced nothing.
- [x] The completed curve, the DSH adapter and the publication gates were **not** modified: `compressAttempts` and
      `cumulativePhaseTpsSeries` already open an episode at its first sample, so the defect was one-sided.
- [x] Provider-counter baseline audited in all three orderings (none known / known before the boundary / known between
      the boundary and the first sample) and the counter used at the real episode start is stated with its reason.
- [x] No forbidden repair: no clamp, no winsorization, no EMA or moving average, no ceiling, no fabricated magnitude or
      sample count, no fixture special-case in production code, no weakened gate.

**Evidence.**

- [x] New deterministic suite `test/boundary-episode-origin.test.js` (12 tests, cases A–H plus two controls and a
      controller-level presentation case), proven **red on baseline `6506bd0`** in a disposable read-only `git worktree`
      (12 tests: 4 pass / 8 fail) and green on the fixed tree (12 pass / 0 fail). The four baseline-passing cases are
      labelled controls and are not counted as coverage.
- [x] Live/completed parity after the fix: both halves report origin `200`, elapsed `100 ms`, sample count `3`, mass
      `300`, TPS `3000` for the fixture, with `curve.peakTps` unchanged at `3000`.

**Gates, documentation and Git.**

- [x] `npm run build:client`, `npm run verify` (**817 pass, 0 fail, 0 skipped, 0 todo**, up from 805),
      `node scripts/verify-sanitization.mjs`, `git diff --check`; `client.js` byte-identical to `lib/client.js`.
- [x] `docs/METRICS_SPEC.md` (the two origins stated as a pair, the episode clock, the guard, the provider-counter
      baseline, §8.2 parity), `docs/IMPLEMENTATION_LOG.md`, `docs/TEST_PLAN.md` §13, `docs/TASKS.md` and the test-file
      listing in `docs/DIRECTORY_TREE.md` updated; historical evidence not rewritten.
- [x] **Version frozen at `0.1.2`** with peer `@deepseek-ai/dsh` `0.2.0-rc.2`. No `npm publish`, no `npm version`, no
      tag, no GitHub Release.
- [x] **Ordinary commits only.** No `--amend`, no rebase of pushed `main`, no `--force`, no `--force-with-lease`.

Acceptance gate: `HEAD == origin/main`, divergence `0 0` and a clean tree after the push; the new suite red on `6506bd0`
and green on the fixed tree; live and completed episode origins identical for the fixture; the provider baseline
describing the same interval as the denominator; the Phase 9.4 gates and the unavailable-peak semantics unchanged; 0
failing tests; sanitization PASS; `git diff --check` clean; and no version, tag or publication change.

**Status: source-level closure complete; a separate narrowly scoped isolated-runtime smoke may be authorized after
independent GitHub review. No release-readiness claim is made in this phase.**
