/**
 * Shared protocol types for the streaming AI client.
 * Kept dependency-light so helpers (apiLog, tokenEstimate, agent loop) can
 * import types without pulling in the provider adapters.
 */

import type { GeminiSafetySettings } from "./safety";
import i18n from "../../i18n";

/** Wire protocol spoken by a provider endpoint. */
export type ApiStandard = "openai" | "openai_compat" | "gemini";

/** A single part inside a multimodal user message. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }; // url = data:<mime>;base64,<data>

export type MessageContent = string | ContentPart[];

// ─── Tool calling types (OpenAI API format) ──────────────────────────────────

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AccumulatedToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export type StreamChunk =
  | { text: string }
  | { done: true; inputTokens: number; outputTokens: number }
  | { toolCalls: AccumulatedToolCall[]; _geminiModelParts?: unknown[] };

/** All message variants accepted by the streaming API. */
export type StreamMessage =
  | { role: "system" | "user" | "assistant"; content: MessageContent }
  | { role: "assistant"; content: null; tool_calls: AssistantToolCall[]; _geminiModelParts?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
  messages: StreamMessage[];
  onChunk: (chunk: StreamChunk) => void;
  signal?: AbortSignal;
  /** Tool definitions for function calling. Honored by both OpenAI and Gemini. */
  tools?: ToolDefinition[];
  /**
   * Tool-choice strategy. Defaults to "auto" when tools are present. Pass
   * "required" to force *some* tool, or a specific function object to force
   * exactly that tool. Mapped to Gemini's tool_config.function_calling_config.
   */
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /** Extra top-level fields merged into the OpenAI request body (e.g. response_format). */
  extraBody?: Record<string, unknown>;
  /** Gemini-only: per-request safety filter thresholds. Ignored for OpenAI. */
  safetySettings?: GeminiSafetySettings;
  /** Optional model-scoped prefix prompt, prepended as the leading system instruction. */
  prefix?: string;
  /**
   * Optional model context window (tokens). When set, a request whose
   * estimated prompt size exceeds it is rejected with ContextSizeError
   * before anything is sent — servers like ollama would otherwise silently
   * truncate the head of the prompt (dropping the system instructions).
   */
  contextSize?: number;
}

/** Thrown before sending when the estimated prompt exceeds the model's configured context size. */
export class ContextSizeError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly contextSize: number,
  ) {
    super(i18n.t("ai.errors.contextExceeded", {
      estimated: estimatedTokens.toLocaleString(),
      limit: contextSize.toLocaleString(),
    }));
    this.name = "ContextSizeError";
  }
}

/**
 * Merge `prefix` into the head of `messages` as a leading system instruction.
 * If the first message is already a system message, the prefix is prepended to
 * its text content; otherwise a new system message is inserted at index 0.
 * Returns a new array — never mutates the input (callers like the agent loop
 * pass the same `history` array across rounds).
 */
export function applyPrefix(messages: StreamMessage[], prefix?: string): StreamMessage[] {
  if (!prefix || !prefix.trim()) return messages;
  const head = messages[0];
  if (head && head.role === "system") {
    const merged: StreamMessage =
      typeof head.content === "string"
        ? { role: "system", content: `${prefix}\n\n${head.content}` }
        : {
            role: "system",
            content: [{ type: "text", text: `${prefix}\n\n` }, ...head.content],
          };
    return [merged, ...messages.slice(1)];
  }
  return [{ role: "system", content: prefix }, ...messages];
}
