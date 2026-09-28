/**
 * DashScope's native protocol (百炼 `/api/v1`) — the multimodal generation
 * endpoint, streamed.
 *
 * The body is Chat Completions' fields in another envelope: `{model, input:
 * {messages}, parameters}`, where `parameters` takes the same names with the
 * same meaning (百炼's compatible mode is a translation onto these). So the
 * fields come from `chatParams` and the streamed choice is read by the same
 * `chatDelta` reader; what is this file's own is the envelope, the content
 * parts' spelling, and the SSE framing (docs/api/dashscope-native-plan.md).
 *
 * Only the multimodal endpoint. The model decides which of the two native
 * endpoints answers — qwen3.7 / qwen3.8 only the multimodal one, older text
 * models (qwen-plus) only `text-generation` — and a wrong pick is a 400
 * `url error` (measured 2026-09-28). The models this route is for are the
 * multimodal ones; for the rest the error says to use the Chat route.
 */

import { fetch } from "../http";
import { unsendablePart } from "./mediaParts";
import { planRequest } from "./capability/plan";
import { chatParams, toWireMessages } from "./openai";
import { createChatDeltaReader } from "./chatDelta";
import { nativeUrl } from "./urls";
import type { StreamOptions } from "./types";

const LABEL = "DashScope";

/** The one endpoint this route speaks. */
export const NATIVE_CHAT_PATH = "/services/aigc/multimodal-generation/generation";

/**
 * One content part as the native protocol spells it: a bare `{text}` or
 * `{image}` object, no `type`. `detail` has no native spelling and is dropped.
 * A clip or a file has no spelling here and is refused by name
 * (`unsendablePart`) — a backstop, not the decision about what to send.
 */
function nativePart(part: Record<string, unknown>): Record<string, unknown> {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "image_url":
      return { image: (part.image_url as { url: string }).url };
    default:
      throw unsendablePart(LABEL, part);
  }
}

/**
 * The app's messages on this wire: the Chat Completions ones (`_` fields
 * stripped, reasoning re-expressed under its own name — the native protocol
 * takes `reasoning_content` back the same way), with array content respelled.
 */
export function toNativeMessages(opts: Pick<StreamOptions, "messages" | "modelId">): Record<string, unknown>[] {
  return toWireMessages(opts.messages, opts.modelId).map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: (m.content as Record<string, unknown>[]).map(nativePart) }
      : m,
  );
}

/** The request body, exposed for the probes and the golden snapshots. */
export function nativeBody(opts: StreamOptions): Record<string, unknown> {
  const plan = opts._plan ?? planRequest(opts);
  return {
    model: opts.modelId,
    input: { messages: toNativeMessages(opts) },
    parameters: {
      result_format: "message",
      // Each frame carries only what is new — the shape the shared reader
      // accumulates. Without it every frame repeats the whole answer so far.
      incremental_output: true,
      // Everything a Chat Completions body carries past its envelope, the
      // author's escape hatch (`extraBody`) and the JSON mode's
      // `response_format` included: a field that is not the envelope's is a
      // parameter here. No `stream_options`: every frame reports usage itself.
      ...chatParams(opts, plan),
    },
  };
}

/** What a 400 `url error` means on this route, for the author. */
const URL_ERROR_HINT =
  " — this model answers on DashScope's text-generation endpoint, which this route does not speak; switch the model to the Chat route";

export async function streamDashscope(opts: StreamOptions): Promise<void> {
  if (!opts.baseUrl.trim()) throw new Error(`${LABEL}: the route has no address`);
  const url = nativeUrl(opts.baseUrl, NATIVE_CHAT_PATH);
  const body = nativeBody(opts);
  opts._onRequestBody?.(body);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      // Without it the endpoint answers with one JSON body at the end.
      "X-DashScope-SSE": "enable",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DashScope API error ${res.status} (${url}): ${err}${/url error/i.test(err) ? URL_ERROR_HINT : ""}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  const choices = createChatDeltaReader(opts, LABEL);
  // A frame is `id:` / `event:` / `:HTTP_STATUS/…` / `data:` lines ended by a
  // blank one. Only `event` and `data` are read; the status line is an SSE
  // comment and says the same thing `event:error` does.
  let event = "";
  let buffer = "";
  // Whether the last frame came — the one with a real finish reason. This wire
  // has no `[DONE]`; that frame is the only sign the answer is whole.
  let finished = false;

  const parseData = (data: string) => {
    let json: any; // JSON.parse's return type — matches openai.ts's untyped access
    try {
      json = JSON.parse(data);
    } catch {
      return; // ignore malformed SSE lines
    }
    // A failure mid-stream (a refused image, a moderation stop, an outage)
    // arrives on a 200 as an `error` frame: `{code, message, request_id}`.
    if (event === "error" || (json.code && !json.output)) {
      throw new Error(`${LABEL}: ${json.code ?? "error"}: ${json.message ?? data}`);
    }
    if (json.usage) {
      // Cumulative on every frame, so the last one is the turn's.
      inputTokens = json.usage.input_tokens ?? inputTokens;
      outputTokens = json.usage.output_tokens ?? outputTokens;
      cachedTokens = json.usage.prompt_tokens_details?.cached_tokens ?? cachedTokens;
    }
    const choice = json.output?.choices?.[0];
    if (choice) {
      // `"null"` — a string — on every frame before the last.
      const finish = choice.finish_reason === "null" ? undefined : choice.finish_reason;
      if (typeof finish === "string" && finish) finished = true;
      choices.read({ delta: choice.message, finish_reason: finish });
    }
  };

  const readLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      event = "";
      return;
    }
    if (trimmed.startsWith("event:")) event = trimmed.slice(6).trim();
    else if (trimmed.startsWith("data:")) parseData(trimmed.slice(5).trim());
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the last (possibly incomplete) line for next read
    for (const line of lines) readLine(line);
  }
  // No sentinel on this wire: the stream simply ends.
  readLine(buffer);
  // A stream closed between frames would otherwise hand half an answer over
  // as a whole one (streaming.md, the failures that look like success).
  if (!finished) throw new Error(`${LABEL}: the stream ended before the answer finished (no finish_reason)`);

  const { stopReason, truncated } = choices.finish();
  opts.onChunk({
    done: true, inputTokens, outputTokens,
    ...(truncated ? { truncated } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(cachedTokens ? { cachedTokens } : {}),
  });
}
