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
- [x] **Secret/privacy audit on the whole tracked tree, not just `.gitignore`.** 174 tracked files: no `.env`, no
      credential store, no `*.log`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.har`, `*.pcap`, `*.sqlite`, `*.db`, no archive.
      `fixtures/raw/` is not tracked. Content scan over tracked files found **no real secret**: the `password` / `Bearer
      token` / `Cookie` hits are verbatim upstream Chrome DevTools MCP tool-schema descriptions inside recorded fixtures,
      the `BEGIN PRIVATE KEY` hits are the sanitizer's own detector patterns, and `secret` appears only in the log's
      record of an earlier scan. No real email address, no machine hostname (`DESKTOP-FENG`: 0 hits), no mailbox identity.
      The only disclosure class found is **recorded local verification paths** in documentation —
      `C:\Users\20659\…` in `docs/DSH_API_NOTES.md:266`, `docs/IMPLEMENTATION_LOG.md:2641-2642,3101-3102`,
      `docs/TASKS.md:341` — which is documentation of a real local command, not a credential; it was classified rather
      than mechanically redacted, because rewriting those rows would falsify evidence. Nothing entered Git history that
      needed to be removed.
- [x] **Fixture sanitization gate run.** `node scripts/verify-sanitization.mjs` exits `0`: none of 22 forbidden terms
      appears in any published fixture value; the 13 published fixtures keep their file set and every structural scalar,
      with 9 of them verified against untracked raw originals at identical string lengths; the sanitizer is confirmed
      load-bearing (raw originals are not a fixed point). 163 UUIDs inside fixtures are recorded session/attempt/call
      identities the tests depend on, which the sanitizer preserves by design. The only reported residue is the declared
      public DSH surface names `wechat_notify` and `dsh-super-injector`.
- [x] **Package contents audited without publishing.** `npm pack --dry-run` under `private: true` prints the tarball
      listing and writes nothing: 172 files, 2.5 MB packed / 8.9 MB unpacked. Contents are the plugin sources, tests,
      fixtures, docs, `dev/` tooling, both bundle copies and `LICENSE`. No `node_modules`, no `fixtures/raw/`, no logs, no
      credentials, no screenshots, no stray archives. No `files` field or `.npmignore` was added: the installed artifact
      is a local DSH file bundle that needs the repository layout, and restructuring packaging for a hypothetical
      registry distribution was explicitly out of scope.
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
- [x] **npm publication, git tag and GitHub Release: N/A — not requested.** The package remains `private: true` at
      version `0.1.0`; no `npm publish`, no `npm access`, no `git tag`, and no `gh release create` was run, and the
      README/CHANGELOG state the local-only distribution rather than implying a registry one.
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
