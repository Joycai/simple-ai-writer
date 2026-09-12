# 用 API 回报的 token 数校准估算器 · 方案

> 状态：`partial` · 2026-09-08 起草。作者按建议定了 §4：**只改显示**、(协议族, 模型 id) 粒度、prefs 里滚动中位数。**S1 已落地**（见 §5 表），S2 等真机跑几轮攒出偏差再动。
>
> 起因：作者问「计量条的上下文占用是准的吗」，答案是**结构对、数值估**——`estimateTextTokens` 是一把启发式尺子（CJK 一字 1 token，其余 4 字符 1 token，图片一口价 800），从来没有和任何真实数字对过账。而应用里**两个数都有**：条上的估算，和 API 回来的真实 token 数。缺的只是把它们对一下。

## 1. 好消息：四家的 usage 结构**已经归一了**

作者担心的「不同端点 tokens 结构不一样，可能得都处理一下」——这件事早就做完了，四个协议族各自在自己的客户端里折成同一个 `Usage { inputTokens, outputTokens, cachedTokens }`：

| 协议族 | 字段 | 折算 |
|---|---|---|
| OpenAI Chat | `usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` | 直取；cached 是 prompt 的**子集** |
| OpenAI Responses | `usage.input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens` | 同上 |
| Gemini | `usageMetadata.promptTokenCount` / `candidatesTokenCount` + `thoughtsTokenCount` / `cachedContentTokenCount` | thinking 计入**输出**；cached 是子集 |
| Anthropic | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | 三个桶**不相交**，`readUsage` 求和才可比（[anthropic.ts:404](../../../src/lib/ai/anthropic.ts) 有整段说明） |

所以校准不需要碰任何一个客户端。`inputTokens` 在四家上都已经是「这一次请求服务端数出来的整个 prompt」，和我们的估算是同一个东西的两种数法。

## 2. 坏消息：现在存下来的那个数**不能用**

`token_usage` 表存的是**一次运行的总和**（[agentStore.ts:2825](../../../src/stores/agentStore.ts)，`runAgent` 返回的 `totalInputTokens` 是各轮相加）。一次 agent 运行有 N 轮，每轮的 prompt 都比上一轮长，N 轮之和跟任何一个单独的估算都不可比。

**唯一正确的配对点是「轮」**，而它已经在代码里挨着了：

- 发出前：[runtime.ts:728](../../../src/lib/agent/runtime.ts) 发 `round-start`，带 `estInputTokens`（消息）和 `toolTokens`（schema）；
- 收到后：同一轮的 `"done"` chunk 带 `chunk.inputTokens`（[runtime.ts:822](../../../src/lib/agent/runtime.ts)）。

两者相隔几十行，中间就是那一次 `streamCompletion`。取样点在这里，别处都不对。

## 3. 会污染样本的四种情况（必须排除）

1. **服务端工具**。`web_search` 之类在服务端执行，检索结果由服务端塞进 prompt 再计费——那部分 token 我们从来没发过，也没法估。开了 `serverTools` 的轮**整轮丢弃**。
2. **中转不回 usage**。部分中转返回 0 或干脆没有 usage 字段，`?? 0` 之后是个 0。`inputTokens <= 0` 一律丢弃，不能当成「估高了」。
3. **图片**。估算按 800 一口价，各家实际按分块算，能差好几倍。带图片的轮**单独归一类**，不进文字系数。
4. **手交接那一轮**（`forceHandoff`）和**withholdTools 那一轮**：工具集不是常规的那套，`toolTokens` 已经特判过，样本本身没问题，但要跟着 `toolTokens` 一起算，不能只比消息。

排除之后，一条样本 = `{ 协议族, 模型 id, est = estInputTokens + toolTokens, actual = chunk.inputTokens }`。

## 4. 三个要作者定的选择

### 4.1 系数用在哪（**最重要**）

| 选项 | 效果 | 风险 |
|---|---|---|
| **A. 只改显示**（推荐） | 计量条、执行日志、预估条上的数字乘以系数 | 无。budget / 触发线 / 预检门全部不动，行为一字不变 |
| B. 显示 + 预算 | `trimHistory`、`planFold`、预检门也用校准后的数 | 系数 > 1 时更安全（更早裁剪）；**系数 < 1 时更危险**——它会放大有效上限，把「其实会超窗」的请求放出去。而 4.3 的样本天然偏向 < 1（见下） |
| C. 只改预算不改显示 | —— | 不考虑：作者看到的数和系统用的数不一致，是这一稿最不该做的事 |

建议 **A**，并且把 B 留成一个后续开关：先让系数在界面上跑几周，作者能看见它稳定在多少，再决定要不要让它管预算。

### 4.2 系数的粒度

- **按模型 id**：最准，但一个新模型头几轮没有样本；
- **按协议族**：样本攒得快，但 GPT 和某个中转上的 Qwen 共用一个系数，意义不大；
- **按 (协议族, 模型 id)，回退到协议族，再回退到 1.0**（推荐）：新模型先用同族的经验值，攒够 N 条自己的样本再切过去。

### 4.3 存在哪 · 攒多少

样本是**可重建的运行时数据**，不值得为它开一张迁移表（作者一贯的取舍：宁可丢历史数据 + 给个重建按钮）。建议：

- 存在 `prefs` 里一份 `{ [modelId]: { n, ratioSum } }` 的滚动值，只留**最近 50 条**的滑动平均；
- **中位数而不是均值**（单条离谱样本不该拽动系数）；
- 系数**夹在 [0.6, 1.8]**——超出这个范围说明取样点错了，而不是尺子偏了；
- 少于 **10 条**样本时不启用，显示原始估算。

预判一下方向：`estimateToolsTokens` 把 JSON schema 按「4 字符 1 token」算，而大括号、引号、下划线密集的文本实际 token **更多**，所以 9468 大概率是**低估**，系数会 > 1；中文正文那一半反而可能略高估。两者抵消到什么程度，只有样本说了算——这正是要做这件事的原因。

## 5. 切片

| # | 内容 | 能验什么 |
|---|---|---|
| **S1** ✅ | 新增 `round-done` 事件带 `actualInputTokens` + `incomparable`；执行日志的轮标题在 token 数后面加一段「+7%」，悬停给「端点实计 10,140（估 9,468，差 +7%）」 | 立刻能看见偏差，且**零行为改动**。这一片本身就有价值，即使后面几片不做 |
| **S2** | 采样 + 排除规则（§3）+ 滚动中位数落进 prefs；设置 → 上下文与记忆 加一行只读的「估算校准 · 已采 42 条 · ×1.07」，带一个「清空重采」 | 系数稳不稳，看几天就知道 |
| **S3** | 把系数用到显示层（§4.1 的 A）：计量条、预估条、执行日志 | 条上的数和真实值对得上了 |
| **S4**（可选，等 S2 的数据） | 开关式地让系数进预算层（选项 B），默认关 | —— |

每片一个 PR，合完停下来等作者在真机上跑几轮。

## 6. 不做的事

- **不引入真分词器**。`tiktoken` / `@anthropic-ai/tokenizer` 各家一个、几 MB 起步，而且中转背后到底是哪个模型根本不可知——校准系数是比它更诚实的解法。
- **不改任何客户端的 usage 解析**。§1 已经归一，动它只会把四家好不容易对齐的语义弄乱。
- **不给 `token_usage` 加列**。那张表记的是钱，粒度是运行；校准要的是轮，两件事不该挤一张表。

## 7. S1 落地记录（2026-09-08）

- 事件在 `"done"` chunk 处发出（[runtime.ts](../../../src/lib/agent/runtime.ts)），因为那是唯一同时握着「我们组装的请求」和「端点数出来的数」的地方。§3 的排除也在这里判——换个地方只能靠猜。
- `incomparable` 三种取值都由运行时定：`no-usage`（`inputTokens <= 0`）、`server-tools`（本轮真的**跑过**服务端工具，不是「提供了」——只提供不用不进 prompt，把那些样本扔掉会白白丢掉搜索模型的大半轮次）、`images`（`history.some(hasImageParts)`）。
- 日志里，被标了 `incomparable` 的轮**只显示估算，不画差值**——一个应用自己都不敢担保的偏差数，比没有更糟。同样地，还在飞的轮、以及这个事件存在之前落盘的旧日志，也都只显示估算。
- 事件**折进它所描述的那一轮的标题**，不占一行：它不是轮里发生的事，它描述这一轮。恢复过的会话可能有两个「第 1 轮」，从后往前匹配。
- `sumTokens` 只读 `run-done`，不会重复计数。

**S2 之前要先攒数据**：等作者真机上跑一阵，看那个百分比在各家端点上稳不稳、方向是不是如 §4.3 预判的偏正。
