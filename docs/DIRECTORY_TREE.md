# Directory Tree

```text
dsh-turn-performance-meter/
├── README.md                         User/developer entry point
├── package.json                      DSH bundle + client manifest (test / build:client / verify)
├── cordis.patch.yml                  Bundle row insertion
├── index.js                          Host entry (no-op by design)
├── client.js                         GENERATED browser bundle (scripts/build-client.mjs)
├── lib/client.js                     byte-identical mirror validated by dsh-super-injector
├── .gitignore
│
├── docs/
│   ├── ARCHITECTURE.md               Layering, state, timing domains, transport
│   ├── METRICS_SPEC.md               Normative formulas, quality axes, evidence rules
│   ├── UI_SPEC.md                    Live/completed/hover interaction contract
│   ├── DSH_API_NOTES.md              Verified DSH extension/API evidence
│   ├── TASKS.md                      Ordered implementation phases + gates
│   ├── TEST_PLAN.md                  Unit/integration/browser test matrix
│   ├── DIRECTORY_TREE.md             This file
│   ├── START_PROMPT.md               Prompt to start DeepSeek V4.1 Flash
│   ├── IMPLEMENTATION_LOG.md         Local API findings, fixture provenance, build diary
│   └── assets/
│       ├── reference-live-ttft.png
│       ├── reference-live-streaming.png
│       ├── reference-completed-summary.png
│       └── reference-hover-curve.png
│
├── fixtures/                         Recorded DSH turn evidence (offline; no DSH needed)
│   ├── README.md                     Scenario table, file shape, regeneration steps
│   ├── index.json                    Generated index of the recorded set
│   ├── dsh-0.1.7/                    The rc.2 corpus: index.json + t01-sequential-tools.json
│   ├── dsh-turns/                    Eight real turns (recorded on 0.1.5): durable + transient planes verbatim
│   │   ├── t1-reasoning-tool-reasoning.json
│   │   ├── t2-pwsh-write-edit.json
│   │   ├── t3-interrupted-mid-reasoning.json
│   │   ├── t4-reasoning-tool-deepseek-official.json
│   │   ├── t5-reasoning-text-deepseek-official.json
│   │   ├── t6-tool-only-deepseek-official.json
│   │   ├── t7-failing-pwsh-deepseek-official.json
│   │   └── t8-reasoning-no-retry-deepseek-official.json
│   └── derived/                      Four declared synthetic mutations
│       ├── d1-no-reasoning-tokens.json
│       ├── d2-partial-usage.json
│       ├── d3-attempt-without-message.json
│       └── d4-unmatched-tool-result.json
│
├── src/
│   ├── core/                         Pure metric engine — zero @deepseek-ai/* imports
│   │   ├── types.js                  JSDoc normalized domain records
│   │   ├── metric-quality.js         exact/calibrated/estimated/unavailable + rateQuality
│   │   ├── quality-model.js          tokenTotal / phaseSplit / temporalShape axes + ceilings
│   │   ├── delta-accounting.js       Delta classification, strict compact-stream decoder, first-token evidence
│   │   ├── rate-publication.js       The one rate-publication policy shared by the live pill and the curve
│   │   ├── phase-duration.js         Phase-episode duration attribution (MiMo-style, Phase 9.2)
│   │   ├── phase-evidence.js         The one authority for provider-counter vs stream-phase contradictions and modes
│   │   ├── token-allocation.js       Delta shape weighting + usage calibration
│   │   ├── live-metrics.js           LiveMeter: phase-cumulative TPS, TTFT, tool phase
│   │   ├── tool-timing.js            Sum and union tool durations
│   │   ├── time-axis.js              Compressed model-attempt chart clock (two clocks per sample)
│   │   ├── curve.js                  Attempt-local phase-cumulative trace, phase-coloured runs, peak, stored-series cap, downsampling
│   │   ├── curve-source.js           The calibrated curve input: stored attempts joined with their reduction
│   │   ├── aggregate-turn.js         Turn-level weighted final metrics + quality axes
│   │   └── turn-state.js             Pure lifecycle state machine + turn/end mapping
│   │
│   ├── dsh/                          DSH rc.2 raw evidence -> normalized events
│   │   ├── index.js                  Public surface of the adapter layer
│   │   ├── raw.js                    Plane discriminants; the only wire-shape predicates
│   │   ├── adapter.js                Field mapping (the only place DSH names are read)
│   │   ├── stream-decoder.js         Durable AssistantStreamRecord decoder + quality
│   │   ├── live-path.js              Path A: transient frames + durable boundaries
│   │   ├── durable-path.js           Path B: settlements only; tail measurement source
│   │   ├── reconstruction.js         Durable evidence -> reconstructed turn record (terminal-tail route)
│   │   └── client-feed.js            SessionEventWindow wire -> normalized events
│   │
│   ├── host/
│   │   └── telemetry-design.js       DSH-agnostic normalized store, session+turn keyed
│   │
│   └── client/
│       ├── ui-model.js               Pure UI view-model shaping (live + completed seams)
│       ├── format.js                 Number/time formatting with `—` for absent evidence
│       ├── base-css.js               Shared scoped tokens and the plugin type scale
│       ├── main.js                   Browser entry: locale + controller + slot registration
│       ├── live/                     Live meter + shared presentation lifecycle
│       │   ├── MeterRoot.js          Slot component: routing, subscription, ticker, style tag
│       │   ├── cadence.js            The one presentation-cadence constant (+ debug override)
│       │   ├── live-state.js         Eight-state UI machine (explicit transitions)
│       │   ├── live-presenter.js     machine + LiveMeter snapshot + settled -> view model
│       │   ├── live-format.js        ≈ TPS / stopwatches / tool labels
│       │   ├── refresh.js            single presentation ticker, coalesced lead render
│       │   ├── controller.js         eventSource attach -> store + presenter, per session
│       │   ├── locale.js             turnPerformanceMeter en/zh dictionary + fallback
│       │   ├── live-css.js           scoped pill stylesheet string (light/dark accent)
│       │   └── LiveMeter.js          React pill (browser-only) + debug counters
│       ├── completed/                Completed card + the Phase 5 curve view
│       │   ├── completed-tree.js     React-free card shell: two stacked views, footer, aria
│       │   ├── metric-cell.js        One metric column, shared by both views
│       │   ├── curve-view-model.js   The ONLY curve seam: phase runs, axis, per-run path, peak marker
│       │   ├── curve-tree.js         React-free SVG element tree, one <path> per run
│       │   ├── view-mode.js          Hover/focus interaction state machine (pure)
│       │   ├── CompletedMeter.js     React binding over the card (browser-only)
│       │   └── completed-css.js      scoped card stylesheet (4-column grid, 2-column wrap)
│       └── README.md                 Client implementation constraints
│
├── dev/                              Dev-only capture tooling (not in the bundle)
│   ├── README.md
│   ├── fixture-recorder/             Injected host recorder (session/event + assistant-stream)
│   ├── capture-scenario.ps1          Launch/interrupt a recorded scenario
│   ├── harvest-fixtures.mjs          Raw recording -> fixtures/dsh-turns/*
│   ├── mutate-fixtures.mjs           Deterministic synthetic derivatives with provenance
│   ├── measure-generation-tail.mjs   Generation-tail evidence for the duration policy
│   ├── inspect-recording.mjs         Chronology dump of one raw recording
│   ├── recordings/                   Launch receipts + captured model catalog
│   └── scratch/                      Working directory the B1 scenario wrote into
│
├── test/
│   ├── helpers/
│   │   ├── fixtures.js               Fixture loading contract
│   │   ├── equivalence.js            Live-vs-durable harness + metric tuple comparison
│   │   └── live-replay.js            Fake eventSource + fixture replay + ticker lifecycle
│   ├── core …                        pure-engine tests (one per src/core module)
│   ├── quality-model.test.js
│   ├── dsh-adapter.test.js
│   ├── dsh-stream-decoder.test.js
│   ├── dsh-equivalence.test.js        Phase 2 acceptance: both paths agree per fixture
│   ├── dsh-fixtures.test.js           Fixture contract + synthetic provenance
│   ├── dsh-degradation.test.js        The twelve required degradation/corruption cases
│   ├── generation-tail.test.js        Frozen phase-duration evidence
│   ├── client-bundle.test.js          Bundle determinism, module table, slot, CSS contract
│   ├── live-controller.test.js        Fixture replay, session isolation, ticker bounds
│   ├── live-refresh.test.js           Scheduler structure at every measured cadence
│   ├── cadence.test.js                One cadence constant; override reachable only when debugging
│   ├── ui-model.test.js               Live + completed view models
│   ├── completed-tree.test.js         Card element tree, aria, footer, per-layer no-chart contract
│   ├── completed-lifecycle.test.js    Live/completed switching, durable reload, static card
│   ├── completed-interaction.test.js  Hover/focus/blur machine, aria-hidden, focus ring, empty curve
│   ├── curve-view-model.test.js       Evidence runs, axis ceiling, peak marker, bounded geometry
│   ├── curve-attempt-boundary.test.js Phase 6: the cross-attempt counterexample + live equivalence
│   ├── curve-regression-matrix.test.js Phase 6: one named scenario per frozen curve semantic
│   ├── curve-quality.test.js          Phase 6: curve quality is the temporal-shape axis
│   ├── cadence-contract.test.js       Phase 6: source-level core/client timing separation
│   ├── runtime-robustness.test.js     Phase 6: tools, retries, errors, reload, duplicate frames
│   ├── curve-reference-cumulative.test.js Phase 9.2: O(n) reference for the phase-cumulative estimator
│   ├── curve-episode-opening.test.js  Phase 9.2: episode opening, phase reset, seam sharing
│   ├── curve-render-budget.test.js    Phase 7: the chart-wide budget and its retention properties
│   ├── mid-turn-reload-recovery.test.js Phase 7: adoption, guards, authoritative upgrade, TTFT paths
│   ├── curve-peak-priority.test.js    Phase 7A.1: retention priority across every run length (BLOCKER A)
│   ├── rebaseline-generation.test.js  Phase 7A.1: window generations and session-scoped store reset (BLOCKER B)
│   ├── curve-calibration.test.js      Phase 7C: the calibrated-magnitude counterexample + the Phase 7B reproduction
│   ├── curve-source.test.js           Phase 7C: the positional, verified join; Phase 7C.2: the global integral sweep
│   ├── curve-phase-cumulative.test.js Phase 9.2: the grid, phase reset, stall decay, terminal tail, the 200-point cap
│   ├── curve-trace-matrix.test.js     Phase 7C: fourteen named scenarios for the attempt trace
│   ├── curve-long-agent-visual.test.js Phase 7C: the 24-call visual regression and the rejected geometry's cost
│   ├── phase-evidence.test.js         Phase 7C.2: the contradiction matrix, counterexamples A-D, the anchored integral
│   ├── dsh-017-*.test.js              Phase 7D / 7D.1 / 7D.1.2: the rc.2 contract — completion, settlement, tool
│   │                                  result and concurrency, durable identity, retention, terminal-tail recovery,
│   │                                  reconstruction materialization, recorded corpus (8 files)
│   ├── dsh-020-contract.test.js       Phase 9.3: the 0.2.0-rc.2 compatibility layer — envelope, boundaries,
│   │                                  settlements, tool plane, compact-stream timing, the five stream chunks,
│   │                                  settle-assistant semantics, the four window-change kinds, the exact peer pin
│   ├── background-settlement.test.js  Phase 9.3.1: a settlement ingested with no projection in between must project
│   │                                  the newest settled turn first; completed identity and memo behaviour
│   ├── rate-publication.test.js       Phase 9.4: the shared rate-publication policy as a pure function
│   ├── curve-rate-publication.test.js Phase 9.4: the curve's ladder and eligibility — off-grid openings, 1 ms and
│   │                                  50 ms denominators, warm-up, peak selection, peak provenance
│   ├── ttft-boundary.test.js          Phase 9.4: the first-token predicate as the TTFT boundary, live vs durable
│   ├── phase94-regressions.test.js    Phase 9.4: baseline-proven regressions for the two repaired defects
│   ├── boundary-episode-origin.test.js Phase 9.4.2: a boundary-only first token opens no TPS episode clock; the
│   │                                  live/completed denominator-origin parity fixture and the provider-baseline matrix
│   ├── phase-cut-parity.test.js       Phase 9.4.3: a non-magnitude phase cut closes the outgoing episode without
│   │                                  opening the incoming one — the principal fixture, the pre-origin and same-phase
│   │                                  controls, the durable/reload parity proof and the publication-gate scan
│   ├── settlement-reconciliation.test.js Phase 9.4.4: a durable settlement completes the transient attempt it is
│   │                                  correlated to — the mixed-plane principal fixture against the full-evidence
│   │                                  reference, the overlap/double-cut/pre-reload-restoration cases, the two
│   │                                  pure-path controls, the retry and ambiguous-correlation cases, the live-meter
│   │                                  non-replay proof and the real `replace` rebaseline regression
│   ├── dsh-client-feed.test.js        SessionEventWindow wire -> normalized events
│   ├── curve.test.js / curve-axis-endpoint / curve-stream-order /
│   │   curve-calibration-coverage     Curve primitives: reduced arithmetic, endpoint retention, same-timestamp
│   │                                  ordering, calibration coverage
│   ├── live-presenter / live-state / live-format
│   │                                  Live seams below the React pill
│   ├── format.test.js                 Shared number/time formatting
│   └── completed-format.test.js       Formatter edge cases (no NaN/Infinity/-0 in UI)
│
└── scripts/
    └── verify-structure.mjs
    └── bundle-client.mjs / build-client.mjs
    └── sanitize-fixtures.mjs / verify-sanitization.mjs

dev/screenshots/                      git-ignored evidence captures
                                      (phase3/, phase5/, phase7b/, phase7c/, phase7c1/, phase7d/)
```

Expected evolution during implementation:

```text
src/client/    — landed in Phase 5 as src/client/completed/{curve-view-model,curve-tree,view-mode}.js
test/          — landed in Phase 5 as curve-view-model.test.js and completed-interaction.test.js;
                 Phase 6 added curve-attempt-boundary, curve-regression-matrix, curve-quality,
                 cadence-contract and runtime-robustness; Phase 7 added curve-reference-window,
                 curve-episode-opening, curve-render-budget and mid-turn-reload-recovery; Phase 7A.1
                 added curve-peak-priority and rebaseline-generation; Phase 7C added curve-calibration,
                 curve-source, curve-total-rolling, curve-trace-matrix and curve-long-agent-visual;
                 Phase 9.4 added rate-publication, curve-rate-publication, ttft-boundary and
                 phase94-regressions; Phase 9.4.2 added boundary-episode-origin; Phase 9.4.3 added
                 phase-cut-parity and extended curve/phase-duration/delta-accounting/time-axis in place;
                 Phase 9.4.4 added settlement-reconciliation
browser/e2e    — no in-tree harness; Phase 5 evidence is dev/screenshots/phase5/ plus the raw
                 JSON captured by an out-of-tree CDP driver (see IMPLEMENTATION_LOG.md §10).
                 Phase 6 verified the *served* client bundle in the live page instead of taking
                 pixels, and TEST_PLAN.md §3 states that gap explicitly. Phase 7C captured the
                 completed curve in a clean-started host under dev/screenshots/phase7c/.
```

Do not create parallel copies of the same metric formula in host and client. Pure formulas remain in `src/core` and are reused wherever the final build pipeline permits. `scripts/verify-structure.mjs` fails when a `src/core` module has no matching test.
