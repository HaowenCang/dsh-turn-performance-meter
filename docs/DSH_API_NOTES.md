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

`conversation.composer.dock` is a session-scoped list slot. Native chat statistics currently register there as id `stats`, order `0`. This makes it the correct allocated layout region for this plugin.

Do not assume that taking the native `stats` id is safe. Register independently first and inspect the local slot catalog/occupants.

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
