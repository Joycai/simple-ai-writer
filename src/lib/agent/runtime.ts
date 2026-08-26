/**
 * Unified agent runtime — the tool loop every AI task runs on.
 *
 * Generalized from the original "continue"-only loop (formerly loop.ts): the
 * task-specific parts — which tools, how many rounds, how the run must end —
 * now come from a TaskPreset, and tool calls dispatch through the registry
 * instead of a hardcoded switch. Progress is reported as structured AgentEvents
 * (events.ts) so the UI can render a live execution log.
 *
 * The runtime takes a seeded message history rather than a single user turn,
 * which is what stage-two conversational use builds on: append another user
 * message to the same history and call runAgent again.
 */

import i18n from "../../i18n";
import { streamCompletion } from "../ai";
import { pickConnOptions, type ConnOptions } from "../ai/conn";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { NativeReasoning } from "../ai/reasoning";
import type {
  AccumulatedToolCall, ContentPart, StreamMessage, ThinkingBlockCarry,
} from "../ai/types";
import {
  createServerToolLog, type AgentEvent, type RoundLimitDecision, type TruncationDecision,
} from "./events";

// Re-exported: callers reach the round-cap contract through the runtime that
// enforces it, not through the event module that only has to describe it.
export type { RoundLimitDecision, TruncationDecision };
import {
  collectRunNotes, fallbackBrief, handoffToolDefinition, HANDOFF_TOOL_NAME,
  parseHandoffBrief, runWriterHandoff, type HandoffBrief,
} from "./handoff";
import { contentWithoutImages, hasImageParts } from "./imageHistory";
import { stepTarget } from "./plan";
import { cloneLoreIndex } from "../lore";
import { TOOL_ARGS_DETAIL_CHARS, TOOL_RESULT_DETAIL_CHARS } from "./logFormat";
import type { TaskPreset } from "./presets";
import {
  executeRegisteredTool,
  getToolDefinitions,
  isParallelSafeTool,
  partitionByGroup,
  type ToolContext,
  type ToolGroup,
  type ToolId,
} from "./registry";
import { handoffToolTokens, toolTokensOf } from "./toolCost";
import { loadTaskDoc, parseSteps, type TaskStep } from "./taskWorkspace";
import type { ToolCall, ToolResult } from "./tools";

/** Stand-in left behind when an old tool result is dropped to reclaim room. */
const ELIDED_TOOL_RESULT =
  "[earlier tool result dropped to stay within the model's context window]";
/** Stand-in for a tool call that never ran, because the run was stopped. */
const ABORTED_TOOL_RESULT = "[not run — the user stopped the task]";

/**
 * How many times one run recovers from the output cap on its own.
 *
 * A long answer running into `max_tokens` once is ordinary, and a card for it
 * would be noise. Three in a row is not: either the model keeps trying to emit
 * something no single reply can hold, or the cap is configured far too low —
 * and every retry is another paid request. So the run recovers silently this
 * many times, then asks (see AgentRuntimeOptions.onTruncationLimit). Answering
 * 继续 grants the same allowance again.
 */
const TRUNCATION_RECOVERY_LIMIT = 3;

/** Whether a tool call's arguments survived the response intact. */
function argumentsUsable(raw: string): boolean {
  if (!raw.trim()) return true; // a no-argument call legitimately sends ""
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}
/** Stand-in left behind where an earlier picture was dropped to reclaim room. */
const ELIDED_IMAGE =
  "[earlier image dropped to stay within the model's context window]";

/**
 * Most read-tier calls one round runs at once. The number matters for
 * `delegate`: each delegation is a whole sub-run against some endpoint, and a
 * round that fans out into many should not open them all simultaneously —
 * providers rate-limit, and every lane past the author's patience is still a
 * paid request. Local reads finish in milliseconds either way.
 */
const MAX_PARALLEL_TOOLS = 4;

/** One stretch of a round's tool calls that may (or must not) overlap. */
interface ToolSegment {
  parallel: boolean;
  calls: AccumulatedToolCall[];
}

/**
 * Split one round's calls into segments, preserving the model's order:
 * consecutive read-tier calls form one parallel segment; every write call is a
 * segment of its own — a barrier that runs only after everything before it has
 * settled. See {@link isParallelSafeTool} for why the write tiers must not
 * overlap anything, including each other.
 */
function partitionParallelSegments(calls: readonly AccumulatedToolCall[]): ToolSegment[] {
  const segments: ToolSegment[] = [];
  for (const tc of calls) {
    const parallel = isParallelSafeTool(tc.name);
    const last = segments[segments.length - 1];
    if (parallel && last?.parallel) last.calls.push(tc);
    else segments.push({ parallel, calls: [tc] });
  }
  return segments;
}

/**
 * Run `worker` over every item with at most `limit` in flight.
 *
 * Workers must not throw — each lane is a plain while-loop, so a throw would
 * reject the whole pool and strand the other lanes' items. The runtime's
 * worker guarantees that (it records a result for every item, error text
 * included), which is also what keeps the tool_call/reply pairing whole.
 */
async function runLanes<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await worker(items[i], i);
      }
    }),
  );
}

/**
 * Context utilization threshold (fraction of input ceiling) at which the agent
 * is nudged to write its intermediate conclusions into notes before trimHistory
 * elides older tool results.
 */
const CHECKPOINT_RATIO = 0.85;

/**
 * Tool rounds of checklist silence tolerated before the runtime reminds the
 * model to bring task.md up to date. A nudge, not a verification: only the
 * model knows which tool call finished which step, so the enforceable half is
 * detecting silence — several rounds without a task_plan/task_progress write
 * while unfinished steps exist means the author's progress view has gone
 * stale.
 */
const TASK_NUDGE_ROUNDS = 3;

/** Checkbox glyphs for the nudge's checklist snapshot (mirrors taskWorkspace). */
const NUDGE_GLYPH: Record<TaskStep["status"], string> = {
  pending: " ",
  in_progress: "/",
  done: "x",
  skipped: "-",
};

/** The active task's steps, or [] when there is no plan (or it can't be read). */
async function loadTaskSteps(projectPath: string, taskId: string): Promise<TaskStep[]> {
  try {
    const doc = await loadTaskDoc(projectPath, taskId);
    return doc ? parseSteps(doc.body) : [];
  } catch {
    return [];
  }
}

/**
 * How many pictures stay in history verbatim. Enough to compare a couple of
 * gallery images against each other; few enough that the request body stays in
 * the low megabytes however long the conversation runs.
 *
 * Counts the author's own attachments alongside the tool loop's: both are
 * base64 on the same wire, and a cap that only saw one of them would be a cap
 * the other could walk straight past.
 */
const MAX_IMAGE_RESULTS = 3;

/** Strip all but the newest {@link MAX_IMAGE_RESULTS} pictures, keeping their text. */
function elideOldImageResults(history: StreamMessage[]): number {
  const live = history.filter(hasImageParts);
  let dropped = 0;
  for (const m of live.slice(0, Math.max(0, live.length - MAX_IMAGE_RESULTS))) {
    m.content = contentWithoutImages(m, ELIDED_IMAGE);
    dropped++;
  }
  return dropped;
}

/**
 * Keep the growing history inside the planned input ceiling.
 *
 * The first turn is budgeted to fill the window up to the author's utilization
 * setting, which leaves the rest for whatever the tools drag in. Without this,
 * a long tool-using run trips the pre-flight check on round 5 or 6 — i.e. it
 * fails *after* the author has already waited through the whole loop.
 *
 * For chat this is the SECOND line of defense: between turns, compaction
 * (lib/agent/compactRun) folds whole old turns into a rolling summary the
 * model can still use. This pass handles what compaction cannot — growth
 * *inside* a turn, where the fold unit (a complete turn) doesn't exist yet —
 * and one-shot agent runs, which have no between-turns moment at all.
 *
 * Oldest tool results go first: they are both the bulk of the growth and the
 * least likely to still matter. Their *messages* stay — an assistant tool_call
 * with no matching tool reply is a protocol error at both OpenAI and Gemini —
 * only the payload is replaced. Pictures (`image_url` parts on a `role: "user"`
 * message — a vision tool's result, or one the author attached to their
 * question) are elided the same way: their base64 data URLs are usually the
 * single largest thing in history, so leaving them out of this pass would mean
 * the ceiling keeps getting hit again every round without ever reclaiming the
 * room that actually matters. Their surrounding text survives — see
 * lib/agent/imageHistory. The system prompt and the assembled first turn's
 * *text* are never touched; if those alone overflow, that is a planning bug and
 * the pre-flight check should say so rather than this quietly hiding it.
 *
 * Returns how many results were elided so the caller can log it.
 */
export function trimHistory(history: StreamMessage[], ceilingTokens?: number): number {
  // Images first, and unconditionally. The token estimate charges a flat rate
  // per picture (see ai/tokenEstimate) because that is what a provider bills —
  // but the *payload* is base64, megabytes of it, and a chat history persists
  // across turns. Left to the token check alone, a session that reads pictures
  // grows a request body no endpoint will accept while the estimate still
  // reads as comfortably under the ceiling.
  let dropped = elideOldImageResults(history);
  if (!ceilingTokens || ceilingTokens <= 0) return dropped;
  if (estimateMessagesTokens(history) <= ceilingTokens) return dropped;
  for (const m of history) {
    if (m.role === "tool" && m.content !== ELIDED_TOOL_RESULT) {
      m.content = ELIDED_TOOL_RESULT;
      dropped++;
    } else if (hasImageParts(m)) {
      m.content = contentWithoutImages(m, ELIDED_IMAGE);
      dropped++;
    } else {
      continue;
    }
    if (estimateMessagesTokens(history) <= ceilingTokens) break;
  }
  return dropped;
}

/**
 * Give every assistant `tool_calls` entry in `history` a matching tool reply.
 *
 * The pairing is a hard protocol requirement — OpenAI answers "An assistant
 * message with 'tool_calls' must be followed by tool messages responding to
 * each tool_call_id", Gemini refuses likewise — and a broken history is
 * permanent, since it *is* the session's history: every later turn is appended
 * to it, so one gap ends the conversation for good and the only recovery the
 * author has is 新建对话.
 *
 * The loop below keeps its own history paired even on abort. This is the belt
 * to that pair of braces: a second run sharing the same array, a crash between
 * the two pushes, or a history restored from anywhere else. Returns how many
 * stubs it had to add.
 */
export function repairToolCallPairing(history: StreamMessage[]): number {
  const answered = new Set<string>();
  for (const m of history) {
    if (m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
  }
  let inserted = 0;
  // Backwards, so each splice leaves the earlier indices untouched.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls.length) continue;
    const missing = m.tool_calls.filter((tc) => !answered.has(tc.id));
    if (!missing.length) continue;
    history.splice(i + 1, 0, ...missing.map((tc): StreamMessage => ({
      role: "tool",
      tool_call_id: tc.id,
      content: ABORTED_TOOL_RESULT,
    })));
    inserted += missing.length;
  }
  return inserted;
}

export interface AgentRunResult {
  /** Rounds actually consumed (≥1). */
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  /** Subset of inputTokens served from the provider's prompt cache. */
  cachedTokens: number;
  /**
   * How the run ended.
   * - "completed": the model produced prose (normal finish).
   * - "paused": the author chose 存盘暂停 at the round cap.
   */
  outcome: "completed" | "paused";
}

export interface AgentRuntimeOptions extends ConnOptions {
  // ── Transport ──────────────────────────────────────────────────────────────
  // The endpoint/model half comes from ConnOptions (lib/ai/conn) — build it with
  // connOptions(conn) rather than listing the fields here.
  /**
   * Ceiling for this run's **messages**, from the context budget planner
   * (`ContextBudgetPlan.messageCeilingTokens`, or `messageCeilingFor` on a
   * surface that builds no plan). Older tool results are elided to stay under
   * it, so a long loop degrades instead of dying on a ContextSizeError several
   * rounds in. Omit to disable.
   *
   * The tool schemas' share is **already subtracted by the caller** — do not
   * subtract it again here. It is the messages this loop can trim; the schemas
   * ride on every round whatever the history looks like, which is exactly why
   * they have to come off the ceiling before the trimming starts rather than
   * being discovered as overflow afterwards.
   */
  inputCeilingTokens?: number;
  /**
   * Extra top-level request fields (e.g. response_format for JSON mode).
   * JSON mode conflicts with tool calling on several providers, so presets
   * that use it should keep `tools: []`.
   */
  extraBody?: Record<string, unknown>;

  // ── Task ───────────────────────────────────────────────────────────────────
  preset: TaskPreset;
  /**
   * Seeded conversation history: system prompt + assembled first user turn.
   * Mutated in place as the loop appends assistant/tool messages, so a caller
   * holding the array sees the full transcript afterwards.
   */
  messages: StreamMessage[];
  toolContext: ToolContext;

  // ── Control & reporting ────────────────────────────────────────────────────
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /**
   * Called when the round cap is about to end the run while the model is still
   * mid-work — i.e. on entering the final round of a force-text preset after
   * every earlier round was a tool round. Blocks the loop (like a
   * `propose_edit` approval) until it resolves with how many extra rounds the
   * author grants; 0 keeps today's behaviour (tools withheld, the model is
   * told to write its answer now).
   *
   * Optional because not every surface can render the question: the lore
   * modals don't show the approvals area, and a run that blocks on a card
   * nobody can see would simply hang.
   */
  onRoundLimit?: (roundsUsed: number) => Promise<RoundLimitDecision>;
  /**
   * Called when the output cap has cut the model off once too often (see
   * TRUNCATION_RECOVERY_LIMIT). Blocks the loop on the author's answer, like
   * `onRoundLimit`.
   *
   * Optional for the same reason: a surface that cannot render the card would
   * hang on it. Without it the run simply stops recovering — which is the
   * conservative direction, since every retry costs another request.
   */
  onTruncationLimit?: (recoveries: number) => Promise<TruncationDecision>;
  /**
   * The run's output **so far, in full** — a snapshot, not a delta, so callers
   * assign rather than append.
   *
   * Cumulative because the runtime is the only place that knows a round's text
   * turned out not to be output at all: anything the model says before calling a
   * tool ("我先去找文件列表。") is it thinking out loud, and used to be spliced
   * into the result the author then inserted into their document. Discarding
   * that is only expressible if the runtime owns the buffer.
   *
   * Text still streams as it arrives, so a tool round's narration appears and
   * then disappears when the round resolves. The alternative — buffering each
   * round until its nature is known — would stall the final answer, which is the
   * part worth watching. The execution log records what the discarded round did,
   * so nothing is actually lost.
   */
  onOutputText: (fullText: string) => void;
  /**
   * System-layer text the writer subagent inherits on a `handoff` finish.
   *
   * Named by the caller rather than lifted from `history[0]`, because that
   * message is not one thing: chat's system layer is the author's writing
   * prompt *plus* the agent briefing, the workflow roster and the docx presets.
   * The first part is exactly what the writer needs — it is where the project's
   * vocabulary lives — and the rest is tool-loop machinery that would have a
   * writer with no tools talking about capabilities it does not have.
   *
   * Ignored unless the run actually hands off.
   */
  writerSystem?: string;
}

export async function runAgent(opts: AgentRuntimeOptions): Promise<AgentRunResult> {
  const { preset } = opts;
  const history = opts.messages;
  /**
   * The toolset as it stands, growing as the run earns groups (see
   * `partitionByGroup`). Resident tools keep their original positions and
   * loaded ones are appended, which is what lets the Anthropic cache prefix
   * covering the resident half survive a mid-run load.
   *
   * An array rather than a Set precisely because that order is load-bearing.
   */
  const { resident, deferred } = partitionByGroup(preset.tools);
  const activeTools: ToolId[] = [...resident];
  const loadedGroups = new Set<ToolGroup>();

  // The run's own lore snapshot. The write tools patch it and resync it in
  // place (see writeTools.syncLore) — but the object callers hand in is the
  // live loreStore state object, so mutating it would edit store state behind
  // zustand's back, on arrays React is rendering from. Cloning here rather
  // than at each call site is deliberate: this is the one funnel every surface
  // passes through, so a caller added later cannot forget it.
  const runToolContext: ToolContext = {
    ...opts.toolContext,
    loreIndex: cloneLoreIndex(opts.toolContext.loreIndex),
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  /** Text from rounds that ended in prose — the run's output as it stands. */
  let committedText = "";

  // Mutable: the author can extend it at the cap via onRoundLimit.
  let maxRounds = preset.maxRounds;
  /** Output-cap recoveries spent in this run — reset when the author grants more. */
  let truncationRecoveries = 0;
  /**
   * May the run recover from one more truncation?
   *
   * Silent for the first {@link TRUNCATION_RECOVERY_LIMIT}; past that the
   * author decides, because from here on the loop is spending money on requests
   * that keep getting cut off. A surface with no card to show says no — the
   * conservative answer, and the only honest one when nobody can be asked.
   */
  const mayRecoverFromTruncation = async (): Promise<boolean> => {
    truncationRecoveries++;
    if (truncationRecoveries <= TRUNCATION_RECOVERY_LIMIT) return true;
    if (!opts.onTruncationLimit) return false;
    const decision = await opts.onTruncationLimit(truncationRecoveries - 1);
    if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
    opts.onEvent({
      kind: "truncation-limit",
      recoveries: truncationRecoveries - 1,
      decision,
      at: Date.now(),
    });
    if (decision.action === "stop") return false;
    // 继续 buys the same allowance again, exactly like the round cap's 继续.
    truncationRecoveries = 0;
    return true;
  };
  let checkpointArmed = false;
  /** Tool rounds since the model last wrote to the checklist — see TASK_NUDGE_ROUNDS. */
  let roundsSinceTaskTouch = 0;
  /**
   * Whether a `handoff` preset must now be *made* to produce a work order.
   *
   * Armed when a round ended in prose instead: on this preset prose is not a
   * valid ending, because the author turned the writer on precisely so the
   * final text would not come from this model. One retry, and then the degraded
   * path takes whatever it said as the work order — see the handoff branch
   * below and lib/agent/handoff.fallbackBrief.
   */
  let handoffForced = false;

  for (let round = 1; round <= maxRounds; round++) {
    if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Lore writes become legal the moment the author approves a plan, and
    // that is exactly when they become worth sending. The gate itself is the
    // signal — `plan.ts` is the one record of what the author signed off on,
    // and a second flag beside it would be a second truth to keep in step.
    //
    // Checked at the top of the round, so the tools arrive on the round *after*
    // the one that proposed. That costs nothing: propose_lore_plan blocks until
    // the author decides and then ends its round with a tool result, so the
    // model's next chance to write is that following round either way.
    // 装载是**按方案形状**分的，不是全有全无：批准一份「改写条目正文」的方案不该
    // 顺手把集合工具也塞进来，反过来也一样。同一个信号（已批准的步骤）回答两个
    // 不同的问题——「有没有条目要写」和「有没有组织结构要动」。
    const steps = runToolContext.lorePlan?.steps ?? [];
    const wantsWrite = steps.some((s) => stepTarget(s) === "entity");
    const wantsOrganize = steps.some((s) => stepTarget(s) !== "entity");
    for (const [group, wanted] of [
      ["lore_write", wantsWrite],
      ["lore_organize", wantsOrganize],
    ] as const) {
      if (!wanted || loadedGroups.has(group) || deferred[group].length === 0) continue;
      loadedGroups.add(group);
      activeTools.push(...deferred[group]);
      opts.onEvent({
        kind: "tools-loaded",
        group,
        names: [...deferred[group]],
        round,
        at: Date.now(),
      });
    }
    // Rebuilt per round because `activeTools` grows. `getToolDefinitions` also
    // re-patches the active profile's lore categories, which is free to redo
    // and wrong to cache across a project switch.
    const toolDefinitions = getToolDefinitions(activeTools);

    // On the final round of a force-text task: inject a "write now" instruction
    // and omit tools so the model must produce text without further tool calls.
    let isLastRound = round === maxRounds;

    // Reaching the final round of a tool-using run means every earlier round
    // ended in a tool call — the model is mid-work, and forcing text now cuts
    // it off. Ask the author before doing that. Asking here (not after the
    // forced round) is the only spot that can still resume: once tools are
    // withheld and the model writes, the run has ended. `round > 1` keeps
    // single-round presets out — their one round *is* the whole run.
    if (
      isLastRound &&
      round > 1 &&
      (preset.finishPolicy === "force-text" || preset.finishPolicy === "handoff") &&
      preset.tools.length > 0 &&
      opts.onRoundLimit
    ) {
      const decision = await opts.onRoundLimit(round - 1);
      if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
      opts.onEvent({ kind: "round-limit", roundsUsed: round - 1, decision, at: Date.now() });

      if (decision.action === "pause") {
        // Clean exit point: we are at the **start** of a round, so every
        // tool_call from the previous round already has its paired tool reply.
        // No repairToolCallPairing needed — the history is valid as-is.
        return {
          rounds: round - 1,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedTokens: totalCachedTokens,
          outcome: "paused",
        };
      }
      if (decision.action === "extend") {
        maxRounds += decision.rounds;
        isLastRound = false;
      }
    }

    /**
     * This run ends by handing a work order to the writer rather than by
     * writing anything itself (lib/agent/handoff).
     *
     * `handoff` is therefore on the table from round 1, not saved for the round
     * cap: the model finishes its research whenever it finishes, and calling
     * the tool is simply what "I am done, here is the job" looks like. What
     * makes the author's switch deterministic is not that the tool is forced
     * on every round — it is that **prose is not an accepted ending** on this
     * preset (see the handoff branch after the request).
     */
    const handoffPreset = preset.finishPolicy === "handoff";
    /**
     * …and this is the round where it stops being a choice: the retry after a
     * prose round, or the round cap. One tool on the wire and `tool_choice`
     * pinned to it — the model has had its whole run to read and think, and
     * leaving `read_file` on the table here only buys research the cap has
     * already ended.
     */
    const forceHandoff = handoffPreset && (handoffForced || isLastRound);
    const withholdTools =
      !handoffPreset &&
      (preset.tools.length === 0 || (isLastRound && preset.finishPolicy === "force-text"));
    const serverToolPolicy = preset.serverTools ?? "final-round-off";
    const withholdServerTools =
      forceHandoff ||
      serverToolPolicy === "off" ||
      (serverToolPolicy === "final-round-off" && isLastRound && preset.finishPolicy === "force-text");
    /**
     * The "stop calling tools" nudge, retracted after this round's request.
     *
     * It is an instruction about *this* round, but for chat the history is
     * persistent — left in, every later turn carried a standing order not to
     * use tools, and the assistant simply stopped reading files and drawing
     * pictures with nothing on screen to explain why.
     */
    let forcedTextNotice: StreamMessage | null = null;
    if (isLastRound && preset.finishPolicy === "force-text" && preset.tools.length > 0) {
      forcedTextNotice = {
        role: "user",
        content: i18n.t("ai.instructions.roundCapReached"),
      };
      history.push(forcedTextNotice);
    }
    // Injected and retracted like the notice above, and for chat with more
    // force behind it: left in a persistent history, "hand your work to the
    // writer now" becomes a standing order, gets folded into the next
    // compaction's summary, and trains the model to answer every later turn
    // with a work order instead of an answer.
    if (forceHandoff) {
      forcedTextNotice = { role: "user", content: i18n.t("ai.instructions.handoffRound") };
      history.push(forcedTextNotice);
    }

    let roundToolCalls: AccumulatedToolCall[] = [];
    /** Whether the endpoint cut this round off at `max_tokens`. */
    let roundTruncated = false;
    let roundStopReason: string | undefined;
    let roundGeminiModelParts: unknown[] | undefined;
    let roundReasoning: NativeReasoning | undefined;
    let roundThinkingBlocks: ThinkingBlockCarry | undefined;
    // Streamed reasoning for this round, reported to the log as it grows. The
    // start time is captured on the first fragment rather than at round start:
    // a model that thinks only after reading a tool result would otherwise be
    // credited with the wait for that result.
    let reasoningText = "";
    let reasoningStart = 0;
    let reasoningDone = false;
    const reportReasoning = (done: boolean) => {
      if (!reasoningText) return;
      opts.onEvent({
        kind: "reasoning",
        round,
        text: reasoningText,
        done,
        ...(done ? { elapsedMs: Date.now() - reasoningStart } : {}),
        at: reasoningStart,
      });
    };
    /** This round's text, still provisional — kept only if it ends in prose. */
    let roundText = "";
    /** Searches the endpoint ran for itself this round, as log rows. */
    const logServerTool = createServerToolLog(round);

    let checkpointNotice: StreamMessage | null = null;
    if (
      preset.scratchpad === "required" &&
      opts.inputCeilingTokens &&
      estimateMessagesTokens(history) > opts.inputCeilingTokens * CHECKPOINT_RATIO &&
      !checkpointArmed
    ) {
      checkpointNotice = {
        role: "user",
        content: i18n.t("ai.instructions.scratchpadCheckpoint", {
          defaultValue:
            "【系统提示】当前上下文接近上限并即将触发裁剪。请使用 write_note 将已获取的关键结论与资料写进笔记文件，避免信息丢失。",
        }),
      };
      history.push(checkpointNotice);
      checkpointArmed = true;
    }

    // The checklist staleness nudge. task.md only advances when the model
    // calls task_progress — the runtime cannot tell which tool call finished
    // which step — so after several tool rounds of silence with unfinished
    // steps on the plan, remind it with a snapshot of the checklist as it
    // stands. Injected fresh and retracted after the request, like the
    // notices above; the counter resets so it re-fires only after another
    // stretch of silence.
    let taskNudgeNotice: StreamMessage | null = null;
    if (
      preset.scratchpad === "required" &&
      !withholdTools &&
      roundsSinceTaskTouch >= TASK_NUDGE_ROUNDS &&
      opts.toolContext.taskWorkspace?.taskId
    ) {
      const steps = await loadTaskSteps(
        opts.toolContext.projectPath,
        opts.toolContext.taskWorkspace.taskId,
      );
      const unfinished = steps.some((s) => s.status === "pending" || s.status === "in_progress");
      if (unfinished) {
        taskNudgeNotice = {
          role: "user",
          content: i18n.t("ai.instructions.taskChecklistNudge", {
            checklist: steps
              .map((s) => `${s.index}. [${NUDGE_GLYPH[s.status]}] ${s.title}`)
              .join("\n"),
          }),
        };
        history.push(taskNudgeNotice);
        roundsSinceTaskTouch = 0;
      }
    }

    const dropped = trimHistory(history, opts.inputCeilingTokens);
    if (dropped > 0) {
      opts.onEvent({ kind: "context-trimmed", count: dropped, at: Date.now() });
      checkpointArmed = false;
    }

    opts.onEvent({
      kind: "round-start",
      round,
      maxRounds,
      estInputTokens: estimateMessagesTokens(history),
      // The handoff round carries one hand-written definition rather than the
      // preset's toolset, so the run's usual figure would overstate it wildly.
      toolTokens: forceHandoff
        ? handoffToolTokens()
        : withholdTools
          ? 0
          : toolTokensOf(activeTools) + (handoffPreset ? handoffToolTokens() : 0),
      at: Date.now(),
    });

    try {
      await streamCompletion({
        ...pickConnOptions(opts),
        messages: history,
        extraBody: opts.extraBody,
        tools: forceHandoff
          ? [handoffToolDefinition()]
          : withholdTools
            ? undefined
            : handoffPreset ? [...toolDefinitions, handoffToolDefinition()] : toolDefinitions,
        // Forced — but never *relied* upon: some endpoints downgrade a forced
        // choice to "auto" without saying so (lib/ai/openai.ts toolChoiceFor,
        // lib/ai/anthropic.ts toolChoiceBody, both on the `switch` thinking
        // dialect). The handoff below therefore runs whether or not the call
        // arrives; see handoff.fallbackBrief.
        ...(forceHandoff
          ? { toolChoice: { type: "function" as const, function: { name: HANDOFF_TOOL_NAME } } }
          : {}),
        // Governed by preset.serverTools (final-round-off | off | always).
        // Separate from local tools because search subagent has no local tools
        // (preset.tools: []) but requires serverTools enabled on every round.
        serverTools: withholdServerTools ? undefined : opts.serverTools,
        signal: opts.signal,
        onChunk: (chunk) => {
          if ("reasoning" in chunk) {
            if (!reasoningText) reasoningStart = Date.now();
            reasoningText += chunk.reasoning;
            reportReasoning(false);
          } else if ("turnResumed" in chunk) {
            opts.onEvent({
              kind: "turn-resumed",
              round,
              leg: chunk.turnResumed.leg,
              final: chunk.turnResumed.final,
              at: Date.now(),
            });
          } else if ("serverTool" in chunk) {
            // A tool the endpoint ran for itself. Reported as a tool step so it
            // reads like every other one in the log — but it never touches
            // `roundToolCalls`: there is nothing left to execute, and answering
            // it with a tool_result would break the round's message pairing.
            opts.onEvent(logServerTool(chunk.serverTool));
          } else if ("text" in chunk) {
            // The answer has started, so the thinking is over. Reported here
            // rather than at round end because on a text round the answer
            // streams for a while afterwards — the log would otherwise show
            // "still thinking" while prose is visibly arriving.
            if (reasoningText && !reasoningDone) {
              reasoningDone = true;
              reportReasoning(true);
            }
            // Streamed live, but on top of `committedText` rather than into it —
            // if this round turns out to be a tool round, the whole of `roundText`
            // is dropped below and the display reverts.
            roundText += chunk.text;
            opts.onOutputText(committedText + roundText);
          } else if ("toolCalls" in chunk) {
            roundToolCalls = chunk.toolCalls;
            roundGeminiModelParts = chunk._geminiModelParts;
            roundReasoning = chunk._reasoning;
            roundThinkingBlocks = chunk._thinkingBlocks;
          } else if ("done" in chunk) {
            totalInputTokens += chunk.inputTokens;
            totalOutputTokens += chunk.outputTokens;
            totalCachedTokens += chunk.cachedTokens ?? 0;
            // Held, not emitted: the event now also reports what the runtime
            // *did* about it, and that isn't known until we see whether this
            // round's casualty was the prose or a tool call's arguments.
            if (chunk.truncated) {
              roundTruncated = true;
              roundStopReason = chunk.stopReason;
            }
          }
        },
      });
    } catch (err) {
      // A stop mid-prose: the text already streamed stays on screen, so it
      // must also stay in the transcript — otherwise the next turn's model
      // never saw what the author is replying to. Tool-round narration keeps
      // its rollback: commit only when no tool call had been emitted.
      if (
        err instanceof DOMException &&
        err.name === "AbortError" &&
        roundToolCalls.length === 0 &&
        roundText.trim()
      ) {
        history.push({ role: "assistant", content: roundText });
      }
      throw err;
    } finally {
      // A round that called a tool without ever emitting prose, or one that
      // failed part-way: the thinking that did happen is still worth showing,
      // and leaving it marked in-progress would strand a spinner in the log.
      if (!reasoningDone) {
        reasoningDone = true;
        reportReasoning(true);
      }
      // The request has been sent, so the nudge has done its job. Retracting
      // it here (rather than never adding it) keeps it out of a persistent
      // history without changing what this round asked for.
      if (forcedTextNotice) {
        const at = history.indexOf(forcedTextNotice);
        if (at >= 0) history.splice(at, 1);
      }
      if (checkpointNotice) {
        const at = history.indexOf(checkpointNotice);
        if (at >= 0) history.splice(at, 1);
      }
      if (taskNudgeNotice) {
        const at = history.indexOf(taskNudgeNotice);
        if (at >= 0) history.splice(at, 1);
      }
    }

    // ── The handoff: this model does not write the answer ──
    //
    // Placed ahead of both the prose branch and the tool-execution path,
    // because a `handoff` call is in neither: it is not a registered tool
    // (executing it would be an "unknown tool" error), and the round that made
    // it is not a prose round. Returning from here is also what keeps the work
    // order out of the history — nothing below ever builds the assistant
    // message that would have carried it.
    if (handoffPreset) {
      const call = roundToolCalls.find((c) => c.name === HANDOFF_TOOL_NAME);

      // Prose where a work order was required. Not an answer: on this preset
      // the author has said the final text comes from the writer, so accepting
      // it here would turn a deterministic switch back into the model's choice.
      // One retry with the tool pinned; if that round still comes back as prose
      // the endpoint is downgrading the forced choice (lib/ai/openai.ts
      // toolChoiceFor), and we hand off anyway with its words as the order.
      if (!call && roundToolCalls.length === 0 && !forceHandoff) {
        handoffForced = true;
        opts.onOutputText(committedText);
        continue;
      }

      if (call || roundToolCalls.length === 0) {
        const degraded = !call;
        const brief: HandoffBrief = call
          ? parseHandoffBrief(call.arguments)
          : fallbackBrief(roundText, await collectRunNotes(runToolContext));
        const stepId = `handoff-${round}`;

        // Whatever this round said before handing off was narration, exactly as
        // on a tool round. Roll the display back before the writer's text
        // starts arriving on top of it.
        opts.onOutputText(committedText);

        const res = await runWriterHandoff({
          brief,
          degraded,
          ctx: runToolContext,
          inheritedSystem: opts.writerSystem,
          signal: opts.signal,
          onEvent: opts.onEvent,
          onText: (full) => opts.onOutputText(committedText + full),
          stepId,
        });
        totalInputTokens += res.inputTokens;
        totalOutputTokens += res.outputTokens;
        totalCachedTokens += res.cachedTokens;

        // What the author ends up reading. The writer's text when there is one;
        // failing that the main model's own prose, which exists only on the
        // degraded path — and there it is a real answer rather than narration,
        // since the model wrote it instead of calling the tool.
        //
        // Failing both, **nothing**: a writer that could not run has produced
        // no reply, and app text pushed into the turn would be the one thing
        // the whole署名 design forbids — a paragraph in the reading column that
        // nobody's model wrote. The reason travels on `handoff-done` instead,
        // and the surface renders it as an app notice outside the prose
        // (设计稿 12 · 屏 1a 轮 4).
        const finalText =
          res.text.trim() || (degraded && roundText.trim() ? roundText : "");

        committedText += finalText;
        opts.onOutputText(committedText);
        // The transcript gets the writer's words, because those are the words
        // the author read and is replying to. The work order is not in here at
        // all — neither the call nor its result was ever appended. An empty
        // turn appends nothing: Anthropic rejects empty content blocks, and a
        // turn where nothing was said should not claim otherwise.
        if (finalText) history.push({ role: "assistant", content: finalText });
        return {
          rounds: round,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedTokens: totalCachedTokens,
          outcome: "completed",
        };
      }
      // Anything else this round called is an ordinary tool round; fall through.
    }

    // No tool calls → the model produced prose → that prose is the answer.
    if (roundToolCalls.length === 0) {
      committedText += roundText;
      // The reply belongs in the wire history, not just on screen: `history`
      // IS the chat session's transcript, and without this the next turn's
      // model has never seen its own answer. Empty text stays out — Anthropic
      // rejects empty content blocks.
      if (roundText.trim()) {
        history.push({ role: "assistant", content: roundText });
      }

      // Cut off mid-sentence: ask for the rest instead of handing the author
      // half an answer. The nudge STAYS in the history — unlike the notices
      // above, which are retracted — because dropping it would leave two
      // assistant messages side by side, and the Anthropic protocol requires
      // the roles to alternate. It is also simply true: the model was asked to
      // continue, and the next turn should see that it was.
      if (roundTruncated && roundText.trim() && (await mayRecoverFromTruncation())) {
        opts.onEvent({
          kind: "output-truncated",
          round,
          stopReason: roundStopReason,
          recovery: { kind: "text", attempt: truncationRecoveries },
          at: Date.now(),
        });
        history.push({
          role: "user",
          content: i18n.t("ai.instructions.continueTruncated", {
            defaultValue:
              "【系统提示】你上一条回复被输出上限截断了。请从断掉的地方**接着写完**，"
              + "不要重复已经写出来的内容，也不要重新开头。如果剩下的部分很长，"
              + "先写完这一段，我会再让你继续。",
          }),
        });
        continue;
      }
      if (roundTruncated) {
        opts.onEvent({
          kind: "output-truncated", round, stopReason: roundStopReason, at: Date.now(),
        });
      }
      return {
        rounds: round,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedTokens: totalCachedTokens,
        outcome: "completed",
      };
    }

    // A tool round: whatever the model said before calling the tool was it
    // narrating its own plan, not writing. Roll the display back to what has
    // actually been committed so the narration can't end up in the document.
    if (roundText) opts.onOutputText(committedText);

    // ── Tool calls the output cap cut in half ──
    //
    // A truncated call is a fragment of JSON, and there is nothing to salvage:
    // it cannot be executed, and it must not enter the history either — the
    // Anthropic and Gemini adapters re-serialise every past tool call, and a
    // fragment that fails to parse would break not this round but every round
    // after it, permanently. So the broken calls are dropped before the
    // assistant message is built, and the model is told plainly what happened.
    //
    // This is where a big write dies today: the model spends its whole output
    // budget on one create_file carrying a 60k-character page, the call is cut,
    // nothing is written, and the old code handed it a raw JSON syntax error —
    // on which the sensible-looking move is to send the same thing again.
    const brokenCalls = roundToolCalls.filter((tc) => !argumentsUsable(tc.arguments));
    if (brokenCalls.length > 0) {
      roundToolCalls = roundToolCalls.filter((tc) => argumentsUsable(tc.arguments));
      for (const tc of brokenCalls) {
        // Reported as a failed step rather than a silent omission: the author
        // watching the log has to see that the model tried to write and that
        // nothing landed.
        opts.onEvent({
          kind: "tool-step",
          step: {
            round,
            toolCallId: tc.id,
            name: tc.name,
            argumentSummary: tc.arguments.slice(0, TOOL_ARGS_DETAIL_CHARS),
            status: "error",
            resultSummary: i18n.t("ai.agent.log.truncatedCall", {
              defaultValue: "参数被输出上限截断，未执行，也没有写入任何内容",
            }),
            argsTruncated: true,
            resultTruncated: false,
          },
          at: Date.now(),
        });
      }
    }

    // Append the assistant's tool-call message to history.
    //
    // Both `_` fields carry what a thinking model needs to see of its own
    // previous turn: Gemini's thought signatures, and the reasoning text the
    // OpenAI-compatible thinking endpoints require echoed back. Dropping either
    // one doesn't degrade the answer — it makes the *next* round of the loop
    // fail outright, which is why they ride on the message rather than being
    // reconstructed later.
    // Skipped when the cap ate every call in the round: an assistant message
    // with an empty tool_calls array is not a valid request on any of the three
    // protocols, and there is nothing left to pair a tool reply with.
    if (roundToolCalls.length > 0) {
      history.push({
        role: "assistant",
        content: null,
        tool_calls: roundToolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
        _geminiModelParts: roundGeminiModelParts,
        _reasoning: roundReasoning,
        _thinkingBlocks: roundThinkingBlocks,
      });
    }

    // Execute the round's tool calls and append results.
    //
    // *Execution* order is no longer strictly the model's: consecutive
    // read-tier calls (`delegate` included) run concurrently, because each is
    // pure IO against its own inputs and a round of three delegations used to
    // pay for them end to end. Every write call is a barrier — it runs alone,
    // after everything before it has settled (see isParallelSafeTool for why
    // that is correctness, not caution). *History* order is unchanged: a
    // segment's results are appended in the model's call order however its
    // lanes settled, so the transcript reads exactly as it did when the loop
    // was serial.
    //
    // Abort is re-checked per call, not just per round: the model can emit
    // several tool calls in one round, and an abort mid-round — including one
    // that arrives *as* rejectAll() resolves a blocked approval — must stop
    // the calls not yet dispatched rather than only taking effect at the next
    // round's top-of-loop check. (A call already in flight when the abort
    // lands runs to its own end — it holds the same signal and cuts itself
    // short.) An abort part-way through must still leave every tool_call
    // answered — the assistant message naming N of them is already in
    // `history`, and `history` IS the chat session's history. Stopping with
    // k < N replies used to wedge the conversation permanently: the next turn
    // appended a user message onto a malformed transcript and every provider
    // rejected it.
    let abortedMidRound = false;
    let touchedChecklist = false;

    /** Execute one call, emitting its running/done log steps. Never throws. */
    const runOneToolCall = async (tc: AccumulatedToolCall): Promise<ToolResult> => {
      const toolCall: ToolCall = { id: tc.id, name: tc.name, arguments: tc.arguments };
      // Kept as valid JSON rather than pre-truncated: the log formats these for
      // display (lib/agent/logFormat), and it can only pull out the identifying
      // argument if the object still parses. Bounded by what the model emits.
      const argsTruncated = tc.arguments.length > TOOL_ARGS_DETAIL_CHARS;
      const argumentSummary = argsTruncated
        ? tc.arguments.slice(0, TOOL_ARGS_DETAIL_CHARS)
        : tc.arguments;

      opts.onEvent({
        kind: "tool-step",
        step: { round, toolCallId: tc.id, name: tc.name, argumentSummary, status: "running", argsTruncated },
        at: Date.now(),
      });

      // Executor never throws — bad calls come back as error-text results the
      // model can read and correct on the next round.
      const callContext: ToolContext = {
        ...runToolContext,
        signal: opts.signal,
        onNestedEvent: opts.onEvent,
      };
      // `activeTools`, NOT `preset.tools`: this list is the security boundary,
      // not an optimisation. Leave it as the preset's full set and a deferred
      // tool stays callable while its schema is being withheld — which is the
      // gate doing nothing at all, dressed up as a saving.
      const result: ToolResult = await executeRegisteredTool(
        toolCall,
        activeTools,
        callContext,
      );
      const isError = result.content.startsWith("Error") || result.content.startsWith("Unknown tool");
      if (!isError && (tc.name === "task_plan" || tc.name === "task_progress")) {
        touchedChecklist = true;
      }
      opts.onEvent({
        kind: "tool-step",
        step: {
          round,
          toolCallId: tc.id,
          name: tc.name,
          argumentSummary,
          status: isError ? "error" : "done",
          // Enough for the expanded row to be worth opening — a 200-char slice
          // stopped inside the first paragraph of a chapter read.
          resultSummary: result.content.slice(0, TOOL_RESULT_DETAIL_CHARS),
          argsTruncated,
          resultTruncated: result.content.length > TOOL_RESULT_DETAIL_CHARS,
        },
        at: Date.now(),
      });
      return result;
    };

    for (const segment of partitionParallelSegments(roundToolCalls)) {
      // Indexed by position, not a Map keyed on id: a confused model can emit
      // two calls sharing an id, and both still need their own reply.
      const results: ToolResult[] = new Array(segment.calls.length);
      const dispatch = async (tc: AccumulatedToolCall, i: number): Promise<void> => {
        if (abortedMidRound || opts.signal.aborted) {
          abortedMidRound = true;
          results[i] = { toolCallId: tc.id, content: ABORTED_TOOL_RESULT };
          return;
        }
        try {
          results[i] = await runOneToolCall(tc);
        } catch (e) {
          // executeRegisteredTool never throws; this guards the surrounding
          // event plumbing so one lane's surprise cannot reject the pool and
          // leave a sibling's tool_call unanswered.
          results[i] = { toolCallId: tc.id, content: `Error: ${String(e)}` };
        }
      };
      if (segment.parallel && segment.calls.length > 1) {
        await runLanes(segment.calls, MAX_PARALLEL_TOOLS, dispatch);
      } else {
        for (let i = 0; i < segment.calls.length; i++) await dispatch(segment.calls[i], i);
      }

      for (let i = 0; i < segment.calls.length; i++) {
        const tc = segment.calls[i];
        const result = results[i];

        // Text result: role "tool" satisfies the tool_call_id protocol
        history.push({ role: "tool", tool_call_id: tc.id, content: result.content });

        // Image result: follow-up user message (OpenAI role:"tool" only allows string content)
        if (result.imageDataUrls?.length) {
          const imageParts: ContentPart[] = [
            { type: "text", text: `Visual reference for ${tc.name}:\n${result.content}` },
            ...result.imageDataUrls.map(
              (url): ContentPart => ({ type: "image_url", image_url: { url } }),
            ),
          ];
          history.push({ role: "user", content: imageParts });
        }
      }
    }
    roundsSinceTaskTouch = touchedChecklist ? 0 : roundsSinceTaskTouch + 1;
    // Thrown only once the round's history is complete, so what the caller
    // keeps is a transcript the next turn can be appended to.
    if (abortedMidRound) throw new DOMException("Aborted", "AbortError");

    // Now that every surviving call has its reply, tell the model about the
    // ones the cap ate. Placed after the tool replies rather than instead of
    // them so a round that got one call through keeps that work.
    if (brokenCalls.length > 0) {
      if (!(await mayRecoverFromTruncation())) {
        return {
          rounds: round,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedTokens: totalCachedTokens,
          outcome: "completed",
        };
      }
      opts.onEvent({
        kind: "output-truncated",
        round,
        stopReason: roundStopReason,
        recovery: { kind: "tool-args", attempt: truncationRecoveries },
        at: Date.now(),
      });
      history.push({
        role: "user",
        content: i18n.t("ai.instructions.truncatedToolCall", {
          defaultValue:
            "【系统提示】你上一轮的工具调用（{{tools}}）因为超出输出上限被截断，已被丢弃："
            + "它没有执行，也没有写入任何内容。一次回复装不下的内容，必须分多次写："
            + "先用 create_file 建好骨架（结构 + 每节一行 `<!-- SECTION: 名字 -->` 占位注释），"
            + "再用 append_file 一节一节追加（每次只发这一节）。不要原样重发刚才那次调用。",
          tools: [...new Set(brokenCalls.map((tc) => tc.name))].join("、"),
        }),
      });
    }
  }

  // Fell through maxRounds without the model producing text — shouldn't happen
  // for force-text presets (the last round withholds tools), but return usage
  // defensively rather than throwing away a completed run's accounting.
  return {
    rounds: maxRounds,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cachedTokens: totalCachedTokens,
    outcome: "completed",
  };
}
