# Implementation Log

Use this file as the running engineering record. Do not replace evidence with vague status statements.

## Environment

- Date: 2026-04-25 (local session)
- DSH version: `0.1.5-rc.2` (`@deepseek-ai/dsh`, `dsh --version` → `0.1.5-rc.2`, exit 0)
- Node version: see `node --version` recorded in the Phase 0 command transcript
- Profile: `web` at `<user-home>\.dsh\profiles\web`
- DSH checkout inspected: `<user-home>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`
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
dsh-profile-web <user-home>\.dsh\profiles\web (PRIVATE)
├── @dsh-external/dsh-super-injector@link:<local-checkout>/injector-release
├─┬ @linxin666/dsh-web-all@0.3.24          (community bundle: 20+ client UI plugins)
├─┬ dsh-cost-meter@1.7.33
├── dsh-vibe-usage-sync@link:<local-checkout>/dsh-vibe-usage-sync
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
dsh: [<user-home>\.dsh\profiles\web\cordis.patch.yml] patch: entry "vision-tool" not found
dsh: [<user-home>\.dsh\profiles\web\cordis.patch.yml] patch: entry "opencode-go-session-header" not found
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
of `fixtures/`, `dev/`, `docs/` and the source tree. That scan checked for credentials, tokens, private endpoints and
secrets in the committable tree and found none: the only credential-shaped strings are the literal example placeholder
`Bearer token` inside a recorded tool schema, a file-content SHA1 digest of the workspace instruction file, session and
message UUIDs, and MCP tool names — all benign. The scan did **not**, however, treat inlined prompt context as a privacy
surface, and the fixtures did carry two such disclosures (the maintainer's personal workspace instruction file verbatim,
and a local injector runtime-context block) plus machine-specific absolute paths. Those were found by the public-release
audit and removed by `scripts/sanitize-fixtures.mjs` before the repository was published; the redaction rules and the
verification that structural evidence survived are documented in `fixtures/README.md`. Deliberately excluded by
`.gitignore`: `dev/screenshots/`, `dev/scratch/`,
`dev/verify-*.txt` (test dumps), `node_modules/`. GitHub synchronization was
blocked at that point solely because no confirmed remote existed (`git remote -v` is empty); no remote URL was invented
and no repository was created. The working tree beyond this phase's files contained no unrelated pre-existing changes
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

Completed turn summary card. Baseline before any change: `dsh --version` = `0.1.5-rc.2`, branch `main`, HEAD
`3d90667` (`feat: complete phase 3 live performance meter`), `git remote -v` **empty**, `npm run verify` exit 0 with
260 tests / 28 files / 0 failures (383.9 ms).

#### 4.1 Fixture-recorder cleanup

Phase 3's report claimed `dev/fixture-recorder` was still injected in the working `web` profile. Checking the three
possible sources before removing anything:

| Source | Finding |
|---|---|
| `dsh plugin --profile web list --depth 2` | 110 packages; no `@dsh-external/dsh-turn-meter-fixture-recorder` row |
| profile `package.json` (`dependencies` + `dsh.profile.bundles`) | not present in either list |
| profile `node_modules` (`dir /AL`) | no junction or symlink for it |
| `dsh-super-injector` registry (`dev_injected_list`) | only `dsh-turn-performance-meter` |
| runtime loader entries (`dev_plugin_status`) | no `fixture-recorder` entry |
| `cordis.patch.yml` | `- id: dsh-turn-meter-fixture-recorder` / `disabled: true` — a disabled tombstone |

So the recorded residue was already gone from the running profile; what remains is the **disabled tombstone**, which is
deliberately kept so a bundle-layer patch cannot re-assemble the entry. It was verified disabled rather than assumed:
the control route returns `404` — the same code as a control probe against a path that never existed, i.e. the
webserver's own "unknown route", not the recorder's `404 {ok:false,error:"unknown route ..."}` JSON body.

```text
/turn-meter-fixture/status -> 404      (plugin route absent)
/turn-meter-fixture/models -> 404
/nonexistent-xyz           -> 404      (baseline)
```

The recorder declares no `dsh.client` entry and registers no slot, so there is no client module or slot residue to
check beyond that. `fixtures/dsh-turns/`, `fixtures/derived/`, `dev/fixture-recorder/lib/index.js`, `dev/capture-scenario.ps1`
and the rest of the Phase 2 tooling are **untouched** — only the production validation profile was cleaned.

#### 4.2 Completed data path

The card consumes the snapshot `TurnTelemetryStore.endTurn` already computes and caches on the turn record:

```text
DSH durable/live evidence
  -> src/dsh (adapter + client-feed)          normalized events
  -> TurnTelemetryStore                       per-(sessionId, turn) records
  -> aggregateTurn (+ compressAttempts)       settled snapshot, cached at turn/end
  -> LivePresenter.project(..., settled)      branch selection only
  -> completedViewModel                       the single completed UI seam
  -> completed-tree / CompletedMeter          render only
```

Three changes made that path complete:

1. `controller.project(sessionId, atMs)` now reads `store.latestSettled(sessionId)` in the same synchronous step as
   `store.liveSnapshot(...)` and passes it to `LivePresenter.project(snapshot, nowMs, settled)`. The presenter returns
   the card when — and only when — its machine is in the settled state, so a settled *machine* unlocks the card and an
   **open turn always wins**. `turn/end` invalidates the projection inside its own event handling, which is what makes
   the handover atomic instead of a two-tick blank.
2. The projection is memoized by identity (`projectionKey`): the settled branch keys on the turn alone, so an unchanged
   settled turn returns the identical object; live branches include the machine state, meter phase, turn elapsed, the
   rounded live TPS and the tool episode. A static card therefore cannot be rebuilt once per ingested delta.
3. `aggregateTurn` now publishes the per-phase token magnitudes the card shows (`phaseTokens` + `phaseTokensQuality`)
   and carries `sessionId` through, and `settle()` gained no new arithmetic.

#### 4.3 The per-phase display decision (the one semantic change)

Before Phase 4, a rate was published only when the provider had reported `reasoningTokens` on **every** contributing
attempt; every other route showed `—` for both TPS columns. Measured against the fixtures that meant `t1` and `t2` — the
two routes that actually represent the common case — displayed no rate at all, which contradicts the frozen reference
layout and discards a real observed generation duration.

The policy now implemented and written into `METRICS_SPEC.md` §3.1: the published per-phase magnitude is the provider
counter when the provider reported it, and otherwise the **anchored allocation of the authoritative total**
(`calibrateAttemptSamples` already rescales each attempt's phase weights so its phases sum to that attempt's total; the
output phase absorbs the rounding residual, so the pair always adds up to the published total). The rate's quality
follows its numerator: exact counters over complete measured timing stay `exact`, an anchored allocation is
`calibrated`, a partial total is `estimated`, and a phase with no evidence at all stays `null` → `—`. Nothing is
fabricated: the numbers are a division of a real total over real duration, and the weaker the derivation, the more
markers it carries.

Frozen consequences, all tested:

| Fixture | Before | After |
|---|---|---|
| `t1` (no `reasoningTokens`, 134 tokens) | `—` / `—` | `—` (no reasoning phase) / `≈305 tokens/s · 0.4s · ≈134` |
| `t2` (no `reasoningTokens`, 458 tokens) | `—` / `—` | `≈186 · 1.3s · ≈232` / `≈175 · 1.3s · ≈226` |
| `t3` (interrupted, no usage) | `—` / `—` | `≈211 · 3.8s · ≈798` / `—`; total `—` |
| `t4` (exact split) | `≈50.6` (timing-limited) / `138` | unchanged — `≈50.6` / `138 · 0.6s · 77` |
| `t5` (exact split) | `39.5` / `35.7` | unchanged — `39.5 · 26.3s · 1,038` / `35.7 · 7.6s · 270` |

Two Phase-2/3 assertions were deliberately amended rather than deleted, because the honest statement changed:
`aggregate-turn.test.js` ("no complete split means no turn-level rate" → the anchored division and its quality) and
`dsh-degradation.test.js` (the rate whose numerator is a partial sum now exists and is `estimated`, with the
under-counted denominator asserted as the cause).

#### 4.4 Reload reconstruction of a settled turn

A window that contains only the durable plane never sees `ATTEMPT_START`, so before this round a settlement arriving
with no in-memory attempt was dropped and the card could not be reconstructed after a page load. The controller now
restores such an attempt from the compact stream embedded in the durable row (`attemptFromDecoded`), derives
`firstTokenMs` from the earliest restored sample timestamp (so TTFT survives a reload), and counts it in diagnostics.
When transient rows for the same attempt *are* present, the settlement is correlated to that attempt by
`(turn, step)` only when exactly one unsettled attempt matches; with two candidates the correlation is unprovable and
the durable row becomes its own attempt rather than being attached to a guess. If the window has lost `turn/start`
entirely, TTFT and elapsed stay `null` and render `—` — no start time is invented.

`test/completed-lifecycle.test.js` proves the property end-to-end through the real controller: the durable-only window
of t1/t3/t4/t5 (and of every fixture) yields a view model identical to the live-observed path's.

#### 4.5 Presentation lifecycle and HMR

`MeterRoot.js` became the single slot component and owns the shared lifecycle: one subscription per attached session,
one style tag (`#dsh-tpm-live-style`) holding **both** stylesheets, one presentation scheduler, and a distinct rule for
the card — the ticker is started only for a live view, so a completed card leaves `timerCount === 0` (asserted on the
t3 replay). While the card is on screen the scheduler is not even notified: an event re-projects directly, which is
sound because the projection is memoized. The live pill became a pure `LivePill` render function; the card's structure
lives in `completed-tree.js`, a React-free element tree so that structure, text and accessibility are testable in Node
without a DOM or a React runtime.

#### 4.6 Verification

`npm run verify` exit 0: structure OK (14 required files, 14 core modules, 31 test files, bundle fresh),
**317 tests / 0 failures / 437.8 ms** — up from 260 tests / 28 files. New files: `test/completed-tree.test.js` (14),
`test/completed-lifecycle.test.js` (14), `test/completed-format.test.js` (11); `test/ui-model.test.js` rewritten
from 8 to 23 tests; `test/live-presenter.test.js`, `test/live-controller.test.js`, `test/client-bundle.test.js`,
`test/aggregate-turn.test.js`, `test/dsh-degradation.test.js` extended or amended as described above.

Real DSH validation, partial and reported as such: after a runtime reload of the bundle, the live page
`http://127.0.0.1:50001/` was inspected with Chrome DevTools and showed exactly one `style#dsh-tpm-live-style` element
(4937 bytes of CSS, containing the card rules) and one `.dsh-tpm-root` in the live streaming state
(`data-state="streaming-output"`, accessible name `输出 · 34m15s`, text `输出 | ≈141 | tokens/s | 34m15s`), beside the
native statistics pill `1 轮 174 步 · 89 tok/s | 79.8M tok · 缓存命中 98%`. A pixel capture of the **completed card** was
not obtained: the host serializes turns, so a fresh short turn could not run while this session's own turn was open,
and the two DSH tabs used for reload-based verification stopped answering DevTools evaluation while re-rendering
multi-megabyte conversations. That gap is recorded in `TEST_PLAN.md` §3 rather than papered over.

### Phase 5 — UI correction, slot migration and the completed TPS curve

Baseline `3781b974288e00211fb2c7127c37fee518d94c6f` (`main`, `origin/main`, working tree clean, MIT, public),
317 tests / 0 failures before the first edit.

#### 1. What was actually wrong, and what replaced it

| # | Defect, as read from the code | Correction |
|---|---|---|
| A | `DEFAULT_REFRESH_MS = 200` in `controller.js` **and** `intervalMs = 200` in `refresh.js` **and** `LiveMeter`'s own `refreshMs` — three defaults for one contract | one constant, `DEFAULT_PRESENTATION_REFRESH_MS`, in `src/client/live/cadence.js`; the scheduler, the controller and `main.js` all import it |
| B | `ctx.slots.inject('conversation.composer.dock', …)`, `order: -10`, i.e. *below* the composer and immediately above the native `stats` pill | `conversation.input.dock`, `order: 30`; the composer dock is no longer touched at all |
| C | `live-css.js` / `completed-css.js` were functional but flat: one text size, no dominant number, no card rhythm | both sheets rebuilt from the four references, plus a shared token block (`base-css.js`) |
| D | `downsampleSeries` kept every local extremum and then thinned the overflow by uniform stride, which can step over the global maximum | anchors (endpoints, global max, global min) reserved first, then extrema ranked by prominence, then shape samples |
| E | `curve.js` documented `peakTps` as "the peak of the rendered series" while `telemetry-design.js` computes it before downsampling | comment corrected at both sites; the implementation was already right and was not changed |
| F | Phase 4 reporting claimed `≈108.2s · ≈37,498` for the duration+token line; the code emits `108.2s · ≈37,498` | the code is right, the report was wrong; docs updated, no `≈` added to a duration |

#### 2. Slot migration (Phase 5B)

DSH's own contract table (`dsh-cordis-client-runner`, generated from
`packages/client/ui-conversation/src/client/contract/slots.ts:166`) states:

- `conversation.input.dock` — `kind: 'list'`, `scope: 'session'`, owner `InputZone`, doc
  "Full-width entries above the composer card", occupants `queue` (20), `todo` (0), `goal` (10);
- `conversation.composer.dock` — "Ambient entries below the composer card", occupant
  `client-ui-chat StatsPills` id `stats`.

The owner renders the seat as `renderSlot("conversation.input.dock", zone)` immediately **before** `inputBar`
(`ownerProps = { session, input }`), and the seat's standard props include `sessionId: SessionId`, so the
plugin's existing `props.sessionId` dependence carries over unchanged — no DOM query was needed or used.

`order` was decided from the occupant list rather than copied: the shipped occupants are 0, 10 and 20, so
`order: 30` places the meter **last**, i.e. directly above the composer card, instead of floating above the
todo/goal panels where it would be furthest from the input it describes.

Structural verification from the running GUI (`dev/screenshots/phase5/`), via the slot wrappers:

```
conversation.input.dock     hasMeter = true
conversation.composer.dock  hasMeter = false
```

Pixel evidence, 1440x950: meter `y = 667…816`, native stats `y = 920…946`; the composer sits between them.

#### 3. Refresh cadence A/B (Phase 5A)

Three full turns on the running DSH web GUI, one per cadence, driven through the production code path with the
debug-only `dsh-turn-performance-meter.refreshMs` override. In-page instrumentation: a `requestAnimationFrame`
frame-time sampler, a `MutationObserver` on the meter's own subtree, and a Long Task observer. Raw evidence:
`dev/screenshots/phase5/ab-{200,50,10}ms.json`.

| cadence | turn | renders | renders/s | DOM writes | DOM/s | DOM peak/s | frame p50 | p95 | max | slow frames (>33 ms) | long tasks |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 200 ms | 90.9 s | 448 | 4.9 | 1 154 | 12.8 | 25 | 4.2 ms | 4.3 ms | 108.4 ms | 79 | 0 |
| 50 ms | 125.5 s | 2 447 | 19.5 | 2 897 | 23.2 | 45 | 4.2 ms | 4.3 ms | 108.4 ms | 93 | 0 |
| 10 ms | 95.0 s | 8 433 | 88.8 | 4 515 | 48.0 | 123 | 4.2 ms | 4.3 ms | 112.5 ms | 125 | 0 |

`tested 50 ms`: 4x the presentation rate of the baseline and 1.8x the DOM writes; frame p50/p95 unchanged; no
long task in 125 s of streaming. The 200 ms baseline is visibly steppy — the two-decimal TTFT counter jumps 20
hundredths per update — while 20 updates/s reads as continuous.

`tested 10 ms`: 3.4x the React renders and 2.1x the DOM writes of 50 ms for **identical** frame p50/p95/max
(4.2/4.3/112.5 vs 4.2/4.3/108.4) and a higher slow-frame rate. The only field that can change between two 10 ms
ticks is the hundredths digit of a stopwatch, which is not readable at that speed.

`selected: 50 ms`. `reason`: it removes the measured steppiness of 200 ms, and 10 ms buys no frame-time
improvement for 3.4x the render work. The display in this environment runs at ~215–220 Hz effective, so the
comparison is not resolution-limited in 10 ms's favour. `timerCount` was 0 with `ticking: false` at the end of
every leg, at every cadence.

The rolling TPS window (1 000 ms) and the curve sampling cadence (250 ms) were **not** touched: the live
presentation cadence, the measurement window and the chart grid are three different numbers.

#### 4. Redundant double update (Phase 5A)

`MeterRoot`'s `onRender` called `refreshView()` **and** a `useReducer` bump. The audit: `refreshView` calls
`setView(controller.project(id, Date.now()))`, and the projection key includes the presentation instant
(`controller.js` `projectionKey`), so every tick receives a fresh object identity and `setView` always schedules
a render. The `bump` could therefore only add a second update per tick. It was removed and the property it
relied on is now a test (`test/completed-lifecycle.test.js`, "every live presentation tick yields a fresh view
object"). Browser confirmation: `refreshDelta == renderDelta` in all three A/B legs (449/448, 2448/2447,
8433/8433) — exactly one projection per render.

#### 5. Visual redesign (Phase 5C)

Measured from the references (device pixels, then corrected to CSS pixels against the composer placeholder's ink
height; scale approximately 1.14x for `reference-completed-summary.png`):

| property | reference | shipped |
|---|---|---|
| card width | 884 px / 1.14 = **775** | **774** (`max-width: var(--dsh-composer-card-max-width)`) |
| card radius | 11 device px | **10 px** |
| card padding | ~24 px vertical | **20.15 px** (`1.55 x` the host content size) |
| metric columns | 4 equal, 221 device px | **4 equal, 193 px** |
| column inline padding | 32 device px | **26 px** |
| label / value / secondary | 14 / 18 / 13 device px ink | **12.35 / 22.1 / 11.96 px** |
| live pill | 324x70 device px, radius ~14 | **content-sized, radius 10, `.62em x 1.55em` padding** |
| curve area | 50 % of the card, two metric columns at 25 % | **same, via `grid-column: span 2`** |
| legend | `思考 ▪ 输出 ▪` at the top left | **same, text before swatch** |
| peak readout | `峰值 730token/s`, top right | **`峰值 ≈543 tokens/s`, same position, `≈` mandatory** |

`reference mismatch: the reference's output-rate orange is #fb8147, which scores 2.31:1 on the reference's own
card surface — below the 3:1 floor for large text. correction: keep the hue (~21°) and darken to #d9600f
(3.4:1); dark theme #ff9a5c.` This is a deliberate, measured deviation, not an oversight.

`reference mismatch: the reference card has no footer; this plugin's card carries tools/attempts/status below a
hairline. correction: keep it — the Phase 4 metric semantics freeze four principal columns and put tool
statistics on a secondary line — and make it quiet (11.05 px, tertiary, top hairline). The card is therefore
149 px rather than the reference's 113 px.`

`reference mismatch: the reference is a warm grey palette; DSH's tokens are cool grey. correction: use the host
tokens (`--dsw-alias-bg-module-platform` = #f5f6f7 light / #353638 dark, `--dsw-alias-label-*`), because a
plugin must follow the active DSH theme.`

Every state was rebuilt together, not just the curve: live TTFT, live streaming, live tool, live waiting and
transition, completed summary and completed curve. Each live state now renders exactly one number through
`.dsh-tpm-number` (1.7x the host content size) and keeps labels, units and elapsed readings strictly below it.
The plugin type scale is expressed as multiples of `--dsh-content-font-size-secondary`, so a DSH font-size
setting scales the whole meter.

#### 6. Curve semantics (Phases 5D/5E)

- **Compressed time**: unchanged, `compressAttempts`; a tool call and inter-attempt waiting still consume zero
  chart width, an intra-attempt stall keeps its full width. `test/curve.test.js` holds the 1 s vs 60 s
  identical-geometry assertion.
- **Series availability**: `settle()` now also emits `curve.phaseSpans` — per phase, first token-producing
  sample to last sample plus the rolling window. `curveViewModel` draws each phase only inside its span, so the
  reasoning series stops when reasoning ends instead of being drawn as a flat zero across the output phase. The
  series values themselves are untouched. Verified on real fixtures:
  `t1` reasoning span `null` (no reasoning evidence) → no reasoning line;
  `t3` (interrupted) output span `null` → no output line; `t5` spans overlap by exactly 1 000 ms, the window.
- **Two series**: `reasoning` (neutral stroke) and `output` (accent stroke), never a synthetic total; the legend
  carries text, so colour is not the only channel.
- **Peak**: `curve.peakTps` is computed from the full pre-downsample series, and the rendered series is
  independently guaranteed to retain that point, so the drawn curve reaches the axis top. It renders as
  `≈`, because a single curve sample is not a provider-certified maximum even when the token total is exact.
- **Sampling cadence**: `DEFAULT_SAMPLE_EVERY_MS = 250` is unchanged. Nothing about the 50 ms presentation
  cadence touches it.
- **Seam**: `settled.curve -> curveViewModel(settled) -> curve-tree.js -> SVG`. React decodes nothing,
  aggregates nothing, compresses nothing, rolls nothing and downsamples nothing.

#### 7. Downsample retention (Phase 5D)

Priority order, all of it unconditional: endpoints, then the global maximum, then the global minimum (when the
budget can hold it), then local extrema ranked by prominence, then uniform shape samples. Ties resolve to the
earliest index, so the function is deterministic. Output is emitted in non-decreasing `timeMs` order and never
exceeds `maxPoints`; a budget below 3 raises `TypeError` rather than silently dropping one of the three hard
guarantees.

The counterexample that defeats the previous stride is in `test/curve.test.js`: a series whose every interior
index is a local extremum (alternating values) with the global spike parked on an index the old stride stepped
over. The old algorithm returns a peak of 101 where the series peak is 9 999; the new one returns 9 999.

#### 8. Interaction and accessibility (Phase 5F)

`view-mode.js` is the whole state machine and is pure. Hover and focus open the curve; leave, blur and view
change close it; a blur that stays inside the card keeps it open. Focus is the touch path — no separate touch
handler exists. A card whose turn has no curve is not focusable and carries no handlers, because a focus stop
that reveals nothing is worse than none.

Both views are stacked in one grid cell, so the card's height is the taller of the two at every width and font
size: measured 149 px at 1440 px and 240 px at 520 px, **identical in both views** at each width. The hidden
layer is `aria-hidden="true"` with `pointer-events: none`; the SVG is `aria-hidden` and the panel carries one
textual description; the focus ring is `2px solid` accent on `:focus-visible` with no `outline: none` anywhere;
`prefers-reduced-motion` cancels the 220 ms opacity cross-fade without cancelling the switch.

Browser verification (deterministic pointer control, `dev/screenshots/phase5/interaction-probe.json`):

```
rest -> summary            hover -> curve          leave -> summary
focus -> curve             blur -> summary         focus-visible ring -> 2px solid rgb(217, 96, 15)
aria-hidden: summary:true, curve:false while rest; the reverse while hovering
settled card: scheduler.ticking = false, timerCount = 0
```

#### 9. Fixture verification

Replayed through the durable window and shaped by `completedViewModel` + `curveViewModel`:

| fixture | status | attempts | tools | TTFT | generated | reasoning TPS | output TPS | peak | axis | drawn pts | reasoning line | output line |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t1-reasoning-tool-reasoning | completed | 2 | 2 | 4.42 | 134 | — | ≈305 | ≈12.8 | 20 | 2 | no | yes |
| t2-pwsh-write-edit | completed | 4 | 3 | 1.97 | 458 | ≈186 | ≈175 | ≈206 | 250 | 14 | yes | yes |
| t3-interrupted-mid-reasoning | interrupted | 1 | 0 | 4.98 | — | ≈211 | — | ≈263 | 500 | 16 | yes | no |
| t4-reasoning-tool-deepseek-official | completed | 2 | 1 | 7.58 | 151 | ≈50.6 | 138 | ≈74.5 | 100 | 12 | yes | yes |
| t5-reasoning-text-deepseek-official | completed | 1 | 0 | 2.88 | 1 308 | 39.5 | 35.8 | ≈84.0 | 100 | 140 | yes | yes |

t1's compressed duration is 440 ms and carries no reasoning evidence, which is why its reasoning line is absent
rather than flat; t3 shows the mirror case.

**Peak changes caused by the Phase 6 correction.** Only `t2` moved, and the reason is the defect itself:

| fixture | peak as reported in Phase 5 | peak after Phase 6 | why |
|---|---|---|---|
| t1-reasoning-tool-reasoning | ≈12.8 | 12.75 | unchanged; one attempt carries evidence |
| t2-pwsh-write-edit | ≈206 | **29.0** | the 206 was a bridged value |
| t3-interrupted-mid-reasoning | ≈263 | 262.5 | unchanged; single attempt |
| t4-reasoning-tool-deepseek-official | ≈74.5 | 74.5 | unchanged |
| t5-reasoning-text-deepseek-official | ≈84.0 | 84.0 | unchanged |

`t2` has four attempts. Attempt 1 generates 206.8 shape tokens of reasoning and 25.5 output tokens in 1 428 ms; attempts
2–4 generate **no reasoning at all** and 24.5–29.0 output tokens each. Reconstructed verbatim, the rejected pipeline
reports 274.0 tokens/s at t = 2 000 — attempt 1's reasoning tokens counted inside attempt 2's window — and 234.5 at
t = 1 500 and 222.5 at t = 1 750. Under the per-attempt construction the reported peak is 29.0, which is attempt 4's own
output total and the largest single-attempt rate in the turn. The 206 figure was not a measurement of anything.

This is the expected direction of the correction: the peak can only fall when a bridged window is removed, and it fell
by the size of the tokens that had been borrowed. The old number was not kept.

#### 10. Browser verification

`dev/screenshots/phase5/` (gitignored, as required) holds the ten required captures plus the raw JSON evidence:
live TTFT, live streaming, live tool-running, completed summary, completed curve on hover, completed curve on
keyboard focus (focus ring visible), light theme, dark theme (summary and curve), narrow viewport (520 px: two
column wrap, no horizontal overflow, height stable across views) and the seat-order capture showing the meter
above the composer with the native statistics below it. The dark run flipped `ui-theme.preference` in the DSH
settings file and restored it byte-identically in a `finally` block (verified by comparison with the backup).

Runtime checks on that page: exactly one `turn-performance-meter` slot entry, the fixture recorder not injected,
native statistics still rendering, no console error attributable to the plugin.

#### 11. Debt removed

`src/client/styles.js` was a second, unreferenced set of `.dsh-tpm-card` / `.dsh-tpm-pill` / `.dsh-tpm-view`
rules — an early scaffold superseded by `live-css.js`. Nothing imported it; it was deleted rather than left as a
second source for the same class names.

### Phase 6 — Curve semantic hardening and runtime robustness

Phase 6 began with two blocking defects found by an independent code audit of the Phase 5 commit. Both were
statistical, both were invisible in the Phase 5 screenshots, and both are now carried by a test that the rejected
implementation fails.

#### 1. Blocking A — the completed rolling window crossed the attempt boundary

`compressAttempts` joins attempts end-to-start so tools consume no chart width, and `settle()` then handed the whole
concatenated sample list to one call of `rollingTpsSeries`. That function filters on `activeTimeMs` and `phase` and
never reads `attemptId`, so one trailing one-second window spanned two model calls.

The live meter had always reset at every new attempt, so the completed curve and the live pill disagreed about the
same definition — and the disagreement was largest exactly where a reader cannot see it, at the coordinate where two
attempts meet.

| | rejected pipeline | corrected construction |
|---|---|---|
| attempt A (100 tokens at local 0 and 500) | `0:100 250:100 500:200` | `0:100 250:100 500:200` |
| attempt B (10 tokens at local 0 and 500, after a 60 s tool) | `500:210 750:210 1000:120 …` | `500:10 750:10 1000:20` |
| turn peak | 210 (assembled from two calls) | 200 (attempt A's own maximum) |

`test/curve-attempt-boundary.test.js` runs the rejected algorithm verbatim over the same record and asserts those
numbers, so the counterexample is executable rather than described. The construction that replaced it:

- `compressAttempts` publishes **two clocks per sample**: `activeTimeMs` (the turn-compressed coordinate the axis is
  drawn against) and `attemptTimeMs` (the attempt-local instant the window is measured on). Publishing only the first
  is what allowed the mistake; for the first attempt the two coincide, which is why the defect survived Phase 5.
- `perAttemptSeries` builds one series per attempt episode. It also had to be split by **episode** rather than by
  attempt: an attempt's own series spans its whole width, and a phase that is absent for part of it would have been
  drawn as a zero line — the same error in a new place.
- Each run's decay tail is clamped at the coordinate the following attempt owns. A single nullable `nextStartMs`
  cannot express that, because "the next attempt starts here" and "this attempt ends at the axis end" both read as the
  same number when the next attempt happens to start at the end of the sample span; `hasSuccessor` was added so the
  final attempt keeps the tail that shows its last tokens expiring, while every other attempt stops at the boundary.
- The opening vertex is measured at the attempt's own zero. A plain half-open window `(0 - 1000, 0]` contains nothing,
  so the curve would have opened on a fabricated trough on the one vertex that carries the call's first tokens.

#### 2. Blocking B — one phase interval could not express a discrete episode

`phaseSpans` returned one interval per phase, from the first sample to the last sample plus a window. A real turn
routinely contains `Reasoning A → Output A → Tool → Reasoning B`, and that single interval spans the output-only
stretch between the two reasoning episodes; a renderer drawing it emits a flat zero line exactly where reasoning was
absent.

`phaseRuns` replaces it with a list of episodes, one per run:

- a run starts at its episode's first token-producing sample and ends one window after its last one, clamped to its
  own attempt's coordinates;
- two same-phase episodes of one attempt merge when the second begins at or before the first one's tail — the window
  never reached zero, so there is no absent stretch to preserve; a longer silence splits them, and a change of attempt
  splits them unconditionally;
- the merge extends the tail and never shortens it, so an episode whose later sample sits *inside* an earlier one's
  window cannot retract the interval and drop the stretch between them.

`phaseSpans` survives as an outer-bounds convenience derived from `phaseRuns`, marked deprecated for rendering: it is
correct as a summary and wrong as a drawing instruction, and the tests assert both halves of that.

`curveViewModel` now builds one path per run and `curve-tree` emits one `<path>` element per drawable run. Two runs
are two elements rather than one element with two subpaths, because the separation is the statement. No attempt
boundary marker is drawn; the break itself is the signal.

#### 3. Correction C — curve quality ignored the temporal-shape axis

`curve.quality` was `aggregate.usageComplete ? 'calibrated' : 'estimated'`. That is a token-axis answer to a
shape-axis question, and the two disagree in both directions: an exact token total with no durable settlement was
called `calibrated`, and durable anchored timing with partial usage was called merely `estimated`.

It is now `quality.temporalShapeQuality`, clamped to that axis's ceiling. The token and split axes travel with the
curve in `curve.qualityAxes` for the numbers printed beside the chart, and a fixture sweep asserts the relationship
on every recorded turn through both the live and the durable path.

While fixing this, `aggregateTurn` was found to be omitting `sampleCount` from its `qualityAxes` call, which made
`temporalShapeQuality` answer `unavailable` for **every** turn — so the strongest achievable curve quality had been
silently capped. Fixed and asserted.

#### 4. Correction D — the dead core `refreshMs` contract

`LiveMeter` accepted `options.refreshMs` and stored it; `TurnTelemetryStore.live()` passed `this.refreshMs ?? 200`;
`TurnTelemetryStore`'s own JSDoc advertised the option. None of it drove a timer — presentation cadence lives in
`src/client/live/cadence.js` — so the core read as though it scheduled the screen, and a future reader changing "the
refresh rate" would have changed nothing.

Both options were removed, and `test/cadence-contract.test.js` holds the separation at source level, because a dead
option cannot be caught behaviourally: `src/core/` and `src/host/` must contain no `refreshMs`, no timer call and no
reference to the presentation cadence, with comments and string literals stripped so the modules may still explain in
prose why their 1000 ms window and 250 ms sampling cadence are *not* UI cadence.

#### 5. One live-path defect found while testing out-of-order frames

`acceptChunk` passed its sample to the live meter without an `attemptId`. The meter's rolling window is bound to one
attempt and rejects a sample naming another one, but that guard was unreachable, so a late frame for an attempt the
turn had already moved past could enter the newer attempt's live rate. The sample is now stamped with its attempt
before it reaches the meter; the completed curve still keeps the late delta against the attempt that produced it,
which is the correct and different answer.

#### 6. New recordings

Three scenarios were recorded with the dev-only fixture recorder and harvested with `dev/harvest-fixtures.mjs`:

| fixture | route | what it is |
|---|---|---|
| `t6-tool-only-deepseek-official` | `deepseek-official` / `deepseek-v4-pro` | four attempts, three pwsh calls, **no assistant text at all** |
| `t7-failing-pwsh-deepseek-official` | `deepseek-official` / `deepseek-v4-pro` | a failing shell command that DSH recorded as a **successful** call |
| `t8-reasoning-no-retry-deepseek-official` | `deepseek-official` / `deepseek-v4-pro` | a reasoning turn recorded to look for a provider retry; it contains none |

Two of them needed a second take and the first takes are kept: `E1`'s first attempt still emitted five tokens of
closing text (a tool-then-text turn, not the tool-only shape), and `E2`'s first attempt failed the *command* rather
than the *call*, which DSH records as a success. The harvest script was also changed to **merge** the fixture index
instead of replacing it — a selective harvest had been silently erasing the record of every unselected fixture.

#### 7. What Phase 6 did not obtain

- **No recorded provider retry.** `t4`, `t5` and `t8` were recorded on the official route specifically to produce one;
  none scheduled an `llm/retry`. The retry path is covered synthetically before and after a tool, and
  `test/runtime-robustness.test.js` asserts that no recording contains a retry — so a future recording that does
  contain one fails the test rather than passing unnoticed.
- **No recorded mid-tool-argument interruption.** `t3` records the mid-reasoning case; the mid-tool-argument shape is
  covered synthetically.
- **No recorded tool-error envelope.** DSH does not appear to produce one for a failing shell command, as `t7` shows.
  The error-envelope path is covered synthetically.
- **No pixel capture of the completed card in Phase 6.** The served bundle was verified in the live page after a
  reload, but producing a *settled* turn in an observing browser would have required driving the very session running
  this work, and a second page in an isolated browser context is refused by the host with `dsh web authentication
  required`. See `TEST_PLAN.md` §3.

#### 8. Injector incident

`dev_reload_package` against this plugin hung and returned no result. The injector's logs place the cause: the
self-reload watcher fired two seconds after `client.js` was rewritten and recorded `watch-precheck-blocked`, so a
reload raced a bundle write in the same directory. Rather than retrying blindly, the served client bundle was fetched
from the running host and inspected directly — the stronger check for a client bundle — and confirms
`DEFAULT_PRESENTATION_REFRESH_MS = 50`, `curveQuality`, `phaseRuns`, `drawnToMs`, `data-run` and the absence of
`this.refreshMs`. The page was then reloaded and the live pill rendered with a clean console.

### Phase 7–8

- E2E:
- Release: `v0.1.0` publication — see "v0.1.0 publication record" at the end of this file. It is a **release plan**
  written before the tag exists; the outcome is reported in the round's final report rather than as a post-tag commit.

## Known limitations

Keep this current. Every approximation that can affect displayed numbers belongs here and in the README before release.

1. Per-delta token counts are not available from DSH; every curve point is `estimated` until provider usage arrives and
   `reconstructed` afterwards (exact phase integrals on an estimated local shape). Live TPS is never `exact`, and it is
   the temporal-shape axis that reports this: it has a hard ceiling of `reconstructed` (docs/METRICS_SPEC.md §11.2).
2. `reasoningTokens` is optional at both usage carriers, and the local `command-goat` route never reports it. When it is
   absent the generated-token total may still be `exact` while the reasoning/output split is `estimated`. Since Phase 4
   the per-phase rates and token counts *are* published in that case, as the anchored division of the authoritative
   total by the observed shape, and they carry `≈` because that division was never measured. A phase with no evidence
   at all still renders `—`.
3. The live 1-second window for a turn already streaming before a page reload **cannot** be reconstructed from the
   reconnect baseline, and Phase 6 confirmed and froze that answer rather than closing it. The baseline carries the
   compact detached stream, not a pre-reload wall-clock window, so the honest degraded state is a neutral pill stage
   with no rate at all — never a rate assembled from a gap. A durably settled attempt inside the same turn *is*
   restored, with its original delta timestamps. Asserted in `test/completed-lifecycle.test.js`.
4. An attempt that emitted generated deltas but never received authoritative usage makes the exact turn total `partial`.
   The partial sum over the attempts that *did* report usage is exposed as `observedGeneratedTokens` instead, and the UI
   renders it as approximate.
5. The exact standard-prop set injected at `conversation.composer.dock` beyond `useChat`, `useProjection`, `sessionId`
   and the locale `t` seat is unverified without a live `slots.snapshot()` query.
6. The composed `web` profile config cannot be dumped in one piece because two pre-existing patch entries target absent
   rows; this is unrelated to this plugin but affects future config-based verification.
7. The Phase 2 fixtures record the transient plane **host-side** (`agent/assistant-stream`), which is the same evidence
   the browser receives but before the client fold. The two forms are asserted equivalent; Phase 7B closed the browser
   half of this by driving real turns through a real page and checking the rendered states, the write cadence and the
   live/reloaded card against the same session's own record.
8. The fixture set **now contains** a tool-only turn (`t6`). It still contains no provider-error retry and no tool-error
   turn: three recordings were made on the official route specifically to obtain a retry and none scheduled one, and a
   failing shell command turns out to be recorded by DSH as a *successful* call (`t7`). Both shapes are covered
   synthetically, and `test/runtime-robustness.test.js` asserts that no recording contains an `llm/retry`, so a future
   recording that does will fail the test rather than pass unnoticed.
9. `dev/fixture-recorder` is a dev-only package. It is **not** part of the plugin bundle and registers no tools, no
   `dsh.client` entry and no listeners outside its two observational subscriptions. It was injected into the local
   `web` profile during Phase 6 to record `t6`–`t8`, which is how the Phase 2 fixture set was produced as well; the
   profile patch carries a `disabled: true` tombstone so a bundle-layer patch cannot re-assemble it.
10. Phase 3 added `dsh-turn-performance-meter` to the profile as a `link:` dependency (bundle layer entry present)
    *and* registered it through `dsh-super-injector` for same-session activation. The loader's dual-instance
    reconciliation is expected to keep exactly one active entry across a restart; if it ever reports a conflict,
    uninstall the injected entry — the profile layer is the official, persistent path.
11. Live TPS can read `≈0.00 tokens/s` while a model genuinely stalls inside an attempt (empty trailing window). This
    is the metric spec working as written; a different display policy would be a product decision, not a fix.
12. The completed card's curve is a **shape** rendering of durable evidence, not a replay of the live session. The live
    pane and the completed curve agree at every attempt-local instant that was actually observed live (asserted in
    `test/curve-attempt-boundary.test.js`), but the curve is rebuilt from stored samples and can be finer than what the
    50 ms presentation cadence happened to display.
13. A run of one vertex is not drawable **as a line**, so an attempt that produced a single measured instant inside a
    phase contributes a peak with no segment. Phase 7 closed the mismatch that used to follow from this: the
    measurement is now placed as a point marker of its own series, so a card can no longer print a turn peak whose
    vertex has no position on the chart. A marker is not a path vertex, so it does not enter `drawnPoints`; Phase 7A.1
    established that it *is* an element of the plot all the same, and the quantity the chart-wide budget bounds is now
    `renderBudget.elementPoints` = path vertices + markers (§"Phase 7A.1" below). Since Phase 7C an ordinary marker is
    deliberately small and subdued, and only a singleton that *is* the published peak keeps the strong marker, because
    a structural change removed most of the singleton runs the old geometry invented (see §"Phase 7C" §3).
14. **Closed in Phase 7C — the curve's peak could fall below the turn's own mean rate.** Found in the browser during
    Phase 7B: turn 5 settled at `generatedTokens: 365` over a 1530 ms curve span — a mean of 238.6 tokens/s — while
    `peakTps` was 63.75, with the same card printing `reasoningTps 157.2` and `outputTps 325.7` and the live pill
    observed at `≈326 tokens/s` in that turn's output phase. The reproduction is preserved in
    `dev/screenshots/phase7b/phase7b-measurements.json`, §"Phase 7B" §2, and the diagnosis, its counterexample and the
    corrected pipeline are recorded in §"Phase 7C" below rather than deleted. Two independent defects produced that
    number: the curve was measured in the **raw heuristic** magnitude system while every printed figure came from the
    **calibrated** one, and it was measured **one phase at a time** while the live meter measured the total. It is
    closed; the reduction is now a test (`test/curve-calibration.test.js`), not a report.

## Phase 7 — curve correctness, chart budget, dock placement (2026-09-26)

An independent audit of the Phase 6 code found three defects and one placement error. Each is recorded with the
counterexample that establishes it, because in all four cases the shipped behaviour looked plausible and the
arithmetic was what was wrong.

### 1. The rolling window was episode-local, not attempt-local

`rollingTpsSeries` carried a special case at an episode's opening vertex:

    const lowerExclusive = localMs <= fromMs ? Number.NEGATIVE_INFINITY : localMs - windowMs

The case was written for an attempt's first episode — local zero is the attempt's own opening delta — and the
reasoning is sound about the attempt but wrong about the coordinate: `fromMs` is the *episode* bound, so `localMs ==
fromMs` holds at **every** episode's opening vertex. An attempt whose phase falls silent for longer than one window
splits into two episodes, and the second opening reopened the window to negative infinity and readmitted samples the
trailing definition had already evicted.

Counterexample, frozen in `test/curve-episode-opening.test.js`: one attempt, output deltas at attempt-local 0 ms and
3000 ms, `windowMs = 1000`. The episodes are `0 -> 1000` and `3000 -> 4000`; at the second opening the window is
`(2000, 3000]` and contains the 3000 ms delta alone, so the rate is **100 tokens/s**. The shipped code reported
**200**. Both episodes belong to one attempt, so nothing here is an attempt-boundary effect. The clamp was also
unnecessary for the case it was written for: at local zero `localMs - windowMs` is `-windowMs`, and a sample at zero
lies inside `(-windowMs, 0]`, so the opening delta is included by the arithmetic. The bound is now uniform.

`test/curve-reference-window.test.js` is the independent check: an O(n²) brute-force reference that shares no code
with `src/core/curve.js`, re-derives the window from the literal definition, partitions episodes by a single gap rule,
and requires every production vertex to lie on its grid with exactly the reference rate. It covers a single run, split
runs, gaps below / at / above the window, reasoning-output alternation, multiple attempts, retries, and two generated
families over 84 turns. Two expectations that had encoded the wrong arithmetic were corrected rather than preserved.

### 2. Per-run point caps left the chart unbounded

`downsampleSeries` bounds **one** run at `DEFAULT_MAX_POINTS` (512) and nothing bounded their sum, so the SVG's element
count followed the model's delivery pattern: a turn alternating reasoning and output a hundred times produced a hundred
runs of up to 512 vertices, and several cards can be on screen at once. `MAX_RENDER_POINTS_TOTAL` (512, fixed and
chart-wide) is the missing bound and `allocateRunBudgets` divides it — anchors first in priority order with the
peak-bearing run ranked first, then runs too short to thin, then a round-robin top-up that never raises an allowance
above what the run holds and never hands out one below `MIN_MAX_POINTS`. `test/curve-render-budget.test.js` asserts the
bound at 10 / 25 / 100 / 150 / 200 runs through both the settled snapshot and the pure allocator, and asserts the
properties that make the bound safe: the global peak survives on a drawn run, run order and run intervals are
preserved, endpoints are kept, a small chart is untouched, and the allocation is deterministic and never raises a
measured value.

**The two-pass structure described above is superseded.** An external audit of `c0d2a60` found that partitioning the
allocation by run length removed the peak's priority band exactly at the class boundary, so a global peak living in a
one- or two-vertex run could be starved by ordinary short runs. The bound and the retention properties above still
hold; the passes do not. See §"Phase 7A.1" for the counterexample and the single-order replacement.

### 3. A one-vertex run was invisible

Handled by the point marker described in limitation 13, with `test/completed-interaction.test.js` asserting that no
line is fabricated, that the marker carries its own series and tone, that `data-points` stays 0 while `data-markers`
is 1, and that a singleton which is the turn's peak lands on exactly the peak marker's coordinate.

### 4. Dock placement

Phase 5 placed the entry at `order: 30` — last in `conversation.input.dock`, directly above the composer. A screenshot
of the real interface showed why that reads wrong: the seat's other occupants (`todo` 0, `goal` 10, `queue` 20) are
full-width cards and this entry is a content-sized pill, so rendering it last put a narrow orphan between a wide card
and the input. `SLOT_ORDER` is now **-10**, which yields telemetry, task state, composer. The value is finite on
purpose: no slot contract defines a top pin, so the honest claim is "first among all currently shipped occupants", and
`test/client-bundle.test.js` asserts exactly that by sorting this entry against the shipped occupants.

### 5. Chart-wide budget and the curve work are visible in the bundle

`client.js` and `lib/client.js` are regenerated from `src/` by `npm run build:client` in the same change as the
sources, and `scripts/verify-structure.mjs` fails the suite when either is stale. A source change that is not reflected
in the bundle is therefore a red build rather than a silent one.

## Toolchain incidents (Phase 7, 2026-09-26)

Two failures in this round were not plugin defects but they gated the phase, and both are recorded here with the
evidence that established them.

### 1. `dev_reload_package` reloaded the wrong module and took the host down with it

**Symptom.** `dev_reload_package dsh-turn-performance-meter` never returned. The session log's last real event was the
tool call at 01:29:26.408; on the next host start the crash-repair in `@deepseek-ai/dsh-session/repair.js` appended a
synthetic `TOOL_OUTCOME_UNKNOWN` result. The plugin's client module also disappeared from the browser boot manifest
(60 entries, ours absent, `/plugins/??dsh-turn-performance-meter/client.js` 404).

**Mechanism.** `reloadPackage` selected its target from the loader module cache with two rules: the key must *contain*
the package name and must *end with* `/lib/index.js`. This package's host entry is the root `index.js`
(`exports["."]`), so the only cache key that could satisfy both rules was another package's — and the dev-only fixture
recorder lives *inside this repository* at `dev/fixture-recorder/lib/index.js`, whose realpath URL contains
`dsh-turn-performance-meter` and ends with `/lib/index.js`. The first call therefore disposed this plugin's fiber and
rebuilt it with the recorder's module (`registry 无 runtime，entry.fiber 直接重建（state=1）`): the client row was
dropped (that branch returned without `refreshClientRow`/`notifyClientRebuilt`), the browser lost the bundle, and the
recorder came back to life. The recording for this session resumes at exactly the reload's own result timestamp
(01:28:09.282) after a 73.7 s gap, which is what fixes the identification. The second call then rebuilt again, wrote
its audit line (`activeEntry=none`) and its success counter at 01:29:31, and the process stopped making progress:
no session event, no injector log, no fixture row after that instant. The operation lock was *not* involved — a
probe call for a non-existent package name returns immediately.

**Fix (local injector, `Plugins/dsh-routing-suite`).** `src/index.ts` and the loaded artifact
`injector-release/lib/index.js` now resolve the target by the entry's own package identity: `packageRootOf` →
`declaredEntryOf` (`exports["."]` → `main` → `./index.js`) → candidate URLs must live inside that root at depth ≤ 2,
so a nested `dev/<sub>/lib/index.js` can never shadow the package. The freshness pre-check now uses the package root
rather than `dirname(dirname(entryUrl))` (which pointed one directory above for a root entry), the watcher pre-check
probes the declared entry instead of a hardcoded `lib/index.js` (the source of dozens of `watch-precheck-blocked`
lines), and the `registry 无 runtime` repair branch now performs the same `refreshClientRow` +
`notifyClientRebuilt` hand-off as the standard path.

**Verification.** A temporary decoy package at `dev/decoy-probe/lib/index.js` (the collision shape, injected and then
removed) was present during the reload: `OK: dsh-turn-performance-meter 热重载完成（清缓存 2 模块，重建 1 fiber）`,
`client ✓ (dsh-turn-performance-meter/client.js)`, and `reload-debug.log` reports
`activeEntry=include:turn-performance-meter fiberState=active` — against `activeEntry=none` before the fix. Purging the
module cache first exercises the repair branch, after which the browser still served the bundle (200) with a fresh rev.
The injector itself was updated by self-reload, confirmed by the new generation's startup audit lines.

### 2. A page that attaches mid-turn left the live meter hidden

**Symptom.** Reloading the GUI while a turn was streaming left the dock empty for the rest of that turn. The plugin was
mounted (its style tag was in the document, `attach` succeeded, 11 886 notifications and 4 513 renders were counted)
but `controller.project()` returned `{kind:'hidden', state:'inactive'}` throughout, with `droppedDeltas` at 11 552.

**Mechanism.** The published window is a live *tail*, so a page that attaches mid-turn never sees the open turn's
`turn/start`. `reduceLiveUi` discards every turn-scoped event while the machine is `inactive` (`wrongTurn`), and
`controller` drops deltas whose turn has no record — correctly refusing to fabricate a start time, but with the
consequence that the whole turn is invisible to this page instance.

**Fix.** The boundary is now *derived* from evidence the page does have: the first transient row naming a turn the
feed is not tracking is adopted (`SessionEventFeed.adoptTurn`) and emitted as a `turn-start` carrying
`recovered: true` and `timeMs: null`. `reduceLiveUi` opens an adopted turn in `waiting-model` with `ttftFrozen: true`,
so the TTFT stopwatch is never restarted from the reload; `LiveMeter.turnElapsedMs` and the presenter's `elapsedMs`
are `null` rather than `0` when the start is unknown, and the pill omits the elapsed run entirely.

Adoption is bounded on three sides, because the synthetic boundary must never outrank real evidence. It happens once
per turn: the feed tracks the open turn, so ten thousand further rows of turn 42 produce one boundary, one attempt
identity and ten thousand deltas. A row naming no finite turn adopts nothing — there is no identity to adopt, and
guessing one would attach this client's deltas to a turn it cannot name. And a turn this client has finished with is
never re-opened: `turn/end` records the turn in `settledTurns`, and a late transient row of it is dropped and counted
as `transient-row-of-a-finished-turn` rather than delivered into a settled record or allowed to re-show a live meter.
That guard is per turn identity and ordering (`highestTurn`), not a global "no adoption after any `turn/end`", so a
following turn 43 is adopted normally; both guards are generation state and are reset by a `replace` rebaseline.

**Authoritative upgrade.** The adopted record opens with `startMs: null`, and `beginTurn` is idempotent — a replayed
durable boundary must not discard the samples already observed for the turn — so the durable `turn/start` arriving
*later* (a reconnect, or the tail sliding back over the row) needed its own step: `TurnTelemetryStore.turnStartObserved`
and `LiveMeter.turnStartObserved`, both called from the controller's `turn-start` branch. The upgrade is one-way (an
observed start is never replaced by a later synthetic or absent one, because a turn has exactly one start) and it
recomputes rather than restarts: `firstTokenMs` keeps the timestamp its delta already carried, the rolling window is
not reset, and elapsed and TTFT are the same arithmetic on the same evidence — merely computable now. `recovered` is
emitted exactly once per turn, which is what makes the inverse impossible by construction.

**Completed card.** The card's TTFT is `first model-producing delta - turn/start` over observed evidence only. If the
durable `turn/start` never entered this client, TTFT is `unavailable` and renders as an em dash: a settlement's stream
timestamps say when a delta was produced, never when the turn started, so deriving a TTFT from them would silently
substitute "time since the reload" for the metric.

**Verification.** Twelve tests in `test/mid-turn-reload-recovery.test.js` plus rewritten cases in `dsh-client-feed`,
`live-state`, `live-metrics` and `runtime-robustness` pin adoption, single adoption over ten thousand rows, the
event order (an attempt boundary must not reach a presenter that is still `inactive`), the no-identity drop, the
finished-turn drop, future-turn adoption, unknown-not-zero elapsed, the authoritative upgrade and its refusal to
downgrade, and both completed-card TTFT paths. In the browser, reloading the page mid-turn now renders the live pill
(`data-kind="live"`, tool-stage timer and TPS from observed deltas) with no fabricated turn elapsed.

## Phase 7A.1 — Final correctness closure (external audit, 2026-09-26)

A second independent audit, run against the pushed Phase 7A history (`05ffd0d`, `c4c8ef0`, `c0d2a60`), confirmed the
Phase 7A work is on `origin/main` and found two further correctness defects. Both are recorded below with the
counterexample that establishes them, the behaviour that shipped, and the invariant that replaces it. Neither is a
styling or preference question: in both cases the code did something other than what its own documentation said.

### 1. A global peak in a one- or two-vertex run could be starved (BLOCKER A)

**Counterexample.** `allocateRunBudgets(runs, 512)` over 173 runs: 170 ordinary three-vertex runs at indices `0..169`,
then three singleton runs at indices `170`, `171`, `172` carrying 10, 20 and **9999** tokens/s. The last one is the
chart's global maximum.

    old budgets      indices 170,171,172 = [1, 1, 0]      <-- the peak run is refused
                     allocated 512, degraded [172]
    new budgets      indices 170,171,172 = [1, 1, 1]
                     allocated 510, degraded [169]        <-- an ordinary long run yields instead

**Old behaviour.** The allocation ran in two passes partitioned by run length. The first seated every run with
`length >= MIN_MAX_POINTS` (3) in priority order, where the peak-bearing run ranked first; the second served the one-
and two-vertex runs **in raw index order**, with no priority at all. `MIN_MAX_POINTS` is a property of run *length*,
so the peak band existed only inside the first pass and vanished exactly at the class boundary: a singleton was
skipped by the anchor pass for being short, then competed as an ordinary run on index alone. The 170 long runs consumed
510 of the 512 vertices, and the two singletons ahead of the peak took the remaining two. The chart printed `≈9,999`
and drew no vertex at that rate — the precise failure `MAX_RENDER_POINTS_TOTAL` was introduced to prevent, and the same
defect the marker work in the log's limitation 13 had closed one layer down.

The scenario is not exotic. `compressAttempts` gives an attempt zero width when it produced a single delta, so a
one-vertex run is what a retry, an abandoned prefix or a single heavy delta produces routinely — and a *saturated*
chart, where the allocation decides anything at all, is exactly the chart with many such runs.

**New invariant.** There is one priority order over all runs, and the peak band is a property of it rather than of a
stage. Every run is denominated in its irreducible cost `minimumRunCost(length)`: `0` for an empty run, `1` and `2`
for a run of one or two vertices (already at full resolution — `downsampleSeries` refuses a smaller budget, and
duplicating a vertex to reach three would draw a segment the data does not contain), and `MIN_MAX_POINTS` for anything
longer. Runs are ranked by peak band first, then by cost, then by length, then by original index, and the seating pass
hands out that cost in that order. A run is therefore either refused (`0`) or drawable at a value its own anchor
contract can honour, and **the peak-bearing run has the highest retention priority whatever its length**: if any run is
drawable, it is.

**Explicit degradation.** `allocateRunBudgets` now also publishes `peakIndex` and `peakRetained`. The second is `false`
only in the formal corner where the peak run's own irreducible cost exceeds the entire budget — unreachable at
`MAX_RENDER_POINTS_TOTAL` = 512, where the cost is at most 3 — and it exists so that corner cannot be reported as a
preservation. `curveViewModel.peak` follows the same rule from the other side: `value` is still the full-series maximum
(a drawing budget may not move a reported statistic), but `x`/`y` are placed only when the leading series' strongest
*drawn* vertex is that same measurement, and are `null` otherwise. A missing dot is visibly missing; a dot on a weaker
vertex is the misleading outcome the position guard removes.

**Chart-wide element bound.** `curve.drawnPoints` counted every budgeted vertex, singleton runs included, while
`curveViewModel.drawnPoints` counted path vertices only and published markers separately — the same name for two
different quantities, and the bound `drawnPoints <= 512` could be asserted while every marker sat outside it. Both
meanings are now stated where they are defined, and the bounded sum is its own published field:
`renderBudget.elementPoints` = `lineVertices` + `markers` in the settled snapshot, and `renderElementPoints` in the
view model. Through the real pipeline with 404 runs the accounting is `lineVertices` 509 + `markers` 3 = **512**.

**Verification.** `test/curve-peak-priority.test.js` (15 tests): the frozen cost ladder, the counterexample above as a
pure-function regression; a two-vertex and a long peak run under the same saturated budget; the peak first and last in
input order;
an equal peak resolving to the earliest run; determinism across repeated calls; and the contract sweep over
1/2/3/40-vertex runs at 1, 3, 17, 100, 170, 200 and 400 runs, asserting the bound, the absence of an unrunnable 1- or
2-vertex allowance for a longer run, and that refused runs stay exactly `0`. Four further tests drive the same
counterexample through `TurnTelemetryStore -> settled.curve -> curveViewModel -> completedTree`, where the peak is a
genuine one-vertex run produced by the real clock: 200 output stretches, 200 reasoning stretches, three one-delta
attempts and a successor attempt (the successor is what collapses the peak attempt's episode to a single instant, so
the construction uses the pipeline rather than a hand-built snapshot). They assert that the peak run is drawn, that
`renderBudget.peakRun` names it, that `peakTps` is its rate and not a long run's, that the printed `≈9,999` sits on the
marker whose own `data-tps` is `9999`, and that no other marker or vertex shares the peak dot's coordinate.

### 2. A window `replace` replayed evidence into the store that owned the previous generation (BLOCKER B)

**Counterexample.** One controller, one session.

    generation 1     durable turn/start(turn 1, 1000)
                     transient a@1100 "x"                 -> attempt a holds 1 sample
    replace          the same two rows, republished as a new window generation
    old result       attempt a holds 2 samples
    new result       attempt a holds 1 sample

**Old behaviour.** `SessionEventFeed.rebaseline()` clears its durable-sequence dedupe, its transient identity set, its
open-turn and open-attempt state and its turn-ordering watermarks, then replays the replacement window — and
`test/dsh-client-feed.test.js` asserts exactly that, because a `replace` is defined as a new authoritative window
generation. The controller honoured the presentation half of the same boundary (`presenter.reset()`,
`currentRecord = null`, `openAttemptId = null`, `invalidate()`) but left `TurnTelemetryStore` untouched. The evidence
lives in the store: `store.turns` holds the attempts, samples, usage and tool intervals, and `store.liveBySession`
holds the rolling window, the frozen TTFT stage, the turn start and the running tool set. Replaying into that state
re-entered attempts that already existed — `beginTurn` is deliberately idempotent so that re-observing a durable
`turn/start` does not discard samples, and `beginAttempt` returns the existing attempt for a known `attemptId` — so each
replayed delta was **appended** rather than replacing. The turn then reported one sample per republication of the
window, and every derived quantity followed: tokens, the curve, the settling attempt's stream, the completed card.

**Why not a dedupe key.** A cross-generation key over `timeMs + text`, `attemptId + time` or a serialized chunk would
mask the symptom while leaving the previous generation's state in memory, which is precisely the state the replacement
window is authoritative about. Stable dedupe is a wire-safety measure; it is not generation ownership.

**New invariant.** The store has the same generation boundary the feed has:
`TurnTelemetryStore.rebaselineSession(sessionId)` removes that session's turn records and its `LiveMeter`, and the
controller calls it **before** the presenter reset:

    store.rebaselineSession(sessionId)   evidence: attempts, samples, usage, tools, live window
    presenter.reset()                    presentation: the UI state machine
    currentRecord = null                 routing
    openAttemptId = null                 routing
    invalidate()                         memoized projections
    ... the feed replays the replacement window from scratch ...

The scope is one session. Two sessions run concurrently with independent windows, so a rebaseline of one is not
evidence about the other; `dispose()` remains the store-wide reset and is a different operation with a different
meaning. Clearing only `currentRecord` would not have been enough — it is a pointer, not the evidence — and clearing
the whole store would have been wrong for the same reason the session key exists.

**The property that matters.** After a `replace`, a controller must be indistinguishable from a fresh controller that
loaded the replacement window directly:

    controller-after-replace  ==  fresh-controller-over-replacement-window

**Verification.** `test/rebaseline-generation.test.js` (12 tests, all controller-level through
`fakeSessionsService()` + `createController()`, not the feed alone): the counterexample; sample counts equal to a fresh
controller's; a shorter replacement window not retaining the delta it dropped; a replacement window that begins
mid-turn re-adopting the open turn with an unknown start (`elapsedMs === null`, never `0`) and a rebuilt live rate; a
recovered record still upgrading when the authoritative `turn/start` arrives in the new generation; a completed turn
rebuilt by a replace comparing **deep-equal** to a fresh controller over the same window, on both the telemetry and
the rendered card, with one attempt, the settlement's own delta timestamps and `generatedTokens === 40` rather than
double; a completed-only window yielding the card and no live meter; tool state absent from the window not surviving
it; a rebaseline of session A leaving session B's record, settled snapshot and rendering identical by identity;
idempotence over three consecutive replaces; an empty replacement window leaving nothing behind; and
`rebaselineSession` itself, including its no-op on an unknown session and its refusal to disturb an unrelated one.

### 3. Verification for this round

`npm run build:client` rebuilds `client.js` and `lib/client.js` (371 340 bytes) from the repaired source, and
`npm run verify` reports the structure check green with **535 tests, 535 pass, 0 fail**. The 508 tests of the
`c0d2a60` baseline are all retained and passing; the 27 added here are the two files above. The frozen behaviours of
Phase 5–7 were re-run unchanged: the 0 ms / 3000 ms episode-opening arithmetic (100 tokens/s at the second opening,
never 200), the attempt-boundary and retry matrix, the mid-turn adoption and authoritative-upgrade suite, the
completed-card reconstruction suite, and `SLOT_ORDER === -10`.

## Phase 7B — Browser, E2E and visual verification (2026-09-26)

Verified against a **freshly started** `dsh web` process on port 50002 through the normal plugin path
(`link:E:/Projects/DSHarness/dsh-turn-performance-meter`, listed in the profile's `dsh.profile.bundles`). The local
injector's `dev_reload_package` was deliberately **not** used as evidence for this round: its repair is not
upstreamed and its release artifact is not reproducibly rebuilt, so it cannot certify a shipped loading path. Normal
load was proven from the served module in the plugin batch response (`meterModuleIndex` 226 of 430 in batch revision
`071dce77e1de`), gated on build-specific markers that exist in no earlier build — the corrected peak-tie comment, the
corrected ascending-length ranking prose and the corrected all-zero-peak prose, with all three superseded claims and
any merge-conflict markers absent. DSH transpiles each client bundle on serve, so the served module is not
byte-identical to the pre-merged `client.js`; freshness is therefore proven by markers, not by a whole-file digest.
`client.js` and `lib/client.js` are byte-identical to each other (SHA-256 `C3FB38DF…7AA69B`).

Measured on the real rendered UI: the meter occupies `conversation.input.dock` and precedes every task-state card in
that slot — `meter → todo → goal → queue → composer`, with `todo` 0, `goal` 10, `queue` 20 and the composer after
`input.dock`. Both slot wrappers are `display: contents`, so every occupant is a direct flex item of the
`composerStack` (flex column, `gap: 6px`); the measured inter-element gap was 6 px in every state, including between
the meter and the composer, and the previously observed orphan band did not reproduce in any state. The full
`meter → todo → goal → composer` stack was observed directly on the everyday instance; no queue card appeared as a
child of `conversation.input.dock` in either instance, so the queue-containing combinations are supported by the slot
contract plus the measured uniform gap rather than by direct observation. Multi-session isolation was verified
separately below.

Production presentation cadence is `DEFAULT_PRESENTATION_REFRESH_MS = 50` with no diagnostic override present, and
the browser confirms it: DOM write intervals on the TTFT counter and on the live pill measure p50 48.5–51.7 ms across
the reasoning, tool-running and waiting-model states. The tool wall timer prints tenths, so its writes land on a
~100 ms grid. Reported frame statistics are not usable from this round — the automation tab was backgrounded and
Chrome throttles `requestAnimationFrame` to ~1 Hz — so cadence is evidenced from timer-driven DOM writes instead.

Live semantics held in the browser: `data-state` walked
`pending-first-token → streaming-reasoning → streaming-output → tool-running → transition → waiting-model →
streaming-reasoning → streaming-output → completed`; TTFT appeared only before the first generated delta; the tool
window contained no TPS number at all, only the wall timer and the turn elapsed counter; and a later attempt did not
restart TTFT. Three 10.3 s tool calls produced a 31.0 s union and three 20 s calls a 40.7 s union, consistent with
the footer arithmetic. An interrupted turn rendered its full card with `data-status="interrupted"`; a deterministic
provider error was not reproducible without fabricating one.

A mid-turn reload driven by `location.reload()` the instant `data-state` became `tool-running` (confirmed by
`navigation[0].type === 'reload'`) recovered honestly: the meter reappeared, the turn was adopted, the tool wall
timer and the turn elapsed counter continued from the durable record (7.3 s → 56.9 s), no `0 s` elapsed and no TTFT
were fabricated, and the turn settled into a coherent card. Interaction, theme, viewport, host font-size and locale
matrices were measured from bounding rectangles rather than asserted: no horizontal overflow, no clipping, no
overlap with the composer or with native `StatsPills`, cell text collisions zero and truncation zero at 1652×880,
1440×950, 1280×800, 1024×768, 768×900, 520×900 and 390×844, with the four columns reflowing from one row to a 2×2
grid between 768 px and 520 px (measured 4 columns at 768 px, 2×2 at 520 px and at 390 px) and the card height
staying a function of the breakpoint (149.29 px in one row, 239.6 px in two). The host font control
scaled the meter's own type scale through `--dsh-content-font-size-secondary` (11 / 13 / 15 px) with no collision,
and the English locale produced `Reasoning TPS / Output TPS / Generated Tokens / TTFT` with identical geometry and
identical metric values. All settings touched during the round (appearance, font size, language) were restored.

The chart budget was cross-checked against the DOM rather than trusted from `curve.renderBudget`: a completed chart
reported `data-points="64"` and the SVG contained exactly 64 vertices across five `dsh-tpm-series` paths plus one
singleton marker — 65 element points against the 512 ceiling. Accessibility measured in the browser: one focus stop,
`role="group"` with `aria-label` and `aria-description`, per-cell descriptive labels, `aria-hidden` on the hidden
layer and on the SVG, a 2 px accent focus ring, and 100 hover/focus cycles with zero card-height drift, zero style
tag growth and no scheduler or timer leak.

### 1. Three stale source comments corrected

Three comments contradicted the code they described. Only prose changed; no runtime behaviour was touched, and each
existing rule was frozen by an added test rather than by altering the implementation.

| Site | Claim | Code | Action |
| --- | --- | --- | --- |
| `src/client/completed/curve-view-model.js` | "Ties resolve to `output`" | strict `>` over a reasoning-first pair resolves a tie to `reasoning` | comment corrected; `test/curve-view-model.test.js` freezes the tie to `reasoning` and its marker position |
| `src/core/curve.js` (`allocateRunBudgets`) | "a dense run is preferred over a flat one of the same cost" | `left.length - right.length` serves the **shorter** run first | comment corrected; `test/curve-peak-priority.test.js` freezes the ascending-length tie-break |
| `src/core/curve.js` (`allocateRunBudgets`) | "a chart whose every rate is zero or non-finite has no maximum" | `peakValue` starts at `-Infinity`, so finite `0` is accepted and an all-zero chart has a `peakIndex` | comment corrected |

The peak-tie rule is one rule at two levels rather than two rules: `buildSeries` resolves an intra-series tie to the
earliest vertex with the same strict comparison, and the series-level leader resolves to the series scanned first.
The length tie-break is load-bearing rather than decorative — every run longer than `MIN_MAX_POINTS` costs exactly
`MIN_MAX_POINTS`, so cost alone cannot separate long runs and the shorter one is genuinely served first. The added
test discriminates the corrected reading from the superseded one: the same two runs in either input order receive
the same per-run allowances, which a longest-first ranking could not produce.

### 2. A core-metric contradiction found in the browser (not fixed here)

The completed curve's printed peak is inconsistent with the same snapshot's own token counts. For turn 5 the settled
record reports `generatedTokens: 365` over a curve span of 1530 ms — a mean of 238.6 tokens/s — while `peakTps` is
**63.75**, i.e. 0.267 of the mean. A maximum cannot fall below its own mean, and the same card prints
`reasoningTps 157.2` and `outputTps 325.7`, with the live pill observed at `≈326 tokens/s` during the output phase
of that very turn. The evidence is the plugin's own debug snapshot
(`window.__dshTurnPerformanceMeter.controller.store`, turn 5) cross-checked against the session log, which records
320 reasoning tokens delivered inside a ~1.28 s stream. No existing test bounds `peakTps` against the mean, the phase
totals, or the live series, so the contradiction is untested rather than newly introduced.

This is a **core metrics** defect — token accounting, rolling-window semantics or the shape/calibration path — and
Phase 7B is not permitted to change those. It is recorded here as a blocker for Phase 8 with its reproduction rather
than patched, because a fix chosen without establishing the intended semantics would be a guess about a frozen
contract. The suite is deliberately left green: the honest artefact is a documented repro, not a red test asserting
behaviour nobody has yet decided.

### 3. Multi-session isolation

Two conversations were driven through real turns in the fresh instance while an in-page poll sampled the DOM 5–7 times a
second, recording the active session key, meter count, every meter's `data-kind`/`data-state`/`data-turn`/`data-session`,
the `input.dock` child count, the rendered tool-row count and the plugin style-tag count. Session A ran a live turn (four
sequential 30 s tools) while session B was created and settled its own turn 1.

Session B's entire 19-sample history contains only its own states — an empty session with **no meter at all**, then
`pending-first-token`, then `completed` — and none of A's signatures ever appeared under B's key. Across all 340 samples
both sessions held exactly one `.dsh-tpm-root`, one `input.dock` child, one plugin style tag and one slot wrapper, so no
meter, slot entry, style tag or subscription symptom was duplicated. Session B's rendered tool-row count stayed at 0
throughout, so no tool label crossed over, and switching back to A restored A's card rather than B's.

Timer behaviour under repeated switching was measured directly. Session B's settled card was byte-identical across a 12 s
idle window, so a frozen card does not advance. After a 12.9 s absence, session A's turn had settled at `总用时 149.6s`
with `工具 4 · 121.3s · 模型调用 5` — the four sequential 30 s tools plus the model calls, with the 12.9 s spent viewing
session B contained inside that window rather than added twice. No reset and no double count on reattach.

Two things were **not** exercised and are not claimed: two sessions streaming simultaneously (A was already in its tool
phase when B's turn began), and a real session-window replace/reconnect, which needs DSH internals to reproduce
deterministically. The controller tests remain the deterministic evidence for rebaseline reachability. Evidence is in
`dev/screenshots/phase7b/phase7b-session-isolation.json`.

### 4. Verification for this round

`npm run build:client` rebuilt `client.js` and `lib/client.js` (372 739 bytes each, identical SHA-256) and
`npm run verify` reports **538 tests, 538 pass, 0 fail** — the 535 of `331968d` plus three added here. Browser
evidence, including the layout/measurement JSON and the screenshots, is kept under `dev/screenshots/phase7b/`, which
is gitignored.

## Phase 7C — Curve metric and rendering repair (2026-09-26)

An external audit of `b7bda66` found three defects in the completed curve. They are recorded here in the order the
audit stated them, each with the counterexample that establishes it, because in all three cases the shipped behaviour
looked plausible: the chart drew *a* curve, and the arithmetic that produced it was wrong.

### 1. The completed curve was drawn in the raw magnitude system (Finding A)

Two magnitude systems live in this project. `sampleFromChunk` attaches a raw **shape weight** to every streamed delta —
`heuristicTokenWeight`, 0.25 per Latin code point and 1 per CJK one, a documented coarse prior that is explicitly *not*
a tokenizer. `calibrateAttemptSamples` replaces those weights with a **calibrated** per-delta allocation once
authoritative usage is known, whose integral over an attempt equals that attempt's `outputTokens` exactly.

`aggregateTurn` builds every published number from the second: `generatedTokens`, the per-phase token counts,
`reasoningTps`, `outputTps`. `settle()` built the curve from the first, because it called
`compressAttempts(record.attempts)` — the raw evidence — while the calibration lived on a *copy* of the same samples in
`attemptBreakdown[].calibration.samples`. A card could therefore print `Generated Tokens: 900` beside a curve whose
whole integrated area was 200, and the `≈` peak was read off the smaller of the two systems.

Counterexample, frozen in `test/curve-calibration.test.js` and observed failing against `b7bda66`: one attempt, two
400-character deltas at attempt-local 0 ms and 500 ms, settled with `outputTokens: 900, reasoningTokens: 0`.

| Quantity | Value |
|---|---|
| raw shape sum | 200 |
| provider `outputTokens` | 900 |
| calibrated samples | `[450, 450]` |
| old `peakTps` | **200** |
| expected calibrated peak | **900** |

The failure message on the old commit was `the peak is the calibrated total-window rate: 900 tokens/s, not 200 —
200 !== 900`.

**The corrected pipeline.** A new module, `src/core/curve-source.js`, is the join and nothing else: it takes
`record.attempts` and `aggregate.attemptBreakdown`, returns the attempts with `calibration.samples` substituted for the
raw ones, and performs **no** scaling of its own. A second calibration algorithm inside `settle()` would be free to
drift from the one the printed totals use, which is the defect being removed. The join is positional — the breakdown is
`attempts.filter(isContributingAttempt).map(reduceAttempt)` — and it is verified wherever both sides publish an
`attemptId` or a `step`, plus a sample-count check. A disagreement degrades the **whole** join to the raw shape and
reports every symptom in `curve.source.issues`, rather than attaching one attempt's calibration to another, because a
partial join would leave the curve measured in two systems with nothing on screen to say which vertex belonged to
which. The raw samples are never mutated: they remain the provenance.

Invariants now asserted in `test/curve-source.test.js` and `test/curve-calibration.test.js`: with usage, the calibrated
samples sum to `outputTokens`; with an exact split, the reasoning samples sum to `reasoningTokens` and the rest to
`outputTokens - reasoningTokens`; with `outputTokens` alone, one common scale is applied, the split stays `estimated`
and the combined samples still sum to the provider total; with no usage, the magnitudes stay the raw shape and
`calibratedForCurve` is `false`, inventing nothing.

### 2. Live and completed curves measured different rates (Finding B)

`LiveMeter` holds **one** `SlidingWindowMeter` per active attempt and feeds it every generated sample — reasoning
deltas, text deltas and tool-call argument deltas alike. `streamingPhase` only *labels* the newest sample. The live TPS
is therefore the total generated tokens of the active attempt whose timestamps lie in `(t - 1000, t]`.

The completed curve built `perAttemptSeries(..., phase: 'reasoning')` and `perAttemptSeries(..., phase: 'output')`
separately. At a reasoning→output transition the live window held `reasoning + output` while the reasoning line held
`reasoning` and the output line held `output`; neither drawn line equalled the live measurement, and `peakTps` took the
larger of two partial rates — structurally below the rate the same session displayed live.

Counterexample, frozen in `test/curve-total-rolling.test.js`: 400 calibrated reasoning tokens at attempt-local 0 ms and
400 calibrated output tokens at 500 ms, against a 800-token provider total.

| Quantity | Value |
|---|---|
| live / corrected total window at 500 ms | `400 + 400 = 800` tokens/s |
| old reasoning-only line at 500 ms | 500 |
| old output-only line at 500 ms | 500 |
| old published peak | **500** |
| corrected published peak | **800** |

**The corrected pipeline.** `perAttemptSeries` and its `phase` filter are gone. `attemptTrace` builds one
attempt-local trace per call with `totalRollingTpsSeries`, which sums every sample of the attempt whatever its phase
and labels each vertex with `activePhase` — the phase of the latest generated sample at or before that instant, which
is exactly `LiveMeter.streamingPhase`. A phase is now a **colour** of one measurement, never a second rate. The
half-open window, the shifted tail grid and the per-attempt clamp are unchanged from Phase 6/7; the total sum and the
label are what changed.

`test/curve-reference-window.test.js` was rewritten around the total window: the independent reference is the literal
definition over all phases, with the body ladder plus the one-step-shifted tail ladder and **no** episode partition,
compared vertex by vertex in both directions.

### 3. The trace was fragmented, and so was the drawing of it (Finding C)

The user-facing symptom was a chart, not a number. The real screenshot showed dozens of disconnected short gray/orange
traces, repeated saw-tooth restarts and many large orange singleton dots near the baseline, against a reference that
reads as one throughput trace whose tone changes by phase.

The structural cause was that the drawing unit was the **phase episode**. Each phase's samples were partitioned into
episodes by the rule "a gap longer than one window separates them", every episode became its own run with its own
one-window tail, and each run was measured separately. A turn of `n` calls with `k` phase alternations produced on the
order of `n × k` short traces instead of `n` traces; a silence inside a call became a **blank region** between two runs
rather than a decay to zero; and every episode holding a single grid vertex became a large marker.

**The corrected geometry.** The attempt's trace is the statistics; the phase segmentation is applied to it afterwards:

```
attemptTraces        one total rolling trace per attempt
  -> visualRunsOf    phase-coloured cuts, seams shared
  -> allocateRunBudgets   chart-wide 512-vertex bound
  -> downsampleRun   per run, both seams reserved
```

`visualRunsOf` cuts at the **midpoint** of each label change, rounded down. Cutting at the first vertex of the new
label would leave the runs separated by exactly the silence — a visible hole on the 250 ms grid — and cutting at the
last vertex of the old label would paint a four-second silence entirely in the outgoing tone. The midpoint does neither:
the outgoing run keeps the earlier half and the incoming run the later half, and the two meet on **one shared vertex**,
one object emitted by both subpaths. A phase change with no silence between its samples — the ordinary case — still
produces adjacent runs sharing the transition vertex. The invariants are
`runs[i].endIndex === runs[i + 1].startIndex` and
`sum(runs[i].pointCount) === points.length + (runs.length - 1)`, both asserted. `downsampleRun` reserves a run's two
endpoints so thinning can never drop the shared seam and reopen the gap it exists to close.

Once the singleton runs stopped being manufactured by the geometry, the marker sizing became the remaining half of the
visual defect. Ordinary single-measurement markers are now `0.24 × font` at opacity `0.75`; a singleton that *is* the
published peak keeps `0.42 × font` at full opacity, so it coincides exactly with the peak dot instead of leaving a ring
of the larger circle behind it. `data-peak` carries the distinction.

`test/curve-long-agent-visual.test.js` replays a 24-call, 23-tool turn with a four-second stall inside every fourth
call and measures the chart a reader experiences: two subpaths per call sharing their seam, the stall adding no
subpath, **zero** singleton markers on the corrected chart, the same evidence producing 18 markers and strictly more
subpaths under the rejected rule, and the whole chart inside `MAX_RENDER_POINTS_TOTAL`.

### 4. The live/completed equivalence contract was too strong

Phase 6 asserted that the live pane and the completed card report numerically identical TPS at every attempt-local
instant. That was true while both read the same shape weights, and it became false the moment the completed curve was
calibrated: live uses the heuristic shape because nothing else exists while the model is still streaming, and completed
uses the provider-anchored allocation. Demanding equality would forbid the calibration the printed totals depend on.

The contract is now stated in two parts. Numeric equality is mandatory when no authoritative usage exists, or when the
calibration scale happens to be 1 — asserted in `test/curve-total-rolling.test.js`, which feeds both sides the same
calibrated magnitudes and requires every vertex to match. Otherwise a common scale may separate them, and what must
remain identical is the **shape**: which instants are sampled, where attempts begin and end, the one-second window,
where phase transitions fall and where stalls fall. `test/curve-attempt-boundary.test.js` asserts that part directly,
by driving the live meter and the completed curve from one stream and comparing the normalised shapes together with the
exact scale factor.

### 5. The "peak ≥ mean" reading is withdrawn

The Phase 7B report observed `peakTps` below `generatedTokens / curveSpan` and argued that a maximum cannot fall below
its own mean. The observation was correct and the generalisation is not: a one-second rolling rate is normalised to a
fixed window, a phase average uses a different active-duration denominator, a very short attempt can have a phase
average above its own one-second-window rate, and combined token totals and phase-specific denominators are not
interchangeable. The invariant is **not** frozen as a test. What replaced it is the independent brute-force reference:
for every instant on every attempt's reference grid, sum the calibrated tokens strictly inside `(t - 1000, t]` across
all phases, reset at every attempt, and take the maximum; `curve.peakTps` must equal it, and the production sampler is
used on neither side of that comparison.

The Phase 7B reproduction itself is kept as a diagnostic test (`test/curve-calibration.test.js`), on a scenario that
reproduces the contradiction rather than the provider timings:

| Quantity | Value |
|---|---|
| raw heuristic sample sum | 200 |
| provider `outputTokens` | 365 |
| calibrated sample sum | 365 |
| calibration scale | 1.825 |
| old per-phase raw peak | **100** (each phase's share; the total would have been 200) |
| new calibrated total-window peak | **365.2** |
| turn mean rate (`generatedTokens / curveSpan`) | 291.8 |

The old peak sat below the turn's own mean, which is the contradiction; the corrected peak is the trailing-window total
and equals the independent reference.

### 6. Summary rate formulas are unchanged

This round did **not** redefine the four summary metrics. Reasoning TPS is still `sum(reasoning tokens) /
sum(reasoning active generation duration)` and output TPS is still `sum(non-reasoning output tokens) / sum(output
active generation duration)`; they are phase **averages**, and the curve is a different diagnostic — an attempt-local
trailing-one-second total throughput trace, colour-coded by active phase. The distinction is now stated in
`docs/METRICS_SPEC.md` §8.2 and `docs/UI_SPEC.md` §6.2 because the two were being read as one number. TTFT, the
toolWall/toolWork split, the 50 ms presentation cadence, `SLOT_ORDER = -10`, the `conversation.input.dock` seat,
turn-level token semantics, tool-call argument inclusion, `rebaselineSession` and session isolation are all untouched.

### 7. Browser validation on a clean host

A second `dsh web` was started at `127.0.0.1:50003` through the normal path
(`dsh web --port 50003 --no-open`) — no `dev_reload_package`, no hot reload — and three turns were driven
from that page's own composer. The plugin's bundle entry on that page was
`/plugins/??dsh-turn-performance-meter/client.js&rev=64b948490bb1b69a-47`, the live pill rendered on the first
turn, and no `dsh-tpm` console error occurred in any of them. Every reading below comes from the DOM of that
live page; the captures and the full measurement table are under `dev/screenshots/phase7c/`, which is gitignored.

| Turn | Calls / tools | `generatedTokens` | `peakTps` | Paths | Path vertices | Singleton markers |
|---|---|---|---|---|---|---|
| long-agent-1 (sparse recording) | 10 / 9 | 1 007 | 141 | 2 | 10 | 8 at 3.11 px |
| long-agent-2 (`curve-long-agent.jpg`) | 11 / 10 | 6 406 | 370 | 19 | 152 | 0 |
| simple-1 (`curve-simple.jpg`) | 1 / 0 | 2 517 | 413 | 2 | 56 | 0 |

Three readings matter and each closes one of the findings.

**The chart is one trace per call, tone-segmented.** The 11-call turn drew 19 subpaths — nine reasoning stretches
and ten tool-call-argument stretches, one pair per call — meeting on shared vertices, with the resets falling only
at real attempt boundaries. The screenshot reads as a throughput trace whose tone changes, which is the reference's
shape, and the bead field is gone: **zero** singleton markers, against the 18 the rejected episode-based geometry
produces on the same evidence in `test/curve-long-agent-visual.test.js`.

**The peak is above the turn's own mean.** `peakTps` was 370 against a mean rate of 168.2 tokens/s over the same
call, where the Phase 7B turn had 63.75 against a mean of 238.6. This is an observation about one turn, not a frozen
invariant — §5 above states why — but it is the reading that opened the phase.

**A genuinely sparse recording still draws, and now draws quietly.** `long-agent-1` is an unusual stream in which
nine of ten calls produced a single grid instant, so eight of its ten measurements are singleton runs. They are
drawn at 3.11 px with opacity 0.75 — the ordinary marker size, a third of the peak's — and the turn's own peak is
carried by a path vertex rather than by a bead. That is the two-level marker policy working on the case it exists
for, and it is the honest outcome: a one-measurement attempt *is* one point, and hiding it would be worse than
drawing it small.

One apparent anomaly was investigated rather than reported: the corrected chart's runs hold far fewer vertices than
a 250 ms grid over their spans would suggest. It is not a defect. The completed card is rebuilt from the durable
compact stream, whose `dt` gaps are the original delta boundaries, and a burst of tool-call arguments really does
arrive within a few milliseconds — so an attempt whose deltas share an instant has almost no width and honestly
draws two vertices. `test/curve-render-budget.test.js` now asserts the accounting around it
(`lineVertices + markers === elementPoints <= allocated <= total`), which is the pair a reader of the chart cannot
see.

### 8. Verification for this round

`npm run build:client` rebuilt `client.js` and `lib/client.js` and `npm run verify` reports **586 tests, 586 pass,
0 fail**. The 538 of `b7bda66` are retained apart from the expectations that encoded the superseded geometry; every
changed expectation carries its old contract in a comment beside it, and the reasons are §1–§3 above. Both defect files
were observed failing before the production change. The browser pass that closes the visual half is recorded under
`dev/screenshots/phase7c/`, which is gitignored.

One defect was found *while* fixing Finding C and is worth recording because it was invisible until the geometry
changed: `totalRollingTpsSeries` sorted its samples by `activeTimeMs` alone, so when a reasoning delta and a text delta
shared an instant the vertex's `activePhase` depended on the sort's stability — that is, on which chunk the transport
delivered first. The tie is now broken by phase (`output` after `reasoning`), and `test/curve.test.js` asserts that
arrival order cannot change the series.

**That repair is superseded by Phase 7C.1, and the reason is stated here rather than only below.** The phase tie-break
made the completed label disagree with `LiveMeter.streamingPhase` for a stream delivered text-then-reasoning, and the
assertion "arrival order cannot change the series" was true of the rate and false of the label.

## Phase 7C.1 — Final curve consistency closure (2026-09-26)

An external audit of the pushed Phase 7C history (`117bcdd`) confirmed the calibration join and the attempt-local
rolling window are correct, and named three remaining inconsistencies. All three are one kind of defect: the code did
something other than what its own documentation said.

### 1. The final attempt's tail collapsed onto the right edge (BLOCKER A)

**Counterexample.** One attempt, one-second window, 250 ms cadence, deltas at local 0 ms and 500 ms.
`compressAttempts` measured the attempt's compressed width as `last - first = 500`, so `curve.durationMs` was 500. The
trace, however, was sampled out to `bodyEndMs + windowMs`:

    old trace times    0, 250, 500, 750, 1000, 1250, 1500
    old x coordinates  0, 50, 100, 100, 100, 100, 100

`xOf(timeMs, durationMs)` clamps everything above the duration to `CURVE_VIEW_WIDTH`, so **five distinct instants**
became one x coordinate and the SVG closed with a vertical stroke at the chart's right edge that no delta produced.

**Why the rule existed.** `attemptTrace` gave the final attempt `bodyEndMs + windowMs` because nothing followed it to
compete for those coordinates, and cut every other attempt at its successor's `nextStartMs`. The intent — "draw the
decay of the last tokens, which really do contribute to the rate for one window" — is sound about the *window* and
wrong about the *axis*. §8.1 defines the axis as compressed model generation, §7 excludes the host settlement tail from
generation duration, and a vertex past the last delta is post-generation time. The final attempt was also the only
attempt whose own evidence was drawn differently depending on where it sat in the turn: an identical single-delta
attempt drew five vertices when it happened to be last and one when it did not.

**The rule that replaces it, for every attempt.** The sampled instants are the union of the attempt's own cadence
ladder from local zero and **its last model-producing instant**, deduplicated and ascending. The trace therefore ends
where the model stopped producing, and an off-grid endpoint is still a vertex: `0, 250, 500, 510` for a final delta at
510 ms. `segment.hasSuccessor` and `segment.nextStartMs` are deleted — with the tail gone they named the same
coordinate as `endMs`, and a field that exists only to special-case the last attempt is the defect restated.

**What it must not remove, and does not.** A silence *between* two deltas is model-generation time and keeps its full
width: the grid runs across it, the rate decays to zero and climbs again. The distinction is "between deltas" versus
"after the last one", not "short" versus "long". A 4 s intra-attempt stall is asserted unchanged, and a 60 s tool gap
still consumes no width at all.

**Peak.** Removing the tail cannot move `peakTps`, and the test measures that rather than arguing it: the superseded
sampler is reproduced beside the new one, and the two agree on every shared vertex and on the maximum.

### 2. Same-timestamp phase labels followed an arbitrary hierarchy (BLOCKER B)

`totalRollingTpsSeries` and `attemptTrace` both resolved a simultaneous reasoning/output pair with
`comparePhase(a.phase, b.phase)`, a fixed `reasoning < output` order, so `output` won every tie and the completed
label was reproducible. Reproducible is not the same as correct: `LiveMeter.streamingPhase` is the phase of the last
**accepted** sample, so for a pair delivered text-then-reasoning the live pill said `reasoning` while the completed
vertex said `output`, from the same stream.

DSH already carries the order twice — the transient frame index and the durable compact stream member order — and both
reconstruct into `record.attempts[].samples` in that order, because `TurnTelemetryStore.acceptChunk` appends and both
reconstruction paths walk their decoded chunks in sequence. `compressAttempts` now captures that position **before**
any timestamp sort and publishes it per sample as `sampleOrder`; the curve layer sorts by `time`, then `sampleOrder`,
and never by phase. `comparePhase` is deleted.

The consequence is bounded, and the boundedness is the contract: order changes **no magnitude**, because a window holds
every sample at an instant whatever the sequence, so only the label moves. The old assertion in `test/curve.test.js` —
`arrival order cannot change the series` — was true of the rate and false of the label, and is restated as "order
cannot change the numbers; it does decide the label". Durable and live feeds are compared over every recorded fixture
on rate, label and visual tone.

### 3. `curve.source.calibrated` meant "some attempts calibrated" (BLOCKER C)

`curveSource` computed `calibratedForCurve = calibratedCount > 0`, so a turn of three contributing attempts in which
two reported usage was published as a calibrated curve, and `curveViewModel.calibrated` repeated the claim. One third
of that chart was still the coarse shape weight.

The mixed magnitudes are **not** the defect and are not removed. An anchored attempt's estimate is calibrated to its
provider counter, an unanchored one stays the raw shape, both are legitimate best estimates, the peak keeps its `≈` at
every coverage level because per-delta allocation is reconstructed in all of them, and dropping the unanchored attempt
would remove real generation from the chart. What was wrong was the provenance claim, so the claim is now explicit:

    full      aligned, contributingCount > 0, every contributing attempt anchored   calibrated: true
    partial   aligned, 0 < calibratedCount < contributingCount                      calibrated: false
    none      aligned, calibratedCount === 0                                        calibrated: false
    fallback  aligned === false                                                     calibrated: false

`none` and `fallback` are different claims and are never conflated — no provider total exists, versus the evidence
could not be joined — and an unanchored attempt inside an aligned join raises no `issues` entry, because absence of
usage is a magnitude-quality fact rather than alignment corruption. `calibrationCoverage` travels to `curve.source` and
to `curveViewModel`; the compact card shows nothing new, because it already prints the peak with `≈` and a third line
of provenance would be clutter.

### 4. The "midpoint" claim was algebraically a restatement (documentation)

`visualRunsOf` computed a change's boundary as `Math.floor((stretch.last + next.first) / 2)` and described it as "the
midpoint of the label change, so a long silence is divided between the two tones". Every vertex of a trace carries an
`activePhase`, so `next.first` **is** `stretch.last + 1` and the expression always evaluated to `stretch.last`: the
outgoing stretch's own last labelled vertex, shared with the incoming subpath. No real trace could produce the
non-adjacent phase stretches the wording presupposed. The formula and the trailing "final run must reach the last
vertex" patch are gone; the rule is stated directly in the code, in `docs/METRICS_SPEC.md` §8.2.2 and in
`docs/UI_SPEC.md` §6.1. The seam itself is unchanged.

### 5. A latent marker-provenance defect found while fixing the above

`curveViewModel` attached `series` and `tone` to each singleton marker from a hard-coded `{ key, tone }` literal paired
with the **built** series under a `built` field. The top-level `markers` array carried both; the per-series
`series[].markers` arrays did not, because `buildSeries` published the raw `run.marker` objects. Two access paths were
describing the same dot differently. The per-series lists are now a filter of the enriched markers, so the two cannot
drift, and `test/curve-stream-order.test.js` asserts the tone on the series-level list.

### 6. Verification for this round

Three new defect files were written and **observed failing against `117bcdd` before any production change**:
`test/curve-axis-endpoint.test.js` (the right-edge counterexample, whose message reads
`post-generation tail collapses several distinct instants onto one x coordinate; 5 vertices sit at x = 100`),
`test/curve-stream-order.test.js`, and `test/curve-calibration-coverage.test.js`. Together they produced 26 failing
assertions on the old revision.

`npm run verify` reports **625 tests, 625 pass, 0 fail**. The 587 of `117bcdd` are retained apart from 53 expectations
that encoded the superseded axis, the phase tie-break or the partial-coverage claim; every changed expectation carries
its old contract in a comment beside it, and the reason is one of §1–§4 above. `MAX_RENDER_POINTS_TOTAL` is untouched at
512, and the budget only becomes easier to satisfy because the tail vertices are gone.

The browser pass is recorded under `dev/screenshots/phase7c1/`, which is gitignored: a simple single-attempt turn and a
five-call tool-driven turn, both driven from the composer of a clean host, with the DOM geometry and the engine-side
measurements in `phase7c1-measurements.json`. Both charts carry exactly one vertex on `x = 100` — the legitimate final
endpoint — and the served bundle was checked to contain the new rules and none of the three superseded ones.

## Phase 7C.2 — Calibration consistency closure (2026-09-26)

Base revision `534ff8f5b87b6fa635267b860a41fed889951789`, working tree clean, starting suite **625 tests / 625 pass /
0 fail**. Phase 7C.1 is confirmed closed by external audit on all four of its axes; one correctness defect remained, in
provider-phase versus stream-phase contradiction handling.

### 1. `totalAnchored` did not guarantee that the curve sample total was anchored (BLOCKER)

`calibrateAttemptSamples` entered its exact-split branch whenever the provider reported a `reasoningTokens` counter that
was a non-negative number, without ever asking whether the stream had recorded deltas of those phases:

```js
reasoningTotal = reasoningTokens
outputTotal    = outputTokens - reasoningTokens
reasoningSamples = calibratePhase(list.filter(s => s.phase === 'reasoning'), reasoningTotal)
outputSamples    = calibratePhase(list.filter(s => s.phase === 'output'),    outputTotal)
```

With `reasoningTokens = 74` over a stream whose reasoning run had been removed, `reasoningSamples` was `[]` — the
74 tokens were received by no sample — and the output samples were calibrated to `144 - 74 = 70`. The function then
returned `totalAnchored: true` and `totalTokens: 144`, `splitQuality: 'unavailable'`, with a note saying the tokens
were reported but the deltas were absent. The note was honest; the flag was not.

Measured on the patched `t4-reasoning-tool-deepseek-official` fixture at `534ff8f`:

| Quantity | Value |
|---|---|
| provider `outputTokens` | 144 |
| provider `reasoningTokens` | 74 |
| observed phases | `{output: 27}` — no reasoning delta at all |
| old calibrated sample sum | **70** |
| new calibrated sample sum | **144** |

`curveSource` then counted the attempt as anchored, `calibrationCoverage` read `full`, and the turn's curve integrated
to **77** against a printed `generatedTokens` of **151** — the Phase 7C defect (two magnitude systems on one card) partly
reopened through a different door.

The defect is not only reachable by mutation. A sweep of the real recordings found it in
`t6-tool-only-deepseek-official` step 4, where the provider reports `outputTokens: 282` beside `reasoningTokens: 281` —
one implied non-reasoning token — over 281 reasoning deltas and no output delta. The old algorithm integrated to
**281**, losing exactly `outputTokens - reasoningTokens` tokens. The size of the loss is that difference; the invariant
is what makes the size irrelevant.

### 2. Two layers held two different versions of the consistency rules

The contradiction logic existed twice and the two copies disagreed. `aggregateTurn` carried a guard for one direction of
one phase:

```js
if (attempt.usage === null || attempt.usage.reasoningTokens !== 0) continue
if (!attempt.hasReasoningStream) continue
```

while `calibrateAttemptSamples` carried a *different* test — a missing phase, detected but not acted upon, because it
only lowered `splitQuality` and calibrated anyway. Neither layer could see the other's cases: `reasoningTokens > 0` with
no reasoning delta was invisible to the aggregate guard, and the output phase was invisible to both.

`src/core/phase-evidence.js` is now the single authority. `analyzePhaseEvidence(samples, outputTokens, reasoningTokens)`
returns the symmetric contradiction list, `splitUsable`, and the notes; `calibrateAttemptSamples` chooses the allocation
from it and `aggregateTurn` publishes metrics, issues and quality axes from it. A rule can no longer be true in one layer
and false in the other. The five symmetric kinds are `reasoning-without-deltas`, `reasoning-zero-with-deltas`,
`output-without-deltas`, `output-zero-with-deltas` and `impossible-split`. An **absent** `reasoningTokens` is deliberately
not among them: it is `split unavailable`, a quality level rather than a conflict, and produces an empty issue list.

### 3. Contradictory split falls back to one common total scale

When the provider total is valid but the phase split cannot be mapped onto the observed stream, the attempt is
`total-anchored`: one common factor is applied across **every** observed generated sample so their integral is the
authoritative total. The mathematics is the same as the already-documented absent-counter path, and it is now the same
code (`calibrateTotally`), because duplicating it is how the two paths drifted apart before. The fallback preserves the
authoritative attempt total, the observed temporal shape, the observed phase labels, the tool-call argument samples and
the Phase 7C attempt-local total rolling window. It invents no sample for the missing phase, drops no tokens, and zeroes
no phase the stream really recorded.

Calibration therefore has three explicit modes, `calibration.temporalAllocationMode`:

    phase-anchored   provider total and phase split both mapped onto observed stream evidence   exact per phase
    total-anchored   total authoritative, phase split absent or contradicted                     one common scale
    unanchored       no authoritative provider total                                             raw shape weight

`aggregate.temporalAllocationMode` is the weakest mode among the contributing attempts, each attempt carries its own,
and `curve.source` retains it per attempt. It is deliberately **not** `calibrationCoverage`: coverage measures how many
attempts have an authoritative **total**, so a `total-anchored` attempt is fully covered and the weaker phase-temporal
reading does not lower it.

### 4. Phase counters are a summary fact, not a temporal allocation

The two claims are now separated rather than merged. A provider that reports `outputTokens = 100, reasoningTokens = 70`
over a stream of output deltas only genuinely *said* that 70 tokens were reasoning and 30 were not; that statement is
retained per attempt in `calibration.evidence.contradictions[].provider`, and the turn's published phase pair comes from
the anchored attribution of the observed samples instead, because the curve cannot place 70 reasoning tokens at
timestamps that do not exist. Where the provider's counters are a real division of the total and the stream agrees, they
are published unchanged.

One further publication defect was found and closed while auditing this: on an impossible split
(`reasoningTokens > outputTokens`) `aggregateTurn` computed `observedNonReasoningTokens` through
`Math.max(0, outputTokens - reasoningTokens)` per attempt and then summed, and the residual correction turned the
negative remainder into a **negative phase count**. No count is now published for either phase of an impossible split:
`NaN` marks "may not be published" in the evidence layer and reaches the consumer as `null`, which the card already
renders as `—`. A negative number in a token column is a worse failure than an em dash.

### 5. Quality model: the counted total stays independent of the phase mapping

The audit found `tokenTotalQuality` correctly untouched by phase contradictions — it is derived from
`outputTokens` coverage and never from the split — and that property is now asserted rather than assumed. The
generalised contradiction flag reaches `phaseSplitQuality` only, capped at `estimated`. The model can express the
required combination in one snapshot: exact total, untrustworthy phase mapping, reconstructed temporal curve. Peak
semantics are unchanged: `≈` at `phase-anchored`, `total-anchored` and `unanchored` alike, because individual delta
allocations remain reconstructed, and a phase contradiction never removes the attempt's authoritative total from the
curve.

### 6. Tests changed, and why the old contract was invalid

Two existing expectations were changed. Both encoded the defect, so both carry the old contract in a comment beside the
new assertion:

- `test/quality-model.test.js` — *"the aggregate exposes the axes and keeps the legacy blended label as a floor"* used a
  reasoning-only stream with `reasoningTokens: 4, outputTokens: 10` and expected `phaseSplitQuality: 'exact'`. That
  expectation **was the defect**: the stream emitted no output delta, so the provider's six non-reasoning tokens could
  not be mapped onto any observed instant, and the split was exact only in the provider's summary sense and false as a
  temporal allocation. The fixture gained the output delta the exact claim needs, and the same counters over a
  reasoning-only stream are now asserted to be `total-anchored` with a reported contradiction;
- `test/dsh-degradation.test.js` — the *"provider total with no deltas of that phase"* test was **extended, not
  replaced**. Its original assertions are kept verbatim and the stronger invariant is added.

`test/dsh-degradation.test.js` also gained one import (`curveSource`) so the curve/card consistency claim can be
asserted on the same fixture.

### 7. Verification for this round

The failing case was strengthened and **observed failing against `534ff8f` before any production change**. Reverting
`src/` to `534ff8f` while keeping the new tests produced 21 failures in `test/phase-evidence.test.js` and one in
`test/curve-source.test.js`, and an in-memory replay of the old algorithm over the real fixtures reported **2 short
integrals in 32 anchored attempts** — the patched `t4` fixture (70 against 144) and the recorded `t6` step 4 (281 against
282).

`npm run verify` reports **648 tests, 648 pass, 0 fail**. All 625 of `534ff8f` are retained apart from the two
expectations above. `test/curve-source.test.js` carries the general sweep: 50 anchored attempts, 0 short integrals, 22
curve/card comparisons, 0 mismatches. `MAX_RENDER_POINTS_TOTAL`, `SLOT_ORDER`, the 50 ms live cadence, the axis
endpoint rule, the stream-order tie-break and the coverage vocabulary of Phase 7C.1 are all untouched.

## Phase 7D — DSH 0.1.7-rc.2 migration (2026-09-27)

The local host moved from `0.1.5-rc.2` to `0.1.7-rc.2`, and the plugin's live meter was observed accumulating strictly
sequential tool calls as though they were concurrent: on a five-call sequential turn the pill printed `pwsh +3` and
`pwsh +4`, and the reported field observation of the same class reaches `pwsh +192`. Everything below is the evidence
for what that was, what the new host actually declares, and what was changed.

The normative target from this phase onward is `0.1.7-rc.2`. Sections above that record verification "on
0.1.5-rc.2" remain historically accurate and are deliberately not rewritten; they document what was measured on the
host that was installed at the time. The field-by-field declarations this phase is built on are recorded in
`docs/DSH_API_NOTES.md` §13.

### 1. Runtime baseline and preflight proof

| Fact | Value |
|---|---|
| `dsh --version` | `0.1.7-rc.2` |
| Executable | `C:\Users\20659\AppData\Roaming\npm\dsh.cmd` |
| Active process | `"D:\softwares\nodejs\node.exe" C:\Users\20659\AppData\Roaming\npm/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open`, PID 42248 |
| Profile | `web` |
| Port | 50001 |
| Public reference commit | `477b4f420553e8a52c2fbccc464d7561b239c443` |

The in-process measurements below were taken pure, with no browser, so the parser could be isolated from presentation
timing. The baseline is SHA `1f97cfa5bad329e54bdf69debbb40611935827ae`, `648 tests / 648 pass`.

| Measurement | Baseline `1f97cfa` | After the fix |
|---|---|---|
| max `runningToolCount` over 100 strictly sequential `pwsh` calls | 100 | 1 |
| labels observed | up to `pwsh +99` (100 distinct) | `pwsh` |
| unmatched tool results | 100 | 0 |
| tools still running at turn end | 100 | 0 |

The baseline column is the whole defect: 100 calls that never overlapped were held as 100 concurrent tools, every
result failed to pair, and the turn closed with nothing resolved. The historical count of 100 was correct throughout —
what was wrong was the running set.

### 2. BLOCKER A — the 0.1.7 result identity was never read

Root cause, stated as the two parse locations that changed:

```text
old (0.1.5 assumption, the only path that existed)
  src/dsh/durable-path.js:164
    const callId = Array.isArray(data.message?.content)
      ? data.message.content[0]?.toolCallId ?? null : null
  src/dsh/durable-path.js:176
    record.status = data.error !== undefined || block?.isError === true ? 'error' : 'ok'

new (0.1.7 contract, in src/dsh/adapter.js)
  toolResultIdentity()  — role 'tool'  -> message.toolCallId / message.isError
                        — otherwise    -> content[0].toolCallId / content[0].isError, labelled legacy
  toolResultOutcome()   — data.error admitted only on a message flagged failed
```

A 0.1.7 result carries `role: 'tool'` with `toolCallId` on the message and no call identity anywhere in its content
blocks, so the old read returned `null` for every result. `null` is not a match, so `toolSettled` found no call to
close: the diagnostic counter `unmatchedToolResults` incremented, the call stayed in the running set, and the next call
was added beside it instead of replacing it. One unpaired result is one stale running tool, which is why the displayed
count grew monotonically with the number of calls.

`src/dsh/adapter.js` now decides this in one place, and the two shapes are separated structurally rather than by field
probing: a message that declares `role: 'tool'` can never reach the legacy content-block read, because the role is the
discriminator. The legacy read remains a labelled decode path (`TOOL_RESULT_SHAPE.LEGACY_CONTENT_BLOCK`) for the
recorded 0.1.5 captures, which are still replayed by the metric-math regressions. A result that carries no readable
identity is `MALFORMED` and fails closed: it closes no call and is counted, never repaired by arrival order.

#### 2.1 The same expression existed twice, and only one copy was in scope

The brief for this phase named a single parse site. The repository contained **two**: `src/dsh/adapter.js` (the live
normalization path) and `src/dsh/durable-path.js` (the durable reconstruction path B). They were identical expressions,
so fixing only the first would have left a defect that no live browser test can see — path B is what rebuilds a card
after a reload.

Measured on the recorded 0.1.7 fixture (`fixtures/dsh-0.1.7/t01-sequential-tools.json`), through
`reconstructFromDurable` alone:

| quantity | baseline | fixed |
|---|---|---|
| tools reconstructed | 2 | 2 |
| calls with a finite `endMs` | **0** | 2 |
| issue kinds raised | `tool-result-without-call-id`, `unmatched-tool-call` | none |

Both paths now go through one exported contract site (`toolResultOutcome`), so the identity location cannot drift
between them again, and `test/dsh-017-fixtures.test.js` asserts that the two paths resolve the same identity for the
same durable event. This second site was found by re-reading the baseline source after the first fix, not by a failing
test, which is why the regression test was added before the fix was considered finished.

### 3. Browser A/B on a five-call sequential turn

The same workload was driven through the real web client against the clean `0.1.7-rc.2` host, once on the baseline
bundle and once on the fixed one (`dev/screenshots/phase7d/phase7d-sequential-tools.json`).

| | Baseline bundle (`client.js` 429422 bytes) | Fixed bundle |
|---|---|---|
| live labels on a 5-call sequential turn | `pwsh +3`, `pwsh +4` | `pwsh · <t>` single-call labels only |
| `unmatchedToolResults` | 4–5 | 0 |
| matched results | — | 5 of 5 |
| completed card tool line | `工具 5 · 0.0s` | `工具 5 · 1.8s` |
| `maxPresentedToolCount` / `maxLiveRunningTools` | — | 1 / 1 |

The `+N` suffix is the multi-call label form, so the baseline pill was claiming three and four simultaneous `pwsh`
calls in a turn whose prompts asked for one call at a time. The card's `0.0s` is the same defect arriving at the
metric: a tool wall union over intervals whose ends were never observed is empty, and an empty union rounded to zero.
Once results paired, the union covered the real intervals and the card printed the turn's actual tool time. The three
`+N` labels were never observed on the fixed bundle, which is asserted rather than assumed
(`observedLiveLabelsNeverSeen`).

### 4. The completion layer, determined branch by branch

A second, independent failure mode was reported in the same round: the live pill stayed on screen after the turn had
ended. Rather than guess, all eight candidate layers were enumerated and each was excluded by source or by measurement
(`dev/screenshots/phase7d/phase7d-completion.json`, `layerDetermination`).

- **B** (`normalizeDurableEvent` ignores `turn/end`) and **C** (the feed drops it) are excluded by source: the
  normalization case is unconditional, `MutableSessionEventSource.publish` increments the revision on every mutation,
  and durable sequence numbers are unique, so neither the revision guard nor the seq dedupe can discard a terminal
  boundary.
- **D** — `lookupRecord` returning `null` and the handler returning silently — was **reachable and silent at the
  baseline**: `if (record === null) return` discarded the authoritative boundary with no record, no counter and no
  issue, and because the feed marks the sequence as seen before emitting, the boundary was unrecoverable. This is the
  layer that was repaired.
- **E** (the store throws on a pathological turn) was tested directly with the exact 192-unresolved-tool shape of the
  reported field screenshot, 192 open calls plus 200k attempt samples: `store.endTurn` completed in 117 ms without
  throwing.
- **F** (the presenter never settles) is excluded because the turn-end transition is unconditional once the turn
  identity matches; **G** (late evidence resurrects the turn) was possible on the durable plane at the baseline and is
  now excluded by a guard that drops and counts rows of a settled turn; **H** (React serving a stale projection) is
  excluded by measurement, since the sampled DOM flipped to `completed` within one 16 ms sample.
- **A** — the wire never exposing `turn/end` at all — remains the only layer outside the plugin's control. The local
  0.1.7 host does append it, verified in the durable v4 log
  (`{"type":"turn/end","seq":60,"time":…,"data":{"turn":1,"reason":{"kind":"completed"}}}`), and every real turn
  measured in this phase delivered `rawTurnEndSeen = 1`. `rawTurnEndSeen` is the instrument that discriminates A from
  D: it is incremented by the feed before any interpretation, so a future occurrence reports which of the two happened
  instead of leaving it undecidable.

The repair is reconstruction, not invention. A `turn/end` with no record is counted (`turnEndLookupMiss`,
`turnEndReconstructed`), recorded as a `turn-end-without-record` issue, and closed against the durable window: the
record is opened with the `turn/start` time the window supplied and `null` when that row was outside the window, the
machine is opened as a recovered boundary so it can own the turn identity, and the turn is closed with the reason the
event carried. Nothing about the live display is converted into evidence.

**Correction (Phase 7D.1).** The paragraph above overstates what this phase actually built, and the overstatement is
kept here rather than edited away because it is the reason Phase 7D.1 exists. What Phase 7D repaired was the terminal
**lifecycle**: the boundary is no longer discarded, and a completed card is always produced. It did **not** repair
metric **reconstruction**. The code opened an empty record — `store.beginTurn(...)` immediately followed by
`store.endTurn(...)` — so every durable fact of that turn still present in the same window (the `assistant/message`
settlements and their embedded compact streams, usage, the `tool/call` and `tool/result` boundaries) was dropped on the
way to it. A recovered card therefore closed with zero attempts, zero generated tokens and no tools while the evidence
for all of them sat in the window the handler had just read, and the log line `reconstructed from the durable window`
described an action the code did not take. The metric half is Phase 7D.1, appended below; the claim "reconstruction from
the durable window" is accurate only from that phase onward.

### 5. Completion trace and reload equivalence

A 16 ms sampler recorded the projected view kind, the rendered node's `data-kind` and the full diagnostics counters
while a real five-call sequential turn ran to completion
(`dev/screenshots/phase7d/phase7d-completion.json`).

```text
t=17     waiting     live        rawDurableEvents 36   rawTurnEndSeen 0
t=972    tool        live        rawToolCalls 5  rawToolResults 4  matchedToolResults 4
t=1228   transition  live        rawToolResults 5  matchedToolResults 5  bareSettleSeen 5  retirementsResolved 5
t=3505   completed   completed   rawTurnEndSeen 1  normalizedTurnEndSeen 1  turnEndLookupHit 1
                                 storeEndTurnCalled 1  presenterTurnEndApplied 1  settledSnapshotBuilt 1
```

The view kind and the DOM's `data-kind` both flip to `completed` inside a single 16 ms sample. No intermediate frame
was observed in which the turn was settled internally but still rendered live, or live internally but rendered as a
card; the bound is the 50 ms presentation cadence plus one React commit, and the measurement sits below both. After the
card is on screen the scheduler is stopped (`ticking: false`, `timerCount: 0`, no increasing elapsed number), and
`livePresentedToolCount` is 0.

Reload equivalence: reloading the page over the same session produced a card whose text is **byte-identical** to the
pre-reload card, with `rawTransientRows` 0 — the card was rebuilt from the durable plane alone and did not return to
`tool-running`, `streaming-output` or `waiting-model` on the way.

### 6. A long real session on 0.1.7

The same counters were left running on a real long session rather than on a scripted turn:

| Counter | Value |
|---|---|
| tool calls / matched / unmatched | 145 / 145 / 0 |
| `bareSettleSeen` | 4 |
| `retirementsResolved` | 4 |
| `abandonmentsResolved` | 0 |

The `bareSettleSeen` row is the second half of this phase. A bare `settleAssistant(attemptId)` looks like an
abandonment, and the 0.1.5-era reading treated it as one — which on this session would have mislabelled four
**successful retirements** as abandonments and overwritten four committed outcomes with an abandonment claim. The two
situations that issue the bare call, and the algebra that distinguishes them, are recorded in `docs/DSH_API_NOTES.md`
§13.4; the feed now resolves them from held evidence (the attempts that received a durable settlement directly, plus a
consumed budget of outstanding settlements keyed by their durable coordinate) and a bare call that no route covers is
the only one counted as an abandonment. `abandonmentsResolved` 0 beside `retirementsResolved` 4 is that reading
working on live evidence.

### 7. The 0.1.7 fixture corpus

`fixtures/dsh-0.1.7/t01-sequential-tools.json` was recorded on 2026-09-27 from session `fixture-mujjrw4r-1` through
`dev/fixture-recorder` against the `0.1.7-rc.2` host. It carries 30 durable rows and 95 transient frames; the turn runs
model → pwsh → model → pwsh → model and closes with `turn/end` reason kind `completed`. Its own summary records the
shape it captured:

```json
"toolResultShape": {
  "role": "tool",
  "identityLocation": "message.toolCallId",
  "isErrorLocation": "message.isError"
}
```

The fixture is versioned (`captureFamily: "0.1.7"`, `dshVersion: "0.1.7-rc.2"`) and published through
`fixtures/dsh-0.1.7/index.json`, so the family a replay is reading is never inferred from the directory it sits in.
Sanitization was verified clean with 513 redaction markers, and the independent gate
`node scripts/verify-sanitization.mjs` now covers `fixtures/dsh-0.1.7/` alongside the 0.1.5 capture family and the
derived mutations.

### 8. Legacy fixture policy

The eight captures under `fixtures/dsh-turns/` are `0.1.5-rc.2` evidence. They may still prove the metric arithmetic,
the decoder's robustness and historical compatibility — they are the only recordings of several shapes in the set, and
nothing about them was invalidated by the host moving. They may **no longer** be the only proof of the tool/result
shape, the settle-assistant semantics, the turn completion lifecycle or the client event-window behaviour, all four of
which 0.1.7 changed and all four of which are now established from the 0.1.7 declarations and the recorded 0.1.7
corpus. Where a 0.1.5 capture and a 0.1.7 declaration disagree, the declaration and the 0.1.7 corpus decide, and the
legacy decode path exists so that the older bytes can still be replayed without being believed about the wire.

### 9. Two defects found in this phase's own code

Both were found while verifying the new code rather than by running the old code, and both were in what this phase
added.

`controller.diagnostics()` originally obtained the live tool counts by taking a `liveSnapshot` at the wall clock. A
snapshot evaluated at an arbitrary instant **evicts** expired samples from the rolling window, so the diagnostic was
mutating the state it was reporting on and could silently change the very rate it was only supposed to observe. The
two live counters are now read from the meter's own running set and its phase, which observes without evaluating a
window.

`liveRunningTools` alone could not express the distinction the pill needs when a turn ends with a call whose result was
never observed: presentation closes at turn end while the unresolved call stays on the record as incomplete evidence,
and one integer cannot report both. `livePresentedToolCount` was added as the same set gated on the tool stage owning
the view, so "what the pill would print" and "what the store still holds" are separately readable. On a settled turn
the pair reads 0 and 0; mid-turn with an unresolved call after the boundary they legitimately disagree.

### 10. Verification for this round

`npm run build:client` + `npm run verify` (`verify-structure.mjs` then the Node test runner) reports **685 tests, 685
pass, 0 fail** — 37 above the 648-test baseline of `1f97cfa` — across `test/dsh-017-tool-result.test.js` (6),
`test/dsh-017-tool-concurrency.test.js` (7), `test/dsh-017-settlement.test.js` (7), `test/dsh-017-completion.test.js`
(9) and `test/dsh-017-fixtures.test.js` (8). The settlement expectations are derived from
`test/helpers/assistant-stream-fold.js`, a faithful port of the shipped `ClientAssistantStream` algebra, so they test
the decision the real fold makes rather than a paraphrase of it. `node scripts/verify-sanitization.mjs` passes
separately with the new corpus included. Browser evidence for the round is under `dev/screenshots/phase7d/`
(`phase7d-sequential-tools.json`, `phase7d-completion.json`, `sequential-tool-live.png`, `completed-card.png`).

## Phase 7D.1 — terminal-tail durable metric reconstruction (2026-09-27)

A correctness closure on one defect, with no change to any frozen metric, UI or curve semantic. The target remains DSH
`0.1.7-rc.2`; nothing in this phase re-opens the tool-identity migration or the settle-assistant disambiguation, and
both are re-verified below against the same evidence as before.

Baseline SHA `3602ce9179be22bcdc4259303546ebae4b827436`, equal to `origin/main`, working tree clean.

### 1. The defect

`src/client/live/controller.js` handled `NORMALIZED_KIND.TURN_END` with `lookupRecord(...) === null` by opening an
**empty** record and closing it:

```text
lookupRecord(state, event.turn) === null
  -> state.counters.turnEndLookupMiss += 1
  -> record = store.beginTurn({ sessionId, turn, timeMs: startMs })   // empty
  -> presenter.apply({ type: 'turn-start', recovered: true })
  -> store.endTurn(record, { ... })                                   // settles 0 attempts, 0 tools
```

`reconstructFromDurable()` was never called, and no attempt was made to consume the durable evidence for that turn that
the same window had already delivered. The consequence is a completed card for a turn whose metrics are known:

```text
window contains no turn/start
  durable assistant/message  -> feed emits ATTEMPT_SETTLE  -> record is null -> attempt dropped
  durable tool/call          -> feed emits TOOL_CALL       -> record is null -> return
  durable tool/result        -> feed emits TOOL_RESULT     -> record is null -> return
  durable turn/end           -> record is null -> EMPTY beginTurn -> endTurn
completed card exists, durable metrics absent
```

The three `record === null` guards are individually correct — fabricating a record from a stray event would attach
evidence to a turn the client cannot identify — but together they discard a turn's whole evidence base, which the
terminal boundary then closes over. The log line `reconstructed from the durable window` named an action the code did
not take; see the correction note in §4 of the Phase 7D entry above.

### 2. Failing test recorded before any production change

`test/dsh-017-terminal-tail-recovery.test.js`, first case
`a terminal durable tail without turn/start reconstructs the turn's durable metrics`, run against baseline `3602ce9`
with no production edit in place.

| | |
|---|---|
| fixture | `fixtures/dsh-0.1.7/t01-sequential-tools.json` (real 0.1.7-rc.2 capture), durable rows with `seq >= 5` |
| tail contents | 3 `assistant/message`, 2 `tool/call`, 2 `tool/result`, `step/start`, `step/end`, 1 `turn/end` |
| deliberately absent | `turn/start` (seq 4), and every transient row |
| reference | `reconstructFromDurable({sessionId, turn: 1, events: tail})` reduced through `TurnTelemetryStore` |

| quantity | reference | baseline controller, recovered record |
|---|---|---|
| `attempts.length` | 3 | **0** |
| tools | 2 × `pwsh` (361 ms, 345 ms), both `ok` | **0** |
| `generatedTokens` | 147 | **`null`** (`observedGeneratedTokens` 0) |
| `curve.attempts.length` | 3 | **0** |
| `curve.peakTps` | 76.0 | **0** |
| `curve.source.calibrationCoverage` | `full` | **`none`** |

Failing assertion: `AssertionError [ERR_ASSERTION]: recovered record == durable reconstruction of the same tail`, first
diff `+ attempts: []` against `- attempts: [ { sampleCount: 40, settlementSeq: 16, ... }, ... ]`. Ten of the eleven
cases in the file failed on the baseline; seven of those ten are the same equality stated against a different ingestion
route, generation boundary or session, and the remaining three assert the unknown-boundary and minimal-evidence
contracts that an empty record trivially satisfies but that must keep holding once reconstruction is real.

### 3. The repair

Two modules and one handler.

**`SessionEventFeed` retains raw durable evidence.** A bounded, per-generation pool
(`DurableEvidencePool`, `MAX_RETAINED_TURNS = 32`, least recently updated turn evicted first, where another row of a turn
refreshes that turn's retention position) keeps every durable row exactly as it
arrived, keyed by the turn its `data.turn` names, with its own `seq`. Retention is hooked into **both** routes by which
a durable row enters the feed — `processDurable` for appended entries, and the `entry`-bearing `settle-assistant`
change for the route DSH uses for interrupted messages and non-surface `assistant/attempt` settlements — because a
retention path covering only the append route would lose attempts that travelled the other. `rebaseline()` clears the
pool with the rest of the generation state, which is the explicit boundary that stops one generation's settlement being
reconstructed together with another's `turn/end`. Consumers read it through `turnEvents(turn)`; nothing is decoded in
the feed.

> **Corrected in Phase 7D.1.1.** This paragraph originally read "oldest turn evicted first", which described first-seen
> FIFO. The implementation was never FIFO: `DurableEvidencePool.record()` deletes the turn's key before re-inserting it,
> and a JavaScript `Map` iterates in insertion order, so a turn that received another row moved to the tail and the
> released turn was the least recently *updated* one. Implementation and documentation therefore disagreed, and the
> contract was undecidable from the repository. The implementation is kept — it is the policy the reconstruction
> consumer wants — and this text, `docs/ARCHITECTURE.md`, `docs/TASKS.md` and the source comments now state it;
> `test/dsh-017-retention-contract.test.js` pins it, including the decisive case (`1..32`, refresh `1`, add `33`
> evicts `2`). The same phase documented that `counters.retainedDurableEvents` is a cumulative ingest count rather than
> a current row count, since eviction does not decrement it.

**`src/dsh/reconstruction.js` bridges reconstruction into the store.** `materializeReconstructedTurn()` calls
`reconstructFromDurable`, then routes its output through the store's own methods — `beginTurn`,
`turnStartObserved`, `beginAttempt`, `acceptChunk`, `setAttemptUsage`, `settleAttempt`, `toolStarted`, `toolSettled`.
It contains no decoder, no tool pairing, no retry correlation and no settlement classification:

```text
feed.turnEvents(turn)
  -> reconstructFromDurable()                     (src/dsh/durable-path.js — the only durable parser)
  -> store.beginTurn / beginAttempt / acceptChunk / setAttemptUsage / settleAttempt / toolStarted / toolSettled
  -> controller: store.endTurn()
  -> aggregateTurn -> curveSource -> compressAttempts -> attemptTraces -> render budgeting
  -> completed card
```

The recovered record is therefore an ordinary store record, and the curve it produces is the ordinary curve. No
`tail recovery curve` exists. Attempt identity — which the durable plane does not carry, since `attemptId` is
process-local to the client fold and never appears in a settlement — is `settlement:<settlementSeq>`
(`reconstructedAttemptId`), derived from the settlement's own sequence rather than from a wall clock or a UUID so that
replaying one window twice produces the same store key. It is a store-internal key and is never presented as a DSH
attempt identity.

**The handler consumes the evidence.** `NORMALIZED_KIND.TURN_END` on a lookup miss now materializes the record from
`state.feed.turnEvents(event.turn)` and closes it. The `observedTurnStart` fallback is retained but narrowed to its
correct role: it supplies a start only for a turn whose `turn/start` this session actually observed, and the
reconstruction reports the same instant, so it is never a substitute for a boundary nobody saw.

### 4. Equality achieved, and the boundary that stays unknown

Measured on the tail of `t01` after the repair:

| field | reference (`reconstructFromDurable(tail)`) | recovered turn |
|---|---|---|
| attempts | 3 (`seq` 16, 22, 27) | identical |
| samples per attempt | 40 / 27 / 6 | identical |
| generated tokens | 147 | 147 |
| reasoning / non-reasoning split | `null` / `null` (provider reported no `reasoningTokens`) | identical |
| tools | 2 × `pwsh`, `workMs` 706, `wallMs` 706 | identical |
| status / note | `completed` / `null`, reason kind known | identical |
| temporal allocation mode | `total-anchored` | identical |
| curve source | `aligned` true, `full` coverage, 3 contributing / 3 calibrated | identical |
| curve peak / duration | 76.0 / 259 ms | identical |

With no `turn/start` in the tail the start stays unknown, and that is the correct outcome rather than a gap:

| field | full recording (has `turn/start`) | tail recovery |
|---|---|---|
| `record.startMs` | 1790497151824 | **`null`** |
| `record.firstTokenMs` | 1790497154164 | **1790497154164** (durable sample evidence) |
| TTFT | 2340 ms | **`null` — unavailable, not fabricated** |
| turn elapsed | 6938 ms | **`null` — unavailable, not fabricated** |

A known first token beside an unavailable TTFT is a legitimate state: TTFT is an interval from the start, and only one
of its two boundaries exists here. Nothing is inferred from the first delta, a `step/start`, a `tool/call`, the attach
time or the current clock. Comparing the two references confirms the boundary is exact — every other field of the tail
reconstruction equals the full recording's — so the tail loses precisely the start-dependent fields and nothing else.

A window whose only evidence is `turn/end` reconstructs to an empty turn: 0 attempts, 0 tools, `startMs` `null`,
`observedGeneratedTokens` 0, `curve.peakTps` 0, `calibrationCoverage` `none`, `aligned` true. No attempt, tool,
duration or sample is manufactured to make the card look complete.

### 5. Diagnostic semantics

`turnEndReconstructed` previously counted an empty `beginTurn()` as a reconstruction, so the counter was satisfied by
an action that consumed nothing. It now counts one reconciliation: the boundary arrived, no record existed, and a record
was built from `feed.turnEvents(turn)` through `reconstructFromDurable`. It deliberately does not claim the evidence was
non-empty — a turn whose only visible row is its own `turn/end` reconstructs to an empty turn, which is correct and is
counted the same way. The `turn-end-without-record` issue now carries `reconstructedAttempts`, `reconstructedTools` and
`startKnown`, so a caller that needs to distinguish "reconciled from evidence" from "reconciled from nothing" can, and
no counter was added that has no reader. The distinction is documented on the counter itself rather than only here.

### 6. Discovery during this phase

The `settle-assistant`-with-entry restore path in the same handler passed `settlementEventType` to `attemptFromDecoded`
— the value was already in scope — but never landed it on the store record, because `settleAttempt` does not accept it
(which is correct: it is the durable surface's own type, not settlement state). The field is now attached to the
restored attempt beside the state, matching what the durable reconstruction path publishes. Without it, a card rebuilt
by reload carried `settlementEventType: null` on every attempt, and the reload-equivalence test could not compare the
field at all. Found by writing the equality contract rather than by a failing production report.

### 7. Fixture corpus: what is recorded and what is not

The 0.1.7 corpus remains `fixtures/dsh-0.1.7/{index.json,t01-sequential-tools.json}`. **No lifecycle fixture was
added, and the corpus is not complete.** The reason is structural rather than an omission:

```text
recorder observation points (dev/fixture-recorder/lib/index.js)
  ctx.on('session/event', (session, event) => ...)              -> durable plane
  ctx.on('agent/assistant-stream', ({agent, frame}) => ...)     -> transient plane
```

The `settle-assistant` window change is neither. It is emitted by the **browser-side** client fold
(`ClientAssistantStream`) when it supersedes an attempt's transient rows, and the host process the recorder lives in
never sees it. No recorded fixture can therefore contain a bare `settle-assistant`, and `t01` proves the tool-identity
and completion facts it was captured for — it does not prove the retirement lifecycle. Capturing one would require
either re-running the fold inside the host recorder, which would make the row a *derived* artifact rather than observed
evidence, or a browser-side recorder, which is a new tracing facility. Neither was undertaken, so that boundary is
recorded rather than papered over.

The retirement-versus-abandonment distinction is consequently covered by **synthetic contract tests** against
`test/helpers/assistant-stream-fold.js`, a faithful port of the shipped `ClientAssistantStream` algebra:
`test/dsh-017-settlement.test.js` (7 cases) establishes normal retirement, true abandonment, the retirement budget, and
the attempt-without-observed-rows case. Those cases are synthetic and are labelled synthetic; the `t01` capture is
recorded evidence, and it covers the tool-identity, window and completion contracts only.

### 8. Regression matrix re-verified

| Property | Evidence | Kind |
|---|---|---|
| terminal tail without `turn/start` recovers full durable metrics | `dsh-017-terminal-tail-recovery` (11) | synthetic replay of a **recorded** 0.1.7 fixture |
| `only turn/end` closes terminally with no invented data | same file | synthetic |
| full durable reload unchanged | same file + `dsh-017-completion` | recorded 0.1.7 / synthetic |
| 100 sequential calls, `runningToolCount` max 1 | `dsh-017-tool-concurrency` | synthetic |
| `message.toolCallId`, `role: 'tool'`, `message.isError`, fail closed | `dsh-017-tool-result` (6) | recorded 0.1.7 + derived |
| bare settle-assistant retirement vs abandonment | `dsh-017-settlement` (7) | synthetic (see §7) |
| all seven `TurnEndReason` variants terminal; unknown reason `statusKnown false` | `dsh-017-completion` | synthetic |
| late evidence does not resurrect a settled turn | `dsh-017-completion` | synthetic |
| rebaseline drops the previous generation's retained evidence | `dsh-017-terminal-tail-recovery` | synthetic replay of a recorded fixture |
| session isolation of retained evidence | same file | synthetic |

### 9. Verification for this round

`npm run build:client` then `npm run verify` reports **696 tests, 696 pass, 0 fail**, 11 above the Phase 7D figure of
685. `node scripts/verify-sanitization.mjs` passes, `git diff --check` is clean, and `verify-structure.mjs` reports the
client bundle fresh. Live-vs-durable equivalence over all eight 0.1.5 recordings (`dsh-equivalence`) and the rebaseline
and mid-turn-reload suites all pass unchanged, as does `curve-source`, which is what keeps the recovered path inside the
existing calibration pipeline rather than beside it.

### 10. Runtime evidence, and the one case a live session cannot produce

Re-verified at the start of the round rather than quoted: `dsh --version` → `0.1.7-rc.2`; executable
`C:\Users\20659\AppData\Roaming\npm\dsh.cmd`; the installed package declares `0.1.7-rc.2`; the running web host is
`"D:\softwares\nodejs\node.exe" C:\Users\20659\AppData\Roaming\npm/node_modules/@deepseek-ai/dsh/lib/bin.js web
--no-open` (PID 38056). No restart and no `dev_reload_package` was used for the evidence below.

**The Phase 7D.1 bundle is what the browser is served.** `window.__DSH_BOOT__.entries` carries
`{"id":"dsh-turn-performance-meter","url":"plugins/??dsh-turn-performance-meter/client.js&rev=7e89ed4086d7"}` after a
fresh page load, and that URL returns the module table containing `src/dsh/reconstruction.js`,
`materializeReconstructedTurn`, `reconstructedAttemptId` and `MAX_RETAINED_TURNS`, with the Phase 7D log line
`reconstructed from the durable window` absent.

**Live meter contract, sampled in the page at 50 ms** during a real turn of this session: 3,945 samples, five distinct
presentation states, and the observed transitions in order — `streaming-output` → `tool-running` → `waiting-model` →
`streaming-output` → `tool-running` → `transition` → `waiting-model` → `streaming-reasoning` → `streaming-output` →
`tool-running` → …, cycling through all five several times. Two properties are load-bearing:

- **zero samples carried a `+N` label.** The defect class Phase 7D closed — a multi-call label claiming simultaneous
  tools — did not reappear. Every tool sample named exactly one call (`mcp__chrome-devtool…`), which is also the
  observation that matters for the running set: the plugin never held more than the calls it had actually seen open.
- **the `transition` stage is reachable and reached**, so the settle → tool → step cycle is being folded rather than
  skipped.

**Completed card on a durable-only reload.** Reopening an existing settled session
(`Sequential pwsh calls with sleeps`, `session-47771d28-…`) with no live turn running rendered
`data-kind="completed" data-status="completed" data-quality="estimated" data-view="summary"`, cells
`思考 TPS ≈227 tokens/s`, `输出 TPS ≈266 tokens/s`, `生成 Tokens 1,513 tokens · 总用时 66.9s`, `首响应 1.51 s`,
`已完成`, footer `工具 8 · 35.8s`, `模型调用 9` — a card rebuilt entirely from the durable plane. Its text was byte-stable
across a two-second resample, so no ticker or scheduler survives onto a static card.

**No plugin console error.** The page's two errors are `useSessionPendingInteraction is not a function` and its
consequent `slot entry crashed in 'conversation.session.header.utilities'`; the stack of the first is entirely inside
the DSH shell bundle `assets/index-Q6zc2uHV.js` with no frame from `dsh-turn-performance-meter`, the crashing slot is
the session header rather than `conversation.input.dock`, and the symbol is the pre-existing DSH template artifact
recorded in §"Phase 5" of this log. Neither is evidence about this plugin.

**What was not reproduced, stated plainly.** The tail scenario — a window whose `turn/start` has actually slid out
while the turn's later rows remain — was **not** produced in the browser. Live observation uses the window as the
session presents it, and a freshly loaded session carries the turn's opening row; on reload the page re-reads the whole
window, so the miss path is not what a normal page load exercises. The case is nonetheless a real shape of the contract
rather than a hypothetical one, which is why the fix is stated against the feed and not against a page load:
`SessionEventWindow` is declared as a *contiguous* window carrying `hasMore` — "whether older history remains" —
(`dsh-api-session-controller/lib/types/client/contract/events.d.ts:55-61`, `:77-93`), so the window is explicitly a
bounded tail, `turn/start` can be outside it, and `replace` (loading a bounded window) plus `prepend` (paging older
history) are the operations that produce exactly that state.

The tail under test in §2 is therefore a **replay of recorded durable bytes in the tail's real shape**, not a
DOM manipulation and not a synthetic session event: the rows are the fixture's own, at their recorded sequence numbers
and timestamps, with the window cut after `turn/start` — which is the position `hasMore: true` describes. Browser-level
instantiation of the cut is the one part of this phase that rests on the contract plus the replay rather than on a live
observation, and it is marked as such here instead of being claimed.

## Phase 7D.1.1 — reconstruction contract and Git gate closure

### 1. Scope, and what was deliberately not touched

A closure phase over the Phase 7D.1 repair, whose baseline was re-verified at the start of the round rather than quoted:
`HEAD == origin/main == dd4b194a349fe9a3dd9b126bd84241dff82221c7`, divergence `0 0`, working tree clean,
`dsh --version` → `0.1.7-rc.2`. Two latent contract defects were closed. Nothing else moved: no metric engine, no UI, no
curve semantics, no change to the DSH 0.1.7-rc.2 `tool/result`, `settle-assistant` or `turn/end` contracts, and no
Phase 8 work.

The Phase 7D.1 main repair is re-verified as frozen. `turn/end` with `lookupRecord == null` still routes through
`state.feed.turnEvents(turn)` → `materializeReconstructedTurn()` → `reconstructFromDurable()` → the store's normal
`beginAttempt` / `acceptChunk` / `setAttemptUsage` / `settleAttempt` / `toolStarted` / `toolSettled` sequence →
`store.endTurn()` → `aggregateTurn` → `curveSource` → `attemptTraces` → a normal completed card. The Phase 7D
empty-record path was not restored. The unknown-boundary rule is unchanged: a missing `turn/start` leaves `startMs`,
`ttftMs` and `turnElapsedMs` `null`, while a durable first generated sample still yields a known `firstTokenMs`.

### 2. Defect A — the unsafe reconstruction `timeMs` fallback

`materializeReconstructedTurn()` accepted a `timeMs` input and wrote

```js
store.beginTurn({ sessionId, turn, timeMs: reconstructed.turnStartMs ?? timeMs })
```

which contradicts the invariant the same module states two paragraphs above it: *a turn start may only come from actual
durable `turn/start` evidence*. No production caller passed `timeMs` — `git grep` over `src/` finds exactly one caller,
`src/client/live/controller.js` in the `TURN_END` lookup-miss path, and it passes only `store`, `sessionId`, `turn` and
`events` — so the defect was latent. It was still a defect: the exported API let any future caller hand a reconstructed
turn a start it never observed, and `startMs` is the anchor TTFT and turn elapsed are measured from.

**Failing test first, on `dd4b194`.** `test/dsh-017-materialize-reconstruction.test.js` builds a tail from the recorded
`fixtures/dsh-0.1.7/t01-sequential-tools.json` — settlements, tool boundaries and the terminal row, with `turn/start`
(seq 4) removed — and supplies a plausible invented clock. Recorded pre-fix result, 2 of 4 cases failing:

| field | pre-fix | expected |
|---|---|---|
| `record.startMs` | `9000000000000` (the caller's clock) | `null` |
| `record.firstTokenMs` | `1790497154164` (durable) | unchanged |
| `settled.ttftMs` | `0` | `null` |
| `settled.turnElapsedMs` | `0` | `null` |

The interval fields are the sharper half of the defect. The invented start sits far in the future of the recorded first
token, so `aggregateTurn` clamps the negative intervals to zero: the card does not merely fail to report an unavailable
metric, it reports a **measured-looking `0 ms`** that no evidence produced.

**The fix** deletes the parameter instead of ignoring it, so the fallback is not expressible at the API level rather
than merely unused:

```js
const record = store.beginTurn({ sessionId, turn, timeMs: reconstructed.turnStartMs })
```

The module docstring records why the input is absent, so a later reader cannot "helpfully" restore it, and points callers
that legitimately hold an observed boundary at `store.turnStartObserved()` — the one-way upgrade that refuses to replace
a finite start, which is what the controller's miss path already uses for `state.observedTurnStart`. Post-fix the same
test reports `startMs` `null`, `ttftMs` `null` and `turnElapsedMs` `null` under both the direct call and an unnamed
`timeMs` smuggled through object spreading, while the same tail *with* `turn/start` still yields `startMs`
`1790497151824`, `turnElapsedMs` `6938` and a numeric TTFT — refusing fabrication did not become refusing evidence.

### 3. Defect B — the retention eviction contract

`DurableEvidencePool` had one policy in its implementation and the opposite in its prose. The implementation:

```js
this.byTurn.delete(turn)
rows.push(event)
this.byTurn.set(turn, rows)
```

Because a JavaScript `Map` iterates in insertion order, deleting and re-inserting moves a revisited turn to the tail, so
the released turn is the **least recently updated** one. The comments and four documents said otherwise: "the oldest
turns being released first", "evicted in the order it was first seen", "re-recording a turn preserves its original
position", "oldest released first". The contract was therefore undecidable from the repository — an auditor reading the
docs and an auditor reading the code would have reached opposite conclusions about which evidence survives.

**The chosen policy is least-recently-updated, and the implementation was kept.** The decision follows from the
consumer rather than from symmetry with a queue: the retention exists so a `turn/end` whose opening row is outside the
live tail can be reconstructed, and that turn is by construction the one still publishing durable rows, so it is the
most recently refreshed entry and is never the eviction candidate. Under first-seen FIFO a turn that began 33 turns ago
and is still running would be released while its evidence was still being produced — the retention would lose exactly
what it was built to keep. Every first-seen claim was replaced, in the source (module docstring, `MAX_RETAINED_TURNS`,
the pool class, `record()`, `retainDurable()`, the counters block) and in `docs/ARCHITECTURE.md`, `docs/TASKS.md` and
§3 of this log.

`test/dsh-017-retention-contract.test.js` (9 tests) pins the policy through the public surface — `retainedTurnCount()`
and `turnEvents()` — rather than through private fields, and includes the case that separates the two candidate
policies:

| scenario | asserted outcome |
|---|---|
| 32 turns resident, then a 33rd | `retainedTurnCount()` stays `32`; one turn released, never more |
| turns 1..32, another row for turn 1, then turn 33 | turn **2** released, turn 1 survives with both rows (FIFO would release turn 1) |
| a long turn interleaved with 64 shorter turns | the long turn keeps all 65 rows, arrival order, `turn/start` first |
| 40 rows of one turn | one slot, not forty: the bound counts turns |
| an evicted / unknown / non-numeric turn | `turnEvents()` is `[]` |
| a surviving turn with interleaved arrivals | its own rows only, in durable arrival order, identical objects |
| a duplicate `seq` | no duplicate row, and no refresh: the replay cannot change the eviction victim |
| `replace` | pool cleared, counter reset, old generation's `seq`s admissible again |
| `retainedDurableEvents` after eviction | strictly greater than current occupancy, i.e. cumulative |
| source and documents | retired first-seen vocabulary absent; stated policy present |

The last row makes documentation/implementation agreement a test rather than a convention, which is the specific failure
this phase repairs.

### 4. `retainedDurableEvents` semantics

Audited and settled as **cumulative**: unique durable rows admitted into the retention pool during the current window
generation. It is republished from the pool's `eventCount`, which increments on each newly retained row and is never
decremented on eviction, and it resets to zero with the pool at a rebaseline. It is therefore *not* a current row count,
and the counter block, `retainDurable()` and `docs/ARCHITECTURE.md` now say so explicitly. Current occupancy keeps its
own honest accessor, `retainedTurnCount()`. The alternative — maintaining an eviction decrement — was rejected because
it would have to walk the released turn's rows to keep a diagnostic accurate; no new state was added.

### 5. Git process deviation

Phase 7D.1 used one `--force-with-lease` after a post-push `--amend`, which rewrote the remote: `d0904dbe` and `dd4b194a`
are sibling commits sharing parent `d3982fe`, as the independent GitHub audit established. No unrelated or production
commit loss was found, but the accurate statement is that **the remote documentation commit was replaced** — not that
"nothing was overwritten". History will not be rewritten again to restate this, and the remainder of this phase uses new
commits plus an ordinary `git push origin main` only: no `--amend` after push, no rebase of pushed `main`, no `--force`,
no `--force-with-lease`, no reset of remote `main`. A rejected ordinary push is reported as divergence rather than
resolved by force.

### 6. Verification for this round

Reported as a **local test result**: this repository has no CI runner, so `npm run verify` here is not CI verification and
is not described as such.

`npm run build:client` reports `client.js rebuilt (477412 bytes, mirrored to lib/client.js)`. `npm run verify` — which is
`scripts/verify-structure.mjs` followed by the Node test runner over `test/*.test.js` — reports **709 tests, 709 pass,
0 fail**, 13 above the Phase 7D.1 figure of 696 (4 in `test/dsh-017-materialize-reconstruction.test.js`, 9 in
`test/dsh-017-retention-contract.test.js`), with `structure OK (14 required files, 16 core modules, 62 test files,
client bundle fresh)`. `git diff --check` is clean and `node scripts/verify-sanitization.mjs` reports
`sanitization verified — no personal content, all structural evidence preserved`.

The generated bundle is fresh and `client.js` and `lib/client.js` are byte-identical
(`SHA-256 4E412F29785E00B7586BDA29097D06E223041BA1270AF34482D166B928E1D36E`). The bundle the browser is actually served —
`plugins/??…dsh-turn-performance-meter/client.js`, entry rev `817e3b87a4e9`, 2,285,490 bytes — contains the module table
including `src/dsh/reconstruction.js`, `DurableEvidencePool` and `materializeReconstructedTurn`, plus this phase's
retention comments (`least-recently-updated`, `cumulative ingest counter`). The withdrawn expression
`reconstructed.turnStartMs ?? timeMs` survives in the served text only inside the docstring that records its removal; the
behavioural guarantee is covered by the adversarial test rather than by string absence.

### 7. Minimal clean-runtime smoke, no reload shortcut

No `dev_reload_package` was used. After a cache-ignoring page reload of `http://127.0.0.1:50001/`, the plugin's live
meter is mounted and rendering in the conversation input dock — `.dsh-tpm-root[data-kind="live"][data-state="tool-running"]`
with `aria-label="工具 · 10m40s"` — so the plugin loads and the live path works. The completed card was exercised on
settled session `Sequential pwsh calls with sleeps`: `.dsh-tpm-root[data-kind="completed"][data-status="completed"]`
`[data-quality="estimated"][data-view="summary"]` with `生成 Tokens 1,513 tokens · 总用时 66.9s`, `首响应 1.51s`,
`峰值 ≈279 tokens/s`, `工具 8 · 35.8s`, `模型调用 9`. No new plugin console error appeared: the page's errors remain the
pre-existing `useSessionPendingInteraction` template artifact, whose stack is entirely inside the DSH shell bundle
`assets/index-Q6zc2uHV.js` with no frame from this plugin, plus shell and other-plugin 404 polling. No long browser
performance A/B was repeated, because no presentation path changed.

## Phase 7D.1.2 — generation-wide durable identity closure

### 1. Scope, and what was deliberately not touched

A closure phase with one subject. Baseline `b188511e80653f2cb9d54a046fdeabe1fc0e1e4a`, re-verified at the start of the
round rather than quoted (`HEAD == origin/main`, divergence `0 0`, working tree clean, `dsh --version` → `0.1.7-rc.2`).
No metric semantics, no UI, no curve arithmetic, no DSH 0.1.7-rc.2 contract and no eviction policy was reopened. The two
Phase 7D.1.1 repairs were treated as frozen: `materializeReconstructedTurn()` still accepts no caller `timeMs`, and
eviction is still least-recently-updated with another row of a turn refreshing that turn's retention position.

### 2. The defect — eviction and generation-wide dedupe disagreed about identity

Two structures held different answers to "has this durable row been seen", and the retention consulted the weaker one:

```text
DurableEvidencePool.seqs        released a row's seq when its turn was evicted
SessionEventFeed.durableSeqs    generation-wide, cleared only by rebaseline()
```

`processDurable()` then ran `retainDurable(event)` *before* the generation-wide duplicate check. A replayed row of an
evicted turn was therefore no longer a duplicate for retention while still being one for ingestion, so the same call both
accepted and refused it. The deterministic counterexample is short: retain turns 1..32, admit turn 33 (turn 1 released,
`pool.seqs` forgets seq 1), then replay `row(turn 1, seq 1)` in the same generation. `retainDurable` re-admitted it,
which incremented `retainedDurableEvents` and put the pool one turn over its bound, so the **next** admission released a
turn that the identical evidence without the replay would have kept; only afterwards did `durableSeqs.has(1)` report
`duplicate-durable-event` and drop the normalized event.

Two frozen statements were violated by that: a duplicate `seq` does not count as activity, and
`retainedDurableEvents` counts the distinct durable rows admitted during the generation. A row that ingestion rejected
still mutated retention, and the same `seq` could increase the counter twice.

The reachable form is worth stating precisely, because it bounds what a test can show. A duplicate is refused while its
seq is still in the retention set, so the only duplicate that could be re-admitted is one whose row had already been
evicted — and a duplicate that pushes the pool back to its bound is invisible in both the counter and the occupancy. The
observable harm is therefore a *later legitimate* turn being released, which is why the new test asserts a control
comparison rather than a number: two feeds receive the same legitimate evidence, one of them additionally receives the
replayed row, and their resident sets and counters must agree.

### 3. The fix — admission before retention, and one identity set

Every durable entry route now passes one gate, `SessionEventFeed.admitDurable(event)`, whose substance is its order: the
`seq` is recorded as seen before retention is attempted and before normalization, so a row refused for either reason is
refused for good. Both routes call it — `processDurable()` for appended window entries and `applySettlement()` for the
entry carried by a `settle-assistant` — and both retain only after it has admitted them. The second route previously had
no duplicate check at all, so a repeated settlement entry could both refresh its turn and emit a second `attempt-settle`
over an outcome that was already committed.

Retention itself lost its private identity set. `DurableEvidencePool` now holds evidence bytes only: `record()` validates
the turn and stores the row, and `evict()` is a single map `delete` per released turn with no walk over that turn's rows,
because nothing outside the map is derived from them. Eviction forgets retained row bytes but not the fact that the `seq`
was already seen; `rebaseline()` remains the only boundary that clears both, which is what keeps a new generation free to
reuse a sequence number the previous one admitted. Comments in the module docstring, `MAX_RETAINED_TURNS`, the pool class,
`record()`, `evict()`, `admitDurable()`, `retainDurable()` and `docs/ARCHITECTURE.md` were rewritten to match, including
the complexity claim: the eviction no longer walks anything.

One accounting detail was separated deliberately. A row naming no finite turn is admitted as an identity — so a repeat of
it is refused rather than recounted — but it is not *retained*, because `turnEvents(turn)` can never retrieve it. The
counter tracks rows admitted **into retention** and is republished from the pool's `eventCount`, so an unkeyable row
leaves it unchanged, while identity still closes against it.

### 4. Failing tests written and run first

`test/dsh-017-durable-identity.test.js` (5 tests) was written against `b188511` and run before any production edit. Three
cases failed, and the other two are the complements that had to keep passing:

| case | on `b188511` |
|---|---|
| post-eviction duplicate appended | **FAIL** — `turnEvents(1)` returned the replayed row after turn 1 had been released |
| duplicate `settle-assistant` entry | **FAIL** — `2 !== 1` settlements emitted for one durable row |
| counter matrix | **FAIL** — `34 !== 33`, an evicted row's duplicate incremented `retainedDurableEvents` |
| duplicate of a still-resident row | pass (the pre-existing case, pinned so the fix cannot narrow it) |
| rebaseline permits seq reuse | pass (the complement: the fix must not become process-lifetime dedupe) |

Two Phase 7D.1.1 cases in `test/dsh-017-retention-contract.test.js` changed with the contract rather than against it.
`a duplicate seq neither duplicates a row nor refreshes its turn` asserted the return value of a direct `retainDurable()`
call; it now travels the real `append` route, because admission is what refuses a duplicate and `retainDurable()` is the
storage primitive *below* that gate. `retainedDurableEvents is a cumulative ingest count...` was repopulated through
`applyWindow` for the same reason and renamed to "cumulative admission count". Both still assert the same behaviour.

### 5. Verification for this round

Reported as a **local test result**: this repository has no CI runner, so `npm run verify` here is not CI verification and
is not described as such.

`npm run build:client` reports `client.js rebuilt (481581 bytes, mirrored to lib/client.js)`. `npm run verify` —
`scripts/verify-structure.mjs` followed by the Node test runner over `test/*.test.js` — reports **714 tests, 714 pass,
0 fail**, 5 above the Phase 7D.1.1 figure of 709 (all 5 in `test/dsh-017-durable-identity.test.js`), with
`structure OK (14 required files, 16 core modules, 63 test files, client bundle fresh)`. `git diff --check` is clean and
`node scripts/verify-sanitization.mjs` reports `sanitization verified — no personal content, all structural evidence
preserved`. `client.js` and `lib/client.js` are byte-identical.

### 6. Minimal clean-runtime smoke, no reload shortcut

No `dev_reload_package` was used as release evidence, and no long browser A/B was repeated, because no presentation path
changed. After a cache-ignoring reload of `http://127.0.0.1:50001/` the plugin's loader entry is `[active]` —
`turn-performance-meter (dsh-turn-performance-meter) [injected]`, entry `E:/Projects/DSHarness/dsh-turn-performance-meter/index.js`
— and the live meter is mounted and rendering in the conversation composer dock:
`.dsh-tpm-root[data-kind="live"][data-state="tool-running"]`, `aria-label="工具 · 8m48s"`, showing the running
`mcp__chrome-devtools__evaluate_script` call with its own elapsed time. No new plugin console error appeared: the page's
errors remain the pre-existing `useSessionPendingInteraction is not a function` template artifact — whose slot is
`conversation.session.header.utilities`, with no frame from this plugin — plus shell and other-plugin 404 polling.

The bundle the browser is actually served was re-fetched after the reload and contains this phase's code: 2,289,659 bytes,
5 occurrences of `admitDurable`, the generation-wide identity vocabulary, the withdrawal of the pool-local seq set, and
the single-`delete` eviction comment. Two limits on this smoke are stated rather than glossed over. The completed card
was not separately observed in this round: live and completed are mutually exclusive projections of one slot, the
conversation mounts only the turn currently being read, and a card therefore cannot be mounted while the agent's own turn
is still running — so the card's rendering is covered by the test suite (`live-presenter` / `completed-lifecycle`) and by
the Phase 7D.1.1 live observation rather than re-observed here. And the smoke ran against the running development
workspace (`E:/Projects/...`), not a packaged install; packaging is Phase 8 work.

## Phase 8 — release readiness (2026-09-27)

Documentation, compatibility, packaging, privacy and runtime gates for a **local** plugin. No metric semantics, UI, curve
arithmetic, DSH 0.1.7-rc.2 contract, retention policy or eviction behaviour changed. Two source edits exist and both are
outside the metric engine: the `index.js` host-entry comment, and a release-hygiene assertion in
`scripts/verify-structure.mjs`.

### 1. Baseline, re-verified rather than quoted

`git fetch origin` → `HEAD == origin/main == 82ec58abb658c7bb7d0eedcbf248b8f6c8e3d0db`,
`git rev-list --left-right --count HEAD...origin/main` → `0 0`, working tree clean. `dsh --version` → `0.1.7-rc.2`;
`& "$env:APPDATA\npm\dsh.cmd" --version` → `0.1.7-rc.2`; `npm list -g @deepseek-ai/dsh --depth=0` →
`@deepseek-ai/dsh@0.1.7-rc.2`. The baseline had not moved, so no divergence audit was required and no reset, rebase or
force operation was performed at any point in the round.

### 2. Install syntax: measured, not assumed

`dsh --help` documents the manager as `dsh plugin --profile <name> <pnpm-args…>`, and
`dsh plugin --profile web --help` delegates verbatim to pnpm's own help (pnpm 11.7.0). Reading the shipped manager
(`@deepseek-ai/dsh-plugin-manager` `lib/types/operations.js`) shows the sequence: pnpm runs in the profile directory,
then `reconcile()` adds each **newly installed** direct dependency to `dsh.profile.bundles` if and only if that package
declares `dsh.bundle`. This package declares `dsh.bundle.patch`, so the bundle row is written by the install itself and no
hand edit of the profile is needed. `parseInstallSpec()` requires a local path to be absolute and accepts both the `file:`
and `link:` prefixes.

Three disposable profiles were created to turn that reading into a measurement, then deleted:

| Probe | Command | Result |
|---|---|---|
| `p8-probe-file` | `dsh plugin --profile p8-probe-file add "file:E:/Projects/DSHarness/dsh-turn-performance-meter"` | initialized the profile; dependency `file:…`; `bundles: [@deepseek-ai/dsh-base, dsh-turn-performance-meter]`; `node_modules` entry a **real directory** |
| `p8-probe-link` | `dsh plugin --profile p8-probe-link add "link:E:/Projects/DSHarness/dsh-turn-performance-meter"` | dependency `link:…`; same bundle reconciliation; `node_modules` entry a **SymbolicLink** to the checkout |
| `p8-clone` | `dsh --profile p8-clone --from-default-profile web --dump-config`, then `add "link:…"` | bundle list `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-turn-performance-meter]`; the 1,197-line composed tree contains `- id: turn-performance-meter` |

The difference decides the documented form. A marker file created in the checkout **after** the `file:` install never
appeared through the profile's `node_modules`, and re-running `pnpm install` reported `Already up to date` without
resyncing it: `file:` freezes a copy, so it would serve the pre-rebuild `client.js` after the next `npm run build:client`.
`link:` keeps the profile reading the checkout. `README.md` §3 therefore documents `link:` with that reason, and uses a
portable placeholder path; the reference checkout path is given only as implementation evidence.

The `web` profile was confirmed untouched by the whole probe lifecycle: `package.json` SHA-256
`97A5BF676618293110BA7E38CC3692741FFE757F826DCC9B9B34E2B76544A703` before and after, and
`node_modules/dsh-turn-performance-meter` still a `SymbolicLink` to the checkout.

**Boundary:** no destructive uninstall/reinstall was performed, and the `web` profile was not cold-restarted. The session
performing this phase runs inside that profile on `http://127.0.0.1:50001`; a restart would terminate it. The stronger
substitutes are the disposable-profile install above and the served-bundle identity below.

### 3. The served bundle is the repository bundle

The client module is served inside a combined request:
`GET /plugins/??…,@deepseek-ai/dsh-client-ui-directory-picker-native/client.js,dsh-turn-performance-meter/client.js&rev=9e8027cfe26a`.
Isolating our module — from its `GENERATED FILE` banner to the closing `})` of its `__ModuleLoader__.load` wrapper —
gives 481,580 characters / 482,478 UTF-8 bytes hashing to
`5dd9159438c7d2e47d5b6646375a8f5369c9d822930bac44b31ceb039860e6fb`, which equals the repository `client.js` minus its one
trailing newline (the separator byte the server consumes). The browser executed exactly the repository bytes.

### 4. Bundle, mirror and freshness

`npm run build:client` → `client.js rebuilt (481581 bytes, mirrored to lib/client.js)`. `Get-FileHash -Algorithm SHA256`
gives `E45A0A738145AE7063C217F941E8E3F8D97E429DC3FE32E90D34D1F21D550A94` for **both** `client.js` and `lib/client.js`.

`scripts/verify-structure.mjs` already failed on a `client.js` stale relative to `src/`. It did not assert the mirror, and
`lib/client.js` is the file the local injector validates before a runtime injection, so a hand-edited or half-written
mirror would have been injected as if built. A mirror assertion was added and exercised both ways: with one line appended
to `lib/client.js` the check exited `1` printing `lib/client.js differs from client.js — run: npm run build:client`; after
`npm run build:client` it exited `0` with `structure OK (…, client bundle fresh, lib/client.js mirrored)` and `git status`
showing no modification to either bundle. The success line now names the mirror.

### 5. Secret and privacy audit

Family-A scan over the 175 tracked files found no sensitive artifact: no `.env`, credential store, `*.log`, `*.pem`,
`*.key`, `*.p12`, `*.pfx`, `*.har`, `*.pcap`, `*.sqlite`, `*.db` and no archive. The only name-pattern hits were
`token-allocation` (source and test) and `raw.js`, all legitimate.

Content scan over tracked files, each hit classified rather than deleted:

| Pattern | Hits | Classification |
|---|---|---|
| `password`, `Bearer token`, `Cookie` | inside `fixtures/**` | **SAFE FIXTURE** — verbatim upstream Chrome DevTools MCP tool-schema descriptions; the string is the placeholder example `{"Authorization": "Bearer token"}` in a recorded schema, not a credential of this project |
| `BEGIN PRIVATE KEY`, `BEGIN RSA PRIVATE KEY`, `secret` | `scripts/verify-sanitization.mjs:53,57`; `docs/IMPLEMENTATION_LOG.md:1118-1119` | **DOCUMENTATION** — the sanitizer's own detector list and the log's record of an earlier scan |
| `20659` in `fixtures/**` | 2 | not a disclosure — digit runs inside recorded epoch-millisecond timestamps (`1790229120659`), the exact class the sanitizer's value-level (not text-level) scan exists to avoid reporting |
| `C:\Users\20659\…` | `docs/DSH_API_NOTES.md:266`, `docs/IMPLEMENTATION_LOG.md:2641-2642,3101-3102`, `docs/TASKS.md:341` | **DOCUMENTATION EXAMPLE** — recorded local verification paths (`dsh.cmd`, the running web process), not credentials. Left in place: they are the precise record of a real local command, and rewriting them would falsify evidence. Stated in the release report as the one accepted disclosure class. |
| `D:\softwares\nodejs\node.exe`, `E:/Projects/…` | same rows | recorded local execution paths, same class |

No real email address (0 hits for the mailbox local-part, `163.com` and `foxmail`), no machine hostname
(`DESKTOP-FENG`: 0 hits), and no mailbox configuration. `HaowenCang` appears only in `LICENSE` (intended copyright) and
in the sanitizer's forbidden-term list. `node scripts/verify-sanitization.mjs` exits `0`: none of 22 forbidden terms in
any published fixture value, the file set and structural scalars preserved (9 fixtures cross-checked against untracked raw
originals at identical string lengths), and the sanitizer confirmed load-bearing. `fixtures/raw/` is git-ignored and not
tracked. **No real secret was found, so nothing had to be removed from Git history.** 163 UUIDs inside fixtures are the
recorded session/attempt/call identities the tests depend on; the sanitizer preserves them by design. Scan rerun after
`CHANGELOG.md` entered the final tree: no new sensitive content found, so the classifications above stand unchanged and
only the tracked-file count moved, from 174 to 175.

### 6. Package contents

`npm pack --dry-run` under `private: true` prints the listing and writes no tarball (confirmed: no `.tgz` appeared and the
tree stayed clean). 173 files, 2.35 MB packed / 8.53 MB unpacked: sources, tests, fixtures, docs, `dev/` tooling, both
bundle copies, `LICENSE`, and now `CHANGELOG.md`. Absent: `node_modules`, `fixtures/raw/`, logs, credentials,
screenshots, archives. The shortfall against the tracked tree is exactly the two `.gitignore` files npm withholds by the
gitignore fallback (`.gitignore`, `dev/fixture-recorder/.gitignore`); no tracked file is silently dropped otherwise, and no
untracked file entered the listing. No `files` field and no `.npmignore` were added — the installed artifact is a local DSH
file bundle that needs the repository layout, and restructuring packaging for a hypothetical registry distribution was out
of scope. Version stays `0.1.0`, `private` stays `true`.

### 7. Gates

Reported as a **local test result**: the tracked tree contains no `.github/` directory, so there is no CI runner and none
was added.

`npm run verify` → `structure OK (14 required files, 16 core modules, 63 test files, client bundle fresh, lib/client.js
mirrored)` followed by **714 tests, 714 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**, `duration_ms` 1078.3746. The count
is unchanged from Phase 7D.1.2 because this phase's structural addition is an assertion in the verify script rather than a
new test file. `git diff --check` is clean. `node scripts/verify-sanitization.mjs` passes.

### 8. Runtime smoke on the real host

Observed in the real DSH `0.1.7-rc.2` web client, with `dev_reload_package` and HMR deliberately not used as evidence.

*Idle.* A newly created session with no turn renders no meter at all — `.dsh-tpm-root` count `0`, `[data-kind="live"]`
count `0`, stable across 2.5 s. There is no live pill without an active turn, and no empty shell either.

*Streaming and tool-running.* A 50 ms DOM recorder installed in a second tab on the Phase 8 session collected 1,390
samples over 190,144 ms. State histogram: `pending-first-token` 11, `streaming-reasoning` 345, `streaming-output` 139,
`tool-running` 233, `waiting-model` 657. Consecutive samples sit 46–61 ms apart, consistent with the frozen 50 ms
presentation cadence. The transitions show the contract directly: `waiting-model 等待模型 2.06 s` →
`streaming-reasoning 思考 ≈0.50 tokens/s` → `… ≈18.5 … ≈21.8 … ≈87.5 … ≈202 tokens/s` →
`streaming-output 输出 ≈212 … ≈242 … ≈171 tokens/s`. Every live rate carries `≈`; the waiting-model state carries a
stopwatch and no rate, so no stale TPS survives a tool call or an inter-step gap. A second observation of the
tool-running state read `data-kind="live" data-state="tool-running" aria-label="工具 · 4m25s"`, text
`mcp__chrome-devtool… · 0.6s 4m25s` — the running tool's own name and elapsed time plus the tool wall timer, with no TPS
field. A late element screenshot of the live pill captured `data-state="streaming-output"`, `aria-label="输出 · 16m22s"`,
`输出 ≈79.5 tokens/s`.

*Completed card.* Re-opening the settled `# Phase 7D.1.2 — Generation-wide` session mounted
`data-kind="completed" data-status="completed" data-quality="estimated" data-view="summary"
data-session="session-e6b63be6-f770-4833-8664-fdf6ee9d29e6"` and rendered
`思考 TPS ≈204 tokens/s · 111.0s · ≈22,625`, `输出 TPS ≈307 tokens/s · 143.5s · ≈44,044`,
`生成 Tokens 66,669 tokens`, `总用时 643.3s`, `首响应 2.99 s`, footer `工具 113 · 101.7s`, `模型调用 109`. The card is
static: its text and full attribute string were identical across three samples spanning 3,000 ms, and no
`[data-kind="live"]` element existed alongside it. Generated Tokens and TTFT print bare while the two rates and their
same-chain token counts print `≈`, which is the display rule working on a turn whose usage is authoritative but whose
temporal shape is not.

*Curve interaction.* Hovering `.dsh-tpm-card` flipped `data-view` `summary → curve` and swapped `aria-hidden` across the
two `.dsh-tpm-view` elements from `["false","true"]` to `["true","false"]`; clearing hover returned both to `summary`.
`card.focus()` produced the same `curve` state with `document.activeElement === card`; `blur()` returned to `summary`. The
curve renders 178 non-empty phase-coloured `<path>` segments inside `viewBox="0 0 100 48"` (479×48 CSS px), with the peak
marker `峰值 ≈646 tokens/s`. A viewport screenshot confirms the legend (`思考` grey, `输出` orange), the dense trace and
the peak annotation, with the card seated above the composer.

*Reload durability.* A cache-ignoring reload of the same tab re-rendered the same session
(`session-e6b63be6-…`) and the same card with every number identical, and the card was static across a further 4,000 ms —
no resumed ticker.

*Console.* Three error classes remain after the reload, none from this plugin: a `Permissions policy violation: unload is
not allowed in this document` shell message; 404 polling from the shell and other plugins (27 and 65 occurrences); and
`TypeError: useSessionPendingInteraction is not a function`, whose stack is entirely inside the shell bundle
`index-Q6zc2uHV.js:56` with no frame from `client.js` or `lib/client.js`, plus its consequent
`slot entry crashed in 'conversation.session.header.utilities'` — a slot this plugin never registers in (it registers only
`conversation.input.dock`, id `turn-performance-meter`). Both are the pre-existing DSH shell template artifact already
recorded in the Phase 7D rounds.

### 9. Evidence boundaries carried forward

The Phase 7D.1 terminal-tail case (`turn/start` already slid out when `turn/end` arrives) remains **not reproduced in a
browser**: it rests on real recorded durable bytes, a real feed/controller replay, and the DSH bounded-window contract.
The `web` profile was not cold-restarted (the verifying session runs inside it), so the install evidence is the disposable
web-template clone plus the served-bundle hash rather than a restart. The completed card and the curve interaction, which
Phase 7D.1.2 could not re-observe, **were** observed in this phase. `npm run verify` remains a local test result. The
documentation rows naming `C:\Users\20659\…` are an accepted, classified disclosure rather than a redacted one.

### 10. Git gate

One ordinary fast-forward push of the single Phase 8 commit; `HEAD == origin/main`, divergence `0 0`, working tree clean,
`git diff --check` clean. No `--amend` after push, no rebase, no `--force`, no `--force-with-lease`, no reset of remote
`main`. No npm publish, no `npm access`, no git tag, no GitHub Release, and `private: true` retained. Version stays
`0.1.0`.

## v0.1.0 publication record

**Status: release plan — pending publication.** This section records the release contract as it is fixed *before* the tag
and the GitHub Release are created. It deliberately does not yet claim that a tag exists, that a Release exists or that
publication succeeded; those are claimed only if the gates below actually pass, and the outcome of the round is reported
in the round's own final report rather than in a post-tag commit, so that `main` HEAD and `v0.1.0` stay on one commit.

### 1. Contract

| Item | Value |
|---|---|
| Version | `0.1.0` (`package.json`, unchanged; no `npm version` was run) |
| `private` | `true`, retained |
| Baseline entering the round | `80057aebc9ea4d6b1cb487a2f850a12ed4faf438`, `HEAD == origin/main`, divergence `0 0` |
| Release target | the final release-state commit of this round, which is `main` HEAD at tag time |
| Tag | `v0.1.0`, annotated, created from that commit |
| Release type | final, not draft, not prerelease, marked latest |
| Asset | `dsh-turn-performance-meter-0.1.0.tgz`, produced by `npm pack` from the release commit |
| Checksum sidecar | `dsh-turn-performance-meter-0.1.0.tgz.sha256` |
| npm | unpublished; no `npm publish` and no `npm access` in this round either |
| DSH | `0.1.7-rc.2` only — no wider compatibility claim was added |

### 2. Round scope

Documentation only, plus the release machinery. No metric semantics, UI, curve arithmetic, adapter, retention or
eviction behaviour is in scope, and none was modified. The documentation edits flip statements that were true of a local
release candidate into statements that are true of a GitHub Release: the README status and install sections, the
CHANGELOG heading and distribution status, and the release records here and in `docs/TASKS.md`. `package.json` is
untouched.

### 3. Gates required before the tag is created

Baseline identity and the absence of an existing `v0.1.0` tag or Release; `npm run build:client`, `npm run verify`,
`node scripts/verify-sanitization.mjs` and `git diff --check` all passing; the packed tarball inspected for forbidden
content; the tarball installed into a disposable DSH profile; and that exact tarball cold-started in that disposable
profile against DSH `0.1.7-rc.2`. The user's real `web` profile is not restarted at any point. Only if every gate passes
are the annotated tag and the GitHub Release created, after which the published asset is downloaded again and its
SHA-256 compared against the pre-upload value.

## v0.1.1 npm distribution record

**Status: release plan — npm publication pending.** This round changes distribution only. No metric semantics, live TPS,
TTFT, curve arithmetic, tool accounting, DSH adapter contract, retention behaviour or client cadence is in scope, and none
was modified: `git diff -- src client.js lib/client.js index.js cordis.patch.yml` is empty at release state. The outcome
of the round is reported in the round's own final report rather than in a post-publication commit, so that `main` HEAD and
`v0.1.1` remain the same commit.

### 1. Contract

| Item | Value |
|---|---|
| Version | `0.1.1` (`package.json`; `npm version` was not run) |
| `private` | removed, not set to `false` |
| Peer | `@deepseek-ai/dsh` exactly `0.1.7-rc.2`, the only declared peer |
| Publication target | `https://registry.npmjs.org/`, `access: public`, tag `latest`, locked by `publishConfig` |
| npm artifact | 8 files: `package.json`, `index.js`, `client.js`, `lib/client.js`, `cordis.patch.yml`, `README.md`, `CHANGELOG.md`, `LICENSE` |
| Baseline entering the round | `9bd54431bbbaa5b7701939ebe64f598520700dd9`, `HEAD == origin/main`, divergence `0 0` |
| `v0.1.0` | left at `9bd54431…`; not moved, deleted or re-created |
| Release target | the final release-state commit of this round, which is `main` HEAD at tag time |
| Tag | `v0.1.1`, annotated, created from that commit |
| GitHub asset | the **registry-downloaded** tarball plus a `.sha256` sidecar |
| DSH | `0.1.7-rc.2` only — no wider compatibility claim was added |

### 2. Why the compatibility field is declared now and was not declared in `0.1.0`

The `0.1.0` README stated that no `package.json` compatibility-range field was declared because DSH's plugin
peer/preflight mechanism had not been verified as a usable gating schema. That statement was accurate for `0.1.0` and
became false the moment a peer was declared, so this round verified the mechanism before writing the field rather than
after.

`@deepseek-ai/dsh-plugin-manager` resolves a named registry spec by running
`pnpm view <spec> name version peerDependencies --json` against the registry that the run itself will use, and then calls
`evaluatePluginCompatibility` from `@deepseek-ai/dsh-app-boot`. That function returns `undefined` when the manifest has no
`peerDependencies` at all — which is precisely why `0.1.0` had no gate. Otherwise it walks the peer entries, ignores every
name that is neither `@deepseek-ai/dsh` nor `@deepseek-ai/dsh-*`, maps the three `workspace:` forms onto the current
runtime version, and rejects any range failing
`semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`. The runtime version is read from
`@deepseek-ai/dsh-app-boot/package.json`, which resolves to `0.1.7-rc.2`.

Checked directly against the bundled `semver` rather than reasoned about: `0.1.7-rc.2` satisfies `0.1.7-rc.2` → `true`;
the same runtime against `0.1.8` → `false` and against `0.1.7` → `false`. The exact range is a genuine gate. It is also
the only range consistent with §2 of the README: `^0.1.7-rc.2`, `~0.1.7-rc.2`, `>=0.1.7-rc.2`, `0.1.x` and `*` would all
admit runtimes this project has never exercised, and `^0.1.7-rc.2` in particular would admit `0.1.7` while rejecting
nothing that matters.

### 3. The import graph, and why only one peer was added

`git grep -n "@deepseek-ai/"` over `src`, `index.js`, `client.js`, `lib/client.js` and `package.json` returns hits in
three categories, none of which is a package dependency. Most are prose: comments naming the DSH declaration files that
the adapter contract was read from, and comments asserting the opposite — that `src/core` has zero `@deepseek-ai/*`
imports and that the bundle cannot require `@deepseek-ai/dsh-llm` or `@deepseek-ai/dsh-session`. Every production import
in the tree is relative.

The remaining category is the three names under `dsh.client.inject` in `package.json`. That field is part of the frozen
client contract and names modules the DSH web client provides to the plugin at runtime;
`@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-client-locale` and `@deepseek-ai/dsh-client-ui-conversation`
are all shipped inside the DSH installation's own `node_modules`. Declaring them as npm peers would have asserted an
installation requirement that does not exist, so they were left alone and `@deepseek-ai/dsh` was declared alone.

### 4. Why the `files` allowlist is safe

The allowlist was written only after the two entry points were shown to be self-contained, because a `files` list that
omits a path the runtime reads fails at load time rather than at pack time. `index.js` is a 714-byte host entry exporting
`name` and a no-op `apply`, with no import, no `require`, no `createRequire` and no path constant. `client.js` is a
482 479-byte generated browser bundle with no `readFile`, no `__dirname`, no `require.resolve` and no reference to `src/`.
Neither reads `cordis.patch.yml`; the DSH loader does, from the package root, which is why that file is in the allowlist.
`lib/client.js` is retained because it is the layout the local injector validates and it is byte-identical to `client.js`
by construction. Nothing else is reachable from the package at runtime.

One asymmetry is worth recording rather than hiding: `scripts/verify-structure.mjs` asserts the presence of `docs/**`, so
`npm run verify` is a checkout-side gate and cannot be run from the published artifact. That is deliberate. The published
package is a prebuilt artifact and carries no test or build tooling, which is why `test`, `build:client` and `verify`
remain in `scripts` but their targets do not ship.

### 5. Verification performed, and its boundaries

Gates at release state: `npm run build:client` rebuilt both bundle copies with no diff against the committed bytes;
`npm run verify` → 714 tests, 714 pass, 0 fail, with `structure OK (14 required files, 16 core modules, 63 test files,
client bundle fresh, lib/client.js mirrored)`; `node scripts/verify-sanitization.mjs` → PASS; `git diff --check` → clean.

The `npm pack` listing and the extracted manifest were checked field by field: 8 entries, no `src/`, `test/`, `fixtures/`,
`dev/`, `scripts/`, `docs/`, `node_modules/`, `.env`, credential, log or raw fixture; `private` absent; exactly one peer;
`publishConfig.registry` the official registry; and no lifecycle install script. A `--dry-run` publish reporting
`dsh-turn-performance-meter@0.1.1`, 8 files, 294.4 kB packed and 1.0 MB unpacked is the same artifact set.

The tarball was then installed into a disposable web-template profile and cold-started. The install reported exit `0` with
no `incompatible-version` rejection, and the composed configuration contains `turn-performance-meter`. pnpm emitted an
unsatisfied-peer warning and did **not** auto-install `@deepseek-ai/dsh`; the declared peer is evaluated against the
running runtime version, not resolved as an installed dependency, which is the behaviour the peer field is there for.

Cold start is evidenced on three surfaces: the host started with a log whose only line is the printed URL, so no plugin
startup error and no compatibility error occurred; `GET /` returned `200`; and the startup combo route — which is matched
by exact URL, including its revision, so a stale or unregistered plugin would 404 rather than degrade — returned `200`
with the plugin bundle present **verbatim**. The served combo contains the repository `client.js` byte-for-byte, probed at
five offsets, and the installed `client.js` SHA-256 equals the repository's, so the bytes the browser receives are the
bytes that were packed.

Evidence boundaries carried forward. Neither browser MCP endpoint was reachable in this environment, so the in-browser
check that an idle session renders no false live meter was **not** performed this round; the bundle-served evidence above
is a transport-level result, not a rendered-UI result, and the UI behaviour itself remains covered only by the local
suite. The `npm run verify` result remains a local result rather than CI, because the repository still has no CI runner.
No VPS, remote host or second machine was used.

### 6. Git gate

One ordinary fast-forward push of the single release commit, made **before** the registry action and re-verified after it;
`HEAD == origin/main`, divergence `0 0`, working tree clean, `git diff --check` clean. No `--amend` after push, no rebase,
no `--force`, no `--force-with-lease`, no reset of remote `main`, no movement of `v0.1.0`. The `v0.1.1` tag is created only
after the npm publication, the registry artifact verification and all three registry install gates pass. No `npm
unpublish` under any circumstance: a published npm version is an immutable artifact, and a failure after publication is
reported as a partial state rather than undone.

## Phase 9 — Completed Card Collapse & DSH Surface Alignment

Baseline `24f69c2c82901aed133ba3465d59b0f1fb584bf4` (`HEAD == origin/main`, divergence `0 0`, working tree clean,
`v0.1.1` peeled to the same commit, DSH `0.1.7-rc.2`). Presentation-only round: no version bump, no tag, no release.

Scope: the completed card's presentation state, structure, CSS and accessibility, plus the tests and docs that cover them.
Frozen and untouched: TURN-level aggregation, ratio-of-sums rates, the reasoning/output split, Generated Tokens, TTFT,
`toolWorkMs`/`toolWallMs`, attempt counting, the quality model, calibration, the curve rolling window, its compressed axis
and its peak, durable reconstruction and deduplication, the 0.1.7-rc.2 adapter contract and the 50 ms live cadence.
`src/core/**`, `src/dsh/**` and `src/host/**` are byte-identical to the baseline (`git diff --name-only` shows no entry
under them).

### 1. The host visual contract, read from source rather than sampled from a screenshot

The surface was taken from the official DSH `0.1.7-rc.2` TodoPanel. Only the compiled bundle ships in the local install
(`packages/client/ui-conversation` has no `src/`), so the CSS was read out of `lib/client.js`, where the module's sheet is
embedded as a string literal under the `TodoPanel.module.css` plugin-CSS tag. The two relevant rules, verbatim:

```css
.lXshSW_root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);border:0;flex:none;margin:0 auto;overflow:hidden}
.lXshSW_body{flex-direction:column;gap:8px;padding:6px 12px;display:flex}
```

The component contract beside it was read from the same bundle's `TodoPanel` function: `useState(true)` (collapsed by
default), `section` root, `div.body`, a single `button` header carrying `aria-expanded={!collapsed}`, and the child order
`lead / title / progress / chevron`, with `lead` and `chevron` both `aria-hidden`. The bundled React tree also fixes the
chevron direction, which is the reverse of the conventional pairing and is therefore asserted by a test rather than
assumed: **collapsed renders `ChevronUp`, expanded renders `ChevronDown`**.

Two consequences follow for this project. First, the plugin now writes no hex, no `rgba()` and no hand-chosen radius on
the completed surface — those are host tokens, and `test/completed-tree.test.js` forbids their return. Second, the live
pill is explicitly excluded from that rule, because it is a different row with a different reference; the sheet's own
test asserts the pill keeps `--dsh-tpm-surface`, its 10 px radius and its hairline, and the browser run below confirms it.

### 2. Where the card's width actually comes from

The completed card was wider than the todo panel because its root took the dock seat's full width and applied its own
`max-width` to the card instead of the host's dock formula. The fix moves the host's `width`/`max-width`/`margin: 0 auto`
onto `.dsh-tpm-root[data-kind="completed"]` — the sibling of TodoPanel's own root — and leaves the live root alone. It is
scoped by `[data-kind="completed"]` rather than by `.dsh-tpm-root`, so there is exactly one width contract per row.

### 3. State model, and why the header does not share an element with the curve

`src/client/completed/view-mode.js` now exposes `defaultCompletedPresentationState()` and
`nextCompletedPresentation(state, event, { interactive })`, where the state is `{ collapsed, mode }`. `nextViewMode` stays
exported and unchanged as the mode half, because it is the tested Phase 5 contract and the new reducer is merely its
caller; keeping both means the curve transitions cannot silently change meaning.

`collapsed` and `mode` are orthogonal, and the transitions that matter are the ones that write both. `toggle` while
collapsed opens the summary; `toggle` while expanded collapses **and resets the mode**, which is what makes "expand
always opens the summary" true for a reader who collapsed while looking at the chart. Events that the current state does
not admit are no-ops rather than resets, so a stray `mouseleave` cannot collapse an open card, and `enter`/`focus` on a
collapsed card change nothing at all.

The reaction to a new settled view lives in `CompletedMeter.js` as one effect keyed on the view identity, resetting curve
view and presentation together. Holding both in a single `useState` is deliberate: split across two states, a render
could exist in which the card is collapsed but still remembers the curve, which is the one state the round forbids.

The curve's handlers and its focus stop moved from `.dsh-tpm-card` to `.dsh-tpm-detail`. That is the structural half of
"header focus must not reveal the curve": the button owns expand/collapse and nothing else, and the region that owns the
curve is the region that answers to hover and focus.

### 4. The compact row reads, it never recomputes

`src/client/completed/compact-summary.js` composes the collapsed line from `view.status` and `view.columns[i].display`,
i.e. from strings `ui-model.js` already formatted. It divides nothing, sums nothing, rounds nothing and decides no
quality marker. The one formatting rule it adds is that a unit appears only when the reading does — `columns[i].unit` is
`null` for an absent metric — so an unavailable reading is the bare em dash and never `— tokens`. A test builds the
expected line out of the same `view.columns` the detail renders, which is what makes "reuse, do not re-derive" fail the
day the two disagree rather than merely today.

The visible title is a new locale key, `performanceTitle` (`Performance` / `性能`); `completedLabel` stays the accessible
name of the card and of the button.

### 5. Layout arithmetic

The card shell took the host's `padding: 6px 12px` and `gap: 8px`, so the reference geometry — which is a distance from
the **card edge** — had to be restated on the element that now owns it. The detail's inline padding is therefore
`26px − 12px = 14px`, and the footer's inline margin `12px`, preserving the measured 26 px to the first label. The old
`padding: calc(var(--dsh-tpm-font) * 1.55) 0` was removed from the outer card rather than kept under the new body, which
is what stops the header and the old padding from adding up. Measured in the browser: the expanded card is 155.67 px
against a 147.96 px always-expanded pre-Phase-9 shell, i.e. the header costs 7.7 px, and the collapsed row is 36 px.

### 6. Automated gates

`npm run build:client` rebuilt `client.js` and the `lib/client.js` mirror (byte-identical, deterministic).
`npm run verify` → **747 tests, 747 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo** (baseline 714; the round adds 33),
with `structure OK (14 required files, 16 core modules, 64 test files, client bundle fresh, lib/client.js mirrored)`.
`node scripts/verify-sanitization.mjs` → PASS. `git diff --check` → clean.

The new coverage is `test/completed-presentation.test.js` (component-level lifecycle: mounted state, toggle, re-render
stability, new-turn reset, and a zero-timer assertion) plus new cases in `test/completed-tree.test.js` and
`test/completed-interaction.test.js` for the collapse structure, the compact row, the CSS contract and the two focus
rings. One pre-existing test needed a one-line change: `test/curve-peak-priority.test.js` renders the card directly and
now passes `collapsed: false`, because the detail — and therefore the curve — is not rendered while collapsed.

`completed-presentation.test.js` loads the component through a synchronous `module.registerHooks()` loader that
substitutes a recording React, so `CompletedMeter.js` itself is the subject rather than a copy of its logic. `useRef`
there keeps its box across renders, which is load-bearing: a box that reset would make the component's
`previousView.current === view` guard always true and would mask a missing dependency array.

### 7. Browser evidence (real DSH 0.1.7-rc.2, real tab)

Captured through the Chrome DevTools protocol against the live `dsh web` GUI on `127.0.0.1:50001`, on a session whose
turn had already settled, so `.dsh-tpm-card` and `[data-testid="todo-panel"]` were on screen simultaneously — the
comparison §31 asks for, on the real elements rather than on a reconstruction.

Computed styles, light theme:

| property | performance `.dsh-tpm-card` | TodoPanel `[data-testid=todo-panel]` |
| --- | --- | --- |
| `borderRadius` | `16px` | `16px` |
| `backgroundColor` | `rgba(248, 249, 250, 0.58)` | `rgba(248, 249, 250, 0.58)` |
| `boxShadow` | `rgba(0,0,0,0.04) 0 0 0 0.5px, rgba(0,0,0,0.03) 0 3px 8px 0, rgba(0,0,0,0.02) 0 0 16px 0` | identical |
| `backdropFilter` | `blur(40px) saturate(1.5)` | `blur(40px) saturate(1.5)` |
| `borderTopWidth` | `0px` | `0px` |

Dark theme, applied with the host's own `body[data-ds-dark-theme]` switch, agrees on every property again and moves both
surfaces together: `rgba(67, 69, 74, 0.45)` background, `rgba(255,255,255,0.06)` stroke, `rgb(249, 250, 251)` text. No
completed-specific light or dark background exists in the sheet, which is why the two cannot drift.

Geometry, in CSS pixels, from the same two elements:

```text
Todo left   400.6667    meter left   400.6667    delta 0
Todo right 1524.6563    meter right 1524.6563    delta 0
Todo width 1123.9896    meter width 1123.9896    delta 0
```

Behaviour, driven through the real DOM: a settled turn arrives `data-collapsed="true"` / `data-view="summary"` with no
`.dsh-tpm-detail`, no metric cell, no footer and no SVG chart in the document; the header click yields
`aria-expanded="true"` / `data-collapsed="false"` with four cells and the footer; a second click returns to
`aria-expanded="false"` / `data-collapsed="true"` with the height falling 155.67 px → 36 px and the detail, cells, footer
and SVG all leaving the layout; collapsing from the curve returns `data-view` to `summary`, and re-expanding opens the
summary rather than the chart. A real pointer entering the detail switches `data-view` to `curve` with exactly one layer
exposed and the other `aria-hidden`, and leaving returns to `summary`. Keyboard focus on the toggle leaves `data-view` at
`summary`; focusing the detail raises the curve; blurring back to the inside of the card closes it. The only two tab stops
are `dsh-tpm-card-header` then `dsh-tpm-detail`. A page reload of the settled session re-renders the same card collapsed.
The live pill measured beside all of this is untouched: `rgb(245, 246, 247)` background, `10px` radius, `0.666667px`
solid hairline, no shadow, no backdrop filter.

Screenshots: `dev/screenshots/phase9/completed-collapsed-light.png`, `completed-expanded-light.png`,
`completed-curve-light.png`, `completed-collapsed-dark.png`. The directory is covered by `.gitignore`, so they are local
evidence and are not committed, as §33 permits.

### 8. Evidence boundaries

The settled card used for the visual comparison is a real turn from a real session, not a synthetic one, but it is a
**historical** session in the same GUI rather than a turn that settled while this round was running; the live turn was
still streaming throughout, and its own card could not be observed here. The browser harness drove that card through the
DOM (click, real `mouseover`/`mouseout`, `.focus()`), which is the same input path a reader uses, and read
`getComputedStyle` and `getBoundingClientRect` from it. The dark theme was applied by setting the host's own
`body[data-ds-dark-theme]` attribute rather than through the settings menu; the token values it resolves are the host's,
and both surfaces moved together under it. The "old completed-card height" of 147.96 px is the shipped detail measured
under a shell override that restores the pre-Phase-9 outer padding, radius and header absence in the live page — an
arithmetic reconstruction of the old outer box, not a checkout of the previous commit; it is reported as such. No second
machine, no remote host and no CI runner was used.

## Phase 9.2 — MiMo TPS semantics adoption (semantic unfreeze)

**Status of the superseded contract.** This round deliberately reopens the Phase 7C contract that live TPS must be a
trailing one-second rate and that the completed curve must use that same statistic. The old design is not deleted
silently: its decisions, their evidence and their reasoning are preserved here and in `docs/METRICS_SPEC.md`'s
supersession note, and `docs/MIMO_RUNTIME_METRICS.md` §14 records the adoption decision against the evidence in that
document.

### 1. What was superseded, and what was not

Superseded (unfrozen by explicit authorization):

| Old contract | Old decision | Replaced by |
|---|---|---|
| live TPS | trailing 1000 ms window (`SlidingWindowMeter`) | phase-cumulative average over the active phase episode |
| completed curve | the same trailing statistic, one attempt-local trace | the same phase-cumulative estimator family as the live pill |
| curve sampling | `DEFAULT_SAMPLE_EVERY_MS` = 250 ms | 100 ms |
| presentation cadence | 50 ms (Phase 5A winner) | 100 ms (MiMo fidelity) |
| completed phase denominator | attributed inter-delta generation time, terminal tail excluded | MiMo-style phase-episode wall time, terminal settlement tail included |
| peak | maximum of the full rolling series, before downsampling | maximum of the published (200-point-capped) cumulative series |

Still frozen, and re-asserted by the regression suites: turn-level aggregation; `reasoningTokens` included in
`outputTokens`; Generated Tokens semantics; TTFT (`turn/start -> first generated delta`); tool result exclusion; tool
wall/work accounting; attempt identity handling; durable reconstruction and deduplication; the phase-evidence
consistency guard; the quality axes; the 0.1.7-rc.2 adapter contract; the completed-card visual design; the
collapsed/expanded UI.

### 2. Why the old decision was defensible, and why it was still replaced

The Phase 2 measurement behind the old denominator stands: across ten recorded attempts the settlement trails the
stream's own `finish` chunk by 1–8 ms, the tail is 3 ms – 260 ms, and the longest attempt (33.8 s) had an 18 ms tail.
That evidence justified "the tail is host commit work, not decode work" for an *attributed inter-delta decode time*.
The target statistic changed, not the measurement: MiMo's completed output rate is
`outputTokens / (settlementTime - outputStartTime)`, i.e. wall clock to settlement, and a port that excluded the tail
would not reproduce it. `test/generation-tail.test.js` keeps the measurements and now asserts the new consequence.

### 3. Implementation summary

- `src/core/live-metrics.js` — the live meter is now a phase-episode estimator: `episodeStartMs`, `episodeTokenMass`,
  `episodeSampleCount`, a `Math.round`ed quotient, a 3-sample warm-up, a 1000 ms first-output fallback guard, and an
  in-stream-usage numerator (`counter - episodeStartBaseline`) that falls back to the shape mass whenever the
  phase-evidence policy refuses the split.
- `src/core/phase-duration.js` — `attributePhaseDurations(samples, {settledAtMs})` cuts an attempt into contiguous
  phase episodes and measures each as `episodeEnd - episodeStart`.
- `src/core/curve.js` — `cumulativePhaseTpsSeries` replaces `totalRollingTpsSeries`; `capSeriesPoints` implements the
  200-point nearest-neighbour stored-series cap; `DEFAULT_SAMPLE_EVERY_MS` is 100; `DEFAULT_WINDOW_MS` is gone.
- `src/core/time-axis.js` — an attempt's width is its terminal episode's end, so the settlement tail is drawn and tool
  waits still own no coordinate.
- `src/host/telemetry-design.js` — no `windowMs`; usage chunks are forwarded to the live meter; the settled curve is
  built from the capped series.
- `src/client/live/cadence.js` — `DEFAULT_PRESENTATION_REFRESH_MS = 100`, candidates `[200, 100, 50, 10]`.
- `src/client/live/live-presenter.js` / `ui-model.js` / `LiveMeter.js` — a `warming` view (phase label + episode
  elapsed counter) while the episode is below its warm-up count; the visual element structure is the existing
  `waiting` structure, so no CSS was touched.
- `src/core/sliding-window.js` and its test were **deleted**: the module was the trailing-window definition and nothing
  referenced it after the change.

### 4. Deliberate divergences from MiMo

No 200 TPS lower visibility gate (DSH models legitimately operate below it; the user's observed turn is ≈151/173
TPS); no 1564 ceiling; no `< 0.2 s` forced-zero rule; tool waits reported as `tps: null` rather than decayed across;
multi-attempt turns aggregated by ratio-of-sums rather than one whole-turn division; explicit DSH phase chunks instead
of MiMo's marker inference. The full list is in `docs/MIMO_RUNTIME_METRICS.md` §14.

### 5. Live evidence hierarchy, verified rather than assumed

The brief required the transient path for `StreamChunk { type: 'usage' }` to be verified before implementing.
Verified against the local `0.1.7-rc.2` install: `dsh-llm/lib/types/types.d.ts:417-447` declares the `usage` variant;
`dsh-agent-loop/lib/index.js` `AssistantStreamAttempt.push` emits a frame for **every** chunk including `usage`;
`dsh-api-session-controller/lib/client.js` republishes each frame as an `assistant/live-chunk` row with
`data.chunk` intact. Usage is therefore not settlement-only, and the live estimator's priority is
(1) usable in-stream provider counters, (2) generated-delta shape weights.

## Phase 9.3 — DSH 0.2.0-rc.2 compatibility migration (2026-09-29)

### 1. Preflight

`HEAD == origin/main == b59de4854b3619651b81b386e38874b240e2413b`, `git rev-list --left-right --count HEAD...origin/main`
→ `0 0`, working tree clean. `dsh --version` → `0.2.0-rc.2`; `npm list -g @deepseek-ai/dsh --depth=0` →
`@deepseek-ai/dsh@0.2.0-rc.2`. The Phase 9.2 commits `291e321` and `b59de48` were therefore the production candidate,
and the phase's own rule — do not restart Phase 9.2, do not revert those commits — was met by simply not touching the
semantics they introduced. No reset, rebase or force was performed at any point.

### 2. The audit: 14 declarations, compared by content address

The published DSH package ships compiled `lib/` plus `.d.ts`, not `src/`, so a source comparison could not be made
against the install. It was made against a local checkout of `deepseek-ai/deepseek-harness`, resolving every declaration
at both reference commits with `git rev-parse <sha>:<path>` and comparing the resulting blob hashes:

| Upstream path | blob at `477b4f42` / `639ed015` |
|---|---|
| `packages/core/session/src/types.ts` | `593c86d5` |
| `packages/llm/llm/src/types.ts` | `54453607` |
| `packages/llm/llm/src/assistant-stream.ts` | `7fca34c5` |
| `packages/api/session-controller/src/client/contract/events.ts` | `bc825f08` |
| `packages/api/session-controller/src/client/session-wire-event.ts` | `59d6ef5b` |
| `packages/api/session-controller/src/client/sessions/assistant-stream.ts` | `973fd108` |
| `packages/api/session-controller/src/client/sessions/session.ts` | `284abc56` |
| `packages/api/session-controller/src/client/contract/session.ts` | `2c8f16c4` |
| `packages/api/session-controller/src/client/contract/snapshot.ts` | `161cd858` |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | `61f7d8ff` |
| `packages/boot/app-boot/src/plugin-compatibility.ts` | `047fe1f9` |
| `packages/boot/plugin-manager/src/install-spec.ts` | `3ef46155` |
| `packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx` | `bf59a54a` |
| `packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css` | `04b537da` |

Fourteen of fourteen identical. Comparing blob identity rather than diffing text is what makes the finding a fact about
bytes: a reformatted or reordered file would hash differently and be reported as a change even with preserved meaning.

Because the sources were identical, no adapter work was justified. This is the phase's central result and it is worth
stating as such: **there was no contract to migrate.** The `src/dsh/**` tree therefore moved no code. The single edit in
it is `src/dsh/index.js`'s header — the module's normative statement of which runtime it targets — and the remaining
`0.1.7-rc.2` strings under `src/dsh/**` (in `adapter.js`, `client-feed.js`, `raw.js`) were deliberately left alone: each
names the version on which a specific shape was *audited*, which is recorded evidence rather than a stale target.

### 3. Confirmation against the installed runtime

The declarations the plugin is compiled against were then re-read from the installed `0.2.0-rc.2` tree, so the claim
rests on the runtime actually present and not only on the upstream repository: the `SessionEvent` envelope
(`dsh-session/lib/types/types.d.ts:489-512`), `turn/start` and `turn/end` (`:262-276`), `assistant/message` (`:330-338`),
`assistant/attempt` (`:344-348`), `tool/call` (`:354-360`), `tool/result` (`:374-388`),
`AssistantStreamRecord` (`dsh-llm/lib/types/assistant-stream.d.ts:16-40`), the `StreamChunk` union
(`dsh-llm/lib/types/types.d.ts:417-447`), `isTokenDelta` (`assistant-stream.d.ts:72-78`), `AssistantLiveChunkEvent`,
`SessionEventChange` and `SessionEventWindow`
(`dsh-api-session-controller/lib/types/client/contract/events.d.ts:6-63`), and `conversation.input.dock`
(`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:213-218`, `kind: 'list'`, `scope: 'session'`). Full
table in `docs/DSH_API_NOTES.md` §14.3.

Two differences between the two commits exist and were assessed as irrelevant rather than worked around:
`session-controller` gained an optional `fork(...).onCreated` callback (this plugin never forks), and the CLI gained the
exact-version exemption operations in §4 below.

### 4. The compatibility gate, measured rather than reasoned about

`evaluatePluginCompatibility` is exported by the installed `dsh-app-boot`, so it was imported and called directly against
the real manifest instead of the gate being paraphrased. With `"@deepseek-ai/dsh": "0.2.0-rc.2"` it returns `undefined` —
no incompatibility at all, which is a stronger statement than "exempted". The **control** is the informative half: the
previous `"0.1.7-rc.2"` peer against the same `0.2.0-rc.2` runtime returns

```json
{"name":"dsh-turn-performance-meter","version":"0.1.1","runtimeVersion":"0.2.0-rc.2",
 "peers":{"@deepseek-ai/dsh":"0.1.7-rc.2"},"exempted":false}
```

which shows both that the check is load-bearing and that the old declaration would have been refused. The gate's
predicate is `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })` over peers named
`@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`; `includePrerelease` is why a prerelease runtime participates in ranges at
all, leaving only the question of which range to declare. Checked against the bundled `semver` with the runtime fixed at
`0.2.0-rc.2`: `0.2.0-rc.2` yes, `0.1.7-rc.2` **no**, `^0.2.0-rc.2` yes, `>=0.2.0-rc.2` yes, `0.2.x` yes, `*` yes,
`0.1.7-rc.2 || 0.2.0-rc.2` yes. The exact pin is the only row satisfied by the intended runtime and unsatisfied by every
runtime this project has not exercised.

`0.2.0-rc.2` also ships exact-version exemptions (`allow-version`, `revoke-version`, `version-exemptions`, and the
`exempted` field above). **None is used or required.** An exemption accepts a declared incompatibility; this plugin
declares a compatible peer, so the gate passes on its own terms.

### 5. Production change surface

Two production edits, both declaration rather than behaviour:

```text
package.json      "peerDependencies": { "@deepseek-ai/dsh": "0.1.7-rc.2" }  ->  "0.2.0-rc.2"
src/dsh/index.js  the header's "target runtime is X" paragraph
```

plus the two generated bundle mirrors (`client.js`, `lib/client.js`) rebuilt from the second. `src/core/**` and
`src/host/**` are untouched, `package.json` `version` remains `0.1.1`, and the dual range was not introduced: the release
matrix is two separately bounded claims, `v0.1.1 → 0.1.7-rc.2` and `v0.1.2 → 0.2.0-rc.2`.

### 6. Automated verification

```text
npm run build:client            client.js rebuilt (522309 bytes, mirrored to lib/client.js)
npm run verify                  763 tests, 763 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo
                                structure OK (14 required files, 15 core modules, 64 test files,
                                client bundle fresh, lib/client.js mirrored)
verify-sanitization.mjs         PASS — no personal content, all structural evidence preserved
git diff --check                clean
```

746 before the phase; the 17 new tests are `test/dsh-020-contract.test.js`, the narrow layer described in
`docs/TEST_PLAN.md` §10. The historical `test/dsh-017-*.test.js` files were neither renamed nor restamped, and the
`fixtures/dsh-0.1.7/` corpus still declares `dshVersion: "0.1.7-rc.2"` because that is when it was recorded.

### 7. Package-install evidence in a disposable profile

A profile was initialised from the shipped web template and the plugin installed through the official command:

```powershell
dsh --profile p93-rc2 --from-default-profile web --dump-config
dsh plugin --profile p93-rc2 add "link:E:/Projects/DSHarness/dsh-turn-performance-meter"
```

Exit `0`. The profile's `package.json` then carried `dsh-turn-performance-meter: link:E:/Projects/...` and
`dsh.profile.bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-turn-performance-meter]` — the bundle was
reconciled automatically, with no hand edit. `node_modules/dsh-turn-performance-meter` is a **SymbolicLink** to the
checkout, which is the documented `link:` semantics, and the peer the profile sees is `0.2.0-rc.2`.

The decisive negative evidence is what was **absent**: no incompatible-plugin rejection in the install output, and no
`compatibility.json` in the profile directory at all, so no version exemption had been granted. The profile was then
cold-started once (`dsh --profile p93-rc2 --port 50011 --no-open`) and served the GUI with the plugin's client CSS
present and its slot mounted; the only error in that host's session was `API key is invalid`, an environment condition
of the fresh profile recorded and **not** investigated under this phase's exclusion rule. The profile was deleted
afterwards.

The real `web` profile was not modified: its `package.json` SHA-256 is
`4C8B1E2F6B0CFF687BBC6FA17A464E5F9836CEE50D4DD6001DC725CE37E5CD67` before and after the whole probe.

### 8. Runtime smoke and acceptance on DSH `0.2.0-rc.2`

Driven in the running `0.2.0-rc.2` GUI, in a session created for the purpose, with a DOM recorder sampling the meter
every 25 ms. Four turns were run: turn 1 a pure reasoning/output answer, turns 2–4 exercising tool calls.

**Cadence.** Across the live samples the gap between consecutive DOM changes has median **100 ms**, with the first
twenty-five gaps almost all exactly `100`. This is the phase's stated target and it is a presentation cadence, unrelated
to the runtime version — the assertion that it is still 100 is in the contract test.

**Phase transitions and live values.**

```text
rel 26 ms     completed card for the previous turn (the starting state)
rel 6698 ms   live  "0.08s 首响应计时"                open turn, no generated token yet — timer, not a rate
rel 8704 ms   live  "思考 ≈670 tokens/s 2.4s"         reasoning phase, phase-cumulative rate
rel 10937 ms  live  "pwsh · 0.4s 4.4s"                tool running — name and its own duration, TPS ABSENT
rel 11089 ms  live  "grep · 0.3s 4.6s"                second tool running
rel 11197 ms  live  "等待模型 0.27s 4.8s"              inter-attempt wait, still no rate
rel 12742 ms  live  "思考 0.01s 6.4s"                 next attempt: FRESH phase episode, counter reset
rel 13730 ms  live  "输出 ≈157 tokens/s 7.4s"          reasoning -> output transition
rel 36227 ms  completed "思考 ≈207 · 输出 ≈344 · 3,701 tokens · 首响应 2.30 s"
```

The `0.01s`/`0.08s`/`0.11s` episode counters after each tool wait are the phase-local reset, observed rather than
assumed. The last live value before settlement was `输出 ≈204 tokens/s` at `34.7s`, and the settled card carried the
authoritative recomputation.

**The settled card is numerically the durable log.** Each turn's card was compared against the turn's own
`assistant/message` usage rows:

| turn | durable `outputTokens` per step | sum | card |
|---|---|---|---|
| 1 | 6799 | 6799 | 6,799 |
| 2 | 461 + 306 + 885 | 1,652 | 1,652 |
| 3 | 342 + 271 + 889 + 915 + 1284 | 3,701 | 3,701 |
| 4 | 470 + 581 + 883 | 1,934 | 1,934 |

Four of four exact. This is the strongest available evidence that the Phase 9.2 completed-rate arithmetic survived the
runtime change untouched, because the inputs it divides are the durable settlement's own counters.

**Interactions.** Collapsed by default on every materialisation (`aria-expanded="false"`, no detail, no cells).
Expanding produced the four-column summary with the phase-episode secondary lines (`思考 TPS ≈211 · 27.8s · ≈5,875` /
`输出 TPS ≈328 · 2.8s · ≈924`). Hovering the detail switched `data-view` from `summary` to `curve` and rendered the
two-series chart with peak ≈623 tokens/s; leaving returned to the summary while the card stayed expanded, which is the
Phase 9 rule that the two decisions are orthogonal. Screenshot retained locally at
`dev/screenshots/phase93/phase93-curve-hover.png` (gitignored).

**Reload.** After a full page reload the card was reconstructed from durable evidence with values identical to the
pre-reload card, and collapsed again — the Phase 9 behaviour, since a reload materialises the component afresh. The
plugin's own diagnostics after the reload read `turnEndLookupHit: 2`, `turnEndLookupMiss: 0`, `settledSnapshotBuilt: 2`,
no feed issues.

**Isolation.** With two sessions attached simultaneously
(`["session-c9172ca8-…","session-5f232bba-…"]`), switching between them showed each session's own card and never the
other's, exactly one meter root at a time, and switching back restored the original values unchanged.

**Diagnostics at the end.** `turnEndLookupMiss: 0`, `turnEndReconstructed: 0`, `unmatchedToolResults: 0`,
`malformedToolResults: 0`, `lateTurnRows: 0`, `lateTurnEvents: 0`, `ignoredEvents: 0`, `droppedDeltas: 0`,
`feedIssues: []`, with eleven tool calls matched to eleven results and four settlements built. Of eight bare
`settle-assistant` calls, **eight** were resolved as retirements and **zero** as abandonments — independent runtime
confirmation of the §13.4 disambiguation on the 0.2.0 fold, which is the contract most at risk from a client-side change.

**Console.** No plugin error. The two error-class messages present were a framework permissions-policy notice and 404s
on `/api/pet/pets` and `/api/pet/state`, i.e. the unrelated `dsh-pet` plugin polling endpoints its host does not serve;
the meter's own bundle request returned `200`.

### 9. One observation recorded and not pursued

In a single sequence — the page had just been reloaded, and a new turn settled while the tab was not in the foreground —
the completed card continued to show the **previous** turn's values until the page was reloaded again. It did not
reproduce: the same page later advanced correctly from one turn's card to the next under the same conditions, the
durable path produced the correct card every time, and all four turns' cards matched the durable log exactly.

It is recorded rather than investigated because it involves no DSH contract, and this phase's subject is compatibility:
reopening presentation logic on unreproduced evidence would be exactly the kind of scope expansion the phase forbids. It
is left as a candidate for a future round with its conditions stated — page reloaded, settlement while the tab is
backgrounded, stale until the next reload — so that a later attempt starts from the conditions rather than from a
symptom.

**Resolved in Phase 9.3.1: not reproduced, 10/10 trials correct without a reload.** See §Phase 9.3.1 below.

---

## Phase 9.3.1 — Background settlement presentation verification (2026-09-29)

Baseline `0c2f16d18c65e82615f12406ba2fc7bd82350976`, DSH `0.2.0-rc.2`. The subject is the single observation §9 above left
open: after a page reload, a turn settled while the tab was backgrounded, and the completed card kept showing the
previous turn until another reload. The brief forbids reopening metric semantics, cadence, curve arithmetic, the DSH
adapter and tool accounting, and requires the observation to be *resolved* rather than re-described; a production change
is permitted only if a reproducible presentation defect demands a minimal one.

### 1. Outcome

**No defect reproduced. No production fix required.** Ten trials ran the exact recorded sequence (page reloaded → card
for turn N visible → turn N+1 started → tab backgrounded → turn N+1 settled → at least 1 s of dwell → tab foregrounded,
**no reloaded page**), and all ten advanced the completed card to turn N+1 on its own; an eleventh trial repeated the
sequence from a card at turn 2 and advanced 2 → 3. In every minimize-verified trial the card had already advanced
*before* the browser window was restored, so the foreground-to-correct-card latency was 0 ms: there was nothing left for
foregrounding to trigger.

The deterministic half of the evidence is
[`test/background-settlement.test.js`](../test/background-settlement.test.js): five tests that ingest a settlement and a
terminal boundary with **zero** projections interleaved — which is what a throttled background tab amounts to — and then
require the first projection to be the newest turn. The file was checked against a deliberately defeated controller (the
`turn/end` invalidation removed): all five tests fail, and the first projection returns turn 1's card, which is the
recorded symptom. The regression is therefore load-bearing rather than decorative.

### 2. Why the recorded symptom cannot be produced by the current code

The chain has four links, and the trials plus the regression locate the recorded observation at none of them.

`turn/end` is routed by `applyEvent` to `store.endTurn`, which is what makes the turn *readable*; the settled machine and
the settled snapshot are both in place before `invalidate(state)` runs, so the **very next** `project()` returns the new
card. That ordering is the first place a stale card could be manufactured, and the defeated-controller experiment shows
exactly what it would look like: dropping the invalidation alone reproduces "the previous card survives the settlement".

What a background tab actually changes is narrower than it first appears. Ingestion is a subscription on
`SessionEventSource`, not a timer, so the store receives the settlement while the tab is hidden; only *presentation* is
throttled, because the sole thing that calls `project()` from a live view is the 100 ms ticker
(`src/client/live/refresh.js`). The tab is also not left without a scheduler when the card is on screen: `MeterRoot`'s
subscription calls `refreshView()` directly for a static projection and the scheduler is never notified. That path is the
one the trials exercised, and it is why the DOM card had advanced before foregrounding in every minimize-verified trial.

The two remaining candidates — a stale `settledRead` and a mis-keyed projection cache — are both per-(session, settled
turn) and both invalidated on `turn/end`; there is no path on which a settled view for turn N can satisfy a projection
request for turn N+1. Assertions are in the regression for each: the first projection's turn, its identity distinct from
the previous card, its `projectionKey`, and the memo's behaviour under a moving clock.

### 3. Browser trials

**Runtime.** A second DSH `0.2.0-rc.2` web host on `127.0.0.1:50077` with its own `DSH_HOME`
(`dev/scratch/phase931-iso/`, git-ignored), mounting this repository's plugin from the workspace and the dev-only
fixture recorder, so the trials neither read nor wrote the operator's own sessions. Turns were driven through
`ctx.sessionController` — the same seam the GUI uses — with one prompt per turn and a fresh session per trial.

**What "backgrounded" was measured as, and why it is not `document.visibilityState`.** On this workstation, activating
another *tab* through DevTools does not background the DSH tab: the page reports `visible`, keeps focus, and keeps
servicing a 50 ms timer at 50 ms. Raising a topmost cover window does not change that either, but it *does* throttle
`requestAnimationFrame` to 1 Hz, which is a partial backgrounding. The condition the trials use is therefore the
unambiguous one: the browser window is **minimized** (`browser-window.ps1`, `IsIconic` verified true before and false
after). While minimized, the page stops being painted — the instrument records `requestAnimationFrame` gaps of
1000–1004 ms — and it also stops servicing its 50 ms sampler, which is why the sampler's own maximum interval stays near
its nominal value and the rAF record, not the sampler, is the backgrounding evidence. `document.visibilityState`
remained `visible` throughout, so it is reported as measured and is explicitly **not** used as the criterion.

**Per-trial record.** `data-turn` is the card's own attribute; the store read is
`controller.store.latestSettled(sessionId).turn` through the plugin's debug handle; the durable turn is the newest
`turn/end` in the host's session log for that session.

| Trial | Session | Durable newest settled turn | Store newest settled turn | DOM card turn | generatedTokens displayed | Card advanced while minimized | Foreground→correct card | Reload needed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `fixture-mumqw2fd-12` | 2 | 2 | 2 | 10.0 (≈) | yes (rAF 1 Hz record) | 0 ms | no |
| 2 | `fixture-mumr1pq9-16` | 2 | 2 | 2 | 10.0 (≈) | yes | 0 ms | no |
| 3 | `fixture-mumr34ct-18` | 2 | 2 | 2 | 9.00 (≈) | yes | 0 ms | no |
| 4 | `fixture-mumr4ey5-20` | 2 | 2 | 2 | 10.0 (≈) | yes | 0 ms | no |
| 5 | `fixture-mumr5w3y-22` | 2 | 2 | 2 | 10.0 (≈) | yes | 0 ms | no |
| 6 | `fixture-mumr73e4-24` | 2 | 2 | 2 | 10.0 (≈) | yes | 0 ms | no |
| 7 | `fixture-mumr87ew-26` | 2 | 2 | 2 | 10.0 (≈) | yes | 0 ms | no |
| 8 | `fixture-mumr9d6v-28` | 2 | 2 | 2 | 10.0 (≈) | yes | 0 ms | no |
| 9 | `fixture-mumrajro-30` | 2 | 2 | 2 | 10.0 (≈) | yes | 0 ms | no |
| 10 | `fixture-mumrbs0z-32` | 2 | 2 | 2 | 10.0 (≈) | yes | 0 ms | no |
| 11 | `fixture-mumrh1eu-1` | **3** | **3** | **3** | 9.00 (≈) | yes | 0 ms | no |

**Trial 11 is the stronger construction** and was added after the first ten. The first ten all advanced the card 1 → 2
from a freshly created session, so in every one of them the card the trial started from was the *only* settled turn the
store had ever held, and the terminal boundary arrived with its turn record open (`turnEndLookupHit`). Trial 11 prepares
**two** turns first — the reloaded page shows turn 2's card, the store holds turns 1 and 2, and `turn/end` for turn 3 has
to supersede a card that was already a *replacement* — and the advance observed is 2 → 3, with `turnEndLookupHit: 3`,
`turnEndLookupMiss: 0` and all three settled turns present in both the store and the durable log. Its page-side record
shows the same shape as trials 2–10: the card change (page clock 21 828 ms) precedes the read that prompted the release
(the page's clock/wall pair at read time is 30 537 / 1 790 691 529 756, so the change lands ≈2.8 s before the window was
restored), and `requestAnimationFrame` gaps of 1000–1004 ms bracket the minimized window.

Trial 1 is the trial whose backgrounding evidence is the weakest: its covered window is documented by a 1 Hz `rAF`
record (23 gaps of 1000–1004 ms spanning it) but the tab was not minimized, so it is reported as a trial that passed on
the acceptance criterion — the card advanced without a reload — rather than as one whose backgrounding is proven.
Trials 2–11 are all minimize-verified.

Trial 10's page recorded its card change at page-clock 24 419 ms and `Date.now()` 1 790 691 327 198 at page-clock
77 035 ms, which places the change 756 ms **before** the window was restored (`wallClock(t) = t − 77 035 + 1 790 691 327 198`).
That is the general shape of every minimize-verified trial: the card was already correct when the tab came back, so the
foreground-to-correct-card latency is not a small positive number but zero.

**No provider-level failures were investigated or needed.** Every trial's turn completed with `reason: { kind:
'completed' }` in the durable log; the plugin's own counters were identical in all ten
(`rawTurnEndSeen: 2`, `turnEndLookupHit: 2`, `turnEndLookupMiss: 0`, `turnEndReconstructed: 0`,
`settledSnapshotBuilt: 2`, `unmatchedToolResults: 0`, `lateTurnRows: 0`, `lateTurnEvents: 0`).

### 4. What this does and does not establish

The recorded sequence is not reproducible on the baseline commit under the conditions stated, and the presentation layer
is demonstrably not the layer that could hold a previous card once a new turn has settled. What the trials cannot settle
is what the single Phase 9.3 occurrence *was*: it was observed once, on a page whose reload coincided with an
API-environment failure the operator has since repaired, and it left no page-side record. The honest statement is
therefore that the observation is **not reproduced after targeted verification**, not that it is explained.

Two conditions from the original context are deliberately outside the trials' coverage, and are recorded as such rather
than folded into the pass: a settlement that arrives while the tab is backgrounded *and* the DSH web host is
unreachable, and a settlement whose `turn/end` never reaches the client at all. The first is an API-environment
condition the brief excludes; the second would leave the durable log without the boundary the acceptance criterion keys
on, so it is a different defect with a different signature — the card would be *live*, not stale.

One documentation defect surfaced and was corrected in `src/client/live/MeterRoot.js`: `isStatic`'s docstring claimed a
`hidden` projection was static, which the function never did and which would have been wrong (the ticker's own lifecycle
tests `view.kind !== 'hidden'` separately). The comment was aligned with the code; the code was not changed.

## v0.1.2 npm distribution record

**Status: release round — npm publication pending on an operator credential.** This round releases Phase 9, 9.2 and 9.3,
which are already in the tree. It adds no feature and changes no metric: `git diff -- src client.js lib/client.js
index.js cordis.patch.yml` is **empty** at release state. The outcome of the round is reported in the round's own final
report rather than in a post-publication commit, so that `main` HEAD and `v0.1.2` remain the same commit.

### 1. Contract

| Item | Value |
|---|---|
| Version | `0.1.2` (`package.json`; `npm version` was not run) |
| Peer | `@deepseek-ai/dsh` exactly `0.2.0-rc.2`, the only declared peer, unchanged by this round |
| Publication target | `https://registry.npmjs.org/`, `access: public`, tag `latest`, locked by `publishConfig` |
| npm artifact | 8 files: `package.json`, `index.js`, `client.js`, `lib/client.js`, `cordis.patch.yml`, `README.md`, `CHANGELOG.md`, `LICENSE` |
| Baseline entering the round | `5e697d8577501f16662f385c099eae1f8ca13af3`, `HEAD == origin/main`, divergence `0 0` |
| `v0.1.0` / `v0.1.1` | left at `9bd54431…` and `24f69c2c…`; neither moved, deleted or re-created |
| Release target | the final release-state commit of this round, which is `main` HEAD at tag time |
| Tag | `v0.1.2`, annotated, created from that commit **after** registry acceptance |
| GitHub asset | the **registry-downloaded** tarball plus a `.sha256` sidecar |
| DSH | `0.2.0-rc.2` only — no wider compatibility claim was added, and none is implied |

### 2. What this round does and does not contain

The tree already carried the Phase 9 presentation work, the Phase 9.2 estimator change and the Phase 9.3 compatibility
migration; the release round's job is to declare and publish them, not to extend them. The production diff is empty, so
the artifact that ships is the artifact the previous rounds verified. The three non-documentation changes are all
release-mechanical and are enumerated here rather than left to the diff:

1. **`package.json` version `0.1.1` → `0.1.2`.** The peer, `publishConfig`, `files`, `exports` and `dsh` blocks are
   untouched, and no lifecycle install script exists.
2. **Dead-helper removal in `test/background-settlement.test.js`.** The `harness()` object carried
   `record: turnNumber => controller.store.turns.get(turnKey(SESSION, turnNumber)) ?? null` while the file never imported
   `turnKey`. The member was unreachable — the only occurrence of the name in the file was its own definition — so it was
   removed rather than satisfied with an import. One line deleted.
3. **One release-induced assertion in `test/dsh-020-contract.test.js`.** It pinned `manifest.version === '0.1.1'` under a
   comment saying the `0.1.2` bump "belongs to the later release phase". This round is that phase, so the pin now reads
   `0.1.2`. The peer assertions beside it — exact pin, single peer, no range syntax, exact-prerelease shape — are
   unchanged. Grepping the suite for the old version confirmed this was the only assertion the bump invalidated.

### 3. Documentation: two stale paragraphs, and why they were not left alone

`README.md` §5 and §5.2 still described the **superseded Phase 7C estimator**: the live meter as a "current trailing
1-second window", the curve as an "attempt-local trailing-one-second total throughput trace" whose vertex sums
`(t - 1000, t]`. Phase 9.2 replaced that contract, and `docs/METRICS_SPEC.md` §6 states that no trailing window exists
anywhere in the rate path. The same README's §1 had already been updated to the phase-cumulative description when the
spec was, so the file contradicted itself, and the contradiction shipped: `README.md` is in the `files` allowlist.

The two paragraphs were rewritten to the phase-cumulative statistic, the phase-local reset, the hyperbolic stall decay,
the 100 ms sampling grid, the 200-point published-series cap and the 512-point chart render budget. This is documentation
alignment with behaviour that was already shipped and already claimed in §1 — not a metric change, and the empty
production diff is the evidence for that. Two further repository-map counts were corrected against the structure check
(`16` → `15` core modules, `63` → `65` test files) and the missing `docs/MIMO_RUNTIME_METRICS.md` row was added.

### 4. Verification performed, and its boundaries

Gates at release state: `npm run build:client` rebuilt both bundle copies and left them **byte-identical** to the
committed bytes, so `git status` lists no bundle file; `npm run verify` → **768 tests, 768 pass, 0 fail**, with
`structure OK (14 required files, 15 core modules, 65 test files, client bundle fresh, lib/client.js mirrored)`;
`node scripts/verify-sanitization.mjs` → PASS; `git diff --check` → clean. `client.js` and `lib/client.js` both hash to
SHA-256 `de920a21219e8d01c77703d18ec0dcd884975595b5fdbc6198f77c87d497138f`.

The `npm pack` listing and the extracted manifest were checked field by field: 8 entries, no `src/`, `test/`, `fixtures/`,
`dev/`, `scripts/`, `docs/`, `node_modules/`, credential, log or raw fixture; `version` `0.1.2`; `private` absent; exactly
one peer at `0.2.0-rc.2`; `publishConfig.registry` the official registry; `dsh.bundle.patch` present; and no lifecycle
install script. Digests for `dsh-turn-performance-meter-0.1.2.tgz` (320 830 bytes): SHA-256
`ade4a3c2e9ebf0ed75761755426a834cff0b3af3f76abdf797e8e93ab0177396`, SHA-1
`44655177439d2125d0f289a796d7108867813be6`, SHA-512
`ea16471f371569d5460fcfd8e4a29e47632a34aaa52bdc266da254f84368397ca29587ca77a677b85486c2919c1d576dfc8f80fc854dfb83cde39dcfb784fe13`.
The SHA-1 and the base64 integrity reproduce npm's own values for the dry-run artifact
(`sha512-6hZHHzcVadVGD8/Y5KKeR2MqNKqlK9wmbaJU+ENoOXyilYfKd6Z3uFSGwpGcHVdt/I+A/IVN+4PN453Pt4T+Ew==`), so the packed
bytes and npm's account of them agree before publication.

The tarball was then installed into a disposable web-template profile and cold-started on a free port. The install
reported exit `0` with no `incompatible-version` rejection and no compatibility exemption; the bundle was enabled
automatically in `dsh.profile.bundles`; `turn-performance-meter` appears in the composed configuration; and the installed
manifest reads `version` `0.1.2` with peer `0.2.0-rc.2`. The installed `client.js` SHA-256 equals the repository's. Cold
start is evidenced on three surfaces: the host log's only line is the printed URL, so no plugin startup error and no
compatibility error occurred; `GET /` returned `200`; and the plugin's own module route
`plugins/??dsh-turn-performance-meter/client.js&rev=10a2b2980515` returned `200` with the repository `client.js` present
**verbatim at offset 0**, the sole difference being the 83-character trailing `//# sourceMappingURL` directive the module
server appends. The host was stopped, the port confirmed free and the profile deleted; the real `web` profile was not
modified or restarted.

Evidence boundaries carried forward. The `npm run verify` result remains a local result rather than CI, because the
repository still has no CI runner, and no model call was made in this round: the packaging gate is a transport- and
composition-level result, and runtime functional evidence remains the Phase 9.3 / 9.3.1 browser record. No VPS, remote
host or second machine was used.

### 5. Authentication blocker, recorded rather than worked around

`npm ping --registry=https://registry.npmjs.org/` succeeded (`PONG 1396ms`), but `npm whoami
--registry=https://registry.npmjs.org/` returned **E401 Unauthorized**, where the `v0.1.1` round recorded exit `0`.
`C:\Users\20659\.npmrc` does contain a `//registry.npmjs.org/:_authToken` entry — its presence was confirmed with the
value redacted — and an authenticated `npm access list packages` also returns E401, so the stored credential is rejected
for authenticated operations while unauthenticated reads still work (`npm owner ls dsh-turn-performance-meter` →
`evan-williams <canghw2023@foxmail.com>`, exit `0`). No token, OTP or credential value was printed, logged, written to any
document in this repository or recorded in this round's report. The registry action is therefore blocked on the
operator's credential, and no authentication control was bypassed to proceed. Publication is the only irreversible step
in the round, so the round stops short of it and reports the partial state rather than substituting a different
credential path.

### 6. Git gate

One ordinary fast-forward push of the single release commit, made **before** the registry action and re-verified after it;
`HEAD == origin/main`, divergence `0 0`, working tree clean, `git diff --check` clean. No `--amend` after push, no rebase,
no `--force`, no `--force-with-lease`, no reset of remote `main`, no movement of `v0.1.0` or `v0.1.1`. The `v0.1.2` tag is
created only after the npm publication, the registry artifact verification and all three registry install gates pass. No
`npm unpublish` under any circumstance: a published npm version is an immutable artifact, and a failure after publication
is reported as a partial state rather than undone.

## Phase 9.4 — TTFT boundary and episode TPS opening stabilization (recovery round)

This phase repairs two independently identified defects in v0.1.2 and is recorded here in the round that actually performed
it: the original Phase 9.4 session crashed mid-work and its conversation state was lost, so this round began by recovering
the uncommitted implementation from the working tree. **Nothing is claimed about the lost session's reasoning**; only what
the repository itself contains is treated as evidence, and every recovered change was re-audited here before it was kept.

### 1. Recovery checkpoint (recorded before any write)

```text
Recovery status:            RECOVERED UNCOMMITTED
Remote baseline:           58685f0abe023629eb776ecd5e75b626bd12c428  (release: prepare v0.1.2)
Local HEAD:                58685f0abe023629eb776ecd5e75b626bd12c428
Working tree:              26 modified tracked files, 10 untracked files, 0 staged, no stash
Recovered Phase 9.4 files: see §2
Recovered Phase 9.4 commits: none — `git rev-list --left-right --count HEAD...origin/main` = 0 0
Recovery backup path:      E:\Projects\DSHarness\_recovery-backups\phase94-20261001-005951
```

The recovery audit was deliberately read-only first. `git status --short --branch`, `git rev-parse HEAD`,
`git rev-parse origin/main`, `git fetch origin --tags`, `git rev-list --left-right --count HEAD...origin/main`,
`git log --oneline --decorate -20`, `git diff --stat`, `git diff`, `git diff --cached`, `git stash list` and
`git reflog --date=iso -20` were all run **before** any write, and none of `git reset`, `git clean`, `git checkout .`,
`git restore .`, `git pull --rebase`, `git rebase`, `git stash push`, `git gc` or `git prune` was run at any point.

`HEAD` was exactly the released baseline and the index held nothing, so this is **CASE B**: no local commit implemented
Phase 9.4 and the entire implementation existed only as uncommitted work. It was preserved before being inspected:

- `git diff` → `worktree.diff` (816 428 bytes — the complete tracked change set),
- `git diff --cached` → `index.diff` (0 bytes, confirming an empty index),
- `git status --short` → `status.txt`, `git rev-parse HEAD` → `HEAD.txt`,
- all 10 untracked files copied verbatim under `untracked/`.

The untracked set was `src/core/rate-publication.js`, `test/rate-publication.test.js`,
`test/curve-rate-publication.test.js`, `test/ttft-boundary.test.js` and five `probe-*.mjs` scratch scripts. Because the
backup is a plain copy outside the repository, the recovered work could then be audited, repaired and extended without any
risk of losing it.

### 2. Audit of the recovered work

The recovered diff was 27 files, `3606` insertions and `993` deletions. It was classified change by change against the
phase's own normative sections rather than trusted or discarded wholesale.

**KEEP — the recovered implementation already satisfied the specification and was left semantically intact.**

| Recovered artefact | Verdict |
| --- | --- |
| `src/core/rate-publication.js` (new) — `MIN_RATE_SAMPLES = 3`, `MIN_RATE_ELAPSED_MS = 100`, `rateAvailability`, `rateIsPublishable`, the four `RateUnavailable` reasons | KEEP — this *is* the one named shared contract the phase requires; both halves already import it |
| `src/core/delta-accounting.js` — `isTokenDelta` mirroring DSH exactly, `tokenEvidence()` returning `{countsAsToken, phase, contributesMagnitude}` | KEEP — decouples the TTFT boundary from TPS magnitude at the predicate, as required |
| `src/core/curve.js` — per-episode 100 ms ladder, `tps: null` for non-publishable vertices, `peakTps` skipping non-finite, `peakProvenanceOf` | KEEP — the phase-local ladder is the preferred §12 implementation, not the eligibility-gated fallback |
| `src/core/live-metrics.js` — `observeTokenBoundary`, `MIN_WARMUP_SAMPLES` as an alias of `MIN_RATE_SAMPLES`, elapsed horizon in `episodeRate` | KEEP |
| `src/host/telemetry-design.js` — `firstTokenObserved(record, {timeMs})` one-way freeze; boundary-only chunks stamp TTFT without producing a sample | KEEP |
| `src/client/live/controller.js` — `ATTEMPT_DELTA` consults `tokenEvidence()` instead of returning early on "no sample" | KEEP — this is the exact line the TTFT defect lived behind |
| `src/dsh/adapter.js` + `src/dsh/stream-decoder.js` — publish `firstTokenMs`/`firstTokenTimeMs` from the predicate, so durable and live agree | KEEP |
| `test/ttft-boundary.test.js`, `test/rate-publication.test.js`, `test/curve-rate-publication.test.js` (new) | KEEP — audited test by test; every assertion is a genuine contract assertion |

**REPAIR — recovered but incomplete or wrong, and repaired in this round.**

| Finding | Repair |
| --- | --- |
| Seven assertions across five test files still encoded the pre-fix contract and failed: `795` tests, `788` pass, `7` fail | Stale expectations updated to the corrected contract with the arithmetic re-derived from episode facts — see §4 |
| `docs/IMPLEMENTATION_LOG.md`, `docs/TEST_PLAN.md`, `docs/TASKS.md` were untouched by the recovered run, so the phase had no documentation | This section, plus the TEST_PLAN and TASKS records |
| The five `probe-*.mjs` scratch scripts were untracked repository-root clutter that no gate or documentation references | Not committed; preserved in the recovery backup |

**DROP — nothing.** No recovered artefact was discarded. The one substantive risk — that the recovered `peakTps` repair
might be *suppressing legitimate high peaks* rather than removing invalid ones — was tested rather than assumed, and is
recorded in §3.

### 3. The one recovered claim that was verified instead of trusted

A maximum is a statistic, so a rule that removes vertices can silently remove the true peak. The recovered revision
lowered one frozen expectation from `10 000` to `6 000` tokens/s, which is exactly the signature of an over-broad
exclusion, so the case was reproduced directly (`probe-recovered-peak.mjs`, since deleted) before the expectation was
accepted as stale.

The fixture is sixty ordinary calls of three 400-character deltas on a 250 ms grid plus one loud call of five
4000-character deltas, each block its own attempt. The spike attempt's samples are at local `0, 250, 500, 750, 1000`, each
weighing 1000 estimated tokens. Its ladder is `0, 100, …, 1250`. The corrected estimator reports:

```text
local   elapsed  samples  mass   tps
    0         0        1   1000   null   opening-anchor
  100       100        1   1000   null   below-sample-warmup
  200       200        1   1000   null   below-sample-warmup
  300       300        2   2000   null   below-sample-warmup
  400       400        2   2000   null   below-sample-warmup
  500       500        3   3000   6000   <-- publishable peak
  ...                                    (decaying to 4000 at 1250)
```

The old `10 000` was `1000 tokens / 100 ms` read off the **attempt-global** grid, which placed a vertex 100 ms after the
attempt started regardless of where the delta boundaries fell. On the episode's own ladder a sample 250 ms distant cannot
enter a vertex 100 ms after the origin — the `4000`-character delta weighs 1000 tokens and the episode had accumulated
exactly one of them — so the honest first publishable measurement is `3000 / 500 ms = 6000`. The spike still **dominates**:
ordinary attempts peak at `600`, so the ratio survives at 10×, and the winning vertex satisfies both gates
(`elapsedMs = 500 ≥ 100`, `episodeSampleCount = 3 ≥ 3`). The expectation was therefore stale, not the estimator, and it was
updated to the value the corrected estimator produces. This is the reason §14's "do not clamp a valid high peak" is not in
tension with §16's "no sub-100 ms peak survives": the repair removes vertices that were never measurements, and the peak
remains wherever a real measurement puts it.

### 4. Baseline reproduction — both defects proven on released v0.1.2

A repair is only a repair if the defect is reproducible before it. `58685f0` was extracted read-only with
`git archive` into `E:\Projects\DSHarness\_recovery-backups\phase94-baseline\repo` — no checkout, reset or stash was used
— and the same implementation-neutral harness was run against both trees. The harness imports only entry points that exist
in **both** revisions (`TurnTelemetryStore`, `LiveMeter`, `isTokenDelta`, `classifyDelta`, `curveViewModel`), so the two
columns below are the same code measuring the same fixtures.

#### BUG A — the first-token boundary

| Observation | v0.1.2 | fixed |
| --- | --- | --- |
| `isTokenDelta({type:'tool-call-delta', name:'pwsh', argumentsDelta:''})` | `true` | `true` |
| `classifyDelta(<same chunk>)` | `null` | `null` |
| `store.acceptChunk(record, attempt, {timeMs: 1200, chunk: <same>})` | `null` | `null` |
| `record.firstTokenMs` after that call | **`null`** | **`1200`** |
| `attempt.samples.length` | `0` | `0` |
| fabricated token mass | none | none |

The defect is therefore exactly where §7 says it is: the predicate accepts the chunk, the classifier cannot attribute a
magnitude to it, and the released controller's `if (sample === null) return` (`src/client/live/controller.js:235` in
v0.1.2) discards the boundary before it can reach the presenter. The state machine itself is **not** at fault — driving
`reduceLiveUi` with the same `delta` event produces the identical `pending-first-token -> streaming-output` transition in
both trees, which is why the fix is at the controller's gate rather than in the machine. The step that differs is the one
that never called it.

**Provenance note.** The live `LiveMeter` half of BUG A cannot be replayed on v0.1.2 by the same harness: TTFT there is
frozen only inside `acceptSample`, which rejects the boundary chunk because its weight is not `> 0`, so v0.1.2 has no
equivalent entry point to call. The released *consequence* is still measured — the store-level freeze above is the same
one-way stamp the live path reads, and the state machine evidence shows the presenter never advanced — but the claim
"v0.1.2's `LiveMeter.firstTokenMs` stayed `null`" is established by reading the released source, not by executing it.

#### BUG B — the episode TPS opening

`peakTps` on the turn's own curve, from fixtures whose arithmetic is stated in the test names:

| §16 case | fixture | v0.1.2 | fixed |
| --- | --- | --- | --- |
| CASE 1 | phase opens at 250 ms; old remainder `300 − 250` | `2000` | `null` (episode never reaches 3 samples) |
| CASE 2 | phase opens at 299 ms; old remainder `300 − 299 = 1 ms` | **`100 000`** | see CASE 6 |
| CASE 3 | three samples share one instant | `300`, opening anchor published as `tps: 0` | `null`, reason `opening-anchor` / `below-elapsed-horizon` |
| CASE 4 | three samples inside 50 ms, episode ends inside the horizon | `600` | `null` |
| CASE 7 | one sample | `4000` | `null` |
| CASE 7 | two samples | `3000` | `null` |

The 1 ms denominator is the defect in its purest form: `100 tokens / 1 ms = 100 000` tokens/s, promoted to `peakTps`
because `peakTps` is a maximum. The observed ≈`23 500` figure in the report that opened this phase is the same
mechanism with a smaller numerator; the mechanism, not the magnitude, is what is repaired.

#### CASE 6 — the heavy calibrated delta, and what must **not** move

The strongest form of the test is the one that also proves the repair is narrow. An attempt streams reasoning, switches
to output **off-grid at 299 ms** with a 500-token first delta, then keeps streaming — so the output episode reaches
publishable vertices and the heavy delta is a measurement rather than a lone sample.

| Quantity | v0.1.2 | fixed |
| --- | --- | --- |
| worst published rate | **`500 000`** (the 1 ms quotient) | — |
| `peakTps` | `500 000` | **`2000`** (600 tokens / 300 ms, 3 samples) |
| shortest publishable denominator | `1` ms (implied by the above) | **`300` ms** |
| any vertex below 100 ms | **yes** | **no** |
| `sumOfSampleWeights` | `870` | `870` |
| `attemptTrace.tokens` | `870` | `870` |
| `settled.outputTps` | `1247.920133111481` | `1247.920133111481` |
| `settled.reasoningTps` | `401.33779264214047` | `401.33779264214047` |
| `settled.generatedTokens` / `observedGeneratedTokens` | `null` / `0` | `null` / `0` |
| `settled.attemptCount` | `1` | `1` |
| `settled.ttftMs` | `0` | `0` |

Every preservation figure is identical to the last digit; only the invalid peak moves. The winning vertex's debug
provenance names its evidence: `attemptId a1`, phase `output`, `episodeStartMs 299`, `pointTimeMs 599`,
`elapsedMs 300`, `episodeSampleCount 3`, `episodeMass 600`, `sampleQuality estimated`, contributing sample times
`[299, 400, 500]`. A future four- or five-figure peak can be audited from that record instead of guessed about.

### 5. The renderer half of the repair, and how it was found

The repaired policy publishes a withheld vertex as `tps: null` rather than `0`, and that change had a consequence outside
the estimator which the recovered work had not yet carried through. `src/client/completed/curve-view-model.js` treated a
non-finite rate as "not a vertex" and dropped it, so:

- a zero-width attempt — one whose single delta is its whole trace — produced an **empty** run instead of the point
  marker it is supposed to draw, so the chart could not show that the attempt had happened; and
- `curve.renderBudget.elementPoints` (the allocator's count over every budgeted vertex) and
  `curveViewModel.renderElementPoints` (what the SVG actually receives) stopped being the same number. On a saturated
  120-call fixture the first read `480` against the second's `240`, so the two published halves of one quantity disagreed
  by exactly the number of withheld vertices.

Neither was a stale expectation. The test file's own prose already described the intended contract — "published as `null`
rather than as a fabricated zero", "on the axis floor rather than on a measurement" — and `assert.equal(marker.props['data-tps'], 'null')`
was already written; the renderer simply could not produce it. Diffing the released test file shows the same assertion
read `'0'` in v0.1.2, so the assert and its comment had been updated for the new contract while the implementation had
not. That is the shape of an interrupted round, and it is why the recovery audit compared the recovered tests against the
recovered sources instead of trusting either alone.

The repair, both halves of one rule: a vertex with no rate keeps its **position** and loses its **value** — placed at the
axis floor, excluded from every run's drawn path, excluded from the run's own `peak` and from the turn's, and carried to
the DOM as `data-tps="null"`. `renderBudget.lineVertices` then counts the measured vertices the SVG receives, so
`elementPoints` and `renderElementPoints` agree again while `curve.drawnPoints` keeps its distinct meaning as the
allocator's own count. No class of vertex is fabricated and no run bridges a gap: a run holding two or more unmeasured
vertices is still a gap rather than a dot.

### 6. Isolated real-machine environment (protected environment untouched)

The phase's safety contract requires all real testing to use a disposable profile and forbids any interaction with a
running one. The environment was therefore inventoried read-only before anything was started, and the inventory corrected
two assumptions in the task brief itself:

| Item | Measured | Note |
| --- | --- | --- |
| `19387` (the operator's live GUI) | **PID 46308**, `DeepSeek Harness.exe`, desktop host, profile `desktop` | the brief paired this port with PID 21088; that pairing is inverted |
| `3080` | **PID 21088**, `node .../dsh/lib/bin.js web --no-open`, profile `web` | a second independent live instance |
| operator Chrome | PID 43176 | never attached to, never navigated |

Both live instances, both profiles and both ports were treated as the protected set. The **only** permitted interaction
was read-only process discovery and directory snapshots.

**Isolation, source-verified rather than guessed.** The mechanism is `--from-default-profile <name>`
(`lib/bin.js:105`), and `initializeProfileFromDefault` (`lib/profile-boot-BZ2ZjNWi.js:139-169`) takes its template from
the shipped `PROFILE_TEMPLATES` table, never from a profile directory — so `--from-default-profile web` does **not** read
`profiles\web`; the doc comment at `:129-133` states that only the template's bundle list is copied and no inheritance
metadata is persisted, and `mkdirSync` at `:147-155` throws `EEXIST` so an existing profile is never merged or
overwritten. `--dump-config` runs the same initialization without booting. A second `DSH_HOME` was deliberately **not**
invented; `$DSH_HOME/cordis.patch.yml` was verified absent, so no home-wide overlay leaked into the isolated boot.

**The disposable profile and instance.**

```text
profile name : tpm-phase94-isolated
profile path : C:\Users\20659\.dsh\profiles\tpm-phase94-isolated   (9 files, own identity)
identity     : dsh-profile-tpm-phase94-isolated
port         : 29617  (bind-tested free immediately before start, host 127.0.0.1)
PID          : 1344    (node, the process this round started and the only one it ever stopped or started)
start command: cd E:\Projects\DSHarness\_recovery-backups\phase94-isolated\workspace
               node ...\@deepseek-ai\dsh\lib\bin.js --profile tpm-phase94-isolated \
                 --port 29617 --host 127.0.0.1 --no-open
plugin form  : plugin --profile tpm-phase94-isolated add "link:E:/Projects/DSHarness/dsh-turn-performance-meter"
               (exit 0, pnpm 11.7.0, no compatibility exemption at peer 0.2.0-rc.2)
```

The isolated cwd is a fresh workspace directory, so its sessions cannot land in the operator's session bucket. The boot
proved the plugin loaded **from the isolated profile's own output**, not from inference: the served page's `__DSH_BOOT__`
carries `{"id":"dsh-turn-performance-meter","url":"plugins/??dsh-turn-performance-meter/client.js&rev=9924c56da80b",...}`
and the profile's `dsh.profile.bundles` reads `[dsh-base, dsh-web-app, dsh-turn-performance-meter]`.

**Containment, measured rather than asserted.** Read-only before/after snapshots (SHA-256 + size + mtime per file) of
`profiles\web` (7441 files) and `profiles\desktop` (3129 files) show **0 added, 0 removed, 0 changed** across the
isolated start; `task-board` likewise 3 files, unchanged. PID 21088 and PID 46308 are still alive and still own 3080 and
19387 respectively. No global process kill of any kind was issued at any point, and no write to a protected profile path
was performed. The instance's `rev=` was also independently reproduced from the live file's metadata
(`mtimeMs`/`ctimeMs`/`size` → `9924c56da80b`), and the served bundle was shown to be the repository `client.js` at
byte offset 0 with only the 83-byte `;\n//# sourceMappingURL=…` trailer appended — so the isolated host was serving
exactly the bytes this round commits.

One measured limit on the isolation claim, stated rather than glossed: `$DSH_HOME` is a single root and some of its state
is **not** profile-scoped — the workspace registry under `storages\`, the `dsh-usage` ledger and the cost meter are
global, and any extra instance appends to them. That is how the product behaves for any additional instance (the operator
already runs two), and no session bucket for the isolated workspace was created. It is not claimed that `DSH_HOME` was
byte-identical afterwards; it is claimed that no protected *profile* path was written.

**Lifetime honesty.** The isolated host was stopped once, deliberately, by this round (PID 56728) on a mistaken caching
hypothesis, and restarted as PID 1344 — see §7. No protected process was ever signalled.

### 7. A correction this round made to itself

Two claims in this round were wrong and are recorded rather than quietly dropped, because each changed what was tested.

1. **The stale-bundle claim was wrong.** This round observed a 2-character length difference between the served bundle
   and the freshly built `client.js` and concluded the module server was serving a cached pre-edit bundle. It is not.
   `artifactRevision` (`@deepseek-ai/dsh-client-modules/lib/index.js:192-199`) derives `rev` from
   `[mtimeMs, ctimeMs, size]` — its own comment says "without hashing its contents" — and the served body is the
   repository file plus a trailer beginning `;\n`. The 2 characters were that `;\n`; the body was byte-identical all
   along, the `rev` had already moved `ecf9d9b7568a` → `9924c56da80b` with no restart, and the isolation engineer was
   right to refuse the restart this round asked for. Useful consequence for the future: because `rev` is metadata-derived,
   a content change that leaves size *and* timestamps unchanged would not be picked up at all, and a page **reload** rather
   than a host restart is what makes a browser adopt a new revision.
2. **A test brief port pairing was wrong**, and the isolation engineer did not act on it: the operator's live GUI on 19387
   is the `desktop` host (PID 46308), while the `web` profile (PID 21088) listens on 3080. Acting on the brief would have
   mis-identified which process was protected.

Both are recorded because a recovery round that silently "fixes" its own premises is indistinguishable from one that
guesses.

### 8. Real-machine acceptance: NOT OBSERVED — blocked on a missing provider credential

**The real-machine tests were not performed, and no result is claimed for them.** The isolated host ran, served the plugin
and accepted a real turn; the turn failed before any model output, and the reason is a credential gap in the disposable
profile rather than a plugin behaviour:

```text
This turn failed
llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY
through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY
in the launching environment
MISSING_CREDENTIAL
```

Read-only diagnosis, so the report is precise about what is missing:

- `DEEPSEEK_API_KEY` is **not** set in this shell's environment;
- it is **not** set in the live working instance's own environment either (PID 21088 and the isolated PID carry the same
  variable names, and no credential-shaped variable is among them) — so the operator's instances must be obtaining
  provider credentials by some other path this round did not replicate;
- the shared store `C:\Users\20659\.dsh\.credentials.yaml` exists and holds `COMMAND_GOAT_API_KEY`, `CPA_API_KEY` and
  `COMMANDCODE_API_KEY` — **no `DEEPSEEK_API_KEY`**.

§18 states that a shared global credential store may be **read** by DSH if that is normal DSH architecture, but that this
task must not modify credentials. Writing a provider key into `.credentials.yaml`, exporting one for the launch, or
copying the protected profile's provider configuration are all credential modifications or protected-profile reads, so
none was attempted. The trial is therefore reported exactly as §22 instructs a failed trial to be reported — as an
environment failure — with the difference that this one is **systemic rather than transient**, so there was no successful
trial to fall back to. Escalating rather than working around it is the behaviour the safety contract asks for.

**What that costs the phase.** The two browser-observed acceptance items — §22 (a real turn whose first model output is a
tool call, with the pill leaving 首响应计时 at the boundary) and §23 (a real long reasoning/output/tool turn with a winning
peak whose provenance shows ≥3 samples and ≥100 ms) — remain **unverified on a real machine**. Their logic is covered
deterministically instead: `test/ttft-boundary.test.js` and `test/phase94-regressions.test.js` drive the same store,
controller and view-model entry points the browser drives, and every one of those assertions was proven to fail on the
released v0.1.2 (§4). That is a real but partial substitute, and the distinction is kept visible here rather than folded
into a claim of end-to-end verification.

**Consequence for this round's status.** The phase is reported **BLOCKED** on real-machine acceptance, not PASS. All
automated gates pass and the two defects are repaired and baseline-proven; the browser half of §22/§23 is outstanding.

### 9. Gates at the change set being committed

```text
npm run build:client            client.js rebuilt (554095 bytes, mirrored to lib/client.js)
npm run verify                  structure OK (14 required files, 16 core modules, 69 test files,
                                client bundle fresh, lib/client.js mirrored)
                                tests 804 · pass 804 · fail 0 · skipped 0 · todo 0
node scripts/verify-sanitization.mjs
                                PASS — no personal content, all structural evidence preserved
git diff --check                clean
```

The released baseline was 768 tests, 768 pass. The count is now **804 pass, 0 fail, 0 skipped, 0 todo** — 36 more tests
across `test/rate-publication.test.js`, `test/curve-rate-publication.test.js`, `test/ttft-boundary.test.js` and
`test/phase94-regressions.test.js`, plus the §9 shape table added to `ttft-boundary` and the repaired expectations in the
four pre-existing curve suites. No test was skipped, todo'd or deleted to reach that state, and no gate was satisfied by
widening a tolerance.

`package.json` is unchanged at version `0.1.2` with peer `@deepseek-ai/dsh` `0.2.0-rc.2`. Nothing was published, no
version was bumped, staged or tagged, and no `v0.1.3` tag or GitHub Release was created: this round prepares the fix and
stops, exactly as §29 requires.

## Phase 9.4.1 — Isolated runtime acceptance closure (2026-10-01)

Baseline `f6d6c46bfd4466ff593769be2db2a95ec2afaf78` (`HEAD == origin/main`, divergence `0 0`, working tree clean), runtime
`dsh 0.2.0-rc.2`, package version `0.1.2`, peer `@deepseek-ai/dsh` `0.2.0-rc.2`. Phase 9.4's implementation is accepted as
the starting point and was **not** redesigned: the TTFT boundary handling, `tokenEvidence()`, `firstTokenObserved()`, the
shared rate-publication policy, `MIN_RATE_SAMPLES = 3`, `MIN_RATE_ELAPSED_MS = 100`, the phase-local completed-curve
ladder, the null/unavailable curve vertices and the peak provenance are all untouched. This round closed one view-model
semantic gap and obtained the real-machine evidence Phase 9.4 was blocked on. The previous round's provider/API failure was
out of scope and was neither diagnosed nor repaired.

### 1. The view-model hygiene fix (pre-runtime, no visual change)

`src/client/completed/curve-view-model.js` projected a non-finite `curve.peakTps` onto `0` before publishing it, so
`peak.value === 0` meant either *"the publication policy withheld every vertex"* or *"the published series has a maximum of
zero"*. The two are different facts about a turn, and the first was asserting the second.

The fix is two lines and one seam:

```js
const peakValue = Number.isFinite(curve.peakTps) ? Math.max(0, curve.peakTps) : null   // published reading
const axisPeak = peakValue ?? 0                                                        // geometry only
const axisMax = niceCeiling(axisPeak)
```

and the peak marker's guard became `peakValue !== null && leaderSeries.peak !== null && Math.abs(…) < 1e-9`, so the `null`
cannot be coerced in a subtraction — that coercion *is* the "null arithmetic flowing into axis calculations" the brief
forbids. `peak.display` is still keyed on `axisPeak > 0`, i.e. byte-identical to the old expression for every input, so
an unavailable peak still prints `—` and a zero peak still prints `—`: the distinction lives in the field, not in the
pixels.

Two existing assertions were updated (`test/curve-rate-publication.test.js`, `test/phase94-regressions.test.js` §16, both
of which encoded `view.peak.value === 0`), and one new test was added — `§16b`, which renders one settled turn through
`curveTree` twice with only `curve.peakTps` moved between `null` and `0` and asserts `assert.deepEqual` on the two element
trees. That is the no-visual-change proof rather than a claim about it. The new test also asserts `view.peak.value === null`,
`display === DASH`, `peak.x === null`, `peak.y === null`, a finite positive `axis.max`, and that no surviving marker is
relabelled `isPeak`.

The change is visible on the real machine and was measured there: the tool-first turn below publishes `peakTps: null`, and
the expanded card renders `峰值 —`, `axis-max 1`, no `dsh-tpm-peak-dot`, and `aria-label "吞吐曲线 · 峰值 — tokens/s"`.
Before this round that same card carried `峰值 —` too (the display never changed) but the view model's `peak.value` was
`0`, which is exactly the conflation the fix removes.

### 2. Terminal terminology (unchanged from the brief)

The **external DSH 0.2.0 wire/stream contract is UNCHANGED**. What Phase 9.4 extended is the **internal normalized adapter
output**, which now carries durable `firstTokenMs` evidence. That extension was kept, and it is not a DSH contract
migration.

### 3. Isolated environment — source-verified, never a protected profile

Read-only inventory at task start:

| Item | Measured |
| --- | --- |
| `3080` | **PID 21088**, `node …/dsh/lib/bin.js web --no-open`, profile `web` |
| `19387` | **PID 46308**, `DeepSeek Harness.exe … profiles\desktop`, profile `desktop` (the operator's live GUI) |
| operator Chrome | PID 43176 — never attached to, never navigated |

Both instances, both profiles and both ports were the protected set. The only interaction permitted with them was
read-only process and directory discovery.

The disposable profile was created with
`dsh tpm-phase941-runtime --from-default-profile web --dump-config`, the same source-verified mechanism the previous round
used: `initializeProfileFromDefault` (`dsh-app-boot/lib/index.js`) copies only the **shipped template's bundle list** and
never reads `profiles\web`, and `mkdirSync` throws `EEXIST` so an existing profile can never be merged. Nothing was copied
from any protected profile.

```text
profile name : tpm-phase941-runtime
profile path : C:\Users\20659\.dsh\profiles\tpm-phase941-runtime
identity     : dsh-profile-tpm-phase941-runtime
port         : 19388   (bind-tested free; not in the protected port list)
PID          : 4440    (node; the only DSH process this round started or stopped)
cwd          : E:\Projects\DSHarness\_phase941-runtime\workspace   (a fresh, empty workspace)
plugin form  : dsh plugin --profile tpm-phase941-runtime add E:\Projects\DSHarness\dsh-turn-performance-meter
               → link:E:/Projects/DSHarness/dsh-turn-performance-meter, bundles auto-extended, exit 0, pnpm 11.7.0
exemptions   : dsh plugin --profile tpm-phase941-runtime version-exemptions → {}   (no compatibility exemption)
```

The plugin's presence was proved from the isolated profile's own output rather than inferred: the served page's
`__DSH_BOOT__` carries
`{"id":"dsh-turn-performance-meter","url":"plugins/??dsh-turn-performance-meter/client.js&rev=e1ebfde3d92d","inject":["@deepseek-ai/dsh-api-session-controller","@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-conversation"],"immediately":true}`,
and the served bundle is the repository `client.js` (556795 bytes) plus the module server's 83-byte trailer (556878 bytes).
Browser automation (a throwaway `--headless=new` Chrome with its own `--user-data-dir`, driven over CDP) was asserted
against `port === 19388` **before** any navigation, and never touched 3080 or 19387.

### 4. Provider route — PATH A, no credential written, none read

The shipped `web` template defaults `agent-default-model` to `provider: deepseek-official`, which is exactly the route
that failed last round with `MISSING_CREDENTIAL`. Rather than debug it, the disposable profile's own `cordis.patch.yml`
was pointed at an **already-authorized, already-working route**:

```yaml
- id: agent-default-model
  config: { provider: command-goat, model: deepseek/deepseek-v4.1-flash, reasoningEffort: max }
- id: llm-pi-ai
  config: { providers: { command-goat: { apiKeyEnv: COMMAND_GOAT_API_KEY, api: openai-completions,
                                          baseURL: https://api.commandcode.ai/provider/v1, models: […] } } }
```

`apiKeyEnv` is a **reference**, not a secret: `resolveApiKey` (`dsh-llm-pi-ai/lib/index.js:2557-2563`) resolves it through
the shared credentials service. The shared store `C:\Users\20659\.dsh\.credentials.yaml` was **read from, never written
to**; no credential value was read, printed, logged, exported or copied, and none was persisted to the repository, the
docs, the profile or any log. The route name is recorded here and the secret is not. The durable request header confirms
the route the agent actually ran on: `{"provider":"command-goat","model":"deepseek/deepseek-v4.1-flash","reasoningEffort":"max"}`.

### 5. General runtime acceptance — PASS

One ordinary reasoning/output turn (`session-241feef2-…`), sampled through the DOM and read back through the plugin's own
documented diagnostic switch (`localStorage['dsh-turn-performance-meter.debug'] = '1'`, which publishes
`window.__dshTurnPerformanceMeter`).

| Step | Observed |
| --- | --- |
| idle | `0` `[class*="dsh-tpm"]` nodes — no meter |
| generation starts | live pill at `t+219 ms`: `首响应计时 0.15 s` |
| TTFT freeze | `t+10245 ms` the pill leaves `首响应计时` and becomes `思考 ≈67.0 tokens/s`, `elapsed 10.1 s` |
| phases | `思考` (reasoning) then `输出` (output), each with a live `≈` TPS |
| settlement | `t+16377 ms` → collapsed card `已完成 · 思考 ≈109 tokens/s · 输出 ≈318 tokens/s · 838 tokens · 首响应 10.03 s` |
| expand | four cells: `思考 TPS ≈109` (`5.3s · ≈580`), `输出 TPS ≈318` (`0.8s · ≈258`), `生成 Tokens 838` (`总用时 16.2s`), `首响应 10.03` (`已完成`); footer `模型调用 1 · 已完成` |
| curve | `viewBox "0 0 100 48"`, `preserveAspectRatio none`, `aria-hidden true`, 2 paths (reasoning + output), legend `思考 / 输出`, `峰值 ≈318 tokens/s`, axis max `500`, peak dot on the 318 vertex |
| reload | card progress string **identical** before and after `Page.reload`: `已完成 · 思考 ≈109 tokens/s · 输出 ≈318 tokens/s · 838 tokens · 首响应 10.03 s` |
| console | **zero** console errors, warnings or uncaught exceptions across the whole run |

### 6. Bug A — TTFT boundary: the exact wire shape WAS observed

Five successful turns were run; the tool-first prompt was
`严格要求：不要输出任何开场白…你的第一个动作必须是一次工具调用——用 read 工具读取 sample-note.txt`, and the wire
was captured from the DSH client's own WebSocket (`/api/remote.mux`) rather than inferred from the UI.

Three of the four tool-first trials (`session-b384721e-…`, and turns 1 and 3 of `session-082e3be0-…`) produced the ideal
shape as the **first chunk a token-delta rule accepts**:

```text
idx 0  block-start      blockType=tool-call                      ← not token evidence
idx 1  tool-call-delta  name=read  argumentsDelta=""             ← FIRST token evidence
idx 2  tool-call-delta  name=read  argumentsDelta="{"            ← argument mass starts here
```

`chunks strictly before it: 1` — the `block-start`. There is no reasoning delta and no text delta ahead of it. The freeze
instant matches the boundary to within sampling resolution: the boundary's wire time is `1790845602051`, the prompt was
sent at `1790845597670` (4381 ms), and the settled `ttftMs` is **4376 ms**. The UI left `首响应计时` at the same instant
and entered the tool stage (`等待模型`), the tool ran (`tools.names ["read"]`, `completedCount 1`, `workMs 10`, footer
`工具 1 · 0.0s · 模型调用 2`), the follow-up attempt produced the file's second line, and the next turn worked.

**No TPS token mass was fabricated.** The name-only delta carries `argumentsDelta: ""`, contributes no text, and the curve
publishes nothing from it: this turn's `curve.peakTps` is `null`, `peakProvenance` is `null`, and every vertex is withheld
with a named reason (`opening-anchor`, `below-elapsed-horizon`). The rendered curve therefore has `0` paths, `峰值 —`,
axis max `1`, and no peak dot — a chart that claims nothing.

Two honest notes on this turn. First, the fourth tool-first trial (`session-082e3be0` turn 2) was **reasoning-first**: its
TTFT froze at 13.746 s on a reasoning delta, so the exact name-only boundary was not its *first* token evidence; it is
counted as an early-tool turn, not as a boundary observation. Second, the class of the exact boundary is additionally
covered deterministically by `test/phase94-regressions.test.js` §9 A/B and `test/ttft-boundary.test.js`, which were proven
red on released v0.1.2.

One observation is recorded without action because it is out of this round's scope: for the 16 ms output phase of
`session-b384721e` the **summary** cell printed `输出 ≈3,500 tokens/s` (56 tokens over a 16 ms phase) while the
**published curve peak** was correctly unavailable (`峰值 —`). The summary rate is the phase average and the peak is the
gated series maximum; that is the pre-existing v0.1.2 arithmetic, which this round was required not to change, and it is
not a §12 escalation because no peak was published at all.

### 7. Bug B — real peak provenance from a substantial turn

`session-41819f3d-…`: a three-step task (glob → read → ~600-character written answer), `3,644` generated tokens, tools
`["glob","read"]`, three model attempts, 33.5 s.

| Quantity | Measured |
| --- | --- |
| reasoning TPS | `130.93` |
| output TPS | `189.69` |
| generated tokens | `3,644` |
| TTFT | `2,686 ms` (`2.69 s` rendered) |
| peak TPS | `453`  (card `峰值 ≈453 tokens/s`, axis max `500`) |

Debug peak provenance, read from the settled snapshot:

| Field | Value |
| --- | --- |
| `attemptId` | `session-41819f3d-…:3` |
| `phase` | `reasoning` |
| `episodeStartMs` | `0` |
| `pointTimeMs` | `439` |
| `elapsedMs` | **`100`**  (≥ 100 ✔) |
| `episodeSampleCount` | **`15`**  (≥ 3 ✔) |
| `episodeMass` | `45.254…` |
| `tps` | `453` |
| `sampleQuality` | `calibrated` |
| `temporalAllocationMode` | `total-anchored` |
| `contributingSampleTimes` | `[0,0,0,1,1,1,1,1,1,2,2,23,23,23,24]` (15 entries, matching the count) |

The winning vertex is the episode's **first publishable** vertex — at `elapsed 100 ms`, not at the withheld opening anchor,
which sits at `localMs 0 / elapsed 0 / tps null / reason opening-anchor`. No geometric opening anchor won, no hard clamp
was introduced anywhere in the estimator, and `renderBudget` reports `allocated 209 / lineVertices 203 / markers 1 /
elementPoints 204 / degradedRuns 0 / peakRetained true`.

**§12 high-peak escalation did not trigger.** `peak / max(phase average)` is `1.00` and `2.39` on the two graded turns,
`0.92` on the replication trial and undefined on the turn with no published peak. The highest is `2.39 ×`, far below the
`10 ×` threshold, so no escalation inspection was required and none was invented.

### 8. The original failure classes are gone — invariant scan

Every published and withheld vertex of every settled turn on the isolated host was scanned:

```text
TOTAL published vertices : 264
TOTAL withheld vertices  : 11
§13 VIOLATIONS           : 0
```

No published vertex used `elapsed < 100 ms` or `episodeSampleCount < 3`; every withheld vertex carried a named
`rateUnavailableReason` (`opening-anchor`, `below-elapsed-horizon`), none was published as a fabricated `0`. On the Bug A
side no successful turn remained at `首响应计时` after a token boundary had been delivered — the pill left it at the
boundary in every trial, including the `2,686 ms` and `12,538 ms` ones.

### 9. Protected environment — containment, measured and attributed

Read-only post-check after all testing:

| Claim | Measurement |
| --- | --- |
| same protected profiles exist | `profiles\web`, `profiles\desktop` both present |
| test ports never used | 3080 and 19387 were never a test target; only 19388 and the throwaway CDP port 9223 were |
| not restarted | PID 21088 still owns 3080, PID 46308 still owns 19387 — same processes, same ports, throughout |
| plugin installation did not touch them | the only profile whose `package.json` gained the link is `tpm-phase941-runtime`; `profiles\web` shows **0 files written after task start** |
| no sessions created inside them | the operator's repo workspace bucket `--E-…-dsh-turn-performance-meter--` gained **0** sessions |

One thing is reported rather than glossed. `profiles\desktop` shows **8 files written after task start**, and they are
**not** this task's:

- `.plugin-manager\logs\operation-wwJOyE\pnpm.log` (02:10:12) and `operation-eIzAnO\pnpm.log` (02:10:53) record two
  attempts to install **`dsh-mail-notify@0.4.0`**, both rejected — `incompatible with dsh 0.2.0-rc.2`, followed by
  `dsh: restored package.json, pnpm-lock.yaml, and node_modules`, i.e. both rolled back; and
- `cordis.patch.yml` (02:12:24) was rewritten with `web-ui-pet`, `permission` and `subagent` rows that are absent from the
  copy read at 01:50 — GUI-settings rows for the operator's own Desktop app.

Every profile-scoped command this task issued named `--profile tpm-phase941-runtime`; none named `web` or `desktop`, and
neither an unrelated plugin install nor a settings-sync rewrite can be produced by any command recorded above. The
containment claim is therefore exact: **no write to a protected profile was performed by this task**, `profiles\web` was
measured untouched, and the operator's own live instance was independently writing to `profiles\desktop` on its own.

A second, smaller shared-state artifact is recorded: one blank session, `session-b78871ec-…`, was created in the shared
`--E-…-dsh-mail-notify--` workspace bucket at 01:48, because the web client's composer still pointed at the previously
selected workspace before its chip was moved to the isolated one. It is not inside a protected profile and it is left in
place, because §15 authorises removal only of the disposable profile.

### 10. Cleanup

The isolated host (PID `4440`) and the throwaway headless Chrome (PID `42468`, verified by its
`--user-data-dir=…\_phase941-runtime\chrome-profile`) were stopped and nothing else; the operator's Chrome (PID 43176) and
both DSH instances were left running, and no broad process-kill command was issued at any point. The disposable profile
was removed only after `Resolve-Path` and its `package.json` identity (`dsh-profile-tpm-phase941-runtime`) were verified
against the literal path `C:\Users\20659\.dsh\profiles\tpm-phase941-runtime` — no wildcard, no computed path. The retained
`tpm-phase94-isolated` profile was independently confirmed **not running** and left untouched, which §15 permits.

### 11. Gates at the change set being committed

```text
npm run build:client             client.js rebuilt (556795 bytes, mirrored to lib/client.js)
npm run verify                   structure OK; tests 805 · pass 805 · fail 0 · skipped 0 · todo 0
node scripts/verify-sanitization.mjs   PASS — no personal content, all structural evidence preserved
git diff --check                 clean
```

The baseline was 804 pass; this round adds one test (§16b) and updates two assertions, with no test skipped, todo'd or
deleted and no tolerance widened. `package.json` remains version `0.1.2` with peer `@deepseek-ai/dsh` `0.2.0-rc.2`; nothing
was published, versioned, tagged or released.

## Phase 9.4.2 — Boundary-only TTFT evidence / TPS episode-origin parity closure (2026-10-01)

Phase 9.4.1's real-machine acceptance stands for everything it observed (Bug A's exact name-bearing empty-arguments
boundary freezing TTFT and leaving `首响应计时`; Bug B's publication gates; `peak.value === null` for an unavailable peak).
Neither of those repairs was redesigned. This round closes one source-level defect found by independent review after
9.4.1: a **boundary-only** first-token event started the live TPS episode clock, so the live pill and the completed curve
used different denominator origins for the same phase episode.

### 1. Starting state (verified before any write)

```text
git fetch origin; git status --short    (clean)
HEAD             6506bd0cc8f9ef348eb7cf6418db60d5ad98f6dc
origin/main      6506bd0cc8f9ef348eb7cf6418db60d5ad98f6dc
divergence       0       0
```

### 2. The defect, measured before the fix (not quoted from the audit)

A scratch probe (`dev/scratch/phase942-probe.mjs`, git-ignored) drove the phase brief's fixture through the real
store/live/curve path — `TurnTelemetryStore.beginTurn/beginAttempt/acceptChunk` → `liveSnapshot` → `settleAttempt/
endTurn` → `settled.curve` — with turn start `t = 0`, a name-bearing empty-arguments `tool-call-delta` at `t = 100`, and
three 100-token output samples at `t = 200 / 250 / 300`. Measured on `6506bd0`:

| observation | baseline `6506bd0` | after the fix |
| --- | --- | --- |
| live episode origin (`LiveMeter.episodeStartMs`) | `100` (the boundary) | `200` (the first sample) |
| live episode elapsed at `t = 300` | `200` | `100` |
| live mass / sample count | `300` / `3` | `300` / `3` |
| **live TPS at `t = 300`** | **`1500`** | **`3000`** |
| completed episode origin (curve, absolute) | `200` | `200` |
| completed elapsed / mass / count | `100` / `300` / `3` | `100` / `300` / `3` |
| **completed TPS at the `t = 300` vertex** | **`3000`** | **`3000`** |
| `curve.peakTps` | `3000` | `3000` |

The live episode's `/1000` quotient was correct arithmetic over the wrong interval: the boundary at `100` is a TTFT
instant the completed curve never sees, because the curve opens an episode at its first sample.

### 3. Root cause

`LiveMeter.observeTokenBoundary` — the method Phase 9.4 added for the one chunk shape that is a first token while
carrying no magnitude — established the episode *and its clock*:

```js
if (nextPhase !== null && (nextPhase !== this.streamingPhase || this.episodeStartMs === null)) {
  this.streamingPhase = nextPhase
  this.episodeStartMs = timeMs                 // <- a boundary instant became a denominator origin
  this.episodeTokenMass = 0
  this.episodeSampleCount = 0
  this.episodeUsageBaseline = this.usageBaselineFor(nextPhase)   // <- and the numerator's origin with it
}
```

Two invariants broke at once. The live denominator origin became an instant the completed estimator cannot represent
(`compressAttempts` gives an attempt's local zero to its first generated sample; `cumulativePhaseTpsSeries` opens each
episode at `filtered[startIndex].activeTimeMs`), and `episodeUsageBaseline` was captured at that same boundary instant,
so the provider-counter numerator — `counter - baseline` — measured an interval the denominator did not describe. The
TTFT boundary, the magnitude sample and the TPS episode origin are three facts, and the method collapsed them into one.

### 4. The change

One method, and only its episode handling (`src/core/live-metrics.js`). `acceptSample` remains the **only** writer of
`episodeStartMs`, `episodeTokenMass`, `episodeSampleCount` and `episodeUsageBaseline`:

```js
if (nextPhase !== null && nextPhase !== this.streamingPhase) {
  this.streamingPhase = nextPhase     // the phase identity is established immediately
  this.episodeStartMs = null          // no TPS episode clock is started
  this.episodeTokenMass = 0
  this.episodeSampleCount = 0
  this.episodeUsageBaseline = null    // and no counter baseline is attached to a boundary
}
```

- `acceptSample` already opened an episode when `episodeStartMs === null`, so a phase announced by a boundary is now
  *backed* by the first magnitude sample that arrives: origin = that sample's instant, mass = its weight, count = 1,
  baseline = `usageBaselineFor(phase)` evaluated at that instant.
- The `|| this.episodeStartMs === null` half of `acceptSample`'s open condition is what carries the new state, which is
  why it was left exactly as it was and merely re-documented.
- A **same-phase** boundary inside an already magnitude-open episode now changes nothing at all (the condition is a pure
  phase comparison), which is the required behaviour: an origin, a numerator and a sample count established by real
  samples are not reset by boundary evidence.

Behavioural consequences of the new state, all asserted:

| state | before | after |
| --- | --- | --- |
| boundary-only, before any magnitude | `episodeStartMs = boundary`, `episodeElapsedMs` advanced, `episodeSampleCount 0` | `episodeStartMs = null`, `episodeElapsedMs = null`, `episodeSampleCount 0` |
| `snapshot.tps` in that state | `null` (gated) | `null` (no episode at all) |
| `snapshot.rateGateReason` in that state | `no-episode` | `null` — no episode exists to gate |
| first-output guard in that state | could fire from the boundary instant | cannot fire: there is no episode to stand in for |
| phase identity | immediate | immediate (unchanged) |
| TTFT | frozen at the boundary | frozen at the boundary (unchanged) |

### 5. Provider-counter baseline semantics after the fix (§4 of the brief)

The baseline is now taken where the denominator origin is, and the three audited orderings resolve as follows.

- **A. No usage known at the boundary, usage before the first magnitude sample.** The first magnitude sample opens the
  episode and takes that usage as its baseline. `test/boundary-episode-origin.test.js` CASE E1 drives exactly this
  (`outputTotal 600` known before the sample, `630` after) and asserts `episodeUsageBaseline === {phase:'output',
  counter:600}`, `episodeMass() === {mass:30, source:'provider-counter'}` and `tps === 300` over the episode's own
  100 ms. On `6506bd0` the same fixture could not take a baseline at all (the boundary had already opened the episode
  with none, and `observeUsage` deliberately never explains an episode retroactively) and read `1667` from shape mass.
- **B. Usage already known before the boundary.** The pre-boundary snapshot is *not* the baseline; the snapshot known at
  the magnitude origin is. CASE E2 runs output → reasoning → boundary → output with counters known throughout: the
  boundary's `outputTotal 600` is not used, the episode that opens at 400 ms takes `660`, and the published rate is
  `10 counter tokens / 100 ms = 100`. On `6506bd0` the boundary took `600` and the numerator then spanned `[320, 500]`
  as `70` tokens, publishing `389` over an interval the curve never measures.
- **C. Usage becomes known between the boundary and the first magnitude sample.** The counter used at the real episode
  start is the latest snapshot observed **at or before** that instant — in E1, `600`. The reason is stated rather than
  assumed: counters are cumulative and only ever replaced by a newer chunk, so the value held when the episode opens was
  never observed after the origin; the later snapshot is a *newer* observation and using it as the baseline would make
  the numerator start after the denominator; and no value is interpolated to the origin, because that would fabricate an
  observation the provider never made. This is the same policy `acceptSample` has always applied to any episode that
  opens while counters are known — it is now applied at the episode's real origin instead of at a boundary.
- **Unchanged:** a usage chunk arriving *inside* an open episode still never explains it retroactively (CASE E3), and a
  contradicted split still falls back to shape mass (§8.3.1).

### 6. Phase transitions, the first-output guard, attempts

- **Phase transition.** A boundary-only event that is a genuine phase change updates the identity immediately, discards
  the previous phase's episode rather than bridging it, and starts no new clock. CASE C asserts the reasoning episode's
  `300 tokens / 100 ms` is not carried into the output episode (which reads `3000`, not `6000`).
- **First-output guard, audited because it depends on `episodeStartMs`.** `publishedRate` requires
  `episodeStartMs !== null`, so with no episode open the guard cannot fire: the reasoning rate is **not** extended across
  a phase that has produced nothing, which is what §3 of the brief requires (`publishable rate = null`). The guard is
  preserved, anchored at the output episode's own origin: CASE C2 asserts it applies 950 ms after the first output
  magnitude sample and is gone one millisecond past `FIRST_OUTPUT_GUARD_MS`. The window moved with the episode rather
  than with the boundary, which is the only reading consistent with "the first second of a fresh output episode".
- **Attempt boundaries.** Unchanged and re-proved: `attemptStarted` clears the episode, the numerator, the sample count,
  the provider baseline and the guard, while turn TTFT stays frozen (CASE F). A boundary in the *new* attempt opens no
  clock either.
- **Tool and turn boundaries.** Unchanged (`clearEpisode` already emptied all four fields).

### 7. The completed curve required no change

The curve was not touched, because the source already has the right origin: `compressAttempts` sets an attempt's local
zero to its first generated sample (`src/core/time-axis.js`), and `cumulativePhaseTpsSeries` opens each maximal same-phase
run at `filtered[startIndex].activeTimeMs` (`src/core/curve.js`). A boundary-only delta produces no sample at all
(`sampleFromChunk` → `null`, `attempt.samples` untouched), so it never reached the curve. The defect was one-sided and it
is repaired on the one side that had it. After the fix the live measurement at `t = 300` and the completed vertex at
`t = 300` were confirmed to carry the same episode facts — origin `200`, elapsed `100`, count `3`, mass `300`,
TPS `3000` — with the curve's published peak unchanged at `3000`.

### 8. Regression matrix and its baseline proof

`test/boundary-episode-origin.test.js` (12 tests) drives the host/store/live/curve path and the real controller. It was
executed against a read-only `git worktree` checked out at `6506bd0` (created and removed for this measurement; the
working tree was never reset, stashed or checked out) before the fix was written:

```text
baseline 6506bd0 : tests 12 · pass 4 · fail 8
fixed tree       : tests 12 · pass 12 · fail 0
```

The eight baseline failures are CASE A, B, C, C2, E1, E2, F and the controller-level A/C test. The four that pass on
both trees are **controls**, deliberately labelled in the file: CASE D (a same-phase boundary must not reset an active
episode), CASE E3 (an episode that opened with no counters keeps its shape mass), CASE G (`MIN_RATE_SAMPLES = 3`,
`MIN_RATE_ELAPSED_MS = 100`, and the §16 CASE 6 `299 ms` fixture still peaking at `2000`, not `500 000`) and CASE H
(`curve.peakTps` `null` ⇒ `peak.value` `null` ⇒ `峰值 —`). They are not counted as coverage of this defect.

### 9. Documentation

`docs/METRICS_SPEC.md` §4 now states the two origins as an explicit pair and states that a boundary-only delta
establishes the former and the phase identity while establishing neither the magnitude nor the episode origin; §6 defines
the episode clock as the first magnitude sample and bounds the first-output guard to that clock; §6.1 makes the
provider-counter baseline part of the same invariant; §8.2 names the shared origin and the fixture that proves parity.
`docs/TEST_PLAN.md` §13 carries the matrix and the baseline result, `docs/TASKS.md` carries the phase closeout, and
`docs/DIRECTORY_TREE.md` lists the new test file. Historical Phase 9.4 / 9.4.1 evidence was not rewritten.

### 10. Gates at the change set being committed

```text
npm run build:client             client.js rebuilt (558994 bytes, mirrored to lib/client.js)
npm run verify                   structure OK; tests 817 · pass 817 · fail 0 · skipped 0 · todo 0
node scripts/verify-sanitization.mjs   PASS — no personal content, all structural evidence preserved
git diff --check                 clean
client.js == lib/client.js       byte-identical
```

The suite stood at 805 tests before this round and stands at 817 after it; no test was skipped, todo'd or deleted and no
tolerance was widened. `package.json` remains version `0.1.2` with peer `@deepseek-ai/dsh` `0.2.0-rc.2`. **No
real-machine run happened in this phase** by design: no DSH profile was started, stopped, attached to or installed into,
the retained `tpm-phase94-isolated` profile was not touched, and no browser/runtime acceptance was repeated. Nothing was
published, versioned, tagged or released.
