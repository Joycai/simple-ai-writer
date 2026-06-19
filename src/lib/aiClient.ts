/**
 * Streaming AI client supporting OpenAI (and compatible) + Gemini APIs.
 * Uses fetch() with SSE / streaming JSON parsing.
 */

import type { ApiStandard, GeminiSafetySettings } from "./aiConfig";
import { toSafetySettingsArray } from "./aiConfig";

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
  /** Tool definitions for OpenAI function calling. Ignored for Gemini. */
  tools?: ToolDefinition[];
  /** Extra top-level fields merged into the OpenAI request body (e.g. response_format). */
  extraBody?: Record<string, unknown>;
  /** Gemini-only: per-request safety filter thresholds. Ignored for OpenAI. */
  safetySettings?: GeminiSafetySettings;
}

// ─── OpenAI / compat ─────────────────────────────────────────────────────────

async function streamOpenAI(opts: StreamOptions): Promise<void> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.modelId,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
      ...opts.extraBody,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  // Index-keyed map for accumulating streamed tool_calls across SSE chunks
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
  // Carry an incomplete trailing line across reads: a single SSE line can be split
  // across network chunks, and parsing the halves would silently drop tokens/usage.
  let buffer = "";

  const emitToolCalls = () => {
    if (toolCallMap.size === 0) return;
    const toolCalls: AccumulatedToolCall[] = [...toolCallMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, tc]) => ({ index, id: tc.id, name: tc.name, arguments: tc.args }));
    opts.onChunk({ toolCalls });
  };

  const parseData = (data: string) => {
    try {
      const json = JSON.parse(data);
      if (json.usage) {
        inputTokens = json.usage.prompt_tokens ?? 0;
        outputTokens = json.usage.completion_tokens ?? 0;
      }
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) opts.onChunk({ text: delta.content });
      // Accumulate tool_calls across partial SSE chunks
      if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const partial of delta.tool_calls as Array<{
          index?: number; id?: string;
          function?: { name?: string; arguments?: string };
        }>) {
          const idx = partial.index ?? 0;
          if (!toolCallMap.has(idx)) toolCallMap.set(idx, { id: "", name: "", args: "" });
          const entry = toolCallMap.get(idx)!;
          if (partial.id) entry.id += partial.id;
          if (partial.function?.name) entry.name += partial.function.name;
          if (partial.function?.arguments) entry.args += partial.function.arguments;
        }
      }
    } catch {
      // ignore malformed SSE lines
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the last (possibly incomplete) line for next read
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        emitToolCalls();
        opts.onChunk({ done: true, inputTokens, outputTokens });
        return;
      }
      parseData(data);
    }
  }

  // Stream ended without a [DONE] sentinel — flush any buffered final line.
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const data = tail.slice(5).trim();
    if (data !== "[DONE]") parseData(data);
  }
  emitToolCalls();
  opts.onChunk({ done: true, inputTokens, outputTokens });
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } };

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

function parseJsonArgs(argsStr: string): Record<string, unknown> {
  try { return JSON.parse(argsStr) as Record<string, unknown>; } catch { return {}; }
}

function convertToGeminiContents(messages: StreamMessage[]): GeminiContent[] {
  // Build tool_call_id → function name map so functionResponse can include the name
  const toolCallIdToName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) {
      for (const tc of m.tool_calls) toolCallIdToName.set(tc.id, tc.function.name);
    }
  }

  const contents: GeminiContent[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "tool") {
      // Merge consecutive tool-result messages into one user message with functionResponse parts
      const parts: GeminiPart[] = [];
      while (i < messages.length && messages[i].role === "tool") {
        const tm = messages[i] as { role: "tool"; tool_call_id: string; content: string };
        const name = toolCallIdToName.get(tm.tool_call_id) ?? "unknown_function";
        parts.push({ functionResponse: { name, response: { content: tm.content } } });
        i++;
      }
      contents.push({ role: "user", parts });
      continue;
    }

    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      if (msg._geminiModelParts?.length) {
        // Use raw parts verbatim to preserve thoughtSignature required by thinking models
        contents.push({ role: "model", parts: msg._geminiModelParts as GeminiPart[] });
      } else {
        contents.push({
          role: "model",
          parts: msg.tool_calls.map((tc) => ({
            functionCall: { name: tc.function.name, args: parseJsonArgs(tc.function.arguments) },
          })),
        });
      }
      i++;
      continue;
    }

    // Regular user / assistant message with string or ContentPart[] content
    const regularMsg = msg as { role: "user" | "assistant"; content: MessageContent };
    const role: "user" | "model" = regularMsg.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = Array.isArray(regularMsg.content)
      ? regularMsg.content.map((p) => {
          if (p.type === "text") return { text: p.text };
          const dataUrl = p.image_url.url;
          const [meta, data] = dataUrl.split(",");
          const mimeType = meta.slice("data:".length).replace(";base64", "");
          return { inline_data: { mime_type: mimeType, data } };
        })
      : [{ text: regularMsg.content as string }];
    contents.push({ role, parts });
    i++;
  }
  return contents;
}

/** Gemini API base used when a provider hasn't configured a custom endpoint. */
const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

async function streamGemini(opts: StreamOptions): Promise<void> {
  const base = (opts.baseUrl || DEFAULT_GEMINI_BASE).replace(/\/$/, "");
  const url = `${base}/models/${opts.modelId}:streamGenerateContent?key=${opts.apiKey}&alt=sse`;

  const systemMsg = opts.messages.find((m) => m.role === "system");
  const nonSystemMsgs = opts.messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    contents: convertToGeminiContents(nonSystemMsgs),
    ...opts.extraBody,
  };
  if (systemMsg) {
    body.system_instruction = { parts: [{ text: systemMsg.content }] };
  }
  if (opts.tools?.length) {
    body.tools = [{
      functionDeclarations: opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }];
  }
  const safetySettings = toSafetySettingsArray(opts.safetySettings);
  if (safetySettings.length) {
    body.safetySettings = safetySettings;
  }

  console.debug("[Gemini request]", {
    model: opts.modelId,
    safetySettings: body.safetySettings ?? "(none)",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  const geminiToolCalls: AccumulatedToolCall[] = [];
  // Accumulate ALL model parts across chunks (including thought/thoughtSignature parts)
  // so they can be echoed back verbatim in subsequent turns — required by thinking models.
  const geminiAllModelParts: unknown[] = [];

  // Carry an incomplete trailing line across reads: a single SSE line can be split
  // across network chunks, and parsing the halves would silently drop content.
  let buffer = "";

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>;
    } catch {
      return; // skip malformed SSE lines
    }
    if (json.error) {
      const msg = (json.error as { message?: string }).message ?? JSON.stringify(json.error);
      throw new Error(`Gemini: ${msg}`);
    }
    const blockReason = (json.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini blocked this request (${blockReason}). The content may have triggered a safety filter — try a different model or provider.`);
    }
    const rawParts: unknown[] =
      (json.candidates as Array<{ content?: { parts?: unknown[] } }> | undefined)?.[0]?.content?.parts ?? [];
    const parts = rawParts as Array<{
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
      functionCall?: { name: string; args?: Record<string, unknown> };
    }>;
    for (const part of parts) {
      geminiAllModelParts.push(part);
      if (part.text && !part.thought) {
        opts.onChunk({ text: part.text });
      } else if (part.functionCall) {
        // Gemini sends complete functionCall objects (not streamed fragments)
        geminiToolCalls.push({
          index: geminiToolCalls.length,
          id: `gtc_${Date.now()}_${geminiToolCalls.length}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      }
    }
    const usage = json.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    if (usage) {
      inputTokens = usage.promptTokenCount ?? 0;
      outputTokens = usage.candidatesTokenCount ?? 0;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the last (possibly incomplete) line for next read
    for (const line of lines) processLine(line);
  }
  // Flush any buffered final line that arrived without a trailing newline.
  if (buffer.trim()) processLine(buffer);

  if (geminiToolCalls.length > 0) {
    opts.onChunk({ toolCalls: geminiToolCalls, _geminiModelParts: geminiAllModelParts });
  }
  opts.onChunk({ done: true, inputTokens, outputTokens });
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function streamCompletion(opts: StreamOptions): Promise<void> {
  if (opts.standard === "gemini") {
    return streamGemini(opts);
  }
  return streamOpenAI(opts);
}
