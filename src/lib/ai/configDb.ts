/**
 * SQLite-backed AI configuration storage: providers, models, and prompt
 * templates, plus the legacy plaintext-key migration helpers used by keyStore.
 */

import Database from "@tauri-apps/plugin-sql";

import type { GeminiSafetySettings } from "./safety";
import type { ApiStandard } from "./types";

export type ModelType = "text" | "multimodal" | "image" | "video";

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
}

/** Upper bound for the per-model context size setting (tokens). */
export const MAX_CONTEXT_SIZE = 2_000_000;

export interface Prompt {
  id: string;
  name: string;
  content: string;
  scene: string; // 'system' | 'continue' | 'polish' | 'rewrite' | 'summary'
}

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
    apiStandard: r.api_standard as ApiStandard,
    safetySettings: parseSafetySettings(r.safety_settings),
    createdAt: r.created_at as number,
  }));
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
      (id, provider_id, model_id, name, type, price_in, price_cached_in, price_out, enabled, prefix, context_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.providerId, m.modelId, m.name, m.type, m.priceIn, m.priceCachedIn, m.priceOut, m.enabled ? 1 : 0, m.prefix ?? null, m.contextSize ?? null]
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
  };
}
