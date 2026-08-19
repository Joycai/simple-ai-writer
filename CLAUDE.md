# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Progressive disclosure** — This file is the always-loaded high-level map. Subsystem deep-dives, the UI/design spec, and step-by-step recipes live under `docs/` and are read on demand (see [Detailed References](#detailed-references)). Keep this file lean: add new detail to the relevant `docs/` file, not here.

## Commands

### Frontend Development
```bash
pnpm dev                 # Run Tauri dev server with hot reload (Vite on port 1420)
pnpm build              # Type-check + bundle frontend (tsc && vite build)
pnpm tsc --noEmit       # Type-check frontend without emitting
```

### Backend (Tauri/Rust)
```bash
pnpm tauri dev          # Start dev app (combines frontend + Rust build)
pnpm tauri build        # Create release binaries for current platform
cargo build             # Build Rust backend only (from src-tauri/)
cargo test              # Run Rust tests
```

### Full Build
```bash
pnpm install            # Install dependencies (pnpm required)
```

## Architecture Overview

### Three-Layer Stack
- **Frontend (React 19 + TypeScript + Vite)** — UI components, state management, markdown editor
- **Tauri v2 (Rust)** — IPC bridge, file system, database, OS-keyring secret storage
- **Backend Services (External APIs)** — OpenAI, Google Gemini, Anthropic Claude, or any OpenAI-compatible provider

### Layout ("Manuscript" aesthetic)
```
┌─────────────────────────────────────────────────────┐
│                    TitleBar                         │
├──────┬──────────────┬──────────────────┬────────────┤
│ Icon │   Sidebar    │   EditorArea     │   AiRail   │
│ Rail │ (resizable)  │   (flex: 1)      │ (resizable)│
│      ├──────────────┤ Editor | Preview │            │
│      │ FileTree /   ├──────────────────┤ AI tasks,  │
│      │ Lore panels  │ EditorBottomStrip│ streaming  │
└──────┴──────────────┴──────────────────┴────────────┘
```
Components in `src/components/layout/` (TitleBar, IconRail, Sidebar, FileTree, EditorArea, EditorBottomStrip, AiRail, ResizeHandle). Both side panels are resizable/collapsible.

### State Management (Zustand Stores)

All in `src/stores/`:
- **appStore** — Theme, language (i18n), sidebar/panel collapse state, active tabs. The persisted fields come from `lib/prefs` via `prefBackedState()`; `reloadFromPrefs()` re-derives and repaints them after a config import
- **projectStore** — Current project path, file tree, active file, word/char count
- **editorStore** — Editor content, dirty flag, view mode (editor/split/preview), save scheduling
- **loreStore** — Indexed lore entities, alias mapping, entity summaries; auto-scans `.ai-writer/lore/` on project open
- **aiStore** — Providers (API config), models (available LLMs), prompts (templates); API keys live in the OS credential manager (keyring) via the Rust `secret_*` commands — see `src/lib/keyStore.ts`
- **aiTaskStore** — Running AI task state, streaming output, token usage, abort signal
- **navStore** — Back / forward history (⌘[ ⌘] · Alt+←→ · mouse side buttons). A *location* = main view + open file + open lore entry; recorded by **observing** those stores, so no navigation call site registers anything. See `docs/architecture.md` → Navigation history
- **batchStore** — Batch clause runs (tasks with `batch: true`): sequential loop over `runTask`, one clause per run, results appended to an output file

### Data Flow: AI Writing Task

1. **User selection** → `aiTaskStore.setSelection()`
2. **Task trigger** → `aiTaskStore.runTask(taskId, customInstruction?)`
   - Resolves the task against the enabled packs (`findTask`) and branches on its declared `tools` / `target` / `continuation`, never on its id
   - Loads system prompt, calls `assembleContext()` (4-layer: system → lore → document → task), formats via `bundleToMessages()`
3. **Streaming** → `streamCompletion()` (SSE) — parses chunks into a `Draft`, extracts token counts/cost on final chunk. A run holds a **list** of drafts (`drafts` + `activeDraftId`); asking for several fans out into N parallel calls over the one assembled context — see `docs/architecture.md` → Multi-draft output
4. **Persist** → Writes one `token_usage` row per draft in SQLite
5. **Insert** → User clicks "Insert to Document" → `editorStore.setContent()` with the active draft

All AI features run on the **unified agent runtime** (`src/lib/agent/runtime.ts`): a per-preset tool loop dispatched via the tool registry (`registry.ts` — read tools, including `read_slides`, which pages a .pptx by slide because `read_file` can only return zip noise for one — see `docs/pptx-plan.md`; L1 auto+backup write tools for lore/memory, and the L2 manuscript tools that block on user approval — `propose_edit` for one unique find/replace, `rewrite_document` for a whole file, which is what makes document-wide formatting expressible at all). Lore writes are additionally gated on an author-approved plan (`plan.ts` + `propose_lore_plan` → `components/ai/PlanCard.tsx`): one card of steps per pass, and the write tools refuse any entity/action it doesn't cover. Runs emit structured `AgentEvent`s (`events.ts`) feeding the shared execution-log component (`components/ai/AgentLog.tsx`). Hitting the preset's round cap mid-work doesn't force-end the run: the runtime's `onRoundLimit` callback blocks on a 继续/收尾 card (`RoundLimitCard.tsx`, queued in agentStore like approvals) — wired only where that card can render (chat, AiPanel; not lore modals or batch runs, which keep the hard stop). The conversational assistant (AiDrawer "chat" mode → `components/ai/AgentChat.tsx`, session state in `stores/agentStore.ts`) and the AiPanel Agent mode both use the full-toolset `AGENT_ASSIST_PRESET`; structured JSON outputs go through `lib/agent/structured.ts` (forced tool_choice + JSON fallback). Design & history: `docs/unified-agent-plan.md`. AI-driven lore generation/improvement lives in `src/lib/lore/generator.ts` + `src/components/lore/`. Chat history is compacted, not just trimmed: folded/summarized old turns plus a per-turn injection ledger live in `lib/agent/compact.ts` + `compactRun.ts`, wired into `agentStore.sendChat`; design: `docs/chat-memory-plan.md`.

Long tasks persist to a durable workspace instead of just wire history: `.ai-writer/tasks/<taskId>/task.md` (goal + step checklist) and `notes/*.md` (intermediate results), written via scratchpad tools (`lib/agent/scratchpadTools.ts`) and resumed into a fresh context rather than replayed (`components/ai/TaskWorkspaceView.tsx`). Auxiliary work (web search, vision, long-document reads, image generation) can be delegated to per-kind subagents (`lib/agent/subagent.ts`, configured in Settings → `components/settings/panes/SubAgentsPane.tsx`, session-level toggles in `components/ai/SubAgentChips.tsx`) so it doesn't bloat the main run's context. Design: `docs/subagent-lld.md`.

> Details: RAG context assembly, SSE parsing, and DB schema are in `docs/architecture.md`.

### Workspace Packs (能力包)

The project is not hardcoded to novels — and not to one domain at a time. A project **enables zero or more capability packs** (`.ai-writer/profile.json` v3: `{enabled[], packs[], categories[]}`; v1/v2 files still read; absent = the built-in `novel` pack alone). Packs are **equal, purely additive toggles** — there is no primary pack: each pack (a `WorkspaceProfile` in `model.ts`) contributes knowledge-base categories and a **task list** (each task = a prompt + a tool set), and may reword the 【…】 prompt block labels *for its own tasks*. `resolveWorkspace(enabled, userCategories)` (`lib/profile/resolve.ts`) merges: categories = pack union + the project's **user-defined categories** (author-created, persisted in profile.json) + the always-present app-level `custom` bucket; tasks = the app-level base menu (`DEFAULT_TASKS`: 续写/润色/改写/总结/自定义/agent) + each pack's own, where a pack declaring a base id *overrides* that base task (first enabled pack wins — how novel keeps its fiction wording). Supporting another kind of writing (跑团模组, 文案, 周报…) is still a data addition, not new branches. Built-ins (`novel`, `ttrpg`, `copy`, `wechat`, `weekly`, `feedback`, `bid`) live in `src/lib/profile/model.ts`; toggling is Settings → 工作台 (`projectStore.setPacks`), custom categories via the lore wall's 「+ 新建分类」 or the same pane (`projectStore.setCustomCategories`).

The UI vocabulary is **app-level and uniform** (`appTerms`/`useTerms`: 文档/分组/知识库/条目 — every project's knowledge store is a 知识库), and so are the document model (always all-on; `useDocModel()` is the seam kept for a future per-project setting) and the system prompt (one neutral writing collaborator — packs do not preset the AI's persona; domain rules live in each pack task's *instruction*, e.g. `bidRespond` carries the deviation discipline). Never hardcode 章/卷/设定 in a component or an i18n value — pass `useTerms()` words into parametrized i18n strings. Prompt templates (`ai.instructions.*`) get the same words plus the 【…】 section labels via `promptParams(isZh, packId?)` — pass the running task's `packId` so a pack task speaks its own wording (【应答大纲】, not 【大纲/写作方向】); the resolution chain is task's pack → neutral defaults, and `knowledge` is never renamed. Keep shared instruction text neutral and give novel its own variant (base-task override with a `*Novel` key) when fiction wording matters.

Rules when touching this: components derive the task menu and categories from the subscribed `projectStore.workspace` (the `lib/profile/active` singleton isn't reactive); **never** resolve a system prompt with `ai.instructions.system` directly — call `profileSystemPrompt()` (the seam a per-project override would land in; a source-scanning test enforces this); resolve a task with `findTask()` and handle the null, because a task id can outlive the pack that defined it; and the merged accessors (`loreCategories()`, `profileTasks()`…) are the truth about what is enabled — read them at call time, never at module scope. Recipe: `docs/workflows.md` → Add a new capability pack.

### Project Structure

**Filesystem**
- `.ai-writer/project.db` — SQLite database (project-scoped)
- `.ai-writer/profile.json` — Enabled capability packs + user-defined categories (v3: `{enabled[], packs[], categories[]}`; v2's `primary` reads as "first enabled", a v1 single-profile file as that pack alone; absent = novel)
- User documents — anywhere in the workspace root, freely organized (older projects keep their `writing/` folder as an ordinary directory)
- `.ai-writer/lore/<category>/<entity>/index.md` — Entity summary with frontmatter (categories = the enabled packs' union + the project's user-defined ones + the always-present `custom` bucket; novel contributes characters, world, factions, items, skills, style)

**Code**
- `src/components/layout/` — Main layout structure (TitleBar, IconRail, Sidebar, FileTree, EditorArea, EditorBottomStrip, AiRail)
- `src/components/editor/` — CodeMirror wrapper, preview renderer
- `src/components/ai/` — AiPanel (task UI, streaming output), ConsistencyCheck
- `src/components/lore/` — Lore browser, LoreGenerator, LoreImproveModal, LoreWall, FacetEditModal + `ai/FacetAiAssistantModal` (AI-assisted facet splitting)
- `src/components/settings/` — SettingsPage: the full-window settings surface (shell + left nav) with one file per pane under `panes/`. Panes are built from the shared row/section/card/chip vocabulary in `settingsUi.module.css` + `panes/bits.tsx`; `settingsCommon.module.css` holds the form controls used inside the edit drawers. 供应商与模型 is a single merged pane (grouped list + right-hand drawer), and Prompt has a drawer of its own
- `src/components/command/`, `onboarding/`, `library/` — CommandPalette, onboarding flow, library view (文库: book-spine ordering + per-collection resources; see `docs/library-plan.md`)
- `src/lib/` — Core logic, grouped by domain:
  - `src/lib/ai/` — streaming client (`index.ts` dispatch, `openai.ts`/`gemini.ts`/`anthropic.ts` adapters, `types.ts`), the config→request seam (`conn.ts` — `ConnOptions` is **the one place** a provider/model transport field is declared; every arg type that carries provider wiring `extends` it, so a new field is one edit, not eighteen. See `docs/provider-layering.md`), per-protocol JSON-mode shaping (`jsonMode.ts`), server-side tools (`serverTools.ts` — tools the *endpoint* runs inside one request: `web_search`, spelled as Anthropic `tools[]` entries on MiniMax-M3 and as top-level `enable_search` on Qwen/DashScope `openai_compat`; nothing to execute locally, so they never enter the agent registry), provider config storage (`configDb.ts`), Gemini safety settings (`safety.ts`), remote probing (`providerProbe.ts`), endpoint limit probing (`endpointProbe.ts` HTTP + `probeAnalysis.ts` pure judgement — measures a model's real context window / output cap; see `docs/architecture.md` → Endpoint probing), per-reply output caps (`modelLimits.ts` — the built-in table + the app-wide default behind `effectiveMaxOutput`, the one resolver both the wire and the budget planner read; see `docs/architecture.md` → Large outputs), multi-draft output vocabulary (`drafts.ts`), token/cost accounting read side (`usage.ts` — the `token_usage` rollups behind Settings → 用量), `apiLog.ts`, `tokenEstimate.ts`
  - `src/lib/agent/` — unified agent runtime (`runtime.ts` loop, `registry.ts` tool registry, `presets.ts` per-task config, `events.ts` execution-log events, `tools.ts` handlers + path containment, `plan.ts` lore-plan gate, `writeTools.ts` L1/L2 write handlers, `splitTools.ts` the facet-split collector — the only tools that write nothing anywhere, existing purely so the split arrives as one tool call per facet instead of one hand-escaped JSON blob, `imageHistory.ts` the one definition of how a picture lives in — and leaves — the wire history; see `docs/architecture.md` → Images in context)
  - `src/lib/lore/` — lore domain model (`model.ts`), entity scan/CRUD (`entity.ts`), gallery/avatar (`gallery.ts`), AI generation (`generator.ts`), `[[lore:…]]` citation resolution/navigation (`citations.ts`), AI-assisted facet splitting (`splitter.ts`); import via `lib/lore` (index re-exports all but generator). Entities can be split into **facets** (sub-entity granularity — e.g. one outfit of several) so injection isn't all-or-nothing; layered-budget facet selection lives in `lib/context/loreSelect.ts`. See `docs/architecture.md` → Facet-aware lore selection; design: `docs/lore-facet-plan.md`
  - `src/lib/batch/` — clause splitting for batch runs (`clauses.ts`: heading/numbered mode detection)
  - `src/lib/consistency/` — 一致性检查: one structured pass over a document against the lore index (`scan.ts`, via `agent/structured.ts`) plus the quote-anchoring that turns a finding into working buttons (`model.ts` — `locateQuote` / `applySuggestions`). State in `stores/consistencyStore.ts`, UI in `components/ai/ConsistencyCheck.tsx`
  - `src/lib/pptx/` — HTML → PPTX（Settings → 通用 → 实验功能 的 Beta 开关，`flag.ts`）: the model keeps writing `.html` and the conversion runs **no model at all** — `harvest.ts` renders the page in an offscreen sandboxed iframe and `harvester.js` (injected `?raw`, answers by `postMessage`) reports what the browser measured, `deck.ts` is the pure layer (units, slide size, colours, pruning, text slack — where the tests are), `write.ts` calls pptxgenjs (lazy, own chunk). Entry points are the `export_pptx` L2 tool (converted in `applyProposal`, the only place with a DOM) and the `.html` preview toolbar. **Never add `allow-same-origin` to that frame** — see `docs/architecture.md` → HTML → PPTX 导出; design + rejected alternatives: `docs/pptx-plan.md` §4
  - `src/lib/profile/` — capability packs: what kinds of writing a project enables (`model.ts` pack types/built-ins/validation, `resolve.ts` multi-pack merge, `file.ts` profile.json v1/v2/v3 parsing, `active.ts` module singleton holding the merged `ResolvedWorkspace`, `store.ts` `.ai-writer/profile.json` IO). Drives the knowledge-base category layout (packs + user-defined + the `custom` bucket) and the per-pack-task 【…】 block labels. **Read `loreCategories()` at call time, never at module scope** — see `docs/architecture.md` → Capability packs
  - `src/lib/context/` — RAG assembly (`rag.ts`), the chat's current-document policy (`docFocus.ts` — describe the open file by default, inject its window only when the turn points at it), story memory (`memory.ts`), book spine (`outline.ts`), book-level continuation context (`bookContext.ts`), per-volume collection digests for the library view (`collectionDigest.ts` + `stores/digestStore.ts`; display-only, never task context)
  - `src/lib/fs/` — Tauri file I/O wrappers (`fileio.ts`), markdown render/frontmatter (`markdown.ts`), image/text file utils (`images.ts` — file-kind classification by extension, base64 data URLs, and `projectFilesFromTree`, the **one** source of the `@` picker's file candidates; it reads `projectStore.fileTree` rather than scanning the disk again, so a file added after the project opened is pickable as soon as the tree refreshes — see `docs/architecture.md` → `@` 引用的候选文件), presentation reading (`pptx.ts` — the two IPC hops onto `src-tauri/src/pptx.rs`; here rather than in `lib/import/` because a .pptx has **two** readers, the importer and the agent's paged `read_slides`), export (`export.ts`), whole-project backup/restore (`projectBackup.ts` — wider scope than the lore bundle on purpose; see `docs/architecture.md` → Export / Import), and the sidebar's two pure decision layers: `moveCopy.ts` (drop rejection, copy numbering) and `selection.ts` (visible-row flattening, ⇧-ranges, dropping nested/dead paths). The workspace is the whole project directory, so the tree is a file manager — multi-select, batch move/copy/delete, and a root that is reachable only through the tree container (it has no row of its own). See `docs/architecture.md` → Organising files
  - `src/lib/theme/` — Markdown typography themes (`markdownThemes.ts`): the `--md-*` CSS generated once and shared by the preview pane, lore previews and exported HTML/PDF. See `docs/design-system.md` → Markdown 排版主题
  - `src/lib/image/` — a document's illustrations: where they land and what links them (`assets.ts` — `assets/<文档名>/` beside the document, **relative** links, `saveDocumentAsset` for a generated picture / `importDocumentAsset` for one the author picked off disk, plus the move/delete follow-up that keeps links alive), and the approval→generate→file step (`illustrate.ts`). Generation itself runs through the `imagegen` subagent (bound model, `generate_image`/`edit_image` tools — not a delegate conversation), configured in `SubAgentsPane.tsx`; design: `docs/image-generation-plan.md`. Lore entities use `lib/lore/gallery.ts` instead — they own a folder, a document is one file
  - `src/lib/import/` — document import into the workspace: docx via mammoth+turndown (`docx.ts`/`markdown.ts`), xlsx via the Rust `xlsx_to_markdown` command (`xlsx.ts` → `src-tauri/src/xlsx.rs`, the only converter not in the webview — calamine reads cached formula results, real dates and merged ranges), PDF text extraction via lazy pdfjs (`pdf.ts`), pptx via the Rust `pptx_to_markdown` command (`lib/fs/pptx.ts` → `src-tauri/src/pptx.rs`), GBK-aware text decode (`text.ts`), dialog orchestration + naming (`index.ts`). Two dispositions, decided by extension (`importMode`): docx/xlsx/pdf/pptx **convert to markdown** because **no model API accepts those binaries** — they are zip archives; converting is not a shortcut, it is the only option. Legacy .doc/.xls/.ppt stay out on purpose — no converter here reads them faithfully, and .ppt is an OLE compound binary the zip reader cannot open at all. txt/md/html and images are **copied in as-is** (same name, same extension; only a non-UTF-8 text encoding is normalised) — the app already opens all of them, so rewriting them would only destroy information. The copy list is `lib/fs/images`'s own kinds, not a second list here
  - root: `project.ts`, `keyStore.ts`, `prefs.ts` (**every** app preference — theme, language, panel widths, model selections; backed by `config.db`, read synchronously from an in-memory cache that `main.tsx` hydrates *before* importing anything that reads one. Never add a `localStorage` call: add a key to `PREF_KEYS` instead — see `docs/architecture.md` → Preferences), `sqlTx.ts` (**the** way to run several writes as one transaction — the SQL plugin is a connection *pool*, so a hand-written `BEGIN`/`COMMIT` pair is not one transaction and deadlocks the pool; see `docs/architecture.md` → Transactions), `http.ts`, `paths.ts`, `platform.ts`
- `src/stores/` — Zustand state managers
- `src/styles/` — Design tokens (`tokens.css`) + global styles (`global.css`)
- `src/i18n/locales/` — JSON translation files (en, zh-CN)

## Detailed References

Load the relevant doc **before** working in that area — don't reconstruct it from scratch:

- **[`docs/api/`](docs/api/README.md)** — LLM API 对接知识库: the four wire-protocol families (OpenAI Chat Completions / OpenAI Responses / Google GenAI / Anthropic Messages), deployment variants, and the third-party "OpenAI-compatible" layer's real-world gaps. Protocol *facts* only — this project's choices live in `docs/*-plan.md` (`reasoning-plan` ① / `anthropic-plan` ④ / `gemini-plan` ③, all three implemented). **Read before touching `src/lib/ai/`**, and read its 「接一个新协议族时，先看这三条」 before adding a family or a vendor. Thinking support is implemented across all three families — as is MiniMax-M3's Anthropic endpoint (`anthropic-plan` §10: the `switch` thinking dialect, its forced-`tool_choice` downgrade, and server-side web search) — but all of it is **unverified against live endpoints**; the open checks are in [`docs/thinking-verification.md`](docs/thinking-verification.md).
- **[`docs/design-system.md`](docs/design-system.md)** — UI/visual spec & theming: design tokens, Apple-like aesthetic rules, animation/shadow/color/component patterns. **Read before building or restyling any UI.**
- **[`docs/architecture.md`](docs/architecture.md)** — Subsystem deep-dives: DB schema, RAG, SSE streaming, secure key storage, export, Tauri IPC, file I/O, CodeMirror, capabilities, performance.
- **[`docs/workflows.md`](docs/workflows.md)** — Recipes: add an AI task type / provider / language; modify lore format.
- **[`docs/pptx-plan.md`](docs/pptx-plan.md)** — .pptx 两端的设计：读（Rust 解析、按页分段、`.ppt` 为什么不做）和写（HTML → PPTX：为什么转换不经过模型、沙箱里怎么量、被否掉的四个方案、验证时抓到的三个 bug）。**改 `src-tauri/src/pptx.rs`、`read_slides` 或 `src/lib/pptx/` 前先读。**
- **[`docs/ci.md`](docs/ci.md)** — CI / PR quality gate: what the `CI` workflow checks (frontend type-check + build, Rust fmt/clippy/test/build), how to enforce it via branch protection, and how to run the same checks locally.

## Local Skills

`.claude/skills/` (tracked in `skills-lock.json`) holds Claude Code skills installed via `npx skills add`:

- **`bump-version`** — bump the app version across all four Tauri manifests in lockstep; use this instead of hand-editing version strings.
- **`tauri`** — router/index skill for Tauri v2 development; start here for anything Tauri-related, it points to the right sub-skill below.
- **`tauri-development`**, **`tauri-concept`**, **`tauri-ipc`**, **`tauri-config`**, **`tauri-window`**, **`tauri-app-develop`**, **`tauri-build`**, **`tauri-security`**, **`tauri-framework-security`**, **`tauri-app-plugin-permissions`** — Tauri v2 core/architecture/build/security guidance.
- **`tauri-app-opener`**, **`tauri-app-dialog`**, **`tauri-app-file-system`**, **`tauri-app-http-client`**, **`tauri-app-sql`** — guidance for the specific Tauri plugins this project uses (`tauri-plugin-opener`/`-dialog`/`-fs`/`-http`/`-sql` in `src-tauri/Cargo.toml`).

## Testing & Type Safety

- TypeScript strict mode enabled (noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch)
- Frontend tests: Vitest (`pnpm test`) — regression/unit tests under `src/lib/__tests__/` and `src/lib/agent/__tests__/`, covering wire-protocol parsing, the agent tool runtime, capability-pack resolution, RAG assembly, and other `lib/` logic; one file per module, not a single smoke-test set
- Rust tests: `cargo test` (from `src-tauri/`) — unit tests live inline in `commands.rs`, `protocol.rs`, `scope.rs`, `secrets.rs`, `transfer.rs`, and `xlsx.rs`
- Frontend type-checks via `pnpm tsc --noEmit`
- CI gate on PRs to `main` runs frontend (type-check + vitest + build) and Rust (fmt/clippy/test/build) — see [`docs/ci.md`](docs/ci.md)
