/**
 * Streaming AI client supporting OpenAI (and compatible) + Gemini APIs.
 * Uses fetch() with SSE / streaming JSON parsing.
 */

import type { ApiStandard } from "./aiConfig";

export type StreamChunk = { text: string } | { done: true; inputTokens: number; outputTokens: number };

/** A single part inside a multimodal user message. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }; // url = data:<mime>;base64,<data>

export type MessageContent = string | ContentPart[];

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
  messages: { role: "system" | "user" | "assistant"; content: MessageContent }[];
  onChunk: (chunk: StreamChunk) => void;
  signal?: AbortSignal;
  /** Extra top-level fields merged into the OpenAI request body (e.g. response_format). */
  extraBody?: Record<string, unknown>;
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        opts.onChunk({ done: true, inputTokens, outputTokens });
        return;
      }
      try {
        const json = JSON.parse(data);
        // Final chunk with usage
        if (json.usage) {
          inputTokens = json.usage.prompt_tokens ?? 0;
          outputTokens = json.usage.completion_tokens ?? 0;
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) opts.onChunk({ text: delta });
      } catch {
        // ignore malformed SSE lines
      }
    }
  }
  opts.onChunk({ done: true, inputTokens, outputTokens });
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

async function streamGemini(opts: StreamOptions): Promise<void> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.modelId}:streamGenerateContent?key=${opts.apiKey}&alt=sse`;

  // Convert OpenAI messages to Gemini format
  const systemMsg = opts.messages.find((m) => m.role === "system");
  const userMessages = opts.messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    contents: userMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: Array.isArray(m.content)
        ? m.content.map((p) => {
            if (p.type === "text") return { text: p.text };
            // image_url with data URI → Gemini inline_data
            const url = p.image_url.url; // "data:<mime>;base64,<data>"
            const [meta, data] = url.split(",");
            const mimeType = meta.slice("data:".length).replace(";base64", "");
            return { inline_data: { mime_type: mimeType, data } };
          })
        : [{ text: m.content }],
    })),
  };
  if (systemMsg) {
    body.system_instruction = { parts: [{ text: systemMsg.content }] };
  }

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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        const json = JSON.parse(trimmed.slice(5).trim());
        const part = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (part) opts.onChunk({ text: part });
        const usage = json.usageMetadata;
        if (usage) {
          inputTokens = usage.promptTokenCount ?? 0;
          outputTokens = usage.candidatesTokenCount ?? 0;
        }
      } catch {
        // ignore
      }
    }
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
