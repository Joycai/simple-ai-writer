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

import i18n from "../../i18n";
import { fetch } from "../http";
import {
  dialectFor, reasoningBody, supportsTemperature, thinkingBody, type ThinkingDialect,
} from "./reasoning";
import {
  anthropicServerTools,
  readServerToolError,
  readWebSearchResults,
  renderSearchResults,
  type ServerToolEvent,
} from "./serverTools";
import { createToolArgsProgress } from "./toolArgsProgress";
import { anthropicUrl } from "./urls";
import type {
  AccumulatedToolCall,
  AuthMode,
  MessageContent,
  StreamMessage,
  StreamOptions,
  ThinkingBlockCarry,
} from "./types";

/** Messages API version. Pinned, not "latest" — the wire shape is versioned by it. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * `max_tokens` when the model has no `maxOutput` configured.
 *
 * Anthropic requires the field on every request, so there is no "let the server
 * decide" option to fall back on.
 *
 * 32k, not the 8k this used to be. Thinking tokens count against `max_tokens`
 * and it is a hard limit, so once thinking is on the old value left the model
 * splitting 8k between reasoning and prose — the documented symptom is a
 * response that stops with `stop_reason: "max_tokens"` and truncated or missing
 * text. Every model in this app's supported Claude range (4.6+) accepts at
 * least 64k output, so the old worry about overshooting a small model's ceiling
 * doesn't apply to them; 32k stays well inside that while leaving real room to
 * think. A value above the model's own cap is itself a 400, which is why this
 * is not simply set to the 128k the range allows.
 */
export const DEFAULT_MAX_TOKENS = 32_768;

/**
 * Thinking budget for the `extended` dialect, when the author declared that
 * dialect but configured no output cap.
 *
 * Must stay below `max_tokens` — the budget is thinking-only and the response
 * still needs room. Half of the default cap is a deliberate split rather than a
 * tuned figure: the point is that neither half can starve the other.
 */
const DEFAULT_THINKING_BUDGET = 16_384;

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
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  // Replayed verbatim, never constructed here — deliberately opaque so nothing
  // in this file is tempted to rebuild one. The API rejects a modified block.
  | { type: "thinking" | "redacted_thinking"; [k: string]: unknown };

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
    // Same data-URL parse as the Gemini adapter's inlineData conversion. A file
    // part becomes a `document` block — Anthropic's own PDF-input shape — so a
    // file that ever reaches this wire arrives as something it documents rather
    // than an unknown key.
    const dataUrl = p.type === "file" ? p.file.file_data : p.image_url.url;
    const [meta, data] = dataUrl.split(",");
    const mediaType = meta.slice("data:".length).replace(";base64", "");
    return p.type === "file"
      ? { type: "document", source: { type: "base64", media_type: mediaType, data } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data } };
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
/**
 * The thinking blocks to replay for one assistant turn, or none.
 *
 * Dropped when they came from a different model: thinking blocks are bound to
 * the model that produced them, and this app lets the author switch models
 * mid-conversation. Another model won't reject them — it ignores them and bills
 * them as input anyway, which is the worst of both.
 */
function thinkingBlocksFor(msg: StreamMessage, modelId: string): AnthropicBlock[] {
  const carry = (msg as { _thinkingBlocks?: ThinkingBlockCarry })._thinkingBlocks;
  return carry && carry.modelId === modelId ? (carry.blocks as AnthropicBlock[]) : [];
}

export function convertToAnthropicMessages(
  messages: StreamMessage[],
  modelId: string,
): AnthropicMessage[] {
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
        content: [
          // Ahead of the tool_use blocks, exactly as the model emitted them.
          // Required, not cosmetic: a tool call pauses the model mid-response,
          // and the reasoning that led to it has to still be there when the
          // result comes back. Omitting it doesn't error — the API silently
          // turns thinking off for the request, which is the harder failure to
          // notice.
          ...thinkingBlocksFor(msg, modelId),
          ...msg.tool_calls.map((tc) => ({
            type: "tool_use" as const,
            id: tc.id,
            name: tc.function.name || toolCallIdToName.get(tc.id) || "unknown_function",
            input: parseJsonArgs(tc.function.arguments),
          })),
        ],
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
    if (prev && prev.role === m.role) {
      // Both tool results and the author's own turns are `role: "user"` here,
      // so this merge can put them in one message — see labelAuthorText.
      prev.content.push(...(hasToolResult(prev) ? labelAuthorText(m.content) : m.content));
    } else {
      merged.push({ role: m.role, content: [...m.content] });
    }
  }
  return merged;
}

function hasToolResult(m: AnthropicMessage): boolean {
  return m.content.some((b) => b.type === "tool_result");
}

/**
 * Mark text that ends up sharing a message with tool results as the author's.
 *
 * Anthropic puts tool results in a `role: "user"` message, which is also where
 * the author's own turns live, and adjacent same-role messages have to be
 * merged. So a run that dies mid-tool-round — the result is appended, no
 * assistant turn follows, and the author then types something — produces one
 * message reading `[tool_result, "continue"]`. Their words are now inside the
 * envelope the model reads as tool output.
 *
 * That was observed doing real damage: three retries typed across a morning of
 * broken runs (`continue` / `retry` / `重试`) merged into a single `read_file`
 * result and were then re-sent on all 39 rounds of the next run, which spent
 * them as a standing order — "the user wants me to keep going" appeared in the
 * model's own reasoning long after those words had stopped meaning that.
 *
 * The label doesn't make stale words fresh; it makes them attributable, which
 * is the part this layer can honestly fix. A 【…】 tag is the same device the
 * assembled prompt uses for every other injected section, so it reads as
 * structure rather than as something the author typed.
 *
 * Only the merged-in blocks are labelled, and only when tool results are
 * actually present — an ordinary pair of consecutive user turns merges exactly
 * as it did before.
 */
function labelAuthorText(blocks: AnthropicBlock[]): AnthropicBlock[] {
  let labelled = false;
  return blocks.map((b) => {
    if (labelled || b.type !== "text") return b;
    labelled = true;
    return { type: "text", text: `${i18n.t("ai.instructions.authorMessage")}\n${b.text}` };
  });
}

// ─── Request shaping ─────────────────────────────────────────────────────────

function resolveMaxTokens(opts: StreamOptions): number {
  const configured = opts.maxOutput;
  return configured && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_TOKENS;
}

/**
 * The `thinking` field for this request, or undefined to send none.
 *
 * This used to disable thinking whenever `tool_choice` forced a tool, because
 * forced tool use is incompatible with *manual* extended thinking and every
 * structured task (一致性检查, lore improve, the entry splitter) forces exactly
 * one named tool. That workaround is gone: **adaptive thinking supports forced
 * tool use**, and adaptive is the only mode this app's supported range (Claude
 * 4.6+) uses. Keeping the disable would have been worse than useless — several
 * models in that range reject `thinking: {type: "disabled"}` outright, so the
 * guard that existed to prevent a 400 had itself become one.
 *
 * `budget_tokens` is bounded below `max_tokens` because the API requires it and
 * because the two share one ceiling: a budget at or above the cap leaves the
 * response no room to exist.
 */
function thinkingFor(
  opts: StreamOptions,
  dialect: ThinkingDialect,
  maxTokens: number,
): Record<string, unknown> | undefined {
  const budget = Math.max(1024, Math.min(DEFAULT_THINKING_BUDGET, Math.floor(maxTokens / 2)));
  return thinkingBody(dialect, budget, opts.reasoningEffort)?.thinking as
    | Record<string, unknown>
    | undefined;
}

/**
 * `tool_choice`, in Anthropic's own spelling.
 *
 * The `switch` clause is the one place a *thinking* declaration decides
 * something about tools, and it is deliberate. That dialect describes one real
 * endpoint — MiniMax's Messages implementation — whose documented `tool_choice`
 * enum is `auto | none` only: no `any`, no `{type:"tool"}` (`docs/api/landscape.md`
 * §7 第四个样本). Forcing there is a 400 before a single token is generated, so
 * a forced choice is downgraded to `auto` rather than sent to fail.
 *
 * Downgrading is safe because forcing was never load-bearing on its own:
 * `agent/structured.ts` treats "the model declined to call the tool" as its cue
 * to re-run in JSON mode, and the agent runtime's handoff round hands off on
 * the round's prose instead. The worst case here is that fallback firing one
 * turn earlier than it would have; the alternative — a guaranteed failed
 * request first — costs the same fallback plus a wasted round trip.
 *
 * Endpoints that refuse a forced choice with nothing in the config to predict
 * it are handled the other way round, from their own 400 — see
 * `lib/ai/toolChoice.ts`.
 */
function toolChoiceBody(
  opts: StreamOptions,
  dialect: ThinkingDialect,
): { type: "auto" | "any" | "none" } | { type: "tool"; name: string } | undefined {
  const tc = opts.toolChoice;
  if (!tc || tc === "auto") return { type: "auto" };
  if (tc === "none") return { type: "none" };
  if (dialect === "switch") return { type: "auto" };
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

/**
 * The stop reason that means "this turn isn't over" — the endpoint suspended a
 * long-running server-tool turn and expects the paused assistant message handed
 * straight back.
 *
 * The only stop reason that is neither an ending nor an error. Treating it as
 * an ending is silent: the searches all ran, the model wrote its opening line,
 * and the answer it promised never arrives.
 */
const ANTHROPIC_PAUSE_STOP_REASON = "pause_turn";

// ─── The adapter ─────────────────────────────────────────────────────────────

/**
 * How many times one logical turn may be resumed after the endpoint stopped
 * mid-turn.
 *
 * Each resumption is a fresh billed request carrying the whole unfinished turn
 * — search results and all — so this is a cost ceiling as much as a loop guard.
 * Four is enough for the shape it exists for (a research question that fans out
 * into a dozen searches, stopping every few) while bounding the worst case at
 * five requests for one visible answer.
 *
 * Hitting the cap is not an error: the turn ends where it stands, and the `done`
 * chunk reports the stop reason that got it there.
 */
const MAX_PAUSE_CONTINUATIONS = 4;

/**
 * One request's outcome, as far as the turn-level loop cares.
 *
 * `null` means finished. Otherwise the turn has to be handed back, and *how*
 * depends on why — see the two variants.
 */
type Attempt =
  | { resume: null }
  /**
   * The endpoint said `pause_turn`: it wants its own turn back, verbatim, and
   * documents that as the way to continue. Blocks are passed through untouched
   * — a search result's `encrypted_content` is decrypted on that round trip and
   * a rebuilt block loses it.
   */
  | { resume: "verbatim"; blocks: Record<string, unknown>[] }
  /**
   * The turn stopped on its search results without using them, and the endpoint
   * has no notion of being handed them back (it rejects its own server-tool
   * blocks — `docs/api/anthropic-plan.md` §10.7). The results go back as plain
   * text instead, which no validator can object to.
   */
  | { resume: "transcript"; text: string; transcript: string };


/**
 * Whether to mark a cache breakpoint on this request's static prefix.
 *
 * This family's prompt caching is **explicit** — no `cache_control`, no cache,
 * ever (`docs/api/landscape.md` §5). The other two families cache long prefixes
 * on their own, so ④ was the one place where an agent loop re-paid full price
 * for the same several-thousand-token toolset on all forty rounds.
 *
 * Officially-standard endpoints only. MiniMax's ④-family endpoint documents a
 * `system` array with `cache_control` but says nothing about `tools`, and this
 * project's standing rule for third-party ④ endpoints is that documented is not
 * verified (docs/issues/thinking-verification.md). A rejected field here costs the
 * author a whole failed round at the very start of a stream — not a trade worth
 * making blind. See docs/feature/agent/agent-tool-context-lld.md §2.3 for what to measure
 * before turning the compat half on.
 */
function cachesPrompt(standard: StreamOptions["standard"]): boolean {
  return standard === "anthropic";
}

/** The marker itself. 5-minute TTL, which an agent loop's rounds sit well inside. */
const CACHE_BREAKPOINT = { type: "ephemeral" } as const;

export async function streamAnthropic(opts: StreamOptions): Promise<void> {
  const url = anthropicUrl(opts.baseUrl, "/messages");
  const caching = cachesPrompt(opts.standard);

  const system = extractSystem(opts.messages);
  const maxTokens = resolveMaxTokens(opts);
  const dialect = dialectFor(opts.standard, opts.thinkingDialect);
  const thinking = thinkingFor(opts, dialect, maxTokens);

  const baseBody: Record<string, unknown> = {
    model: opts.modelId,
    max_tokens: maxTokens,
    stream: true,
  };
  // A cached breakpoint has to sit on a content block, so the plain string
  // becomes a one-element array. The system layer is worth caching in its own
  // right here: the agent briefing runs to thousands of tokens and is identical
  // on every round of a run.
  if (system) {
    baseBody.system = caching
      ? [{ type: "text", text: system, cache_control: CACHE_BREAKPOINT }]
      : system;
  }
  if (thinking) baseBody.thinking = thinking;
  // Temperature, with this protocol's two constraints applied here rather than
  // at the setting: it caps at 1 (the other families allow 2), and a thinking
  // request refuses everything but 1 — see `supportsTemperature`, which the
  // model editor reads too so it never renders a control this would drop.
  // 0 is a real value, hence the `!== undefined` test.
  if (opts.temperature !== undefined && supportsTemperature(opts.standard, opts.thinkingDialect)) {
    baseBody.temperature = Math.max(0, Math.min(1, opts.temperature));
  }
  // Absent unless the author set an effort on this model. Governs the whole
  // response here, not only thinking — see ANTHROPIC_EFFORT in ./reasoning.
  Object.assign(baseBody, reasoningBody(opts.standard, opts.reasoningEffort, dialect));
  // Server-side tools ride in the same array as ours: one list, two kinds of
  // entry (`{type,name}` for the endpoint's own, `{name,input_schema}` for
  // ours). They are sent even on a request that declares no tools of its own —
  // a standing permission on the model, not something a task opts into.
  const serverTools = anthropicServerTools(opts.serverTools);
  if (opts.tools?.length || serverTools.length) {
    const tools: Record<string, unknown>[] = [
      ...serverTools,
      ...(opts.tools ?? []).map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      })),
    ];
    // One breakpoint, on the LAST entry: this is prefix caching, so a marker
    // caches everything *before* it. Marking each tool would spend the request's
    // four-breakpoint allowance to buy nothing. `tools` comes before `system`
    // and `messages` on the wire, so this covers the whole toolset while the
    // system marker above extends the same cached prefix one block further.
    if (caching && tools.length) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: CACHE_BREAKPOINT };
    }
    baseBody.tools = tools;
    // Only when *we* declared tools. `tool_choice` governs the model's own
    // calls, and a request whose only tool is the server's has nothing to
    // choose — `{type:"auto"}` there would be an opinion about a decision the
    // endpoint makes internally.
    if (opts.tools?.length) baseBody.tool_choice = toolChoiceBody(opts, dialect);
  }
  // `opts.extraBody` is deliberately NOT spread in. It carries OpenAI-shaped
  // fields (`response_format`) that the Messages API rejects outright with a
  // 400 — see jsonModeExtraBody in ./jsonMode, which is why nothing sends one
  // down this path any more.

  // ── Turn-level state, spanning every request this turn takes ───────────────
  //
  // A `pause_turn` splits one assistant turn across several HTTP requests (see
  // below). Everything the caller is told once per turn — usage, the tool
  // calls, the closing `done` — is therefore accumulated out here rather than
  // per request.
  /**
   * The turn's billed total, summed over its requests.
   *
   * Summed, not carried: each request reports its own running totals, so a
   * resumed turn that simply kept the latest numbers would bill the author for
   * the last leg only — and the resumed request is the *expensive* one, since
   * it re-sends the whole paused turn including its search results.
   */
  let total: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let truncated = false;
  /** The endpoint's own `stop_reason`, carried to the API log verbatim. */
  let stopReason: string | undefined;
  // Block-index-keyed, like the OpenAI adapter's tool_calls map: a tool_use
  // block announces its id and name in content_block_start, then streams its
  // arguments as input_json_delta fragments that have to be concatenated.
  const toolBlocks = new Map<number, { id: string; name: string; args: string }>();
  // Index-keyed so the blocks go back in the order the model produced them —
  // a reordered sequence is a 400.
  const thinkingBlocks = new Map<number, Record<string, unknown>>();
  /** `server_tool_use` id → tool name, for labelling the result block. */
  const serverToolNames = new Map<string, string>();
  let finished = false;

  // See toolArgsProgress: the calls themselves cannot be handed over until the
  // stream ends, so this is the only thing that can be said while they arrive.
  const reportToolArgs = createToolArgsProgress(opts.onChunk);
  const argChars = () => {
    let n = 0;
    for (const tc of toolBlocks.values()) n += tc.args.length;
    return n;
  };

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
    const blocks = [...thinkingBlocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    opts.onChunk({
      toolCalls,
      // Only on a tool round: between plain turns the API filters prior
      // thinking itself, so carrying it would be tokens paid for nothing.
      ...(blocks.length ? { _thinkingBlocks: { modelId: opts.modelId, blocks } } : {}),
    });
  };

  const emitDone = () => {
    if (finished) return;
    finished = true;
    emitToolCalls();
    opts.onChunk({
      done: true,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      ...(stopReason ? { stopReason } : {}),
      ...(truncated ? { truncated } : {}),
      ...(total.cachedTokens ? { cachedTokens: total.cachedTokens } : {}),
    });
  };

  /**
   * Stream one request of this turn.
   *
   * Per-request state (the SSE line buffer, the blocks of *this* response)
   * lives here; anything the caller hears about once per turn lives outside.
   */
  const runOnce = async (messages: AnthropicMessage[]): Promise<Attempt> => {
    const requestBody = { ...baseBody, messages };
    opts._onRequestBody?.(requestBody);
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(opts.apiKey, opts.authMode),
      body: JSON.stringify(requestBody),
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
    /**
     * This request's own usage. Per-request because `message_delta` reports a
     * running total for the response it belongs to; the turn's total is summed
     * from these when the request ends.
     */
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    /**
     * Every content block of *this* response, verbatim and in arrival order.
     *
     * Kept whole — not just the fields this adapter reads — because a paused
     * turn has to be echoed back **unmodified**, and a search result carries an
     * `encrypted_content` payload the API decrypts to restore its own context.
     * Rebuilding a block from the parts we understand would strip exactly that.
     */
    const turnBlocks = new Map<number, Record<string, unknown>>();
    /** Streamed `input_json` fragments per block index, applied on close. */
    const blockArgs = new Map<number, string>();
    /** Server-tool calls awaiting their closing event, by block index. */
    const pendingServerCalls = new Map<number, { id: string; name: string }>();
    let paused = false;
    /**
     * Whether the model has said anything since its last search came back.
     *
     * This is the test for "did the turn actually finish", and it is asked this
     * way — as a fact about the text stream — rather than by inspecting the
     * last content block, because a block is only recorded if its
     * `content_block_start` arrived. Keying the decision on that would make a
     * missing start event mean "the model never spoke", which resends a
     * finished turn and bills for it.
     *
     * Starts true so a response with no server tool in it at all is finished by
     * definition.
     */
    let spokeSinceSearch = true;
    /** This request's searches, kept so they can be handed back as text. */
    const searchEvents: ServerToolEvent[] = [];
    /** Plain text the model produced this request, for the resumed turn. */
    let spokenText = "";
    // Carry an incomplete trailing line across reads: a single SSE line can be
    // split across network chunks, and parsing the halves would silently drop
    // text and usage.
    let buffer = "";
    let ended = false;

    /** Fold a block's streamed argument fragments back into its `input`. */
    const settleArgs = (index: number) => {
      const raw = blockArgs.get(index);
      if (raw === undefined) return;
      const block = turnBlocks.get(index);
      if (block) block.input = parseJsonArgs(raw);
    };

    /** Report a finished `server_tool_use` block once, when it closes. */
    const emitServerToolCall = (index: number) => {
      const entry = pendingServerCalls.get(index);
      if (!entry) return;
      pendingServerCalls.delete(index); // once per block, whoever gets here first
      settleArgs(index);
      const event: ServerToolEvent = {
        phase: "call",
        id: entry.id,
        name: entry.name,
        input: parseJsonArgs(blockArgs.get(index) ?? ""),
      };
      searchEvents.push(event);
      opts.onChunk({ serverTool: event });
    };

    /** A response cut off mid-search still says what it was searching for. */
    const flushServerCalls = () => {
      for (const index of [...pendingServerCalls.keys()].sort((a, b) => a - b)) {
        emitServerToolCall(index);
      }
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
          if (!block) return;
          // Shallow copy so the deltas below accumulate into our own object
          // rather than the parsed event's. Every block is kept, including the
          // types this adapter has no other use for — see `turnBlocks`.
          turnBlocks.set(index, { ...block });

          // Thinking blocks are additionally tracked on the *turn*, because
          // they are replayed on the next round of the agent loop, not just
          // within this turn. Redacted ones carry only an opaque payload.
          if (block.type === "thinking" || block.type === "redacted_thinking") {
            thinkingBlocks.set(index, turnBlocks.get(index)!);
          }
          if (block.type === "tool_use") {
            toolBlocks.set(index, {
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              args: "",
            });
          }
          // A search the endpoint is running for itself. Its query streams as
          // input_json_delta exactly like a tool_use's, so it is accumulated the
          // same way and reported once the block closes.
          if (block.type === "server_tool_use") {
            const id = String(block.id ?? "");
            const name = String(block.name ?? "");
            pendingServerCalls.set(index, { id, name });
            // Some endpoints send the input whole on the start block instead of
            // streaming it; seed the buffer so both shapes end up in one place.
            if (block.input && Object.keys(block.input).length) {
              blockArgs.set(index, JSON.stringify(block.input));
            }
            if (id) serverToolNames.set(id, name);
          }
          // The results, delivered whole — there is no delta form for them.
          if (typeof block.type === "string" && block.type.endsWith("_tool_result")) {
            // The model now owes an answer built on these. Cleared again by the
            // first text that follows.
            spokeSinceSearch = false;
            const id = String(block.tool_use_id ?? "");
            const error = readServerToolError(block.content);
            const event: ServerToolEvent = {
              phase: "result",
              id,
              // The call block named the tool; falling back to the result
              // block's own type (`web_search_tool_result` → `web_search`)
              // covers a stream whose two halves didn't pair up.
              name: serverToolNames.get(id) ?? block.type.replace(/_tool_result$/, ""),
              results: readWebSearchResults(block.content),
              ...(error ? { error } : {}),
            };
            searchEvents.push(event);
            opts.onChunk({ serverTool: event });
          }
          return;
        }
        case "content_block_delta": {
          const index = asIndex(json.index);
          const delta = json.delta as Record<string, unknown> | undefined;
          const block = turnBlocks.get(index);
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            if (block) block.text = String(block.text ?? "") + delta.text;
            if (delta.text.trim()) spokeSinceSearch = true;
            spokenText += delta.text;
            opts.onChunk({ text: delta.text });
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            blockArgs.set(index, (blockArgs.get(index) ?? "") + delta.partial_json);
            const entry = toolBlocks.get(index);
            if (entry) {
              entry.args += delta.partial_json;
              // `toolBlocks` only — a server-side search's query streams the
              // same way (blockArgs above), but nothing local is waiting on it.
              reportToolArgs(() => ({ name: entry.name, chars: argChars() }));
            }
          } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
            if (block) block.signature = String(block.signature ?? "") + delta.signature;
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            if (block) block.thinking = String(block.thinking ?? "") + delta.thinking;
            // Summarized reasoning, streamed for display. Arrives only because the
            // request asks for display: "summarized" — the current Claude
            // generation defaults to omitting the text while still billing it.
            opts.onChunk({ reasoning: delta.thinking });
          }
          // Neither delta is *only* accumulated above: the text is also streamed
          // for display, while the signature stays out of sight — it is the
          // encrypted full reasoning, not anything a reader wants.
          return;
        }
        case "message_delta": {
          usage = readUsage(json.usage, usage);
          const stop = (json.delta as { stop_reason?: string } | undefined)?.stop_reason;
          if (stop) stopReason = stop;
          if (stop && ANTHROPIC_REFUSAL_STOP_REASONS.has(stop)) {
            throw new Error(
              `Anthropic declined this response (stop_reason: ${stop}). The content may have triggered a safety classifier — try a different model or provider.`,
            );
          }
          if (stop === "max_tokens") truncated = true;
          // Not an ending: the endpoint suspended a long-running turn and wants
          // it handed straight back. Handled by the caller below.
          if (stop === ANTHROPIC_PAUSE_STOP_REASON) paused = true;
          return;
        }
        case "content_block_stop": {
          // The only block whose *closing* is news: a server tool's query is
          // complete exactly here, and reporting it now is what puts the search
          // in the execution log before its results arrive.
          const index = asIndex(json.index);
          emitServerToolCall(index);
          settleArgs(index);
          return;
        }
        case "message_stop":
          ended = true;
          return;
        default:
          return; // ping, and anything added later
      }
    };

    while (!ended) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep the last (possibly incomplete) line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue; // `event:` lines carry no payload
        parseData(trimmed.slice(5).trim());
        if (ended) break;
      }
    }
    // Stream ended without a message_stop — flush any buffered final line so a
    // last usage report or stop reason isn't lost.
    if (!ended) {
      const tail = buffer.trim();
      if (tail.startsWith("data:")) parseData(tail.slice(5).trim());
    }
    flushServerCalls();
    total = {
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cachedTokens: total.cachedTokens + usage.cachedTokens,
    };

    /**
     * Two ways for a turn to be unfinished, only one of them announced — and
     * they are resumed differently because the endpoints that produce them
     * disagree about what they will accept back.
     *
     * `pause_turn` is the documented signal, and its endpoint documents the
     * verbatim echo along with it.
     *
     * The other is a turn that stops on its own search results without using
     * them: the model asked a question, the endpoint answered it, and the
     * answer is worth nothing unless the model gets to speak again — whatever
     * stop reason came with it. That case exists because the vendor's own
     * endpoint runs the follow-through *inside* one request while MiniMax's
     * beta implementation stops after delivering results and reports
     * `end_turn`. Its symptom is an opening line as the whole visible answer,
     * inside a well-formed success (`docs/api/anthropic-plan.md` §10.5) — and that
     * same endpoint rejects its own blocks on the way back, so the results
     * return as text instead (§10.7).
     */
    if (paused) {
      return {
        resume: "verbatim",
        blocks: [...turnBlocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b),
      };
    }
    if (spokeSinceSearch) return { resume: null };
    const transcript = renderSearchResults(searchEvents);
    // Nothing came back worth reading — resuming would ask the model to answer
    // from the same nothing, one more billed request later.
    if (!transcript) return { resume: null };
    return { resume: "transcript", text: spokenText, transcript };
  };

  /**
   * One assistant turn, however many requests it takes to finish.
   *
   * The vendor's own endpoint runs a server tool's follow-through *inside* one
   * request: search, results, keep writing. Two things break that assumption,
   * and both look like a completed response from outside —
   *
   *   - `pause_turn`, the documented "this is taking a while, hand it back";
   *   - a turn that stops on the search results themselves, which is what
   *     MiniMax's beta implementation does while reporting `end_turn`.
   *
   * Either way the fix is the same round trip: send the unfinished turn back
   * **verbatim** so the model can use what it found. Verbatim is load-bearing —
   * a search result carries an `encrypted_content` payload the endpoint
   * decrypts to restore its own context, and a rebuilt block loses it.
   *
   * The caller is told none of this. It sees one continuous stream of text and
   * a single `done`, because "how many HTTP requests one answer took" is the
   * transport's business.
   */
  let messages = convertToAnthropicMessages(opts.messages, opts.modelId);
  for (let attempt = 0; ; attempt++) {
    const outcome = await runOnce(messages);
    if (!outcome.resume) break;
    // An unfinished turn can't also be a tool round — the API answers a mixed
    // parallel call with `tool_use` instead, leaving the search unrun — but if
    // one ever arrives, the tool call is the half that needs answering first.
    if (toolBlocks.size > 0) break;
    if (attempt >= MAX_PAUSE_CONTINUATIONS) break;
    // The last leg this turn is allowed. Said out loud in the instruction
    // below, because a model that expects another chance uses this one to
    // announce what it will do next — see `searchResultsFinal`.
    const final = attempt >= MAX_PAUSE_CONTINUATIONS - 1;
    opts.onChunk({ turnResumed: { leg: attempt + 2, final } });
    messages =
      outcome.resume === "verbatim"
        ? [...messages, { role: "assistant", content: outcome.blocks as AnthropicBlock[] }]
        : [
            ...messages,
            // Two plain-text messages, not one: the alternation rule means the
            // results can't simply be appended after the trailing user turn,
            // and the assistant half is where the model's own opening line
            // belongs. Its fallback names the searches instead, because an
            // empty assistant message is itself a 400.
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: outcome.text.trim() || i18n.t("ai.instructions.searchedFor"),
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: i18n.t(
                    final ? "ai.instructions.searchResultsFinal" : "ai.instructions.searchResults",
                    { results: outcome.transcript },
                  ),
                },
              ],
            },
          ];
  }
  emitDone();
}
