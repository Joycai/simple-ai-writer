/**
 * The unified assistant's home: the L2 approval queue AND the conversational
 * agent session (对话助手).
 *
 * ── Approvals ──
 * propose_edit blocks the tool loop on a Promise held here; the approval card
 * renders `pending` and the user's decision resolves it. The APPROVER is what
 * applies the edit — the tool never touches the manuscript:
 *
 *   approve → backup → apply (through editorStore when the file is open in
 *             the editor, so unsaved work is respected and the change shows
 *             immediately; straight to disk otherwise) → resolve {approved}
 *   reject  → resolve {approved:false, reason} (fed back to the model verbatim)
 *
 * The apply re-locates the `find` text at decision time — if the document
 * changed while the card sat open, the proposal resolves as a rejection with
 * that explanation instead of clobbering the author's newer text.
 *
 * rejectAll() drains the queue on task abort/end so a dangling Promise can
 * never wedge a future run.
 *
 * ── Chat session ──
 * One conversation at a time. The protocol history (chatHistory) is the same
 * array the runtime mutates in place: turn N's tool calls and results stay in
 * context for turn N+1, which is what makes it a real conversation rather than
 * repeated one-shots. The first turn seeds the history through assembleContext
 * (lore/memory/recent-window injection, same layers as the task panel);
 * later turns just append a user message. Display state (turns) is kept
 * separately — the history holds wire messages, the turns hold what the user
 * sees (text + per-turn execution log).
 */

import { create } from "zustand";
import i18n from "../i18n";
import { backupFile } from "../lib/agent/backup";
import { appendAgentEventTo, type AgentEvent } from "../lib/agent/events";
import type { ApprovalDecision, EditProposal } from "../lib/agent/registry";
import type { StreamMessage } from "../lib/ai/types";
import { readFile, writeFile } from "../lib/fs/fileio";
import { getDb } from "../lib/project";
import { loadApiKey } from "../lib/keyStore";

interface PendingApproval {
  proposal: EditProposal;
  resolve: (decision: ApprovalDecision) => void;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant turns: this turn's execution log (rounds, tool calls, outcome). */
  log: AgentEvent[];
}

interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface AgentState {
  pending: PendingApproval[];

  // ── Chat session ──
  turns: ChatTurn[];
  chatRunning: boolean;
  chatError: string | null;
  /** Session-cumulative usage across all turns. */
  chatUsage: ChatUsage | null;
  chatAbort: AbortController | null;
  /** Wire-protocol history the runtime appends to; null until the first turn. */
  chatHistory: StreamMessage[] | null;

  /** Called by the tool executor (via ToolContext.requestApproval). */
  requestApproval: (proposal: EditProposal) => Promise<ApprovalDecision>;
  /** User approved: backup, apply, resolve. */
  approve: (id: string) => Promise<void>;
  /** User rejected: resolve with their optional reason. */
  reject: (id: string, reason?: string) => void;
  /** Drain the queue (task aborted / finished) — resolves everything as rejected. */
  rejectAll: (reason: string) => void;

  sendChat: (text: string) => Promise<void>;
  stopChat: () => void;
  resetChat: () => void;
}

let turnCounter = 0;

/** Chat's own usage recorder (aiTaskStore has an equivalent; kept local to avoid a store cycle). */
async function recordChatUsage(
  projectPath: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
): Promise<void> {
  try {
    const db = await getDb(projectPath);
    await db.execute(
      `INSERT INTO token_usage (model_id, task, prompt_tokens, completion_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [modelId, "chat", inputTokens, outputTokens, cost, Math.floor(Date.now() / 1000)],
    );
  } catch {
    // non-critical
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pending: [],

  turns: [],
  chatRunning: false,
  chatError: null,
  chatUsage: null,
  chatAbort: null,
  chatHistory: null,

  requestApproval: (proposal) =>
    new Promise<ApprovalDecision>((resolve) => {
      set((s) => ({ pending: [...s.pending, { proposal, resolve }] }));
    }),

  approve: async (id) => {
    const item = get().pending.find((p) => p.proposal.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.proposal.id !== id) }));

    const { proposal } = item;
    try {
      const { useProjectStore } = await import("./projectStore");
      const { projectPath, activeFilePath } = useProjectStore.getState();
      const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

      if (activeFilePath === proposal.path) {
        // The file is open — go through the editor so unsaved edits are kept
        // and the change is visible (and autosaved) immediately.
        const { useEditorStore } = await import("./editorStore");
        const { content, setContent } = useEditorStore.getState();
        const idx = content.indexOf(proposal.find);
        if (idx < 0) throw new Error("Document changed — the target text no longer matches.");
        setContent(
          content.slice(0, idx) + proposal.replace + content.slice(idx + proposal.find.length),
        );
      } else {
        const raw = await readFile(proposal.path);
        const idx = raw.indexOf(proposal.find);
        if (idx < 0) throw new Error("Document changed — the target text no longer matches.");
        await writeFile(
          proposal.path,
          raw.slice(0, idx) + proposal.replace + raw.slice(idx + proposal.find.length),
        );
      }
      item.resolve({ approved: true, backupPath });
    } catch (e) {
      // Approval failed to apply — report as a rejection so the model knows
      // the manuscript is untouched.
      item.resolve({ approved: false, reason: `apply failed: ${String(e)}` });
    }
  },

  reject: (id, reason) => {
    const item = get().pending.find((p) => p.proposal.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.proposal.id !== id) }));
    item.resolve({ approved: false, reason });
  },

  rejectAll: (reason) => {
    const items = get().pending;
    if (items.length === 0) return;
    set({ pending: [] });
    for (const item of items) item.resolve({ approved: false, reason });
  },

  // ── Chat session ──────────────────────────────────────────────────────────

  sendChat: async (text) => {
    const message = text.trim();
    if (!message || get().chatRunning) return;

    const { useAiStore } = await import("./aiStore");
    const { useProjectStore } = await import("./projectStore");
    const { useLoreStore } = await import("./loreStore");
    const { useAppStore } = await import("./appStore");
    const { resolveModel } = await import("../lib/lore/aiTask");

    const { models, providers, activeModelId } = useAiStore.getState();
    const resolved = resolveModel(models, providers, activeModelId);
    const { projectPath, activeFilePath } = useProjectStore.getState();
    if (!projectPath) { set({ chatError: i18n.t("ai.errors.noProject") }); return; }
    if (!resolved) { set({ chatError: i18n.t("ai.errors.noModel") }); return; }
    const { model, provider } = resolved;
    const apiKey = (await loadApiKey(provider.id)) ?? "";

    const controller = new AbortController();
    const userTurn: ChatTurn = { id: `t${++turnCounter}`, role: "user", text: message, log: [] };
    const assistantTurn: ChatTurn = { id: `t${++turnCounter}`, role: "assistant", text: "", log: [] };
    set((s) => ({
      turns: [...s.turns, userTurn, assistantTurn],
      chatRunning: true,
      chatError: null,
      chatAbort: controller,
    }));

    const patchAssistant = (patch: (turn: ChatTurn) => ChatTurn) =>
      set((s) => ({
        turns: s.turns.map((tn) => (tn.id === assistantTurn.id ? patch(tn) : tn)),
      }));

    try {
      // ── History: seed on first turn, append afterwards ──
      let history = get().chatHistory;
      if (!history) {
        const { assembleContext, bundleToMessages } = await import("../lib/context/rag");
        const { measureCharsPerToken, RECENT_WINDOW_MIN_CHARS } = await import("../lib/context/budget");
        const { MEMORY_BUDGET_CHARS, loadMemory } = await import("../lib/context/memory");
        const { useAiStore: aiStore2 } = await import("./aiStore");
        const { useEditorStore } = await import("./editorStore");

        const { prompts, activePromptId } = aiStore2.getState();
        const systemPrompt =
          prompts.find((p) => p.id === activePromptId)?.content ?? i18n.t("ai.instructions.system");
        const { content: documentText } = useEditorStore.getState();
        const memory = activeFilePath ? await loadMemory(projectPath, activeFilePath) : null;
        const { loreBudgetTokens } = useAppStore.getState();
        const charsPerToken = measureCharsPerToken(documentText);

        const bundle = await assembleContext(
          systemPrompt,
          useLoreStore.getState().index,
          documentText,
          "",
          `${i18n.t("ai.instructions.agent")}\n\n${message}`,
          { contextChars: RECENT_WINDOW_MIN_CHARS },
          null,
          memory,
          loreBudgetTokens * charsPerToken,
          MEMORY_BUDGET_CHARS,
        );
        history = bundleToMessages(bundle);
        set({ chatHistory: history });
      } else {
        history.push({ role: "user", content: message });
      }

      const { runAgent } = await import("../lib/agent/runtime");
      const { AGENT_ASSIST_PRESET } = await import("../lib/agent/presets");
      const { contextUtilization } = useAppStore.getState();

      const { inputTokens, outputTokens } = await runAgent({
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        safetySettings: provider.safetySettings,
        modelId: model.modelId,
        prefix: model.prefix,
        contextSize: model.contextSize,
        inputCeilingTokens: model.contextSize
          ? Math.floor(model.contextSize * contextUtilization)
          : undefined,
        preset: AGENT_ASSIST_PRESET,
        messages: history,
        toolContext: {
          projectPath,
          // Live index — a lore write in turn N must be visible to turn N+1.
          loreIndex: useLoreStore.getState().index,
          multimodal: model.type === "multimodal",
          onLoreChanged: () => {
            void useLoreStore.getState().scanProject(projectPath);
          },
          onMemoryChanged: () => {
            void import("./memoryStore").then((m) =>
              m.useMemoryStore.getState().loadForActiveFile(),
            );
          },
          requestApproval: (p) => get().requestApproval(p),
        },
        signal: controller.signal,
        onEvent: (event) =>
          patchAssistant((tn) => ({ ...tn, log: appendAgentEventTo(tn.log, event) })),
        onOutputChunk: (chunk) => patchAssistant((tn) => ({ ...tn, text: tn.text + chunk })),
      });

      const cost = (inputTokens * model.priceIn + outputTokens * model.priceOut) / 1_000_000;
      set((s) => ({
        chatUsage: {
          inputTokens: (s.chatUsage?.inputTokens ?? 0) + inputTokens,
          outputTokens: (s.chatUsage?.outputTokens ?? 0) + outputTokens,
          cost: (s.chatUsage?.cost ?? 0) + cost,
        },
      }));
      patchAssistant((tn) => ({
        ...tn,
        log: appendAgentEventTo(tn.log, { kind: "run-done", inputTokens, outputTokens, at: Date.now() }),
      }));
      void recordChatUsage(projectPath, model.id, inputTokens, outputTokens, cost);
    } catch (e) {
      if ((e as Error).name !== "AbortError" && get().chatAbort === controller) {
        const msg = String(e);
        set({ chatError: msg });
        patchAssistant((tn) => ({
          ...tn,
          log: appendAgentEventTo(tn.log, { kind: "run-error", message: msg, at: Date.now() }),
        }));
      }
    } finally {
      // Drain any approval still blocking the loop.
      get().rejectAll("task ended");
      if (get().chatAbort === controller) {
        set({ chatRunning: false, chatAbort: null });
      }
    }
  },

  stopChat: () => {
    get().chatAbort?.abort();
    get().rejectAll("aborted by user");
    set({ chatRunning: false, chatAbort: null });
  },

  resetChat: () => {
    get().stopChat();
    set({ turns: [], chatHistory: null, chatError: null, chatUsage: null });
  },
}));
