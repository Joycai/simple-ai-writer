# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Progressive disclosure** — This file is the always-loaded high-level map: commands, the shape of the app, the hard rules, and where to read next. Per-directory notes (module split, invariants, why-not-the-other-way) live in [`docs/reference/codemap.md`](docs/reference/codemap.md); subsystem deep-dives, the UI/design spec and recipes are under `docs/` (see [Detailed References](#detailed-references)). **Keep this file lean: add new detail to `codemap.md` or the relevant `docs/` file, not here.**

## Commands

```bash
pnpm install            # Dependencies (pnpm only — the lockfile is pnpm's)
pnpm tauri dev          # The app: Rust backend + webview, hot reload. This is the dev loop
pnpm dev                # Vite alone on :1420 — UI in a browser, no Tauri IPC, so files / DB / keyring all fail
pnpm test               # Vitest
pnpm exec tsc --noEmit  # Type-check — this project's lint gate (strict, no unused locals/params)
pnpm build              # tsc && vite build
pnpm tauri build        # Release binaries for the current platform
```
From `src-tauri/` (and again in `server/`, its own crate): `cargo fmt --all -- --check` · `cargo clippy --all-targets --all-features -- -D warnings` · `cargo test --all-features` · `cargo build`.

The merge gate runs exactly these — [`docs/reference/ci.md`](docs/reference/ci.md) has the copy-paste local run.

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
- **appStore** — Theme, language (i18n), sidebar/panel collapse state, active tabs. Persisted fields come from `lib/prefs` via `prefBackedState()`; `reloadFromPrefs()` re-derives them after a config import
- **projectStore** — Current project path, file tree, active file, word/char count, the resolved `workspace` (enabled packs)
- **editorStore** — Editor content, dirty flag, view mode (editor/split/preview), save scheduling
- **loreStore** — Indexed lore entities, alias mapping, entity summaries; auto-scans `.ai-writer/lore/` on project open
- **aiStore** — Providers, models, prompts; API keys live in the OS keyring via the Rust `secret_*` commands (`src/lib/keyStore.ts`)
- **aiTaskStore** — Running AI task state, streaming output, token usage, abort signal
- **agentStore** — Chat sessions (several at once), approval / plan / question cards, run queue
- **navStore** — Back / forward history, recorded by *observing* the other stores — no call site registers anything
- **batchStore** — Batch clause runs (`batch: true` tasks): sequential loop over `runTask`, results appended to an output file
- **composerStore** — what the author typed but hasn't sent. Per-session, never persisted: the AI drawer unmounts on close, and a half-written instruction belongs to the author, not to the surface showing it
- **memoryStore** — per-document story memory segments (`lib/context/memory`): coverage, freshness, the summarizing run
- **imageStore** — one conversational image session; the turn chain is a **tree, not a line**, and which provider path ran is recorded per turn
- **docFormatStore** — .docx 排版格式 presets. Install-level, not project-level (built-ins in code, author's in `config.db`, one read from a .docx lives only for the session)
- **syncStore** — knowledge-base sync: connection, binding, plan→run. **A direction is never executed without a plan the author has seen** — there is deliberately no "sync now"
- **roleplayStore**, **consistencyStore**, **configSyncStore**, **themeStore**, **digestStore** — one per Beta / subsystem; see their `lib/` directory in `codemap.md`

### Data Flow: AI Writing Task

1. **User selection** → `aiTaskStore.setSelection()`
2. **Task trigger** → `aiTaskStore.runTask(taskId, customInstruction?)` — resolves the task against the enabled packs (`findTask`) and branches on its declared `tools` / `target` / `continuation`, **never on its id**; builds context via `assembleContext()` (system → lore → document → task)
3. **Streaming** → `streamCompletion()` (SSE) — a run holds a **list** of drafts; asking for several fans out into N parallel calls over one assembled context
4. **Persist** → one `token_usage` row per draft in SQLite
5. **Insert** → "Insert to Document" → `editorStore.setContent()` with the active draft

Every AI feature runs on the **unified agent runtime** (`src/lib/agent/runtime.ts`): a per-preset tool loop over the registry — read tools, L1 auto+backup write tools (lore / memory), and L2 manuscript tools (`propose_edit` · `rewrite_lines` · `rewrite_document` · `export_pptx` / `export_xlsx` · `convert_document` · `transcribe_audio`) that block on an author-approved proposal card. Lore writes are further gated on an approved **plan** (`plan.ts`). Runs emit `AgentEvent`s into the shared execution log. The chat assistant (`AgentChat.tsx` + `agentStore`) and the AiPanel Agent mode share `AGENT_ASSIST_PRESET`; every mid-run card (round-limit 继续/收尾, `ask_author`, writer handoff) is wired **only** on surfaces that can render it — `routeTools` decides per surface. Long tasks persist to `.ai-writer/tasks/<id>/` and are resumed, not replayed; auxiliary work goes to per-kind subagents; chat history is compacted (`compact.ts`), can be rewound to a turn (`rewind.ts`), or run on structured state behind the 状态记忆 Beta.

> Full picture (multi-chat model, orchestrator pack mode, writer handoff, compaction / rewind / state invariants): `codemap.md` → AI 运行时. RAG assembly, SSE parsing and DB schema: `docs/reference/architecture.md`. Designs: `docs/feature/agent/`.

### Workspace Packs (能力包)

The project is not hardcoded to novels. A project **enables zero or more capability packs** (`.ai-writer/profile.json` v3 `{enabled[], packs[], categories[]}`; absent = the built-in `novel` pack). Packs are **equal, purely additive toggles** — no primary pack: each contributes knowledge-base categories and a **task list** (prompt + tool tier `none` / `read` / `write` / `full` via `presetForTools`). **Prefer `write` over `full`**: the `full` schema alone can eat a 32k local model's whole input (`contextForecast.test.ts` pins this). Built-ins (`novel`, `ttrpg`, `copy`, `wechat`, `weekly`, `feedback`, `bid`) live in `src/lib/profile/model.ts`; supporting another kind of writing is a data addition, not new branches.

The UI vocabulary is **app-level and uniform** (`useTerms()`: 文档/分组/知识库/条目; word list in `docs/reference/terminology.md`), and so are the document model and the neutral system prompt — packs never preset a persona; domain rules live in each pack task's instruction. Prompt templates get the words and 【…】 labels via `promptParams(isZh, packId?)` — pass the running task's `packId`.

> Merge rules, the 【…】 label chain, user-defined categories: `codemap.md` → 能力包. Recipe: `docs/reference/workflows.md` → Add a new capability pack.

## Hard Rules

Things that are silent when broken, or that a source-scanning test enforces. Each has its reasoning in `codemap.md` or the doc named.

**Packs & vocabulary**
- Resolve the system prompt only through `profileSystemPrompt()` — never `ai.instructions.system` (test-enforced). Resolve tasks with `findTask()` and handle the null; a task id can outlive its pack.
- Read `loreCategories()` / `profileTasks()` **at call time, never at module scope**; components subscribe to `projectStore.workspace` (the `lib/profile/active` singleton isn't reactive).
- Never hardcode 章/卷/设定 in a component or an i18n value — pass `useTerms()` words into parametrized strings. Don't write 「设定」「词条」「主词条」「前情记忆」「前情摘要」「思维链」「底稿」「图像生成」「生成插图」「修改插图」 — the retired set, held shut by `localeTerms.test.ts` (it scans locale values *and* the `defaultValue` literals in components; `docs/reference/terminology.md` §3 says which word won).

**Storage & state**
- Every preference goes through `lib/prefs.ts` `PREF_KEYS`. **Never add a `localStorage` call.**
- Several writes as one transaction = `lib/sqlTx.ts`. A hand-written `BEGIN`/`COMMIT` is not one transaction on the pool and deadlocks it.
- `appReset`: keyring before database — the `providers` rows are the only record of which keyring accounts exist.

**Providers & models**
- A provider/model transport field is declared **once**, in `ConnOptions` (`lib/ai/conn.ts`); per-request knobs that vary between retries (`top_p`, `frequency_penalty`) live in `StreamOptions` instead. See `docs/api/provider-layering.md`.
- Models flagged `translateFormat` / `asrFormat` **never appear in any conversational picker** (`conversationalModels` is the invariant's name). Translate, ASR, image generation are tool-shaped subagents: in `SUBAGENT_KINDS`, not `DELEGATE_KINDS`.
- Read `docs/api/` before touching `src/lib/ai/`; read `docs/reference/tool-presence.md` + `docs/feature/agent/agent-tool-context.md` before adding a tool to a preset or a branch to `routeTools` — `agentToolBudget.test.ts`'s ratchet is not a broken test.

**Agent & context**
- Every new `role: "system"` builder decides about the clock and passes `currentTime.test.ts`'s source guard; the time is a line, not a tool, and is stamped on the chat's *current turn*, never `history[0]`.
- Which image reader a call site wants is decided by where the bytes end up: `imageForModel` for the wire, `imageToDataUrl` for rendering, `readImageBytes` for disk. Getting it wrong is silent in both directions.
- Nothing is paid for before the author nods: the `transcribe_audio` card sits **before** the billed step (unlike `convert_document`, which converts at proposal time), and `autoApprove` never passes it.
- Import and conversion **never touch the source file**; the agent's `read_document` writes only to the `.ai-writer/tmp/convert/` cache.

**Roleplay (Beta)**
- The binding block is its own prelude message — **never merged into the seed block** (compaction drops only `meta.seedContext`).
- The 记忆区 is **never merged into `loreIndex`**; the roleplay preset has no scene tools by construction.
- Anything author-editable that lands in `history[0]` must also enter `contextSignature`, or the "设定已更新" hint never lights.

**Export & theming**
- `src/lib/pptx/harvester.js`: **never** add `allow-same-origin` to the sandbox frame, and never edit it without updating **both** the `sha256-` in `tauri.conf.json`'s `script-src` and `htmlSlides.ts`'s selector list (`pptxHarvesterCsp.test.ts`).
- xlsx export: a cell that can't be typed with certainty stays text — mis-typing text as a number is silent data loss.
- docx export: the model writes **markdown only** — **the format is a reference, not a parameter**, resolved by pure functions from three sources (`lib/docx/resolve`). Nothing about the layout goes through a model (`docs/feature/docx/01-agent-design.md`).
- `lib/theme/scheme.ts` is the **only** writer of `data-theme` / `data-scheme`. A refused theme rule carries a `ThemeReasonCode`; the sentences live only in the locale files, in both languages.

## Project Structure

**Filesystem**
- `.ai-writer/project.db` — SQLite database (project-scoped)
- `.ai-writer/profile.json` — Enabled capability packs + user-defined categories (v3; v1/v2 still read; absent = novel)
- `.ai-writer/lore/<category>/<entity>/index.md` — Entity summary with frontmatter; facets and `collections:` beside it
- `.ai-writer/tasks/`, `tmp/`, `themes/`, `workflows/`, `roleplay/` — agent workspaces, conversion/ASR caches, project typography themes, workflow-card overrides, roleplay sessions + memory areas
- User documents — anywhere in the workspace root, freely organized

**Code** — one line each; the per-directory notes are in [`docs/reference/codemap.md`](docs/reference/codemap.md).
- `src/components/layout/` — TitleBar, IconRail, Sidebar, ProjectRow, FileTree (设计稿 01b), RecentProjects, EditorArea, EditorBottomStrip, AiRail
- `src/components/editor/` — CodeMirror wrapper, `EditorToolbar` (icon-only and stateless on purpose), preview renderer + zoom
- `src/components/ai/` — AiPanel, AgentChat, the card family (approval / plan / question / round-limit / proposals), AgentLog, ConsistencyCheck, 提示词库
- `src/components/lore/` — browser, wall, read mode (R), `collections/` (分类用颜色，集合用装订), facet / dict modals, generator
- `src/components/settings/` — full-window settings, one file per pane under `panes/`; 实验室 holds **every** Beta switch; 工作台 · 上下文与记忆 · 子代理 · 用量 · 排版格式 · 同步与备份; the model drawer (设计稿 05c: unset = dashed edge)
- `src/components/common/` — shared primitives (`Slider` is the app's one slider)
- `src/components/command/`, `onboarding/`, `library/`, `roleplay/`, `sync/` — palette + global search, onboarding, 文库, roleplay UI, sync modals
- `src/lib/ai/` — streaming client for four protocol families, `conn.ts`, JSON-mode / tool-choice shaping learned per endpoint, server-side tools, probing, output caps, drafts, snippets, usage
- `src/lib/agent/` — runtime, registry, presets, events, tools, compaction / rewind / structured state, plan gate, write + edit tools, `inspect_html`, subagents, handoff, packs
- `src/lib/lore/` — model, entity CRUD, collections + the 取材范围 fence (narrows *discovery* only), facets / slots, citations, gallery, generator
- `src/lib/profile/` — capability packs (model / resolve / file / active / store)
- `src/lib/context/` — RAG assembly, clock, doc focus, story memory, book spine, collection digests
- `src/lib/batch/`, `src/lib/workflow/` — clause splitting; workflow cards (built-ins + project overrides, two-level disclosure)
- Beta subsystems, each behind Settings → AI 配置 → 实验室 (`flag.ts`): `src/lib/comfy/` (ComfyUI image route), `pptx/` (HTML → PPTX, no model in the loop), `xlsx/` (markdown tables → workbook), `docx/` (markdown → .docx; 版面全来自 `DocFormat`, no model in the loop), `roleplay/` (first-person scenes, narrator, character memory), `translate/` (Sakura 日中), `asr/` (千问 audio transcription), `cli/` (one shell command per approval card; PowerShell on Windows, `$SHELL` elsewhere)
- `src/lib/editor/` — the editing surface's pure logic + CodeMirror extensions: the explicit AI target range (mapped through edits, not a DOM selection), markdown commands for both CodeMirror and plain textareas, `manuscriptHighlight` (class names only, so a theme can reach the editor), insert / caret landing flashes, split-view scroll linking **by source line**, the preview zoom ladder
- `src/lib/format/`, `src/lib/diff/`, `src/lib/search/` — paragraph tidying (the mechanical half of "give this document shape"; guesses toward doing nothing); the capped Myers diff behind approval cards; ⌘K global search (substring > prefix > subsequence, and subsequence **only** on names)
- `src/lib/sync/` — knowledge-base sync against `server/`: one direction, whole tree, no merge, and every run goes through a **three-way plan** (local × remote × last-sync snapshot) because comparing two sides cannot say *who moved*
- `src/lib/consistency/` — 一致性检查 on the agent loop; windowing is code's, findings verified at record time
- `src/lib/configsync/` — app-config backup to the sync server (encrypted whenever API keys ride along)
- `src/lib/fs/` — Tauri file I/O, markdown, images / `@` candidates, pptx reading, export, project backup, the sidebar's move/copy + selection logic
- `src/lib/theme/` — scheme, contract, validator, registry, install, export, typography themes
- `src/lib/image/` — document illustrations (`assets/<文档名>/`, relative links, relink repair), model-bound image reader (downscale instead of refuse), illustrate step
- `src/lib/import/` — docx / xlsx / pdf / pptx → markdown (+ extracted rasters), copy-as-is for txt/md/html/images, conversion cache, materialize
- `src/lib/` root — `project.ts`, `keyStore.ts`, `instance.ts` (multi-instance), `prefs.ts`, `appReset.ts`, `sqlTx.ts`, `notify.ts`, `http.ts`, `paths.ts`, `platform.ts`, `webviewCaps.ts`, `recentProjects.ts` (the pin set + the multi-instance merge), `shortcuts.ts` (the one registry every shortcut is listed in, dispatched or not), `staleRefs.ts` (清理失效数据 — what the app stored about files that are no longer there), `motion.ts`
- `src/stores/` (one paragraph each under [State Management](#state-management-zustand-stores) above), `src/styles/` (`tokens.css` + `global.css` — the five `@layer` cascade), `src/i18n/locales/` (en, zh-CN) — these three have no `codemap.md` section on purpose; `design-system.md` and `terminology.md` cover the latter two
- `src-tauri/` — Rust side: `commands` + `blocking` (every `fs_*` off the main thread) behind `scope`'s path fence, `protocol` (`ai-writer-asset:`), `secrets` (OS credential manager), `sqltx` (one transaction on one connection), `transfer` (zip bundles + config backup, dialogs Rust-side), `lorehash` (an entry directory → one digest, the sync wire format), `instance` + `windowmenu` (multi-instance), `preview` + `print`, and the Office readers/writers `xlsx` / `xlsx_write` / `pptx` / `docx` (zip + XML stays here; markdown dialect stays in TS), `cmd` (`run_command`, deliberately not `tauri-plugin-shell`)
- `server/` — **not part of the app**: a standalone Rust/axum binary for knowledge-base sync (`/v1/kbs`), app-config backups (`/v1/configs`, stored encrypted) and an admin console (`/admin`); own crate, CI job, `server/README.md` + `server/DEPLOY.md`

## Detailed References

`docs/` is grouped by **type** (`reference/` living truth · `api/` wire protocols · `feature/` per-subsystem dossiers · `issues/` open and unconfirmed); **status is a field inside each doc**, never a folder, because ~90 source comments cite these paths. [`docs/README.md`](docs/README.md) is the index with every doc's status.

Load the relevant doc **before** working in that area — don't reconstruct it from scratch:

- **[`docs/reference/codemap.md`](docs/reference/codemap.md)** — the per-directory notes that used to live here. **Read the section for any directory before changing it.**
- **[`docs/reference/architecture.md`](docs/reference/architecture.md)** — subsystem deep-dives: DB schema, prefs, multi-instance, RAG, facet selection, budget planner, endpoint probing, streaming, key storage, images in context, file organising, pptx / xlsx export, transactions, CSP.
- **[`docs/reference/design-system.md`](docs/reference/design-system.md)** — UI/visual spec & theming. **Read before building or restyling any UI.**
- **[`docs/reference/terminology.md`](docs/reference/terminology.md)** — 词表与措辞校准. **Read before writing any author-facing string.**
- **[`docs/reference/tool-presence.md`](docs/reference/tool-presence.md)** — 工具在场性契约: a run's words must match what it can do. Read before touching presets, `routeTools`, subagent kinds, or any tool description / result text.
- **[`docs/reference/workflows.md`](docs/reference/workflows.md)** — recipes: add an AI task type / provider / language / capability pack; modify lore format.
- **[`docs/reference/ci.md`](docs/reference/ci.md)** — what the merge gate runs and how to run it locally.
- **[`docs/api/`](docs/api/README.md)** — the four wire-protocol families and the "OpenAI-compatible" layer's real gaps. **Read before touching `src/lib/ai/`**; thinking support is implemented but unverified live (`docs/issues/thinking-verification.md`).
- **[`docs/feature/agent/agent-tool-context.md`](docs/feature/agent/agent-tool-context.md)** + [`-lld.md`](docs/feature/agent/agent-tool-context-lld.md) — the per-round fixed-header cost account. Read before adding a tool to `AGENT_ASSIST_PRESET`, changing `ai.instructions.agent`, or touching `trimHistory` / `planFold` ceilings.
- **[`docs/feature/lore/lore-entry-type-plan.md`](docs/feature/lore/lore-entry-type-plan.md)** — the entry type system (slots as a category's schema; the three invariants that let entries degrade rather than vanish). Read before changing `ProfileCategory`, facet frontmatter or `scanLore`'s category enum.
- **[`docs/feature/roleplay/`](docs/feature/roleplay/README.md)** — roleplay design, transcript / context layering, memory (`10-memory-system.html`), transitions. Read before touching `src/lib/roleplay/`, `roleplayStore`, `lib/roleplay/context.ts`, `memory.ts`, or `compact.ts`'s ceiling.
- **[`docs/feature/translate/`](docs/feature/translate/01-execution-plan.md)** — Sakura 日中翻译: twelve live measurements and six invariants. Read before touching `src/lib/translate/`, `SUBAGENT_KINDS`, or any model picker.
- **[`docs/feature/docx/01-agent-design.md`](docs/feature/docx/01-agent-design.md)** — markdown → .docx: the invariants that shape it (the format is a reference not a parameter, three-source pure-function resolve, Beta off = the tool is absent from the run). Read before touching `src/lib/docx/`, `docFormatStore`, or `src-tauri/src/docx.rs`.
- **[`docs/feature/pptx-plan.md`](docs/feature/pptx-plan.md)** — .pptx read (Rust) and write (HTML → PPTX). Read before touching `src-tauri/src/pptx.rs`, `read_slides` or `src/lib/pptx/`.
- **[`docs/feature/knowledge-base/kb-admin-console.md`](docs/feature/knowledge-base/kb-admin-console.md)** — the server's admin console. Read before touching `server/src/config.rs`, `server/src/admin.rs` or `server/admin/*`.
- **[`docs/reference/macos-signing.md`](docs/reference/macos-signing.md)** (`planned`) — self-signed codesigning so updates stop re-asking for the login password. Read when cutting a macOS release, or when the Keychain starts prompting again.

## Local Skills

`.claude/skills/` (installed via `npx skills add`, tracked in `skills-lock.json` at the repo root):

- **`bump-version`** — moves the app version across all four Tauri manifests in lockstep. Use it instead of hand-editing any version string; they must move together or the running app reports a different version than the installer that shipped it.
- **`tauri`** — the router for everything Tauri v2. Start here; it points at the right sub-skill (`tauri-concept` / `-ipc` / `-config` / `-window` / `-build` / `-security` / `-framework-security` / `-development` / `-app-develop` / `-app-plugin-permissions`, plus one per plugin this project actually uses: `-app-opener` / `-app-dialog` / `-app-file-system` / `-app-http-client` / `-app-sql`).

## Testing & Type Safety

- TypeScript strict mode enabled (noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch)
- Frontend tests: Vitest (`pnpm test`) — one file per module in the nearest `__tests__/`: `src/lib/__tests__/` and `src/lib/agent/__tests__/` plus a per-subsystem one under `asr/`, `cli/`, `comfy/`, `docx/`, `roleplay/`, `translate/`, `workflow/`, `xlsx/`. Several are **source-scanning guards** (system-prompt seam, retired vocabulary, clock, tool budget ratchet, harvester CSP hash) — when one fails, a Hard Rule above is what it is enforcing
- Rust tests: `cargo test` (from `src-tauri/`) — inline `mod tests` in `cmd.rs`, `commands.rs`, `docx.rs`, `instance.rs`, `lorehash.rs`, `pptx.rs`, `preview.rs`, `protocol.rs`, `scope.rs`, `secrets.rs`, `sqltx.rs`, `transfer.rs`, `xlsx.rs`, `xlsx_write.rs`
- CI gate on PRs to `main` runs frontend (type-check + vitest + build) and Rust (fmt/clippy/test/build) — see [`docs/reference/ci.md`](docs/reference/ci.md)
