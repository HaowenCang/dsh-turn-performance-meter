# dsh-turn-performance-meter

A turn-level performance meter for DeepSeek Harness (DSH) agent workflows. It is designed for turns that may contain multiple model invocations, tool calls, retries, shell commands, file writes/edits, and a final answer. The project provides two UI modes: a compact live meter during execution and a completed turn card that aggregates the whole turn.

面向 DeepSeek Harness（DSH）Agent 工作流的 turn 级性能统计插件。它适用于一个 turn 内存在多次模型调用、工具调用、重试、shell 命令、文件写入/编辑以及最终回答的场景。插件包含两种 UI：执行过程中的紧凑实时统计，以及 turn 完成后的统计卡片。完成态卡片按整个 turn 聚合。

> Status: Phase 4 complete. The turn-level engine, the DSH adapter with both semantic preflight audits, the production
> Live Client integration and the **completed turn summary card** are in place. The live meter and the completed card
> run inside the real DSH web client against `ctx.sessions.binding().eventSource`, verified by 317 offline tests and a
> live browser session run. The completed card is a static settled view: it aggregates the whole turn (all model
> attempts, all tool calls) and never re-derives metrics in React. The mandatory hover/focus **TPS curve is Phase 5**
> and is deliberately absent.
>
> 状态：Phase 4 已完成。指标口径、DSH adapter（含两项前置语义审计）、生产级实时 Client 集成与**完成态统计卡片**均已落地：
> 实时组件与完成态卡片都在真实 DSH Web 客户端中基于 `ctx.sessions.binding().eventSource` 运行，由 317 个离线测试与真实
> 浏览器会话运行共同验证。完成态卡片是静态的 settled 视图：它聚合整个 turn（全部模型 attempt、全部工具调用），且 React 层
> 不重新计算任何指标。必选的悬停/聚焦 **TPS 曲线属于 Phase 5**，当前刻意不实现。

## 1. Frozen product requirements / 已冻结需求

The statistical boundary is a **turn**, not a single model step. One user turn can contain `LLM -> tool -> LLM -> tool -> ... -> final answer`, and the completed metrics aggregate the entire turn. Per-step TPS values must never be arithmetically averaged.

统计边界是整个 **turn**，而不是单个模型 step。一个用户 turn 可以经历 `LLM -> tool -> LLM -> tool -> ... -> final answer`；完成态指标聚合整个 turn，禁止对各 step 的 TPS 做算术平均。

During model generation, the live meter displays the **current trailing 1-second TPS window** of the active attempt, always with the approximate marker `≈`. It does not display a curve. The rolling window resets when a new model invocation begins after a tool call or retry boundary, so unrelated calls are never mixed. States where no model decode is running (tools, inter-step gaps, retry backoff) show their own stopwatches instead of any TPS value.

模型生成期间，实时组件显示**当前活动 attempt 最近 1 秒向后滑动窗口的 TPS**，且始终带 `≈` 近似标记，不显示曲线。工具返回后开始新的模型调用，或进入新的尝试边界时，窗口重置，禁止混合两个独立模型调用的数据。非模型解码阶段（工具执行、步骤间隙、重试退避）显示各自的计时器，不显示任何 TPS 数值。

After the turn settles, the same slot shows the completed card instead: turn-level averages over every model attempt and tool call in that turn, with the reasoning/output split marked `≈` whenever the provider did not report `reasoningTokens`. The card is static — no ticker, no curve, no hover behaviour. Tool execution time occupies **zero horizontal width** on the Phase 5 curve, whose x-axis is compressed model-generation time, because the curve is meant to diagnose model throughput stability rather than end-to-end latency.

turn 结束后，同一 slot 切换为完成态卡片：对该 turn 内全部模型 attempt 与工具调用做 turn 级平均；当 provider 未报告
`reasoningTokens` 时，reasoning/output 拆分标 `≈`。卡片是静态的——没有 ticker、没有曲线、没有悬停行为。Phase 5 曲线的横轴上，
工具执行时间占用**零宽度**；横轴采用压缩后的模型生成时间，因为曲线用于诊断模型吞吐率稳定性，而不是表现端到端时延。

Model-generated ordinary text and model-generated tool-call arguments count as model output. Therefore PowerShell commands, shell scripts, write-file payloads, edit patches/diffs, and other tool arguments belong to output accounting. Tool results such as stdout, file contents returned by a tool, or API responses do **not** count as model output; they may become input to a later model call.

模型生成的普通文本与模型生成的 tool-call arguments 均属于模型输出。因此 PowerShell 命令、shell 脚本、写文件正文、编辑 patch/diff 等工具参数都计入输出统计。工具自身返回的 stdout、文件读取结果、API 结果等**不**计入模型输出；它们如果随后送入模型，则属于下一次模型调用的输入。

## 2. Main metrics / 主指标

Completed summary keeps four principal columns to preserve the reference layout:

完成态摘要保留四个主要栏位，以维持参考界面的视觉结构：

| Field | Definition | Secondary line |
|---|---|---|
| Reasoning TPS / 思考 TPS | `sum(reasoning tokens) / sum(reasoning generation time)` across the turn | reasoning duration · reasoning tokens |
| Output TPS / 输出 TPS | `sum(non-reasoning output tokens) / sum(output generation time)` across the turn | output duration · output tokens |
| Generated Tokens / 生成 Tokens | sum of provider `outputTokens` for contributing attempts | total turn elapsed time |
| TTFT / 首响应 | turn start → first non-empty reasoning/text/tool-call delta | turn status |

A footer line, not a fifth column, carries the tool summary (`tools 4 · 12.8s`, using the wall union) and the attempt
count. A turn with no tool call hides the tool item entirely.

卡片底部（而不是第五个栏位）承载工具摘要（`工具 4 · 12.8s`，使用 wall union）与模型调用次数；无工具调用的 turn 直接隐藏该
项。

Display follows metric quality, and only a genuinely measured value is printed bare:

- `exact` → `54770` / `1.44 s` / `345`;
- anything weaker → `≈54770` / `≈345`; a per-phase token count on the same derivation chain as an approximate rate
  carries `≈` too, so `≈345 tokens/s` and `≈37,498 tokens` always agree;
- `unavailable` → `—`, never `0`.

显示遵循指标质量，只有真正测量到的值才不带标记：

- `exact` → `54770` / `1.44 s` / `345`；
- 更弱的等级 → `≈54770` / `≈345`；与近似速率同一条推导链的 phase token 数同样带 `≈`，因此 `≈345 tokens/s` 与
  `≈37,498 tokens` 始终一致；
- `unavailable` → `—`，绝不为 `0`。

Tool latency is tracked independently. `toolWorkMs` is the sum of all completed call durations; `toolWallMs` is the union of tool intervals and therefore does not double-count parallel tools. The compact UI displays `toolWallMs`; the summed work stays in the view model for detail/debug surfaces.

工具耗时独立统计。`toolWorkMs` 是所有已完成工具调用时长之和；`toolWallMs` 是工具执行区间的并集，因此不会对并行工具重复计时。紧凑 UI 显示 `toolWallMs`；求和值保留在 view model 中供详细/调试界面使用。

## 3. Measurement fidelity / 测量精度

DSH stream deltas carry text/tool-argument fragments and timestamps, while authoritative provider token usage is normally reported as aggregate usage rather than an exact token count attached to every delta. Therefore the implementation must expose metric quality rather than pretending every live/curve point is exact.

DSH 流式 delta 提供文本/工具参数片段及时间戳，而权威 provider token usage 通常是聚合值，并非每个 delta 都携带精确 token 数。因此实现必须显式记录指标质量，不能把所有实时值和曲线点伪装成精确数据。

Quality is tracked on three independent axes, because one label cannot describe a whole curve:

- `tokenTotalQuality` — how well the **total** generated tokens are known; can reach `exact`;
- `phaseSplitQuality` — how well that total divides into reasoning vs non-reasoning output; can reach `exact`, and only when the provider reports `reasoningTokens`;
- `temporalShapeQuality` — how well the **timing** is known; its ceiling is `reconstructed`, because DSH attaches no token count to a delta, so no timing evidence can make a curve point exact.

质量在三个独立轴上记录，因为单一标签无法描述整条曲线：token 总数质量（最高可达 `exact`）、reasoning/output 拆分质量（仅在 provider 报告 `reasoningTokens` 时可达 `exact`）、时间形状质量（上限为 `reconstructed`——DSH 不为单个 delta 附带 token 数，因此曲线点永不为 exact）。

Levels per axis: `exact` · `calibrated` · `reconstructed` · `partial` · `estimated` · `unavailable`. Only `exact` suppresses the `≈` marker; `unavailable` renders `—` and is never coerced to zero.

每一轴的等级为 `exact` · `calibrated` · `reconstructed` · `partial` · `estimated` · `unavailable`。仅 `exact` 免除 `≈` 标记；`unavailable` 显示 `—`，绝不静默归零。

See `docs/METRICS_SPEC.md` §11 for the complete contract, and §13 for the durable/transient evidence rules.

完整口径见 `docs/METRICS_SPEC.md` §11；durable/transient 两类证据的规则见 §13。

## 4. Repository map / 项目结构

```text
dsh-turn-performance-meter/
├─ README.md
├─ package.json                      scripts: test / build:client / verify
├─ cordis.patch.yml
├─ index.js                          host entry (no-op by design)
├─ client.js                         GENERATED browser bundle (npm run build:client)
├─ lib/client.js                     same bytes; the layout the local injector validates
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ METRICS_SPEC.md
│  ├─ UI_SPEC.md
│  ├─ DSH_API_NOTES.md
│  ├─ TASKS.md
│  ├─ TEST_PLAN.md
│  ├─ DIRECTORY_TREE.md
│  ├─ START_PROMPT.md
│  ├─ IMPLEMENTATION_LOG.md
│  └─ assets/
├─ fixtures/            recorded DSH turn evidence (offline; no DSH required)
│  ├─ README.md
│  ├─ index.json
│  ├─ dsh-turns/        five real recorded turns, durable + transient planes verbatim
│  └─ derived/          four declared synthetic mutations of those recordings
├─ src/
│  ├─ core/             pure metric engine — zero @deepseek-ai/* imports
│  ├─ dsh/              DSH rc.2 raw evidence -> normalized events (+ client-feed)
│  ├─ host/             TurnTelemetryStore (session+turn keyed)
│  └─ client/           main.js entry + presentation
│     ├─ live/          state machine, presenter, scheduler, controller, MeterRoot,
│     │                 React pill, locale, CSS
│     └─ completed/     completed-card view tree + React binding + card CSS
├─ test/                31 test files (core / dsh / live / completed / bundle)
└─ scripts/             verify-structure, bundle-client, build-client

dev/                    dev-only tooling, not part of the bundle
├─ fixture-recorder/    injected host recorder: session/event + agent/assistant-stream
├─ capture-scenario.ps1 live scenario driver (launch / interrupt)
├─ harvest-fixtures.mjs raw recording -> fixtures/dsh-turns/*
├─ mutate-fixtures.mjs  deterministic synthetic derivatives with provenance
├─ measure-generation-tail.mjs
├─ inspect-recording.mjs
└─ screenshots/phase3/  live-meter screenshots from the real DSH web client
```

The pure metric engine and the DSH adapter both have tests that run without a DSH process; the recorded fixtures make the adapter layer verifiable offline.

纯指标引擎与 DSH adapter 层都有无需 DSH 进程即可运行的测试；已录制的 fixture 使 adapter 层可以离线验证。

## 5. Local development / 本地开发

Place the directory at:

```text
E:\Projects\DSHarness\dsh-turn-performance-meter
```

Run the dependency-free core verification first:

```powershell
cd E:\Projects\DSHarness\dsh-turn-performance-meter
npm run verify
npm run build:client   # after editing src/client/**; verify fails on a stale bundle
```

The project uses Node's built-in test runner for both the pure-metric layer and the DSH adapter layer. Do not add a frontend React dependency solely for the DSH client module; DSH supplies React through its browser module table. Because a DSH client bundle is a single classic script whose factory `require` resolves only module-table words, `scripts/bundle-client.mjs` deterministically bundles the `src/client/main.js` graph into `client.js` (verified by `test/client-bundle.test.js`; no bundler dependency is installed).

纯指标层与 DSH adapter 层都使用 Node 内置测试运行器。不要仅为了 DSH Client 模块而安装额外 React 副本；DSH 会通过浏览器模块表提供 React。由于 DSH 客户端 bundle 是单个 classic script（factory 的 `require` 只解析模块表词汇），`scripts/bundle-client.mjs` 将 `src/client/main.js` 依赖图确定性地打包进 `client.js`（由 `test/client-bundle.test.js` 验证，不引入任何打包器依赖）。

The tests need no DSH process, no network and no injection: the recorded turn fixtures under `fixtures/` carry both evidence planes verbatim, so the adapter layer is verifiable offline.

测试不需要 DSH 进程、网络或注入：`fixtures/` 下已录制的 turn fixture 逐字保留两类证据，因此 adapter 层可以离线验证。

To inspect the DSH evidence again (only needed when capturing new fixtures, in a DSH host with `dsh-super-injector`):

如需重新采集证据（仅在抓取新 fixture 时需要，且须在装有 `dsh-super-injector` 的 DSH host 内）：

```powershell
dsh --version
# inject dev/fixture-recorder, then:
powershell -File dev/capture-scenario.ps1 -Name A1
node dev/harvest-fixtures.mjs
node dev/mutate-fixtures.mjs --write
node dev/measure-generation-tail.mjs
```

See `fixtures/README.md` for the fixture shape and `dev/fixture-recorder/README.md` for the recorder. The recorder is dev-only and never part of the plugin bundle.

fixture 结构见 `fixtures/README.md`，录制器见 `dev/fixture-recorder/README.md`。录制器仅供开发使用，不属于插件 bundle。

## 6. Install the local bundle / 安装本地 bundle

Current DSH documentation accepts an absolute local bundle path through the plugin manager. After implementation and verification, the expected Windows form is:

当前 DSH 文档允许插件管理器使用绝对本地 bundle 路径。实现并验证完成后，Windows 预期形式为：

```powershell
dsh plugin --profile web add "file:E:/Projects/DSHarness/dsh-turn-performance-meter"
```

The Plugins UI can also add an absolute local directory. Verify the exact CLI behavior with the locally installed DSH before using profile-mutating commands. Do not modify DSH core source files for this project.

Plugins UI 同样可以添加绝对本地目录。在执行会修改 profile 的命令前，应以本机 DSH 的帮助信息和实际行为为准。该项目不应修改 DSH 核心源码。

The scaffold client is invisible by default. For the **bootstrap-only** slot-loading check, set the browser local-storage key below to `1`, reload once, and remove/ignore this debug mechanism after the real UI exists:

骨架 Client 默认不可见。仅在验证 slot 加载时，可将以下浏览器 local-storage 项设为 `1` 后刷新；正式 UI 完成后应删除或忽略这一调试机制：

```js
localStorage.setItem('dsh-turn-performance-meter.debugPlaceholder', '1')
```

Setting `dsh-turn-performance-meter.debug` to `1` instead enables the production diagnostics handle (lifecycle logs only, no per-delta logging):

将 `dsh-turn-performance-meter.debug` 设为 `1` 则启用生产诊断句柄（仅记录生命周期事件，不记录每个 delta）：

```js
localStorage.setItem('dsh-turn-performance-meter.debug', '1')
// window.__dshTurnPerformanceMeter.{controller,diagnostics,attachedSessions,meter}
```

## 7. Build order / 构建顺序

Do not start from visual polish. The order is: local API reconnaissance → telemetry normalization → pure metric tests → live rolling TPS → tool timing → completed turn aggregation → compressed timeline → calibrated curve → completed/hover UI → interruption/retry/error handling → browser/E2E verification. Phases 0–4 (reconnaissance, pure engine, DSH telemetry normalization, live client integration + live meter UI, completed turn summary card) are complete; Phase 5 (the mandatory completed TPS curve and its hover/focus alternate view) is next.

不要从视觉细节开始。顺序为：本机 API 勘察 → 遥测归一化 → 纯指标测试 → 实时滚动 TPS → 工具计时 → turn 完成态聚合 → 压缩时间轴 → 校准 TPS 曲线 → 完成态/悬停 UI → 中断/重试/错误处理 → 浏览器/E2E 验证。Phase 0–4（勘察、纯引擎、DSH 遥测归一化、实时 Client 集成 + 实时组件 UI、完成态统计卡片）已完成，下一步为 Phase 5（必选的完成态 TPS 曲线及其悬停/聚焦切换视图）。

The executable task list and acceptance gates are in `docs/TASKS.md`. The prompt to start DeepSeek V4.1 Flash is in `docs/START_PROMPT.md`.

可执行任务列表与验收门槛见 `docs/TASKS.md`；启动 DeepSeek V4.1 Flash 的提示词见 `docs/START_PROMPT.md`。
