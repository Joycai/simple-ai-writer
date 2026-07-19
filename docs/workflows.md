# Common Workflows

> Step-by-step recipes for recurring changes.

## Add a new AI task type
1. Add to `TaskKind` union in `aiTaskStore.ts`
2. Add default instruction to `TASK_INSTRUCTIONS` map
3. Update `AiPanel.tsx` UI button grid
4. Update i18n (en.json, zh-CN.json)

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
1. Manual: LoreDetail → 侧面 section → 新建侧面 / 转为侧面 (form writes the `facet` frontmatter)
2. AI split: LoreDetail top bar → 拆分侧面 → review drafts → Apply (original index.md backed up to `.ai-writer/backups/`)
3. Activation semantics live in `src/lib/context/loreSelect.ts`; facet parsing in `src/lib/lore/entity.ts` (`parseFacetMeta`)
4. Tests: `src/lib/__tests__/loreSelect.test.ts`, `splitter.test.ts`
