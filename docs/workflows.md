# Common Workflows

> Step-by-step recipes for recurring changes.

## Add a new AI task type
1. Add to `TaskKind` union in `aiTaskStore.ts`
2. Add default instruction to `TASK_INSTRUCTIONS` map
3. Update `AiPanel.tsx` UI button grid
4. Update i18n (en.json, zh-CN.json)

## Add a new provider/API
1. Implement `StreamOptions` parsing in `aiClient.ts` (`streamOpenAI()` or new provider branch)
2. Add `ApiStandard` enum value if needed
3. UI already supports custom base URLs in SettingsModal

## Add a new language
1. Copy `src/i18n/locales/en.json` → `src/i18n/locales/[lang].json`
2. Translate all values
3. Update `src/i18n/config.ts` languages array (if exists)
4. Restart dev server

## Modify lore entity format
1. Edit expected folder structure in `src/lib/lore.ts` (filename patterns)
2. Update `loreStore.scanProject()` parsing logic
3. Migration: rebuild lore index via store action
