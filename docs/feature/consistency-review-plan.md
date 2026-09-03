# 一致性检查 · 重设计

> **状态：`shipped`** · 2026-09-03 起草，同日拍板（切段归代码，§14 其余按建议），同日随设计稿
> `22 一致性检查` 一起落地。UI 任务书与设计稿的回答：[`consistency-review-ui-brief.md`](./consistency-review-ui-brief.md)。
> 实现与本文的出入记在 §15。
>
> 把一致性检查从「一次结构化调用」搬到统一 agent 运行时上：作者选**范围**（全部 / 集合 /
> 若干条目）、写一句**核对重点**（可选），运行按预算把文档切成若干段，每段一个带读工具的
> **核对子运行**并行跑，发现即时落成卡片，过程走执行日志，头部挂一条分配条。
>
> 前置阅读：[`agent/unified-agent-plan.md`](agent/unified-agent-plan.md)（运行时）、
> [`agent/subagent-lld.md`](agent/subagent-lld.md) §5（子运行的日志转发）、
> [`agent/context-meters.md`](agent/context-meters.md)（三条计量条哪些必须一致）、
> [`lore/lore-collection-plan.md`](lore/lore-collection-plan.md)（围栏只挡自动发现）、
> [`lore/lore-retrieval-plan.md`](lore/lore-retrieval-plan.md) §5（检索子代理把作者的话展开成知识库词）。

---

## 1. 现状：它停在哪个版本

`lib/consistency/scan.ts` 是 2026-07 的形状，之后运行时长出来的东西一样都没跟上：

| 今天 | 后果 |
|---|---|
| `runStructuredTask` 一次调用：文档 + `selectLore` 24k 字 + 前情 → 强制 tool_choice 出一份 JSON | **模型看不到没被子串命中的条目**。一个特征没写 key、一个别名没登记，那条设定就不在它眼前，而它也没有 `read_lore_entity` 可以去翻 |
| 文档超过 40,000 字取**尾部** | 长文档的前半永远没被查过，界面上却没有任何提示 |
| 范围 = 全局取材范围（`loreStore.scope`） | 作者想「只对着林辰这一条查」做不到；想「查小说 A 的设定但我现在围栏切在 B」也做不到 |
| 没有「查什么」的入口 | 命令面板明明有「核对一致性 · 关于 “{{q}}”」，点下去只是打开抽屉，`q` 被丢掉（`CommandPalette.tsx:353`） |
| 进度 = 原始 JSON 流的最后 400 字 + 思维链 | 和执行日志（轮次 / 工具行 / 子运行）是两套语言；子代理一个都用不上 |
| 没有上下文条 | 作者不知道文档和知识库各占了多少、有没有被截 |
| `quote` 只在渲染时校验 | 模型抄错一个标点，发现就变成「这段原文已找不到」——钱花了，按钮没了 |

保留得住的是 `model.ts`：**一条发现 = 一段逐字引文**这个锚定模型，以及围绕它的 `locateQuote` /
`applySuggestions`（右到左应用、实时重定位）。重设计不动它，只给它更好的输入。

## 2. 目标与不做

**目标**

1. 范围可选：全部（跟随围栏）· 一个或几个集合 · 若干条目（可到特征）。
2. 核对重点可写：一句话，可选；命令面板的 `q` 直接进这里。
3. 过程可见：执行日志（轮次、工具行、并行的子运行）与助手 / AI 面板同一个组件；发现**边查边出**。
4. 头部一条分配条：与生成面板同一套色，读数说清「切了几段、每段带了多少」。
5. 长文档不再截尾：按预算切段、并行核对、合并去重。
6. 引文在**工具里**校验：抄错当场退回让模型改，不留到渲染时。

**不做（本期）**

- 不写知识库、不写正文。「应用建议」仍是作者在卡片上点的确定性替换，「更新条目」仍是跳转。
  核对是量尺子，不是改尺子（组件头注释里那条理由不变）。
- 不给核对绑专用模型。跑抽屉头部 `ModelSelector` 选的那一个，和 AI 面板的任务一样。
  子代理照助手的规矩：设置里绑了的、面板芯片没关的，运行里就能 `delegate`。
- 不落盘报告 / 不做历史。报告仍是「一份文档在一个时刻」的东西，作者一动手就过时（§10 留了口）。
- 不接 `ask_author` / 轮数上限卡：核对是封闭任务，轮数按活的形状定，到顶就 force-text 收尾。

## 3. 形状：核对是助手的那个循环，切段是代码的事

```
scan(scope, focus)
  │
  ├─ ① 取材（纯代码，无模型）
  │     范围 → 候选条目集；重点 → 检索子代理展开成知识库词（3s 超时，可缺席）
  │     预算 → 一次请求能装多少原文 → 装得下就 1 段，装不下切 N 段（按段落边界）
  │
  ├─ ② 核对（N 个完整的 agent 运行，并行 ≤ 3，同一模型）
  │     = 助手的循环：runAgent + routeTools + 任务工作区 + 子代理（delegate）+ 便签
  │     种子：system + 【本段 k/N】+ 【前文提要】+ 【知识库】(按本段匹配) + 【核对重点】
  │     模型自己规划：翻哪些条目、搜哪些前文、要不要派长文/联网子代理、记什么
  │     记录：report_issue / report_pass（收集器，§6.2）；结束：force-text，一句总评
  │
  └─ ③ 合并（纯代码）
        汇总 sink → 按段偏移定位 → 跨段去重 → 报告
```

**核对运行就是对话助手那一套，一样不少。** 同一个 `runAgent`、同一个 `routeTools`（子代理
按设置和面板芯片装载）、同一个按运行建的任务工作区（`createTaskWorkspace`，惰性，不用不
落盘）、同一份执行日志。它和助手的差别只有三处：preset 是 read 档 + 两个收集器，没有写工具；
system 层是核对者不是写作协作者；收尾正文是总评不是答案。**规划权在模型手里**：种子里只列
了标题的条目它自己 `read_lore_entity`；「第三章说过他左手受伤」它自己 `search_text` 回头查；
前面几章太长它派 `longread` 子代理去读摘要；周报里一个日期要核外部事实它派 `search`。
`structured.ts` 的文件头本来就写着这条路：*investigate → structured result*——这一版把
investigate 交给完整的循环，把 result 交给收集器。

绝大多数文档一次请求装得下，也就是 **N = 1：一个运行，全部自主**。切段只在装不下时发生。

**为什么切段仍然是代码的事，不交给模型规划。** 因为「整份文档都被读过」是核对的**保证**，
不是它的**计划**。让模型自己分页（种子给标题索引，模型 `read_file` 一段段翻、用 `task_plan`
勾清单）技术上可行——edit-loop-plan 的结构读和 subagent-lld 的清单滞后提醒都是为这类事修
的——但两条实测挡在前面：`toolBriefingFor` 的注释记着 gemma4:12b 四次续写里两次根本没碰
工具、直接从注入的材料写；tool-pack-plan 的台架记着分发可靠性按模型分档。一份靠模型自觉才
读完的文档，在弱一档的模型上就是「读了前 4000 字，报告说没问题」，而且界面上看不出来。
切段由预算算出来，每段是一次**独立、干净、并行**的运行，覆盖是结构性的；模型的自主留在
段内——那里它有全部工具，而且那正是规划真正有价值的地方（查什么、信什么）。

被否的另一半方案「一个运行 + 模型自己分页」的代价还有两条：串行（N 段就是 N 倍等待），
以及历史随翻页增长、`trimHistory` 会把早先的 `read_file` 结果抹掉——发现在 sink 里不丢，
但模型对前文的记忆丢了，第 6 段查第 2 段说过的事就只剩再翻一次。留在 §14 待拍板。

**并行子运行在日志里是什么。** 父运行只发 `run-start`，然后每段一条 `tool-step`
（name = `check_window`，argumentSummary 带 `{"window":k,"of":N}`），段内子运行的全部事件带
`parentStep` 转发——`logModel.ts` 对未知派发器的兜底就是 `via: "tool"`，和 `run_pack` /
`translate` 走的是同一条缝（tool-progress-plan 修「子运行卡按工具名判定」时留下的）。
不需要改 `AgentLog`。

## 4. 范围（ReviewScope）

```ts
type ReviewScope =
  | { kind: "all" }                              // 跟随取材范围围栏，今天的行为
  | { kind: "collections"; names: string[] }     // 覆盖围栏：只这些集合（可含「未归集」）
  | { kind: "entries"; pins: LorePin[] };        // 只这些条目 / 特征
```

三档和围栏的关系，照 lore-collection-plan 的那一条规则——**围栏只挡自动发现，点名的永远
过**——各自落成：

| 档 | 注入侧 (`selectLore`) | 工具侧 (`ToolContext.loreScope`) | 发现的归属 |
|---|---|---|---|
| all | `scope = loreStore.scope` | 同 | 不限 |
| collections | `scope = names` | `names` | 不限 |
| entries | `pins = pins`，**自动发现关掉**（budget 全给 pin） | 不设围栏 | **只认 pins 里的条目**：sink 拒收别的（§6.2） |

entries 档为什么关自动发现：作者点名要「对着林辰查」，得到 27 条关于别人的发现，是答非所问。
但工具侧**不**围：模型查一个别名、翻一条相关条目来理解上下文都合理——限制发生在**记录**那
一步，不在**阅读**那一步。这和 `findEntityByName` 一路不设防是同一个判断。

**持久化。** `consistency:scope:<projectPath>` 一条偏好（走 `PREF_KEYS`，形状同
`lore:scope:<project>`），下次打开抽屉还是上次那个范围。重点不持久化——它是这一次要问的话。

**失效。** 集合被删、条目被移走：范围里出现引用不到的名字时，设置区显示「N 条失效」并在
运行前剔除（同扮演的 `stale` 处理）；一个全失效的范围退回 all 并说明。

## 5. 核对重点（focus）

一行可选输入。空 = 今天的全面核对（名称 / 事实 / 时序）。有值时它改三处：

1. **指令层**：`【核对重点】` 一段追加到子运行的 user 消息，指令改成「只报告与重点相关的
   矛盾；重点之外的发现即使看见也不记」。
2. **靶子**：重点文本进 `selectLore` 的 matchTarget，并先经 `expandAuthorIntent` 展开——
   「外貌」在知识库里没有一个字匹配，展开成「金发 / 左眼 / 疤」之后才命中特征。检索子代理
   没绑就跳过，这一步永远是可缺席的（`lore-retrieval-plan` §5 的契约原样）。
3. **已通过的口径**：`report_pass` 的标签应当是围绕重点核对过的项，报告头写「重点：外貌 ·
   已通过 6 项」——作者据此知道这次覆盖到哪。

命令面板的 `q` 预填进这里：`setShowAiDrawer(true, "consistency")` 之后再
`useConsistencyStore.setFocus(term)`。

**不做成 chip 菜单。** 重点的可能性和能力包一样开放（周报的「数据」、模组的「规则数值」、
小说的「称呼」），一列预置 chip 会在非小说包上全是错的。placeholder 给两个例子就够。

## 6. 核对子运行

### 6.1 preset

```ts
export const CONSISTENCY_PRESET: TaskPreset = {
  id: "consistency",
  tools: [
    "list_lore_entities", "read_lore_entity", "read_lore_image",   // 翻种子里只列了标题的条目
    "list_files", "read_file", "read_slides", "search_text",       // 回头查前面的章节
    "read_memory", "read_workflow",                                // 前情、工作流卡
    "read_image",                                                  // 稿里贴的图（多模态模型才装）
    "task_plan", "task_progress", "write_note", "read_note", "list_notes",   // 便签
    "report_issue", "report_pass",                                 // 收集器（§6.2）
  ],
  maxRounds: 12,
  finishPolicy: "force-text",
  serverTools: "off",           // 联网走 search 子代理，主模型不直接搜——同助手
  scratchpad: "offered",
};
```

**就是助手 preset 去掉写工具，再加两个收集器。** `delegate` 不在字面量里，和助手一样由
`routeTools` 按「设置里绑了 + 芯片没关 + 有工作区」装上；`read_image` 由 `multimodal` 决定
留不留，也是既有规则。写工具一个都没有：`propose_lore_plan` 和整套 lore 写工具、`propose_edit`
和整套正文写工具、生图、导出——核对不改任何东西，所以它们对这条任务是一条永远走不到的
岔路（`WRITE_PRESET` 注释里「收窄的依据是任务真的会调什么」那条）。

- 工具成本预计 ≈ 5k（read 档 + 便签 + 两个小 schema，`delegate` 另加），远低于 `full` 的 15k。
  `agentToolCost.test.ts` 加一条棘轮钉住它，超了就是有人往里加了工具。
- `maxRounds: 12`：一段的形状是「翻几条条目 → 搜几次前文（可能派一次子代理）→ 逐条记录 →
  总评」。到顶 force-text 收尾即可——已经记进 sink 的发现一条都不会丢，这正是收集器优于
  「结尾一次 JSON」的地方（`LORE_SPLIT_PRESET` 的注释里就是这个论证）。不接轮数上限卡：
  核对是封闭任务，不是「继续整理」那种开放活。
- `scratchpad: "offered"` 不是 `required`：一段核对通常不需要存档；给它便签是为了派了
  子代理之后有地方落摘要（`delegate` 的契约就是「摘要 + note 路径」）。

### 6.2 收集器工具（`lib/consistency/reviewTools.ts`）

照 `splitTools.ts` 的先例：**不写盘，只往 `ToolContext.review` 这个 sink 里追加**。存在的理由
同样是传输——一条发现一次调用，参数由端点按 schema 解码，输出上限只能砍掉一条而不是整份
报告。

`report_issue` 的参数就是今天 `findingsTool` 里 `issues[]` 的一项。**handler 做三件今天留到
渲染时才做的事**：

| 校验 | 退回给模型的话 | 为什么在这里做 |
|---|---|---|
| `quote` 在**本段**原文里逐字出现且**恰好一次** | 「未找到 / 出现 N 次——请缩短或延长到唯一的一句」 | 模型现在就能改；渲染时发现就只剩「找不到」 |
| `entity` 解析到索引里的一条（名字 / 别名） | 「不认识“x”，条目名以【知识库】里给的为准」 | 「更新条目」按钮要落到真目录上 |
| entries 档：`entity` ∈ pins | 「超出本次范围，只记录关于 … 的发现」，**不入 sink** | §4 的归属规则，结构性地执行 |

通过就回「已记录 #n」。`report_pass({label, entity?})` 只解析 entity。`editApply.ts` 「find 的
出现次数变了就拒写」是同一条哲学：**把校验放在它能被纠正的那一刻**。

### 6.3 种子

```
【<文档名> · 第 k/N 段】            ← N = 1 时不写段号
<本段原文，逐字>

【前文提要】                        ← k > 1 时：上一段尾部 600 字 + 前情摘要；k = 1 时只有前情
…

【知识库】                          ← selectLore(本段原文 + 重点展开词, scope/pins, 本段预算)
…                                     只列了标题的条目在尾部一行点名：「以下条目未展开，需要时用 read_lore_entity 读」

【核对重点】                        ← 有才写
…
```

每段**各自**匹配知识库，不是全文匹配一次然后每段都带一样的块——一段只提到三个人，给它 24k
字的设定是把预算花在没人读的地方；分开匹配之后每段的知识库块更小也更准，省下的字给原文。

系统提示沿用今天 `SYSTEM_PROMPT` 的规则（只报材料确立的事、风格不管、引文逐字、答稿子的
语言），加两条：「先用工具查证再记录，猜测不记」「每记一条发现或通过项就调一次工具，不要
在正文里列」。走 `profileSystemPrompt()` 的那条规则在这里不适用——核对者不是写作协作者，
它有自己的 system 层，和 `scan.ts` 今天一样。

### 6.4 模型不调工具怎么办

不保留单发的 JSON 回退（那是第二套代码，而且要多付一次请求）。兜底只做一件廉价的事：
运行结束时 sink 为空而收尾正文非空，就对正文跑一次 `extractJsonObject`，形状对得上就当报告
收——模型把清单写在正文里的情况够多，值这十行。两者都空，报告头写「模型没有记录任何发现
（它没有调用记录工具）」，而不是画一个「没有发现冲突」的绿勾——那正是 §1 里「没查」和
「没问题」同屏的老病。

## 7. 切段与并行

### 7.1 预算（`lib/consistency/budget.ts`，纯函数）

```
ceiling      = inputCeilingFor(model.contextSize, 窗口占用偏好)     ← 和 AiPanel 同一个上限
fixed        = 工具 schema（plannedToolTokens(preset)）+ system + 指令
growth       = ceiling × 0.25                                       ← 留给工具结果长出来的部分
usable       = ceiling − fixed − growth
lore         = entries 档：pins 全文（上限 usable × 0.5）；否则 usable × 0.35
recap        = min(前情摘要, usable × 0.1)（k > 1 再加 600 字尾巴）
window       = usable − lore − recap                                 ← 每段能装的原文
N            = ceil(docChars / window)，上限 12
```

切点取段落边界，优先标题（`lib/batch/clauses.ts` 的 heading 探测可复用其判定，不复用其
输出——它切的是「一条一条」，这里要的是「尽量满的一段」）。N 超过上限时不再细切，读数
写「文档过长，后 x 字未核对」——**截了就要说**，这条是 §1 第二行的修正。

`growth` 那 25% 是运行时 `trimHistory` 的余地：子运行翻条目、搜前文，历史会长；留少了第五轮
撞上限，留多了段变多。先取 25%，实测再调，写进测试里的是「段的合计等于上限」这条不变量，
不是这个数。

### 7.2 并行

- 并发 3，信号量同扮演面板（`roleplayStore` 的 3 个并发）。每段自己的 `AbortController`，
  link 到运行的总信号；作者按停止全体停。
- 顺序不重要但**编号**重要：k 段的前文提要来自 k−1 段的**原文尾巴**，不是它的核对结果，
  所以段与段没有数据依赖，可以真并行。
- 一段失败（网络 / 上限）不拖垮别的：那一段标「失败 · 重试」，报告仍然出，头部写「第 k 段
  未核对」。重试只跑那一段。

### 7.3 合并（`lib/consistency/merge.ts`，纯函数）

- 每条发现带 `window: {index, from, to}`。定位先在**段内**做（`locateQuote(doc.slice(from,to))`
  再加偏移），段内唯一就够——今天「引文在全文出现两次就放弃」的限制随之消失，因为段的范围
  就是消歧信息。
- 跨段去重：同 `quote` 只留段号最小的；同 `entity` + 同 `title` 而 `quote` 不同的保留（两处
  都错是两条）。
- `passed` 合并去重；总评取各段收尾正文，N > 1 时拼成「第 k 段：…」的列表，不再让模型
  总结总结。

## 8. 进度与日志

设置区里有一行 `<SubAgentChips />`，和助手的一样、状态一样存 `agentStore.disabledSubAgents`
（一个面板一次一个运行，没有扮演那种四场并存的问题，不用另开一份）。`retrieval` 照旧不是
芯片：它在 ①取材里已经跑完了。

运行中面板从上到下：

1. **段条**：N 个小格，等待 / 核对中 / 完成（含本段发现数）/ 失败。N = 1 时不画。
2. **执行日志**：`<AgentLog log={log} isRunning flat />`——和 AI 面板 Agent 模式同一个组件、
   同一个变体。N = 1 时它就是助手那份日志的样子：轮次、工具行、`delegate` 的嵌套子运行、
   便签；N > 1 时每段是一条工具行，展开是它自己的那一整套。思维链走 `reasoning` 事件，今天
   那个独立的「思考过程」折叠随之退休。
3. **发现流**：sink 每收一条，卡片就在下面出现（store 订阅 sink 的追加）。作者不必等到最后
   才开始看，长文档尤其如此——这是把「进度」从「JSON 流的尾巴」换成「已经查出来的东西」。

停止：总信号 abort，已记录的发现**保留**并出报告，头部标「已中止 · 核对到第 k/N 段」。
半份报告比没有报告有用，而且作者已经付过钱。

事件节流沿用 `createStreamThrottle`，`reasoning` 按 (parentStep, round) latest-wins——
`aiTaskStore` 那段照抄，不要再写第三份。

## 9. 分配条

作者的原话是「单次任务，无实际意义，只为统一」。**它有意义，但要用对那一条。**
`context-meters.md` 的分界：生成面板那条是**控件**，量「这一次请求」；助手那条是**读数**，量
「这场对话」还剩多少。核对没有「下一轮」，也没有折叠线可画，所以它是分配条，不是构成条。

而且它回答的是一个作者真会问的问题：**文档为什么被切成 4 段。** 条上一眼看见知识库占了
多少、原文一段能装多少，作者调窗口占用、换 entries 档、或者缩范围，段数就跟着变。

| 段 | 色（与分配条同 token） | 装什么 |
|---|---|---|
| 系统+工具 | `--color-text-dim` | schema + system + 指令 |
| 原文 | 同「选区/附加」`--color-border-accent` | 一段能装的原文——都是「这一次带进来的材料」 |
| 知识库 | 同「条目」`--color-success` | 本段的知识库预算 |
| 前情 | 同「前情」`--color-accent-mid` | 摘要 + 上段尾巴 |
| 余量 | 轨道 | 留给工具结果长出来的那 25% |

读数：`本次 3 段 · 并行 3 · 每段 ≤ 9.2k tk`。`over` 态：模型没声明窗口 → 静态一句「模型未声明
上下文大小，按 N 段估」（同 forecast.ts 返回 null 时的兜底）。

**不加新颜色、不加第四种条。** `context-meters.md` 的表加一行「核对分配条 = 分配条，段名不同，
色相同」，实现复用 `AiPanel` 的 `ContextAllocation` 渲染（把它抽到 `components/ai/` 同级），
预估函数是 `lib/consistency/budget.ts` 自己的——它和 `forecast.ts` 算的不是一个东西，只是穿
同一件衣服。

## 10. 报告

`ConsistencyReport` 加四个字段，其余不动：

```ts
scope: ReviewScope;            // 头部写「范围：小说A ＋1 · 重点：外貌」——校准信息，和「已通过」同一个目的
focus: string;
windows: WindowOutcome[];      // 每段：范围、状态、发现数——「第 3 段未核对」从这里来
summary: string;               // 总评（§7.3）
```

卡片不变：跳到原文 / 应用建议 / 忽略 / 更新条目。`reportMatchesOpenDocument` 那条守卫不变。

**留的口（不做）**：报告写到 `.ai-writer/reviews/<doc>.json` 并在文件树上挂一个「上次核对
有 3 条未处理」——要做的话，`resolved` 得跟着落盘，而且要处理「文档改了报告还在」。等作者
真的要回看历史再说。

## 11. 改进意见（作者四条之外）

1. **引文在工具里校验**（§6.2）——今天最常见的失败模式是「找不到原文」，根子是校验晚了一步。
2. **发现边查边出**（§8）——长文档等三分钟再看清单，和三分钟里陆续看见，是两种体验。
3. **跨章节时序**——子运行有 `search_text` + `read_file`，「上一章他明明死了」这类今天
   靠前情摘要碰运气的矛盾，现在可以查证。
4. **段内定位**（§7.3）——同一句话在全文出现两次不再让按钮失效。
5. **「没查」和「没问题」分开说**（§6.4、§7.1）——空 sink、截断、失败段，每一种都写在
   报告头上，绿勾只给真的核对过的。
6. **命令面板的 `q` 有去处**（§5）。
7. **选区模式**（可选）：编辑器有选区时，设置区多一个「只核对选区」开关——N = 1、原文 = 选区，
   前文提要 = 选区之前的 600 字。实现零成本（切段函数多一个入口），但设置区多一个控件；
   要不要放，看设计稿。

## 12. 文件改动

**新建**
- `lib/consistency/budget.ts` — 预算与切段（纯）
- `lib/consistency/merge.ts` — 合并、去重、段内定位（纯）
- `lib/consistency/reviewTools.ts` — `report_issue` / `report_pass` + `ReviewSink`
- `lib/consistency/review.ts` — `runConsistencyReview(args)`：①取材 ②并行运行（每段
  `routeTools` + `createTaskWorkspace` + `runAgent`，`toolContext` 照 `aiTaskStore` 那份减去
  审批通道）③合并；替换 `scan.ts`（删除，不保留单发路径）
- `lib/consistency/scope.ts` — `ReviewScope` 类型、序列化、失效剔除
- `lib/consistency/__tests__/{budget,merge,reviewTools,scope}.test.ts`

**修改**
- `lib/agent/presets.ts` — `CONSISTENCY_PRESET`
- `lib/agent/registry.ts` — 两个工具 id + `ToolContext.review?: ReviewSink`
- `lib/agent/toolCost` 相关测试 — 棘轮一条
- `stores/consistencyStore.ts` — scope / focus / log / windows / 流式 issues；`scan()` 改走
  `runConsistencyReview`；范围偏好读写
- `lib/prefs.ts` — `PREF_KEYS` 加 `consistency:scope:`
- `components/ai/ConsistencyCheck.tsx` + css — 设置区（范围三档 + 集合选择复用
  `ScopePicker` 的弹层、条目选择复用 AI 面板的固定条目选择器）、分配条、段条、日志、发现流
- `components/ai/AiPanel.tsx` — `ContextAllocation` 抽成独立文件供两处用
- `components/command/CommandPalette.tsx:353` — 带 `term` 过去
- `docs/feature/agent/context-meters.md` — 表加一行；`docs/README.md` — 状态行
- i18n：`ai.consistency.*` 新增键，中英各一份；**不出现 章/卷/设定**，段名用 `useTerms()`

## 13. PR 切片

| 片 | 内容 | 可验证的东西 |
|---|---|---|
| **PR-A 搬家** | preset + 收集器 + `review.ts`（N = 1，不并行）+ store 改走运行时 + 面板换 `AgentLog` + 引文工具内校验 + `q` 预填 + 删 `scan.ts` | 一份短文档：日志出现轮次和 `read_lore_entity` 行；故意让引文抄错，看到模型被退回后改对 |
| **PR-B 范围与重点** | `ReviewScope` 三档 + 持久化 + 失效剔除 + entries 档 sink 拒收 + focus + 检索展开 + 报告头 | entries 档下对着一条查，报告只有它；focus「外貌」命中没写 key 的特征 |
| **PR-C 切段并行** | `budget.ts` / `merge.ts` + 并发 3 + 段条 + 分配条 + 失败段重试 + 中止出半份 | 一份 8 万字的文档：4 段、3 并行、日志里 4 条子运行、段内定位、超长截断有提示 |

每片一次真机测试再下一片。PR-A 先落是因为它一个人就消掉 §1 的前两行和最后一行。

## 14. 已拍板（2026-09-03）

0. **切段归代码**（§3）：按预算切、段内模型全自主。否掉的是「一个运行、模型自己 `read_file`
   分页 + `task_plan` 勾清单」——串行、弱模型上读不完且看不出来。
1. entries 档的工具侧**不围**（§4）。
2. 并发 **3**（同扮演），本地端点的排队由它自己扛。
3. `growth` **25%** 先这么定，PR-C 实测后回来改 §7.1。
4. 选区模式（§11-7）**先不进**第一版设置区；切段函数留入口。
5. 报告**不落盘**（§10）。
6. UI 任务书已出：[`consistency-review-ui-brief.md`](./consistency-review-ui-brief.md)。
   设计稿回来之前不动 `ConsistencyCheck.tsx` 的版式；PR-A 可以先落数据层和 store。

## 15. 实现与方案的出入（2026-09-03）

三片 PR 合成了一次落地：设计稿一次画出了跑前 / 跑中 / 跑后三个态，而三片各缺一块就没有一个
态是完整的，分开交付只会让作者测三次半成品。文件按 §12 的清单落，差别如下。

- **收集器的校验结果比 §6.2 多一条**：`category` 不在项目的分类里时不拒收，改归 `timeline`
  并在回执里说明——一个分类写错就丢掉一条已查实的矛盾，代价比一个错误的标签大。
- **`salvageJson` 是 §6.4 那十行**：收尾正文里的 `{issues, passed}` 走的是和工具**同一套**
  校验（`reportIssueTool` 本身），所以正文里抄错的引文一样被丢，不会绕过「恰好一次」。
- **段内定位比 §7.3 严一层**：`locateIssue` 以扫描时的锚点为中心按 0 / 200 / 2000 字三圈
  逐圈搜、每圈都守唯一性，最后才搜全文。§7.3 只写了「段内」，而一段里同一句话出现两次的
  情形（对白）真实存在，所以圈要从锚点本身起。
- **前情提要只给本段之前的摘要**（`MemorySegment.to <= window.from`）：把正在核对的文字的
  摘要也喂进去，等于把答案递给模型。
- **N = 1 不套父运行**：单段就是运行本身，事件直接上日志——这也是设计稿 1b 画的样子。
  N > 1 时父运行只发 `run-start` / 一个 `round-start` / 每段一条 `check_window` 工具行 /
  `run-done`；`AgentLog` 为此多了两个可选 prop（`headline`、`subRunsLabel`），因为它自己的
  头部句子是按轮次说的，而父运行没有轮次。
- **重跑与续跑**：设计稿 1j 的「重跑第 3 段」「从停下的地方继续」「从第 N 字起再跑一次」
  都实现成**部分运行**——只跑点名的段，其余段的发现原样保留再合并。续跑的边界是「所有
  不是 done 的段」，上限截掉的尾巴则是整份重跑（切段是确定性的，同一份文本切出同一批段）。
- **撤销**：已忽略的卡折到底部一行，撤销回到列表；已应用的撤销靠 `revertSuggestion`
  在锚点附近定位建议文本再换回引文，找不到就不动（作者已经改过了）。
- **范围里的失效项**在运行前剔除（`resolveReviewScope`），界面上是虚线划线的芯片 + 一行
  「N 条失效」+ 剔除按钮；全失效退回 all。
- **entries 档的预估**：pins 的正文大小不读盘就不知道，预估按一条 1,500 字 + 每个特征 300
  字估，运行时以真实注入为准。这是分配条上唯一一个「估」而不是「量」的段。
- **没做**：设计稿头部的「历史检查」按钮和空态里的「查看那份报告」（§10 不落盘的决定）；
  条目档芯片上的特征展开（选择器直接列出「条目 · 特征」两级，效果等价）；`lastCheckedAgo`
  只在同一会话内有意义。
