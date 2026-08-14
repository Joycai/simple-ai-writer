import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  listProviders, saveProvider, deleteProvider,
  listModels, saveModel, deleteModel,
  listPrompts, savePrompt, deletePrompt,
  ensureAiSchema,
  type Provider, type Model, type Prompt,
} from "../lib/ai/configDb";
import { fetchRemoteModels } from "../lib/ai/providerProbe";
import { saveApiKey, loadApiKey, deleteApiKey, migrateLegacyKeys } from "../lib/keyStore";
import { getGlobalDb } from "../lib/project";
import { deletePref, readPref, writePref } from "../lib/prefs";
import {
  SUBAGENT_KINDS,
  type SubAgentConfig,
  type SubAgentKind,
} from "../lib/agent/subagent";

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
  return {
    kind,
    modelId: readPref(`ai:subagent:${kind}:modelId`) ?? null,
    enabled: readPref(`ai:subagent:${kind}:enabled`) === "true",
  };
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
  return globalDb;
}

interface AiState {
  providers: Provider[];
  models: Model[];
  prompts: Prompt[];
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

  addProvider: (p: Omit<Provider, "id" | "createdAt">, apiKey: string) => Promise<string>;
  updateProvider: (p: Provider, apiKey?: string) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  getApiKey: (providerId: string) => Promise<string | null>;

  addModel: (m: Omit<Model, "id">) => Promise<void>;
  updateModel: (m: Model) => Promise<void>;
  removeModel: (id: string) => Promise<void>;
  fetchAndImportModels: (providerId: string) => Promise<{ id: string; name: string }[]>;

  addPrompt: (p: Omit<Prompt, "id">) => Promise<void>;
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
      const [providers, models, prompts] = await Promise.all([
        listProviders(d),
        listModels(d),
        listPrompts(d),
      ]);
      set({ providers, models, prompts });
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
        liveSubAgents[k] = {
          ...liveSubAgents[k],
          modelId: liveModel(liveSubAgents[k].modelId),
        };
      }
      set({
        activeModelId: liveModel(s.activeModelId) ?? models[0]?.id ?? null,
        memoryModelId: liveModel(s.memoryModelId),
        imageModelId: liveModel(s.imageModelId),
        subAgents: liveSubAgents,
        activePromptId: s.activePromptId && promptIds.has(s.activePromptId) ? s.activePromptId : null,
      });
    } finally {
      set({ isLoading: false });
    }
  },

  addProvider: async (p, apiKey) => {
    const provider: Provider = { ...p, id: nanoid(), createdAt: Date.now() };
    if (isTauri) {
      const d = await db();
      await saveProvider(d, provider);
      await saveApiKey(provider.id, apiKey);
    }
    set((s) => ({ providers: [...s.providers, provider] }));
    return provider.id;
  },

  updateProvider: async (p, apiKey) => {
    if (isTauri) {
      const d = await db();
      await saveProvider(d, p);
      if (apiKey !== undefined) await saveApiKey(p.id, apiKey);
    }
    set((s) => ({ providers: s.providers.map((x) => (x.id === p.id ? p : x)) }));
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

  getApiKey: (providerId) => loadApiKey(providerId),

  addModel: async (m) => {
    const model: Model = { ...m, id: nanoid() };
    if (isTauri) {
      const d = await db();
      await saveModel(d, model);
    }
    set((s) => ({ models: [...s.models, model] }));
    if (!get().activeModelId) set({ activeModelId: model.id });
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

  fetchAndImportModels: async (providerId) => {
    const provider = get().providers.find((p) => p.id === providerId);
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
