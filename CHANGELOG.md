# Changelog

User-facing release history for `dsh-turn-performance-meter`. The per-phase implementation record — root causes,
counterexamples, fixture provenance and gate evidence — is in `docs/IMPLEMENTATION_LOG.md`; this file is the summary a
user of the plugin reads.

Distribution status: published to the public npm registry as `dsh-turn-performance-meter`, with the GitHub Release
`.tgz` retained as an offline, immutable fallback.

## Unreleased — DSH 0.2.1-rc.3 compatibility (Phase 13.0 / 13.0R)

**Not published, not tagged, not version-bumped.** This entry records the development state on
`compat/dsh-021-rc3` (fast-forwarded to `main` in Phase 13.0R); `package.json` stays `0.1.6`. It is a runtime-target
compatibility migration, not a feature release: no TPS, TTFT, estimator, curve, rendering or lifecycle algorithm
changed.

The development target moved from DSH `0.2.1-rc.2` (reference commit
`687f282e8625c6b8d11ff58211a90524be2e4317`) to `0.2.1-rc.3` (reference commit
`1f81c047fc48fa190a683e469daa699857e9afe8`, tag `dsh-v0.2.1-rc.3`).

- Exact peer is now `"@deepseek-ai/dsh": "0.2.1-rc.3"`. This is the only required change: the rc.3 compatibility
  checker is byte-identical, and an exact `0.2.1-rc.2` peer is unmet on an rc.3 runtime, which silently puts a profile
  bundle into `skippedBundles` — without the moved pin the meter would not load at all. No compatibility exemption is
  used or required, and `allow-version --accept-risk` is not part of the migration. The pin is exact on purpose (no
  wide semver range): the working tree therefore supports `0.2.1-rc.3` only, and the published `v0.1.6` artifact keeps
  its own exact `0.2.1-rc.2` pin and is not restamped.
- **No production source change.** Every DSH declaration this plugin consumes is byte-identical between the two
  reference commits — the `SessionEventWindow`/`SessionEventChange`/`MutableSessionEventSource` contract, `Session` and
  `SessionManager`, `SessionBinding`/`sessions.binding()`, `sessions.retainInfo()` with its stable-per-id observer
  source, the transient `assistant/live-chunk` producer, the durable `turn/start`/`turn/end`/settlement events, the
  compact `AssistantStreamRecord` decoder, `conversation.input.dock` (`{ kind: 'list'; scope: 'session'; owner:
  InputZone }`), the slot renderer/registry, the bundle loader and the plugin-compatibility evaluator. The rc.3 product
  changes are additive and outside the consumed surface: the Conversation header View-tab More menu (new root-scope
  slot `conversation.session.header.views.actions`, registered by the first-party entry-customization row), View pins,
  navigation entry customization, and the `ui-workspace` new-session draft/reuse behaviour. The rebuilt bundle is
  therefore byte-identical to the Phase 12.0R accepted artifact:
  `client.js`/`lib/client.js` 651,961 B, SHA-256
  `07F717FA4BA11425A034B3DD81E122C208D99D1783E4C0F919C409118137ED69`.
- **Tests.** `test/dsh-021-rc3-contract.test.js` is the new normative layer: it pins the rc.3 reference commit, the
  exact peer, the historical evidence boundary, the three Cordis injections and the bundle patch, the dock seat and its
  `order: -10`, the absence of any rc.3 menu seat in the plugin's registration, the wire evidence, the
  `retainInfo`/source-generation semantics (observe-only watch, release on generation retirement, exactly one re-armed
  watch and one subscription on the returning activation, pre-history revision-0 deferral) and the frozen 100 ms
  cadence with `MIN_RATE_SAMPLES = 3` / `MIN_RATE_ELAPSED_MS = 100`. The rc.2 layer
  (`test/dsh-021-contract.test.js`) and the 0.2.0 layer (`test/dsh-020-contract.test.js`) are retained as historical
  records; only their cross-file peer guard tracks the live peer. Suite: **960 tests, 960 pass, 0 fail, 0 skipped,
  0 todo** (946 Phase 12.0/12.0R baseline + 14 rc.3 contract tests).
- The Phase 12.0/12.0R fixes are preserved unchanged: session activation recovery, source-identity-aware rebind,
  authoritative revision resync, pre-history generation deferral, `bindingPending` stale-state suppression, retired
  retention-watcher release, single-watcher rebuild on re-entry, historical telemetry retention, foreground recovery,
  and main/subagent statistical isolation.
- **Real DSH `0.2.1-rc.3` acceptance: 123/123 checks PASS, 0 failed, 0 not observed.** On an isolated `0.2.1-rc.3` host
  (exact peer accepted, no compatibility exemption, plugin in the served module graph with three Cordis injections, no
  `skippedBundles`) the real-browser matrix observed: boot/dock 19/19; R1 live TTFT + live TPS + 100 ms cadence
  (p50 100 ms, p95 103 ms, timer stopped on completion); R2 a real `pwsh` tool window pauses the rate and the model
  phase resumes after it; R3 completed-card tokens and attempts exactly equal to the durable turn (2,002 tokens,
  1 attempt, peak ≈306); R4 three real main → subagent → main trips inside a live parent turn with identity rebind,
  one watcher and one plugin subscription per return; R5 a real scope retirement leaves the retired source with zero
  listeners and the new generation with exactly one plugin subscription; R6 the 120/150-session retention contract
  (retired sessions hold zero plugin watchers while telemetry is retained, a re-visit arms exactly one); R7 a real
  Win32 minimize/restore producing exactly one foreground recovery per real hidden→visible edge with the ticker
  suspended while hidden; R8 a genuine multi-attempt connector (output, attempt 2 → 3) with 547 tokens == durable;
  R9 the rc.3 header View-tabs More menu and draft reuse leave the dock seat, mount count and bound session
  unchanged. Evidence is local, under the git-ignored `dev/phase13/`. Verdict:
  **PASS — DSH 0.2.1-rc.3 COMPATIBILITY ACCEPTED; INDEPENDENT SOURCE AUDIT CLOSED.**
- **Independent source audit closed (Phase 13.0R), and the reviewed branch was fast-forwarded to `main`.** The
  external GitHub remote source audit passed on the GitHub commit, the package manifest (`0.1.6`, exact peer
  `0.2.1-rc.3`, no exemption), the code diff (no production logic change; the bundle is byte-identical at
  `07F717FA4BA11425A034B3DD81E122C208D99D1783E4C0F919C409118137ED69`) and the contract tests. It is a *source-level*
  verification and did **not** independently re-run the isolated real-browser matrix, so the 123/123 runtime result
  above remains this project's own executed evidence. The accepted history
  `568ebaae → bdcd4265 → 5500c576 → 011ab975 →` the closure commit was fast-forwarded onto `main` with `--ff-only`; no
  merge commit exists, `HEAD == origin/main` and divergence is `0 0`. The round is documentation-only — no production
  source, test, bundle or manifest file changed — and no release occurred: version `0.1.6`, exact peer `0.2.1-rc.3`,
  and the published `v0.1.6` artifact unchanged and still bounded to `0.2.1-rc.2`.

## Unreleased — session navigation recovery (Phase 12.0, planned as 0.1.7)

**Not published, not tagged, not version-bumped.** This entry records the development state on
`fix/session-navigation-resync`; `package.json` stays `0.1.6` and the exact peer stays `@deepseek-ai/dsh: 0.2.1-rc.2`.

Fixed the reported DSH `0.2.1-rc.2` defect where the live meter could stay frozen on a stale phase (tool call /
waiting for model) after moving between the main agent and a subagent session, even though the agent had advanced.
Root cause: navigating away releases the DSH session scope, which retires its binding and disposes its
`SessionEventSource`; navigating back materializes a new scope with a **new** source (revision restarts at 0). The
plugin's `attach()` treated an already-known session as still-subscribed, so it kept the retired source and only
document foreground events triggered the identity-aware `resync()`.

- Every session activation (`sessionId` mount/change) now runs an authoritative binding check: identity-aware
  rebind of a replaced generation, idempotent authoritative window resync of the same generation, and never a second
  subscription.
- `ctx.sessions.retainInfo(sessionId)` (public `ObservableSnapshot`, subscribing does **not** retain) is used as the
  event-driven binding-ready signal for a temporarily absent binding. No polling and no extra `SessionReference`.
- A source rebind is atomic: old subscription released, new source adopted/subscribed, full generation rebaseline
  over the authoritative window, presentation cache cleared. A new scope's empty revision-0 pre-history window is
  not adopted as evidence: the previous settled card stays readable until the real history publication arrives.
- A temporarily missing binding suppresses stale live claims (no fabricated tool/waiting state) while telemetry and
  settled history are retained; session activation is independent of document visibility, and Phase 10.1R foreground
  recovery is unchanged.
- **Resource lifecycle (Phase 12.0R).** The binding-ready `retainInfo` watch installed by this fix is now released on
  the session scope's `1 -> 0` retirement edge and re-armed on activation, instead of staying installed for the client
  lifetime. Visiting many sessions therefore no longer leaves one live retention observer callback (and one map entry)
  per visited session; a retired session needs no permanent watcher because returning to it is an authoritative
  session activation. Historical telemetry — settled cards, turn records and bounded feed evidence — is retained
  unchanged. Additive read-only `controller.lifecycle()` reports `{ sessions, retentionWatches, listeners, disposed }`.
- **No change** to TPS/TTFT/reasoning-output attribution/tool timing/token allocation/attempt-local reset/completed
  curve/connector/peak/render budget/revision-gap mechanism; 100 ms cadence, `MIN_RATE_SAMPLES = 3`,
  `MIN_RATE_ELAPSED_MS = 100` are frozen. The deterministic suite is 946 tests (915 prior + 25 Phase 12.0 + 6
  Phase 12.0R lifecycle) with 0 skipped and 0 todo.

## 0.1.6 — 2026-10-17

Supported and tested against DSH `0.2.1-rc.2` only. **No support claim is made beyond DSH `0.2.1-rc.2`**, and the
`v0.1.5` claim stays bounded to `0.2.0-rc.2` while the `v0.1.1` claim stays bounded to `0.1.7-rc.2`; the releases are
separate claims, not one range.

First release for DSH `0.2.1-rc.2`. The development target moved from `0.2.0-rc.2` to `0.2.1-rc.2` (public reference
commit `687f282e8625c6b8d11ff58211a90524be2e4317`) in Phase 11.0, and Phase 11.0R closed the runtime acceptance, so the
exact `0.2.1-rc.2` peer is now shipped. **No TPS, TTFT, estimator, curve, rendering or lifecycle algorithm changed** —
this is a runtime-target and metadata release, and the frozen metric semantics and the 100 ms presentation cadence are
unchanged. `v0.1.5` remains published for `0.2.0-rc.2` and is not restamped.

- Exact peer is now `"@deepseek-ai/dsh": "0.2.1-rc.2"`; `0.2.0-rc.2` is no longer the declared runtime peer. DSH
  evaluates the declared peer before installing or loading a plugin, so the declaration moved with the target. No
  compatibility exemption is used or required.
- No consumed interface changed in meaning. Eight of the fourteen audited DSH declaration files are byte-identical
  between the two reference commits; the six that changed add provider-configuration metadata, experimental plugin
  records and client slots, or touch subagent/install plumbing this plugin does not read. No adapter code moved and no
  metric semantics moved.
- Wire-shape contract re-pinned by `test/dsh-021-contract.test.js` against the new reference commit. The 0.2.0-rc.2
  contract evidence remains in `test/dsh-020-contract.test.js`, which is not restamped.
- Frozen invariants unchanged: 100 ms presentation cadence, `MIN_RATE_SAMPLES = 3`, `MIN_RATE_ELAPSED_MS = 100`, TTFT
  semantics, attempt-local TPS reset, durable reconciliation, peak publication rules, compressed curve geometry and
  generation-safe foreground recovery.
- The published `v0.1.5` npm package, Git tag and GitHub Release remain bound to DSH `0.2.0-rc.2` and are preserved
  unchanged.
- **Phase 11.0 runtime acceptance ended BLOCKED at R5.** On an isolated `0.2.1-rc.2` host the plugin installed with the
  exact peer, booted into the served module graph, and passed boot/dock acceptance plus R1–R4, R7 and R8 with real model
  output; R6's backgrounding behaviour was observed across two real runs. R5's eligible continuity-connector occurrence
  was **not observed** on a real turn (the natural tool turns produced no eligible same-phase adjacent attempt
  boundary), so Phase 11.0 recorded **BLOCKED — RUNTIME ACCEPTANCE** and deliberately did not push the migration. That
  record is preserved as the state at the end of Phase 11.0.
- **Phase 11.0R closed R5; compatibility with DSH `0.2.1-rc.2` is now ACCEPTED.** A genuine `0.2.1-rc.2` turn produced
  **3 attempts, 2 tool call/result cycles, 2 naturally eligible same-phase boundaries and 2 continuity connectors in the
  real DOM**, with the measured statistics unchanged (output TPS, peak, tokens, TTFT and the completed-card totals
  identical). The two `pwsh` checkpoint commands in that turn did **not** execute — the host sandbox returned the
  pre-existing `SetNamedSecurityInfoW / Win32 5` ACL error — so no checkpoint output is claimed; the genuine
  call/result cycles are what produced the boundaries. Limits: reasoning effort Off (no reasoning-phase boundary), one
  turn/session/provider route, and the runtime evidence is locally captured (`dev/phase11R/`, not pushed) while the
  independent GitHub remote-source audit passed separately. `v0.1.6` ships that accepted compatibility; the published
  `v0.1.5` npm package, tag and GitHub Release remain bound to DSH `0.2.0-rc.2`. See
  `docs/IMPLEMENTATION_LOG.md` Phase 11.0R.

Distribution is unchanged: public npm registry as the primary form, GitHub Release `.tgz` as the offline fallback, and
a runtime-only file allowlist. The standard install command resolves this version through the `latest` dist-tag;
`…@0.1.6` pins it.

## 0.1.5 — 2026-10-07

Supported and tested against DSH `0.2.0-rc.2` only. **No support claim is made beyond DSH `0.2.0-rc.2`**, and the
`v0.1.1` claim stays bounded to `0.1.7-rc.2`; the two are separate claims, not one range.

Visual continuity and lifecycle recovery release for DSH `0.2.0-rc.2`:

- Completed throughput curves now visually stitch eligible same-phase generation segments across compressed
  multi-attempt/tool boundaries.
- Continuity connectors are presentation-only and do not alter TPS, peak, token accounting, phase duration or
  attempt-local estimator resets.
- Fixes stale live-panel state after the DSH page is backgrounded.
- Live presentation timers are suspended while the document is hidden.
- Foreground return performs an authoritative session resynchronization before the first recovered render.
- Missed event revisions trigger full authoritative window rebaseline rather than applying only the latest delta.
- Controller defensively rebinds if the session event-source generation changes.
- Foreground lifecycle recovery is generation-safe: each real hidden -> visible transition recovers exactly once.
- 100 ms / 10 Hz presentation cadence remains unchanged.
- DSH compatibility remains exactly 0.2.0-rc.2.

Distribution is unchanged: public npm registry as the primary form, GitHub Release `.tgz` as the offline fallback, and
a runtime-only file allowlist. The standard install command resolves this version through the `latest` dist-tag;
`…@0.1.5` pins it.

## 0.1.4 — 2026-10-05

Supported and tested against DSH `0.2.0-rc.2` only. **No support claim is made beyond DSH `0.2.0-rc.2`**, and the
`v0.1.1` claim stays bounded to `0.1.7-rc.2`; the two are separate claims, not one range.

Presentation and precision release for the live turn meter:

- **Shared typographic baseline.** Live panel text now shares a typographic baseline across mixed font sizes;
  fixes visible vertical drift in waiting/warming/streaming/tool states.
- **Tenths stopwatch precision.** Running live stopwatches now show tenths rather than hundredths;
  display precision now matches the 10 Hz / 100 ms presentation cadence.
- **Timing calculations unchanged.** Internal millisecond timing and all TPS/TTFT calculations are unchanged.
- **Completed card unchanged.** Completed-card precision and metrics are unchanged.
- **Compatibility unchanged.** DSH compatibility remains exactly 0.2.0-rc.2.

Distribution is unchanged: public npm registry as the primary form, GitHub Release `.tgz` as the offline fallback, and
a runtime-only file allowlist. The standard install command resolves this version through the `latest` dist-tag;
`…@0.1.4` pins it.

## 0.1.3 — 2026-10-02

Supported and tested against DSH `0.2.0-rc.2` only. **No support claim is made beyond DSH `0.2.0-rc.2`**, and the
`v0.1.1` claim stays bounded to `0.1.7-rc.2`; the two are separate claims, not one range.

Correctness and recovery release for DSH `0.2.0-rc.2`. It repairs how first-token evidence, phase boundaries and
reload-time reconciliation produce live and completed numbers; it is not a redesign, and no metric definition, UI
surface or DSH adapter contract is redefined.

- **TTFT without a fabricated rate.** A name-bearing tool-call delta with empty arguments now establishes TTFT — that
  is real model output arriving at a real time — while contributing no TPS magnitude of its own. First-token time and
  the first magnitude sample are separate facts rather than one conflated one.
- **A live episode starts at its first magnitude sample.** The live TPS episode's origin is that sample, not a
  boundary-only TTFT event that may precede it, so a phase cannot open with a denominator it has no numerator for.
- **No short-denominator spikes.** Shared publication gates keep a sub-100-ms denominator out of both the live pill and
  the completed curve: a rate is published only over an interval the evidence can support.
- **Unavailable stays unavailable.** Unavailable peak semantics remain `null` in the model and `—` in the card, and are
  never replaced by a synthetic zero.
- **A phase boundary closes, it does not open.** A non-magnitude phase boundary closes the completed outgoing phase
  episode without opening an incoming magnitude episode, so the boundary itself is not counted as new evidence.
- **The cut gap is preserved.** Completed curves and phase-duration summaries keep the gap between a boundary and the
  next magnitude sample, instead of bridging it or redistributing it into the neighbouring episode.
- **Reload reconciliation.** A mid-turn browser reload followed by durable settlement replaces partial transient stream
  evidence with the complete durable stream; samples and cuts are **replaced**, never unioned or deduplicated by
  heuristic.
- **Explicit evidence authority.** Durable temporal evidence carries explicit provenance — `live`,
  `durable-incomplete`, `durable-complete` — and an incomplete durable decode can no longer claim
  `temporalShapeQuality = reconstructed`.
- **Settlement diagnostics.** Settlement outcomes are classified `reconciled`, `rejected` or `uncorrelated`, so a
  settlement that cannot be matched to held evidence is visible rather than silent.
- **Rendering.** An absent duration renders `—`; a measured zero remains `0.00 s`.
- **Compatibility is unchanged.** The exact peer remains `@deepseek-ai/dsh = 0.2.0-rc.2`; no other DSH version is
  claimed or exercised by this release.

Real-runtime acceptance (Phase 9.4.6) against an installed `@deepseek-ai/dsh 0.2.0-rc.2`:

```text
mid-turn browser reload:
691 durable samples
663 magnitude deltas observed by the browser
completed result adopted the full durable attempt
```

Distribution is unchanged from `0.1.2`: public npm registry as the primary form, GitHub Release `.tgz` as the offline
fallback, and a runtime-only file allowlist. The standard install command resolves this version through the `latest`
dist-tag; `…@0.1.3` pins it.

## 0.1.2 — 2026-09-29

Supported and tested against DSH `0.2.0-rc.2` only (public reference commit
`639ed015397290b3745d163aafe02ffee4aa3f84`). **No support claim is made beyond DSH `0.2.0-rc.2`.** The `v0.1.1` release
remains bounded to `0.1.7-rc.2`; the two are separate claims, not one range.

Presentation and estimator release. The live rate, the completed rate and the completed curve are now one estimator
family, and the completed card became a collapsible surface drawn from the host's own tokens.

- Live throughput is a **MiMo-style phase-cumulative average** rather than a trailing one-second window: the active
  phase episode's generated token mass over the wall time since that episode began. The last window-based rate path is
  gone; `docs/METRICS_SPEC.md` §6 records the superseded contract rather than erasing it.
- **Phase-local reset.** A `reasoning → output` transition (and any later one) resets the episode clock, the numerator
  and the sample count, so the first output rate is output-local and never contains reasoning-phase elapsed time. A new
  model attempt after a tool call or a retry resets all of it; two independent calls are never mixed.
- **Stall-aware cumulative decay.** A stall is now a value rather than a boundary: the numerator stops moving while the
  denominator advances, so the rate decays hyperbolically and never freezes or drops to zero by rule.
- **Settlement-time recomputation of the completed rate.** Completed rates are recomputed at settlement from the
  provider-calibrated allocation, which may raise the evidence quality above what the live pill could observe. A live
  screen value and its settled counterpart are therefore not required to be numerically equal; the estimator definition
  is what must agree.
- **Phase-cumulative completed curve.** The curve uses the same estimator family as the live pill, sampled on a 100 ms
  grid, with each attempt and each phase episode on its own clock (`docs/METRICS_SPEC.md` §8).
- **200-point published-series cap.** A longer series is reduced to exactly 200 points evenly spaced in time, each
  target taking the nearest raw sample with no interpolation; `peakTps` is the maximum of that published series, read
  before any render allowance is applied.
- The live presentation **cadence is 100 ms** (10 updates/s).
- Completed cards default to a **compact collapsed row**; the expanded summary and the throughput curve remain
  available on demand.
- The completed-card surface is drawn from **DSH host tokens** (the TodoPanel visual contract), so it follows the host
  light and dark themes.
- **Background-settlement regression coverage.** A settlement ingested while the browser tab is backgrounded must
  advance the completed card on the next projection. Both arrival shapes are covered: a settlement closing an open live
  record, and one whose opening row is outside the live tail and is therefore reconstructed from durable evidence.
- Compatibility baseline moved to DSH `0.2.0-rc.2`: the exact peer is now `@deepseek-ai/dsh = 0.2.0-rc.2`. Every DSH
  declaration this plugin reads was re-audited against the new runtime and is byte-identical to its `0.1.7-rc.2` form,
  so no adapter, metric or presentation behaviour changed with the runtime itself. **No compatibility exemption is
  required or used.**

Distribution is unchanged from `0.1.1`: public npm registry as the primary form, GitHub Release `.tgz` as the offline
fallback, and a runtime-only file allowlist. The standard install command resolves this version through the `latest`
dist-tag; `…@0.1.2` pins it.

## 0.1.1 — npm distribution

Supported and tested against DSH `0.1.7-rc.2` only.

Distribution change only. No metric semantics, UI, curve arithmetic, tool accounting, DSH adapter contract, retention
behaviour or client cadence is altered; the runtime implementation is the `0.1.0` implementation.

- First npm registry publication. `private: true` is removed and the published artifact is public.
- Standard DSH registry installation is supported: `dsh plugin --profile web add dsh-turn-performance-meter`, or
  `…@0.1.1` to pin the version.
- Exact peer compatibility declared: `@deepseek-ai/dsh = 0.1.7-rc.2`. A different DSH runtime is rejected at plugin
  preflight rather than silently admitted.
- The npm artifact is reduced to runtime-only files. `src/`, `test/`, `fixtures/`, `dev/`, `scripts/` and `docs/` are no
  longer part of the published package.
- `publishConfig` locks publication to `https://registry.npmjs.org/`.
- Repository, homepage, bugs and keywords metadata added for the registry listing.

## 0.1.0 — Initial release

Supported and tested against DSH `0.1.7-rc.2`
(public reference commit `477b4f420553e8a52c2fbccc464d7561b239c443`).

- Live turn TPS: the active attempt's trailing one-second window, always marked `≈`, reset at every attempt boundary,
  never shown while no model decode is running.
- Completed turn metrics: turn-level Reasoning TPS, Output TPS, Generated Tokens and TTFT as ratios of sums over the
  whole turn, with three independent quality axes and `—` for genuinely unavailable evidence.
- Calibrated throughput curve: one attempt-local total trace, phase as colour, tools and inter-attempt waits at zero
  compressed width, 512-point render budget with the global peak preserved.
- Completed card interaction: hover and keyboard focus replace the two TPS columns with the curve; the card itself is
  static, with no ticker.
- Terminal-tail reconstruction: a `turn/end` with no open record rebuilds the turn from the durable evidence the
  published window still holds, along the ordinary `reconstructFromDurable → aggregateTurn → curveSource` route, instead
  of closing an empty record. A start boundary the window never contained is reported unavailable rather than invented.
- Strict tool-result identity on the `0.1.7` contract: `message.toolCallId` and `message.isError`, failing closed when a
  `role: 'tool'` row is malformed — no fallback to content position, name, step, recency or arrival order.
- Generation-wide durable identity: `admitDurable` runs before retention and normalization, so a duplicate `seq` cannot
  re-enter retention, refresh an eviction position, change an eviction victim or increment the retained-row counter.
- Bounded retained evidence: `MAX_RETAINED_TURNS = 32`, evicted least-recently-updated, holding evidence bytes only.
- Release hygiene: `npm run verify` now also fails when the injector-validated `lib/client.js` mirror differs from
  `client.js`.
