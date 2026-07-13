/**
 * OpenAI (and compatible) streaming adapter — chat/completions with SSE parsing.
 */

import { fetch } from "../http";
import type { AccumulatedToolCall, StreamOptions } from "./types";

export async function streamOpenAI(opts: StreamOptions): Promise<void> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Keyless local servers (Ollama, LM Studio) need no auth; omit the header
      // rather than sending an empty bearer token.
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.modelId,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.tools ? { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" } : {}),
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
