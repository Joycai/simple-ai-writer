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
   - `categories` — knowledge-base folders. Ids must be `[A-Za-z0-9_-]` (they become directory names); order matters, the first is the "new entity" default
   - `sections` — only the 【…】 block labels that differ from the novel wording; anything omitted inherits `DEFAULT_SECTION_LABELS`
   - `systemPromptKey` — an `ai.instructions.*` key
2. Add that system prompt to **both** locales (`en.json`, `zh-CN.json`) under `ai.instructions`. Reference the profile's own section labels in the prompt text, not the novel ones.
3. Nothing else is required — the picker (Settings → 工作台), the scaffold, the lore scan, the category pickers and the agent tool schemas all read the profile at runtime.
4. Tests: extend `src/lib/__tests__/profile.test.ts` (the built-in loop already validates ids/uniqueness for every profile).

For a **project-specific** layout with no code change, hand-write `.ai-writer/profile.json`; a file naming a built-in patches it (`{"id":"ttrpg","sections":{"prevTail":"上一幕结尾"}}`).

**Not yet profile-driven** (still novel-shaped for every profile): the `TaskKind` list, and the ordered volume/chapter document model in `context/outline.ts` + `bookContext.ts`. A profile that shouldn't have "previous chapter" context needs those made conditional first.

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
