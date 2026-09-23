/**
 * Shared protocol types for the streaming AI client.
 * Kept dependency-light so helpers (apiLog, tokenEstimate, agent loop) can
 * import types without pulling in the provider adapters.
 */

import type { NativeReasoning, ReasoningEffort, ThinkingCategoryId } from "./reasoning";
import type { StructuredOutputMode } from "./jsonMode";

/** Anthropic thinking blocks, tagged with the model that produced them. */
export interface ThinkingBlockCarry {
  modelId: string;
  /** `thinking` / `redacted_thinking` blocks, verbatim and in original order. */
  blocks: unknown[];
}

/**
 * The OpenAI Responses family's output items for one tool round, tagged with
 * the model that produced them (see `lib/ai/responses.ts`).
 *
 * `reasoning` (with its `encrypted_content`), `function_call` and any
 * `message` the model emitted before calling, verbatim and in order — the
 * whole `output[]` of the turn, which is what the endpoint wants back on the
 * next request (docs/api/responses.md §5). Model-bound for the same reason as
 * `ThinkingBlockCarry`: encrypted reasoning is opaque to any other model, and
 * an item list with ids from one model replayed to another is at best billed
 * noise. When the model changed, the adapter falls back to the bare
 * `function_call` spelling, which every model accepts.
 */
export interface ResponseItemCarry {
  modelId: string;
  items: unknown[];
}
import type { GeminiSafetySettings } from "./safety";
import type { ServerToolEvent, ServerToolId } from "./serverTools";
import type { PlatformId } from "./platforms";
import type { RelayUpstreamChoice } from "./relayUpstream";
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
  /**
   * OpenAI's second protocol (`POST /responses`), a family of its own rather
   * than a flag on the first: body, stream events, tool shape and the echo
   * obligation all differ (docs/api/landscape.md §3). Same base URL and same
   * Bearer auth as the Chat Completions half — only the paths below it change.
   */
  | "openai_responses"
  | "openai_responses_compat"
  | "gemini"
  | "gemini_compat"
  | "anthropic"
  | "anthropic_compat";

/** The wire protocol itself — official and compat of a family speak the same one. */
export type ProtocolFamily = "openai" | "responses" | "gemini" | "anthropic";

const PROTOCOL_FAMILY: Record<ApiStandard, ProtocolFamily> = {
  openai: "openai",
  openai_compat: "openai",
  openai_responses: "responses",
  openai_responses_compat: "responses",
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
 *   - "ark"        — 火山方舟 Seedream: POST {base}/images/generations, the
 *                    same path as "images-api" but a different body (no `n`,
 *                    references as a JSON `image` field, `watermark` on by
 *                    default upstream). Never a default either — the 火山方舟
 *                    starter rows declare it. See docs/api/landscape.md §7.
 */
export type ImageRoute = "images-api" | "chat" | "gemini" | "dashscope" | "comfyui" | "ark";

/**
 * The optional processing hint that rides beside an image URL.
 *
 * `low` asks the endpoint to scale the picture to 512x512 before looking at
 * it; `high` asks for full resolution. Absence means "endpoint's choice",
 * which is also what the `auto` both vendors document already means — so this
 * app never sends that string. Lives here rather than beside the builder
 * because it is a wire vocabulary, and `lib/ai/imagePart.ts` is what decides
 * when to use it. See that file for the vendor table.
 */
export type ImageDetail = "low" | "high";

/** A single part inside a multimodal user message. */
export type ContentPart =
  | { type: "text"; text: string }
  /**
   * A picture. `url` is a `data:<mime>;base64,<data>`; `detail` is the
   * optional processing hint OpenAI and DeepSeek both accept (`low` = the
   * endpoint scales to 512x512 first). Build these with `imagePart()` rather
   * than by hand — it is what applies the author's default. Protocols with no
   * spelling for `detail` (Anthropic, Gemini) drop it in their own adapters.
   */
  | { type: "image_url"; image_url: { url: string; detail?: ImageDetail } }
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
  | { type: "file"; file: { file_data: string; filename: string } }
  /**
   * A video clip, as a `data:video/…;base64,…` URL — the DashScope
   * compatible-mode Chat Completions spelling (docs/feature/video-input.md).
   * `fps` is a sibling of `video_url`, not a field inside it; absent means
   * the endpoint default (≈2 frames per second, measured).
   *
   * Only the `openai` family carries it, and only for a model declaring
   * `videoInput` — the other adapters throw a named error on it, and the
   * chat composer never builds one for them (`canReadVideo`). Build with
   * `videoPart()`; never put bookkeeping fields on it, since openai.ts sends
   * parts verbatim.
   */
  | { type: "video_url"; video_url: { url: string }; fps?: number };

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

interface AssistantToolCall {
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
      /**
       * Fields the endpoint echoed back with another value than the one sent.
       * Only the Responses family echoes its request, so only it fills this;
       * the round still succeeded — see `WireRewrite`.
       */
      wireRewrites?: WireRewrite[];
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
      /** The Responses family's output items for this turn — see `StreamMessage`. */
      _responseItems?: ResponseItemCarry;
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
       * whose blocks were reordered, edited, or partially dropped. One text
       * plus at most one sealed payload (`NativeReasoning`) cannot express that.
       *
       * Carries `modelId` because thinking blocks are bound to the model that
       * produced them. Switching models mid-conversation (which this app
       * allows) means the blocks must be left out: another model won't reject
       * them, it will silently ignore them — and still bill them as input.
       */
      _thinkingBlocks?: ThinkingBlockCarry;
      /**
       * The OpenAI Responses family's output items for this turn — reasoning
       * (encrypted), function calls and any interim message, verbatim.
       *
       * Its own field for the same reason `_thinkingBlocks` is: the shape is an
       * ordered item list the endpoint wants back whole, not a `{field, text}`
       * pair. Unlike Anthropic's blocks, leaving them out is not an error on
       * this family (docs/api/responses.md §5 — the bare `function_call` is
       * accepted); the cost is quality, since a model whose reasoning context
       * spans turns (`all_turns`) sees none of its past reasoning without them.
       */
      _responseItems?: ResponseItemCarry;
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** The Responses family's `text.verbosity` levels (GPT-5.x). */
export const TEXT_VERBOSITIES = ["low", "medium", "high"] as const;
export type TextVerbosity = (typeof TEXT_VERBOSITIES)[number];

/** Narrow a stored or imported value; anything else is absent (send nothing). */
export function parseTextVerbosity(v: unknown): TextVerbosity | undefined {
  return typeof v === "string" && (TEXT_VERBOSITIES as readonly string[]).includes(v)
    ? (v as TextVerbosity)
    : undefined;
}

/**
 * A request field the endpoint echoed back with a different value than the
 * one sent. Only ever built from a real echo — a response that omits the field
 * says nothing about it (docs/api/gpt56-plan.md P2).
 */
export interface WireRewrite {
  field: "reasoning.effort" | "temperature";
  sent: string;
  echoed: string;
}

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
  /**
   * The server beyond its protocol (`lib/ai/platforms.ts`) — which private
   * fields the adapter may spell. Absent = inferred from `baseUrl` (`wireOf`).
   */
  platform?: PlatformId;
  modelId: string;
  messages: StreamMessage[];
  onChunk: (chunk: StreamChunk) => void;
  signal?: AbortSignal;
  /** Tool definitions for function calling. Honored by both OpenAI and Gemini. */
  tools?: ToolDefinition[];
  /**
   * Server-side tools the endpoint should be allowed to run on its own (web
   * search, page extraction). Spelled per wire — Anthropic-family `tools[]`
   * entries, OpenAI-compat `enable_search` (+ `search_options`), Responses-compat
   * built-in `tools[]` entries (see `lib/ai/serverTools.ts`); the Gemini adapter
   * ignores it.
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
   * This request's own output cap, sent as `max_tokens`, or absent to send
   * nothing. **OpenAI wire only**, same as `topP` — the Anthropic path already
   * sends `maxOutput` as its required `max_tokens`.
   *
   * Not `ConnOptions.maxOutput`: that one is the model's cap, planning-only on
   * this wire because a volunteered `max_tokens` is refused by OpenAI's own
   * reasoning models. This is the task's: the translation engine sizes it per
   * chunk so that a degenerate chunk stops there and reads as truncated
   * (docs/feature/translate/01-execution-plan.md invariant 4) instead of
   * running to the server's own limit.
   */
  maxTokens?: number;
  /**
   * How hard the model should think, in this app's own vocabulary. Translated
   * per protocol family by `lib/ai/reasoning.ts`; absent (and `"default"`) sends
   * nothing at all, leaving the endpoint's own default alone.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Which thinking-parameter category this model uses. Absent means the
   * family's default — see `resolveThinkingCategory` in `lib/ai/reasoning.ts`.
   */
  thinkingCategory?: ThinkingCategoryId;
  /** Token budget for a budget-shape category (Claude extended, Qwen). */
  thinkingBudget?: number;
  /**
   * How this model is asked for JSON on a structured task (`lib/ai/jsonMode.ts`).
   * Carried so `ConnOptions` stays a structural subset of this type; no adapter
   * reads it — the shaping happens where the request is built and arrives here
   * as `extraBody`.
   */
  structuredOutput?: StructuredOutputMode;
  /** Responses family: `text.verbosity`, merged beside any `text.format`. */
  textVerbosity?: TextVerbosity;
  /** Chat Completions (DashScope): `vl_high_resolution_images: true`. */
  vlHighResolution?: boolean;
  /**
   * The relay upstream behind the model (`ConnOptions.relayUpstream`). Read
   * through `capabilityModelOf`, which falls back to a product name in the id
   * when a hand-built bag leaves it out.
   */
  relayUpstream?: RelayUpstreamChoice;
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
 * Thrown before sending when the request's pictures together exceed
 * `MAX_REQUEST_IMAGE_CHARS` (lib/ai/imagePart.ts).
 *
 * The paths that send several pictures fit themselves under the ceiling first;
 * this is the net under the ones that don't. Refused here rather than sent
 * because the failure it replaces is slow and nameless: tens of megabytes
 * uploading for minutes before an endpoint answers 413, or nothing at all.
 */
export class ImagePayloadError extends Error {
  constructor(
    public readonly images: number,
    public readonly chars: number,
    public readonly limit: number,
  ) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    super(i18n.t("ai.errors.imagePayloadTooLarge", {
      count: images,
      size: mb(chars),
      limit: mb(limit),
    }));
    this.name = "ImagePayloadError";
  }
}

/**
 * Thrown when a stream stays silent past its deadline — `streamCompletion`'s
 * watchdog (docs/feature/agent/window-edge-plan.md D7).
 *
 * A named error rather than an `AbortError`, on purpose: the agent runtime reads
 * an AbortError as "the author pressed stop", and a stream the endpoint stopped
 * feeding is a failure the author has to be told about, not a stop they made.
 */
export class StreamStallError extends Error {
  constructor(
    /** `first-chunk`: nothing ever arrived. `idle`: output started, then stopped. */
    public readonly phase: "first-chunk" | "idle",
    public readonly waitedMs: number,
  ) {
    super(i18n.t(phase === "first-chunk" ? "ai.errors.streamNoFirstChunk" : "ai.errors.streamStalled", {
      seconds: Math.round(waitedMs / 1000),
    }));
    this.name = "StreamStallError";
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
