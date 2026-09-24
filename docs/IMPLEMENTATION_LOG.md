# Implementation Log

Use this file as the running engineering record. Do not replace evidence with vague status statements.

## Environment

- Date: 2026-04-25 (local session)
- DSH version: `0.1.5-rc.2` (`@deepseek-ai/dsh`, `dsh --version` → `0.1.5-rc.2`, exit 0)
- Node version: see `node --version` recorded in the Phase 0 command transcript
- Profile: `web` at `C:\Users\20659\.dsh\profiles\web`
- DSH checkout inspected: `C:\Users\20659\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`
  (installed packages under `...\dsh\node_modules\@deepseek-ai\*`, each with `lib/*.js` + `lib/types/**/*.d.ts`)
- Project path: `E:\Projects\DSHarness\dsh-turn-performance-meter`

## Phase 0 — Local API reconnaissance

### Commands and outputs

#### 0.1 `dsh --version`

```text
0.1.5-rc.2
=== exit: 0 ===
```

#### 0.2 `dsh plugin --profile web list --depth 2`

Exit 0, 109 packages. Relevant rows:

```text
dsh-profile-web C:\Users\20659\.dsh\profiles\web (PRIVATE)
├── @dsh-external/dsh-super-injector@link:E:/Projects/DSHarness/Plugins/dsh-routing-suite/injector-release
├─┬ @linxin666/dsh-web-all@0.3.24          (community bundle: 20+ client UI plugins)
├─┬ dsh-cost-meter@1.7.33
├── dsh-vibe-usage-sync@link:E:/Projects/DSHarness/dsh-vibe-usage-sync
├─┬ dsh-watcher@0.4.1
└─┬ ... (dsh-document-selection-ask, dsh-mail-notify)
```

Consequence for this project: the profile already carries many third-party client plugins, so slot-id collisions and
composer-width pressure are real deployment conditions, not hypothetical ones. `conversation.composer.dock` currently
has exactly one shipped occupant (`stats`); no third-party occupant was observed in the static catalog.

#### 0.3 `dsh --profile web --dump-config`

The command emits a partial document and then fails. Recorded honestly:

- stdout: 704 lines, starting with `# == @deepseek-ai/dsh-base` and ending with the profile patch section
  (`wechat-notify`, `web-search-tavily`, `mcp-chrome`, `mcp-chrome-devtools`).
- stderr, before the composed document:

```text
dsh: [C:\Users\20659\.dsh\profiles\web\cordis.patch.yml] patch: entry "vision-tool" not found
dsh: [C:\Users\20659\.dsh\profiles\web\cordis.patch.yml] patch: entry "opencode-go-session-header" not found
```

- The process aborts after the dump (observed `exit: -1` through the PowerShell wrapper). The two patch entries declare
  `disabled: true` for rows that are not present in the composed graph, so the loader never creates the targeted entry
  and the patch cannot resolve it. This is a **pre-existing local profile defect, not caused by this project**, and it
  does not block plugin development. It does mean the composed config cannot be read as a single complete document and
  must be captured from stdout only.

Confirmed present in the composed graph (relevant to this plugin):

```text
- id: session-projection          name: '@deepseek-ai/dsh-session-projection'
- id: session-projection-cache    name: '@deepseek-ai/dsh-session-projection-cache'
- id: llm                         name: '@deepseek-ai/dsh-llm'
- id: llm-retry                   name: '@deepseek-ai/dsh-llm-retry'
- id: agent                       name: '@deepseek-ai/dsh-agent'
- id: api-session-controller      (web app tier)
- id: cordis-client-runner        name: '@deepseek-ai/dsh-cordis-client-runner'
- id: ui-theme / locale / ui-cordis / ui-chat … (client tier)
- id: agent-default-model         provider: deepseek-official, model: deepseek-flash
```

`tool-cordis` is **not** an enabled row in this profile.

#### 0.4 `npm run verify` (baseline, before Phase 1 edits)

```text
> dsh-turn-performance-meter@0.1.0 verify
> node scripts/verify-structure.mjs && node --test test/*.test.js

structure OK (12 required files)
✔ turn TPS is token/duration weighted, never arithmetic mean of step TPS (0.708ms)
✔ rolling curve operates on active-time samples (0.5667ms)
✔ rolling window excludes samples at or below lower boundary (0.5036ms)
✔ reset prevents live TPS from bridging LLM attempts (0.0926ms)
✔ compressed chart removes tool/inter-attempt wall gaps (0.9276ms)
✔ tool-call arguments are output, tool results are not StreamChunks here (0.4844ms)
✔ calibration preserves exact reasoning/non-reasoning aggregate totals (0.2125ms)
✔ parallel tools separate summed work from wall union (0.5476ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 144.1111
=== exit: 0 ===
```

#### 0.5 What could **not** be verified in this environment

Recorded because the Phase 0 gate forbids claiming unverified APIs:

- `cordis_inspect what:"client"` does not exist in `0.1.5-rc.2`. The installed tool package exposes three different tools —
  `cordis_inspect_list`, `cordis_inspect_query`, `cordis_inspect_self` — and the whole tool is unavailable here because
  `tool-cordis` is not an enabled row. **No live inspect query was executed.**
- Browser-side confirmation was attempted and failed: the Chrome DevTools MCP call (`list_pages`) timed out, the
  alternative Chrome MCP (`get_windows_and_tabs`) could not connect to its MCP server, and
  `Invoke-WebRequest http://127.0.0.1:50001/` returns **HTTP 401** (the GUI requires a token). Therefore the running page
  could not be inspected.

What replaces it is static, but authoritative and version-matched: the shipped client bundle contains a **generated
compile-time slot catalog** whose own doc comment states it is exactly what `cordis_inspect` serves to the model:

```text
packages/client/.../dsh-cordis-client-runner/lib/types/client/slot-catalog.d.ts:6-8
  "The compile-time contract of the shipped web bundle's slot surface, as
   `cordis_inspect what:"client"` serves it to the model"
packages/.../dsh-cordis-client-runner/lib/client.js:2201   const CLIENT_SLOT_API = [ …
packages/.../dsh-cordis-client-runner/lib/client.js:4745   const SLOT_CATALOG = new Map(CLIENT_SLOT_API.map(…))
packages/.../dsh-cordis-client-runner/lib/client.js:4659-4686  clientInspectProviders → Slots.listSubTree
                                                               reads ctx.get("slots").snapshot(root)
```

Every package that contributes the catalog is version `0.1.5-rc.2`, i.e. the same version as the installed runtime.
**Residual risk (must be re-checked at Phase 7 mount time):** the catalog is generated, so it describes the shipped
composition rather than the live registered set. The live occupant list is the only thing a real
`cordis_inspect_query`/`slots.snapshot()` would additionally confirm, and that check is deferred, not skipped.

### Slot contract — `conversation.composer.dock`

Source of truth: generated `CLIENT_SLOT_API` entry in
`@deepseek-ai/dsh-cordis-client-runner/lib/client.js:2515-2536`, cross-checked against the declaration
`@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:197-201`, the shipped render site
`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:16259`, and the shipped occupant
`@deepseek-ai/dsh-client-ui-chat/lib/client.js:8351-8355`.

| Property | Verified value |
|---|---|
| key | `conversation.composer.dock` |
| kind | `list` (ordered, additive) |
| scope | `session` |
| summary | "Ambient entries below the composer card." |
| register options | `id: string` (required) · `order?: number` (optional, ascending, default 0) · `label?: string \| (() => string)` (optional) |
| owner props | none — `renderSlot("conversation.composer.dock", {})` passes an explicit empty owner object |
| standard props | scope-derived; see below |
| declared by | the `conversation.composer.bar` entry in `client-ui-conversation`, so the seat exists while that entry is mounted |
| occupants | exactly one: `client-ui-chat StatsPills id 'stats'` |
| replace risk | **`none`** — registering a fresh id is purely additive |
| slot inject face | none |
| source pointer | `packages/client/ui-conversation/src/client/contract/slots.ts:170` |

The declaration prose in the SlotMap carries no extra contract beyond `kind`/`scope`; placement geometry comes from the
render site, where the dock is a sibling **below** the composer card and **outside** it, inside the composer stack.
Reference visual confirmation: `docs/assets/reference-live-streaming.png` shows the pill centred between the transcript
and the composer card.

Register options in the shipped runtime are described as:

```text
id:    "Your cell key. Use an id of your own: a fresh id is added beside the shipped entries,
        while reusing a shipped id puts you in THAT cell and replaces it."
order: "Position among the entries, ascending (default 0)."
label: "Display text where the owner projects one (nav rows, tabs)."
```

**Project decision:** keep the independent id `turn-performance-meter`. `replaceRisk: none` proves the additive path is
supported; there is no local evidence that taking the `stats` id is either necessary or stable, so the native stats row
stays untouched.

#### Scope-derived standard props actually injected

The framework supplies props by scope: `PropsRuntime<K> = OwnerOf<K> & KeyPropsOf<K> & SlotInjectFace<K> &
(ScopeOf<K> extends 'session' ? SessionStandardProps : …) & GlobalStandardProps`
(`dsh-cordis-client-runner/lib/client.js:1909`). For this slot the catalog lists (union across the session-scope seats):

```text
useResource: UseResource
useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
usePanelInfo: UsePanelInfo
useSessions: UseSessions
useSessionPendingInteraction: UseSessionPendingInteraction
useChat: UseChat
useConversation: UseConversation
useInput: SnapshotSelectorHook<InputState>
inputActions: InputActions
useSession: SessionSnapshotSelector
sessionId: SessionId
useProjection: UseProjection
useTrajectory: UseTrajectory
```

The catalog `standardProps` array is a union over the whole `CLIENT_SLOT_API` for that scope, so it is an upper bound.
Two entries are **independently proven** for this exact seat by the shipped occupant's own signature:

```text
dsh-client-ui-chat/lib/types/client/chat/StatsPills.d.ts
  export interface StatsPillsProps {
    useChat: SnapshotSelectorHook<ChatSnapshot>
    useProjection: UseProjection
    t: ChatViewSlotProps['t']          // locale seat
  }
```

So `useChat`, `useProjection`, `sessionId` and the locale `t` seat are available at this seat. The remaining names in the
union are unverified for this seat and must not be relied on without a live `slots.snapshot()` check.

#### Locale and theme services

- Locale: `ctx.locale` (Client Cordis service), `declare module '@deepseek-ai/cordis' { interface Context { locale: LocaleRuntime } }`
  — `@deepseek-ai/dsh-client-locale/lib/types/client/index.d.ts:55-58`. Registration API:
  `register(ns, { en, zh })` (typed, both built-in locales required) or
  `register(ns, locale, dict)` (untyped). Lookup walks the active language's fallback chain in the namespace, then the
  shared `common` namespace, then shows the key itself. `bind(ns)` returns an identity-stable `Translate`.
  A registration **bumps the revision and notifies `LocaleFace` subscribers** but does **not** emit `locale/change`
  (lines 218-225), so dictionaries registered late are still picked up by already-mounted outlets.
  The slot option `locale: NS` is the shipped pattern (`ui-chat` passes `locale: NS`), which is how the occupant's `t`
  seat gets bound.
- Theme: `ctx.theme` (`ThemeRuntime`) — `@deepseek-ai/dsh-client-ui-theme/lib/types/client/index.d.ts:84-97`.
  Read via `getTheme(): ThemeSnapshot` (`{ preference, fontSize, active: { id, colorScheme, tokens }, themes, revision }`),
  subscribe via the `theme/change` event (documented as `@mode emit`, so plain `ctx.on`). Token layer:
  `overrideTokens(source, { tokenName: { light, dark } })` stacks an alias-layer override on top of the active theme and
  returns a disposer; both palette modes are mandatory per token. `exportInspectTokens()` returns the token directory.
  The tokens consumed by shipped UI are `--dsw-alias-*` / `--dsw-specific-*` CSS variables (observed in shipped CSS,
  e.g. `--dsw-alias-border-l1`, `--dsw-specific-tip`, `--dsw-alias-label-tertiary`).

For the live pill the reference accent is a warm orange that has no obviously equivalent host token, so the plan remains:
inherit host `--dsw-*` values wherever a suitable token exists, and declare only the output accent as a plugin token with
both `light` and `dark` values.

### Live assistant telemetry

#### Chosen local source

`@deepseek-ai/dsh-api-session-controller` Client half, hosted on `ctx.sessions` (`ISessions`):

```ts
// dsh-api-session-controller/lib/types/client/contract/sessions.d.ts
binding(id: SessionId): SessionBinding | undefined

// .../client/sessions/service.d.ts:102-110
export interface SessionBinding {
  readonly sessionId: SessionId
  readonly session: SessionFace          // ISession & ObservableSnapshot<SessionSnapshot>
  readonly eventSource: SessionEventSource
  readonly ctx: AgentContext
}
```

`SessionEventSource` is `ObservableSnapshot<SessionEventWindow>`; the shipped implementation `MutableSessionEventSource`
publishes **synchronously** on every accepted window mutation (`.../client/contract/events.d.ts:56-101`). The window is:

```ts
interface SessionEventWindow {
  readonly entries: readonly SessionEventLikeEntry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change: SessionEventChange
}
type SessionEventLikeEntry = { type: 'event'; event: SessionEvent } | { type: 'transient'; event: AssistantLiveChunkEvent }
type SessionEventChange =
  | { kind: 'replace';  entries: … }
  | { kind: 'prepend';  entries: … }
  | { kind: 'append';   entries: … }
  | { kind: 'settle-assistant'; attemptId: LlmAttemptId; entry?: SessionAssistantSettlementEntry }
```

**One source therefore carries both planes**, which is exactly what `ARCHITECTURE.md` §9 asks for.

#### Transient frame shape (browser wire)

```ts
// dsh-api-session-controller/lib/types/types.d.ts:441-468
type SessionAssistantStreamFrame =
  | { type: 'start'; attemptId; revision; startedAfterSeq; turn; step }
  | { type: 'chunk'; attemptId; revision; index; time; chunk: JsonValue }
  | { type: 'end';   attemptId; revision; index;
      outcome: { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq }
             | { kind: 'abandoned' } }
```

The browser fold (`ClientAssistantStream`, `.../client/sessions/assistant-stream.d.ts`) reduces these frames to
client-only live entries:

```ts
// .../client/contract/events.d.ts:4-16
interface AssistantLiveChunkEvent {
  readonly type: 'assistant/live-chunk'
  readonly seq: number          // orders the transient row between durable Session seqs
  readonly time: number         // ← the timestamp the live meter and the curve need
  readonly data: {
    readonly attemptId: LlmAttemptId
    readonly turn: number
    readonly step: number
    readonly chunk: StreamChunk
  }
}
```

Four consequences that change the design relative to the scaffold:

1. **`time` is on the entry, not on `data`.** The scaffold's adapter sketch treated the chunk as carrying its own time.
2. **Turn and step are on `data`, not on a separate start frame.** The transient plane gives identity plus timestamp in
   one value.
3. **No `end`/`abandoned` transient is published to the client.** The fold converts `end` into either a durable
   settlement (`settle-assistant`, carrying `assistant/message`/`assistant/attempt`) or a bare abandonment. Retry and
   abandonment therefore have to be derived from durable events, not from a transient end frame.
4. **`outcome.kind: 'abandoned'` exists on the wire** even though it is not published as an entry — so a new `attemptId`
   arriving without a settlement is a real and expected condition.

`StreamChunk` (verified at `dsh-llm/lib/types/types.d.ts:359-389`) is exactly:

```ts
| { type: 'block-start'; index; blockType }
| { type: 'text-delta'; index; text }
| { type: 'reasoning-delta'; index; text }
| { type: 'tool-call-delta'; index; id: ToolCallId; name?; argumentsDelta }
| { type: 'block-end'; index; block: ContentBlock }
| { type: 'usage'; usage: TokenUsage }        // ← usage can also arrive in-stream
| { type: 'finish'; reason; replayState? }
```

`usage` being a chunk variant matters: for a live attempt, an authoritative usage object may become available **inside the
stream**, before the durable settlement. The design must accept usage from both places without double counting.

`dsh-llm` also ships `isTokenDelta(chunk)` and `runFirstTokenTime`/`assistantStreamFirstTokenTime` helpers
(`dsh-llm/lib/types/assistant-stream.d.ts:72-116`) whose first-token predicate is

```text
"true for a non-empty text, reasoning, or Tool-call arguments fragment and for every
 name-bearing Tool-call delta; false for block, usage, and finish chunks"
```

That is the local definition of "first generated delta" and it matches `METRICS_SPEC.md` §4. This plugin reimplements the
predicate in `src/core` rather than importing it — see the module-table finding below.

#### Reconnect / baseline behaviour

`SessionFollowRequest.assistantStream?: true` opts the follow connection into process-local frames
(`types.d.ts:417-422`), and the opening snapshot carries a compact detached prefix:

```ts
interface SessionAssistantStreamAttempt {
  readonly attemptId; readonly startedAfterSeq; readonly turn; readonly step;
  readonly nextIndex: number
  readonly stream: readonly JsonValue[]     // compact detached stream at this opening revision
}
interface SessionAssistantStreamBaseline { readonly revision: number; readonly activeAttempt?: SessionAssistantStreamAttempt }
```

`ClientAssistantStream.replace(entries, baseline?)` returns "immediately visible durable entries plus reconstructed
transient chunks". So a reload mid-turn yields a reconstructed partial stream rather than nothing. The reconstructed
chunks carry reconstructed times (`expandAssistantStream` throws on an invalid reconstructed timestamp,
`assistant-stream.d.ts:65-71`), which is enough for phase shape but **not** enough to re-derive the live 1-second window
for a turn that was already streaming before the reload. Live TPS for a turn whose first delta predates the reload is
therefore provisionally `unavailable` rather than reconstructed — to be confirmed against a real reload in Phase 6.

### Durable turn/tool telemetry

Source: `@deepseek-ai/dsh-session/lib/types/types.d.ts`.

```ts
interface SessionEvent<T> { type: T; seq: SessionSeq; time: number; data: SessionEventMap[T]; ignorable?: true }

SessionEventMap {
  'turn/start':      { turn: number }
  'turn/end':        { turn: number; reason: TurnEndReason }
  'step/start':      { turn: number; step: number }
  'step/end':        { turn: number; step: number }
  'assistant/message': { turn; step; message: AssistantMessage
                         stream: AssistantStreamRecord[]      // exact timed model stream
                         usage?: TokenUsage                   // absent when the adapter reported none
                         interrupted?: true }
  'assistant/attempt': { turn; step; stream: AssistantStreamRecord[] }   // settled attempt with no surface message
  'tool/call':       { turn; step; callId: ToolCallId; name: string; arguments: string }   // raw JSON string
  'tool/result':     { turn; step; message: ToolResultMessage; error?: { name; code }; meta?: JsonValue }
  'user/message' | 'system/message' | 'request/header' | 'request/context' | 'session/end-seed' | …
}
```

`TurnEndReason` is a merge-extensible union with kinds `completed`, `aborted` (`reason: TurnEndCancelCause` =
`{kind:'user'|'parent'|'hook'|'disposed'}` or `{kind:'legacy'}`), `blocked`, `error` (`error: LlmFailure`),
`max-tokens`, `interrupted` (crash-orphaned turn closed after the fact).

Status mapping this project will implement (Phase 2):

| `turn/end.reason.kind` | card status |
|---|---|
| `completed` | `completed` |
| `aborted` | `interrupted` |
| `interrupted` | `interrupted` (crash-orphan) |
| `blocked`, `error` | `errored` |
| `max-tokens` | `completed` with a truncation note on the secondary line |

Timestamps are **event-envelope** times: `turn/start.time`, `tool/call.time`, `tool/result.time`, `turn/end.time`. The
`data` payloads carry no time of their own. This is what makes TTFT, per-tool latency, `toolWorkMs` and `toolWallMs`
derivable from durable evidence alone.

#### The single most valuable finding: `AssistantStreamRecord` is a compact *timed* delta run

```ts
// dsh-llm/lib/types/assistant-stream.d.ts:16-40
type AssistantStreamRecord =
  | { type: 'text-chunks';      time0: number; index: number; dt: readonly number[]; texts: readonly string[] }
  | { type: 'reasoning-chunks'; time0: number; index: number; dt: readonly number[]; texts: readonly string[] }
  | { type: 'tool-call-chunks'; time0: number; index: number; dt: readonly number[]; id: ToolCallId; name?: string
                                args: readonly string[] }
  | { type: 'chunk'; time: number; chunk: StreamChunk }
```

Its own doc comment states the durable `assistant/message` event "embeds their exact compact raw streams so persistence
stores one durable settlement per attempt". `expandAssistantStream(stream)` reconstructs "detached timed chunks with
**every original delta boundary preserved**".

This is decisive for the Phase 5 curve: **the exact intra-stream delta spacing survives into the durable log**, so the
mandatory compressed-time curve with real intra-stream stalls can be rebuilt from durable evidence after a reload,
without depending on the transient plane at all. `dt` is understood to be per-member offsets from `time0`; the exact
accumulation rule (cumulative vs. per-step) must be confirmed against `expandAssistantStream`'s implementation or a
captured fixture in Phase 2, and is recorded as an open item below.

#### Token usage location and semantics

```ts
// dsh-llm/lib/types/types.d.ts:136-150
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number        // exact full-call total, omitted when unavailable or inconsistent
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number    // documented as already included in outputTokens
}
```

Local document text confirms the public note: the field doc for the input side says adapters whose providers fold cache
hits into a total prompt count ("DeepSeek's `prompt_tokens`") subtract them out. Reached by this plugin at exactly two
places: `assistant/message.usage` (durable) and the in-stream `usage` chunk (transient).

`reasoningTokens` is **optional at every layer**. Nothing in the installed runtime guarantees the DeepSeek adapter reports
it for a given route, so the "missing `reasoningTokens`" fixture is a first-class path, not an edge case.

#### Existing statistics that must not be misused

- `@deepseek-ai/dsh-session-stats` is installed; `StatsPills` prefers the `sessionStats` projection and falls back to
  `deriveStats(nodes)` over the visible window. Both are **whole-session** scopes and are therefore explicitly not this
  plugin's data source (`ARCHITECTURE.md` §12).
- `AssistantTiming` in the conversation record contract carries `stepStartTime`, `firstTokenTime`,
  "First non-empty text/reasoning/tool delta timestamp, or null when no token delta was recorded", and `completedTime`
  (`.../contract/records.d.ts:53-61`). This is per-step, window-limited (`stepStartTime` is `null` when outside the
  current window), and folds several attempts into one node — it cannot express per-attempt identities, so it is a
  fallback cross-check, not an authority.

### Host→client telemetry seam

**Decision: a client-side read model built in the plugin's browser half from
`ctx.sessions.binding(sessionId).eventSource`, which already carries the durable `SessionEvent` plane and the transient
`assistant/live-chunk` plane in one synchronously-published window with `change` deltas. No Host half is required for
telemetry, and no new projection key is registered.**

**Evidence.**

1. The window carries both planes with distinct discriminants (`type: 'event'` vs `type: 'transient'`), and the transient
   entry already carries `time`, `attemptId`, `turn`, `step` and the expanded `StreamChunk`. Everything the live meter,
   TTFT and phase accounting need is present in one structure.
2. Publishing is synchronous per mutation, so a 100–250 ms render throttle is a UI concern, not a transport concern.
3. `change.kind` gives `append` vs `settle-assistant` vs `replace`, which is exactly the discrimination the state machine
   needs for "new entry" vs "an attempt just settled" vs "the window was rebaselined (reload/reconnect)".
4. Durable `assistant/message.stream` carries the timed delta runs, so the completed card and the curve do not depend on
   anything transient having been observed live.
5. `ctx.sessions` is proven injectable by a client plugin: `ui-chat` declares `const inject = ['slots','sessions',
   'uiSession','uiConversation','locale','settingsScope','remote','remote.session','sidebarRight']` and resolves
   `ctx.sessions.binding(sessionId)` inside its own `apply`
   (`dsh-client-ui-chat/lib/client.js:8233-8243`, `:8263-8280`).
6. It is supported by a first-party package that is present in the browser module graph: `dsh.client.inject` of
   `ui-conversation` and `ui-chat` both list `@deepseek-ai/dsh-api-session-controller`, and that package's own manifest is
   `dsh.client = { external: ['@deepseek-ai/dsh-api-gateway/client'], inject: ['@deepseek-ai/dsh-api-gateway'],
   platform: 'web' }`.

**Rejected alternatives.**

- **Host-owned telemetry with a plugin-owned session projection** (`ctx.sessionProjections.register`, verified at
  `@deepseek-ai/dsh-session-projection/lib/types/index.d.ts`). Rejected on mechanism, not taste: the registry's drive is
  defined as "subscribes to `session/event` once; every committed event passes every registered unit's `apply`", the unit
  contract states "All functions MUST be synchronous" and "`state` MUST be plain JSON", every client value is published
  with `seq` = "the unit's watermark at emission (the seq of the event that caused the change)", and the client store
  accepts a value only when its seq does not regress. A registered unit therefore **cannot** publish at 100–250 ms
  cadence, and it cannot see transient assistant chunks at all. Producing live TPS through it would require appending
  synthetic session events to the durable log — a direct violation of "do not modify DSH core" in spirit and of the
  durable/transient split in `DSH_API_NOTES.md` §4. It would also make this plugin's live numbers depend on
  `session-projection-cache` write cadence (`writeEveryEvents: 200`, `writeIntervalMs: 5000` in the composed config).
- **Host half tailing the session log and pushing over a private socket.** Rejected: it re-implements a transport DSH
  already ships, adds a Host half that must be disposed correctly across HMR, and still cannot see transient frames.
- **Reading `sessionStats` / `tokenUsage` projections.** Rejected by scope: both are whole-session aggregates, and the
  frozen requirements forbid substituting them for turn data.
- **Polling or DOM scraping.** Rejected by the engineering rules and unnecessary given (1).

Consequence for the Host half: `index.js` remains a no-op plugin. It stays in the bundle because the manifest shape
(`dsh.bundle.patch` + `cordis.patch.yml`) needs the host row to exist, but it registers no listeners, holds no state, and
must not duplicate any formula.

### Client plugin loading mechanism and the browser module table

- Loading contract: a browser bundle only **registers** a factory —
  `window.__ModuleLoader__.load({ id, factory })` — and every module-body side effect, CSS injection included, must live
  inside the factory closure and run at materialization, not at script execution
  (`@deepseek-ai/dsh-client-modules/lib/types/client/manifest.d.ts:9-20`, `:147-157`). The scaffold already follows this.
- `require` inside a factory resolves through a fixed branch order: **seed word → already-materialized record →
  registered graph row factory → throw** (`manifest.d.ts:18-20`, `ClientModuleSystem.makeRequire` doc).
- The seed table is a hard-coded object in the shipped shell bundle
  (`dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`):

```js
function by(){return{
  react: …,
  "react/jsx-runtime": …,
  "react-dom": …,
  "react-dom/client": …,
  "@deepseek-ai/cordis": …,
  "@deepseek-ai/dsh-client-store": …,
  "@deepseek-ai/dsh-client-ui-slots": …,
  "@deepseek-ai/dsh-client-ui-primitives": …,
  "@deepseek-ai/dsh-client-ui-dockkit": …
}}
```

- Everything else must arrive as a graph row. Graph rows are built from `dsh.client` declarations, and a package's own
  `dsh.client.inject` list names the packages that must arrive before it.
- **`@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-session` declare no `dsh.client` at all** (their `package.json` has no
  `dsh` field), so they are host-only packages. Their subpath modules (`dsh-llm/assistant-stream`, `dsh-session/types`)
  are **not** requireable from a browser bundle.

Direct consequences for this project:

1. `require('react')` is correct and mandatory — React comes from the seed table, and no second React may be bundled.
2. The plugin must **not** `require` anything from `@deepseek-ai/dsh-llm` or `@deepseek-ai/dsh-session`. In particular
   `expandAssistantStream`, `isTokenDelta` and `assistantStreamFirstTokenTime` must be reimplemented in `src/core`.
   This is convenient as well as necessary: `ARCHITECTURE.md` (and the project rules) require exactly one copy of the
   statistical formulas, so reimplementing them in `src/core` and unit-testing them satisfies both constraints.
3. `@deepseek-ai/dsh-client-ui-slots` and `@deepseek-ai/dsh-client-store` are **type-only in the installed tree** — no
   package directory exists under the checkout's `node_modules`; they exist solely as an ambient merge target in other
   packages' `.d.ts` files and as seed-table entries at runtime. This is why the project stays plain JavaScript with
   JSDoc: there is nothing local to type against, and no runtime dependency to declare.
4. The client package-dependency list belongs in `package.json` `dsh.client.inject` (package names), while the service
   list belongs in the exported plugin object's `inject` (service keys). The scaffold conflated neither, but its
   `dsh.client.inject` is too narrow and needs `@deepseek-ai/dsh-api-session-controller` added.

### Deviations from public-master notes

| Item | Public note (`DSH_API_NOTES.md`) | Local behavior (`0.1.5-rc.2`) | Action |
|---|---|---|---|
| Inspect tool name | "If available … `cordis_inspect` `what:"client"`" | Three tools: `cordis_inspect_list`, `cordis_inspect_query`, `cordis_inspect_self`; the whole tool is disabled in this profile (`tool-cordis` not an enabled row) | Static catalog used instead; live `slots.snapshot()` check deferred to Phase 7 and recorded as a residual risk |
| `AssistantStreamFrame` | `start {attemptId, revision, turn, step}` / `end {…, outcome: committed \| abandoned}` | Adds `startedAfterSeq` on `start`; `outcome` is an object: `{kind:'committed', eventType:'assistant/message'\|'assistant/attempt', seq}` or `{kind:'abandoned'}` | Adapter must read `outcome.kind`, and `eventType` tells which durable event settles the attempt |
| Client live-chunk access | "the client fold materializes transient `assistant/live-chunk` events carrying `time`, `turn`, `step`, and `chunk`" | Correct, and now exact: `{type:'assistant/live-chunk', seq, time, data:{attemptId, turn, step, chunk}}` | Adapter reads `entry.time` and `entry.data.*`; scaffold sketch corrected |
| Where live chunks come from | "conversation/session data … smallest supported seam" | `ctx.sessions.binding(id).eventSource` (`SessionEventSource = ObservableSnapshot<SessionEventWindow>`), proven injectable | This is the chosen seam |
| Token usage location | "provider usage … aggregate usage" | Two local carriers: `assistant/message.usage?: TokenUsage` (durable) **and** a `StreamChunk` variant `{type:'usage', usage}` (in-stream) | Adapter accepts both; must not double count |
| Timed delta evidence for the curve | not stated | `AssistantStreamRecord` compact runs (`time0` + `dt[]` + `texts[]`/`args[]`) embedded in the durable settlement, "every original delta boundary preserved" | Curve can be rebuilt from durable evidence after reload; `dt` accumulation rule to be confirmed in Phase 2 |
| Chat record timings | "`AssistantMessageNode` … timing with `stepStartTime`, `firstTokenTime`, `completedTime`" | Correct; `AssistantTiming` also documents `firstTokenTime` as "first non-empty text/reasoning/tool delta timestamp" | Used only as a cross-check; `stepStartTime` is `null` outside the current event window, so it cannot be authoritative |
| `turn/end` reason | not enumerated | `TurnEndReasonMap`: `completed` \| `aborted{reason}` \| `blocked` \| `error{error: LlmFailure}` \| `max-tokens` \| `interrupted` | Status mapping table above adopted; `max-tokens` maps to `completed` with a note |
| Session projection as a telemetry seam | listed as preferred option 1 "if local DSH provides a clean plugin-owned session projection/resource seam usable for transient updates" | The projection registry is committed-event-driven, synchronous, seq-watermarked; it is **not** usable for transient updates | Option 1 rejected on evidence; option 2 adopted |
| Browser module table | "React comes from the DSH browser module table" | Confirmed, and the full seed is only 9 words: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit` | `dsh-llm` / `dsh-session` helpers may not be imported; reimplement in `src/core` |
| Type packages | implied available | `@deepseek-ai/dsh-client-ui-slots` and `@deepseek-ai/dsh-client-store` have **no installed package directory** in the checkout | Stay plain JS + JSDoc; no TypeScript build for the client half |
| Local plugin install | `dsh plugin --profile web add file:…` | Not exercised this round (no profile mutation performed) | Deferred to Phase 7 |

### Phase 0 acceptance gate

No production integration code was written against an unverified API assumption. Every API named above is backed by an
absolute path in the installed `0.1.5-rc.2` tree, and the two facts that could only be confirmed by a live page
(current occupant roster, exact per-seat standard-prop set beyond `useChat`/`useProjection`/`sessionId`/`t`) are recorded
as explicit residual risks with the command that would close them.

## Phase results

### Phase 1

Complete. `npm run verify` → `exit 0`, **110 tests / 0 failures** (12 test files). The full command and output are
recorded below.

#### What was added or corrected

| File | State | Substance |
|---|---|---|
| `src/core/delta-accounting.js` | **new** | Single implementation of the DSH delta predicate (`isTokenDelta` parity), `classifyDelta`, `deltaText`, `usageFromChunk`, and `expandAssistantStream` for the compact durable runs. Reimplemented rather than imported because `@deepseek-ai/dsh-llm` declares no `dsh.client` manifest and is therefore not requireable from a browser bundle. |
| `src/core/phase-duration.js` | **new** | The normative interval-attribution policy from METRICS_SPEC §7, with the trailing-settlement-interval branch explicitly omitted and the reason documented. |
| `src/core/live-metrics.js` | **new** | `LiveMeter` — per-attempt rolling window, TTFT-once rule, tool-phase suppression of TPS, and the pending/streaming/tool/settled presentation state machine. |
| `src/core/metric-quality.js` | rewritten | Added `isMetricQuality`, `rateQuality` (partial denominators can never be `exact`), and made an unknown quality degrade to `unavailable` rather than silently to `exact`. |
| `src/core/sliding-window.js` | hardened | `beginAttempt` epoch method, `isEmpty`/`size`/`newestTimeMs`, `addAll`, finite-input validation on `value(nowMs)`. Boundary semantics and the "future samples retained but not counted" rule are now asserted. |
| `src/core/token-allocation.js` | rewritten | Calibration now returns a structured result (`phaseTokens`, `totalQuality`, `splitQuality`, `totalAnchored`, `note`). **Fixed a real specification violation:** the previous `calibrateAttemptSamples` returned samples untouched when `reasoningTokens` was absent, leaving `tokens === weight` with `quality: 'estimated'` and never anchoring the total. It now rescales the whole attempt by one factor so the integral equals the authoritative `outputTokens`, while the reasoning/output split stays `estimated`. Also removed a dead `byIdentity` map. |
| `src/core/tool-timing.js` | hardened | `runningCount`/`cancelledCount`/`names`, null-record tolerance, and `workMs >= wallMs` asserted. |
| `src/core/time-axis.js` | rewritten | Now also returns `segments`, so the curve can show where attempt boundaries land. |
| `src/core/curve.js` | extended | Added `downsampleSeries` (extrema- and endpoint-preserving, bounded point count) and rejected non-positive window/cadence instead of producing infinite TPS. |
| `src/core/aggregate-turn.js` | rewritten | Split `isContributingAttempt` from "emitted no delta", added `observedGeneratedTokens` (partial sum) beside `generatedTokens` (exact-or-`null`), explicit `usageComplete`/`splitComplete`/`shapeTokens`, and a documented refusal to publish a turn-level TPS whose numerator or denominator is incomplete. |
| `src/core/turn-state.js` | rewritten | `settleFromTurnEndReason` implementing the verified `turn/end.reason` vocabulary, including `max-tokens` → `completed` with a note and an unknown-future-kind fallback that does not claim a known cause. |
| `src/core/types.js` | rewritten | JSDoc records aligned to the verified DSH shapes plus `turnKey(sessionId, turn)`. |
| `src/host/telemetry-design.js` | rewritten | `TurnTelemetryStore` with `(sessionId, turn)` keys, one `LiveMeter` **per session**, idempotent `beginTurn` (a replayed durable `turn/start` must not discard samples), attempt/tool pairing by id, bounded history, and `dispose()`. |
| `src/client/ui-model.js` | rewritten | Live/completed view models over the finalized core snapshots; asserts the four fixed columns and keeps tool statistics on the detail line. |
| `src/client/format.js` | rewritten | Absent evidence renders `—`; quality is deliberately **not** baked into the formatted string. |
| `src/client/styles.js` | rewritten | Host `--dsw-*` alias tokens for everything except the output accent; `prefers-reduced-motion` handled. |
| `package.json` | corrected | `dsh.client.inject` widened to `@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-client-locale`, `@deepseek-ai/dsh-client-ui-conversation` — the three packages whose services this plugin injects. |
| `scripts/verify-structure.mjs` | extended | Now also fails when a `src/core` module has no matching test and when a local import in `src/` does not resolve. |

Two behaviours were changed on evidence rather than on taste, and both are worth remembering: an attempt whose
reasoning and output deltas share a timestamp has **no** measurable output interval (the whole gap is charged to the
earlier phase), and a new `attemptId` may legitimately arrive while a tool is still running — the phase then stays `tool`
until the last tool settles, which is why the "new attempt starts from an empty window" assertion had to settle the tool
first.

#### Command and result

```text
$ npm run verify

> dsh-turn-performance-meter@0.1.0 verify
> node scripts/verify-structure.mjs && node --test test/*.test.js

structure OK (14 required files, 12 core modules, 12 test files)
✔ … 110 tests …
ℹ tests 110
ℹ suites 0
ℹ pass 110
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 217.5466
=== exit: 0 ===
```

The 110 individual test names and timings are reproduced in the round report; the suite covers the fixtures required by
`TEST_PLAN.md` §1–2 (A single call, B reasoning+text, C tool-heavy, D multi-call with a long tool wait, E parallel tools,
F retry-shaped attempts, G interruption, H missing `reasoningTokens`, J cross-session isolation) plus the Phase 1 edge
cases named in `TASKS.md`: one-delta attempts, simultaneous timestamps, zero duration, missing usage, missing
`reasoningTokens`.

#### Remaining risks after Phase 1

1. `heuristicTokenWeight` is a shape prior, not a tokenizer. Every live number and every curve point is `estimated` until
   calibration; this is by design and is asserted, but it means the live pill is never provider-exact.
   **Resolved in Phase 2:** the quality model now has a per-axis ceiling, so a shape prior can never be published as
   `exact` — `temporalShapeQuality` cannot exceed `reconstructed` (see §2.7).
2. `attributePhaseDurations` excludes the trailing interval to settlement. If a later Phase 2 fixture shows that
   `assistant/message.time` (or a stream `finish` chunk time) tracks decode rather than host commit, the policy should be
   revisited, because the current choice slightly **under**-counts generation time for very short final tails.
   **Resolved in Phase 2:** ten real attempts show the settlement trailing the stream's own `finish` chunk by 1–8 ms and a
   tail that does not scale with generation length, so the omission is now a measured decision rather than a fallback
   (see §2.6).
3. `downsampleSeries` guarantees that extrema survive, but on a pathological series whose local extrema alone exceed the
   budget it thins uniformly and can drop a non-extremum peak plateau. The `peakTps` value shown is computed from the
   **full** series before downsampling, so the displayed peak stays correct even then. **Still open.**
4. `LiveMeter` rejects a sample whose `attemptId` differs from the active one. If DSH ever publishes chunks whose
   `data.attemptId` is absent, the adapter must supply one, or the guard silently accepts everything — the Phase 2
   adapter must therefore fail loudly on a missing `attemptId` rather than passing `undefined`.
   **Resolved in Phase 2:** `LiveTurnAccumulator.acceptDelta` reports `frame-without-attempt-id` and refuses the frame
   instead of admitting it under an undefined identity.

### Phase 2

Complete. `npm run verify` → `exit 0`, **201 tests / 0 failures** (21 test files). The five recorded turn fixtures and four synthetic derivatives reproduce every assertion offline, with no DSH process.

#### 2.1 Real turn fixtures: how they were captured, and why it had to be this way

The durable and transient planes are not equally recoverable. `session/event` is persisted; `agent/assistant-stream` frames exist only in the running host process and are never written to disk. The durable `assistant/message.stream` is a *different representation* of the same evidence, so deriving the "live" side of an equivalence test from it would compare a thing with itself and prove nothing. A host-side recorder was therefore the only way to obtain real transient frames.

`dev/fixture-recorder` (package `@dsh-external/dsh-turn-meter-fixture-recorder`) is that recorder:

```text
ctx.on('session/event', (session, event) => …)                    → raw durable row
ctx.on('agent/assistant-stream', ({agent, frame}) => …)           → raw transient row
```

It writes append-only JSONL under `$DSH_HOME/turn-meter-fixtures/raw`, one file per session, three row kinds (`durable`, `transient`, `meta`), with no normalization, reordering or filtering. It also registers a loopback control route on `ctx.get('webServer')` so a scenario can be launched and interrupted deterministically instead of by hand.

Two findings from building it are worth keeping:

1. **`ctx.agents.create` alone produces a bare agent.** A scenario created that way opened `turn/start`, ran `step/start` → `step/end` in 3 ms, and closed with `turn/end{completed}` — no model call, no tool, nothing. The composed agent preset supplies the tools, system prompt and model route, and only `ctx.sessionController.create()` composes it. The recorder therefore drives scenarios through `sessionController.create` + `sessionController.prompt`, the same Host seam the GUI uses.
2. **A user interruption is a real durable fact, not a simulation.** `sessionController.cancel({sessionId})` produced `assistant/message{interrupted:true}` followed by `turn/end{reason:{kind:'aborted', reason:{kind:'user'}}}`, which is exactly the fixture shape the interruption tests need.

Scenarios captured (all on `2026-04-25`, DSH `0.1.5-rc.2`):

| Fixture | Route | Prompt | Attempts | Tools |
|---|---|---|---|---|
| `t1-reasoning-tool-reasoning` | `command-goat` / `deepseek/deepseek-v4.1-flash` | two exact `pwsh` commands, then one sentence | 2 | 2 × `pwsh` |
| `t2-pwsh-write-edit` | `command-goat` / `deepseek/deepseek-v4.1-flash` | `write` a 3-line file, `edit` one line, `pwsh` read it back, then one sentence | 4 | `write`, `edit`, `pwsh` |
| `t3-interrupted-mid-reasoning` | `command-goat` / `deepseek/deepseek-v4.1-flash` | "write ≥1200 words", cancelled 9 s in | 1 | — |
| `t4-reasoning-tool-deepseek-official` | `deepseek-official` / `deepseek-v4-pro` | one `pwsh` command, then one sentence | 2 | `pwsh` |
| `t5-reasoning-text-deepseek-official` | `deepseek-official` / `deepseek-v4-pro` | a five-step technical explanation | 1 | — |

`dev/harvest-fixtures.mjs` selects and reshapes the raw recordings into `fixtures/dsh-turns/<name>.json`; `dev/mutate-fixtures.mjs --write` writes `fixtures/derived/<name>.json`. Both copy `durable` and `transient` verbatim. `fixtures/README.md` documents the shape and the regeneration sequence.

#### 2.2 What the recordings revealed that the Phase 0 notes did not contain

| Finding | Evidence | Consequence |
|---|---|---|
| `command-goat` (the pi-ai route) never reports `reasoningTokens`, even when the model streams reasoning | `t1` step 1: `{inputTokens:4134, outputTokens:118, totalTokens:30492, cacheReadTokens:26240}` with `reasoning-chunks[28]` in the same settlement | "missing `reasoningTokens`" is the *default* condition on this route, not an edge case. `t1`, `t2` and `t3` all show it natively; `d1` adds the isolated comparison. |
| `deepseek-official` does report it, and it is an exact split | `t5`: `outputTokens=1308`, `reasoningTokens=1038`, stream `reasoning-chunks[1038] + text-chunks[269]` | The fragment count matches the provider counter exactly (1038 = 1038). This is the first direct evidence that the compact durable stream preserves per-delta structure losslessly enough to be the curve's source of truth. |
| A settlement may carry **no** `usage` object while its own stream carries an in-stream `usage` chunk | `t1` step 1 has no `data.usage`; its stream holds `{type:'chunk', chunk:{type:'usage', …outputTokens:118}}` | The two usage carriers are genuinely redundant and must be read in a defined order. The adapter prefers the settlement and falls back to the last in-stream `usage` chunk, recording which one supplied the counter (`usageSource`). |
| The durable log has **no attempt identity** | No `assistant/message` or `assistant/attempt` payload carries an `attemptId`; `t1`/`t2`/`t4` have 2–4 distinct transient `attemptId`s (`<sessionId>:<step>`) | A durable reconstruction keys attempts by settlement sequence. This is why the equivalence harness compares chart coordinates *positionally* and excludes `attemptId` from the comparison: the identity is a transient-plane fact. |
| `assistant/attempt` may still carry a recoverable counter | `d3` (converted from `t4`): the `assistant/attempt` settlement has no `usage`, but its in-stream `usage` chunk does | An abandoned attempt's real token consumption is not discarded. |
| `isTokenDelta` accepts a name-*bearing* tool-call delta with **empty** arguments | `t1` step 1: 56 of 62 decoded deltas are `tool-call-delta` with `argumentsDelta:""` and `name:"pwsh"`; `dsh-llm`'s predicate is `argumentsDelta !== '' \|\| name !== undefined` | `src/core/delta-accounting.js` was corrected to match DSH exactly. It matters because this predicate defines the first-token boundary TTFT is measured from. |

No DSH field observed in Phase 2 contradicts the Phase 0 record; the divergences above are additions to it, and each was recorded here before the implementation was changed.

#### 2.3 DSH raw evidence → normalized events

The mapping lives in exactly one place (`src/dsh/adapter.js`); nothing outside `src/dsh/` reads a DSH field name.

| DSH raw | Normalized |
|---|---|
| `SessionEvent<'turn/start'>.time` / `.data.turn` | `NORMALIZED_KIND.TURN_START` → `TurnRecord.startMs`, `.turn` |
| `SessionEvent<'turn/end'>.time` / `.data.reason` | `TURN_END` → `endMs`, `status`, `statusKnown`, `rawReason` |
| `SessionEvent<'step/start'\|'step/end'>` | `STEP_START` / `STEP_END` → step intervals |
| `SessionEvent<'assistant/message'>` | `ATTEMPT_SETTLE` → `AttemptRecord{status:'committed', usage, settlementSeq}` |
| `SessionEvent<'assistant/attempt'>` | `ATTEMPT_SETTLE` → `AttemptRecord{status:'abandoned'}` |
| `assistant/message.data.usage` | `AttemptRecord.usage`, `usageSource:'assistant-settlement'` |
| in-stream `{type:'usage', usage}` chunk | `AttemptRecord.usage`, `usageSource:'in-stream-usage-chunk'` (fallback only) |
| `AssistantStreamRecord.text-chunks` | `text-delta` chunks → `phase:'output'` samples |
| `AssistantStreamRecord.reasoning-chunks` | `reasoning-delta` chunks → `phase:'reasoning'` samples |
| `AssistantStreamRecord.tool-call-chunks` | `tool-call-delta` chunks (`name` preserved when present) → `phase:'output'` samples |
| `AssistantStreamRecord.chunk` (`block-*`, `usage`, `finish`) | raw chunks; no token sample; block boundaries and stream settlement retained |
| `SessionEvent<'tool/call'>.time` / `.data{callId,name,arguments}` | `TOOL_CALL` → `ToolCallRecord{startMs, name, argumentsRaw}` |
| `SessionEvent<'tool/result'>.time` / `.data{message,error}` | `TOOL_RESULT` → `endMs`, `status:'ok'\|'error'` |
| `AssistantLiveChunkEvent{time, seq}` / `.data{attemptId,turn,step,chunk}` | `ATTEMPT_DELTA` → `DeltaSample{timeMs, phase, weight, attemptId}` |
| `AssistantStreamFrame start/chunk/end` | `ATTEMPT_START` / `ATTEMPT_DELTA` / `ATTEMPT_SETTLE`\|`ATTEMPT_ABANDON` |
| any other event type | `IGNORED`, counted, never guessed at |

`normalizeDurableEvent(null)` and a malformed envelope both return `IGNORED`. `turn/end` with an unrecognized reason kind maps to `errored` with `statusKnown:false` rather than to a known cause.

#### 2.4 `AssistantStreamRecord` decode rules

`src/core/delta-accounting.js::decodeAssistantStream` is the strict decoder; `src/dsh/stream-decoder.js` wraps it and converts issues into quality. The rules mirror `validateRecord`/`validateRun` in `dsh-llm/lib/types/assistant-stream.js`:

| Rule | Failure kind |
|---|---|
| the record is a JSON object (not an array, not null) | `not-an-object` |
| `record.type` ∈ `{text-chunks, reasoning-chunks, tool-call-chunks, chunk}` | `unknown-type` |
| the key set is **exactly** the declared one for that type | `missing-keys` / `unexpected-keys` |
| `time0` / `time` is a safe integer | `bad-time` |
| `texts` / `args` is a string array, non-empty | `bad-members` / `empty-run` |
| `dt` is a safe-integer array with `dt.length === members.length - 1` | `bad-dt` |
| every reconstructed member time stays a safe integer | `time-overflow` |
| `tool-call-chunks.id` is a non-empty string; `name`, when present, is a non-empty string | `bad-call-id` / `bad-members` |
| a raw `chunk` record carries an object chunk | `bad-raw-chunk` |

Accumulation is DSH's own: member `i>0` occurs `dt[i-1]` ms after member `i-1`, starting from `time0`. Every delta boundary and every reconstructed timestamp therefore survives into the curve, which is what lets a reloaded page draw the same chart as the live meter did.

Behaviour on failure is split deliberately, and the split is the point:

- `decodeAssistantStream` **never fabricates a delta and never silently drops a run**. It reports every deviation with its record index, keeps the runs it could read, and marks itself `complete:false`; `time-overflow` keeps the members already produced because they are real evidence.
- `expandAssistantStream` (the pre-existing tolerant reader, used by the live path) skips what it cannot read, so one corrupt record costs one curve segment instead of the whole card.
- A decode with any issue can never be `exact`. `decodeQuality` returns `estimated`, or `unavailable` when nothing decodable remains.

All five recorded fixtures decode with **zero** issues and `quality:'exact'`; the decoder tests assert this for every settlement, and additionally assert that reconstructed times are monotonically non-decreasing in stream order.

#### 2.5 Live-vs-durable equivalence

`test/dsh-equivalence.test.js` + `test/helpers/equivalence.js` drive both paths into the **same** engine (`TurnTelemetryStore` → `aggregateTurn` → `compressAttempts` → rolling series), so a disagreement is about evidence, not about formulas.

- Path A consumes `agent/assistant-stream` frames (and, in a second variant, the client-folded `assistant/live-chunk` rows) plus durable turn/step/tool boundaries. Its `end` frame's `outcome.seq` links an attempt to its durable settlement, from which path A takes **only identity and usage** — never the stream.
- Path B consumes durable events only, decoding each settlement's compact stream strictly.

Per fixture, the comparison asserts exact equality on: turn status, attempt counts, usage/split completeness, generated/observed/reasoning/non-reasoning token totals, TTFT, turn elapsed, per-phase durations, per-attempt phase segmentation and sample counts, tool count / names / call ids / per-call durations / work / wall union / error count, model-generated tool-argument bytes, generated text bytes, compressed chart duration, segment offsets and the full coordinate sequence, and all three quality axes. Only four quantities are compared with a tolerance: `reasoningTps`, `outputTps`, `chart.peakTps` (1e-9 tokens/s, i.e. floating-point identity) and the two rolling-series integrals (1e-6, a sampled sum).

Result over the five recorded fixtures — **41/39 exact comparisons, 3–5 tolerant, 0 semantic differences each**:

| Fixture | attempts | tools | generated | reason / non-reason | TTFT | elapsed | chart span | coords | peak TPS | quality (total / split / shape) |
|---|---|---|---|---|---|---|---|---|---|---|
| `t1` | 2 | 2 × pwsh | 134 | n/a | 4420 ms | 8085 ms | 440 ms | 69 | 12.75 | exact / estimated / reconstructed |
| `t2` | 4 | write, edit, pwsh | 458 | n/a | 1968 ms | 11916 ms | 2544 ms | 340 | 206 | exact / estimated / reconstructed |
| `t3` | 1 | — | unavailable | n/a | 4980 ms | 9029 ms | 3781 ms | 715 | 262.5 | unavailable / unavailable / estimated |
| `t4` | 2 | pwsh | 151 | 74 / 77 | 7583 ms | 10581 ms | 2019 ms | 107 | 74.5 | exact / exact / reconstructed |
| `t5` | 1 | — | 1308 | 1038 / 270 | 2878 ms | 36757 ms | 33849 ms | 1307 | 84 | exact / exact / reconstructed |

A third test per fixture asserts the strongest available losslessness claim: the durable decode and the recorded transient frames contain the *same generated deltas at the same timestamps in the same order*, compared element by element. A fourth asserts that the host-frame form and the client-folded form are equivalent, which matters because a browser only ever sees the latter.

`t3` is the case that shows why status and quality are independent: it settles as `interrupted` with `tokenTotalQuality:'unavailable'` and a `null` generated total, while still publishing 715 real chart coordinates at a 262.5 peak.

#### 2.6 Generation tail duration: measured, then frozen

`node dev/measure-generation-tail.mjs` measures, per attempt, `settlement time − last non-empty model-producing delta`.

| Fixture | seq | step | deltas | span ms | tail ms | tail/span | last chunk |
|---|---|---|---|---|---|---|---|
| t1 | 16 | 1 | 56 | 430 | 9 | 0.021 | `finish` |
| t1 | 23 | 2 | 15 | 18 | 3 | 0.167 | `finish` |
| t2 | 16 | 1 | 226 | 1428 | 9 | 0.006 | `finish` |
| t2 | 22 | 2 | 46 | 417 | 3 | 0.007 | `finish` |
| t2 | 27 | 3 | 33 | 118 | 7 | 0.059 | `finish` |
| t2 | 32 | 4 | 38 | 582 | 6 | 0.010 | `finish` |
| t3 | 16 | 1 | 715 | 3781 | **260** | 0.069 | `reasoning-delta` (interrupted) |
| t4 | 18 | 1 | 102 | 1825 | 60 | 0.033 | `finish` |
| t4 | 23 | 2 | 6 | 194 | 4 | 0.021 | `finish` |
| t5 | 18 | 1 | 1307 | 33849 | **18** | 0.001 | `finish` |

Summary: 10 attempts, tails 3–260 ms, mean 37.9 ms.

**Decision: generation duration ends at the last model-producing delta. The tail is not charged.**

The evidence is that the settlement trails the *stream*, not the decode loop:

1. every normally completed attempt's last recorded chunk is the model's own `finish` chunk, and the settlement lands **1–8 ms** after it;
2. the remaining interval therefore consists of prefix assembly, durable commit and record sealing — host bookkeeping, not decode;
3. the tail does not scale with generation length. The longest attempt in the set (33 849 ms of generation, 1307 deltas) has an 18 ms tail, i.e. 0.1 %. A decode-bearing interval would grow with the stream;
4. the one large tail belongs to the **interrupted** attempt, which has no `finish` chunk at all: 260 ms to finalize a 715-fragment delivered prefix. That is the clearest possible instance of the class of work being excluded.

The cost of the decision is bounded and known: for a very short attempt the omitted tail is a larger share (the 18 ms span above would grow by 17 %), so the current policy slightly *under*-counts generation time for short final tails and never inflates throughput. The alternative — charging it — would mix host overhead into every denominator, and would distort the shortest attempts most.

`test/generation-tail.test.js` re-derives these numbers from the fixtures and asserts the streaming, the ordering, the near-constancy of the tail, the interrupted case, and the ratio argument, so the frozen policy cannot silently drift. `docs/METRICS_SPEC.md` §7 now records the same conclusion.

#### 2.7 Quality model: three axes

The single exact/calibrated/estimated label was replaced by `src/core/quality-model.js`:

```text
tokenTotalQuality     unavailable | estimated | partial | reconstructed | calibrated | exact
phaseSplitQuality     same vocabulary
temporalShapeQuality  unavailable | estimated | reconstructed   (ceiling: reconstructed)
```

Two levels were added. `partial` separates "some contributors were authoritative" from a wholesale estimate; `reconstructed` separates an anchored curve from a rough one. Both live in `src/core/metric-quality.js`'s ordering, so `weakestQuality` keeps working for legacy callers.

The ceilings are structural, not conventional: `temporalShapeQuality` can never reach `exact` because DSH attaches no token count to a delta, and `phaseSplitQuality` is clamped by `tokenTotalQuality` because a split cannot be better known than the total it divides. Both are asserted.

Verified mapping against the required semantics:

| Evidence | tokenTotal | phaseSplit | temporalShape |
|---|---|---|---|
| `t4`, `t5` — authoritative `outputTokens` + `reasoningTokens`, durable timestamps | `exact` | `exact` | `reconstructed` |
| `t1`, `t2`, `d1` — authoritative `outputTokens`, no `reasoningTokens` | `exact` | `estimated` | `reconstructed` |
| `d3`-style incomplete coverage | `partial` | ≤ `estimated` | `reconstructed` |
| `t3` — no usage at all, durable timestamps | `unavailable` | `unavailable` | `estimated` |
| live observation only | `unavailable` | `unavailable` | `estimated` |
| a contributing attempt with no delta timestamp | unchanged | unchanged | `estimated` |

Each settled snapshot now carries `quality = { tokenTotalQuality, phaseSplitQuality, temporalShapeQuality, approximateTokenTotal, approximatePhaseSplit, displayTokenTotal, displayPhaseSplit, notes }`. `displayTokenTotal`/`displayPhaseSplit` are `exact | approximate | unavailable`, computed once so no renderer has to re-derive the rule, and `approximate` is exactly the set that must render with `≈`. Live TPS is `estimated` unconditionally, so the live pill always carries the approximate marker; Phase 3 renders it, Phase 2 delivers the field.

#### 2.8 Degradation and corruption coverage

`test/dsh-degradation.test.js` covers all twelve required cases; the rule under test in every one is that insufficient evidence lowers a quality or produces `unavailable`, and is never coerced to zero or reported as exact.

| Case | Exercise | Asserted outcome |
|---|---|---|
| missing usage | settlement usage removed from one attempt of `t4` (in-stream carrier also removed) | `generatedTokens:null`, `tokenTotalQuality:'partial'`, rates `unavailable`, partial sum kept as a diagnostic |
| missing usage, all attempts | every settlement and in-stream usage removed | `observedGeneratedTokens:0` (not a fabrication), total `unavailable`, timing preserved |
| missing `reasoningTokens` | `d1` (t5 with the counter stripped) | total `exact` at 1308, split `estimated`, anchored integral still 1308 |
| a phase total with no deltas of that phase | reasoning runs stripped from `t4` step 1 | `splitQuality:'unavailable'`, `calibration.note` names the missing phase, provider counter still reported |
| missing delta timestamp | `{type:'chunk', time:'soon'}` | decoder reports `bad-time`, the chunk is dropped, quality degrades to `estimated` |
| missing dt | `dt.length !== members-1` | `bad-dt`, the run is skipped, other runs still decode |
| malformed compact run | 13 malformed shapes incl. `dt` mismatch, non-string member, empty run, extra/missing key, bad id/name, non-integer time, overflow | one issue each with its own kind and record index, **zero** fabricated deltas |
| duplicated transient frame | the same frame re-inserted at the same index | `duplicated-transient-frame`, not accepted, chart identical to the clean run |
| out-of-order transient frame | one frame removed so the next arrives with `index` ahead of `expected` | one `out-of-order-transient-frame` naming index and expected, quality degrades |
| unmatched tool/result | `d4` | `unmatched-tool-call` reported, the call counts as seen but not completed, no duration invented, `workMs >= wallMs` preserved |
| abandoned attempt | `d3` | status `abandoned`, settlement type `assistant/attempt`, no surface `message`, deltas kept as generation time |
| retry | `t1`'s two attempt epochs | both attempts keep their own identity and samples; no window spans the tool gap |
| interrupted turn | `t3` | `interrupted` on both paths, no usage claimed, `displayTokenTotal:'unavailable'`, partial stream retained |
| zero-token / empty delta | every fragment emptied, including tool-call names | no sample, attempt stops contributing, boundaries still decoded |
| concurrent tools | second call shifted to overlap the first | `workMs` = sum, `wallMs` < `workMs`, union ≥ longest call |

Two further cases protect against regressions that would be invisible in the numbers: a lost live frame is reported and the durable plane still recovers the delta (which is why the durable reconstruction remains the authority after a reload), and the live path never reads a settlement's compact stream — asserted by checking that its accepted sample count equals the recorded transient generated-frame count exactly.

#### 2.9 Phase 2 acceptance gate

| Requirement | Status |
|---|---|
| no running DSH needed; all fixture tests reproduce offline | met — `node --test` reads only `fixtures/**` |
| `npm run verify` fully passes | met — `exit 0`, 201 tests, 0 failures |
| live/durable equivalence tests all pass | met — 5 fixtures × 4 assertions, 0 semantic differences |
| `IMPLEMENTATION_LOG.md` records fixture provenance and results | this section |
| generation tail duration decided with evidence | §2.6 |
| heuristic live TPS quality decided | §2.7 — live is always `estimated`/`approximate`; no per-delta provider count exists, and no tokenizer is assumed |
| Phase 3 UI not started | met — no production UI change; only the data fields were added |

#### 2.10 Residual risks entering Phase 3

1. **Transient frames were captured host-side, not browser-side.** `agent/assistant-stream` and the client-folded `assistant/live-chunk` row carry the same `attemptId`, `index`, `time` and `chunk`, and a test asserts the two forms produce identical metrics; what has *not* been observed live is the browser transport itself (its `seq` ordering and its rebaseline path). Phase 7 must re-check against the running page.
2. **The `t4` step-2 settlement reports `{outputTokens:7, reasoningTokens:0}` with six generated deltas.** `reasoningTokens:0` next to a non-zero reasoning run is consistent (the run's fragments are tool-argument and reasoning-free), but it is a counter edge case worth watching: a provider that reports `reasoningTokens:0` while a reasoning run exists would make the split `exact` on a shape that disagrees. No such case appeared in the recordings.
3. **A tool-only turn and a tool error are not in the fixture set.** `d4` covers an unmatched call, and the unit tests cover error status, but no recorded turn consists solely of tool calls with an empty final answer. Phase 6 should record one.
4. **A retry caused by a provider failure was not reproduced** (no safe way to force one locally). `d3` reproduces the durable *shape* of an attempt that committed no surface message; the live `agent/request-error` retry path is untested.
5. **Reload-mid-turn is still unverified.** The Phase 0 note stands: the reconnect baseline carries reconstructed times, so the live 1-second window for a turn already streaming before a reload remains provisionally `unavailable`. Phase 6 owns this.
6. **The recorder is still injected in the local `web` profile** (a dev-only entry, no `dsh.client`). It should be uninjected after Phase 5 if no further fixtures are needed; it does not affect the plugin bundle.
7. **`d2` did not test what it was built to test.** Removing the settlement usage carrier left the in-stream `usage` chunk as an authoritative source, so the turn total stayed exact. That is the correct behaviour, but it means the "partial coverage" quality level is currently exercised only through `d3`-style and hand-patched cases; a fixture with genuinely partial coverage would be better evidence.

### Phase 3

Complete. `npm run verify` → `exit 0`, **260 tests / 0 failures** (28 test files). The live meter is mounted in the
real local DSH `0.1.5-rc.2` web client against `ctx.sessions.binding().eventSource`, and its full state machine was
exercised in live turns (no-tool, pwsh, multi-tool, long-streaming) with screenshot and timestamped DOM evidence.

#### 3.1 Baseline at start

```text
DSH version        0.1.5-rc.2 (dsh --version, exit 0)
npm run verify     201 tests / 0 failures / 21 test files (Phase 2 gate intact)
repository status  NOT a git repository — `git status` reported
                   "fatal: not a git repository (or any of the parent directories): .git"
                   (recorded honestly; handled in §3.11)
dsh plugin list    exit 0, profile `web`, same 109-package tree as Phase 0
```

The starting baseline passed, so Phase 3 proceeded. The missing git repository was the only baseline anomaly; it
does not affect tests and was closed at the end of this phase (local repository created, committed, GitHub blocked
only by the absence of a confirmed remote — see §3.11).

#### 3.2 Preflight semantic audit A — `assistant/attempt` is not an abandonment

Re-verified against the installed runtime before any UI work:

| Question | Local 0.1.5-rc.2 answer | Source |
|---|---|---|
| what `assistant/message` is | the surface settlement; a cancelled turn finalizes its delivered prefix as this event with `interrupted: true` | `dsh-session/lib/types/types.d.ts:299-317` |
| what `assistant/attempt` is | "One model attempt that committed **no surface message** … a **failed, retried, cancelled, or stream-error** attempt that reached **settlement**" — a durable settlement, not an abandonment | `dsh-session/lib/types/types.d.ts:318-327` |
| where `abandoned` comes from | only `AssistantStreamFrame.end.outcome.kind === 'abandoned'` — "live abandonment without one [durable settlement]" | `dsh-agent/lib/types/runtime-types.d.ts:123-137` |
| who appends `assistant/attempt` | the loop on (a) abort with no delivered content, (b) mid-stream error, (c) `finish.kind` `error`/`aborted` before the `agent/request-error` waterfall | `dsh-agent-loop/lib/index.js:1045-1098` |
| `llm/retry` semantics | durable, non-surface, appended **after** the failed attempt settled, naming the same turn/step; invariant-checked; "records scheduling, not completion" | `dsh-llm-retry` README + `lib/invariant.js` |

Model correction implemented: the single `status` string was split into `settlementKind`
(`message`/`attempt`/`none`), `surfaceCommitted` (boolean) and `attemptOutcome`
(`committed`/`interrupted`/`failed`/`retried`/`cancelled`/`stream-error`/`abandoned`/`unknown`) on every
`AttemptRecord`, on the normalized `ATTEMPT_SETTLE` event, and in the adapter vocabulary
(`SETTLEMENT_KIND`, `ATTEMPT_OUTCOME`, `settlementClassification`, `transientEndClassification`).
`assistant/attempt` now derives `attemptOutcome: 'unknown'` — never `abandoned` — and is upgraded to `retried` only
when a durable `llm/retry` naming the same turn/step provably follows it (`applyRetryOutcomes`, idempotent, wired
into both the durable path and the live accumulator). `abandoned` remains reachable solely from the transient end
frame / a bare `settle-assistant`. Updated: adapter/degradation/quality tests, the d3 expectations (settlement kind
`attempt`, surface `false`, outcome `unknown`, explicitly *not* `abandoned`), the equivalence harness (compares the
triple instead of one status string), METRICS_SPEC §13.1, DSH_API_NOTES. Fixture bytes were **not** modified.
Impact on Phase 2 results: none — every recorded fixture's metrics, quality axes and equivalence tuples are
unchanged; only the labeling of attempt settlement concepts moved.

#### 3.3 Preflight semantic audit B — `reasoningTokens = 0` vs the reasoning stream

Guard (METRICS_SPEC §11.6): an attempt whose stream carries a non-empty `reasoning-delta` while provider usage
reports `reasoningTokens === 0` is a provider/stream contradiction. On conflict: `tokenTotalQuality` untouched
(authoritative `outputTokens` still anchors the total), `phaseSplitQuality` downgraded to at most `estimated`
(whenever every attempt "reported" the counter), the legacy `splitQuality` label degrades with it, derived rates stop
claiming `exact`, and each conflict lands in `aggregate.consistencyIssues` plus a `quality.notes` entry. Consistent
zero reports (tool-argument-only attempts such as `t4` step 2) keep an `exact` split.

Tests: unit (`phaseSplitQuality`/`qualityAxes` with the conflict flag), aggregate (conflicting attempt → split not
exact, issues recorded; consistent attempt → exact), and fixture-driven (t4 step-1 usage patched to
`reasoningTokens: 0` → split degrades with a note, while the clean recording still reports `exact`).
Impact on Phase 2 results: none — no recorded fixture contains the conflict, and the clean-path expectations still
pass unchanged.

Also frozen in this audit round: the rolling-window **warm-up contract** (METRICS_SPEC §6 — divide observed samples
by the full 1000 ms, never extrapolate) with a dedicated test, and the **live tool-episode timer** (METRICS_SPEC §5 —
the current continuous tool-activity union interval, never a sum of call durations) with parallel/gap tests; the old
"oldest still-running call" expectation in `test/live-metrics.test.js` was corrected to episode semantics.

#### 3.4 Client eventSource integration

Architecture as frozen (no new host channel, no projection, no synthetic durable telemetry, no DOM scraping):

```text
ctx.sessions.binding(id).eventSource        getSnapshot() + subscribe(), synchronous publication
  -> src/dsh/client-feed.js                 SessionEventWindow change wire -> normalized events
  -> TurnTelemetryStore (src/host)          (sessionId, turn) keyed records + per-session LiveMeter
  -> LivePresenter (src/client/live)        per-session 8-state machine + projection guards
  -> React LiveMeter                        one 200 ms ticker, stored view state
```

`SessionEventFeed` consumes the four verified `SessionEventChange` kinds: the initial pass and `replace` replay the
full window (replace first resets dedupe state and emits `window-rebaseline`, which resets the UI machine rather than
fabricating continuity); `append` feeds new tail entries with durable-`seq` + transient-identity dedupe; `prepend`
(older history) is counted and deliberately ignored; `settle-assistant` carries the transient `attemptId` into the
settlement — or, without an entry, is transient abandonment. Attempt identity on the client comes from changes of
`data.attemptId` between transient rows (the browser never sees the host `start` frame). Deltas arriving without a
seen `turn/start` are reported (`droppedDeltas`) and dropped — a window that no longer contains the boundary cannot
honestly fabricate a start time.

The controller attaches idempotently (exactly one eventSource subscription per session across A→B→A switches),
resolves each normalized event to its `(sessionId, turn)` record, folds settlement identity into the store, runs the
retry-outcome correlation, and notifies presentation subscribers after every handled event (the notify itself is
coalesced by the scheduler and never renders).

#### 3.5 Slot registration

```js
ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
  name: 'conversation.composer.dock',
  id: 'turn-performance-meter',   // independent; native `stats` (order 0) untouched
  order: -10,                     // directly beside the composer
}, makeMeterSlot({ controller, t, debug })))
```

Verified live: the boot graph contains exactly one `dsh-turn-performance-meter` entry (the boot manifest parser
throws on duplicates, and no "duplicate factory registration" console error appears); the native stats pills
("1 轮 N 步 · X tok/s", "N tok · 缓存命中 N%") remain present and updating in the same dock; `replaceRisk: none`
held — registration was purely additive.

#### 3.6 Timer / throttle strategy

One `createPresentationScheduler` per mounted meter: a single 200 ms interval while the view is visible, at most one
coalesced zero-delay leading render while hidden, `stop()` on hide/unmount clears everything, `dispose()` makes the
scheduler inert. The projected view is stored React state and is **only** written by the ticker (plus mount/session
changes) — parent re-renders of the conversation dock reuse the stored values, so the chat's per-chunk render cadence
cannot bypass the throttle. Deltas are never dropped for UI economy: ingestion is per-event, presentation is
throttled.

Structural test (t5, >1300 transient frames): all deltas ingested (`droppedDeltas === 0`, sample count equals the
recorded generated-delta count), render count bounded by `ceil(span/200ms)+2` and `< deltas/5`, ≤2 live timers, ticker
stopped at turn end. Live browser confirmation during a 113 s streaming turn: `renderCalls` advanced every ~204 ms
while `notifyCalls` advanced per event — ingestion unthrottled, presentation throttled.

Two real defects were found by this verification loop and fixed:

1. **`ctx.effect` semantics.** The callback runs *immediately as setup* and its **return value** is the teardown
   disposer (confirmed from shipped `ctx.effect(() => ctx.webServer.register(...))` call sites and live behavior).
   The first implementation registered the disposal body directly, which disposed the controller at startup —
   `attach` then silently returned `false` for every session. Corrected to the returned-disposer form, with the
   contract documented at the call site and asserted by `test/client-bundle.test.js`.
2. **Missing `emit()`.** After the stored-view fix removed render-time projection, it surfaced that the controller
   never notified its subscribers (the notify call was planned but not wired). The chain now fires
   `applyEvent -> emit -> scheduler.notify` for every event, verified live via counters
   (`notifyCalls` per delta, one render per ticker tick).

#### 3.7 Session isolation and lifecycle

Per-session everything: one feed, one machine (presenter), store keys `(sessionId, turn)`, one LiveMeter per session.
Scenario tests: A streaming → attach B → B streams → B settles while A still streams → dispose unsubscribes both
(counts go 1/1 → 0/0) → a fresh controller re-attaches exactly once (HMR remount shape). Attach is idempotent
(second attach of the same session keeps the subscription count at 1). Mid-turn attach into a window that no longer
holds the turn's `turn/start` degrades honestly: deltas counted as dropped, machine inactive, meter hidden — the
documented reload-mid-turn limitation (Phase 6), not a fabricated resume.

HMR/cleanup: the style tag is reference-counted (one `#dsh-tpm-live-style` ever; last unmount removes it — verified
`styleTags === 1` across reloads), the scheduler owns ≤2 timers and clears them on stop, the controller's
`ctx.effect` disposer unsubscribes every eventSource and disposes the store, and reloading the page picked up each
rebuilt bundle revision (boot-graph `rev` changed per build) with a single style tag and no double subscription.

#### 3.8 Locale, theme, responsive, accessibility

- locale: `turnPerformanceMeter` namespace registered with `{en, zh}`, bound via `ctx.locale.bind`, English in-module
  fallback if the service is missing; tool names / `tokens/s` / `+N` are locale-independent;
- theme: host `--dsw-*` tokens for surfaces and text; the one plugin accent resolves `#d9480f` (light) and
  `#ff922b` (dark, keyed on `body[data-ds-dark-theme]` — the selector shipped theme CSS itself uses), both read back
  from the live page;
- responsive: no fixed rem widths (`width:100%` + content-sized pill with flex-wrap), long tool names truncate with
  an ellipsis;
- accessibility: no `aria-live` anywhere (digits are plain text), per-state `aria-label` on the root, state text
  always present in the DOM (不只依赖颜色), tabular digits, `prefers-reduced-motion` disables the only transition;
- the bootstrap `dsh-turn-performance-meter.debugPlaceholder` localStorage gate is **gone**; the production meter
  renders with no localStorage dependency. The only debug key left is `dsh-turn-performance-meter.debug` (default
  off; lifecycle logs only — attach/turn/attempt/tool/rebaseline/quality downgrade, never per delta) plus its
  read-only `window.__dshTurnPerformanceMeter` diagnostics handle.

#### 3.9 Actual DSH mounting and browser validation

Mount path: `dsh plugin --profile web add "link:E:/Projects/DSHarness/dsh-turn-performance-meter"` (exit 0 — the CLI
is a pnpm forwarder plus `dsh.profile.bundles` reconciliation; the profile now lists the dependency *and* the bundle
layer entry). Because the already-running web server composes `window.__DSH_BOOT__` from boot-time state, same-session
activation used `dsh-super-injector` runtime injection (host ✓, client ✓; it validates `lib/client.js`, which
`build:client` mirrors). After injection + reload the boot graph contained our entry and the client materialized.

| Check | Result |
|---|---|
| plugin bundle active | **yes** — one boot-graph entry; console free of plugin errors |
| client module loaded | **yes** — component mounted (single style tag), `sessionId` standard prop present |
| slot entry exactly once | **yes** — boot-graph duplicate parsing would throw; no duplicate-registration console error; one component instance (one `slot prop shape` log per mount) |
| native stats preserved | **yes** — both stats pills visible and updating beside the meter |
| React duplicate instance | **none** — `window.React`/`ReactDOM` undefined; no duplicate-React console error; React from the seed table only |
| HMR/reload double subscription | **none** — attach idempotent (subscription count 1); style tag stays 1 across reloads; each bundle `rev` picked up fresh |
| session switch cross-talk | **none** — A/B isolation scenario passes in the live controller (two subscriptions while both attached, per-session machines) |
| console errors | none attributable to the plugin (pre-existing: git-graph warning, pet-plugin 404s, permissions-policy notice) |

Live turn runs (Chrome DevTools automation, session `session-6d8dc0…`/`session-cf4b6c4a…`, screenshots in
`dev/screenshots/phase3/`):

- **A — no-tool answer** (`2+3` and an 800-word essay): `pending-first-token` stopwatch ticking at the ticker cadence
  (0.08 → 3.05 s in 200 ms steps) → `streaming-reasoning` (`思考 ≈4.75…≈77.5 tokens/s`) → `streaming-output`
  (`输出 ≈34.0…≈18.0 tokens/s`, `≈` on every value) → `transition` → hidden at `turn/end`;
- **B — pwsh tool turn**: pending → streaming → transition (`处理中… 4.8 s`) → **tool-running**
  (`pwsh · 0.2–0.4 s | 4.4–4.6 s`) → **waiting-model** (`等待模型 · 0.10 → 4.50 s`, its own stopwatch, never the TTFT
  counter) → streaming → transition → hidden;
- **C — multi-tool turn**: two tool episodes with the episode timer restarting between sequential calls
  (`0.1s → 0.2s`, then a fresh `0.1s → 0.3s` — never bridging the gap), waiting stages between steps, final
  streaming, hidden;
- interrupted/error exits and retry correlation were exercised at fixture level; a live retry was observed in the
  development session's own history (`retry scheduled turn 1 step 46` logged by the controller);
- screenshots: pending ×7 (`.png`/`.jpg`), streaming-output ×1 (`turng-streaming-output.jpg` with the `≈` marker),
  post-settle hidden ×1+. A pixel capture of the seconds-long `tool-running`/`waiting-model` pills was **not**
  achieved — the agent-to-agent latency between consecutive automation calls exceeds those state windows and
  occluded-tab frames go stale — so those two states are evidenced by timestamped DOM text captured by an in-page
  sampler instead (`0.72 s 首响应计时`, `pwsh · 0.3s 3.6s`, `等待模型 · 10.42 s 14.1s`, `输出 ≈18.0 tokens/s 11.3s`,
  each with wall-clock timestamps and the exact ticker cadence). Recorded as a partial visual gap, not claimed as
  full screenshot coverage.

Mid-turn attach into an old window (the development session itself, whose `turn/start` had scrolled out of the
event window) produced the designed honest degradation: `droppedDeltas: 1097`, no fabricated turn, meter hidden —
confirming the reload-mid-turn boundary documented since Phase 2.

#### 3.10 Test count and suite structure

```text
$ npm run verify
structure OK (14 required files, 14 core modules, 28 test files, client bundle fresh)
ℹ tests 260
ℹ pass 260
ℹ fail 0
ℹ duration_ms ~380
=== exit: 0 ===
```

New/changed test files this phase: `live-state`, `live-presenter`, `live-format`, `live-refresh`,
`dsh-client-feed`, `live-controller`, `client-bundle` (7 new), plus audit additions inside `dsh-adapter`,
`dsh-degradation`, `quality-model`, `aggregate-turn`, `sliding-window`, `live-metrics`, `telemetry-store`,
`client-bundle`, and the equivalence-harness settlement-triple comparison. All 201 Phase 0–2 tests remain and pass.

#### 3.11 Git / GitHub

The phase started with **no git repository** (recorded in §3.1). A local repository was initialized at phase end
(`git init -b main`) and the complete project tree — the Phase 0–2 baseline plus every Phase 3 change — was committed
as the initial commit `feat: complete phase 3 live performance meter` (115 files) after a sensitive-information scan
of `fixtures/`, `dev/`, `docs/` and the source tree (pass — no credentials, tokens, private endpoints or secrets in
the committable tree; the only credential-shaped strings are the literal example placeholder `Bearer token` inside
recorded prompt context, a file-content SHA1 digest of `~/.dsh/AGENTS.md`, session/message UUIDs and MCP tool names —
all benign evidence). Deliberately excluded by `.gitignore`: `dev/screenshots/`, `dev/scratch/`,
`dev/verify-*.txt` (test dumps), `node_modules/`. GitHub synchronization is
blocked solely because no confirmed remote exists (`git remote -v` is empty); no remote URL was invented and no
repository was created. The working tree beyond this phase's files contains no unrelated pre-existing changes
(there was nothing else — the directory was not under version control; the only untracked leftovers are the ignored
test dump `dev/verify-phase2.txt`, the ignored screenshot folder and `dev/scratch/fixture-b1.txt`).

#### 3.12 Residual risks entering Phase 4

1. **Reload/mid-turn attach** remains unresolvable from the client window alone when `turn/start` has left the
   window: deltas are dropped and the meter stays hidden rather than fabricating state (live-verified, by design).
   Phase 6 keeps owning a possible baseline-based recovery.
2. **Paint-bound screenshots**: `tool-running`/`waiting-model` pill pixels were not captured (DOM-text evidence
   instead); occluded-tab frames go stale in this automation setup. Trivial to re-capture manually when the window
   is visible; not a product defect.
3. **Tool-only turn, provider-error retry, tool-error turn** still have no *recorded* fixture (a live tool-name
   error surfaced incidentally in the development session's own history and settled normally through the store).
4. **`attemptOutcome` beyond `retried`** stays `unknown` unless future durable evidence appears — deliberate.
5. The **injector + profile-layer dual presence** relies on the loader's documented dual-instance reconciliation;
   if a future restart shows a conflict, uninstall the injector entry (the profile layer alone is the official path).
6. `dev/fixture-recorder` remains injected in the local `web` profile (Phase 2 note, unchanged).
7. Live `≈0.00 tokens/s` can appear during a genuine model stall inside a streaming attempt (the honest empty
   trailing window); if product review finds this confusing, the fix belongs to the display policy, not the metric.

### Phase 4

- Completed summary:

### Phase 5

- Curve:

### Phase 6–8

- Robustness:
- E2E:
- Release:

## Known limitations

Keep this current. Every approximation that can affect displayed numbers belongs here and in the README before release.

1. Per-delta token counts are not available from DSH; every curve point is `estimated` until provider usage arrives and
   `reconstructed` afterwards (exact phase integrals on an estimated local shape). Live TPS is never `exact`, and it is
   the temporal-shape axis that reports this: it has a hard ceiling of `reconstructed` (docs/METRICS_SPEC.md §11.2).
2. `reasoningTokens` is optional at both usage carriers, and the local `command-goat` route never reports it. When it is
   absent the generated-token total may still be `exact` while the reasoning/output split is `estimated`. When it is
   absent the turn-level reasoning and output TPS values are not published at all, because a rate whose numerator is a
   shape weight would be fabricated.
3. The live 1-second window for a turn already streaming before a page reload cannot be reconstructed from the reconnect
   baseline (the baseline carries the compact detached stream, not a pre-reload wall-clock window). Provisionally
   `unavailable`; to be confirmed in Phase 6.
4. An attempt that emitted generated deltas but never received authoritative usage makes the exact turn total `partial`.
   The partial sum over the attempts that *did* report usage is exposed as `observedGeneratedTokens` instead, and the UI
   renders it as approximate.
5. The exact standard-prop set injected at `conversation.composer.dock` beyond `useChat`, `useProjection`, `sessionId`
   and the locale `t` seat is unverified without a live `slots.snapshot()` query.
6. The composed `web` profile config cannot be dumped in one piece because two pre-existing patch entries target absent
   rows; this is unrelated to this plugin but affects future config-based verification.
7. The Phase 2 fixtures record the transient plane **host-side** (`agent/assistant-stream`), which is the same evidence
   the browser receives but before the client fold. The two forms are asserted equivalent; the browser transport itself
   is unverified until Phase 7.
8. The fixture set contains no tool-only turn, no provider-error retry and no tool-error turn. `d4` covers an unmatched
   call and the unit tests cover error status, but a recorded instance of each is still owed to Phase 6.
9. `dev/fixture-recorder` is a dev-only package that stays injected in the local `web` profile until the remaining
   fixtures are captured. It registers no tools, no listeners outside its two observational subscriptions, and no
   `dsh.client` entry; it is not part of the plugin bundle.
10. Phase 3 added `dsh-turn-performance-meter` to the profile as a `link:` dependency (bundle layer entry present)
    *and* registered it through `dsh-super-injector` for same-session activation. The loader's dual-instance
    reconciliation is expected to keep exactly one active entry across a restart; if it ever reports a conflict,
    uninstall the injected entry — the profile layer is the official, persistent path.
11. Live TPS can read `≈0.00 tokens/s` while a model genuinely stalls inside an attempt (empty trailing window). This
    is the metric spec working as written; a different display policy would be a product decision, not a fix.
