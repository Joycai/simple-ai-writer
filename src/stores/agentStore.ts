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
 *
 * ── Why every store is reached through `await import()` ──
 * aiTaskStore imports THIS module at the top level. A static import back would
 * close the cycle, so every store this file touches — aiStore, projectStore,
 * loreStore, appStore, editorStore, memoryStore — is loaded lazily at the call
 * site. Plain `src/lib/**` modules carry no such constraint and are imported
 * normally above. See docs/architecture.md → Circular Dependencies.
 */

import { create } from "zustand";
import i18n from "../i18n";
import { backupFile } from "../lib/agent/backup";
import { appendAgentEventTo, type AgentEvent } from "../lib/agent/events";
import { createPlanGate, type LorePlan, type PlanDecision } from "../lib/agent/plan";
import { AGENT_ASSIST_PRESET } from "../lib/agent/presets";
import { repairToolCallPairing, runAgent } from "../lib/agent/runtime";
import {
  inputCeilingFor, measureCharsPerToken, RECENT_WINDOW_MIN_CHARS,
} from "../lib/context/budget";
import { loadMemory, MEMORY_BUDGET_CHARS } from "../lib/context/memory";
import { parentDir } from "../lib/context/outline";
import { assembleContext, bundleToMessages, profileSystemPrompt } from "../lib/context/rag";
import { docModel, promptParams } from "../lib/profile/active";
import type { ApprovalDecision, EditProposal, Proposal } from "../lib/agent/registry";
import { resolveModel, type AttachedItem } from "../lib/lore/aiTask";
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

/**
 * What an approval carries beyond the proposal itself — supplied by the caller
 * that owns the run, because the store cannot derive either of these.
 */
export interface ApprovalBinding {
  /**
   * The chat turn a produced picture belongs to. An explicit binding, not
   * "whichever turn is last when the apply finishes": the apply can outlive
   * the run (approving is instantaneous, drawing is not), and 停止 clears
   * `chatAbort` — so an identity test against it dropped pictures the author
   * had already paid for.
   */
  turnId?: string;
  /** The run's abort signal, so an approved-but-slow apply can be cancelled. */
  signal?: AbortSignal;
}

interface PendingApproval extends ApprovalBinding {
  proposal: Proposal;
  resolve: (decision: ApprovalDecision) => void;
  runId: RunId;
}

interface PendingPlan {
  plan: LorePlan;
  resolve: (decision: PlanDecision) => void;
  runId: RunId;
}

/**
 * A run that hit its round cap mid-work, waiting for the author to choose:
 * grant `extension` more rounds, or let it wrap up now. At most one per run —
 * the runtime blocks on the answer, so a second can't queue behind the first.
 */
export interface PendingRoundLimit {
  /** Stable identity for React keys — `runId` is an opaque object. */
  id: string;
  /** Tool rounds consumed so far. */
  roundsUsed: number;
  /** Extra rounds a 继续 grants (the preset's own cap again). */
  extension: number;
  resolve: (granted: number) => void;
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
  /**
   * Assistant turns: absolute paths of pictures this turn produced.
   *
   * Filled by the approval, not by the model — the app knows exactly what was
   * drawn, and relying on the assistant to mention it produced turns that
   * apologised for being unable to show the image it had just saved.
   */
  images?: string[];
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
  /** Round-cap questions awaiting the author's decision — one per blocked run. */
  pendingRoundLimits: PendingRoundLimit[];

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
  requestApproval: (proposal: Proposal, runId: RunId, binding?: ApprovalBinding) => Promise<ApprovalDecision>;
  /** User approved: backup, apply, resolve. */
  approve: (id: string) => Promise<void>;
  /** User rejected: resolve with their optional reason. */
  reject: (id: string, reason?: string) => void;
  /** Drain both queues for one run (task aborted / finished) — resolves that
   *  run's own entries as rejected, leaving any other run's untouched. */
  rejectAll: (reason: string, runId: RunId) => void;

  /** Called by the runtime's onRoundLimit when a run reaches its round cap. */
  requestRoundExtension: (roundsUsed: number, extension: number, runId: RunId) => Promise<number>;
  /** Resolve a blocked run's round-cap question: `granted` extra rounds (0 = wrap up). */
  resolveRoundLimit: (runId: RunId, granted: number) => void;

  /** Called by propose_lore_plan (via ToolContext.requestPlanApproval). */
  requestPlanApproval: (plan: LorePlan, runId: RunId) => Promise<PlanDecision>;
  /** User approved the plan — the gate records its steps and the loop resumes. */
  approvePlan: (id: string) => void;
  /** User rejected the plan: their reason goes back to the model verbatim. */
  rejectPlan: (id: string, reason?: string) => void;

  /** @param quote Manuscript passage attached to the message, if the author
   *               pinned their selection to it (shown above the turn, and sent
   *               to the model as a 【选中内容】 block). */
  sendChat: (text: string, quote?: string, refs?: AttachedItem[]) => Promise<void>;
  stopChat: () => void;
  resetChat: () => void;
}

let turnCounter = 0;
let roundLimitCounter = 0;

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
 * What an applied proposal reports.
 *
 * `report` is what the model is told (historically just a backup path, hence
 * the field it travels back in). `imagePath` is carried separately rather than
 * scraped out of that prose — the wording is for a reader, and parsing it
 * would silently break the transcript the next time it is reworded.
 */
interface ApplyOutcome {
  report: string | null;
  imagePath?: string;
}

/**
 * Carry out what an approved proposal asked for. Throwing here is how a failure
 * reaches the model as a rejection — never swallow one and report success.
 */
async function applyProposal(proposal: Proposal, signal?: AbortSignal): Promise<ApplyOutcome> {
  const { useProjectStore } = await import("./projectStore");
  const { createEntry, moveEntry, deleteEntry } = useProjectStore.getState();

  switch (proposal.kind) {
    case "edit":
      return { report: await applyEdit(proposal) };

    case "create": {
      const dir = parentDir(proposal.path);
      await createEntry(dir, proposal.path.slice(dir.length + 1), "file", proposal.content);
      return { report: null }; // nothing existed to back up
    }

    case "move":
      await moveEntry(proposal.path, proposal.newPath);
      return { report: null }; // the file still exists, at its new path

    case "delete":
      // Folders never reach here (delete_chapter refuses them), but the backup
      // is what makes an approved deletion recoverable, so it is not optional.
      return { report: await deleteEntry(proposal.path, false, { backup: true }) };

    case "illustrate": {
      // The only kind whose "apply" spends money and calls out to a provider.
      // Approving is the author paying, so it happens here rather than at
      // proposal time — a rejected card costs nothing.
      const { runIllustration } = await import("../lib/image/illustrate");
      const { projectPath: root } = useProjectStore.getState();
      const outcome = await runIllustration(proposal, root ?? "", signal);
      if (proposal.dest.kind === "lore") {
        // The gallery grew — rescan so the entity view shows it at once.
        const { useLoreStore } = await import("./loreStore");
        if (root) void useLoreStore.getState().scanProject(root);
      }
      // Reported back to the model through backupPath (see the shared apply
      // contract): the document case needs the markdown to place next, and
      // every case needs to know whether an edit was silently regenerated.
      return {
        imagePath: outcome.path,
        report: [
          `Saved to ${outcome.path}.`,
          // Without this the assistant apologises for being unable to show the
          // picture it just made — it has no other way to know the app has
          // already put it in the transcript.
          "This picture is shown to the author in the conversation, so do not say you cannot display it — just say what you made and offer the next step.",
          outcome.markdown
            ? `Place it with propose_edit using exactly:\n${outcome.markdown.trim()}`
            : "",
          outcome.degraded
            ? "NOTE: this model cannot edit an existing picture, so it was regenerated from the instruction — it will not resemble the original. Tell the author."
            : "",
        ].filter(Boolean).join("\n"),
      };
    }
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pending: [],
  pendingPlans: [],
  pendingRoundLimits: [],

  turns: [],
  chatRunning: false,
  chatError: null,
  chatUsage: null,
  chatAbort: null,
  chatHistory: null,

  requestApproval: (proposal, runId, binding) =>
    new Promise<ApprovalDecision>((resolve) => {
      set((s) => ({ pending: [...s.pending, { proposal, resolve, runId, ...binding }] }));
    }),

  approve: async (id) => {
    const item = get().pending.find((p) => p.proposal.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.proposal.id !== id) }));

    try {
      const { report, imagePath } = await applyProposal(item.proposal, item.signal);
      // A picture goes into the transcript as well as onto disk — into the turn
      // the request came from, named at request time. The task panel shares
      // this queue and binds no turn, so its images stay out of the chat.
      if (imagePath && item.turnId) {
        set((s) => ({
          turns: s.turns.map((tn) =>
            tn.id === item.turnId ? { ...tn, images: [...(tn.images ?? []), imagePath] } : tn),
        }));
      }
      item.resolve({ approved: true, backupPath: report });
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

  requestRoundExtension: (roundsUsed, extension, runId) =>
    new Promise<number>((resolve) => {
      const id = `round-limit-${++roundLimitCounter}`;
      set((s) => ({
        pendingRoundLimits: [...s.pendingRoundLimits, { id, roundsUsed, extension, resolve, runId }],
      }));
    }),
  resolveRoundLimit: (runId, granted) => {
    const item = get().pendingRoundLimits.find((p) => p.runId === runId);
    if (!item) return;
    set((s) => ({ pendingRoundLimits: s.pendingRoundLimits.filter((p) => p.runId !== runId) }));
    item.resolve(granted);
  },

  rejectAll: (reason, runId) => {
    const { pending, pendingPlans, pendingRoundLimits } = get();
    const drainP = pending.filter((p) => p.runId === runId);
    const drainL = pendingPlans.filter((p) => p.runId === runId);
    const drainR = pendingRoundLimits.filter((p) => p.runId === runId);
    if (drainP.length === 0 && drainL.length === 0 && drainR.length === 0) return;
    set({
      pending: pending.filter((p) => p.runId !== runId),
      pendingPlans: pendingPlans.filter((p) => p.runId !== runId),
      pendingRoundLimits: pendingRoundLimits.filter((p) => p.runId !== runId),
    });
    for (const item of drainP) item.resolve({ approved: false, reason });
    for (const item of drainL) item.resolve({ approved: false, reason });
    // 0 extra rounds = wrap up; the aborted signal is re-checked right after.
    for (const item of drainR) item.resolve(0);
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

  sendChat: async (text, quote, refs = []) => {
    const message = text.trim();
    if (!message || get().chatRunning) return;
    // What the model receives: the quoted passage and any @-referenced material
    // first, so "把这一段重写得更克制一些" has an unambiguous referent even
    // mid-conversation. Composition lives in lib/agent/chatRefs.
    const quoted = quote?.trim();
    const { buildChatMessage } = await import("../lib/agent/chatRefs");
    const wireMessage = await buildChatMessage(message, quoted, refs);

    // Stores are reached lazily throughout this module: aiTaskStore imports
    // *this* one at the top level, so agentStore must stay free of static store
    // imports or the cycle closes. See docs/architecture.md → Circular deps.
    const { useAiStore } = await import("./aiStore");
    const { useProjectStore } = await import("./projectStore");
    const { useLoreStore } = await import("./loreStore");
    const { useAppStore } = await import("./appStore");
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
        const { useAiStore: aiStore2 } = await import("./aiStore");

        const { prompts, activePromptId } = aiStore2.getState();
        const writingPrompt =
          prompts.find((p) => p.id === activePromptId)?.content ?? profileSystemPrompt();
        // The agent briefing belongs in the SYSTEM layer, not in the first user
        // turn: only the system message survives every later turn intact. Seeded
        // as a task-layer instruction it decayed after turn one — the author's
        // "去执行" then landed in a context whose only standing instruction was a
        // prose-writing prompt, and the assistant kept answering with plans.
        const systemPrompt = `${writingPrompt}\n\n${i18n.t("ai.instructions.agent", promptParams(i18n.language === "zh-CN"))}`;
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
        // A previous turn that was stopped, or crashed between two pushes, can
        // leave an assistant tool_calls message without every reply it needs —
        // and appending onto that makes the provider reject not just this turn
        // but every turn after it. Repair before adding to it.
        repairToolCallPairing(history);
        history.push({ role: "user", content: wireMessage });
      }

      const { contextUtilization } = useAppStore.getState();

      const { inputTokens, outputTokens, cachedTokens } = await runAgent({
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        safetySettings: provider.safetySettings,
        modelId: model.modelId,
        prefix: model.prefix,
        contextSize: model.contextSize,
        // Never undefined: without a ceiling the tool loop's history trimming
        // is a no-op, and a chat that reads pictures accumulates base64 in a
        // history that persists across turns until the provider rejects it.
        inputCeilingTokens: inputCeilingFor(model.contextSize, contextUtilization),
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
          requestApproval: (p) =>
            get().requestApproval(p, controller, {
              turnId: assistantTurn.id,
              signal: controller.signal,
            }),
          requestPlanApproval: (p) => get().requestPlanApproval(p, controller),
          // One gate per turn: a plan the author approved for *this* request
          // does not silently authorise the next one.
          lorePlan: createPlanGate(),
        },
        signal: controller.signal,
        // At the round cap, block on the author's 继续/收尾 card instead of
        // force-ending. Each 继续 grants the preset's own cap again.
        onRoundLimit: (roundsUsed) =>
          get().requestRoundExtension(roundsUsed, AGENT_ASSIST_PRESET.maxRounds, controller),
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
