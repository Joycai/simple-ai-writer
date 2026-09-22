import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  listProviders, saveProvider, deleteProvider, providerOrderUpdate,
  listModels, saveModel, deleteModel,
  listPrompts, savePrompt, deletePrompt,
  ensureAiSchema, canAutoSelectAsChat,
  type Provider, type Model, type Prompt,
} from "../lib/ai/configDb";
import { normalizeChannel, routeProvider } from "../lib/ai/routes";
import { attachFees } from "../lib/ai/configDb";
import { feeGroupDeleteStatements, feeGroupUpsert, listFeeGroups } from "../lib/ai/feeGroupDb";
import type { FeeGroup } from "../lib/ai/feeGroup";
import { mergeStatements, planMerge, type MergePlan } from "../lib/ai/channelMerge";
import { remapUsageModelIds } from "../lib/ai/usage";
import type { ProtocolFamily } from "../lib/ai/types";
import { moveId, type ProviderMove } from "../lib/ai/providerOrder";
import { fetchRemoteModels } from "../lib/ai/providerProbe";
import { saveApiKey, loadApiKey, deleteApiKey, migrateLegacyKeys } from "../lib/keyStore";
import { getGlobalDb, getGlobalDbPath } from "../lib/project";
import { backfillUsagePartsQuietly } from "../lib/ai/usageBackfill";
import { sqlTransaction } from "../lib/sqlTx";
import { deletePref, readPref, writePref } from "../lib/prefs";
import {
  SUBAGENT_KINDS,
  type SubAgentConfig,
  type SubAgentKind,
} from "../lib/agent/subagentModel";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Which model is selected for what is a preference, not configuration, so it
 * goes through `lib/prefs` beside the rest of them rather than into the
 * providers/models tables next to the thing it points at.
 */
const SELECTION_KEYS = {
  activeModelId: "ai:activeModelId",
  activePromptId: "ai:activePromptId",
  memoryModelId: "ai:memoryModelId",
  imageModelId: "ai:imageModelId",
} as const;

type SelectionField = keyof typeof SELECTION_KEYS;

function readSelection(field: SelectionField): string | null {
  return readPref(SELECTION_KEYS[field]);
}

function writeSelection(field: SelectionField, value: string | null): void {
  if (value) writePref(SELECTION_KEYS[field], value);
  else deletePref(SELECTION_KEYS[field]);
}

function readSubAgent(kind: SubAgentKind): SubAgentConfig {
  const modelId = readPref(`ai:subagent:${kind}:modelId`) ?? null;
  const enabled = readPref(`ai:subagent:${kind}:enabled`);
  // Seed the imagegen subagent from the pre-subagent image-model pick. Before
  // the kind existed, the agent's image tools drew with `ai:imageModelId` and
  // were always on — an author who used them would otherwise find the
  // assistant silently unable to draw after an update, with nothing saying
  // why. Untouched prefs only (both keys absent): the first explicit change
  // persists real values (see the store subscription) and this derivation
  // stops applying.
  if (kind === "imagegen" && modelId === null && enabled === null) {
    const legacy = readPref("ai:imageModelId");
    if (legacy) return { kind, modelId: legacy, enabled: true };
  }
  return { kind, modelId, enabled: enabled === "true" };
}

function readAllSubAgents(): Record<SubAgentKind, SubAgentConfig> {
  const res = {} as Record<SubAgentKind, SubAgentConfig>;
  for (const k of SUBAGENT_KINDS) {
    res[k] = readSubAgent(k);
  }
  return res;
}

/**
 * The schema migration, shared by every caller instead of re-run per operation.
 *
 * `ensureAiSchema` is a "PRAGMA table_info → ALTER TABLE if missing" sequence
 * with no transaction around it, and this ran on every add/update/remove. Two
 * overlapping calls on a first launch after an upgrade both saw the column
 * missing and the second `ALTER` failed with `duplicate column name`, taking
 * the operation that triggered it down with it. Cleared on failure so a
 * genuine error can be retried.
 */
let schemaReady: Promise<void> | null = null;

/**
 * The one-shot sweep of the legacy plaintext key table, run alongside the
 * schema migration so it happens before anything reads the provider list.
 *
 * Never reset on failure and never rethrown: `migrateLegacyKeys` already
 * reports its own shortfalls and leaves un-migrated rows for the next launch,
 * and a cleanup pass has no business failing the config load that triggered
 * it.
 */
let legacyKeysSwept: Promise<void> | null = null;

/**
 * 总账里老行的分项回填，一次就好，跟在 schema 后面。
 *
 * 和上面那个清理一样：**失败不重置、不抛出**。回填失败只是有些行在用量页里
 * 停在「未分项」，而一个补历史数据的动作没有资格让触发它的配置加载失败。
 * 项目库那一份在 `lib/project` 的 `initSchema` 里，各走各的。
 */
let usagePartsBackfilled: Promise<void> | null = null;

async function db() {
  const globalDb = await getGlobalDb();
  if (!schemaReady) {
    schemaReady = ensureAiSchema(globalDb).catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  await schemaReady;
  if (!legacyKeysSwept) {
    legacyKeysSwept = migrateLegacyKeys()
      .then((r) => {
        if (r.migrated > 0) {
          console.info(`[aiStore] moved ${r.migrated} stored API key(s) out of the config database.`);
        }
      })
      .catch((e) => console.warn("[aiStore] legacy key sweep failed:", e));
  }
  await legacyKeysSwept;
  if (!usagePartsBackfilled) {
    usagePartsBackfilled = getGlobalDbPath().then((path) =>
      backfillUsagePartsQuietly(globalDb, path),
    );
  }
  await usagePartsBackfilled;
  return globalDb;
}

interface AiState {
  providers: Provider[];
  models: Model[];
  prompts: Prompt[];
  /**
   * 计费组（lib/ai/feeGroup）。价格从模型行上搬出来之后，它是「一次请求
   * 多少钱」的唯一来源；模型只持有一个 id，解析出来的 `Model.fee` 由
   * `attachFees` 挂上——所以改一个组，绑着它的模型下一次请求就按新价算。
   */
  feeGroups: FeeGroup[];
  activeModelId: string | null;
  activePromptId: string | null;
  /** Model used for Story-Memory summarization; falls back to activeModelId. */
  memoryModelId: string | null;
  /**
   * Model used to generate pictures. Unlike memoryModelId there is no fallback:
   * activeModelId is a text model and would only produce a confusing error, so
   * the image UI stays disabled until an `image`-type model is picked.
   */
  imageModelId: string | null;
  subAgents: Record<SubAgentKind, SubAgentConfig>;
  isLoading: boolean;

  loadConfig: () => Promise<void>;
  /**
   * Re-read every selection (main / prompt / memory / image model, subagent
   * bindings) from `lib/prefs`. Only a config restore needs this: the store
   * reads them once at module scope, so selections a restore wrote into prefs
   * are invisible here — and the subscription below would write the stale
   * in-memory ones back over them at the next change. Call before `loadConfig`,
   * so its stale-id sweep checks the restored ids rather than the old ones.
   */
  reloadSelections: () => void;

  addProvider: (p: Omit<Provider, "id" | "createdAt">, apiKey: string) => Promise<string>;
  updateProvider: (p: Provider, apiKey?: string) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  /**
   * Fold channel `absorbId` into `keepId` (lib/ai/channelMerge, 设计稿 05k 屏 07):
   * the rows in one transaction, every selection and subagent binding that
   * named a merged-away model re-pointed, the open project's usage rows
   * re-pointed, and only then the absorbed channel's key deleted — the reverse
   * of appReset's order, because here the database must stop referring to the
   * key before the key goes.
   */
  mergeProviders: (keepId: string, absorbId: string, projectPath?: string | null) => Promise<MergePlan>;
  /** 置顶/上移/下移/置底 — reorders the provider list and persists it. */
  moveProvider: (id: string, move: ProviderMove) => Promise<void>;
  getApiKey: (providerId: string) => Promise<string | null>;

  /** 新建 / 改一个组。改了价之后 `models` 上挂的 `fee` 一并刷新。 */
  saveFeeGroup: (g: Omit<FeeGroup, "id" | "createdAt"> & { id?: string; createdAt?: number }) => Promise<string>;
  /**
   * 删一个组。引用置空、模型不删、**用量行一分不动**——每一行都抄着当时
   * 的价，历史不会因为今天删了一个组而变。
   */
  removeFeeGroup: (id: string) => Promise<void>;

  addModel: (m: Omit<Model, "id">) => Promise<void>;
  updateModel: (m: Model) => Promise<void>;
  removeModel: (id: string) => Promise<void>;
  /** The channel's model list, asked of `route` (its primary route when absent). */
  fetchAndImportModels: (providerId: string, route?: ProtocolFamily) => Promise<{ id: string; name: string }[]>;

  addPrompt: (p: Omit<Prompt, "id">) => Promise<string>;
  /** Records one insertion (drives the picker's 「常用」 section). Fire and
   *  forget — a failed bookkeeping write must never block the insert. */
  noteSnippetUsed: (id: string) => Promise<void>;
  updatePrompt: (p: Prompt) => Promise<void>;
  removePrompt: (id: string) => Promise<void>;

  setActiveModel: (id: string) => void;
  setActivePrompt: (id: string) => void;
  setMemoryModel: (id: string | null) => void;
  setImageModel: (id: string | null) => void;
  setSubAgent: (kind: SubAgentKind, patch: Partial<Omit<SubAgentConfig, "kind">>) => void;
}

export const useAiStore = create<AiState>((set, get) => ({
  providers: [],
  models: [],
  prompts: [],
  feeGroups: [],
  activeModelId: readSelection("activeModelId"),
  activePromptId: readSelection("activePromptId"),
  memoryModelId: readSelection("memoryModelId"),
  imageModelId: readSelection("imageModelId"),
  subAgents: readAllSubAgents(),
  isLoading: false,

  loadConfig: async () => {
    if (!isTauri) return;
    set({ isLoading: true });
    try {
      const d = await db();
      const [providers, models, prompts, feeGroups] = await Promise.all([
        listProviders(d),
        listModels(d),
        listPrompts(d),
        listFeeGroups(d),
      ]);
      // `listModels` 已经把组解析进 `Model.fee` 了（同一个库、同一次读），
      // 所以这里不用再 attach 一遍。
      set({ providers, models, prompts, feeGroups });
      // A restored selection can outlive what it pointed at: the model may
      // have been deleted on another launch, or the config replaced by an
      // import from a different machine, where the ids are all different.
      // Verify each one against what actually loaded before trusting it.
      const modelIds = new Set(models.map((m) => m.id));
      const promptIds = new Set(prompts.map((p) => p.id));
      const s = get();
      const liveModel = (id: string | null) => (id && modelIds.has(id) ? id : null);
      const liveSubAgents = { ...s.subAgents };
      for (const k of SUBAGENT_KINDS) {
        const modelId = liveModel(liveSubAgents[k].modelId);
        // Replace the object only when the id actually went stale. The
        // persistence subscription compares by reference, so a fresh object
        // for an unchanged binding rewrites its prefs — which after a config
        // import wrote this window's old bindings over the restored ones.
        if (modelId !== liveSubAgents[k].modelId) {
          liveSubAgents[k] = { ...liveSubAgents[k], modelId };
        }
      }
      set({
        activeModelId: liveModel(s.activeModelId) ?? models.find(canAutoSelectAsChat)?.id ?? null,
        memoryModelId: liveModel(s.memoryModelId),
        imageModelId: liveModel(s.imageModelId),
        subAgents: liveSubAgents,
        activePromptId: s.activePromptId && promptIds.has(s.activePromptId) ? s.activePromptId : null,
      });
    } finally {
      set({ isLoading: false });
    }
  },

  reloadSelections: () =>
    set({
      activeModelId: readSelection("activeModelId"),
      activePromptId: readSelection("activePromptId"),
      memoryModelId: readSelection("memoryModelId"),
      imageModelId: readSelection("imageModelId"),
      subAgents: readAllSubAgents(),
    }),

  addProvider: async (p, apiKey) => {
    // Normalized in memory the way listProviders normalizes a row read back
    // (routes filled, flat fields = primary route, platform resolved), so a
    // provider added from a surface that names neither a platform nor routes
    // (onboarding) doesn't read differently until the next launch.
    const provider = normalizeChannel({ ...p, id: nanoid(), createdAt: Date.now() });
    if (isTauri) {
      const d = await db();
      await saveProvider(d, provider);
      await saveApiKey(provider.id, apiKey);
    }
    set((s) => ({ providers: [...s.providers, provider] }));
    return provider.id;
  },

  updateProvider: async (p, apiKey) => {
    const resolved = normalizeChannel(p);
    if (isTauri) {
      const d = await db();
      await saveProvider(d, resolved);
      if (apiKey !== undefined) await saveApiKey(p.id, apiKey);
    }
    set((s) => ({ providers: s.providers.map((x) => (x.id === p.id ? resolved : x)) }));
  },

  removeProvider: async (id) => {
    if (isTauri) {
      const d = await db();
      await deleteProvider(d, id);
      await deleteApiKey(id);
    }
    set((s) => {
      const removedIds = new Set(
        s.models.filter((m) => m.providerId === id).map((m) => m.id),
      );
      const cleanSubs = { ...s.subAgents };
      for (const k of SUBAGENT_KINDS) {
        if (cleanSubs[k].modelId && removedIds.has(cleanSubs[k].modelId!)) {
          cleanSubs[k] = { ...cleanSubs[k], modelId: null };
        }
      }
      return {
        providers: s.providers.filter((p) => p.id !== id),
        models: s.models.filter((m) => m.providerId !== id),
        activeModelId: s.activeModelId && removedIds.has(s.activeModelId) ? null : s.activeModelId,
        memoryModelId: s.memoryModelId && removedIds.has(s.memoryModelId) ? null : s.memoryModelId,
        imageModelId: s.imageModelId && removedIds.has(s.imageModelId) ? null : s.imageModelId,
        subAgents: cleanSubs,
      };
    });
  },

  mergeProviders: async (keepId, absorbId, projectPath) => {
    const cur = get();
    const keep = cur.providers.find((p) => p.id === keepId);
    const absorb = cur.providers.find((p) => p.id === absorbId);
    if (!keep || !absorb || keep.id === absorb.id) throw new Error("Provider not found");
    const plan = planMerge(keep, absorb, cur.models);
    if (isTauri) {
      await db();
      await sqlTransaction(await getGlobalDbPath(), mergeStatements(plan, absorbId));
    }
    const re = (id: string | null) => (id && plan.remap[id]) || id;
    set((s) => {
      const upserted = new Map(plan.upserts.map((m) => [m.id, m]));
      const gone = new Set(plan.deletes);
      const subAgents = { ...s.subAgents };
      for (const k of SUBAGENT_KINDS) {
        const to = re(subAgents[k].modelId);
        // Replace only what changed — the persistence subscription compares by reference.
        if (to !== subAgents[k].modelId) subAgents[k] = { ...subAgents[k], modelId: to };
      }
      return {
        providers: s.providers.filter((p) => p.id !== absorbId).map((p) => (p.id === keepId ? plan.channel : p)),
        models: s.models.filter((m) => !gone.has(m.id)).map((m) => upserted.get(m.id) ?? m),
        activeModelId: re(s.activeModelId),
        memoryModelId: re(s.memoryModelId),
        imageModelId: re(s.imageModelId),
        subAgents,
      };
    });
    // 项目那份可能没有（没开项目），总账那份一定在：不改它，合并掉的模型
    // 会在「全部」范围里永远显示成一个叫不出名字的 id。
    await remapUsageModelIds(projectPath ?? null, plan.remap);
    if (isTauri) {
      try {
        await deleteApiKey(absorbId);
      } catch (e) {
        console.warn("[aiStore] merged channel's key could not be removed from the keyring:", e);
      }
    }
    return plan;
  },

  moveProvider: async (id, move) => {
    const cur = get().providers;
    const order = moveId(cur.map((p) => p.id), id, move);
    if (!order) return;
    const byId = new Map(cur.map((p) => [p.id, p]));
    // Positions are rewritten for the WHOLE list, not just the moved row:
    // never-moved providers carry no sortOrder and sort after all ordered ones
    // (see Provider.sortOrder), so moving one row "above" an unordered row
    // would otherwise not actually place it there.
    const providers = order.map((pid, i) => ({ ...byId.get(pid)!, sortOrder: i }));
    if (isTauri) {
      // db() first: it runs the schema migration that adds sort_order — a
      // first move right after an upgrade must not race the ALTER TABLE.
      await db();
      await sqlTransaction(
        await getGlobalDbPath(),
        providers.map((p) => providerOrderUpdate(p.id, p.sortOrder)),
      );
    }
    set({ providers });
  },

  getApiKey: (providerId) => loadApiKey(providerId),

  saveFeeGroup: async (g) => {
    const group: FeeGroup = {
      ...g,
      id: g.id ?? nanoid(),
      createdAt: g.createdAt ?? Math.floor(Date.now() / 1000),
    };
    if (isTauri) {
      const d = await db();
      const { sql, values } = feeGroupUpsert(group);
      await d.execute(sql, values);
    }
    set((s) => {
      const feeGroups = s.feeGroups.some((x) => x.id === group.id)
        ? s.feeGroups.map((x) => (x.id === group.id ? group : x))
        : [...s.feeGroups, group];
      // 价变了，挂在模型上的那份解析结果就过期了——重挂一次，而不是让
      // 每个算钱的调用点自己去想「我手里这份还新鲜吗」。
      return { feeGroups, models: attachFees(s.models, feeGroups) };
    });
    return group.id;
  },

  removeFeeGroup: async (id) => {
    if (isTauri) {
      // 事务走文件而不是这个句柄：SQL 插件是连接池，`sqlTransaction` 要自己
      // 开一条连接（lib/sqlTx）。先 `db()` 一次确保表结构已经就位。
      await db();
      // 三条语句一个事务：半删掉的组会让模型指着一个不存在的 id。
      await sqlTransaction(await getGlobalDbPath(), feeGroupDeleteStatements(id));
    }
    set((s) => {
      const feeGroups = s.feeGroups.filter((g) => g.id !== id);
      const models = s.models.map((m) => (m.feeGroupId === id ? { ...m, feeGroupId: undefined } : m));
      const providers = s.providers.map((p) =>
        p.defaultFeeGroupId === id ? { ...p, defaultFeeGroupId: undefined } : p,
      );
      return { feeGroups, providers, models: attachFees(models, feeGroups) };
    });
  },

  addModel: async (m) => {
    const model: Model = { ...m, id: nanoid() };
    if (isTauri) {
      const d = await db();
      await saveModel(d, model);
    }
    set((s) => ({ models: [...s.models, model] }));
    if (!get().activeModelId && canAutoSelectAsChat(model)) set({ activeModelId: model.id });
  },

  updateModel: async (m) => {
    if (isTauri) {
      const d = await db();
      await saveModel(d, m);
    }
    set((s) => ({ models: s.models.map((x) => (x.id === m.id ? m : x)) }));
  },

  removeModel: async (id) => {
    if (isTauri) {
      const d = await db();
      await deleteModel(d, id);
    }
    set((s) => {
      const cleanSubs = { ...s.subAgents };
      for (const k of SUBAGENT_KINDS) {
        if (cleanSubs[k].modelId === id) {
          cleanSubs[k] = { ...cleanSubs[k], modelId: null };
        }
      }
      return {
        models: s.models.filter((m) => m.id !== id),
        activeModelId: s.activeModelId === id ? null : s.activeModelId,
        memoryModelId: s.memoryModelId === id ? null : s.memoryModelId,
        imageModelId: s.imageModelId === id ? null : s.imageModelId,
        subAgents: cleanSubs,
      };
    });
  },

  fetchAndImportModels: async (providerId, route) => {
    const channel = get().providers.find((p) => p.id === providerId);
    const provider = channel ? routeProvider(channel, route) : undefined;
    if (!provider) throw new Error("Provider not found");
    const apiKey = await loadApiKey(providerId) ?? "";
    return fetchRemoteModels(provider.baseUrl, apiKey, provider.apiStandard, provider.authMode);
  },

  addPrompt: async (p) => {
    const prompt: Prompt = { ...p, id: nanoid() };
    if (isTauri) {
      const d = await db();
      await savePrompt(d, prompt);
    }
    set((s) => ({ prompts: [...s.prompts, prompt] }));
    return prompt.id;
  },

  noteSnippetUsed: async (id) => {
    const prompt = get().prompts.find((p) => p.id === id);
    if (!prompt) return;
    const next: Prompt = {
      ...prompt,
      useCount: (prompt.useCount ?? 0) + 1,
      lastUsedAt: Date.now(),
    };
    set((s) => ({ prompts: s.prompts.map((p) => (p.id === id ? next : p)) }));
    if (isTauri) {
      const d = await db();
      await savePrompt(d, next);
    }
  },

  // `savePrompt` is an INSERT OR REPLACE, so an edit is the same write as an
  // add — only the id differs in where it comes from.
  updatePrompt: async (prompt) => {
    if (isTauri) {
      const d = await db();
      await savePrompt(d, prompt);
    }
    set((s) => ({ prompts: s.prompts.map((p) => (p.id === prompt.id ? prompt : p)) }));
  },

  removePrompt: async (id) => {
    if (isTauri) {
      const d = await db();
      await deletePrompt(d, id);
    }
    set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) }));
  },

  setActiveModel: (id) => set({ activeModelId: id }),
  setActivePrompt: (id) => set({ activePromptId: id }),
  setMemoryModel: (id) => set({ memoryModelId: id }),
  setImageModel: (id) => set({ imageModelId: id }),
  setSubAgent: (kind, patch) =>
    set((s) => ({
      subAgents: {
        ...s.subAgents,
        [kind]: { ...s.subAgents[kind], ...patch },
      },
    })),
}));

/**
 * Persist the selections by observing the store rather than writing at each
 * call site. They change from the setters, from removeModel/removeProvider
 * clearing a deleted pointer, and from loadConfig's stale-id sweep — and a
 * missed site is a preference that silently fails to stick, which is exactly
 * the bug this replaced.
 */
useAiStore.subscribe((state, prev) => {
  for (const field of Object.keys(SELECTION_KEYS) as SelectionField[]) {
    if (state[field] !== prev[field]) writeSelection(field, state[field]);
  }
  for (const k of SUBAGENT_KINDS) {
    if (state.subAgents[k] !== prev.subAgents[k]) {
      const cur = state.subAgents[k];
      if (cur.modelId) writePref(`ai:subagent:${k}:modelId`, cur.modelId);
      else deletePref(`ai:subagent:${k}:modelId`);
      writePref(`ai:subagent:${k}:enabled`, String(cur.enabled));
    }
  }
});
