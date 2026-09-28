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
import type { Model, ModelType, Provider } from "./configDb";
import type { ReasoningEffort, ThinkingCategoryId } from "./reasoning";
import { modelValue, resolveThinkingCategory, type Sourced } from "./capabilities";
import type { Provenance } from "./capability/intent";
import type { GeminiSafetySettings } from "./safety";
import { providerWire, resolvePlatform, type PlatformId } from "./platforms";
import { activeFamily, channelEndpoints, providerFor, ROUTE_LONG, routeProvider } from "./routes";
import type { ServerToolId } from "./serverTools";
import { isRelayPlatform, relayUpstreamFor, type RelayUpstreamChoice } from "./relayUpstream";
import { canonicalModelId } from "./capability/modelId";
import type { StructuredOutputMode } from "./jsonMode";
import { requestMedia, type RequestPlan } from "./capability/plan";
import { mediaDeclarationOf, type MediaAdmission } from "./capability/media";
import type { ApiStandard, AuthMode, TextVerbosity } from "./types";

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
  /**
   * Which server this is beyond its protocol (`lib/ai/platforms.ts`): decides
   * which private fields — server tools above all — the adapters may spell.
   * `connOptions()` always fills it; absent in a hand-built bag means "infer
   * from the address", the same answer `listProviders` gives (`wireOf`).
   */
  platform?: PlatformId;
  /** L3 — the model. */
  modelId: string;
  /**
   * The id the model catalog is asked about: less a `vendor/` namespace and,
   * on a relay, less the owner's prefix — the channel's own prefix-table row
   * (`特价kiro | `), else a leading `[…]` (`capability/modelId.ts`
   * `canonicalModelId`). `connOptions()` fills it; absent in a hand-built bag,
   * where the catalog strips the namespace alone.
   */
  canonicalModelId?: string;
  /** Optional model-scoped prefix prompt, prepended as a leading system message. */
  prefix?: string;
  /**
   * The context window (tokens) — the author's, else the tables' (`provenance`
   * says which). Planners take any; an oversized prompt is rejected before
   * sending only against the author's.
   */
  contextSize?: number;
  /**
   * The per-reply cap — the author's, else the tables' or the app default.
   * Sent as `max_tokens` on the Anthropic path only when it is the author's;
   * planning-only elsewhere.
   */
  maxOutput?: number;
  /**
   * Where `contextSize` and `maxOutput` came from (`capability/intent.ts`):
   * each consumer trusts only some sources (`TRUST`). `connOptions()` fills
   * it; absent in a hand-built bag, whose numbers are the caller's own.
   */
  provenance?: Provenance;
  /**
   * Sampling temperature, or absent to leave the endpoint's own default alone.
   * Every family sends it; the Anthropic path clamps it to 1 and drops it while
   * extended thinking is on (see ai/anthropic.ts).
   */
  temperature?: number;
  /** How hard to think, in this app's vocabulary — each adapter translates. */
  reasoningEffort?: ReasoningEffort;
  /**
   * The resolved thinking-parameter category. `connOptions()` always fills it;
   * optional only so hand-built option bags and
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
  /** Responses-family `text.verbosity`; absent sends nothing. */
  textVerbosity?: TextVerbosity;
  /** DashScope `vl_high_resolution_images` on the Chat Completions wire; absent sends nothing. */
  vlHighResolution?: boolean;
  /**
   * The relay upstream behind this model, resolved from the channel's prefix
   * table and the model's own choice (`lib/ai/relayUpstream.ts`); `"none"`
   * when nothing applies. Absent in a hand-built bag, where the adapters fall
   * back to a product name in the id (`capabilityModelOf`).
   */
  relayUpstream?: RelayUpstreamChoice;
  /**
   * What the model row declares about media — its type, `videoInput`,
   * `pdfInput` — for the request plan's media admission
   * (`capability/media.ts`): the history a request carries may hold parts
   * attached under another model, and this is what decides which of them go
   * out. `connOptions()` fills all three (the booleans as `false`, never
   * absent); absent in a hand-built bag (a probe), whose parts are its own:
   * it sends whatever the protocol can spell.
   */
  modelType?: ModelType;
  videoInput?: boolean;
  pdfInput?: boolean;
}

/**
 * {@link ConnOptions.canonicalModelId}: the channel's prefix table counts only
 * on a relay, the one kind of platform it means anything on (`relayUpstream.ts`).
 */
function catalogIdOf(model: { modelId: string }, provider: Provider, platform: PlatformId): string {
  return canonicalModelId(model.modelId, isRelayPlatform(platform) ? { prefixes: provider.upstreamPrefixes } : undefined);
}

/**
 * A model's window and per-reply cap on the route it takes, each with its
 * source (`capability/values.ts`): the author's value, else the platform's
 * row, the catalog, the app default.
 */
function sourcedLimits(pair: ConnPair): { contextSize?: Sourced<number>; maxOutput?: Sourced<number> } {
  const { model, provider } = pair;
  const platform = providerWire(provider).platform;
  const at = { standard: provider.apiStandard, platform, canonicalModelId: catalogIdOf(model, provider, platform) };
  return { contextSize: modelValue("contextSize", model, at), maxOutput: modelValue("maxOutput", model, at) };
}

export interface PlannedLimits {
  contextSize?: number;
  maxOutput?: number;
}

/**
 * A model's window and per-reply cap as a planner takes them — every source
 * (`TRUST.planner`). The one answer every budget, ceiling, trigger and
 * forecast plans with, so the forecast the author reads and the run it
 * describes measure against the same numbers; the request's own copy is
 * `connOptions()`'s, from the same {@link sourcedLimits}.
 */
export function plannedLimits(pair: ConnPair): PlannedLimits {
  const { contextSize, maxOutput } = sourcedLimits(pair);
  return { contextSize: contextSize?.value, maxOutput: maxOutput?.value };
}

/**
 * {@link plannedLimits} for a model picked from the store, on the route it
 * takes. A model whose channel is gone has only its own values — no request
 * can be built for it either (`resolveConn`).
 */
export function plannedLimitsOf(model: Model | undefined, providers: readonly Provider[]): PlannedLimits {
  if (!model) return {};
  const provider = providerFor(model, providers);
  if (provider) return plannedLimits({ model, provider });
  const own = (n: number | undefined) => (n && n > 0 ? n : undefined);
  return { contextSize: own(model.contextSize), maxOutput: own(model.maxOutput) };
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
  const platform = resolvePlatform(provider.platform, provider.baseUrl, provider.apiStandard);
  // Resolved, not copied: an unconfigured model still has a window and a
  // per-reply ceiling, and the one place every request is built is the one
  // place that can make the planner and the wire agree on them. Each carries
  // its source, and the wire takes only the author's (capability/intent.ts).
  const { contextSize, maxOutput } = sourcedLimits(conn);
  return {
    baseUrl: provider.baseUrl,
    apiKey,
    standard: provider.apiStandard,
    safetySettings: provider.safetySettings,
    authMode: provider.authMode,
    platform,
    modelId: model.modelId,
    canonicalModelId: catalogIdOf(model, provider, platform),
    prefix: model.prefix,
    contextSize: contextSize?.value,
    maxOutput: maxOutput?.value,
    provenance: {
      ...(contextSize ? { contextSize: contextSize.source } : {}),
      ...(maxOutput ? { maxOutput: maxOutput.source } : {}),
    },
    temperature: model.temperature,
    reasoningEffort: model.reasoningEffort,
    // Resolved here, the one place with the
    // provider's standard in hand — the model row alone can't name its family.
    // An unset one takes the platform's category for the id before the
    // family's default (capability/values.ts, D1).
    thinkingCategory: resolveThinkingCategory(model, provider.apiStandard, platform).id,
    thinkingBudget: model.thinkingBudget,
    serverTools: model.serverTools,
    structuredOutput: model.structuredOutput,
    textVerbosity: model.textVerbosity,
    vlHighResolution: model.vlHighResolution,
    // Resolved here, the one place with the channel's prefix table in hand;
    // "none" rather than absent, so the adapters don't infer over the table.
    relayUpstream: relayUpstreamFor(platform, model, provider),
    ...mediaDeclarationOf(model),
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
    platform: o.platform,
    modelId: o.modelId,
    canonicalModelId: o.canonicalModelId,
    prefix: o.prefix,
    contextSize: o.contextSize,
    maxOutput: o.maxOutput,
    provenance: o.provenance,
    temperature: o.temperature,
    reasoningEffort: o.reasoningEffort,
    thinkingCategory: o.thinkingCategory,
    thinkingBudget: o.thinkingBudget,
    serverTools: o.serverTools,
    structuredOutput: o.structuredOutput,
    textVerbosity: o.textVerbosity,
    vlHighResolution: o.vlHighResolution,
    relayUpstream: o.relayUpstream,
    modelType: o.modelType,
    videoInput: o.videoInput,
    pdfInput: o.pdfInput,
  };
}

/**
 * Which media a request to this model on this route may carry — the plan's
 * {@link RequestPlan.media}, asked before there is a request. The gates that
 * decide whether a part is built read it — the composer's clip gate
 * (`canReadVideo`) and the PDF subagent's eligibility (`readsPdf`) — so a part
 * is built only where it will also go out. Built from the same fields
 * `connOptions()` fills; `mediaAdmission.test.ts` holds the two to one answer.
 */
export function admittedMediaOf(
  model: Pick<Model, "relayUpstream" | "videoInput" | "pdfInput"> & { modelId?: string; type?: ModelType },
  provider: Pick<Provider, "apiStandard" | "baseUrl" | "platform" | "upstreamPrefixes">,
): MediaAdmission {
  const platform = resolvePlatform(provider.platform, provider.baseUrl, provider.apiStandard);
  return requestMedia({
    standard: provider.apiStandard,
    baseUrl: provider.baseUrl,
    platform,
    modelId: model.modelId ?? "",
    relayUpstream: relayUpstreamFor(platform, model, provider),
    ...mediaDeclarationOf(model),
  });
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
 * The failure modes stay distinct on purpose. "No model selected", "the
 * selected model is gone" (deleted, or its config was re-imported), "its
 * channel is gone" and "its channel no longer has the route it takes" call for
 * different fixes, and one call site used to report all of them as the first.
 *
 * The provider handed back is the channel **as the model's route sees it**
 * (`routeProvider`): base URL, standard, auth and platform are that route's,
 * so every consumer downstream — `connOptions`, the wire summaries, the tool
 * routing — reads the right family without knowing routes exist.
 */
export function resolveConn(
  models: Model[],
  providers: Provider[],
  modelId: string | null,
): ConnResolution {
  if (!modelId) return { ok: false, error: i18n.t("ai.errors.noModel") };
  const model = models.find((m) => m.id === modelId);
  if (!model) return { ok: false, error: i18n.t("ai.errors.modelNotFound") };
  const channel = providers.find((p) => p.id === model.providerId);
  if (!channel) return { ok: false, error: i18n.t("ai.errors.providerNotFound") };
  // A picked route the channel dropped since is refused rather than quietly
  // replaced by the primary one: the model's route fields were set for that
  // family, and sending them down another is a cross-family request.
  if (model.activeRoute && !channelEndpoints(channel).some((e) => e.family === model.activeRoute)) {
    return {
      ok: false,
      error: i18n.t("ai.errors.routeNotFound", { route: ROUTE_LONG[model.activeRoute], provider: channel.name }),
    };
  }
  const provider = routeProvider(channel, activeFamily(model, channel)) ?? channel;
  return { ok: true, model, provider };
}
