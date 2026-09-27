/**
 * Two read-only views of a model row for the settings surfaces — 设计稿 05c.
 *
 * `wireSummary` is the editor's 「将发送」 line: which request-body fields this
 * row's declarations actually put on the wire, spelled the way the wire spells
 * them. It spells the same **request plan** the adapters spell
 * (`capability/plan.ts`), with the adapters' own body functions (`reasoningBody`,
 * `thinkingBody`, the server-tool spellers) — not a second table of what they
 * do: a summary that disagreed with the request would be worse than none, and
 * the only way to keep two tables in step is to have one. What it omits is deliberate: declarations that never leave the
 * machine (PDF input, the translation format) shape which pickers offer the
 * model, not the request.
 *
 * `declarationMarks` is the list row's badges: the declarations an author made
 * explicitly, so a long provider list can be scanned for "which one thinks,
 * which one may search". Auto is never marked — it is not a declaration.
 */

import type { Model } from "./configDb";
import { hasCapability, modelValue } from "./capabilities";
import { planRequest, type RequestPlan } from "./capability/plan";
import type { StructuredOutputMode } from "./jsonMode";
import { wireOf, type PlatformId } from "./platforms";
import { reasoningBody, thinkingBody } from "./reasoning";
import type { RelayUpstreamChoice } from "./relayUpstream";
import { geminiServerTools, openaiServerToolsBody, type ServerToolId } from "./serverTools";
import { familyOf, type ApiStandard, type ProtocolFamily } from "./types";

export interface WireItem {
  /** Dotted path of the field, e.g. `thinking.type`, `response_format`. */
  key: string;
  value: string;
  /**
   * `structured` — sent on structured tasks only, not on every request.
   * `prefix` — the leading system message; the value is empty and the UI
   * names it in the author's language.
   * `video` — rides on a clip's content part, so only on a message carrying one.
   */
  scope?: "structured" | "prefix" | "video";
}

export type WireInput = Pick<
  Model,
  | "type" | "modelId" | "maxOutput" | "temperature" | "reasoningEffort"
  | "thinkingCategory" | "thinkingBudget" | "serverTools" | "structuredOutput"
  | "prefix" | "caps" | "textVerbosity" | "vlHighResolution" | "videoInput" | "videoFps"
>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{a:{b:1}, c:"x"}` → `a.b 1`, `c x`. */
function flatten(body: Record<string, unknown>, prefix = ""): WireItem[] {
  const out: WireItem[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (isPlainObject(v)) out.push(...flatten(v, `${prefix}${k}.`));
    else out.push({ key: `${prefix}${k}`, value: Array.isArray(v) ? v.join(",") : String(v) });
  }
  return out;
}

/** Fields the adapters always pair with another and that say nothing on their own. */
const NOISE = new Set(["thinking.display", "generationConfig.thinkingConfig.includeThoughts"]);

/** How one family spells the plan's summary items — a spelling, never a decision. */
interface SummarySpelling {
  /** Items beside `reasoningBody`'s (the Messages API's `thinking` block). */
  thinking?: (plan: RequestPlan, budgetDeclared: boolean) => WireItem[];
  /** The wire requires `max_tokens` on every request, so it is always sent. */
  maxTokens?: true;
  serverTools: (ids: readonly ServerToolId[]) => WireItem[];
  /** The field a structured task's JSON tier goes out in. */
  structured: (mode: Exclude<StructuredOutputMode, "off">) => WireItem;
}

const toolsItem = (names: readonly string[]): WireItem[] => (names.length ? [{ key: "tools", value: names.join(",") }] : []);

/** 四条线四种拼法。A `Record` so a new family does not compile until it says how. */
const SPELLING: Record<ProtocolFamily, SummarySpelling> = {
  openai: {
    serverTools: (ids) => flatten(openaiServerToolsBody(ids)),
    structured: (mode) => ({ key: "response_format", value: mode, scope: "structured" }),
  },
  responses: {
    serverTools: toolsItem,
    structured: (mode) => ({ key: "text.format", value: mode, scope: "structured" }),
  },
  gemini: {
    // Spelled apart from the ids (`googleSearch`, …); an id with no entry of
    // its own is listed as itself.
    serverTools: (ids) => {
      const names = geminiServerTools(ids).flatMap((t) => Object.keys(t));
      return toolsItem(names.length ? names : ids);
    },
    // The strict tier is responseJsonSchema; below it, only responseMimeType.
    structured: (mode) => (mode === "json_schema"
      ? { key: "generationConfig.responseJsonSchema", value: "strict", scope: "structured" }
      : { key: "generationConfig.responseMimeType", value: "application/json", scope: "structured" }),
  },
  anthropic: {
    // The adapter sends `thinking` on every request for a dialect that has
    // one; the budget it fills in when unset is its own.
    thinking: (plan, budgetDeclared) => {
      const body = thinkingBody(plan.thinking.category.dialect, plan.thinking.budget ?? 0, plan.thinking.effort);
      if (!body) return [];
      return flatten(body)
        .filter((i) => !NOISE.has(i.key))
        .map((i) => (i.key === "thinking.budget_tokens" && !budgetDeclared ? { ...i, value: "…" } : i));
    },
    maxTokens: true,
    serverTools: toolsItem,
    // Only the strict tier exists here (`output_config.format`).
    structured: (mode) => ({ key: "output_config.format", value: mode, scope: "structured" }),
  },
};

/** The plan's request-body fields, spelled the way `plan.wire`'s family spells them. */
function spellSummary(plan: RequestPlan, budgetDeclared: boolean): WireItem[] {
  const spelling = SPELLING[familyOf(plan.wire.standard)];
  const out: WireItem[] = [...(spelling.thinking?.(plan, budgetDeclared) ?? [])];
  const reasoning = reasoningBody(plan.thinking.category, plan.thinking.effort, plan.thinking.budget);
  if (reasoning) out.push(...flatten(reasoning).filter((i) => !NOISE.has(i.key)));
  if (spelling.maxTokens) out.push({ key: "max_tokens", value: String(plan.maxTokensOnWire) });
  if (plan.temperature !== undefined) out.push({ key: "temperature", value: String(plan.temperature) });
  out.push(...spelling.serverTools(plan.serverTools));
  if (plan.structured !== "off") out.push(spelling.structured(plan.structured));
  // Sent on every request, beside (not instead of) a structured task's text.format.
  if (plan.textVerbosity) out.push({ key: "text.verbosity", value: plan.textVerbosity });
  if (plan.vlHighResolution) out.push({ key: "vl_high_resolution_images", value: "true" });
  return out;
}

/**
 * What this row adds to a request beyond `model` and the messages.
 *
 * Planned the way a request from this row is (`connOptions()`): the output
 * cap resolved with its source (so `max_tokens` shows only the author's cap,
 * else the adapter's default), the relay upstream as resolved. Summarised as a request
 * without function tools — the conditions that drop `enable_code_interpreter`
 * and the `agent_max` strategy are the request's, not the model's.
 *
 * `baseUrl` names the endpoint for the session's learned refusals: with it,
 * the structured-output item is what will *actually* be sent, not what the
 * config alone would say. `platform` decides which server tools can be spelled
 * (`lib/ai/platforms.ts`); absent = inferred from `baseUrl`, as the adapters do.
 */
export function wireSummary(
  m: WireInput,
  standard: ApiStandard,
  baseUrl?: string,
  platform?: PlatformId,
  /** The resolved relay upstream (`resolveRelayUpstream`); absent = a product name in the id. */
  relayUpstream?: RelayUpstreamChoice,
): WireItem[] {
  if (m.type === "image") {
    // An image model's declarations steer the client, not a chat body.
    const out: WireItem[] = [];
    if (m.caps?.route) out.push({ key: "route", value: m.caps.route });
    if (m.caps?.dialect) out.push({ key: "dialect", value: m.caps.dialect });
    if (m.caps?.sizes?.length) {
      const [first, ...rest] = m.caps.sizes;
      out.push({ key: "size", value: rest.length ? `${first} +${rest.length}` : first });
    }
    return out;
  }

  const maxOutput = modelValue("maxOutput", m, { standard, platform: wireOf({ standard, baseUrl: baseUrl ?? "", platform }).platform });
  const plan = planRequest({
    standard, baseUrl: baseUrl ?? "", platform, modelId: m.modelId, relayUpstream,
    thinkingCategory: m.thinkingCategory, reasoningEffort: m.reasoningEffort, thinkingBudget: m.thinkingBudget,
    temperature: m.temperature, maxOutput: maxOutput?.value, provenance: maxOutput && { maxOutput: maxOutput.source },
    serverTools: m.serverTools, structuredOutput: m.structuredOutput,
    textVerbosity: m.textVerbosity, vlHighResolution: m.vlHighResolution,
  });
  const out = spellSummary(plan, !!m.thinkingBudget);
  // Not a body field — `fps` sits on the clip's content part. Listed anyway: it
  // changes the request, and the bill (4× between fps 0.5 and the default).
  if (m.videoInput && m.videoFps !== undefined && hasCapability("videoFps", plan.wire)) {
    out.push({ key: "video_url.fps", value: String(m.videoFps), scope: "video" });
  }
  if (m.prefix?.trim()) out.push({ key: "system", value: "", scope: "prefix" });
  return out;
}

type ModelMark = "think" | "web" | "code" | "pdf" | "video" | "translate";

/**
 * The explicit declarations on a conversational model, for the list row.
 * Image, video and transcription models carry none: their declarations live in
 * `caps` / `asrFormat`, and the row already says what type they are.
 */
export function declarationMarks(
  m: Pick<Model, "type" | "thinkingCategory" | "serverTools" | "pdfInput" | "videoInput" | "translateFormat">,
): ModelMark[] {
  if (m.type === "image" || m.type === "video" || m.type === "asr") return [];
  const out: ModelMark[] = [];
  if (m.thinkingCategory) out.push("think");
  if (m.serverTools?.includes("web_search")) out.push("web");
  if (m.serverTools?.includes("code_interpreter")) out.push("code");
  if (m.pdfInput) out.push("pdf");
  if (m.videoInput) out.push("video");
  if (m.translateFormat) out.push("translate");
  return out;
}

/** Whether the stored value is the one the probe measured (not overridden since). */
export function isMeasured(value: number | undefined, probed: number | undefined): boolean {
  return probed !== undefined && value === probed;
}
