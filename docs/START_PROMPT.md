# DeepSeek V4.1 Flash Start Prompt

将以下内容作为首次任务直接发送给 DeepSeek V4.1 Flash：

---

你现在负责继续完成一个 DeepSeek Harness（DSH）插件项目：

```text
E:\Projects\DSHarness\dsh-turn-performance-meter
```

项目目标是实现一个 **turn 级性能统计插件**，适配 DSH 一个 turn 内多次 LLM 调用、工具调用、重试、PowerShell/shell、write/edit 等 Agent 工作流。不要把它实现成只统计单个 step 或单次模型请求的 TPS 插件。

## 一、先阅读，不要立即开始改代码

按以下顺序完整阅读：

```text
README.md
docs/ARCHITECTURE.md
docs/METRICS_SPEC.md
docs/UI_SPEC.md
docs/DSH_API_NOTES.md
docs/TASKS.md
docs/TEST_PLAN.md
docs/DIRECTORY_TREE.md
docs/IMPLEMENTATION_LOG.md
```

同时查看：

```text
docs/assets/reference-live-ttft.png
docs/assets/reference-live-streaming.png
docs/assets/reference-completed-summary.png
docs/assets/reference-hover-curve.png
```

`docs/METRICS_SPEC.md` 是统计口径的规范性来源；若代码骨架与该文件存在冲突，应以该文件为准，并在 `IMPLEMENTATION_LOG.md` 说明修改。

## 二、Phase 0 必须先做本机 DSH API 勘察

先执行并记录：

```powershell
cd E:\Projects\DSHarness\dsh-turn-performance-meter
dsh --version
dsh plugin --profile web list --depth 2
dsh --profile web --dump-config
npm run verify
```

随后检查本机实际安装的 DSH 接口，而不是仅依赖公开仓库 master。至少查明：

1. `conversation.composer.dock` 当前的 kind、scope、owner/standard props、occupants 与顺序；
2. 浏览器侧当前如何获得 transient assistant stream / `assistant/live-chunk`；
3. Host/Client 当前能获得哪些 durable `session/event`；
4. `turn/start`、`turn/end`、step、assistant attempt/retry、`tool/call`、`tool/result` 的实际 payload；
5. provider usage 中 `outputTokens`、`reasoningTokens` 的实际位置和语义；
6. 是否存在适合插件的 session projection/resource，用于从 Host 向 Client 发布 turn telemetry；
7. 本地 locale service、主题 token/primitives 以及 Client 插件的正确构建/加载方式。

若环境提供 `cordis_inspect what:"client"` 或同等 Client inspect 能力，应当使用它确认精确 slot 合约。若没有，则从本机安装包/源映射/当前 DSH 文档中核实。

把所有结论、具体文件路径、命令结果和与 `docs/DSH_API_NOTES.md` 的差异写入：

```text
docs/IMPLEMENTATION_LOG.md
```

在 Phase 0 没有完成前，不要凭猜测写 DSH-specific integration。

## 三、不可改变的核心统计规则

### 1. 统计单位

以整个 **turn** 为统计边界。一个 turn 可包含：

```text
LLM -> tool -> LLM -> tool -> ... -> final answer
```

完成态 TPS 必须用总 Token / 总有效生成时间重新计算，禁止计算各 step TPS 的算术平均。

### 2. 实时 TPS

实时模式只显示紧凑统计，不显示曲线。

实时 TPS 是当前 LLM attempt 最近 1 秒的 trailing sliding window：

```text
TPS_live(t) = tokens(t-1s, t] / 1s
```

UI 可每 100–250 ms 刷新一次。每当工具结束后开始新的 LLM invocation、发生 retry/new attempt 时，必须 reset rolling window，不能把两个模型调用混入同一个 1 秒窗口。

### 3. 模型输出范围

必须把以下模型生成内容计入 output：

- 普通 assistant text；
- tool-call arguments；
- pwsh/shell command；
- PowerShell/Python/source code；
- write 的文件正文；
- edit 的 patch/diff；
- 其他由模型生成并传给工具的参数。

以下内容不得计入模型 output TPS：

- 工具返回的 stdout/stderr；
- read/search 返回的文件内容；
- MCP/API/tool result；
- 工具本身产生的错误文本。

### 4. `reasoningTokens`

DSH 当前公开契约中，`reasoningTokens` 已包含在 `outputTokens` 中。因此：

```text
nonReasoningOutput = outputTokens - reasoningTokens
```

绝对禁止 `outputTokens + reasoningTokens`。

### 5. TTFT

TTFT 对整个 turn 只定义一次：

```text
turn/start -> 第一个非空 reasoning/text/tool-call delta
```

后续工具调用完成后的第二次、第三次 LLM 请求不能重新定义 turn TTFT。

### 6. 工具计时

每次工具调用至少记录：

```text
callId
name
startMs
endMs
status
```

同时维护：

```text
toolWorkMs = 每个工具调用时长之和
toolWallMs = 所有工具执行区间并集的时长
```

并行工具会导致 `toolWorkMs > toolWallMs`。紧凑 UI 默认优先展示 `toolWallMs`。

### 7. 完成态 TPS 曲线

曲线只存在于 **turn 完成后的卡片** 中；实时模式绝对不显示曲线。

完成态默认显示四栏摘要；鼠标 hover 或键盘 focus-within 时，在**同一卡片内部**切换为曲线视图；不是 tooltip，不是浮层。

曲线横轴必须暂停/移除工具执行时间。不同 LLM attempt 在压缩时间轴上直接拼接：

```text
wall clock:
LLM A ==== | tool 60s | LLM B === | tool | LLM C =====

curve clock:
LLM A ====LLM B ===LLM C =====
```

工具等待、下一次调用的 pre-first-token 等待不占曲线横轴宽度。模型一次 stream 内部真实发生的 chunk 间停顿则保留，因为这正是模型吞吐稳定性信息。

曲线是必选功能，显示 reasoning + output 两条 series 和 peak TPS。

### 8. 精度与质量标记

流式 delta 一般没有逐 delta 的 provider 精确 token count。不得假装实时 1 秒 TPS 和每个曲线点天然精确。

必须支持：

```text
exact
calibrated
estimated
unavailable
```

推荐最终曲线算法：

1. 实时捕获每个 delta 的 timestamp、phase 和 token-shape weight；
2. turn/attempt 完成得到 provider usage 后，如果有 `outputTokens + reasoningTokens`，分别把 reasoning 与 non-reasoning output 的 delta weights 缩放，使 phase 总和严格等于权威 token 数；
3. 这样局部曲线标为 `calibrated`，聚合 token 总数仍为 `exact`；
4. 缺 `reasoningTokens` 时，不得把 reasoning/output split 标成 exact；
5. 缺数据时显示 `—`，不要用 0 冒充。

不要为了“精确 tokenization”擅自套用 GPT/tiktoken 到 DeepSeek/其他 provider。

## 四、UI 要求

目标样式以 `docs/assets` 中四张截图为参考，但不要复制原站 Tailwind class，也不要依赖对方 DOM。

### Live pending

紧凑、居中，类似：

```text
2.80 s | 首响应计时
```

### Live streaming

类似：

```text
338 tokens/s | 14.3 s
```

其中 TPS 是当前最近 1 秒窗口；右侧为 turn elapsed。无曲线。

### Live tool

工具执行期间不要显示 stale TPS 或强制 TPS=0；切换为紧凑 tool timer，例如：

```text
pwsh · 2.31 s | 17.9 s
```

### Completed default

保留四个主栏：

```text
Reasoning TPS | Output TPS | Generated Tokens | TTFT
```

工具统计放在 secondary line/detail，不永久增加第五栏。

### Completed hover/focus

左侧约 50–60% 为 reasoning/output TPS 曲线，右侧保留 Generated Tokens 与 TTFT，风格参考 `reference-hover-curve.png`。使用 SVG path/polyline 即可，长期 turn 要限制点数。支持 `prefers-reduced-motion`。

## 五、实现原则

1. 不修改 DSH core 源码；项目自身完成全部功能。
2. 不通过 DOM scraping 读取 DSH 或其他插件的数据。
3. 不额外加载 React；使用 DSH browser module table 提供的 React。
4. 不把 whole-session `sessionStats` 当成目标 turn 数据源；可参考其实现，但本插件要维护 turn-level telemetry。
5. 所有 listener/timer/subscription/style 必须可 dispose，HMR 后不能重复累积。
6. session 状态必须按 sessionId + turn 隔离，禁止全局 current-turn 泄漏。
7. 优先复用 `src/core` 中纯函数，不在 Host/UI 中复制一套统计公式。
8. 若本机 DSH API 与文档不同，修改适配层，不要修改统计契约；确实必须改变契约时先说明证据和影响。
9. 任何“看起来能工作”的实现都不能替代测试。

## 六、按阶段推进

严格按照 `docs/TASKS.md` 的 Phase 0 → Phase 8 进行。每完成一个 Phase：

- 更新 `docs/IMPLEMENTATION_LOG.md`；
- 运行相关测试；
- 报告具体修改文件；
- 报告命令与测试结果；
- 明确尚未完成的风险。

不要一次性大改所有文件后再测试。

## 七、第一轮任务

现在只完成 **Phase 0 + Phase 1**，除非为了验证 Client bundle/slot 必须做最小 bootstrap 修改。

第一轮结束时向我报告：

1. 本机 DSH 版本与关键 API 勘察结果；
2. 选择的 Host↔Client telemetry seam 及依据；
3. 对现有代码骨架做了哪些修正；
4. Phase 1 的全部单元测试结果；
5. 还存在的统计精度/API 风险；
6. 下一阶段（Phase 2）的精确实施计划。

不要在没有本机证据时声称某个 DSH API 一定存在。不要省略测试输出。

---
