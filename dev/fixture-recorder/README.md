# Fixture recorder (dev-only)

`@dsh-external/dsh-turn-meter-fixture-recorder` is the tool that produced
`fixtures/dsh-turns/`. It is not part of the plugin bundle and is never loaded by
a released profile.

## Why it exists

The turn meter consumes two independent evidence planes:

| plane | DSH source | persisted by DSH |
|---|---|---|
| durable | `session/event` | yes — the session log |
| transient | `agent/assistant-stream` | **no** |

The transient plane lives only in the running host process. Once a turn is over,
`assistant/live-chunk` rows cannot be recovered from anywhere — the durable
`assistant/message.stream` is a *different* representation of the same evidence,
and an equivalence test that derived both sides from it would prove nothing. The
recorder is therefore the only way to obtain real transient frames, and it must
run inside the host process while a turn is executing.

## What it records

Raw JSONL, one file per session, three row kinds, no interpretation:

```jsonc
{"plane":"durable",   "sessionId":"…", "wallClockMs":…, "sessionEvent":{…}}
{"plane":"transient", "sessionId":"…", "wallClockMs":…, "frame":{…}}
{"plane":"meta",      "sessionId":"…", "wallClockMs":…, "kind":"scenario/start", "detail":{…}}
```

Nothing is normalized, reordered, filtered or dropped. `dev/harvest-fixtures.mjs`
does the selecting, and it preserves both planes verbatim.

## Control route

Registered on the running web host's `webServer` service while the recorder is
injected:

```text
GET  /turn-meter-fixture/status
GET  /turn-meter-fixture/models
GET  /turn-meter-fixture/dump?sessionId=<id>
POST /turn-meter-fixture/scenario  {task, cwd?, agentPreset?, provider?, model?, interruptAfterMs?}
POST /turn-meter-fixture/cancel    {sessionId}
POST /turn-meter-fixture/dispose   {sessionId}
```

Scenario driving goes through `ctx.sessionController` — `create` then `prompt` —
because that is the same Host seam the GUI uses. `ctx.agents.create` alone yields
a bare agent whose steps close immediately: the composed agent preset is what
supplies the tools, the system prompt and the model.

`interruptAfterMs` arms a real user cancellation (`sessionController.cancel`,
which reaches `TurnEndReason {kind:'aborted', reason:{kind:'user'}}`), so the
interrupted fixture is a genuine interruption rather than a simulated one.

## Reproducing the fixtures

1. Inject the package into a running DSH host (`dsh-super-injector`:
   `dev_inject_plugin <this directory>`). It has no `dsh.client` declaration, so
   no browser bundle is built.
2. Launch a scenario:

   ```powershell
   powershell -File dev/capture-scenario.ps1 -Name A1 -Recipe dev/recordings/A1.json
   ```

   Known scenarios: `A1` (two pwsh calls, two attempts), `B1` (write + edit +
   pwsh, four attempts), `C1` (interrupted mid-reasoning), `D1`/`D2`
   (`deepseek-official`, which reports `reasoningTokens`).
3. Wait for the scenario to settle, then harvest:

   ```bash
   node dev/harvest-fixtures.mjs
   node dev/mutate-fixtures.mjs --write
   ```

4. Uninject the recorder (`dev_uninject_plugin dsh-turn-meter-fixture-recorder`).

Raw recordings land under `$DSH_HOME/turn-meter-fixtures/raw`. The recorder
deliberately does not write inside the repository: an injected package must not
depend on the host process's working directory.
