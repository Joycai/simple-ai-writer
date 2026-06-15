import { create } from "zustand";
import i18n from "../i18n";
import { streamCompletion } from "../lib/aiClient";
import { assembleContext, bundleToMessages } from "../lib/rag";
import { useAiStore } from "./aiStore";
import { useLoreStore } from "./loreStore";
import { useProjectStore } from "./projectStore";
import { getDb } from "../lib/project";
import { loadApiKey } from "../lib/keyStore";

export type TaskKind = "continue" | "polish" | "rewrite" | "summary" | "custom";

const TASK_INSTRUCTIONS: Record<TaskKind, string> = {
  continue: i18n.t("ai.instructions.continue"),
  polish: i18n.t("ai.instructions.polish"),
  rewrite: i18n.t("ai.instructions.rewrite"),
  summary: i18n.t("ai.instructions.summary"),
  custom: "",
};

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number; // USD
}

interface AiTaskState {
  isRunning: boolean;
  output: string;
  error: string | null;
  usage: TokenUsage | null;
  selection: string;
  abortController: AbortController | null;

  setSelection: (s: string) => void;
  runTask: (kind: TaskKind, customInstruction?: string) => Promise<void>;
  abort: () => void;
  clearOutput: () => void;
}

export const useAiTaskStore = create<AiTaskState>((set, get) => ({
  isRunning: false,
  output: "",
  error: null,
  usage: null,
  selection: "",
  abortController: null,

  setSelection: (s) => set({ selection: s }),

  runTask: async (kind, customInstruction) => {
    const { activeModelId, activePromptId, models, providers, prompts } = useAiStore.getState();
    const { projectPath } = useProjectStore.getState();
    const { index: loreIndex } = useLoreStore.getState();

    if (!projectPath) { set({ error: i18n.t("ai.errors.noProject") }); return; }
    if (!activeModelId) { set({ error: i18n.t("ai.errors.noModel") }); return; }

    const model = models.find((m) => m.id === activeModelId);
    if (!model) { set({ error: i18n.t("ai.errors.modelNotFound") }); return; }

    const provider = providers.find((p) => p.id === model.providerId);
    if (!provider) { set({ error: i18n.t("ai.errors.providerNotFound") }); return; }

    // System prompt: user-selected prompt (scene === "system"), else default
    const prompt = prompts.find((p) => p.id === activePromptId);
    const systemPrompt = prompt?.content ?? i18n.t("ai.instructions.system");

    const apiKey = await loadApiKey(provider.id) ?? "";

    // Gather current document text from editorStore lazily (avoid circular import)
    const { useEditorStore } = await import("./editorStore");
    const { content: documentText } = useEditorStore.getState();

    // Task instruction: use scene-matched user prompt if one exists, else built-in default
    const scenePrompt = kind !== "custom"
      ? prompts.find((p) => p.scene === kind)
      : undefined;
    const instruction =
      kind === "custom" ? (customInstruction ?? "")
      : scenePrompt?.content ?? TASK_INSTRUCTIONS[kind];

    const bundle = await assembleContext(
      systemPrompt,
      loreIndex,
      documentText,
      get().selection,
      instruction
    );
    const messages = bundleToMessages(bundle);

    const controller = new AbortController();
    set({ isRunning: true, output: "", error: null, usage: null, abortController: controller });

    try {
      await streamCompletion({
        baseUrl: provider.baseUrl || defaultBaseUrl(provider.apiStandard),
        apiKey,
        standard: provider.apiStandard,
        modelId: model.modelId,
        messages,
        signal: controller.signal,
        onChunk: (chunk) => {
          if ("done" in chunk) {
            const { inputTokens, outputTokens } = chunk;
            const cost =
              (inputTokens * model.priceIn + outputTokens * model.priceOut) / 1_000_000;
            set({ usage: { inputTokens, outputTokens, cost } });
            // Persist usage to SQLite
            void persistUsage(projectPath, model.id, inputTokens, outputTokens, cost, kind);
          } else {
            set((s) => ({ output: s.output + chunk.text }));
          }
        },
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        set({ error: String(e) });
      }
    } finally {
      set({ isRunning: false, abortController: null });
    }
  },

  abort: () => {
    get().abortController?.abort();
    set({ isRunning: false, abortController: null });
  },

  clearOutput: () => set({ output: "", error: null, usage: null }),
}));

function defaultBaseUrl(standard: string): string {
  if (standard === "gemini") return ""; // handled separately in aiClient
  return "https://api.openai.com/v1";
}

async function persistUsage(
  projectPath: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  task: string
): Promise<void> {
  try {
    const db = await getDb(projectPath);
    await db.execute(
      `INSERT INTO token_usage (model_id, task, prompt_tokens, completion_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [modelId, task, inputTokens, outputTokens, cost, Math.floor(Date.now() / 1000)]
    );
  } catch {
    // non-critical — don't surface DB errors to the user
  }
}
