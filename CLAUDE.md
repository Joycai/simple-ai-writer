# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> [`AGENTS.md`](AGENTS.md) is this file's generated mirror — the entry point for agents that follow the `AGENTS.md` convention (Codex, Cursor, …), so they read the same map instead of a second copy that drifts. Edit here, then run `node scripts/gen-agents-md.ts`; `agentsMdSync.test.ts` fails while the mirror lags.

> **Progressive disclosure** — This file is the always-loaded high-level map: commands, the hard rules, the shape of the app, and where to read next. Per-directory notes (module split, invariants, why-not-the-other-way) live in [`docs/reference/codemap.md`](docs/reference/codemap.md); subsystem deep-dives, the UI/design spec and recipes are under `docs/` (see [Detailed References](#detailed-references)). **Keep this file lean: add new detail to `codemap.md` or the relevant `docs/` file, not here.**

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

**计费与用量**
- 价格只在**计费组**上（`lib/ai/feeGroup`），模型只持有 `feeGroupId`；算钱一律
  读 `Model.fee`（`configDb.feeOf`），模型行上的 `price_*` 旧列**只剩迁移在读**。
- 用量行**自带价格**：`recordUsage` 是唯一写入口，把当时的单价 / 数量 / 规格抄在
  行上。改组、删组、换组都动不了历史；删组只置空引用，不碰用量行。
- `costOf()` 是**全应用唯一的一份算式**。`cost_usd` 是它的结果落了盘，读那一侧
  `SUM` 它——不要在别处再算一遍。
- **「没有」与「零」分得开**：缓存价可空（空 = 同输入价，`0` = 真免费）、上游报价
  可空（空 = 没报，`0` = 上游说免费）、档位条件可空（空 = 匹配一切）。
- 一次请求**记两处**：项目 `.ai-writer/project.db` 与 appDataDir 的 `config.db`
  （多一列 `project`）。两张表的结构共用 `lib/ai/usageSchema.ts` 一处定义。

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

## Architecture Overview

### Three-Layer Stack
- **Frontend (React 19 + TypeScript + Vite)** — UI components, Zustand stores, markdown editor
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

## Project Structure

**Filesystem**
- `.ai-writer/project.db` — SQLite database (project-scoped; **本项目**用量在这里，跟着项目文件夹走)
- `.ai-writer/profile.json` — Enabled capability packs + user-defined categories (v3; v1/v2 still read; absent = novel)
- `.ai-writer/lore/<category>/<entity>/index.md` — Entity summary with frontmatter; facets and `collections:` beside it
- `.ai-writer/tasks/`, `tmp/`, `themes/`, `workflows/`, `roleplay/` — agent workspaces, conversion/ASR caches, project typography themes, workflow-card overrides, roleplay sessions + memory areas
- User documents — anywhere in the workspace root, freely organized

**Code** — **one line each, and it stays one line**; the per-directory notes (module split, invariants, why-not-the-other-way) are in [`docs/reference/codemap.md`](docs/reference/codemap.md), one section per directory.
- `src/components/layout/` — TitleBar, IconRail, Sidebar, ProjectRow, FileTree, RecentProjects, EditorArea, EditorBottomStrip, AiRail
- `src/components/editor/` — CodeMirror wrapper, `EditorToolbar` (icon-only and stateless on purpose), preview renderer + zoom
- `src/components/ai/` — AiPanel, AgentChat, the card family (approval / plan / question / round-limit / proposals), AgentLog, ConsistencyCheck, 提示词库
- `src/components/lore/` — browser, wall, read mode (R), `collections/`, facet / dict modals, generator
- `src/components/settings/` — full-window settings, one file per pane under `panes/`; 实验室 holds **every** Beta switch; the model drawer; 计费组列表与编辑抽屉
- `src/components/common/` — shared primitives (`Slider` is the app's one slider)
- `src/components/command/`, `onboarding/`, `library/`, `roleplay/`, `sync/` — palette + global search, onboarding, 文库, roleplay UI, sync modals
- `src/lib/ai/` — streaming client for four protocol families, `conn.ts`, JSON-mode / tool-choice shaping learned per endpoint, server-side tools, probing, output caps, drafts, snippets, 计费组 + 用量（`feeGroup` / `feeGroupDb` / `feeGroupLabel` / `usageSchema` / `usageRow` / `usage`）
- `src/lib/agent/` — runtime, registry, presets, events, tools, compaction / rewind / structured state, plan gate, write + edit tools, approved-proposal apply, `inspect_html`, subagents, handoff, packs
- `src/lib/lore/` — model, entity CRUD, collections + the 取材范围 fence (narrows *discovery* only), facets / slots, citations, gallery, generator
- `src/lib/profile/` — capability packs (model / resolve / file / active / store)
- `src/lib/context/` — RAG assembly, clock, doc focus, story memory, book spine, collection digests
- `src/lib/editor/` — the editing surface's pure logic + CodeMirror extensions: the explicit AI target range, markdown commands, `manuscriptHighlight`, landing flashes, split-view scroll linking, the preview zoom ladder
- `src/lib/batch/`, `src/lib/workflow/` — clause splitting; workflow cards (built-ins + project overrides)
- `src/lib/format/`, `src/lib/diff/`, `src/lib/search/` — paragraph tidying; the capped Myers diff behind approval cards; ⌘K global search
- `src/lib/sync/` — knowledge-base sync against `server/`: one direction, whole tree, no merge, every run through a three-way plan
- `src/lib/configsync/` — app-config backup to the sync server (encrypted whenever API keys ride along)
- `src/lib/consistency/` — 一致性检查 on the agent loop; windowing is code's, findings verified at record time
- `src/lib/fs/` — Tauri file I/O, markdown, images / `@` candidates, pptx reading, export, project backup, the sidebar's move/copy + selection logic
- `src/lib/theme/` — scheme, contract, validator, registry, install, export, typography themes
- `src/lib/image/` — document illustrations (`assets/<文档名>/`, relative links, relink repair), model-bound image reader, illustrate step
- `src/lib/import/` — docx / xlsx / pdf / pptx → markdown (+ extracted rasters), copy-as-is for txt/md/html/images, conversion cache, materialize
- Beta subsystems, each behind Settings → AI 配置 → 实验室 (`flag.ts`): `src/lib/comfy/` (ComfyUI image route), `pptx/` (HTML → PPTX), `xlsx/` (markdown tables → workbook), `docx/` (markdown → .docx), `roleplay/` (first-person scenes), `translate/` (Sakura 日中), `asr/` (千问 transcription), `cli/` (one shell command per approval card)
- `src/lib/` root — `project.ts`, `keyStore.ts`, `instance.ts`, `prefs.ts`, `appReset.ts`, `sqlTx.ts`, `notify.ts`, `http.ts`, `paths.ts`, `platform.ts`, `webviewCaps.ts`, `recentProjects.ts`, `shortcuts.ts` (the one registry every shortcut is listed in, dispatched or not), `staleRefs.ts`, `motion.ts`, `ime.ts`
- `src/stores/` — Zustand, one per concern: `app` · `project` · `editor` · `lore` · `ai` · `aiTask` · `agent` · `nav` · `batch` · `composer` · `memory` · `image` · `docFormat` · `sync` · `configSync` · `consistency` · `roleplay` · `theme` · `digest`, plus the non-store coordinators `configImportRefresh.ts` (what must be re-read after a config lands, **in that order**) · `projectLifecycle.ts` (the one way to open / close a project) · `openDocument.ts` · `toolAppState.ts`, and `agent/` (agentStore's private split)
- `src/styles/` (`tokens.css` + `global.css` — the five `@layer` cascade), `src/i18n/locales/` (en, zh-CN) — no `codemap.md` section on purpose; `design-system.md` and `terminology.md` cover them
- `src-tauri/` — Rust side: `commands` + `blocking` (every `fs_*` off the main thread) behind `scope`'s path fence, `protocol` (`ai-writer-asset:`), `secrets` (OS credential manager), `sqltx`, `transfer`, `lorehash`, `instance` + `windowmenu`, `preview` + `print`, the Office readers/writers `xlsx` / `xlsx_write` / `pptx` / `docx` (zip + XML stays here; markdown dialect stays in TS), `cmd` (`run_command`, deliberately not `tauri-plugin-shell`)
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
- **[`docs/feature/billing/01-fee-groups.md`](docs/feature/billing/01-fee-groups.md)** — 计费组与两本用量账：八条不变量、迁移为什么用 `fee_migrated`、备份 v3。Read before touching `src/lib/ai/feeGroup*`, `usageRow`, `usage`, or anything that prices a request.
- **[`docs/feature/docx/01-agent-design.md`](docs/feature/docx/01-agent-design.md)** — markdown → .docx: the invariants that shape it (the format is a reference not a parameter, three-source pure-function resolve, Beta off = the tool is absent from the run). Read before touching `src/lib/docx/`, `docFormatStore`, or `src-tauri/src/docx.rs`.
- **[`docs/feature/pptx-plan.md`](docs/feature/pptx-plan.md)** — .pptx read (Rust) and write (HTML → PPTX). Read before touching `src-tauri/src/pptx.rs`, `read_slides` or `src/lib/pptx/`.
- **[`docs/feature/knowledge-base/kb-admin-console.md`](docs/feature/knowledge-base/kb-admin-console.md)** — the server's admin console. Read before touching `server/src/config.rs`, `server/src/admin.rs` or `server/admin/*`.
- **[`docs/reference/macos-signing.md`](docs/reference/macos-signing.md)** (`planned`) — self-signed codesigning so updates stop re-asking for the login password. Read when cutting a macOS release, or when the Keychain starts prompting again.

## Testing & Type Safety

- TypeScript strict mode enabled (noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch)
- Frontend tests: Vitest (`pnpm test`) — one file per module in the **nearest** `__tests__/`: every `src/lib/<subsystem>/` has one, and the stores tests live in `src/stores/__tests__/`. `src/lib/__tests__/` is *not* the general test dir — it holds only what belongs to no subsystem: the root modules (`prefs`, `project`, `keyStore`, `shortcuts`, `paths`, …) and the repo-wide scanning guards, and `testPlacement.test.ts` gates that (a test whose **subject** is a subsystem module may not be added there; `vi.mock`-ing a subsystem does not make it the subject). Several are **source-scanning guards** (system-prompt seam, retired vocabulary, clock, tool budget ratchet, harvester CSP hash, test placement, layering and import cycles, CSS Module class refs) — when one fails, a Hard Rule above is what it is enforcing
- Rust tests: `cargo test` (from `src-tauri/`) — inline `mod tests` in `cmd.rs`, `commands.rs`, `docx.rs`, `instance.rs`, `lorehash.rs`, `pptx.rs`, `preview.rs`, `protocol.rs`, `scope.rs`, `secrets.rs`, `sqltx.rs`, `transfer.rs`, `xlsx.rs`, `xlsx_write.rs`
- CI gate on PRs to `main` runs frontend (type-check + vitest + build) and Rust (fmt/clippy/test/build) — see [`docs/reference/ci.md`](docs/reference/ci.md)

## 协作约定

- **分支从 `main` 切**，前缀 `feat/` · `fix/` · `chore/` · `docs/` · `refactor/`。**不叠 PR**：CI 的触发条件是 `pull_request: branches: [main]`，指向别的分支的 PR 一道门禁都拿不到。
- **commit message 是英文类型前缀 + 中文正文**（`fix: 收紧 shell 只读免审白名单并禁止复合命令连批`）。写改了什么、为什么这么改，不写文件清单。
- **版本号跟着功能 PR 一起走**，不单开 chore 分支。用 `bump-version` skill，别手改任何一处版本字符串——四份 Tauri 清单必须同步移动。
- **PR 由作者本人合并。** 做到「PR 已开、CI 已绿」为止就停。
- **决策落进文档，并写明理由。** commit message 和代码注释都不算——它们不在下次有人会去问的地方。理由写进 `docs/` 对应的那一份（`reference/` 活的真相 · `feature/` 子系统档案 · `issues/` 未决），新增文档在 `docs/README.md` 登记状态。改完 `CLAUDE.md` 记得 `node scripts/gen-agents-md.ts`。

## Local Skills

`.claude/skills/` (installed via `npx skills add`, tracked in `skills-lock.json` at the repo root):

- **`bump-version`** — moves the app version across all four Tauri manifests in lockstep. Use it instead of hand-editing any version string; they must move together or the running app reports a different version than the installer that shipped it.
- **`make-theme`** — a theme file (appearance tokens or `.md-body` typography, or a pair) from a description, a screenshot or a Typora theme. Ships a palette generator on the built-in lightness ramp, a checker that runs the app's own validator predicates, and a preview renderer (`previews.local/`). Written in this repo, not installed — so it is not in `skills-lock.json`.
- **`tauri`** — the router for everything Tauri v2. Start here; it points at the right sub-skill (`tauri-concept` / `-ipc` / `-config` / `-window` / `-build` / `-security` / `-framework-security` / `-development` / `-app-develop` / `-app-plugin-permissions`, plus one per plugin this project actually uses: `-app-opener` / `-app-dialog` / `-app-file-system` / `-app-http-client` / `-app-sql`).
