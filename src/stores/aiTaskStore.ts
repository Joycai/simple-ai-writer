import { create } from "zustand";
import i18n from "../i18n";
import { streamCompletion } from "../lib/aiClient";
import { assembleContext, bundleToMessages, type TaskExtras } from "../lib/rag";
import { useAiStore } from "./aiStore";
import { useLoreStore } from "./loreStore";
import { useProjectStore } from "./projectStore";
import { getDb } from "../lib/project";
import { loadApiKey } from "../lib/keyStore";
import type { ToolStep } from "../lib/agentLoop";

export type TaskKind = "continue" | "polish" | "rewrite" | "summary" | "custom";
export type { ToolStep };

// Resolve the built-in instruction at call time so it follows the active
// language — module-load lookups would freeze to the initial locale.
function taskInstruction(kind: Exclude<TaskKind, "custom" | "continue">): string {
  return i18n.t(`ai.instructions.${kind}`);
}

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
  toolSteps: ToolStep[];

  setSelection: (s: string) => void;
  runTask: (kind: TaskKind, customInstruction?: string, continueLength?: number, extras?: TaskExtras) => Promise<void>;
  abort: () => void;
  clearOutput: () => void;
  addToolStep: (step: ToolStep) => void;
}

export const useAiTaskStore = create<AiTaskState>((set, get) => ({
  isRunning: false,
  output: "",
  error: null,
  usage: null,
  selection: "",
  abortController: null,
  toolSteps: [],

  setSelection: (s) => set({ selection: s }),

  addToolStep: (step) =>
    set((s) => {
      const idx = s.toolSteps.findIndex(
        (t) => t.toolCallId === step.toolCallId && t.name === step.name,
      );
      if (idx >= 0) {
        const updated = [...s.toolSteps];
        updated[idx] = step;
        return { toolSteps: updated };
      }
      return { toolSteps: [...s.toolSteps, step] };
    }),

  runTask: async (kind, customInstruction, continueLength, extras) => {
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
    let instruction: string;
    if (kind === "custom") {
      instruction = customInstruction ?? "";
    } else if (kind === "continue") {
      instruction = scenePrompt?.content
        ?? i18n.t("ai.instructions.continue", { length: continueLength ?? 500 });
    } else {
      instruction = scenePrompt?.content ?? taskInstruction(kind);
    }

    const controller = new AbortController();
    set({ isRunning: true, output: "", error: null, usage: null, toolSteps: [], abortController: controller });

    const baseUrl = provider.baseUrl || defaultBaseUrl(provider.apiStandard);

    try {
      if (kind === "continue") {
        // ── Agentic mode: AI reads context autonomously with tools ─────────
        const bundle = await assembleContext(
          systemPrompt,
          loreIndex,
          documentText,
          get().selection,
          instruction,
          extras,
        );
        const initialMessages = bundleToMessages(bundle);
        // Extract the user message content for the first agent turn
        const initialUserMessage =
          typeof initialMessages[1]?.content === "string"
            ? initialMessages[1].content
            : JSON.stringify(initialMessages[1]?.content ?? "");

        const { runAgentLoop } = await import("../lib/agentLoop");
        const { AGENT_TOOLS } = await import("../lib/tools");

        await runAgentLoop({
          baseUrl,
          apiKey,
          standard: provider.apiStandard,
          safetySettings: provider.safetySettings,
          modelId: model.modelId,
          prefix: model.prefix,
          systemPrompt,
          initialUserMessage,
          projectPath,
          loreIndex,
          tools: AGENT_TOOLS,
          multimodal: model.type === "multimodal",
          signal: controller.signal,
          onToolStep: (step) => get().addToolStep(step),
          onOutputChunk: (text) => set((s) => ({ output: s.output + text })),
          onDone: ({ inputTokens, outputTokens }) => {
            const cost = (inputTokens * model.priceIn + outputTokens * model.priceOut) / 1_000_000;
            set({ usage: { inputTokens, outputTokens, cost } });
            void persistUsage(projectPath, model.id, inputTokens, outputTokens, cost, kind);
          },
        });
      } else {
        // ── Simple streaming: polish / rewrite / summary / custom / Gemini ─
        const bundle = await assembleContext(
          systemPrompt,
          loreIndex,
          documentText,
          get().selection,
          instruction,
          extras,
        );
        const messages = bundleToMessages(bundle);

        await streamCompletion({
          baseUrl,
          apiKey,
          standard: provider.apiStandard,
          safetySettings: provider.safetySettings,
          modelId: model.modelId,
          prefix: model.prefix,
          messages,
          signal: controller.signal,
          onChunk: (chunk) => {
            if ("done" in chunk) {
              const { inputTokens, outputTokens } = chunk;
              const cost =
                (inputTokens * model.priceIn + outputTokens * model.priceOut) / 1_000_000;
              set({ usage: { inputTokens, outputTokens, cost } });
              void persistUsage(projectPath, model.id, inputTokens, outputTokens, cost, kind);
            } else if ("text" in chunk) {
              set((s) => ({ output: s.output + chunk.text }));
            }
          },
        });
      }
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

  clearOutput: () => set({ output: "", error: null, usage: null, toolSteps: [] }),
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
