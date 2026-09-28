# dsh-turn-performance-meter

A turn-level performance meter for DeepSeek Harness (DSH) agent workflows. It is designed for turns that may contain
multiple model invocations, tool calls, retries, shell commands, file writes/edits, and a final answer. The plugin
provides two UI modes: a compact live meter during execution and a completed turn card that aggregates the whole turn.

面向 DeepSeek Harness（DSH）Agent 工作流的 turn 级性能统计插件。它适用于一个 turn 内存在多次模型调用、工具调用、
重试、shell 命令、文件写入/编辑以及最终回答的场景。插件包含两种 UI：执行过程中的紧凑实时统计，以及 turn 完成后的统计
卡片。完成态卡片按整个 turn 聚合。

> **Released as `v0.1.0` on GitHub, for DSH `0.1.7-rc.2`.** Version `0.1.0`, `private: true`. Distribution is the GitHub
> Release asset `dsh-turn-performance-meter-0.1.0.tgz` plus the local checkout; the package is **not** published to npm.
> Phases 0–8 are complete and the `v0.1.0` tag points at the release commit on `main`.
>
> **已发布 GitHub `v0.1.0`，面向 DSH `0.1.7-rc.2`。** 版本 `0.1.0`，`private: true`。分发方式为 GitHub Release 资产
> `dsh-turn-performance-meter-0.1.0.tgz` 与本地检出目录；本包**未**发布到 npm。Phase 0–8 全部完成，`v0.1.0` tag 指向
> `main` 上的发布 commit。

## 1. What it does / 功能

The statistical boundary is the whole **turn**, not a single model step. During generation the meter shows the current
attempt's trailing one-second TPS with an `≈` marker; when no model decode is running it shows the stopwatch of
whatever is running instead (tool execution, inter-step wait, retry backoff) and never a stale rate. When the turn
settles, the same seat switches to a static completed card carrying turn-level Reasoning TPS, Output TPS, Generated
Tokens, TTFT, a tool summary and the model-call count; hovering the card or focusing it with the keyboard replaces the
two TPS columns with the throughput curve.

统计边界是整个 **turn**，而不是单个模型 step。生成期间实时组件显示当前活动 attempt 最近 1 秒的 TPS，并始终带 `≈`
近似标记；非模型解码阶段（工具执行、步骤间隙、重试退避）显示正在进行的那个阶段各自的计时器，绝不显示过期的速率。
turn 结束后，同一位置切换为静态完成态卡片，承载 turn 级的思考 TPS、输出 TPS、生成 Tokens、首响应、工具摘要与模型调用
次数；鼠标悬停或用键盘聚焦时，前两个 TPS 栏位被吞吐曲线替换。

The meter occupies `conversation.input.dock` at `order: -10`, above the composer card; the native chat statistics keep
their own seat (`conversation.composer.dock`) below it. Both views are projections of settled or live evidence — the
React layer never re-derives a metric.

插件挂载在 `conversation.input.dock`、`order: -10`，位于输入框卡片上方；原生聊天统计保留其在输入框下方的原位置。
两个视图都只是既有证据的投影，React 层不重新计算任何指标。

## 2. Support status / 支持状态

```text
Version:           0.1.0
Supported/tested:  DSH 0.1.7-rc.2
Distribution:      GitHub Release + local checkout; package private
npm:               not published
Verification:      local automated suite + real DSH browser smoke
```

The only DSH version this project claims is **`0.1.7-rc.2`**, whose public reference commit is
`477b4f420553e8a52c2fbccc464d7561b239c443`. The claim is bounded on purpose: it is not `0.1.7+`, not `0.1.x` and not
"the latest DSH", because no other version has been exercised. Local evidence for the claim is the CLI
(`dsh --version`), the installed package (`npm list -g @deepseek-ai/dsh`) and the composed profile tree, all recorded in
`docs/IMPLEMENTATION_LOG.md`.

本项目唯一声明支持的 DSH 版本是 **`0.1.7-rc.2`**，其公开参考 commit 为
`477b4f420553e8a52c2fbccc464d7561b239c443`。该声明有意限定范围：不写 `0.1.7+`、不写 `0.1.x`、也不写"最新 DSH"，
因为其他版本均未被实际验证。本机证据来自 CLI（`dsh --version`）、已安装包（`npm list -g @deepseek-ai/dsh`）与
组合后的 profile 树，均记录在 `docs/IMPLEMENTATION_LOG.md`。

Phase 7D migrated the adapter, the client feed and the completion path to that version: tool results are identified
through the first-class tool-role message (`message.toolCallId`, `message.isError`), the bare `settleAssistant(attemptId)`
is resolved from held evidence instead of being read as an abandonment, a `turn/end` is terminal even when no record is
open, and the session log format is v4. The field-by-field contract record is `docs/DSH_API_NOTES.md` §13.

Phase 7D 将 adapter、client feed 与完成态路径迁移到该版本：工具结果经一等公民的 tool-role message 识别
（`message.toolCallId`、`message.isError`）；裸 `settleAssistant(attemptId)` 依据已持有的证据判定，而不再一律读作
abandonment；`turn/end` 即使没有已打开的 record 也具终止性；会话日志格式为 v4。逐字段契约记录见
`docs/DSH_API_NOTES.md` §13。

The eight captures under `fixtures/dsh-turns/` were recorded against `0.1.5`. They remain evidence for the metric
arithmetic, the decoder and historical compatibility, and they are **not** evidence for the tool/result shape, the
settle-assistant semantics, the turn completion lifecycle or the client event-window behaviour, nor are they a supported
runtime contract. No `package.json` compatibility-range field is declared, because DSH's plugin peer/preflight mechanism
was not verified as a supported gating schema for this project.

`fixtures/dsh-turns/` 下的八段录制采集自 `0.1.5`。它们仍是指标算术、解码器与历史兼容性的证据，但**不是** tool/result
形状、settle-assistant 语义、turn 完成生命周期或客户端事件窗口行为的证据，也不构成受支持的运行时契约。本项目不声明
`package.json` 兼容范围字段，因为 DSH 的 plugin peer/preflight 机制未被验证为本项目可用的门控 schema。

## 3. Install / 安装

There are two installation paths. Use the release asset for a fixed `v0.1.0`; use the checkout only while developing the
plugin itself.

安装方式有两种。固定使用 `v0.1.0` 时采用 Release 资产；仅在开发插件本身时使用检出目录。

### 3.1 Stable release / 稳定发行版

Download `dsh-turn-performance-meter-0.1.0.tgz` from the
[v0.1.0 release](https://github.com/HaowenCang/dsh-turn-performance-meter/releases/tag/v0.1.0), then install it:

从 [v0.1.0 release](https://github.com/HaowenCang/dsh-turn-performance-meter/releases/tag/v0.1.0) 下载
`dsh-turn-performance-meter-0.1.0.tgz` 后安装：

```powershell
dsh plugin --profile web add "file:C:/path/to/dsh-turn-performance-meter-0.1.0.tgz"
```

This is the recommended immutable `v0.1.0` installation. `file:` on a tarball is a frozen artifact, which is the point:
the installed bytes cannot drift from the published release, and the release carries a `.sha256` sidecar for verifying
the download before installation.

这是推荐的固定 `v0.1.0` 安装方式。对 tarball 使用 `file:` 得到的是一份冻结产物，这正是目的所在：安装的字节不会相对
已发布 release 漂移，且该 release 附带 `.sha256` sidecar，可在安装前校验下载内容。

Verify the download before installing:

安装前校验下载内容：

```powershell
Get-FileHash .\dsh-turn-performance-meter-0.1.0.tgz -Algorithm SHA256
Get-Content .\dsh-turn-performance-meter-0.1.0.tgz.sha256
```

### 3.2 Development checkout / 开发检出

```powershell
dsh plugin --profile web add "link:C:/path/to/dsh-turn-performance-meter"
```

`link:` tracks the working checkout and is intended for development. `link:` is the form this project documents for
development, and the reason is measured rather than stylistic. pnpm installs a `link:` spec as a **symlink to the
checkout**, so a later `npm run build:client` is picked up by the profile without reinstalling, whereas the `file:` spec
of §3.1 installs a **frozen copy**. `link:` is therefore not the distribution form: it follows whatever the checkout
contains, including uncommitted work, so it cannot represent an immutable `v0.1.0` installation.

`link:` 跟踪工作检出目录，仅用于开发。本项目在开发场景下记录 `link:` 形式，其理由来自实测而非风格偏好。pnpm 把
`link:` 安装为**指向检出目录的符号链接**，因此之后执行 `npm run build:client` 时 profile 会直接读到新字节，无需重装；
而 §3.1 的 `file:` 安装的是一份**冻结副本**。因此 `link:` 不是分发形式：它跟随检出目录的当前内容（包含未提交的改动），
无法代表一份不可变的 `v0.1.0` 安装。

Either command initializes the profile on first use and adds the package to `dsh.profile.bundles` automatically, because
this package declares `dsh.bundle.patch`.

两种命令都会在首次使用时初始化 profile，并因为本包声明了 `dsh.bundle.patch` 而自动把包名加入 `dsh.profile.bundles`。

The reference checkout used for this project's recorded evidence is
`E:\Projects\DSHarness\dsh-turn-performance-meter`; substitute any absolute path. Reload the page after installing, or
restart the profile when the loader entry has to be re-read.

本项目的录制证据来自参考检出目录 `E:\Projects\DSHarness\dsh-turn-performance-meter`；实际使用时替换为任意绝对路径。
安装后刷新页面；若需要重新读取 loader 条目，则重启该 profile。

The Plugins UI in the web client can add an absolute local directory as well. Do not modify DSH core source files for this
project: installation requires no patch to DSH, to any `node_modules` file, or to the shipped package.

Web 客户端中的插件 UI 同样可以添加绝对本地目录。本项目不需要修改 DSH 核心源码：安装过程不修改 DSH、不修改任何
`node_modules` 文件，也不修改已安装的包。

## 4. Usage / 使用

Nothing is configured per session. The meter attaches to whichever session the client is displaying and detaches on
teardown.

无需按会话配置。实时组件挂载到客户端当前显示的会话，并在销毁时解除。

Diagnostics are off by default. Setting the browser local-storage key below to `1` and reloading enables lifecycle logs
(`console.debug`) and a read-only handle — session attach, turn open/close, attempt and tool boundaries, quality
downgrades, rebaselines. It is a diagnostic aid only, it is not required for normal use, and per-delta logging never
happens in either mode.

诊断默认关闭。将下列浏览器 local-storage 项设为 `1` 并刷新，可启用生命周期日志（`console.debug`）与只读句柄 ——
包括会话挂载、turn 开关、attempt 与工具边界、质量降级、rebaseline。它仅是诊断辅助，正常使用不需要，且两种模式下都
不会记录逐 delta 日志。

```js
localStorage.setItem('dsh-turn-performance-meter.debug', '1')
// window.__dshTurnPerformanceMeter.{controller,diagnostics,attachedSessions,meter}
```

The same switch is the only way to reach the cadence override `dsh-turn-performance-meter.refreshMs`, which exists so
that the presentation cadence could be A/B measured in a browser. While the diagnostic switch is off the production
cadence has exactly one source (`src/client/live/cadence.js`) and no persisted value can change it.

同一开关也是触达刷新节奏覆盖项 `dsh-turn-performance-meter.refreshMs` 的唯一途径；该项的存在是为了在浏览器中实测
刷新节奏的 A/B。诊断开关关闭时，生产刷新节奏只有一个来源（`src/client/live/cadence.js`），任何持久化值都无法改变它。

## 5. Metric semantics / 指标口径

These definitions are frozen. Per-step TPS values must never be arithmetically averaged; rates are always a ratio of
sums over the turn.

以下口径已冻结。禁止对各 step 的 TPS 做算术平均；速率始终是 turn 级"和之比"。

| Field | Definition | Secondary line |
|---|---|---|
| Reasoning TPS / 思考 TPS | `sum(reasoning tokens) / sum(reasoning generation time)` across the turn | reasoning duration · reasoning tokens |
| Output TPS / 输出 TPS | `sum(non-reasoning output tokens) / sum(output generation time)` across the turn | output duration · output tokens |
| Generated Tokens / 生成 Tokens | sum of provider `outputTokens` for contributing attempts | total turn elapsed time |
| TTFT / 首响应 | turn start → first non-empty reasoning/text/tool-call delta | turn status |

A footer line, not a fifth column, carries the tool summary (`tools 4 · 12.8s`, using the wall union) and the attempt
count. A turn with no tool call hides the tool item entirely.

卡片底部（而不是第五个栏位）承载工具摘要（`工具 4 · 12.8s`，使用 wall union）与模型调用次数；无工具调用的 turn 直接
隐藏该项。

The live meter displays the **current trailing 1-second window of the active attempt**, always with `≈`, and never a
curve. The window resets at a new model invocation after a tool call or at a retry boundary, so unrelated calls are never
mixed; a measurement window never crosses an attempt boundary.

实时组件显示**当前活动 attempt 最近 1 秒的滑动窗口**，始终带 `≈`，且不显示曲线。窗口在工具返回后的新模型调用或新的
尝试边界处重置，禁止混合两个独立模型调用的数据；测量窗口绝不跨 attempt 边界。

Model-generated ordinary text and model-generated tool-call arguments count as model output. PowerShell commands, shell
scripts, write-file payloads and edit patches therefore belong to output accounting. Tool results such as stdout, file
contents returned by a tool, or API responses do **not** count as model output; they may become input to a later model
call. `reasoningTokens` is already included in `outputTokens`, so the non-reasoning share is
`outputTokens - reasoningTokens` and the two are never added together.

模型生成的普通文本与 tool-call arguments 均属于模型输出，因此 PowerShell 命令、shell 脚本、写文件正文与编辑 patch
都计入输出统计。工具自身返回的 stdout、文件读取结果、API 结果等**不**计入模型输出；它们如果随后送入模型，则属于下一次
模型调用的输入。`reasoningTokens` 已包含在 `outputTokens` 中，非思考部分为
`outputTokens - reasoningTokens`，两者绝不相加。

Tool latency is tracked on two axes: `toolWorkMs` is the sum of all completed call durations, `toolWallMs` is the union
of tool intervals and therefore does not double-count parallel tools. The compact UI displays `toolWallMs`; the summed
work stays in the view model for detail/debug surfaces.

工具耗时按两个轴统计：`toolWorkMs` 是所有已完成工具调用时长之和；`toolWallMs` 是工具执行区间的并集，因此不会对并行
工具重复计时。紧凑 UI 显示 `toolWallMs`；求和值保留在 view model 中供详细/调试界面使用。

### 5.1 Measurement fidelity / 测量精度

DSH stream deltas carry text/tool-argument fragments and timestamps, while authoritative provider token usage is
normally reported as aggregate usage rather than an exact token count attached to every delta. The implementation
therefore exposes metric quality instead of pretending every live/curve point is exact. Quality is tracked on three
independent axes, because one label cannot describe a whole curve: `tokenTotalQuality` (how well the **total** is
known; can reach `exact`), `phaseSplitQuality` (how well that total divides into reasoning vs non-reasoning; can reach
`exact`, and only when the provider reports `reasoningTokens`), and `temporalShapeQuality` (how well the **timing** is
known; its ceiling is `reconstructed`).

DSH 流式 delta 提供文本/工具参数片段及时间戳，而权威 provider token usage 通常是聚合值，并非每个 delta 都携带精确
token 数。因此实现显式记录指标质量，不把所有实时值和曲线点伪装成精确数据。质量在三个独立轴上记录，因为单一标签无法描述
整条曲线：token 总数质量（最高可达 `exact`）、reasoning/output 拆分质量（仅在 provider 报告 `reasoningTokens` 时可达
`exact`）、时间形状质量（上限为 `reconstructed`）。

Levels per axis: `exact` · `calibrated` · `reconstructed` · `partial` · `estimated` · `unavailable`. Only `exact`
suppresses the `≈` marker; `unavailable` renders `—` and is never coerced to zero.

每一轴的等级为 `exact` · `calibrated` · `reconstructed` · `partial` · `estimated` · `unavailable`。仅 `exact` 免除
`≈` 标记；`unavailable` 显示 `—`，绝不静默归零。

### 5.2 Curve / 曲线

The curve is one **attempt-local trailing-one-second total throughput trace per model attempt**: a vertex at
attempt-local `t` sums every generated sample of that attempt inside `(t - 1000, t]`, whatever its phase — exactly what
the live pill measures. The compressed x-axis joins attempts so tools and inter-attempt waits consume **zero width**, but
the measurement window never crosses an attempt boundary, and a model silence *inside* a call retains full width as a
decay to zero. Reasoning and output are **colours** of that one measurement — the trace is cut into phase-coloured runs
whose seams are shared vertices — not two rate definitions. Same-timestamp samples are ordered by `sampleOrder`; no
synthetic one-second decay tail is appended; an off-grid last real point is retained; the total render budget is 512
points and the global peak is preserved. The curve's magnitudes are the provider-calibrated per-delta allocation whenever
authoritative usage exists, so the drawn curve and the printed token total are one magnitude system, and
`attemptBreakdown[].calibration.samples` stays the authoritative magnitude source once a turn has settled.

曲线是**每个 model attempt 各一条 attempt 局部、1 秒滑动窗口的总吞吐轨迹**：局部时刻 `t` 的取值汇总该 attempt 在
`(t - 1000, t]` 内的全部生成样本（不区分 phase），与实时指示器口径完全一致。压缩横轴把各 attempt 首尾相接，因此工具
时间与 attempt 间等待占用**零宽度**，但测量窗口绝不跨 attempt 边界；attempt **内部**的模型静默按完整宽度绘出，表现为
衰减到零。reasoning 与 output 是同一次测量的两种**颜色**（轨迹按 phase 切分为若干子路径，接缝共享同一顶点），而不是
两套速率定义。同一时间戳的样本按 `sampleOrder` 排序；不追加合成的 1 秒衰减尾；保留网格外的最后一个真实点；总渲染预算
512 点并保留全局峰值。当存在权威 usage 时，曲线量级采用 provider 校准后的逐 delta 分配，因此曲线与卡片打印的 token
总数属于同一量级体系；turn settle 之后，`attemptBreakdown[].calibration.samples` 始终是量级的权威来源。

The complete contract is `docs/METRICS_SPEC.md` §11, with the durable/transient evidence rules in §13 and the
architecture in `docs/ARCHITECTURE.md`.

完整口径见 `docs/METRICS_SPEC.md` §11，durable/transient 两类证据的规则见 §13，架构见 `docs/ARCHITECTURE.md`。

## 6. Known limitations / 已知限制

**Live TPS is approximate.** DSH deltas do not carry an exact per-token count, so live TPS is a heuristic delta
weighting and is always marked `≈`. It is not an exact measurement and must not be read as one.

**实时 TPS 是近似的。** DSH 的 delta 不携带逐 token 精确计数，因此实时 TPS 属于启发式 delta 加权，且始终标 `≈`。
它不是精确测量，不应被当作精确测量读取。

**Completed token totals depend on provider usage.** When the provider reports `outputTokens` and `reasoningTokens`, the
corresponding totals and the phase split can reach `exact`. When it does not, the phase split is estimated or
reconstructed and the card marks it `≈`.

**完成态 token 总量取决于 provider usage。** 当 provider 报告 `outputTokens` 与 `reasoningTokens` 时，相应总量与
phase 拆分可达 `exact`；未报告时，phase 拆分被估计或重建，卡片以 `≈` 标记。

**The temporal curve is never exact per-token timing.** DSH supplies delta timestamps but no authoritative token count
per delta, so the temporal-shape quality ceiling is `reconstructed` and no curve vertex can be exact.

**时间曲线永远不是精确的逐 token 计时。** DSH 提供 delta 时间戳，但不提供每个 delta 的权威 token 数，因此时间形状质量
的上限是 `reconstructed`，任何曲线顶点都不可能 exact。

**A missing `turn/start` leaves TTFT and elapsed unavailable.** In terminal-tail reconstruction the record is rebuilt
from the durable evidence the published window still holds. When that window never contained the turn's start boundary,
`startMs` stays `null` and therefore TTFT and turn elapsed report `—`; only `firstTokenMs` may still be known from a
durable sample. The plugin does not always recover TTFT, and does not invent a start boundary.

**缺少 `turn/start` 时 TTFT 与耗时为不可用。** 终末 tail 重建会从发布窗口仍持有的 durable 证据复原 record。若该窗口
从未包含该 turn 的起始边界，则 `startMs` 保持 `null`，TTFT 与 turn elapsed 显示 `—`；仅 `firstTokenMs` 可能仍能由
durable 样本得知。插件并非总能恢复 TTFT，也不会编造 start 边界。

**Retained durable evidence is bounded.** The window-generation reconstruction budget is
`MAX_RETAINED_TURNS = 32`, evicted least-recently-updated, and it holds evidence **bytes** only — durable identity is
generation-wide and survives eviction. This is a memory bound on reconstruction, not a statement that only 32 turns are
supported.

**保留的 durable 证据是有界的。** 窗口代际重建预算为 `MAX_RETAINED_TURNS = 32`，按最久未更新淘汰，且只保存证据
**字节** —— durable 身份是全代际的，淘汰不会遗忘。这是重建过程的内存上界，不代表"只支持 32 个 turn"。

**Fixture evidence is bounded.** The `0.1.7` real recorded corpus currently contains two files,
`fixtures/dsh-0.1.7/index.json` and `fixtures/dsh-0.1.7/t01-sequential-tools.json`. The `settle-assistant`
retirement/abandonment contract is covered by a synthetic contract test against the ported fold algebra, not by a
host-recorded `0.1.7` fixture.

**Fixture 证据是有界的。** `0.1.7` 的真实录制语料目前只有两个文件：`fixtures/dsh-0.1.7/index.json` 与
`fixtures/dsh-0.1.7/t01-sequential-tools.json`。`settle-assistant` 的 retirement/abandonment 契约由针对移植后 fold
代数的合成契约测试覆盖，而非由 host 录制的 `0.1.7` fixture 覆盖。

**Browser evidence is bounded.** The Phase 7D.1 terminal-tail case — `turn/start` already slid out of the window when
`turn/end` arrives — was not constructed directly in a browser. It is established by real recorded durable bytes, a real
feed/controller replay, and the DSH bounded-window contract. It is not a browser reproduction.

**浏览器证据是有界的。** Phase 7D.1 的终末 tail 场景（`turn/end` 到达时 `turn/start` 已滑出窗口）并未在浏览器中直接
构造。它由真实录制的 durable 字节、真实的 feed/controller 回放，以及 DSH 有界窗口契约共同确立，不属于浏览器复现。

**Verification is local.** This repository has no GitHub CI runner, so every `npm run verify` result quoted anywhere in
this repository is a local test result, not CI. The implementation log keeps the full evidence.

**验证是本地进行的。** 本仓库没有 GitHub CI runner，因此本仓库中引用的所有 `npm run verify` 结果都是本地测试结果，
而非 CI 结果。完整证据保留在 implementation log 中。

## 7. Repository map / 项目结构

```text
dsh-turn-performance-meter/
├─ README.md
├─ CHANGELOG.md                      Release history (0.1.0)
├─ LICENSE                           MIT
├─ package.json                      version 0.1.0, private, scripts: test / build:client / verify
├─ cordis.patch.yml                  Bundle row insertion; the only DSH composition this plugin adds
├─ index.js                          host entry (no-op by design; telemetry is client-side)
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
│  └─ assets/                        four reference-layout screenshots
├─ fixtures/            recorded DSH turn evidence (offline; no DSH required)
│  ├─ README.md
│  ├─ index.json
│  ├─ dsh-0.1.7/        the rc.2 corpus: index.json + t01-sequential-tools.json
│  ├─ dsh-turns/        eight real recorded turns (0.1.5), durable + transient planes verbatim
│  └─ derived/          four declared synthetic mutations of those recordings
├─ src/
│  ├─ core/             pure metric engine — zero @deepseek-ai/* imports (16 modules)
│  ├─ dsh/              DSH rc.2 raw evidence -> normalized events (+ client-feed)
│  ├─ host/             TurnTelemetryStore (session+turn keyed)
│  └─ client/           main.js entry + presentation
│     ├─ live/          state machine, presenter, scheduler, controller, MeterRoot,
│     │                 React pill, locale, CSS
│     └─ completed/     completed-card view tree + React binding + card CSS
├─ test/                63 test files + helpers/ (core / dsh / live / completed / bundle)
└─ scripts/             verify-structure, bundle-client, build-client,
                        sanitize-fixtures, verify-sanitization

dev/                    dev-only tooling, not part of the bundle
├─ fixture-recorder/    injected host recorder: session/event + agent/assistant-stream
├─ capture-scenario.ps1 live scenario driver (launch / interrupt)
├─ harvest-fixtures.mjs raw recording -> fixtures/dsh-turns/*
├─ mutate-fixtures.mjs  deterministic synthetic derivatives with provenance
├─ measure-generation-tail.mjs
├─ inspect-recording.mjs
└─ recordings/          launch receipts + captured model catalog
```

`dev/screenshots/` and `fixtures/raw/` are git-ignored local evidence directories: the first holds browser captures, the
second the pre-sanitization fixture originals. Neither is part of the repository or the installed bundle.

`dev/screenshots/` 与 `fixtures/raw/` 是 git 忽略的本地证据目录：前者存放浏览器截图，后者存放脱敏前的 fixture 原件。
两者都不属于仓库内容，也不属于安装后的 bundle。

The pure metric engine and the DSH adapter both have tests that run without a DSH process; the recorded fixtures make the
adapter layer verifiable offline.

纯指标引擎与 DSH adapter 层都有无需 DSH 进程即可运行的测试；已录制的 fixture 使 adapter 层可以离线验证。

## 8. Development and verification / 开发与验证

The project uses Node's built-in test runner; no test dependency, bundler or network access is required. After editing
`src/client/**`, rebuild **before** verifying — `scripts/verify-structure.mjs` fails on a bundle that is stale relative
to `src/`, so `npm run verify` on unbuilt client sources is expected to fail:

本项目使用 Node 内置测试运行器；不需要测试依赖、打包器或网络访问。修改 `src/client/**` 之后应**先构建再验证**——
`scripts/verify-structure.mjs` 会在 bundle 相对 `src/` 过期时失败，因此对未构建的 client 源码直接运行 `npm run verify`
预期会失败：

```powershell
npm run build:client     # rewrites client.js and mirrors the same bytes to lib/client.js
npm run verify           # structure check + full test suite
node scripts/verify-sanitization.mjs
```

`npm run verify` runs `node scripts/verify-structure.mjs && node --test test/*.test.js`. The structure check asserts that
the required files exist, that every `src/core` module has a matching test, that every local import under `src/` resolves,
that `client.js` is fresh relative to `src/`, and that `lib/client.js` is byte-identical to `client.js`. `npm test` runs
the test suite alone.

`npm run verify` 执行 `node scripts/verify-structure.mjs && node --test test/*.test.js`。结构检查断言：必需文件存在、
每个 `src/core` 模块都有对应测试、`src/` 下每个本地 import 均可解析、`client.js` 相对 `src/` 是新的、且
`lib/client.js` 与 `client.js` 逐字节相同。仅运行测试套件使用 `npm test`。

Do not add a frontend React dependency solely for the DSH client module; DSH supplies React through its browser module
table. Because a DSH client bundle is a single classic script whose factory `require` resolves only module-table words,
`scripts/bundle-client.mjs` deterministically bundles the `src/client/main.js` graph into `client.js` (verified by
`test/client-bundle.test.js`; no bundler dependency is installed).

不要仅为 DSH Client 模块而安装额外 React 副本；DSH 会通过浏览器模块表提供 React。由于 DSH 客户端 bundle 是单个
classic script（factory 的 `require` 只解析模块表词汇），`scripts/bundle-client.mjs` 将 `src/client/main.js` 依赖图
确定性地打包进 `client.js`（由 `test/client-bundle.test.js` 验证，不引入任何打包器依赖）。

To capture new DSH evidence (only needed when recording new fixtures, in a DSH host with `dsh-super-injector`):

如需重新采集证据（仅在抓取新 fixture 时需要，且须在装有 `dsh-super-injector` 的 DSH host 内）：

```powershell
dsh --version
# inject dev/fixture-recorder, then:
powershell -File dev/capture-scenario.ps1 -Name A1
node dev/harvest-fixtures.mjs
node dev/mutate-fixtures.mjs --write
node dev/measure-generation-tail.mjs
```

See `fixtures/README.md` for the fixture shape and `dev/fixture-recorder/README.md` for the recorder. The recorder is
dev-only and never part of the plugin bundle.

fixture 结构见 `fixtures/README.md`，录制器见 `dev/fixture-recorder/README.md`。录制器仅供开发使用，不属于插件 bundle。

The executable task list and acceptance gates are in `docs/TASKS.md`; the implementation log with per-phase evidence is
in `docs/IMPLEMENTATION_LOG.md`; the prompt that starts DeepSeek V4.1 Flash is in `docs/START_PROMPT.md`.

可执行任务列表与验收门槛见 `docs/TASKS.md`；逐阶段证据见 `docs/IMPLEMENTATION_LOG.md`；启动 DeepSeek V4.1 Flash 的
提示词见 `docs/START_PROMPT.md`。

## 9. License / 许可证

This project is licensed under the MIT License. See [LICENSE](./LICENSE).

本项目采用 MIT 许可证，详见 [LICENSE](./LICENSE)。
