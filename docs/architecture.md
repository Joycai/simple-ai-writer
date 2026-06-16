# Architecture & Implementation Notes

> Deep-dive reference. Read the relevant subsection before working in that subsystem.

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

> Theming/design tokens live in `docs/design-system.md`.

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
