# 源码地图 · 分模块笔记

> **状态：`living`。** 与代码不符时，是文档的 bug。
> 这里是 `AGENTS.md` 目录地图的**展开版**：每个目录一节，写的是那个目录的模块分工、不变量和「为什么不是另一种做法」，以及各自设计文档的落点。`AGENTS.md` 只保留一句话和硬规则；**改某个目录之前，先读它在这里的那一节。**
> 2026-09-07 从 `CLAUDE.md` 原样搬出（那份文件曾长到 73KB，每次会话都整份进上下文）。往这里加细节，不往 `AGENTS.md` 加。
>
> **覆盖面**：`src/components/*`、`src/lib/*`、`src-tauri/`、`server/`——每个目录一节，新建一个目录就在这里加一节（2026-09-12 补齐了 `lib/docx` · `lib/editor` · `lib/format` · `lib/search` · `lib/sync` · `components/roleplay` · `components/sync` 与 `src-tauri/`，此前它们只有 `CLAUDE.md` 里的一行）。两个目录**故意不在这里**，因为别处讲得更全：`src/styles/` 与 `src/i18n/locales/` 看 [`design-system.md`](design-system.md) 与 [`terminology.md`](terminology.md)。（2026-09-16 补上 `src/stores/`，此前它只在 `CLAUDE.md` 的 State Management 一节里。）

## 能力包（Workspace packs）

The project is not hardcoded to novels — and not to one domain at a time. Code: `src/lib/profile/` (`model.ts` pack types + built-ins + validation, `resolve.ts` the multi-pack merge, `file.ts` profile.json parsing, `active.ts` the singleton holding the merged `ResolvedWorkspace`, `store.ts` persistence). Recipe: [`workflows.md`](workflows.md) → Add a new capability pack.

#### 存储与合并

- **Stored at** — `.ai-writer/profile.json`, per project. v3 is the current format — `{version: 3, enabled: [ids], packs: [custom], categories: [user-defined], collections: [names]}` (`collections` absent = none, so a v3 file from a build that predates collections still reads); a v2 file (`{version: 2, primary, enabled, packs}`) reads with its retired primary normalised to "first enabled", and a v1 file (the whole object is one profile) still reads as that pack alone. Old files are only rewritten as v3 when the author changes the selection. **Absent means the novel pack alone**, so every project created before profiles existed keeps its categories and task menu.

Packs are **equal, purely additive toggles**: enabling one adds its predefined tasks and its knowledge-base categories, nothing more. There is deliberately no "primary pack" any more — it used to own the non-additive dimensions (UI vocabulary, doc model, the AI's persona), which made packs unequal and made the agent assume a domain role the author never chose. Those dimensions are app-level now: every project's knowledge store is a **知识库**, every file a 文档 (`appTerms`/`useTerms`), the document model is always all-on, and the system prompt is one neutral writing collaborator (see below). A project with **zero packs** is valid and useful: the base task menu, the user's own categories, the `custom` misc bucket.

`resolveWorkspace(enabled, userCategories)` merges: **categories** = every enabled pack's (union, deduped case-insensitively by id — a shared id like `style` is the same directory; first declarer labels it, `packIds` records every declarer) + the project's **user-defined categories** (from profile.json's top-level `categories`; marked `userDefined`, the only ones the settings UI lets the author rename/remove) + the app-level **`custom` bucket, always last** (so `fallbackCategoryId()` always has a misc pile). **Tasks** = the app-level base menu (`DEFAULT_TASKS`: 续写/改写/润色/总结/图示页面/自定义/agent — ids `continue` / `rewrite` / `polish` / `summary` / `htmlArtifact` / `custom` / `agent`, always present) + each pack's own tasks; a pack declaring a *base* id **overrides** that base task in place (first enabled pack wins — this is how novel re-points 续写/改写/总结 at fiction wording), any other colliding id is dropped loudly. Each `ResolvedTask` carries the `packId` that `sectionLabel` resolves 【…】 wording against; base tasks nobody overrode carry none and speak the neutral defaults.

Per pack:

| Field | Drives |
| --- | --- |
| `categories` | The `.ai-writer/lore/<category>` folders — the knowledge-base layout, the lore scan, the category pickers, and the `category` enum in the agent's lore tools |
| `sections` | The 【…】 block labels *for this pack's tasks* (`bundleToMessages`), e.g. 【上一场景结尾】 instead of 【上一篇结尾】. `knowledge` is never overridden by built-ins — the knowledge base is called 知识库 everywhere |
| `tasks` | Base-task overrides and the pack's own tasks — see below |

Built-ins: `novel` (the default), `ttrpg` (跑团模组), `copy` (文案), `wechat` (微信公众号), `weekly` (周报), `feedback` (反馈报告) and `bid` (标书应答). Selection is Settings → 工作台 → 能力包 — each card is one on/off toggle — which calls `projectStore.setPacks(enabledIds)`: persist (v3) → scaffold the union's folders → rescan. The same pane (and the lore wall's 「+ 新建分类」 chip) manages the user-defined categories via `projectStore.setCustomCategories`, with folder ids derived by `suggestCategoryId` so the author only ever types a name. **Non-destructive** — a disabled pack's category folders and entities stay on disk and reappear on re-enabling, and removing a user category first asks where its entries go (`CategoryDeleteModal`): move them into another category, or leave them — the folder then stays on disk as an orphan category. The entries themselves stay *usable* meanwhile, as **orphan categories** (below); the pane's "N 个分类目录仍有内容" note now says which pack would give those categories their names and type schemas back. The AI panel groups the task menu by origin (`visibleTaskGroups`): the base menu flat (`pack: null` — an overridden base task still renders here), each pack's own tasks under a pack-name eyebrow.

#### 孤儿分类 (orphan categories)

`scanLore` 扫的是**磁盘上真实存在的目录**，不只是合并后的分类表：任何已启用包和用户自建分类都不声明、但里面有条目的目录，作为**孤儿分类**进入 `LoreIndex`（空目录不算——没人能往里新建的幽灵分类只会碍事；大小写不同的同一目录也只进一次，因为大小写不敏感的文件系统会把它报成另一个名字）。于是关掉一个能力包是**降级**而不是消失：条目照常出现在知识库墙、命令面板、AI 面板的清单里，照常被注入；失去的是分类的显示名（退回目录名）、类型 schema（`slots`/`imageSlots`，见 [`lore-entry-type-plan.md`](../feature/lore/lore-entry-type-plan.md)），以及作为新建目标的资格。

两个问题必须分开问——`src/lib/lore/categories.ts` 就是为此存在的：

| 问题 | 用什么 | 孤儿算不算 |
| --- | --- | --- |
| 「能往哪写」——新建条目、模型给的 `category`、移动目标 | `loreCategories()` / `isKnownCategory()`（也填 `create_lore_entity` 的 enum） | **不算** |
| 「有些什么」——墙、命令面板、AI 面板清单、详情页翻页 | `indexCategories(loreIndex)` | 算 |

搞混的后果很具体：注入侧走的是 `Object.values(loreIndex)`（`selectLore`/`rag`/`agent/tools` 都是），UI 侧若还枚举 `loreCategories()`，作者看到的条目会**少于**模型看到的——看不见的条目照样进 prompt。

`assignableCategories(current)` 是唯一的例外口子：条目自己正待在某个孤儿分类里时，分类选择器必须把它列出来，否则界面会显示一个它并不在的分类，而下一次保存就按那个值把目录搬走了。反过来「搬进」孤儿分类仍然不可能——从停用包的目录里迁出去是合理操作，往一个应用建不出来的目录里填东西不是。

标签用**目录名**，而不是借那个被停用的包的标签：借来的标签会让人以为 schema 还在，而目录名对手工建的、或者跟着别人项目一起来的文件夹也是唯一诚实的答案。`list_lore_entities` 的输出会在孤儿分类后面缀一句说明，免得模型试一次被拒才知道不能往里建。

#### Tasks (`tasks`)

A task is **a prompt plus a tool set**. The panel renders one segment per entry, so a profile carries however many it needs — 「生成遭遇表」 for a module, 「三版标题」 for copy — instead of the four a hardcoded union allowed.

| Field | Effect |
| --- | --- |
| `instructionKey` | The built-in instruction. A prompt template whose `scene` equals the task `id` overrides it; for a `freeform` task it is a *prefix* the author's ask follows (that is how Agent mode gets its briefing) |
| `tools` | `none` / `read` / `write` / `full`, resolved by `presetForTools` (lib/agent/presets) to no preset / `CONTINUE_PRESET` / `WRITE_PRESET` / `AGENT_ASSIST_PRESET`; `write` reads and authors files and deliverable exports but not the knowledge base, pictures or memory. **Having tools is what makes a run agentic** — `none` maps to null, which is the signal to stream directly |
| `target` | `append` (splice at the continuation anchor) / `replace` (overwrite the selection) / `detached` (author inserts it if they want it) |
| `continuation` | Append at an anchor, prior-document context, and the length + 承接/独立 + outline/knowledge controls. One switch because they are one feature; only valid with `target: "append"` |
| `needsSelection`, `referenceWindow`, `freeform`, `hidden` | The remaining flags the old `TaskKind` branches encoded |
| `agentTaskId` | Which task the "Agent 模式" toggle switches to. A pointer, so the agent task stays an ordinary entry with its own prompt and toolset |

The task `id` is load-bearing in three places, so renaming one is a breaking change: the `scene` of an overriding prompt template, the `task` column in `token_usage`, and the execution log's label.

`draftCountFor` derives its rule from `tools`, not from a list of task names: **any tool-using task produces a single draft.** Every round of the loop reports into one shared `agentLog`, so parallel runs would interleave into an unreadable log; a `full` toolset additionally can't have concurrent runs touching one lore folder or racing approval cards. Stating it this way covers tasks nobody has written yet.

`DEFAULT_TASKS` is the app-level base menu (续写/改写/润色/总结/图示页面/自定义/agent) — domain-neutral and present in every project, so a pack declares only its *own* tasks (plus any base-id overrides; novel's three instruction re-points are the only built-in ones). Packs can no longer drop a base task — the menu is uniform, and 续写 in a copy project simply continues the open document. `TTRPG_PROFILE`'s pair shows how `tools` is the load-bearing choice:

| Task | Shape | Why |
| --- | --- | --- |
| 遭遇 (`encounter`) | `tools: "read"`, freeform, detached | Must consult the module's own NPCs/locations first — an encounter that invents a rival the module already has is worse than useless at the table. Costs the single-draft limit. |
| 随机表 (`randomtable`) | `tools: "none"`, freeform, detached | A table of rumours needs the brief and the tone, not a lore sweep — and staying toolless is what lets it fan out, since three tables to choose between is how this gets used. |
| 标题 (`headlines`, copy) | `tools: "none"`, freeform, detached | Generated from a brief, so no selection. Toolless so it fans out: the drafts give *sets* of angles to compare. |
| 渠道改写 (`channel`, copy) | `needsSelection`, freeform, detached | Transforms an existing passage, so it needs one — but takes no `referenceWindow`, since the target channel comes from the author's line, not from surrounding text. Detached, because overwriting would lose the source being adapted from. |
| 汇总 (`digest`, weekly) | `tools: "none"`, freeform | The author brings the week's raw material, so there is nothing to go and find. |
| 对照上期 (`carryover`, weekly) | `tools: "read"`, **not** freeform | Has to *find* the previous report: prior-document context only reaches `continuation` tasks, and this one appends nothing. Not freeform because it is useful with no input, and a freeform task can't run on an empty box. |
| 归纳主题 (`themes`, feedback) | `tools: "read"`, freeform | Must actually read the corpus — themes inferred from product intuition are the failure this profile is shaped against. |
| 溯源核对 (`verify`, feedback) | `tools: "read"`, `needsSelection` | Checks one claim in the draft against the sources. No reference window: what it needs is the material, not the surrounding paragraphs. |
| 选题 (`topic`, wechat) | `tools: "read"`, freeform, detached | Has to list what the account already published — colliding with a published angle is the failure it exists to avoid. One run already returns a spread, so the lost fan-out costs little. |
| 标题 / 开头 (`titles`, `hook`, wechat) | `tools: "none"`, **not** freeform | The article is already in 【当前文章】 by the time you need either, and a freeform task can't run on an empty box — it would force the author to retype the gist. Toolless so the drafts give sets of options to compare. |
| 合规审查 (`compliance`, wechat) | `tools: "read"`, no selection | Reads the account's own 合规红线 entries rather than general impressions of 广告法, and audits the whole article: a red line in the paragraph you didn't select is exactly as fatal. |

**Tool-using tasks are told which file they are on.** `TaskExtras.currentFilePath` becomes a 【当前文件】 block, emitted first. Without it a task that browses the project cannot tell which of the files it lists is the one it was invoked on — 对照上期's "find the report before this one" has no anchor. In testing it happened to work because the draft's own heading said 「第 31 周」; a document that doesn't name its period would have left the model guessing, and picking the wrong file produces output that looks entirely normal. Toolless tasks omit it: they can't look at anything else, so it would only spend tokens.

**The feedback corpus can live anywhere in the workspace.** `list_files` and `search_text` cover the whole project tree (only the app's `.ai-writer` data is excluded), so source material in any folder is discoverable.

`needsSelection` and `referenceWindow` are separate flags answering different questions, and 渠道改写 is the first task to want one without the other. They coincide on every built-in, which is how the panel deriving the selection gate from `referenceWindow` went unnoticed — see the `TaskDef flags` guard in `profileTasks.test.ts`, which fails when a declared field has no consumer.

Both are `freeform`: the author supplies the situation ("下水道，被跟踪") and the built-in text is the briefing on what a usable result contains. **A prompt template whose `scene` matches the task id replaces that briefing while keeping the author's ask** — freeform tasks used to skip the scene lookup entirely, which made a carefully-written domain prompt the one kind nobody could tune.

**Ids can outlive the profile that defined them** (persisted panel selection, a log entry, a prompt template's `scene`), so `findTask()` returns null rather than throwing and every caller decides what to do — the panel falls back to `defaultTask()`, the log shows the raw id, `runTask` reports `ai.errors.taskNotFound`.

#### The document model (`DocModel`)

Three flags — `ordered` (volume/chapter spine + library view), `priorContext` (【前文回顾】 + 【上一篇结尾】 and the 承接/独立 picker), `memory` (per-document rolling summary, 【前情提要】). Since packs became purely additive the model is **app-level and always all-on** (`DEFAULT_DOC_MODEL`): every project gets the machinery and simply doesn't use what it doesn't need. Turning them off per-domain required a primary pack to arbitrate, and hiding working features bought less than the concept cost. The type, `docModel()` and `useDocModel()` survive as the seam a future *per-project* setting would plug into — consumers still read flags instead of assuming them, so re-introducing a switch is one edit, not an archaeology dig.

Details that are easy to get wrong:

- **`active.ts` is a module singleton, not a store.** The lore scanner, the agent's tool-schema builder, and the prompt assembler all need it synchronously from non-React code (mirrors how `i18n` is consumed). `projectStore` mirrors it as `workspace` state *purely so components re-render*, and is the **only** writer of both — syncing them anywhere else lets the UI and the prompt disagree about which packs are in force.
- **Anything module-level must resolve categories per call.** `registry.ts` is a `const` evaluated once at import, so its lore-tool `enum`s (via `profileCategoryParams`) and the `{{categories}}` placeholder in tool descriptions are both substituted in `getToolDefinitions()`, returning a copy. The same hazard applies to any future top-level constant: use `loreCategories()` at call time, never at module scope.
- **Never resolve a system prompt with `ai.instructions.system` directly.** The prompt is one neutral collaborator identity now, but `profileSystemPrompt()` (`lib/context/rag`) stays the single seam — it is where a per-project override would land, and history says callers drift: a TTRPG project was once prompted as a novel because `aiTaskStore` reached for the key while the then-per-pack fallback sat unexercised. `profileSystemPrompt.test.ts` still scans the source for the key. The packs' former persona prompts are gone; their domain rules (bid's deviation discipline, wechat's 合规, feedback's anti-overclaiming…) live in the pack tasks' *instructions*, where they only fire on the tasks they belong to.

`profile.json` is hand-editable, and its category ids become **directory names** — so it is parsed defensively (`parseProfile`/`parseCategoryList` drop bad entries, reject case-insensitive duplicates, cap the count; the retired pack fields `terms`/`docModel`/`systemPromptKey` are ignored with a note) and re-validated in Rust (`valid_category` in `commands.rs`, which is the actual boundary). A pack entry is read as a *patch on the built-in it names*: `{"id":"ttrpg"}` resolves back to that pack exactly.

#### 工具档与预算

- 每条任务声明一个**工具档** `none`/`read`/`write`/`full`（`presetForTools`），而 `write`（产物是一份文档：查 + 写文件 + 验 + 交付，**不碰知识库**）约 4.7k 对 `full` 的约 17k（两档的上限钉在 `agentToolBudget.test.ts` 的 `WRITE_CAP` / `AGENT_ASSIST_CAP`），所以**先考虑 `write` 再考虑 `full`**——schema 每轮重发，32k 的本地模型上 `full` 一档就能把整个输入上限吃光、知识库分到零（`contextForecast.test.ts` 钉着）。
- 随工具走而不是随档位走的还有两份清单（工作流卡 / docx 格式），见 `docs/feature/agent/edit-loop-plan.md` §7。

#### 词汇与提示词措辞

The UI vocabulary is **app-level and uniform** (`appTerms`/`useTerms`: 文档/分组/知识库/条目 — every project's knowledge store is a 知识库; the retired synonyms are ratcheted shut by `localeTerms.test.ts`, and `docs/reference/terminology.md` is the word list), and so are the document model (always all-on; `useDocModel()` is the seam kept for a future per-project setting) and the system prompt (one neutral writing collaborator — packs do not preset the AI's persona; domain rules live in each pack task's *instruction*, e.g. `bidRespond` carries the deviation discipline). Never hardcode 章/卷/设定 in a component or an i18n value — pass `useTerms()` words into parametrized i18n strings. Prompt templates (`ai.instructions.*`) get the same words plus the 【…】 section labels via `promptParams(isZh, packId?)` — pass the running task's `packId` so a pack task speaks its own wording (【应答大纲】, not 【大纲/写作方向】); the resolution chain is task's pack → neutral defaults, and `knowledge` is never renamed. Keep shared instruction text neutral and give novel its own variant (base-task override with a `*Novel` key) when fiction wording matters.

## `src/components/`

### `src/components/layout/`

Main layout structure (TitleBar, IconRail, Sidebar, ProjectRow (项目名那一行 + 它的菜单 + 搜索), FileTree (设计稿 01b：行的三个通道、容器查询分档、脚线；口径在 `docs/reference/design-system.md` → 文件面板设计语言), RecentProjects — the sidebar's no-project panel: 已固定 / 最近打开 两节，固定＝换节住而不是行上的标记，见 `docs/feature/file-panel-pin-ui-brief.md` — EditorArea, EditorBottomStrip, AiRail)

**顶栏右半段分两截，各有各的规矩（设计稿 `01e`，`TitleBar.tsx` + `DocActions.tsx`）。** 文档段跟着当前文档来去，全局段（主题 / 语言 / AI）右锚不动。三条：

- **谁在场由扩展名决定，不在场就不渲染**——一张名单一类文件，`lib/fs/docKind.ts` 的 `DocKind` 六个值就是设计稿表 B 的五行（`markdown` / `html` / `slides` / `image` / `convertible` / `opaque`）。`.html` 的导出只剩「打印 · PDF」（三条导出都先 `renderMarkdown`，把页面源码再渲染一遍不是导出，见 `printHtmlDocument`）；图片与读不出来的没有视图切换、没有字数，空位换成「用默认应用打开」/「转换文档」。
- **跟着文档走的读数认的是缓冲区，不是 `activeFilePath`。** 打开图片或可转换的 `docx / xlsx / pdf / pptx`（`isViewOnlyKind`——按扩展名就知道，`EditorArea` 根本不去读）时缓冲区**故意**停在上一篇文档——AI 那一侧靠 `WritingFocus.settled` 判断"还没就绪"（`stores/openDocument`），所以缓冲区不能清。代价是顶栏自己认路：`ExportMenu` 用 `useWritingFocus()` + `isExportableDocument`，字数 / 保存点 / 面包屑的「已修改」用 `isTextKind(docKindOf(...))`。用 `activeFilePath` 当条件的写法都错，而且错得很安静（图片打开时导出的是上一篇的正文、文件名却取自图片名）。同一条的反面：**一个手势里既打开文件又发一轮对话**（文件树的「新建目录说明并交给助手」）要先 `whenFocusSettles(path)` 等缓冲区追上，否则那一轮取到的焦点是点击前的那一篇——对话输入框没有 `settled` 门，作者在那里打字时本来就看着编辑器。
- **让位靠容器查询，量的是 `.flow` 的宽度**（顶栏减去平台让位：mac 56px 红绿灯位、无边框 Windows 138px 三键）——按窗口宽判会让两种边框形态在不同窗口宽度上跳档。三档 ≥1160 / 900–1159 / <900，让位顺序在 `TitleBar.module.css` 末尾那一段注释里（＝设计稿表 A，实现逐行照抄）。右侧每一件 `nowrap` + `flex-shrink:0`，整条里唯一让宽的是面包屑：中文标签被压到字宽以下会逐字折行成「编 辑」。两种档位的成色都渲染出来、由 CSS 藏掉一种——查询能换布局，换不了词。
- **没进编辑器的文件在编辑区有一页，三种原因三种说法**（`FileNotice.tsx`，由 `docKind.ts` 的 `fileNoticeReason` 判）：`convertible` 不读、给「转换文档」；`notText` 是读了才知道的二进制，只给「用默认应用打开」；只有 `error`（权限、I/O）才叫「失败」并带「重试」。前两种不是故障，不许用故障的措辞——理由与那张表在 `docs/feature/topbar-doc-actions-brief.md` 出入 5。

**关闭文档只有一处实现**：`stores/openDocument.ts` 的 `closeDocument()`（面包屑末尾的 ×、⌘W、文件树右键三个入口共用）。**「关闭」是三层，三平台同一套**（`lib/shortcuts.ts` 的 `CLOSE_DOC_COMBOS` 顶上有那张表）：文档 ⌘W · 项目 ⇧⌘W（`ProjectRow`，项目开着时才挂）· 窗口 ⌥⌘W（仅 mac，`windowmenu.rs` 的菜单项）。窗口那一层**不能**用 `PredefinedMenuItem::close_window`：预置项在 macOS 上固定带 ⌘W，而原生菜单先于 webview 收键——一个窗口就是一个工作区，于是「关文档」的 ⌘W 实际关掉的是整个项目窗口。先 flush 再置空，**写盘失败就不关**（缓冲区是那几行字唯一的副本），痕迹是面包屑尾巴两秒的一行；关的是图片时不碰缓冲区里那篇待写的文档。四条都钉在 `src/stores/__tests__/openDocumentClose.test.ts`。设计稿的两张表与出入表在 `docs/feature/topbar-doc-actions-brief.md`。

### `src/components/editor/`

`SlidesPreview` / `NativeSlideView` provide the lazy `.slides.json` preview from the export resolver, page navigation/notes, and prepare→review→write export using the P4 artifact cache. Source edits invalidate the review; unmount aborts work. Preview stays approximate and names unembedded fonts (pptx-plan §8.12).

CodeMirror wrapper, the markdown formatting strip above it (`EditorToolbar`, icon-only and stateless on purpose — reflecting the caret's formatting would cost a store write per keystroke, so only the heading dropdown reads state, and only when it opens), preview renderer + its zoom control

### `src/components/ai/`

`OutputRecoveryPanel` 是聊天与任务面板共用的「已保存的输出」入口，含纯文本续写与按作者大纲分节生成；数据属于项目，不随组件卸载丢失。设计与边界见 [`long-output-recovery.md`](../feature/agent/long-output-recovery.md)。

AiPanel (task UI, streaming output), ConsistencyCheck, 提示词库 (`SnippetPicker` 取用 + `SnippetSaveMenu` 右键存入 + `snippetTrace` 的确认痕迹)，以及执行日志与审批卡的这几件：

- `PlanLedger.tsx`——执行日志里的方案账本。它在轮次**上方**单独一段，不塞进批准它的那一轮：结束的轮是折叠的，要从手风琴里挖出来的账没人读。
- `TurnWrites.tsx`——执行日志末尾的「本轮写入」带子（设计稿 02h 1j）。「本次都批准」之后审批卡根本不出现，这里就是那张没出现的卡：每次写入一行（动词 · 文件 · +a −b · 自动批准），展开是同一套窗口加「在编辑器里打开」，末行汇总「N 个文档 · M 条条目 · +a −b 字 · 删 k 段」——删掉的段数是任何折叠都不许藏的那个数。运行结束后才出现；方案步骤的写入不重复列行。
- `ChangeWindows.tsx`——编辑类审批卡共用的那扇改动窗。行号列 40px、符号列 14px，删/加各用 diff 令牌，字级高亮是同色更深一档的 color-mix 而不是第五个令牌；空白只在「整窗差异全是空白」时显形成 ␣ ↵ →。窄栏降级走**容器查询**不是媒体查询——同一张卡在抽屉里 1100、在栏里 240。行号列在 CSS 里也 `display:none`，它和 JS 那侧的 `lineNumbers` 不许有分歧：两列网格里多出来的那个格子会把正文挤成一行一个字，那正是 resize 后第一帧的样子。
- `BlockWindows.tsx`——给重写卡的每扇窗戴一个头（「删 · § 三 · 码头夜市 · L88–101 · 整段 · 486 字」），因为整篇重写是一次到齐的几件无关的事，每扇窗得自我介绍。窗内每侧只露 2 行，其余折成一行可按的计数。
- **窄卡**（卡宽 < 480，设计稿 1k；容器查询与 `useNarrow` 用同一个阈值）：重写窗每行截成一行、窗头多一个「展开」；头部排两行——标题和唯一要紧的那个数一行，文件名和挪下来的规模一行（`headerScale` 一处算，宽窄两种头部说的是同一组数）；页脚排三行——理由框独占、拒绝/批准各半、常设授权降成一行小字，因为在窄处它是最不该误触的那个。方案卡同一套。

### `src/components/lore/`

Lore browser, LoreGenerator, LoreImproveModal, LoreWall, LoreReadView（条目**阅读模式**——墙上摊开的一张纸，与三栏管理台并列切换（`loreStore.detailMode`，快捷键 R）；注入语义收进节头短线与 mono 边注，见 `docs/reference/design-system.md` → v3 · 条目阅读模式）, `collections/` (the second axis's UI — 装订栏 / 卡片装订边 / 取材范围切换器 / 归集清单 / 集合管理; **分类用颜色，集合用装订**, and the `3px double` rule that keeps the fence from ever looking like a filter — see `docs/reference/design-system.md` → 集合 · 装订语汇), FacetEditModal + `ai/FacetAiAssistantModal` (AI-assisted facet splitting), LoreDictNormalizeModal（词典标准化：AI 只搬运词对、格式由 `formatDictBody` 渲染；入口在 AI 中心，仅 `dict` 条目可见；结果态是 03c 同款词表预览 + 可编辑原文两态，待核行点出来而不只报数——设计稿 03f，口径在 `docs/reference/design-system.md` → 分类操作与词典标准化，`CategoryDeleteModal` / `CategoryMoveMenu` 同处）

### `src/components/settings/`

#### 设置页结构

- SettingsPage: the full-window settings surface (shell + left nav) with one file per pane under `panes/`.
- SettingsPage 由 `App.tsx` 以 `React.lazy` 懒加载，单独成 chunk（约 350 kB）：多数会话不开设置，而它原先占了启动包约三分之一，把 App chunk 顶过了 `chunkSizeWarningLimit`。这条路成立的前提是**除 `App.tsx` 外没人静态 import `components/settings/`**——别处一旦直接引用，它就被拉回主包，拆分悄悄失效（`src/lib/__tests__/layering.test.ts` 守着这一条）。
- Panes are built from the shared row/section/card/chip vocabulary in `settingsUi.module.css` + `panes/bits.tsx`; `settingsCommon.module.css` holds the form controls used inside the edit drawers.
- 渠道与模型 is a single merged pane (grouped list + right-hand drawer), and Prompt has a drawer of its own.
- 外观（`AppearancePane`，设计稿 05m）紧跟「通用」：原先是通用里的一节，长到占了那一页
  大半，把语言 / 通知 / 调试 / 维护 / 重置挤到第二屏以下。每根轴一节——外观主题（明暗
  分段控件是它的第一行，因为明暗决定长出一条带还是两条）· 字体方案 · Markdown 排版
  主题 · 主题文件——页顶的「此刻」是唯一能看见三根轴**叠在一起**的地方（`NowSpecimen`：
  外壳两栏同外观卡样张，自带 `data-theme`/`data-scheme`；中间一页是排版样张 iframe，
  `sampleDocument` 的 `sizing` 放大到阅读字号）。卡、带、坏主题三态全在
  `AppearanceThemes.tsx`（05i）。通用页顶的路标和导航上的「新」只活到第一次打开外观
  （`app:appearanceSeen`，机器本地）。字体方案一节是两条带（设计稿 05n）：系统字体即选
  即用；鸿蒙黑体 / MiSans 是 `FontPackCard`——点卡即下载，状态行说本机有没有，外层是
  div（状态行里有删除 / 重试 / 清除按钮，按钮里不能嵌按钮），删正在用的那款先卡内确认；
  清除没下完的文件不确认（字形本来就是黑体的）。
- 计费组（`FeeGroupsPane` + `FeeGroupDrawer`，设计稿 05l）紧跟「渠道与模型」——它是
  那一页的价格那一半；中间隔着子代理，作者会以为它属于「用量」。编辑抽屉的表单是
  一个完整的 `FeeGroup`（三种方式的字段全在），分段控件只改 `billingMode`：**切方式
  只换下面的字段区，不清空别的方式的值**。列表行首 7px 方块沿用模型抽屉节目录的记号
  （实心 = 配了价，虚线 = 全是 0）。
- 用量页有两排 chip：范围（本项目 / 全部）在上，时间窗在下——先问「哪一份账」，再问
  「哪一段时间」。分组条只有一个强调色、长度表示占比（份额用长度，种类用词：这个
  仓库只有一个强调色，把成本拆成五段上色要么互相认不出，要么逼出一套新色板）。
  「按项目」只在总体范围下出现，它同时是「为什么有两本账」的自我解释。

#### 模型抽屉

- The model drawer (`ModelDrawer.tsx` + `ModelDrawerBits.tsx`, 设计稿 05c) folds its six sections by **"has a value"** (decided once from the stored row, never from the live form), spells **unset as a dashed edge** everywhere — an empty input, a selected 自动 chip, an off toggle, a folded empty section — because unset means *nothing is sent* and must not look like "set to 0", and ends in a 「将发送」 line computed by `lib/ai/modelSummary` from the adapters' own body functions; see `docs/reference/design-system.md` → 模型编辑抽屉. Under 上下文 / 最大输出 / 思考类目 one line says where a value comes from and who uses it (`panes/valueNotes.ts` over `modelSummary.valueFacts`, the same chain and request plan a request takes); a multi-route channel adds `panes/ValueFactMatrix.tsx`. The image section's decisions — the async switch on screen, what a save keeps, what a route change seeds — are pure functions in `panes/imageCapsDraft.ts` over the **effective** image route, the same answer the client dispatches on (`docs/feature/image-route.md`); `imageRouteAgreement.test.ts` walks random edits and checks the two sides against each other. A declaration the route won't send (PDF, video) keeps its switch, and the hint under it is picked by the verdict's reason code in `panes/declNotes.ts` — 「没有拼法」 only for `family`, the platform's own sentence for a platform measured refusing it or never measured (capability-gating-plan §2.3–§2.4, C4). A new row prefills only its type and PDF declaration — the value facts stay empty and follow the platform's rows (LLD §9.9). The legacy `thinkingDialect` no longer exists downstream: `lib/ai/legacyThinking.ts` rewrites it once, at `config.db` open and in `parseConfigBundle` (LLD §9.10).

#### 实验室与上下文记忆

- Under the AI group, 实验室 (`LabPane`) holds **every** Beta switch — each gates an assistant capability, so its neighbours are the panes an author configures next —
- and 上下文与记忆 (`ContextMemoryPane`) holds what a conversation puts in front of the model, in the order one bounds the next:
  - **窗口占用** (the 50–90% share of the model's window a single request may occupy — `CONTEXT_UTILIZATION_*`; it moved here from the AI panel's chip row on 2026-09-05, which is why the compaction example's third attribution now scrolls up this same page rather than leaving settings — see `docs/feature/agent/compact-threshold-plan.md` §D)
  - 对话归纳 (the auto-fold switch + the two threshold sliders)
  - and the image long-edge ceiling — see `docs/feature/settings-ai-tabs-ui-brief.md`).

#### 同步与备份

- 同步与备份 (`SyncPane`) runs top to bottom:
  - the anchor card (server connection + the bound pair, installation-level connection)
  - the **current project** paper (bind / push / pull / records — project-scoped, and the only part with an "open a project first" state)
  - then **这台机器** (应用配置 — local file export/import *and* the server backups, one section because they are two exits from the same thing)
- folded to a one-line summary while a project is open because the binding is what the page is visited for.

#### KbPicker

- Picking a base to bind is `KbPicker` (recommendation card + search/sort + a fixed-height list, so the bind button never scrolls away; pure half in `lib/sync/kbPicker`) — reasons in `docs/feature/knowledge-base/sync-lore-ui-brief.md` §绑定选择器

### `src/components/common/`

shared primitives, including `Slider` (设计稿 02e: the app's one slider — square 14×14 thumb, 2px track, optional log₂ scale, tick snapping within 4px, full keyboard; the value is the truth and a typed readout beside it mirrors it) and `Highlighted` (the one `MatchRange[]` painter for every list ranked by `lib/search`'s `matchText` — ⌘K and the `@` picker draw the same hit the same way; it only paints, merging stays with the search)

`MentionPicker.tsx` 是三个 `@` 宿主（对话助手、扮演、知识库三个 AI 弹窗）共用的选择器，组件只画，逻辑分在下面几处。理由：`docs/feature/agent/mention-scope-ui-brief.md`。

- **检测与状态**：`useMentionState`。`findMention` 是纯函数，node 测试直接 import，所以这个文件**不能** import store——词表走 `appTerms` 而不是 `useTerms`。状态是一个对象，`sync` 是纯函数 `syncMention(prev, value, caret)`：新开（含提名开着时另起一个 `@`）把档位重置为「全部」、高亮回第 0 行；同一个 `@` 上继续则保留档位。
- **作用域 chip**（设计稿 02i）：列表顶上一行，「全部」恒在，有条目才有「条目」、有文件就有「文档」、有图才有「图片」（`availableScopes`）。
- **claim 表**：每个提名有序号，选中那一刻 `claim()` 登记到按 id 记的待落表。`trackClaims` 每次渲染让表项跟着打字；关了保留；同一 `@` 上重开的也跟。一张表就是一份草稿——三个宿主都按草稿重挂，对话助手是 `AiDrawer` 的 `key={activeChatKey}`。
- **落字**：读完文件再 `accept(value, item, claim, projectPath, sel)`，返回 `{ text, sel }`。`acceptPick` 只落一次、按表里的当前位置；打长了且 `matchesMention` 仍找得到就整段替换，否则退回快照 query；没落上不记账、不关提名；落上了平移后面的 claim。`afterAccept` 关掉被 claim 的与同一 `@` 上重开的，后起的 `@夜` 平移 `start`——宿主程序化落字不再 `sync`。落字本身是纯函数 `spliceMention`，原位已不是 `@query` 就不动正文。
- **记号只有一份定义**：`@[名字]` 的形状取自 `lib/agent/mentionText` 的 `mentionToken`；气泡着色、generator 剥引用、`findMention` 判断「在已落引用里」都按它数括号。
- **选区保持**：程序化落字会把光标甩到末尾，所以 `landSelection` 把作者此刻的整段选区两端各经 `caretThrough` 映射过这次替换，宿主渲染之后由 `useKeptSelection` 在 layout effect 里放回去。别的实例写进同一份草稿时，它在渲染期记下输入框换值之前的文本与选区，经 `selectionThrough`（按 `editRange`）搬过去——三个宿主都不必知道是谁写的。
- **读取中的草稿**：`@` 选中的文件还在读时这份草稿不能发（`useMentionReads(slot)`，按槽位计数，照 `chatStash` 的 `pasting`：发起读取的实例可能已卸载；表本身在 `lib/agent/mentionReads.ts`，好让 `composerStore.resetAll` 清掉失败）。对话助手与扮演的读取失败也按槽位记（同一个 hook 的 `failure` / `fail` / `take`）：屏上的实例——或下一个挂上这份草稿的——撤排队、显示拒绝提示，显示过就取走（抽屉退场动画里的实例不取，`useIsPresent`）。知识库弹窗的槽位随弹窗消失，照旧实例内提示。
- **读取期间切了会话或角色**：旧实例照样落进原来那份草稿，正文经 store 的 updater 落进它此刻的值（不用冻结在切走那一刻的 `draftRef`，否则切回来接着打的字会被整段覆盖）。新实例拿 `useOwnDraft`（自己的每次写入都经它，写之前先把没渲染的外来改动平移掉；对话助手与扮演共用）认出这次写不是自己的，按 `editRange` 夹出的改动段平移开着的提名与等着的 claim（`shiftCore` / `shiftClaims`），不按光标找、不重开。自己的写入（落字除外——`acceptPick` 自己平移）之后也按改动段平移等着的 claim（`moveClaims`，经 `mention.edited`）：读的期间关掉的提名不再被 `trackClaims` 带着走。
- **搜索与键盘**：匹配、排序、可用档全在 `lib/search/mentionSearch`，宿主经同文件的 `useMentionSearch(candidates, mention, projectPath)` 跑它（选择器不在屏上时什么都不算——候选每次条目写入、文件树刷新都在变）。键盘协议只有 `mentionKeyDown` 这一份（Esc 关、组字期间交还输入法、Tab 切档、↑↓、Enter 选中或在空档吞掉），三个宿主各调一次、只在「选中之后做什么」上不同——三处手抄的版本一个 PR 里就漂过一次（弹窗漏了 IME 守卫）。
- **门**：`search.open` = `mention.open && candidates.length > 0`。空档仍渲染（chip 行 + 一行事实），但一个候选都没有时没什么可分档，选择器照旧不出来、键照旧放过。命中高亮用 `common/Highlighted`，与 ⌘K 同一个组件。

### `src/components/command/`, `onboarding/`, `library/`

CommandPalette, onboarding flow, library view (文库: only what the author picked — `LibraryPicker` edits the members table, whole folders or single docs; book-spine ordering + per-collection resources; after its own moves it re-reads the spine from disk because `moveEntry` already rewrote it, and reloads on `spineRev`; see `docs/feature/library-plan.md` → 第四期)

### `src/components/roleplay/`

扮演 Beta 的整套界面（设计稿 04a / 04b / 04c，功能设计在 `docs/feature/roleplay/`）。

#### 花名册与对话主界面

- `RoleplayPanel.tsx` 是外壳（花名册 + 对话区），空态是作者第一次看见这个功能的地方，所以它不是一句「暂无内容」——标题说清这是什么，中间给一段真的对话长什么样，底下直接列出知识库里现成的人物。
- `RoleplayRoster.tsx` 的两类角色**靠形状和分组区分，不靠颜色**：角色是圆头像（取人物条目的配图，无图时用名字最后一个字），旁白是直角方框套小方块并单独成组置顶；花名册里永远只有一个赭石，它属于「选中」而不属于分类（悬停是中性灰、无左规——把悬停也染成赭石会读成一个并不存在的选中，`docs/reference/design-system.md` 的硬规矩）。
- `RoleplayChat.tsx` 是**稿面而不是聊天**：一栏 640px 居中、与编辑器正文同宽，作者的回合只用一条 2px 赭石左规加一个小号名标区分，角色的回合直接落在纸上——没有气泡、没有左右分栏，因为气泡把每条消息切成独立单元而剧本要的是连续的稿面。它的输入框实时着色**只改颜色，不改字号字重字形**：那是一个 textarea 上盖一层镜像 div，任何度量差异都会让光标和字错位，而「边打边变」要传达的只是「标记生效了」。**它是 `AgentChat` 的第二份撰写区**——改一边就得把另一边的 band 顺序和嵌套一起改。
- `ScriptText.tsx` 是稿面这套混合文本的排版（`*动作*` / `「台词」` / 裸文本＝场景 / `[元指令]`）。

#### Agent 编辑与记忆区

- `AgentComposer.tsx` 是新建 / 编辑 agent 的二层抽屉，唯一复杂的东西是绑定选择器（左边条目、右边该条目的特征、勾到底部芯片行），计数 `3/6` 落在**条目行**上——作者可能有几十个条目、上百段特征，不点进去也要知道哪条已经绑了东西。
- `AreaPicker.tsx` 与 `AreaBrowser.tsx` 是记忆区：前者在编辑抽屉里只讲清**继承**（绑一个已存在的区，新角色一上场就记得旧事，包括上一个角色答应过、误会过、记错过的；删角色不删区；一个区同时只能挂一个角色，所以已占用的条目**显示但不可选**——藏起来作者会以为它不见了），后者是浏览与编辑，**必须一眼看出不是知识库**：知识库是世界的事实（格纸墙、硬阴影、按分类着色），这里是**某个角色以为的事**（横格纸内页、单色、细线分行、卡片不浮起），它可以和正典矛盾而那是特性，所以这里从不「纠正」、也没有任何同步回知识库的入口。
- `MemoryPanel.tsx` 是记事本（约定 / 待办 / 事件 / 关系）——设计稿没画这一屏：它做成**默认收起的第三栏**，因为稿面 640px 是整个面板不肯让步的一条，常驻会把它压到 640 以下；但入口带计数，因为它不是配置而是作品的一部分。

#### 转场与取材追溯

- `SceneTransition.tsx` 是转场，**就地向上展开而不是弹层**（作者一天可能用好几次），两支的差别用**一道线**表达而不是图标或第二个颜色：另起一场是断掉的线，接续是中间嵌一个赭石实心方块的线；三态（选择 → 生成中 → 预览确认）在同一块里原地替换。
- `TurnTrace.tsx` 是本轮取材条，回答「这一轮模型眼前有哪些条目和特征、为什么」，四种来源**不靠四种颜色而靠同一根线的不同终止方式**（常驻上下出血、知识库两端止笔、记忆区断成点线加斜体下沉、引用是作者轮那道 2px 赭石线——四段里唯一带强调色的装订，因为它唯一由作者负责）。
- `ArchiveViewer.tsx` 是封存场次的**只读**查看器：「新开会话」把上一场移进 `archive/` 一个字没删，但只留在文件里不算数——作者读不到它，「封存」在他的体感里就和「删除」没区别；只读是刻意的，能继续的会话只有一个，这就是「存档」这个词的全部含义。

### `src/components/sync/`

两个资源各一张模态，共用一条规矩：**下载的那个按钮不是合并的那个按钮。** `SyncPreviewModal.tsx` 是知识库同步的预览 / 执行 / 结果（设计稿 03c）——一张模态四个阶段，因为它们是作者正在走完的**同一个决定**（将要发生什么 → 正在发生 → 发生了什么），拆成几个对话框会恰好在镜像变得不可逆的那一刻丢掉线索。设计里三条规则承载了整个功能的安全性：**本地永远是左栏、远端永远是右栏**，不管跑哪个方向，只有箭头和染色在动（按方向换边会让「哪个是我的」每次都要重读一遍）；**只有会丢东西的行才着色**，两侧冲突给底色**加**强调左规、单侧丢失只给左规，其余几百行保持素色（再多着色就等于什么都没着色）。`ConfigRestoreModal.tsx` 是从服务器恢复应用配置（密码 → 预览 → 合并）：一次恢复会按 id 替换供应商、覆盖钥匙串条目，并在落地那一刻就改掉主题和面板宽度——按下「恢复」以为能先看一眼的作者，会发现这些已经全都做完了。屏上的数字一律来自**解密并重新校验过**的包，从不用信封自报的 `counts`：那个字段是自称的，一旦加密谁也验不了，把它画出来等于把一个作者会信的数字摆在一个没人检查过的数字前面。

## `src/lib/`

每个子系统目录自带 `__tests__/`（测 store 的在 `src/stores/__tests__/`，测组件的在组件旁边）。`src/lib/__tests__/` 只放两类没有子系统可归的测试：下面「根模块」那节的模块，和全库扫描的闸门——`testPlacement.test.ts` 守着这条，判据是**被测对象**而不是 import：根模块会在运行时伸手进子系统，测试打桩挡住那些手是正当的。

**`lib/` 不 import `stores/`**（值导入，静态与 `await import` 都算；`import type` 不算），`src/lib/__tests__/layering.test.ts` 守着，上限是 0。需要 store 里的东西就让调用方作参数传进来：agent 工具经 `ToolContext.appState`（`ToolAppState`：AI 设置、docx 格式清单），非工具的函数直接收参数（`resolveAsrConn(settings)`、`runIllustration(…, settings, …)`、`installCitationNavigation({ index, open })`、`resolveCommit(text, editorView)`）。过去这些都是函数体里的 `await import("../../stores/…")`——它躲过了打包器的环检测，却把 aiStore 和 loreStore 分别拉进了 agent 与 lore 的循环依赖（docs/feature/code-structure-plan.md P3）。

### `src/lib/ai/`

#### 流式协议层
- streaming client (`index.ts` dispatch on `familyOf(standard)`, `openai.ts`/`responses.ts`/`gemini.ts`/`anthropic.ts`/`dashscope.ts` adapters — five protocol families (the fifth is DashScope's native `/api/v1`, which shares `chatParams` and the `chatDelta` choice reader with Chat Completions — docs/api/dashscope-native-plan.md), Responses being OpenAI's second one on the same base and Bearer, with `instructions` + `input` items instead of `messages`, typed stream events, and `store:false` on every request
  - `Model.textVerbosity` goes out as `text.verbosity`, merged beside a structured task's `text.format` rather than replacing it, and the terminal event's echoed `reasoning.effort` / `temperature` is compared with what was sent — a mismatch becomes `wireRewrites` on the done chunk, in the API log and as a `round-done` row in the execution log, reported and never retried (`docs/api/gpt56-plan.md` P2 / P3)
  - slice-by-slice status in `docs/api/qianwen-compat-plan.md` §6 — `types.ts`)
- a refused request's body (non-2xx) is read by **one** function, `refusal.ts` `refusalText`, in all five adapters: the whole body or each `data:` line, the vendor's `message` verbatim plus the fields a reader of the thrown message matches on (`code`/`status`/`type`, `param`, `request_id`, a relay's `metadata.raw`) — `learned.ts`, `structured.ts` and `modelHealth` regex that message, so stripping a field the raw body carried is a silent regression. The connection test's `/models` refusal reads through it too; kept apart from `providerProbe.apiErrorMessage`, which answers "is this the API at all". `image.ts` / `asr/client.ts` still have their own `parseErrorBody`, because their fallbacks branch on the parsed `code` / `param` (`docs/api/refusal-plan.md` §4)

- **内部消息形状是 OpenAI 的**（`StreamMessage`，工具调用的 `arguments` 是 JSON 字符串）。Gemini 和 Anthropic 适配器各自带一个转换器（`convertToGeminiContents` / `convertToAnthropicMessages`），包括工具调用的往返和 data URL → base64 图片。Anthropic 那边还要守两条结构规矩：丢掉开头的 assistant 轮、合并相邻的同角色轮；合并进 tool_result 的作者文字会加上【作者消息】标签（`labelAuthorText`）。流式读取是 fetch + `ReadableStream` 按行解析。
- **Anthropic 的用量在进门时归一化**：应用里的 `cachedTokens` 是 `inputTokens` 的**子集**（OpenAI / Gemini 就这么报，`costOf()` 也按这个算），Anthropic 报的是三个互不重叠的桶，所以适配器求和：`inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，`cachedTokens = cache_read_input_tokens`。缓存写入比基础输入价贵，而计费组没有缓存写入价（只有输入价和缓存输入价），所以它落进全价桶——宁可多报，不少报。DashScope 原生每帧都带累计 usage，所以不发 `stream_options`。
- **`max_tokens`**：Anthropic 必填，`Model.maxOutput` 经能力规划（`capability/plan.ts` 的 `maxTokensOnWire`）进请求，没配时发一个常数；其他族它只用于规划。线上另一种输出上限只有任务自己的 `StreamOptions.maxTokens`，只在 Chat Completions 路径上发（今天只有 Sakura 翻译引擎设它）。
- **结构化输出与思考**：`agent/structured.ts` 要的是 `toolChoice: "required"`（Anthropic `{type:"any"}`），不点名工具。Anthropic 适配器以前在强制工具时发 `thinking: {type: "disabled"}`，这个绕法已经删了——adaptive 思考（默认方言）支持强制工具，而这一段里有几个模型直接拒绝 `disabled`；改之前看 `anthropic.ts` 的 `thinkingFor`。JSON 模式按协议族在 `jsonMode.ts` 决定：OpenAI 系 `response_format`、Gemini `responseMimeType`、Anthropic 没有 JSON-object 档，只有 `off` 与严格的 `json_schema`（`output_config.format`）。要 schema 保证而不只是「合法 JSON」的调用方走 `agent/structured.ts`。

#### 请求整形与工具选择
- the config→request seam (`conn.ts` — `ConnOptions` is **the one place** a provider/model transport field is declared; every arg type that carries provider wiring `extends` it, so a new field is one edit, not eighteen. See `docs/api/provider-layering.md`)
- per-protocol **and per-model** JSON-mode shaping (`jsonMode.ts` — the protocol decides the spelling, `Model.structuredOutput` decides the strength: `off` / `json_object` / `json_schema`, absent = auto → family default lifted to strict `json_schema` for model ids known to take it (OpenAI `response_format.json_schema`, the Responses family's `text.format`, Gemini 2.5+'s `generationConfig.responseJsonSchema` — a **standard** JSON Schema, so the same `strictify` output goes on the wire unchanged, unlike the older OpenAPI-dialect `responseSchema`)
  - and capped by what the endpoint has already refused with a 400 naming that field — `effectiveStructuredOutput` is the one answer the shaping, the 「将发送」 summary and the skip decision all read. A caller only says it wants JSON (`StreamOptions.structured`); the plan shapes it (`RequestPlan.json`) and `streamCompletion` puts it on the request and steps it down on a refusal
  - both learned refusals — this one and the forced `tool_choice` below — live in **one** store, `capability/learned.ts`: a ceiling per endpoint+model per fact, only ever lowered, read in memory and written through to `config.db` (`learnedDb.ts`, table `learned_ceilings`, loaded at startup, not in backups); a ceiling ages out after 7 days, and changing the model's structured-output declaration or probing it forgets it sooner (`learnedForget.ts`), with the classifier as data (`LEARN_RULES`: which error text refuses which fact, and only when the request used it). The table resolution never reads it; the facade `capabilityVerdict` lays it on when given the route's address, which is how the drawer's matrix shows `— · learned`
  - `jsonSchemaStrict.ts` adapts an output schema to strict mode's all-required rule on the way out and strips the resulting nulls on the way back, so the eight call-site schemas stay untouched
  - see `docs/api/structured-output-plan.md`)
- forced-`tool_choice` support — the endpoints that answer a forced choice with a 400 instead of honouring or ignoring it (DeepSeek V4, which always thinks): learned from that 400 into the shared store and re-sent with `auto`
- `streamCompletion` is **the one fallback executor**: before the first chunk, an error that refuses something the plan actually sent is learned, the request is planned again and re-sent — every retry sends strictly less, so it ends within three (LLD §9.13)

#### 服务端工具
- server-side tools (`serverTools.ts` — tools the *endpoint* runs inside one request, **spelled per `(platform, family)`, never per standard**: `platforms.ts` holds the platform profiles, keyed by the provider row's `platform` (inferred from the host when a row never stored one; an official standard is always its vendor), so DashScope's private body fields reach DashScope only — before it, every `openai_compat` row (DeepSeek, relays, Ollama) got them; a protocol-native tool on a platform that lists none is offered as 未实测.
  - **Whether** a wire has a capability at all — a server tool, whole-PDF input, DashScope's hi-res / clip-fps knobs, forced `tool_choice` — is one table, `capabilities.ts` — a facade since the capability-resolution P1, the tables and the verdict under `capability/` (`facts` · `rules` · `modelId` · `conditions` · `cells/platform` · `cells/upstream` · `cells/catalog` · `resolve` · `values` · `intent` · `learned` · `plan` · `media`; `docs/api/capability-resolution-lld.md`). Everything keyed by model id is rows of one `ModelPattern` type (exact · prefix · regex), consulted most-specific first: per-platform capability rows and calibrations in `cells/platform.ts` (matched on the raw id), model-intrinsic facts — output caps, the strict-schema list, non-reasoning ids — in the global catalog `cells/catalog.ts` (matched on `canonicalModelId`: the id less its `vendor/` namespace and, on a relay, less the owner's prefix — the channel's prefix-table row, else a leading `[…]` — carried as `ConnOptions.canonicalModelId`) — (platform × family × capability, model id as the third axis; `capabilityVerdict` → `yes / unknown / no` + a reason code), rendered as `docs/api/capability-matrix.md`; a `private` capability is `no` on any platform that has no cell for it, so a new vendor field cannot leak by omission (`docs/api/capability-gating-plan.md`).
  - **What a request carries** is decided once, by `planRequest` (`capability/plan.ts`): effort on the wire, temperature, the tool choice and why it was downgraded, the server-tool ids, the JSON tier, `max_tokens` for the Messages API, and the rest. `streamCompletion` hands the plan to the adapter as `_plan`; the five adapters and the 将发送 line (`modelSummary.ts`, one `Record` of per-family spellings) only spell it. A decision added to an adapter instead of the plan is what `plan.test.ts` catches.
  - **Which media a request carries** is the plan's too: `RequestPlan.media` (`capability/media.ts` `admittedMedia` — three layers: what the family's adapter can spell at all (`spelledMedia`, always applied), the model's declarations, which `ConnOptions` carries as `modelType` / `videoInput` / `pdfInput`, and the route's `videoInput` / `pdfInput` cells, asked only about a declaration — a hand-built probe sends whatever the protocol spells). `streamCompletion` projects the messages through it (`mediaParts.ts` `admitMedia`) before anything reads them, so a clip or picture attached under another model goes out as a note and the history is never edited; the composer's clip gate (`canReadVideo`) and the PDF subagent's eligibility (`readsPdf`) read the same answer via `conn.ts` `admittedMediaOf`. The adapters' `unsendablePart` throw is only a backstop (`docs/feature/video-input.md` §4). A clip's `fps` rides the same projection: `RequestPlan.clipFps` (`capability/media.ts` `clipFps`, from `ConnOptions.videoFps` and the `videoFps` cell) is written onto — or stripped from — a copy of every admitted clip, whatever fps it was attached with; `sentVideoFps` (via `clipFpsOf`) and the 将发送 line read the same answer. The agent runtime weighs its history through the same projection (`plan.ts` `mediaProjection`) for trimming, the thinking guard and the checkpoint, so it cannot under-count what the request's pre-flight will count; compaction and the context bar still weigh the raw history.
  - The **value facts** a model row may leave unset — the thinking category (at 自动), the context window, the output cap — resolve along the same chain (`capability/values.ts`): the author's value → the platform's row for the id (only a category the route can spell) → the catalog (caps only) → the family's default / the app default. Every value travels with its source, and each consumer trusts only some (`capability/intent.ts` `TRUST`): planners take any, but the Anthropic `max_tokens` and the pre-send window gate take only the author's (D2). `connOptions()` carries the sources as `ConnOptions.provenance`; every budget, ceiling and forecast reads `plannedLimits` / `plannedLimitsOf` (`conn.ts`; `usePlannedLimits` in components), never `model.contextSize`, so the forecast and the run plan with the same numbers. The drawer still prefills the platform's values; a blank row resolves to the same ones (`values.test.ts`).
  - Whether a request **thinks** has one definition, `wireThinks` (`capability/conditions.ts`), from the category's `offSpelling` / `unsetThinks` data and the effort after `effortOnWire`; `thinkingIsOn` is only the toggle's display. What a request does to a capability — function tools beside it, thinking on or off — is rule data (`rules.ts` `unless`), evaluated in the verdict; the adapters pass the request's context and never re-judge it. A rule's `official: "yes"` answers on the vendor's own standard only (`promptCache`).
  - On a relay (`newapi` / `custom`) the same model id behaves differently per **upstream** behind it (Kiro, CC, anti, Bedrock for Claude; Codex account pools and a guarded gateway for GPT — each profile scoped by `models`). Which upstream is the author's data — the channel's prefix → upstream table (`Provider.upstreamPrefixes`) and the model's own choice (`Model.relayUpstream`) — resolved by `relayUpstream.ts` (model → longest prefix → a product name in the id → none) in `connOptions()` into `ConnOptions.relayUpstream`; what each upstream does is `UPSTREAM_CELLS` in `capability/cells/upstream.ts`, consulted before the platform's cell. Every capability question about a model passes `capabilityModelOf(opts)`, never a bare `{ modelId }` — a caller that drops the upstream disagrees with the adapters, and `capabilityConsistency.test.ts` catches it. Relay owners' prefixes (`[CC量]`) never go in code (§8.11). Where a wire does not take `instructions` (`instructionsField`, the gateway upstream) the Responses adapter sends the system prompt as a leading `developer` message; everywhere else `instructions` is always sent (§8.12).
  - `platforms.ts` keeps addresses, routes and cost reporting; every asker (adapters, 「将发送」, drawers, the chat surface) calls `hasCapability` / `capabilityVerdict` directly — there are no per-capability wrappers — and `capabilityConsistency.test.ts` holds each asker's actual request against the table.
  - The model's declaration is the author's grant and **stays when the wire can't say it** — `effectiveServerTools` is what a request carries, `serverToolsSent` is what any capability promise (search subagent, page reading, list marks, context estimates) reads, never the raw row (`docs/feature/channel-model-route-plan.md` §4, §11):
  - `web_search`, spelled as Anthropic `tools[]` entries on MiniMax-M3, as top-level `enable_search` on DashScope's Chat Completions, and as built-in `tools[]` entries on both Responses standards — DashScope's tool on compat, OpenAI's own search on the official endpoint, whose `web_search_call` items also carry `open_page` / `find_in_page` actions (a `url`, no queries) — with every other id filtered off the official wire;
  - plus `web_extractor` (网页抓取), **only ever beside `web_search`** because DashScope refuses it alone — `search_strategy: agent_max` on Chat (dropped from any request carrying function tools — DashScope's "agent mode" 400s on the pair, so agent rounds there search without reading pages), `{type:"web_extractor"}` on Responses, where the calls stream back as `web_*_call` items and reach the execution log;
  - plus the two image searches `web_search_image` (以文搜图) / `image_search` (以图搜图), Responses-compat only, independent switches because they bill far above search, their items carrying JSON-string `arguments` / `output`;
  - plus `code_interpreter` (代码解释器) — the one id that is not a web tool and, on DashScope, the one **gated by model id** (the `code_interpreter` cells in `capabilities.ts`, a measured id table per wire; the drawer shows the switch only for a matching id), `enable_code_interpreter` on Chat compat but **dropped from any request that carries function tools** (the wire 400s on the pair), `{type:"code_interpreter"}` on Responses compat, where it sits beside function tools but is **dropped when thinking is off**, its `code_interpreter_call` items reaching the log as code + printed output;
  - on the **Gemini** wire the three ids are bare `tools[]` entries beside `functionDeclarations` (`geminiServerTools`): `web_search` → `{googleSearch:{}}`, `web_extractor` → `{urlContext:{}}` (still only beside search — one meaning per id, though Gemini would take it alone), `code_interpreter` → `{codeExecution:{}}`, none dropped per request (measured 200 beside function tools, a forced call and a response schema). `web_search` there is protocol-native — offered as 未实测 on the official and relay platforms; the other two only where a cell was measured (OrcaRouter's Vertex route, a platform-level cell, no model-id gate). Reports come from three places — code parts, `urlContextMetadata` on the first block, `groundingMetadata` on the last — read by `createGeminiServerToolReader`, one per request, whose ids carry a request prefix because the log replaces rows by id across rounds and drafts; the tools' own input (`toolUsePromptTokenCount`, outside `promptTokenCount`) is counted as input tokens (`docs/api/tools.md` §5.1);
  - a live search subagent takes only the web ids from the main model (`"no-web"` policy — `routeTools` / `nonWebServerTools`);
  - requests the app makes on its own send **no** server tools — structured tasks, compaction, the background summaries in `memoryStore` / `digestStore`, Sakura translation (`translate/run.ts`) and the lore gallery's image description (`lore/vision.ts`) override the field the model row carries (work on text or a picture already in hand has nothing to look up or compute, and a declared interpreter alone costs ~800 input tokens a request; `backgroundSummaryServerTools.test.ts`, `translate/run.test.ts`, `lore/vision.test.ts`);
  - nothing to execute locally, so they never enter the agent registry — measurements in `docs/api/landscape.md` §7 第六个样本「代码解释器」)

#### 供应商、路由与探测
- provider config storage (`configDb.ts`)
- channels × routes (`routes.ts` — a provider row is a **channel**, one key on one platform, with one **route** per protocol family at host + path (a path left empty follows the platform's convention in `platforms.ts`);
  - a model takes one route (`activeRoute`) and keeps the fields that change with the protocol per route (`RouteProfile`, parked in `Model.routes`).
  - **The flat fields are always the current route's** — the channel's primary route on the row, the model's current route on the model — so anything asking a protocol question about a model goes through **`providerFor(model, providers)`**, never `providers.find(p => p.id === m.providerId)`, and `resolveConn` hands back the routed view the same way;
  - stored as two JSON columns, migrated at read time byte-for-byte (`docs/feature/channel-model-route-plan.md` §12)
- merging two channels that are one key (`channelMerge.ts` — detect only, the author confirms; the one operation that deletes model ids, references re-pointed in the same step)
- Gemini safety settings (`safety.ts`)
- remote probing (`providerProbe.ts`)
- endpoint limit probing (`endpointProbe.ts` HTTP + `probeAnalysis.ts` pure judgement — measures a model's real context window / output cap; see `docs/reference/architecture.md` → Endpoint probing)

#### 输出、草稿与片段库
- per-reply output caps (`modelLimits.ts` — the built-in table, the app-wide default and the Messages API's own `max_tokens` default; the resolver is `capability/values.ts`, see below; `docs/reference/architecture.md` → Large outputs)
- multi-draft output vocabulary (`drafts.ts`)
- the snippet library's pure layer (`snippets.ts` — grouping/search/hit-slicing shared by the picker and Settings → Prompt, so both surfaces section a library the same way; see `docs/feature/prompt-snippets-ui-brief.md`)
#### 计费与用量
价格在**计费组**上（`feeGroup*`），模型只持有 `feeGroupId`；用量行由 `usageRow.ts` 的 `recordUsage` 唯一入口写两处（项目库 + `config.db`），行上自带当时的价，`costOf()` 是唯一的算式；读那一侧（`usage.ts`）、给老行补分项（`usageBackfill.ts`，唯一改写历史行的地方）、用量条分段（`usageMeter.ts`）、上游报价换算（`reportedCost.ts`）各一个文件。**逐文件的分工、不变量和理由都在 [`docs/feature/billing/01-fee-groups.md`](../feature/billing/01-fee-groups.md) 的「模块」一节**，改这些文件之前读那里；硬规则在 `AGENTS.md`「计费与用量」。

#### 图片与日志
- **which endpoint an image model draws through** (`imageRoute.ts` — `effectiveImageRoute`: the declared `ImageCaps.route`, else a `Record<ProtocolFamily, …>` default by the family of the model's *current* route, so 自动 on DashScope's native route is `dashscope`). The only derivation: the client (`generateImage`, fed by the one conn builder `imageConnOf`), the generate modal, 「将发送」, `defaultImageCaps` and the drawer (`panes/imageCapsDraft.ts`) all read it; `asyncTask` only through `effectiveAsyncTask`. `chat` / `comfyui` / `ark` are never derived, so a declaration read is fine for those three and **forbidden** for the other three — `src/lib/__tests__/imageRouteOwner.test.ts` scans for it. See `docs/feature/image-route.md`
- the one builder for an image content part (`imagePart.ts` — eight call sites hand a picture to a model, and the `detail` hint the author sets (`app:imageDetail`: unset = send no field, which is what every endpoint reads as `auto`) has to reach all eight or none; only ① and ② have a spelling for it, and they put it in different places — see `docs/api/landscape.md` §1)
- `apiLog.ts`
- `tokenEstimate.ts`

### `src/lib/agent/`

All AI features run on the **unified agent runtime** (`src/lib/agent/runtime.ts`): a per-preset tool loop dispatched via the tool registry (`registry.ts`, entries in `toolTable/`).

#### 三层工具（读 / L1 / L2）
- Read tools (`toolTable/read.ts`), including `read_slides`, which pages a deck by slide — a .pptx because `read_file` can only return zip noise for one, an .html because finding slide 7 by paging 4000 characters of source is not a way to edit it; see `docs/feature/pptx-plan.md`.
- L1 auto+backup write tools for lore/memory, and the L2 manuscript tools that block on user approval — `propose_edit` for a find/replace — the Nth occurrence or all of them, so repeated text in a deck or a table is addressable at all
  - `rewrite_lines` for a region named by line numbers, which is how a LONG file gets restructured without re-emitting it
  - `rewrite_document` for a whole short file.
- All three are one `EditProposal` machinery apart from the last: the proposal records how many times `find` occurred when the author saw the card, and `editApply.ts` refuses to write if that moved.

#### Lore 写入门控与执行日志
- Lore writes are additionally gated on an author-approved plan (`plan.ts` + `propose_lore_plan` → `components/ai/PlanCard.tsx`): one card of steps per pass, and the write tools refuse any entity/action it doesn't cover.
- Runs emit structured `AgentEvent`s (`events.ts`) feeding the shared execution-log component (`components/ai/AgentLog.tsx`).

#### 轮次上限卡与作者决策卡
- Hitting the preset's round cap mid-work doesn't force-end the run: the runtime's `onRoundLimit` callback blocks on a 继续/收尾 card (`RoundLimitCard.tsx`, queued in agentStore like approvals) — wired only where that card can render (chat, AiPanel; not lore modals or batch runs, which keep the hard stop).
- The agent can also put a decision to the author mid-run: `ask_author` (2–4 options plus the card's own always-present free-text row, `QuestionCard.tsx`) blocks its tool call on the answer, and routing appends the tool only for surfaces that render the card — chat and the non-batch AiPanel; design: `docs/feature/agent/ask-author-plan.md`.

#### 对话式助手与多会话
- The conversational assistant (AiDrawer "chat" mode → `components/ai/AgentChat.tsx`) and the AiPanel Agent mode both use the full-toolset `AGENT_ASSIST_PRESET` — except that chat behind the 助手工具包模式 Beta swaps to the thin `ORCHESTRATOR_PRESET` (`lib/agent/packs.ts`: reads + memory + notes only, every write dispatched via `run_pack` to a pack sub-run on the parent's own model, with the parent's approval channels and plan gate passed through so cards render where they always do; `chatAgentPreset()` is the one seam every chat-side reader goes through, and the default stays off because dispatch reliability is model-tiered — see `docs/feature/agent/tool-pack-plan.md`).
- Chat session state lives in `stores/agentStore.ts` — **several conversations at once**: `chats: Record<key, LiveChat>` + `activeChatKey` on one axis, `runningChats` / `chatQueue` (semaphore in `lib/agent/scheduler.ts`, shared with roleplay) on the other
  - components read the on-screen one through `useActiveChat`, every card a conversation raises is tagged `surface: chat:<key>`, and its 本次都批准 key is `chatAutoApproveKey(key)`, never a shared literal — see `docs/feature/agent/chat-sessions-plan.md`.

#### 结构化输出
- structured JSON outputs go through `lib/agent/structured.ts` (forced tool_choice + JSON fallback — and the forced attempt is **skipped outright** when the endpoint is known to downgrade a forced `tool_choice` *and* strict `json_schema` is available, because then the fallback enforces the same schema and the attempt only buys an `EMPTY_TOOL_CALL` and a second request; only `json_object` to fall back on and it still tries the tool, since one tool call beats valid JSON whose shape rests on prose). Design & history: `docs/feature/agent/unified-agent-plan.md`.

#### 历史压缩、回溯与状态记忆
- Chat history is compacted, not just trimmed: folded/summarized old turns plus a per-turn injection ledger live in `lib/agent/compact.ts` + `compactRun.ts`, wired into the chat run (`stores/agent/chatJob.ts`); design: `docs/feature/agent/chat-memory-plan.md`.
- A question can be rewound to (`lib/agent/rewind.ts` — a *cut* of the wire history at that turn's start, never a re-seed, and never offered for a turn already folded into the summary: what the author still sees above the cut must be what the model still holds; §12 of the same doc).
- Behind the 状态记忆 Beta (`lib/agent/stateFlag.ts`) a conversation can instead run on a SKILL.state-style **structured execution state** (`skillState.ts` schema/validation/rendering + `skillStateRun.ts`, arXiv:2608.26263): every send folds everything before the last turn into one schema-validated JSON block in the summary's slot — the same `planFold` with `keepTurns: 1`, so the fold invariants are unchanged — and a state the model twice fails to make valid leaves the history alone and falls back to ordinary compaction
  - the mode is per session (`ChatSessionMeta.stateMode`, the composer chip mirrors it; the Lab sub-option 「新会话默认打开」 only sets where a *new* conversation starts — `freshChat` / `newChatStateMemory`), see `docs/feature/agent/skill-state-memory-plan.md`.

#### 长输出恢复

`outputRecovery.ts` 在项目 SQLite 中原子保存可见正文，每 1.5 秒一次、同一输出串行写入。恢复不重放工具历史，`outputRecoveryStore` 用新文本请求追加内容；两种写作表面共用，项目和模型绑定运行起点。见 [`long-output-recovery.md`](../feature/agent/long-output-recovery.md)。

#### 任务工作区

Long tasks persist to a durable workspace instead of just wire history: `.ai-writer/tasks/<taskId>/task.md` (goal + step checklist) and `notes/*.md` (intermediate results), written via scratchpad tools (`lib/agent/scratchpadTools.ts`) and resumed into a fresh context rather than replayed (`components/ai/TaskWorkspaceView.tsx`).

#### 子代理委派

- Auxiliary work (web search, vision, long-document reads, image generation) can be delegated to per-kind subagents, so it doesn't bloat the main run's context.
  - `lib/agent/subagentModel.ts` holds the kinds, bindings and connection resolution that the tools, `routeTools` and settings panes ask.
  - `lib/agent/subagent.ts` holds only `executeDelegate`, the half that runs a nested agent and so the only half allowed to import `runtime` — the split is what keeps the image / translate / ASR tools out of the agent import cycle, docs/feature/code-structure-plan.md P1.
  - The three places a tool starts a nested run — `delegate`, `run_pack`, the writer handoff — never import `runtime`: `runAgent` fills `ToolContext.subRun` (`SubRunner`: itself plus the toolCost ceiling seam) on every context it hands its tools, and passes itself to `runWriterHandoff`; importing it back would close a cycle through the registry, P2.
  - Configured in Settings → `components/settings/panes/SubAgentsPane.tsx`, session-level toggles in `components/ai/CapabilityMenu.tsx` on the composers and `components/ai/SubAgentChips.tsx` in 一致性检查's pre-run block — two renderings of one control, sharing `components/ai/subagentChipModel.ts`; 设计稿 02g 屏 1c.
- Design: `docs/feature/agent/subagent-lld.md`.

#### Writer 子代理

- The **writer** subagent (`lib/agent/handoff.ts`) inverts that contract and is therefore not a `delegate` kind: its output *is* the turn's answer rather than a summary, and no model chooses it — with the switch on, the chat assistant's run ends by handing a **work order** to the writer (`finishPolicy: "handoff"`, applied by `routeTools` only for surfaces that opt in), whose text streams straight into the turn.
- Prose is not an accepted ending on that preset, and the writer never writes to disk: `deliverTo` on the brief makes the *runtime* build the proposal, so the bytes never pass through a second model.
- Design: `docs/feature/agent/writer-subagent-plan.md`.

**文件怎么分（P6，docs/feature/code-structure-plan.md）。** `registry.ts` 只是入口：工具表的类型在 `toolTypes.ts`（`registry.ts` 用 `export type *` 原样转出，外部照旧 `from "./registry"`），工具条目按领域分在 `toolTable/` 下十个片段里（`read` · `lore` · `collectors` · `manuscript` · `exports` · `image` · `manuscriptDelete` · `scratchpad` · `roleplay` · `subRuns`，共用的参数解析与描述构造在 `toolTable/shared.ts`），`registry.ts` 按固定顺序把它们展开回 `REGISTRY`——**这个顺序就是发给模型的声明顺序**，`search_tools` 的目录和 Anthropic 的缓存前缀都跟着它，`toolDefinitionsSnapshot.test.ts` 逐字节钉住拆分前的输出。加工具放进它领域的片段；`manuscriptDelete` 单列一个片段正是因为那两个删除工具在线上排在图像工具之后。写工具同理：`writeTools.ts` 只做转出，实现按原来的分节在 `write/` 下——`planGate`（方案门与破坏性步骤的暂停）· `loreFiles` · `loreAssets`（图集、头像、跨条目复制、搬移与删除条目）· `memory` · `manuscript`（L2 提案与落点回执），`write/shared.ts` 放它们共用而谁也不拥有的东西（提案 id 计数器，快照上的两个辅助），这样模块之间不绕圈。

unified agent runtime 的各模块：

#### 运行时核心

- `runtime.ts` loop
- `registry.ts` tool registry（条目在 `toolTable/`，类型在 `toolTypes.ts`——见上面「文件怎么分」）
- `presets.ts` per-task config
- `tools.ts` handlers + path containment
- `events.ts` execution-log events——其中 `ChangeRecord` 是 L1 写入交回来的**「改成了什么」**：这些写入调用即落盘、作者那一票发生在更早的方案卡上（卡上只有模型自己写的一句打算），所以在此之前没有任何地方给作者看过真正写进去的字，日志那一行只有工具名与截断到 400 字的原始 JSON；记录落在本来就免费的地方——handler 为了备份已经读了旧文（`backup.ts` 的 `snapshotFile` 把它读到的那份顺手交出来）、也握着新文，由 lore 层拼装的那几个则读回盘上的结果（`changeAfterWrite`，理由和写入回执一样：记录该说落了什么而不是打算写什么）
  - 两侧各 4000 字封顶且**超了就一起丢**（只留能装下的那一侧会被读成「整份都是新加的」——那是断言不是省略），字数与 `backupPath` / `path` 照留，完整的旧版新版本来就在盘上
  - 只有产生前后两份**文本**的写入才有它：归集改的是成员、头像改的是字节，那些改动由方案步骤自己说清
  - 它也是「本次对话都批准」之后唯一还读得到改动的地方
  - 正文写入（`propose_edit` / `rewrite_*` / `insert_lines` / `append_file` / 新建与删除文档）批准之后也交一份（`writeReceipt`，读回落盘结果，`autoApproved` 标出没人读过的那几次）；两侧超出上限时改存有界的窗口（`ChangeRecord.diff`：最多 6 扇、每侧前两行、每行 300 字）——章节几乎总是超限，只剩字数的记录等于回到卡片改版之前
  - 批准一个正打开的文档时改动走编辑器缓冲，所以批准后的写盘（`lib/agent/proposalApply.ts` 的 `flushEditor`）立即 `saveNow`：不然读回的是 2 秒自动保存之前的旧文，记录说什么都没改、指纹让之后的撤回误判「改过了」

#### 压缩与方案账本

- `compact.ts` chat-history compaction planning — its trigger is `compactTriggerFor`, the lowest of three lines (the author's token slider, the author's window-ratio slider × the model's window, and the classic `COMPACT_TRIGGER × message ceiling`, which the sliders can only ever pull *earlier*), read by the store, the context bar and the settings readout so all three name the same number
  - 自动归纳 off skips the automatic fold entirely and leaves 立即归纳 (chat **and** roleplay — `lib/roleplay/run.ts`'s `compactSceneNow`, whose summary-to-disk + memory-block refresh are the same `afterCompaction` step the automatic path runs) — see `docs/feature/agent/compact-threshold-plan.md`
- `plan.ts` lore-plan gate — whose steps carry a **target** axis (entity / collection / category) so a reorganisation is one step per collection *or category* rather than one per entry, which is the difference between a card the author reads and one they rubber-stamp; that axis also decides which deferred tool group a run loads (`planLoadsEntityWrites` / `planLoadsOrganize` — a `category`+`move` step loads `lore_write`, because `move_lore_entity` is what carries it out)
- `planLedger.ts` 把批准过的方案做成这一轮的账本（设计稿 02h 1i）——方案卡以前一批准就消失，之后的写入各落各的，只剩工具行和 400 字 JSON；现在每一步长出回执（已写入 · +a −b · 展开）。**哪次写入属于哪一步由门自己记**（`plan.recordMatch` 按工具调用 id 存进 `PlanGate.matched`，运行时抄到 `ToolStep.planStep`），UI 不重新匹配——第二个匹配器迟早会和门说法不一；按调用 id 而不是「上一次命中」存，是因为同轮工具调用可以并发。账本从落盘的回合日志里建，所以重启之后还在；`summarizeTurnWrites` 给「本轮写入」带子算数（文档按路径去重、条目按实体去重、删掉的段数取自改动窗的摘要）
- `destructive.ts` 决定哪些**已批准**的知识库步骤仍要停下来问（设计稿 02h 1g）：删条目，或替换超过六成正文（按去掉 frontmatter 的正文算，字级；正文不到 200 字的不停——把「待补充」补成正文不该触发）。写入工具在门放行之后、落盘之前调 `pauseForStep` 出一张 `loreStep` 卡：批准时这边什么都不 apply，由写入工具自己写；跳过只跳这一步（`PlanGate.skipped`，账本显示「已跳过」），模型被明确告知方案其余照旧。这张卡不在 `AUTO_APPROVABLE` 里——方案本身就是那一层的授权，这张卡正是为它不该覆盖的两类步骤而设。删条目的卡还会扫一遍文档找 `[[lore:…]]` 引用（`citingDocuments`，按渲染器同一套名字 → 别名 → category/id 解析），那是条目一删就再也查不出来的事
- `undo.ts` 是账本里的撤回（设计稿 02h 1h / 1i）：**只撤回还是那次写入原样的文件**——按 `ChangeRecord.afterHash` 比对（正文超出记录上限被丢掉之后指纹还在），本轮稍后的写入碰过同一文件就点名拒绝，作者手改过就说「最后改于今天 14:03（可能是你手动改的）」——时间按路径问 `fs_stat`（`lib/fs/modified.ts`；删文档卡的「最后改于」也是它），不挂在 `FileNode` 上，那棵树每次打开项目整棵读，是谁改的仍说不出，删掉的文件或条目原位已被占用就拒绝；撤回全部从新到旧做，撤回本身也先备份被覆盖的那份；撤回之前先保存编辑器里没存的字（让「改过了」看得见它），之后重新载入或关掉打开的文档。每次尝试作为 `undo` 事件追加进那一轮的日志并落盘（`agentStore.undoTurnWrites`），账本据此显示「已撤回」或拒绝原因，`logModel` 跳过这种事件不当作行

#### 工具组加载与检索

- `organizeTools.ts` the collection/category tools that ride on it (deferred `lore_organize`, loaded **by plan shape**)
- `toolSearch.ts` `search_tools`——另一种延迟组：`file_ops`（改名/复制/删除/新建章节与目录）和 `image`（三个画图工具）没有门，只是多数对话用不到，所以由模型自己要。目录只列这次运行真有的组；模型不搜直接点名时当场装上并让它再调一次；同一段对话用过的组下一次运行开跑就装上；`TaskPreset.residentGroups` 让以此为本职的预设（文件 pack、旁白）照旧常驻——见 `docs/feature/agent/agent-tool-context-lld.md` §6

#### 写入与编辑工具

- `writeTools.ts` L1/L2 write handlers（只做转出，实现在 `write/`——见上面「文件怎么分」）
- `editApply.ts` where an approved find/replace lands, plus the line-range slicing behind `rewrite_lines` — the occurrence count recorded on the proposal is what lets a targeted edit refuse a file that moved on——而 `locateMatches` 把每一处命中的行号与上下文行也在建提案那一刻记下来（那时文件正文就在手上），卡片才说得出「改在哪」而不只是「改成什么」
- `lineEcho.ts` 行号契约的两半——`read_file` 每行带行号（模型才能**指名**一个区域而不是把它抄进 `find`），以及写入批准后的回执带回新行区间、位移和应用后的片段，**那正是它取代的那次重读**（位移从落盘后的文件量出来，不从发出去的文本推算：换行符的归属有三处可以差一行，而差一行是静默的、错的是**下一次**编辑）。这些全部是**运行时输出而不是 schema**——棘轮只剩 65 token，而规则在它生效的那一刻到达本来就比写在几千 token 之前更管用；见 `docs/feature/agent/edit-loop-plan.md`
- `htmlTools.ts` the `inspect_html` verifier —— 这条链上唯一一个**验**而不是**写**的工具：模型看不见自己画出来的页面，所以把它渲进 `lib/pptx/harvest` 那个离屏沙箱，回报盒子有没有掉出幻灯片、有没有一页什么都没画、有没有图没加载上（判定在纯的 `lib/pptx/inspect.ts`）。**一行 `harvester.js` 都不用改**——每个盒子本来就带着相对本页的 box，`canvas` 就是第一张幻灯片自己的矩形，所以「超边界」只是两次比较；而没有分节的长页面是一张和自己一样高的幻灯片，因此**不会**把整页误报成溢出。见 `docs/feature/agent/edit-loop-plan.md` §6
- `splitTools.ts` the facet-split collector — the only tools that write nothing anywhere, existing purely so the split arrives as one tool call per facet instead of one hand-escaped JSON blob

#### 图片历史

- `imageHistory.ts` the message-level predicates for pictures and clips in the wire history; the part rule it applies (the words stay, only the payload goes) is `lib/ai/mediaParts.ts` `withoutParts`
- `chatImages.ts` the mirror of that on the way back — where a picture link **the model wrote** resolves (the project root, since a chat turn is not a file) and which ones are refused unread; see `docs/reference/architecture.md` → Images in context)
- `imageLease.ts` 按**轮**给图片计租期（`IMAGE_LEASE_TURNS = 1`）：一轮里的图（作者附的与工具读的）保留到其后又有一轮**答过的**对话，再下一轮开头去像素留文字（没答出来的失败一问不算轮）；留下的那句不点名工具（有看图子代理时主模型没有 `read_image`）。**只在 `chatJob` 里新问题入历史那一刻调**，从不在一轮中间——那时模型正看着它们，改前缀还会在每个工具轮次打掉前缀缓存。`trimHistory` 的 3 条 / 24 MiB 两道上限照旧，先到者生效
- `pasteImages.ts` · `chatStash.ts` 输入框贴图（`docs/feature/agent/chat-image-paste-plan.md`）：**贴图 = 会话暂存区里的一个真文件**（`.ai-writer/tmp/chat/<stashId>/<内容哈希>.<ext>`），之后按 `@` 附图原样走。`pasteImages` 是纯判定（剪贴板有文字就贴文字；四种格式白名单；贴图序号）。`chatStash` 管生死：`stashId` 首次贴图才生成，存进会话 blob 并镜像到 `chat_sessions.stash_id` 一列；作者删会话立即删目录，其余死法（SQL 自动修剪没有回调、没发过的标签页没有行）交给**对账式清扫**——每个项目每次启动一次，不被任何会话认领且超过 24 小时才删（宽限防另一个窗口里已贴未发的会话被误删）。【附图】块（`chatRefs.ts`）因此每行带项目相对路径，暂存图注明随会话删除：像素退场后模型能按路径读回（`read_image`，有看图子代理时委派它），也不会把暂存路径写进正文

### `src/lib/lore/`

AI-driven lore generation/improvement lives in `generator.ts` (UI in `src/components/lore/`).

lore domain model (`model.ts`), entity scan/CRUD (`entity.ts`), knowledge-base **collections** (`collections.ts` — the second axis, orthogonal to category: which body of work an entry belongs to, multi-membership, stored as a `collections:` frontmatter list rather than a folder level because `dirPath` is already persisted by pins / `[[lore:…]]` / roleplay bindings / sync hashes; plus the **取材范围** fence, whose one rule is that it narrows *automatic discovery* only — pins, `@` refs and citations always pass through. See `docs/feature/lore/lore-collection-plan.md`), gallery/avatar (`gallery.ts`), AI generation (`generator.ts`), `[[lore:…]]` citation resolution/navigation (`citations.ts`), AI-assisted facet splitting (`splitter.ts`), facet **slots** — the authoring side of a category's type schema, i.e. the checklist prompts inject and the defaults a new facet materialises (`slots.ts`, `categories.ts` for the orphan/assignable split); the **category note** (`categoryNote.ts` — `<category>/index.md` in the same folder-note format, summary only, read at `list_lore_entities` call time and never carried on `LoreIndex` — the wall's summary line reads it separately into `loreStore.categoryNotes` — written by `manage_category`'s `describe` under a `category/update` plan step; the cheap half of `folder-note-plan.md` §4.2 — `status` and `title` wait for the entry-status step; **not** hashed by `lorehash.rs` nor bundled by `transfer.ts`, both of which walk entity folders only — the note is local until categories get an identity of their own, plan §8); import via `lib/lore` (index re-exports all but generator). Entities can be split into **facets** (sub-entity granularity — e.g. one outfit of several) so injection isn't all-or-nothing; layered-budget facet selection lives in `lib/context/loreSelect.ts`. See `docs/reference/architecture.md` → Facet-aware lore selection; design: `docs/feature/lore/lore-facet-plan.md`

### `src/lib/batch/`

clause splitting for batch runs (`clauses.ts`: heading/numbered mode detection)

### `src/lib/diff/`

「改了什么」的纯计算层，为审批卡片而建（`docs/feature/agent/approval-card-ui-brief.md`）。

- `myers.ts`——**带上限**的 Myers 贪心搜索。先掐掉公共前后缀（一处小改在三千行里就只搜那几行），超过 `MAX_LINE_DISTANCE` 返回 `null` 而不是给一份读不动的答案：两份毫不相干的文档「diff」出来是三千行红压着三千行绿，比一句「整篇替换」说得**更少**，所以算力上限和可读性上限是同一条线。
- `tokens.ts`——行内切分，**中日韩逐字、拉丁逐词、空白成串**。通用 diff 库按空白切词，一整段中文只切出一个 token，「金发→银发」就退化成「整句被替换」。
- `index.ts`——出 `diffInline`（find/replace 那种短文本）与 `diffDocument`（行级 + hunk + 成对行的行内详情）。**折叠阈值 `context` 是参数不是规矩**：这一层只回答「改了什么」，「显示多少」是卡片的事。两条边界：行内详情只配给**等长**的删/增行对（跨长度配对出的错是把两行无关的句子画成一次改写）；`stats.whitespaceOnly` 单独一条（只动缩进/换行/行尾的改动要一眼可辨，而「格式整理」里**不是**纯空白的那部分恰恰是这个功能要抓的）。行号按 `editApply.countLines` 的算法数：末尾换行不制造一个空的末行。
- `windows.ts`——卡片那一层的模型（设计稿 02h 1z A/B）。一处改动一扇窗，窗里前后各两行原文做定位，**删行永远在加行上面**（视线先过要失去的）。字级高亮是**有条件的点亮**：改动行 ≤ 3 且 Dice 相似度 ≥ 0.5，低于就写「整段替换」并熄灯（标出两句不相干的话共有的那几个字，是噪音穿了信息的衣服）。同一种替换重复 ≥ 10 处时只画 2 扇、上下文收成 0 行并报数。宽度相关的数（上下文行数、窗数上限）由调用方传，改动相关的判断在模块里——前者是布局，后者是关于这次改动的判断。
- `blocks.ts`——整篇重写那一层（设计稿 02h 1b）。**按空行切段**而不是按行：重排过的段落会散成十几处无关的行改动，而「合并」（两段焊成一段，整理稿最常做的事）按行根本表达不出来。五类：删 / 改写 / 合并 / 新增 / 标点，排序是 删 → 改写·合并 → 新增 → 标点；标点类只报数不画（它改不了字数，三十七处会把改得了的挤出屏幕），除非整篇只有标点改动。**先分类再合并相邻窗**，且只合并同类：反过来做会凭空造出「合并」——一处删除挨着一处无关改写，正好是「两删一加」的形状，卡片会告诉作者两段被焊到了一起。
- `sections.ts`——「这一行在哪个小节」的唯一定义，编辑卡与重写卡共用（围栏里的 `#` 不算小节）。

### `src/lib/editor/`

编辑面的纯逻辑与 CodeMirror 扩展，一个文件一件事——组件里只剩接线，所以这些能在 node 下测。

- `aiTarget.ts`——**显式标记的 AI 作用区**。拖一段选区只够「立刻就动它」，撑不住作者真实的动作（点进 AI 面板、滚一页、继续打字）：DOM 选区在第一次点别处就没了，一对裸偏移在上方任何编辑之后就烂了。把起止交给编辑器状态，CodeMirror 会替它映射过每一次改动（包括区间内部的），于是偏移可以直接信。
- `aiSelection.ts`——「把当前选区定成一次 AI 任务」的纯逻辑，InlineAiBubble 和全局 `Mod+Shift+E/L/M` 各调它一次，谁都不用 import 谁。
- `format.ts`（CodeMirror）与 `textareaFormat.ts`（条目编辑器那种裸 `<textarea>`）——同一套 markdown 命令的两个面。行内标记**开关式**（对已加粗的文字再加粗就是去掉），块级命令作用于选区碰到的每一行。`textareaFormat` 把变换切成纯函数（`*Edit`，算出一段连续替换 + 结果选区，无 DOM 可测）加一层薄的 DOM 应用层，改动靠派发 `input` 事件写回 React。
- `highlight.ts`——`manuscriptHighlight` **只发 `.tok-*` 类名、不带颜色**。CodeMirror 的 `defaultHighlightStyle` 自带一套浅色调色板，而且它是个 JavaScript 对象：没有令牌、读不到 `data-scheme`，主题伸不进去（夜间的代码和引用会一直是浅色，模块 CSS 里读令牌的 `.tok-*` 规则也匹配不上，因为默认样式发的是生成类名）。颜色因此和编辑器画的其他东西一起住在模块样式表里，主题换编辑器配色就和换按钮颜色是同一件事（`docs/feature/theme-system-plan.md` §8）。
- `insertFlash.ts` 与 `caretFlash.ts`——两种落点回执，**mark 与 line 装饰的分别**是被逼出来的：插入用 mark 画那段刚落下的文字；跳转到 `doc.length`、文档又以换行结尾时落在**空行**上，零宽区间的 mark 什么都画不出来，所以跳转用 line 装饰（它至少还有行高）。
- `scrollSync.ts`——分栏两侧**按源行对齐而不是按滚动百分比**：同样的行在两边高度差得远（`# 标题` 变成一个高标题，`![图]` 变成一整块图），等百分比会把不同的段落摆到屏上。每一侧交一份 `ScrollMapping`（视口顶 → 分数源行，以及反向），没有映射时退回等比镜像，两个极端始终吸附。插值数学是这里的纯函数。
- `scrollAnchors.ts`——那两份具体映射（编辑器侧读 CodeMirror 的块几何，预览侧读 `renderMarkdown` 在分栏下打的 `data-line` 锚点）。纯测量，正是 jsdom 跑不了的那部分，所以数学留在 `scrollSync.ts`。
- `previewZoom.ts`——预览缩放的**定档梯子**：按钮和 ⌘/Ctrl+滚轮必须对「一档是多少」有共识，而一个作者说不出名字的百分比（113%）比稍粗一点的跳档更糟；档位在 100% 附近变密，因为阅读微调都发生在那儿。

### `src/lib/format/`

`paragraphs.ts` 一个文件：段落整理——「给这份没标题的文档一点形状」里**机械的那一半**。那句话其实是两件事：判断一节从哪里开始、该叫什么，需要读过全文；把跑在一起的两段分开，只需要文本本身。后者过一遍模型等于为同一份文档付两次钱，还给它一次改写正文的机会——所以判断那半是 `insert_lines`（`docs/feature/agent/large-doc-formatting-plan.md`），机械这半是这里：一个纯函数，作者从编辑器直接跑，零 token、零轮次。**一条判据统治这里的每个决定**：错误的变换是静默的，而作者恰恰是最不可能发现的人——他要整理，正是因为他没在细读。所以**文本没有明确说自己是什么的时候，什么都不做**，和 `lib/xlsx/cells` 同一条教义（把文本错判成数字是看不见的，留成文本是一眼就看见的，所以往「不动」那边猜）。最咬人的地方是插空行：硬换行的散文和真正的分段在字面上长得一样。

### `src/lib/comfy/`

本地 ComfyUI 生图（Settings → AI 配置 → 实验室 的 Beta 开关，`flag.ts`）：第五条 `ImageRoute`（`"comfyui"`），一个 image Model = 一张作者导出的 **API 格式**工作流（存 `ImageCaps.comfy`，UI 保存格式被专门识别并拒绝）。`workflow.ts` 是全部纯逻辑——解析、占位识别（标题约定**负面先于正面**判定 → 采样器回溯）、注入（提示词/负面/seed/尺寸/张数/LoadImage 图名），识别在**读取时**做、绝不在导入时固化 node id；HTTP adapter 在 `lib/ai/image.ts`（提交-轮询-取图 + `/upload/image` 参考图，seed 与上传名默认每次随机化否则命中 ComfyUI 的节点缓存不出新图；取消先 queue delete、核对 queue_running 才 interrupt）。`caps.edit`/`maxRefs` 从工作流的 LoadImage 数**推导**而非声明；负面提示词是这条路由独有的 wire 字段——没有负面节点就丢弃，**绝不**折进正面（SD 会画出它读到的东西）；图生图编辑发累积描述不发增量指令。人设校准循环在 `lib/image/calibrate.ts`（清单 → vision 评审双诊断 revisedPrompt/seedOnly → 修正重试，纯循环可单测；硬轮数上限 + 历史最佳兜底，UI 在 ImageGenModal 随同一开关显隐）。应用绝不自己构造节点图。设计：`docs/feature/comfyui-plan.md`

### `src/lib/consistency/`

#### 流程总览
- 一致性检查: the document read back against the knowledge base **on the assistant's own loop** (`review.ts` — ① 取材 in code, ② one full `runAgent` per window on `CONSISTENCY_PRESET` = the read tier + `report_issue` / `report_pass` and no write tool, subagents routed like chat, ③ merge).
- **Windowing is code's, not the model's** (`budget.ts` — the plan whose segments sum to the ceiling, and `splitDocument`; measured reasons in the plan §3): N = 1 is the common case and then the run is fully autonomous; N > 1 nests each window under a `check_window` step so the log needs no new band.

#### 收集与范围
- `reviewTools.ts` is the collector — a finding's quote is verified against the segment **at record time** (verbatim, exactly once) and sent back for a rewrite otherwise, an entity must resolve, and in entries mode the sink refuses anyone not pinned
- `scope.ts` the three-way range (all follows the fence / collections override it / entries pin and refuse — the fence narrows discovery only, never recording)

#### 合并与定位
- `merge.ts` cross-window dedupe + the coverage band
- `model.ts` the anchoring (`locateIssue` — scan-time anchor as tie-breaker in widening rings, then whole document; `applySuggestions` / `revertSuggestion`).

#### 状态与展示
- Never a green tick for an empty run: `emptyRun`, failed and aborted windows and the cap's tail are all on the report head.
- State in `stores/consistencyStore.ts` (range persisted per project, findings stream in live), UI in `components/ai/ConsistencyCheck.tsx` (设计稿 02d).
- Design: `docs/feature/consistency-review-plan.md`

### `src/lib/pptx/`

`.slides.json` / HTML → PPTX（Settings → AI 配置 → 实验室 的 Beta 开关，`flag.ts`）: deterministic native layout or legacy browser harvesting; neither export runs a model.

#### 原生路线（P1–P5 导出、Agent 审批与应用预览）
- `native/model.ts` / `validate.ts` / `diagnostics.ts` define the closed v1 `.slides.json` semantic contract, pure validation and JSON-pointer diagnostics; `theme.ts` keeps immutable point-based themes with explicit Latin/CJK font candidates. `resources.ts` checks loader observations against byte/pixel ceilings; P2 `environment.ts` performs bounded project-local reads and decoding, `imageHeader.ts` enforces pixel limits before decode. `approval.ts` prepares bounded ephemeral artifacts and hash-bound receipts before approval; stale inputs/destination or a lost cache require fresh review (plan §8.11). Six-layout example and tests live in `native/__tests__/`; contract and limits: `pptx-plan.md` §8.8.

- `native/resolve.ts` owns validated source, selected fonts, media strings and deeply frozen layout; `layout.ts` compiles all six layouts into fixed-size editable lines, rules, images and semantic tables with explicit overflow diagnostics; `write.ts` emits native text/shapes/images/tables/notes. `paragraphs.ts` normalizes PptxGenJS rich-text paragraph properties to one block per paragraph. P2/P3 Office evidence and font tradeoffs: `pptx-plan.md` §8.9–8.10.

#### 转换管线（无模型参与）
- `harvest.ts` renders the page in an offscreen sandboxed iframe and `harvester.js` (injected `?raw`, answers by `postMessage`) reports what the browser measured
- `deck.ts` is the pure layer (units, slide size, colours, pruning, text slack — where the tests are)
- `write.ts` calls pptxgenjs (lazy, own chunk)
- and `htmlSlides.ts` reads a page **by structure** — by slide for `read_slides` (its selector list **must** stay in step with `harvester.js`'s or "slide 7" means two different things), and by landmark (`landmarkIndex`: headings, `id`s, and the tags that are a place on their own) for the pages those selectors cannot divide, which is the map `read_file` puts in front of a long landing page or report. Pure text, one tag scanner, one offset-to-line map — see `docs/feature/agent/html-read-edit-plan.md`.

#### 生成侧保真度检查
- `inspect.ts` reports harvested HTML geometry/degradation only, never PowerPoint fidelity; empty/unmeasured slides cannot count as passing. `scripts/pptx/` and the fixed fixture in the subsystem tests provide repeatable browser export and same-renderer image comparison; baseline evidence and remaining Office verification are in `pptx-plan.md` §8.7.
- `lint.ts` is the generation-side half of fidelity: a text-level scan of the page for what the harvester **can never see** (a `::before` has no box to measure; an entrance animation starting at `opacity: 0` is measured as hidden) or is known to approximate, appended to `inspect_html`'s report with a line per finding, carried on the `export_pptx` card (folded by rule, the sentences in both locale files) and repeated in the apply report beside what the conversion measured, saying nothing on a clean page — never a reason to refuse an export, and never a `harvester.js` edit
  - the rule table is `pptx-plan.md` §7.3.

#### 入口点
- Native `.slides.json` sources are editable `slides` documents, attachable as text, and styled as author documents in the tree. Its Beta export menu opens the shared preview/export controls; ordinary JSON is unchanged.
- The `export_pptx` L2 tool accepts native sources (prepared before approval, exact bytes applied with binary backup and staged replacement) or legacy HTML (converted on approval). Other HTML entry points are the `.html` preview toolbar, and the file tree's right-click menu — the last two call the same `exportHtmlToPptx(path)` and both flush the editor first, since it reads the file off disk.

#### CSP 安全约束
- **Never add `allow-same-origin` to that frame, and never edit `harvester.js` without updating BOTH the `sha256-` in `tauri.conf.json`'s `script-src` and `htmlSlides.ts`'s selector list** (a `blob:` document inherits the app's CSP, so that hash is the only reason the script runs at all; `pptxHarvesterCsp.test.ts` guards the drift) — why: `docs/feature/pptx-plan.md` D13 / D18; design + rejected alternatives: the same doc's §4

### `src/lib/xlsx/`

markdown 表格 → .xlsx（Settings → AI 配置 → 实验室 的 Beta 开关，`flag.ts`）：一张表格 = 一个工作表，名字取自它上面最近的标题——和导入侧（`xlsx.rs` 写出的 `## 工作表名` + 表格）严格对称，所以作者不用学新写法。`cells.ts` 是全部实质：一份所有格子都是文本的 .xlsx 只是表格的截图，所以数字/百分数/日期/`=` 公式都判成真类型，**而判不出来就留成文本**——前导零（`007`）、15 位以上（身份证）、带单位（`12000元`）一律不转，把文本错判成数字是**静默的**数据损坏，反过来作者一眼就看见；百分数存分数（`12%` → `0.12`，存 12 会让整列求和错一个数量级）。`sheets.ts` 复用 `lib/docx/blocks` 的 token 流（markdown 方言全树只有一份），`write.ts` 是唯一知道生成在 Rust 的文件（`src-tauri/src/xlsx_write.rs`，`rust_xlsxwriter`）——生成放 Rust 而 docx 放 TS 是**同一条**规则「跟着已有的那一份走」：这里 markdown 方言一个字都不过界，过去的是一张已经定型的格子表。入口只有 `export_xlsx` L2 工具，工作簿**在提案时就建好**（不像 pptx 必须等 DOM），所以作者批的和写下去的严格是同一本。设计与弃案：`docs/feature/xlsx-export-plan.md`

### `src/lib/docx/`

#### 概述

markdown → .docx（Settings → AI 配置 → 实验室 的 Beta 开关，`flag.ts`）。**转换一个字都不过模型**：模型写 markdown，版面全部来自 `DocFormat`（`docs/feature/docx/01-agent-design.md` I1），`index.ts` 只负责把源文、格式、插图三样凑齐再汇报降级了什么。


#### 分层模块（write.ts / format.ts / blocks.ts）

- 分层照 `pptx/` 的分法——能不碰库就决定的全住在纯模块里，`write.ts` 是**唯一**知道 `docx` 库存在的文件（1.1MB，懒加载，不进启动包），换库或改走 Rust 时要重写的只有它。
- `format.ts` 是主体：一份 Word 文稿的全部版面参数，单位是磅 / 毫米 / twip。**刻意不复用 `lib/theme/markdownThemes.ts`** —— 那五套是 CSS，`2em` 和 `var(--font-serif)` 无法无损翻成磅，而 CSS **根本不表达页面**（纸张、页边距、文档网格在那边不存在）；内置预设的名字和 markdown 主题对齐（作者看到的和导出的对得上），值是一张手写映射表而不是从 CSS 推导的。
- `blocks.ts` 走 markdown-it 的 **token 流**而不是 `renderMarkdown` 的 HTML：vitest 跑在 node 下没有 DOM，走 DOM 就等于这一层不可测，而逻辑全在这一层；用的是 `lib/fs/markdown` 里**同一个** `md` 实例，所以方言不分叉、自定义的 `lore_cite` 也看得见。

#### 读取与合并（read.ts / resolve.ts）

- `read.ts` 是「参考模仿」——把一份 .docx 里写死的参数读成一套 `DocFormat`（纯函数 `layoutToFormat` + 一趟 IPC 到 `src-tauri/src/docx.rs`），三条判断留在 TS 侧而不是 Rust 侧（那边只报「XML 里写着什么」）：缺席 ≠ 零、纸张**按尺寸认不按名字认**（OOXML 里没有「A4」这个词）、并报出「哪些是它写死的」。
- `resolve.ts` 合并三级来源（本次明确指定 > 参考模仿的文件 > 默认预设），永远有结果，所以「作者没特别指定」不需要模型做任何事。
- **贯穿整个子系统的一条纪律：解析失败抛错或返回 null，绝不静默取默认。** 静默回落正是「看起来对、其实不合规」的来源——作者说了仿宋三号、产出是默认格式，而没有任何地方会亮红。

#### 预设与字体检查（presets.ts / fontCheck.ts）

- `presets.ts` 把作者自建的格式存进 `config.db`（**装机级**：一套公文格式要跨项目复用，连带好处是自然落进「应用配置备份」的范围；整套格式存成一列 JSON，因为这张表永远整套读写、从不按字段查询）。
- `fontCheck.ts` 回答「这台机器装了这个字体吗」，手段是**量宽度**而不是 `document.fonts.check`（后者在家族缺失时靠后备字体照样排得出来，于是对没装的字体也答 true），三个后备各问一次防止字形宽度巧合；缺字体只是一句中性提示不是错误——导出的文件仍然是对的，拿到装了它的机器上打印一样合规。

#### 上下文简报与设计文档

- `briefing.ts` 把可点名的格式清单挂在固定头部（和工作流清单同一层、同一个理由），格式的**细节**不进上下文，那是 `read_doc_format` 的活。
- 设计：`docs/feature/docx/`（00 可行性 —— 为什么难的是读 docx 不是写 docx · 01 agent 设计 · 02 / 03 UI 稿）

### `src/lib/roleplay/`

#### 总览

互动式角色扮演（Settings → AI 配置 → 实验室 的 Beta 开关，`flag.ts`）：作者以第一人称和知识库里的人物对话，另有一个能读到全部对话的「旁白」。以下模块承担全部设计：


#### 记录与播种（transcript.ts / context.ts / markup.ts）

- `transcript.ts` 是**只追加、永不改写**的对话记录（资产；`session.json` 里的 wire history 只是缓存，读不出来就从 transcript 重新播种），
- `context.ts` 把历史播种成 `[system, 绑定块, seed 块, 提问]` —— **绑定块必须是 prelude 里一条独立消息、绝不能并进 seed 块**，因为 `buildCompactedHistory` 只丢 `meta.seedContext`，放对位置就等于永不失忆（`__tests__/context.test.ts` 跑真实压缩守着这条），
- `markup.ts` 解析 `*动作*` / `「台词」` / 裸文本 / `[元指令]`（**解析只影响作者看到的稿面，发给模型的仍是原文**），

#### 读取通道与 system 层（sceneTools.ts / conversationTools.ts）

- `sceneTools.ts` 是旁白读别人 transcript / summary / memory / 记忆区的**唯一**通道——扮演 agent 的 preset 里根本没有这几个工具名，隔离是结构性的；它覆盖当前场**和归档**（场次地址 `<agentId>#<N>`，当前场＝最大归档号 + 1，见 `scene.ts`），而**作者作废的场次（「另起一场」）默认一层都不进**，点名读得到但内容前面挂着作废提示——旁白是会往正文里写字的，把试验场当情节写进第三章是这个口子唯一真实的风险。
- `conversationTools.ts` 是角色回看**自己**的通道，同样覆盖自己的每一场（废弃的连点名都够不到），作用域仍然是结构性的（`ToolContext.conversation` **没有 agent id 参数**——场号选的是「自己的哪一场」，不是「谁的场」）。
- **system 层不是只播种一次的**：角色名 / 主角条目正文 / 扮演指令 / 作者身份都住在 `history[0]`，作者随时会改，所以 `refreshSystemPrompt` 就地重写它、`contextSignature` 是「设定已更新」的基线（覆盖这全部输入，不只是绑定块）——往 system 层加一样作者能改的东西，就要同时加进那个签名，否则提示永远不亮（05 §2.16）——
- `AuthorPersona` 的四档（`lore` / `prompt` / `stranger` / **默认 `none` ＝导演视角**，作者写场面和剧情指令而不是以某个人的身份说话）踩的就是这条：`personaKey` 不区分 `none` 和 `stranger`，切换身份时提示永远不亮。

#### 长期记忆（memory.ts / run.ts）

- `memory.ts` + `memoryTools.ts` 是角色的长期记忆（约定 / 待办 / 事件 / 关系）：它**不是摘要**——摘要会被再次摘要，一条没兑现的约定三轮之后就变成「他们聊了一些计划」，所以记忆只增改不删、恒在 prelude，且注入块**只在四个时刻刷新**（播种 / 压缩之后 / 恢复 / 作者手动），绝不在 `remember` 写入的当下；注入块**只放标题**，正文由 `recall(id)` 按需展开——连正文一起塞时超预算的记录是**整条不列**的，而那意味着角色连那件事发生过都不知道。
- 每条记忆带 `scene`（记下时是第几场）：转场把轮号归零，所以单给「turn 14」指不到任何东西。
- `run.ts` 是一次运行的**历史准备**，它的排序本身就是设计：修对配对 → 压缩 →（**压缩了才**）刷新记忆块 → 条目注入 → 记忆区检索 → 提问（永远最后一条，且是本轮 turnStart）——「压缩之后刷新记忆块」不是省钱的优化，压缩刚把 `remember` 的工具结果折叠掉，**那一刻精确地就是正确性边界**。

#### 转场（area.ts / recap.ts）

- `area.ts` + `recap.ts` 是**转场**，而它有**两支**：「接续」＝这一场算数——欠着的约定/待办和关系留在常驻层，其余**移出**常驻层、逐条沉进记忆区（改成标 `void` 留档就会让分拣每次都重新命中它们，条目随转场次数平方级膨胀），前情由角色**第一人称自己写**（第三人称全知会写进它当时不该知道的事）；
- 「另起一场」＝这一场**作废**——**分拣一步都不跑**，本场记下的记录移出常驻层，归档存成 `transcript-NN.discarded.md`（**编号推进和归档列表必须认同一套正则**，否则下一场会拿到一个已占用的号、覆盖掉那一场的 summary）。
- 分拣曾经无条件执行，于是试验场里记的事照样沉进记忆区、三场之后被关键字命中说出来；记忆区的格式和知识库完全相同，却**绝不并进 `loreIndex`**——并进去，隔离就从「它不在那里」降级成一个要在六处同时正确的过滤器（含一致性检查，它会把角色的错误认知报成正文矛盾），而记忆区装的正是角色**以为**的事，本就可以和正文冲突；区落在 `areas/<areaId>/` 而不挂在 agent 上，所以删掉角色它还在、能被下一个角色继承。

#### 取材追踪与状态（trace.ts / traceView.ts / roleplayStore.ts）

- `trace.ts` 是**取材事实**的数据一侧——这一轮命中了哪些条目/特征、被什么关键字激活、什么没进去，以及首次发送**之前**的预估（`history` 还是 null 时上下文构成条只画得出工具 schema）。
- 两条必须记住：**常驻层和本轮检索是两个字段**（`coreDone` 会让常驻条目在报告里显示成「匹配了、贡献 0 字」，合成一栏作者就会以为人设没进上下文），**记忆区永不并进知识库那一栏**（同 `loreIndex` 那条，记忆区装的是角色**以为**的事）；`BoundContent` 因此有两个清单——`resident` 给注入账本（只收真装了正文的），`pieces` 给作者看（**必须**含只写了标题的那些），合并只能二选一：要么账本出错，要么界面漏报。预估的三块字符数走 `context.ts` 的 `blockSizes`，它调的就是真正的块构造函数——理由同 `contextSignature`。
- `traceView.ts` 是它的取数层（纯函数），界面是 `components/roleplay/TurnTrace.tsx`——**四种来源靠同一根线的四种终止方式分开**（常驻上下出血 / 知识库两端止笔 / 记忆区断成点线 / 引用 2px 赭石）——**3px 双线一次都不用**，那已经归集合所有。
- 取材条一律读**字**（数据层给的就是 chars），只有上下文构成条读 tk：换算只在构成条发生一次，两处各说各的真实数据比对齐成一个假数好。`hitRows` 刻意**不用** `contributingEntities`——`coreResident` 的条目要以「0 字」出现，滤掉它作者会以为没唤起，然后去改一个工作正常的条目。
- 状态在 `stores/roleplayStore.ts`（每 agent 一个会话 + 3 个并发的信号量；`contextTrace` 按轮号、只在内存，`preflight` 按 agent、装机后就有），UI 在 `components/roleplay/`。设计与取舍：`docs/feature/roleplay/`

### `src/lib/translate/`

日中翻译（Settings → AI 配置 → 实验室 的 Beta 开关，`flag.ts`）：接一个**本地部署的专用翻译模型**（Sakura，走 LM Studio / Ollama 的 OpenAI 兼容端点）。它不是一个小号 LLM，而是一个**翻译函数**——实测问它「你是什么模型」，它把问题改写一遍还回来；给它中译日，输出的还是中文。设计与实测：`docs/feature/translate/`。

四条不变量因此成立：

- `translate` **进 `SUBAGENT_KINDS` 但不进 `DELEGATE_KINDS`**（照 `imagegen` 的先例，助手的接口是工具而不是子对话）。
- `run.ts` **绕开 `runAgent` 直接调 `streamCompletion`**（它没有 tool calling 可循环）。
- 带 `translateFormat` 的模型**永不出现在任何非翻译候选列表里**。过滤收在 `components/ai/ModelSelector` 一处——那个组件就是「挑一个模型来对话」这件事；`lib/ai/configDb` 的 `conversationalModels` 是这条不变量的名字。
- **坏译文永不落盘**：阶梯走完仍不合格的块写回原文加一行 HTML 注释。

模块：

- `sakura.ts`——训练时固定的提示词模板、采样常量和退化判定。判定顺序 degenerate → truncated → line-mismatch **不能换**，而且**不信「重复整行」**：实测两次退化的重复行计数都是 0，复读发生在一行之内；可靠的信号是 tok/行（正常 19–22，退化 65–120）。
- `chunk.ts`——按行切块（块大小可调：设置 → 子代理 → 每块行数，`flag.ts` 的 `translateLinesPerChunk`），没有日文字符的行（空行、URL、分隔线）根本不进请求、按行号插回。
- `glossary.ts`——从知识库抽**本块命中**的术语，并在译文上做最长词优先的强制替换（术语表只是软提示，实测漏替一半）。来源两条：条目别名 → 条目名，加上勾了「翻译词典」开关（frontmatter `dict: true`，条目编辑表单里设）的条目正文里的 `原文->译文 #备注` 行；同源词词典赢。
- `context.ts`——把上一块尾部几行的「原文 → 译文」作为一对合成消息前置。
- `top_p` / `frequency_penalty` 住在 `StreamOptions` 而**不是 `ConnOptions`**：后者只收「来自配置」的字段，而 freq 是退化重试阶梯的一环，逐次请求都在变。

### `src/lib/asr/`

#### 入口与设计
- 音频转写（Settings → AI 配置 → 实验室 的 Beta 开关，`flag.ts`；两个入口：文件树右键「转写为文字稿…」→ 行下确认条 → `FileTree.handleTranscribe`，以及 L2 工具 `transcribe_audio`（`tool.ts` → `TranscribeProposal` 卡 → `lib/agent/proposalApply.ts`）——**卡在付费之前**而不是之后，和 `convert_document` 相反，因为转写本身就是计费的那一步；设计稿 02f，实现出入记在 `docs/feature/asr/02-ui-brief.md`）

#### 双路径总览
- 千问 / DashScope 语音识别，**两条路，由绑定的模型行选**（`asrFormat`，不在两个模型之间自动路由）

#### 异步与同步转写
- 异步那条——`client.ts` 拿临时上传凭证 → OSS 表单上传（`file` 字段必须最后）→ `oss://` 提交 → 轮询 `/tasks/{id}` → 取结果 JSON；filetrans 接口**只收公网 URL**，所以上传不是优化是唯一入口
- 同步那条（`dashscope-sync`，`sync.ts`，2026-09-14）是 compatible-mode `/chat/completions` 一次往返：user 消息只能有一个 `input_audio` part；≤10MB / ≤5 分钟在批准之前按 `formats.ts` 的 `syncRefusal` 拦；结果是一段不带时间的纯文字（`Transcript.timed: false`，渲染不写时间戳和说话人）。理由与实测见 `00-research.md` §1.3 补记

#### 三条不变量
- 三条不变量写在 `01-execution-plan.md` §1：凭证和提交的 `model` 是**同一个变量**（临时文件与模型名绑定）、`X-DashScope-OssResourceResolve` 头只跟着 `oss://` 走（漏了提交照样 200，错误只在轮询里出现）、付费之前必须有人点头（右键确认卡 / 审批卡，`autoApprove` 永不放行）

#### 结果、缓存与读取
- `result.ts` 同时认两代模型的响应形状（结果链接在 `output.result` 还是 `output.output`、`sentence_id` 从 0 还是 1）——按形状不按模型 id 分支，因为 id 是作者手打的自由文本
- `cache.ts` + `run.ts` 把结果 JSON 本体按「内容哈希 + 模型 + 参数」缓存到 `.ai-writer/tmp/asr/`（链接 24 小时失效，一小时音频 ¥0.8）——模型进键而不是命中后比对，两个模型才各留一份、来回切不重复付费；命中时仍核对 `meta.model`，因为目录名里的模型 id 是清洗过的
- 批准之前一律走 `readFileHead`（`fs_read_head`，一次往返给回真实大小 + 前 64KB）而不是 `readBinaryFile`，时长由 `duration.ts` 从容器读（MP3 / FLAC / Ogg / MP4 家族，头里不够时经 `fs_read_range` 读有界区间），大小上限也在那时拦——`transcribeFile` 里的那道闸在付费之后

#### 身份、关联与文档
- 模型行的身份是类型 `asr`（界面「音频 ASR」；2026-09-14 之前是 `asrFormat` 标记，读旧行与旧备份时 `normalizeAsrIdentity` 升级，`asrFormat` 现在只表示走哪种接口，理由见 `00-research.md` §4.1 补记。照 `translateFormat`：`isAsrOnly` 是不变量的名字，`conversationalModels` 无条件排除），绑在 `asr` 子代理档位上（进 `SUBAGENT_KINDS` 不进 `DELEGATE_KINDS`——端点收的是音频 URL，没有对话可委托）
- 轮询循环和 `image.ts` 的 `dashscopeAsyncImage` 是同一节奏但**没有抽共用**（§0 修正）。设计与实测：`docs/feature/asr/`，wire 事实在 `docs/api/qianwen-compat-plan.md` §1.4

### `src/lib/cli/`

命令行（Settings → AI 配置 → 实验室 的 Beta 开关，`flag.ts`）：让助手在这台电脑上跑一条命令——Windows 走 PowerShell（`pwsh` 优先，退 5.1），macOS / Linux 走 `$SHELL` 或系统 shell。设计：`docs/feature/agent/shell-command-plan.md`。

- **Rust 那一半**在 `src-tauri/src/cmd.rs`（`cmd_shell_info` / `cmd_run` / `cmd_kill` + 受管的句柄表），**不装** `tauri-plugin-shell`：它唯一的安全机制是静态允许清单，对模型现写的一行只能配成 `args: true`，而超时、杀进程组、输出封顶、编码检测、`FsScope` 的 `cwd` 围栏它一样都没有。
- **前端四个纯模块**各答一个问题：`shell.ts` 识别真实 shell 和它所在的系统（`systemLabel`：系统名 + 版本 + 架构）；`command.ts` 以封闭白名单按 POSIX / PowerShell 判 `read | write`（未知、复合、危险参数默认写入；程序必须是裸名——`./cat` 按 basename 命中会跑项目里的文件；参数不许出项目——免审读取的输出不经作者直接进模型），并给审批卡算 `isCompound` / `looksDangerous`；`output.ts` 截出模型读回的头尾；`run.ts` 编排运行、中止、日志。
- **免审批清单** `allowlist.ts`（`app:cliAllowlist`，机器本地）：程序名规整成 `programNameOf` 的键；shell / 解释器 / 构建工具 / 提权与 `cd` `export` 这类改后续段环境的内建命令永远拒收，包管理器只放行查看类子命令。`command.ts` 的 `commandCover` 把一行按 `&&` `||` `;` `|` 切段，每段须是只读或被清单覆盖（与只读白名单共用 `plainInvocation` 形状检查，外加按程序的执行钩子表）；`allowlistCandidates` 给卡算「始终允许」该列哪些程序——只在加进去之后这一行本身能免审时给，删除 / 移动类程序从不给（只能在设置页加）。
- **审批**：`agent/cliTools.ts` 对 `commandCover` 通过的命令直接调用 runner（清单非空时 description 点名这些程序），其余组 `CommandProposal`。`ApprovalCard` 展示写命令原文；「始终允许 <程序>」写清单并批准本张（不要求 `autoApproveKey`——它是设置不是运行授权）；单条普通写命令可按 1–5 条连批，复合或危险命令永远逐条审批（危险表不完整，复合是它的兜底）。`agentStore` 用 `commandLeft` + `commandRun` 扣减并在 run 结束清零。`isAutoApprovable("command")` 为假，正文的布尔授权永不覆盖 shell。
- **路由**要求 `RouteOptions.commands` + Beta + `IS_TAURI` 三者齐全，description 在交出定义时点名真实系统与 shell（只说 zsh 分不出 BSD 还是 GNU userland）。

### `src/lib/workflow/`

工作流卡（A 类 best-effort 流程指引，见 `docs/feature/agent/workflow-cards-plan.md`）：内置卡（`builtins.ts`，开箱即用）+ 项目 `.ai-writer/workflows/*.md`（同 id **整张**覆盖内置），`cards.ts` 纯逻辑（解析/合并/清单限长/查找）、`scan.ts` 唯一碰盘处。两级渐进披露：清单一行一卡恒挂 briefing（chat 的 system 层 + AiPanel `tools: "full"` 任务的 instruction 尾部，`briefing.ts`），正文只在模型调 `read_workflow`（常驻 read 工具）时进上下文；管理 UI 在 Settings → 工作台（启停/编辑/新建/还原，`write.ts`——停用内置卡写的是**全量副本**，薄覆盖会合并出空卡）。必须保证的行为不进卡——那是"流水线进工具"（translate 等）的地界

### `src/lib/profile/`

capability packs: what kinds of writing a project enables (`model.ts` pack types/built-ins/validation, `resolve.ts` multi-pack merge, `file.ts` profile.json v1/v2/v3 parsing, `active.ts` module singleton holding the merged `ResolvedWorkspace`, `store.ts` `.ai-writer/profile.json` IO). Drives the knowledge-base category layout (packs + user-defined + the `custom` bucket), each category's optional **type schema** (`slots`/`imageSlots` — what facets and images entries of that category are expected to have; metadata and prompts only, never injection — see `docs/feature/lore/lore-entry-type-plan.md`), and the per-pack-task 【…】 block labels. The merge rules, orphan categories, the task fields and the rules for reading the singleton are in [能力包](#能力包workspace-packs) above.

### `src/lib/context/`

RAG assembly (`rag.ts`), the current time as one line (`clock.ts` — a line, not a tool; appended to a single-shot run's system prompt but stamped on the chat's *current turn*, because a clock in `history[0]` would invalidate the whole conversation's cache prefix every send; roleplay, summarizers and the consistency reviewer deliberately carry none — the source guard in `currentTime.test.ts` makes every new `role: "system"` builder decide. See `docs/reference/architecture.md` → 当前时间), the chat's current-document policy (`docFocus.ts` — describe the open file by default, inject its window only when the turn points at it), story memory (`memory.ts`), book spine (`outline.ts` — the library members live in the spine and `resolveVolumes` filters by them, so 续写 sees only the library (`library.ts` holds the members table's pure rules); `isChapterFile` keeps the folder note `index.md` off the spine, and deliberately reads no `status`: the spine and 续写 are the author's explicit acts, not automatic discovery, see `folder-note-plan.md` §3), book-level continuation context (`bookContext.ts`), per-volume collection digests for the library view (`collectionDigest.ts` + `stores/digestStore.ts`; display-only, never task context)

### `src/lib/search/`

`globalSearch.ts`：⌘K 全局搜索的纯逻辑层——搜什么、怎么排、高亮哪一段。面板只做接线（把 `projectStore.fileTree` / `loreStore.index` / `editorStore.content` / `navStore.past` 递进来，把命中递给渲染），所以这一层能在 node 下测，面板换样子（设计稿 01d）时一个字都不用动。三条决定：**子串 > 词首 > 子序列**，且子序列**只在文档名和条目名上允许**（`ch3 ren` 命中 `第三章/人物小传.md` 是 ⌘P 的肌肉记忆），正文行上不允许——一行几十个字里几乎任何两个字都能按顺序找到，子序列在那里只是噪音；**空格分词、每个词各自命中**，一个词可以落在文档名上、另一个落在分组路径上，全中才算中；**回传的是区间而不是布尔**——高亮由区间画，旧面板在渲染时再 `indexOf` 一次查询串，只能亮第一个子串，子序列和多词一个都亮不出来。`currentTextDocument` 那条小闸也在这里：文本缓冲只在它属于 `projectStore` 说的当前文件时才可搜（文件加载是异步的，而图片刻意把上一份文本缓冲留在原地，两个条件各自都不够）。设计：`docs/feature/global-search-ui-brief.md`

`mentionSearch.ts`：`@` 选择器的纯逻辑层（设计稿 02i）——作用域是先于一切的硬过滤（`scopeOf`：条目 / 文档 / 图片，录音与视频归文档档），`availableScopes` 是三个宿主 chip 行的**唯一**来源（有任何文件就保留「文档」档，行的形状不随项目有没有图而变），`searchMentions` 复用 `matchText`、每个词取名字 / 别名 / 分组路径 / 整条相对路径里最优的字段（×1 / ×0.9 / ×0.6 / ×0.5，后两档是 `searchFiles` 的；分组与路径只认子串和词首——这里的命中有牙，Enter 会替换作者的字并附上文件）；库层逐词与 ⌘K 一致，但宿主永远只送一个词（空格结束提名），作者能打出的「分组 + 名字」是一个词跨 `/`（两者都按最后一个 `/` 拆开，左半严格对分组、右半对名字、两半均分 ×0.5；整条路径档只剩 `/` 在词首或词尾的词），空查询不打分而是按类交错——只有十行，作者刚打 `@` 就该看见两类都在；`countByScope` 只数不切，给空档那一行「别处有几条」。用结构化的 `MentionLike` 而不是组件的 `MentionItem`：`lib` 不 import `components`。旧的 `filterMentions`（只 `includes`、不排序、只看名字、条目独占前十）就是这里替掉的。理由：`docs/feature/agent/mention-scope-ui-brief.md`

### `src/lib/configsync/`

应用配置备份到服务端（供应商 / 模型 / Prompt / 偏好，以及可选的 API Key），与知识库同步共用一台服务器和一份连接信息（`lib/sync/config` 的 `app:kbServerUrl` + keyring 里的 `kbsync:<url>`——地址和 token 是**装机级**的，不是项目级的）。`envelope.ts` 是这份配置离开本机时的样子：明文头部（设备 / 版本 / 条目数 / 加没加密）+ PBKDF2-SHA256(310k) → AES-256-GCM 的载荷，**带 API Key 时没有密码就直接抛错**——那不是提示，是这个模块存在的理由（本地文件导出仍是明文 + 警告，因为文件在作者自己盘上；服务器上一个 token 泄漏就是全部供应商凭据泄漏）。KDF 参数写在信封里而不是代码里，所以以后调高迭代次数不会让今天的备份开不了；`counts` 是自报的，加密之后无人能核对，**只能被显示**，「要合并多少条」那句确认必须从解密并重新校验之后的 bundle 算。`client.ts` 是 `/v1/configs` 的 HTTP 客户端（前置条件、412 → `SyncConflictError`，与 `lib/sync/client` 同形），`password.ts` 是可选的「记住密码」（keyring，按**服务器 + 档**两级作键——一个全局条目会安静地答错一个），`run.ts` 是 build → seal → PUT 和 GET → open → `parseConfigBundle` 两条流程。状态在 `stores/configSyncStore.ts`（装机级，**不需要打开项目**——刚装好的新机器正是最想恢复配置的时刻），UI 在 Settings → 同步与备份 + `components/sync/ConfigRestoreModal.tsx`。设计与取舍：`docs/feature/knowledge-base/config-backup-plan.md`

### `src/lib/sync/`

知识库同步的客户端一侧（服务端是 `server/`，两者的可行性与线格式在 `docs/feature/knowledge-base/remote-knowledge-base-feasibility.md` §13–§20，UI 稿在 `sync-lore-ui-brief.md`）。

#### 共同词汇与同步方向（model.ts）
- `model.ts` 是共同词汇：一个项目可以**绑定**到服务器上一个具名知识库，同步是**单向、整棵树**的——把本地 `.ai-writer/lore/` 推上去，或把远端拉下来，**没有 merge**，作者选方向、另一侧变成它的镜像
- 也正因如此每次操作都先出一份**方案**：镜像反了就是毁掉工作，而作者和这件事之间唯一的东西，就是被逐条告知将要发生什么、其中哪几步会丢东西（`SyncDecision` 让他关掉任意单步，镜像是默认形状不是紧身衣）

#### 方案安全栏（plan.ts）
- `plan.ts` 是整个功能的安全栏：只比本地和远端，只能说出**它们不同**，说不出**谁动了**——而没有后者，每次覆盖都是抛硬币（用你没动过的旧副本盖掉同事的新条目，和推上你自己的修改，看起来一模一样）
- 所以方案是三路比对：本地哈希 × 远端哈希 × **上次同步成功时的快照**（`SyncBinding.snapshot`），两侧都动过是 DANGER，只有远端动过而你要推是「拿旧的盖新的」

#### 执行三原则（run.ts）
- `run.ts` 执行方案，三条规则：
  - **一、本地任何东西都不会被 unlink**，拉取要替换或删掉的条目是被**移进** `.ai-writer/backups/`（和 `applyLoreImport` 的 `displaceEntity`、agent 的 `delete_lore_entity` 同一个扁平目录——知识库是作者几十小时的工作而应用没有撤销，一个地方可找就是全部的恢复叙事）
  - **二、拉取先把整棵树快照到项目之外**（单条备份挡的是单条误操作，挡不住「我拉反了方向」；放应用数据目录而不是 `.ai-writer/backups/`，因为被覆盖的正是项目文件夹，存在里面的安全网会跟着这个文件夹一起被别的工具还原 / 移动 / 同步掉）
  - **三、每一次写都带前置条件，即使作者已经点过警告**——那是两种不同的保证，作者接受的是方案**给他看的**东西，`If-Match` 挡的是方案画出来之后、这次写落地之前服务器上变掉的东西
- 一步失败不中止整轮：剩下的条目仍然值得同步，快照只为落地了的那些前进，所以重试会正确地重新规划其余部分

#### 请求层与前置条件（client.ts）
- `client.ts` 走 `lib/http` 的 fetch（Tauri 的那个，请求从 Rust 发出），于是局域网上自建的服务器不用为 CORS 头操心
- 每个写操作都发 `If-Match` / `If-None-Match`，违反前置条件变成 `SyncConflictError`，并带上服务器上真正存着的哈希好让调用方重新规划

#### 装机级与项目级配置（config.ts / store.ts）
- `config.ts` 与 `store.ts` 是**装机级和项目级的分界**：服务器地址是普通偏好、令牌进 OS 钥匙串（和 AI 供应商密钥同一套 `secret_*`），因为地址和令牌描述的是**这台机器**而不是这个项目（几个项目共用一台服务器，存成项目级意味着逐个重输，还会把 bearer 令牌放进一个作者可能转手给别人的文件夹）
- 而「绑定了哪个知识库」和上次同步的快照在项目的 `.ai-writer/sync.json` 里，照 `lib/profile/store.ts` 的样子写——**永不抛**，它在项目打开路径上，一个缺失 / 截断 / 被手改成乱码的文件必须降级成「未绑定」而不是拦住作者打开项目（快照坏了再降一级也仍然安全：没有快照，规划器把每处差异都报成两侧冲突，吵但绝不静默破坏）

#### 本地哈希、打包与新旧判断（local.ts / status.ts）
- `local.ts` 是本地那半的三件事，都过 Rust：哈希在 `src-tauri/src/lorehash.rs`（摘要是和服务器共享的线格式，而且条目的图集不该为了算哈希从 webview 读一遍），打包解包在 `src-tauri/src/transfer.rs`（压缩包代码和 zip-slip 防护本来就在那边，后者在**下载**路径上最要紧）
- `status.ts` 回答「本地和服务器谁比较新」，读的是和方案同样的三张哈希图、**从不看时间戳**：时间戳只能说某一侧**什么时候**被写过，快照说的是**自作者上次认可以来哪一侧动了**，后者才是「该推还是该拉」真正在问的问题；而且它能活过一切会重置 mtime 的事（还原备份、复制项目文件夹），那恰好是作者最想要一个可信答案的时刻。纯的、只供显示，不喂方案也不喂执行器。

### `src/lib/fs/`

#### 文件工具与反向链接

- Tauri file I/O wrappers (`fileio.ts`); bounded head/range reads accept an optional `projectRoot` that narrows the existing Rust scope to canonical paths within that project (native PPTX assets).
- backlinks (`links.ts` 是「哪些文档链接到这个文件」——删除卡上**唯一一件删完就问不出来的事**：正文在备份里、大小在日志里，而文件一没，指向它的链接就只是断了，没人记得它们曾经是通的。只认真链接（markdown 的 `](path)` 与 `[[wiki]]`），不认光提到名字：一份叫 `序.md` 的稿子会让「被 12 个文档引用」变成没人再读第二遍的一行）
- markdown render/frontmatter (`markdown.ts`)
- the folder note (`folderNote.ts` — a directory's own `index.md`: `status` is the one machine-read key, the first prose paragraph is the summary, HTML comments are skipped so the unfilled template says nothing; `nearestFolderNote` walks up to the project root for the 【当前文件】 brief. Consumed by `list_files` / `search_text` under the 取材范围 fence's two invariants — automatic discovery only, hidden counts reported — and by nothing that is an explicit reference. `docs/feature/lore/folder-note-plan.md`)
- image/text file utils (`images.ts` — file-kind classification by extension, base64 data URLs, and `projectFilesFromTree`, the **one** source of the `@` picker's file candidates; it reads `projectStore.fileTree` rather than scanning the disk again, so a file added after the project opened is pickable as soon as the tree refreshes — see `docs/reference/architecture.md` → `@` 引用的候选文件)

#### 媒体与文档读取

- the model-bound video reader (`video.ts` — size checked with `readFileHead` **before** a byte is read, the 15MB / 2 s limits DashScope measured, and a pure MP4/MOV box parser for duration and frame size; the gate, part builder and ≈token estimate are `lib/ai/videoInput.ts` — see `docs/feature/video-input.md`)
- presentation reading (`pptx.ts` — the two IPC hops onto `src-tauri/src/pptx.rs`; here rather than in `lib/import/` because a .pptx has **two** readers, the importer and the agent's paged `read_slides`)
- export (`export.ts`)
- whole-project backup/restore (`projectBackup.ts` — wider scope than the lore bundle on purpose; see `docs/reference/architecture.md` → Export / Import)

#### 侧栏与行判定

- The sidebar's two pure decision layers: `moveCopy.ts` (drop rejection, copy numbering) and `selection.ts` (visible-row flattening, ⇧-ranges, dropping nested/dead paths).
- `rowMeta.ts` is the third: what one row **is** (设计稿 01b 的七种行，加上目录说明 `note`) —— `rowKind` 只看名字与父级（`assets/<组>` 由**位置**而不由名字决定），`pictureFolders` 再用一次自底向上的走查标出只装图片的目录（**内容优先、名字兜底**：子树里有文件就要求**全部**是图片——「大部分」要数数，而这个模块不数数；一个文件都没有才轮到名单，因为一个叫 `images` 却装章节的目录错标比漏标更糟），`resolveRowKind` 把两半合起来。图片目录**只有外观**：不进失配判定、不进「重新关联到…」，否则作者自建的 `images/` 会被改名并改写一份无关文档的正文（`docs/feature/file-tree-picture-folder-brief.md`）.

#### 文件树整体定位

- The workspace is the whole project directory, so the tree is a file manager — multi-select, batch move/copy/delete, and a root that is reachable only through the tree container (it has no row of its own). See `docs/reference/architecture.md` → Organising files

### `src/lib/theme/`

the theme system (`docs/feature/theme-system-plan.md`). `scheme.ts` is the **only** writer of `data-theme` / `data-scheme` (the first is a cascade key nobody reads, the second the polarity everything reads).

#### 外观主题文件（Appearance theme files）
- Appearance theme **files** (`appDataDir/themes/*.css`, tokens-only CSS with `--theme-name / --theme-scheme` metadata):
  - `contract.ts` parses `tokens.css` into scale / core / derived and `contractData.ts` is that parse frozen by `scripts/gen-theme-contract.ts` (vitest stubs `.css` imports, so the runtime cannot read the file; the contract test fails when the constant drifts)
  - `validate.ts` walks the browser's own `CSSRuleList` and drops what a ui theme may not do — with a reason per rule, never the whole file —
  - `registry.ts` merges built-ins with the folder (missing / unusable / reserved-id cards)
  - `install.ts` keeps the runtime registry, installs every usable file into one `<style>` in `tokens.user` and resolves which id actually applies
  - `export.ts` generates the exported document's palette from it (light on `:root`, dark under `prefers-color-scheme`)
  - `exportFile.ts` writes 「把当前外观主题导出为文件」 (设置 → 外观 → 主题文件).

#### 排版主题文件（Typography theme files）
- **Typography theme files** (`--theme-kind: markdown`, in the same folder or a project's `.ai-writer/themes/`, project overriding by id) go through the same validator with a different fence — every selector starts at `.md-body`, `@font-face` / `@keyframes` allowed, `url()` relative or `data:` only — and are installed as a second `<style>` after the generator's with `data-md-theme` naming the built-in they extend
  - `assets.ts` inlines their fonts and textures as `data:` (the app retired the `ai-writer-asset:` protocol for its own pictures, so themes never use it)
  - `sample.ts` builds the settings samples as sandboxed `<iframe srcdoc>` documents carrying the export's exact stylesheet.

#### 可下载字体包（Font packs）
- `fontPacks.ts` downloads, verifies and installs 鸿蒙黑体 / MiSans into `appDataDir/fonts/<id>/<version>/`; `fontPackData.ts` is the pinned table (size + sha256 of every file) that `scripts/gen-font-packs.ts` generates — the only thing trusted; sources just deliver bytes. Lib layer: `appStore` drives it and holds `fontPacks` (on this machine, read off disk — never a preference) apart from `fontScheme` (the choice, a preference). The stacks are ordinary `tokens.css` blocks; only the `@font-face` rules are injected, one `<style>` per pack (`install.ts` `applyFontFaces`). Reasoning: `docs/feature/downloadable-fonts-plan.md`.

#### 启动加载与设置面板
- Boot reads only the selected files (`main.tsx`) — and the chosen font pack's faces, so the first frame is already in that font
- Settings → 外观 (`components/settings/panes/AppearancePane.tsx` composes it, 设计稿 05m; the cards and bands are `AppearanceThemes.tsx`, 设计稿 05i) scans the folders, and `stores/themeStore.ts` follows the open project and **watches both folders while Settings is open** (`tauri-plugin-fs`'s `watch` feature — the one place the app watches the disk — reloading on a change and leaving the same trace the button does).

#### 拒绝理由与内置排版主题
- A refused rule carries a `ThemeReasonCode` + params, never a sentence: the locale files hold the sentences (`systemSettings.appearance.reason.*`), so add a code there in both languages when you add a rule.
- Built-in markdown typography themes (`markdownThemes.ts`): the `--md-*` CSS generated once and shared by the preview pane, lore previews and exported HTML/PDF.

#### 示例文件
- **Shipped example files** live in `themes/` at the repo root (a `.css` an author downloads into either folder, plus `themes/README.md` — both kinds' anatomy, the knob table, the core-token table and the two fences in author's words). Fourteen files today: `journal.css`, and the 物理猫 Phycat suite — eleven appearance themes (eight light, three dark) plus the two typography themes they pair with (`phycat.css` 气泡, `phycat-neon.css` 灯带)
- `__tests__/themeExamples.test.ts` branches on each file's `--theme-kind` and runs it through the **runtime's own predicates**: a typography theme's selectors and `url()`s through `isMdSelector` / `isAllowedUrl`, an appearance theme's selectors through `isThemeSelector` and its token names through `tokenTier`, both through `readThemeMeta` — so an example the validator would trim cannot ship. Two checks are the *samples'* promise rather than the format's: an appearance sample writes the **whole** core contract (a partial one silently inherits its base's hues, which over a differently-coloured ground reads as a bug), and its `--color-sienna` / `--color-text-primary` clear 4.5:1 / 7:1 over its own `--color-bg-base`
- **Making one**: the repo-level `make-theme` skill (`.claude/skills/make-theme/`) is the working procedure — `scripts/palette.mjs` keeps the 石 / 墨 lightness ramp and swaps hue and chroma (the method S7 used by hand), `scripts/check-theme.mjs` loads `check.ts` through vite so the verdict comes from `isMdSelector` / `isThemeSelector` / `tokenTier` / `readThemeMeta` rather than a second parser, and `--preview` resolves the palette with `exportPaletteCss` so the derived layer is real. It lives under `.claude/` rather than `scripts/` because it is an agent's procedure, not a build step; `check.ts` is outside `tsconfig`'s `include` on purpose and imports `src/lib/theme/*` by relative path, so a rename there must be followed here (the skill's own run is what catches it)
- Why the suite is eleven appearance files and two typography files rather than eleven pairs: a typography theme writes no literal colour — every value reads `var(--color-*)` — so the colour is the appearance theme's job and a per-colour copy of the rules would be eleven copies of one file. Reasoning in `docs/feature/theme-system-plan.md` §13 S7. See `docs/reference/design-system.md` → Theming / Markdown 排版主题

### `src/lib/image/`

a document's illustrations: where they land and what links them

#### 文档插图落点（assets.ts）
- (`assets.ts` — `assets/<文档名>/` beside the document, **relative** links, `saveDocumentAsset` for a generated picture / `importDocumentAsset` for one the author picked off disk, plus the move/delete follow-up that keeps links alive, and `relinkAssetGroup` — the repair behind the file tree's ⚠ on a group no document claims, which renames the folder **and** rewrites that document's links, because doing only the first is the step that actually breaks pictures that still resolved), and the approval→generate→file step (`illustrate.ts`).

#### 模型绑定的图片读取器
- Also the **model-bound image reader** (`normalize.ts` → `imageForModel`, planned by the pure `downscalePlan.ts` and short-circuited by the header-only `imageSize.ts`): a picture past the author's long-edge ceiling (`app:imageMaxLongEdge`, default 4096, 设置 → AI 配置 → 上下文与记忆) or the 12MB cap is **re-encoded smaller instead of refused**.
- Which of the three readers a call site wants is decided by where the bytes end up, not by what the file is — `imageForModel` for the wire, `imageToDataUrl` for rendering, `readImageBytes` for writing to disk — and getting that wrong is silent in both directions (a downscaled preview, or a permanently re-encoded avatar). See `docs/feature/image-normalize-plan.md`.

#### 图片生成与图集
- Generation itself runs through the `imagegen` subagent (bound model, `generate_image`/`edit_image` tools — not a delegate conversation), configured in `SubAgentsPane.tsx`; design: `docs/feature/image-generation-plan.md`.
- Lore entities use `lib/lore/gallery.ts` instead — they own a folder, a document is one file

### `src/lib/import/`

#### 转换器一览

document import into the workspace:

- docx via mammoth+turndown (`docx.ts`/`markdown.ts`)
- xlsx via the Rust `xlsx_to_markdown` command (`xlsx.ts` → `src-tauri/src/xlsx.rs`, the only converter not in the webview — calamine reads cached formula results, real dates and merged ranges)
- PDF text extraction via lazy pdfjs (`pdf.ts`)
- pptx via the Rust `pptx_to_markdown` command (`lib/fs/pptx.ts` → `src-tauri/src/pptx.rs`)
- GBK-aware text decode (`text.ts`)
- dialog orchestration + naming (`index.ts`).

#### 入口与只读缓存（导入对话框 / 转换文档 / read_document）

- **Two entry points**, one write step: the import dialog, and `convertProjectFile` behind the file tree's 右键 →「转换文档」 for a document already in the workspace (dragged in, pulled from git, or imported before this app could convert it) — both end in the same `writeConversion`, and neither ever touches the source file, because conversion is lossy in ways the author cannot undo.
- The converters have a **third reader that writes nothing to the project**: the agent's `read_document` tool (`lib/agent/documentTools.ts`) runs the same `convertToMarkdown` and pages the result like `read_file`, but the markdown lands in a content-hash-keyed cache under `.ai-writer/tmp/convert/` (`cache.ts` pure judgements — key, sidecar, scan detection, sweep plan; `cachedConvert.ts` the one disk-touching module) — invisible to `list_files` / `read_file` / `search_text` / backups, reachable by `read_image` for the extracted pictures.
- `read_file` / `read_slides` / `read_document` refuse each other's formats by name in the same round rather than one of them guessing from the extension.

#### 写入与落盘（convert_document）

- Its write half is the L2 `convert_document` tool (`lib/agent/convertTools.ts` → `ConvertProposal` card): the conversion runs at proposal time through that same cache, and approval **copies the cached entry out** beside the source (`lib/import/materialize.ts`, relinking pictures to `assets/<文档名>/`) rather than converting again, so what the author approved is what lands; see `docs/feature/agent/document-read-plan.md` §10.

#### 转换策略与图片抽取

- Two dispositions, decided by extension (`importMode`; `convertExtOf` when the caller needs *which* format): docx/xlsx/pdf/pptx **convert to markdown** because **no model API accepts those binaries** — they are zip archives; converting is not a shortcut, it is the only option.
- PDF, docx and pptx conversions also extract embedded **raster** images (vector drawings are a format limit, like tables degrading to text): converters return `{markdown, assets}` and stay pure — the import loop is what writes `assets/<文档名>/` and the body keeps relative links; the pure op-walking + keep/drop rules (dedupe, cross-page decoration, tiny images) live in `pdfImages.ts`, pptx pulls its `ppt/media/` parts Rust-side (the agent's paged `read_slides` deliberately never carries the bytes), and the decisions in `docs/feature/import-images-plan.md`.

#### 排除与直通

- Legacy .doc/.xls/.ppt stay out on purpose — no converter here reads them faithfully, and .ppt is an OLE compound binary the zip reader cannot open at all.
- txt/md/html and images are **copied in as-is** (same name, same extension; only a non-UTF-8 text encoding is normalised) — the app already opens all of them, so rewriting them would only destroy information. The copy list is `lib/fs/images`'s own kinds, not a second list here

### `src/lib/` 根模块

#### 多开与基础模块
- `project.ts`
- `keyStore.ts`
- `recentProjects.ts` (the recent-projects list and its pin set, pure: parsing, the cap that counts only unpinned entries, and the cross-instance merge `prefs.writePrefMerged` applies at persist time; the pinned section renders from the pin row, not the recents; both rows are machine-local)
- `staleRefs.ts` (清理失效数据 — behind the button of that name in `GeneralPane`: removes only **dead** absolute-path references — pinned-lore rows, roleplay agent bindings, a chat session's injection ledger and turn images — each checked against disk first)
- `instance.ts` (multi-instance / 多开 — the app runs as several processes, one workspace each, VS Code-style: the advisory `.ai-writer/window.lock` plus the loopback focus channel that brings the *existing* window forward when a folder is opened twice (dialog only as fallback), the CLI workspace argument, and spawning a sibling instance for the 新窗口 buttons
  - paired with `src-tauri/src/instance.rs` and the prefs focus refresh + merged recents write.
  - Separate processes are also why macOS's 「Window」 menu cannot list the siblings on its own — `src-tauri/src/windowmenu.rs` builds that list from a per-pid registry and switches via the same focus channel, and `useWindowTitle` is what gives each window a name to show.
  - Both — see `docs/reference/architecture.md` → Multi-instance)

#### 偏好与重置
- `prefs.ts` (**every** app preference — theme, language, panel widths, model selections; backed by `config.db`, read synchronously from an in-memory cache that `main.tsx` hydrates *before* importing anything that reads one. Never add a `localStorage` call: add a key to `PREF_KEYS` instead — see `docs/reference/architecture.md` → Preferences)
- `appReset.ts` (重置应用配置 —— 清空 `config.db` 的配置表、全部偏好和钥匙串里的密钥，**钥匙串先于数据库**，因为 `providers` 那几行是「钥匙串里有哪些账户」的唯一记录；文档 / 知识库 / 用量一律不碰。见 `docs/reference/architecture.md` → 重置应用配置)

#### 事务与通知
- `sqlTx.ts` (**the** way to run several writes as one transaction — the SQL plugin is a connection *pool*, so a hand-written `BEGIN`/`COMMIT` pair is not one transaction and deadlocks the pool; see `docs/reference/architecture.md` → Transactions)
- `notify.ts` (系统通知 — the OS ping for "waiting for your approval" / "run finished" / "run failed", each its own switch, off by default, silent while the window has focus; the only thing it must never carry is the model's or the document's text, see `docs/reference/architecture.md` → 系统通知)

#### 平台与能力探测
- `http.ts`
- `paths.ts`
- `platform.ts`
- `motion.ts` (the shared Motion presets for screen / panel transitions — the one sanctioned exception to pure-CSS motion; the variants animate a raw `transform`, so every consumer goes through `useMotionPreset()`, which is what keeps the reduced-motion promise)
- `webviewCaps.ts` (渲染引擎的能力底线 — probed by **feature**, never by OS or UA version: the floor the build targets, reported once per missing set under the TitleBar and always in Settings → 关于. Fill where the dependency offers a fill — pdfjs loads its `legacy/build` for exactly this — and probe only what nobody polyfills for us; see `docs/reference/architecture.md` → 渲染引擎的能力底线)

## `src/stores/`

Zustand stores。一个 store 一个关注点，**存的是「现在是什么」，不是「怎么做」**：决策形状的东西住在对应的 `lib/` 子系统里，store 只做时序、订阅和缓存。从 `CLAUDE.md` 搬来（2026-09-16），今天 `AGENTS.md` 只留一份名字索引。

- **`appStore`** — 主题、语言（i18n）、侧栏 / 面板折叠、活动标签页。持久化的字段经 `lib/prefs` 的 `prefBackedState()` 拿初值；配置导入之后由 `reloadFromPrefs()` 重新派生，因为那些字段只在启动时读过一次偏好。
- **`projectStore`** — 当前项目路径、文件树、活动文件，以及解析好的 `workspace`（启用了哪些能力包）。**组件订阅的是这里的 `workspace`**，不是 `lib/profile/active` 那个单例——单例不是响应式的。
- **`editorStore`** — 编辑器内容、脏标记、视图模式（editor / split / preview）、保存调度、字数 / 字符数（从内容算出，所以跟内容住一起）。**不 import `projectStore`**——要同时看两边的东西放在 `openDocument.ts`。写盘与切换的时序规矩（`saveNow` 只「清」自己写出去的那份、同一路径的写盘排成一条链、`loadFile` 先读后 flush 再同一拍切换）写在 `docs/feature/html-artifact-plan.md` D5。
- **`loreStore`** — 已索引的知识库条目、别名映射、条目摘要；项目打开时自动扫 `.ai-writer/lore/`（`scanLore`）。另带 `categoryNotes`：墙筛到某分类时读一次的分类说明摘要（`loadCategoryNote`，`null` 也缓存），换项目随索引清空、同项目重扫保留，`describe` 写盘经 `ToolAppState.categoryNoteWritten` 逐出一条——它**不在** `LoreIndex` 上，重扫读不到它（`docs/feature/lore/folder-note-plan.md` §5.2）。
- **`aiStore`** — 供应商、模型、提示词。**API 密钥不在这里**：它们经 Rust 的 `secret_*` 命令住在 OS 钥匙串里（`src/lib/keyStore.ts`），这个 store 只存「有哪些 provider」，而那几行也是「钥匙串里有哪些账户」的唯一记录（见 `appReset` 的顺序规矩）。
- **`outputRecoveryStore`** — 项目级恢复列表、流式正文检查点和按大纲分节生成；恢复只续写文字，绝不复原审批授权。
- **`aiTaskStore`** — 正在跑的 AI 任务：流式输出、token 用量、中断信号。任务按声明的 `tools` / `target` / `continuation` 分支，**从不按 id 分支**。
- **`agentStore`** — 对话助手的家：L2 审批队列 **和** 会话状态。同时开几个会话（`chats: Record<key, LiveChat>` + `activeChatKey` 一根轴，`runningChats` / `chatQueue` 另一根，信号量在 `lib/agent/scheduler.ts`，与 roleplay 共用）；每张卡片带 `surface: chat:<key>`，「本次都批准」的 key 是 `chatAutoApproveKey(key)` 而不是一个共享字面量。
  - **拆分（P5，docs/feature/code-structure-plan.md）。** `agentStore.ts` 只留 store 本体（状态、动作、审批队列）；类型在 `stores/agent/types.ts`，一次聊天运行与多会话管线在 `stores/agent/chatJob.ts`（用 store 的 `set` / `get` 调，不 import store），给组件的纯读取在 `stores/agent/selectors.ts`，批准后的写盘在 `lib/agent/proposalApply.ts`（app 以 `ProposalApplyDeps` 传入，所以每一种提案都能单测）。这些名字由 `agentStore` 重新导出，组件的 import 一行不用改。**`stores/` 的子目录只放一个 store 的私有拆分**，以 store 名命名（`stores/agent/`），不放跨 store 的东西——跨 store 的编排是 `stores/` 根下的平铺文件（`projectLifecycle.ts`、`openDocument.ts`、`configImportRefresh.ts`、`toolAppState.ts`）。
- **`navStore`** — 前进 / 后退历史，靠**观察**其他 store 记录——没有任何调用点登记什么。位置是作者真正在其间移动的那个三元组（哪个主视图 / 哪个文件 / 哪个条目）。
- **`batchStore`** — 批处理（`batch: true` 的任务）：对拆出来的子句顺序循环调 `runTask`（带 `{ fromBatch: true }`——`aiTaskStore` 据此不出任何中途卡片，而不是反过来读 `batchStore.running`，那会成环），结果逐条追加进一个输出文件。
- **`composerStore`** — 作者打了但还没发的内容。**按会话存，永不持久化**：AI 抽屉是 `AnimatePresence` 的子节点，关闭即卸载，原来放在 `useState` 里的半句话跟着一起死；而一句写了一半的指令属于作者，不属于正在显示它的那个界面。
- **`memoryStore`** — 每份文档的故事记忆片段（`lib/context/memory`）：覆盖范围、新鲜度、以及那次做摘要的运行。
- **`imageStore`** — 一次对话式的图像会话（初次生成，然后在其上编辑，每轮产出候选供作者挑）。轮次链是**树，不是线**——作者经常退回两轮再岔出去——并且每一轮都记下走的是哪条 provider 路径。
- **`docFormatStore`** — .docx 排版格式预设。**装机级，不是项目级**（一套公文格式要跨项目复用）：内置的在代码里，作者自建的落在 `config.db`，从一份 .docx 读出来的那一套只活在本次会话里。见 `docs/feature/docx/01-agent-design.md` §7。
- **`syncStore`** — 知识库同步：连接、绑定、plan→run 的生命周期。决策形状的东西已经在 `lib/sync` 里（三路比对、客户端、执行器），这里只管时序。**任何一个方向都不会在作者没看过计划的情况下执行**——刻意没有「立即同步」这个按钮。
- **`configSyncStore`** — 应用配置备份：槽位列表、一次推送、一次带预览的恢复。**与 `syncStore` 分开而不是做成它的一节，只因一件事决定了整个形状：这件事不需要打开任何项目。**
- **`consistencyStore`** — 一致性检查的状态。做成 store 而不是组件状态，是因为抽屉一次只渲染一个标签页：切到对话助手再切回来会把检查卸载掉。
- **`roleplayStore`** — 互动式角色扮演：花名册 + 每个 agent 的活会话 + 并发闸。为什么是新 store 而不是改造 `agentStore`，见它自己的文件头。
- **`themeStore`** — 设置页看到的主题注册表；是 `lib/theme/install` 的一层薄 React 面孔（经 `subscribeRegistry` 镜像），状态的主人在那边。
- **`digestStore`** — 集合摘要（`lib/context` 的 collection digests）的运行状态。
- **`configImportRefresh.ts`** — 不是 store，是「一份配置落地之后（从文件或从同步服务器）必须重读哪些东西」的**那一个**函数。两条路线共用它；**顺序就是全部的重点**：先从 prefs 取选择（恢复刚把它们写进去，而 store 只在启动时读），再 `loadConfig`（它的失效 id 清扫必须拿*那些* id 去比合并后的表，先跑就会把新的扫掉并持久化），最后才是外观偏好和排版格式预设。
- **`projectLifecycle.ts`** — 不是 store，是打开 / 切换 / 关闭项目的**唯一入口**（`openProject(path?)`、`closeProject()`）。`projectStore` 负责切换本身；聊天那一侧在切换里有两步——离开前问一句正在跑的对话、切换不会再失败之后恢复新项目的聊天——以 `ProjectSwitchHooks` 传进 `projectStore`，位置和顺序与原先一样（顺序写在文件头注释里）。钩子是**必填**参数：绕过这里直接调 `projectStore.openProject` 编译不过，而不是悄悄不问就切。原先是 `projectStore` 里 `await import("./agentStore")`，与 `agentStore` 成环（docs/feature/code-structure-plan.md P4）。
- **`openDocument.ts`** — 编辑器里打开的那篇文档，按项目与编辑器**合起来**看：`closeDocument()`、⌘S 的 `saveDocument()`、EditorArea 切文件的 `loadIntoEditor()`（三者的写盘失败都落在面包屑尾巴那一道 `editorStore.crumbTrace` 上——应用没有 toast）、从磁盘读之前只写脏缓冲区的 `flushIfOpen()`，以及每个 AI 动作认的「写作焦点」（`WritingFocus`、`getWritingFocus` / `useWritingFocus`，以及分开「还在载入」与「永远不会载入」的 `focusBlockOf` / `useFocusBlock`）。它们要同时读 `projectStore.activeFilePath` 和 `editorStore` 的缓冲区，原先住在 `editorStore`，于是 `editorStore` 与 `projectStore` 互相 import。
- **`toolAppState.ts`** — 不是 store，是 `ToolContext.appState` 的 store 一侧：agent 工具能读到的那几样活状态（`aiStore` 的模型 / 渠道 / 子代理绑定，`docFormatStore` 的格式清单与本次会话的「照 .docx 模仿」槽位）。每个启动运行的面（`agentStore`、`aiTaskStore`、`roleplayStore`、`consistencyStore`）传的都是这同一个对象，所以「工具看见的是哪份设置」只有一个答案；嵌套运行（`delegate`、`run_pack`、写手交接）原样转交。给的是 getter，工具在调用那一刻读——和原先工具里 `await import` store 的时刻一样。反向的两条通知也走这里（`addImitatedFormat`、`categoryNoteWritten`）：工具改了一样不在任何索引上的东西，store 得知道。

## `src-tauri/`

Rust 侧。

#### 装配与分工总则

- `lib.rs` 是装配（插件、命令注册、启动时登记的根）
- `main.rs` 只有那句不许删的 Windows 控制台注解。
- `[lib] crate-type` 只留 `rlib`：`main.rs` 按 rlib 链接它。脚手架默认的 `staticlib` / `cdylib` 是给 iOS / Android 的，本项目不出移动端，却要为它们每次 release 多写一个约 200 MB 的 `.lib`、多链一个 DLL（中文 MSVC 下还会冒出一条 `linker_messages` 警告）。真要上 `tauri ios` / `tauri android` 时再加回去。
- **一条贯穿的分工**：凡是 zip + XML 的读写都在这边（`zip` 和 `quick-xml` 已经是直接依赖，前端再引一个是白加），凡是 markdown 方言都在 TS 那边。

#### 命令与路径安全

- `commands.rs` 是自建的文件系统命令，全部 `async` 并把活交给 `blocking.rs`——一个不带 `async` 的 Tauri 命令跑在**主线程**上，而一次知识库扫描会连着调几百次 `fs_exists`，每次先 canonicalize，把窗口的事件循环一段段卡住；而光 `async` 也不够，那只是挪到 tokio 的 worker 上（有几个核就有几个），一块慢盘或一次钥匙串弹窗能占住其中一个任意久。`blocking.rs` 因此也被 `secrets.rs` / `transfer.rs` / `cmd.rs` / `scope.rs` 共用。命令有 `scaffold_project`、`read_dir_recursive` 和 `fs_*` 一族（读写文本、写二进制、追加、建 / 读 / 删目录、删文件、`fs_exists`、`fs_stat`、`fs_rename`……），每条在系统调用之前先过 `FsScope::check` 做 canonicalize；这次检查跟着其余的活一起进阻塞任务，所以 `FsScope` 是 `Clone`（一份根列表外面包一层 `Arc`，之后才允许的根照样算数）。
- `scope.rs` 是这些命令的运行期路径围栏：否则它们接受任意绝对路径，一个被攻陷的 webview 就能读写删任意文件；根只从可信来源登记（原生文件夹选择器、带 `.ai-writer` 标记的重开项目，而那个标记 webview 在已允许的根之外造不出来）。
- `protocol.rs` 注册 `ai-writer-asset:` 自定义 scheme（扩展名白名单 + 同一个 `FsScope`）。**应用已经不再产生这种链接**——知识库和文档里的图都以 data URL 渲染（`imageToDataUrl` / `useImageDataUrl`），因为 Webview2 的 URL 解析让这个 scheme 在 Windows 上不可靠；它留着只是为了让旧版本存下的文档里的 `ai-writer-asset://` 链接还能显示。
- `fontproto.rs` 注册 `ai-writer-font:`：只服务 `appDataDir/fonts/` 下的 `.woff2`（下载来的字体包），围栏比 `FsScope` 更窄，而且**先按字面判定再碰磁盘**——Windows 上把网页可控的 `//host/share` 交给 canonicalize 会发起 SMB 连接。异步协议，响应带 ACAO `*`（主窗口、沙箱样张、打印窗口都是跨源取字体）。

#### 密钥、事务与传输

- `secrets.rs` 是 API 密钥的 OS 凭据管理器后端（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），取代了早先会在某些 macOS 上死锁的 stronghold 和中途那版明文 SQLite；IPC 面到处一样（`secret_save` / `secret_load` / `secret_delete` 按 id 存 / 取 / 删一条，`secret_clear_all` 批量擦除、返回 `SecretWipe`），存储形状不一样——macOS 把**所有**密钥折进单个钥匙串项，其余平台一个 id 一条凭据。
- `sqltx.rs` 是「一个事务跑在一条连接上」的那个命令：`tauri-plugin-sql` 交给前端的是**连接池**，分开发的 `BEGIN` / `COMMIT` 落在不同连接上，根本不构成一个事务（见 `lib/sqlTx.ts` 与 `docs/reference/architecture.md` → Transactions）。
- `transfer.rs` 是导入导出：`zip_export_dialog` / `zip_import_dialog`（知识库包与项目备份）、`save_text_file_dialog` / `open_text_file_dialog`（配置备份的 JSON），对话框全在 Rust 侧——照 `scope.rs` 立的规矩，webview 从不提供任意目标路径，只接收用户在原生对话框里亲手点的路径。
  - zip-slip 防护靠 `enclosed_name()`。
  - `excludes` 在遍历时就在目录处剪掉整棵子树，按**完整路径段**匹配（所以 `.ai-writer/tmp` 不会吞掉 `.ai-writer/tmpl`）。
  - `require_manifest_kind` 先单独读一遍 manifest，不对就在解压任何东西之前返回——恢复到作者选的文件夹时，「文件选错了，什么都没发生」这句承诺靠的就是它。
- `lorehash.rs` 是条目的内容哈希：一个条目是一个**目录**（`index.md`、特征文件、`images.md`、头像、图集），同步需要一个「任何一样变了它就变、别的时候不变」的值，那也是服务器存的身份和客户端三路比对跑的东西。

#### 多开、窗口与打印

- `instance.rs` 是多开协调（劝告式的 `.ai-writer/window.lock` + 回环 focus 通道）
- `windowmenu.rs` 是 macOS 的「窗口」菜单——AppKit 只会列**本进程**的窗口，而这里每个窗口都是独立进程，所以那份列表从 `instance.rs` 的注册表渲染、切换走同一条 focus 通道。
- `preview.rs` 是独立的 HTML 预览窗（`docs/feature/html-artifact-plan.md` 三期）：应用内预览是编辑器里的沙箱 iframe，适合迭代、不适合按真实视口判断一张宣传页，所以这一份给文档自己一个 webview，用自定义 scheme 直接从盘上喂项目文件，相对链接因此照常工作。
- `print.rs` 是原生打印——`window.print()` 在 macOS 的 Tauri 里是**静默空操作**（WebKit 把打印请求转给宿主的 `WKUIDelegate`，而 wry 的 delegate 只实现了四个方法、不含打印，Tauri 也没加自己的），什么都不抛，所以导出菜单看起来是死的。

#### Office 读写器

- 三个 Office 读写器各有自己的理由：
  - `xlsx.rs`（calamine 读的是工作簿的**语义**——缓存的公式结果、真正的日期而不是序列号、合并区域，而可维护的 JS 选项要么做不到要么不可分发）
  - `xlsx_write.rs`（`rust_xlsxwriter` 本来就在树里给那边的往返测试造夹具，写的一半只多一次从 dev-dependency 的升格）
  - `pptx.rs`（一份 .pptx 的字节对模型毫无意义，而且它**按幻灯片区间**读——这是 `read_slides` 的那一半）
  - `docx.rs`（只读**排版参数**不读正文：格式便宜一个量级，正文保真要面对修订、域、内容控件、编号继承，所以导入端干脆放弃保真转 markdown）。

#### Shell 命令与测试

- `cmd.rs` 是 agent 的 `run_command` 的 Rust 一半（`cmd_shell_info` / `cmd_run` / `cmd_kill`），**刻意不用** `tauri-plugin-shell`（它唯一的安全机制是静态允许清单，对模型运行时现写的一行只能配成 `cmd: pwsh, args: true`，等于把清单关掉；而这个功能真正需要的超时、杀整棵进程树、输出封顶它都没有；`docs/feature/agent/shell-command-plan.md` §2.1）。
  - Windows 用 PowerShell（先 `pwsh`、退回 5.1，`CREATE_NO_WINDOW`，`-Command` 外面包一层 UTF-8 + 退出码）；unix 上是认得的 `$SHELL`（否则平台默认 shell）以 `-l -c` 跑在自己的进程组里。
  - `cwd` 和每条 `fs_*` 一样过 `FsScope::check`；审批卡是前端状态，所以这边守的是工作目录、超时、输出上限（每路 1 MB，超出后继续读掉丢弃）和杀整棵进程树。
- 测试内联在 `cmd.rs` / `commands.rs` / `docx.rs` / `fontproto.rs` / `instance.rs` / `lorehash.rs` / `pptx.rs` / `preview.rs` / `print.rs` / `protocol.rs` / `scope.rs` / `secrets.rs` / `sqltx.rs` / `transfer.rs` / `xlsx.rs` / `xlsx_write.rs` 里。

## `server/`

**not part of the app.** A standalone Rust/axum server (`aiw-kb-server`, `src/main.rs`) holding two unrelated resources that happen to share one host, one set of tokens and one data directory.

#### 知识库与配置备份两类资源

- **Knowledge bases** (`/v1/kbs`): the app pushes a project's lore tree up and pulls it back down on another machine (one-way whole-tree sync with a per-entry opt-out in the client's preview, per-entry content hashes).
- **Application-config backups** (`/v1/configs`): the app's providers / models / prompts / preferences, versioned per slot (newest N kept), arriving **encrypted whenever they carry API keys** — the password is derived on the author's machine and this server has neither it nor any code that would decrypt.
- It stores blobs and reports hashes — nothing in it parses markdown, knows what a facet is, or reads the config envelope (the `X-Config-Meta` display header is stored verbatim and handed back), so both formats can keep moving without it.

#### 与知识库设计的两处差异

- Two departures from the knowledge-base design are deliberate and documented in `store.rs`: a config version's hash is computed **by the server** (unlike an entry's, it *is* recoverable from the uploaded bytes), and `configs/` keeps a `.meta` sidecar where `entries/` forbids one (that ban is about sidecars holding a *hash*, which the client's three-way rail cannot tell has drifted).

#### 配置文件与管理控制台

- Configuration is a **TOML file with environment-variable overrides** (`config.rs` resolves it and remembers each value's provenance; `confedit.rs` writes it back through `toml_edit` so an operator's comments survive)
- and it serves an **admin console** at `/admin` — three `include_str!`-ed files under `server/admin/`, no build step — covering knowledge bases, sync tokens, an activity log (`audit.log`, the one record it keeps that it cannot derive, deliberately outside the truth path), disk/backup/maintenance, and config editing.
- The console has its **own credential** (username+password in `[admin]`); a sync token cannot log into it and its session cookie cannot call `/v1`.

#### 归属与相关文档

- A second binary, `aiw-kb-tray` (`src/bin/tray.rs`), is a Windows-only tray launcher running the same server in-process (start/stop from the menu, run at login, first-run credentials in a dialog); on other platforms it compiles to a stub that exits, so CI's `clippy --all-targets` still covers it. Design: `docs/feature/knowledge-base/kb-server-tray.md`.
- Its own crate, its own CI job, its own `server/README.md` (what it is + API + the console) and `server/DEPLOY.md` (编译 / 密钥 / systemd / Docker / TLS / 轮换 / 排错); design in `docs/feature/knowledge-base/remote-knowledge-base-feasibility.md` §13–§20 and `docs/feature/knowledge-base/kb-admin-console.md` (the console's own trade-offs and where it departs from 设计稿 03e).
- The client side lives in `src/lib/sync/` + `src/components/sync/` + Settings → 同步与备份
