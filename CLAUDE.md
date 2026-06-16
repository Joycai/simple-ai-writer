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
- **Frontend (React 18 + TypeScript + Vite)** — UI components, state management, markdown editor
- **Tauri v2 (Rust)** — IPC bridge, file system, database, crypto operations
- **Backend Services (External APIs)** — OpenAI, Google Gemini, or any OpenAI-compatible provider

### 3-Pane Layout
```
┌─────────────────────────────────────────────────────┐
│                   StatusBar (36px)                  │
├──────┬──────────────┬──────────────────┬────────────┤
│ Side │   Sidebar    │   EditorArea     │ RightPanel │
│ Tab  │   (240px)    │   (flex: 1)      │  (280px)   │
│ Bar  ├──────────────┼──────────────────┤            │
│      │ Files/Lore   │ Editor | Preview │ Outline    │
│      │ panels       │                  │ AI Panel   │
│      │              │                  │ Lore Cards │
└──────┴──────────────┴──────────────────┴────────────┘
```

### State Management (Zustand Stores)

All in `src/stores/`:
- **appStore** — Theme, language (i18n), sidebar/panel collapse state, active tabs
- **projectStore** — Current project path, file tree, active file, word/char count
- **editorStore** — Editor content, dirty flag, view mode (editor/split/preview), save scheduling
- **loreStore** — Indexed lore entities, alias mapping, entity summaries; auto-scans `lore/` folder on project open
- **aiStore** — Providers (API config), models (available LLMs), prompts (templates); secure API key storage via stronghold
- **aiTaskStore** — Running AI task state, streaming output, token usage, abort signal

### Data Flow: AI Writing Task

1. **User selection** → `aiTaskStore.setSelection()`
2. **Task trigger** → `aiTaskStore.runTask(kind, customInstruction?)`
   - Loads system prompt, calls `assembleContext()` (4-layer: system → lore → document → task), formats via `bundleToMessages()`
3. **Streaming** → `streamCompletion()` (SSE) — parses chunks into `output`, extracts token counts/cost on final chunk
4. **Persist** → Writes to `token_usage` table in SQLite
5. **Insert** → User clicks "Insert to Document" → `editorStore.setContent()`

> Details: RAG context assembly, SSE parsing, and DB schema are in `docs/architecture.md`.

### Project Structure

**Filesystem**
- `.ai-writer/project.db` — SQLite database (project-scoped)
- `writing/` — User markdown files (organized tree)
- `lore/[EntityName]/index.md` — Entity summary (rendered in preview)
- `lore/[EntityName]/aliases.txt` — One alias per line (for RAG keyword matching)

**Code**
- `src/components/layout/` — Main layout structure (SideTabBar, Sidebar, EditorArea, RightPanel, StatusBar)
- `src/components/editor/` — CodeMirror wrapper, preview renderer
- `src/components/ai/` — AiPanel (task UI, streaming output)
- `src/components/settings/` — SettingsModal (provider/model/prompt config)
- `src/lib/` — Core logic (project, editor, RAG, AI client, export, file I/O)
- `src/stores/` — Zustand state managers
- `src/styles/` — Design tokens (`tokens.css`) + global styles (`global.css`)
- `src/i18n/locales/` — JSON translation files (en, zh-CN)

## Detailed References

Load the relevant doc **before** working in that area — don't reconstruct it from scratch:

- **[`docs/design-system.md`](docs/design-system.md)** — UI/visual spec & theming: design tokens, Apple-like aesthetic rules, animation/shadow/color/component patterns. **Read before building or restyling any UI.**
- **[`docs/architecture.md`](docs/architecture.md)** — Subsystem deep-dives: DB schema, RAG, SSE streaming, secure key storage, export, Tauri IPC, file I/O, CodeMirror, capabilities, performance.
- **[`docs/workflows.md`](docs/workflows.md)** — Recipes: add an AI task type / provider / language; modify lore format.

## Testing & Type Safety

- TypeScript strict mode enabled (noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch)
- No test framework currently; tests welcome via PR
- Frontend type-checks via `pnpm tsc --noEmit`
