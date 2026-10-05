# Architecture & Implementation Notes

> **Status: `living`.** When it disagrees with the code, the doc is the bug.
> Deep-dive reference. Read the relevant subsection before working in that subsystem.

## Key Implementation Details

### Database Schema (SQLite)

Each table is created (and later columns added with `PRAGMA table_info` →
`ALTER TABLE … ADD COLUMN`) by the module that owns it: `src/lib/project.ts`
(`project.db`), `src/lib/ai/configDb.ts` (`providers` / `models` / `prompts`),
`src/lib/ai/usageSchema.ts` (`token_usage`, both databases),
`src/lib/ai/feeGroupDb.ts`, `src/lib/ai/learnedDb.ts`, `src/lib/prefs.ts` and
`src/lib/docx/presets.ts`:

```
project.db   token_usage (id, model_id, task, prompt_tokens, cached_tokens, completion_tokens,
                          cost_usd, created_at, + 计费快照与分项 22 列 — lib/ai/usageSchema.ts)
project.db   chat_sessions (id, preview, data, pinned, title, stash_id, created_at, updated_at)
                          -- 对话助手会话，每条一个 JSON blob（lib/agent/sessionDb）
project.db   output_recovery (id, data, updated_at) -- 长输出正文检查点（lib/agent/outputRecovery）
config.db    token_usage 同上 + project          -- 总账：比任何一个项目活得久
config.db    fee_groups  (id, name, vendor, billing_mode, input_price, cache_input_price,
                          output_price, request_price, output_unit, output_rates,
                          input_unit_price, input_free_units, sort_order, created_at)
config.db    providers   (id, name, base_url, api_standard, safety_settings, auth_mode,
                          sort_order, platform, host, endpoints, default_fee_group_id,
                          upstream_prefixes, created_at)
config.db    models      (id, provider_id, model_id, name, type, enabled, prefix,
                          -- 容量：context_size, max_output, probed_at, probed_context_size,
                          --       probed_max_output, caps
                          -- 请求参数：temperature, reasoning_effort, thinking_category,
                          --       thinking_budget, text_verbosity, structured_output,
                          --       server_tools, pdf_input, vl_high_resolution,
                          --       video_input, video_fps
                          -- 专用格式：translate_format, asr_format
                          -- 线路：active_route, routes, relay_upstream
                          -- 计费：fee_group_id, fee_migrated
                          -- 旧列，只剩迁移在读：price_in / price_cached_in / price_out /
                          --       price_per_image / price_per_second, thinking_dialect)
config.db    prompts     (id, name, content, scene, grp, use_count, last_used_at)
config.db    learned_ceilings (standard, base_url, model_id, fact, ceiling, rank, learned_at)
                          -- 端点学到的降级；不是作者的配置，备份与同步都不带
config.db    doc_format  (id, label, format, imitated_from, created_at)   -- docx 格式预设
config.db    prefs       (key, value)          -- see Preferences below
```

Two databases, and the split is what each thing *belongs to*: `project.db`
travels with the project folder, `config.db` (in `appDataDir`) belongs to the
installation. That is also the line the two backup features draw — see
Export / Import below.

`token_usage` 存在**两个库里**，结构共用一处定义（`lib/ai/usageSchema.ts`）：
项目那份跟着项目文件夹走，`config.db` 那份多一列 `project`、比任何一个项目
活得久。一次请求两处各记一行（`lib/ai/usageRow.recordUsage`，唯一写入口）。
行上除了计数还快照了**当时的价**——模式、三个 token 单价、按次价、按规格的
数量 / 单价 / 单位 / 规格三元组 / 命中与否、输入图的发出张数 / 计费张数 /
单价，以及可空的上游报价。所以改组、删组、换组都动不了历史。
`cost_usd` 是 `feeGroup.costOf()` 在记账那一刻的结果落了盘，读那一侧 `SUM`
它——不是第二套口径，也因此不需要检查点。价格本身在 `fee_groups`，见
`docs/feature/billing/01-fee-groups.md`。

`model_id` holds the configured model's internal id; rows written by image runs
before that was corrected hold the provider's own model string instead, so
`lib/ai/usage.ts` matches both when naming a model.

**Removed:** `settings` and `lore_entities` were created on every project open
and never read or written by anything — `lore_entities` (note
`embedding_status`) was the remains of a SQLite-indexed knowledge base the app
no longer has; the tree under `.ai-writer/lore/` is the source of truth and
`loreStore` rescans it on open. `initSchema` now drops both
(`DEAD_PROJECT_TABLES`), best-effort, so a failed cleanup can't stop a project
opening.

### Usage accounting (Settings → 用量)

`src/lib/ai/usage.ts` is the read side of `token_usage`: pick a ledger (`project` = the project DB, `global` = `config.db`), then roll up by model / task / billing mode / project over a time window. Every usage row carries its own price snapshot and `cost_usd`, so the read side only ever `SUM`s. The module split, the invariants and their reasons (totals, NULL coercion, sort order, the by-fee-group fold) live in [`docs/feature/billing/01-fee-groups.md`](../feature/billing/01-fee-groups.md) → 模块.

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

### Multi-instance (多开 — `src/lib/instance.ts` + `src-tauri/src/instance.rs`)

The app runs as **several processes, each on its own workspace** (VS
Code-style) — there is deliberately no single-instance plugin, and "new
window" means a new *process*.

The reason is `FsScope`. It is `app.manage()`d state, i.e. **process-wide**
(`lib.rs`), and it is the entire guard on the custom `fs_*` commands: two
workspaces inside one process would share one union of allowed roots, so
window A's webview could read and write window B's project. (The reason
recorded here previously — that the Zustand stores and `lib/profile/active`
are module singletons sized to one project — does **not** hold: each
`WebviewWindow` runs its own page in its own JS realm, so those singletons are
per-webview, not per-process. `FsScope` is the constraint that actually binds,
along with everything else keyed on the PID: the workspace lock, the focus
channel, the launch argument, the exit sweep.)

What multi-open actually needs is five small pieces; everything project-scoped
(`project.db`, the lore tree, the editor) was per-process already.

- **The workspace lock** — `.ai-writer/window.lock` (`{pid, since, port}`),
  an *advisory* guard against the one dangerous case: two windows opening the
  **same** folder, i.e. two autosaving editors over one set of files.
  `projectStore.openProject` claims it after root registration (the commands
  are `FsScope`-checked). A live *other* holder resolves the VS Code way
  first: `port` is the holder's loopback **focus channel** (a TCP listener
  where *connecting is the whole message* — nothing read, nothing granted
  beyond "raise your window", which any local process has via OS APIs
  anyway), so `project_focus_existing` brings the existing window forward and
  the second open backs out (`openProject` returns `"focused-existing"`; the
  launch-argument path in App.tsx then closes its fresh window, like
  `code <folder>` handing off). Only an unreachable holder — a crashed
  instance's recycled PID, a pre-channel lock, a foreign machine's lock on a
  network share — falls back to the 「仍要打开吗」dialog; never a hard block.
  Staleness is PID liveness (one syscall at open time), not heartbeats — a
  crash leaves a lock that reads as free. Release happens on project
  switch/close and, for everything the frontend can't reach
  (`window.destroy()`, kill), in the `RunEvent::Exit` sweep in `lib.rs`.
  Every lock failure counts as acquired: the guard is a courtesy, the
  project opening is the point.
- **The shared preference cache** — all instances share `config.db`, and
  after hydration each treats its in-memory `Map` as truth. Two repairs:
  `refreshPrefs()` re-reads the table on window focus (`usePrefsFocusSync`,
  mirroring the file tree's focus refresh) and repaints via
  `reloadFromPrefs()` only when something changed; and the recent-projects
  row — the one *list* every instance rewrites whole — persists through
  `writePrefMerged`, a read-merge-write on the ordinary write chain with the
  union logic in `lib/recentProjects.ts` (ours-first, capped; a raced
  *removal* can resurface from the other side's copy, which is why the
  remove/clear paths stay plain overwrites). Providers/models/prompts
  (`configDb` tables, loaded once by `aiStore.loadConfig`) still need a
  restart to appear in a sibling — a known, accepted gap.
- **The launch argument** — `simple-ai-writer <folder>` opens that workspace
  at startup: parsed in `instance.rs` under the same trust rule as
  `project_register_root` (absolute + on-disk `.ai-writer` marker, so argv
  can't aim the fs scope at an arbitrary directory), consumed exactly once
  (`take()` — StrictMode's doubled effect run gets `null`), and fed through
  the normal `openProject(path)` flow in `App.tsx`.
- **Spawning a sibling** — `spawn_new_instance` runs `current_exe()` again,
  optionally with that argument. Two affordances: the file tree toolbar's
  新窗口 button (blank on purpose — handing it the current project would just
  bounce off the focus handoff back to this window) and 在新窗口打开 on each
  recents entry in the sidebar's empty state. macOS Dock/Finder still
  focuses the running instance (`open -n` from a shell works); the in-app
  buttons are the supported path there.
- **The window menu** (macOS) — see below. Separate processes are exactly why
  the native one cannot work, so the app builds its own.

#### The 「Window」 menu (macOS — `src-tauri/src/windowmenu.rs`)

macOS fills the Window menu from `NSApp.windowsMenu`, which AppKit populates
from *that process's* `NSApp.windows`. Tauri already hands its default Window
submenu to AppKit (`tauri::app::init_app_menu` calls
`set_as_windows_menu_for_nsapp`), so the native mechanism is wired up and
simply has one window to list — every sibling is a separate application as far
as LaunchServices is concerned (two `type="Foreground"` ASNs under one bundle
id, confirmed with `lsappinfo`). The list the author wants exists nowhere in
AppKit's reach, so the app builds it:

- **A registry of live instances** — `<app data>/instances/<pid>.json`, one per
  process: `{pid, port, since, title, workspace}`. Written at startup and
  rewritten whenever the window is renamed; removed in the `RunEvent::Exit`
  sweep beside the locks. Staleness is the same PID probe the workspace lock
  uses, run when the list is read; a dead instance's file is deleted on sight,
  and a file too corrupt to parse is judged by the pid in its *name* (the only
  way garbage can ever leave, since the content that would name its owner is
  what is unreadable).
- **A Window submenu the app owns** — with **its own id**, deliberately not
  Tauri's `WINDOW_SUBMENU_ID`. Keeping that id would make AppKit append its own
  list (this process's single window) after whatever we add, and there is no
  API to take `windowsMenu` back. Owning the whole submenu means every instance
  renders the **same list in the same order** (launch time, then pid) with the
  current window checked, rather than each showing itself in a different place.
  Nothing is lost: `windowsMenu`'s whole value is the automatic list, which is
  precisely what cannot work here. Installing it means owning the rest of the
  default menu too (app / File / Edit / View / Help), which `windowmenu::build`
  reproduces from Tauri's `Menu::default`.
- **Switching** — a menu item connects to the target's focus-channel port. That
  is the channel `instance.rs` already opens, where *connecting is the whole
  message*; no new protocol, and nothing granted that a local process did not
  already have. A connection that fails means the entry was stale, and the
  failure rebuilds the menu without it.
- **Refreshing on focus is exact, not approximate** — a sibling cannot push "I
  opened" to us without widening the focus channel past its one invariant. It
  does not need to: **the menu bar belongs to the frontmost app**, so the
  author must focus this window before its menu can be opened at all, and that
  is where the rebuild happens. The window that spawned a sibling and the
  window whose sibling just quit both regain focus on the way to their own
  menu bar. Same argument as `usePrefsFocusSync`, but here it is a bound
  rather than a heuristic.
- **Naming the window** — `set_window_title` (one frontend call site,
  `useWindowTitle`) sets the OS title *and* updates the registry, because they
  are the same fact. Without it every entry would read "Simple AI Writer": the
  app had never called `set_title` at all. The label is the **project**, not
  the open file — a window *is* its workspace here, and following the file
  would re-announce on every tab switch to say something the title bar already
  shows.

Two things it deliberately does not do. **⌘\`** (cycle windows) stays
per-process: it is an AppKit behaviour over `NSApp.windows`, and the entries
carry no accelerators, so nothing is taken from the webview's own shortcuts.
And the menu is **macOS-only** — on Windows/Linux Tauri installs no menu at
all, and drawing a menu bar inside this app's custom titlebar would be a
regression, not a feature. The menu's own wording stays English (Tauri's
default already was); only the window entries are author-facing text.

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

- **Location** — `src/lib/ai/drafts.ts` (the `Draft` shape, `MAX_DRAFTS`, `totalUsage`, `draftCountFor`), fan-out in `aiTaskStore.runTask`, UI in `AiPanel`
- **Setting** — `appStore.draftCount` (1–5, persisted), chosen per run in the panel

A run produces a **list** of drafts, not one string: `drafts: Draft[]` + `activeDraftId`, where an ordinary task is simply a run with one draft. Modelling the single case as a degenerate multi-draft run — rather than as a separate field — is what stops the two paths drifting.

Asking for N assembles the context **once** and then fires N independent `streamCompletion` calls sharing one `AbortController`. The drafts differ only by the model's own sampling, which is the point: N takes on the same brief. Consequences worth knowing:

- `Promise.allSettled`, not `all` — one draft being refused or filtered records an error **on that draft** and leaves the others' text alone. The run only fails if every draft did.
- One `token_usage` row **per draft**, since each is a separately billed call; the panel footer shows `totalUsage(drafts)`.
- Drafts are patched **by id, not index**: N streams land out of order and a run can be replaced mid-flight, so an index could write into the next run's array. A stale id is a no-op, which is the right outcome.
- Ids carry a monotonic run counter, so React can't mistake a new run's first draft for the previous one re-rendering.

**`draftCountFor` pins every tool-using task (`tools !== "none"`) to a single draft, and neither limit is cosmetic:**

| Tier | Why |
| --- | --- |
| any but `none` (`read` / `write` / `full`) | The run goes through the agent loop, and every round reports into one shared `agentLog`. N interleaved tool logs are unreadable. |
| `full` | Additionally holds the L1 write tools and `propose_edit`. N runs would write to one lore folder concurrently and race N approval cards against one resolver — a correctness limit. |

`MAX_DRAFTS`, the draft types and `draftCountFor` live in `lib/ai/drafts` rather than in either store because both ends need them — `appStore` owns the setting, `aiTaskStore` owns the run — and importing across would close a cycle. It also keeps the pure parts testable without a store that touches `localStorage`/`document` at module load.

### Capability packs (能力包)

The pack model — profile.json versions, the multi-pack merge, orphan categories, the task fields, the document model and the singleton's rules — is documented per directory in [`codemap.md` → 能力包](codemap.md#能力包workspace-packs).

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

Two things keep it from being invisible. `AutoApproveChip` sits in the chip row for as long as a grant is live and revokes it on click; and `ApprovalDecision.auto` rides back into the tool result (`reportDecision`, `lib/agent/write/manuscript.ts`) so the model is told plainly that nobody reviewed that change. Note the plan grant skips the *card*, not the *gate* — the model still has to declare its steps, and `checkPlan` still refuses any lore write they don't cover.

### The run's lore snapshot

`ToolContext.loreIndex` is a **snapshot**, captured once when `runAgent` starts and shared by reference across every tool call in the run (the loop spreads the same context per call rather than rebuilding it). That is deliberate — resolving entities against a moving index mid-run would make a plan's steps mean different things at different rounds — but it has a sharp edge: a write that changes *what entities exist* is invisible to the rest of the run unless someone puts it there.

For a long time only some writes did. `move`/`delete` patched the snapshot by hand (`relocateInSnapshot`), `create` did not — so the model would create an entity, immediately try to write its body, and be told `entity "X" not found`, while the create's own result text said the index had been refreshed. It generally concluded it had the name wrong and created the entity a second time.

Three rules now hold it together:

- **`onLoreChanged` returns the fresh index**, and `syncLore` (`lib/agent/write/planGate.ts`) pours it *into* `ctx.loreIndex` — in place, because reassigning would only fix the current call's view. Every write tool calls it **last**, and nothing may touch disk through an entity resolved before it: those objects are detached once it returns.
- **`runAgent` clones the index it is given** (`cloneLoreIndex`). What callers hand over is the live `loreStore` state object, and the snapshot patches splice its arrays — mutating it would edit store state behind zustand's back, on arrays React is rendering from. Cloning at the one funnel every surface passes through means a caller added later cannot forget it.
- **`syncLore` never throws.** `executeRegisteredTool` turns a throw into an `"Error: …"` result, so a rescan failing *after* a successful write would report the write as failed — and the model would redo it. The hand-written snapshot patches stay as the fallback, which is also what keeps surfaces with no rescan at all (`lore/generator`, `lore/splitter`, both passing `loreIndex: {}`) working.

Because the tools now *await* the rescan, `loreStore.scanProject` has to be worth awaiting. It serializes: scans used to run fire-and-parallel, and whichever *resolved* last installed its index — not the one that started last, which is where the intermittent "the index didn't update" came from. A caller arriving while a scan is merely **queued** shares it (that scan will read disk strictly after their write, so it is fresh enough), which is what keeps a burst of writes to one extra walk instead of one each. That guarantee holds only because the queued scan has genuinely not called `scanLore` yet — anything that pre-starts it breaks it silently.

Most writes do not need the walk at all. A body edit, a facet, a gallery picture — anything that stayed inside one entity's folder — passes that entity to `syncLore`, which hands its address (`LoreEntityAddress`) to `onLoreChanged`, and the surfaces answer with `loreStore.refreshEntity`: one `scanEntity` of that folder, swapped into the index in place. It sits in the **same queue** as the full scans, so the freshness guarantee above is unchanged; a queued-but-unstarted full scan is shared exactly as before; and it falls back to the walk whenever patching could be wrong — the index belongs to another project, or the entity is not where the run's snapshot says. Only create / move / delete and pack runs still call `syncLore` without an entity, because those change what exists.

**Whoever rewrites a whole `index.md` reads `collections` and `cover` from disk, never from the run snapshot.** There are three such writers — `update_lore_meta`, `update_lore_file` and `move_lore_entity` — and `saveEntityMetaAndBody` defaults both fields from the `LoreEntity` it is handed, which for an agent run is the snapshot cloned at run start. A filing made since that clone (by `file_lore_entries` earlier in the same run, or by the author in the panel while the run was in flight) is therefore invisible to it, and the next whole-frontmatter write puts the old value back with no error and no card. That is how seven entries silently left a collection. `update_lore_meta` and `move_lore_entity` read both fields off the same `parseFrontmatter` they already do for the body; `update_lore_file` cannot (its content comes from the model) so it **refuses** a write that would change either, the way it already refuses a changed `dict`, and its refusal names the plan step that loads `file_lore_entries`.

A **filing** call changes N entries at once and none of them move, so the hint is a *list* of addresses and the surfaces answer with `loreStore.refreshEntities`: the folders are read one at a time and installed in a single `set`, so no half-refreshed index is ever rendered. `manage_collection`'s rename and delete, and `file_lore_entries`, all take that path — the collection's name **is** its id, so both rewrite the member entries' frontmatter, and `refileCollection` / `fileEntities` hand back exactly whose. Those three tools resync the run snapshot for a reason beyond speed: `saveEntityMetaAndBody` defaults `collections` from the entity object it is handed, so a stale snapshot means the next `update_lore_meta` in the same run writes the *old* filing back over the new one. `manage_category` alone does not resync — creating a category makes an empty one, renaming and deleting touch no entry at all, and `setCustomCategories` has already walked the store. The UI's own in-place mutations (`LoreDetail`'s pictures, cover, facet delete; the wall's avatar pick) and the approved-illustration apply in `agentStore` use `refreshEntity` the same way, and `proposeIllustration` resyncs the run snapshot afterwards so the model can find the picture it was just told about. The picture grids follow the same rule one level up: `useImageThumbnails` / `useImageDataUrls` read only the paths they do not hold yet (`planImageReads`) — before that, one new gallery picture re-read and re-encoded the whole gallery. The walk itself also got cheaper: `scanEntity` answers every "is this file here?" (avatar, `images.md`, each picture) from the one directory listing it already has, instead of an IPC probe per file — each of which canonicalized the path on the Rust side, twice when absent.

A preset carrying lore *write* tools must supply `onLoreChanged`; it stays optional on `ToolContext` only because the read-only presets legitimately have nothing to write.

### 当前时间 (`lib/context/clock.ts`)

模型自己没有钟。system 提示是一段静态身份，briefing 是一张静态规则表，工具表里也没有一个「现在几点」——所以在这条线接上之前，助手答「今天几号」靠的是训练截止日，周报包的「上一期」按日期找文件时找的是去年。修法是**一行字，不是一个工具**：工具的 schema 每次请求都要发、模型还得决定调不调，而一行 `当前时间：2026-09-04 星期五 14:32（时区 Asia/Shanghai）` 只有 25 个 token、零轮次。时间按作者本机时区给（不是 UTC——作者写「今晚八点」写的是自己的时区，给 UTC 模型会反过来纠正作者），星期跟界面语言，数字强制拉丁。

**这行字放在哪里由缓存决定，不由整洁决定。** Prompt cache 是前缀缓存（OpenAI 的自动缓存、Anthropic 的 block 断点都是）：命中的是和上一次请求完全相同的最长前缀。

- **单次运行**（AiPanel 任务、批量、子代理、`run_pack` 子运行、写手交接）的 system 层每次运行只建一次，时间就挂在它**末尾**（`withCurrentTime`）：前面的静态文本照样命中，一个工具循环里的各轮共享同一个时间戳，后面没有任何东西依赖它。
- **多轮对话**正相反。它的历史跨发送持续存在，第 N 轮的整份历史就是第 N+1 轮的缓存前缀；时间戳若放在 system 消息里，每次发送都变，等于为了 25 个 token 把它后面的全部——每一轮、每条工具结果、每张图——全部作废。所以聊天把时间戳打在**当前这一轮的用户消息**上（`currentTimeLine` 经 `withDirective`，和计划模式指令走同一条缝）：它接在最新一条消息后面、落在缓存前缀之外，而历史里每一轮都留着自己的发送时间——作者第二天早上接着聊时，模型本来就该看到这些。

**刻意不打时间戳的**：角色扮演（人物活在故事的时间里，作者的挂钟正是那种会漏进正文的事实；旁白要真实时间戳时读的是 transcript 自带的那份）、一致性检查（对照的是知识库，日期不是它核的事实）、各种归纳器（压缩、文库摘要、故事记忆——把「今天」编进摘要是错的）、结构化一次性提取，以及 Sakura（它的 system 是训练时固定的模板）。`src/lib/context/__tests__/currentTime.test.ts` 的源码扫描把这两张名单钉死：任何新建 `role: "system"` 消息的文件都必须进 REQUIRED 或带着理由进 EXEMPT。

### Images in context (谁能看图，看多久)

A picture reaches a model exactly one way: an `image_url` part on a `role: "user"` message (`ContentPart`, `lib/ai/types.ts`). Everything below is about who is allowed to create one and what happens to it afterwards.

**Three entry points**, all gated on `canSeeImages(model)` (type `multimodal` or `vision` — `lib/ai/capability/media`, re-exported by `lib/ai/configDb`) — a *declaration on the model row* in 设置 → 渠道与模型, not a guess from the model name. A text-only model is told the picture could not travel rather than silently losing it:

| Entry | Who chooses the picture | Scope |
| --- | --- | --- |
| `read_lore_image` tool | the model | one entity's avatar / gallery image, by name + filename |
| `read_image` tool | the model | any image file **inside the project** — document illustrations in a sibling `assets/`, reference art anywhere else |
| chat `@`-mention | the author | any image `scanProjectFiles` found; inlined by `lib/agent/chatRefs`, ≤ `MAX_MESSAGE_IMAGES` per message |
| chat paste (⌘V) | the author | a picture from the clipboard, written to the session's scratch area `.ai-writer/tmp/chat/<stashId>/` first and then attached exactly like an `@` one — the same `MAX_MESSAGE_IMAGES`, shared ([`chat-image-paste-plan.md`](../feature/agent/chat-image-paste-plan.md)) |

Those gates hold at *attach* time. The history outlives the model, so every request asks again: `streamCompletion` projects the messages through the plan's media admission (`RequestPlan.media`, `lib/ai/capability/media.ts`; `admitMedia` in `lib/ai/mediaParts.ts`) — a picture the model now answering does not read goes out as a one-line note and stays in the history, so switching back sends it again (`docs/feature/video-input.md` §4).

The model only *knows* a lore picture exists because the injected 【知识库】 block says so — `selectLore` writes one bounded 配图 line per matched entity (filenames + descriptions, never pixels). See RAG → 配图在注入里 below.

`read_image` is contained against the *whole project*, where `read_file` (and the other text tools) additionally exclude `.ai-writer/` (`isWorkspacePath` in `lib/paths.ts`). The text tools are narrower because a prompt-injected model could read `profile.json` or the lore back to whoever planted the instruction; an image tool decodes one file, by extension, into pixels — and lore gallery images live under `.ai-writer/lore/`, where it must still reach. Both refuse outright when there is no project path — every absolute path is "inside" an empty prefix.

Every model-supplied path goes through `resolveWorkspacePath` (same file) first, which rebases a **project-relative** one on the project root before the containment check. Not a convenience: the prompt's 【当前文件】 block carries a relative path (`stores/agentStore`, `stores/aiTaskStore`), so a relative path is the shape the model naturally answers in — and the absolute-only tools used to refuse it as "outside the project folder" for a file plainly inside it. `..` still cannot climb out, because containment is applied *after* resolution.

**Every one of them goes through one reader.** `lib/image/normalize.imageForModel` is the only way bytes become an `image_url` part: it reads the file's header (`imageSize.ts` — PNG/JPEG/GIF/WebP are fixed-layout, so the common "already small enough" case costs no decode at all), and re-encodes anything past the author's long-edge ceiling (`app:imageMaxLongEdge`, default 4096, 设置 → AI 配置 → 上下文与记忆) or the 12MB `MAX_IMAGE_BYTES` cap — and past `MAX_IMAGE_EDGE` (8192) even when the author switched the ceiling off, because that one is an endpoint's refusal (DeepSeek), not a preference. The ladder — quality before pixels, scaling only when there is no quality left, animated pictures never touched — is pure and lives in `downscalePlan.ts`. What the size cap means changed with it: it used to *refuse* an oversized attachment ("pick another one", which is not something an author can do), and now it is the target a shrink aims at, with the refusal kept as the fallback for a picture that survives four attempts. The ladder has a floor too: a picture with a side under `MIN_IMAGE_EDGE` (10px) is *enlarged*, aspect kept, because DashScope's qwen3-vl-plus 400s a 9×9 image outright (`docs/api/landscape.md`, 第六个样本). Where the floor and the long-edge ceiling can't both hold (a 2×1000 sliver against a 256 ceiling), the floor wins and the long edge overshoots — the ceiling is a token preference, the floor an endpoint refusal, and squashing the aspect would hand the model a distorted picture. An enlargement carries no `downscaled` note ([`image-normalize-plan.md`](../feature/image-normalize-plan.md) §2.8).

Which reader a call site wants is decided by **where the bytes end up**, not by what the file is: `imageForModel` for the wire, `imageToDataUrl` for anything a human looks at (previews, gallery tiles, exported HTML), `readImageBytes` for anything written to disk (an entity avatar, a kept generation). Both wrong answers are silent — a downscaled preview, or an avatar permanently re-encoded on its way into the project — which is why they are three functions rather than one with a flag. Design: [`image-normalize-plan.md`](../feature/image-normalize-plan.md).

The pixels are half the trade; the other half is how much of them the *endpoint* agrees to look at. `image_url.detail` is an optional hint OpenAI and DeepSeek both accept — `low` has the endpoint scale to 512x512 first (cheaper and faster, and the first casualties are a screenshot's small text and a table's digits), `high` keeps full resolution. It is the author's call, in the same 设置 → AI 配置 → 上下文与记忆 section as the long edge, and **its default is to send no field at all** — absence is what both vendors call `auto`, so an author who never opens that page produces exactly the request they produced before the setting existed, on every endpoint including the ones that never heard of `detail`. One builder applies it (`lib/ai/imagePart.imagePart`), because eight call sites construct image parts and seven honouring the preference would be invisible in review. Anthropic and Gemini have no spelling for it and drop it in their own adapters; the Responses family carries it *beside* `image_url` rather than inside it.

**Nothing keeps a picture for long.** Base64 is megabytes, and a chat history persists for the whole session, so four separate passes take pixels back out — all through `lib/agent/imageHistory`'s message predicates over the one part rule, `withoutParts` in `lib/ai/mediaParts` (which the request's send-time projection uses too), and all of which **keep the message's text**: the author's attachment rides on their question, which is a turn boundary `compact.ts` segments on.

0. **The lease** (`lib/agent/imageLease`, [`chat-image-paste-plan.md`](../feature/agent/chat-image-paste-plan.md) §5.2) — the earliest of the four to bite. A turn's pictures keep their pixels for that turn and `IMAGE_LEASE_TURNS` (1) *answered* turns after it; then they are replaced by a note, and the 【附图】 list's project-relative path is what the model reads them back by. It runs in exactly one place, `chatJob`, the moment the author's new question enters the history — never per tool round, never on resume, and not on AiPanel's Agent mode, which does not go through `chatJob`. Rewind does not bring the pixels back.
1. `trimHistory` (`runtime.ts`) caps a live history at the newest `MAX_IMAGE_RESULTS` (3) pictures — unconditionally, before the token check, because the token estimate charges a *flat rate* per image while the payload keeps growing.
   Then, still unconditionally, it elides older pictures until what is left fits `MAX_REQUEST_IMAGE_CHARS` (24 MiB of data URL) — the count cap counts *messages*, and one message can carry `MAX_MESSAGE_IMAGES` (5). The round in progress and the newest picture-bearing message are never touched (the same M1 rule as the token pass — stripping a picture the model just asked for makes it ask again); if what remains is still over, `streamCompletion` refuses the request with `ImagePayloadError` before uploading anything, and the runtime then takes those pictures out of the history (text kept) — the next question is appended to the same array and would otherwise still see that round as in progress, so the chat would be refused for good. The chat composer, the vision subagent and the metadata-improve pass fit themselves under the same ceiling when they build a message ([`image-normalize-plan.md`](../feature/image-normalize-plan.md) §2.9).
2. The same pass elides more, oldest-first, when the estimate is over the ceiling.
3. `serializeChatSession` drops every picture before the session blob goes into its SQLite row. A restored session has the conversation, not the pixels — and the paths are still in the transcript, so `read_image` can fetch one again.

#### 视频：同一条路，更窄的门（`docs/feature/video-input.md`）

视频片段以 `video_url` 内容块进入，和图片走同一条组装与清除路径，但每一处都更紧：

- **只有一个入口**：对话里的 `@`（`chatRefs.buildChatMessage` 的 `allowVideo`），没有工具。门是 `lib/ai/videoInput.canReadVideo`——模型声明了 `videoInput`、能看图、且能力表对这条线路的 `videoInput` 不是 `no`——只在 **`openai` 族**、且按平台点名：`video_url` 是厂商扩展，百炼、智谱、火山方舟 Coding Plan 实测收，DeepSeek、xAI、OrcaRouter 实测不收（OrcaRouter 上 Gemini 静默丢弃、GPT 报错），没测过的平台不发，中继照发（[`capability-gating-plan`](../api/capability-gating-plan.md) §9）。已经在历史里的视频每一轮再由请求计划问一次（`RequestPlan.media`），收不下就投影成一句说明、历史不动（`docs/feature/video-input.md` §4）；Responses / Gemini / Anthropic / 原生适配器对这个块的具名报错（`unsendablePart`）只是后备，不是门。
- **一个读取函数**：`lib/fs/video.readVideoForModel`，先 `readFileHead` 查大小（> 15MB 直接拒，因为 DashScope 单个 data URI 上限 20,971,520 字节），再整读、解析 MP4/MOV 头拿时长与尺寸（短于 2 秒拒），最后 base64。视频不压缩、不转码。
- **每条消息 1 段，历史里 1 段**：`MAX_MESSAGE_VIDEOS` 与 `trimHistory` 的 `MAX_VIDEO_RESULTS`，和图片的 5 / 3 各算各的；天花板那一遍和会话落盘同样把视频数据拿掉、文字留下。
- **估算不上线**：芯片上的 ≈token（`estimateVideoTokens`）以「代价随 fps 的函数」记进 `tokenEstimate` 的 WeakMap 供预检使用（投影出的副本带着它，按实际发出的 fps 计），不写在内容块上——`openai.ts` 原样发送内容块。无估值按 10k 计。
- `fps` 是模型行上的声明（`Model.videoFps`），放在内容块上而不是请求体上；它随另三项媒体声明进 `ConnOptions`，由计划决定这一次请求的片段带什么（`RequestPlan.clipFps`：写上、删掉，或手拼请求原样），`admitMedia` 投影时写到片段副本上——附加时写进历史的那个值线上不认它；运行时的裁剪与预算也按 `mediaProjection` 投影后的历史估算，只有压缩规划与上下文条还读它。「将发送」里显示为 `video_url.fps`（读 `plan.clipFps`），范围标「消息带视频时」（`docs/feature/video-input.md` §4「片段的 fps 也按请求决定」）。

#### 反过来：模型自己写的图片链接

同一条 `![](…)` 也会**从模型那边回来**——助手在回复里插一张图。这是全应用唯一一处图片链接不是作者写的，两件事都由此决定（`lib/agent/chatImages.ts`，纯逻辑 + 测试；DOM 那半在 `components/ai/AgentChat.tsx` 的 `AssistantBody`）：

- **相对谁**：文档的链接相对于文档所在目录（`Preview` 的 `basePath`），条目预览相对于条目目录（`MarkdownPreview`）。**一轮对话不是一个文件，没有目录**，所以相对链接一律相对**项目根**解析。代价是文档里 `assets/…` 那种写法在聊天里只有当文档就在根目录时才对——所以模型被要求写完整路径（见下）。
- **拒绝什么**：这个字符串是模型控制的，落在项目外就**根本不读**。`src-tauri/src/protocol.rs` 早就对 `ai-writer-asset://` 给过同一个答案（"crafted `![](ai-writer-asset://localhost/etc/passwd)` in imported/shared markdown"），这里是同形的威胁。`.ai-writer/` 在这条路上**是**放行的，与 `isWorkspacePath` 相反——那条禁令是为了写工具不成为进入知识库的后门，而条目图集正住在里面，把它显示出来本来就是知识库面板每天在做的事。

三条附带的实现事实，都不是可有可无的：

1. **必须内联成 data URL**，不能直接给路径：CSP 的 `img-src` 只有 `'self' data: blob: ai-writer-asset:`，而 `ai-writer-asset://` 因 Webview2 的 URL 解析已被弃用（`lib/lore/entity.ts`）。这也是编辑器预览和 `MarkdownPreview` 早就在做的事。
2. **走缩略图（`imageToThumbnailDataUrl`，长边 640）而不是原图**：理由和同文件里的 `TurnImages` 一样——生成图可以是 4096²，超过某个大小 WebKit 会**无声地**拒绝解码 `data:` URI，而这一栏只有几百 CSS 像素宽。
3. **解析前要 percent-decode**：markdown-it 把每个链接过一遍 `encodeURI`，所以中文条目名到这里已经是 `%E7%99%BD…`。用 `resolveLinkPath`（逐段 `decodeURIComponent`）而不是 `decodeURI`，与预览和导出同一条规则。

**还得让模型有路径可写。** 它看到的图集本来只有文件名（`read_lore_entity` 的 `=== images ===` 块、注入块里的「配图：文件名（描述）」），照抄下来就是一个解析不到任何地方的裸文件名——这正是这条路最初坏掉的样子。所以工具结果的图集标题带上条目目录（一次，不是每行一遍），`ai.instructions.agent` 的「配图」一节要求回复里配图写完整路径。没找到的图不是消失，而是一个虚线框，框里印着那条路径（`alt` 兜底成原始链接）——错的链接要看得见，否则作者只会看到助手少说了一段话。

### Paths across Windows and Linux/macOS

`lib/paths.ts` is the **only** module that knows how the two platforms differ, and it answers both questions from the *shape of the path* rather than from the host — so the functions stay pure and one test file covers both worlds:

- **Is `\` a separator?** Yes, unless the path is POSIX-absolute (`/…`, but not a `//server/share` UNC). On Linux and macOS a backslash is a legal character *inside* a filename, and splitting on it would invent directories; `D:\…`, UNC, and relative paths (which carry no shape at all) keep the Windows reading. `toPosixPath` applies the rule; everything else is built on it.
- **Does case matter?** `pathKey` folds case for Windows-shaped paths only — `D:\Proj\A.md` and `d:/proj/a.md` are one file, while `/proj/A.md` and `/proj/a.md` are genuinely two. Every comparison (`isPathWithin`, `isStrictDescendant`, `isSamePath`, `isProtectedPath`, `projectRelative`) goes through it, so they cannot drift apart again — they had, `projectRelativePath` folding case where its neighbours did not.

The vocabulary — `toPosixPath` / `baseName` / `dirName` / `joinPath` / `projectRelative` / `isSamePath` — replaced a dozen local copies of `p.split(/[\\/]/).pop()` and `p.replace(/\\/g,"/")`, one of which (the sidebar's project name) split on `/` alone and printed the whole path on Windows. Paths still enter in the host's own spelling (Rust's `to_string_lossy`, the native picker) and are answered in the POSIX one, so **never compare two paths with `===`** — a path that has been through any helper here meets one that has not, and the mismatch is silent: an approved edit writes to disk behind the open editor, whose next autosave clobbers it. Use `isSamePath` (it takes nulls).

### RAG (Retrieval-Augmented Generation)

- **Location** — `src/lib/context/rag.ts` (assembly) + `src/lib/context/loreSelect.ts` (lore selection)
- **Method** — Alias-based keyword matching (no embeddings, fast); facet-level secondary-key matching within matched entities
- **Context Assembly** (4 layers in `assembleContext()`):
  1. System prompt (from active template or default)
  2. Lore (facet-aware layered selection, see below)
  3. Recent document context (last 2400 chars before selection)
  4. Task instruction (continue/polish/rewrite/summary/custom)
- **Output** → `ContextBundle` → formatted to messages via `bundleToMessages()`; carries a `loreReport` (what was injected/dropped and why) rendered in `AiPanel`
- **The chat is the exception to layer 3.** A writing task is invoked *on* the open document, so it gets the window. The conversational assistant is not: it defaults to a **brief** of the open file (path, title, length, heading outline, plus a line saying the text was withheld and which path to `read_file`), and injects the window only when the turn points at the document — a pinned selection, or wording like 这一段 / 本章 / 全文 / 继续写 / `this chapter`. Decision layer in `src/lib/context/docFocus.ts`, wiring in the chat run (`stores/agent/chatJob.ts`), rationale in `docs/feature/agent/chat-memory-plan.md` §5a. The body can arrive on any later turn (`ChatSessionMeta.bodyDocPath` remembers whether it already did)

#### Facet-aware lore selection (`loreSelect.ts`)

An entity is a folder; any sibling `.md` with a `facet` frontmatter field (title, `keys`, `group`, `priority`, `mode: auto|always|manual`) is an independently-activatable **facet** — an outfit, a backstory arc, etc. Selection layers under one char budget (user setting in `appStore.loreBudgetTokens`, default 600 tk, range 200–128k, converted to chars by the planner's measured chars/token — presets + a free number field in `AiPanel`):

1. **Summary** (frontmatter one-liner) — every matched entity, guaranteed
2. **Gallery notice** — one bounded line naming the entity's pictures and what each one shows; see below
3. **Core** (`index.md` body) — paragraph-boundary truncated to fit
4. **Facets** — `auto` fires on entity match AND any key in the match target; same-`group` facets are mutually exclusive (highest priority wins; pins override); a facet that doesn't fit whole is dropped, never truncated

Pins come from `AiPanel` as `dirPath` (whole entity) or `dirPath#file` (single facet; implies its entity). Facet/core content is re-read from disk each call so hand edits are never stale. AI-assisted splitting of an oversized `index.md` into facets lives in `src/lib/lore/splitter.ts` + `LoreSplitModal` (backs up to `.ai-writer/backups/` before applying). See `docs/feature/lore/lore-facet-plan.md` for the full design.

#### 配图在注入里：一行字，不是图（`galleryNotice`）

命中的条目会带上这样一行，位置在 summary 之下、正文之上：

```
## 苏红
> 剑阁弟子，惯用左手
配图：avatar.png（头像） · portrait.png（银发束高马尾，黑色立领窄袖劲装…） · sword.png
剑阁第七代弟子……
```

**为什么要有这一行。** 在此之前，被 RAG 命中的条目里完全没有配图的痕迹——没有图、没有描述、也没有「这个条目有图」这句话。于是形成了一个死结：模型手里已经有这个条目的全部正文，就没有任何理由再去调 `read_lore_entity`，而**图库清单只在那个工具的返回值里**（`lib/agent/tools.ts`），所以它永远不会知道有图可看。`read_lore_image` 那条链路（先看文件名+描述，再决定要不要看图）设计得没问题，缺的只是入口。这一行就是入口。

**为什么是文字，不是图。** 把图库编码进注入块，等于每一次「提到了某个人物」的请求都要付几 MB 的 base64——而那张图这次任务多半用不上。这正是 `read_lore_entity` 当初拒绝支付的成本（2026-07-31 的挂起：5 张图 / ~35MB 一次调用直接超时）。这一行只携带模型自己拿不到的两样东西：**图存在**，以及 `read_lore_image` 需要的**文件名**。描述本身一图两吃——对纯文本模型它是唯一能得到的视觉细节（`lib/lore/vision.ts` 的系统提示就是照这个前提写的），对多模态模型它是「这张值不值得花钱看」的判断依据。

**为什么排在正文之前而不是特征之后。** 需要这一行的恰恰是正文长到能吃光预算的条目；放在最后填，写得好的条目一律看不到配图行，只有草稿桩子才有。正文是设计上就可截断的，最多为此少一段；这一行不可分割，而且比那一段更值——它是让图变得可达的唯一途径。

**两道上限。** 单条目 180 字（描述各截 48 字，多出来的图折成「另有 N 张」），全部条目合计不超过预算的 `GALLERY_BUDGET_SHARE`（20%）——一次命中二十个条目时，元数据不能把正文挤没。超出份额的条目照 facet 的规矩处理：不注入，但记进 `LoreEntityReport.droppedImages`，在 AiPanel 的注入报告里显示为一个 dropped chip。

**槽位（slot）不进这一行。** 分类的 image slot 是创作侧的元数据，`docs/feature/lore/lore-entry-type-plan.md` 的三条不变量之一就是 slot 绝不参与注入；而且能力包一关，那个 id 对模型就是个没有意义的词。

**「可以看图」这句话不写在注入块里，写在工具简介里。** 注入块是事实（有这些图、叫这些名字、画的是这些内容），对没有工具的任务（`tools: "none"`）和纯文本模型同样成立；「需要时调 `read_lore_image`」是能力，只在真的带着那个工具时才为真——所以它落在 `ai.instructions.toolsRead`（read 档）和 `ai.instructions.agent`（full 档）里，这两处本来就只在对应工具在场时才发出。这样 `selectLore` 也不必知道模型是不是多模态、preset 带了哪些工具，省掉一路参数透传。

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

- **Say what the ceiling is.** `modelValue("maxOutput", …)` (`src/lib/ai/capability/values.ts`) resolves it in one place, with its source: the author's own `maxOutput` → the platform's row for the id → the built-in table (`cells/catalog.ts`, read through `modelLimits.ts`) → the app-wide default (Settings → 渠道与模型, pref `app:defaultMaxOutput`) → each protocol's own fallback. The planner takes any source (`plannedLimits` in `conn.ts`); the Anthropic `max_tokens` takes **only the author's** (`capability/intent.ts` `TRUST`), because there a value above the model's ceiling is a 400 — `modelLimits.ts`'s `DEFAULT_MAX_TOKENS` (32k) keeps that job otherwise, whatever the tables or the app default say. Elsewhere the value is planning-only — the OpenAI and Gemini adapters send no cap at all. 「探测真实上限」 (`endpointProbe.ts`) measures the truth and writes it onto the model; the table is only what an author sees before they bother.
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
- **A floor is not a ceiling** (fixed 2026-09-19). A generation run that reached what it asked for proves only that much is reachable, so its low-confidence finding stays out of the minimum; otherwise asking for 16k on a model declared at 64k "corrected" it to 16k on 应用. It is kept as a conflict when it exceeds the chosen cap. Likewise a run counts as capped (`outputRunCapped`) only when something *other than the model* stopped it short — a length-type finish reason or none at all; `stop` / `end_turn` / `STOP` is the model being done, not a server limit
- **Detection is proof; non-detection is not.** A server may report the pre-truncation count, omit usage, or (via a relay) invent it. Both the report and the UI string say so explicitly
- **Nothing is written automatically.** The probe fills the form only when the author presses 应用, and the form still has to be saved. `model.probedAt` dates the measurement, because a relay can re-route the same model name tomorrow
- **Padding is a seeded word sequence**, not `"aaa…"` or a repeated paragraph — prefix caching and some tokenizers collapse long repeats, which would make the measured count a fiction

### 小模型 / 本地端点：三处不能靠模型自己推断的地方

Probing above fixes what the *endpoint* misreports. This section is the other half — what the **request** leaves unsaid, and what a smaller model does not fill in on its own. All three were found driving a local model through the real code paths; the protocol itself was fine. Measurements: [`feature/agent/measurements/small-model-gaps-2026-08.md`](../feature/agent/measurements/small-model-gaps-2026-08.md).

**1. A read-tool task says it has tools** (`toolBriefingFor` in `lib/agent/presets.ts`). A frontier model infers "these schemas exist, so I should look things up"; a small one doesn't, and fails silently. The briefing goes in the **system** layer, like the chat's (`stores/agent/chatJob.ts`): it is a standing fact about the run, not a step of the task. Only the read tier gets one — `full` tasks already carry theirs in the *task* layer (`ai.instructions.agent`, `ai.instructions.htmlArtifact`), and briefing a `none` task would be paid-for tokens describing tools the request never sends. It is a function of the **tier**, not of a task id, because a pack may declare any number of read-tool tasks and every one of them has the same gap.

**2. Structured output forces `"required"`, never a named `tool_choice`** (`lib/agent/structured.ts`). It presents one pseudo-tool and forces it. The named spelling is the one ollama **silently ignores**, costing a whole request before the JSON fallback runs. With exactly one tool offered the two are the same instruction, and all three adapters map `"required"` (OpenAI `required`, Anthropic `{type:"any"}`, Gemini mode `ANY` with no `allowedFunctionNames`).

**3. Temperature is a local-endpoint escape hatch, not a tuning knob** (`Model.temperature` → `ConnOptions` → all three adapters). Without it an ollama model runs at whatever the Modelfile baked in, with no way to change it from the app. It does **not** fix erratic tool use (measured: the briefing is the fix), and lowering it narrows the spread of multi-draft output — so the hint text says so, including that temperature 0 does not buy reproducibility. Three details hold it in place:

- **0 is a value, not "unset".** It is the temperature an author reaches for when a task must stop being creative, so every test on it is `!== undefined`, never truthiness — in the form state, in the save path, and in all three adapters
- **Absent means absent.** An unconfigured model's request is byte-identical to before the setting existed
- **The control is hidden where the request would drop it.** The `temperature` capability (`hasCapability("temperature", …)` in `ai/capabilities.ts`, a `thinkingOff` rule) is asked by *both* the Anthropic adapter and the model editor: the Messages API accepts `temperature: 1` alone while thinking is on, and `defaultDialect` makes Anthropic thinking unless declared otherwise, so on an ordinary Claude model the row does not render at all. Clamping the author's 0.2 up to the one legal value would send the opposite of what they asked for under the name of honoring it; showing a control the request then drops is what that module's own comment ("a control that does nothing is worse than no control") exists to prevent

Two related gaps stay open on purpose, both bigger than a setting: the full toolset's schemas still ride on every agent request — tiered since (`none` / `read` / `write` / `full` via `presetForTools`, and the assistant preset keeps its rarer groups behind `search_tools` so only its resident half, capped at 9k tokens by `agentToolBudget.test.ts`, is paid per round), but a 32k local model still can't afford `full` (`contextForecast.test.ts`) — and `discoverOllama` reads limits out of `/api/show` but not its `capabilities` array (`tools` / `vision` / `thinking`), so `model.type` remains author-declared.

### Story Memory (前情提要)

Per-document rolling summary so long manuscripts don't lose early plot in AI tasks — the assembled context carries a `【前情提要】` layer (compacted summaries of everything before the verbatim window) ahead of `【近期内容】`.

- **Location** — `src/lib/context/memory.ts` (pure logic + file IO), `src/stores/memoryStore.ts` (generation orchestration), UI strip in `AiPanel.tsx`
- **Storage** — `.ai-writer/memory/<relative doc path>.md`: machine metadata (segment ranges + FNV-1a hashes) in a leading `<!-- ai-writer-memory {json} -->` comment; each segment's summary is a human-editable `## …` section paired by order
- **Segmentation** — source split at paragraph boundaries into ~12k-char segments (scaled by `model.contextSize`); coverage stops `MEMORY_TAIL_KEEP_CHARS` (2000) before the end — the verbatim window handles the tail
- **Updates are incremental** — appending only summarizes the new tail; editing early text invalidates that segment *and everything after it* (offsets shift), and an update re-summarizes from the first stale segment. Manual, never automatic: the AiPanel strip shows coverage/staleness and prompts the user to create/update when >10k pre-window chars are uncovered
- **Context selection** — `selectMemoryForContext()` includes only segments starting before the verbatim window (a mid-document selection never sees later plot), newest-first under a budget from the planner below (a 0 budget means "no room" and yields nothing)
- **Usage tracking** — summarization tokens land in `token_usage` with `task = "memory"`

### Book Spine & cross-chapter memory (大纲书脊 / 文库)

Story Memory is *per-document*, so a chapter is its own file and knows nothing of its siblings. The book spine adds an explicit chapter *order* so continuing a fresh chapter can see what came before it.

- **Location** — `src/lib/context/outline.ts` (order resolution, spine IO) + `src/lib/context/bookContext.ts` (book-context assembly); the **library view** (文库, `MainView` id `library`, `src/components/library/LibraryView.tsx` — formerly 大纲·全图/OutlineFullView) is the editor (drag-to-reorder). Plan & naming rationale: `docs/feature/library-plan.md`; design canvas `01f 文库 · 挑选`
- **Storage** — `.ai-writer/outline.json`: `{ version, order: { <volume relPath>: [<chapter relPath>, …] }, volumes: [<volume relPath>, …], members: { folders, docs, exclude } }`. **`members` is the library (文库成员表, `lib/context/library.ts`)**: only whole-member folders and individually picked docs count as the book — for the library view *and* for 续写 (`resolveVolumes` = `groupVolumes → applyMembers → applySpine`). No outline.json = empty library; a file without `members` infers it once from the order's non-empty volumes. Every move through `projectStore.moveEntry` rewrites order / status / members to the new path (`moveInSpineOnDisk`, bumps `projectStore.spineRev`). Rationale and rules: `docs/feature/library-plan.md` → 第四期. A **volume** = a book: chapter files at the workspace root form a default volume (relPath `""`), each folder — at any depth, `assets/` excluded — is its own. `volumes` orders the columns themselves with the same overlay semantics (absent in older files → traversal order, exactly what they had)
- **Order is an overlay, not a rigid list** — `applySpine()` applies the manifest order, drops entries whose file vanished, and appends un-listed files by **natural (numeric-aware) sort** (`naturalCompare` — so 第2章 < 第10章, 6-1 < 6-2 < 7). Creating/deleting files outside the outline UI never breaks ordering; the backend's byte-sort no longer decides chapter order
- **Chapter files** — `.md` / `.markdown` / `.txt` (the outline view previously dropped `.txt`)
- **Resources** — `Volume.resources` lists a folder's direct *non-chapter* files (images, PDFs…), natural-sorted; the library view renders them under the chapter cards (images with a data-URL thumbnail, same path as `ImagePreview`) and clicking opens them in the editor area. Purely display-layer: resources never enter the spine, `bookContext`, or any AI context. A member folder holding only resources (the root included) still shows as a column; the library's delete-group button appears only when the folder is empty on disk (no subfolders, no assets/, no docs excluded from the library) — `removeDir` is recursive and keeps no backup
- **Collection digest (集合摘要)** — per-volume AI summary shown on each library column (`lib/context/collectionDigest.ts` format/IO/freshness + `stores/digestStore.ts` one-at-a-time generation). Stored at `.ai-writer/collections/<volume relPath>/digest.md` (root volume: `collections/digest.md`) in the memory-file style: `<!-- ai-writer-digest {json} -->` metadata (ordered chapter relPath+hash list) over an author-editable summary body. Stale when the chapter set changed, was **reordered**, or any content hash mismatches. Generation prefers each chapter's *fresh* story-memory summaries over raw text, fits the prompt to `segmentTargetChars(model.contextSize)` by equal-share truncation (400-char floor), uses the summary model (`memoryModelId ?? activeModelId`), and bills to `token_usage` as task `digest`. Display-layer only — digests never feed AI task context
- **Referenced lore chips** — the same one-pass chapter read that drives the memory badges also runs `matchEntitiesInText` (`lib/lore/match.ts`, loreSelect's auto-match semantics: case-insensitive name/alias substring) over each volume's full text; the chips navigate via `loreStore.openDetail` + the lore wall. Local scan, no AI cost, recomputed every visit — never stale, never persisted
- **Continuation memory** — `buildBookContext()` (called from `aiTaskStore` for the `continue` task) resolves the active chapter's position in its volume and returns two layers, emitted by `bundleToMessages`:
  - `【全书前情】` — recap of prior chapters, from *their* memory files, newest-first under a planner-supplied budget (chapters without a memory file simply contribute nothing — generate per-chapter memory to enrich it)
  - `【上一章结尾·<title>】` — the previous chapter's verbatim ending (a bridge), included only when the cursor is near this chapter's start; deeper in, the chapter's own `【近期内容】` carries continuity
- **Scope** — resolution stays within the active chapter's volume, and only inside the library (a chapter outside it gets no book context; the AI panel says so and offers to add its folder); only the `continue` task consumes it (a mid-document edit stays local)
- **Per-chapter memory in the outline** — each chapter card shows its Story-Memory state (`memoryStatus()` → 就绪 / 需更新 / 无摘要 / 过短) and can trigger generation *for that chapter* without opening it. The generation core is factored into `runMemoryGeneration()` (shared by `memoryStore.generate` for the active doc and `memoryStore.generateForFile(absPath)` for outline-triggered chapters); `generateForFile` reads the target's content from disk (or the live editor when it's the open file) and tracks progress under `chapterGen` so it doesn't collide with the AiPanel's active-doc strip
- **Summary model** — `aiStore.memoryModelId` (set from the outline header picker) selects which model does summarization; `memoryStore.resolveModel()` falls back to `activeModelId` when unset
- **Volume & chapter management in the library** — a volume maps to a workspace folder the author put in the library (a member folder that is empty still shows, usable as a move/create target). The library can create a volume (`makeDir`, joins the library whole), rename one (`projectStore.moveEntry` the folder — which itself rewrites the spine's paths via `moveInSpineOnDisk`, nested volume keys included, path-segment aware — then move the mirrored `.ai-writer/memory/<rel>` and `.ai-writer/collections/<rel>` subtrees along and re-read the spine), reorder columns (◀▶ buttons → `spine.volumes`), and delete a truly empty one (`removeDir`; the workspace-root volume is never deletable or renamable). Chapters: the empty-volume placeholder card creates one (`projectStore.createEntry`, which refuses overwrites), the context menu offers open / mark 在写 / rename / remove from library (not a delete: excluded or unpicked) / delete — rename keeps the old extension for a bare name, carries the spine position + 在写 status + memory file to the new relPath; delete goes through `projectStore.deleteEntry` with `backup: true` (snapshotted into `.ai-writer/backups/`, same as the file tree) and cleans the status entry and any picked/excluded library entry for that path (otherwise a file later created there would inherit it). Selected chapters move between volumes via the header picker (`moveEntry` + `moveMemory` per chapter). Single click *selects* (multi-select), double click opens, the top/up/down/bottom buttons reorder within a volume, and **drag works across volumes too**: dropping on a chapter inserts at its position (in-volume → reorder; cross-volume → file move + memory + spine position + status), dropping on a column's empty space appends at its end
- **Chapter status** — `BookSpine.status` (persisted in `outline.json`) maps a chapter relPath → `"writing"`; absence means done. Set via the chapter context menu; the header stat splits 完 / 在写 from it. `spineFromVolumes(volumes, prev)` carries the status map across reorders
- **Forcing a short chapter's summary** — the outline's per-chapter generate button passes `force` for `status === "short"`; `runMemoryGeneration({ force })` then bypasses the `MEMORY_MIN_DOC_CHARS` guard and covers the *whole* chapter (no verbatim tail), since a short prior chapter's book-level recap wants all of it

### Streaming (SSE)

`src/lib/ai/index.ts` dispatches on the protocol family to five adapters (Chat Completions, Responses, Gemini, Anthropic Messages, DashScope native); every adapter speaks the app's one internal message shape and yields the same stream chunks, so nothing above `src/lib/ai/` knows which wire a run is on. What each wire actually sends and accepts is in [`docs/api/`](../api/README.md) (`streaming.md`, `usage.md`, `structured.md`, `reasoning.md`); how the adapters convert, normalise usage, cap output and shape JSON mode is in [`codemap.md` → `src/lib/ai/`](codemap.md#srclibai) → 流式协议层.

### Secure Key Storage

- **Backend** — OS credential manager via the `keyring` crate (Windows Credential Manager / macOS Keychain / Linux Secret Service), service name `com.simple-ai-writer.app`
- **Rust commands** — `secret_save` / `secret_load` / `secret_delete` / `secret_clear_all` in `src-tauri/src/secrets.rs`. All four run on the blocking pool (`crate::blocking`, i.e. `async_runtime::spawn_blocking`), not on an async-runtime worker: one call can block for as long as it takes the author to answer a macOS Keychain dialog, and the migration below answers a whole row of them
- **Storage shape differs by platform.** macOS keeps **every** secret in a *single* keychain item (account `all-secrets`, holding a JSON `{id: secret}` map); Windows and Linux keep one credential per id. Not symmetry for its own sake — keyring's macOS backend writes into the file-based login keychain, where **each item carries its own ACL** keyed to the binary's code-signing identity; an ad-hoc-signed release's identity is its `cdhash`, which changes with every build (why, and the measurements: [`macos-signing.md`](macos-signing.md) §0). So after every update macOS re-asks for the login password **once per item**, and 「始终允许」 only ever covers the item its dialog was about. One item per provider meant one dialog per configured provider — 18 on the author's machine — on every single update. Off macOS a bundle would buy nothing and cost something: the Windows Credential Manager doesn't prompt and caps one credential's blob at 2560 bytes (a dozen API keys overrun it), and the Secret Service unlocks a whole collection at a time rather than an item at a time. The size asymmetry is in the storage, not in the idea: the Windows cap is a documented field constraint (`CredentialBlobSize` "cannot be larger than CRED_MAX_CREDENTIAL_BLOB_SIZE (5*512)" — Microsoft's `CREDENTIAL` docs), while a login-keychain item's data is a variable-length blob with no equivalent — 2.5 KB / 10 KB / 100 KB / 1 MB / 4 MB / 16 MB all round-tripped through a throwaway item on a real login keychain (16 MB is where the probe stopped, not where it broke). 18 secrets as JSON come to roughly 2–3 KB: over the Windows cap, nowhere near anything on macOS
- **The bundle is the cheap half of the fix.** The real one is a fixed signing certificate (self-signed or a paid Developer ID), which makes the ACL name the certificate instead of the `cdhash` — that plan and its status are [`macos-signing.md`](macos-signing.md)'s. Until then the bundle turns N dialogs per update into one, and it also shrinks the single unavoidable prompt *after* such a switch to one item
- **Bundle migration (macOS)** — the pre-bundle per-provider items are folded in on first use, inside the same lock that guards the item. It **enumerates** (`keyring_core::Entry::search` by service, which loads attributes only and so is silent) rather than asking the frontend for the ids it knows: a provider the author deleted, or an id one of the three callers forgot to report, would otherwise be a secret left behind in a store nothing reads any more. Reading each item is the one dialog apiece, paid once. Order is write-the-bundle-then-delete-the-items, so an interruption duplicates a secret rather than destroying one; an item whose dialog was dismissed stays where it is and the pass runs again next launch. A bundle that won't parse as JSON is an **error**, not an empty bundle — treating it as empty would let the next save overwrite every key the author has
- **Wholesale wipe (`secret_clear_all`)** — 重置应用配置 的钥匙串那一半，见下面的「重置应用配置」。参数是前端**叫得出名字**的账户列表；macOS 忽略它、直接清空那一个条目（`with_bundle` 刚把散落的旧条目折进来，所以手上的就是全部），Windows / Linux 按名字逐条删。单条失败不中断也不抛——它记进 `SecretWipe.failed`，因为调用方要拿这个数**做决定**：`failed > 0` 就不许动数据库
- **No in-process cache.** Every read goes to the keychain and every write is a read-modify-write, guarded by one `Mutex` for the process. The app runs one process per workspace (`instance.rs`), so a cached copy in one instance would silently overwrite what another just saved; the lock is what keeps two parallel writes (several sub-agents resolving keys at once) from losing one
- **Frontend** — `src/lib/keyStore.ts`: `saveApiKey(providerId, key)`, `loadApiKey(providerId)`, `deleteApiKey(providerId)`; falls back to sessionStorage outside Tauri (browser dev)
- **Migration** — keys stored by older builds in the plaintext SQLite `api_keys` table are moved into the keyring and deleted from the DB. `migrateLegacyKeys()` sweeps the *whole* table once per launch (from `aiStore`'s lazily-initialized `db()`, alongside `ensureAiSchema`) and then `DROP`s it + `VACUUM`s — the lazy per-provider path only ever ran for a provider something asked about, so a key belonging to a provider the author stopped using (or deleted from the UI) stayed in plaintext indefinitely. Per row the order is save-then-delete, so an interruption at worst duplicates a key into the keyring; the table is dropped only when nothing failed, leaving the rest for the next launch. Cleanup never fails the config load that triggered it
- **History** — stronghold was removed (its Rust actor deadlocked on some macOS setups); an interim plaintext-SQLite scheme was then replaced by the keyring; the keyring's own per-provider items were folded into one on macOS once it became clear every app update re-asked for the login password once per provider

### Navigation history (后退 / 前进)

- **Location** — `src/stores/navStore.ts`; keys dispatched from `useGlobalShortcuts`, installed once from `App`
- **A location** = `{ mainView, activeFilePath, lore detailPath }` — the three things the author moves *between*. Drawers, modals, sidebar tabs and scroll position are chrome, not places, and are deliberately not restored.
- **Recorded by observation, not interception.** The store subscribes to `appStore` / `projectStore` / `loreStore` and notices when the location changed. Every navigation path — file tree, command palette, library rows, citation clicks, "open in editor" — lands in the history without knowing the store exists, and one added later can't forget to register. The cost is a location comparison per store update, which short-circuits on the first field.
- **`applying` flag** — set while back()/forward() restores a location. zustand notifies subscribers synchronously inside `set`, so a replayed step is fully observed before the flag clears and never re-enters the stacks. `replaceLocation()` reuses the flag for `history.replaceState` semantics: same place, new address (moving a lore entry to another category renames its folder while the author is looking at it).
- **Bindings** — Mac `⌘[` / `⌘]` always, plus `⌘←` / `⌘→` outside text entry (there the caret owns them). Elsewhere `Alt+←` / `Alt+→`, which CodeMirror leaves free so it works mid-manuscript. Mouse buttons 3/4 with `preventDefault` on the press, so the webview doesn't attempt a page-history navigation of its own. Combos live in `lib/shortcuts.ts` (`NAV_BACK_COMBOS` / `NAV_FORWARD_COMBOS`) and are listed in Settings → 快捷键.
- **Boundaries** — a blocking overlay (settings, palette, onboarding) suspends both directions; opening another project clears the history, since another project's files aren't places in this one. Depth caps at 100.
- **Prerequisite** — the wall's open lore entry lives in `loreStore.detailPath` (not LoreWall local state) precisely so history can read and restore it; an unresolvable path just renders the grid, which also covers "entry deleted since you visited it".

### AI 面板的标签页记忆（⌘J / ⌘L）

- **位置** — 标签页本身在 `components/ai/AiDrawer.tsx`（生成 / 对话 / 一致性检查 / 扮演），当前那一个存在 `appStore.aiDrawerMode`，落盘到偏好 `app:aiDrawerMode`。
- **`setShowAiDrawer(v, mode?)` 的 `mode` 是可选的，这就是记忆的全部机制。** 传了 tab 就**记住**它（`writePref`，且只在真的换了 tab 时写），不传就是「照原样打开」——回到作者上次停在的那一个。
- **⌘J 是面板的开关，不是某个标签页的入口。** 它不指定 mode，所以和图标栏、标题栏的按钮行为一致：抽屉回到上次的 tab。以前它写死 `"generate"`，于是作者在「对话」里按 ⌘J 关掉、再按 ⌘J，回来的是「生成」——面板记住了 tab，快捷键却每次把它覆盖掉。
- **⌘L 保留 mode，是有意的不对称。** 一个「无论现在在哪个 tab 都直达对话」的键有独立价值；⌘J 则是「把面板收起来 / 拿回来」。同理，⌘⇧E/L/M 和内联气泡仍然强制 `"generate"`——它们要跑的就是生成任务，落错 tab 等于什么都没发生。
- **没有因此丢掉可达性** — 命令面板仍能按名字打开「生成」（并把查询串当作选区）和「一致性检查」，扮演有自己的 tab。
- **降级只在读取侧** — `storedAiDrawerMode()` 在读到 `"roleplay"` 而 Beta 开关已关时退回 `"generate"`；偏好里那一行不改写，开关重新打开时记忆还在。
- **回归测试** — `src/stores/__tests__/aiDrawerMode.test.ts`：连续多次「不指定 tab 地打开」必须不漂移回第一个标签页。

### 系统通知 (OS notifications)

- **Location** — `src/lib/notify.ts` (switches + gating), `tauri-plugin-notification` on the Rust side, Settings → 通用 → 系统通知.
- **What is announced** — only the three moments the author is likely to have switched windows: *the run stopped and is waiting for you* (`approval` — an edit/rewrite/append/illustrate/pptx approval card, a lore write plan, the round-limit card, the truncation card), *the run finished* (`done` — a chat turn, an AI-panel task, a batch run with no failed clause, a roleplay reply on a non-active agent) and *the run failed* (`error` — the same surfaces when the call threw, plus a batch with any failed clause). Everything else stays in-app, and a run the author aborted is never announced at all.
- **Why success and failure are two kinds, not one "ended"** — they are two different reasons to come back. An author who finds "finished" noisy on a busy day must still hear that a run died halfway; one who only wants failures should not have to give up the summons for approvals. Every call site decides the kind from the outcome it already has (`failure ? "error" : "done"`), so there is no second place where "what counts as failed" is spelled.
- **Four gates, in order** — the master switch (`app:notifyEnabled`, **default off**); the per-kind switch (`app:notifyApproval` / `app:notifyDone` / `app:notifyError`, default on); **window focus** — a notification for something already on screen is noise, so a focused window is silence; and a per-kind coalescing window (approvals 8s, completions and failures none) so a run that proposes six edits summons the author once. `isFocused()` failing counts as *focused*: a notification framework's failure mode should be quiet, not chatty.
- **Why the master switch defaults to off** — the first notification is what registers the app with the OS's notification centre. Flipping the switch is the moment the author asked for that, which is also where `requestPermission()` is called from.
- **What a notification never carries** — the model's text or the document's. These land on lock screens and stay in notification history; content belongs in the app's own panels. Bodies name the surface and the outcome (and, for an edit, the file's basename).
- **One job, one ping** — `batchStore` drives `aiTaskStore.runTask` once per clause, so it holds `muteRunFinished()` for the whole loop and sends a single summary at the end. The mute is a counter (nesting-safe) and covers the run-ended kinds (`done` and `error`) only: a failed clause is a line in the summary, not a ping of its own, but a batch that stops for an approval still has to summon the author. It is checked on the *first* line of `notify()`, synchronously, because the last clause's completion and the loop's exit are one microtask apart.
- **Permission is a mobile concept here** — the desktop plugin answers `Granted` to both `isPermissionGranted` and `requestPermission` unconditionally. The real authorization is the OS's: macOS registers the app under 系统设置 → 通知 the first time a **bundled** build posts one, and Windows needs the app **installed** (an AppUserModelID is only set outside `target/`). That is why the settings pane carries a 发送测试通知 button — on a desktop where the API cannot tell you anything, actually sending one is the only honest check.
- **Dev mode wears someone else's face** — under `tauri dev` the plugin deliberately posts as `com.apple.Terminal` on macOS and with no app id on Windows, so a dev-mode notification shows the terminal's / PowerShell's name and icon. Expected, not a misconfiguration.
- **Permissions** — `notification:allow-is-permission-granted` / `allow-request-permission` / `allow-notify` in `capabilities/default.json`, rather than `notification:default` (the scheduling, channel and listener commands are unused). Focus reading needs nothing new: `core:window:default` already includes `allow-is-focused`.

### 渲染引擎的能力底线（`src/lib/webviewCaps.ts`）

Tauri 窗口只有机器上的 webview 那么新：Windows 是 WebView2（Chromium，常态下随 Edge 常青更新，但更新被策略挡住、或装的是 Fixed Version 运行时的机器会停在旧版本），macOS 是 WKWebView（那个 macOS 版本封顶的 Safari），Linux 是 WebKitGTK。构建目标是 Vite 默认的 `baseline-widely-available`（Chromium 107 / Safari 16），但那只决定哪些**语法**被转译——缺一个内置函数不会被转译掉，它在调用处直接抛，还带着压缩后的名字（2026-09 的实例：pdfjs 6.3 在 WebView2 < 140 上每个 PDF 都死于 `n.toHex is not a function`，`Uint8Array.prototype.toHex` 是 Chromium 140 / Safari 18.2 才有的）。

两条规则：

- **按特性判断，不按 OS 或版本号。** 同一个失败在 macOS 12（Safari 最高 17.6）和陈旧的 WebView2 上是一样的；按 OS 查表要维护一张表；而 macOS 上 WKWebView 的 UA **根本没有 `Version/` 字段**——所以版本号只做显示（`parseEngine` / `engineName`），`CAPS` 里的探测才是判定。每条探测必须在底线**以内**（`webviewCaps.test.ts` 钉着）：探到一个比底线还新的 API，报的就是构建本来就承诺不支持的东西。
- **依赖有补丁就补，没有才提示。** pdfjs 自带 legacy 构建（core-js polyfill 了 `toHex` / `fromBase64` / `Promise.withResolvers` / `Promise.try` / 迭代器助手，`Float16Array` 走 `typeof` 回退），所以 `lib/import/pdf.ts` 加载的是 `pdfjs-dist/legacy/build/…`，作者永远不会听到 `toHex`；留在探测清单里的是应用自己站着的底线——没有人替我们 polyfill 的那些（`structuredClone`、`Array.prototype.at`、`AbortSignal.timeout`、容器查询……）。

缺失只报一次**每个不同的集合**（`capsNoticeKey`，存 `app:webviewCapsNoticed`，机器级偏好——引擎是机器的），以 TitleBar 下一条警示（不是 danger：此刻没有东西在坏）出现，并常驻在设置 → 关于的「渲染引擎 / 引擎能力」两行——下一次跨机器的 bug 报告先要这两行。安装器帮不上忙：Tauri 的 Windows 安装包默认只在 WebView2 **缺失**时下载安装，对已装的旧运行时一概不动，也没有「最低 WebView2 版本」可声明，所以应用内探测是唯一的一道。已知仍在底线之外的第三方：mermaid 的 architecture 图用了 `Set.prototype.union`（Chromium 122 / Safari 17），只影响那一种图。

### Export

- **Location** — `src/lib/fs/export.ts`
- **Markdown** — Copy to clipboard
- **HTML** — Self-contained file (inline CSS, no external assets)
- **PDF** — The system print dialog is the PDF engine; the path there is per-platform:
  - **Waiting for fonts, both paths** — a downloaded font pack (鸿蒙黑体 / MiSans) is split by `unicode-range` and each chunk loads only when layout meets it, so on a long document some can still be in flight at "load"; printing on a fixed delay prints them in the fallback face. Each path waits for `document.fonts.ready`, capped at 3 s (`docs/feature/downloadable-fonts-plan.md` §6).
  - **Windows/Linux** — hidden iframe, render HTML, wait for the iframe's `fonts.ready` (the main window's CSP refuses inline scripts, so `printPage` waits from outside), `window.print()`, remove iframe after 2s. The webview is Chromium (WebView2) / WebKitGTK, where printing a detached iframe just works, and the dialog owns the paper margins.
  - **macOS** — `window.print()` is a silent no-op (WebKit forwards JS print to the host's `WKUIDelegate`; wry implements no print callback), so the frontend calls `invoke("print_document")` instead. `src-tauri/src/print.rs` stages the HTML behind a custom `ai-writer-print://` scheme (single-use, nothing on disk), opens a print-preview window on it, and runs its own `NSPrintOperation` on the WKWebView. It does **not** use wry's `print()`/tauri's `WebviewWindow::print()`, because wry zeroes all four margins on the process-wide *shared* `NSPrintInfo` — text flush against the paper edge, and the mutated defaults leak into later print jobs. `print_with_margins` copies the shared print info and sets 0.5in margins (the print CSS zeroes the body's own padding so the two don't stack). macOS has no virtual PDF printer — the export exit is the print dialog's easily-missed "PDF ▾ → Save as PDF" menu — so the preview window carries a bottom banner (`editor.exportPdfHint`, hidden under `@media print`) pointing at it. The PDF page (not an author's own `.html`) ends with a script that, once `document.fonts.ready` resolves, requests `/__fonts-ready` on its own origin; `stage()` stamps the **last double-quoted** `"/__fonts-ready"` in the page with the print's generation (`?g=<n>`), and the print waits for that generation's signal, up to 3 s — so the script must keep the path in double quotes and stay last in `<body>`.

> Theming/design tokens live in `docs/reference/design-system.md`.

## Important Notes

### Circular Dependencies

The value-import graph of `src/` has **no cycles**, and `src/lib/__tests__/layering.test.ts` keeps it that way (Tarjan over every value import, `await import()` included; `import type` excluded). Three rules follow:

- **`src/lib/**` never imports a store** — not statically, and not with `await import()` either. A lib module that needs store state takes it as a parameter; agent tools get it through `ToolContext.appState` (`stores/toolAppState.ts`), non-tool functions as an argument (`resolveAsrConn(settings)`, `runIllustration(…, settings, …)`, `installCitationNavigation({ index, open })`). The rule used to allow `await import()` here; that dodged the bundler's cycle check and put `aiStore` and `loreStore` inside two import cycles (docs/feature/code-structure-plan.md P3). The guard's ceiling is zero.
- **Stores don't call each other in both directions.** Where two did, the dependency is now handed in: the chat side's steps in a project switch are hooks that `stores/projectLifecycle.ts` passes to `projectStore`; a batch run tells `runTask` `{ fromBatch: true }` instead of `aiTaskStore` reading `batchStore`; what needs both the project and the editor lives above both in `stores/openDocument.ts` (docs/feature/code-structure-plan.md P4).
- **The store-to-store `await import()`s that remain are about load order, not cycles.** `agentStore` and its private split `stores/agent/chatJob.ts` reach `projectStore` / `appStore` / `openDocument` / `memoryStore` lazily because each of those pulls in `appStore`, which paints the theme onto `document` at module load — and `agentStore` is imported directly by node-environment tests. The guard pins how many there are.

Because the remaining lazy targets are also imported statically elsewhere (components), the bundler reports `INEFFECTIVE_DYNAMIC_IMPORT` for each — "this dynamic import did not move the module into its own chunk". That is expected and harmless: the goal was deferring *evaluation* to call time, which still holds within one chunk, and this app is loaded from local disk by Tauri so chunking buys nothing. `vite.config.ts` filters exactly those warnings, keyed on the target living under `src/stores/`.

**The same warning pointing at a `src/lib/**` target is a real defect** — it means someone wrote `await import()` for a module that is statically imported anyway, which buys nothing and only obscures the call site. Those are deliberately left unfiltered; convert them back to a top-level import.

### Tauri IPC Commands

Most logic is TypeScript; the Rust side is file I/O behind a path fence, secrets, transactions, transfer, printing and the Office readers/writers. Each file's commands, rules and reasons are in [`codemap.md` → `src-tauri/`](codemap.md#src-tauri); plugin permissions are in `src-tauri/capabilities/default.json` (see Capabilities & Permissions below).

### File I/O
- `src/lib/fs/fileio.ts` wraps the app's own `fs_*` Rust commands (`fs_read_text_file`, `fs_write_text_file`, `fs_stat`, `fs_read_dir`, `fs_rename`, … in `src-tauri/src/commands.rs`, behind `FsScope`) via `invoke`; the one exception is `readBinaryFile`, which uses the fs plugin's `readFile` so bytes come back as a `Uint8Array` instead of base64 through JSON
- No raw fs access from the webview: every path goes through those commands or the fs plugin's scope
- **Text encoding is guessed on read, converted on save** (`decode_text` in `src-tauri/src/commands.rs`): `fs_read_text_file` tries BOM → strict UTF-8 → chardetng (GBK/Shift_JIS/Big5/windows-125x…), so a file the author copied in from a Chinese-Windows machine opens instead of erroring. Order matters and each step's reason is on the function: BOM before the UTF-8 fast path (a UTF-8 BOM *is* valid UTF-8 and a surviving U+FEFF breaks frontmatter detection) and before the NUL check (UTF-16 is full of NULs); a NUL past that point means binary, which is **refused** rather than guessed — decoding a PNG "successfully" hands the editor garbage that the next save writes back over the image. Whatever the source encoding, the decoded string is UTF-8, so saving an edited file converts it to UTF-8 on disk — the write path never needs to know. The frontend's own GBK fallback in `lib/import/text.ts` predates this and stays: imports read bytes for other reasons and its pure form is what the tests pin.

### Organising files (sidebar)

The workspace is the **whole project directory** — documents live wherever the author puts them, so the sidebar has to be a real file manager rather than a viewer over one blessed folder. Drag-and-drop, multi-selection and a cut/copy/paste menu are what make that true. Things that are easy to break:

- **`dragDropEnabled: false`** in `tauri.conf.json`. On Windows the webview's native OS drag-drop handler swallows HTML5 drag events, so the flag is what makes any in-app dragging work at all (the outline's chapter reordering depends on it too). Turning it back on would silently kill both. Nothing listens for Tauri's OS file-drop events, so the flag costs nothing.
- **`src/lib/fs/moveCopy.ts`** holds the pure path decisions: `dropRejection(source, targetDir, mode)` — which both lights up the drop target and decides the outcome, so the highlight can't promise something the drop refuses — and `resolveCopyTarget`, which numbers a colliding copy as `名字 (1).md` (existing ` (n)` suffixes are replaced, not stacked).
- **`src/lib/fs/selection.ts`** holds the pure selection decisions, for the same reason: `flattenVisible` (the rows actually on screen, which is what a ⇧-range must walk — a range that reached into a collapsed folder would select entries the author cannot see), `rangeBetween`, `pruneSelection` (a selection outlives the gesture that acted on it — a move rewrites every selected path — so dead paths must drop out before they widen the *next* gesture), and `pruneNested`. `isDirOpen` lives here as the one definition of the expand default (top level open, deeper closed), so the rendered tree and the flattened one cannot disagree about which rows exist.
- **`pruneNested` is not an optimisation.** Selecting a folder *and* something inside it is one shift-click away, and transferring both would move the folder first, then look for a child at a path that no longer exists. The folder carries its contents, so the descendants are redundant — dropped before any transfer or delete runs.
- **The project root has no row of its own.** `read_dir_recursive` returns the project's *children*, so the root is reachable only through the tree container itself: its empty strip (`.tree`'s 40px bottom padding) is the root drop zone, its background clears the selection, and a root-level create renders its inline input there. Rows `stopPropagation` on dragover/drop precisely so a folder row always beats the container — otherwise the root would silently claim a drag aimed at a file. (Before this, the toolbar's 新建 buttons and the root context menu set `creatingIn` to the project path and nothing rendered: the inline input only existed inside a `TreeNode`.)
- **Move vs copy.** A move is `fs_rename` via `projectStore.moveEntry`, which refuses an occupied destination and keeps the open document pointed at the moved file. A copy is the `fs_copy` Rust command (recursive for folders) via `copyEntry`; it refuses a destination that already exists and a folder copied into its own subtree — that last check is duplicated in Rust because a recursive self-copy writes until the disk fills. Hold Ctrl/Alt while dropping to copy.
- **A copied document gets its own illustration folder** (`copyDocumentAssets`, the copy twin of `moveDocumentAssets`): links are relative and the `assets/<文档名>/` folder is named after the document, so without this a cross-folder copy had every picture broken, and a same-folder numbered copy silently *shared* the original's folder — which turned deleting the original into deleting the copy's pictures too (`discardDocumentAssets` takes the shared folder away with the backup). Folder copies never needed it: their asset dirs travel inside the folder. `copyEntry` also takes an optional `newName` (default: the source's name), which is what lets the agent's `copy_file` rename in the same step instead of costing a second approval card for the follow-up move.
- **The agent's move/copy/delete tools are these same store functions** (`lib/agent/proposalApply.ts`'s `applyProposal` calls `moveEntry`/`copyEntry`/`deleteEntry`, handed in by `agentStore` as `ProposalApplyDeps`), so asset follow-up, the editor's autosave flush and active-file repointing cannot diverge between an author's drag and an agent's card. The one agent-side extra: `move_chapter` defaults a bare destination to `.md` **only when the source is a manuscript file** — for any other file an extensionless destination is refused rather than silently rewritten (`数据.csv` moved to `数据` must not become `数据.md`).
- **Every transfer goes through one `transferMany`** in `FileTree.tsx`, shared by the drop gesture, the paste item and the root drop zone. It attempts *every* source and reports the failures together: one entry that cannot land (an occupied name, a folder dropped into itself) must not strand the rest of a multi-selection halfway. Entries that land become the new selection, so the next gesture acts on where they went rather than where they were.
- **`projectStore.clipboard` is a list**, and ⌘/Ctrl adds to the selection while ⇧ extends it (Ctrl is deliberately *not* the additive modifier on macOS — there it opens the context menu, and a click that both toggled the selection and raised a menu would leave the menu acting on a set the author never built). Right-clicking outside the selection retargets it to that one row, so 删除 5 项 can never appear over a row that isn't one of the five.

### `@` 引用的候选文件（与外部改动同步）

`@` 在聊天与三个知识库 AI 弹窗里给出的**文件**候选，来自 `projectStore.fileTree`——即侧栏那棵树——经 `projectFilesFromTree`（`lib/fs/images`）按扩展名分类，`useProjectFiles()` 是唯一入口。

- **为什么不再各扫各的**：原先每个界面在项目打开时各调一次 `scanProjectFiles(projectPath)`，自己存一份快照。之后新增的文件（agent 写的、Finder 里拷进来的）在侧栏看得见、`@` 里选不到，屏幕上没有任何东西解释这个差异。一棵树、一条刷新路径，这类不一致就没有藏身处。
- **哪些算文本**：`md` / `markdown` / `txt` / `html` / `htm`。`.html` 是交付物不是章节（`docs/feature/html-artifact-plan.md` D6，`isChapterFile` 不动），但**读**它没有任何理由排除——`search_text` 早就扫它（`isSearchableFile`），写这个页面的助手正是作者接着要它改页面的那个助手。图片候选另外还要模型链看得见图（`chainCanSeeImages`），否则挂上去的附件这条消息物理上带不走。
- **外部改动怎么进来**：`useExternalFileRefresh`（`src/useExternalFileRefresh.ts`）在**窗口重新获得焦点**时 `refreshFileTree()`，1.5s 内不重复。焦点正好是这件事的形状——作者去了文件管理器又回来。项目目录不上监听（插件的 `watch` 权限只给了设置打开时 `themeStore` 看两个主题文件夹，范围不含文件树）：对任意项目目录做 watch 是新的权限面，事件流最后还是要 UI 自己去抖，收益只有"应用在前台时别人改了文件"这一种边角情形。
- **不覆盖的**：知识库条目仍只在项目打开 / 写操作后扫（`loreStore.scanProject`）；外部直接往 `.ai-writer/lore/` 里塞条目仍需重开项目。
- **第二个入口——文件树右键「发送到助手」**：同一份分类（`classifyProjectFile`，`projectFilesFromTree` 的单文件形态）决定条目是否出现，同一条构造路（`lib/lore/aiTask` 的 `attachProjectFile`——读文本 / `imageForModel` 归一化 + 12MB 上限，`@` 选择也走它）产出同一种附件，挂进 `composerStore.chatRefs` 并照 `@` 的约定在草稿里落 `@[名字]`，然后打开抽屉的 chat 模式。刻意**不**在树上按 `chainCanSeeImages` 过滤图片：树不认识模型、作者发送前还能换模型，而 `buildChatMessage` 对读不了图的模型会点名附件并给出 vision 子代理的读法——降级是诚实的，不值得为它把 AI 配置耦合进文件树。
- **挑选与排序**（2026-09-26，设计稿 02i）：候选进了选择器之后，作用域、打分、截断都在 `lib/search/mentionSearch`——顶部一行 chip 把候选限到条目 / 文档 / 图片一类（Tab 切档，每次打开回「全部」），排序复用 ⌘K 的 `matchText`（名字 ×1 / 别名 ×0.9 / 分组路径 ×0.6 / 整条路径 ×0.5；分组与路径不认子序列；宿主只送一个词——空格结束提名，一个词可跨 `/`：`@潮汐门篇/第五`），空查询按类交错取十条。此前只 `includes`、不排序、只看名字、条目独占前十，是「文件和条目一多就找不到」的根因。理由与被否方案：`docs/feature/agent/mention-scope-ui-brief.md`。

### PPTX / XLSX (read and export)

Reading `.pptx` (import conversion + `read_slides` paging), HTML → PPTX export and markdown tables → XLSX export are each owned by one directory and one design doc: the code notes are in `codemap.md` → [`src/lib/pptx/`](codemap.md#srclibpptx), [`src/lib/xlsx/`](codemap.md#srclibxlsx), [`src/lib/import/`](codemap.md#srclibimport) and `src-tauri/` → Office 读写器; the decisions and their reasons are in [`pptx-plan.md`](../feature/pptx-plan.md) and [`xlsx-export-plan.md`](../feature/xlsx-export-plan.md). The CSP side of the harvester is under [Content Security Policy](#content-security-policy) below.

### Export / Import (lore bundles & config backup)
- **Lore bundle** (`src/lib/lore/transfer.ts`, UI in `LoreWall`): a zip with root `manifest.json` + the whole on-disk `.ai-writer/lore/` tree under `lore/…` — *all* categories on disk, not just the active profile's, so bundles survive profile switches. Import is two-phase: `stageLoreImport` extracts into `.ai-writer/lore-import-tmp` and reports conflicts; `applyLoreImport` moves entity dirs in under a user-chosen strategy (skip / overwrite / keep-both via `uniqueEntityId`), then deletes the staging dir. **Overwrite displaces rather than deletes**: the entity being replaced is renamed into `.ai-writer/backups/replaced-<ts>-<category>-<id>` (the same directory `delete_lore_entity` uses), and if the move-in then fails it is renamed back. The previous `removeDir`-then-`rename` both destroyed an entry — gallery images included — with no undo, and left a window where a failed rename lost the folder from both places. Categories that fail `CATEGORY_ID_RE` are ignored.
- **Project backup** (`src/lib/fs/projectBackup.ts`, UI in Settings → 工作台): the whole project folder as one zip under `project/…` + root `manifest.json` (`kind: "ai-writer-project-bundle"`). Scope is deliberately wider than the lore bundle — `profile.json`, `outline.json`, `.ai-writer/memory/`, `imagegen.json` and each document's `assets/` are all things *the model sees*, so a project missing them behaves differently with nothing on screen saying why. `PROJECT_BACKUP_EXCLUDES` drops `.ai-writer/backups`, the scratch/staging dirs, the SQLite `-wal`/`-shm` sidecars, `.git` and `node_modules`; `project.db` is WAL-checkpointed first (`PRAGMA wal_checkpoint(TRUNCATE)` via `select`, best-effort) so the single archived file is complete. Restore takes an **empty** folder picked through `project_open_dialog` (which is also what allows it as an fs root), and `zip_import_dialog` is given `requireManifestKind` so a wrong zip is refused before a single file is written. Not included: `config.db` and the keyring — those belong to the installation, and the UI says so.
- **Config backup** (`src/lib/ai/configTransfer.ts`, UI in Settings → General): providers/models/prompts, the **fee groups** (`feeGroups`) and the author's **排版格式 presets** (`docFormats`, `doc_format`) **plus the portable preferences** (see Preferences) as one JSON file, `version: 3` (v3 = prices moved from model rows into fee groups; a v2 bundle's legacy `price_*` fields are folded into groups on restore by the same `migrateModelPricesToFeeGroups` an upgraded machine runs, and a v2-only build refuses a v3 bundle whole). `prefs`, `feeGroups` and `docFormats` are optional, so a backup written before they were included still restores. Not included: `token_usage` and `learned_ceilings`. API keys (OS keyring) are **excluded unless the user opts in** — then embedded in plaintext and re-saved to the keyring on import. Restore merges by id (`INSERT OR REPLACE`); models whose provider is neither in the backup nor already configured are dropped during validation. The row writes go through `sqlTransaction` (see Transactions below), fee groups first, then providers before the models that reference them, then prompts; the fee-group migration, preferences, 排版格式 presets and keyring writes land after the commit, because neither can join a SQL transaction and a failure in them must not undo the configuration that already succeeded.

### 重置应用配置 (Settings → 通用 → 重置 · `src/lib/appReset.ts`)

Export / Import 的反面：把这台机器的配置清回刚装好的样子。

- **范围是装机级的，不是项目级的。** 清 `config.db` 的 `providers` / `models` / `prompts` / `fee_groups` / `doc_format` / `learned_ceilings`（连同内存里那份学到的降级）、**`config.db` 的 `token_usage`——跨项目的总用量账，重置后「全部」视图从零开始，无法找回**，`prefs` 里的全部偏好，以及钥匙串里这个应用存的密钥。**不碰**项目文件夹里的文档与知识库、`project.db` 的用量（「本项目」那本账）与对话记录，也不碰 `appDataDir/backups` 里拉取前的知识库压缩包——那些是安全网，装的正是重置无法再生成的东西。一个按钮不该同时意味着「配置回到出厂」和「几十万字没了」。
- **顺序：钥匙串先，数据库后。** `providers` 那几行是「钥匙串里有哪些账户」的唯一记录。先删行再删密钥，中间断了就留下一堆再也叫不出名字的密钥，永远清不掉；反过来断了只是「供应商还在、密钥没了」，重填一次即可。所以 `clearAllSecrets` 报回 `failed > 0` 时 `resetApp` 直接抛 `SecretWipeError`，数据库一行不动（和 `lib/sync` 的「安全网缺席的那次拉取正是不该开始的那次」同源）。`__tests__/appReset.test.ts` 钉住这条顺序。
- **确认框上的数字必须从真东西上数出来**（`collectResetInventory`）。「将清除全部配置」这句话在什么都没配过的机器上和配了十八个供应商的机器上一模一样，而两次按下去的后果完全不同。
- **两道门不是同一道来两遍。** 第一道给事实（清单 + 「不会动」+ 「先去导出一份」），第二道要手上的一个停顿——手打 `重置` / `RESET`。连点两次「确定」是一个动作，打四个字不是。
- **清完重载窗口。** 内存里的 store 和偏好缓存还停在旧值上，而重新走一遍 `main.tsx` 的启动（空 prefs → 引导页）恰好就是重置后该看到的样子。`clearAllPrefs` 因此是 `await` 的，也顺手扫掉 `localStorage` 里的副本——留着的话下次启动会被迁移回数据库，重置会自己撤销自己。
- **够不着的那一处**：钥匙串没有跨平台的「列出全部」。macOS 把所有密钥折进一个条目，清空那个条目就是清空全部；Windows / Linux 一个 id 一条凭据，只能删叫得出名字的那些（每个供应商 + `kbsync:<服务器>`）。作者勾过「记住密码」的配置备份密码（`cfgpwd:<服务器>:<档>`）叫不出名字——档的 id 只在连上服务器时才知道——那一条会留在钥匙串里，取消勾选或删掉那个档才会消失。为它连一次网络、或者为记住它再引入一份注册表，都比这条残留本身更贵。

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
- Built in `src/components/editor/CodeEditor.tsx` from individual packages (not the `basicSetup` bundle): `markdown({ base: markdownLanguage, codeLanguages: languages })` (GFM + fenced-code languages from `@codemirror/language-data`), `history()`, selection / cursor helpers, `highlightSelectionMatches()`, the app's own search panel (`themedSearch()`, `searchPanel.ts`), and a keymap of the AI-target, format, default, history and search bindings. No Vim mode
- Line wrapping via `EditorView.lineWrapping`; gutters hidden (`.cm-gutters { display: none }`), so no line numbers
- Theme: no bundled CodeMirror theme (`@codemirror/theme-one-dark` is a dependency but nothing in `src/` imports it). `syntaxHighlighting(manuscriptHighlight)` (`lib/editor/highlight`) emits class names only; the colours are `.tok-*` rules in the editor's CSS module, so both light and dark follow the design tokens

### Capabilities & Permissions
- `src-tauri/capabilities/default.json` — Explicit permissions for all Tauri plugins
- Must include: `sql:*`, `dialog:*`, and the narrow `fs` set (key storage uses custom `secret_*` commands, no plugin permission needed)
- The fs plugin is granted exactly `fs:default` (read access to the app-specific directories, plus creating them), `fs:allow-read-file`, `fs:allow-watch` and `fs:allow-unwatch` — no write, remove or `read-dir`. All writes/deletes and directory listing go through the audited custom `fs_*` Rust commands. `watch` / `unwatch` exist for one caller: `themeStore` watches the two themes folders (recursive, 300 ms debounce) while Settings is open, so an edited theme file reloads on its own.
- **Two path scopes exist, and they do not agree.** Projects can live anywhere on disk, so neither can be a static allowlist:
  - `src-tauri/src/scope.rs` (`FsScope`) guards every custom `fs_*` command. Roots are registered only from trusted sources (the Rust-side folder picker, or a recents entry with an on-disk `.ai-writer` marker). Containment is component-wise with `..` and symlinks resolved — no special case for dot-directories.
  - `tauri-plugin-fs`'s own scope guards the handful of **binary image reads** the frontend does directly (`src/lib/fs/images.ts`, `LoreDetail`/`LoreWall`, `lib/import`). `allow_for_plugin_fs` extends it to a registered root; dialog-picked files are auto-scoped by the dialog plugin for that session.
- **The plugin's scope is glob-based, and on unix a wildcard will not match a leading dot.** Its runtime scope is built from `FsScope::default()`, which means `require_literal_leading_dot: true` — so `<root>/**` covers `<root>/writing/…` but *not* `<root>/.ai-writer/…`, and the `requireLiteralLeadingDot` config knob cannot reach it (that value only feeds the per-call scope built from static capability entries). Since every generated picture lives under `.ai-writer/`, `allow_for_plugin_fs` grants `<root>/.ai-writer` a second time with the dot spelled out. Symptom when this is missing: `forbidden path: …` on image reads while documents load fine — see `docs/feature/image-generation-plan.md` §8. Adding another dot-directory the frontend must read means adding another grant; the durable fix is routing project-internal binary reads through the custom `fs_*` commands too.

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
- `connect-src` allows `https:`/`http:` because users configure arbitrary AI endpoints (incl. local LLMs like Ollama); `script-src` is `'self'` plus one `'sha256-…'` hash — the pptx harvester's inline script (`src/lib/pptx/harvester.js`; `pptxHarvesterCsp.test.ts` keeps the hash, the file and `htmlSlides.ts` in step)
- `img-src` includes the `ai-writer-asset:` custom scheme (and its `http://ai-writer-asset.localhost` Windows form) — only for legacy `ai-writer-asset://` links in old documents; current images are `data:` / `blob:` URLs
- `font-src` is `'self' data: ai-writer-font: http://ai-writer-font.localhost` — the `ai-writer-font:` scheme (`src-tauri/src/fontproto.rs`) serves downloaded font packs
- If a new subsystem breaks under CSP (e.g. a library injecting inline `<script>`), extend the directive minimally — don't set `csp` back to `null`
- `dangerousDisableAssetCspModification: ["style-src"]` is **load-bearing — do not remove.** At build time Tauri stamps a nonce onto every inline `<style>` in `index.html` (we have one: the boot splash) and appends `'nonce-…'` to `style-src` at runtime. Per CSP2+, a nonce in a directive makes `'unsafe-inline'` **ignored**, so every `<style>` injected later by JS gets blocked — CodeMirror's base theme (style-mod injects a plain `<style>`, losing `.cm-scroller { height: 100% }` → the editor renders but cannot scroll), plus KaTeX/mermaid inline `style="…"` attributes. Only ever visible in `tauri build`, never in `tauri dev`, since `devCsp` is `null`. The flag just tells Tauri to leave `style-src` alone; we already declare `'unsafe-inline'` ourselves, so the effective policy is unchanged.

## Performance Considerations

- **Editor debouncing** — `editorStore` uses `setTimeout` to auto-save on content change (not on every keystroke)
- **Lore scanning** — Full `lore/` tree walk per `loreStore.scanProject()`; triggered on project open, on a profile switch, after every in-app lore mutation, after every agent lore write, and on entering the lore wall. Scans are **serialized and coalesced** (see → The run's lore snapshot), so a burst costs one extra walk rather than one each
- **RAG caching** — Entity summaries cached in `loreStore.index` after first scan
- **Context assembly** — no fixed total cap: the layers are sized against the model's declared window by the budget planner (see → Context budget planner), after an output reserve, so a small model gets a small request and a 1M model isn't starved
