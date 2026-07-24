/**
 * AI-assisted facet splitting: takes an entity's index.md body and asks the
 * model to reorganize it into a lean core card plus independently-activatable
 * facets (outfits, backstory arcs, relations…). The model must MOVE text, not
 * rewrite it — the author's wording is the canon. Output is strict JSON,
 * parsed with the same fence-tolerant extraction as ./generator.
 */

import i18n from "../../i18n";
import type { GeminiSafetySettings } from "../ai/safety";
import type { ApiStandard } from "../ai/types";
import type { FacetMeta } from "./model";

export interface SplitFacetDraft {
  meta: FacetMeta;
  content: string;
}

export interface SplitResult {
  /** What remains in the core card (index.md body). */
  core: string;
  facets: SplitFacetDraft[];
  /** One-line explanation of the split, shown to the author. */
  notes: string;
}

export async function splitLore(opts: {
  entityName: string;
  /** index.md body (frontmatter stripped). */
  indexBody: string;
  /**
   * Existing facets to fold back into the reorganization. When present, the
   * model treats their text as part of the source and returns the COMPLETE
   * new facet set (the caller replaces the old files with it).
   */
  existingFacets?: { title: string; keys: string[]; body: string }[];
  /** Optional author guidance, e.g. "服装单独拆组". */
  instruction?: string;
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  safetySettings?: GeminiSafetySettings;
  modelId: string;
  prefix?: string;
  contextSize?: number;
  onProgress: (text: string) => void;
  signal?: AbortSignal;
  systemPrompt?: string;
}): Promise<SplitResult> {
  const { streamCompletion } = await import("../ai");

  const existing = opts.existingFacets?.filter((f) => f.body.trim()) ?? [];
  const existingBlock = existing.length > 0
    ? [
        "",
        "EXISTING FACETS (already split out — treat their text as part of the source material;",
        "reorganize, merge, rename, or re-split them together with the core, and RETURN THE COMPLETE new facet set):",
        ...existing.map((f) =>
          `### ${f.title}${f.keys.length ? ` (keys: ${f.keys.join(", ")})` : ""}\n${f.body.trim()}`,
        ),
      ].join("\n")
    : "";

  const promptText = [
    `ENTITY NAME: ${opts.entityName}`,
    `CURRENT ENTRY (index.md body):`,
    opts.indexBody,
    existingBlock,
    opts.instruction?.trim() ? `\nAUTHOR GUIDANCE:\n${opts.instruction.trim()}` : "",
  ].filter(Boolean).join("\n");

  const extraBody = opts.standard === "gemini"
    ? { generationConfig: { responseMimeType: "application/json" } }
    : { response_format: { type: "json_object" } };

  const userParts: Array<{ type: "text"; text: string }> = [
    { type: "text", text: promptText },
  ];
  if (opts.standard === "gemini") {
    userParts.push({
      type: "text",
      text: "Output ONLY valid JSON matching the schema in the system instructions. No markdown fences, no explanation.",
    });
  }

  let fullText = "";
  await streamCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    standard: opts.standard,
    safetySettings: opts.safetySettings,
    modelId: opts.modelId,
    prefix: opts.prefix,
    contextSize: opts.contextSize,
    messages: [
      { role: "system", content: opts.systemPrompt ?? i18n.t("ai.instructions.loreSplit") },
      { role: "user", content: userParts },
    ],
    extraBody,
    onChunk: (chunk) => {
      if ("text" in chunk) {
        fullText += chunk.text;
        opts.onProgress(chunk.text);
      }
    },
    signal: opts.signal,
  });

  return parseSplitResponse(fullText);
}

/** Extract + validate the JSON response (fence-tolerant, defaults applied). */
export function parseSplitResponse(fullText: string): SplitResult {
  const trimmed = fullText.trim();
  let jsonStr: string | undefined;
  if (trimmed.startsWith("{")) {
    jsonStr = trimmed;
  } else {
    const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1];
    } else {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end > start) jsonStr = trimmed.slice(start, end + 1);
    }
  }
  if (!jsonStr) {
    const preview = trimmed.slice(0, 300) || "(empty response)";
    throw new Error(`Model did not return valid JSON.\n\nResponse preview:\n${preview}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse model response as JSON.\n\nResponse preview:\n${jsonStr.slice(0, 300)}`);
  }

  const rawFacets = Array.isArray(parsed.facets) ? parsed.facets : [];
  const facets: SplitFacetDraft[] = rawFacets
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f) => ({
      meta: {
        title: typeof f.title === "string" && f.title.trim() ? f.title.trim() : "未命名特征",
        keys: Array.isArray(f.keys)
          ? f.keys.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean)
          : [],
        group: typeof f.group === "string" && f.group.trim() ? f.group.trim() : null,
        priority: typeof f.priority === "number" && Number.isFinite(f.priority) ? f.priority : 0,
        mode: "auto" as const,
      },
      content: typeof f.content === "string" ? f.content.trim() : "",
    }))
    .filter((f) => f.content.length > 0);

  return {
    core: typeof parsed.core === "string" ? parsed.core.trim() : "",
    facets,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}
