/**
 * Agentic tool-use loop for the "continue" task.
 * The AI calls tools to read history chapters and lore entities before writing.
 * MAX_ROUNDS caps the loop to prevent unbounded tool calls.
 */

import type { ApiStandard, GeminiSafetySettings } from "./aiConfig";
import type { ToolDefinition, StreamMessage, AccumulatedToolCall, ContentPart } from "./aiClient";
import { streamCompletion } from "./aiClient";
import type { ToolCall, ToolResult } from "./tools";
import { executeTool } from "./tools";
import type { LoreIndex } from "./lore";

const MAX_ROUNDS = 8;

export type ToolStepStatus = "running" | "done" | "error";

export interface ToolStep {
  round: number;
  toolCallId: string;
  name: string;
  /** Truncated argument JSON for display */
  argumentSummary: string;
  status: ToolStepStatus;
  /** First 80 chars of result content, set on done/error */
  resultSummary?: string;
}

export interface AgentLoopOptions {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
  /** Gemini-only: per-request safety filter thresholds. */
  safetySettings?: GeminiSafetySettings;
  systemPrompt: string;
  /** The assembled user message content (from RAG) for the first turn */
  initialUserMessage: string;
  projectPath: string;
  loreIndex: LoreIndex;
  tools: ToolDefinition[];
  signal: AbortSignal;
  onToolStep: (step: ToolStep) => void;
  onOutputChunk: (text: string) => void;
  onDone: (usage: { inputTokens: number; outputTokens: number }) => void;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const history: StreamMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.initialUserMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");

    // On the final round: inject a "write now" instruction and omit tools
    // so the model is forced to produce text without further tool calls.
    const isLastRound = round === MAX_ROUNDS;
    if (isLastRound) {
      history.push({
        role: "user",
        content:
          "You have reached the maximum number of tool calls. Please now write the continuation directly without calling any more tools.",
      });
    }

    let roundToolCalls: AccumulatedToolCall[] = [];
    let roundGeminiModelParts: unknown[] | undefined;

    await streamCompletion({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      standard: opts.standard,
      modelId: opts.modelId,
      messages: history,
      safetySettings: opts.safetySettings,
      tools: isLastRound ? undefined : opts.tools,
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
      opts.onDone({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
      return;
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

      opts.onToolStep({ round, toolCallId: tc.id, name: tc.name, argumentSummary, status: "running" });

      let result: ToolResult;
      try {
        result = await executeTool(toolCall, opts.projectPath, opts.loreIndex);
        opts.onToolStep({
          round,
          toolCallId: tc.id,
          name: tc.name,
          argumentSummary,
          status: "done",
          resultSummary: result.content.slice(0, 80),
        });
      } catch (e) {
        const errMsg = `Error: ${String(e)}`;
        opts.onToolStep({
          round,
          toolCallId: tc.id,
          name: tc.name,
          argumentSummary,
          status: "error",
          resultSummary: errMsg.slice(0, 80),
        });
        result = { toolCallId: tc.id, content: errMsg };
      }

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

  // Fell through MAX_ROUNDS without the model producing text — shouldn't happen
  // because the last round forces text output, but emit done defensively.
  opts.onDone({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
}
