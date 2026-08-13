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

## 1. 一句话结论

**Anthropic 族的三件事全都没做，而且失败方式与 OpenAI 族相反：不会报错。**

OpenAI 族那一轮修的是"DeepSeek 推理模型在工具循环里必然 400"——一个响亮的
故障。④ 族对应的问题是**静默降级**：不回传 thinking block，API 不报错，只是
悄悄关掉思考。所以这里没有任何现象会逼我们去修，只能靠对照文档发现。

## 2. 现状审计

### 2.1 `thinkingFor` 的三个前提，今天有两个是错的

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

### 2.2 thinking block 全部丢弃 → 工具循环静默失去思考

`anthropic.ts` 的流式解析明确丢弃 `thinking_delta` / `signature_delta`，理由
（注释原文）是"本 app 没有展示推理文本的界面，且 token 已计入 usage"。
第一条已经不成立了——[PR #128](https://github.com/Joycai/simple-ai-writer/pull/128)
做了展示界面。

后果不是报错，是**每一次带工具的 Claude 运行都在没有思考的情况下跑**：我们
从不回传 thinking block，API 于是判定历史与"思考启用"不兼容，静默关闭。

`reasoning-plan.md` §3.1 当时写的是"今天不出问题，是因为 forced tool 时禁用了
思考，而普通 agent 轮次里 thinking block 缺失暂时被服务端容忍"——**"容忍"这个
词现在有了准确含义：不是宽容，是降级。**

### 2.3 展示功能在 Claude 上会是空的

PR #128 的思维链展示对 ④ 族**完全无效**，两个原因叠加：

1. adapter 根本不解析 `thinking_delta`（§2.2）。
2. 即使解析了，当前一代模型的 `display` **默认是 `"omitted"`** —— `thinking`
   字段是空字符串，只有 `signature` 有值。不显式设 `display:"summarized"`
   就一个字也拿不到，但**照全额思考 token 计费**。

### 2.4 强度设置对 ④ 族无效（已知，非缺陷）

`lib/ai/reasoning.ts` 的 `reasoningBody` 对非 openai 族返回 undefined，
`supportsThinkingLevel` 也只认 openai 族，所以面板上的思考档位在 Claude 模型上
**整行不渲染**。这是 `reasoning-plan.md` §7 有意留的口子，不是 bug。

### 2.5 已经正确、不要动的

- **不发采样参数。** 当前一代 Claude 对非默认 `temperature`/`top_p`/`top_k`
  **无条件 400**（与是否思考无关）。本 app 从不发送，天然安全。
- **`max_tokens` 必填 + 兜底常量。** `DEFAULT_MAX_TOKENS = 8192`。
- **工具结果合并成一条 user 消息**、`tool_result`/`tool_use_id` 配对。

## 3. 待决的四个问题

### 3.1 `max_tokens` 兜底值与思考的冲突

思考 token **计入 `max_tokens`**，且 `max_tokens` 是硬上限（effort 只是软引导）。
一旦开启思考，8192 的兜底意味着思考和正文共用这 8k —— 深度思考会把正文挤掉，
表现为 `stop_reason: "max_tokens"` 的截断。

官方对高 effort 的建议是"从 64k 起步"。所以**开启思考这件事不能单独做**，必须
同时决定兜底值。倾向：思考开启时把兜底提到一个高得多的值，但要先确认小模型的
输出上限（超过模型自身 cap 本身就是 400）。

### 3.2 换模型时必须剥掉 thinking block —— 而本 app 允许中途换

thinking block 与产出它的模型绑定。官方要求换模型时剥掉此前回合的 `thinking`
与 `redacted_thinking`；不剥不会被拒绝，**但仍按输入 token 计费**。

本 app 的对话助手允许作者随时切换活动模型，且历史是持久化的
（`chatSession.ts`）。所以一旦开始回传 thinking block，**必须同时实现"换模型
即剥离"**，否则换到别家模型后每一轮都在为一堆被忽略的 block 付钱。

这也意味着历史里的 thinking block 需要记住**是哪个模型产出的**——目前
`StreamMessage` 没有这个信息。

### 3.3 `_reasoning` 的形状够不够用

OpenAI 族那一轮定的是 `NativeReasoning { field, text }` ——"收到什么字段名就用
什么名字还回去"。④ 族装不进这个形状：

- 它要回传的是**一个 block 数组**（可能多个 `thinking` + `redacted_thinking`
  交错），不是一个字符串。
- `redacted_thinking` 只有不透明的 `data`，没有文本。
- 顺序与完整性都受约束（重排/部分丢弃 → 400）。

所以 ④ 族大概率要回到原计划的**不透明载体**（`reasoning-plan.md` §4.4 当初
考虑过的 `_native`），而 ① 族保留有类型的 `_reasoning`。**两者并存是否可接受，
是本轮最主要的架构决定。**

### 3.4 `thinkingFor` 该换成什么

`disabled` 不能再无条件当兜底用。候选：

- **什么都不发**（最保守，与"默认不发"的既有原则一致）：但对 Opus 4.8/4.6 这
  一派意味着思考始终关着——而那正是我们想开的。
- **发 `adaptive`**：解锁 forced tool + 思考共存，但对只支持手动模式的旧模型
  是 400（`type:"adaptive"` 在那些模型上返回 400）。
- **按模型代次分支**：模型名在 compat 端点上是自由文本，`provider-layering.md`
  §2.1 坑 3 已经论证过不可靠。

倾向：**沿用 ① 族那一套** —— 默认什么都不发，由作者在模型上显式选择，配一次
400 降级重试识别"这个模型不认这套写法"。但这要等 §3.1 的 `max_tokens` 决定先落。

## 4. 建议的切片

与 ① 族那一轮同样按"打坏东西的风险"排序：

1. ⬜ **修 `thinkingFor` 的潜在 400**（§2.1）。独立、小、可立即做——当前的
   `disabled` 兜底在两类模型上是硬故障。
2. ⬜ **解析 `thinking_delta` / `signature_delta`，接上 `{reasoning}` chunk**
   （§2.2 + §2.3）。纯读侧，加法；需同时决定是否发 `display:"summarized"`。
3. ⬜ **回传合规**（§3.2 + §3.3）。**最容易打坏 agent 循环，必须单独一刀**，
   且要先解决"换模型即剥离"与载体形状两个前置问题。
4. ⬜ **强度映射 + 面板控件解禁**（§2.4 + §3.1 + §3.4）。依赖 `max_tokens`
   决定。这一步做完，`supportsSeparateEffort` 才会第一次返回 true ——
   `output_config.effort` 正是那个"独立于思考档位的 effort 拨盘"。

## 5. 需要实测才能定论的

与 ① 族一样，列出来免得被当成已知：

- **Fable 5 / Mythos 5 上强制工具调用是否真的 400**（§2.1），以及错误措辞是否
  命中 `structured.ts` 的降级判据。
- **不回传 thinking block 时，响应里到底还有没有 thinking block** —— 这是判断
  "是否已被静默降级"的唯一手段，也是验证 §2.2 结论的直接方法。
- **`display:"summarized"` 在哪些模型上真的返回文本**，以及摘要与计费 token
  的差距有多大。
