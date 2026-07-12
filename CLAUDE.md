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

### Data Flow: AI Writing Task

1. **User selection** → `aiTaskStore.setSelection()`
2. **Task trigger** → `aiTaskStore.runTask(kind, customInstruction?)`
   - Loads system prompt, calls `assembleContext()` (4-layer: system → lore → document → task), formats via `bundleToMessages()`
3. **Streaming** → `streamCompletion()` (SSE) — parses chunks into `output`, extracts token counts/cost on final chunk
4. **Persist** → Writes to `token_usage` table in SQLite
5. **Insert** → User clicks "Insert to Document" → `editorStore.setContent()`

Tasks can also run through an **agentic tool loop** (`src/lib/agent/loop.ts` + `src/lib/agent/tools.ts`): up to 8 rounds of model-driven tool calls (`list_lore_entities`, `read_lore_entity`, `list_files`, `read_file`) with multimodal image support. AI-driven lore generation/improvement lives in `src/lib/lore/generator.ts` + `src/components/lore/`.

> Details: RAG context assembly, SSE parsing, and DB schema are in `docs/architecture.md`.

### Project Structure

**Filesystem**
- `.ai-writer/project.db` — SQLite database (project-scoped)
- `writing/` — User markdown files (organized tree)
- `.ai-writer/lore/<category>/<entity>/index.md` — Entity summary with frontmatter (categories: characters, world, factions, items, skills, custom)

**Code**
- `src/components/layout/` — Main layout structure (TitleBar, IconRail, Sidebar, FileTree, EditorArea, EditorBottomStrip, AiRail)
- `src/components/editor/` — CodeMirror wrapper, preview renderer
- `src/components/ai/` — AiPanel (task UI, streaming output), ConsistencyCheck
- `src/components/lore/` — Lore browser, LoreGenerator, LoreImproveModal, LoreWall
- `src/components/settings/` — SettingsModal (provider/model/prompt config)
- `src/components/command/`, `onboarding/`, `outline/` — CommandPalette, onboarding flow, full outline view
- `src/lib/` — Core logic, grouped by domain:
  - `src/lib/ai/` — streaming client (`index.ts` dispatch, `openai.ts`/`gemini.ts` adapters, `types.ts`), provider config storage (`configDb.ts`), Gemini safety settings (`safety.ts`), remote probing (`providerProbe.ts`), `apiLog.ts`, `tokenEstimate.ts`
  - `src/lib/agent/` — agentic tool loop (`loop.ts`) + tool definitions/executor (`tools.ts`)
  - `src/lib/lore/` — lore domain model (`model.ts`), entity scan/CRUD (`entity.ts`), gallery/avatar (`gallery.ts`), AI generation (`generator.ts`); import via `lib/lore` (index re-exports all but generator)
  - `src/lib/context/` — RAG assembly (`rag.ts`), story memory (`memory.ts`), book spine (`outline.ts`), book-level continuation context (`bookContext.ts`)
  - `src/lib/fs/` — Tauri file I/O wrappers (`fileio.ts`), markdown render/frontmatter (`markdown.ts`), image/text file utils (`images.ts`), export (`export.ts`)
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
