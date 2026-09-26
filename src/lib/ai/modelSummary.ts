/**
 * Two read-only views of a model row for the settings surfaces — 设计稿 05c.
 *
 * `wireSummary` is the editor's 「将发送」 line: which request-body fields this
 * row's declarations actually put on the wire, spelled the way the wire spells
 * them. It is built from the **adapters' own body functions** (`reasoningBody`,
 * `thinkingBody`, `openaiServerToolsBody`, `resolveStructuredOutput`), not from
 * a second table of what they do — a summary that disagreed with the request
 * would be worse than none, and the only way to keep two tables in step is to
 * have one. What it omits is deliberate: declarations that never leave the
 * machine (PDF input, the translation format) shape which pickers offer the
 * model, not the request.
 *
 * `declarationMarks` is the list row's badges: the declarations an author made
 * explicitly, so a long provider list can be scanned for "which one thinks,
 * which one may search". Auto is never marked — it is not a declaration.
 */

import type { Model } from "./configDb";
import { effectiveStructuredOutput } from "./jsonMode";
import {
  reasoningBody, resolveThinkingCategory, thinkingBody,
} from "./reasoning";
import { effectiveServerTools, openaiServerToolsBody } from "./serverTools";
import { wireOf, type PlatformId } from "./platforms";
import { hasAnyServerTool, hasCapability } from "./capabilities";
import { familyOf, type ApiStandard } from "./types";
import { capabilityModelOf, type RelayUpstreamChoice } from "./relayUpstream";

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

/**
 * What this row adds to a request beyond `model` and the messages.
 *
 * `baseUrl` names the endpoint for the session memo of refused JSON modes: with
 * it, the structured-output item is what will *actually* be sent, not what the
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
  const out: WireItem[] = [];
  const family = familyOf(standard);
  const wire = wireOf({ platform, baseUrl: baseUrl ?? "", standard });

  if (m.type === "image") {
    // An image model's declarations steer the client, not a chat body.
    if (m.caps?.route) out.push({ key: "route", value: m.caps.route });
    if (m.caps?.dialect) out.push({ key: "dialect", value: m.caps.dialect });
    if (m.caps?.sizes?.length) {
      const [first, ...rest] = m.caps.sizes;
      out.push({ key: "size", value: rest.length ? `${first} +${rest.length}` : first });
    }
    return out;
  }

  const category = resolveThinkingCategory({ thinkingCategory: m.thinkingCategory }, standard);

  if (family === "anthropic") {
    // The Messages adapter sends `thinking` on every request for a dialect
    // that has one; the budget it fills in when unset is the adapter's own.
    const body = thinkingBody(category.dialect, m.thinkingBudget ?? 0, m.reasoningEffort);
    if (body) {
      for (const item of flatten(body)) {
        if (NOISE.has(item.key)) continue;
        out.push(item.key === "thinking.budget_tokens" && !m.thinkingBudget ? { ...item, value: "…" } : item);
      }
    }
  }
  const reasoning = reasoningBody(category, m.reasoningEffort, m.thinkingBudget);
  if (reasoning) out.push(...flatten(reasoning).filter((i) => !NOISE.has(i.key)));

  if (family === "anthropic" && m.maxOutput) out.push({ key: "max_tokens", value: String(m.maxOutput) });
  // With the upstream, as the adapters ask: behind a relay it can decide either way.
  const capModel = capabilityModelOf({ modelId: m.modelId, relayUpstream });
  if (m.temperature !== undefined && hasCapability("temperature", wire, { ...capModel, thinkingCategory: category.id })) {
    out.push({ key: "temperature", value: String(m.temperature) });
  }
  if (m.serverTools?.length && hasAnyServerTool(wire)) {
    // Summarised as a request without function tools: the condition that
    // drops `enable_code_interpreter` and the `agent_max` strategy is the
    // request's, not the model's.
    if (family === "openai") out.push(...flatten(openaiServerToolsBody(wire, m.serverTools, m.modelId, { functionTools: false }, relayUpstream)));
    else {
      const ids = effectiveServerTools(wire, m.serverTools, m.modelId, relayUpstream);
      if (ids) out.push({ key: "tools", value: ids.join(",") });
    }
  }

  const so = effectiveStructuredOutput({
    standard, baseUrl, platform: wire.platform, modelId: m.modelId, structuredOutput: m.structuredOutput, relayUpstream,
  });
  if (so !== "off") {
    // 四条线四个字段名：Gemini 的 generationConfig（严格档是 responseJsonSchema，
    // 否则只是 responseMimeType）、Responses 的 text.format、Anthropic 的
    // output_config.format（只有严格档）、其余的 response_format。
    out.push(family === "anthropic"
      ? { key: "output_config.format", value: so, scope: "structured" }
      : family === "gemini"
      ? so === "json_schema"
        ? { key: "generationConfig.responseJsonSchema", value: "strict", scope: "structured" }
        : { key: "generationConfig.responseMimeType", value: "application/json", scope: "structured" }
      : family === "responses"
        ? { key: "text.format", value: so, scope: "structured" }
        : { key: "response_format", value: so, scope: "structured" });
  }
  // Sent on every request, beside (not instead of) a structured task's text.format.
  if (m.textVerbosity && hasCapability("textVerbosity", wire, capModel)) out.push({ key: "text.verbosity", value: m.textVerbosity });
  if (m.vlHighResolution && hasCapability("vlHighResolution", wire)) out.push({ key: "vl_high_resolution_images", value: "true" });
  // Not a body field — `fps` sits on the clip's content part. Listed anyway: it
  // changes the request, and the bill (4× between fps 0.5 and the default).
  if (m.videoInput && m.videoFps !== undefined && hasCapability("videoFps", wire)) {
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
