# 统一 AI Agent 系统方案（v0.3.0 · feat/unified-agent）

> 目标：把目前分散在编辑器侧与 lore 侧的所有 AI 功能，统一到**一套 agent runtime**
> 上运行 —— 该 runtime 提供 tool loop，模型可以按需发现 lore、阅读章节文本、
> 更新记忆/知识库，或依据文本与用户输入修改、新增 lore。
>
> 交互形态采用**两阶段演进**：第一阶段统一底层 runtime（现有 UI 入口全部改为
> 调用它，行为对用户基本无感）；第二阶段把 AiRail 长成对话式统一助手。

## 1. 现状盘点：分散的 AI 入口

当前共约 9 处各自组装 prompt、各自管理流式状态的 AI 调用点：

| 入口 | 位置 | 形态 | 上下文来源 |
| --- | --- | --- | --- |
| 续写 continue | `stores/aiTaskStore.ts` | **agent loop**（唯一） | 预算化 RAG 注入 + 4 个只读工具 |
| 润色/改写/总结/自定义 | `stores/aiTaskStore.ts` | 单次流式 | 预算化 RAG 注入 |
| 前情提要摘要 | `stores/memoryStore.ts` | 单次流式 | 分段正文切片 |
| Lore 新建实体提取 | `lib/lore/generator.ts` | 单次流式（JSON 结构化） | 描述 + @附件 |
| Lore 特征拆解 | `lib/lore/splitter.ts` | 单次流式 | 实体全文 |
| 图集 AI 描述 | `lib/lore/vision.ts` | 单次流式（多模态） | 单张图片 |
| LoreImproveModal / LoreMetaImproveModal / FacetAiAssistantModal | `components/lore/` | 单次流式（共用 `lib/lore/aiTask.ts` 引擎） | 实体文件 + @附件 |

问题不在功能而在结构：每个入口都要重复解决模型解析、apiKey、流式累积、
错误/中止、写回等同一批事，且互相看不见 —— lore 改进器不知道章节正文，
续写 agent 只读不能写，记忆更新只能被动整段重算。

## 2. 可行性判断

**可行，且已有一半地基。** `lib/agent/loop.ts` 已经是一个与 provider 无关的
tool loop：OpenAI/Gemini 双协议、多模态工具结果、`trimHistory` 上下文裁剪、
最后一轮强制成文、Gemini thought-signature 保留。`lib/agent/tools.ts` 已有
工具定义/执行器模式与路径包含校验（`isPathWithin`）。缺的是：

1. loop 与「续写」语义解耦（多轮会话、任务无关的收尾策略）；
2. **写类工具**及其安全机制（备份 / diff 审批）；
3. 工具注册表 + 按任务裁剪的 toolset；
4. 一个统一的会话状态层（替代各入口自管的流式状态）。

主要风险与对策见 §6。

## 3. 目标架构

```
components/（各入口 UI，第一阶段保持外观不变）
      │  以 TaskPreset 启动
      ▼
stores/agentStore.ts        ← 会话历史、工具时间线、待审批队列、usage
      │
      ▼
lib/agent/runtime.ts        ← 泛化自 loop.ts：多轮 tool loop、流式、裁剪
lib/agent/registry.ts       ← 工具注册表（定义 + 执行器 + 权限级别）
lib/agent/presets.ts        ← TaskPreset：每个旧入口 = 一份预设
lib/agent/approval.ts       ← 写操作分级：自动+备份 / diff 审批
      │
      ▼
lib/ai/*（streamCompletion 等，不动） · lib/context/*（预算化注入，保留作 seed）
```

### 3.1 AgentRuntime（`runtime.ts`，从 `loop.ts` 泛化）

- 输入从「systemPrompt + initialUserMessage」泛化为**会话消息数组**，
  支持追加用户轮次（第二阶段聊天 UI 的基础）；
- `MAX_ROUNDS`、收尾策略（强制成文 / 允许以工具调用结束）由 preset 决定；
- 工具执行改为查 registry，不再 switch 硬编码；
- 保留：`trimHistory`、`inputCeilingTokens`、多模态图片回传、abort 语义。

### 3.2 工具注册表（`registry.ts`）

| 工具 | 读/写 | 说明 |
| --- | --- | --- |
| `list_lore_entities` / `read_lore_entity` | 读 | 知识库侧只读，原样迁入 |
| `list_files` | 读 | 递归列出工作区全树（含子目录；`.ai-writer/` 除外），按 `ls -R` 分组输出：绝对目录路径一行，其下文件名缩进。不逐行重复项目前缀是为了省 context——几百章各带一遍长前缀，光目录就能吃掉几千 token |
| `read_file` | 读 | 单次上限 4000 字符，**按行边界切**；截断时回报 `lines a-b of N` 与下一个 `start_line`，长章节可顺序翻页。分页坐标用行号而非字符偏移，因为 `search_text` 给的就是行号（`L34`），「从第 34 行读」是直接的后续动作 |
| `search_text` | 读 | 在工作区内全文检索：递归扫所有章节文件（`.ai-writer/` 除外），返回 `路径 + 行号 + 片段`。字面匹配、大小写不敏感，**不支持正则**（模型给的病态正则会卡死 UI 线程且无法中断）。结果有上限（全局 40 行 / 单文件 8 行），长段落按命中位置开窗截断——否则一个常用词就能吃光整个上下文 |
| `read_memory` | 读 | 读当前文档的前情提要 |
| `propose_lore_plan` | 写·审批 | 提交知识库改动方案（步骤 = action + entity + detail），阻塞等作者批准；**四个 lore 写工具的准入门槛** |
| `create_lore_entity` | 写·L1 | 新建实体（name/category/summary/content），落盘前校验 frontmatter |
| `update_lore_file` | 写·L1 | 改写实体的 index.md 或特征 md（整文件替换，沿用 splitter 的逐字校验思路）。**兜底手段**：整篇重排或新建特征文件才用它，小改动见下面三个 |
| `update_lore_meta` | 写·L1 | 只改实体 index.md 的 summary / aliases，正文原样带过。`aliases` 整表替换、`add_aliases` 追加；**改名与换分类不在这里**（都要搬文件夹，走 `move_lore_entity`） |
| `append_lore_file` | 写·L1 | 往实体某个 .md 末尾追加（默认 index.md），前面的内容既不重发也不重读，中间自动留一个空行 |
| `edit_lore_file` | 写·L1 | 替换实体某个 .md **正文**里唯一的一处原文（find 必须唯一，replace 为空即删除）；frontmatter 永不触及 |
| `update_facet_meta` | 写·L1 | 只改某个特征的 keys/group/priority/mode/title，正文原样保留（走 saveFacetFile 序列化，模型不用手写 YAML） |
| `delete_lore_file` | 写·L1 | 删掉实体下的单个特征/附件 md（先备份；index.md 与 images.md 拒绝） |
| `move_lore_entity` | 写·L1 | 改名 / 换分类。换分类只能走它——扫描器认的是文件夹位置，只改 frontmatter 会在下次重扫时被还原 |
| `delete_lore_entity` | 写·L1 | 删除实体：整个文件夹 rename 进 `.ai-writer/backups/deleted-…`，图库等二进制资产一并保住，可整目录搬回还原 |
| `update_memory` | 写·L1 | 更新前情提要段落（走 memory.ts 的分段协议，不允许破坏元数据注释） |
| `propose_edit` | 写·L2 | 对工作区正文文件提出修改（find + 新文本；`.ai-writer/` 不可触及），**只产生提案不落盘**。find 重复时用 `occurrence=N` 指定第几处、`replace_all` 改全部——见 §8.5 |
| `rewrite_document` | 写·L2 | 整文件替换工作区内的某个正文文件（完整新内容；`.ai-writer/` 不可触及），**只产生提案不落盘** |
| `rewrite_lines` | 写·L2 | 按**行号**替换文件的一段（只发替换内容，原文由工具从盘上取），长文件的分段改写路径——见 §8.6 |
| `create_chapter` | 写·L2 | 新建章节（完整路径 + 开篇正文）。路径里不存在的文件夹一并创建——新开一卷就是这么来的。审批卡用 `renderMarkdown` 渲染正文预览 |
| `move_chapter` | 写·L2 | 改名 / 移到别的卷（同一个操作，表达为新的完整路径），也可作用于分卷文件夹。目标已存在则拒绝，移进自己的子树则拒绝 |
| `delete_chapter` | 写·L2 | 删**单个**章节文件，批准后移入 `.ai-writer/backups` 可恢复。**分卷文件夹一律拒绝**——删整卷的爆炸半径是作者自己的决定，不该在运行中间用一张卡片批掉 |

> 结构类操作全部走 L2 而非 lore 那样的 L1 自动应用：正文的所有权感比知识库强得多，删一章的破坏性也远大于改一个条目文件。也**没有**对应的 `propose_chapter_plan` 前置门——每个操作各自一张卡，大改结构就是好几张，换来的是每一步都看得见、可单独拒绝。真觉得烦了再加门比反过来容易。
>
> **为什么在 `propose_edit` 之外还要 `rewrite_document`（2026-08-16 补充）：** 排版类工作（统一空行、首行缩进、引号、标题层级）改的恰恰是**全篇重复**的文本，而 `propose_edit` 要求 `find` 在文件里唯一——每一处都会被「occurs N 次」顶回去，模型只能不断加上下文把单条编辑撑大，还是一次只修一处。整篇跑下来既撞轮次上限，也变成几十张卡片。所以补一个整文件替换工具，仍是 L2、仍然一张卡，只是审批单位从「一处」变成「这个文件」——这才是排版这件事诚实的审批粒度。
>
> 它引入的新故障模式是「只读了第一页就把它当成全文交回来」，那会**静默删掉后半篇**。两道防线：工具层对不足原文 50% 的提案直接拒绝并让模型继续 `read_file`（见 `REWRITE_MIN_RATIO`，宁可退回模型也不花作者的注意力）；卡片层把字数增减放在最显眼处，减少时用告警色。落盘前照例备份——`applyRewrite` 无法像 `applyEdit` 那样重新定位、发现作者中途改过文件，备份是唯一的兜底。
>
> 提案类型是按 `kind` 打标签的判别联合（`Proposal`），审批卡和落盘步骤都靠它收窄。TypeScript 会验证两处 switch 穷尽，所以加 kind 时漏了卡片 body 或落盘分支是编译错误。

**安全分级（已定）：**

- **L1（lore / 记忆）：自动应用 + 自动备份。** 每次写入前把原文件备份到
  `.ai-writer/backups/<时间戳>/…`（复用 LoreSplitModal 的备份模式），
  写入后触发 loreStore 重扫 / memoryStore 刷新。
- **lore 写入额外受方案门控（2026-07-28 补充，见 8.2）：** 四个 lore 写工具
  在 L1 之上再叠一层——必须先有作者批准的 `propose_lore_plan` 步骤覆盖
  「这个动作 + 这个实体（+ 这个文件）」，否则工具直接拒绝。一张卡片管一整轮
  整理，写入不再逐个弹窗，但落盘的必然是卡片上那几条。记忆写入不设门控。
- **L2（正文）：必须审批。** `propose_edit` 只把 diff 放进 agentStore 的
  待审批队列，UI 渲染 diff，用户确认后才写入 editorStore/磁盘；拒绝则把
  「用户拒绝+理由」作为 tool result 回给模型。
- 所有路径参数一律过 `isPathWithin`；正文写工具经 `isWorkspacePath`
  限定在工作区内且排除 `.ai-writer/`，lore/memory 写入只能走各自的专用工具。

### 3.3 TaskPreset（`presets.ts`）

每个现有入口收敛为一份预设：

```ts
interface TaskPreset {
  id: string;                    // continue / polish / lore-improve / …
  systemPrompt(ctx): string;
  seedContext(ctx): Promise<string>;  // 预算化 RAG 注入结果（沿用 lib/context）
  tools: ToolId[];               // 按任务裁剪，如 polish 可以为空数组
  finishPolicy: "force-text" | "allow-tool-end";
  output: "stream-to-panel" | "structured-json" | "write-back";
}
```

要点：**预算化注入不废除**。lore 的三层预算注入（loreSelect）继续作为
seed 提供低延迟的第一轮上下文，工具用于按需补读 —— 两者互补而非替代。
`tools: []` 的 preset 就退化为今天的单次流式，弱模型兜底也靠它（§6）。

### 3.4 agentStore

替代 aiTaskStore 中「流式状态」职责（selection 等编辑器耦合状态留在原处）：
会话消息、toolSteps 时间线、pendingApprovals、usage 累计、abortController。
一次只跑一个会话（与现状一致），第二阶段再考虑会话持久化。

## 4. 分阶段 PR 计划

| PR | 内容 | 验收 |
| --- | --- | --- |
| **PR1** | 抽出 runtime + registry（纯搬运，只读工具），`continue` 迁移到 preset 跑通 | 续写行为与 main 完全一致；loop.ts 删除 |
| **PR2** | agentStore + 备份/审批基础设施 + L1 写工具（lore/记忆）；`update_memory` 接入 | 手动触发 agent 改 lore 有备份、UI 即时刷新 |
| **PR3** | lore 侧入口迁移：Improve / MetaImprove / FacetAssistant / Generator / Splitter 全部改为 preset 调 runtime；`lib/lore/aiTask.ts` 流式部分退役 | 各 modal 外观不变，底层单一路径 |
| **PR4** | `propose_edit` + diff 审批 UI；润色/改写/总结获得可选 agent 模式；一致性检查用 `search_text` 重做 | 正文修改全部走审批 |
| **PR5**（第二阶段） | AiRail 对话式统一助手：自由输入 + 预设变快捷指令、会话内多轮追问 | 聊天式交互上线 |

PR1–PR2 合并前不动任何用户可见行为，随时可发版；0.3.0 在 PR4 末尾对外。

## 5. 需要同步调整的现有模块

- `aiTaskStore.runTask`：收缩为「解析 preset → 调 runtime」的薄壳；
  预算规划（planContextBudget）挪进 preset 的 seedContext。
- `lib/lore/aiTask.ts`：附件收集（@-引用）保留，改造成 seedContext 的素材源；
  `streamLoreTask` 删除。
- `memory.ts`：暴露「重写单段」的安全写入 API 供 `update_memory` 调用，
  保持分段哈希协议不被模型输出破坏。
- i18n：新增工具时间线、审批 diff、备份提示文案（中文用「特征」术语）。
- 测试：registry 的路径白名单/参数校验单测；runtime 多轮会话单测
  （mock streamCompletion）；preset 快照测试。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 任意 OpenAI 兼容端点上的弱模型 tool-use 不可靠 | preset 均保留 `tools: []` 单次流式回退；provider 探测（providerProbe）可加 tool-call 能力探测 |
| 工具循环放大 token 成本/延迟 | 沿用 MAX_ROUNDS + inputCeilingTokens；seed 注入减少补读轮数；usage 面板继续按任务记账 |
| 模型写坏 lore 文件（frontmatter / 分段协议） | 写工具走结构化参数 + 落盘前 schema 校验，坏输出直接以错误回给模型重试；L1 自动备份可回滚 |
| 大重构回归 | 分 5 个 PR，PR1/PR3 是行为等价迁移，CI（tsc + vitest + build）逐个把关 |

## 7. 本分支进度

- 基于 main@69e5a13 建分支 `feat/unified-agent`；
- 四份版本清单同步升至 0.3.0（bump-version 脚本）；
- 本方案文档；
- **PR1 完成**：`loop.ts` → `runtime.ts`（按 preset 驱动的通用 tool loop）+
  `registry.ts`（工具注册表，含 access 分级字段）+ `presets.ts`（CONTINUE_PRESET）+
  `events.ts`（结构化执行事件）。`aiTaskStore` 改为薄壳调用 runtime。
- **执行日志（提前自 §4 计划）**：所有任务（含单次流式）发 run-start / round-start /
  tool-step / context-trimmed / run-done / run-error 事件，AiPanel 的
  AgentLogSection 实时渲染为可折叠日志（工具调用、轮次、token 估算、时间戳）。
  注意：preset 的 systemPrompt/seedContext 收拢仍属 PR2/PR3 范围，当前仍在
  aiTaskStore 内组装。
- **PR2 完成**：`backup.ts`（写前自动快照进 `.ai-writer/backups/`，backup 失败即写入
  失败）+ `writeTools.ts` 四个新工具：`read_memory`（读段落索引）与三个 L1 写工具
  `create_lore_entity` / `update_lore_file` / `update_memory`（access: write-auto）。
  结构校验先于落盘：index.md 必须保住 frontmatter 且禁改 category、facet 文件必须
  仍是合法 facet、images.md 拒写、记忆只能走 `rewriteMemorySegment`（memory.ts 新
  API，段范围/哈希协议不可破坏）。ToolContext 增加 onLoreChanged/onMemoryChanged
  刷新钩子（aiTaskStore 已接 loreStore.scanProject / memoryStore.loadForActiveFile）。
  注意：尚无 preset 引用写工具——它们在 PR3 的 lore 入口迁移中获得第一个 UI 触发点；
  独立的 agentStore 推迟到需要审批队列/多轮会话时（PR4/PR5）再立。
- **PR3 完成（范围有两处有意收窄）**：
  - `run.ts` 新增 `runLoreAgentTask`（Model/Provider → runAgent 的 UI 入口），
    `streamLoreTask` 从 aiTask.ts 删除；执行日志抽成共享组件
    `components/ai/AgentLog.tsx`（AiPanel 与 lore modal 共用）。
  - **LoreImproveModal / FacetAiAssistantModal**：迁到 LORE_IMPROVE / FACET_ASSIST
    preset（带 list/read lore 只读工具，maxRounds 4），modal 内嵌执行日志——AI 改知识库
    前可以自己查阅其它条目了。审阅后保存的 UX 不变（modal 落盘），未直接用
    update_lore_file 自动写：审阅式 modal 里静默改盘反而降低可控性。
  - **generator.ts / splitter.ts**：等价迁到 runtime 单发 preset（runtime 新增
    extraBody 透传支持 JSON mode）。JSON mode 与 tool 调用在多家 provider 上互斥，
    故这两个暂不带工具；升级路径是 PR4/PR5 的「强制 tool 调用做结构化输出」。
  - **LoreMetaImproveModal 未迁**：它自有「强制 tool_choice + JSON 回退」结构化输出
    流程，等 runtime 原生支持结构化输出（同上）再收编。
  - 写工具（create_lore_entity 等）的 UI 触发点顺延至 PR5 对话式助手——那才是
    「agent 自主改 lore」的自然场景；modal 场景保留人审。
- **PR4 完成**：L2 正文审批闭环 + Agent 模式首个完整入口。
  - `propose_edit` 工具（write-approval）：只产生提案不落盘；find 必须在文件中
    唯一；工具循环**同步阻塞**在审批 Promise 上——批准即应用（先备份；活动文档走
    editorStore 保住未保存内容并即时可见，其余走磁盘；应用时重新定位 find，文档
    已变则以拒绝形式回给模型），拒绝则把作者理由原样反馈给模型调整。
  - `stores/agentStore.ts`（按计划此刻建立）：审批队列 + approve/reject/rejectAll；
    abort 与任务收尾都会 drain 队列，防止挂起的 Promise 卡死后续运行。
  - AiPanel：`ApprovalCard`（原文/替换为 对照块 + 可选拒绝理由输入）；自定义任务
    新增「Agent 模式」开关 → `AGENT_ASSIST_PRESET`（全部 9 个工具、12 轮）——
    这是 L1 写工具与 propose_edit 的第一个真实 UI 触发点，也是 PR5 对话助手的
    前身。ai.instructions.agent 引导模型「先调查后动手、正文必走 propose_edit」。
  - 仍未做（顺延 PR5）：runtime 原生结构化输出（收编 MetaImprove 与
    generator/splitter 的 JSON mode）；agentLog 迁入 agentStore（等会话化）。
- **PR5 完成 —— 第二阶段交付，本需求收官**：
  - **对话助手**：AiDrawer 新增「助手」标签（generate / chat / consistency 三模式），
    `components/ai/AgentChat.tsx`。会话状态入 agentStore：`chatHistory` 就是 runtime
    原地追加的 wire 协议数组——前一轮的工具调用与结果留在上下文里，后续轮次可以指代
    （「把刚才那条也改了」）；展示层 turns 单独维护（每个 assistant 轮内嵌自己的
    AgentLog）。首轮经 assembleContext 注入知识库/记忆/正文窗口，后续轮只追加 user
    消息；inputCeiling 由 contextSize×utilization 直接给出，超限靠 runtime 的
    trimHistory 淘汰旧工具结果。走 AGENT_ASSIST_PRESET 全工具集，审批卡片渲染在
    输入框上方；停止/新会话/会话累计用量齐备；usage 以 task="chat" 记账。
    toolContext 每轮重建（取 loreStore 最新 index，第 N 轮写入的 lore 第 N+1 轮可见）。
  - **结构化输出统一**：`lib/agent/structured.ts` runStructuredTask（强制
    tool_choice + JSON 回退，抽取自 MetaImprove 的成熟实现并泛化）；
    LoreMetaImproveModal 迁移完成——至此 9 个 AI 入口全部运行在 lib/agent 之上。
    有意保持单发：JSON mode / 强制 tool_choice 与自由工具循环互斥，需要
    「调查→结构化产出」时先跑 agent loop 再喂 structured 调用。
  - generator/splitter 维持 extraBody JSON mode（经 runtime）：迁去 runStructuredTask
    属可选优化，留作后续小 PR。

## 8. 收官状态（2026-07-25）

统一目标达成：所有 AI 功能（续写/润色/改写/总结/自定义/Agent 模式/对话助手/
记忆摘要外的 lore 全家桶）共享同一 runtime、注册表、事件流与安全分级。
剩余已知优化（无阻塞，按需开小 PR）：memoryStore 摘要生成迁 preset、
generator/splitter 换 runStructuredTask、对话会话持久化（重启后恢复）、
向量检索兜底召回（见 lore-facet-plan 后续方向）。

### 8.1 后续修正（2026-07-28）：对话助手「只给方案不动手」

作者要求对话助手整理知识库，它反复输出方案、明确命令也不执行。两个原因叠加：

1. **Agent 指令活不过第一轮。** `ai.instructions.agent` 被拼进首轮 task 层，
   而第二轮起 agentStore 只往 history 追加裸 user 消息。全程唯一常驻的
   system 消息是写作提示词，里面还写着「零附加评论／只输出所请求的写作内容」——
   于是「去执行」落进了一个唯一稳定指令是「写散文」的上下文里。
   **修正**：agent 指令改由 system 层承载（写作提示词 + agent 指令拼接），
   并在指令里显式声明其优先于「只输出写作内容」这一条。
2. **「整理」所需的工具不存在。** 合并重复、改分类、删废弃条目都没有对应工具
   （`update_lore_file` 还明确拒绝改 category），模型调查完也无从下手。
   **修正**：补 `move_lore_entity` / `delete_lore_entity`（见 3.2），
   `AGENT_ASSIST_PRESET` 轮数 12 → 20（整理全量 lore 是 list + 逐个 read 才
   开始写，轮数用尽在作者看来同样是「不肯动手」）。

   > **2026-08-16 再放宽 20 → 40。** 同一条理由的第二次触发：`rewrite_document`
   > 让「整篇排版」成为可表达的活儿之后，一章正文得靠 `read_file` 每次 4000 字
   > 分页读完才能动手，长章节光是读就吃掉大半预算。这个数同时也是轮数上限卡片上
   > 按一次「继续」所加的轮数（`agentStore` 把 `maxRounds` 原样当增量传过去），
   > 所以它定的既是初始天花板，也是「再来一段」的粒度。

### 8.2 方案门控（`lib/agent/plan.ts`）

上一节让 agent 肯动手之后，作者提的第二个要求是「改知识库必须先出方案、经我同意，
且落盘的必须就是方案里那几条」。做法不是把 lore 写工具升到 L2（逐次弹 diff 卡片，
整理十个条目要点十次），而是把审批提前到**方案**这一层：

- `propose_lore_plan` 阻塞在作者的决定上，一张卡片列出全部步骤
  （action + entity + 可选 file + detail）。批准即把步骤记进本次运行的 `PlanGate`。
- 四个 lore 写工具落盘前过 `checkPlan`：没有覆盖当前「动作 + 实体（+ 文件）」的
  已批准步骤就直接返回错误，错误文案里附上已批准步骤清单和「要改就重新提方案」的
  指引（光拒绝会让模型原样重试）。
- 实体匹配走 `findEntityByName` 解析后比对，方案写「Ava」而写入用别名「阿瓦」
  不会被误拒；`create` 没有落盘实体，退回字符串比对。
- 步骤声明了 `file` 就把写入钉死在那个文件，没声明则该实体下任意文件都放行。
- 门控**按运行**存活：批准只对这一次请求有效，下一轮重新问。同一次运行里再批一份
  方案是**追加**（不撤销先前步骤），返回值里带上前一份尚未兑现的步骤。
- 能保证的是「改了哪个实体的哪个文件、做了什么动作」，保证不了正文措辞——所以命中的
  步骤 `detail` 会回写进工具结果，作者在执行日志里能把「说要改什么」和「实际改了什么」
  并排看。
- UI：`components/ai/PlanCard.tsx`，与 ApprovalCard 并列渲染在 AgentChat 与 AiPanel
  的输入框上方；队列 `pendingPlans` 在 agentStore，abort/收尾同样走 `rejectAll`。
- `ai.instructions.agent` 里写死这套流程，并强调「方案只能通过工具提交，写在回复里
  作者看不到批准按钮」——否则模型会退回上一节那个只在聊天里空谈方案的老毛病。

### 8.3 特征级工具（2026-07-28）

8.1 补的两个工具都是**实体级**的，作者随即发现「只能整个删掉条目，没有调特征的手段」。
盘下来实际缺口有两处，都补了（见 3.2）：

- **删单个特征：以前做不到。** `update_lore_file` 要求 content 非空，没有删除路径；
  能删的只有 `delete_lore_entity`（整个角色）。→ `delete_lore_file`，先备份再
  removeFile，index.md / images.md 拒绝。
- **只调特征元数据：以前要整篇重发。** 改几个 keys 也得通过 `update_lore_file`
  把正文原样吐一遍——既费 token，又有「说好只改关键词，顺手把正文改写了」的漂移风险，
  而且 YAML 得模型手写（`serializeFacetFrontmatter` 会把 keys JSON 引号化以保证 CJK
  与逗号能原样往返，手写容易走样）。→ `update_facet_meta` 只重写 frontmatter，
  body 经 parseFrontmatter 原样带过；未传的字段保持原值；`mode=auto` 且 keys 为空时
  在结果里明确警告「这条特征永远不会被注入」。
- 特征**新建**没有单独开工具：`update_lore_file` 传一个新文件名即可，够用。
- 两个新工具都从磁盘读当前状态（而非运行快照），因为同一次运行里刚由
  `update_lore_file` 建出来的特征还不在快照里；写完再回填/剔除快照条目。

**顺带修掉一个门控漏洞：** `checkPlan` 原来的文件匹配是
`!s.file || !file || 同名`——步骤带 file、调用不带 file 时会命中。于是一条
「delete Ava / armor.md」的方案步骤能授权 `delete_lore_entity` 删掉整个 Ava。
改成「步骤声明了 file，调用就必须给出同一个 file」。删单个特征与删整个条目现在
是两条互不越权的步骤，`PlanCard` 上也分别显示为 `DELETE Ava / armor.md` 与
`DELETE Ava`。

### 8.4 手术刀级的条目编辑（2026-08-19）

8.3 只给特征开了「不必整篇重发」的口子，实体本身没有。作者盘的是同一件事的另外三种形态：
**只改一个 metadata、只搬一下分类、只追加一段**，凭什么都要重写整个条目。

盘完的结论是：搬分类本来就不用重写（`move_lore_entity` 从 8.1 起就是唯一途径，
`update_lore_file` 明确拒绝改 category），特征元数据也不用（8.3 的 `update_facet_meta`）。
真缺的是三处，都补了（见 3.2）：

- **实体的 summary / aliases：以前只能整篇重发。** 特征有 `update_facet_meta`，
  实体却没有对等物，改一句 summary 也要 `update_lore_file` 把正文原样吐一遍。
  → `update_lore_meta`，从磁盘读 frontmatter、body 经 parseFrontmatter 原样带过，
  未传的字段保持原值。**name / category 故意不收**：这两个会搬动实体文件夹，
  而文件夹位置才是扫描器认的真相——同一件事有两个入口，迟早有一个是错的。
  别名冲突照 `move_lore_entity` 改名时的规矩拒绝（两个条目都会变得按名字解析不出来）。
- **追加内容：以前没有任何途径。** 正文侧的 `append_file` / `propose_edit` 都被
  `manuscriptTarget` 挡在 `.ai-writer/` 外（挡得对：那会绕过方案门控），知识库侧就只剩
  整文件替换。→ `append_lore_file`，只发新增的那一段，前面的字节既不重发也不重读，
  因而**不可能被这次写坏**。与正文侧的 `append_file` 有一处故意不同：分隔的空行由工具补，
  不让模型自己拼——正文里那个接缝是作者的决定，而这里的载荷是 markdown 结构
  （一个新的 `##`、又一条列表项），少一个空行就会静默焊到上一段末尾。
  开头是 `---` 的 content 直接拒绝：那是模型把整份文件当增量发了，追加进去会在正文中间
  留一块游离的 frontmatter。
- **改错一句话：以前得整篇重发。** → `edit_lore_file`，正文侧 `propose_edit` 的知识库版
  （唯一 find + 替换），只是它是 L1：方案覆盖到了就直接落盘 + 备份。

三个工具都用 `splitFrontmatter` 把文件切成「frontmatter 原始字节 + 正文」，写回时 head 原样拼回。
这不是省事，是**结构校验因此不再需要**：够不着 frontmatter 的写入，改不了 category、
丢不掉 `name`、也不可能把 `facet:` 写没了而让一条特征悄悄停止注入——
`update_lore_file` 那三道落盘前校验防的正是这些。`edit_lore_file` 的 find 只在正文里匹配，
命中 frontmatter 时报错直接把模型指去 `update_lore_meta` / `update_facet_meta`。

**为什么值得开三个而不是让模型多花点 token 重发：** 重发的代价不只是把内容付两遍钱，
而是每一个被重新吐出来的字符都是模型可以顺手改写的字符——「说好只改 summary，
正文措辞也变了」这类漂移，作者唯一能发现它的方式是读完整篇 diff，也就等于发现不了。
工具层面够不着的东西，才是真的不会被改。

`ai.instructions.agent`（中英两份）里改成按**改动大小**挑工具，`update_lore_file`
明确降级为最后手段——工具存在但提示词不引导，模型还是会走它最熟的那条路。

### 8.5 定位到「第几处」（2026-08-19）

§8.4 收尾时顺手审了正文侧和 pptx 导出这条链路，问的是同一个问题：**还有哪里是小改动被迫整篇重发的。**
`export_pptx` 本身干净（它不重写任何东西，只把已有 .html 转出来，且转换全程不过模型），
`append_file` 也干净。真正的洞在 `propose_edit` 的唯一性规则上。

那条规则对散文是对的——一段散文天然唯一。对**结构化文件**则完全不成立：一份演示稿 HTML 是
N 个结构相同的 `<section class="slide">`，表格里同一句话出现在十几行。改第 7 页的标题，
若第 12 页标题相同就得把 `find` 撑到包含周边标记；两页真的逐字节相同时**无解**。
唯一的退路是 `rewrite_document`——而它把整份新内容当一个工具参数发，
60k 字符的 deck 在输出上限 8k/16k tokens 的模型上必然截断，
**而截断的调用什么都不写**，前面为了读全文花掉的十几次 `read_file` 一起报废。
也就是说：这个工具最需要它的文件尺寸，恰恰是它跑不完的尺寸。
（`REWRITE_MIN_RATIO` 那道护栏只防「少写」，不防截断——截断发生在工具调用层，到不了那个检查。）

补的是两件事：

- **`propose_edit` 收 `occurrence`（1 起数）与 `replace_all`。** 歧义只有在调用**没有解决它**时才是错误；
  错误文案改成把三条出路一起说清（加上下文让 find 唯一 / `occurrence=N` / `replace_all=true`），
  因为原来那句光拒绝的话，模型的下一步就是退回 `rewrite_document`。
  「全文统一某个说法」现在也不必再整篇重发了。
- **`read_slides` 能读 .html 了**（`lib/pptx/htmlSlides.ts`，纯文本切分）。
  前一条要好用，模型得先能便宜地定位到第 7 页；而此前 .html 只能用 `read_file` 按 4000 字符盲翻。
  同一个工具而不是第二个：模型的问题是「给我看第 7 页」，deck 存成哪种格式不属于这个问题。
  返回的是**逐字节的原始源码**，因为它拿到之后的下一个动作就是把其中一段抄进 `propose_edit`。

两个决定值得记下理由：

- **审批的安全性质换了一种守法。** 旧的唯一性规则同时守着两头：提案端拒绝歧义，落盘端也拒绝
  （`applyEdit` 的 `first !== lastIndexOf`）。允许 find 重复之后这条就没了，替代品是
  **提案记录当时的出现次数**（`EditProposal.occurrences`），落盘时重新计数、对不上就拒绝。
  作者在卡片等着的时候继续打字改变了次数，写入就落到他们没看过的位置上——这正是原规则真正在防的东西，
  而它现在被防得更准：不是「多于一处就不行」，而是「和你看到的那一份不一样就不行」。
  纯逻辑抽进 `lib/agent/editApply.ts` 单独测试。
- **切分约定与 `harvester.js` 共用，且必须共用。** 那边的 `SLIDE_SELECTORS` 决定导出时什么算一页；
  这边若自成一套，「第 7 页」在读和导出时就是两个东西，作者审「第 7 页的改动」会看错框。
  harvester.js 是以原始文本注入沙箱帧的（它 import 不了任何东西），所以这份不变量靠
  `htmlSlides.ts` 的模块注释和 `htmlSlides.test.ts` 守——改任一边都要同步另一边。
  切分是**纯文本**的：`harvest.ts` 那个离屏帧的存在意义是**量**页面（需要布局），
  而切源码不需要布局，纯函数才是能承载测试的那部分。

`replace_all` 与「本次都批准」的关系是刻意不动的：一次 `replace_all` 是**一张卡片管 N 处**，
而没有它的时候同样这 N 处会变成 N 次单点编辑——授权覆盖的范围没变，卡片数反而少了，
而卡片上那行「替换全部 N 处」用的是告警色，正是为了让这个数字不被当成一处看。

仍然没做：`rewrite_document` 的分段路径（整篇重排撞输出上限时依旧没有出路）。
`occurrence` + `replace_all` 把「重复文本」这个最常见的诱因消掉之后，剩下的场景要小得多，
留作单独一轮再看。**（§8.6 做了。）**

### 8.6 `rewrite_lines`：改写也能分段了（2026-08-19）

§8.5 结尾留的那条。创建端早就有分段故事——`create_file` 写骨架、`append_file` 一节一节补，
理由写在提示词里：一次性输出撞输出上限，**被截断的调用什么都不写**。
改写端一直没有对等物：`rewrite_document` 把整份新内容当一个工具参数发，
所以它最需要被用上的文件尺寸，恰恰是它跑不完的尺寸，而且失败时连前面十几次 `read_file` 一起赔进去。

`propose_edit` 也表达不了「把这一整块重排」——除非把每一行原文都抄进 `find`，
那正是这件事要省掉的输出，还附赠一种新的失败方式（抄错一个字符就找不到）。

**做法：让模型只说范围，不说原文。** `rewrite_lines(path, start_line, end_line, content)`
自己去盘上取那几行，然后构造一个**普通的 edit 提案**：`find` = 那几行的原文，`replace` = 模型发来的内容。
卡片、审批、落盘路径、以及 §8.5 那套「次数对不上就拒绝」的守法，全部原样复用。
这里没有新的写入种类，新的只是「模型不必把旧文本念一遍」。
整篇重排于是变成 K 次调用，每次都真正落盘，截断只损失一段。

几个细节值得记：

- **坐标用行号，因为模型手里就是行号。** `read_file` 的尾注给 `lines a-b of N`，
  `search_text` 给 `L34`——「从第 34 行开始重写」是这些工具的直接后续动作，
  不需要再发明一套锚点，也就没有锚点唯一性问题。
- **行号会漂，所以提案仍按 `find` 定位。** 改完一段，后面的行号就变了。
  工具结果里明写了这件事（重新读，或者从文件末尾往前做），
  但真正的保险是：落盘时 `applyFindReplace` 按原文重新定位并核对出现次数，
  漂了就拒绝而不是写错地方。
- **一段行范围不保证唯一**（两页幻灯片可以逐字节相同），所以提案要记下它取的是**第几处**
  （`occurrenceAt`）。没有这一条，落盘会重定位到第一处，改错那一页。
- **切片按字符偏移取，不是 `split("\n").join("\n")`。** 后者会把 CRLF 文件的这一段悄悄变成 LF，
  文件其余部分还是 CRLF。范围**包含最后一行的换行符**，替换内容缺了就补上——
  否则下一行会被焊到这段末尾（与 `append_lore_file` 补空行是同一类判断：
  这种细节在长文档里只会错一次，而错的样子是一个损坏的标题）。
- **`end_line` 超出末尾按末尾算**（「从第 300 行到结尾」是很正常的意思，
  模型在读到那里之前无从知道最后一行是几），但 **`start_line` 超出就报错**——那里根本没有可改的区域。
- 卡片上多一行「第 a–b 行」。作者要知道自己批的是文件的一个区段，而不是某处片段。

`rewrite_document` 保留：短文件一张卡片看完整个新版本，仍然是最诚实的审批单位。
它的描述改成了「只在整份新内容能舒服地放进一次回复时用」，并指向 `rewrite_lines`；
输出被截断时那条系统提示（`truncatedToolCall`）也补了同一句——那正是模型撞上这件事的时刻。

## 9. 知识库工具评审补丁（2026-08-24 · claude/lore-management-tools-review）

对「agent 管理知识库」的一次系统评审（重组 / 合并拆分 / 元数据三类操作 + 工具标准统一）落下的六个修复。逐条记录**为什么**，实现细节看 `writeTools.ts` 对应函数的注释。

### 9.1 update_lore_file 不再是绕过通道（评审发现 1）

整篇重写 index.md 曾经可以顺手改 `name`、加冲突别名、翻 `dict` 开关——三件事各自有守门的专用工具（`move_lore_entity` 的重名检查 + 旧名转别名、`update_lore_meta` 的别名冲突检查、条目编辑器里作者亲手设的词典标记），全量写把它们全部旁路。现在 index.md 的结构校验多三条：`name` 不许变（指向 move_lore_entity）、`dict` 不许翻、**新引入的**别名过同一套冲突检查（既有冲突不拦无关编辑，与 update_lore_meta 同规）。

### 9.2 合并的顺序是固定的，错误信息负责教学（评审发现 2）

合并两个条目的自然顺序（拷贝 → 加别名 → 删除）会在第二步撞上别名冲突检查——败者还活着，它的名字还在解析。旧错误信息说「Drop it, or merge the two entities」，在合并进行中读到这句是循环建议。现在：`delete_lore_entity` 的描述写明三步固定顺序（拷贝 → **删除** → 才加别名），所有别名冲突错误共用 `MERGE_ALIAS_HINT` 教同一个顺序，agent briefing（zh/en）同步。没有做「计划里有 delete 步骤就放行别名」的豁免：运行中断在加别名之后、删除之前，会留下一个持久的二义性解析，教顺序比开后门稳。

### 9.3 配图子项进入 agent 能力面（评审发现 3）

此前 images.md 对 agent 只读，配图只能加（generate_image）不能改描述/槽位、不能删、不能设头像——而描述是纯文本模型看到的全部，槽位正是类型系统 imageSlots 的落点。新增三个 L1 工具（都在 `lore_write` 延迟组、都过 plan 门控、都有备份）：

- `update_lore_image`（desc / slot，槽位按 category 的 imageSlots 校验，空串清除——与 update_facet_meta 同一套约定）
- `delete_lore_image`（二进制**搬进** backups 而不是 unlink——`backupFileByMove`，文本备份救不了二进制，搬移本身就是备份）
- `set_lore_avatar`（从本条目 gallery 或项目内图片提升；旧头像先搬 backups）

读侧同步：`read_lore_entity` 的 gallery 行带 `[slot: …]`，新增 `=== image slots ===` 清单（`imageSlotChecklistText`）；`generate_image` 新增 `slot` 参数、`edit_image` 的重绘继承原图槽位（`IllustrateProposal.dest.slot` → `illustrate.ts` 落盘）。

### 9.4 copy_lore_file：逐字节搬运，不经模型的手（评审发现 4）

合并与「特征升格为独立条目」此前必须读出→由模型在工具参数里重发正文，这正是外科手术工具族一直防的悄悄改写。`copy_lore_file` 把一个特征 .md（连 frontmatter）或一张 gallery 图（连描述和槽位）逐字节复制到另一个条目；源不动，「移动」= 复制 + 源侧 delete_lore_file/delete_lore_image（各自的计划步骤）。槽位跨分类原样携带（与 facet 的 slot 同一条降级规则）。

### 9.5 分类没有工具，错误信息说明去哪建（评审发现 5）

分类 CRUD 留在 UI（能力包 + 作者自定义）是有意的边界；补的是**说明**：所有「未知分类」错误和 create/move 的 category 参数描述都指明「请作者在 设置 → 工作台 或知识库墙上创建」，briefing 同步，模型不再靠撞 enum 猜。

### 9.6 改名连目录一起改（评审发现 6）

`saveEntityMetaAndBody` 现在在**名字变化**时按新名重新 slug 目录（同分类内 rename；爆炸半径与换分类搬目录完全一致：`[[lore:分类/id]]` 路径引文和 facet pin 失效，两者本就容忍——引文回退到按名解析，失效 pin 被跳过）。只在名字变时才重 slug：slug(name) 与存量 id 常年不相等（冲突后缀、历史 id），逐次保存都重排目录会把无关保存变成搬家。UI 与 agent 共用这一个函数，行为一致。

### 9.7 标准统一

- 读工具参数 `name` → `entity`（写工具从来是 `entity`；en briefing 早已按 `entity` 写，此前是潜在错位）。执行层兼容旧拼写。
- 工具预算棘轮上调有账：整套 9,743 → 11,237（新工具 ~1.4k token **全部在延迟组**，方案批准后才上线）；常驻 7,201 → 7,554（只涨了 generate_image 的 slot 参数和读侧措辞）。见 `agentToolBudget.test.ts` 注释。

## 10. 工具面约定（2026-08-24 · claude/agent-tool-standards-alignment）

§9 修的是知识库工具、`docs/reference/architecture.md` → Organising files 记的是文件工具。第三轮扫的是**其余 24 个**（发现/门控、生图、拆分收集器、任务工作区、扮演、委托/流水线），但结论不是又一批修复清单——三轮下来，找到的缺陷是**同一个形状**：不是某个工具坏了，而是**一样东西有两个名字**。

- 读工具用 `name` 寻址条目，写工具用 `entity`（§9.7 已修）
- 一张图的说明对造它的工具叫 `note`，对改它的工具叫 `desc`（本轮修）
- 一个场景在 schema 里叫 `agent`，而工具名、`list_scenes` 的输出、每一句参数说明都叫它 "scene id"（本轮修）

每一处的代价都是一次错误调用，而且**没有一处会让任何测试失败**——审阅者拿一个工具去比另外四十个，正是那个看不出来的读者。所以这轮的产出主要不是改名，是把约定变成机器检查：`src/lib/__tests__/agentToolConventions.test.ts`。

### 10.1 钉住的约定

| 约定 | 内容 |
|---|---|
| 寻址参数以**被寻址物**命名 | `entity` / `scene` / `workflow` / `path`。裸 `name` 一律不行——它什么也没说。`create_lore_entity({name})` 例外且保留：那是**要给的名字**，不是被寻址的东西 |
| 一个概念一个拼法 | `desc`（不是 note/caption/alt）、`references`（不是 refs）、`query`、`folder`、`scene`（不是 agent） |
| 翻页 vs 读范围 | 往后翻用 `start_line`/`start_slide`（工具自己在尾注给下一个游标），读**命名范围**用 `from`/`to`。两种是不同的访问模式、各留各的名字；不许出现第三种拼法（`offset`/`begin`/`first`/`since` 直接报错），也不许有 `to` 没有 `from` |
| 卡片对面的人是 **the author** | 不是 the user。半数手稿工具原先说 user、知识库工具说 author，对模型读起来是两个人 |
| 检索工具必须自报匹配语义 | 「literal、case-insensitive」——不写模型就会开始写正则 |

`ALL_TOOL_IDS` 因此从注册表**派生**而不是手抄：手抄的清单必然在它写下的第二天就停止覆盖新工具，而那种失败是静默的。测试自己带一条计数守卫（>40 个工具 + 抽查五个家族 + 确认参数真的解析出来了），因为这一整个文件是对全集的循环——集合空了的话，每条断言都会变成真的。

### 10.2 本轮的改名（全部接受旧拼法）

| 工具 | 旧 | 新 | 为什么 |
|---|---|---|---|
| `read_scene` / `search_scenes` / `read_scene_summary` / `read_scene_memory` | `agent` | `scene` | 模型面对的词汇从来是「场景」；值仍是 agent id（一角色一场，两者同一），改的只是线上的名字 |
| `generate_image` / `edit_image` | `note` | `desc` | 写的就是 images.md 的 `desc` 字段，`update_lore_image`（§9.3）改的也是它 |
| `read_workflow` | `name` | `workflow` | 让「没有寻址参数叫裸 name」成为可检查的不变量 |
| `delegate` | `refs` | `references` | 与 `generate_image.references` 同名，且这个代码库不用缩写 |

改名当天在飞的会话仍会发旧参数，所以**每一处都接受旧拼法**（`args.scene ?? args.agent`），并在 `sceneTools.ts` / `imageTools.ts` / `subagent.ts` 就地注明这是 1.28 之前的拼法。`workflowTool.test.ts` 与新增的 `sceneTools.test.ts` 各有一条用例专门跑兼容路径——改名的症状会是「旁白突然说不认识这个场景」，那是要被测试挡住的东西。

### 10.3 顺带修掉的措辞漂移

- `search_scenes` 缺「literal / case-insensitive」那句（`search_text` 和 `search_conversation` 都有）。
- `include_closed` 在 `read_scene_memory` 和 `recall` 上是两句不同的说明；统一到指名状态值的那句（"kept (done) and called-off (void)"）。
- `translate` 的拒绝文案还是 "The user REJECTED"——#305 扫了 registry / writeTools / imageTools，漏了 `lib/translate/tool.ts`。现在由 10.1 的测试覆盖，不会再漏。

## 11. add_lore_image：把已有的图归档进条目（2026-08-24）

作者的报告：**「让 agent 把某张图加进某个条目,它做不到,反而去调生图工具。」**

不是模型判断失误。§9.3 补配图工具时，补的是「改一张**已经在** gallery 里的图」——描述、槽位、删除、设头像。**「让一张图进到 gallery 里」这件事本身**当时没补，而能做到它的四条路径里，三条是 UI 或生成：

| 路径 | 谁 | 图从哪来 |
|---|---|---|
| `LoreDetail.tsx` | 作者在界面里选 | 磁盘任意文件 |
| `LoreImageGenModal.tsx` | 作者在界面里生成 | 模型画的 |
| `illustrate.ts`（`generate_image` / `edit_image`） | agent | **只能是模型画的** |
| `copy_lore_file`（§9.4） | agent | **只能来自另一个条目** |

于是对 agent 来说，「一张图出现在这个条目的 gallery 里」这个**结果**只有一扇门，就是 `generate_image`。模型去够它是唯一够得着的东西，代价是画了一张作者没要的图并且**收了钱**。

同一轮里还留下一处刺眼的不对称：`set_lore_avatar` 是收项目路径的。也就是说 agent 能把项目里的一张图设成条目头像，却不能把同一张图放进那个条目的 gallery。

`add_lore_image(entity, path, desc?, slot?)` 补上这扇门。几处刻意的选择：

- **复制而不是移动**。那张图很可能是文档配图或作者留着的参考图，它在原地还有用途——和 `set_lore_avatar` 同一条规矩。
- **没写 `desc` 会警告**。文字模型看得见的只有描述，一张没有描述的图对它等于一个文件名。和 `update_facet_meta` 警告「这个特征永远不会被注入」是同一类：写入成功，但成果是哑的，那就得说出来。
- **`generate_image` 的描述里加一句指路**（「这会花钱，只用于还不存在的图；项目里已有的用 `add_lore_image`」）。这 69 token 是常驻的、也是这次唯一的常驻涨幅——工具本体在 `lore_write` 延迟组里。缺口补上了，但让模型**别再走错门**的是这句话。
- 重名不覆盖，`addLoreImage` 自动编号（`portrait-2.png`）。

留下的教训，与 §10 是同一条：能力面上的缺口不会表现为报错，而是表现为**模型去够旁边那个最像的工具**。§10 的约定测试查的是「一个概念两个名字」，查不出「一件事没有门」。这一处是靠作者撞上才发现的。

## 12. 跟随最新 ≠ 强制置底（2026-08-25）

作者的报告：**「助手在 thinking 的时候，对话框被强制滚到最下面，没法看历史信息。」**

AgentChat 原本每次 `turns` 变化都写一次 `scrollTop = scrollHeight`。一次 agent 运行里这个变化来自每一个 agent 事件——每段 reasoning、每次工具调用、每个 chunk。于是「往上翻」在运行期间**物理上做不到**：滚上去的那一帧就被下一个事件拉回底部。运行越长（正是最需要回看的那种），越翻不动。

改法是把置底从**反射**变成**模式**（`components/common/useStickToBottom.ts`）：

- 视口停在底部（40px 内的余量）时跟随状态是**开**的，新内容照旧贴着底走；读者滚开就**关**，后续 chunk 一律不再动滚动位置。读者是在读还是在等，除了「视线在不在最新那一端」之外没有别的证据可用。
- 40px 的余量不是随手取的：滚轮很少停在最后一个像素上，把一格轻微的滑动判成「去翻历史了」会在流式输出中途把作者甩下车。
- 关的时候，转录区右下浮起一枚「回到最新」——按下就跳到最新并**重新开**跟随。发消息（含排队后自动发出的那条）也重新开：提问本身就是「我要看这个答案」。
- 开关状态存在 ref 里而不只是 state：`follow()` 跑在内容刚长出来的那个 layout effect 里，早于 React 把新 state 送回来的时机。

按钮**挂在滚动容器的外面一层**（新增的 `.viewport`）。`position: relative` 加在 `overflow: auto` 的元素上，绝对定位的子元素会跟着内容一起滚走——按钮会在读者往上翻的时候飘出视野，恰好是它唯一有用的那一刻。

同样的强制置底还留在 AiPanel 的输出区和扮演面板（`RoleplayChat`）里，本轮没动——那两处的运行时长和日志密度都低一档，作者报的也不是它们。真要动，`useStickToBottom` 是现成的。
