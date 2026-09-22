/**
 * One chat turn's run, and the multi-conversation plumbing around it: opening
 * and restoring conversations, the job queue and its pump, and the resume seed
 * for a paused task. Split out of `agentStore.ts` (docs/feature/code-structure-plan.md
 * P5); the store calls these with its own `set` / `get`, so nothing here imports
 * the store.
 */

import i18n from "../../i18n";
import { coreDoneFor, createSessionMeta, injectedFacetsFor, noteTurnStart, recordInjectionsFromReport, compactTriggerFor } from "../../lib/agent/compact";
import { compactChatHistory, summarizeForCompaction } from "../../lib/agent/compactRun";
import { requestStateUpdate, updateSkillState } from "../../lib/agent/skillStateRun";
import { isSkillStateEnabled } from "../../lib/agent/stateFlag";
import { listChatSessions } from "../../lib/agent/sessionDb";
import type { ChatSnapshot } from "../../lib/agent/chatSession";
import { MAX_CONCURRENT_RUNS, nextRunnableJobIndex } from "../../lib/agent/scheduler";
import { appendAgentEventTo, type AgentEvent } from "../../lib/agent/events";
import { createStreamThrottle } from "../../lib/agent/streamThrottle";
import { chatAutoApproveKey } from "../../lib/agent/autoApprove";
import { createPlanGate } from "../../lib/agent/plan";
import { createTaskWorkspace, existingWorkspace, listTaskNotes, loadTaskDoc, markTaskPaused, recordSourceRef, type TaskWorkspaceHandle } from "../../lib/agent/taskWorkspace";
import { chatAgentPreset, ORCHESTRATOR_PRESET } from "../../lib/agent/packs";
import { routeTools } from "../../lib/agent/routing";
import { resolveSubAgentConn } from "../../lib/agent/subagentModel";
import { newChatStateMemory } from "../../lib/agent/stateFlag";
import { repairToolCallPairing, runAgent } from "../../lib/agent/runtime";
import { persistUsage } from "../../lib/ai/usage";
import { measureCharsPerToken, RECENT_WINDOW_MIN_CHARS } from "../../lib/context/budget";
import { messageCeilingFor } from "../../lib/agent/toolCost";
import { workflowBriefingSection } from "../../lib/workflow";
import { docxBriefingSection } from "../../lib/docx/briefing";
import { currentFormats } from "../docFormatStore";
import { useAiStore } from "../aiStore";
import { toolAppState } from "../toolAppState";
import { useLoreStore } from "../loreStore";
import {
  hashText, loadMemory, MEMORY_BUDGET_CHARS, projectRelativePath,
} from "../../lib/context/memory";
import { contributingEntities } from "../../lib/context/loreSelect";
import {
  assembleContext, assembleTurnInjection, bundleToChatMessages, profileSystemPrompt,
} from "../../lib/context/rag";
import { currentTimeLine } from "../../lib/context/clock";
import { docModel, promptParams } from "../../lib/profile/active";
import type { StreamMessage } from "../../lib/ai/types";
import { fileExists, readFile } from "../../lib/fs/fileio";
import { loadApiKey } from "../../lib/keyStore";
import { expandAuthorIntent } from "../../lib/context/expand";
import { recordRunOutcome } from "../../lib/ai/modelHealth";
import { canSeeImages, costFor } from "../../lib/ai/configDb";
import { connOptions } from "../../lib/ai/conn";
import { notify } from "../../lib/notify";
import { isSamePath } from "../../lib/paths";
import type { ChatTurn, LiveChat, ChatJob, AgentState } from "./types";


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
// ─── Multi-session plumbing ──────────────────────────────────────────────────

let chatKeyCounter = 0;
/** A tab's local identity. Never reused within a process, never persisted. */
export function newChatKey(): string {
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
 * A conversation the author is about to start. Same as `emptyChat` except for
 * the one switch whose starting point is a preference: 状态记忆 under its
 * 「新会话默认打开」 sub-option. Read at creation, not at module scope's leisure —
 * the Lab pane can flip it while the app runs (`applyStateMemoryDefault`).
 */
export function freshChat(key: string): LiveChat {
  return { ...emptyChat(key), stateMemory: newChatStateMemory() };
}

/**
 * A saved conversation as an open one. The chips say "this conversation", so
 * they start at default — a temporary switch is not worth a format change.
 * 状态记忆 IS stored in the blob (the restored history's shape was made by it),
 * so the chip must show what it is. Auto-approve is deliberately not
 * persisted either: standing authorisation to rewrite prose is the last thing
 * that should follow the author into another manuscript.
 */
export function chatFromSnapshot(
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

export type Set = (fn: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)) => void;
export type Get = () => AgentState;

/**
 * The one way a conversation's fields are written. A missing key is a closed
 * tab whose run is still unwinding — nothing to update, and nothing to crash.
 */
export function patchChat(
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
export function openSessionIds(s: AgentState): number[] {
  return s.chatOrder
    .map((k) => s.chats[k]?.sessionId)
    .filter((id): id is number => typeof id === "number");
}

export async function refreshSessionList(set: Set, get: Get): Promise<void> {
  const { useProjectStore } = await import("../projectStore");
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
export function noteCardFor(set: Set, get: Get, surface: string | undefined): void {
  if (!surface || !surface.startsWith("chat:")) return;
  const key = surface.slice("chat:".length);
  if (get().activeChatKey !== key) patchChat(set, key, { unread: true });
}

/** A conversation's standing grant ends with the conversation (close / reset). */
export function endGrantFor(set: Set, get: Get, key: string): void {
  if (get().autoApprove?.key === chatAutoApproveKey(key)) set({ autoApprove: null });
}

/**
 * The semaphore: while a slot is free, start the first queued job whose
 * conversation is not already generating or folding. Called from every path
 * that frees a slot or adds a job.
 */
export function pump(set: Set, get: Get): void {
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
  const { useAppStore } = await import("../appStore");
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

  const { withDirective } = await import("../../lib/agent/chatRefs");
  // 计划模式: repeated on every turn while the switch is on, not stated once.
  // The system layer is the only one that survives intact, and this mode is
  // toggled mid-conversation — so a one-time announcement would be buried by
  // turn three, exactly when the model decides whether this job needs a plan.
  // 当前时间 rides on the turn, never on history[0]: the system message is
  // the cache prefix of every later send, and a clock in it would invalidate
  // the whole conversation on each turn — see lib/context/clock.
  const stamped = withDirective(composed, currentTimeLine());
  const wireContent = get().chats[key]?.planMode
    ? withDirective(stamped, i18n.t("ai.instructions.planMode"))
    : stamped;

  // ── Is this turn about the document the author has open? ──
  // The chat used to answer "always" and seed its tail window into every
  // session. Most questions are not about the file that happens to be in the
  // editor, so the default is now the path plus a *brief* (title, length,
  // outline) and the assistant reads the file itself when it judges it
  // relevant. See lib/context/docFocus for what counts as pointing at the
  // document, and docs/feature/agent/chat-memory-plan.md §5a for why the line is drawn
  // where it is.
  const { documentBrief, wantsDocumentBody } = await import("../../lib/context/docFocus");
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
  // The open file's folder note (nearest index.md up the tree, and whether any
  // ancestor is deprecated) — one line in the brief, read on every turn because
  // the author may have just written it.
  const { nearestFolderNote } = await import("../../lib/fs/folderNote");
  const folder = activeFilePath ? await nearestFolderNote(projectPath, activeFilePath) : null;
  const docBrief = docRelPath
    ? documentBrief(focus.text, { withheld: !wantsDocBody, folder })
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
      // providers: whether the search subagent is live depends on what its
      // model's platform sends (serverToolsSent) — the turn asks the same.
      { handoff: true, packs: true, providers: useAiStore.getState().providers },
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
      // commands: same area renders the command card (lib/cli).
      // providers: the search model's wire decides whether it can read pages.
      { handoff: true, askAuthor: true, packs: true, commands: true, providers: useAiStore.getState().providers },
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
    const { loreOrganizer } = await import("../projectStore");

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
        multimodal: canSeeImages(model),
        appState: toolAppState,
        // 谁来读图，由 routeTools 一处判定（它同时也是摘掉 read_lore_image
        // 的那一处）。图集清单据此说出真正走得通的那条路。
        visionDelegate: routed.visionDelegate,
        searchReadsPages: routed.searchReadsPages,
        onLoreChanged: async (changed) => {
          // Those folders re-read when the write stayed inside them; the
          // whole walk only when what exists changed (see ToolContext).
          const lore = useLoreStore.getState();
          if (Array.isArray(changed)) await lore.refreshEntities(projectPath, changed);
          else if (changed) await lore.refreshEntity(projectPath, changed);
          else await lore.scanProject(projectPath);
          // Re-read rather than returning scanProject's own result: if a
          // later scan won the store's queue, that is the one we want.
          return useLoreStore.getState().index;
        },
        onMemoryChanged: () => {
          void import("../memoryStore").then((m) =>
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
        failure ? "error" : "done",
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
export async function workspaceForSnapshot(
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

/** The routing tag for one conversation's cards (lib/agent/approvalRouting). */
export function chatSurface(key: string): string {
  return `chat:${key}`;
}
