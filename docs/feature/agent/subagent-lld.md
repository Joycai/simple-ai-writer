# 长任务工作区与子代理 详细设计文档（Low-Level Design）

> **状态**：PR-A~PR-E 全部实现。`imageModelId` 的配置归口已在 PR #178（`feat(agent): 图片生成成为子代理`，commit `a785584`）完成——`imagegen` 成为独立 `SubAgentKind`，绑定模型迁移进 `ai:subagent:imagegen:*` 前缀，`SubAgentsPane.tsx` 提供配置 UI；本文 §8 的文件改动清单止于 PR-E，未覆盖该次追加。
> **关联 High-Level Design**：[`docs/feature/agent/subagent-plan.md`](subagent-plan.md)
> **基建依赖**：[`unified-agent-plan.md`](unified-agent-plan.md)（统一 Agent Runtime）、[`chat-memory-plan.md`](chat-memory-plan.md)（会话折叠压缩）、[`anthropic-plan.md`](../../api/anthropic-plan.md) §10（服务端工具）
> **分支**：`feat/task-workspace-and-subagents`

---

## 0. 修订记录

本文是第二版。第一版（另一模型产出）的骨架被保留，以下内容经对照代码后修正：

| 类别 | 修正 |
| :--- | :--- |
| **致命** | `search` 子代理原设计 `tools: []`，会被 `runtime.ts` 的 `withholdTools` 连带撤掉 `serverTools`，**永远不会联网**。改为在 `TaskPreset` 上引入显式的 `serverTools` 策略字段（§5.2.1） |
| **致命** | checkpoint 提示原设计永久 `push` 进 history，与 `forcedTextNotice` 已修过的坑同类（一次性话术变成常驻指令）。改为发出即撤（§4.2） |
| **致命** | 原设计用 `extractLastAssistantText(subMessages)` 取子代理产出。runtime 在成文轮**直接 return，文本从不入 history**，取到的必然是空或上一轮。改为经 `onOutputText` 捕获（§5.3） |
| **API** | `read_project_image` → `read_image`；`AgentEventBase` 不存在（改用交叉类型）；`recordTokenUsage` 不存在（需先抽 `persistUsage`）；`costFor` 漏第 4 参 `cachedTokens`；`loadApiKey` 返回可空；`ctx.models/providers/activeTaskId` 均不在 `ToolContext` |
| **契约** | 「存盘暂停」无法经 `Promise<number>` 回传。`onRoundLimit` 契约改为判别联合，并新增 runtime 的提前退出路径（§4.3、§4.4） |
| **格式** | `task.md` 未真正沿用 `memory.ts`（后者是三行式注释）。且原设计步骤数据在 JSON 与正文中各存一份，双事实源。改为**步骤只存在于正文，按序号寻址**（§3.2） |
| **语义** | `ToolContext.multimodal` 的升级方向是反的——它是「能否把 base64 塞进**当前模型**」的闸，改成「链路上有人能看图」会让纯文本主模型收到读不了的图片。改为语义不动，路由改工具集（§6） |
| **需求** | vision 路由原被收窄为「仅当主模型是纯文本」，与 HLD「两边都支持时优先子代理」不符。改回 HLD 语义（§6.2） |
| **补充** | `activeTaskId` 的来源（原文未定义，却被所有新工具依赖）、嵌套日志的去重键冲突、同轮并发写 `task.md` 的丢更新、GC 的无界增长漏洞、与 chat 折叠的交互、测试计划、i18n 与 profile terms 约束 |

**2026-08-18 · 子代理设置页对齐设计稿 04（§7.4 改写）。** 原实现把每个 kind 摊成
一个 section + 两行（启用 / 选择模型），读起来是五组互不相干的开关；但子代理从来
是一个**对**——专家和跑它的模型，缺一半就等于零。改为一 kind 一张卡（`SubAgents.module.css`），
卡头一眼给出这对能不能用：状态点 + 名称 + 「需 web_search」这类前置条件芯片 +
就绪/需要处理/已停用 + 开关，卡身是说明、`执行模型` 绑定与轮次预算，警告作为
卡底的一条 caution strip。同时补了两件旧版没有的事实：**已启用但没绑到任何可解析
的模型**也是一条警告（`warnNoModel`——旧版只在绑了错模型时才出声，绑空反而安静），
以及按运行时的真实分界分组（`delegate` 可派发的四种 vs 只能当工具用的 `imagegen`）。
卡上的轮次预算/份数上限读 `SUB_PRESETS` 与 `MAX_PDF_*` 本身，不再手抄数字。

**2026-08-16 · 清单滞后提醒（§4.2.1）。** 任务清单不逐步推进、结尾"突然全部完成"的
成因是四层指令都没要求模型边做边勾；提示词层补齐后，runtime 再加一道确定性兜底：
连续 3 个工具轮没有 `task_progress` 落地且清单仍有未完成步骤时，注入带清单快照的
提醒（发出即撤，同 checkpoint 模式）。

**2026-08-15 · 任务工作区对齐设计稿 1g（§3.3 / §4.5 / §7.3）。** 对照 claude.ai/design
的 `02 AI 面板` 1g 屏复查后落三件事：note 文件加来源机器头（§3.3 第 2a 条），
`TaskWorkspaceView` 全面改到 1g 的视觉词汇（§7.3），会话 blob 携带 `taskId` 并顺手
修掉 `switchChatSession` 的工作区句柄泄漏（§4.5）。任务级 token 总账（`token_usage`
加 `taskId` 列）经确认仍然不做，1g 底栏的用量数字继续缺省。

**2026-08-14 · 执行日志重排（§7.2 / §7.3 改写）。** PR-A~E 全部落地后，面板上的信息量
本身成了问题：三条平级的事件流挤在一列里，子代理的执行过程更是藏在两层展开之下。
改为四段分层，并把 band ④（任务列表）定为**会话级**——它按会话存在，而 `AgentLog`
按对话轮次渲染，照搬会重复十份。

## 1. 背景与系统目标

当前 Agent Runtime（`lib/agent/runtime.ts`）的记忆完全依赖内存态的 wire message history（`StreamMessage[]`）。处理长任务（多次联网搜索、多文件阅读、图片理解）时存在三个结构缺陷：

1. **上下文膨胀与破坏性裁剪**：`trimHistory`（`runtime.ts:90`）为避免超窗，把旧工具结果整体替换为 `[earlier tool result dropped…]`，模型丢失中间结论后**重复搜索/阅读**，很快又填满；
2. **缺乏状态恢复**：撞到 `maxRounds` 时只有「继续加轮」与「强制收尾」两个出口，无法存档；
3. **主上下文污染**：搜索网页正文、图片 base64、长文切片直接灌进主模型上下文（观测到单次运行 8 次搜索 / 123k input token，见 `lib/ai/serverTools.ts` 的 `TRANSCRIPT_CHARS` 注释）。

**设计目标**：

1. **记忆落盘**：`.ai-writer/tasks/<taskId>/` 工作区，`task.md` 管目标与进度，`notes/*.md` 存中间结论 —— 使裁剪从「破坏性丢失」变为「可回读恢复」；
2. **状态化断点续跑**：恢复时基于 `task.md` + notes 索引启动**全新干净上下文**，不重放旧 wire history；
3. **单层单向委托**：`delegate` 工具，子代理用专属模型与独立 context 运行，主模型只收到「摘要 + 路径」；
4. **确定性能力路由**：在**工具集层**而非提示词层实现能力隔离。

---

## 2. 总体架构与数据流

```
                  ┌──────────────── 主 Agent（runAgent，全工具集）────────────────┐
                  │                                                              │
                  │  wire history ── trimHistory / compact（只管上下文，不管记忆）│
                  │       │                                                      │
                  │       ├── task_plan / task_progress / write_note ────────┐   │
                  │       │   read_note / list_notes                         │   │
                  │       │                                                  │   │
                  │       └── delegate(kind, task, refs) ──┐                 │   │
                  └───────────────────────────────────────┼─────────────────┼───┘
                                                          │                 │
                                   ┌──────────────────────▼──────┐          │
                                   │ 子代理（嵌套 runAgent）      │          │
                                   │  · 独立 ConnOptions          │          │
                                   │  · 全新 history（2 条消息）  │          │
                                   │  · 深度 1 · 只读             │          │
                                   │  · 共享 signal · 独立记账    │          │
                                   └──────────────┬───────────────┘          │
                                                  │ 产出经 onOutputText 落盘 │ 读写
                                                  ▼                          ▼
                                 .ai-writer/tasks/<taskId>/
                                   ├── task.md
                                   └── notes/{search,vision,read}-*.md
```

---

## 3. 任务工作区（Task Workspace）

### 3.1 目录结构、命名与生命周期归属

```
<projectPath>/.ai-writer/tasks/
  └── 20260814-163000-a1b2c3/
        ├── task.md
        └── notes/
              ├── search-east-nobles.md
              ├── vision-avatar-01.md
              └── read-ch45-summary.md
```

- **`taskId` 格式**：`YYYYMMDD-HHmmss-<6 位随机>`，严格时间序 + 唯一。
- **不进文档树**，不出现在文件树，不参与导出；**进 `projectBackup`**（不在 `PROJECT_BACKUP_EXCLUDES` 里，`projectBackup.ts:41`）。

#### 3.1.1 `activeTaskId` 从哪来 —— 懒创建

> 第一版把这件事留空了，但**所有新工具都依赖它**。这里定死。

绝大多数 run 是短任务，不该凭空产生一个任务目录。所以工作区**在第一次被需要时才创建**：

```ts
// lib/agent/taskWorkspace.ts
export interface TaskWorkspaceHandle {
  /** 已创建的任务 id；null 表示这次运行还没用到工作区。 */
  readonly taskId: string | null;
  /** 创建（或复用）本次运行的工作区。title 只在首次创建时用。 */
  ensure(title: string): Promise<{ taskId: string; dir: string }>;
}
```

- 由**发起 run 的调用方**构造一个 handle 放进 `ToolContext.taskWorkspace`，与 `lorePlan`（一次运行一个 `PlanGate`）同构；
- `AgentChat` 的会话把 handle 绑在 session 上（同一会话多轮共用一个任务），`AiPanel` 的单次任务绑在这一次 run 上；
- **可选字段**。lore modal、generator、splitter 等不传，此时 scratchpad 工具返回
  `"Error: this surface has no task workspace — do not call this tool here."`
  —— 与 `checkPlan` 在 `gate` 缺失时的措辞策略一致（`plan.ts:108`）。

### 3.2 `task.md` 协议格式

沿用 `context/memory.ts` **实际**的格式（`memory.ts:131` / `140`）：三行式注释头，`<!--` 与 `-->` 各自独占一行。

> 第一版写成单行 `<!-- ai-writer-task {json} -->`。这既与先例不符，也会在一个「邀请作者手改」的文件里产生一条几千字符的长行。

#### 关键决策：步骤只有一个事实源

`memory.ts` 的做法值得原样照搬 —— 它的元数据里**只有机器状态**（`from`/`to`/`hash`），人可编辑的摘要正文不在 JSON 里，段落按**出现顺序**与元数据配对，注释里明说「heading text is display-only so author edits to headings can't corrupt ranges」。

因此：**步骤的标题与状态只存在于正文的复选框列表里，JSON 里一个都不放。** 工具按 **1 基序号** 寻址步骤，于是连 `step.id` 都不需要。作者手改 `- [ ]` 为 `- [x]`，就是真的改了状态，不存在两份数据打架。

#### 文件内容

```markdown
<!-- ai-writer-task
{"taskId":"20260814-163000-a1b2c3","status":"in_progress","modelId":"mdl-7","createdAt":"2026-08-14T08:30:00.000Z","updatedAt":"2026-08-14T08:35:12.000Z","sourceRefs":[{"path":"writing/第03卷/第45章.md","hash":"3f8a9b1c"}]}
-->

# 调查东境贵族世系与魔法起源

## 步骤 <!-- ai-writer-task-steps -->

- [x] 检索东境三大家族设定
- [/] 分析初代家主与禁忌魔法关联
- [ ] 起草补充设定并更新词条

## 进度记录 <!-- ai-writer-task-log -->

- 16:32 家族关系网比对完成，见 `notes/search-east-nobles.md`
```

复选框字形即状态：`[ ]` pending · `[/]` in_progress · `[x]` done · `[-]` skipped。
缩进的复选框**也算一步**：工具按位置寻址，而作者是照着渲染后的列表数位置的，
解析器漏掉一条就会让其后每个序号错位、勾错行。

小节标题经 i18n 翻译（作者要读这个文件），但各自带一个语言无关的锚点注释
`<!-- ai-writer-task-steps -->` / `<!-- ai-writer-task-log -->`。工具靠锚点定位小节，
所以换了应用语言、或作者改了标题措辞，追加的位置都不会错——按标题文本去找，
第一次切换语言就会把进度记录写到别处去。

#### 类型与序列化（`src/lib/agent/taskWorkspace.ts`）

```ts
export type TaskStatus = "in_progress" | "paused" | "completed" | "failed";
export type StepStatus = "pending" | "in_progress" | "done" | "skipped";

/** 只有机器状态。标题与步骤状态**不在**这里 —— 见上文。 */
export interface TaskMeta {
  taskId: string;
  status: TaskStatus;
  /** 发起这次任务的主模型配置行 id（Model.id，不是 Model.modelId）。 */
  modelId: string;
  createdAt: string;
  updatedAt: string;
  /** 恢复时用于判断作者是否改过参考文件。 */
  sourceRefs?: { path: string; hash: string }[];
}

/** 从正文解析出来的一步，序号是它在列表中的位置（1 基）。 */
export interface TaskStep {
  index: number;
  title: string;
  status: StepStatus;
}

export interface TaskDoc {
  meta: TaskMeta;
  /** 正文原文，作者可任意编辑。 */
  body: string;
}

export interface TaskNoteHeader {
  slug: string;
  title: string;
  /** 项目相对路径，可直接喂给 read_note。 */
  path: string;
  chars: number;
  /**
   * 请求的 slug 已被占用、实际落盘时加了后缀时才有值——工具据此告诉模型
   * 真实文件名。**不要**在这里放 updatedAt：readDir 拿不到 mtime，
   * 填 `new Date()` 等于放一个永远说谎的字段。
   */
  renamedFrom?: string;
}
```

```ts
const TASK_META_RE = /^<!--\s*ai-writer-task\s*\n([\s\S]*?)\n-->/;

export function serializeTaskDoc(meta: TaskMeta, body: string): string {
  return `<!-- ai-writer-task\n${JSON.stringify(meta)}\n-->\n\n${body.trim()}\n`;
}

export function parseTaskDoc(raw: string): TaskDoc | null {
  const m = raw.match(TASK_META_RE);
  if (!m) return null;
  let meta: unknown;
  try { meta = JSON.parse(m[1]); } catch { return null; }
  if (!meta || typeof meta !== "object" || typeof (meta as TaskMeta).taskId !== "string") return null;
  return { meta: meta as TaskMeta, body: raw.slice(m[0].length).trim() };
}

const STEP_RE = /^[-*]\s+\[([ x\/-])\]\s+(.*)$/;
const GLYPH: Record<string, StepStatus> = {
  " ": "pending", "/": "in_progress", x: "done", "-": "skipped",
};

/** 正文里的复选框行即步骤表。解析失败的行原样保留，不做规整。 */
export function parseSteps(body: string): TaskStep[] {
  const out: TaskStep[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(STEP_RE);
    if (m) out.push({ index: out.length + 1, title: m[2].trim(), status: GLYPH[m[1]] });
  }
  return out;
}
```

### 3.3 Scratchpad 工具集

新增 5 个 `ToolId`，注册进 `registry.ts` 的 `REGISTRY`，执行器实现在新文件 `src/lib/agent/scratchpadTools.ts`。

| 工具 | access | 参数 | 说明 |
| :--- | :--- | :--- | :--- |
| `task_plan` | `write-auto` | `{ title: string; steps: string[] }` | 建立或重写 `task.md` 的标题与步骤列表。会**保留**已有的「进度记录」小节 |
| `task_progress` | `write-auto` | `{ action: "check"\|"start"\|"skip"\|"add_step"\|"log"; step?: number; text?: string }` | 增量改一行。`step` 是 1 基序号；`add_step`/`log` 用 `text` |
| `write_note` | `write-auto` | `{ slug: string; title: string; content: string; sources?: string[] }` | 写 `notes/<slug>.md`，自动补标题、时间戳与来源清单，返回相对路径 |
| `read_note` | `read` | `{ path: string; start_line?: number }` | 分页回读，**沿用 `read_file` 的行号分页语义**（单次 4000 字符、按行边界切、回报 `lines a-b of N` 与下一个 `start_line`） |
| `list_notes` | `read` | `{}` | 列出本任务的所有 note：slug、标题、路径、字符数。**不给正文** |

#### 实现要点

1. **路径沙箱**：`slug` 经 `sanitizeSlug` 清洗——**保留任何文字系统的字母与数字**
   （`/[^\p{L}\p{N}-]/gu`），按码点截断 60 字符，空则回落 `note`。
   这条不能写成 ASCII 白名单：那样每个纯中文 slug（「搜索结果」「第一章分析」）都会
   被清空并回落到同一个名字，于是中文项目的每篇笔记都写进 `note.md` 覆盖上一篇——
   正是工作区要防的那种丢失。清洗后的名字里不可能含 `/`、`\` 或 `.`，
   所以拼进 notes 目录后天然出不去，无须再叠一次 `isPathWithin`。
   **读**侧的引用另走 `noteSlugFromReference`：接受相对路径、`<slug>.md` 和裸 slug
   三种形态（前两种就来自本应用自己的工具输出），指向别的任务则返回「找不到」。
2. **绝不覆盖**：slug 撞车时自动加 `-2`、`-3` 后缀，并在工具结果里说明真实文件名。
   静默覆盖等于丢数据，而模型没有任何办法察觉它发生过。
2a. **来源机器头（2026-08-15，设计稿 1g 对齐）**：note 文件首行是一行 HTML 注释
   `<!-- ai-writer-note {"origin":"longread","sources":2} -->`——与 `task.md`、
   `memory.ts` 同一约定：注释在渲染与作者手改下都存活，且单行即可整行丢弃，不碰正文。
   `origin`（`search|vision|longread|main`）由**执行器**填（`executeDelegate` 传
   kind、`write_note` 传 `main`），不是工具参数——模型没有理由也没有资格谎报出处。
   `listTaskNotes` 解析它连同 `sources` 数回给 UI（任务工作区的笔记行显示
   「长读子代理 · 6.2k 字 · 2 条来源」）；标题解析随之从「取首行」改为「取第一个
   H1」，否则机器头会被当成标题。旧笔记没有这行头 → 字段缺省，只显示字数。
3. **谁能创建工作区**：只有 `task_plan`（标题即计划主题）与 `write_note`
   （checkpoint 提示点名要它，拒绝会让那条提示变成死路；但它用**中性标题**建仓，
   任务叫什么是计划的事，不能由碰巧第一个落盘的笔记决定）。
   `task_progress` **不创建**——它编辑的是一份必须已经存在的清单。

   > **作者主动要计划（2026-08-16）**：对话输入框上方新增「制定计划」按钮。它**不**直接建仓，
   > 而是照 `resumeTask` 的老路发一条普通轮次——`ai.instructions.makePlan` 上线、
   > 转录里只显示短标签，由模型自己去调 `task_plan`。UI 直接写一份 `task.md` 也做得到，
   > 但那样建出来的计划模型没参与、也不会照着走，只是一份骗人的进度条。
   > 在此之前，工作区只在**模型**认为活儿够大时才出现，作者没有办法对一件被判定为
   > 「小事」的工作说「这个要跟踪」，跑偏之后也没有办法把计划要回来。
   >
   > **改成模式开关（2026-08-18）**：按钮换成「计划模式」开关（`PlanModeChip`，与子代理
   > chips 并排、共用 `toggleChip.module.css`），状态在 `agentStore.planMode`。
   > 按钮的问题是**时机**：它只能在活儿已经说完之后补一份计划，那份计划针对的是一段
   > 转录而不是一次请求，作者发下一条消息时模型又回到原来的做法。开关则作用在作者
   > **将要**提的那件事上——只要它开着，`sendChat` 就在每一轮的 wire content 后面缀上
   > `ai.instructions.planMode`（`chatRefs.withDirective`），模型先立清单再动手，并在
   > 执行期用 `task_progress` 维护它。
   >
   > 三个具体决定：**每轮都发**，不是开启时宣告一次——system 层是唯一每轮存活的层，
   > 而这个开关是会话中途拨的，宣告一次到第三轮就被埋了，恰好是模型决定要不要立
   > 清单的时候；**只缀在 wire content 上**，`ChatMessagePayload.text` 保持原样，因为
   > 那一半是检索的 matchTarget，每轮重复一段固定指令只会污染知识库匹配；
   > **会话级、新会话归零**（与 chips、`autoApprove` 同一条理由：它说的是「本次对话」）。
   > 计划完不停下来等确认——作者要的是「模型 plan task 来完成任务」，
   > 停下来等确认那是另一回事，真要停有 `propose_*` 审批卡在管。
   新建的工作区**不含任何占位步骤**：伪造一条「开始任务」会被 `parseSteps` 数进去，
   于是一个没人规划过的任务显示 0/1，模型还会去勾一条它没写过的步骤。
4. **大小熔断**：note 正文 ≤ `100_000` 字符，`task.md` ≤ `20_000` 字符；超限返回 tool error 而非截断（截断会让模型以为写成功了）。
5. **不做备份**。`write-auto` 在别处意味着「自动应用 + 写前备份」（`agent/backup.ts`），但工作区是 agent 自己的草稿纸：备份它只会让 `.ai-writer/backups/` 翻倍增长，而没有任何可恢复价值。这一点要写进工具注释，否则下一个人会以为是漏了。
6. **不过任何审批门**：不经 `PlanGate`，不经 `requestApproval`。理由同上 —— 那两道门是为「改作者的内容」设的。
7. **写入串行化**：模型可以在同一轮发出多个 tool call（`runtime.ts:465` 的循环），两个 `task_progress` 并发读改写 `task.md` 会丢更新。模块内维护一条 `writeChain: Promise<void>`，所有 `task.md` 写入串上去 —— 与 `apiLog.ts:51` 的做法相同。

```ts
// scratchpadTools.ts — 所有 task.md 写入的唯一入口
let writeChain: Promise<void> = Promise.resolve();

function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}
```

### 3.4 GC 与保留策略

- **上限** `MAX_SAVED_TASKS = 20`（对照 `MAX_CHAT_SESSIONS = 5`，`sessionDb.ts:15`；任务目录比会话轻，且断点续跑的价值窗口更长，故放宽）。
- **排序键**：先按「是否已收尾」（`completed`/`failed`/`aborted` 排前面，优先被淘汰，判定收在 `isFinishedStatus()` 一处），再按 `updatedAt` 倒序；保留前 20 个。

  > 第一版写的是「未完成的不清理」，那样一个永不收尾的任务序列会无界增长。上面的排序保证「未完成的优先留下，但不豁免」。
- **绝不删除当前 run 持有的 `taskId`**（handle 里有它）。
- **触发时机**：`ensure()` 成功创建新目录之后，`void gcTasks(projectPath, keepId)` 异步执行，失败只 `console.warn`。
- **手动清除**：任务工作区 footer 的「清除已完成任务」按钮（`TaskWorkspaceView`）经 `ConfirmDialog` 确认后调 `clearCompletedTasks(projectPath, keepTaskId)`，只删 `status === "completed"` 的目录；`keepTaskId` 同样豁免当前会话持有的任务，理由同上。
- **单个删除（2026-08-16）**：footer 的「删除任务」按钮调 `deleteTask(projectPath, taskId, liveTaskId)`，只对**已收尾**的任务开放（`isFinishedStatus`），并同样豁免当前会话的 `taskId`。工具层而非只在 UI 层做这两道判断，是因为「删掉正在跑的任务」丢的是没法找回的工作——按钮的可见性是提示，函数的拒绝才是保证。目录解析不出 `task.md` 的算可删：那正是作者要清掉的东西。

### 3.5 项目备份

`projectBackup.ts` 的 `PROJECT_BACKUP_EXCLUDES`（`projectBackup.ts:41`）**不加** `.ai-writer/tasks`，即默认包含。理由与 `.ai-writer/tmp` 被排除恰好相反：tmp 是 scratch，tasks 是可恢复状态。

需要在 `projectBackup.ts` 的模块注释里补一句说明，否则下次有人清理 `.ai-writer/` 时会顺手把它加进排除表。

---

## 4. 状态机、Checkpoint 与断点续跑

### 4.1 生命周期

```
  ┌──────────┐  task_plan / 首次 write_note
  │  (无)    ├──────────────────────────────► in_progress
  └──────────┘                                   │
                     撞轮数上限选「存盘暂停」     │  步骤全部收尾
                  ┌────────────────────────────┤
                  ▼                             ▼
              paused ──── UI 点「继续」───► in_progress ───► completed
                  │                             │
                  │        作者点「终止任务」   │  运行异常
                  └──────────────┬──────────────┘
                                 ▼              ▼
                             aborted         failed
```

**`aborted` 与 `failed` 分开（2026-08-16）：** 前者是作者的决定，后者是运行自己出的事。分开不是为了措辞好看——两者的后续动作正相反：终止的任务是「办完了的事」，可删、不可续（续跑等于把刚做的决定撤销）；失败的任务是故障，作者多半还想重试。UI 上 `aborted` 用中性色而非 `failed` 的告警色，也是同一个理由。

**入口**：`agentStore.abortTask(taskId)`。顺序是**先停后写**——若终止的正是当前会话的任务且仍在跑，先 `stopChat()`，否则循环里下一次 `task_progress` 会把刚写的 `aborted` 覆盖掉。写完还要 `chatTaskWorkspace: null` 把 handle 摘掉：`task_plan` 会无条件把状态重置回 `in_progress`，不摘的话作者随后一句「再规划一下」就悄悄把终止的任务复活了。

### 4.2 裁剪前的 Checkpoint 注入

在 `runtime.ts` 的轮循环顶部、`trimHistory` **之前**插入。关键是**发出即撤**：

```ts
// runtime.ts —— 与 forcedTextNotice（runtime.ts:276-283 / 410-413）完全同构
let checkpointNotice: StreamMessage | null = null;
if (
  preset.scratchpad === "required" &&
  opts.inputCeilingTokens &&
  estimateMessagesTokens(history) > opts.inputCeilingTokens * CHECKPOINT_RATIO &&
  !checkpointArmed
) {
  checkpointNotice = { role: "user", content: i18n.t("ai.instructions.scratchpadCheckpoint") };
  history.push(checkpointNotice);
  checkpointArmed = true;   // 本轮已提醒
}
…
} finally {
  // 与 forcedTextNotice 同理：这是一条「关于本轮」的指令，而 chat 的 history
  // 是持久的。留在里面等于给之后每一轮都下了一道常驻命令 —— 这正是
  // 「agent 不停告诉自己用户要求继续」那类故障的成因。
  if (checkpointNotice) {
    const at = history.indexOf(checkpointNotice);
    if (at >= 0) history.splice(at, 1);
  }
}
```

两个补充：

- `CHECKPOINT_RATIO = 0.85`。必须**早于** `trimHistory` 的触发点（后者在 `> inputCeilingTokens` 时才动手），否则提醒发出时内容已经被删了。
- `checkpointArmed` 在**每次 `trimHistory` 真正丢弃了内容之后重新置回 `false`**（`dropped > 0` 时）。第一版只置一次，等于整段运行只 checkpoint 一次，长任务照样丢。

`preset.scratchpad` 新增于 `TaskPreset`：

```ts
/**
 * 这个任务是否使用磁盘工作区。
 *  - "off"（默认）  —— 不给 scratchpad 工具，行为与今天完全一致
 *  - "offered"      —— 给工具，但不主动提醒
 *  - "required"     —— 给工具，并在裁剪前与撞墙时强制提醒
 */
scratchpad?: "off" | "offered" | "required";
```

默认 `"off"` 意味着**整套机制可以整体回退**：不改任何预设，就是今天的行为。

### 4.2.1 清单滞后提醒（2026-08-16）

**问题**：作者反馈 task_plan 拆出的 4-5 步清单在执行中不逐步推进，而是最后一刻"突然全部完成"。排查确认链路本身是实时的（每个 tool-step 落地即写 store，`TaskPanel` 按 revision 重读磁盘），根因是**没有任何一层指令要求模型边做边勾**——于是模型把所有 `task_progress` 攒到最后一轮批量发出，同轮几百毫秒内全部落盘，且最后一勾同时把 `meta.status` 翻成 `completed`。

**为什么不能硬校验**：步骤只是 task.md 里的一行文字，runtime 不知道哪个工具调用完成了哪一步——"每步完成必须上报"在 runtime 侧不可判定。可判定的是**沉默**：清单上还有未完成步骤，却连续多轮没有任何 `task_plan`/`task_progress` 成功落地。

**机制**（`runtime.ts`，与 checkpoint 同构、同样发出即撤）：轮循环维护 `roundsSinceTaskTouch`，工具轮里有成功的 `task_plan`/`task_progress` 就归零，否则 +1；达到 `TASK_NUDGE_ROUNDS = 3` 且 `loadTaskDoc` 读出的清单仍有 pending/in_progress 步骤时，注入 `ai.instructions.taskChecklistNudge`——**附当前清单快照**（带序号和勾选态），让模型对照实际进展逐条补勾，而不是凭记忆乱勾。注入后计数器归零，再沉默 3 轮才会重发。条件里带 `!withholdTools`（末轮收走工具时提醒只会制造死路）和 `preset.scratchpad === "required"`（与 checkpoint 同一开关，整体可回退）。

**提示词层同日配套**（这是第一道防线，nudge 是兜底）：`ai.instructions.agent` 新增「任务清单」一节（system 层是唯一每轮存活的层），`task_plan`/`task_progress` 的 description 补调用时机，`makePlan`（今为 `planMode`）补执行期约定，`scratchpadCheckpoint` 顺带要求补勾清单。测试：`agentRuntimeTaskNudge.test.ts`。

### 4.3 轮数上限：新增「存盘暂停」

现契约是 `onRoundLimit: (roundsUsed: number) => Promise<number>`（`runtime.ts:203`）与 `resolveRoundLimit(runId, granted: number)`（`agentStore.ts:207`）。一个 `number` 表达不了「暂停」，**必须换契约**：

```ts
// lib/agent/runtime.ts
export type RoundLimitDecision =
  | { action: "extend"; rounds: number }
  | { action: "finish" }              // 今天的 granted: 0 —— 撤工具、强制成文
  | { action: "pause" };              // 新增 —— 不再发请求，直接收工

export interface AgentRunResult {
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** 新增。"paused" 表示作者选了存盘暂停，本次没有产出正文。 */
  outcome: "completed" | "paused";
}
```

runtime 的处理（替换 `runtime.ts:250-264` 那一段）：

```ts
if (isLastRound && round > 1 && preset.finishPolicy === "force-text"
    && preset.tools.length > 0 && opts.onRoundLimit) {
  const decision = await opts.onRoundLimit(round - 1);
  if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
  opts.onEvent({ kind: "round-limit", roundsUsed: round - 1, decision, at: Date.now() });

  if (decision.action === "pause") {
    // 干净的退出点：我们在一轮的**开头**，上一轮的 tool_calls 全都已配对，
    // history 本身是合法的，不需要 repairToolCallPairing。
    return { rounds: round - 1, inputTokens: totalInputTokens,
             outputTokens: totalOutputTokens, cachedTokens: totalCachedTokens,
             outcome: "paused" };
  }
  if (decision.action === "extend") { maxRounds += decision.rounds; isLastRound = false; }
}
```

> 为什么在轮首暂停是干净的：`runtime.ts:440-521` 的不变式是「一轮结束时，每个 `tool_call` 都有配对的 `tool` 回复」，`abortedMidRound` 那段专门维护它。轮首退出天然满足，所以暂停不会像中途 abort 那样把会话写坏。

配套改动：

- `AgentEvent` 的 `round-limit` 成员：`granted: number` → `decision: RoundLimitDecision`；
- `agentStore.requestRoundExtension(...) => Promise<RoundLimitDecision>`，`resolveRoundLimit(runId, decision)`；
- `rejectAll` 里 `item.resolve(0)` → `item.resolve({ action: "finish" })`（`agentStore.ts:456`）；
- `RoundLimitCard.tsx` 三个按钮：`就此收尾` / `存盘并暂停` / `继续（再 N 轮）`。
  中间那个的可见性由 **`PendingRoundLimit.canPause`** 决定，由发起 run 的一方在
  撞上限的那一刻求值（`!!workspace.taskId`）。**不要让卡片去读 chat 的状态**：
  这张卡 chat 与 AiPanel 共用，读 `chatTaskWorkspace` 会把按钮显示在面板的任务上，
  而那一侧既没处理 `paused` 也无处可存 —— 点下去整轮工作无声消失。
  同理，**两个调用方都必须处理 `outcome === "paused"`**，不能只做聊天那一侧；
- 调用方拿到 `outcome === "paused"` 时：把 `task.md` 的 `status` 置 `paused`、追加一条进度记录、**不**再强跑一轮成文。

### 4.4 从 `task.md` 恢复

```ts
// stores/agentStore.ts
export async function buildResumeSeed(
  projectPath: string,
  taskId: string,
): Promise<{ userContent: string; taskWorkspace: TaskWorkspaceHandle }> {
  const doc = await loadTaskDoc(projectPath, taskId);
  if (!doc) throw new Error(i18n.t("ai.errors.taskNotFound"));

  // 1. 参考文件新鲜度 —— 复用 memory.ts 的 FNV-1a
  const stale: string[] = [];
  for (const ref of doc.meta.sourceRefs ?? []) {
    const abs = `${projectPath}/${ref.path}`;
    if (!(await fileExists(abs))) { stale.push(`${ref.path}（已删除）`); continue; }
    if (hashText(await readFile(abs)) !== ref.hash) stale.push(`${ref.path}（已修改）`);
  }

  // 2. notes 索引：只给标题与路径，不给正文
  const notes = await listTaskNotes(projectPath, taskId);

  // 3. 全新的干净用户轮 —— 不带任何旧 wire history
  const userContent = i18n.t("ai.instructions.taskResume", {
    body: doc.body,
    notes: notes.length
      ? notes.map((n) => `- ${n.path} — ${n.title}（${n.chars} 字符）`).join("\n")
      : i18n.t("ai.instructions.taskResumeNoNotes"),
    stale: stale.length ? stale.map((s) => `- ${s}`).join("\n") : "",
  });

  return { userContent, taskWorkspace: existingWorkspace(projectPath, taskId) };
}
```

启动时 `messages = [{ role: "system", content: profileSystemPrompt(...) + agent 指令 }, { role: "user", content: userContent }]`。

> **这正面解掉了 `【作者消息】` 那一层兜底所治标的病**：恢复的是**任务状态**而非**对话记录**，作者三周前那句 `continue` 根本不会出现在新上下文里。
>
> 系统提示词必须走 `profileSystemPrompt()`，不能用 `ai.instructions.system` —— 否则非小说项目会拿到小说指令（CLAUDE.md 明令）。

### 4.5 会话与工作区的绑定跨重启（2026-08-15，原 PR-B 遗留）

`chatTaskWorkspace` 的 `taskId` 现在随会话 blob 持久化（`chatSession.ts` 的
`SerializedChat.taskId`，**可选字段、版本仍是 v1**——旧行照常还原为 `null`，旧代码读
新行会忽略它）。恢复端（`switchChatSession` / `resetChatForProject`）经
`workspaceForSnapshot` 重建句柄：taskId 存在**且 `task.md` 仍可解析**才给
`existingWorkspace`，否则显式置 `null`——工作区可能已被 GC（20 个上限），拿着已剪掉
任务的句柄会在下一条笔记时悄悄复活一个空目录。

为什么「显式置 null」值得写进注释：修这条时发现 `switchChatSession` 原本**不碰**
`chatTaskWorkspace`，于是切到历史会话后，惰性创建器直接复用上一个会话的句柄——
历史会话的新笔记会写进**另一个任务**的工作区。恢复代码对这个字段沉默就是继承污染，
所以每条恢复路径都必须给它一个明确的值。

---

## 5. 子代理执行引擎

### 5.1 数据模型与配置存储

```ts
// lib/agent/subagent.ts
/** 可委托的子代理种类。`image` 不在此列 —— 见 §5.5。 */
export type SubAgentKind = "search" | "vision" | "longread" | "pdf";

export const SUBAGENT_KINDS: readonly SubAgentKind[] = ["search", "vision", "longread", "pdf"];

export interface SubAgentConfig {
  kind: SubAgentKind;
  /** Model.id（配置行主键），null = 未绑定。 */
  modelId: string | null;
  enabled: boolean;
}
```

#### 持久化

沿用 `imageModelId` / `memoryModelId` 的做法：应用级偏好，不进 `.ai-writer/`（它描述的是作者买了什么账号，不是这个项目的内容）。在 `lib/prefs.ts` 的 `PREF_KEYS` 注册 6 个键：

```
ai:subagent:search:modelId    ai:subagent:search:enabled
ai:subagent:vision:modelId    ai:subagent:vision:enabled
ai:subagent:longread:modelId  ai:subagent:longread:enabled
ai:subagent:pdf:modelId       ai:subagent:pdf:enabled
```

`aiStore` 提供 `subAgents: Record<SubAgentKind, SubAgentConfig>` 与 `setSubAgent(kind, patch)`，并**必须**接进既有的两处清理逻辑（`aiStore.ts:148-155` 模型表刷新、`aiStore.ts:231` 单个模型删除）—— 否则删掉一个模型后，子代理会指向一个不存在的行。`aiStoreRemoval.test.ts` 已经为 `memoryModelId` 立过这个规矩。

> **绝不要用 `localStorage`**：加键到 `PREF_KEYS`（CLAUDE.md 明令）。

### 5.2 内置种类规范

| kind | 定位 | `tools` | `maxRounds` | `serverTools` 策略 | 产出 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `search` | 联网检索与查证 | `[]` | 2 | **`"always"`** | `notes/search-*.md`：结论 + 事实 + **原始 URL** |
| `vision` | 图像理解 | `["read_image", "read_lore_image"]` | 3 | `"off"` | `notes/vision-*.md`：视觉描述与结论 |
| `longread` | 长文精读提要 | `["read_file", "search_text", "list_files"]` | 4 | `"off"` | `notes/read-*.md`：大纲 + 关键细节 |
| `pdf` | PDF 原件精读（2026-08-17 加） | `[]` | 1 | `"off"` | `notes/pdf-*.md`：结构 + 关键内容 |
| `imagegen` | 图片生成（2026-08-17 加）| —（非会话型，见下） | — | — | 文档 `assets/` 或条目图库里的一张图 |

一律 `finishPolicy: "force-text"`（子代理必须以文本收尾，那段文本就是产出）。

`imagegen` 是唯一**非会话型**的种类：图像模型开不了 `runAgent` 的子回合，所以
它不走 `delegate`（`DELEGATE_KINDS = SubAgentKind \ {imagegen}`，`executeDelegate`
对 `kind:"imagegen"` 直接拒绝并把模型指回图片工具）。它的接口是既有的
`generate_image` / `edit_image` / `redraw_lore_image` 三个工具（L2 审批卡：
提案→出示提示词与价格→同意才生成，`lib/agent/imageTools.ts` +
`lib/image/illustrate.ts`；后两个是改图的一对——按图存在哪里分工，见
`docs/feature/image-generation-plan.md` §8），绑定让开关有了
实义：`routeTools` 只在 `subAgentModel("imagegen")` 可用（启用 + 绑到
`type:"image"` 模型）时保留这三个工具，工具解析模型也只认这份绑定——不再回退
到"随便哪个图像模型"。与 `vision` 的分工：vision 接管**读**图，imagegen 提供
**画**图，二者在路由里互不干涉。会话芯片对它同样生效（本次对话关掉 ⇒ 工具被
剥掉）。迁移：`ai:subagent:imagegen:*` 两个 pref 都缺席时，从旧的
`ai:imageModelId`（生成弹窗的选择）播种为「启用 + 同一模型」——此前 agent 画图
一直隐式在线，升级后静默失能会被读成"助手坏了"；弹窗自己仍用 `imageModelId`
（作者当场可换，互不影响）。

`pdf` 与 `longread` 的分界：`longread` 靠 `read_file` 分页读**文本**文档；PDF 是
二进制，`read_file` 读不了，而项目的 docx/pdf 导入线（`lib/import`）是作者手动
动作，agent 够不着。`pdf` 子代理把**原件整份**作为 `file` 内容块放进首条 user
消息（`{type:"file", file:{file_data: <data URL>, filename}}`——ContentPart 的
第三个变体，`lib/ai/types.ts`），端点服务端抽取并作答。因此它 `maxRounds: 1`、
零工具：没有任何工具能在后续轮次再取一份文件，请求本身就是全部工作。文件在
`executeDelegate` 里按 `refs` 就地读取（`loadProjectPdf`）：`.pdf` 后缀强制、
`isWorkspacePath` 包含校验（**`.ai-writer/` 拒绝**——PDF 是模型当文本读的文档，
`read_file` 挡外泄的论证原样适用）、单文件 ≤150MB（DashScope 自己的上限）、
单次 ≤3 份（厂商只给过单文件示例，多文件是否可行见
`thinking-verification.md` 4.9）。base64 编码用线性 join 而非 `imageToDataUrl`
的累加循环——那个循环在 12MB 图片帽下看不出问题，150MB 会二次方到分钟级。

能力位是 `Model.pdfInput`（声明式布尔，`configDb` 新列 `pdf_input`，
ModelDrawer 仅 openai 族显示）：与 `serverTools` 同一哲学——这是作者买了什么的
属性（同一 DashScope 端点后面只有 qwen3.8-max 读得了 PDF），探测无从问起。
**不 sniff 模型名**：厂商扩大支持面时作者勾一下就行，代码零改。

#### 5.2.1 致命修正：`serverTools` 必须脱离 `withholdTools`

`runtime.ts:266` 现状：

```ts
const withholdTools = preset.tools.length === 0 || (isLastRound && preset.finishPolicy === "force-text");
…
serverTools: withholdTools ? undefined : opts.serverTools,   // runtime.ts:340
```

`search` 子代理没有任何本地工具（搜索发生在端点内部），`preset.tools.length === 0` 恒真 ⇒ `withholdTools` 恒真 ⇒ **`web_search` 每一轮都被撤掉，子代理开机即哑**。

这行是为「force-text 收尾轮不该再联网」加的兜底，方向没错，但把两件不同的事并成了一条。拆开：在 `TaskPreset` 上加显式策略。

```ts
// presets.ts
/**
 * 这个任务允许模型使用**端点自带**的服务端工具（web_search）到什么程度。
 *
 * 与本地工具分开表达，因为「没有本地工具」和「该收尾了」是两件事：
 * 搜索子代理正是一个没有任何本地工具、而联网就是它全部工作的预设。
 *
 *  - "final-round-off"（默认）—— 允许，但 force-text 的收尾轮撤掉。
 *      收尾轮的唯一任务是把已有信息写成文；在那里放一次搜索，会重新触发
 *      整个「搜索 → 续跑」循环（docs/api/anthropic-plan.md §10.8）。
 *  - "off"      —— 从不。结构化 JSON 任务用它。
 *  - "always"   —— 每轮都允许，含最后一轮。只有搜索子代理该用。
 */
serverTools?: "final-round-off" | "off" | "always";
```

```ts
// runtime.ts —— 替换 340 行那一处
const serverToolPolicy = preset.serverTools ?? "final-round-off";
const withholdServerTools =
  serverToolPolicy === "off" ||
  (serverToolPolicy === "final-round-off" && isLastRound && preset.finishPolicy === "force-text");
…
tools: withholdTools ? undefined : toolDefinitions,
serverTools: withholdServerTools ? undefined : opts.serverTools,
```

- 现有预设不写这个字段，取默认值 —— 行为与今天**逐字相同**（`LORE_GENERATE` / `LORE_SPLIT` 是 `maxRounds: 1` + force-text，第 1 轮即最后一轮，照样被撤）。为表明意图，仍给这两个显式写上 `serverTools: "off"`。
  > 后续：`LORE_SPLIT` 已改成多轮工具环（`split_core` / `split_facet`，见 `lib/agent/splitTools.ts`），"第 1 轮即最后一轮"不再成立——那句显式 `serverTools: "off"` 从表明意图变成了真正在起作用的一行。
- `structured.ts:common` 里那句 `serverTools: undefined` 保留 —— 它走的是 `streamCompletion` 而非 runtime，是另一条路径上的同一道闸。

#### 5.2.2 绑定校验

**每个 kind 各有一条前置条件，都在 `delegate` 里检查、而非留给子跑去发现** ——
否则作者要等一整个往返，才被告知一件设置界面早就知道的事，而且报出来的形态是
「子代理失败」而不是「配置不对」。`vision` 要求 `model.type === "multimodal"`，
`pdf` 要求 `model.pdfInput`，`search` 要求下面这条。同样的判断也在设置面板上
就地提示（`SubAgentsPane.warningFor`），也是 `subAgentModel` 的「可用」判定——
三处一个实现。

**密钥缺失同理**：`resolveSubAgentConn` 不得把取不到的密钥降级成空串——
那会发出一个无钥请求，401 回来被包装成「子代理坏了」，而真正的修法是去粘一个 key。

`search` 子代理绑定的模型若没有配 `serverTools: ["web_search"]`（`Model.serverTools`，`configDb.ts:156`），它就是个不能上网的普通模型。`delegate` 执行前检查，并给出可操作的错误：

```
Error: the search subagent's model "<name>" has no server-side web_search enabled.
Tell the author to turn it on in Settings → Models, or answer without searching.
```

自 2026-08-17 起 `web_search` 不再是 Anthropic 族专属：`openai_compat` 端点
（千问 DashScope 兼容模式）也可声明，adapter 拼成顶层 `enable_search: true`
（`lib/ai/serverTools.ts` 的 `openaiServerToolsBody`）。一个诚实的差别要知道：
该协议**不返回任何搜索痕迹**（厂商文档明载无来源、无角标），所以千问当搜索
子代理时执行日志里没有「搜了什么、命中了什么」的行——产出笔记里的结论就是
全部可见物，`renderSearchResults` 那套回手转写在这条线上天然无事可做。

### 5.3 `delegate` 工具与嵌套调用

#### 5.3.1 `ToolContext` 扩展

`delegate` 需要三样 `ToolContext` 今天没有的东西。全部**可选**，这样 `run.ts:41` 与两个 lore modal 的三字段构造不用改：

```ts
// registry.ts — ToolContext 追加
export interface ToolContext {
  … // 既有 8 个字段不动

  /** 本次运行的任务工作区（懒创建）。缺失时 scratchpad 工具与 delegate 拒绝。 */
  taskWorkspace?: TaskWorkspaceHandle;
  /**
   * 本次运行的中止信号。自己发起请求的工具（delegate）必须共用它，
   * 否则作者点「停止」之后子代理还在后台烧钱。
   */
  signal?: AbortSignal;
  /** 把嵌套运行的事件转发进本次运行的执行日志。 */
  onNestedEvent?: (event: AgentEvent) => void;
  /** 供 delegate 解析子代理连接。由调用方从 aiStore 取，lib 层不反向依赖 store。 */
  resolveSubAgent?: (kind: SubAgentKind) => Promise<AiConn | { error: string }>;
}
```

> 第一版把 `parentSignal` / `onParentEvent` 写成 `executeDelegate` 的额外形参，但注册表的执行器签名是 `execute(call, ctx)`（`registry.ts:189`），多出来的参数无处传入。走 `ToolContext` 是唯一的口子。
>
> `resolveSubAgent` 做成回调而不是 `ctx.models` / `ctx.providers`，是为了不把 `lib/agent` 变成 store 的下游 —— `agentStore` 已经因为循环依赖被迫全用 `await import()`（见其模块注释），不该再加一条。

runtime 在构造调用时补上：`signal: opts.signal`、`onNestedEvent: opts.onEvent`（`toolContext` 由调用方给，runtime 在 `executeRegisteredTool` 前浅合并这两项即可）。

#### 5.3.2 工具定义

```ts
// registry.ts
delegate: {
  access: "read",     // 它本身不写作者的任何东西；子代理只写自己的 notes
  definition: {
    type: "function",
    function: {
      name: "delegate",
      description:
        "Hand a context-heavy or capability-specific job to a specialist subagent " +
        "running on its own model. The subagent works in a separate context, writes " +
        "its full findings to a note file, and returns only a short summary plus the " +
        "note path — so its raw material never enters this conversation. Use it for " +
        "web research, reading images, and digesting long documents.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["search", "vision", "longread"],
            description:
              "search — look things up on the web; vision — describe or analyse images; " +
              "longread — read long documents and report what matters.",
          },
          task: {
            type: "string",
            description:
              "A complete, self-contained instruction. The subagent cannot see this " +
              "conversation, so state everything it needs to know.",
          },
          refs: {
            type: "array",
            items: { type: "string" },
            description: "Paths the subagent should work on (documents or images).",
          },
        },
        required: ["kind", "task"],
      },
    },
  },
  execute: executeDelegate,
},
```

> 描述里刻意用 `documents` 而不是「章节」：工具描述对所有 workspace profile 通用，硬编码 `章/卷/设定` 会让跑团/文案项目读到错的词（CLAUDE.md 的 `terms` 约束）。需要 profile 词汇的地方走 `getToolDefinitions` 的占位符替换机制（`registry.ts` 的 `CATEGORY_PLACEHOLDER`）。

#### 5.3.3 执行器

```ts
// lib/agent/subagent.ts
export async function executeDelegate(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const fail = (msg: string): ToolResult => ({ toolCallId: call.id, content: `Error: ${msg}` });

  if (!ctx.taskWorkspace || !ctx.signal || !ctx.onNestedEvent || !ctx.resolveSubAgent) {
    return fail("this surface cannot run subagents — do not call this tool here.");
  }
  const args = parseArgs<{ kind?: string; task?: string; refs?: string[] }>(call.arguments);
  const kind = args.kind as SubAgentKind;
  if (!SUBAGENT_KINDS.includes(kind)) return fail(`unknown subagent kind "${args.kind}".`);
  const task = args.task?.trim();
  if (!task) return fail("'task' is required — state the whole job, the subagent cannot see this conversation.");

  const conn = await ctx.resolveSubAgent(kind);
  if ("error" in conn) return fail(conn.error);

  const refs = (args.refs ?? []).filter((r) => typeof r === "string");
  const preset = SUB_PRESETS[kind];

  // 全新历史：两条消息，不带主 agent 的任何上下文。
> 提示词按有无 `refs` 分成**两个 i18n 键**（`subagentTask` / `subagentTaskWithRefs`），
> 不能用一个键插值一个空串：带 refs 的那个键自带「参考资源」小节标题，
> 复用它就等于给子代理一个空的资料清单——一条「去查这些来源」的指令，
> 而来源并不存在。（按 `refs.length` 分叉 `defaultValue` 是无效的：
> 键存在时 `defaultValue` 根本不会被采用。）

  const messages: StreamMessage[] = [
    { role: "system", content: i18n.t(`ai.instructions.subagent.${kind}`, promptParams(isZh())) },
    { role: "user", content: i18n.t("ai.instructions.subagentTask", { task, refs: refs.join("\n") }) },
  ];

  // 产出经 onOutputText 捕获 —— runtime 在成文轮**直接 return，那段文本
  // 从不进 history**（runtime.ts:417-425），所以事后翻 messages 一定是空的。
  // 它是累积快照而非增量，赋值即可（runtime.ts:220）。
  let output = "";

  let result: AgentRunResult;
  try {
    result = await runAgent({
      ...connOptions(conn),
      preset,
      messages,
      toolContext: {
        projectPath: ctx.projectPath,
        loreIndex: ctx.loreIndex,
        // 子代理自己的多模态能力，与主模型无关。
        multimodal: conn.model.type === "multimodal",
        // 沙箱：没有审批通道、没有方案门、没有工作区句柄 ⇒ 它既写不了正文
        // 与设定，也调不动 delegate（后者还被 SUB_PRESETS 的工具集挡了一道）。
        taskWorkspace: undefined,
        signal: ctx.signal,
      },
      signal: ctx.signal,
      onEvent: (e) => ctx.onNestedEvent!({ ...e, parentStep: call.id }),
      onOutputText: (text) => { output = text; },
      // 不给 onRoundLimit：子代理撞上限就按老规矩强制成文，不去打扰作者。
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;   // 中止要往上传，不能吞
    return fail(`the ${kind} subagent failed: ${(e as Error).message}`);
  }

  // 记账：一次子跑一行，model_id 是子代理的。
  await persistUsage(
    ctx.projectPath, conn.model.id,
    result.inputTokens, result.outputTokens,
    costFor(conn.model, result.inputTokens, result.outputTokens, result.cachedTokens),
    `subagent:${kind}`, result.cachedTokens,
  );

  if (!output.trim()) return fail(`the ${kind} subagent returned nothing. Try a narrower task, or do it yourself.`);

  const { taskId } = await ctx.taskWorkspace.ensure(i18n.t("ai.taskDoc.untitled"));
  const note = await writeTaskNote(ctx.projectPath, taskId, {
    slug: `${kind}-${slugify(task)}`,
    title: task.slice(0, 80),
    content: output,
    sources: refs,
  });

  return {
    toolCallId: call.id,
    content: [
      `The ${kind} subagent finished. Full findings saved to: ${note.path}`,
      `Call read_note with that path when you need the detail.`,
      ``,
      `Summary:`,
      clip(output, DELEGATE_SUMMARY_CHARS),
    ].join("\n"),
  };
}

**命名的两条规矩**（PR-C 审阅补）：工作区标题用 `ai.taskDoc.untitled`，
**绝不是**委托指令——任务叫什么归 `task_plan` 管，而 delegate 的 `task` 按设计
就是一整段自足指令，拿它当标题会让 `task.md` 的 H1 变成一个段落（PR-A 已为
`write_note` 修过同一条）。note 的 slug 只取指令前 20 个码点：文件名是文件名，
完整指令留在 note 首行的标题里。

/** 回给主模型的摘要上限。够判断「要不要展开读」，不够顺手替代读 note。 */
const DELEGATE_SUMMARY_CHARS = 800;
```

关于 `persistUsage`：**今天没有可复用的函数**。三份逐字相同的私有副本分别在 `aiTaskStore.ts:670`、`memoryStore.ts:369`、`agentStore.ts:241`。`lib/agent` 不该再抄第四份，也不该反向 import store。**PR-C 的前置改动**：把它提到 `lib/ai/usage.ts`（用量的读侧已经在那里），三个 store 改为 import。这是纯搬运，独立可测。

### 5.4 四条硬约束的落实点

| 约束 | 落实处 | 为什么这里够 |
| :--- | :--- | :--- |
| **深度 1** | `SUB_PRESETS[kind].tools` 不含 `"delegate"` | `executeRegisteredTool`（`registry.ts:1003`）按 `allowed` 白名单查表，不在名单里直接返回 `Unknown tool` |
| **只读** | 子 `ToolContext` 的 `requestApproval` / `requestPlanApproval` / `lorePlan` / `taskWorkspace` 全部不传 | L2 提案工具在缺 `requestApproval` 时自报错（`imageTools.ts:51`），lore 写工具在缺 `lorePlan` 时被 `checkPlan` 挡下（`plan.ts:108`）。**两道独立的闸，工具集是第三道** |
| **零上下文渗透** | `messages` 只有 2 条，现场构造 | —— |
| **共享 signal** | `ctx.signal` 直接透传给 `runAgent`；`AbortError` 向上重抛而不转成 tool error | 转成 tool error 会让主模型以为「搜索失败」并重试，而作者其实是按了停止 |

### 5.5 `image` 为什么不在里面

生图已经有完整的 L2 提案链路（`imageTools.ts` + `lib/image/illustrate.ts`）与自己的模型选择（`imageModelId`），且它**要花钱、必须逐次审批**，与「子代理默默干活再交报告」的形态相反。把它塞进 `delegate` 只会绕过审批卡。

`imageModelId` 与子代理表的归口留到 PR-E，且只是配置层面的归口，调用链不变。

---

## 6. 能力路由

### 6.1 `ToolContext.multimodal` 的语义不动

`multimodal` 在 `tools.ts:130` 与 `tools.ts:205` 里决定的是 **「要不要把 base64 塞进当前这次请求的模型」**，由 `run.ts:45` 从 `model.type === "multimodal"` 得出。

把它改成「链路上有人能看图」会让纯文本主模型收到它读不了的 base64 —— 烧 token，还可能被端点 400。**所以这个字段一个字不改。**

UI 的灰显判断需要的是另一个概念，单独给：

```ts
// lib/agent/subagent.ts
/** 这条链路上有没有人能看图 —— 只给 UI 用（设定库的「AI 描述」按钮等）。 */
export function chainCanSeeImages(mainModel: Model, subs: Record<SubAgentKind, SubAgentConfig>): boolean {
  return mainModel.type === "multimodal" || (subs.vision.enabled && !!subs.vision.modelId);
}
```

### 6.1.1 直接 UI 动作也走同一条优先级（PR-D 定）

设定库的「AI 描述」这类**不经 agent 的直接动作**，同样是 **子代理可用就优先子代理**
（`resolveVisionConn`）。理由不是省事，是让开关只有一个含义：`routeTools` 已经在
工具集层把图片工具从主模型手里拿走了，若 UI 动作反过来优先主模型，同一个开关在
两处表示相反的事——而且对一个用多模态主模型的作者，那个开关将永远不产生任何效果。
代价是多一跳。

两条配套约束：

- **「启用且绑定」不等于可用。** 设置面板会警告但仍允许把纯文本模型绑给
  `vision`（作者可能配到一半），所以 `visionSubAgentModel()` 必须再验一次
  `type === "multimodal"`；`chainCanSeeImages()` 与 `resolveVisionConn()` 都走它。
  只信标志位，就会点亮一个图片入口然后把图发给读不了图的模型。
- **失败要带原因。** `resolveVisionConn` 返回判别联合而不是 `null`：调用点都在
  作者刚按下的控件后面，「什么都没发生」是最没用的反馈。密钥缺失同样不得降级成
  空串（同 §5.2.2）。

### 6.1.2 附件闸放宽了，管道也要通

`allowImages` **仍然只看主模型**——base64 绝不能进一个读不了它的模型的上下文
（§6.1）。但把 UI 的附图入口放宽到 `chainCanSeeImages` 之后，若管道不动，作者就会
看到一个能点的回形针，然后得到一句「图片未能发送」。

所以未发出的图片改为**同时给出路径**，并在有 vision 子代理待命时把那条告示从
道歉改成指令：路径正是 `delegate(kind:"vision", refs:[...])` 要的东西
（`buildChatMessage` 的 `visionDelegate` 选项）。只给文件名时，模型看得见缺了什么，
却没有任何办法去取。

### 6.2 路由 = 改工具集，不是改提示词也不是改返回值

作者的规则是「主模型也支持、子代理也支持时，**优先子代理**」。

> 第一版把它收窄成「仅当主模型是纯文本时才重定向」，那样多模态主模型仍自己看图，vision 子代理形同虚设。这里改回 HLD 语义。

做法是**从主模型的有效工具集里拿掉被接管的工具**，而不是让工具返回一句「请改用 delegate」。前者是硬保证，后者仍要模型配合，而且白白花一次工具往返。

```ts
// lib/agent/routing.ts（新文件，位于 preset 与 registry 之间）
export interface RoutedTools {
  tools: ToolId[];
  /** 主模型这次是否还允许用端点自带的搜索。 */
  serverTools: "final-round-off" | "off";
}

export function routeTools(
  preset: TaskPreset,
  subs: Record<SubAgentKind, SubAgentConfig>,
  hasWorkspace: boolean,
): RoutedTools {
  let tools = [...preset.tools];
  const live = (k: SubAgentKind) => subs[k].enabled && !!subs[k].modelId;

  // vision 接管看图：拿掉图片工具，主模型只能委托。
  if (live("vision")) tools = tools.filter((t) => t !== "read_image" && t !== "read_lore_image");

  // longread 不接管 read_file —— 主模型读一小段正文是它的日常工作，
  // 全部委托出去反而多一次往返。longread 是「通读一大摞」的加法，不是替代。

  if (SUBAGENT_KINDS.some(live) && hasWorkspace && !tools.includes("delegate")) {
    tools.push("delegate");
  }
  // search 接管联网：主模型不再直接持有端点搜索。
  return { tools, serverTools: live("search") ? "off" : (preset.serverTools ?? "final-round-off") };
}
```

三点说明：

1. **`delegate` 需要工作区**（子代理产出要落盘），所以 `hasWorkspace` 为假时不加它 —— lore modal 这类表面不会莫名其妙多出一个用不了的工具。
2. **`search` 启用 ⇒ 主模型的 `serverTools` 关掉。** 这不只是「优先子代理」，更是把 MiniMax 那套 `pause_turn` / 续跑 / `tool id not found` 的复杂度**关进子跑里** —— 主 history 从此见不到 `web_search_tool_result` 这类块（`anthropic-plan.md` §10.7）。
3. 路由结果覆盖 `preset.serverTools`，两者的优先级要在 runtime 入口处一次性算清，不要两处各判一次。

### 6.3 模型幻觉调用被拿掉的工具

主模型若仍调 `read_image`，`executeRegisteredTool` 返回 `Unknown tool: read_image`（`registry.ts:1014`）。这条信息偏弱但可自纠。**不**为此加特例分支：路由一旦开始按名字打补丁，就得为每一对「被谁接管」维护映射表。真观察到模型反复撞墙，再在 `delegate` 的描述里点名它接管了什么。

---

## 7. 前端与可视化

### 7.1 `AgentEvent` 加 `parentStep`

`AgentEvent` 是 13 个内联对象字面量的联合（`events.ts:31-165`），**没有** `AgentEventBase` 可以继承。最小改动是把整个联合包一层交叉类型 —— 联合与对象类型的交叉会分配到每个成员，`kind` 的判别式收窄与穷尽检查都不受影响：

```ts
// events.ts
/** 每个事件都带。只有从嵌套子代理转发上来的事件会设值。 */
export interface AgentEventScope {
  /** 拥有这个事件的 `delegate` 步骤的 toolCallId。 */
  parentStep?: string;
}

export type AgentEvent = AgentEventScope & (
  | { kind: "run-start"; … }
  | …                              // 13 个成员一字不改
);
```

#### 去重键必须带上 `parentStep`

`replaceableIndex`（`events.ts` 末尾）现在按 `toolCallId + name` 去重 tool-step、按 `round` 去重 reasoning。子跑的轮次也从 1 开始，**它的 reasoning 会顶掉主 run 第 1 轮的 reasoning 行**。两处都补上作用域比较：

```ts
if (event.kind === "tool-step") {
  return log.findIndex((e) => e.kind === "tool-step"
    && e.parentStep === event.parentStep
    && e.step.toolCallId === event.step.toolCallId
    && e.step.name === event.step.name);
}
if (event.kind === "reasoning") {
  return log.findIndex((e) => e.kind === "reasoning"
    && e.parentStep === event.parentStep
    && e.round === event.round);
}
```

### 7.2 `AgentLog.tsx` 四段分层（2026-08-14 定）

事件流是平的、按时间排的——上线路对，读起来错。一个跑了十二轮、中间派了一次
子代理的 run，到了面板上就是六十条平级的行，而「它现在在干什么」「第 3 轮干了
什么」「那个搜索子代理搞成什么样了」是三个不同的问题，在抢同一列。所以拆四段：

| 段 | 内容 | 归属 | 状态 |
|----|------|------|------|
| ① 头行 | run 状态 + **当前动作** + 轮次/用量；点开是日志尾巴 | 每个 run | 已实现 |
| ② 轮次 | 已完成的轮次，手风琴，一次只开一个 | 每个 run | 已实现 |
| ③ 子代理 | 每次 delegate 一张卡，内含子跑的完整日志 | 每个 run | 已实现 |
| ④ 任务 | `task.md` 的步骤与进度、累计用量 | **会话级** | 见 §7.3 |

形状由 `lib/agent/logModel.ts` 算（纯函数、有测试），组件只管画。四条判断：

- **头行说的是「在做什么」，不是「在运行」。** 卡在 40 秒文件读取上的 run 和卡在
  联网搜索上的 run，只说「执行中」是同一个样子，而这恰恰决定作者是等还是插手。
  所以文案从 `current` 那个**事件**生成，不是从状态字符串。
- **在跑的那一轮属于①，不属于②。**「现在」和「刚才」是两个问题；把在飞的轮次同时
  列进两处，正是这次重排要终结的「什么都说两遍」。②因此只列已完成的轮次。
- **轮次收起行必须自带内容。**「第 3 轮」是一份没人看得见的文档的目录条目——作者
  要找哪一轮读了文件，就得把每一轮都点开。所以收起行报出该轮真正调用过的工具名。
- **③ 不是 ② 的一行。** delegate 的 `tool-step` 仍留在它所属的轮次里（那是事实），
  但 `roundRows()` 把它滤掉，只在 ③ 出现一次。子代理是唯一一个作者有理由读它
  *内部*的步骤：它跑在另一个模型上、花的是另一份预算、返回的摘要后面全靠它。
  在此之前它藏在 delegate 行展开后的详情里，等于没有。

`kind` / `task` 从 `argumentSummary` 里用**正则**抠，不用 `JSON.parse`：runtime 只留
参数的前 `TOOL_ARGS_DETAIL_CHARS`（400）字符，而 `delegate` 按设计就是唯一一个
`task` 是一整段话的工具，它的 JSON 常态性地断在字符串中间、根本 parse 不出来。

### 7.3 任务面板 band ④（`components/ai/TaskPanel.tsx`）

**它是会话级的，不能塞进 `AgentLog`。** 对话助手里每个 assistant 轮次各渲染一张
`AgentLog`（`AgentChat.tsx` → `AssistantTurn`），band ④ 若照搬，十轮对话就有十份
一模一样的任务计划。子代理属于「这一轮的执行动作」，任务计划属于「这个会话」。
所以它挂在输入框上方（`.taskBand`，`:empty` 时整块消失），AiPanel 则挂在运行区。

**数据源是 `.ai-writer/tasks/<id>/task.md`，必须读盘，不能从事件流推。**
`task_plan` 的参数同样受 400 字符截断，六个中文步骤就可能拼不回来；更要紧的是，
暂停恢复之后新一轮对话的事件流里**根本没有那份计划**，只有盘上有。何时重读由
`taskDocRevision()` 给：数**已落地**（非 running）的 `task_plan` / `task_progress`
调用——数「发起」会在写盘之前就去读。

**没有步骤就没有面板。** 只写了笔记、没有拆过步骤的工作区不是计划，而输入框上方
一条空进度条是每个会话都在付出的消息空间，却什么都没说。

- 收起态：任务名 + `3/5` + 累计 token + 一条 pip 进度条（进度不点开就能看）；
  展开态：同一批步骤，带标题。跳过用删除线——「这条不做了」和「这条做完了」
  不能长一个样。
- 用量口径是**「本次会话累计，含子代理」**，且**主/子分开算**（`sumTokens`）：
  两者跑在不同模型、不同价钱上，合成一个数就把委托的意义盖掉了——它恰恰是把一次
  又大又便宜的阅读从贵模型上挪走。子代理那半来自 `executeDelegate` 新发的、带
  `parentStep` 的嵌套 `run-done`（DB 里的 `token_usage` 行是永久账本，但不打开
  设置→用量就看不见，而委托恰恰是作者**当下**要拍板的那一步）。
- 真·任务级总账（跨暂停恢复）要给 `token_usage` 加 `taskId` 列，那是单独一件事，
  不能拿会话累计冒充，所以文案写「本次」。
- 任务列表页、notes 列表、`paused` 任务的继续按钮已由 `TaskWorkspaceView` 落地
  （对话头部「任务」入口），并于 2026-08-15 对齐设计稿 1g：步骤行用方块词汇
  （绿勾 / 赭石实心方块+行高亮+「暂停于此」/ 描边空方块 / `–`+删除线），笔记为
  发丝线行式列表（mono 文件名 + 来源·字数 meta，见 §3.3 的机器头），底栏放
  「在新会话中继续」CTA。底栏左半留空——那是任务级 token 总账的落位处，仍待
  `token_usage` 的 `taskId` 列。尚未做：`task.md` 正文预览。

### 7.4 设置 → 子代理（`panes/SubAgentsPane.tsx`）

对齐设计稿 04「系统设置 · 子代理」（2026-08-18）。**一个 kind 一张卡**，因为一个
子代理就是一个对（专家 + 跑它的模型），把它拆成「启用」和「选择模型」两行，作者
要在两行之间自己合成「这东西现在能不能用」——那正是这张页面唯一要回答的问题。

- 卡头：状态点（灰=停用 / 橄榄=就绪 / 赭石=需要处理）+ 名称 + 前置条件芯片
  （`需 web_search` / `需多模态` / `大窗口优先` / `需 PDF 文件输入` / `需图像模型`）
  + 状态词 + 开关；停用时整张卡身（不含警告条）降到 `opacity: .55`；
- 卡身：一句说明、`执行模型` 下拉（`type` 按 kind 过滤：`imagegen` 只列图像模型，
  其余只列非图像模型）、右对齐的轮次预算/份数上限；
- 卡底：`warningFor` 的警告条（只有**已启用**的坏卡才同时把边框换成 `--stg-border-warn`
  ——停用的错绑定还不是任何人的问题）；
- 页头摘要「已启用 n / N · m 项需要处理」，页尾一句「做什么由程序决定，这里只绑模型」。

两个分组照运行时的真实分界切：**对话委托**（`DELEGATE_KINDS`，助手经 `delegate`
工具在独立上下文里跑）与**绘图工具**（`imagegen`，图像模型开不了会话，只能当工具
调用，见 §5.2）。分组不是新事实，是把已经存在的分界画出来。

卡上的数字读代码而非手抄：轮次预算取 `SUB_PRESETS[kind].maxRounds`（`maxRounds: 1`
显示为「单发请求」）、「服务端检索常驻」取 `serverTools === "always"`、PDF 的份数与
体积上限取 `MAX_PDF_FILES` / `MAX_PDF_BYTES`（为此从 `subagent.ts` 导出）——运行时
拒绝时说的限额与这里写的必然是同一个。

`warningFor` 比旧版多一条：**已启用、却没有任何可解析的绑定**（没绑，或绑的模型
被停用/改了 type 后不在候选里了）就是 `warnNoModel`。旧版只在绑了不合格的模型时
才出声，绑空反而一片安静——而那恰恰是运行时会当场拒绝委托的状态。

累计用量（按 `task LIKE 'subagent:%'` 聚合进 `lib/ai/usage.ts`）仍未做，设计稿也
没给它落位。

### 7.4.1 「启用」不等于「可用」，一处判断，处处一致

`subAgentModel(kind, models, subs)` 是这个问题的唯一答案：绑定存在、模型还在、
且满足该 kind 的前置条件（vision 要多模态，search 要 `web_search`）。
`routeTools`、chips、`chainCanSeeImages`、`resolveVisionConn` 全部走它。

不这么做的代价不止是「多一个没用的按钮」：`routeTools` 见到 search 被启用，就会
把**主模型自己的**联网关掉（`serverTools: "off"`）并改发 `delegate`——若那个子代理
其实不能上网，作者就既失去了主模型的联网，又什么都没换回来。

### 7.5 会话级 chips

`AgentChat.tsx` / `AiPanel.tsx` 输入框上方渲染已启用子代理的 chips，可单次点掉。**会话级覆盖存在 store 里，不落 prefs** —— 它是「这次对话」的意思，不是设置。

覆盖**只减不增**（`withSessionOverrides`）：chip 只能关掉设置里已启用的，不能打开
一个没绑模型的——「就这一次用一下」需要一个作者从未做过的绑定。

而「这次对话」必须**在对话变化时全部清掉**：`resetChat` 与 `switchChatSession` 都要清。
只清前者，作者在对话 A 关掉的联网会跟着他进入从历史里打开的对话 B。

---

## 8. 文件变更清单

```
src/
├── lib/
│   ├── agent/
│   │   ├── events.ts            [MODIFY] AgentEventScope 交叉类型；replaceableIndex 带 parentStep；
│   │   │                                 round-limit 事件改载 decision
│   │   ├── presets.ts           [MODIFY] TaskPreset 增 scratchpad / serverTools 字段；
│   │   │                                 LORE_GENERATE / LORE_SPLIT 显式 serverTools:"off"
│   │   ├── registry.ts          [MODIFY] ToolContext 增 4 个可选字段；注册 5 个 scratchpad 工具 + delegate
│   │   ├── runtime.ts           [MODIFY] serverTools 脱离 withholdTools；checkpoint 注入并撤回；
│   │   │                                 RoundLimitDecision 与 outcome:"paused" 提前退出；
│   │   │                                 toolContext 合入 signal / onNestedEvent
│   │   ├── routing.ts           [NEW] 能力路由（工具集改写）
│   │   ├── scratchpadTools.ts   [NEW] 5 个工作区工具 + 写入串行化
│   │   ├── subagent.ts          [NEW] SubAgentConfig / SUB_PRESETS / executeDelegate / chainCanSeeImages
│   │   └── taskWorkspace.ts     [NEW] task.md 序列化、步骤解析、note 读写、GC、Handle
│   ├── ai/
│   │   └── usage.ts             [MODIFY] 抽出共享 persistUsage（三个 store 改为 import）
│   ├── prefs.ts                 [MODIFY] 6 个子代理 PREF_KEYS
│   └── fs/projectBackup.ts      [MODIFY] 注释说明 .ai-writer/tasks 有意包含
├── stores/
│   ├── agentStore.ts            [MODIFY] RoundLimitDecision 契约；buildResumeSeed；
│   │                                     构造 taskWorkspace / resolveSubAgent
│   ├── aiTaskStore.ts           [MODIFY] persistUsage 改 import；同上的 ctx 构造
│   ├── memoryStore.ts           [MODIFY] persistUsage 改 import
│   └── aiStore.ts               [MODIFY] subAgents 状态 + 两处清理逻辑接入
├── components/
│   ├── ai/
│   │   ├── AgentLog.tsx         [MODIFY] 按 parentStep 分组 + 嵌套折叠
│   │   ├── RoundLimitCard.tsx   [MODIFY] 第三个按钮「存盘并暂停」
│   │   ├── SubAgentChips.tsx    [NEW] 会话级开关
│   │   └── TaskWorkspaceView.tsx[NEW] 任务列表与详情
│   └── settings/panes/
│       └── SubAgentsPane.tsx    [NEW]
└── i18n/locales/{en,zh-CN}.json [MODIFY] 见 §10
```

---

## 9. 异常与边界

| 场景 | 风险 | 对策 |
| :--- | :--- | :--- |
| 子代理异常 / 超时 | 主 run 崩溃 | `executeDelegate` 全包 try/catch → tool error；**唯独 `AbortError` 重抛**，否则主模型会把作者的「停止」读成「搜索失败」并重试 |
| 作者点停止 | 子代理后台继续烧钱 | 共享 `ctx.signal` |
| 递归委托 | 指数爆炸 | `SUB_PRESETS` 工具集不含 `delegate` + 注册表白名单双保险 |
| 路径越界 | 模型传 `../../writing/x.md` | `isPathWithin` + slug 字符白名单 |
| 同轮并发写 `task.md` | 丢更新 | 模块内 `writeChain` 串行化（§3.3.5） |
| 磁盘堆积 | 任务目录无界增长 | 排序 GC，未收尾的优先保留但**不豁免**（§3.4） |
| 恢复时源文件已变 | 基于过期正文推理 | `sourceRefs` 的 FNV-1a 比对，变动清单写进恢复提示（§4.4）。**这个字段必须真有写入方**——只声明而无人填，检查就永远不会触发。写入点是**暂停时**记录当前文档（`recordSourceRef`）：恢复要比对的正是「任务挂起时的那个状态」，而给模型读过的每个文件都算哈希要多一次整文件读 |
| 嵌套事件顶掉主 run 的日志行 | 日志错乱 | 去重键带 `parentStep`（§7.1） |
| 子代理返回空 | 写出一篇空 note | 空产出直接返回 tool error，不建 note |
| 会话折叠吃掉 note 路径 | 模型忘了自己存过什么 | `compact.ts` 的 `renderTurnsForSummary` 已渲染工具调用；在 `ai.instructions.chatCompact` 里加一句「保留提到过的 `notes/` 路径」。**不**把 note 加进 `injectionCarriers`（那是给可复现的检索块用的） |
| 子代理绑的模型被删 | 指向空行 | `aiStore` 两处清理逻辑接入（§5.1）；`resolveSubAgent` 再兜一次 |

---

## 10. i18n 与 profile 约束

- 提示词一律走 i18n，**不硬编码中文**：`ai.instructions.subagent.{search,vision,longread}`、`subagentTask`、`scratchpadCheckpoint`、`taskResume`、`taskResumeNoNotes`；
- 需要 profile 词汇的提示词在解析处传 `promptParams(isZh)`（CLAUDE.md：绝不在组件或 i18n 值里硬编码 章/卷/设定）；
- 子代理的 system prompt 属于「通用助手」语域，用中性词（文档 / 知识库），novel 需要小说措辞时另开 `*Novel` 键；
- 工具 `description` 保持英文（与注册表其余工具一致），但同样避开 章节/设定 这类 profile 专属词；
- 恢复任务的 system prompt **必须** `profileSystemPrompt()`，不得用 `ai.instructions.system`。

---

## 11. 测试计划

CI 是 PR 门禁（`docs/reference/ci.md`：tsc + vitest + build，Rust fmt/clippy/test）。至少覆盖：

| 测试 | 位置 | 断言 |
| :--- | :--- | :--- |
| `task.md` 序列化往返 | `lib/__tests__/taskWorkspace.test.ts` | parse∘serialize 恒等；作者手改复选框后 `parseSteps` 读出新状态；元数据损坏时 `parseTaskDoc` 返回 null 而不抛 |
| 步骤寻址 | 同上 | `task_progress({step:2,action:"check"})` 只改第 2 行；越界序号返回 tool error |
| 路径沙箱 | `lib/__tests__/scratchpadTools.test.ts` | `slug: "../../x"`、绝对路径、空 slug 三种输入都被挡 |
| **serverTools 策略** | `lib/__tests__/agentRuntime.test.ts` | `tools:[] + serverTools:"always"` 的预设，**每一轮**的请求都带 serverTools（这是 §5.2.1 那个 bug 的回归测试）；默认策略的收尾轮不带 |
| checkpoint 撤回 | 同上 | 注入 checkpoint 的那一轮请求里有提示消息，**该轮结束后 history 里没有** |
| 暂停退出 | 同上 | `onRoundLimit` 返回 `{action:"pause"}` 时 `outcome === "paused"`，且 history 的 tool_call 配对完整 |
| 委托沙箱 | `lib/__tests__/subagent.test.ts` | 子 `ToolContext` 不含 approval/plan/workspace；`SUB_PRESETS` 均不含 `delegate`；`AbortError` 被重抛而非转成 tool error |
| 产出捕获 | 同上 | mock `runAgent` 只经 `onOutputText` 吐字，note 内容与之一致（这是 §0 第三条的回归测试） |
| 能力路由 | `lib/__tests__/routing.test.ts` | vision 启用 ⇒ 工具集无 `read_image`；search 启用 ⇒ `serverTools: "off"`；无工作区 ⇒ 无 `delegate` |
| 日志作用域 | `lib/__tests__/agentEvents.test.ts` | 主 run 与子跑各自的 round-1 reasoning 并存，互不覆盖 |
| 子代理配置清理 | `lib/__tests__/aiStoreRemoval.test.ts` | 删除模型后 `subAgents.*.modelId` 被清空（沿用 `memoryModelId` 的既有用例） |

---

## 12. 分阶段实施

### PR-A · 任务工作区与 scratchpad 基建
`taskWorkspace.ts`、`scratchpadTools.ts`、`ToolContext.taskWorkspace`、`TaskPreset.scratchpad`、checkpoint 注入与撤回、GC、备份注释。
**验收**：长任务在接近上限时写出 notes；裁剪后模型能 `read_note` 取回结论而不重搜；`preset.scratchpad = "off"` 时行为与 main 逐字一致。

### PR-B · 存盘暂停与恢复
`RoundLimitDecision` 契约、runtime 提前退出、`buildResumeSeed`、`TaskWorkspaceView`。
**验收**：撞上限后暂停 → 重启应用 → 点继续 → 新上下文里没有任何旧对话，且接着未完成的步骤跑。

### PR-C · `delegate` 与 `search` 子代理
前置：抽出共享 `persistUsage`。含 `subagent.ts`、`TaskPreset.serverTools` 策略拆分、`AgentEventScope`、嵌套日志。
**验收**：主模型 DeepSeek（不能联网），经 `delegate(search)` 调起 MiniMax-M3 完成查证；日志嵌套折叠；`token_usage` 出现 `subagent:search` 行且 `model_id` 是子代理的；**主 run 的请求体里从头到尾没有 `web_search`**。

### PR-D · `vision` / `longread` 与能力路由
`routing.ts`、`chainCanSeeImages`。
**验收**：主模型为纯文本时能完成识图任务，且它的工具集里确实没有 `read_image`。

### PR-E · 会话 chips 与归口

> 设置面板已提前到 PR-C：没有它，`ai:subagent:*:enabled` 没有任何写入途径，
> PR-C 那条「用 DeepSeek 主模型经 delegate 调起 MiniMax」的验收标准就无法执行。
`SubAgentsPane`、`SubAgentChips`、`imageModelId` 归口到子代理配置表（**仅配置层归口，生图调用链与审批卡不变**）。
**验收**：设置里可配可看用量；chips 能单次关掉某个子代理。

---

## 13. 与既有机制的边界（不做什么）

- **不替代 `compact`**：会话折叠管「聊过什么」，工作区管「查到什么、做到哪」。
- **不替代 `PlanGate`**：那是授权，这是记忆。`task.md` 的步骤**不授予任何写权限**。
- **不做通用多智能体框架**：无子代理间通信、无并行编排、无递归。
- **工作区不进文档树**，不参与导出。
- **子代理不写正文、不写设定、不生图。**
