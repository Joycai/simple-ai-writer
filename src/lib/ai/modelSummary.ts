/**
 * Two read-only views of a model row for the settings surfaces — 设计稿 19.
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
import { resolveStructuredOutput } from "./jsonMode";
import {
  reasoningBody, resolveThinkingCategory, supportsTemperature, thinkingBody,
} from "./reasoning";
import { openaiServerToolsBody, supportsServerTools } from "./serverTools";
import { familyOf, type ApiStandard } from "./types";

export interface WireItem {
  /** Dotted path of the field, e.g. `thinking.type`, `response_format`. */
  key: string;
  value: string;
  /**
   * `structured` — sent on structured tasks only, not on every request.
   * `prefix` — the leading system message; the value is empty and the UI
   * names it in the author's language.
   */
  scope?: "structured" | "prefix";
}

export type WireInput = Pick<
  Model,
  | "type" | "modelId" | "maxOutput" | "temperature" | "reasoningEffort"
  | "thinkingCategory" | "thinkingBudget" | "serverTools" | "structuredOutput"
  | "prefix" | "caps"
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

/** What this row adds to a request beyond `model` and the messages. */
export function wireSummary(m: WireInput, standard: ApiStandard): WireItem[] {
  const out: WireItem[] = [];
  const family = familyOf(standard);

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
  if (m.temperature !== undefined && supportsTemperature(standard, category.id)) {
    out.push({ key: "temperature", value: String(m.temperature) });
  }
  if (m.serverTools?.length && supportsServerTools(standard)) {
    if (family === "anthropic") out.push({ key: "tools", value: m.serverTools.join(",") });
    else out.push(...flatten(openaiServerToolsBody(standard, m.serverTools)));
  }

  const so = resolveStructuredOutput({ standard, modelId: m.modelId, structuredOutput: m.structuredOutput });
  if (so !== "off") {
    out.push(family === "gemini"
      ? { key: "generationConfig.responseMimeType", value: "application/json", scope: "structured" }
      : family === "responses"
        ? { key: "text.format", value: so, scope: "structured" }
        : { key: "response_format", value: so, scope: "structured" });
  }
  if (m.prefix?.trim()) out.push({ key: "system", value: "", scope: "prefix" });
  return out;
}

export type ModelMark = "think" | "web" | "pdf" | "translate";

/**
 * The explicit declarations on a conversational model, for the list row.
 * Image and video models carry none: their declarations live in `caps`, and the
 * row already says what type they are.
 */
export function declarationMarks(
  m: Pick<Model, "type" | "thinkingCategory" | "serverTools" | "pdfInput" | "translateFormat">,
): ModelMark[] {
  if (m.type === "image" || m.type === "video") return [];
  const out: ModelMark[] = [];
  if (m.thinkingCategory) out.push("think");
  if (m.serverTools?.includes("web_search")) out.push("web");
  if (m.pdfInput) out.push("pdf");
  if (m.translateFormat) out.push("translate");
  return out;
}

/** Whether the stored value is the one the probe measured (not overridden since). */
export function isMeasured(value: number | undefined, probed: number | undefined): boolean {
  return probed !== undefined && value === probed;
}
