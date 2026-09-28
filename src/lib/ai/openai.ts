/**
 * OpenAI (and compatible) streaming adapter — chat/completions with SSE parsing.
 */

import { fetch } from "../http";
import { reasoningBody, type NativeReasoning, ENCRYPTED_REASONING_FIELD } from "./reasoning";
import { openaiServerToolsBody } from "./serverTools";
import { costReportHeaders, costReportingPlatform, reportedCostOf } from "./reportedCost";
import { planRequest, type RequestPlan } from "./capability/plan";
import { openaiUrl } from "./urls";
import { createChatDeltaReader } from "./chatDelta";
import type { StreamMessage, StreamOptions } from "./types";

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
 * so this is a no-op for them and their requests are unchanged. The opaque
 * payload beside it goes back only to the model that produced it: another
 * model cannot decrypt it, and 火山方舟 says a payload it cannot restore fails.
 */
function toWireMessages(messages: StreamMessage[], modelId: string): Record<string, unknown>[] {
  return messages.map((m) => {
    const bag = m as Record<string, unknown>;
    // Drop by prefix rather than by name: every protocol that needs carry-back
    // adds a field here, and an allow-list of names silently lets the next one
    // through to the wire.
    const wire = Object.fromEntries(
      Object.entries(bag).filter(([k]) => !k.startsWith("_")),
    );
    const reasoning = bag._reasoning as NativeReasoning | undefined;
    if (!reasoning) return wire;
    const encrypted = reasoning.encrypted?.modelId === modelId ? reasoning.encrypted.value : undefined;
    return {
      ...wire,
      // A round can carry the payload with no summary text at all.
      ...(reasoning.text ? { [reasoning.field]: reasoning.text } : {}),
      ...(encrypted ? { [ENCRYPTED_REASONING_FIELD]: encrypted } : {}),
    };
  });
}

/**
 * Every field of a Chat Completions body except the envelope (`model`,
 * `messages`, `stream`, `stream_options`), in the order the body has always
 * carried them. DashScope's native protocol takes the same fields under the
 * same names inside its `parameters` object — which is why this is its own
 * function rather than part of `streamOpenAI`'s body literal.
 */
function chatParams(opts: StreamOptions, plan: RequestPlan): Record<string, unknown> {
  return {
    // Absent unless the author set one on this model, for the same reason as
    // the reasoning fields below: an unset model must keep sending exactly
    // what it sent before this setting existed. 0 is a real value here, so
    // the test is `!== undefined` rather than truthiness.
    ...(plan.temperature !== undefined ? { temperature: plan.temperature } : {}),
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
    // A forced choice the plan downgraded goes out as `auto` — the reasons are
    // listed on `RequestPlan.toolChoice`.
    ...(opts.tools ? { tools: opts.tools, tool_choice: plan.toolChoice?.sent ?? "auto" } : {}),
    // A standing permission the author granted this model, spelled the way
    // this wire wants it (enable_search / enable_code_interpreter — see
    // lib/ai/serverTools.ts). Empty object for every model without the
    // declaration, so their requests are byte-identical to before this existed.
    ...openaiServerToolsBody(plan.serverTools),
    // Absent unless the author set an effort on this model — an unset model
    // must keep sending exactly what it sent before this existed, because a
    // volunteered field is a field some relay can reject. The category carries
    // the vendor spelling (reasoning_effort / enable_thinking / disable
    // switch); the budget is read only by Qwen's budget category.
    ...reasoningBody(plan.thinking.category, plan.thinking.effort, plan.thinking.budget),
    // DashScope's high-resolution image reading, declared per model (see
    // Model.vlHighResolution). Absent unless declared, same rule as above —
    // and unless the platform reads it (智谱 takes it and ignores it).
    ...(plan.vlHighResolution ? { vl_high_resolution_images: true } : {}),
    // Last: extraBody is the per-request escape hatch and outranks config.
    ...opts.extraBody,
  };
}

export async function streamOpenAI(opts: StreamOptions): Promise<void> {
  const url = openaiUrl(opts.baseUrl, "/chat/completions");
  // Every decision about what this request carries — the effort as the wire
  // takes it, the temperature, the tool choice, the server tools — is the
  // plan's (capability/plan.ts); this function only spells it.
  const plan = opts._plan ?? planRequest(opts);
  const body: Record<string, unknown> = {
    model: opts.modelId,
    messages: toWireMessages(opts.messages, opts.modelId),
    stream: true,
    stream_options: { include_usage: true },
    ...chatParams(opts, plan),
  };
  // This family carries the most thinking spellings of the four (effort,
  // enable_thinking, the disable switch, budgets) and the log's request entry
  // shows only the caller's messages — without the wire body there is no way
  // to tell whether the field the author chose ever went out.
  opts._onRequestBody?.(body);
  const platform = costReportingPlatform(opts);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Keyless local servers (Ollama, LM Studio) need no auth; omit the header
      // rather than sending an empty bearer token.
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      ...costReportHeaders(platform),
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
  /** From the last chunk's `usage`, and only from a trusted platform (`reportedCost.ts`). */
  let reportedCost: number | undefined;
  const choices = createChatDeltaReader(opts);
  // Carry an incomplete trailing line across reads: a single SSE line can be split
  // across network chunks, and parsing the halves would silently drop tokens/usage.
  let buffer = "";

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
      reportedCost = reportedCostOf(platform, "openai", json.usage) ?? reportedCost;
    }
    choices.read(json.choices?.[0]);
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
        const { stopReason, truncated } = choices.finish();
        opts.onChunk({
          done: true, inputTokens, outputTokens,
          ...(truncated ? { truncated } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(cachedTokens ? { cachedTokens } : {}),
          ...(reportedCost !== undefined ? { reportedCost } : {}),
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
  const { stopReason, truncated } = choices.finish();
  opts.onChunk({
    done: true, inputTokens, outputTokens,
    ...(truncated ? { truncated } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(cachedTokens ? { cachedTokens } : {}),
    ...(reportedCost !== undefined ? { reportedCost } : {}),
  });
}
