/**
 * AI configuration backup/restore: providers, models and prompt templates as
 * a single JSON file, saved/opened through native dialogs on the Rust side.
 *
 * API keys live in the OS keyring, never in the config DB — so a backup omits
 * them unless the user explicitly opts in (`includeKeys`), in which case they
 * are embedded in the JSON in plaintext and re-saved to the keyring on import.
 *
 * Restore is a merge: entries with a known id are replaced, everything else in
 * the local config is left alone.
 */

import { getVersion } from "@tauri-apps/api/app";
import {
  ensureAiSchema,
  listModels,
  listPrompts,
  listProviders,
  saveModel,
  savePrompt,
  saveProvider,
  type Model,
  type ModelType,
  type Prompt,
  type Provider,
} from "./configDb";
import type { ApiStandard } from "./types";
import { loadApiKey, saveApiKey } from "../keyStore";
import { getGlobalDb } from "../project";
import { openTextFileDialog, saveTextFileDialog } from "../fs/transfer";

export const CONFIG_BACKUP_KIND = "ai-writer-config-backup";
export const CONFIG_BACKUP_VERSION = 1;

interface ProviderBackup extends Provider {
  /** Present only when the backup was exported with "include API keys". */
  apiKey?: string;
}

export interface ConfigBackup {
  kind: typeof CONFIG_BACKUP_KIND;
  version: number;
  exportedAt: string;
  appVersion: string;
  providers: ProviderBackup[];
  models: Model[];
  prompts: Prompt[];
}

async function configDb() {
  const db = await getGlobalDb();
  await ensureAiSchema(db);
  return db;
}

/**
 * Export the whole AI config as a JSON file via the native save dialog.
 * Returns the saved path, or null when the user cancelled.
 */
export async function exportAiConfig(includeKeys: boolean): Promise<string | null> {
  const db = await configDb();
  const [providers, models, prompts] = await Promise.all([
    listProviders(db),
    listModels(db),
    listPrompts(db),
  ]);

  const providerBackups: ProviderBackup[] = [];
  for (const p of providers) {
    const backup: ProviderBackup = { ...p };
    if (includeKeys) {
      const key = await loadApiKey(p.id);
      if (key) backup.apiKey = key;
    }
    providerBackups.push(backup);
  }

  let appVersion = "";
  try {
    appVersion = await getVersion();
  } catch {}

  const bundle: ConfigBackup = {
    kind: CONFIG_BACKUP_KIND,
    version: CONFIG_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion,
    providers: providerBackups,
    models,
    prompts,
  };

  const date = new Date().toISOString().slice(0, 10);
  return saveTextFileDialog(
    JSON.stringify(bundle, null, 2),
    `ai-writer-config-${date}.json`,
    "JSON",
    ["json"],
  );
}

export interface StagedConfigImport {
  path: string;
  providers: ProviderBackup[];
  models: Model[];
  prompts: Prompt[];
  /** How many imported providers carry an embedded API key. */
  keyCount: number;
}

const API_STANDARDS: ApiStandard[] = ["openai", "gemini", "openai_compat"];
const MODEL_TYPES: ModelType[] = ["text", "multimodal", "image", "video"];

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Phase 1 of restore: pick a backup file and validate it. Returns null when
 * the user cancelled; throws `Error("invalid-backup")` when the file is not a
 * config backup. Malformed individual entries are dropped, and models whose
 * provider is neither in the backup nor already configured are dropped too.
 */
export async function stageConfigImport(
  existingProviderIds: string[],
): Promise<StagedConfigImport | null> {
  const picked = await openTextFileDialog("JSON", ["json"]);
  if (!picked) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(picked.content);
  } catch {
    throw new Error("invalid-backup");
  }
  const root = raw as Record<string, unknown>;
  if (!root || root.kind !== CONFIG_BACKUP_KIND || num(root.version, 0) > CONFIG_BACKUP_VERSION) {
    throw new Error("invalid-backup");
  }

  const providers: ProviderBackup[] = [];
  for (const item of Array.isArray(root.providers) ? root.providers : []) {
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    const name = str(r.name);
    const apiStandard = API_STANDARDS.includes(r.apiStandard as ApiStandard)
      ? (r.apiStandard as ApiStandard)
      : null;
    if (!id || !name || !apiStandard || typeof r.baseUrl !== "string") continue;
    providers.push({
      id,
      name,
      baseUrl: r.baseUrl,
      apiStandard,
      safetySettings:
        r.safetySettings && typeof r.safetySettings === "object"
          ? (r.safetySettings as Provider["safetySettings"])
          : undefined,
      createdAt: num(r.createdAt, Date.now()),
      ...(str(r.apiKey) ? { apiKey: r.apiKey as string } : {}),
    });
  }

  const knownProviders = new Set([...existingProviderIds, ...providers.map((p) => p.id)]);
  const models: Model[] = [];
  for (const item of Array.isArray(root.models) ? root.models : []) {
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    const providerId = str(r.providerId);
    const modelId = str(r.modelId);
    const name = str(r.name);
    if (!id || !providerId || !modelId || !name || !knownProviders.has(providerId)) continue;
    models.push({
      id,
      providerId,
      modelId,
      name,
      type: MODEL_TYPES.includes(r.type as ModelType) ? (r.type as ModelType) : "text",
      priceIn: num(r.priceIn),
      priceCachedIn: num(r.priceCachedIn),
      priceOut: num(r.priceOut),
      enabled: r.enabled !== false,
      prefix: str(r.prefix) ?? undefined,
      contextSize: typeof r.contextSize === "number" ? r.contextSize : undefined,
      maxOutput: typeof r.maxOutput === "number" ? r.maxOutput : undefined,
      probedAt: typeof r.probedAt === "number" ? r.probedAt : undefined,
      pricePerImage: typeof r.pricePerImage === "number" ? r.pricePerImage : undefined,
      caps: r.caps && typeof r.caps === "object" ? (r.caps as Model["caps"]) : undefined,
    });
  }

  const prompts: Prompt[] = [];
  for (const item of Array.isArray(root.prompts) ? root.prompts : []) {
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    const name = str(r.name);
    const scene = str(r.scene);
    if (!id || !name || !scene || typeof r.content !== "string") continue;
    prompts.push({ id, name, content: r.content, scene });
  }

  if (providers.length === 0 && models.length === 0 && prompts.length === 0) {
    throw new Error("invalid-backup");
  }

  return {
    path: picked.path,
    providers,
    models,
    prompts,
    keyCount: providers.filter((p) => p.apiKey).length,
  };
}

/** Phase 2: merge the staged backup into the config DB (and keyring for embedded keys). */
export async function applyConfigImport(staged: StagedConfigImport): Promise<void> {
  const db = await configDb();
  for (const { apiKey, ...provider } of staged.providers) {
    await saveProvider(db, provider);
    if (apiKey) await saveApiKey(provider.id, apiKey);
  }
  for (const m of staged.models) await saveModel(db, m);
  for (const p of staged.prompts) await savePrompt(db, p);
}
