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
 * ── Chat sessions ──
 * Several conversations at a time (docs/feature/agent/chat-sessions-plan.md):
 * `chats` holds every open one by a local key, `activeChatKey` says which is on
 * screen, and `runningChats` / `chatQueue` say which are generating — two axes
 * that never read each other. Per conversation, the protocol history is the same
 * array the runtime mutates in place: turn N's tool calls and results stay in
 * context for turn N+1, which is what makes it a real conversation rather than
 * repeated one-shots. The first turn seeds the history through assembleContext
 * (lore/memory/recent-window injection, same layers as the task panel);
 * later turns just append a user message. Display state (turns) is kept
 * separately — the history holds wire messages, the turns hold what the user
 * sees (text + per-turn execution log).
 *
 * ── Where the rest of it lives ──
 * This file is the store: state, actions, the approval queue. Split beside it
 * (docs/feature/code-structure-plan.md P5), and re-exported from here so
 * importers keep one address:
 *   - `stores/agent/types.ts` — the state shape and every pending-card kind;
 *   - `stores/agent/chatJob.ts` — one chat turn's run and the multi-conversation
 *     plumbing, called with this store's `set` / `get`;
 *   - `stores/agent/selectors.ts` — pure reads for components;
 *   - `lib/agent/proposalApply.ts` — carrying out an approved proposal, with
 *     the app handed in as `ProposalApplyDeps`.
 *
 * ── Why some stores are still reached through `await import()` ──
 * Not cycles — there are none left. projectStore, appStore, openDocument and
 * memoryStore each pull in appStore, which paints the theme onto `document` at
 * module load, and this module is imported directly by node-environment
 * tests. Every other store is imported normally above. See
 * docs/reference/architecture.md → Circular Dependencies.
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import i18n from "../i18n";
import { planFold } from "../lib/agent/compact";
import { compactChatHistory, summarizeForCompaction } from "../lib/agent/compactRun";
import { requestStateUpdate, updateSkillState } from "../lib/agent/skillStateRun";
import { isSkillStateEnabled } from "../lib/agent/stateFlag";
import { STATE_KEEP_TURNS } from "../lib/agent/skillState";
import {
  deserializeChatSession, maxTurnId, serializeChatSession, sessionPreview,
} from "../lib/agent/chatSession";
import { applyRewindCut, planRewind } from "../lib/agent/rewind";
import { deleteChatSession as deleteChatSessionRow, listChatSessions, loadChatSession, normalizeSessionTitle, setChatSessionPinned, setChatSessionTitle, upsertChatSession } from "../lib/agent/sessionDb";
import { ownerBusy } from "../lib/agent/scheduler";
import { sessionLabel } from "../lib/agent/sessionDb";
import { appendAgentEventTo } from "../lib/agent/events";
import { undoWrites } from "../lib/agent/undo";
import { turnWrites } from "../lib/agent/planLedger";
import { COMMAND_GRANT_MAX, ILLUSTRATE_GRANT_MAX, grants, grantsAppend, grantsCommand, grantsIllustrate, isAutoApprovable, isChatAutoApproveKey } from "../lib/agent/autoApprove";
import type { PlanDecision } from "../lib/agent/plan";
import { markTaskAborted, markTaskPaused, markTaskResumed } from "../lib/agent/taskWorkspace";
import { chatAgentPreset } from "../lib/agent/packs";
import { visionSubAgentModel, withSessionOverrides } from "../lib/agent/subagentModel";
import { subAgentModel } from "../lib/agent/subagentModel";
import { isAsrEnabled } from "../lib/asr/flag";
import { newChatStateMemory } from "../lib/agent/stateFlag";
import { repairToolCallPairing, type RoundLimitDecision, type TruncationDecision } from "../lib/agent/runtime";
import { messageCeilingFor } from "../lib/agent/toolCost";
import { useAiStore } from "./aiStore";
import type { PendingApproval, ChatTurn, LiveChat, AgentState } from "./agent/types";
import { newChatKey, freshChat, chatFromSnapshot, patchChat, openSessionIds, refreshSessionList, noteCardFor, endGrantFor, pump, workspaceForSnapshot, buildResumeSeed } from "./agent/chatJob";
import { activeChat, type ChatStateInputs, pickChatStateInputs, chatStateOf } from "./agent/selectors";
import { applyProposal, flushEditor, type ProposalApplyDeps } from "../lib/agent/proposalApply";
import { useEditorStore } from "./editorStore";
import { useLoreStore } from "./loreStore";
import { useComposerStore } from "./composerStore";
import type { ApprovalDecision, AskAnswer } from "../lib/agent/registry";
import { fileExists } from "../lib/fs/fileio";
import { loadApiKey } from "../lib/keyStore";
import { canSeeImages } from "../lib/ai/configDb";
import { canReadVideo, sentVideoFps } from "../lib/ai/videoInput";
import { connOptions, resolveConn } from "../lib/ai/conn";
import { notify } from "../lib/notify";
import { baseName, isSamePath, joinPath } from "../lib/paths";


let turnCounter = 0;
let roundLimitCounter = 0;
let truncationCounter = 0;
let questionCounter = 0;
/**
 * The in-flight manual compactions' abort handles (compactChatNow), by chat
 * key. Module-level rather than state: nothing renders from them — stopChat
 * just needs a way to cancel a summarize request that would otherwise hold the
 * compacting slot.
 */
const compactAborts: Record<string, AbortController> = {};


/**
 * What `applyProposal` reads from the app (lib/agent/proposalApply). projectStore
 * stays a lazy import here for the reason the module doc gives.
 */
async function proposalApplyDeps(): Promise<ProposalApplyDeps> {
  const { useProjectStore } = await import("./projectStore");
  return {
    projectPath: () => useProjectStore.getState().projectPath,
    activeFilePath: () => useProjectStore.getState().activeFilePath,
    editor: () => useEditorStore.getState(),
    entries: () => useProjectStore.getState(),
    refreshFileTree: () => useProjectStore.getState().refreshFileTree(),
    aiSettings: () => useAiStore.getState(),
    lore: () => useLoreStore.getState(),
  };
}

/**
 * Carry out an approved proposal and unblock the tool call waiting on it.
 *
 * Shared by the card's 批准 button and by the auto-approve path, so that the
 * two cannot drift: an auto-approved edit is applied, backed up and reported
 * exactly like one the author clicked through. The item must already be out of
 * `pending` (or never have entered it) — this function only applies.
 */
async function settleApproval(
  item: PendingApproval,
  set: (fn: (s: AgentState) => Partial<AgentState>) => void,
  auto: boolean,
): Promise<void> {
  try {
    const { report, imagePath, resultPath, exportSummary } = await applyProposal(
      item.proposal, await proposalApplyDeps(), item.signal, item.onApplyProgress,
    );
    // A picture goes into the transcript as well as onto disk — into the turn
    // the request came from, named at request time. The task panel shares
    // this queue and binds no turn, so its images stay out of the chat.
    if (imagePath && item.turnId) {
      set((s) => {
        // Whichever open conversation holds the turn — the run may be on a
        // background tab by the time the picture is drawn.
        const key = Object.keys(s.chats).find((k) =>
          s.chats[k].turns.some((tn) => tn.id === item.turnId));
        if (!key) return {};
        const chat = s.chats[key];
        return {
          chats: {
            ...s.chats,
            [key]: {
              ...chat,
              turns: chat.turns.map((tn) =>
                tn.id === item.turnId ? { ...tn, images: [...(tn.images ?? []), imagePath] } : tn),
            },
          },
        };
      });
    }
    // An export lands in the transcript on the same terms a picture does: the
    // turn that asked for it keeps the receipt, and a run that binds no turn
    // (the task panel) keeps none — there the model's own sentence is all there
    // is, and inventing a card with nowhere to live would be worse.
    if (exportSummary && item.turnId) {
      set((s) => {
        const key = Object.keys(s.chats).find((k) =>
          s.chats[k].turns.some((tn) => tn.id === item.turnId));
        if (!key) return {};
        const chat = s.chats[key];
        return {
          chats: {
            ...s.chats,
            [key]: {
              ...chat,
              turns: chat.turns.map((tn) =>
                tn.id === item.turnId
                  ? { ...tn, exports: [...(tn.exports ?? []), exportSummary] }
                  : tn),
            },
          },
        };
      });
    }
    item.resolve({ approved: true, backupPath: report, resultPath, auto: auto || undefined });
  } catch (e) {
    // Approval failed to apply — report as a rejection so the model knows
    // the manuscript is untouched.
    item.resolve({ approved: false, reason: `apply failed: ${String(e)}` });
  }
}

/**
 * The OS ping for "the run has stopped and is waiting for you". Every queueing
 * point calls this right after the card lands in state, never before: a card
 * that turned out to be covered by a standing grant is not a wait.
 *
 * `notify` decides whether anything is actually sent (switch off / window
 * focused / another approval already announced seconds ago) — see lib/notify.
 */
function notifyApproval(bodyKey: string, params?: Record<string, string>): void {
  notify("approval", i18n.t("notify.approvalTitle"), i18n.t(bodyKey, params ?? {}));
}

/** Basename, for a notification that must fit on one line. */
function fileLabel(path: string): string {
  return baseName(path) || path;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pending: [],
  pendingPlans: [],
  pendingRoundLimits: [],
  pendingTruncations: [],
  pendingQuestions: [],
  autoApprove: null,

  chats: { c0: freshChat("c0") },
  chatOrder: ["c0"],
  activeChatKey: "c0",
  runningChats: [],
  compactingChats: [],
  chatQueue: [],
  chatAborts: {},
  lastClosedLabel: null,
  projectSwitchGuard: null,
  chatSessions: [],

  enableAutoApprove: (key, what) =>
    set((s) => {
      const held = s.autoApprove?.key === key ? s.autoApprove : null;
      return {
        autoApprove: {
          key,
          proposals: what === "proposals" || !!held?.proposals,
          plans: what === "plans" || !!held?.plans,
          appendPaths: held?.appendPaths ?? [],
          illustrateLeft: held?.illustrateLeft ?? 0,
          illustrateRun: held?.illustrateRun,
          commandLeft: held?.commandLeft ?? 0,
          commandRun: held?.commandRun,
        },
      };
    }),

  grantAppendPath: (key, path) =>
    set((s) => {
      // Same displacement rule as enableAutoApprove: a grant from another
      // surface is replaced, not merged, so only one surface ever holds one.
      const held = s.autoApprove?.key === key ? s.autoApprove : null;
      return {
        autoApprove: {
          key,
          proposals: !!held?.proposals,
          plans: !!held?.plans,
          appendPaths: held?.appendPaths.includes(path)
            ? held.appendPaths
            : [...(held?.appendPaths ?? []), path],
          illustrateLeft: held?.illustrateLeft ?? 0,
          illustrateRun: held?.illustrateRun,
          commandLeft: held?.commandLeft ?? 0,
          commandRun: held?.commandRun,
        },
      };
    }),

  grantCommands: (key, runId, count) =>
    set((s) => {
      const held = s.autoApprove?.key === key ? s.autoApprove : null;
      return {
        autoApprove: {
          key,
          proposals: !!held?.proposals,
          plans: !!held?.plans,
          appendPaths: held?.appendPaths ?? [],
          illustrateLeft: held?.illustrateLeft ?? 0,
          illustrateRun: held?.illustrateRun,
          // Replaces rather than adds, exactly like the image batch: the
          // number picked on this card is the whole remaining authorisation.
          commandLeft: Math.max(1, Math.min(COMMAND_GRANT_MAX, Math.floor(count))),
          commandRun: runId,
        },
      };
    }),

  grantIllustrations: (key, runId, count) =>
    set((s) => {
      const held = s.autoApprove?.key === key ? s.autoApprove : null;
      return {
        autoApprove: {
          key,
          proposals: !!held?.proposals,
          plans: !!held?.plans,
          appendPaths: held?.appendPaths ?? [],
          // Replaces rather than adds: the author picked a number off the
          // card just now, and that number is the whole authorisation.
          illustrateLeft: Math.max(1, Math.min(ILLUSTRATE_GRANT_MAX, Math.floor(count))),
          illustrateRun: runId,
          commandLeft: held?.commandLeft ?? 0,
          commandRun: held?.commandRun,
        },
      };
    }),

  clearAutoApprove: () => set({ autoApprove: null }),

  requestApproval: (proposal, runId, binding) =>
    new Promise<ApprovalDecision>((resolve) => {
      const item: PendingApproval = { proposal, resolve, runId, at: Date.now(), ...binding };
      // Covered by a standing grant: apply now and never queue. Queuing first
      // and approving synchronously would flash the card for a frame.
      const covered =
        (grants(get().autoApprove, item.autoApproveKey, "proposals")
          && isAutoApprovable(proposal.kind))
        // The narrow grant: this one file, appends only.
        || (proposal.kind === "append"
          && grantsAppend(get().autoApprove, item.autoApproveKey, proposal.path))
        // Counted command batch. Read commands never enter this queue;
        // dangerous-looking writes are re-judged and always get a card.
        || (proposal.kind === "command"
          && grantsCommand(get().autoApprove, item.autoApproveKey, runId, proposal));
      if (covered) {
        if (proposal.kind === "command") {
          // Spend before starting: two proposals can arrive close together.
          set((s) => s.autoApprove
            ? { autoApprove: { ...s.autoApprove, commandLeft: s.autoApprove.commandLeft - 1 } }
            : {});
        }
        void settleApproval(item, set, true);
        return;
      }
      // The counted illustrate budget — spent *before* the apply starts, so a
      // second proposal arriving while the first still renders cannot ride
      // the same remaining count twice.
      if (proposal.kind === "illustrate"
        && grantsIllustrate(get().autoApprove, item.autoApproveKey)) {
        set((s) => s.autoApprove
          ? { autoApprove: { ...s.autoApprove, illustrateLeft: s.autoApprove.illustrateLeft - 1 } }
          : {});
        void settleApproval(item, set, true);
        return;
      }
      set((s) => ({ pending: [...s.pending, item] }));
      noteCardFor(set, get, item.surface);
      // Deliberately kind-neutral: a notification is a summons, and the card
      // itself is where "改动 / 删除 / 导出" is spelled out.
      notifyApproval("notify.approvalWork", { file: fileLabel(proposal.path) });
    }),

  approve: async (id) => {
    const item = get().pending.find((p) => p.proposal.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.proposal.id !== id) }));
    await settleApproval(item, set, false);
  },

  reject: (id, reason) => {
    const item = get().pending.find((p) => p.proposal.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.proposal.id !== id) }));
    item.resolve({ approved: false, reason });
  },

  requestRoundExtension: (roundsUsed, extension, runId, canPause, surface) =>
    new Promise<RoundLimitDecision>((resolve) => {
      const id = `round-limit-${++roundLimitCounter}`;
      set((s) => ({
        pendingRoundLimits: [
          ...s.pendingRoundLimits,
          { id, roundsUsed, extension, canPause, resolve, runId, surface, at: Date.now() },
        ],
      }));
      noteCardFor(set, get, surface);
      notifyApproval("notify.approvalRound");
    }),
  requestTruncationDecision: (recoveries, runId, surface) =>
    new Promise<TruncationDecision>((resolve) => {
      const id = `truncation-${++truncationCounter}`;
      set((s) => ({
        pendingTruncations: [
          ...s.pendingTruncations, { id, recoveries, resolve, runId, surface, at: Date.now() },
        ],
      }));
      noteCardFor(set, get, surface);
      notifyApproval("notify.approvalTruncation");
    }),
  resolveTruncation: (runId, decision) => {
    const item = get().pendingTruncations.find((p) => p.runId === runId);
    if (!item) return;
    set((s) => ({ pendingTruncations: s.pendingTruncations.filter((p) => p !== item) }));
    item.resolve(decision);
  },

  resolveRoundLimit: (runId, decision) => {
    const item = get().pendingRoundLimits.find((p) => p.runId === runId);
    if (!item) return;
    set((s) => ({ pendingRoundLimits: s.pendingRoundLimits.filter((p) => p.runId !== runId) }));
    item.resolve(decision);
  },

  requestQuestion: (q, runId, surface) =>
    new Promise<AskAnswer>((resolve) => {
      const id = `question-${++questionCounter}`;
      set((s) => ({
        pendingQuestions: [
          ...s.pendingQuestions,
          { id, question: q.question, options: q.options, resolve, runId, surface, at: Date.now() },
        ],
      }));
      noteCardFor(set, get, surface);
      notifyApproval("notify.approvalQuestion");
    }),
  resolveQuestion: (id, answer) => {
    const item = get().pendingQuestions.find((p) => p.id === id);
    if (!item) return;
    set((s) => ({ pendingQuestions: s.pendingQuestions.filter((p) => p.id !== id) }));
    item.resolve(answer);
  },

  rejectAll: (reason, runId) => {
    // A panel task's grant is scoped to its run, and this is the one place
    // every finish/abort path already goes through. A chat conversation's
    // grant is keyed `chat:<key>`, never a controller, so it is untouched here
    // — closing or resetting that conversation is what ends it (endGrantFor).
    if (get().autoApprove?.key === runId) set({ autoApprove: null });
    // Counted image/command budgets die with the run that granted them, even
    // in chat where boolean grants live on. A remainder must not sit armed
    // across turns the author has not read yet.
    else if (get().autoApprove?.illustrateRun === runId
      || get().autoApprove?.commandRun === runId) {
      set((s) => s.autoApprove
        ? {
            autoApprove: {
              ...s.autoApprove,
              illustrateLeft: s.autoApprove.illustrateRun === runId ? 0 : s.autoApprove.illustrateLeft,
              illustrateRun: s.autoApprove.illustrateRun === runId ? undefined : s.autoApprove.illustrateRun,
              commandLeft: s.autoApprove.commandRun === runId ? 0 : s.autoApprove.commandLeft,
              commandRun: s.autoApprove.commandRun === runId ? undefined : s.autoApprove.commandRun,
            },
          }
        : {});
    }

    const {
      pending, pendingPlans, pendingRoundLimits, pendingTruncations, pendingQuestions,
    } = get();
    const drainP = pending.filter((p) => p.runId === runId);
    const drainL = pendingPlans.filter((p) => p.runId === runId);
    const drainR = pendingRoundLimits.filter((p) => p.runId === runId);
    const drainT = pendingTruncations.filter((p) => p.runId === runId);
    const drainQ = pendingQuestions.filter((p) => p.runId === runId);
    if (
      drainP.length === 0 && drainL.length === 0
      && drainR.length === 0 && drainT.length === 0 && drainQ.length === 0
    ) return;
    set({
      pending: pending.filter((p) => p.runId !== runId),
      pendingPlans: pendingPlans.filter((p) => p.runId !== runId),
      pendingRoundLimits: pendingRoundLimits.filter((p) => p.runId !== runId),
      pendingTruncations: pendingTruncations.filter((p) => p.runId !== runId),
      pendingQuestions: pendingQuestions.filter((p) => p.runId !== runId),
    });
    for (const item of drainP) item.resolve({ approved: false, reason });
    for (const item of drainL) item.resolve({ approved: false, reason });
    // Finish = wrap up; the aborted signal is re-checked right after.
    for (const item of drainR) item.resolve({ action: "finish" });
    // Stop, for the same reason: the run is over, and answering 继续 into a
    // dead run would leave the loop trying to recover from nothing.
    for (const item of drainT) item.resolve({ action: "stop" });
    // Dismissed, not answered: a dangling Promise here would leave the tool
    // call awaiting forever behind a card that no longer exists.
    for (const item of drainQ) item.resolve({ kind: "dismissed" });
  },

  requestPlanApproval: (plan, runId, autoApproveKey, surface) =>
    new Promise<PlanDecision>((resolve) => {
      // A standing grant skips the card, not the gate: the model still had to
      // declare its steps, and every lore write is still checked against them
      // (plan.ts → checkPlan). What the author gave up is reading each pass.
      if (grants(get().autoApprove, autoApproveKey, "plans")) {
        resolve({ approved: true });
        return;
      }
      set((s) => ({
        pendingPlans: [...s.pendingPlans, { plan, resolve, runId, autoApproveKey, surface, at: Date.now() }],
      }));
      noteCardFor(set, get, surface);
      notifyApproval("notify.approvalPlan");
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

  // ── Chat sessions (多个活会话) ────────────────────────────────────────────

  toggleSubAgent: (kind, key) => {
    const k = key ?? get().activeChatKey;
    patchChat(set, k, (c) => ({
      disabledSubAgents: c.disabledSubAgents.includes(kind)
        ? c.disabledSubAgents.filter((x) => x !== kind)
        : [...c.disabledSubAgents, kind],
    }));
  },
  setPlanMode: (on, key) => patchChat(set, key ?? get().activeChatKey, { planMode: on }),
  setStateMemory: (on, key) => {
    const k = key ?? get().activeChatKey;
    const chat = get().chats[k];
    if (!chat) return;
    if (chat.meta) chat.meta.stateMode = on;
    patchChat(set, k, { stateMemory: on });
    // The mode is part of the saved session (chatSession.ts) — a flip with no
    // turn after it would otherwise be lost with the window.
    void get().persistChat(k);
  },
  applyStateMemoryDefault: () => {
    const on = newChatStateMemory();
    set((st) => {
      let chats = st.chats;
      for (const [k, c] of Object.entries(st.chats)) {
        if (c.turns.length > 0 || c.sessionId !== null || c.stateMemory === on) continue;
        if (chats === st.chats) chats = { ...st.chats };
        chats[k] = { ...c, stateMemory: on };
      }
      return chats === st.chats ? {} : { chats };
    });
  },

  activateChat: (key) => {
    if (!get().chats[key]) return;
    // Looking at it is reading it: whatever arrived while the author was on
    // another tab has now been seen.
    set({ activeChatKey: key });
    patchChat(set, key, { unread: false });
  },

  newChat: () => {
    const s = get();
    // An empty conversation is already "a new one"; a second empty tab would be
    // two names for the same nothing (an empty session has no row either).
    // Reset it to defaults rather than merely focus it: the author asked for a
    // fresh start, and chips left on from before are not fresh.
    const empty = s.chatOrder.find((k) => {
      const c = s.chats[k];
      return c && c.turns.length === 0 && !ownerBusy(k, s.runningChats, s.compactingChats, s.chatQueue);
    });
    const key = empty ?? newChatKey();
    endGrantFor(set, get, key);
    set((st) => ({
      chats: { ...st.chats, [key]: freshChat(key) },
      chatOrder: empty ? st.chatOrder : [...st.chatOrder, key],
      activeChatKey: key,
      lastClosedLabel: null,
    }));
    return key;
  },

  closeChat: async (key) => {
    const s = get();
    const chat = s.chats[key];
    if (!chat) return true;
    // Closing is not stopping: a run in flight, a fold in flight or a job in
    // the queue belongs to this tab, and the caller stops it first (and asks
    // the author before doing so).
    if (ownerBusy(key, s.runningChats, s.compactingChats, s.chatQueue)) return false;
    await get().persistChat(key);
    const label = sessionLabel(
      { title: chat.title, preview: chat.turns.find((tn) => tn.role === "user")?.text ?? "" },
      "",
    );
    endGrantFor(set, get, key);
    useComposerStore.getState().clearChatComposer(key);
    set((st) => {
      const { [key]: _gone, ...chats } = st.chats;
      const order = st.chatOrder.filter((k) => k !== key);
      let active = st.activeChatKey;
      if (active === key) {
        // The neighbour on the left, else the right — where the eye already is.
        const idx = st.chatOrder.indexOf(key);
        active = order[Math.max(0, idx - 1)] ?? order[0] ?? "";
      }
      return { chats, chatOrder: order, activeChatKey: active };
    });
    // Never zero tabs: the composer must always have a conversation to send to.
    // The empty one that takes its place says where the closed one went.
    if (get().chatOrder.length === 0) {
      get().newChat();
      set({ lastClosedLabel: label || null });
    }
    // A closed tab's row falls back under the ordinary cap — which the list
    // re-applies on read.
    void refreshSessionList(set, get);
    return true;
  },

  renameChat: async (title, key) => {
    const k = key ?? get().activeChatKey;
    const chat = get().chats[k];
    if (!chat) return;
    const clean = normalizeSessionTitle(title);
    // Memory first, so the name is on screen at once whether or not the
    // conversation has a row yet (plan §3.2); the first persist carries it.
    patchChat(set, k, { title: clean });
    if (chat.sessionId === null) return;
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;
    try {
      await setChatSessionTitle(projectPath, chat.sessionId, clean);
      await refreshSessionList(set, get);
    } catch (e) {
      console.warn("chat session rename failed:", e);
    }
  },

  renameSession: async (id, title) => {
    const s = get();
    const openKey = s.chatOrder.find((k) => s.chats[k]?.sessionId === id);
    if (openKey) return get().renameChat(title, openKey);
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;
    try {
      await setChatSessionTitle(projectPath, id, normalizeSessionTitle(title));
      await refreshSessionList(set, get);
    } catch (e) {
      console.warn("chat session rename failed:", e);
    }
  },

  deleteChatSession: async (id) => {
    const s = get();
    const openKey = s.chatOrder.find((k) => s.chats[k]?.sessionId === id) ?? null;
    // A running conversation is not deletable — the caller disables the
    // action and says why (plan §3.5). Stop first, then delete.
    if (openKey && ownerBusy(openKey, s.runningChats, s.compactingChats, s.chatQueue)) return false;
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return false;
    try {
      await deleteChatSessionRow(projectPath, id);
    } catch (e) {
      console.warn("chat session delete failed:", e);
      return false;
    }
    if (openKey) {
      // Same tab bookkeeping as closeChat, minus the persist — the row is
      // gone on purpose, and saving would resurrect it.
      endGrantFor(set, get, openKey);
      set((st) => {
        const { [openKey]: _gone, ...chats } = st.chats;
        const order = st.chatOrder.filter((k) => k !== openKey);
        let active = st.activeChatKey;
        if (active === openKey) {
          const idx = st.chatOrder.indexOf(openKey);
          active = order[Math.max(0, idx - 1)] ?? order[0] ?? "";
        }
        return { chats, chatOrder: order, activeChatKey: active };
      });
      if (get().chatOrder.length === 0) get().newChat();
    }
    await refreshSessionList(set, get);
    return true;
  },

  sendChat: (text, quote, refs = [], opts) =>
    get().sendChatTo(get().activeChatKey, text, quote, refs, opts),

  sendChatTo: async (key, text, quote, refs = [], opts) => {
    const message = text.trim();
    const chat = get().chats[key];
    if (!message || !chat) return;
    // A manual compaction is about to swap the history this send would append
    // onto. (Running is *not* a reason to refuse any more: the job queues
    // behind the turn in flight and runs when it settles.)
    if (get().compactingChats.includes(key)) return;
    const quoted = quote?.trim();

    // Stores are reached lazily throughout this module: aiTaskStore imports
    // *this* one at the top level, so agentStore must stay free of static store
    // imports or the cycle closes. See docs/reference/architecture.md → Circular deps.
    const { useProjectStore } = await import("./projectStore");
    const { getWritingFocus } = await import("./openDocument");

    // Resolved at *send* time and carried on the job: a queued question runs on
    // the model that was active when it was asked, not on whatever the header
    // says by the time a slot frees up.
    const { models, providers, activeModelId } = useAiStore.getState();
    const resolved = resolveConn(models, providers, activeModelId);
    const { projectPath } = useProjectStore.getState();
    // One atomic read of the focused document, held for the whole turn — see
    // openDocument.WritingFocus for why this must not be recomposed per use.
    // Read now, not when the job starts: the author asked about the document
    // they were looking at when they pressed Enter.
    const focus = getWritingFocus();
    if (!projectPath) { patchChat(set, key, { error: i18n.t("ai.errors.noProject") }); return; }
    if (!resolved.ok) { patchChat(set, key, { error: resolved.error }); return; }
    const { model, provider } = resolved;

    // Resolved once for the whole turn: the composer, the router and the
    // delegate resolver all have to agree on which subagents are live.
    const effectiveSubs = withSessionOverrides(
      useAiStore.getState().subAgents, chat.disabledSubAgents,
    );

    // What the model receives: the quoted passage and any @-referenced material
    // first, so "把这一段重写得更克制一些" has an unambiguous referent even
    // mid-conversation. Composition lives in lib/agent/chatRefs. Built after
    // the model is resolved, because whether an attached picture can travel at
    // all is a property of the model.
    const { buildChatMessage } = await import("../lib/agent/chatRefs");
    const { text: wireMessage, content: composed, imagePaths } = await buildChatMessage(
      message, quoted, refs,
      {
        // Unchanged and deliberately narrow: base64 goes only to a model that
        // can read it. What widened is the *fallback* — see visionDelegate.
        allowImages: canSeeImages(model),
        visionDelegate: visionSubAgentModel(
          useAiStore.getState().models, effectiveSubs,
        ) !== null,
        // Same rule as routing.ts's append: Beta on AND an `asr` binding —
        // a mentioned recording is pointed at the tool only when it is there.
        transcribe: isAsrEnabled()
          && subAgentModel("asr", useAiStore.getState().models, effectiveSubs) !== null,
        // Declared on the model AND a wire with a `video_url` part — a clip on
        // any other wire is at best an empty answer (docs/feature/video-input.md).
        allowVideo: canReadVideo(model, provider),
        videoFps: sentVideoFps(model, provider),
      },
    );

    const userTurn: ChatTurn = {
      id: `t${++turnCounter}`, role: "user",
      // The wire gets `message`; the transcript can show something shorter. A
      // resume seed is a whole task.md plus a notes index — correct to send,
      // but a wall of machine-written text attributed to the author on screen.
      text: opts?.displayText ?? message,
      log: [], at: Date.now(), quote: quoted,
      images: imagePaths.length ? imagePaths : undefined,
    };
    const assistantTurn: ChatTurn = {
      id: `t${++turnCounter}`, role: "assistant", text: "", log: [], at: Date.now(),
    };
    // The awaits above (reading @-referenced files can take a while) are the
    // one window in which an idle tab can be closed under a send. A job for a
    // conversation that no longer exists would spend a model call on nothing.
    if (!get().chats[key]) return;
    // On screen at once, whatever the queue says: the author's words are the
    // record of what was asked, and the empty assistant turn is where the
    // answer — or the wait for a slot — is drawn.
    patchChat(set, key, (c) => ({ turns: [...c.turns, userTurn, assistantTurn], error: null }));
    set((s) => ({
      chatQueue: [...s.chatQueue, {
        key, projectPath, focus, message, quoted, refs, opts,
        model, provider, effectiveSubs, wireMessage, composed, imagePaths,
        userTurnId: userTurn.id,
        assistantTurnId: assistantTurn.id,
      }],
      lastClosedLabel: null,
    }));
    pump(set, get);
  },

  stopChat: (key) => {
    const k = key ?? get().activeChatKey;
    const controller = get().chatAborts[k];
    controller?.abort();
    // A hanging manual compaction holds the compacting slot (and with it every
    // send to this conversation) until its request settles — stop covers it too.
    compactAborts[k]?.abort();
    // The abort signal does not resolve a card the run is blocked on — the
    // runtime awaits a Promise, and abort makes nothing reject. Drain them.
    if (controller) get().rejectAll("aborted by user", controller);
    // Stopping is an intervention: a question queued behind the stopped turn
    // would fire the moment the slot frees, which undoes it. Its placeholder
    // answer goes with it; the author's words stay as the record of the ask.
    const dropped = get().chatQueue.filter((j) => j.key === k).map((j) => j.assistantTurnId);
    set((s) => {
      const chatAborts = { ...s.chatAborts };
      delete chatAborts[k];
      return {
        runningChats: s.runningChats.filter((x) => x !== k),
        chatAborts,
        chatQueue: s.chatQueue.filter((j) => j.key !== k),
      };
    });
    if (dropped.length) {
      patchChat(set, k, (c) => ({ turns: c.turns.filter((tn) => !dropped.includes(tn.id)) }));
    }
    pump(set, get);
  },

  dequeueChat: (key) => {
    const mine = get().chatQueue.filter((j) => j.key === key);
    if (mine.length === 0) return null;
    // Both placeholder turns go: the words go back to the composer, so leaving
    // them in the transcript would show the question twice.
    const gone = new Set(mine.flatMap((j) => [j.userTurnId, j.assistantTurnId]));
    set((s) => ({ chatQueue: s.chatQueue.filter((j) => j.key !== key) }));
    patchChat(set, key, (c) => ({ turns: c.turns.filter((tn) => !gone.has(tn.id)) }));
    return mine[0].message;
  },

  promoteChat: (key) => {
    set((s) => {
      const mine = s.chatQueue.filter((j) => j.key === key);
      if (mine.length === 0) return {};
      return { chatQueue: [...mine, ...s.chatQueue.filter((j) => j.key !== key)] };
    });
    // Only the order changed — but a slot may be free and this one skipped
    // for being behind a busy owner's job.
    pump(set, get);
  },

  confirmProjectSwitch: (target) => {
    const s = get();
    const busy = s.chatOrder.some((k) => ownerBusy(k, s.runningChats, s.compactingChats, s.chatQueue))
      || s.chatOrder.some((k) => chatStateOf(s, k) === "waiting");
    // Idle everywhere: nothing the author could not know about, so no question
    // — today's single-conversation behaviour.
    if (!busy) return Promise.resolve(true);
    // A second ask while one is open answers the first with "stay": two
    // dialogs for one decision would be worse than a refused switch.
    get().projectSwitchGuard?.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({
        projectSwitchGuard: {
          target,
          resolve: (leave) => {
            set({ projectSwitchGuard: null });
            resolve(leave);
          },
        },
      });
    });
  },

  compactChatNow: async (key) => {
    const k = key ?? get().activeChatKey;
    const s0 = get();
    if (ownerBusy(k, s0.runningChats, s0.compactingChats, s0.chatQueue)) return;
    const chat = s0.chats[k];
    if (!chat) return;
    const history = chat.history;
    const meta = chat.meta;
    if (!history || !meta) return;

    const { useAppStore } = await import("./appStore");
    const { models, providers, activeModelId } = useAiStore.getState();
    const resolved = resolveConn(models, providers, activeModelId);
    if (!resolved.ok) { patchChat(set, k, { error: resolved.error }); return; }
    const { model, provider } = resolved;

    // The same ceiling the turn measures against — computed the same way, so a
    // manual fold and the automatic one can never disagree about the budget.
    const effectiveSubs = withSessionOverrides(
      useAiStore.getState().subAgents, chat.disabledSubAgents,
    );
    const messageCeiling = messageCeilingFor(
      model.contextSize,
      useAppStore.getState().contextUtilization,
      chatAgentPreset(),
      effectiveSubs,
      models,
      // Same as the turn's: this is the chat, so a writer run carries the
      // handoff schema on every round and the ceiling must know it.
      // providers: whether the search subagent is live depends on what its
      // model's platform sends (serverToolsSent) — the turn asks the same.
      { handoff: true, packs: true, providers: useAiStore.getState().providers },
    );

    // Same repair a turn does before touching an inherited history: a turn
    // that was stopped mid-tool-call leaves a pairing the fold must not build on.
    repairToolCallPairing(history);
    // 状态记忆 on: the button rewrites the execution state now, keeping the
    // mode's own one turn — the same fold the next question would run, earlier.
    const stateMode = meta.stateMode && isSkillStateEnabled();
    // Foldability check up front, so a null from compactChatHistory below can
    // only mean the summarize request failed — the author pressed a button and
    // deserves an error over silence.
    if (!planFold(history, meta, messageCeiling, {
      force: true, keepTurns: stateMode ? STATE_KEEP_TURNS : undefined,
    })) return;

    // Reserve the conversation before the first await: send and pump both read
    // this list, so no generation can enter the async setup window beside us.
    const controller = new AbortController();
    compactAborts[k] = controller;
    set((s) => ({ compactingChats: [...s.compactingChats, k] }));
    patchChat(set, k, { error: null });
    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      const compacted = stateMode
        ? await updateSkillState({
            history,
            meta,
            ceilingTokens: messageCeiling,
            update: (input) =>
              requestStateUpdate(
                connOptions({ provider, model, apiKey }),
                input,
                controller.signal,
              ),
          })
        : await compactChatHistory({
            history,
            meta,
            ceilingTokens: messageCeiling,
            force: true,
            summarize: (input) =>
              summarizeForCompaction(
                connOptions({ provider, model, apiKey }),
                input,
                controller.signal,
              ),
          });
      if (!compacted) {
        patchChat(set, k, {
          error: i18n.t(stateMode ? "ai.chat.stateUpdateFailed" : "ai.chat.compactFailed"),
        });
        return;
      }
      patchChat(set, k, (c) => {
        // The event lands on the newest assistant turn's log — per the context
        // bar's own rule (contextBreakdown §8), where a context-compacted row
        // sits only records *when* the fold happened, and "right after that
        // turn" is exactly when this one did.
        const lastAssistant = [...c.turns].reverse().find((tn) => tn.role === "assistant");
        return {
          history: compacted.history,
          contextVersion: c.contextVersion + 1,
          turns: lastAssistant
            ? c.turns.map((tn) =>
                tn === lastAssistant
                  ? { ...tn, log: appendAgentEventTo(tn.log, compacted.event) }
                  : tn,
              )
            : c.turns,
        };
      });
      // The history just changed shape — the crash that loses a session never
      // announces itself first (see the run's finally).
      void get().persistChat(k);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patchChat(set, k, { error: String(e) });
      }
    } finally {
      if (compactAborts[k] === controller) delete compactAborts[k];
      set((s) => ({ compactingChats: s.compactingChats.filter((x) => x !== k) }));
      // A job that queued while the fold held this conversation may run now.
      pump(set, get);
    }
  },

  undoTurnWrites: async (key, turnId, toolCallIds) => {
    const turn = get().chats[key]?.turns.find((tn) => tn.id === turnId);
    const { useProjectStore } = await import("./projectStore");
    const projectPath = useProjectStore.getState().projectPath;
    if (!turn || !projectPath) return;
    // A document open in the editor may hold typing that is not on disk yet.
    // Saved first, so "is the file still what the write left" sees it and
    // refuses — rather than restoring underneath the buffer, whose next
    // autosave would put the undone text straight back.
    const editor = useEditorStore.getState();
    if (editor.isDirty && editor.filePath) await flushEditor(editor);
    const events = await undoWrites(projectPath, turn.log, toolCallIds);
    if (events.length === 0) return;
    patchChat(set, key, (c) => ({
      turns: c.turns.map((tn) =>
        tn.id === turnId ? { ...tn, log: events.reduce((log, e) => appendAgentEventTo(log, e), tn.log) } : tn),
    }));
    void get().persistChat(key);

    const undone = new Set(events.filter((e) => e.outcome === "undone").map((e) => e.toolCallId));
    if (undone.size === 0) return;
    const paths = turnWrites(turn.log).filter((w) => undone.has(w.toolCallId)).map((w) => w.change.path);
    // What came back into the knowledge base has to be in the index before the
    // next turn resolves a name against it.
    if (paths.some((p) => p.startsWith(".ai-writer/lore/"))) {
      await useLoreStore.getState().scanProject(projectPath);
    }
    // A document: the tree shows what was restored or removed, and the open
    // buffer becomes the file as it now stands, not the text just undone.
    const documents = paths.filter((p) => !p.startsWith(".ai-writer/"));
    if (documents.length === 0) return;
    await useProjectStore.getState().refreshFileTree();
    const open = useEditorStore.getState().filePath;
    if (!open || !documents.some((p) => isSamePath(joinPath(projectPath, p), open))) return;
    if (await fileExists(open)) {
      await useEditorStore.getState().loadFile(open);
    } else {
      // Undoing a create removed the open file. Same teardown as deleteEntry,
      // or a pending autosave would recreate it.
      const { saveTimer } = useEditorStore.getState();
      if (saveTimer) clearTimeout(saveTimer);
      useEditorStore.setState({ content: "", filePath: null, headings: [], isDirty: false, saveTimer: null });
      useProjectStore.getState().setActiveFilePath(null);
    }
  },

  persistChat: async (key) => {
    const k = key ?? get().activeChatKey;
    const chat = get().chats[k];
    if (!chat || !chat.history || !chat.meta || chat.turns.length === 0) return;
    const { turns, history, meta, usage, title } = chat;
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;
    try {
      const data = serializeChatSession({
        turns, history, meta, usage,
        taskId: chat.taskWorkspace?.taskId ?? null,
      });
      const id = await upsertChatSession(
        projectPath, chat.sessionId, data, sessionPreview(turns),
        // The title rides only into a *new* row (a rename on an existing one
        // goes through setChatSessionTitle); every open tab is exempt from
        // the prune, whatever its age.
        { title, keep: openSessionIds(get()) },
      );
      // Another persist may have raced ahead (approve() lands mid-run) — only
      // adopt the id if nothing changed the session underneath.
      if (get().chats[k]?.history === history) patchChat(set, k, { sessionId: id });
      await refreshSessionList(set, get);
    } catch (e) {
      // Persistence is best-effort: the chat itself must keep working.
      console.warn("chat session persist failed:", e);
    }
  },

  switchChatSession: async (id) => {
    const s0 = get();
    // Already open: it has a tab, and the tab is where the author goes.
    const openKey = s0.chatOrder.find((k) => s0.chats[k]?.sessionId === id);
    if (openKey) { get().activateChat(openKey); return; }
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;
    await get().persistChat(s0.activeChatKey);
    try {
      const raw = await loadChatSession(projectPath, id);
      const snap = raw ? deserializeChatSession(raw) : null;
      if (!snap) {
        // Unreadable row — refresh the list so it stops being offered.
        await refreshSessionList(set, get);
        return;
      }
      turnCounter = Math.max(turnCounter, maxTurnId(snap.turns));
      const row = get().chatSessions.find((r) => r.id === id);
      const restored = chatFromSnapshot(
        snap, id, row?.title ?? "", await workspaceForSnapshot(projectPath, snap.taskId),
      );
      // Into the active tab if it is empty (a blank tab is nobody's), else
      // into a new one — the conversation the author was in stays open.
      const s1 = get();
      const active = s1.chats[s1.activeChatKey];
      const reuse = active && active.turns.length === 0
        && !ownerBusy(s1.activeChatKey, s1.runningChats, s1.compactingChats, s1.chatQueue);
      const key = reuse ? s1.activeChatKey : newChatKey();
      endGrantFor(set, get, key);
      set((st) => ({
        chats: { ...st.chats, [key]: { ...restored, key } },
        chatOrder: reuse ? st.chatOrder : [...st.chatOrder, key],
        activeChatKey: key,
      }));
    } catch (e) {
      console.warn("chat session load failed:", e);
    }
  },

  toggleChatSessionPin: async (id) => {
    const row = get().chatSessions.find((s) => s.id === id);
    if (!row) return;
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;
    try {
      await setChatSessionPinned(projectPath, id, !row.pinned);
      // Re-read rather than patch the flag in place: unpinning can put the row
      // back over the cap, and the list is where that stops being offered.
      await refreshSessionList(set, get);
    } catch (e) {
      // Same contract as persistChat: the conversation must keep working.
      console.warn("chat session pin failed:", e);
    }
  },

  /**
   * 回到这里重说 (docs/feature/agent/chat-memory-plan.md §12).
   *
   * A cut, not a re-seed — the wire history is the conversation, so it is
   * truncated at the target's question and the meta is brought back in step
   * (lib/agent/rewind decides where and whether). Two things deliberately
   * survive: the session's disk workspace, because a note the assistant filed
   * is a file like any approved edit — rewinding the conversation does not
   * un-write the manuscript either, and the confirm text says so — and the
   * usage totals, because the tokens were spent.
   *
   * Rewinding to the first question empties the session: the history goes back
   * to null so the next send seeds afresh against the new question, and the DB
   * row keeps its id so that send overwrites it in place rather than leaving
   * the un-rewound conversation behind as a second entry. Until then the row
   * still holds the old turns (persistChat has nothing to write) — which is
   * also what a restart would restore, and an accidental rewind is then
   * recoverable rather than gone.
   */
  rewindChat: async (turnId, key) => {
    const k = key ?? get().activeChatKey;
    const s0 = get();
    if (ownerBusy(k, s0.runningChats, s0.compactingChats, s0.chatQueue)) return null;
    const chat = s0.chats[k];
    if (!chat) return null;
    const { turns, history, meta } = chat;
    const target = turns.find((tn) => tn.id === turnId);
    const plan = planRewind(turns, history, meta, turnId);
    if (!plan || !target) return null;
    if (plan.kind === "reseed") {
      patchChat(set, k, (c) => ({
        turns: [],
        history: null,
        meta: null,
        error: null,
        contextVersion: c.contextVersion + 1,
      }));
    } else if (history && meta) {
      const cut = applyRewindCut(history, meta, plan.cutAt);
      patchChat(set, k, (c) => ({
        turns: plan.turns,
        history: cut,
        error: null,
        contextVersion: c.contextVersion + 1,
      }));
      // The history just changed shape — same rule as a fold: save now, the
      // crash that loses a session never announces itself first.
      void get().persistChat(k);
    }
    return target.text;
  },

  resumeTask: async (taskId: string) => {
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;

    const { userContent, title, taskWorkspace } = await buildResumeSeed(projectPath, taskId);

    await markTaskResumed(projectPath, taskId);

    // Into a conversation of its own (a blank tab if there is one): the button
    // says 在新会话中继续, and a running conversation elsewhere keeps running.
    const key = get().newChat();
    patchChat(set, key, { taskWorkspace });

    await get().sendChatTo(key, userContent, undefined, [], {
      displayText: i18n.t("ai.taskWorkspace.resumeTurn", { title }),
    });

    // The status was set optimistically so a run that does start finds the task
    // live. If it never got off the ground — no model configured, no project —
    // say so on disk rather than leaving a task that claims to be running.
    if (get().chats[key]?.error) await markTaskPaused(projectPath, taskId);
  },

  abortTask: async (taskId: string) => {
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;

    // Stop the work before recording the decision — otherwise a still-running
    // loop's next task_progress call writes over the aborted status.
    const s0 = get();
    const key = s0.chatOrder.find((k) => s0.chats[k]?.taskWorkspace?.taskId === taskId);
    if (key) {
      if (s0.runningChats.includes(key)) get().stopChat(key);
      // Detach: the conversation continues, but a later task_plan starts a
      // fresh workspace instead of quietly reviving the one just called off
      // (task_plan resets status to in_progress unconditionally).
      patchChat(set, key, { taskWorkspace: null });
      void get().persistChat(key);
    }

    await markTaskAborted(projectPath, taskId);
  },

  resetChatForProject: async (projectPath) => {
    // No persist here: the outgoing sessions were saved at their last turn, and
    // by the time projectStore calls this the active project has already
    // changed — saving now would write them into the wrong DB. Every run stops:
    // it was reading and writing the project that just closed.
    // Queue first: stopChat pumps, and a queued job of another conversation
    // would otherwise start against the project that just closed.
    set({ chatQueue: [] });
    for (const k of [...get().runningChats, ...Object.keys(compactAborts)]) get().stopChat(k);
    const key = newChatKey();
    set({
      chats: { [key]: freshChat(key) },
      chatOrder: [key],
      activeChatKey: key,
      runningChats: [],
      compactingChats: [],
      chatQueue: [],
      chatAborts: {},
      lastClosedLabel: null,
      chatSessions: [],
      autoApprove: isChatAutoApproveKey(get().autoApprove?.key) ? null : get().autoApprove,
    });
    if (!projectPath) return;
    try {
      const sessions = await listChatSessions(projectPath);
      set({ chatSessions: sessions });
      // "Where I left off": the newest row opens in the one tab.
      if (sessions.length > 0) {
        const raw = await loadChatSession(projectPath, sessions[0].id);
        const snap = raw ? deserializeChatSession(raw) : null;
        if (snap) {
          turnCounter = Math.max(turnCounter, maxTurnId(snap.turns));
          const restored = chatFromSnapshot(
            snap, sessions[0].id, sessions[0].title,
            await workspaceForSnapshot(projectPath, snap.taskId),
          );
          set((st) => ({ chats: { ...st.chats, [key]: { ...restored, key } } }));
        }
      }
    } catch (e) {
      console.warn("chat session restore failed:", e);
    }
  },
}));

/**
 * Narrow selector over the active conversation — the seam that lets AgentChat
 * and the composer chips keep their per-field subscriptions after the store
 * went multi-session (plan §4.1).
 */
export function useActiveChat<T>(selector: (c: LiveChat) => T): T {
  return useAgentStore((s) => selector(activeChat(s)));
}

/** The slices above, shallow-compared so the subscription re-renders only when one of them moved. */
export function useChatStateInputs(): ChatStateInputs {
  return useAgentStore(useShallow(pickChatStateInputs));
}


// Moved out in P5 (docs/feature/code-structure-plan.md); re-exported so importers keep one address.
export { buildResumeSeed, chatSurface, emptyChat } from "./agent/chatJob";
export { activeChat, chatQueuePosition, chatStateOf, chatWaitingSince, isChatBusy, mostUrgentChatState, pickChatStateInputs } from "./agent/selectors";
export type { ChatStateInputs } from "./agent/selectors";
export type { ChatTurn, LiveChat, PendingApproval, PendingPlan, PendingQuestion, PendingRoundLimit, PendingTruncation } from "./agent/types";
