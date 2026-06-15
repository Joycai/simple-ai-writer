import Database from "@tauri-apps/plugin-sql";

export type ApiStandard = "openai" | "openai_compat" | "gemini";
export type ModelType = "text" | "multimodal" | "image" | "video";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiStandard: ApiStandard;
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
}

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
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

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
      enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      scene TEXT NOT NULL DEFAULT 'system'
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS api_keys (
      provider_id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL DEFAULT ''
    )
  `);
}

export async function saveKeyToDb(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId: string,
  apiKey: string,
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO api_keys (provider_id, api_key) VALUES (?, ?)`,
    [providerId, apiKey],
  );
}

export async function loadKeyFromDb(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId: string,
): Promise<string | null> {
  const rows = await db.select<{ api_key: string }[]>(
    `SELECT api_key FROM api_keys WHERE provider_id = ?`,
    [providerId],
  );
  return rows[0]?.api_key ?? null;
}

export async function deleteKeyFromDb(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId: string,
): Promise<void> {
  await db.execute(`DELETE FROM api_keys WHERE provider_id = ?`, [providerId]);
}

export async function listProviders(db: Awaited<ReturnType<typeof Database.load>>): Promise<Provider[]> {
  const rows = await db.select<Record<string, unknown>[]>(
    "SELECT id, name, base_url, api_standard, created_at FROM providers ORDER BY created_at ASC"
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    baseUrl: r.base_url as string,
    apiStandard: r.api_standard as ApiStandard,
    createdAt: r.created_at as number,
  }));
}

export async function saveProvider(
  db: Awaited<ReturnType<typeof Database.load>>,
  p: Provider
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO providers (id, name, base_url, api_standard, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [p.id, p.name, p.baseUrl, p.apiStandard, p.createdAt]
  );
}

export async function deleteProvider(
  db: Awaited<ReturnType<typeof Database.load>>,
  id: string
): Promise<void> {
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
      (id, provider_id, model_id, name, type, price_in, price_cached_in, price_out, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.providerId, m.modelId, m.name, m.type, m.priceIn, m.priceCachedIn, m.priceOut, m.enabled ? 1 : 0]
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

/** Fetch the available model list from a provider's /models endpoint (OpenAI-style). */
export async function fetchRemoteModels(
  baseUrl: string,
  apiKey: string,
  standard: ApiStandard
): Promise<{ id: string; name: string }[]> {
  if (standard === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gemini models fetch failed: ${res.status}`);
    const data = await res.json();
    return (data.models ?? []).map((m: Record<string, string>) => ({
      id: m.name?.replace("models/", "") ?? m.name,
      name: m.displayName ?? m.name,
    }));
  }
  // OpenAI / compatible
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((m: Record<string, string>) => ({
    id: m.id,
    name: m.id,
  }));
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
  };
}
