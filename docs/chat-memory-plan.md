# 对话助手记忆系统方案（chat context compaction）

> 目标：把对话助手的上下文管理从「只挖不补」升级为**分层记忆**——
> 稳定前缀（system + 工具定义）→ 历史摘要 → 最近轮次逐字 → 本轮注入 → 用户问题。
> 长会话不再走向 `ContextSizeError` 死局，被淘汰的轮次归纳成摘要而不是蒸发。
>
> 现状与问题盘点见 §1；本方案只动 chat（agentStore.sendChat 一条链路），
> AiPanel 任务与 lore modal 的单次运行不受影响。

## 1. 现状与问题

今天的链路（`stores/agentStore.ts` sendChat）：

- 首轮 `assembleContext` → `bundleToMessages`，把设定/前情/正文窗口**和第一个
  问题拼成一条 user 消息**；之后每轮只 `history.push({role:"user"})`。
- 唯一的长度控制是 `trimHistory`（`lib/agent/runtime.ts`）：超过
  `inputCeilingTokens` 时把最老的 `role:"tool"` 结果换成占位符。用户消息、
  助手正文一律不碰。

三个后果：

1. **检索只发生一次**。作者中途换文档、换话题，注入的还是开场那批设定，
   新材料只能靠模型自己调工具。
2. **首轮上下文是永久占用**。它和第一个问题焊在同一条消息里，`trimHistory`
   够不着（只认 `role:"tool"`），无法单独淘汰。
3. **挖无可挖之后是死局**。tool 结果全部挖空仍超窗时，`ai/index.ts` 的
   pre-flight 抛 `ContextSizeError`，此后每次发送都撞同一堵墙，作者唯一出路
   是 `resetChat` 清空全部历史。

## 2. 目标消息结构

```
[system]    写作提示词 + agent briefing                     ── 稳定，从不改写
(tools)     工具定义（请求字段，占 token、占缓存前缀）          ── 稳定
[user] ①    【历史摘要】被折叠轮次的滚动归纳                   ── 仅压缩时改写
[…turns…]   最近 K 轮逐字：user / assistant / tool 配对原样    ── 只追加
[user] ②    【本轮注入】新命中的设定、切换后的文档窗口（可选）    ── 每轮按需追加
[user]      用户问题（+选区 +@引用，即现有 wireMessage）        ── 追加
```

按易变程度从上到下排。两条硬约束决定了结构里什么**不能**动：

- **tool 结果位置被协议钉死**。`role:"tool"` 必须紧跟发出 `tool_calls` 的
  assistant 消息、`tool_call_id` 配对，OpenAI/Gemini 都会拒绝乱序。所以
  工具结果永远留在它发生的那一轮里，跟整轮一起折叠——绝不单独搬运。
- **prompt cache 命中的是未变前缀**。中段任何一处改写都作废其后全部缓存。
  因此摘要消息①只在压缩时刻改写（一次性代价），本轮注入②只在**尾部追加**、
  绝不回头替换旧注入块。

## 3. 会话历史的记账

`chatHistory` 保持 `StreamMessage[]` 平铺不变（runtime 零改动），agentStore
另记**轮边界**：

- 边界按**消息对象身份**记录（`WeakSet` / 引用数组），不是数组下标——
  `repairToolCallPairing` 会**插桩**（splice 补 tool 存根），下标会漂移；
  `trimHistory` 原地换 content，对象身份两者都不破坏。
- 一「轮」= 一条用户问题起，到下一条用户问题前的全部消息（assistant 文本、
  tool_calls、tool 结果、图片结果 follow-up）。压缩以轮为最小单位。

首轮播种拆三段：新增 `bundleToChatMessages(bundle)`（`lib/context/rag.ts`）
返回 `[system, 播种注入, 用户问题]`——现有 `bundleToMessages` 给 panel 任务
继续用，不动。拆开之后播种块才第一次成为可独立淘汰的对象。

## 4. 压缩机制（compaction）

**时机**：`sendChat` 里 push 用户消息**之前**判一次
`estimateMessagesTokens(history) > COMPACT_TRIGGER × inputCeilingTokens`。
只在轮与轮之间跑——轮内增长（工具连读大文件）等不到下个边界，仍由
`trimHistory` 每轮兜底，它降级为第二道保险，不再是唯一机制。

**折叠**：从最老的轮开始（播种注入块最先、见下），逐轮移入折叠集，直到
预计规模 ≤ `RETAIN_TARGET × ceiling`；无论如何保留最近 `MIN_KEEP_TURNS` 轮
逐字。播种注入块和【本轮注入】块**直接丢弃不进摘要**——它们是检索结果，
可再生（§5 的去重集同步清除对应条目，需要时会重新注入）；摘要只归纳对话本身。

**归纳**：一次无工具的 `streamCompletion`（复用当前会话模型），输入 =
旧摘要 + 折叠轮次的渲染文本（tool 结果每条截到 ~200 字符——摘要要的是
"查了什么、得到什么要点"，不是原文），提示词新增
`ai.instructions.chatCompact`（双语）。输出写入消息①（首次压缩时在 system
后**插入**该消息）。旧摘要每次都作为输入参与归纳，摘要天然可再摘要，
不会自身膨胀失控。

**原子性与失败语义**：新历史整体构建、成功后一次性换入并重建边界；归纳请求
失败或用户中止则**放弃本次压缩**，沿用原历史照常发送（阈值仍超，下轮重试）。
压缩绝不能把一次网络失败放大成会话损坏。

**事件**：新增 `AgentEvent`
`{kind:"context-compacted", foldedTurns, fromTokens, toTokens}`，AgentLog 出
一行「已归纳前 N 轮 · 38k → 17k」，展开详情显示摘要全文（复用 ExpandableRow）。
被折叠的必须在 UI 留痕，否则作者只会觉得助手突然失忆。展示层 `turns` 与
wire 历史本就分离，聊天记录的显示不受压缩影响。

## 5. 每轮注入与去重

压缩判定之后、push 用户问题之前：

- 以「用户问题 + 选区 + 当前文档尾窗」为 target 重跑 `selectLore`（预算同
  首轮），命中集对**会话注入账本**去重：`Map<entityPath, contentHash>`，
  已在场且内容未变的不再注入。有净增量才追加一条【本轮注入】user 消息。
- 文档切换（`activeFilePath` ≠ 上次注入时的路径）时，同一块里补注新文档的
  近期窗口 + 前情记忆——这是现状最疼的盲区。
- 含注入块的轮被折叠时，从账本删除其条目 → 再次提到时可重新注入。
- 每次实际注入复用 `context-seeded` 事件进该轮日志，作者看得到每轮进了什么、
  或者什么都没命中。

模型自己 `read_lore_entity` 读到的不记账本——那是它的工作记忆，折叠即忘，
再要再读，行为与人一致。

## 6. 参数（常量集中在 `lib/agent/compact.ts`）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `COMPACT_TRIGGER` | 0.70 | 触发压缩的占用比 |
| `RETAIN_TARGET` | 0.45 | 压缩后的目标占用比，给多轮工具留余量 |
| `MIN_KEEP_TURNS` | 2 | 无论如何逐字保留的最近轮数 |
| `SUMMARY_BUDGET_TOKENS` | ~1000 | 摘要软上限（提示词约束 + 超长再归纳） |
| `FOLD_RESULT_CLIP` | 200 chars | 折叠渲染时单条 tool 结果的截断 |

`0.70 → 0.45` 的空档刻意留大：一轮多工具调用可能增长数千 token，阈值贴得
太近会导致每轮都压、缓存每轮全废。

## 7. 落地拆分

- **PR1 — 结构**（已完成）：`bundleToChatMessages` 三段拆分（`lib/context/rag.ts`，
  返回值按对象身份标出 seed/question）；agentStore 轮边界记账（`chatMeta`，与
  `chatHistory` 同生命周期）；`lib/agent/compact.ts` 纯逻辑（`segmentHistory` /
  `planFold` / `renderTurnsForSummary` / `buildCompactedHistory` + 常量）+
  `chatCompact.test.ts`。行为对用户无感。
- **PR2 — 压缩**：归纳请求 + sendChat 接线 + `context-compacted` 事件 +
  AgentLog 行 + 双语文案；`trimHistory` 注释改写为第二道保险。
- **PR3 — 每轮注入**：注入账本、`selectLore` 复跑、文档切换补注、
  `context-seeded` 每轮化。
- 顺序即依赖序；PR2/PR3 互不依赖，可并行。

**测试**（`src/lib/__tests__/chatCompact.test.ts`）：折叠绝不切开
assistant/tool 配对；`MIN_KEEP_TURNS` 恒成立;插桩后边界仍然正确；归纳失败
回退不改历史；注入账本的去重、折叠回收、内容变更重注入。

## 8. 非目标

- **会话持久化**：`chatHistory` 仍是内存态，随应用退出消失。摘要落盘、
  跨启动恢复是独立议题（届时摘要消息①正好是天然的存档格式）。
- **panel 任务与 lore modal**：单次运行，生命周期短，无长会话问题，不接入。
- **展示层 `turns` 的折叠 UI**（聊天记录抽屉里收起旧轮）：纯 UI 优化，与
  wire 历史无关，不在本方案。
