# Changelog

User-facing release history for `dsh-turn-performance-meter`. The per-phase implementation record — root causes,
counterexamples, fixture provenance and gate evidence — is in `docs/IMPLEMENTATION_LOG.md`; this file is the summary a
user of the plugin reads.

Distribution status: the package is `private: true` and is installed as a local DSH file plugin. Nothing here has been
published to npm, tagged, or attached to a GitHub Release.

## 0.1.0 — local release candidate (initial release)

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
