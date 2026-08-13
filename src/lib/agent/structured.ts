/**
 * Structured output for agent tasks — the unified "give me JSON that matches
 * this schema" path.
 *
 * Strategy (extracted from LoreMetaImproveModal, where it was battle-tested):
 *   1. Forced tool call: present ONE pseudo-tool whose parameters are the
 *      output schema and force it via tool_choice — reliable structure on
 *      models that support function calling.
 *   2. JSON fallback: reasoning/"thinking" models (e.g. DeepSeek reasoner)
 *      reject a forced tool_choice or return no call — fall back to a plain
 *      "respond with only JSON" request parsed with extractJsonObject.
 *
 * Single-shot by design: JSON mode and forced tool_choice both conflict with a
 * free tool loop, so structured tasks don't browse. When a task needs both
 * (investigate → structured result), run an agent loop first and feed its
 * findings into a structured call.
 */

import { streamCompletion } from "../ai";
import { pickConnOptions, type ConnOptions } from "../ai/conn";
import { jsonModeShaping } from "../ai/jsonMode";
import type { ContentPart, StreamMessage, ToolDefinition } from "../ai/types";
import { extractJsonObject } from "../ai/json";

export interface StructuredTaskArgs extends ConnOptions {
  /** Base system prompt (no output-format instructions — added per path). */
  systemPrompt: string;
  /** Appended to the system prompt on the forced-tool path. */
  toolInstruction: string;
  /** Appended on the JSON-fallback path (describe the exact JSON shape). */
  jsonInstruction: string;
  /** Pseudo-tool whose parameters are the output schema. Never executed. */
  outputTool: ToolDefinition;
  userContent: string | ContentPart[];
  signal?: AbortSignal;
  /** Raw streamed text (fallback path, or stray prose around a tool call). */
  onText?: (accumulated: string) => void;
  /**
   * The model's reasoning, accumulated. Only endpoints that expose it call
   * this; on every other model it never fires and the caller shows nothing.
   */
  onReasoning?: (accumulated: string) => void;
}

/**
 * Errors that mean "this model can't do forced tool calls" → fall back to JSON.
 *
 * Bare substrings like "does not support" or "function call" used to be
 * enough to trigger the fallback — but those also show up in genuine,
 * unrelated upstream errors ("does not support streaming for this region",
 * "invalid function call: missing required argument"), which would silently
 * retry the whole request as a second, different-shaped call instead of
 * surfacing the real problem — doubling cost and hiding the actual error.
 * Require the capability word (function/tool call[s][ing]) to appear
 * *together with* an explicit "not supported" phrasing, not just anywhere in
 * the message.
 */
const CAPABILITY_WORD = "(?:function|tool)s?[ _-]?calls?(?:ing)?";
const TOOL_CAPABILITY_ERROR = new RegExp(
  [
    "tool[_ ]?choice",
    "thinking mode",
    `does not support ${CAPABILITY_WORD}`,
    `${CAPABILITY_WORD}(?: is| are)? not supported`,
    `no support for ${CAPABILITY_WORD}`,
    "EMPTY_TOOL_CALL",
  ].join("|"),
  "i",
);

/** The text a multimodal user turn carries, for the "json" precondition check. */
function userText(content: string | ContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

/**
 * Run one structured task and resolve with the raw JSON string of the result
 * (already extracted, not yet parsed — callers own their schema validation).
 */
export async function runStructuredTask(args: StructuredTaskArgs): Promise<string> {
  const common = { ...pickConnOptions(args), signal: args.signal };
  const toolName = args.outputTool.function.name;

  let reasoning = "";
  const noteReasoning = (chunk: { reasoning: string }) => {
    reasoning += chunk.reasoning;
    args.onReasoning?.(reasoning);
  };

  const runTool = async (): Promise<string> => {
    let acc = "";
    let toolArgs = "";
    const messages: StreamMessage[] = [
      { role: "system", content: `${args.systemPrompt}\n${args.toolInstruction}` },
      { role: "user", content: args.userContent },
    ];
    await streamCompletion({
      ...common,
      messages,
      tools: [args.outputTool],
      toolChoice: { type: "function", function: { name: toolName } },
      onChunk: (chunk) => {
        if ("reasoning" in chunk) {
          noteReasoning(chunk);
        } else if ("text" in chunk) {
          acc += chunk.text;
          args.onText?.(acc);
        } else if ("toolCalls" in chunk) {
          const call = chunk.toolCalls.find((c) => c.name === toolName) ?? chunk.toolCalls[0];
          if (call) toolArgs = call.arguments;
        }
      },
    });
    if (!toolArgs.trim()) throw new Error("EMPTY_TOOL_CALL");
    return toolArgs;
  };

  const runJson = async (): Promise<string> => {
    let acc = "";
    args.onText?.("");
    const messages: StreamMessage[] = [
      { role: "system", content: `${args.systemPrompt}\n${args.jsonInstruction}` },
      { role: "user", content: args.userContent },
    ];
    // Native JSON enforcement on top of the prose instruction, not instead of
    // it. This path exists because the model refused a forced tool choice —
    // which is exactly what a *thinking* model does — so it used to be the one
    // place structured output had no enforcement at all, on the models least
    // likely to volunteer clean JSON.
    const json = jsonModeShaping(
      args.standard,
      `${args.systemPrompt}\n${args.jsonInstruction}\n${userText(args.userContent)}`,
    );
    if (json.cue) messages.push({ role: "user", content: json.cue });
    await streamCompletion({
      ...common,
      messages,
      extraBody: json.extraBody,
      onChunk: (chunk) => {
        if ("reasoning" in chunk) {
          noteReasoning(chunk);
        } else if ("text" in chunk) {
          acc += chunk.text;
          args.onText?.(acc);
        }
      },
    });
    return extractJsonObject(acc);
  };

  try {
    return await runTool();
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // Only fall back for tool-capability failures; surface real errors as-is.
    if (!TOOL_CAPABILITY_ERROR.test(msg)) throw err;
    return runJson();
  }
}
