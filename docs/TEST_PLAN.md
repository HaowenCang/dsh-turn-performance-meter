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
  `conversation.composer.dock`, order −10), `ctx.effect` setup/disposer semantics, remount shape;
- audit tests inside existing files — settlement concepts (`assistant/attempt` ≠ `abandoned`), `llm/retry` →
  `retried`, `reasoningTokens=0` + reasoning stream consistency guard (unit, aggregate, and fixture-patched), the
  frozen window warm-up contract, the tool-episode live timer.

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
- pending TTFT pill — screenshots (`turnb-pending-first-token.png`, `turnc-*.jpg`, …) plus 200 ms-cadence DOM trace;
- streaming TPS pill — screenshot (`turng-streaming-output.jpg`, `≈` marker visible) plus DOM trace with per-tick
  `思考/输出 ≈N tokens/s` values;
- tool timer pill — timestamped DOM trace (`pwsh · 0.3 s | 3.6 s`, episode restarts across sequential calls); a
  pixel capture of this seconds-long state was not achieved (agent-to-agent tool-call latency exceeds the window) —
  recorded honestly below;
- completed summary / hover / curve — Phase 4/5 rows, still open;
- no curve in live mode — asserted in unit tests and confirmed in the live DOM (no chart element exists);
- light/dark — plugin accent computed as `#d9480f` (light) / `#ff922b` (dark override) in the live page;
- console free of plugin errors; native stats pills present beside the meter.

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
