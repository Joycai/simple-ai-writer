# 能力解析层重构：HLD

> **状态：`partial`——作者 2026-09-27 定下 §6 的七个决定，全部按推荐；按 LLD 的 P0–P7 分期实施，P0（请求体金标与棘轮扩面）已落成，记录在 LLD §9.1。** 执行方案（文件、类型、算法、分 PR、测试）在
> [`capability-resolution-lld.md`](capability-resolution-lld.md)。
> 前置阅读：[`capability-gating-plan.md`](capability-gating-plan.md)（C0–C3 已落成的能力表，本文在它上面扩，不推翻）、
> [`provider-layering.md`](provider-layering.md)（字段归哪一层）。起因是 2026-09-27 对「渠道 × 模型 × 上游 × 能力」
> 全部代码的一次盘点（本文 §1）。

## 0. 一句话

把今天散在 `capabilities.ts`、`reasoning.ts`、`jsonMode.ts`、`toolChoice.ts`、`modelLimits.ts`、`platforms.ts`
和两个抽屉里的判断，收进**一个解析层**。它由四部分组成：

- **一张事实登记表**：开关、枚举、数值三类都登记在这里。
- **一条固定顺序的裁决链**：守卫 → 上游 → 平台 → 模型目录 → 协议规则 → 缺省；再合成作者声明，最后套上学到的上限。
- **一个请求计划**：一次请求的全部决定。适配器和「将发送」摘要都只拿它去拼 body。
- **一个回退执行器**：报错 → 分类 → 学到 → 重算计划 → 重试，有上界。

## 1. 起点：已有的，与缺的

### 1.1 已经对的——保留

| 已有 | 位置 | 为什么保留 |
| --- | --- | --- |
| 协议规则 × 平台格 × 上游格，三值裁决加原因码 | `capabilities.ts` `familyVerdict` | 形状正确：私有字段缺省 `no`、原生字段缺省 `yes / unknown`；格是实测，永远压过规则 |
| 平台画像只管地址、线路、主机识别 | `platforms.ts` `PROFILES` | 「在哪」与「能做什么」已经拆开 |
| 上游由作者声明，能力由内置画像给出 | `relayUpstream.ts` + `UPSTREAM_CAPABILITIES` | 中转站主的前缀永远不进代码（gating §8.11） |
| 思考类目是拼法表 | `reasoning.ts` `THINKING_CATEGORIES` | 适配器不按类目 id 分支，只读字段 |
| 三道闸 | 矩阵快照 · 一致性测试 · 源码棘轮 | 防止长回去的机制本身是对的，本文只扩它们的覆盖面 |

### 1.2 四个结构性缺口

**A. 表只回答「有没有」，不回答「取什么值」。** `capabilityVerdict` 只给 yes / unknown / no。
下面这些「取什么值」的问题各有各的函数，各有各的回退：

- 思考类目：`resolveThinkingCategory`，缺省按族 `switch`（`reasoning.ts` 的 `defaultCategoryId`）。
- JSON 档位：`resolveStructuredOutput`，Anthropic 走 `if (family === "anthropic")`（`jsonMode.ts` 的 `resolveStructuredOutput`）。
- 输出上限：`effectiveMaxOutput`。
- 上下文窗口：只在模型行上，没有目录。
- Responses 的 `include`：`platforms.ts` 的字段，加 `/non-reasoning/i`（`responses.ts` 的 `streamResponses`）。
- 提示缓存：`standard === "anthropic"`（`anthropic.ts` 的 `cachesPrompt`）。

**B. 模型 id 轴散在七处，匹配方式有四种。**

| 事实 | 位置 | 匹配 | 作用域 |
| --- | --- | --- | --- |
| 预填（思考类目 / 窗口 / 上限 / 类型 / PDF） | `PROFILES[*].models` | 精确 id | 平台；只预填一次 |
| 预填（上一行没覆盖的） | `ProviderDrawer.tsx` 的起步模型（`doubao(…)`、OrcaRouter 免费 DeepSeek） | 写死 | 平台；只预填一次 |
| 输出上限 | `KNOWN_OUTPUT_CAPS` | 规范化后前缀，最长者胜 | 全局 |
| 严格 schema 的自动提档 | `KNOWN_JSON_SCHEMA` | 同上 | 全局 |
| 按 id 放行 / 拒绝能力 | `ModelMatcher`（`runs` / `refuses`） | 原始 id 正则 | 平台 × 族 |
| 上游覆盖哪些模型 | `UPSTREAM_CAPABILITIES[*].models` | 正则 | 上游 |
| 有没有推理可加密 | `/non-reasoning/i` | 正则 | 全局，写在适配器里 |

后果有三：

- 新增一个型号可能要改三四个文件。
- 中转站的 `[CC量]claude-opus-4-6` 被 `normalizeModelId` 规范化后，前缀仍对不上任何全局表。
- 精确 id 表与前缀表对同一个 id 可以给出不同的上限。

**C. 回退有五套，互相看不见。**

| 机制 | 位置 | 键 | 存在哪 | 裁决和抽屉能否看到 |
| --- | --- | --- | --- | --- |
| JSON 档位降级 | `jsonMode.ts` 的 `noteJsonModeRefused` / `withJsonModeFallback` | standard + baseUrl + modelId | 内存 Map | 否 |
| 强制 tool_choice 降级 | `toolChoice.ts`，`index.ts` 的 `streamCompletion` | 同上 | 内存 Set | 否 |
| 结构化任务改走 JSON 路径 | `agent/structured.ts` 的 `TOOL_CAPABILITY_ERROR` / `forcedToolIsWasted` | 每次请求重判 | — | 否 |
| 思考预算耗尽后关思考 | `agent/runtime.ts` 的 `runAgent`（`thinkingCut` 分支） | 当次运行 | — | 否 |
| 数值缺省链 | `modelLimits`、`context/budget.ts` 的 `ASSUMED_INPUT_CEILING_TOKENS`（32000） | — | — | 部分 |

同一个问题被回答不止一次：

- **「强制 tool_choice 真的会被执行吗」有三个来源**：类目的 `forcing` 字段、平台格 `forcedToolChoice`、学到的 Set。
  `structured.ts` 的 `forcedToolIsWasted` 只问了其中两个。
- **「在思考吗」有三种判法**：
  - `capabilities.ts` 只看类目，类目不是 `off` 就算在思考。
  - `forcesToolChoiceAuto` 只看 effort 是否显式非 off。
  - `serverTools.ts` 看请求体里是否 `effort === "none"`。
  - 还有 UI 用的 `thinkingIsOn`：`claude-adaptive` 在 off 时它回答「关」，但线上发的是 low 档，其实仍在想。
- **「哪些档位不能发」有两处**：GLM 的 off 写在类目的 `menu` 里；gpt-6-astra 的 off、gpt-5.6-sol 的 max / minimal 写在 `reasoningOff` / `effortMax` / `effortMinimal` 格里（#717）。agent 的回退只读前者。

**D. 提问者各自复刻一遍请求。** `modelSummary.ts` 的 `wireSummary` 用它自己的六处 `family ===`，
重算一遍四个适配器已经算过的东西，靠一致性测试把两边钉在一起。新增一个值类决定，就要在两边各写一遍。

### 1.3 顺带核实的两处不一致

1. **Gemini 与 Responses 适配器不读 `forcedToolChoice` 格**（`gemini.ts` 的 `streamGemini` 拼 `toolConfig` 处、`responses.ts` 的 `toResponsesToolChoice`）。
   在平台自己列出的线路上，今天这两族没有 `false` 格。但智谱的格写在 `all` 上，作者在智谱主机下手建的 ② / ③ 渠道
   会被推断成智谱，那里的强制照发。一致性测试只走平台列出的线路，所以抓不到这一格。
   同类的还有 Chat 与 Gemini 适配器发温度时不问格（`openai.ts` 的 `streamOpenAI`、`gemini.ts` 的 `streamGemini`），今天没有 `false` 格，零差异。
2. **Anthropic 的 `max_tokens` 违反 `modelLimits.ts` 头注第 1 条。** 头注说「表里的值绝不发给 Anthropic」，
   但 `conn.ts` 的 `connOptions` 传过去的是 `effectiveMaxOutput`，里面含表值和应用缺省，`anthropic.ts` 的 `resolveMaxTokens` 原样发出。
   两处出自同一个提交（`b0993266`），从一开始就矛盾。取哪边是 §6 的 D2。

## 2. 目标与非目标

**目标**

| # | 目标 | 验收 |
| --- | --- | --- |
| G1 | 扩展只加数据 | §5 的每一行都是「一处数据 + 两种语言的句子」，最多再加一个拼法函数 |
| G2 | 判定不写分支 | 按族分支只出现在拼法层，也就是 body 长什么样。棘轮扩到 `standard ===`、`platform ===` 和表外的模型 id 字面量 |
| G3 | 一条回退链，每个值都带出处 | 同一个问题只有一个解析入口；抽屉能说出「这个值来自哪一层」，也能说出本次会话学到了什么 |
| G4 | 行为不变可证明 | 每期先过请求体金标，逐字节相同。有意的行为变化逐条列在 LLD §5 的账本里，且只出现在点名的那一期 |

**非目标**（重申 gating §5，外加三条新的）

- **画像不让作者编辑。** 实测事实不是偏好，作者能改的是模型行上的声明。
- **不写平台子类。** 运行时一族一个适配器，「某一家」是数据。
- **不做主动探测能力。** 「学到的」只来自正常请求的 400，不额外发请求。探测维与配置层的关系仍是 provider-layering §7 的未决项。
- **不合并思考类目表。** `THINKING_CATEGORIES` 仍是「怎么拼」。本文改的是「选哪个类目」：
  它变成值类事实，走同一条链。这与 gating §5 第三条相容。
- **图像区不动。** `defaultImageCaps`、方言、路由、尺寸只有图像管线一个提问者（gating §5 第四条）。
- **计费不动。** `reportsCost` 是上游报价的信任边界，另有 [`billing/01-fee-groups.md`](../feature/billing/01-fee-groups.md)。
- **拼法不动。** 同一事实在各族拼成什么字段，仍归 `reasoning.ts`、`jsonMode.ts`、`serverTools.ts` 和各适配器。

## 3. 核心概念

### 3.1 四个输入

```
Wire     = 平台 × 协议族（× 官方/兼容）       —— 请求打到哪
Subject  = 规范化模型 id × 上游 × 模型类型     —— 问的是哪个模型
Intent   = 模型行上当前线路的作者声明          —— 作者要什么
Request  = 这一次请求的条件：带不带函数工具、要不要强制、思考状态（可选，抽屉没有）
```

`Request` 是新引入的一维。今天 `serverTools.ts` 在请求期丢工具（带函数工具时不发 `agent_max`、思考关闭时不发代码解释器），
`capabilities.ts` 里的 `thinkingOff` 也是条件，但它们各写各的。有了这一维，条件成为格上的数据。
没有请求时（抽屉），解析结果带出条件列表，由界面告诉作者「带函数工具时不发」。

### 3.2 事实：能力的上位概念

今天的 `CapabilityId` 是开关事实。登记表扩成三类：

| 类 | 取值 | 例子 |
| --- | --- | --- |
| 开关 flag | yes / unknown / no | 今天全部 20 个能力；新增 `jsonObjectTier`、`promptCache`、`strictSchemaModel`、`reasons` |
| 枚举 enum | 取值 | `thinkingCategory` |
| 数值 number | 取值 | `maxOutput`、`contextSize` |

每个事实登记五样东西：

1. **类**：开关、枚举或数值。
2. **作用域等级**：
   - **传输类**：只能出现在平台或上游作用域，因为同一个模型换一个平台，拼法就可能不同。例如 DeepSeek 在 DashScope 上走 `enable_thinking`。
   - **固有类**：可以出现在全局模型目录，比如输出上限、窗口、是否守 schema。
   这条划分回答了「思考类目为什么不能进全局目录」。
3. **协议规则**：今天的 `CAPABILITY_RULES`，外加数值与枚举的族缺省（今天是 `defaultCategoryId` 的 switch）。
4. **意图策略**：作者声明与解析结果怎么合成，见 §4.2。
5. **学习规则**（可选）：哪种 400 说明这个事实该降。

### 3.3 格：唯一的数据单元

一格是「作用域 → 事实取值 + 条件 + 出处」。作用域有四个维度：上游 × 平台 × 族 × 模型模式，前三个都可以省略。
今天的七张表都是格的特例，迁移后同一种东西只有一种写法：

- `PLATFORM_CAPABILITIES`：平台 × 族。
- `UPSTREAM_CAPABILITIES`：上游 × 族，外加一个模型模式。
- `ModelMatcher`：平台 × 族 × 模型模式。
- `PROFILES.models`：平台 × 模型。
- `KNOWN_*`：全局 × 模型模式。

**模型模式只有一种语义。** 匹配对象是规范化 id。规范化会去掉：

- 作者前缀表里命中的那段前缀，比如 `[CC量]`；
- 行首的 `[…]` 前缀；
- 厂商命名空间，比如 `openai/`。

模式有三种写法：精确、前缀、正则。同一作用域内，**具体者胜**：精确 > 更长的前缀 > 正则。
正则之间若对同一个 id 给出相冲突的值，由测试拦下，不靠书写顺序。

### 3.4 解析结果

`capabilityVerdict` 的 `{status, reason}` 扩成 `Resolution`，多出三样：

- `value`：枚举和数值事实的取值。
- `source`：来自哪一层，界面据此说「来自平台实测 / 模型目录 / 你的设置 / 本次会话学到」。
- `conditions`：未求值的请求条件。

原因码仍是封闭集合，句子只在语言文件里。新增的原因码有 `learned`、`catalog`、`condition`、`author`、`default`。

### 3.5 请求计划

`planRequest(conn, request) → RequestPlan`：一次请求的**全部决定**。包括：

- 类目、线上 effort、思考状态；
- 温度发不发；
- `max_tokens` 及其出处；
- tool_choice 请求了什么、实际发什么、被谁降级；
- JSON 档位；
- 过完条件的服务端工具；
- 输出详细度、高分辨率、fps、`instructions` 字段、`include`、提示缓存。

计划里没有任何字段名。**适配器只做一件事：把计划拼成 body。** 「将发送」摘要读的是同一份计划。

## 4. 架构

```
┌─ 数据层（纯数据，零分支）───────────────────────────────────────────────────┐
│ facts 登记表 · 协议规则 · 平台格 · 上游格 · 全局模型目录 · 学习规则表       │
│ THINKING_CATEGORIES（拼法） · PROFILES（地址 / 主机 / 线路）                │
└──────────────────────────────┬──────────────────────────────────────────────┘
┌─ 解析层 ─────────────────────▼──────────────────────────────────────────────┐
│ canonicalModelId → resolve(fact, wire, subject, request?) → Resolution      │
│                    ↑ 学到的存储（会话级，只降不升）                         │
│ intent 策略（gate / override / tier） → effective(fact, intent, …)          │
└──────────────────────────────┬──────────────────────────────────────────────┘
┌─ 计划层 ─────────────────────▼──────────────────────────────────────────────┐
│ planRequest(conn, request) → RequestPlan（无字段名，只有决定和出处）         │
└───────┬──────────────────────────────────────┬──────────────────────────────┘
┌─ 拼法层（按族分支只许在这里）─▼──────┐  ┌─ 提问者 ──▼──────────────────────────┐
│ openai / responses / gemini /        │  │ 抽屉 · 矩阵 · 会话面 · 子代理资格    │
│ anthropic：spell(plan) → body        │  │ resolve() 或 planRequest()           │
│ wireSummary：spellSummary(plan)      │  └──────────────────────────────────────┘
└───────┬──────────────────────────────┘
┌─ 回退执行器 ─▼──────────────────────────────────────────────────────────────┐
│ streamCompletion：发送 → 出错且未出首块 → 学习规则分类 → 记入存储 →          │
│ 重算计划 → 重试；每次重试必须让某个事实严格降一级，否则抛出                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 裁决链（固定顺序，所有事实同一条）

| 序 | 层 | 开关事实 | 值类事实 | 原因码 / 出处 |
| --- | --- | --- | --- | --- |
| 0 | 守卫：模型类型、依赖、请求条件 | → `no` | — | `model-type` / `requires` / `condition` |
| 1 | 上游格（仅中转站，且上游覆盖该模型） | 命中即止 | 命中即止 | `upstream` |
| 2 | 平台 × 族格，含模型行 | 命中即止 | 命中即止 | `measured` / `model` / `model-unlisted` |
| 3 | 平台 × all 格，含模型行 | 同上 | 同上 | 同上 |
| 4 | 全局模型目录（仅固有类事实） | 命中即止 | 命中即止 | `catalog` |
| 5 | 协议规则 | 族、origin、assumed、relay | 族缺省 | `protocol` / `family` / `relay` / … |
| 6 | 兜底常量 | — | 应用偏好、适配器缺省 | `default` |
|  | **然后**合成作者意图（§4.2），再套**学到的上限**（只降不升） | | | `author` / `learned` |

第 0–3 层与第 5 层就是今天的 `familyVerdict`，顺序不变。新增的只有三样：

- 第 4 层（目录）只对固有类事实生效。今天的开关事实都是传输类，所以不受影响。
- 值类事实走同一条链。
- 学到的上限成为链的一部分，界面由此能看到它。

### 4.2 意图策略：声明与能力怎么合成

| 策略 | 公式 | 用于 |
| --- | --- | --- |
| **gate** | 作者声明了 且 解析结果不是 `no` → 发送；声明留在行上，不改写 | `pdfInput`、`vlHighResolution`、`videoInput`、`videoFps`、`textVerbosity`、各服务端工具、`temperature` |
| **override** | 作者值（若有）否则解析值；再由消费方按出处决定信不信（§4.3） | `maxOutput`、`contextSize`、`thinkingCategory` |
| **tier** | 作者声明的档（或自动档），先被解析结果封顶，再被学到的封顶 | `structuredOutput`（off < json_object < json_schema） |

没有声明位、只由解析决定的事实（`instructionsField`、`promptCache`、`reasons`），策略为 `none`。

### 4.3 出处决定信任：硬闸只收可靠来源

数值事实带着出处走，消费方按出处决定信不信。这把 `modelLimits.ts` 头注里那条「表很胆小」的规则，
从一段注释变成一张数据表：

| 消费方 | 收哪些出处 | 理由 |
| --- | --- | --- |
| 预算规划（`context/budget.ts`） | 全部 | 猜低只是规划保守一点，猜高什么也不花 |
| 发送前的窗口硬闸（`index.ts` 的 `ContextSizeError`） | 作者值、探测值 | 目录错了会让请求发不出去 |
| Anthropic 的 `max_tokens` | 作者值、探测值（D2 推荐） | 超过模型上限是一次 400，整条线不能用 |
| 表单占位 | 全部，并显示出处 | 让作者看见它从哪来 |

### 4.4 思考状态只有一个定义

`wireThinks(category, effortOnWire)` 返回 `on / off / unknown`，只由类目**数据**推出。
为此给类目加一个字段 `offSpelling`，说明 off 在线上是「真关」还是「落到最低档」。`off` 类目什么都不发，结果是端点缺省，恒为 `unknown`。
每条条件自己声明两件事：遇到 `unknown` 时按哪边算，以及输入缺失时（抽屉只知道类目）是直接触发还是留给界面说明。

今天的三种判法都能由它和条件上的 `unknownAs` / `absent` 逐格复现，复现清单是 LLD §3.5 的那张表。有两处分歧：

- MiniMax / Doubao ④ 关思考时带不带温度。这一处**不排期**，等一条实测。
- agent 思考回退遇到「没有关闭档」的模型。这一处按修正处理，因为今天回退发出的 off 在线上是 low。

两处都在 LLD 的行为变化账本里（B6、B8）。

### 4.5 学到的降级：一个存储、一张分类表、一个执行器

- **存储**：键是（standard, baseUrl, modelId, 事实），值是上限。开关事实的上限是 `no`，档位事实的上限是一个档。
  只降不升，会话级。持久化是 D3。
- **分类表 `LEARN_RULES`**：每行是「报错正则 → 事实 → 本次计划里这个事实的取值 → 降到哪」。
  今天的两个正则（`/tool[_ ]?choice/`，以及 JSON 模式的四种字段名）是它的前两行。以后学温度、学 effort，都是加一行。
- **执行器**：回退只在首块之前发生，每次重试必须让某个事实严格降一级。格是有限的，所以循环必然终止。
  `structured.ts` 那套「工具调用失败就走 JSON」是任务层的路径选择，不是学习。
  它保留，但改问计划里的 `toolChoice.sent`，不再自己拼两个来源。

## 5. 扩展方式（G1 的验收表）

| 要做的事 | 改哪里 | 还要改什么 |
| --- | --- | --- |
| 新平台 | `PROFILES` 加地址、主机、线路；平台格加实测 | 语言文件的平台名 |
| 新模型（固有事实：上限、窗口、是否守 schema） | 全局目录加一行 | 无 |
| 新模型在某平台的拼法（思考类目、按 id 的放行） | 该平台格的模型行 | 无 |
| 新中转上游 | `RELAY_UPSTREAMS` 与上游格 | 两种语言的上游名 |
| 新开关能力 | 登记表加一行（`Record` 让它不登记就编译不过）；平台格补实测 | 拼法函数一个；两种语言的句子 |
| 新值类事实 | 登记表加一行，写明意图策略和出处信任 | 计划里一个字段、拼法一处 |
| 学会一种新的 400 | `LEARN_RULES` 加一行 | 无 |
| 一个思考方言 | `THINKING_CATEGORIES` 加一项（今天就是这样） | 两种语言的句子 |

## 6. 作者拍板的决定

> **2026-09-27，作者：D1–D7 全部按推荐。** 下面保留每条的选项与理由，推荐项即决定。

**D1　平台格和目录里的模型值：运行时缺省，还是一次性预填？**

- 今天是一次性预填。`ModelCalibration` 的注释写明「a prefill, never a runtime default」，
  但 `KNOWN_OUTPUT_CAPS` 和 `KNOWN_JSON_SCHEMA` 已经是运行时缺省。两种体制并存。
- **推荐：运行时缺省。** 只作用于有真正「未设」状态的字段：`thinkingCategory` 为 auto、`contextSize` 与 `maxOutput` 为空。
  界面显示出处，作者的值永远优先。这与 platforms 的规则 3 同理：一次新的实测能到达每一行，不需要迁移。
- `type`（模型类型）没有「未设」状态，仍只预填。`pdfInput` 能不能区分「未设」和 `false`，要先查列，查不到就仍只预填。
- **行为变化**：已有的、留空的行，在有格的平台上会换值。例如在智谱上把 thinkingCategory 留成 auto 的 GLM 行，
  会从 `openai-generic` 变成 `glm-switch`。这正是 zhipu-plan G11 要修的问题。已经预填过的行存了值，不受影响。

**D2　Anthropic 的 `max_tokens` 信哪些来源？**

- 推荐：只信作者值和探测值；否则用适配器缺省 32768，也就是回到 `modelLimits.ts` 头注第 1 条。
- 另一选项：改头注去迁就代码。但代价是作者把应用缺省调到 64k 以后，每个上限更低的 Claude 请求都会 400。

**D3　学到的降级要不要持久化？** 推荐维持会话级，只加可见性。持久化等于替探测维做决定，而 provider-layering §7 仍未决。

**D4　回退执行器合一的范围。** 推荐分两步：

- P3 先共享存储和分类表，两个执行器各自保留。这一步不改行为。
- P7 再把 JSON 整形移进计划，并入 `streamCompletion` 的执行器。这一步可以停在 P6 之后不做。

**D5　目录结构。** 推荐仿照 `agent/registry.ts` + `toolTable/` 的先例：`capabilities.ts` 留作门面，
实现拆进 `src/lib/ai/capability/`。测试仍放 `src/lib/ai/__tests__/`，这是 testPlacement 的「最近的 `__tests__/`」。
门面让现有的 19 个导入方（14 个源文件、5 个测试）一行都不用改。

**D6　棘轮扩大扫描面。** 推荐从 P0 起计数：`standard ===`、`platform ===`，以及格文件之外对 `modelId` 的正则、
`includes`、`startsWith`。起点等于当时的实际计数，双向棘轮，与今天的 `capabilityFamilyRatchet` 同一套。

**D7　界面。** 抽屉要显示「出处」与「本次会话学到」，矩阵组件要多出值类事实。按惯例先出 Claude Design 稿、
作者点头后再写界面代码。P0–P5 都不碰界面，不受这条阻塞。

## 7. 分期总览

| 期 | 内容 | 行为变化 | 能否停在这里 |
| --- | --- | --- | --- |
| **P0** | 护栏先行：请求体金标、扩大棘轮 | 无 | 能 |
| **P1** | 拆目录、建事实登记表，门面不变；矩阵文档逐字节相同 | 无 | 能 |
| **P2** | 模型 id 轴合一：规范化 id、一种模式、七处迁进格与目录 | 无（规范化 id 的扩大留到 P6b） | 能 |
| **P3** | 学到的存储与分类表合一，裁决链看得到它 | 无 | 能 |
| **P4** | 条件进格、`wireThinks`、`promptCache` 与 `jsonObjectTier` 进表（`strictSchemaModel` 与 `reasons` 已随 P2 的目录落地） | 请求体无；agent 思考回退在「没有关闭档」的模型上改为提示作答（LLD B8） | 能 |
| **P5** | 请求计划：适配器与摘要只读计划 | 平台列出的线路上请求体无变化；「将发送」摘要改说线上真实的值（B10）；结构化任务在几种中转站线路上少跑一轮注定降级的强制调用（B4）；手建的智谱 ② / ③ 渠道不再强制（B3） | 能 |
| **P6** | 值类事实走链加出处信任，D1 与 D2 生效；界面在设计稿之后 | **有**（LLD B1、B2：留空字段取格值，Anthropic `max_tokens` 只信作者值） | 能 |
| **P6b** | 规范化 id 生效：中转站前缀后的 id 能命中目录。必须在 P6 之后，否则扩大的目录命中会经由 `max_tokens` 发到 ④ 线路上 | 有（LLD B7） | 能 |
| **P7** | （可选）JSON 整形进计划，回退执行器合一 | 无 | — |

每期一个 PR，从 `main` 切，不叠 PR。版本号跟着带请求体变化的那一期走（P5、P6、P6b）。

## 8. 风险与防护

| 风险 | 防护 |
| --- | --- |
| 大面积移动带进行为差 | P0 的请求体金标。它用真实适配器生成（测试调真正的生产者），逐字节比对，差异按「哪几格变了」审 |
| 规范化 id 让不该命中的模型命中 | P2 与 P6b 分开；P6b 的差异逐条进账本；冲突模式由测试拦；前缀匹配保持今天的普通 `startsWith` |
| 计划层成为新的上帝对象 | 计划里只有决定，没有字段名；拼法仍各在其族。棘轮保证判定不回流到适配器 |
| 学到的状态让测试互相污染 | 保留每个存储的 `__reset`，合并后只剩一个 |
| 值类事实的缺省变动吓到作者 | 界面显示出处；作者值永远优先；D1 只作用于「未设」 |

## 9. 与既有文档的关系

- [`capability-gating-plan.md`](capability-gating-plan.md)：本文是它的下一阶段。§5 的「明确不做」全部继承。
  改动的只有一处：「不动思考类目」细化为「不动类目的拼法；选哪个类目进链」。
- [`provider-layering.md`](provider-layering.md)：§2 的归属判断法不变。本文给「探测维」补上被动的一半，也就是学到的降级。
  持久化仍归它的 §7。
- [`capability-matrix.md`](capability-matrix.md)：P1–P5 逐字节不变；P6 起多出值类事实的章节。
- 落地时各期在 LLD 里回填实施记录，并同步 `docs/reference/codemap.md` 的 `src/lib/ai/` 一节。
