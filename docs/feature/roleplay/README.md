# 互动式角色扮演创作

> **状态：已实现**（Beta 开关后面，Settings → 通用 → 实验功能），含角色记忆。
> UI 设计稿：claude.ai/design 的 `08 扮演 Roleplay.dc.html`（TURN 1，1a–1i 九屏）；
> 记事本面板设计稿里没有，是按现有视觉语言自己定的，理由见
> [05-implementation-notes.md](05-implementation-notes.md)。

让作者以第一人称走进自己写的设定里，和笔下的角色直接对话。每个角色有自己的长期记忆（约定 / 待办 / 事件 / 关系），聊多久都不会忘；再由一个能看见全场的「旁白」和作者讨论故事、把精彩的互动梳理成正文。

## 文档

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| [01-overview.md](01-overview.md) | 概要设计：是什么 / 不是什么、**三条不变量**、架构总览、磁盘布局、五个决策、被否掉的五个方案 | 动手前必读 |
| [02-design.md](02-design.md) | 详细设计：模块清单、数据模型、transcript 格式、上下文装配、preset、旁白工具、并发、测试点 | 写代码时对照 |
| [03-plan.md](03-plan.md) | 执行方案：6 个 PR 的切分、逐条验收标准、风险清单、回归重点 | 排期和 review 时 |
| [04-ui-brief.md](04-ui-brief.md) | 给 Claude Design 的自包含设计任务书 | 做 UI 时 |
| [05-implementation-notes.md](05-implementation-notes.md) | **实现记录**：这一轮做了什么、与设计的差异、新增令牌、验证到哪一步 | 接着往下做之前 |
| [06-scene-and-memory-area.md](06-scene-and-memory-area.md) | 转场与记忆区：为什么不需要「场」这根轴、沉降规则、前情摘要由角色自己写 | 改转场 / `lib/roleplay/area.ts` 前 |
| [07-area-ui-brief.md](07-area-ui-brief.md) | TURN 2 的 UI 任务书（转场与记忆区），自包含 | 做记忆区 UI 时 |
| [08-verification-checklist.md](08-verification-checklist.md) | 给作者试用的验证清单——**问法比条目重要** | 交给作者试之前 |
| [09-runjob-refactor-lld.md](09-runjob-refactor-lld.md) | `runJob` 的历史准备路径抽进 `lib/roleplay/run.ts`：只动形状，不动行为 | 改 `runJob` 的排序前 |
| [10-memory-system.html](10-memory-system.html) | **记忆系统全景图**（浏览器打开）：五张图讲清哪三块永不出上下文、压缩在什么时刻按什么阈值触发、角色私有记忆的四个刷新时刻、转场沉降与记忆区检索 | 想一次看懂记忆系统时；改 `context.ts` / `memory.ts` / `compact.ts` 之前 |
| [11-lore-binding-lld.md](11-lore-binding-lld.md) | **绑定与自动注入的粒度**（`partial`，PR-1~3 已实现，只剩 UI 与花名册迁移）：主角条目正文常驻、勾中的特征常驻、**其余照常自动注入**——账本下沉到特征级、`selectLore` 的 `coreDone` / `excludeFacets`、四片 PR 与逐条验收 | 改绑定语义、`selectLore` 的入参、或 `lib/agent/compact.ts` 的注入账本之前 |

## 一分钟版本

**能复用的**：agent 运行时（`runAgent` 只吃 `messages + preset + toolContext + 回调`，完全解耦）、lore 命中与钉住（`selectLore` 的 pinned/auto 两条路本来就是一个函数的两个入参）、会话序列化、折叠压缩、`@` 注入、审批卡、执行日志。**`lib/agent/*` 一行不改。**

**要新建的**：`lib/roleplay/`（领域逻辑）、`stores/roleplayStore.ts`（多会话 + 并发闸）、`components/roleplay/`（UI）、registry 里 3 个记忆工具 + 5 个只读 scene 工具。约 4650 行。

**四条不变量**（违反任何一条，功能就退化成聊久了会失忆的玩具）：

1. **`transcript.md` 是资产，wire history 是缓存。** 前者只追加、永不删；后者可压缩、可丢、可从前者重建。
2. **绑定内容和记忆块进 prelude 的独立消息，永不进 seed 块。** `buildCompactedHistory` 只丢 `seedContext` 和旧 summary，`trimHistory` 只动 tool 结果和图片——所以放对位置就永久存活，**不需要给压缩加白名单**（已核对代码确认）。
3. **旁白读的是别人的 transcript / memory，永远不是别人的 wire history。** 隔离是结构性的，不靠 prompt 约定：扮演 agent 的工具集里根本没有 scene 工具。
4. **记忆是记录，不是摘要。** 摘要有损、会被再压缩，回答「之前大致发生了什么」；记忆只增改不删、恒在 prelude，回答「现在有哪些还在生效的约定 / 待办 / 关系」。一条约定被折进摘要，三轮后就变成「他们聊了一些计划」。

## 五个已定的决策

| # | 决策 |
|---|---|
| 1 | 旁白用**工具式**读取（列表 / 按轮号读 / 全文检索 / 读摘要），不用注入式 |
| 2 | 落盘 `.ai-writer/roleplay/`，**不用 `chat_sessions` 表**（那张表只保留最新 5 个会话，会吃掉作者的创作） |
| 3 | 「把对话写进正文」**复用现有的 `create_chapter` / `append_file` / `propose_edit`**，不新建写工具 |
| 4 | 并发上限 3，实现为信号量而非硬编码分支 |
| 5 | 每个 agent 独立选 / 切模型；子代理（识图、联网）沿用全局设置——但有个 `routeTools` 的坑，见 02-design §8 |
| 6 | 记忆的注入块**只在四个时刻刷新**（播种 / 压缩后 / 恢复 / 作者手动），绝不在写入的当下刷新——见 02-design §5.5 |
