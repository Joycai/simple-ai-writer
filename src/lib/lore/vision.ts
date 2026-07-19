/**
 * AI vision helper for the lore gallery: describe a single reference image
 * (appearance / clothing / pose …) in words. The result is stored as the
 * image's description in images.md, where it stands in for the picture when
 * a text-only model reads the entity — so it must be concrete and visual.
 */

import type { GeminiSafetySettings } from "../ai/safety";
import type { ApiStandard, StreamMessage } from "../ai/types";

export interface DescribeLoreImageOptions {
  /** base64 data URL of the image to describe. */
  dataUrl: string;
  /** Name of the entity the image belongs to (context only). */
  entityName: string;
  /** One-line entity summary, if any (context only). */
  entitySummary?: string;
  /** Existing description — offered to the model as a starting point to refine. */
  existingDesc?: string;
  /** UI language tag (e.g. "zh-CN") — controls the output language. */
  language: string;
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  safetySettings?: GeminiSafetySettings;
  modelId: string;
  prefix?: string;
  contextSize?: number;
  signal?: AbortSignal;
  /** Called with the accumulated text on every streamed chunk. */
  onProgress?: (text: string) => void;
}

/**
 * Ask a multimodal model to describe one gallery image. Returns the final
 * description text (trimmed). Throws on transport/model errors; the caller
 * decides how to surface them.
 */
export async function describeLoreImage(opts: DescribeLoreImageOptions): Promise<string> {
  const { streamCompletion } = await import("../ai");

  const lang = opts.language.startsWith("zh") ? "简体中文" : "English";
  const system = [
    "You are a visual reference describer for a fiction-writing app's lore gallery.",
    "The image belongs to a lore entity (character / item / place). Your description is stored",
    "next to the image and is the ONLY thing text-only AI models will ever \"see\" of it,",
    "so it must let a reader picture the image accurately.",
    "",
    "Cover, in this order, whatever is actually visible:",
    "1. Appearance — face, eyes, hair, build, distinguishing marks.",
    "2. Clothing & accessories — garments, colors, materials, jewelry, weapons/props.",
    "3. Pose, action & expression.",
    "4. Scene, atmosphere and art style, briefly.",
    "",
    "Rules:",
    "- Describe ONLY what is visible in the image. Never invent names, backstory or hidden traits.",
    "- Plain prose, 2–5 sentences. No markdown headings, no bullet lists, no preamble like \"This image shows\".",
    "- Concrete and compact: aim for roughly 80–200 Chinese characters (or 50–120 English words).",
    `- Respond in ${lang}.`,
  ].join("\n");

  const userLines = [
    `This image is in the gallery of the lore entity "${opts.entityName}".`,
    opts.entitySummary?.trim() ? `Entity summary (context only, do not repeat): ${opts.entitySummary.trim()}` : "",
    opts.existingDesc?.trim()
      ? `Current description (refine/extend it, keep what is correct):\n${opts.existingDesc.trim()}`
      : "",
    "Describe the image.",
  ].filter(Boolean);

  const messages: StreamMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: userLines.join("\n\n") },
        { type: "image_url", image_url: { url: opts.dataUrl } },
      ],
    },
  ];

  let acc = "";
  await streamCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    standard: opts.standard,
    safetySettings: opts.safetySettings,
    modelId: opts.modelId,
    prefix: opts.prefix,
    contextSize: opts.contextSize,
    signal: opts.signal,
    messages,
    onChunk: (chunk) => {
      if ("text" in chunk) {
        acc += chunk.text;
        opts.onProgress?.(acc);
      }
    },
  });
  return acc.trim();
}
