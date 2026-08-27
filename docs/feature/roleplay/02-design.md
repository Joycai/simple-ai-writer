# 互动式角色扮演创作 — 详细设计

> 前置：先读 [01-overview.md](01-overview.md) 的四条不变量。本文只写「怎么做」。
> 涉及的既有代码全部给了 `文件:行号`，实现前请核对——行号会漂。

## 1. 模块清单

### 新增

| 路径 | 职责 | 约行数 |
|---|---|---|
| `src/lib/roleplay/model.ts` | 类型、常量、不变量断言 | 150 |
| `src/lib/roleplay/store.ts` | `.ai-writer/roleplay/` 的读写（花名册、人设卡、会话） | 320 |
| `src/lib/roleplay/transcript.ts` | transcript 追加 / 按轮号切片 / 检索 / 容错解析 | 260 |
| `src/lib/roleplay/memory.ts` | **角色记忆**：解析 / 增改 / 渲染注入块（§5） | 320 |
| `src/lib/roleplay/context.ts` | 播种历史 + 逐轮注入 + 记忆块刷新 | 300 |
| `src/lib/roleplay/presets.ts` | `ROLEPLAY_PRESET` / `NARRATOR_PRESET` | 90 |
| `src/lib/roleplay/memoryTools.ts` | `remember` / `revise_memory` / `recall` 三个工具处理器 | 200 |
| `src/lib/roleplay/sceneTools.ts` | 旁白的 5 个只读 scene 工具处理器 | 280 |
| `src/lib/roleplay/summary.ts` | 滚动摘要的生成与更新 | 120 |
| `src/lib/roleplay/flag.ts` | Beta 开关（照抄 `lib/pptx/flag.ts`） | 25 |
| `src/stores/roleplayStore.ts` | agent 花名册 + 活会话 + 并发闸 | 750 |
| `src/components/roleplay/RoleplayPanel.tsx` | 面板外壳：花名册 + 对话区 | 380 |
| `src/components/roleplay/RoleplayChat.tsx` | 单个 agent 的对话区 + composer | 420 |
| `src/components/roleplay/MemoryPanel.tsx` | 记忆面板：分组、编辑、跳轮 | 320 |
| `src/components/roleplay/AgentComposer.tsx` | 新建/编辑 agent 的抽屉 | 380 |
| `src/components/roleplay/*.module.css` | 样式 | 500 |
| `src/lib/roleplay/__tests__/*.test.ts` | transcript / memory / 上下文 / 并发 | 500 |

### 修改（全部是加法）

| 路径 | 改动 |
|---|---|
| `src/lib/agent/registry.ts` | `ToolId` 加 3 个记忆工具 + 5 个 scene 工具；`REGISTRY` 加 8 项；`ToolContext` 加 2 个可选字段 |
| `src/lib/prefs.ts` | `PREF_KEYS` 加 `app:roleplayBeta`、`app:roleplayActiveAgent` |
| `src/stores/appStore.ts` | `AiDrawerMode` 加 `"roleplay"`（`appStore.ts:142`） |
| `src/components/ai/AiDrawer.tsx` | 第四个 tab + 分支渲染 |
| `src/components/settings/panes/GeneralPane.tsx` | 实验功能区加一个开关（`GeneralPane.tsx:255` 的 `betaSection`） |
| `src/i18n/locales/{zh-CN,en}.json` | 新键，见 §13 |
| `CLAUDE.md` | 目录地图 + Detailed References 各加一行 |

**`lib/agent/*` 的运行时、压缩、@注入、审批一行不改。**

## 2. 数据模型

### 2.1 磁盘

```
.ai-writer/roleplay/
├── agents.json
└── <agentId>/
    ├── agent.md
    ├── transcript.md
    ├── memory.md
    ├── summary.md
    └── session.json
```

`agentId`：`rp-<base36 时间戳>-<4 位随机>`，与 `taskWorkspace.generateTaskId()` 同风格。是目录名，因此必须过字符校验（只允许 `[a-z0-9-]`），避免模型或导入数据造出穿越路径。

### 2.2 `agents.json` — 花名册

```jsonc
{
  "v": 1,
  "authorPersona": {              // 作者自己扮演谁（全局默认）
    "mode": "lore",               // "lore" | "prompt" | "none"
    "dirPath": "/abs/.../lore/characters/lin",
    "prompt": ""
  },
  "agents": [                     // 数组即显示顺序
    {
      "id": "rp-lx8k2p-a3f9",
      "kind": "character",        // "character" | "narrator"
      "name": "艾尔登",
      "primaryDirPath": "/abs/.../lore/characters/elden",  // narrator 恒为 null
      "boundPaths": [             // 常驻绑定，dirPath 或 dirPath#facet.md
        "/abs/.../lore/world/tower",
        "/abs/.../lore/characters/elden#outfit-armor.md"
      ],
      "modelId": null,            // null = 跟随全局 activeModelId
      "authorPersona": null,      // 覆盖全局；null = 用全局
      "taskId": null,             // 懒创建的 task workspace，见 §8
      "createdAt": 1755000000,
      "updatedAt": 1755000000,
      "turnCount": 42,
      "openMemoryCount": 3        // 活跃记忆条数，花名册上直接显示
    }
  ]
}
```

**为什么花名册是一个文件而不是每个 agent 一份元数据**：显示顺序、并发状态、「有哪些 agent」这三件事都需要一次性读全，扫目录再逐个读 frontmatter 是 N 次 IO 换零收益。人设卡和记忆（会变长、作者要编辑）才独立成文件。

**`boundPaths` 直接复用 `lib/context/loreSelect.ts` 的 pin 语法**（`dirPath` 或 `dirPath#facetFile`，见 `loreSelect.ts:49-58` 的 `parsePins`）。这不是巧合而是设计：绑定条目 = 永久钉住，和 AiPanel 的 `selectedLorePaths`（`AiPanel.tsx:1108`）是同一个概念，只是作用域从「一次任务」变成「一个 agent 的一生」。

### 2.3 `agent.md` — 人设卡

```markdown
---
id: rp-lx8k2p-a3f9
kind: character
name: 艾尔登
primary: characters/elden
---

# 扮演指令

（作者手写。留空则只用绑定条目本身的内容。）

说话短，句子不超过十五个字。从不解释自己的动机。
提到「塔」的时候会停顿一下再回答。
```

frontmatter 的四个字段与 `agents.json` 重复，是**故意的冗余**：花名册损坏时可以从各个目录重建，且作者把目录拷给别人时那个目录是自解释的。重建规则：`agents.json` 是权威，缺失的条目从目录扫描补回，冲突以 `agents.json` 为准。

### 2.4 TS 类型（`lib/roleplay/model.ts`）

```ts
export type AgentKind = "character" | "narrator";

export interface AuthorPersona {
  mode: "lore" | "prompt" | "none";
  dirPath: string | null;   // mode === "lore"
  prompt: string;           // mode === "prompt"
}

export interface RoleplayAgent {
  id: string;
  kind: AgentKind;
  name: string;
  primaryDirPath: string | null;   // narrator 恒为 null
  boundPaths: string[];            // pin 语法
  modelId: string | null;          // null = 跟随全局
  authorPersona: AuthorPersona | null;
  taskId: string | null;           // 见 §8
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  openMemoryCount: number;
}

/** transcript 里的一轮 */
export interface SceneTurn {
  index: number;                   // 单调递增，从 1 开始，read_scene 的寻址单位
  speaker: "author" | "agent";
  speakerName: string;
  at: number;                      // Unix 秒
  text: string;
}

// ── 记忆（§5）──
export type MemoryKind = "pact" | "todo" | "event" | "bond" | "note";
export type MemoryStatus = "open" | "done" | "void";

export interface MemoryRecord {
  id: string;                      // "m3"，agent 内唯一且永不复用
  kind: MemoryKind;
  title: string;                   // 一行，作者和模型都靠它扫
  body: string;
  status: MemoryStatus;
  /** 记下时的 transcript 轮号，让作者能跳回当时的对话 */
  turn: number;
  /** 关联对象：lore 条目 dirPath，或另一个角色的显示名。可空 */
  subject: string | null;
  updatedAt: number;
}
```

## 3. transcript 格式与解析

### 3.1 格式

```markdown
<!-- roleplay-transcript v1 agent=rp-lx8k2p-a3f9 -->

## [1] 作者 · 2026-08-20 14:03

*推开门，屋里没有点灯。*
「你还在等？」

## [2] 艾尔登 · 2026-08-20 14:03

「等的不是你。」
*他没有回头。*
```

- 首行是机器头，与 `task.md` 的做法一致（`taskWorkspace.ts` 的三行注释头）。
- 每轮一个 `## [N] 名字 · 时间` 标题，`[N]` 是**稳定地址**，`read_scene(from, to)` 按它切片，记忆记录的 `turn` 也指向它。
- 正文原样，不转义、不加引号——作者要能直接读，也要能直接拷进稿子。

### 3.2 解析必须容错

```ts
export function parseTranscript(md: string): SceneTurn[];
```

规则，与 `deserializeChatSession` 的偏执同源（一段读不出的记录不值得让整个功能挂掉）：

- 标题解析失败的块 → 归入**上一轮的正文**，而不是丢弃；一个都没解析出来 → 返回单条 `{index:1, speaker:"agent", text: 全文}`。
- `[N]` 缺失或重复 → 按出现顺序重新编号，并在返回值里标记 `renumbered`，调用方在结果里如实告诉模型「轮号已重排」。
- **永远不抛异常。** 作者手改 transcript 是被允许的行为，不是错误。

### 3.3 追加是唯一的写入方式

```ts
export async function appendTurn(
  projectPath: string, agentId: string, turn: Omit<SceneTurn, "index">,
): Promise<number>;   // 返回分配到的轮号
```

实现上是「读末尾 → 算下一个轮号 → 追加」。**不提供 `rewriteTranscript`**——不变量一说了它只追加。作者想删，用文件树删文件；那是作者的决定，不是程序的。

## 4. 上下文装配（`lib/roleplay/context.ts`）

### 4.1 播种（首轮）

```ts
export async function seedRoleplayHistory(opts: {
  agent: RoleplayAgent;
  persona: AuthorPersona;
  personaCard: string;        // agent.md 正文
  memory: MemoryRecord[];     // 已加载的记忆
  loreIndex: LoreIndex;
  firstMessage: MessageContent;
  loreBudgetChars: number;
}): Promise<{
  messages: StreamMessage[];
  meta: RoleplaySessionMeta;
  report: LoreActivationReport;
}>;
```

产出的消息序列**必须**是这个形状（不变量二、不变量四）：

```
[0] system  = ai.instructions.roleplay
              + 人设卡（agent.md 正文）
              + 主角条目的 index.md 正文
              + 作者身份说明
              + 输入语法约定
[1] user    = 【绑定条目】<boundPaths 解析出的正文>     ← prelude，恒存活，很少变
[2] user    = 【记忆】<活跃记录，按 kind 分组>          ← prelude，恒存活，按 §5.5 刷新
[3] user    = 【场景】<首轮自动命中的其他条目>          ← meta.seedContext，压缩会丢，正确
[4] user    = 作者第一句                              ← meta.turnStarts[0]
```

`RoleplaySessionMeta` = `ChatSessionMeta` + 两个字段：

```ts
export interface RoleplaySessionMeta extends ChatSessionMeta {
  /** [1] 的对象身份，刷新绑定时定位它 */
  boundBlock: StreamMessage | null;
  /** [2] 的对象身份，刷新记忆时定位它 */
  memoryBlock: StreamMessage | null;
}
```

按**对象身份**而不是下标持有，理由和 `ChatSessionMeta.seedContext` 完全一样：`repairToolCallPairing` 会 splice，下标不可靠（`chatSession.ts` 开头的注释把这件事说透了）。序列化时转下标、反序列化重新链接，复用同一套做法。

实现方式：调 `assembleContext(...)` 拿 bundle（`documentText` 传 `""`、`selection` 传 `""`、`contextChars: 0`——扮演不关心编辑器里开着什么），再调 `bundleToChatMessages(bundle, firstMessage)`（`rag.ts:663`），然后**把绑定块和记忆块 splice 到 index 1、2**。

不改 `bundleToChatMessages` 而是在外面 splice：那个函数是对话助手和写作任务共用的，为一个新调用方增加参数会让两个既有调用方都要理解一个它们用不到的概念。

> **验证过的关键事实**：`buildCompactedHistory`（`compact.ts:344-352`）遍历 prelude，只跳过 `meta.seedContext` 和 `meta.summary`，其余原样 push。`trimHistory`（`runtime.ts:156-179`）只把 `role: "tool"` 的内容和图片 part 替换掉，不动 `role: "user"` 的文本消息。**所以 `[1]` 和 `[2]` 在两条裁剪路径下都永久存活，无需给压缩加任何白名单。**

### 4.2 逐轮注入

复用 `assembleTurnInjection`（`rag.ts:578`），`matchTarget` = 作者本轮输入（不含文档尾巴——扮演没有「当前文档」的概念），`excludeDirs` = `excludeDirsFor(meta)`（现成的注入账本，`compact.ts`）。

**绑定条目必须预先写进账本**，否则第一次提到「塔」时会把已经在 `[1]` 里的塔重新注入一遍。播种时：

```ts
recordInjections(meta, boundEntities, pinnedMessage);
```

（`recordInjections` 的第三个参数是 carrier 消息，这里传绑定块本身——它永不离开历史，所以账本条目也永不失效。`buildCompactedHistory` 末尾会清理 carrier 已离场的账本条目，绑定块不会离场。）

### 4.3 绑定内容更新

绑定条目在知识库里被改了之后，`[1]` 是旧的。**不自动刷新**——原地重写会让 prompt 缓存前缀作废，长会话里这是真金白银。

做法：`roleplayStore` 记录播种时**静态上下文**的 hash（`contextSignature` + `hashText`，`lib/context/memory.ts:60`），与磁盘上的现状比对，不一致时在对话区顶部显示一条「绑定内容已更新 · 刷新」。作者点了才重写 `[1]`，并在 transcript 里记一条 `<!-- rebound at N -->`。

> 实现时这个范围扩大了：基线不只覆盖绑定块，还覆盖 system 层里全部由作者改动的输入（角色名、扮演指令、主角条目正文、作者身份），而「刷新」也会一并重写 `[0]`。原因和当初漏掉它们的后果，见 05 §2.16。

## 5. 角色记忆（agent memory）

> 这一节兑现不变量四。**滚动摘要回答「之前大致发生了什么」，记忆回答「现在有哪些还在生效的约定 / 待办 / 关系」。**

### 5.1 为什么不能复用现有的任何一个机制

| 候选 | 为什么不行 |
|---|---|
| 滚动摘要（`compact.ts`） | 有损、会被再次摘要。一条约定三轮之后就变成「他们聊了一些计划」。 |
| 故事记忆（`lib/context/memory.ts` 的 `DocMemory`） | 它是**文档**的分段摘要，按源文本字符区间组织，且同样是摘要。 |
| 知识库（lore） | 那是作品的正典，是作者的。角色记忆是这一次扮演里长出来的、可能作废、可能只属于某条支线的东西，混进去会污染正典（见 §5.7）。 |
| task workspace 的 notes | 那是一次任务的中间产物，会被 `MAX_SAVED_TASKS` 清理。 |

所以它是第五种东西，需要自己的存储、自己的注入位置、自己的生命周期。

### 5.2 记录种类

固定五种，进 tool schema 的 `enum`：

| kind | 中文 | 什么时候记 | 有状态 |
|---|---|---|---|
| `pact` | 约定 | 双方说定了一件事（「雪停了一起去塔下」） | open / done / void |
| `todo` | 待办 | 角色打算做但还没做的事 | open / done / void |
| `event` | 事件 | 已经发生的、改变了后续的事 | 恒 open |
| `bond` | 关系 | 对某人 / 某物的态度与关系状态，会演变 | 恒 open（用 revise 改正文） |
| `note` | 其他 | 逃生舱 | open / void |

**为什么是固定枚举，而不像 lore 分类那样由 profile 定义**：这五种是**对话结构**的产物，不是**领域**的产物——跑团、言情、悬疑都一样会产生约定和关系。做成可配置只会让作者在能用之前先做一次配置，并且让模型面对一个它无法预知的枚举。

### 5.3 文件格式 `.ai-writer/roleplay/<agentId>/memory.md`

```markdown
<!-- roleplay-memory v1 agent=rp-lx8k2p-a3f9 next=8 -->

## 约定

### [m3] 雪停了一起去塔下 · open · turn 12
作者说等雪停，他答应了。没说为什么要去。

### [m5] 不问她的名字 · void · turn 19
后来她自己说了，约定作废。

## 关系

### [m7] 对 林（作者） · open · turn 20
从戒备转为勉强的信任。仍然不提塔里的事。
```

- 机器头的 `next=` 是下一个 id 的计数器，**id 永不复用**——复用会让 transcript 里对某条记忆的引用指向另一件事。
- `## 分组` 按 kind 固定顺序；`### [id] 标题 · 状态 · turn N` 是记录头。
- 解析与 transcript 同源：容错、永不抛、坏掉的块并入上一条、id 缺失则按序补发并标记。

### 5.4 三条写入规则

L1 自动写没有审批卡兜底，唯一的安全阀是让**最坏情况只是多噪音，不会丢东西**：

1. **只增改，不删。** 没有 `forget` 工具；作废是把状态改成 `void` 并保留正文。
2. **每次写入前 `backupFile`**（`lib/agent/backup.ts`），与所有 L1 写工具一致。
3. **没有整篇重写工具。** 只有「新增一条」和「按 id 改一条」。模型拿不到重发整个 `memory.md` 的能力，所以一次坏调用的爆炸半径是一条记录。

### 5.5 注入与刷新（本节最重要的一条）

记忆块 `[2]` 只在**四个时刻**重写，**绝不在写入的当下重写**：

| 时刻 | 为什么 |
|---|---|
| 播种 | 显然 |
| **压缩之后** | 见下 |
| 会话恢复 | 作者可能在应用关着的时候手改过 `memory.md` |
| 作者显式点「刷新」 | 手改之后想立刻生效 |

**为什么写入时不刷新**：`remember` 的 tool 结果本身就在历史里，模型这一轮、以及之后直到折叠为止的每一轮都看得见它。真正的失效边界是**那条 tool 结果被折叠掉的时刻**——而那正是压缩发生的时刻。所以「压缩后刷新」不是省钱的优化，**它精确地就是正确性边界**；写入即刷新只会让每记一件事就作废一次 prompt 缓存前缀，换来零收益。

实现挂在 store 里，不进 `lib/agent/compact.ts`：

```ts
const compacted = await compactChatHistory({ history, meta, ... });
if (compacted) {
  // buildCompactedHistory 按身份保留 prelude 消息，所以 memoryBlock 还在新数组里
  refreshMemoryBlock(compacted.history, meta, await loadMemory(projectPath, agentId));
  set({ history: compacted.history });
}
```

`refreshMemoryBlock` 就地改那条消息的 `content`（对象身份不变，`meta.memoryBlock` 继续有效）。

### 5.6 预算

`MEMORY_BLOCK_CHAR_CAP = 4000`。注入块**只放活跃记录**（`open`），排序 `pact > todo > bond > event > note`，同 kind 内新的优先。超出时尾部写一行「还有 N 条较早的记录，用 recall 读」——和 `read_file` 分页读同一套话术，模型已经学会了这个形状。

`done` / `void` 的记录不进注入块，只能通过 `recall({include_closed: true})` 读到。这既是省预算，也是语义正确：**已经兑现或作废的约定不再是「现在生效的状态」**。

### 5.7 与知识库的关系：记忆不进正典

记忆**不自动、也不半自动地写进 lore**。理由：知识库是作品的正典，作者对它有完全的所有权和信任；角色记忆是一次扮演里长出来的，可能作废、可能只属于某条被放弃的支线。让它自动流进正典，等于让一场即兴演出改写作品正典。

要沉淀，路径是显式的：作者看到某条记忆值得进知识库 → 切到旁白 → 让它走现有的知识库写入路径（`propose_lore_plan` 闸门 + 审批卡）。v1 不做（01-overview §8），但路径是通的，不需要新机制。

### 5.8 隔离

记忆是 per-agent 的。扮演 agent 的工具集里没有任何读别人记忆的工具；旁白有只读的 `read_scene_memory`（§7.5）。

**注意一个看起来像违反、实际不违反不变量三的情况**：`bond` 记录的 `subject` 可以指向另一个角色。角色 A 对角色 B 有看法是合法的——它们在故事里通过作者的叙述见过面。不允许的是 A 读到 B 的对话记录。**「知道有这个人」和「读到那个人的私聊」是两件事。**

### 5.9 三个工具

全部注册进 `lib/agent/registry.ts`，处理器在 `lib/roleplay/memoryTools.ts`。扮演 agent 和旁白 agent 都有这三个，各写各的。

**`remember`** — `access: "write-auto"`

```jsonc
{
  "name": "remember",
  "description": "Record something that will still matter many turns from now: a pact the two of you made, something you intend to do, an event that changed things, or a shift in how you feel about someone. This is your own private long-term memory — it survives context compaction, unlike the conversation itself. Do NOT record ordinary dialogue, or anything already stated in the knowledge base.",
  "parameters": {
    "type": "object",
    "properties": {
      "kind":    { "type": "string", "enum": ["pact", "todo", "event", "bond", "note"] },
      "title":   { "type": "string", "description": "One line. This is what you will see first when you look back." },
      "body":    { "type": "string", "description": "The detail: what exactly was agreed, what changed, why it matters." },
      "subject": { "type": "string", "description": "Who or what this is about, if any." }
    },
    "required": ["kind", "title", "body"]
  }
}
```

工具描述里**必须**写清楚「什么时候不该记」——L1 自动写的工具，模型倾向于过度使用，一个每轮都记三条的角色会把注入块塞满噪音。

**`revise_memory`** — `access: "write-auto"`

```jsonc
{
  "name": "revise_memory",
  "description": "Update one existing memory record — mark a pact kept (done) or called off (void), or rewrite how you now see a relationship. Records are never deleted; voiding one keeps its text. Call recall first if you need the ids.",
  "parameters": {
    "type": "object",
    "properties": {
      "id":     { "type": "string" },
      "body":   { "type": "string" },
      "status": { "type": "string", "enum": ["open", "done", "void"] }
    },
    "required": ["id"]
  }
}
```

**`recall`** — `access: "read"`

```jsonc
{
  "name": "recall",
  "description": "Read your memory records. The active ones are already in your context — call this only to look further back: closed pacts, voided agreements, or older records that did not fit.",
  "parameters": {
    "type": "object",
    "properties": {
      "kind":           { "type": "string", "enum": ["pact", "todo", "event", "bond", "note"] },
      "include_closed": { "type": "boolean" }
    }
  }
}
```

命名刻意避开既有的 `read_memory` / `update_memory`——那两个是**文档的**故事记忆（滚动摘要，`registry.ts:670` / `registry.ts:1050`），语义完全不同，同名会让模型混淆。

### 5.10 `ToolContext` 的接线

```ts
/**
 * 本 agent 的私有记忆读写通道。缺席意味着当前 surface 不是扮演/旁白，
 * 记忆工具直接报错而不是静默无操作。
 */
agentMemory?: AgentMemoryStore;
```

```ts
export interface AgentMemoryStore {
  list(opts?: { kind?: MemoryKind; includeClosed?: boolean }): Promise<MemoryRecord[]>;
  add(rec: Omit<MemoryRecord, "id" | "updatedAt">): Promise<MemoryRecord>;
  revise(id: string, patch: { body?: string; status?: MemoryStatus }): Promise<MemoryRecord | null>;
}
```

**每次调用都从磁盘读，不缓存**——同 §7.6 的理由，也同 `ToolContext` 上已经吃过的那个亏：它是运行快照，一次写入必须能被同一次运行的后续调用看见。`add` / `revise` 返回写入后的记录，调用方据此更新 UI 和花名册上的 `openMemoryCount`。

## 6. Preset 与工具集

```ts
/** 扮演 agent：只读世界 + 只写自己的记忆 */
export const ROLEPLAY_PRESET: TaskPreset = {
  id: "roleplay-character",
  tools: [
    "list_lore_entities", "read_lore_entity", "read_lore_image",
    "read_image",
    "search_conversation", "read_conversation",
    "remember", "revise_memory", "recall",
  ],
  maxRounds: 5,
  finishPolicy: "force-text",
  serverTools: "off",
};

/** 旁白：读全场 + 写正文 + 写自己的记忆，不写知识库（v1） */
export const NARRATOR_PRESET: TaskPreset = {
  id: "roleplay-narrator",
  tools: [
    "list_lore_entities", "read_lore_entity", "read_lore_image",
    "read_image", "list_files", "read_file", "read_slides", "search_text",
    "read_memory",
    "list_scenes", "read_scene", "search_scenes", "read_scene_summary", "read_scene_memory",
    "remember", "revise_memory", "recall",
    "propose_edit", "append_file", "create_chapter", "rewrite_lines",
    "write_note", "read_note", "list_notes",
  ],
  maxRounds: 20,
  finishPolicy: "force-text",
  scratchpad: "offered",
};
```

设计要点：

- **扮演 agent 唯一能写的是自己的记忆**，碰不到稿子、碰不到知识库。也没有 `read_file`——一个角色不需要读作者的稿子，它活在故事里，不在文档里。
- **回看过去说过的话走 `search_conversation` / `read_conversation`，不是 `search_text`。** 这一条最初写的是「`search_text` 留着，因为『你还记得我们在雪原上说的话吗』这类问题需要它」。那个需求是真的，那个工具是错的，而且错了两层：

  1. `search_text` 扫的是**工作区里的稿件**并且排除 `.ai-writer/`（见 `lib/agent/tools` 的 `searchWritingFiles`），而 transcript 就住在 `.ai-writer/roleplay/<id>/` 下——它一辈子搜不到那句话。它实际能给的只有作者的稿子，也就是上一条刚说过不该给的东西。
  2. 它的结果是「路径:行号」，工具描述明写着接着去 `read_file`，而扮演 preset 故意没有 `read_file`。模型拿到命中之后只能去调一个不存在的工具，白烧一轮。

  换成一对作用域绑死在自己身上的工具：`ToolContext.conversation` 没有 agent id 参数，所以它只够得到本次运行那个 agent 的 transcript，**不变量三不受影响**。处理器在 `lib/roleplay/conversationTools.ts`，和旁白的 scene 工具不共用渲染——那边的说话人标签和「先读摘要」的引导是写给旁白的，这边是写给一个正在戏里的角色。
- **`maxRounds: 5`**（比只读版本多一轮，给记记忆留出空间）。扮演的期望响应是一句台词，不是一次调研。扮演面板**不接 `onRoundLimit` 回调**（不渲染那张卡），撞到上限就按 force-text 收尾——这是对的降级。
- **旁白拿到的正文写工具就是「把对话写进稿子」这个需求**（01-overview §6 决策 3）。它读完场景，自己梳理成散文，然后走 `create_chapter` / `append_file` / `propose_edit`，审批卡、备份、占位符校验全是现成的。
- `serverTools: "off"` 只对扮演 agent；旁白用默认的 `final-round-off`。

## 7. 旁白的 scene 工具

五个，全部 `access: "read"`。注册进 `REGISTRY`（`registry.ts:435`），处理器在 `lib/roleplay/sceneTools.ts`。

### 7.1 `list_scenes`

无参数。返回每个扮演 agent 一行：`agentId`、角色名、绑定的主角条目、轮数、活跃记忆条数、最后活动时间、摘要首句。**旁白 agent 自己不在列表里。**

### 7.2 `read_scene`

```jsonc
{
  "name": "read_scene",
  "description": "Read the verbatim transcript of one roleplay scene by turn range. Call list_scenes first for agent ids and turn counts. Omit `from`/`to` to get the most recent turns.",
  "parameters": {
    "type": "object",
    "properties": {
      "agent": { "type": "string", "description": "agentId from list_scenes" },
      "from":  { "type": "integer", "description": "First turn number (1-based, inclusive). Omit for the latest window." },
      "to":    { "type": "integer", "description": "Last turn number (inclusive)." }
    },
    "required": ["agent"]
  }
}
```

- 省略 `from`/`to` → 最近 `DEFAULT_SCENE_WINDOW = 20` 轮。
- 单次上限 `SCENE_READ_CHAR_CAP = 8000` 字符；超了截断并写明「还剩 N 轮，用 from/to 继续读」。
- 越界的 `from`/`to` 钳到有效范围并在结果里说明，不报错。

### 7.3 `search_scenes`

```jsonc
{
  "name": "search_scenes",
  "description": "Full-text search across roleplay transcripts. Returns matching turn numbers with surrounding context, so you can then read_scene the relevant range.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "agent": { "type": "string", "description": "Restrict to one scene. Omit to search all." }
    },
    "required": ["query"]
  }
}
```

实现：读 transcript → 解析 → 逐轮 `includes`（大小写不敏感）。返回 `agentId + 轮号 + 命中行 ± 1 行`，最多 30 条。**不建索引**——单个项目的 transcript 总量在几百 KB 量级，扫一遍比维护索引一致性便宜得多，也不会出现「索引落后于文件」这种只在长会话里才暴露的 bug。

### 7.4 `read_scene_summary`

单参数 `agent`。工具描述里就写清楚**该先读摘要再决定读哪段**，这是控制旁白 token 成本的主要手段。

### 7.5 `read_scene_memory`

```jsonc
{
  "name": "read_scene_memory",
  "description": "Read what a character has committed to long-term memory: pacts they made, things they intend to do, events that changed them, how they feel about people. Far cheaper than reading the transcript, and it is where the still-binding commitments live — start here.",
  "parameters": {
    "type": "object",
    "properties": {
      "agent":          { "type": "string" },
      "include_closed": { "type": "boolean" }
    },
    "required": ["agent"]
  }
}
```

**合法性**：旁白已经能读别人的全部 transcript，记忆是它的派生物，严格更少。而且便宜得多——这是旁白**应该**先调的工具，工具描述里明说。

### 7.6 `ToolContext` 的接线

```ts
/**
 * 旁白读取其他扮演会话的通道。**只能触达 transcript.md / summary.md /
 * memory.md**——别人的 wire history 在这里没有路径（不变量三）。
 * 缺席意味着当前 surface 不是旁白，scene 工具直接报错而不是返回空。
 */
scenes?: SceneReader;
```

```ts
export interface SceneReader {
  list(): Promise<SceneInfo[]>;
  read(agentId: string, from?: number, to?: number): Promise<SceneSlice>;
  search(query: string, agentId?: string): Promise<SceneHit[]>;
  summary(agentId: string): Promise<string>;
  memory(agentId: string, includeClosed?: boolean): Promise<MemoryRecord[]>;
}
```

**`SceneReader` 每次调用都从磁盘读，不缓存。** `ToolContext` 是运行快照，这里是硬要求：旁白在讨论的过程中，作者完全可能切去和某个角色又聊了三轮，一个捕获了快照的 reader 会让旁白坚持说那三轮不存在。

## 8. 子代理与 workspace 的坑（必读）

`routeTools`（`lib/agent/routing.ts`）有两条会互相咬的规则：

1. vision 子代理可用时，**剥掉主 agent 的 `read_image` / `read_lore_image`**；
2. `delegate` 工具**只在 `workspace !== undefined` 时才追加**。

组合起来：**一个没有 workspace 的 agent，在作者开了 vision 子代理之后，既不能自己看图、也不能委派给会看图的——看图能力凭空消失。**

对策：**每个 roleplay agent 都要有 workspace handle**，v1 直接懒创建标准的 task workspace（`createTaskWorkspace(projectPath, modelId)`，`taskWorkspace.ts:810`），`taskId` 存进花名册。

代价与取舍：

- 任务列表里会出现扮演产生的条目。可接受——它们确实是任务，且旁白的调研笔记本来就该在那里能翻到。
- `MAX_SAVED_TASKS = 20` 的清理**可能删掉某个 agent 的 notes 目录**。可接受，因为 notes 是辅助产物；**资产是 transcript 和 memory.md，都不在 `tasks/` 下**（不变量一在这里第二次救场）。清理后 `taskId` 悬空，`ensure()` 会重新建一个。
- 后续优化：把 `taskWorkspaceDir` 参数化，让 roleplay 的 workspace 落在 `.ai-writer/roleplay/<agentId>/notes/`。纯重构，不改行为，不进 v1。

模型切换无需额外工作：`_thinkingBlocks` 已经携带 `modelId` 且换模型时会被排除（`lib/ai/types.ts:264-275`），「某个 agent 聊到一半换模型」是既有机制已经覆盖的。

## 9. 并发与运行生命周期

```ts
export const MAX_CONCURRENT_RUNS = 3;
```

实现为信号量 + FIFO 排队，不是三个分支：

```
send(agentId, text)
  → 立即 append 作者轮到 transcript + turns（UI 马上有反馈）
  → 入队；活跃数 < MAX 则立刻起跑，否则标记该 agent 为 "queued"
  → 起跑：resolveConn(models, providers, agent.modelId ?? activeModelId)
         → 播种或追加历史（含记忆块）
         → runAgent({ preset, messages, toolContext, signal, onEvent, onOutputText })
  → 结束：append 助手轮到 transcript → 落盘 session.json
         → 若本轮有记忆写入，更新花名册的 openMemoryCount
         → 释放名额 → 拉起队首
```

要点：

- **每个 agent 一个 `AbortController`**，「停止」只停自己。
- **记忆写入是即时落盘的**，不等本轮结束——`remember` 的处理器直接写文件。中途 abort 不该让已经记下的约定消失。
- **`persistUsage`（`lib/ai/usage.ts`）照常写**，`task` 字段用 `roleplay:character` / `roleplay:narrator`，Settings → 用量 里能看出扮演花了多少钱。并发跑三个时这个可见性是必要的，不是锦上添花。
- **审批**：只有旁白会产生审批。走现有 `agentStore.requestApproval(proposal, runId, binding)`，`runId` 传该 agent 的 controller（`agentStore` 对 runId 只做 `===`）。审批卡渲染在扮演面板内。
- **自动批准的 key 必须是 agent 自己的 controller，不能是字面量。** `CHAT_AUTO_APPROVE_KEY = "chat"`（`autoApprove.ts:65`）是对话助手专用；多个 roleplay agent 共用一个字面量会让 A 的「本次都批准」覆盖到 B。用 controller 对象，`autoApproveScope()` 会自动判定为 `"run"` 级。
- **切走的 agent 继续跑。** 运行状态在 store 里，不在组件里。

## 10. `roleplayStore` 状态形状

```ts
interface RoleplayState {
  order: string[];                          // 花名册顺序
  agents: Record<string, RoleplayAgent>;
  authorPersona: AuthorPersona;

  sessions: Record<string, LiveSession>;    // 只有被打开过的 agent 才在这里

  activeAgentId: string | null;             // 持久化到 prefs
  running: string[];
  queued: string[];

  loaded: boolean;
  error: string | null;
}

interface LiveSession {
  turns: SceneTurn[];                       // 显示用（从 transcript 派生）
  log: Record<number, AgentEvent[]>;        // 轮号 → 执行日志（只在内存，不落盘）
  history: StreamMessage[] | null;
  meta: RoleplaySessionMeta | null;
  abort: AbortController | null;
  usage: { inputTokens: number; outputTokens: number; cost: number } | null;

  memory: MemoryRecord[];                   // 记忆面板的数据源，写入后同步更新
  memoryStale: boolean;                     // 磁盘变了但注入块还没刷新（§5.5）
  contextHash: string | null;               // 静态上下文 hash，§4.3 的过期提示
                                            // （原名 boundHash，只覆盖绑定块；
                                            //  见 05 §2.16）
  contextVersion: number;
}
```

`log` 不落盘是刻意的：执行日志是「这一轮模型干了什么」的调试信息，对**扮演**来说它不是作品的一部分。落盘会让 transcript 之外多一份需要保持同步的机器状态，违反不变量一的精神。

## 11. 持久化与恢复

- **`session.json` 复用 `serializeChatSession` / `deserializeChatSession`**（`lib/agent/chatSession.ts`）—— 它已经解决了最难的部分（meta 按对象身份引用消息，序列化转下标、反序列化重新链接）。roleplay 需要在外层包 `{ v: 1, agentId, chat: <那个 blob>, boundBlock: <idx>, memoryBlock: <idx> }`，两个新下标按同样的方式转换与重链接。
- **反序列化失败 = 从 transcript + memory.md 重建。** 这是不变量一和四的兑现：`session.json` 读不出来，就用 transcript 的最近 N 轮重新播种，记忆块从 `memory.md` 原样重建。作者损失的只是「模型脑子里的细节」，**不损失一个字的对话，也不损失一条约定**。对话助手做不到这一点（它没有 transcript，也没有记忆），这是这个功能比它更稳的地方。
- **恢复时刷新记忆块**（§5.5 的第三个时刻）。
- **写入时机**：每轮跑完写一次 `session.json`（全量重写）、追加 `transcript.md`；`memory.md` 在工具调用的当下就写。三者都是 best-effort：失败只记 `console.warn` 并在 UI 上提示，绝不打断对话。
- **无条数上限。** 不实现任何自动清理。删除是作者的显式动作。

## 12. 输入语法

纯 prompt 约定，**不写解析器**。约定：

| 写法 | 含义 |
|---|---|
| `「…」` 或 `"…"` | 台词 |
| `*…*` | 动作 / 神态 |
| 裸文本 | 环境、事件、场景描述（叙述者视角） |
| `[…]` | OOC 元指令（「[让他更冷一点]」），角色不当作故事内发生的事 |

三点说明：

1. **这些标记同时是 lore 的匹配文本**（`matchTarget`）。现有匹配是别名子串匹配，标点不干扰命中——不需要预处理。
2. **`[…]` 的 OOC 语义必须写进 `ai.instructions.roleplay`**，否则模型会把它当台词演出来。
3. **composer 上给一条常驻的语法提示条**，而不是靠作者记住。第一次使用时展开，之后折成一行。

## 13. i18n 键

```
ai.instructions.roleplay          扮演 agent 的 system 提示（新写，不复用 ai.instructions.system）
ai.instructions.narrator          旁白 agent 的 system 提示
ai.instructions.roleplaySyntax    输入语法约定（拼进上面两个）
ai.instructions.roleplayMemory    记忆纪律：什么时候该记、什么时候不该记（拼进上面两个）
ai.instructions.roleplaySummary   滚动摘要的生成提示

roleplay.title / tabLabel / empty / newAgent / editAgent / deleteAgent
roleplay.kind.character / kind.narrator
roleplay.bind.primary / bind.related / bind.stale / bind.refresh
roleplay.persona.title / persona.lore / persona.prompt / persona.none
roleplay.syntax.hint / syntax.speech / syntax.action / syntax.scene / syntax.ooc
roleplay.memory.title / memory.empty / memory.refresh / memory.stale / memory.jumpToTurn
roleplay.memory.kind.pact / kind.todo / kind.event / kind.bond / kind.note
roleplay.memory.status.open / status.done / status.void
roleplay.memory.recorded          对话内联提示：「记下了：…」
roleplay.queued / running / stop / concurrencyFull
roleplay.errors.*
systemSettings.general.roleplayBeta / roleplayBetaDesc
```

**关键：`ai.instructions.roleplay` 绝不能是 `profileSystemPrompt()`。** 那个是「写作协作者」人格（`ai.instructions.system`），要求「零附加评论、只输出所请求的写作内容」——套在扮演上是灾难。扮演的 system 提示要自带一份「创作主权」条款（黑暗主题、道德复杂的角色不自我审查），因为扮演比写作更容易触发模型的自我审查。

`profileSystemPrompt.test.ts` 的源码守卫只禁止在白名单外引用 `ai.instructions.system` 这个键，新键不受影响——但**不要**在 roleplay 里去调 `profileSystemPrompt()`，那会把写作人格混进来。

## 14. 错误与降级

| 情况 | 行为 |
|---|---|
| 绑定的 lore 条目被删了 | 播种时跳过（pin 解析已经会跳过失效 pin，`loreSelect.ts:157`），UI 上把该绑定标灰 + 一键移除 |
| 主角条目被删了 | agent 保留、可读、不可发新消息；提示作者重新绑定 |
| `agents.json` 损坏 | 扫目录用各 `agent.md` 的 frontmatter 重建，写回并提示作者 |
| `session.json` 损坏 | 从 transcript + memory.md 重建（§11） |
| transcript / memory.md 被作者改坏 | 容错解析（§3.2、§5.3），永不抛 |
| `revise_memory` 给了不存在的 id | 返回错误文本（列出现有 id），不新建记录——静默新建会让模型以为改成功了 |
| 记忆块超预算 | 截断 + 「还有 N 条，用 recall 读」，不静默丢 |
| 模型未配置 / 已删除 | 该 agent 的发送按钮禁用 + 行内提示，其他 agent 不受影响 |
| 并发满 | 排队，花名册上显示「排队中」；作者可取消排队 |
| 项目未打开 | 整个 tab 显示空态 |

## 15. 测试点（vitest，`lib/roleplay/__tests__/`）

按重要性：

1. **`context.test.ts`** — 播种消息序列形状正确（绑定块 index 1、记忆块 index 2、`meta.seedContext` 指向 index 3）；**跑一次真实的 `buildCompactedHistory` 后，绑定块和记忆块都还在、seed 块已消失**（不变量二 + 四的回归测试，最重要的一个）；压缩后 `refreshMemoryBlock` 能按身份定位到记忆块；`recordInjections` 后绑定条目不被逐轮注入重复注入。
2. **`memory.test.ts`** — 解析正常/坏格式/空文件；id 永不复用（删掉中间一条后 `next` 不回退）；`revise` 不存在的 id 返回 null；`void` 保留正文；注入块只含 `open`、按优先级排序、超预算截断且带续读提示。
3. **`transcript.test.ts`** — 正常解析；轮号缺失/重复的重排；标题坏掉的块并入上一轮；全文无标题的降级；追加后轮号连续；空文件。
4. **`sceneTools.test.ts`** — 越界范围钳位；字符上限截断后的续读提示；旁白自己不出现在 `list_scenes`；**扮演 preset 的工具集里不含任何 scene 工具**（不变量三的回归测试）。
5. **`concurrency.test.ts`** — 第 4 个请求进队列；一个跑完拉起队首；abort 只影响自己；**abort 不回滚已写入的记忆**；队列在 agent 被删除时清理。
6. **`store.test.ts`** — 花名册损坏后的重建；`agentId` 字符校验拒绝穿越路径。
