import { create } from "zustand";
import i18n from "../i18n";
import { streamCompletion } from "../lib/ai";
import {
  assembleContext, bundleToMessages, profileSystemPrompt, resolveAppendAnchor,
  type TaskExtras,
} from "../lib/context/rag";
import { docModel, findTask, promptParams } from "../lib/profile/active";
import { presetForTools } from "../lib/agent/presets";
import { runAgent } from "../lib/agent/runtime";
import {
  ASSUMED_INPUT_CEILING_TOKENS, fixedContextChars, measureCharsPerToken, planContextBudget,
  reflowMemoryBudget, type ContextAllocation,
} from "../lib/context/budget";
import { BOOK_PREV_TAIL_CHARS, buildBookContext } from "../lib/context/bookContext";
import { hashText, loadMemory, projectRelativePath } from "../lib/context/memory";
import type { LoreActivationReport } from "../lib/context/loreSelect";
import type { StreamMessage } from "../lib/ai/types";
import { useAgentStore } from "./agentStore";
import { useAiStore } from "./aiStore";
import { draftCountFor, totalUsage, type Draft } from "../lib/ai/drafts";
import { costFor } from "../lib/ai/configDb";
import { persistUsage } from "../lib/ai/usage";
import { connOptions, resolveConn } from "../lib/ai/conn";
import { useAppStore } from "./appStore";
import { useLoreStore } from "./loreStore";
import { useProjectStore } from "./projectStore";
import { loadApiKey } from "../lib/keyStore";
import { recordRunOutcome } from "../lib/ai/modelHealth";
import {
  appendAgentEventTo, createServerToolLog, type AgentEvent, type ToolStep,
} from "../lib/agent/events";
import { createPlanGate } from "../lib/agent/plan";
import {
  createTaskWorkspace, markTaskPaused, recordSourceRef,
} from "../lib/agent/taskWorkspace";
import { routeTools } from "../lib/agent/routing";
import { resolveSubAgentConn } from "../lib/agent/subagent";

/**
 * A task id, as declared by the active profile's `tasks` (see lib/profile).
 *
 * Deliberately a plain string rather than a union of the built-in ids: which
 * tasks exist is profile data and only knowable at runtime. Resolve one with
 * `findTask()` — and handle the null, because an id can outlive the profile that
 * defined it (persisted panel state, an execution-log entry, a prompt template's
 * `scene`).
 */
export type TaskKind = string;
export type { AgentEvent, ToolStep };
// The draft vocabulary lives in lib/ai/drafts (it has to be reachable from both
// stores without a cycle); re-exported here so callers of the store don't have
// to know about the split.
export { MAX_DRAFTS, draftCountFor, totalUsage, type Draft, type TokenUsage } from "../lib/ai/drafts";

/**
 * Monotonic run counter, so draft ids are unique across runs.
 *
 * A React key reused between runs would let the framework treat the new run's
 * first draft as the old one re-rendered, keeping the previous scroll position
 * and any per-draft UI state.
 */
let runSeq = 0;

/** Zustand's setter, narrowed to what the draft helpers below need. */
type SetState = (fn: (state: AiTaskState) => Partial<AiTaskState>) => void;

/**
 * Apply a patch to one draft by id.
 *
 * By id rather than index because N streams land out of order and a run can be
 * replaced mid-flight: an index into a `drafts` array that has since been
 * swapped for the next run's would write into the wrong draft. An id that is no
 * longer present is a no-op, which is exactly right for a stale stream.
 */
function patchDraft(set: SetState, id: string, patch: Partial<Draft>): void {
  set((s) => ({
    drafts: s.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)),
  }));
}

/** Append streamed text to one draft. Separate from `patchDraft` because it has
 *  to read the previous text inside the same atomic update. */
function appendDraftText(set: SetState, id: string, text: string): void {
  set((s) => ({
    drafts: s.drafts.map((d) => (d.id === id ? { ...d, text: d.text + text } : d)),
  }));
}

/** Source-document offsets for the committed selection, when known (editor
 *  mode). Null in preview mode where only rendered text is available. */
export interface SelectionRange { from: number; to: number; }

interface AiTaskState {
  isRunning: boolean;
  /** This run's results, in request order. Empty before the first run. */
  drafts: Draft[];
  /** Which draft the output pane shows and the insert actions act on. */
  activeDraftId: string | null;
  /** Run-level failure (context assembly, aborted setup) — see `Draft.error`
   *  for one draft failing on its own. */
  error: string | null;
  selection: string;
  selectionRange: SelectionRange | null;
  /**
   * Where the committed target came from.
   *   - `marker` — explicitly marked in the editor. Offsets are maintained by
   *     CodeMirror and can be trusted verbatim, including for in-place replace.
   *   - `commit`  — captured from a drag selection at the moment the author
   *     acted on it. Editor-origin ones carry offsets; preview-origin ones are
   *     rendered text with none, and still need locating before use.
   * Null when nothing is committed. Only the owning source may clear the slot,
   * so a marker being dropped can't wipe a selection the toolbar just made.
   */
  selectionSource: "marker" | "commit" | null;
  /** Task the floating toolbar asked the panel to pre-select. Consumed + cleared by AiPanel. */
  requestedTask: TaskKind | null;
  /** Instruction to pre-fill alongside it — the toolbar's 自定义指令 box. */
  requestedInstruction: string | null;
  abortController: AbortController | null;
  /** Execution log for the current/last run — rounds, tool calls, outcome. */
  agentLog: AgentEvent[];
  /** Which lore entities/facets were injected (and why) for the current run. */
  loreReport: LoreActivationReport | null;
  /** Final per-layer allocation for the current run (see lib/context/budget). */
  contextAlloc: ContextAllocation | null;
  /**
   * The messages this run actually sent — what 查看完整提示 shows.
   *
   * The forecast bar says how the window *will* be divided; this is the only
   * place the author can read what the four layers resolved to, which is what
   * a refusal or an off-brief answer is usually explained by. Kept in memory
   * for the current run only: it is a debugging view of one request, not a
   * history, and a long context is megabytes.
   */
  lastMessages: StreamMessage[] | null;
  /**
   * The document this run's context was assembled from — null if none was
   * open. The current draft's text was generated for *this* file; if the
   * author has since switched to a different one, applying it there would
   * silently splice one document's output into another. Set once, from the
   * same focus snapshot as the run itself, and never touched afterwards.
   */
  sourceFilePath: string | null;

  setSelection: (s: string, range?: SelectionRange | null, source?: "marker" | "commit") => void;
  /** Drop the committed target, but only if `source` is the one that set it. */
  clearSelectionFrom: (source: "marker" | "commit") => void;
  setRequestedTask: (kind: TaskKind | null, instruction?: string) => void;
  runTask: (kind: TaskKind, customInstruction?: string, continueLength?: number, extras?: TaskExtras) => Promise<void>;
  abort: () => void;
  clearOutput: () => void;
  setActiveDraft: (id: string) => void;
  appendAgentEvent: (event: AgentEvent) => void;
}

export const useAiTaskStore = create<AiTaskState>((set, get) => ({
  isRunning: false,
  drafts: [],
  activeDraftId: null,
  error: null,
  selection: "",
  selectionRange: null,
  selectionSource: null,
  requestedTask: null,
  requestedInstruction: null,
  abortController: null,
  agentLog: [],
  loreReport: null,
  contextAlloc: null,
  lastMessages: null,
  sourceFilePath: null,

  setSelection: (s, range = null, source = "commit") =>
    set({ selection: s, selectionRange: range, selectionSource: s ? source : null }),

  clearSelectionFrom: (source) =>
    set((state) =>
      state.selectionSource === source
        ? { selection: "", selectionRange: null, selectionSource: null }
        : state,
    ),
  setRequestedTask: (kind, instruction) =>
    set({ requestedTask: kind, requestedInstruction: kind ? instruction ?? null : null }),

  appendAgentEvent: (event) =>
    set((s) => ({ agentLog: appendAgentEventTo(s.agentLog, event) })),

  runTask: async (kind, customInstruction, continueLength, extras) => {
    if (get().isRunning) return; // one task at a time — UI disables triggers, this guards races
    const { activeModelId, activePromptId, models, providers, prompts } = useAiStore.getState();
    const { projectPath } = useProjectStore.getState();
    const { index: loreIndex } = useLoreStore.getState();

    if (!projectPath) { set({ error: i18n.t("ai.errors.noProject") }); return; }

    const resolved = resolveConn(models, providers, activeModelId);
    if (!resolved.ok) { set({ error: resolved.error }); return; }
    const { model, provider } = resolved;

    // Everything below reads the task's *definition* rather than testing its id,
    // so a profile can offer any number of tasks. An id the active profile
    // doesn't define is a real case (persisted panel state surviving a profile
    // switch), not a defensive branch.
    const task = findTask(kind);
    if (!task) { set({ error: i18n.t("ai.errors.taskNotFound", { task: kind }) }); return; }

    // System prompt: user-selected prompt (scene === "system"), else default
    const prompt = prompts.find((p) => p.id === activePromptId);
    const systemPrompt = prompt?.content ?? profileSystemPrompt();

    // Snapshot the writing focus and the committed selection together, here —
    // before the keyring read below and every other await further down (memory
    // load, book-context build) gives the author a window to switch files or
    // change the selection mid-setup. Use nothing else for the rest of the
    // run: file identity, text, and selection all come from this one atomic
    // read, never re-fetched via get(). (Lazy import — avoids a store cycle.)
    const { getWritingFocus } = await import("./editorStore");
    const focus = getWritingFocus();
    const documentText = focus.text;
    const activeFilePath = focus.filePath;
    const selection = get().selection;
    const selectionRange = get().selectionRange;
    if (!focus.settled) { set({ error: i18n.t("ai.errors.focusNotReady") }); return; }

    // Story memory for the focused document (前情提要 layer). Read from disk so
    // manual edits to the memory file are picked up; null when none exists.
    //
    // Skipped entirely when the profile's documents don't use rolling memory —
    // a null here is what makes every downstream layer (the budget's hasMemory,
    // assembleContext's 前情提要) drop out on its own.
    const docs = docModel();
    const memory = docs.memory && activeFilePath
      ? await loadMemory(projectPath, activeFilePath)
      : null;

    // ── Instruction ─────────────────────────────────────────────────────────
    // A user prompt template whose `scene` matches the task id replaces the
    // built-in text — for **every** task, freeform included. A domain task's
    // prompt (生成遭遇, 随机表) is exactly the thing an experienced author wants
    // to tune, and it used to be the one kind that couldn't be: freeform tasks
    // skipped the lookup entirely.
    //
    // What "replaces" means still depends on the task: a freeform task's text is
    // a *prefix* that the author's own ask follows, which is how Agent mode gets
    // its briefing without losing the request. So an override swaps the briefing,
    // not the request.
    const scenePrompt = prompts.find((p) => p.scene === task.id);
    const builtIn = scenePrompt?.content
      ?? (task.instructionKey
        // `length` is only consumed by the continuation prompt; the profile's
        // terms/section labels serve any template mentioning 【{{knowledge}}】
        // or {{doc}}. Unused params are harmless.
        ? i18n.t(task.instructionKey, {
            length: continueLength ?? 500,
            ...promptParams(i18n.language === "zh-CN"),
          })
        : "");
    let instruction: string;
    if (task.freeform) {
      const ask = customInstruction ?? "";
      instruction = builtIn ? `${builtIn}\n\n${ask}` : ask;
    } else {
      instruction = builtIn;
    }
    // An empty document has no 【近期内容】 for the model to continue, so the last
    // prose in the prompt is whatever bridge got injected — and "continue from
    // where the text ends" then means "continue the previous chapter". Nothing in
    // the prompt otherwise says a new one is starting.
    if (task.continuation && documentText.trim() === "") {
      instruction += `\n\n${i18n.t("ai.instructions.continueNewChapter", promptParams(i18n.language === "zh-CN"))}`;
    }

    // ── Context budget ──────────────────────────────────────────────────────
    // Divide the model's window between the layers we can size: lore (the
    // author's explicit setting) and the two recap layers (whatever is left).
    // Must be planned *before* the book context is built — that build spends its
    // own budget. See lib/context/budget.ts.
    const { loreBudgetTokens, contextUtilization } = useAppStore.getState();
    const isContinue = !!task.continuation;
    // A continuation only gets the preceding documents when this project's
    // documents actually have a "preceding" — see DocModel.priorContext.
    const useBookContext = isContinue && docs.priorContext;
    // Where this request is anchored in the document — both the book-context
    // build and the recent-window budget measure backwards from here.
    //
    // The range is verified against the live text before it is trusted, the same
    // way assembleContext does: an offset only means something in the document it
    // was recorded in, and an anchor pointing past the end of *this* one makes
    // the book-context bridge decide "we're deep into the chapter" for a file the
    // author just opened. Anything that doesn't check out falls back to the end
    // of the document, which is where a continuation belongs anyway.
    const anchorRange = selectionRange;
    const anchorValid =
      !!anchorRange &&
      anchorRange.to <= documentText.length &&
      documentText.slice(anchorRange.from, anchorRange.to) === selection;
    // Continue resolves through the shared anchor instead, so the budget window
    // and the book-context bridge measure from the very offset assembleContext
    // will slice from — and that the panel has already named for the author.
    const anchorOffset = isContinue
      ? extras?.appendAnchor ?? resolveAppendAnchor(documentText, selection, anchorRange)
      : anchorValid ? anchorRange!.to : documentText.length;
    const plan = planContextBudget({
      contextSize: model.contextSize,
      maxOutputTokens: model.maxOutput,
      utilization: contextUtilization,
      loreBudgetTokens,
      fixedChars: fixedContextChars({
        systemPromptChars: systemPrompt.length,
        taskInstructionChars: instruction.length,
        // Continue never sends the selection as its own 【选中内容】 block (see
        // assembleContext's append mode) — it is an anchor, and its characters
        // reach the model only as part of 【近期内容】, which is a *plannable*
        // layer with its own budget. Billing them here as a fixed cost too
        // charges the same text twice and shrinks every other layer for it.
        selectionChars: isContinue ? 0 : selection.length,
        outlineChars: extras?.outline?.length,
        knowledgeChars: extras?.additionalKnowledge?.length,
        prevChapterTailChars: useBookContext ? BOOK_PREV_TAIL_CHARS : 0,
      }),
      // Undefined for continue/custom (no picker) → the planner grows the
      // verbatim window with the model. Polish/rewrite/summary pass the author's
      // explicit 「参考上下文范围」 choice, which is honored as-is.
      recentWindowChars: extras?.contextChars,
      availableRecentChars: Math.max(0, anchorOffset),
      hasMemory: !!memory && memory.segments.length > 0,
      includeBookContext: useBookContext,
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
    if (useBookContext && activeFilePath) {
      try {
        const { fileTree } = useProjectStore.getState();
        const bookContext = await buildBookContext(
          projectPath, fileTree, activeFilePath, anchorOffset, plan.bookPriorChars,
          extras?.bridgeChapter,
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

    // How many independent completions to produce. Assembled context is shared,
    // so this only multiplies the sampling, not the context work.
    const draftCount = draftCountFor(task, useAppStore.getState().draftCount);
    const drafts: Draft[] = Array.from({ length: draftCount }, (_, i) => ({
      id: `${runSeq++}-${i}`,
      index: i + 1,
      text: "",
      usage: null,
      error: null,
      done: false,
      truncated: false,
    }));

    const controller = new AbortController();
    set({
      isRunning: true, drafts, activeDraftId: drafts[0].id,
      error: null, agentLog: [], loreReport: null, lastMessages: null,
      sourceFilePath: activeFilePath,
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

    const loreBudgetChars = plan.loreChars;

    // Having tools *is* what makes a run agentic — see presetForTools.
    const preset = presetForTools(task.tools);
    const isAgentic = preset !== null;
    // Only a task that can browse the project needs to know which file it is
    // looking at; for a toolless one the block is dead weight. Project-relative,
    // because that is the shape the read tools report and accept.
    const currentFilePath = isAgentic && activeFilePath
      ? projectRelativePath(projectPath, activeFilePath) ?? undefined
      : undefined;
    get().appendAgentEvent({
      kind: "run-start",
      task: kind,
      modelName: model.name || model.modelId,
      agentic: isAgentic,
      at: Date.now(),
    });

    try {
      const apiKey = await loadApiKey(provider.id) ?? "";
      const conn = connOptions({ provider, model, apiKey });

      if (isAgentic) {
        // ── Agentic mode: AI reads (and, in agent mode, writes) via tools ──
        // Continue is append-mode: any selection is an anchor to write *after*,
        // never an edit target — so no 【选中内容】 block is sent. Agent mode
        // keeps the selection as context for the user's instruction.
        const bundle = await assembleContext(
          systemPrompt,
          loreIndex,
          documentText,
          selection,
          instruction,
          isContinue
            ? { ...extras, ...bookExtras, appendMode: true, contextChars: plan.recentWindowChars, currentFilePath }
            : { ...extras, contextChars: plan.recentWindowChars, currentFilePath },
          selectionRange,
          memory,
          loreBudgetChars,
          memoryBudgetChars,
        );
        // Guarded like the catch/finally below: assembleContext's per-facet
        // disk reads can resolve after the author has already aborted and
        // re-run, and an unguarded set() here would overwrite the new run's
        // lore report with the aborted one's.
        const agentMessages = bundleToMessages(bundle);
        if (get().abortController === controller) {
          set({ loreReport: bundle.loreReport, lastMessages: agentMessages });
        }

        // Hoisted out of toolContext: the round-cap card and the paused
        // handler below both need to ask it whether anything was written.
        const workspace = createTaskWorkspace(projectPath, model.id);
        const subAgents = useAiStore.getState().subAgents;
        const routed = routeTools(preset!, subAgents, workspace, models);
        const effectivePreset = {
          ...preset!,
          tools: routed.tools,
          serverTools: routed.serverTools,
        };

        const { inputTokens, outputTokens, cachedTokens, outcome } = await runAgent({
          ...conn,
          // `plan.inputCeilingTokens` is 0 on a static plan (model declared no
          // context size), and a 0 ceiling disables history trimming entirely.
          inputCeilingTokens: plan.inputCeilingTokens || ASSUMED_INPUT_CEILING_TOKENS,
          // Non-null on this branch — isAgentic is exactly `preset !== null`.
          preset: effectivePreset,
          messages: agentMessages,
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
            // L2 approvals: the AiPanel card resolves these (agent mode only —
            // continue's preset has no propose_edit). Scoped to this run's own
            // controller so an unrelated chat turn ending doesn't drain them.
            // No turnId: the panel has no transcript to attach a picture to.
            requestApproval: (p) =>
              useAgentStore.getState().requestApproval(p, controller, { signal: controller.signal }),
            // Lore changes are gated on an approved plan; the gate is per-run,
            // so each task starts with a clean slate.
            requestPlanApproval: (p) => useAgentStore.getState().requestPlanApproval(p, controller),
            lorePlan: createPlanGate(),
            // Disk workspace for the scratchpad tools. Per-run here (a panel
            // task is one job, start to finish) rather than per-session as in
            // chat. Lazy: nothing is written unless the model actually files a
            // plan or a note, so short tasks leave no directory behind.
            taskWorkspace: workspace,
            resolveSubAgent: (k) => {
              const { models, providers, subAgents: subs } = useAiStore.getState();
              return resolveSubAgentConn(k, models, providers, subs, loadApiKey);
            },
          },
          signal: controller.signal,
          // At the round cap, block on the AiPanel's 继续/收尾 card instead of
          // force-ending. Skipped during a batch run: the batch modal covers
          // the panel, and a card nobody can see would hang the whole sweep.
          onRoundLimit: async (roundsUsed) => {
            // Must stay dynamic: batchStore imports this module at the top
            // level, so a static import back would close the cycle.
            const { useBatchStore } = await import("./batchStore");
            if (useBatchStore.getState().running) return { action: "finish" };
            return useAgentStore
              .getState()
              .requestRoundExtension(
                roundsUsed, preset!.maxRounds, controller,
                // Offer 存盘暂停 only once there is something on disk to resume
                // from — pausing discards the wire history and keeps only what
                // the model wrote down.
                !!workspace.taskId,
              );
          },
          // Guarded: abort() resets isRunning/abortController synchronously,
          // without waiting for this run's in-flight promise to actually
          // unwind, so the author can already be a round or two into a new
          // run by the time an aborted run's tool loop notices the signal.
          // Unguarded, this event stream would keep appending the old run's
          // rounds/tool-steps into the new run's fresh agentLog.
          onEvent: (event) => {
            if (get().abortController === controller) get().appendAgentEvent(event);
          },
          // Always the single draft — draftCountFor pins tool-using tasks to 1.
          // Assigned rather than appended: the runtime sends the whole output
          // each time so it can drop a tool round's narration. patchDraft is
          // id-keyed and already a no-op once this run's draft id is gone, so
          // it needs no separate guard.
          onOutputText: (text) => patchDraft(set, drafts[0].id, { text }),
        });

        // The author chose 存盘暂停 at the round cap. The wire history is
        // discarded, so what survives is whatever the model wrote to disk —
        // mark it paused there and let the execution log explain the ending.
        // Without this the run would just stop with no draft and no reason.
        if (outcome === "paused" && workspace.taskId) {
          await markTaskPaused(projectPath, workspace.taskId);
          const rel = activeFilePath ? projectRelativePath(projectPath, activeFilePath) : null;
          if (rel) {
            await recordSourceRef(
              projectPath, workspace.taskId,
              rel,
              hashText(focus.text),
            );
          }
        }
        const cost = costFor(model, inputTokens, outputTokens, cachedTokens);
        patchDraft(set, drafts[0].id, { usage: { inputTokens, outputTokens, cost }, done: true });
        if (get().abortController === controller) {
          get().appendAgentEvent({ kind: "run-done", inputTokens, outputTokens, at: Date.now() });
        }
        void persistUsage(projectPath, model.id, inputTokens, outputTokens, cost, kind, cachedTokens);
      } else {
        // ── Simple streaming: polish / rewrite / summary / custom / Gemini ─
        const bundle = await assembleContext(
          systemPrompt,
          loreIndex,
          documentText,
          selection,
          instruction,
          { ...extras, contextChars: plan.recentWindowChars },
          selectionRange,
          memory,
          loreBudgetChars,
          memoryBudgetChars,
        );
        const messages = bundleToMessages(bundle);
        if (get().abortController === controller) {
          set({ loreReport: bundle.loreReport, lastMessages: messages });
        }

        // One request per draft, all sharing this run's AbortController so a
        // single abort() stops every stream. The context above was assembled
        // once: the drafts differ only by the model's own sampling, which is the
        // point — N takes on the *same* brief.
        const results = await Promise.allSettled(
          drafts.map((draft) => {
            // One per draft: each request is its own stream, and the searches
            // it triggers are its own. Round 1 for all of them — a single-shot
            // task has no rounds, and the log's round chip reads as "the one
            // request this was".
            const logServerTool = createServerToolLog(1);
            return streamCompletion({
              ...conn,
              messages,
              signal: controller.signal,
              onChunk: (chunk) => {
                if ("turnResumed" in chunk) {
                  if (get().abortController === controller) {
                    get().appendAgentEvent({
                      kind: "turn-resumed",
                      round: 1,
                      leg: chunk.turnResumed.leg,
                      final: chunk.turnResumed.final,
                      at: Date.now(),
                    });
                  }
                } else if ("serverTool" in chunk) {
                  // A search the endpoint ran inside this response. Nothing to
                  // execute — it is already done; the log is the whole point.
                  if (get().abortController === controller) {
                    get().appendAgentEvent(logServerTool(chunk.serverTool));
                  }
                } else if ("done" in chunk) {
                  const { inputTokens, outputTokens, truncated, cachedTokens } = chunk;
                  const cost = costFor(model, inputTokens, outputTokens, cachedTokens);
                  patchDraft(set, draft.id, {
                    usage: { inputTokens, outputTokens, cost },
                    done: true,
                    truncated: truncated ?? false,
                  });
                  // One row per draft: each is a separate billed call, and a
                  // single summed row would misreport the run's shape.
                  void persistUsage(projectPath, model.id, inputTokens, outputTokens, cost, kind, cachedTokens);
                } else if ("text" in chunk) {
                  appendDraftText(set, draft.id, chunk.text);
                }
              },
            });
          }),
        );

        // allSettled, not all: one draft being refused or filtered must not
        // discard the text the others already produced. Each failure is recorded
        // on its own draft; the run only counts as failed if every draft did,
        // which is re-raised below so the existing error handling applies.
        const failures: string[] = [];
        results.forEach((result, i) => {
          if (result.status !== "rejected") return;
          const reason = result.reason as Error;
          if (reason?.name === "AbortError") return;
          failures.push(String(reason));
          patchDraft(set, drafts[i].id, { error: String(reason), done: true });
        });
        // Surface the run total once, for the execution log's closing line.
        // Guarded: a superseded run's allSettled can resolve after a new run
        // has already replaced `drafts` and started its own agentLog.
        if (get().abortController === controller) {
          const total = totalUsage(get().drafts);
          if (total) {
            get().appendAgentEvent({
              kind: "run-done",
              inputTokens: total.inputTokens,
              outputTokens: total.outputTokens,
              at: Date.now(),
            });
          }
        }
        if (failures.length === drafts.length && failures.length > 0) {
          throw new Error(failures[0]);
        }
        // Land on a draft that actually has something to show. Guarded for
        // the same reason as above — get().drafts could already belong to a
        // newer run by the time this resolves.
        if (get().abortController === controller) {
          const firstUsable = get().drafts.find((d) => !d.error);
          if (firstUsable) set({ activeDraftId: firstUsable.id });
        }
      }
    } catch (e) {
      // Only surface errors while this task is still the current one — after
      // abort() + a quick re-run, this stale rejection must not clobber the
      // new task's state.
      if ((e as Error).name !== "AbortError" && get().abortController === controller) {
        set({ error: String(e) });
        get().appendAgentEvent({ kind: "run-error", message: String(e), at: Date.now() });
        // Remember a safety refusal against this model — the picker surfaces it
        // so "switch models" is an informed choice next time.
        recordRunOutcome(model.id, String(e));
      }
    } finally {
      if (!get().error) recordRunOutcome(model.id, null);
      // Drain this run's own approvals — a dangling Promise here would wedge
      // the next run's tool executor, but an unrelated chat turn's pending
      // card must not be touched.
      useAgentStore.getState().rejectAll("task ended", controller);
      // Same guard: abort() already cleared state, and a newer task may own it now.
      if (get().abortController === controller) {
        set({ isRunning: false, abortController: null });
      }
    }
  },

  abort: () => {
    const controller = get().abortController;
    controller?.abort();
    // Unblock a loop waiting on an approval card so the abort takes effect.
    useAgentStore.getState().rejectAll("aborted by user", controller);
    set({ isRunning: false, abortController: null });
  },

  clearOutput: () =>
    set({
      drafts: [], activeDraftId: null, error: null, agentLog: [],
      loreReport: null, lastMessages: null, sourceFilePath: null,
    }),

  setActiveDraft: (id) => set({ activeDraftId: id }),
}));

/**
 * A committed selection belongs to the document it was made in.
 *
 * Nothing else drops it — not a run, not a file switch — so opening another
 * chapter used to leave the previous chapter's passage as the live edit target:
 * the panel kept showing its selection card, polish/rewrite would run against
 * text that isn't in the open file (and, failing to locate it, append the result
 * to the end of the *new* chapter), and runTask's anchor pointed at an offset in
 * a document that is no longer loaded. Clearing on switch is the one place that
 * fixes all of those at once.
 */
useProjectStore.subscribe((state, prev) => {
  if (state.activeFilePath === prev.activeFilePath) return;
  const { selection, selectionRange } = useAiTaskStore.getState();
  if (selection || selectionRange) {
    useAiTaskStore.setState({ selection: "", selectionRange: null, selectionSource: null });
  }
});

