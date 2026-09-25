# Architecture

## 1. Objective

`dsh-turn-performance-meter` is a turn-scoped telemetry and presentation plugin for DSH. Its design assumes agentic turns rather than one request/one response. The fundamental object is a Turn containing zero or more tool calls and one or more model attempts.

```text
Turn
├─ LLM attempt A
│  ├─ reasoning deltas
│  └─ output deltas (text + tool-call arguments)
├─ Tool calls
├─ LLM attempt B
│  ├─ reasoning deltas
│  └─ output deltas
├─ Tool calls
└─ LLM attempt C
   └─ final output
```

The architecture separates raw DSH evidence from normalized telemetry, pure metrics, and UI. No UI component should know raw `session/event` or `agent/assistant-stream` details.

## 2. Layers

```text
DSH Host/runtime
  │
  ├─ durable session/event facts
  │    turn/start, step boundaries, assistant settlements,
  │    tool/call, tool/result, turn/end, retry/attempt records
  │
  └─ transient assistant stream
       agent/assistant-stream start/chunk/end
       └─ timestamped StreamChunk deltas
                 │
                 ▼
        DSH adapter / normalization layer
                 │
                 ▼
        TurnTelemetryStore (session + turn keyed)
          ├─ AttemptRecord[]
          ├─ ToolCallRecord[]
          ├─ live SlidingWindowMeter
          └─ turn lifecycle
                 │
        ┌────────┴─────────┐
        ▼                  ▼
  Live snapshot        Settled snapshot
  (estimated)          (exact/calibrated where possible)
        │                  │
        └────────┬─────────┘
                 ▼
        client projection/resource
                 ▼
      conversation.input.dock
        ├─ live compact pill
        └─ completed card
             └─ hover curve view
```

## 3. Source-of-truth policy

The integration layer must use DSH extension points and client services, not DOM scraping. DSH's public architecture explicitly distinguishes durable facts (`session/event`) from transient live model presentation (`agent/assistant-stream`). The plugin should combine them:

- transient assistant frames: live current-window TPS and in-flight sample timestamps;
- durable turn/step/tool/assistant settlements: authoritative boundaries, completion status, replay/reload reconstruction, and provider usage;
- provider usage: exact aggregate output/reasoning token totals when available.

Do not derive metrics by observing rendered chat DOM, another plugin's DOM, or text animation timing.

## 4. Host state model

Key all active state by `(sessionId, turn)`; never maintain one global "current turn" because multiple sessions can exist and background/parallel activity may occur.

```ts
TurnRecord = {
  sessionId,
  turn,
  startMs,
  endMs?,
  firstTokenMs?,
  status,
  attempts: AttemptRecord[],
  tools: ToolCallRecord[],
}

AttemptRecord = {
  attemptId,
  turn,
  step,
  samples: DeltaSample[],
  usage?,
  reasoningMs?,
  outputMs?,
  outcome?,
}

ToolCallRecord = {
  callId,
  name,
  startMs,
  endMs?,
  status,
  parentCallId?,
}
```

`attemptId` is the live identity for one assistant streaming attempt. A retry/new attempt must create a new live rolling-window epoch.

## 5. Normalized delta accounting

A timestamped `StreamChunk` contributes to model-output telemetry only if it carries non-empty generated content:

- `reasoning-delta` → reasoning phase;
- `text-delta` → output phase;
- `tool-call-delta.argumentsDelta` → output phase;
- empty deltas, `block-start`, `block-end`, `usage`, `finish` → no direct token sample.

Tool execution results never enter this stream-accounting path.

This rule means model-generated `pwsh` commands, write-file payloads and edit patches are naturally counted because they are generated inside tool-call argument deltas.

## 6. Turn lifecycle

Recommended normalized states:

```text
idle
  -> pending          turn/start, no first generated delta yet
  -> streaming        first/current model delta
  -> tool             tool executing; live TPS cleared
  -> pending          next model attempt waiting for first delta
  -> streaming
  -> completed | interrupted | errored
```

A tool may be parallel with another tool. State presentation can still say `tool` while `activeToolIds.size > 0`; timing must retain individual intervals.

### Live rolling-window reset rule

Every `AssistantStreamFrame.start` / accepted new attempt resets the 1-second live meter. A later model call must not inherit tokens from a preceding call separated by a tool or retry.

### The same rule applies to the completed curve (frozen in Phase 6)

The completed curve uses the compressed clock, which joins attempts end-to-start so tools consume no width. That joining is a **coordinate** operation; it is not a statement about the measurement window. Each attempt's completed series is therefore computed on its own local clock by `perAttemptSeries` and only then relabelled to the shared coordinate.

The two clocks a compressed sample carries are named explicitly for exactly this reason:

| Field | Meaning | Used by |
|---|---|---|
| `activeTimeMs` | turn-compressed coordinate, continuous across attempts | the x-axis, and `phaseRuns`' intervals |
| `attemptTimeMs` | attempt-local instant, zero at that attempt's first delta | the trailing-window measurement |

Publishing only the first of the two is what allowed the rejected revision to roll a turn-global window while believing it was local. Anything that measures a rate reads `attemptTimeMs`; anything that draws a position reads `activeTimeMs`.

One consequence is worth stating separately: an attempt's one-window decay tail is clamped at the coordinate the **following** attempt owns, because past that point the coordinate belongs to a different call. The final attempt keeps its tail. The clamp is published on the segment as `hasSuccessor` + `nextStartMs` — a single nullable number cannot distinguish "the next attempt starts here" from "this attempt ends at the axis end", and the two cases require different behaviour.

## 7. Timing domains

The project deliberately has several clocks; do not collapse them.

### Wall clock

Used for:

- turn elapsed time;
- TTFT;
- individual tool latency;
- tool wall-union latency;
- model intra-attempt streaming stalls.

### Phase generation duration

Used as TPS denominator. Tool waiting is excluded. Reasoning/output duration must be derived from model-generated delta boundaries under one documented policy and tested against edge cases.

### Compressed curve clock

Used only for the completed TPS chart. For each model attempt, preserve the internal time spacing from first generated delta to last generated delta; concatenate attempts with no inter-attempt gap:

```text
wall clock:
A model ===== | tool 30 s | B model === | tool | C model ======

curve clock:
A model =====B model ===C model ======
```

Thus tool execution and second-call pre-first-token wait consume zero chart width, while a real stall *inside* an active model stream remains visible as a local TPS reduction.

Formally, the chart is equivalent to an active model-generation coordinate, but implementation is safer as explicit attempt concatenation than subtracting arbitrary wall intervals from one global clock.

The domain boundary is easy to get wrong in one direction only, and the wrong direction is the expensive one: the clock is continuous across an attempt boundary, so it is tempting to treat the rolling series as continuous too. It is not. See "The same rule applies to the completed curve" above for the two clocks and the decay clamp.

## 8. Retry, interruption and failure semantics

The implementation must not assume one attempt per step. DSH publishes an `attemptId` and can durably record attempts/retries.

Recommended policy:

- include every attempt in the turn that actually emitted non-empty generated deltas;
- use provider usage for an attempt when it exists;
- an abandoned/failed attempt without authoritative usage may still contribute observed timing/curve shape with degraded metric quality;
- a user-stopped turn settles the card as `interrupted`, not `completed`;
- provider/request failure settles as `errored` when DSH's turn end says so;
- do not fabricate exact final token totals when contributing attempts lack authoritative usage. The UI should show `≈`/quality detail or `—` according to `METRICS_SPEC.md`.

DeepSeek must validate these policies against the local DSH retry/assistant-attempt event semantics before finalizing integration.

## 9. Transport from host to client

**Decided and implemented (Phase 3).** One session-scoped read model in the browser, fed by
`ctx.sessions.binding(sessionId).eventSource`: its `SessionEventWindow` carries the durable `SessionEvent` plane and
the client-folded transient `assistant/live-chunk` plane in one synchronously-published window with `change` payloads
(`replace` / `append` / `prepend` / `settle-assistant`). No host half, no plugin projection, no polling loop, no DOM
scraping, no synthetic durable events.

```text
SessionEventWindow (change payloads)
  -> src/dsh/client-feed.js      window wire -> normalized events (the only DSH-wire parser)
  -> TurnTelemetryStore          (sessionId, turn) keyed statistics + per-session LiveMeter
  -> LivePresenter               per-session UI state machine + projection guards
  -> controller.project()        precedence + memoized projection identity
  -> MeterRoot (React)           one 200 ms ticker for live views, none for completed ones
       ├─ LiveMeter pill
       └─ CompletedMeter card
```

Rejected alternatives and their reasons are recorded in `docs/IMPLEMENTATION_LOG.md` (Phase 0 §"Host→client telemetry
seam"): plugin-owned session projection (committed-event-driven, cannot publish at transient cadence), host push
socket (re-implements shipped transport, HMR-fragile), `sessionStats`/`tokenUsage` projections (whole-session scope),
DOM polling (forbidden).

The exact mechanism was intentionally not hardcoded in the scaffold; Phase 0 recorded the chosen seam before any
integration code was written, and Phase 3 verified it live.

**Completed-view selection (frozen in Phase 4).** The card's data source is the settled snapshot
`TurnTelemetryStore.endTurn` produces and caches on the turn record, read back through `latestSettled(sessionId)`. The
card never re-reads raw events, never re-aggregates, and never computes a metric:

```text
DSH durable/live evidence
  -> src/dsh (adapter + client-feed)          normalized events
  -> TurnTelemetryStore                       per-(sessionId, turn) records
  -> aggregateTurn + compressAttempts         settled snapshot (cached at turn/end)
  -> completedViewModel                       the ONLY completed UI seam: values, `≈`, `—`, strings
  -> curveViewModel(settled)                  the ONLY curve seam: evidence spans, axis, path data
  -> completed-tree + curve-tree + CompletedMeter   render only
```

The card's render layer therefore performs no arithmetic at all: `completedViewModel` decides every visible string,
`curveViewModel` decides every coordinate, and the React components turn finished values into elements.

Precedence is one rule in one place (`controller.project`): **an open turn wins over a settled one**. A settled
*state machine* is what unlocks the card, not merely a settled meter, and the settled snapshot is read in the same
synchronous step as the live one — so `turn/end` replaces the pill with the card inside a single state advance, and a
following `turn/start` replaces the card with the pill just as atomically. The projection is memoized by turn identity,
so an unchanged settled turn returns the same object and a static card is never rebuilt per ingested delta.

## 10. Client/UI architecture

Mount in `conversation.input.dock` — DSH's list seat above the composer card — as an independent entry
`turn-performance-meter` (`order: 30`, additive; the native `stats` occupant keeps its own seat in
`conversation.composer.dock` and is untouched). Phase 3 mounted in the composer dock, which is *below* the
composer; Phase 5B moved it. The order is derived from that seat's shipped occupants (`todo` 0, `goal` 10,
`queue` 20), so the meter renders last — immediately above the composer card.

One root component projects an explicit state machine onto one view:

```text
MeterRoot (slot component) — owns subscription, ticker and the single style tag
├─ hidden            no session | inactive machine — renders null
├─ LiveMeter pill    while a turn is open
│  ├─ pending-first-token   running first-response stopwatch (once per turn)
│  ├─ streaming-reasoning   trailing-1s ≈TPS + turn elapsed
│  ├─ streaming-output      (tool-call arguments included)
│  ├─ tool-running          episode wall timer + tool label(s), no TPS field
│  ├─ waiting-model         post-TTFT wait stopwatch, never the TTFT counter
│  └─ transition            neutral 处理中…, no TPS field
└─ CompletedMeter card   once that session's turn has settled
   ├─ MetricCell Reasoning TPS     value + unit + `108.2s · ≈37,498`
   ├─ MetricCell Output TPS        value + unit + `25.4s · ≈17,272`
   ├─ MetricCell Generated Tokens  value + unit + `总用时 133.6s`
   ├─ MetricCell TTFT              value + unit + status text
   └─ footer                       `工具 4 · 12.8s · 模型调用 4 · 已完成`
```

The projected view is stored state: only the presentation ticker — one cadence constant,
`DEFAULT_PRESENTATION_REFRESH_MS` = 50 ms in `src/client/live/cadence.js` (Phase 5A measured 200 / 50 / 10 ms in the
browser and selected 50 ms) — and mount/session changes write it, so the slot owner's high-frequency re-renders cannot
bypass the presentation throttle. Each tick produces exactly one state update: the projection key includes the
presentation instant, so the tick's view is always a new object and the `useReducer` "force render" that used to
accompany it was pure duplication and was removed. The ticker exists for **live** views only; once the card is on
screen the scheduler is stopped and the card is refreshed by events, not by a clock. Hover must not create a detached
tooltip: Phase 5F switches two layers inside the same card, and keyboard focus (`tabindex="0"` plus a `:focus-visible`
ring) provides equivalent access, which also covers touch because a tap focuses. The state machine is
`src/client/completed/view-mode.js`; the layers are stacked in one grid cell so the card height is the taller of the
two at every width. A turn with no curve produces an inert, unfocusable card.

## 11. Resource ownership

All timers, listeners, subscriptions, styles, and observers must be effect-scoped and disposed when the plugin/client contribution unmounts. Avoid singleton browser intervals. Avoid duplicate React. Prefer CSS variables/inherited host theme values; only the output accent color should be plugin-defined if no suitable host token exists.

Implemented ownership (Phase 3, extended in Phase 4 and Phase 5): the slot component (`MeterRoot`) owns exactly one
presentation scheduler (cleared on hide, on the completed card and on unmount), one eventSource subscription per
attached session inside the controller (unsubscribed on controller dispose), and a reference-counted style tag (single
`#dsh-tpm-live-style`, holding the shared token block plus the pill and card CSS, removed with the last unmount). The
controller disposes every subscription, machine and store entry on fiber teardown (`ctx.effect` returns-disposer form —
the callback runs as setup, its return value at teardown) and exposes `project`, `diagnostics`, `attachedSessions`.
Phase 5A moved the whole debug handle — including its `meter()` accessor — **inside** that setup callback, because an
accessor attached after `ctx.effect(...)` returned was silently lost: the setup had not run yet and the assignment threw
into its own guard. React comes from the browser module table seed; `window.React` stays undefined and no
duplicate-instance error appears in the console. The completed card owns no timer at all, which the browser run
confirms (`scheduler.ticking === false`, `timerCount === 0` with a settled card on screen).

## 12. Non-goals

This project is not:

- a billing/token-cost meter;
- a session-wide aggregate stats replacement;
- an end-to-end timeline visualization;
- a profiler for tool stdout throughput;
- a DOM observer;
- a DSH core patch.
