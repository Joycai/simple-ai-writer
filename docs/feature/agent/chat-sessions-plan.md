# 对话助手的会话：标题与改名 · 多个活会话并发

> **状态：`shipped`** —— PR A（标题数据层）、B（`agentStore` 收敛成 `chats` 表）、C（并发：
> 队列 / 信号量 / 卡片打标 / 未读）、D（界面，按设计稿 `23 助手多会话`）全部落地
> （2026-09-04）。实现出入记在 §10，界面与稿子的出入在 §11；「让助手起名」按稿子第一期
> 隐藏、位置保留。两个功能一份稿，因为第二个决定了第一个的数据落点（标题挂在哪一层、
> 什么时候能改），拆开写会各说各的。
> 给 Claude Design 的任务书在 [`chat-sessions-ui-brief.md`](chat-sessions-ui-brief.md)，
> 自包含，可整段丢过去。
>
> 涉及：`stores/agentStore.ts`（改动最大）、`lib/agent/sessionDb.ts` / `chatSession.ts`、
> `lib/project.ts`（一列迁移）、`components/ai/AiDrawer.tsx` / `AgentChat.tsx`、
> `lib/agent/approvalRouting.ts`（只是用法，规则不动）、`stores/composerStore.ts`。
> 角色扮演一行不改，但它的并发模型（`roleplayStore` + `lib/roleplay/scheduler.ts`）是
> 这份稿的蓝本，§4 逐条对照。

## 0. 一句话

给历史会话加一个**作者自己起的标题**（不起就还是今天那条「第一句话的截断」），并且让
对话助手像角色扮演一样，**几段对话可以同时活着、同时在跑**——切走的那段继续生成，
回来时字已经在那里，需要作者批准的卡片在它自己的那一页上等着。

## 1. 现状

### 1.1 会话的存法

会话不是文件，是 `.ai-writer/project.db` 里 `chat_sessions` 表的一行，`data` 列一个
JSON（`lib/agent/chatSession.ts` 的 `SerializedChat v1`）：

```sql
CREATE TABLE chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preview TEXT NOT NULL DEFAULT '',   -- 第一句话，折行、截到 60 字
  data TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
)
```

三条今天的规则，后面每一条都会被碰到：

- **没有标题。** 列表上那行字是 `preview`，`sessionPreview(turns)` 在**每次** `persistChat`
  时从头重算——它是派生值，不是可存的东西。回退到第一问会把它一起改掉。
- **没有删除。** 唯一的移除是 `upsertChatSession` 里的自动清理：未固定的行只留最新
  `MAX_CHAT_SESSIONS = 5` 条。固定是列表上唯一的逐行动作。
- **空会话没有行。** `persistChat` 在 `turns.length === 0` 时直接返回，所以「先建再起名」
  在第一次发送之前没有东西可挂。

### 1.2 store 是单值的

`agentStore` 里会话作用域的字段全是标量：`turns` / `chatHistory` / `chatMeta` / `chatUsage` /
`chatRunning` / `chatCompacting` / `chatAbort` / `chatSessionId` / `chatTaskWorkspace` /
`disabledSubAgents` / `planMode` / `stateMemory` / `autoApprove`。一次只有一段对话是活的；
`switchChatSession` 在 `chatRunning` 时拒绝，「历史会话」按钮在运行中直接 `disabled`。

角色扮演当初就是因为这个另起了 `roleplayStore`（文件头原话）：

> `agentStore` 从字段设计上就是「当前只有一个对话」……把它改成 `Map<id, Session>` 会波及
> AgentChat、AiDrawer、审批队列、任务工作区——用一次高风险重构换「代码复用」。

那次的判断对：扮演要的是 N 个**互不相干**的对话，复用 `runAgent()` 就够。**这次不一样**——
要并发的正是对话助手本身，它的取材、归纳、状态记忆、任务工作区、回退、写手交接全长在
`agentStore.sendChat` 那一条链上，绕开它等于把这些再写一遍。所以这次**就是**那次没做的
重构，只是要做得让 `AgentChat` 几乎感觉不到（§4.1）。

### 1.3 被阻塞的卡片按「界面」路由，不按会话

`lib/agent/approvalRouting.ts`：没有 `surface` 的卡属于默认界面（对话助手 + 任务面板），
带 `surface` 的只由同名界面渲染。扮演用 agentId 打标，于是三个并发的 agent 各看各的。
**对话助手今天从不打标**，`CHAT_AUTO_APPROVE_KEY = "chat"` 也是一个全局字面量——两段
对话一起跑，A 的「本次都批准」会覆盖到 B（`roleplayStore.ts:747-759` 的注释就是防这个）。

## 2. 目标与非目标

**目标**

1. 会话有**标题**，作者能在列表和头部改；不起名时显示今天的 preview，行为不变。
2. **多个活会话**：打开着的会话各自有自己的轮次、历史、运行态、草稿、芯片开关；最多
   `MAX_CONCURRENT_RUNS = 3` 段同时在生成，第四段排队；切走继续跑；后台跑完 / 卡住时列表
   上有信号、窗口没焦点时有系统通知。
3. 被阻塞的卡片（审批 / 方案 / 轮数上限 / 截断 / 提问）**只出现在提出它的那段对话里**。
4. 起了名字的会话**不会被自动清掉**；配套一个带确认的删除。

**非目标（本稿明确不做）**

- 会话之间互相看见（共享上下文、@ 另一段对话）。四段对话是四段，和扮演的负向验收同理。
- 每会话绑模型。头部的 `ModelSelector` 仍是全局的，模型在**发送那一刻**解析并随该次运行走；
  两段对话可以用不同模型跑着，只要作者在两次发送之间换了。要不要把模型钉在会话上是
  下一稿的事，字段位置在 §4.1 留了。
- 标题由模型自动起。见 §3.4，留了一个**作者点了才跑**的入口，不做静默调用。
- AiPanel / 批量 / lore 弹窗的运行不进这套并发闸。它们仍是各自的单次运行。
- 把三个并发名额和角色扮演**共用**。§4.3 说为什么先不共用、以及共用时改哪一处。

## 3. 功能一：标题与改名

### 3.1 数据

`chat_sessions` 加一列：

```sql
ALTER TABLE chat_sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''
```

迁移照 `lib/project.ts` 的 `addChatSessionPinned` 写一个 `addChatSessionTitle`（`duplicate
column name` 视为成功，每次 `getDb` 都跑）。`ChatSessionRow` 加 `title: string`。

**`title` 和 `preview` 是两个字段，永远不合并。** `preview` 继续每次保存时重算（它是
「这段对话在说什么」的派生值，回退之后应该跟着变）；`title` 只有作者写。显示用
`title || preview || （空会话）`，这个三段回退收在一个纯函数 `sessionLabel(row)` 里
（`lib/agent/sessionDb.ts`），列表、头部、通知、删除确认全部走它——四处各写一遍
`||`，迟早有一处忘了中间那段。

写入：`setChatSessionTitle(projectPath, id, title)`，和 `setChatSessionPinned` 并排，**只写
这一列**。`upsertChatSession` 的 UPDATE 语句今天刻意不碰 `pinned`，同样不碰 `title`——
一次运行结束时的落盘绝不能把作者刚改的名字冲回去。

规范化在写入前做，也是纯函数：折掉换行与连续空白、两端裁掉、上限 **60 字**（和 preview
同一把尺，列表一行放得下）；裁完为空 ＝ 清除标题（回到 preview），不是存一个空串等着
显示成空行。

### 3.2 没有行的会话怎么起名

空会话没有行（§1.1），但作者完全可能一开新会话就先起名（「第三章改稿」）。在 store 的
会话记录上放一个 `title: string`（§4.1 的 `LiveChat.title`），改名先改内存；`persistChat`
第一次拿到行 id 时把它一起写下去。这样改名对作者来说**永远立即生效**，不需要知道
「有没有存过」。同一个字段在切回一段旧会话时从行里读出来，所以头部显示的名字和列表
里的是同一个来源。

改名**不受运行态限制**。它只写一列，和正在跑的那次运行无关；扮演里改角色名也不用等它
说完话。

### 3.3 命名的会话不被清掉

自动清理只删**既没固定、也没命名**的行。作者打过字的名字是「我还要找它」最强的信号，
悄悄删掉一段起过名的对话，正是 `setChatSessionPinned` 那段注释里说的「未经确认、不可
恢复的丢失」。

**命名与固定是两列、两个动作、互不牵连**（2026-09-04 定稿）：`title` 与 `pinned` 各自
读写，固定不改名字、改名不动固定；**固定着的会话照样可以改名**，改名也照样可以固定。
两条后果，都接受：

- 命名 ≠ 固定。列表还是「已固定 / 最近」两节，命名而未固定的住在「最近」，只是不会被
  挤掉。要不要再分一节「已命名」由设计稿回答（任务书 §3）。
- 「最近」可能变长。所以这次必须补**删除**（§3.5）——保护和删除是一对，只做前一半会
  让列表只进不出。

清理还要跳过**当前打开着的**会话（§4.5），那是功能二引入的另一条保护，和这条同一处实现：
`upsertChatSession` 的 prune 多收一个 `keep: number[]`。

### 3.4 「让助手起个名」——留口，不静默

不做「第一轮之后自动起标题」。这个应用对模型调用的态度是每一次都看得见、算得出
（写手那一稿把「每轮 2 次请求」写在输入框上方），一次作者没要过的结构化调用不符合这个
态度，而且它会在**每个**新会话上花一次钱。

留的口是改名弹层里的一个动作「让助手起名」：作者点了才跑，用当前会话的模型，走
`lib/agent/structured.ts` 要一个 `{ title }`，结果**填进输入框而不是直接落盘**——作者
看一眼、改一改、回车。第一期可以不做这个按钮，但弹层的布局要给它留位。

### 3.5 删除

`deleteChatSession(projectPath, id)`，从行菜单进，**必有确认**（文案含 `sessionLabel`）。
两条拒绝：

- 该会话正在生成或排队 → 菜单项禁用，提示「停止后才能删除」。不做「删除并停止」——
  一个动作两件事，作者会点错。
- 该会话就是当前显示的这段 → 允许，删完切到打开列表里相邻的一段；没有别的了就落到一段
  空的新会话（和今天 `resetChat` 之后的样子一致）。

删除的是行；`.ai-writer/tasks/<taskId>/` 的任务工作区**不跟着删**——它是文件、可能被
别的东西引用过，而且 `TaskWorkspaceView` 本来就能列出不属于任何会话的工作区。

### 3.6 落点清单

| 层 | 改动 |
|---|---|
| `lib/project.ts` | `addChatSessionTitle` 迁移 |
| `lib/agent/sessionDb.ts` | `ChatSessionRow.title`、`setChatSessionTitle`、`deleteChatSession`、`normalizeSessionTitle`、`sessionLabel`、prune 的 `keep` 与「命名不清」 |
| `stores/agentStore.ts` | `renameChat(key, title)`、`deleteChat(id)`；`LiveChat.title` |
| `AiDrawer.tsx` | 行上的改名 / 删除入口、头部标题可编辑 |
| i18n | `ai.chat.rename` / `ai.chat.renamePlaceholder` / `ai.chat.deleteSession` / `ai.chat.deleteConfirm` / `ai.chat.deleteBlockedRunning` / `ai.chat.suggestTitle`；`ai.chat.sessionTitle`（会话）今天是死键，可以启用 |
| 测试 | `chatSessionPin.test.ts` 旁加 `chatSessionTitle.test.ts`：只写一列、保存不冲名字、命名的行不被清、`keep` 生效、规范化边界 |

## 4. 功能二：多个活会话

### 4.1 状态形状：一张表 + 一个「当前」，其余照旧

```ts
/** 一段打开着的对话。key 是本地稳定的，行 id 在第一次落盘才有。 */
interface LiveChat {
  key: string;                    // `c${++counter}`，永不复用
  sessionId: number | null;       // 行 id；空会话为 null
  title: string;                  // §3.2
  turns: ChatTurn[];
  history: StreamMessage[] | null;
  meta: ChatSessionMeta | null;
  usage: ChatUsage | null;
  contextVersion: number;
  taskWorkspace: TaskWorkspaceHandle | null;
  error: string | null;
  // 作者在这段对话上的开关——全部按会话，理由同扮演（05 §2.16）
  disabledSubAgents: SubAgentKind[];
  planMode: boolean;
  stateMemory: boolean;           // 镜像 meta.stateMode
  autoApprove: AutoApproveState | null;
  /** 有新回复 / 有卡在等，但作者没看。*/
  unread: boolean;
  // 预留：modelId?: string  —— 每会话绑模型（非目标）
}

interface AgentState {
  chats: Record<string, LiveChat>;
  chatOrder: string[];            // 打开的顺序，就是标签条的顺序
  activeChatKey: string | null;
  running: string[];              // 正在生成的 key，上限 MAX_CONCURRENT_RUNS
  compacting: string[];           // 正在手动归纳的 key
  queue: ChatJob[];               // FIFO：{ key, text, quote, refs, opts }
  aborts: Record<string, AbortController>;
  chatSessions: ChatSessionRow[]; // 历史列表，不变
  // pending* 五个队列不变（按 surface 路由，见 §4.4）
}
```

和扮演的 `LiveSession` 一样，**只有打开过的会话才在 `chats` 里**；历史列表里的其余会话
只是行。

**给 `AgentChat` 留的缝**：今天它用十几个窄选择器读 `s.turns` / `s.chatRunning` /
`s.chatHistory`……，每次流式刷新都在写 store，选择器窄是刻意的。重构后这些字段不再是
store 的顶层字段，但 `AgentChat` 不应该因此改一遍所有选择器。做法是一个
`useActiveChat(selector)` 钩子（`stores/agentStore.ts` 导出）：

```ts
const turns = useActiveChat((c) => c.turns);
const isRunning = useAgentStore((s) => s.activeChatKey !== null && s.running.includes(s.activeChatKey));
```

再加一组与今天同名的动作（`sendChat` / `stopChat` / `compactChatNow` / `rewindChat` /
`setStateMemory` / `setPlanMode`……）**默认作用于当前会话**，内部带 key 的版本
（`sendChatTo(key, …)`）给标签条和队列用。`AgentChat` 的改动因此是**选择器换钩子**，
不是重写。`ContextBar`、`StateMemoryChip`、`PlanModeChip`、`AutoApproveChip`、
`SubAgentChips` 同理——它们读的都是「当前会话」的开关。

**`AgentChat` 用 `key={activeChatKey}` 挂载**（扮演的 `RoleplayChat key={active.id}` 同一
手法）：切会话就是重挂，滚动位置、`showAll`、`rewindTo` 这些组件态天然归零，不用一个个
在 effect 里清。今天 `useEffect(() => setRewindTo(null), [chatRunning, chatSessionId])`
这类清理可以删掉。

### 4.2 一次发送

照扮演 §9 的顺序，换成对话助手的动作：

```
sendChatTo(key, text, quote, refs, opts)
  → 拒绝：该 key 在 compacting；空文本
  → 立刻 push 作者轮 + 空的助手轮到 chats[key].turns（界面马上有反馈）
  → 入队 { key, … }；pump()
pump()
  → running.length >= MAX_CONCURRENT_RUNS → 返回
  → nextRunnableJobIndex(queue, running, compacting) —— 同一会话正在跑 / 归纳的作业跳过，不堵队首
  → 取出作业，running += key，runChatJob(job)
runChatJob(job)
  → controller = new AbortController(); aborts[key] = controller
  → 今天 sendChat 从「resolveConn」到「finally」之间的全部逻辑，
    所有 set({ turns, chatHistory, … }) 改成 patchChat(key, …)
  → finally：释放 running / aborts；rejectAll(reason, controller)；persistChatOf(key)；
    若 activeChatKey !== key → unread[key] = true + notify("done")；pump()
```

**同一会话内的排队** 是今天 `queued` 那个组件态（运行中按 Enter，本轮结束后发送）的
store 版本：`AgentChat.tsx` 里的 `queued` state 和它的 effect 删掉，改为直接入队；队列里
同一 key 的作业按顺序跑。作者「停止」时清掉该 key 的队列项（扮演 `stop` 的行为）。

流式文本仍走 `createStreamThrottle` 落进 `chats[key].turns`——**store 就是缓冲**，切走的
会话不需要另一个后台缓冲，切回来时 `AgentChat` 重挂、读到的就是累积到那一刻的 turns。

**停止只停自己**：`stopChat(key)` 只 abort 那一个 controller，`rejectAll` 按 controller
身份只清它的卡（`agentStore.ts:1091` 的比较本来就是 `===` controller）。

### 4.3 并发闸

`MAX_CONCURRENT_RUNS` 今天住在 `lib/roleplay/model.ts`，`nextRunnableJobIndex` 住在
`lib/roleplay/scheduler.ts`。**把这两样搬到 `lib/agent/scheduler.ts`**，roleplay 从那里
import（一处改 import 路径，行为不变）；扮演至今没有 scheduler 的单测，搬家时补上，
两边共用同一份。

**名额先不共用。** 对话助手三个、扮演三个，两条队列。理由：

- 共用一个信号量意味着两个 store 要么共享一块 `running` 状态，要么有一个协调层——那是
  第三个模块，而两个功能今天没有任何共同的运行时对象。
- 真正稀缺的是**接口的并发上限和账单**，不是本机的槽位；这两样已经按 `persistUsage` 的
  `task` 字段分开可见（`chat` / `roleplay:*`）。
- 作者同时开六段生成是极端用法，而不是需要一个闸来防的常态。

共用的那一天：把 `running` 的计数改成读一个 `lib/agent/runSlots.ts` 的全局计数器即可，
`pump` 的形状不变。稿里记一句，不先做。

### 4.4 卡片归属：对话助手也打标

每段对话的运行给自己的五种卡全部打 `surface: chat:<key>`，`AgentChat` 按
`cardsForSurface(list, "chat:" + activeKey)` 渲染，`AiPanel` / `TaskWorkspaceView` 继续读
无标签的（它们的运行不变）。`approvalRouting.ts` 的规则**一个字不改**，改的只是对话
助手从「默认界面」变成一个**具名界面**。

**自动批准的 key 改成 controller**，不再是 `CHAT_AUTO_APPROVE_KEY` 字面量——扮演 §9 那
条原话：几个运行共用一个字面量会让 A 的「本次都批准」覆盖到 B。`AutoApproveChip` 的
`owner` 因此从常量变成当前会话的 controller（没在跑时是 `null`，芯片按今天的规则显示）。
`autoApproveScope()` 对对象自动判成 `"run"` 级，正好。

**卡在等 = 有信号。** 扮演的 `unread` 只在跑完时置位，后台 agent 卡在审批上时花名册上
**没有**记号，只有一个系统通知（梳理时确认的缺口）。这里补上：任何一种卡片入队时，若
`surface` 指向的不是当前会话，就置该会话的 `unread`——而且这种「等着你」比「跑完了」
更急，标签条上要能分开（任务书 §2 的态清单）。

### 4.5 持久化与清理

- **落盘时机不变**：一次运行的 `finally`、手动归纳之后、切走之前。多了一个：**关闭标签**
  之前。
- `persistChatOf(key)` 拿到行 id 后只在 `chats[key]` 还存在且 `history` 同一引用时写回
  `sessionId`（今天 `get().chatHistory === chatHistory` 那条守卫的按 key 版本）。
- **自动清理跳过打开着的会话**：`upsertChatSession` 多收 `keep: number[]`（所有
  `chats[*].sessionId`）。否则五段新对话之后，一段打开着、正在跑的旧会话的行会被删掉——
  它下一次 UPDATE 命中 0 行会退回 INSERT、拿到新 id，倒是不丢字，但固定 / 标题跟着丢了。
- **打开着的标签集合不持久化**（第一期）。重启后照今天：恢复最近一行到一个标签。
  打开集合本质是「作者这会儿在干什么」，存到 prefs 也只是一串行 id，收益小、多一条
  失效路径（行被删了 / 换项目了）。要做的话是 prefs 里按项目路径存 `openIds + activeId`，
  §7 列为可选。
- **换项目**：`resetChatForProject` 先 abort 全部 `aborts`、清空 `chats/queue/running`，再
  恢复目标项目的最近一行——今天的行为，只是从一个变成全部。

### 4.6 界面行为（给设计稿的规则，不是画面）

- **标签条**：打开着的会话一条一个，顺序 = `chatOrder`，可关闭。关闭 ≠ 删除：关的是标签，
  行还在历史里。关闭正在生成的会话要先停止（确认一次），排队中的直接出队。
- **历史列表**（今天的下拉）保留，语义从「切换」变成「打开」：已经打开的会话点了是
  **聚焦**那个标签，不再新开；行上标出「已打开」。「历史会话」按钮**不再在运行中禁用**——
  没有理由了。
- **新会话**：永远可点。已有一个空标签时聚焦它而不是再开一个（空会话没有行，两个空
  标签毫无意义）。
- **切走继续跑**：标签上有「正在生成」态；跑完、或卡在等作者，标签上有未读记号，切
  到它就清。
- **抽屉不在助手模式、或抽屉关着**：`AiDrawer` 的模式 tab 上那个 `modeTabDot`（今天扮演
  用的：`unread || running > 0`）对助手同样点亮。抽屉关着时今天没有任何入口显示扮演在跑，
  这次也不新加——那是抽屉之外的设计，超出本稿。
- **并发读数**：`并发 ▮▮▯ 2 / 3 · 排队 1`，扮演花名册脚那一行的同一语汇；放哪里由设计稿定。
- **输入框草稿按会话**：`composerStore` 的 `chatDraft / chatRefs` 改成 `Record<key, …>`，
  和它的 `roleplay: Record<agentId, …>` 同构；关闭标签时清。
- **快捷键**：⌘L 开抽屉到助手（不变）；标签间切换用 ⌃Tab / ⌃⇧Tab（扮演今天没有绑，
  这次两边都不绑，避免和 CodeMirror 抢）——设计稿可以提议，实现第一期不做。

## 5. 不变量（写进测试的那几条）

1. **两个轴正交**：`activeChatKey`（可见，一个）与 `running`（执行，≤ 3）互不读取，除了
   跑完时判断要不要置 `unread`。组件从不持有运行态。
2. **停止只停一个**：`stopChat(key)` 之后其他 key 的 controller 未被 abort、队列里其他 key
   的作业还在。
3. **卡片只在自己的会话里**：任一卡片的 `surface === "chat:" + key`；`cardsForSurface`
   对另一个 key 返回空；`AiPanel` 读到的无标签队列里没有对话助手的卡。
4. **自动批准不串**：会话 A 的「本次都批准」（controller A）对会话 B 的下一张卡无效。
5. **同一会话不并跑**：同 key 的两个作业永远串行；`compacting` 中的 key 不被 pump 拉起。
6. **落盘不冲名字 / 不冲固定**：`upsertChatSession` 的 UPDATE 不含 `title` / `pinned`。
7. **打开着的行不被清**：`keep` 里的 id 在 prune 之后仍在。
8. **命名的行不被清**：`title <> ''` 的行在 prune 之后仍在。
9. **`sessionLabel` 是唯一的三段回退**：源码扫描——`preview ||` 不出现在 `components/`。
10. **`AgentChat` 不 import `chats` 表**：它只通过 `useActiveChat` 读会话；源码扫描 `s.chats[`
    不出现在 `components/ai/AgentChat.tsx`。

## 6. 风险与取舍

| 风险 | 处理 |
|---|---|
| `sendChat` 有 700 行，改成按 key 写状态时漏一处 `set({turns})` | 先做 PR-B 的机械改写：把今天所有会话作用域的 `set` 收敛到一个 `patchChat(key, patch)`，**先在单会话下跑绿全部既有测试**，再开第二个会话。这一步不加任何功能 |
| `rewindChat` / `compactChatNow` / `resumeTask` / `abortTask` 各自对 `chatHistory` 就地操作 | 都改成收 key，默认当前；和 `send` 一样进 `running ∪ compacting ∪ queue` 的互斥判断（扮演 `rewind` 的三段守卫） |
| `TaskWorkspaceView` 读 `chatTaskWorkspace` | 读当前会话的；`resumeTask` 恢复到**当前**会话（它今天就清空当前会话再发种子轮） |
| 三段贵模型同时跑，账单 | 已按 `task` 字段可见；标签条上显示每会话累计 usage（`ChatUsage` 已是按会话的） |
| 后台会话的错误没人看见 | 错误也置 `unread`，标签上是错误态而不是普通未读 |
| 归纳（自动）在后台会话里触发 | 归纳是运行的一部分，本来就在 `runChatJob` 里，按 key 改写后天然隔离；`compactAbort` 这个模块级变量要变成 `Record<key, AbortController>` |
| 写手交接（`finishPolicy: "handoff"`）按会话 | 它读的是全局 Beta 开关 + 子代理配置，每次运行解析，不需要按会话 |

## 7. PR 切片

| PR | 内容 | 依赖 |
|---|---|---|
| **A · 标题** | 迁移 + `sessionDb` 三个函数 + 列表行改名/删除 + 头部可编辑标题 + `sessionLabel` + 命名不清 + 测试。**在单会话 store 上就能做**，`title` 先作为一个新的顶层字段 `chatTitle` | 无 |
| **B · 收敛写点** | `LiveChat` 形状 + `chats/chatOrder/activeChatKey` + `patchChat` + `useActiveChat`；`AgentChat` 换钩子；`AgentChat key=`；**仍然只允许一个会话**（`chatOrder.length === 1`）。目标是既有测试全绿、行为零变化 | A |
| **C · 并发** | `scheduler` 搬家 + 队列 + `running/aborts` + 卡片打标 + 自动批准 key + `unread` + `keep` + 系统通知 + `composerStore` 按 key | B |
| **D · 界面** | 标签条 + 历史列表的「打开 / 已打开」语义 + 模式 tab 的点 + 并发读数 + 关闭标签的确认。按设计稿落 | C + 设计稿 |
| 可选 · E | 打开集合持久化；「让助手起名」；⌃Tab | D |

A 可以独立发版；B 是无功能的重构 PR，评审时只看「有没有行为变化」。

## 8. 验收

- 三段对话各发一句，三条流各自推进、互不串台；第四段显示排队；切走再切回，字在。
- 后台一段提出改稿 → 那段的标签有「等你」记号，系统通知一次（窗口无焦点时）；切过去
  卡片在；当前这段**看不到**那张卡。
- 会话 A 点「本次都批准」，会话 B 的下一张卡仍然停下来等。
- 停止一段，其他两段继续；关闭正在跑的标签先问一次。
- 给空会话起名 → 发第一句 → 列表里的行带这个名字；保存十次名字不变；回退到第一问，
  preview 变了、名字没变。
- 起过名的会话在五段新对话之后仍在列表里；删除要确认；正在跑的不能删。
- 换项目：全部运行停止，新项目恢复最近一行。
- `pnpm test` 中 `chatSession*.test.ts`、`autoApprove.test.ts`、`subagentChips.test.ts`、
  `approvalRouting.test.ts` 全绿，新增 `chatScheduler.test.ts` / `chatSessionTitle.test.ts`。

## 9. 弃案

- **继续单会话，只把「历史会话」按钮在运行中解禁**（切走就停止当前运行）。这不是并发，
  是允许打断；作者要的是切走**继续跑**。
- **另起 `chatSessionsStore`，像 `roleplayStore` 那样绕开 `agentStore`**。扮演能绕是因为
  它只需要 `runAgent()`；对话助手的取材 / 归纳 / 状态记忆 / 工作区 / 回退 / 写手交接都在
  `sendChat` 里，绕开等于复制 700 行再分叉维护。
- **标题自动由模型起**。见 §3.4：每个新会话一次看不见的调用，不符合这个应用把成本
  写在明处的做法。
- **命名即固定**。两件事语义不同（固定是「列表里住哪一节」，命名是「叫什么」），合并了
  作者取消固定时会以为名字也没了。改成两者都保护、各自独立。
- **共用扮演的三个名额**。§4.3。
- **`title` 落成 `preview` 的覆盖**（同一列、作者改了就不再重算）。回退之后 preview 应该
  跟着对话变，而名字不该；一列装不下两种寿命。

## 10. 实现出入（PR A–C，2026-09-04）

按稿落地的不重复。以下是**和稿子不一样**、或稿子没说而实现时定下的：

- **自动批准的 key 不是 controller，是 `chat:<key>`**（`lib/agent/autoApprove.ts`
  `chatAutoApproveKey`）。§4.4 写的是照扮演改成 controller；实现时发现那会把「本次对话
  都批准」缩成「本次运行」——controller 随一轮死，而这个按钮存在的理由就是跨轮。字面量
  按会话拼，既不共用（A 的授权碰不到 B），又活到会话关闭（`endGrantFor`）。
  `autoApproveScope()` 据前缀判 `session`。全局仍只有一个授权槽：B 里按下会顶掉 A 的——
  那是今天「只有一个界面持有授权」的规则，跨标签沿用，作为已知限制记下。
- **对话助手从「默认界面」变成具名界面。** 它的五种卡全部打 `surface: chat:<key>`，
  `AgentChat` 按 `chatSurface(activeKey)` 过滤；`AiPanel` 继续读无标签的。
  `approvalRouting.ts` 一个字没改。
- **卡在等 = 未读。** `noteCardFor` 在五个 `request*` 入队点之后调用：卡片的 surface 指向
  非当前会话就置 `unread`。扮演至今没有这一条（花名册只在跑完时亮）。
- **`resumeTask` 开一段新会话**而不是清掉当前会话——按钮本来就写着「在新会话中继续」，
  而当前那段可能正在跑。用 `newChat()`（复用空标签，否则新开）。
- **同一会话内的排队**：store 层 `sendChatTo` 在运行中不再拒绝，作业按 key 串行；但
  `AgentChat` 的组件级「Enter 排队、本轮结束后发送」保留，`canSend` 另加 `!queued`——
  界面语义等设计稿定，store 已经能接。
- **发送时就定下模型与消息**：`ChatJob` 带 `model` / `provider` / `focus` / 已拼好的
  `wireMessage`——排队的问题跑在**问它时**的模型上、针对**问它时**打开的文档，
  不是名额空出来那一刻头部选着的那个。
- **`persistChat` 的 `keep`** 把刚写的那一行也算进去（`keepIds(…, justWritten)`），
  所以 INSERT 出来的新行不需要先知道 id 再保护。
- **`composerStore` 的 chat 草稿按 key**（`chat: Record<key, {draft, refs}>`，
  `chatComposerOf`），与 `roleplay` 同构；文件树的「发送到助手」写进当前会话的槽。
- **`scheduler` 搬到 `lib/agent/scheduler.ts`**（泛型，`ownerOf` 访问器），
  `lib/roleplay/scheduler.ts` 变成薄包装，`MAX_CONCURRENT_RUNS` 从 `roleplay/model.ts`
  re-export——扮演侧 import 路径不变。§4.3 说的「补上扮演没有的 scheduler 单测」在
  `lib/agent/__tests__/scheduler.test.ts`。
- **组件侧的缝**：`useActiveChat(selector)` / `activeChat(state)` / `chatSurface(key)` /
  `isChatBusy` 等从 `stores/agentStore.ts` 导出；`AgentChat` 以 `key={activeChatKey}`
  挂载（切标签即重挂，组件态天然归零）。`resetChat` 改名 `newChat`，
  `switchChatSession` 语义变成「已打开就聚焦，否则装进空的当前标签，再否则新开」。
- **不变量测试**：`lib/agent/__tests__/chatSessions.test.ts`（标签 / 运行 / 关闭 / 卡片归属 /
  保存 / 换项目）、`chatSessionTitle.test.ts`（数据层）、`scheduler.test.ts`。§5 的第 9、10 条
  （源码扫描）没写——`preview ||` 与 `s.chats[` 的约束目前靠评审。

## 11. 界面落地（PR D，设计稿 23，2026-09-04）

设计稿的答案，和实现时的取舍：

- **张力一 → 横向标签条**（`components/ai/SessionTabs.tsx`，38px，夹在模式 tab 和对话区
  之间）。当前标签底色＝对话区底色、顶上 2px 赭石线、压掉发丝线；其它标签只有一根竖
  发丝线。标签 120–220px，放不下的收进右端「+N」，点开就是历史下拉。并发读数
  `并发 ▮▮▯ 2 / 3 · 排队 1` 在标签条右端，扮演花名册脚那一行的同一语汇。**标签上只有
  记号、字、×**——用量不上标签。稿子否掉的竖向侧栏（1c）没有做。
- **张力二 → 三家记号**（`lib/agent/chatState.ts` 纯判定 + `components/ai/ChatMark.tsx`）：
  圆＝在跑（5px 实心脉动 / 空心环），方＝有结果（7px 实心 / 空心），两根 2×9 竖条＝停住等
  你。会话自己的态：等作者 > 在跑 > 排队 > 出错 > 未读；模式 tab 只挂最急的一个：竖条 >
  方块 > 圆。当前标签不画未读方块。「等你 · mm:ss」的起点是卡片入队的时刻——五种
  pending 卡都加了 `at`。
- **两种字**（`lib/agent/chatLabel.ts`）：作者的名 500 字重、亮一档；第一句话的截断 400
  字重、暗一档、前带开引号“；没有第一句的新会话写「未命名」最淡一档、不带引号。
- **张力三 → 历史下拉三节**（`SessionMenu.tsx`）：已打开（唯一用赭石写小标签的一节，行尾
  「切到 ›」）/ 已固定 / 最近（脚注写清 5 条的规则）。**没有「已命名」一节**。悬停三个图标
  + 右键同一套（`ContextMenu`，为此给它的根加了 `data-context-menu`，让抽屉的「点外面关
  菜单」认出 portal 出去的右键菜单）。删除就地确认，「删除」赭石不用红；正在生成的行删除
  灰掉，悬停说「正在生成 · 先停止」。多了一个搜索框（稿子 1e 画了）。
- **张力四 → 头部是会话名**（`SessionTitle.tsx`）：四态就地——静止 / 悬停出铅笔 / 编辑中
  1px 赭石框 + `n / 60` 计数 + 一行提示 / 空名写「未命名会话」虚线底。列表行同样就地改名，
  截断做占位。「让助手起名」的槽位留着（CSS 里的 `.suggest` 注释），按钮不渲染。
- **新会话永远可点**，`⌘N`（只在抽屉开着且在对话助手模式时绑定；文件树的 ⌘N 要树有焦点，
  两者不撞）。落在已有的空标签上时那条标签顶线闪一下（240ms，稿子写 120，取了应用里
  近似的时长）。空态两行字（`emptyTitle` / `emptyOthers` + `emptyUnsaved` 或
  `emptyClosed`）；**唯一保留旧引导文案的情形**是作者第一次用：没有别的标签、没有历史、
  也不是刚关了一段——那时候两行字说不清这是什么。
- **排队卡**（AgentChat 里）与扮演同构，多一行「正在跑的：」列名字——会话之间唯一
  「看见」彼此的地方，看见的只是名字。「取消排队」把那句话退回输入框（`dequeueChat` 返回
  文本并删掉两条占位轮），「插到最前」只排到队首（`promoteChat`）。
- **切到等作者的那一段**：转录区淡到 55%，卡片是这段对话里唯一带顶上 2px 赭石线的东西
  （`.approvals > :first-child`），输入框变成一句话「这段停在上面那张卡…」，**不是禁用**。
  稿子的 `justify-content: flex-end` 没照做——转录区是滚动容器，那会截掉顶部；卡片本来就
  停靠在输入框上方，效果相同。
- **关闭正在生成的标签两步就地**：标签变成「还在生成。停止并关闭？」，Esc 或「留着」回去；
  确认＝`stopChat` + `closeChat`。停下来的那段留在历史里。
- **换项目**（`ChatSwitchGuard.tsx` + `agentStore.confirmProjectSwitch`，接在
  `projectStore.openProject` / `closeProject` 的最前面）：有会话在跑 / 排队 / 归纳 / 等作者才
  问一次，逐行列出并写清各自的去向（写到哪算哪 / 会按拒绝处理 / 退回草稿）；全部闲着直接
  切。第二次问会把第一次按「留下」答掉，不叠两个对话框。
- **未做**：「让助手起名」（第一期隐藏）；标签条键盘切换 ⌃Tab；打开集合持久化（§7 可选）。
- **合并后修的一处崩溃（React #185）**：`ChatSwitchGuard` 的行列表和 `SessionMenu` 的
  「已打开」一节原本在 `useAgentStore` 的选择器里 `map`/`flatMap` 出一个新数组——每次调用
  都不相等，`useSyncExternalStore` 就无限重渲染，打包后的应用首屏即白（守卫常驻挂在
  `App.tsx`）。改法是 `agentStore` 导出 `ChatStateInputs` 切片 + `useChatStateInputs()`
  （`useShallow` 按引用比较那十二个字段），组件在 `useMemo` 里算数组；`chatStateOf` 等
  几个判定函数的参数类型收窄到这个切片。**规则：传给 `useAgentStore` 的选择器只返回
  原始值或 store 里已有的引用，永不现造数组或对象**——`chatSessions.test.ts` 钉着切片的
  形状。
- **复核（2026-09-04，PR D 合并后对着稿子 1a–1j 再核一遍）**，改掉了五处看得见的出入，
  另有两处是有意不照稿：
  - 标签条的底色原来用 `--color-bg-stream`，它**比头部亮**，当前标签贴不出来；稿子里标签条
    是抽屉最暗的一条带（深 `#14100C` / 浅 `#F1ECE0`）。新加 `--color-bg-tabstrip`，只有这一个
    用途。
  - 历史下拉里「当前」那一行原来把会话名染成赭石；稿子是左缘 2px 赭石竖条 + 选中底色
    （`--color-bg-selected`，深色正好是稿子的 `#2A211A`），名字仍是亮字。染色的名字读作链接。
  - 空态芯片：没选区时原来是一行灰字「未选中正文」，稿子 1g 写明芯片要回到该会话的默认——
    「+ 选区」是禁用的幽灵芯片，「自动批准 —」是虚线芯片（`AutoApproveChip` 的 `absent`，
    只有对话助手传它；它不是控件，授权永远在卡上给）。状态记忆芯片仍随 Beta 隐藏——
    那条「Absent — not disabled」是自己的决定，见 `StateMemoryChip`。
  - 排队卡：稿子 1h 是行首空心环在**槽里**、卡内一个转圈，「正在跑的」一行上有分隔线——
    和扮演的排队卡同构（那边就有转圈）；原来把空心环塞进卡里顶替了转圈。
  - 小样式：空态标题 300/22px；下拉节标题拉一根发丝线、计数靠右、行 13px、脚注斜体衬线；
    换项目对话框的行去掉发丝线、脚注衬线、按钮行上加一根线。
  - **没照稿的**：芯片行的排布仍按设计稿 02——「+ 条目 / + 文档」推到行尾，稿子 1g 把它们画在
    左边是示意，02 的那条「what this message carries and what could be added stay
    visually separate」是有理由的；头部静止态不常显铅笔（1a/1g 全貌图里有一支很淡的，1f
    「静止」小图没有，取 1f）。稿子头部写的 ⌘⇧A 是旧值，应用一直是 ⌘L。

