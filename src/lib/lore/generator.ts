/**
 * AI-assisted Lore entity generation.
 * Takes a text description + optional reference images/text files, calls the
 * selected model, and returns a structured GeneratedLore ready to save.
 *
 * Runs through the unified agent runtime (single-shot preset — JSON response
 * mode conflicts with tool calling on several providers, so no tools here).
 */

import i18n from "../../i18n";
import type { AgentEvent } from "../agent/events";
import { LORE_GENERATE_PRESET } from "../agent/presets";
import { runAgent } from "../agent/runtime";
import { jsonModeShaping } from "../ai/jsonMode";
import { pickConnOptions, type ConnOptions } from "../ai/conn";
import { fallbackCategoryId, isKnownCategory, loreCategoryIds } from "../profile/active";
import { type CategoryId } from "./model";

export interface GeneratedLore {
  name: string;
  category: CategoryId;
  aliases: string[];
  summary: string;
  content: string;
}

export async function generateLore(opts: ConnOptions & {
  description: string;
  images: { dataUrl: string }[];
  textAttachments?: { name: string; content: string }[];
  /** The response so far, in full — a snapshot, not a delta. */
  onProgress: (fullText: string) => void;
  /** Runtime progress (reasoning stream, token totals) for the progress UI. */
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  systemPrompt?: string;
  /** Restrict the category the model may pick (设计稿 08 · 分类范围). */
  allowedCategories?: CategoryId[];
}): Promise<GeneratedLore> {
  // Strip @[filename] visual placeholders from the user description — they're UI labels only.
  const cleanDesc = opts.description.replace(/@\[[^\]]*\]/g, "").trim();

  // Build the text portion of the prompt.
  // 500 000 chars ≈ 125–250 k tokens — covers even large settings docs on modern
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
  // The system prompt is author-overridable, so it is passed in here rather
  // than assumed: on the OpenAI family the word "json" in it is a precondition,
  // not a nicety.
  const json = jsonModeShaping(opts.standard, `${opts.systemPrompt ?? ""}\n${promptText}`);
  const extraBody = json.extraBody;
  if (json.cue) userParts.push({ type: "text", text: json.cue });

  // The extraction prompt — built-in or author-overridden — enumerates the
  // categories in its own prose, and under a non-novel profile that list is
  // simply wrong (it would offer a TTRPG author "characters"/"skills"). Append
  // the authoritative list so the last word the model reads is the set that
  // actually exists on disk; anything else it invents lands in the fallback
  // bucket, silently mis-filing the entity.
  const baseSystemPrompt = opts.systemPrompt ?? i18n.t("ai.instructions.lore");
  // The author may have narrowed the extraction scope to a subset of the
  // profile's categories; an empty/absent list means the full set.
  const allowed = (opts.allowedCategories ?? []).filter((c) => isKnownCategory(c));
  const categoryIds = allowed.length > 0 ? allowed : loreCategoryIds();
  const systemPrompt =
    `${baseSystemPrompt}\n\n## Valid categories (authoritative)\n` +
    `The "category" field MUST be exactly one of: ${categoryIds.join(", ")}.`;

  let fullText = "";
  await runAgent({
    ...pickConnOptions(opts),
    extraBody,
    preset: LORE_GENERATE_PRESET,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userParts },
    ],
    // Single-shot preset — tools are empty, so the context is never consulted.
    toolContext: { projectPath: "", loreIndex: {}, multimodal: true },
    signal: opts.signal ?? new AbortController().signal,
    onEvent: opts.onEvent ?? (() => {}),
    onOutputText: (text) => {
      fullText = text;
      opts.onProgress(text);
    },
  });

  // Extract JSON: markdown fences first, then outermost braces. Sliced to the
  // outermost braces even when the reply already starts with one — a model that
  // appends a closing remark after the object would otherwise hand JSON.parse
  // the remark too and fail a perfectly salvageable response (the splitter's
  // parseSplitResponse hit exactly this and fixed it the same way).
  const trimmed = fullText.trim();
  let jsonStr: string | undefined;
  const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  } else {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) jsonStr = trimmed.slice(start, end + 1);
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
