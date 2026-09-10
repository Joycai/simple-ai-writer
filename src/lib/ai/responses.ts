/**
 * OpenAI Responses (and compatible) streaming adapter — `POST {base}/responses`
 * with SSE parsing.
 *
 * A fourth protocol family rather than a switch inside the Chat Completions
 * adapter: the body (`instructions` + `input` items instead of `messages`),
 * the stream (typed events instead of `choices[].delta`), the tool shape
 * (flat, auto-strict) and the multi-turn echo obligation (whole output items
 * back, not an assistant message) all differ — see docs/api/landscape.md §3
 * and docs/api/responses.md for the measured protocol.
 *
 * Slices D and E of docs/api/qianwen-compat-plan.md §4.4: text streaming and
 * tool calling. What this file deliberately does not do yet, and where each
 * lands:
 *
 *   - Thinking is neither requested nor tuned (slice F: the `responses-effort`
 *     category and `reasoning: {effort, summary}`). The *read* side of the
 *     summary events is here already because it is three lines and harmless
 *     when nothing was requested.
 *   - Structured output stays on the prompt cue (slice G: `text.format`).
 *
 * Two request-side rules that are not optional, both from the plan §4.4:
 *
 *   - `store: false` on every request. The app keeps its own history, a copy
 *     on the server buys nothing, and zero-data-retention organisations are
 *     refused without it. It is also what makes the endpoint attach
 *     `encrypted_content` to reasoning items — the part of the echo below
 *     that carries the model's actual reasoning across a tool round.
 *   - `instructions` is **always** sent, even when empty. A relay that finds
 *     it absent injects its own system prompt — the New API relay measured in
 *     docs/api/landscape.md §7 第八个样本 adds 4.4K–7.5K tokens of Codex
 *     instructions per request that way.
 *
 * Tools (slice E), three decisions worth knowing before touching them:
 *
 *   - Definitions are flat (`{type, name, description, parameters}`, not the
 *     Chat Completions `function: {…}` wrapper) and carry an explicit
 *     `strict: false`. Omitting `strict` is not neutral on this wire — the
 *     endpoint upgrades to `strict: true` on its own (docs/api/responses.md
 *     §2.3), which rewrites the contract every schema in `lib/agent/registry`
 *     was written under (optional fields, `additionalProperties` unstated) into
 *     "all-required or 400". The Chat Completions adapter's schemas are
 *     non-strict; on this family that has to be said out loud.
 *   - Arguments arrive twice — as `function_call_arguments.delta` fragments and
 *     whole on `function_call_arguments.done` / `output_item.done`. The whole
 *     item wins when it arrives, the fragments are what the progress report
 *     is built from, and an endpoint that sends only one of the two still
 *     yields a complete call.
 *   - The echo is the turn's `output[]` verbatim, collected from
 *     `output_item.done` — reasoning item (encrypted) included — and handed
 *     back on the `toolCalls` chunk as `_responseItems`. The next request puts
 *     those items into `input` *in place of* the bare `function_call` mapping,
 *     never beside it. No forced-choice downgrade here: forcing while thinking
 *     is legal on this family (§2.3); an endpoint that nonetheless refuses is
 *     learned from its 400 by `lib/ai/toolChoice.ts` like any other.
 */

import { fetch } from "../http";
import { reasoningBody, resolveThinkingCategory } from "./reasoning";
import { openaiUrl } from "./urls";
import { createToolArgsProgress } from "./toolArgsProgress";
import type {
  AccumulatedToolCall, ContentPart, ResponseItemCarry, StreamMessage, StreamOptions,
  ToolDefinition,
} from "./types";

/** The text of a message whose content may be a string or a part list. */
function textOf(content: StreamMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * One user content part in this wire's spelling.
 *
 * `input_image` takes the data URL directly (verified on GPT-5.4/5.5,
 * docs/api/responses.md §7); `input_file` is the documented shape for a
 * base64 document and is unverified against a live endpoint — the plan's
 * slice H is where both get their tests. Mapping them here rather than
 * dropping them keeps a picture the author attached from vanishing silently
 * on this family.
 */
function toInputPart(part: ContentPart): Record<string, unknown> {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image_url":
      return { type: "input_image", image_url: part.image_url.url };
    case "file":
      return { type: "input_file", filename: part.file.filename, file_data: part.file.file_data };
  }
}

/**
 * The app's messages as `instructions` + `input` items.
 *
 * System messages leave the list and become `instructions` (joined, in order —
 * `applyPrefix` has already folded the model prefix into the first one).
 *
 * An assistant turn that called tools is echoed as the endpoint's own output
 * items when it has them and they came from the model being asked now
 * (`_responseItems`, see `ResponseItemCarry`); otherwise — a history that
 * began on another provider or another model, since the app allows switching
 * mid-conversation — as bare `function_call` items, the fourth of the echo
 * spellings the endpoint accepts (docs/api/responses.md §5). Tool results are
 * `function_call_output` either way. The other `_`-prefixed carriers are
 * dropped by construction: nothing here reads them.
 */
export function toResponsesInput(
  messages: StreamMessage[],
  modelId?: string,
): { instructions: string; input: Record<string, unknown>[] } {
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = textOf(m.content);
      if (text) instructions.push(text);
      continue;
    }
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
      continue;
    }
    if (m.role === "assistant" && m.content === null && "tool_calls" in m) {
      const carried = m._responseItems;
      if (carried && carried.items.length > 0 && (!modelId || carried.modelId === modelId)) {
        for (const item of carried.items) input.push(item as Record<string, unknown>);
        continue;
      }
      for (const call of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      input.push({ role: "user", content: m.content.map(toInputPart) });
      continue;
    }
    input.push({ role: m.role, content: textOf(m.content) });
  }
  return { instructions: instructions.join("\n\n"), input };
}

/** Tool definitions in this wire's flat spelling, explicitly non-strict. */
export function toResponsesTools(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict: false,
  }));
}

/** `tool_choice` in this wire's spelling — the named form loses its `function` wrapper. */
function toResponsesToolChoice(tc: StreamOptions["toolChoice"]): unknown {
  if (!tc || typeof tc === "string") return tc ?? "auto";
  return { type: "function", name: tc.function.name };
}

/** Usage from a terminal event's `response` object, in this app's vocabulary. */
function readUsage(response: unknown): { inputTokens: number; outputTokens: number; cachedTokens: number } {
  const usage = (response as { usage?: Record<string, unknown> } | undefined)?.usage;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const details = usage?.input_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: n(usage?.input_tokens),
    outputTokens: n(usage?.output_tokens),
    // A subset of input_tokens, same as Chat Completions' cached_tokens.
    cachedTokens: n(details?.cached_tokens),
  };
}

/** Whether an output item is one of the kinds the next request wants back. */
function isEchoItem(item: unknown): item is Record<string, unknown> {
  const type = (item as { type?: unknown } | null)?.type;
  return type === "reasoning" || type === "function_call" || type === "message";
}

export async function streamResponses(opts: StreamOptions): Promise<void> {
  const url = openaiUrl(opts.baseUrl, "/responses");
  const { instructions, input } = toResponsesInput(opts.messages, opts.modelId);
  const body = {
    model: opts.modelId,
    instructions,
    input,
    stream: true,
    store: false,
    // Same `!== undefined` rule as the Chat Completions adapter: 0 is a real
    // value for all three, and an unset one must send nothing.
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
    ...(opts.frequencyPenalty !== undefined ? { frequency_penalty: opts.frequencyPenalty } : {}),
    ...(opts.tools
      ? { tools: toResponsesTools(opts.tools), tool_choice: toResponsesToolChoice(opts.toolChoice) }
      : {}),
    // `reasoning: {effort, summary}` — absent unless the author set an effort
    // on this model, for the same reason as every other adapter: an unset
    // model must keep sending exactly what it sent before, and each model's
    // default effort differs (5.4 none, 5.5/5.6 medium) so "unset" must not be
    // spelled as any one of them. The category resolves to `responses-effort`
    // for this family (lib/ai/reasoning.ts); a legacy or cross-family
    // category reaches here as the family default too.
    ...reasoningBody(
      resolveThinkingCategory({ thinkingCategory: opts.thinkingCategory }, opts.standard),
      opts.reasoningEffort,
    ),
    // Last: extraBody is the per-request escape hatch and outranks config.
    ...opts.extraBody,
  };
  // The wire body is a different shape from the caller's messages (items, not
  // messages; instructions lifted out), so the log's request entry alone
  // cannot show what was sent — report the body the way the Anthropic adapter
  // does for its resumed legs.
  opts._onRequestBody?.(body);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI Responses API error ${res.status} (${url}): ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let truncated = false;
  let stopReason: string | undefined;
  let buffer = "";
  // Function calls keyed by `output_index` — the one key every event about a
  // call carries (`item_id` is absent on some relays' delta events).
  const calls = new Map<number, { id: string; name: string; args: string }>();
  // The turn's output items, verbatim, in the order they completed — this is
  // the echo (see the file header).
  const items: unknown[] = [];

  // See toolArgsProgress: the calls themselves cannot be handed over until the
  // stream ends, so this is the only thing that can be said while they arrive.
  const reportToolArgs = createToolArgsProgress(opts.onChunk);
  const argChars = () => {
    let n = 0;
    for (const c of calls.values()) n += c.args.length;
    return n;
  };

  const emitToolCalls = () => {
    if (calls.size === 0) return;
    const toolCalls: AccumulatedToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({ index, id: c.id, name: c.name, arguments: c.args }));
    const carry: ResponseItemCarry | undefined = items.length
      ? { modelId: opts.modelId, items }
      : undefined;
    opts.onChunk({ toolCalls, ...(carry ? { _responseItems: carry } : {}) });
  };

  const finish = () => {
    emitToolCalls();
    opts.onChunk({
      done: true, inputTokens, outputTokens,
      ...(truncated ? { truncated } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(cachedTokens ? { cachedTokens } : {}),
    });
  };

  const readTerminalUsage = (response: unknown) => {
    const u = readUsage(response);
    inputTokens = u.inputTokens;
    outputTokens = u.outputTokens;
    cachedTokens = u.cachedTokens;
  };

  const callAt = (index: unknown) => {
    const idx = typeof index === "number" ? index : 0;
    let entry = calls.get(idx);
    if (!entry) {
      entry = { id: "", name: "", args: "" };
      calls.set(idx, entry);
    }
    return entry;
  };

  /** True once the event was the stream's terminal one. */
  const parseData = (data: string): boolean => {
    let json: any; // JSON.parse's return type — matches the rest of lib/ai's untyped access
    try {
      json = JSON.parse(data);
    } catch {
      return false; // ignore malformed SSE lines
    }
    // A relay can answer 200 and then deliver a failure as a plain error
    // object in the data line rather than as the protocol's `error` event.
    if (json.error && typeof json.type !== "string") {
      const err = json.error as { message?: string } | string;
      const msg = typeof err === "string" ? err : err?.message ?? JSON.stringify(json.error);
      throw new Error(`OpenAI Responses: ${msg}`);
    }
    switch (json.type) {
      case "response.output_text.delta":
        // Every delta also carries an `obfuscation` field (random padding
        // against length side-channels); it is not text and is ignored by
        // reading only `delta`.
        if (typeof json.delta === "string") opts.onChunk({ text: json.delta });
        return false;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (typeof json.delta === "string") opts.onChunk({ reasoning: json.delta });
        return false;
      case "response.output_item.added": {
        const item = json.item;
        if (item?.type === "function_call") {
          const entry = callAt(json.output_index);
          if (typeof item.call_id === "string") entry.id = item.call_id;
          if (typeof item.name === "string") entry.name = item.name;
          if (typeof item.arguments === "string") entry.args = item.arguments;
        }
        return false;
      }
      case "response.function_call_arguments.delta": {
        if (typeof json.delta === "string") {
          const entry = callAt(json.output_index);
          entry.args += json.delta;
          reportToolArgs(() => ({ name: entry.name, chars: argChars() }));
        }
        return false;
      }
      case "response.function_call_arguments.done": {
        // The whole string, authoritative over whatever the fragments summed to.
        if (typeof json.arguments === "string") callAt(json.output_index).args = json.arguments;
        return false;
      }
      case "response.output_item.done": {
        const item = json.item;
        if (item?.type === "function_call") {
          const entry = callAt(json.output_index);
          if (typeof item.call_id === "string") entry.id = item.call_id;
          if (typeof item.name === "string") entry.name = item.name;
          if (typeof item.arguments === "string") entry.args = item.arguments;
        }
        if (isEchoItem(item)) items.push(item);
        return false;
      }
      case "response.completed":
        readTerminalUsage(json.response);
        stopReason = "completed";
        return true;
      case "response.incomplete": {
        readTerminalUsage(json.response);
        const reason = json.response?.incomplete_details?.reason;
        // Same treatment as Chat Completions' finish_reason: a filter stop is
        // the safety refusal it is, not a short answer.
        if (reason === "content_filter") {
          throw new Error("OpenAI Responses: response was blocked (incomplete_details.reason: content_filter)");
        }
        if (reason === "max_output_tokens") truncated = true;
        stopReason = typeof reason === "string" ? reason : "incomplete";
        return true;
      }
      case "response.failed": {
        const msg = json.response?.error?.message ?? json.response?.error?.code ?? "response.failed";
        throw new Error(`OpenAI Responses: ${msg}`);
      }
      case "error": {
        const msg = json.message ?? json.code ?? "error";
        throw new Error(`OpenAI Responses: ${msg}`);
      }
      default:
        // Lifecycle and structural events (created, in_progress,
        // content_part.*, *_text.done, reasoning_summary_part.*) carry nothing
        // this adapter needs beyond what the cases above already read.
        return false;
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
      // `event:` lines name the same type the data line carries; only the
      // data line is read, so a relay that drops the event line changes nothing.
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue; // not part of this protocol, tolerated
      if (parseData(data)) {
        finish();
        return;
      }
    }
  }

  // Stream ended without a terminal event — flush any buffered final line.
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const data = tail.slice(5).trim();
    if (data !== "[DONE]" && parseData(data)) {
      finish();
      return;
    }
  }
  finish();
}
