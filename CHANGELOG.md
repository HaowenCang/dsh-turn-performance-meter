# Changelog

User-facing release history for `dsh-turn-performance-meter`. The per-phase implementation record — root causes,
counterexamples, fixture provenance and gate evidence — is in `docs/IMPLEMENTATION_LOG.md`; this file is the summary a
user of the plugin reads.

Distribution status: published to the public npm registry as `dsh-turn-performance-meter`, with the GitHub Release
`.tgz` retained as an offline, immutable fallback.

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
