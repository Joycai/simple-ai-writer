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
- **Backend Services (External APIs)** — OpenAI, Google Gemini, or any OpenAI-compatible provider

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
- **appStore** — Theme, language (i18n), sidebar/panel collapse state, active tabs
- **projectStore** — Current project path, file tree, active file, word/char count
- **editorStore** — Editor content, dirty flag, view mode (editor/split/preview), save scheduling
- **loreStore** — Indexed lore entities, alias mapping, entity summaries; auto-scans `.ai-writer/lore/` on project open
- **aiStore** — Providers (API config), models (available LLMs), prompts (templates); API keys live in the OS credential manager (keyring) via the Rust `secret_*` commands — see `src/lib/keyStore.ts`
- **aiTaskStore** — Running AI task state, streaming output, token usage, abort signal
- **batchStore** — Batch clause runs (tasks with `batch: true`): sequential loop over `runTask`, one clause per run, results appended to an output file

### Data Flow: AI Writing Task

1. **User selection** → `aiTaskStore.setSelection()`
2. **Task trigger** → `aiTaskStore.runTask(taskId, customInstruction?)`
   - Resolves the task against the active profile (`findTask`) and branches on its declared `tools` / `target` / `continuation`, never on its id
   - Loads system prompt, calls `assembleContext()` (4-layer: system → lore → document → task), formats via `bundleToMessages()`
3. **Streaming** → `streamCompletion()` (SSE) — parses chunks into a `Draft`, extracts token counts/cost on final chunk. A run holds a **list** of drafts (`drafts` + `activeDraftId`); asking for several fans out into N parallel calls over the one assembled context — see `docs/architecture.md` → Multi-draft output
4. **Persist** → Writes one `token_usage` row per draft in SQLite
5. **Insert** → User clicks "Insert to Document" → `editorStore.setContent()` with the active draft

All AI features run on the **unified agent runtime** (`src/lib/agent/runtime.ts`): a per-preset tool loop dispatched via the tool registry (`registry.ts` — read tools, L1 auto+backup write tools for lore/memory, and the L2 `propose_edit` that blocks on user approval). Lore writes are additionally gated on an author-approved plan (`plan.ts` + `propose_lore_plan` → `components/ai/PlanCard.tsx`): one card of steps per pass, and the write tools refuse any entity/action it doesn't cover. Runs emit structured `AgentEvent`s (`events.ts`) feeding the shared execution-log component (`components/ai/AgentLog.tsx`). The conversational assistant (AiDrawer "chat" mode → `components/ai/AgentChat.tsx`, session state in `stores/agentStore.ts`) and the AiPanel Agent mode both use the full-toolset `AGENT_ASSIST_PRESET`; structured JSON outputs go through `lib/agent/structured.ts` (forced tool_choice + JSON fallback). Design & history: `docs/unified-agent-plan.md`. AI-driven lore generation/improvement lives in `src/lib/lore/generator.ts` + `src/components/lore/`.

> Details: RAG context assembly, SSE parsing, and DB schema are in `docs/architecture.md`.

### Workspace Profiles

The project is not hardcoded to novels. A per-project **profile** (`.ai-writer/profile.json`, absent = the built-in `novel` one) declares the knowledge-base categories, its **task list** (each task = a prompt + a tool set, so a profile can offer any number of them), the 【…】 block labels used in the assembled prompt, the fallback system prompt, and a **`docModel`** — whether the documents form an ordered spine, carry prior-document context, or use rolling memory. Turning those off removes the injected context *and* the UI that configures it, so supporting another kind of writing (跑团模组, 文案, 周报…) is a data addition, not new branches. Built-ins (`novel`, `ttrpg`, `copy`, `weekly`, `feedback`, `bid`) live in `src/lib/profile/model.ts`; the author switches via Settings → 工作台.

Three rules when touching this: components read flags via `useDocModel()` (the singleton isn't reactive); **never** resolve a system prompt with `ai.instructions.system` — call `profileSystemPrompt()`, or a non-novel project gets novel instructions; and resolve a task with `findTask()` and handle the null, because a task id can outlive the profile that defined it. Recipe: `docs/workflows.md` → Add a new workspace profile.

### Project Structure

**Filesystem**
- `.ai-writer/project.db` — SQLite database (project-scoped)
- `.ai-writer/profile.json` — Workspace profile (what kind of writing this project is; absent = novel)
- `writing/` — User markdown files (organized tree)
- `.ai-writer/lore/<category>/<entity>/index.md` — Entity summary with frontmatter (categories come from the active profile — novel: characters, world, factions, items, skills, style, custom)

**Code**
- `src/components/layout/` — Main layout structure (TitleBar, IconRail, Sidebar, FileTree, EditorArea, EditorBottomStrip, AiRail)
- `src/components/editor/` — CodeMirror wrapper, preview renderer
- `src/components/ai/` — AiPanel (task UI, streaming output), ConsistencyCheck
- `src/components/lore/` — Lore browser, LoreGenerator, LoreImproveModal, LoreWall
- `src/components/settings/` — SettingsModal (provider/model/prompt config)
- `src/components/command/`, `onboarding/`, `outline/` — CommandPalette, onboarding flow, full outline view
- `src/lib/` — Core logic, grouped by domain:
  - `src/lib/ai/` — streaming client (`index.ts` dispatch, `openai.ts`/`gemini.ts` adapters, `types.ts`), provider config storage (`configDb.ts`), Gemini safety settings (`safety.ts`), remote probing (`providerProbe.ts`), endpoint limit probing (`endpointProbe.ts` HTTP + `probeAnalysis.ts` pure judgement — measures a model's real context window / output cap; see `docs/architecture.md` → Endpoint probing), multi-draft output vocabulary (`drafts.ts`), `apiLog.ts`, `tokenEstimate.ts`
  - `src/lib/agent/` — unified agent runtime (`runtime.ts` loop, `registry.ts` tool registry, `presets.ts` per-task config, `events.ts` execution-log events, `tools.ts` handlers + path containment, `plan.ts` lore-plan gate, `writeTools.ts` L1/L2 write handlers)
  - `src/lib/lore/` — lore domain model (`model.ts`), entity scan/CRUD (`entity.ts`), gallery/avatar (`gallery.ts`), AI generation (`generator.ts`), `[[lore:…]]` citation resolution/navigation (`citations.ts`); import via `lib/lore` (index re-exports all but generator)
  - `src/lib/batch/` — clause splitting for batch runs (`clauses.ts`: heading/numbered mode detection)
  - `src/lib/profile/` — workspace profiles: what kind of writing a project is (`model.ts` types/built-ins/validation, `active.ts` module singleton, `store.ts` `.ai-writer/profile.json`). Drives the lore category layout, the prompt's 【…】 block labels, and the fallback system prompt. **Read `loreCategories()` at call time, never at module scope** — see `docs/architecture.md` → Workspace profiles
  - `src/lib/context/` — RAG assembly (`rag.ts`), story memory (`memory.ts`), book spine (`outline.ts`), book-level continuation context (`bookContext.ts`)
  - `src/lib/fs/` — Tauri file I/O wrappers (`fileio.ts`), markdown render/frontmatter (`markdown.ts`), image/text file utils (`images.ts`), export (`export.ts`)
  - `src/lib/import/` — document import into `writing/`: docx via mammoth+turndown (`docx.ts`/`markdown.ts`), PDF text extraction via lazy pdfjs (`pdf.ts`), GBK-aware text decode (`text.ts`), dialog orchestration + naming (`index.ts`)
  - root: `project.ts`, `keyStore.ts`, `http.ts`, `paths.ts`, `platform.ts`
- `src/stores/` — Zustand state managers
- `src/styles/` — Design tokens (`tokens.css`) + global styles (`global.css`)
- `src/i18n/locales/` — JSON translation files (en, zh-CN)

## Detailed References

Load the relevant doc **before** working in that area — don't reconstruct it from scratch:

- **[`docs/design-system.md`](docs/design-system.md)** — UI/visual spec & theming: design tokens, Apple-like aesthetic rules, animation/shadow/color/component patterns. **Read before building or restyling any UI.**
- **[`docs/architecture.md`](docs/architecture.md)** — Subsystem deep-dives: DB schema, RAG, SSE streaming, secure key storage, export, Tauri IPC, file I/O, CodeMirror, capabilities, performance.
- **[`docs/workflows.md`](docs/workflows.md)** — Recipes: add an AI task type / provider / language; modify lore format.
- **[`docs/ci.md`](docs/ci.md)** — CI / PR quality gate: what the `CI` workflow checks (frontend type-check + build, Rust fmt/clippy/test/build), how to enforce it via branch protection, and how to run the same checks locally.

## Testing & Type Safety

- TypeScript strict mode enabled (noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch)
- Frontend tests: Vitest (`pnpm test`) — smoke tests in `src/lib/__tests__/` cover RAG assembly and SSE stream parsing
- Rust tests: `cargo test` (from `src-tauri/`) — unit tests live inline in `secrets.rs` and `protocol.rs`
- Frontend type-checks via `pnpm tsc --noEmit`
- CI gate on PRs to `main` runs frontend (type-check + vitest + build) and Rust (fmt/clippy/test/build) — see [`docs/ci.md`](docs/ci.md)
