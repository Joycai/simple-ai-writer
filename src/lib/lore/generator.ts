/**
 * AI-assisted Lore entity generation.
 * Takes a text description + optional reference images/text files, calls the
 * selected model, and returns a structured GeneratedLore ready to save.
 */

import i18n from "../../i18n";
import type { GeminiSafetySettings } from "../ai/safety";
import type { ApiStandard } from "../ai/types";
import { LORE_CATEGORIES, type CategoryId } from "./model";

export interface GeneratedLore {
  name: string;
  category: CategoryId;
  aliases: string[];
  summary: string;
  content: string;
}

export async function generateLore(opts: {
  description: string;
  images: { dataUrl: string }[];
  textAttachments?: { name: string; content: string }[];
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
}): Promise<GeneratedLore> {
  const { streamCompletion } = await import("../ai");

  // Strip @[filename] visual placeholders from the user description — they're UI labels only.
  const cleanDesc = opts.description.replace(/@\[[^\]]*\]/g, "").trim();

  // Build the text portion of the prompt.
  // 200 000 chars ≈ 50–100 k tokens — covers even large settings docs on modern
  // models (Gemini 1.5/2.0 Flash/Pro support 1 M token context windows).
  const MAX_REF_CHARS = 500_000;
  const refs = (opts.textAttachments ?? [])
    .map((ta) => {
      const body = ta.content.length > MAX_REF_CHARS
        ? ta.content.slice(0, MAX_REF_CHARS) + `\n…[truncated, ${ta.content.length - MAX_REF_CHARS} chars omitted]`
        : ta.content;
      return `--- Reference: ${ta.name} ---\n${body}\n---`;
    })
    .join("\n\n");

  let promptText: string;
  if (refs) {
    // Explicit extraction instruction so the model treats the file as reference material.
    promptText = cleanDesc
      ? `${cleanDesc}\n\nReference materials:\n${refs}`
      : `Extract a lore entity from the following reference text and output as JSON:\n\n${refs}`;
  } else {
    promptText = cleanDesc || "请根据附图创建一个设定条目。";
  }

  const userParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text: promptText },
    ...opts.images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: img.dataUrl },
    })),
  ];

  // JSON mode: use native API enforcement where available.
  // For Gemini, also append a text reminder as belt-and-suspenders (some older models
  // silently ignore responseMimeType and need the text cue too).
  const extraBody = opts.standard === "gemini"
    ? { generationConfig: { responseMimeType: "application/json" } }
    : { response_format: { type: "json_object" } };

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
      { role: "system", content: opts.systemPrompt ?? i18n.t("ai.instructions.lore") },
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

  // Extract JSON: try clean parse first, then markdown fences, then first-{-to-last-}
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
    throw new Error(`Failed to parse model response as JSON.\n\nResponse preview:\n${jsonStr!.slice(0, 300)}`);
  }

  return {
    name:     typeof parsed.name     === "string" ? parsed.name     : "未命名",
    category: (LORE_CATEGORIES.some((c) => c.id === parsed.category)
               ? parsed.category as CategoryId : "custom"),
    aliases:  Array.isArray(parsed.aliases) ? parsed.aliases.filter((a): a is string => typeof a === "string") : [],
    summary:  typeof parsed.summary  === "string" ? parsed.summary  : "",
    content:  typeof parsed.content  === "string" ? parsed.content  : "",
  };
}
