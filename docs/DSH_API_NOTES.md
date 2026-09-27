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

### 13.5 Supported version

The only supported and tested DSH for this project is `0.1.7-rc.2`, verified against the locally installed package
recorded above. This project does **not** claim 0.1.5 support. The 0.1.5-rc.2 captures retained under
`fixtures/dsh-turns/` remain usable as evidence about the metric arithmetic, the decoder's robustness and historical
compatibility; they are no longer evidence for the tool/result shape, settle-assistant semantics, the turn completion
lifecycle or the client event-window contract, all of which are established from the 0.1.7 declarations and the
recorded 0.1.7 corpus.
