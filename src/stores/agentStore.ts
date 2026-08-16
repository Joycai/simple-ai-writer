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
import {
  createSessionMeta, excludeDirsFor, noteTurnStart, recordInjections,
  type ChatSessionMeta,
} from "../lib/agent/compact";
import { compactChatHistory, summarizeForCompaction } from "../lib/agent/compactRun";
import {
  deserializeChatSession, maxTurnId, serializeChatSession, sessionPreview,
} from "../lib/agent/chatSession";
import {
  listChatSessions, loadChatSession, upsertChatSession, type ChatSessionRow,
} from "../lib/agent/sessionDb";
import { appendAgentEventTo, type AgentEvent } from "../lib/agent/events";
import {
  CHAT_AUTO_APPROVE_KEY, grants, isAutoApprovable,
  type AutoApproveKind, type AutoApproveState,
} from "../lib/agent/autoApprove";
import { createPlanGate, type LorePlan, type PlanDecision } from "../lib/agent/plan";
import {
  createTaskWorkspace,
  existingWorkspace,
  listTaskNotes,
  loadTaskDoc,
  markTaskAborted,
  markTaskPaused,
  markTaskResumed,
  recordSourceRef,
  type TaskWorkspaceHandle,
} from "../lib/agent/taskWorkspace";
import { AGENT_ASSIST_PRESET } from "../lib/agent/presets";
import { routeTools } from "../lib/agent/routing";
import {
  resolveSubAgentConn, visionSubAgentModel, withSessionOverrides, type SubAgentKind,
} from "../lib/agent/subagent";
import { repairToolCallPairing, runAgent, type RoundLimitDecision } from "../lib/agent/runtime";
import { persistUsage } from "../lib/ai/usage";
import {
  inputCeilingFor, measureCharsPerToken, RECENT_WINDOW_MIN_CHARS,
} from "../lib/context/budget";
import {
  hashText, loadMemory, MEMORY_BUDGET_CHARS, projectRelativePath,
} from "../lib/context/memory";
import { parentDir } from "../lib/context/outline";
import {
  assembleContext, assembleTurnInjection, bundleToChatMessages, profileSystemPrompt,
} from "../lib/context/rag";
import { docModel, promptParams } from "../lib/profile/active";
import type { ApprovalDecision, EditProposal, Proposal, RewriteProposal } from "../lib/agent/registry";
import { type AttachedItem } from "../lib/lore/aiTask";
import type { StreamMessage } from "../lib/ai/types";
import { fileExists, readFile, writeFile } from "../lib/fs/fileio";
import { loadApiKey } from "../lib/keyStore";
import { recordRunOutcome } from "../lib/ai/modelHealth";
import { costFor } from "../lib/ai/configDb";
import { connOptions, resolveConn } from "../lib/ai/conn";

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
  /**
   * Which auto-approve scope this run belongs to — `"chat"` for the whole
   * conversation, the run's own controller for a panel task. Absent means the
   * surface does not offer 本次都批准 at all, and every card is asked.
   */
  autoApproveKey?: unknown;
}

export interface PendingApproval extends ApprovalBinding {
  proposal: Proposal;
  resolve: (decision: ApprovalDecision) => void;
  runId: RunId;
}

export interface PendingPlan {
  plan: LorePlan;
  resolve: (decision: PlanDecision) => void;
  runId: RunId;
  /** Same meaning as on ApprovalBinding — plans carry their own grant flag. */
  autoApproveKey?: unknown;
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
  /**
   * Whether 存盘暂停 is on offer for this run.
   *
   * A property of the RUN, not of the store. This card is shared by chat and
   * the task panel, so reading a chat field to decide would put the button on
   * a panel run — whose caller has nowhere to save to and no handler for the
   * answer. Each caller says for itself, at the moment the cap is hit, whether
   * it has a workspace with something in it.
   */
  canPause: boolean;
  resolve: (decision: RoundLimitDecision) => void;
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

/** Extras for a programmatically composed turn (today: resuming a task). */
export interface SendChatOptions {
  /**
   * What the transcript shows in place of the sent text. The full text still
   * goes to the model — this only changes what the author reads.
   */
  displayText?: string;
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
  /**
   * The one surface currently auto-approving, if any (lib/agent/autoApprove).
   * Null is the normal state: every card is asked.
   */
  autoApprove: AutoApproveState | null;

  // ── Chat session ──
  turns: ChatTurn[];
  chatRunning: boolean;
  chatError: string | null;
  /** Session-cumulative usage across all turns. */
  chatUsage: ChatUsage | null;
  chatAbort: AbortController | null;
  /** Wire-protocol history the runtime appends to; null until the first turn. */
  chatHistory: StreamMessage[] | null;
  /**
   * Turn boundaries + seed/summary identities for chatHistory — what the flat
   * array can't say about itself. Mutated in place alongside the history it
   * describes (lib/agent/compact); null exactly when chatHistory is.
   */
  chatMeta: ChatSessionMeta | null;
  /**
   * Bumped whenever the wire history's *composition* changes, so the composer's
   * context bar can recompute. `chatHistory` can't do that job: the runtime and
   * the injection pass push into it in place, leaving the array reference — and
   * therefore any selector on it — untouched. Deliberately not bumped for
   * streamed text, which arrives per chunk and never touches the history.
   */
  chatContextVersion: number;
  /**
   * Disk workspace the scratchpad tools write into, for the *whole* session.
   *
   * Per-session rather than per-turn: a note the assistant filed on turn 3 has
   * to still be readable on turn 9 — that is the entire point of putting it on
   * disk. Lazy, like the handle itself: a conversation that never plans or
   * takes a note leaves no directory behind.
   *
   * The taskId rides in the session blob, so a conversation reopened from the
   * history menu reconnects to its own notes (`workspaceForSnapshot`); restores
   * must set this field explicitly — leaving it untouched hands the previous
   * session's workspace to the restored one.
   */
  chatTaskWorkspace: TaskWorkspaceHandle | null;
  /** DB row this session saves into; null until the first persist. */
  chatSessionId: number | null;
  /** Recent sessions (newest first, ≤ MAX_CHAT_SESSIONS) for the history menu. */
  chatSessions: ChatSessionRow[];
  /** Subagents temporarily disabled for the live session (session-level override). */
  disabledSubAgents: SubAgentKind[];
  toggleSubAgent: (kind: SubAgentKind) => void;

  /**
   * Author pressed 本次都批准 on a card: everything of that kind from the same
   * surface applies without a card until the grant is cleared. Same key merges,
   * a different key replaces — only one surface may hold a grant.
   */
  enableAutoApprove: (key: unknown, what: AutoApproveKind) => void;
  /** Author dismissed the indicator chip — back to asking every time. */
  clearAutoApprove: () => void;

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
  requestRoundExtension: (
    roundsUsed: number, extension: number, runId: RunId, canPause: boolean,
  ) => Promise<RoundLimitDecision>;
  /** Resolve a blocked run's round-cap question: extend, finish, or pause. */
  resolveRoundLimit: (runId: RunId, decision: RoundLimitDecision) => void;

  /** Called by propose_lore_plan (via ToolContext.requestPlanApproval). */
  requestPlanApproval: (plan: LorePlan, runId: RunId, autoApproveKey?: unknown) => Promise<PlanDecision>;
  /** User approved the plan — the gate records its steps and the loop resumes. */
  approvePlan: (id: string) => void;
  /** User rejected the plan: their reason goes back to the model verbatim. */
  rejectPlan: (id: string, reason?: string) => void;

  /** @param quote Manuscript passage attached to the message, if the author
   *               pinned their selection to it (shown above the turn, and sent
   *               to the model as a 【选中内容】 block). */
  sendChat: (
    text: string, quote?: string, refs?: AttachedItem[], opts?: SendChatOptions,
  ) => Promise<void>;
  /** Resume a paused task with a fresh, clean context using task.md and notes. */
  resumeTask: (taskId: string) => Promise<void>;
  /** Author called a task off: stop it if live, then mark it aborted on disk. */
  abortTask: (taskId: string) => Promise<void>;
  stopChat: () => void;
  resetChat: () => void;

  /** Save the live session to the project DB (best-effort, never throws). */
  persistChat: () => Promise<void>;
  /** Load a session from the history menu, persisting the current one first. */
  switchChatSession: (id: number) => Promise<void>;
  /**
   * Project open/close hook (projectStore calls this): drop the previous
   * project's session from view, then restore the new project's newest one.
   */
  resetChatForProject: (projectPath: string | null) => Promise<void>;
}

let turnCounter = 0;
let roundLimitCounter = 0;

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
 * Apply an approved whole-file rewrite. Returns the pre-write backup path.
 *
 * Unlike applyEdit there is nothing to re-locate — the proposal is the entire
 * new file — so the author's concurrent typing cannot be detected, only
 * overwritten. The backup is therefore load-bearing rather than a courtesy,
 * and it is taken before anything is written.
 */
async function applyRewrite(proposal: RewriteProposal): Promise<string | null> {
  const { useProjectStore } = await import("./projectStore");
  const { projectPath, activeFilePath } = useProjectStore.getState();
  const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

  if (activeFilePath === proposal.path) {
    // Same reason as applyEdit: go through the editor so the change is visible
    // and autosaved rather than being clobbered by the open buffer on next save.
    const { useEditorStore } = await import("./editorStore");
    useEditorStore.getState().setContent(proposal.content);
  } else {
    await writeFile(proposal.path, proposal.content);
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

    case "rewrite":
      return { report: await applyRewrite(proposal) };

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
    item.resolve({ approved: true, backupPath: report, auto: auto || undefined });
  } catch (e) {
    // Approval failed to apply — report as a rejection so the model knows
    // the manuscript is untouched.
    item.resolve({ approved: false, reason: `apply failed: ${String(e)}` });
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pending: [],
  pendingPlans: [],
  pendingRoundLimits: [],
  autoApprove: null,

  turns: [],
  chatRunning: false,
  chatError: null,
  chatUsage: null,
  chatAbort: null,
  chatHistory: null,
  chatMeta: null,
  chatContextVersion: 0,
  chatTaskWorkspace: null,
  chatSessionId: null,
  chatSessions: [],
  disabledSubAgents: [],
  toggleSubAgent: (kind) =>
    set((s) => ({
      disabledSubAgents: s.disabledSubAgents.includes(kind)
        ? s.disabledSubAgents.filter((k) => k !== kind)
        : [...s.disabledSubAgents, kind],
    })),

  enableAutoApprove: (key, what) =>
    set((s) => {
      const held = s.autoApprove?.key === key ? s.autoApprove : null;
      return {
        autoApprove: {
          key,
          proposals: what === "proposals" || !!held?.proposals,
          plans: what === "plans" || !!held?.plans,
        },
      };
    }),

  clearAutoApprove: () => set({ autoApprove: null }),

  requestApproval: (proposal, runId, binding) =>
    new Promise<ApprovalDecision>((resolve) => {
      const item: PendingApproval = { proposal, resolve, runId, ...binding };
      // Covered by a standing grant: apply now and never queue. Queuing first
      // and approving synchronously would flash the card for a frame.
      if (
        grants(get().autoApprove, item.autoApproveKey, "proposals") &&
        isAutoApprovable(proposal.kind)
      ) {
        void settleApproval(item, set, true);
        return;
      }
      set((s) => ({ pending: [...s.pending, item] }));
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

  requestRoundExtension: (roundsUsed, extension, runId, canPause) =>
    new Promise<RoundLimitDecision>((resolve) => {
      const id = `round-limit-${++roundLimitCounter}`;
      set((s) => ({
        pendingRoundLimits: [
          ...s.pendingRoundLimits,
          { id, roundsUsed, extension, canPause, resolve, runId },
        ],
      }));
    }),
  resolveRoundLimit: (runId, decision) => {
    const item = get().pendingRoundLimits.find((p) => p.runId === runId);
    if (!item) return;
    set((s) => ({ pendingRoundLimits: s.pendingRoundLimits.filter((p) => p.runId !== runId) }));
    item.resolve(decision);
  },

  rejectAll: (reason, runId) => {
    // A panel task's grant is scoped to its run, and this is the one place
    // every finish/abort path already goes through. Chat's grant is keyed
    // "chat", never a controller, so it is untouched here — resetChat and
    // switchChatSession are what end it.
    if (get().autoApprove?.key === runId) set({ autoApprove: null });

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
    // Finish = wrap up; the aborted signal is re-checked right after.
    for (const item of drainR) item.resolve({ action: "finish" });
  },

  requestPlanApproval: (plan, runId, autoApproveKey) =>
    new Promise<PlanDecision>((resolve) => {
      // A standing grant skips the card, not the gate: the model still had to
      // declare its steps, and every lore write is still checked against them
      // (plan.ts → checkPlan). What the author gave up is reading each pass.
      if (grants(get().autoApprove, autoApproveKey, "plans")) {
        resolve({ approved: true });
        return;
      }
      set((s) => ({ pendingPlans: [...s.pendingPlans, { plan, resolve, runId, autoApproveKey }] }));
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

  sendChat: async (text, quote, refs = [], opts) => {
    const message = text.trim();
    if (!message || get().chatRunning) return;
    const quoted = quote?.trim();

    // Stores are reached lazily throughout this module: aiTaskStore imports
    // *this* one at the top level, so agentStore must stay free of static store
    // imports or the cycle closes. See docs/architecture.md → Circular deps.
    const { useAiStore } = await import("./aiStore");
    const { useProjectStore } = await import("./projectStore");
    const { useLoreStore } = await import("./loreStore");
    const { useAppStore } = await import("./appStore");
    const { getWritingFocus } = await import("./editorStore");

    const { models, providers, activeModelId } = useAiStore.getState();
    const resolved = resolveConn(models, providers, activeModelId);
    const { projectPath } = useProjectStore.getState();
    // One atomic read of the focused document, held for the whole turn — see
    // editorStore.WritingFocus for why this must not be recomposed per use.
    const focus = getWritingFocus();
    const activeFilePath = focus.filePath;
    if (!projectPath) { set({ chatError: i18n.t("ai.errors.noProject") }); return; }
    if (!resolved.ok) { set({ chatError: resolved.error }); return; }
    const { model, provider } = resolved;

    // What the model receives: the quoted passage and any @-referenced material
    // first, so "把这一段重写得更克制一些" has an unambiguous referent even
    // mid-conversation. Composition lives in lib/agent/chatRefs. Built after
    // the model is resolved, because whether an attached picture can travel at
    // all is a property of the model.
    // Resolved once for the whole turn: the composer, the router and the
    // delegate resolver all have to agree on which subagents are live.
    const effectiveSubs = withSessionOverrides(
      useAiStore.getState().subAgents, get().disabledSubAgents,
    );

    const { buildChatMessage } = await import("../lib/agent/chatRefs");
    const { text: wireMessage, content: wireContent, imagePaths } = await buildChatMessage(
      message, quoted, refs,
      {
        // Unchanged and deliberately narrow: base64 goes only to a model that
        // can read it. What widened is the *fallback* — see visionDelegate.
        allowImages: model.type === "multimodal",
        visionDelegate: visionSubAgentModel(
          useAiStore.getState().models, effectiveSubs,
        ) !== null,
      },
    );

    const controller = new AbortController();
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

    /** Tell the context bar the history changed under it (see chatContextVersion). */
    const bumpContext = () => set((s) => ({ chatContextVersion: s.chatContextVersion + 1 }));

    /**
     * This session's disk workspace, created on first use and reused by every
     * later turn. Built here rather than in the state initialiser because it
     * needs the project path and the model, neither of which exists until a
     * turn actually runs.
     */
    const taskWorkspace = (): TaskWorkspaceHandle => {
      const existing = get().chatTaskWorkspace;
      if (existing) return existing;
      const handle = createTaskWorkspace(projectPath, model.id);
      set({ chatTaskWorkspace: handle });
      return handle;
    };

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";

      // ── History: seed on first turn, append afterwards ──
      const { contextUtilization } = useAppStore.getState();
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
        // Three messages, not two: the seeded context and the question are
        // separate so the compaction pass can later drop the former without
        // the latter (docs/chat-memory-plan.md §3). The meta records which
        // message is which — by identity, because indices don't survive
        // repairToolCallPairing's splices.
        const seed = bundleToChatMessages(bundle, wireContent);
        history = seed.messages;
        const meta = createSessionMeta();
        meta.seedContext = seed.seedContext;
        meta.lastDocPath = activeFilePath ?? null;
        noteTurnStart(meta, seed.question);
        // The seeded lore goes in the injection ledger, carried by the seed
        // block — otherwise turn 2's retrieval would re-inject everything the
        // model was just given.
        if (seed.seedContext) {
          const byDir = new Map(
            Object.values(useLoreStore.getState().index).flat().map((e) => [e.dirPath, e]),
          );
          recordInjections(
            meta,
            bundle.loreReport.entities.flatMap((r) => byDir.get(r.dirPath) ?? []),
            seed.seedContext,
          );
        }
        set({ chatHistory: history, chatMeta: meta });
        bumpContext();

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

        // ── Compaction (docs/chat-memory-plan.md §4) ──
        // Between turns, before this turn's question goes in: if the history
        // has outgrown the trigger, fold the oldest turns into the rolling
        // summary. Best-effort — a failed summarize returns null and the turn
        // proceeds on the uncompacted history (trimHistory still backstops
        // mid-turn); only an abort propagates. The event lands in this turn's
        // log so the author sees what was folded and can read the summary.
        const meta = get().chatMeta;
        if (meta) {
          const compacted = await compactChatHistory({
            history,
            meta,
            ceilingTokens: inputCeilingFor(model.contextSize, contextUtilization),
            summarize: (input) =>
              summarizeForCompaction(
                connOptions({ provider, model, apiKey }),
                input,
                controller.signal,
              ),
          });
          if (compacted) {
            history = compacted.history;
            set({ chatHistory: history });
            bumpContext();
            patchAssistant((tn) => ({ ...tn, log: appendAgentEventTo(tn.log, compacted.event) }));
          }
        }

        // ── Per-turn injection (docs/chat-memory-plan.md §5) ──
        // The seed's retrieval, re-run against *this* question, minus what the
        // ledger says is already in the conversation. A document switch also
        // re-injects the window + recap — the seeded ones belong to the old
        // document. Nothing net-new appends nothing: the history stays
        // append-only, so the prompt-cache prefix survives.
        if (meta) {
          const docSwitched = !!activeFilePath && activeFilePath !== meta.lastDocPath;
          const memory = docSwitched && docModel().memory && activeFilePath
            ? await loadMemory(projectPath, activeFilePath)
            : null;
          const loreIdx = useLoreStore.getState().index;
          const { loreBudgetTokens } = useAppStore.getState();
          const inj = await assembleTurnInjection({
            loreIndex: loreIdx,
            // Same match targets as the seed: the question (with its quote and
            // @refs inlined) plus the document's tail neighborhood.
            matchTarget: wireMessage + focus.text.slice(-500),
            excludeDirs: excludeDirsFor(meta, loreIdx),
            loreBudgetChars: loreBudgetTokens * measureCharsPerToken(focus.text),
            doc: docSwitched && activeFilePath
              ? {
                  filePath: activeFilePath,
                  documentText: focus.text,
                  memory,
                  contextChars: RECENT_WINDOW_MIN_CHARS,
                  memoryBudgetChars: MEMORY_BUDGET_CHARS,
                }
              : null,
          });
          if (inj.text) {
            const injMsg: StreamMessage = { role: "user", content: inj.text };
            history.push(injMsg);
            recordInjections(meta, inj.matchedEntities, injMsg);
            if (docSwitched) meta.lastDocPath = activeFilePath;
            patchAssistant((tn) => ({
              ...tn,
              log: appendAgentEventTo(tn.log, {
                kind: "context-seeded",
                documentName: docSwitched && activeFilePath
                  ? (activeFilePath.split(/[\\/]/).pop() ?? "").replace(/\.md$/i, "")
                  : null,
                recentChars: inj.docChars,
                memoryChars: inj.memoryChars,
                loreEntities: inj.loreReport.entities.length,
                loreChars: inj.loreReport.usedChars,
                at: Date.now(),
              }),
            }));
          }
        }

        const questionMsg: StreamMessage = { role: "user", content: wireContent };
        if (meta) noteTurnStart(meta, questionMsg);
        history.push(questionMsg);
        bumpContext();
      }

      const tw = taskWorkspace();
      const routed = routeTools(
        AGENT_ASSIST_PRESET, effectiveSubs, tw, useAiStore.getState().models,
      );
      const effectivePreset = {
        ...AGENT_ASSIST_PRESET,
        tools: routed.tools,
        serverTools: routed.serverTools,
      };

      const { inputTokens, outputTokens, cachedTokens, outcome } = await runAgent({
        ...connOptions({ provider, model, apiKey }),
        // Never undefined: without a ceiling the tool loop's history trimming
        // is a no-op, and a chat that reads pictures accumulates base64 in a
        // history that persists across turns until the provider rejects it.
        inputCeilingTokens: inputCeilingFor(model.contextSize, contextUtilization),
        preset: effectivePreset,
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
              // Not the controller: 本次对话都批准 has to outlive the turn it
              // was pressed in, which is the whole point of the button.
              autoApproveKey: CHAT_AUTO_APPROVE_KEY,
            }),
          requestPlanApproval: (p) =>
            get().requestPlanApproval(p, controller, CHAT_AUTO_APPROVE_KEY),
          // One gate per turn: a plan the author approved for *this* request
          // does not silently authorise the next one.
          lorePlan: createPlanGate(),
          // ...unlike the workspace, which is per SESSION — see chatTaskWorkspace.
          taskWorkspace: tw,
          resolveSubAgent: (k) => {
            const { models: allModels, providers: allProviders } = useAiStore.getState();
            return resolveSubAgentConn(k, allModels, allProviders, effectiveSubs, loadApiKey);
          },
        },
        signal: controller.signal,
        // At the round cap, block on the author's 继续/收尾/存盘暂停 card instead of
        // force-ending. Each 继续 grants the preset's own cap again.
        onRoundLimit: (roundsUsed) =>
          get().requestRoundExtension(
            roundsUsed, AGENT_ASSIST_PRESET.maxRounds, controller,
            // Evaluated here, at the cap — not at run start. A workspace the
            // model created three rounds ago counts; pausing with nothing on
            // disk would throw the turn away, since pause keeps only what was
            // written down.
            !!tw.taskId,
          ),
        // Every runtime event marks a point where the history just grew (a
        // round's messages, a tool reply) or shrank (trimHistory) — which is
        // exactly the cadence the context bar wants to redraw at.
        onEvent: (event) => {
          patchAssistant((tn) => ({ ...tn, log: appendAgentEventTo(tn.log, event) }));
          bumpContext();
        },
        // Assign, not append — the runtime hands over the whole output each
        // time so it can retract a tool round's narration.
        onOutputText: (text) => patchAssistant((tn) => ({ ...tn, text })),
      });

      if (outcome === "paused") {
        const pausedId = get().chatTaskWorkspace?.taskId;
        // Guaranteed non-null: `canPause` was false without it, so the button
        // was never offered. Checked anyway — a silent no-op here would mean
        // the author pressed 存盘 and nothing was saved.
        if (pausedId) {
          await markTaskPaused(projectPath, pausedId);
          // The document the work was based on, as it stands right now. This is
          // the only writer of sourceRefs: a resume compares against the state
          // the task was suspended at, which is exactly this moment.
          const rel = activeFilePath ? projectRelativePath(projectPath, activeFilePath) : null;
          if (rel && focus.text) {
            await recordSourceRef(
              projectPath, pausedId,
              rel,
              hashText(focus.text),
            );
          }
        }
      }

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
      // The run's last assistant message landed in the history after the final
      // event fired, so the bar would otherwise sit one message behind until
      // the next turn.
      bumpContext();
      recordRunOutcome(model.id, null);
      void persistUsage(projectPath, model.id, inputTokens, outputTokens, cost, "chat", cachedTokens);
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
      // Save after every turn, success or failure — the crash that loses a
      // session never announces itself first.
      void get().persistChat();
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
    // The old session stays in the history menu (it was persisted at its last
    // turn); clearing the id makes the next turn open a fresh row.
    set({
      turns: [], chatHistory: null, chatMeta: null, chatSessionId: null,
      chatError: null, chatUsage: null,
      // A new conversation is a new job: it must not inherit the previous
      // one's notes, or read_note would surface findings from another topic.
      chatTaskWorkspace: null,
      disabledSubAgents: [],
      // Same reasoning as the chips: the button said "this conversation", and
      // this is a different one.
      autoApprove: null,
    });
  },

  persistChat: async () => {
    const { turns, chatHistory, chatMeta, chatUsage, chatSessionId } = get();
    if (!chatHistory || !chatMeta || turns.length === 0) return;
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;
    try {
      const data = serializeChatSession({
        turns, history: chatHistory, meta: chatMeta, usage: chatUsage,
        taskId: get().chatTaskWorkspace?.taskId ?? null,
      });
      const id = await upsertChatSession(
        projectPath, chatSessionId, data, sessionPreview(turns),
      );
      // Another persist may have raced ahead (approve() lands mid-run) — only
      // adopt the id if nothing changed the session underneath.
      if (get().chatHistory === chatHistory) set({ chatSessionId: id });
      set({ chatSessions: await listChatSessions(projectPath) });
    } catch (e) {
      // Persistence is best-effort: the chat itself must keep working.
      console.warn("chat session persist failed:", e);
    }
  },

  switchChatSession: async (id) => {
    if (get().chatRunning || id === get().chatSessionId) return;
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;
    await get().persistChat();
    try {
      const raw = await loadChatSession(projectPath, id);
      const snap = raw ? deserializeChatSession(raw) : null;
      if (!snap) {
        // Unreadable row — refresh the list so it stops being offered.
        set({ chatSessions: await listChatSessions(projectPath) });
        return;
      }
      turnCounter = Math.max(turnCounter, maxTurnId(snap.turns));
      set({
        turns: snap.turns,
        chatHistory: snap.history,
        chatMeta: snap.meta,
        chatUsage: snap.usage,
        chatSessionId: id,
        chatError: null,
        // The restored conversation's own workspace — explicitly, because
        // leaving the field alone would carry the *previous* session's handle
        // across the switch and file new notes under another task.
        chatTaskWorkspace: await workspaceForSnapshot(projectPath, snap.taskId),
        // The chips say "this conversation", so they cannot survive into a
        // different one. Not stored in the session blob either: a temporary
        // switch is not worth a format change (see resetChat).
        disabledSubAgents: [],
        // Auto-approve says the same words, and standing authorisation to
        // rewrite prose is the last thing that should follow the author into
        // another manuscript. Deliberately not persisted: reopening a
        // conversation from the history menu re-asks.
        autoApprove: null,
      });
    } catch (e) {
      console.warn("chat session load failed:", e);
    }
  },

  resumeTask: async (taskId: string) => {
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;

    get().stopChat();

    const { userContent, title, taskWorkspace } = await buildResumeSeed(projectPath, taskId);

    await markTaskResumed(projectPath, taskId);

    set({
      turns: [],
      chatHistory: null,
      chatMeta: null,
      chatSessionId: null,
      chatError: null,
      chatUsage: null,
      chatTaskWorkspace: taskWorkspace,
    });

    await get().sendChat(userContent, undefined, [], {
      displayText: i18n.t("ai.taskWorkspace.resumeTurn", { title }),
    });

    // The status was set optimistically so a run that does start finds the task
    // live. If it never got off the ground — no model configured, no project —
    // say so on disk rather than leaving a task that claims to be running.
    if (get().chatError) await markTaskPaused(projectPath, taskId);
  },

  abortTask: async (taskId: string) => {
    const { useProjectStore } = await import("./projectStore");
    const { projectPath } = useProjectStore.getState();
    if (!projectPath) return;

    // Stop the work before recording the decision — otherwise a still-running
    // loop's next task_progress call writes over the aborted status.
    if (get().chatTaskWorkspace?.taskId === taskId) {
      if (get().chatRunning) get().stopChat();
      // Detach: the conversation continues, but a later task_plan starts a
      // fresh workspace instead of quietly reviving the one just called off
      // (task_plan resets status to in_progress unconditionally).
      set({ chatTaskWorkspace: null });
      void get().persistChat();
    }

    await markTaskAborted(projectPath, taskId);
  },

  resetChatForProject: async (projectPath) => {
    // No persist here: the outgoing session was saved at its last turn, and
    // by the time projectStore calls this the active project has already
    // changed — saving now would write it into the wrong DB.
    get().resetChat();
    set({ chatSessions: [] });
    if (!projectPath) return;
    try {
      const sessions = await listChatSessions(projectPath);
      set({ chatSessions: sessions });
      if (sessions.length > 0) {
        const raw = await loadChatSession(projectPath, sessions[0].id);
        const snap = raw ? deserializeChatSession(raw) : null;
        if (snap) {
          turnCounter = Math.max(turnCounter, maxTurnId(snap.turns));
          set({
            turns: snap.turns,
            chatHistory: snap.history,
            chatMeta: snap.meta,
            chatUsage: snap.usage,
            chatSessionId: sessions[0].id,
            chatTaskWorkspace: await workspaceForSnapshot(projectPath, snap.taskId),
          });
        }
      }
    } catch (e) {
      console.warn("chat session restore failed:", e);
    }
  },
}));

/**
 * Rebind a restored session to its own task workspace — or to nothing.
 *
 * The workspace may have been GC'd since the session was saved (20-task cap);
 * a handle to a pruned task would quietly resurrect an empty directory on the
 * next note, so only a taskId whose task.md still parses gets a handle back.
 */
async function workspaceForSnapshot(
  projectPath: string,
  taskId: string | null,
): Promise<TaskWorkspaceHandle | null> {
  if (!taskId) return null;
  try {
    return (await loadTaskDoc(projectPath, taskId)) ? existingWorkspace(projectPath, taskId) : null;
  } catch {
    return null;
  }
}

/**
 * Build the seed for resuming a paused task with a fresh, clean context.
 *
 * Reads task.md for goals/steps, lists notes, and validates the freshness
 * of sourceRefs using FNV-1a hashes. The returned userContent is an
 * instruction to continue without replaying any old conversation history.
 */
export async function buildResumeSeed(
  projectPath: string,
  taskId: string,
): Promise<{ userContent: string; title: string; taskWorkspace: TaskWorkspaceHandle }> {
  const doc = await loadTaskDoc(projectPath, taskId);
  if (!doc) throw new Error(i18n.t("ai.errors.taskNotFound", { defaultValue: "未找到任务工作区" }));

  // 1. Check reference freshness with memory.ts's hashText
  const stale: string[] = [];
  for (const ref of doc.meta.sourceRefs ?? []) {
    const abs = `${projectPath}/${ref.path}`;
    const mark = (reasonKey: string) =>
      stale.push(`- ${ref.path}（${i18n.t(`ai.instructions.${reasonKey}`)}）`);
    if (!(await fileExists(abs))) {
      mark("taskResumeDeleted");
      continue;
    }
    try {
      if (hashText(await readFile(abs)) !== ref.hash) mark("taskResumeModified");
    } catch {
      mark("taskResumeUnreadable");
    }
  }

  // 2. notes index: paths and titles only, not whole bodies
  const notes = await listTaskNotes(projectPath, taskId);

  // 3. Clean user turn without any stale conversation history
  const staleBlock = stale.length
    ? i18n.t("ai.instructions.taskResumeStale", { list: stale.join("\n") })
    : "";

  const notesBlock = notes.length
    ? notes.map((n) => `- ${n.path} — ${n.title}（${n.chars} 字符）`).join("\n")
    : i18n.t("ai.instructions.taskResumeNoNotes", { defaultValue: "（暂无保存的笔记）" });

  const userContent = i18n.t("ai.instructions.taskResume", {
    defaultValue:
      "【恢复任务】\n以下是此前已暂停的任务进度与相关笔记索引：\n\n## 任务状态与规划\n{{body}}\n\n## 已有笔记索引\n{{notes}}{{stale}}\n\n请直接根据当前规划和笔记，继续推进未完成的步骤。如果需要查阅笔记详情，使用 `read_note` 读取对应路径。",
    body: doc.body,
    notes: notesBlock,
    stale: staleBlock,
  });

  return {
    userContent,
    title: doc.body.match(/^#\s+(.+)$/m)?.[1].trim() || taskId,
    taskWorkspace: existingWorkspace(projectPath, taskId),
  };
}
