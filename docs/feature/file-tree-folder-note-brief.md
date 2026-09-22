# 「文件」面板 · 目录说明 `index.md` —— 设计任务书

> 状态：`shipped`（设计稿已同步进设计项目 `01b 文件面板（一）` 的 TURN 2，2026-09-22；实现随
> [`folder-note-plan.md`](lore/folder-note-plan.md) 同一个 PR，§7 的落点已按稿子落地，2e-2 等提案押后见该文档 §8）。设计项目
> [`17a6a5ce-f60e-4996-8f94-5948958206d0`](https://claude.ai/design/p/17a6a5ce-f60e-4996-8f94-5948958206d0)，
> 目标文件 **`17 文件面板 Files Panel`**（文件后来改号为 `01b 文件面板（一）`，以 `list_files` 为准），
> 本稿作为 **TURN 2** 叠在 TURN 1（01b）现有内容上方；知识库墙那一屏（2e）**放在同一文件里**，
> 说明栏注明它属于 `03 设定集` 的墙——一次点击只在一个文件里读完整条链，比拆去两处强。
> `---` 以上是**代码实况**（供实现时回查）；`---` 以下是**发给设计师的原文**，自包含；
> 文末是**设计稿怎么答的**（本轮先画后写，所以答案已经在）。
> 关联：[file-panel-redesign-brief.md](file-panel-redesign-brief.md)（01b 的行语言与数据边界清单的体例）·
> [file-tree-picture-folder-brief.md](file-tree-picture-folder-brief.md)（右列固定词的先例）。

## 代码实况（2026-09-22，分支 `feat/folder-index`）

| 面 | 落点 |
|---|---|
| 说明文件的读写 | [`lib/fs/folderNote.ts`](../../src/lib/fs/folderNote.ts) —— `FOLDER_NOTE_FILE = "index.md"` · `parseFolderNote`（三值 `status`、首段摘要 ≤ `FOLDER_NOTE_SUMMARY_MAX` 160、`description` 兜底）· `nearestFolderNote` · `folderNoteTemplate(folderName, isZh)` |
| 第八种行 | [`lib/fs/rowMeta.ts`](../../src/lib/fs/rowMeta.ts) `RowKind` 多了 `note`；`rowKind` 按名字判 `isFolderNoteFile`；`extLabel` 对 `note` 返回 `null`（右列交给 `fileTree.noteLabel`） |
| 不是章节 | [`lib/context/outline.ts`](../../src/lib/context/outline.ts) `isChapterFile` 排除 `index.md`；[`agent/write/manuscript.ts`](../../src/lib/agent/write/manuscript.ts) `create_chapter` 对它单独一句拒绝语，指向 `create_file` |
| 行的渲染 | [`FileTree.tsx`](../../src/components/layout/FileTree.tsx) `RowIcon`（`switch (kind)`，`note` 分支已按本稿加）· `rightCol()`（`note` 分支已加）· `buildMenuItems`（分组菜单「造」格：在此新建文档 / 在此新建分组 / 导入文件 / [重新关联到…]） |
| 右键菜单组件 | [`common/ContextMenu.tsx`](../../src/components/common/ContextMenu.tsx)：`item` 支持 `icon` / `label` / `shortcut` / `hint`（第二行 mono）/ `badge` / `disabled` / `danger`；项高 30、`min-width 176`、`--color-bg-surface` 底 + `--color-border-strong` 边 |
| 发到助手的现成路径 | `FileTree.tsx` `sendToAssistant`：`useAppStore.getState().setShowAiDrawer(true, "chat")` 打开抽屉；`composerStore` 的 `setChatDraft` / `setChatRefs` 填输入框——本功能要的是**直接发出**，不是填入 |
| 知识库墙分类头 | [`LoreWall.tsx`](../../src/components/lore/LoreWall.tsx) 筛选 chip（`styles.chip`，3px 左边 = 分类色）`onContextMenu → setCatMenu`；`categoryMenuItems(cat)` 三分支：orphan →「把 N 条搬走并清空…」，包声明 →「删除分类…」禁用 + hint，自建 →「删除分类…」danger |
| 分类的数据 | [`lib/lore/categories.ts`](../../src/lib/lore/categories.ts) `IndexedCategory = ProfileCategory & { orphan }`——**没有** `hasNote`；`.ai-writer/` 不进文件树 |
| 批准卡 | [`ai/ApprovalCard.tsx`](../../src/components/ai/ApprovalCard.tsx)：头 = `ai.approval.titleRewrite`「整篇重写」+ 路径 mono + 行数差；脚 = 拒绝原因输入 + 拒绝 / 批准 |
| 树的顺序 | [`src-tauri/src/commands.rs`](../../src-tauri/src/commands.rs) `sort_by`：分组在前，其余按名字 |
| 词表 | [`terminology.md`](../reference/terminology.md) §3：作者面前叫**目录说明 / 分类说明**，不叫「索引」；文件夹叫**分组**（`useTerms().group`） |

`fileTree.noteLabel` 已随实现加入（`lore.*` 下有一个同名的「图库描述」，是另一回事）。

---

# 目录说明 `index.md` —— 设计任务书

请在 **`17 文件面板 Files Panel`**（现名 `01b 文件面板（一）`）里叠一个新的 **TURN 2**，放在现有内容上方。
复用它的组件、调色与 TURN 徽标 / 说明栏；不要另起一套。知识库墙那一屏也放在这里，说明栏注明它属于 `03`。

## 0. 这是什么功能

任何分组（文件夹）可以放一份 `index.md`，告诉助手这个分组装什么、该不该参考。没有它一切照旧；
有它，助手在自己扫描（`list_files` / `search_text`）和被告知「当前文件在哪」时会读到它。
格式借自 Open Knowledge Format：frontmatter 里**只有一个机器读的键** `status: draft | stable | deprecated`
（缺席 = stable），正文第一段是摘要，下面可选一张 `* [文件名](文件名) - 一句话` 的清单——**应用不解析清单**。
知识库分类也可以有同一格式的说明（`.ai-writer/lore/<分类>/index.md`），只读摘要、不读 `status`。

作者面前它叫**目录说明**（分类的叫**分类说明**），不叫「索引」：清单是可选的，说明才是必有的。
文件夹在这个应用里叫**分组**，文件叫**文档**——句子里请用这两个词；「目录说明」作为功能名是一个固定复合词，保留。

## 1. 现在的样子

树的行语言是 01b 定的：七种行、六枚图标、两级灰、右列一列两义（分组 = 篇数，文档 = 大写后缀；
`assets/<组>` 与图片目录用固定词「插图」「图片」占掉右列）。三个互不占用的通道：底色（悬停中性 /
当前打开赭石淡底）、左槽（3px 赭石 = 在选区里）、字重。行里没有 hover 才出现的元素。

分组右键菜单的顺序固定为**造 → 搬 → 查 → 毁**：「造」那一格现在是 在此新建文档 / 在此新建分组 / 导入文件
（失配的 `assets/` 组多一项 重新关联到…）。不成立的项**不渲染**而不是禁用。

## 2. 要你解决的

### 2a · 树上那一行

`index.md` 是一份 `.md`，后缀被吃掉后名字只剩 `index`。它不是一章（不进书脊、不进续写），作者要在树上一眼认出来。
请定：图标（lucide）、右列的词、与章节行的差别落在哪里、三态（悬停 / 当前打开 / 选中）是否照 01b 叠加即可。
**它有没有资格拿第三种颜色或第三档灰？**（倾向没有——它是作者写的东西。）

### 2b · 分组右键：造它的入口

「造」那一格多一项，跟在「导入文件」后：分组里**没有** `index.md` 时是**新建目录说明并交给助手**，**已有**时是
**让助手更新目录说明**（同一条提示词，不动文件）。请定图标、两条措辞的中英文、以及这两项是「一个槽位换词」还是两项并列。
菜单项的名字就是「交给助手」，所以点下去**直接发出**消息，不是填进输入框等作者再按回车。

### 2c · 点下去之后

一次点击触发一串：写入模板 → 刷新树 → 在编辑器打开它 → 打开助手抽屉 → 提示词作为一条消息已发出 → 助手自己读这个分组
→ `rewrite_document` 的批准卡 → 作者在卡上点一次 → 文件更新。请画出这一串里作者**看得见的每个状态**，卡片内部不必画（现有组件）。
两段文案请一并给：**模板**（一行标题 + 一段 HTML 注释说怎么填）和**提示词**（发出去的那条消息），中英各一套。

### 2d · `list_files` 里怎么呈现

那是模型看的文本，不画。

### 2e · 知识库墙的分类头

分类 chip 右键多一项**让助手写分类说明**，包声明的、自建的、未声明（孤儿）三种分类都有；现有的删除项规则不动。
另外请拿主意：**分类说明写好之后要不要在墙上显示？** 方案里它的消费点只在模型侧；但 `.ai-writer/` 不进文件树，
作者在界面上任何地方都看不到这份文件。若你决定显示，标为「提案」，并写清它要多读什么。

### 2f · 数据边界

树里每个节点**只有** `{名字, 路径, 是否目录, 子节点}`。具体说：

- 一行**是不是**说明：名字比对，现在就有。某分组**有没有** `index.md`：子节点名字比对，现在就有。
- `status` 三值与摘要：**读文件时**才有（`parseFolderNote`），树不读文件——所以行上**没有** status。
- 「最近一层祖先的说明」「祖先链上有没有 deprecated」：逐层读盘，只有模型侧的简报用。
- 清单**不解析**、链接**不校验**：没有「N 条失效」这种记号可画。
- 知识库分类：墙**不知道**某分类有没有说明（`IndexedCategory` 无 `hasNote`）；分类**不读** `status`。
- 没有修改时间（01b §3 同一条）。

如果你的设计需要上面某样不存在的东西，**请单独列出来**并说明它值不值得——我会评估代价，不会默默砍掉。

## 3. 约束

零圆角；唯一强调色赭石；颜色一律标 token 名；lucide 图标；不弹模态；行里不加 hover 才出现的元素；
浅色 + 深色两套；文案中英两套；不引入「章节」「设定」「词条」「索引」。

## 4. 交付

2a 行外观（含一行的解剖）· 2b 两态菜单 · 2c 连锁各态 · 2e 三种分类的菜单 + 显示与否的提案 · 2f 边界清单 · 2z 决策记录。

---

# 设计稿怎么答的（TURN 2，2026-09-22）

主干一句：**说明行与章节行只差一枚图标和右列一个词；菜单侧一个槽位、两个标签。** 全部在既有数据上成立，
唯一要新读盘的是 2e-2 的提案。

## 5. 逐屏的决定

| 屏 | 决定 | 值 |
|---|---|---|
| 2a 图标 | `NotebookText`，16 / stroke 1.6，描边不填充（叶子） | 与 `FileText` 一眼分得开（左侧装订线）；`ScrollText` / `Notebook` / `BookOpen` 在应用里已有别的义，未用 |
| 2a 右列 | 固定词，走 `.rightCol.ext`（9.5px mono，与「插图」「图片」「PDF」同位同号） | `fileTree.noteLabel`：**说明** / **NOTE** |
| 2a 灰度 | 作者那一档，**不进** `isSecondary` | 图标 `--color-text-muted`，名字 `--color-text-secondary`（与章节同） |
| 2a 名字 | 保持文件名 `index`，不换显示名 | 可改名 / 可搜索 / 可复制路径的字符串就是名字；换成显示名会让这些动作撒谎 |
| 2a 三态 | 01b 三通道原样叠加，不另设计 | 当前打开 `--color-accent-tint` + 图标转 `--color-sienna` + 500；选中左槽 `inset 3px 0 0 --color-sienna`；悬停 `--color-bg-elevated` |
| 2a status | **行上不显示** | 数据边界；将来若做，记号放**分组行右列**一个词，不是行的透明度 |
| 2b 位置 | 「造」格第四项，紧跟「导入文件」 | 造的是一个文件；不新开格（多一条线 = 多一个概念） |
| 2b 图标 | `NotebookPen`，新建 / 更新**同一枚** | 一槽两标签（与「转换文档 / 导出为 PPTX」同规）；图标说「造什么」不说「谁去做」，`Sparkles` 留给对象是助手的项 |
| 2b 措辞 | 新建目录说明并交给助手 / 让助手更新目录说明 | `New folder note via assistant` / `Update folder note via assistant` |
| 2b 判据 | 子节点名字比对（`isFolderNoteFile`），不读盘 | — |
| 2c 顺序 | 写模板 → 刷新树（新行以「当前打开」态出现）→ 编辑器打开（注释按 `.tok-comment` muted 斜体）→ 抽屉对话页打开、消息已在列表 → 步骤日志 → 批准卡 → 批准后编辑器随文件重载，**树上一个像素不变，抽屉不自动关** | — |
| 2c 消息 | 普通用户消息（`.userTurn`），时间行后缀「由「新建目录说明并交给助手」发出」；**不挂 `@[…]`**（两份说明同名，chip 分不出；路径写在正文里） | — |
| 2c 模板 | 沿用 `folderNoteTemplate`，**句子里的「目录」改成词表的「分组」**（功能名「目录说明」不动） | 见 §6 |
| 2c 提示词 | 四个要点按序：先列后读（folder 直指）→ 整篇重写 → status 怎么写 → 保留仍正确的话 | 见 §6 |
| 2e 措辞 | **一个标签覆盖新建与更新**：让助手写分类说明 / `Write category note via assistant` | 墙不知道 index.md 在不在；「写」在两种情况下都是真话。日后有 `hasNote` 再换词 |
| 2e 位置 | 菜单最上、与删除隔一条线；三种分类都有 | 造在毁前 |
| 2e-2 提案 | **建议显示**：筛到某分类时 chip 行下一行 | 12px 衬线 `--color-text-muted` + 13px `NotebookText`（`--color-text-faint`）+ 单行省略 + 右端 10px「右键分类可更新」；「全部」不显示、没有说明时**这一行不存在**；只读 |
| 2e-2 代价 | 筛到某分类时读一次 `lore/<分类>/index.md`，会话内缓存，`describe` 写盘后失效 | **不进** `scanLore`，不动 `selectLore` 不变量 |

三条**提案**（便宜，未画进主屏）：
1. 说明行**固定排在本分组文件之首**——中文章名下它恰好已在最前（拉丁码位小），英文章名下会混进去。改一处比较器。
2. **说明行自己的右键**多一项「让助手更新目录说明」，在「打开」之后、「发送到助手」之前，同一个 handler。
3. **树空白处右键**（项目根）也给「新建目录说明并交给助手」：根的 index.md 描述整个项目，`nearestFolderNote` 走到根。

## 6. 两段文案

**模板**（`folderNoteTemplate`，句子按词表对齐后）：

```markdown
# 第一卷

<!--
目录说明：第一段用一两句话写这个分组装什么、写作时该怎么参考。
不再参考的分组，在文件最顶上加三行：
---
status: deprecated
---
（草稿分组写 draft；不写就是正常参考。）
下面可以列出主要文件，每行一个：* [文件名](文件名) - 一句话
-->
```

英文照现有 `folderNoteTemplate` 的英文分支，`folder` → `group`。

**提示词**（菜单项发出的消息；`{group}` 是分组名，`{path}` 是相对路径）：

> 请为分组「{group}」写目录说明（{path}）。先列出这个分组里的文件，抽读两三份主要的；再整篇重写 index.md：
> 第一段用一两句话说这个分组装什么、写作时该怎么参考；如果它已经不再参考，在最顶上加 `status: deprecated` 的
> frontmatter（草稿写 draft，正常参考就不写）；下面可以列主要文件，每行 `* [文件名](文件名) - 一句话`。
> 现有说明里仍然正确的话保留。

> Write the folder note for the group “{group}” ({path}). List the files in this group and read two or three of
> the main ones; then rewrite index.md as a whole: in the first paragraph, one or two sentences on what this group
> holds and how to use it when writing; if it should no longer be consulted, put `status: deprecated` frontmatter at
> the very top (draft for work in progress; nothing for normal use); below, optionally list the main files, one per
> line as `* [name](name) - one line`. Keep whatever in the existing note is still true.

新建与更新用**同一条**：最后一句正是「更新」的意义所在，新建时它无害（没有现有说明）。

分类说明的提示词（2e）：

> 请为知识库分类「{category}」写分类说明。先读这一类的条目，再用 describe 提一份只有一步的方案：
> 一两句话说这一类装什么、条目之间怎么分工，写作时什么情况下该查它。

> Write the category note for the knowledge-base category “{category}”. Read this category's entries first, then
> propose a one-step plan with describe: one or two sentences on what this category holds, how its entries divide
> the ground, and when to consult it while writing.

## 7. 落点（给实现）

| 面 | 改什么 |
|---|---|
| `FileTree.tsx` `RowIcon` | `case "note": return <NotebookText size={16} strokeWidth={1.6} />`（不加 `filled`、不加 `secondary`） |
| `FileTree.tsx` `rightCol()` | `kind === "note"` → `<span className={`${styles.rightCol} ${styles.ext}`}>{t("fileTree.noteLabel")}</span>` |
| `FileTree.tsx` `buildMenuItems` | 分组分支在「导入文件」后 push 一项：`NotebookPen size={13}`，label 按 `node.children` 里有无 `isFolderNoteFile` 换 `fileTree.noteCreate` / `fileTree.noteUpdate` |
| 新 handler | 写模板（无则）→ `refreshFileTree` → `setActiveFilePath` → `setShowAiDrawer(true, "chat")` → 直接发送消息（不经 `setChatDraft`）；消息 meta 记来源，用于时间行的后缀 |
| `LoreWall.tsx` `categoryMenuItems` | 三个分支都在最前 push 「让助手写分类说明」+ divider |
| locale | `fileTree.noteLabel` 说明 / NOTE · `fileTree.noteCreate` · `fileTree.noteUpdate` · `fileTree.notePrompt`（含 `{{group}}` `{{path}}`）· `fileTree.noteSentBy`（时间行后缀）· `lore.categoryNote.menu` · `lore.categoryNote.prompt` · `lore.categoryNote.updateHint`（2e-2 采纳时） |
| `folderNoteTemplate` | 中文句子里「目录」→ `{{group}}`（`promptParams` 或直接 `useTerms`），英文 `folder` → `group` |
| `commands.rs` `sort_by`（提案 1） | 同一分组内 `index.md` 先于其他文件 |
| 2e-2（若采纳） | `LoreWall` 在 `filter` 变为某分类时读 `lore/<id>/index.md` → `parseFolderNote(...).summary`，缓存到 `describe` 写盘 |

设计稿文件：`17 文件面板 · TURN 2 目录说明 Folder Note.dc.html`（本地渲染核对过浅深两套；同步进设计项目的步骤见文首）。
