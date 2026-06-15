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
import { getDb } from "../lib/project";

interface AiState {
  providers: Provider[];
  models: Model[];
  prompts: Prompt[];
  activeModelId: string | null;
  activePromptId: string | null;
  isLoading: boolean;

  loadConfig: (projectPath: string) => Promise<void>;

  addProvider: (projectPath: string, p: Omit<Provider, "id" | "createdAt">, apiKey: string) => Promise<string>;
  updateProvider: (projectPath: string, p: Provider, apiKey?: string) => Promise<void>;
  removeProvider: (projectPath: string, id: string) => Promise<void>;
  getApiKey: (projectPath: string, providerId: string) => Promise<string | null>;

  addModel: (projectPath: string, m: Omit<Model, "id">) => Promise<void>;
  updateModel: (projectPath: string, m: Model) => Promise<void>;
  removeModel: (projectPath: string, id: string) => Promise<void>;
  fetchAndImportModels: (projectPath: string, providerId: string) => Promise<{ id: string; name: string }[]>;

  addPrompt: (projectPath: string, p: Omit<Prompt, "id">) => Promise<void>;
  removePrompt: (projectPath: string, id: string) => Promise<void>;

  setActiveModel: (id: string) => void;
  setActivePrompt: (id: string) => void;
}

export const useAiStore = create<AiState>((set, get) => ({
  providers: [],
  models: [],
  prompts: [],
  activeModelId: null,
  activePromptId: null,
  isLoading: false,

  loadConfig: async (projectPath) => {
    const db = await getDb(projectPath);
    await ensureAiSchema(db);
    const [providers, models, prompts] = await Promise.all([
      listProviders(db),
      listModels(db),
      listPrompts(db),
    ]);
    set({ providers, models, prompts });
    // Seed default active model if none set
    if (!get().activeModelId && models.length > 0) {
      set({ activeModelId: models[0].id });
    }
  },

  addProvider: async (projectPath, p, apiKey) => {
    const db = await getDb(projectPath);
    const provider: Provider = { ...p, id: nanoid(), createdAt: Date.now() };
    await saveProvider(db, provider);
    await saveApiKey(projectPath, provider.id, apiKey);
    set((s) => ({ providers: [...s.providers, provider] }));
    return provider.id;
  },

  updateProvider: async (projectPath, p, apiKey) => {
    const db = await getDb(projectPath);
    await saveProvider(db, p);
    if (apiKey !== undefined) await saveApiKey(projectPath, p.id, apiKey);
    set((s) => ({ providers: s.providers.map((x) => (x.id === p.id ? p : x)) }));
  },

  removeProvider: async (projectPath, id) => {
    const db = await getDb(projectPath);
    await deleteProvider(db, id);
    await deleteApiKey(projectPath, id);
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      models: s.models.filter((m) => m.providerId !== id),
    }));
  },

  getApiKey: (projectPath, providerId) => loadApiKey(projectPath, providerId),

  addModel: async (projectPath, m) => {
    const db = await getDb(projectPath);
    const model: Model = { ...m, id: nanoid() };
    await saveModel(db, model);
    set((s) => ({ models: [...s.models, model] }));
    if (!get().activeModelId) set({ activeModelId: model.id });
  },

  updateModel: async (projectPath, m) => {
    const db = await getDb(projectPath);
    await saveModel(db, m);
    set((s) => ({ models: s.models.map((x) => (x.id === m.id ? m : x)) }));
  },

  removeModel: async (projectPath, id) => {
    const db = await getDb(projectPath);
    await deleteModel(db, id);
    set((s) => ({
      models: s.models.filter((m) => m.id !== id),
      activeModelId: s.activeModelId === id ? null : s.activeModelId,
    }));
  },

  fetchAndImportModels: async (projectPath, providerId) => {
    const provider = get().providers.find((p) => p.id === providerId);
    if (!provider) throw new Error("Provider not found");
    const apiKey = await loadApiKey(projectPath, providerId) ?? "";
    return fetchRemoteModels(provider.baseUrl, apiKey, provider.apiStandard);
  },

  addPrompt: async (projectPath, p) => {
    const db = await getDb(projectPath);
    const prompt: Prompt = { ...p, id: nanoid() };
    await savePrompt(db, prompt);
    set((s) => ({ prompts: [...s.prompts, prompt] }));
  },

  removePrompt: async (projectPath, id) => {
    const db = await getDb(projectPath);
    await deletePrompt(db, id);
    set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) }));
  },

  setActiveModel: (id) => set({ activeModelId: id }),
  setActivePrompt: (id) => set({ activePromptId: id }),
}));
