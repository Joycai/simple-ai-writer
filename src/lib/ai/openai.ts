/**
 * OpenAI (and compatible) streaming adapter — chat/completions with SSE parsing.
 */

import { fetch } from "../http";
import {
  createThinkTagSplitter, forcesToolChoiceAuto, readReasoningDelta, reasoningBody,
  resolveThinkingCategory, type NativeReasoning, type ThinkingCategory,
} from "./reasoning";
import { openaiServerToolsBody } from "./serverTools";
import { wireOf } from "./platforms";
import { hasCapability } from "./capabilities";
import { openaiUrl } from "./urls";
import { createToolArgsProgress } from "./toolArgsProgress";
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

/**
 * The text of a `delta.content`, whichever shape it arrived in.
 *
 * A string on the protocol's own endpoints; a part array
 * (`[{type:"text",text}]`) on relays fronting a Responses- or Anthropic-shaped
 * backend, which mirror their backend's content verbatim (measured on relay
 * traffic 2026-08-14). Passed on as-is, an array became the text
 * "[object Object]" in the manuscript. Only `text` is read from an array: a
 * part with no text of its own has nothing for the answer.
 */
function deltaText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const t = (part as { text?: unknown } | null)?.text;
    if (typeof t === "string") out += t;
  }
  return out;
}

/**
 * `tool_choice` for this request, with one endpoint-specific downgrade.
 *
 * The `switch` dialect describes endpoints whose thinking is a bare
 * `enable_thinking` boolean (Qwen on DashScope compatible-mode), and those
 * endpoints document that **while thinking is on, `tool_choice` accepts only
 * `auto` and `none`** — a forced function (or `required`) is a 400 before a
 * single token is generated. So a forced choice is downgraded to `auto`
 * exactly when this request also says `enable_thinking: true` — that is,
 * dialect declared *and* an effort other than `off`/`default` set (see
 * `reasoningBody`: `off` sends `false`, `default` sends nothing, and the
 * models this dialect exists for default thinking to off, so both leave
 * forcing legal).
 *
 * Same safety argument as the Anthropic adapter's `toolChoiceBody`: neither
 * caller that forces relies on it — `agent/structured.ts` treats "the model
 * declined to call the tool" as its cue to fall back to JSON mode, and the
 * agent runtime's handoff round hands off on the round's prose instead. The
 * worst case is that fallback firing one turn earlier; not downgrading is a
 * guaranteed failed request followed by the same fallback.
 *
 * This is the *predictable* half of the problem — an endpoint whose declared
 * dialect says forcing is illegal. Endpoints that refuse it with nothing in
 * the config to warn us (DeepSeek V4) are learned from their own 400 instead;
 * see `lib/ai/toolChoice.ts`.
 *
 * A platform can also declare `auto` its only value (the `forcedToolChoice`
 * cell in capabilities.ts) — 智谱, whose models ignore forcing or refuse it with an error
 * that never names the parameter, so the learned downgrade cannot catch it.
 */
function toolChoiceFor(opts: StreamOptions, category: ThinkingCategory): StreamOptions["toolChoice"] {
  const tc = opts.toolChoice ?? "auto";
  const forced = tc === "required" || typeof tc === "object";
  if (!forced) return tc;
  return forcesToolChoiceAuto(category, opts.reasoningEffort) || !hasCapability("forcedToolChoice", wireOf(opts)) ? "auto" : tc;
}

export async function streamOpenAI(opts: StreamOptions): Promise<void> {
  const url = openaiUrl(opts.baseUrl, "/chat/completions");
  const category = resolveThinkingCategory({ thinkingCategory: opts.thinkingCategory }, opts.standard);
  const body: Record<string, unknown> = {
    model: opts.modelId,
    messages: toWireMessages(opts.messages),
    stream: true,
    stream_options: { include_usage: true },
    // Absent unless the author set one on this model, for the same reason as
    // the reasoning fields below: an unset model must keep sending exactly
    // what it sent before this setting existed. 0 is a real value here, so
    // the test is `!== undefined` rather than truthiness.
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    // Same `!== undefined` rule, and for the same reason: 0 is a real value
    // for both (frequency_penalty 0 is the vendor's own default). These two
    // come from the task rather than from the model's config — today only the
    // Sakura translation engine sets them — so a request that doesn't ask for
    // them is byte-identical to one from before they existed.
    ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
    ...(opts.frequencyPenalty !== undefined ? { frequency_penalty: opts.frequencyPenalty } : {}),
    // A task's per-request cap (StreamOptions.maxTokens), never the model's
    // maxOutput — see the field for why the two are kept apart.
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.tools ? { tools: opts.tools, tool_choice: toolChoiceFor(opts, category) } : {}),
    // A standing permission the author granted this model, spelled the way
    // this wire wants it (enable_search / enable_code_interpreter — see
    // lib/ai/serverTools.ts). Empty object for every model without the
    // declaration, so their requests are byte-identical to before this existed.
    ...openaiServerToolsBody(wireOf(opts), opts.serverTools, opts.modelId, { functionTools: !!opts.tools?.length }),
    // Absent unless the author set an effort on this model — an unset model
    // must keep sending exactly what it sent before this existed, because a
    // volunteered field is a field some relay can reject. The category carries
    // the vendor spelling (reasoning_effort / enable_thinking / disable
    // switch); the budget is read only by Qwen's budget category.
    ...reasoningBody(category, opts.reasoningEffort, opts.thinkingBudget),
    // DashScope's high-resolution image reading, declared per model (see
    // Model.vlHighResolution). Absent unless declared, same rule as above —
    // and unless the platform reads it (智谱 takes it and ignores it).
    ...(opts.vlHighResolution && hasCapability("vlHighResolution", wireOf(opts)) ? { vl_high_resolution_images: true } : {}),
    // Last: extraBody is the per-request escape hatch and outranks config.
    ...opts.extraBody,
  };
  // This family carries the most thinking spellings of the four (effort,
  // enable_thinking, the disable switch, budgets) and the log's request entry
  // shows only the caller's messages — without the wire body there is no way
  // to tell whether the field the author chose ever went out.
  opts._onRequestBody?.(body);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Keyless local servers (Ollama, LM Studio) need no auth; omit the header
      // rather than sending an empty bearer token.
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
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
  // The endpoint's own finish_reason, last non-empty one seen — reported on the
  // done chunk so the log can say why a turn ended (stop / length / tool_calls
  // / a vendor's own word), not just that it did.
  let stopReason: string | undefined;
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

  // See toolArgsProgress: the calls themselves cannot be handed over until the
  // stream ends, so this is the only thing that can be said while they arrive.
  const reportToolArgs = createToolArgsProgress(opts.onChunk);
  const argChars = () => {
    let n = 0;
    for (const tc of toolCallMap.values()) n += tc.args.length;
    return n;
  };

  const emitToolCalls = () => {
    if (toolCallMap.size === 0) return;
    // Some relays send the call id as "" rather than leaving it out. Kept, two
    // calls of one round share the empty id, the next request is refused for
    // a duplicate tool_call_id — and since history accumulates, so is every
    // request after it. An empty id is a missing one: make one up, unique
    // across rounds (the stamp) and within this one (the index).
    const stamp = Date.now().toString(36);
    const toolCalls: AccumulatedToolCall[] = [...toolCallMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, tc]) => ({ index, id: tc.id || `call_${stamp}_${index}`, name: tc.name, arguments: tc.args }));
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
    const content = deltaText(delta?.content);
    if (content) emit(inlineThink.push(content));
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
        if (partial.function?.arguments) {
          entry.args += partial.function.arguments;
          reportToolArgs(() => ({ name: entry.name, chars: argChars() }));
        }
      }
    }
    // content_filter fires with little or no text — Azure OpenAI and several
    // compat gateways signal it this way instead of an error status. Throw so
    // it's treated as the safety refusal it is (modelHealth.isSafetyBlockMessage
    // matches "content_filter") rather than a normal empty completion.
    if (choice?.finish_reason === "content_filter") {
      throw new Error("OpenAI: response was blocked (finish_reason: content_filter)");
    }
    // 智谱's names for the same three outcomes (landscape.md §7 第十四个样本).
    // A stream that fails mid-way reports it *only* here — no error body — so
    // read as a normal stop, these hand a half answer over as whole. The
    // moderation stop keeps the `content_filter` wording so the safety-block
    // memory (modelHealth.isSafetyBlockMessage) sees it.
    if (choice?.finish_reason === "sensitive") {
      throw new Error("OpenAI: response was blocked by the endpoint's moderation (finish_reason: sensitive, content_filter)");
    }
    if (choice?.finish_reason === "network_error") {
      throw new Error("OpenAI: the endpoint stopped generating mid-response (finish_reason: network_error)");
    }
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) stopReason = choice.finish_reason;
    if (choice?.finish_reason === "length" || choice?.finish_reason === "model_context_window_exceeded") truncated = true;
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
          ...(stopReason ? { stopReason } : {}),
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
    ...(stopReason ? { stopReason } : {}),
    ...(cachedTokens ? { cachedTokens } : {}),
  });
}
