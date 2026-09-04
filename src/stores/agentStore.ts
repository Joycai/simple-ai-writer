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
 * ── Why every store is reached through `await import()` ──
 * aiTaskStore imports THIS module at the top level. A static import back would
 * close the cycle, so every store this file touches — aiStore, projectStore,
 * loreStore, appStore, editorStore, memoryStore — is loaded lazily at the call
 * site. Plain `src/lib/**` modules carry no such constraint and are imported
 * normally above. See docs/reference/architecture.md → Circular Dependencies.
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import i18n from "../i18n";
import { backupFile } from "../lib/agent/backup";
import { applyFindReplace, applyInsertions } from "../lib/agent/editApply";
import {
  coreDoneFor, createSessionMeta, injectedFacetsFor, noteTurnStart, planFold,
  recordInjectionsFromReport,
  type ChatSessionMeta, compactTriggerFor,
} from "../lib/agent/compact";
import { compactChatHistory, summarizeForCompaction } from "../lib/agent/compactRun";
import { requestStateUpdate, updateSkillState } from "../lib/agent/skillStateRun";
import { isSkillStateEnabled } from "../lib/agent/stateFlag";
import { STATE_KEEP_TURNS } from "../lib/agent/skillState";
import {
  deserializeChatSession, maxTurnId, serializeChatSession, sessionPreview,
} from "../lib/agent/chatSession";
import { applyRewindCut, planRewind } from "../lib/agent/rewind";
import {
  deleteChatSession as deleteChatSessionRow, listChatSessions, loadChatSession,
  normalizeSessionTitle, setChatSessionPinned, setChatSessionTitle, upsertChatSession,
  type ChatSessionRow,
} from "../lib/agent/sessionDb";
import type { ChatSnapshot } from "../lib/agent/chatSession";
import { MAX_CONCURRENT_RUNS, nextRunnableJobIndex, ownerBusy } from "../lib/agent/scheduler";
import { chatState, mostUrgent, type ChatState } from "../lib/agent/chatState";
import { sessionLabel } from "../lib/agent/sessionDb";
import type { WritingFocus } from "./editorStore";
import { appendAgentEventTo, type AgentEvent, type ToolProgress } from "../lib/agent/events";
import { createStreamThrottle } from "../lib/agent/streamThrottle";
import {
  chatAutoApproveKey, ILLUSTRATE_GRANT_MAX, grants, grantsAppend, grantsIllustrate,
  isAutoApprovable, isChatAutoApproveKey, type AutoApproveKind, type AutoApproveState,
} from "../lib/agent/autoApprove";
import type { SurfaceTagged } from "../lib/agent/approvalRouting";
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
import { chatAgentPreset, ORCHESTRATOR_PRESET } from "../lib/agent/packs";
import { routeTools } from "../lib/agent/routing";
import {
  resolveSubAgentConn, visionSubAgentModel, withSessionOverrides,
  type SubAgentConfig, type SubAgentKind,
} from "../lib/agent/subagent";
import {
  repairToolCallPairing, runAgent,
  type RoundLimitDecision, type TruncationDecision,
} from "../lib/agent/runtime";
import { persistUsage } from "../lib/ai/usage";
import {
  measureCharsPerToken, RECENT_WINDOW_MIN_CHARS,
} from "../lib/context/budget";
import { messageCeilingFor } from "../lib/agent/toolCost";
import { workflowBriefingSection } from "../lib/workflow";
import { docxBriefingSection } from "../lib/docx/briefing";
import { currentFormats } from "./docFormatStore";
import {
  hashText, loadMemory, MEMORY_BUDGET_CHARS, projectRelativePath,
} from "../lib/context/memory";
import { contributingEntities } from "../lib/context/loreSelect";
import { parentDir } from "../lib/context/outline";
import {
  assembleContext, assembleTurnInjection, bundleToChatMessages, profileSystemPrompt,
} from "../lib/context/rag";
import { docModel, promptParams } from "../lib/profile/active";
import type {
  AppendProposal, ApprovalDecision, AskAnswer, AskQuestion, EditProposal, InsertProposal, Proposal,
  RewriteProposal,
} from "../lib/agent/registry";
import { type AttachedItem } from "../lib/lore/aiTask";
import type { MessageContent, StreamMessage } from "../lib/ai/types";
import { fileExists, readFile, writeFile } from "../lib/fs/fileio";
import { loadApiKey } from "../lib/keyStore";
import { expandAuthorIntent } from "../lib/context/expand";
import { recordRunOutcome } from "../lib/ai/modelHealth";
import { costFor } from "../lib/ai/configDb";
import { connOptions, resolveConn, type ConnPair } from "../lib/ai/conn";
import { notify } from "../lib/notify";
import { baseName, isSamePath } from "../lib/paths";

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
  /**
   * Which surface renders this card. Absent = the default ones (chat + task
   * panel), which is every caller that existed before roleplay. See
   * lib/agent/approvalRouting for the one rule and why the default is "show".
   */
  surface?: string;
  /**
   * Where to report the wait while the approved proposal is being *carried
   * out*, for the kinds whose apply is the slow part.
   *
   * Approving a picture is instantaneous; drawing it polls for up to ten
   * minutes (`lib/ai/image`), and in that window the tool call is parked inside
   * `requestApproval` with no way to say anything — the log shows a step on
   * "running", which is also what a dead endpoint shows. This is the tool's own
   * `ctx.onProgress`, passed down by the call that asked, so what it advances
   * is that call's own row.
   */
  onApplyProgress?: (p: ToolProgress) => void;
}

export interface PendingApproval extends ApprovalBinding {
  proposal: Proposal;
  resolve: (decision: ApprovalDecision) => void;
  runId: RunId;
  /** When the card landed — the tab's 「等你 · mm:ss」 counts from here. */
  at: number;
}

export interface PendingPlan extends SurfaceTagged {
  plan: LorePlan;
  resolve: (decision: PlanDecision) => void;
  runId: RunId;
  at: number;
  /** Same meaning as on ApprovalBinding — plans carry their own grant flag. */
  autoApproveKey?: unknown;
}

/**
 * A run that hit its round cap mid-work, waiting for the author to choose:
 * grant `extension` more rounds, or let it wrap up now. At most one per run —
 * the runtime blocks on the answer, so a second can't queue behind the first.
 */
export interface PendingRoundLimit extends SurfaceTagged {
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
  at: number;
}

/**
 * A run blocked on "the output cap keeps cutting you off — keep going?".
 *
 * Same shape as {@link PendingRoundLimit} and for the same reason: the loop is
 * waiting on a person, and both chat and the task panel render the card.
 */
export interface PendingTruncation extends SurfaceTagged {
  id: string;
  /** Recoveries the runtime already made on its own before asking. */
  recoveries: number;
  resolve: (decision: TruncationDecision) => void;
  runId: RunId;
  at: number;
}

/**
 * A question the model put to the author (`ask_author`), blocking its run.
 *
 * Unlike the round-limit card there can be several per run — the read tier
 * executes in parallel, so two questions can land in one round — which is why
 * resolveQuestion keys on `id` where resolveRoundLimit keys on the run.
 */
export interface PendingQuestion extends SurfaceTagged {
  id: string;
  question: string;
  options: string[];
  resolve: (answer: AskAnswer) => void;
  runId: RunId;
  at: number;
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

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * One open conversation (a tab). Only opened conversations are here; the rest
 * of the history is rows (`chatSessions`). `key` is local and never reused;
 * `sessionId` arrives with the first persist.
 */
export interface LiveChat {
  key: string;
  /** DB row this conversation saves into; null until the first persist. */
  sessionId: number | null;
  /** The author's own name, or `""` (sessionDb.sessionLabel falls back to the preview). */
  title: string;
  turns: ChatTurn[];
  /** Wire-protocol history the runtime appends to; null until the first turn. */
  history: StreamMessage[] | null;
  /**
   * Turn boundaries + seed/summary identities for `history` — what the flat
   * array can't say about itself. Mutated in place alongside the history it
   * describes (lib/agent/compact); null exactly when `history` is.
   */
  meta: ChatSessionMeta | null;
  /** Conversation-cumulative usage across all turns. */
  usage: ChatUsage | null;
  /**
   * Bumped whenever the wire history's *composition* changes, so the composer's
   * context bar can recompute. `history` can't do that job: the runtime and the
   * injection pass push into it in place, leaving the array reference — and
   * therefore any selector on it — untouched. Deliberately not bumped for
   * streamed text, which arrives per chunk and never touches the history.
   */
  contextVersion: number;
  /**
   * Disk workspace the scratchpad tools write into, for the *whole* conversation.
   * Per conversation rather than per turn: a note the assistant filed on turn 3
   * has to still be readable on turn 9. Lazy, like the handle itself. The taskId
   * rides in the session blob, so a conversation reopened from the history menu
   * reconnects to its own notes (`workspaceForSnapshot`).
   */
  taskWorkspace: TaskWorkspaceHandle | null;
  error: string | null;
  /** Subagents temporarily disabled for this conversation (session-level override). */
  disabledSubAgents: SubAgentKind[];
  /**
   * 计划模式: while on, every turn of this conversation carries a standing
   * instruction to open a task checklist with `task_plan` and keep it live with
   * `task_progress` while working. A mode, not a one-off request; a new
   * conversation starts back at off.
   */
  planMode: boolean;
  /**
   * 状态记忆（SKILL.state 模式）for this conversation. Unlike planMode it is a
   * property of the saved session (the history's shape depends on it), so it
   * mirrors `meta.stateMode`: written through together, restored with the blob.
   */
  stateMemory: boolean;
  /**
   * Something happened here while the author was on another tab: a run
   * finished (or failed), or a card is waiting. Cleared by activateChat.
   */
  unread: boolean;
}

/**
 * A send waiting for (or holding) a slot. Everything decided at send time rides
 * here so the run does not re-read "the current" anything.
 */
export interface ChatJob {
  key: string;
  projectPath: string;
  focus: WritingFocus;
  message: string;
  quoted: string | undefined;
  refs: AttachedItem[];
  opts: SendChatOptions | undefined;
  model: ConnPair["model"];
  provider: ConnPair["provider"];
  effectiveSubs: Record<SubAgentKind, SubAgentConfig>;
  wireMessage: string;
  composed: MessageContent;
  imagePaths: string[];
  /** The author's turn already on screen — what 取消排队 hands back to the composer. */
  userTurnId: string;
  /** The empty assistant turn already on screen, where the answer streams into. */
  assistantTurnId: string;
}

/** 换项目 while conversations are busy: the question put to the author (设计稿 23 屏 1j). */
export interface ProjectSwitchGuard {
  /** Where the author is going — a folder name, or null for "closing the project". */
  target: string | null;
  resolve: (leave: boolean) => void;
}

interface AgentState {
  pending: PendingApproval[];
  /** Lore plans awaiting the author's decision — the loop is blocked on each. */
  pendingPlans: PendingPlan[];
  /** Round-cap questions awaiting the author's decision — one per blocked run. */
  pendingRoundLimits: PendingRoundLimit[];
  /** Repeated-truncation questions awaiting the author — one per blocked run. */
  pendingTruncations: PendingTruncation[];
  /** `ask_author` questions awaiting the author — each blocks its tool call. */
  pendingQuestions: PendingQuestion[];
  /**
   * The one surface currently auto-approving, if any (lib/agent/autoApprove).
   * Null is the normal state: every card is asked.
   */
  autoApprove: AutoApproveState | null;

  // ── Chat sessions ──
  /** Every open conversation by key. Always holds `activeChatKey`. */
  chats: Record<string, LiveChat>;
  /** Open conversations in tab order. Never empty. */
  chatOrder: string[];
  activeChatKey: string;
  /** Keys generating right now — at most MAX_CONCURRENT_RUNS. */
  runningChats: string[];
  /** Keys whose history a manual compaction is swapping (compactChatNow). */
  compactingChats: string[];
  /** Sends waiting for a slot, FIFO. */
  chatQueue: ChatJob[];
  /** The running turn's controller, per key — what 停止 and the card queues know a run by. */
  chatAborts: Record<string, AbortController>;
  /**
   * What the last closed tab was called, when closing it left an empty
   * conversation behind (设计稿 23 屏 1j: the empty state says where it went).
   * Cleared by the next send or new tab.
   */
  lastClosedLabel: string | null;
  /** Non-null while 换项目 is waiting for the author's answer (设计稿 23 屏 1j). */
  projectSwitchGuard: ProjectSwitchGuard | null;
  /**
   * Sessions for the history menu, newest first: the recent ones (≤
   * MAX_CHAT_SESSIONS) plus every pinned, named or open one, which is why this
   * list has no length bound of its own. Recency order, not pinned-first — the
   * restore on project open reads element 0 as "where I left off".
   */
  chatSessions: ChatSessionRow[];

  /** Per-conversation switches. `key` defaults to the active conversation. */
  toggleSubAgent: (kind: SubAgentKind, key?: string) => void;
  setPlanMode: (on: boolean, key?: string) => void;
  setStateMemory: (on: boolean, key?: string) => void;

  /**
   * Author pressed 本次都批准 on a card: everything of that kind from the same
   * surface applies without a card until the grant is cleared. Same key merges,
   * a different key replaces — only one surface may hold a grant.
   */
  enableAutoApprove: (key: unknown, what: AutoApproveKind) => void;
  /**
   * Author pressed 本次都追加到这个文件 on an append card: further appends to
   * that one path apply without a card, for as long as the grant lives.
   */
  grantAppendPath: (key: unknown, path: string) => void;
  /**
   * Author pressed 批准并连批 on an illustrate card: the next `count` (1–5)
   * image proposals from the same surface apply without a card, each one
   * still spending real money. The budget dies with `runId` — see
   * AutoApproveState.illustrateRun.
   */
  grantIllustrations: (key: unknown, runId: RunId, count: number) => void;
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
    surface?: string,
  ) => Promise<RoundLimitDecision>;
  /** Resolve a blocked run's round-cap question: extend, finish, or pause. */
  resolveRoundLimit: (runId: RunId, decision: RoundLimitDecision) => void;

  /** Called by the runtime's onTruncationLimit after repeated truncation. */
  requestTruncationDecision: (
    recoveries: number, runId: RunId, surface?: string,
  ) => Promise<TruncationDecision>;
  /** Resolve a blocked run's truncation question: keep going, or stop here. */
  resolveTruncation: (runId: RunId, decision: TruncationDecision) => void;

  /** Called by the ask_author tool (via ToolContext.askAuthor). */
  requestQuestion: (
    q: AskQuestion, runId: RunId, surface?: string,
  ) => Promise<AskAnswer>;
  /** Author answered a question card: an option, or free text. */
  resolveQuestion: (id: string, answer: AskAnswer) => void;

  /** Called by propose_lore_plan (via ToolContext.requestPlanApproval). */
  requestPlanApproval: (
    plan: LorePlan, runId: RunId, autoApproveKey?: unknown, surface?: string,
  ) => Promise<PlanDecision>;
  /** User approved the plan — the gate records its steps and the loop resumes. */
  approvePlan: (id: string) => void;
  /** User rejected the plan: their reason goes back to the model verbatim. */
  rejectPlan: (id: string, reason?: string) => void;

  /** Bring one open conversation on screen (and mark it read). */
  activateChat: (key: string) => void;
  /**
   * Open a fresh conversation and make it active; returns its key. Reuses an
   * idle empty tab (reset to defaults) rather than adding a second blank one.
   */
  newChat: () => string;
  /**
   * Close a tab — not delete: the row stays in the history. Refuses (false)
   * while the conversation is generating, folding or queued; stop it first.
   */
  closeChat: (key: string) => Promise<boolean>;
  /** Name (or with `""` un-name) a conversation. Works with or without a row, running or not. */
  renameChat: (title: string, key?: string) => Promise<void>;
  /** Name a *saved* conversation by row id — through renameChat if it is open, else straight to the row. */
  renameSession: (id: number, title: string) => Promise<void>;
  /**
   * Delete a saved conversation for good — the caller confirms. Refuses (false)
   * while it is open and busy. An open idle one loses its tab as well.
   */
  deleteChatSession: (id: number) => Promise<boolean>;

  /** Send to the active conversation. */
  sendChat: (
    text: string, quote?: string, refs?: AttachedItem[], opts?: SendChatOptions,
  ) => Promise<void>;
  /**
   * Send to one conversation: the turn goes on screen at once and the job
   * queues for a slot (MAX_CONCURRENT_RUNS across conversations, one at a time
   * within one). @param quote Manuscript passage attached to the message, if
   * the author pinned their selection to it.
   */
  sendChatTo: (
    key: string, text: string, quote?: string, refs?: AttachedItem[], opts?: SendChatOptions,
  ) => Promise<void>;
  /** Resume a paused task in a conversation of its own, from task.md and notes. */
  resumeTask: (taskId: string) => Promise<void>;
  /** Author called a task off: stop it if live, then mark it aborted on disk. */
  abortTask: (taskId: string) => Promise<void>;
  /** Stop one conversation's run (and drop its queued sends). Others keep going. */
  stopChat: (key?: string) => void;
  /**
   * 取消排队: drop a conversation's queued sends and hand the first one's text
   * back (for the composer). The conversation itself stays.
   */
  dequeueChat: (key: string) => string | null;
  /** 插到最前: this conversation's queued sends go to the head of the queue. */
  promoteChat: (key: string) => void;
  /**
   * 换项目 / 关闭项目 with conversations generating, queued or waiting: put the
   * question to the author once (设计稿 23 屏 1j) and resolve with their answer.
   * Resolves true at once when everything is idle — nothing to ask.
   */
  confirmProjectSwitch: (target: string | null) => Promise<boolean>;
  /**
   * Author-requested compaction ("主动 compact"): fold the older turns into the
   * rolling summary right now, without waiting for the COMPACT_TRIGGER. Same
   * machinery as the between-turns pass, forced (docs/feature/agent/chat-memory-plan.md §10).
   * No-op while the conversation is busy or nothing is foldable.
   */
  compactChatNow: (key?: string) => Promise<void>;

  /** Save one open conversation to the project DB (best-effort, never throws). */
  persistChat: (key?: string) => Promise<void>;
  /**
   * Open a saved conversation: focus its tab if it is already open, else load
   * it into the active tab when that is empty, else into a new tab.
   */
  switchChatSession: (id: number) => Promise<void>;
  /**
   * Pin / unpin one stored session. A pinned session is exempt from the
   * five-session cap, so it stays reachable from the history menu until the
   * author releases it.
   */
  toggleChatSessionPin: (id: number) => Promise<void>;
  /**
   * 回到这里重说: undo one of the author's questions and everything after it.
   * Resolves with the question's text for the composer, or null when the turn
   * cannot be rewound to (see lib/agent/rewind for which ones can).
   */
  rewindChat: (turnId: string, key?: string) => Promise<string | null>;
  /**
   * Project open/close hook (projectStore calls this): stop every run, drop the
   * previous project's conversations from view, then restore the new project's
   * newest one.
   */
  resetChatForProject: (projectPath: string | null) => Promise<void>;
}

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

  // Which occurrence(s), and what to do when the file has moved on, are
  // `agent/editApply`'s job — the same reasoning as rag.ts's resolveEditRange
  // (repeated lines are ordinary in a draft, so writing at "wherever it happens
  // to appear first" would change text the author never approved), generalised
  // to the targeted edits propose_edit can now make.
  const rewrite = (text: string): string =>
    applyFindReplace(text, proposal.find, proposal.replace, proposal.occurrences, proposal.target);

  if (isSamePath(activeFilePath, proposal.path)) {
    // The file is open — go through the editor so unsaved edits are kept
    // and the change is visible (and autosaved) immediately.
    const { useEditorStore } = await import("./editorStore");
    const { content, setContent } = useEditorStore.getState();
    setContent(rewrite(content));
  } else {
    await writeFile(proposal.path, rewrite(await readFile(proposal.path)));
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

  if (isSamePath(activeFilePath, proposal.path)) {
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
 * Apply an approved append. Returns the pre-write backup path.
 *
 * Reads the file *now* rather than trusting the length the proposal recorded:
 * the author may have kept typing while the card sat there, and an append is
 * the one write where that is harmless — whatever they added stays, and the
 * new section lands after it. The recorded length is only the card's "grew
 * from" figure, never a precondition.
 */
async function applyAppend(proposal: AppendProposal): Promise<string | null> {
  const { useProjectStore } = await import("./projectStore");
  const { projectPath, activeFilePath } = useProjectStore.getState();
  const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

  if (isSamePath(activeFilePath, proposal.path)) {
    // Same reason as applyEdit/applyRewrite: through the editor, so the open
    // buffer doesn't overwrite the append on its next autosave.
    const { useEditorStore } = await import("./editorStore");
    const { content, setContent } = useEditorStore.getState();
    setContent(content + proposal.content);
  } else {
    const raw = await readFile(proposal.path);
    await writeFile(proposal.path, raw + proposal.content);
  }
  return backupPath;
}

/**
 * Apply approved insertions. Returns the pre-write backup path.
 *
 * The recorded line count is passed through to be re-checked against the file
 * as it stands now — `applyInsertions` owns that refusal, exactly as
 * `applyFindReplace` owns the occurrence check `applyEdit` relies on. The
 * author may have kept typing while the card sat there, and every line number
 * on that card points somewhere else the moment they did.
 */
async function applyInsert(proposal: InsertProposal): Promise<string | null> {
  const { useProjectStore } = await import("./projectStore");
  const { projectPath, activeFilePath } = useProjectStore.getState();
  const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

  const splice = (text: string): string =>
    applyInsertions(text, proposal.insertions, proposal.lineCount);

  if (isSamePath(activeFilePath, proposal.path)) {
    // Same reason as applyEdit: through the editor, so unsaved work survives
    // and the change is visible and autosaved at once.
    const { useEditorStore } = await import("./editorStore");
    const { content, setContent } = useEditorStore.getState();
    setContent(splice(content));
  } else {
    await writeFile(proposal.path, splice(await readFile(proposal.path)));
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
  /** Where a copy actually landed (collision auto-numbering decides at apply time). */
  resultPath?: string;
}

/**
 * Carry out what an approved proposal asked for. Throwing here is how a failure
 * reaches the model as a rejection — never swallow one and report success.
 */
async function applyProposal(
  proposal: Proposal,
  signal?: AbortSignal,
  onProgress?: (p: ToolProgress) => void,
): Promise<ApplyOutcome> {
  const { useProjectStore } = await import("./projectStore");
  const { createEntry, moveEntry, deleteEntry, copyEntry } = useProjectStore.getState();

  switch (proposal.kind) {
    case "edit":
      return { report: await applyEdit(proposal) };

    case "rewrite":
      return { report: await applyRewrite(proposal) };

    case "append":
      return { report: await applyAppend(proposal) };

    case "insert":
      return { report: await applyInsert(proposal) };

    case "create": {
      const dir = parentDir(proposal.path);
      const name = proposal.path.slice(dir.length + 1);
      await createEntry(dir, name, proposal.isDir ? "folder" : "file", proposal.content);
      return { report: null }; // nothing existed to back up
    }

    case "move":
      await moveEntry(proposal.path, proposal.newPath);
      return { report: null }; // the file still exists, at its new path

    case "copy":
      // The source is untouched; the interesting fact is where the copy
      // landed, which collision auto-numbering decides only now.
      return {
        report: null,
        resultPath: await copyEntry(proposal.path, proposal.destDir, proposal.isDir, proposal.newName),
      };

    case "convert": {
      // The conversion already ran when the card was raised; this copies that
      // exact entry out of the cache beside the source (lib/import/materialize).
      const { materializeConversion } = await import("../lib/import/materialize");
      const landed = await materializeConversion(proposal.sourcePath, proposal.cacheDir);
      // Written with the raw file writer — the tree needs telling.
      await useProjectStore.getState().refreshFileTree();
      return {
        resultPath: landed,
        report: [
          `Converted ${proposal.sourcePath} to ${landed} (${proposal.chars} characters; the original is untouched).`,
          proposal.pictures > 0
            ? `${proposal.pictures} picture(s) extracted to the document's assets/ folder, linked from the text.`
            : "",
          proposal.scanned
            ? "NOTE: this PDF had no text layer (a scan), so the document holds page pictures and no text. Say so to the author."
            : "",
        ].filter(Boolean).join("\n"),
      };
    }

    case "delete":
      // The backup is what makes an approved deletion recoverable, so it is
      // not optional. The entry — file or folder — is renamed into backups whole.
      return { report: await deleteEntry(proposal.path, !!proposal.isDir, { backup: true }) };

    case "illustrate": {
      // The only kind whose "apply" spends money and calls out to a provider.
      // Approving is the author paying, so it happens here rather than at
      // proposal time — a rejected card costs nothing.
      const { runIllustration } = await import("../lib/image/illustrate");
      const { projectPath: root } = useProjectStore.getState();
      const outcome = await runIllustration(proposal, root ?? "", signal, onProgress);
      if (proposal.dest.kind === "lore") {
        // The gallery grew — rescan so the entity view shows it at once.
        // Awaited: this function's caller reports the outcome to the model, and
        // an unawaited scan makes "saved" race the index that proves it.
        const { useLoreStore } = await import("./loreStore");
        if (root) await useLoreStore.getState().scanProject(root);
      } else {
        // Same reason the pptx case below refreshes: the picture is written
        // with the raw byte writer, which the file tree knows nothing about, so
        // without this it stays invisible in the sidebar until something else
        // happens to refresh — and the author is told a file exists that they
        // cannot see.
        await useProjectStore.getState().refreshFileTree();
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

    case "pptx": {
      // Applied here rather than in the tool for the same reason `illustrate`
      // is: the work needs something the tool loop does not have. There it was
      // the author's money; here it is a DOM — the page has to be laid out by
      // a real browser before anything can be measured (lib/pptx).
      const { exportHtmlToPptx } = await import("../lib/pptx");
      const outcome = await exportHtmlToPptx(proposal.sourcePath, proposal.path);
      // The deck is written with the raw byte writer, which the file tree knows
      // nothing about — without this the new file is invisible until something
      // else refreshes.
      await useProjectStore.getState().refreshFileTree();
      return {
        resultPath: outcome.path,
        report: [
          `Exported ${outcome.slides} slide(s) to ${outcome.path}.`,
          outcome.degraded.length
            ? `These did not carry across faithfully — tell the author:\n- ${outcome.degraded.join("\n- ")}`
            : "",
        ].filter(Boolean).join("\n"),
      };
    }

    case "docx": {
      // Same reason as the pptx case: the work needs something the tool loop
      // does not have — here it is a 1 MB library that must stay out of the
      // startup bundle, and a binary write.
      const { exportMarkdownToDocx } = await import("../lib/docx");
      const outcome = await exportMarkdownToDocx(proposal.sourcePath, proposal.format, proposal.path);
      // Written with the raw byte writer, which the file tree knows nothing
      // about — without this the new file is invisible until something else
      // refreshes.
      await useProjectStore.getState().refreshFileTree();
      return {
        resultPath: outcome.path,
        report: [
          `Exported ${outcome.blocks} block(s) to ${outcome.path}, laid out by ${proposal.originLabel}.`,
          outcome.degraded.length
            ? `These fell back to a simpler form — state them plainly to the author, they are facts rather than errors:\n- ${outcome.degraded.join("\n- ")}`
            : "Nothing degraded.",
          // Naming it here is the only way the assistant knows not to promise a
          // preview that matches the author's screen.
          proposal.missingFonts.length
            ? `NOTE: ${proposal.missingFonts.join("、")} is not installed on this machine. The file is still correct — it will render properly wherever the font exists — but the author's own preview will substitute it.`
            : "",
        ].filter(Boolean).join("\n"),
      };
    }

    case "xlsx": {
      // Unlike the two above, nothing is converted here: the workbook was built
      // when the card was raised, so this step only turns the approved grid
      // into bytes (lib/xlsx/write.ts) and puts them on disk.
      const { writeWorkbook } = await import("../lib/xlsx");
      await writeWorkbook(proposal.sheets, proposal.path);
      // Written with the raw byte writer, which the file tree knows nothing
      // about — without this the new file is invisible until something else
      // refreshes.
      await useProjectStore.getState().refreshFileTree();
      const cells = proposal.summaries.reduce(
        (acc, s) => ({
          numbers: acc.numbers + s.numbers,
          dates: acc.dates + s.dates,
          formulas: acc.formulas + s.formulas,
        }),
        { numbers: 0, dates: 0, formulas: 0 },
      );
      return {
        resultPath: proposal.path,
        report: [
          `Exported ${proposal.summaries.length} sheet(s) to ${proposal.path}: ${proposal.summaries
            .map((s) => `"${s.name}" ${s.rows}×${s.cols}`)
            .join(", ")}.`,
          `Typed cells: ${cells.numbers} number(s), ${cells.dates} date(s), ${cells.formulas} formula(s). Everything else is text.`,
          proposal.skipped.length
            ? `These are in the document but not in the workbook — a worksheet has nowhere to put them. State them plainly to the author:\n- ${proposal.skipped.join("\n- ")}`
            : "",
          // Without this the assistant promises a total the author will not see
          // until they open the file in a real spreadsheet app.
          cells.formulas > 0
            ? "NOTE: formulas are written without a cached result, so Excel and LibreOffice compute them on open; a preview that only reads stored values may show those cells blank until then."
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
    const { report, imagePath, resultPath } = await applyProposal(
      item.proposal, item.signal, item.onApplyProgress,
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
/**
 * The chat session's system layer: writing prompt + tier briefing + the
 * read-once rosters (workflow cards; docx formats on the assist tier only —
 * the orchestrator holds no export tool to name formats for).
 *
 * One function because it is built at two moments that must agree: seeding a
 * new session, and rewriting history[0] when the 助手工具包模式 Beta flips
 * mid-session. The briefing is the one part of the read-once layer that must
 * not lie about the toolset — the orchestrator's mandates every write go
 * through `run_pack`, which routing removes the moment the Beta goes off, so
 * a stale one steers the model into "Unknown tool" on every write attempt.
 */
async function chatSystemPrompt(projectPath: string, orchestrating: boolean): Promise<string> {
  const { useAiStore } = await import("./aiStore");
  const { prompts, activePromptId } = useAiStore.getState();
  const writingPrompt =
    prompts.find((p) => p.id === activePromptId)?.content ?? profileSystemPrompt();
  const workflowSection = await workflowBriefingSection(projectPath);
  const docxFormats = currentFormats();
  const docxSection = docxBriefingSection(docxFormats.presets, docxFormats.defaultId);
  const briefing = i18n.t(
    orchestrating ? "ai.instructions.orchestrator" : "ai.instructions.agent",
    promptParams(i18n.language === "zh-CN"),
  );
  return (
    `${writingPrompt}\n\n${briefing}` +
    (workflowSection ? `\n\n${workflowSection}` : "") +
    (docxSection && !orchestrating ? `\n\n${docxSection}` : "")
  );
}

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

  chats: { c0: emptyChat("c0") },
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
          && grantsAppend(get().autoApprove, item.autoApproveKey, proposal.path));
      if (covered) {
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
    // The illustrate budget dies with the run that granted it, even in chat,
    // where the boolean grants live on: it is authorisation to spend money,
    // given for the pictures of THIS run, and any remainder must not sit
    // armed across turns the author hasn't read yet.
    else if (get().autoApprove?.illustrateRun === runId) {
      set((s) => s.autoApprove
        ? { autoApprove: { ...s.autoApprove, illustrateLeft: 0, illustrateRun: undefined } }
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
      chats: { ...st.chats, [key]: emptyChat(key) },
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
    void import("./composerStore").then((m) =>
      m.useComposerStore.getState().clearChatComposer(key),
    );
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
    const { useAiStore } = await import("./aiStore");
    const { useProjectStore } = await import("./projectStore");
    const { getWritingFocus } = await import("./editorStore");

    // Resolved at *send* time and carried on the job: a queued question runs on
    // the model that was active when it was asked, not on whatever the header
    // says by the time a slot frees up.
    const { models, providers, activeModelId } = useAiStore.getState();
    const resolved = resolveConn(models, providers, activeModelId);
    const { projectPath } = useProjectStore.getState();
    // One atomic read of the focused document, held for the whole turn — see
    // editorStore.WritingFocus for why this must not be recomposed per use.
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
        allowImages: model.type === "multimodal",
        visionDelegate: visionSubAgentModel(
          useAiStore.getState().models, effectiveSubs,
        ) !== null,
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

    const { useAiStore } = await import("./aiStore");
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
      { handoff: true, packs: true },
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
      chats: { [key]: emptyChat(key) },
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

// ─── Multi-session plumbing ──────────────────────────────────────────────────

let chatKeyCounter = 0;
/** A tab's local identity. Never reused within a process, never persisted. */
function newChatKey(): string {
  return `c${++chatKeyCounter}`;
}

/** A fresh, empty conversation: no row, no history, every switch at default. */
export function emptyChat(key: string): LiveChat {
  return {
    key, sessionId: null, title: "", turns: [], history: null, meta: null, usage: null,
    contextVersion: 0, taskWorkspace: null, error: null,
    disabledSubAgents: [], planMode: false, stateMemory: false, unread: false,
  };
}

/**
 * A saved conversation as an open one. The chips say "this conversation", so
 * they start at default — a temporary switch is not worth a format change.
 * 状态记忆 IS stored in the blob (the restored history's shape was made by it),
 * so the chip must show what it is. Auto-approve is deliberately not
 * persisted either: standing authorisation to rewrite prose is the last thing
 * that should follow the author into another manuscript.
 */
function chatFromSnapshot(
  snap: ChatSnapshot,
  sessionId: number,
  title: string,
  taskWorkspace: TaskWorkspaceHandle | null,
): Omit<LiveChat, "key"> {
  return {
    sessionId, title,
    turns: snap.turns, history: snap.history, meta: snap.meta, usage: snap.usage,
    contextVersion: 0, taskWorkspace, error: null,
    disabledSubAgents: [], planMode: false, stateMemory: snap.meta.stateMode, unread: false,
  };
}

type Set = (fn: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)) => void;
type Get = () => AgentState;

/**
 * The one way a conversation's fields are written. A missing key is a closed
 * tab whose run is still unwinding — nothing to update, and nothing to crash.
 */
function patchChat(
  set: Set,
  key: string,
  patch: Partial<LiveChat> | ((c: LiveChat) => Partial<LiveChat>),
): void {
  set((s) => {
    const chat = s.chats[key];
    if (!chat) return {};
    const p = typeof patch === "function" ? patch(chat) : patch;
    return { chats: { ...s.chats, [key]: { ...chat, ...p } } };
  });
}

/** Row ids of every open tab — the prune's `keep` list. */
function openSessionIds(s: AgentState): number[] {
  return s.chatOrder
    .map((k) => s.chats[k]?.sessionId)
    .filter((id): id is number => typeof id === "number");
}

async function refreshSessionList(set: Set, get: Get): Promise<void> {
  const { useProjectStore } = await import("./projectStore");
  const { projectPath } = useProjectStore.getState();
  if (!projectPath) return;
  set({ chatSessions: await listChatSessions(projectPath, openSessionIds(get())) });
}

/**
 * A card just landed for `surface`. If that is a chat conversation other than
 * the one on screen, the tab has to say so — a run blocked on a card the
 * author cannot see is a run that never finishes. (Roleplay's roster marks
 * only completions; this is the gap the plan's §4.4 closes for chat.)
 */
function noteCardFor(set: Set, get: Get, surface: string | undefined): void {
  if (!surface || !surface.startsWith("chat:")) return;
  const key = surface.slice("chat:".length);
  if (get().activeChatKey !== key) patchChat(set, key, { unread: true });
}

/** A conversation's standing grant ends with the conversation (close / reset). */
function endGrantFor(set: Set, get: Get, key: string): void {
  if (get().autoApprove?.key === chatAutoApproveKey(key)) set({ autoApprove: null });
}

/**
 * The semaphore: while a slot is free, start the first queued job whose
 * conversation is not already generating or folding. Called from every path
 * that frees a slot or adds a job.
 */
function pump(set: Set, get: Get): void {
  for (;;) {
    const { runningChats, compactingChats, chatQueue } = get();
    if (runningChats.length >= MAX_CONCURRENT_RUNS) return;
    const idx = nextRunnableJobIndex(chatQueue, runningChats, compactingChats, (j) => j.key);
    if (idx < 0) return;
    const job = chatQueue[idx];
    set((s) => ({
      chatQueue: s.chatQueue.filter((_, i) => i !== idx),
      runningChats: [...s.runningChats, job.key],
    }));
    void runChatJob(job, set, get);
  }
}

/**
 * One turn of one conversation — everything from "the slot is ours" to "the
 * slot is free". The job carries what was decided at send time (model,
 * message, focus, references); everything read from the store in here is read
 * by `job.key`, never from "the current conversation", because the author may
 * be on another tab by now.
 */
async function runChatJob(job: ChatJob, set: Set, get: Get): Promise<void> {
  const {
    key, projectPath, focus, message, quoted, refs, model, provider, effectiveSubs,
    wireMessage, composed, assistantTurnId,
  } = job;
  const { useAiStore } = await import("./aiStore");
  const { useLoreStore } = await import("./loreStore");
  const { useAppStore } = await import("./appStore");
  const activeFilePath = focus.filePath;

  /**
   * 查询扩展的一次调用，接在 `effectiveSubs` 上——所以「本次对话关掉它」这个
   * 芯片对它也有效……除了它没有芯片（见 SubAgentChips：轮到芯片渲染的时候它
   * 已经跑完了）。走 `effectiveSubs` 而不是原始配置仍然是对的：这一条不变量
   * 是「本轮谁是活的」只有一个答案。
   *
   * 永不抛、永不阻塞：没绑模型就整段不跑，其余一切失败都退回未扩展的行为。
   */
  const expandForRetrieval = async (intent: string, signal: AbortSignal): Promise<string[]> => {
    const cfg = effectiveSubs.retrieval;
    if (!cfg?.enabled || !cfg.modelId || !intent.trim()) return [];
    const { models: allModels, providers: allProviders } = useAiStore.getState();
    const conn = await resolveSubAgentConn(
      "retrieval", allModels, allProviders, effectiveSubs, loadApiKey,
    );
    if ("error" in conn) return [];
    return expandAuthorIntent({
      intent,
      loreIndex: useLoreStore.getState().index,
      scope: useLoreStore.getState().scope,
      conn,
      signal,
    });
  };

  const { withDirective } = await import("../lib/agent/chatRefs");
  // 计划模式: repeated on every turn while the switch is on, not stated once.
  // The system layer is the only one that survives intact, and this mode is
  // toggled mid-conversation — so a one-time announcement would be buried by
  // turn three, exactly when the model decides whether this job needs a plan.
  const wireContent = get().chats[key]?.planMode
    ? withDirective(composed, i18n.t("ai.instructions.planMode"))
    : composed;

  // ── Is this turn about the document the author has open? ──
  // The chat used to answer "always" and seed its tail window into every
  // session. Most questions are not about the file that happens to be in the
  // editor, so the default is now the path plus a *brief* (title, length,
  // outline) and the assistant reads the file itself when it judges it
  // relevant. See lib/context/docFocus for what counts as pointing at the
  // document, and docs/feature/agent/chat-memory-plan.md §5a for why the line is drawn
  // where it is.
  const { documentBrief, wantsDocumentBody } = await import("../lib/context/docFocus");
  const docRelPath = activeFilePath ? projectRelativePath(projectPath, activeFilePath) : null;
  const wantsDocBody = !!activeFilePath && wantsDocumentBody({
    query: message,
    hasQuote: !!quoted,
    // The author `@`-ed the open file: chatRefs already inlined it, and the
    // window would send the same paragraphs a second time.
    alreadyAttached: refs.some(
      (r) => r.kind === "text" && r.file.path === activeFilePath,
    ),
  });
  // Sent in both modes — the title, length and outline describe parts of the
  // document the tail window doesn't reach. Only the "text withheld, read it
  // yourself" line is conditional.
  const docBrief = docRelPath
    ? documentBrief(focus.text, { withheld: !wantsDocBody })
    : null;

  // The slot is already ours (pump took it); the controller is what 停止 and
  // the card queues know this run by.
  const controller = new AbortController();
  set((s) => ({ chatAborts: { ...s.chatAborts, [key]: controller } }));
  patchChat(set, key, { error: null });

  const patchAssistant = (patch: (turn: ChatTurn) => ChatTurn) =>
    patchChat(set, key, (c) => ({
      turns: c.turns.map((tn) => (tn.id === assistantTurnId ? patch(tn) : tn)),
    }));

  // Streaming arrives per network chunk — far above reading speed — and each
  // store write re-renders the transcript. Output text and the live round's
  // reasoning are both latest-wins, so they buffer here and land at most
  // once per interval (see streamThrottle). Everything else (tool steps,
  // run-done) still writes immediately, behind a flush() ordering barrier.
  let pendingText: string | null = null;
  let pendingReasoning: (AgentEvent & { kind: "reasoning" }) | null = null;
  const stream = createStreamThrottle(() => {
    const text = pendingText;
    const reasoning = pendingReasoning;
    pendingText = null;
    pendingReasoning = null;
    if (text === null && reasoning === null) return;
    patchAssistant((tn) => ({
      ...tn,
      ...(reasoning ? { log: appendAgentEventTo(tn.log, reasoning) } : {}),
      ...(text !== null ? { text } : {}),
    }));
  });

  /** Tell the context bar the history changed under it (see chatContextVersion). */
  const bumpContext = () =>
    patchChat(set, key, (c) => ({ contextVersion: c.contextVersion + 1 }));

  /**
   * This session's disk workspace, created on first use and reused by every
   * later turn. Built here rather than in the state initialiser because it
   * needs the project path and the model, neither of which exists until a
   * turn actually runs.
   */
  const taskWorkspace = (): TaskWorkspaceHandle => {
    const existing = get().chats[key]?.taskWorkspace ?? null;
    if (existing) return existing;
    const handle = createTaskWorkspace(projectPath, model.id);
    patchChat(set, key, { taskWorkspace: handle });
    return handle;
  };

  try {
    const apiKey = (await loadApiKey(provider.id)) ?? "";

    // ── History: seed on first turn, append afterwards ──
    const {
      contextUtilization, autoCompact, compactTriggerTokens, compactTriggerRatio,
    } = useAppStore.getState();
    /**
     * The ceiling every **message-side** decision in this turn measures
     * against: compaction below, and the runtime's history trimming.
     *
     * The tool schemas' share is already taken out (lib/agent/toolCost), for
     * the reason lib/agent/contextBreakdown spells out: the assistant preset
     * carries a toolset worth thousands of tokens on every round, so a
     * history trimmed to `inputCeilingFor(...)` exactly produced a request
     * well past it. Computed once, used twice — those two used to compute it
     * separately, and the visible symptom was the context bar standing past
     * its own compaction mark with nothing happening.
     */
    // The Beta switch decides the tier for the WHOLE turn: ceiling, routing,
    // round cap and briefing all read this one value (lib/agent/packs).
    const chatPreset = chatAgentPreset();
    const messageCeiling = messageCeilingFor(
      model.contextSize,
      contextUtilization,
      chatPreset,
      effectiveSubs,
      useAiStore.getState().models,
      // The handoff schema rides on every round of a writer run — the whole
      // point of this module is that a ceiling must not assume a schema the
      // request carries. See lib/agent/toolCost. `packs` for the same
      // reason: with the dev flag on, run_pack is resident on every round.
      { handoff: true, packs: true },
    );
    let history = get().chats[key]?.history ?? null;
    if (!history) {
      // The agent briefing belongs in the SYSTEM layer, not in the first user
      // turn: only the system message survives every later turn intact. Seeded
      // as a task-layer instruction it decayed after turn one — the author's
      // "去执行" then landed in a context whose only standing instruction was a
      // prose-writing prompt, and the assistant kept answering with plans.
      //
      // The workflow roster rides with the briefing (same layer, same
      // stability) and is read once per session, like the rest of the seed:
      // a card edited mid-session is picked up by the next session. The
      // orchestrator tier gets its own briefing — the assist one teaches
      // tools this tier does not hold, which reads as the assistant being
      // broken. Construction shared with the mid-session tier refresh below:
      // see chatSystemPrompt.
      const orchestrating = chatPreset === ORCHESTRATOR_PRESET;
      const systemPrompt = await chatSystemPrompt(projectPath, orchestrating);
      const documentText = focus.text;
      // Follows the profile, like the panel's tasks do: a project whose
      // documents don't use rolling memory has none to inject. Loaded only
      // when the window is: the recap summarises the same text, so it rides
      // with it rather than standing in for it.
      const memory = wantsDocBody && docModel().memory && activeFilePath
        ? await loadMemory(projectPath, activeFilePath)
        : null;
      const { loreBudgetTokens } = useAppStore.getState();
      const charsPerToken = measureCharsPerToken(documentText);

      // 查询扩展——把这一句问话扩成知识库自己的词，并进同一个匹配靶。
      // 只有首轮走这里；后续轮在 assembleTurnInjection 那侧（见下）。
      // 没绑模型 / 超时 / 出错都退回未扩展的行为，绝不让一次取材优化变成一次
      // 失败的对话。见 docs/feature/lore/lore-retrieval-plan.md §5.3
      const seedTerms = await expandForRetrieval(wireMessage, controller.signal);
      const seedMatch = seedTerms.length
        ? `${wireMessage}\n${seedTerms.join(" ")}`
        : wireMessage;

      const bundle = await assembleContext(
        systemPrompt,
        useLoreStore.getState().index,
        documentText,
        "",
        wireMessage,
        {
          // 0 → the document is described, not injected (docBrief below).
          contextChars: wantsDocBody ? RECENT_WINDOW_MIN_CHARS : 0,
          // Named in both modes: which file the author is looking at is what
          // read_file, propose_edit and every other path-taking tool need,
          // and the chat never used to say it at all.
          currentFilePath: docRelPath ?? undefined,
          documentBrief: docBrief ?? undefined,
          // With no window in the context, the question is the only thing
          // left to match lore against — and it was always the better
          // target for a conversation anyway.
          extraMatchText: seedMatch,
          loreScope: useLoreStore.getState().scope,
        },
        null,
        memory,
        loreBudgetTokens * charsPerToken,
        MEMORY_BUDGET_CHARS,
      );
      // Three messages, not two: the seeded context and the question are
      // separate so the compaction pass can later drop the former without
      // the latter (docs/feature/agent/chat-memory-plan.md §3). The meta records which
      // message is which — by identity, because indices don't survive
      // repairToolCallPairing's splices.
      const seed = bundleToChatMessages(bundle, wireContent);
      history = seed.messages;
      const meta = createSessionMeta();
      meta.seedContext = seed.seedContext;
      meta.lastDocPath = activeFilePath ?? null;
      meta.bodyDocPath = wantsDocBody ? activeFilePath ?? null : null;
      meta.briefingTier = orchestrating ? "orchestrator" : "assist";
      meta.stateMode = get().chats[key]?.stateMemory ?? false;
      noteTurnStart(meta, seed.question);
      // The seeded lore goes in the injection ledger, carried by the seed
      // block — otherwise turn 2's retrieval would re-inject everything the
      // model was just given. Recorded from the report, so what is booked is
      // what was actually emitted: an entity whose body lost to the budget
      // stays eligible for it, and its facets are booked one by one.
      if (seed.seedContext) {
        recordInjectionsFromReport(
          meta, bundle.loreReport, useLoreStore.getState().index, seed.seedContext,
        );
      }
      patchChat(set, key, { history, meta });
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

      // ── Tier refresh (the roleplay refreshSystemPrompt pattern) ──
      // The system layer is read-once for *wording* (rosters, prompt edits),
      // but the briefing must not lie about the toolset: the orchestrator's
      // mandates every write go through run_pack, and routing removes that
      // tool the moment the Beta goes off — a stale briefing then steers the
      // model into "Unknown tool" on every write attempt (the reverse flip
      // teaches write tools the thin tier doesn't hold, and never teaches
      // run_pack). So when the tier flipped between turns, rewrite
      // history[0] in place with the current tier's full system layer.
      const tierNow = chatPreset === ORCHESTRATOR_PRESET ? "orchestrator" : "assist";
      const tierMeta = get().chats[key]?.meta ?? null;
      if (tierMeta && tierMeta.briefingTier !== tierNow && history[0]?.role === "system") {
        history[0].content = await chatSystemPrompt(projectPath, tierNow === "orchestrator");
        tierMeta.briefingTier = tierNow;
        patchChat(set, key, { history });
        bumpContext();
      }

      // ── Compaction (docs/feature/agent/chat-memory-plan.md §4) ──
      // Between turns, before this turn's question goes in: if the history
      // has outgrown the trigger, fold the oldest turns into the rolling
      // summary. Best-effort — a failed summarize returns null and the turn
      // proceeds on the uncompacted history (trimHistory still backstops
      // mid-turn); only an abort propagates. The event lands in this turn's
      // log so the author sees what was folded and can read the summary.
      //
      // 自动归纳 off (设置 → 上下文与记忆) skips this step entirely; 立即归纳
      // (compactChatNow) is then the only fold, and trimHistory the only
      // backstop. The trigger is the lowest of the author's two lines and
      // the classic one — docs/feature/agent/compact-threshold-plan.md §B.0.
      const meta = get().chats[key]?.meta ?? null;
      // ── 状态记忆 (docs/feature/agent/skill-state-memory-plan.md) ──
      // With the mode on for this conversation (and the Beta still on), the
      // fold is not a threshold event: every turn before the last one is
      // folded into the structured execution state, whatever the bar reads.
      // Best-effort like compaction — a model that twice returns something
      // the schema refuses leaves the history as it was, and the ordinary
      // threshold fold below then still backstops it, so the conversation
      // cannot grow without bound on a model that can't keep the state.
      let stateFolded = false;
      if (meta && meta.stateMode && isSkillStateEnabled()) {
        const updated = await updateSkillState({
          history,
          meta,
          ceilingTokens: messageCeiling,
          update: (input) =>
            requestStateUpdate(
              connOptions({ provider, model, apiKey }),
              input,
              controller.signal,
            ),
        });
        if (updated) {
          stateFolded = true;
          history = updated.history;
          patchChat(set, key, { history });
          bumpContext();
          patchAssistant((tn) => ({ ...tn, log: appendAgentEventTo(tn.log, updated.event) }));
        }
      }
      if (meta && autoCompact && !stateFolded) {
        const compacted = await compactChatHistory({
          history,
          meta,
          ceilingTokens: messageCeiling,
          triggerTokens: compactTriggerFor({
            contextSize: model.contextSize,
            messageCeiling,
            triggerTokens: compactTriggerTokens,
            triggerRatio: compactTriggerRatio,
          }).tokens,
          summarize: (input) =>
            summarizeForCompaction(
              connOptions({ provider, model, apiKey }),
              input,
              controller.signal,
            ),
        });
        if (compacted) {
          history = compacted.history;
          patchChat(set, key, { history });
          bumpContext();
          patchAssistant((tn) => ({ ...tn, log: appendAgentEventTo(tn.log, compacted.event) }));
        }
      }

      // ── Per-turn injection (docs/feature/agent/chat-memory-plan.md §5) ──
      // The seed's retrieval, re-run against *this* question, minus what the
      // ledger says is already in the conversation. Nothing net-new appends
      // nothing: the history stays append-only, so the prompt-cache prefix
      // survives.
      //
      // Two independent reasons to say something about the document here.
      // A **switch** onto another file always sends at least its brief —
      // the assistant has to know where the author is, even on a turn that
      // has nothing to do with the manuscript. And a turn that *points* at
      // the document ("把这一段…") sends the window, however many turns ago
      // the file was opened — this is where the deferred body lands when the
      // seed described the file instead of injecting it.
      if (meta) {
        const docSwitched = !!activeFilePath && !isSamePath(activeFilePath, meta.lastDocPath);
        const needsBody = wantsDocBody && !!activeFilePath
          && !isSamePath(activeFilePath, meta.bodyDocPath);
        const memory = needsBody && docModel().memory && activeFilePath
          ? await loadMemory(projectPath, activeFilePath)
          : null;
        const loreIdx = useLoreStore.getState().index;
        const { loreBudgetTokens } = useAppStore.getState();
        // Same expansion as the seed, per turn: the question changes every
        // turn, and 「那根杖呢」 is exactly the sort of turn whose words reach
        // nothing on their own.
        const turnTerms = await expandForRetrieval(wireMessage, controller.signal);
        const inj = await assembleTurnInjection({
          loreIndex: loreIdx,
          // Same match targets as the seed: the question (with its quote and
          // @refs inlined) plus the document's tail neighborhood.
          matchTarget: wireMessage + focus.text.slice(-500)
            + (turnTerms.length ? `\n${turnTerms.join(" ")}` : ""),
          // Per layer, not per entity: an entity already introduced keeps
          // its body out of the wire and still brings a facet the author
          // has just asked about ("他那件外套") — which entity-level
          // exclusion made unreachable for the rest of the session.
          coreDone: coreDoneFor(meta, loreIdx),
          excludeFacets: injectedFacetsFor(meta, loreIdx),
          scope: useLoreStore.getState().scope,
          loreBudgetChars: loreBudgetTokens * measureCharsPerToken(focus.text),
          doc: (docSwitched || needsBody) && activeFilePath
            ? {
                filePath: docRelPath ?? activeFilePath,
                // Only on a switch: mid-conversation the file was described
                // when it was opened, and repeating that costs the append-only
                // history for nothing.
                brief: docSwitched ? docBrief : null,
                body: needsBody
                  ? {
                      documentText: focus.text,
                      memory,
                      contextChars: RECENT_WINDOW_MIN_CHARS,
                      memoryBudgetChars: MEMORY_BUDGET_CHARS,
                    }
                  : null,
              }
            : null,
        });
        if (inj.text) {
          const injMsg: StreamMessage = { role: "user", content: inj.text };
          history.push(injMsg);
          recordInjectionsFromReport(meta, inj.loreReport, loreIdx, injMsg);
          if (docSwitched) meta.lastDocPath = activeFilePath;
          if (needsBody) meta.bodyDocPath = activeFilePath;
          patchAssistant((tn) => ({
            ...tn,
            log: appendAgentEventTo(tn.log, {
              kind: "context-seeded",
              documentName: (docSwitched || needsBody) && activeFilePath
                ? (activeFilePath.split(/[\\/]/).pop() ?? "").replace(/\.md$/i, "")
                : null,
              recentChars: inj.docChars,
              memoryChars: inj.memoryChars,
              // 只数真的贡献了文字的条目：正文已常驻、这一轮又没有新特征的
              // 条目照样会进报告，把它们算进去等于告诉作者注入了并不存在的东西。
              loreEntities: contributingEntities(inj.loreReport).length,
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
    // The chat assistant is the one surface that hands its ending to the
    // writer today (docs/feature/agent/writer-subagent-plan.md). Opting in
    // here rather than on the preset is what keeps AiPanel's Agent mode —
    // which runs the very same preset object — out of it.
    const routed = routeTools(
      chatPreset, effectiveSubs, tw, useAiStore.getState().models,
      // askAuthor: the question card renders in the approvals area below.
      // packs: chat is the surface that threads the approval channels and
      // selfConn through ToolContext — see run_pack's guards (agent/packs).
      { handoff: true, askAuthor: true, packs: true },
    );
    const effectivePreset = {
      ...chatPreset,
      tools: routed.tools,
      serverTools: routed.serverTools,
      finishPolicy: routed.finishPolicy,
    };
    /**
     * The slice of the system layer the writer inherits — the author's own
     * writing prompt, which is where the project's vocabulary lives.
     *
     * Recomputed per turn rather than reused from the seed above: that branch
     * only runs on the first turn of a session, and the author can switch
     * prompts at any point. Deliberately NOT the seeded `systemPrompt`, which
     * also carries the agent briefing, the workflow roster and the docx
     * presets — tool-loop machinery a writer with no tools would only be
     * confused by.
     */
    const writerSystem = (() => {
      const { prompts, activePromptId } = useAiStore.getState();
      return prompts.find((pr) => pr.id === activePromptId)?.content ?? profileSystemPrompt();
    })();

    // 和这个文件里其它每一处一样动态取——agentStore ↔ projectStore 是一个循环，
    // 静态 import 会在模块求值期炸掉。
    const { loreOrganizer } = await import("./projectStore");

    const { inputTokens, outputTokens, cachedTokens, outcome } = await runAgent({
      ...connOptions({ provider, model, apiKey }),
      // Never undefined: without a ceiling the tool loop's history trimming
      // is a no-op, and a chat that reads pictures accumulates base64 in a
      // history that persists across turns until the provider rejects it.
      inputCeilingTokens: messageCeiling,
      preset: effectivePreset,
      messages: history,
      writerSystem,
      toolContext: {
        projectPath,
        // Live index — a lore write in turn N is visible to turn N+1 because
        // onLoreChanged below *awaits* its rescan. runAgent clones this for
        // the run, so the tools' in-place patches never reach store state.
        loreIndex: useLoreStore.getState().index,
        loreScope: useLoreStore.getState().scope,
        organize: loreOrganizer(),
        multimodal: model.type === "multimodal",
        onLoreChanged: async () => {
          await useLoreStore.getState().scanProject(projectPath);
          // Re-read rather than returning scanProject's own result: if a
          // later scan won the store's queue, that is the one we want.
          return useLoreStore.getState().index;
        },
        onMemoryChanged: () => {
          void import("./memoryStore").then((m) =>
            m.useMemoryStore.getState().loadForActiveFile(),
          );
        },
        requestApproval: (p, onApplyProgress) =>
          get().requestApproval(p, controller, {
            turnId: assistantTurnId,
            signal: controller.signal,
            onApplyProgress,
            // Not the controller: 本次对话都批准 has to outlive the turn it
            // was pressed in, which is the whole point of the button. Per
            // conversation, so two open ones cannot cover each other.
            autoApproveKey: chatAutoApproveKey(key),
            // The card renders in THIS conversation's tab and no other —
            // lib/agent/approvalRouting, and the plan's §4.4.
            surface: chatSurface(key),
          }),
        requestPlanApproval: (p) =>
          get().requestPlanApproval(p, controller, chatAutoApproveKey(key), chatSurface(key)),
        askAuthor: (q) => get().requestQuestion(q, controller, chatSurface(key)),
        // One gate per turn: a plan the author approved for *this* request
        // does not silently authorise the next one.
        lorePlan: createPlanGate(),
        // ...unlike the workspace, which is per SESSION — see chatTaskWorkspace.
        taskWorkspace: tw,
        resolveSubAgent: (k) => {
          const { models: allModels, providers: allProviders } = useAiStore.getState();
          return resolveSubAgentConn(k, allModels, allProviders, effectiveSubs, loadApiKey);
        },
        // The run's own conn + the author's utilization setting, for
        // run_pack's nested run (packs run the parent's model — D1).
        selfConn: { provider, model, apiKey },
        contextUtilization,
      },
      signal: controller.signal,
      // At the round cap, block on the author's 继续/收尾/存盘暂停 card instead of
      // force-ending. Each 继续 grants the preset's own cap again.
      // The card can render here (the approvals area is right above the
      // composer), so repeated truncation becomes a question instead of a
      // silent stop.
      onTruncationLimit: (recoveries) =>
        get().requestTruncationDecision(recoveries, controller, chatSurface(key)),
      onRoundLimit: (roundsUsed) =>
        get().requestRoundExtension(
          roundsUsed, chatPreset.maxRounds, controller,
          // Evaluated here, at the cap — not at run start. A workspace the
          // model created three rounds ago counts; pausing with nothing on
          // disk would throw the turn away, since pause keeps only what was
          // written down.
          !!tw.taskId,
          chatSurface(key),
        ),
      // Every runtime event marks a point where the history just grew (a
      // round's messages, a tool reply) or shrank (trimHistory) — which is
      // exactly the cadence the context bar wants to redraw at. Except
      // reasoning: it is re-emitted per streamed *fragment*, and the history
      // only takes the round's messages when the round ends — bumping here
      // made the context bar re-walk the entire wire history (a CJK regex
      // over every message) dozens of times per second while a model thought.
      onEvent: (event) => {
        if (event.kind === "reasoning") {
          // Latest-wins per (parentStep, round) — a fragment for a *new*
          // stream must not overwrite a buffered one from the previous, so
          // flush across the boundary (in practice a round-start or
          // tool-step always sits between, but this doesn't rely on it).
          if (
            pendingReasoning &&
            (pendingReasoning.parentStep !== event.parentStep ||
              pendingReasoning.round !== event.round)
          ) {
            stream.flush();
          }
          pendingReasoning = event;
          stream.schedule();
          return;
        }
        // Ordering barrier: buffered text/reasoning land before this event.
        stream.flush();
        patchAssistant((tn) => ({ ...tn, log: appendAgentEventTo(tn.log, event) }));
        bumpContext();
      },
      // Assign, not append — the runtime hands over the whole output each
      // time so it can retract a tool round's narration.
      onOutputText: (text) => {
        pendingText = text;
        stream.schedule();
      },
    });
    // The turn is over; whatever the throttle still holds is the final text.
    stream.flush();

    if (outcome === "paused") {
      const pausedId = get().chats[key]?.taskWorkspace?.taskId;
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
    patchChat(set, key, (c) => ({
      usage: {
        inputTokens: (c.usage?.inputTokens ?? 0) + inputTokens,
        outputTokens: (c.usage?.outputTokens ?? 0) + outputTokens,
        cost: (c.usage?.cost ?? 0) + cost,
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
    // Whatever streamed before the failure is still the author's to read.
    stream.flush();
    if ((e as Error).name !== "AbortError" && get().chatAborts[key] === controller) {
      const msg = String(e);
      patchChat(set, key, { error: msg });
      recordRunOutcome(model.id, msg);
      patchAssistant((tn) => ({
        ...tn,
        log: appendAgentEventTo(tn.log, { kind: "run-error", message: msg, at: Date.now() }),
      }));
    }
  } finally {
    // Drain this turn's own approvals — never another run's.
    get().rejectAll("task ended", controller);
    if (get().chatAborts[key] === controller) {
      set((s) => {
        const chatAborts = { ...s.chatAborts };
        delete chatAborts[key];
        return { runningChats: s.runningChats.filter((k) => k !== key), chatAborts };
      });
      // Only on this guard: a turn the author stopped has no news worth an
      // OS notification (stopChat released the slot before we got here).
      const failure = get().chats[key]?.error ?? null;
      // Finished while the author was on another tab: mark it, so the tab
      // says so until they look (activateChat clears it).
      if (get().activeChatKey !== key) patchChat(set, key, { unread: true });
      notify(
        "done",
        i18n.t(failure ? "notify.failedTitle" : "notify.doneTitle"),
        failure
          ? i18n.t("notify.chatFailed", { error: failure })
          : i18n.t("notify.chatDone"),
      );
    }
    // Save after every turn, success or failure — the crash that loses a
    // session never announces itself first.
    void get().persistChat(key);
    // The slot is free: the next queued conversation may start.
    pump(set, get);
  }
}

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

// ─── Read side for components ────────────────────────────────────────────────

const FALLBACK_CHAT: LiveChat = Object.freeze(emptyChat("")) as LiveChat;

/**
 * The conversation on screen. The invariant is that `activeChatKey` always
 * names an open one; the fallbacks are belt-and-braces so a render mid-update
 * never sees undefined.
 */
export function activeChat(s: AgentState): LiveChat {
  return s.chats[s.activeChatKey] ?? s.chats[s.chatOrder[0]] ?? FALLBACK_CHAT;
}

/**
 * Narrow selector over the active conversation — the seam that lets AgentChat
 * and the composer chips keep their per-field subscriptions after the store
 * went multi-session (plan §4.1).
 */
export function useActiveChat<T>(selector: (c: LiveChat) => T): T {
  return useAgentStore((s) => selector(activeChat(s)));
}

/**
 * The slices every per-conversation state helper below reads. A component that
 * derives an *array* over several conversations (the switch guard's rows, the
 * history menu's 已打开 section) must not build it inside a `useAgentStore`
 * selector: a selector returning a fresh array on every call never compares
 * equal, and under useSyncExternalStore that is an infinite render loop (React
 * #185, seen on first paint in the packaged app). Subscribe to these slices by
 * reference through `useChatStateInputs` and compute in `useMemo` instead.
 */
export type ChatStateInputs = Pick<
  AgentState,
  | "chats" | "chatOrder" | "activeChatKey" | "chatSessions"
  | "runningChats" | "compactingChats" | "chatQueue"
  | "pending" | "pendingPlans" | "pendingQuestions" | "pendingRoundLimits" | "pendingTruncations"
>;

export const pickChatStateInputs = (s: AgentState): ChatStateInputs => ({
  chats: s.chats, chatOrder: s.chatOrder, activeChatKey: s.activeChatKey, chatSessions: s.chatSessions,
  runningChats: s.runningChats, compactingChats: s.compactingChats, chatQueue: s.chatQueue,
  pending: s.pending, pendingPlans: s.pendingPlans, pendingQuestions: s.pendingQuestions,
  pendingRoundLimits: s.pendingRoundLimits, pendingTruncations: s.pendingTruncations,
});

/** The slices above, shallow-compared so the subscription re-renders only when one of them moved. */
export function useChatStateInputs(): ChatStateInputs {
  return useAgentStore(useShallow(pickChatStateInputs));
}

/** The routing tag for one conversation's cards (lib/agent/approvalRouting). */
export function chatSurface(key: string): string {
  return `chat:${key}`;
}

/** Whether a card is blocking this conversation's run (any of the five kinds). */
export function chatWaiting(s: ChatStateInputs, key: string): boolean {
  const surface = chatSurface(key);
  return s.pending.some((p) => p.surface === surface)
    || s.pendingPlans.some((p) => p.surface === surface)
    || s.pendingQuestions.some((p) => p.surface === surface)
    || s.pendingRoundLimits.some((p) => p.surface === surface)
    || s.pendingTruncations.some((p) => p.surface === surface);
}

/** When the oldest card blocking this conversation landed, or null. */
export function chatWaitingSince(s: ChatStateInputs, key: string): number | null {
  const surface = chatSurface(key);
  const ats = [
    ...s.pending, ...s.pendingPlans, ...s.pendingQuestions,
    ...s.pendingRoundLimits, ...s.pendingTruncations,
  ].filter((p) => p.surface === surface).map((p) => p.at);
  return ats.length ? Math.min(...ats) : null;
}

/** The one mark a conversation's tab wears (lib/agent/chatState). */
export function chatStateOf(s: ChatStateInputs, key: string): ChatState | null {
  const c = s.chats[key];
  if (!c) return null;
  return chatState({
    running: s.runningChats.includes(key),
    queued: s.chatQueue.some((j) => j.key === key),
    waiting: chatWaiting(s, key),
    unread: c.unread,
    error: c.error !== null,
  });
}

/** The one mark the mode tab wears for every conversation together. */
export function mostUrgentChatState(s: ChatStateInputs): ChatState | null {
  return mostUrgent(s.chatOrder.map((k) => chatStateOf(s, k)));
}

/** 0-based position in the queue, or -1. */
export const chatQueuePosition = (s: ChatStateInputs, key: string) =>
  s.chatQueue.findIndex((j) => j.key === key);

export const isChatRunning = (s: ChatStateInputs, key: string) => s.runningChats.includes(key);
export const isChatCompacting = (s: ChatStateInputs, key: string) => s.compactingChats.includes(key);
export const isChatQueued = (s: ChatStateInputs, key: string) => s.chatQueue.some((j) => j.key === key);
/** Generating, folding or waiting for a slot — no new exclusive work may start. */
export const isChatBusy = (s: ChatStateInputs, key: string) =>
  ownerBusy(key, s.runningChats, s.compactingChats, s.chatQueue);
