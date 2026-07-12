import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  listProviders, saveProvider, deleteProvider,
  listModels, saveModel, deleteModel,
  listPrompts, savePrompt, deletePrompt,
  fetchRemoteModels, ensureAiSchema,
  type Provider, type Model, type Prompt,
} from "../lib/aiConfig";
import { saveApiKey, loadApiKey, deleteApiKey } from "../lib/keyStore";
import { getGlobalDb } from "../lib/project";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function db() {
  const globalDb = await getGlobalDb();
  await ensureAiSchema(globalDb);
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
  removePrompt: (id: string) => Promise<void>;

  setActiveModel: (id: string) => void;
  setActivePrompt: (id: string) => void;
  setMemoryModel: (id: string | null) => void;
}

export const useAiStore = create<AiState>((set, get) => ({
  providers: [],
  models: [],
  prompts: [],
  activeModelId: null,
  activePromptId: null,
  memoryModelId: null,
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
      if (!get().activeModelId && models.length > 0) {
        set({ activeModelId: models[0].id });
      }
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
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      models: s.models.filter((m) => m.providerId !== id),
    }));
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
    set((s) => ({
      models: s.models.filter((m) => m.id !== id),
      activeModelId: s.activeModelId === id ? null : s.activeModelId,
    }));
  },

  fetchAndImportModels: async (providerId) => {
    const provider = get().providers.find((p) => p.id === providerId);
    if (!provider) throw new Error("Provider not found");
    const apiKey = await loadApiKey(providerId) ?? "";
    return fetchRemoteModels(provider.baseUrl, apiKey, provider.apiStandard);
  },

  addPrompt: async (p) => {
    const prompt: Prompt = { ...p, id: nanoid() };
    if (isTauri) {
      const d = await db();
      await savePrompt(d, prompt);
    }
    set((s) => ({ prompts: [...s.prompts, prompt] }));
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
}));
