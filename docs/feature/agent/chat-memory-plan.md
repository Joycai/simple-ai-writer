# 对话助手记忆系统方案（chat context compaction）

> **状态：三期全部实现**（PR1 结构 / PR2 压缩 / PR3 每轮注入，见 §7）。
> 纯逻辑落在 [`lib/agent/compact.ts`](../../../src/lib/agent/compact.ts)，编排落在
> `compactRun.ts`，接入点是 `agentStore.sendChat`。
>
> 目标：把对话助手的上下文管理从「只挖不补」升级为**分层记忆**——
> 稳定前缀（system + 工具定义）→ 历史摘要 → 最近轮次逐字 → 本轮注入 → 用户问题。
> 长会话不再走向 `ContextSizeError` 死局，被淘汰的轮次归纳成摘要而不是蒸发。
>
> 现状与问题盘点见 §1；本方案只动 chat（agentStore.sendChat 一条链路），
> AiPanel 任务与 lore modal 的单次运行不受影响。

## 1. 现状与问题

今天的链路（`stores/agentStore.ts` sendChat）：

- 首轮 `assembleContext` → `bundleToMessages`，把知识库/前情/正文窗口**和第一个
  问题拼成一条 user 消息**；之后每轮只 `history.push({role:"user"})`。
- 唯一的长度控制是 `trimHistory`（`lib/agent/runtime.ts`）：超过
  `inputCeilingTokens` 时把最老的 `role:"tool"` 结果换成占位符。用户消息、
  助手正文一律不碰。

三个后果：

1. **检索只发生一次**。作者中途换文档、换话题，注入的还是开场那批条目，
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
[user] ②    【本轮注入】新命中的条目、切换后的文档窗口（可选）    ── 每轮按需追加
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

> **修复记录（2026-08-15）**：上面结构里的「assistant 文本」此前从未真正
> 入史——runtime 的纯文本轮直接 `return`，最终回复只到达展示层
> `turns[].text`，wire history 里从无带文本的 assistant 消息（API 日志可
> 证：下一轮请求里全是 user/tool/assistant(null+tool_calls)）。Anthropic
> 适配器再把相邻 user 消息合并，模型看到的对话里一个自己的发言都没有，
> 表现为"提完方案下一轮否认提过"的失忆。现 `runtime.ts` 在 prose 分支和
> 中止（AbortError）时若本轮无工具调用、`roundText` 非空，push
> `{role:"assistant", content}` 入史；空文本不入（Anthropic 拒绝空
> content 块）。工具轮 narration 的回滚设计不变——只有作为答案的文本入史。

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
  近期窗口 + 前情提要——这是现状最疼的盲区。
- 含注入块的轮被折叠时，从账本删除其条目 → 再次提到时可重新注入。
- 每次实际注入复用 `context-seeded` 事件进该轮日志，作者看得到每轮进了什么、
  或者什么都没命中。

模型自己 `read_lore_entity` 读到的不记账本——那是它的工作记忆，折叠即忘，
再要再读，行为与人一致。

### 5a. 当前文档默认**只报信息、不注正文**（2026-08-18）

原先无论问什么，首轮都把打开文档的尾窗（`RECENT_WINDOW_MIN_CHARS` = 2400 字）
连同前情提要一起种进去。可是大多数问题跟编辑器里恰好开着的那个文件无关——
「艾尔登的剑叫什么」要的是知识库，不是这一章的结尾——而真正冲着正文来的问题，
作者自己会说出来。于是默认改成一份**简介**（`lib/context/docFocus.ts`）：
标题、篇幅（空文件就说空文件）、标题大纲，跟在 `【当前文件】` 的路径后面，
末尾一句话说明**正文没有注入、要看用 `read_file` 读这个路径**。

- 判定分两层，**确定性的那层只认无歧义的指代**：作者钉了选区（那就是
  「我说的是这个文件的这一段」），或者话里出现只对打开文件才成立的词——
  这一段 / 本章 / 全文 / 继续写 / `this chapter` / `continue writing`。
  其余全部交给模型自己判断，因为它手里有问题、也有工具。方向不对称：
  猜保守了只多一次 `read_file`，猜激进了是**每一次对话都在付钱**。
  单独的编辑动词（润色、改一下）**故意不算**——它们需要宾语，而宾语是打开
  文档时，上面那些词几乎总在旁边；只凭动词判定等于把正文塞回每一条
  听起来像写作的请求里。
- 正文可以**迟到**：`meta.bodyDocPath` 记住正文是否真的在场（`lastDocPath`
  改为「已经告知过的文档」）。首轮报了简介、第五轮作者说「把这一段改紧凑些」，
  那一轮才注入窗口 + 前情——不必从头再来，也不会重复注入。
- 首轮的知识库匹配随之改用**问题**做 target（`TaskExtras.extraMatchText`）：
  以前 `assembleContext` 的 match target 只有「选区 + 选区前文」，对话没有选区
  就等于拿文档尾窗去猜作者想问谁；窗口不再注入之后，问题成了唯一也是本来就
  更对的匹配对象。
- `@` 引用了打开的那个文件时不注入窗口——`chatRefs` 已经把整篇内联进消息了。
- 简介**两种模式都发**（`documentBrief(text, {withheld})`）：窗口只取文档尾部，
  标题大纲是唯一能说清「上面还有什么」的东西；只有那句「正文没有注入」在真注了
  正文的轮次里去掉——上下文块自相矛盾比没有这个块更糟。
- 日志诚实：只报了简介的那轮，`context-seeded` 显示「当前文档 · 未注入正文」
  （灰行，因为没花钱），而不是假装读过。
- **AI 面板的写作任务不受影响**：续写/润色本来就是对着这份文档发起的，
  文档就是它们的宾语。变的只有对话助手。

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
- **PR2 — 压缩**（已完成）：`lib/agent/compactRun.ts`（`compactChatHistory`
  编排 + `summarizeForCompaction` 真实归纳请求，注入式分离以便测试与将来的
  专用归纳模型）；sendChat 在 push 用户消息前接线；`context-compacted` 事件 +
  AgentLog 可展开行（详情=摘要全文）；`ai.instructions.chatCompact*` 双语文案；
  `trimHistory` 注释改写为第二道保险。
- **PR3 — 每轮注入**（已完成）：注入账本进 `ChatSessionMeta`
  （`injected: Map<dirPath, {version, carrier}>` + `entityVersion` 指纹 +
  `excludeDirsFor` / `recordInjections`，折叠时按 carrier 存活性驱逐）；
  `selectLore` 增加 `excludeDirs`（只影响自动匹配，pin 豁免）；
  `assembleTurnInjection`（`lib/context/rag.ts`）产出净增量块，文档切换补注
  窗口+前情；播种的条目在首轮就入账本；归纳输入跳过注入块；实际注入时复用
  `context-seeded` 事件进当轮日志。指纹来自索引（name/aliases/summary/facets
  元数据），只改正文不改摘要的编辑不触发重注——模型仍可用工具读到最新内容。
- 顺序即依赖序；PR2/PR3 互不依赖，可并行。

**测试**（`src/lib/__tests__/chatCompact.test.ts`）：折叠绝不切开
assistant/tool 配对；`MIN_KEEP_TURNS` 恒成立;插桩后边界仍然正确；归纳失败
回退不改历史；注入账本的去重、折叠回收、内容变更重注入。

## 8. 上下文构成条的口径（`lib/agent/contextBreakdown.ts` + AgentChat `ContextBar`）

§4 的压缩机制在 composer 上的可视化。写下口径本身，因为每一条都是改错过一次
之后定下来的：

- **画的是「下一次请求将携带什么」**，按当前 `chatHistory` 实测（按 `chatMeta`
  的对象身份分类每条消息 → 系统+工具 / 摘要 / 种子 / 注入 / 对话），不是本会话
  累计消耗。旧文本计量表用 `chatUsage.inputTokens`（跨轮累加），几轮后读作
  `400k / 128k`——它回答的唯一问题「还剩多少空间」被答反了。
- **分母是输入上限**（`inputCeilingFor` = 窗口 × 利用率，`lib/context/budget.ts`），
  不是裸窗口：压缩与运行时都按上限规划，对着窗口画会让压缩在条的 35% 处
  无端触发。工具 schema 计入固定成本（预检门也数它们）。
- **工具段按「实际发出的工具集」计量**（`routePlannedTools` = `routeTools`
  预判 workspace 存在——chat 在运行开始时必建 workspace，而从组件里拿真句柄
  会把「渲染一个仪表」变成「创建 workspace」的副作用）。响应会话内子代理开关
  （`disabledSubAgents`）：路由会剥 `read_image`/图像工具、追加 `delegate`，
  无视旁边芯片的 系统+工具 段与它声称描述的请求是两回事。
- **`willCompact` vs `over`**：`willCompact`（> 上限 × `COMPACT_TRIGGER`，即条上
  画的那条竖线）驱动警示视觉——竖线就是触发线，只在 100% 才警示意味着条可以
  站在自己画的线外面还一脸平静；`over`（> 上限）保留为几何事实（空余为 0、
  刻度改按 used 缩放），蕴含 `willCompact`。
- **模型未声明窗口时整条隐藏**（`contextSize <= 0` 返 null）——分母会退到假设值，
  对着猜出来的分母画精确的条，是错误的自信。
- `context-compacted` 行留在它先于的那一轮轮体内（不上提为带间分隔）：设计稿
  就把「已归纳前 N 轮对话」画作轮体内的一行，落在哪一轮只是压缩何时发生的
  记录。与之相对，`round-limit` 在 logModel 里上提为手风琴收尾行——它发生在
  两轮**之间**，是对整个手风琴的注脚（见 `docs/reference/design-system.md` → AI 面板
  设计语言）。

## 9. 非目标

- ~~**会话持久化**~~（已另行完成 — 项目库 `chat_sessions` 表保最近 5 个会话：
  `lib/agent/chatSession.ts` 序列化（meta 的对象身份引用 ↔ 历史下标互转，
  解析失败宁可返 null 起新会话）+ `sessionDb.ts` 存取与上限裁剪；每轮结束
  自动落盘，`openProject` 恢复最新会话，AiDrawer 历史菜单可切换）。
- **panel 任务与 lore modal**：单次运行，生命周期短，无长会话问题，不接入。
- ~~**展示层 `turns` 的折叠 UI**~~（已另行完成 — `lib/agent/transcriptFold.ts`
  + AgentChat 的「更早的 N 轮对话」条：纯展示，边界永不切开一问一答，
  展开/收起用高度差补偿滚动位置，与 wire 历史无关）。

## 10. 手动归纳（主动 compact，2026-08-23）

§4 的压缩只在阈值处自动发生；这一节给作者一个**现在就压**的把手——
`agentStore.compactChatNow()`，UI 是 ContextBar 计量行右端的「立即归纳」按钮
（仅 chat 接线；扮演面板的压缩不走这个 store，不传 handler 就没有按钮）。

- **同一套机器，force 档**：`planFold(history, meta, ceiling, {force:true})`
  跳过 0.70 触发检查，并且**跳过回退循环**、折叠到只留 `MIN_KEEP_TURNS`
  逐字——回退循环存在的理由是「预算还不需要的空间不必腾」，而作者按下按钮
  恰恰就是在说「我要空间胜过要逐字」。少于 `MIN_KEEP_TURNS + 1` 轮仍然拒绝
  （按钮也据此隐藏：AgentChat 用 `segmentHistory` 判断有没有可折叠的轮）。
- **天花板同源**：`messageCeilingFor` 按当前会话的子代理开关重算，与 sendChat
  用的是同一个函数——手动折叠和自动折叠不能对预算各执一词。
- **忙时互斥**：新状态 `chatCompacting`。归纳期间 send / 切换会话都等它
  （store 守卫 + composer 的 `canSend`）；反过来 `chatRunning` 时按钮不出现。
  stopChat / resetChat 会中止在途的归纳请求（module 级 AbortController），
  免得一次挂起的请求永久扣住发送。
- **失败要出声**：自动压缩失败可以沉默（下轮重试），按钮按下去没反应不行。
  store 先自己跑一遍 force `planFold` 确认有得折，之后 `compactChatHistory`
  返回 null 就只可能是归纳请求失败——报 `ai.chat.compactFailed`。
- **事件落在最近的 assistant 轮**：复用 `context-compacted`。§8 已写明这行
  落在哪一轮只是「压缩何时发生」的记录，手动压缩发生在上一轮之后，就记在
  上一轮。成功后立即 `persistChat`——历史刚换形，崩溃不会提前打招呼。
