# Common Workflows

> Step-by-step recipes for recurring changes.

## Add a new AI task type

Tasks are pack data (`docs/reference/architecture.md` → Tasks), so this is an edit to one pack — not to a union, the panel, or the run loop. A pack's `tasks` list carries only its *own* tasks (and any overrides of a base-menu id); the base 续写/润色/… menu is app-level (`DEFAULT_TASKS`) and needs no declaring.

1. Add a `TaskDef` to the pack's `tasks` in `src/lib/profile/model.ts`:
   - `instructionKey` — an `ai.instructions.*` key holding the prompt (or `freeform: true` to let the author type it)
   - `tools` — `none` for a plain completion, `read` to let it consult lore/chapters first, `full` for the write-capable toolset. Anything but `none` runs the agent loop and produces a single draft
   - `target` — `append` / `replace` / `detached`, i.e. where an accepted result goes
   - flags as needed: `needsSelection`, `referenceWindow`, `continuation` (append-only), `hidden`
2. Add the instruction to **both** locales under `ai.instructions`, plus a `labelKey`/`descKey` under `ai.tasks` (or literal `labelZh`/`labelEn` for a hand-written `profile.json`, where new i18n keys aren't possible).
3. Nothing else — the panel renders a segment per task, the preset comes from `tools`, and a prompt template with `scene` = the task id overrides the instruction.

Task ids are used as prompt `scene` keys and as the `token_usage.task` value, so pick one and keep it.

**Worked example** — the ttrpg profile's 遭遇 and 随机表 (`src/lib/profile/model.ts`). Both are `freeform` so the author supplies the situation and the built-in text is the briefing; they differ only in `tools`, and that one field decides whether the task can consult the module's lore (`read`) or can instead produce several results at once (`none`). Pick `read` when being consistent with existing entities matters more than having options to compare.

**Still app-global:** the built-in prompt list in Settings → Prompt (`BUILTIN_PROMPTS_CONFIG` in `settings/panes/PromptsPane.tsx`) is a static set of scenes. A profile-specific task can still be overridden by a template whose `scene` matches its id, but it won't be pre-listed there yet.

## Add a new capability pack (新的写作类型)

A pack is data — reach for this instead of adding branches for a new kind of writing (文案 / 周报 / 报告 …). See `docs/reference/architecture.md` → Capability packs. A pack is **purely additive**: it contributes tasks and knowledge-base categories, and may reword the 【…】 labels *for its own tasks*. It does not set the UI vocabulary, the document model, or the AI's persona — those are app-level; domain rules belong in the pack tasks' instruction texts (see how `bidRespond` carries the deviation discipline).

1. Add a `WorkspaceProfile` const in `src/lib/profile/model.ts` and append it to `BUILTIN_PROFILES`:
   - `categories` — knowledge-base folders. Ids must match `[A-Za-z0-9][A-Za-z0-9_-]*` and be ≤40 chars (they become directory names, and `scaffold_project` re-checks the same rule in Rust); order matters, the first is the "new entity" default. Don't declare `custom` — the misc bucket is app-level and always present
   - `sections` — only the 【…】 block labels that differ from the neutral defaults, applied to this pack's own tasks; anything omitted inherits `DEFAULT_SECTION_LABELS`. Don't override `knowledge` — the knowledge base is called 知识库 everywhere
   - `tasks` — the pack's own tasks, plus a base-id entry only to *override* a base task's instruction (the way novel re-points 续写 at `continueNovel`)
2. Add the task instructions to **both** locales (`en.json`, `zh-CN.json`) under `ai.instructions`, folding the domain's non-negotiables into them — there is no per-pack system prompt to carry them.
3. Nothing else is required — the toggles (Settings → 工作台), the scaffold, the lore scan, the category pickers and the agent tool schemas all read the merged workspace at runtime.
4. Tests: extend `src/lib/__tests__/profile.test.ts` (the built-in loop already validates ids/uniqueness for every pack). `resolveWorkspace.test.ts` covers the merge, `profileStore.test.ts` the `profile.json` read/write path and `projectStoreProfile.test.ts` the open/close/switch ordering.

For **project-specific categories** no code (and no pack) is needed: the lore wall's 「+ 新建分类」 chip and Settings → 工作台 manage user-defined categories persisted in profile.json's top-level `categories`. For a project-specific *pack*, hand-write `.ai-writer/profile.json`; a `packs[]` entry naming a built-in patches it (`{"id":"ttrpg","sections":{"prevTail":"上一幕结尾"}}`) — `categories` and `sections` both layer over that built-in's, so overriding one label keeps the rest of its wording.

Tasks are pack data too — see **Add a new AI task type** above.

## Change how many drafts a task produces

Draft count is a user setting (`appStore.draftCount`, chip row in the AI panel), not something a task declares. To make a *task* fan out or stop fanning out, edit `draftCountFor` in `src/stores/aiTaskStore.ts` — the single place that rule lives, so the panel's control and the run agree.

Before lifting the clamp on `agent` or `continue`, read the table in `docs/reference/architecture.md` → Multi-draft output: `agent` is a correctness limit (concurrent disk writes + racing approval cards), and `continue` needs per-draft `agentLog`s first or the execution log becomes unreadable.

Tests: `src/lib/__tests__/aiTaskDrafts.test.ts` covers the clamp, the fan-out count, per-draft failure isolation, shared-abort, and one usage row per draft.

## Add a new provider/API

`ApiStandard` is a *wire protocol*, not a vendor — add a value only when the endpoint speaks a shape the existing adapters can't. A provider that serves `/chat/completions` is `openai_compat` and needs no code.

**Only one of the sites below is type-enforced** (`STANDARD_ENDPOINTS`, step 5). Every other list is hand-maintained and will silently stay incomplete — most damagingly the two allowlists in step 3, which rewrite an unrecognised value to `openai_compat`, i.e. the provider quietly talks the wrong protocol.

1. **Adapter** — new file in `src/lib/ai/` alongside `openai.ts` / `gemini.ts` / `anthropic.ts`, exporting `stream<Name>(opts: StreamOptions): Promise<void>`. Copy the SSE read loop (the `buffer` carry across reads and the trailing-line flush are load-bearing) and honour the chunk contract: incremental `{ text }`, at most one `{ toolCalls }` *before* exactly one `{ done, … }`. Throw on a non-2xx *and* on an in-band error delivered under HTTP 200 — relays do that routinely.
2. **Union + dispatch** — add the value to `ApiStandard` in `src/lib/ai/types.ts`, then a branch in `streamCompletion()` in `src/lib/ai/index.ts` (inside the existing log/context-guard wrapper, so both come for free).
3. **Both allowlists** — `API_STANDARDS` in `src/lib/ai/configDb.ts` (`parseApiStandard`, guards DB reads) **and** in `src/lib/ai/configTransfer.ts` (guards config import). They are separate arrays in different orders; missing either loses the provider on next launch.
4. **`defaultImageCaps`** in `src/lib/ai/configDb.ts` — add a `case`, even if the answer is "generates no images".
5. **Settings** — `src/components/settings/panes/ProviderDrawer.tsx`: `STANDARD_ENDPOINTS` (a `Record<ApiStandard, string>`, so this is the compile error that tells you the union moved), the `apiStandardOptions` picker array, and a `PROVIDER_PRESETS` entry if it's a named service.
6. **i18n** — `aiConfig.apiStandards.<value>` in **both** `en.json` and `zh-CN.json`; `localeParity.test.ts` fails on a one-sided key.
7. **Onboarding** — `PROVIDERS` in `src/components/onboarding/Onboarding.tsx`, if it belongs in the first-run list.
8. **Default base URL** — `defaultBaseUrl()` in `src/stores/aiTaskStore.ts`, used when the author leaves the field blank.
9. **Probes** — `src/lib/ai/providerProbe.ts` (both functions; `testProviderConnection` otherwise falls through to "Unknown API standard" and reports failure on a working provider) and `src/lib/ai/endpointProbe.ts` (`authHeaders`, the Step-0 models endpoint, and either a `chatRequest` branch or an early return from the chat-based steps).
10. **JSON mode** — `jsonModeExtraBody` / `needsJsonTextCue` in `src/lib/ai/jsonMode.ts`, if the protocol enforces JSON differently (or not at all — sending a foreign field is a 400 on Anthropic).
11. **Tests** — a `describe` block in `src/lib/__tests__/aiClient.test.ts` covering deltas, usage, truncation, a streamed tool call, and an in-band error; plus `providerProbe.test.ts`.

## Add a new language
1. Copy `src/i18n/locales/en.json` → `src/i18n/locales/[lang].json`
2. Translate all values
3. Update `src/i18n/config.ts` languages array (if exists)
4. Restart dev server

## Modify lore entity format
1. Edit expected folder structure in `src/lib/lore/entity.ts` / `src/lib/lore/gallery.ts` (filename patterns)
2. Update `loreStore.scanProject()` parsing logic
3. Migration: rebuild lore index via store action

## Add or split lore facets
1. Manual: LoreDetail → 特征 section → 新建特征 / 转为特征 (form writes the `facet` frontmatter)
2. AI split: LoreDetail top bar → 拆分特征 → review drafts → Apply (original index.md backed up to `.ai-writer/backups/`)
3. Activation semantics live in `src/lib/context/loreSelect.ts`; facet parsing in `src/lib/lore/entity.ts` (`parseFacetMeta`)
4. Tests: `src/lib/__tests__/loreSelect.test.ts`, `splitter.test.ts`
