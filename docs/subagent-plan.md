# 长任务工作区与子代理（high-level design）

> **状态：设计稿，尚未实现。** 本文只做可行性判断与架构选型，不描述已有行为。
> 已实现的 agent 体系见 [`unified-agent-plan.md`](unified-agent-plan.md)，
> 对话侧的上下文折叠见 [`chat-memory-plan.md`](chat-memory-plan.md)。

## 0. 问题从哪来

这份设计是被 MiniMax-M3 的服务端 `web_search` 逼出来的（`anthropic-plan.md` §10）。
那一轮排查暴露的现象，逐条看都像独立的 bug，连起来看是同一个结构缺陷：

- 一次带搜索的任务，输入侧观测到 **8 次搜索 / 123k input token**（记录在
  `lib/ai/serverTools.ts` 的 `TRANSCRIPT_CHARS` 注释里）；
- `trimHistory` 为了不撞 context 上限，把最旧的工具结果替换成
  `[earlier tool result dropped…]` —— 于是模型**再搜一遍**，于是又满了；
- 撞到 `maxRounds` 时只有两个出口（继续加轮 / 收尾成文），没有第三个出口；
- 重跑时作者历史里那几条 `continue`、`重试` 被当成新指令，agent 自我强化地
  "继续"下去（本次只做了 `【作者消息】` 标注这一层兜底）。

**一句话根因：这套 runtime 只有一种记忆，就是 wire history。**
它既落不了盘，也挑不出重点。上下文一满，可用手段只有删（`trimHistory`，破坏性）
或压（`compact.ts`，只服务 chat 的轮与轮之间）。删掉的东西再也回不来，
模型只好重做，重做又把它填满。

作者提的两条改造，正好对着这个根因的两半：把记忆放到磁盘上（§3.1），
把不该进主上下文的活儿交出去（§3.3）。

## 1. 现状盘点：已经有什么地基

| 已有 | 它给了什么 | 缺什么 |
| --- | --- | --- |
| `agent/runtime.ts` 的 tool loop | 与 provider 无关的多轮循环；`messages`/`signal`/`onEvent` 全部由调用方传入 | —— **天然可重入**，这是子代理的关键前提 |
| `agent/plan.ts`（`propose_lore_plan` + `PlanGate`） | 一个"计划"概念，一张卡片管一整轮整理 | 它是**授权**不是**记忆**：内存态、随 run 死、只覆盖 lore 写入 |
| `agent/compact.ts` + `compactRun.ts` | 滚动摘要，把旧轮次折进一段 summary | 只在 chat 的**轮与轮之间**触发；轮**内**增长管不到；摘要在内存/DB 里，不是人能打开的文件 |
| `runtime.trimHistory` | 上下文兜底，先丢图片再丢工具结果 | 纯破坏性，丢掉的内容没有第二份 |
| `runtime.onRoundLimit` + `RoundLimitCard` | 撞墙时阻塞问作者 | 只能"再给几轮"，不能"存盘、下次接着跑" |
| `context/memory.ts` + `.ai-writer/memory/*.md` | **一个"人可读正文 + `<!-- ai-writer-… {json} -->` 机器元数据"的落盘格式先例** | 只面向单个文档的前情，不面向任务 |
| `ai:memoryModelId` / `ai:imageModelId` | **"按用途绑一个模型"的先例，已经跑了两个特例** | 主模型看不见它们，也无法把活儿交给它们 |
| `ai/conn.ts` 的 `ConnOptions` / `resolveConn` | 一个模型接一个请求的唯一接缝 | —— 换模型跑一段，成本已经是零 |
| `agent/structured.ts` | "调一次模型，拿一个结构化答案回来"的单发原语 | —— |
| `ToolContext.multimodal` | 已经知道"当前模型看不了图"并据此**降级**（不塞图片 payload） | 只会降级，不会**转交** |
| `token_usage` 表 | 每行自带 `model_id` | —— 分模型记账不需要改表 |

结论：两条改造要的东西，**没有一样需要新协议、新 provider 抽象或 runtime 主循环重写**。

## 2. 可行性判断

**都可行。** 分别看：

**想法 1（计划/任务追踪文件）—— 低风险，纯增量。**
把 agent 的记忆从"只有 wire history"扩成"wire history + 磁盘工作区"。
新增的是一个目录、四个工具、两个强制触发点；`runAgent` 主循环本身几乎不动。
最大的收益不是"能看进度"，而是下面这条性质：

> **裁剪从破坏性变成非破坏性。** 结论落在盘上，被 `trimHistory` elide 掉的只是
> 它在上下文里的一份拷贝，模型可以 `read_note` 拿回来。

这一条直接解掉 §0 的第 2、3、4 个现象。

**想法 2（子代理）—— 机制简单，配套是真成本。**
子代理**就是一个工具**：执行器是一次嵌套的 `runAgent`，换一份 `ConnOptions`、
换一份 preset、开一条独立 history。机制上 `ConnOptions` + `runAgent` +
`structured.ts` 已经把"换个模型跑一段"做完了。真正要新写的是配套：
用量记账的分摊、执行日志的嵌套渲染、审批与方案门控的边界、设置界面、
以及"优先用子代理"这句话怎么变成**保证**而不是**祈祷**（§3.4）。

**两者的关系，作者说对了：#1 是总线，#2 是设备。**
子代理的产出**不该整块塞回主上下文**——那只是把堆叠换了个地方堆。
它该落进工作区文件，回给主模型的是「一段摘要 + 一个路径」。
没有 #1，#2 会把今天的问题原样复制到主 agent 身上。

## 3. 目标架构

```
        ┌──────────────── 主 agent（今天的 runAgent，全工具集）────────────────┐
        │                                                                     │
        │   wire history ──── trimHistory / compact（只管上下文，不再管记忆）  │
        │        │                                                            │
        │        ├── task_plan / task_progress / write_note / read_note ──┐    │
        │        │                                                       │    │
        │        └── delegate(kind, task, refs) ─┐                       │    │
        └────────────────────────────────────────┼───────────────────────┼────┘
                                                 │                       │
                        ┌────────────────────────▼──────┐                │
                        │ 子代理：另一份 ConnOptions      │                │
                        │ 独立 history · 只读 · 深度 1    │                │
                        │ search / vision / longread     │                │
                        └────────────────┬───────────────┘               │
                                         │ 产出落盘                       │ 读写
                                         ▼                                ▼
                        .ai-writer/tasks/<taskId>/{task.md, notes/*.md}
```

### 3.1 任务工作区（`.ai-writer/tasks/`）

```
.ai-writer/tasks/<taskId>/
  task.md            ← 目标 + 步骤清单 + 进度。人可读、可手改
  notes/<slug>.md    ← 中间结果：搜索摘要、识图结论、长文提要、子代理产出
```

- `<taskId>` = 时间戳 + slug，落在 `.ai-writer/` 下而**不是** `writing/`：
  它是过程物，不是作品，不参与导出。
- `task.md` 沿用 `context/memory.ts` 已验证的格式：首行
  `<!-- ai-writer-task {json} -->` 承载机器状态（runId、模型、状态、步骤勾选、
  创建/更新时间），其下是人可读的 markdown。作者可以直接改正文，
  元数据块每次写入重建。
- **保留策略**沿用 `sessionDb.ts` 的做法：写入路径上做 GC，只留最近 N 个任务目录。
- **进 `projectBackup`**：它不在 `EXCLUDE` 名单里（对照 `.ai-writer/tmp` 是 scratch
  所以被排除）。任务工作区是可恢复状态，该跟着项目走。

**四个新工具**（注册进 `registry.ts`）：

| 工具 | 级别 | 说明 |
| --- | --- | --- |
| `task_plan` | write-auto | 建立/重写 `task.md` 的目标与步骤清单 |
| `task_progress` | write-auto | 勾掉一步 / 追加一步 / 记一句结论。**追加式**，不整篇重写 |
| `write_note` | write-auto | 写一篇中间结果到 `notes/`，返回相对路径 |
| `read_note` / `list_notes` | read | 回读。`read_note` 沿用 `read_file` 的行号分页 |

访问控制：新增白名单 `.ai-writer/tasks/`，一律过 `isPathWithin`，单文件有大小上限。
**不过 `PlanGate`** —— 那道门是为"改作者的设定"设的，这里是 agent 自己的草稿纸，
加门只会让模型在自己的笔记本上也要请示。

**两个强制触发点。** 光有工具不够，模型不会主动用：

1. **裁剪前的 checkpoint 机会。** `trimHistory` 判定即将丢弃内容时，
   先注入一条 user 提示（"上下文即将裁剪，把还需要的结论写进 notes"）跑一轮，
   再执行裁剪。
2. **`RoundLimitCard` 增加第三个选项：存盘并暂停。** 今天只有「继续」与「收尾」，
   撞墙时作者其实最想要的是"别丢，下次接着"。

### 3.2 恢复：继续任务，而不是继续对话

有了 `task.md`，"继续"从**重放对话**变成**读取状态**：

- 新 run 的种子 = system prompt + `task.md` + notes 索引（只给标题和路径），
  **不带**上一次的 wire history。
- 这正面解掉 §0 第 4 个现象：恢复的是**任务状态**，不是**对话记录**，
  作者三个月前那句 `continue` 根本不会出现在新上下文里。
- UI：AiDrawer 里一个任务列表（进行中/已完成），每个任务一个「继续」按钮，
  以及 `task.md` 的只读渲染视图。

### 3.3 子代理（`lib/agent/subagent.ts`）

```ts
// 可委托的种类。`image` 有意不在其中 —— 它要花钱、必须逐次审批，
// 与「子代理默默干活再交报告」的形态相反，继续走既有的 illustrate 提案链路。
// 详见 docs/subagent-lld.md §5.5。
type SubAgentKind = "search" | "vision" | "longread";

interface SubAgent {
  kind: SubAgentKind;
  /** 绑定到某个已配置的 Model 行（config.db），沿用 imageModelId 的模式。 */
  modelId: string;
  enabled: boolean;
}
```

**内置种类，不做任意自定义** —— 沿用 workspace profile 的选型理由：
每个 kind 决定了 preset（工具集 + 轮数）、输入形状、产出形状三件事，
它们是代码而不是配置。作者能配的是"这个种类用哪个模型、开不开"。
自定义子代理留作后续，加比减容易。

| kind | 干什么 | 典型模型 | 输入 | 产出 |
| --- | --- | --- | --- | --- |
| `search` | 联网查证 | MiniMax-M3（`serverTools: ["web_search"]`） | 若干个问题 | `notes/search-*.md` + 一段摘要（**必带 URL**） |
| `vision` | 看图并回答 | Gemini / Opus / MiniMax | 图片路径 + 问题 | `notes/vision-*.md` + 一段结论 |
| `longread` | 通读长文档并提要 | 大窗口便宜模型 | 文件路径 + 问题 | `notes/read-*.md` + 一段摘要 |

生图**不是**其中一种。它要花钱、必须逐次审批，与"子代理默默干活再交报告"的形态相反；
把它塞进 `delegate` 只会绕过审批卡。`imageModelId` 在 PR-E 归口到同一张配置表，
但调用链继续走既有的 `illustrate` 提案链路。

调用形态是**一个工具** `delegate(kind, task, refs?)`，执行器：

```
resolveConn(subAgent.modelId)
  → runAgent({
      ...connOptions(conn),
      preset: SUB_PRESET[kind],                  // 只读工具 + 该 kind 的轮数
      messages: [system(kind), user(task + refs)],// 全新 history
      signal: 父 signal,                          // 中止是一次
      onEvent: e => 父.onEvent({ ...e, parentStep: toolCallId }),
    })
  → 产出写进 notes/ → 返回 { notePath, summary }
```

**四条硬规矩**（都是为了不把复杂度放大成平方）：

1. **深度 1。** 子代理的工具集里没有 `delegate`。
2. **子代理只读。** 它不能碰 `writing/`，不能碰 `.ai-writer/lore/`，
   只能写自己那次任务的 `notes/`。审批（L2）、方案门控（`PlanGate`）、
   L1 备份全部留在主 agent —— **不需要跨 agent 推理授权**，这是最省事的一刀。
3. **不继承主 history。** 输入是主模型显式写下的一段任务描述 + 显式的路径引用。
   这正是"不把堆叠换个地方堆"的落实处。
4. **共享 signal 与预算。** 中止一次全停；每个子跑写自己的 `token_usage` 行
   （表已有 `model_id`，不需要改 schema）。

### 3.4 能力路由：为什么"优先子代理"不能靠提示词

作者的规则是"主模型也支持、子代理也支持时，优先交给子代理"。
**做法是改主模型看得见的工具集，而不是在提示词里写一条偏好。**
偏好靠模型自觉，工具集是硬保证。这一层放在 `registry` 与 `preset` 之间，
`getToolDefinitions` 之后：

- 启用 `vision` 子代理 → 主模型的 `read_image` / `read_lore_image`
  **不再返回 `imageDataUrls`**，改为返回"这张图请用 `delegate(vision, …)` 看"；
- 启用 `search` 子代理 → 主模型请求**不带 `serverTools`**，改带 `delegate`。
  （注意这条正是本次踩过的坑：`serverTools` 来自 `Model` 行而不是 preset，
  会绕过任务级的闸 —— 见 `runtime.ts` 里 `withholdTools` 那段注释。
  能力路由必须在同一处把它收编。）

顺带一个语义升级：`ToolContext.multimodal` 今天的含义是"**主模型**能不能看图"，
引入 vision 子代理后应变成"**这条链路上有没有人**能看图"。

### 3.5 UI

- **设置 → 子代理**：每个 kind 一行（模型下拉 + 开关 + 累计用量），
  复用「供应商与模型」那套 row/section/drawer 词汇（`settingsUi.module.css`）。
- **对话输入框上方**：本次会话启用哪些子代理的 chips —— 作者明确要的"主动选择"。
- **`AgentLog`**：`delegate` 渲染成一个**可展开的嵌套块**，默认收起，
  收起态显示 `kind + 摘要 + 耗时 + token`。`AgentEvent` 需要一个 `parentStep` 字段。
- **任务视图**：`task.md` 的只读渲染 + 「继续」按钮（§3.2）。

## 4. 分阶段

| PR | 内容 | 验收 |
| --- | --- | --- |
| **A** | 任务工作区 + 四个 scratchpad 工具 + 两个强制触发点 | 一个长搜索任务不再因裁剪而重搜；`.ai-writer/tasks/` 里能看到 `task.md` 与 notes |
| **B** | 存盘暂停 + 从 `task.md` 恢复 | 撞轮数上限后可暂停，之后接着跑，且新上下文里没有旧对话 |
| **C** | `delegate` 机制 + `search` 子代理 + 嵌套日志 + 分模型记账 | 用 DeepSeek 当主模型跑一个需要联网的任务 |
| **D** | `vision` / `longread` 子代理 + 能力路由（§3.4） | 主模型不支持多模态时也能完成识图任务 |
| **E** | `image` 子代理收编；会话级开关 | `imageModelId` / `memoryModelId` 归口到子代理表 |

关于 E：`imageModelId` 与 `memoryModelId` 本质上是同一个东西的两个特例，
最终应该归口。但**不要一上来就动它们** —— 它们连着用量统计与设置界面这两个
稳定面，放在最后、在 `delegate` 已经被真实用过之后再收编，风险最小。

**建议先做 A、B。** 它们完全不依赖子代理，单独就能解掉 §0 里三个现象中的两个；
而且 `delegate` 的产出契约（一篇 note 到底该长什么样）只有在 A 被真实用过之后
才知道该怎么定。先定契约再实现子代理，比反过来省一次返工。

## 5. 边界：明确不做什么

- **不替代 `compact`。** chat 的轮间折叠继续管**对话**，工作区管**任务事实**，
  层次不同。一个是"我们聊过什么"，一个是"查到了什么、做到哪一步"。
- **不替代 `PlanGate`。** 那是**授权**，这是**记忆**。`task.md` 里的步骤
  不授予任何写权限；要改 lore 照样得走 `propose_lore_plan`。
  UI 上可以并排显示，数据结构不合并。
- **不做通用多智能体框架。** 没有子代理之间的通信，没有并行编排，没有递归，
  没有"子代理自己决定再叫谁"。一个主脑 + 一层单向委托，就这些。
- **工作区文件不进 `writing/`**，不参与导出，不出现在文件树里。
- **子代理不写正文、不写设定。**

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 弱模型压根不用 scratchpad | preset 增加 `scratchpad: "off" / "offered" / "required"`；`required` 时在裁剪与撞墙两处强制注入提示。全部 `off` 就是今天的行为，可整体回退 |
| 工作区自己变成新的上下文肥肉（每轮把 notes 全读一遍） | `read_note` 沿用 `read_file` 的行号分页；`task.md` 有大小上限；`list_notes` 只给标题+路径不给正文 |
| 委托放大成本与时延（每次都是一整跑） | 每个 kind 独立 `maxRounds`（search 4 / vision 2 / longread 3）；`delegate` 在父轮里只算一轮；设置里显示每个子代理的累计花费 |
| 记账被稀释、作者不知道钱花在哪 | 每个子跑写自己的 `token_usage` 行（`model_id` 已在表里）；用量面板按 `task` 维度加一个「子代理」分组 |
| 执行日志变噪音 | 嵌套折叠，默认收起 |
| 子代理产出不可信（编造搜索摘要） | note 强制带来源（URL / 文件路径+行号）；主模型的指令里要求引用 note 路径而非凭记忆复述 |
| 子跑异常炸掉整个任务 | 共享 signal；子跑的异常以**错误 tool result** 回给主模型，由它决定换个方式还是放弃 |
| 磁盘垃圾堆积 | 写入路径 GC，保留最近 N 个任务目录（沿用 `MAX_CHAT_SESSIONS` 的位置与做法） |
| 兼容层端点的既有坑（`pause_turn` / `tool id not found`） | `search` 子代理正是把 `serverTools` 关进小黑屋的地方：整个 turn 续跑逻辑只在子跑内部发生，主 history 永远见不到 `web_search_tool_result` 这类块 |
| 恢复出来的任务与磁盘现状对不上（文档已被作者改过） | `task.md` 元数据记录引用文件的路径+哈希（沿用 `memory.ts` 的 staleness 模型），恢复时校验并把过期项标出来 |
