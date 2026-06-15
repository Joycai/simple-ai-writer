# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
   - Loads system prompt from active prompt template (or default)
   - Calls `assembleContext()` (4-layer context assembly: system → lore → document → task)
   - Formats messages via `bundleToMessages()`
3. **Streaming** → `streamCompletion()` (SSE from OpenAI/Gemini)
   - Parses chunks, updates `output` state
   - On final chunk, extracts token counts and cost
4. **Persist** → Writes to `token_usage` table in SQLite
5. **Insert** → User clicks "Insert to Document" → `editorStore.setContent()`

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
- `src/i18n/locales/` — JSON translation files (en, zh-CN)

## Key Implementation Details

### Database Schema (SQLite)

Initialized in `src/lib/project.ts` and extended in `src/lib/aiConfig.ts`:

```
settings (id → str, value → str)
lore_entities (id, category, dir_path, name, aliases_json, summary, embedding_status, updated_at)
providers (id, name, baseUrl, apiStandard, createdAt)
models (id, name, modelId, providerId, priceIn, priceOut)
prompts (id, name, content, taskHints, category)
token_usage (id, model_id, task, prompt_tokens, cached_tokens, completion_tokens, cost_usd, created_at)
```

### RAG (Retrieval-Augmented Generation)

- **Location** — `src/lib/rag.ts`
- **Method** — Alias-based keyword matching (no embeddings, fast)
- **Context Assembly** (4 layers in `assembleContext()`):
  1. System prompt (from active template or default)
  2. Lore snippets (up to 3 matching entity summaries, max 1800 chars each)
  3. Recent document context (last 2400 chars before selection)
  4. Task instruction (continue/polish/rewrite/summary/custom)
- **Output** → `ContextBundle` → formatted to messages via `bundleToMessages()`

### Streaming (SSE)

- **Location** — `src/lib/aiClient.ts`
- **Providers** — OpenAI + compatible APIs (SSE `data: {...}` lines), Google Gemini (alt=sse format)
- **Parsing** — Fetch + ReadableStream, line-by-line JSON parsing
- **Token Tracking** — OpenAI sends `include_usage: true` in stream_options; Gemini in final `usageMetadata`

### Secure Key Storage

- **Library** — `tauri-plugin-stronghold` (v2.3.1)
- **Location** — `src/lib/keyStore.ts`
- **Setup** — `.setup()` hook in `src-tauri/src/lib.rs` with argon2 KDF (salt at `~/.config/simple-ai-writer/salt.txt`)
- **API** — `saveApiKey(projectPath, providerId, key)`, `loadApiKey(projectPath, providerId)`

### Export

- **Location** — `src/lib/export.ts`
- **Markdown** — Copy to clipboard
- **HTML** — Self-contained file (inline CSS, no external assets)
- **PDF** — Create hidden iframe, render HTML, call `window.print()`, remove iframe after 2s

### Theming

- **System** — CSS variables (dark/light modes) set via `data-theme` attribute
- **Location** — `src/styles/global.css` (variables), component modules (CSS Modules)
- **Theme Modes** — dark, light, system (auto-detect)

### Internationalization (i18n)

- **Library** — react-i18next (i18next backend)
- **Locales** — `src/i18n/locales/{en,zh-CN}.json`
- **Hook** — `useTranslation()` returns `t()` and i18n methods
- **Store** — `appStore.language` syncs with `i18n.changeLanguage()`

## Important Notes

### Circular Dependencies
- `aiTaskStore` imports from `editorStore` lazily inside `runTask()` to avoid circular imports at module load

### Tauri IPC Commands
- Implemented in `src-tauri/src/lib.rs` (minimal; most logic in TypeScript)
- Commands exposed: `scaffold_project`, `read_dir_recursive`
- Plugin permissions in `src-tauri/capabilities/default.json`

### File I/O
- `src/lib/fileio.ts` wraps Tauri fs plugin commands (read, write, metadata, etc.)
- All paths resolved via Tauri plugin (no raw fs access)

### CodeMirror 6 Setup
- Extensions: GFM, Markdown language, history, search, Vim bindings optional
- Line wrapping enabled via `EditorView.lineNumbers` extension
- Theme: One Dark (dark mode); light mode via CSS override

### Capabilities & Permissions
- `src-tauri/capabilities/default.json` — Explicit permissions for all Tauri plugins
- Must include: `stronghold:*`, `sql:*`, `fs:*`, `dialog:*`

## Performance Considerations

- **Editor debouncing** — `editorStore` uses `setTimeout` to auto-save on content change (not on every keystroke)
- **Lore scanning** — Scans `lore/` tree at project open only; manual refresh via store action
- **RAG caching** — Entity summaries cached in `loreStore.index` after first scan
- **Context assembly** — 4-layer context capped at ~4000 tokens total to keep request size reasonable

## Testing & Type Safety

- TypeScript strict mode enabled (noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch)
- No test framework currently; tests welcome via PR
- Frontend type-checks via `pnpm tsc --noEmit`

## Common Workflows

**Add a new AI task type**
1. Add to `TaskKind` union in `aiTaskStore.ts`
2. Add default instruction to `TASK_INSTRUCTIONS` map
3. Update `AiPanel.tsx` UI button grid
4. Update i18n (en.json, zh-CN.json)

**Add a new provider/API**
1. Implement `StreamOptions` parsing in `aiClient.ts` (`streamOpenAI()` or new provider branch)
2. Add `ApiStandard` enum value if needed
3. UI already supports custom base URLs in SettingsModal

**Add a new language**
1. Copy `src/i18n/locales/en.json` → `src/i18n/locales/[lang].json`
2. Translate all values
3. Update `src/i18n/config.ts` languages array (if exists)
4. Restart dev server

**Modify lore entity format**
1. Edit expected folder structure in `src/lib/lore.ts` (filename patterns)
2. Update `loreStore.scanProject()` parsing logic
3. Migration: rebuild lore index via store action
