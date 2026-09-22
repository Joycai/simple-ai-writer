# 目录说明文件与 OKF 元数据：调研

> 状态：`research`。一次调查，不是承诺。三条结论的先后顺序在 §7，落地前各自还要一份设计稿。
> **2026-09-22 更新**：§5 与 §6.2 已按 [`folder-note-plan.md`](folder-note-plan.md) 落地（顺序与 §7 不同——作者的三条诉求都在目录说明这一侧，条目 `status` 押后）；§6.1 与 §6.3 仍未做。
>
> 起点是两个需求：① 在工作区的目录里放一份说明文件，告诉 agent 这个目录装什么、
> 该不该参考，目录深时兼作文件索引；② 给知识库的条目和分类加类似的元数据。
> 调查过程中作者提出 Google Cloud 的 Open Knowledge Format（OKF）与两者都像，
> 于是把三件事放在一起看。
>
> 调研日期：2026-09-22 · 针对项目：simple-ai-writer · OKF 版本：v0.2

---

## 1. 先核实一件事：助手现在怎么接触工作区文档

结论：**会读，但只在模型自己决定调工具时读，从不整体自动注入。**

### 1.1 三个读取工具

都在 `src/lib/agent/toolTable/read.ts` 声明、`src/lib/agent/tools.ts` 实现。
路径由 `lib/paths.ts` 的 `resolveWorkspacePath` 围在项目根内；`.ai-writer/` 永远不出现，
因为 Rust 侧的 `read_dir_recursive` 跳过所有点文件。

| 工具 | 行为 | 上限（常量名） |
|---|---|---|
| `list_files` | 递归列出整个工作区，`ls -R` 风格分组，不按后缀过滤 | `LIST_MAX_FILES` = 300 个文件 |
| `read_file` | 按整行分页读任意文本文件，每行带行号 | `READ_MAX_CHARS` = 4000 字/页 |
| `search_text` | 大小写不敏感的子串搜索，只扫 `.md/.markdown/.txt/.html`，同一次调用连知识库一起搜 | `SEARCH_MAX_HITS` = 40 条，`SEARCH_MAX_PER_FILE` = 8 条 |

`read_slides` / `read_document` / `read_image` / `inspect_html` 是它们的格式分支，不改变结论。
命令行 Beta 打开时 `run_command` 也能 `cat` 任何文件，但每条命令过审批卡。

### 1.2 自动进入上下文的只有两处

- **当前文档**只给「简报」：路径、标题、字数、标题大纲。正文只在这一轮明确指向它时
  才注入（置顶了一段，或用了「这一段 / 本章 / 继续写」这类词）。理由写在
  `src/lib/context/docFocus.ts` 的文件头。
- **续写任务**通过 `src/lib/context/bookContext.ts` 的 `buildBookContext` 拉同一卷里
  前几章的**记忆摘要**（不是原文）和上一章结尾的原文尾巴（`BOOK_PREV_TAIL_CHARS`）。
  章节顺序来自 `src/lib/context/outline.ts` 的书脊。按卷摘要 `collectionDigest.ts`
  明确标注「只用于展示，永不进任务上下文」。

### 1.3 提示词怎么说

`ai.instructions.agent` 的第一节「先查后动」：作者提到某处内容却没说在哪个文档时，
先用 `search_text` 找，不要逐个 `list_files` / `read_file` 翻。没有任何一句让模型主动枚举整棵树。

### 1.4 哪些面能到达工作区

| 预设 | `list_files` | `read_file` | `search_text` |
|---|---|---|---|
| 对话助手 / 面板 Agent 模式（`AGENT_ASSIST_PRESET`） | ✓ | ✓ | ✓ |
| 续写（`CONTINUE_PRESET`） | ✓ | ✓ | ✓ |
| 一致性检查（`CONSISTENCY_PRESET`） | ✓ | ✓ | ✓ |
| 旁白（`NARRATOR_PRESET`） | ✓ | ✓ | ✓ |
| Writer 子代理（`WRITER_PRESET`） | ✗ | ✓ | ✓ |
| 扮演角色（`ROLEPLAY_PRESET`） | ✗ | ✗ | ✗ |

扮演角色刻意没有这三个工具，理由在 `src/lib/roleplay/presets.ts` 文件头。

### 1.5 没有任何目录级说明的约定

`README.md` 在源码里只以测试用的示例文件名出现。`manifest.json` 是知识库打包的清单，
`images.md` 是条目图集的清单，`.ai-writer/outline.json` 是书脊的覆盖层。没有一样是「向模型描述一个文件夹」。

---

## 2. OKF 是什么

Google Cloud 于 2026-06 发布，作者 Sam McVeety 与 Amir Hormati。官方说法是把 Karpathy
的「LLM wiki」模式定成一份可移植的规范。博客写的是 v0.1；规范仓库现在是 **v0.2**，
住在 `GoogleCloudPlatform/open-knowledge-format`。整份规范一页纸。

### 2.1 四条核心约定

1. **一个 bundle 是一棵目录树**，一个概念一个 markdown 文件，文件路径去掉 `.md` 就是概念的身份。
   可以是 git 仓库、tarball、zip，或另一个仓库的子目录。
2. **frontmatter 只强制一个字段** `type`。推荐 `title` / `description` / `resource` / `tags`。
   其余由生产方自定；消费方**不得**因未知字段、未知类型、断链或缺失的索引而拒绝一个 bundle。
3. **两个保留文件名**，都不是概念：
   - `index.md`：目录清单，正文是分节的 `* [标题](相对路径) - 一句描述`，子目录也这样列。
     用途叫「渐进披露」（progressive disclosure）：让 agent 一层一层往下看，而不是整包读进上下文。
     只有 bundle 根的 `index.md` 允许 frontmatter，唯一的键是 `okf_version`。
   - `log.md`：按 `YYYY-MM-DD` 日期倒序分组的变更记录。
4. **关系就是普通 markdown 链接**。链接只断言「有关系」，关系的种类由周围的文字说明。
   推荐 bundle 相对的绝对路径（以 `/` 开头），文件在子目录内移动时链接不断。

### 2.2 v0.2 新增的可选字段族

| 字段族 | 形状 | 语义 |
|---|---|---|
| `status` | `draft` / `stable` / `deprecated`，缺省 `stable` | 生命周期。`deprecated` 保留给链接和历史，不再是现行 |
| `stale_after` | ISO 8601 时间戳 | `now >= stale_after` 即过期 |
| `generated` | `{ by: <actor>, at: <时间> }` | 谁、何时最后一次实质修改 |
| `verified` | `[{ by, at }, …]`，单个可写成裸映射 | 谁确认过。**信任三档由此推导、不落盘**：无 `verified` = 未验证；只有非 `human:` 的 actor = 机器确认；有 `human:<id>` = 人工审阅 |
| `sources` | `[{ id, resource, title, author, usage_count, last_modified }]` + `usage_window` | 出处。正文按 `sources[].id` 用脚注引用 |
| `Attested Computation` 类型 | `runtime` / `parameters` / `computation` / `executor` / `attester` | 一个被认可的计算方式，agent 只能填参数不能改算法。数据领域专用 |

actor 的写法统一为 `<producer>/<version>`（agent）、`human:<id>`（人）、`process:<id>`（自动流程）。

v0.1 → v0.2 的两处破坏性变更：`timestamp` 改为 `generated.at`；正文的 `# Citations` 节改为 frontmatter 的 `sources`。

### 2.3 它不是什么

- **不是检索机制。** 它不检索、不排序片段；RAG 在另一层。
- **不是运行时。** 没有 SDK、没有注册中心、没有中央权威。
- **不是新东西。** 一个带 frontmatter 的 Obsidian 仓库在发布前就已经「符合」。
- 截至 2026-08，**没有主流 agent 原生读 OKF bundle**。参考实现是一个从 BigQuery 元数据生成
  bundle 的 Python agent、一个静态 HTML 可视化器、几个样例 bundle。

所以它现在的价值是**词汇和约定**，不是互操作。

---

## 3. 对照：本仓库的知识库 vs OKF

### 3.1 知识库已经是 OKF 形状的东西

| OKF | 本仓库知识库 |
|---|---|
| 一概念一文件，路径即身份 | 一条目一目录：`.ai-writer/lore/<category>/<id>/index.md` |
| `type` | 分类，就是目录名 |
| `title` / `description` / `tags` | frontmatter 的 `name` / `summary` / `collections` |
| markdown 链接成图 | `[[lore:…]]` 引用，`LoreEntity.citeTargets` 已解析成图，`lore-retrieval-plan.md` 用它做引用扩展 |
| 目录 `index.md` 渐进披露 | `tools.ts` 的 `formatLoreIndex` 在调用时现渲染给模型，不落盘 |
| `log.md` | `.ai-writer/backups/` + 方案账本（`planLedger.ts`）+ `ChangeRecord` |

### 3.2 知识库比 OKF 多的：注入语义

特征（facet）的 `keys` / `group` / `priority` / `mode` 决定一段内容什么时候进上下文、
和谁互斥、预算里排第几（`architecture.md` → Lore selection）。OKF 完全没有这一层，
因为它假设消费方自己做检索。**这一层一个字不能换。**
`lore-entry-type-plan.md` 的第一条不变量说的就是：`selectLore` 读到的东西一个字都不许多。

### 3.3 OKF 有、知识库没有的

- **`status`。** 现在没有任何字段能说「这条是草稿」或「这条已作废」。这正是需求 ①
  里「参考度 / 要不要参考」的规范化形态，而且是三值枚举而不是数字。
- **`generated` / `verified` 的信任三档。** 应用其实能诚实地盖章：`events.ts` 的
  `ChangeRecord.autoApproved` 已经区分了「作者看过」和「本次都批准之下没人读过」的写入。
- **`sources` 出处。** 只对提取类任务有意义：`bidExtract` 现在让模型在正文里写「信息来源」，
  `feedbackVerify` 靠 `search_text` 回溯。
- **`stale_after`。** 对小说设定没有意义；对标书、周报类能力包可能有。

### 3.4 一个命名冲突

OKF 规定 `index.md` 永远不是概念；本仓库条目的 `index.md` 正是概念本身
（`RESERVED_ENTITY_FILES`）。所以 `.ai-writer/lore/` **不是**一个合规 bundle。
一个 OKF 消费方走进来会把每个条目读成「一个没有概念的目录」。
调研的判断是不为此改动：模型不是靠走文件树消费知识库的（§3.1 最后一行）。
若将来要把知识库交给别的工具，`lib/lore/transfer.ts` 加一个 OKF 导出是机械映射
（条目 → `<分类>/<id>.md` + `type: <分类>`），只有特征怎么摊开需要设计。

---

## 4. 两处工程约束

任何「给条目加 yml 元数据」的方案都先撞上这两条。

**约束一：未知的 frontmatter 字段在整篇重写时会丢。**
`lib/lore/entity.ts` 的 `serializeEntityFrontmatter` 写的是固定字段集
（`name` / `aliases` / `category` / `summary` / `dict` / `cover` / `collections`）。
`architecture.md` 已经记过这个坑：`dict` 有六个写点要一一带过，
`saveEntityMetaAndBody` 为 `collections` 和 `cover` 设了「缺席 = 保留」的默认值正是为此。
新字段要么进这个固定集并过全部写点，要么先把序列化改成保留未知键。

**约束二：frontmatter 解析器读不了嵌套映射。**
`lib/fs/markdown.ts` 的 `parseFrontmatter` 是手写的按行解析，只认标量、行内列表、块列表。
OKF 的 `generated: {by, at}`、`verified: [{…}]`、`sources:` 全是嵌套的。
要么引入真正的 YAML 库，要么用扁平键（`generated_by` / `generated_at`）。

---

## 5. 需求 ①：工作区的目录说明文件

OKF 的 `index.md` 就是这份文件，连「一层一层看而不是整棵读」的理由都一样。
借它的名字和正文格式，换来的是现成的词汇，而且作者写的清单本身就是那份「文件索引」，
不需要第二套机制。

### 5.1 借取材范围围栏的哲学

知识库的取材范围（`lore-collection-plan.md` §3）有两条不变量可以原样搬来：

- **围栏只挡自动发现，不挡显式指定。** `list_files` / `search_text` 是自动发现；
  `read_file` 给路径、`@` 引用是显式指定，一律穿过围栏。
- **被挡掉的要报数。** `formatLoreIndex` 报「另有 N 条在范围外」，因为一份安静缩短过的
  清单读起来就是「这个项目只有这几条」。目录同理。

### 5.2 落点全在工具结果里，不进 schema

`lineEcho.ts` 已经为这个选择付过账：规则在生效那一刻到达，比写在几千 token 之前更管用，
也不碰 `agentToolBudget.test.ts` 的棘轮。

| 落点 | 做什么 |
|---|---|
| `list_files`（`listWritingFiles`） | 每个文件夹行下挂说明的首行；`deprecated` 子树不列，结尾报「另有 N 个目录按说明未列出」 |
| `search_text`（`collectChapterFiles`） | 跳过 `deprecated` 目录。实际收益最大：一本小说存了三版废稿，搜一个人名时 40 条命中会被废稿吃掉一半 |
| `docFocus.ts` 的简报 | 加当前文档所在目录的那一行说明。作者正在编辑「废稿/第三章.md」时助手应该知道这是废稿 |
| `@` 引用、`read_file` 显式路径 | 穿过围栏，不改 |

### 5.3 「参考度」不做成数字

知识库特征的 `priority` 能成立，是因为它驱动一个具体机制（注入预算的排序）。
目录级的参考度没有对应机制，模型拿到一个 `0.6` 只能猜。
细微差别写进说明正文（「v1 旧稿，人设以 v2 为准」），机器只读一个三值的 `status`。
仓库的一贯取向也是：两个互相拒绝的明确态优于一个要推断意图的宽泛量。

### 5.4 必须处理的副作用

选 `index.md` 做保留名之后：

- `outline.ts` 的 `isChapterFile` 把所有 `.md` 当章节，说明文件会变成书脊上的「第零章」
  进入续写上下文。要在书脊里排除。
- 一致性检查按同一套 `collectChapterFiles` 选文件，要排除。
- `lib/fs/rowMeta.ts` 的 `rowKind` 需要一种新的行外观（设计稿 01b 的七种行之外）。
- `list_files` 的 description 多一句，`agentToolBudget.test.ts` 的棘轮要抬一次，理由写在测试里。
- 文件名和这一行的措辞要过 `terminology.md`。

### 5.5 对 OKF 的一处偏离

OKF 只在 bundle 根的 `index.md` 允许 frontmatter。这里要在任意目录的 `index.md` 里放
`status:`。OKF 消费方必须容忍未知键，所以不算破坏；但要在设计稿里写明这是有意的偏离。

---

## 6. 需求 ②：知识库的条目与分类元数据

### 6.1 条目：借 `status`，第一步

`status: draft | stable | deprecated`，扁平键，解析器现成能读。

- 写入按缺席规则：`stable` 不写这一行，老知识库字节不变，和 `dict` / `cover` / `collections` 同一套纪律。
- `formatLoreIndex` 在名字后标一个词。
- `selectLore` 把 `deprecated` 排除出自动匹配；显式点名（置顶、`[[lore:…]]`、`@`）照样进，同围栏。
- 一致性检查跳过 `deprecated`，否则旧设定会被当成正文矛盾报出来。
- 要过 §4 约束一的全部写点。

### 6.2 分类：一份 `index.md` 带 `title` 与 `description`，第三步

分类的 **schema**（槽位）住在能力包和 profile.json，`lore-entry-type-plan.md` 说 schema 不进 lore 目录。
但 `.ai-writer/lore/<分类>/index.md` 带 `title` 和 `description` 不是 schema。它解决的是孤儿分类的老问题：
包一关，分类只剩目录名，`lore-entry-type-plan.md` §5 说目录名是「唯一诚实的答案」。
有了这份文件，分类的名字和「这一类装什么」跟着目录走，随知识库同步到别的项目也不丢。

消费点只有 `formatLoreIndex` 的分类头下面一行，只在模型真列清单时计费。
**不**进 `create_lore_entity` 的分类枚举说明，那是 schema，每轮都发。

### 6.3 往后放的

- **信任盖章**（`generated` / `verified`）：应用能诚实地写，但价值在界面而不在提示词，
  知识库墙上标一个「AI 写的，未过目」比塞进上下文有用。需要嵌套 YAML 或扁平键。
- **`sources`**：只对提取类能力包有意义，需要嵌套 YAML。
- **OKF 导出**：§3.4。

### 6.4 明确不做的

- **`log.md`。** 备份目录、方案账本、`ChangeRecord` 三处已经覆盖；让模型维护一份每条目的日志正是会失真的那种苦活。
- **数字参考度。** §5.3。
- **为符合 OKF 而改条目的 `index.md` 命名。** §3.4。
- **手工维护的全局文件索引。** 应用自带的文件管理器不会替它更新，第一次移动文件后就失真；
  说明文件逐层组合已经覆盖深目录的定位。若要自动索引，现成资产是 `collectionDigest`，
  但它「永不进任务上下文」是一条写明的决定，翻案要先在它的文档里给出理由。

---

## 7. 结论：先后顺序

| 步 | 内容 | 为什么先 |
|---|---|---|
| 1 | 条目 `status` + 写点保真 | 最小、最独立，直接回答「要不要参考」；顺手把 §4 约束一的写点过一遍 |
| 2 | 工作区 `index.md` 说明文件 | 需求 ① 本身；三处排除和一种新行外观 |
| 3 | 分类 `index.md` | 孤儿分类的收益；依赖第 2 步定下的文件格式 |
| 后 | 信任盖章 · `sources` · OKF 导出 | 各自要先决定解析器要不要升级 |

每一步落地前各自要一份 `docs/feature/` 下的设计稿，把这里的取舍连同理由写进去，并在 `docs/README.md` 登记。

### 未决问题

1. `deprecated` 目录要不要同时从续写的书脊里摘掉。倾向要（废稿不该喂给续写），但这是行为改变。
2. 解析器要不要升级到真正的 YAML 库。第一步不需要；信任盖章和 `sources` 需要。
3. 目录说明文件的作者可见名字与行外观，要过 `terminology.md` 与 `design-system.md`。

---

## 参考资料

- Google Cloud 博客：[How the Open Knowledge Format can improve data sharing](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)（2026-06，v0.1 时期的介绍）
- 规范原文：[OKF SPEC.md v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) · [仓库 README](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/README.md)（参考 agent、样例 bundle、可视化器）
- 样例 bundle 的目录索引：[bundles/ga4/index.md](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/bundles/ga4/index.md)
- 第三方解读：[GitBook: What is OKF](https://www.gitbook.com/blog/what-is-okf-open-knowledge-format) · [Google OKF Explained: 3 Hot Takes That Are Dead Wrong](https://bradtrnavsky.com/google-open-knowledge-format-okf-explained/) · [Open Knowledge Format: The Complete 2026 Guide](https://witscode.com/open-knowledge-format)
- 本仓库：`docs/feature/lore/lore-collection-plan.md`（取材范围围栏的不变量）· `docs/feature/lore/lore-entry-type-plan.md`（三条不变量、孤儿分类）· `docs/reference/tool-presence.md`（工具在场性）· `docs/feature/agent/agent-tool-context.md`（工具描述的上下文开销）· `docs/feature/agent/edit-loop-plan.md`（`lineEcho` 为什么是运行时输出不是 schema）
