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
- Release:

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
   the browser receives but before the client fold. The two forms are asserted equivalent; the browser transport itself
   is unverified until Phase 7.
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
    `renderBudget.elementPoints` = path vertices + markers (§"Phase 7A.1" below).

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
contract plus the measured uniform gap rather than by direct observation.

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

### 3. Verification for this round

`npm run build:client` rebuilt `client.js` and `lib/client.js` (372 739 bytes each, identical SHA-256) and
`npm run verify` reports **538 tests, 538 pass, 0 fail** — the 535 of `331968d` plus three added here. Browser
evidence, including the layout/measurement JSON and the screenshots, is kept under `dev/screenshots/phase7b/`, which
is gitignored.
