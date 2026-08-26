# 写手子代理 设计文档（Writer Sub-Agent）

> **状态**：`shipped`（PR-1 + PR-2 + PR-3，一次落地）。§3 的触发时机在实现中改过一次，原因与原方案错在哪里记在 §3.1；**实机从未验证**，见 §9 末尾。
> **范围**：**只有对话助手**（AiDrawer chat 模式 / `components/ai/AgentChat.tsx`）。角色扮演与 AiPanel 写作任务**明确不在第一期**，理由见 §7。
> **关联**：[`subagent-plan.md`](subagent-plan.md)（§5 的边界条款在这里被**绕开而不是推翻**，见 §5.5）、[`subagent-lld.md`](subagent-lld.md)（任务工作区就是本设计的交接地基）、[`unified-agent-plan.md`](unified-agent-plan.md)（`finishPolicy` 是本设计唯一的新缝）

---

## 0. 一句话

**主模型负责收集材料与做决定，最终成文交给作者另外绑定的一个模型。开关一开就必然发生，不经任何模型判断。**

---

## 1. 定位：这不是上下文隔离，是模型专业化

这一条是后面所有取舍的依据，而且和现有四个子代理的直觉**是反的**，所以放在最前面。

`search` / `vision` / `longread` / `pdf` 的目标是**上下文隔离**：搜索原文、base64 图片、长文切片不该进主上下文，所以它们的成功判据是「回来的东西越小越好」——`DELEGATE_SUMMARY_CHARS = 800`，全文落 note。

写手的目标是**模型专业化**：换一个更会写的模型来出最后一段文字。**省不省上下文根本不是它的 KPI。**

由此得到一条判据，写进这里免得以后被磨掉：

> **交接单该多大，取决于写手需要多少才写得好，不取决于省多少 token。**

搞混这条的后果是具体的：为了"看起来像个子代理"去压缩交接单，然后拿到一段没有文风、把作者的设定转述过一道的正文——而文风正是启用写手的唯一理由。

---

## 2. 为什么它不是第五个 `delegate`

| | 现有四个（归纳型） | 写手（终结型） |
|---|---|---|
| 产出去向 | 落 note，回 800 字摘要 + 路径 | **就是这一轮给作者的文本**，一字不能改 |
| 谁决定调用 | 主模型（判断） | **开关**（无判断） |
| 主模型在它之后 | 继续干活 | **必须收尾** |
| 产出可否被复述 | 可以，摘要本来就是复述 | **绝对不可以** |

照搬 `executeDelegate` 会二选一，两条都坏：

- **主模型复述一遍** → 付两次 output token，而且必然被悄悄改写。这正是 `copy_lore_file` 的描述里已经写下的那句话——「the content never passes through you: reading a file and re-sending it with `update_lore_file` risks silently reworded prose, a copy cannot」（[`registry.ts:1338`](../../../src/lib/agent/registry.ts)）。
- **主模型说「写好了，见 notes/xxx.md」** → 让作者去打开一个不进文件树、不参与导出的内部目录。

而且"开关一开就委托"意味着它**不能是一个工具**：工具要模型自己决定调不调，那就是判断。

**所以写手是 `runAgent` 的一个收尾阶段，不是 `delegate` 的第五个 kind。**

---

## 3. 架构：`finishPolicy: "handoff"`

```
主跑（对话助手，AGENT_ASSIST_PRESET，作者的主模型）
  │  正常工具循环：读文件 / 查设定 / delegate(search|vision|longread|pdf)
  │  材料按老规矩落进 .ai-writer/tasks/<taskId>/notes/*.md
  │  handoff 工具**从第 1 轮起就在工具集里**（为什么不是收尾轮，见 §3.1）
  │
  ├─ 主模型认为收集完了 → 调 handoff，交出交接单
  │  （这一轮若吐的是正文而不是工单：不接受，钉死 tool_choice 重来一轮）
  │
  ▼
写手子跑（作者绑定的写手模型，全新上下文）
  │  system = [成文指令] + [调用方的 system 层]      ← §5.3
  │  user   = 交接单
  │  tools  = read_note / list_notes / read_file / read_lore_entity / search_text
  │  onOutputText ──────────────────────────► 透传成父跑的 turn text（作者看到流式吐字）
  │
  ▼
主跑结束。写手的文本就是这一轮的产出。
交接单的 tool_call / tool_result 在返回前被撤出 history（§5.2）。
deliver_to 存在时，runtime 用写手的输出组一张 Proposal 交给审批卡（§4.2）。
```

### 3.1 触发时机：为什么不是「收尾轮」

**初版设计错在这里，留着以免再犯。** 原方案是「最后一轮改成强制 handoff」。但
`AGENT_ASSIST_PRESET` 的 `maxRounds` 是 40，而绝大多数对话在第 1、2 轮就产出正文了
—— 最后一轮几乎永远到不了。照那个方案实现，开关打开之后**大部分轮次根本不会委托**，
而且不报任何错。

正确的触发点是「模型不再调工具、准备作答」的那一刻。于是：

1. `handoff` **每一轮都在工具集里**。主模型什么时候觉得收集完了，就什么时候调它
   —— 这正是需求描述的工作流（收集 → 想清楚 → 交给写手）。它需要判断的是"我做完
   了没有"，那本来就是它每一轮都在做的判断；"要不要用写手"仍然不归它管。
2. **正文不是合法的收尾。** 一轮结束时没有任何工具调用、只有正文，运行时**不接受
   它**：钉死 `tool_choice` 重来一轮。确定性来自这一条，不来自"每轮都强制"。
3. 重来那一轮仍然只出正文 → 端点降级了强制调用（§5.1），走降级路径委托。

代价是一次多余的请求，且只在模型答错时发生；被丢掉的那份正文**不进 history、也从未
作为终稿到达作者**（显示层回滚，同工具轮 narration 的回滚）。

### 3.2 为什么缝在 runtime，不在 `agentStore`

范围缩到 chat 之后，最省事的写法是在 `agentStore.sendChat` 里手写「跑完主跑，再跑一次写手」。**不要这么做。** 三件事天然在循环内部：

1. 每轮挂上 `handoff`、正文轮不接受、钉死重试 —— 都在决定 `withholdTools` / `tools`
   的那个位置，也就是循环体自己；
2. 写手的 `onOutputText` 透传成父跑输出 —— `committedText + roundText` 的语义在循环里；
3. 钉死那一轮的 nudge 发出即撤 —— 复用 `forcedTextNotice` 的 push/remove。

在 store 里做等于把手伸进循环。做成 `finishPolicy` 的第三个取值之后，**「roleplay 不动」就是它的 preset 没打开这个开关**，而不是机制长成了 chat 的形状——以后要加 roleplay 或 AiPanel，是改一个枚举值加一个 brief builder，不是重写。

同理，开关一关，`routeTools` 把 `finishPolicy` 还原成 `"force-text"`：整套东西可整体回退，和 `scratchpad: "off"` 就是今天的行为同一个套路。

---

## 4. 交接单（handoff brief）

### 4.1 形状

```ts
interface HandoffBrief {
  /** 这一轮要交付什么。一句话。 */
  goal: string;
  /** 不可违背的东西：设定、情节点、作者刚提的要求。 */
  constraints: string[];
  /** 文风锚点：从前文/知识库里摘的**原文片段**，不是形容词。 */
  styleAnchors: string[];
  /** 材料索引：note / 文档 / 词条路径。写手自己去读。 */
  notes: string[];
  /** 交付形态：正文 / 分析 / 直接回答。决定写手的成文指令走哪一支。 */
  kind: "prose" | "analysis" | "answer";
  length?: string;
  forbid?: string[];
  /** 落盘意图。见 §4.2。 */
  deliverTo?: {
    path: string;
    /** rewrite = 整篇替换；replace_lines 必须带 range，否则整个 deliverTo 被丢弃 */
    mode: "create" | "append" | "rewrite" | "replace_lines";
    range?: { from: number; to: number };
  };
}
```

**材料给路径而不是正文**，因为任务工作区（`subagent-lld.md` §3）存在的理由恰好就是这个：让一个全新上下文读到主模型收集的东西。主模型把材料抄进交接单是它**输出** token（贵的那一半），而 note 已经在盘上了。

`styleAnchors` 是唯一例外——它必须是**原文片段**。用形容词描述文风（「冷峻、克制」）等于让写手去猜，而猜出来的东西就是通用腔。

### 4.2 `deliverTo` —— 引用式写入

现在所有 L2 写工具的 `content` 都是**字面量参数**（`create_file(path, content)`、`append_file(path, content)`）：谁调用，谁就得把全文打一遍字。写手落盘因此只有两条坏路——主模型复述（§2），或者写手自己拿 L2 工具（审批卡归属、路径包含性、`editApply` 的 occurrence 校验都要在子跑里重新成立一遍）。

第三条：**主模型在交接单里声明落盘意图，字节由 runtime 搬。**

写手吐完之后，runtime 用「写手的输出 + `deliverTo`」组一张普通的 `CreateProposal` / `AppendProposal` / `EditProposal`（[`registry.ts:121`](../../../src/lib/agent/registry.ts) 起），交给**父 surface** 的审批卡。

- 不需要新的 Proposal 类型——它们的 `content` 本来就是字符串，区别只在于**这一次没有任何模型打过这些字**；
- 卡上显示的是真实内容，作者审的是要落盘的那段字，不是「插入笔记 X」这种没法审的东西；
- `propose_edit` 那条路的 occurrence 校验一字不改（`EditProposal.occurrences` 仍在提案构造时记录）；
- **写手确实没写盘**，是 runtime 写的 —— 所以 `subagent-plan.md` §5 的「子代理不写正文、不写设定」不用推翻。

---

## 5. 五条不变量

### 5.1 开关一开就必然委托 —— 而强制 `tool_choice` 会被静默降级

这是本设计**唯一一个会让功能悄悄失效**的点，从代码里读出来的：

MiniMax 的 `switch` thinking dialect 上，forced `tool_choice` 被**降级成 `auto`**——OpenAI 适配器（[`openai.ts:63`](../../../src/lib/ai/openai.ts) `toolChoiceFor`）和 Anthropic 适配器（[`anthropic.ts:364`](../../../src/lib/ai/anthropic.ts) `toolChoiceBody`）各有一份。两处注释都写着这是安全的，理由是「唯一会强制的调用方是 `structured.ts`，它本来就把『模型没调工具』当成降级到 JSON 模式的信号」。

**本设计让那句话不再成立。** 如果收尾轮的 `handoff` 被降级成 `auto`，主模型可以直接写正文，写手根本不会跑——作者打开了开关，看到的却是主模型的输出，而且**没有任何报错**。

所以 runtime 必须有确定性兜底：

> 钉死 `tool_choice` 的那一轮若仍然没拿到 `handoff` 调用，**仍然委托**——把主模型这一轮吐出的文本当作交接单正文，`kind` 取 `"prose"`，`notes` 取本次运行写过的全部 note（`handoff.fallbackBrief` + `collectRunNotes`）。绝不静默退回「主模型自己写」。

同时在 `AgentLog` 上留一条事件（`handoff` 的 `degraded: true`），否则作者无从知道交接单是降级来的。

### 5.2 交接单发出即撤

`handoff` 的 tool_call 与 tool_result **不进持久 history**。chat 的 history 跨轮存在还要过 `compact`：留在里面就是下一轮的噪音，会被折叠进摘要变成常驻指令，并训练模型把"写交接单"当成回答本身。这与 `forcedTextNotice` 修过的是同一个坑（[`runtime.ts:529`](../../../src/lib/agent/runtime.ts)）。

进 history 的只有写手的文本——那也正是作者看到、并在回复的那一段。

实现上不需要"撤销"这个动作：`handoff` 的 tool_call **从来没有被 append 过**。运行时在
执行工具之前就拦下它并直接 return，而组装 assistant 消息、配对 tool_result 的那段代码
在拦截点之后——所以工作单没有进过 history，也就没有 `repairToolCallPairing` 要收拾的
半截配对。同理，被拒绝的那份正文也从未入过 history。

### 5.3 写手继承调用方的 system 层

写手的 system **不是**一句固定的成文指令，而是：

```
[写手的成文指令（按 brief.kind 分支）] + [调用方的 system 层]
```

继承的是**调用方指定的那一段**（`AgentRuntimeOptions.writerSystem`），不是 `history[0]`
整条。chat 的 `history[0]` 是「作者的写作提示词 + agent briefing + 工作流清单 + docx
预设」拼起来的：第一段正是写手需要的（`profileSystemPrompt()` 和能力包的 【…】 措辞就在
那里，拿不到就不知道这个项目管它叫「文档」还是「章节」），后面几段是工具循环的机器，
喂给一个没有那些工具的写手只会让它谈论自己没有的能力。

`agentStore` 因此**每轮重算**这一段而不是复用首轮播种时的那份——播种只在会话第一轮
发生，而作者随时可以换提示词。

这条同时是 roleplay 以后要接进来的那个缝（角色人设住在 `history[0]`）——现在就按"继承"实现，比以后再改便宜。

### 5.4 正文字节不经任何模型二次输出

§4.2 的全部理由。任何"让主模型把写手的产出整理一下再交付"的改动都违反这条，无论听起来多合理。

### 5.5 写手不写盘

落盘由 runtime 组 Proposal、父 surface 审批、`editApply` 执行。写手的 preset 里没有任何写工具——**隔离是结构性的，不是提示词里的一句话**（同 `sceneTools` 对扮演 agent 的隔离）。

---

## 6. 改动点清单

| 文件 | 改什么 |
|---|---|
| `lib/agent/presets.ts` | `FinishPolicy` 加 `"handoff"`；新增 `WRITER_PRESET`（tools = `read_note` / `list_notes` / `read_file` / `read_lore_entity` / `search_text`，`maxRounds: 6`，`finishPolicy: "force-text"`，`serverTools: "off"`） |
| `lib/agent/handoff.ts` | **新文件**：交接单类型与宽松解析、`handoff` 工具定义、写手 system 层的拼装、`runWriterHandoff`（子跑 + 记账）、`deliverWriterOutput`（§4.2） |
| `lib/agent/runtime.ts` | `handoff` 每轮挂载、正文轮不接受 → 钉死重试、跑写手子跑、透传 `onOutputText`、撤 nudge、§5.1 的兜底；新增 `writerSystem` 选项（§5.3） |
| `lib/agent/toolCost.ts` | `handoffToolTokens()`——`handoff` 不是注册表工具，`toolTokensOf` 看不见它，漏掉就是这个模块当初要修的那个缺陷重演一次 |
| `lib/agent/subagent.ts` | `SubAgentKind` 加 `"writer"`；**不进** `DELEGATE_KINDS`（同 `imagegen` / `translate` 的先例）；`subAgentModel` 的 writer 分支只接受 `text` / `multimodal` 类型且非 `isTranslateOnly` |
| `lib/agent/routing.ts` | writer 不摘主模型任何工具（没有对应能力可摘）；只把 preset 的 `finishPolicy` 在"可用"时改成 `"handoff"` |
| `lib/agent/events.ts` | 新事件 kind（`handoff`：交接单摘要 + 写手模型名 + `degraded?`），供 `AgentLog` 渲染 |
| `lib/prefs.ts` | `ai:subagent:writer:modelId` / `ai:subagent:writer:enabled` 进 `PREF_KEYS` |
| `lib/agent/logModel.ts` + `components/ai/AgentLog.tsx` | 写手在执行日志里占 band ③ 的一张卡（同 delegate）：`SubAgentRun.step` 变可选，写手改带 `handoff`/`handoffDone`。卡底显示**工单**而不是"返回结果"——写手的返回值就是上面那段答案，再抄一遍只是同一段文字两份，外加一个更重的会话 blob |
| `components/ai/SubAgentChips.tsx` | 加 `kinds?: readonly SubAgentKind[]` 参数（默认全量）；**roleplay 传一个排除 writer 的列表**，见 §8 |
| `components/settings/panes/SubAgentsPane.tsx` | writer 卡；分组不是 delegate/工具两档了，writer 是第三档「收尾」 |
| `i18n/locales/*` | 写手成文指令（三支：prose / analysis / answer）、交接单模板、卡片与芯片文案 |

`ToolContext.taskWorkspace` 不需要新的只读类型：写手的 preset 里没有 `write_note` / `task_plan`，`ensure()` 就没有调用者。**约束来自工具集，不来自 handle** —— 这与 `conversationTools` 的作用域论证同源。

---

## 7. 明确不做

- **角色扮演。** 角色的价值全在那一两句话的质感里，而质感来自人设块、记忆注入块和最近几轮原文的语气——整理一遍就是改写一遍，交接单没法把它们"整理"掉。也就是说 roleplay 的交接单不是交接单，是把整个上下文搬一次：一句台词付两次请求，换来的只是"换个模型说话"。那件事真要做，正确形态是**每个 agent 绑自己的模型**，跟写手子代理是两个需求。附带的三处麻烦（并发信号量 3 → 6、`contextSignature` 要不要把写手算进去、转场前情摘要是谁写的）与本需求核心毫无关系。
- **AiPanel 写作任务。** 缝做在 runtime 之后，接入是「preset 改一个 `finishPolicy` + 一个 brief builder」，不是路口。第一期不做，但 `deliverTo` 与多稿 fan-out 在 schema 里**留好位置**，免得接 AiPanel 时改 schema。
- **多稿 fan-out。** 属于 AiPanel 的 `drafts`，随它一起推迟。
- **任何"这轮算不算写作"的判断旁路。** 见 §8 第一条。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| **退化轮双跑**：作者只说「好的」「继续」，主跑一个工具没调，照样两跑 | **接受，这是"不要 LLM 判断"的标价。** 任何旁路都得判断"这轮算不算写作"，那就是要避开的那个判断换了个位置。缓解手段是会话芯片（`SubAgentChips` 只减不增的语义原样适用） |
| **强制 `tool_choice` 被静默降级** → 开关形同虚设 | §5.1 的确定性兜底 + `degraded` 事件 |
| **写手绑错模型** | writer 没有像 vision/search/pdf 那样的天然前置条件（任何文本模型都能写），所以只能反向排除：拒绝 `image` 类型与 `isTranslateOnly` 的模型。后者绑上去**不报任何错**，只是安静地返回一段它自己指令的中文改写 |
| **roleplay 会话里出现一个点了没反应的芯片** | 这正是这个代码库自己抱怨过的失败模式（"enabled 却什么都不变"）。roleplay 侧传排除 writer 的 `kinds`；`SubAgentsPane` 的卡上写明它在哪儿生效 |
| **延迟翻倍，作者盯 spinner** | 透传 `onOutputText` 是**必须项**不是优化项：不透传，作者要盯着一个纯 spinner 等完一整篇 |
| **成本记账被稀释** | 沿用 `persistUsage(..., "subagent:writer")`，用量面板已按 task 维度分组 |
| **写手把交接单当成要交付的内容照抄** | 成文指令里明确"交接单是给你的工单，不是给读者的文本"；`kind: "answer"` 分支尤其要盯 |

---

### 8.1 实现时发现、设计里没写的两件事

1. **`handoff` 的 schema 要从 ceiling 里扣。** 它不在任何 preset 的 `tools` 里，
   所以 `toolTokensOf` 看不见它——而它每一轮都在线上。`toolCost.ts` 因此多了
   `handoffToolTokens()`，`plannedToolTokens` / `messageCeilingFor` 多了一个
   `RouteOptions` 参数。这与 [`agent-tool-context.md`](agent-tool-context.md) 那条
   「工具 token 必须先从 ceiling 里扣掉」是同一件事，只是这次的工具不在注册表里。
2. **提示词层最终没有为写手加东西。** 本来打算往 `ai.instructions.agent` 里加一段
   「你不写正文」，最后没加：确定性来自 §3.1 第 2 条，提示词只能让模型少浪费一轮
   重试。等实测发现某个模型总在浪费那一轮，再加不迟——现在加就是为一个还没观测到的
   问题付每一轮的 token。

## 9. 分期

1. **PR-1（已落地）**：`finishPolicy: "handoff"` + `WRITER_PRESET` + 交接单 schema +
   透传 + 发出即撤 + §5.1 兜底。
2. **PR-2（已落地）**：`deliverTo` → Proposal → 审批卡（引用式写入）。
3. **PR-3（已落地，随前两片一起）**：设置页第三组「收尾成文」、会话芯片、执行日志
   band ③ 的写手卡、i18n、roleplay 侧的芯片排除。

三片一起落地，因为 §3.1 那次返工把 PR-1 的边界重画了：`handoff` 每轮挂载之后，
"这一轮的回复由写手出"和"落到哪个文件里"共用同一条返回路径，拆开反而要写两遍。

**覆盖测试**：`lib/__tests__/agentRuntimeHandoff.test.ts`（整条循环，含降级路径与
`deliverTo` 的四种模式）、`lib/agent/__tests__/handoff.test.ts`（解析与绑定）、
`lib/agent/__tests__/routing.test.ts` 的 `routeTools — writer handoff` 一节。

**尚未实机验证**：写手没有对着任何真实端点跑过一次。§5.1 那条降级路径尤其——它是
照着 `openai.ts` / `anthropic.ts` 里的注释推出来的，不是观测到的行为。
