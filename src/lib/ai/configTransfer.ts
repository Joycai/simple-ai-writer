/**
 * AI configuration backup/restore: providers, models and prompt templates as
 * a single JSON file, saved/opened through native dialogs on the Rust side.
 *
 * API keys live in the OS keyring, never in the config DB — so a backup omits
 * them unless the user explicitly opts in (`includeKeys`), in which case they
 * are embedded in the JSON in plaintext and re-saved to the keyring on import.
 *
 * Preferences (lib/prefs) ride along too — they were the other half of "my
 * setup didn't come with me": theme, fonts, panel widths, the lore budget.
 * Only the portable subset travels; a recent-projects list or a per-project
 * pin would carry paths that mean nothing on the other machine, and `lib/prefs`
 * filters those on both the way out and the way in.
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
import { parseReasoningEffort, parseThinkingDialect } from "./reasoning";
import { parseServerTools } from "./serverTools";
import { authModesFor, type ApiStandard, type AuthMode } from "./types";
import { migrateLegacyStandard } from "./urls";
import { loadApiKey, saveApiKey } from "../keyStore";
import { applyPrefEntries, portablePrefEntries } from "../prefs";
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
  /** Portable preferences as `[key, value]` pairs. Absent in v1 backups written before they were included. */
  prefs?: [string, string][];
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
    prefs: portablePrefEntries(),
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
  prefs: [string, string][];
  /** How many imported providers carry an embedded API key. */
  keyCount: number;
}

const API_STANDARDS: ApiStandard[] = [
  "openai",
  "openai_compat",
  "gemini",
  "gemini_compat",
  "anthropic",
  "anthropic_compat",
];
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
    // A backup written before the official/compat split names the family only
    // — same re-labelling as reading a pre-split DB row.
    const migrated = migrateLegacyStandard(apiStandard, r.baseUrl);
    providers.push({
      id,
      name,
      baseUrl: r.baseUrl,
      apiStandard: migrated,
      safetySettings:
        r.safetySettings && typeof r.safetySettings === "object"
          ? (r.safetySettings as Provider["safetySettings"])
          : undefined,
      authMode: authModesFor(migrated).includes(r.authMode as AuthMode)
        ? (r.authMode as AuthMode)
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
      // Parsed rather than cast: a backup written by a newer build (or edited by
      // hand) can carry a level this build doesn't know, and an unknown level
      // must degrade to "send nothing" rather than reach the wire.
      reasoningEffort: parseReasoningEffort(r.reasoningEffort),
      thinkingDialect: parseThinkingDialect(r.thinkingDialect),
      serverTools: parseServerTools(r.serverTools),
      pdfInput: r.pdfInput === true ? true : undefined,
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

  // Shape-checked here; which keys are actually allowed through is `lib/prefs`'
  // call, made again at apply time so a hand-edited file can't slip one past.
  const prefs: [string, string][] = (Array.isArray(root.prefs) ? root.prefs : [])
    .filter(
      (e): e is [string, string] =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
    );

  if (providers.length === 0 && models.length === 0 && prompts.length === 0 && prefs.length === 0) {
    throw new Error("invalid-backup");
  }

  return {
    path: picked.path,
    providers,
    models,
    prompts,
    prefs,
    keyCount: providers.filter((p) => p.apiKey).length,
  };
}

/**
 * Phase 2: merge the staged backup into the config DB (and keyring for
 * embedded keys).
 *
 * The DB rows go in one transaction: row-by-row, a failure part-way (a
 * rejected model row, a locked database) left providers configured with none
 * of their models and nothing on screen distinguishing that from a clean
 * import. Keyring writes cannot join the transaction — a different store
 * entirely — so they happen after the rows are committed, and a failure there
 * is reported as exactly what it is: the configuration landed, the keys did
 * not.
 */
export async function applyConfigImport(staged: StagedConfigImport): Promise<void> {
  const db = await configDb();
  await db.execute("BEGIN");
  try {
    for (const { apiKey: _apiKey, ...provider } of staged.providers) await saveProvider(db, provider);
    for (const m of staged.models) await saveModel(db, m);
    for (const p of staged.prompts) await savePrompt(db, p);
    await db.execute("COMMIT");
  } catch (e) {
    await db.execute("ROLLBACK").catch(() => { /* the failure below is the one that matters */ });
    throw e;
  }

  // Preferences are not part of the transaction and deliberately land after
  // it: they are the cosmetic half of the restore, and a failure here must not
  // roll back the configuration that already succeeded.
  applyPrefEntries(staged.prefs);

  const failed: string[] = [];
  for (const { id, name, apiKey } of staged.providers) {
    if (!apiKey) continue;
    try {
      await saveApiKey(id, apiKey);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length) {
    throw new Error(
      `Imported the configuration, but could not store the API key for: ${failed.join(", ")}. Enter those keys by hand.`,
    );
  }
}
