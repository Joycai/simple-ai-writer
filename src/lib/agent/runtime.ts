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
import { createServerToolLog, type AgentEvent, type RoundLimitDecision } from "./events";

// Re-exported: callers reach the round-cap contract through the runtime that
// enforces it, not through the event module that only has to describe it.
export type { RoundLimitDecision };
import { contentWithoutImages, hasImageParts } from "./imageHistory";
import { TOOL_ARGS_DETAIL_CHARS, TOOL_RESULT_DETAIL_CHARS } from "./logFormat";
import type { TaskPreset } from "./presets";
import { executeRegisteredTool, getToolDefinitions, type ToolContext } from "./registry";
import { loadTaskDoc, parseSteps, type TaskStep } from "./taskWorkspace";
import type { ToolCall, ToolResult } from "./tools";

/** Stand-in left behind when an old tool result is dropped to reclaim room. */
const ELIDED_TOOL_RESULT =
  "[earlier tool result dropped to stay within the model's context window]";
/** Stand-in for a tool call that never ran, because the run was stopped. */
const ABORTED_TOOL_RESULT = "[not run — the user stopped the task]";
/** Stand-in left behind where an earlier picture was dropped to reclaim room. */
const ELIDED_IMAGE =
  "[earlier image dropped to stay within the model's context window]";

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
   * Input-token ceiling from the context budget planner (lib/context/budget).
   * Older tool results are elided to stay under it, so a long loop degrades
   * instead of dying on a ContextSizeError several rounds in. Omit to disable.
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
}

export async function runAgent(opts: AgentRuntimeOptions): Promise<AgentRunResult> {
  const { preset } = opts;
  const history = opts.messages;
  const toolDefinitions = getToolDefinitions(preset.tools);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  /** Text from rounds that ended in prose — the run's output as it stands. */
  let committedText = "";

  // Mutable: the author can extend it at the cap via onRoundLimit.
  let maxRounds = preset.maxRounds;
  let checkpointArmed = false;
  /** Tool rounds since the model last wrote to the checklist — see TASK_NUDGE_ROUNDS. */
  let roundsSinceTaskTouch = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");

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
      preset.finishPolicy === "force-text" &&
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

    const withholdTools =
      preset.tools.length === 0 || (isLastRound && preset.finishPolicy === "force-text");
    const serverToolPolicy = preset.serverTools ?? "final-round-off";
    const withholdServerTools =
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

    let roundToolCalls: AccumulatedToolCall[] = [];
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
      at: Date.now(),
    });

    try {
      await streamCompletion({
        ...pickConnOptions(opts),
        messages: history,
        extraBody: opts.extraBody,
        tools: withholdTools ? undefined : toolDefinitions,
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
            // Said out loud rather than swallowed: a truncated round looks
            // exactly like a finished one from the outside, and the author's
            // next move (raise the output cap / shorten the context) depends
            // entirely on knowing which it was.
            if (chunk.truncated) {
              opts.onEvent({
                kind: "output-truncated",
                round,
                stopReason: chunk.stopReason,
                at: Date.now(),
              });
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

    // Append the assistant's tool-call message to history.
    //
    // Both `_` fields carry what a thinking model needs to see of its own
    // previous turn: Gemini's thought signatures, and the reasoning text the
    // OpenAI-compatible thinking endpoints require echoed back. Dropping either
    // one doesn't degrade the answer — it makes the *next* round of the loop
    // fail outright, which is why they ride on the message rather than being
    // reconstructed later.
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

    // Execute each tool call and append results. Re-checked per call, not just
    // per round: the model can emit several tool calls in one round (e.g. a
    // propose_edit followed by write-auto lore calls), and an abort mid-round
    // — including one that arrives *as* rejectAll() resolves a blocked
    // approval — must stop the remaining calls in this same array rather than
    // only taking effect at the next round's top-of-loop check.
    // An abort part-way through must still leave every tool_call answered —
    // the assistant message naming N of them is already in `history`, and
    // `history` IS the chat session's history. Stopping with k < N replies
    // used to wedge the conversation permanently: the next turn appended a
    // user message onto a malformed transcript and every provider rejected it.
    let abortedMidRound = false;
    let touchedChecklist = false;
    for (const tc of roundToolCalls) {
      if (abortedMidRound || opts.signal.aborted) {
        abortedMidRound = true;
        history.push({ role: "tool", tool_call_id: tc.id, content: ABORTED_TOOL_RESULT });
        continue;
      }
      const toolCall: ToolCall = { id: tc.id, name: tc.name, arguments: tc.arguments };
      // Kept as valid JSON rather than pre-truncated: the log formats these for
      // display (lib/agent/logFormat), and it can only pull out the identifying
      // argument if the object still parses. Bounded by what the model emits.
      const argumentSummary = tc.arguments.length > TOOL_ARGS_DETAIL_CHARS
        ? tc.arguments.slice(0, TOOL_ARGS_DETAIL_CHARS)
        : tc.arguments;

      opts.onEvent({
        kind: "tool-step",
        step: { round, toolCallId: tc.id, name: tc.name, argumentSummary, status: "running" },
        at: Date.now(),
      });

      // Executor never throws — bad calls come back as error-text results the
      // model can read and correct on the next round.
      const callContext: ToolContext = {
        ...opts.toolContext,
        signal: opts.signal,
        onNestedEvent: opts.onEvent,
      };
      const result: ToolResult = await executeRegisteredTool(
        toolCall,
        preset.tools,
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
        },
        at: Date.now(),
      });

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
    roundsSinceTaskTouch = touchedChecklist ? 0 : roundsSinceTaskTouch + 1;
    // Thrown only once the round's history is complete, so what the caller
    // keeps is a transcript the next turn can be appended to.
    if (abortedMidRound) throw new DOMException("Aborted", "AbortError");
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
