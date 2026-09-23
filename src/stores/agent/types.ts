/**
 * agentStore's types — the state shape, the pending-card kinds, a conversation's
 * turns and live state. Split out of `agentStore.ts` (docs/feature/code-structure-plan.md
 * P5) so the chat-job and selector modules beside it can name them without
 * importing the store; `agentStore` re-exports the public ones.
 */

import type { ChatSessionMeta } from "../../lib/agent/compact";
import type { ChatSessionRow } from "../../lib/agent/sessionDb";
import type { TurnExport } from "../../lib/agent/chatSession";
import type { WritingFocus } from "../openDocument";
import type { AgentEvent, ToolProgress } from "../../lib/agent/events";
import type { AutoApproveKind, AutoApproveState } from "../../lib/agent/autoApprove";
import type { SurfaceTagged } from "../../lib/agent/approvalRouting";
import type { LorePlan, PlanDecision } from "../../lib/agent/plan";
import type { TaskWorkspaceHandle } from "../../lib/agent/taskWorkspace";
import type { SubAgentConfig, SubAgentKind } from "../../lib/agent/subagentModel";
import type { RoundLimitDecision, TruncationDecision } from "../../lib/agent/runtime";
import type { ApprovalDecision, AskAnswer, AskQuestion, Proposal } from "../../lib/agent/registry";
import type { AttachedItem } from "../../lib/lore/aiTask";
import type { MessageContent, StreamMessage } from "../../lib/ai/types";
import type { ConnPair } from "../../lib/ai/conn";


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
interface ApprovalBinding {
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
  /**
   * Assistant turns: files this turn exported (Word today). Same contract as
   * `images` — written by the approval, never by the model.
   */
  exports?: TurnExport[];
}

/** Extras for a programmatically composed turn (today: resuming a task). */
interface SendChatOptions {
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
  /**
   * This conversation's scratch directory under `.ai-writer/tmp/chat/`, where
   * pasted pictures are written (lib/agent/chatStash). Null until the first
   * paste — not the row id, because a paste happens before the first send and
   * `sessionId` only exists after the first persist. Rides in the session
   * blob and in its own `chat_sessions.stash_id` column.
   */
  stashId: string | null;
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
  /** `wireMessage` with pictures named but not located — what lore matching reads (chatRefs). */
  matchText: string;
  composed: MessageContent;
  imagePaths: string[];
  /** The author's turn already on screen — what 取消排队 hands back to the composer. */
  userTurnId: string;
  /** The empty assistant turn already on screen, where the answer streams into. */
  assistantTurnId: string;
}

/** 换项目 while conversations are busy: the question put to the author (设计稿 02b 屏 1j). */
interface ProjectSwitchGuard {
  /** Where the author is going — a folder name, or null for "closing the project". */
  target: string | null;
  resolve: (leave: boolean) => void;
}

export interface AgentState {
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
   * conversation behind (设计稿 02b 屏 1j: the empty state says where it went).
   * Cleared by the next send or new tab.
   */
  lastClosedLabel: string | null;
  /** Non-null while 换项目 is waiting for the author's answer (设计稿 02b 屏 1j). */
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
   * The author ticked or unticked 「新会话默认打开」: every conversation that
   * has not started yet (no turn, no saved row) takes the new default, so the
   * blank tab on screen is a 新会话 too. Started ones keep what they have.
   * Called only from that checkbox — flipping the Beta itself must not
   * overwrite a value the author set by hand on a blank tab.
   */
  applyStateMemoryDefault: () => void;

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
  /** Author approved a counted batch of ordinary write commands for this run. */
  grantCommands: (key: unknown, runId: RunId, count: number) => void;
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
  /**
   * This conversation's scratch directory id, made on first use (a paste —
   * lib/agent/chatStash). Synchronous: the id exists before any byte is
   * written under it.
   */
  ensureChatStash: (key?: string) => string;

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
   * 取消排队: drop a conversation's queued sends and hand the first one's words
   * and chips back (for the composer). The conversation itself stays.
   */
  dequeueChat: (key: string) => { text: string; refs: AttachedItem[] } | null;
  /** 插到最前: this conversation's queued sends go to the head of the queue. */
  promoteChat: (key: string) => void;
  /**
   * 换项目 / 关闭项目 with conversations generating, queued or waiting: put the
   * question to the author once (设计稿 02b 屏 1j) and resolve with their answer.
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
   * Undo writes from a finished turn's plan ledger (设计稿 02h 1h / 1i). Every
   * attempt — done or refused — is appended to that turn's log and persisted,
   * so the ledger keeps saying what happened.
   */
  undoTurnWrites: (key: string, turnId: string, toolCallIds: string[]) => Promise<void>;
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
   * Resolves with the question's words and picture paths for the composer, or
   * null when the turn cannot be rewound to (see lib/agent/rewind for which
   * ones can).
   */
  rewindChat: (turnId: string, key?: string) => Promise<{ text: string; images: string[] } | null>;
  /**
   * Project open/close hook (projectStore calls this): stop every run, drop the
   * previous project's conversations from view, then restore the new project's
   * newest one.
   */
  resetChatForProject: (projectPath: string | null) => Promise<void>;
}
