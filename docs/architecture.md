# Architecture & Implementation Notes

> Deep-dive reference. Read the relevant subsection before working in that subsystem.

## Key Implementation Details

### Database Schema (SQLite)

Initialized in `src/lib/project.ts` and extended in `src/lib/ai/configDb.ts`:

```
project.db   token_usage (id, model_id, task, prompt_tokens, cached_tokens, completion_tokens, cost_usd, created_at)
config.db    providers   (id, name, base_url, api_standard, safety_settings, created_at)
config.db    models      (id, provider_id, model_id, name, type, price_in, price_cached_in, price_out,
                          enabled, prefix, context_size, max_output, probed_at, price_per_image, caps)
config.db    prompts     (id, name, content, scene)
config.db    prefs       (key, value)          -- see Preferences below
```

Two databases, and the split is what each thing *belongs to*: `project.db`
travels with the project folder, `config.db` (in `appDataDir`) belongs to the
installation. That is also the line the two backup features draw — see
Export / Import below.

`token_usage` is the only project-scoped table. Its `model_id` holds the
configured model's internal id; rows written by image runs before that was
corrected hold the provider's own model string instead, so `lib/ai/usage.ts`
matches both when naming a model.

**Removed:** `settings` and `lore_entities` were created on every project open
and never read or written by anything — `lore_entities` (note
`embedding_status`) was the remains of a SQLite-indexed knowledge base the app
no longer has; the tree under `.ai-writer/lore/` is the source of truth and
`loreStore` rescans it on open. `initSchema` now drops both
(`DEAD_PROJECT_TABLES`), best-effort, so a failed cleanup can't stop a project
opening.

### Usage accounting (Settings → 用量)

`src/lib/ai/usage.ts` is the read side of `token_usage`: two `GROUP BY`
rollups (by model, by task) over a 7d / 30d / all window, plus the delete
behind 清空统计. `total` is summed from the by-model buckets rather than
queried separately, so the headline can never disagree with the rows under it.
`SUM()` over an empty group returns NULL, which is coerced at the row boundary
— left alone it propagates as `NaN` through every later addition. Sorting is
cost-descending with an output-token tiebreak, so models the author never
priced still order usefully instead of collapsing to the bottom.

### Preferences (`src/lib/prefs.ts`)

Everything that is a *setting* rather than configuration or project data —
theme, language, fonts, panel widths, the lore budget, model selections,
model-picker recall, the onboarding flag, per-project pinned lore. They lived
in scattered `localStorage` calls, which meant clearing the webview's data (or
moving machines) silently reset all of them, and nothing could enumerate the
set to back it up. They are now rows in `config.db`'s `prefs (key, value)`.

The awkward part is that the store is async and the two biggest readers are
not: i18n takes its language as it initializes, and `appStore` computes its
whole initial state at module scope. So the module keeps an in-memory `Map` as
the synchronous read path and `main.tsx` calls `hydratePrefs()` **before
importing anything that reads a preference** — `./i18n`, `./App` and the error
boundary are dynamic imports for exactly that reason. Until hydration (vitest,
browser dev, or a database that will not open) every call falls through to
`localStorage` as before: a preference store that cannot reach its database
should cost the author their preferences syncing, not their app starting.

- **Migration** — `hydratePrefs` moves leftovers out of `localStorage` one key
  at a time, database-write first and `removeItem` second, because the reverse
  order turns a failed write into a lost preference. A key already in the
  database wins; a key the app does not own (`isPrefKey`) is never touched.
- **Collection** — `ai:pinnedLore:<absolute path>` accrued one row per project
  ever opened and nothing removed one, so renaming a folder orphaned its row
  permanently. `appStore` now prunes on `removeRecentProject` /
  `clearRecentProjects`, and `hydratePrefs` sweeps against the recents list at
  startup as a backstop.
- **Backup** — `portablePrefEntries()` is the subset a config backup carries;
  `MACHINE_LOCAL_PREF_KEYS` and the per-project families are filtered out on
  the way out *and* on the way back in, so a hand-edited backup cannot plant
  another machine's project paths. After an import, `appStore.reloadFromPrefs()`
  re-derives the pref-backed slice and repaints — without it the values are
  right in the store and the screen still shows what it computed at startup.
- **Writes** — serialized on one chain, so two `writePref` calls for the same
  key (a slider being dragged) land in call order rather than in whichever
  order the driver finishes them.

### The AI target (选区) and where a task acts

Every AI task acts *somewhere*, and getting that spot wrong is the failure mode
with the worst blast radius — polish/rewrite overwrite prose. Two mechanisms
commit a target, both writing one slot (`aiTaskStore.selection` +
`selectionRange` + `selectionSource`), last action wins:

- **Marked range** (`src/lib/editor/aiTarget.ts`) — ⌘⇧[ / ⌘⇧] / ⌘⇧\, or the
  buttons in `EditorBottomStrip`. Lives in a CodeMirror `StateField` and is
  **mapped through every change**, so the offsets stay exact across arbitrary
  edits, including edits inside the range. `to: null` is the half-marked state:
  surfaced in the UI, never treated as a target. Painted with a bottom band —
  not a fill, which `.cm-selectionBackground` already is. Dropped on any
  full-document replace (file switch, AI insert), since mapping across one
  leaves offsets pointing at unrelated prose. `CodeEditor`'s `updateListener`
  mirrors it to the stores; it is driven by the *field*, not by the mark
  commands, so edits that move the range keep the mirror in step.
- **Dragged selection** (`InlineAiBubble`) — committed at the moment the author
  acts on it (the bubble `preventDefault`s mousedown to keep the DOM selection
  alive). Required for the preview pane, which has no source offsets at all.
  Committing one drops any marker, so the document is never painted for a
  passage the assistant isn't working on.

Consumers ask `lib/context/rag.ts`, never re-derive:

| Question | Function | Not-sure answer |
|---|---|---|
| Where does polish/rewrite overwrite? | `resolveEditRange()` | `null` → append (lossless) |
| Where does a continuation attach? | `resolveAppendAnchor()` / `locateAppendAnchor()` | document end / `null` |
| How does it get spliced in? | `spliceContinuation()` | — |

`resolveEditRange` will relocate a *dragged* selection by verbatim search
(unique match only), but never a *marked* one: the editor maintains those
offsets, so if they've stopped describing the document, searching for the text
and overwriting whatever turns up is a bigger bug than appending.

**Continue positions.** `AiPanel` offers 开篇 / 文末 / 扩写选区 explicitly —
the three are not inferable from document state (an opening is offset 0 whether
or not something is selected). The chosen offset is passed down as
`TaskExtras.appendAnchor`, so the card's label, the prompt's reference window,
the budget and the insert all measure from the one place the author was shown.
Expand refuses to run when its passage can't be located rather than silently
relocating to the chapter end. This is separate from 承接/独立, which is a
question about the chapter's *age* (gated on its length, not on the anchor) —
fusing them is why expanding early in a long chapter used to drag in the
previous chapter's ending.

### Multi-draft output (生成版本)

- **Location** — `src/lib/ai/drafts.ts` (the `Draft` shape, `MAX_DRAFTS`, `totalUsage`), fan-out in `aiTaskStore.runTask`, `draftCountFor` alongside it, UI in `AiPanel`
- **Setting** — `appStore.draftCount` (1–5, persisted), chosen per run in the panel

A run produces a **list** of drafts, not one string: `drafts: Draft[]` + `activeDraftId`, where an ordinary task is simply a run with one draft. Modelling the single case as a degenerate multi-draft run — rather than as a separate field — is what stops the two paths drifting.

Asking for N assembles the context **once** and then fires N independent `streamCompletion` calls sharing one `AbortController`. The drafts differ only by the model's own sampling, which is the point: N takes on the same brief. Consequences worth knowing:

- `Promise.allSettled`, not `all` — one draft being refused or filtered records an error **on that draft** and leaves the others' text alone. The run only fails if every draft did.
- One `token_usage` row **per draft**, since each is a separately billed call; the panel footer shows `totalUsage(drafts)`.
- Drafts are patched **by id, not index**: N streams land out of order and a run can be replaced mid-flight, so an index could write into the next run's array. A stale id is a no-op, which is the right outcome.
- Ids carry a monotonic run counter, so React can't mistake a new run's first draft for the previous one re-rendering.

**`draftCountFor` pins two kinds to a single draft, and neither limit is cosmetic:**

| Kind | Why |
| --- | --- |
| `agent` | Its preset holds the L1 write tools and `propose_edit`. N agents would write to one lore folder concurrently and race N approval cards against one resolver — a correctness limit. |
| `continue` | Runs the agent loop too (read-only, so parallelism would be *safe*) but every round reports into one shared `agentLog`. N interleaved tool logs are unreadable, so multi-draft 续写 waits on per-draft logs. |

`MAX_DRAFTS` and the draft types live in `lib/ai/drafts` rather than in either store because both ends need them — `appStore` owns the setting, `aiTaskStore` owns the run — and importing across would close a cycle. It also keeps the pure parts testable without a store that touches `localStorage`/`document` at module load.

### Capability packs (能力包)

- **Location** — `src/lib/profile/` (`model.ts` pack types + built-ins + validation, `resolve.ts` the multi-pack merge, `file.ts` profile.json v1/v2/v3 parsing, `active.ts` singleton holding the merged `ResolvedWorkspace`, `store.ts` persistence)
- **Stored at** — `.ai-writer/profile.json`, per project. v3 is the current format — `{version: 3, enabled: [ids], packs: [custom], categories: [user-defined]}`; a v2 file (`{version: 2, primary, enabled, packs}`) reads with its retired primary normalised to "first enabled", and a v1 file (the whole object is one profile) still reads as that pack alone. Old files are only rewritten as v3 when the author changes the selection. **Absent means the novel pack alone**, so every project created before profiles existed keeps its categories and task menu.

Packs are **equal, purely additive toggles**: enabling one adds its predefined tasks and its knowledge-base categories, nothing more. There is deliberately no "primary pack" any more — it used to own the non-additive dimensions (UI vocabulary, doc model, the AI's persona), which made packs unequal and made the agent assume a domain role the author never chose. Those dimensions are app-level now: every project's knowledge store is a **知识库**, every file a 文档 (`appTerms`/`useTerms`), the document model is always all-on, and the system prompt is one neutral writing collaborator (see below). A project with **zero packs** is valid and useful: the base task menu, the user's own categories, the `custom` misc bucket.

`resolveWorkspace(enabled, userCategories)` merges: **categories** = every enabled pack's (union, deduped case-insensitively by id — a shared id like `style` is the same directory; first declarer labels it, `packIds` records every declarer) + the project's **user-defined categories** (from profile.json's top-level `categories`; marked `userDefined`, the only ones the settings UI lets the author rename/remove) + the app-level **`custom` bucket, always last** (so `fallbackCategoryId()` always has a misc pile). **Tasks** = the app-level base menu (`DEFAULT_TASKS`: 续写/润色/改写/总结/自定义/agent — always present) + each pack's own tasks; a pack declaring a *base* id **overrides** that base task in place (first enabled pack wins — this is how novel re-points 续写/改写/总结 at fiction wording), any other colliding id is dropped loudly. Each `ResolvedTask` carries the `packId` that `sectionLabel` resolves 【…】 wording against; base tasks nobody overrode carry none and speak the neutral defaults.

Per pack:

| Field | Drives |
| --- | --- |
| `categories` | The `.ai-writer/lore/<category>` folders — the knowledge-base layout, the lore scan, the category pickers, and the `category` enum in the agent's lore tools |
| `sections` | The 【…】 block labels *for this pack's tasks* (`bundleToMessages`), e.g. 【上一场景结尾】 instead of 【上一篇结尾】. `knowledge` is never overridden by built-ins — the knowledge base is called 知识库 everywhere |
| `tasks` | Base-task overrides and the pack's own tasks — see below |

Built-ins: `novel` (the default), `ttrpg` (跑团模组), `copy` (文案), `wechat` (微信公众号), `weekly` (周报), `feedback` (反馈报告) and `bid` (标书应答). Selection is Settings → 工作台 — each card is one on/off toggle — which calls `projectStore.setPacks(enabledIds)`: persist (v3) → scaffold the union's folders → rescan. The same pane (and the lore wall's 「+ 新建分类」 chip) manages the user-defined categories via `projectStore.setCustomCategories`, with folder ids derived by `suggestCategoryId` so the author only ever types a name. **Non-destructive** — a disabled pack's category folders and entities stay on disk and reappear on re-enabling, and removing a user category only hides its directory. The entries themselves stay *usable* meanwhile, as **orphan categories** (below); the pane's "N 个分类目录仍有内容" note now says which pack would give those categories their names and type schemas back. The AI panel groups the task menu by origin (`visibleTaskGroups`): the base menu flat (`pack: null` — an overridden base task still renders here), each pack's own tasks under a pack-name eyebrow.

#### 孤儿分类 (orphan categories)

`scanLore` 扫的是**磁盘上真实存在的目录**，不只是合并后的分类表：任何已启用包和用户自建分类都不声明、但里面有条目的目录，作为**孤儿分类**进入 `LoreIndex`（空目录不算——没人能往里新建的幽灵分类只会碍事；大小写不同的同一目录也只进一次，因为大小写不敏感的文件系统会把它报成另一个名字）。于是关掉一个能力包是**降级**而不是消失：条目照常出现在知识库墙、命令面板、AI 面板的清单里，照常被注入；失去的是分类的显示名（退回目录名）、类型 schema（`slots`/`imageSlots`，见 [`lore-entry-type-plan.md`](lore-entry-type-plan.md)），以及作为新建目标的资格。

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
| `tools` | `none` / `read` / `full`, resolved by `presetForTools` (lib/agent/presets). **Having tools is what makes a run agentic** — `none` maps to null, which is the signal to stream directly |
| `target` | `append` (splice at the continuation anchor) / `replace` (overwrite the selection) / `detached` (author inserts it if they want it) |
| `continuation` | Append at an anchor, prior-document context, and the length + 承接/独立 + outline/knowledge controls. One switch because they are one feature; only valid with `target: "append"` |
| `needsSelection`, `referenceWindow`, `freeform`, `hidden` | The remaining flags the old `TaskKind` branches encoded |
| `agentTaskId` | Which task the "Agent 模式" toggle switches to. A pointer, so the agent task stays an ordinary entry with its own prompt and toolset |

The task `id` is load-bearing in three places, so renaming one is a breaking change: the `scene` of an overriding prompt template, the `task` column in `token_usage`, and the execution log's label.

`draftCountFor` derives its rule from `tools`, not from a list of task names: **any tool-using task produces a single draft.** Every round of the loop reports into one shared `agentLog`, so parallel runs would interleave into an unreadable log; a `full` toolset additionally can't have concurrent runs touching one lore folder or racing approval cards. Stating it this way covers tasks nobody has written yet.

`DEFAULT_TASKS` is the app-level base menu (续写/改写/润色/总结/自定义/agent) — domain-neutral and present in every project, so a pack declares only its *own* tasks (plus any base-id overrides; novel's three instruction re-points are the only built-in ones). Packs can no longer drop a base task — the menu is uniform, and 续写 in a copy project simply continues the open document. `TTRPG_PROFILE`'s pair shows how `tools` is the load-bearing choice:

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

### Agent output: snapshots, not deltas

`runAgent`'s `onOutputText` hands over **the run's whole output each time**, so callers assign rather than append. Cumulative because the runtime is the only place that knows a round's text turned out not to be output at all: anything the model says before calling a tool ("我先去找文件列表。") is it thinking out loud, and it used to be spliced into the result the author then inserted into their document.

Text still streams as it arrives, so a tool round's narration appears and is then retracted when the round resolves. Buffering each round until its nature is known would instead stall the final answer — the part actually worth watching. The execution log records what the discarded round did, so nothing is lost.

This also settled a pre-existing inconsistency: `run.ts`'s `onText` was already cumulative while `splitter`'s `onProgress` was a delta, and `LoreSplitModal` appended accordingly. (`onProgress` is gone now — the split reports progress through its sink instead; see Facet splitting below.)

### 本次都批准 (standing approval grants)

Every L2 proposal and every lore plan blocks the tool loop on its own card. Right for one change, wrong for twenty: a housekeeping pass fires a dozen identical cards and the author stops reading by the fourth. So `ApprovalCard` and `PlanCard` each offer a third button that stands for the ones after it — `lib/agent/autoApprove.ts` + `agentStore.autoApprove`.

**Two kinds are never covered, whatever the author turned on.** `delete` removes a chapter and `illustrate` **spends money** (the card prints the price). An authorisation given for "keep fixing my prose" must not quietly become one for "keep buying pictures", so the excluded set lives in one list (`isAutoApprovable`) and the button simply doesn't render for those kinds — nothing to explain to the author, and nothing to remember at a call site.

**Scope is the caller's to declare, not the store's.** Both approval queues are shared by chat and the task panel, so a grant carries a `key`: the literal `"chat"` for a conversation (deliberately *not* the turn's controller — the grant has to outlive the turn it was pressed in), the run's own `AbortController` for a panel task. A proposal auto-approves only against its own key. That single test is what stops a panel task's grant from reaching chat, and is the same shape as `PendingRoundLimit.canPause`: a property of the run, decided by whoever owns it.

**One slot, so one surface at a time.** A second grant displaces the first rather than accumulating. Deliberate — the displaced surface falls back to asking, and erring toward one more question is always the safe direction.

Ending a grant: `rejectAll(reason, runId)` clears a run-keyed one (every panel finish/abort path already goes through it), `resetChat` and `switchChatSession` clear chat's. It is **not** written into the session blob: reopening a conversation from the history menu re-asks, which also saves a `chatSession` format change. There is no cross-restart persistence at all — standing authorisation that survives the process is a larger decision than this button.

Two things keep it from being invisible. `AutoApproveChip` sits in the chip row for as long as a grant is live and revokes it on click; and `ApprovalDecision.auto` rides back into the tool result (`writeTools.reportDecision`) so the model is told plainly that nobody reviewed that change. Note the plan grant skips the *card*, not the *gate* — the model still has to declare its steps, and `checkPlan` still refuses any lore write they don't cover.

### The run's lore snapshot

`ToolContext.loreIndex` is a **snapshot**, captured once when `runAgent` starts and shared by reference across every tool call in the run (the loop spreads the same context per call rather than rebuilding it). That is deliberate — resolving entities against a moving index mid-run would make a plan's steps mean different things at different rounds — but it has a sharp edge: a write that changes *what entities exist* is invisible to the rest of the run unless someone puts it there.

For a long time only some writes did. `move`/`delete` patched the snapshot by hand (`relocateInSnapshot`), `create` did not — so the model would create an entity, immediately try to write its body, and be told `entity "X" not found`, while the create's own result text said the index had been refreshed. It generally concluded it had the name wrong and created the entity a second time.

Three rules now hold it together:

- **`onLoreChanged` returns the fresh index**, and `writeTools.syncLore` pours it *into* `ctx.loreIndex` — in place, because reassigning would only fix the current call's view. Every write tool calls it **last**, and nothing may touch disk through an entity resolved before it: those objects are detached once it returns.
- **`runAgent` clones the index it is given** (`cloneLoreIndex`). What callers hand over is the live `loreStore` state object, and the snapshot patches splice its arrays — mutating it would edit store state behind zustand's back, on arrays React is rendering from. Cloning at the one funnel every surface passes through means a caller added later cannot forget it.
- **`syncLore` never throws.** `executeRegisteredTool` turns a throw into an `"Error: …"` result, so a rescan failing *after* a successful write would report the write as failed — and the model would redo it. The hand-written snapshot patches stay as the fallback, which is also what keeps surfaces with no rescan at all (`lore/generator`, `lore/splitter`, both passing `loreIndex: {}`) working.

Because the tools now *await* the rescan, `loreStore.scanProject` has to be worth awaiting. It serializes: scans used to run fire-and-parallel, and whichever *resolved* last installed its index — not the one that started last, which is where the intermittent "the index didn't update" came from. A caller arriving while a scan is merely **queued** shares it (that scan will read disk strictly after their write, so it is fresh enough), which is what keeps a burst of writes to one extra walk instead of one each. That guarantee holds only because the queued scan has genuinely not called `scanLore` yet — anything that pre-starts it breaks it silently.

A preset carrying lore *write* tools must supply `onLoreChanged`; it stays optional on `ToolContext` only because the read-only presets legitimately have nothing to write.

### Images in context (谁能看图，看多久)

A picture reaches a model exactly one way: an `image_url` part on a `role: "user"` message (`ContentPart`, `lib/ai/types.ts`). Everything below is about who is allowed to create one and what happens to it afterwards.

**Three entry points**, all gated on `model.type === "multimodal"` — a *declaration on the model row* in 设置 → 供应商与模型, not a guess from the model name. A text-only model is told the picture could not travel rather than silently losing it:

| Entry | Who chooses the picture | Scope |
| --- | --- | --- |
| `read_lore_image` tool | the model | one entity's avatar / gallery image, by name + filename |
| `read_image` tool | the model | any image file **inside the project** — document illustrations in a sibling `assets/`, reference art anywhere else |
| chat `@`-mention | the author | any image `scanProjectFiles` found; inlined by `lib/agent/chatRefs`, ≤ `MAX_MESSAGE_IMAGES` per message |

`read_image` is contained against the *whole project*, where `read_file` (and the other text tools) additionally exclude `.ai-writer/` (`isWorkspacePath` in `lib/paths.ts`). The text tools are narrower because a prompt-injected model could read `profile.json` or the lore back to whoever planted the instruction; an image tool decodes one file, by extension, into pixels — and lore gallery images live under `.ai-writer/lore/`, where it must still reach. Both refuse outright when there is no project path — every absolute path is "inside" an empty prefix.

**Nothing keeps a picture for long.** Base64 is megabytes, and a chat history persists for the whole session, so three separate passes take pixels back out — all through `lib/agent/imageHistory`, which is the single definition of the shape, and all of which **keep the message's text**: the author's attachment rides on their question, which is a turn boundary `compact.ts` segments on.

1. `trimHistory` (`runtime.ts`) caps a live history at the newest `MAX_IMAGE_RESULTS` (3) pictures — unconditionally, before the token check, because the token estimate charges a *flat rate* per image while the payload keeps growing.
2. The same pass elides more, oldest-first, when the estimate is over the ceiling.
3. `serializeChatSession` drops every picture before the session blob goes into its SQLite row. A restored session has the conversation, not the pixels — and the paths are still in the transcript, so `read_image` can fetch one again.

### RAG (Retrieval-Augmented Generation)

- **Location** — `src/lib/context/rag.ts` (assembly) + `src/lib/context/loreSelect.ts` (lore selection)
- **Method** — Alias-based keyword matching (no embeddings, fast); facet-level secondary-key matching within matched entities
- **Context Assembly** (4 layers in `assembleContext()`):
  1. System prompt (from active template or default)
  2. Lore (facet-aware layered selection, see below)
  3. Recent document context (last 2400 chars before selection)
  4. Task instruction (continue/polish/rewrite/summary/custom)
- **Output** → `ContextBundle` → formatted to messages via `bundleToMessages()`; carries a `loreReport` (what was injected/dropped and why) rendered in `AiPanel`
- **The chat is the exception to layer 3.** A writing task is invoked *on* the open document, so it gets the window. The conversational assistant is not: it defaults to a **brief** of the open file (path, title, length, heading outline, plus a line saying the text was withheld and which path to `read_file`), and injects the window only when the turn points at the document — a pinned selection, or wording like 这一段 / 本章 / 全文 / 继续写 / `this chapter`. Decision layer in `src/lib/context/docFocus.ts`, wiring in `agentStore.sendChat`, rationale in `docs/chat-memory-plan.md` §5a. The body can arrive on any later turn (`ChatSessionMeta.bodyDocPath` remembers whether it already did)

#### Facet-aware lore selection (`loreSelect.ts`)

An entity is a folder; any sibling `.md` with a `facet` frontmatter field (title, `keys`, `group`, `priority`, `mode: auto|always|manual`) is an independently-activatable **facet** — an outfit, a backstory arc, etc. Selection layers under one char budget (user setting in `appStore.loreBudgetTokens`, default 600 tk, range 200–128k, converted to chars by the planner's measured chars/token — presets + a free number field in `AiPanel`):

1. **Summary** (frontmatter one-liner) — every matched entity, guaranteed
2. **Core** (`index.md` body) — paragraph-boundary truncated to fit
3. **Facets** — `auto` fires on entity match AND any key in the match target; same-`group` facets are mutually exclusive (highest priority wins; pins override); a facet that doesn't fit whole is dropped, never truncated

Pins come from `AiPanel` as `dirPath` (whole entity) or `dirPath#file` (single facet; implies its entity). Facet/core content is re-read from disk each call so hand edits are never stale. AI-assisted splitting of an oversized `index.md` into facets lives in `src/lib/lore/splitter.ts` + `LoreSplitModal` (backs up to `.ai-writer/backups/` before applying). See `docs/lore-facet-plan.md` for the full design.

#### Facet splitting: why the result arrives as tool calls

The split asks the model to move the author's own paragraphs, verbatim, into a core card plus N facets — and it used to ask for all of that as **one JSON object in the reply text**. That makes the model hand-write a multi-thousand-character JSON string full of someone else's quotes and newlines, and it failed constantly on real entries: one unescaped `"` copied straight out of the source (`其名取自"…"`), or an output cap landing mid-string, threw the whole run away with `Failed to parse model response as JSON` — after paying for every token of it.

The controlled experiment was already in the app: asked to do the same split, the conversational assistant never trips on this, because it writes one `update_lore_file` per facet and the endpoint decodes those arguments against the schema. Total output is *larger* there, so volume was never the variable. The two that matter are **whether the JSON is constrained-decoded** and **how long a single uninterrupted hand-written string has to be**.

So `splitLore` runs a tool loop over `split_core` + `split_facet` (`lib/agent/splitTools.ts`) — the only tools in the registry that write nothing anywhere. They append to a `SplitSink` handed in on `ToolContext`; the modal renders the sink as its review list and the author's Apply is still the only thing that reaches disk. Consequences worth keeping straight:

- **Escaping stops being the model's job.** Same mechanism `update_lore_file` has always had.
- **The output cap can only cut one facet short.** The runtime drops a truncated call and tells the model so (`argumentsUsable`); resending the facet under the same title *replaces* it, so the retry can't duplicate.
- **A run that ends early still delivers.** `force-text` withholds tools on the last round, so whatever was submitted arrives at the review list. When the core card is among the missing pieces the modal fills in the original body and says so — otherwise Apply would leave the facet text in two places.
- **No JSON mode.** `response_format` conflicts with tool calling on several providers; the schema is the enforcement now.
- `parseSplitResponse` survives as the fallback for a model that ignores the tools and prints the old object anyway.

### Large outputs: the per-reply cap (`modelLimits.ts` + the runtime's recovery)

The limit a big deliverable hits is **max output tokens** — one reply's ceiling — not the context window. Three layers deal with it, because no single one can:

- **Say what the ceiling is.** `effectiveMaxOutput(model, defaultMaxOutput())` resolves it in one place for both the request and the planner: the author's own `maxOutput` → the built-in table (`src/lib/ai/modelLimits.ts`) → the app-wide default (Settings → 供应商与模型, pref `app:defaultMaxOutput`) → each protocol's own fallback. The table deliberately holds **no Anthropic entries**: there a `max_tokens` above the model's ceiling is a 400, so `anthropic.DEFAULT_MAX_TOKENS` (32k) keeps that job. Elsewhere the value is planning-only — the OpenAI and Gemini adapters send no cap at all. 「探测真实上限」 (`endpointProbe.ts`) measures the truth and writes it onto the model; the table is only what an author sees before they bother.
- **Write files in pieces.** `append_file` is the one write tool whose per-call size is independent of the file's size: `create_file` the skeleton (structure + one `<!-- SECTION: x -->` placeholder per section), then a call per section. Its card offers a **per-file** grant (`AutoApproveState.appendPaths`) so a long build isn't a click per section, without becoming a blanket write authorisation.
- **Recover when it happens anyway.** `runAgent` distinguishes the two casualties. Cut prose: keep what arrived, append a "continue from where you stopped" user message (kept in the history — dropping it would put two assistant messages side by side, which Anthropic rejects), loop. A cut **tool call**: drop it unexecuted and never let it into the history — the Anthropic and Gemini adapters re-serialise past tool calls, so one fragment of JSON breaks every later round — execute whatever else that round emitted, and tell the model to write in pieces. Three recoveries per run are silent; after that the author decides on a card (`TruncationCard`), since every retry is another paid request. Surfaces that can't render the card (batch runs, lore modals) simply stop recovering.

### Context budget planner (`budget.ts`)

`src/lib/context/budget.ts` divides the model's declared window among the layers that can be sized, so a 1M-token model isn't fed the same 1500-token recap as an 8k one. Called from `aiTaskStore.runTask()` **before** `buildBookContext()`, since that build spends its own budget.

Spend order (each step takes from what the last left):

1. **Output reserve** — `outputReserveTokens()`: 2× the requested reply length, floor 2000 tokens, then capped by `model.maxOutput` when it is known (a model that cannot emit more than 4k gains nothing from a 12k reserve — the surplus goes back to the prompt)
2. **Fixed costs** — `fixedContextChars()`: system prompt, task text, outline/knowledge, prev-chapter tail. Non-negotiable, they *are* the request
3. **Verbatim window floor** — `RECENT_WINDOW_MIN_CHARS` (2400) for `【近期内容】`. Prose the model can quote outranks any summary of it, so this comes before the recap layers get anything
4. **Lore** — the author's `appStore.loreBudgetTokens`, honored as-is; only trimmed if the window physically can't hold it
5. **Leftover** — half **grows the verbatim window** (same reasoning: on a 1M model the first thing worth buying is more of the actual page, not more summary of it), capped by how much text precedes the anchor. The rest splits 60/40 between `【前情提要】` and `【全书前情】`. A layer that can't contribute (no memory file / not a continuation) yields its share up front; the book layer's *unspent* share reflows to memory afterwards via `reflowMemoryBudget(plan, bookUsedChars)`

The verbatim window is only plannable for tasks with no picker (continue / custom). Polish / rewrite / summary expose 「参考上下文范围」 in `AiPanel`, and an explicit choice there — **including 0** — is an author decision the planner honors exactly and never grows.

- **`appStore.contextUtilization`** (default 0.5, chips in `AiPanel`) caps what one request may occupy — a window that *can* hold 1M tokens still costs money to fill on every task, and long contexts dilute instruction-following
- **No declared `contextSize` → static fallback.** The plan returns the historical constants (`MEMORY_BUDGET_CHARS`, `BOOK_PRIOR_BUDGET_CHARS`, `RECENT_WINDOW_MIN_CHARS`) and `dynamic: false`; nothing changes for users who never filled the field in. Lore is additionally hard-capped at `STATIC_LORE_BUDGET_MAX_TOKENS` (2000) on this path — `lib/ai/index.ts` only pre-flights when `contextSize > 0`, so without that cap nothing at all would stop a 128k-token lore setting from building a prompt no endpoint accepts
- **Agentic runs keep planning after turn 1.** `plan.inputCeilingTokens` is handed to `runAgentLoop`, which elides the oldest tool-result payloads (leaving the messages themselves in place — an unanswered `tool_call` is a protocol error) rather than letting round 6 die on a `ContextSizeError` the author waited five rounds for
- **chars/token is measured, never assumed.** `measureCharsPerToken(documentText)` samples the manuscript through `lib/ai/tokenEstimate` — the *same* estimator the pre-flight context gate uses. The rest of the context layer assumes ~3 chars/token while that gate counts CJK at ~1 token/char; planning with the optimistic ratio would build prompts the client then refuses to send. Measuring keeps plan and gate in agreement and adapts to Chinese (~1) vs Latin-script (~4) projects on its own
- **Model context size** — slider (`CONTEXT_SIZE_STOPS`: 16k/32k/128k/256k/512k/1M) plus an exact number field in the model editor, since real windows sit between stops (Claude's 200k, 64k local builds). See `src/lib/ai/contextSize.ts`. The 「探测真实上限」 panel below those fields fills both of them by measurement — see below

### Endpoint probing (探测真实上限)

Everything above trusts `model.contextSize` / `model.maxOutput`, and hand-typed values are wrong often enough — and wrong in *different ways per backend* — that the planner needs a way to check. `src/lib/ai/probeAnalysis.ts` (pure, unit-tested) + `src/lib/ai/endpointProbe.ts` (HTTP) + `src/components/settings/ModelProbePanel.tsx` (UI, under the context-size field) do that.

Three quantities that "context size" conflates, kept apart on purpose:

| Quantity | Question | Who lies about it |
|---|---|---|
| **Accepted limit** | how large a prompt survives without a 4xx | relays (a gateway caps below its upstream) |
| **Untruncated limit** | how much the server actually *forwards* | local backends — ollama's `num_ctx` drops the head and still answers 200 OK |
| **Effective limit** | how deep the model still attends | everyone; not measured here |

Run order, cheapest first — most endpoints are resolved before a token is spent:

1. **Free metadata (0 tokens)** — `readEntryLimits()` walks any provider JSON for a candidate key rather than hardcoding one per backend: vLLM `max_model_len`, OpenRouter `context_length` + `top_provider.max_completion_tokens`, LM Studio `max_context_length` / `loaded_context_length`, Gemini `inputTokenLimit` / `outputTokenLimit`. For local targets it also reads ollama's `POST /api/show` (both the model's `<arch>.context_length` *and* the `num_ctx` actually in force — they routinely differ by 30×) and llama.cpp's `GET /props` (`default_generation_settings.n_ctx`, the server's real `-c`)
2. **Error probe (~0 tokens)** — one streaming request with a two-word prompt and an absurd `max_tokens`; servers that enforce a limit write the number into the 4xx body, which is exact and free. An *accepted* probe is aborted at the first byte. Handles the `max_tokens` → `max_completion_tokens` rename with a single retry
3. **Calibration + truncation check (a few k tokens)** — two paddings of different sizes; the *difference* in reported `prompt_tokens` cancels the chat-template overhead and yields this endpoint's real chars/token. Then one prompt of known size is compared against the server's own count. Quick mode bounds this at `QUICK_TRUNCATION_TOKENS` (8192) so a probe on a 1M model still costs cents — enough to catch the ollama default, not enough to catch a cap above 8k
4. **Deep pass (opt-in, cost shown, second press required)** — binary search for the accepted ceiling (starts at the declared value; a pass ends the search in one request) and a real generation with a task the model can't finish naturally, so `finish_reason` disambiguates "the ceiling" from "it was done talking"

Rules the implementation is built around:

- **Error classification is the whole ballgame.** Reading a 429 or a 502 as "that's the ceiling" would record a rate-limited 128k model as whatever size tripped the quota. Only messages that actually name a context/output limit are `conclusive`; 413 is a gateway *body-size* cap and is reported separately; transient kinds are retried with backoff and never become evidence
- **Smallest credible value wins.** `suggestSettings()` takes the minimum across findings and reports the disagreement — the effective ceiling is whatever link is tightest, and too-low costs unused window while too-high returns to silent truncation
- **Detection is proof; non-detection is not.** A server may report the pre-truncation count, omit usage, or (via a relay) invent it. Both the report and the UI string say so explicitly
- **Nothing is written automatically.** The probe fills the form only when the author presses 应用, and the form still has to be saved. `model.probedAt` dates the measurement, because a relay can re-route the same model name tomorrow
- **Padding is a seeded word sequence**, not `"aaa…"` or a repeated paragraph — prefix caching and some tokenizers collapse long repeats, which would make the measured count a fiction

### Story Memory (前情记忆)

Per-document rolling summary so long manuscripts don't lose early plot in AI tasks — the assembled context carries a `【前情提要】` layer (compacted summaries of everything before the verbatim window) ahead of `【近期内容】`.

- **Location** — `src/lib/context/memory.ts` (pure logic + file IO), `src/stores/memoryStore.ts` (generation orchestration), UI strip in `AiPanel.tsx`
- **Storage** — `.ai-writer/memory/<relative doc path>.md`: machine metadata (segment ranges + FNV-1a hashes) in a leading `<!-- ai-writer-memory {json} -->` comment; each segment's summary is a human-editable `## …` section paired by order
- **Segmentation** — source split at paragraph boundaries into ~12k-char segments (scaled by `model.contextSize`); coverage stops `MEMORY_TAIL_KEEP_CHARS` (2000) before the end — the verbatim window handles the tail
- **Updates are incremental** — appending only summarizes the new tail; editing early text invalidates that segment *and everything after it* (offsets shift), and an update re-summarizes from the first stale segment. Manual, never automatic: the AiPanel strip shows coverage/staleness and prompts the user to create/update when >10k pre-window chars are uncovered
- **Context selection** — `selectMemoryForContext()` includes only segments starting before the verbatim window (a mid-document selection never sees later plot), newest-first under a budget from the planner below (a 0 budget means "no room" and yields nothing)
- **Usage tracking** — summarization tokens land in `token_usage` with `task = "memory"`

### Book Spine & cross-chapter memory (大纲书脊 / 文库)

Story Memory is *per-document*, so a chapter is its own file and knows nothing of its siblings. The book spine adds an explicit chapter *order* so continuing a fresh chapter can see what came before it.

- **Location** — `src/lib/context/outline.ts` (order resolution, spine IO) + `src/lib/context/bookContext.ts` (book-context assembly); the **library view** (文库, `MainView` id `library`, `src/components/library/LibraryView.tsx` — formerly 大纲·全图/OutlineFullView) is the editor (drag-to-reorder). Plan & naming rationale: `docs/library-plan.md`
- **Storage** — `.ai-writer/outline.json`: `{ version, order: { <volume relPath>: [<chapter relPath>, …] }, volumes: [<volume relPath>, …] }`. A **volume** = a book: chapter files at the workspace root form a default volume (relPath `""`), each folder — at any depth, `assets/` excluded — is its own. `volumes` orders the columns themselves with the same overlay semantics (absent in older files → traversal order, exactly what they had)
- **Order is an overlay, not a rigid list** — `applySpine()` applies the manifest order, drops entries whose file vanished, and appends un-listed files by **natural (numeric-aware) sort** (`naturalCompare` — so 第2章 < 第10章, 6-1 < 6-2 < 7). Creating/deleting files outside the outline UI never breaks ordering; the backend's byte-sort no longer decides chapter order
- **Chapter files** — `.md` / `.markdown` / `.txt` (the outline view previously dropped `.txt`)
- **Resources** — `Volume.resources` lists a folder's direct *non-chapter* files (images, PDFs…), natural-sorted; the library view renders them under the chapter cards (images with a data-URL thumbnail, same path as `ImagePreview`) and clicking opens them in the editor area. Purely display-layer: resources never enter the spine, `bookContext`, or any AI context. A folder holding only resources (the root included) still shows as a collection, and a volume with resources is not "empty" — it can't be deleted from the library
- **Collection digest (集合摘要)** — per-volume AI summary shown on each library column (`lib/context/collectionDigest.ts` format/IO/freshness + `stores/digestStore.ts` one-at-a-time generation). Stored at `.ai-writer/collections/<volume relPath>/digest.md` (root volume: `collections/digest.md`) in the memory-file style: `<!-- ai-writer-digest {json} -->` metadata (ordered chapter relPath+hash list) over an author-editable summary body. Stale when the chapter set changed, was **reordered**, or any content hash mismatches. Generation prefers each chapter's *fresh* story-memory summaries over raw text, fits the prompt to `segmentTargetChars(model.contextSize)` by equal-share truncation (400-char floor), uses the summary model (`memoryModelId ?? activeModelId`), and bills to `token_usage` as task `digest`. Display-layer only — digests never feed AI task context
- **Referenced lore chips** — the same one-pass chapter read that drives the memory badges also runs `matchEntitiesInText` (`lib/lore/match.ts`, loreSelect's auto-match semantics: case-insensitive name/alias substring) over each volume's full text; the chips navigate via `loreStore.openDetail` + the lore wall. Local scan, no AI cost, recomputed every visit — never stale, never persisted
- **Continuation memory** — `buildBookContext()` (called from `aiTaskStore` for the `continue` task) resolves the active chapter's position in its volume and returns two layers, emitted by `bundleToMessages`:
  - `【全书前情】` — recap of prior chapters, from *their* memory files, newest-first under a planner-supplied budget (chapters without a memory file simply contribute nothing — generate per-chapter memory to enrich it)
  - `【上一章结尾·<title>】` — the previous chapter's verbatim ending (a bridge), included only when the cursor is near this chapter's start; deeper in, the chapter's own `【近期内容】` carries continuity
- **Scope** — resolution stays within the active chapter's volume; only the `continue` task consumes it (a mid-document edit stays local)
- **Per-chapter memory in the outline** — each chapter card shows its Story-Memory state (`memoryStatus()` → 就绪 / 需更新 / 无摘要 / 过短) and can trigger generation *for that chapter* without opening it. The generation core is factored into `runMemoryGeneration()` (shared by `memoryStore.generate` for the active doc and `memoryStore.generateForFile(absPath)` for outline-triggered chapters); `generateForFile` reads the target's content from disk (or the live editor when it's the open file) and tracks progress under `chapterGen` so it doesn't collide with the AiPanel's active-doc strip
- **Summary model** — `aiStore.memoryModelId` (set from the outline header picker) selects which model does summarization; `memoryStore.resolveModel()` falls back to `activeModelId` when unset
- **Volume & chapter management in the library** — a volume maps to a workspace folder (empty ones included, so they're usable as move/create targets). The library can create a volume (`makeDir`), rename one (`projectStore.moveEntry` the folder, then move the mirrored `.ai-writer/memory/<rel>` and `.ai-writer/collections/<rel>` subtrees along and prefix-rewrite the spine via `renameVolumeInSpine` — nested volume keys included, path-segment aware), reorder columns (◀▶ buttons → `spine.volumes`), and delete a truly empty one (`removeDir`; the workspace-root volume is never deletable or renamable). Chapters: the empty-volume placeholder card creates one (`projectStore.createEntry`, which refuses overwrites), the context menu offers open / mark 在写 / rename / delete — rename keeps the old extension for a bare name, carries the spine position + 在写 status + memory file to the new relPath; delete goes through `projectStore.deleteEntry` with `backup: true` (snapshotted into `.ai-writer/backups/`, same as the file tree) and cleans the status entry. Selected chapters move between volumes via the header picker (`moveEntry` + `moveMemory` per chapter). Single click *selects* (multi-select), double click opens, the top/up/down/bottom buttons reorder within a volume, and **drag works across volumes too**: dropping on a chapter inserts at its position (in-volume → reorder; cross-volume → file move + memory + spine position + status), dropping on a column's empty space appends at its end
- **Chapter status** — `BookSpine.status` (persisted in `outline.json`) maps a chapter relPath → `"writing"`; absence means done. Set via the chapter context menu; the header stat splits 完 / 在写 from it. `spineFromVolumes(volumes, prev)` carries the status map across reorders
- **Forcing a short chapter's summary** — the outline's per-chapter generate button passes `force` for `status === "short"`; `runMemoryGeneration({ force })` then bypasses the `MEMORY_MIN_DOC_CHARS` guard and covers the *whole* chapter (no verbatim tail), since a short prior chapter's book-level recap wants all of it

### Streaming (SSE)

- **Location** — `src/lib/ai/` (`index.ts` dispatch + pre-flight checks, `openai.ts` / `gemini.ts` / `anthropic.ts` adapters, `types.ts` shared protocol types)
- **Providers** — OpenAI + compatible APIs (SSE `data: {...}` lines), Google Gemini (alt=sse format), Anthropic Messages API (typed SSE events: `message_start` → `content_block_delta` → `message_delta` → `message_stop`)
- **Parsing** — Fetch + ReadableStream, line-by-line JSON parsing
- **Internal message shape is OpenAI's** (`StreamMessage`, tool calls with a JSON-string `arguments`). The Gemini and Anthropic adapters each own a converter — `convertToGeminiContents` / `convertToAnthropicMessages` — including the tool-call round trip and the data-URL → base64 image conversion. Anthropic additionally enforces two structural rules the others don't: the first message must be `user`, and adjacent same-role turns must be merged
- **Token Tracking** — OpenAI sends `include_usage: true` in stream_options; Gemini in final `usageMetadata`; Anthropic in `message_start.message.usage` (prompt) plus `message_delta.usage` (output)
- **Anthropic usage is normalized on the way in.** The app's `cachedTokens` is a *subset* of `inputTokens` (what OpenAI and Gemini report, and what `costFor` bills against). Anthropic instead reports three disjoint buckets, so the adapter sums them: `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `cachedTokens = cache_read_input_tokens`. Reading `input_tokens` alone would under-report a cached prompt by however much was cached. Cache *writes* bill above the base input rate and `Model` has no field for it, so they land in the full-price bucket — over-stating rather than under-stating cost
- **`max_tokens` is required by Anthropic**, with no server-side default to fall back on, so `Model.maxOutput` is threaded into `StreamOptions` and sent on that path (a constant when unset). It stays planning-only for the other two
- **Thinking vs forced tools (Anthropic)** — current Claude models think by default when `thinking` is omitted, but extended thinking is incompatible with a forced `tool_choice`, and `agent/structured.ts` forces a named tool for every structured task. The adapter therefore sends `thinking: {type: "disabled"}` *only* on the forced-tool path; see `thinkingFor` in `anthropic.ts` before changing it
- **JSON mode** — `ai/jsonMode.ts` owns the per-protocol decision: `response_format` for OpenAI, `responseMimeType` for Gemini, and **nothing** for Anthropic (unknown top-level fields are a 400 there) plus a text cue in the user turn. Callers needing schema enforcement rather than "valid JSON" use `agent/structured.ts`, whose forced pseudo-tool call works on all three

### Secure Key Storage

- **Backend** — OS credential manager via the `keyring` crate (Windows Credential Manager / macOS Keychain / Linux Secret Service), service name `com.simple-ai-writer.app`
- **Rust commands** — `secret_save` / `secret_load` / `secret_delete` in `src-tauri/src/secrets.rs`
- **Frontend** — `src/lib/keyStore.ts`: `saveApiKey(providerId, key)`, `loadApiKey(providerId)`, `deleteApiKey(providerId)`; falls back to sessionStorage outside Tauri (browser dev)
- **Migration** — keys stored by older builds in the plaintext SQLite `api_keys` table are moved into the keyring and deleted from the DB. `migrateLegacyKeys()` sweeps the *whole* table once per launch (from `aiStore`'s lazily-initialized `db()`, alongside `ensureAiSchema`) and then `DROP`s it + `VACUUM`s — the lazy per-provider path only ever ran for a provider something asked about, so a key belonging to a provider the author stopped using (or deleted from the UI) stayed in plaintext indefinitely. Per row the order is save-then-delete, so an interruption at worst duplicates a key into the keyring; the table is dropped only when nothing failed, leaving the rest for the next launch. Cleanup never fails the config load that triggered it
- **History** — stronghold was removed (its Rust actor deadlocked on some macOS setups); an interim plaintext-SQLite scheme was then replaced by the keyring

### Navigation history (后退 / 前进)

- **Location** — `src/stores/navStore.ts`; keys dispatched from `useGlobalShortcuts`, installed once from `App`
- **A location** = `{ mainView, activeFilePath, lore detailPath }` — the three things the author moves *between*. Drawers, modals, sidebar tabs and scroll position are chrome, not places, and are deliberately not restored.
- **Recorded by observation, not interception.** The store subscribes to `appStore` / `projectStore` / `loreStore` and notices when the location changed. Every navigation path — file tree, command palette, library rows, citation clicks, "open in editor" — lands in the history without knowing the store exists, and one added later can't forget to register. The cost is a location comparison per store update, which short-circuits on the first field.
- **`applying` flag** — set while back()/forward() restores a location. zustand notifies subscribers synchronously inside `set`, so a replayed step is fully observed before the flag clears and never re-enters the stacks. `replaceLocation()` reuses the flag for `history.replaceState` semantics: same place, new address (moving a lore entry to another category renames its folder while the author is looking at it).
- **Bindings** — Mac `⌘[` / `⌘]` always, plus `⌘←` / `⌘→` outside text entry (there the caret owns them). Elsewhere `Alt+←` / `Alt+→`, which CodeMirror leaves free so it works mid-manuscript. Mouse buttons 3/4 with `preventDefault` on the press, so the webview doesn't attempt a page-history navigation of its own. Combos live in `lib/shortcuts.ts` (`NAV_BACK_COMBOS` / `NAV_FORWARD_COMBOS`) and are listed in Settings → 快捷键.
- **Boundaries** — a blocking overlay (settings, palette, onboarding) suspends both directions; opening another project clears the history, since another project's files aren't places in this one. Depth caps at 100.
- **Prerequisite** — the wall's open lore entry lives in `loreStore.detailPath` (not LoreWall local state) precisely so history can read and restore it; an unresolvable path just renders the grid, which also covers "entry deleted since you visited it".

### Export

- **Location** — `src/lib/fs/export.ts`
- **Markdown** — Copy to clipboard
- **HTML** — Self-contained file (inline CSS, no external assets)
- **PDF** — The system print dialog is the PDF engine; the path there is per-platform:
  - **Windows/Linux** — hidden iframe, render HTML, `window.print()`, remove iframe after 2s. The webview is Chromium (WebView2) / WebKitGTK, where printing a detached iframe just works, and the dialog owns the paper margins.
  - **macOS** — `window.print()` is a silent no-op (WebKit forwards JS print to the host's `WKUIDelegate`; wry implements no print callback), so the frontend calls `invoke("print_document")` instead. `src-tauri/src/print.rs` stages the HTML behind a custom `ai-writer-print://` scheme (single-use, nothing on disk), opens a print-preview window on it, and runs its own `NSPrintOperation` on the WKWebView. It does **not** use wry's `print()`/tauri's `WebviewWindow::print()`, because wry zeroes all four margins on the process-wide *shared* `NSPrintInfo` — text flush against the paper edge, and the mutated defaults leak into later print jobs. `print_with_margins` copies the shared print info and sets 0.5in margins (the print CSS zeroes the body's own padding so the two don't stack). macOS has no virtual PDF printer — the export exit is the print dialog's easily-missed "PDF ▾ → Save as PDF" menu — so the preview window carries a bottom banner (`editor.exportPdfHint`, hidden under `@media print`) pointing at it.

> Theming/design tokens live in `docs/design-system.md`.

## Important Notes

### Circular Dependencies

Two rules keep the module graph acyclic, and one build warning follows from them:

- **`src/lib/**` never imports a store statically.** The lib layer is store-free; when a lib module genuinely needs one (`agent/imageTools` → `aiStore`, `image/illustrate` → `aiStore`, `lore/citations` → `loreStore`/`appStore`) it reaches for it with `await import()`. This is also what keeps those modules unit-testable without booting the store graph.
- **Store-to-store back-edges are lazy.** `aiTaskStore` statically imports `agentStore`, so `agentStore` holds *no* static store imports and pulls `aiStore`/`projectStore`/`loreStore`/`appStore`/`editorStore`/`memoryStore` lazily inside `sendChat()`. Likewise `batchStore` statically imports `aiTaskStore`, so `aiTaskStore` can only reach `batchStore` through `await import()`.

Because those targets are also imported statically elsewhere (components), the bundler reports `INEFFECTIVE_DYNAMIC_IMPORT` for each — "this dynamic import did not move the module into its own chunk". That is expected and harmless: the goal was deferring *evaluation* to call time, which still holds within one chunk, and this app is loaded from local disk by Tauri so chunking buys nothing. `vite.config.ts` filters exactly those warnings, keyed on the target living under `src/stores/`.

**The same warning pointing at a `src/lib/**` target is a real defect** — it means someone wrote `await import()` for a module that is statically imported anyway, which buys nothing and only obscures the call site. Those are deliberately left unfiltered; convert them back to a top-level import.

### Tauri IPC Commands
- Implemented in `src-tauri/src/` (minimal; most logic in TypeScript)
- `commands.rs` — `scaffold_project`, `read_dir_recursive`, plus `fs_*` helpers (write text/binary, read text, create/read/remove dir, remove file, exists)
- `secrets.rs` — `secret_save` / `secret_load` / `secret_delete` (OS keyring)
- `transfer.rs` — export/import: `zip_export_dialog` / `zip_import_dialog` (lore + project bundles) and `save_text_file_dialog` / `open_text_file_dialog` (config backup JSON). Dialogs run Rust-side (same trust rationale as `project_open_dialog`); zip extraction is zip-slip-guarded via `enclosed_name()`. `excludes` prunes whole subtrees at the directory during the walk, matched on **whole path components** (so `.ai-writer/tmp` never swallows `.ai-writer/tmpl`). `require_manifest_kind` reads the manifest in a first pass and returns before extracting anything, which is what lets a restore into a user-picked folder promise "wrong file, nothing happened"
- `protocol.rs` — custom `ai-writer-asset://` scheme for lore images (extension allowlist)
- `print.rs` — `print_document` + custom `ai-writer-print://` scheme (macOS PDF export: preview window + native `NSPrintOperation` with real margins — see Export above; other platforms never call it)
- Plugin permissions in `src-tauri/capabilities/default.json`

### File I/O
- `src/lib/fs/fileio.ts` wraps Tauri fs plugin commands (read, write, metadata, etc.)
- All paths resolved via Tauri plugin (no raw fs access)

### Organising files (sidebar)

The workspace is the **whole project directory** — documents live wherever the author puts them, so the sidebar has to be a real file manager rather than a viewer over one blessed folder. Drag-and-drop, multi-selection and a cut/copy/paste menu are what make that true. Things that are easy to break:

- **`dragDropEnabled: false`** in `tauri.conf.json`. On Windows the webview's native OS drag-drop handler swallows HTML5 drag events, so the flag is what makes any in-app dragging work at all (the outline's chapter reordering depends on it too). Turning it back on would silently kill both. Nothing listens for Tauri's OS file-drop events, so the flag costs nothing.
- **`src/lib/fs/moveCopy.ts`** holds the pure path decisions: `dropRejection(source, targetDir, mode)` — which both lights up the drop target and decides the outcome, so the highlight can't promise something the drop refuses — and `resolveCopyTarget`, which numbers a colliding copy as `名字 (1).md` (existing ` (n)` suffixes are replaced, not stacked).
- **`src/lib/fs/selection.ts`** holds the pure selection decisions, for the same reason: `flattenVisible` (the rows actually on screen, which is what a ⇧-range must walk — a range that reached into a collapsed folder would select entries the author cannot see), `rangeBetween`, `pruneSelection` (a selection outlives the gesture that acted on it — a move rewrites every selected path — so dead paths must drop out before they widen the *next* gesture), and `pruneNested`. `isDirOpen` lives here as the one definition of the expand default (top level open, deeper closed), so the rendered tree and the flattened one cannot disagree about which rows exist.
- **`pruneNested` is not an optimisation.** Selecting a folder *and* something inside it is one shift-click away, and transferring both would move the folder first, then look for a child at a path that no longer exists. The folder carries its contents, so the descendants are redundant — dropped before any transfer or delete runs.
- **The project root has no row of its own.** `read_dir_recursive` returns the project's *children*, so the root is reachable only through the tree container itself: its empty strip (`.tree`'s 40px bottom padding) is the root drop zone, its background clears the selection, and a root-level create renders its inline input there. Rows `stopPropagation` on dragover/drop precisely so a folder row always beats the container — otherwise the root would silently claim a drag aimed at a file. (Before this, the toolbar's 新建 buttons and the root context menu set `creatingIn` to the project path and nothing rendered: the inline input only existed inside a `TreeNode`.)
- **Move vs copy.** A move is `fs_rename` via `projectStore.moveEntry`, which refuses an occupied destination and keeps the open document pointed at the moved file. A copy is the `fs_copy` Rust command (recursive for folders) via `copyEntry`; it refuses a destination that already exists and a folder copied into its own subtree — that last check is duplicated in Rust because a recursive self-copy writes until the disk fills. Hold Ctrl/Alt while dropping to copy.
- **Every transfer goes through one `transferMany`** in `FileTree.tsx`, shared by the drop gesture, the paste item and the root drop zone. It attempts *every* source and reports the failures together: one entry that cannot land (an occupied name, a folder dropped into itself) must not strand the rest of a multi-selection halfway. Entries that land become the new selection, so the next gesture acts on where they went rather than where they were.
- **`projectStore.clipboard` is a list**, and ⌘/Ctrl adds to the selection while ⇧ extends it (Ctrl is deliberately *not* the additive modifier on macOS — there it opens the context menu, and a click that both toggled the selection and raised a menu would leave the menu acting on a set the author never built). Right-clicking outside the selection retargets it to that one row, so 删除 5 项 can never appear over a row that isn't one of the five.

### `@` 引用的候选文件（与外部改动同步）

`@` 在聊天与三个设定 AI 弹窗里给出的**文件**候选，来自 `projectStore.fileTree`——即侧栏那棵树——经 `projectFilesFromTree`（`lib/fs/images`）按扩展名分类，`useProjectFiles()` 是唯一入口。

- **为什么不再各扫各的**：原先每个界面在项目打开时各调一次 `scanProjectFiles(projectPath)`，自己存一份快照。之后新增的文件（agent 写的、Finder 里拷进来的）在侧栏看得见、`@` 里选不到，屏幕上没有任何东西解释这个差异。一棵树、一条刷新路径，这类不一致就没有藏身处。
- **哪些算文本**：`md` / `markdown` / `txt` / `html` / `htm`。`.html` 是交付物不是章节（`docs/html-artifact-plan.md` D6，`isChapterFile` 不动），但**读**它没有任何理由排除——`search_text` 早就扫它（`isSearchableFile`），写这个页面的助手正是作者接着要它改页面的那个助手。图片候选另外还要模型链看得见图（`chainCanSeeImages`），否则挂上去的附件这条消息物理上带不走。
- **外部改动怎么进来**：`useExternalFileRefresh`（`src/useExternalFileRefresh.ts`）在**窗口重新获得焦点**时 `refreshFileTree()`，1.5s 内不重复。焦点正好是这件事的形状——作者去了文件管理器又回来。不上目录监听：对任意项目目录做 watch 是新的权限面，事件流最后还是要 UI 自己去抖，收益只有"应用在前台时别人改了文件"这一种边角情形。
- **不覆盖的**：知识库条目仍只在项目打开 / 写操作后扫（`loreStore.scanProject`）；外部直接往 `.ai-writer/lore/` 里塞条目仍需重开项目。

### 读 .pptx（导入转换 + 按页读）

演示文稿是 zip 里的一堆 XML，模型拿到字节等于拿到噪声，所以解析在 Rust：`src-tauri/src/pptx.rs`，前端只有 `src/lib/fs/pptx.ts` 这一跳。两个入口共用一个转换函数：

- **导入**（`pptx_to_markdown`，字节走 IPC）：`CONVERT_EXTENSIONS` 里的第四种，产物是 markdown 文件。这一步顺带把 `@` 引用、`search_text`、`read_file` 分页、RAG 全部打通——它们面对的已经是普通文本了。
- **Agent 直读**（`pptx_read_slides` → `read_slides` 工具，走**路径**+`FsScope::check`）：作者从外部拷进项目的 .pptx 不必先导入。分段在 Rust 侧按幻灯片切，整份 deck 从不跨 IPC；这也是为什么它不是"读字节再切"。

设计上要记住的几条：

- **顺序来自 `presentation.xml` 的 `<p:sldIdLst>`，不是文件名。** `slide10.xml` 排在 `slide2.xml` 前面，而且文件名本来就不权威——按目录读会静默打乱整份演示。
- **分段单位是页，不是行。** 预算（4000 字符）花完就在页边界停下，尾注写明 `slides 8-24 of 30 shown; call read_slides again with start_slide=25`——刻意和 `read_file` 的尾注同形，学会一个就会另一个。一页超预算时仍整页返回（同 `read_file` 对超长行的规则：能返回空的预算等于没有出路）。
- **只解析范围内的页。** 顺序表和 zip 条目都是按名取的，所以翻一页的成本是一页，不是整份。
- **`search_text` 不扫 .pptx**，`read_file` 遇到 .pptx 也直接改口指向 `read_slides`（否则模型会花一轮读二进制噪声，然后判定文件是空的）。全文搜索要遍历整个项目，解 zip 比读文本贵一个数量级；导入后的 markdown 本来就在搜索面里。
- **超大 deck 的最后一道防线是 subagent**：`read_slides` 在 `longread` 的工具集里，几百页丢给它，主上下文只收摘要 + note 路径。
- **`.ppt`（97-2003）读不了，也不打算读**：OLE 复合二进制，不是 zip。与 `.doc`/`.xls` 同一条判断——半乱码的结果和成功的长得一模一样。导入器不收它，`read_slides` 直接说明要先另存为 .pptx。

设计与被否掉的方案：`docs/pptx-plan.md`。

### HTML → PPTX 导出（Beta）

`.html` 是模型最擅长的排版语言，这个 app 已经能预览它、审批它、让作者改它。所以生成 pptx 这件事被拆成两半：**模型继续写 HTML，转换一步不经过模型**。整条链路是确定性代码，同一份文件每次转出来一样，没有生成的脚本需要谁去审。

```
.html → 离屏沙箱 iframe 渲染 → 量出每个盒子 → 写成 PowerPoint 形状 → .pptx
```

- **为什么不重新实现 CSS**：不需要。页面已经在 iframe 里布局完成，`getBoundingClientRect` 会精确说出每个盒子和每一行文字落在哪。flex / grid / 绝对定位用哪种都无所谓，只读最终结果。
- **怎么读到**：预览 frame 是 `blob:` + `sandbox="allow-scripts"`、**不给** `allow-same-origin`，所以 app 读不到它的 DOM——采集脚本（`lib/pptx/harvester.js`，`?raw` 注进去）在里面量，靠 `postMessage` 把结果送出来。消息认两件事：`event.source` 是这个 frame 的 `contentWindow`，且带着这一轮挂在 `data-nonce` 属性上的一次性 token。**这个 sandbox 参数不能动**：加上 `allow-same-origin` 能省掉注入，代价是把"AI 脚本进不了 app 上下文"这条保证从 sandbox 转嫁给 CSP。
- **它凭什么能跑**：`blob:` 文档**继承创建它的页面的 CSP**（opaque origin 豁免的是同源访问，不是策略），而 app 的 `script-src` 是 `'self'`——所以一期发出去的版本里这个脚本一行都没执行，每次导出都是 20 秒静默超时。现在 `tauri.conf.json` 的 `script-src` 带一个 `'sha256-'`，精确放行**这一个**脚本；页面自己带的内联脚本仍然全被拦住。两条纪律由 `pptxHarvesterCsp.test.ts` 钉住：**改 `harvester.js` 就必须同步改 conf 里的 hash**（漂了的症状还是那个静默超时），以及**每轮变化的数据只能放属性**，塞进脚本正文会让 hash 每次都不同。
- **分层**：`harvester.js` 只测量和分类（jsdom 没有布局引擎，它测不了）；`deck.ts` 是纯的——单位换算、幻灯片尺寸、颜色、剪枝、文本余量，测试都在这；`write.ts` 只调 pptxgenjs（lazy import，272KB 独立分片）。切成这样是为了让有 bug 的那层可测。
- **文字仍是文字**，PowerPoint 里能改——这是产出 .pptx 而不是 PDF 的唯一理由。所以 `pruneBlocks` 必须丢掉没有可见绘制的布局容器：不剪的话视觉上完美，打开一看图层面板三百层，等于交了份不能改的东西。
- **入口两个**，都要作者点头：`export_pptx` 工具（L2 审批卡，说明「哪个页面 → 哪个文件」；转换在 `applyProposal` 里跑，因为那里才有 DOM）和 `.html` 预览工具栏的导出按钮。
- **Beta 开关**（Settings → 通用 → 实验功能，`lib/pptx/flag.ts`）关着时 `routeTools` 把 `export_pptx` 从工具列表里**删掉**而不是让它报错——同 imagegen 未绑定时删掉画图工具。
- **会降级的**：内联 SVG 和 `<canvas>` 变图片，渐变背景变色标平均色，CSS 滤镜/混合模式/文字阴影/动画丢掉。每次导出把降级项列给作者。
- **最大的风险不是冷门 CSS，是字体和文本回流**：HTML 的换行引擎不是 PowerPoint 的，web font 也进不了 pptx。对策是按字形而不是容器测量文本框、四周留 6% 对称余量、多行允许自动缩字号，外加工具描述里要求用系统字体。

设计、被否掉的方案（让模型写 Python 转换、slides markdown、模型直接调 pptx 工具、整页截图）、以及验证时抓到的三个 bug：`docs/pptx-plan.md` §4。

### Export / Import (lore bundles & config backup)
- **Lore bundle** (`src/lib/lore/transfer.ts`, UI in `LoreWall`): a zip with root `manifest.json` + the whole on-disk `.ai-writer/lore/` tree under `lore/…` — *all* categories on disk, not just the active profile's, so bundles survive profile switches. Import is two-phase: `stageLoreImport` extracts into `.ai-writer/lore-import-tmp` and reports conflicts; `applyLoreImport` moves entity dirs in under a user-chosen strategy (skip / overwrite / keep-both via `uniqueEntityId`), then deletes the staging dir. **Overwrite displaces rather than deletes**: the entity being replaced is renamed into `.ai-writer/backups/replaced-<ts>-<category>-<id>` (the same directory `delete_lore_entity` uses), and if the move-in then fails it is renamed back. The previous `removeDir`-then-`rename` both destroyed an entry — gallery images included — with no undo, and left a window where a failed rename lost the folder from both places. Categories that fail `CATEGORY_ID_RE` are ignored.
- **Project backup** (`src/lib/fs/projectBackup.ts`, UI in Settings → 工作台): the whole project folder as one zip under `project/…` + root `manifest.json` (`kind: "ai-writer-project-bundle"`). Scope is deliberately wider than the lore bundle — `profile.json`, `outline.json`, `.ai-writer/memory/`, `imagegen.json` and each document's `assets/` are all things *the model sees*, so a project missing them behaves differently with nothing on screen saying why. `PROJECT_BACKUP_EXCLUDES` drops `.ai-writer/backups`, the scratch/staging dirs, the SQLite `-wal`/`-shm` sidecars, `.git` and `node_modules`; `project.db` is WAL-checkpointed first (`PRAGMA wal_checkpoint(TRUNCATE)` via `select`, best-effort) so the single archived file is complete. Restore takes an **empty** folder picked through `project_open_dialog` (which is also what allows it as an fs root), and `zip_import_dialog` is given `requireManifestKind` so a wrong zip is refused before a single file is written. Not included: `config.db` and the keyring — those belong to the installation, and the UI says so.
- **Config backup** (`src/lib/ai/configTransfer.ts`, UI in Settings → General): providers/models/prompts **plus the portable preferences** (see Preferences) as one JSON file — the `prefs` field is optional, so a backup written before they were included still restores. API keys (OS keyring) are **excluded unless the user opts in** — then embedded in plaintext and re-saved to the keyring on import. Restore merges by id (`INSERT OR REPLACE`); models whose provider is neither in the backup nor already configured are dropped during validation. The row writes go through `sqlTransaction` (see Transactions below), providers before the models that reference them; preferences and keyring writes land after the commit, because neither can join a SQL transaction and a failure in them must not undo the configuration that already succeeded.

### Transactions (`src/lib/sqlTx.ts` + `src-tauri/src/sqltx.rs`)

`@tauri-apps/plugin-sql` looks like a connection but is a **pool**: each
`db.execute()` borrows whichever connection is free, and sqlx returns it from a
spawned task *after* the call resolves, so the next statement often opens a
second connection instead of reusing the first. `execute("BEGIN")` … the writes
… `execute("COMMIT")` therefore is not one transaction. The BEGIN opens a
transaction on connection A; the writes land on A or B by luck; and the moment
one lands inside A's still-open transaction, A holds SQLite's write lock while
the next statement on B waits out the busy timeout and fails with
`error returned from database: (code: 5) database is locked`. Worse, sqlx's
on-release check is a ping and not a rollback, so A goes back into the pool
mid-transaction and keeps that lock until the app restarts — the config restore
hit exactly this, and a failed attempt could poison later config writes too.

`sqlTransaction(dbPath, statements)` hands the batch to the `sqlite_transaction`
Rust command, which opens a **private** connection, runs `BEGIN IMMEDIATE` (so a
busy database fails before any of the batch applies rather than half way
through), and closes it after. `dbPath` goes through the same `FsScope` as the
`fs_*` commands, so it can only be one of this app's own databases. **Never
write a bare `BEGIN` through a `Database` handle** — `configImportTx.test.ts`
asserts the config restore issues no transaction control statement through the
pooled handle, and `sqltx.rs`'s own tests cover the commit/rollback behaviour.

### CodeMirror 6 Setup
- Extensions: GFM, Markdown language, history, search, Vim bindings optional
- Line wrapping enabled via `EditorView.lineNumbers` extension
- Theme: One Dark (dark mode); light mode via CSS override

### Capabilities & Permissions
- `src-tauri/capabilities/default.json` — Explicit permissions for all Tauri plugins
- Must include: `sql:*`, `dialog:*`, and read-only `fs` permissions (key storage uses custom `secret_*` commands, no plugin permission needed)
- The fs plugin is granted **read-only** (`read-file`, `read-dir`) — all writes/deletes go through the audited custom `fs_*` Rust commands.
- **Two path scopes exist, and they do not agree.** Projects can live anywhere on disk, so neither can be a static allowlist:
  - `src-tauri/src/scope.rs` (`FsScope`) guards every custom `fs_*` command. Roots are registered only from trusted sources (the Rust-side folder picker, or a recents entry with an on-disk `.ai-writer` marker). Containment is component-wise with `..` and symlinks resolved — no special case for dot-directories.
  - `tauri-plugin-fs`'s own scope guards the handful of **binary image reads** the frontend does directly (`src/lib/fs/images.ts`, `LoreDetail`/`LoreWall`, `lib/import`). `allow_for_plugin_fs` extends it to a registered root; dialog-picked files are auto-scoped by the dialog plugin for that session.
- **The plugin's scope is glob-based, and on unix a wildcard will not match a leading dot.** Its runtime scope is built from `FsScope::default()`, which means `require_literal_leading_dot: true` — so `<root>/**` covers `<root>/writing/…` but *not* `<root>/.ai-writer/…`, and the `requireLiteralLeadingDot` config knob cannot reach it (that value only feeds the per-call scope built from static capability entries). Since every generated picture lives under `.ai-writer/`, `allow_for_plugin_fs` grants `<root>/.ai-writer` a second time with the dot spelled out. Symptom when this is missing: `forbidden path: …` on image reads while documents load fine — see `docs/image-generation-plan.md` §8. Adding another dot-directory the frontend must read means adding another grant; the durable fix is routing project-internal binary reads through the custom `fs_*` commands too.

### Window chrome（自定义标题栏，方案 B 混合）

The app draws its own titlebar (`TitleBar.tsx`) and the OS chrome is handled per platform:

- **macOS** — native traffic lights are kept, floating over our bar: `titleBarStyle: "Overlay"` + `hiddenTitle: true` in `tauri.conf.json`. The bar reserves a blank strip for them (`.macInset`, ~56px + bar padding), collapsed in fullscreen (the system hides the buttons there). Rounded corners / shadow / fullscreen animation / stage-manager behaviors all stay native. Traffic-light vertical centering in the 48px bar is the OS default (slightly high); if it ever needs pixel-perfect insetting, that's `tauri-plugin-decorum`'s `setTrafficLightsInset` — deliberately not pulled in yet.
- **Windows** — `decorations: false` in **`tauri.windows.conf.json`**, and `TitleBar` renders its own caption buttons (minimize / maximize-restore / close, Segoe-style strokes, close hovers `#e81123`). Known trade-off: Win11 Snap Layouts on hover are lost (same decorum plugin would restore them). Edge resize + shadow are handled by Tauri for undecorated windows.
- **Linux / plain browser** — base config keeps `decorations` on, so `useWindowControls` sees a decorated window and renders no buttons; outside Tauri entirely (plain `pnpm dev`), the bar falls back to the decorative 设计稿 dots.

Wiring lives in `src/components/layout/useWindowControls.ts` (state + actions; `close()` goes through `window.close()` so `useWindowCloseFlush`'s autosave flush still runs). Dragging is `data-tauri-drag-region` on the bar, crumb and spacer — the attribute only works on the element it sits on directly, so child buttons stay clickable; double-click on a drag region toggles maximize (built into Tauri's injected handler).

Two maintenance caveats:

- **Platform config merge is JSON Merge Patch (RFC 7396): arrays are replaced whole.** `tauri.windows.conf.json` therefore repeats the *entire* window object, not just `decorations` — keep it in sync with the window in `tauri.conf.json` when editing either.
- The window permissions behind all this are explicit in `capabilities/default.json`: `start-dragging`, `internal-toggle-maximize` (double-click), `minimize`, `toggle-maximize`, `close`, and the `is-maximized` / `is-fullscreen` / `is-decorated` getters.

### Content Security Policy
- Production CSP is set in `tauri.conf.json` (`app.security.csp`); `devCsp` is `null` so Vite HMR keeps working in dev
- `connect-src` allows `https:`/`http:` because users configure arbitrary AI endpoints (incl. local LLMs like Ollama); `script-src` is locked to `'self'`
- `img-src` includes the `ai-writer-asset:` custom scheme (and its `http://ai-writer-asset.localhost` Windows form) for lore images
- If a new subsystem breaks under CSP (e.g. a library injecting inline `<script>`), extend the directive minimally — don't set `csp` back to `null`
- `dangerousDisableAssetCspModification: ["style-src"]` is **load-bearing — do not remove.** At build time Tauri stamps a nonce onto every inline `<style>` in `index.html` (we have one: the boot splash) and appends `'nonce-…'` to `style-src` at runtime. Per CSP2+, a nonce in a directive makes `'unsafe-inline'` **ignored**, so every `<style>` injected later by JS gets blocked — CodeMirror's base theme (style-mod injects a plain `<style>`, losing `.cm-scroller { height: 100% }` → the editor renders but cannot scroll), plus KaTeX/mermaid inline `style="…"` attributes. Only ever visible in `tauri build`, never in `tauri dev`, since `devCsp` is `null`. The flag just tells Tauri to leave `style-src` alone; we already declare `'unsafe-inline'` ourselves, so the effective policy is unchanged.

## Performance Considerations

- **Editor debouncing** — `editorStore` uses `setTimeout` to auto-save on content change (not on every keystroke)
- **Lore scanning** — Full `lore/` tree walk per `loreStore.scanProject()`; triggered on project open, on a profile switch, after every in-app lore mutation, after every agent lore write, and on entering the lore wall. Scans are **serialized and coalesced** (see → The run's lore snapshot), so a burst costs one extra walk rather than one each
- **RAG caching** — Entity summaries cached in `loreStore.index` after first scan
- **Context assembly** — 4-layer context capped at ~4000 tokens total to keep request size reasonable
