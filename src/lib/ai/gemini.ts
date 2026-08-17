/**
 * Gemini streaming adapter — streamGenerateContent with SSE parsing, plus the
 * OpenAI-message → Gemini-contents conversion (incl. tool call round-trips).
 */

import { fetch } from "../http";
import { reasoningBody } from "./reasoning";
import { toSafetySettingsArray } from "./safety";
import { geminiUrl } from "./urls";
import type {
  AccumulatedToolCall, AuthMode, MessageContent, StreamMessage, StreamOptions,
} from "./types";

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } };

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

function parseJsonArgs(argsStr: string): Record<string, unknown> {
  try { return JSON.parse(argsStr) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Exported for the image client (./image.ts), which speaks to the same
 * `generateContent` endpoint and must build `contents` identically — including
 * the data-URL → inlineData conversion below.
 */
export function convertToGeminiContents(messages: StreamMessage[]): GeminiContent[] {
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
          // Images and files both travel as data URLs, and Gemini takes both as
          // inlineData — a PDF is just inlineData with an application/pdf mime.
          const dataUrl = p.type === "file" ? p.file.file_data : p.image_url.url;
          const [meta, data] = dataUrl.split(",");
          const mimeType = meta.slice("data:".length).replace(";base64", "");
          return { inlineData: { mimeType, data } };
        })
      : [{ text: regularMsg.content as string }];
    contents.push({ role, parts });
    i++;
  }
  return contents;
}

/**
 * `candidates[0].finishReason` values that mean the response was refused or
 * filtered rather than completed — as opposed to `STOP` (normal) or
 * `MAX_TOKENS` (truncated, but real output). Unlike `promptFeedback.blockReason`
 * (checked before generation starts), these can arrive after partial text has
 * already streamed — e.g. the safety filter tripping mid-response.
 */
const GEMINI_BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "RECITATION",
  "SPII",
  "IMAGE_SAFETY",
]);

/**
 * `finishReason` values that report a malformed *request* rather than a refused
 * response, each with what actually went wrong.
 *
 * These are the reason this check can't just be "is it in the blocked set":
 * a request that loses a thought signature comes back **HTTP 200 with a
 * finishReason**, so treating anything outside the blocked set as success reads
 * it as a normal short answer. And reporting it as a safety filter would send
 * the author looking at their prose for something that isn't there.
 */
const GEMINI_REQUEST_FAULTS: Record<string, string> = {
  // Thinking models bind their reasoning to a signature that must be echoed
  // back verbatim on later turns (see `_geminiModelParts`). This fires when one
  // went missing — a bug on this side, not anything the author wrote.
  MISSING_THOUGHT_SIGNATURE:
    "a thought signature was missing from the request history",
  // The model asked for a tool the request never offered.
  UNEXPECTED_TOOL_CALL: "the model called a tool that this request didn't declare",
  // The server cut a runaway tool loop short.
  TOO_MANY_TOOL_CALLS: "the model called tools too many times in a row",
  MALFORMED_RESPONSE: "the model returned a malformed response",
};

/**
 * How the key is presented.
 *
 * `x-goog-api-key` is what Google's own endpoint wants, and stays the default.
 * Relays fronting Gemini commonly want `Authorization: Bearer` instead — an
 * endpoint expecting one and receiving the other answers 401, so this is the
 * difference between reachable and not. `both` covers a gateway whose docs
 * don't say which; it is offered only on the compat standard, since sending two
 * credentials to Google's own endpoint could only ever hurt.
 *
 * The query-string form (`?key=`) is deliberately absent: it leaks the key into
 * proxy logs and error messages.
 */
export function geminiAuthHeaders(apiKey: string, authMode?: AuthMode): Record<string, string> {
  const mode = authMode ?? "default";
  return {
    ...(mode === "bearer" ? {} : { "x-goog-api-key": apiKey }),
    ...(mode === "default" ? {} : { Authorization: `Bearer ${apiKey}` }),
  };
}

export async function streamGemini(opts: StreamOptions): Promise<void> {
  // Key goes in the x-goog-api-key header, never the URL — query strings leak
  // into proxy/server logs and error messages.
  const url = geminiUrl(opts.baseUrl, `/models/${opts.modelId}:streamGenerateContent?alt=sse`);

  const systemMsg = opts.messages.find((m) => m.role === "system");
  const nonSystemMsgs = opts.messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    contents: convertToGeminiContents(nonSystemMsgs),
    ...opts.extraBody,
  };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }
  if (opts.tools?.length) {
    body.tools = [{
      functionDeclarations: opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }];
    // Translate toolChoice → Gemini's functionCallingConfig. "auto"/undefined
    // leaves the default (AUTO). "required"/a specific function force a call
    // (ANY), optionally restricted to one allowed function name.
    const tc = opts.toolChoice;
    if (tc && tc !== "auto") {
      const mode = tc === "none" ? "NONE" : "ANY";
      const allowed = typeof tc === "object" ? [tc.function.name] : undefined;
      body.toolConfig = {
        functionCallingConfig: {
          mode,
          ...(allowed ? { allowedFunctionNames: allowed } : {}),
        },
      };
    }
  }
  const safetySettings = toSafetySettingsArray(opts.safetySettings);
  if (safetySettings.length) {
    body.safetySettings = safetySettings;
  }

  // Merged one level deep rather than assigned: `generationConfig` is shared
  // territory — JSON mode already puts `responseMimeType` there via extraBody,
  // and a plain assign in either direction would drop the other's field.
  const thinking = reasoningBody(opts.standard, opts.reasoningEffort);
  if (thinking) {
    body.generationConfig = {
      ...(body.generationConfig as Record<string, unknown> | undefined),
      ...(thinking.generationConfig as Record<string, unknown>),
    };
  }

  console.debug("[Gemini request]", {
    model: opts.modelId,
    safetySettings: body.safetySettings ?? "(none)",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...geminiAuthHeaders(opts.apiKey, opts.authMode) },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status} (${url}): ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let truncated = false;
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
    const candidate = (json.candidates as Array<{ content?: { parts?: unknown[] }; finishReason?: string }> | undefined)?.[0];
    const rawParts: unknown[] = candidate?.content?.parts ?? [];
    const parts = rawParts as Array<{
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
      functionCall?: { name: string; args?: Record<string, unknown> };
    }>;
    for (const part of parts) {
      // Every part, thinking included, before any branching: the raw array is
      // what gets echoed back next turn, and a dropped thoughtSignature ends
      // the run with finishReason MISSING_THOUGHT_SIGNATURE.
      geminiAllModelParts.push(part);
      if (part.thought && part.text) {
        // Reasoning, kept away from `text`: that variant is what reaches the
        // manuscript. Arrives only when the request asked for it —
        // `includeThoughts` defaults to off (see reasoningBody).
        opts.onChunk({ reasoning: part.text });
      } else if (part.text) {
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
    const usage = json.usageMetadata as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      cachedContentTokenCount?: number;
    } | undefined;
    if (usage) {
      inputTokens = usage.promptTokenCount ?? 0;
      // Thinking models bill reasoning tokens as output, but candidatesTokenCount
      // excludes them — without this, a run that thinks for 5k tokens and
      // answers in 500 would record only 500 output tokens.
      outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
      // A subset of promptTokenCount, not additional to it.
      cachedTokens = usage.cachedContentTokenCount ?? 0;
    }
    // Response-level block/filter — distinct from promptFeedback.blockReason
    // above, which only covers the request being refused before generation
    // starts. Left unhandled, a mid-generation filter trip ends the stream
    // with whatever text streamed so far, reported as a normal completion.
    if (candidate?.finishReason && GEMINI_BLOCKED_FINISH_REASONS.has(candidate.finishReason)) {
      throw new Error(`Gemini blocked this response (${candidate.finishReason}). The content may have triggered a safety filter — try a different model or provider.`);
    }
    const fault = candidate?.finishReason && GEMINI_REQUEST_FAULTS[candidate.finishReason];
    if (fault) {
      throw new Error(`Gemini rejected this request (${candidate.finishReason}): ${fault}.`);
    }
    if (candidate?.finishReason === "MAX_TOKENS") truncated = true;
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
  opts.onChunk({
    done: true, inputTokens, outputTokens,
    ...(truncated ? { truncated } : {}),
    ...(cachedTokens ? { cachedTokens } : {}),
  });
}
