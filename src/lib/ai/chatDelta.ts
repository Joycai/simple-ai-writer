/**
 * Reading one streamed choice of a Chat-Completions-shaped response: the text,
 * the thinking beside it, the tool calls assembled across frames, and what the
 * finish reason says about how the turn ended.
 *
 * Two wires feed it. Chat Completions hands it `choices[0].delta`; DashScope's
 * native protocol hands it `output.choices[0].message`, whose inside has the
 * same fields under the same names — the compatible mode is a translation onto
 * the native one. The envelope and the SSE framing around it are each
 * adapter's own; this is only the part the two share, kept in one place because
 * every piece of it (empty ids, `<think>` in content, the finish-reason family)
 * was learned from a failure once and should not be learned twice.
 */

import {
  createThinkTagSplitter, readReasoningDelta, readEncryptedReasoning, type NativeReasoning,
} from "./reasoning";
import { createToolArgsProgress } from "./toolArgsProgress";
import { mergeConcatenatedArgs } from "./toolArgs";
import type { AccumulatedToolCall, StreamOptions } from "./types";

/**
 * The text of a `delta.content`, whichever shape it arrived in.
 *
 * A string on the protocol's own endpoints; a part array
 * (`[{type:"text",text}]`) on relays fronting a Responses- or Anthropic-shaped
 * backend, which mirror their backend's content verbatim (measured on relay
 * traffic 2026-08-14), and on DashScope's native multimodal endpoint
 * (`[{text}]`, 2026-09-28). Passed on as-is, an array became the text
 * "[object Object]" in the manuscript. Only `text` is read from an array: a
 * part with no text of its own has nothing for the answer.
 */
export function deltaText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const t = (part as { text?: unknown } | null)?.text;
    if (typeof t === "string") out += t;
  }
  return out;
}

/** One choice of one frame: the delta (or message) and its finish reason. */
export interface ChatChoice {
  delta?: Record<string, unknown>;
  finish_reason?: unknown;
}

interface ChatDeltaReader {
  /** Feed one frame's choice. Throws on a finish reason that means failure. */
  read(choice: ChatChoice | undefined): void;
  hasFinishReason(): boolean;
  /**
   * The stream is over: flush the `<think>` splitter and hand the tool calls
   * over. Called once.
   */
  finish(): { stopReason?: string; truncated: boolean };
}

/**
 * @param label  the vendor prefix of the errors thrown (`OpenAI: …`), so a
 *               failure names the wire it came from.
 */
export function createChatDeltaReader(opts: StreamOptions, label = "OpenAI"): ChatDeltaReader {
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
      .map(([index, tc]) => ({
        index,
        id: tc.id || `call_${stamp}_${index}`,
        name: tc.name,
        // `{}{"id":1}` from some relays — see toolArgs.ts.
        arguments: mergeConcatenatedArgs(tc.args),
      }));
    opts.onChunk({ toolCalls, ...(reasoning ? { _reasoning: reasoning } : {}) });
  };

  const read = (choice: ChatChoice | undefined) => {
    const delta = choice?.delta;
    const content = deltaText(delta?.content);
    if (content) emit(inlineThink.push(content));
    // Thinking endpoints stream reasoning beside the answer, under a field name
    // they don't agree on. Streamed for display and accumulated for the echo;
    // an endpoint that sends none leaves both untouched.
    const think = delta ? readReasoningDelta(delta) : null;
    if (think) {
      reasoning = { ...reasoning, field: think.field, text: (reasoning?.text ?? "") + think.text };
      opts.onChunk({ reasoning: think.text });
    }
    // Not displayed — it is ciphertext — only carried for the echo.
    const sealed = delta ? readEncryptedReasoning(delta) : null;
    if (sealed) {
      reasoning = {
        field: reasoning?.field ?? "reasoning_content",
        text: reasoning?.text ?? "",
        encrypted: { modelId: opts.modelId, value: (reasoning?.encrypted?.value ?? "") + sealed },
      };
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
    const finish = choice?.finish_reason;
    // content_filter fires with little or no text — Azure OpenAI and several
    // compat gateways signal it this way instead of an error status. Throw so
    // it's treated as the safety refusal it is (modelHealth.isSafetyBlockMessage
    // matches "content_filter") rather than a normal empty completion.
    if (finish === "content_filter") {
      throw new Error(`${label}: response was blocked (finish_reason: content_filter)`);
    }
    // 智谱's names for the same three outcomes (landscape.md §7 第十四个样本).
    // A stream that fails mid-way reports it *only* here — no error body — so
    // read as a normal stop, these hand a half answer over as whole. The
    // moderation stop keeps the `content_filter` wording so the safety-block
    // memory (modelHealth.isSafetyBlockMessage) sees it.
    if (finish === "sensitive") {
      throw new Error(`${label}: response was blocked by the endpoint's moderation (finish_reason: sensitive, content_filter)`);
    }
    if (finish === "network_error") {
      throw new Error(`${label}: the endpoint stopped generating mid-response (finish_reason: network_error)`);
    }
    if (typeof finish === "string" && finish) stopReason = finish;
    if (finish === "length" || finish === "model_context_window_exceeded") truncated = true;
  };

  return {
    read,
    hasFinishReason: () => !!stopReason,
    finish() {
      emit(inlineThink.flush());
      emitToolCalls();
      return { stopReason, truncated };
    },
  };
}
