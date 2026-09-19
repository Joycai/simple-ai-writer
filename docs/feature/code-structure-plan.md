# 源码结构整改方案（分层与循环依赖）

> 状态：`planned`——已决定，未动工。进度看 §2，每合一个 PR 改一行。
> 背景：2026-09-19 对 `src/` 做了一次结构审查。顶层分层（`components → stores → lib → Tauri`）是健康的：`lib` 不依赖 `components`，`stores` 不依赖 `components`，`lib/` 27 个子目录各有 `__tests__/`。问题集中在 agent 子系统和几个几千行的文件，它们正在从内部侵蚀这套分层。这份方案把整改拆成可以单独合并的阶段，并在第一步装上守卫，让后面每一步只能往前走。

## 0. 这份文档怎么用

- **每个阶段一个 PR，从 `main` 切，不叠 PR**（`CLAUDE.md` → 协作约定）。分支前缀 `refactor/`，P0 用 `chore/`。
- **只改结构，不改行为。** 一个阶段里如果发现非改行为不可，停下来，把它记进 §7「偏离记录」，另开 `fix/` PR，不夹带。
- **每个阶段结束时**：更新 §2 的进度行和 §3 的指标；把 P0 守卫里对应的上限调到新的实际值（棘轮只降）；`codemap.md` 里涉及的那一节同步改。
- **范围之外的事不做**，即使顺手。§6 列了明确不做的事和理由；想加进来，先改这份文档。

## 1. 现状盘点（2026-09-19，`main` @ `03882022`，逐项核实）

### 1.1 运行时循环依赖：4 组强连通分量，24 个文件

只数**值导入**（`import type` 与 `import { type X }` 不算，它们在编译后消失）；`await import("…")` **算**一条边——它只是把环藏到了运行时。复现命令见 §8。

| 组 | 文件数 | 成员 |
|---|---|---|
| agent | 12 | `lib/agent/` 的 `handoff` `imageTools` `packs` `registry` `routing` `runtime` `subagent` `toolCost`，`lib/asr/conn` `lib/asr/tool`，`lib/translate/tool`，`stores/aiStore` |
| lore | 6 | `lib/fs/markdown`，`lib/lore/` 的 `citations` `entity` `index` `transfer`，`stores/loreStore` |
| project | 4 | `stores/` 的 `agentStore` `editorStore` `memoryStore` `projectStore` |
| batch | 2 | `stores/aiTaskStore` `stores/batchStore` |

只看静态导入是 2 组 13 个文件——另外 11 个是 `await import` 藏起来的。（盘点时数成 25 个：`events.ts` 注释里的一段 `import("…")` 示例被当成了边，P0 的解析器先去注释再解析，见 §7。）**组是 P0 棘轮的单位**：环路条数取决于遍历顺序，组的成员不会。

下表是 madge 列出的 15 条具体环路，用来看「为什么成环」，不作指标：

| # | 环 | 归类 |
|---|---|---|
| 1 | `fs/markdown → lore/citations → stores/loreStore → lore/index → lore/entity` | B：`citations` 读 store |
| 2 | `lore/citations → stores/loreStore → lore/index → lore/entity` | B |
| 3 | `fs/markdown → lore/citations → stores/loreStore → lore/index → lore/transfer` | B |
| 4 | `agent/runtime ↔ agent/handoff` | A2：`handoff` 需要 `runAgent` |
| 5 | `subagent → runtime → registry → imageTools → subagent` | A1：`imageTools` 只为 `subAgentModel` |
| 6 | 同 5，经 `imageTools → stores/aiStore` | A1 + B |
| 7 | `packs → routing → subagent → runtime → registry → packs` | A1 + A2 |
| 8 | `subagent → runtime → registry → subagent` | A2：registry 的 `delegate` 调 `executeDelegate` |
| 9 | `subagent → runtime → registry → asr/tool → asr/conn → subagent` | A1 |
| 10 | `subagent → runtime → registry → translate/tool → subagent` | A1 |
| 11 | `routing → subagent → runtime → toolCost → routing` | A1 |
| 12 | `projectStore → agentStore → editorStore → projectStore` | C |
| 13 | `projectStore → agentStore → memoryStore → projectStore` | C |
| 14 | `projectStore ↔ agentStore` | C |
| 15 | `aiTaskStore ↔ batchStore` | C |

**A1 的根。** `lib/agent/subagent.ts`（647 行）把两类东西放在一起：纯查询（`SUBAGENT_KINDS`、`DELEGATE_KINDS`、`SUB_PRESETS`、`subAgentModel`、`searchReadsPages`、`visionSubAgentModel`、`withSessionOverrides`、`chainCanSeeImages`、`resolveSubAgentConn`、`resolveVisionConn`）和执行入口（`executeDelegate`，内部调 `runAgent`）。`imageTools`、`translate/tool`、`asr/conn`、`routing` 都只要前者，却因此把 `runtime` 整个拉进了依赖图。

**A2 的根。** 三处「工具执行时要再跑一次 agent」：registry 的 `delegate`（→ `executeDelegate`）、`run_pack`（→ `packs.executeRunPack`）、写手交接（`handoff.runWriterHandoff`）。它们直接 import `runAgent`，而 `runtime` 又 import 它们。

**更正审查时的一个判断。** 审查时说过「`*Tools.ts` 从 registry 导入类型、registry 导入它们的实现，于是成环」。核实后不成立：`*Tools.ts` 从 `registry` 导入的**全是类型**，不产生运行时环。拆 `registry.ts` 的类型仍然值得做（P6，为了文件大小），但它**不是**解环的手段。

### 1.2 `lib → stores` 的值依赖：7 个文件

| 文件 | 读什么 | 方式 |
|---|---|---|
| `agent/imageTools.ts` | `aiStore` 的 `models, subAgents` | `await import` |
| `translate/tool.ts` | `aiStore` 的 `models, providers, subAgents` | `await import` |
| `asr/conn.ts` | 同上 | `await import` |
| `image/illustrate.ts` | `aiStore` 的 `models, providers` | `await import` |
| `lore/citations.ts` | `loreStore.index` / `openDetail`、`appStore.setMainView` | `await import` ×2 |
| `agent/docxTools.ts` | `docFormatStore` 的四个导出 | 静态 |
| `editor/aiSelection.ts` | `editorStore.editorView` | 静态 |

`lib/shortcuts.ts` 只 `import type { AppScreen }`，不算。前四个要的是同一样东西——一份 AI 配置快照；`ToolContext` 已经有 `resolveSubAgent` 回调，是注入这类依赖的现成先例。`citations` 的 `installCitationNavigation()` 由 `App` 安装一次，可以直接收回调作参数。

### 1.3 store 之间的动态导入：61 处

`agentStore` 34、`roleplayStore` 18、`aiTaskStore` 5、`projectStore` 4。数的是 `import("./…")` 的**次数**——`Promise.all([import(…), import(…)])` 一行算几次（盘点时按行数成 50，见 §7）。多数是为了绕开环 12–15。环本身的来由：

- `projectStore → agentStore`：切换/关闭项目时调 `confirmProjectSwitch`、`resetChatForProject`（`openProject`、`closeProject` 两个 action 里）。
- `aiTaskStore → batchStore`：只读 `useBatchStore.getState().running`（`runTask` 里三处：选预设时一次，`onTruncationLimit`、`onRoundLimit` 回调各一次）。

### 1.4 大文件

| 文件 | 行数 | 结构 |
|---|---|---|
| `lib/agent/registry.ts` | 4246 | 类型约 1100 行（`Proposal` 家族、`ToolContext`、`RegisteredTool`）+ `REGISTRY` 字面量 2750 行（79 个工具）+ 查询函数 |
| `lib/agent/writeTools.ts` | 3907 | 已经用分节注释切成 16 段 |
| `stores/agentStore.ts` | 3251 | `applyEdit`…`applyProposal`（约 450 行，把批准的提案写盘）；`create()` 本体约 1000 行；`runChatJob` 一个函数约 700 行；读侧选择器 100 行 |

**不会被拆分改变的东西。** `getToolDefinitions(ids)` 按调用方传入的 id 顺序出定义，不看 `REGISTRY` 的键序；`ALL_TOOL_IDS` 的顺序只有 `agentToolConventions.test.ts` 在用。所以按领域拆 `REGISTRY` 不改变发给模型的任何一个字节。

### 1.5 零碎

- `LoreDetail.tsx` 的 `handleAvatarPick` 与 `handleAddImages`、`LoreWall.tsx` 的 `handleAvatarPick` 各自写了一遍「读字节 + 取扩展名」，那正是 `lib/fs/images.ts` 的 `readImageBytes`，它的注释点名说头像路径该用它。
- `docs/reference/codemap.md` 11.5 万字符，单行最长 8935 字符——本该是「逐层展开」的那一层，自己成了一堵墙。

## 2. 进度

| 阶段 | 内容 | 状态 | PR |
|---|---|---|---|
| P0 | 守卫：分层与循环的棘轮测试 | 已合并 | #644 |
| P1 | 拆 `subagent.ts`：纯查询 / 执行 | 已合并 | #645 |
| P2 | `runAgent` 经 `ToolContext` 注入，解 A2 | 已合并 | #646 |
| P3 | `lib → stores` 归零 | 已合并 | #647 |
| P4 | store 环：项目生命周期协调 + 批处理标志 | 已合并 | #648 |
| P5 | `agentStore` 拆分 | 已合并 | #649 |
| P6 | `registry.ts` / `writeTools.ts` 按领域拆分 | 已合并 | #650 |
| P7 | 零碎：`readImageBytes` 复用、`codemap.md` 分段 | 进行中 | |

状态只用 `未开始` / `进行中` / `已合并` / `放弃（见 §7）`。

## 3. 指标

| 指标 | 起点 | P1 后 | P2 后 | P3 后 | P4 后 | 终点目标 |
|---|---|---|---|---|---|---|
| 循环依赖：组 / 文件（§1.1） | 4 / 24 | 4 / 18 | 3 / 12 | 2 / 6 | 0 / 0 | 0 / 0 |
| `lib → stores` 值依赖文件数（§1.2） | 7 | 7 | 7 | 0 | 0 | 0 |
| store 间 `await import`（§1.3） | 61 | 61 | 61 | 57 | 21（全在 `agentStore`，理由见守卫） | 只剩写明理由的几处 |
| 最大源文件行数 | 4246 | 4246 | 4274 | 4297 | 4297 | < 1500 |

每一列在对应 PR 合并时填实际值。「P1 后」「P2 后」的循环数是预期会降的地方；没降，就是方案错了，先回来改文档。

## 4. 阶段

### P0 · 守卫先行

**做什么。** 在 `src/lib/__tests__/` 加 `layering.test.ts`（仓库级扫描守卫，`testPlacement.test.ts` 允许放在这里），写法照 `capabilityFamilyRatchet.test.ts`：

1. **循环**：扫 `src/**/*.{ts,tsx}`（跳过 `__tests__`），用正则解析值导入（跳过 `import type` 与只含 `type X` 的花括号；`await import("…")` 也算一条边——它躲得过打包器，躲不过这个测试），建图，用 Tarjan 算强连通分量。允许清单 = §1.1 的 4 组成员，写成 `ALLOWED_CYCLES`，每组注明归类。任何文件出现在清单之外的组里（新环，或已有的组吸进新文件）就失败；组变小或消失也失败，并提示把清单删成新的实际值。
2. **`lib → stores`**：`CEILING` 记 §1.2 的七个文件，没记的就是 0。
3. **store 间动态导入**：按文件记上限（§1.3 的四个数）。

TypeScript 7 没有 JS API，所以不引依赖、用正则；§8 的 madge 命令是交叉核对用的，不进 CI。

**完成判据。** 测试在 `main` 上是绿的；故意加一条 `lib → stores` 的 import 会红。

### P1 · 拆 `subagent.ts`

**做什么。** 纯查询搬进新文件 `lib/agent/subagentModel.ts`（§1.1 A1 列的那些），`subagent.ts` 只留 `executeDelegate` 及其私有函数，并从 `subagentModel` 重新 import 它要的。调用方改 import 路径：`imageTools`、`translate/tool`、`asr/conn`、`routing`，以及其余只用查询的地方（`grep "from \"./subagent\""` 逐个判）。

**不做。** 不改任何函数签名，不重命名导出。

**完成判据。** agent 组缩小：预期 `imageTools`、`translate/tool`、`asr/*`、`routing` 离组（madge 的环 5、9、10、11 消失），以守卫实测为准；P0 清单删成新成员。

**风险。** `SUB_PRESETS` 引用 `TaskPreset`（类型），不会带回 `runtime`；如果某个查询函数实际依赖执行路径，把它留在 `subagent.ts` 并在 §7 记一行。

### P2 · `runAgent` 注入

**做什么。** `ToolContext` 加一个字段（暂名 `runSubAgent: typeof runAgent`），由 `runtime` 在构造工具上下文时填入它自己。`executeDelegate`、`executeRunPack` 改成从 `ctx` 取；`runtime` 调 `runWriterHandoff` 时把 `runAgent` 作参数传进去。之后 `subagent`、`packs`、`handoff` 都不再 import `runtime` 的值。

**为什么不用其它办法。** 模块级的「注册表 setter」（`setRunner(runAgent)`）也能解环，但它是隐式的全局可变状态，测试之间会互相污染；`ToolContext` 本来就是一次运行的快照，子运行从它派生是这个项目已有的写法（`resolveSubAgent` 就是这么进来的）。

**完成判据。** madge 的环 4、7、8 消失；只看静态导入时 agent 组消失。它若仍在（含动态边），剩下的应当只是经 `stores/aiStore` 的那几条——P3 处理。

**风险。** `ToolContext` 的字段增减会碰 `agentToolBudget` / tool-presence 相关的检查吗？不会——它不是工具 schema。但要确认所有构造 `ToolContext` 的地方（非 runtime 的调用方，如一致性检查、roleplay）都走得到这个字段，漏了的地方类型检查会拦（字段设为必填）。

### P3 · `lib → stores` 归零

**做什么。**

- `imageTools` / `translate/tool` / `asr/conn`：AI 配置快照从 `ToolContext` 取。先读 `resolveSubAgent` 的现有用法，能用它就用它，不另加字段；不够再加。
- `image/illustrate.ts`：调用方（`agentStore` 的批准路径）把 `models, providers` 作参数传入。
- `lore/citations.ts`：`installCitationNavigation({ resolve, open })`，`App.tsx` 传入 store 操作。
- `agent/docxTools.ts`：格式状态经 `ToolContext` 进来，读 `docs/feature/docx/01-agent-design.md` 再定字段形状（「格式是引用不是参数」那条不变量不能碰）。
- `editor/aiSelection.ts`：`editorView` 作参数传入；如果它本质是 store 的派生读，就搬到 `stores/` 旁边，并在 §7 记一行。

**完成判据。** P0 的 `lib → stores` 上限全部为 0；lore 组、agent 组都消失。

### P4 · store 环

**做什么。**

- 新增 `stores/projectLifecycle.ts`，照 `configImportRefresh.ts` 的做法：一个编排「切换 / 关闭项目」的函数，按顺序调 `agentStore.confirmProjectSwitch`、`projectStore` 的切换、`agentStore.resetChatForProject`。`projectStore` 不再 import `agentStore`，UI 入口改调协调函数。
- `aiTaskStore ↔ batchStore`：`batchStore` 调 `runTask` 时带上 `{ fromBatch: true }`，`aiTaskStore` 不再问 `batchStore.running`。

**完成判据。** project 组、batch 组消失，`ALLOWED_CYCLES` 为空；P0 的动态导入上限按新值下调。`agentStore` / `roleplayStore` 里剩下的动态导入如果不再是为了绕环，改成静态导入。

**风险。** 切换项目的顺序是有讲究的（未保存提示、聊天重置、编辑器清空）。先把现有顺序原样写进协调函数的注释，改完用 `pnpm tauri dev` 手动走一遍：开项目 A → 聊天中切到 B → 取消 → 再切 → 关闭项目。

### P5 · `agentStore` 拆分

**做什么。**

- `applyEdit` … `applyProposal`（§1.4）搬到 `lib/agent/proposalApply.ts`，依赖（项目的 create/move/delete/copy、`refreshFileTree`、编辑器 `saveNow`）以参数对象传入。纯文本变换已经在 `editApply.ts`，这里是它的写盘那一半。
- `runChatJob` 与多会话辅助函数搬到 `stores/agent/chatJob.ts`；读侧选择器（`activeChat`、`useActiveChat`、`chatStateOf` …）搬到 `stores/agent/selectors.ts`。`agentStore.ts` 重新导出这些名字，组件的 import 一行不改。

**需要记下的决定。** `stores/` 现在是一 store 一文件的平铺目录；这一步第一次引入子目录。在 `codemap.md` 的 stores 一节写明：子目录只放**一个 store 的**私有拆分，不放跨 store 的东西。

**完成判据。** `agentStore.ts` < 1500 行；`proposalApply.ts` 有单测覆盖每一种提案。

### P6 · `registry.ts` / `writeTools.ts` 按领域拆分

**做什么。**

- `registry.ts` 的类型搬到 `lib/agent/toolTypes.ts`，`registry.ts` 重新导出，外部 import 暂不动（之后可以逐步改）。
- `REGISTRY` 按领域拆成若干 `Record<ToolId, RegisteredTool>` 片段（读工具、知识库写、手稿提案、文件操作、导出、图像……），`registry.ts` 合并。
- `writeTools.ts` 按现有 16 个分节合成 4–5 个文件（方案门、知识库写、知识库图像、记忆、手稿提案）。

**不变量。** 拆完 `getToolDefinitions(ALL_TOOL_IDS)` 的输出与拆之前逐字节相同——先在拆之前把它存成快照测试，拆完不许改快照。`agentToolBudget.test.ts` 的棘轮不许动。

**完成判据。** 两个文件都 < 1500 行；快照测试不变。

### P7 · 零碎

- `LoreDetail.tsx`、`LoreWall.tsx` 改用 `readImageBytes`。
- `codemap.md` 把每一节的长段落拆成小标题与列表，内容不增不删。单独一个 `docs/` PR。

## 5. 每个 PR 的检查清单

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

- P0 守卫里对应的上限已下调到新的实际值。
- §2 进度行、§3 指标列已更新。
- `codemap.md` 对应一节已同步。
- 涉及 store 或项目切换的阶段（P4、P5）：`pnpm tauri dev` 手动走一遍 §4 写的路径。

## 6. 明确不做

| 事 | 理由 |
|---|---|
| 拆 1000 行以上的组件（`FileTree`、`AiPanel` 等 11 个） | 每个都要逐屏验证，性质和这里的「只改 import 图」不同。等这份方案完成后另立一份 |
| 把 `src/` 根目录的 5 个 `use*.ts` 挪进 `src/hooks/` | 纯搬家，收益小于它在 git blame 里制造的噪音 |
| 引入 madge / dependency-cruiser 进 CI | P0 的测试已经管住了；多一个依赖多一个会漂的版本 |
| 顺手改行为、改文案、修 bug | §0。遇到了记 §7，另开 PR |

## 7. 偏离记录

计划和实际不一致时写在这里：日期、阶段、发生了什么、怎么处理。

| 日期 | 阶段 | 记录 |
|---|---|---|
| 2026-09-19 | P0 | 守卫实测修正两个盘点数字：agent 组 12 个文件而不是 13（`events.ts` 只经注释里的 `import("…")` 示例入组，那不是边）；store 间动态导入 61 处而不是 50（盘点的 grep 按行计数）。§1、§3 已改成实测值。 |
| 2026-09-19 | P1 | 预期之外的收获：`stores/aiStore` 也离开了 agent 组——它只经 `subagent.ts` 被拉进环，拆开后环里只剩 A2 的 6 个文件（`handoff` `packs` `registry` `runtime` `subagent` `toolCost`）。`MAX_PDF_BYTES` / `MAX_PDF_FILES` 也搬进了 `subagentModel`：它们是设置面板要显示的常量，不该让面板为此 import 执行路径。 |
| 2026-09-19 | P2 | 只注入 `runAgent` 解不开整个组：`registry → packs → toolCost → registry` 这条环不经过 runtime——`run_pack` 要用 `messageCeilingForTools` 给子运行定上限，而 `toolCost` 要读 registry 的工具定义。所以注入的是 `ToolContext.subRun: SubRunner`（`run` + `messageCeilingForTools`）而不是单个 `runSubAgent`。字段设为可选而不是方案写的必填：`runAgent` 在它交给工具的上下文上统一填入，调用方一个都不用改；不在运行里调用（只有测试）时，`delegate` / `run_pack` 返回一条说明而不是去找 runtime。写手交接照方案，`runAgent` 作参数传入。结果 agent 组整组消失，不只是静态部分。 |
| 2026-09-19 | P3 | 四个读 AI 配置的文件没有复用 `resolveSubAgent`：它解析的是**连接**（带 key、套上本次对话的芯片开关），而 `imageTools` / `translate` / `asr` 读的是设置里原样的绑定，换成它会改变行为。于是加了 `ToolContext.appState: ToolAppState`（`aiSettings` / `docFormats` / `addImitatedFormat` 三个 getter，store 一侧是 `stores/toolAppState.ts`），`resolveAsrConn` 与 `runIllustration` 改为收参数（`FileTree` 的右键转写直接传 `useAiStore.getState()`）。`imitatedIdFor` / `isSessionImitated` 是纯函数，从 `docFormatStore` 搬进 `lib/docx/presets.ts`。批准插图的路径要 `aiStore`，`agentStore` 于是改为静态 import 它——`aiStore` 本来就不在 agentStore 的环里——原有的 4 处 `await import("./aiStore")` 一并去掉，这本是 P4 的活，提前了。 |
| 2026-09-19 | P4 | 方案漏了一条环：`projectStore ↔ editorStore` 是**双向静态**导入（`editorStore` 写字数、读 `activeFilePath`；`projectStore` 冲刷与重置缓冲区），madge 列的 15 条环里没有单独出现它。拆法：字数 / 字符数从 `projectStore` 搬进 `editorStore`（它本来就是从内容算的，四个组件改订阅）；`closeDocument` 与写作焦点（`WritingFocus` 一族）搬进新文件 `stores/openDocument.ts`，它在两个 store 之上。项目切换照方案走 `stores/projectLifecycle.ts`，但做法是把聊天那两步作为**必填钩子**传进 `projectStore.openProject/closeProject`，而不是在协调函数里重排步骤——这样切换中途的顺序和出错时的回滚（包括 catch 里移出最近项目）一字不变。批处理照方案用 `{ fromBatch: true }`；唯一的差别是一个本来就到不了的窗口：批处理两条子句之间若有人从快捷键另起一个面板任务，原先它会因 `running` 而不出卡片，现在会出。环拆完后把不再为躲环的动态导入改成静态（`roleplayStore`、`aiTaskStore`、`projectStore` 归零），其中三处 fire-and-forget 的 `void import(…).then(…)` 变成同步调用（composer 清空、记忆重载、`rejectAll`），各自改的是另一个 store，先后不可观察。`agentStore` 保留 21 处：目标都会把 `appStore` 带进来，而 `appStore` 加载即写主题到 `document`——静态导入会让十来个 node 测试在加载时就碰 DOM；理由写进了守卫。**手动走查（开项目 A → 聊天中切 B → 取消 → 再切 → 关闭）在这个环境里做不了**（Tauri 窗口无法自动驱动），留给合并前手动确认。 |
| 2026-09-19 | P5 | 照方案拆，另加一个文件：只搬 `proposalApply` / `chatJob` / 选择器，`agentStore` 仍有约 1850 行，于是把约 480 行的类型也搬进 `stores/agent/types.ts`，落到 1272 行。两个订阅 store 的钩子（`useActiveChat`、`useChatStateInputs`）留在 `agentStore`，因为 `selectors` 若 import store 就会与它成环；`chatSurface` 放在 `chatJob` 而不是 `selectors`，理由相同（两者互相要对方的一个函数）。`chatSystemPrompt` 只有聊天运行用，随 `chatJob` 走；`currentTime.test.ts` 登记的「聊天面」因此从 `agentStore.ts` 改为 `stores/agent/chatJob.ts`——打时间戳的代码搬了家，守卫跟着搬。`proposalApply` 的依赖由 `agentStore` 的 `proposalApplyDeps()` 一次 `await import("./projectStore")` 组装，原来五个 apply 函数各自一次，store 间动态导入因此从 21 降到 17（`agentStore` 13 + `chatJob` 4）。 |
| 2026-09-19 | P6 | 快照先于拆分单独提交（`toolDefinitionsSnapshot.test.ts`：声明顺序、两种目录下的全部定义、驻留 / 延迟划分），拆完逐字节不变。`REGISTRY` 按**连续**的键段切成十个片段再按原顺序展开，而不是按领域重排——`allSearchable` / `partitionByGroup` 的输出跟着键序走，重排会改线上字节；代价是删除章节 / 目录的两个工具单成一个片段（它们在线上排在图像工具之后）。`writeTools.ts` 拆成 `write/` 下五个模块加一个 `shared.ts`：跨节共用的 `relocateInSnapshot` / `withAlias` 与提案计数器若留在原节，会让 `loreFiles ↔ loreAssets`、`planGate ↔ manuscript` 互相 import；计数器从模块级 `let` 改成 `nextProposalSeq()`，仍是同一个计数器。`pptxLint.test.ts` 读 `export_pptx` 描述的源码路径随之改到 `toolTable/exports.ts`。**指标「最大源文件 < 1500」按原意只覆盖本方案的三个大文件**（现为 `loreFiles` 1418、`manuscript` 1400、`agentStore` 1272）；仓库里仍超过 1500 行的 `profile/model.ts`（多为能力包数据）、`roleplayStore`、`runtime`、`tools.ts`、`ai/image.ts` 与 §6 排除的组件不在本方案范围，另立。 |
| 2026-09-19 | P7 | `codemap.md` 里 20 个超过 1500 字的段落拆成 `####` 小标题 + 列表。「内容不增不删」由脚本验：去掉小标题行、列表标记、空白与分隔标点（，；、：。* -）之后，新旧逐字相同——20 段全部通过，小标题是唯一新增的文字。单行最长从 8935 字降到约 1000 字（剩下的是原本就不可再切的单句）。 |

## 8. 复现 §1 的数字

循环（值导入，交叉核对 P0 的结果用；`.madgerc` 用完删掉，不提交）：

```bash
echo '{"detectiveOptions":{"ts":{"skipTypeImports":true},"tsx":{"skipTypeImports":true}}}' > .madgerc
npx --yes madge@8 --circular --extensions ts,tsx --ts-config tsconfig.json src
rm .madgerc
```

store 间动态导入（按次数，不按行）：

```bash
grep -oE 'import\("\./[a-zA-Z]+Store"\)' src/stores/*.ts | cut -d: -f1 | sort | uniq -c
```

权威数字以 `src/lib/__tests__/layering.test.ts` 为准——它去掉注释再解析。
