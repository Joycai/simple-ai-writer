# 互动式角色扮演创作 — 执行方案

> 前置：[01-overview.md](01-overview.md)（不变量）、[02-design.md](02-design.md)（怎么做）。

## 分支与 PR 策略

仓库不做 stacked PR（CI 只在 to-`main` 的 PR 上跑）。所以每个 PR 都从 `main` 切、独立开、独立合，**功能整体藏在 Beta 开关后面**——开关默认关，未完成的部分对作者不可见，这样中间态合进 `main` 是安全的。

开关在 PR1 就落地并默认关闭，PR7 才在文档里宣布可用。

---

## PR1 — 地基：开关、存储、花名册

**做什么**
- `lib/roleplay/flag.ts`（照抄 `lib/pptx/flag.ts`）+ `PREF_KEYS` 加 `app:roleplayBeta`
- `lib/roleplay/model.ts` 类型
- `lib/roleplay/store.ts`：`.ai-writer/roleplay/` 的建目录、花名册读写、人设卡读写、`agentId` 生成与校验
- `lib/roleplay/transcript.ts`：追加、解析、切片、检索（**这个 PR 就要带测试**）
- `lib/roleplay/memory.ts`：记忆的解析 / 增改 / 渲染注入块（**同样这个 PR 就带测试**——它是纯函数，比 UI 早写完没有代价）
- `stores/roleplayStore.ts`：只有花名册的增删改查，没有对话
- `AiDrawerMode` 加 `"roleplay"`；`AiDrawer` 第四个 tab（开关关时不渲染）
- `RoleplayPanel` 骨架 + `AgentComposer`（能建 / 改 / 删 agent，能绑条目、选模型、写人设卡）
- Settings → 通用 → 实验功能 的开关

**验收**：开开关 → 建一个绑定了某人物的扮演 agent → 磁盘上出现正确的目录结构 → 重启应用后花名册还在、顺序不变 → 关开关，tab 消失、数据不动。**还不能对话。**

**测试**：`transcript.test.ts` 全部；`memory.test.ts` 全部；`store.test.ts` 的花名册重建与 id 校验。

**规模**：约 1200 行。

---

## PR2 — 单个扮演 agent 跑通（本功能的技术核心）

**做什么**
- `lib/roleplay/presets.ts` 的 `ROLEPLAY_PRESET`
- `lib/roleplay/context.ts` 的 `seedRoleplayHistory` + 逐轮注入（记忆块占 `[2]`，但本 PR 里它恒为空——记忆工具在 PR3）
- `ai.instructions.roleplay` / `roleplaySyntax` 两个 i18n 键（中英）
- `roleplayStore` 接上 `runAgent`：发送、流式、落 transcript、落 `session.json`、`persistUsage`
- `RoleplayChat`：气泡、流式、停止、执行日志（复用 `AgentLog`）、语法提示条
- 作者身份设置（`AuthorPersona` 三种模式）
- 绑定过期提示 + 刷新（§4.3）

**验收（逐条勾）**
1. 和角色说话，它以第一人称回应，语气符合绑定条目。
2. 说到一个**没绑定**的词条名，`selectLore` 自动命中并注入（在执行日志里看得到）。
3. **聊到触发压缩之后，角色仍然记得自己的人设**——这是不变量二的人工验收，必须真的聊到压缩触发，不能只看单测。
4. 关掉应用重开，对话历史还在；把 `session.json` 删掉重开，对话仍在（从 transcript 重建）。
5. 单开一个 agent 时，对话助手 tab 的行为完全没变。

**测试**：`context.test.ts` 全部，尤其是「跑一次 `buildCompactedHistory` 后绑定块仍在」那条。

**规模**：约 1000 行。**风险最高的 PR，建议单独合、合完自己用两天再往下走。**

---

## PR3 — 角色记忆

**做什么**
- `lib/roleplay/memoryTools.ts`：`remember` / `revise_memory` / `recall` 三个工具处理器
- `registry.ts` 注册这三个，`ToolContext` 加 `agentMemory?`
- `ROLEPLAY_PRESET` 加上这三个工具，`maxRounds` 4 → 5
- `ai.instructions.roleplayMemory`（记忆纪律：什么时候该记、什么时候**不**该记）
- **记忆块的四时刻刷新**（详细设计 §5.5），尤其是压缩之后那一次
- `MemoryPanel`：按 kind 分组、状态切换、作者可增删改、点一条跳回记下时的那一轮
- 对话里 `remember` 发生时的内联轻提示

**验收（逐条勾）**
1. 和角色约定一件事，它调 `remember` 记下来；`memory.md` 里出现正确的记录。
2. **聊到触发压缩之后，问它「我们之前说好了什么」，它答得出来**——这是不变量四的人工验收，必须真的聊到压缩触发。
3. 兑现那个约定，它调 `revise_memory` 标记 `done`；作废的记录仍在文件里，正文没丢。
4. 作者在记忆面板里手改一条 → 点刷新 → 角色下一轮就按新的说。
5. 关掉应用、手改 `memory.md`、重开 → 新内容生效（恢复时刷新）。
6. **负向验收**：让它随便聊十轮家常，不该冒出十条记忆。如果冒出来了，是 `ai.instructions.roleplayMemory` 的「不该记」写得不够狠，回去改提示词而不是改代码。

**规模**：约 700 行。

**这个 PR 是「扮演」和「聊天玩具」的分界线。** 没有它，角色只是聊得像；有了它，角色能持有承诺。

---

## PR4 — 多 agent 并发

**做什么**
- `roleplayStore` 的信号量 + FIFO 队列（`MAX_CONCURRENT_RUNS = 3`）
- 每 agent 独立 `AbortController`、独立 usage、独立模型
- 花名册上的运行中 / 排队中 / 有新回复指示
- 切换 agent 时保持后台运行
- 自动批准的 key 改用 controller（§8）

**验收**：同时向 3 个角色发消息，三条流各自独立推进，互不串台；第 4 个进队列；切走的 agent 跑完后花名册上有提示；停止只停一个。**关键的负向验收：角色 A 绝不知道角色 B 的存在**——直接问它「你认识 B 吗」，它只能从知识库知道，不能从对话记录知道。

**测试**：`concurrency.test.ts` 全部。

**规模**：约 500 行。

---

## PR5 — 旁白 agent

**做什么**
- `lib/roleplay/sceneTools.ts` + `SceneReader`
- `registry.ts` 注册 5 个 scene 工具（含 `read_scene_memory`），`ToolContext` 加 `scenes?`
- `NARRATOR_PRESET`、`ai.instructions.narrator`
- `lib/roleplay/summary.ts` 滚动摘要（每 N 轮或压缩时更新）
- 审批卡在扮演面板里的渲染（复用 `ApprovalCard`）
- 旁白把场景梳理成正文写进稿子（复用 `create_chapter` / `append_file` / `propose_edit`）

**验收**：建一个旁白 → 它能列出所有场景、读某一段、检索很早以前的一句话 → **问它「艾尔登现在还欠着什么承诺」，它先调 `read_scene_memory` 而不是把整段 transcript 拉进来** → 讨论故事走向时引用得出具体的轮次 → 让它「把刚才那段整理成一节」，弹出审批卡，批准后正文里出现该节。**负向验收：扮演 agent 的工具列表里没有任何 scene 工具**（单测已覆盖，但手工再确认一次工具面板）。

**规模**：约 800 行。

---

## PR6 — 打磨

- `@` 引用接进扮演 composer（复用 `chatRefs`）
- 上下文条（复用 `contextBreakdown`）
- 导出一个场景为 markdown
- 删除 agent 的二次确认 + 目录移入 `.ai-writer/backups`（与删条目一致，可恢复）
- 空态、错误态、键盘快捷键
- 系统通知接入（`lib/notify.ts`）：后台 agent 跑完时提醒——**注意 `notify.ts` 的约束是绝不携带模型正文**，所以通知内容只能是「艾尔登回复了」

**规模**：约 400 行。

---

## PR7 — 文档与收尾

- `CLAUDE.md` 加目录地图与 Detailed References 条目
- 本目录的三份文档更新为「已实现」，把实现过程中改掉的决定写回去（这一步不能省——决定要记在文档里，且要带理由）
- README 提一句 Beta 功能

---

## 总量与顺序

| PR | 规模 | 可独立发布 |
|---|---|---|
| 1 地基 | ~1200 行 | 是（开关关着） |
| 2 单 agent | ~1000 行 | 是（自己能用了） |
| 3 记忆 | ~700 行 | 是（**功能真正立住**） |
| 4 并发 | ~500 行 | 是 |
| 5 旁白 | ~850 行 | 是（功能完整） |
| 6 打磨 | ~400 行 | 是 |
| 7 文档 | — | 是 |

合计约 **4650 行**，其中测试约 500 行。

**建议在 PR3 之后停下来实际用几天**再决定 PR4/PR5 的优先级。PR2 结束时角色只是「聊得像」，PR3 结束时它才「能持有承诺」——那才是这个功能真正的样子，也才谈得上判断「和一个角色深聊」和「同时开三个」哪个更值得先做好。

## 风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| **不变量二被破坏**（绑定块被塞进 seed 块） | 聊久了角色失忆，且症状要几十轮后才出现，极难归因 | PR2 的单测直接跑一次真实的 `buildCompactedHistory` 断言绑定块还在；PR2 验收第 3 条必须人工跑到压缩触发 |
| **不变量三被破坏**（扮演 agent 拿到 scene 工具） | 记忆隔离失效，功能的前提没了 | preset 的工具集写死 + 单测断言；`ToolContext.scenes` 只在旁白的 run 里注入 |
| 并发三个跑贵模型，成本失控 | 账单 | `persistUsage` 的 `task` 字段区分开，用量页能看见；花名册上显示本会话累计 |
| task workspace 被 `MAX_SAVED_TASKS` 清理 | 旁白的笔记丢 | 已接受（§8）——资产是 transcript 和 memory.md，都不在 `tasks/` 下 |
| 作者手改 transcript / memory.md 改坏 | 解析异常 | 容错解析，永不抛（§3.2、§5.3）+ 单测 |
| **记忆块刷新时机写错**（写入即刷新） | 每记一件事作废一次 prompt 缓存前缀，长会话成本翻倍，且不会报错——只会账单变贵 | 详细设计 §5.5 写死了四个时刻；code review 时专门看这一处 |
| **模型滥记忆** | 注入块被噪音塞满，真正的约定被挤出预算 | `ai.instructions.roleplayMemory` 的「不该记」条款 + PR3 验收第 6 条；注入块按 kind 优先级排序，pact/todo 先进 |
| 扮演内容触发模型自我审查 | 角色出戏、拒演 | `ai.instructions.roleplay` 自带创作主权条款；换模型是 per-agent 的，作者可以给难演的角色配别的模型 |
| 新 tab 挤占 AiDrawer 的横向空间 | 四个 tab 在窄屏下换行 | UI 设计时明确处理（见 04-ui-brief） |

## 与既有代码的接触面（回归重点）

改动虽然是加法，但这几处要在 review 时特别看：

- `registry.ts` 的 `ToolId` 联合类型加了成员 → `Record<ToolId, RegisteredTool>` 是全量映射，漏一个不会编译，安全。
- `ToolContext` 加可选字段 → 不影响既有调用方。
- `appStore.AiDrawerMode` 加成员 → `storedAiDrawerMode()`（`appStore.ts:118`）要能处理旧 pref 值，且**开关关掉时存着 `"roleplay"` 的 pref 必须降级回 `"generate"`**，否则关开关后抽屉打开是空白。这是个真会踩的坑。
- `AiDrawer` 的 header 逻辑里有若干 `aiDrawerMode === "chat"` 的分支（历史会话、新建会话、任务按钮），加第四个 mode 时要确认这些分支的 else 分支行为正确。
