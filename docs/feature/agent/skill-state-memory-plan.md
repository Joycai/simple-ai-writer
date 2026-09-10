# 状态记忆：SKILL.state 模式作为对话助手的可选记忆方式

> 状态：`shipped` `unverified`（2026-09-03 第一片落地：Beta 开关 + 按对话的芯片 + 每轮折叠进有 schema 的执行状态；**没有在真实端点上跑过长对话**，§7 列着要验的事）
> 起因：作者读到 *SKILL.state: Scalable Long-Horizon Agent Skills*（Badhe / Tiwari / Chung，arXiv:2608.26263，EMNLP 2026），要求把它做成一个 Beta 的、**作者在某一次对话里显式开启**的记忆模式。
> 相关：[chat-memory-plan.md](chat-memory-plan.md)（今天的分层记忆：摘要 + 逐字 + 每轮注入——本方案复用它的折叠机器）、[compact-threshold-plan.md](compact-threshold-plan.md)（阈值；状态模式下阈值不再是触发条件）、[agent-tool-context.md](agent-tool-context.md)（为什么状态更新不做成常驻工具）、[subagent-lld.md](subagent-lld.md) §3.3（任务工作区——盘上的记忆，与状态互补）

## 1. 论文说了什么

> **读取说明**：本会话所在的网络策略拦住了 arxiv.org 及全部镜像（alphaxiv / ar5iv / semanticscholar / huggingface / emergentmind），下面的内容来自摘要和几家二手摘录里引用的原文片段与数字，**没有读到全文**。机制层面的关键句都是原文引用；实验细节只记有数字的那几条。实现前谁能拿到全文，请对照 §2 的映射复核一遍。

**问题**：现有 agent 运行时靠不断往对话历史里追加观察、动作和中间推理来维持执行，历史随步数无界增长——每步的提示词是 O(t)，T 步累计 O(T²)——带来延迟退化和「上下文投毒」（早期的错误推理留在窗口里持续影响后续判断）。

**机制**：把只追加的对话历史换成一份**显式的、可变的执行状态** Σ。每一步模型只收到三样东西：

1. **不变的技能说明**（skill specification）——任务怎么做的规则，整个过程一字不改；
2. **当前的结构化执行状态**（structured execution state）——一份按 schema 组织的 JSON；
3. **最新的观察**（latest observation）——上一步动作的结果。

模型产出一份状态更新；「中间推理在产生一份**经校验的**状态更新之后立即丢弃」（*Intermediate reasoning is discarded immediately after producing a validated state update*），所以提示词不随执行历史增长。校验由**确定性的运行时**做而不是模型：把 patch 应用到 Σ，按 schema 检查字段类型和键成员，通过就提交、不通过就回滚。结果是每步 O(1)、累计 O(T)。

**状态长什么样**：一个 schema 管全部任务。InterCode CTF 那组 100 道题用的是同一份五字段 schema：`{ "discovered_flags": [], "tested_hypotheses": [], "active_files": [], "working_dir": "/root", "cmd_summary": "" }`——字段是为这一类工作挑的，不是通用记忆。

**数字**（二手摘录引用）：

| 基准 | 结果 |
|---|---|
| 合成仓库任务（100 步） | 累计 token 比 stateful 基线少 **16.2×**；同 token 预算下的滑窗 / LLMLingua 压缩掉到 0.18–0.22 的准确率，SKILL.state 保持 0.94 |
| InterCode CTF | pass@1 54.2%（比最强基线 +7.8、比 stateful +12.4），总 token −60.4%（vs ReAct）/ −65.9%（vs stateful） |
| τ-Bench（航空） | 每步恒定 ≈ 2,800 token，pass 32.4%，token −40.5% / −45.4% |

作者自己的话：16.2× 「不是压缩技巧」——同预算的截断和统计压缩会把准确率打掉，**结构化的语义状态**不会。这一句是整篇的论点，也是本方案存在的理由：我们今天的归纳是散文摘要，摘要会被再次摘要，第 20 轮时「作者要求不用感叹号」大概率已经不在了。

## 2. 映射到本项目

对话助手今天的记忆是 [chat-memory-plan.md](chat-memory-plan.md) 的分层结构：稳定前缀 → 【历史摘要】→ 最近轮次逐字 → 每轮注入 → 问题，摘要只在越过阈值时由散文归纳产生。三元组逐项对到这里：

| 论文 | 本项目 | 说明 |
|---|---|---|
| 不变的技能说明 | `history[0]` 的 system 层（写作提示词 + agent briefing + 工作流卡清单） | 已经是「整个会话不改」的层，只有档位翻转时原地重写 |
| 结构化执行状态 Σ | 【执行状态】消息（`lib/agent/skillState.ts`），落在 system 之后、和历史摘要**同一个位置**（`meta.summary`） | 位置不变是刻意的：稳定前缀最大，`contextBreakdown` 不用学新段 |
| 最新的观察 | **上一轮**整轮逐字（`STATE_KEEP_TURNS = 1`） | 论文里是一次动作的结果；写作对话里「第二段再短点」指的是助手刚写的那段原文，一句话的 `last` 装不下，所以保一整轮 |
| 状态更新 + 校验 + 提交/回滚 | 轮与轮之间一次 `runStructuredTask`（强制 tool_choice + JSON 回退）→ `validateSkillState` → `buildCompactedHistory` 原子换入；不合格重试一次，再不合格**放弃这一轮、历史不动** | `skillStateRun.ts`；失败语义与归纳完全相同（§4） |
| 丢弃中间推理 | 折叠时工具往返只以 200 字符的摘录进更新器输入，之后整轮离开 wire | `renderTurnsForSummary` 原样复用 |

**「步」的粒度**是唯一一处有意的偏离。论文的一步 = 一次模型调用；这里一步 = **一轮对话**（一个问题到下一个问题之间，含多次工具往返）。轮内仍是 runtime 的工具循环、`trimHistory` 兜底。理由两条：写作助手一轮里的「观察」要到轮结束才知道全貌（读了三个文件、改了两处）；而在 runtime 每一轮里插一次状态更新会让每次工具调用多付一次请求，对着 `read_file` 分页读一章的场景是灾难。轮级粒度下累计成本仍是 O(T)：每轮提示词 = 常量（system + 状态上界 + 上一轮 + 问题）。

**状态 schema**（`SKILL_STATE_SCHEMA`）是为写作协作者挑的七个字段，和论文一样「一份 schema 管全部任务」：

| 字段 | 装什么 | 上界 |
|---|---|---|
| `goal` | 作者当前在做什么 | 300 字 |
| `decisions` | 作者定下的：约束、口味、已拍板的选择 | 12 条 × 200 |
| `facts` | 已查明的事实，带来源路径 / 条目名 | 20 条 × 240 |
| `progress` | 步骤清单 `{step, status: todo/doing/done}` | 12 条 × 140 |
| `files` | 涉及的文件与笔记路径及各自状态 | 10 条 |
| `open` | 等作者回答的、还没查清的 | 8 条 × 200 |
| `last` | 上一轮做了什么、结果如何 | 400 字 |

上界是这个模式**成立**的条件而不是装饰：有上界，每轮才是 O(1)。所以校验对**长度**只裁不拒（一条 230 字的事实不该让整轮状态作废，裁是确定性的、模型下一轮看得见）；对**形状**才拒（类型错、`status` 不在枚举），模型拿到错误文本重试一次。列表裁法有方向：`facts` / `decisions` / `open` 保**尾部**（模型按时间追加，最新的在后），`progress` 保**头部**（有序清单，尾部是远期项）。

**全量替换而不是 patch**。论文的运行时是「把 patch 应用到 Σ 再校验」。这里让模型每轮重发整份状态：状态本身 ≤ 约 1.5k token，重发代价很小，而 patch 在小模型上最常见的失败是**打错目标**（改了一条不存在的 `facts[7]`）——全量输出把这一类错误整个消掉，校验也只剩「这一份合不合 schema」一个问题。

## 3. 作者看到什么

- **实验室开关**「状态记忆（SKILL.state）」（`lib/agent/stateFlag.ts`，`app:skillStateBeta`，默认关）。开着时对话助手输入框的芯片行多一个**「状态记忆」芯片**（`components/ai/StateMemoryChip.tsx`），和计划模式并排——同一类控件：改的是助手怎么工作，不是消息带什么。关着时芯片**不存在**而不是禁用。
- **按对话开启**。芯片的值是会话的属性（`ChatSessionMeta.stateMode`，随会话落盘、随会话恢复），不像计划模式那样切换会话就归零：历史的形状是它造成的，换回来的会话必须把它显示出来。新对话从关开始。
- **每次发送前**（和归纳同一个时机、同一个位置）：上一轮之前的全部轮次折进状态，执行日志出一行「已把前 N 轮对话折进执行状态 · 38k → 6k」，展开是状态的 JSON。第二轮时只有一轮历史、无可折叠，一次请求都不发。
- **上下文构成条**：状态模式下**不画**归纳线——线的意思是「越过此处下一轮折叠」，而这个模式下下一轮无论如何都折；条右端的按钮改叫「更新状态」（`compactChatNow` 走同一条路，只是提前）；图例句改成说这个模式在做什么。
- **和「自动归纳」开关的关系**：状态模式是作者在这次对话里显式要的，所以它**不看**自动归纳开关；反过来，状态更新失败的那一轮退回普通归纳（仍受自动归纳开关管），保证模型交不出合格状态时对话也不会无界增长。

## 4. 与现有机器的关系（为什么几乎没有新机制）

状态模式**就是**一次 `force` 折叠：只留 1 轮、每轮都折、摘要换成一份有 schema 的状态。所以 `planFold` 只多了一个 `keepTurns` 参数，`buildCompactedHistory` 一字未改——折叠的全部不变量（不切开 tool 配对、注入账本随载体驱逐、种子块首折即弃、原子换入、失败不动历史）一条都不用重新证明，`chatCompact.test.ts` 原样守着。

两种模式互相接得上，靠 `meta.summaryText` 的一条约定——它永远是「下一次折叠该喂回去的文本」：

- 普通归纳过的对话**打开**状态记忆：`meta.state` 为 null 而 `summaryText` 是散文，更新器收到【已有摘要】，第一份状态从它里面长出来；旧的摘要消息被状态块**替换**而不是叠上去。
- 状态模式下**关掉**（芯片或 Beta）：`summaryText` 是状态的 JSON，普通归纳把它当【已有摘要】合并——`facts` 里的东西进散文，不会丢。

执行状态和**任务工作区**（`task.md` + `notes/`）不重叠：工作区是盘上的、跨会话的、装原文（一份查到的材料）；状态是上下文里的、每轮重写的、装**结论**（材料在哪、说明了什么）。`files` 字段专门留着笔记路径，状态块的引导句告诉模型细节用 `read_note` / `read_file` 重读——这正是论文里「观察不留在历史里，需要就再看」的那一半。

## 5. 成本

每轮多一次结构化请求：输入 = 上一份状态（≤ 1.5k）+ 折叠轮次的渲染（工具结果截 200 字符）+ 指令；输出 ≤ 1.5k。换回来的是主请求的历史从 O(t) 变成常量。粗算：主请求的历史一旦超过「状态 + 一次更新请求」的大小（三四轮之后），状态模式每轮就更便宜；两三轮的闲聊反而多付一次。所以它是**按对话**开的、默认关的——实验室文案里写了这一句。

Prompt cache：状态块每轮重写，缓存前缀止于 system 层——比普通归纳差（那边摘要只在折叠时刻改写）。论文的 O(T) 是按 token 数算的，没有算缓存；本项目的 system 层本来就是大头（工具 schema + briefing ≈ 6–10k），前缀仍然保住了最贵的那段。

## 6. 非目标

- **扮演页 / AiPanel / 批量运行**不接。扮演有自己的记忆系统（`lib/roleplay/memory.ts`，恒在 prelude 的长期记忆 + 转场分拣），和状态记忆解决的是不同的问题；AiPanel 的任务是单次运行。
- **runtime 轮内的状态更新**不做（§2 的粒度决定）。
- **专用更新模型**：`requestStateUpdate` 和 `summarizeForCompaction` 一样与流程分开，将来可绑一个便宜模型，今天用会话自己的。
- **patch 式更新**：见 §2；等有实测证据说全量重写在某类模型上丢东西再考虑。

## 7. 要验的事（`unverified` 的内容）

1. 三个协议族上 `runStructuredTask` 交回的状态是否稳定合 schema——尤其 JSON 回退路径上的本地模型（gemma / qwen 级），以及 strict `json_schema` 下 `progress[].status` 的枚举是否被尊重。
2. 二十轮以上的真实写作任务里，`facts` 是否真的保住了「作者要求不用感叹号」这类决定——这是相对散文摘要的核心承诺，要对照着跑一次。
3. `STATE_KEEP_TURNS = 1` 够不够：作者说「上上轮那个版本」时模型是否能从 `last` + 状态里找回来，还是需要保 2 轮。
4. 每轮多一次请求在慢端点上的体感——是否需要把更新挪到轮**结束**时（在 finally 里跑，作者读回复的时候顺便更新），而不是下一次发送前。今天放在发送前是为了和归纳共用同一段代码与失败语义；挪的代价是中止的轮要单独处理。

## 8. 落地记录

- 2026-09-03 · 第一片：`lib/agent/skillState.ts`（schema / 校验 / 渲染，纯）、`skillStateRun.ts`（更新请求 + 原子换入）、`stateFlag.ts`（Beta）；`compact.ts` 的 `keepTurns` 与 meta 的 `stateMode` / `state`；`chatSession.ts` 两个加法字段（恢复时重新校验 state）；`contextBreakdown` 的 `stateMode`（不画线、按 1 轮算可折）；`agentStore` 的 `stateMemory` + `setStateMemory`、`sendChat` 的状态折叠优先于归纳、`compactChatNow` 两条路；`StateMemoryChip`、实验室开关、ContextBar 的句子与按钮、AgentLog 的两种标签；`context-compacted` 事件加 `mode` 字段；`skillState.test.ts`。
