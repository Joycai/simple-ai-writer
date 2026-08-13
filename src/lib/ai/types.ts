/**
 * Shared protocol types for the streaming AI client.
 * Kept dependency-light so helpers (apiLog, tokenEstimate, agent loop) can
 * import types without pulling in the provider adapters.
 */

import type { ReasoningEffort } from "./reasoning";
import type { GeminiSafetySettings } from "./safety";
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
  // alone would not reach it; Gemini's (`?key=`) is deliberately unimplemented
  // — a key in the query string leaks into proxy logs and error messages.
  // Neither gets a choice until those are addressed on their own terms.
  return standard === "anthropic_compat" ? ["default", "bearer", "both"] : ["default"];
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
 */
export type ImageRoute = "images-api" | "chat" | "gemini";

/** A single part inside a multimodal user message. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }; // url = data:<mime>;base64,<data>

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
  | {
      done: true;
      inputTokens: number;
      outputTokens: number;
      /** True when the provider cut the response short on max-tokens (OpenAI
       *  finish_reason "length" / Gemini finishReason "MAX_TOKENS") rather than
       *  the model finishing on its own. */
      truncated?: boolean;
      /**
       * Portion of `inputTokens` served from the provider's prompt cache
       * (OpenAI `usage.prompt_tokens_details.cached_tokens` / Gemini
       * `usageMetadata.cachedContentTokenCount`) — a subset of `inputTokens`,
       * not additional to it, and billed at the model's cheaper cached rate.
       */
      cachedTokens?: number;
    }
  | { toolCalls: AccumulatedToolCall[]; _geminiModelParts?: unknown[] };

/** All message variants accepted by the streaming API. */
export type StreamMessage =
  | { role: "system" | "user" | "assistant"; content: MessageContent }
  | { role: "assistant"; content: null; tool_calls: AssistantToolCall[]; _geminiModelParts?: unknown[] }
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
   * Tool-choice strategy. Defaults to "auto" when tools are present. Pass
   * "required" to force *some* tool, or a specific function object to force
   * exactly that tool. Mapped to Gemini's tool_config.function_calling_config.
   */
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /** Extra top-level fields merged into the OpenAI request body (e.g. response_format). */
  extraBody?: Record<string, unknown>;
  /** Gemini-only: per-request safety filter thresholds. Ignored for OpenAI. */
  safetySettings?: GeminiSafetySettings;
  /** Optional model-scoped prefix prompt, prepended as the leading system instruction. */
  prefix?: string;
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
   * How hard the model should think, in this app's own vocabulary. Translated
   * per protocol family by `lib/ai/reasoning.ts`; absent (and `"default"`) sends
   * nothing at all, leaving the endpoint's own default alone.
   */
  reasoningEffort?: ReasoningEffort;
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
