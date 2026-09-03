# Agent 直读 Office / PDF 文档（`read_document` + 转换缓存）

> **Status: `implemented`** — 2026-09-03 起草并同日实现（一片 PR，未真机验证——见 §9）。**不含 UI 变动**：新增的只有一个 agent 只读工具、一层落在 `.ai-writer/tmp/` 下的转换缓存，以及执行日志里一条工具标签字符串（§5.3）。把转换结果写回工作区的那一半（`convert_document`）被明确排除在本轮之外，因为它需要一种新的审批卡——那才是 UI（D11）。

## 1. 背景与现状

作者的预期场景：「把这个目录下的文档按项目归类整理」。目录里混着 .docx / .xlsx / .pdf / .pptx，agent 应该自己读懂内容再决定挪去哪里，而不是要作者先逐个右键「转换文档」。

**整理那一半是齐的。** `list_files` / `create_directory` / `move_chapter`（移动或改名任意文件与文件夹，过审批卡）/ `copy_file` / `delete_chapter` / `delete_directory` 都在 `AGENT_ASSIST_PRESET` 里。卡住的只有「读懂内容」这一步：

| 格式 | agent 今天能读吗 | 途径 | 缺口 |
|---|---|---|---|
| .pptx | 能 | `read_slides`（Rust 解析、按页分段，`docs/feature/pptx-plan.md` D3–D5） | — |
| .pdf | 有条件 | 只有 `delegate(kind: "pdf")`：把**原始字节**交给一个声明了 `pdfInput` 的模型，单轮、无工具 | 没配这种模型就一个字都读不到；有也读不了 150MB 以上，且每次都是整份送出、无法翻页 |
| .docx | 不能 | `read_file` 只对 .pptx 有拦截（`readWritingFile`），docx 会被 `fs_read_text_file` 当文本解码——zip 噪声或解码错误；`read_doc_format` 只读**版式**不读正文 | 无 |
| .xlsx | 不能 | 同上 | 无 |

**转换器都在，但只有 UI 入口。** `lib/import/index.ts` 的 `convertToMarkdown(ext, bytes, assetRelDir)` 已经统一了四种格式（docx → mammoth+turndown、xlsx → Rust `xlsx_to_markdown`、pdf → pdfjs、pptx → Rust `pptx_to_markdown`），返回纯的 `{markdown, assets}`。调用它的只有导入对话框和文件树右键「转换文档」（`convertProjectFile`）；`src/lib/agent/` 里没有一处引用 `lib/import`。而且两条路都只会把 .md 写到源文件**旁边**（`writeConversion`）——「临时目录」这种去向根本不存在。

`longread` 子代理也帮不上：它的工具集就是 `read_file` / `read_slides` / `search_text` / `list_files`，和主 agent 一样打不开 docx。

所以这不是一个新的转换功能，而是**给已有的转换函数开一个 agent 入口，并给它的产物找一个不污染工作区的落点**。

## 2. 目标与非目标

**目标**

- agent（chat 助手、AiPanel 的 `read`/`write`/`full` 档任务、`longread` 子代理）能直接读 .docx / .xlsx / .pdf 的正文，分页协议与 `read_file` 一致。
- 转换结果**不进工作区**：文件树看不见、`list_files` 列不出、`search_text` 搜不到、项目备份不带。源文件一个字节都不动。
- 同一份文件在一次会话里被翻十页，只转换一次；作者第二天再问，仍然不重转——除非文件内容变了。
- 转换抽出来的图片（docx / pdf 内嵌光栅图）对多模态模型可见：`read_image` 能打开它们。
- 缓存的键、路径、清理判定、扫描件判定全是纯函数，可在没有 Tauri 的 vitest 里测。

**非目标**

- **不把转换结果写回工作区。** 那是 L2 写操作，需要一种新的审批卡（D11）。作者今天仍用右键「转换文档」做这件事；agent 想让 .md 成为项目文件时，用 `create_file` 提交它读到并整理过的内容——这本来就是它整理文档的方式。
- **不扩 `search_text`。** 与 `pptx-plan.md` D6 同理（§3 D7）。
- **不做 OCR。** 扫描件的文本层是空的，本地路径读不到字；工具结果会明说并指向两条出路（D5）。
- **不碰 .doc / .xls / .ppt。** 导入器排除它们的理由原样成立：半乱码的结果和成功的长得一模一样。
- **不加 Beta 开关。** 导入侧的转换本来就不在开关后面；这个工具只是同一段代码的第二个读者。

## 3. 关键决策（含弃用理由）

### D1 新工具 `read_document`，不扩 `read_file`

`read_slides` 独立成工具的三条理由（pptx-plan D5）在这里一条不少：这几种文件不是磁盘上的文本；`read_file` 遇到它们该做的是**改口**（"用 read_document"），而不是花一整轮读噪声再得出"文件是空的"；而且一个「看扩展名决定要不要先转换」的 `read_file` 是在推断意图——两个互相拒绝的名字比一个会猜的工具可靠。

为什么不干脆并进 `read_slides`：`read_slides` 的坐标是**页**，pptx 的分页在 Rust 里按页解析、翻一页只解一页（D3/D4）；docx/xlsx/pdf 转出来的是一整篇 markdown，坐标是**行**。两种坐标塞进一个 `start_*` 参数，语义就随扩展名漂移，那正是 D5 反对的事。所以 `.pptx` 交给 `read_document` 时**拒绝并指回 `read_slides`**，三个读工具两两互相改口，没有一个会猜。

### D2 产物落在 `.ai-writer/tmp/convert/`，不落工作区

作者的要求是「放到临时目录里而不是污染工作区」。`.ai-writer/tmp/` 是应用已有的暂存根（`lib/image/session.ts` 的 `.ai-writer/tmp/imagegen`），它恰好同时满足四条：

- `readDirRecursive` 跳过点目录，所以文件树和 `list_files` 都看不见它；
- `read_file` 的围栏是「工作区减 `.ai-writer/`」（`resolveWorkspacePath`），模型**不能**用 `read_file` 去读缓存——缓存只归 `read_document` 管，翻页协议因此只有一个；
- `read_image` 的围栏是**整个项目含 `.ai-writer/`**（它本来就要读 `.ai-writer/lore/` 里的配图），所以转换抽出的图片模型看得到；
- `projectBackup.ts` 已经把 `.ai-writer/tmp` 列在排除清单里，备份不会把缓存打包走。

目录布局：

```
.ai-writer/tmp/convert/<sha256 前 16 位>/
  document.md      ← convertToMarkdown 的 markdown（与导入产物字节相同）
  assets/…         ← 抽出的图片，名字由转换器定（p3-1.jpg）
  meta.json        ← { source, ext, bytes, convertedAt, lastUsedAt, version }
```

**否掉的落点**

- *源文件旁边（`convertProjectFile` 现状）*：这就是「污染工作区」本身——`list_files` 会列出一份作者没要的 .md，下一轮模型会读它、`search_text` 会命中它、作者关了 agent 还得手动删。
- *任务工作区 `.ai-writer/tasks/<taskId>/notes/`*：note 是「模型写给自己的中间结果」，会被 `list_notes` 列出、被 resume 读进新上下文；一份 40 页的招标书原文塞进 note，等于让恢复上下文时把它整个搬回来。而且它绑在一个 task 上，同一份文件换个任务就要重转。
- *只放内存（`ToolContext` 上一张 Map）*：`ToolContext` 是一次运行的快照，chat 每轮一次 run，作者多问一句就重转；64MB 的 PDF 转一次要几十秒。图片也没有路径给 `read_image`。
- *系统临时目录*：出了项目根，`FsScope` 管不到，Tauri 的 fs 命令一律拒绝。

### D3 缓存键是**内容哈希**，不是路径 + 修改时间

`fileio.ts` 没有 stat，Rust 侧也没有暴露 mtime 的命令；加一个可以，但路径 + mtime 这把钥匙本身就不对：作者把 `招标文件.docx` 改名成 `A项目/招标文件.docx`——**这正是整理动作**——路径变了，内容没变，不该重转；反过来同名覆盖了一份新版本，内容变了，必须重转。内容哈希两边都对。

代价是每次调用要把文件读进内存算一遍 SHA-256：`crypto.subtle.digest` 对 64MB（`MAX_IMPORT_BYTES`，转换本来就要读这么多）在 webview 里是百毫秒级，而转换本身是秒级到分钟级。前 16 位十六进制做目录名——碰撞概率对一个项目的文档数来说可以忽略，且 `meta.json` 里记着 `source`，撞了也看得出来。

`meta.version` 是转换器版本号：docx/pdf/xlsx 任一转换器改了输出格式（比如导入图片那次），把常量 +1，旧缓存整体作废，不用管哪种格式改了。

### D4 分页照抄 `read_file`：按行，`start_line`，同一条尾注

学会了 `read_file` 的模型不该再学一遍（pptx-plan D4 的原话）。`pageLines` / `headingIndex` / `paragraphIndex` 直接复用；结果开头同样是标题地图，结尾同样是 `[... lines a-b of N shown; pass start_line=… to continue ...]`。

*实现出入*：行号**带**，且同样挂「行号不是内容」那条注。原稿写的是不带（这不是可编辑的文件），但 `pageLines` 是**唯一**的分页实现、行号是它输出的一部分（`numberLines`），为了去掉行号再开一份分页循环，正是 `pageLines` 注释里点名要避免的分叉；而且行号对这里并非无用——`<!-- page 7 -->` 在第几行，模型引用时说得出来。

PDF 的页号靠转换器已经写下的 `<!-- page N -->` 注释：它在 markdown 里就是一行，翻页时自然出现，模型引用「第 7 页」有据可依。xlsx 每张工作表是 `## 工作表名` + 一张表，标题地图直接把工作表列成目录；5000 行的截断提示是 Rust 侧已有的（`MAX_ROWS_PER_SHEET`，明示不静默）。

### D5 PDF 默认走本地 pdfjs；`pdf` 子代理留给扫描件和版面

这是 §1 里那个悬而未决的取舍。两条路各有真实用处：本地文本抽取不依赖任何模型配置、可缓存、可翻页、有页号；`pdf` 子代理能看版面、能读扫描件（如果那个模型会 OCR），但整份字节每次都送出去、单轮、无法翻页，还要求作者配了一个 `pdfInput` 模型。

所以：`read_document` 读 PDF **只走本地**，不碰子代理；`delegate(kind:"pdf")` 原样保留。两者由**工具结果**接起来，不由描述里的规则接：转换后正文近乎为空（去掉页标记和图片链接后不足一个阈值，纯函数 `looksScanned`），结果就说清楚——「这份 PDF 没有文本层，很可能是扫描件；已抽出 N 张页图（可用 read_image 查看），或把它交给 pdf 子代理」。规则在它生效的那一刻到达，比写在几千 token 之前的描述里管用（`edit-loop-plan.md` 的同一条判断）。

### D6 三个读工具两两改口

- `read_file` 遇到 .docx / .xlsx / .pdf → `Error: "…" is a Word/Excel/PDF document, not a text file. Use read_document to read it.`（照 .pptx 那条拦截的样子；`convertExtOf` 就是判定，不再手写扩展名表）。
- `read_document` 遇到 .pptx → 指回 `read_slides`；遇到其它扩展名 → 指回 `read_file`。
- `read_slides` 的拒绝语已经指向 `read_file`，改成同时提 `read_document`。

这样任何一个工具拿到不属于自己的文件，都在**同一轮**把模型送到对的工具去，不花第二轮。

### D7 `search_text` 不扫这些格式，也不扫缓存

pptx-plan D6 的账原样成立：全文搜索每次都要遍历整个项目，解 zip 比读文本贵一个数量级。缓存也不进搜索面——它在 `.ai-writer/` 下，`search_text` 本来就不进那里（知识库有自己的工具），而且缓存里有什么取决于模型此前读过什么，一个「有时命中有时不命中」的搜索面比没有更糟。要搜，`read_document` 的描述引导模型先读。

### D8 图片跟着缓存走，链接是相对的

`convertToMarkdown` 的 `assetRelDir` 参数传 `assets`，markdown 里就是 `![](assets/p3-1.jpg)`；文件写在缓存目录的 `assets/` 下。翻页结果里模型看到的是相对链接，工具在尾注里给出缓存目录的绝对路径（`pictures under: <dir>/assets`），模型要看就 `read_image(<dir>/assets/p3-1.jpg)`。不把图片内联成 base64（导入侧 `dropImages` 当年的三条罪状），也不预先送给模型——只看真正需要的那张，与 `read_lore_image` 的纪律一致。

### D9 进哪些 preset：与 `read_slides` 同行，先量再加

`read_slides` 在哪，`read_document` 就在哪：`CONTINUE_PRESET`、`AGENT_ASSIST_PRESET`、`WRITE_PRESET`、`packs.ts` 的两处读清单（`PACK_READS`——每个能力包子跑共用的读集——和 `ORCHESTRATOR_PRESET`）、`subagent.ts` 的 `longread`。理由各不相同但都成立：续写要读作者丢进项目的资料（大纲常常是 docx）；`write` 档的投标应答（`bidRespond`）读的招标书几乎总是 docx/pdf；`longread` 是三百页文档的最后一道防线（pptx-plan D7）。

预算是棘轮（`agentToolBudget.test.ts`），加工具要**先量**：

| preset | 上限 | 最近测得 | 余量 |
|---|---|---|---|
| agent-assist | 16,400 | ~15,700（15,385 + `insert_lines` 316） | ~700 |
| write | 4,600 | 4,491 | ~110 |
| continue | 2,000 | 1,738 | ~260 |

一个两参数、描述约 90 词的工具大约 150–200 token。`agent-assist` 和 `continue` 装得下；**`write` 很可能装不下**。届时的选择按测试文件自己立的规矩：改上限要在常量旁边写论证（这个工具在 `write` 档买到的是「不用作者先手动转换十份招标附件」），不许静默放宽。描述文本也为此从紧：路由交给 D6 的错误信息去做，描述里不重复列扩展名表。

*实测*：第一稿描述 260 token，三档全超；收紧后 **226**。`continue` 1,964 进了 2,000；`agent-assist` 16,479、`write` 4,718 各超 79 / 118，上限分别提到 16,600 / 4,800，论证写在 `agentToolBudget.test.ts` 两个常量的注释里。

### D10 清理：`lastUsedAt` 超过 7 天的条目，在首次调用时扫掉

没有 mtime 就自己记：每次命中把 `meta.json` 的 `lastUsedAt` 写成现在。每个项目在本次启动里**第一次** `read_document` 时扫一遍 `.ai-writer/tmp/convert/`，删掉 `lastUsedAt` 早于 7 天、或 `meta.version` 过期、或根本没有 `meta.json`（写到一半崩了）的条目。判定 `planSweep(entries, now)` 是纯函数。

不在项目打开时扫：那一刻正忙着 `scanLore`、读文件树，多一次目录遍历是给每个作者加载时间，换来的只是没用过这个工具的项目多删几个空目录。不设总量上限：一个条目最大就是一份 64MB 文档转出来的 markdown 和图片，七天窗口里能堆多少取决于作者读了多少份，那是他自己的选择。

### D11 写回工作区（`convert_document`）不在本轮——它是 UI

作者有时确实要那个 .md 成为项目文件（比如把招标书正文留在项目里以后反复引用）。那是 L2 写操作，走的应该是一张审批卡：「把 X.docx 转换为 X.md，放在旁边」。现有的卡种类（`propose_edit` 的 find/replace、`rewrite_*`、pptx/docx/xlsx 导出）都不是这个形状，得加一种 `EditProposal.kind`，就得有卡的组件——那就是 UI 变动，和这份「不动 UI」的方案分开做。今天的替代路径两条都能用：作者右键「转换文档」；或 agent 读完后用 `create_file` 交付它整理过的版本。

### D12 并发写入：先写临时目录再 `rename`

两个并行子代理（多稿 fan-out、或 `longread` 与主 run 同时读同一份文件）会同时转换同一个哈希。产物先写到 `<key>.tmp-<随机后缀>/`，全部落盘后 `renamePath` 到 `<key>/`；已存在就丢弃自己的那份。`fileio.renamePath` 现成，`image/session.ts` 是同样的写法。

## 4. 工具契约

```
read_document(path: string, start_line?: number)
```

描述文本（草稿，实施时以 `estimateToolsTokens` 量过再定）：

> Read a Word (.docx), Excel (.xlsx) or PDF document in the project as text. read_file cannot open these (they are compressed archives or binary); this converts one to markdown — headings, paragraphs, tables, one `## sheet` per worksheet, `<!-- page N -->` markers in a PDF — and pages through it exactly like read_file: about 4000 characters per call cut on a line boundary, with the start_line to pass next. The conversion is cached outside the workspace; the original file is never modified and no new file appears in the project. Pictures inside the document are extracted and can be viewed with read_image at the paths the result names. For a .pptx use read_slides.

参数描述与 `read_file` 逐字相同（`path`：list_files 的文件夹行 + "/" + 文件名；`start_line`：上一次尾注给的行号）。

结果形状（首页）：

```
<headingIndex 或 paragraphIndex>

<第 1–N 行正文>

[... lines 1-118 of 2,340 shown; call read_document again with start_line=119 to continue; converted from 招标文件.docx (original untouched); 6 pictures under /proj/.ai-writer/tmp/convert/3fa9…/assets ...]
```

错误样例（全部一轮内改口，见 D6）：

- `Error: "x.pptx" is a presentation. Use read_slides to read it.`
- `Error: "x.md" is a text file. Use read_file to read it.`
- `Error: "x.doc" is a legacy Word 97-2003 file; it cannot be converted. Ask the author to save it as .docx.`
- `Error: "x.pdf" is 80MB — over the 64MB conversion limit. Delegate it to the pdf subagent instead.`
- 扫描件（D5）：正文为空时不报错，返回页标记 + 图片链接 + 说明。

围栏与 `read_file` 相同（`resolveWorkspacePath`：工作区减 `.ai-writer/`）——被注入的模型不能拿它把 `.ai-writer/lore/` 里的东西「转换」出来。

## 5. 实施路径

### 5.1 文件

| 文件 | 改动 |
|---|---|
| `src/lib/import/cache.ts`（新） | 纯层：`cacheKey(bytes)`（SHA-256 → 前 16 位）、`cacheDirFor(projectPath, key)`、`CONVERT_CACHE_VERSION`、`looksScanned(markdown)`、`planSweep(entries, now)`、`meta.json` 的类型与解析 |
| `src/lib/import/cachedConvert.ts`（新） | 唯一碰盘处：读源文件 → 算键 → 命中则更新 `lastUsedAt` 并返回 markdown；未命中则 `convertToMarkdown` → 临时目录 → `rename`。首次调用触发 sweep |
| `src/lib/agent/documentTools.ts`（新） | `readDocumentFile(toolCallId, rawPath, projectPath, startLine)`：围栏、扩展名路由（D6）、调 `cachedConvert`、`pageLines` + 索引 + 尾注 |
| `src/lib/agent/tools.ts` | `readWritingFile` 加 docx/xlsx/pdf 拦截；`readSlidesFile` 的拒绝语补一句；`pageLines` / `headingIndex` / `paragraphIndex` 导出给新模块（`pageLines` 今天是模块私有） |
| `src/lib/agent/registry.ts` | `read_document` 条目（`access: "read"`）；`ToolId` 联合加一项 |
| `src/lib/agent/presets.ts`、`packs.ts`、`subagent.ts` | 按 D9 加进五处清单 |
| `src/i18n/locales/zh-CN.json`、`en.json` | `ai.agent.tool.read_document`（执行日志标签；缺了会回退成裸工具名，不是崩）；`ai.instructions.toolsRead` 那句「read_slides 按页读演示稿」后面加「read_document 读 Word / Excel / PDF」 |
| `src/lib/__tests__/agentToolBudget.test.ts` | 量出新数，按 D9 处理 `write` 档 |
| `docs/README.md`、`CLAUDE.md` | README 加行；CLAUDE.md 的 `src/lib/import/` 一段补「第三个读者」一句 |

### 5.2 PR 切片

一片就够——它没有需要分阶段验证的 UI，而且 D6 的改口和新工具必须同时到达（先加拦截而没有新工具，等于把 `read_file` 对 docx 从「噪声」改成「死路」）。

### 5.3 「不动 UI」的核对

组件目录一个文件不改。会动到的面向作者的文字只有两条 i18n 值：执行日志里的工具标签、briefing 里的一句话。文件树右键「转换文档」、导入对话框、设置里的子代理面板都保持原样。

## 6. 测试

- `cache.test.ts`：同字节同键、改一字节换键；`looksScanned` 对「只有页标记 + 图片链接」为真、对一段正文为假；`planSweep` 的三种删除条件与保留条件；`meta.json` 缺字段的解析结果。
- `documentTools.test.ts`（mock fs）：四种扩展名的路由（docx/xlsx/pdf 走转换，pptx/md/doc 各自改口）；命中缓存不再调转换器；翻页尾注形状与 `read_file` 的逐字对照；扫描件结果的说明文字；越界路径被拒。
- `tools.test.ts` 现有的 `read_file` 用例加三条拦截。
- `agentToolBudget.test.ts`：记录新测得的数。
- `writePreset.test.ts`「the read tools a page is assembled from」加 `read_document`。
- 真机：一份带图 docx、一份多表 xlsx、一份 30 页 PDF、一份扫描件 PDF、一份 .pptx（确认改口）；改名后不重转、改内容后重转；关掉重开 7 天判定（改系统时间或把 `lastUsedAt` 手改成旧日期）。

## 7. 被否掉的方案

- **扩 `read_file` 让它按扩展名自动转换。** D1。一个会猜的工具 + 两种坐标塞一个参数。
- **只靠 `delegate(kind:"longread")`，给它加转换能力。** 主 agent 自己读第 3 页、决定这份文件归哪个项目，是最常见的用法，不该每次都付一次子代理的往返和摘要损耗；而且子代理没有转换能力这件事本身也要修——修在工具上，两边都得到。
- **转换结果写回源文件旁边（复用 `convertProjectFile`）。** D2 第一条。这正是作者点名不要的。
- **让 Rust 侧新开按路径读的 `docx/xlsx_read` 命令，绕开 64MB 的字节 IPC。** xlsx 是 `Vec<u8>` 数字数组过 IPC（pptx-plan D3 说过约四倍膨胀），确实不理想；但 docx 和 pdf 的转换器都在 TS 里，本来就要把字节读进 webview，只优化 xlsx 一条路换不来对称。而且缓存把这个成本压到每份文件一次。列为后续可选项。
- **缓存放 `config.db` / `project.db` 里。** 图片要有路径给 `read_image`；markdown 几 MB 一条塞 SQLite 没有比文件系统好的地方；而且 `.ai-writer/tmp` 已经有「可随时整目录删掉」的语义，数据库表没有。

## 8. 开放问题

- `write` 档预算（D9）：实施时量出来再定，两种结果都有既定处理方式。
- `looksScanned` 的阈值：原稿定 40，写测试时发现一行中文正文只有 ~30 字（拉丁文一行 ~80），40 会把一页只有一行字的 PDF 判成扫描件，改成 **20**——仍高于图注、页码这种漏网的短行。真机对着扫描件再调。
- 一份 docx 只有表格没有段落时，`headingIndex` 和 `paragraphIndex` 都可能给不出地图（`tools.ts` 的注释已经承认 .txt 无标题时如此）。xlsx 没有这个问题（`## 工作表名` 就是标题）。先不为它单独做索引。

## 9. 实现记录（2026-09-03）

落地文件与 §5.1 一致，另有两处出入已记在 D4（行号保留）和 §8（扫描阈值 20）。单测：`convertCache.test.ts`（纯层 12 条）、`documentTools.test.ts`（路由 / 分页 / 扫描件 / 三个读工具互相改口，11 条）、`writePreset.test.ts` 与 `agentToolBudget.test.ts` 更新。

**未做真机验证**：worktree 里没有 Tauri 运行环境，四种转换器本身有导入侧的既有测试与真机记录（`import-images-plan.md`），这里新增的是围绕它们的缓存与路由。§6 列的真机清单（带图 docx、多表 xlsx、30 页 PDF、扫描件、改名不重转、改内容重转、7 天清理）待跑。

