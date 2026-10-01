# 词表与措辞校准

> 状态：**`living`**——今天要遵守、与代码不符时错的是文档。写任何面向作者的字符串之前读 §2–§5。
>
> 六个校准批次各改了哪些键、护栏怎么加上的、落地后的全库复审，都在 [`feature/terminology-calibration.md`](../feature/terminology-calibration.md)（`shipped`，2026-09 从本文拆出）。
>
> 起因：2026-08 对全量文案做了一次盘点——`en.json` / `zh-CN.json` 共 2775 个键，加上 `lib/profile/model.ts` 的能力包 / 分类 / 特征槽位、`lib/agent/subagent.ts` 的子代理种类。机械比对短标签（≤20 字符、不含插值）后发现 **78 处一词多译**、**49 处一译多词**。本文档是那次盘点收敛出来的词表和规则。
>
> 中英对照全表（含每个词的出处）在 <https://claude.ai/code/artifact/98e7fecb-de17-4385-ac39-0c400db4eaa7>。

## 1. 这份文档要解决的是什么

不是「翻译不准」。逐条看，几乎每个中文词单独拿出来都是对的——问题在**同一个东西有几个名字**，以及**几个不同的东西共用一个名字**。前者让作者以为功能不止一个，后者让作者以为两个功能是一回事。

三个最贵的例子：

- 知识库里的一条，在应用里同时叫 **条目**、**词条**、**设定**。`appTerms.entry` 明明已经把它定死成「条目」了。
- 同一份 story memory，AI 面板叫**前情记忆**、文库按钮叫**前情摘要**、用量页叫**前情提要**、上下文分配条叫**前情**。四个名字，一个功能。
- **工作台**同时是设置页签（能力包配置）、文档树视图、系统提示词里的整个应用；旁边还有个「任务工作区」。**工作流**同时是对话流程指引卡和 ComfyUI 节点图，而且都在设置页里。

CLAUDE.md 里已经写了这条纪律的一半——「UI 词汇是应用级且统一的（文档/分组/知识库/条目）」「绝不在组件或 i18n 值里写死 章/卷/设定」。当时规则在，文案没跟上；这份文档把另一半补齐。

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

### 应用级词汇（`useTerms()`）与【…】块标签

组件和提示词模板里的「文档 / 分组 / 知识库 / 条目」不写字面量，从这里取——`AGENTS.md` 说的「word list in terminology.md」就是这一张。两张表都在 `src/lib/profile/model.ts`，**表本身是真相，这里是抄录**，改词先改那里。

`DEFAULT_TERMS`（组件经 `useTerms()`〔`stores/projectStore`〕、模板经 `promptParams()` 拿到，英文复数由 `appTerms()` 补）。应用级、所有项目一致，能力包**不能**覆盖：

| id | 中文 | 英文 | 用在 |
|---|---|---|---|
| `doc` | 文档 | document（复数 documents） | 一份文档 |
| `group` | 分组 | group（groups） | 一个装文档的文件夹 |
| `kb` | 知识库 | Knowledge Base | 知识库的显示名 |
| `entry` | 条目 | entry（entries） | 知识库的一条，用于计数与 chip |
| `filesHeader` | DOCUMENTS · 文档 | DOCUMENTS | 侧栏文档面板的表头 |
| `emptyEyebrow` | 新篇 · NEW DOCUMENT | NEW DOCUMENT | 空文档上的装饰小标 |

`DEFAULT_SECTION_LABELS`（上下文块的【…】标签，经 `sectionLabel(id, packId)` / `promptParams()` 进提示词）。**只有中文一份**，不随界面语言切换；能力包可以按块覆盖（`pack.sections`），唯独 `knowledge` 是统一的「知识库」、不被覆盖：

| id | 默认标签 | 小说包的覆盖（举例） |
|---|---|---|
| `knowledge` | 知识库 | —（不覆盖） |
| `additionalKnowledge` | 附加知识 | |
| `outline` | 大纲/写作方向 | |
| `priorAll` | 前文回顾 | 小说包：全书前情 |
| `priorRecap` | 前情提要 | |
| `prevTail` | 上一篇结尾 | 小说包：上一章结尾 |
| `recent` | 近期内容 | |
| `selection` | 选中内容 | |
| `requirement` | 额外要求 | |
| `currentFile` | 当前文件 | |

其他内置包也各有 `sections` 覆盖（`model.ts` 各包定义里的 `sections: {…}`），这里只抄小说包作例子；要看某个包的全部覆盖读源码。

`Headword / 主条目` 是这一节唯一的新词。英文侧曾有三种写法（`Entry` · `Headword` · `Core card`）。取 Headword：`Entry` 会和条目本身撞，`Core card` 是扮演面板独有的说法。

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
| AiPanel 的模式名 | Agent mode | Agent 模式（保留英文，它是模式名不是主体名）。任务列表里同一个模式的标签 `ai.tasks.agent` 也只写「Agent」——「Agent 助手」把模式名和主体名拼在一起，两条规则都破 |
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
| Style | 文风 | 小说包分类 `style` 原叫「风格」，与「文风锚点」对不上。只改显示名 `labelZh`，持久化标识和目录名都是 `id`，已有项目不受影响 |
| Tone（跑团包） | 基调 | 与 Style 是两个词，刻意的，不动 |
| Recent（模型筛选） | 最近用过 | 不叫「常用」——那是 Frequent |
| Headlines（文案包任务） | 广告语 | 不叫「标题」——文案包和公众号包能同时启用，菜单上会并排两个「标题」 |
| Titles（公众号包任务） | 拟标题 | 同上 |
| Body text（编辑器段落样式） | 正文段落 | 弃裸「正文」——它同时是 body / content / prose / Manuscript |
| prose（写手的产出） | 成稿 | 同上 |
| Channel（设置里的 provider 行） | 渠道 | 弃「供应商」（2026-09-18）。一行 = 一把 key + 一个平台，下面挂几条线路；「供应商」读起来是一家公司，而同一家公司两把 key 是两个渠道、一把 key 打三个协议是一个渠道。代码里的 `Provider` / `providers` 表不改名。见 `docs/feature/channel-model-route-plan.md` §12 第 10 条 |
| Route（渠道下的一个协议） | 线路 | 界面上用协议名徽标（`Chat` · `Resp` · `Gemini` · `Anth`），不用编号——编号要背（同文 §6.1） |
| Platform | 平台 | 这台服务器在协议之外认哪些私有字段（阿里云百炼、DeepSeek 官方、New API……）；不是「厂商」，一个中转站也是一个平台 |
| Relay upstream（中转站背后的后端） | 上游 | 同一台中转站把同一个模型 id 转给 Kiro、Bedrock……，能力随之不同（2026-09-23，`docs/api/capability-gating-plan.md` §8.11）。**不叫「渠道」**——「渠道」已经是 provider 行，叫了会读成「渠道里的渠道」；选项写「Kiro 反代」「Bedrock 正向」这类名字。代码里是 `relayUpstream` / `upstreamPrefixes` |
| Folder note（目录自己的 `index.md`） | 目录说明 | 不叫「索引」——清单是可选的，说明才是必有的；文件树右列也只写「说明」（2026-09-22，`docs/feature/lore/folder-note-plan.md` §6） |
| Category note（`.ai-writer/lore/<分类>/index.md`） | 分类说明 | 同上；与条目的「主条目」是同一个文件名、两个东西，措辞上靠前缀分开 |
| Workspace（设置页签） | 工作台 | **只**指设置 → 工作台这个页签；别处说能力包配置就写「能力包」。「任务工作区」（`ai.taskWorkspace.*`）是另一个东西：一个真实的磁盘目录，「区」与「台」分得开 |
| Workflow card（流程指引） | 工作流卡 | 「工作流」单说时让给 ComfyUI 的节点图（规则 4）。`aiConfig.models.comfy*` 里的「工作流」是作者从 ComfyUI 导出的东西，名字不归我们管 |
| Image analysis（子代理档位） | 图像理解 | 规则 6 **唯一的豁免**：它是能力名不是动作名，「图片理解」读起来更差。护栏因此只禁「图像生成」这个组合，不禁「图像」二字。模型类型那一侧叫「视觉理解」，刻意不同名：前者是一个档位，后者是模型的类型 |
| Binding（扮演 system 层的全部输入） | 绑定内容 | 角色名、主角条目正文、扮演指令、作者身份合起来，比「条目」大（绑定内容已更新 · 刷新绑定）。扮演指令里角色「关于自己已确立的一切」叫**人设** |
| 【系统】（写手失败等系统通知） | 【系统】 | 不是 system prompt，所以不写「系统提示」 |

## 4. 护栏：`localeTerms.test.ts`

`src/lib/__tests__/localeTerms.test.ts`。一张 `RETIRED` 表（词 → 该用什么 → 豁免键清单），命中即失败，报错直接把替代词和命中的键打出来。它扫**两个**面，因为文案有两份副本：`zh-CN.json` 的值，和组件里 `t(key, { defaultValue: "…" })` 的字面量。`defaultValue` 只在键缺失时渲染，而 `localeParity.test.ts` 保证键不缺——所以它是**休眠的第二份副本**，改了 JSON 不改它，退役词就活在源码里，下一个人照着抄。

**护栏的边界**（照测试本身核过）——它**只**管下面这些，别把它当成 §3 词表的执行者：

- **词**：`RETIRED` 恰好十个——`词条`、`主词条`、`前情记忆`、`前情摘要`、`思维链`、`底稿`、`生成插图`、`修改插图`、`图像生成`、`设定`（后者带三条豁免键：`roleplay.persona.none` / `narratorNote` 是动词，`roleplay.empty.body` 是散文）。§3 里其余的「弃」（供应商、正在思考、裸「正文」、「常用」作 Recent、「工作台」作能力包、裸「图像」……）**没有**机器守着，靠写文案的人读 §3。
- **面**：`zh-CN.json` 的全部值；`src/` 下所有 `.ts` / `.tsx`（跳过 `__tests__/`）里 `defaultValue: "…"` 的**单行双引号**字面量。豁免按「调用点前 120 字符里出现豁免键名」判定，因为键就写在同一次调用里。
- **不扫**：`en.json`（英文侧的取词——Headword、Channel、APPLIES TO 等——全无守卫）、非 `defaultValue` 的源码字面量、代码注释、`docs/`。

**代码注释故意不扫。** 注释里有设计记录和引用的设计稿屏名（`设计稿 03a · 屏 17「AI 执行进度 · 思维链」`），对散文做禁词就是个误报机器。注释由改词的那个 PR 自己扫干净。

**改词的完成定义**：同一个 PR 里改掉 `zh-CN.json`、`en.json`、组件 `defaultValue`、代码注释，以及描述这些字符串的文档；然后把旧词加进 `RETIRED`。文档要按「这次改了哪些 i18n 键」去扫，不是按「我记得改了哪个词」——批次 A 漏掉三个串，七份 roleplay 文档留了 32 处旧字。

## 5. 明确不改的

- **代码里的 `lore`**。它是路径（`.ai-writer/lore/`）、类型名（`LoreEntity`）、工具名（`read_lore_entity`），改它是一次无收益的大重构。UI 说知识库，代码说 lore，这个分裂是刻意的。
- **`chapter` / `volume`**。同上——`appTerms` 已经把 UI 侧盖住了。
- **`Prompt` 不译成中文**。17 处既成事实，且「Prompt」在中文语境里已经是外来词。只有「发给模型的那段文本」译作「提示词」。
- **`Model ID`、`API Key`、`Token`、`PPTX`、`ComfyUI`**。专有名词。
- **5 个缺中文的复数键**（`ai.plan.stepCount_other`、`aiConfig.hub.modelCount_one/_other`、`deleteProviderConfirm_one/_other`）。中文无复数形态，`localeParity.test.ts` 已经把这条豁免写进注释了。
- **动词的措辞差异**：Save 保存/存、Clear 清除/清空、Close 关闭/收起、Add 添加/新增/归入。这些随位置长度和语气变化是正常的，统一它们只会让短按钮变长。

## 6. 文档侧的口径

`.md` 文档里的词不归护栏管，按文档的身份用三条规则：

1. **`living` 文档与 `AGENTS.md`：文档和代码不一致，错的是文档。** 立刻改。
2. **`shipped` / `research` 设计记录：退役词同样改成今天的词**，只留有名有姓的例外——外部产物的名字（设计稿文件名、屏名）、真实存在的标签、作动词的用法、示例数据、逐字引用的禁令原文、`docs/api/` 协议域的「思维链」（清单见下文「留在原地的」）。*（原先这条写的是「不重写正文，加一行更正」，理由是保住「后来改过名」这个事实；六批落地后的复审里作者推翻了它，决定全部扫干净，执行记录见 [`feature/terminology-calibration.md`](../feature/terminology-calibration.md) §4–§5。）*
3. **文档准确描述了今天的 UI，而那个 UI 用的是退役词：不动，等它所属的批次。** 现在改，文档就先于代码错了——这恰好违反规则 1。

规则 3 是这一节的重点：**改词的完成定义里必须包含它要同步改的文档**（§4），否则落地当天 `design-system.md` 就开始说假话。

**留在原地的**（都有名有姓）：设计稿文件名 `03a 设定集 · 条目与类型 Lore A` / `03b 设定集 · 集合 Lore B` 及屏名「屏 17『AI 执行进度 · 思维链』」、配图槽位名「服装设定」（`model.ts` 里的真实标签）、`docx` 里作动词的「能设定样式」、`collections: ["小说A", "共享设定"]` 这类示例数据、`subagent-lld.md` 三处引用 `AGENTS.md` 禁令原文、`docs/api/` 的「思维链」（协议域）。

`lib/profile/model.ts` 里讲「为什么 sections 是层叠不是替换」的那条注释用【设定资料】举例：它描述的是一个**被否掉的方案**当年会产生什么后果，改掉例子等于删掉理由，所以只加了括注说那个块后来改叫【知识库】。

`design/` 与 `plans/` 整体不动：`design/PRD.md` 是应用只做小说、知识库还叫设定集时的原始需求，`plans/` 是动效审计的执行记录。两者都是历史，校准它们会毁掉时间线。

两条从执行中学到的：

- **判断一个词是不是「wire 字面量」之前，先看它是不是 `i18n.t()` 拼出来的。** 扮演的【绑定条目】/【记忆】/【场景】是 `context.ts` 用 i18n 标签拼的，归文案管；当年误判成字面量，让注释和七份文档画了三个月不存在的块名。
- **改标题时 grep 引用它的地方。** 标题会被当接口引用（`xxx.md → 标题`），`### 设定集设计语言` 改名后留下过三处断链。
