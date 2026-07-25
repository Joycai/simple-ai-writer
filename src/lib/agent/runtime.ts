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

import { streamCompletion } from "../ai";
import type { GeminiSafetySettings } from "../ai/safety";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { AccumulatedToolCall, ApiStandard, ContentPart, StreamMessage } from "../ai/types";
import type { AgentEvent } from "./events";
import type { TaskPreset } from "./presets";
import { executeRegisteredTool, getToolDefinitions, type ToolContext } from "./registry";
import type { ToolCall, ToolResult } from "./tools";

/** Stand-in left behind when an old tool result is dropped to reclaim room. */
const ELIDED_TOOL_RESULT =
  "[earlier tool result dropped to stay within the model's context window]";

/**
 * Keep the growing history inside the planned input ceiling.
 *
 * The first turn is budgeted to fill the window up to the author's utilization
 * setting, which leaves the rest for whatever the tools drag in. Without this,
 * a long tool-using run trips the pre-flight check on round 5 or 6 — i.e. it
 * fails *after* the author has already waited through the whole loop.
 *
 * Oldest tool results go first: they are both the bulk of the growth and the
 * least likely to still matter. Their *messages* stay — an assistant tool_call
 * with no matching tool reply is a protocol error at both OpenAI and Gemini —
 * only the payload is replaced. The system prompt and the assembled first turn
 * are never touched; if those alone overflow, that is a planning bug and the
 * pre-flight check should say so rather than this quietly hiding it.
 *
 * Returns how many results were elided so the caller can log it.
 */
function trimHistory(history: StreamMessage[], ceilingTokens?: number): number {
  if (!ceilingTokens || ceilingTokens <= 0) return 0;
  if (estimateMessagesTokens(history) <= ceilingTokens) return 0;
  let dropped = 0;
  for (const m of history) {
    if (m.role !== "tool" || m.content === ELIDED_TOOL_RESULT) continue;
    m.content = ELIDED_TOOL_RESULT;
    dropped++;
    if (estimateMessagesTokens(history) <= ceilingTokens) break;
  }
  return dropped;
}

export interface AgentRunResult {
  /** Rounds actually consumed (≥1). */
  rounds: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRuntimeOptions {
  // ── Transport ──────────────────────────────────────────────────────────────
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
  /** Gemini-only: per-request safety filter thresholds. */
  safetySettings?: GeminiSafetySettings;
  /** Optional model-scoped prefix prompt. */
  prefix?: string;
  /** Optional model context window (tokens); checked before each round's request. */
  contextSize?: number;
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
  onOutputChunk: (text: string) => void;
}

export async function runAgent(opts: AgentRuntimeOptions): Promise<AgentRunResult> {
  const { preset } = opts;
  const history = opts.messages;
  const toolDefinitions = getToolDefinitions(preset.tools);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let round = 1; round <= preset.maxRounds; round++) {
    if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");

    // On the final round of a force-text task: inject a "write now" instruction
    // and omit tools so the model must produce text without further tool calls.
    const isLastRound = round === preset.maxRounds;
    const withholdTools =
      preset.tools.length === 0 || (isLastRound && preset.finishPolicy === "force-text");
    if (isLastRound && preset.finishPolicy === "force-text" && preset.tools.length > 0) {
      history.push({
        role: "user",
        content:
          "You have reached the maximum number of tool calls. Please now write the continuation directly without calling any more tools.",
      });
    }

    let roundToolCalls: AccumulatedToolCall[] = [];
    let roundGeminiModelParts: unknown[] | undefined;

    const dropped = trimHistory(history, opts.inputCeilingTokens);
    if (dropped > 0) {
      opts.onEvent({ kind: "context-trimmed", count: dropped, at: Date.now() });
    }

    opts.onEvent({
      kind: "round-start",
      round,
      maxRounds: preset.maxRounds,
      estInputTokens: estimateMessagesTokens(history),
      at: Date.now(),
    });

    await streamCompletion({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      standard: opts.standard,
      modelId: opts.modelId,
      prefix: opts.prefix,
      contextSize: opts.contextSize,
      messages: history,
      safetySettings: opts.safetySettings,
      extraBody: opts.extraBody,
      tools: withholdTools ? undefined : toolDefinitions,
      signal: opts.signal,
      onChunk: (chunk) => {
        if ("text" in chunk) {
          opts.onOutputChunk(chunk.text);
        } else if ("toolCalls" in chunk) {
          roundToolCalls = chunk.toolCalls;
          roundGeminiModelParts = chunk._geminiModelParts;
        } else if ("done" in chunk) {
          totalInputTokens += chunk.inputTokens;
          totalOutputTokens += chunk.outputTokens;
        }
      },
    });

    // No tool calls → model produced text → we're done
    if (roundToolCalls.length === 0) {
      return { rounds: round, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
    }

    // Append the assistant's tool-call message to history.
    // _geminiModelParts preserves thought signatures for Gemini thinking models.
    history.push({
      role: "assistant",
      content: null,
      tool_calls: roundToolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
      _geminiModelParts: roundGeminiModelParts,
    });

    // Execute each tool call and append results
    for (const tc of roundToolCalls) {
      const toolCall: ToolCall = { id: tc.id, name: tc.name, arguments: tc.arguments };
      const argumentSummary = tc.arguments.length > 60
        ? tc.arguments.slice(0, 60) + "…"
        : tc.arguments;

      opts.onEvent({
        kind: "tool-step",
        step: { round, toolCallId: tc.id, name: tc.name, argumentSummary, status: "running" },
        at: Date.now(),
      });

      // Executor never throws — bad calls come back as error-text results the
      // model can read and correct on the next round.
      const result: ToolResult = await executeRegisteredTool(
        toolCall,
        preset.tools,
        opts.toolContext,
      );
      const isError = result.content.startsWith("Error") || result.content.startsWith("Unknown tool");
      opts.onEvent({
        kind: "tool-step",
        step: {
          round,
          toolCallId: tc.id,
          name: tc.name,
          argumentSummary,
          status: isError ? "error" : "done",
          resultSummary: result.content.slice(0, 80),
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
  }

  // Fell through maxRounds without the model producing text — shouldn't happen
  // for force-text presets (the last round withholds tools), but return usage
  // defensively rather than throwing away a completed run's accounting.
  return {
    rounds: preset.maxRounds,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}
