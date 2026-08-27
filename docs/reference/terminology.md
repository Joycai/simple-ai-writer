# 词表与措辞校准

> 状态：第 1–3 节 `living`（今天要遵守的取词规则和词表，写任何面向作者的字符串之前读它）；第 4 节 `shipped`（**六批全部落地**）；第 5 节 `shipped`（`src/lib/__tests__/localeTerms.test.ts`，`ai.instructions.` 的豁免已随批次 F 撤除）。
>
> 起因：2026-08 对全量文案做了一次盘点——`en.json` / `zh-CN.json` 共 2775 个键，加上 `lib/profile/model.ts` 的能力包 / 分类 / 特征槽位、`lib/agent/subagent.ts` 的子代理种类。机械比对短标签（≤20 字符、不含插值）后发现 **78 处一词多译**、**49 处一译多词**。本文档是那次盘点的结论 + 收敛计划。
>
> 中英对照全表（含每个词的出处）在 <https://claude.ai/code/artifact/98e7fecb-de17-4385-ac39-0c400db4eaa7>。

## 1. 这份文档要解决的是什么

不是「翻译不准」。逐条看，几乎每个中文词单独拿出来都是对的——问题在**同一个东西有几个名字**，以及**几个不同的东西共用一个名字**。前者让作者以为功能不止一个，后者让作者以为两个功能是一回事。

三个最贵的例子：

- 知识库里的一条，在应用里同时叫 **条目**、**词条**、**设定**。`appTerms.entry` 明明已经把它定死成「条目」了。
- 同一份 story memory，AI 面板叫**前情记忆**、文库按钮叫**前情摘要**、用量页叫**前情提要**、上下文分配条叫**前情**。四个名字，一个功能。
- **工作台**同时是设置页签（能力包配置）、文档树视图、系统提示词里的整个应用；旁边还有个「任务工作区」。**工作流**同时是对话流程指引卡和 ComfyUI 节点图，而且都在设置页里。

CLAUDE.md 里已经写了这条纪律的一半——「UI 词汇是应用级且统一的（文档/分组/知识库/条目）」「绝不在组件或 i18n 值里写死 章/卷/设定」。第 4 节要做的就是把剩下那一半补齐：规则在，但文案没跟上。

## 2. 六条取词规则

只落一件事就落这个。规则按「哪个词赢」写，不按「哪个词错」写。

| # | 规则 | 取 | 弃 |
|---|---|---|---|
| 1 | 知识存储只有一个名字 | 知识库 · 条目 · 主条目 | 设定、词条、Lore（代码里 `lore` 不动） |
| 2 | 前情类四个词各管一件事 | 前情提要（故事记忆）· 概要（条目 frontmatter）· 历史摘要（对话压缩产物）· 总结（任务名） | 前情记忆、前情摘要 |
| 3 | 要作者点头的叫方案，模型自列的叫计划 | 方案 · 计划 | 两者混用 |
| 4 | 「工作流」让给 ComfyUI | 工作流卡（流程指引）· 工作流（ComfyUI 节点图） | 流程卡也叫「工作流」 |
| 5 | 主体一律「助手」，被委托的一律「子代理」 | 助手 · 子代理 · 写手 · 角色（扮演里的 agent） | 代理、Agent 助手、工作台 Agent、未翻译的 agent |
| 6 | 图片不叫图像 | 图片 · 生成图片 · 配图 · 图集 | 图像生成、生成插图、修改插图 |

规则 4 有一处口径修正：盘点时提的是「流程卡改叫流程卡」，但代码和设计文档里它**本来就叫工作流卡**（`lib/workflow/builtins.ts` 的注释、`docs/feature/agent/workflow-cards-plan.md`）。所以正确的动作不是发明新词，是把 UI 上掉了的那个「卡」字补回去——UI 与代码同时收敛，成本还更低。

规则 5 的「角色」是新提的：扮演里的 `agent` 现在**根本没翻译**（「新建 agent」「搜索 agent」）。它有两种类型——扮演（character）和旁白（narrator）——「角色」能同时罩住这两个，不与「子代理」冲突。

## 3. 词表（取哪个词）

只列会分歧的部分。全表见文首链接。

### 知识库

| 概念 | 英文 | 中文 |
|---|---|---|
| 知识库整体 | Knowledge Base | 知识库 |
| 一条记录 | entry / entries | 条目 |
| 条目的 `index.md` | **Headword** | **主条目** |
| frontmatter 的一句话 | Summary | 概要 |
| 子粒度 | Facet | 特征 |
| 一根轴：住在哪 | Category | 分类 |
| 另一根轴：属于哪本 | Collection | 集合 |
| 自动检索的围栏 | Scope · scope fence | 取材范围 · 取材围栏 |
| 分类的类型 schema | Slot | 槽位 |
| 词典条目的一对词 | pair | **词对**（不是「词条」） |

`Headword / 主条目` 是这一节唯一的新词。现在英文侧同一个东西有三种写法——`lore.detail.colIndex` 写 `Entry`、`lore.meta.*` 写 `Headword`、`roleplay.composer.core` 写 `Core card`——中文侧统一是「主词条」。取 Headword/主条目：`Entry` 会和条目本身撞，`Core card` 是扮演面板独有的说法。

### 前情类

| 概念 | 英文 | 中文 |
|---|---|---|
| 长文档的故事记忆 | Story memory · Recap | 前情提要（紧凑处缩「前情」） |
| 条目 frontmatter 的摘要 | Summary | 概要 |
| 对话历史压缩的产物 | Summary（日志里） | 历史摘要 |
| 任务名 | Summary | 总结 |
| 文库按分组生成的 | Group digest | 分组摘要 |
| 扮演转场留下的 | Recap | 前情 |

### Agent 相关

| 概念 | 英文 | 中文 |
|---|---|---|
| 对话主体 | Assistant | 助手 / 对话助手 |
| AiPanel 的模式名 | Agent mode | Agent 模式（保留英文，它是模式名不是主体名） |
| 被委托的专用模型 | Subagent | 子代理 |
| 收尾成文的那个 | Writer | 写手 |
| 扮演里的一个人 | agent → **character / narrator** | **角色**（扮演 / 旁白） |
| 要作者点头的那张卡 | Plan | 方案 |
| 模型自己列的步骤 | Plan | 计划 |
| 一次运行的平行结果 | Draft | 版本（单位「版」） |
| 未定稿的内容 | draft | 草稿 |

### 其他分歧位

| 英文 | 取 | 说明 |
|---|---|---|
| Thinking（折叠区标题） | 思考过程 | 弃「思维链」——那是模型侧行话。**只退 UI**：`docs/api/` 里 chain-of-thought 照旧叫思维链，那是协议域的正确译法 |
| Thinking…（进行时） | 思考中… | 弃「正在思考」 |
| Prompt（模板 / 配置层） | Prompt | 既成事实，17 处，保留英文 |
| prompt（发给模型的文本） | 提示词 | 于是「系统提示」→「系统提示词」 |
| Style | 文风 | 小说包分类 `style` 现在是「风格」，与「文风锚点」对不上 |
| Tone（跑团包） | 基调 | 与 Style 是两个词，刻意的，不动 |
| Recent（模型筛选） | 最近用过 | 现在是「常用」，和 Frequent 撞 |
| Headlines（文案包任务） | 广告语 | 现在和公众号包的 Titles 中文都叫「标题」 |
| Titles（公众号包任务） | 拟标题 | 同上 |
| Body text（编辑器段落样式） | 正文段落 | 弃裸「正文」——它同时是 body / content / prose / Manuscript |
| prose（写手的产出） | 成稿 | 同上 |

## 4. 校准批次

六批，按「改一处的爆炸半径」从小到大排。每批都是一个独立 PR，互不依赖，可以任意顺序落。

**每一批要改三个地方。** 前两个是文案的两份副本：`zh-CN.json` / `en.json`，以及组件里 **845 处硬编码中文 `defaultValue`**（`t("key", { defaultValue: "…" })`）。`defaultValue` 只在键缺失时才渲染，而 `localeParity.test.ts` 保证键不缺——所以它是**休眠的第二份副本**：改了 JSON 不改它，退役词就活在源码里，下一个人照着抄。批次 A 实测里它已经漂过一次：`RoleplayChat.tsx` 的 `roleplay.stale.body` 兜底写的是「绑定的设定被改过」，JSON 里却是「设定被改过（绑定条目、人设或身份）」——两句话，一个键。

第三个是**代码注释**，A 做完才发现它必须进批次：改完 UI 的「主词条 → 主条目」，注释里还留着 20 处旧词，下一个人照着注释写新文案就退回去了。第 5 节的护栏测试扫前两处（注释太容易误伤），注释靠批次自己扫干净。

### 批次 A —— 知识库的名字 ✅ 已落地

`设定` 34 键（含 `ai.instructions.*` 10 键，见批次 F）、`词条` 14 键。落地实测：i18n 41 处（zh 32 / en 10，含删两个死键）、组件 `defaultValue` 21 处、代码注释 20 处、文档 20 处。`pnpm tsc --noEmit` 0 错，`pnpm test` 190 文件 / 2603 用例全绿。

设定 → 知识库 / 条目：

| 键 | 现在 | 改成 |
|---|---|---|
| `ai.bubble.extractLore` | Extract as lore / 提取为设定 | Extract as an entry / 提取为条目 |
| ~~`editorStrip.refs`~~ | `{{n}} lore refs` / 引用 {{n}} 设定 | **删除**——落地时才查出它和 `ai.tasks.lore` 一样没有调用点（`EditorBottomStrip` 直接渲染 `refsCount` 数字）。删掉比改写一个没人渲染的串好 |
| `lore.improve.atHint` | 引用其他设定条目 | 引用其他条目 |
| `lore.newEntry.aiHint` | 从手稿或描述中提取设定 | 从手稿或描述中提取条目 |
| `ai.writer.intro1a` | 助手照常读文件、查设定、思考 | …查知识库、思考 |
| `sync.freshBody` / `emptyLocalBody` / `emptyRemoteBody` | {{n}} 条设定 | {{n}} 条知识库条目 |
| `roleplay.section.bound` | Bound setting / 绑定设定 | Bound entries / 绑定条目 |
| `roleplay.section.boundNone` | …需要设定时用 `read_lore_entity` 去读 | …需要资料时用 `read_lore_entity` 去读 |
| `roleplay.band.bound` | 绑定 {{n}} 项设定 | 绑定 {{n}} 条条目 |
| `roleplay.band.boundList` | 本次对话注入的设定 · {{n}} | 本次对话注入的条目 · {{n}} |
| `roleplay.band.boundNone` | 没有绑定任何设定 | 没有绑定任何条目 |
| `roleplay.chatEmpty.body` | 你绑给 TA 的 {{n}} 项设定 | …{{n}} 条条目 |
| `roleplay.composer.addLore` | entry / 设定 | entry / 条目 |
| `roleplay.composer.boundEmpty` | 没有绑定任何设定——角色只会知道主词条里写的东西 | …任何条目——…主条目里写的东西 |

**「设定」的三处不是知识库，单独判**，别一把 sed 过去：

- `systemSettings.maintenance.staleHint` 结尾「文档、知识库和设定都在文件系统上」——英文原文是 *settings*，这是**翻译 bug**，应作「设置」。
- `roleplay.persona.none`「不设定」、`roleplay.persona.narratorNote`「无身份设定」——动词，不动。
- `roleplay.roster.stale`「设定已更新」、`roleplay.stale.body`「设定被改过（绑定条目、人设或身份）」、`roleplay.stale.refresh`「刷新设定」——这里的「设定」覆盖的是 system 层的全部输入（角色名 / 主角条目正文 / 扮演指令 / 作者身份），比「条目」大。已按 **「绑定内容」** 落地（绑定内容已更新 / 绑定内容被改过（条目、人设或身份）/ 刷新绑定），英文侧同步 `setting updated` → `binding updated`、`A setting changed` → `A binding changed`。
- `roleplay.empty.body`「他按自己的设定回你」——散文，读起来自然。改不改都行，倾向不动。

词条 → 条目（全部机械替换，无例外）：`lore.detail.colIndex`、`lore.generator.stepExtract`、`lore.facet.modeAutoHint`、`lore.facet.modeAlwaysHint`、`lore.improve.targetIndex`、`lore.meta.title` / `currentLabel` / `stepRead` / `footerNote`、`lore.aiHub.improveDesc`、`roleplay.composer.bound` / `core` / `boundEmpty`。

一个例外：`lore.dict.applyNeedsEntries`「没有可解析的词条」——这里的「词条」是**翻译词典的词对**，不是知识库条目。英文原文就是 *pairs*。改成「词对」，正好把「词条」这个词彻底腾空。落地时把这条推到了 `lib/translate/`：`glossary.ts` / `tool.ts` / `run.ts` 和工作流卡里的 9 处「词条」一并改成「词对」，于是**全代码库「词条」归零**——留一半反而更难分辨哪个是哪个意思。

英文侧同批修：`lore.detail.colIndex` 的 `Entry · index.md` → `Headword · index.md`；`roleplay.composer.core` 的 `Core card (index.md)` → `Headword (index.md)`。

顺手清死键：**`ai.tasks.lore`（Lore extraction / 设定提取）和 `editorStrip.refs` 全代码库无人引用**，两个都删了——`ai.tasks.extract`（提取入库）才是活的那个。同类的 `editorStrip.cumulative` 也没有调用点，但它不含退役词，留给别的清理去处理。

**留在原地的三处「设定」**（都不是知识库义）：`roleplay.persona.none`「不设定」、`roleplay.persona.narratorNote`「无身份设定」是动词；`roleplay.empty.body`「他按自己的设定回你」是散文，中文读起来自然。

### 批次 B —— 前情四词分工 ✅ 已落地

| 键 | 现在 | 改成 |
|---|---|---|
| `ai.memory.title` | Story Memory / 前情记忆 | 前情提要 |
| `ai.memory.hintCreate` / `hintUpdate` / `docTooShort` / `upToDate` | 前情记忆 | 前情提要 |
| `library.memoGenerate` / `memoUpdate` | 生成 / 更新前情摘要 | 生成 / 更新前情提要 |
| `library.summaryModelHint` | 用于生成前情摘要的模型 | 用于生成前情提要的模型 |
| `ai.memory.systemPrompt` | 你是前情摘要助手 | 你是前情提要助手 |

扮演侧的 recap 同批归位：`lib/roleplay/recap.ts` 及其测试、`writer-subagent-plan.md` 里的「转场前情摘要」按 §3 词表改成 **前情**（它不是 story memory）。

不动：`systemSettings.usage.kinds.memory`（已经是「前情提要」）、`ai.panel.allocMemory`（「前情」是紧凑位的合法缩写）、`lore.detail.fieldSummary`（概要）、`ai.agent.log.detailSummary`（历史摘要）、`ai.tasks.summary`（总结）、`systemSettings.usage.kinds.digest`（分组摘要）。

### 批次 C —— 撞车词 ✅ 已落地

**工作台**（8 键，2 个在 `ai.instructions.*` 见批次 F）：

| 键 | 现在 | 改成 |
|---|---|---|
| `systemSettings.tabs.workspace` | Workspace / 工作台 | 不动——设置页签保留「工作台」 |
| `systemSettings.shortcuts.items.viewFiles` | Go to Files (workbench) / 切换到文档树（工作台） | Go to Files / 切换到文档树 |
| `ai.errors.taskNotFound` | 当前工作台没有「{{task}}」这个任务 | 当前启用的能力包里没有「{{task}}」这个任务 |
| `lore.transfer.sourceProfile` | source workspace / 来源工作台 | source packs / 来源能力包 |
| `systemSettings.projectBackup.hint` | …知识库、工作台类型、大纲顺序… | …知识库、能力包配置、大纲顺序… |

`ai.taskWorkspace.*`（任务工作区）不动——「区」和「台」区分得开，且它是一个真实存在的磁盘目录。

**工作流 → 工作流卡**（`systemSettings.workflows.*`，5 个面向作者的键）：`section`（Workflows → Workflow cards / 工作流卡）、`newCard`（+ New workflow → + New card / + 新建工作流卡）、`hint`、`enableCard` / `disableCard` 的插值文案。`aiConfig.models.comfy*` 的 9 个「工作流」**全部不动**——那是作者从 ComfyUI 里导出的东西，名字不归我们管。

**正文**：`editor.toolbar.paragraph`（Body text / 正文 → 正文段落）、`ai.writer.kind.prose` 与 `ai.agent.log.handoffKind.prose`（prose / 正文 → 成稿）。

**标题**：`ai.tasks.headlines`（Headlines / 标题 → 广告语）、`ai.tasks.titles`（Titles / 标题 → 拟标题）。两个任务能同时出现在启用了文案 + 公众号的项目里，现在菜单上会并排两个「标题」。

**方案 / 计划**：现状已经基本正确（`ai.plan.*` 是方案、`ai.chat.planMode` 是计划模式、`task_plan` 是拟定任务计划），本批只把这条界线写进本文档，代码不动。

### 批次 D —— 英文侧的歧义 ✅ 已落地

中文分得清、英文糊在一起的地方。改英文比改中文安全，因为中文用户看不到。

| 键 | 现在 | 改成 |
|---|---|---|
| `ai.tasks.continue` | Continue | Continue writing |
| `roleplay.transition.continue` | Continue | Continue the scene |
| `systemSettings.subagents.writerScopeLabel` | SCOPE | APPLIES TO |
| `lore.split.groupPlaceholder` | group | exclusion group |
| `ai.modelPicker.filterRecent` | Recent / 常用 | Recent / **最近用过**（这条中文也改，与 Frequent「常用」分开） |
| `lore.aiHub.splitName` / `lore.split.title` | Split & organize / Reorganize & split | 统一 Split & organize |
| `ai.tasks.hook` | Opening / 开头 | Hook / 开头钩子（与续写面板的「开篇」分开） |

`SCOPE` 那条尤其值得改：知识库的 scope 是取材围栏，写手的 scope 是适用范围，英文界面上现在是同一个词。

### 批次 E —— 图片与小分歧 ✅ 已落地

**图像 → 图片**（面向作者的部分，`aiConfig.models.comfy*` 与供应商专有名词不动）：

| 键 | 现在 | 改成 |
|---|---|---|
| `aiConfig.modelTypes.image` | Image Generation / 图像生成 | 图片生成 |
| `aiConfig.models.capsEditLabel` | 支持图像编辑 | 支持修改图片 |
| `systemSettings.usage.kinds.image-gen` / `image-edit` | 生成插图 / 修改插图 | 生成图片 / 修改图片 |
| `systemSettings.subagents.imagegenSub` | 为文档和知识库条目生成插图 | …生成配图 |
| `systemSettings.subagents.imagegenReq` | 需图像模型 | 需图片模型 |
| `lore.imageGen.noImageModel` / `lore.detail.aiGenImageNeedModel` | 「图像生成」类型的模型 | 「图片生成」类型的模型 |

`systemSettings.subagents.vision`（Image analysis / 图像理解）**保留「图像理解」**——它是能力名不是动作名，且「图片理解」读起来更差。这是规则 6 唯一的豁免，写在这里免得下次又被「统一」掉；`localeTerms.test.ts` 的 `RETIRED` 里因此只禁「图像生成」这个组合，不禁「图像」二字。

落地时多改了一处 `model.ts`：小说包 `style` 分类的 `labelZh` 从「风格」改成「文风」。`resolveWorkspace.test.ts` 有两条断言写死了「风格」——它们测的是「同 id 时第一个声明者的标签赢」，字面值是附带的，跟着改了期望值。

**其余小分歧**：

| 键 | 现在 | 改成 |
|---|---|---|
| `lore.run.thinking` | Thinking / 思维链 | 思考过程 |
| `ai.panel.systemPromptLabel` | 系统提示 | 系统提示词 |
| `ai.panel.defaultSystemPrompt` | 默认系统提示… | 默认系统提示词… |
| `ai.panel.viewPrompt` / `promptViewerTitle` | 查看完整提示 / 完整提示 | 查看完整提示词 / 完整提示词 |
| `ai.errors.writerFailed` | 【系统提示】写手子代理… | 【系统】写手子代理…（这里是「系统通知」不是 system prompt） |
| `aiConfig.prompts.useAsDraft` / `emptyHint` | 以此为底稿覆盖 | 以此为基础创建覆盖版 |
| `NOVEL_PROFILE` 的 `style` 分类（`model.ts`） | Style / 风格 | Style / 文风 |

`model.ts` 里的分类 `labelZh` 改动会影响已有项目吗？**不会**——分类的持久化标识是 `id`（`style`），磁盘目录名也是 `id`，`labelZh` 只是显示名。

### 批次 F —— 系统提示词里的措辞 ✅ 已落地

`ai.instructions.*` 的字符串**发给模型**，改它们是改提示词而不是改文案，所以单独一个 PR。实际改了 16 处（zh 16 / en 6）：

| 语境 | 改法 |
|---|---|
| `system` / `agent` 的「工作台」 | → **写作应用**（「你是一位深度嵌入写作应用的写作协作者」/「你是作者的写作应用 Agent」；en: `the author's writing app` / `writing-app agent`） |
| `continueNovel` 的「设定忠实」 | → **资料忠实**，与中性 `continue` 的说法对齐；小说味由后半句的「角色名称、世界规则或实体」承担（en: `Lore fidelity` → `Source fidelity`） |
| `lore` 的「JSON 设定条目」 | → **JSON 条目**（en: `structured lore entry` → `structured knowledge-base entry`） |
| `roleplay` / `roleplayPersonaLore` 的「自己的设定」 | → **自己的人设**——角色「关于自己已确立的一切」正是人设，且这个词 `roleplay.stale.body` 已经在用（en: `your own setting` → `your own profile`；不用 `character sheet`，那是 `portrait` 配图槽位的名字） |
| `roleplayMemory`「知识库里已经写着的设定」 | → **已经写着的内容** |
| `copyChannel`「语气设定」 | → **语气** |
| `imageChecklist`「与设定相符」 | → **与资料相符** |
| `imagePrompt`「这类抽象设定」 | → **这类抽象特质** |
| `toolsRead`「某个名称、设定或已经写定的事实」 | → **某个名称、细节或…** |
| `subagent.longread`「核心设定」 | → **核心资料**（en: `core worldbuilding` → `core material`） |
| `imageChecklist` / `imagePrompt` / `imageReview` 的「图像…员/工程师」 | → **图片**（角色名，不是「图像理解」那个能力名） |
| `agent` 的「正文里的插图」×2 | → **配图**，与 `lib/image/assets.ts` 的用词一致 |

**两处刻意留下的「退役词」**，它们正是规则允许的那个意思：

- `agent` 里的「请作者在 **设置 → 工作台** 或{{kb}}墙上创建」——那是设置页签的名字，规则 C 保留的就是它；
- `subagent.vision` 的「你是**图像理解**专员」——能力名不是动作名，规则 6 的唯一豁免。护栏只禁「图像生成」这个组合而不禁「图像」二字，所以它自动通过，不需要为 vision 写特例。

落地后**撤掉了护栏里 `ai.instructions.` 的整段豁免**——那条豁免的注释原文就是「批次 F，还没做」。撤掉时它立刻红了一次，指到 `ai.instructions.subagent.longread`：那条藏在 `subagent` 子对象里，手工扫顶层键时漏掉了。护栏找出了人没找到的那一处。

**验证到哪一步为止**：`rag.test.ts` 45 条 + 全量 2623 条全绿，`tsc` / `build` 干净。但要说清楚——**没有任何测试断言到这些提示词的字面量**，所以绿的意思是「提示词装配没坏、键能解析、中英对齐」，**不是**「模型行为没变」。后者只有真机对一轮话才能确认，本轮没有条件做。风险评估仍是原来那句：「设定」在中文里对模型信息量很足，换成「条目」可能让它对知识库的态度变淡——如果之后发现助手查知识库变懒了，第一个该回滚的就是这批。

## 5. 防回潮：`localeTerms.test.ts` ✅ 已落地

`src/lib/__tests__/localeTerms.test.ts`。一张 `RETIRED` 表（词 → 该用什么 → 豁免键清单），命中即失败，报错直接把替代词和命中的键打出来。

扫**两个**面，因为文案有两份副本：

1. `zh-CN.json` 的全部值；
2. 组件里 `t(key, { defaultValue: "…" })` 的字面量——豁免按「调用点前 120 字符里出现豁免键名」判定，因为键就写在同一次调用里。

**代码注释故意不扫。** 注释里有设计记录和引用的设计稿屏名（`设计稿 03 · 屏 17「AI 执行进度 · 思维链」`），对散文做禁词就是个误报机器。注释由各批次自己扫干净。

`RETIRED`：`词条`、`主词条`、`前情记忆`、`前情摘要`、`思维链`、`底稿`、`生成插图`、`修改插图`、`图像生成`，加上带三条豁免的 `设定`（`roleplay.persona.none` / `narratorNote` / `empty.body` —— 动词或散文）。原先还有第四条 `ai.instructions.` 的整段豁免，批次 F 落地时撤掉了。

**一处计划没说对的**：原计划写「测试在 A 落地之后再加」，理由是先有护栏会让 A 那个 PR 自己踩自己。同样的道理对 B–E 也成立——护栏只能加在**所有要退的词都归零之后**，所以它实际排在最后。落地时按 A → B → C → D → E → 测试的顺序走。

护栏本身验过两次红：往 `zh-CN.json` 塞回一个「前情记忆」、往 `AiPanel.tsx` 的 `defaultValue` 塞回一个「思维链」，两个面各失败一次，报错指到具体的键和文件。一个从没红过的守卫测试不算守卫。

## 6. 明确不改的

- **代码里的 `lore`**。它是路径（`.ai-writer/lore/`）、类型名（`LoreEntity`）、工具名（`read_lore_entity`），改它是一次无收益的大重构。UI 说知识库，代码说 lore，这个分裂是刻意的。
- **`chapter` / `volume`**。同上——`appTerms` 已经把 UI 侧盖住了。
- **`Prompt` 不译成中文**。17 处既成事实，且「Prompt」在中文语境里已经是外来词。只有「发给模型的那段文本」译作「提示词」。
- **`Model ID`、`API Key`、`Token`、`PPTX`、`ComfyUI`**。专有名词。
- **5 个缺中文的复数键**（`ai.plan.stepCount_other`、`aiConfig.hub.modelCount_one/_other`、`deleteProviderConfirm_one/_other`）。中文无复数形态，`localeParity.test.ts` 已经把这条豁免写进注释了。
- **动词的措辞差异**：Save 保存/存、Clear 清除/清空、Close 关闭/收起、Add 添加/新增/归入。这些随位置长度和语气变化是正常的，统一它们只会让短按钮变长。

## 7. 落地记录

实际顺序：**A → B → C → D → E → 护栏测试**（一个 PR，A 单独一个提交，B–E 合成一个），随后 **F** 单独一个 PR。

每批的验证都是同一套：`pnpm tsc --noEmit` + `pnpm test`。最终 191 文件 / 2623 用例全绿（护栏测试贡献 20 条）。全程只有一次真实失败：E 改了小说包 `style` 的 `labelZh`，`resolveWorkspace.test.ts` 两条断言写死了旧字面值。

批次 F 随后单独走了一个 PR，并在落地时撤掉了护栏对 `ai.instructions.` 的整段豁免。它是六批里唯一作者看不见的一批，也是唯一没有测试能证明「行为没变」的一批——详见 §4 批次 F 末尾那段验证边界。

改完任意一批，同步更新三处：本文档第 3 节的词表、第 5 节的 `RETIRED` 表，以及 `CLAUDE.md` 里 Workspace Packs 一节的「UI 词汇是应用级且统一的」那段（它现在只点名了 文档/分组/知识库/条目 四个词）。

## 8. 文档侧的口径

第 4 节管的是 i18n 文案。`.md` 文档里同样有这批词——全项目 104 个 md 文件里，「设定」出现 246 次、「词条」51 次、「思维链」50 次——但**不能照着第 4 节一把改过去**，因为文档的三种身份要用三条不同的规则。

### 三条规则

1. **`living` 文档与 `CLAUDE.md`：文档和代码不一致，错的是文档。** 立刻改。
2. **`shipped` / `research` 设计记录：不重写正文，加一行更正。** 那些文档存在的理由是「当时为什么这么选」，把措辞刷成今天的样子会让「后来改过名」这个事实从记录里消失。仓库里已经有这个先例（`web-access-plan.md` 的复核表、`remote-knowledge-base-feasibility.md` 在索引里的那句「the file's own status line predates that」）。
3. **文档准确描述了今天的 UI，而那个 UI 用的是退役词：不动，等它所属的批次。** 现在改，文档就先于代码错了——这恰好违反规则 1。

规则 3 是这一节的重点：**每个批次的完成定义里必须包含它要同步改的文档**，否则 A 落地当天，`design-system.md` 就开始说假话。A–E 都是这么落的，下表已按实际结果更新。

### 已按规则 1 改掉的（本次）

| 位置 | 原文 | 现在 | 为什么是文档的错 |
|---|---|---|---|
| `reference/architecture.md` | injected 【设定资料】 block | injected 【知识库】 block | 注入块在能力包上线时就改名了，`sectionLabel("knowledge")` 是唯一不许被包改名的那个 |
| `reference/architecture.md` | 三个设定 AI 弹窗 | 三个知识库 AI 弹窗 | UI 上没有「设定」这个面 |
| `reference/design-system.md` | ### 设定集设计语言 | ### 知识库设计语言 | 同上；设计稿文件名 `03 设定集 Lore` 是外部产物，保留原样 |
| `reference/design-system.md` | 设定/摘要 bar segments · 注入设定 `--color-success` | 注入条目/… | 这条 bar 上的字今天是 `ai.chat.ctxInjected` =「注入条目」 |
| `CLAUDE.md` | → 词条注入 → | → 条目注入 → | 应用级词汇是「条目」 |
| `CLAUDE.md` | 前情摘要由角色第一人称自己写 | 前情由角色第一人称自己写 | 扮演转场的那份东西，UI 上就叫「前情」 |

顺带修了两处**代码注释**（同一个错，不是 md 但同源）：`stores/appStore.ts` 的两条注释把 lore 注入预算说成「【设定资料】 block」。

### 已按规则 2 加更正的

- `feature/lore/lore-facet-plan.md` —— 正文三处【设定资料】保留，状态块里加了一行说明它后来改叫【知识库】，并给出该搜什么。

### 按规则 3 押后的（各批次的文档尾巴）

| 批次 | 落地时必须同步改的文档 |
|---|---|
| A（主词条 → 主条目）✅ | 已随批次改完，共 20 处：`reference/design-system.md` ×9 · `feature/lore/lore-entry-type-plan.md` ×7 · `feature/lore/lore-collection-ui-brief.md` ×2 · `feature/lore/lore-collection-plan.md` ×1 · `feature/roleplay/11-lore-binding-lld.md` ×1。（原先按「行数」估的 ×8/×6 偏低——有的行含两处，按 occurrence 数才对） |
| B（前情记忆 → 前情提要）✅ | 已随批次改完共 10 处：`reference/architecture.md` 的 `### Story Memory` 标题 ×1 · `feature/agent/unified-agent-plan.md` ×3 · `feature/library-plan.md` ×2 · `feature/agent/chat-memory-plan.md` ×2 · `feature/pptx-plan.md` ×1 · `feature/html-artifact-plan.md` ×1；另有 4 处「前情摘要」按语境分流到 前情提要 / 前情 |
| E（思维链 → 思考过程）✅ | `reference/design-system.md` ×2 已改（`ThinkingPanel` 的名字与头行、`AgentLog` 那句分工）；引用设计稿屏名的那处「屏 17『AI 执行进度 · 思维链』」保留，它是外部产物的名字。**`docs/api/` 的 40 处不动** |

改 `### Story Memory` 那个标题前先 `grep -rn "architecture.md →"`：本文档写作时没有源码注释引用它，但这类标题是被当接口引用的。

### 一条写错了的判断（2026-08 复审更正）

本节原先写着「扮演的 【设定】/【记忆】/【场景】是 `lib/roleplay/context.ts` 和 `run.ts` 里**真实存在的 wire 块名**——发给模型的字面量，要改得走批次 F」。

**这句是错的。** 那些块名不是字面量，是从 i18n 拼出来的（`context.ts:561` 的 `` `【${label}】` ``，label 取自 `roleplay.section.bound` / `.memory` / `.scene`）。所以**批次 A 就已经把【绑定设定】改成了【绑定条目】**，根本轮不到批次 F。错判的代价是：此后三个月里 `context.ts:9` 的注释、`run.ts:104` 的注释和七份 roleplay 文档一直画着一个不存在的块名。

教训写在这里：**判断一个词是不是「真实的 wire 字面量」之前，先看它是不是 `i18n.t()` 拼出来的。** 是的话，它就归文案批次管，和别的 UI 串没有区别。

### 唯一真的不动

**`lib/profile/model.ts` 里那条讲「为什么 sections 是层叠不是替换」的注释**（约 1975 行，举例用了【上一章结尾】/【设定资料】）。它描述的是一个**被否掉的方案**当年会产生什么后果，属于「why not the other way」的记录——改掉例子等于删掉理由。复审时给它补了一个括注（"that lore block has since been renamed 【知识库】"），这样既留住理由，也不会让人搜一个搜不到的名字。

### `design/` 与 `plans/` 整体不动

`design/PRD.md` 一个文件就有 44 处「设定」——那是应用只做小说、知识库还叫设定集时的原始需求文档。`plans/` 是 29 份一次性的动效执行记录。两者都是历史，不是「今天的系统」，校准它们没有收益且会毁掉时间线。

## 9. 全库复审（六批落地之后）

六批全部合并后做了一次复审，结论是**规则 2「设计记录不重写正文」被推翻了**——作者的决定是全部扫干净。复审同时查出四类问题：

1. **上一轮改标题留下的断链**：`design-system.md` 的 `### 设定集设计语言` 改成了 `### 知识库设计语言`，但 `lore-collection-plan.md` / `lore-entry-type-plan.md` 里三处 `→ 设定集设计语言` 的交叉引用没跟着改，指向了一个不存在的小节。**改标题时要一起 grep 引用它的地方**，这是本次最该记住的一条。
2. **批次 A 的文档尾巴漏了三个 UI 串**：当时只扫了「主词条」，没扫「设定已更新 / 刷新设定 / 绑定设定」——这三个是同一批改的 i18n 值，却在七份 roleplay 文档里留了 32 处旧字。最疼的是 `08-verification-checklist.md`：验收清单照着它测会找不到那几个字。**批次的文档尾巴要按「这批改了哪些 i18n 键」去扫，不是按「我记得改了哪个词」。**
3. **源码注释里的旧块名**：`loreSelect.ts` ×2、`budget.ts` ×2、`context.ts` ×2 还写着【设定资料】/【绑定设定】，测试夹具里也有 8 处。夹具是任意字符串、不影响断言，但读者会当成真名。
4. **文档声明了一个 UI 决定而代码不再遵守**：`workflow-cards-plan.md`「UI 词用**工作流**」——批次 C 已经改成「工作流卡」。

清扫结果：`docs/` 132 处 + 源码注释与夹具 20 处。留在原地的 17 处都有名有姓——设计稿文件名 `03 设定集 Lore`、配图槽位名「服装设定」（`model.ts` 里的真实标签）、`docx` 里作动词的「能设定样式」、`collections: ["小说A", "共享设定"]` 这种示例数据、`subagent-lld.md` 三处引用 CLAUDE.md 禁令原文，以及 `docs/api/` 的 44 处「思维链」（协议域）。
