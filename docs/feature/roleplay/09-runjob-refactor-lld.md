# runJob 重构 · 详细设计（LLD）

> 背景：第九轮审查（见 [05-implementation-notes.md](05-implementation-notes.md) §9）修掉的
> 三个高严重度 bug 全部出在 `roleplayStore.runJob` 的历史准备路径里——这不是偶然。
> 本文档是那次审查遗留的结构建议的落地设计：**只动形状，不动行为**。
> 状态：设计完成，待实现。

## 1. 问题：为什么这 345 行值得动

`runJob`（`stores/roleplayStore.ts:498-842`）今天揉着七件事：

| # | 职责 | 行数（约） | 出过 bug 吗 |
|---|---|---|---|
| 1 | 连接解析 + 中止控制器 + 本轮状态复位 | 25 | — |
| 2 | **历史准备**：重试 / 播种 / 续跑三分支 | 120 | **三个高严重度全在这** |
| 3 | 标记 committed（重试语义的锚点） | 4 | — |
| 4 | workspace 复活 + preset 路由 | 15 | — |
| 5 | ToolContext 装配（六个通道） | 60 | — |
| 6 | runAgent 调用 + 旁白专属回调 | 30 | — |
| 7 | 回复落盘 / 用量 / 通知 / catch / finally | 90 | 轮号竞态（已修） |

问题不在长——在**第 2 块没有测试，也没法有**：它住在 zustand 闭包里，
读三个别的 store，交错着 `patchSession`。第九轮修的三个 bug（记忆块失联、
重复沉降的姊妹问题、播种轮没有记忆区检索）本质上都是「历史准备的某条排序 /
某个状态迁移只存在于这段没人能跑的代码里」。修完时补的测试也只能测到它调用
的纯函数（`seedRoleplayHistory` / `takeSinkable`），测不到**编排本身**——
「压缩之后才刷新记忆块」「区检索排在词条注入之后、提问之前」「提问永远是
最后一条且带 turnStart」这些排序，今天仍然只由没有测试的店内代码保证。

## 2. 设计原则（三条约束，定了就不再讨论）

1. **行为零变更。** 这是纯结构重构：状态迁移的顺序、liveLog 事件的顺序、
   重试语义、对象身份（meta 就地改、块引用不换）全部保持。验收方式见 §7。
2. **`lib/agent/*` 一行不改**（沿用 01-overview 的原则）。重构边界是
   `lib/roleplay/` 和 `stores/roleplayStore.ts` 两处。
3. **lib 做 IO，store 做状态。** 这是本仓库既有的分界（`lib/roleplay/store.ts`
   读写磁盘、`context.ts` 读条目正文），不是新发明。所以抽出去的函数**可以**
   直接读盘、跑压缩摘要，但**不准** import 任何 zustand store——需要向 store
   报告的事，以**返回值**说出来，由 store 去 patch。不引入依赖注入式的
   ports 接口（见 §8 被否掉的方案 A）。

## 3. 目标形态

### 3.1 新模块 `src/lib/roleplay/run.ts`

一次运行的**历史准备**逻辑，三分支各成一个可独立测试的函数。签名如下
（类型名用现有词汇，不新造）：

```ts
// ── 静态上下文（从 store 平移过来，refreshBinding / checkBindings 同样改从这里 import）
export interface StaticContext { primaryText: string; personaCard: string }
export async function loadStaticContext(
  projectPath: string, agent: RoleplayAgent,
): Promise<StaticContext>

// ── 回放轮的选择（纯函数）：去掉末尾那条刚落盘的作者问
export function selectPriorTurns(turns: readonly SceneTurn[]): readonly SceneTurn[]

// ── 记忆区检索（从 store 闭包平移，改为返回值风格）
export interface RecalledEntity { name: string; dirPath: string }
export async function injectAreaRecall(opts: {
  projectPath: string;
  areaId: string | null;
  matchText: string;
  history: StreamMessage[];        // 就地 splice
  meta: RoleplaySessionMeta;       // 就地记账；prelude 情形就地标轮起点
  insertIndex: number;
  budgetChars: number;
}): Promise<RecalledEntity[]>      // [] = 没想起任何事（区为空 / 没命中 / 读不出）

// ── 播种分支
export interface SeedOutcome {
  history: StreamMessage[];
  meta: RoleplaySessionMeta;
  bound: BoundContent;             // stalePaths 给 UI
  report: LoreActivationReport | null;   // context-seeded 事件的数字
  memoryRecords: MemoryRecord[];   // 记事本面板的初始数据
  contextHash: string;             // 「设定已更新」的新基线，store 写进花名册
  recalled: RecalledEntity[];
}
export async function prepareSeededHistory(opts: {
  projectPath: string;
  agent: RoleplayAgent;
  persona: AuthorPersona;
  loreIndex: LoreIndex;
  wire: MessageContent;
  matchText: string;
  loreBudgetChars: number;
  areaBudgetChars: number;
  /** 显示层的当前对话（store 传入），用来算回放轮。 */
  currentTurns: readonly SceneTurn[];
}): Promise<SeedOutcome>

// ── 续跑分支
export interface ContinueOutcome {
  /** 压缩可能重建数组；没压缩时就是传入的那一个。 */
  history: StreamMessage[];
  compactedEvent: AgentEvent | null;
  /** 压缩产出的滚动摘要；store 负责 fire-and-forget 落盘（保持今天的时序）。 */
  summaryToSave: string | null;
  /** 压缩后从盘上重读的记忆；null = 没压缩，记事本不用动。 */
  memoryRecords: MemoryRecord[] | null;
  recalled: RecalledEntity[];
}
export async function prepareContinuedHistory(opts: {
  projectPath: string;
  agent: RoleplayAgent;
  loreIndex: LoreIndex;
  history: StreamMessage[];        // 就地改（meta 的块身份必须活着）
  meta: RoleplaySessionMeta;
  wire: MessageContent;
  matchText: string;
  loreBudgetChars: number;
  areaBudgetChars: number;
  ceilingTokens: number;
  /** 连接绑定的摘要器，store 用 connOptions 闭包好传进来——lib 不碰密钥。 */
  summarize: (input: string) => Promise<string>;
}): Promise<ContinueOutcome>

// ── 角色回看自己这一场的通道（ConversationReader 的工厂，纯平移）
export function conversationReader(
  projectPath: string, agentId: string,
): ConversationReader
```

**内部排序 = 今天的排序，逐条搬**：

- `prepareSeededHistory`：`loadStaticContext` → `loadMemoryDoc` →
  `selectPriorTurns` → 有回放才 `loadSummary` → `seedRoleplayHistory` →
  `contextSignature`+`hashText` → `injectAreaRecall(…, history.length - 1)`
  （旧事插在提问前）。
- `prepareContinuedHistory`：`repairToolCallPairing` → `compactChatHistory`
  →（压缩了才）`loadMemoryDoc` + `refreshMemoryBlock` →
  `assembleTurnInjection` + 账本 → `injectAreaRecall(…, history.length)` →
  push 提问 + `noteTurnStart`。**提问永远是最后一条**。
- 重试分支只有一行 `repairToolCallPairing`，**不值得成为函数**——它留在
  store 的分派处，作为三分支里可见的那个「什么都不用准备」。

### 3.2 常量迁移

`AREA_BUDGET_TOKENS` 从 store 顶部迁到 `lib/roleplay/model.ts`——它是领域
预算常量，和 `SCENE_READ_CHAR_CAP` / `RESTORE_REPLAY_CHAR_CAP` 是同类；
今天卡在 store 的 import 块中间（第 71 行）本来就是个错位。注释原样带走。

### 3.3 store 侧：runJob 变成一页纸的叙事

```
runJob(job):
  解析连接（失败 → error + 让出名额 + pump）
  controller 注册 + 本轮状态复位
  try:
    三分支分派：
      committed && 有历史   → repairToolCallPairing(history)          // 重试
      无历史               → prepareSeededHistory(...)   → patch 基线/会话/事件/recalled
      有历史               → prepareContinuedHistory(...) → patch 历史/事件/摘要落盘/记事本/recalled
    lastJob = {committed: true}
    workspace 复活；preset 路由
    runAgent(conn, history, toolContext, 旁白回调)
    回复落盘（appendTurnChained）；用量；通知
  catch: Abort → stopped；其余 → error
  finally: rejectAll；contextVersion++；saveSession；让出名额；pump
```

预计 ~170 行（原 345）。两个 patch 汇合点值得说清：

- **播种后的 patch**（原 566-595 行的两次 set + 一次 patchSession）合并语义
  不变：基线哈希 + stale 清零进花名册 state，`history/meta/stalePaths/memory/
  memoryStale/liveLog(context-seeded)` 进会话，`recalled` 按
  `turns.length + 1` 键入——这个下标在 store 算，因为它读的是显示层状态
  （见 §6 风险 3）。
- **续跑后的 patch**：`history`（压缩可能换了数组）+ `liveLog(compactedEvent)`
  + `memoryRecords`（非 null 时）+ `recalled`；`summaryToSave` 非 null 时
  `void saveSummary(...)`——**保持 fire-and-forget**，把它挪进 lib 同步 await
  会改变失败语义（摘要写不进盘今天不毁这一轮）。

**ToolContext 装配留在 store，不抽。** 六个通道里四个是 store 绑定的
（`scenes` 要 `sceneReader()`、`agentMemory` 要 `mutateMemory`→`patchSession`、
`requestApproval` 要 agentStore、`resolveSubAgent` 要本场的子代理覆盖）；
把它抽成函数就得把这四样再包成参数递回去——搬了一次对象字面量，换来一层
没有内容的间接（§8 方案 B）。唯一平移的是 `conversation` 通道：它是纯 lib
（读 transcript），工厂放进 run.ts，store 一行 `conversation:
conversationReader(projectPath, agent.id)`。

### 3.4 删掉的东西

- store 里的 `injectAreaRecall` 闭包（60 行）→ lib，patch `recalled` 的职责
  交还调用方。
- store 里的 `loadStaticContext`（模块级函数）→ lib；`refreshBinding` /
  `checkBindings` 改 import 路径，行为不变。
- 播种分支里的 `priorTurns` 内联计算 → `selectPriorTurns`。

## 4. 不变量清单（重构期间逐条对照）

1. 历史突变顺序：压缩 → 记忆块刷新 → 词条注入 → 区检索 → 提问。
2. `lastJob.committed = true` 恰好发生在提问进入 history **之后**、runAgent
   **之前**；prepare 任何一步抛出时 committed 仍是 false，重试整套重来。
3. liveLog 事件顺序：`context-seeded` / 压缩事件出现的时机与今天逐帧相同。
4. meta **就地改**：`boundBlock` / `memoryBlock` / 账本 / `turnStarts` 的对象
   身份跨越整个 prepare 存活（`saveSession` 的下标序列化依赖它）。
5. 基线哈希只在播种路径写，且必须由 `contextSignature` 同一函数算出
   （`contextHash` 的注释说过：基线和实际内容各读各的 = 永远对不上的比较）。
6. `saveSummary` / `persistRoster` / `persistUsage` 保持 `void`（不阻塞）。
7. 区检索失败不毁这一轮（`injectAreaRecall` 内部吞掉并 warn，返回 []）。
8. 播种且无回放时，区检索载体标为自己的轮起点（第九轮 §9.4 的折叠语义）。
9. `AREA_BUDGET_TOKENS` 数值不变（800）。
10. `lib/agent/*` 与所有 preset / 工具注册零改动。

## 5. 测试计划（新 `__tests__/run.test.ts`，预计 12-15 个用例）

复用 context.test.ts 的 mock 风格（i18n `t: k=>k`、fileio 内存表、真实的
compact / loreSelect）：

**selectPriorTurns**
- 末尾是作者轮 → 去掉；末尾是角色轮 → 原样；空数组。

**prepareSeededHistory**
- 形状 = `[system, 绑定块, 记忆块, (seed), (summary), 回放…, (区检索), 提问]`，
  提问是最后一条且在 `turnStarts` 里。
- `contextHash` 等于用相同输入直接算 `contextSignature`+`hashText` 的结果
  （不变量 5 的钉子）。
- 有回放轮才读 summary.md（用 fileio mock 的调用记录断言）。
- 无回放 + 区命中 → 载体在提问前一位，且是轮起点（不变量 8）。

**prepareContinuedHistory**（这组是本次重构的全部意义所在）
- 不触发压缩：顺序 = [词条注入?]→[区检索?]→提问；提问带 turnStart；账本
  记了注入条目。
- 触发压缩（喂长历史 + 假 summarize）：`compactedEvent` 非空、
  `summaryToSave` = meta.summaryText、`memoryRecords` 从盘上重读、
  **记忆块内容在压缩后被刷新**（第九轮 §9.1 的排序，第一次有编排级测试）、
  两个块身份跨压缩存活。
- summarize 抛出 → 整个函数抛出（重试语义靠 committed=false 兜底，
  这里只需确认不吞）。

**injectAreaRecall**
- 无 areaId / 区为空 → 返回 []，history 不变。
- 命中 → 载体插在 insertIndex，带【…】标签；返回的 RecalledEntity 有名字。
- 同一 meta 连调两次 → 第二次 []（账本防重发）。
- scanArea 抛出 → 返回 []（不变量 7）。

**conversationReader**
- 每次 `read()` 都重新读盘（改盘后第二次调用看得见新轮次）。

## 6. 风险与对策

1. **压缩换数组，store 忘了接。** `ContinueOutcome.history` 永远返回（没压缩
   时 === 传入引用），store 无条件 patch——比「压缩了才 patch」少一个分支，
   多一次无害的引用赋值。
2. **meta 身份断裂。** lib 函数签名上 meta 是入参且就地改，测试里对块身份
   有直接断言（§5）；`saveSession` 的 round-trip 测试（store.test.ts）已经
   在守序列化那半边。
3. **`recalled` 的轮号。** 今天它在 injectAreaRecall 内部用
   `sessions[id].turns.length + 1` 键入；重构后 store 在 prepare 返回处算同
   一个式子。prepare 期间唯一能改 turns 的是并发的 `appendTurnChained`——
   而 pump 保证同 agent 不并发跑，`send` 的追加发生在入队**前**，所以
   prepare 全程 turns 不变，两种算法等价。写进代码注释。
4. **动态 import 的丢失。** store 今天动态 import loreSelect（区检索里）；
   run.ts 会静态 import。`context.ts` 已经静态 import 它，同属一个 chunk，
   bundle 无回归。`agentStore` 的动态 import（审批 / 轮数卡）留在 store，
   不受影响。
5. **行为漂移的总闸。** 重构前后各跑一遍全量 vitest + tsc + build；diff 里
   store 的每一次 `patchSession` / `set` 都要能指回 §3.3 的对应行。

## 7. 迁移步骤（3 个 commit，每步全绿）

1. **平移无争议的**：`AREA_BUDGET_TOKENS` → model.ts；`loadStaticContext` +
   `conversationReader` + `injectAreaRecall`（改返回值风格）→ run.ts；store
   改调用处。附 injectAreaRecall / conversationReader 的测试。
2. **播种分支**：`selectPriorTurns` + `prepareSeededHistory`；runJob 播种
   分支替换为「调用 + 两次 patch」。附测试。
3. **续跑分支**：`prepareContinuedHistory`；替换续跑分支；runJob 收形到
   §3.3 的叙事。附测试（§5 里最重的那组）。更新 05-implementation-notes
   §10 一节 + 本文档状态行。

## 8. 被否掉的方案

| 方案 | 为什么不 |
|---|---|
| **A. ports/DI**：prepare* 不做 IO，全部效果以接口注入 | 和仓库分界相反（lib 本来就直接读盘），每个测试要先搭一套假 ports，测的是「假 ports 被怎么调」而不是真排序。context.test 用 fileio mock + 真 compact 的现路线已经证明更值 |
| **B. ToolContext 抽成 lib 工厂** | 六个通道里四个 store 绑定，抽了就是把闭包拆成参数再原样递回去——一层没有内容的间接 |
| **C. runJob 全量拆成 start/execute/finish 三段** | catch/finally 的补偿逻辑（rejectAll、名额、saveSession）和 try 是一体的；拆开后每段都要重新解释「我失败了谁收尾」。历史准备是唯一测试价值密集的段，只拆它 |
| **D. 类/状态机化（RunContext 对象） | 345 行里只有 prepare 有分支结构；为一次线性流程引入生命周期对象是把叙事变成散点 |
