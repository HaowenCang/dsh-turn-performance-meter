# DSH API Notes

## 1. Purpose and compatibility rule

These notes were verified against the public `deepseek-ai/deepseek-harness` repository on 2026-09-23, with search results pointing at commit `00102833dfaee1da9f48a3a8eae9d34005a75218` on `master`. They are evidence for the design, **not** a promise that the locally installed DSH has identical APIs.

Before implementing the bridge, DeepSeek must inspect the local DSH version and live slot/runtime contracts. Local installed behavior wins. Record any divergence in `IMPLEMENTATION_LOG.md`.

Repository: `https://github.com/deepseek-ai/deepseek-harness`

## 2. UI plugin pattern

Verified source:

`packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md`

Current guidance:

- client-enabled bundle declares `dsh.client` and exports `./client`;
- browser artifact registers through `window.__ModuleLoader__.load`;
- React comes from the DSH browser module table; do not install/load a duplicate React runtime;
- use `ctx.slots.inject` and `ctx.slots.register`;
- prefer allocated slots such as `conversation.composer.dock`;
- effects/listeners/timers must be disposed through lifecycle/effect scope;
- do not replace app root or append a second app to `document.body`;
- do not read another plugin's DOM or stylesheet to infer placement.

Template files verified at:

```text
packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/
  package.json
  index.js
  client.js
  cordis.patch.yml
```

The root scaffold in this project follows that package shape.

## 3. Composer slot

Verified source:

```text
packages/client/ui-conversation/src/client/apply.ts
packages/client/ui-conversation/src/client/contract/slots.ts
packages/client/ui-chat/src/client/apply.ts
packages/client/ui-chat/src/client/chat/StatsPills.tsx
```

Two session-scoped list seats exist and they are not interchangeable:

| seat | DSH wording | occupants |
|---|---|---|
| `conversation.input.dock` | "Full-width entries above the composer card" — `kind: 'list'`, `scope: 'session'`, owner `InputZone` (`ownerProps: { session, input }`) | `todo` (order 0), `goal` (10), `queue` (20) |
| `conversation.composer.dock` | "Ambient entries below the composer card" | `client-ui-chat` `StatsPills`, id `stats` |

The input seat's standard props include `sessionId: SessionId`, so a session-scoped occupant reads the session from
its props and must never scrape it from the DOM. The owner renders the seat as
`renderSlot("conversation.input.dock", zone)` immediately **before** `inputBar`, which is what makes it "above the
composer card". Sole occupant listing source: the generated contract table in
`dsh-cordis-client-runner/lib/client.js`, key `conversation.input.dock`
(`packages/client/ui-conversation/src/client/contract/slots.ts:166`).

Do not assume that taking the native `stats` id is safe. Register independently first and inspect the local slot
catalog/occupants. Phase 3 registered in the composer dock and Phase 5B moved the plugin to the input dock, because
the composer dock is *below* the composer and already holds the statistics the meter was competing with.

## 4. Durable vs transient evidence

Verified docs:

```text
docs/architecture.md
docs/agent-lifecycle.md
docs/cookbook/extension-cookbook.md
```

DSH's architecture rule is:

- durable replayable facts → `session/event`;
- live/interception/transient signals → `agent/*` and tool runtime events.

Turn and step boundaries are durable session facts. The cookbook explicitly describes a UI plugin as combining durable `session/event` records with transient `agent/assistant-stream` frames for live token presentation.

## 5. Assistant stream frame

Verified source:

`packages/core/agent/src/runtime-types.ts`

Current shape:

```ts
type AssistantStreamFrame =
  | {
      type: 'start'
      attemptId: LlmAttemptId
      revision: number
      turn: number
      step: number
    }
  | {
      type: 'chunk'
      attemptId: LlmAttemptId
      revision: number
      index: number
      time: number
      chunk: StreamChunk
    }
  | {
      type: 'end'
      attemptId: LlmAttemptId
      revision: number
      index: number
      outcome: committed | abandoned
    }
```

The timestamp on chunk frames is exactly what the live meter/curve needs. The start frame provides turn/step/attempt identity.

## 6. Browser transport already knows live chunks

Verified source:

```text
packages/api/session-controller/src/types.ts
packages/api/session-controller/src/client/sessions/assistant-stream.ts
```

`SessionFollowRequest` can request `assistantStream: true`. The browser wire carries assistant stream start/chunk/end frames. The client fold materializes transient `assistant/live-chunk` events carrying `time`, `turn`, `step`, and `chunk`.

This means the final plugin may be able to compute live telemetry from verified client conversation/session data without inventing a separate Host-to-browser socket. DeepSeek must inspect the actual standard props/client services in the installed version and choose the smallest supported seam.

## 7. StreamChunk output classes

Verified source:

`packages/llm/llm/src/types.ts`

Current generated delta forms:

```ts
{ type: 'text-delta', text }
{ type: 'reasoning-delta', text }
{ type: 'tool-call-delta', id, name?, argumentsDelta }
```

Other forms include block-start/end, usage, and finish.

This directly supports the project's accounting rule: tool-call arguments are model-generated output and should be included in output throughput; tool results are separate durable/tool events and are excluded.

## 8. TokenUsage semantics

Verified docs/source:

```text
docs/subsystems/llm-streaming.md
packages/llm/llm/src/types.ts
packages/llm/token-meter/src/turn-usage.ts
```

Current contract:

```ts
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

`reasoningTokens`, when present, is already included in `outputTokens`. Never add it twice.

## 9. Existing timing/statistics references

Verified source:

```text
packages/session/session-stats/README.md
packages/client/ui-chat/src/client/chat/StatsPills.tsx
packages/client/ui-conversation/src/client/contract/records.ts
```

`sessionStats` is a whole-session projection with fields such as `llmMs`, `toolMs`, `ttftMs/ttftSteps`, and `decodeMs/decodeTokens`. It is useful as an implementation reference but is **not** the target data source for this turn card.

`AssistantMessageNode` currently contains `turn`, `step`, blocks, optional usage, and timing with `stepStartTime`, `firstTokenTime`, `completedTime`. Tool-result records contain `callId`, paired call time when available, result time, and call metadata.

## 10. Tokenizer limitation

Verified source/docs:

`packages/llm/token-meter/README.md` and related design notes.

DSH's token meter uses an approximate character-based heuristic when provider-exact reusable usage is unavailable; exact model tokenizer support is explicitly not guaranteed. A GPT/tiktoken tokenizer would also be wrong for arbitrary DeepSeek/provider routes.

Therefore this project must distinguish exact aggregate usage from estimated/calibrated local curve points. Do not report every 1-second live value as exact simply because final `outputTokens` is exact.

## 11. Local plugin installation

Verified current docs include local bundle installation such as:

```text
dsh plugin --profile <name> add file:/absolute/path/to/my-plugin-bundle
```

The Web Plugins page also accepts an absolute local plugin directory. Current plugin-manager docs say newly installed bundles are enabled by default, but local CLI/runtime behavior should still be verified before mutation.

For this project on Windows the intended path is:

```text
file:E:/Projects/DSHarness/dsh-turn-performance-meter
```

#### Phase-3 additions (audited against the installed 0.1.5-rc.2)

| Item | Verified local fact | Source |
|---|---|---|
| `SessionEventMap['assistant/attempt']` | "One model attempt that committed no surface message. The embedded stream preserves a **failed, retried, cancelled, or stream-error** attempt that reached **settlement** without fabricating model-visible history." A durable settlement — not an abandonment. | `dsh-session/lib/types/types.d.ts:318-327` |
| transient abandonment | `AssistantStreamFrame.end.outcome` = `{kind:'committed', eventType, seq}` **or** `{kind:'abandoned'}` ("live abandonment without one [durable settlement]") — the only source of `abandoned` | `dsh-agent/lib/types/runtime-types.d.ts:123-137` |
| who appends `assistant/attempt` | the loop settles it on (a) abort with no delivered content, (b) stream error caught mid-iteration, (c) `finish.kind` `error`/`aborted` before the `agent/request-error` waterfall (which then schedules `llm/retry`) | `dsh-agent-loop/lib/index.js:1045-1098` |
| `llm/retry` | durable, non-surface, appended **after** the failed attempt settled, naming the same turn/step; invariant-checked (`dsh-llm-retry/lib/invariant.js`); "records scheduling, not completion" | `dsh-llm-retry/README.md`, `lib/invariant.js` |
| client window changes | `SessionEventChange` = `replace` / `prepend` / `append` (each with `entries`) / `settle-assistant` (`attemptId` + optional settlement entry; bare = abandonment). `replace` rebaselines; `prepend` is older history. | `dsh-api-session-controller/lib/types/client/contract/events.d.ts:41-61` |
| `SessionEventSource` surface | `getSnapshot(): SessionEventWindow` + `subscribe(listener) => unsubscribe` (useSyncExternalStore shape); synchronous publication per mutation | same file, `MutableSessionEventSource` |
| slot register form | `ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({name, id, order, label?}, Component))` — second argument is a React component (shipped `StatsPills` call site) | `dsh-client-ui-chat/lib/client.js:8351-8356` |
| `ctx.effect` semantics | `ctx.effect(fn)` runs `fn` **immediately** as setup and calls the **returned** function at fiber teardown (shipped call sites: `ctx.effect(() => ctx.webServer.register(...))`). Registering a disposal body directly disposes at startup. | observed live + `dsh-super-injector` shipped patterns |
| locale | `ctx.locale.register(ns, {en, zh}) => disposer`; `ctx.locale.bind(ns) => t` (identity-stable, resolves against the active language at call time) | `dsh-client-locale/lib/types/client/index.d.ts:198-215` |
| dark-theme selector | shipped theme CSS keys dark overrides on `body[data-ds-dark-theme]` — usable for a plugin-scoped light/dark variable pair | shipped `dsh-client-ui-theme` CSS (`--shiki-*` rules) |
| host accent token | `--dsw-alias-brand-primary` exists in the token directory; the warm-orange reference accent has no host equivalent, so the plugin defines its own scoped accent with a `body[data-ds-dark-theme]` override | `dsh-client-ui-theme` token list |
| React isolation | the browser seed table provides `react`/`react-dom`; `window.React`/`window.ReactDOM` are undefined after plugin load, and no duplicate-React error appears in the console | verified in the running page |
| local install path | `dsh plugin --profile web <args...>` is a thin **pnpm forwarder** run in the profile directory; it then reconciles `dsh.profile.bundles` against installed dependencies that declare `dsh.bundle` | `@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js` |
| `dsh-super-injector` layout expectations | validates `lib/client.js` (exists, contains `__ModuleLoader__`, declares `inject` with `slots`, registers a `KNOWN_SLOTS` name incl. `conversation.composer.dock`) before runtime injection; freshness check only walks `src/**.ts` | injector `buildFreshnessProblems` / `clientSkeletonProblems` |
| boot graph pickup | an installed/injected entry appears in `window.__DSH_BOOT__.entries` only after the running server composes it — a profile change requires either server restart or the injector's runtime registration; both were exercised | observed live |

## 12. Phase-0 inspection checklist

Before writing DSH-specific integration code:

```powershell
dsh --version
dsh plugin --profile web list --depth 2
dsh --profile web --dump-config
```

Then inspect, by whichever local development/Creator tools are available:

- exact `conversation.composer.dock` owner/standard props and occupants;
- current client access to transient `assistant/live-chunk` or assistant stream frames;
- current durable conversation/session event exposure in browser;
- `turn/start`, `turn/end`, tool call/result and assistant attempt/retry payload shapes;
- whether a plugin-owned projection/resource can update at transient cadence;
- locale service and theme primitives;
- whether native stats can/should remain visible beside this plugin.

Write findings and source locations into `IMPLEMENTATION_LOG.md` before Phase 1 integration.

## 13. DSH 0.1.7-rc.2 compatibility baseline

| Item | Value |
|---|---|
| Local installed version | `0.1.7-rc.2` |
| Public reference commit | `477b4f420553e8a52c2fbccc464d7561b239c443` |
| Verified local package path | `C:\Users\20659\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` (recorded form: `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`; the shipped packages it composes resolve under `...\dsh\node_modules\@deepseek-ai\*`, which is the root the declaration paths below are relative to) |
| Verified date | 2026-09-27 |

This section supersedes the 0.1.5-era reading of the contracts it names. It is deliberately **not** a statement that
0.1.7 is "the same as 0.1.5": the declarations below differ from the 0.1.5 assumption in the places the project reads,
and the differences are the whole content of the section. The earlier sections above were verified against public
`master` and against the locally installed `0.1.5-rc.2`, and they remain as written for the surfaces they cover.

### 13.1 Field-by-field comparison

| Contract | Local declaration | 0.1.5 assumption | 0.1.7 reality |
|---|---|---|---|
| `ToolResultMessage` | `dsh-llm/lib/types/message.d.ts:152-160` | the result is a `user`-role message whose identity sits inside the content: `content[0].toolCallId`, `content[0].isError` | `interface ToolResultMessage extends MessageBase { readonly role: 'tool'; readonly source: ToolMessageSource; readonly toolCallId: ToolCallId; readonly isError?: boolean }` — a first-class tool-role message owning both fields directly |
| `SessionEventMap['tool/result']` | `dsh-session/lib/types/types.d.ts:374-388` | the payload's message was the nested 0.1.5 form above | `{ turn, step, message: ToolResultMessage, error?: { name, code, reason? }, meta? }`; the declared comment restricts `error` to a message carrying `isError: true` |
| `TurnEndReasonMap` | `dsh-session/lib/types/types.d.ts:165-208` | fewer terminal reasons, with no fork marker among them | exactly seven variants: `completed`, `aborted { reason: TurnEndCancelCause }`, `blocked`, `error { error: LlmFailure }`, `max-tokens`, `interrupted`, `forked` |
| `turn/start` / `turn/end` | `dsh-session/lib/types/types.d.ts:262-286` | present | unchanged: `turn/start { turn }` and `turn/end { turn, reason }` still exist, confirmed against the local runtime log row `{"type":"turn/end","seq":60,"time":…,"data":{"turn":1,"reason":{"kind":"completed"}}}` |
| Session log format | local session store | an earlier log generation | **v4** — `session.v4.jsonl.zstd`, written as concatenated zstd frames |
| `AssistantLiveChunkEvent` | `dsh-api-session-controller/lib/types/client/contract/events.d.ts:6-16` | the live-chunk row was not modelled as a first-class client event | `{ type: 'assistant/live-chunk', seq, time, data: { attemptId, turn, step, chunk } }` |
| `SessionEventChange` | `…/events.d.ts:41-54` | three window deltas, with a settlement whose absent entry was taken to mean abandonment | four change kinds: `replace`, `prepend` and `append` (each carrying `entries`), plus `{ kind: 'settle-assistant', attemptId, entry?: SessionAssistantSettlementEntry }` |
| `SessionEventWindow` / source | `…/events.d.ts:56-63` | the window snapshot and its change payload were read as one thing | `{ entries, hasMore, revision, change }`, exposed as `SessionEventSource = ObservableSnapshot<SessionEventWindow>` |
| `SessionAssistantStreamFrame` | `dsh-api-session-controller/lib/types/types.d.ts:482-509` | the frame shape recorded from public master in §5 above | `start { attemptId, revision, startedAfterSeq, turn, step }`, `chunk { attemptId, revision, index, time, chunk }` and `end { attemptId, revision, index, outcome }`, where `outcome` is `{ kind: 'committed', eventType: 'assistant/message' or 'assistant/attempt', seq }` or `{ kind: 'abandoned' }` |
| `ClientAssistantStreamResult` | `dsh-api-session-controller/lib/types/client/sessions/assistant-stream.d.ts:6-23` | the client fold's decisions were not enumerated | `publish { entry, retireAttemptId? }`, `settlement { attemptId, entry }`, `abandonment { attemptId }`, `transient { entry }`, `rebaseline`, or `undefined` |

### 13.2 `TurnEndReasonMap` and the fork boundary

`forked` is new in 0.1.7. Its declaration (`dsh-session/lib/types/types.d.ts:199-207`) states that fork-seed
construction closed a turn that was still open at the fork boundary in the source session, that only fork seeds carry
the marker, and that the loop never emits it live. The source events before the boundary remain intact in the child.
A turn carrying it genuinely did not finish, so it is an interruption and never a completion.

`TurnEndCancelCause = AgentCancelCause | { kind: 'legacy' }` (`…/types.d.ts:159`), and
`AgentCancelCause = { kind: 'user' } | { kind: 'parent' } | { kind: 'hook', reason } | { kind: 'disposed' }`
(`…/types.d.ts:148`). The `legacy` arm covers an import whose coarse record carried no cause.

### 13.3 The tool-role result message

`dsh-llm/lib/types/message.d.ts:152-160` declares `ToolResultMessage` as a first-class tool-role message carrying the
result of one tool invocation, with `toolCallId` and optional `isError` on the message itself. The call identity is
therefore `data.message.toolCallId` and the failure flag is `data.message.isError`. In a 0.1.7 recording the content
blocks are result **content** and carry no call identity at all, so `content[0].toolCallId` is not a fallback and not a
repair path. `dsh-session/lib/types/types.d.ts:374-388` places that message in the durable event as
`'tool/result': { turn, step, message: ToolResultMessage, error?, meta? }`, and the structured `error` is declared
"outside model content" and allowed only when the message has `isError: true`.

The legacy 0.1.5 nested shape is still decoded, because the recorded 0.1.5 captures are replayed as evidence by the
metric-math regressions. The two shapes are separated by a **structural** discriminator — `message.role` — so the
legacy read is unreachable for a message that declares `role: 'tool'`, and every normalization states which shape it
used. A tool result whose identity cannot be read is malformed and fails closed rather than being repaired by position.

### 13.4 The bare `settleAssistant(attemptId)` is ambiguous

`SessionEventChange`'s `settle-assistant` arm makes `entry` optional, and the absence of an entry is **not** by itself
an abandonment. In the installed 0.1.7, one bare call is issued for two different situations.

Normal successful retirement. On an `end` frame whose outcome is `committed` to `assistant/message` and whose
`interrupted` flag is not true, `ClientAssistantStream.acceptFrame` deletes the staged settlement from `pending`, sets
`retainedAttempt`, and returns `publish(entry)`
(`dsh-api-session-controller/lib/client.js:1489-1539`). The attempt is retired later, when that attempt's `step/end` is
published: `publish()` returns `{ type: 'publish', entry, retireAttemptId }` (`…/client.js:1524-1539`), and
`publishAssistantEntry` (`…/client.js:2105-2130`, the branch at `:2124-2127`) calls
`eventSource.settleAssistant(retireAttemptId)` with no entry.

True abandonment. On an `end` frame whose outcome is `abandoned` with `pending.size === 0`, `acceptFrame` returns
`{ type: 'abandonment', attemptId }` (`…/client.js:1494-1497`), and the same no-entry call is made
(`…/client.js:2119-2122`).

Since both situations produce the same wire form, `entry === undefined` alone proves nothing. A consumer must resolve
the bare call from whether a durable settlement for that attempt is already known; the plugin does this by holding the
attempt identities that received a durable settlement directly and a budget of outstanding settlements keyed by their
durable coordinate, and it consumes one budget entry per bare call (see `docs/ARCHITECTURE.md`, §"Phase 7D — tool-role
results, window changes and completion evidence").

### 13.5 `SessionEventWindow`, and the evidence a host-side recorder cannot see

`SessionEventChange` (`dsh-api-session-controller/lib/types/client/contract/events.d.ts:41-61`) has four arms —
`replace`, `append`, `prepend` and `settle-assistant` — and `settle-assistant` carries an **optional** `entry`. The
window is a **live tail**, so a client that attaches mid-turn normally holds no `turn/start` for the open turn while
holding that turn's settlements, tool boundaries and terminal `turn/end`. Nothing in the contract obliges the window to
begin at a turn boundary, and nothing marks where it begins.

That has a consequence for evidence collection that is worth recording here rather than in a test file. The host-side
recorder observes exactly two seams:

```text
ctx.on('session/event', (session, event) => …)             durable plane
ctx.on('agent/assistant-stream', ({agent, frame}) => …)    transient plane
```

The `settle-assistant` **change** is neither. It is produced by the browser-side client fold
(`ClientAssistantStream`, §13.4) when it supersedes an attempt's transient rows, and it is delivered to the browser's
window subscriber; the host process never sees it as a row. A recorded fixture therefore **cannot** contain a
`settle-assistant` change, however faithfully it captures the two planes, and `fixtures/dsh-0.1.7/t01-sequential-tools.json`
does not exercise the retirement lifecycle. Reproducing that change in a recording would require either running the fold
inside the host recorder — which would make the row a derived artifact rather than observed evidence — or a browser-side
recorder, which is a different kind of instrument. The retirement/abandonment distinction is consequently established by
the fold algebra above and by synthetic contract tests against a port of it, not by a capture.

### 13.6 Supported version

The only supported and tested DSH for this project is `0.1.7-rc.2`, verified against the locally installed package
recorded above. This project does **not** claim 0.1.5 support. The 0.1.5-rc.2 captures retained under
`fixtures/dsh-turns/` remain usable as evidence about the metric arithmetic, the decoder's robustness and historical
compatibility; they are no longer evidence for the tool/result shape, settle-assistant semantics, the turn completion
lifecycle or the client event-window contract, all of which are established from the 0.1.7 declarations and the
recorded 0.1.7 corpus.

**Superseded in Phase 9.3.** §13 remains the record of the 0.1.7-rc.2 baseline and of the audit that established it; it
is a statement about what was verified *on 0.1.7*, and none of it is retracted. The supported runtime is now
`0.2.0-rc.2` — see §14, which is the normative baseline from Phase 9.3 onward.

## 14. DSH 0.2.0-rc.2 compatibility baseline

| Item | Value |
|---|---|
| Local installed version | `0.2.0-rc.2` |
| Public reference commit | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| Superseded reference commit | `477b4f420553e8a52c2fbccc464d7561b239c443` (`0.1.7-rc.2`) |
| Verified local package path | `C:\Users\20659\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` (the shipped packages it composes resolve under `...\dsh\node_modules\@deepseek-ai\*`, which is the root the declaration paths below are relative to) |
| Verified date | 2026-09-29 |
| Version exemption required | no |

### 14.1 Method

Two independent checks, run because the normative runtime changed rather than because a defect was suspected.

The first is a **content-addressed comparison of the upstream declarations**. Every file in the audit list below was
resolved at both commits with `git rev-parse <sha>:<path>` in a local checkout of `deepseek-ai/deepseek-harness` and the
resulting blob hashes were compared. Comparing blob identity rather than diffing text is what makes "unchanged" a fact
about bytes: a reformatted or reordered file would produce a different hash and would be reported as a difference even
if its meaning were preserved.

The second is a **read of the installed 0.2.0-rc.2 runtime**. The published package ships compiled JavaScript plus
`.d.ts` declarations, not the `src/` tree, so the declarations the plugin is compiled against were read from the
installed `lib/types/**` of each composed package and the runtime symbols were read from the installed `lib/*.js`.

### 14.2 Upstream comparison — 14 files, 14 identical

| Upstream path | Blob at `477b4f42` / `639ed015` | Verdict |
|---|---|---|
| `packages/core/session/src/types.ts` | `593c86d5` | identical |
| `packages/llm/llm/src/types.ts` | `54453607` | identical |
| `packages/llm/llm/src/assistant-stream.ts` | `7fca34c5` | identical |
| `packages/api/session-controller/src/client/contract/events.ts` | `bc825f08` | identical |
| `packages/api/session-controller/src/client/session-wire-event.ts` | `59d6ef5b` | identical |
| `packages/api/session-controller/src/client/sessions/assistant-stream.ts` | `973fd108` | identical |
| `packages/api/session-controller/src/client/sessions/session.ts` | `284abc56` | identical |
| `packages/api/session-controller/src/client/contract/session.ts` | `2c8f16c4` | identical |
| `packages/api/session-controller/src/client/contract/snapshot.ts` | `161cd858` | identical |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | `61f7d8ff` | identical |
| `packages/boot/app-boot/src/plugin-compatibility.ts` | `047fe1f9` | identical |
| `packages/boot/plugin-manager/src/install-spec.ts` | `3ef46155` | identical |
| `packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx` | `bf59a54a` | identical |
| `packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css` | `04b537da` | identical |

Every declaration this plugin reads therefore has the same bytes in the new normative runtime as in the old one. That is
the finding, and it is the reason no adapter change was made: **there is no contract to migrate.** `src/dsh/**` moved no
code in Phase 9.3, and the Phase 9.2 metric semantics were not reopened.

### 14.3 Installed-runtime confirmation

The declarations the plugin depends on, as read from the installed `0.2.0-rc.2` package tree:

| Contract | Installed declaration | What the plugin reads |
|---|---|---|
| `SessionEvent` envelope | `dsh-session/lib/types/types.d.ts:489-512` | `{ type, seq, time, data }`, with `ignorable?` and the surface intent alongside it; `seq` is monotonic within a session, `time` is Unix epoch milliseconds |
| `turn/start`, `turn/end` | `…/types.d.ts:262-276` | `turn/start { turn }`, `turn/end { turn, reason }` |
| `assistant/message` | `…/types.d.ts:330-338` | `{ turn, step, message, stream, usage?, interrupted? }` — the settlement that commits a model-visible message |
| `assistant/attempt` | `…/types.d.ts:344-348` | `{ turn, step, stream }` — a settlement that committed no surface message |
| `tool/call` | `…/types.d.ts:354-360` | `{ turn, step, callId, name, arguments }`, `arguments` the raw unparsed JSON string |
| `tool/result` | `…/types.d.ts:374-388` | `{ turn, step, message: ToolResultMessage, error?: { name, code, reason? }, meta? }`; `error` is allowed only on a message with `isError: true` |
| `AssistantStreamRecord` | `dsh-llm/lib/types/assistant-stream.d.ts:16-40` | `text-chunks` / `reasoning-chunks` / `tool-call-chunks` runs carrying `time0`, `index` and `dt[]`, plus raw `chunk` records — the two shapes the decoder reconstructs exact timestamps from |
| `StreamChunk` | `dsh-llm/lib/types/types.d.ts:417-447` | `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-start`, `block-end`, `usage`, `finish` |
| `isTokenDelta` | `dsh-llm/lib/types/assistant-stream.d.ts:72-78` | the first-token predicate TTFT is measured against, unchanged |
| `AssistantLiveChunkEvent` | `dsh-api-session-controller/lib/types/client/contract/events.d.ts:6-16` | `{ type: 'assistant/live-chunk', seq, time, data: { attemptId, turn, step, chunk } }` |
| `SessionEventChange` | `…/contract/events.d.ts:41-54` | four arms — `replace`, `prepend`, `append` (each `{ entries }`) and `{ kind: 'settle-assistant', attemptId, entry? }` |
| `SessionEventWindow` | `…/contract/events.d.ts:56-63` | `{ entries, hasMore, revision, change }` |
| `conversation.input.dock` | `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:213-218` | `{ kind: 'list', scope: 'session', owner: InputZone }` — the seat the meter occupies at `order: -10` |
| TodoPanel visual contract | `dsh-client-ui-conversation/lib/types/client/skeleton/TodoPanel.d.ts` | the dock geometry and surface tokens the completed card reproduces; the `.module.css` source file is byte-identical between the two commits, so the Phase 9 copy is still the host's own contract |

The three settling findings of §13 — the tool-role result identity, the ambiguous bare `settleAssistant(attemptId)`, and
the four window-change arms — are unchanged, because the files that declare them are unchanged. §13.3, §13.4 and §13.5
therefore remain the operative description.

### 14.4 The plugin-compatibility gate

`dsh-app-boot` evaluates the plugin's `peerDependencies` against the running runtime before a profile starts the plugin
(`evaluatePluginCompatibility`, installed at `dsh-app-boot/lib/index.js:286-313`). Only peers named `@deepseek-ai/dsh`
or `@deepseek-ai/dsh-*` participate, and the check is

```js
semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })
```

`includePrerelease: true` is the detail that matters here: a prerelease runtime does participate in ranges, so the
question is only which range is declared. Checked directly against the bundled `semver` rather than reasoned about,
with the runtime fixed at `0.2.0-rc.2`:

| Declared peer | Satisfies `0.2.0-rc.2`? |
|---|---|
| `0.2.0-rc.2` (declared) | yes |
| `0.1.7-rc.2` (previous) | **no** |
| `^0.2.0-rc.2` | yes |
| `>=0.2.0-rc.2` | yes |
| `0.2.x` | yes |
| `*` | yes |
| `0.1.7-rc.2 \|\| 0.2.0-rc.2` | yes |

The exact pin is the only row that is both satisfied by the intended runtime and unsatisfied by every runtime this
project has not exercised. The last row is rejected for a different reason: it would make a single artifact claim two
runtimes and would erase the evidence boundary between `v0.1.1` and `v0.1.2`.

`0.2.0-rc.2` also ships exact-version compatibility exemptions (`allow-version`, `revoke-version`,
`version-exemptions`, and the `exempted` field the gate returns). **No exemption is used or required by this plugin.**
An exemption accepts a declared incompatibility; this plugin declares a compatible peer, so the gate passes on its own
terms. If an exemption were needed after the peer had been updated, that would be a defect in the declaration rather
than a configuration task.

### 14.5 Differences between the two references

The audited files are identical, but the two commits are not the same commit, and two differences were found and
assessed as irrelevant:

- `session-controller` gained an optional `fork(...).onCreated` callback. The plugin never forks a session and never
  calls `fork`.
- The CLI and plugin manager gained the exact-version exemption operations named in §14.4. They are an escape hatch for
  a *declared* incompatibility; this plugin has none.

Neither difference is in the evidence path, and neither was worked around.

### 14.6 Supported version

The only supported and tested DSH for the current working tree is `0.2.0-rc.2`, verified against the locally installed
package recorded in §14. The `v0.1.1` release remains bounded to `0.1.7-rc.2` and is not retroactively re-scoped. This
project does **not** claim `0.2.0+`, `0.2.x` or dual-runtime support. The recorded corpora keep the version they were
captured on — `fixtures/dsh-turns/` is `0.1.5`, `fixtures/dsh-0.1.7/` is `0.1.7-rc.2` — and
`test/dsh-020-contract.test.js` is the narrow layer that asserts the wire shapes above against the current runtime.

---

**Superseded in Phase 11.0.** §14 remains the record of the `0.2.0-rc.2` baseline and of the audit that established it;
it is a statement about what was verified *on 0.2.0*, and none of it is retracted. The supported runtime for the
current working tree is now `0.2.1-rc.2` — see §15, which is the normative baseline from Phase 11.0 onward.

## 15. DSH 0.2.1-rc.2 compatibility baseline

| Item | Value |
|---|---|
| Local installed version | `0.2.1-rc.2` |
| Public reference commit | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| Superseded reference commit | `639ed015397290b3745d163aafe02ffee4aa3f84` (`0.2.0-rc.2`) |
| Older reference commit | `477b4f420553e8a52c2fbccc464d7561b239c443` (`0.1.7-rc.2`) |
| Verified local package path | `E:\Projects\DSHarness\_phase11-runtime\dsh-0.2.1-rc.2\node_modules\@deepseek-ai\dsh` — an isolated prefix install (`npm install --prefix ... @deepseek-ai/dsh@0.2.1-rc.2`) whose composed packages resolve as siblings under `...\node_modules\@deepseek-ai\*`, the root the installed paths below are relative to |
| Verified date | 2026-10-17 |
| Version exemption required | no |

### 15.1 Method

Three independent checks, run because the normative runtime changed rather than because a defect was suspected.

1. **Content-addressed comparison of the upstream declarations.** Every consumed declaration file was resolved at
   both commits with `git rev-parse <sha>:<path>` in a local checkout of `deepseek-ai/deepseek-harness` and the
   resulting blob hashes were compared. The comparison is scoped to the consumed packages because the tree is not
   small: **8,431 files** changed between the two reference commits.
2. **Read of the installed `0.2.1-rc.2` runtime.** The published packages ship compiled JavaScript plus `.d.ts`
   declarations, not `src/`, so each source finding was re-checked against the installed `lib/types/**` and `lib/*.js`
   of the isolated install, and compared with the installed `0.2.0-rc.2` tree. The consumed packages are version
   `0.2.1-rc.2` in that tree (11 of the 12 audited package names; see §15.5 for the twelfth, `dsh-client-ui-slots`,
   whose declarations are a build-time artifact).
3. **Execution where a static read is not decisive.** The installed `evaluatePluginCompatibility` evaluators from both
   runtimes were executed against the real manifest and runtime strings, and the isolated host's own boot manifest was
   read back from the served page (§15.4, §15.6).

### 15.2 Upstream comparison — 14 files, 8 identical, 6 changed and classified

| Upstream path | 0.2.0 / 0.2.1 blob | Verdict |
|---|---|---|
| `packages/llm/llm/src/assistant-stream.ts` | `7fca34c5` | identical |
| `packages/api/session-controller/src/client/contract/events.ts` | `bc825f08` | identical |
| `packages/api/session-controller/src/client/session-wire-event.ts` | `59d6ef5b` | identical |
| `packages/api/session-controller/src/client/sessions/assistant-stream.ts` | `973fd108` | identical |
| `packages/api/session-controller/src/client/contract/session.ts` | `2c8f16c4` | identical |
| `packages/api/session-controller/src/client/contract/snapshot.ts` | `161cd858` | identical |
| `packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx` | `bf59a54a` | identical |
| `packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css` | `04b537da` | identical |
| `packages/core/session/src/types.ts` | changed | documentation plus additive experimental plugin-record types; the `SessionEventMap` entries and the `SessionEvent` envelope the adapter reads are unchanged |
| `packages/llm/llm/src/types.ts` | changed | additive provider-configuration metadata (`defaultBaseURL`, `baseURLEnv`, `nativeAuth`) and doc comments; `TokenUsage`, `StreamChunk` and `reasoningTokens` semantics untouched |
| `packages/api/session-controller/src/client/sessions/session.ts` | changed | subagent `prompt` accepts a caller `requestId` — a code path this plugin does not call |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | changed | additive slots and owner props (hero options, user-text nodes, message-image labels); `conversation.input.dock` and `InputZone` unchanged |
| `packages/boot/app-boot/src/plugin-compatibility.ts` | changed | `engines.dsh` now takes precedence *when a manifest declares it*; the peer-only decision remains `semver.satisfies(runtime, range, { includePrerelease: true })`; result field renamed `peers` → `requirements` (diagnostic only) |
| `packages/boot/plugin-manager/src/install-spec.ts` | changed | additive exported `dependencySpec()` for reinstall/repair; `parseInstallSpec` — the path `plugin add file:` uses — is unchanged |

One further contract file, not in the §14 list, was added to this audit:

| Upstream path | Verdict |
|---|---|
| `packages/api/session-controller/src/client/contract/sessions.ts` | changed — `create()` gained an optional `agentPreset`, `fork()` gained an optional `allowMigration`; `binding(id: SessionId): SessionBinding \| undefined` is unchanged text and `SessionBinding` keeps its four readonly fields |

The consumed event-window file being byte-identical is the load-bearing result: the four `SessionEventChange` arms, the
`SessionEventWindow` fields and the `MutableSessionEventSource.publish` `revision + 1` producer behind the Phase 10.1R
gap-rebaseline rule are the same bytes in both runtimes. The llm-stream file being byte-identical is the other: the
compact `AssistantStreamRecord`/`dt` decoder and `isTokenDelta` were not redefined.

### 15.3 Installed-runtime confirmation

| Contract | 0.2.1 installed evidence | What the plugin reads | Verdict |
|---|---|---|---|
| `SessionEvent` envelope | `dsh-session/lib/types/types.d.ts` — `type`, `seq` (“Monotonic sequence number within the session”), `time` (“Unix epoch milliseconds”), `data` | `{type, seq, time, data}`; envelope bytes text-identical to the 0.2.0 install | unchanged |
| `SessionEventMap` entries | `dsh-session/lib/types/types.d.ts` — `turn/start`, `turn/end`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result` all present with the same keys | turn boundaries, settlements, tool plane | unchanged |
| `SessionEventWindow` / `SessionEventChange` / `SessionEventSource` | `dsh-api-session-controller/lib/types/client/contract/events.d.ts` — **byte-identical** to the 0.2.0 installed file (4,233 bytes, same SHA-256) | revision, the four change kinds, snapshot/subscribe | unchanged |
| `AssistantStreamRecord` / `isTokenDelta` | `dsh-llm/lib/types/assistant-stream.d.ts` — **byte-identical** (8,338 bytes) | compact `time0`/`dt[]`/`texts`/`args` reconstruction and first-token predicate | unchanged |
| `TokenUsage` | `dsh-llm/lib/types/types.d.ts` — fields `inputTokens`, `outputTokens`, `totalTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?`; declaration identical in 0.2.0 and 0.2.1 | authoritative usage; `reasoningTokens` remains contained in `outputTokens` | unchanged |
| `SessionBinding` / `sessions.binding()` | `dsh-api-session-controller/lib/types/client/sessions/service.d.ts` — `{ sessionId, session, eventSource, ctx }`, all four `readonly`, identical to 0.2.0; `contract/sessions.d.ts` declares `binding(id): SessionBinding \| undefined` | `binding(sessionId).eventSource` identity, snapshot and subscribe; rebind on generation change | unchanged |
| `conversation.input.dock` / `InputZone` | `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` — declaration still `{ kind: 'list'; scope: 'session'; owner: InputZone }`; `InputZone { readonly session: SessionSnapshot; readonly input: InputState }` identical | slot registration at `order: -10`, `props.sessionId` | unchanged |
| `locale` service | `dsh-client-locale/lib/types/client/index.d.ts` — **byte-identical** to 0.2.0 | `ctx.locale.register(ns, dicts)` and `ctx.locale.bind(ns)` | unchanged |
| `slots` service + slot lifecycle | `dsh-client-ui-renderer/lib/client.js` — the registry ships with `inject(...)`, `runInject`, `cachedSlotInject`/`cachedSessionInject`; the file changed only additively (inline anchors, keyed-hook member, style-claim fix) | `ctx.slots.inject(name, () => register(...))`, idempotency across reload/session switch | unchanged semantics |
| Web bundle loading | `dsh-client-modules/lib/index.js` — `rev: shortHash(JSON.stringify({...}))`; `dsh-client-modules/lib/client.js` — new `ReleaseChangeGate` (pauses plugin updates when the page's boot release differs from the Host release; inert on a same-release page) | `__ModuleLoader__` factory, served bundle `rev`, `platform`/`immediately`/`inject` | unchanged for a same-release runtime |
| Plugin-compatibility gate | `dsh-app-boot/lib/index.js` — `evaluatePluginCompatibility`, `unmetRequirements`, `engines.dsh` branch, `semver.satisfies(..., { includePrerelease: true })`; result field `requirements` | the manifest's `peerDependencies['@deepseek-ai/dsh']` | decision unchanged for peer-only manifests |
| Install spec | `dsh-plugin-manager/lib/index.js` — `parseInstallSpec` present; additive `dependencySpec` | `plugin add file:<tgz>` | unchanged |

The installed evidence therefore agrees with the source comparison: the declarations on the plugin's evidence path did
not move. The six changed files implement features above or beside that path (provider metadata, experimental records,
extra client slots, subagent/install plumbing), not underneath it.

### 15.4 The plugin-compatibility gate

`dsh-app-boot` evaluates a plugin's DSH requirement before install and at profile load. For a manifest that declares
`peerDependencies` and no `engines.dsh` — this plugin's shape — the decision is unchanged between the two runtimes:

```js
semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })
```

`includePrerelease: true` is again the detail that matters: a prerelease runtime participates in ranges, so an exact
prerelease pin is decided by exact version equality. Executed against the installed evaluators (LOCAL TEST RESULT;
saved under `dev/phase11/lead/peer-evaluator-matrix.txt`), with six cells and both evaluators:

| Evaluator | Manifest peer | Runtime | Result |
|---|---|---|---|
| 0.2.1 installed | `0.2.1-rc.2` (migrated) | `0.2.1-rc.2` | compatible (`undefined`) |
| 0.2.1 installed | `0.2.0-rc.2` (old) | `0.2.1-rc.2` | incompatible — `{"@deepseek-ai/dsh":"0.2.0-rc.2"}` |
| 0.2.0 installed | `0.2.0-rc.2` (old) | `0.2.1-rc.2` | incompatible — same decision (negative control) |
| 0.2.0 installed | `0.2.1-rc.2` (migrated) | `0.2.1-rc.2` | compatible |
| 0.2.1 installed | `0.2.1-rc.2` (migrated) | `0.2.0-rc.2` | incompatible — opposite direction |
| 0.2.0 installed | `0.2.0-rc.2` (old) | `0.2.0-rc.2` | compatible |

The old peer is therefore **not** merely stale documentation on `0.2.1-rc.2`: it is refused at install
(`incompatible-version`) and the bundle is skipped at profile load. That is why the peer had to move for this migration,
and it is why the migration's install-time acceptance is evidence rather than bookkeeping.

`0.2.1-rc.2` still ships exact-version compatibility *exemptions* (`allow-version`, `revoke-version`,
`version-exemptions`). **No exemption is used or required by this plugin**, and `allow-version --accept-risk` is not
part of this migration: an exemption accepts a declared incompatibility, and the migrated plugin declares a compatible
peer, so the gate passes on its own terms. The isolated profile's `version-exemptions` store reads `{}` and the plugin
still boots.

### 15.5 Differences between the three references assessed as irrelevant

- `engines.dsh` precedence in the compatibility gate (§15.4): new, and unused by this plugin because it declares no
  `engines`.
- `ReleaseChangeGate` in the client module loader: pauses plugin-update application when the page outlives a Host
  release change. The isolated acceptance page and host are the same release, so the gate is inert; a page reload
  adopts the new release by construction.
- Additive experimental plugin records (`plugin:` namespace) in the session log: the plugin reads concrete event types
  and ignores unknown ones through the existing envelope handling.
- Provider metadata on `LlmConfigurableProvider` and the `GenerateOptions.purpose` doc rewrite: configuration surface,
  not the usage/stream evidence the plugin reads.
- Additive client slots and owner props (`conversation.hero.options`, user-text nodes, message-image labels): new seats
  beside the dock, not a change to it.
- Subagent/`create` options (`requestId`, `agentPreset`, `allowMigration`) and the install-spec `dependencySpec` helper:
  code paths the plugin never calls.
- `@deepseek-ai/dsh-client-ui-slots` is present in the 0.2.0 install tree but absent from the 0.2.1 install tree; its
  declarations are a build-time artifact of the client packages, the `slots` service itself ships in
  `dsh-client-ui-renderer`, and this plugin neither imports the package nor names it in `dsh.client.inject`.

### 15.6 Real-runtime acceptance — observed, with one unobserved item

On the isolated `0.2.1-rc.2` host the plugin was installed from the migrated tarball (exact peer accepted, no
compatibility exemption, `version-exemptions {}`), booted into the served module graph (`rev a5b665752098`, no
`skippedBundles` entry) and the served bundle was byte-identical to the built `client.js` plus the 83-byte source-map
trailer. The real-browser matrix on that host then observed: boot/dock acceptance **PASS** (18/18), R1 **PASS** (9/9),
R2 **PASS** (7/0/1 — the provider returned no `reasoningTokens`, so the per-phase token split against the provider was
not observable), R3 **PASS** (7/0/2 — the real tool call returned in ~10 ms, shorter than the 100 ms presentation
cadence, so the tool-timer-advance frame was not observable), R4 **PASS** (14/14), R7 **PASS** (11/11), R8 **PASS**
(7/7). R6's required behaviour was observed across two real runs — real OS window minimize plus opaque cover, hidden
intervals with rAF gaps of 11,320 ms and 18,254 ms, `foregroundResyncs 1 → 2`, settlement while hidden and card tokens
equal to durable tokens (2,106 / 2,106 and 346 / 346) — while its final consolidated clean-browser rerun was
environment-limited and recorded NOT OBSERVED for that attempt. R5 is **NOT OBSERVED for connector occurrence**: the
natural tool turns produced no eligible same-phase adjacent attempt boundary (the outgoing run was a 5 ms tool-argument
singleton and/or carried a tail phase cut), so no real-turn continuity connector is claimed; connector geometry remains
covered by the deterministic curve-continuity tests. The per-check raw evidence is under
`dev/phase11/runtime/out/` with the merged report at `dev/phase11/runtime/matrix-results.md`.

Because one required real-runtime item is not observed, this phase does **not** declare compatibility accepted; the
verdict recorded in `docs/IMPLEMENTATION_LOG.md` (Phase 11.0 §8) is **BLOCKED — RUNTIME ACCEPTANCE**, with source
compatibility confirmed.

### 15.7 Supported version

The only supported and tested DSH for the current working tree is `0.2.1-rc.2`, verified against the isolated installed
package recorded in §15 and the real-browser acceptance matrix recorded in `docs/IMPLEMENTATION_LOG.md` (Phase 11.0).
The published `v0.1.5` release remains bounded to `0.2.0-rc.2` and is not retroactively re-scoped; the working tree is
unreleased and keeps version `0.1.5`. This project does **not** claim `0.2.1+`, `0.2.x` or dual-runtime support. The
recorded corpora keep the version they were captured on — `fixtures/dsh-turns/` is `0.1.5`, `fixtures/dsh-0.1.7/` is
`0.1.7-rc.2` — and neither is restamped. `test/dsh-021-contract.test.js` is the narrow layer that asserts the wire
shapes above against the current runtime; `test/dsh-020-contract.test.js` is retained as the 0.2.0-rc.2 historical
record.

## 16. DSH 0.2.1-rc.3 compatibility baseline

| Item | Value |
|---|---|
| Local installed version | `0.2.1-rc.3` |
| Public reference commit | `1f81c047fc48fa190a683e469daa699857e9afe8` (tag `dsh-v0.2.1-rc.3`, "Merge pull request #6999 from deepseek-harness/worktree/release-dsh-0.2.1-rc.3") |
| Superseded reference commit | `687f282e8625c6b8d11ff58211a90524be2e4317` (`0.2.1-rc.2`, tag `dsh-v0.2.1-rc.2`) |
| Older reference commits | `639ed015397290b3745d163aafe02ffee4aa3f84` (`0.2.0-rc.2`), `477b4f420553e8a52c2fbccc464d7561b239c443` (`0.1.7-rc.2`) |
| Verified local package path | `E:\Projects\DSHarness\_phase13-runtime\dsh-0.2.1-rc.3\node_modules\@deepseek-ai\dsh` — an isolated prefix install (`npm install --save-exact @deepseek-ai/dsh@0.2.1-rc.3`), version read back as `0.2.1-rc.3`, tarball `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.3.tgz`, integrity `sha512-H+E9HLnHf7fJqzen84Z9Bq8ggb5xbrcbyhZjXTJLE9NabHr3zteGvTRvdvGkxPl4ov80is4WLglFmSo+/olJjg==` |
| Verified date | 2026-10-24 |
| Version exemption required | no |

### 16.1 Method

Three independent checks, run because the normative runtime moved, not because a defect was suspected.

1. **Content-addressed comparison of the upstream declarations.** Each consumed declaration was resolved at both
   commits with `git rev-parse <sha>:<path>` in two worktrees of a full `deepseek-ai/deepseek-harness` clone
   (`_phase13-runtime\upstream\rc2`, `.../rc3`, both verified by `git rev-parse HEAD` to the full SHAs above) and the
   blob hashes compared. Between the two reference commits there are **6 commits**, all of them product work
   (`release(dsh): 0.2.1-rc.3`, the official `/models` listing on the API-key route, navigation entry customization,
   navigation pins/analytics, and the release merge); none of them is a session-controller or event-window change.
2. **Read of the installed `0.2.1-rc.3` runtime.** The published packages ship compiled JavaScript plus `.d.ts`
   declarations, so every source finding was re-checked against the installed `lib/types/**` and `lib/*.js` of the
   isolated rc.3 install and against the installed rc.2 tree. All 306 composed packages report `0.2.1-rc.3`.
3. **Execution where a static read is not decisive.** The installed compatibility evaluator was executed against the
   real manifest/runtime strings, the contract tests were run against the plugin tree, and the real-browser acceptance
   matrix was run on the isolated rc.3 host (§16.6).

### 16.2 Upstream comparison — the consumed declarations are unchanged; the changes are additive

| Upstream path | rc.2 / rc.3 blob | Verdict |
|---|---|---|
| `packages/api/session-controller/src/client/contract/events.ts` | `bc825f08fd` | identical — `SessionEventWindow`, the four `SessionEventChange` kinds, `MutableSessionEventSource` |
| `packages/api/session-controller/src/client/contract/sessions.ts` | `a52d2c15` | identical — `SessionBinding` borrow, `retainInfo(id)` doc + signature |
| `packages/api/session-controller/src/client/contract/session.ts` | `2c8f16c4ae` | identical — `Session` |
| `packages/api/session-controller/src/client/sessions/session.ts` | `09494e01ab` | identical |
| `packages/api/session-controller/src/client/sessions/manager.ts` | `b8bec9be8a` | identical — `SessionManager` |
| `packages/api/session-controller/src/client/session-wire-event.ts` | `59d6ef5b` | identical |
| `packages/api/session-controller/src/client/sessions/assistant-stream.ts` | `973fd108` | identical — the transient `assistant/live-chunk` producer |
| `packages/llm/llm/src/assistant-stream.ts` | `7fca34c5` | identical — `AssistantStreamRecord` `time0`/`dt[]` and `isTokenDelta` |
| `packages/core/session/src/types.ts` | identical | `turn/start`, `turn/end`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result` and the envelope |
| `packages/boot/app-boot/src/plugin-compatibility.ts` | `2e4ca573` | identical — the compatibility checker |
| `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` | `ef95796577` | identical |
| `packages/client/ui-conversation/src/client/skeleton/ConversationPanel.tsx` | `8bd11aac33` | identical |
| `packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx` | identical | the `conversation.input.dock` render site (`:168`) |
| `packages/client/ui-renderer/src/client/registry.ts` / `packages/client/ui-slots/**` | identical | slot registry, `inject`, `register`, strict session-scope props |
| `packages/api/session-controller/src/client/sessions/service.ts` | 1 line | **comment-only** — one JSDoc sentence inside `SessionSummary`; `retainInfo`'s cached `retainObservers` implementation is unchanged |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | `a02f5aa6` → `4a0bd3a7` | **strictly additive** — new root-scope slot `conversation.session.header.views.actions`, `ConversationViewActionsOwnerProps`, and header `hooks`/`setPinned`; `conversation.input.dock` at `:272` is unchanged text |
| `packages/client/ui-workspace/src/client/navigation.ts` | changed | `replaceMain()` byte-identical; the changes are draft handling (`whenDraftExists`), blank-session reuse across presets, and JSDoc |
| `packages/client/ui-conversation/src/client/{apply.ts,skeleton/ConversationSession.tsx,view-pins.ts,contract/input.ts,contract/composer-submission.ts,input/**}` | changed | additive View-tab More menu, View pins, and draft/submission metadata — no dock, no session-scope, no wire contract |

The load-bearing result is that the event-window file, the session-controller contracts, the assistant-stream decoder and
the compatibility checker are **byte-identical**. The rc.3 product changes are a header More menu for View tabs and the
new-session draft/reuse behaviour in `ui-workspace`, neither of which is a declaration this plugin consumes.

### 16.3 The one real incompatibility, and the migration change

The compatibility checker did not change; the **peer pin did not match the new runtime**. With no `engines.dsh`, DSH
evaluates every `@deepseek-ai/dsh` peer with `semver.satisfies(runtimeVersion, requirement)`; against `0.2.1-rc.3` an
exact `0.2.1-rc.2` peer is unmet, and `app-boot/src/profile.ts` **silently** pushes a profile bundle with an unmet
requirement into `skippedBundles` — the meter would not load at all. This was verified from the rc.3 sources and the
unchanged evaluator, and confirmed on the isolated host (below).

The migration change is therefore exactly one declaration:

```json
"peerDependencies": { "@deepseek-ai/dsh": "0.2.1-rc.3" }
```

The exact pin is deliberate and follows the project's existing convention (§14.4, §15.4): a range would admit runtimes
this project has not exercised, and the phase contract forbids a wide semver range. The consequence is stated plainly:
the working tree now supports **only** `0.2.1-rc.3`; the published `v0.1.6` artifact keeps its own exact `0.2.1-rc.2`
pin and is not restamped. `0.2.1-rc.3` still ships exact-version exemptions (`allow-version`, `revoke-version`,
`version-exemptions`); **no exemption is used or required**, and `allow-version --accept-risk` is not part of this
migration.

### 16.4 Installed-runtime confirmation

| Contract | rc.3 installed evidence | What the plugin reads | Verdict |
|---|---|---|---|
| `SessionEventWindow` / `SessionEventChange` / `SessionEventSource` | `dsh-api-session-controller/lib/types/client/contract/events.d.ts` — **byte-identical** to the rc.2 installed file | `revision`, the four change kinds, `getSnapshot`/`subscribe` | unchanged |
| `SessionBinding` / `sessions.binding()` / `retainInfo()` | `dsh-api-session-controller/lib/types/client/sessions/service.d.ts` — one comment line differs; `binding(id): SessionBinding \| undefined` and `retainInfo(id)` are unchanged | binding identity, `eventSource`, retention watch | unchanged |
| `Session` / `SessionManager` | `dsh-api-session-controller/lib/types/client/contract/session.d.ts` and `sessions/*.d.ts` byte-identical | session generation identity | unchanged |
| `conversation.input.dock` / `InputZone` | `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` — the rc.3 additions are the new `views.actions` slot and view-pin hooks; `conversation.input.dock` keeps `{ kind: 'list'; scope: 'session'; owner: InputZone }` | slot registration at `order: -10`, `props.sessionId` | unchanged |
| `slots` service + `locale` service | `dsh-client-ui-renderer`, `dsh-client-locale` declarations unchanged | `ctx.slots.inject/register`, `ctx.locale.register/bind` | unchanged |
| Cordis injection packages | all three declared packages (`dsh-api-session-controller`, `dsh-client-locale`, `dsh-client-ui-conversation`) are present at `0.2.1-rc.3` and remain rows of the `dsh-base`/`dsh-web-app` compositions | `dsh.client.inject` | unchanged |
| Web bundle loader | `@deepseek-ai/dsh-client-modules` package version moved to `0.2.1-rc.3`; its loader source is unchanged and the `__ModuleLoader__` / `rev` / `platform` / `immediately` / `inject` protocol is identical | served plugin body, boot rev, `skippedBundles` | unchanged |
| Plugin-compatibility gate | `dsh-app-boot` evaluator byte-identical; decision is exact-version equality with `{ includePrerelease: true }` | `peerDependencies['@deepseek-ai/dsh']` | unchanged decision; the pin moved |

rc.3 also adds the first-party `@deepseek-ai/dsh-client-ui-entry-customization` row to the web bundle. It registers only
sidebar/guide/header-view seats; it does not touch `conversation.input.dock` and does not collide with this plugin's
seat id or order.

### 16.5 Differences between the two references assessed as irrelevant

- The View-tab More menu and its root-scope slot `conversation.session.header.views.actions`: new seats in the session
  header, beside the dock, not a change to it. The header renders More only while that slot has registrations, so a
  plugin that registers nothing there is invisible to the menu.
- View pins (`view-pins.ts`, `setPinned`, `entryPins`): presentation state for the Conversation header.
- `ui-workspace` new-session draft/reuse behaviour (`whenDraftExists`, preset-aware blank reuse): a navigation-policy
  change. It is the one rc.3 change that the plugin can *notice* — New Session may now open an existing blank session
  instead of creating one, so the dock can be remounted on a session id it has visited before. That is exactly the
  class of navigation the Phase 12.0 binding-generation recovery already handles, and R9 exercises it end to end.
- Navigation entry customization and its analytics events: keyboard/entry surfaces outside this plugin.
- The official `/models` listing on the DeepSeek API-key route and the account catalog's lazy first-access listing:
  route plumbing; the plugin reads usage from turn events, never from the model catalog.
- Additive submission metadata (`newSession`, `agentPreset`): composer plumbing.

### 16.6 Real-runtime acceptance — observed, with no unobserved item

On the isolated `0.2.1-rc.3` host the plugin was installed from the adapted tarball (exact peer accepted, no
compatibility exemption, no `skippedBundles` entry, 71-entry served graph, plugin rev `0c26f9f4b972`) and the served
bundle was byte-identical to the built `client.js` plus the 83-byte module trailer. The real-browser matrix then observed
**boot 19/19, R1 12/12, R2 11/11, R3 11/11, R4 14/14, R5 10/10, R6 13/13, R7 10/10, R8 9/9, R9 14/14 — 123/123 checks
PASS, 0 FAIL, 0 NOT OBSERVED.**

- **R1** live TTFT (107 ms to the first-response stage; settled card TTFT 0.84 s), 205 live TPS samples, configured
  100 ms cadence with real DOM update p50 = 100 ms / p95 = 103 ms, 9.73 scheduler ticks/s, timer stopped on completion.
- **R2** real `pwsh` tool window 8,315 ms: after a one-cadence-tick transition (87 ms), 107 tool-phase samples carry
  the tool stopwatch and no model rate; the following model phase resumes.
- **R3** completed card tokens 2,002 and attempts 1 exactly match the durable turn; peak ≈306; 104-point curve.
- **R4** three real main → subagent-child → main trips inside a live parent turn: `binding.eventSource` identity
  1→3→5→7 with `eventSourceRebinds +1` and `navigationResyncs +1` per return, `foregroundResyncs +0` while visible,
  `feedRevision == lastSourceRevision`, `retentionWatches = 1`, one active plugin subscription; card 440 tokens equals
  durable.
- **R5** a real scope retirement while the child was visible left the retired sources with **0 listeners / 0 plugin
  records**; each new generation carries exactly one plugin subscription, `feed == source`, no stale foreign card.
- **R6** deterministic 120/150-session simulation: retired scopes hold 0 callbacks/watches/subscriptions while
  `sessionsMap == storeTurns == N`, and a re-visit arms exactly one watch (LOCAL TEST RESULT); real visits keep
  `{sessions: 3, retentionWatches: 1}` with each previous binding retired.
- **R7** real Win32 minimize + restore: 8,848–9,231 ms hidden, page-side hidden→visible edges, `foregroundResyncs 0 → 1`
  for exactly one real edge, scheduler suspended while hidden, authoritative state after restore, turn settled with
  2,974 tokens == durable.
- **R8** a genuine multi-attempt turn (3 attempts, 2 real tool cycles) rendered a real continuity connector
  (output, attempt 2 → 3), peak ≈404, card tokens 547 == durable.
- **R9** the rc.3 header View-tabs More menu (new root slot `conversation.session.header.views.actions`, rendered
  because the first-party entry-customization row is present) was opened and closed three times: no intersection with
  the meter or composer, no position delta, no duplicate mount or subscription, unchanged bound session; the sidebar
  panel-list More menus behave identically. rc.3's draft reuse (New Session reopens the same blank session and restores
  the unsent draft) does not disturb the meter's `sessionId` binding.

The per-check raw evidence is under `dev/phase13/runtime/out/` (`MATRIX.md`, `run-summary.json`, per-round
`run-summary.json` / `driver.log` / `samples.jsonl` / screenshots), with the isolated environment runbook under
`_phase13-runtime/RUNBOOK.md`. Because every required item is observed, the migration is not limited by an unobserved
runtime dimension; the final verdict is **PASS — DSH 0.2.1-rc.3 COMPATIBILITY ACCEPTED; INDEPENDENT SOURCE AUDIT
CLOSED**. The runtime matrix recorded above is this project's own executed evidence; the separate independent GitHub
remote source audit closed in Phase 13.0R verified the committed source, the manifest, the code diff and the contract
tests at source level and did **not** re-run the browser matrix, so it is not reported as a runtime re-test. Full
record: `docs/IMPLEMENTATION_LOG.md` Phase 13.0 and Phase 13.0R.

### 16.7 Supported version

The only supported and tested DSH for the current working tree is `0.2.1-rc.3`, verified against the isolated installed
package recorded in §16 and the real-browser acceptance matrix recorded in `docs/IMPLEMENTATION_LOG.md` (Phase 13.0).
The baseline is integrated on `main` (Phase 13.0R fast-forward, no merge commit); the annotated `v0.1.6` tag still
points at `568ebaaeab2c9362a2c265f9d5173bac73b264e5` and the published `v0.1.6` release is unchanged.
The published `v0.1.6` release remains bounded to `0.2.1-rc.2` and is not retroactively re-scoped; the working tree is
unreleased and keeps version `0.1.6`. This project does **not** claim `0.2.1+`, `0.2.x` or dual-runtime support, and the
exact peer pins exactly one runtime by design. The recorded corpora keep the version they were captured on —
`fixtures/dsh-turns/` is `0.1.5`, `fixtures/dsh-0.1.7/` is `0.1.7-rc.2` — and neither is restamped.
`test/dsh-021-rc3-contract.test.js` is the narrow layer that asserts the wire shapes, the metadata and the
`retainInfo`/generation semantics against the rc.3 target; `test/dsh-021-contract.test.js` and
`test/dsh-020-contract.test.js` are retained as the rc.2 and 0.2.0 historical records.

## 17. Release Phase A — v0.1.7 `engines.dsh` compatibility range

| Item | Value |
|---|---|
| Status | **RELEASE PREPARED — not published to npm, not tagged, no GitHub Release** |
| Release version | `0.1.7` |
| Live declaration | `"engines": { "dsh": ">=0.2.1-rc.2 <0.2.2-0" }` |
| Removed declaration | `"peerDependencies": { "@deepseek-ai/dsh": "0.2.1-rc.3" }` (and the superseded exact `0.2.1-rc.2` pin it replaced) |
| Device-verified runtimes | DSH `0.2.1-rc.2` and DSH `0.2.1-rc.3` — isolated install + real-browser acceptance |
| Range-decision only | DSH `0.2.1-rc.4`, DSH `0.2.1` — semver decision, **not** device-verified |
| Unsupported | the `0.2.0` line and the `0.2.2` line |
| Version exemption | none used; `allow-version --accept-risk` is not part of this release |

### 17.1 Why the declaration moved from an exact peer to `engines.dsh`

The exact peer worked, but it forced a new plugin release for every DSH version on the same compatible line: v0.1.6
declared exact `0.2.1-rc.2`, the Phase 13.0 working tree declared exact `0.2.1-rc.3`, and neither could load on the
other runtime even though every consumed declaration is byte-identical (§16). The host evaluator already supported an
own `engines.dsh` range that decides alone; v0.1.7 therefore declares one bounded range and removes the DSH peer
entirely. The bounds are deliberate: `>=0.2.1-rc.2` keeps the accepted rc.2 floor, `<0.2.2-0` excludes the whole
`0.2.2` line (the `-0` sentinel sorts below every real `0.2.2` prerelease and below `0.2.2` itself).

### 17.2 Evaluator semantics — verified, not assumed

The evaluator is `packages/boot/app-boot/src/plugin-compatibility.ts`. It is **byte-identical** between the rc.2
reference (`687f282e8625c6b8d11ff58211a90524be2e4317`) and the rc.3 reference
(`1f81c047fc48fa190a683e469daa699857e9afe8`): `git diff --stat 687f282e..1f81c047 --
packages/boot/app-boot/src/plugin-compatibility.ts packages/boot/app-boot/src/compatibility-preflight.ts
packages/boot/app-boot/src/profile.ts` is empty. `compatibility-preflight.ts` and `profile.ts` call the same evaluator;
there is no second installation rule.

The precedence and comparison are, in the installed source:

```ts
function satisfies(runtimeVersion: string, range: string): boolean {
  return range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
}
function unmetRequirements(fields, runtimeVersion) {
  const engines = Object.hasOwn(fields, 'engines') ? objectOf(fields.engines, 'Plugin manifest engines') : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('Plugin manifest engines.dsh must be a string')
    return satisfies(runtimeVersion, range) ? {} : { 'engines.dsh': range }
  }
  if (!Object.hasOwn(fields, 'peerDependencies')) return {}
  // … every @deepseek-ai/dsh / @deepseek-ai/dsh-* peer must match
}
```

Confirmed semantics for this release:

- an own `engines.dsh` **decides alone**; `peerDependencies` are ignored when it is present;
- the comparison is semver, with **`includePrerelease: true`**;
- an unmet `engines.dsh` is reported as `requirements: { "engines.dsh": <range> }` and is the only condition that
  skips a profile bundle (`profile.ts`) or disables a loader row (`compatibility-preflight.ts`);
- a matching range returns `undefined` — no diagnostic, no exemption, no `allow-version --accept-risk` step;
- `engines.dsh` is not an npm/pnpm engine key (`engines.node` / `engines.npm` / `engines.pnpm` are the package-manager
  keys), so pnpm does not block the install on it; the host evaluator is the gate.

The installed evaluator was executed directly, from both isolated toolchains, rather than reimplemented:
`@deepseek-ai/dsh-app-boot/lib/index.js` exposes `getDshRuntimeVersion()` and `evaluatePluginCompatibility()`; the rc.2
install reports `0.2.1-rc.2` and the rc.3 install reports `0.2.1-rc.3`.

### 17.3 Version matrix — executed against the installed evaluator

The v0.1.7 manifest was passed to `evaluatePluginCompatibility(manifest, {}, runtimeVersion)` with both installed
evaluators; both returned the same decisions.

| DSH runtime | Requirement decision | Interpretation |
|---|---|---|
| `0.2.0-rc.2` | **REJECT** | below the accepted floor |
| `0.2.1-rc.1` | **REJECT** | below the accepted floor |
| `0.2.1-rc.2` | **ACCEPT** | device-verified (this release) |
| `0.2.1-rc.3` | **ACCEPT** | device-verified (this release) |
| `0.2.1-rc.4` | **ACCEPT** | range decision only — **not** device-verified |
| `0.2.1` | **ACCEPT** | range decision only — **not** device-verified |
| `0.2.2-rc.1` | **REJECT** | above the capped line |
| `0.2.2` | **REJECT** | above the capped line |

Each REJECT returned exactly `requirements: { "engines.dsh": ">=0.2.1-rc.2 <0.2.2-0" }`; each ACCEPT returned
`undefined`. `0.2.1-rc.4` and `0.2.1` are statements about the range, not runtime acceptance.

### 17.4 Precedence test — the host's own implementation wins

A test-only manifest declaring both fields was evaluated by the installed host evaluator:

| Test manifest | Runtime | Result |
|---|---|---|
| `engines.dsh = ">=0.2.1-rc.2 <0.2.2-0"` **and** peer `"@deepseek-ai/dsh": "0.0.0-deliberately-mismatched"` | `0.2.1-rc.2`, `0.2.1-rc.3` | **COMPATIBLE** — the mismatched peer is ignored |
| `engines.dsh = "^9.9.9"` **and** peer `"@deepseek-ai/dsh": "0.2.1-rc.2"` | `0.2.1-rc.2` | **REJECT**, `requirements: { "engines.dsh": "^9.9.9" }` — a matching peer cannot rescue a failing engines range |
| no `engines`, peer `"@deepseek-ai/dsh": "0.2.1-rc.2"` | `0.2.1-rc.2` / `0.2.1-rc.3` | ACCEPT / REJECT — the documented peer-only fallback is unchanged |

The production manifest is different from these test manifests on purpose: it carries **no** `peerDependencies` at all.

### 17.5 Committed tests

- `test/dsh-engine-range.test.js` (new) pins the manifest shape, the eight-row range matrix, the inclusive/exclusive
  bounds, the `engines.dsh` priority rule, and the non-DSH-peer irrelevance. It resolves the installed host evaluator
  from `DSH_APP_BOOT_LIB` or the sibling isolated toolchains and uses it for the decision; a spec-faithful portable
  comparator keeps the same assertions self-contained when no installed evaluator is resolvable, so no test is
  skipped or weakened.
- `test/dsh-021-rc3-contract.test.js` (the rc.3 normative layer) now pins the v0.1.7 manifest: `engines.dsh` exact,
  no `peerDependencies`, no `engines.node`, release version `0.1.7`.
- `test/dsh-021-contract.test.js` and `test/dsh-020-contract.test.js` stay as the rc.2 and 0.2.0 historical layers.
  Their wire-shape evidence is untouched; only their cross-file working-declaration guard changed, from the superseded
  exact-peer read to the `engines.dsh` read. No old test was deleted or weakened.
- Suite: **966 tests, 966 pass, 0 fail, 0 skipped, 0 todo** (960 pre-existing + 6 in the new range file).

### 17.6 Isolated install acceptance — two disposable runtimes

Two fresh, disposable profiles were created in their own `DSH_HOME` directories and each received the temporary local
v0.1.7 tarball (never a published version):

| Item | rc.2 profile | rc.3 profile |
|---|---|---|
| Toolchain | `_phase11-runtime/dsh-0.2.1-rc.2` | `_phase13-runtime/dsh-0.2.1-rc.3` |
| `DSH_HOME` | `_release-v017/rc2/dsh-home` | `_release-v017/rc3/dsh-home` |
| Profile | `tpm-v017-rc2` | `tpm-v017-rc3` |
| Host port | `50251` | `50252` |
| Headless CDP port | `9251` | `9252` |
| Install command | `dsh plugin --profile tpm-v017-rc2 add "file:<temp>.tgz"` | `dsh plugin --profile tpm-v017-rc3 add "file:<temp>.tgz"` |
| Install result | exit 0, `+ dsh-turn-performance-meter` | exit 0, `+ dsh-turn-performance-meter` |
| Installed manifest | `0.1.7`, `engines.dsh` exact, **no peer**, no exemption | same |
| pnpm lock | records `engines: {dsh: '>=0.2.1-rc.2 <0.2.2-0'}`, no peer resolution | same |

Both hosts then passed the same checks (all **PASS**, no NOT OBSERVED item):

- token URL serves the SPA (200) and the token-less root is fenced (401);
- the plugin row is present in the served `__DSH_BOOT__` graph with `inject` = the three Cordis packages
  (`dsh-api-session-controller`, `dsh-client-locale`, `dsh-client-ui-conversation`) and `immediately: true`; all three
  injected rows are present;
- the served plugin body is the installed `client.js` plus the 83-byte module trailer, and the installed client is
  byte-identical to the accepted bundle (`07F717FA4BA11425A034B3DD81E122C208D99D1783E4C0F919C409118137ED69`);
- the installed host evaluator accepts the installed manifest; `skippedBundles` contains no plugin and the host logs
  contain no `skipping profile bundle` / `is incompatible with dsh` diagnostic; `compatibility.json` does not exist
  (no exemption);
- real browser: `[data-slot="conversation.input.dock"]` present, exactly one `.dsh-tpm-root` inside it, one plugin style
  element, seat above and spanning the composer column;
- real model turns on both runtimes: model route `DeepSeek-V4.1-Flash` + `High`, Full access, a completed card whose
  tokens equal the durable turn;
- published navigation/lifecycle scenarios on both runtimes: main → real subagent child → main round trips with
  identity rebind + navigation resync, `feedRevision == lastSourceRevision`, one retention watch, one active plugin
  subscription, no stuck tool/waiting state, retirement releases the watch and re-visit re-arms exactly one.

Per-runtime results: rc.3 — boot `20/20`, R4 navigation `14/14`, R6 retention `13/13`, boot-HTTP `19/19`, dock `7/7`;
rc.2 — published Phase 12.0R scenario `PASS` (76 checks, 0 failure), boot-HTTP `19/19`, dock `7/7`. Evidence is local,
under the git-local-excluded `dev/release-v017/` and `_release-v017/` (host logs, served page/boot graph, served plugin
body, screenshots, run summaries). No test was used as a substitute for a real-runtime observation, and no unexecuted
scenario is claimed as executed.

### 17.7 Claim boundary

- `0.2.1-rc.2` and `0.2.1-rc.3` are **device-verified** for v0.1.7 by the acceptance above.
- `0.2.1-rc.4` and `0.2.1` are **range decisions only**. The range deliberately allows install on future
  non-breaking `0.2.1`-line runtimes, but those have not been exercised; no device compatibility is claimed for them.
- The `0.2.0` line and the `0.2.2` line are **not supported** — the evaluator rejects them.
- The range is not a wildcard and has a closed upper bound; `*`, `>=0.2.1`, `^0.2.1-rc.2` and `||` unions were rejected
  as release declarations.

### 17.8 Historical releases and artifacts

- `v0.1.6` remains published with its original exact peer `"@deepseek-ai/dsh": "0.2.1-rc.2"`; it is **not** restamped
  or re-scoped, and its npm package, Git tag, GitHub Release and canonical tarball are untouched.
- `v0.1.7` is the first release that declares an `engines.dsh` range. At this point it is **RELEASE PREPARED**, not
  published: no npm publish, no Git tag, no GitHub Release, no uploaded asset.
- The release-prep commit and this documentation do not change production source or either bundle: `client.js` /
  `lib/client.js` stay 651,961 bytes at
  `07F717FA4BA11425A034B3DD81E122C208D99D1783E4C0F919C409118137ED69`, and the frozen constants remain
  `DEFAULT_PRESENTATION_REFRESH_MS = 100`, `MIN_RATE_SAMPLES = 3`, `MIN_RATE_ELAPSED_MS = 100`.
