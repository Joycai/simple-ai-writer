# Anthropic 族接入方案（调研与审计）

> **状态：调研完成，一行代码未动。** 本文是动手前的现状审计与取舍记录。
>
> 协议事实见 [`api/reasoning.md`](api/reasoning.md)、[`api/tools.md`](api/tools.md)、
> [`api/landscape.md`](api/landscape.md) §5 —— 本文只写"我们现在是什么样、
> 该怎么改、为什么"。分层裁决依据见
> [`provider-layering.md`](provider-layering.md)。
>
> 对照文档：[`reasoning-plan.md`](reasoning-plan.md) 是 OpenAI 族那一轮的同类
> 文档，已实现。本轮的目标是把同样的三件事（强度 / 思维链 / 回传）做到 ④ 族。
>
> **支持范围：Claude 4.6 及以上（§2）。** 这不是一句免责声明——它消掉了本轮
> 四个原本最难的问题，是读这份文档时最该先看的一节。

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
（§3.1）**是删除，不是替换**。它引发的 Fable 5 / Mythos 5 上的 400 一并消失。

**④ 输出上限统一到 128k。** 范围内全部支持 128k 输出；被排除的 Haiku 4.5 /
Sonnet 4.5 / Opus 4.5 才是 64k 的那批。`DEFAULT_MAX_TOKENS` 当前注释里
"猜高了会打断小模型"的顾虑**在这个范围内不成立**，§4.1 因此大为简化。

### 2.2 另外两条被范围拉平的

- **thinking block 保留策略统一为"保留全部历史回合"。** 范围内全部属于
  keep-all，不需要写 last-turn-only 的分支。代价是思考会累积在上下文里并按
  输入计费——与我们的压缩/裁剪逻辑相关（§4.5）。
- **`output_config.effort` 范围内全部支持。** 这意味着
  `supportsSeparateEffort` 第一次可以对 ④ 族返回 true ——**面板上那个停用的
  「力度」拨盘会亮起来**。唯一的缺口：`xhigh` 在 Opus 4.6 / Sonnet 4.6 上没有
  （`max` 两者都有）。

### 2.3 范围内仍然分裂、必须处理的两条

- **`display` 默认值不统一**：Opus 4.6 / Sonnet 4.6 默认 `summarized`，
  4.7 / 4.8 / Opus 5 / Sonnet 5 / Fable 5 / Mythos 5 默认 `omitted`。
  → **必须显式发 `display: "summarized"`**，否则一半模型上拿不到文本。
- **`disabled` 仍不通用**：Fable 5 / Mythos 5 / Mythos Preview 无条件拒绝，
  Opus 5 在 xhigh/max 下拒绝。见 §4.6。

## 3. 现状审计

### 3.1 `thinkingFor` 的三个前提，今天有两个是错的

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

### 3.2 thinking block 全部丢弃 → 工具循环静默失去思考

`anthropic.ts` 的流式解析明确丢弃 `thinking_delta` / `signature_delta`，理由
（注释原文）是"本 app 没有展示推理文本的界面，且 token 已计入 usage"。
第一条已经不成立了——[PR #128](https://github.com/Joycai/simple-ai-writer/pull/128)
做了展示界面。

后果不是报错，是**每一次带工具的 Claude 运行都在没有思考的情况下跑**：我们
从不回传 thinking block，API 于是判定历史与"思考启用"不兼容，静默关闭。

`reasoning-plan.md` §3.1 当时写的是"今天不出问题，是因为 forced tool 时禁用了
思考，而普通 agent 轮次里 thinking block 缺失暂时被服务端容忍"——**"容忍"这个
词现在有了准确含义：不是宽容，是降级。**

### 3.3 展示功能在 Claude 上会是空的

PR #128 的思维链展示对 ④ 族**完全无效**，两个原因叠加：

1. adapter 根本不解析 `thinking_delta`（§3.2）。
2. 即使解析了，当前一代模型的 `display` **默认是 `"omitted"`** —— `thinking`
   字段是空字符串，只有 `signature` 有值。不显式设 `display:"summarized"`
   就一个字也拿不到，但**照全额思考 token 计费**。

### 3.4 强度设置对 ④ 族无效（已知，非缺陷）

`lib/ai/reasoning.ts` 的 `reasoningBody` 对非 openai 族返回 undefined，
`supportsThinkingLevel` 也只认 openai 族，所以面板上的思考档位在 Claude 模型上
**整行不渲染**。这是 `reasoning-plan.md` §7 有意留的口子，不是 bug。

### 3.5 已经正确、不要动的

- **不发采样参数。** 当前一代 Claude 对非默认 `temperature`/`top_p`/`top_k`
  **无条件 400**（与是否思考无关）。本 app 从不发送，天然安全。
- **`max_tokens` 必填 + 兜底常量。** `DEFAULT_MAX_TOKENS = 8192`。
- **工具结果合并成一条 user 消息**、`tool_result`/`tool_use_id` 配对。

## 4. 范围收窄之后，还剩什么

§1.5 消掉了四个。剩下的按"动手前必须先定"排序：

### 4.1 `DEFAULT_MAX_TOKENS = 8192` 必须提高

思考 token **计入 `max_tokens`**，而 `max_tokens` 是硬上限（effort 只是软引导）。
开启思考后，8k 要被思考和正文分。官方把这个症状单列为一条故障：
`stop_reason: "max_tokens"` 且正文被截断或缺失。

范围内全部支持 128k 输出，所以提高是安全的。**待定的是提到多少** ——
高兜底会让"作者没配 maxOutput"的情况下每次请求都预留很大空间，而
`lib/context/budget.ts` 正是拿 `maxOutput` 来做预算规划的。这不是一个孤立的
常量，改它会牵动上下文预算。

### 4.2 换模型必须剥离 thinking block —— 而本 app 允许中途换

thinking block 与产出它的模型绑定。换模型时必须剥掉此前回合的 `thinking` 与
`redacted_thinking`；不剥不会被拒绝，**但仍按输入 token 计费**。

范围内全是 keep-all 模型，**这让问题更严重而不是更轻**：block 会一直累积。
对话助手允许作者随时切换活动模型且历史持久化（`chatSession.ts`），所以一旦
开始回传，就必须同时实现"换模型即剥离"。

这要求历史里的 block 记住**是哪个模型产出的** —— `StreamMessage` 目前没有
这个信息。

### 4.3 `_reasoning` 的形状装不下 ④ 族

① 族那一轮定的是 `NativeReasoning { field, text }`——"收到什么字段名就用什么
名字还回去"。④ 族要回传的是**一个有序的 block 数组**（`thinking` 与
`redacted_thinking` 可能交错），其中 `redacted_thinking` 只有不透明的 `data`、
没有文本，且顺序与完整性受约束（重排或部分丢弃 → 400）。

倾向：**① 族保留有类型的 `_reasoning`，④ 族用不透明载体**，与 Gemini 的
`_geminiModelParts` 同类。三者并存意味着 `StreamMessage` 上有三个 `_` 字段，
这是 [`reasoning-plan.md`](reasoning-plan.md) §4.4 当初想避免的形态 ——
**需要重新确认这个取舍**。

### 4.4 展示：必须显式发 `display: "summarized"`

否则一半范围内模型返回空 `thinking` 字段。两个连带决定：

- `display` 是请求级参数，且**属于"我想不想看"** —— 按
  [`reasoning-plan.md`](reasoning-plan.md) §4.1 的既有结论，这类偏好进
  `lib/prefs.ts` 而不是 `Model`。但它同时影响**延迟**（omitted 时服务端跳过
  流式传输思考 token，正文更早开始）和**缓存**（thinking 配置是缓存前缀的一
  部分）。
- 无论怎么设都**照全额思考 token 计费**，`summarized` 省不了钱。而且摘要由
  另一个模型生成，**账单上的输出 token 数与看到的文本对不上是正常的** ——
  用量面板可能需要一句说明。

### 4.5 keep-all 与我们的压缩/裁剪逻辑

思考累积在上下文里并按输入计费。`trimHistory` 目前裁的是工具结果与图片；
`compactChatHistory` 折叠整轮。thinking block 会不会成为新的膨胀源、要不要
纳入裁剪，需要实测数据才好判断。官方提供了 `clear_thinking_20251015` 的
context-editing 策略作为逃生舱。

### 4.6 「关闭」档在 ④ 族上给不出承诺

Fable 5 / Mythos 5 / Mythos Preview 无条件拒绝 `disabled`；Opus 5 在 xhigh/max
下拒绝。而且官方明示 **Opus 5 关闭思考后会偶尔把工具调用当作纯文本吐出、或
在可见输出里混入内部 XML 标签**，并直接建议"重新开启思考，改用低 effort 控制
成本"。

倾向：**④ 族的「关闭」档不映射到 `thinking:{type:"disabled"}`，而是映射到
最低 effort**。理由是官方自己给的替代方案，且避免了三类 400。但这让"关闭"
在 ① 族和 ④ 族语义不同（前者真关，后者只是最省），**需要在 UI 文案上说清楚**。

## 5. 建议的切片

按"打坏东西的风险"排序，交叉引用已按范围收窄后的节号更新：

1. ⬜ **删掉 `thinkingFor` 的 `disabled` 兜底**（§3.1）。范围收窄后这是**删除
   而非替换**：adaptive 支持强制工具调用，所以那个兜底的存在理由消失了，而它
   本身在 Fable 5 / Mythos 5 上是硬 400。独立、小、可立即做。
2. ⬜ **发 `thinking: {type:"adaptive", display:"summarized"}`**（§3.3 + §4.4）。
   范围内无条件安全（没有模型拒绝 adaptive），范围外的模型会得到一条措辞明确
   的 400。同时决定 `DEFAULT_MAX_TOKENS`（§4.1）——**这两件必须同刀**，否则
   开了思考却只有 8k 预算，表现为正文被截断。
3. ⬜ **解析 `thinking_delta` / `signature_delta` → `{reasoning}` chunk**（§3.2）。
   纯读侧加法，PR #128 的展示界面已经在等它。
4. ⬜ **回传合规**（§4.2 + §4.3）。**最容易打坏 agent 循环，必须单独一刀**，
   且要先定"换模型即剥离"与载体形状。
5. ⬜ **强度映射 + 面板双拨盘解禁**（§3.4 + §4.6）。这一步做完
   `supportsSeparateEffort` 第一次返回 true ——`output_config.effort` 正是设计稿
   里那个一直停用的「力度」拨盘。「关闭」档按 §4.6 映射到最低 effort 而非
   `disabled`。

第 1 刀与第 2 刀合起来是"让 Claude 真的开始思考"；第 3 刀让它可见；第 4 刀让
它在工具循环里不丢失；第 5 刀让作者能调。

## 6. 需要实测才能定论的

- **不回传 thinking block 时，响应里还有没有 thinking block** —— 这是判断
  §3.2 那条"静默降级"是否正在发生的**唯一手段**，也是整份文档里最值得先测的
  一条：它决定第 4 刀的紧迫性。
- **`display:"summarized"` 在范围内各模型上返回的文本量**，以及与计费 token
  的差距。影响 §4.4 的用量面板说明。
- **`DEFAULT_MAX_TOKENS` 提高后对上下文预算的实际影响**（§4.1）——
  `lib/context/budget.ts` 拿 `maxOutput` 做规划，这个常量不是孤立的。
- **范围外模型的 400 措辞**是否会被 `structured.ts` 的 `TOOL_CAPABILITY_ERROR`
  误判成"不支持工具调用"从而白白退成 JSON 模式。官方措辞是
  `adaptive thinking is not supported on this model`，与那个正则的
  `(?:function|tool)s?[ _-]?calls?` 分支不匹配，**推断为不会误判**，但值得验。
