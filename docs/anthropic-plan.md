# Anthropic 族接入方案（调研与审计）

> **状态：六刀全部实现。** 剩下的是 §7 那几条只能靠真实请求定论的验证。
>
> 协议事实见 [`api/reasoning.md`](api/reasoning.md)、[`api/tools.md`](api/tools.md)、
> [`api/landscape.md`](api/landscape.md) §5 —— 本文只写"我们现在是什么样、
> 该怎么改、为什么"。分层裁决依据见
> [`provider-layering.md`](provider-layering.md)。
>
> 对照文档：[`reasoning-plan.md`](reasoning-plan.md) 是 OpenAI 族那一轮的同类
> 文档，已实现。本轮的目标是把同样的三件事（强度 / 思维链 / 回传）做到 ④ 族。
>
> **两个架构决定，读这份文档时先看这两节**：
> §2 支持范围收窄到 Claude 4.6+，消掉了本轮四个原本最难的问题；
> §3 `thinkingDialect` 字段，处理中继上代次不可推断的那一半。

## 1. 一句话结论

**Anthropic 族的三件事全都没做，而且失败方式与 OpenAI 族相反：不会报错。**

OpenAI 族那一轮修的是"DeepSeek 推理模型在工具循环里必然 400"——一个响亮的
故障。④ 族对应的问题是**静默降级**：不回传 thinking block，API 不报错，只是
悄悄关掉思考。所以这里没有任何现象会逼我们去修，只能靠对照文档发现。

## 2. 支持范围：只接 4.6 及以上（作者决定）

这是本轮最重要的一个约束，因为它**消掉的问题比它带来的多**。官方 per-model 表
（截至 2026-08）按范围切开：

| 模型 | thinking 模式 | 默认 | 400 拒绝 |
| --- | --- | --- | --- |
| **—— 范围内 ——** | | | |
| Fable 5 | 仅 adaptive | 始终开 | `enabled`、`disabled` |
| Mythos 5 | 仅 adaptive | 始终开 | `enabled`、`disabled` |
| Mythos Preview | adaptive + extended | 始终开 | `disabled` |
| Opus 5 | 仅 adaptive | 开 | `enabled`；`disabled` 在 xhigh/max 下 |
| Opus 4.8 | 仅 adaptive | **关** | `enabled` |
| Opus 4.7 | 仅 adaptive | **关** | `enabled` |
| Sonnet 5 | 仅 adaptive | 开 | `enabled` |
| Opus 4.6 | adaptive + extended（已弃用） | **关** | 无 |
| Sonnet 4.6 | adaptive + extended（已弃用） | **关** | 无 |
| **—— 范围外 ——** | | | |
| Opus 4.5 / Haiku 4.5 / Sonnet 4.5 | **仅 extended** | 关 | **`adaptive`** |

### 2.1 这个决定直接消掉的四个问题

**① `adaptive` 可以无条件发。** 范围内**没有任何模型拒绝 `adaptive`**，而范围外
的三个**恰好只拒绝 `adaptive`**。于是"compat 端点上模型名是自由文本、猜不出
代次"这个老问题（[`provider-layering.md`](provider-layering.md) §2.1 坑 3）
**不再需要解决**——不猜，直接发，范围外的模型会得到一条措辞明确的 400：

> `adaptive thinking is not supported on this model`

**把"检测不出代次"从阻塞变成了不必检测。**

**② 手动模式与 `budget_tokens` 整体消失。** 范围内 4.7+ 拒绝 `enabled`，4.6 虽
接受但已弃用。所以
[`reasoning-plan.md`](reasoning-plan.md) §4.1 规划过的 `thinkingBudget` 字段
**可以正式取消**，永远不必实现。

**③ 强制工具调用与思考不再冲突。** adaptive 支持 forced tool use，冲突只存在于
手动模式——而手动模式已出局。所以 `thinkingFor` 里那个 `disabled` 兜底
（§4.1）**是删除，不是替换**。它引发的 Fable 5 / Mythos 5 上的 400 一并消失。

**④ 输出上限统一到 128k。** 范围内全部支持 128k 输出；被排除的 Haiku 4.5 /
Sonnet 4.5 / Opus 4.5 才是 64k 的那批。`DEFAULT_MAX_TOKENS` 当前注释里
"猜高了会打断小模型"的顾虑**在这个范围内不成立**，§5.1 因此大为简化。

### 2.2 另外两条被范围拉平的

- **thinking block 保留策略统一为"保留全部历史回合"。** 范围内全部属于
  keep-all，不需要写 last-turn-only 的分支。代价是思考会累积在上下文里并按
  输入计费——与我们的压缩/裁剪逻辑相关（§5.5）。
- **`output_config.effort` 范围内全部支持。** 这意味着
  `supportsSeparateEffort` 第一次可以对 ④ 族返回 true ——**面板上那个停用的
  「力度」拨盘会亮起来**。唯一的缺口：`xhigh` 在 Opus 4.6 / Sonnet 4.6 上没有
  （`max` 两者都有）。

### 2.3 范围内仍然分裂、必须处理的两条

- **`display` 默认值不统一**：Opus 4.6 / Sonnet 4.6 默认 `summarized`，
  4.7 / 4.8 / Opus 5 / Sonnet 5 / Fable 5 / Mythos 5 默认 `omitted`。
  → **必须显式发 `display: "summarized"`**，否则一半模型上拿不到文本。
- **`disabled` 仍不通用**：Fable 5 / Mythos 5 / Mythos Preview 无条件拒绝，
  Opus 5 在 xhigh/max 下拒绝。见 §5.6。

### 2.4 这一节的适用边界：官方端点，不含中继

上面全部核销**只对官方端点成立**。作者说"只用 4.6+"约束的是他自己的选择，
不是中继背后实际路由到什么。

在 `anthropic_compat` 上，`modelId` 是作者手填的自由文本 —— `lib/ai/modelLabel.ts`
今天解析的就是 `特价kiro | claude-opus-4-6-thinking`、
`claude-opus-4-6-thinking [特价 kiro]` 这类形态。**代次不可推断**，所以
§2.1 那句"adaptive 可以无条件发"在中继上不成立：中继可能front 的是 4.5，
那会 400。

处理办法见 §3 —— 这是本轮的第二个架构决定。

## 3. 方言字段：作者声明，探测兜底

### 3.1 为什么是配置而不是探测

[`provider-layering.md`](provider-layering.md) §2 的判断法第三问是"作者答不上来、
只能发个请求试？→ 探测维"。**这里的答案是"作者答得上来"**：他挑的中继、读过
中继的模型列表、买的就是 Claude Opus 4.6 的额度。不知道的是代码，不是人。

所以这是**配置层**的字段。探测不是替代方案，是兜底：

- **配置回答"作者知道的"**：这是哪种方言。第一次请求就能对，不必先失败一次。
- **探测/降级回答"作者猜错了"**：发出去 400 了，把结论记下来并指出该改哪个字段。

### 3.2 一个字段，不是一个 profile

核销之后（§2.1），4.6+ 与 4.5- 之间**真正互斥的只有一件事**：思考参数说哪种
方言。所以不需要具名的能力捆绑包，一个字段就够：

```ts
// lib/ai/configDb.ts → interface Model
/**
 * 这个模型接受哪种思考配置。中继上 modelId 是自由文本、代次不可推断，
 * 所以由作者声明 —— 他知道自己买的是什么，代码不知道。
 * 未设 = 按协议族的默认假设。
 */
thinkingDialect?: "adaptive" | "extended" | "none";
```

| 值 | 发什么 | 对应 |
| --- | --- | --- |
| `adaptive` | `thinking:{type:"adaptive", display:"summarized"}` + `output_config.effort` | Claude 4.6+ |
| `extended` | `thinking:{type:"enabled", budget_tokens:N}` | Claude 4.5 及更早 |
| `none` | 什么都不发 | 中继不支持思考 / 作者不想要 |

### 3.3 它跨族通用 —— 这是选这个形状的主要理由

Gemini 有**一模一样的分裂**：新代 `thinkingConfig.thinkingLevel` vs 2.5 代
`thinkingConfig.thinkingBudget`，同样无法从模型名可靠推断。同一个字段能同时
回答两族的问题。

这属于 [`provider-layering.md`](provider-layering.md) §5 私有扩展三分法里的
**"有跨族对应物"**那一类：抽象成本项目自己的语义，各 adapter 负责映射，作者
看到的是概念而不是某一家的字段名。

对照之下，"每族一个 profile 枚举"会把三族的产品文档抄进设置界面，正是 §5
明确要避免的形态。

### 3.4 默认值沿用 `ImageCaps` 的既有形态

`Model.caps` + `defaultImageCaps(standard)` 已经是"按协议族给默认、作者可覆盖"
的模式，`thinkingDialect` 照抄即可：未设时按协议族推导（Anthropic → `adaptive`，
因为那是我们声明的支持范围），作者显式设置时永远优先。

这也满足 [`provider-layering.md`](provider-layering.md) §6 偏离四给 L2→L3 继承
定的两条约束：继承值必须可被 L3 显式覆盖，且必须能区分"未设"与"继承来的"。

### 3.5 ④ 族兼容层的三处实测（MiniMax，2026-08）

MiniMax 的 `/anthropic/v1/messages` 是第二个 ④ 族兼容层样本（协议事实见
[`api/landscape.md`](api/landscape.md) §7）。逐条对照本实现：

| 它的差异 | 我们受影响吗 |
| --- | --- |
| 端点带 `/anthropic` 前缀 | ❌ `anthropicRoot` 只剥尾部的 `/v1` 与 `/messages`，作者填 `https://api.minimaxi.com/anthropic` 即可 |
| 不要求 `anthropic-version` | ❌ 我们照发；多一个头无害，少发在官方会挂 |
| 流式多一个 `ping` 事件 | ❌ `default: return` 已涵盖 |
| Bearer 与 `x-api-key` 都收 | ❌ `authModesFor` 的三档正好 |
| thinking 默认 `disabled` | ❌ 我们显式发 `adaptive`，正是需要的 |
| **`tool_choice` 只有 `auto`/`none`** | ⚠️ **见下** |
| 没有 `output_config` | ⚠️ 与 New API 相同，见 §3.6 |
| `thinking` 无 `display` 字段 | ⚠️ 我们发 `display:"summarized"`。透传则无害，严格校验则 400。未实测 |

**`tool_choice` 那条已经有兜底，不需要改代码。** `structured.ts` 的
`TOOL_CAPABILITY_ERROR` 第一条就是 `tool[_ ]?choice`，报错提到这个字段名即自动
退回 JSON 模式；`EMPTY_TOOL_CALL` 兜住"接受了但不返回调用"那种。

但这让一件事的性质变了：**"强制工具调用失败就退回 JSON 模式"从防御性设计变成
了必需品**。这条路径今后不能当作可有可无的兜底来维护 —— 它是 ④ 族兼容层上
结构化输出的唯一出路。

### 3.6 中继还可能吞掉 `output_config`

方言字段解决的是"发哪种 thinking 配置"。中继上还有第二个未知数：
**`effort` 能不能到达上游**。

New API 的 Anthropic 格式端点（见
[`api/landscape.md`](api/landscape.md) §7）请求体清单里有 `thinking`，
**但没有 `output_config`** —— 而 4.6+ 的 `effort` 就住在那里面。

不能据此判定它不支持：那份文档同样没画 `thinking` / `redacted_thinking` /
`signature` 这些任何 Claude 模型都会返回的 content block，明显不完整，而中继
通常透传未知字段。**结论是未知，需实测**（已加入 §7）。

对第 6 刀的影响：`supportsSeparateEffort` 若按协议族一刀切返回 true，在吞掉
`output_config` 的中继上会给出一个**按了没反应**的拨盘 —— 正是
[`reasoning-plan.md`](reasoning-plan.md) §7 当初拒绝的形态。所以第 6 刀落地时
要么依赖实测结论，要么让 `thinkingDialect` 顺带表达"这个端点认不认 effort"。
倾向前者：**先测，别急着给字段加维度。**

### 3.7 命名：不要叫 `profile`

`profile` 在本项目已经指**工作区 profile**（`.ai-writer/profile.json`：novel /
ttrpg / copy / weekly…，决定知识库分类、任务列表、【…】区块标签、系统提示词），
`src/lib/profile/`、`useTerms()`、`findTask()`、`profileSystemPrompt()` 全是它。

复用这个词会让每次读到都要先判断是哪一个。`thinkingDialect` 只是占位名，
要点是**避开 `profile`**。

## 4. 现状审计

### 4.1 `thinkingFor` 的三个前提，今天有两个是错的

`lib/ai/anthropic.ts` 目前唯一与思考相关的逻辑是：forced tool 时发
`thinking:{type:"disabled"}`，其余情况什么都不发。它的注释写了三条理由，
逐条对照今天的协议：

| 注释里的前提 | 今天 |
| --- | --- |
| "Current Claude models think by default when the field is omitted" | **只对一半模型成立。** Opus 5 / Sonnet 5 / Fable 5 / Mythos 5 默认思考；Opus 4.8 / 4.7 / 4.6 与 Sonnet 4.6 **默认关闭**，必须显式 `adaptive`（见 `api/reasoning.md` §1.2） |
| "extended thinking is incompatible with a forced tool_choice" | **只对手动模式成立。** adaptive 思考**支持**强制工具调用，官方明示 |
| 发 `disabled` 是安全的兜底 | **在部分模型上直接 400。** Fable 5 / Mythos 5 / Mythos Preview 无条件拒绝 `disabled`；Opus 5 在 `xhigh`/`max` effort 下也拒绝 |

**推论：这是一个潜在的硬故障。** 一致性检查 / lore 改进 / 条目拆分都走
`structured.ts` 的强制工具路径 → `thinkingFor` 发 `disabled` → 若作者配的是
Claude Fable 5 或 Mythos 5，**请求直接 400**。

而且大概率不会落进 `structured.ts` 的降级兜底：`TOOL_CAPABILITY_ERROR` 匹配的
是 `tool_choice` / `thinking mode` 等字样，而这个错误谈的是 `thinking.type`
不被支持，措辞未必命中。**未实测**，但两种结果都不好：命中就白白退成 JSON 模式，
不命中就是一个作者看不懂的报错。

### 4.2 thinking block 全部丢弃 → 工具循环静默失去思考

`anthropic.ts` 的流式解析明确丢弃 `thinking_delta` / `signature_delta`，理由
（注释原文）是"本 app 没有展示推理文本的界面，且 token 已计入 usage"。
第一条已经不成立了——[PR #128](https://github.com/Joycai/simple-ai-writer/pull/128)
做了展示界面。

后果不是报错，是**每一次带工具的 Claude 运行都在没有思考的情况下跑**：我们
从不回传 thinking block，API 于是判定历史与"思考启用"不兼容，静默关闭。

`reasoning-plan.md` §3.1 当时写的是"今天不出问题，是因为 forced tool 时禁用了
思考，而普通 agent 轮次里 thinking block 缺失暂时被服务端容忍"——**"容忍"这个
词现在有了准确含义：不是宽容，是降级。**

### 4.3 展示功能在 Claude 上会是空的

PR #128 的思维链展示对 ④ 族**完全无效**，两个原因叠加：

1. adapter 根本不解析 `thinking_delta`（§4.2）。
2. 即使解析了，当前一代模型的 `display` **默认是 `"omitted"`** —— `thinking`
   字段是空字符串，只有 `signature` 有值。不显式设 `display:"summarized"`
   就一个字也拿不到，但**照全额思考 token 计费**。

### 4.4 强度设置对 ④ 族无效（已知，非缺陷）

`lib/ai/reasoning.ts` 的 `reasoningBody` 对非 openai 族返回 undefined，
`supportsThinkingLevel` 也只认 openai 族，所以面板上的思考档位在 Claude 模型上
**整行不渲染**。这是 `reasoning-plan.md` §7 有意留的口子，不是 bug。

### 4.5 已经正确、不要动的

- **不发采样参数。** 当前一代 Claude 对非默认 `temperature`/`top_p`/`top_k`
  **无条件 400**（与是否思考无关）。本 app 从不发送，天然安全。
- **`max_tokens` 必填 + 兜底常量。** `DEFAULT_MAX_TOKENS = 8192`。
- **工具结果合并成一条 user 消息**、`tool_result`/`tool_use_id` 配对。

## 5. 范围收窄之后，还剩什么

§2 消掉了四个，§3 给了中继那部分一个出口。剩下的按"动手前必须先定"排序：

### 5.1 `DEFAULT_MAX_TOKENS = 8192` 必须提高

思考 token **计入 `max_tokens`**，而 `max_tokens` 是硬上限（effort 只是软引导）。
开启思考后，8k 要被思考和正文分。官方把这个症状单列为一条故障：
`stop_reason: "max_tokens"` 且正文被截断或缺失。

范围内全部支持 128k 输出，所以提高是安全的。**待定的是提到多少** ——
高兜底会让"作者没配 maxOutput"的情况下每次请求都预留很大空间，而
`lib/context/budget.ts` 正是拿 `maxOutput` 来做预算规划的。这不是一个孤立的
常量，改它会牵动上下文预算。

### 5.2 换模型必须剥离 thinking block —— 而本 app 允许中途换

thinking block 与产出它的模型绑定。换模型时必须剥掉此前回合的 `thinking` 与
`redacted_thinking`；不剥不会被拒绝，**但仍按输入 token 计费**。

范围内全是 keep-all 模型，**这让问题更严重而不是更轻**：block 会一直累积。
对话助手允许作者随时切换活动模型且历史持久化（`chatSession.ts`），所以一旦
开始回传，就必须同时实现"换模型即剥离"。

这要求历史里的 block 记住**是哪个模型产出的** —— `StreamMessage` 目前没有
这个信息。

### 5.3 `_reasoning` 的形状装不下 ④ 族

① 族那一轮定的是 `NativeReasoning { field, text }`——"收到什么字段名就用什么
名字还回去"。④ 族要回传的是**一个有序的 block 数组**（`thinking` 与
`redacted_thinking` 可能交错），其中 `redacted_thinking` 只有不透明的 `data`、
没有文本，且顺序与完整性受约束（重排或部分丢弃 → 400）。

倾向：**① 族保留有类型的 `_reasoning`，④ 族用不透明载体**，与 Gemini 的
`_geminiModelParts` 同类。三者并存意味着 `StreamMessage` 上有三个 `_` 字段，
这是 [`reasoning-plan.md`](reasoning-plan.md) §4.4 当初想避免的形态 ——
**需要重新确认这个取舍**。

### 5.4 展示：必须显式发 `display: "summarized"`

否则一半范围内模型返回空 `thinking` 字段。两个连带决定：

- `display` 是请求级参数，且**属于"我想不想看"** —— 按
  [`reasoning-plan.md`](reasoning-plan.md) §4.1 的既有结论，这类偏好进
  `lib/prefs.ts` 而不是 `Model`。但它同时影响**延迟**（omitted 时服务端跳过
  流式传输思考 token，正文更早开始）和**缓存**（thinking 配置是缓存前缀的一
  部分）。
- 无论怎么设都**照全额思考 token 计费**，`summarized` 省不了钱。而且摘要由
  另一个模型生成，**账单上的输出 token 数与看到的文本对不上是正常的** ——
  用量面板可能需要一句说明。

### 5.5 keep-all 与我们的压缩/裁剪逻辑

思考累积在上下文里并按输入计费。`trimHistory` 目前裁的是工具结果与图片；
`compactChatHistory` 折叠整轮。thinking block 会不会成为新的膨胀源、要不要
纳入裁剪，需要实测数据才好判断。官方提供了 `clear_thinking_20251015` 的
context-editing 策略作为逃生舱。

### 5.6 「关闭」档在 ④ 族上给不出承诺

Fable 5 / Mythos 5 / Mythos Preview 无条件拒绝 `disabled`；Opus 5 在 xhigh/max
下拒绝。而且官方明示 **Opus 5 关闭思考后会偶尔把工具调用当作纯文本吐出、或
在可见输出里混入内部 XML 标签**，并直接建议"重新开启思考，改用低 effort 控制
成本"。

倾向：**④ 族的「关闭」档不映射到 `thinking:{type:"disabled"}`，而是映射到
最低 effort**。理由是官方自己给的替代方案，且避免了三类 400。但这让"关闭"
在 ① 族和 ④ 族语义不同（前者真关，后者只是最省），**需要在 UI 文案上说清楚**。

## 6. 建议的切片

按"打坏东西的风险"排序：

1. ✅ **删掉 `thinkingFor` 的 `disabled` 兜底**（§4.1）。范围收窄后这是**删除
   而非替换**：adaptive 支持强制工具调用，所以那个兜底的存在理由消失了，而它
   本身在 Fable 5 / Mythos 5 上是硬 400。独立、小、可立即做。
2. ✅ **`thinkingDialect` 字段 + 模型抽屉的选择器**（§3）。纯数据 + UI，没有
   调用方，可单独合并。**必须排在第 3 刀之前** —— 否则中继上的 4.5 会吃到一个
   我们主动发出去的 `adaptive` 400，而作者没有任何地方可以纠正它。
3. ✅ **按方言发送思考配置**（§4.3 + §5.4），并同刀决定 `DEFAULT_MAX_TOKENS`
   （§5.1）。**这两件必须同刀**：只开思考不提上限，思考和正文抢那 8k，表现为
   正文被截断。
4. ✅ **解析 `thinking_delta` → `{reasoning}` chunk**（§4.2）。
   纯读侧加法，PR #128 的展示界面已经在等它。
5. ✅ **回传合规**（§5.2 + §5.3）。载体定为
   `_thinkingBlocks: {modelId, blocks}` —— 见 §9。
6. ✅ **强度映射 + 拨盘**（§4.4 + §5.6）。**结果与计划不同：做成了一个拨盘，
   不是两个。** 见 §8。

第 1–3 刀合起来是"让 Claude 真的开始思考"；第 4 刀让它可见；第 5 刀让它在工具
循环里不丢失；第 6 刀让作者能调。

六刀都落地了；剩下的是 §7 那几条只能靠真实请求定论的验证。

## 7. 落地时改掉的一个设计：一个拨盘，不是两个

[`reasoning-plan.md`](reasoning-plan.md) §7 与设计稿都规划了两个拨盘 ——
「思考」与「力度」，后者停用待 Anthropic 接入后点亮。实现时发现这是错的。

**没有任何端点把两者作为独立输入暴露出来。** OpenAI 族里它们塌缩成同一个
`reasoning_effort`；Anthropic 这边虽然 `thinking` 与 `output_config.effort` 是
两个字段，但前者只是开关（adaptive/disabled），**唯一的档位输入是 effort**，
而它同时管正文、工具调用和思考。

所以两个拨盘会是**两个控件写同一个值** —— 对作者是关于"我在调什么"的谎话。

改成：**一个拨盘，变的是标签**。`supportsSeparateEffort` 从"有没有第二个拨盘"
改成"这个端点上这一档管的是整个回复还是只管思考"，据此选词（「力度」/「思考」）
与说明文案。停用样式与相关 i18n key 一并删除。

这也让 §5.6 的取舍在 UI 上有了着落：Claude 上「关闭」档实际发的是最低 effort，
文案直说"等于最低档而非真正关掉"，不承诺协议不兑现的东西。

## 8. 需要实测才能定论的

- **不回传 thinking block 时，响应里还有没有 thinking block** —— 这是判断
  §4.2 那条"静默降级"是否正在发生的**唯一手段**，也是整份文档里最值得先测的
  一条：它决定第 5 刀的紧迫性。
- **`display:"summarized"` 在范围内各模型上返回的文本量**，以及与计费 token
  的差距。影响 §5.4 的用量面板说明。
- **`DEFAULT_MAX_TOKENS` 提高后对上下文预算的实际影响**（§5.1）——
  `lib/context/budget.ts` 拿 `maxOutput` 做规划，这个常量不是孤立的。
- **中继是否透传 `output_config`**（§3.5）。决定第 6 刀能不能在中继上兑现，
  也决定 `thinkingDialect` 要不要多一个维度。测法：对同一个中继模型分别发
  `effort: "low"` 与 `effort: "max"`，比较输出 token 量——透传了会有明显差异。
- **中继上 `adaptive` 被拒时的 400 措辞**是否会被 `structured.ts` 的
  `TOOL_CAPABILITY_ERROR` 误判成"不支持工具调用"、从而白白退成 JSON 模式。
  官方措辞是 `adaptive thinking is not supported on this model`，与那个正则的
  `(?:function|tool)s?[ _-]?calls?` 分支不匹配，**推断为不会误判**，但值得验 ——
  这条同时决定 §3.1 说的"探测兜底"要不要单独实现，还是复用既有的降级路径。

## 9. 回传载体：`_thinkingBlocks`，不是 `_native`

§5.3 当时倾向"④ 族用不透明载体"，并担心 `StreamMessage` 上会攒出三个 `_` 字段。
实现时选了具名而非泛化：

```ts
interface ThinkingBlockCarry { modelId: string; blocks: unknown[] }
```

三个理由：

1. **形状真的不同，不是同一件事的三种编码。** `_reasoning` 是"一段文本 + 它来自
   哪个字段名"，`_thinkingBlocks` 是"一个有序数组，其中某些成员只有不透明
   payload、且顺序不可改"。把它们塞进一个 `unknown` 里，唯一的收益是字段数从
   三降到一，代价是每个读者都要先做类型判别。
2. **`modelId` 是这个字段自己的需求**，不是通用需求。Gemini 的 thought
   signature 与 DeepSeek 的 `reasoning_content` 都没有"换模型必须剥离"这条
   规则 —— 泛化载体会把一个特例提升成所有人的负担。
3. **泛化 `_geminiModelParts` 要动一条正在工作的路径**，而这一刀本身已经是
   "最容易打坏 agent 循环"的那一刀。

真正需要泛化的地方是**剥离**，不是承载：`openai.ts` 的 `toWireMessages` 原本
逐个列出要丢弃的字段名，那是个"下一个协议加字段时会静默泄漏到线上"的形状，
已改为按 `_` 前缀丢弃。

### 9.1 换模型剥离怎么落的

`thinkingBlocksFor(msg, modelId)` 比对 carrier 上的 `modelId` 与当前请求的
模型：不同就整组丢掉。代价只有"换回来时前几轮的思考不再回传"，而那本就是
API 自己会做的事（它按模型决定保留策略）。
