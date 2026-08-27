# 词表与措辞校准

> 状态：第 1–3 节 `living`（今天要遵守的取词规则和词表，写任何面向作者的字符串之前读它）；第 4 节 `planned`（六个批次一个都没落，PR 未开）；第 5 节 `planned`（防回潮的护栏测试还不存在）。
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
| Thinking（折叠区标题） | 思考过程 | 弃「思维链」——那是模型侧行话 |
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

**每一批都要改两个地方。** 组件里有 **845 处硬编码中文 `defaultValue`**（`t("key", { defaultValue: "…" })`），其中 **29 处**含本文要退役的词。`defaultValue` 只在键缺失时才渲染，而 `localeParity.test.ts` 保证键不缺——所以它是**休眠的第二份副本**：改了 JSON 不改它，退役词就活在源码里，下一个人照着抄。第 5 节的护栏测试同时扫这两处，就是为这件事。

### 批次 A —— 知识库的名字（最大，24 + 14 键）

`设定` 34 键（含 `ai.instructions.*` 10 键，见批次 F）、`词条` 14 键。

设定 → 知识库 / 条目：

| 键 | 现在 | 改成 |
|---|---|---|
| `ai.bubble.extractLore` | Extract as lore / 提取为设定 | Extract as an entry / 提取为条目 |
| `editorStrip.refs` | `{{n}} lore refs` / 引用 {{n}} 设定 | `{{n}} {{entries}} referenced` / 引用 {{n}} {{entry}} |
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
- `roleplay.roster.stale`「设定已更新」、`roleplay.stale.body`「设定被改过（绑定条目、人设或身份）」、`roleplay.stale.refresh`「刷新设定」——这里的「设定」覆盖的是 system 层的全部输入（角色名 / 主角条目正文 / 扮演指令 / 作者身份），比「条目」大。建议统一成 **「绑定内容」**（绑定内容已更新 / 绑定内容被改过 / 刷新绑定），但这三处**需要一次拍板**，不是机械替换。
- `roleplay.empty.body`「他按自己的设定回你」——散文，读起来自然。改不改都行，倾向不动。

词条 → 条目（全部机械替换，无例外）：`lore.detail.colIndex`、`lore.generator.stepExtract`、`lore.facet.modeAutoHint`、`lore.facet.modeAlwaysHint`、`lore.improve.targetIndex`、`lore.meta.title` / `currentLabel` / `stepRead` / `footerNote`、`lore.aiHub.improveDesc`、`roleplay.composer.bound` / `core` / `boundEmpty`。

一个例外：`lore.dict.applyNeedsEntries`「没有可解析的词条」——这里的「词条」是**翻译词典的词对**，不是知识库条目。英文原文就是 *pairs*。改成「词对」，正好把「词条」这个词彻底腾空。

英文侧同批修：`lore.detail.colIndex` 的 `Entry · index.md` → `Headword · index.md`；`roleplay.composer.core` 的 `Core card (index.md)` → `Headword (index.md)`。

顺手清一个死键：**`ai.tasks.lore`（Lore extraction / 设定提取）全代码库无人引用**，可直接删——`ai.tasks.extract`（提取入库）才是活的那个。

### 批次 B —— 前情四词分工（9 键）

| 键 | 现在 | 改成 |
|---|---|---|
| `ai.memory.title` | Story Memory / 前情记忆 | 前情提要 |
| `ai.memory.hintCreate` / `hintUpdate` / `docTooShort` / `upToDate` | 前情记忆 | 前情提要 |
| `library.memoGenerate` / `memoUpdate` | 生成 / 更新前情摘要 | 生成 / 更新前情提要 |
| `library.summaryModelHint` | 用于生成前情摘要的模型 | 用于生成前情提要的模型 |
| `ai.memory.systemPrompt` | 你是前情摘要助手 | 你是前情提要助手 |

不动：`systemSettings.usage.kinds.memory`（已经是「前情提要」）、`ai.panel.allocMemory`（「前情」是紧凑位的合法缩写）、`lore.detail.fieldSummary`（概要）、`ai.agent.log.detailSummary`（历史摘要）、`ai.tasks.summary`（总结）、`systemSettings.usage.kinds.digest`（分组摘要）。

### 批次 C —— 撞车词（8 + 15 键）

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

### 批次 D —— 英文侧的歧义（7 键，中文不动）

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

### 批次 E —— 图片与小分歧（21 + 5 键）

**图像 → 图片**（面向作者的部分，`aiConfig.models.comfy*` 与供应商专有名词不动）：

| 键 | 现在 | 改成 |
|---|---|---|
| `aiConfig.modelTypes.image` | Image Generation / 图像生成 | 图片生成 |
| `aiConfig.models.capsEditLabel` | 支持图像编辑 | 支持修改图片 |
| `systemSettings.usage.kinds.image-gen` / `image-edit` | 生成插图 / 修改插图 | 生成图片 / 修改图片 |
| `systemSettings.subagents.imagegenSub` | 为文档和知识库条目生成插图 | …生成配图 |
| `systemSettings.subagents.imagegenReq` | 需图像模型 | 需图片模型 |
| `lore.imageGen.noImageModel` / `lore.detail.aiGenImageNeedModel` | 「图像生成」类型的模型 | 「图片生成」类型的模型 |

`systemSettings.subagents.vision`（Image analysis / 图像理解）**保留「图像理解」**——它是能力名不是动作名，且「图片理解」读起来更差。这是规则 6 唯一的豁免，写在这里免得下次又被「统一」掉。

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

### 批次 F —— 系统提示词里的措辞（12 键，单独 PR）

`ai.instructions.*` 里有 10 处「设定」、2 处「工作台」、4 处「图像」。这些字符串**发给模型**，改它们是改提示词，不是改文案：

- `ai.instructions.system` / `agent` 里的「工作台」→「写作应用」；
- `ai.instructions.lore` / `toolsRead` / `roleplay*` 里的「设定」→「知识库」/「条目」。

单独开一个 PR，理由是验证方式不同：文案改动看截图就够，提示词改动要跑一遍 `src/lib/__tests__/rag.test.ts` + 真机对话确认模型行为没变。风险低但不为零——「设定」在中文里对模型是个信息量很足的词，换成「条目」可能让它对知识库的态度变淡。**如果只想落一批就跳过这批**：它是六批里唯一一个作者根本看不见的。

## 5. 防回潮：`localeTerms.test.ts`

护栏必须扫**两处**，否则半年后退役词从 `defaultValue` 爬回来：

```
src/i18n/locales/zh-CN.json      ← 所有值
src/**/*.{ts,tsx}                ← t(…, { defaultValue: "…" }) 的字面量
```

形状照 `localeParity.test.ts` 和 `agentToolBudget.test.ts` 的棘轮写：一张 `RETIRED` 表（词 → 该用什么 → 豁免键清单），命中即失败，报错里直接给出替代词。豁免清单是这个测试的关键——「设定」有四处合法用法（见批次 A），把它们写进清单比放宽正则安全，因为清单会逼下一个人解释自己为什么要豁免。

初版 `RETIRED`：`词条`（→ 条目，豁免 `lore.dict.*` 的词对）、`前情记忆`、`前情摘要`、`思维链`、`底稿`、`生成插图` / `修改插图`。**「设定」暂不进表**——它在 `ai.instructions.*` 和扮演散文里还有活的用法，等批次 A 和 F 都落完再加，否则测试一上来就是红的。

## 6. 明确不改的

- **代码里的 `lore`**。它是路径（`.ai-writer/lore/`）、类型名（`LoreEntity`）、工具名（`read_lore_entity`），改它是一次无收益的大重构。UI 说知识库，代码说 lore，这个分裂是刻意的。
- **`chapter` / `volume`**。同上——`appTerms` 已经把 UI 侧盖住了。
- **`Prompt` 不译成中文**。17 处既成事实，且「Prompt」在中文语境里已经是外来词。只有「发给模型的那段文本」译作「提示词」。
- **`Model ID`、`API Key`、`Token`、`PPTX`、`ComfyUI`**。专有名词。
- **5 个缺中文的复数键**（`ai.plan.stepCount_other`、`aiConfig.hub.modelCount_one/_other`、`deleteProviderConfirm_one/_other`）。中文无复数形态，`localeParity.test.ts` 已经把这条豁免写进注释了。
- **动词的措辞差异**：Save 保存/存、Clear 清除/清空、Close 关闭/收起、Add 添加/新增/归入。这些随位置长度和语气变化是正常的，统一它们只会让短按钮变长。

## 7. 落地顺序建议

A → B → C 是作者能直接感知的三批，先落这三批就解掉了盘点里的大头。D 只动英文，可以随时插队。E 面广但每条都极浅。F 单独走，且是唯一可以不做的一批。

第 5 节的测试**在 A 落地之后再加**，一次性把 B/C/E 的退役词也写进 `RETIRED` 表——先有护栏再改文案，会让 A 那个 PR 自己踩自己。

改完任意一批，同步更新两处：本文档第 3 节的词表，以及 `CLAUDE.md` 里 Workspace Packs 一节的「UI 词汇是应用级且统一的」那段（它现在只点名了 文档/分组/知识库/条目 四个词）。
