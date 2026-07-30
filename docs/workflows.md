# Common Workflows

> Step-by-step recipes for recurring changes.

## Add a new AI task type
1. Add to `TaskKind` union in `aiTaskStore.ts`
2. Add default instruction to `TASK_INSTRUCTIONS` map
3. Update `AiPanel.tsx` UI button grid
4. Update i18n (en.json, zh-CN.json)

## Add a new workspace profile (新的写作类型)

A profile is data — reach for this instead of adding branches for a new kind of writing (文案 / 周报 / 报告 …). See `docs/architecture.md` → Workspace profiles.

1. Add a `WorkspaceProfile` const in `src/lib/profile/model.ts` and append it to `BUILTIN_PROFILES`:
   - `categories` — knowledge-base folders. Ids must match `[A-Za-z0-9][A-Za-z0-9_-]*` and be ≤40 chars (they become directory names, and `scaffold_project` re-checks the same rule in Rust); order matters, the first is the "new entity" default
   - `sections` — only the 【…】 block labels that differ from the novel wording; anything omitted inherits `DEFAULT_SECTION_LABELS`
   - `docModel` — which novel-shaped machinery applies: `ordered` (volume/chapter spine + the full outline view), `priorContext` (【全书前情】 + 【上一章结尾】 on a continuation), `memory` (the per-document rolling summary). Omit it for `DEFAULT_DOC_MODEL` (all on). `priorContext` requires `ordered` — "previous document" needs an order, and `parseProfile` disables it otherwise
   - `systemPromptKey` — an `ai.instructions.*` key
2. Add that system prompt to **both** locales (`en.json`, `zh-CN.json`) under `ai.instructions`. Reference the profile's own section labels in the prompt text, not the novel ones.
3. Nothing else is required — the picker (Settings → 工作台), the scaffold, the lore scan, the category pickers, the agent tool schemas and the document-model gating all read the profile at runtime.
4. Tests: extend `src/lib/__tests__/profile.test.ts` (the built-in loop already validates ids/uniqueness for every profile). `profileStore.test.ts` covers the `profile.json` read/write path and `projectStoreProfile.test.ts` the open/close/switch ordering.

For a **project-specific** layout with no code change, hand-write `.ai-writer/profile.json`; a file naming a built-in patches it (`{"id":"ttrpg","sections":{"prevTail":"上一幕结尾"}}`) — `categories` and `sections` both layer over that built-in's, so overriding one label keeps the rest of its wording.

**Not yet profile-driven:** the `TaskKind` list (续写 / 润色 / 改写 / 总结) is the same for every profile. A profile wanting its own tasks — 「生成遭遇表」 for TTRPG, 「三版标题」 for copy — needs that made data-driven. The multi-draft output it depends on is in place (see `docs/architecture.md` → Multi-draft output); what remains is a per-profile task registry.

## Change how many drafts a task produces

Draft count is a user setting (`appStore.draftCount`, chip row in the AI panel), not something a task declares. To make a *task* fan out or stop fanning out, edit `draftCountFor` in `src/stores/aiTaskStore.ts` — the single place that rule lives, so the panel's control and the run agree.

Before lifting the clamp on `agent` or `continue`, read the table in `docs/architecture.md` → Multi-draft output: `agent` is a correctness limit (concurrent disk writes + racing approval cards), and `continue` needs per-draft `agentLog`s first or the execution log becomes unreadable.

Tests: `src/lib/__tests__/aiTaskDrafts.test.ts` covers the clamp, the fan-out count, per-draft failure isolation, shared-abort, and one usage row per draft.

## Add a new provider/API
1. Add a new adapter in `src/lib/ai/` (alongside `openai.ts` / `gemini.ts`) and wire it into the `streamCompletion()` dispatch in `src/lib/ai/index.ts`
2. Add `ApiStandard` enum value in `src/lib/ai/types.ts` if needed
3. UI already supports custom base URLs in SettingsModal

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
