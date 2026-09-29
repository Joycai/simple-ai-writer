# Common Workflows

> **Status: `living`.** If a recipe disagrees with the code, the doc is the bug.
> Step-by-step recipes for recurring changes.

## Add a new AI task type

Tasks are pack data (`docs/reference/architecture.md` → Tasks), so this is an edit to one pack — not to a union, the panel, or the run loop. A pack's `tasks` list carries only its *own* tasks (and any overrides of a base-menu id); the base 续写/润色/… menu is app-level (`DEFAULT_TASKS`) and needs no declaring.

1. Add a `TaskDef` to the pack's `tasks` in `src/lib/profile/model.ts`:
   - `instructionKey` — an `ai.instructions.*` key holding the prompt (or `freeform: true` to let the author type it)
   - `tools` — `none` for a plain completion, `read` to let it consult lore/chapters first, `write` when the task's product is a **document** (read + create/append/edit/verify + the deliverable exports, but nothing that changes the knowledge base), `full` for the whole toolset. Anything but `none` runs the agent loop and produces a single draft. **Reach for `write` before `full`**: the schemas ride on every round, and `full` (the assistant preset) is capped at ~17k against `write`'s ~5k — the live caps are `AGENT_ASSIST_CAP` / `WRITE_CAP` in `agentToolBudget.test.ts`; on a small local model that difference is the knowledge base getting a budget or getting nothing (`agentToolBudget.test.ts`, `contextForecast.test.ts`)
   - `target` — `append` / `replace` / `detached`, i.e. where an accepted result goes
   - flags as needed: `needsSelection`, `referenceWindow`, `continuation` (append-only), `hidden`
2. Add the instruction to **both** locales under `ai.instructions`, plus a `labelKey`/`descKey` under `ai.tasks` (or literal `labelZh`/`labelEn` for a hand-written `profile.json`, where new i18n keys aren't possible).
3. Nothing else — the panel renders a segment per task, the preset comes from `tools`, and a prompt template with `scene` = the task id overrides the instruction.

Task ids are used as prompt `scene` keys and as the `token_usage.task` value, so pick one and keep it.

**Worked example** — the ttrpg profile's 遭遇 and 随机表 (`src/lib/profile/model.ts`). Both are `freeform` so the author supplies the situation and the built-in text is the briefing; they differ only in `tools`, and that one field decides whether the task can consult the module's lore (`read`) or can instead produce several results at once (`none`). Pick `read` when being consistent with existing entities matters more than having options to compare.

**Still app-global:** the built-in prompt list in Settings → Prompt (`BUILTIN_PROMPTS_CONFIG` in `settings/panes/PromptsPane.tsx`) is a static set of scenes. A profile-specific task can still be overridden by a template whose `scene` matches its id, but it won't be pre-listed there yet.

## Add a new capability pack (新的写作类型)

A pack is data — reach for this instead of adding branches for a new kind of writing (文案 / 周报 / 报告 …). See [`codemap.md` → 能力包](codemap.md#能力包workspace-packs). A pack is **purely additive**: it contributes tasks and knowledge-base categories, and may reword the 【…】 labels *for its own tasks*. It does not set the UI vocabulary, the document model, or the AI's persona — those are app-level; domain rules belong in the pack tasks' instruction texts (see how `bidRespond` carries the deviation discipline).

1. Add a `WorkspaceProfile` const in `src/lib/profile/model.ts` and append it to `BUILTIN_PROFILES`:
   - `categories` — knowledge-base folders. Ids must match `[A-Za-z0-9][A-Za-z0-9_-]*` and be ≤40 chars (they become directory names, and `scaffold_project` re-checks the same rule in Rust); order matters, the first is the "new entity" default. Don't declare `custom` — the misc bucket is app-level and always present
   - `sections` — only the 【…】 block labels that differ from the neutral defaults, applied to this pack's own tasks; anything omitted inherits `DEFAULT_SECTION_LABELS`. Don't override `knowledge` — the knowledge base is called 知识库 everywhere
   - `tasks` — the pack's own tasks, plus a base-id entry only to *override* a base task's instruction (the way novel re-points 续写 at `continueNovel`)
2. Add the task instructions to **both** locales (`en.json`, `zh-CN.json`) under `ai.instructions`, folding the domain's non-negotiables into them — there is no per-pack system prompt to carry them.
3. Nothing else is required — the toggles (Settings → 工作台), the scaffold, the lore scan, the category pickers and the agent tool schemas all read the merged workspace at runtime.
4. Tests: extend `src/lib/profile/__tests__/profile.test.ts` (the built-in loop already validates ids/uniqueness for every pack). `resolveWorkspace.test.ts` covers the merge, `profileStore.test.ts` the `profile.json` read/write path and `projectStoreProfile.test.ts` the open/close/switch ordering.

For **project-specific categories** no code (and no pack) is needed: the lore wall's 「+ 新建分类」 chip and Settings → 工作台 manage user-defined categories persisted in profile.json's top-level `categories`. For a project-specific *pack*, hand-write `.ai-writer/profile.json`; a `packs[]` entry naming a built-in patches it (`{"id":"ttrpg","sections":{"prevTail":"上一幕结尾"}}`) — `categories` and `sections` both layer over that built-in's, so overriding one label keeps the rest of its wording.

Tasks are pack data too — see **Add a new AI task type** above.

## Change how many drafts a task produces

Draft count is a user setting (`appStore.draftCount`, chip row in the AI panel), not something a task declares. To make a *task* fan out or stop fanning out, edit `draftCountFor` in `src/stores/aiTaskStore.ts` — the single place that rule lives, so the panel's control and the run agree.

Before lifting the clamp on `agent` or `continue`, read the table in `docs/reference/architecture.md` → Multi-draft output: `agent` is a correctness limit (concurrent disk writes + racing approval cards), and `continue` needs per-draft `agentLog`s first or the execution log becomes unreadable.

Tests: `src/stores/__tests__/aiTaskDrafts.test.ts` covers the clamp, the fan-out count, per-draft failure isolation, shared-abort, and one usage row per draft.

## Add a new provider/API

Provider config is three layers (`docs/feature/channel-model-route-plan.md`, `docs/api/provider-layering.md`): a **channel** (`Provider` row — one key on one **platform**, `PlatformId`) → its **routes** (`Endpoint` in `src/lib/ai/routes.ts` — one `ProtocolFamily` at a path below the channel's host) → a **model** that picks one route as `activeRoute` and keeps its protocol-dependent settings per route (`RouteProfile`). So "a new provider" is one of two very different changes:

- **A new platform** (a named service speaking families we already have) — data, no adapter. Section A below.
- **A new protocol family** — `ApiStandard` / `ProtocolFamily` are *wire protocols*, not vendors; add one only when the endpoint speaks a shape the existing adapters can't. Section B below. A server that answers `/chat/completions` needs neither: pick the `custom` (or `newapi`) platform in the drawer.

**The `Record<ApiStandard | ProtocolFamily | PlatformId, …>` tables are type-enforced** — the compile errors walk you through them (`PROTOCOL_FAMILY`, `COMPAT_STANDARD`, `ROUTE_SHORT` / `ROUTE_LONG`, `PROFILES`, `PLATFORM_CELLS`, `VALUE_FACTS.*.familyDefault`, `DERIVED` in `imageRoute.ts`, …). The plain **lists** are hand-maintained and silently stay incomplete: `PLATFORM_IDS` (a platform missing from it reads back as `custom`), `ROUTE_FAMILIES` (a family missing from it is dropped when a route is parsed), and the two `API_STANDARDS` allowlists in step B3 (an unrecognised standard is rewritten to `openai_compat`, i.e. the provider quietly talks the wrong protocol).

### A. A new platform

1. **`src/lib/ai/platforms.ts`** — add the id to the `PlatformId` union **and** to `PLATFORM_IDS` (the drawer's order and `parsePlatform`'s allowlist), then a `PROFILES` entry: `origin` (absent = the author types the host), `endpoints` (one `{ family, path }` per route it serves, first = primary; `official: true` only for a vendor's own constant address; `authMode` when the platform documents a different key header), `hosts` (how a row with no stored platform is recognised), `source` (the measurement it rests on). A self-hosted relay can reuse `GENERIC_ENDPOINTS`.
2. **Capabilities** — `PLATFORM_CELLS` in `src/lib/ai/capability/cells/platform.ts` (a `Record`, so it won't compile without the entry): server tools, private knobs and model calibrations the platform was *measured* to accept. Anything unmeasured stays out — the protocol's own vocabulary is the default (`platforms.ts` header, rule 1).
3. **Billing** — set `reportsCost` on the profile **only** if a sample compared the platform's reported per-request cost with its own ledger: a reported cost overrides the model's whole fee group (`reportedCost.ts`), so a relay merely returning a field of that name must not get it. List in `unreported` the model ids a route answers without a cost — the model drawer then asks for a fee group there. Fee groups themselves are author data, not platform data: the channel's `defaultFeeGroupId` (ProviderDrawer's 计费组 select) only **prefills** `feeGroupId` on models created under it and never follows later. Invariants: [`docs/feature/billing/01-fee-groups.md`](../feature/billing/01-fee-groups.md).
4. **Settings** — `src/components/settings/panes/ProviderDrawer.tsx`: optional `STARTER_MODELS[platform]` (rows created with a *new* channel saved from that platform — OrcaRouter's free tier; never added to an existing channel) and `PLATFORM_NOTES[platform]`. The drawer lists routes, paths and auth headers straight from the profile, so nothing else there changes.
5. **i18n** — `aiConfig.platforms.<id>` in **both** `en.json` and `zh-CN.json`; `localeParity.test.ts` fails on a one-sided key.
6. **Onboarding** — `PROVIDERS` in `src/components/onboarding/Onboarding.tsx`, if it belongs in the first-run list.
7. **Tests** — `platforms.test.ts` (host inference, endpoints) and, for `reportsCost`, `reportedCost.test.ts` under `src/lib/ai/__tests__/`, plus a `landscape.md` sample for whatever the profile claims.

### B. A new protocol family

1. **Adapter** — new file in `src/lib/ai/` alongside `openai.ts` / `responses.ts` / `gemini.ts` / `anthropic.ts` / `dashscope.ts`, exporting `stream<Name>(opts: StreamOptions): Promise<void>`. Copy the SSE read loop (the `buffer` carry across reads and the trailing-line flush are load-bearing) and honour the chunk contract: incremental `{ text }`, at most one `{ toolCalls }` *before* exactly one `{ done, … }`. Throw on a non-2xx *and* on an in-band error delivered under HTTP 200 — relays do that routinely.
2. **Union + dispatch** — add the value (both halves, `x` and `x_compat` — or only `x_compat` when no vendor address is locked to the wire, as with `dashscope_compat`) to `ApiStandard` in `src/lib/ai/types.ts`, a `ProtocolFamily` value if the wire is new, and the `PROTOCOL_FAMILY` rows (a `Record<ApiStandard, …>`, so it fails to compile until both are there); in `src/lib/ai/routes.ts` the family's `COMPAT_STANDARD` / `OFFICIAL_STANDARD` rows, its `ROUTE_SHORT` / `ROUTE_LONG` badge text, and — by hand — `ROUTE_FAMILIES`; then a `case` on the family in `streamCompletion()` in `src/lib/ai/index.ts` (inside the existing log/context-guard wrapper, so both come for free). A new family also has to answer in the family switches that *don't* have a default worth inheriting — `VALUE_FACTS.thinkingCategory.familyDefault` in `capability/facts.ts` (a `Record`, so it will not compile until the family names its category — an unrelated family's would put its fields on the new wire) and `resolveStructuredOutput` in `jsonMode.ts` (same, for `response_format`); `grep familyOf` for the rest and read each `default` branch as "OpenAI Chat Completions", because that is what it means.
3. **Both allowlists** — `API_STANDARDS` in `src/lib/ai/configDb.ts` (`parseApiStandard`, guards DB reads) **and** in `src/lib/ai/configTransfer.ts` (guards config import). They are separate arrays in different orders; missing either loses the provider on next launch.
4. **`defaultImageCaps`** in `src/lib/ai/configDb.ts` — add a `case`, even if the answer is "generates no images".
5. **Platforms** — add the family's route to every `PROFILES` entry in `platforms.ts` that serves it (and to `GENERIC_ENDPOINTS` if relays in general do); a family no platform lists can only be added by hand in the drawer's route table. `rawCost` in `reportedCost.ts` needs a `case` for the family — the field its usage object reports cost in, or `undefined` (Section A step 3 for the trust rule).
6. **i18n** — the per-family hint keys in `ModelDrawer.tsx` (`SEARCH_HINT_KEY` / `EXTRACT_HINT_KEY` / `CODE_HINT_KEY`, `Record`s) point at locale keys that must exist in **both** `en.json` and `zh-CN.json`; `localeParity.test.ts` fails on a one-sided key.
7. **Onboarding** — `PROVIDERS` in `src/components/onboarding/Onboarding.tsx`, if it belongs in the first-run list.
8. **Default base URL** — `defaultBaseFor()` in `src/lib/ai/urls.ts`, used when an official provider's stored base is empty (a family that shares another's host, like Responses on OpenAI's, needs no branch there).
9. **Probes** — `src/lib/ai/providerProbe.ts` (`testProviderConnection`'s "count the list" branch and `completionProbeRequest`, whose fallback must speak the family's own shape — a relay serving only the new endpoint need not serve the old one) and `src/lib/ai/endpointProbe.ts` (`authHeaders`, the Step-0 models endpoint, a `chatRequest` branch or an early return from the chat-based steps, and `outputParamFor` if the family names its output cap differently).
10. **JSON mode** — `resolveStructuredOutput` / `jsonModeShaping` in `src/lib/ai/jsonMode.ts`, if the protocol enforces JSON differently (or not at all — sending a foreign field is a 400 on Anthropic and silently nothing on Responses), plus the matching `soChoices` list in `ModelDrawer.tsx`.
11. **Tests** — a test file per adapter under `src/lib/ai/__tests__/` (`aiClient.test.ts` for the original three, `responses.test.ts` for the Responses family) covering deltas, usage, truncation, a streamed tool call, and an in-band error; plus `providerProbe.test.ts`, and the `familyOf` / family-default category / `defaultImageCaps` cases in `providerUrls.test.ts`, `thinkingCategory.test.ts`, `imageDomain.test.ts`.

## Add a new language
1. Copy `src/i18n/locales/en.json` → `src/i18n/locales/[lang].json`
2. Translate all values. Read [`terminology.md`](terminology.md) first — the 词表 decides which word a key may use, and `localeTerms.test.ts` fails the retired ones.
3. `src/i18n/index.ts`: add the `import` and one entry in i18next's `resources` map. There is no languages array — the map *is* the list, and `fallbackLng` stays `en`.
4. `src/stores/appStore.ts`: widen the `Language` union; `src/components/settings/panes/GeneralPane.tsx`: add the option to the picker. The stored value goes through `lib/prefs` (`app:language`), read once at module init — see the comment in `i18n/index.ts` about why `hydratePrefs()` must finish first.
5. `src/lib/__tests__/localeParity.test.ts` imports `zh-CN.json` and `en.json` by name — a third locale is not covered until you add it there. That test is the only checklist for "did I translate all of it": a missing key is invisible at runtime, i18next silently falls back.
6. Restart the dev server (the JSON is imported at build time).

## Modify lore entity format
1. Edit expected folder structure in `src/lib/lore/entity.ts` / `src/lib/lore/gallery.ts` (filename patterns)
2. Update the parsing in `scanLore()` (`src/lib/lore/entity.ts`; `loreStore.scanProject()` only calls it). Before changing a category's shape or facet frontmatter, read [`lore-entry-type-plan.md`](../feature/lore/lore-entry-type-plan.md) — slots are a category's schema, and its §4 三条不变量 are what let entries degrade rather than vanish
3. Migration: rebuild lore index via store action

## Add or split lore facets
1. Manual: LoreDetail → 特征 section → 新建特征 / 转为特征 (form writes the `facet` frontmatter)
2. AI split: LoreDetail top bar → 拆分特征 → review drafts → Apply (original index.md backed up to `.ai-writer/backups/`)
3. Activation semantics live in `src/lib/context/loreSelect.ts`; facet parsing in `src/lib/lore/entity.ts` (`parseFacetMeta`)
4. Tests: `src/lib/context/__tests__/loreSelect.test.ts`, `splitter.test.ts`
