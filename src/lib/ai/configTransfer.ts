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
import { loadCustomFormats, saveCustomFormat } from "../docx/presets";
import { parseDocFormat, type DocFormatPreset } from "../docx/format";
import {
  ensureAiSchema,
  listModels,
  listPrompts,
  listProviders,
  modelUpsert,
  parseTranslateFormat,
  promptUpsert,
  providerUpsert,
  type Model,
  type ModelType,
  type Prompt,
  type Provider,
} from "./configDb";
import { parseReasoningEffort, parseThinkingCategory, parseThinkingDialect } from "./reasoning";
import { parseServerTools } from "./serverTools";
import { parseStructuredOutputMode } from "./jsonMode";
import { authModesFor, type ApiStandard, type AuthMode } from "./types";
import { migrateLegacyStandard } from "./urls";
import { loadApiKey, saveApiKey } from "../keyStore";
import { applyPrefEntries, portablePrefEntries } from "../prefs";
import { getGlobalDb, getGlobalDbPath } from "../project";
import { sqlTransaction } from "../sqlTx";
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
  /**
   * The author's own 排版格式 presets. Absent in backups written before Word
   * export shipped — the same forward-compatible shape `prefs` uses, so an old
   * backup restores without them rather than failing.
   */
  docFormats?: DocFormatPreset[];
}

async function configDb() {
  const db = await getGlobalDb();
  await ensureAiSchema(db);
  return db;
}

/**
 * Collect the whole configuration into one bundle.
 *
 * Split out of `exportAiConfig` because the file dialog is not the only way out
 * any more: `lib/configsync` seals this same bundle into an envelope and pushes
 * it to the sync server. Keeping one builder means the two routes can never
 * disagree about what "my configuration" is — the failure mode would be a
 * server backup that quietly carries less than the file export does.
 */
export async function buildConfigBundle(includeKeys: boolean): Promise<ConfigBackup> {
  const db = await configDb();
  const [providers, models, prompts, docFormats] = await Promise.all([
    listProviders(db),
    listModels(db),
    listPrompts(db),
    // Installation-level like everything else here: one 公文 format is reused
    // across every project, so it belongs in the thing you carry to a new
    // machine. Failing to read them must not sink the whole backup.
    loadCustomFormats().catch(() => [] as DocFormatPreset[]),
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

  return {
    kind: CONFIG_BACKUP_KIND,
    version: CONFIG_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion,
    providers: providerBackups,
    models,
    prompts,
    prefs: portablePrefEntries(),
    docFormats,
  };
}

/**
 * Export the whole AI config as a JSON file via the native save dialog.
 * Returns the saved path, or null when the user cancelled.
 */
export async function exportAiConfig(includeKeys: boolean): Promise<string | null> {
  const bundle = await buildConfigBundle(includeKeys);
  const date = new Date().toISOString().slice(0, 10);
  return saveTextFileDialog(
    JSON.stringify(bundle, null, 2),
    `ai-writer-config-${date}.json`,
    "JSON",
    ["json"],
  );
}

/** A validated bundle, whatever it arrived in — a file, or a server envelope. */
export interface ParsedConfigBundle {
  providers: ProviderBackup[];
  models: Model[];
  prompts: Prompt[];
  prefs: [string, string][];
  docFormats: DocFormatPreset[];
  /** How many imported providers carry an embedded API key. */
  keyCount: number;
}

export interface StagedConfigImport extends ParsedConfigBundle {
  path: string;
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
 * Validate a parsed backup into something `applyConfigImport` can merge.
 *
 * Throws `Error("invalid-backup")` when this is not a config backup at all.
 * Malformed individual entries are dropped, and models whose provider is
 * neither in the backup nor already configured are dropped too.
 *
 * Separate from the file dialog because a bundle now also arrives from the sync
 * server, and both routes must apply *this* validation — it is where the
 * hard-won degradations live (an unknown `reasoningEffort` must reach the wire
 * as nothing; an unknown `translateFormat` must degrade to an ordinary model
 * rather than hide it from every picker). A second validator written for the
 * server route would drift from these within one release.
 */
export function parseConfigBundle(
  raw: unknown,
  existingProviderIds: string[],
): ParsedConfigBundle {
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
      // Absent stays absent — "never moved" must survive a backup round-trip
      // rather than becoming position 0.
      sortOrder: typeof r.sortOrder === "number" ? r.sortOrder : undefined,
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
      temperature: typeof r.temperature === "number" ? r.temperature : undefined,
      probedAt: typeof r.probedAt === "number" ? r.probedAt : undefined,
      // Parsed rather than cast: a backup written by a newer build (or edited by
      // hand) can carry a level this build doesn't know, and an unknown level
      // must degrade to "send nothing" rather than reach the wire.
      reasoningEffort: parseReasoningEffort(r.reasoningEffort),
      thinkingDialect: parseThinkingDialect(r.thinkingDialect),
      thinkingCategory: parseThinkingCategory(r.thinkingCategory),
      thinkingBudget: typeof r.thinkingBudget === "number" ? r.thinkingBudget : undefined,
      serverTools: parseServerTools(r.serverTools),
      pdfInput: r.pdfInput === true ? true : undefined,
      // Same reason as the reasoning fields above: an unknown format from a
      // newer build must degrade to "an ordinary model" rather than mark a
      // usable model translation-only and hide it from every picker.
      translateFormat: parseTranslateFormat(r.translateFormat),
      // Unknown value → auto, which sends what an undeclared model always sent.
      structuredOutput: parseStructuredOutputMode(r.structuredOutput),
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
    // The snippet fields are optional: a bundle written before the snippet
    // library existed has none, and a restored snippet with no group simply
    // lands in 「未分组」 — the same place a fresh right-click save lands.
    prompts.push({
      id, name, content: r.content, scene,
      group: str(r.grp) || str(r.group) || "",
      useCount: typeof r.useCount === "number" ? r.useCount : 0,
      lastUsedAt: typeof r.lastUsedAt === "number" ? r.lastUsedAt : 0,
    });
  }

  // Shape-checked here; which keys are actually allowed through is `lib/prefs`'
  // call, made again at apply time so a hand-edited file can't slip one past.
  const prefs: [string, string][] = (Array.isArray(root.prefs) ? root.prefs : [])
    .filter(
      (e): e is [string, string] =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
    );

  // 排版格式：`parseDocFormat` 归一而不是拒绝——一个字段坏了不该让整套预设
  // 消失，而缺的那一项本来就该落回默认。只有 id/名字都没有的条目才丢掉。
  const docFormats: DocFormatPreset[] = [];
  for (const item of Array.isArray(root.docFormats) ? root.docFormats : []) {
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    const label = str(r.label);
    if (!id || !label) continue;
    docFormats.push({
      id,
      label,
      // 备份里的一律当自建：内置那几套随版本走，不该被一份旧备份改写。
      builtin: false,
      ...(str(r.imitatedFrom) ? { imitatedFrom: r.imitatedFrom as string } : {}),
      format: parseDocFormat(r.format),
    });
  }

  if (
    providers.length === 0 &&
    models.length === 0 &&
    prompts.length === 0 &&
    prefs.length === 0 &&
    docFormats.length === 0
  ) {
    throw new Error("invalid-backup");
  }

  return {
    providers,
    models,
    prompts,
    prefs,
    docFormats,
    keyCount: providers.filter((p) => p.apiKey).length,
  };
}

/**
 * Phase 1 of restore: pick a backup file and validate it. Returns null when
 * the user cancelled; throws `Error("invalid-backup")` when the file is not a
 * config backup.
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
  return { path: picked.path, ...parseConfigBundle(raw, existingProviderIds) };
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
 *
 * That transaction runs through `sqlTransaction`, **not** as `db.execute`d
 * BEGIN/COMMIT around the usual per-row helpers. The SQL plugin hands out a
 * connection pool, so those three calls were three different connections: the
 * writes ended up outside the transaction the BEGIN had opened, and once one of
 * them landed inside it, the connection holding the write lock made every later
 * statement fail with `(code: 5) database is locked` — the import error this
 * restore reported for a config it could have merged fine. See lib/sqlTx.
 *
 * Providers are written before the models that reference them: sqlx connects
 * with `foreign_keys = ON`, and `models.provider_id` is a real foreign key.
 */
export async function applyConfigImport(staged: ParsedConfigBundle): Promise<void> {
  // Not for the writes below — this is what guarantees the tables and their
  // added columns exist before the transaction's own connection touches them.
  await configDb();

  await sqlTransaction(await getGlobalDbPath(), [
    ...staged.providers.map(({ apiKey: _apiKey, ...provider }) => providerUpsert(provider)),
    ...staged.models.map(modelUpsert),
    ...staged.prompts.map(promptUpsert),
  ]);

  // Preferences are not part of the transaction and deliberately land after
  // it: they are the cosmetic half of the restore, and a failure here must not
  // roll back the configuration that already succeeded.
  applyPrefEntries(staged.prefs);

  // Same reasoning, plus one of its own: 排版格式 has no foreign key into
  // anything above, so putting it inside that transaction would only widen the
  // window in which a locked database can undo a restore that had succeeded.
  for (const preset of staged.docFormats) {
    try {
      await saveCustomFormat(preset);
    } catch (e) {
      console.warn(`[config] 排版格式 ${preset.id} 没能写入：`, e);
    }
  }

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
