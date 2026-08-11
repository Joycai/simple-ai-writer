/**
 * AI-assisted Lore entity generation.
 * Takes a text description + optional reference images/text files, calls the
 * selected model, and returns a structured GeneratedLore ready to save.
 *
 * Runs through the unified agent runtime (single-shot preset — JSON response
 * mode conflicts with tool calling on several providers, so no tools here).
 */

import i18n from "../../i18n";
import { LORE_GENERATE_PRESET } from "../agent/presets";
import { runAgent } from "../agent/runtime";
import { JSON_ONLY_CUE, jsonModeExtraBody, needsJsonTextCue } from "../ai/jsonMode";
import type { GeminiSafetySettings } from "../ai/safety";
import type { ApiStandard, AuthMode } from "../ai/types";
import { fallbackCategoryId, isKnownCategory, loreCategoryIds } from "../profile/active";
import { type CategoryId } from "./model";

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
  /** Anthropic-compat auth scheme; ignored by every other protocol. */
  authMode?: AuthMode;
  modelId: string;
  prefix?: string;
  contextSize?: number;
  /** Sent as `max_tokens` on the Anthropic path; planning-only elsewhere. */
  maxOutput?: number;
  /** The response so far, in full — a snapshot, not a delta. */
  onProgress: (fullText: string) => void;
  signal?: AbortSignal;
  systemPrompt?: string;
}): Promise<GeneratedLore> {
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

  // JSON mode: native API enforcement where the protocol has it, plus a text
  // cue where it doesn't (or where it can't be trusted alone). See ai/jsonMode.
  const extraBody = jsonModeExtraBody(opts.standard);
  if (needsJsonTextCue(opts.standard)) {
    userParts.push({ type: "text", text: JSON_ONLY_CUE });
  }

  // The extraction prompt — built-in or author-overridden — enumerates the
  // categories in its own prose, and under a non-novel profile that list is
  // simply wrong (it would offer a TTRPG author "characters"/"skills"). Append
  // the authoritative list so the last word the model reads is the set that
  // actually exists on disk; anything else it invents lands in the fallback
  // bucket, silently mis-filing the entity.
  const baseSystemPrompt = opts.systemPrompt ?? i18n.t("ai.instructions.lore");
  const systemPrompt =
    `${baseSystemPrompt}\n\n## Valid categories (authoritative)\n` +
    `The "category" field MUST be exactly one of: ${loreCategoryIds().join(", ")}.`;

  let fullText = "";
  await runAgent({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    standard: opts.standard,
    safetySettings: opts.safetySettings,
    authMode: opts.authMode,
    modelId: opts.modelId,
    prefix: opts.prefix,
    contextSize: opts.contextSize,
    maxOutput: opts.maxOutput,
    extraBody,
    preset: LORE_GENERATE_PRESET,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userParts },
    ],
    // Single-shot preset — tools are empty, so the context is never consulted.
    toolContext: { projectPath: "", loreIndex: {}, multimodal: true },
    signal: opts.signal ?? new AbortController().signal,
    onEvent: () => {},
    onOutputText: (text) => {
      fullText = text;
      opts.onProgress(text);
    },
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
    // The model is told the profile's categories but can still invent one; an
    // unknown id would become a stray directory, so it lands in the fallback.
    category: (typeof parsed.category === "string" && isKnownCategory(parsed.category)
               ? parsed.category as CategoryId : fallbackCategoryId()),
    aliases:  Array.isArray(parsed.aliases) ? parsed.aliases.filter((a): a is string => typeof a === "string") : [],
    summary:  typeof parsed.summary  === "string" ? parsed.summary  : "",
    content:  typeof parsed.content  === "string" ? parsed.content  : "",
  };
}
