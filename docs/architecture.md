# Architecture & Implementation Notes

> Deep-dive reference. Read the relevant subsection before working in that subsystem.

## Key Implementation Details

### Database Schema (SQLite)

Initialized in `src/lib/project.ts` and extended in `src/lib/ai/configDb.ts`:

```
settings (id → str, value → str)
lore_entities (id, category, dir_path, name, aliases_json, summary, embedding_status, updated_at)
providers (id, name, baseUrl, apiStandard, createdAt)
models (id, name, modelId, providerId, priceIn, priceOut)
prompts (id, name, content, taskHints, category)
token_usage (id, model_id, task, prompt_tokens, cached_tokens, completion_tokens, cost_usd, created_at)
```

### RAG (Retrieval-Augmented Generation)

- **Location** — `src/lib/context/rag.ts` (assembly) + `src/lib/context/loreSelect.ts` (lore selection)
- **Method** — Alias-based keyword matching (no embeddings, fast); facet-level secondary-key matching within matched entities
- **Context Assembly** (4 layers in `assembleContext()`):
  1. System prompt (from active template or default)
  2. Lore (facet-aware layered selection, see below)
  3. Recent document context (last 2400 chars before selection)
  4. Task instruction (continue/polish/rewrite/summary/custom)
- **Output** → `ContextBundle` → formatted to messages via `bundleToMessages()`; carries a `loreReport` (what was injected/dropped and why) rendered in `AiPanel`

#### Facet-aware lore selection (`loreSelect.ts`)

An entity is a folder; any sibling `.md` with a `facet` frontmatter field (title, `keys`, `group`, `priority`, `mode: auto|always|manual`) is an independently-activatable **facet** — an outfit, a backstory arc, etc. Selection layers under one char budget (user setting in `appStore.loreBudgetTokens`, default 600 tk, range 200–128k, converted to chars by the planner's measured chars/token — presets + a free number field in `AiPanel`):

1. **Summary** (frontmatter one-liner) — every matched entity, guaranteed
2. **Core** (`index.md` body) — paragraph-boundary truncated to fit
3. **Facets** — `auto` fires on entity match AND any key in the match target; same-`group` facets are mutually exclusive (highest priority wins; pins override); a facet that doesn't fit whole is dropped, never truncated

Pins come from `AiPanel` as `dirPath` (whole entity) or `dirPath#file` (single facet; implies its entity). Facet/core content is re-read from disk each call so hand edits are never stale. AI-assisted splitting of an oversized `index.md` into facets lives in `src/lib/lore/splitter.ts` + `LoreSplitModal` (backs up to `.ai-writer/backups/` before applying). See `docs/lore-facet-plan.md` for the full design.

### Context budget planner (`budget.ts`)

`src/lib/context/budget.ts` divides the model's declared window among the layers that can be sized, so a 1M-token model isn't fed the same 1500-token recap as an 8k one. Called from `aiTaskStore.runTask()` **before** `buildBookContext()`, since that build spends its own budget.

Spend order (each step takes from what the last left):

1. **Output reserve** — `outputReserveTokens()`: 2× the requested reply length, floor 2000 tokens
2. **Fixed costs** — `fixedContextChars()`: system prompt, task text, outline/knowledge, prev-chapter tail. Non-negotiable, they *are* the request
3. **Verbatim window floor** — `RECENT_WINDOW_MIN_CHARS` (2400) for `【近期内容】`. Prose the model can quote outranks any summary of it, so this comes before the recap layers get anything
4. **Lore** — the author's `appStore.loreBudgetTokens`, honored as-is; only trimmed if the window physically can't hold it
5. **Leftover** — half **grows the verbatim window** (same reasoning: on a 1M model the first thing worth buying is more of the actual page, not more summary of it), capped by how much text precedes the anchor. The rest splits 60/40 between `【前情提要】` and `【全书前情】`. A layer that can't contribute (no memory file / not a continuation) yields its share up front; the book layer's *unspent* share reflows to memory afterwards via `reflowMemoryBudget(plan, bookUsedChars)`

The verbatim window is only plannable for tasks with no picker (continue / custom). Polish / rewrite / summary expose 「参考上下文范围」 in `AiPanel`, and an explicit choice there — **including 0** — is an author decision the planner honors exactly and never grows.

- **`appStore.contextUtilization`** (default 0.5, chips in `AiPanel`) caps what one request may occupy — a window that *can* hold 1M tokens still costs money to fill on every task, and long contexts dilute instruction-following
- **No declared `contextSize` → static fallback.** The plan returns the historical constants (`MEMORY_BUDGET_CHARS`, `BOOK_PRIOR_BUDGET_CHARS`, `RECENT_WINDOW_MIN_CHARS`) and `dynamic: false`; nothing changes for users who never filled the field in. Lore is additionally hard-capped at `STATIC_LORE_BUDGET_MAX_TOKENS` (2000) on this path — `lib/ai/index.ts` only pre-flights when `contextSize > 0`, so without that cap nothing at all would stop a 128k-token lore setting from building a prompt no endpoint accepts
- **Agentic runs keep planning after turn 1.** `plan.inputCeilingTokens` is handed to `runAgentLoop`, which elides the oldest tool-result payloads (leaving the messages themselves in place — an unanswered `tool_call` is a protocol error) rather than letting round 6 die on a `ContextSizeError` the author waited five rounds for
- **chars/token is measured, never assumed.** `measureCharsPerToken(documentText)` samples the manuscript through `lib/ai/tokenEstimate` — the *same* estimator the pre-flight context gate uses. The rest of the context layer assumes ~3 chars/token while that gate counts CJK at ~1 token/char; planning with the optimistic ratio would build prompts the client then refuses to send. Measuring keeps plan and gate in agreement and adapts to Chinese (~1) vs Latin-script (~4) projects on its own
- **Model context size** — slider (`CONTEXT_SIZE_STOPS`: 16k/32k/128k/256k/512k/1M) plus an exact number field in the model editor, since real windows sit between stops (Claude's 200k, 64k local builds). See `src/lib/ai/contextSize.ts`

### Story Memory (前情记忆)

Per-document rolling summary so long manuscripts don't lose early plot in AI tasks — the assembled context carries a `【前情提要】` layer (compacted summaries of everything before the verbatim window) ahead of `【近期内容】`.

- **Location** — `src/lib/context/memory.ts` (pure logic + file IO), `src/stores/memoryStore.ts` (generation orchestration), UI strip in `AiPanel.tsx`
- **Storage** — `.ai-writer/memory/<relative doc path>.md`: machine metadata (segment ranges + FNV-1a hashes) in a leading `<!-- ai-writer-memory {json} -->` comment; each segment's summary is a human-editable `## …` section paired by order
- **Segmentation** — source split at paragraph boundaries into ~12k-char segments (scaled by `model.contextSize`); coverage stops `MEMORY_TAIL_KEEP_CHARS` (2000) before the end — the verbatim window handles the tail
- **Updates are incremental** — appending only summarizes the new tail; editing early text invalidates that segment *and everything after it* (offsets shift), and an update re-summarizes from the first stale segment. Manual, never automatic: the AiPanel strip shows coverage/staleness and prompts the user to create/update when >10k pre-window chars are uncovered
- **Context selection** — `selectMemoryForContext()` includes only segments starting before the verbatim window (a mid-document selection never sees later plot), newest-first under a budget from the planner below (a 0 budget means "no room" and yields nothing)
- **Usage tracking** — summarization tokens land in `token_usage` with `task = "memory"`

### Book Spine & cross-chapter memory (大纲书脊)

Story Memory is *per-document*, so a chapter is its own file and knows nothing of its siblings. The book spine adds an explicit chapter *order* so continuing a fresh chapter can see what came before it.

- **Location** — `src/lib/context/outline.ts` (order resolution, spine IO) + `src/lib/context/bookContext.ts` (book-context assembly); the outline view `src/components/outline/OutlineFullView.tsx` is the editor (drag-to-reorder)
- **Storage** — `.ai-writer/outline.json`: `{ version, order: { <volume relPath>: [<chapter relPath>, …] } }`. A **volume** = a book: top-level chapter files under `writing/` form a default volume, each sub-folder is its own
- **Order is an overlay, not a rigid list** — `applySpine()` applies the manifest order, drops entries whose file vanished, and appends un-listed files by **natural (numeric-aware) sort** (`naturalCompare` — so 第2章 < 第10章, 6-1 < 6-2 < 7). Creating/deleting files outside the outline UI never breaks ordering; the backend's byte-sort no longer decides chapter order
- **Chapter files** — `.md` / `.markdown` / `.txt` (the outline view previously dropped `.txt`)
- **Continuation memory** — `buildBookContext()` (called from `aiTaskStore` for the `continue` task) resolves the active chapter's position in its volume and returns two layers, emitted by `bundleToMessages`:
  - `【全书前情】` — recap of prior chapters, from *their* memory files, newest-first under a planner-supplied budget (chapters without a memory file simply contribute nothing — generate per-chapter memory to enrich it)
  - `【上一章结尾·<title>】` — the previous chapter's verbatim ending (a bridge), included only when the cursor is near this chapter's start; deeper in, the chapter's own `【近期内容】` carries continuity
- **Scope** — resolution stays within the active chapter's volume; only the `continue` task consumes it (a mid-document edit stays local)
- **Per-chapter memory in the outline** — each chapter card shows its Story-Memory state (`memoryStatus()` → 就绪 / 需更新 / 无摘要 / 过短) and can trigger generation *for that chapter* without opening it. The generation core is factored into `runMemoryGeneration()` (shared by `memoryStore.generate` for the active doc and `memoryStore.generateForFile(absPath)` for outline-triggered chapters); `generateForFile` reads the target's content from disk (or the live editor when it's the open file) and tracks progress under `chapterGen` so it doesn't collide with the AiPanel's active-doc strip
- **Summary model** — `aiStore.memoryModelId` (set from the outline header picker) selects which model does summarization; `memoryStore.resolveModel()` falls back to `activeModelId` when unset
- **Volume & chapter management in the outline** — a volume maps to a `writing/` sub-folder (empty ones included, so they're usable as move targets). The outline can create a volume (`makeDir`), delete an empty one (`removeDir`; the top-level `writing` volume is never deletable), and move selected chapters into a volume (`renamePath` the doc + `moveMemory()` its memory file, keeping the two together). In the outline, a single click *selects* a chapter (multi-select), a double click opens it, and right-click opens a context menu (open / mark 在写); the top/up/down/bottom buttons and drag reorder operate within a volume
- **Chapter status** — `BookSpine.status` (persisted in `outline.json`) maps a chapter relPath → `"writing"`; absence means done. Set via the chapter context menu; the header stat splits 完 / 在写 from it. `spineFromVolumes(volumes, prev)` carries the status map across reorders
- **Forcing a short chapter's summary** — the outline's per-chapter generate button passes `force` for `status === "short"`; `runMemoryGeneration({ force })` then bypasses the `MEMORY_MIN_DOC_CHARS` guard and covers the *whole* chapter (no verbatim tail), since a short prior chapter's book-level recap wants all of it

### Streaming (SSE)

- **Location** — `src/lib/ai/` (`index.ts` dispatch + pre-flight checks, `openai.ts` / `gemini.ts` adapters, `types.ts` shared protocol types)
- **Providers** — OpenAI + compatible APIs (SSE `data: {...}` lines), Google Gemini (alt=sse format)
- **Parsing** — Fetch + ReadableStream, line-by-line JSON parsing
- **Token Tracking** — OpenAI sends `include_usage: true` in stream_options; Gemini in final `usageMetadata`

### Secure Key Storage

- **Backend** — OS credential manager via the `keyring` crate (Windows Credential Manager / macOS Keychain / Linux Secret Service), service name `com.simple-ai-writer.app`
- **Rust commands** — `secret_save` / `secret_load` / `secret_delete` in `src-tauri/src/secrets.rs`
- **Frontend** — `src/lib/keyStore.ts`: `saveApiKey(providerId, key)`, `loadApiKey(providerId)`, `deleteApiKey(providerId)`; falls back to sessionStorage outside Tauri (browser dev)
- **Migration** — keys stored by older builds in the plaintext SQLite `api_keys` table are moved into the keyring (and deleted from the DB) lazily on first access
- **History** — stronghold was removed (its Rust actor deadlocked on some macOS setups); an interim plaintext-SQLite scheme was then replaced by the keyring

### Export

- **Location** — `src/lib/fs/export.ts`
- **Markdown** — Copy to clipboard
- **HTML** — Self-contained file (inline CSS, no external assets)
- **PDF** — Create hidden iframe, render HTML, call `window.print()`, remove iframe after 2s

> Theming/design tokens live in `docs/design-system.md`.

## Important Notes

### Circular Dependencies
- `aiTaskStore` imports from `editorStore` lazily inside `runTask()` to avoid circular imports at module load

### Tauri IPC Commands
- Implemented in `src-tauri/src/` (minimal; most logic in TypeScript)
- `commands.rs` — `scaffold_project`, `read_dir_recursive`, plus `fs_*` helpers (write text/binary, read text, create/read/remove dir, remove file, exists)
- `secrets.rs` — `secret_save` / `secret_load` / `secret_delete` (OS keyring)
- `protocol.rs` — custom `ai-writer-asset://` scheme for lore images (extension allowlist)
- Plugin permissions in `src-tauri/capabilities/default.json`

### File I/O
- `src/lib/fs/fileio.ts` wraps Tauri fs plugin commands (read, write, metadata, etc.)
- All paths resolved via Tauri plugin (no raw fs access)

### CodeMirror 6 Setup
- Extensions: GFM, Markdown language, history, search, Vim bindings optional
- Line wrapping enabled via `EditorView.lineNumbers` extension
- Theme: One Dark (dark mode); light mode via CSS override

### Capabilities & Permissions
- `src-tauri/capabilities/default.json` — Explicit permissions for all Tauri plugins
- Must include: `sql:*`, `dialog:*`, and read-only `fs` permissions (key storage uses custom `secret_*` commands, no plugin permission needed)
- The fs plugin is granted **read-only** (`read-file`, `read-dir`) — all writes/deletes go through the audited custom `fs_*` Rust commands. The fs scope stays broad (`/**`) because projects can live anywhere on disk.

### Content Security Policy
- Production CSP is set in `tauri.conf.json` (`app.security.csp`); `devCsp` is `null` so Vite HMR keeps working in dev
- `connect-src` allows `https:`/`http:` because users configure arbitrary AI endpoints (incl. local LLMs like Ollama); `script-src` is locked to `'self'`
- `img-src` includes the `ai-writer-asset:` custom scheme (and its `http://ai-writer-asset.localhost` Windows form) for lore images
- If a new subsystem breaks under CSP (e.g. a library injecting inline `<script>`), extend the directive minimally — don't set `csp` back to `null`

## Performance Considerations

- **Editor debouncing** — `editorStore` uses `setTimeout` to auto-save on content change (not on every keystroke)
- **Lore scanning** — Scans `lore/` tree at project open only; manual refresh via store action
- **RAG caching** — Entity summaries cached in `loreStore.index` after first scan
- **Context assembly** — 4-layer context capped at ~4000 tokens total to keep request size reasonable
