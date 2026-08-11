/**
 * Anthropic streaming adapter — the Messages API (`POST /v1/messages`, SSE),
 * plus the OpenAI-message → Anthropic-messages conversion (incl. tool call
 * round-trips).
 *
 * Three things here differ from both other adapters, and each is a correctness
 * trap rather than a style difference:
 *
 *   1. `max_tokens` is **required**. OpenAI and Gemini both default it
 *      server-side; Anthropic 400s without it. See `resolveMaxTokens`.
 *   2. Usage arrives in three *disjoint* buckets, not the subset relationship
 *      the rest of the app assumes. See `readUsage`.
 *   3. Thinking is on by default and conflicts with a forced tool choice.
 *      See `thinkingFor`.
 */

import { fetch } from "../http";
import { anthropicUrl } from "./urls";
import type {
  AccumulatedToolCall,
  AuthMode,
  MessageContent,
  StreamMessage,
  StreamOptions,
} from "./types";

/** Messages API version. Pinned, not "latest" — the wire shape is versioned by it. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * `max_tokens` when the model has no `maxOutput` configured.
 *
 * Anthropic requires the field on every request, so there is no "let the server
 * decide" option to fall back on. 8k is chosen to be larger than any single
 * writing task this app issues while staying well under every current model's
 * ceiling — a value above the model's own cap is itself a 400, so guessing high
 * would break the small models rather than the large ones.
 */
export const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Request headers.
 *
 * Two ways to present the key, both first-class in the Anthropic ecosystem:
 * `ANTHROPIC_API_KEY` rides `x-api-key` (what api.anthropic.com wants), and
 * `ANTHROPIC_AUTH_TOKEN` rides `Authorization: Bearer` (what a large share of
 * third-party gateways want — their docs typically name only that one). A
 * gateway that reads the wrong header sees an unauthenticated request and 401s,
 * which is why the mode is configurable per provider rather than guessed.
 *
 * `both` exists for gateways whose docs say neither. It is only reachable from
 * a compat provider: api.anthropic.com rejects a request carrying two
 * credentials, so sending both there would break a working configuration.
 *
 * `anthropic-dangerous-direct-browser-access` is a no-op for the packaged app —
 * requests leave from Rust reqwest (see lib/http.ts), which never does a CORS
 * preflight. It is here so `pnpm dev` in a plain browser, which falls back to
 * the global fetch, can reach the API too; without it Anthropic refuses
 * browser-origin requests outright.
 */
function authHeaders(apiKey: string, mode: AuthMode = "default"): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(mode === "bearer" ? {} : { "x-api-key": apiKey }),
    ...(mode === "default" ? {} : { Authorization: `Bearer ${apiKey}` }),
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export { authHeaders as anthropicHeaders };

// ─── Message conversion ──────────────────────────────────────────────────────

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

function parseJsonArgs(argsStr: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsStr) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Flatten a message's content down to plain text, dropping any images. */
function textOf(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function blocksOf(content: MessageContent): AnthropicBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((p): AnthropicBlock => {
    if (p.type === "text") return { type: "text", text: p.text };
    // Same data-URL parse as the Gemini adapter's inline_data conversion.
    const [meta, data] = p.image_url.url.split(",");
    const mediaType = meta.slice("data:".length).replace(";base64", "");
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  });
}

/**
 * The system instruction, pulled out of `messages`.
 *
 * Anthropic has no `system` role inside the message array (the mid-conversation
 * variant is model-gated and positional, which the callers here can't
 * guarantee), so every system message is hoisted to the top-level `system`
 * field. Content is flattened through `textOf` rather than assigned straight
 * across: a system message with `ContentPart[]` content would otherwise
 * serialize as `[object Object]`.
 */
export function extractSystem(messages: StreamMessage[]): string | undefined {
  const parts = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf((m as { content: MessageContent }).content))
    .filter((t) => t.trim());
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * OpenAI-shaped `StreamMessage[]` → Anthropic `messages[]`.
 *
 * Exported for the tests, and because the two structural rules below are worth
 * asserting directly rather than only through a streamed response.
 *
 * Anthropic is stricter than either other protocol about the message array:
 * the first entry must be `user`, and adjacent entries must alternate roles.
 * OpenAI accepts consecutive same-role turns and the agent loop produces them
 * (a tool round often appends assistant-then-assistant), so both are fixed up
 * here rather than left to 400 at request time.
 */
export function convertToAnthropicMessages(messages: StreamMessage[]): AnthropicMessage[] {
  const toolCallIdToName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) {
      for (const tc of m.tool_calls) toolCallIdToName.set(tc.id, tc.function.name);
    }
  }

  const out: AnthropicMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "system") {
      i++; // hoisted into the top-level `system` field by extractSystem
      continue;
    }

    if (msg.role === "tool") {
      // Merge consecutive tool results into ONE user message. Anthropic requires
      // every tool_result for a turn to arrive together, and splitting them
      // across messages breaks the alternation rule as well.
      const content: AnthropicBlock[] = [];
      while (i < messages.length && messages[i].role === "tool") {
        const tm = messages[i] as { role: "tool"; tool_call_id: string; content: string };
        content.push({ type: "tool_result", tool_use_id: tm.tool_call_id, content: tm.content });
        i++;
      }
      out.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      out.push({
        role: "assistant",
        content: msg.tool_calls.map((tc) => ({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.function.name || toolCallIdToName.get(tc.id) || "unknown_function",
          input: parseJsonArgs(tc.function.arguments),
        })),
      });
      i++;
      continue;
    }

    const regular = msg as { role: "user" | "assistant"; content: MessageContent };
    out.push({ role: regular.role, content: blocksOf(regular.content) });
    i++;
  }

  // Drop a leading assistant turn, then merge same-role neighbours.
  while (out.length && out[0].role === "assistant") out.shift();
  const merged: AnthropicMessage[] = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...m.content);
    else merged.push({ role: m.role, content: [...m.content] });
  }
  return merged;
}

// ─── Request shaping ─────────────────────────────────────────────────────────

function resolveMaxTokens(opts: StreamOptions): number {
  const configured = opts.maxOutput;
  return configured && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_TOKENS;
}

/**
 * Whether this request forces the model into a specific tool.
 *
 * `"auto"` is the default and imposes nothing; `"required"` and a named
 * function both do.
 */
function forcesTool(opts: StreamOptions): boolean {
  const tc = opts.toolChoice;
  if (!tc || tc === "auto" || tc === "none") return false;
  return true;
}

/**
 * The `thinking` field, or undefined to leave the model's default alone.
 *
 * Two facts collide here. Current Claude models think by default when the field
 * is omitted — which is what the agent loop wants, and why this returns
 * undefined for an ordinary request. But extended thinking is incompatible with
 * a forced `tool_choice`, and `runStructuredTask` (lib/agent/structured.ts)
 * forces exactly one named tool for every structured task: 一致性检查, lore
 * improve, the entry splitter. Left alone those would all 400 and fall through
 * to the JSON-mode fallback, silently losing schema enforcement.
 *
 * So thinking is disabled *only* on the forced-tool path. Don't turn this into
 * an unconditional disable when adding a thinking toggle later — that trades a
 * structured-output failure for an agent-loop regression.
 */
function thinkingFor(opts: StreamOptions): { type: "disabled" } | undefined {
  return forcesTool(opts) ? { type: "disabled" } : undefined;
}

function toolChoiceBody(
  opts: StreamOptions,
): { type: "auto" | "any" | "none" } | { type: "tool"; name: string } | undefined {
  const tc = opts.toolChoice;
  if (!tc || tc === "auto") return { type: "auto" };
  if (tc === "none") return { type: "none" };
  if (tc === "required") return { type: "any" };
  return { type: "tool", name: tc.function.name };
}

// ─── Usage ───────────────────────────────────────────────────────────────────

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

function asCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Content-block index. Separate from `asCount` because 0 is a valid index. */
function asIndex(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * Fold Anthropic's usage report into the shape the rest of the app expects.
 *
 * OpenAI and Gemini both report a cached count that is a *subset* of the input
 * count, and `costFor` bills `(input − cached) × priceIn + cached ×
 * priceCachedIn`. Anthropic instead reports three disjoint buckets:
 * `input_tokens` is the uncached remainder only, with cache reads and cache
 * writes counted separately beside it. Summing them is what makes the totals
 * comparable across providers — reading `input_tokens` alone would under-report
 * the prompt by however much was cached, which on a long lore prompt is most of
 * it.
 *
 * Cache *writes* bill above the base input rate, and `Model` has no field for
 * that rate, so they land in the full-price bucket rather than the cached one.
 * That errs toward over-stating cost, which is the safe direction for a number
 * the author uses to decide what to run.
 */
function readUsage(raw: unknown, prev: Usage): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const uncached = asCount(u.input_tokens);
  const cacheRead = asCount(u.cache_read_input_tokens);
  const cacheWrite = asCount(u.cache_creation_input_tokens);
  const input = uncached + cacheRead + cacheWrite;
  return {
    // `message_delta` reports only output_tokens; don't let its absent input
    // fields zero out what message_start already established.
    inputTokens: input || prev.inputTokens,
    outputTokens: asCount(u.output_tokens) || prev.outputTokens,
    cachedTokens: cacheRead || prev.cachedTokens,
  };
}

/**
 * `stop_reason` values that mean the response was refused rather than
 * completed — as opposed to `end_turn` (normal), `tool_use` (a tool call), or
 * `max_tokens` (truncated, but real output). Like Gemini's blocked finish
 * reasons, this can arrive *after* partial text has streamed, so it has to be
 * thrown rather than reported as a normal short answer.
 */
const ANTHROPIC_REFUSAL_STOP_REASONS = new Set(["refusal"]);

// ─── The adapter ─────────────────────────────────────────────────────────────

export async function streamAnthropic(opts: StreamOptions): Promise<void> {
  const url = anthropicUrl(opts.baseUrl, "/messages");

  const system = extractSystem(opts.messages);
  const thinking = thinkingFor(opts);

  const body: Record<string, unknown> = {
    model: opts.modelId,
    max_tokens: resolveMaxTokens(opts),
    stream: true,
    messages: convertToAnthropicMessages(opts.messages),
  };
  if (system) body.system = system;
  if (thinking) body.thinking = thinking;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
    body.tool_choice = toolChoiceBody(opts);
  }
  // `opts.extraBody` is deliberately NOT spread in. It carries OpenAI-shaped
  // fields (`response_format`) that the Messages API rejects outright with a
  // 400 — see jsonModeExtraBody in ./jsonMode, which is why nothing sends one
  // down this path any more.

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(opts.apiKey, opts.authMode),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    // The URL is part of the message on purpose: the most common failure on a
    // third-party endpoint is a base URL that resolves somewhere unintended,
    // and a bare "404: <html>" gives the author nothing to compare against the
    // address they pasted.
    throw new Error(`Anthropic API error ${res.status} (${url}): ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let truncated = false;
  // Block-index-keyed, like the OpenAI adapter's tool_calls map: a tool_use
  // block announces its id and name in content_block_start, then streams its
  // arguments as input_json_delta fragments that have to be concatenated.
  const toolBlocks = new Map<number, { id: string; name: string; args: string }>();
  // Carry an incomplete trailing line across reads: a single SSE line can be
  // split across network chunks, and parsing the halves would silently drop
  // text and usage.
  let buffer = "";
  let finished = false;

  const emitToolCalls = () => {
    if (toolBlocks.size === 0) return;
    const toolCalls: AccumulatedToolCall[] = [...toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc], index) => ({
        index,
        id: tc.id,
        name: tc.name,
        // The runtime expects a JSON string. An empty-object tool call streams
        // no input_json_delta at all, so "" has to become "{}" or the agent
        // loop sees a call it can't parse.
        arguments: tc.args.trim() ? tc.args : "{}",
      }));
    opts.onChunk({ toolCalls });
  };

  const emitDone = () => {
    if (finished) return;
    finished = true;
    emitToolCalls();
    opts.onChunk({
      done: true,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(truncated ? { truncated } : {}),
      ...(usage.cachedTokens ? { cachedTokens: usage.cachedTokens } : {}),
    });
  };

  const parseData = (data: string) => {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // ignore malformed SSE lines
    }

    switch (json.type) {
      case "error": {
        // HTTP 200 followed by an in-band failure — overloaded_error and
        // rate-limit mid-stream both arrive this way. Left unhandled the stream
        // would end with whatever text arrived first, reported as a success.
        const err = json.error as { message?: string } | undefined;
        throw new Error(`Anthropic: ${err?.message ?? JSON.stringify(json.error)}`);
      }
      case "message_start": {
        const message = json.message as Record<string, unknown> | undefined;
        usage = readUsage(message?.usage, usage);
        return;
      }
      case "content_block_start": {
        const index = asIndex(json.index);
        const block = json.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          toolBlocks.set(index, {
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            args: "",
          });
        }
        return;
      }
      case "content_block_delta": {
        const index = asIndex(json.index);
        const delta = json.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          opts.onChunk({ text: delta.text });
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const entry = toolBlocks.get(index);
          if (entry) entry.args += delta.partial_json;
        }
        // thinking_delta / signature_delta are intentionally dropped: the app
        // has no surface for reasoning text, and the tokens are already counted
        // in output_tokens.
        return;
      }
      case "message_delta": {
        usage = readUsage(json.usage, usage);
        const stop = (json.delta as { stop_reason?: string } | undefined)?.stop_reason;
        if (stop && ANTHROPIC_REFUSAL_STOP_REASONS.has(stop)) {
          throw new Error(
            `Anthropic declined this response (stop_reason: ${stop}). The content may have triggered a safety classifier — try a different model or provider.`,
          );
        }
        if (stop === "max_tokens") truncated = true;
        return;
      }
      case "message_stop":
        emitDone();
        return;
      default:
        return; // ping, content_block_stop, and anything added later
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the last (possibly incomplete) line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue; // `event:` lines carry no payload
      parseData(trimmed.slice(5).trim());
      if (finished) return;
    }
  }

  // Stream ended without a message_stop — flush any buffered final line, then
  // emit `done` anyway so callers aren't left waiting on a chunk that will
  // never arrive.
  const tail = buffer.trim();
  if (tail.startsWith("data:")) parseData(tail.slice(5).trim());
  emitDone();
}
