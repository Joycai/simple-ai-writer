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
| `thinking` 无 `display` 字段 | ⚠️ 我们曾无条件发 `display:"summarized"`。透传则无害，严格校验则 400 |

> **这三条 ⚠️ 已在 §10 一起处理**（`switch` 方言）。下面两段是当时的判断，
> 保留以说明为什么后来改了主意。

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

汇总在 [`thinking-verification.md`](thinking-verification.md) §1.1 与 §2 ——
三族的实测项放在一处，因为它们只在同一次动手时才会被真正执行。**最要紧的一条**
是 §1.1：不回传 thinking block 时响应里还有没有 thinking block，那是判断
§4.2 那条"静默降级"是否正在发生的唯一手段。

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

## 10. MiniMax-M3 落地：`switch` 方言 + 服务端工具（2026-08）

§3.5 当时的结论是"三条 ⚠️ 不用改代码，靠兜底"。接 MiniMax-M3 时推翻了其中两条，
理由不是发现了新协议事实，而是**这三条差异属于同一个端点，且都能由作者已经知道
的一件事推出来**：他买的是 M3 的 `/anthropic` 端点。

### 10.1 三条差异，一次声明

新增 `thinkingDialect: "switch"`（`lib/ai/reasoning.ts`）。名字描述形状而不是
厂商 —— **这一档的含义是"思考参数是个纯开关"**：

| 官方 4.6+ | `switch` |
| --- | --- |
| `thinking: {type:"adaptive", display:"summarized"}` | `thinking: {type:"adaptive"}` |
| 深度住在 `output_config.effort` | **没有这个字段** |
| `thinking:{type:"disabled"}` 部分模型拒绝 | `disabled` 是文档里的合法值 |

由此三件事一起定下来：

1. **不发 `display`。** 文档没写的字段一律不发 —— 兼容层"忽略未知键"与"严格
   校验后 400"两种都常见（[`api/landscape.md`](api/landscape.md) §7），赌哪一种
   都不如不赌。代价：这个端点的思考文本能不能显示，取决于它自己的默认，未实测。
2. **不发 `output_config`。** §3.6 担心的"按了没反应的拨盘"在这里有了确定答案：
   这个端点确实没有该字段。于是「力度」在 `switch` 下只保留唯一还有意义的
   区分 —— `off` → `{type:"disabled"}`，其余一律 `{type:"adaptive"}`。**在这里
   `off` 是字面意义的关闭**，与官方端点上"`off` 映射成最低档"相反（§4.4、
   `ANTHROPIC_EFFORT` 的注释解释了官方为什么不能真关）。
3. **强制 `tool_choice` 自动降级为 `auto`。**

### 10.2 第 3 条是一处刻意的耦合，值得单独说

`tool_choice` 的枚举与"思考参数长什么样"没有任何逻辑关系。让思考方言决定它，
是**用一个作者答得上来的问题（"这是不是 M3 的 /anthropic 端点"）替换一个他答
不上来的问题（"你的端点支不支持强制单个工具"）**，而不是发现了什么因果。

接受这个耦合，因为错的代价是有界的：

- 降级**不会让任何东西失效**。唯一会强制工具的调用点是
  `agent/structured.ts`，它本来就把"模型没调工具"当作退回 JSON 模式的信号
  （`EMPTY_TOOL_CALL`）。降级最坏是让那条兜底早一轮触发。
- 不降级则是**必然多一次 400**：请求在生成任何 token 之前就被拒，然后走同一条
  兜底。省下的那次往返是这个改动的全部收益。
- 将来若出现"开关式思考但支持强制工具"的端点，症状是结构化任务偶尔走 JSON
  兜底 —— 可观测、不致命，届时再把它拆成独立字段。

**没有为它加第三个设置**：模型配置里每多一个作者必须理解的开关，就多一处配错
的可能，而这条的收益只是一次往返。

### 10.3 服务端工具：`serverTools`，per-model 声明

`web_search` 由服务端在同一次请求里跑完（协议事实见
[`api/landscape.md`](api/landscape.md) §7）。落在 `lib/ai/serverTools.ts`，
四个决定：

1. **不进 agent 注册表。** 注册表里的工具是"模型请求 → 我们执行 → 回传结果"，
   服务端工具没有中间那一步。更要紧的是**不能让它进工具循环**：给一次已完成的
   `server_tool_use` 回一条 `tool_result`，是协议错误。适配层因此把它单独收到
   一个 map 里，与 `toolBlocks` 完全分开。
2. **per-model，作者声明。** 同一个 base URL 后面 M3 有、M2.x 没有，而**没有任何
   探测能问出"你提供哪些服务端工具"**。与 `thinkingDialect` 同一条理由。
3. **一进一出都是 id，不是 wire type。** 存的是 `"web_search"`，
   `web_search_20250305` 只出现在 `ANTHROPIC_WIRE_TYPE` 一张表里 —— 厂商改版本
   日期时这是一处编辑，而不是每个模型行里一个永远不会更新的旧值。
4. **搜索结果不进历史。** 工具轮回传的 `_thinkingBlocks` 只带 thinking，不带
   `server_tool_use` / `web_search_tool_result`。两个理由：这些 block 每条命中都
   附带网页正文，是一次搜索响应里最大的东西，回传等于每轮重新计费；而模型自己的
   thinking（会回传）已经概括了它查到什么。代价是多轮循环里模型不能逐字引用上一轮
   的搜索原文 —— 接受，这是省钱的一侧。

**开关默认关闭，且在 UI 上说清它是什么**：打开它等于允许该模型在每次回答时自行
联网，本机既不参与也无法逐次批准（不同于 `propose_edit` 那种 L2 审批）。这是
作者的授权，不是程序该替他做的默认。

### 10.4 可观测性：搜索走执行日志

服务端工具在流里以两个 content block 到达（调用、结果）。适配层把它们变成
`StreamChunk` 的新分支 `{serverTool}`，`agent/events.ts` 的
`createServerToolLog()` 再把它折成一行 `tool-step` —— 于是它在执行日志里读起来
与本地工具一模一样：跑起来时显示 query，结束时显示命中标题。

分成"调用/结果"两个 phase 而不是等结束一次性上报，是因为**这正是响应变慢的原因
所在**：作者需要在等待时看到"它在搜什么"，而不是事后才知道搜过。

### 10.5 修正：turn 会中途停住 —— §10.3 漏掉的一条，且是静默的

§10.3 写"服务端工具没有中间那一步、调用方无事可做"。**这句话是错的**，代价是
第一次实测就撞上的那个现象：搜索全跑完、模型只写了一句开场白、然后没了，
没有任何报错。

#### 实测记录（2026-08-14，MiniMax-M3）

| | |
| --- | --- |
| `stop_reason` | **`end_turn`** |
| 输出文本 | 28 字：「好的，我来搜索这些策略和曲线术语的含义，然后补到文件里。」 |
| 搜索 | 8 次，全部成功，每次 10 条结果 |
| `toolCalls` | 无 |
| usage | 输入 123,436 / 输出 784 |

响应的**最后一个 content block 是 `web_search_tool_result`**，之后模型一个字
都没写。784 输出 token 几乎全花在思考与 8 条查询上。

**结论：MiniMax 的服务端循环把结果送回来了，但没有再叫一次模型去用它们。**
官方端点是在**一次请求内部**跑完「搜索 → 结果 → 模型接着写」的；这个 beta
实现只跑到「结果」就收工，那趟往返得由调用方补上。

#### 先前的错误推断，留在这里

第一版补丁按 `pause_turn` 实现 —— 官方 ④ 族确实有这个机制（协议事实见
[`api/tools.md`](api/tools.md) §6.1：turn 被挂起、必须把 assistant 消息原样
送回），症状描述也对得上，MiniMax 文档没写但"没列 ≠ 不支持"。

**推断错了**：日志里是 `end_turn`。但补丁的主体是对的 —— 需要的那趟往返一模
一样，错的只是触发条件。所以 `pause_turn` 的处理保留（官方端点上会用到），
另加一条判断。

#### 判断条件：「搜完之后模型还说话了吗」

```
unfinished = (stop_reason === "pause_turn") || !spokeSinceSearch
```

`spokeSinceSearch` 在每个 `*_tool_result` 块开始时置 false，在其后任何非空
`text_delta` 时置 true。**刻意不去看"最后一个 content block 是什么类型"**：
块要靠 `content_block_start` 才会被记下来，而一个不发该事件的流会因此被判成
"模型从未说话"，于是把一个已经完成的 turn 重发一遍并为之计费。写测试时正是
这条把一个原本会通过的用例照了出来。

范围很窄：搜索之后只要有一个字，就当作模型已经回答，不续跑。

#### 为什么放在适配层，而不是 agent runtime

一次续跑不是循环的一轮 —— 它没有工具要执行、没有决策要做、对调用方不可见，
就是**同一个回答被切成了两个 HTTP 请求**。放进 runtime 会让"轮"同时表示两种
东西；而且 runtime 的规则是"这一轮没有工具调用 = 模型给出了答案 = 结束运行"，
它在这里只会把那句开场白当成最终答案交出去。

于是适配层自己循环，调用方看到的仍是一段连续的流和**一个** `done`。

#### 三条实现约束

1. **未完成的 turn 整块回传，一个字段都不改。** `encrypted_content` 是服务端
   用来恢复模型上下文的密文，缺了或改了都是 400。所以存的是**原样 content
   block**，不是"我们认识的字段"重建出来的对象 —— 与 ③ 族 `thoughtSignature`
   同一条教训。
2. **用量必须跨请求累加，不能覆盖。** 每个请求各报各的运行总量，续跑的那个
   还**更贵**（把整个 turn 连同搜索结果重发一遍：实测首个请求就已经 123k
   输入）。写测试时发现实现是覆盖的 —— 那会让作者只看到最后一段的账单。
3. **续跑次数有上限**（`MAX_PAUSE_CONTINUATIONS = 4`）。撞上限不算错误：turn
   就停在那里，`done` 里带着当时的 `stopReason` 如实上报。

**已知代价**：一次搜索型问答现在至少两个请求，第二个携带全部搜索结果。这是
拿钱换"答案真的会出现"，没有更便宜的做法 —— 不回传结果，模型就没有东西可写。

### 10.6 顺带补上的两处

**`max_uses: 10`。** 服务端搜索不问就跑、按次计费、结果还按 input token 再计
一遍；实测那次一轮就发了八次。这是唯一的刹车。**这里刻意违反了"只发中继文档
写了的字段"那条规则**（§10.1 第 1 条）：那条规则防的是被校验字段拒掉，而这里
不发的代价是无上限开销 —— 两害相权，且它是同一个版本化工具对象上的官方字段，
能解析这个对象的中继就认得它。超限不是请求失败，是结果块里一个
`max_uses_exceeded` 错误码，模型读得到、会自己绕开。

**截断终于会说话了。** `done` 上新增 `stopReason`（只进 API 日志，不参与任何
分支 —— 上面那次定位就是靠它才半分钟结束的），而 runtime 此前**把 `truncated`
直接丢掉了** —— 于是 agent / 对话里一个被 `max_tokens` 截断的回答，和一个模型
自己写完的回答，在界面上一模一样。现在执行日志里会出现一行"输出被上限截断"。
这与 §10.5 是同一类缺陷（回答无声无息地停住），只是原因不同，所以两条都要能
被分辨出来。

### 10.7 再修正：原样回传被端点拒了，改送纯文本

§10.5 的补丁按协议规定实现 —— 把未完成的 assistant turn 原样送回。**MiniMax
拒收**：

```
400 invalid_request_error
invalid params, tool result's tool id(call_019ffefc181f7c61ae839314) not found (2013)
```

那个 id 不在调用方给的任何一条消息里（38 条消息、11 组工具调用全部配对完好，
且 id 前缀都更旧）—— 它是**服务端在本次请求里自己生成的 `server_tool_use` id**。
换句话说：它拒绝的是它自己刚发出来的块。

**推断的机制**：它的请求侧校验器把任何 `*_tool_result` 都当成**客户端**工具的
结果，去找同 id 的 `tool_use`；而 `server_tool_use` 按定义不是那个东西，于是
找不到。beta 阶段只教了响应侧、没教请求侧，是很典型的形态。

**于是这个端点上出现一个死结**：协议规定的续跑方式（原样回传）正是它唯一不接受
的形状。

#### 改法：把搜索结果渲染成纯文本

续跑消息改成两条普通消息：

| | 内容 |
| --- | --- |
| assistant | 模型这一轮自己写的那句开场白（为空时退化成"我已完成联网搜索。"—— 空 assistant 消息本身是 400） |
| user | 渲染后的搜索结果 + 一句"你只写了开场白，请基于这些继续" |

**两条而不是一条**：Anthropic 的角色交替是硬要求，而历史最后一条通常就是 user，
直接再追加一条 user 会 400。

纯文本没有任何依赖 —— 它就是普通消息，一个完全不懂服务端工具的校验器也挑不出
毛病。**代价是引用机制**：`encrypted_content` 与 `web_search_result_location`
只对签发它们的端点有意义，所以模型看到的是带网址的散文，而不是可引用的来源。
提示词里因此要求它直接给出网址。

#### 由此产生的一处反悔

§10.3 第 4 条写"搜索结果不进历史，因为每条命中都带网页正文、回传等于重新计费"。
**在这个端点上那条不成立**：模型压根没机会读这些结果，它们是"查到了什么"的唯一
副本，不带上就等于没搜。所以 `WebSearchResult` 现在保留 `content`，并有两道
预算闸：单条摘录 600 字、整份 12,000 字。

这条反悔是有边界的：**仍然不进 agent 循环的跨轮历史**，只进这一次续跑。

#### 两种续跑形状，按原因分

保留 `pause_turn` 的原样回传（官方端点这么规定，且它显然认得自己的块），
新增纯文本形状用于"停在结果上"。这不是一个 if 分支的权宜 —— **两种原因来自
两种端点，而它们对"能收回什么"的回答不同**，所以形状本来就该不同。

#### 教训

三次修正踩的是同一件事的三层：

1. §10.3 —— 以为服务端工具没有后续，**漏了整个续跑**；
2. §10.5 —— 以为续跑由 `pause_turn` 触发，**触发条件错了**（实际是 `end_turn`）；
3. §10.7 —— 以为续跑按协议原样回传，**形状也被拒了**。

每一层都是"照着官方协议推断兼容层"，每一层都对了一半。
[`api/landscape.md`](api/landscape.md) 那条"不能把兼容层文档当能力清单"应当
再加一句对称的：**也不能把官方文档当兼容层的行为说明书**。而这三层没有一层是
单元测试能发现的 —— 全靠 API 日志里那一行真实报文。

### 10.8 续跑跑起来了，但模型只报计划不写正文

§10.7 之后不再 400，续跑链路是通的。实测（三条腿、16 次搜索、79 秒）却拿到 69
个字，**全是预告**：

> 「我先把文档里的关键术语分批检索，再追加到文档末尾。」
> →「继续追加搜索下一批术语。」
> →「继续搜索下一批术语（趋势/震荡指标、机器学习方法、利率平价等）。」

一次写入工具都没调，正文一个字都没有。

#### 先排除掉「上下文爆了」

这是最直觉的怀疑，但日志否掉了它：三条腿的请求体是 23,151 / 23,324 / 23,484
字节 —— **几乎不增长**，§10.7 的两道截断闸在起作用。`usage` 里的 102,819 输入
是三次请求的**总和**（§10.5 第 2 条改成累加的），且大头是 MiniMax 把它自己内部
注入的搜索结果计入 input，不是我们发的消息。单次请求离窗口上限很远。

**这条值得记住的地方在于：`usage` 改成累加之后，它不再能直接当作"单次请求有多
大"来读。** 判断上下文压力要看 `request-body` 那条日志的实际字节数。

#### 真正的原因是提示词

续跑消息原本写的是「请基于它们继续完成上一条回复」。模型自己的计划是"分批检索
→ 追加到文档"，于是它把这句读成"继续执行你的计划"，就去搜下一批了 —— 每一条腿
都如此，直到它认为自己已经交代完毕（最后一条腿在搜索**之后**说了话，
`spokeSinceSearch` 为真，于是我们停止续跑，runtime 看到"有文本、无工具调用"
就结束了整轮）。

**模型的行为是自洽的，错的是我们给的指令。**

改成两段式，并把"这是最后一次"明说：

| | 说什么 |
| --- | --- |
| 普通续跑 | **先把这一批的正文写出来**（或用工具写入文档），写完之后如果还有没查的再搜下一批。明确指出"不要再用一整轮去说接下来要搜什么：那等于什么都没产出" |
| 最后一条腿 | **不要再发起任何检索**，用现有资料收尾；没覆盖到的如实说明 |

第二条抄的是 runtime 已有的 `roundCapReached` 形态（最后一轮撤掉工具并要求出
文本）—— 同一个问题的同一个解法：**一个以为自己还有下一次机会的模型，会把这
一次用来安排下一次。**

这同时就是"分批输出"：每一批先落到文档里再检索下一批，进度是持久的，而不是攒
到最后一次性产出（那一次永远不会到来）。

#### 顺带：续跑不再是隐形的

一次 `streamCompletion` 变成多次 HTTP 请求，此前在界面上完全看不出来 —— 作者
只看到一轮跑了 79 秒、花了几倍的钱。现在每条腿都在执行日志里有一行，最后一条
腿标注"本轮最后一次"。

**这是本轮反复吃亏的那件事的第三次补课**（前两次是 §10.6 的 `stopReason` 与
执行日志里的截断行）：**这个端点上，"什么都没发生"和"发生了很多但你看不见"是
同一种画面。**

### 10.9 两条兜底：作者的话不要混进工具结果，服务端工具要服从收尾轮

§10.8 之后又一次实测（39 轮、一个不肯收尾的 agent）暴露的两件事。都不是
MiniMax 的问题，是本项目自己的形状问题 —— 只是服务端搜索把它们放大到看得见。

#### 一、`role:"user"` 承载了两种东西

Anthropic 把工具结果放进 `role:"user"` 消息，而作者自己的发言也是这个角色，
再加上相邻同角色必须合并（[`api/tools.md`](api/tools.md) §2 第三点），于是：

**一次中途死掉的工具轮**（结果已追加、assistant 还没来得及说话）**后面跟着作者
敲的任何一句话，都会被并进同一条消息**。实测拿到的是：

```jsonc
{ "role": "user", "content": [
    { "type": "tool_result", "tool_use_id": "…", "content": "<read_file 的返回>" },
    { "type": "text", "text": "continue" },
    { "type": "text", "text": "retry" },
    { "type": "text", "text": "重试" } ] }
```

那三个词是作者在**上午那几次坏掉的运行**里敲的，意思是"这次跑挂了，重来"。它们
指向的失败早已不在历史里，而这三个词留在会话里、**之后每一轮都重发**——39 轮
之后，模型自己的思考里出现了 *"given the user's continued requests"* 与 *"The
user wants me to keep going"*。**它不是在幻想，是在如实转述历史。**

放大器是思考回传：同一份请求体里有 32 个 `thinking` 块，模型上一轮得出的"用户
要我继续"，下一轮作为既成事实再喂给它自己，而历史里没有任何东西反驳它。

**改法**：合并时，若目标消息里已经有 `tool_result`，被并进来的作者文本前面加一个
【作者消息】标签。协议不允许"不合并"（相邻同角色会被拒），而伪造一条空 assistant
把它们隔开等于替模型说了它没说过的话 —— 两条都不做。

**这个标签不会让过期的话变新鲜，只是让它可归属**，那是这一层能诚实做到的部分。
用 【…】 是因为本项目所有注入段落本来就是这个记号，模型会把它读成结构而不是
作者敲的字。普通的两条连续作者消息合并时不加标签，行为与以前完全一致。

#### 二、`serverTools` 绕过了 `withholdTools`

force-text 的收尾轮会撤掉工具、要求模型直接写答案。但服务端工具来自**模型配置**
（`ConnOptions`）而不是 preset，于是它从那道检查旁边直接走过去了。实测该轮的
请求体：

```
ntools: 1, has web_search: true, tool_choice: none
```

**那一轮唯一的目的就是"别再调工具了，把答案写出来"，手里却还攥着一把搜索工具**
—— 而它一旦在那轮搜了，§10.5 的续跑循环又会接着跑，整轮的收尾语义作废。

同一个标志也覆盖 `tools: []` 的单发 preset（结构化 JSON 任务），那里同样不该联网。
`agent/structured.ts` 一并显式清掉 —— 它的文件头写着"structured tasks don't
browse"，`serverTools` 恰好把这条写下来的不变量破坏了。

#### 教训：一个模型级的权限，会绕过所有任务级的闸

`serverTools` 是"作者授予这个模型的常驻权限"，而 `withholdTools` 是"这一次请求
不许用工具"。两者住在不同的层，于是前者默认赢。**下一个模型级开关落地时，第一件
要问的事就是它会不会同样绕过任务级的约束。**

### 10.10 官方端点确认：同一张表，零代码改动（2026-08）

给 MiniMax 接完 `web_search` 后回头核对了官方端点，结论有两条。

**一、官方确实有同一能力，而且现有实现已经覆盖它。**
`web_search_20250305` 在 api.anthropic.com 上是 GA 工具，不需要任何
`anthropic-beta` header（协议事实记在 [`api/tools.md`](api/tools.md) §6.1）——
MiniMax 的声明格式本就是照抄官方的。核对逐层成立：

- `supportsServerTools()` 当初刻意按**整个 anthropic 协议族**判断而不限于
  `anthropic_compat`（§10.3），所以官方供应商下的模型现在就能勾选 `web_search`，
  不需要新开关；
- 发出去的 `{type:"web_search_20250305", name:"web_search", max_uses:10}` 与
  官方声明一字不差，`max_uses` 在官方是文档明列的字段（在 MiniMax 才是赌注，
  §10.6）；
- 响应侧的 `server_tool_use` / `*_tool_result` 解析、以及 `pause_turn` 的
  verbatim 续跑（整块原样回传、`encrypted_content` 不动）**本来就是按官方行为
  写的** —— MiniMax 走的才是 §10.7 的纯文本降级路径。官方端点预期走正路。

所以这次的"接入"没有一行 TS：只把 UI 提示（`aiConfig.models.serverToolsHint`
两个语言）从"只有 MiniMax 提供"改成"Anthropic 协议族端点均生效（官方 GA /
MiniMax Beta）"。

**二、wire type 维持 `web_search_20250305`，不升 `_20260209`。**
官方对新款模型（Opus 4.6+ / Sonnet 4.6+ / Sonnet 5 / Opus 5）另有
`web_search_20260209`（动态过滤版），但基础版全模型可用、且与 MiniMax 共用同
一条路径；新版则要求**按模型型号选版本**，而本项目对模型一无所知、无法探测
（与 §10.3"由作者按模型声明"同一处境）。要支持它，正确形态大概率是把
`ANTHROPIC_WIRE_TYPE` 的值也变成作者可选的声明，而不是适配层猜型号 —— 等有真实
需求再做。`web_fetch` 同理未纳入 `ServerToolId`。

**三、未经真机验证。** 以上"预期走正路"仍是推断：官方端点的
`pause_turn` → verbatim 续跑、`encrypted_content` 回传被接受、
`usage.server_tool_use.web_search_requests` 是否存在，都没有对 api.anthropic.com
实测过。验证项在 [`thinking-verification.md`](thinking-verification.md) §2.7。
