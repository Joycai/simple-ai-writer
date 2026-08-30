/**
 * Shared protocol types for the streaming AI client.
 * Kept dependency-light so helpers (apiLog, tokenEstimate, agent loop) can
 * import types without pulling in the provider adapters.
 */

import type { NativeReasoning, ReasoningEffort, ThinkingDialect } from "./reasoning";

/** Anthropic thinking blocks, tagged with the model that produced them. */
export interface ThinkingBlockCarry {
  modelId: string;
  /** `thinking` / `redacted_thinking` blocks, verbatim and in original order. */
  blocks: unknown[];
}
import type { GeminiSafetySettings } from "./safety";
import type { ServerToolEvent, ServerToolId } from "./serverTools";
import i18n from "../../i18n";

/**
 * Which endpoint a provider is, as configured by the author.
 *
 * Two axes in one string: the **protocol family** (what the wire messages look
 * like) and whether it is the vendor's own endpoint or a third-party one that
 * merely speaks the same protocol.
 *
 * The `_compat` half is not cosmetic. A first-party endpoint is a fixed address
 * with one documented auth scheme, so the app can hard-code both and assume the
 * optional parts of the protocol exist (`/models`, image editing). A compatible
 * endpoint is an address the author types, and relays vary in which halves of
 * the protocol they implement — so everything the official branch may assume,
 * the compat branch has to ask about or degrade around. Keeping them apart is
 * what lets the compat branch loosen without loosening the official one too:
 * see `lib/ai/urls.ts` for the base-URL half.
 */
export type ApiStandard =
  | "openai"
  | "openai_compat"
  | "gemini"
  | "gemini_compat"
  | "anthropic"
  | "anthropic_compat";

/** The wire protocol itself — official and compat of a family speak the same one. */
export type ProtocolFamily = "openai" | "gemini" | "anthropic";

const PROTOCOL_FAMILY: Record<ApiStandard, ProtocolFamily> = {
  openai: "openai",
  openai_compat: "openai",
  gemini: "gemini",
  gemini_compat: "gemini",
  anthropic: "anthropic",
  anthropic_compat: "anthropic",
};

/**
 * The protocol behind a standard. Branch on this, never on the standard itself,
 * wherever the question is "what do the messages look like" — otherwise every
 * new `_compat` value silently falls into the OpenAI branch.
 */
export function familyOf(standard: ApiStandard): ProtocolFamily {
  // Defensive default for the same reason parseApiStandard exists: this value
  // reaches here from a DB row that predates the current union.
  return PROTOCOL_FAMILY[standard] ?? "openai";
}

/** True for the third-party half of a family — the one whose endpoint is author-typed. */
export function isCompatStandard(standard: ApiStandard): boolean {
  return standard.endsWith("_compat");
}

/**
 * How a compat endpoint wants the API key presented.
 *
 * `default` is each protocol's own scheme and is what an official endpoint
 * always uses. The other two exist because the Anthropic ecosystem has *two*
 * first-class conventions — `ANTHROPIC_API_KEY` → `x-api-key` and
 * `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer` — and a third-party gateway
 * may implement either one, with its docs naming only the one it wants.
 *
 * `both` is for gateways whose docs don't say. It is deliberately unavailable
 * on the official standard: api.anthropic.com rejects a request carrying two
 * credentials, so offering it there would hand the author a setting that can
 * only break things.
 */
export type AuthMode = "default" | "bearer" | "both";

/** The modes a standard may be configured with. Officials are locked to one. */
export function authModesFor(standard: ApiStandard): AuthMode[] {
  // OpenAI's second convention (Azure's `api-key` header) comes with a
  // different URL shape and an api-version query string, so a header toggle
  // alone would not reach it — it stays unavailable until that is addressed on
  // its own terms.
  //
  // Gemini's own second convention (`?key=`) is deliberately unimplemented for
  // a different reason: a key in the query string leaks into proxy logs and
  // error messages. But relays fronting Gemini authenticate with a plain
  // `Authorization: Bearer` instead, which has neither problem — and an
  // endpoint that wants Bearer while receiving only `x-goog-api-key` answers
  // 401, so without this the relay is simply unreachable.
  return standard === "anthropic_compat" || standard === "gemini_compat"
    ? ["default", "bearer", "both"]
    : ["default"];
}

/**
 * Which endpoint an image model's pictures come out of. Not derivable from
 * `ApiStandard`: newAPI-style relays speak the OpenAI protocol but serve
 * Gemini/Flux image models through `/chat/completions`, while their
 * `/images/generations` accepts only Imagen ("not supported model for image
 * generation, only imagen models are supported"). Same provider, same
 * protocol, two different endpoints depending on the model.
 *
 *   - "images-api" — POST /images/generations (OpenAI, xAI, Imagen on relays)
 *   - "chat"       — POST /chat/completions, image comes back in the message
 *   - "gemini"     — POST /models/{id}:generateContent (Gemini native)
 *   - "dashscope"  — DashScope native (Qwen/Wan image models):
 *                    POST {api/v1}/services/aigc/multimodal-generation/generation,
 *                    or the async task flow when `ImageCaps.asyncTask` is set.
 *                    Never a default — the DashScope provider preset is
 *                    `openai_compat`, whose derived route must stay "images-api".
 *   - "comfyui"    — a local ComfyUI instance: POST {base}/prompt with the
 *                    model's imported workflow graph (`ImageCaps.comfy`), then
 *                    poll {base}/history/{id} and fetch via {base}/view. Never
 *                    a default either — only an explicit declaration selects it.
 *                    See docs/feature/comfyui-plan.md.
 */
export type ImageRoute = "images-api" | "chat" | "gemini" | "dashscope" | "comfyui";

/** A single part inside a multimodal user message. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } } // url = data:<mime>;base64,<data>
  /**
   * A whole document handed to the model as a file — the OpenAI Chat
   * Completions file part, which DashScope mirrors for Qwen's PDF
   * understanding (see `docs/api/landscape.md` §7 第六个样本). `file_data` is a
   * data URL, same encoding as `image_url`; `filename` is required beside it —
   * the endpoint refuses base64 file bodies that arrive nameless.
   *
   * Only the PDF subagent builds these (lib/agent/subagent.ts), so they live in
   * one fresh 2-message context and never enter a long-lived history — nothing
   * like `imageHistory`'s eviction is needed for them.
   */
  | { type: "file"; file: { file_data: string; filename: string } };

export type MessageContent = string | ContentPart[];

// ─── Tool calling types (OpenAI API format) ──────────────────────────────────

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AccumulatedToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export type StreamChunk =
  | { text: string }
  /**
   * A fragment of the model's reasoning, streamed alongside the answer.
   *
   * A separate variant rather than more `text` because the two are not
   * interchangeable: reasoning must never reach the manuscript, and every
   * existing consumer keys on `"text" in chunk`, so they ignore this by
   * construction. Endpoints that emit no reasoning simply never produce it.
   */
  | { reasoning: string }
  /**
   * A tool the *endpoint* ran inside this response — its call, then its results
   * (see `lib/ai/serverTools.ts`).
   *
   * Reporting only: there is nothing to execute and nothing to send back, so
   * unlike `toolCalls` this never becomes a message. Consumers that don't know
   * about it ignore it by construction, the same way `reasoning` is ignored by
   * everything that keys on `"text" in chunk`.
   */
  | { serverTool: ServerToolEvent }
  /**
   * The endpoint stopped mid-turn and the adapter handed the turn back to keep
   * it going (see `lib/ai/anthropic.ts`).
   *
   * Reported because it is otherwise invisible: one call becomes several
   * requests, each with its own latency and its own bill, and the author is
   * left watching a minute of silence with nothing to explain it. Diagnostic
   * only — nothing branches on it.
   */
  | { turnResumed: { leg: number; final: boolean } }
  /**
   * How much of this round's tool-call arguments has arrived so far.
   *
   * Progress, not data: the calls themselves are delivered whole in `toolCalls`
   * at the very end of the stream, because half a JSON object cannot be
   * executed. That end is exactly the problem this variant exists for — a model
   * writing a rewritten chapter into `rewrite_lines` streams for a minute or
   * two, and until this every consumer saw *nothing at all* in that window,
   * which is indistinguishable from a hung endpoint.
   *
   * `chars` counts every call in the round, not just the named one: a round can
   * open several calls, and the author is waiting on the round. Throttled by
   * the adapter (`createToolArgsProgress`), and ignored by construction by
   * consumers that don't know about it. Endpoints that hand function calls over
   * whole rather than in fragments (Gemini) never produce it.
   */
  | { toolArgs: { name: string; chars: number } }
  | {
      done: true;
      inputTokens: number;
      outputTokens: number;
      /** True when the provider cut the response short on max-tokens (OpenAI
       *  finish_reason "length" / Gemini finishReason "MAX_TOKENS") rather than
       *  the model finishing on its own. */
      truncated?: boolean;
      /**
       * Why the model stopped, in the endpoint's own words — diagnostic only,
       * never branched on.
       *
       * Here because "the answer just stops" is the hardest failure to reason
       * about from the outside, and the reason is the one datum that separates
       * its causes (`max_tokens` cut it off / `tool_use` means the turn is
       * meant to continue / `end_turn` means the model considered itself done).
       * Written to the API log; an adapter that has no such field simply omits
       * it.
       */
      stopReason?: string;
      /**
       * Portion of `inputTokens` served from the provider's prompt cache
       * (OpenAI `usage.prompt_tokens_details.cached_tokens` / Gemini
       * `usageMetadata.cachedContentTokenCount`) — a subset of `inputTokens`,
       * not additional to it, and billed at the model's cheaper cached rate.
       */
      cachedTokens?: number;
    }
  | {
      toolCalls: AccumulatedToolCall[];
      _geminiModelParts?: unknown[];
      /**
       * The round's reasoning, whole, for echoing back on the assistant message
       * this chunk becomes. Delivered here rather than assembled from the
       * `{reasoning}` fragments above because only a tool round needs it —
       * see `StreamMessage`.
       */
      _reasoning?: NativeReasoning;
      /** Anthropic's thinking blocks for this turn — see `StreamMessage`. */
      _thinkingBlocks?: ThinkingBlockCarry;
    };

/** All message variants accepted by the streaming API. */
export type StreamMessage =
  | { role: "system" | "user" | "assistant"; content: MessageContent }
  | {
      role: "assistant";
      content: null;
      tool_calls: AssistantToolCall[];
      _geminiModelParts?: unknown[];
      /**
       * Reasoning this assistant turn produced, echoed back verbatim.
       *
       * Not an optimisation — a correctness requirement, and only on messages
       * that carry `tool_calls`. Endpoints whose models think before calling a
       * tool treat that reasoning as part of the turn: omit it from the history
       * and the next request is rejected outright, so a thinking model could
       * never finish a tool loop. Between plain user turns the same field is
       * ignored by those endpoints, which is why it is not kept there — it
       * would be tokens paid for nothing.
       *
       * Fields prefixed `_` are this app's own; adapters strip them before a
       * message reaches the wire and re-express whatever their protocol needs.
       */
      _reasoning?: NativeReasoning;
      /**
       * Anthropic's `thinking` / `redacted_thinking` blocks for this turn,
       * verbatim and in order.
       *
       * A separate field from `_reasoning` because the shape is genuinely
       * different: this is an ordered array of blocks — some carrying only an
       * opaque `data` payload with no text at all — and the API rejects a turn
       * whose blocks were reordered, edited, or partially dropped. A
       * `{field, text}` pair cannot express that.
       *
       * Carries `modelId` because thinking blocks are bound to the model that
       * produced them. Switching models mid-conversation (which this app
       * allows) means the blocks must be left out: another model won't reject
       * them, it will silently ignore them — and still bill them as input.
       */
      _thinkingBlocks?: ThinkingBlockCarry;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  /**
   * How to present `apiKey`. Anthropic-compat only; every other protocol
   * ignores it. Absent means `default`, which is what an official endpoint and
   * every provider configured before this setting existed use.
   */
  authMode?: AuthMode;
  modelId: string;
  messages: StreamMessage[];
  onChunk: (chunk: StreamChunk) => void;
  signal?: AbortSignal;
  /** Tool definitions for function calling. Honored by both OpenAI and Gemini. */
  tools?: ToolDefinition[];
  /**
   * Server-side tools the endpoint should be allowed to run on its own (web
   * search). Spelled per wire — Anthropic-family `tools[]` entries, OpenAI-compat
   * `enable_search` (see `lib/ai/serverTools.ts`); the Gemini adapter ignores it.
   * Sent on every request the model handles, `tools` or no `tools` — it is a
   * standing permission the author granted the model, not a per-task input.
   */
  serverTools?: ServerToolId[];
  /**
   * Tool-choice strategy. Defaults to "auto" when tools are present. Pass
   * "required" to force *some* tool, or a specific function object to force
   * exactly that tool. Mapped to Gemini's toolConfig.functionCallingConfig.
   */
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /** Extra top-level fields merged into the OpenAI request body (e.g. response_format). */
  extraBody?: Record<string, unknown>;
  /** Gemini-only: per-request safety filter thresholds. Ignored for OpenAI. */
  safetySettings?: GeminiSafetySettings;
  /** Optional model-scoped prefix prompt, prepended as the leading system instruction. */
  prefix?: string;
  /**
   * Every HTTP request body an adapter actually sends, reported for the API log.
   *
   * Wired by `streamCompletion`, never by a task. It exists because one call can
   * become several requests — an Anthropic turn resumes itself when the endpoint
   * stops mid-turn (see `lib/ai/anthropic.ts`) — and a log that records only the
   * caller's intent cannot show what the endpoint was actually sent. Every bug
   * found in that resume path so far was found by reading these bodies.
   */
  _onRequestBody?: (body: unknown) => void;
  /**
   * Optional model context window (tokens). When set, a request whose
   * estimated prompt size exceeds it is rejected with ContextSizeError
   * before anything is sent — servers like ollama would otherwise silently
   * truncate the head of the prompt (dropping the system instructions).
   */
  contextSize?: number;
  /**
   * Optional cap on how many tokens the model may emit in one reply.
   *
   * Only the Anthropic path sends it: the Messages API requires `max_tokens` on
   * every request, so an unset value there falls back to a constant rather than
   * to the server's own default (there isn't one). On the OpenAI and Gemini
   * paths this stays a planning-only input, used by context/budget.ts to stop
   * reserving window the model could never fill.
   */
  maxOutput?: number;
  /**
   * Sampling temperature, or absent to send nothing and leave the endpoint's
   * own default alone.
   *
   * Sent by all three adapters, with one protocol-level exception: the Messages
   * API allows only `temperature: 1` while extended thinking is on, so the
   * Anthropic adapter clamps to its own ceiling of 1 and omits the field
   * entirely on a thinking request. Nothing else about a request depends on it.
   */
  temperature?: number;
  /**
   * Nucleus sampling cutoff, or absent to leave the endpoint's own default
   * alone. **OpenAI wire only** — the Gemini and Anthropic adapters ignore it.
   *
   * Deliberately here and not on `ConnOptions`, unlike `temperature`: this is a
   * property of the *task*, not of the model the author configured. The one
   * caller that sets it is the Sakura translation engine, for which 0.3 is part
   * of the prompt format itself (`lib/translate/sakura.ts`), not a preference
   * anyone would tune per endpoint. See docs/feature/translate/01-execution-plan.md §1.
   */
  topP?: number;
  /**
   * Penalty on already-emitted tokens, or absent to send nothing. **OpenAI wire
   * only**, same as `topP`.
   *
   * A task input in the strongest sense: the translation engine *varies it
   * between retries of the same chunk* (0.1 → 0.2) because that is Sakura's
   * documented — and measured — remedy for degeneration. A per-model config
   * field could not express that, which is why neither this nor `topP` belongs
   * in `ConnOptions`.
   */
  frequencyPenalty?: number;
  /**
   * How hard the model should think, in this app's own vocabulary. Translated
   * per protocol family by `lib/ai/reasoning.ts`; absent (and `"default"`) sends
   * nothing at all, leaving the endpoint's own default alone.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Which shape of thinking parameter this model accepts. Absent means the
   * family's current generation — see `dialectFor` in `lib/ai/reasoning.ts`.
   */
  thinkingDialect?: ThinkingDialect;
}

/** Thrown before sending when the estimated prompt exceeds the model's configured context size. */
export class ContextSizeError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly contextSize: number,
  ) {
    super(i18n.t("ai.errors.contextExceeded", {
      estimated: estimatedTokens.toLocaleString(),
      limit: contextSize.toLocaleString(),
    }));
    this.name = "ContextSizeError";
  }
}

/**
 * Merge `prefix` into the head of `messages` as a leading system instruction.
 * If the first message is already a system message, the prefix is prepended to
 * its text content; otherwise a new system message is inserted at index 0.
 * Returns a new array — never mutates the input (callers like the agent loop
 * pass the same `history` array across rounds).
 */
export function applyPrefix(messages: StreamMessage[], prefix?: string): StreamMessage[] {
  if (!prefix || !prefix.trim()) return messages;
  const head = messages[0];
  if (head && head.role === "system") {
    const merged: StreamMessage =
      typeof head.content === "string"
        ? { role: "system", content: `${prefix}\n\n${head.content}` }
        : {
            role: "system",
            content: [{ type: "text", text: `${prefix}\n\n` }, ...head.content],
          };
    return [merged, ...messages.slice(1)];
  }
  return [{ role: "system", content: prefix }, ...messages];
}
