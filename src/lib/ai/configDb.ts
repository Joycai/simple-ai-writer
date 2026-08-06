/**
 * SQLite-backed AI configuration storage: providers, models, and prompt
 * templates, plus the legacy plaintext-key migration helpers used by keyStore.
 */

import Database from "@tauri-apps/plugin-sql";

import type { GeminiSafetySettings } from "./safety";
import type { ApiStandard } from "./types";

export type ModelType = "text" | "multimodal" | "image" | "video";

/**
 * What an image model's endpoint can actually do. Declared rather than probed:
 * a capability probe against an image endpoint costs a real generation, so the
 * author states it once (defaults guessed from the API standard) and the
 * runtime degrades visibly when a request proves the declaration wrong.
 */
export interface ImageCaps {
  /** Accepts input images — editing / img2img. False for generate-only endpoints. */
  edit?: boolean;
  /** Sizes the endpoint accepts (e.g. ["1024x1024"]). Empty ⇒ send no size at all. */
  sizes?: string[];
  /** How many reference images one edit request may carry. */
  maxRefs?: number;
}

/**
 * Default capabilities for a newly added image model, by wire protocol.
 * `openai_compat` is the conservative case: relays and xAI commonly expose
 * /images/generations but no /images/edits, and guessing "yes" there would
 * promise the author an edit button that always errors.
 */
export function defaultImageCaps(standard: ApiStandard): ImageCaps {
  switch (standard) {
    case "openai":
      return { edit: true, maxRefs: 16 };
    case "gemini":
      return { edit: true, maxRefs: 3 };
    case "openai_compat":
      return { edit: false };
    default:
      // Not dead code, despite the union being exhaustive: `standard` reaches
      // here from a DB row, and a value the type system never anticipated
      // would otherwise fall out of the switch as `undefined` — crashing every
      // caller that trusts the return type.
      return { edit: false };
  }
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiStandard: ApiStandard;
  /** Gemini-only: per-request safety filter thresholds. */
  safetySettings?: GeminiSafetySettings;
  createdAt: number;
}

export interface Model {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  type: ModelType;
  priceIn: number;      // USD per 1M input tokens
  priceCachedIn: number;
  priceOut: number;     // USD per 1M output tokens
  enabled: boolean;
  /** Optional model-scoped prefix prompt, prepended to every request as a leading system instruction. */
  prefix?: string;
  /**
   * Optional context window size in tokens (max 2,000,000). When set, requests
   * whose estimated prompt size exceeds it are blocked with a user-facing
   * notice before sending, instead of being silently truncated by the server.
   */
  contextSize?: number;
  /**
   * Optional cap on how many tokens this model can emit in one reply. Purely a
   * planning input: the context budget stops reserving window the model could
   * never fill (see context/budget.ts), which hands that space back to the
   * prompt. Nothing is sent to the provider.
   */
  maxOutput?: number;
  /**
   * When the endpoint was last probed (ms epoch), or undefined for values the
   * author typed in. Measurements age — a relay can re-route the same model
   * name to a different upstream tomorrow — so the UI dates them rather than
   * presenting them as permanent facts.
   */
  probedAt?: number;
  /**
   * USD per generated image. The billing shape image endpoints usually use;
   * token pricing (priceIn/priceOut) still applies on top for the providers
   * that bill image generation as tokens. See `imageCostFor`.
   */
  pricePerImage?: number;
  /** Image-model capabilities. Meaningless (and unset) for text models. */
  caps?: ImageCaps;
}

/**
 * USD cost of one completion, accounting for the model's cheaper cached-input
 * rate. `cachedTokens` is a subset of `inputTokens` — both OpenAI's and
 * Gemini's usage reporting count it that way — so only the uncached
 * remainder bills at the full input rate.
 */
export function costFor(
  model: Model,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
): number {
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  return (
    (uncachedInput * model.priceIn + cachedTokens * model.priceCachedIn + outputTokens * model.priceOut) /
    1_000_000
  );
}

/**
 * USD cost of one image run. Two billing shapes exist and a model may use
 * either, so both are summed rather than switched between: `pricePerImage`
 * covers the per-image endpoints (xAI, Imagen), and the token terms cover the
 * providers that meter image generation as tokens (OpenAI's image models) and
 * report usage on the response. A model configures whichever applies; the
 * unset side contributes zero.
 *
 * Deliberately separate from `costFor` — folding two billing units into one
 * function makes both call sites read as if they know something they don't.
 */
export function imageCostFor(
  model: Model,
  images: number,
  usage?: { inputTokens: number; outputTokens: number },
): number {
  const perImage = (model.pricePerImage ?? 0) * Math.max(0, images);
  const perToken = usage
    ? (usage.inputTokens * model.priceIn + usage.outputTokens * model.priceOut) / 1_000_000
    : 0;
  return perImage + perToken;
}

/** Upper bound for the per-model context size setting (tokens). */
export const MAX_CONTEXT_SIZE = 2_000_000;

/** Upper bound for the per-model max-output setting (tokens). */
export const MAX_OUTPUT_SIZE = 262_144;

export interface Prompt {
  id: string;
  name: string;
  content: string;
  /**
   * 'system' (selectable system prompt), a task id (overrides that task's
   * built-in instruction), or SNIPPET_SCENE (a reusable snippet the input
   * boxes offer for quick insertion — never auto-applied to anything).
   */
  scene: string;
}

/**
 * Scene value for quick-insert snippets. Deliberately not a task id — a
 * prompt with this scene overrides nothing; the input surfaces (自定义 task
 * box, chat) list it in their snippet picker instead.
 */
export const SNIPPET_SCENE = "snippet";

export async function ensureAiSchema(db: Awaited<ReturnType<typeof Database.load>>) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_standard TEXT NOT NULL DEFAULT 'openai',
      safety_settings TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Migration: add safety_settings to providers created before this column existed.
  const providerCols = await db.select<{ name: string }[]>(`PRAGMA table_info(providers)`);
  if (!providerCols.some((c) => c.name === "safety_settings")) {
    await db.execute(`ALTER TABLE providers ADD COLUMN safety_settings TEXT`);
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      price_in REAL NOT NULL DEFAULT 0,
      price_cached_in REAL NOT NULL DEFAULT 0,
      price_out REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      prefix TEXT
    )
  `);

  // Migration: add prefix column to models created before this column existed.
  const modelCols = await db.select<{ name: string }[]>(`PRAGMA table_info(models)`);
  if (!modelCols.some((c) => c.name === "prefix")) {
    await db.execute(`ALTER TABLE models ADD COLUMN prefix TEXT`);
  }
  if (!modelCols.some((c) => c.name === "context_size")) {
    await db.execute(`ALTER TABLE models ADD COLUMN context_size INTEGER`);
  }
  if (!modelCols.some((c) => c.name === "max_output")) {
    await db.execute(`ALTER TABLE models ADD COLUMN max_output INTEGER`);
  }
  if (!modelCols.some((c) => c.name === "probed_at")) {
    await db.execute(`ALTER TABLE models ADD COLUMN probed_at INTEGER`);
  }
  if (!modelCols.some((c) => c.name === "price_per_image")) {
    await db.execute(`ALTER TABLE models ADD COLUMN price_per_image REAL`);
  }
  if (!modelCols.some((c) => c.name === "caps")) {
    await db.execute(`ALTER TABLE models ADD COLUMN caps TEXT`);
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      scene TEXT NOT NULL DEFAULT 'system'
    )
  `);

}

// ─── Legacy plaintext key storage (migration only) ────────────────────────────
// Keys used to be stored in plaintext in the `api_keys` table. They now live in
// the OS keyring (see keyStore.ts). These helpers only exist so keyStore can
// migrate old rows out of the DB; no code path writes new keys here.

export async function loadLegacyKeyFromDb(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId: string,
): Promise<string | null> {
  const rows = await db.select<{ api_key: string }[]>(
    `SELECT api_key FROM api_keys WHERE provider_id = ?`,
    [providerId],
  );
  return rows[0]?.api_key ?? null;
}

export async function deleteLegacyKeyFromDb(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId: string,
): Promise<void> {
  await db.execute(`DELETE FROM api_keys WHERE provider_id = ?`, [providerId]);
}

export async function listProviders(db: Awaited<ReturnType<typeof Database.load>>): Promise<Provider[]> {
  const rows = await db.select<Record<string, unknown>[]>(
    "SELECT id, name, base_url, api_standard, safety_settings, created_at FROM providers ORDER BY created_at ASC"
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    baseUrl: r.base_url as string,
    apiStandard: parseApiStandard(r.api_standard),
    safetySettings: parseSafetySettings(r.safety_settings),
    createdAt: r.created_at as number,
  }));
}

const API_STANDARDS: ApiStandard[] = ["openai", "openai_compat", "gemini"];

/**
 * Narrow a stored `api_standard` to the union instead of asserting it.
 *
 * The column is free text: rows predate the current names, backups and hand
 * edits land here unchecked, and a bare `as ApiStandard` hands the rest of the
 * app a value no `switch` covers. Anything unrecognised becomes
 * `openai_compat`, which is where the dispatch sent it anyway (everything
 * that is not `gemini` takes the OpenAI adapter) — so this narrows the type
 * without changing which adapter a provider talks to.
 */
function parseApiStandard(raw: unknown): ApiStandard {
  return API_STANDARDS.includes(raw as ApiStandard) ? (raw as ApiStandard) : "openai_compat";
}

function parseSafetySettings(raw: unknown): GeminiSafetySettings | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw) as GeminiSafetySettings;
  } catch {
    return undefined;
  }
}

export async function saveProvider(
  db: Awaited<ReturnType<typeof Database.load>>,
  p: Provider
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO providers (id, name, base_url, api_standard, safety_settings, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [p.id, p.name, p.baseUrl, p.apiStandard, p.safetySettings ? JSON.stringify(p.safetySettings) : null, p.createdAt]
  );
}

export async function deleteProvider(
  db: Awaited<ReturnType<typeof Database.load>>,
  id: string
): Promise<void> {
  // SQLite does not enforce the models.provider_id FK cascade unless
  // `PRAGMA foreign_keys = ON` is set per connection (it isn't), so delete the
  // dependent model rows explicitly — otherwise they survive as orphans that
  // reappear on the next launch.
  await db.execute("DELETE FROM models WHERE provider_id = ?", [id]);
  await db.execute("DELETE FROM providers WHERE id = ?", [id]);
}

export async function listModels(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId?: string
): Promise<Model[]> {
  const sql = providerId
    ? "SELECT * FROM models WHERE provider_id = ? ORDER BY name ASC"
    : "SELECT * FROM models ORDER BY name ASC";
  const args = providerId ? [providerId] : [];
  const rows = await db.select<Record<string, unknown>[]>(sql, args);
  return rows.map(rowToModel);
}

export async function saveModel(
  db: Awaited<ReturnType<typeof Database.load>>,
  m: Model
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO models
      (id, provider_id, model_id, name, type, price_in, price_cached_in, price_out, enabled, prefix, context_size, max_output, probed_at, price_per_image, caps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.providerId, m.modelId, m.name, m.type, m.priceIn, m.priceCachedIn, m.priceOut, m.enabled ? 1 : 0, m.prefix ?? null, m.contextSize ?? null, m.maxOutput ?? null, m.probedAt ?? null, m.pricePerImage ?? null, m.caps ? JSON.stringify(m.caps) : null]
  );
}

export async function deleteModel(
  db: Awaited<ReturnType<typeof Database.load>>,
  id: string
): Promise<void> {
  await db.execute("DELETE FROM models WHERE id = ?", [id]);
}

export async function listPrompts(
  db: Awaited<ReturnType<typeof Database.load>>
): Promise<Prompt[]> {
  const rows = await db.select<Record<string, unknown>[]>(
    "SELECT id, name, content, scene FROM prompts ORDER BY name ASC"
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    content: r.content as string,
    scene: r.scene as string,
  }));
}

export async function savePrompt(
  db: Awaited<ReturnType<typeof Database.load>>,
  p: Prompt
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO prompts (id, name, content, scene) VALUES (?, ?, ?, ?)`,
    [p.id, p.name, p.content, p.scene]
  );
}

export async function deletePrompt(
  db: Awaited<ReturnType<typeof Database.load>>,
  id: string
): Promise<void> {
  await db.execute("DELETE FROM prompts WHERE id = ?", [id]);
}

function rowToModel(r: Record<string, unknown>): Model {
  return {
    id: r.id as string,
    providerId: r.provider_id as string,
    modelId: r.model_id as string,
    name: r.name as string,
    type: r.type as ModelType,
    priceIn: r.price_in as number,
    priceCachedIn: r.price_cached_in as number,
    priceOut: r.price_out as number,
    enabled: (r.enabled as number) === 1,
    prefix: (r.prefix as string | null) ?? undefined,
    contextSize: (r.context_size as number | null) ?? undefined,
    maxOutput: (r.max_output as number | null) ?? undefined,
    probedAt: (r.probed_at as number | null) ?? undefined,
    pricePerImage: (r.price_per_image as number | null) ?? undefined,
    caps: parseImageCaps(r.caps),
  };
}

function parseImageCaps(raw: unknown): ImageCaps | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ImageCaps) : undefined;
  } catch {
    return undefined;
  }
}
