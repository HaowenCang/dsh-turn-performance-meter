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

## What it cannot record: the `settle-assistant` window change

The recorder observes two host seams — `ctx.on('session/event')` and
`ctx.on('agent/assistant-stream')` — and the `settle-assistant` **change** is
neither. It is produced by the browser-side client fold (`ClientAssistantStream`)
when it supersedes an attempt's transient rows with a durable settlement, and it is
delivered to the browser's window subscriber; the host process never sees it as a
row. A recording therefore cannot contain a bare `settle-assistant`, however
faithfully both planes are captured, and the retirement-versus-abandonment
distinction cannot be evidenced from a fixture.

Reproducing it inside this recorder would mean re-running the fold over the
recorded planes, which would make the emitted row a *derived* artifact rather than
observed evidence — a worse trade than recording the gap. The distinction is
instead established by the fold's own algebra (`docs/DSH_API_NOTES.md` §13.4) and
by synthetic contract tests in `test/dsh-017-settlement.test.js` against a port of
it. Two further properties of this instrument follow from the same seam list and
are worth stating for the same reason: it sees no `SessionEventWindow` snapshot, so
a replay's window boundaries are reconstructed by the consumer rather than
recorded; and it records both planes with `Date.now()` taken at the observation
point, so an entry's position in a replayed window is derived from that clock
rather than from a recorded `revision`.

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
