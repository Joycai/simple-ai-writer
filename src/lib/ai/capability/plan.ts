/**
 * The request plan: every decision about what a request carries, made once,
 * before any adapter spells it (docs/api/capability-resolution-lld.md §3.8, P5).
 *
 * Each adapter used to make its own: resolve the category, rewrite the effort
 * for the wire, ask the table about temperature, downgrade a forced tool
 * choice, cut the server tools — and the 将发送 summary made them a second
 * time from the model row, which is how it came to show an effort the wire
 * never carried. Now `planRequest` makes them and the adapters and the summary
 * only spell the plan; what differs between families is spelling, never a
 * decision.
 *
 * Pure: it reads the options, the tables and the learned store, and nothing
 * else. `streamCompletion` computes it once and hands it on as `_plan`; an
 * adapter called directly (the consistency test, a live probe) plans for
 * itself, so the two cannot differ.
 */

import { effortOnWire, hasCapability, platformResponsesInclude, temperatureReaches } from "../capabilities";
import { effectiveStructuredOutput, jsonModeShaping, messagesText, type JsonModeShaping, type StructuredOutputMode } from "../jsonMode";
import { requiredMaxTokens } from "../modelLimits";
import { wireOf, type Wire } from "../platforms";
import { forcesToolChoiceAuto, type ReasoningEffort, type ThinkingCategory } from "../reasoning";
import { capabilityModelOf } from "../relayUpstream";
import { effectiveServerTools, type ServerToolId } from "../serverTools";
import type { StreamOptions, TextVerbosity } from "../types";
import { catalogFact } from "./cells/catalog";
import { wireThinks, type ThinkingState } from "./conditions";
import { carried, trusted } from "./intent";
import { learnedCeiling } from "./learned";
import { admittedMedia, clipFps, type ClipFps, type MediaAdmission } from "./media";
import type { CapabilityModel } from "./resolve";
import { resolveThinkingCategory } from "./values";

type ToolChoice = NonNullable<StreamOptions["toolChoice"]>;

/**
 * What a plan is made from: the transport fields, the request's own tools and,
 * when it wants JSON back, its intent and the messages the JSON precondition
 * reads.
 */
export type PlanInput = Pick<
  StreamOptions,
  | "standard" | "baseUrl" | "platform" | "modelId" | "canonicalModelId" | "relayUpstream"
  | "thinkingCategory" | "reasoningEffort" | "thinkingBudget" | "temperature" | "maxOutput" | "provenance"
  | "tools" | "toolChoice" | "serverTools" | "structuredOutput" | "textVerbosity" | "vlHighResolution"
  | "modelType" | "videoInput" | "pdfInput" | "videoFps"
> & Partial<Pick<StreamOptions, "messages" | "structured">>;

export interface RequestPlan {
  wire: Wire;
  /**
   * The model as every capability question about it is asked — its id, relay
   * upstream and, when declared, its type (so the tables' `modelTypes` rules
   * apply).
   */
  model: CapabilityModel;
  thinking: {
    category: ThinkingCategory;
    /** The effort as the wire takes it (`effortOnWire`), not as the row holds it. */
    effort?: ReasoningEffort;
    /** A budget-shape category's token budget, as declared. */
    budget?: number;
    /** Whether the request thinks on the wire (`wireThinks`). */
    state: ThinkingState;
  };
  /** Absent = not sent: none declared, or the wire refuses one under this request. */
  temperature?: number;
  /**
   * The `max_tokens` a wire that requires one sends (the Messages API); the
   * others send no cap. Only the author's cap (`TRUST.anthropicMaxTokens`, D2),
   * else the adapter's own default.
   */
  maxTokensOnWire: number;
  /**
   * Only when the request carries a function-tool list. `sent` is what goes on the
   * wire; `downgradedBy` says why a forced choice became `auto` — the
   * category's dialect, the table's cell, or the endpoint's own 400, learned
   * within the week (`learned.ts`).
   */
  toolChoice?: { requested?: ToolChoice; sent?: ToolChoice; downgradedBy?: "category" | "cell" | "learned" };
  /** The endpoint-run tools this request carries, canonical and cut to the wire and the request. */
  serverTools: readonly ServerToolId[];
  /** The JSON tier a structured task on this request gets (`effectiveStructuredOutput`). */
  structured: StructuredOutputMode;
  /**
   * Only when the request asks for JSON (`StreamOptions.structured`): how it
   * goes out — the tier actually shaped (below `structured` when there is no
   * schema to enforce), the body fields and the cue. `streamCompletion` puts it
   * on the request; a refusal steps down from its `mode`.
   */
  json?: JsonModeShaping;
  textVerbosity?: TextVerbosity;
  vlHighResolution: boolean;
  /** The system prompt as Responses' top-level `instructions` (else a leading developer message). */
  instructionsField: boolean;
  /** Responses' `include`: empty for a model with no reasoning to encrypt. */
  responsesInclude: readonly string[];
  /** Cache breakpoints on the system prompt and the toolset. */
  promptCache: boolean;
  /**
   * Which media kinds this request may carry (`capability/media.ts`).
   * `streamCompletion` projects the messages through it before any adapter
   * sees them: a part of a kind not admitted goes out as a one-line note.
   */
  media: MediaAdmission;
  /**
   * What an admitted clip's `fps` field says on this request (`clipFps`):
   * the projection writes it onto every clip, or strips it, whatever the
   * history holds.
   */
  clipFps: ClipFps;
}

/** Whether this choice tells the model to call a tool rather than offering. */
export function isForcedToolChoice(tc: StreamOptions["toolChoice"]): boolean {
  return tc === "required" || (typeof tc === "object" && tc !== null);
}

/**
 * `tool_choice` for this request. A forced choice (`required` or a named
 * function) goes out as `auto` where it is known to fail or be ignored, for
 * one of three reasons:
 *
 *   - `category`: the thinking dialect forbids it — Qwen on DashScope takes
 *     only `auto` / `none` while `enable_thinking` is on, MiniMax's Messages
 *     enum is `auto | none` always (`forcesToolChoiceAuto`). A 400 before a
 *     single token otherwise.
 *   - `cell`: the table says the wire takes `auto` only — 智谱, whose models
 *     ignore forcing or refuse it with an error that never names the
 *     parameter, and relay upstreams that take it with a 200 and ignore it
 *     (Kiro, anti). A silent ignore teaches the learned store nothing.
 *   - `learned`: the endpoint answered a forced choice with a 400 within the
 *     last week (DeepSeek V4, which thinks unconditionally; the store is
 *     `learned.ts`, the retry `streamCompletion`'s).
 *
 * Downgrading is safe because no caller relies on forcing: `agent/structured.ts`
 * treats "the model declined to call the tool" as its cue to re-run in JSON
 * mode, and the agent runtime's handoff round hands off on the round's prose.
 * The worst case is that fallback firing one turn earlier; not downgrading is
 * a guaranteed failed request followed by the same fallback.
 */
function toolChoiceOf(
  opts: PlanInput, category: ThinkingCategory, effort: ReasoningEffort | undefined, wire: Wire, model: CapabilityModel,
): RequestPlan["toolChoice"] {
  if (!opts.tools) return undefined;
  const requested = opts.toolChoice;
  if (!isForcedToolChoice(requested)) return { requested, sent: requested };
  const downgradedBy = forcesToolChoiceAuto(category, effort)
    ? "category"
    : !hasCapability("forcedToolChoice", wire, model)
      ? "cell"
      : learnedCeiling(opts, "forcedToolChoice") === false
        ? "learned"
        : undefined;
  return { requested, sent: downgradedBy ? "auto" : requested, ...(downgradedBy ? { downgradedBy } : {}) };
}

/** {@link RequestPlan.model}: the id and relay upstream, and the type when declared. */
function planModel(opts: MediaPlanInput): CapabilityModel {
  return { ...capabilityModelOf(opts), ...(opts.modelType !== undefined ? { type: opts.modelType } : {}) };
}

/** What {@link RequestPlan.media} is made from — a subset of {@link PlanInput}. */
type MediaPlanInput = Pick<
  PlanInput, "standard" | "baseUrl" | "platform" | "modelId" | "relayUpstream" | "modelType" | "videoInput" | "pdfInput" | "videoFps"
>;

/**
 * {@link RequestPlan.media} without the rest of the plan: the question the
 * attach gates ask (`conn.ts` `admittedMediaOf`), answered by the same
 * composition the plan uses, so what may be attached and what goes out
 * cannot differ.
 */
export function requestMedia(opts: MediaPlanInput): MediaAdmission {
  return admittedMedia(wireOf(opts), planModel(opts), opts);
}

/**
 * {@link RequestPlan.clipFps} without the rest of the plan: the fps the
 * composer estimates a clip at (`sentVideoFps`), answered by the same
 * composition the plan uses.
 */
export function requestClipFps(opts: MediaPlanInput): ClipFps {
  const wire = wireOf(opts);
  const model = planModel(opts);
  return clipFps(wire, model, opts, admittedMedia(wire, model, opts));
}

export function planRequest(opts: PlanInput): RequestPlan {
  const wire = wireOf(opts);
  const model = planModel(opts);
  const category = resolveThinkingCategory({ thinkingCategory: opts.thinkingCategory, modelId: opts.modelId }, opts.standard, wire.platform);
  const functionTools = !!opts.tools?.length;
  // The row's effort as this wire takes it: `off` beside function tools where
  // the wire refuses any other effort there, the nearest level the model takes
  // where it refuses `off` / `max` / `minimal`. Unchanged everywhere else, so
  // an unset model still sends nothing.
  const effort = effortOnWire(opts.reasoningEffort, wire, model, functionTools);
  const state = wireThinks(category, effort);
  // What the request's conditions read (`capability/conditions.ts`).
  const request: CapabilityModel = { ...model, thinking: state, functionTools };
  const media = admittedMedia(wire, model, opts);
  const json = {
    standard: opts.standard, baseUrl: opts.baseUrl, platform: wire.platform, modelId: opts.modelId,
    canonicalModelId: opts.canonicalModelId,
    structuredOutput: opts.structuredOutput, relayUpstream: opts.relayUpstream,
  };
  return {
    wire,
    model,
    thinking: { category, effort, budget: opts.thinkingBudget, state },
    ...(opts.temperature !== undefined && temperatureReaches(wire, model, category, effort) ? { temperature: opts.temperature } : {}),
    maxTokensOnWire: requiredMaxTokens(trusted(carried(opts.maxOutput, opts.provenance?.maxOutput), "anthropicMaxTokens")),
    toolChoice: toolChoiceOf(opts, category, effort, wire, model),
    serverTools: effectiveServerTools(wire, opts.serverTools, opts.modelId, opts.relayUpstream, request) ?? [],
    structured: effectiveStructuredOutput(json),
    ...(opts.structured ? { json: jsonModeShaping(json, messagesText(opts.messages ?? []), opts.structured.schema) } : {}),
    ...(opts.textVerbosity && hasCapability("textVerbosity", wire, model) ? { textVerbosity: opts.textVerbosity } : {}),
    vlHighResolution: !!opts.vlHighResolution && hasCapability("vlHighResolution", wire, model),
    instructionsField: hasCapability("instructionsField", wire, model),
    // No `include` for a model with no reasoning to encrypt (the catalog's
    // `reasons` rows): OpenAI answers that combination with a 400, and xAI's
    // non-reasoning ids were never measured with it.
    responsesInclude: catalogFact("reasons", opts.canonicalModelId ?? opts.modelId) === false ? [] : platformResponsesInclude(wire.platform),
    promptCache: hasCapability("promptCache", wire, model),
    media,
    clipFps: clipFps(wire, model, opts, media),
  };
}
