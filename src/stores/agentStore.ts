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
 * never wedge a future run. Scoped per run (see `runId` below) — the panel
 * task and a chat turn can legitimately run at once, each with its own
 * pending approvals, so one finishing must not silently auto-reject the
 * other's still-open card.
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
import { createPlanGate, type LorePlan, type PlanDecision } from "../lib/agent/plan";
import { parentDir } from "../lib/context/outline";
import { docModel } from "../lib/profile/active";
import type { ApprovalDecision, EditProposal, Proposal } from "../lib/agent/registry";
import type { StreamMessage } from "../lib/ai/types";
import { readFile, writeFile } from "../lib/fs/fileio";
import { getDb } from "../lib/project";
import { loadApiKey } from "../lib/keyStore";
import { recordRunOutcome } from "../lib/ai/modelHealth";
import { costFor } from "../lib/ai/configDb";

/**
 * Identifies which run created a queued approval — in practice each run's own
 * AbortController, since every caller already has one and object identity is
 * exactly the comparison rejectAll needs. Opaque to this store: it never does
 * anything with a runId but `===` it.
 */
type RunId = unknown;

interface PendingApproval {
  proposal: Proposal;
  resolve: (decision: ApprovalDecision) => void;
  runId: RunId;
}

interface PendingPlan {
  plan: LorePlan;
  resolve: (decision: PlanDecision) => void;
  runId: RunId;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant turns: this turn's execution log (rounds, tool calls, outcome). */
  log: AgentEvent[];
  /** Wall-clock time the turn was created, for the transcript's time column. */
  at: number;
  /** User turns: manuscript passage the message was asked *about*. */
  quote?: string;
}

interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface AgentState {
  pending: PendingApproval[];
  /** Lore plans awaiting the author's decision — the loop is blocked on each. */
  pendingPlans: PendingPlan[];

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
  requestApproval: (proposal: Proposal, runId: RunId) => Promise<ApprovalDecision>;
  /** User approved: backup, apply, resolve. */
  approve: (id: string) => Promise<void>;
  /** User rejected: resolve with their optional reason. */
  reject: (id: string, reason?: string) => void;
  /** Drain both queues for one run (task aborted / finished) — resolves that
   *  run's own entries as rejected, leaving any other run's untouched. */
  rejectAll: (reason: string, runId: RunId) => void;

  /** Called by propose_lore_plan (via ToolContext.requestPlanApproval). */
  requestPlanApproval: (plan: LorePlan, runId: RunId) => Promise<PlanDecision>;
  /** User approved the plan — the gate records its steps and the loop resumes. */
  approvePlan: (id: string) => void;
  /** User rejected the plan: their reason goes back to the model verbatim. */
  rejectPlan: (id: string, reason?: string) => void;

  /** @param quote Manuscript passage attached to the message, if the author
   *               pinned their selection to it (shown above the turn, and sent
   *               to the model as a 【选中内容】 block). */
  sendChat: (text: string, quote?: string) => Promise<void>;
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
  cachedTokens = 0,
): Promise<void> {
  try {
    const db = await getDb(projectPath);
    await db.execute(
      `INSERT INTO token_usage (model_id, task, prompt_tokens, cached_tokens, completion_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [modelId, "chat", inputTokens, cachedTokens, outputTokens, cost, Math.floor(Date.now() / 1000)],
    );
  } catch {
    // non-critical
  }
}

// ─── Applying an approved proposal ───────────────────────────────────────────

/**
 * Apply an approved edit. Returns the pre-write backup path.
 *
 * The find text is re-located at apply time rather than trusting the offset the
 * proposal was built from: the author may have kept typing while the card sat
 * there, and silently writing at a stale position would corrupt the passage.
 */
async function applyEdit(proposal: EditProposal): Promise<string | null> {
  const { useProjectStore } = await import("./projectStore");
  const { projectPath, activeFilePath } = useProjectStore.getState();
  const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

  // Same reasoning as rag.ts's resolveEditRange: repeated lines are ordinary
  // in a draft, and applying at the first match when there's more than one
  // rewrites text the author never actually approved — they approved this
  // find/replace, not "wherever it happens to appear first". Ambiguous ->
  // refuse, exactly like a stale (no-longer-present) match already does.
  const locate = (text: string): number => {
    const first = text.indexOf(proposal.find);
    if (first < 0) throw new Error("Document changed — the target text no longer matches.");
    if (first !== text.lastIndexOf(proposal.find)) {
      throw new Error("The target text appears more than once in the document — too ambiguous to apply automatically.");
    }
    return first;
  };

  if (activeFilePath === proposal.path) {
    // The file is open — go through the editor so unsaved edits are kept
    // and the change is visible (and autosaved) immediately.
    const { useEditorStore } = await import("./editorStore");
    const { content, setContent } = useEditorStore.getState();
    const idx = locate(content);
    setContent(content.slice(0, idx) + proposal.replace + content.slice(idx + proposal.find.length));
  } else {
    const raw = await readFile(proposal.path);
    const idx = locate(raw);
    await writeFile(
      proposal.path,
      raw.slice(0, idx) + proposal.replace + raw.slice(idx + proposal.find.length),
    );
  }
  return backupPath;
}

/**
 * Carry out what an approved proposal asked for, returning the backup path to
 * report back to the model. Throwing here is how a failure reaches the model as
 * a rejection — never swallow one and report success.
 */
async function applyProposal(proposal: Proposal): Promise<string | null> {
  const { useProjectStore } = await import("./projectStore");
  const { createEntry, moveEntry, deleteEntry } = useProjectStore.getState();

  switch (proposal.kind) {
    case "edit":
      return applyEdit(proposal);

    case "create": {
      const dir = parentDir(proposal.path);
      await createEntry(dir, proposal.path.slice(dir.length + 1), "file", proposal.content);
      return null; // nothing existed to back up
    }

    case "move":
      await moveEntry(proposal.path, proposal.newPath);
      return null; // the file still exists, at its new path

    case "delete":
      // Folders never reach here (delete_chapter refuses them), but the backup
      // is what makes an approved deletion recoverable, so it is not optional.
      return deleteEntry(proposal.path, false, { backup: true });
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pending: [],
  pendingPlans: [],

  turns: [],
  chatRunning: false,
  chatError: null,
  chatUsage: null,
  chatAbort: null,
  chatHistory: null,

  requestApproval: (proposal, runId) =>
    new Promise<ApprovalDecision>((resolve) => {
      set((s) => ({ pending: [...s.pending, { proposal, resolve, runId }] }));
    }),

  approve: async (id) => {
    const item = get().pending.find((p) => p.proposal.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.proposal.id !== id) }));

    try {
      item.resolve({ approved: true, backupPath: await applyProposal(item.proposal) });
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

  rejectAll: (reason, runId) => {
    const { pending, pendingPlans } = get();
    const drainP = pending.filter((p) => p.runId === runId);
    const drainL = pendingPlans.filter((p) => p.runId === runId);
    if (drainP.length === 0 && drainL.length === 0) return;
    set({
      pending: pending.filter((p) => p.runId !== runId),
      pendingPlans: pendingPlans.filter((p) => p.runId !== runId),
    });
    for (const item of drainP) item.resolve({ approved: false, reason });
    for (const item of drainL) item.resolve({ approved: false, reason });
  },

  requestPlanApproval: (plan, runId) =>
    new Promise<PlanDecision>((resolve) => {
      set((s) => ({ pendingPlans: [...s.pendingPlans, { plan, resolve, runId }] }));
    }),

  approvePlan: (id) => {
    const item = get().pendingPlans.find((p) => p.plan.id === id);
    if (!item) return;
    set((s) => ({ pendingPlans: s.pendingPlans.filter((p) => p.plan.id !== id) }));
    item.resolve({ approved: true });
  },

  rejectPlan: (id, reason) => {
    const item = get().pendingPlans.find((p) => p.plan.id === id);
    if (!item) return;
    set((s) => ({ pendingPlans: s.pendingPlans.filter((p) => p.plan.id !== id) }));
    item.resolve({ approved: false, reason });
  },

  // ── Chat session ──────────────────────────────────────────────────────────

  sendChat: async (text, quote) => {
    const message = text.trim();
    if (!message || get().chatRunning) return;
    // What the model receives: the quoted passage first, so "把这一段重写得更
    // 克制一些" has an unambiguous referent even mid-conversation.
    const quoted = quote?.trim();
    const wireMessage = quoted
      ? `${i18n.t("ai.chat.quoteBlockLabel", { defaultValue: "【选中内容】" })}\n${quoted}\n\n${message}`
      : message;

    const { useAiStore } = await import("./aiStore");
    const { useProjectStore } = await import("./projectStore");
    const { useLoreStore } = await import("./loreStore");
    const { useAppStore } = await import("./appStore");
    const { resolveModel } = await import("../lib/lore/aiTask");

    const { getWritingFocus } = await import("./editorStore");

    const { models, providers, activeModelId } = useAiStore.getState();
    const resolved = resolveModel(models, providers, activeModelId);
    const { projectPath } = useProjectStore.getState();
    // One atomic read of the focused document, held for the whole turn — see
    // editorStore.WritingFocus for why this must not be recomposed per use.
    const focus = getWritingFocus();
    const activeFilePath = focus.filePath;
    if (!projectPath) { set({ chatError: i18n.t("ai.errors.noProject") }); return; }
    if (!resolved) { set({ chatError: i18n.t("ai.errors.noModel") }); return; }
    const { model, provider } = resolved;

    const controller = new AbortController();
    const userTurn: ChatTurn = {
      id: `t${++turnCounter}`, role: "user", text: message, log: [], at: Date.now(), quote: quoted,
    };
    const assistantTurn: ChatTurn = {
      id: `t${++turnCounter}`, role: "assistant", text: "", log: [], at: Date.now(),
    };
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
      const apiKey = (await loadApiKey(provider.id)) ?? "";

      // ── History: seed on first turn, append afterwards ──
      let history = get().chatHistory;
      if (!history) {
        const { assembleContext, bundleToMessages, profileSystemPrompt } = await import("../lib/context/rag");
        const { measureCharsPerToken, RECENT_WINDOW_MIN_CHARS } = await import("../lib/context/budget");
        const { MEMORY_BUDGET_CHARS, loadMemory } = await import("../lib/context/memory");
        const { useAiStore: aiStore2 } = await import("./aiStore");

        const { prompts, activePromptId } = aiStore2.getState();
        const writingPrompt =
          prompts.find((p) => p.id === activePromptId)?.content ?? profileSystemPrompt();
        // The agent briefing belongs in the SYSTEM layer, not in the first user
        // turn: only the system message survives every later turn intact. Seeded
        // as a task-layer instruction it decayed after turn one — the author's
        // "去执行" then landed in a context whose only standing instruction was a
        // prose-writing prompt, and the assistant kept answering with plans.
        const systemPrompt = `${writingPrompt}\n\n${i18n.t("ai.instructions.agent")}`;
        const documentText = focus.text;
        // Follows the profile, like the panel's tasks do: a project whose
        // documents don't use rolling memory has none to inject.
        const memory = docModel().memory && activeFilePath
          ? await loadMemory(projectPath, activeFilePath)
          : null;
        const { loreBudgetTokens } = useAppStore.getState();
        const charsPerToken = measureCharsPerToken(documentText);

        const bundle = await assembleContext(
          systemPrompt,
          useLoreStore.getState().index,
          documentText,
          "",
          wireMessage,
          { contextChars: RECENT_WINDOW_MIN_CHARS },
          null,
          memory,
          loreBudgetTokens * charsPerToken,
          MEMORY_BUDGET_CHARS,
        );
        history = bundleToMessages(bundle);
        set({ chatHistory: history });

        // Report the seeded layers into this turn's log. This is the only turn
        // that gets automatic RAG — from here on the history is inherited and
        // the agent must reach for tools — so if nothing matched, the author
        // needs to see that now rather than infer it from a vague answer.
        patchAssistant((tn) => ({
          ...tn,
          log: appendAgentEventTo(tn.log, {
            kind: "context-seeded",
            documentName: activeFilePath
              ? (activeFilePath.split(/[\\/]/).pop() ?? "").replace(/\.md$/i, "")
              : null,
            recentChars: bundle.recentContext.length,
            memoryChars: bundle.storySummary.length,
            loreEntities: bundle.loreReport.entities.length,
            loreChars: bundle.loreReport.usedChars,
            at: Date.now(),
          }),
        }));
      } else {
        history.push({ role: "user", content: wireMessage });
      }

      const { runAgent } = await import("../lib/agent/runtime");
      const { AGENT_ASSIST_PRESET } = await import("../lib/agent/presets");
      const { contextUtilization } = useAppStore.getState();

      const { inputTokens, outputTokens, cachedTokens } = await runAgent({
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
          requestApproval: (p) => get().requestApproval(p, controller),
          requestPlanApproval: (p) => get().requestPlanApproval(p, controller),
          // One gate per turn: a plan the author approved for *this* request
          // does not silently authorise the next one.
          lorePlan: createPlanGate(),
        },
        signal: controller.signal,
        onEvent: (event) =>
          patchAssistant((tn) => ({ ...tn, log: appendAgentEventTo(tn.log, event) })),
        // Assign, not append — the runtime hands over the whole output each
        // time so it can retract a tool round's narration.
        onOutputText: (text) => patchAssistant((tn) => ({ ...tn, text })),
      });

      const cost = costFor(model, inputTokens, outputTokens, cachedTokens);
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
      recordRunOutcome(model.id, null);
      void recordChatUsage(projectPath, model.id, inputTokens, outputTokens, cost, cachedTokens);
    } catch (e) {
      if ((e as Error).name !== "AbortError" && get().chatAbort === controller) {
        const msg = String(e);
        set({ chatError: msg });
        recordRunOutcome(model.id, msg);
        patchAssistant((tn) => ({
          ...tn,
          log: appendAgentEventTo(tn.log, { kind: "run-error", message: msg, at: Date.now() }),
        }));
      }
    } finally {
      // Drain this turn's own approvals — never another run's.
      get().rejectAll("task ended", controller);
      if (get().chatAbort === controller) {
        set({ chatRunning: false, chatAbort: null });
      }
    }
  },

  stopChat: () => {
    const controller = get().chatAbort;
    controller?.abort();
    get().rejectAll("aborted by user", controller);
    set({ chatRunning: false, chatAbort: null });
  },

  resetChat: () => {
    get().stopChat();
    set({ turns: [], chatHistory: null, chatError: null, chatUsage: null });
  },
}));
