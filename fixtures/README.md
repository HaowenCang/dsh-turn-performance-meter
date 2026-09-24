# DSH turn fixtures

Recorded evidence for the DSH adapter tests. Every file under `dsh-turns/` is one
real turn captured from the local DSH `0.1.5-rc.2` host by
`dev/fixture-recorder`; every file under `derived/` is a deterministic mutation
of one of those and declares its provenance.

Nothing here is hand-written. A fixture is never edited to make a test pass — if
a test needs a shape the recordings do not contain, the shape is produced by
`dev/mutate-fixtures.mjs` (a reproducible transformation) or by a local patch
inside the test, and the recording stays untouched.

## Recorded scenarios

| Fixture | Route | Attempts | Tools | What it proves |
|---|---|---|---|---|
| `t1-reasoning-tool-reasoning` | `command-goat` / `deepseek/deepseek-v4.1-flash` | 2 | `pwsh` ×2 | A multi-attempt turn, tool-call arguments counted as model output, two sequential tools, a provider that reports `outputTokens` without `reasoningTokens` |
| `t2-pwsh-write-edit` | `command-goat` / `deepseek/deepseek-v4.1-flash` | 4 | `write`, `edit`, `pwsh` | Reasoning and a tool call inside one attempt, a substantial generated file body and patch counted as output, tool results excluded |
| `t3-interrupted-mid-reasoning` | `command-goat` / `deepseek/deepseek-v4.1-flash` | 1 | — | A real user interruption 9 s into reasoning: `interrupted:true`, `turn/end.reason = aborted(user)`, no usage |
| `t4-reasoning-tool-deepseek-official` | `deepseek-official` / `deepseek-v4-pro` | 2 | `pwsh` | The route that **does** report `reasoningTokens`, so the exact phase split is exercised |
| `t5-reasoning-text-deepseek-official` | `deepseek-official` / `deepseek-v4-pro` | 1 | — | A 1307-delta stream (1038 reasoning fragments then 269 text fragments) with authoritative `reasoningTokens`, so the curve has real intra-stream spacing |

## Synthetic derivatives

`dev/mutate-fixtures.mjs --write` regenerates these. Each carries a
`syntheticMutation` block naming its source fixture, the exact change, and every
touched field.

| Fixture | Source | Change |
|---|---|---|
| `d1-no-reasoning-tokens` | `t5` | Removes `reasoningTokens` from every usage carrier. This is the *common* real condition (t1 and t2 show it natively); deriving it from t5 isolates the effect of the missing counter on an otherwise identical, fully-split stream. |
| `d2-partial-usage` | `t4` | Removes the settlement usage object from the last attempt. Shows that the in-stream `usage` chunk still supplies the authoritative counter. |
| `d3-attempt-without-message` | `t4` | Converts the last `assistant/message` into `assistant/attempt` — DSH's own durable record for a settled attempt that committed no surface message (retry, cancellation, stream error). The embedded stream is unchanged. |
| `d4-unmatched-tool-result` | `t2` | Removes the last `tool/result`, leaving one `tool/call` unmatched, as an interruption during tool execution does. |

## File shape

```jsonc
{
  "fixture": "t1-reasoning-tool-reasoning",
  "capturedAt": "2026-04-25",
  "dshVersion": "0.1.5-rc.2",
  "sessionId": "fixture-muf44tre-1",
  "scenario": "…",
  "covers": ["…"],
  "provenance": { "recorder": "…", "durablePlane": "…", "transientPlane": "…" },
  "summary": { "durableEventCount": 26, "transientFrameCount": 85, "settlements": [ … ] },
  "durable":    [{ "wallClockMs": …, "event": { "type": "turn/start", "seq": 4, "time": …, "data": { … } } }],
  "transient":  [{ "wallClockMs": …, "frame": { "type": "chunk", "attemptId": "…", "revision": 5, "index": 4, "time": …, "chunk": { … } } }],
  "meta":       [{ "kind": "scenario/start", "detail": { "task": "…", "cwd": "…" } }]
}
```

`durable` holds verbatim `SessionEvent` envelopes and `transient` holds verbatim
`AssistantStreamFrame` values; both are copied by
`dev/harvest-fixtures.mjs` without transformation.

## Offline use

The tests read these files directly — no DSH process, no network, no injection:

```bash
node --test test/dsh-fixtures.test.js test/dsh-equivalence.test.js
```

`dev/inspect-recording.mjs <sessionId>` prints the chronology of a raw recording
when a fixture needs auditing against what the host actually emitted.
