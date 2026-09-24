# dev/ — fixture capture tooling

Dev-only. Nothing here is part of the plugin bundle, and `npm run verify` does not
run any of it.

| Path | Purpose |
|---|---|
| `fixture-recorder/` | The injected host recorder. It is the only way to obtain real transient `agent/assistant-stream` frames, because DSH never persists them. See its own README. |
| `capture-scenario.ps1` | Launches one recorded scenario on a running host through the recorder's control route, optionally arming a real interruption. |
| `harvest-fixtures.mjs` | Selects a raw recording and writes `fixtures/dsh-turns/<name>.json`, copying both evidence planes verbatim. |
| `mutate-fixtures.mjs` | Writes `fixtures/derived/<name>.json`: deterministic, declared mutations of a real fixture. Requires `--write`. |
| `measure-generation-tail.mjs` | Measures `settlement time − last model-producing delta` per attempt. This is the evidence behind the phase-duration decision in `docs/METRICS_SPEC.md` §7. |
| `inspect-recording.mjs` | Prints the durable chronology, transient frame chronology and per-attempt summary of one raw recording. |
| `recordings/` | The launch receipts (`A1`, `B1`, `C1`, `D1`, `D2`) and the model catalog captured at the time, so a fixture's route and scenario are reproducible. |
| `scratch/` | Working directory the `B1` scenario was told to write into. |

The capture sequence, and what each scenario covers, is documented in
`fixtures/README.md`.
