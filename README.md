# dsh-turn-performance-meter

A turn-level performance meter for DeepSeek Harness (DSH) agent workflows. It is designed for turns that may contain
multiple model invocations, tool calls, retries, shell commands, file writes/edits, and a final answer. The plugin
provides two UI modes: a compact live meter during execution and a completed turn card that aggregates the whole turn.

面向 DeepSeek Harness（DSH）Agent 工作流的 turn 级性能统计插件。它适用于一个 turn 内存在多次模型调用、工具调用、
重试、shell 命令、文件写入/编辑以及最终回答的场景。插件包含两种 UI：执行过程中的紧凑实时统计，以及 turn 完成后的统计
卡片。完成态卡片按整个 turn 聚合。

> **Released as `v0.1.6` on npm and GitHub, for DSH `0.2.1-rc.2`.** Version `0.1.6`, published to the public npm
> registry. The primary distribution is the npm package `dsh-turn-performance-meter`; the GitHub Release asset
> `dsh-turn-performance-meter-0.1.6.tgz` is an offline fallback, and the local checkout is for development. §2.1 holds
> the release/runtime matrix.
>
> **`v0.1.5` remains published for DSH `0.2.0-rc.2`** and is not restamped. Phase 11.0 migrated the source to
> `0.2.1-rc.2` and Phase 11.0R closed the runtime acceptance, so **compatibility with `0.2.1-rc.2` is ACCEPTED**, and
> `v0.1.6` is the first release for that runtime. It changes no TPS, TTFT, estimator, curve, rendering or lifecycle
> algorithm.
>
> **Working tree (unreleased, branch `compat/dsh-021-rc3`): DSH `0.2.1-rc.3` only.** Phase 13.0 moved the exact peer
> to `0.2.1-rc.3` and re-audited every consumed declaration; no production source changed and the bundle is
> byte-identical to the accepted `v0.1.6` build. Compatibility is **ACCEPTED pending independent source audit** (source
> audit 0 breaking interfaces; isolated real-browser matrix boot + R1–R9 = 123/123 checks PASS). The published `v0.1.6`
> artifact is **not** re-scoped: it remains bounded to `0.2.1-rc.2`, and no release occurred. See §2.1.
>
> **已发布 npm 与 GitHub `v0.1.6`，面向 DSH `0.2.1-rc.2`。** 版本 `0.1.6`，已发布到公开 npm registry。主要分发方式为
> npm 包 `dsh-turn-performance-meter`；GitHub Release 资产 `dsh-turn-performance-meter-0.1.6.tgz` 作为离线回退，本地检出
> 目录用于开发。发布与运行时对应关系见 §2.1。
>
> **`v0.1.5` 继续面向 DSH `0.2.0-rc.2` 发布**，不做改写。Phase 11.0 完成了源码迁移，Phase 11.0R 完成了运行时验收，
> 因此 **`0.2.1-rc.2` 兼容性为 ACCEPTED（已接受）**，`v0.1.6` 是该运行时的首个发布。本次发布不改变任何 TPS、TTFT、
> 估计器、曲线、渲染或生命周期算法。
>
> **工作树（未发布，分支 `compat/dsh-021-rc3`）：仅面向 DSH `0.2.1-rc.3`。** Phase 13.0 将精确 peer 迁移到
> `0.2.1-rc.3`，并重新审计了本插件读取的全部声明；生产源码未改动，bundle 与已验收的 `v0.1.6` 构建逐字节一致。
> 已发布的 `v0.1.6` 产物**不**被重新划定范围，仍限定于 `0.2.1-rc.2`。详见 §2.1。

## 1. What it does / 功能

The statistical boundary is the whole **turn**, not a single model step. During generation the meter shows the active
attempt's **phase-cumulative TPS** — the current phase episode's generated token mass over the wall time since that
episode began — with an `≈` marker, once the episode holds at least three samples; before that it shows the episode's
elapsed counter rather than an unstable rate. When no model decode is running it shows the stopwatch of
whatever is running instead (tool execution, inter-step wait, retry backoff) and never a stale rate. When the turn
settles, the same seat switches to a static completed card carrying turn-level Reasoning TPS, Output TPS, Generated
Tokens, TTFT, a tool summary and the model-call count; hovering the card or focusing it with the keyboard replaces the
two TPS columns with the throughput curve.

统计边界是整个 **turn**，而不是单个模型 step。生成期间实时组件显示当前活动 attempt 的**相位累计 TPS**（当前相位片段自起点以来
生成的 token 量除以该片段的墙钟时间），并始终带 `≈` 近似标记；该片段累计满 3 个样本之前，组件显示该片段的计时器而不是不稳定的速率。
非模型解码阶段（工具执行、步骤间隙、重试退避）显示正在进行的那个阶段各自的计时器，绝不显示过期的速率。
turn 结束后，同一位置切换为静态完成态卡片，承载 turn 级的思考 TPS、输出 TPS、生成 Tokens、首响应、工具摘要与模型调用
次数；鼠标悬停或用键盘聚焦时，前两个 TPS 栏位被吞吐曲线替换。

The meter occupies `conversation.input.dock` at `order: -10`, above the composer card; the native chat statistics keep
their own seat (`conversation.composer.dock`) below it. Both views are projections of settled or live evidence — the
React layer never re-derives a metric.

插件挂载在 `conversation.input.dock`、`order: -10`，位于输入框卡片上方；原生聊天统计保留其在输入框下方的原位置。
两个视图都只是既有证据的投影，React 层不重新计算任何指标。

## 2. Support status / 支持状态

```text
Version (working tree): 0.1.6
Development target:     DSH 0.2.1-rc.3 only (Phase 13.0, compatibility ACCEPTED pending independent source audit)
Compatibility status:   ACCEPTED — DSH 0.2.1-rc.3 (Phase 13.0 source audit + isolated real-browser matrix 123/123)
Released:               v0.1.6 -> DSH 0.2.1-rc.2
                        v0.1.5 -> DSH 0.2.0-rc.2
                        v0.1.4 -> DSH 0.2.0-rc.2
                        v0.1.3 -> DSH 0.2.0-rc.2
                        v0.1.2 -> DSH 0.2.0-rc.2
                        v0.1.1 -> DSH 0.1.7-rc.2
Primary distribution:   npm
Fallback distribution:  GitHub Release .tgz
Development:            link checkout
Verification:           local automated suite + real DSH browser smoke
```

### 2.1 Compatibility baseline / 兼容性基线

```text
plugin v0.1.1  ->  DSH 0.1.7-rc.2   reference commit 477b4f420553e8a52c2fbccc464d7561b239c443
plugin v0.1.2  ->  DSH 0.2.0-rc.2   reference commit 639ed015397290b3745d163aafe02ffee4aa3f84
plugin v0.1.3  ->  DSH 0.2.0-rc.2   reference commit 639ed015397290b3745d163aafe02ffee4aa3f84
plugin v0.1.4  ->  DSH 0.2.0-rc.2   reference commit 639ed015397290b3745d163aafe02ffee4aa3f84
plugin v0.1.5  ->  DSH 0.2.0-rc.2   reference commit 639ed015397290b3745d163aafe02ffee4aa3f84
plugin v0.1.6  ->  DSH 0.2.1-rc.2   reference commit 687f282e8625c6b8d11ff58211a90524be2e4317
plugin 0.1.6   ->  DSH 0.2.1-rc.3   reference commit 1f81c047fc48fa190a683e469daa699857e9afe8  (working tree, unreleased)
```

**`0.2.1-rc.2` is the normative runtime for `v0.1.6`.** Phase 11.0 moved the development target to it
and re-audited every DSH declaration this plugin reads — the session event envelope, the session-controller event window
and settlement contracts, the transient `agent/assistant-stream` / `assistant/live-chunk` plane,
`sessions.binding(sessionId)`, the `conversation.input.dock` slot contract, the compact `AssistantStreamRecord` decoder
with its usage fields and tool timing events, the Web client bundle loader and React slot lifecycle, and the
plugin-compatibility gate. The declarations the plugin consumes did not change in meaning: eight of the fourteen audited
declaration files are **byte-identical** between the two reference commits, and the six that changed are additive or
outside the consumed surface (provider-configuration metadata, experimental plugin records, new client slots, and
subagent/install plumbing this plugin does not read). No adapter code moved, no metric semantics moved, and no
compatibility exemption is involved. The comparison is recorded in `docs/DSH_API_NOTES.md` §15, and
`test/dsh-021-contract.test.js` re-pins the wire shapes against the 0.2.1 reference.

The one deployment-level change is the peer declaration itself: DSH 0.2.1-rc.2 refuses to install or load a plugin whose
declared `@deepseek-ai/dsh` peer does not satisfy the running runtime, so `package.json` now pins `0.2.1-rc.2` exactly.

The claim is bounded on purpose: it is not `0.2.1+`, not `0.2.x` and not "the latest DSH", because no other version has
been exercised. Local evidence for the claim is the isolated `0.2.1-rc.2` installation, the CLI version output, the
composed profile tree and the real-browser acceptance matrix, all recorded in `docs/IMPLEMENTATION_LOG.md`.

**Runtime acceptance: Phase 11.0 ended BLOCKED at R5; Phase 11.0R closed it, and compatibility with `0.2.1-rc.2` is now
ACCEPTED.** On the isolated `0.2.1-rc.2` host the plugin installed with the exact peer, booted into the served module
graph, and passed boot/dock acceptance plus R1–R4, R7 and R8 with real model output; R6's backgrounding behaviour was
observed across two real runs. Phase 11.0's single unresolved item was R5: no eligible continuity-connector boundary
occurred on the two natural tool turns it captured, so it recorded **BLOCKED — RUNTIME ACCEPTANCE** and deliberately did
not push the migration. That record stands as the historical state at the end of Phase 11.0.

Phase 11.0R re-tested R5 on a purpose-built genuine turn and observed the missing occurrence: **3 attempts, 2 tool
call/result cycles, 2 naturally eligible same-phase boundaries**, and **2 continuity connectors rendered in the real
DOM**, with the measured statistics preserved exactly (output TPS, peak, tokens, TTFT and the completed-card totals
unchanged). A read-only audit of the earlier R5 corpus also showed those two turns were correctly ineligible under the
frozen publication gate, not a connector defect. The two `pwsh` checkpoint commands in the real turn did **not** execute
— the host sandbox returned a pre-existing `SetNamedSecurityInfoW / Win32 5` ACL error — so no checkpoint output is
claimed; the genuine call/result cycles are what produced the two boundaries. The runtime observations are locally
reported evidence under `dev/phase11R/` (git-excluded, not pushed); the independent GitHub remote-source audit of the
compatibility commit is a separate, source-level verification and does not substitute for runtime rendering. Full
record: `docs/IMPLEMENTATION_LOG.md` Phase 11.0R. Verdict: **PASS — DSH 0.2.1-rc.2 COMPATIBILITY ACCEPTED.**

**运行时验收：Phase 11.0 在 R5 处以 BLOCKED 结束；Phase 11.0R 完成了后续验收，`0.2.1-rc.2` 兼容性现已 ACCEPTED。**
在隔离的 `0.2.1-rc.2` 主机上，插件以精确 peer 成功安装、进入服务端模块图，并通过 boot/dock 验收以及 R1–R4、R7、R8
（真实模型输出）；R6 的后台恢复行为已在两次真实运行中观察到。Phase 11.0 唯一未完成项是 R5：它捕获的两个自然工具
turn 未产生同相位相邻的合格边界，因此记录为 **BLOCKED — RUNTIME ACCEPTANCE**，并有意识地未推送该迁移；该记录作为
Phase 11.0 结束时的历史状态保留。

Phase 11.0R 用一次专门构造的真实 turn 重新测试 R5，观察到了缺失的那一项：**3 次 attempt、2 次工具调用/结果循环、
2 个自然出现的同相位合格边界**，以及**真实 DOM 中渲染出的 2 条连续性连接线**，且测量统计精确保持不变（输出 TPS、
峰值、token、TTFT 与完成态卡片总计均未变化）。对早期 R5 语料的只读审计还表明，那两个 turn 在冻结的发布门槛下确实
不合格，并非连接线缺陷。真实 turn 中的两个 `pwsh` checkpoint 命令**并未执行**——宿主沙箱返回了既有的
`SetNamedSecurityInfoW / Win32 5` ACL 错误——因此不声称任何 checkpoint 输出；真正产生两个边界的是真实的调用/结果
循环。运行时观察属于本地报告的 `dev/phase11R/` 证据（被 git 排除、未推送）；独立的 GitHub 远端源码审计属于另一层
源码级验证，不能替代运行时渲染。完整记录见 `docs/IMPLEMENTATION_LOG.md` Phase 11.0R。结论：
**PASS — DSH 0.2.1-rc.2 COMPATIBILITY ACCEPTED。**

**Phase 13.0 moved the unreleased working tree to `0.2.1-rc.3` (reference commit
`1f81c047fc48fa190a683e469daa699857e9afe8`).** The audit re-derived every interface from both reference commits and
from both installed runtimes: all consumed declarations are **byte-identical** — the `SessionEventWindow` /
`SessionEventChange` / `MutableSessionEventSource` contract, `Session` and `SessionManager`,
`SessionBinding`/`sessions.binding()`, `sessions.retainInfo()` and its stable-per-id observer source, the transient
`assistant/live-chunk` producer, the durable turn/settlement events, the compact `AssistantStreamRecord` decoder, the
`conversation.input.dock` slot, the slot renderer/registry, the bundle loader and the plugin-compatibility evaluator.
The only incompatible item was the plugin's own exact `0.2.1-rc.2` peer pin: the rc.3 checker is unchanged, so that
pin is unmet and a profile bundle is silently skipped, which is why the pin moved. The rc.3 product changes are
additive and outside the consumed surface (Conversation header View-tab More menu and its root-scope slot, View pins,
navigation entry customization, `ui-workspace` draft/reuse handling). **No production source changed**, the rebuilt
bundle is byte-identical to the Phase 12.0R artifact
(`07F717FA4BA11425A034B3DD81E122C208D99D1783E4C0F919C409118137ED69`), and the deterministic suite is **960 tests, 960
pass, 0 fail, 0 skipped, 0 todo**. On an isolated DSH `0.2.1-rc.3` host the plugin installed with the exact peer, no
compatibility exemption and no `skippedBundles` entry, registered its dock and was exercised by the real-browser matrix
(R1–R9). The claim stays bounded: the working tree supports `0.2.1-rc.3` only, and `v0.1.6` remains the published
artifact for `0.2.1-rc.2`. Record: `docs/DSH_API_NOTES.md` §16 and `docs/IMPLEMENTATION_LOG.md` Phase 13.0.

**Phase 13.0 将未发布的工作树迁移到 `0.2.1-rc.3`（参考 commit `1f81c047fc48fa190a683e469daa699857e9afe8`）。**
本次审计从两个参考 commit 与两套已安装运行时重新推导了全部接口：所有被消费的声明**逐字节相同**——包括
`SessionEventWindow` / `SessionEventChange` / `MutableSessionEventSource` 契约、`Session` 与 `SessionManager`、
`SessionBinding`/`sessions.binding()`、`sessions.retainInfo()` 及其按 id 稳定的观察源、瞬态 `assistant/live-chunk`
生产端、durable turn/结算事件、紧凑 `AssistantStreamRecord` 解码器、`conversation.input.dock` 插槽、插槽渲染器/注册表、
bundle 加载器以及插件兼容性评估器。唯一不兼容项是插件自身的精确 `0.2.1-rc.2` peer：rc.3 检查器未变，该 peer 因此
不满足，profile bundle 会被静默跳过——这正是 peer 必须迁移的原因。rc.3 的产品变更均为新增且位于消费面之外
（Conversation 头部 View 标签的 More 菜单及其 root 作用域插槽、View 固定状态、导航入口定制、`ui-workspace` 草稿/复用
处理）。**生产源码未改动**，重建 bundle 与 Phase 12.0R 产物逐字节一致
（`07F717FA4BA11425A034B3DD81E122C208D99D1783E4C0F919C409118137ED69`），确定性测试为 **960 tests、960 pass、
0 fail、0 skipped、0 todo**。在隔离的 DSH `0.2.1-rc.3` 主机上，插件以精确 peer 安装成功，未使用兼容性豁免，也未进入
`skippedBundles`，注册了自身 dock 并通过真实浏览器矩阵（R1–R9）验收。声明仍保持限定：工作树仅支持 `0.2.1-rc.3`，
`v0.1.6` 仍是面向 `0.2.1-rc.2` 的已发布产物。记录见 `docs/DSH_API_NOTES.md` §16 与
`docs/IMPLEMENTATION_LOG.md` Phase 13.0。

`v0.1.2` is the release in which the `0.2.0-rc.2` target became the shipped one, and `v0.1.3`, `v0.1.4` and `v0.1.5`
carry it forward unchanged. Those published artifacts are immutable — `v0.1.5`, `v0.1.4`, `v0.1.3` and `v0.1.2`
declare `0.2.0-rc.2` and `v0.1.1` still declares `0.1.7-rc.2` — so the releases are **separately bounded** rather than
expressed as one range. `v0.1.6` is the first release on the `0.2.1-rc.2` line: Phase 11.0 migrated the source and
Phase 11.0R accepted the runtime, and the release round itself adds no TPS, TTFT, estimator, curve, rendering or
lifecycle algorithm change.

**`0.2.1-rc.2` 是 `v0.1.6` 的规范运行时。** Phase 11.0 将开发目标迁移到该版本，并对照隔离安装的 `0.2.1-rc.2` 与上述公开
参考 commit，重新审计了本插件读取的全部 DSH 声明——会话事件信封、session-controller 的事件窗口与结算契约、瞬态
`agent/assistant-stream` / `assistant/live-chunk` 平面、`sessions.binding(sessionId)`、`conversation.input.dock` 插槽
契约、紧凑 `AssistantStreamRecord` 解码及其 usage 字段与工具计时事件、Web 客户端 bundle 加载与 React 插槽生命周期，
以及插件兼容门控。插件消费的声明语义未变：十四项受审声明文件中八项在两个参考 commit 之间**逐字节相同**，其余六项的
变化要么是新增内容，要么位于本插件不读取的表面（provider 配置元数据、实验性 plugin record、新的客户端插槽，以及
subagent/安装管线）。adapter 代码未移动，指标语义未移动，也不涉及任何兼容性豁免。对比记录见
`docs/DSH_API_NOTES.md` §15，`test/dsh-021-contract.test.js` 针对 0.2.1 参考重新固定了线缆形状。

唯一的部署层面变化是 peer 声明本身：DSH 0.2.1-rc.2 会拒绝安装或加载其 `@deepseek-ai/dsh` peer 与当前运行时不匹配的
插件，因此 `package.json` 现在精确固定为 `0.2.1-rc.2`。

该声明有意限定范围：不写 `0.2.1+`、不写 `0.2.x`、也不写“最新 DSH”，因为其他版本均未被实际验证。本机证据来自隔离
安装的 `0.2.1-rc.2`、CLI 版本输出、组合后的 profile 树以及真实浏览器验收矩阵，均记录在
`docs/IMPLEMENTATION_LOG.md`。

`v0.1.2` 是 `0.2.0-rc.2` 目标转为正式发布的版本，`v0.1.3`、`v0.1.4` 与 `v0.1.5` 原样延续该目标。这些已发布产物不可
变更——`v0.1.5`、`v0.1.4`、`v0.1.3` 与 `v0.1.2` 声明 `0.2.0-rc.2`，`v0.1.1` 仍声明 `0.1.7-rc.2`——因此各发布版本是
**各自限定**的，而不是写成一个范围。`v0.1.6` 是 `0.2.1-rc.2` 线上的首个发布：Phase 11.0 完成了源码迁移，Phase 11.0R
完成了运行时验收，发布轮次本身不引入任何 TPS、TTFT、估计器、曲线、渲染或生命周期算法变化。

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
runtime contract. `package.json` declares an exact compatibility gate,
`"peerDependencies": { "@deepseek-ai/dsh": "0.2.1-rc.3" }`. DSH evaluates that peer against the running runtime version
before a profile starts the plugin, so an unsupported DSH is rejected instead of silently admitted. The exact range is
deliberate: `^0.2.1-rc.2`, `~0.2.1-rc.2`, `>=0.2.1-rc.2`, `0.2.x` and `*` would all admit runtimes this project has
never exercised, and the dual `0.2.1-rc.2 || 0.2.1-rc.3` range would erase the evidence boundary between the rc.2 and
rc.3 references. An exact pin matches exactly one runtime: the working tree therefore supports `0.2.1-rc.3` only, and
the published `v0.1.6` artifact keeps its own exact `0.2.1-rc.2` pin. The recorded corpora keep the version they were
captured on: `fixtures/dsh-turns/` is `0.1.5`, `fixtures/dsh-0.1.7/` is `0.1.7-rc.2`, and neither is restamped;
`test/dsh-020-contract.test.js` keeps the 0.2.0-rc.2 evidence it was written on, `test/dsh-021-contract.test.js` is the
0.2.1-rc.2 layer, and `test/dsh-021-rc3-contract.test.js` is the 0.2.1-rc.3 layer.

`fixtures/dsh-turns/` 下的八段录制采集自 `0.1.5`。它们仍是指标算术、解码器与历史兼容性的证据，但**不是** tool/result
形状、settle-assistant 语义、turn 完成生命周期或客户端事件窗口行为的证据，也不构成受支持的运行时契约。`package.json`
声明精确兼容门控 `"peerDependencies": { "@deepseek-ai/dsh": "0.2.1-rc.3" }`。DSH 会在 profile 启动插件前用当前运行时
版本校验该 peer，因此不受支持的 DSH 会被拒绝，而不会被静默接受。使用精确范围是有意的：`^0.2.1-rc.2`、`~0.2.1-rc.2`、
`>=0.2.1-rc.2`、`0.2.x` 与 `*` 都会放行本项目从未实际验证过的运行时，而 `0.2.1-rc.2 || 0.2.1-rc.3` 这样的双范围会抹掉
rc.2 与 rc.3 两个参考之间的证据边界。精确 pin 只能匹配一个运行时：因此工作树仅支持 `0.2.1-rc.3`，已发布的 `v0.1.6`
产物继续保留其自身的精确 `0.2.1-rc.2` pin。已录制语料保留其采集时的版本：`fixtures/dsh-turns/` 为 `0.1.5`，
`fixtures/dsh-0.1.7/` 为 `0.1.7-rc.2`，两者均未改写版本标记；`test/dsh-020-contract.test.js` 保留其编写时的
0.2.0-rc.2 证据，`test/dsh-021-contract.test.js` 是 0.2.1-rc.2 层，`test/dsh-021-rc3-contract.test.js` 是 0.2.1-rc.3 层。

## 3. Install / 安装

Three installation paths. The npm package is the primary distribution; the GitHub Release tarball is an offline, immutable
fallback; the checkout is only for developing the plugin itself.

安装方式有三种。npm 包是主要分发方式；GitHub Release tarball 是离线、不可变的回退方式；检出目录仅用于开发插件本身。

### 3.1 Prerequisite / 前置条件

The plugin declares an exact runtime peer and DSH refuses to start a plugin whose DSH peer does not match the running
runtime, so the prerequisite follows §2.1: **install the runtime that matches the plugin version you are installing.**

| Installing | Required DSH |
|---|---|
| `@0.1.6` (npm / GitHub Release, §3.2, §3.3) | `@deepseek-ai/dsh@0.2.1-rc.2` |
| `@0.1.5` (npm / GitHub Release, historical) | `@deepseek-ai/dsh@0.2.0-rc.2` |
| `@0.1.4` (npm / GitHub Release, historical) | `@deepseek-ai/dsh@0.2.0-rc.2` |
| `@0.1.3` (npm / GitHub Release, historical) | `@deepseek-ai/dsh@0.2.0-rc.2` |
| `@0.1.2` (npm / GitHub Release, historical) | `@deepseek-ai/dsh@0.2.0-rc.2` |
| `@0.1.1` (npm / GitHub Release, historical) | `@deepseek-ai/dsh@0.1.7-rc.2` |
| the development checkout (§3.4) | `@deepseek-ai/dsh@0.2.1-rc.2` |

```powershell
# released v0.1.6 artifacts (npm / GitHub Release)
npm install -g @deepseek-ai/dsh@0.2.1-rc.2

# released v0.1.5 and every historical release above
npm install -g @deepseek-ai/dsh@0.2.0-rc.2

# historical v0.1.1 only
npm install -g @deepseek-ai/dsh@0.1.7-rc.2
```

Do not install an arbitrary latest DSH and assume the plugin runs on it: the plugin declares exact runtime
compatibility only, and no DSH release other than the three named above has been exercised by this project.

插件声明精确的运行时 peer，而 DSH 会拒绝启动 DSH peer 与当前运行时不匹配的插件，因此前置条件遵循 §2.1：**安装与所要
安装的插件版本相匹配的运行时。**

| 安装对象 | 所需 DSH |
|---|---|
| `@0.1.6`（npm / GitHub Release，§3.2、§3.3） | `@deepseek-ai/dsh@0.2.1-rc.2` |
| `@0.1.5`（npm / GitHub Release，历史版本） | `@deepseek-ai/dsh@0.2.0-rc.2` |
| `@0.1.4`（npm / GitHub Release，历史版本） | `@deepseek-ai/dsh@0.2.0-rc.2` |
| `@0.1.3`（npm / GitHub Release，历史版本） | `@deepseek-ai/dsh@0.2.0-rc.2` |
| `@0.1.2`（npm / GitHub Release，历史版本） | `@deepseek-ai/dsh@0.2.0-rc.2` |
| `@0.1.1`（npm / GitHub Release，历史版本） | `@deepseek-ai/dsh@0.1.7-rc.2` |
| 开发检出目录（§3.4） | `@deepseek-ai/dsh@0.2.1-rc.2` |

不要安装任意“最新”DSH 并假定插件可在其上运行：本插件只声明精确的运行时兼容性，且除上述三个版本之外本项目未验证任何
DSH 版本。

### 3.2 npm, the default installation / npm 默认安装

```powershell
dsh plugin --profile web add dsh-turn-performance-meter
```

Pin the version for a reproducible install:

固定版本以获得可复现的安装：

```powershell
dsh plugin --profile web add dsh-turn-performance-meter@0.1.6
```

The unversioned command resolves npm's `latest` dist-tag; the pinned form resolves `0.1.6` exactly. Both install a frozen
copy of the published artifact.

无版本号命令解析 npm 的 `latest` dist-tag；固定版本形式精确解析 `0.1.6`。两者安装的都是已发布产物的冻结副本。

### 3.3 GitHub Release tarball (offline fallback) / GitHub Release tarball（离线回退）

Download `dsh-turn-performance-meter-0.1.6.tgz` from the
[v0.1.6 release](https://github.com/HaowenCang/dsh-turn-performance-meter/releases/tag/v0.1.6), then install it:

从 [v0.1.6 release](https://github.com/HaowenCang/dsh-turn-performance-meter/releases/tag/v0.1.6) 下载
`dsh-turn-performance-meter-0.1.6.tgz` 后安装：

```powershell
dsh plugin --profile web add "file:C:/path/to/dsh-turn-performance-meter-0.1.6.tgz"
```

This is the offline and immutable fallback, and the asset is the same tarball the npm registry serves. `file:` on a
tarball is a frozen artifact, which is the point: the installed bytes cannot drift from the published release, and the
release carries a `.sha256` sidecar for verifying the download before installation.

这是离线且不可变的回退方式，该资产与 npm registry 所提供的 tarball 为同一份。对 tarball 使用 `file:` 得到的是一份冻结
产物，这正是目的所在：安装的字节不会相对已发布 release 漂移，且该 release 附带 `.sha256` sidecar，可在安装前校验下载
内容。

Verify the download before installing:

安装前校验下载内容：

```powershell
Get-FileHash .\dsh-turn-performance-meter-0.1.6.tgz -Algorithm SHA256
Get-Content .\dsh-turn-performance-meter-0.1.6.tgz.sha256
```

### 3.4 Development checkout / 开发检出

```powershell
dsh plugin --profile web add "link:C:/path/to/dsh-turn-performance-meter"
```

`link:` tracks the working checkout and is intended for **development only**. The reason is measured rather than
stylistic. pnpm installs a `link:` spec as a **symlink to the checkout**, so a later `npm run build:client` is picked up by
the profile without reinstalling, whereas the npm and `file:` specs of §3.2 and §3.3 install a **frozen copy**. `link:` is
therefore not a distribution form: it follows whatever the checkout contains, including uncommitted work, so it cannot
represent an immutable published installation.

`link:` 跟踪工作检出目录，**仅用于开发**。其理由来自实测而非风格偏好。pnpm 把 `link:` 安装为**指向检出目录的符号链接**，
因此之后执行 `npm run build:client` 时 profile 会直接读到新字节，无需重装；而 §3.2 与 §3.3 的 npm 与 `file:` 形式安装的
是一份**冻结副本**。因此 `link:` 不是分发形式：它跟随检出目录的当前内容（包含未提交的改动），无法代表一份不可变的已发布
安装。

Every command above initializes the profile on first use and adds the package to `dsh.profile.bundles` automatically,
because this package declares `dsh.bundle.patch`.

以上每种命令都会在首次使用时初始化 profile，并因为本包声明了 `dsh.bundle.patch` 而自动把包名加入 `dsh.profile.bundles`。

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

The live meter displays the **phase-cumulative TPS of the active attempt's current phase episode**: the episode's
generated token mass over the wall time since that episode's first sample, published once the episode holds at least
three samples, always with `≈`, and never a curve. A `reasoning → output` transition resets the episode clock, the
numerator and the sample count, so the first output rate never contains reasoning-phase elapsed time; a new model
invocation after a tool call or a retry resets all of it, so unrelated calls are never mixed. No model attempt streaming
means no value — never a stale rate. A stall decays hyperbolically by elapsed wall time: the numerator stops moving while
the denominator advances.

实时组件显示**当前活动 attempt 当前相位片段的累计 TPS**：该片段自首个样本以来生成的 token 量除以片段墙钟时间，且在片段
累计满 3 个样本后才发布，始终带 `≈`，且不显示曲线。`reasoning → output` 切换会重置片段时钟、分子与样本计数，因此首个
output 速率绝不包含 reasoning 片段的已用时间；工具返回后的新模型调用或重试会重置全部状态，禁止混合两个独立模型调用的
数据。没有 model attempt 在流式输出时即无该值，绝不显示过期速率。停滞按已流逝的墙钟时间呈双曲线衰减：分子停止增长而
分母继续推进。

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

The curve is one **attempt-local phase-cumulative throughput trace per model attempt**: a vertex at attempt-local `t`
reports the cumulative average of the phase episode in force at `t` — that episode's sample mass up to `t` over the wall
time since its first sample — whatever its phase, which is the same estimator family the live pill publishes. The
compressed x-axis joins attempts so tools and inter-attempt waits consume **zero width**, but each episode owns its own
clock and numerator, so the trace steps down at a phase boundary and climbs again on the new phase's own evidence; a
model silence *inside* a call retains full width as a hyperbolic decay, not as a reset to zero. Reasoning and output are
**colours** of that one trace. The trace is sampled on a 100 ms grid, and the published series is capped at 200 points by
evenly spaced nearest-sample reduction with no interpolation. The chart-wide render budget is 512 points allocated across
phase-coloured runs with the global peak preserved, while `peakTps` is read from the published series *before* any render
allowance is applied. The curve's magnitudes are the provider-calibrated per-delta allocation whenever authoritative
usage exists, so the drawn curve and the printed token total are one magnitude system, and
`attemptBreakdown[].calibration.samples` stays the authoritative magnitude source once a turn has settled.

曲线是**每个 model attempt 各一条 attempt 局部的相位累计吞吐轨迹**：局部时刻 `t` 的取值是 `t` 处生效的那个相位片段的累计
平均——该片段截至 `t` 的样本量除以自其首个样本以来的墙钟时间——不区分相位，与实时指示器属于同一估计器族。压缩横轴把各
attempt 首尾相接，因此工具时间与 attempt 间等待占用**零宽度**；但每个片段拥有自己的时钟与分子，轨迹在相位边界处下台阶，
再依据新相位自身的证据重新爬升；attempt **内部**的模型静默按完整宽度绘出，表现为双曲线衰减，而不是归零。reasoning 与
output 是同一条轨迹的两种**颜色**。轨迹以 100 ms 网格采样，发布序列按时间等距取最近样本压缩到 200 点上限，不做插值。
图级渲染预算为 512 点，按相位色段分配并保留全局峰值；`peakTps` 则在应用任何渲染配额**之前**从发布序列读取。当存在权威
usage 时，曲线量级采用 provider 校准后的逐 delta 分配，因此曲线与卡片打印的 token 总数属于同一量级体系；turn settle
之后，`attemptBreakdown[].calibration.samples` 始终是量级的权威来源。

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
├─ CHANGELOG.md                      Release history (0.1.6)
├─ LICENSE                           MIT
├─ package.json                      version 0.1.6, published to npm, scripts: test / build:client / verify
├─ cordis.patch.yml                  Bundle row insertion; the only DSH composition this plugin adds
├─ index.js                          host entry (no-op by design; telemetry is client-side)
├─ client.js                         GENERATED browser bundle (npm run build:client)
├─ lib/client.js                     same bytes; the layout the local injector validates
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ METRICS_SPEC.md
│  ├─ MIMO_RUNTIME_METRICS.md
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
│  ├─ core/             pure metric engine — zero @deepseek-ai/* imports (15 modules)
│  ├─ dsh/              DSH rc.2 raw evidence -> normalized events (+ client-feed)
│  ├─ host/             TurnTelemetryStore (session+turn keyed)
│  └─ client/           main.js entry + presentation
│     ├─ live/          state machine, presenter, scheduler, controller, MeterRoot,
│     │                 React pill, locale, CSS
│     └─ completed/     completed-card view tree + React binding + card CSS
├─ test/                65 test files + helpers/ (core / dsh / live / completed / bundle)
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
