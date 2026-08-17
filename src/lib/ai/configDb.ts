/**
 * SQLite-backed AI configuration storage: providers, models, and prompt
 * templates, plus the legacy plaintext-key migration helpers used by keyStore.
 */

import Database from "@tauri-apps/plugin-sql";

import type { GeminiSafetySettings } from "./safety";
import { authModesFor, type ApiStandard, type AuthMode, type ImageRoute } from "./types";
import {
  parseReasoningEffort, parseThinkingDialect,
  type ReasoningEffort, type ThinkingDialect,
} from "./reasoning";
import { parseServerTools, type ServerToolId } from "./serverTools";
import { migrateLegacyStandard } from "./urls";

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
  /**
   * Which endpoint serves this model's images. Unset ⇒ derived from the
   * provider's API standard, which is right for first-party endpoints and
   * wrong for relays hosting a Gemini image model behind an OpenAI protocol.
   */
  route?: ImageRoute;
  /**
   * "dashscope" route only: submit as an async task and poll /tasks/{id}.
   * Wan text-to-image (wan2.7-image*) is async-only; qwen-image* and
   * z-image-turbo answer synchronously and leave this unset. Declared, not
   * sniffed from the model id — same rule as every other capability here.
   */
  asyncTask?: boolean;
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
    case "gemini_compat":
      // Compat gets the optimistic default here, unlike the OpenAI side,
      // because of *how* Gemini expresses an edit: input images are extra parts
      // on the same `:generateContent` call. There is no second endpoint for a
      // relay to be missing — anything that can serve generation can serve an
      // edit, so assuming otherwise would hide a button that works.
      return { edit: true, maxRefs: 3 };
    case "anthropic":
      // Claude generates no images at all, so an image model configured under
      // an Anthropic provider is already a mistake — but the switch still has
      // to answer, and "no editing" is the honest answer.
      return { edit: false };
    default:
      // `openai_compat` lands here on purpose: OpenAI puts editing behind a
      // *separate* endpoint (`/images/edits`, multipart), and relays and xAI
      // commonly expose `/images/generations` without it — so promising an edit
      // button there would promise one that errors. Also covers a DB row
      // carrying a value the union never anticipated, which would otherwise
      // fall out of the switch as `undefined` and crash every caller that
      // trusts the return type.
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
  /**
   * Anthropic-compat only: which header carries the key. Undefined — every
   * provider configured before this setting existed — means the protocol's own
   * scheme, so an upgrade never changes how an existing provider authenticates.
   */
  authMode?: AuthMode;
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
   * Optional cap on how many tokens this model can emit in one reply.
   *
   * Mostly a planning input: the context budget stops reserving window the model
   * could never fill (see context/budget.ts), which hands that space back to the
   * prompt. It *is* sent to the provider on the Anthropic path, where the
   * Messages API requires `max_tokens` on every request and has no server-side
   * default to fall back on (see ai/anthropic.ts).
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
   * How hard this model should think, in this app's own vocabulary — the
   * adapters translate (see `lib/ai/reasoning.ts`).
   *
   * Per-model rather than per-provider because the levels a model accepts, and
   * whether it can think at all, vary between models served by one endpoint:
   * a relay hosts a reasoning model and a plain one behind the same base URL.
   *
   * Absent (and `"default"`) means send nothing.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Which shape of thinking parameter this model accepts.
   *
   * Declared rather than derived: within one protocol family the parameter
   * changed between model generations, and on a relay the model id is free text
   * the author typed, so the generation isn't recoverable from it. Absent means
   * "assume the family's current generation" — see `dialectFor`.
   */
  thinkingDialect?: ThinkingDialect;
  /**
   * Tools this model may have the **endpoint** run for it — today only
   * `web_search`, and only on the Anthropic wire (see `lib/ai/serverTools.ts`).
   *
   * Per-model and declared, for the same reason as everything else here: it is
   * a property of what the author bought (MiniMax-M3 serves it; the M2.x models
   * behind the same base URL do not), and no probe can ask an endpoint which
   * server tools it offers. Absent means none, which is what every model
   * configured before this setting existed sends.
   */
  serverTools?: ServerToolId[];
  /**
   * Whether this endpoint accepts whole PDF files as message content (the
   * OpenAI `file` content part — today Qwen3.8-Max on DashScope
   * compatible-mode; see `docs/api/landscape.md` §7 第六个样本).
   *
   * Declared rather than derived, same as `serverTools` above: it is a
   * property of what the author bought — one model behind a DashScope endpoint
   * reads PDFs, the rest behind the same base URL do not — and no probe can
   * ask without spending a real document run. The PDF subagent's eligibility
   * check reads this. Absent means no, which is what every model configured
   * before this setting existed sends.
   */
  pdfInput?: boolean;
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

/**
 * `ALTER TABLE … ADD COLUMN`, skipped when the column is already there and
 * tolerant of losing the race to add it.
 *
 * "Read the columns, then add the missing ones" is not atomic, and this schema
 * check has historically run from more than one place. A second process (or a
 * second window) that added the column between the read and the write makes
 * SQLite answer `duplicate column name`, which is the outcome this function
 * was trying to produce anyway — so it is success, not failure.
 */
async function addColumn(
  db: Awaited<ReturnType<typeof Database.load>>,
  existing: { name: string }[],
  table: string,
  column: string,
  type: string,
): Promise<void> {
  if (existing.some((c) => c.name === column)) return;
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e))) throw e;
  }
}

export async function ensureAiSchema(db: Awaited<ReturnType<typeof Database.load>>) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_standard TEXT NOT NULL DEFAULT 'openai',
      safety_settings TEXT,
      auth_mode TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Migrations: columns added to providers after the table shipped.
  const providerCols = await db.select<{ name: string }[]>(`PRAGMA table_info(providers)`);
  await addColumn(db, providerCols, "providers", "safety_settings", "TEXT");
  await addColumn(db, providerCols, "providers", "auth_mode", "TEXT");

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

  // Migration: columns added to models after the table's first shipped shape.
  const modelCols = await db.select<{ name: string }[]>(`PRAGMA table_info(models)`);
  await addColumn(db, modelCols, "models", "prefix", "TEXT");
  await addColumn(db, modelCols, "models", "context_size", "INTEGER");
  await addColumn(db, modelCols, "models", "max_output", "INTEGER");
  await addColumn(db, modelCols, "models", "probed_at", "INTEGER");
  await addColumn(db, modelCols, "models", "price_per_image", "REAL");
  await addColumn(db, modelCols, "models", "caps", "TEXT");
  await addColumn(db, modelCols, "models", "reasoning_effort", "TEXT");
  await addColumn(db, modelCols, "models", "thinking_dialect", "TEXT");
  await addColumn(db, modelCols, "models", "server_tools", "TEXT");
  await addColumn(db, modelCols, "models", "pdf_input", "INTEGER");

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

/**
 * Every remaining plaintext key row.
 *
 * The per-provider lookup above only migrates a key when something asks for
 * that provider, so a provider the author stopped using keeps its key in
 * plaintext indefinitely — including after they deleted the provider from the
 * UI, since that path deletes the row it knows about and not one for an id it
 * no longer lists. Reading the whole table is what lets the migration finish
 * instead of trailing off (see `migrateLegacyKeys` in keyStore).
 */
export async function listLegacyKeyRows(
  db: Awaited<ReturnType<typeof Database.load>>,
): Promise<{ providerId: string; apiKey: string }[]> {
  const rows = await db.select<{ provider_id: string; api_key: string }[]>(
    `SELECT provider_id, api_key FROM api_keys`,
  );
  return rows
    .filter((r) => typeof r.provider_id === "string" && typeof r.api_key === "string" && r.api_key)
    .map((r) => ({ providerId: r.provider_id, apiKey: r.api_key }));
}

/**
 * Remove the legacy table itself.
 *
 * Emptying it is not enough: a deleted SQLite row leaves its bytes in the page
 * until something overwrites them, so the keys stay recoverable from the file
 * with a hex editor. Dropping the table and vacuuming rewrites the database
 * without them. VACUUM cannot run inside a transaction and may fail on a
 * database another window holds open — that is a cleanup shortfall, not a
 * migration failure, so it is tolerated separately.
 */
export async function dropLegacyKeyTable(
  db: Awaited<ReturnType<typeof Database.load>>,
): Promise<void> {
  await db.execute(`DROP TABLE IF EXISTS api_keys`);
  try {
    await db.execute("VACUUM");
  } catch (e) {
    console.warn("[configDb] dropped api_keys but could not VACUUM:", e);
  }
}

export async function listProviders(db: Awaited<ReturnType<typeof Database.load>>): Promise<Provider[]> {
  const rows = await db.select<Record<string, unknown>[]>(
    "SELECT id, name, base_url, api_standard, safety_settings, auth_mode, created_at FROM providers ORDER BY created_at ASC"
  );
  return rows.map((r) => {
    const baseUrl = r.base_url as string;
    const apiStandard = migrateLegacyStandard(parseApiStandard(r.api_standard), baseUrl);
    return {
      id: r.id as string,
      name: r.name as string,
      baseUrl,
      // Re-labels pre-split rows (see migrateLegacyStandard); the row itself is
      // rewritten only when the author next saves the provider.
      apiStandard,
      safetySettings: parseSafetySettings(r.safety_settings),
      authMode: parseAuthMode(r.auth_mode, apiStandard),
      createdAt: r.created_at as number,
    };
  });
}

const API_STANDARDS: ApiStandard[] = [
  "openai",
  "openai_compat",
  "gemini",
  "gemini_compat",
  "anthropic",
  "anthropic_compat",
];

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

/**
 * Narrow a stored `auth_mode`, and drop one the standard can't use.
 *
 * The second half matters when a provider is switched from compat back to
 * official: the row keeps its old `bearer`, and honouring that on
 * api.anthropic.com sends a credential it rejects. Reading it against the
 * standard means the stale value is inert rather than breaking the request.
 */
function parseAuthMode(raw: unknown, standard: ApiStandard): AuthMode | undefined {
  const allowed = authModesFor(standard);
  return allowed.includes(raw as AuthMode) ? (raw as AuthMode) : undefined;
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
  // A real upsert, NOT `INSERT OR REPLACE`: that is a DELETE followed by an
  // INSERT, and `models.provider_id` declares `ON DELETE CASCADE`. sqlx (which
  // backs tauri-plugin-sql) connects with `foreign_keys = ON` by default, so
  // renaming a provider — or importing a config over an existing one — would
  // take every model configured under it with it. `created_at` is deliberately
  // left out of the update: editing a provider must not re-date it.
  await db.execute(
    `INSERT INTO providers (id, name, base_url, api_standard, safety_settings, auth_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       base_url = excluded.base_url,
       api_standard = excluded.api_standard,
       safety_settings = excluded.safety_settings,
       auth_mode = excluded.auth_mode`,
    [
      p.id,
      p.name,
      p.baseUrl,
      p.apiStandard,
      p.safetySettings ? JSON.stringify(p.safetySettings) : null,
      p.authMode ?? null,
      p.createdAt,
    ]
  );
}

export async function deleteProvider(
  db: Awaited<ReturnType<typeof Database.load>>,
  id: string
): Promise<void> {
  // Delete the dependent model rows explicitly rather than relying on the
  // declared `ON DELETE CASCADE`: whether SQLite enforces it depends on a
  // per-connection `PRAGMA foreign_keys`, which nothing in this app sets — it
  // is whatever the driver happens to default to. Doing it here makes the
  // outcome the same either way, instead of leaving orphan rows that reappear
  // on the next launch if the default ever changes.
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
      (id, provider_id, model_id, name, type, price_in, price_cached_in, price_out, enabled, prefix, context_size, max_output, probed_at, price_per_image, caps, reasoning_effort, thinking_dialect, server_tools, pdf_input)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.providerId, m.modelId, m.name, m.type, m.priceIn, m.priceCachedIn, m.priceOut, m.enabled ? 1 : 0, m.prefix ?? null, m.contextSize ?? null, m.maxOutput ?? null, m.probedAt ?? null, m.pricePerImage ?? null, m.caps ? JSON.stringify(m.caps) : null, m.reasoningEffort ?? null, m.thinkingDialect ?? null, m.serverTools?.length ? JSON.stringify(m.serverTools) : null, m.pdfInput ? 1 : null]
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
    type: parseModelType(r.type),
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
    reasoningEffort: parseReasoningEffort(r.reasoning_effort),
    thinkingDialect: parseThinkingDialect(r.thinking_dialect),
    serverTools: parseServerTools(r.server_tools),
    // Absent for anything but an explicit 1 — the column is free-typed like
    // the rest, and "no declaration" must stay one representation.
    pdfInput: r.pdf_input === 1 ? true : undefined,
  };
}

const MODEL_TYPES: ModelType[] = ["text", "multimodal", "image", "video"];

/**
 * Narrow a stored `type` to the union instead of asserting it, for the same
 * reason `parseApiStandard` exists next door: the column is free text, and an
 * unrecognised value made the model vanish from *both* the text and the image
 * pickers with nothing on screen to say why. "text" is where a model with no
 * declared type belonged before the column existed.
 */
function parseModelType(raw: unknown): ModelType {
  return MODEL_TYPES.includes(raw as ModelType) ? (raw as ModelType) : "text";
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
