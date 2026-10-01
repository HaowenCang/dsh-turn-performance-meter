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
          ├─ live LiveMeter (phase-episode cumulative TPS)
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

- transient assistant frames: live phase-cumulative TPS and in-flight sample timestamps;
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

`attemptId` is the live identity for one assistant streaming attempt. A retry/new attempt must create a new live phase episode: the episode clock, the numerator and the first-output fallback are all reset, so a later model call never inherits tokens from a preceding call separated by a tool or a retry.

### Window generation reset (frozen in Phase 7A.1)

`TurnTelemetryStore` is keyed by `(sessionId, turn)` and also owns one `LiveMeter` per session, so it holds the
*evidence* rather than a pointer to it. That makes it the owner of the client's window-generation boundary: a
`replace` on the session event window is a rebaseline (reload, reconnect, window swap), and
`TurnTelemetryStore.rebaselineSession(sessionId)` drops that session's turn records and its live meter so the
replacement window is rebuilt rather than merged.

The reason the ownership sits here and not in the controller: `beginTurn` is deliberately idempotent — a replayed
durable `turn/start` must not discard samples already observed — and `beginAttempt` returns the existing attempt for a
known `attemptId`. Both are correct for an `append` and wrong for a new generation, because a replayed delta would be
*appended* to the attempt the superseded window filled. Resetting only the controller's `currentRecord` would leave
that state in place; resetting the whole store would discard other sessions, whose windows are independent.

The generation boundary is therefore one operation with one scope, and the controller's order on
`window-rebaseline` is: `store.rebaselineSession(sessionId)`, `presenter.reset()`, clear `currentRecord` and
`openAttemptId`, `invalidate()`. See `docs/METRICS_SPEC.md` §13.3 for the invariants this must satisfy and
`docs/IMPLEMENTATION_LOG.md` (Phase 7A.1 §2) for the counterexample that established it.

## 5. Normalized delta accounting

A timestamped `StreamChunk` contributes to model-output telemetry only if it carries non-empty generated content:

- `reasoning-delta` → reasoning phase;
- `text-delta` → output phase;
- `tool-call-delta.argumentsDelta` → output phase;
- empty deltas, `block-start`, `block-end`, `usage`, `finish` → no direct token sample.

One chunk shape is deliberately neither: a name-bearing `tool-call-delta` whose `argumentsDelta` is still empty. DSH's
first-token predicate accepts it and no magnitude can be attributed to it, so it is accounted as a **phase cut** — the
evidence that the stream moved to another phase at that instant — and never as a sample
(`src/core/delta-accounting.js` `phaseCutOf`; the rule and its consequences are in the next subsection and in
`docs/METRICS_SPEC.md` §8.7).

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

### Live phase-episode reset rule (Phase 9.2)

Every accepted new attempt resets the live estimator, and every phase transition inside one attempt resets the current **phase episode** — its start instant, its token mass and its sample count. The live rate is the episode's cumulative average, `Math.round(mass * 1000 / (now - episodeStartMs))`, and it is published only once the episode holds `MIN_WARMUP_SAMPLES` (3) generated samples; before that the pill shows the episode's elapsed counter. A tool start clears the episode outright (`tps: null`) rather than continuing its decay, and the next attempt begins a fresh clock.

**The reset is not the opening (Phase 9.4.2).** A transition *discards* the outgoing episode; the incoming phase's clock starts at its **first magnitude-bearing generated sample**, which is also the origin the completed curve uses. A DSH first-token boundary that carries no magnitude — a name-bearing `tool-call-delta` with an empty `argumentsDelta` — announces the phase without opening a clock, so `episodeStartMs` is `null`, `episodeSampleCount` is `0` and no rate (not even the first-output fallback) is published until that sample arrives. A boundary inside an already magnitude-open episode of the same phase resets nothing.

### The same rule applies to the completed curve (frozen in Phase 6, corrected in Phase 7C, restated for the cumulative estimator in Phase 9.2)

The completed curve uses the compressed clock, which joins attempts end-to-start so tools consume no width. That joining is a **coordinate** operation; it is not a statement about the episode clock. Each attempt's completed trace is therefore computed on its own local clock by `attemptTrace` and only then relabelled to the shared coordinate.

The two clocks a compressed sample carries are named explicitly for exactly this reason:

| Field | Meaning | Used by |
|---|---|---|
| `activeTimeMs` | turn-compressed coordinate, continuous across attempts | the x-axis |
| `attemptTimeMs` | attempt-local instant, zero at that attempt's first delta | the phase-episode measurement |

Publishing only the first of the two is what allowed the rejected revision to roll a turn-global window while believing it was local. Anything that measures a rate reads `attemptTimeMs`; anything that draws a position reads `activeTimeMs`.

An attempt's width is its terminal episode's end: the attempt's settlement instant when one is known, and its last generated delta otherwise. The terminal generated-delta → settlement tail is therefore drawn (a decaying stretch, because the numerator freezes while the denominator advances), while the tool and inter-attempt waits that follow still own no coordinate — the next attempt starts where this one's clock stopped.

### One measurement per attempt, one episode clock per phase (frozen in Phase 7C, restated in Phase 9.2)

Within one attempt the estimator accumulates **every** generated sample, whatever its phase, into the episode in force at that instant; a phase transition starts a new episode with its own clock and numerator. That is what `LiveMeter` measures, and the two halves of the project must agree: the live pill and the completed curve publish the same estimator family, with the completed curve allowed to improve its evidence quality at settlement.

Phase reaches the chart as a **label** on each vertex — `activePhase`, the phase of the latest generated sample at or before that instant, which is `streamingPhase` restated — and as the segmentation of the trace into phase-coloured runs by `visualRunsOf`. It is not a filter on the measurement:

```
raw samples (all phases) + the attempt's phase cuts
  -> compressAttempts           attempt-local + compressed clocks, cuts mapped with the samples
  -> curveSource                calibrated magnitudes from aggregate.attemptBreakdown
  -> attemptTraces              one phase-cumulative trace per attempt, capped at 200 published points
  -> visualRunsOf               phase-coloured cuts that share their seams, except across a phase cut
  -> allocateRunBudgets         chart-wide 512-vertex bound
  -> downsampleRun              per run, seams reserved
```

The rejected revision stopped at `perAttemptSeries(..., phase)`: two independent series, one per phase, neither of which equalled the live reading whenever both phases were active inside one measurement span. The episode cut that went with it — one drawn run per phase episode, with blank regions between them — stays removed: a silence inside a call is a value on that call's own trace, drawn at full width, and an episode is a *statistical* unit rather than a drawing unit. The one hole the chart does draw is the **phase cut** below, and it is not a silence inside a call: it is a stretch in which no episode was in force at all.

### A non-magnitude phase cut is its own evidence (Phase 9.4.3)

Until Phase 9.4.3 the boundary existed only in the live meter. `attempt.samples` holds magnitude-bearing deltas only, so
the completed curve — which segmented its episodes from that array — never saw the boundary and continued the outgoing
episode until the incoming phase's first magnitude sample, drawing a decay across a stretch the live pill had already
left, and charging that stretch to the outgoing phase's summary denominator. The repair is a fourth concept rather than
a new statistic:

| Concept | Who establishes it |
|---|---|
| TTFT boundary | the first chunk DSH's predicate accepts (`tokenEvidence().countsAsToken`) |
| phase identity transition | the phase that chunk declares |
| TPS magnitude sample | a generated delta with a shape weight (`sampleFromChunk`) |
| TPS episode origin | the first magnitude sample of the episode |

```
attempt.phaseCuts: [{ timeMs, phase }]      recorded by TurnTelemetryStore.phaseCutObserved
        │
        ├── transient plane   acceptChunk sees the boundary chunk  ─┐
        └── durable plane     attemptFromDecoded / decodeStreamRecords decode the same member
                                                                     │
        compressAttempts (attempt-local + compressed clocks, pre-origin cuts counted, not clamped)
                                                                     │
        buildPhaseEpisodes (src/core/phase-duration.js)  ← one rule, two readers
                    ├──────────────► cumulativePhaseTpsSeries   the curve, one episode at a time
                    └──────────────► attributePhaseDurations     the summary denominators
```

The cut **closes** the episode in force at its own instant — the closing vertex carries that episode's own mass over
its own elapsed clock — and **opens nothing**: the incoming episode still begins at its first magnitude sample, and the
stretch between the two belongs to no phase. A cut that closes nothing (a same-phase boundary, or one with no episode
in force) is inert, which is what keeps a same-phase boundary from splitting a valid episode. Neither the transient
plane nor the durable plane may be the only one that knows this: both record it through the same store call, so a
reloaded card recovers the identical cut, and `test/helpers/equivalence.js` compares the two planes' cut evidence on
every recorded fixture.

The one implementation of the episode boundary is `buildPhaseEpisodes`, because three consumers read it — the live
estimator's rule, the completed curve and the printed phase rates. A second copy would be free to disagree about where
a phase stopped, which is the defect class this closes.

### The mixed plane: a settlement completes the attempt it settles (Phase 9.4.4)

The two planes above are the *pure* ones. A reload produces a third: an attempt whose evidence arrives on both at once,
because the replacement window holds only the transient tail it could still see while the settlement that closes the
attempt carries the whole compact stream. Phase 9.4.3 recorded the cut on both pure planes; this one routes it on the
mixed plane, where the controller correlated the settlement correctly and then settled the existing attempt without
reading `event.decoded` at all.

```
durable assistant/message or assistant/attempt
        │  decodeStreamRecords  -> one decode of the whole attempt
        │  correlation          -> the attempt whose (turn, step) it uniquely proves
        ▼
TurnTelemetryStore.reconcileAttemptStream(record, attempt, { decoded })
        ├── decoded.complete !== true  ->  refused; nothing is written, and the
        │                                  refusal is counted as `rejected`
        ├── attempt.samples     := one sampleFromChunk pass over decoded.chunks
        ├── attempt.phaseCuts   := phaseCutsFromChunks(decoded.chunks)
        ├── record.firstTokenMs := one-way upgrade (earlier may replace, later may not)
        ├── attempt.temporalEvidenceAuthority := durable-complete (Phase 9.4.5)
        └── everything else     preserved: attemptId, step, startedAtMs, usage, lifecycle
        ▼
settleAttempt(...)   ->  endTurn()  ->  aggregateTurn -> curveSource -> attemptTraces
```

Replacement rather than union or dedupe is structural, not stylistic: the planes share no per-delta identity (a
transient row is keyed by the fold's `(attemptId, index, revision)`, a decoded durable delta by
`(recordIndex, memberIndex)`), so a union double-counts an overlap and a `timeMs + text` dedupe would reorder
same-timestamp deltas. A decode with any malformed record is refused outright, because it is not the whole attempt.

### Temporal-evidence authority (Phase 9.4.5)

`settlementSeq` proves that a durable settlement was **observed**. It does not prove that the attempt's sample timeline
came from a durable stream, and until Phase 9.4.5 the settled temporal-shape gate read exactly that:

```js
durableShape = record.attempts.every(attempt => Number.isFinite(attempt.settlementSeq))   // removed
```

A correlated settlement whose decode was incomplete was therefore refused by the reconciliation — correctly — and the
card still labelled the retained transient tail `temporalShapeQuality: reconstructed`.

The replacement is a field written where the decision is made, not inferred later:

```
src/core/types.js   TEMPORAL_EVIDENCE_AUTHORITY = { live, durable-incomplete, durable-complete }
                    hasDurableTemporalAuthority(attempt) === (… === 'durable-complete')

written by:
  TurnTelemetryStore.beginAttempt        'live' (default; an undeclared source is never durable)
  attemptFromDecoded                     from decoded.complete
  reconstructFromDurable                 from decoded.complete
  materializeReconstructedTurn           carried through to beginAttempt
  reconcileAttemptStream (adopted)       'durable-complete'
  reconcileAttemptStream (refused)       nothing — the samples were not replaced
  open attempt at turn/end               'live'
  acceptChunk / settleAttempt            nothing — appending a sample or observing a
                                         settlement claims no new provenance

read by:
  TurnTelemetryStore.settle()
        durableShape = every contributing attempt hasDurableTemporalAuthority
        -> aggregateTurn({ durable }) -> temporalShapeQuality
```

`temporalEvidenceObserved` is **one-way upward**: a proven claim may be raised when better evidence replaces the
samples, and is never withdrawn, because nothing in the store removes a sample once it is recorded. An unknown or
unrecognised value ranks as `live`, so the failure mode of a forgotten path is an understated claim, never an
overstated one.

The population is the **contributing** attempts (`isContributingAttempt`, the predicate `aggregateTurn` already reduces
with): an attempt with no generated sample draws no vertex, so it can neither support nor degrade the shape. An empty
population cannot claim a durable shape.

The call touches `LiveMeter` nowhere. The live observations already made are historical presentation facts, and
re-feeding the decoded stream through `acceptSample`/`observeTokenBoundary` would re-open episodes the pill had left and
reset its frozen TTFT stage; `test/settlement-reconciliation.test.js` asserts the live snapshot is byte-for-byte
unchanged across the reconciliation, and that the completed card then equals the full-evidence card with only
reconstruction-local attempt identity projected out.

The live-vs-durable equivalence harness states the same distinction: `durableSettledView` carries the authority
`reconstructFromDurable` derived, `liveSettledView` declares none, and `compareTuples` no longer requires the two planes
to agree on `temporalShapeQuality` — it requires each side to satisfy the invariant that a `reconstructed` claim implies
durable temporal authority.

### Curve magnitude provenance (frozen in Phase 7C)

`curveSource` joins `record.attempts` with `aggregate.attemptBreakdown[].calibration.samples`, which is the only place calibration happens. The raw evidence is not mutated and remains the provenance; the join is positional, verified on `attemptId`/`step`/sample count, and degrades **wholesale** to the raw shape if it cannot be trusted, reporting why in `curve.source.issues`.

This is what makes the printed token total and the drawn curve one magnitude system: before it, `aggregateTurn` calibrated a copy of the samples for the metrics while `settle()` drew the curve from the uncalibrated originals.

### One authority for phase evidence (frozen in Phase 7C.2)

Provider usage and the stream make different claims, and the code keeps them apart in the type system rather than in prose: `outputTokens`/`reasoningTokens` are **summary counters**, and the stream's deltas are a **temporal allocation**. `src/core/phase-evidence.js` is the single module that compares them. It returns the symmetric contradiction list and the `temporalAllocationMode`, and both consumers read it:

```
src/core/phase-evidence.js
        │  analyzePhaseEvidence(samples, outputTokens, reasoningTokens)
        ├──────────────► src/core/token-allocation.js   choose the allocation, publish `calibration`
        └──────────────► src/core/aggregate-turn.js     publish metrics, issues and quality axes
```

Before this, the rules lived in both layers and disagreed: `aggregateTurn` guarded only `reasoningTokens === 0` beside a reasoning stream, while `calibrateAttemptSamples` detected a missing phase but calibrated anyway. The first could not see the other three directions; the second published `totalAnchored: true` over a curve whose integral was short by the missing phase's tokens. The invariant the module exists to guarantee:

```
calibration.totalAnchored === true   =>   sum(calibration.samples[].tokens) === usage.outputTokens
```

Calibration therefore has three modes rather than two. `phase-anchored` maps the provider's split onto observed samples; `total-anchored` refuses the split (absent *or* contradicted) and applies one common scale across every observed sample, preserving the total, the temporal shape, the phase labels and the tool-call argument samples; `unanchored` has no provider total to scale toward. `aggregate.temporalAllocationMode` reports the weakest mode among the contributing attempts, and each attempt carries its own. This is separate from `curveSource().calibrationCoverage`, which measures authoritative **total** coverage: a `total-anchored` attempt is fully covered and merely does not claim an exact phase-temporal reading.

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

Used as TPS denominator. Tool waiting is excluded. Reasoning/output duration is derived from model-generated delta boundaries under one documented policy — the MiMo-style **phase episode** policy of `docs/METRICS_SPEC.md` §7: a non-terminal episode ends at the next episode's first sample or at a **phase cut** declaring a different phase (§8.7), the terminal episode ends at the attempt's settlement instant, and a duration that is not measurable is `null` rather than `0`.

### Compressed curve clock

Used only for the completed TPS chart. For each model attempt, preserve the internal time spacing from first generated delta to the attempt's own end; concatenate attempts with no inter-attempt gap:

```text
wall clock:
A model ===== | tool 30 s | B model === | tool | C model ======

curve clock:
A model =====B model ===C model ======
```

Thus tool execution and second-call pre-first-token wait consume zero chart width, while a real stall *inside* an active model stream remains visible as a local rate decay.

Formally, the chart is equivalent to an active model-attempt coordinate, but implementation is safer as explicit attempt concatenation than subtracting arbitrary wall intervals from one global clock.

A **phase cut** is an instant on that coordinate, never a width: `compressAttempts` places it by the same subtraction the samples use (so a cut and a sample at one wall-clock instant share a coordinate), and a cut that precedes its attempt's first generated delta owns no coordinate at all — an attempt's local zero is its first delta — so it is counted in `segments[].preOriginCutCount` instead of being clamped onto zero. Clamping would invent a pre-sample instant and give the attempt a width its evidence does not contain.

The domain boundary is easy to get wrong in one direction only, and the wrong direction is the expensive one: the clock is continuous across an attempt boundary, so it is tempting to treat the episode clock as continuous too. It is not. See "The same rule applies to the completed curve" above for the two clocks and the terminal-tail rule.

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

A `replace` change enters that pipeline as a generation boundary: the feed resets and replays, and the store resets the
same session's evidence (`rebaselineSession`) before the presenter is reset, so the replay rebuilds the projection
instead of merging into the superseded one. The order and its rationale are in §4.

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
`turn-performance-meter` (`order: -10`, additive; the native `stats` occupant keeps its own seat in
`conversation.composer.dock` and is untouched). Phase 3 mounted in the composer dock, which is *below* the
composer; Phase 5B moved it into the list seat and Phase 7 fixed the order. `order` is ascending and that seat's
shipped occupants are `todo` (0), `goal` (10) and `queue` (20), so `-10` places this entry **first**: telemetry, task
state, composer. The value is finite on purpose — no slot contract defines a top pin, so the honest claim is "first
among all currently shipped occupants", which `test/client-bundle.test.js` asserts by sorting this entry against the
shipped occupant list rather than by asserting the literal alone.

One root component projects an explicit state machine onto one view:

```text
MeterRoot (slot component) — owns subscription, ticker and the single style tag
├─ hidden            no session | inactive machine — renders null
├─ LiveMeter pill    while a turn is open
│  ├─ pending-first-token   running first-response stopwatch (once per turn)
│  ├─ streaming-reasoning   ≈cumulative phase TPS + turn elapsed
│  ├─ warming               below the 3-sample warm-up: phase label + episode counter, no rate
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
`DEFAULT_PRESENTATION_REFRESH_MS` = 100 ms in `src/client/live/cadence.js` (Phase 9.2 moved the selection from the
Phase 5A winner of 50 ms to 100 ms as a fidelity decision, matching MiMo's ~100 ms metric and presentation grid;
200 / 100 / 50 / 10 ms remain reachable through the diagnostic override) — and mount/session changes write it, so the
slot owner's high-frequency re-renders cannot
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

### Phase 7D — tool-role results, window changes and completion evidence

Appended after §12, which remains the closing statement of the document's scope. The plugin targets DSH `0.1.7-rc.2`,
and this subsection records the contracts that version changed underneath the adapter and the client feed. The
field-by-field declarations are in `docs/DSH_API_NOTES.md` §13.

#### Call identity moved onto the message

`tool/result` now carries a first-class `ToolResultMessage` (`role: 'tool'`, `toolCallId`, optional `isError`), so the
call identity is read from `data.message.toolCallId` and the failure flag from `data.message.isError`. The legacy
0.1.5 nested shape — a `user`-role message whose first content block owned the same two fields — remains a **labelled
decode path** for the recorded 0.1.5 captures, tagged `TOOL_RESULT_SHAPE.LEGACY_CONTENT_BLOCK`, and it is unreachable
for a message that declares `role: 'tool'`: the discriminator is the role, not a field probe, so a 0.1.7 message can
never fall back to reading its content blocks. A result whose identity cannot be read from the location its own role
declares is `MALFORMED` and fails closed — it closes no call, and it is counted rather than repaired by position. The
structured `data.error` is allowed only when the message is flagged failed; `src/dsh/adapter.js` (`toolResultIdentity`,
`toolResultOutcome`) is the single place this is decided, so a tool result can never be paired by arrival order.

#### Window changes

The feed consumes the three entry-bearing change kinds and the settlement kind as four distinct facts:

- `append` — the new entries are processed in order; dedupe is by durable `seq` and, for transient rows, by row
  identity. A durable `seq` is admitted once per generation and a repeat is inert: it produces a `duplicate-durable-event`
  diagnostic and nothing else, so a replayed row cannot refresh its turn's retention position or its admission count.
- `prepend` — older history, outside the live tail and out of chronological order relative to what has already been
  consumed. It is counted (`ignoredPrepends`) and never guessed at.
- `replace` — a rebaseline. The feed clears every piece of generation state it owns — durable sequences, transient row
  identity, the open turn and attempt, the adoption guards, the attempt-to-coordinate map, the settled-attempt set and
  the outstanding-settlement queue — before replaying the replacement window, and the store resets the same session's
  evidence (§4). The durable `seq` set is cleared here and only here, which is what lets the next generation reuse a
  sequence number the previous one had admitted.
- `settle-assistant` — see below.

#### The settle-assistant disambiguation

A bare `settleAssistant(attemptId)` is issued by DSH for two different situations: the normal retirement that follows
the publication of the retired attempt's `step/end`, and a true abandonment. The absence of an entry does not separate
them (`docs/DSH_API_NOTES.md` §13.4), so the feed resolves the bare call from **held evidence** instead of from the
wire form:

- `settledAttemptIds` — the attempts that received a durable settlement *directly*, through a `settle-assistant` change
  that named the attempt and carried its entry. A bare settle naming one of these can only be a retirement, because the
  retirement carries no entry.
- `pendingSettlements` — a queue of durable, non-interrupted `assistant/message` settlements that have been published
  but not yet retired, oldest first, each keyed by the `(turn, step)` its transient rows declared. The queue is both the
  proof that a retirement is happening and the **budget** that stops one settlement from excusing a later attempt in the
  same step; one bare call consumes exactly one entry.

The routes are tried in order of strength — the attempt's own identity, then its recorded coordinate, then a single
unmatched outstanding settlement — and a bare call that no route covers is recorded as an unresolved settlement and
emitted as an abandonment. The failure this prevents is specific: treating every bare settle as an abandonment
overwrites a committed outcome with an abandonment claim, and the 0.1.5-era reading did exactly that. The bare settle
is a signal that the attempt's transient rows are now redundant, not a claim about how the attempt ended.

#### Diagnostics, turn-end terminality and reconstruction

`controller.diagnostics(sessionId)` is the single read surface for this path and publishes two counter groups, each
incremented where the fact happens rather than derived later: the feed's raw-versus-accepted counters
(`rawDurableEvents`, `rawTransientRows`, `rawToolCalls`, `rawToolResults`, `matchedToolResults`,
`unmatchedToolResults`, `malformedToolResults`, `rawTurnEndSeen`, `normalizedTurnEndSeen`, `bareSettleSeen`,
`settlementsWithEntry`, `retirementsResolved`, `abandonmentsResolved`, `lateTurnRows`, `lateTurnEvents`) and the
controller's completion-path counters (`normalizedTurnEndSeen`, `turnEndLookupHit`, `turnEndLookupMiss`,
`turnEndReconstructed`, `storeEndTurnCalled`, `presenterTurnEndApplied`, `settledSnapshotBuilt`, `ignoredAfterSettled`,
`matchedToolResults`). A terminal boundary that went missing is then readable as the first counter that stayed at zero,
and `rawTurnEndSeen` discriminates "the wire never delivered the boundary" from "the plugin discarded it".

A `turn/end` is terminal and is never refused for want of a record. The record is normally present, but the published
window is a live tail, so a client that attached after the turn began can receive `turn/end` for a turn whose opening
row is outside the window and whose transient rows were already superseded. That case is counted
(`turnEndLookupMiss`, `turnEndReconstructed`) and recorded as a `turn-end-without-record` issue; the machine is opened
as a **recovered** boundary so it can own the turn identity and settle it, and the turn is closed with the reason the
event carries — which the host published authoritatively, so nothing about the live display is converted into evidence.
Late durable rows of a turn that already settled are dropped and counted rather than allowed to reopen it, so a
completed card cannot be resurrected by evidence that arrives after its boundary.

As Phase 7D left it, that handling was **lifecycle only**: `startMs` came from `observedTurnStart` and the record was
otherwise empty, so the card closed with no metrics. The paragraph above describes the behaviour from Phase 7D.1
onward; the retention and materialization that make it true are the next subsection.

#### Retention and the Phase 7D.1 repair of that reconstruction

Phase 7D repaired the terminal **lifecycle** only: the miss path opened an empty record and closed it, so the card
appeared with zero attempts, zero tokens and no tools while the turn's durable evidence sat in the window the handler
had just read. Phase 7D.1 closes the metric half. Two things were added, and neither is a second parser.

`SessionEventFeed` retains every durable row it accepts, keyed by the turn the row names, for the lifetime of the
current window generation (`DurableEvidencePool`, bounded at `MAX_RETAINED_TURNS = 32` turns). Eviction is
**least-recently-updated**: admitting a turn beyond the bound releases the retained turn whose last arrival is oldest,
and another durable row of a turn refreshes that turn's position. The policy is chosen for the consumer rather than for
symmetry with a queue — the turn a `turn/end` miss can ask about has been publishing evidence moments earlier, so it is
the most recently refreshed entry and is never the eviction victim, whereas first-seen FIFO would release a long turn
that began 33 turns ago while it was still running. Rows are held exactly as they arrived and the per-turn row array
keeps pure arrival order; only the map's turn order is a retention policy.
Retention is hooked into **both** routes by which a durable row enters the feed — an appended window entry, and the
entry carried by a `settle-assistant` change — because DSH delivers a settlement by both and a path covering only one
would lose the attempts that travelled the other. `rebaseline()` clears the pool with the rest of the generation state;
that boundary is what stops one generation's settlement being reconstructed together with another's `turn/end`.
Consumers read rows through `turnEvents(turn)`; the feed decodes nothing.

Two quantities are bounded here, and they have different lifetimes. **Row retention is bounded by turns**: eviction
releases the least recently updated turn's rows to bound memory. **Durable seq identity is generation-wide**: a `seq`
admitted earlier in the generation can never become new evidence again, even after the row carrying it has been evicted,
because DSH's sequence numbers are only distinct within a generation and a replayed row is the same durable fact whether
or not this client still holds its bytes. Eviction therefore forgets the retained row bytes but not the fact that the
`seq` was already seen, and `rebaseline()` is the only boundary that clears both. This is why eviction is a single map
`delete` with no walk over the released turn's rows: nothing outside the map is derived from them.

Every durable entry route passes one admission gate, `admitDurable(event)`, and its substance is its **order**: the
`seq` is recorded as seen before retention is attempted and before normalization, so a row refused for either reason is
refused for good. Because admission precedes retention, a duplicate cannot reach the pool at all — it cannot count as
activity of its turn, cannot refresh that turn's retention position, and cannot change which turn a later admission
evicts. Keeping the generation-wide identity in the pool instead, with eviction trimming it, is what made a row that
ingestion rejected still mutate retention.

Retention diagnostics distinguish two different quantities, and the distinction is deliberate: `retainedTurnCount()`
reports **current** occupancy in turns (bounded by `MAX_RETAINED_TURNS`, decreasing on eviction), while
`counters.retainedDurableEvents` is a **cumulative ingest count** of distinct durable rows admitted into retention during
the generation — it is never decremented on eviction and resets with the pool at a rebaseline, so it is not a current row
count and must not be read as one. It counts rows *retained*, not seqs *admitted*: a row naming no turn is admitted as an
identity but cannot be retrieved by `turnEvents(turn)`, so it is not one of them.

`src/dsh/reconstruction.js` bridges the reconstruction into the store.
`materializeReconstructedTurn()` calls `reconstructFromDurable` (`src/dsh/durable-path.js`, still the only module that
decodes a settlement) and routes its output through the store's own methods — `beginTurn`, `turnStartObserved`,
`beginAttempt`, `acceptChunk`, `setAttemptUsage`, `settleAttempt`, `toolStarted`, `toolSettled`:

```text
turn/end with no open record
  -> feed.turnEvents(turn)
  -> reconstructFromDurable()
  -> store.beginTurn / beginAttempt / acceptChunk / setAttemptUsage / settleAttempt / toolStarted / toolSettled
  -> store.endTurn()
  -> aggregateTurn -> curveSource -> compressAttempts -> attemptTraces -> render budgeting
  -> completed card
```

The recovered record is therefore an ordinary store record and the recovered curve is the ordinary curve; there is no
`tail recovery curve`. Attempt identity, which the durable plane does not carry (`attemptId` is process-local to the
client fold and never enters a settlement), is `settlement:<settlementSeq>` — derived from the settlement's own
sequence, never from a wall clock or a UUID, so replaying one window twice yields the same store key. It is a
store-internal key and is never presented as a DSH attempt identity.

What stays unknown is exactly what the tail cannot determine. With no `turn/start` row the record's `startMs` is
`null`, and TTFT and turn elapsed — both intervals from the start — are `null` as well rather than inferred from the
first delta, a `step/start`, a `tool/call`, the attach instant or the clock. `record.firstTokenMs` *is* recovered,
because the settlement's embedded compact stream preserves the original delta timestamps and the earliest generated
sample is observed durable evidence; a known first token beside an unavailable TTFT is the correct state, not a gap. A
turn whose only visible row is its own `turn/end` reconstructs to an empty turn with no attempt, tool, duration or
sample manufactured to fill the card.

`turnEndReconstructed` counts one reconciliation — a miss that was closed from available durable evidence — and
deliberately does not claim that evidence was non-empty; the `turn-end-without-record` issue carries
`reconstructedAttempts`, `reconstructedTools` and `startKnown` for a caller that needs the distinction.

The feed's diagnostics also keep the three tool quantities separate, because a single counter cannot express the
distinction the compact pill needs: `historicalTools` is what the settled turn record holds, `liveRunningTools` is the
live meter's own running set, and `livePresentedToolCount` is the same set gated on the tool stage owning the view. The
two live counters are read from the meter's own running set rather than from a snapshot taken at the wall clock, because
taking a snapshot advances the episode clock the diagnostic was only supposed to observe (and, before Phase 9.2, evicted
expired samples from the rolling window). The gate matters for the same reason: a turn that ended with a call whose result was
never observed closes its presentation while the unresolved call stays on the record as incomplete evidence.

### Phase 9.3 — DSH 0.2.0-rc.2 compatibility

The normative runtime moved from `0.1.7-rc.2` to `0.2.0-rc.2`, and this subsection records what that did and did not
change. It is short because the answer is "nothing in the data path", and the reason is worth stating precisely rather
than as an assurance.

Every DSH declaration the plugin reads was re-audited at the public reference commit
`639ed015397290b3745d163aafe02ffee4aa3f84` and compared against the previous reference
`477b4f420553e8a52c2fbccc464d7561b239c443` by **blob hash**, not by eye. All fourteen are identical: the session event
types, the LLM stream and compact-stream types, the whole session-controller client contract, the conversation slot
contract, the plugin-compatibility gate, and both TodoPanel files. The table and the installed-runtime confirmation are
in `docs/DSH_API_NOTES.md` §14.

That result has a direct architectural consequence, and it is the point of the phase: **the boundary this project drew
in Phase 2 held.** `src/dsh/**` is the only layer that knows DSH field names; because the field names did not move,
neither did any layer above it. No adapter code, no normalization rule, no metric arithmetic and no presentation rule
changed. In particular the Phase 9.2 phase-cumulative TPS semantics — the live estimator, the 100 ms presentation
cadence, the phase-local reset, the stall decay, the settlement recomputation, the 100 ms curve grid with its
200-point cap and nearest-neighbour reduction — were not reopened, and the completed card's visual contract was not
restyled. A change of *runtime* is not a change of *contract*, and the two are separated here so that a future version
bump is not mistaken for an occasion to revisit frozen semantics.

What did change is the compatibility declaration. `package.json` now carries an exact
`"@deepseek-ai/dsh": "0.2.0-rc.2"` peer. The gate that reads it
(`evaluatePluginCompatibility`, installed at `dsh-app-boot/lib/index.js:286-313`) evaluates
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })` over peers named `@deepseek-ai/dsh` or
`@deepseek-ai/dsh-*`, so an exact prerelease pin is both satisfied by the intended runtime and unsatisfied by every
runtime this project has not exercised. DSH `0.2.0-rc.2` additionally ships exact-version *exemptions*
(`allow-version`, `revoke-version`, `version-exemptions`); **none is used here**, because an exemption accepts a
declared incompatibility and this plugin declares none.

The evidence layer for the claim is `test/dsh-020-contract.test.js`. It is deliberately narrow — the eight contract
groups rather than a re-test of the metric semantics, which are covered by the existing suite and by the
`test/dsh-017-*.test.js` files that remain stamped with the 0.1.7 evidence they were recorded on. Read together with
§13 of the API notes, the structure is: the 0.1.7 corpus and its tests are the historical record, §14 and the 0.2.0
contract test are the current baseline, and the two are kept apart rather than merged into one restamped set.

## 12. Non-goals

This project is not:

- a billing/token-cost meter;
- a session-wide aggregate stats replacement;
- an end-to-end timeline visualization;
- a profiler for tool stdout throughput;
- a DOM observer;
- a DSH core patch.
