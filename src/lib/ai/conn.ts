/**
 * The seam between the config layers and one request.
 *
 * `docs/api/provider-layering.md` splits provider configuration into three layers:
 * L1 the protocol family, L2 the configured endpoint (`Provider`), L3 the model
 * (`Model`). Every AI call needs the L2 and L3 halves flattened into the
 * transport fields of `StreamOptions` — and before this module existed, all
 * sixteen call sites did that flattening by hand, while three separate argument
 * interfaces re-declared the same nine fields.
 *
 * That mattered because every one of those fields is optional: missing one at a
 * call site is not a type error, it is a silent behaviour difference on one
 * screen. Adding a field (a thinking-effort setting, say) meant betting on
 * remembering all sixteen.
 *
 * So: **`ConnOptions` is the one place a new L2/L3 transport field is declared,
 * and `connOptions()` is the one place it is read off the config rows.** Task
 * inputs (messages, tools, callbacks) are deliberately *not* here — they come
 * from the caller, not from configuration.
 */

import i18n from "../../i18n";
import type { Model, Provider } from "./configDb";
import { resolveThinkingCategory, type ReasoningEffort, type ThinkingCategoryId } from "./reasoning";
import type { GeminiSafetySettings } from "./safety";
import type { ServerToolId } from "./serverTools";
import type { StructuredOutputMode } from "./jsonMode";
import type { ApiStandard, AuthMode } from "./types";
import { defaultMaxOutput, effectiveMaxOutput } from "./modelLimits";

/**
 * A resolved endpoint + model + credential: everything a request needs except
 * the request itself. The three pieces travel together because none of them is
 * meaningful alone — a `Model` without its `Provider` has no address, and a
 * `Provider` without a key has no access.
 */
export interface AiConn {
  provider: Provider;
  model: Model;
  apiKey: string;
}

/**
 * The transport half of a request: exactly the `StreamOptions` fields that come
 * from configuration rather than from the task.
 *
 * Structurally a subset of `StreamOptions`, so `{...connOptions(conn), messages,
 * onChunk}` type-checks as a whole request. Argument interfaces that carry
 * provider wiring alongside their own inputs (`AgentRuntimeOptions`,
 * `StructuredTaskArgs`, `ScanArgs`) extend this instead of restating it.
 */
export interface ConnOptions {
  /** L2 — the endpoint. */
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  /** Gemini-only: per-request safety filter thresholds. */
  safetySettings?: GeminiSafetySettings;
  /** Anthropic-compat auth scheme; ignored by every other protocol. */
  authMode?: AuthMode;
  /** L3 — the model. */
  modelId: string;
  /** Optional model-scoped prefix prompt, prepended as a leading system message. */
  prefix?: string;
  /** Optional context window (tokens); oversized prompts are rejected before sending. */
  contextSize?: number;
  /** Sent as `max_tokens` on the Anthropic path; planning-only elsewhere. */
  maxOutput?: number;
  /**
   * Sampling temperature, or absent to leave the endpoint's own default alone.
   * Every family sends it; the Anthropic path clamps it to 1 and drops it while
   * extended thinking is on (see ai/anthropic.ts).
   */
  temperature?: number;
  /** How hard to think, in this app's vocabulary — each adapter translates. */
  reasoningEffort?: ReasoningEffort;
  /**
   * The resolved thinking-parameter category. `connOptions()` always fills it
   * (migrating any legacy dialect); optional only so hand-built option bags and
   * task callers may omit it — the adapters re-resolve to the family default.
   */
  thinkingCategory?: ThinkingCategoryId;
  /** Token budget for a budget-shape category (Claude extended, Qwen). */
  thinkingBudget?: number;
  /** Endpoint-run tools this model may use on its own (web search). */
  serverTools?: ServerToolId[];
  /**
   * How this model is asked for JSON on a structured task; absent = auto.
   * Read by `jsonModeShaping`, not by the adapters — the shaping happens where
   * the request is built and travels as `extraBody`.
   */
  structuredOutput?: StructuredOutputMode;
}

/**
 * Flatten a resolved connection into the transport fields of a request.
 *
 * Note what is *not* here: a default for an empty `baseUrl`. An empty base means
 * "use this protocol's own default", and only the adapter knows which one that
 * is (`lib/ai/urls.ts`) — substituting api.openai.com would point a Gemini or
 * Anthropic provider at it.
 */
export function connOptions(conn: AiConn): ConnOptions {
  const { provider, model, apiKey } = conn;
  return {
    baseUrl: provider.baseUrl,
    apiKey,
    standard: provider.apiStandard,
    safetySettings: provider.safetySettings,
    authMode: provider.authMode,
    modelId: model.modelId,
    prefix: model.prefix,
    contextSize: model.contextSize,
    // Resolved, not copied: an unconfigured model still has a real per-reply
    // ceiling, and the one place every request is built is the one place that
    // can make the planner and the wire agree on what it is. See ./modelLimits.
    maxOutput: effectiveMaxOutput(model, defaultMaxOutput()),
    temperature: model.temperature,
    reasoningEffort: model.reasoningEffort,
    // Resolved (and migrated from a legacy dialect) here, the one place with the
    // provider's standard in hand — the model row alone can't name its family.
    thinkingCategory: resolveThinkingCategory(model, provider.apiStandard).id,
    thinkingBudget: model.thinkingBudget,
    serverTools: model.serverTools,
    structuredOutput: model.structuredOutput,
  };
}

/**
 * Narrow an object that *extends* `ConnOptions` back down to just the transport
 * fields. Spreading the wider object would work at runtime — the adapters build
 * their request bodies field by field and ignore strays — but it hands every
 * downstream helper an argument bag full of unrelated task inputs, which is how
 * a `systemPrompt` ends up read from two different places.
 */
export function pickConnOptions(o: ConnOptions): ConnOptions {
  return {
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    standard: o.standard,
    safetySettings: o.safetySettings,
    authMode: o.authMode,
    modelId: o.modelId,
    prefix: o.prefix,
    contextSize: o.contextSize,
    maxOutput: o.maxOutput,
    temperature: o.temperature,
    reasoningEffort: o.reasoningEffort,
    thinkingCategory: o.thinkingCategory,
    thinkingBudget: o.thinkingBudget,
    serverTools: o.serverTools,
    structuredOutput: o.structuredOutput,
  };
}

/** A model paired with the endpoint that serves it. */
export interface ConnPair {
  model: Model;
  provider: Provider;
}

export type ConnResolution =
  | ({ ok: true } & ConnPair)
  | { ok: false; error: string };

/**
 * Resolve a model id against the configured tables, or explain why it failed.
 *
 * The three failure modes stay distinct on purpose. "No model selected",
 * "the selected model is gone" (deleted, or its config was re-imported) and
 * "its provider is gone" call for different fixes, and one call site used to
 * report all three as the first one.
 */
export function resolveConn(
  models: Model[],
  providers: Provider[],
  modelId: string | null,
): ConnResolution {
  if (!modelId) return { ok: false, error: i18n.t("ai.errors.noModel") };
  const model = models.find((m) => m.id === modelId);
  if (!model) return { ok: false, error: i18n.t("ai.errors.modelNotFound") };
  const provider = providers.find((p) => p.id === model.providerId);
  if (!provider) return { ok: false, error: i18n.t("ai.errors.providerNotFound") };
  return { ok: true, model, provider };
}
