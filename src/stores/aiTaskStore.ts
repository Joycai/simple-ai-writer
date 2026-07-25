import { create } from "zustand";
import i18n from "../i18n";
import { streamCompletion } from "../lib/ai";
import { assembleContext, bundleToMessages, type TaskExtras } from "../lib/context/rag";
import {
  fixedContextChars, measureCharsPerToken, planContextBudget, reflowMemoryBudget,
  type ContextAllocation,
} from "../lib/context/budget";
import type { LoreActivationReport } from "../lib/context/loreSelect";
import { useAiStore } from "./aiStore";
import { useAppStore } from "./appStore";
import { useLoreStore } from "./loreStore";
import { useProjectStore } from "./projectStore";
import { getDb } from "../lib/project";
import { loadApiKey } from "../lib/keyStore";
import type { AgentEvent, ToolStep } from "../lib/agent/events";

export type TaskKind = "continue" | "polish" | "rewrite" | "summary" | "custom";
export type { AgentEvent, ToolStep };

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

/** Source-document offsets for the committed selection, when known (editor
 *  mode). Null in preview mode where only rendered text is available. */
export interface SelectionRange { from: number; to: number; }

interface AiTaskState {
  isRunning: boolean;
  output: string;
  error: string | null;
  usage: TokenUsage | null;
  selection: string;
  selectionRange: SelectionRange | null;
  /** Task the floating toolbar asked the panel to pre-select. Consumed + cleared by AiPanel. */
  requestedTask: TaskKind | null;
  abortController: AbortController | null;
  /** Execution log for the current/last run — rounds, tool calls, outcome. */
  agentLog: AgentEvent[];
  /** Which lore entities/facets were injected (and why) for the current run. */
  loreReport: LoreActivationReport | null;
  /** Final per-layer allocation for the current run (see lib/context/budget). */
  contextAlloc: ContextAllocation | null;

  setSelection: (s: string, range?: SelectionRange | null) => void;
  setRequestedTask: (kind: TaskKind | null) => void;
  runTask: (kind: TaskKind, customInstruction?: string, continueLength?: number, extras?: TaskExtras) => Promise<void>;
  abort: () => void;
  clearOutput: () => void;
  appendAgentEvent: (event: AgentEvent) => void;
}

export const useAiTaskStore = create<AiTaskState>((set, get) => ({
  isRunning: false,
  output: "",
  error: null,
  usage: null,
  selection: "",
  selectionRange: null,
  requestedTask: null,
  abortController: null,
  agentLog: [],
  loreReport: null,
  contextAlloc: null,

  setSelection: (s, range = null) => set({ selection: s, selectionRange: range }),
  setRequestedTask: (kind) => set({ requestedTask: kind }),

  appendAgentEvent: (event) =>
    set((s) => {
      // A tool step is emitted twice (running → done/error); update in place so
      // the log shows one line per call rather than duplicates.
      if (event.kind === "tool-step") {
        const idx = s.agentLog.findIndex(
          (e) =>
            e.kind === "tool-step" &&
            e.step.toolCallId === event.step.toolCallId &&
            e.step.name === event.step.name,
        );
        if (idx >= 0) {
          const updated = [...s.agentLog];
          updated[idx] = event;
          return { agentLog: updated };
        }
      }
      return { agentLog: [...s.agentLog, event] };
    }),

  runTask: async (kind, customInstruction, continueLength, extras) => {
    if (get().isRunning) return; // one task at a time — UI disables triggers, this guards races
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

    // Story memory for the active document (前情提要 layer). Read from disk so
    // manual edits to the memory file are picked up; null when none exists.
    const { activeFilePath } = useProjectStore.getState();
    const { loadMemory } = await import("../lib/context/memory");
    const memory = activeFilePath ? await loadMemory(projectPath, activeFilePath) : null;

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

    // ── Context budget ──────────────────────────────────────────────────────
    // Divide the model's window between the layers we can size: lore (the
    // author's explicit setting) and the two recap layers (whatever is left).
    // Must be planned *before* the book context is built — that build spends its
    // own budget. See lib/context/budget.ts.
    const { loreBudgetTokens, contextUtilization } = useAppStore.getState();
    const isContinue = kind === "continue";
    const { BOOK_PREV_TAIL_CHARS } = await import("../lib/context/bookContext");
    // Where this request is anchored in the document — both the book-context
    // build and the recent-window budget measure backwards from here.
    const anchorOffset = get().selectionRange?.to ?? documentText.length;
    const plan = planContextBudget({
      contextSize: model.contextSize,
      utilization: contextUtilization,
      loreBudgetTokens,
      fixedChars: fixedContextChars({
        systemPromptChars: systemPrompt.length,
        taskInstructionChars: instruction.length,
        selectionChars: get().selection.length,
        outlineChars: extras?.outline?.length,
        knowledgeChars: extras?.additionalKnowledge?.length,
        prevChapterTailChars: isContinue ? BOOK_PREV_TAIL_CHARS : 0,
      }),
      // Undefined for continue/custom (no picker) → the planner grows the
      // verbatim window with the model. Polish/rewrite/summary pass the author's
      // explicit 「参考上下文范围」 choice, which is honored as-is.
      recentWindowChars: extras?.contextChars,
      availableRecentChars: Math.max(0, anchorOffset),
      hasMemory: !!memory && memory.segments.length > 0,
      includeBookContext: isContinue,
      replyChars: isContinue ? continueLength : undefined,
      // Measured from this manuscript, so a Chinese and an English project each
      // get budgets their own tokenizer cost agrees with.
      charsPerToken: measureCharsPerToken(documentText),
    });

    // Book-level continuation memory: recap of prior chapters + the previous
    // chapter's ending, resolved from the outline order (.ai-writer/outline.json).
    // Only for "continue" — this is what lets a freshly-started chapter know what
    // happened in the chapters before it.
    let bookExtras: Partial<TaskExtras> = {};
    let bookUsedChars = 0;
    if (isContinue && activeFilePath) {
      try {
        const { fileTree } = useProjectStore.getState();
        const { buildBookContext } = await import("../lib/context/bookContext");
        const bookContext = await buildBookContext(
          projectPath, fileTree, activeFilePath, anchorOffset, plan.bookPriorChars,
        );
        if (bookContext) {
          bookExtras = { bookContext };
          bookUsedChars = bookContext.priorSummary.length;
        }
      } catch {
        // best-effort — continuation still works without book context
      }
    }
    // Whatever 【全书前情】 didn't spend goes to 【前情提要】.
    const memoryBudgetChars = reflowMemoryBudget(plan, bookUsedChars);

    const controller = new AbortController();
    set({
      isRunning: true, output: "", error: null, usage: null, agentLog: [], loreReport: null,
      contextAlloc: {
        loreChars: plan.loreChars,
        memoryChars: memoryBudgetChars,
        // Realized, not planned — its unspent share is already inside memoryChars.
        bookPriorChars: bookUsedChars,
        recentWindowChars: plan.recentWindowChars,
        charsPerToken: plan.charsPerToken,
        dynamic: plan.dynamic,
      },
      abortController: controller,
    });

    const baseUrl = provider.baseUrl || defaultBaseUrl(provider.apiStandard);
    const loreBudgetChars = plan.loreChars;

    get().appendAgentEvent({
      kind: "run-start",
      task: kind,
      modelName: model.name || model.modelId,
      agentic: isContinue,
      at: Date.now(),
    });

    try {
      if (kind === "continue") {
        // ── Agentic mode: AI reads context autonomously with tools ─────────
        // Continue is append-mode: any selection is an anchor to write *after*,
        // never an edit target — so no 【选中内容】 block is sent.
        const bundle = await assembleContext(
          systemPrompt,
          loreIndex,
          documentText,
          get().selection,
          instruction,
          { ...extras, ...bookExtras, appendMode: true, contextChars: plan.recentWindowChars },
          get().selectionRange,
          memory,
          loreBudgetChars,
          memoryBudgetChars,
        );
        set({ loreReport: bundle.loreReport });

        const { runAgent } = await import("../lib/agent/runtime");
        const { CONTINUE_PRESET } = await import("../lib/agent/presets");

        const { inputTokens, outputTokens } = await runAgent({
          baseUrl,
          apiKey,
          standard: provider.apiStandard,
          safetySettings: provider.safetySettings,
          modelId: model.modelId,
          prefix: model.prefix,
          contextSize: model.contextSize,
          inputCeilingTokens: plan.inputCeilingTokens,
          preset: CONTINUE_PRESET,
          messages: bundleToMessages(bundle),
          toolContext: {
            projectPath,
            loreIndex,
            multimodal: model.type === "multimodal",
            // Write-auto tools call these after touching disk so the panels
            // reflect agent edits immediately (no-ops for read-only presets).
            onLoreChanged: () => {
              void useLoreStore.getState().scanProject(projectPath);
            },
            onMemoryChanged: () => {
              void import("./memoryStore").then((m) =>
                m.useMemoryStore.getState().loadForActiveFile(),
              );
            },
          },
          signal: controller.signal,
          onEvent: (event) => get().appendAgentEvent(event),
          onOutputChunk: (text) => set((s) => ({ output: s.output + text })),
        });
        const cost = (inputTokens * model.priceIn + outputTokens * model.priceOut) / 1_000_000;
        set({ usage: { inputTokens, outputTokens, cost } });
        get().appendAgentEvent({ kind: "run-done", inputTokens, outputTokens, at: Date.now() });
        void persistUsage(projectPath, model.id, inputTokens, outputTokens, cost, kind);
      } else {
        // ── Simple streaming: polish / rewrite / summary / custom / Gemini ─
        const bundle = await assembleContext(
          systemPrompt,
          loreIndex,
          documentText,
          get().selection,
          instruction,
          { ...extras, contextChars: plan.recentWindowChars },
          get().selectionRange,
          memory,
          loreBudgetChars,
          memoryBudgetChars,
        );
        set({ loreReport: bundle.loreReport });
        const messages = bundleToMessages(bundle);

        await streamCompletion({
          baseUrl,
          apiKey,
          standard: provider.apiStandard,
          safetySettings: provider.safetySettings,
          modelId: model.modelId,
          prefix: model.prefix,
          contextSize: model.contextSize,
          messages,
          signal: controller.signal,
          onChunk: (chunk) => {
            if ("done" in chunk) {
              const { inputTokens, outputTokens } = chunk;
              const cost =
                (inputTokens * model.priceIn + outputTokens * model.priceOut) / 1_000_000;
              set({ usage: { inputTokens, outputTokens, cost } });
              get().appendAgentEvent({ kind: "run-done", inputTokens, outputTokens, at: Date.now() });
              void persistUsage(projectPath, model.id, inputTokens, outputTokens, cost, kind);
            } else if ("text" in chunk) {
              set((s) => ({ output: s.output + chunk.text }));
            }
          },
        });
      }
    } catch (e) {
      // Only surface errors while this task is still the current one — after
      // abort() + a quick re-run, this stale rejection must not clobber the
      // new task's state.
      if ((e as Error).name !== "AbortError" && get().abortController === controller) {
        set({ error: String(e) });
        get().appendAgentEvent({ kind: "run-error", message: String(e), at: Date.now() });
      }
    } finally {
      // Same guard: abort() already cleared state, and a newer task may own it now.
      if (get().abortController === controller) {
        set({ isRunning: false, abortController: null });
      }
    }
  },

  abort: () => {
    get().abortController?.abort();
    set({ isRunning: false, abortController: null });
  },

  clearOutput: () => set({ output: "", error: null, usage: null, agentLog: [], loreReport: null }),
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
