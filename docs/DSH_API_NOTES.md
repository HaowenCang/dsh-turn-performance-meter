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
