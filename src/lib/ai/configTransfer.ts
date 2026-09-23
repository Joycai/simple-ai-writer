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
import { parseTextVerbosity } from "./types";
import { clampVideoFps } from "./videoInput";
import {
  ensureAiSchema,
  listModels,
  listPrompts,
  listProviders,
  modelUpsert,
  normalizeAsrIdentity,
  parseModelType,
  parseTranslateFormat,
  parseAsrFormat,
  parseImageCaps,
  promptUpsert,
  providerUpsert,
  readChannel,
  type Model,
  type Prompt,
  type Provider,
} from "./configDb";
import { parseEndpoints, parseRouteFamily, parseRouteProfiles } from "./routes";
import { feeGroupUpsert, listFeeGroups, rowToFeeGroup } from "./feeGroupDb";
import type { FeeGroup } from "./feeGroup";
import { parseReasoningEffort, parseThinkingCategory, parseThinkingDialect } from "./reasoning";
import { parseServerTools } from "./serverTools";
import { parsePlatform } from "./platforms";
import { parseStructuredOutputMode } from "./jsonMode";
import { authModesFor, type ApiStandard, type AuthMode } from "./types";
import { migrateLegacyStandard } from "./urls";
import { loadApiKey, saveApiKey } from "../keyStore";
import { applyPrefEntries, portablePrefEntries } from "../prefs";
import { getGlobalDb, getGlobalDbPath } from "../project";
import { sqlTransaction } from "../sqlTx";
import { openTextFileDialog, saveTextFileDialog } from "../fs/transfer";

export const CONFIG_BACKUP_KIND = "ai-writer-config-backup";
/**
 * 2: channels carry `host` + `endpoints`, models `activeRoute` + `routes`
 * (channel-model-route-plan.md §5.4). A v1 bundle reads through the same
 * normalization a pre-routes DB row does (`readChannel`), so there is one
 * migration, not two. A build that knows only v1 refuses a v2 bundle — the
 * version check below was always there for exactly this.
 */
/**
 * 3：价格从模型行搬进**计费组**（`fee_groups`），模型只持有 `feeGroupId`，
 * 渠道带一个 `defaultFeeGroupId`（docs/feature/billing/01-fee-groups.md）。
 *
 * v2 的包读得进来：它的模型行还带着 `priceIn` / `pricePerImage` 这些旧列，
 * 落库之后 `ensureAiSchema` 的那一步迁移（`fee_migrated` 为 NULL 的行）会
 * 把它们归并成组——和一台机器从老版本升上来走的是同一条路，不是第二条。
 * 只认 v2 的构建会**整体拒绝**一个 v3 的包，而不是导到一半：版本检查一直
 * 就是为这件事准备的。
 *
 * 计费组后来多了一个可空的 `vendor`（厂商，只用来把列表分段），**没有涨到 4**：
 * 版本号该涨的条件是「老版本读到新格式会出错或读错」，而这里两个方向都是合法
 * 状态——老版本读新包，没人读那一键，厂商丢掉而价格一个字段不差；新版本读老包，
 * 厂商读成空。为一个整理标签涨版本号，只会让老版本整体拒掉一份价格完整的备份。
 */
const CONFIG_BACKUP_VERSION = 3;

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
  /** 计费组。v2 及更早的包没有这一项——它们的价还在模型行上。 */
  feeGroups?: FeeGroup[];
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
  const [providers, models, prompts, feeGroups, docFormats] = await Promise.all([
    listProviders(db),
    listModels(db),
    listPrompts(db),
    // 价跟着配置走：只带模型而不带它绑的组，导到新机器上每个模型都会变成
    // 「未绑定」，而那种缺失不报错，只是从此一分钱记不出来。
    listFeeGroups(db),
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
    feeGroups,
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
  feeGroups: FeeGroup[];
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
  "openai_responses",
  "openai_responses_compat",
  "gemini",
  "gemini_compat",
  "anthropic",
  "anthropic_compat",
];

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
    const channel = readChannel({
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
      // A backup from before platforms existed has none: inferred from the
      // address, the same answer reading an old DB row gives. An id this
      // build doesn't know reads as `custom` (parsePlatform).
      platform: parsePlatform(r.platform),
      // 这个渠道下新模型预填的计费组。v2 及更早的包没有它——那时价还在
      // 模型行上，没有组可以指。
      defaultFeeGroupId: str(r.defaultFeeGroupId) || undefined,
      // v1 has neither: readChannel builds the one route the flat fields
      // describe, exactly as for a pre-routes DB row.
      host: typeof r.host === "string" ? r.host : undefined,
      endpoints: parseEndpoints(r.endpoints),
      createdAt: num(r.createdAt, Date.now()),
    });
    providers.push({ ...channel, ...(str(r.apiKey) ? { apiKey: r.apiKey as string } : {}) });
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
    // Normalised like a DB row: a backup from before `asr` was a type carries
    // the identity on `asrFormat` alone and must not land in the chat pickers.
    models.push(normalizeAsrIdentity({
      id,
      providerId,
      modelId,
      name,
      type: parseModelType(r.type),
      priceIn: num(r.priceIn),
      priceCachedIn: num(r.priceCachedIn),
      priceOut: num(r.priceOut),
      enabled: r.enabled !== false,
      prefix: str(r.prefix) ?? undefined,
      contextSize: typeof r.contextSize === "number" ? r.contextSize : undefined,
      maxOutput: typeof r.maxOutput === "number" ? r.maxOutput : undefined,
      temperature: typeof r.temperature === "number" ? r.temperature : undefined,
      probedAt: typeof r.probedAt === "number" ? r.probedAt : undefined,
      probedContextSize: typeof r.probedContextSize === "number" ? r.probedContextSize : undefined,
      probedMaxOutput: typeof r.probedMaxOutput === "number" ? r.probedMaxOutput : undefined,
      // Parsed rather than cast: a backup written by a newer build (or edited by
      // hand) can carry a level this build doesn't know, and an unknown level
      // must degrade to "send nothing" rather than reach the wire.
      reasoningEffort: parseReasoningEffort(r.reasoningEffort),
      thinkingDialect: parseThinkingDialect(r.thinkingDialect),
      thinkingCategory: parseThinkingCategory(r.thinkingCategory),
      thinkingBudget: typeof r.thinkingBudget === "number" ? r.thinkingBudget : undefined,
      serverTools: parseServerTools(r.serverTools),
      pdfInput: r.pdfInput === true ? true : undefined,
      vlHighResolution: r.vlHighResolution === true ? true : undefined,
      videoInput: r.videoInput === true ? true : undefined,
      // Clamped like a DB row: a hand-edited backup must not put fps 500 on the wire.
      videoFps: clampVideoFps(r.videoFps),
      // Unknown level → absent, which sends nothing.
      textVerbosity: parseTextVerbosity(r.textVerbosity),
      // Same reason as the reasoning fields above: an unknown format from a
      // newer build must degrade to "an ordinary model" rather than mark a
      // usable model translation-only and hide it from every picker.
      translateFormat: parseTranslateFormat(r.translateFormat),
      // Same degradation for a transcription format this build doesn't know.
      asrFormat: parseAsrFormat(r.asrFormat),
      // 绑定的计费组。v2 及更早的包没有它，落库之后 `ensureAiSchema` 的
      // 那一步迁移会按旧价格列给这一行补上——和一台机器从老版本升上来
      // 走的是同一条路。
      feeGroupId: str(r.feeGroupId) || undefined,
      pricePerSecond: typeof r.pricePerSecond === "number" ? r.pricePerSecond : undefined,
      // Unknown value → auto, which sends what an undeclared model always sent.
      structuredOutput: parseStructuredOutputMode(r.structuredOutput),
      pricePerImage: typeof r.pricePerImage === "number" ? r.pricePerImage : undefined,
      // Field by field, not cast: the drawer and the image modal read these
      // without a second check, so a malformed value crashes a page later.
      caps: parseImageCaps(r.caps),
      activeRoute: parseRouteFamily(r.activeRoute),
      routes: parseRouteProfiles(r.routes),
    }));
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

  // 计费组：一行一行按列读回来（`rowToFeeGroup` 认的就是这些键），坏掉的
  // 格读作缺失而不是让整个包作废——和从库里读一行是同一条路径。
  const feeGroups: FeeGroup[] = [];
  for (const item of Array.isArray(root.feeGroups) ? root.feeGroups : []) {
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    feeGroups.push(rowToFeeGroup({
      id,
      name: r.name,
      vendor: r.vendor,
      billing_mode: r.billingMode,
      input_price: r.inputPrice,
      cache_input_price: r.cacheInputPrice,
      output_price: r.outputPrice,
      request_price: r.requestPrice,
      output_unit: r.outputUnit,
      // 库里这一列存的是 JSON 文本，备份里是数组——序列化一次再交给同一个
      // 解析器，「读一个组」就仍然只有一份代码。
      output_rates: JSON.stringify(Array.isArray(r.outputRates) ? r.outputRates : []),
      input_unit_price: r.inputUnitPrice,
      input_free_units: r.inputFreeUnits,
      sort_order: r.sortOrder,
      created_at: r.createdAt,
    }));
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
    feeGroups.length === 0 &&
    prefs.length === 0 &&
    docFormats.length === 0
  ) {
    throw new Error("invalid-backup");
  }

  return {
    providers,
    models,
    prompts,
    feeGroups,
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
 * That report is a **return value, not a throw.** A throw here meant "the
 * import failed" to both callers, so they skipped `refreshAfterConfigImport`
 * over rows that had in fact been committed — the stores kept showing the
 * pre-restore config, and saving from a stale drawer could overwrite what the
 * restore had just written. A throw from this function now means the rows did
 * not land; anything after the commit comes back in `ConfigImportResult`, and
 * `keyFailureMessage` words it.
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
export async function applyConfigImport(staged: ParsedConfigBundle): Promise<ConfigImportResult> {
  // Not for the writes below — this is what guarantees the tables and their
  // added columns exist before the transaction's own connection touches them.
  await configDb();

  await sqlTransaction(await getGlobalDbPath(), [
    // 组先于引用它的两张表：`models.fee_group_id` 与 `providers
    // .default_fee_group_id` 没有外键（组可以先于模型被删掉，引用置空就行），
    // 但让写入顺序自己成立比依赖「反正没约束」清楚。
    ...staged.feeGroups.map(feeGroupUpsert),
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
  return { failedKeys: failed };
}

/** What a restore that committed its rows still has to tell the author. */
export interface ConfigImportResult {
  /** Names of the providers whose embedded API key did not reach the keyring. */
  failedKeys: string[];
}

/** The author-facing sentence for `failedKeys`; null when every key landed. */
export function keyFailureMessage(failedKeys: string[]): string | null {
  if (!failedKeys.length) return null;
  return `Imported the configuration, but could not store the API key for: ${failedKeys.join(", ")}. Enter those keys by hand.`;
}
