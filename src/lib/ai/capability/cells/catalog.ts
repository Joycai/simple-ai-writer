/**
 * The global model catalog — facts that belong to a *model*, whoever serves it
 * (docs/api/capability-resolution-hld.md §3.2, "固有类"). How a platform spells a
 * model's thinking, or which of its tools it runs, is never here: that changes
 * with the server and lives in `platform.ts`.
 *
 * Rows match {@link canonicalModelId} (lower-cased, `vendor/` namespace
 * stripped) and are consulted per fact in {@link bySpecificity} order, so the
 * longest prefix that says anything about a fact answers it — `gpt-4-turbo`
 * is not answered by `gpt-4`. A row may carry one fact or several.
 *
 * What used to be two lists (`modelLimits.ts` `KNOWN_OUTPUT_CAPS`,
 * `jsonMode.ts` `KNOWN_JSON_SCHEMA`) and one regex inside the Responses
 * adapter; a prefix that was on both lists is one row here.
 *
 *   - `maxOutput`: the documented single-reply cap. Planning-only, and timid on
 *     purpose — see `modelLimits.ts`'s header for the two rules.
 *   - `strictSchemaModel`: documented (or measured) to follow a strict JSON
 *     schema. Lifts the auto tier *up* only (`jsonMode.ts`), so a stale row
 *     costs a missed upgrade, never a request that used to work.
 *   - `reasons: false`: no reasoning to encrypt — the Responses route asks for
 *     no `include` (OpenAI answers the pair with a 400; xAI's non-reasoning ids
 *     were never measured with it).
 */

import { bySpecificity, canonicalModelId, prefix, rowSetting, type ModelPattern } from "../modelId";

interface IntrinsicFacts {
  maxOutput?: number;
  /** No rows yet: every window the app knows is a platform's (`platform.ts`). */
  contextSize?: number;
  strictSchemaModel?: true;
  reasons?: false;
}

interface CatalogRow {
  match: ModelPattern;
  set: IntrinsicFacts;
}

const row = (p: string, set: IntrinsicFacts): CatalogRow => ({ match: prefix(p), set });
const STRICT = { strictSchemaModel: true } as const;

const MODEL_CATALOG: readonly CatalogRow[] = bySpecificity<CatalogRow>([
  // ── OpenAI ──
  // GPT-6: 128K, the same as GPT-5 (OrcaRouter's catalog for all three, 2026-09-26).
  // gpt-6 held an enum the prompt contradicted, on ① and ② (landscape.md §7 第十八个样本).
  row("gpt-6", { maxOutput: 128_000, ...STRICT }),
  row("gpt-5", { maxOutput: 128_000, ...STRICT }),
  row("gpt-4.1", { maxOutput: 32_768, ...STRICT }),
  row("gpt-4o", { maxOutput: 16_384, ...STRICT }),
  row("gpt-4-turbo", { maxOutput: 4_096 }),
  row("gpt-4", { maxOutput: 8_192 }),
  row("gpt-3.5", { maxOutput: 4_096 }),
  row("o4-mini", { maxOutput: 100_000 }),
  row("o3", { maxOutput: 100_000 }),
  row("o1", { maxOutput: 100_000 }),
  // ── Google — `responseJsonSchema` is documented from Gemini 2.5 on ──
  row("gemini-3", { maxOutput: 65_536, ...STRICT }),
  row("gemini-2.5", { maxOutput: 65_536, ...STRICT }),
  row("gemini-2.0", { maxOutput: 8_192 }),
  row("gemini-1.5", { maxOutput: 8_192 }),
  // ── DeepSeek ──
  row("deepseek-reasoner", { maxOutput: 32_768 }),
  row("deepseek-chat", { maxOutput: 8_192 }),
  // DeepSeek-V4.1-Flash, the vendor's own catalogue name (api-docs.deepseek.com
  // 模型 & 价格, 2026-09): 1M window, 384K cap. Its id shares no prefix with any
  // row above — `deepseek-flash` matched nothing and fell through to the
  // app-wide default, which on an author who never filled the field in is a
  // silent truncation rather than a wrong number.
  row("deepseek-flash", { maxOutput: 393_216 }),
  // ── Qwen (DashScope) ──
  row("qwen-max", { maxOutput: 8_192 }),
  row("qwen-plus", { maxOutput: 8_192 }),
  row("qwen-turbo", { maxOutput: 8_192 }),
  // ── 千问AI平台 catalogue, 2026-09 (docs/api/qianwen-compat-plan.md P6) ──
  // Numbers are the platform's model pages; the third-party models are listed
  // under the bare ids the platform uses (`kimi-k3`, `glm-5.2`), which is also
  // what the vendors' own endpoints call them. Strict schema: the platform's
  // own list, 2026-09.
  row("qwen3.8-flash", { maxOutput: 131_072, ...STRICT }),
  row("qwen3.8-max", STRICT),
  row("qwen3.7-flash", { maxOutput: 131_072, ...STRICT }),
  row("qwen3.7-plus", STRICT),
  row("qwen3.7-max", STRICT),
  row("qwen3-vl-plus", { maxOutput: 32_768 }),
  row("deepseek-v4-pro", { maxOutput: 393_216 }),
  row("glm-5.2", { maxOutput: 131_072 }),
  row("kimi-k3", { maxOutput: 1_000_000 }),
  // ── 智谱 BigModel — the vendor's 核心参数 table, 2026-09 (landscape.md §7
  // 第十四个样本; 4.5-air's 98,304 measured: one over is a 400 naming the range).
  // `glm-5` covers every 5.x id (5-turbo, 5.1–5.3, 5.3-flash(x), 5v-turbo); the
  // two vision rows exist because their text siblings' prefix would claim them.
  row("glm-5", { maxOutput: 131_072 }),
  row("glm-4.7", { maxOutput: 131_072 }),
  row("glm-4.6", { maxOutput: 131_072 }),
  row("glm-4.6v", { maxOutput: 32_768 }),
  row("glm-4.5", { maxOutput: 98_304 }),
  row("glm-4.5v", { maxOutput: 16_384 }),
  row("minimax-m2.5", { maxOutput: 32_768 }),
  // ── 火山方舟 Doubao Seed 2.1 — plan alias and dated id both. Not 2.0:
  // 2.0-lite answered past a strict schema on both routes (第十二个样本) ──
  row("doubao-seed-2.1", STRICT),
  row("doubao-seed-2-1", STRICT),
  // ── Anthropic `output_config.format` — Claude 4.5 on, per Anthropic's list;
  // held an enum the prompt contradicted on Sonnet 5 / 4.6, Opus 5.5 / 4.5 and
  // Fable 5.1 (landscape.md §7 第十八个样本，补测). Both spellings: the
  // official hyphen and the relays' dot. Haiku 4.5 is on the list, unmeasured.
  // No output caps: nothing here may reach Anthropic's `max_tokens` (modelLimits.ts). ──
  ...[
    "claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5",
    "claude-opus-4-5", "claude-opus-4.5", "claude-opus-4-6", "claude-opus-4.6",
    "claude-opus-4-7", "claude-opus-4.7", "claude-opus-4-8", "claude-opus-4.8",
    "claude-sonnet-4-5", "claude-sonnet-4.5", "claude-sonnet-4-6", "claude-sonnet-4.6",
    "claude-haiku-4-5", "claude-haiku-4.5",
  ].map((p) => row(p, STRICT)),
  // ── xAI — the non-reasoning ids (`grok-4-fast-non-reasoning`) ──
  { match: /non-reasoning/, set: { reasons: false } },
]);

/**
 * What the catalog says about one fact of this model, or undefined when no row
 * does. A relay alias like `特价 | qwen3.8-max` matches nothing; that model is
 * declared by hand.
 */
export function catalogFact<K extends keyof IntrinsicFacts>(fact: K, modelId: string): IntrinsicFacts[K] | undefined {
  return rowSetting(MODEL_CATALOG, canonicalModelId(modelId), (r) => r.set[fact] !== undefined)?.set[fact];
}
