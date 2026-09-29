# Changelog

User-facing release history for `dsh-turn-performance-meter`. The per-phase implementation record — root causes,
counterexamples, fixture provenance and gate evidence — is in `docs/IMPLEMENTATION_LOG.md`; this file is the summary a
user of the plugin reads.

Distribution status: published to the public npm registry as `dsh-turn-performance-meter`, with the GitHub Release
`.tgz` retained as an offline, immutable fallback.

## Unreleased

Supported and tested against DSH `0.2.0-rc.2` only (public reference commit
`639ed015397290b3745d163aafe02ffee4aa3f84`). The `v0.1.1` release remains bounded to `0.1.7-rc.2`; the two are separate
claims, not one range.

- Live throughput is now a **phase-cumulative average** rather than a trailing one-second window, and the completed
  curve uses the same estimator family on a 100 ms source grid with a 200-point cap (`docs/METRICS_SPEC.md` §6–§8).
- The live presentation cadence is 100 ms.
- Completed cards now default to a compact collapsed row; expanded detail remains available on demand.
- Completed-card surface follows DSH TodoPanel host tokens.
- Compatibility baseline moved to DSH `0.2.0-rc.2`: the exact peer is now `@deepseek-ai/dsh = 0.2.0-rc.2`. Every DSH
  declaration this plugin reads was re-audited against the new runtime and is byte-identical to its `0.1.7-rc.2` form,
  so no adapter, metric or presentation behaviour changed with the runtime. **No compatibility exemption is required or
  used.**

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
