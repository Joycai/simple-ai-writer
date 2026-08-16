# 统一 AI Agent 系统方案（v0.3.0 · feat/unified-agent）

> 目标：把目前分散在编辑器侧与 lore 侧的所有 AI 功能，统一到**一套 agent runtime**
> 上运行 —— 该 runtime 提供 tool loop，模型可以按需发现 lore、阅读章节文本、
> 更新记忆/设定，或依据文本与用户输入修改、新增 lore。
>
> 交互形态采用**两阶段演进**：第一阶段统一底层 runtime（现有 UI 入口全部改为
> 调用它，行为对用户基本无感）；第二阶段把 AiRail 长成对话式统一助手。

## 1. 现状盘点：分散的 AI 入口

当前共约 9 处各自组装 prompt、各自管理流式状态的 AI 调用点：

| 入口 | 位置 | 形态 | 上下文来源 |
| --- | --- | --- | --- |
| 续写 continue | `stores/aiTaskStore.ts` | **agent loop**（唯一） | 预算化 RAG 注入 + 4 个只读工具 |
| 润色/改写/总结/自定义 | `stores/aiTaskStore.ts` | 单次流式 | 预算化 RAG 注入 |
| 前情记忆摘要 | `stores/memoryStore.ts` | 单次流式 | 分段正文切片 |
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
| `list_lore_entities` / `read_lore_entity` | 读 | 设定侧只读，原样迁入 |
| `list_files` | 读 | 递归列出 writing/ 全树（含分卷子目录），按 `ls -R` 分组输出：绝对目录路径一行，其下文件名缩进。不逐行重复项目前缀是为了省 context——几百章各带一遍长前缀，光目录就能吃掉几千 token |
| `read_file` | 读 | 单次上限 4000 字符，**按行边界切**；截断时回报 `lines a-b of N` 与下一个 `start_line`，长章节可顺序翻页。分页坐标用行号而非字符偏移，因为 `search_text` 给的就是行号（`L34`），「从第 34 行读」是直接的后续动作 |
| `search_text` | 读 | 在 writing/ 内全文检索：递归扫所有章节文件，返回 `路径 + 行号 + 片段`。字面匹配、大小写不敏感，**不支持正则**（模型给的病态正则会卡死 UI 线程且无法中断）。结果有上限（全局 40 行 / 单文件 8 行），长段落按命中位置开窗截断——否则一个常用词就能吃光整个上下文 |
| `read_memory` | 读 | 读当前文档的前情记忆 |
| `propose_lore_plan` | 写·审批 | 提交设定改动方案（步骤 = action + entity + detail），阻塞等作者批准；**四个 lore 写工具的准入门槛** |
| `create_lore_entity` | 写·L1 | 新建实体（name/category/summary/content），落盘前校验 frontmatter |
| `update_lore_file` | 写·L1 | 改写实体的 index.md 或特征 md（整文件替换，沿用 splitter 的逐字校验思路） |
| `update_facet_meta` | 写·L1 | 只改某个特征的 keys/group/priority/mode/title，正文原样保留（走 saveFacetFile 序列化，模型不用手写 YAML） |
| `delete_lore_file` | 写·L1 | 删掉实体下的单个特征/附件 md（先备份；index.md 与 images.md 拒绝） |
| `move_lore_entity` | 写·L1 | 改名 / 换分类。换分类只能走它——扫描器认的是文件夹位置，只改 frontmatter 会在下次重扫时被还原 |
| `delete_lore_entity` | 写·L1 | 删除实体：整个文件夹 rename 进 `.ai-writer/backups/deleted-…`，图库等二进制资产一并保住，可整目录搬回还原 |
| `update_memory` | 写·L1 | 更新前情记忆段落（走 memory.ts 的分段协议，不允许破坏元数据注释） |
| `propose_edit` | 写·L2 | 对 writing/ 正文提出修改（唯一 find + 新文本），**只产生提案不落盘** |
| `rewrite_document` | 写·L2 | 整文件替换 writing/ 下的某个正文文件（完整新内容），**只产生提案不落盘** |
| `create_chapter` | 写·L2 | 新建章节（完整路径 + 开篇正文）。路径里不存在的文件夹一并创建——新开一卷就是这么来的。审批卡用 `renderMarkdown` 渲染正文预览 |
| `move_chapter` | 写·L2 | 改名 / 移到别的卷（同一个操作，表达为新的完整路径），也可作用于分卷文件夹。目标已存在则拒绝，移进自己的子树则拒绝 |
| `delete_chapter` | 写·L2 | 删**单个**章节文件，批准后移入 `.ai-writer/backups` 可恢复。**分卷文件夹一律拒绝**——删整卷的爆炸半径是作者自己的决定，不该在运行中间用一张卡片批掉 |

> 结构类操作全部走 L2 而非 lore 那样的 L1 自动应用：正文的所有权感比设定强得多，删一章的破坏性也远大于改一个设定文件。也**没有**对应的 `propose_chapter_plan` 前置门——每个操作各自一张卡，大改结构就是好几张，换来的是每一步都看得见、可单独拒绝。真觉得烦了再加门比反过来容易。
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
- 所有路径参数一律过 `isPathWithin`，写类工具额外限定在
  `.ai-writer/lore/`、`.ai-writer/memory/`、`writing/` 白名单内。

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
    preset（带 list/read lore 只读工具，maxRounds 4），modal 内嵌执行日志——AI 改设定
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
    AgentLog）。首轮经 assembleContext 注入设定/记忆/正文窗口，后续轮只追加 user
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

作者要求对话助手整理设定，它反复输出方案、明确命令也不执行。两个原因叠加：

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

上一节让 agent 肯动手之后，作者提的第二个要求是「改设定必须先出方案、经我同意，
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
