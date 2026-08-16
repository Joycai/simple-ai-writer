/**
 * OpenAI (and compatible) streaming adapter — chat/completions with SSE parsing.
 */

import { fetch } from "../http";
import {
  createThinkTagSplitter, readReasoningDelta, reasoningBody, type NativeReasoning,
} from "./reasoning";
import { openaiUrl } from "./urls";
import type { AccumulatedToolCall, StreamMessage, StreamOptions } from "./types";

/**
 * Turn the app's messages into wire messages.
 *
 * Two jobs, both about the `_`-prefixed fields the app carries on a message for
 * its own bookkeeping. They must not reach the wire as-is — an endpoint that
 * validates its input strictly is entitled to reject an unknown key, and one
 * that doesn't would just be billed for the noise.
 *
 *   1. Drop them.
 *   2. Re-express `_reasoning` under the field name it arrived on, because this
 *      protocol's thinking endpoints require the reasoning of a tool-calling
 *      turn back verbatim (see `StreamMessage`).
 *
 * Endpoints that never send reasoning produce messages with no `_reasoning`,
 * so this is a no-op for them and their requests are unchanged.
 */
function toWireMessages(messages: StreamMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const bag = m as Record<string, unknown>;
    // Drop by prefix rather than by name: every protocol that needs carry-back
    // adds a field here, and an allow-list of names silently lets the next one
    // through to the wire.
    const wire = Object.fromEntries(
      Object.entries(bag).filter(([k]) => !k.startsWith("_")),
    );
    const reasoning = bag._reasoning as NativeReasoning | undefined;
    return reasoning ? { ...wire, [reasoning.field]: reasoning.text } : wire;
  });
}

export async function streamOpenAI(opts: StreamOptions): Promise<void> {
  const url = openaiUrl(opts.baseUrl, "/chat/completions");
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
      messages: toWireMessages(opts.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.tools ? { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" } : {}),
      // Absent unless the author set an effort on this model — an unset model
      // must keep sending exactly what it sent before this existed, because a
      // volunteered field is a field some relay can reject.
      // Declared dialect only, no dialectFor(): absent means "this endpoint
      // speaks the standard reasoning_effort", not a guessed generation.
      ...reasoningBody(opts.standard, opts.reasoningEffort, opts.thinkingDialect),
      // Last: extraBody is the per-request escape hatch and outranks config.
      ...opts.extraBody,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status} (${url}): ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let truncated = false;
  // Index-keyed map for accumulating streamed tool_calls across SSE chunks
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
  // Accumulated across the whole response so the tool-call chunk below can hand
  // the round's reasoning back whole. `field` is whichever name this endpoint
  // used — remembered so the echo matches (see reasoning.ts NativeReasoning).
  let reasoning: NativeReasoning | null = null;
  // Endpoints that don't separate thinking from the answer wrap it in
  // <think>…</think> inside `content`. Unsplit, that prose reaches the
  // manuscript. A no-op for every endpoint that doesn't do it.
  const inlineThink = createThinkTagSplitter();
  // Display only, deliberately not accumulated into `reasoning` above: text
  // that arrived *inside* `content` has no wire field of its own, so there is
  // nothing to echo it back under. Inventing a name would put a key no endpoint
  // knows into the next request.
  const emit = (pieces: ReturnType<typeof inlineThink.push>) => {
    for (const piece of pieces) opts.onChunk(piece);
  };
  // Carry an incomplete trailing line across reads: a single SSE line can be split
  // across network chunks, and parsing the halves would silently drop tokens/usage.
  let buffer = "";

  const emitToolCalls = () => {
    if (toolCallMap.size === 0) return;
    const toolCalls: AccumulatedToolCall[] = [...toolCallMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, tc]) => ({ index, id: tc.id, name: tc.name, arguments: tc.args }));
    opts.onChunk({ toolCalls, ...(reasoning ? { _reasoning: reasoning } : {}) });
  };

  const parseData = (data: string) => {
    let json: any; // JSON.parse's return type — matches the rest of this file's untyped access
    try {
      json = JSON.parse(data);
    } catch {
      return; // ignore malformed SSE lines
    }
    // A relay can return HTTP 200 and then deliver a failure (moderation
    // block, upstream outage, credit exhaustion) as an SSE data event rather
    // than an error status — OpenRouter does this routinely. Left unhandled,
    // the stream would just end with whatever partial usage/text arrived
    // before the failure, reported as a normal success.
    if (json.error) {
      const err = json.error as { message?: string } | string | undefined;
      const msg = typeof err === "string" ? err : err?.message ?? JSON.stringify(json.error);
      throw new Error(`OpenAI: ${msg}`);
    }
    // The same failure mode under a second name. Some endpoints report auth
    // failure, rate limiting, insufficient balance and internal errors as a
    // status object on an HTTP 200 body instead of the `error` field above —
    // `status_code: 0` is success, anything else is not. Left unhandled, an
    // expired key reads as a normal empty completion.
    const base = json.base_resp as { status_code?: number; status_msg?: string } | undefined;
    if (base && typeof base.status_code === "number" && base.status_code !== 0) {
      throw new Error(`OpenAI: ${base.status_msg || `status_code ${base.status_code}`}`);
    }
    if (json.usage) {
      inputTokens = json.usage.prompt_tokens ?? 0;
      outputTokens = json.usage.completion_tokens ?? 0;
      // A subset of prompt_tokens, not additional to it — only the uncached
      // remainder bills at the full input rate.
      cachedTokens = json.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) emit(inlineThink.push(delta.content));
    // Thinking endpoints stream reasoning beside the answer, under a field name
    // they don't agree on. Streamed for display and accumulated for the echo;
    // an endpoint that sends none leaves both untouched.
    const think = delta ? readReasoningDelta(delta as Record<string, unknown>) : null;
    if (think) {
      reasoning = { field: think.field, text: (reasoning?.text ?? "") + think.text };
      opts.onChunk({ reasoning: think.text });
    }
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
    // content_filter fires with little or no text — Azure OpenAI and several
    // compat gateways signal it this way instead of an error status. Throw so
    // it's treated as the safety refusal it is (modelHealth.isSafetyBlockMessage
    // matches "content_filter") rather than a normal empty completion.
    if (choice?.finish_reason === "content_filter") {
      throw new Error("OpenAI: response was blocked (finish_reason: content_filter)");
    }
    if (choice?.finish_reason === "length") truncated = true;
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
        emit(inlineThink.flush());
        emitToolCalls();
        opts.onChunk({
          done: true, inputTokens, outputTokens,
          ...(truncated ? { truncated } : {}),
          ...(cachedTokens ? { cachedTokens } : {}),
        });
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
  emit(inlineThink.flush());
  emitToolCalls();
  opts.onChunk({
    done: true, inputTokens, outputTokens,
    ...(truncated ? { truncated } : {}),
    ...(cachedTokens ? { cachedTokens } : {}),
  });
}
